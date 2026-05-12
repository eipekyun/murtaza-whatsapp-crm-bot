import { describe, expect, it } from 'vitest';
import { shouldReconnectAfterClose } from '../src/whatsapp/reconnect-policy.js';

describe('WhatsApp reconnect policy', () => {
  it('does not auto-reconnect after QR timeout to avoid repeated pairing attempts', () => {
    expect(shouldReconnectAfterClose(408)).toBe(false);
  });

  it('does not auto-reconnect after explicit logout', () => {
    expect(shouldReconnectAfterClose(401)).toBe(false);
  });

  it('allows reconnect for transient unknown failures', () => {
    expect(shouldReconnectAfterClose(undefined)).toBe(true);
  });
});
