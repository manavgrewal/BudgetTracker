import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrationsFolder } from '@/db/client';
import { backupsDir, runNightlyBackup } from '@/lib/backup';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { commitRestore, prepareRestore, type RestorePlan } from '../../scripts/restore-core.ts';
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

  it('MUST-20.23 (T1 review CRITICAL 1): a hard error mid-commit signals restart, never lets a partial commit look complete, and self-heals on the next boot even if the signal is ignored', () => {
    stageArchiveBackup();
    const applying = applyingDir();
    fs.renameSync(stagedDir(), applying);
    const plan = prepareRestore(path.join(applying, 'payload'), {
      dataDir,
      scratchDir: applying,
      migrationsFolder: migrationsFolder(),
      now: new Date('2026-08-16T21:00:00.000Z'),
    });
    fs.writeFileSync(path.join(applying, 'commit.json'), JSON.stringify({ ...plan, attempts: 1 }));

    // Inject a genuine hard error (not just a "file missing") at the very last step: renaming
    // the incoming database into place.
    const incomingDb = path.join(applying, 'work', 'budget.db.incoming');
    const dbTarget = path.join(dataDir, 'budget.db');
    const realRenameSync = fs.renameSync.bind(fs);
    let broken = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (!broken && String(from) === incomingDb && String(to) === dbTarget) {
        broken = true;
        throw new Error('EIO simulated mid-step');
      }
      return realRenameSync(from, to);
    }) as typeof fs.renameSync);

    let outcome1: 'continue' | 'restart';
    try {
      outcome1 = applyStagedRestoreOnBoot(new Date('2026-08-16T21:05:00.000Z'));
    } finally {
      spy.mockRestore();
    }

    // The contract: 'restart' means the caller (instrumentation-node.ts) must exit instead of
    // calling getDb(). Nothing terminal has been recorded, and restore-applying/ + its
    // commit.json survive for the next boot to resume.
    expect(outcome1).toBe('restart');
    expect(fs.existsSync(applying)).toBe(true);
    expect(fs.existsSync(path.join(applying, 'commit.json'))).toBe(true);
    expect(readRestoreState().result).toBeNull();
    // Step 1 already moved the real database aside before the injected failure; the live
    // path is genuinely empty right now, mid-commit.
    expect(fs.existsSync(dbTarget)).toBe(false);

    // Simulate a caller that (wrongly) ignored the 'restart' signal and opened the database
    // anyway — src/db/client.ts's openDatabase() creates the file (and its schema) if it does
    // not already exist. This is exactly the CRITICAL bug: an empty, migrated database at the
    // path the interrupted commit still needs.
    fs.writeFileSync(dbTarget, 'BOGUS-EMPTY-DB-FROM-AN-IGNORED-RESTART-SIGNAL');

    const outcome2 = applyStagedRestoreOnBoot(new Date('2026-08-16T21:06:00.000Z'));
    expect(outcome2).toBe('continue');
    expect(fs.existsSync(applying)).toBe(false);
    expect(readRestoreState().result?.status).toBe('success');
    // The REAL payload is what's installed, not the bogus placeholder — the incoming-first,
    // clear-stale-`to` replay rule (restore-core.ts) overwrites it rather than skipping the
    // rename because `to` merely existed.
    const finalDb = fs.readFileSync(dbTarget);
    expect(finalDb.toString()).not.toContain('BOGUS-EMPTY-DB-FROM-AN-IGNORED-RESTART-SIGNAL');
    expect(finalDb.subarray(0, 15).toString('utf8')).toBe('SQLite format 3');
  });

  it('a hard error mid-commit on a bare-db restore also signals restart and self-heals', () => {
    const legacyName = 'budget-2026-08-11.db';
    fs.mkdirSync(backupsDir(), { recursive: true });
    current!.sqlite.exec(`VACUUM INTO '${path.join(backupsDir(), legacyName).replace(/'/g, "''")}'`);
    stageRestore({ backupName: legacyName, userId: 1, username: 'admin' });

    const applying = applyingDir();
    fs.renameSync(stagedDir(), applying);
    const plan = prepareRestore(path.join(applying, 'payload'), {
      dataDir,
      scratchDir: applying,
      migrationsFolder: migrationsFolder(),
      now: new Date('2026-08-16T21:10:00.000Z'),
    });
    fs.writeFileSync(path.join(applying, 'commit.json'), JSON.stringify({ ...plan, attempts: 1 }));

    const incomingDb = path.join(applying, 'work', 'budget.db.incoming');
    const dbTarget = path.join(dataDir, 'budget.db');
    const realRenameSync = fs.renameSync.bind(fs);
    let broken = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (!broken && String(from) === incomingDb && String(to) === dbTarget) {
        broken = true;
        throw new Error('EIO simulated mid-step');
      }
      return realRenameSync(from, to);
    }) as typeof fs.renameSync);

    let outcome1: 'continue' | 'restart';
    try {
      outcome1 = applyStagedRestoreOnBoot(new Date('2026-08-16T21:11:00.000Z'));
    } finally {
      spy.mockRestore();
    }
    expect(outcome1).toBe('restart');

    fs.writeFileSync(dbTarget, 'BOGUS-EMPTY-DB');
    const outcome2 = applyStagedRestoreOnBoot(new Date('2026-08-16T21:12:00.000Z'));
    expect(outcome2).toBe('continue');
    expect(readRestoreState().result?.status).toBe('success');
    expect(fs.readFileSync(dbTarget).toString()).not.toContain('BOGUS-EMPTY-DB');
  });

  it('MUST-20.13 (T1 review CRITICAL 2): a tampered commit.json pointing outside the data directory is refused and terminal', () => {
    stageArchiveBackup();
    const applying = applyingDir();
    fs.renameSync(stagedDir(), applying);
    const plan = prepareRestore(path.join(applying, 'payload'), {
      dataDir,
      scratchDir: applying,
      migrationsFolder: migrationsFolder(),
      now: new Date('2026-08-16T21:00:00.000Z'),
    });
    const outsideTarget = path.join(os.tmpdir(), 'escaped-outside-data-dir.txt');
    fs.rmSync(outsideTarget, { force: true });
    const tampered = {
      ...plan,
      attempts: 1,
      steps: [{ op: 'rename', from: path.join(dataDir, 'budget.db'), to: outsideTarget, incoming: false }],
    };
    fs.writeFileSync(path.join(applying, 'commit.json'), JSON.stringify(tampered));

    const outcome = applyStagedRestoreOnBoot(new Date('2026-08-16T21:05:00.000Z'));

    expect(outcome).toBe('continue');
    // Refused BEFORE any step executes: nothing was renamed outside the data directory.
    expect(fs.existsSync(outsideTarget)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'budget.db'))).toBe(true);
    // Terminal, not silently discarded: restore-applying/ is renamed for forensics, and the
    // state machine is unwedged (staging is possible again).
    expect(fs.existsSync(applying)).toBe(false);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('restore-failed-'))).toBe(true);
    expect(readRestoreState().result?.status).toBe('failed');
    fs.rmSync(outsideTarget, { force: true });
  });

  it('MUST-20.13 (T1 review CRITICAL 2): a truncated commit.json is terminal, and staging is possible again afterward', () => {
    stageArchiveBackup();
    const applying = applyingDir();
    fs.renameSync(stagedDir(), applying);
    // Simulate a write that was killed partway through (not the atomic writeJsonAtomically
    // path at all — a raw truncated file, worse than what this codebase would ever produce,
    // but exactly what an operator hand-editing ${DATA_DIR} could leave behind).
    fs.writeFileSync(path.join(applying, 'commit.json'), '{"version": 1, "stamp": "2026-08-16T21-00-00-000Z", "st');

    const outcome = applyStagedRestoreOnBoot(new Date('2026-08-16T21:05:00.000Z'));

    expect(outcome).toBe('continue');
    expect(fs.existsSync(applying)).toBe(false);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('restore-failed-'))).toBe(true);
    expect(readRestoreState().result?.status).toBe('failed');

    // The state machine is not wedged: a fresh stage succeeds.
    const second = runNightlyBackup(new Date('2026-08-17T06:00:00.000Z'));
    expect(() => stageRestore({ backupName: second.name, userId: 1, username: 'admin' })).not.toThrow();
  });

  it('T1 review IMPORTANT 4: F18 recovery text does not nest the old receipts/ inside the new one when a later step already ran', () => {
    stageArchiveBackup();
    const applying = applyingDir();
    fs.renameSync(stagedDir(), applying);
    const plan = prepareRestore(path.join(applying, 'payload'), {
      dataDir,
      scratchDir: applying,
      migrationsFolder: migrationsFolder(),
      now: new Date('2026-08-16T21:00:00.000Z'),
    });
    expect(plan.kind).toBe('archive');

    // Actually run every step EXCEPT the last (the database rename) for real, so `receipts`
    // already holds the INCOMING content by the time exhaustion is simulated — the exact
    // state in which a naive recovery command would nest the old receipts/ inside the new one.
    // budget.db does not exist at this halfway point (the truncated steps list never got to
    // the final rename), so commitRestore's own countMissingReceiptRows() throws trying to
    // report on it — exactly like a real kill never reaching its own return statement.
    try {
      commitRestore(
        { ...plan, steps: plan.steps.slice(0, plan.steps.length - 1) },
        { dataDir, now: new Date('2026-08-16T21:00:01.000Z') },
      );
    } catch {
      /* the steps themselves ran; only the truncated call's own result-reporting throws */
    }
    expect(fs.existsSync(path.join(dataDir, 'receipts'))).toBe(true);
    expect(plan.receiptsMovedAside).not.toBeNull();

    const exhausted: RestorePlan = { ...plan, attempts: MAX_COMMIT_ATTEMPTS };
    fs.writeFileSync(path.join(applying, 'commit.json'), JSON.stringify(exhausted));

    applyStagedRestoreOnBoot(new Date('2026-08-16T21:05:00.000Z'));

    const error = readRestoreState().result?.error ?? '';
    // The current (new) receipts/ is moved aside to a .failed-<stamp> sibling FIRST, only
    // then is the pre-restore copy moved back into the real path — never a bare `mv` of the
    // safety copy onto an already-occupied destination (which would nest, not replace).
    expect(error).toMatch(/mv \S*[/\\]receipts \S*[/\\]receipts\.failed-\S+ && mv \S*[/\\]receipts\.pre-restore-\S+ \S*[/\\]receipts\b/);
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
    // A realistic "exhausted after 3 attempts" scenario has SOME steps genuinely completed —
    // step 1 (the safety copy) would have succeeded in the very first attempt, long before a
    // later step's repeated failure burns through the cap. Simulate that so the recovery
    // text below (built from real fs.existsSync state, T1 review IMPORTANT 4) has something
    // real to point at, rather than asserting on a state this code path can't actually reach.
    if (plan.safetyCopy) {
      fs.writeFileSync(path.join(dataDir, plan.safetyCopy), 'safety copy made by an earlier attempt');
    }
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

  it('MUST-20.12 (T1 review IMPORTANT 5): a raw non-RestoreError never reaches restore-result.json', () => {
    stageArchiveBackup();

    // Simulate an unanticipated, non-RestoreError failure during prepare (e.g. an ENOSPC-like
    // condition): mkdirSync throwing a raw errno-shaped Error, not something this codebase
    // wrote as an operator-readable sentence. Left in STAGED (not pre-renamed to APPLYING) so
    // the fresh-promotion path actually reaches prepareRestore()'s mkdirSync call.
    const realMkdirSync = fs.mkdirSync.bind(fs);
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, opts?: unknown) => {
      if (String(target).includes('work')) {
        throw new Error('ENOSPC: no space left on device, mkdir raw-path-detail');
      }
      return realMkdirSync(target, opts as fs.MakeDirectoryOptions);
    }) as typeof fs.mkdirSync);

    try {
      applyStagedRestoreOnBoot(new Date('2026-08-16T21:05:00.000Z'));
    } finally {
      spy.mockRestore();
    }

    const error = readRestoreState().result?.error ?? '';
    expect(error).not.toContain('ENOSPC');
    expect(error).not.toContain('raw-path-detail');
    expect(error).toMatch(/unexpected error/i);
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

  it('T1 review minor: a successful outcome is never overwritten by the outer catch, even if something throws right after writing it', () => {
    stageArchiveBackup();
    // writeOutcome() logs AFTER the write has already completed successfully; simulate that
    // logging call itself throwing (an unrelated failure with nothing to do with the restore)
    // to exercise the outer catch's defensive "don't overwrite a result already written
    // during this call" check.
    let thrown = false;
    const spy = vi.spyOn(console, 'log').mockImplementation(((...args: unknown[]) => {
      const msg = String(args[0] ?? '');
      if (!thrown && msg.startsWith('[restore] applied')) {
        thrown = true;
        throw new Error('simulated logging failure right after a successful write');
      }
    }) as typeof console.log);

    let outcome: 'continue' | 'restart';
    try {
      outcome = applyStagedRestoreOnBoot(new Date('2026-08-16T21:05:00.000Z'));
    } finally {
      spy.mockRestore();
    }

    expect(outcome).toBe('continue');
    expect(readRestoreState().result?.status).toBe('success');
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

  it('T1 review minor: sweeps a stale restore-result.json.partial left by a killed write', () => {
    const partial = path.join(dataDir, 'restore-result.json.partial');
    fs.writeFileSync(partial, '{"incomplete write left behind by a killed writeJsonAtomically() call');
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(partial, longAgo, longAgo);

    expect(purgePreRestoreCopies()).toBe(1);
    expect(fs.existsSync(partial)).toBe(false);
  });

  it('T1 review minor: leaves a fresh restore-result.json.partial alone — a write still in flight must not be swept mid-write', () => {
    const partial = path.join(dataDir, 'restore-result.json.partial');
    fs.writeFileSync(partial, '{"still being written');

    expect(purgePreRestoreCopies()).toBe(0);
    expect(fs.existsSync(partial)).toBe(true);
  });
});
