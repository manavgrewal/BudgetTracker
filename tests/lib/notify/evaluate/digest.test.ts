import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';

let t: TestDb;
let accountId: number;
let creatorId: number;
const NOW = new Date('2026-08-17T12:00:00Z');

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  // A fixed FK target for transactions.created_by (NOT NULL) — independent of
  // notification attribution, which each test controls via emailUser()/spend().
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function emailUser(): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  setPref(userId, 'weekly_digest', 'email', true); // default-off (MUST-4.1)
  return userId;
}

function spend(categoryId: number, cents: number, date: string, attributedUserId: number | null = null, merchant = 'LOBLAWS'): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${merchant}, ${merchant.toLowerCase()}, ${categoryId},
                ${attributedUserId}, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})`,
  );
}

function body(): string {
  const row = t.sqlite.prepare('select body from notification_outbox').get() as { body: string };
  return row.body;
}

describe('§10.2: the window is [slot − 7, slot − 1]', () => {
  it('includes the seven days ending the day before the slot and excludes the slot day itself', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    spend(groceries, 1000, '2026-08-10'); // in (slot − 7)
    spend(groceries, 2000, '2026-08-16'); // in (slot − 1)
    spend(groceries, 4000, '2026-08-17'); // the slot day — OUT
    spend(groceries, 8000, '2026-08-09'); // before the window — OUT

    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    const subject = (t.sqlite.prepare('select subject from notification_outbox').get() as { subject: string }).subject;
    expect(subject).toBe('Weekly summary — 2026-08-10 to 2026-08-16');
    expect(body()).toContain('Household spend: $30.00');
  });

  it('reports the recipient’s own attributed spend separately', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    spend(groceries, 1000, '2026-08-12', userId);
    spend(groceries, 3000, '2026-08-13', null);
    evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW });
    expect(body()).toContain('Household spend: $40.00');
    expect(body()).toContain('$10.00');
  });

  it('names the top categories and merchants', () => {
    const userId = emailUser();
    spend(categoryIdByName(t.db, 'Groceries'), 40211, '2026-08-12', null, 'LOBLAWS');
    spend(categoryIdByName(t.db, 'Gas'), 12100, '2026-08-13', null, 'PETRO-CANADA');
    evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW });
    expect(body()).toContain('Top categories (household)');
    expect(body()).toContain('Groceries');
    expect(body()).toContain('Top merchants (household)');
    // topMerchants() reports normalizedMerchant, which is stored lowercase — the
    // rendered body reflects the stored form, not the raw uppercase description.
    expect(body()).toContain('loblaws');
  });
});

describe('§10.2: an empty week still sends', () => {
  it('renders the empty sentence rather than staying silent', () => {
    const userId = emailUser();
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(body()).toContain('No transactions were recorded this week.');
  });
});

describe('MUST-3.11: once per weekly slot', () => {
  it('dedupes a second evaluation of the same slot and fires for the next one', () => {
    const userId = emailUser();
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(0);
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-24', now: new Date('2026-08-24T12:00:00Z') })).toBe(1);
    const keys = (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
      (r) => r.dedup_key,
    );
    expect(keys).toEqual(['digest:2026-08-17', 'digest:2026-08-24']);
  });
});
