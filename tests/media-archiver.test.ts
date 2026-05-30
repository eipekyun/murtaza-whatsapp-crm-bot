import { describe, expect, it, vi } from 'vitest';
import { createMediaArchiver, senderFromChatId, type DriveResult, type DrivePythonRunner } from '../src/media/media-archiver.js';
import type { MessageStore, MediaServeInfo, PendingMedia } from '../src/store/sqlite-message-store.js';
import type { ConversationSettings, MediaUploadStatus } from '../src/types.js';

// Minimal in-memory MessageStore: sadece media + conversation-settings yollarını gerçekçi tutar.
function fakeStore(): MessageStore & {
  __status: Map<string, MediaUploadStatus>;
  __done: Map<string, { driveId: string; driveUrl: string }>;
  __local: Map<string, string>;
  __settings: Map<string, ConversationSettings>;
  __pending: Map<string, PendingMedia[]>;
} {
  const status = new Map<string, MediaUploadStatus>();
  const done = new Map<string, { driveId: string; driveUrl: string }>();
  const local = new Map<string, string>();
  const settings = new Map<string, ConversationSettings>();
  const pending = new Map<string, PendingMedia[]>();
  const base: Partial<MessageStore> = {
    saveInbound: async () => {},
    saveOutbound: async () => {},
    saveContactName: async () => {},
    updateMessageStatus: async () => {},
    markChatRead: async () => {},
    getUnreadInboundKeys: async () => [],
    listMessages: async () => [],
    listMessagesByChat: async () => [],
    listConversations: async () => [],
    getConversationReplyContext: async () => ({}),
    getConversationSettings: async (_t: string, chatId: string) => settings.get(chatId) ?? { botEnabled: true, tags: [], readReceipt: 'on_reply' },
    setConversationSettings: async (_t: string, chatId: string, patch) => {
      const base2 = settings.get(chatId) ?? { botEnabled: true, tags: [] as string[], readReceipt: 'on_reply' as const };
      const next = { ...base2, ...patch } as ConversationSettings;
      settings.set(chatId, next);
      return next;
    },
    hasWhitelistedAlias: async () => false,
    markMediaPending: async (_t: string, messageId: string, localPath: string) => { local.set(messageId, localPath); status.set(messageId, 'pending'); },
    setMediaUploadStatus: async (_t: string, messageId: string, s: MediaUploadStatus) => { status.set(messageId, s); },
    markMediaDone: async (_t: string, messageId: string, driveId: string, driveUrl: string) => { status.set(messageId, 'done'); done.set(messageId, { driveId, driveUrl }); local.delete(messageId); },
    getMediaForServe: async (): Promise<MediaServeInfo | undefined> => undefined,
    listPendingMediaByChat: async (_t: string, chatId: string) => pending.get(chatId) ?? [],
    listAllPendingMedia: async () => [...pending.values()].flat(),
    resetStaleUploading: async () => {},
    getAppState: async () => undefined,
    setAppState: async () => {},
    close: () => {}
  };
  const store = base as MessageStore;
  return Object.assign(store, { __status: status, __done: done, __local: local, __settings: settings, __pending: pending });
}

function mockRunner(
  uploadImpl: (slug: string, kind: string, file: string) => DriveResult,
  uploadInboxImpl?: (sender: string, kind: string, file: string) => DriveResult
): DrivePythonRunner {
  return {
    upload: vi.fn(async (slug, kind, file) => uploadImpl(slug, kind, file)),
    uploadInbox: vi.fn(async (sender, kind, file) =>
      (uploadInboxImpl ?? (() => ({ status: 'uploaded', drive_id: 'inbox-d', link: 'https://drive/inbox' })))(sender, kind, file)),
    download: vi.fn(async () => ({ status: 'ok', path: '/tmp/x' })),
    resolve: vi.fn(async () => ({ status: 'ok', root_id: 'r' }))
  };
}

describe('media archiver', () => {
  it('uploads to the user inbox fallback (by sender) when no customer slug is assigned', async () => {
    const store = fakeStore();
    const runner = mockRunner(() => ({ status: 'uploaded', drive_id: 'd1' }));
    const archiver = createMediaArchiver({ store, tenantId: 'esmark-test', runner });

    await archiver.onIncomingMedia({ chatId: '905322013401@s.whatsapp.net', messageId: 'm1', mediaKind: 'image', localPath: '/tmp/m1.jpg', mediaName: 'foto.jpg' });

    expect(runner.upload).not.toHaveBeenCalled();
    expect(runner.uploadInbox).toHaveBeenCalledWith('905322013401', 'image', '/tmp/m1.jpg', 'foto.jpg');
    expect(store.__status.get('m1')).toBe('done');
    expect(store.__done.get('m1')).toEqual({ driveId: 'inbox-d', driveUrl: 'https://drive/inbox' });
  });

  it('marks status error when the inbox fallback upload fails', async () => {
    const store = fakeStore();
    const runner = mockRunner(() => ({ status: 'uploaded', drive_id: 'x' }), () => ({ status: 'error', error: 'drive_api: quota' }));
    const archiver = createMediaArchiver({ store, tenantId: 'esmark-test', runner });

    await archiver.onIncomingMedia({ chatId: '905322013401@s.whatsapp.net', messageId: 'm9', mediaKind: 'image', localPath: '/tmp/m9.jpg' });

    expect(store.__status.get('m9')).toBe('error');
    expect(store.__done.has('m9')).toBe(false);
  });

  it('uploads immediately and marks done when a customer slug is already set', async () => {
    const store = fakeStore();
    store.__settings.set('c1', { botEnabled: true, tags: [], readReceipt: 'on_reply', customerSlug: 'lavanda' });
    const runner = mockRunner(() => ({ status: 'uploaded', drive_id: 'drive-1', link: 'https://drive/x' }));
    const archiver = createMediaArchiver({ store, tenantId: 'esmark-test', runner });

    await archiver.onIncomingMedia({ chatId: 'c1', messageId: 'm1', mediaKind: 'image', localPath: '/tmp/m1.jpg', mediaName: 'm1.jpg' });

    expect(runner.upload).toHaveBeenCalledWith('lavanda', 'image', '/tmp/m1.jpg', 'm1.jpg');
    expect(store.__status.get('m1')).toBe('done');
    expect(store.__done.get('m1')).toEqual({ driveId: 'drive-1', driveUrl: 'https://drive/x' });
  });

  it('marks error when upload returns skip WITHOUT drive_id (defensive branch)', async () => {
    const store = fakeStore();
    store.__settings.set('c1', { botEnabled: true, tags: [], readReceipt: 'on_reply', customerSlug: 'lavanda' });
    const runner = mockRunner(() => ({ status: 'skip' }));
    const archiver = createMediaArchiver({ store, tenantId: 'esmark-test', runner });

    await archiver.onIncomingMedia({ chatId: 'c1', messageId: 'm1', mediaKind: 'image', localPath: '/tmp/m1.jpg' });

    expect(store.__status.get('m1')).toBe('error');
    expect(store.__done.has('m1')).toBe(false);
  });

  it('queue isolation: first item error does NOT block the second upload', async () => {
    const store = fakeStore();
    store.__pending.set('c1', [
      { messageId: 'm1', chatId: 'c1', mediaKind: 'image', localPath: '/tmp/m1.jpg' },
      { messageId: 'm2', chatId: 'c1', mediaKind: 'document', localPath: '/tmp/m2.pdf' }
    ]);
    const runner = mockRunner((_slug, _kind, file) =>
      file === '/tmp/m1.jpg' ? { status: 'error', error: 'boom' } : { status: 'uploaded', drive_id: 'd2', link: 'https://drive/' });
    const archiver = createMediaArchiver({ store, tenantId: 'esmark-test', runner });

    await archiver.onCustomerAssigned('c1', 'lavanda');

    expect(store.__status.get('m1')).toBe('error');
    expect(store.__status.get('m2')).toBe('done');
  });

  it('requeuePending re-dispatches by assignment: firma → upload, atanmamış → uploadInbox', async () => {
    const store = fakeStore();
    store.__settings.set('c-firma', { botEnabled: true, tags: [], readReceipt: 'on_reply', customerSlug: 'lavanda' });
    store.__pending.set('c-firma', [{ messageId: 'mf', chatId: 'c-firma', mediaKind: 'image', localPath: '/tmp/mf.jpg' }]);
    store.__pending.set('905551112233@s.whatsapp.net', [{ messageId: 'mi', chatId: '905551112233@s.whatsapp.net', mediaKind: 'document', localPath: '/tmp/mi.pdf' }]);
    const runner = mockRunner(() => ({ status: 'uploaded', drive_id: 'df', link: 'l' }), () => ({ status: 'uploaded', drive_id: 'di', link: 'l' }));
    const archiver = createMediaArchiver({ store, tenantId: 'esmark-test', runner });

    await archiver.requeuePending();

    expect(runner.upload).toHaveBeenCalledWith('lavanda', 'image', '/tmp/mf.jpg', undefined);
    expect(runner.uploadInbox).toHaveBeenCalledWith('905551112233', 'document', '/tmp/mi.pdf', undefined);
    expect(store.__status.get('mf')).toBe('done');
    expect(store.__status.get('mi')).toBe('done');
  });

  it('onCustomerAssigned uploads all pending media for the chat', async () => {
    const store = fakeStore();
    store.__pending.set('c1', [
      { messageId: 'm1', chatId: 'c1', mediaKind: 'image', localPath: '/tmp/m1.jpg' },
      { messageId: 'm2', chatId: 'c1', mediaKind: 'document', mediaName: 'teklif.pdf', localPath: '/tmp/m2.pdf' }
    ]);
    const runner = mockRunner((_slug, _kind, file) => ({ status: 'uploaded', drive_id: file === '/tmp/m1.jpg' ? 'd1' : 'd2', link: 'https://drive/' }));
    const archiver = createMediaArchiver({ store, tenantId: 'esmark-test', runner });

    await archiver.onCustomerAssigned('c1', 'lavanda-lavander');

    expect(runner.upload).toHaveBeenCalledTimes(2);
    expect(store.__status.get('m1')).toBe('done');
    expect(store.__status.get('m2')).toBe('done');
  });

  it('marks status error when the runner returns an error result', async () => {
    const store = fakeStore();
    store.__settings.set('c1', { botEnabled: true, tags: [], readReceipt: 'on_reply', customerSlug: 'lavanda' });
    const runner = mockRunner(() => ({ status: 'error', error: 'drive_api: quota' }));
    const archiver = createMediaArchiver({ store, tenantId: 'esmark-test', runner });

    await archiver.onIncomingMedia({ chatId: 'c1', messageId: 'm1', mediaKind: 'image', localPath: '/tmp/m1.jpg' });

    expect(store.__status.get('m1')).toBe('error');
    expect(store.__done.has('m1')).toBe(false);
  });
});

describe('senderFromChatId', () => {
  it('extracts the phone number from a standard JID', () => {
    expect(senderFromChatId('905322013401@s.whatsapp.net')).toBe('905322013401');
  });

  it('strips the device suffix', () => {
    expect(senderFromChatId('905322013401:12@s.whatsapp.net')).toBe('905322013401');
  });

  it('extracts digits from a LID JID', () => {
    expect(senderFromChatId('191749301485604:5@lid')).toBe('191749301485604');
  });

  it('prefixes group JIDs with "grup-" so they never collide with individual chats', () => {
    expect(senderFromChatId('120363012345678901@g.us')).toBe('grup-120363012345678901');
  });

  it('sanitizes the local part for a pure-alpha LID (no digits)', () => {
    expect(senderFromChatId('abcXYZ@lid')).toBe('abcXYZ');
  });

  it('falls back to a safe label when there are no usable chars', () => {
    expect(senderFromChatId('@s.whatsapp.net')).toBe('bilinmeyen');
    expect(senderFromChatId('')).toBe('bilinmeyen');
    expect(senderFromChatId('!#$%@lid')).toBe('bilinmeyen');
  });
});
