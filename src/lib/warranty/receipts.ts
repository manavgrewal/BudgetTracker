import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readEnv } from '@/lib/env';
import { extForMime, type ReceiptMime } from '@/lib/warranty/sniff';

/** §17.2: 10 x 1024^2, not 10,000,000. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 5;
export const MAX_UPLOAD_BYTES = MAX_RECEIPT_BYTES * MAX_FILES_PER_UPLOAD;

/** 24 h age guard so the sweep cannot race an in-flight upload (MUST-4.9). */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** randomUUID() always emits lowercase hex in the canonical 8-4-4-4-12 shape (MUST-4.3). */
export const STORED_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

export class ReceiptStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptStorageError';
  }
}

/** MUST-4.1: inside the existing bind-mounted data volume, beside budget.db and backups/. */
export function receiptsDir(): string {
  return path.join(readEnv().dataDir, 'receipts');
}

/** The existing ${DATA_DIR}/tmp, already swept by purgeStagedFiles()'s 24 h mtime rule. */
export function receiptTempDir(): string {
  return path.join(readEnv().dataDir, 'tmp');
}

/**
 * MUST-4.3, two independent lines of defence, modelled on resolveSafeTarget() in
 * src/lib/backup.ts: (a) the name must match STORED_NAME_RE, and (b) the resolved path
 * must still land directly inside the receipts directory. Both run before any fs call.
 */
export function resolveReceiptPath(storedFilename: string): string {
  if (!STORED_NAME_RE.test(storedFilename)) {
    throw new ReceiptStorageError(`Refusing unsafe receipt filename: ${storedFilename}`);
  }
  const resolvedDir = path.resolve(receiptsDir());
  const target = path.resolve(resolvedDir, storedFilename);
  if (path.dirname(target) !== resolvedDir) {
    throw new ReceiptStorageError('Refusing to touch a receipt outside its directory');
  }
  return target;
}

/** MUST-4.2: the extension comes from the SNIFFED type only. */
export function newStoredFilename(mime: ReceiptMime): string {
  return `${randomUUID()}.${extForMime(mime)}`;
}

/**
 * adoptReceiptFile's other half of the double guard: resolveReceiptPath locks down
 * the *destination*, this locks down the *source*. Without it, adoptReceiptFile would
 * renameSync() any path a caller passed it — e.g. ${DATA_DIR}/budget.db — into receipts/
 * under a fresh, innocuous-looking UUID name, making it downloadable as a "receipt".
 * Only a file that already lives directly inside the staging directory (${DATA_DIR}/tmp,
 * where writeReceiptFile and the staged-upload flow both put files) may be adopted.
 */
function resolveStagedSourcePath(sourcePath: string): string {
  const resolvedTmpDir = path.resolve(receiptTempDir());
  const resolvedSource = path.resolve(sourcePath);
  if (path.dirname(resolvedSource) !== resolvedTmpDir) {
    throw new ReceiptStorageError('Refusing to adopt a file outside the staging directory');
  }
  return resolvedSource;
}

export function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256FileSync(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

/**
 * MUST-4.7 write order: buffer -> write to ${DATA_DIR}/tmp -> renameSync into receipts/
 * (same filesystem, atomic). The caller inserts the DB row afterwards and unlinks on failure.
 */
export function writeReceiptFile(buf: Buffer, mime: ReceiptMime): string {
  const tmpDir = receiptTempDir();
  fs.mkdirSync(tmpDir, { recursive: true });
  const storedFilename = newStoredFilename(mime);
  const tmpPath = path.join(tmpDir, storedFilename);
  fs.writeFileSync(tmpPath, buf);
  return adoptReceiptFile(tmpPath, mime, storedFilename);
}

/**
 * Renames an already-written file into receipts/. `reuseName` is used only by
 * writeReceiptFile, which has already generated the stored name for the tmp path.
 *
 * The source must already live directly inside the staging directory (enforced by
 * resolveStagedSourcePath) — this is the load-bearing guard against adopting an
 * arbitrary path on the same volume. The destination goes through the same
 * STORED_NAME_RE + resolved-path-prefix double guard as every other receipt path
 * (resolveReceiptPath).
 *
 * renameSync() preserves the source file's mtime, so a staged file that has been
 * sitting around for a while (close to, or past, ORPHAN_MIN_AGE_MS) would otherwise
 * become instantly eligible for purgeOrphanReceipts() the moment it lands in
 * receipts/ — a silent receipt loss if the DB insert that makes it "known" hasn't
 * committed yet by the time a sweep runs. Stamping the mtime to "now" on adoption
 * makes mtime mean "adopted at", not "originally written at", closing that window.
 */
export function adoptReceiptFile(sourcePath: string, mime: ReceiptMime, reuseName?: string): string {
  const resolvedSource = resolveStagedSourcePath(sourcePath);
  const dir = receiptsDir();
  fs.mkdirSync(dir, { recursive: true });
  const storedFilename = reuseName ?? newStoredFilename(mime);
  const target = resolveReceiptPath(storedFilename);
  fs.renameSync(resolvedSource, target);
  const now = new Date();
  fs.utimesSync(target, now, now);
  return storedFilename;
}

export function receiptFileExists(storedFilename: string): boolean {
  try {
    return fs.existsSync(resolveReceiptPath(storedFilename));
  } catch {
    return false;
  }
}

export function receiptFileSize(storedFilename: string): number | null {
  try {
    return fs.statSync(resolveReceiptPath(storedFilename)).size;
  } catch {
    return null;
  }
}

/** MUST-4.8: a failed unlink is logged, never surfaced as an error, and swept later. */
export function deleteReceiptFile(storedFilename: string): void {
  try {
    fs.rmSync(resolveReceiptPath(storedFilename), { force: true });
  } catch (error) {
    console.warn(`[warranty] could not unlink receipt ${storedFilename}`, error);
  }
}

/**
 * MUST-4.9: files in receipts/ with no matching stored_filename row AND an mtime older
 * than 24 h are removed. Entries that do not match STORED_NAME_RE are left alone — this
 * sweep deletes only files it could itself have created.
 *
 * `known` should be the set of stored_filename values currently in the database,
 * queried by the caller as close as possible to — and, where the caller controls
 * ordering, strictly AFTER — this function's directory read. writeReceiptFile's write
 * order (write the file, then insert its DB row; MUST-4.7) means a just-adopted file
 * can briefly exist on disk before its row commits. Reading `known` too early widens
 * that race window. adoptReceiptFile() closes the same window from the other side by
 * stamping the file's mtime to "now" on adoption, so a file caught mid-insert is still
 * protected by the age check even if it isn't (yet) in `known`.
 */
export function purgeOrphanReceipts(
  known: Set<string>,
  olderThanMs: number = ORPHAN_MIN_AGE_MS,
  now: Date = new Date(),
): number {
  const dir = receiptsDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!STORED_NAME_RE.test(entry)) continue;
    if (known.has(entry)) continue;
    const file = path.join(dir, entry);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      continue;
    }
    // A directory can't be a receipt; never let one abort the nightly sweep (Ruling P14).
    if (!stats.isFile()) continue;
    if (now.getTime() - stats.mtimeMs <= olderThanMs) continue;
    fs.rmSync(file, { force: true });
    removed += 1;
  }
  return removed;
}
