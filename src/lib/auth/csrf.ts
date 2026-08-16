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

/**
 * Origin check for **read-only, auth-gated download GETs** only
 * (api/backup/download, api/reports/export, the two api/packs export routes,
 * api/simplefin/accounts).
 *
 * Controller ruling (supersedes the earlier "ruling (a)" pattern on those
 * routes): reject only when Origin or Sec-Fetch-Site is PRESENT and does not
 * match; when BOTH are absent, allow. Authentication is still required, and
 * every mutating route and server action keeps the strict isSameOrigin()
 * check — this relaxation applies to nothing else.
 *
 * Why: the documented default deployment is plain HTTP on the LAN. A
 * same-origin top-level navigation (the `<a href>` that starts these
 * downloads) sends no Origin header, and browsers omit Sec-Fetch-* on
 * non-trustworthy — i.e. non-HTTPS — origins. Strict isSameOrigin() therefore
 * sees no signal at all and 403s the family's own backup download on the
 * default install. Rejecting on header ABSENCE buys nothing there: a
 * cross-site link click arrives header-less too, so the two are
 * indistinguishable on plain HTTP. And the exposure is small by construction:
 * these are GETs that mutate nothing, the response goes only to the
 * requesting user's own browser, and CORS stops another origin from reading
 * it. A mismatched header, on the other hand, is a positive signal of a
 * cross-origin request and is still refused.
 */
export function isSameOriginOrHeaderless(headers: Headers, env: AppEnv = readEnv()): boolean {
  // `Origin: null` counts as PRESENT, not absent: a sandboxed iframe or a
  // cross-origin redirect is what produces it, and neither is the family's
  // own download link.
  const headerless = headers.get('origin') === null && headers.get('sec-fetch-site') === null;
  return headerless || isSameOrigin(headers, env);
}

export function assertSameOrigin(request: Request, env: AppEnv = readEnv()): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  if (!isSameOrigin(request.headers, env)) throw new CsrfError();
}
