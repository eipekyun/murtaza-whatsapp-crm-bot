import 'dotenv/config';
import { loadConfigFromEnv } from './config.js';
import { createRouter } from './router.js';
import { createSqliteMessageStore } from './store/sqlite-message-store.js';
import { createOperatorHttpServer } from './http/operator-server.js';
import { startBaileysClient } from './whatsapp/baileys-client.js';
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
  sock = await startBaileysClient(config, router, {
    onSocketReady: (nextSock) => {
      sock = nextSock;
    },
    onOutboundSent: (message) => store.saveOutbound(message),
    onContactName: (jid, name, source) => store.saveContactName(config.tenantId, jid, name, source),
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
  });
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
