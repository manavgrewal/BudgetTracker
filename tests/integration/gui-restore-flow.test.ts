import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { runNightlyBackup } from '@/lib/backup';
import { backupsDir } from '@/lib/backup/archive';
import { receiptsDir, writeReceiptFile } from '@/lib/warranty/receipts';
import { applyStagedRestoreOnBoot, applyingDir, readRestoreState, stageRestore, stagedDir } from '@/lib/backup/restore';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.7\n');

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-gui-restore-'));
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

function insertWarrantyItem(sqlite: import('better-sqlite3').Database, name: string, ownerUserId: number, at: string): number {
  const row = sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
       values (?, '2026-01-01', 0, ?, ?, ?) returning id`,
    )
    .get(name, ownerUserId, at, at) as { id: number };
  return row.id;
}

function insertWarrantyReceipt(
  sqlite: import('better-sqlite3').Database,
  itemId: number,
  storedFilename: string,
  sha256: string,
  at: string,
): void {
  sqlite
    .prepare(
      `insert into warranty_receipts (warranty_item_id, original_filename, stored_filename, mime, size_bytes, sha256, ocr_status, created_at)
       values (?, 'receipt.jpg', ?, 'image/jpeg', 64, ?, 'done', ?)`,
    )
    .run(itemId, storedFilename, sha256, at);
}

function sha256Of(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * VACUUM INTO the current live seeded db as ${DATA_DIR}/budget.db — a plain fs.copyFileSync
 * would miss anything still buffered in the WAL-mode connection's -wal file. Mirrors how
 * buildArchive() (src/lib/backup/archive.ts) takes its own snapshot.
 */
function vacuumIntoLiveDb(): void {
  const target = path.join(dataDir, 'budget.db');
  fs.rmSync(target, { force: true });
  current!.sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

function itemNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('select name from warranty_items order by name').all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
}

describe('gui-restore-flow (spec §20.15)', () => {
  it('archive restore: restores items and receipts, banks the mutated data as a safety copy', () => {
    const userId = insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const itemId1 = insertWarrantyItem(current!.sqlite, 'Fridge', userId, '2026-08-01T00:00:00.000Z');
    const itemId2 = insertWarrantyItem(current!.sqlite, 'Laptop', userId, '2026-08-01T00:00:00.000Z');
    const receiptA = writeReceiptFile(JPEG, 'image/jpeg');
    const receiptB = writeReceiptFile(PDF, 'application/pdf');
    insertWarrantyReceipt(current!.sqlite, itemId1, receiptA, sha256Of(path.join(receiptsDir(), receiptA)), '2026-08-01T00:00:00.000Z');
    insertWarrantyReceipt(current!.sqlite, itemId2, receiptB, sha256Of(path.join(receiptsDir(), receiptB)), '2026-08-01T00:00:00.000Z');

    const shaABefore = sha256Of(path.join(receiptsDir(), receiptA));
    const shaBBefore = sha256Of(path.join(receiptsDir(), receiptB));

    // The "live" data the restore machinery actually operates on. A plain file copy would
    // miss anything still buffered in the WAL-mode connection's -wal file, so this uses
    // VACUUM INTO — the same self-contained-snapshot mechanism buildArchive() itself uses.
    vacuumIntoLiveDb();

    const backup = runNightlyBackup(new Date('2026-08-16T06:00:00.000Z'));
    const staged = stageRestore({ backupName: backup.name, userId, username: 'alice' });
    expect(fs.existsSync(stagedDir())).toBe(true);
    expect(staged.kind).toBe('archive');

    // Mutate the live data after staging: delete one item (directly against the on-disk
    // file the restore machinery manages, exactly as if the app had kept running), and add
    // an untracked third receipt.
    const mutator = new Database(path.join(dataDir, 'budget.db'));
    try {
      mutator.prepare('delete from warranty_items where id = ?').run(itemId1);
    } finally {
      mutator.close();
    }
    const thirdReceipt = '99999999-8888-7777-6666-555555555555.jpg';
    fs.writeFileSync(path.join(dataDir, 'receipts', thirdReceipt), JPEG);
    const mutatedDbHash = sha256Of(path.join(dataDir, 'budget.db'));

    applyStagedRestoreOnBoot(new Date('2026-08-16T21:04:53.000Z'));

    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(fs.existsSync(applyingDir())).toBe(false);

    // Both original items are back.
    expect(itemNames(path.join(dataDir, 'budget.db'))).toEqual(['Fridge', 'Laptop']);

    // Both receipt files are present with unchanged sha256.
    expect(sha256Of(path.join(dataDir, 'receipts', receiptA))).toBe(shaABefore);
    expect(sha256Of(path.join(dataDir, 'receipts', receiptB))).toBe(shaBBefore);

    const state = readRestoreState();
    expect(state.result?.status).toBe('success');

    // The third (untracked) receipt is preserved in the pre-restore safety copy, not in the
    // restored receipts/.
    expect(state.result?.receiptsMovedAside).toMatch(/^receipts\.pre-restore-/);
    expect(fs.existsSync(path.join(dataDir, state.result!.receiptsMovedAside!, thirdReceipt))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'receipts', thirdReceipt))).toBe(false);

    // budget.pre-restore-*.db contains the MUTATED data (the deleted item stays deleted there).
    expect(state.result?.safetyCopy).toMatch(/^budget\.pre-restore-.+\.db$/);
    const safetyCopyPath = path.join(dataDir, state.result!.safetyCopy!);
    expect(sha256Of(safetyCopyPath)).toBe(mutatedDbHash);
    expect(itemNames(safetyCopyPath)).toEqual(['Laptop']);
  });

  it('legacy bare-.db restore: leaves receipts/ untouched, re-arms mtimes, reports missing rows', () => {
    const userId = insertTestUser(current!.db, { name: 'Bob', username: 'bob' });
    insertWarrantyItem(current!.sqlite, 'Blender', userId, '2026-08-01T00:00:00.000Z');
    // A receipt row whose file will NOT be present after restore -> counted as missing.
    current!.sqlite
      .prepare(
        `insert into warranty_receipts (warranty_item_id, original_filename, stored_filename, mime, size_bytes, sha256, ocr_status, created_at)
         values (1, 'a.jpg', '11111111-2222-3333-4444-555555555555.jpg', 'image/jpeg', 64, ?, 'done', '2026-08-01T00:00:00.000Z')`,
      )
      .run('a'.repeat(64));

    vacuumIntoLiveDb();

    const legacyName = 'budget-2026-08-10.db';
    fs.mkdirSync(backupsDir(), { recursive: true });
    current!.sqlite.exec(`VACUUM INTO '${path.join(backupsDir(), legacyName).replace(/'/g, "''")}'`);

    stageRestore({ backupName: legacyName, userId, username: 'bob' });

    // Pre-existing receipts/, with mtimes well past the 24h orphan grace window.
    // Anchored to `now`, not the real wall clock: applyStagedRestoreOnBoot's touch-receipts
    // step stamps mtimes to the injected `now`, so the fixture must be too — otherwise this
    // assertion silently depends on how much real time has passed since the fixture was
    // written (it did: see the defect writeup for v1.4.0).
    const now = new Date('2026-08-16T21:04:53.000Z');
    fs.mkdirSync(path.join(dataDir, 'receipts'), { recursive: true });
    const existingReceipt = '22222222-3333-4444-5555-666666666666.jpg';
    fs.writeFileSync(path.join(dataDir, 'receipts', existingReceipt), JPEG);
    const wellOverADayAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dataDir, 'receipts', existingReceipt), wellOverADayAgo, wellOverADayAgo);

    applyStagedRestoreOnBoot(now);

    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(fs.existsSync(applyingDir())).toBe(false);

    const state = readRestoreState();
    expect(state.result?.status).toBe('success');
    expect(state.result?.kind).toBe('sqlite');
    // MUST-12.9: receipts/ is never renamed, emptied or modified by a bare-db restore.
    expect(state.result?.receiptsMovedAside).toBeNull();
    expect(fs.readdirSync(path.join(dataDir, 'receipts'))).toEqual([existingReceipt]);
    expect(fs.statSync(path.join(dataDir, 'receipts', existingReceipt)).mtimeMs).toBeGreaterThan(
      wellOverADayAgo.getTime(),
    );
    expect(state.result?.receiptsTouched).toBe(1);
    expect(state.result?.missingReceiptRows).toBe(1);
    expect(itemNames(path.join(dataDir, 'budget.db'))).toEqual(['Blender']);
  });
});
