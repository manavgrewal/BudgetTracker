import { SESSION_COOKIE_NAME } from './session-constants';

/**
 * Only the CLEARED variant lives here. Setting the cookie is done through
 * next/headers' cookie store (setSessionCookie in session.ts); the one place that
 * needs a raw Set-Cookie string is the logout route handler, which builds its own
 * Response. A hand-rolled "set" builder existed alongside this and had no callers —
 * two ways to spell the same cookie is exactly how the two drift apart.
 */
export function buildClearedSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
