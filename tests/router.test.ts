import { describe, expect, it } from 'vitest';
import { createRouter } from '../src/router.js';
import type { InboundMessage } from '../src/types.js';

const baseMessage: InboundMessage = {
  tenantId: 'esmark-test',
  channel: 'whatsapp',
  provider: 'baileys',
  direction: 'inbound',
  messageId: 'msg-1',
  chatId: '905551112233@s.whatsapp.net',
  senderPhone: '905551112233',
  senderDisplayName: 'Test Kisi',
  text: 'Merhaba web sitesi yaptırmak istiyorum',
  receivedAt: new Date('2026-05-12T11:00:00.000Z')
};

describe('message router safety policy', () => {
  it('replies to whitelisted inbound messages with safe lead intake text', async () => {
    const saved: InboundMessage[] = [];
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: ['905551112233'],
      autoReply: true,
      saveInbound: async (message) => { saved.push(message); }
    });

    const result = await router.handleInbound(baseMessage);

    expect(saved).toHaveLength(1);
    expect(result.shouldReply).toBe(true);
    expect(result.replyText).toContain('ESMARK Asistanı');
    expect(result.replyText).toContain('talebinizi');
    expect(result.reason).toBe('whitelisted_auto_reply');
  });

  it('logs but does not reply to non-whitelisted inbound messages', async () => {
    const saved: InboundMessage[] = [];
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: ['905559998877'],
      autoReply: true,
      saveInbound: async (message) => { saved.push(message); }
    });

    const result = await router.handleInbound(baseMessage);

    expect(saved).toHaveLength(1);
    expect(result.shouldReply).toBe(false);
    expect(result.replyText).toBeUndefined();
    expect(result.reason).toBe('sender_not_whitelisted');
  });

  it('normalizes Turkish phone formats before whitelist comparison', async () => {
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: ['+90 555 111 22 33'],
      autoReply: true,
      saveInbound: async () => {}
    });

    const result = await router.handleInbound({
      ...baseMessage,
      senderPhone: '0 (555) 111 22 33'
    });

    expect(result.shouldReply).toBe(true);
  });
});
