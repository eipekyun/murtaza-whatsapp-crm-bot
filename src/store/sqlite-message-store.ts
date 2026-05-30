import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ConversationSettings, ConversationSummary, InboundMessage, MediaUploadStatus, OutboundMessage, ReadReceiptMode, StoredMessage } from '../types.js';
import { normalizePhone, normalizeWhitelist } from '../phone.js';

interface MessageRow {
  tenant_id: string;
  channel: StoredMessage['channel'];
  provider: StoredMessage['provider'];
  direction: StoredMessage['direction'];
  origin: string | null;
  message_id: string;
  chat_id: string;
  sender_phone: string;
  sender_display_name: string | null;
  text: string;
  media_kind: string | null;
  media_name: string | null;
  media_mime: string | null;
  media_data: string | null;
  media_local_path: string | null;
  media_drive_id: string | null;
  media_drive_url: string | null;
  media_upload_status: string | null;
  received_at: string;
  status: number | null;
}

export interface MediaServeInfo {
  direction: StoredMessage['direction'];
  mediaKind?: StoredMessage['mediaKind'];
  mediaName?: string;
  mediaMime?: string;
  mediaData?: string;
  mediaLocalPath?: string;
  mediaDriveId?: string;
  mediaDriveUrl?: string;
  mediaUploadStatus?: MediaUploadStatus;
}

export interface PendingMedia {
  messageId: string;
  chatId: string;
  mediaKind?: StoredMessage['mediaKind'];
  mediaName?: string;
  mediaMime?: string;
  localPath: string;
}

interface ConversationRow {
  chat_id: string;
  display_name: string | null;
  push_name: string | null;
  phone: string;
  latest_text: string;
  latest_at: string;
  unread_count: number;
}

export interface MessageStore {
  saveInbound(message: InboundMessage): Promise<void>;
  saveOutbound(message: OutboundMessage): Promise<void>;
  saveContactName(tenantId: string, jid: string, name: string, source?: string): Promise<void>;
  updateMessageStatus(tenantId: string, messageId: string, status: number): Promise<void>;
  markChatRead(tenantId: string, chatId: string): Promise<void>;
  getUnreadInboundKeys(tenantId: string, chatId: string): Promise<Array<{ chatId: string; messageId: string; senderPhone: string }>>;
  listMessages(tenantId: string): Promise<InboundMessage[]>;
  listMessagesByChat(tenantId: string, chatId: string): Promise<StoredMessage[]>;
  listConversations(tenantId: string): Promise<ConversationSummary[]>;
  getConversationReplyContext(tenantId: string, chatId: string): Promise<{ lastBotReplyAt?: Date; lastManualReplyAt?: Date; botEnabled?: boolean; readReceiptMode?: ReadReceiptMode }>;
  getConversationSettings(tenantId: string, chatId: string): Promise<ConversationSettings>;
  setConversationSettings(tenantId: string, chatId: string, patch: Partial<ConversationSettings>): Promise<ConversationSettings>;
  hasWhitelistedAlias(tenantId: string, displayName: string, whitelistPhones: string[]): Promise<boolean>;
  markMediaPending(tenantId: string, messageId: string, localPath: string): Promise<void>;
  setMediaUploadStatus(tenantId: string, messageId: string, status: MediaUploadStatus): Promise<void>;
  markMediaDone(tenantId: string, messageId: string, driveId: string, driveUrl: string): Promise<void>;
  getMediaForServe(tenantId: string, messageId: string): Promise<MediaServeInfo | undefined>;
  listPendingMediaByChat(tenantId: string, chatId: string): Promise<PendingMedia[]>;
  listAllPendingMedia(tenantId: string): Promise<PendingMedia[]>;
  // Grup detayı için: bir gruba mesaj atmış kişilerin telefon → görünen ad eşlemesi.
  getGroupMembersFromMessages(tenantId: string, chatId: string): Promise<Array<{ phone: string; name?: string }>>;
  // Grup başlığı (Drive klasör adı için): contact_names'te kayıtlı grup adı.
  getGroupSubject(tenantId: string, chatId: string): Promise<string | undefined>;
  resetStaleUploading(tenantId: string): Promise<void>;
  getAppState(key: string): Promise<string | undefined>;
  setAppState(key: string, value: string): Promise<void>;
  close(): void;
}

export function createSqliteMessageStore(dbPath: string): MessageStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      provider TEXT NOT NULL,
      direction TEXT NOT NULL,
      origin TEXT,
      message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_phone TEXT NOT NULL,
      sender_display_name TEXT,
      text TEXT NOT NULL,
      media_kind TEXT,
      media_name TEXT,
      media_mime TEXT,
      media_data TEXT,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, provider, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_tenant_received
      ON messages(tenant_id, received_at DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_tenant_chat_received
      ON messages(tenant_id, chat_id, received_at ASC);

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_names (
      tenant_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, jid)
    );
  `);
  ensureColumn(db, 'messages', 'origin', 'TEXT');
  ensureColumn(db, 'messages', 'media_kind', 'TEXT');
  ensureColumn(db, 'messages', 'media_name', 'TEXT');
  ensureColumn(db, 'messages', 'media_mime', 'TEXT');
  ensureColumn(db, 'messages', 'media_data', 'TEXT');
  ensureColumn(db, 'messages', 'media_local_path', 'TEXT');
  ensureColumn(db, 'messages', 'media_drive_id', 'TEXT');
  ensureColumn(db, 'messages', 'media_drive_url', 'TEXT');
  ensureColumn(db, 'messages', 'media_upload_status', 'TEXT');
  ensureColumn(db, 'messages', 'status', 'INTEGER');
  ensureColumn(db, 'contact_names', 'push_name', 'TEXT');

  const insert = db.prepare<[string, string, string, string, string | null, string, string, string, string | null, string, string | null, string | null, string | null, string | null, string, number | null]>(`
    INSERT OR IGNORE INTO messages (
      tenant_id, channel, provider, direction, origin, message_id, chat_id,
      sender_phone, sender_display_name, text, media_kind, media_name, media_mime, media_data, received_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectColumns = `
    SELECT tenant_id, channel, provider, direction, origin, message_id, chat_id,
           sender_phone, sender_display_name, text, media_kind, media_name, media_mime, media_data,
           media_local_path, media_drive_id, media_drive_url, media_upload_status, received_at, status
    FROM messages
  `;

  const upsertContactName = db.prepare<[string, string, string, string | null, string]>(`
    INSERT INTO contact_names (tenant_id, jid, name, source, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, jid) DO UPDATE SET
      name = excluded.name, source = excluded.source, updated_at = excluded.updated_at
  `);

  const upsertPushName = db.prepare<[string, string, string, string]>(`
    INSERT INTO contact_names (tenant_id, jid, name, push_name, updated_at)
    VALUES (?, ?, '', ?, ?)
    ON CONFLICT(tenant_id, jid) DO UPDATE SET
      push_name = excluded.push_name, updated_at = excluded.updated_at
  `);

  const updateStatusStmt = db.prepare<[number, string, string, number]>(`
    UPDATE messages SET status = ?
    WHERE tenant_id = ? AND message_id = ? AND (status IS NULL OR status < ?)
  `);

  const unreadKeysStmt = db.prepare<[string, string, string], { chat_id: string; message_id: string; sender_phone: string }>(`
    SELECT chat_id, message_id, sender_phone
    FROM messages
    WHERE tenant_id = ? AND chat_id = ? AND direction = 'inbound'
      AND received_at > COALESCE((SELECT value FROM app_state WHERE key = ?), '')
  `);

  const getState = db.prepare<[string], { value: string }>('SELECT value FROM app_state WHERE key = ?');
  const stateReader = getState as unknown as { get: (key: string) => { value: string } | undefined };
  const setState = db.prepare<[string, string, string]>(`
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const listInbound = db.prepare<[string], MessageRow>(`
    ${selectColumns}
    WHERE tenant_id = ? AND direction = 'inbound'
    ORDER BY received_at ASC
  `);

  // Bireysel sohbet: aynı kişi @lid ve telefon JID olarak iki chat_id'de görünebilir;
  // sender_display_name ile birleştirilir. ANCAK gruplar (@g.us) bu birleştirmeye DAHİL
  // EDİLMEZ — grupta "Ersin" yazması, Ersin'in bireysel sohbetini gruba çekmemeli.
  const listByChat = db.prepare<[string, string, string, string], MessageRow>(`
    WITH selected_names AS (
      SELECT DISTINCT sender_display_name AS display_name
      FROM messages
      WHERE tenant_id = ?
        AND chat_id = ?
        AND sender_display_name IS NOT NULL
        AND sender_display_name != ''
    ), alias_chats AS (
      SELECT ? AS chat_id
      UNION
      SELECT DISTINCT chat_id
      FROM messages
      WHERE sender_display_name IN (SELECT display_name FROM selected_names)
        AND chat_id NOT LIKE '%@g.us'
    )
    ${selectColumns}
    WHERE tenant_id = ?
      AND chat_id IN (SELECT chat_id FROM alias_chats)
    ORDER BY received_at ASC
  `);

  // Grup sohbeti: isim-birleştirme YOK, yalnızca o grubun mesajları (tam chat_id eşleşmesi).
  const listByChatExact = db.prepare<[string, string], MessageRow>(`
    ${selectColumns}
    WHERE tenant_id = ? AND chat_id = ?
    ORDER BY received_at ASC
  `);

  const conversations = db.prepare<[string, string, string], ConversationRow>(`
    WITH chat_names AS (
      SELECT chat_id, MIN(sender_display_name) AS display_name
      FROM messages
      WHERE tenant_id = ?
        AND sender_display_name IS NOT NULL
        AND sender_display_name != ''
      GROUP BY chat_id
    ), enriched AS (
      SELECT
        m.*,
        -- Gruplar (@g.us) HER ZAMAN kendi chat_id'leriyle ayrı kimlik alır; isim-bazlı
        -- birleştirmeye girmez. Aksi halde grupta geçen bir isim (örn. "Ersin"), aynı isimli
        -- kişinin bireysel sohbetiyle aynı identity_key'e düşüp onu listeden siliyordu.
        CASE
          WHEN m.chat_id LIKE '%@g.us' THEN 'chat:' || m.chat_id
          WHEN chat_names.display_name IS NOT NULL AND chat_names.display_name != ''
            THEN 'name:' || lower(chat_names.display_name)
          ELSE 'chat:' || m.chat_id
        END AS identity_key,
        chat_names.display_name AS identity_display_name
      FROM messages m
      LEFT JOIN chat_names ON chat_names.chat_id = m.chat_id
      WHERE m.tenant_id = ?
    ), latest_per_identity AS (
      SELECT identity_key, MAX(received_at) AS latest_at
      FROM enriched
      GROUP BY identity_key
    ), latest AS (
      SELECT e.*
      FROM enriched e
      JOIN latest_per_identity grouped
        ON grouped.identity_key = e.identity_key
       AND grouped.latest_at = e.received_at
    ), group_phones AS (
      SELECT identity_key, MAX(NULLIF(sender_phone, '')) AS phone
      FROM enriched
      WHERE sender_phone NOT LIKE '%@%'
      GROUP BY identity_key
    ), unread AS (
      SELECT identity_key, COUNT(*) AS unread_count
      FROM enriched
      WHERE direction = 'inbound'
        AND received_at > COALESCE((SELECT value FROM app_state a WHERE a.key = 'last_read:' || enriched.tenant_id || ':' || enriched.chat_id), '')
      GROUP BY identity_key
    )
    SELECT
      latest.chat_id,
      COALESCE(
        NULLIF(cn.name, ''),
        CASE WHEN COALESCE(NULLIF(cn.push_name, ''), NULLIF(latest.identity_display_name, ''), NULLIF(latest.sender_display_name, '')) != ''
             THEN '~' || COALESCE(NULLIF(cn.push_name, ''), NULLIF(latest.identity_display_name, ''), NULLIF(latest.sender_display_name, '')) END,
        NULLIF(group_phones.phone, ''), NULLIF(latest.sender_phone, ''), latest.chat_id
      ) AS display_name,
      COALESCE(NULLIF(cn.push_name, ''), NULLIF(latest.identity_display_name, ''), NULLIF(latest.sender_display_name, '')) AS push_name,
      COALESCE(NULLIF(group_phones.phone, ''), NULLIF(latest.sender_phone, ''), replace(latest.chat_id, '@s.whatsapp.net', '')) AS phone,
      latest.text AS latest_text,
      latest.received_at AS latest_at,
      COALESCE(unread.unread_count, 0) AS unread_count
    FROM latest
    LEFT JOIN group_phones ON group_phones.identity_key = latest.identity_key
    LEFT JOIN unread ON unread.identity_key = latest.identity_key
    LEFT JOIN contact_names cn ON cn.tenant_id = ? AND cn.jid = latest.chat_id
    ORDER BY latest.received_at DESC
  `);

  const replyContext = db.prepare<[string, string], { last_bot_reply_at: string | null; last_manual_reply_at: string | null }>(`
    SELECT
      MAX(CASE WHEN direction = 'outbound' AND origin = 'bot' THEN received_at END) AS last_bot_reply_at,
      MAX(CASE WHEN direction = 'outbound' AND origin IN ('manual', 'self') THEN received_at END) AS last_manual_reply_at
    FROM messages
    WHERE tenant_id = ? AND chat_id = ?
  `);

  const phonesByDisplayName = db.prepare<[string, string], { sender_phone: string }>(`
    SELECT DISTINCT sender_phone
    FROM messages
    WHERE tenant_id = ?
      AND lower(sender_display_name) = lower(?)
      AND sender_phone != ''
  `);

  // Yalnızca yeni (NULL) veya başarısız (error) medyayı 'pending'e al; halihazırda
  // uploading/done/pending olan kaydı sıfırlama (duplicate messages.upsert status gerilemesini önler).
  const markMediaPendingStmt = db.prepare<[string, string, string]>(`
    UPDATE messages SET media_local_path = ?, media_upload_status = 'pending'
    WHERE tenant_id = ? AND message_id = ?
      AND (media_upload_status IS NULL OR media_upload_status = 'error')
  `);

  const setMediaUploadStatusStmt = db.prepare<[string, string, string]>(`
    UPDATE messages SET media_upload_status = ?
    WHERE tenant_id = ? AND message_id = ?
  `);

  const markMediaDoneStmt = db.prepare<[string, string, string, string]>(`
    UPDATE messages SET media_drive_id = ?, media_drive_url = ?,
      media_upload_status = 'done', media_local_path = NULL
    WHERE tenant_id = ? AND message_id = ?
  `);

  const mediaForServeStmt = db.prepare<[string, string], MessageRow>(`
    ${selectColumns}
    WHERE tenant_id = ? AND message_id = ?
    LIMIT 1
  `);
  const mediaForServeReader = mediaForServeStmt as unknown as { get: (tenantId: string, messageId: string) => MessageRow | undefined };

  const pendingMediaStmt = db.prepare<[string, string], MessageRow>(`
    ${selectColumns}
    WHERE tenant_id = ? AND chat_id = ? AND direction = 'inbound'
      AND media_local_path IS NOT NULL AND media_local_path != ''
      AND (media_upload_status IS NULL OR media_upload_status IN ('pending', 'error'))
    ORDER BY received_at ASC
  `);

  // Restart recovery: tüm sohbetlerdeki bekleyen/başarısız medya (chat filtresiz).
  const allPendingMediaStmt = db.prepare<[string], MessageRow>(`
    ${selectColumns}
    WHERE tenant_id = ? AND direction = 'inbound'
      AND media_local_path IS NOT NULL AND media_local_path != ''
      AND (media_upload_status IS NULL OR media_upload_status IN ('pending', 'error'))
    ORDER BY received_at ASC
  `);

  // Grup başlığı: contact_names'te 'group' kaynağıyla kaydedilmiş grup adı.
  const groupSubjectStmt = db.prepare<[string, string], { name: string | null }>(`
    SELECT name FROM contact_names WHERE tenant_id = ? AND jid = ? LIMIT 1
  `);
  const groupSubjectReader = groupSubjectStmt as unknown as { get: (t: string, j: string) => { name: string | null } | undefined };

  // Grup detayı: gruba mesaj atmış kişiler (telefon + en sık görünen ad).
  const groupMembersStmt = db.prepare<[string, string], { phone: string; name: string | null }>(`
    SELECT sender_phone AS phone, MIN(sender_display_name) AS name
    FROM messages
    WHERE tenant_id = ? AND chat_id = ? AND direction = 'inbound'
      AND sender_phone IS NOT NULL AND sender_phone != '' AND sender_phone NOT LIKE '%@%'
    GROUP BY sender_phone
    ORDER BY name IS NULL, name ASC
  `);

  // Restart recovery: önceki oturumda yarıda kalmış 'uploading' kayıtları 'pending'e çevir.
  const resetStaleUploadingStmt = db.prepare<[string]>(`
    UPDATE messages SET media_upload_status = 'pending'
    WHERE tenant_id = ? AND media_upload_status = 'uploading'
  `);

  return {
    async saveInbound(message: InboundMessage): Promise<void> {
      insert.run(
        message.tenantId,
        message.channel,
        message.provider,
        message.direction,
        null,
        message.messageId,
        message.chatId,
        message.senderPhone,
        message.senderDisplayName ?? null,
        message.text,
        message.mediaKind ?? null,
        message.mediaName ?? null,
        message.mediaMime ?? null,
        message.mediaData ?? null,
        message.receivedAt.toISOString(),
        null
      );
    },

    async saveOutbound(message: OutboundMessage): Promise<void> {
      insert.run(
        message.tenantId,
        message.channel,
        message.provider,
        message.direction,
        message.origin,
        message.messageId,
        message.chatId,
        message.recipientPhone,
        null,
        message.text,
        message.mediaKind ?? null,
        message.mediaName ?? null,
        message.mediaMime ?? null,
        message.mediaData ?? null,
        message.sentAt.toISOString(),
        message.status ?? 2
      );
    },

    async updateMessageStatus(tenantId: string, messageId: string, status: number): Promise<void> {
      if (!messageId || !Number.isFinite(status)) return;
      updateStatusStmt.run(status, tenantId, messageId, status);
    },

    async markChatRead(tenantId: string, chatId: string): Promise<void> {
      if (!chatId) return;
      const now = new Date().toISOString();
      setState.run(lastReadKey(tenantId, chatId), now, now);
    },

    async getUnreadInboundKeys(tenantId: string, chatId: string): Promise<Array<{ chatId: string; messageId: string; senderPhone: string }>> {
      return unreadKeysStmt.all(tenantId, chatId, lastReadKey(tenantId, chatId))
        .map((r) => ({ chatId: r.chat_id, messageId: r.message_id, senderPhone: r.sender_phone }));
    },

    async listMessages(tenantId: string): Promise<InboundMessage[]> {
      return listInbound.all(tenantId).map(rowToInboundMessage);
    },

    async listMessagesByChat(tenantId: string, chatId: string): Promise<StoredMessage[]> {
      // Gruplar tam eşleşme (birleştirme yok); bireysel sohbetler LID/PN isim-birleştirmeli.
      if (chatId.endsWith('@g.us')) {
        return listByChatExact.all(tenantId, chatId).map(rowToStoredMessage);
      }
      return listByChat.all(tenantId, chatId, chatId, tenantId).map(rowToStoredMessage);
    },

    async saveContactName(tenantId: string, jid: string, name: string, source?: string): Promise<void> {
      const clean = (name ?? '').trim();
      if (!clean || !jid) return;
      const now = new Date().toISOString();
      if (source === 'push') {
        upsertPushName.run(tenantId, jid, clean.slice(0, 120), now);
      } else {
        upsertContactName.run(tenantId, jid, clean.slice(0, 120), source ?? null, now);
      }
    },

    async listConversations(tenantId: string): Promise<ConversationSummary[]> {
      return conversations.all(tenantId, tenantId, tenantId).map((row) => {
        const settings = readConversationSettings(stateReader, tenantId, row.chat_id);
        return {
          chatId: row.chat_id,
          displayName: row.display_name ?? row.phone,
          pushName: row.push_name ?? undefined,
          phone: row.phone,
          latestText: row.latest_text,
          latestAt: new Date(row.latest_at),
          unreadCount: row.unread_count,
          settings
        };
      });
    },

    async getConversationReplyContext(tenantId: string, chatId: string): Promise<{ lastBotReplyAt?: Date; lastManualReplyAt?: Date; botEnabled?: boolean; readReceiptMode?: ReadReceiptMode }> {
      const row = (replyContext as unknown as { get: (tenantId: string, chatId: string) => { last_bot_reply_at: string | null; last_manual_reply_at: string | null } | undefined }).get(tenantId, chatId);
      const settings = readConversationSettings(stateReader, tenantId, chatId);
      return {
        lastBotReplyAt: row?.last_bot_reply_at ? new Date(row.last_bot_reply_at) : undefined,
        lastManualReplyAt: row?.last_manual_reply_at ? new Date(row.last_manual_reply_at) : undefined,
        botEnabled: settings.botEnabled,
        readReceiptMode: settings.readReceipt
      };
    },

    async getConversationSettings(tenantId: string, chatId: string): Promise<ConversationSettings> {
      return readConversationSettings(stateReader, tenantId, chatId);
    },

    async setConversationSettings(tenantId: string, chatId: string, patch: Partial<ConversationSettings>): Promise<ConversationSettings> {
      const current = readConversationSettings(stateReader, tenantId, chatId);
      const next: ConversationSettings = {
        botEnabled: patch.botEnabled ?? current.botEnabled,
        tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 12) : current.tags,
        note: typeof patch.note === 'string' ? patch.note.trim().slice(0, 1000) : current.note,
        readReceipt: patch.readReceipt ?? current.readReceipt,
        customerSlug: typeof patch.customerSlug === 'string' ? normalizeSlug(patch.customerSlug) : current.customerSlug
      };
      setState.run(conversationSettingsKey(tenantId, chatId), JSON.stringify(next), new Date().toISOString());
      return next;
    },

    async hasWhitelistedAlias(tenantId: string, displayName: string, whitelistPhones: string[]): Promise<boolean> {
      const name = displayName.trim();
      if (!name) return false;
      const whitelist = normalizeWhitelist(whitelistPhones);
      return phonesByDisplayName.all(tenantId, name).some((row) => whitelist.has(normalizePhone(row.sender_phone)));
    },

    async markMediaPending(tenantId: string, messageId: string, localPath: string): Promise<void> {
      if (!messageId || !localPath) return;
      markMediaPendingStmt.run(localPath, tenantId, messageId);
    },

    async setMediaUploadStatus(tenantId: string, messageId: string, status: MediaUploadStatus): Promise<void> {
      if (!messageId) return;
      setMediaUploadStatusStmt.run(status, tenantId, messageId);
    },

    async markMediaDone(tenantId: string, messageId: string, driveId: string, driveUrl: string): Promise<void> {
      if (!messageId) return;
      markMediaDoneStmt.run(driveId, driveUrl, tenantId, messageId);
    },

    async getMediaForServe(tenantId: string, messageId: string): Promise<MediaServeInfo | undefined> {
      const row = mediaForServeReader.get(tenantId, messageId);
      if (!row) return undefined;
      return {
        direction: row.direction,
        mediaKind: normalizeMediaKind(row.media_kind),
        mediaName: row.media_name ?? undefined,
        mediaMime: row.media_mime ?? undefined,
        mediaData: row.media_data ?? undefined,
        mediaLocalPath: row.media_local_path ?? undefined,
        mediaDriveId: row.media_drive_id ?? undefined,
        mediaDriveUrl: row.media_drive_url ?? undefined,
        mediaUploadStatus: normalizeUploadStatus(row.media_upload_status)
      };
    },

    async listPendingMediaByChat(tenantId: string, chatId: string): Promise<PendingMedia[]> {
      return pendingMediaStmt.all(tenantId, chatId).map(toPendingMedia);
    },

    async listAllPendingMedia(tenantId: string): Promise<PendingMedia[]> {
      return allPendingMediaStmt.all(tenantId).map(toPendingMedia);
    },

    async getGroupMembersFromMessages(tenantId: string, chatId: string): Promise<Array<{ phone: string; name?: string }>> {
      return groupMembersStmt.all(tenantId, chatId).map((row) => ({
        phone: row.phone,
        name: row.name && row.name.trim() ? row.name.trim() : undefined
      }));
    },

    async getGroupSubject(tenantId: string, chatId: string): Promise<string | undefined> {
      const name = groupSubjectReader.get(tenantId, chatId)?.name;
      return name && name.trim() ? name.trim() : undefined;
    },

    async resetStaleUploading(tenantId: string): Promise<void> {
      resetStaleUploadingStmt.run(tenantId);
    },

    async getAppState(key: string): Promise<string | undefined> {
      return (getState as unknown as { get: (key: string) => { value: string } | undefined }).get(key)?.value;
    },

    async setAppState(key: string, value: string): Promise<void> {
      setState.run(key, value, new Date().toISOString());
    },

    close(): void {
      db.close();
    }
  };
}

function conversationSettingsKey(tenantId: string, chatId: string): string {
  return `conversation_settings:${tenantId}:${chatId}`;
}

function lastReadKey(tenantId: string, chatId: string): string {
  return `last_read:${tenantId}:${chatId}`;
}

function readConversationSettings(getState: { get: (key: string) => { value: string } | undefined }, tenantId: string, chatId: string): ConversationSettings {
  const fallback: ConversationSettings = { botEnabled: true, tags: [], readReceipt: 'on_reply' };
  const raw = getState.get(conversationSettingsKey(tenantId, chatId))?.value;
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationSettings>;
    const slug = typeof parsed.customerSlug === 'string' ? normalizeSlug(parsed.customerSlug) : undefined;
    return {
      botEnabled: parsed.botEnabled !== false,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : [],
      note: typeof parsed.note === 'string' && parsed.note ? parsed.note : undefined,
      readReceipt: parsed.readReceipt === 'on_open' || parsed.readReceipt === 'never' ? parsed.readReceipt : 'on_reply',
      customerSlug: slug || undefined
    };
  } catch {
    return fallback;
  }
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function normalizeUploadStatus(value: string | null): MediaUploadStatus | undefined {
  if (value === 'pending' || value === 'uploading' || value === 'done' || value === 'error' || value === 'skipped') return value;
  return undefined;
}

function toPendingMedia(row: MessageRow): PendingMedia {
  return {
    messageId: row.message_id,
    chatId: row.chat_id,
    mediaKind: normalizeMediaKind(row.media_kind),
    mediaName: row.media_name ?? undefined,
    mediaMime: row.media_mime ?? undefined,
    localPath: row.media_local_path ?? ''
  };
}

function ensureColumn(db: { prepare: (sql: string) => { all: () => unknown[] }; exec: (sql: string) => void }, table: string, column: string, type: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function rowToStoredMessage(row: MessageRow): StoredMessage {
  if (row.direction === 'outbound') {
    return {
      tenantId: row.tenant_id,
      channel: row.channel,
      provider: row.provider,
      direction: 'outbound',
      origin: row.origin === 'bot' ? 'bot' : row.origin === 'self' ? 'self' : 'manual',
      messageId: row.message_id,
      chatId: row.chat_id,
      recipientPhone: row.sender_phone,
      text: row.text,
      mediaKind: normalizeMediaKind(row.media_kind),
      mediaName: row.media_name ?? undefined,
      mediaMime: row.media_mime ?? undefined,
      mediaData: row.media_data ?? undefined,
      mediaLocalPath: row.media_local_path ?? undefined,
      mediaDriveId: row.media_drive_id ?? undefined,
      mediaDriveUrl: row.media_drive_url ?? undefined,
      mediaUploadStatus: normalizeUploadStatus(row.media_upload_status),
      status: row.status ?? undefined,
      sentAt: new Date(row.received_at)
    };
  }

  return rowToInboundMessage(row);
}

function rowToInboundMessage(row: MessageRow): InboundMessage {
  return {
    tenantId: row.tenant_id,
    channel: row.channel,
    provider: row.provider,
    direction: 'inbound',
    messageId: row.message_id,
    chatId: row.chat_id,
    senderPhone: row.sender_phone,
    senderDisplayName: row.sender_display_name ?? undefined,
    text: row.text,
    mediaKind: normalizeMediaKind(row.media_kind),
    mediaName: row.media_name ?? undefined,
    mediaMime: row.media_mime ?? undefined,
    mediaData: row.media_data ?? undefined,
    mediaLocalPath: row.media_local_path ?? undefined,
    mediaDriveId: row.media_drive_id ?? undefined,
    mediaDriveUrl: row.media_drive_url ?? undefined,
    mediaUploadStatus: normalizeUploadStatus(row.media_upload_status),
    receivedAt: new Date(row.received_at)
  };
}

function normalizeMediaKind(value: string | null): StoredMessage['mediaKind'] {
  if (value === 'image' || value === 'document' || value === 'video' || value === 'audio' || value === 'sticker') return value;
  return undefined;
}
