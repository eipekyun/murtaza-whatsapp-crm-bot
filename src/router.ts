import { normalizePhone, normalizeWhitelist } from './phone.js';
import type { BotIntent, InboundMessage, RouterDecision } from './types.js';

export interface RouterOptions {
  tenantId: string;
  whitelistPhones: string[];
  autoReply: boolean;
  getAutoReplyAudience?: () => 'whitelist' | 'all';
  isTrustedSender?: (message: InboundMessage) => Promise<boolean>;
  getConversationContext?: (message: InboundMessage) => Promise<{ lastBotReplyAt?: Date; lastManualReplyAt?: Date; botEnabled?: boolean }>;
  now?: () => Date;
  saveInbound: (message: InboundMessage) => Promise<void>;
}

export interface MessageRouter {
  handleInbound(message: InboundMessage): Promise<RouterDecision>;
}

export function createRouter(options: RouterOptions): MessageRouter {
  return {
    async handleInbound(message: InboundMessage): Promise<RouterDecision> {
      await options.saveInbound(message);

      if (!options.autoReply) {
        return { shouldReply: false, reason: 'auto_reply_disabled' };
      }

      const context = await options.getConversationContext?.(message);
      if (context?.botEnabled === false) {
        return { shouldReply: false, reason: 'conversation_bot_disabled' };
      }
      if (isRecent(context?.lastManualReplyAt, 30 * 60 * 1000, options.now?.())) {
        return { shouldReply: false, reason: 'recent_manual_reply' };
      }
      if (isRecent(context?.lastBotReplyAt, 12 * 60 * 60 * 1000, options.now?.())) {
        return { shouldReply: false, reason: 'recent_bot_reply' };
      }

      const reply = buildContextualReply(message, options.now?.() ?? new Date());
      if ((options.getAutoReplyAudience?.() ?? 'whitelist') === 'all') {
        return {
          shouldReply: true,
          reason: 'all_auto_reply',
          replyText: reply.text,
          intent: reply.intent,
          replyDelayMs: pickHumanDelayMs(message)
        };
      }

      const normalizedSender = normalizePhone(message.senderPhone);
      const whitelist = normalizeWhitelist(options.whitelistPhones);
      if (!whitelist.has(normalizedSender)) {
        const trustedAlias = await options.isTrustedSender?.(message);
        if (!trustedAlias) return { shouldReply: false, reason: 'sender_not_whitelisted' };
        return {
          shouldReply: true,
          reason: 'trusted_alias_auto_reply',
          replyText: reply.text,
          intent: reply.intent,
          replyDelayMs: pickHumanDelayMs(message)
        };
      }

      return {
        shouldReply: true,
        reason: 'whitelisted_auto_reply',
        replyText: reply.text,
        intent: reply.intent,
        replyDelayMs: pickHumanDelayMs(message)
      };
    }
  };
}

interface ReplyTemplate {
  intent: BotIntent;
  text: string;
}

function buildContextualReply(message: InboundMessage, now: Date): ReplyTemplate {
  if (!isBusinessHours(now)) {
    return {
      intent: 'out_of_hours',
      text: 'Merhaba, ESMARK müşteri asistanı. Mesajınızı aldım; ekip mesai saatinde görüp dönüş yapacak. Kısaca hangi konuda destek istediğinizi yazarsanız sabah daha hızlı yönlendirebilirim.'
    };
  }

  const text = message.text.toLocaleLowerCase('tr-TR');
  if (/(web|site|reklam|google|ads|seo|sosyal medya|instagram|meta)/i.test(text)) {
    return {
      intent: 'service_interest',
      text: 'Merhaba, ESMARK müşteri asistanı. web sitesi / reklam talebinizi aldım; uygun kişi görüp dönüş yapacak. Kısaca firma adınızı, sektörünüzü ve hedefinizi yazarsanız daha hızlı yönlendirebilirim.'
    };
  }
  if (/(fiyat|ücret|teklif|kaç para|maliyet)/i.test(text)) {
    return {
      intent: 'price_request',
      text: 'Merhaba, ESMARK müşteri asistanı. Teklif/fiyat talebinizi aldım; net dönüş için uygun kişi inceleyecek. İsterseniz ihtiyacınızı ve varsa web adresinizi kısaca yazın.'
    };
  }
  if (/(destek|arıza|sorun|çalışmıyor|yardım|müşteri)/i.test(text)) {
    return {
      intent: 'existing_customer_support',
      text: 'Merhaba, ESMARK müşteri asistanı. Destek talebinizi aldım; ilgili kişi görüp dönüş yapacak. Sorunu ve hangi proje/hesapla ilgili olduğunu kısaca yazabilir misiniz?'
    };
  }
  return { intent: 'first_contact', text: buildSafeLeadIntakeReply() };
}

function buildSafeLeadIntakeReply(): string {
  return [
    'Merhaba, ESMARK müşteri asistanı.',
    'Yazdığınızı aldım; uygun kişi görüp dönüş yapacak.',
    'Bu arada kısaca hangi konuda destek istediğinizi yazarsanız daha hızlı yönlendirebilirim.'
  ].join(' ');
}

function isRecent(date: Date | undefined, windowMs: number, now = new Date()): boolean {
  if (!date) return false;
  return now.getTime() - date.getTime() < windowMs;
}

function isBusinessHours(now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', hour12: false }).format(now));
  return hour >= 9 && hour < 18;
}

function pickHumanDelayMs(message: InboundMessage): number {
  const normalizedLength = Math.min(message.text.length, 120);
  return 2500 + Math.floor(normalizedLength * 20);
}
