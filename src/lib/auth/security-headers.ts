/**
 * script-src carries a per-request nonce (set by src/middleware.ts) so modern browsers
 * run only nonce-tagged scripts. 'unsafe-inline' stays alongside it purely as a legacy
 * fallback: CSP2+ browsers ignore 'unsafe-inline' whenever a nonce is present in the
 * same directive, so this only weakens the policy for browsers old enough to not
 * understand nonces at all.
 */
function buildCsp(nonce?: string): string {
  const scriptSrc = nonce ? `script-src 'self' 'nonce-${nonce}' 'unsafe-inline'` : "script-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    // data: is required for the TOTP QR PNG rendered at enrollment.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(nonce?: string): Record<string, string> {
  return {
    'Content-Security-Policy': buildCsp(nonce),
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  };
}
