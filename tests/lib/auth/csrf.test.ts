import { describe, it, expect } from 'vitest';
import { isSameOrigin, isSameOriginOrHeaderless, assertSameOrigin, CsrfError } from '@/lib/auth/csrf';
import { securityHeaders } from '@/lib/auth/security-headers';
import type { AppEnv } from '@/lib/env';

function headersFor(init: Record<string, string>): Headers {
  return new Headers(init);
}

function envWith(trustProxy: boolean): AppEnv {
  return { secretKey: 'x'.repeat(32), trustProxy, tz: 'UTC', port: 3000, dataDir: '/data' };
}

describe('isSameOrigin', () => {
  it('accepts a matching Origin and Host', () => {
    expect(isSameOrigin(headersFor({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }))).toBe(true);
    expect(isSameOrigin(headersFor({ origin: 'https://budget.example.com', host: 'budget.example.com' }))).toBe(true);
  });

  it('rejects a cross-origin request', () => {
    expect(isSameOrigin(headersFor({ origin: 'http://evil.local', host: 'nas.local:3000' }))).toBe(false);
    expect(isSameOrigin(headersFor({ origin: 'http://nas.local:3001', host: 'nas.local:3000' }))).toBe(false);
  });

  it('accepts a missing Origin only when Sec-Fetch-Site says same-origin or none', () => {
    expect(isSameOrigin(headersFor({ host: 'nas.local:3000', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOrigin(headersFor({ host: 'nas.local:3000', 'sec-fetch-site': 'none' }))).toBe(true);
    expect(isSameOrigin(headersFor({ host: 'nas.local:3000', 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('rejects a request with neither Origin nor fetch metadata', () => {
    // Plain-HTTP browsers omit Sec-Fetch-*, but they still send Origin on mutating
    // requests, so "neither" means a non-browser client — refuse it.
    expect(isSameOrigin(headersFor({ host: 'nas.local:3000' }))).toBe(false);
  });

  it('rejects when Host is missing entirely', () => {
    expect(isSameOrigin(headersFor({ origin: 'http://nas.local:3000' }))).toBe(false);
  });

  it('prefers X-Forwarded-Host when present and TRUST_PROXY is on (reverse proxy)', () => {
    expect(
      isSameOrigin(
        headersFor({ origin: 'https://budget.example.com', host: 'internal:3000', 'x-forwarded-host': 'budget.example.com' }),
        envWith(true),
      ),
    ).toBe(true);
  });

  it('ignores X-Forwarded-Host when TRUST_PROXY is off (untrusted client header)', () => {
    // Same headers as the reverse-proxy case above, but without TRUST_PROXY: the real
    // Host does not match Origin, so a client-supplied X-Forwarded-Host must not save it.
    expect(
      isSameOrigin(
        headersFor({ origin: 'https://budget.example.com', host: 'internal:3000', 'x-forwarded-host': 'budget.example.com' }),
        envWith(false),
      ),
    ).toBe(false);
  });
});

describe('isSameOriginOrHeaderless (read-only download GETs only)', () => {
  it('allows a request carrying NEITHER Origin nor Sec-Fetch-Site', () => {
    // The plain-HTTP LAN case: a same-origin navigation sends no Origin, and
    // browsers omit Sec-Fetch-* on non-trustworthy origins. Strict
    // isSameOrigin() refuses exactly this — which broke the backup download on
    // the documented default deployment.
    expect(isSameOrigin(headersFor({ host: 'nas.local:3000' }))).toBe(false);
    expect(isSameOriginOrHeaderless(headersFor({ host: 'nas.local:3000' }))).toBe(true);
  });

  it('still rejects a PRESENT and mismatched Origin', () => {
    expect(isSameOriginOrHeaderless(headersFor({ origin: 'http://evil.local', host: 'nas.local:3000' }))).toBe(false);
    expect(isSameOriginOrHeaderless(headersFor({ origin: 'http://nas.local:3001', host: 'nas.local:3000' }))).toBe(false);
  });

  it('still rejects a PRESENT and mismatched Sec-Fetch-Site', () => {
    expect(isSameOriginOrHeaderless(headersFor({ host: 'nas.local:3000', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOriginOrHeaderless(headersFor({ host: 'nas.local:3000', 'sec-fetch-site': 'same-site' }))).toBe(false);
  });

  it('treats "Origin: null" as present, not absent (sandboxed iframe / cross-origin redirect)', () => {
    expect(isSameOriginOrHeaderless(headersFor({ origin: 'null', host: 'nas.local:3000' }))).toBe(false);
  });

  it('accepts the ordinary matching-header cases exactly as isSameOrigin does', () => {
    expect(isSameOriginOrHeaderless(headersFor({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }))).toBe(true);
    expect(isSameOriginOrHeaderless(headersFor({ host: 'nas.local:3000', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginOrHeaderless(headersFor({ host: 'nas.local:3000', 'sec-fetch-site': 'none' }))).toBe(true);
  });

  it('honours TRUST_PROXY the same way, since it delegates to isSameOrigin for present headers', () => {
    const proxied = headersFor({ origin: 'https://budget.example.com', host: 'internal:3000', 'x-forwarded-host': 'budget.example.com' });
    expect(isSameOriginOrHeaderless(proxied, envWith(true))).toBe(true);
    expect(isSameOriginOrHeaderless(proxied, envWith(false))).toBe(false);
  });
});

describe('assertSameOrigin', () => {
  it('throws CsrfError with status 403 on a cross-origin request', () => {
    const request = new Request('http://nas.local:3000/api/import/commit', {
      method: 'POST',
      headers: { origin: 'http://evil.local', host: 'nas.local:3000' },
    });
    expect(() => assertSameOrigin(request)).toThrowError(CsrfError);
    try {
      assertSameOrigin(request);
    } catch (error) {
      expect((error as CsrfError).status).toBe(403);
    }
  });

  it('passes a same-origin request through', () => {
    const request = new Request('http://nas.local:3000/api/import/commit', {
      method: 'POST',
      headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000' },
    });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it('never blocks a GET', () => {
    const request = new Request('http://nas.local:3000/api/health', {
      method: 'GET',
      headers: { host: 'nas.local:3000' },
    });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });
});

describe('securityHeaders', () => {
  it('sets a self-only CSP, denies framing and trims the referrer', () => {
    const headers = securityHeaders();
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("img-src 'self' data:");
    expect(headers['Content-Security-Policy']).not.toContain('http://');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('same-origin');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('falls back to a plain script-src (with unsafe-inline) when no nonce is given', () => {
    const headers = securityHeaders();
    expect(headers['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(headers['Content-Security-Policy']).not.toContain('nonce-');
  });

  it('embeds the per-request nonce in script-src, keeping unsafe-inline only as a legacy fallback', () => {
    const headers = securityHeaders('abc123==');
    expect(headers['Content-Security-Policy']).toContain("script-src 'self' 'nonce-abc123==' 'unsafe-inline'");
  });
});
