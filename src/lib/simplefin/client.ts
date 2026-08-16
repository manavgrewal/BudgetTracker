/**
 * Pre-buffer content-length cap for the SimpleFIN route handlers' JSON bodies
 * (house pattern — same authenticated-memory-DoS defence as the CSV/pack
 * upload routes). Every body these routes accept is a handful of bytes under
 * zod's own limits (a setup token capped at 4000 chars, a link/unlink
 * payload), so 64KB is generous headroom without being a meaningful cap.
 */
export const MAX_SIMPLEFIN_BODY_BYTES = 64 * 1024;

export class SimplefinError extends Error {
  readonly status: number;
  readonly code: 'bad_token' | 'claim_failed' | 'http_error' | 'bad_response';
  constructor(code: SimplefinError['code'], message: string, status = 400) {
    super(message);
    this.name = 'SimplefinError';
    this.code = code;
    this.status = status;
  }
}

export interface SimplefinTransaction {
  id: string;
  posted: number;
  amount: string;
  description: string;
  pending?: boolean;
}

export interface SimplefinAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  'balance-date'?: number;
  transactions?: SimplefinTransaction[];
}

export interface SimplefinAccountSet {
  accounts: SimplefinAccount[];
  errlist: string[];
}

/** Injectable so every test runs against a mocked bridge and never touches the network. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const MAX_WINDOW_SECONDS = 90 * 24 * 60 * 60;

const defaultFetcher: Fetcher = async (url, init) => {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status, text: () => response.text() };
};

/** A setup token is base64 of the one-shot claim URL. */
export function decodeSetupToken(setupToken: string): string {
  const cleaned = setupToken.replace(/\s+/g, '');
  if (cleaned.length === 0) throw new SimplefinError('bad_token', 'Paste the setup token from your SimpleFIN bridge.');

  let decoded: string;
  try {
    decoded = Buffer.from(cleaned, 'base64').toString('utf8').trim();
  } catch {
    throw new SimplefinError('bad_token', 'That does not look like a SimpleFIN setup token.');
  }

  if (!/^https?:\/\//i.test(decoded)) {
    throw new SimplefinError('bad_token', 'That does not look like a SimpleFIN setup token (it does not decode to a URL).');
  }
  if (!/^https:\/\//i.test(decoded)) {
    throw new SimplefinError('bad_token', 'The claim URL is not https. Refusing to send a credential over plain HTTP.');
  }
  return decoded;
}

/** The access URL embeds basic-auth credentials; move them into a header and out of the URL. */
export function splitAccessUrl(accessUrl: string): { base: string; authHeader: string } {
  let parsed: URL;
  try {
    parsed = new URL(accessUrl);
  } catch {
    throw new SimplefinError('bad_response', 'The stored SimpleFIN access URL is not a valid URL.');
  }
  if (parsed.username.length === 0 && parsed.password.length === 0) {
    throw new SimplefinError('bad_response', 'The SimpleFIN access URL has no credentials embedded in it.');
  }
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';
  const base = parsed.toString().replace(/\/$/, '');
  return { base, authHeader: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

/** POST with Content-Length: 0. The token is spent afterwards — a second call fails by design. */
export async function claimSetupToken(setupToken: string, fetcher: Fetcher = defaultFetcher): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  const response = await fetcher(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });

  if (!response.ok) {
    if (response.status === 403 || response.status === 404 || response.status === 409) {
      throw new SimplefinError(
        'claim_failed',
        'The bridge rejected this setup token. A setup token can only be claimed once — generate a fresh one and try again.',
        response.status,
      );
    }
    throw new SimplefinError('claim_failed', `The bridge returned HTTP ${response.status} when claiming the token.`, response.status);
  }

  const body = (await response.text()).trim();
  if (!/^https:\/\/[^\s]+$/i.test(body)) {
    throw new SimplefinError('bad_response', 'The claim did not return an access URL. Check that the token came from your SimpleFIN bridge.');
  }
  return body;
}

export async function fetchAccounts(input: {
  accessUrl: string;
  startDate: number;
  endDate: number;
  fetcher?: Fetcher;
}): Promise<SimplefinAccountSet> {
  if (input.endDate - input.startDate > MAX_WINDOW_SECONDS) {
    throw new SimplefinError('bad_token', 'SimpleFIN windows are limited to 90 days.');
  }

  const { base, authHeader } = splitAccessUrl(input.accessUrl);
  const url = `${base}/accounts?version=2&start-date=${input.startDate}&end-date=${input.endDate}`;
  const fetcher = input.fetcher ?? defaultFetcher;
  const response = await fetcher(url, { method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' } });

  if (!response.ok) {
    throw new SimplefinError('http_error', `The SimpleFIN bridge returned HTTP ${response.status}.`, response.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new SimplefinError('bad_response', 'The SimpleFIN response could not be read as JSON.');
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new SimplefinError('bad_response', 'The SimpleFIN response could not be read as an account set.');
  }
  const record = parsed as { accounts?: unknown; errlist?: unknown };
  const accounts = Array.isArray(record.accounts) ? (record.accounts as SimplefinAccount[]) : [];
  const errlist = Array.isArray(record.errlist) ? record.errlist.map((entry) => String(entry)) : [];
  return { accounts, errlist };
}
