import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrationsFolder } from '@/db/client';
import { backupsDir, runNightlyBackup } from '@/lib/backup';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { prepareRestore, type RestorePlan } from '../../scripts/restore-core.ts';
import {
  MAX_COMMIT_ATTEMPTS,
  PRE_RESTORE_MAX_AGE_MS,
  applyStagedRestoreOnBoot,
  applyingDir,
  purgePreRestoreCopies,
  readRestoreState,
  resultPath,
  stageRestore,
  stagedDir,
} from '@/lib/backup/restore';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function fileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stageArchiveBackup(): { name: string } {
  const backup = runNightlyBackup(new Date('2026-08-16T06:00:00.000Z'));
  const request = stageRestore({ backupName: backup.name, userId: 1, username: 'admin' });
  return { name: request.sourceName };
}

function writeMarker(overrides: Record<string, unknown>): void {
  const markerPath = path.join(stagedDir(), 'restore-request.json');
  const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(markerPath, JSON.stringify({ ...parsed, ...overrides }));
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-app-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  process.env.BUDGET_DB_PATH = current.path;
  insertTestUser(current.db, { name: 'Admin', username: 'admin' });

  // The "live" data the restore machinery actually operates on: a real copy of the seeded,
  // migrated database at ${DATA_DIR}/budget.db, plus a receipts/ directory with one file.
  fs.copyFileSync(current.path, path.join(dataDir, 'budget.db'));
  fs.mkdirSync(path.join(dataDir, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'receipts', '11111111-2222-3333-4444-555555555555.jpg'), JPEG);
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

describe('MUST-20.17: the state machine', () => {
  it('stages by building tmp/<uuid>-restore/ and renaming it into place', () => {
    expect(fs.existsSync(stagedDir())).toBe(false);
    const backup = runNightlyBackup(new Date('2026-08-16T06:00:00.000Z'));
    const request = stageRestore({ backupName: backup.name, userId: 1, username: 'admin' });

    expect(fs.existsSync(stagedDir())).toBe(true);
    expect(fs.existsSync(path.join(stagedDir(), 'payload'))).toBe(true);
    expect(request.version).toBe(1);
    expect(request.sourceName).toBe(backup.name);
    expect(request.sha256).toBe(fileHash(path.join(stagedDir(), 'payload')));

    const state = readRestoreState();
    expect(state.staged?.sourceName).toBe(backup.name);

    // Nothing is left dangling under tmp/ once the commit rename has happened.
    const tmpDir = path.join(dataDir, 'tmp');
    if (fs.existsSync(tmpDir)) {
      expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('-restore'))).toEqual([]);
    }
  });

  it('refuses a second stage while one is staged (MUST-20.10)', () => {
    stageArchiveBackup();
    const second = runNightlyBackup(new Date('2026-08-17T06:00:00.000Z'));
    expect(() => stageRestore({ backupName: second.name, userId: 1, username: 'admin' })).toThrowError(
      /already staged/i,
    );
  });

  it('refuses an unlisted or unsafe backup filename', () => {
    expect(() => stageRestore({ backupName: '../../etc/passwd', userId: 1, username: 'admin' })).toThrow();
    expect(() => stageRestore({ backupName: 'not-a-real-backup.tar.gz', userId: 1, username: 'admin' })).toThrow();
  });

  it('applies a staged archive on boot and leaves the safety copies', () => {
    const before = stageArchiveBackup();
    // Mutate the live data after staging, before the restart.
    fs.writeFileSync(path.join(dataDir, 'receipts', 'extra-not-in-backup.txt'), 'mutated');

    applyStagedRestoreOnBoot(new Date('2026-08-16T21:04:53.000Z'));

    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(fs.existsSync(applyingDir())).toBe(false);
    const state = readRestoreState();
    expect(state.result?.status).toBe('success');
    expect(state.result?.sourceName).toBe(before.name);
    expect(state.result?.safetyCopy).toMatch(/^budget\.pre-restore-.+\.db$/);
    expect(fs.existsSync(path.join(dataDir, state.result!.safetyCopy!))).toBe(true);
    expect(state.result?.receiptsMovedAside).toMatch(/^receipts\.pre-restore-/);
    expect(fs.existsSync(path.join(dataDir, state.result!.receiptsMovedAside!, 'extra-not-in-backup.txt'))).toBe(
      true,
    );
    // The restored receipts/ holds exactly what the backup had, not the mutation.
    expect(fs.existsSync(path.join(dataDir, 'receipts', 'extra-not-in-backup.txt'))).toBe(false);
  });

  it('applies a staged bare .db on boot without touching receipts/', () => {
    const legacyName = 'budget-2026-08-10.db';
    fs.mkdirSync(backupsDir(), { recursive: true });
    current!.sqlite.exec(`VACUUM INTO '${path.join(backupsDir(), legacyName).replace(/'/g, "''")}'`);

    stageRestore({ backupName: legacyName, userId: 1, username: 'admin' });

    const preExisting = fs.readdirSync(path.join(dataDir, 'receipts')).sort();
    applyStagedRestoreOnBoot(new Date('2026-08-16T21:04:53.000Z'));

    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(fs.existsSync(applyingDir())).toBe(false);
    const state = readRestoreState();
    expect(state.result?.status).toBe('success');
    expect(state.result?.kind).toBe('sqlite');
    // MUST-12.9: receipts/ is never renamed, emptied or modified by a bare-db restore.
    expect(state.result?.receiptsMovedAside).toBeNull();
    expect(fs.readdirSync(path.join(dataDir, 'receipts')).sort()).toEqual(preExisting);
  });

  it('discards an APPLYING attempt that has no commit.json, untouched (MUST-20.19)', () => {
    stageArchiveBackup();
    const dbHashBefore = fileHash(path.join(dataDir, 'budget.db'));

    // Simulate a crash between the STAGED -> APPLYING rename and the first prepare write:
    // restore-applying/ exists, but no commit.json was ever written.
    fs.renameSync(stagedDir(), applyingDir());

    applyStagedRestoreOnBoot();

    expect(fs.existsSync(applyingDir())).toBe(false);
    expect(fileHash(path.join(dataDir, 'budget.db'))).toBe(dbHashBefore);
    expect(readRestoreState().result?.status).toBe('failed');
  });

  it('resumes an APPLYING attempt that has commit.json (MUST-20.23)', () => {
    stageArchiveBackup();
    const applying = applyingDir();
    fs.renameSync(stagedDir(), applying);

    // Build the real plan restore-core would have produced, exactly as the boot hook does,
    // then simulate a crash immediately after commit.json was written (the point of no
    // return) but before any of its steps executed.
    const plan = prepareRestore(path.join(applying, 'payload'), {
      dataDir,
      scratchDir: applying,
      migrationsFolder: migrationsFolder(),
      now: new Date('2026-08-16T21:00:00.000Z'),
    });
    fs.writeFileSync(path.join(applying, 'commit.json'), JSON.stringify({ ...plan, attempts: 1 }));

    applyStagedRestoreOnBoot(new Date('2026-08-16T21:05:00.000Z'));

    expect(fs.existsSync(applying)).toBe(false);
    expect(readRestoreState().result?.status).toBe('success');
  });

  it('does not retry once attempts have been exhausted (MUST-20.19)', () => {
    stageArchiveBackup();
    const applying = applyingDir();
    fs.renameSync(stagedDir(), applying);
    const plan = prepareRestore(path.join(applying, 'payload'), {
      dataDir,
      scratchDir: applying,
      migrationsFolder: migrationsFolder(),
      now: new Date('2026-08-16T21:00:00.000Z'),
    });
    const exhausted: RestorePlan = { ...plan, attempts: MAX_COMMIT_ATTEMPTS };
    fs.writeFileSync(path.join(applying, 'commit.json'), JSON.stringify(exhausted));

    applyStagedRestoreOnBoot();

    expect(fs.existsSync(applying)).toBe(false);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('restore-failed-'))).toBe(true);
    expect(readRestoreState().result?.status).toBe('failed');
    expect(readRestoreState().result?.error).toMatch(/mv /);
  });

  it.each([
    ['a marker with version 2', () => writeMarker({ version: 2 })],
    ['a marker failing zod', () => writeMarker({ sha256: 'nope' })],
    ['a missing payload', () => fs.rmSync(path.join(stagedDir(), 'payload'))],
    ['a sha256 mismatch', () => fs.appendFileSync(path.join(stagedDir(), 'payload'), 'x')],
  ])('records %s as failed and leaves live data alone', (_label, sabotage) => {
    stageArchiveBackup();
    const before = fileHash(path.join(dataDir, 'budget.db'));
    sabotage();

    applyStagedRestoreOnBoot();

    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(readRestoreState().result?.status).toBe('failed');
    expect(fileHash(path.join(dataDir, 'budget.db'))).toBe(before);
  });

  it('MUST-20.20: never throws, even when checking restore-applying/ fails', () => {
    stageArchiveBackup();
    const realExistsSync = fs.existsSync.bind(fs);
    const spy = vi.spyOn(fs, 'existsSync').mockImplementation(((target: fs.PathLike) => {
      if (String(target).includes('restore-applying')) throw new Error('EACCES simulated');
      return realExistsSync(target);
    }) as typeof fs.existsSync);

    try {
      expect(() => applyStagedRestoreOnBoot()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('the fast path does nothing and logs nothing observable when no restore is staged', () => {
    expect(fs.existsSync(resultPath())).toBe(false);
    expect(() => applyStagedRestoreOnBoot()).not.toThrow();
    expect(fs.existsSync(resultPath())).toBe(false);
  });
});

describe('purgePreRestoreCopies (MUST-20.33)', () => {
  function fakeDated(name: string, isDir: boolean, daysAgo: number): void {
    const target = path.join(dataDir, name);
    if (isDir) fs.mkdirSync(target, { recursive: true });
    else fs.writeFileSync(target, 'x');
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    fs.utimesSync(target, when, when);
  }

  it('removes aged-out copies but keeps the most recent of each kind even at 400 days', () => {
    // The "recent" one is 35 days old — itself past the 30-day cutoff — to prove it survives
    // purely because it is the NEWEST of its kind, not because it happens to be under 30 days.
    fakeDated('budget.pre-restore-recent.db', false, 35);
    fakeDated('budget.pre-restore-old.db', false, 400);
    fakeDated('receipts.pre-restore-recent', true, 35);
    fakeDated('receipts.pre-restore-old', true, 400);
    fakeDated('restore-failed-recent', true, 35);
    fakeDated('restore-failed-old', true, 400);

    const removed = purgePreRestoreCopies();
    expect(removed).toBe(3);
    expect(fs.existsSync(path.join(dataDir, 'budget.pre-restore-recent.db'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'budget.pre-restore-old.db'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'receipts.pre-restore-recent'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'receipts.pre-restore-old'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'restore-failed-recent'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'restore-failed-old'))).toBe(false);
  });

  it('removes a pre-restore db together with its -wal/-shm siblings', () => {
    fakeDated('budget.pre-restore-old.db', false, 31);
    fakeDated('budget.pre-restore-old.db-wal', false, 31);
    fakeDated('budget.pre-restore-old.db-shm', false, 31);
    fakeDated('budget.pre-restore-new.db', false, 0);

    purgePreRestoreCopies();
    expect(fs.existsSync(path.join(dataDir, 'budget.pre-restore-old.db-wal'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'budget.pre-restore-old.db-shm'))).toBe(false);
  });

  it('keeps everything when nothing is old enough', () => {
    fakeDated('budget.pre-restore-a.db', false, 1);
    fakeDated('budget.pre-restore-b.db', false, 2);
    expect(purgePreRestoreCopies()).toBe(0);
  });

  it('does nothing when the data dir has no such files', () => {
    expect(purgePreRestoreCopies()).toBe(0);
  });

  it('exports the documented 30-day constant', () => {
    expect(PRE_RESTORE_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
