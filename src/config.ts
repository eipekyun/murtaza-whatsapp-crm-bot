import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { MediaKind } from './types.js';

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
  // Gelen medya arşivleme (Drive)
  archiveMedia: boolean;
  archiveKinds: MediaKind[];
  maxMediaBytes: number;
  mediaIncomingDir: string;
  drivePython: string;
  driveUploadScript: string;
  driveTokenPath: string;
  customersDir: string;
}

type Env = Record<string, string | undefined>;

const ALL_MEDIA_KINDS: MediaKind[] = ['image', 'video', 'document', 'audio', 'sticker'];

export function loadConfigFromEnv(env: Env = process.env): RuntimeConfig {
  const dbPath = env.BOT_DB_PATH?.trim() || './data/poc.sqlite';
  const dataDir = dirname(resolve(dbPath));
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
    operatorNoAuth: env.BOT_OPERATOR_NO_AUTH === 'true',
    archiveMedia: env.BOT_ARCHIVE_MEDIA !== 'false',
    archiveKinds: parseMediaKinds(env.BOT_ARCHIVE_MEDIA_KINDS),
    maxMediaBytes: parseMaxMediaBytes(env.BOT_MAX_MEDIA_MB),
    mediaIncomingDir: env.BOT_MEDIA_INCOMING_DIR?.trim() || resolve(dataDir, 'media', 'incoming'),
    drivePython: env.BOT_DRIVE_PYTHON?.trim() || `${homedir()}/.local/share/pipx/venvs/hermes-agent/bin/python3`,
    driveUploadScript: env.BOT_DRIVE_UPLOAD_SCRIPT?.trim() || resolve(process.cwd(), 'scripts', 'wa_drive_upload.py'),
    driveTokenPath: expandHome(env.BOT_DRIVE_TOKEN_PATH?.trim() || '~/.hermes/drive_token.json'),
    customersDir: env.BOT_CUSTOMERS_DIR?.trim() || resolve(process.cwd(), '..', '..', '01-Musteriler')
  };
}

function parseMaxMediaBytes(value: string | undefined): number {
  const mb = Number(value);
  const effectiveMb = Number.isFinite(mb) && mb > 0 ? mb : 50;
  return Math.round(effectiveMb * 1024 * 1024);
}

function parseMediaKinds(value: string | undefined): MediaKind[] {
  const csv = splitCsv(value);
  if (csv.length === 0) return ['image', 'video', 'document', 'audio'];
  const filtered = csv.filter((kind): kind is MediaKind => (ALL_MEDIA_KINDS as string[]).includes(kind));
  return filtered.length > 0 ? filtered : ['image', 'video', 'document', 'audio'];
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
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
