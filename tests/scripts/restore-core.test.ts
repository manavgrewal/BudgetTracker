import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  RestoreError,
  commitRestore,
  prepareRestore,
  readAppliedMigrations,
  readLocalMigrations,
  restoreFromArtifact,
  validateArtifact,
} from '../../scripts/restore-core.ts';

let work: string;
const cleanupDirs: string[] = [];

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-core-'));
});
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir: string): string {
  cleanupDirs.push(dir);
  return dir;
}

/** A journal folder with `count` entries whose `when` values are 1000, 2000, … */
function fakeJournal(count: number, tag = String(count)): string {
  const folder = path.join(work, `journal-${tag}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const entries = Array.from({ length: count }, (_, i) => ({
    idx: i,
    version: '6',
    when: (i + 1) * 1000,
    tag: `000${i}_x`,
    breakpoints: true,
  }));
  fs.writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  );
  return folder;
}

function buildDbFile(file: string, whens: number[], opts: { withTable?: boolean } = {}): void {
  const db = new Database(file);
  db.exec('create table users (id integer primary key)');
  db.exec('create table accounts (id integer primary key)');
  db.exec('create table transactions (id integer primary key)');
  if (opts.withTable !== false) {
    db.exec('create table __drizzle_migrations (id integer primary key, hash text not null, created_at numeric)');
    const insert = db.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)');
    for (const when of whens) insert.run(`hash-${when}`, when);
  }
  db.close();
}

/** A minimal but genuine Budget Tracker-shaped database with `whens` already applied. */
function fakeDb(name: string, whens: number[], opts: { withTable?: boolean } = {}): string {
  const file = path.join(work, name);
  buildDbFile(file, whens, opts);
  return file;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

async function makeArchive(
  destDir: string,
  opts: { whens?: number[]; receiptNames?: string[]; includeReceiptsEntry?: boolean } = {},
): Promise<string> {
  const tar = await import('tar');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-core-archive-'));
  try {
    buildDbFile(path.join(stage, 'budget.db'), opts.whens ?? [1000]);
    const names = ['budget.db'];
    if (opts.includeReceiptsEntry !== false) {
      const receipts = path.join(stage, 'receipts');
      fs.mkdirSync(receipts, { recursive: true });
      for (const name of opts.receiptNames ?? ['11111111-2222-3333-4444-555555555555.jpg']) {
        fs.writeFileSync(path.join(receipts, name), JPEG);
      }
      names.push('receipts');
    }
    const artifact = path.join(destDir, `archive-${Math.random().toString(36).slice(2)}.tar.gz`);
    tar.create({ file: artifact, cwd: stage, gzip: true, sync: true }, names);
    return artifact;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function makeHostileArchive(destDir: string): Promise<string> {
  const tar = await import('tar');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-core-hostile-'));
  try {
    fs.writeFileSync(path.join(stage, 'evil.sh'), '#!/bin/sh\nrm -rf /');
    const artifact = path.join(destDir, `hostile-${Math.random().toString(36).slice(2)}.tar.gz`);
    tar.create({ file: artifact, cwd: stage, gzip: true, sync: true }, ['evil.sh']);
    return artifact;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function makeLiveDataDir(): string {
  const dataDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-core-live-')));
  buildDbFile(path.join(dataDir, 'budget.db'), [1000]);
  const receipts = path.join(dataDir, 'receipts');
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(receipts, '99999999-8888-7777-6666-555555555555.jpg'), JPEG);
  fs.writeFileSync(
    path.join(receipts, '11111111-2222-3333-4444-555555555555.png'),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]),
  );
  return dataDir;
}

/** Sorted listing of everything under `dir`, with file sha256s. The comparison instrument. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(full, rel);
      } else {
        out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir, '');
  return out;
}

describe('MUST-20.16: the one-way guard', () => {
  it('reads the local journal', () => {
    expect(readLocalMigrations(fakeJournal(4))).toEqual({ count: 4, maxWhen: 4000 });
  });

  it('T1 review IMPORTANT 5: a missing local journal throws a written RestoreError, not a raw ENOENT', () => {
    expect(() => readLocalMigrations(path.join(work, 'does-not-exist'))).toThrowError(RestoreError);
    expect(() => readLocalMigrations(path.join(work, 'does-not-exist'))).not.toThrowError(/ENOENT/);
  });

  it('T1 review IMPORTANT 5: an unparseable local journal throws a written RestoreError, not a raw SyntaxError', () => {
    const folder = path.join(work, 'bad-journal');
    fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'meta/_journal.json'), '{not valid json');
    expect(() => readLocalMigrations(folder)).toThrowError(RestoreError);
  });

  it('reads what a backup has applied', () => {
    expect(readAppliedMigrations(fakeDb('a.db', [1000, 2000]))).toEqual({ count: 2, maxWhen: 2000 });
  });

  it('treats a missing __drizzle_migrations table as zero, not as an error', () => {
    expect(readAppliedMigrations(fakeDb('b.db', [], { withTable: false }))).toEqual({ count: 0, maxWhen: 0 });
  });

  it.each([
    ['fewer', [1000, 2000], 4],
    ['equal', [1000, 2000, 3000, 4000], 4],
    ['none', [], 4],
  ])('allows a backup with %s applied migrations', (label, whens, local) => {
    const db = fakeDb(`ok-${label}.db`, whens as number[]);
    expect(() =>
      validateArtifact(db, {
        scratchDir: path.join(work, `s-${label}`),
        migrationsFolder: fakeJournal(local as number, label),
      }),
    ).not.toThrow();
  });

  it('refuses a backup whose newest migration is newer than the code ships', () => {
    const db = fakeDb('newer.db', [1000, 2000, 3000, 9999]);
    expect(() =>
      validateArtifact(db, {
        scratchDir: path.join(work, 's-newer'),
        migrationsFolder: fakeJournal(4, 'newer'),
      }),
    ).toThrowError(/newer version of Budget Tracker/i);
  });

  it('refuses a backup with MORE applied migrations even when the newest matches', () => {
    // maxWhen is equal, so the `when` comparison alone would let this through. The count
    // comparison catches it: this database has a migration the running code does not ship.
    const db = fakeDb('extra.db', [1000, 1500, 2000, 3000, 4000]);
    expect(() =>
      validateArtifact(db, {
        scratchDir: path.join(work, 's-extra'),
        migrationsFolder: fakeJournal(4, 'extra'),
      }),
    ).toThrowError(RestoreError);
  });
});

describe('T1 review IMPORTANT 3 (controller ruling): --allow-newer bypasses the one-way guard, CLI only', () => {
  it('validateArtifact refuses a newer backup by default but allows it with allowNewerMigrations', () => {
    const db = fakeDb('newer-bypass.db', [1000, 2000, 3000, 9999]);
    const local = fakeJournal(4, 'bypass');
    expect(() => validateArtifact(db, { scratchDir: path.join(work, 's-bypass-off'), migrationsFolder: local })).toThrowError(
      /newer version of Budget Tracker/i,
    );
    const report = validateArtifact(db, {
      scratchDir: path.join(work, 's-bypass-on'),
      migrationsFolder: local,
      allowNewerMigrations: true,
    });
    expect(report.appliedMigrations).toBe(4);
  });

  it('restoreFromArtifact (the CLI path) restores a newer backup only when allowNewerMigrations is set', () => {
    // restoreFromArtifact() resolves the REAL project drizzle/meta/_journal.json (it takes
    // no migrationsFolder param), so "newer" here must exceed that real journal's actual max
    // `when`, not just the small fixture values used against fakeJournal() elsewhere in this
    // file.
    const dataDir = makeLiveDataDir();
    const newerDb = fakeDb('newer-restore.db', [1000, 2000, 3000, 9_999_999_999_999]);
    expect(() => restoreFromArtifact(newerDb, { dataDir, now: new Date() })).toThrowError(
      /newer version of Budget Tracker/i,
    );
    const result = restoreFromArtifact(newerDb, { dataDir, now: new Date(), allowNewerMigrations: true });
    expect(result.databaseRestored).toBe(true);
  });

  it('prepareRestore refuses a newer backup by default even when the caller is the app/boot path', () => {
    // The app/boot path (src/lib/backup/restore.ts) never passes allowNewerMigrations at
    // all — this pins that omitting it (the app's only call shape) still enforces the guard.
    const dataDir = makeLiveDataDir();
    const newerDb = fakeDb('newer-app.db', [1000, 2000, 3000, 9999]);
    expect(() =>
      prepareRestore(newerDb, {
        dataDir,
        scratchDir: path.join(work, 's-app-guard'),
        migrationsFolder: fakeJournal(4, 'app-guard'),
        now: new Date(),
      }),
    ).toThrowError(/newer version of Budget Tracker/i);
  });
});

describe('MUST-20.14: validation refuses everything it should', () => {
  it('refuses an empty file, a tiny file, and a directory', () => {
    const empty = path.join(work, 'empty');
    fs.writeFileSync(empty, '');
    const tiny = path.join(work, 'tiny');
    fs.writeFileSync(tiny, 'ab');
    const dir = path.join(work, 'dir');
    fs.mkdirSync(dir);
    for (const target of [empty, tiny, dir]) {
      expect(() =>
        validateArtifact(target, { scratchDir: path.join(work, 's'), migrationsFolder: fakeJournal(4, 'refuse') }),
      ).toThrowError(RestoreError);
    }
  });

  it('refuses a file that is neither gzip nor SQLite', () => {
    const junk = path.join(work, 'junk.tar.gz'); // the NAME says archive
    fs.writeFileSync(junk, Buffer.alloc(64, 0x41)); // the BYTES say nothing
    expect(() =>
      validateArtifact(junk, { scratchDir: path.join(work, 's2'), migrationsFolder: fakeJournal(4, 'junk') }),
    ).toThrowError(/neither a .*archive nor a .*SQLite/i);
  });

  it('refuses a SQLite file that is not a Budget Tracker database', () => {
    const file = path.join(work, 'other.db');
    const db = new Database(file);
    db.exec('create table something_else (id integer primary key)');
    db.close();
    expect(() =>
      validateArtifact(file, { scratchDir: path.join(work, 's3'), migrationsFolder: fakeJournal(4, 'other') }),
    ).toThrowError(/not a usable Budget Tracker database/i);
  });

  it('refuses a corrupted SQLite file (quick_check)', () => {
    const file = fakeDb('corrupt.db', [1000]);
    const fd = fs.openSync(file, 'r+');
    // Scribble over a page well past the header, so the magic bytes still pass and only
    // quick_check can catch it — which is the whole point of running quick_check.
    fs.writeSync(fd, Buffer.alloc(512, 0xff), 0, 512, 4096);
    fs.closeSync(fd);
    expect(() =>
      validateArtifact(file, { scratchDir: path.join(work, 's4'), migrationsFolder: fakeJournal(4, 'corrupt') }),
    ).toThrowError(RestoreError);
  });

  it('returns a report for a good bare database', () => {
    const report = validateArtifact(fakeDb('good.db', [1000, 2000]), {
      scratchDir: path.join(work, 's5'),
      migrationsFolder: fakeJournal(4, 'good'),
    });
    expect(report.kind).toBe('sqlite');
    expect(report.receiptCount).toBe(0);
    expect(report.appliedMigrations).toBe(2);
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a report for a good archive, counting only accepted receipt names', async () => {
    const artifact = await makeArchive(work, { whens: [1000, 2000] });
    const report = validateArtifact(artifact, {
      scratchDir: path.join(work, 's6'),
      migrationsFolder: fakeJournal(4, 'archive-good'),
    });
    expect(report.kind).toBe('archive');
    expect(report.receiptCount).toBe(1);
    expect(report.appliedMigrations).toBe(2);
  });
});

describe('MUST-20.7: prepareRestore writes nothing outside scratchDir', () => {
  it.each(['archive', 'sqlite'] as const)('for a %s artifact', async (kind) => {
    const dataDir = makeLiveDataDir();
    const artifact =
      kind === 'archive' ? await makeArchive(work, { whens: [1000] }) : fakeDb(`src-${kind}.db`, [1000]);
    const before = snapshot(dataDir);
    const scratch = path.join(work, `scratch-${kind}`);
    prepareRestore(artifact, { dataDir, scratchDir: scratch, migrationsFolder: fakeJournal(4, kind), now: new Date() });
    expect(snapshot(dataDir)).toEqual(before); // not one byte of live data moved
  });

  it('leaves live data untouched when validation throws mid-prepare', async () => {
    const dataDir = makeLiveDataDir();
    const before = snapshot(dataDir);
    const hostile = await makeHostileArchive(work);
    expect(() =>
      prepareRestore(hostile, {
        dataDir,
        scratchDir: path.join(work, 'scratch-bad'),
        migrationsFolder: fakeJournal(4, 'bad'),
        now: new Date(),
      }),
    ).toThrowError(RestoreError);
    expect(snapshot(dataDir)).toEqual(before);
  });
});

describe('MUST-20.22: commitRestore replays idempotently', () => {
  it('a second full run is a no-op', async () => {
    const dataDir = makeLiveDataDir();
    const artifact = await makeArchive(work, { whens: [1000] });
    const plan = prepareRestore(artifact, {
      dataDir,
      scratchDir: path.join(work, 'sc1'),
      migrationsFolder: fakeJournal(4, 'replay1'),
      now: new Date(),
    });
    commitRestore(plan, { dataDir });
    const afterFirst = snapshot(dataDir);
    commitRestore(plan, { dataDir }); // exactly what a resumed boot does
    expect(snapshot(dataDir)).toEqual(afterFirst);
  });

  it('an interruption after ANY step replays to the identical final state', async () => {
    const referenceDataDir = makeLiveDataDir();
    const referenceArtifact = await makeArchive(work, { whens: [1000] });
    const migrationsFolder = fakeJournal(4, 'reference');
    const now = new Date('2026-08-16T21:00:00Z');
    const referencePlan = prepareRestore(referenceArtifact, {
      dataDir: referenceDataDir,
      scratchDir: path.join(work, 'ref'),
      migrationsFolder,
      now,
    });
    commitRestore(referencePlan, { dataDir: referenceDataDir });
    const reference = snapshot(referenceDataDir);

    // Build one probe plan purely to learn how many steps a real archive restore has.
    const probeDataDir = makeLiveDataDir();
    const probeArtifact = await makeArchive(work, { whens: [1000] });
    const probePlan = prepareRestore(probeArtifact, {
      dataDir: probeDataDir,
      scratchDir: path.join(work, 'probe'),
      migrationsFolder,
      now,
    });

    for (let cut = 0; cut <= probePlan.steps.length; cut += 1) {
      const dataDir = makeLiveDataDir();
      const artifact = await makeArchive(work, { whens: [1000] });
      const scratch = path.join(work, `cut-${cut}`);
      const plan = prepareRestore(artifact, { dataDir, scratchDir: scratch, migrationsFolder, now });
      try {
        // "killed" after `cut` steps: a real SIGKILL never lets commitRestore reach its own
        // return statement, so a truncated run throwing while trying to report on a
        // still-incomplete database (e.g. budget.db mid-flight-missing) is exactly what
        // "killed here" looks like — never observed by anything, and never a real error.
        commitRestore({ ...plan, steps: plan.steps.slice(0, cut) }, { dataDir });
      } catch {
        /* simulated kill */
      }
      commitRestore(plan, { dataDir }); // the next boot resumes
      expect(snapshot(dataDir)).toEqual(reference);
    }
  });

  it('an interruption during a bare-db restore also replays to the identical final state', () => {
    const migrationsFolder = fakeJournal(4, 'bare-replay');
    const now = new Date('2026-08-16T21:30:00Z');

    const referenceDataDir = makeLiveDataDir();
    const referenceArtifact = fakeDb('reference-bare.db', [1000]);
    const referencePlan = prepareRestore(referenceArtifact, {
      dataDir: referenceDataDir,
      scratchDir: path.join(work, 'bare-ref'),
      migrationsFolder,
      now,
    });
    commitRestore(referencePlan, { dataDir: referenceDataDir });
    const referenceDbHash = createHash('sha256')
      .update(fs.readFileSync(path.join(referenceDataDir, 'budget.db')))
      .digest('hex');
    const referenceReceiptNames = fs.readdirSync(path.join(referenceDataDir, 'receipts')).sort();

    for (let cut = 0; cut <= referencePlan.steps.length; cut += 1) {
      const dataDir = makeLiveDataDir();
      const artifact = fakeDb(`bare-cut-${cut}.db`, [1000]);
      const plan = prepareRestore(artifact, {
        dataDir,
        scratchDir: path.join(work, `bare-cut-${cut}`),
        migrationsFolder,
        now,
      });
      try {
        commitRestore({ ...plan, steps: plan.steps.slice(0, cut) }, { dataDir });
      } catch {
        /* simulated kill */
      }
      commitRestore(plan, { dataDir });

      const dbHash = createHash('sha256').update(fs.readFileSync(path.join(dataDir, 'budget.db'))).digest('hex');
      expect(dbHash).toBe(referenceDbHash);
      // MUST-12.9: receipts/ is never renamed, emptied or modified by a bare-db restore.
      expect(fs.readdirSync(path.join(dataDir, 'receipts')).sort()).toEqual(referenceReceiptNames);
    }
  });
});

describe('T1 re-review D1: incoming-step replay clears stale WAL/SHM sidecars, not just the main file', () => {
  /**
   * Fabricates a "dirty" WAL-mode SQLite file whose real content lives only in an
   * un-checkpointed -wal file — exactly what a getDb() call followed by an unclean process
   * death leaves behind. Captures the raw bytes from a live connection BEFORE closing it,
   * because closing the last connection to a WAL database triggers SQLite's own automatic
   * checkpoint, which would erase the very evidence this test needs to plant.
   */
  function makeDirtyWalImpostor(destDbPath: string): void {
    const tmpFile = path.join(work, `impostor-src-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(tmpFile);
    db.pragma('journal_mode = WAL');
    db.exec('create table impostor_marker (id integer primary key)');
    db.exec('insert into impostor_marker default values');
    fs.copyFileSync(tmpFile, destDbPath);
    const walSrc = `${tmpFile}-wal`;
    if (fs.existsSync(walSrc)) fs.copyFileSync(walSrc, `${destDbPath}-wal`);
    const shmSrc = `${tmpFile}-shm`;
    if (fs.existsSync(shmSrc)) fs.copyFileSync(shmSrc, `${destDbPath}-shm`);
    db.close();
  }

  it('an impostor db with an alien, unapplied -wal at the live path is fully replaced, not silently merged', async () => {
    const dataDir = makeLiveDataDir();
    const artifact = await makeArchive(work, { whens: [1000] });
    const migrationsFolder = fakeJournal(4, 'd1');
    const now = new Date('2026-08-16T22:00:00Z');
    const plan = prepareRestore(artifact, {
      dataDir,
      scratchDir: path.join(work, 'd1-scratch'),
      migrationsFolder,
      now,
    });

    const dbStepIndex = plan.steps.findIndex(
      (step) => step.op === 'rename' && step.incoming && step.to === path.join(dataDir, 'budget.db'),
    );
    expect(dbStepIndex).toBeGreaterThan(-1);

    // Run every step up to (but not including) the final incoming db rename for real — the
    // exact state a boot finds after a PRIOR attempt wrongly reached getDb() following a
    // failed commit, then died before the real payload's db rename ever ran.
    try {
      commitRestore({ ...plan, steps: plan.steps.slice(0, dbStepIndex) }, { dataDir, now });
    } catch {
      /* the steps themselves ran; only the truncated call's own result-reporting throws
         (budget.db does not exist yet at this halfway point) */
    }

    const dbTarget = path.join(dataDir, 'budget.db');
    expect(fs.existsSync(dbTarget)).toBe(false);
    makeDirtyWalImpostor(dbTarget);
    expect(fs.existsSync(`${dbTarget}-wal`)).toBe(true);

    // Resume: only the final incoming db-rename step remains.
    commitRestore(plan, { dataDir, now });

    expect(fs.existsSync(`${dbTarget}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbTarget}-shm`)).toBe(false);

    const finalDb = new Database(dbTarget, { readonly: true });
    try {
      const tables = new Set(
        (finalDb.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      // The real payload, not the impostor merged in via WAL replay (the exact silent
      // corruption a stray sidecar would otherwise cause).
      expect(tables.has('impostor_marker')).toBe(false);
      expect(tables.has('users')).toBe(true);
      expect(finalDb.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      finalDb.close();
    }
  });
});

describe('restoreFromArtifact (unchanged behaviour, re-expressed in terms of prepare/commit)', () => {
  it('produces the same RestoreResult shape as the direct prepare+commit path', async () => {
    const dataDir = makeLiveDataDir();
    const artifact = await makeArchive(work, { whens: [1000] });
    const result = restoreFromArtifact(artifact, { dataDir, now: new Date('2026-08-16T12:00:00.000Z') });
    expect(result.kind).toBe('archive');
    expect(result.databaseRestored).toBe(true);
    expect(result.receiptsMovedAside).toMatch(/^receipts\.pre-restore-/);
  });
});
