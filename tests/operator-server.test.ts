import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createOperatorHttpServer } from '../src/http/operator-server.js';
import type { MessageStore } from '../src/store/sqlite-message-store.js';
import type { ChatCrmMapping, OutboundMessage } from '../src/types.js';

const TEST_TOKEN = '0123456789abcdef0123456789abcdef';
function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', 'Bearer ' + TEST_TOKEN);
  return fetch(input, { ...init, headers });
}

function url(server: { address(): any }, path: string): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not listening');
  return `http://127.0.0.1:${address.port}${path}`;
}

interface FakeStoreOptions {
  conversations?: Awaited<ReturnType<MessageStore['listConversations']>>;
}

function fakeStore(saved: OutboundMessage[] = [], opts: FakeStoreOptions = {}): MessageStore {
  const state = new Map<string, string>();
  const crmMappings = new Map<string, ChatCrmMapping>();
  const settings = new Map<string, { botEnabled: boolean; tags: string[]; note?: string; readReceipt: 'on_reply' | 'on_open' | 'never'; customerSlug?: string; perfexProjectId?: number }>();
  return {
    saveInbound: async () => {},
    saveOutbound: async (message: OutboundMessage) => { saved.push(message); },
    saveContactName: async () => {},
    updateMessageStatus: async () => {},
    updateMessageText: async () => {},
    markChatRead: async () => {},
    getUnreadInboundKeys: async () => [],
    listMessages: async () => [],
    listConversations: async () => opts.conversations ?? [],
    listMessagesByChat: async () => [],
    getConversationReplyContext: async () => ({}),
    getConversationSettings: async (_tenantId: string, chatId: string) => settings.get(chatId) ?? { botEnabled: true, tags: [], readReceipt: 'on_reply' },
    setConversationSettings: async (_tenantId: string, chatId: string, patch) => {
      const base = settings.get(chatId) ?? { botEnabled: true, tags: [] as string[], readReceipt: 'on_reply' as const };
      // Gerçek store: yalnız tanımlı alan yazılır, undefined alan mevcut değeri korur.
      const next = {
        botEnabled: typeof patch.botEnabled === 'boolean' ? patch.botEnabled : base.botEnabled,
        tags: patch.tags ?? base.tags,
        note: patch.note ?? base.note,
        readReceipt: patch.readReceipt ?? base.readReceipt,
        customerSlug: patch.customerSlug ?? base.customerSlug,
        // perfexProjectId: yalnız finite number ise yaz, değilse mevcut değeri koru.
        perfexProjectId: typeof patch.perfexProjectId === 'number' && Number.isFinite(patch.perfexProjectId)
          ? patch.perfexProjectId
          : base.perfexProjectId
      };
      settings.set(chatId, next);
      return next;
    },
    hasWhitelistedAlias: async () => false,
    markMediaPending: async () => {},
    setMediaUploadStatus: async () => {},
    markMediaDone: async () => {},
    getMediaForServe: async () => undefined,
    listPendingMediaByChat: async () => [],
    listAllPendingMedia: async () => [],
    getGroupMembersFromMessages: async () => [],
    getGroupSubject: async () => undefined,
    resetStaleUploading: async () => {},
    getAppState: async (key: string) => state.get(key),
    setAppState: async (key: string, value: string) => { state.set(key, value); },
    getGroupCrmMapping: (_tenantId: string, chatId: string) => crmMappings.get(chatId),
    setGroupCrmMapping: (mapping: ChatCrmMapping) => { crmMappings.set(mapping.chatId, mapping); },
    listGroupCrmMappings: () => [...crmMappings.values()],
    deleteGroupCrmMapping: (_tenantId: string, chatId: string) => { crmMappings.delete(chatId); },
    close: () => {}
  };
}

describe('operator HTTP API', () => {
  it('sends manual WhatsApp image messages and persists outbound metadata', async () => {
    const sent: Array<{ chatId: string; text: string; image?: Buffer; imageName?: string }> = [];
    const saved: OutboundMessage[] = [];
    const store = fakeStore(saved);

    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async (payload) => {
        sent.push(payload);
        return 'wa-manual-1';
      }
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const response = await authedFetch(url(server, '/api/send'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId: '905322013401@s.whatsapp.net',
          text: 'Görsel ektedir',
          imageData: 'data:image/png;base64,aGVsbG8=',
          imageName: 'urun.png'
        })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(sent[0]?.chatId).toBe('905322013401@s.whatsapp.net');
      expect(sent[0]?.text).toBe('Görsel ektedir');
      expect(sent[0]?.image?.toString('utf8')).toBe('hello');
      expect(sent[0]?.imageName).toBe('urun.png');
      expect(saved[0]).toMatchObject({
        direction: 'outbound',
        origin: 'manual',
        mediaKind: 'image',
        mediaName: 'urun.png',
        mediaMime: 'image/png',
        mediaData: 'data:image/png;base64,aGVsbG8='
      });
    } finally {
      server.close();
    }
  });

  it('sends documents and arms history-sync listener without pretending import completed', async () => {
    const sent: Array<{ chatId: string; text: string; document?: Buffer; documentName?: string; documentMime?: string }> = [];
    const saved: OutboundMessage[] = [];
    const store = fakeStore(saved);
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async (payload) => {
        sent.push(payload);
        return 'wa-doc-1';
      }
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const response = await authedFetch(url(server, '/api/send'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId: '905322013401@s.whatsapp.net',
          documentData: 'data:application/pdf;base64,JVBERg==',
          documentName: 'teklif.pdf'
        })
      });
      expect(response.status).toBe(200);
      expect(sent[0]?.document?.toString('utf8')).toBe('%PDF');
      expect(sent[0]?.documentName).toBe('teklif.pdf');
      expect(sent[0]?.documentMime).toBe('application/pdf');
      expect(saved[0]).toMatchObject({ mediaKind: 'document', mediaName: 'teklif.pdf', mediaMime: 'application/pdf' });

      const firstImport = await authedFetch(url(server, '/api/history-import/start'), { method: 'POST' });
      expect(firstImport.status).toBe(200);
      const firstBody = await firstImport.json();
      expect(firstBody).toMatchObject({ status: 'listening', progress: 0, imported: 0 });
      const secondImport = await authedFetch(url(server, '/api/history-import/start'), { method: 'POST' });
      expect(secondImport.status).toBe(200);
      const secondBody = await secondImport.json();
      expect(secondBody.status).toBe('listening');
    } finally {
      server.close();
    }
  });

  it('exposes conversation summaries with settings for the detail panel', async () => {
    const store = fakeStore([], {
      conversations: [
        {
          chatId: '29132796747799@lid',
          displayName: 'Ersin',
          phone: '905322013401',
          latestText: 'Slm',
          latestAt: new Date('2026-05-13T10:35:38.000Z'),
          unreadCount: 2,
          settings: { botEnabled: false, tags: ['sıcak lead'], note: 'LID/JID birleşmiş', readReceipt: 'on_reply' }
        }
      ]
    });
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'unused'
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const response = await authedFetch(url(server, '/api/conversations'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.conversations).toHaveLength(1);
      const conv = body.conversations[0];
      expect(conv).toMatchObject({
        chatId: '29132796747799@lid',
        displayName: 'Ersin',
        phone: '905322013401',
        latestText: 'Slm',
        unreadCount: 2
      });
      expect(conv.settings).toMatchObject({ botEnabled: false, tags: ['sıcak lead'], note: 'LID/JID birleşmiş' });
      expect(typeof conv.latestAt).toBe('string');
    } finally {
      server.close();
    }
  });

  it('returns default settings for an unseen chat so the detail panel can render', async () => {
    const store = fakeStore();
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'unused'
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const response = await authedFetch(url(server, '/api/conversation-settings?chatId=' + encodeURIComponent('905001112233@s.whatsapp.net')));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.settings).toMatchObject({ botEnabled: true, tags: [] });
    } finally {
      server.close();
    }
  });

  it('updates per-conversation bot controls, tags and notes', async () => {
    const store = fakeStore();
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'unused'
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const patchResponse = await authedFetch(url(server, '/api/conversation-settings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId: '29132796747799@lid',
          botEnabled: false,
          tags: ['sıcak lead', 'web'],
          note: 'Aynı kişi: 905322013401'
        })
      });
      expect(patchResponse.status).toBe(200);
      const patched = await patchResponse.json();
      expect(patched.settings).toMatchObject({ botEnabled: false, tags: ['sıcak lead', 'web'], note: 'Aynı kişi: 905322013401' });

      const getResponse = await authedFetch(url(server, '/api/conversation-settings?chatId=29132796747799%40lid'));
      expect(getResponse.status).toBe(200);
      const body = await getResponse.json();
      expect(body.settings.botEnabled).toBe(false);
    } finally {
      server.close();
    }
  });

  it('rejects /api/* without Bearer token', async () => {
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store: fakeStore(),
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'wa-x'
    });
    server.listen(0);
    await once(server, 'listening');
    try {
      const noAuth = await fetch(url(server, '/api/conversations'));
      expect(noAuth.status).toBe(401);

      const wrongAuth = await fetch(url(server, '/api/conversations'), {
        headers: { Authorization: 'Bearer wrong-token-wrong-token' }
      });
      expect(wrongAuth.status).toBe(401);

      const ok = await authedFetch(url(server, '/api/conversations'));
      expect(ok.status).toBe(200);

      const htmlOk = await fetch(url(server, '/'));
      expect(htmlOk.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('lists Perfex projects for a customer slug via /api/projects', async () => {
    const store = fakeStore();
    const calls: string[] = [];
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'unused',
      listProjects: (slug: string) => {
        calls.push(slug);
        return slug === 'ersin-ic-operasyon'
          ? [{ id: 39, name: 'Ops A' }, { id: 40, name: 'Ops B' }]
          : [];
      }
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const response = await authedFetch(url(server, '/api/projects?customerSlug=ersin-ic-operasyon'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(calls).toEqual(['ersin-ic-operasyon']);
      expect(body.projects).toEqual([{ id: 39, name: 'Ops A' }, { id: 40, name: 'Ops B' }]);

      const empty = await authedFetch(url(server, '/api/projects'));
      expect(empty.status).toBe(200);
      const emptyBody = await empty.json();
      expect(emptyBody.projects).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('round-trips perfexProjectId through conversation settings', async () => {
    const store = fakeStore();
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'unused'
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const setResponse = await authedFetch(url(server, '/api/conversation-settings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '120363000000000000@g.us', customerSlug: 'ersin-ic-operasyon', perfexProjectId: 40 })
      });
      expect(setResponse.status).toBe(200);
      const setBody = await setResponse.json();
      expect(setBody.settings).toMatchObject({ customerSlug: 'ersin-ic-operasyon', perfexProjectId: 40 });

      const getResponse = await authedFetch(url(server, '/api/conversation-settings?chatId=' + encodeURIComponent('120363000000000000@g.us')));
      const getBody = await getResponse.json();
      expect(getBody.settings.perfexProjectId).toBe(40);
    } finally {
      server.close();
    }
  });

  it('fires onConversationCrmChanged when slug or project changes, not on no-op', async () => {
    const store = fakeStore();
    const changed: string[] = [];
    const assigned: Array<{ chatId: string; slug: string }> = [];
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'unused',
      onCustomerAssigned: (chatId: string, slug: string) => { assigned.push({ chatId, slug }); },
      onConversationCrmChanged: (chatId: string) => { changed.push(chatId); }
    });

    server.listen(0);
    await once(server, 'listening');
    const chatId = '120363111111111111@g.us';
    const post = (payload: Record<string, unknown>): Promise<Response> =>
      authedFetch(url(server, '/api/conversation-settings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, ...payload })
      });
    try {
      // 1) slug atanır → hem onCustomerAssigned hem onConversationCrmChanged
      await post({ customerSlug: 'voyelle-tour' });
      // 2) proje atanır → yalnız onConversationCrmChanged
      await post({ perfexProjectId: 36 });
      // 3) sadece not güncellenir (CRM değişmez) → CRM callback tetiklenmez
      await post({ note: 'sıcak lead' });

      expect(assigned).toEqual([{ chatId, slug: 'voyelle-tour' }]);
      expect(changed).toEqual([chatId, chatId]);
    } finally {
      server.close();
    }
  });

  it('serves Perfex tasks for a chat via /api/perfex-tasks', async () => {
    const store = fakeStore();
    const calls: string[] = [];
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'unused',
      getPerfexTasks: async (chatId: string) => {
        calls.push(chatId);
        return {
          tasks: [
            { id: 91, name: 'Reklam metni revize', priority: 3, status: 2, statusLabel: 'Devam Ediyor' },
            { id: 92, name: 'Logo onayı', priority: 1, status: 1, statusLabel: 'Başlamadı', dueDate: '2026-06-10' }
          ],
          projects: [{ id: 40, name: 'Voyelle Sosyal', status: 2 }],
          error: null
        };
      }
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const chatId = '120363000000000000@g.us';
      const response = await authedFetch(url(server, '/api/perfex-tasks?chatId=' + encodeURIComponent(chatId)));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(calls).toEqual([chatId]);
      expect(body.error).toBeNull();
      expect(body.tasks).toHaveLength(2);
      expect(body.tasks[0]).toMatchObject({ id: 91, name: 'Reklam metni revize', statusLabel: 'Devam Ediyor', priority: 3 });
      expect(body.projects).toEqual([{ id: 40, name: 'Voyelle Sosyal', status: 2 }]);

      const missing = await authedFetch(url(server, '/api/perfex-tasks'));
      expect(missing.status).toBe(400);
      const missingBody = await missing.json();
      expect(missingBody.error).toBe('chatId_required');
    } finally {
      server.close();
    }
  });

  it('returns a disabled envelope when getPerfexTasks is not wired', async () => {
    const store = fakeStore();
    const server = createOperatorHttpServer({
      tenantId: 'esmark-test',
      store,
      whitelistPhones: [],
      authToken: TEST_TOKEN,
      sendWhatsAppMessage: async () => 'unused'
    });

    server.listen(0);
    await once(server, 'listening');
    try {
      const response = await authedFetch(url(server, '/api/perfex-tasks?chatId=' + encodeURIComponent('905322013401@s.whatsapp.net')));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ tasks: [], projects: [], error: 'perfex devre dışı' });
    } finally {
      server.close();
    }
  });

  it('throws if authToken missing or too short', () => {
    expect(() => createOperatorHttpServer({
      tenantId: 'x', store: fakeStore(), whitelistPhones: [], authToken: 'short',
      sendWhatsAppMessage: async () => 'x'
    })).toThrow();
  });
});
