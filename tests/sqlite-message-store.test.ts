import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteMessageStore } from '../src/store/sqlite-message-store.js';
import type { InboundMessage } from '../src/types.js';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    tenantId: 'esmark-test',
    channel: 'whatsapp',
    provider: 'baileys',
    direction: 'inbound',
    messageId: 'msg-1',
    chatId: '905551112233@s.whatsapp.net',
    senderPhone: '905551112233',
    senderDisplayName: 'Test Kisi',
    text: 'Merhaba',
    receivedAt: new Date('2026-05-12T11:00:00.000Z'),
    ...overrides
  };
}

describe('sqlite message store', () => {
  it('persists inbound messages and can list them by tenant', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'murtaza-wa-'));
    const store = createSqliteMessageStore(join(tmp, 'messages.sqlite'));

    await store.saveInbound(message());
    await store.saveInbound(message({ tenantId: 'other', messageId: 'msg-2' }));

    const messages = await store.listMessages('esmark-test');

    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe('msg-1');
    expect(messages[0].text).toBe('Merhaba');
    expect(messages[0].receivedAt.toISOString()).toBe('2026-05-12T11:00:00.000Z');

    store.close();
  });
});
