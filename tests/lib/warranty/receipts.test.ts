import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MAX_FILES_PER_UPLOAD,
  MAX_RECEIPT_BYTES,
  MAX_UPLOAD_BYTES,
  ReceiptStorageError,
  STORED_NAME_RE,
  adoptReceiptFile,
  deleteReceiptFile,
  newStoredFilename,
  purgeOrphanReceipts,
  receiptFileExists,
  receiptFileSize,
  receiptTempDir,
  receiptsDir,
  resolveReceiptPath,
  sha256Bytes,
  sha256FileSync,
  writeReceiptFile,
} from '@/lib/warranty/receipts';
import { sniffReceiptType } from '@/lib/warranty/sniff';

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-receipts-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('constants', () => {
  it('caps a receipt at 10 MiB and an upload at five of them (§17.2, §17.22)', () => {
    expect(MAX_RECEIPT_BYTES).toBe(10485760);
    expect(MAX_FILES_PER_UPLOAD).toBe(5);
    expect(MAX_UPLOAD_BYTES).toBe(10485760 * 5);
  });
});

describe('STORED_NAME_RE', () => {
  it('accepts a lowercase UUID with an accepted extension', () => {
    for (const ext of ['jpg', 'png', 'webp', 'pdf']) {
      expect(STORED_NAME_RE.test(`${crypto.randomUUID()}.${ext}`)).toBe(true);
    }
  });

  it('rejects traversal, subpaths, wrong extensions, uppercase hex and a bare UUID', () => {
    const uuid = crypto.randomUUID();
    for (const bad of [
      '../../etc/passwd',
      'a/b.jpg',
      `../${uuid}.jpg`,
      'x.exe',
      `${uuid}.exe`,
      uuid.toUpperCase() + '.jpg',
      uuid,
      `${uuid}.jpg.exe`,
      `${uuid}.JPG`,
      '',
    ]) {
      expect(STORED_NAME_RE.test(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('resolveReceiptPath', () => {
  it('lands directly inside the receipts directory', () => {
    const name = newStoredFilename('image/jpeg');
    expect(resolveReceiptPath(name)).toBe(path.join(path.resolve(receiptsDir()), name));
  });

  it('refuses any name that fails the regex, before any fs call', () => {
    expect(() => resolveReceiptPath('../budget.db')).toThrowError(ReceiptStorageError);
    expect(() => resolveReceiptPath('nested/name.jpg')).toThrowError(ReceiptStorageError);
  });

  it('names files under DATA_DIR/receipts', () => {
    expect(receiptsDir()).toBe(path.join(dataDir, 'receipts'));
    expect(receiptTempDir()).toBe(path.join(dataDir, 'tmp'));
  });
});

describe('newStoredFilename', () => {
  it('derives the extension from the sniffed mime, not from any client string', () => {
    expect(newStoredFilename('image/webp').endsWith('.webp')).toBe(true);
    expect(newStoredFilename('application/pdf').endsWith('.pdf')).toBe(true);
    expect(STORED_NAME_RE.test(newStoredFilename('image/png'))).toBe(true);
  });

  // Cross-module: the stored name always reflects what sniffReceiptType() decided from
  // the bytes, never a client-claimed filename or extension — a ".jpg"-named upload
  // whose content is actually a PNG must still be stored as .png.
  it('stores a .jpg-claimed upload under .png when the bytes sniff as PNG', () => {
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(8),
    ]);
    const mime = sniffReceiptType(pngBytes);
    expect(mime).toBe('image/png');
    const name = newStoredFilename(mime!);
    expect(name.endsWith('.png')).toBe(true);
  });
});

describe('sha256', () => {
  it('matches a known digest for a known fixture', () => {
    // sha256("hello") — a fixed vector, so a change to the hashing is loud.
    expect(sha256Bytes(Buffer.from('hello', 'utf8'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('hashes a file on disk identically to its bytes', () => {
    const buf = Buffer.from('receipt bytes', 'utf8');
    const file = path.join(dataDir, 'x.bin');
    fs.writeFileSync(file, buf);
    expect(sha256FileSync(file)).toBe(sha256Bytes(buf));
  });
});

describe('writeReceiptFile / adoptReceiptFile', () => {
  it('writes via tmp then renames into receipts/, and reports size and existence', () => {
    const buf = Buffer.from('a'.repeat(1000), 'utf8');
    const name = writeReceiptFile(buf, 'image/jpeg');
    expect(STORED_NAME_RE.test(name)).toBe(true);
    expect(receiptFileExists(name)).toBe(true);
    expect(receiptFileSize(name)).toBe(1000);
    // Nothing left behind in tmp.
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('adopts a staged file by renaming it under a fresh stored name', () => {
    fs.mkdirSync(receiptTempDir(), { recursive: true });
    const staged = path.join(receiptTempDir(), `${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(staged, Buffer.from('%PDF-1.7\n'));
    const name = adoptReceiptFile(staged, 'application/pdf');
    expect(name.endsWith('.pdf')).toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
    expect(receiptFileExists(name)).toBe(true);
  });

  it('deleteReceiptFile is best effort and never throws on a missing file', () => {
    const name = newStoredFilename('image/png');
    expect(() => deleteReceiptFile(name)).not.toThrow();
    expect(receiptFileExists(name)).toBe(false);
    expect(receiptFileSize(name)).toBeNull();
  });

  it('refuses to adopt a source file outside the staging directory, moving nothing', () => {
    const outside = path.join(dataDir, 'not-staged.pdf');
    fs.writeFileSync(outside, Buffer.from('%PDF-1.7\n'));
    expect(() => adoptReceiptFile(outside, 'application/pdf')).toThrowError(ReceiptStorageError);
    // Nothing moved: the source is untouched and nothing landed in receipts/.
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(receiptsDir()) ? fs.readdirSync(receiptsDir()) : []).toEqual([]);
  });

  it('refreshes mtime on adoption so a backdated staged file is not immediately orphan-swept', () => {
    fs.mkdirSync(receiptTempDir(), { recursive: true });
    const staged = path.join(receiptTempDir(), `${crypto.randomUUID()}.jpg`);
    fs.writeFileSync(staged, Buffer.from('staged bytes'));
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staged, twoDaysAgo, twoDaysAgo);

    const name = adoptReceiptFile(staged, 'image/jpeg');
    // Simulates the DB insert not having committed yet: `known` does NOT include `name`, so
    // only the mtime refresh on adoption protects this file from an immediate sweep. A decoy
    // entry keeps `known` non-empty (re-review fix): an empty known set would instead be
    // caught by purgeOrphanReceipts' own belt-and-braces guard (BLOCKER 1b) before the age
    // check ever runs, which would shadow the very regression this test exists to catch.
    const removed = purgeOrphanReceipts(new Set([crypto.randomUUID() + '.jpg']));
    expect(removed).toBe(0);
    expect(receiptFileExists(name)).toBe(true);
  });
});

describe('purgeOrphanReceipts (MUST-4.9)', () => {
  it('removes only unknown files older than 24 hours', () => {
    const known = writeReceiptFile(Buffer.from('known'), 'image/jpeg');
    const oldOrphan = writeReceiptFile(Buffer.from('old'), 'image/png');
    const freshOrphan = writeReceiptFile(Buffer.from('fresh'), 'image/webp');

    const now = new Date('2026-08-16T12:00:00.000Z');
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    fs.utimesSync(resolveReceiptPath(oldOrphan), twoDaysAgo, twoDaysAgo);
    fs.utimesSync(resolveReceiptPath(known), twoDaysAgo, twoDaysAgo);

    const removed = purgeOrphanReceipts(new Set([known]), undefined, now);
    expect(removed).toBe(1);
    expect(receiptFileExists(known)).toBe(true);
    expect(receiptFileExists(oldOrphan)).toBe(false);
    expect(receiptFileExists(freshOrphan)).toBe(true);
  });

  it('ignores entries that do not match STORED_NAME_RE rather than deleting them', () => {
    fs.mkdirSync(receiptsDir(), { recursive: true });
    const stray = path.join(receiptsDir(), 'README.txt');
    fs.writeFileSync(stray, 'x');
    const long_ago = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(stray, long_ago, long_ago);
    expect(purgeOrphanReceipts(new Set(), undefined, new Date('2026-08-16T12:00:00.000Z'))).toBe(0);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('returns 0 when the directory does not exist yet', () => {
    expect(purgeOrphanReceipts(new Set())).toBe(0);
  });

  it('skips a directory entry that happens to match STORED_NAME_RE rather than crashing the sweep (Ruling P14)', () => {
    fs.mkdirSync(receiptsDir(), { recursive: true });
    const weirdDirName = `${crypto.randomUUID()}.jpg`;
    fs.mkdirSync(path.join(receiptsDir(), weirdDirName));
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(path.join(receiptsDir(), weirdDirName), longAgo, longAgo);
    let removed = -1;
    expect(() => {
      removed = purgeOrphanReceipts(new Set(), undefined, new Date('2026-08-16T12:00:00.000Z'));
    }).not.toThrow();
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(receiptsDir(), weirdDirName))).toBe(true);
  });

  // Fix report BLOCKER 1b, belt-and-braces guard: an empty `known` set together with a
  // receipts/ directory that still has receipt-shaped files in it is never a legitimate
  // sweep target (it is always either mid-restore -- see scripts/restore-backup.ts -- or a
  // corrupt read of warranty_receipts), so the whole sweep is refused, REGARDLESS of the
  // files' age. This is deliberately distinguished from the "adopts a staged file..." test
  // above, whose files are protected by the 24 h age guard alone; here the files are made
  // deliberately ancient (2020) specifically to prove the empty-known guard is the thing
  // doing the protecting, not the age check.
  it('refuses to sweep when known is empty but receipts/ still holds files, no matter how old they are', () => {
    const orphanA = writeReceiptFile(Buffer.from('a'), 'image/jpeg');
    const orphanB = writeReceiptFile(Buffer.from('b'), 'image/png');
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(resolveReceiptPath(orphanA), longAgo, longAgo);
    fs.utimesSync(resolveReceiptPath(orphanB), longAgo, longAgo);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removed = purgeOrphanReceipts(new Set(), undefined, new Date('2026-08-16T12:00:00.000Z'));
    expect(removed).toBe(0);
    expect(receiptFileExists(orphanA)).toBe(true);
    expect(receiptFileExists(orphanB)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does NOT trigger the empty-known guard when known has entries — normal orphan sweeping still works', () => {
    const known = writeReceiptFile(Buffer.from('known'), 'image/jpeg');
    const orphan = writeReceiptFile(Buffer.from('orphan'), 'image/png');
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(resolveReceiptPath(orphan), longAgo, longAgo);
    fs.utimesSync(resolveReceiptPath(known), longAgo, longAgo);

    const removed = purgeOrphanReceipts(new Set([known]), undefined, new Date('2026-08-16T12:00:00.000Z'));
    expect(removed).toBe(1);
    expect(receiptFileExists(known)).toBe(true);
    expect(receiptFileExists(orphan)).toBe(false);
  });
});
