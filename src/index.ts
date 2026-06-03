import 'dotenv/config';
import { createHash } from 'node:crypto';
import { rmSync, readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { loadConfigFromEnv } from './config.js';
import { createRouter } from './router.js';
import { createSqliteMessageStore } from './store/sqlite-message-store.js';
import { createOperatorHttpServer, type GroupInfo, type MediaFile } from './http/operator-server.js';
import { startBaileysClient, type BaileysClientOptions } from './whatsapp/baileys-client.js';
import { createDrivePythonRunner, createMediaArchiver } from './media/media-archiver.js';
import { createPerfexReader } from './perfex/perfex-reader.js';
import { createExtractionRunner } from './candidate/extraction-runner.js';
import { createApprovalRequester } from './approval/approval-requester.js';
import { readCustomerCard } from './customer/customer-card-reader.js';
import { parseGroupMappings, upsertGroupMapping } from './customer/vault-group-mapping.js';
import { normalizePhone, normalizeWhitelist } from './phone.js';
import type { ChatCrmMapping, GroupCandidate, MediaKind, PerfexQueryResult, ProjectOption } from './types.js';
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
  // Perfex READ-ONLY okuyucu: scripts/perfex-query.py subprocess köprüsü.
  // fetchClientStatus ASLA throw etmez; hata {tasks:[],projects:[],error} olarak döner.
  const perfexReader = createPerfexReader({
    python: config.perfexQueryPython,
    scriptPath: config.perfexQueryScript,
    opsEnvPath: config.perfexOpsEnvPath
  });
  // Grup → görev adayı çıkarma köprüsü (scripts/wa-extract.py). extractGroup ASLA throw etmez.
  const extractionRunner = createExtractionRunner({
    python: config.perfexQueryPython,
    scriptPath: config.waExtractScript,
    dbPath: config.dbPath
  });
  // Onay isteği köprüsü: aday → request_approval.py (Telegram 3-buton). requestApproval throw etmez.
  const approvalRequester = createApprovalRequester({
    python: config.perfexQueryPython,
    scriptPath: config.requestApprovalScript
  });
  // Restart recovery (2/2): bekleyen + başarısız tüm medyayı (firma vs inbox kararıyla) yeniden
  // kuyruğa al. enqueue arka planda seri çalışır; startup'ı bloklamaz.
  if (config.archiveMedia) await mediaArchiver.requeuePending();
  // Vault grup eşlemeleri (authoritative) ile chat_crm_mapping mirror'ını startup'ta tazele.
  loadGroupMappingsFromVault();
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
    onMessageEdited: (messageId, newText, editedAt) =>
      store.updateMessageText(config.tenantId, messageId, newText, editedAt.toISOString()),
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

  // Seçili firmanın Perfex projeleri (kart 'Aktif Projeler' bölümünden). Çoklu projeli
  // müşteride operatör panelden seçer. Kart yoksa veya proje yoksa boş dizi.
  function listProjects(customerSlug: string): ProjectOption[] {
    const card = readCustomerCard(customerSlug, config.customersDir);
    if (!card) return [];
    return card.perfexProjectIds.map((p) => ({ id: p.id, name: p.name || `Proje ${p.id}` }));
  }

  // Panel 'Perfex görevleri' butonu: sohbet → grup CRM eşlemesinden perfexClientId çözer,
  // sonra READ-ONLY perfexReader ile o firmanın açık görev/proje durumunu çeker.
  // Firma atanmamışsa veya reader hata verirse {tasks,projects,error} döner — UI buna göre mesaj gösterir.
  // perfexReader.fetchClientStatus zaten throw etmez; yine de defansif try-catch (eşleme okuması patlayabilir).
  async function getPerfexTasks(chatId: string): Promise<PerfexQueryResult> {
    try {
      // Grup sohbeti: chat_crm_mapping mirror'ından (hızlı, @g.us için yazılır). Bireysel/atanmış
      // sohbette mirror boş kalır; o yüzden conversation_settings.customerSlug → müşteri kartı fallback'i.
      let perfexClientId = store.getGroupCrmMapping(config.tenantId, chatId)?.perfexClientId;
      if (perfexClientId === undefined) {
        const slug = (await store.getConversationSettings(config.tenantId, chatId)).customerSlug;
        if (slug) perfexClientId = readCustomerCard(slug, config.customersDir)?.perfexClientId;
      }
      if (perfexClientId === undefined) {
        return { tasks: [], projects: [], error: 'firma atanmamış' };
      }
      return await perfexReader.fetchClientStatus(perfexClientId);
    } catch (error) {
      return { tasks: [], projects: [], error: error instanceof Error ? error.message : 'perfex erişilemedi' };
    }
  }

  // Panel 'Bu grubu özetle' butonu: grup mesajlarından wa-extract.py ile özet + görev adayı çıkarır,
  // grup CRM eşlemesiyle zenginleştirip group_candidates'a (status:'draft') yazar. Hash ile dedup —
  // aynı özet/görev seti tekrar üretilirse store mevcut adayı döner. extractionRunner throw etmez;
  // yine de defansif try-catch (eşleme okuması / store yazımı patlayabilir).
  async function extractGroup(chatId: string): Promise<{ ok: boolean; candidateId?: number; error?: string }> {
    if (!chatId.endsWith('@g.us')) return { ok: false, error: 'sadece grup' };
    try {
      const result = await extractionRunner.extractGroup(chatId);
      if (!result.ok) return { ok: false, error: result.error ?? 'extraction_failed' };
      const summary = result.summary ?? '';
      const tasks = result.tasks ?? [];

      // Grup CRM eşlemesinden firma/proje bağlamını çöz (varsa). Eşleme yoksa alanlar undefined kalır.
      const mapping = store.getGroupCrmMapping(config.tenantId, chatId);

      // Dedup hash: chatId + özet + görev başlıkları. Aynı içerik → aynı hash → store mevcut adayı döner.
      const hashInput = chatId + '|' + summary + '|' + tasks.map((t) => t.title).join('|');
      const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

      // Tüm görevlerin kaynak mesaj id'lerinin uniq birleşimi → aday seviyesinde izlenebilirlik.
      const sourceMessageIds = [...new Set(tasks.flatMap((t) => t.sourceMessageIds))];

      const candidate = store.insertGroupCandidate({
        tenantId: config.tenantId,
        chatId,
        ...(mapping?.customerSlug ? { customerSlug: mapping.customerSlug } : {}),
        ...(mapping?.perfexClientId !== undefined ? { perfexClientId: mapping.perfexClientId } : {}),
        ...(mapping?.perfexProjectId !== undefined ? { perfexProjectId: mapping.perfexProjectId } : {}),
        summary,
        tasks,
        status: 'draft',
        sourceMessageIds,
        extractionSource: 'claude-opus',
        hash,
        perfexTaskIds: []
      });
      // Supersede: yeni aday üretildi → aynı grubun eski 'draft' adaylarını 'discarded' yap
      // (yeni aday hariç). Grup başına tek güncel taslak kalsın.
      store.discardDraftCandidates(config.tenantId, chatId, candidate.id);
      return { ok: true, candidateId: candidate.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'aday çıkarılamadı' };
    }
  }

  function listCandidates(chatId: string): GroupCandidate[] {
    return store.listGroupCandidates(config.tenantId, chatId);
  }

  // Panel "Onaya Sun" butonu: aday → rel çöz (proje varsa project, yoksa client; ikisi de yoksa hata) →
  // her görev için dedup_hash (candidate.hash + '|' + task.title, sha256, 16 hex) → on_approve payload →
  // request_approval.py (Telegram 3-buton). Onay gelince Hermes resolve_approval perfex_task_create
  // aksiyonunu deterministik uygular. ok ise aday status:'sent' + approvalJobId.
  async function submitCandidate(candidateId: number): Promise<{ ok: boolean; jobId?: string; error?: string }> {
    try {
      const candidate = store.getGroupCandidate(config.tenantId, candidateId);
      if (!candidate) return { ok: false, error: 'aday bulunamadı' };
      if (candidate.status !== 'draft') return { ok: false, error: 'aday zaten onaya sunulmuş' };
      const tasks = candidate.tasks ?? [];
      if (tasks.length === 0) return { ok: false, error: 'adayda görev yok' };

      // rel çöz: proje atanmışsa project, yoksa client; ikisi de yoksa grup CRM'e eşli değil.
      let relType: 'project' | 'client';
      let relId: number;
      if (candidate.perfexProjectId !== undefined) {
        relType = 'project';
        relId = candidate.perfexProjectId;
      } else if (candidate.perfexClientId !== undefined) {
        relType = 'client';
        relId = candidate.perfexClientId;
      } else {
        return { ok: false, error: 'grup eşli değil' };
      }

      const payloadTasks = tasks.map((t) => ({
        title: t.title,
        description: t.description,
        priority: t.priority,
        ...(t.suggestedDue ? { suggested_due: t.suggestedDue } : { suggested_due: null }),
        dedup_hash: createHash('sha256').update(candidate.hash + '|' + t.title).digest('hex').slice(0, 16)
      }));

      const onApprove: Record<string, unknown> = {
        action: 'perfex_task_create',
        rel_type: relType,
        rel_id: relId,
        tasks: payloadTasks,
        candidate_id: candidateId,
        tenant_id: config.tenantId,
        // Mutlak path: Hermes resolve_approval farklı CWD'den çalışır; göreceli path yanlış
        // konuma düşer (loop-closure prefix guard'ı da reddeder). resolve = bot CWD'den mutlak.
        bot_db_path: resolve(config.dbPath)
      };

      const titleStr = `Perfex görev onayı (${payloadTasks.length})`;
      const bodyStr = [
        candidate.summary ? candidate.summary : '(özet yok)',
        '',
        ...payloadTasks.map((t, i) => `${i + 1}. ${t.title}`)
      ].join('\n');

      // Atomik rezervasyon: draft→sent CAS. Onay isteği (~30sn) öncesi rezerve et ki aynı
      // adaydan paralel ikinci istek çift Telegram onayı/job oluşturmasın (TOCTOU penceresi).
      if (!store.tryReserveCandidateForApproval(config.tenantId, candidateId)) {
        return { ok: false, error: 'aday zaten onaya sunulmuş' };
      }

      const result = await approvalRequester.requestApproval({
        kind: 'perfex_task_create',
        title: titleStr,
        body: bodyStr,
        on_approve: onApprove,
        ...(candidate.customerSlug ? { customer_slug: candidate.customerSlug } : {})
      });

      if (!result.ok) {
        // Onay isteği başarısız → rezervasyonu geri al ki operatör tekrar deneyebilsin.
        store.updateGroupCandidate(config.tenantId, candidateId, { status: 'draft' });
        return { ok: false, error: result.error ?? 'onay isteği başarısız' };
      }

      if (result.jobId) {
        store.updateGroupCandidate(config.tenantId, candidateId, { approvalJobId: result.jobId });
      }
      return { ok: true, ...(result.jobId ? { jobId: result.jobId } : {}) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'onaya sunulamadı' };
    }
  }

  // Operatör panelden firma/proje değiştirince chat_crm_mapping mirror'ını tazeler ve
  // vault eşleme dosyasını günceller. Slug conversation_settings'ten; perfexClientId/projectName/
  // repoPath karttan zenginleştirilir. Tek projeli kartta seçim yoksa o proje otomatik alınır.
  // Her yan etki (store yazımı, vault yazımı) AYRI try-catch; biri patlarsa diğeri çalışsın.
  async function onConversationCrmChanged(chatId: string): Promise<void> {
    // chat_crm_mapping + vault eşleme YALNIZ grup sohbetleri için tutulur (tablo/dosya semantiği grup).
    // 1:1 sohbet CRM bilgisi conversation_settings'te yaşar; bu callback'ten önce panel onu yazdı.
    if (!chatId.endsWith('@g.us')) return;

    const settings = await store.getConversationSettings(config.tenantId, chatId);
    const slug = settings.customerSlug;
    if (!slug) return;

    const card = readCustomerCard(slug, config.customersDir);
    // perfexProjectId operatörce seçilmemişse (undefined) ve kart tek projeliyse onu varsay.
    // Store 0'ı undefined'a normalize ettiğinden burada yalnız undefined kontrolü yeter.
    let perfexProjectId = settings.perfexProjectId;
    if (perfexProjectId === undefined && card && card.perfexProjectIds.length === 1) {
      perfexProjectId = card.perfexProjectIds[0]?.id;
    }
    const projectName = card?.perfexProjectIds.find((p) => p.id === perfexProjectId)?.name;

    const mapping: ChatCrmMapping = {
      tenantId: config.tenantId,
      chatId,
      customerSlug: slug,
      ...(card?.perfexClientId !== undefined ? { perfexClientId: card.perfexClientId } : {}),
      ...(perfexProjectId !== undefined ? { perfexProjectId } : {}),
      ...(projectName ? { projectName } : {}),
      ...(card?.repoPath ? { repoPath: card.repoPath } : {}),
      updatedAt: new Date().toISOString()
    };

    // Her yan etki AYRI try-catch; biri patlarsa diğeri çalışsın.
    try {
      store.setGroupCrmMapping(mapping);
    } catch (error) {
      console.error('chat_crm_mapping mirror tazeleme hatası:', error instanceof Error ? error.message : error);
    }

    try {
      upsertGroupMapping(config.groupMapPath, {
        chatId,
        slug,
        ...(card?.perfexClientId !== undefined ? { perfexClientId: card.perfexClientId } : {}),
        ...(perfexProjectId !== undefined ? { perfexProjectId } : {}),
        ...(projectName ? { projectName } : {})
      });
    } catch (error) {
      console.error('Vault grup eşleme yazımı hatası:', error instanceof Error ? error.message : error);
    }
  }

  // Startup loader: vault eşleme dosyası authoritative. Her entry'yi kartla zenginleştirip
  // chat_crm_mapping mirror'ını tazeler. Hata botu durdurmaz (log + devam).
  function loadGroupMappingsFromVault(): void {
    try {
      const entries = parseGroupMappings(config.groupMapPath);
      const vaultChatIds = new Set(entries.map((e) => e.chatId));
      for (const entry of entries) {
        const card = readCustomerCard(entry.slug, config.customersDir);
        const projectName = entry.projectName
          ?? card?.perfexProjectIds.find((p) => p.id === entry.perfexProjectId)?.name;
        const mapping: ChatCrmMapping = {
          tenantId: config.tenantId,
          chatId: entry.chatId,
          customerSlug: entry.slug,
          ...(entry.perfexClientId !== undefined ? { perfexClientId: entry.perfexClientId }
            : card?.perfexClientId !== undefined ? { perfexClientId: card.perfexClientId } : {}),
          ...(entry.perfexProjectId !== undefined ? { perfexProjectId: entry.perfexProjectId } : {}),
          ...(projectName ? { projectName } : {}),
          ...(card?.repoPath ? { repoPath: card.repoPath } : {}),
          updatedAt: new Date().toISOString()
        };
        try {
          store.setGroupCrmMapping(mapping);
        } catch (error) {
          console.error(`Grup eşleme mirror yazımı hatası (chat=${entry.chatId}):`, error instanceof Error ? error.message : error);
        }
      }
      // Vault authoritative: vault'tan silinmiş grup eşlemelerini SQLite mirror'dan da temizle (stale önle).
      try {
        for (const existing of store.listGroupCrmMappings(config.tenantId)) {
          if (existing.chatId.endsWith('@g.us') && !vaultChatIds.has(existing.chatId)) {
            store.deleteGroupCrmMapping(config.tenantId, existing.chatId);
          }
        }
      } catch (error) {
        console.error('Stale grup eşleme temizleme hatası:', error instanceof Error ? error.message : error);
      }
      console.log('Vault grup eşleme yüklendi: %d entry', entries.length);
    } catch (error) {
      console.error('Vault grup eşleme yükleme hatası:', error instanceof Error ? error.message : error);
    }
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
    listProjects: (customerSlug) => listProjects(customerSlug),
    onCustomerAssigned: (chatId, slug) => mediaArchiver.onCustomerAssigned(chatId, slug),
    onConversationCrmChanged: (chatId) => onConversationCrmChanged(chatId),
    getPerfexTasks: (chatId) => getPerfexTasks(chatId),
    extractGroup: (chatId) => extractGroup(chatId),
    listCandidates: async (chatId) => listCandidates(chatId),
    submitCandidate: (candidateId) => submitCandidate(candidateId),
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
