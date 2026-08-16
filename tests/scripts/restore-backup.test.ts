import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { buildArchive } from '@/lib/backup/archive';
import { receiptsDir, writeReceiptFile } from '@/lib/warranty/receipts';
import {
  RESTORE_STORED_NAME_RE,
  RestoreError,
  detectArtifactKind,
  restoreFromArtifact,
} from '../../scripts/restore-backup';
import { STORED_NAME_RE } from '@/lib/warranty/receipts';

/**
 * A minimal, hand-rolled ustar-format tar writer, used only to fabricate archives with
 * entry shapes node-tar's own `create()` either normalizes away (a leading "/" is stripped
 * before it ever reaches disk) or cannot produce at all on this platform (creating a real
 * symlink on Windows requires elevated privileges, which a CI runner may not have). An
 * attacker crafting a hostile archive does not go through node-tar's create() either — they
 * write the tar bytes directly — so this is the more faithful test fixture for the tar-slip
 * defence, not a shortcut around it.
 */
function ustarHeader(fields: { name: string; typeflag: '0' | '2'; linkname?: string; size?: number }): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(fields.name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'utf8');
  buf.write('0000000\0', 108, 8, 'utf8');
  buf.write('0000000\0', 116, 8, 'utf8');
  const size = fields.size ?? 0;
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  buf.write('00000000000\0', 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder: 8 ASCII spaces
  buf.write(fields.typeflag, 156, 1, 'utf8');
  if (fields.linkname) buf.write(fields.linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += buf[i];
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return buf;
}

function buildRawTarGz(entries: { name: string; typeflag: '0' | '2'; linkname?: string; body?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const bodyBuf = entry.body ? Buffer.from(entry.body, 'utf8') : Buffer.alloc(0);
    blocks.push(
      ustarHeader({ name: entry.name, typeflag: entry.typeflag, linkname: entry.linkname, size: bodyBuf.length }),
    );
    if (bodyBuf.length > 0) {
      const padded = Buffer.alloc(Math.ceil(bodyBuf.length / 512) * 512);
      bodyBuf.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024)); // two all-zero 512-byte blocks mark end-of-archive
  return zlib.gzipSync(Buffer.concat(blocks));
}

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-'));
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

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('the duplicated stored-name regex stays in step (the ARGON2_OPTIONS precedent)', () => {
  it('matches src/lib/warranty/receipts.ts exactly', () => {
    expect(RESTORE_STORED_NAME_RE.source).toBe(STORED_NAME_RE.source);
    expect(RESTORE_STORED_NAME_RE.flags).toBe(STORED_NAME_RE.flags);
  });
});

describe('detectArtifactKind (MUST-12.5) — magic bytes, never the extension', () => {
  it('recognises gzip, SQLite and neither', () => {
    const gz = path.join(dataDir, 'a.bin');
    fs.writeFileSync(gz, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(detectArtifactKind(gz)).toBe('archive');

    const db = path.join(dataDir, 'b.bin');
    fs.writeFileSync(db, Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(16)]));
    expect(detectArtifactKind(db)).toBe('sqlite');

    const junk = path.join(dataDir, 'c.tar.gz'); // a lying extension
    fs.writeFileSync(junk, Buffer.from('this is a text file'));
    expect(detectArtifactKind(junk)).toBe('unknown');
  });

  it('refuses an unrecognised artifact and touches nothing', () => {
    const junk = path.join(dataDir, 'junk.tar.gz');
    fs.writeFileSync(junk, Buffer.from('nope'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.writeFileSync(path.join(target, 'budget.db'), 'ORIGINAL');
    expect(() => restoreFromArtifact(junk, { dataDir: target })).toThrowError(RestoreError);
    expect(fs.readFileSync(path.join(target, 'budget.db'), 'utf8')).toBe('ORIGINAL');
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('archive restore (MUST-12.7, MUST-12.8)', () => {
  it('restores the database and every receipt byte-for-byte into an empty data dir', () => {
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const a = writeReceiptFile(JPEG, 'image/jpeg');
    const b = writeReceiptFile(Buffer.from('%PDF-1.7\n'), 'application/pdf');
    const digests = { [a]: sha(path.join(receiptsDir(), a)), [b]: sha(path.join(receiptsDir(), b)) };

    const artifact = path.join(dataDir, 'backup.tar.gz');
    buildArchive(artifact);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    const result = restoreFromArtifact(artifact, { dataDir: target });

    expect(result.kind).toBe('archive');
    expect(result.databaseRestored).toBe(true);
    expect(result.receiptsRestored).toBe(2);
    expect(fs.readFileSync(path.join(target, 'budget.db')).subarray(0, 15).toString('utf8')).toBe('SQLite format 3');
    for (const [name, digest] of Object.entries(digests)) {
      expect(sha(path.join(target, 'receipts', name))).toBe(digest);
    }
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('removes stale -wal and -shm files (MUST-12.7)', () => {
    const artifact = path.join(dataDir, 'backup.tar.gz');
    buildArchive(artifact);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.writeFileSync(path.join(target, 'budget.db-wal'), 'stale');
    fs.writeFileSync(path.join(target, 'budget.db-shm'), 'stale');
    restoreFromArtifact(artifact, { dataDir: target });
    expect(fs.existsSync(path.join(target, 'budget.db-wal'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'budget.db-shm'))).toBe(false);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('moves an existing receipts/ aside instead of deleting it (MUST-12.8)', () => {
    const artifact = path.join(dataDir, 'backup.tar.gz');
    buildArchive(artifact);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.mkdirSync(path.join(target, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(target, 'receipts', 'keepme.txt'), 'precious');

    const result = restoreFromArtifact(artifact, { dataDir: target, now: new Date('2026-08-16T12:00:00.000Z') });
    expect(result.receiptsMovedAside).toMatch(/^receipts\.pre-restore-/);
    expect(fs.readFileSync(path.join(target, result.receiptsMovedAside!, 'keepme.txt'), 'utf8')).toBe('precious');
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('tar-slip defence (MUST-12.6)', () => {
  async function hostileArchive(entries: { name: string; body: string }[]): Promise<string> {
    const tar = await import('tar');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-hostile-'));
    const names: string[] = [];
    for (const entry of entries) {
      const file = path.join(stage, entry.name.replace(/[/\\]/g, '_'));
      fs.writeFileSync(file, entry.body);
      names.push(path.basename(file));
    }
    const out = path.join(dataDir, `hostile-${Math.random().toString(36).slice(2)}.tar.gz`);
    tar.create({ file: out, cwd: stage, gzip: true, sync: true }, names);
    fs.rmSync(stage, { recursive: true, force: true });
    return out;
  }

  it('aborts the whole restore on an unexpected top-level entry', async () => {
    const artifact = await hostileArchive([{ name: 'evil.sh', body: '#!/bin/sh\nrm -rf /' }]);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(RestoreError);
    expect(fs.readdirSync(target)).toEqual([]);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('rejects a receipts/ entry whose name is not a stored filename', async () => {
    const tar = await import('tar');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-hostile2-'));
    fs.mkdirSync(path.join(stage, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'receipts', 'evil.sh'), 'x');
    fs.writeFileSync(path.join(stage, 'budget.db'), 'SQLite format 3\0');
    const artifact = path.join(dataDir, 'hostile2.tar.gz');
    tar.create({ file: artifact, cwd: stage, gzip: true, sync: true }, ['budget.db', 'receipts']);
    fs.rmSync(stage, { recursive: true, force: true });

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(/receipts/i);
    expect(fs.existsSync(path.join(target, 'budget.db'))).toBe(false);
    fs.rmSync(target, { recursive: true, force: true });
  });

  // Fix report M5: the three tar-slip vectors the spec (MUST-12.6) names explicitly, each
  // fabricated with a hand-rolled tar writer since node-tar's own create() either strips a
  // leading "/" before it reaches disk (so it can never emit a genuinely absolute entry.path)
  // or, for a real symlink, needs OS privileges a CI runner may not have on every platform.
  it('aborts on an absolute-path entry and extracts nothing', () => {
    const artifact = path.join(dataDir, 'abs.tar.gz');
    fs.writeFileSync(artifact, buildRawTarGz([{ name: '/etc/evil.sh', typeflag: '0', body: 'x' }]));

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(RestoreError);
    expect(fs.readdirSync(target)).toEqual([]);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('aborts on a ".." segment entry and extracts nothing', () => {
    const artifact = path.join(dataDir, 'dotdot.tar.gz');
    fs.writeFileSync(artifact, buildRawTarGz([{ name: '../evil.sh', typeflag: '0', body: 'x' }]));

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(RestoreError);
    expect(fs.readdirSync(target)).toEqual([]);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('aborts on a symlink entry and extracts nothing', () => {
    const artifact = path.join(dataDir, 'symlink.tar.gz');
    fs.writeFileSync(
      artifact,
      buildRawTarGz([
        { name: 'budget.db', typeflag: '0', body: 'SQLite format 3\0' },
        { name: 'receipts/11111111-2222-3333-4444-555555555555.jpg', typeflag: '2', linkname: '/etc/passwd' },
      ]),
    );

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(RestoreError);
    expect(fs.readdirSync(target)).toEqual([]);
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('allow-listed names must match their expected entry type (fix report M10)', () => {
  it('rejects an archive where "receipts" is a plain file, not a directory', async () => {
    const tar = await import('tar');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-hostile3-'));
    fs.writeFileSync(path.join(stage, 'budget.db'), 'SQLite format 3\0');
    fs.writeFileSync(path.join(stage, 'receipts'), 'not a directory');
    const artifact = path.join(dataDir, 'hostile3.tar.gz');
    tar.create({ file: artifact, cwd: stage, gzip: true, sync: true }, ['budget.db', 'receipts']);
    fs.rmSync(stage, { recursive: true, force: true });

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(RestoreError);
    expect(fs.readdirSync(target)).toEqual([]);
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('archive restore refuses a non-SQLite budget.db entry (fix report IMPORTANT 4, MUST-12.5 continued)', () => {
  it('refuses to clobber the live database when the archive\'s budget.db is not really SQLite', async () => {
    const tar = await import('tar');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-hostile4-'));
    fs.mkdirSync(path.join(stage, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'budget.db'), 'this looks like a file but is not a SQLite database');
    const artifact = path.join(dataDir, 'hostile4.tar.gz');
    tar.create({ file: artifact, cwd: stage, gzip: true, sync: true }, ['budget.db', 'receipts']);
    fs.rmSync(stage, { recursive: true, force: true });

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.writeFileSync(path.join(target, 'budget.db'), 'ORIGINAL LIVE DATABASE');
    fs.mkdirSync(path.join(target, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(target, 'receipts', 'keepme.txt'), 'precious');

    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(RestoreError);
    // MUST-12.5's "refuse, touch nothing" must hold for what's INSIDE the archive too.
    expect(fs.readFileSync(path.join(target, 'budget.db'), 'utf8')).toBe('ORIGINAL LIVE DATABASE');
    expect(fs.existsSync(path.join(target, 'receipts', 'keepme.txt'))).toBe(true);
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('v1.0.0 DB-only restore (MUST-12.9)', () => {
  it('replaces the database, leaves receipts/ completely untouched, and counts missing files', () => {
    // A v1.1 database that references two receipt files.
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const kept = writeReceiptFile(JPEG, 'image/jpeg');

    const legacy = path.join(dataDir, 'budget-2026-08-15.db');
    current!.sqlite.exec(`VACUUM INTO '${legacy.replace(/'/g, "''")}'`);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.mkdirSync(path.join(target, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(target, 'receipts', kept), JPEG);
    fs.writeFileSync(path.join(target, 'receipts', 'unrelated.bin'), 'precious');

    const result = restoreFromArtifact(legacy, { dataDir: target });

    expect(result.kind).toBe('sqlite');
    expect(result.databaseRestored).toBe(true);
    expect(result.receiptsRestored).toBe(0);
    expect(result.receiptsMovedAside).toBeNull();
    // MUST-12.9: a DB-only artifact says NOTHING about receipts. Treating silence as
    // "delete them" would destroy files the backup was never responsible for.
    expect(fs.readdirSync(path.join(target, 'receipts')).sort()).toEqual([kept, 'unrelated.bin'].sort());
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('reports how many receipt rows reference files that are not present', () => {
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const stored = `11111111-2222-3333-4444-555555555555.jpg`;
    current!.sqlite
      .prepare(
        `insert into warranty_items (id, name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
         values (1, 'Fridge', '2026-08-16', 0, 1, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      )
      .run();
    current!.sqlite
      .prepare(
        `insert into warranty_receipts (warranty_item_id, original_filename, stored_filename, mime, size_bytes,
           sha256, ocr_status, created_at)
         values (1, 'a.jpg', ?, 'image/jpeg', 64, ?, 'done', '2026-08-16T00:00:00.000Z')`,
      )
      .run(stored, 'a'.repeat(64));

    const legacy = path.join(dataDir, 'legacy.db');
    current!.sqlite.exec(`VACUUM INTO '${legacy.replace(/'/g, "''")}'`);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    const result = restoreFromArtifact(legacy, { dataDir: target });
    expect(result.missingReceiptRows).toBe(1);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('reports zero missing rows for a pre-warranty database with no such table', async () => {
    // A genuine v1.0.0 artifact has no warranty_receipts table at all.
    const legacy = path.join(dataDir, 'v100.db');
    current!.sqlite.exec(`VACUUM INTO '${legacy.replace(/'/g, "''")}'`);
    // Ruling P3: no require() in an ESM vitest file — use a dynamic import instead.
    const { default: Database } = await import('better-sqlite3');
    const copy = new Database(legacy);
    copy.exec('drop table warranty_receipts; drop table warranty_items;');
    copy.close();

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(restoreFromArtifact(legacy, { dataDir: target }).missingReceiptRows).toBe(0);
    fs.rmSync(target, { recursive: true, force: true });
  });
});
