import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@/db/client';
import { createTestDb, type TestDb } from '../helpers/db';

let current: TestDb | null = null;

const REAL_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

afterEach(() => {
  current?.cleanup();
  current = null;
  // Every upgrade-path test below points this at a temp folder while it builds a 0003-era
  // database, then deletes it again to fall back to the real (0004-including) drizzle/
  // folder. Belt and braces: clear it here too, so a failed assertion mid-test never leaks
  // the override into a later, unrelated test in this same process.
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

describe('migration 0004 — journal and file discipline', () => {
  it('records idx 4 / when 1755561600000 / tag 0004_item_type_kinds with breakpoints', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 4);
    expect(entry).toEqual({
      idx: 4,
      version: '6',
      when: 1755561600000,
      tag: '0004_item_type_kinds',
      breakpoints: true,
    });
  });

  it('leaves the committed 0003 entry untouched', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.idx === 3);
    expect(entry).toMatchObject({ when: 1755475200000, tag: '0003_warranty_item_types' });
  });

  it('separates statements with the breakpoint marker, never inside a comment, and extends the SQL-only enumeration', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'drizzle/0004_item_type_kinds.sql'), 'utf8');
    expect(sql).toContain('--> statement-breakpoint');
    // Drizzle's splitter is comment-blind: a marker on a comment line would cut the header
    // comment in half and hand SQLite a fragment.
    for (const line of sql.split(/\r?\n/)) {
      if (line.includes('--> statement-breakpoint')) expect(line.trim()).toBe('--> statement-breakpoint');
    }
    expect(sql).toMatch(/only in SQL|only in this file|exist only/i);
    expect(sql).toMatch(/CHECK/i);
    expect(sql).toMatch(/NOT EXISTS/i);
  });
});

describe('migration 0004 — fresh database', () => {
  it('adds a NOT NULL kind column, appended last, defaulting new rows to warranty', () => {
    current = createTestDb();
    const cols = current.sqlite.prepare('pragma table_info(warranty_item_types)').all() as {
      name: string;
      notnull: number;
    }[];
    const kindCol = cols.find((c) => c.name === 'kind');
    expect(kindCol).toBeDefined();
    expect(kindCol!.notnull).toBe(1);
    // ALTER TABLE ADD COLUMN appends physically: kind is last.
    expect(cols[cols.length - 1]!.name).toBe('kind');

    const info = current.sqlite
      .prepare("insert into warranty_item_types (name, is_subscription, created_at) values ('Default Kind Probe', 0, '2026-08-17T00:00:00.000Z')")
      .run();
    const row = current.sqlite.prepare('select kind from warranty_item_types where id = ?').get(info.lastInsertRowid) as {
      kind: string;
    };
    expect(row.kind).toBe('warranty');
  });

  it('backfills kind = subscription for the pre-existing Subscription row, warranty for Laptop/Appliance', () => {
    current = createTestDb();
    const rows = current.sqlite.prepare('select name, kind from warranty_item_types order by id').all() as {
      name: string;
      kind: string;
    }[];
    expect(Object.fromEntries(rows.map((r) => [r.name, r.kind]))).toEqual({
      Laptop: 'warranty',
      Appliance: 'warranty',
      Subscription: 'subscription',
      Contract: 'contract',
      Loan: 'loan',
    });
  });

  it('seeds Contract and Loan with the literal v1.2.2 timestamp and is_subscription 0', () => {
    current = createTestDb();
    const rows = current.sqlite
      .prepare(
        "select name, is_subscription, created_at from warranty_item_types where name in ('Contract', 'Loan') order by name",
      )
      .all() as { name: string; is_subscription: number; created_at: string }[];
    expect(rows).toEqual([
      { name: 'Contract', is_subscription: 0, created_at: '2026-08-17T00:00:00.000Z' },
      { name: 'Loan', is_subscription: 0, created_at: '2026-08-17T00:00:00.000Z' },
    ]);
  });

  it('rejects a kind outside the four allowed values (CHECK constraint)', () => {
    current = createTestDb();
    expect(() =>
      current!.sqlite
        .prepare(
          "insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Lease', 0, 'lease', '2026-08-17T00:00:00.000Z')",
        )
        .run(),
    ).toThrowError(/CHECK constraint failed/);
  });

  it('is idempotent across a normal reboot (migrate() runs on every openDatabase call)', () => {
    current = createTestDb();
    current.sqlite.close();
    const reopened = openDatabase(current.path);
    const names = reopened.sqlite
      .prepare('select name from warranty_item_types order by name')
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual(['Appliance', 'Contract', 'Laptop', 'Loan', 'Subscription']);
    reopened.sqlite.close();
  });
});

/**
 * Builds a database that has only ever seen migrations 0000-0003 (i.e. a real household's
 * database the moment before this release), by pointing BUDGET_MIGRATIONS_DIR at a temp
 * folder holding copies of just those four files plus a journal trimmed to their entries.
 * Reopening the SAME file with the default (real, 0004-including) migrations folder
 * reproduces exactly what happens on the NAS the first time this release boots.
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0003-migrations-'));
  for (const name of [
    '0000_init.sql',
    '0001_add_must_change_password.sql',
    '0002_warranty_tracker.sql',
    '0003_warranty_item_types.sql',
  ]) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 3) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0003-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

describe('migration 0004 — upgrade path from a 0003-era database', () => {
  it('backfills a pre-existing subscription-flagged custom type to kind subscription, and Laptop to warranty', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);
    staged.sqlite
      .prepare("insert into warranty_item_types (name, is_subscription, created_at) values ('Gym Pass', 1, '2026-08-16T12:00:00.000Z')")
      .run();
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/ folder, which now includes 0004
    const upgraded = openDatabase(file);
    try {
      const rows = upgraded.sqlite
        .prepare('select name, kind, is_subscription from warranty_item_types order by id')
        .all() as { name: string; kind: string; is_subscription: number }[];
      expect(rows).toEqual(
        expect.arrayContaining([
          { name: 'Laptop', kind: 'warranty', is_subscription: 0 },
          { name: 'Appliance', kind: 'warranty', is_subscription: 0 },
          { name: 'Subscription', kind: 'subscription', is_subscription: 1 },
          { name: 'Gym Pass', kind: 'subscription', is_subscription: 1 },
          { name: 'Contract', kind: 'contract', is_subscription: 0 },
          { name: 'Loan', kind: 'loan', is_subscription: 0 },
        ]),
      );
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('does not insert a duplicate Contract seed when a user already created one before upgrading (NOT EXISTS guard)', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);
    staged.sqlite
      .prepare("insert into warranty_item_types (name, is_subscription, created_at) values ('Contract', 0, '2026-08-16T12:00:00.000Z')")
      .run();
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    try {
      const contracts = upgraded.sqlite
        .prepare("select id, kind, is_subscription, created_at from warranty_item_types where name = 'Contract' collate nocase")
        .all() as { id: number; kind: string; is_subscription: number; created_at: string }[];
      // Exactly one row -- the user's own, never duplicated by the migration's seed insert.
      expect(contracts).toHaveLength(1);
      // It survives untouched: original timestamp preserved, and its kind defaults to
      // 'warranty' via the plain ALTER TABLE ADD COLUMN default (0004's backfill only ever
      // reclassifies by is_subscription, never by name).
      expect(contracts[0]).toMatchObject({ kind: 'warranty', is_subscription: 0, created_at: '2026-08-16T12:00:00.000Z' });
      // Loan has no pre-existing collision in this scenario, so it seeds normally.
      const loan = upgraded.sqlite.prepare("select kind from warranty_item_types where name = 'Loan'").get() as {
        kind: string;
      };
      expect(loan.kind).toBe('loan');
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
