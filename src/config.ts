export interface RuntimeConfig {
  tenantId: string;
  displayName: string;
  dbPath: string;
  authDir: string;
  whitelistPhones: string[];
  autoReply: boolean;
}

type Env = Record<string, string | undefined>;

export function loadConfigFromEnv(env: Env = process.env): RuntimeConfig {
  return {
    tenantId: env.BOT_TENANT_ID?.trim() || 'esmark-test',
    displayName: env.BOT_DISPLAY_NAME?.trim() || 'ESMARK Asistan',
    dbPath: env.BOT_DB_PATH?.trim() || './data/poc.sqlite',
    authDir: env.BOT_AUTH_DIR?.trim() || './data/auth/esmark-test',
    whitelistPhones: splitCsv(env.BOT_WHITELIST_PHONES),
    autoReply: env.BOT_AUTO_REPLY === 'true'
  };
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
