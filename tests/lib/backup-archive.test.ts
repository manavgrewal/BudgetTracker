import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import {
  ARCHIVE_NAME_RE,
  LEGACY_NAME_RE,
  backupsDir,
  buildArchive,
  createOnDemandArchive,
  nightlyArchiveName,
  resolveSafeTarget,
  tempDir,
} from '@/lib/backup/archive';
import { listBackups, nightlyBackupName, pruneBackups, runMaintenanceSweep, runNightlyJob } from '@/lib/backup';
import { receiptsDir, writeReceiptFile } from '@/lib/warranty/receipts';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-archive-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
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

async function entriesOf(archivePath: string): Promise<string[]> {
  const tar = await import('tar');
  const names: string[] = [];
  tar.list({ file: archivePath, sync: true, onReadEntry: (entry) => names.push(entry.path) });
  return names.sort();
}

describe('archive naming and guards', () => {
  it('names the nightly artifact budget-YYYY-MM-DD.tar.gz', () => {
    const at = new Date('2026-08-16T06:00:00.000Z'); // 02:00 in Toronto
    expect(nightlyArchiveName(at, 'America/Toronto')).toBe('budget-2026-08-16.tar.gz');
    expect(nightlyBackupName(at, 'America/Toronto')).toBe('budget-2026-08-16.tar.gz');
    expect(ARCHIVE_NAME_RE.test('budget-2026-08-16.tar.gz')).toBe(true);
    expect(LEGACY_NAME_RE.test('budget-2026-08-16.db')).toBe(true);
  });

  it('refuses a filename that does not match its pattern or escapes its directory', () => {
    expect(() => resolveSafeTarget(backupsDir(), '../evil.tar.gz', ARCHIVE_NAME_RE)).toThrowError(/unsafe/i);
    expect(() => resolveSafeTarget(backupsDir(), 'budget-2026-08-16.tar.gz.bak', ARCHIVE_NAME_RE)).toThrowError(/unsafe/i);
  });
});

describe('buildArchive (MUST-12.1, MUST-12.2)', () => {
  it('contains budget.db and every receipt, and leaves no temp snapshot behind', async () => {
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const a = writeReceiptFile(JPEG, 'image/jpeg');
    const b = writeReceiptFile(Buffer.from('%PDF-1.7\n'), 'application/pdf');

    const target = path.join(dataDir, 'out.tar.gz');
    buildArchive(target);

    const head = fs.readFileSync(target).subarray(0, 2);
    expect([head[0], head[1]]).toEqual([0x1f, 0x8b]);
    expect(await entriesOf(target)).toEqual(['budget.db', 'receipts/', `receipts/${a}`, `receipts/${b}`].sort());

    // No leftovers in DATA_DIR/tmp — neither the VACUUM snapshot nor the staging directory.
    expect(fs.readdirSync(tempDir()).filter((n) => n.endsWith('.db') || n.includes('archive'))).toEqual([]);
  });

  it('works when there are no receipts at all', async () => {
    const target = path.join(dataDir, 'empty.tar.gz');
    buildArchive(target);
    expect(await entriesOf(target)).toContain('budget.db');
  });

  it('overwrites an existing target rather than failing the day’s backup', () => {
    const target = path.join(dataDir, 'twice.tar.gz');
    buildArchive(target);
    expect(() => buildArchive(target)).not.toThrow();
  });

  it('createOnDemandArchive writes into tmp under a UUID name', () => {
    const { path: file, bytes } = createOnDemandArchive();
    expect(path.dirname(file)).toBe(path.resolve(tempDir()));
    expect(path.basename(file)).toMatch(/^[0-9a-f-]{36}\.tar\.gz$/);
    expect(bytes).toBeGreaterThan(0);
  });
});

describe('listBackups compatibility (MUST-12.3)', () => {
  function fake(name: string, ageMinutes: number): void {
    fs.mkdirSync(backupsDir(), { recursive: true });
    const file = path.join(backupsDir(), name);
    fs.writeFileSync(file, 'x');
    const when = new Date(Date.now() - ageMinutes * 60_000);
    fs.utimesSync(file, when, when);
  }

  it('lists BOTH .tar.gz and legacy .db artifacts, newest first', () => {
    fake('budget-2026-08-16.tar.gz', 1);
    fake('budget-2026-08-15.db', 60);
    fake('budget-2026-08-16.tar.gz.bak', 2);
    fake('README.txt', 3);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-16.tar.gz', 'budget-2026-08-15.db']);
  });

  it('prunes across both shapes with one retention count', () => {
    fake('budget-2026-08-16.tar.gz', 1);
    fake('budget-2026-08-15.db', 60);
    fake('budget-2026-08-14.db', 120);
    expect(pruneBackups(1).sort()).toEqual(['budget-2026-08-14.db', 'budget-2026-08-15.db']);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-16.tar.gz']);
  });
});

describe('maintenance sweep (MUST-4.9)', () => {
  it('reports receiptOrphansPurged and leaves referenced files alone', () => {
    const orphan = writeReceiptFile(JPEG, 'image/jpeg');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.join(receiptsDir(), orphan), twoDaysAgo, twoDaysAgo);

    const result = runMaintenanceSweep(new Date());
    expect(result.receiptOrphansPurged).toBe(1);
    expect(fs.existsSync(path.join(receiptsDir(), orphan))).toBe(false);
  });
});

describe('runNightlyJob', () => {
  it('writes the archive, prunes, sweeps, and reports the archive name', () => {
    const result = runNightlyJob(new Date('2026-08-16T06:00:00.000Z'));
    expect(result.backup.name).toBe('budget-2026-08-16.tar.gz');
    expect(result.backup.bytes).toBeGreaterThan(0);
    expect(result.sweep.receiptOrphansPurged).toBe(0);
  });
});
