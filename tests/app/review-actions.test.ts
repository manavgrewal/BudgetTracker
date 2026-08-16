import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

let currentUser = { id: 1, name: 'Alice', username: 'alice', role: 'admin' as const };

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { fixCategoryAction, markTransferAction } from '@/app/(app)/review/actions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  currentUser = { id: userId, name: 'Alice', username: 'alice', role: 'admin' };
  const accountId = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const addTxn = (description = 'TIM HORTONS') => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, -500, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, userId, accountId, addTxn };
}

describe('fixCategoryAction — missing input validation (finding 2)', () => {
  it('returns a clean error for a non-numeric transactionId instead of throwing', async () => {
    const { db, addTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    addTxn();
    await expect(
      fixCategoryAction({}, formData({ transactionId: 'not-a-number', categoryId: String(coffee) })),
    ).resolves.toMatchObject({ error: expect.any(String) });
  });

  it('returns a clean error for a well-formed but nonexistent transactionId instead of throwing', async () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    await expect(
      fixCategoryAction({}, formData({ transactionId: '999999', categoryId: String(coffee) })),
    ).resolves.toMatchObject({ error: expect.any(String) });
  });

  it('still sets a valid category on a real transaction', async () => {
    const { db, sqlite, addTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = addTxn();
    const result = await fixCategoryAction({}, formData({ transactionId: String(id), categoryId: String(coffee) }));
    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select category_id from transactions where id = ?').get(id) as { category_id: number };
    expect(row.category_id).toBe(coffee);
  });
});

describe('markTransferAction — missing input validation (finding 2)', () => {
  it('returns a clean error for a non-numeric transactionId instead of throwing', async () => {
    setup();
    await expect(markTransferAction({}, formData({ transactionId: 'nope' }))).resolves.toMatchObject({
      error: expect.any(String),
    });
  });

  it('returns a clean error for a well-formed but nonexistent transactionId instead of throwing', async () => {
    setup();
    await expect(markTransferAction({}, formData({ transactionId: '999999' }))).resolves.toMatchObject({
      error: expect.any(String),
    });
  });

  it('still marks a real transaction as a transfer', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    const result = await markTransferAction({}, formData({ transactionId: String(id) }));
    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number };
    expect(row.is_transfer).toBe(1);
  });
});
