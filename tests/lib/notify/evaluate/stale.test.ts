import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { DEFAULT_USER_SETTINGS, saveEmailTarget, saveSmtp, saveUserSettings, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateStaleImport } from '@/lib/notify/evaluate/stale';

let t: TestDb;
const TZ = 'UTC';

beforeEach(() => {
  t = createSeededTestDb();
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
  // stale_import defaults to OFF in the event registry (MUST-4.1: it is one of the chattier
  // informational events a person opts into), so an evaluator test needs it explicitly on.
  setPref(userId, 'stale_import', 'email', true);
  return userId;
}

function importAt(userId: number, createdAt: string): void {
  const accountId = insertTestAccount(t.db);
  t.db.run(
    sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
        values (${accountId}, null, ${'export.csv'}, ${userId}, 10, 0, 0, ${createdAt})`,
  );
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

describe('decision 10: an install with zero imports never fires', () => {
  it('says nothing before the household has anything to be stale about', () => {
    const userId = emailUser();
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});

describe('the N-week threshold', () => {
  it('is silent at N × 7 − 1 days and fires at N × 7', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-28T12:00:00.000Z'); // 20 days before 2026-08-17
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(1);
  });

  it('honours a different staleImportWeeks', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 1 });
    importAt(userId, '2026-08-10T12:00:00.000Z');
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(1);
  });
});

describe('MUST-3.11: one message per calendar week while stale', () => {
  it('dedupes within a week and fires again the following week', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-01T12:00:00.000Z');
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(1); // Monday
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-19T12:00:00Z'), tz: TZ })).toBe(0); // Wednesday
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-24T12:00:00Z'), tz: TZ })).toBe(1); // next Monday
    expect(keys()).toEqual(['stale:2026-08-17', 'stale:2026-08-24']);
  });
});

describe('MUST-14.8: any imports row resets the clock, including a SimpleFIN sync', () => {
  it('a recent import silences the event', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-01T12:00:00.000Z');
    importAt(userId, '2026-08-16T12:00:00.000Z');
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
  });
});

describe('the body', () => {
  it('names the last import date and the days since', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-27T12:00:00.000Z');
    evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ });
    const row = t.sqlite.prepare('select subject, body from notification_outbox').get() as {
      subject: string;
      body: string;
    };
    expect(row.subject).toBe('No transactions imported in 3 weeks');
    expect(row.body).toContain('The last import was 2026-07-27 (21 days ago).');
  });
});
