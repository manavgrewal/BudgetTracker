/**
 * MUST-8.1 / MUST-8.4 / MUST-8.6: the update feature's egress policy, in code. PURE
 * (MUST-2.1): no @/db import, no @/lib/env import, no node builtin, no import of any kind.
 *
 * MUST-2.3: this module holds the ONLY `://` string literal anywhere under
 * src/lib/update/, mirroring the rule src/lib/notify/egress.ts already lives under, and
 * tests/ops/notify-egress.test.ts fails the build if a second one appears. The Watchtower
 * URL is deliberately NOT a literal anywhere in this tree: it arrives from WATCHTOWER_URL,
 * and its default value is written once, in YAML, in install/synology-compose-pull.yml.
 */
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_REPO_PATH = '/repos/VibeLogicCode/BudgetTracker';

/** MUST-4.2: the only two endpoints this app may ever call on api.github.com. */
export const GITHUB_RELEASES_PATH = `${GITHUB_REPO_PATH}/releases/latest`;
export const GITHUB_CHANGELOG_PATH = `${GITHUB_REPO_PATH}/contents/CHANGELOG.md`;

/** MUST-8.4 condition 5: the one place a caller-supplied value reaches the URL. */
const CHANGELOG_REF_PATTERN = /^\?ref=v\d+\.\d+\.\d+$/;

/**
 * MUST-8.4: all five conditions, and the reasoning is the same one notify's Telegram guard
 * sets out. `new URL()` normalises dot-segments BEFORE any check runs, so a value that folds
 * down to a different path can still read back an innocent `origin`; and a userinfo section
 * ("https://api.github.com@evil.com") lands in `host`, not in a separate field a naive check
 * would notice.
 *
 * Pinning the EXACT pathnames rather than a prefix is deliberate: a prefix check on
 * /repos/VibeLogicCode/BudgetTracker would happily allow /issues, /comments, or
 * /contents/<anything>, and this feature has no business reading any of them.
 */
export function assertGithubUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('refusing a GitHub request to a non-URL target');
  }
  // `origin` folds scheme, host and port together, so this single comparison covers
  // api.github.com.evil.com, plain http, and a non-443 port at once.
  if (parsed.origin !== GITHUB_API_ORIGIN) {
    throw new Error('refusing a GitHub request to a non-permitted origin');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('refusing a GitHub request carrying userinfo');
  }
  if (parsed.hash !== '') {
    throw new Error('refusing a GitHub request carrying a fragment');
  }
  if (parsed.pathname === GITHUB_RELEASES_PATH) {
    if (parsed.search !== '') throw new Error('refusing a GitHub request with an unexpected query');
    return;
  }
  if (parsed.pathname === GITHUB_CHANGELOG_PATH) {
    if (!CHANGELOG_REF_PATTERN.test(parsed.search)) {
      throw new Error('refusing a GitHub request with an unexpected query');
    }
    return;
  }
  throw new Error('refusing a GitHub request to an unrecognized path');
}

/** A Docker Compose service name: one label, no dot. `watchtower` is the shipped default. */
const BARE_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(hostname: string): boolean {
  const match = IPV4.exec(hostname);
  if (match === null) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true; //             127.0.0.0/8
  if (a === 10) return true; //              10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  // URL.hostname keeps the brackets off but lowercases the literal.
  if (hostname === '[::1]') return true;
  const inner = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (inner === '::1') return true;
  // fc00::/7 is fc.. or fd..; fe80::/10 is fe8./fe9./fea./feb.
  if (/^f[cd][0-9a-f]{0,2}:/i.test(inner)) return true;
  if (/^fe[89ab][0-9a-f]?:/i.test(inner)) return true;
  return false;
}

/**
 * MUST-8.6 / MUST-8.2: this function is what makes the Watchtower exemption from the
 * three-destination egress list enforceable rather than asserted. It refuses every hostname
 * that is not a bare compose label, `localhost`, or a private/loopback IP literal.
 *
 * A dotted name could resolve anywhere, and this function is PURE — it cannot and must not
 * resolve DNS to find out. So any dotted hostname that is not one of the IP literals below
 * is refused outright, which is stricter than "is it actually internal" and is the correct
 * direction to err in.
 */
export function assertWatchtowerUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('refusing a Watchtower request to a non-URL target');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('refusing a Watchtower request on a non-HTTP scheme');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('refusing a Watchtower request carrying userinfo');
  }
  if (parsed.pathname !== '/v1/update') {
    throw new Error('refusing a Watchtower request to an unrecognized path');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('refusing a Watchtower request carrying a query or fragment');
  }
  const host = parsed.hostname;
  const internal =
    host === 'localhost' || (!host.includes('.') && !host.includes(':') && BARE_LABEL.test(host)) || isPrivateIpv4(host) || isPrivateIpv6(host);
  if (!internal) {
    throw new Error('refusing a Watchtower request to a non-internal host');
  }
}
