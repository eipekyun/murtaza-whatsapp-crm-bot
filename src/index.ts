import 'dotenv/config';
import { loadConfigFromEnv } from './config.js';
import { createRouter } from './router.js';
import { createSqliteMessageStore } from './store/sqlite-message-store.js';
import { startBaileysClient } from './whatsapp/baileys-client.js';

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const store = createSqliteMessageStore(config.dbPath);
  const router = createRouter({
    tenantId: config.tenantId,
    whitelistPhones: config.whitelistPhones,
    autoReply: config.autoReply,
    saveInbound: (message) => store.saveInbound(message)
  });

  console.log(`MURTAZA WhatsApp CRM PoC başlıyor: tenant=${config.tenantId} autoReply=${config.autoReply}`);
  console.log(`Whitelist kayıt sayısı: ${config.whitelistPhones.length}`);
  await startBaileysClient(config, router);
}

main().catch((error) => {
  console.error('Bot başlatılamadı:', error);
  process.exitCode = 1;
});
