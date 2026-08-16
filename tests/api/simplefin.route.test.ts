import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { GET as accountsRoute } from '@/app/api/simplefin/accounts/route';
import { POST as claimRoute } from '@/app/api/simplefin/claim/route';
import { POST as linkRoute } from '@/app/api/simplefin/link/route';
import { POST as syncRoute } from '@/app/api/simplefin/sync/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { MAX_SIMPLEFIN_BODY_BYTES } from '@/lib/simplefin/client';
import { getConnection, listLinks, saveClaimedConnection } from '@/lib/simplefin/connection';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  vi.unstubAllGlobals();
});

const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';
const SETUP_TOKEN = Buffer.from('https://bridge.example/simplefin/claim/DEMO', 'utf8').toString('base64');

function setup() {
  current = createSeededTestDb();
  const admin = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' });
  const member = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  const accountId = insertTestAccount(current.db, { name: 'Joint Chequing' });
  return { adminToken: createSession(admin).token, memberToken: createSession(member).token, accountId };
}

function jsonRequest(url: string, body: unknown, token: string | null, origin = 'http://nas.local:3000') {
  return new Request(url, {
    method: 'POST',
    headers: {
      origin,
      host: 'nas.local:3000',
      'content-type': 'application/json',
      ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, token: string | null, origin = 'http://nas.local:3000') {
  return new Request(url, {
    method: 'GET',
    headers: {
      origin,
      host: 'nas.local:3000',
      ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
    },
  });
}

/**
 * A GET with neither Origin nor Sec-Fetch-Site — what a plain-HTTP LAN install
 * actually sends. Allowed on this read-only route by controller ruling; a
 * present-but-mismatched header is still refused.
 */
function headerlessGetRequest(url: string, token: string | null) {
  return new Request(url, {
    method: 'GET',
    headers: { host: 'nas.local:3000', ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}) },
  });
}

/** Fakes a POST Request whose json() throws if ever called, to prove the content-length cap short-circuits before it. */
function oversizedRequest(token: string | null): { request: Request; jsonSpy: ReturnType<typeof vi.fn> } {
  const jsonSpy = vi.fn(async () => {
    throw new Error('json() must not be called once content-length already exceeds the cap');
  });
  const request = {
    method: 'POST',
    headers: new Headers({
      origin: 'http://nas.local:3000',
      host: 'nas.local:3000',
      'content-length': String(MAX_SIMPLEFIN_BODY_BYTES + 1),
      ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
    }),
    json: jsonSpy,
  } as unknown as Request;
  return { request, jsonSpy };
}

describe('POST /api/simplefin/claim', () => {
  it('claims the token and never returns the access URL', async () => {
    const { adminToken } = setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(ACCESS_URL, { status: 200 })));

    const response = await claimRoute(jsonRequest('http://nas.local:3000/api/simplefin/claim', { setupToken: SETUP_TOKEN }, adminToken));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('s3cr3t');
    expect(body).not.toContain('bridge.example');
    expect(JSON.parse(body)).toMatchObject({ enabled: true });
    expect(getConnection()).not.toBeNull();
  });

  it('reports a spent token as a 4xx with a readable message', async () => {
    const { adminToken } = setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));
    const response = await claimRoute(jsonRequest('http://nas.local:3000/api/simplefin/claim', { setupToken: SETUP_TOKEN }, adminToken));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/only be claimed once/i);
  });

  it('403s a member, 401s an anonymous caller, 403s cross-origin', async () => {
    const { adminToken, memberToken } = setup();
    expect((await claimRoute(jsonRequest('http://nas.local:3000/api/simplefin/claim', { setupToken: SETUP_TOKEN }, memberToken))).status).toBe(403);
    expect((await claimRoute(jsonRequest('http://nas.local:3000/api/simplefin/claim', { setupToken: SETUP_TOKEN }, null))).status).toBe(401);
    expect(
      (await claimRoute(jsonRequest('http://nas.local:3000/api/simplefin/claim', { setupToken: SETUP_TOKEN }, adminToken, 'http://evil.local'))).status,
    ).toBe(403);
  });

  it('400s on a token that is not base64 of a URL', async () => {
    const { adminToken } = setup();
    const response = await claimRoute(
      jsonRequest('http://nas.local:3000/api/simplefin/claim', { setupToken: Buffer.from('hello').toString('base64') }, adminToken),
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/simplefin/link', () => {
  it('links an account and warns that CSV import is now disabled', async () => {
    const { adminToken, accountId } = setup();
    saveClaimedConnection(ACCESS_URL);
    const response = await linkRoute(
      jsonRequest('http://nas.local:3000/api/simplefin/link', { action: 'link', simplefinAccountId: 'remote-1', accountId, currency: 'CAD' }, adminToken),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.csvDisabled).toBe(true);
    expect(body.warning).toMatch(/CSV import is disabled/i);
    expect(body.currencyWarning).toBeNull();
    expect(listLinks()).toHaveLength(1);
  });

  it('warns about a non-CAD currency', async () => {
    const { adminToken, accountId } = setup();
    saveClaimedConnection(ACCESS_URL);
    const response = await linkRoute(
      jsonRequest('http://nas.local:3000/api/simplefin/link', { action: 'link', simplefinAccountId: 'remote-1', accountId, currency: 'usd' }, adminToken),
    );
    expect((await response.json()).currencyWarning).toMatch(/USD/);
  });

  it('unlinks and says CSV is restored', async () => {
    const { adminToken, accountId } = setup();
    saveClaimedConnection(ACCESS_URL);
    await linkRoute(
      jsonRequest('http://nas.local:3000/api/simplefin/link', { action: 'link', simplefinAccountId: 'remote-1', accountId, currency: 'CAD' }, adminToken),
    );
    const response = await linkRoute(
      jsonRequest('http://nas.local:3000/api/simplefin/link', { action: 'unlink', simplefinAccountId: 'remote-1' }, adminToken),
    );
    expect((await response.json()).csvRestored).toBe(true);
    expect(listLinks()).toHaveLength(0);
  });

  it('404s an unknown local account and 403s a member', async () => {
    const { adminToken, memberToken, accountId } = setup();
    saveClaimedConnection(ACCESS_URL);
    expect(
      (await linkRoute(jsonRequest('http://nas.local:3000/api/simplefin/link', { action: 'link', simplefinAccountId: 'r', accountId: 9999, currency: 'CAD' }, adminToken))).status,
    ).toBe(404);
    expect(
      (await linkRoute(jsonRequest('http://nas.local:3000/api/simplefin/link', { action: 'link', simplefinAccountId: 'r', accountId, currency: 'CAD' }, memberToken))).status,
    ).toBe(403);
  });
});

describe('POST /api/simplefin/sync', () => {
  it('409s when nothing is configured', async () => {
    const { adminToken } = setup();
    const response = await syncRoute(jsonRequest('http://nas.local:3000/api/simplefin/sync', {}, adminToken));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/no SimpleFIN connection/i);
  });

  it('syncs and returns the counts, errlist and remaining budget', async () => {
    const { adminToken, accountId } = setup();
    saveClaimedConnection(ACCESS_URL);
    await linkRoute(
      jsonRequest('http://nas.local:3000/api/simplefin/link', { action: 'link', simplefinAccountId: 'remote-1', accountId, currency: 'CAD' }, adminToken),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              accounts: [
                {
                  id: 'remote-1',
                  name: 'Bridge Chequing',
                  currency: 'CAD',
                  balance: '10.00',
                  transactions: [{ id: 't1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS' }],
                },
              ],
              errlist: ['Bank X needs attention'],
            }),
            { status: 200 },
          ),
      ),
    );

    const response = await syncRoute(jsonRequest('http://nas.local:3000/api/simplefin/sync', {}, adminToken));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalAdded).toBe(1);
    expect(body.errlist).toEqual(['Bank X needs attention']);
    expect(body.remainingRequests).toBe(19);
  });

  it('403s a member and 403s cross-origin', async () => {
    const { adminToken, memberToken } = setup();
    saveClaimedConnection(ACCESS_URL);
    expect((await syncRoute(jsonRequest('http://nas.local:3000/api/simplefin/sync', {}, memberToken))).status).toBe(403);
    expect((await syncRoute(jsonRequest('http://nas.local:3000/api/simplefin/sync', {}, adminToken, 'http://evil.local'))).status).toBe(403);
  });
});

describe('GET /api/simplefin/accounts', () => {
  it('403s cross-origin even for an authenticated admin (a GET makes the generic assertSameOrigin a no-op, so this route checks explicitly)', async () => {
    const { adminToken } = setup();
    saveClaimedConnection(ACCESS_URL);
    const response = await accountsRoute(getRequest('http://nas.local:3000/api/simplefin/accounts', adminToken, 'http://evil.local'));
    expect(response.status).toBe(403);
  });

  it('401s an anonymous caller and 403s a member', async () => {
    const { memberToken } = setup();
    expect((await accountsRoute(getRequest('http://nas.local:3000/api/simplefin/accounts', null))).status).toBe(401);
    expect((await accountsRoute(getRequest('http://nas.local:3000/api/simplefin/accounts', memberToken))).status).toBe(403);
  });

  it('serves a header-less GET (plain-HTTP LAN) with an admin session, and still enforces auth on one', async () => {
    const { adminToken, memberToken } = setup();
    saveClaimedConnection(ACCESS_URL);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accounts: [], errlist: [] }), { status: 200 })),
    );
    expect((await accountsRoute(headerlessGetRequest('http://nas.local:3000/api/simplefin/accounts', adminToken))).status).toBe(200);
    expect((await accountsRoute(headerlessGetRequest('http://nas.local:3000/api/simplefin/accounts', null))).status).toBe(401);
    expect((await accountsRoute(headerlessGetRequest('http://nas.local:3000/api/simplefin/accounts', memberToken))).status).toBe(403);
  });

  it('lists remote accounts and consumes a request against the budget on a same-origin admin call', async () => {
    const { adminToken } = setup();
    saveClaimedConnection(ACCESS_URL);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ accounts: [{ id: 'remote-1', name: 'Bridge Chequing', currency: 'CAD', balance: '10.00' }], errlist: [] }),
            { status: 200 },
          ),
      ),
    );
    const response = await accountsRoute(getRequest('http://nas.local:3000/api/simplefin/accounts', adminToken));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accounts).toEqual([{ id: 'remote-1', name: 'Bridge Chequing', currency: 'CAD', balance: '10.00' }]);
    expect(body.remainingRequests).toBe(19);
  });

  it('409s when nothing is configured', async () => {
    const { adminToken } = setup();
    const response = await accountsRoute(getRequest('http://nas.local:3000/api/simplefin/accounts', adminToken));
    expect(response.status).toBe(409);
  });
});

describe('pre-buffer content-length caps (house pattern — same authenticated-memory-DoS defence as the CSV/pack upload routes)', () => {
  it('claim route rejects an oversized body before json() is ever called', async () => {
    const { adminToken } = setup();
    const { request, jsonSpy } = oversizedRequest(adminToken);
    const response = await claimRoute(request);
    expect(response.status).toBe(413);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('link route rejects an oversized body before json() is ever called', async () => {
    const { adminToken } = setup();
    const { request, jsonSpy } = oversizedRequest(adminToken);
    const response = await linkRoute(request);
    expect(response.status).toBe(413);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('sync route rejects an oversized body (defensive — this route reads no body today, but stays consistent with its siblings)', async () => {
    const { adminToken } = setup();
    saveClaimedConnection(ACCESS_URL);
    const { request, jsonSpy } = oversizedRequest(adminToken);
    const response = await syncRoute(request);
    expect(response.status).toBe(413);
    expect(jsonSpy).not.toHaveBeenCalled();
  });
});
