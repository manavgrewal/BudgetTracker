import { parseChangelog, type ChangelogRelease } from '@/lib/changelog';
import { truncateText } from '@/lib/notify/render';
import { GITHUB_API_ORIGIN, GITHUB_CHANGELOG_PATH, GITHUB_RELEASES_PATH, assertGithubUrl } from '@/lib/update/egress';
import { formatSemver, parseSemver } from '@/lib/update/semver';
import { APP_VERSION } from '@/lib/version';

/**
 * MUST-4.1: the check compares APP_VERSION with the latest published GitHub release of the
 * PUBLIC repository VibeLogicCode/BudgetTracker. No authentication token is ever sent. An
 * unauthenticated api.github.com caller gets 60 requests per hour per source IP, and this
 * feature's ceiling is one scheduled check per day plus a rate-limited button, so the quota
 * is never a design consideration.
 *
 * MUST-2.2: server-only. Never imported, directly or transitively, from a *-client.tsx.
 *
 * There are exactly two `fetch(` call sites in this file, one per endpoint, each with
 * `assertGithubUrl()` on the line immediately above it (MUST-8.5). They are deliberately not
 * folded into a shared request helper: that adjacency is the property a refactor loses first,
 * and Task 14's scanner checks for it at the source level.
 */
export const GITHUB_TIMEOUT_MS = 15_000;
export const MAX_CHANGELOG_BYTES = 512 * 1024;
export const MAX_CHANGELOG_GROUPS = 12;
export const MAX_CHANGELOG_ITEMS = 200;
export const CHANGELOG_ITEM_MAX = 500;
export const CHANGELOG_TITLE_MAX = 60;

export const UNPARSEABLE_TAG_ERROR = 'That release tag is not a version this app can compare.';
const MALFORMED_ERROR = 'GitHub returned something this app could not read.';
const CHANGELOG_UNREADABLE = 'The release notes could not be read.';

export interface RemoteRelease {
  /** The release tag exactly as GitHub reports it, e.g. "v1.4.0". */
  tag: string;
  /** The tag with one optional leading "v" stripped, e.g. "1.4.0". */
  version: string;
  publishedAt: string | null;
}

/**
 * MUST-4.7: `permanent` is true for HTTP 401/403/404/422 and for a malformed payload; false
 * for 429, any 5xx, a DNS failure, a connect timeout and an abort. There is no backoff
 * ladder, because there is at most one automatic attempt per day already (MUST-5.5).
 */
export class UpdateCheckError extends Error {
  readonly permanent: boolean;

  constructor(message: string, options: { permanent: boolean }) {
    super(message);
    this.name = 'UpdateCheckError';
    this.permanent = options.permanent;
  }
}

/** MUST-4.3: these three, and nothing else. No Authorization. No cookie. No telemetry field. */
function headers(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub requires a User-Agent; ours names the product and its version and nothing
    // about the install: not its hostname, not its data directory, not its user count.
    'User-Agent': `BudgetTracker/${APP_VERSION}`,
  };
}

function statusIsPermanent(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 422;
}

/** Turns anything a rejected fetch() can throw (DNS failure, connect timeout, abort) into a
 * transient UpdateCheckError. Does not itself call fetch. */
function requestFailure(error: unknown): UpdateCheckError {
  const message = error instanceof Error ? error.message : 'The GitHub request failed.';
  return new UpdateCheckError(message, { permanent: false });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new UpdateCheckError(MALFORMED_ERROR, { permanent: true });
  }
}

/**
 * MUST-4.2 endpoint 1. MUST-4.6: the ONLY fields read are tag_name and published_at. draft
 * and prerelease releases are refused by the endpoint itself (/releases/latest excludes
 * both), and a tag_name that fails parseSemver raises a PERMANENT error rather than being
 * guessed at, which is what keeps an unclassifiable version away from an auto-apply
 * decision (MUST-4.10).
 */
export async function fetchLatestRelease(): Promise<RemoteRelease> {
  const url = `${GITHUB_API_ORIGIN}${GITHUB_RELEASES_PATH}`;
  // MUST-4.4: 15 s abort and redirect: 'error'. A 3xx from api.github.com is a failure, not
  // a hop.
  let response: Response;
  try {
    assertGithubUrl(url);
    response = await fetch(url, {
      method: 'GET',
      headers: headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    throw requestFailure(error);
  }

  if (!response.ok) {
    throw new UpdateCheckError(`GitHub returned ${response.status}.`, { permanent: statusIsPermanent(response.status) });
  }

  const payload = (await readJson(response)) as { tag_name?: unknown; published_at?: unknown };
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name : '';
  const parsed = parseSemver(tag);
  if (parsed === null) throw new UpdateCheckError(UNPARSEABLE_TAG_ERROR, { permanent: true });

  return {
    tag,
    // Re-serialised from the parsed integers, never passed through (MUST-4.2).
    version: formatSemver(parsed),
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
  };
}

/**
 * MUST-4.2 endpoint 2, pinned to the release's OWN tag rather than the default branch, so
 * the changelog an admin reads on the confirm screen is the changelog of the version being
 * offered, not whatever `main` happens to hold.
 *
 * `version` is re-serialised from parseSemver's integer components before it reaches the
 * URL (informational 4 of the Task 2 review): a value that survived parseSemver cannot
 * contain a path or query character, so the guard's `\d+` pattern and this parser's
 * strictness can never diverge.
 */
export async function fetchRemoteChangelog(version: string): Promise<string> {
  const parsedVersion = parseSemver(version);
  if (parsedVersion === null) throw new UpdateCheckError(UNPARSEABLE_TAG_ERROR, { permanent: true });

  const url = `${GITHUB_API_ORIGIN}${GITHUB_CHANGELOG_PATH}?ref=v${formatSemver(parsedVersion)}`;
  let response: Response;
  try {
    assertGithubUrl(url);
    response = await fetch(url, {
      method: 'GET',
      headers: headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    throw requestFailure(error);
  }

  if (!response.ok) {
    throw new UpdateCheckError(`GitHub returned ${response.status}.`, { permanent: statusIsPermanent(response.status) });
  }

  // MUST-4.6: the only fields read are encoding, size and content, and both guards are
  // permanent failures. The confirm screen then renders MUST-9.6's fallback sentence.
  const payload = (await readJson(response)) as { encoding?: unknown; size?: unknown; content?: unknown };
  if (payload.encoding !== 'base64') throw new UpdateCheckError(CHANGELOG_UNREADABLE, { permanent: true });
  if (typeof payload.size !== 'number' || payload.size > MAX_CHANGELOG_BYTES) {
    throw new UpdateCheckError(CHANGELOG_UNREADABLE, { permanent: true });
  }
  if (typeof payload.content !== 'string') throw new UpdateCheckError(CHANGELOG_UNREADABLE, { permanent: true });

  return Buffer.from(payload.content, 'base64').toString('utf8');
}

/**
 * MUST-4.8: a repository is a place a person can write anything, and the confirm screen
 * treats it that way. The decoded text is parsed by the EXISTING pure parseChangelog() and
 * rendered by the EXISTING renderEmphasis() bold-run helper (no markdown library,
 * no dangerouslySetInnerHTML anywhere), and the parsed result is bounded here, with the
 * same truncateText discipline notify MUST-10.3 applies to merchant names.
 */
export function boundRelease(release: ChangelogRelease): ChangelogRelease {
  const groups: ChangelogRelease['groups'] = [];
  let budget = MAX_CHANGELOG_ITEMS;
  for (const group of release.groups.slice(0, MAX_CHANGELOG_GROUPS)) {
    if (budget <= 0) break;
    const items = group.items.slice(0, budget).map((item) => truncateText(item, CHANGELOG_ITEM_MAX));
    budget -= items.length;
    groups.push({ title: truncateText(group.title, CHANGELOG_TITLE_MAX), items });
  }
  return {
    heading: truncateText(release.heading, CHANGELOG_TITLE_MAX),
    notes: release.notes.slice(0, MAX_CHANGELOG_GROUPS).map((note) => truncateText(note, CHANGELOG_ITEM_MAX)),
    groups,
  };
}

/** Re-exported so callers parse remote text with the same reader the About panel uses. */
export { parseChangelog };
