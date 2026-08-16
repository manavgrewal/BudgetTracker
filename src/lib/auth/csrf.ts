import { readEnv, type AppEnv } from '@/lib/env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class CsrfError extends Error {
  readonly status = 403;
  constructor(message = 'Cross-origin request rejected') {
    super(message);
    this.name = 'CsrfError';
  }
}

/**
 * Primary CSRF defence (spec section 6): Origin verified against Host.
 * Sec-Fetch-Site is only a fallback when Origin is absent, because browsers
 * omit fetch metadata on plain-HTTP (non-trustworthy) origins.
 *
 * X-Forwarded-Host is only trusted when TRUST_PROXY is on — it is a client-settable
 * header, so honouring it unconditionally would let an attacker spoof a matching
 * "Host" for CSRF purposes on a request that never actually passed through the proxy.
 */
export function isSameOrigin(headers: Headers, env: AppEnv = readEnv()): boolean {
  const host = env.trustProxy ? (headers.get('x-forwarded-host') ?? headers.get('host')) : headers.get('host');
  if (!host) return false;

  const origin = headers.get('origin');
  if (origin && origin !== 'null') {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  const fetchSite = headers.get('sec-fetch-site');
  return fetchSite === 'same-origin' || fetchSite === 'none';
}

export function assertSameOrigin(request: Request, env: AppEnv = readEnv()): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  if (!isSameOrigin(request.headers, env)) throw new CsrfError();
}
