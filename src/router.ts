import { normalizePhone, normalizeWhitelist } from './phone.js';
import type { InboundMessage, RouterDecision } from './types.js';

export interface RouterOptions {
  tenantId: string;
  whitelistPhones: string[];
  autoReply: boolean;
  saveInbound: (message: InboundMessage) => Promise<void>;
}

export interface MessageRouter {
  handleInbound(message: InboundMessage): Promise<RouterDecision>;
}

export function createRouter(options: RouterOptions): MessageRouter {
  const whitelist = normalizeWhitelist(options.whitelistPhones);

  return {
    async handleInbound(message: InboundMessage): Promise<RouterDecision> {
      await options.saveInbound(message);

      if (!options.autoReply) {
        return { shouldReply: false, reason: 'auto_reply_disabled' };
      }

      const normalizedSender = normalizePhone(message.senderPhone);
      if (!whitelist.has(normalizedSender)) {
        return { shouldReply: false, reason: 'sender_not_whitelisted' };
      }

      return {
        shouldReply: true,
        reason: 'whitelisted_auto_reply',
        replyText: buildSafeLeadIntakeReply()
      };
    }
  };
}

function buildSafeLeadIntakeReply(): string {
  return [
    'Merhaba, ben ESMARK Asistanı.',
    'talebinizi doğru kişiye yönlendirebilmem için kısaca neye ihtiyacınız olduğunu yazar mısınız?',
    'İsterseniz firma adınızı, sektörünüzü ve size hangi konuda dönüş yapmamızı istediğinizi de ekleyebilirsiniz.'
  ].join(' ');
}
