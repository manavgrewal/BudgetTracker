import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { create as tarCreate } from 'tar';
import { getSqlite } from '@/db/client';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { STORED_NAME_RE, receiptsDir } from '@/lib/warranty/receipts';

/**
 * MUST-12.1: a backup is a gzipped tar containing
 *     budget.db          (a VACUUM INTO snapshot, not the live file)
 *     receipts/<files>   (every file in ${DATA_DIR}/receipts)
 *
 * node-tar is the archiver: Node ships zlib but no tar writer, and hand-rolling one to save
 * a dependency is the wrong trade on a data-integrity path.
 */
export const ARCHIVE_NAME_RE = /^budget-\d{4}-\d{2}-\d{2}\.tar\.gz$/;
/** MUST-12.3: a v1.0.0 install's existing .db backups stay visible, listed and prunable. */
export const LEGACY_NAME_RE = /^budget-\d{4}-\d{2}-\d{2}\.db$/;
export const ON_DEMAND_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/;
const SNAPSHOT_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/;

export function backupsDir(): string {
  return path.join(readEnv().dataDir, 'backups');
}

export function tempDir(): string {
  return path.join(readEnv().dataDir, 'tmp');
}

/**
 * Controller ruling (b), unchanged from v1.0.0: a VACUUM INTO / archive target must never be
 * built from an attacker-influenced string. Nightly names come only from todayIso()'s fixed
 * YYYY-MM-DD output and on-demand names only from randomUUID(). This refuses any filename
 * that doesn't match its expected shape and confirms the resolved path still lands directly
 * inside the expected directory before any fs call touches it.
 */
export function resolveSafeTarget(dir: string, name: string, pattern: RegExp): string {
  if (!pattern.test(name)) throw new Error(`Refusing unsafe backup filename: ${name}`);
  const resolvedDir = path.resolve(dir);
  const target = path.resolve(resolvedDir, name);
  if (path.dirname(target) !== resolvedDir) {
    throw new Error('Refusing to write a backup outside its directory');
  }
  return target;
}

export function nightlyArchiveName(at: Date = new Date(), tz?: string): string {
  return `budget-${todayIso(at, tz)}.tar.gz`;
}

function vacuumInto(target: string): void {
  // VACUUM cannot be a bound-parameter statement in every SQLite build, so the path is
  // escaped and inlined. Single quotes are doubled per SQLite rules.
  getSqlite().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

/**
 * MUST-12.2: VACUUM INTO a temp snapshot, add it as `budget.db`, add `receipts/`, write the
 * tar+gzip to a `.partial` sibling of the target, then rename it into place — the temp
 * snapshot and the staging directory are unlinked in a `finally` regardless of outcome.
 *
 * The staging directory holds HARD LINKS to the receipts rather than copies, so a 300 MB
 * receipt library is not duplicated on disk while the archive is written. Hard links are
 * read as ordinary files by tar; copyFileSync is the fallback if the filesystem refuses.
 *
 * Atomic write (fix report, IMPORTANT 2): the archive is built as `${targetPath}.partial` —
 * in the SAME directory as the final target, so the final `renameSync` is a same-filesystem
 * (and therefore atomic, even on a NAS-mounted backups dir) move, never a cross-device copy —
 * and renamed into place only once `tarCreate` returns successfully. Without this, the old
 * code deleted any existing same-day artifact BEFORE writing the new one; a crash or thrown
 * error partway through `tarCreate` left a truncated `.tar.gz` at the final name. That
 * filename still matched `ARCHIVE_NAME_RE`, so `listBackups()` would list it and
 * `pruneBackups()` would count it as one of the retained backups — silently evicting a good
 * older backup to make room for a corrupt one, and destroying the previous day's good backup
 * outright when the same target is rewritten (the on-demand and nightly retry paths both
 * reuse the same final name). `ARCHIVE_NAME_RE`/`ON_DEMAND_NAME_RE` are anchored with `$`, so
 * a `name.tar.gz.partial` file never matches either pattern and `listBackups()` already
 * ignores it structurally — nothing else needed there.
 */
export function buildArchive(targetPath: string): void {
  const tmp = tempDir();
  fs.mkdirSync(tmp, { recursive: true });
  const stage = path.join(tmp, `${randomUUID()}-archive`);
  const snapshotName = `${randomUUID()}.db`;
  const snapshot = resolveSafeTarget(tmp, snapshotName, SNAPSHOT_NAME_RE);
  const partialTarget = `${targetPath}.partial`;

  try {
    fs.rmSync(snapshot, { force: true });
    vacuumInto(snapshot);

    fs.mkdirSync(stage, { recursive: true });
    fs.renameSync(snapshot, path.join(stage, 'budget.db'));

    const source = receiptsDir();
    const stagedReceipts = path.join(stage, 'receipts');
    fs.mkdirSync(stagedReceipts, { recursive: true });
    if (fs.existsSync(source)) {
      for (const entry of fs.readdirSync(source)) {
        if (!STORED_NAME_RE.test(entry)) continue;
        const from = path.join(source, entry);
        const to = path.join(stagedReceipts, entry);
        try {
          fs.linkSync(from, to);
        } catch {
          fs.copyFileSync(from, to);
        }
      }
    }

    fs.rmSync(partialTarget, { force: true });
    tarCreate(
      { file: partialTarget, cwd: stage, gzip: true, sync: true, portable: true, follow: false },
      ['budget.db', 'receipts'],
    );
    // Only now, with a complete archive on disk, does the previous artifact at this name
    // (if any) get replaced — and it's replaced atomically by the rename, never by a
    // delete-then-write gap.
    fs.renameSync(partialTarget, targetPath);
  } finally {
    fs.rmSync(snapshot, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(partialTarget, { force: true });
  }
}

/** Settings -> "Download backup now". Built in /data/tmp so it cannot collide with a nightly name. */
export function createOnDemandArchive(): { path: string; bytes: number } {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = resolveSafeTarget(dir, `${randomUUID()}.tar.gz`, ON_DEMAND_NAME_RE);
  buildArchive(target);
  return { path: target, bytes: fs.statSync(target).size };
}
