import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readEnv } from '@/lib/env';

export class StagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function stagingDir(): string {
  return path.join(readEnv().dataDir, 'tmp');
}

export function stagedFilePath(stagingId: string): string {
  // Path-traversal guard: only a UUID may ever reach path.join.
  if (!UUID_RE.test(stagingId)) throw new StagingError('Invalid staging id');
  return path.join(stagingDir(), `${stagingId}.csv`);
}

export function writeStagedFile(buf: Buffer): string {
  const dir = stagingDir();
  fs.mkdirSync(dir, { recursive: true });
  const stagingId = randomUUID();
  fs.writeFileSync(path.join(dir, `${stagingId}.csv`), buf);
  return stagingId;
}

export function readStagedFile(stagingId: string): Buffer {
  const file = stagedFilePath(stagingId);
  if (!fs.existsSync(file)) throw new StagingError('Staged upload not found or expired');
  return fs.readFileSync(file);
}

export function deleteStagedFile(stagingId: string): void {
  const file = stagedFilePath(stagingId);
  fs.rmSync(file, { force: true });
}

export function purgeStagedFiles(olderThanMs: number = DEFAULT_TTL_MS, now: Date = new Date()): number {
  const dir = stagingDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      continue;
    }
    const aged = now.getTime() - stats.mtimeMs > olderThanMs;
    // Ruling P14 (both halves): this directory is also where buildArchive()
    // (src/lib/backup/archive.ts) stages a whole backup archive (budget.db + receipts/)
    // under a `<uuid>-archive` subdirectory while a backup is being written. A directory
    // can't be a staged upload, and fs.rmSync on a directory without { recursive: true }
    // throws (EISDIR/ENOTEMPTY) — so directories in general are left alone, or a stale one
    // would crash the entire nightly maintenance sweep. But a `-archive` directory left
    // behind by a container killed mid-backup holds a full copy of the database (and,
    // transiently, hard-linked receipts) — leaving THAT alone forever leaks disk space
    // without bound. Once one is old enough that no backup could still be writing it, it is
    // safe, and necessary, to remove it recursively. Any other directory shape is left
    // completely untouched: this sweep only ever removes things it can positively identify
    // as its own leftovers.
    //
    // MUST-20.32: `<uuid>-restore` is the same argument, for the same reason, one entry
    // point later — src/lib/backup/restore.ts's stageRestore() builds one of these under
    // this same DATA_DIR/tmp while validating and staging a restore, and a container killed
    // mid-stage leaves it behind holding a hard-linked (or copied) backup payload. Same age
    // constant, same "only removed once nothing could still be writing it" reasoning.
    if (stats.isDirectory()) {
      if (aged && (entry.endsWith('-archive') || entry.endsWith('-restore'))) {
        fs.rmSync(file, { recursive: true, force: true });
        removed += 1;
      }
      continue;
    }
    if (aged) {
      fs.rmSync(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}
