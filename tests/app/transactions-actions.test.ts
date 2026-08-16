import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
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

import { saveNoteAction, setAttributionAction } from '@/app/(app)/transactions/actions';

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

describe('setAttributionAction — missing input validation (finding 2)', () => {
  it('rejects a non-numeric attributedUserId instead of writing NaN', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    const result = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: 'not-a-number' }));
    expect(result.error).toBeTruthy();
    const row = sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null };
    expect(row.a).not.toBeNaN();
    // Untouched by the rejected write — still whatever it started as (null here).
    expect(row.a).toBeNull();
  });

  it('still accepts a real user id and an empty selection meaning household/unattributed', async () => {
    const { userId, sqlite, addTxn } = setup();
    const id = addTxn();
    const attributed = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: String(userId) }));
    expect(attributed.message).toBeTruthy();
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null }).a).toBe(userId);

    const cleared = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: '' }));
    expect(cleared.message).toBeTruthy();
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null }).a).toBeNull();
  });
});

describe('saveNoteAction — missing input validation (finding 2)', () => {
  it('returns an error for a non-numeric transactionId instead of a silent no-op success', async () => {
    setup();
    const result = await saveNoteAction({}, formData({ transactionId: 'nope', notes: 'hi' }));
    expect(result.error).toBeTruthy();
  });

  it('returns an error when the transaction does not exist instead of claiming success', async () => {
    setup();
    const result = await saveNoteAction({}, formData({ transactionId: '999999', notes: 'hi' }));
    expect(result.error).toBeTruthy();
  });

  it('saves the note for a real transaction', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    const result = await saveNoteAction({}, formData({ transactionId: String(id), notes: 'split with Bob' }));
    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select notes from transactions where id = ?').get(id) as { notes: string | null };
    expect(row.notes).toBe('split with Bob');
  });
});
