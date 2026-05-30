import 'dotenv/config';
import { rmSync, readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadConfigFromEnv } from './config.js';
import { createRouter } from './router.js';
import { createSqliteMessageStore } from './store/sqlite-message-store.js';
import { createOperatorHttpServer, type GroupInfo, type MediaFile } from './http/operator-server.js';
import { startBaileysClient, type BaileysClientOptions } from './whatsapp/baileys-client.js';
import { createDrivePythonRunner, createMediaArchiver } from './media/media-archiver.js';
import { normalizePhone, normalizeWhitelist } from './phone.js';
import type { MediaKind } from './types.js';
import type { WASocket } from '@whiskeysockets/baileys';

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const store = createSqliteMessageStore(config.dbPath);
  // Restart recovery (1/2): önceki oturumda 'uploading' kalmış (yarıda kesilmiş) medyaları
  // 'pending'e çevir. Asıl kuyruğa ekleme aşağıda mediaArchiver.requeuePending() ile yapılır.
  if (config.archiveMedia) await store.resetStaleUploading(config.tenantId);
  let autoReplyAudience: 'whitelist' | 'all' = config.autoReplyAudience;
  const savedAudience = await store.getAppState('auto_reply_audience');
  if (savedAudience === 'all' || savedAudience === 'whitelist') autoReplyAudience = savedAudience;
  let botReplyDelayMs = 20 * 1000;
  const savedDelay = await store.getAppState('bot_reply_delay_seconds');
  if (savedDelay != null && savedDelay !== '' && Number.isFinite(Number(savedDelay))) botReplyDelayMs = Math.max(0, Number(savedDelay)) * 1000;

  // Gelen medya arşivleme: Drive Python runner + seri kuyruklu archiver.
  const driveRunner = createDrivePythonRunner({
    python: config.drivePython,
    script: config.driveUploadScript,
    tokenPath: config.driveTokenPath,
    customersDir: config.customersDir,
    timeoutMs: 180000
  });
  const mediaArchiver = createMediaArchiver({
    store,
    tenantId: config.tenantId,
    runner: driveRunner,
    logger: { info: (m) => console.log(m), error: (m) => console.error(m) }
  });
  // Restart recovery (2/2): bekleyen + başarısız tüm medyayı (firma vs inbox kararıyla) yeniden
  // kuyruğa al. enqueue arka planda seri çalışır; startup'ı bloklamaz.
  if (config.archiveMedia) await mediaArchiver.requeuePending();
  const router = createRouter({
    tenantId: config.tenantId,
    whitelistPhones: config.whitelistPhones,
    autoReply: config.autoReply,
    getAutoReplyAudience: () => autoReplyAudience,
    isTrustedSender: (message) => message.senderDisplayName
      ? store.hasWhitelistedAlias(config.tenantId, message.senderDisplayName, config.whitelistPhones)
      : Promise.resolve(false),
    getConversationContext: (message) => store.getConversationReplyContext(config.tenantId, message.chatId),
    saveInbound: (message) => store.saveInbound(message)
  });

  console.log(`MURTAZA WhatsApp CRM PoC başlıyor: tenant=${config.tenantId} autoReply=${config.autoReply}`);
  console.log(`Whitelist kayıt sayısı: ${config.whitelistPhones.length}`);
  let sock: WASocket;
  let waState = 'connecting';
  let waMe: string | undefined;

  // Okundu makbuzu (mavi tik) per-konuşma ayara göre: on_reply (varsayılan) sadece cevapta,
  // on_open açınca, never hiç. Her durumda sol listedeki okunmamış sayacı sıfırlanır (last_read).
  async function applyReadReceipt(chatId: string, trigger: 'open' | 'reply'): Promise<void> {
    if (!chatId) return;
    const mode = (await store.getConversationSettings(config.tenantId, chatId)).readReceipt;
    const shouldSend = mode === 'on_open' || (mode === 'on_reply' && trigger === 'reply');
    if (shouldSend && sock) {
      const keys = (await store.getUnreadInboundKeys(config.tenantId, chatId)).map((k) => ({
        remoteJid: k.chatId,
        id: k.messageId,
        fromMe: false,
        ...(k.chatId.endsWith('@g.us') ? { participant: k.senderPhone.includes('@') ? k.senderPhone : `${k.senderPhone}@s.whatsapp.net` } : {})
      }));
      if (keys.length > 0) {
        try { await sock.readMessages(keys); } catch (error) { console.error('readMessages hatası:', error instanceof Error ? error.message : error); }
      }
    }
    await store.markChatRead(config.tenantId, chatId);
  }

  const botOptions: BaileysClientOptions = {
    onSocketReady: (nextSock) => {
      sock = nextSock;
    },
    onConnectionState: (state, me) => {
      waState = state;
      if (me) waMe = me.split('@')[0].split(':')[0];
    },
    onOutboundSent: (message) => store.saveOutbound(message),
    onContactName: (jid, name, source) => store.saveContactName(config.tenantId, jid, name, source),
    onMessageStatus: (messageId, status) => store.updateMessageStatus(config.tenantId, messageId, status),
    onAfterReply: (chatId) => applyReadReceipt(chatId, 'reply'),
    getBotReplyDelayMs: () => botReplyDelayMs,
    shouldStillReply: async (chatId, sinceIso) => {
      const ctx = await store.getConversationReplyContext(config.tenantId, chatId);
      if (ctx.botEnabled === false) return false;
      const since = new Date(sinceIso).getTime();
      if (ctx.lastManualReplyAt && ctx.lastManualReplyAt.getTime() > since) return false;
      if (ctx.lastBotReplyAt && ctx.lastBotReplyAt.getTime() > since) return false;
      return true;
    },
    onHistorySync: async ({ imported, progress }) => {
      const raw = await store.getAppState('history_import');
      const current = raw ? JSON.parse(raw) as { imported?: number } : {};
      const totalImported = Number(current.imported ?? 0) + imported;
      const normalizedProgress = typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
      await store.setAppState('history_import', JSON.stringify({
        status: normalizedProgress >= 100 ? 'completed' : 'listening',
        progress: normalizedProgress,
        imported: totalImported,
        note: imported > 0 ? `History-sync chunk kaydedildi: ${imported} yeni kayıt.` : 'History-sync event geldi ama kaydedilecek yeni inbound mesaj yoktu.',
        updatedAt: new Date().toISOString()
      }));
    },
    ...(config.archiveMedia ? {
      mediaIncomingDir: config.mediaIncomingDir,
      archiveKinds: new Set<MediaKind>(config.archiveKinds),
      maxMediaBytes: config.maxMediaBytes,
      // Arşivle: gönderen whitelist'te VEYA sohbet (grup/bireysel) bir firmaya atanmış.
      // Böylece atanmış grubun whitelist dışı üyelerinin medyası da firmanın Drive'ına gider.
      shouldArchiveMedia: async (chatId, senderPhone) => {
        if (normalizeWhitelist(config.whitelistPhones).has(normalizePhone(senderPhone))) return true;
        const settings = await store.getConversationSettings(config.tenantId, chatId);
        return Boolean(settings.customerSlug);
      },
      onIncomingMedia: (event) => mediaArchiver.onIncomingMedia(event),
      onMediaSkipped: (event: { messageId: string }) => store.setMediaUploadStatus(config.tenantId, event.messageId, 'skipped')
    } : {})
  };
  sock = await startBaileysClient(config, router, botOptions);

  async function relinkWhatsApp(): Promise<void> {
    try { (sock as unknown as { end?: (error?: unknown) => void }).end?.(undefined); } catch { /* yoksay */ }
    try { rmSync(config.authDir, { recursive: true, force: true }); } catch { /* yoksay */ }
    waState = 'connecting';
    waMe = undefined;
    sock = await startBaileysClient(config, router, botOptions);
  }

  // customersDir'deki *.md dosyaları (_ veya . ile başlayanlar hariç) -> {slug,name}.
  // name = ilk "# Başlık" satırı, yoksa slug.
  function listCustomers(): Array<{ slug: string; name: string }> {
    if (!existsSync(config.customersDir)) return [];
    let files: string[];
    try { files = readdirSync(config.customersDir); } catch { return []; }
    const out: Array<{ slug: string; name: string }> = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      if (file.startsWith('_') || file.startsWith('.')) continue;
      const slug = file.slice(0, -3);
      let name = slug;
      try {
        const text = readFileSync(join(config.customersDir, file), 'utf8');
        const heading = text.split('\n').find((line) => line.trim().startsWith('# '));
        if (heading) name = heading.replace(/^#\s+/, '').trim() || slug;
      } catch { /* başlık okunamazsa slug kalır */ }
      out.push({ slug, name });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    return out;
  }

  // WhatsApp'tan gelen dosya adı (mediaName) güvenilmez; path traversal'ı önlemek için
  // basename + karakter filtresiyle güvenli bir tek-segment dosya adına indir.
  function safeMediaName(name?: string): string {
    const cleaned = basename(name || '').replace(/[^A-Za-z0-9._\- ]/g, '_').trim();
    const result = cleaned || 'dosya';
    return /^\.+$/.test(result) ? 'dosya' : result;
  }

  // Panelden bir medyaya tıklanınca dosyayı çözer: yerel kopya > base64 data url > Drive indirme.
  async function resolveMediaFile(messageId: string): Promise<MediaFile | undefined> {
    const info = await store.getMediaForServe(config.tenantId, messageId);
    if (!info) return undefined;
    if (info.mediaLocalPath && existsSync(info.mediaLocalPath)) {
      return { path: info.mediaLocalPath, mime: info.mediaMime, name: info.mediaName, cleanup: false };
    }
    if (info.mediaData && info.mediaData.startsWith('data:')) {
      const match = info.mediaData.match(/^data:([^;]+);base64,(.+)$/i);
      if (match) {
        const dir = mkdtempSync(join(tmpdir(), 'wa-media-'));
        const path = join(dir, safeMediaName(info.mediaName));
        writeFileSync(path, Buffer.from(match[2] ?? '', 'base64'));
        return { path, mime: match[1] ?? info.mediaMime, name: info.mediaName, cleanup: true };
      }
    }
    if (info.mediaDriveId) {
      const dir = mkdtempSync(join(tmpdir(), 'wa-media-'));
      const path = join(dir, safeMediaName(info.mediaName));
      const result = await mediaArchiver.downloadDriveFile(info.mediaDriveId, path);
      if (result.status === 'ok') {
        return { path, mime: result.mime || info.mediaMime, name: result.name || info.mediaName, cleanup: true };
      }
      // Başarısız indirmede geçici dizini sızdırma.
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temizlik best-effort */ }
    }
    return undefined;
  }

  // Grup detayı: canlı groupMetadata (tam üye listesi) + DB'deki mesaj gönderen adlarıyla
  // zenginleştirme. Metadata alınamazsa (sock yok/hata) DB üyeleriyle fallback.
  function phoneFromJid(jid: string): string {
    const local = (jid.split('@')[0] ?? '').split(':')[0] ?? '';
    return local.replace(/[^0-9]/g, '') || local || jid;
  }
  async function resolveGroupInfo(chatId: string): Promise<GroupInfo | undefined> {
    if (!chatId.endsWith('@g.us')) return undefined;
    const dbMembers = await store.getGroupMembersFromMessages(config.tenantId, chatId);
    const nameByPhone = new Map(dbMembers.map((m) => [m.phone, m.name]));
    let subject: string | undefined;
    let members = dbMembers.map((m) => ({ phone: m.phone, name: m.name, admin: false }));
    try {
      const meta = await sock.groupMetadata(chatId);
      subject = meta?.subject ?? undefined;
      if (meta?.participants?.length) {
        members = meta.participants.map((p) => {
          // Baileys v7: p.id LID olabilir; gerçek telefon p.phoneNumber'da. İsim p.name (rehber)
          // veya p.notify (kişinin kendi adı), yoksa DB'deki mesaj gönderen adı.
          const phone = phoneFromJid(p.phoneNumber || p.id);
          const name = (p.name && p.name.trim()) || (p.notify && p.notify.trim()) || nameByPhone.get(phone);
          return { phone, name, admin: p.admin === 'admin' || p.admin === 'superadmin' };
        });
      }
    } catch {
      // canlı metadata yoksa DB üyeleriyle devam (mesaj atmış kişiler)
    }
    return { chatId, subject, count: members.length, members };
  }

  const operatorServer = createOperatorHttpServer({
    tenantId: config.tenantId,
    store,
    whitelistPhones: config.whitelistPhones,
    authToken: config.operatorToken,
    noAuth: config.operatorNoAuth,
    listCustomers,
    onCustomerAssigned: (chatId, slug) => mediaArchiver.onCustomerAssigned(chatId, slug),
    getMediaFile: (messageId) => resolveMediaFile(messageId),
    getGroupInfo: (chatId) => resolveGroupInfo(chatId),
    getAutoReplyAudience: () => autoReplyAudience,
    setAutoReplyAudience: async (audience) => {
      autoReplyAudience = audience;
      await store.setAppState('auto_reply_audience', audience);
    },
    markChatRead: (chatId, trigger) => applyReadReceipt(chatId, trigger),
    getWaStatus: () => ({ state: waState, me: waMe }),
    relinkWhatsApp: () => relinkWhatsApp(),
    getReplyDelaySeconds: () => Math.round(botReplyDelayMs / 1000),
    setReplyDelaySeconds: async (seconds) => {
      botReplyDelayMs = Math.max(0, Math.min(3600, Math.round(seconds))) * 1000;
      await store.setAppState('bot_reply_delay_seconds', String(Math.round(botReplyDelayMs / 1000)));
    },
    sendWhatsAppMessage: async (payload) => {
      const sent = payload.image
        ? await sock.sendMessage(payload.chatId, { image: payload.image, caption: payload.text || undefined })
        : payload.document
          ? await sock.sendMessage(payload.chatId, { document: payload.document, mimetype: payload.documentMime || 'application/octet-stream', fileName: payload.documentName || 'dosya', caption: payload.text || undefined })
          : await sock.sendMessage(payload.chatId, { text: payload.text });
      return sent?.key.id ?? undefined;
    }
  });

  operatorServer.listen(config.operatorPort, config.operatorHost, () => {
    const base = `http://${config.operatorHost}:${config.operatorPort}/`;
    // Güvenlik: token'ı log'a basma (PM2/journal/log-aggregator'a sızar). Sadece adres + dosya referansı.
    console.log(`Operatör paneli hazır: ${base}`);
    if (!config.operatorNoAuth) console.log('Erişim için token: data/operator-token.txt (chmod 600) — panele ?token=<değer> ile gir.');
  });
}

main().catch((error) => {
  console.error('Bot başlatılamadı:', error);
  process.exitCode = 1;
});
