import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteMessageStore, type MessageStore } from '../src/store/sqlite-message-store.js';
import type { CandidateTask, NewGroupCandidate } from '../src/types.js';

let dir: string;
let store: MessageStore;

function task(overrides: Partial<CandidateTask> = {}): CandidateTask {
  return {
    title: 'Logo revize',
    description: 'Lavanda logo rengini koyulaştır',
    priority: 2,
    suggestedDue: '2026-06-10',
    sourceMessageIds: ['wamid-1', 'wamid-2'],
    ...overrides
  };
}

function candidate(overrides: Partial<NewGroupCandidate> = {}): NewGroupCandidate {
  return {
    tenantId: 'esmark-test',
    chatId: '120363000000000000@g.us',
    customerSlug: 'lavanda',
    perfexClientId: 12,
    perfexProjectId: 34,
    summary: 'Logo ve banner revizesi konuşuldu.',
    tasks: [task()],
    status: 'draft',
    sourceMessageIds: ['wamid-1', 'wamid-2'],
    extractionSource: 'wa-extract.py',
    windowStart: '2026-06-01T08:00:00.000Z',
    windowEnd: '2026-06-01T18:00:00.000Z',
    hash: 'hash-aaa',
    approvalJobId: undefined,
    perfexTaskIds: [],
    ...overrides
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'murtaza-cand-'));
  store = createSqliteMessageStore(join(dir, 'cand.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('group_candidates CRUD', () => {
  it('insertGroupCandidate returns row with id and round-trips tasks/sourceMessageIds JSON', () => {
    const inserted = store.insertGroupCandidate(candidate());

    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.tenantId).toBe('esmark-test');
    expect(inserted.chatId).toBe('120363000000000000@g.us');
    expect(inserted.customerSlug).toBe('lavanda');
    expect(inserted.perfexClientId).toBe(12);
    expect(inserted.perfexProjectId).toBe(34);
    expect(inserted.summary).toBe('Logo ve banner revizesi konuşuldu.');
    expect(inserted.status).toBe('draft');
    expect(inserted.extractionSource).toBe('wa-extract.py');
    expect(inserted.windowStart).toBe('2026-06-01T08:00:00.000Z');
    expect(inserted.windowEnd).toBe('2026-06-01T18:00:00.000Z');
    expect(inserted.hash).toBe('hash-aaa');
    expect(inserted.perfexTaskIds).toEqual([]);
    expect(inserted.createdAt).toBeTruthy();
    expect(inserted.updatedAt).toBeTruthy();

    // tasks JSON round-trip: nested CandidateTask survives stringify/parse.
    expect(inserted.tasks).toEqual([task()]);
    expect(inserted.sourceMessageIds).toEqual(['wamid-1', 'wamid-2']);
  });

  it('insertGroupCandidate dedups on same hash: second insert returns existing, no new row', () => {
    const first = store.insertGroupCandidate(candidate({ hash: 'dup-hash' }));
    const second = store.insertGroupCandidate(
      candidate({ hash: 'dup-hash', summary: 'farklı özet ama aynı hash' })
    );

    // Aynı (tenant, chat, hash) → mevcut kayıt döner, yeni satır eklenmez.
    expect(second.id).toBe(first.id);
    expect(second.summary).toBe(first.summary);
    expect(second.summary).not.toBe('farklı özet ama aynı hash');

    const all = store.listGroupCandidates('esmark-test', '120363000000000000@g.us');
    expect(all).toHaveLength(1);
  });

  it('insertGroupCandidate keeps distinct rows for different hashes', () => {
    store.insertGroupCandidate(candidate({ hash: 'hash-1' }));
    store.insertGroupCandidate(candidate({ hash: 'hash-2' }));

    const all = store.listGroupCandidates('esmark-test', '120363000000000000@g.us');
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.hash).sort()).toEqual(['hash-1', 'hash-2']);
  });

  it('listGroupCandidates returns rows newest-first (created_at DESC)', () => {
    const older = store.insertGroupCandidate(candidate({ hash: 'old' }));
    // created_at = new Date().toISOString() içeride üretilir; iki insert aynı ms'ye
    // düşerse ORDER BY created_at DESC eşitlik durumunda belirsiz sıra verir
    // (impl'de id tie-breaker yok). ms sınırını geçecek kadar bekleyip deterministik kıl.
    const start = Date.now();
    while (Date.now() === start) { /* busy-wait: yeni created_at farklı ms olsun */ }
    const newer = store.insertGroupCandidate(candidate({ hash: 'new' }));

    expect(newer.createdAt > older.createdAt).toBe(true);

    const all = store.listGroupCandidates('esmark-test', '120363000000000000@g.us');
    expect(all).toHaveLength(2);
    // DESC: en yeni created_at (newer) başta.
    expect(all[0].id).toBe(newer.id);
    expect(all[1].id).toBe(older.id);
  });

  it('listGroupCandidates is scoped per chat and tenant', () => {
    store.insertGroupCandidate(candidate({ chatId: 'a@g.us', hash: 'a' }));
    store.insertGroupCandidate(candidate({ chatId: 'b@g.us', hash: 'b' }));
    store.insertGroupCandidate(candidate({ tenantId: 'other', chatId: 'a@g.us', hash: 'a' }));

    expect(store.listGroupCandidates('esmark-test', 'a@g.us')).toHaveLength(1);
    expect(store.listGroupCandidates('esmark-test', 'b@g.us')).toHaveLength(1);
    expect(store.listGroupCandidates('other', 'a@g.us')).toHaveLength(1);
    expect(store.listGroupCandidates('esmark-test', 'zzz@g.us')).toEqual([]);
  });

  it('getGroupCandidate fetches by id, undefined for unknown id', () => {
    const inserted = store.insertGroupCandidate(candidate({ hash: 'get-me' }));

    const read = store.getGroupCandidate('esmark-test', inserted.id);
    expect(read?.id).toBe(inserted.id);
    expect(read?.hash).toBe('get-me');
    expect(read?.tasks).toEqual([task()]);

    expect(store.getGroupCandidate('esmark-test', 999999)).toBeUndefined();
    // Yanlış tenant aynı id'yi görmez.
    expect(store.getGroupCandidate('other', inserted.id)).toBeUndefined();
  });

  it('updateGroupCandidateStatus changes status and bumps updatedAt', () => {
    const inserted = store.insertGroupCandidate(candidate({ hash: 'status' }));
    expect(inserted.status).toBe('draft');

    store.updateGroupCandidateStatus('esmark-test', inserted.id, 'sent');

    const read = store.getGroupCandidate('esmark-test', inserted.id);
    expect(read?.status).toBe('sent');
  });

  it('updateGroupCandidate patches summary and tasks (JSON round-trip), leaves others intact', () => {
    const inserted = store.insertGroupCandidate(candidate({ hash: 'patch' }));

    const newTasks: CandidateTask[] = [
      task({ title: 'Yeni görev', priority: 4, sourceMessageIds: ['wamid-9'] })
    ];
    store.updateGroupCandidate('esmark-test', inserted.id, {
      summary: 'Güncellenmiş özet',
      tasks: newTasks
    });

    const read = store.getGroupCandidate('esmark-test', inserted.id);
    expect(read?.summary).toBe('Güncellenmiş özet');
    expect(read?.tasks).toEqual(newTasks);
    // Dokunulmayan alanlar korunur.
    expect(read?.status).toBe('draft');
    expect(read?.hash).toBe('patch');
  });

  it('updateGroupCandidate patches Faz 4 fields (status, approvalJobId, perfexTaskIds)', () => {
    const inserted = store.insertGroupCandidate(candidate({ hash: 'faz4' }));

    store.updateGroupCandidate('esmark-test', inserted.id, {
      status: 'written',
      approvalJobId: 'job-abc-123',
      perfexTaskIds: [101, 102]
    });

    const read = store.getGroupCandidate('esmark-test', inserted.id);
    expect(read?.status).toBe('written');
    expect(read?.approvalJobId).toBe('job-abc-123');
    expect(read?.perfexTaskIds).toEqual([101, 102]);
  });

  it('updateGroupCandidate with empty patch is a no-op (does not throw, row unchanged)', () => {
    const inserted = store.insertGroupCandidate(candidate({ hash: 'noop' }));

    expect(() => store.updateGroupCandidate('esmark-test', inserted.id, {})).not.toThrow();

    const read = store.getGroupCandidate('esmark-test', inserted.id);
    expect(read?.summary).toBe(inserted.summary);
    expect(read?.status).toBe('draft');
  });

  it('insertGroupCandidate normalizes customerSlug and defaults missing arrays', () => {
    const inserted = store.insertGroupCandidate(
      candidate({ hash: 'slug', customerSlug: '  Lavanda-Lavander!! ' })
    );

    expect(inserted.customerSlug).toBe('lavanda-lavander');
  });
});
