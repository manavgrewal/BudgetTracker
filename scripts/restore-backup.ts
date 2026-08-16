#!/usr/bin/env node
/**
 * Rescue tool: restore a Budget Tracker backup artifact into a data directory.
 *
 * Run it with the container STOPPED (MUST-12.4). There is deliberately no in-app restore
 * button: restoring under a live SQLite connection is how you corrupt a database.
 *
 *   docker compose down
 *   docker compose run --rm --entrypoint node budget-tracker \
 *     --experimental-strip-types scripts/restore-backup.ts /data/backups/budget-2026-08-16.tar.gz
 *   docker compose up -d
 *
 * ...or, from a checkout:  npm run restore-backup -- <artifact> [--data-dir ./data]
 *
 * This script is DELIBERATELY self-contained, exactly like scripts/reset-admin-password.ts:
 * the runtime image ships Next's standalone output, which does not include the project's
 * src/ tree, so the "@/..." import alias cannot resolve in the container. It therefore talks
 * to node-tar and better-sqlite3 directly — both are already present in the image.
 *
 * tests/scripts/restore-backup.test.ts pins RESTORE_STORED_NAME_RE against
 * src/lib/warranty/receipts.ts so the two can never drift apart unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
 * Fix report M10: the original allow-list checked entry NAMES only, so an archive whose
 * top-level `receipts` entry was itself a plain file (rather than a directory) — or whose
 * `budget.db` was a directory — passed the name check and only failed later, deeper in
 * extraction, in a less predictable way. Every accepted name now also pins the expected
 * entry TYPE.
 */
function assertArchiveEntriesAreSafe(artifactPath: string): void {
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

function replaceDatabase(source: string, dataDir: string): void {
  const target = path.join(dataDir, 'budget.db');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(source, target);
  // MUST-12.7: SQLite runs in WAL mode and would otherwise replay the OLD write-ahead log
  // over the database you just restored.
  fs.rmSync(`${target}-wal`, { force: true });
  fs.rmSync(`${target}-shm`, { force: true });
}

export function restoreFromArtifact(
  artifactPath: string,
  opts: { dataDir: string; now?: Date },
): RestoreResult {
  if (!fs.existsSync(artifactPath)) throw new RestoreError(`No such artifact: ${artifactPath}`);
  const kind = detectArtifactKind(artifactPath);
  const dataDir = path.resolve(opts.dataDir);
  const receiptsPath = path.join(dataDir, 'receipts');

  if (kind === 'unknown') {
    throw new RestoreError(
      'That file is neither a v1.1 .tar.gz archive nor a v1.0 SQLite backup. Nothing was changed.',
    );
  }

  if (kind === 'sqlite') {
    // MUST-12.9: a DB-only artifact says nothing about receipts. Do NOT delete, empty or
    // modify data/receipts/ — treating silence as "delete them" would destroy files the
    // backup was never responsible for.
    replaceDatabase(artifactPath, dataDir);
    return {
      kind,
      databaseRestored: true,
      receiptsRestored: 0,
      receiptsMovedAside: null,
      missingReceiptRows: countMissingReceiptRows(path.join(dataDir, 'budget.db'), receiptsPath),
    };
  }

  assertArchiveEntriesAreSafe(artifactPath);

  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const stage = path.join(dataDir, `.restore-${stamp}`);
  fs.mkdirSync(stage, { recursive: true });
  let movedAside: string | null = null;

  try {
    tar.extract({ file: artifactPath, cwd: stage, sync: true, preservePaths: false, strip: 0 });

    const extractedDb = path.join(stage, 'budget.db');
    if (!fs.existsSync(extractedDb)) throw new RestoreError('The archive contains no budget.db.');
    // Fix report IMPORTANT 4, MUST-12.5 continued: the tar-slip allow-list only constrains
    // entry NAMES and TYPES, not file CONTENT — an archive can be a perfectly well-formed
    // gzip+tar with a `budget.db` entry that is a File but not actually a SQLite database
    // (garbage bytes, a text file, anything). Verify it by the same magic-byte check used
    // for the whole artifact BEFORE touching the live database: "refuse and touch nothing"
    // must hold for the inside of the archive too, not just its outer envelope. This check
    // runs before replaceDatabase() and before the receipts/ rename-aside below — nothing in
    // dataDir has been modified yet at this point, so throwing here truly leaves the live
    // install untouched.
    if (detectArtifactKind(extractedDb) !== 'sqlite') {
      throw new RestoreError("The archive's budget.db is not a valid SQLite database. Nothing was changed.");
    }
    replaceDatabase(extractedDb, dataDir);

    const extractedReceipts = path.join(stage, 'receipts');
    // MUST-12.8: non-destructive. The existing directory is RENAMED aside, never deleted —
    // recovering from a mistaken restore is a rename.
    if (fs.existsSync(receiptsPath)) {
      movedAside = `receipts.pre-restore-${stamp}`;
      fs.renameSync(receiptsPath, path.join(dataDir, movedAside));
    }
    fs.mkdirSync(receiptsPath, { recursive: true });
    let restored = 0;
    if (fs.existsSync(extractedReceipts)) {
      for (const entry of fs.readdirSync(extractedReceipts)) {
        if (!RESTORE_STORED_NAME_RE.test(entry)) continue;
        fs.renameSync(path.join(extractedReceipts, entry), path.join(receiptsPath, entry));
        restored += 1;
      }
    }

    return {
      kind,
      databaseRestored: true,
      receiptsRestored: restored,
      receiptsMovedAside: movedAside,
      missingReceiptRows: countMissingReceiptRows(path.join(dataDir, 'budget.db'), receiptsPath),
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function resolveDataDir(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const flag = argv.indexOf('--data-dir');
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  return env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : '/data';
}

/**
 * Returns the artifact path: the first positional argument, i.e. the first entry that is
 * neither `--data-dir` nor the value immediately following it. Written as an explicit index
 * walk (not `argv.indexOf(arg)` inside a `.find()`) so a duplicated value — e.g. the artifact
 * path happening to equal the `--data-dir` value, or `--data-dir` appearing twice — cannot
 * make `indexOf` resolve to the wrong occurrence.
 */
function resolveArtifactArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir') {
      i += 1; // skip its value
      continue;
    }
    if (!argv[i].startsWith('--')) return argv[i];
  }
  return undefined;
}

function usage(): void {
  console.log(`Restore a Budget Tracker backup artifact into a data directory.

Usage:
  node --experimental-strip-types scripts/restore-backup.ts <artifact.tar.gz|artifact.db> [--data-dir /data]

Run this with the container STOPPED — restoring under a live SQLite connection is how you
corrupt a database. See INSTALL.md -> "Restoring from a backup".

  docker compose down
  docker compose run --rm --entrypoint node budget-tracker \\
    --experimental-strip-types scripts/restore-backup.ts /data/backups/budget-2026-08-16.tar.gz
  docker compose up -d

Both artifact shapes are accepted, detected by content, not filename:
  - a v1.1+ ".tar.gz" archive containing budget.db and every receipt file
  - a v1.0.0 bare ".db" SQLite snapshot (receipts/ is left completely untouched)

Data directory: --data-dir, else $DATA_DIR, else /data.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const artifact = resolveArtifactArg(argv);
  if (!artifact) {
    console.error('Usage: restore-backup <artifact.tar.gz|artifact.db> [--data-dir /data]');
    console.error('Stop the container first. See INSTALL.md -> "Restoring from a backup".');
    process.exit(1);
  }
  const dataDir = resolveDataDir(argv);
  const result = restoreFromArtifact(artifact, { dataDir });
  console.log(`Restored ${result.kind === 'archive' ? 'archive' : 'database-only backup'} into ${dataDir}`);
  console.log(`  database restored: ${result.databaseRestored}`);
  console.log(`  receipt files restored: ${result.receiptsRestored}`);
  if (result.receiptsMovedAside) console.log(`  previous receipts kept at: ${result.receiptsMovedAside}`);
  // MUST-12.9: an explicit count, so a cross-version restore is honest about what is missing.
  console.log(`  ${result.missingReceiptRows} receipt rows reference files that are not present on disk.`);
}

// Only run when invoked directly, so the test file can import the functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
