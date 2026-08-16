import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, type TestDb } from '../helpers/db';

let current: TestDb | null = null;

afterEach(() => {
  current?.cleanup();
  current = null;
});

const ISO = '2026-08-16T12:00:00.000Z';

function seedUser(db: TestDb): number {
  db.sqlite
    .prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin',?)")
    .run(ISO);
  return 1;
}

function insertItem(db: TestDb, over: Partial<Record<string, unknown>> = {}): number {
  const row = {
    name: 'Fridge', vendor: 'Home Depot', model: 'GDT645SYNFS', serial: null,
    purchase_date: '2026-08-16', warranty_months: 24, is_lifetime: 0, expiry_date: '2028-08-16',
    price_cents: 129999, owner_user_id: 1, transaction_id: null, notes: null,
    ...over,
  };
  const info = db.sqlite
    .prepare(
      `insert into warranty_items
        (name, vendor, model, serial, purchase_date, warranty_months, is_lifetime, expiry_date,
         price_cents, owner_user_id, transaction_id, notes, created_at, updated_at)
       values (@name, @vendor, @model, @serial, @purchase_date, @warranty_months, @is_lifetime,
               @expiry_date, @price_cents, @owner_user_id, @transaction_id, @notes, '${ISO}', '${ISO}')`,
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

function insertReceipt(db: TestDb, itemId: number, over: Partial<Record<string, unknown>> = {}): number {
  const row = {
    warranty_item_id: itemId,
    original_filename: 'receipt.jpg',
    stored_filename: `${crypto.randomUUID()}.jpg`,
    mime: 'image/jpeg',
    size_bytes: 1024,
    sha256: 'a'.repeat(64),
    ocr_text: null,
    ocr_status: 'pending',
    ocr_error: null,
    ...over,
  };
  const info = db.sqlite
    .prepare(
      `insert into warranty_receipts
        (warranty_item_id, original_filename, stored_filename, mime, size_bytes, sha256,
         ocr_text, ocr_status, ocr_error, created_at)
       values (@warranty_item_id, @original_filename, @stored_filename, @mime, @size_bytes,
               @sha256, @ocr_text, @ocr_status, @ocr_error, '${ISO}')`,
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

function matches(db: TestDb, query: string): number[] {
  return db.sqlite
    .prepare('select rowid as id from warranty_search where warranty_search match ?')
    .all(query)
    .map((r) => (r as { id: number }).id);
}

describe('migration 0002 — journal and objects', () => {
  it('records idx 2 / when 1755388800000 / tag 0002_warranty_tracker with breakpoints', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 2);
    expect(entry).toEqual({ idx: 2, version: '6', when: 1755388800000, tag: '0002_warranty_tracker', breakpoints: true });
  });

  it('separates statements with --> statement-breakpoint and never runs drizzle-kit', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'drizzle/0002_warranty_tracker.sql'), 'utf8');
    expect(sql).toContain('--> statement-breakpoint');
    // Trigger bodies contain semicolons; a ';'-keyed splitter would shred them (MUST-3.3).
    expect(sql).toContain('CREATE TRIGGER `warranty_search_item_ai`');
    expect(sql).toMatch(/only in SQL|only in this file|exist only/i);
  });

  it('applies cleanly on top of 0000 and 0001 and creates both tables', () => {
    current = createTestDb();
    const tables = current.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name like 'warranty%' order by name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('warranty_items');
    expect(tables).toContain('warranty_receipts');
    expect(tables).toContain('warranty_search');
  });

  it('has FTS5 available on a SQLite new enough for contentless_delete', () => {
    current = createTestDb();
    const { v } = current.sqlite.prepare('select sqlite_version() as v').get() as { v: string };
    const [maj, min] = v.split('.').map(Number);
    expect(maj).toBeGreaterThanOrEqual(3);
    expect(maj > 3 || min >= 43).toBe(true);
    const ddl = current.sqlite
      .prepare("select sql from sqlite_master where name = 'warranty_search'")
      .get() as { sql: string };
    expect(ddl.sql).toContain('contentless_delete=1');
    expect(ddl.sql).toContain('unicode61 remove_diacritics 2');
  });

  it('creates every new index', () => {
    current = createTestDb();
    const names = new Set(
      current.sqlite
        .prepare("select name from sqlite_master where type = 'index' and name not like 'sqlite_%'")
        .all()
        .map((r) => (r as { name: string }).name),
    );
    for (const expected of [
      'warranty_items_expiry_idx',
      'warranty_items_owner_idx',
      'warranty_items_transaction_idx',
      'warranty_receipts_stored_uq',
      'warranty_receipts_item_idx',
      'warranty_receipts_ocr_idx',
    ]) {
      expect(names.has(expected), `missing index ${expected}`).toBe(true);
    }
  });
});

describe('migration 0002 — CHECK constraints', () => {
  it('rejects lifetime with warranty_months set', () => {
    current = createTestDb();
    seedUser(current);
    expect(() => insertItem(current!, { is_lifetime: 1, warranty_months: 12, expiry_date: null })).toThrowError(/CHECK constraint failed/);
  });

  it('rejects lifetime with an expiry_date set', () => {
    current = createTestDb();
    seedUser(current);
    expect(() => insertItem(current!, { is_lifetime: 1, warranty_months: null, expiry_date: '2030-01-01' })).toThrowError(/CHECK constraint failed/);
  });

  it('accepts a lifetime row with both null', () => {
    current = createTestDb();
    seedUser(current);
    expect(insertItem(current!, { is_lifetime: 1, warranty_months: null, expiry_date: null })).toBeGreaterThan(0);
  });

  it('accepts an unknown-term row (months null, expiry null, not lifetime)', () => {
    current = createTestDb();
    seedUser(current);
    expect(insertItem(current!, { warranty_months: null, expiry_date: null })).toBeGreaterThan(0);
  });

  it('rejects months set with expiry NULL, and expiry set with months NULL', () => {
    current = createTestDb();
    seedUser(current);
    expect(() => insertItem(current!, { warranty_months: 12, expiry_date: null })).toThrowError(/CHECK constraint failed/);
    expect(() => insertItem(current!, { warranty_months: null, expiry_date: '2027-01-01' })).toThrowError(/CHECK constraint failed/);
  });

  it('rejects warranty_months = 0 and a negative price', () => {
    current = createTestDb();
    seedUser(current);
    expect(() => insertItem(current!, { warranty_months: 0, expiry_date: '2026-08-16' })).toThrowError(/CHECK constraint failed/);
    expect(() => insertItem(current!, { price_cents: -1 })).toThrowError(/CHECK constraint failed/);
  });

  it('rejects an out-of-list mime and ocr_status, and out-of-range size_bytes', () => {
    current = createTestDb();
    seedUser(current);
    const itemId = insertItem(current!);
    expect(() => insertReceipt(current!, itemId, { mime: 'image/gif' })).toThrowError(/CHECK constraint failed/);
    expect(() => insertReceipt(current!, itemId, { ocr_status: 'running' })).toThrowError(/CHECK constraint failed/);
    expect(() => insertReceipt(current!, itemId, { size_bytes: 0 })).toThrowError(/CHECK constraint failed/);
    expect(() => insertReceipt(current!, itemId, { size_bytes: 10485761 })).toThrowError(/CHECK constraint failed/);
    expect(insertReceipt(current!, itemId, { size_bytes: 10485760 })).toBeGreaterThan(0);
  });

  it('rejects a duplicate stored_filename', () => {
    current = createTestDb();
    seedUser(current);
    const itemId = insertItem(current!);
    const name = `${crypto.randomUUID()}.jpg`;
    insertReceipt(current!, itemId, { stored_filename: name });
    expect(() => insertReceipt(current!, itemId, { stored_filename: name })).toThrowError(/UNIQUE constraint failed/);
  });
});

describe('migration 0002 — FTS triggers', () => {
  it('indexes an item on insert and finds it by name', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    expect(matches(current!, '"fridge"')).toEqual([id]);
  });

  it('reindexes when name changes but NOT when only updated_at changes', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    current!.sqlite.prepare('update warranty_items set name = ? where id = ?').run('Dishwasher', id);
    expect(matches(current!, '"fridge"')).toEqual([]);
    expect(matches(current!, '"dishwasher"')).toEqual([id]);

    // updated_at is not in the AFTER UPDATE OF column list, so the row must not be re-tokenized.
    const before = current!.sqlite.prepare('select count(*) as c from warranty_search').get() as { c: number };
    current!.sqlite.prepare('update warranty_items set updated_at = ? where id = ?').run('2026-09-01T00:00:00.000Z', id);
    const after = current!.sqlite.prepare('select count(*) as c from warranty_search').get() as { c: number };
    expect(after.c).toBe(before.c);
    expect(matches(current!, '"dishwasher"')).toEqual([id]);
  });

  it('finds an item by a word that appears only on its receipt', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    insertReceipt(current!, id, { ocr_text: 'RONA STORE 4412 SPATULA', ocr_status: 'done' });
    expect(matches(current!, '"spatula"')).toEqual([id]);
  });

  it('matches MÉTRO by typing metro (remove_diacritics 2)', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!, { vendor: 'MÉTRO' });
    expect(matches(current!, '"metro"')).toEqual([id]);
  });

  it('prefix-matches a partial model number', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    expect(matches(current!, '"GDT645"*')).toEqual([id]);
  });

  it('swaps the indexed text when ocr_text is updated', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    const receiptId = insertReceipt(current!, id, { ocr_text: 'OLDWORD', ocr_status: 'done' });
    expect(matches(current!, '"oldword"')).toEqual([id]);
    current!.sqlite.prepare('update warranty_receipts set ocr_text = ? where id = ?').run('NEWWORD', receiptId);
    expect(matches(current!, '"oldword"')).toEqual([]);
    expect(matches(current!, '"newword"')).toEqual([id]);
  });

  it('drops a deleted receipt’s text but keeps the item indexed', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    const receiptId = insertReceipt(current!, id, { ocr_text: 'GONEWORD', ocr_status: 'done' });
    current!.sqlite.prepare('delete from warranty_receipts where id = ?').run(receiptId);
    expect(matches(current!, '"goneword"')).toEqual([]);
    expect(matches(current!, '"fridge"')).toEqual([id]);
  });

  it('leaves ZERO FTS rows after deleting an item that had two receipts (MUST-3.11)', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    insertReceipt(current!, id, { ocr_text: 'ONE', ocr_status: 'done' });
    insertReceipt(current!, id, { ocr_text: 'TWO', ocr_status: 'done' });
    current!.sqlite.prepare('delete from warranty_items where id = ?').run(id);
    const count = current!.sqlite.prepare('select count(*) as c from warranty_search').get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('migration 0002 — foreign keys', () => {
  it('nulls transaction_id and keeps the item when the transaction is deleted (MUST-3.7)', () => {
    current = createTestDb();
    seedUser(current);
    current!.sqlite
      .prepare("insert into accounts (id, name, institution, type, is_active, created_at) values (1,'Chq','TD','chequing',1,?)")
      .run(ISO);
    current!.sqlite
      .prepare(
        `insert into transactions (id, account_id, date, raw_description, normalized_merchant, amount_cents,
           dedup_hash, hash_version, created_by, created_at, updated_at)
         values (7, 1, '2026-08-16', 'HOME DEPOT', 'HOME DEPOT', -129999, 'h1', 1, 1, ?, ?)`,
      )
      .run(ISO, ISO);
    const id = insertItem(current!, { transaction_id: 7 });
    current!.sqlite.prepare('delete from transactions where id = 7').run();
    const row = current!.sqlite.prepare('select transaction_id from warranty_items where id = ?').get(id) as {
      transaction_id: number | null;
    };
    expect(row.transaction_id).toBeNull();
  });

  it('cascades receipt rows when the item is deleted', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    insertReceipt(current!, id);
    current!.sqlite.prepare('delete from warranty_items where id = ?').run(id);
    const count = current!.sqlite.prepare('select count(*) as c from warranty_receipts').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('allows two warranty items to share one transaction (no unique index)', () => {
    current = createTestDb();
    seedUser(current);
    current!.sqlite
      .prepare("insert into accounts (id, name, institution, type, is_active, created_at) values (1,'Chq','TD','chequing',1,?)")
      .run(ISO);
    current!.sqlite
      .prepare(
        `insert into transactions (id, account_id, date, raw_description, normalized_merchant, amount_cents,
           dedup_hash, hash_version, created_by, created_at, updated_at)
         values (9, 1, '2026-08-16', 'HOME DEPOT', 'HOME DEPOT', -200000, 'h2', 1, 1, ?, ?)`,
      )
      .run(ISO, ISO);
    expect(insertItem(current!, { transaction_id: 9, name: 'Fridge' })).toBeGreaterThan(0);
    expect(insertItem(current!, { transaction_id: 9, name: 'Dishwasher' })).toBeGreaterThan(0);
  });
});
