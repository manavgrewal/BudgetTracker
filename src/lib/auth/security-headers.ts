/**
 * script-src carries a per-request nonce (set by src/middleware.ts) so modern browsers
 * run only nonce-tagged scripts. 'unsafe-inline' stays alongside it purely as a legacy
 * fallback: CSP2+ browsers ignore 'unsafe-inline' whenever a nonce is present in the
 * same directive, so this only weakens the policy for browsers old enough to not
 * understand nonces at all.
 *
 * 'wasm-unsafe-eval' is required by the receipt scanner. Chromium enforces CSP on
 * WebAssembly compilation, so without it WebAssembly.instantiate throws and the scanner
 * never initialises on Android Chrome, which is its primary device. The token permits
 * WebAssembly compilation and nothing else: it does not re-enable eval or new Function,
 * which is exactly why it exists separately from 'unsafe-eval'.
 */
function buildCsp(nonce?: string): string {
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-inline' 'wasm-unsafe-eval'`
    : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";
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
    // camera=() stays even though the scanner ships: it costs nothing, because the file
    // input's capture="environment" handoff to the phone's camera app is not governed by
    // this policy, and it mechanically stops a future contributor from adding a live
    // WebRTC-based viewfinder without noticing why there is not one already.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  };
}
