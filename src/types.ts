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
  mediaLocalPath?: string;
  mediaDriveId?: string;
  mediaDriveUrl?: string;
  mediaUploadStatus?: MediaUploadStatus;
  // WhatsApp mesaj düzenleme (edit) zamanı (ISO). Set ise mesaj gönderildikten sonra düzenlendi.
  editedAt?: string;
  receivedAt: Date;
}

export type OutboundOrigin = 'manual' | 'bot' | 'self';
export type MediaKind = 'image' | 'document' | 'video' | 'audio' | 'sticker';
export type MediaUploadStatus = 'pending' | 'uploading' | 'done' | 'error' | 'skipped';
export type ReadReceiptMode = 'on_reply' | 'on_open' | 'never';

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
  mediaLocalPath?: string;
  mediaDriveId?: string;
  mediaDriveUrl?: string;
  mediaUploadStatus?: MediaUploadStatus;
  status?: number;
  // WhatsApp mesaj düzenleme (edit) zamanı (ISO). Set ise mesaj gönderildikten sonra düzenlendi.
  editedAt?: string;
  sentAt: Date;
}

export type StoredMessage = InboundMessage | OutboundMessage;

export interface ConversationSettings {
  botEnabled: boolean;
  tags: string[];
  note?: string;
  readReceipt: ReadReceiptMode;
  customerSlug?: string;
  // Operatörün seçtiği Perfex proje ID — çoklu projeli müşteride hangi projeye not düşüleceğini belirler
  perfexProjectId?: number;
}

export interface ChatCrmMapping {
  tenantId: string;
  chatId: string;
  customerSlug?: string;
  perfexClientId?: number;
  perfexProjectId?: number;
  projectName?: string;
  repoPath?: string;
  updatedAt: string;
}

export type CandidateStatus = 'draft' | 'sent' | 'approved' | 'written' | 'discarded';

export interface CandidateTask {
  title: string;
  description: string;
  priority: number;            // 1-4 (Perfex priority), default 2
  suggestedDue?: string;       // ISO tarih veya undefined
  sourceMessageIds: string[];
}

export interface GroupCandidate {
  id: number;
  tenantId: string;
  chatId: string;              // @g.us grup
  customerSlug?: string;
  perfexClientId?: number;
  perfexProjectId?: number;
  summary: string;
  tasks: CandidateTask[];
  status: CandidateStatus;
  sourceMessageIds: string[];
  extractionSource: string;
  windowStart?: string;
  windowEnd?: string;
  hash: string;
  approvalJobId?: string;      // Faz 4 alanı
  perfexTaskIds: number[];     // Faz 4 alanı
  createdAt: string;
  updatedAt: string;
}

export type NewGroupCandidate = Omit<GroupCandidate, 'id' | 'createdAt' | 'updatedAt'>;

export interface CustomerCardInfo {
  slug: string;
  name: string;
  perfexClientId?: number;
  perfexProjectIds: { id: number; name?: string }[];
  repoPath?: string;
  perfexLeadId?: number;
}

export interface ProjectOption {
  id: number;
  name: string;
}

// Perfex READ-ONLY sorgu sonuçları (scripts/perfex-query.py JSON sözleşmesi).
// task status: 1=Başlamadı, 2=Devam, 3=Test, 4=Geri Bildirim, 5=Tamamlandı
export interface PerfexTask {
  id: number;
  name: string;
  priority: number;
  status: number;
  statusLabel: string;
  dueDate?: string;
  // Görevin bağlı olduğu Perfex projesi. 0 = firmaya doğrudan bağlı (proje dışı) görev.
  // Açık görevlerin çoğu projeye bağlıdır (rel_type='project'); panel bunları projeye göre gruplar.
  projectId: number;
}

// project status: 1=Başlamadı, 2=Devam Ediyor, 3=Beklemede, 4=Tamamlandı, 5=İptal
export interface PerfexProjectStatus {
  id: number;
  name: string;
  status: number;
  statusLabel: string;
}

export interface PerfexQueryResult {
  tasks: PerfexTask[];
  projects: PerfexProjectStatus[];
  error: string | null;
}

export interface ConversationSummary {
  chatId: string;
  displayName: string;
  pushName?: string;
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
    | 'recent_manual_reply'
    | 'group_listen_only';
}
