export type Channel = 'whatsapp';
export type Provider = 'baileys' | 'whatsapp-cloud-api';

export interface InboundMessage {
  tenantId: string;
  channel: Channel;
  provider: Provider;
  direction: 'inbound';
  messageId: string;
  chatId: string;
  senderPhone: string;
  senderDisplayName?: string;
  text: string;
  mediaKind?: MediaKind;
  mediaName?: string;
  mediaMime?: string;
  mediaData?: string;
  receivedAt: Date;
}

export type OutboundOrigin = 'manual' | 'bot' | 'self';
export type MediaKind = 'image' | 'document' | 'video' | 'audio' | 'sticker';

export interface OutboundMessage {
  tenantId: string;
  channel: Channel;
  provider: Provider;
  direction: 'outbound';
  origin: OutboundOrigin;
  messageId: string;
  chatId: string;
  recipientPhone: string;
  text: string;
  mediaKind?: MediaKind;
  mediaName?: string;
  mediaMime?: string;
  mediaData?: string;
  sentAt: Date;
}

export type StoredMessage = InboundMessage | OutboundMessage;

export interface ConversationSettings {
  botEnabled: boolean;
  tags: string[];
  note?: string;
}

export interface ConversationSummary {
  chatId: string;
  displayName: string;
  phone: string;
  latestText: string;
  latestAt: Date;
  unreadCount: number;
  settings?: ConversationSettings;
}

export type BotIntent =
  | 'first_contact'
  | 'service_interest'
  | 'existing_customer_support'
  | 'price_request'
  | 'out_of_hours'
  | 'unknown_intent';

export interface RouterDecision {
  shouldReply: boolean;
  replyText?: string;
  replyDelayMs?: number;
  intent?: BotIntent;
  reason:
    | 'whitelisted_auto_reply'
    | 'trusted_alias_auto_reply'
    | 'all_auto_reply'
    | 'sender_not_whitelisted'
    | 'auto_reply_disabled'
    | 'conversation_bot_disabled'
    | 'recent_bot_reply'
    | 'recent_manual_reply';
}
