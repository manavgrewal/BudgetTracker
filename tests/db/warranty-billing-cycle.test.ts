import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, type TestDb } from '../helpers/db';

let current: TestDb | null = null;

afterEach(() => {
  current?.cleanup();
  current = null;
});

const ISO = '2026-08-17T12:00:00.000Z';

function seedUser(db: TestDb): number {
  db.sqlite
    .prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin',?)")
    .run(ISO);
  return 1;
}

function insertItem(db: TestDb, over: Partial<Record<string, unknown>> = {}): number {
  const row = {
    name: 'Netflix', vendor: null, model: null, serial: null,
    purchase_date: '2026-08-17', warranty_months: null, is_lifetime: 0, expiry_date: null,
    price_cents: null, owner_user_id: 1, transaction_id: null, notes: null,
    billing_cycle: null, billing_amount_cents: null,
    ...over,
  };
  const info = db.sqlite
    .prepare(
      `insert into warranty_items
        (name, vendor, model, serial, purchase_date, warranty_months, is_lifetime, expiry_date,
         price_cents, owner_user_id, transaction_id, notes, billing_cycle, billing_amount_cents,
         created_at, updated_at)
       values (@name, @vendor, @model, @serial, @purchase_date, @warranty_months, @is_lifetime,
               @expiry_date, @price_cents, @owner_user_id, @transaction_id, @notes,
               @billing_cycle, @billing_amount_cents, '${ISO}', '${ISO}')`,
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

describe('migration 0005 — journal and file discipline', () => {
  it('records idx 5 / when 1755648000000 / tag 0005_billing_cycle with breakpoints', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 5);
    expect(entry).toEqual({
      idx: 5,
      version: '6',
      when: 1755648000000,
      tag: '0005_billing_cycle',
      breakpoints: true,
    });
  });

  it('leaves the committed 0004 entry untouched', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.idx === 4);
    expect(entry).toMatchObject({ when: 1755561600000, tag: '0004_item_type_kinds' });
  });

  it('separates statements with the breakpoint marker, never inside a comment', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'drizzle/0005_billing_cycle.sql'), 'utf8');
    expect(sql).toContain('--> statement-breakpoint');
    for (const line of sql.split(/\r?\n/)) {
      if (line.includes('--> statement-breakpoint')) expect(line.trim()).toBe('--> statement-breakpoint');
    }
    expect(sql).toMatch(/only in SQL|only in this file|exist only/i);
    expect(sql).toMatch(/CHECK/i);
  });
});

describe('migration 0005 — fresh database', () => {
  it('adds billing_cycle and billing_amount_cents, both nullable, appended last', () => {
    current = createTestDb();
    const cols = current.sqlite.prepare('pragma table_info(warranty_items)').all() as {
      name: string;
      notnull: number;
    }[];
    const cycleCol = cols.find((c) => c.name === 'billing_cycle');
    const amountCol = cols.find((c) => c.name === 'billing_amount_cents');
    expect(cycleCol).toBeDefined();
    expect(amountCol).toBeDefined();
    expect(cycleCol!.notnull).toBe(0);
    expect(amountCol!.notnull).toBe(0);
    // ALTER TABLE ADD COLUMN appends physically: both land at the very end, in the order added.
    expect(cols[cols.length - 2]!.name).toBe('billing_cycle');
    expect(cols[cols.length - 1]!.name).toBe('billing_amount_cents');
  });

  it('accepts NULL for both columns (the default, pre-existing-row shape)', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current);
    const row = current.sqlite
      .prepare('select billing_cycle, billing_amount_cents from warranty_items where id = ?')
      .get(id) as { billing_cycle: string | null; billing_amount_cents: number | null };
    expect(row).toEqual({ billing_cycle: null, billing_amount_cents: null });
  });

  it('accepts monthly/annual and rejects any other billing_cycle value (CHECK constraint)', () => {
    current = createTestDb();
    seedUser(current);
    expect(insertItem(current, { billing_cycle: 'monthly' })).toBeGreaterThan(0);
    expect(insertItem(current, { billing_cycle: 'annual' })).toBeGreaterThan(0);
    expect(() => insertItem(current!, { billing_cycle: 'weekly' })).toThrowError(/CHECK constraint failed/);
  });

  it('accepts a non-negative billing_amount_cents and rejects a negative one (CHECK constraint)', () => {
    current = createTestDb();
    seedUser(current);
    expect(insertItem(current, { billing_amount_cents: 0 })).toBeGreaterThan(0);
    expect(insertItem(current, { billing_amount_cents: 1599 })).toBeGreaterThan(0);
    expect(() => insertItem(current!, { billing_amount_cents: -1 })).toThrowError(/CHECK constraint failed/);
  });

  it('is idempotent across a normal reboot (migrate() runs on every openDatabase call)', async () => {
    const { openDatabase } = await import('@/db/client');
    current = createTestDb();
    current.sqlite.close();
    const reopened = openDatabase(current.path);
    const cols = reopened.sqlite.prepare('pragma table_info(warranty_items)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'billing_cycle')).toBe(true);
    expect(cols.some((c) => c.name === 'billing_amount_cents')).toBe(true);
    reopened.sqlite.close();
  });
});
