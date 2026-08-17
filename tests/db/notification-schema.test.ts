import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
});

const now = '2026-08-17T12:00:00.000Z';

function insertSmtp(id = 1): void {
  t.sqlite
    .prepare(
      `insert into notification_smtp
         (id, preset, host, port, security, username, password_encrypted, from_email, from_name, created_at, updated_at)
       values (?, 'brevo', 'smtp-relay.brevo.com', 587, 'starttls', 'me@example.com', 'ZW5j', 'me@example.com', 'Budget Tracker', ?, ?)`,
    )
    .run(id, now, now);
}

describe('MUST-3.2: the journal entry', () => {
  it('records idx 6 / when 1755734400000 / tag 0006_notifications', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 6);
    expect(entry).toEqual({ idx: 6, version: '6', when: 1755734400000, tag: '0006_notifications', breakpoints: true });
    // Append-only: 0005 keeps its slot (MUST-3.2a).
    expect(journal.entries.find((e) => e.idx === 5)?.tag).toBe('0005_billing_cycle');
  });
});

describe('AC6 / MUST-3.3: the breakpoint marker never appears inside a comment', () => {
  it('every occurrence is a statement separator', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0006_notifications.sql'), 'utf8');
    const marker = ['-->', 'statement-breakpoint'].join(' ');
    const total = sqlText.split(marker).length - 1;
    const withoutComments = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--') || line.trimStart().startsWith(marker))
      .join('\n');
    expect(withoutComments.split(marker).length - 1).toBe(total);
    expect(total).toBeGreaterThan(0);
  });
});

describe('MUST-3.13: the tables and indexes exist after migration', () => {
  it('creates all five tables', () => {
    const names = t.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name like 'notification_%' order by name`)
      .all() as { name: string }[];
    expect(names.map((r) => r.name)).toEqual([
      'notification_outbox',
      'notification_prefs',
      'notification_smtp',
      'notification_targets',
      'notification_user_settings',
    ]);
  });

  it('creates all four named indexes', () => {
    const names = t.sqlite
      .prepare(`select name from sqlite_master where type = 'index' and name like 'notification_%' order by name`)
      .all() as { name: string }[];
    expect(names.map((r) => r.name)).toEqual([
      'notification_outbox_dedup_uq',
      'notification_outbox_due_idx',
      'notification_outbox_user_idx',
      'notification_targets_user_channel_uq',
    ]);
  });

  it('stores notification_prefs WITHOUT ROWID', () => {
    const row = t.sqlite
      .prepare(`select sql from sqlite_master where type = 'table' and name = 'notification_prefs'`)
      .get() as { sql: string };
    expect(row.sql).toMatch(/WITHOUT ROWID/i);
  });

  it('leaves every table empty (MUST-1.1)', () => {
    for (const table of [
      'notification_smtp',
      'notification_targets',
      'notification_prefs',
      'notification_user_settings',
      'notification_outbox',
    ]) {
      const { n } = t.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number };
      expect(n).toBe(0);
    }
  });
});

describe('MUST-3.2 / §3.2: notification_smtp is a SQL-enforced singleton', () => {
  it('accepts id = 1 and rejects a second row', () => {
    insertSmtp(1);
    expect(() => insertSmtp(2)).toThrowError(/CHECK constraint failed/i);
    expect(() => insertSmtp(1)).toThrowError(/UNIQUE constraint failed/i);
  });

  it('rejects an unknown preset, an out-of-range port and an unknown security value', () => {
    expect(() =>
      t.sqlite
        .prepare(
          `insert into notification_smtp (id, preset, host, port, security, username, password_encrypted, from_email, created_at, updated_at)
           values (1, 'mailgun', 'h', 587, 'starttls', 'u', 'p', 'f@e.com', ?, ?)`,
        )
        .run(now, now),
    ).toThrowError(/CHECK constraint failed/i);
    expect(() =>
      t.sqlite
        .prepare(
          `insert into notification_smtp (id, preset, host, port, security, username, password_encrypted, from_email, created_at, updated_at)
           values (1, 'custom', 'h', 70000, 'starttls', 'u', 'p', 'f@e.com', ?, ?)`,
        )
        .run(now, now),
    ).toThrowError(/CHECK constraint failed/i);
    expect(() =>
      t.sqlite
        .prepare(
          `insert into notification_smtp (id, preset, host, port, security, username, password_encrypted, from_email, created_at, updated_at)
           values (1, 'custom', 'h', 587, 'ssl', 'u', 'p', 'f@e.com', ?, ?)`,
        )
        .run(now, now),
    ).toThrowError(/CHECK constraint failed/i);
  });
});

describe('§3.3: notification_targets pairing and uniqueness', () => {
  function insertTarget(userId: number, channel: string, secret: string | null): void {
    t.sqlite
      .prepare(
        `insert into notification_targets (user_id, channel, destination, secret_encrypted, created_at, updated_at)
         values (?, ?, 'dest', ?, ?, ?)`,
      )
      .run(userId, channel, secret, now, now);
  }

  it('rejects a telegram target with no secret and an email target with one', () => {
    const userId = insertTestUser(t.db);
    expect(() => insertTarget(userId, 'telegram', null)).toThrowError(/CHECK constraint failed/i);
    expect(() => insertTarget(userId, 'email', 'ZW5j')).toThrowError(/CHECK constraint failed/i);
    insertTarget(userId, 'telegram', 'ZW5j');
    insertTarget(userId, 'email', null);
  });

  it('rejects a duplicate (user_id, channel)', () => {
    const userId = insertTestUser(t.db);
    insertTarget(userId, 'telegram', 'ZW5j');
    expect(() => insertTarget(userId, 'telegram', 'ZW5j')).toThrowError(/UNIQUE constraint failed/i);
  });

  it('rejects an unknown channel', () => {
    const userId = insertTestUser(t.db);
    expect(() => insertTarget(userId, 'sms', null)).toThrowError(/CHECK constraint failed/i);
  });
});

describe('MUST-3.6: notification_prefs.event_id has no CHECK and no FK', () => {
  it('accepts an event_id that is not in the registry — the extension-point guarantee', () => {
    const userId = insertTestUser(t.db);
    t.sqlite
      .prepare(`insert into notification_prefs (user_id, event_id, channel, enabled) values (?, 'on_pace_overshoot', 'email', 1)`)
      .run(userId);
    const { n } = t.sqlite.prepare(`select count(*) as n from notification_prefs`).get() as { n: number };
    expect(n).toBe(1);
  });
});

describe('§3.5: every knob CHECK rejects 0 and the upper bound + 1', () => {
  const bounds: [string, number, number][] = [
    ['coming_due_days', 1, 365],
    ['budget_threshold_pct', 1, 99],
    ['stale_import_weeks', 1, 52],
    ['daily_hour', 0, 23],
    ['digest_weekday', 0, 6],
    ['digest_hour', 0, 23],
  ];

  for (const [column, low, high] of bounds) {
    it(`${column} accepts ${low} and ${high} but rejects ${low - 1} and ${high + 1}`, () => {
      const userId = insertTestUser(t.db);
      const write = (value: number) =>
        t.sqlite
          .prepare(
            `insert or replace into notification_user_settings (user_id, ${column}, created_at, updated_at) values (?, ?, ?, ?)`,
          )
          .run(userId, value, now, now);
      write(low);
      write(high);
      expect(() => write(low - 1)).toThrowError(/CHECK constraint failed/i);
      expect(() => write(high + 1)).toThrowError(/CHECK constraint failed/i);
    });
  }

  it('applies every documented default for an otherwise-empty row', () => {
    const userId = insertTestUser(t.db);
    t.sqlite
      .prepare(`insert into notification_user_settings (user_id, created_at, updated_at) values (?, ?, ?)`)
      .run(userId, now, now);
    const row = t.sqlite.prepare(`select * from notification_user_settings where user_id = ?`).get(userId) as Record<string, number>;
    expect(row.coming_due_days).toBe(14);
    expect(row.budget_threshold_pct).toBe(80);
    expect(row.stale_import_weeks).toBe(3);
    expect(row.daily_hour).toBe(8);
    expect(row.digest_weekday).toBe(1);
    expect(row.digest_hour).toBe(8);
  });
});

describe('MUST-3.9: the outbox dedup index', () => {
  function insertRow(userId: number, channel: string, dedupKey: string): number {
    const info = t.sqlite
      .prepare(
        `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, next_attempt_at, created_at)
         values (?, ?, 'coming_due', ?, 's', 'b', ?, ?) on conflict do nothing`,
      )
      .run(userId, channel, dedupKey, now, now);
    return info.changes;
  }

  it('reports changes === 0 for a duplicate (user, channel, dedup_key)', () => {
    const userId = insertTestUser(t.db);
    expect(insertRow(userId, 'telegram', 'due:1:2026-09-01')).toBe(1);
    expect(insertRow(userId, 'telegram', 'due:1:2026-09-01')).toBe(0);
    // Same key on the other channel is a different row.
    expect(insertRow(userId, 'email', 'due:1:2026-09-01')).toBe(1);
  });

  it('rejects an unknown status', () => {
    const userId = insertTestUser(t.db);
    expect(() =>
      t.sqlite
        .prepare(
          `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, status, next_attempt_at, created_at)
           values (?, 'email', 'coming_due', 'k', 's', 'b', 'queued', ?, ?)`,
        )
        .run(userId, now, now),
    ).toThrowError(/CHECK constraint failed/i);
  });
});

describe('§3: deleting a user cascades every child table', () => {
  it('removes targets, prefs, settings and outbox rows', () => {
    const userId = insertTestUser(t.db);
    t.sqlite
      .prepare(
        `insert into notification_targets (user_id, channel, destination, secret_encrypted, created_at, updated_at)
         values (?, 'email', 'a@b.com', null, ?, ?)`,
      )
      .run(userId, now, now);
    t.sqlite.prepare(`insert into notification_prefs (user_id, event_id, channel, enabled) values (?, 'coming_due', 'email', 1)`).run(userId);
    t.sqlite.prepare(`insert into notification_user_settings (user_id, created_at, updated_at) values (?, ?, ?)`).run(userId, now, now);
    t.sqlite
      .prepare(
        `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, next_attempt_at, created_at)
         values (?, 'email', 'coming_due', 'k', 's', 'b', ?, ?)`,
      )
      .run(userId, now, now);

    t.db.run(sql`delete from users where id = ${userId}`);

    for (const table of ['notification_targets', 'notification_prefs', 'notification_user_settings', 'notification_outbox']) {
      const { n } = t.sqlite.prepare(`select count(*) as n from ${table} where user_id = ?`).get(userId) as { n: number };
      expect(n).toBe(0);
    }
  });
});
