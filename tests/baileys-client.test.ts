import { describe, expect, it } from 'vitest';
import { toInboundMessage } from '../src/whatsapp/baileys-client.js';
import type { RuntimeConfig } from '../src/config.js';

const config: RuntimeConfig = {
  tenantId: 'esmark-test',
  displayName: 'ESMARK Asistan',
  dbPath: './data/poc.sqlite',
  authDir: './data/auth/esmark-test',
  whitelistPhones: ['905322013401'],
  autoReply: true,
  autoReplyAudience: 'whitelist',
  operatorPort: 8787,
  operatorToken: '0123456789abcdef0123456789abcdef',
  operatorHost: '127.0.0.1',
  operatorNoAuth: false
};

describe('baileys inbound message mapping', () => {
  it('uses remoteJid as sender phone when participant is an empty string', () => {
    const inbound = toInboundMessage(config, {
      key: {
        fromMe: false,
        id: 'msg-1',
        remoteJid: '905322013401@s.whatsapp.net',
        participant: ''
      },
      pushName: 'Ersin',
      message: { conversation: 'Merhaba' },
      messageTimestamp: 1778603315
    } as any);

    expect(inbound?.chatId).toBe('905322013401@s.whatsapp.net');
    expect(inbound?.senderPhone).toBe('905322013401');
    expect(inbound?.text).toBe('Merhaba');
  });
});
