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

describe('GET /api/reports/export', () => {
  it('streams a CSV attachment for an authenticated user', async () => {
    const { token } = setup();
    const response = await GET(
      new Request('http://nas.local:3000/api/reports/export?from=2026-03-01&to=2026-03-31', {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      }),
    );
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
    const response = await GET(
      new Request('http://nas.local:3000/api/reports/export?from=2026-04-01&to=2026-04-30', {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      }),
    );
    const body = await response.text();
    expect(body.trim().split('\r\n')).toHaveLength(1); // header only
  });

  it('401s without a session', async () => {
    setup();
    const response = await GET(new Request('http://nas.local:3000/api/reports/export'));
    expect(response.status).toBe(401);
  });
});
