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
  receivedAt: Date;
}

export interface RouterDecision {
  shouldReply: boolean;
  replyText?: string;
  reason: 'whitelisted_auto_reply' | 'sender_not_whitelisted' | 'auto_reply_disabled';
}
