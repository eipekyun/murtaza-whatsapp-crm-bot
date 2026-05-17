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
      now: () => new Date("2026-05-13T11:00:00+03:00"),
      saveInbound: async (message) => { saved.push(message); }
    });

    const result = await router.handleInbound(baseMessage);

    expect(saved).toHaveLength(1);
    expect(result.shouldReply).toBe(true);
    expect(result.replyText).toContain('ESMARK müşteri asistanı');
    expect(result.replyText).toContain('uygun kişi');
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

  it('trusts a LID sender when a previous same-name phone identity is whitelisted', async () => {
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: ['905551112233'],
      autoReply: true,
      isTrustedSender: async (message) => message.senderDisplayName === 'Test Kisi',
      saveInbound: async () => {}
    });

    const result = await router.handleInbound({
      ...baseMessage,
      chatId: '29132796747799@lid',
      senderPhone: '29132796747799'
    });

    expect(result.shouldReply).toBe(true);
    expect(result.reason).toBe('trusted_alias_auto_reply');
  });

  it('suppresses auto reply after a recent manual operator reply', async () => {
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: ['905551112233'],
      autoReply: true,
      getConversationContext: async () => ({ lastManualReplyAt: new Date() }),
      saveInbound: async () => {}
    });

    const result = await router.handleInbound(baseMessage);

    expect(result.shouldReply).toBe(false);
    expect(result.reason).toBe('recent_manual_reply');
  });

  it('suppresses auto reply when bot is disabled for the conversation', async () => {
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: ['905551112233'],
      autoReply: true,
      getConversationContext: async () => ({ botEnabled: false }),
      saveInbound: async () => {}
    });

    const result = await router.handleInbound(baseMessage);

    expect(result.shouldReply).toBe(false);
    expect(result.reason).toBe('conversation_bot_disabled');
  });

  it('chooses a service-intent reply during business hours', async () => {
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: ['905551112233'],
      autoReply: true,
      now: () => new Date('2026-05-13T11:00:00+03:00'),
      saveInbound: async () => {}
    });

    const result = await router.handleInbound({ ...baseMessage, text: 'Google reklam ve web sitesi fiyatı almak istiyorum' });

    expect(result.shouldReply).toBe(true);
    expect(result.reason).toBe('whitelisted_auto_reply');
    expect(result.replyText).toContain('web sitesi / reklam');
    expect(result.intent).toBe('service_interest');
    expect(result.replyDelayMs).toBeGreaterThanOrEqual(2500);
  });

  it('uses out-of-hours wording when the customer writes outside business hours', async () => {
    const router = createRouter({
      tenantId: 'esmark-test',
      whitelistPhones: ['905551112233'],
      autoReply: true,
      now: () => new Date('2026-05-13T22:00:00+03:00'),
      saveInbound: async () => {}
    });

    const result = await router.handleInbound(baseMessage);

    expect(result.shouldReply).toBe(true);
    expect(result.intent).toBe('out_of_hours');
    expect(result.replyText).toContain('mesai saatinde');
  });
});
