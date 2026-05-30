import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import makeWASocket, {
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type proto,
  type WAMessage,
  type WASocket
} from '@whiskeysockets/baileys';
import type { RuntimeConfig } from '../config.js';
import type { MessageRouter } from '../router.js';
import type { InboundMessage, MediaKind, OutboundMessage } from '../types.js';
import { writeQrArtifacts } from './qr-artifacts.js';
import { shouldReconnectAfterClose } from './reconnect-policy.js';

type AltKey = proto.IMessageKey & { remoteJidAlt?: string; participantAlt?: string };

// downloadMediaMessage context tipi (Baileys v7'de logger zorunlu, pino Logger bekler).
type DownloadCtx = Parameters<typeof downloadMediaMessage>[3];

// WhatsApp LID (@lid) adreslemesi aynı kişiyi telefon JID'sinden ayrı gösterir.
// Baileys mesaj key'inde PN karşılığı remoteJidAlt/participantAlt olarak gelir;
// @lid ise PN'i tercih ederek sohbetleri tek kişide birleştiririz.
function preferPn(jid: string | null | undefined, alt: string | null | undefined): string | null | undefined {
  return jid && jid.endsWith('@lid') && alt ? alt : jid;
}

export interface IncomingMediaEvent {
  chatId: string;
  messageId: string;
  mediaKind: MediaKind;
  mediaMime?: string;
  mediaName?: string;
  localPath: string;
}

export interface BaileysClientOptions {
  onOutboundSent?: (message: OutboundMessage) => Promise<void>;
  onHistorySync?: (chunk: { imported: number; progress?: number }) => Promise<void>;
  onSocketReady?: (sock: WASocket) => void;
  onContactName?: (jid: string, name: string, source?: string) => Promise<void> | void;
  onMessageStatus?: (messageId: string, status: number) => Promise<void> | void;
  onAfterReply?: (chatId: string) => Promise<void> | void;
  onConnectionState?: (state: string, me?: string) => void;
  getBotReplyDelayMs?: () => number;
  shouldStillReply?: (chatId: string, sinceIso: string) => Promise<boolean>;
  // Gelen medya arşivleme: canlı inbound medya yerel dosyaya indirilince çağrılır.
  onIncomingMedia?: (event: IncomingMediaEvent) => Promise<void> | void;
  // Boyut limiti aşıldığı için indirilmeyen medya bildirilir (status=skipped işaretlemek için).
  onMediaSkipped?: (event: { chatId: string; messageId: string; mediaKind: MediaKind }) => Promise<void> | void;
  mediaIncomingDir?: string;
  archiveKinds?: Set<MediaKind>;
  // Gelen medya için indirme üst sınırı (bytes). Aşılırsa indirilmez. undefined = limitsiz.
  maxMediaBytes?: number;
  // Arşivleme izni: true ise medya indirilip arşivlenir. Whitelist gönderen VEYA sohbet bir
  // firmaya atanmış (grup→firma medyası için whitelist dışı üyeler de dahil) → true.
  shouldArchiveMedia?: (chatId: string, senderPhone: string) => Promise<boolean> | boolean;
}

export async function startBaileysClient(config: RuntimeConfig, router: MessageRouter, options: BaileysClientOptions = {}): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    syncFullHistory: false,
    browser: ['MURTAZA', 'Chrome', '0.1.0']
  });

  sock.ev.on('creds.update', saveCreds);
  options.onSocketReady?.(sock);

  const botSentIds = new Set<string>();
  const resolvedGroups = new Set<string>();

  async function resolveGroupName(jid: string): Promise<void> {
    if (!jid.endsWith('@g.us') || resolvedGroups.has(jid)) return;
    resolvedGroups.add(jid);
    try {
      const meta = await sock.groupMetadata(jid);
      if (meta?.subject) await options.onContactName?.(jid, meta.subject, 'group');
    } catch { /* grup metadata alınamazsa sessiz geç */ }
  }

  sock.ev.on('messaging-history.set', async ({ messages, contacts, chats, progress }) => {
    for (const c of contacts ?? []) {
      const saved = c.name || c.verifiedName;
      if (c.id && saved) void options.onContactName?.(c.id, saved, 'contact');
      if (c.id && c.notify) void options.onContactName?.(c.id, c.notify, 'push');
    }
    for (const ch of chats ?? []) {
      if (ch.id && ch.name && ch.id.endsWith('@g.us')) void options.onContactName?.(ch.id, ch.name, 'group');
    }
    let imported = 0;
    for (const raw of messages) {
      if (raw.key?.fromMe) {
        const outbound = toOutboundFromSelf(config, raw);
        if (outbound) { await options.onOutboundSent?.(outbound); imported += 1; }
        continue;
      }
      const inbound = toInboundMessage(config, raw);
      if (!inbound) continue;
      if (raw.pushName) void options.onContactName?.(raw.key?.participant || inbound.chatId, raw.pushName, 'push');
      void resolveGroupName(inbound.chatId);
      await router.handleInbound(inbound);
      imported += 1;
    }
    if (imported > 0) console.log(`WhatsApp history chunk kaydedildi: imported=${imported} progress=${progress ?? 'unknown'}`);
    await options.onHistorySync?.({ imported, progress: progress ?? undefined });
  });

  sock.ev.on('connection.update', (update) => {
    if (update.qr) options.onConnectionState?.('qr');
    else if (update.connection) options.onConnectionState?.(update.connection, sock.user?.id ?? undefined);
    if (update.qr) {
      void writeQrArtifacts(update.qr).then((artifacts) => {
        console.log('\nWhatsApp QR hazır. Telefondan WhatsApp Business > Bağlı Cihazlar > Cihaz Bağla ile okut.');
        console.log(`PNG QR: ${artifacts.pngPath}`);
        console.log(`Terminal QR: ${artifacts.terminalPath}`);
        console.log('QR expire olursa botu açık bırakma; yeni QR için yeniden başlat.\n');
      }).catch((error) => {
        console.error('QR çıktıları yazılamadı:', error);
      });
    }

    if (update.connection === 'open') {
      console.log(`WhatsApp bağlantısı hazır: tenant=${config.tenantId}`);
      // Baileys'in ilk app-state senkronu rehber (contacts/critical_unblock_low) koleksiyonunu
      // eksik çekiyor; bağlanınca app-state'i yeniden senkronlayıp kayıtlı kişi adlarını tam alırız.
      setTimeout(() => {
        void (sock as unknown as { resyncAppState?: (c: string[], i: boolean) => Promise<void> }).resyncAppState?.(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false)
          .catch((error: unknown) => console.error('Rehber resync hatası:', error instanceof Error ? error.message : error));
      }, 4000);
    }

    if (update.connection === 'close') {
      const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const shouldReconnect = shouldReconnectAfterClose(statusCode);
      console.log(`WhatsApp bağlantısı kapandı. shouldReconnect=${shouldReconnect} status=${statusCode ?? 'unknown'}`);
      if (shouldReconnect) {
        void startBaileysClient(config, router, options);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const raw of messages) {
      if (raw.key?.fromMe) {
        const selfMessageId = raw.key.id ?? '';
        if (selfMessageId && botSentIds.has(selfMessageId)) continue;
        const outbound = toOutboundFromSelf(config, raw);
        if (outbound) await options.onOutboundSent?.(outbound);
        continue;
      }

      const inbound = toInboundMessage(config, raw);
      if (!inbound) continue;
      if (raw.pushName) void options.onContactName?.(raw.key?.participant || inbound.chatId, raw.pushName, 'push');
      void resolveGroupName(inbound.chatId);

      // Sadece CANLI inbound medya arşivlenir; messaging-history.set'e EKLENMEZ (toplu indirme yasak).
      // Arşivleme izni archiveInboundMedia içinde shouldArchiveMedia ile verilir (whitelist VEYA
      // sohbet bir firmaya atanmış — atanmış grubun whitelist dışı üyelerinin medyası da dahil).
      if (inbound.mediaKind && options.onIncomingMedia && (options.archiveKinds?.has(inbound.mediaKind) ?? true)) {
        void archiveInboundMedia(sock, raw, inbound, options);
      }

      const decision = await router.handleInbound(inbound);
      console.log(`Router kararı: chat=…${inbound.chatId.split('@')[0].slice(-4)} cevap=${decision.shouldReply} sebep=${decision.reason}`);
      // Çift güvenlik: gruba (@g.us) hiçbir koşulda otomatik cevap gönderme.
      if (decision.shouldReply && decision.replyText && !inbound.chatId.endsWith('@g.us')) {
        const replyText = decision.replyText;
        const sinceIso = inbound.receivedAt.toISOString();
        // Operatöre öncelik: bekleme süresi sonunda operatör araya girmediyse bot cevaplar.
        const graceMs = options.getBotReplyDelayMs?.() ?? decision.replyDelayMs ?? 2500;
        setTimeout(() => {
          void (async () => {
            try {
              if (options.shouldStillReply && !(await options.shouldStillReply(inbound.chatId, sinceIso))) return;
              await sendTypingPause(sock, inbound.chatId, 2500);
              const sent = await sock.sendMessage(inbound.chatId, { text: replyText });
              if (sent?.key.id) botSentIds.add(sent.key.id);
              await options.onOutboundSent?.({
                tenantId: config.tenantId,
                channel: 'whatsapp',
                provider: 'baileys',
                direction: 'outbound',
                origin: 'bot',
                messageId: sent?.key.id ?? `bot-${inbound.messageId}`,
                chatId: inbound.chatId,
                recipientPhone: inbound.senderPhone,
                text: replyText,
                sentAt: new Date()
              });
              void options.onAfterReply?.(inbound.chatId);
            } catch (error) {
              console.error('Gecikmeli bot cevabı hatası:', error instanceof Error ? error.message : error);
            }
          })();
        }, graceMs);
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const id = u.key?.id;
      const status = u.update?.status;
      if (id && typeof status === 'number') void options.onMessageStatus?.(id, status);
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    let savedCount = 0;
    for (const c of contacts) {
      const saved = c.name || c.verifiedName;
      if (saved) savedCount += 1;
      if (c.id && saved) void options.onContactName?.(c.id, saved, 'contact');
      if (c.id && c.notify) void options.onContactName?.(c.id, c.notify, 'push');
    }
    if (savedCount > 0) console.log(`Rehber senkronu: ${savedCount} kayıtlı ad alındı`);
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const c of updates) {
      const saved = c.name || c.verifiedName;
      if (c.id && saved) void options.onContactName?.(c.id, saved, 'contact');
      if (c.id && c.notify) void options.onContactName?.(c.id, c.notify, 'push');
    }
  });

  return sock;
}

// Test erişimi için saf yardımcıları açığa çıkar (runtime davranışı değişmez).
export const __baileysInternals = {
  safeSegment,
  mediaExceedsLimit
};

export function toOutboundFromSelf(config: RuntimeConfig, raw: proto.IWebMessageInfo): OutboundMessage | null {
  const key = raw.key as AltKey | null | undefined;
  if (!key || !key.fromMe) return null;

  const chatId = preferPn(key.remoteJid, key.remoteJidAlt);
  const messageId = key.id;
  if (!chatId || !messageId) return null;

  const media = extractMedia(raw.message);
  const text = extractText(raw.message) || media?.fallbackText;
  if (!text && !media) return null;

  const recipientPhone = chatId.split('@')[0] ?? chatId;

  return {
    tenantId: config.tenantId,
    channel: 'whatsapp',
    provider: 'baileys',
    direction: 'outbound',
    origin: 'self',
    messageId,
    chatId,
    recipientPhone,
    text: text ?? '',
    mediaKind: media?.kind,
    mediaName: media?.name,
    mediaMime: media?.mime,
    sentAt: new Date(Number(raw.messageTimestamp ?? Date.now() / 1000) * 1000)
  };
}

export function toInboundMessage(config: RuntimeConfig, raw: proto.IWebMessageInfo): InboundMessage | null {
  const key = raw.key as AltKey | null | undefined;
  if (!key || key.fromMe) return null;

  const chatId = preferPn(key.remoteJid, key.remoteJidAlt);
  const messageId = key.id;
  if (!chatId || !messageId) return null;

  const media = extractMedia(raw.message);
  const text = extractText(raw.message) || media?.fallbackText;
  if (!text && !media) return null;

  const senderJid = preferPn(key.participant, key.participantAlt) || chatId;
  const senderPhone = senderJid.split('@')[0] ?? senderJid;

  return {
    tenantId: config.tenantId,
    channel: 'whatsapp',
    provider: 'baileys',
    direction: 'inbound',
    messageId,
    chatId,
    senderPhone,
    senderDisplayName: raw.pushName ?? undefined,
    text: text ?? '',
    mediaKind: media?.kind,
    mediaName: media?.name,
    mediaMime: media?.mime,
    receivedAt: new Date(Number(raw.messageTimestamp ?? Date.now() / 1000) * 1000)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTypingPause(sock: WASocket, chatId: string, delayMs: number): Promise<void> {
  const safeDelay = Math.max(1000, Math.min(8000, delayMs));
  try {
    await sock.presenceSubscribe(chatId);
    await sock.sendPresenceUpdate('composing', chatId);
    await delay(safeDelay);
    await sock.sendPresenceUpdate('paused', chatId);
  } catch {
    await delay(safeDelay);
  }
}

function extractText(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    null
  );
}

// Canlı inbound medyayı buffer olarak indirir, yerel geçici dosyaya yazar, onIncomingMedia tetikler.
// Hata olursa sessiz yutmaz; loglar ama akışı kesmez (void + catch çağırandadır).
async function archiveInboundMedia(
  sock: WASocket,
  raw: proto.IWebMessageInfo,
  inbound: InboundMessage,
  options: BaileysClientOptions
): Promise<void> {
  const kind = inbound.mediaKind;
  if (!kind) return;
  // Arşivleme izni: whitelist gönderen VEYA firmaya atanmış sohbet. İzin yoksa indirme bile yapma
  // (tanımadık/spam gönderenin diske/Drive'a yazmasını önler).
  if (options.shouldArchiveMedia) {
    try {
      const allowed = await options.shouldArchiveMedia(inbound.chatId, inbound.senderPhone);
      if (!allowed) return;
    } catch (error) {
      console.error('Medya arşivleme izni kontrolü hatası:', error instanceof Error ? error.message : error);
      return;
    }
  }
  // Boyut limiti: indirmeden ÖNCE mesaj node'undaki fileLength'e bak. Aşıyorsa indirme
  // (disk/RAM DoS koruması). fileLength yoksa best-effort indir.
  const fileLength = mediaFileLength(raw.message);
  if (mediaExceedsLimit(fileLength, options.maxMediaBytes)) {
    console.error(`Medya boyut limiti aşıldı, atlandı: msg=${inbound.messageId} kind=${kind} bytes=${String(fileLength)}`);
    try { await options.onMediaSkipped?.({ chatId: inbound.chatId, messageId: inbound.messageId, mediaKind: kind }); }
    catch (error) { console.error('Medya skip işaretleme hatası:', error instanceof Error ? error.message : error); }
    return;
  }
  try {
    // raw burada geçerli key'e sahip (toInboundMessage key.id'yi zaten doğruladı);
    // Baileys WAMessage tipini bekliyor, IWebMessageInfo'dan cast ediyoruz.
    // Context, Baileys v7'de logger zorunlu; socket'in kendi logger'ını veriyoruz.
    // socket logger ILogger, context Logger bekliyor (yapısal olarak uyumlu, sadece
    // opsiyonel 'level' alanı eksik) -> context'i DownloadCtx olarak cast ediyoruz.
    const ctx = {
      logger: (sock as unknown as { logger: unknown }).logger,
      reuploadRequest: sock.updateMediaMessage.bind(sock)
    } as DownloadCtx;
    const buffer = await downloadMediaMessage(raw as WAMessage, 'buffer', {}, ctx) as Buffer;
    const baseDir = options.mediaIncomingDir ?? './data/media/incoming';
    const chatSeg = safeSegment(inbound.chatId);
    const ext = inbound.mediaName ? extname(inbound.mediaName) : extForMime(inbound.mediaMime, kind);
    const nameSeg = inbound.mediaName ? `-${safeSegment(inbound.mediaName)}` : ext;
    const localPath = join(baseDir, chatSeg, `${safeSegment(inbound.messageId)}${nameSeg}`);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, buffer);
    await options.onIncomingMedia?.({
      chatId: inbound.chatId,
      messageId: inbound.messageId,
      mediaKind: kind,
      mediaMime: inbound.mediaMime,
      mediaName: inbound.mediaName,
      localPath
    });
  } catch (error) {
    console.error('Gelen medya arşivleme hatası:', error instanceof Error ? error.message : error);
  }
}

export function safeSegment(value: string): string {
  const cleaned = (value || 'x').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'x';
  // Salt-nokta segmentleri (. / .. / ...) path traversal'a açar; nötrle.
  return /^\.+$/.test(cleaned) ? 'x' : cleaned;
}

// Baileys medya node'undan fileLength'i çıkarır (image/video/document/audio).
function mediaFileLength(message: proto.IMessage | null | undefined): unknown {
  if (!message) return undefined;
  return message.imageMessage?.fileLength
    ?? message.videoMessage?.fileLength
    ?? message.documentMessage?.fileLength
    ?? message.audioMessage?.fileLength
    ?? message.stickerMessage?.fileLength
    ?? undefined;
}

// Boyut limiti kararı (saf fonksiyon, testlenir). fileLength Long olabilir (toNumber/low
// alanlı obje) ya da number/string; bilinmiyorsa indir (false). maxBytes yoksa limit yok.
export function mediaExceedsLimit(fileLength: unknown, maxBytes?: number): boolean {
  if (!maxBytes || maxBytes <= 0) return false;
  const size = toNumberLength(fileLength);
  if (size === undefined) return false;
  return size > maxBytes;
}

function toNumberLength(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value === 'object') {
    const obj = value as { toNumber?: () => number; low?: number };
    if (typeof obj.toNumber === 'function') {
      const n = obj.toNumber();
      return Number.isFinite(n) ? n : undefined;
    }
    if (typeof obj.low === 'number') {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

export function extForMime(mime: string | undefined, kind: MediaKind): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'application/pdf': '.pdf'
  };
  if (mime && map[mime]) return map[mime];
  const kindDefault: Record<MediaKind, string> = {
    image: '.jpg',
    video: '.mp4',
    audio: '.ogg',
    document: '.bin',
    sticker: '.webp'
  };
  return kindDefault[kind];
}

function extractMedia(message: proto.IMessage | null | undefined): { kind: InboundMessage['mediaKind']; name?: string; mime?: string; fallbackText: string } | null {
  if (!message) return null;
  if (message.imageMessage) return { kind: 'image', mime: message.imageMessage.mimetype ?? 'image/jpeg', fallbackText: '[Görsel]' };
  if (message.videoMessage) return { kind: 'video', mime: message.videoMessage.mimetype ?? 'video/mp4', fallbackText: '[Video]' };
  if (message.audioMessage) return { kind: 'audio', mime: message.audioMessage.mimetype ?? 'audio/ogg', fallbackText: '[Ses]' };
  if (message.stickerMessage) return { kind: 'sticker', mime: message.stickerMessage.mimetype ?? 'image/webp', fallbackText: '[Sticker]' };
  if (message.documentMessage) return {
    kind: 'document',
    name: message.documentMessage.fileName ?? undefined,
    mime: message.documentMessage.mimetype ?? 'application/octet-stream',
    fallbackText: `[Dosya] ${message.documentMessage.fileName ?? ''}`.trim()
  };
  return null;
}
