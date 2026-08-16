import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session-constants';
import { securityHeaders } from '@/lib/auth/security-headers';

/**
 * Middleware runs on the Edge runtime and MUST NOT import better-sqlite3.
 * Real session validation happens server-side in requireUser(); this only:
 *   1. attaches security headers to every response, and
 *   2. bounces requests with no session cookie away from app pages.
 *
 * All /api/* paths are exempt from the redirect: route handlers enforce auth
 * themselves via requireUser() and must return a 401 JSON response, not receive
 * an HTML redirect (a fetch() call following a redirect to /login is not useful
 * to an API client). Security headers still apply to /api/* responses.
 */
// '/' itself must be public too: it is the setup-vs-login dispatcher (src/app/page.tsx),
// not a protected app page — it has to run unauthenticated to decide where to send a
// first-time visitor. The prefix-matching rule below only exempts the exact root path
// here (pathname.startsWith('//') never matches a real path), so this does not also
// exempt every other route the way adding, say, '/api' as a bare prefix would.
const PUBLIC_PREFIXES = ['/', '/login', '/setup', '/_next', '/favicon.ico'];

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** Edge-safe random nonce: Web Crypto + base64, no Buffer/Node dependency. */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  const hasCookie = request.cookies.has(SESSION_COOKIE_NAME);
  const nonce = generateNonce();

  // Next.js's documented CSP-nonce pattern: forward the nonce to the request so a
  // Server Component (the root layout) can read it via headers() and force this
  // route to render dynamically — required so each response gets a fresh nonce
  // matching the one in its own Content-Security-Policy header.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  let response: NextResponse;
  if (!isPublic && !isApiPath(pathname) && !hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    response = NextResponse.redirect(url);
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  for (const [key, value] of Object.entries(securityHeaders(nonce))) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
