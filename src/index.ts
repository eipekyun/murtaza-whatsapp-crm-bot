import 'dotenv/config';
import { rmSync } from 'node:fs';
import { loadConfigFromEnv } from './config.js';
import { createRouter } from './router.js';
import { createSqliteMessageStore } from './store/sqlite-message-store.js';
import { createOperatorHttpServer } from './http/operator-server.js';
import { startBaileysClient, type BaileysClientOptions } from './whatsapp/baileys-client.js';
import type { WASocket } from '@whiskeysockets/baileys';

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const store = createSqliteMessageStore(config.dbPath);
  let autoReplyAudience: 'whitelist' | 'all' = config.autoReplyAudience;
  const savedAudience = await store.getAppState('auto_reply_audience');
  if (savedAudience === 'all' || savedAudience === 'whitelist') autoReplyAudience = savedAudience;
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
    }
  };
  sock = await startBaileysClient(config, router, botOptions);

  async function relinkWhatsApp(): Promise<void> {
    try { (sock as unknown as { end?: (error?: unknown) => void }).end?.(undefined); } catch { /* yoksay */ }
    try { rmSync(config.authDir, { recursive: true, force: true }); } catch { /* yoksay */ }
    waState = 'connecting';
    waMe = undefined;
    sock = await startBaileysClient(config, router, botOptions);
  }

  const operatorServer = createOperatorHttpServer({
    tenantId: config.tenantId,
    store,
    whitelistPhones: config.whitelistPhones,
    authToken: config.operatorToken,
    noAuth: config.operatorNoAuth,
    getAutoReplyAudience: () => autoReplyAudience,
    setAutoReplyAudience: async (audience) => {
      autoReplyAudience = audience;
      await store.setAppState('auto_reply_audience', audience);
    },
    markChatRead: (chatId, trigger) => applyReadReceipt(chatId, trigger),
    getWaStatus: () => ({ state: waState, me: waMe }),
    relinkWhatsApp: () => relinkWhatsApp(),
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
    const url = config.operatorNoAuth ? base : `${base}?token=${config.operatorToken}`;
    console.log(`Operatör paneli hazır: ${url}`);
    if (!config.operatorNoAuth) console.log('Token data/operator-token.txt dosyasında saklı (chmod 600).');
  });
}

main().catch((error) => {
  console.error('Bot başlatılamadı:', error);
  process.exitCode = 1;
});
