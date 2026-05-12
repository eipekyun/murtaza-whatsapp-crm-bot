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
});
