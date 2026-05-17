import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ConversationSettings, ConversationSummary, InboundMessage, OutboundMessage, StoredMessage } from '../types.js';
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
  received_at: string;
}

interface ConversationRow {
  chat_id: string;
  display_name: string | null;
  phone: string;
  latest_text: string;
  latest_at: string;
  unread_count: number;
}

export interface MessageStore {
  saveInbound(message: InboundMessage): Promise<void>;
  saveOutbound(message: OutboundMessage): Promise<void>;
  listMessages(tenantId: string): Promise<InboundMessage[]>;
  listMessagesByChat(tenantId: string, chatId: string): Promise<StoredMessage[]>;
  listConversations(tenantId: string): Promise<ConversationSummary[]>;
  getConversationReplyContext(tenantId: string, chatId: string): Promise<{ lastBotReplyAt?: Date; lastManualReplyAt?: Date; botEnabled?: boolean }>;
  getConversationSettings(tenantId: string, chatId: string): Promise<ConversationSettings>;
  setConversationSettings(tenantId: string, chatId: string, patch: Partial<ConversationSettings>): Promise<ConversationSettings>;
  hasWhitelistedAlias(tenantId: string, displayName: string, whitelistPhones: string[]): Promise<boolean>;
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
  `);
  ensureColumn(db, 'messages', 'origin', 'TEXT');
  ensureColumn(db, 'messages', 'media_kind', 'TEXT');
  ensureColumn(db, 'messages', 'media_name', 'TEXT');
  ensureColumn(db, 'messages', 'media_mime', 'TEXT');
  ensureColumn(db, 'messages', 'media_data', 'TEXT');

  const insert = db.prepare<[string, string, string, string, string | null, string, string, string, string | null, string, string | null, string | null, string | null, string | null, string]>(`
    INSERT OR IGNORE INTO messages (
      tenant_id, channel, provider, direction, origin, message_id, chat_id,
      sender_phone, sender_display_name, text, media_kind, media_name, media_mime, media_data, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectColumns = `
    SELECT tenant_id, channel, provider, direction, origin, message_id, chat_id,
           sender_phone, sender_display_name, text, media_kind, media_name, media_mime, media_data, received_at
    FROM messages
  `;

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
    )
    ${selectColumns}
    WHERE tenant_id = ?
      AND chat_id IN (SELECT chat_id FROM alias_chats)
    ORDER BY received_at ASC
  `);

  const conversations = db.prepare<[string, string], ConversationRow>(`
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
        COALESCE('name:' || lower(chat_names.display_name), 'chat:' || m.chat_id) AS identity_key,
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
      GROUP BY identity_key
    )
    SELECT
      latest.chat_id,
      COALESCE(NULLIF(latest.identity_display_name, ''), NULLIF(latest.sender_display_name, ''), NULLIF(group_phones.phone, ''), NULLIF(latest.sender_phone, ''), latest.chat_id) AS display_name,
      COALESCE(NULLIF(group_phones.phone, ''), NULLIF(latest.sender_phone, ''), replace(latest.chat_id, '@s.whatsapp.net', '')) AS phone,
      latest.text AS latest_text,
      latest.received_at AS latest_at,
      COALESCE(unread.unread_count, 0) AS unread_count
    FROM latest
    LEFT JOIN group_phones ON group_phones.identity_key = latest.identity_key
    LEFT JOIN unread ON unread.identity_key = latest.identity_key
    ORDER BY latest.received_at DESC
  `);

  const replyContext = db.prepare<[string, string], { last_bot_reply_at: string | null; last_manual_reply_at: string | null }>(`
    SELECT
      MAX(CASE WHEN direction = 'outbound' AND origin = 'bot' THEN received_at END) AS last_bot_reply_at,
      MAX(CASE WHEN direction = 'outbound' AND origin = 'manual' THEN received_at END) AS last_manual_reply_at
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
        message.receivedAt.toISOString()
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
        message.sentAt.toISOString()
      );
    },

    async listMessages(tenantId: string): Promise<InboundMessage[]> {
      return listInbound.all(tenantId).map(rowToInboundMessage);
    },

    async listMessagesByChat(tenantId: string, chatId: string): Promise<StoredMessage[]> {
      return listByChat.all(tenantId, chatId, chatId, tenantId).map(rowToStoredMessage);
    },

    async listConversations(tenantId: string): Promise<ConversationSummary[]> {
      return conversations.all(tenantId, tenantId).map((row) => {
        const settings = readConversationSettings(stateReader, tenantId, row.chat_id);
        return {
          chatId: row.chat_id,
          displayName: row.display_name ?? row.phone,
          phone: row.phone,
          latestText: row.latest_text,
          latestAt: new Date(row.latest_at),
          unreadCount: row.unread_count,
          settings
        };
      });
    },

    async getConversationReplyContext(tenantId: string, chatId: string): Promise<{ lastBotReplyAt?: Date; lastManualReplyAt?: Date; botEnabled?: boolean }> {
      const row = (replyContext as unknown as { get: (tenantId: string, chatId: string) => { last_bot_reply_at: string | null; last_manual_reply_at: string | null } | undefined }).get(tenantId, chatId);
      const settings = readConversationSettings(stateReader, tenantId, chatId);
      return {
        lastBotReplyAt: row?.last_bot_reply_at ? new Date(row.last_bot_reply_at) : undefined,
        lastManualReplyAt: row?.last_manual_reply_at ? new Date(row.last_manual_reply_at) : undefined,
        botEnabled: settings.botEnabled
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
        note: typeof patch.note === 'string' ? patch.note.trim().slice(0, 1000) : current.note
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

function readConversationSettings(getState: { get: (key: string) => { value: string } | undefined }, tenantId: string, chatId: string): ConversationSettings {
  const fallback: ConversationSettings = { botEnabled: true, tags: [] };
  const raw = getState.get(conversationSettingsKey(tenantId, chatId))?.value;
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationSettings>;
    return {
      botEnabled: parsed.botEnabled !== false,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : [],
      note: typeof parsed.note === 'string' && parsed.note ? parsed.note : undefined
    };
  } catch {
    return fallback;
  }
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
      origin: row.origin === 'bot' ? 'bot' : 'manual',
      messageId: row.message_id,
      chatId: row.chat_id,
      recipientPhone: row.sender_phone,
      text: row.text,
      mediaKind: normalizeMediaKind(row.media_kind),
      mediaName: row.media_name ?? undefined,
      mediaMime: row.media_mime ?? undefined,
      mediaData: row.media_data ?? undefined,
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
    receivedAt: new Date(row.received_at)
  };
}

function normalizeMediaKind(value: string | null): StoredMessage['mediaKind'] {
  if (value === 'image' || value === 'document' || value === 'video' || value === 'audio' || value === 'sticker') return value;
  return undefined;
}
