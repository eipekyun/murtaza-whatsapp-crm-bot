import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type proto,
  type WASocket
} from '@whiskeysockets/baileys';
import type { RuntimeConfig } from '../config.js';
import type { MessageRouter } from '../router.js';
import type { InboundMessage, OutboundMessage } from '../types.js';
import { writeQrArtifacts } from './qr-artifacts.js';
import { shouldReconnectAfterClose } from './reconnect-policy.js';

type AltKey = proto.IMessageKey & { remoteJidAlt?: string; participantAlt?: string };

// WhatsApp LID (@lid) adreslemesi aynı kişiyi telefon JID'sinden ayrı gösterir.
// Baileys mesaj key'inde PN karşılığı remoteJidAlt/participantAlt olarak gelir;
// @lid ise PN'i tercih ederek sohbetleri tek kişide birleştiririz.
function preferPn(jid: string | null | undefined, alt: string | null | undefined): string | null | undefined {
  return jid && jid.endsWith('@lid') && alt ? alt : jid;
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

      const decision = await router.handleInbound(inbound);
      console.log(`Router kararı: chat=…${inbound.chatId.split('@')[0].slice(-4)} cevap=${decision.shouldReply} sebep=${decision.reason}`);
      if (decision.shouldReply && decision.replyText) {
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
