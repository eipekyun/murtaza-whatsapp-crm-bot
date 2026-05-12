import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { InboundMessage } from '../types.js';

interface MessageRow {
  tenant_id: string;
  channel: InboundMessage['channel'];
  provider: InboundMessage['provider'];
  direction: 'inbound';
  message_id: string;
  chat_id: string;
  sender_phone: string;
  sender_display_name: string | null;
  text: string;
  received_at: string;
}

export interface MessageStore {
  saveInbound(message: InboundMessage): Promise<void>;
  listMessages(tenantId: string): Promise<InboundMessage[]>;
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
      message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_phone TEXT NOT NULL,
      sender_display_name TEXT,
      text TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, provider, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_tenant_received
      ON messages(tenant_id, received_at DESC);
  `);

  const insert = db.prepare<[string, string, string, string, string, string, string, string | null, string, string]>(`
    INSERT OR IGNORE INTO messages (
      tenant_id, channel, provider, direction, message_id, chat_id,
      sender_phone, sender_display_name, text, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const list = db.prepare<[string], MessageRow>(`
    SELECT tenant_id, channel, provider, direction, message_id, chat_id,
           sender_phone, sender_display_name, text, received_at
    FROM messages
    WHERE tenant_id = ?
    ORDER BY received_at ASC
  `);

  return {
    async saveInbound(message: InboundMessage): Promise<void> {
      insert.run(
        message.tenantId,
        message.channel,
        message.provider,
        message.direction,
        message.messageId,
        message.chatId,
        message.senderPhone,
        message.senderDisplayName ?? null,
        message.text,
        message.receivedAt.toISOString()
      );
    },

    async listMessages(tenantId: string): Promise<InboundMessage[]> {
      return list.all(tenantId).map(rowToInboundMessage);
    },

    close(): void {
      db.close();
    }
  };
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
    receivedAt: new Date(row.received_at)
  };
}
