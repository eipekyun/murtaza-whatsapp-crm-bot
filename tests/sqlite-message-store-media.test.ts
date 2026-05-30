import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteMessageStore, type MessageStore } from '../src/store/sqlite-message-store.js';
import type { InboundMessage } from '../src/types.js';

let dir: string;
let store: MessageStore;

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    tenantId: 'esmark-test',
    channel: 'whatsapp',
    provider: 'baileys',
    direction: 'inbound',
    messageId: 'media-1',
    chatId: '905551112233@s.whatsapp.net',
    senderPhone: '905551112233',
    senderDisplayName: 'Test',
    text: '[Görsel]',
    mediaKind: 'image',
    mediaMime: 'image/jpeg',
    receivedAt: new Date('2026-05-30T08:00:00.000Z'),
    ...overrides
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'murtaza-media-'));
  store = createSqliteMessageStore(join(dir, 'media.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sqlite media archive columns', () => {
  it('markMediaPending sets local path + pending status (getMediaForServe reflects it)', async () => {
    await store.saveInbound(inbound());
    await store.markMediaPending('esmark-test', 'media-1', '/tmp/incoming/media-1.jpg');

    const info = await store.getMediaForServe('esmark-test', 'media-1');
    expect(info?.mediaUploadStatus).toBe('pending');
    expect(info?.mediaLocalPath).toBe('/tmp/incoming/media-1.jpg');
    expect(info?.mediaKind).toBe('image');
    expect(info?.direction).toBe('inbound');
  });

  it('markMediaDone sets done status, drive url and clears local path', async () => {
    await store.saveInbound(inbound());
    await store.markMediaPending('esmark-test', 'media-1', '/tmp/incoming/media-1.jpg');
    await store.markMediaDone('esmark-test', 'media-1', 'drive-abc', 'https://drive.example/file');

    const info = await store.getMediaForServe('esmark-test', 'media-1');
    expect(info?.mediaUploadStatus).toBe('done');
    expect(info?.mediaDriveId).toBe('drive-abc');
    expect(info?.mediaDriveUrl).toBe('https://drive.example/file');
    expect(info?.mediaLocalPath).toBeUndefined();
  });

  it('listPendingMediaByChat returns pending media but not done ones', async () => {
    await store.saveInbound(inbound({ messageId: 'pending-1', mediaName: 'a.jpg' }));
    await store.markMediaPending('esmark-test', 'pending-1', '/tmp/incoming/pending-1.jpg');
    await store.saveInbound(inbound({ messageId: 'done-1' }));
    await store.markMediaPending('esmark-test', 'done-1', '/tmp/incoming/done-1.jpg');
    await store.markMediaDone('esmark-test', 'done-1', 'drive-x', 'https://drive.example/x');

    const pending = await store.listPendingMediaByChat('esmark-test', '905551112233@s.whatsapp.net');
    expect(pending).toHaveLength(1);
    expect(pending[0].messageId).toBe('pending-1');
    expect(pending[0].localPath).toBe('/tmp/incoming/pending-1.jpg');
    expect(pending[0].mediaKind).toBe('image');
  });

  it('resetStaleUploading flips uploading→pending and leaves done untouched', async () => {
    await store.saveInbound(inbound({ messageId: 'up-1' }));
    await store.markMediaPending('esmark-test', 'up-1', '/tmp/up-1.jpg');
    await store.setMediaUploadStatus('esmark-test', 'up-1', 'uploading');
    await store.saveInbound(inbound({ messageId: 'done-2' }));
    await store.markMediaPending('esmark-test', 'done-2', '/tmp/done-2.jpg');
    await store.markMediaDone('esmark-test', 'done-2', 'd', 'u');

    await store.resetStaleUploading('esmark-test');

    expect((await store.getMediaForServe('esmark-test', 'up-1'))?.mediaUploadStatus).toBe('pending');
    expect((await store.getMediaForServe('esmark-test', 'done-2'))?.mediaUploadStatus).toBe('done');
  });

  it('listAllPendingMedia returns pending+error across all chats, excludes done', async () => {
    await store.saveInbound(inbound({ messageId: 'p-1', chatId: 'a@s.whatsapp.net' }));
    await store.markMediaPending('esmark-test', 'p-1', '/tmp/p-1.jpg');
    await store.saveInbound(inbound({ messageId: 'e-1', chatId: 'b@s.whatsapp.net' }));
    await store.markMediaPending('esmark-test', 'e-1', '/tmp/e-1.jpg');
    await store.setMediaUploadStatus('esmark-test', 'e-1', 'error');
    await store.saveInbound(inbound({ messageId: 'd-1', chatId: 'c@s.whatsapp.net' }));
    await store.markMediaPending('esmark-test', 'd-1', '/tmp/d-1.jpg');
    await store.markMediaDone('esmark-test', 'd-1', 'd', 'u');

    const ids = (await store.listAllPendingMedia('esmark-test')).map((m) => m.messageId).sort();
    expect(ids).toEqual(['e-1', 'p-1']);
  });

  it('markMediaPending does NOT reset an already-done record (duplicate-upsert guard)', async () => {
    await store.saveInbound(inbound({ messageId: 'g-1' }));
    await store.markMediaPending('esmark-test', 'g-1', '/tmp/g-1.jpg');
    await store.markMediaDone('esmark-test', 'g-1', 'd', 'u');
    await store.markMediaPending('esmark-test', 'g-1', '/tmp/g-1-again.jpg');

    const info = await store.getMediaForServe('esmark-test', 'g-1');
    expect(info?.mediaUploadStatus).toBe('done');
    expect(info?.mediaLocalPath).toBeUndefined();
  });

  it('setConversationSettings writes + reads customerSlug with normalization', async () => {
    const saved = await store.setConversationSettings('esmark-test', '905551112233@s.whatsapp.net', {
      customerSlug: '  Lavanda-Lavander!! '
    });
    expect(saved.customerSlug).toBe('lavanda-lavander');

    const read = await store.getConversationSettings('esmark-test', '905551112233@s.whatsapp.net');
    expect(read.customerSlug).toBe('lavanda-lavander');
  });
});
