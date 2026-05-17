import { describe, expect, it } from 'vitest';
import { createRouter } from '../src/router.js';
import type { InboundMessage } from '../src/types.js';

const baseMessage: InboundMessage = {
  tenantId: 'esmark-test',
  channel: 'whatsapp',
  provider: 'baileys',
  direction: 'inbound',
  messageId: 'msg-dynamic',
  chatId: '905322013401@s.whatsapp.net',
  senderPhone: '905322013401',
  senderDisplayName: 'Ersin',
  text: 'Merhaba',
  receivedAt: new Date('2026-05-12T17:05:00.000Z')
};

describe('router runtime whitelist updates', () => {
  it('uses the current whitelist array for each inbound message', async () => {
    const whitelistPhones = ['15613764604'];
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones,
      autoReply: true,
      saveInbound: async () => {}
    });

    const before = await router.handleInbound(baseMessage);
    expect(before.reason).toBe('sender_not_whitelisted');

    whitelistPhones.push('905322013401');
    const after = await router.handleInbound({ ...baseMessage, messageId: 'msg-dynamic-2' });
    expect(after.shouldReply).toBe(true);
    expect(after.reason).toBe('whitelisted_auto_reply');
  });

  it('can reply to everyone when audience is all', async () => {
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: [],
      autoReply: true,
      getAutoReplyAudience: () => 'all',
      saveInbound: async () => {}
    });

    const decision = await router.handleInbound(baseMessage);
    expect(decision.shouldReply).toBe(true);
    expect(decision.reason).toBe('all_auto_reply');
  });
});
