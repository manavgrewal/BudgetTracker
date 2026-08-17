import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { upsertBudget } from '@/lib/budgets';
import { saveEmailTarget, saveSmtp, saveTelegramTarget, getTarget, removeTarget, setPref } from '@/lib/notify/config';
import { evaluateBudgets, resetBudgetFingerprintForTests } from '@/lib/notify/evaluate/budget';
import {
  CHANNEL_REMOVED_ERROR,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  listRecentDeliveries,
  pumpOutbox,
  resetOutboxPumpForTests,
} from '@/lib/notify/outbox';
import { NotifyError, resetNotifySenderForTests, setNotifySenderForTests, type DeliveryRequest } from '@/lib/notify/send';

const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';
const TZ = 'UTC';

let t: TestDb;
let accountId: number;
let userId: number;
let sent: DeliveryRequest[];
let telegramFails: NotifyError | null;

function install(): void {
  setNotifySenderForTests(async (request) => {
    if (request.channel === 'telegram' && telegramFails) throw telegramFails;
    sent.push(request);
  });
}

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  sent = [];
  telegramFails = null;
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  install();

  userId = insertTestUser(t.db, { role: 'admin', username: 'sam', name: 'Sam' });
  saveSmtp({
    preset: 'brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'me@example.com',
    password: 'pw',
    fromEmail: 'me@example.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
  setPref(userId, 'budget_threshold', 'telegram', true);
  setPref(userId, 'budget_threshold', 'email', true);
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  t.cleanup();
});

function spend(categoryId: number, cents: number, date: string): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, categorization_source, created_by, dedup_hash, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${'LOBLAWS'}, ${'loblaws'}, ${categoryId},
                null, 0, ${'manual'}, ${userId}, ${`h${Math.random()}`}, ${`${date}T00:00:00.000Z`}, ${`${date}T00:00:00.000Z`})`,
  );
}

function statuses(): { channel: string; status: string; last_error: string | null }[] {
  return t.sqlite.prepare('select channel, status, last_error from notification_outbox order by id').all() as never;
}

it('§17.6: the whole flow, end to end', async () => {
  const groceries = categoryIdByName(t.db, 'Groceries');
  upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });

  // --- Push Groceries past 80%, tick: two rows, one per channel, both sent.
  spend(groceries, 41000, '2026-08-05');
  evaluateBudgets({ now: new Date('2026-08-17T12:00:00Z'), tz: TZ });
  expect(await pumpOutbox(new Date('2026-08-17T12:00:05Z'))).toEqual({ sent: 2, failed: 0, deferred: 0 });
  expect(sent.map((r) => r.channel).sort()).toEqual(['email', 'telegram']);
  expect(statuses().every((r) => r.status === 'sent')).toBe(true);

  // --- Tick again: nothing new.
  resetBudgetFingerprintForTests();
  evaluateBudgets({ now: new Date('2026-08-17T12:05:00Z'), tz: TZ });
  expect(await pumpOutbox(new Date('2026-08-17T12:05:05Z'))).toEqual({ sent: 0, failed: 0, deferred: 0 });
  expect(statuses()).toHaveLength(2);

  // --- Push past 100%: one more pair.
  sent = [];
  resetBudgetFingerprintForTests();
  spend(groceries, 15000, '2026-08-06');
  evaluateBudgets({ now: new Date('2026-08-17T12:10:00Z'), tz: TZ });
  await pumpOutbox(new Date('2026-08-17T12:10:05Z'));
  expect(sent.map((r) => r.channel).sort()).toEqual(['email', 'telegram']);
  expect(statuses()).toHaveLength(4);

  // --- Advance a month: the same category fires again for the new month.
  sent = [];
  resetBudgetFingerprintForTests();
  upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-09', amountCents: 50000 });
  spend(groceries, 60000, '2026-09-03');
  evaluateBudgets({ now: new Date('2026-09-17T12:00:00Z'), tz: TZ });
  await pumpOutbox(new Date('2026-09-17T12:00:05Z'));
  expect(sent.length).toBeGreaterThan(0);

  // --- Telegram throws transiently, email succeeds: per-channel isolation.
  sent = [];
  resetBudgetFingerprintForTests();
  telegramFails = new NotifyError('bot api unreachable', { permanent: false });
  upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-10', amountCents: 50000 });
  spend(groceries, 60000, '2026-10-03');
  evaluateBudgets({ now: new Date('2026-10-17T12:00:00Z'), tz: TZ });
  const mixed = await pumpOutbox(new Date('2026-10-17T12:00:05Z'));
  expect(mixed.sent).toBeGreaterThan(0);
  expect(sent.every((r) => r.channel === 'email')).toBe(true);
  expect(getTarget(userId, 'telegram')?.lastError).toBe('bot api unreachable');
  expect(getTarget(userId, 'email')?.lastError).toBeNull();

  // --- Exhaust the attempts: the Telegram rows go failed and show in the deliveries list.
  let clock = new Date('2026-10-17T12:00:05Z').getTime();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    clock += MAX_BACKOFF_MS;
    await pumpOutbox(new Date(clock));
  }
  const telegramRows = statuses().filter((r) => r.channel === 'telegram');
  expect(telegramRows.some((r) => r.status === 'failed')).toBe(true);
  expect(listRecentDeliveries({ userId }).some((row) => row.status === 'failed')).toBe(true);

  // --- Remove the Telegram target with rows still pending: they resolve to the removal
  //     message and the sender records ZERO further calls (MUST-7.5, MUST-1.1).
  telegramFails = null;
  resetBudgetFingerprintForTests();
  upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-11', amountCents: 50000 });
  spend(groceries, 60000, '2026-11-03');
  evaluateBudgets({ now: new Date('2026-11-17T12:00:00Z'), tz: TZ });
  removeTarget(userId, 'telegram');
  sent = [];
  clock = new Date('2026-11-17T12:00:05Z').getTime() + MAX_BACKOFF_MS;
  await pumpOutbox(new Date(clock));
  expect(sent.every((r) => r.channel === 'email')).toBe(true);
  const removed = statuses().filter((r) => r.channel === 'telegram' && r.last_error === CHANNEL_REMOVED_ERROR);
  expect(removed.length).toBeGreaterThan(0);
});
