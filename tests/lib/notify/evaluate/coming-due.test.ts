import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../../helpers/db';
import { saveEmailTarget, saveSmtp, saveTelegramTarget, saveUserSettings, DEFAULT_USER_SETTINGS } from '@/lib/notify/config';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { MAX_NEW_ROWS_PER_USER_PER_EVALUATION, evaluateComingDue } from '@/lib/notify/evaluate/coming-due';

let t: TestDb;
const NOW = new Date('2026-08-17T12:00:00Z');
const TZ = 'UTC';

beforeEach(() => {
  t = createTestDb();
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
  return userId;
}

function bothChannelsUser(): number {
  const userId = emailUser();
  saveTelegramTarget({ userId, destination: '5551234', botToken: '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx', enabled: true });
  return userId;
}

function typeId(kind: 'warranty' | 'subscription' | 'contract' | 'loan'): number {
  const row = t.db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values (${`${kind}-${Math.random().toString(36).slice(2, 8)}`}, ${kind === 'subscription' ? 1 : 0}, ${kind}, ${'2026-01-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function item(over: {
  ownerUserId: number;
  name?: string;
  expiryDate?: string | null;
  isLifetime?: boolean;
  kind?: 'warranty' | 'subscription' | 'contract' | 'loan';
  vendor?: string | null;
  priceCents?: number | null;
}): number {
  // warranty_items CHECK constraints (drizzle/0002_warranty_tracker.sql) require:
  //   is_lifetime = 0 OR (warranty_months IS NULL AND expiry_date IS NULL)
  //   (warranty_months IS NULL) = (expiry_date IS NULL)
  // A lifetime item can therefore never carry an expiry_date; a non-lifetime item with an
  // expiry_date needs a paired, positive warranty_months. Neither is part of what this
  // evaluator reads, so a fixed 12 satisfies the CHECK without affecting any assertion.
  const isLifetime = over.isLifetime ?? false;
  const expiryDate = isLifetime ? null : (over.expiryDate ?? null);
  const warrantyMonths = expiryDate === null ? null : 12;
  const row = t.db.get<{ id: number }>(
    sql`insert into warranty_items
          (name, vendor, purchase_date, warranty_months, is_lifetime, expiry_date, price_cents, owner_user_id, type_id, created_at, updated_at)
        values (${over.name ?? 'Dishwasher'}, ${over.vendor ?? null}, ${'2024-01-01'}, ${warrantyMonths},
                ${isLifetime ? 1 : 0}, ${expiryDate}, ${over.priceCents ?? null},
                ${over.ownerUserId}, ${typeId(over.kind ?? 'warranty')}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function queued(): { dedup_key: string; subject: string }[] {
  return t.sqlite
    .prepare(`select dedup_key, subject from notification_outbox order by id`)
    .all() as { dedup_key: string; subject: string }[];
}

describe('MUST-6.10: the window', () => {
  it('includes exactly today and exactly today + N, and excludes today + N + 1', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, comingDueDays: 14 });
    item({ ownerUserId: userId, name: 'Today', expiryDate: '2026-08-17' });
    item({ ownerUserId: userId, name: 'Edge', expiryDate: '2026-08-31' });
    item({ ownerUserId: userId, name: 'Beyond', expiryDate: '2026-09-01' });
    item({ ownerUserId: userId, name: 'Past', expiryDate: '2026-08-16' });

    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(2);
    expect(queued().map((r) => r.subject).sort()).toEqual(['Coming due: Edge', 'Coming due: Today']);
  });

  it('never fires for a lifetime item or an item with no expiry date', () => {
    const userId = emailUser();
    item({ ownerUserId: userId, name: 'Lifetime', expiryDate: '2026-08-20', isLifetime: true });
    item({ ownerUserId: userId, name: 'Open', expiryDate: null });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(queued()).toHaveLength(0);
  });

  it('honours the user’s own comingDueDays', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, comingDueDays: 3 });
    item({ ownerUserId: userId, name: 'Soon', expiryDate: '2026-08-20' });
    item({ ownerUserId: userId, name: 'Later', expiryDate: '2026-08-21' });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
  });
});

describe('MUST-6.11: only the item’s owner is notified', () => {
  it('ignores another member’s items', () => {
    const mine = emailUser();
    const theirs = emailUser();
    item({ ownerUserId: theirs, name: 'Theirs', expiryDate: '2026-08-20' });
    expect(evaluateComingDue({ userId: mine, now: NOW, tz: TZ })).toBe(0);
    expect(evaluateComingDue({ userId: theirs, now: NOW, tz: TZ })).toBe(1);
  });
});

describe('MUST-6.12: announced once ever, per item and expiry date', () => {
  it('a second evaluation of the same slot enqueues nothing', () => {
    const userId = emailUser();
    item({ ownerUserId: userId, expiryDate: '2026-08-20' });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(0);
    expect(queued()).toHaveLength(1);
  });

  it('editing the expiry date produces a second, correctly-keyed message', () => {
    const userId = emailUser();
    const id = item({ ownerUserId: userId, expiryDate: '2026-08-20' });
    evaluateComingDue({ userId, now: NOW, tz: TZ });
    t.db.run(sql`update warranty_items set expiry_date = ${'2026-08-25'} where id = ${id}`);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(queued().map((r) => r.dedup_key)).toEqual([`due:${id}:2026-08-20`, `due:${id}:2026-08-25`]);
  });
});

describe('MUST-6.13: the flood guard', () => {
  it('caps a single evaluation at 20 new rows and picks the rest up next slot', () => {
    const userId = emailUser();
    for (let i = 0; i < 25; i += 1) item({ ownerUserId: userId, name: `Item ${i}`, expiryDate: '2026-08-20' });
    expect(MAX_NEW_ROWS_PER_USER_PER_EVALUATION).toBe(20);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(20);
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(5);
    expect(queued()).toHaveLength(25);
  });

  it('counts ROWS, not items: a user with both channels enabled hits the cap at 10 items (20 rows)', () => {
    const userId = bothChannelsUser();
    for (let i = 0; i < 25; i += 1) item({ ownerUserId: userId, name: `Item ${i}`, expiryDate: '2026-08-20' });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(20);
    // 10 items × 2 channels = 20 rows; the 11th item's pair is left for the next slot.
    expect(queued()).toHaveLength(20);
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(20);
    // The remaining 15 items × 2 channels = 30 rows; capped again at 20.
    expect(queued()).toHaveLength(40);
    expect(evaluateComingDue({ userId, now: new Date('2026-08-19T12:00:00Z'), tz: TZ })).toBe(10);
    expect(queued()).toHaveLength(50);
  });
});

describe('MUST-6.14: the verb comes from the item’s kind', () => {
  it('a loan says "paid off by" and a subscription "cancel by"', () => {
    const userId = emailUser();
    item({ ownerUserId: userId, name: 'Car loan', expiryDate: '2026-08-20', kind: 'loan' });
    item({ ownerUserId: userId, name: 'Netflix', expiryDate: '2026-08-21', kind: 'subscription' });
    evaluateComingDue({ userId, now: NOW, tz: TZ });
    const bodies = (t.sqlite.prepare('select body from notification_outbox order by id').all() as { body: string }[]).map(
      (r) => r.body,
    );
    expect(bodies[0]).toContain('paid off by');
    expect(bodies[1]).toContain('cancel by');
  });

  it('includes the vendor and the price when they are set', () => {
    const userId = emailUser();
    item({ ownerUserId: userId, name: 'Fridge', expiryDate: '2026-08-20', vendor: 'Costco', priceCents: 129999 });
    evaluateComingDue({ userId, now: NOW, tz: TZ });
    const row = t.sqlite.prepare('select body from notification_outbox').get() as { body: string };
    expect(row.body).toContain('Costco');
    expect(row.body).toContain('$1,299.99');
  });
});
