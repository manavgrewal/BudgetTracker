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

function seedUser(db: TestDb): void {
  db.sqlite
    .prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin',?)")
    .run(ISO);
}

function insertItem(db: TestDb, typeId: number | null): number {
  const info = db.sqlite
    .prepare(
      `insert into warranty_items
        (name, purchase_date, warranty_months, is_lifetime, expiry_date, owner_user_id, type_id, created_at, updated_at)
       values ('Fridge', '2026-08-16', 24, 0, '2028-08-16', 1, ?, ?, ?)`,
    )
    .run(typeId, ISO, ISO);
  return Number(info.lastInsertRowid);
}

function insertType(db: TestDb, name: string, isSubscription = 0): number {
  const info = db.sqlite
    .prepare('insert into warranty_item_types (name, is_subscription, created_at) values (?, ?, ?)')
    .run(name, isSubscription, ISO);
  return Number(info.lastInsertRowid);
}

describe('migration 0003 — journal and file discipline', () => {
  it('records idx 3 / when 1755475200000 / tag 0003_warranty_item_types with breakpoints', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 3);
    expect(entry).toEqual({
      idx: 3,
      version: '6',
      when: 1755475200000,
      tag: '0003_warranty_item_types',
      breakpoints: true,
    });
  });

  it('leaves the committed 0002 entry untouched', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.idx === 2);
    expect(entry).toMatchObject({ when: 1755388800000, tag: '0002_warranty_tracker' });
  });

  it('separates statements with the breakpoint marker and never puts it inside a comment', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'drizzle/0003_warranty_item_types.sql'), 'utf8');
    expect(sql).toContain('--> statement-breakpoint');
    // Drizzle's splitter is comment-blind: a marker on a comment line would cut the
    // header comment in half and hand SQLite a fragment.
    for (const line of sql.split(/\r?\n/)) {
      if (line.includes('--> statement-breakpoint')) expect(line.trim()).toBe('--> statement-breakpoint');
    }
    // The header extends the MUST-3.4 enumeration of SQL-only objects.
    expect(sql).toMatch(/only in SQL|only in this file|exist only/i);
    expect(sql).toMatch(/COLLATE NOCASE/i);
  });
});

describe('migration 0003 — objects and seeds', () => {
  it('creates warranty_item_types and its indexes on top of 0000..0002', () => {
    current = createTestDb();
    const names = new Set(
      current.sqlite
        .prepare("select name from sqlite_master where name not like 'sqlite_%'")
        .all()
        .map((r) => (r as { name: string }).name),
    );
    expect(names.has('warranty_item_types')).toBe(true);
    expect(names.has('warranty_item_types_name_uq')).toBe(true);
    expect(names.has('warranty_items_type_idx')).toBe(true);
  });

  it('seeds exactly Laptop(0), Appliance(0), Subscription(1) — and nothing else', () => {
    current = createTestDb();
    const rows = current.sqlite
      .prepare('select name, is_subscription from warranty_item_types order by id')
      .all() as { name: string; is_subscription: number }[];
    expect(rows).toEqual([
      { name: 'Laptop', is_subscription: 0 },
      { name: 'Appliance', is_subscription: 0 },
      { name: 'Subscription', is_subscription: 1 },
    ]);
    const stamped = current.sqlite
      .prepare("select count(*) as c from warranty_item_types where created_at = '2026-08-16T00:00:00.000Z'")
      .get() as { c: number };
    expect(stamped.c).toBe(3);
  });

  it('adds a nullable type_id to warranty_items without disturbing the existing columns', () => {
    current = createTestDb();
    const cols = current.sqlite.prepare('pragma table_info(warranty_items)').all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const typeCol = cols.find((c) => c.name === 'type_id');
    expect(typeCol).toBeDefined();
    expect(typeCol!.notnull).toBe(0);
    expect(typeCol!.dflt_value).toBeNull();
    // ALTER TABLE ADD COLUMN appends physically: type_id is last.
    expect(cols[cols.length - 1]!.name).toBe('type_id');
  });
});

describe('migration 0003 — constraints', () => {
  it('rejects a name differing only in case (COLLATE NOCASE unique index)', () => {
    current = createTestDb();
    expect(() => insertType(current!, 'laptop')).toThrowError(/UNIQUE constraint failed/);
    expect(() => insertType(current!, 'LAPTOP')).toThrowError(/UNIQUE constraint failed/);
    expect(insertType(current!, 'Phone')).toBeGreaterThan(0);
  });

  it('rejects is_subscription outside 0/1 and a blank or over-long name', () => {
    current = createTestDb();
    expect(() => insertType(current!, 'Router', 2)).toThrowError(/CHECK constraint failed/);
    expect(() => insertType(current!, '   ')).toThrowError(/CHECK constraint failed/);
    expect(() => insertType(current!, 'x'.repeat(61))).toThrowError(/CHECK constraint failed/);
    expect(insertType(current!, 'x'.repeat(60))).toBeGreaterThan(0);
  });

  it('accepts NULL and a real type on warranty_items, and rejects an unknown one', () => {
    current = createTestDb();
    seedUser(current);
    const laptop = (current.sqlite.prepare("select id from warranty_item_types where name = 'Laptop'").get() as {
      id: number;
    }).id;
    expect(insertItem(current, null)).toBeGreaterThan(0);
    expect(insertItem(current, laptop)).toBeGreaterThan(0);
    expect(() => insertItem(current!, 9999)).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('refuses at the database level to delete a type that an item references (MUST-19.6 backstop)', () => {
    current = createTestDb();
    seedUser(current);
    const laptop = (current.sqlite.prepare("select id from warranty_item_types where name = 'Laptop'").get() as {
      id: number;
    }).id;
    insertItem(current, laptop);
    expect(() => current!.sqlite.prepare('delete from warranty_item_types where id = ?').run(laptop)).toThrowError(
      /FOREIGN KEY constraint failed/,
    );
    // No cascade, no set-null: the item and its type are both still there.
    const item = current.sqlite.prepare('select type_id from warranty_items limit 1').get() as { type_id: number };
    expect(item.type_id).toBe(laptop);
  });

  it('deletes an unused type cleanly', () => {
    current = createTestDb();
    const id = insertType(current, 'Unused');
    current.sqlite.prepare('delete from warranty_item_types where id = ?').run(id);
    expect(current.sqlite.prepare('select count(*) as c from warranty_item_types').get()).toEqual({ c: 3 });
  });

  it('does NOT re-tokenize the FTS row when only type_id changes', () => {
    current = createTestDb();
    seedUser(current);
    const laptop = (current.sqlite.prepare("select id from warranty_item_types where name = 'Laptop'").get() as {
      id: number;
    }).id;
    const itemId = insertItem(current, null);
    const before = current.sqlite
      .prepare('select rowid as id from warranty_search where warranty_search match ?')
      .all('"fridge"')
      .map((r) => (r as { id: number }).id);
    expect(before).toEqual([itemId]);
    current.sqlite.prepare('update warranty_items set type_id = ? where id = ?').run(laptop, itemId);
    // The type name is not search text (MUST-19.16) and type_id is not in the
    // AFTER UPDATE OF column list, so the index is unchanged.
    const after = current.sqlite.prepare('select count(*) as c from warranty_search').get() as { c: number };
    expect(after.c).toBe(1);
    expect(
      current.sqlite.prepare('select rowid as id from warranty_search where warranty_search match ?').all('"laptop"'),
    ).toEqual([]);
  });
});
