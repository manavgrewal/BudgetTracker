import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WATCHTOWER_BAD_URL_ERROR,
  WATCHTOWER_TOKEN_ERROR,
  WatchtowerError,
  triggerUpdate,
  watchtowerConfig,
  watchtowerConfigError,
} from '@/lib/update/watchtower';

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

const GOOD = { WATCHTOWER_URL: 'http://watchtower:8080/v1/update', WATCHTOWER_TOKEN: 'budget-tracker-local-update' };

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('MUST-7.8 / MUST-8.7: watchtowerConfig is null unless both vars are usable', () => {
  it('returns the pair when both are present and the URL passes the guard', () => {
    expect(watchtowerConfig(GOOD)).toEqual({ url: GOOD.WATCHTOWER_URL, token: GOOD.WATCHTOWER_TOKEN });
    expect(watchtowerConfigError(GOOD)).toBeNull();
  });

  it('returns null when either is absent or empty, with no error to report', () => {
    expect(watchtowerConfig({ WATCHTOWER_URL: GOOD.WATCHTOWER_URL })).toBeNull();
    expect(watchtowerConfig({ WATCHTOWER_TOKEN: GOOD.WATCHTOWER_TOKEN })).toBeNull();
    expect(watchtowerConfig({ WATCHTOWER_URL: '', WATCHTOWER_TOKEN: '' })).toBeNull();
    // No compose file, nothing to complain about — this is the ordinary fallback path.
    expect(watchtowerConfigError({})).toBeNull();
  });

  it('returns null AND a reportable error when the URL fails the guard', () => {
    const bad = { WATCHTOWER_URL: 'http://evil.example.com/v1/update', WATCHTOWER_TOKEN: 'tok' };
    expect(watchtowerConfig(bad)).toBeNull();
    expect(watchtowerConfigError(bad)).toBe(WATCHTOWER_BAD_URL_ERROR);
  });
});

describe('MUST-7.1 / MUST-7.4: the apply request', () => {
  it('is a GET carrying a bearer token, redirect: error and a 30s abort', async () => {
    stub(() => new Response('', { status: 200 }));
    await expect(triggerUpdate(watchtowerConfig(GOOD)!)).resolves.toBe('accepted');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GOOD.WATCHTOWER_URL);
    expect(calls[0]!.init.method).toBe('GET');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${GOOD.WATCHTOWER_TOKEN}`);
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('MUST-7.4 step 5: a 401 or 403 is a permanent error naming the compose variables', async () => {
    for (const status of [401, 403]) {
      calls = [];
      stub(() => new Response('', { status }));
      const error = (await triggerUpdate(watchtowerConfig(GOOD)!).catch((e: unknown) => e)) as WatchtowerError;
      expect(error).toBeInstanceOf(WatchtowerError);
      expect(error.permanent).toBe(true);
      expect(error.message).toBe(WATCHTOWER_TOKEN_ERROR);
    }
  });

  it('MUST-7.3 / MUST-10.11: no error message contains any substring of the token', async () => {
    const token = 'budget-tracker-local-update';
    stub(() => {
      throw new Error(`connect ECONNREFUSED with Authorization: Bearer ${token}`);
    });
    const error = (await triggerUpdate({ url: GOOD.WATCHTOWER_URL, token }).catch((e: unknown) => e)) as WatchtowerError;
    expect(error.message).not.toContain(token);
    expect(error.message).toContain('[redacted]');
  });

  it('MUST-7.5: an abort AFTER the request was written is accepted-unconfirmed, not a failure', async () => {
    stub(() => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    });
    await expect(triggerUpdate(watchtowerConfig(GOOD)!)).resolves.toBe('accepted-unconfirmed');

    stub(() => {
      const error = new Error('socket hang up') as Error & { code?: string };
      error.code = 'ECONNRESET';
      throw error;
    });
    await expect(triggerUpdate(watchtowerConfig(GOOD)!)).resolves.toBe('accepted-unconfirmed');
  });

  it('MUST-7.4 step 6: any other non-2xx is a scrubbed status line and a throw', async () => {
    stub(() => new Response('', { status: 500 }));
    const error = (await triggerUpdate(watchtowerConfig(GOOD)!).catch((e: unknown) => e)) as WatchtowerError;
    expect(error.permanent).toBe(false);
    expect(error.message).toContain('500');
  });

  it('refuses to fetch at all when the URL fails the guard', async () => {
    stub(() => new Response('', { status: 200 }));
    await expect(triggerUpdate({ url: 'http://evil.example.com/v1/update', token: 'tok' })).rejects.toBeInstanceOf(
      WatchtowerError,
    );
    expect(calls).toHaveLength(0);
  });
});
