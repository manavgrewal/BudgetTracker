import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import {
  DEFAULT_BACKUP_RETENTION,
  backupsDir,
  createOnDemandBackup,
  getBackupRetention,
  listBackups,
  nightlyBackupName,
  pruneBackups,
  runMaintenanceSweep,
  runNightlyBackup,
  runNightlyJob,
  setBackupRetention,
  tempDir,
} from '@/lib/backup';
import { createSession } from '@/lib/auth/session';
import { recordLoginAttempt } from '@/lib/auth/ratelimit';
import { writeStagedFile, stagedFilePath } from '@/lib/import/staging';
import { nowIso } from '@/lib/clock';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-backup-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  // The backup routines read the live database path from the client module.
  process.env.BUDGET_DB_PATH = current.path;
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
  else process.env.BUDGET_DB_PATH = originalDbPath;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('nightly backup', () => {
  it('writes budget-YYYY-MM-DD.tar.gz under DATA_DIR/backups', () => {
    const at = new Date('2026-08-15T06:00:00.000Z'); // 02:00 in Toronto
    const backup = runNightlyBackup(at);
    expect(backupsDir()).toBe(path.join(dataDir, 'backups'));
    expect(nightlyBackupName(at, 'America/Toronto')).toBe('budget-2026-08-15.tar.gz');
    expect(backup.name).toBe('budget-2026-08-15.tar.gz');
    expect(fs.existsSync(backup.path)).toBe(true);
    expect(backup.bytes).toBeGreaterThan(0);
  });

  it('produces a readable gzip archive containing the data', () => {
    // The artifact is now a .tar.gz, not a bare SQLite file: better-sqlite3 can no longer
    // open it directly, so the check is the gzip magic header (0x1f 0x8b).
    runNightlyBackup(new Date('2026-08-15T06:00:00.000Z'));
    const backup = runNightlyBackup(new Date('2026-08-15T06:00:00.000Z'));
    expect(fs.readFileSync(backup.path).subarray(0, 2).toJSON().data).toEqual([0x1f, 0x8b]);
  });

  it('overwrites an existing file for the same day (a stale target must not fail the backup)', () => {
    const at = new Date('2026-08-15T06:00:00.000Z');
    const first = runNightlyBackup(at);
    fs.writeFileSync(first.path, 'not an archive');
    expect(() => runNightlyBackup(at)).not.toThrow();
    const second = runNightlyBackup(at);
    expect(second.bytes).toBeGreaterThan(100);
    expect(fs.readFileSync(second.path).subarray(0, 2).toJSON().data).toEqual([0x1f, 0x8b]);
  });

  it('creates the backups directory if it is missing', () => {
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false);
    runNightlyBackup(new Date('2026-08-15T06:00:00.000Z'));
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(true);
  });

  it('always produces a filename matching the safe nightly pattern, even across timezones', () => {
    // Ruling (b): the only inputs to the on-disk name are the server clock and the
    // configured TZ — never a settings value — so the filename is always this shape.
    const name = nightlyBackupName(new Date('2026-08-15T06:00:00.000Z'), 'Pacific/Kiritimati');
    expect(name).toMatch(/^budget-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });
});

describe('retention', () => {
  function fakeBackup(name: string, minutesAgo: number) {
    fs.mkdirSync(backupsDir(), { recursive: true });
    const file = path.join(backupsDir(), name);
    fs.writeFileSync(file, 'x');
    const when = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(file, when, when);
  }

  it('defaults to keeping 14 and is configurable', () => {
    expect(DEFAULT_BACKUP_RETENTION).toBe(14);
    expect(getBackupRetention()).toBe(14);
    setBackupRetention(3);
    expect(getBackupRetention()).toBe(3);
  });

  it('keeps the most recent N and deletes the rest', () => {
    for (let i = 0; i < 6; i += 1) fakeBackup(`budget-2026-08-${String(10 + i).padStart(2, '0')}.tar.gz`, (6 - i) * 60);
    setBackupRetention(3);
    const deleted = pruneBackups();
    expect(deleted.sort()).toEqual(['budget-2026-08-10.tar.gz', 'budget-2026-08-11.tar.gz', 'budget-2026-08-12.tar.gz']);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.tar.gz', 'budget-2026-08-14.tar.gz', 'budget-2026-08-13.tar.gz']);
  });

  it('deletes nothing when the count is under the retention limit', () => {
    fakeBackup('budget-2026-08-15.tar.gz', 10);
    expect(pruneBackups(14)).toEqual([]);
  });

  it('ignores non-backup files in the directory', () => {
    fakeBackup('budget-2026-08-15.tar.gz', 10);
    fs.writeFileSync(path.join(backupsDir(), 'README.txt'), 'hello');
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.tar.gz']);
    expect(pruneBackups(0)).toEqual(['budget-2026-08-15.tar.gz']);
    expect(fs.existsSync(path.join(backupsDir(), 'README.txt'))).toBe(true);
  });

  it('ignores filenames shaped like a traversal attempt', () => {
    // Ruling (b): listBackups/pruneBackups only ever touch entries matching one of the
    // two strict patterns, so a rogue entry can never be read or deleted by them.
    fakeBackup('budget-2026-08-15.tar.gz', 10);
    fs.writeFileSync(path.join(backupsDir(), 'budget-2026-08-15.tar.gz.bak'), 'x');
    fs.writeFileSync(path.join(backupsDir(), '..budget-2026-08-15.tar.gz'), 'x');
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.tar.gz']);
  });

  it('lists nothing when the directory does not exist', () => {
    expect(listBackups()).toEqual([]);
    expect(pruneBackups()).toEqual([]);
  });

  it('keeps listing a v1.0.0 .db backup alongside the new archives (MUST-12.3)', () => {
    fakeBackup('budget-2026-08-15.tar.gz', 10);
    fakeBackup('budget-2026-08-14.db', 20);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.tar.gz', 'budget-2026-08-14.db']);
  });
});

describe('on-demand backup', () => {
  it('writes into DATA_DIR/tmp with a uuid name that cannot collide with the nightly files', () => {
    const result = createOnDemandBackup();
    expect(result.path.startsWith(tempDir())).toBe(true);
    expect(path.basename(result.path)).toMatch(/^[0-9a-f-]{36}\.tar\.gz$/);
    expect(result.path).not.toContain('backups');
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    fs.rmSync(result.path, { force: true });
  });
});

describe('maintenance sweep', () => {
  it('purges expired sessions, old login attempts and abandoned uploads', () => {
    const userId = insertTestUser(current!.db);
    createSession(userId, { at: new Date('2026-01-01T00:00:00.000Z') }); // expires 2026-01-31
    createSession(userId, { at: new Date('2026-08-10T00:00:00.000Z') }); // still valid
    recordLoginAttempt({ username: 'alice', ip: '10.0.0.5', success: false, at: new Date('2026-06-01T00:00:00.000Z') });
    recordLoginAttempt({ username: 'alice', ip: '10.0.0.5', success: false, at: new Date('2026-08-14T00:00:00.000Z') });

    const at = new Date('2026-08-15T02:00:00.000Z');
    const stale = writeStagedFile(Buffer.from('old'));
    // Anchored to `at`, not the real wall clock: purgeStagedFiles compares
    // mtime against the injected "now", so the fixture must too.
    const longAgo = new Date(at.getTime() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stagedFilePath(stale), longAgo, longAgo);

    const result = runMaintenanceSweep(at);
    expect(result).toEqual({
      sessionsPurged: 1,
      loginAttemptsPurged: 1,
      stagedFilesPurged: 1,
      receiptOrphansPurged: 0,
      preRestoreCopiesPurged: 0,
      outboxRowsPurged: 0,
    });
    expect((current!.sqlite.prepare('select count(*) as c from sessions').get() as { c: number }).c).toBe(1);
    expect((current!.sqlite.prepare('select count(*) as c from login_attempts').get() as { c: number }).c).toBe(1);
  });

  it('purges 31-day-old .pre-restore-* copies and restore-failed-*/, keeping the most recent of each (MUST-20.33)', () => {
    function fakeDated(name: string, isDir: boolean, daysAgo: number): void {
      const target = path.join(dataDir, name);
      if (isDir) fs.mkdirSync(target, { recursive: true });
      else fs.writeFileSync(target, 'x');
      const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      fs.utimesSync(target, when, when);
    }

    fakeDated('budget.pre-restore-recent.db', false, 35); // newest of its kind -> kept anyway
    fakeDated('budget.pre-restore-old.db', false, 400);
    fakeDated('budget.pre-restore-old.db-wal', false, 400);
    fakeDated('budget.pre-restore-old.db-shm', false, 400);
    fakeDated('receipts.pre-restore-recent', true, 35);
    fakeDated('receipts.pre-restore-old', true, 400);
    fakeDated('restore-failed-recent', true, 35);
    fakeDated('restore-failed-old', true, 400);

    const result = runMaintenanceSweep(new Date());
    expect(result.preRestoreCopiesPurged).toBe(3);
    expect(fs.existsSync(path.join(dataDir, 'budget.pre-restore-recent.db'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'budget.pre-restore-old.db'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'budget.pre-restore-old.db-wal'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'budget.pre-restore-old.db-shm'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'receipts.pre-restore-recent'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'receipts.pre-restore-old'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'restore-failed-recent'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'restore-failed-old'))).toBe(false);
  });
});

describe('runNightlyJob', () => {
  it('backs up, prunes and sweeps in one call', () => {
    const userId = insertTestUser(current!.db);
    createSession(userId, { at: new Date('2026-01-01T00:00:00.000Z') });
    current!.db.run(sql`insert into settings (key, value) values ('probe', ${nowIso()})`);

    const result = runNightlyJob(new Date('2026-08-15T06:00:00.000Z'));
    expect(result.backup.name).toBe('budget-2026-08-15.tar.gz');
    expect(fs.existsSync(result.backup.path)).toBe(true);
    expect(result.sweep.sessionsPurged).toBe(1);
    expect(Array.isArray(result.pruned)).toBe(true);
  });
});

describe('MUST-3.14: the sweep prunes delivered notifications', () => {
  it('reports outboxRowsPurged and leaves pending rows alone', () => {
    const userId = insertTestUser(current!.db);
    // MUST-3.12/R3: OUTBOX_RETENTION_DAYS is 400, comfortably past the maximum 365-day
    // comingDueDays window, so "old" here must be well past 400 days too.
    const old = '2025-01-01T00:00:00.000Z';
    const recent = '2026-08-17T00:00:00.000Z';
    const insert = (key: string, status: string, createdAt: string) =>
      current!.sqlite
        .prepare(
          `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, status, next_attempt_at, created_at)
           values (?, 'email', 'coming_due', ?, 's', 'b', ?, ?, ?)`,
        )
        .run(userId, key, status, createdAt, createdAt);
    insert('old-sent', 'sent', old);
    insert('old-failed', 'failed', old);
    insert('old-pending', 'pending', old);
    insert('new-sent', 'sent', recent);

    const result = runMaintenanceSweep(new Date('2026-08-17T12:00:00Z'));
    expect(result.outboxRowsPurged).toBe(2);
    const keys = (
      current!.sqlite.prepare('select dedup_key from notification_outbox order by dedup_key').all() as { dedup_key: string }[]
    ).map((r) => r.dedup_key);
    expect(keys).toEqual(['new-sent', 'old-pending']);
  });

  it('MUST-3.12/R3: keeps a 399-day-old sent row and purges a 401-day-old one', () => {
    const userId = insertTestUser(current!.db);
    const at = new Date('2026-08-17T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const at399 = new Date(at.getTime() - 399 * day).toISOString();
    const at401 = new Date(at.getTime() - 401 * day).toISOString();
    const insert = (key: string, createdAt: string) =>
      current!.sqlite
        .prepare(
          `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, status, next_attempt_at, created_at)
           values (?, 'email', 'coming_due', ?, 's', 'b', 'sent', ?, ?)`,
        )
        .run(userId, key, createdAt, createdAt);
    insert('399-old', at399);
    insert('401-old', at401);

    const result = runMaintenanceSweep(at);
    expect(result.outboxRowsPurged).toBe(1);
    const keys = (
      current!.sqlite.prepare('select dedup_key from notification_outbox order by dedup_key').all() as { dedup_key: string }[]
    ).map((r) => r.dedup_key);
    expect(keys).toEqual(['399-old']);
  });
});
