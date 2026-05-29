import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface RuntimeConfig {
  tenantId: string;
  displayName: string;
  dbPath: string;
  authDir: string;
  whitelistPhones: string[];
  autoReply: boolean;
  autoReplyAudience: 'whitelist' | 'all';
  operatorPort: number;
  operatorToken: string;
  operatorHost: string;
  operatorNoAuth: boolean;
}

type Env = Record<string, string | undefined>;

export function loadConfigFromEnv(env: Env = process.env): RuntimeConfig {
  const dbPath = env.BOT_DB_PATH?.trim() || './data/poc.sqlite';
  return {
    tenantId: env.BOT_TENANT_ID?.trim() || 'esmark-test',
    displayName: env.BOT_DISPLAY_NAME?.trim() || 'ESMARK Asistan',
    dbPath,
    authDir: env.BOT_AUTH_DIR?.trim() || './data/auth/esmark-test',
    whitelistPhones: splitCsv(env.BOT_WHITELIST_PHONES),
    autoReply: env.BOT_AUTO_REPLY === 'true',
    autoReplyAudience: env.BOT_AUTO_REPLY_AUDIENCE === 'all' ? 'all' : 'whitelist',
    operatorPort: Number(env.BOT_OPERATOR_PORT ?? '8787'),
    operatorToken: resolveOperatorToken(env, dbPath),
    operatorHost: env.BOT_OPERATOR_HOST?.trim() || '127.0.0.1',
    operatorNoAuth: env.BOT_OPERATOR_NO_AUTH === 'true'
  };
}

function resolveOperatorToken(env: Env, dbPath: string): string {
  const fromEnv = env.BOT_OPERATOR_TOKEN?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const dataDir = dirname(resolve(dbPath));
  const tokenPath = resolve(dataDir, 'operator-token.txt');
  if (existsSync(tokenPath)) {
    const cached = readFileSync(tokenPath, 'utf8').trim();
    if (cached.length >= 16) return cached;
  }
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const generated = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, generated + '\n', { encoding: 'utf8' });
  try { chmodSync(tokenPath, 0o600); } catch { /* best effort on non-POSIX */ }
  return generated;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
