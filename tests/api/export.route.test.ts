import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/reports/export/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { nowIso } from '@/lib/clock';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const account = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const groceries = categoryIdByName(current.db, 'Groceries');
  current.db.run(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
    values (${account}, '2026-03-05', 'LOBLAWS #1042', 'LOBLAWS', -12345, ${groceries}, 'manual', 0, ${alice}, ${alice}, ${nowIso()}, ${nowIso()})`);
  return { token: createSession(alice).token };
}

/** Same-origin by default; the CSV route refuses anything else (m1). */
function exportRequest(url: string, token: string | null, origin: string | null = 'http://nas.local:3000') {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  if (origin) headers.origin = origin;
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new Request(url, { headers });
}

describe('GET /api/reports/export', () => {
  it('streams a CSV attachment for an authenticated user', async () => {
    const { token } = setup();
    const response = await GET(exportRequest('http://nas.local:3000/api/reports/export?from=2026-03-01&to=2026-03-31', token));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="budget-transactions-');
    const body = await response.text();
    expect(body.split('\r\n')[0]).toBe('Date,Account,Description,Merchant,Amount,Category,Person,Transfer,Source,Notes');
    expect(body).toContain('-123.45');
    expect(body).toContain('Alice');
  });

  it('applies the query filters', async () => {
    const { token } = setup();
    const response = await GET(exportRequest('http://nas.local:3000/api/reports/export?from=2026-04-01&to=2026-04-30', token));
    const body = await response.text();
    expect(body.trim().split('\r\n')).toHaveLength(1); // header only
  });

  it('401s without a session', async () => {
    setup();
    const response = await GET(exportRequest('http://nas.local:3000/api/reports/export', null));
    expect(response.status).toBe(401);
  });

  it('403s a cross-origin request even with a valid session cookie (m1)', async () => {
    // Same ruling as /api/backup/download: a GET is normally CSRF-exempt, but
    // this one streams every transaction in the household, so a forged
    // cross-origin request riding the session cookie must be refused.
    const { token } = setup();
    const response = await GET(
      exportRequest('http://nas.local:3000/api/reports/export?from=2026-03-01&to=2026-03-31', token, 'http://evil.example'),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('LOBLAWS');
  });

  it('403s before the session is even considered when the origin is wrong', async () => {
    setup();
    const response = await GET(exportRequest('http://nas.local:3000/api/reports/export', null, 'http://evil.example'));
    expect(response.status).toBe(403);
  });

  it('serves a header-less request — the plain-HTTP LAN default deployment', async () => {
    // Controller ruling: the Export CSV link on a plain-HTTP install sends
    // neither Origin nor Sec-Fetch-*, and refusing that would break the
    // feature on the documented default deployment. Auth still applies.
    const { token } = setup();
    const response = await GET(exportRequest('http://nas.local:3000/api/reports/export?from=2026-03-01&to=2026-03-31', token, null));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('LOBLAWS');
  });

  it('still 401s a header-less request with no session', async () => {
    setup();
    expect((await GET(exportRequest('http://nas.local:3000/api/reports/export', null, null))).status).toBe(401);
  });

  it('403s a header-less request that declares a cross-site fetch', async () => {
    const { token } = setup();
    const response = await GET(
      new Request('http://nas.local:3000/api/reports/export', {
        headers: { host: 'nas.local:3000', 'sec-fetch-site': 'cross-site', cookie: `${SESSION_COOKIE_NAME}=${token}` },
      }),
    );
    expect(response.status).toBe(403);
  });
});
