import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
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
    // Token is deliberately >= MIN_TOKEN_LENGTH so this test isolates the URL-guard failure
    // from the too-short-token fallback exercised separately below.
    const bad = { WATCHTOWER_URL: 'http://evil.example.com/v1/update', WATCHTOWER_TOKEN: 'not-too-short' };
    expect(watchtowerConfig(bad)).toBeNull();
    expect(watchtowerConfigError(bad)).toBe(WATCHTOWER_BAD_URL_ERROR);
  });
});

describe('finding 5: a too-short WATCHTOWER_TOKEN is treated as unset, not accepted', () => {
  it('a 7-character token (below the boundary) is treated as absent, with a one-time warning naming the var', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const short = { WATCHTOWER_URL: GOOD.WATCHTOWER_URL, WATCHTOWER_TOKEN: 'a'.repeat(7) };
      expect(watchtowerConfig(short)).toBeNull();
      // No usable pair at all — same reportable-error shape as any other "absent" case.
      expect(watchtowerConfigError(short)).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain('WATCHTOWER_TOKEN');

      // A second call does not warn again — it is a one-time-per-process warning, not
      // one-per-call.
      watchtowerConfig(short);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('an 8-character token (at the boundary) is accepted', () => {
    const atBoundary = { WATCHTOWER_URL: GOOD.WATCHTOWER_URL, WATCHTOWER_TOKEN: 'a'.repeat(8) };
    expect(watchtowerConfig(atBoundary)).toEqual({ url: GOOD.WATCHTOWER_URL, token: 'a'.repeat(8) });
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

    // AbortSignal.timeout()'s REAL shape (verified on Node 24): a DOMException named
    // 'TimeoutError', not a plain Error with a reassigned .name. isReplacementSignal checks
    // `.name === 'TimeoutError'` before it ever inspects the message, so this pins the
    // name-based branch specifically — it stays correct even if the /aborted/i message
    // fallback were removed, despite this authentic message also containing "aborted".
    stub(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
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

describe('HIGH fix: real socket drops (authentic Node/undici error shapes, not hand-built)', () => {
  // These deliberately do NOT call stub() — real global fetch talks to a real local TCP
  // server on 127.0.0.1 (an internal host, so assertWatchtowerUrl passes it), producing the
  // genuine undici error shapes (a top-level TypeError('fetch failed') wrapping the real
  // socket error in .cause) that the hand-built mocks elsewhere in this file cannot fake.
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server === undefined) return;
    const toClose = server;
    server = undefined;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  });

  function listen(handler: (socket: net.Socket) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer(handler);
      srv.on('error', reject);
      server = srv;
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}/v1/update`);
      });
    });
  }

  it('a hard RST mid-request (socket.resetAndDestroy) resolves to accepted-unconfirmed', async () => {
    const url = await listen((socket) => {
      socket.on('data', () => {
        if (typeof socket.resetAndDestroy === 'function') {
          socket.resetAndDestroy();
        } else {
          socket.destroy();
        }
      });
    });
    await expect(triggerUpdate({ url, token: GOOD.WATCHTOWER_TOKEN })).resolves.toBe('accepted-unconfirmed');
  });

  it('a clean close mid-response, with no HTTP response ever written, resolves to accepted-unconfirmed', async () => {
    const url = await listen((socket) => {
      // Watchtower's handler has started the update and the container is being torn down:
      // the far side just ends the connection, with no bytes of an HTTP response sent at
      // all. undici cannot attach a recognizable OS error code to this — it reports a bare
      // top-level TypeError('fetch failed'), which is exactly what the second, separate
      // check in isReplacementSignal exists to catch.
      socket.on('data', () => {
        socket.end();
      });
    });
    await expect(triggerUpdate({ url, token: GOOD.WATCHTOWER_TOKEN })).resolves.toBe('accepted-unconfirmed');
  });
});
