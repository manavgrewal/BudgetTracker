/**
 * MUST-9.1 / MUST-9.2 — the egress policy, in code. PURE (MUST-2.1).
 *
 * Exactly two destinations are permitted, and only once configured: this origin (two
 * endpoints on it, sendMessage and getUpdates) and the SMTP host an admin typed in.
 *
 * send/telegram.ts calls assertTelegramUrl() on the URL it is about to fetch, immediately
 * before the fetch. The bot token is interpolated into the PATH, so this guard also
 * catches a malformed token that manages to inject a host.
 *
 * This module holds the ONLY `://` URL literal anywhere under src/lib/notify/, and
 * tests/ops/notify-egress.test.ts fails the build if a second one appears (MUST-9.4).
 */
export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

/**
 * Only these two Bot API methods are ever called (send/telegram.ts). Anchoring the
 * pathname to exactly `/bot<token>/<method>` — no extra segments, no trailing slash —
 * is what actually stops a path-traversal token: `new URL()` resolves `../` dot-segments
 * *before* this check ever runs, so a token like `123:abc/../../@evil.com` collapses
 * `/bot123:abc/../../@evil.com/sendMessage` down to `/@evil.com/sendMessage` while the
 * origin stays `api.telegram.org` the whole time. An origin check alone would wave that
 * through; requiring the `/bot`-prefixed shape below is what actually catches it.
 */
const TELEGRAM_PATH_PATTERN = /^\/bot[^/]+\/(sendMessage|getUpdates)$/;

export function assertTelegramUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing a non-URL Telegram request target`);
  }
  // `origin` folds scheme, host and port together, and a userinfo section
  // ("https://api.telegram.org@evil.com") lands in `host`, so this single comparison
  // covers every look-alike shape.
  if (parsed.origin !== TELEGRAM_API_ORIGIN || parsed.username !== '' || parsed.password !== '') {
    throw new Error(`refusing a Telegram request to a non-permitted origin`);
  }
  if (!TELEGRAM_PATH_PATTERN.test(parsed.pathname)) {
    throw new Error(`refusing a Telegram request to an unrecognized path`);
  }
}
