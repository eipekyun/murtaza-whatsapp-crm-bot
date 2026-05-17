import { describe, expect, it } from 'vitest';
import { shouldReconnectAfterClose } from '../src/whatsapp/reconnect-policy.js';

describe('WhatsApp reconnect policy', () => {
  it('auto-reconnects after 408 connection-lost timeouts on an already paired session', () => {
    expect(shouldReconnectAfterClose(408)).toBe(true);
  });

  it('does not auto-reconnect after explicit logout', () => {
    expect(shouldReconnectAfterClose(401)).toBe(false);
  });

  it('allows reconnect for transient unknown failures', () => {
    expect(shouldReconnectAfterClose(undefined)).toBe(true);
  });
});
