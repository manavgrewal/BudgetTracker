/**
 * Shared restore logic for BOTH the CLI (scripts/restore-backup.ts, run under
 * `node --experimental-strip-types` outside any bundler) and the app-side boot hook
 * (src/lib/backup/restore.ts, bundled into Next's server build). Neither side may import
 * the other, so this module is the third party both of them import instead (MUST-20.4):
 *
 *   - alias-free: only `node:*`, `better-sqlite3`, `tar`, and relative siblings. No `@/…`
 *     import may ever appear here — tests/ops/restore-seams.test.ts pins that with a source
 *     scan, not a convention.
 *   - parameterised, never environment-reading: every exported function that needs a path
 *     takes it as an argument. Nothing here calls readEnv(), reads process.env, or calls
 *     process.cwd().
 *   - erasable-syntax only: no enum, no namespace, no parameter properties, because
 *     `--experimental-strip-types` erases types rather than compiling them.
 *
 * Every consumer imports this file with the explicit '.ts' extension: Node's type-stripping
 * loader does no extension resolution, and Vitest/webpack both accept the explicit extension
 * too, so one specifier works for all three.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import * as tar from 'tar';

/** Must stay identical to STORED_NAME_RE in src/lib/warranty/receipts.ts. */
export const RESTORE_STORED_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

export type ArtifactKind = 'archive' | 'sqlite' | 'unknown';

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface RestoreResult {
  kind: ArtifactKind;
  databaseRestored: boolean;
  receiptsRestored: number;
  /** The directory the previous receipts/ was renamed to, or null when there was none. */
  receiptsMovedAside: string | null;
  missingReceiptRows: number;
  /** How many pre-existing receipt files had their mtime re-armed to "now" after a bare-db restore. */
  receiptsTouched: number;
}

const SQLITE_MAGIC = 'SQLite format 3\0';

/** MUST-12.5: format detection is by magic bytes, NEVER by file extension. */
export function detectArtifactKind(filePath: string): ArtifactKind {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  let read = 0;
  try {
    read = fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'archive';
  if (read >= 16 && head.toString('binary') === SQLITE_MAGIC) return 'sqlite';
  return 'unknown';
}

/**
 * MUST-12.6, tar-slip defence: extraction accepts ONLY the entry `budget.db` (a File),
 * `receipts` (a Directory), and entries matching `receipts/<STORED_NAME_RE>` (each a File).
 * Absolute paths, `..` segments, symlinks, hardlinks, device nodes, a `budget.db` that is
 * itself a directory, a `receipts` that is itself a plain file, and anything else abort the
 * whole restore. This runs as a FIRST PASS over the archive listing, before a single byte is
 * written, so "reject" really does mean "abort" and not "skip". node-tar's own protections
 * are relied on IN ADDITION TO this allow-list.
 *
 * MUST-20.4: this is the same function, moved — not a second copy of the tar-slip defence.
 */
export function assertArchiveEntriesAreSafe(artifactPath: string): void {
  const problems: string[] = [];
  tar.list({
    file: artifactPath,
    sync: true,
    onReadEntry: (entry) => {
      const name = entry.path.replace(/\/+$/, '');
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        problems.push(`${entry.path} (${entry.type})`);
        return;
      }
      if (path.isAbsolute(name) || name.split('/').includes('..')) {
        problems.push(entry.path);
        return;
      }
      if (name === 'budget.db') {
        if (entry.type !== 'File') problems.push(`${entry.path} (expected a file)`);
        return;
      }
      if (name === 'receipts') {
        if (entry.type !== 'Directory') problems.push(`${entry.path} (expected a directory)`);
        return;
      }
      const match = /^receipts\/(.+)$/.exec(name);
      if (match === null || !RESTORE_STORED_NAME_RE.test(match[1]) || entry.type !== 'File') {
        problems.push(entry.path);
      }
    },
  });
  if (problems.length > 0) {
    throw new RestoreError(`Refusing to extract unexpected archive entries: ${problems.join(', ')}`);
  }
}

/** MUST-12.9: how many warranty_receipts rows point at a file that is not on disk. */
function countMissingReceiptRows(databasePath: string, receiptsPath: string): number {
  const db = new Database(databasePath, { readonly: true });
  try {
    const table = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'warranty_receipts'")
      .get();
    if (!table) return 0; // a genuine v1.0.0 artifact has no such table
    const rows = db.prepare('select stored_filename from warranty_receipts').all() as {
      stored_filename: string;
    }[];
    return rows.filter((row) => !fs.existsSync(path.join(receiptsPath, row.stored_filename))).length;
  } finally {
    db.close();
  }
}

/**
 * MUST-4.9 / MUST-12.9's mtime re-arm: re-arms purgeOrphanReceipts' 24 h grace window for
 * every file already sitting in receiptsPath, by stamping its mtime to `now`.
 *
 * Without this, a bare-db restore replaces budget.db with a snapshot that references few or
 * zero receipt files — by design (MUST-12.9) receipts/ itself is left completely untouched —
 * while every file already in that directory keeps whatever mtime it had before the restore,
 * which after any real amount of uptime is well past 24 h old. The very next nightly
 * runMaintenanceSweep() then calls purgeOrphanReceipts() with that freshly-restored
 * (near-empty) known set, and every one of those "too old" files reads as an orphan.
 * Stamping every file's mtime to "now" buys the operator time to reconcile.
 *
 * `fs.utimesSync` is wrapped per-file in its own try/catch so one EPERM/read-only file does
 * not throw after the restore has otherwise succeeded; `receiptsTouched` counts only the
 * files actually touched.
 */
export function touchReceiptFiles(receiptsPath: string, now: Date): number {
  if (!fs.existsSync(receiptsPath)) return 0;
  let touched = 0;
  for (const entry of fs.readdirSync(receiptsPath)) {
    const file = path.join(receiptsPath, entry);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.utimesSync(file, now, now);
      touched += 1;
    } catch (error) {
      console.warn(`[restore] could not refresh mtime on ${entry}, skipping:`, error);
    }
  }
  return touched;
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export interface MigrationCounts {
  count: number;
  maxWhen: number;
}

export function readLocalMigrations(migrationsFolder: string): MigrationCounts {
  const journal = path.join(migrationsFolder, 'meta', '_journal.json');
  // MUST-20.12: every error that can end up in restore-result.json must be a written,
  // operator-readable RestoreError, never a raw ENOENT/parse SyntaxError bubbling up from a
  // filesystem primitive.
  let raw: string;
  try {
    raw = fs.readFileSync(journal, 'utf8');
  } catch {
    throw new RestoreError('Could not read the local migrations journal. The installation may be corrupted.');
  }
  let parsed: { entries?: { when?: number }[] };
  try {
    parsed = JSON.parse(raw) as { entries?: { when?: number }[] };
  } catch {
    throw new RestoreError('The local migrations journal is not valid JSON. The installation may be corrupted.');
  }
  const entries = parsed.entries ?? [];
  return {
    count: entries.length,
    maxWhen: entries.reduce((max, entry) => Math.max(max, Number(entry.when ?? 0)), 0),
  };
}

export function readAppliedMigrations(databasePath: string): MigrationCounts {
  const db = new Database(databasePath, { readonly: true });
  try {
    const table = db
      .prepare("select name from sqlite_master where type='table' and name='__drizzle_migrations'")
      .get();
    // A pre-migrator or hand-made database: zero applied, and forward migration is exactly
    // what should happen to it. Not an error.
    if (!table) return { count: 0, maxWhen: 0 };
    const row = db
      .prepare('select count(*) as count, coalesce(max(created_at), 0) as maxWhen from __drizzle_migrations')
      .get() as { count: number; maxWhen: number };
    return { count: Number(row.count), maxWhen: Number(row.maxWhen) };
  } finally {
    db.close();
  }
}

/**
 * MUST-20.16. Both conditions are checked because either alone can be fooled: `when` alone
 * misses a migration inserted with an earlier timestamp than the local maximum, and `count`
 * alone misses a reordered journal. Together they are the strongest statement that can be
 * made BEFORE a migration has run — which is the only moment at which the question can
 * honestly be asked.
 */
export function assertNotNewerThanCode(databasePath: string, migrationsFolder: string): number {
  const local = readLocalMigrations(migrationsFolder);
  const backup = readAppliedMigrations(databasePath);
  if (backup.maxWhen > local.maxWhen || backup.count > local.count) {
    throw new RestoreError(
      `This backup was made by a newer version of Budget Tracker than the one running ` +
        `(it carries ${backup.count} applied migrations; this version ships ${local.count}). ` +
        `Upgrade the app first, then restore. Nothing was changed.`,
    );
  }
  return backup.count;
}

/**
 * Controller ruling (T1 review): the one-way guard is a real safety property for the GUI/boot
 * path, which must never be bypassable — but it is also the one thing that can strand an
 * operator who has deliberately rolled the running image back to recover from a bad upgrade
 * and now needs their most recent (newer-schema) backup back. `allowNewer` exists ONLY on the
 * CLI disaster path (scripts/restore-backup.ts's `--allow-newer` flag, default off); the app
 * side (src/lib/backup/restore.ts) never sets it, so the GUI/boot guard cannot be bypassed.
 */
function appliedMigrationsFor(databasePath: string, migrationsFolder: string, allowNewer: boolean | undefined): number {
  if (allowNewer) return readAppliedMigrations(databasePath).count;
  return assertNotNewerThanCode(databasePath, migrationsFolder);
}

const REQUIRED_TABLES = ['users', 'accounts', 'transactions'] as const;

/**
 * MUST-20.14 step 5. Three checks, in increasing cost:
 *   1. magic bytes — a well-formed tar can carry a `budget.db` File entry full of garbage;
 *   2. PRAGMA quick_check — the same class of answer as integrity_check in a fraction of the
 *      time on a multi-gigabyte database, on a path an operator is watching a spinner for;
 *   3. three tables that have existed since 0000_init and will not be renamed — i.e. this is
 *      A BUDGET TRACKER DATABASE, not some other SQLite file that got renamed budget.db.
 */
export function preflightSqliteFile(databasePath: string): void {
  if (detectArtifactKind(databasePath) !== 'sqlite') {
    throw new RestoreError("The archive's budget.db is not a valid SQLite database. Nothing was changed.");
  }
  const db = new Database(databasePath, { readonly: true });
  try {
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') {
      throw new RestoreError(`That backup's database failed an integrity check (${String(check)}). Nothing was changed.`);
    }
    const names = new Set(
      (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    const missing = REQUIRED_TABLES.filter((table) => !names.has(table));
    if (missing.length > 0) {
      throw new RestoreError(
        `That file is a SQLite database but not a usable Budget Tracker database (missing: ${missing.join(', ')}). Nothing was changed.`,
      );
    }
  } finally {
    db.close();
  }
}

export interface ValidationReport {
  kind: 'archive' | 'sqlite';
  bytes: number;
  sha256: string;
  receiptCount: number;
  appliedMigrations: number;
}

/**
 * MUST-20.14: the complete check set, run in order, all fatal. Called twice in the app flow —
 * once by the server action before staging, once again by the boot hook before applying —
 * because the payload has survived a process restart and a filesystem in between by the
 * second call.
 */
export function validateArtifact(
  artifactPath: string,
  opts: { scratchDir: string; migrationsFolder: string; allowNewerMigrations?: boolean },
): ValidationReport {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(artifactPath);
  } catch {
    throw new RestoreError(`No such backup: ${path.basename(artifactPath)}`);
  }
  if (!stats.isFile()) throw new RestoreError('That backup is not a regular file. Nothing was changed.');
  if (stats.size === 0) throw new RestoreError('That backup is empty. Nothing was changed.');

  const kind = detectArtifactKind(artifactPath);
  if (kind === 'unknown') {
    throw new RestoreError(
      'That file is neither a .tar.gz archive nor a SQLite backup. Nothing was changed.',
    );
  }

  if (kind === 'sqlite') {
    preflightSqliteFile(artifactPath);
    return {
      kind,
      bytes: stats.size,
      sha256: sha256File(artifactPath),
      receiptCount: 0,
      appliedMigrations: appliedMigrationsFor(artifactPath, opts.migrationsFolder, opts.allowNewerMigrations),
    };
  }

  assertArchiveEntriesAreSafe(artifactPath); // MUST-12.6, before a byte is written
  fs.mkdirSync(opts.scratchDir, { recursive: true });
  const probe = path.join(opts.scratchDir, 'validate');
  try {
    fs.rmSync(probe, { recursive: true, force: true });
    fs.mkdirSync(probe, { recursive: true });
    tar.extract({ file: artifactPath, cwd: probe, sync: true, preservePaths: false, strip: 0 });
    const inner = path.join(probe, 'budget.db');
    if (!fs.existsSync(inner)) throw new RestoreError('The archive contains no budget.db.');
    preflightSqliteFile(inner);
    const receipts = path.join(probe, 'receipts');
    const receiptCount = fs.existsSync(receipts)
      ? fs.readdirSync(receipts).filter((name) => RESTORE_STORED_NAME_RE.test(name)).length
      : 0;
    return {
      kind,
      bytes: stats.size,
      sha256: sha256File(artifactPath),
      receiptCount,
      appliedMigrations: appliedMigrationsFor(inner, opts.migrationsFolder, opts.allowNewerMigrations),
    };
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

export type RestoreStep =
  | {
      op: 'rename';
      from: string;
      to: string;
      optional?: boolean;
      /**
       * T1 review fix (CRITICAL 1a): true for the two steps whose `from` lives inside this
       * plan's `work/` scratch directory (the incoming database/receipts). Tagged explicitly
       * at plan time, not inferred at replay time, because the replay RULE differs by kind —
       * see runStep()'s docblock.
       */
      incoming?: boolean;
    }
  | { op: 'touch-receipts'; dir: string };

export interface RestorePlan {
  version: 1;
  stamp: string;
  kind: 'archive' | 'sqlite';
  steps: RestoreStep[];
  attempts: number;
  receiptsRestored: number;
  safetyCopy: string | null;
  receiptsMovedAside: string | null;
}

/**
 * MUST-20.7: builds a RestorePlan by validating the artifact and constructing the INCOMING
 * files entirely inside scratchDir — `dataDir` is only ever read here (existence checks, to
 * decide which safety-copy renames apply and to compute the report fields below), never
 * written. That is what makes the crash-safety argument in commitRestore() sound: everything
 * this function does can be safely abandoned with `rm -rf scratchDir` and nothing under
 * `dataDir` will have moved.
 */
export function prepareRestore(
  artifactPath: string,
  opts: {
    dataDir: string;
    scratchDir: string;
    migrationsFolder: string;
    now: Date;
    /** CLI disaster-path only (controller ruling) — see appliedMigrationsFor()'s docblock.
     *  The app/boot path never sets this. */
    allowNewerMigrations?: boolean;
  },
): RestorePlan {
  const dataDir = path.resolve(opts.dataDir);
  const scratchDir = path.resolve(opts.scratchDir);
  const stamp = opts.now.toISOString().replace(/[:.]/g, '-');

  // Validation runs first and is what actually enforces MUST-20.14; if it throws, nothing
  // below has run and nothing under scratchDir or dataDir has been created or touched.
  const report = validateArtifact(artifactPath, {
    scratchDir: path.join(scratchDir, 'validate-probe'),
    migrationsFolder: opts.migrationsFolder,
    allowNewerMigrations: opts.allowNewerMigrations,
  });

  const workDir = path.join(scratchDir, 'work');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const incomingDb = path.join(workDir, 'budget.db.incoming');
  const incomingReceipts = path.join(workDir, 'receipts.incoming');
  let receiptsRestored = 0;

  if (report.kind === 'archive') {
    // validateArtifact() already ran assertArchiveEntriesAreSafe() and cleaned up its own
    // probe extraction in a finally, so this is a fresh, independent extraction — not a
    // second copy of the tar-slip check, just a second look at the same already-vetted bytes.
    tar.extract({ file: artifactPath, cwd: workDir, sync: true, preservePaths: false, strip: 0 });
    fs.renameSync(path.join(workDir, 'budget.db'), incomingDb);
    const extractedReceipts = path.join(workDir, 'receipts');
    fs.mkdirSync(incomingReceipts, { recursive: true });
    if (fs.existsSync(extractedReceipts)) {
      for (const entry of fs.readdirSync(extractedReceipts)) {
        if (!RESTORE_STORED_NAME_RE.test(entry)) continue;
        fs.renameSync(path.join(extractedReceipts, entry), path.join(incomingReceipts, entry));
        receiptsRestored += 1;
      }
    }
  } else {
    fs.copyFileSync(artifactPath, incomingDb);
  }

  const dbTarget = path.join(dataDir, 'budget.db');
  const receiptsTarget = path.join(dataDir, 'receipts');
  const dbExisted = fs.existsSync(dbTarget);
  const receiptsExisted = report.kind === 'archive' && fs.existsSync(receiptsTarget);

  const safetyCopy = dbExisted ? `budget.pre-restore-${stamp}.db` : null;
  const receiptsMovedAside = receiptsExisted ? `receipts.pre-restore-${stamp}` : null;

  // MUST-20.21, in this exact order.
  const steps: RestoreStep[] = [
    { op: 'rename', from: dbTarget, to: path.join(dataDir, `budget.pre-restore-${stamp}.db`), optional: true },
    { op: 'rename', from: `${dbTarget}-wal`, to: path.join(dataDir, `budget.pre-restore-${stamp}.db-wal`), optional: true },
    { op: 'rename', from: `${dbTarget}-shm`, to: path.join(dataDir, `budget.pre-restore-${stamp}.db-shm`), optional: true },
  ];

  if (report.kind === 'archive') {
    // MUST-12.8: the existing receipts/ is renamed aside, never deleted.
    steps.push({ op: 'rename', from: receiptsTarget, to: path.join(dataDir, `receipts.pre-restore-${stamp}`), optional: true });
    steps.push({ op: 'rename', from: incomingReceipts, to: receiptsTarget, incoming: true });
    steps.push({ op: 'rename', from: incomingDb, to: dbTarget, incoming: true });
  } else {
    steps.push({ op: 'rename', from: incomingDb, to: dbTarget, incoming: true });
    // MUST-12.9: receipts/ is never renamed, emptied or modified on a bare-db restore —
    // only its files' mtimes are re-armed, and only after the database itself is in place.
    steps.push({ op: 'touch-receipts', dir: receiptsTarget });
  }

  return {
    version: 1,
    stamp,
    kind: report.kind,
    steps,
    attempts: 0,
    receiptsRestored,
    safetyCopy,
    receiptsMovedAside,
  };
}

/**
 * MUST-20.22. Idempotency is decided from the FILESYSTEM, never from a flag inside the
 * journal: a flag written after the rename has its own crash window, and a flag written
 * before it lies. Two DIFFERENT replay rules, by step KIND — tagged at plan time
 * (`step.incoming`), not inferred, because inferring it from path shape is exactly the bug
 * a T1 review caught:
 *
 * - **Safety-copy steps** (current live path → `*.pre-restore-<stamp>`, `incoming` absent):
 *   `to` is checked FIRST. A later INCOMING step's `to` reuses this step's `from` path (step 1
 *   moves `budget.db` out of the way; the last step renames the incoming database back to
 *   that same path), so by the time a full replay reaches here a second time, `from` may have
 *   been repopulated with the NEW content while this step's own `to` (the safety copy)
 *   already exists from the first run. Checking `to` first recognises "already done"
 *   regardless of what has since moved back into `from`'s place — this is what makes
 *   `commitRestore()` safe to call twice on an already-fully-applied plan.
 * - **Incoming steps** (`work/*.incoming` → the live path, `incoming: true`): `from` is
 *   checked FIRST instead, and — this is the fix — a stale `to` is unconditionally CLEARED
 *   before the rename, never trusted as "already done" on its own. Nothing legitimate can
 *   recreate an incoming step's `from` once it is gone (it lives under this plan's private
 *   `work/` scratch dir), so `from` existing is a completely reliable "not done yet" signal.
 *   The reverse is NOT reliable: if a boot ever continues past a failed, non-exhausted commit
 *   attempt and reaches `getDb()` (it must not — see src/lib/backup/restore.ts's
 *   `applyStagedRestoreOnBoot()` contract), `getDb()` will CREATE an empty `budget.db` at
 *   exactly this step's `to`. A naive `to`-exists-means-done check would then skip installing
 *   the real payload forever, reporting success over an empty database. Checking `from` first
 *   and clearing `to` closes that hole even if the "must not reach getDb()" contract is ever
 *   violated by a caller.
 *
 * touch-receipts always re-touches: it is idempotent by construction (re-stamping an mtime
 * that is already "now" is a no-op in effect). It uses the `now` passed to commitRestore()
 * (defaulting to the real wall clock), not a value captured at plan time, because the grace
 * window it re-arms (MUST-4.9) is measured from whenever the restore actually completes.
 */
function runStep(step: RestoreStep, now: Date): number {
  if (step.op === 'touch-receipts') {
    return touchReceiptFiles(step.dir, now);
  }
  if (step.incoming) {
    if (fs.existsSync(step.from)) {
      fs.rmSync(step.to, { recursive: true, force: true });
      // T1 re-review D1: clearing `to` is not enough if `to` was an impostor SQLite
      // database created in WAL mode (e.g. by a boot that wrongly reached getDb() after a
      // failed, non-exhausted commit) and then died uncleanly — its -wal/-shm sidecars
      // survive the rmSync above, sitting at these exact paths, and SQLite replays a -wal
      // over whatever file it finds at its matching main-file path the moment that path is
      // next opened. Left in place, the impostor's -wal would silently overwrite the REAL
      // payload we are about to install here, and PRAGMA quick_check would still report
      // "ok" afterward (the merged result is structurally valid, just wrong). This is safe
      // unconditionally: any LEGITIMATE -wal/-shm for the path this step replaces was
      // already relocated by the earlier safety-copy steps (their own `rename` ops target
      // `*.pre-restore-<stamp>.db-wal`/`-shm`), and the receipts incoming step's `to` has no
      // such sidecars to begin with, making this a harmless no-op there.
      fs.rmSync(`${step.to}-wal`, { force: true });
      fs.rmSync(`${step.to}-shm`, { force: true });
      fs.renameSync(step.from, step.to);
      return 0;
    }
    if (fs.existsSync(step.to)) return 0;
    if (step.optional) return 0;
    throw new RestoreError(`Restore step cannot be replayed: neither ${step.from} nor ${step.to} exists.`);
  }
  if (fs.existsSync(step.to)) return 0;
  if (fs.existsSync(step.from)) {
    fs.renameSync(step.from, step.to);
    return 0;
  }
  if (step.optional) return 0;
  throw new RestoreError(`Restore step cannot be replayed: neither ${step.from} nor ${step.to} exists.`);
}

/**
 * Replays plan.steps in order. Every step is individually idempotent (see runStep), so
 * calling this twice on the same plan — or once after a previous call was interrupted
 * partway through — converges to the same final state. This is the half of the crash-safety
 * argument that runs AFTER commit.json exists (the point of no return); the half that runs
 * BEFORE it is prepareRestore()'s "writes nothing outside scratchDir" property.
 */
export function commitRestore(plan: RestorePlan, opts: { dataDir: string; now?: Date }): RestoreResult {
  const dataDir = path.resolve(opts.dataDir);
  const now = opts.now ?? new Date();
  let receiptsTouched = 0;
  for (const step of plan.steps) {
    const touched = runStep(step, now);
    if (step.op === 'touch-receipts') receiptsTouched = touched;
  }
  const dbPath = path.join(dataDir, 'budget.db');
  const receiptsPath = path.join(dataDir, 'receipts');
  return {
    kind: plan.kind,
    databaseRestored: true,
    receiptsRestored: plan.receiptsRestored,
    receiptsMovedAside: plan.receiptsMovedAside,
    missingReceiptRows: countMissingReceiptRows(dbPath, receiptsPath),
    receiptsTouched,
  };
}

/**
 * scripts/restore-core.ts lives at <root>/scripts/restore-core.ts; 'drizzle' is a sibling of
 * scripts/. Resolved from import.meta.url rather than process.cwd(), so it is correct
 * regardless of the working directory the CLI happens to be invoked from, and this file never
 * needs to call process.cwd() at all (MUST-20.4).
 */
function defaultMigrationsFolder(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
}

/**
 * MUST-20.7: restoreFromArtifact() is prepareRestore() + commitRestore() + `rm -rf` the
 * scratch dir in a finally, and is re-expressed in these terms so the CLI's observable
 * behaviour is bit-for-bit what it was before the split. Signature and behaviour unchanged
 * from v1.1.0: this is the function tests/scripts/restore-backup.test.ts exercises, and that
 * file must keep passing without a single edit.
 */
export function restoreFromArtifact(
  artifactPath: string,
  opts: {
    dataDir: string;
    now?: Date;
    /** CLI-only (`--allow-newer`, controller ruling): bypasses the one-way migration guard
     *  for an operator who has deliberately rolled the running image back. Never set by the
     *  app/boot path. */
    allowNewerMigrations?: boolean;
  },
): RestoreResult {
  const now = opts.now ?? new Date();
  const dataDir = path.resolve(opts.dataDir);
  const scratch = path.join(dataDir, `.restore-${now.toISOString().replace(/[:.]/g, '-')}`);
  try {
    const plan = prepareRestore(artifactPath, {
      dataDir,
      scratchDir: scratch,
      migrationsFolder: defaultMigrationsFolder(),
      now,
      allowNewerMigrations: opts.allowNewerMigrations,
    });
    // Passing `now` through means commitRestore's single touch-receipts pass uses the exact
    // value the CALLER supplied (tests/scripts/restore-backup.test.ts asserts an exact mtime)
    // rather than a second, separate re-touch pass — one touch, one clock, for every caller.
    return commitRestore(plan, { dataDir, now });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
