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

export interface BaileysClientOptions {
  onOutboundSent?: (message: OutboundMessage) => Promise<void>;
  onHistorySync?: (chunk: { imported: number; progress?: number }) => Promise<void>;
  onSocketReady?: (sock: WASocket) => void;
  onContactName?: (jid: string, name: string, source?: string) => Promise<void> | void;
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
      const name = c.name || c.notify || c.verifiedName;
      if (c.id && name) void options.onContactName?.(c.id, name, 'contact');
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
      if (decision.shouldReply && decision.replyText) {
        await sendTypingPause(sock, inbound.chatId, decision.replyDelayMs ?? 2500);
        const sent = await sock.sendMessage(inbound.chatId, { text: decision.replyText });
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
          text: decision.replyText,
          sentAt: new Date()
        });
      }
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      const name = c.name || c.notify || c.verifiedName;
      if (c.id && name) void options.onContactName?.(c.id, name, 'contact');
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const c of updates) {
      const name = c.name || c.notify || c.verifiedName;
      if (c.id && name) void options.onContactName?.(c.id, name, 'contact');
    }
  });

  return sock;
}

export function toOutboundFromSelf(config: RuntimeConfig, raw: proto.IWebMessageInfo): OutboundMessage | null {
  const key = raw.key;
  if (!key || !key.fromMe) return null;

  const chatId = key.remoteJid;
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
  const key = raw.key;
  if (!key || key.fromMe) return null;

  const chatId = key.remoteJid;
  const messageId = key.id;
  if (!chatId || !messageId) return null;

  const media = extractMedia(raw.message);
  const text = extractText(raw.message) || media?.fallbackText;
  if (!text && !media) return null;

  const senderJid = key.participant || chatId;
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
