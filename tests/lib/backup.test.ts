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
  it('writes budget-YYYY-MM-DD.db under DATA_DIR/backups', () => {
    const at = new Date('2026-08-15T06:00:00.000Z'); // 02:00 in Toronto
    const backup = runNightlyBackup(at);
    expect(backupsDir()).toBe(path.join(dataDir, 'backups'));
    expect(nightlyBackupName(at, 'America/Toronto')).toBe('budget-2026-08-15.db');
    expect(backup.name).toBe('budget-2026-08-15.db');
    expect(fs.existsSync(backup.path)).toBe(true);
    expect(backup.bytes).toBeGreaterThan(0);
  });

  it('produces a readable SQLite copy containing the data', async () => {
    const userId = insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const backup = runNightlyBackup(new Date('2026-08-15T06:00:00.000Z'));
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const copy = new BetterSqlite3(backup.path, { readonly: true });
    const row = copy.prepare('select name from users where id = ?').get(userId) as { name: string };
    expect(row.name).toBe('Alice');
    copy.close();
  });

  it('overwrites an existing file for the same day (VACUUM INTO errors otherwise)', () => {
    const at = new Date('2026-08-15T06:00:00.000Z');
    const first = runNightlyBackup(at);
    fs.writeFileSync(first.path, 'not a database');
    expect(() => runNightlyBackup(at)).not.toThrow();
    const second = runNightlyBackup(at);
    expect(second.bytes).toBeGreaterThan(100);
    expect(fs.readFileSync(second.path).subarray(0, 15).toString('utf8')).toBe('SQLite format 3');
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
    expect(name).toMatch(/^budget-\d{4}-\d{2}-\d{2}\.db$/);
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
    for (let i = 0; i < 6; i += 1) fakeBackup(`budget-2026-08-${String(10 + i).padStart(2, '0')}.db`, (6 - i) * 60);
    setBackupRetention(3);
    const deleted = pruneBackups();
    expect(deleted.sort()).toEqual(['budget-2026-08-10.db', 'budget-2026-08-11.db', 'budget-2026-08-12.db']);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.db', 'budget-2026-08-14.db', 'budget-2026-08-13.db']);
  });

  it('deletes nothing when the count is under the retention limit', () => {
    fakeBackup('budget-2026-08-15.db', 10);
    expect(pruneBackups(14)).toEqual([]);
  });

  it('ignores non-backup files in the directory', () => {
    fakeBackup('budget-2026-08-15.db', 10);
    fs.writeFileSync(path.join(backupsDir(), 'README.txt'), 'hello');
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.db']);
    expect(pruneBackups(0)).toEqual(['budget-2026-08-15.db']);
    expect(fs.existsSync(path.join(backupsDir(), 'README.txt'))).toBe(true);
  });

  it('ignores filenames shaped like a traversal attempt', () => {
    // Ruling (b): listBackups/pruneBackups only ever touch entries matching the
    // strict nightly regex, so a rogue entry can never be read or deleted by them.
    fakeBackup('budget-2026-08-15.db', 10);
    fs.writeFileSync(path.join(backupsDir(), 'budget-2026-08-15.db.bak'), 'x');
    fs.writeFileSync(path.join(backupsDir(), '..budget-2026-08-15.db'), 'x');
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.db']);
  });

  it('lists nothing when the directory does not exist', () => {
    expect(listBackups()).toEqual([]);
    expect(pruneBackups()).toEqual([]);
  });
});

describe('on-demand backup', () => {
  it('writes into DATA_DIR/tmp with a uuid name that cannot collide with the nightly files', () => {
    const result = createOnDemandBackup();
    expect(result.path.startsWith(tempDir())).toBe(true);
    expect(path.basename(result.path)).toMatch(/^[0-9a-f-]{36}\.db$/);
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
    expect(result).toEqual({ sessionsPurged: 1, loginAttemptsPurged: 1, stagedFilesPurged: 1 });
    expect((current!.sqlite.prepare('select count(*) as c from sessions').get() as { c: number }).c).toBe(1);
    expect((current!.sqlite.prepare('select count(*) as c from login_attempts').get() as { c: number }).c).toBe(1);
  });
});

describe('runNightlyJob', () => {
  it('backs up, prunes and sweeps in one call', () => {
    const userId = insertTestUser(current!.db);
    createSession(userId, { at: new Date('2026-01-01T00:00:00.000Z') });
    current!.db.run(sql`insert into settings (key, value) values ('probe', ${nowIso()})`);

    const result = runNightlyJob(new Date('2026-08-15T06:00:00.000Z'));
    expect(result.backup.name).toBe('budget-2026-08-15.db');
    expect(fs.existsSync(result.backup.path)).toBe(true);
    expect(result.sweep.sessionsPurged).toBe(1);
    expect(Array.isArray(result.pruned)).toBe(true);
  });
});
