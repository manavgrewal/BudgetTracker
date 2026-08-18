import { readEnv } from '@/lib/env';
import { scrubSecrets } from '@/lib/notify/crypto';
import { assertWatchtowerUrl } from '@/lib/update/egress';

/**
 * MUST-7.1: the app never touches the Docker socket, never shells out, never writes a
 * compose file and never restarts itself. It sends ONE HTTP request to the Watchtower
 * companion container on the compose network, and Watchtower — which already holds the
 * socket, already carries the label scope, and is already the thing that updates this app on
 * a prebuilt-image install — does the rest.
 *
 * The method is GET because that is the shape Watchtower's own documentation specifies for
 * /v1/update: the endpoint's contract is Watchtower's to define, not ours. Any 2xx is
 * "accepted".
 *
 * MUST-2.3: no `://` string literal appears in this file. The URL comes from WATCHTOWER_URL
 * and its default value is written once, in YAML, in install/synology-compose-pull.yml.
 * MUST-2.2: server-only. Never imported from a *-client.tsx.
 */
export const WATCHTOWER_TIMEOUT_MS = 30_000;

export const WATCHTOWER_BAD_URL_ERROR = 'The WATCHTOWER_URL in your compose file is not a valid internal address.';
export const WATCHTOWER_TOKEN_ERROR =
  'Watchtower rejected the token. Check that WATCHTOWER_TOKEN matches WATCHTOWER_HTTP_API_TOKEN in your compose file.';

export interface WatchtowerConfig {
  url: string;
  token: string;
}

export type TriggerOutcome = 'accepted' | 'accepted-unconfirmed';

export class WatchtowerError extends Error {
  readonly permanent: boolean;

  constructor(message: string, options: { permanent: boolean }) {
    super(message);
    this.name = 'WatchtowerError';
    this.permanent = options.permanent;
  }
}

function pair(source: Partial<NodeJS.ProcessEnv> | undefined): { url: string; token: string } | null {
  if (source === undefined) {
    const env = readEnv();
    if (env.watchtowerUrl === null || env.watchtowerToken === null) return null;
    return { url: env.watchtowerUrl, token: env.watchtowerToken };
  }
  const url = (source.WATCHTOWER_URL ?? '').trim();
  const token = (source.WATCHTOWER_TOKEN ?? '').trim();
  if (url.length === 0 || token.length === 0) return null;
  return { url, token };
}

/**
 * MUST-7.8 / MUST-8.7: null on a build-from-source install, a bare `npm start`, or a pull
 * install whose compose predates §16.1 — and null, too, when the URL fails the guard, which
 * puts that install on the same fallback path with a reportable reason. Never a 500, never a
 * silent no-op.
 */
export function watchtowerConfig(source?: Partial<NodeJS.ProcessEnv>): WatchtowerConfig | null {
  const found = pair(source);
  if (found === null) return null;
  try {
    assertWatchtowerUrl(found.url);
  } catch {
    return null;
  }
  return found;
}

/** The card's reason line: non-null only when both vars are SET and the URL is unusable. */
export function watchtowerConfigError(source?: Partial<NodeJS.ProcessEnv>): string | null {
  const found = pair(source);
  if (found === null) return null;
  try {
    assertWatchtowerUrl(found.url);
    return null;
  } catch {
    return WATCHTOWER_BAD_URL_ERROR;
  }
}

/**
 * MUST-7.5: Watchtower's /v1/update handler performs the update and THEN responds — and the
 * container being replaced is this one. It is therefore entirely normal for the connection
 * to die before a response arrives: the app has just asked something to kill it. Treating
 * that as a failure would show a red error on the last screen a person sees before the app
 * comes back healthy on the new version, which is the worst possible false negative.
 */
function isReplacementSignal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = (error as Error & { code?: string }).code;
  if (code === 'ECONNRESET' || code === 'EPIPE') return true;
  return /socket hang up|aborted|ECONNRESET|EPIPE/i.test(error.message);
}

/**
 * MUST-10.11: every string this function can produce passes through scrubSecrets with the
 * token in the secret list. An Authorization header can end up quoted in a fetch error or a
 * redirect message, which is exactly the hazard notify MUST-5.5 exists for.
 */
function clean(message: string, token: string): string {
  return scrubSecrets(message, [token]);
}

export async function triggerUpdate(config: WatchtowerConfig): Promise<TriggerOutcome> {
  try {
    assertWatchtowerUrl(config.url);
  } catch {
    throw new WatchtowerError(WATCHTOWER_BAD_URL_ERROR, { permanent: true });
  }

  let response: Response;
  try {
    // MUST-8.5: the guard is immediately above the call. Task 14 asserts the adjacency.
    assertWatchtowerUrl(config.url);
    response = await fetch(config.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(WATCHTOWER_TIMEOUT_MS),
    });
  } catch (error) {
    // MUST-7.4 step 7 / MUST-7.5.
    if (isReplacementSignal(error)) return 'accepted-unconfirmed';
    const raw = error instanceof Error ? error.message : 'The Watchtower request failed.';
    throw new WatchtowerError(clean(raw, config.token), { permanent: false });
  }

  if (response.ok) return 'accepted';
  if (response.status === 401 || response.status === 403) {
    throw new WatchtowerError(WATCHTOWER_TOKEN_ERROR, { permanent: true });
  }
  throw new WatchtowerError(clean(`Watchtower returned ${response.status}.`, config.token), { permanent: false });
}
