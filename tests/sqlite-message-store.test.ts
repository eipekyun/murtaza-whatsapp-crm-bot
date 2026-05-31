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

  it('group chat (@g.us) does NOT pull in individual chats that share a sender name', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'murtaza-wa-'));
    const store = createSqliteMessageStore(join(tmp, 'messages.sqlite'));

    // Ersin'in bireysel sohbeti
    await store.saveInbound(message({ messageId: 'i-1', chatId: '905322013401@s.whatsapp.net', senderPhone: '905322013401', senderDisplayName: 'Ersin', text: 'bireysel' }));
    // Aynı isimle (Ersin) grup mesajı + grupta başka kişi
    await store.saveInbound(message({ messageId: 'g-1', chatId: '120363407358572607@g.us', senderPhone: '905322013401', senderDisplayName: 'Ersin', text: 'grup-ersin' }));
    await store.saveInbound(message({ messageId: 'g-2', chatId: '120363407358572607@g.us', senderPhone: '905312153333', senderDisplayName: 'Irem', text: 'grup-irem' }));

    const groupMsgs = await store.listMessagesByChat('esmark-test', '120363407358572607@g.us');
    // Grup yalnızca kendi 2 mesajını içermeli; Ersin'in bireysel sohbeti SIZMAMALI.
    expect(groupMsgs.map((m) => m.messageId).sort()).toEqual(['g-1', 'g-2']);

    store.close();
  });

  it('listConversations keeps a group separate from an individual chat that shares a sender name', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'murtaza-wa-'));
    const store = createSqliteMessageStore(join(tmp, 'messages.sqlite'));

    await store.saveInbound(message({ messageId: 'i-1', chatId: '905322013401@s.whatsapp.net', senderPhone: '905322013401', senderDisplayName: 'Ersin', text: 'bireysel', receivedAt: new Date('2026-05-12T10:00:00.000Z') }));
    await store.saveInbound(message({ messageId: 'g-1', chatId: '120363407358572607@g.us', senderPhone: '905322013401', senderDisplayName: 'Ersin', text: 'grup', receivedAt: new Date('2026-05-12T11:00:00.000Z') }));

    const ids = (await store.listConversations('esmark-test')).map((c) => c.chatId).sort();
    // İkisi de listede olmalı; grup, aynı isimli bireysel sohbeti gizlememeli.
    expect(ids).toContain('905322013401@s.whatsapp.net');
    expect(ids).toContain('120363407358572607@g.us');

    store.close();
  });

  it('getGroupMembersFromMessages returns distinct senders with their display names', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'murtaza-wa-'));
    const store = createSqliteMessageStore(join(tmp, 'messages.sqlite'));

    await store.saveInbound(message({ messageId: 'g1', chatId: '120363407358572607@g.us', senderPhone: '905322013401', senderDisplayName: 'Ersin' }));
    await store.saveInbound(message({ messageId: 'g2', chatId: '120363407358572607@g.us', senderPhone: '905312153333', senderDisplayName: 'Irem' }));
    await store.saveInbound(message({ messageId: 'g3', chatId: '120363407358572607@g.us', senderPhone: '905322013401', senderDisplayName: 'Ersin' }));

    const members = await store.getGroupMembersFromMessages('esmark-test', '120363407358572607@g.us');
    expect(members.map((m) => m.phone).sort()).toEqual(['905312153333', '905322013401']);
    expect(members.find((m) => m.phone === '905322013401')?.name).toBe('Ersin');

    store.close();
  });

  it('individual chat merges same-name LID/PN chats but excludes groups', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'murtaza-wa-'));
    const store = createSqliteMessageStore(join(tmp, 'messages.sqlite'));

    await store.saveInbound(message({ messageId: 'pn-1', chatId: '905322013401@s.whatsapp.net', senderPhone: '905322013401', senderDisplayName: 'Ersin', text: 'pn' }));
    await store.saveInbound(message({ messageId: 'lid-1', chatId: '29132796747799@lid', senderPhone: '29132796747799', senderDisplayName: 'Ersin', text: 'lid' }));
    await store.saveInbound(message({ messageId: 'grp-1', chatId: '120363407358572607@g.us', senderPhone: '905322013401', senderDisplayName: 'Ersin', text: 'grup' }));

    const ids = (await store.listMessagesByChat('esmark-test', '905322013401@s.whatsapp.net')).map((m) => m.messageId).sort();
    // LID birleşir (pn-1 + lid-1), grup mesajı (grp-1) sızmaz.
    expect(ids).toEqual(['lid-1', 'pn-1']);

    store.close();
  });

  it('listConversations excludes WhatsApp status broadcasts', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'murtaza-wa-'));
    const store = createSqliteMessageStore(join(tmp, 'messages.sqlite'));

    await store.saveInbound(message({ messageId: 'real-1', chatId: '905551112233@s.whatsapp.net', senderPhone: '905551112233', senderDisplayName: 'Müşteri' }));
    // Geçmişte kaydedilmiş bir status yayını (yeni gelenler zaten baileys handler'ında drop edilir).
    await store.saveInbound(message({ messageId: 'status-1', chatId: 'status@broadcast', senderPhone: '905999998877', senderDisplayName: 'Birisi' }));

    const ids = (await store.listConversations('esmark-test')).map((c) => c.chatId);
    expect(ids).toContain('905551112233@s.whatsapp.net');
    expect(ids).not.toContain('status@broadcast');

    store.close();
  });
});
