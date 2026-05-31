import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteMessageStore, type MessageStore } from '../src/store/sqlite-message-store.js';
import type { ChatCrmMapping } from '../src/types.js';

let dir: string;
let store: MessageStore;

function mapping(overrides: Partial<ChatCrmMapping> = {}): ChatCrmMapping {
  return {
    tenantId: 'esmark-test',
    chatId: '120363000000000000@g.us',
    customerSlug: 'lavanda',
    perfexClientId: 12,
    perfexProjectId: 34,
    projectName: 'Lavanda Sosyal Medya',
    repoPath: '/repos/lavanda',
    updatedAt: '2026-05-30T08:00:00.000Z',
    ...overrides
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'murtaza-crm-'));
  store = createSqliteMessageStore(join(dir, 'crm.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('chat_crm_mapping', () => {
  it('setGroupCrmMapping inserts then getGroupCrmMapping reflects it', () => {
    store.setGroupCrmMapping(mapping());

    const read = store.getGroupCrmMapping('esmark-test', '120363000000000000@g.us');
    expect(read).toBeDefined();
    expect(read?.customerSlug).toBe('lavanda');
    expect(read?.perfexClientId).toBe(12);
    expect(read?.perfexProjectId).toBe(34);
    expect(read?.projectName).toBe('Lavanda Sosyal Medya');
    expect(read?.repoPath).toBe('/repos/lavanda');
    expect(read?.updatedAt).toBe('2026-05-30T08:00:00.000Z');
  });

  it('getGroupCrmMapping returns undefined for unknown chat', () => {
    expect(store.getGroupCrmMapping('esmark-test', 'missing@g.us')).toBeUndefined();
  });

  it('setGroupCrmMapping upserts on conflict (tenant_id, chat_id)', () => {
    store.setGroupCrmMapping(mapping());
    store.setGroupCrmMapping(mapping({
      perfexProjectId: 99,
      projectName: 'Lavanda Reklam',
      updatedAt: '2026-05-31T09:00:00.000Z'
    }));

    const all = store.listGroupCrmMappings('esmark-test');
    expect(all).toHaveLength(1);
    expect(all[0].perfexProjectId).toBe(99);
    expect(all[0].projectName).toBe('Lavanda Reklam');
    expect(all[0].updatedAt).toBe('2026-05-31T09:00:00.000Z');
  });

  it('setGroupCrmMapping normalizes customerSlug', () => {
    store.setGroupCrmMapping(mapping({ customerSlug: '  Lavanda-Lavander!! ' }));

    const read = store.getGroupCrmMapping('esmark-test', '120363000000000000@g.us');
    expect(read?.customerSlug).toBe('lavanda-lavander');
  });

  it('optional fields round-trip as undefined when absent', () => {
    store.setGroupCrmMapping({
      tenantId: 'esmark-test',
      chatId: 'minimal@g.us',
      updatedAt: '2026-05-30T08:00:00.000Z'
    });

    const read = store.getGroupCrmMapping('esmark-test', 'minimal@g.us');
    expect(read?.customerSlug).toBeUndefined();
    expect(read?.perfexClientId).toBeUndefined();
    expect(read?.perfexProjectId).toBeUndefined();
    expect(read?.projectName).toBeUndefined();
    expect(read?.repoPath).toBeUndefined();
  });

  it('listGroupCrmMappings is scoped per tenant', () => {
    store.setGroupCrmMapping(mapping({ chatId: 'a@g.us' }));
    store.setGroupCrmMapping(mapping({ chatId: 'b@g.us' }));
    store.setGroupCrmMapping(mapping({ tenantId: 'other-tenant', chatId: 'c@g.us' }));

    const esmark = store.listGroupCrmMappings('esmark-test');
    expect(esmark.map((m) => m.chatId).sort()).toEqual(['a@g.us', 'b@g.us']);

    const other = store.listGroupCrmMappings('other-tenant');
    expect(other).toHaveLength(1);
    expect(other[0].chatId).toBe('c@g.us');
  });

  it('deleteGroupCrmMapping removes only the targeted chat', () => {
    store.setGroupCrmMapping(mapping({ chatId: 'x@g.us' }));
    store.setGroupCrmMapping(mapping({ chatId: 'y@g.us' }));

    store.deleteGroupCrmMapping('esmark-test', 'x@g.us');

    expect(store.getGroupCrmMapping('esmark-test', 'x@g.us')).toBeUndefined();
    expect(store.listGroupCrmMappings('esmark-test').map((m) => m.chatId)).toEqual(['y@g.us']);
  });
});

describe('conversation_settings perfexProjectId', () => {
  it('setConversationSettings writes + reads perfexProjectId', async () => {
    const saved = await store.setConversationSettings('esmark-test', '905551112233@s.whatsapp.net', {
      perfexProjectId: 77
    });
    expect(saved.perfexProjectId).toBe(77);

    const read = await store.getConversationSettings('esmark-test', '905551112233@s.whatsapp.net');
    expect(read.perfexProjectId).toBe(77);
  });

  it('perfexProjectId is undefined for settings written without it', async () => {
    await store.setConversationSettings('esmark-test', '905551112233@s.whatsapp.net', {
      customerSlug: 'lavanda'
    });

    const read = await store.getConversationSettings('esmark-test', '905551112233@s.whatsapp.net');
    expect(read.customerSlug).toBe('lavanda');
    expect(read.perfexProjectId).toBeUndefined();
  });

  it('patch preserves existing perfexProjectId when not in patch', async () => {
    await store.setConversationSettings('esmark-test', '905551112233@s.whatsapp.net', {
      perfexProjectId: 42
    });
    const after = await store.setConversationSettings('esmark-test', '905551112233@s.whatsapp.net', {
      customerSlug: 'lavanda'
    });
    expect(after.perfexProjectId).toBe(42);
  });

  it('perfexProjectId 0 clears the value (panel temizleme sinyali → undefined)', async () => {
    await store.setConversationSettings('esmark-test', '905551112233@s.whatsapp.net', {
      perfexProjectId: 50
    });
    const cleared = await store.setConversationSettings('esmark-test', '905551112233@s.whatsapp.net', {
      perfexProjectId: 0
    });
    expect(cleared.perfexProjectId).toBeUndefined();

    const read = await store.getConversationSettings('esmark-test', '905551112233@s.whatsapp.net');
    expect(read.perfexProjectId).toBeUndefined();
  });
});
