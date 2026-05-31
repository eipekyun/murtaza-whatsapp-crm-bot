import { describe, expect, it } from 'vitest';
import { loadConfigFromEnv } from '../src/config.js';

describe('runtime config', () => {
  it('loads safe defaults and whitelist from env', () => {
    const config = loadConfigFromEnv({
      BOT_TENANT_ID: 'esmark-test',
      BOT_DISPLAY_NAME: 'ESMARK Asistan',
      BOT_DB_PATH: './data/test.sqlite',
      BOT_AUTH_DIR: './data/auth/test',
      BOT_WHITELIST_PHONES: '+90 555 111 22 33,05559998877',
      BOT_AUTO_REPLY: 'true'
    });

    expect(config.tenantId).toBe('esmark-test');
    expect(config.whitelistPhones).toEqual(['+90 555 111 22 33', '05559998877']);
    expect(config.autoReply).toBe(true);
  });

  it('keeps auto reply disabled unless explicitly true', () => {
    const config = loadConfigFromEnv({});

    expect(config.autoReply).toBe(false);
    expect(config.tenantId).toBe('esmark-test');
  });

  it('derives groupMapPath from customersDir by default (../02-Temel/WhatsApp-Grup-Eslemesi.md)', () => {
    const config = loadConfigFromEnv({ BOT_CUSTOMERS_DIR: '/vault/01-Musteriler' });

    expect(config.customersDir).toBe('/vault/01-Musteriler');
    expect(config.groupMapPath).toBe('/vault/02-Temel/WhatsApp-Grup-Eslemesi.md');
  });

  it('honors explicit BOT_GROUP_MAP_PATH override', () => {
    const config = loadConfigFromEnv({
      BOT_CUSTOMERS_DIR: '/vault/01-Musteriler',
      BOT_GROUP_MAP_PATH: '/custom/map.md'
    });

    expect(config.groupMapPath).toBe('/custom/map.md');
  });

  it('falls back perfexQueryPython to BOT_DRIVE_PYTHON, then to pipx default', () => {
    const fromDrive = loadConfigFromEnv({ BOT_DRIVE_PYTHON: '/opt/py/python3' });
    expect(fromDrive.perfexQueryPython).toBe('/opt/py/python3');

    const fallback = loadConfigFromEnv({});
    expect(fallback.perfexQueryPython).toContain('hermes-agent');
  });

  it('honors explicit BOT_PERFEX_PYTHON over BOT_DRIVE_PYTHON', () => {
    const config = loadConfigFromEnv({
      BOT_PERFEX_PYTHON: '/usr/bin/python3',
      BOT_DRIVE_PYTHON: '/opt/py/python3'
    });

    expect(config.perfexQueryPython).toBe('/usr/bin/python3');
  });

  it('defaults perfexQueryScript to scripts/perfex-query.py and honors override', () => {
    const fallback = loadConfigFromEnv({});
    expect(fallback.perfexQueryScript.endsWith('scripts/perfex-query.py')).toBe(true);

    const override = loadConfigFromEnv({ BOT_PERFEX_QUERY_SCRIPT: '/custom/q.py' });
    expect(override.perfexQueryScript).toBe('/custom/q.py');
  });

  it('expands ~ in perfexOpsEnvPath and honors override', () => {
    const fallback = loadConfigFromEnv({});
    expect(fallback.perfexOpsEnvPath.startsWith('~')).toBe(false);
    expect(fallback.perfexOpsEnvPath.endsWith('.config/murtaza-vps-ops.env')).toBe(true);

    const override = loadConfigFromEnv({ BOT_PERFEX_OPS_ENV: '/srv/ops.env' });
    expect(override.perfexOpsEnvPath).toBe('/srv/ops.env');
  });

  // Wiring sözleşmesi (index.ts): createPerfexReader bu üç alanı doğrudan tüketir
  // ({ python, scriptPath, opsEnvPath }). Hepsi non-empty string olmalı; aksi halde
  // subprocess köprüsü sessizce yanlış path'le çağrılır.
  it('provides all three perfex* fields createPerfexReader consumes (non-empty strings)', () => {
    const config = loadConfigFromEnv({});
    for (const value of [config.perfexQueryPython, config.perfexQueryScript, config.perfexOpsEnvPath]) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
