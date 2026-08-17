import { describe, it, expect } from 'vitest';
import { TELEGRAM_API_ORIGIN, assertTelegramUrl } from '@/lib/notify/egress';

describe('MUST-9.2: assertTelegramUrl', () => {
  it('pins the one permitted Telegram origin', () => {
    expect(TELEGRAM_API_ORIGIN).toBe('https://api.telegram.org');
  });

  it('accepts the two permitted endpoints on that origin', () => {
    expect(() => assertTelegramUrl(`${TELEGRAM_API_ORIGIN}/bot123:abc/sendMessage`)).not.toThrow();
    expect(() =>
      assertTelegramUrl(`${TELEGRAM_API_ORIGIN}/bot123:abc/getUpdates?limit=100&allowed_updates=%5B%22message%22%5D`),
    ).not.toThrow();
  });

  it('rejects a look-alike host, plain HTTP, another port, and a userinfo trick', () => {
    for (const url of [
      'https://api.telegram.org.evil.com/bot123/sendMessage',
      'http://api.telegram.org/bot123/sendMessage',
      'https://api.telegram.org:8443/bot123/sendMessage',
      'https://api.telegram.org@evil.com/bot123/sendMessage',
      'https://evil.com/api.telegram.org/bot123/sendMessage',
    ]) {
      expect(() => assertTelegramUrl(url)).toThrowError(/telegram/i);
    }
  });

  it('rejects a token that smuggles a host into the path', () => {
    // The token is interpolated into the PATH, so a token containing a slash and a host
    // would otherwise change where the request goes.
    const badToken = '123:abc/../../@evil.com';
    expect(() => assertTelegramUrl(new URL(`/bot${badToken}/sendMessage`, TELEGRAM_API_ORIGIN).toString())).toThrow();
  });

  it('rejects a string that is not a URL at all', () => {
    expect(() => assertTelegramUrl('not a url')).toThrowError(/telegram/i);
  });
});
