import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createSqliteMessageStore } from '../src/store/sqlite-message-store.js';

describe('sqlite message store outbound/operator views', () => {
  it('saves outbound operator messages with origin/media metadata and lists conversations with latest text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'murtaza-store-'));
    try {
      const store = createSqliteMessageStore(join(dir, 'test.sqlite'));

      await store.saveOutbound({
        tenantId: 'esmark-test',
        channel: 'whatsapp',
        provider: 'baileys',
        direction: 'outbound',
        origin: 'manual',
        messageId: 'manual-1',
        chatId: '905322013401@s.whatsapp.net',
        recipientPhone: '905322013401',
        text: 'Operatör cevabı',
        mediaKind: 'image',
        mediaName: 'teklif.png',
        sentAt: new Date('2026-05-12T17:00:00.000Z')
      });

      const conversations = await store.listConversations('esmark-test');
      expect(conversations).toEqual([
        {
          chatId: '905322013401@s.whatsapp.net',
          displayName: '905322013401',
          pushName: undefined,
          phone: '905322013401',
          latestText: 'Operatör cevabı',
          latestAt: new Date('2026-05-12T17:00:00.000Z'),
          unreadCount: 0,
          settings: { botEnabled: true, tags: [], readReceipt: 'on_reply' }
        }
      ]);

      const messages = await store.listMessagesByChat('esmark-test', '905322013401@s.whatsapp.net');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        direction: 'outbound',
        origin: 'manual',
        text: 'Operatör cevabı',
        mediaKind: 'image',
        mediaName: 'teklif.png'
      });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges phone JID and LID rows for the same named contact in operator conversation list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'murtaza-store-'));
    try {
      const store = createSqliteMessageStore(join(dir, 'test.sqlite'));

      await store.saveInbound({
        tenantId: 'esmark-test',
        channel: 'whatsapp',
        provider: 'baileys',
        direction: 'inbound',
        messageId: 'in-phone-1',
        chatId: '905322013401@s.whatsapp.net',
        senderPhone: '905322013401',
        senderDisplayName: 'Ersin',
        text: 'Merhaba',
        receivedAt: new Date('2026-05-12T16:28:35.000Z')
      });
      await store.saveOutbound({
        tenantId: 'esmark-test',
        channel: 'whatsapp',
        provider: 'baileys',
        direction: 'outbound',
        origin: 'bot',
        messageId: 'bot-phone-1',
        chatId: '905322013401@s.whatsapp.net',
        recipientPhone: '905322013401',
        text: 'Eski bot cevabı',
        sentAt: new Date('2026-05-12T19:45:36.820Z')
      });
      await store.saveInbound({
        tenantId: 'esmark-test',
        channel: 'whatsapp',
        provider: 'baileys',
        direction: 'inbound',
        messageId: 'in-lid-1',
        chatId: '29132796747799@lid',
        senderPhone: '29132796747799',
        senderDisplayName: 'Ersin',
        text: 'Slm',
        receivedAt: new Date('2026-05-13T10:35:38.000Z')
      });

      const conversations = await store.listConversations('esmark-test');
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({
        chatId: '29132796747799@lid',
        displayName: '~Ersin',
        latestText: 'Slm',
        unreadCount: 2
      });

      const messages = await store.listMessagesByChat('esmark-test', '29132796747799@lid');
      expect(messages.map((message) => message.text)).toEqual(['Merhaba', 'Eski bot cevabı', 'Slm']);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
