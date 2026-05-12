import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type proto,
  type WASocket
} from '@whiskeysockets/baileys';
import type { RuntimeConfig } from '../config.js';
import type { MessageRouter } from '../router.js';
import type { InboundMessage } from '../types.js';
import { writeQrArtifacts } from './qr-artifacts.js';
import { shouldReconnectAfterClose } from './reconnect-policy.js';

export async function startBaileysClient(config: RuntimeConfig, router: MessageRouter): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: ['MURTAZA', 'Chrome', '0.1.0']
  });

  sock.ev.on('creds.update', saveCreds);

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
        void startBaileysClient(config, router);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const raw of messages) {
      const inbound = toInboundMessage(config, raw);
      if (!inbound) continue;

      const decision = await router.handleInbound(inbound);
      if (decision.shouldReply && decision.replyText) {
        await sock.sendMessage(inbound.chatId, { text: decision.replyText });
      }
    }
  });

  return sock;
}

export function toInboundMessage(config: RuntimeConfig, raw: proto.IWebMessageInfo): InboundMessage | null {
  const key = raw.key;
  if (!key || key.fromMe) return null;

  const chatId = key.remoteJid;
  const messageId = key.id;
  if (!chatId || !messageId) return null;

  const text = extractText(raw.message);
  if (!text) return null;

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
    text,
    receivedAt: new Date(Number(raw.messageTimestamp ?? Date.now() / 1000) * 1000)
  };
}

function extractText(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}
