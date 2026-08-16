import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import { seedCategories, seedDatabase, seedImportProfiles, SEED_CATEGORIES } from '@/db/seed';
import { parseImportMapping } from '@/lib/import/mapping';
import { BUILTIN_PRESET_NAMES } from '@/lib/import/presets';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('seed', () => {
  it('inserts 9 parents and 28 children', () => {
    current = createTestDb();
    const inserted = seedCategories(current.db);
    expect(inserted).toBe(37);
    const parents = current.sqlite.prepare('select count(*) as c from categories where parent_id is null').get() as { c: number };
    const children = current.sqlite.prepare('select count(*) as c from categories where parent_id is not null').get() as { c: number };
    expect(parents.c).toBe(9);
    expect(children.c).toBe(28);
    expect(SEED_CATEGORIES).toHaveLength(9);
  });

  it('marks only Income and its children as is_income', () => {
    current = createTestDb();
    seedCategories(current.db);
    const incomeNames = (current.sqlite.prepare('select name from categories where is_income = 1 order by name').all() as { name: string }[]).map((r) => r.name);
    expect(incomeNames).toEqual(['Income', 'Other Income', 'Salary']);
  });

  it('never seeds an "Uncategorized" or "Transfer" category', () => {
    current = createTestDb();
    seedCategories(current.db);
    const bad = current.sqlite
      .prepare("select count(*) as c from categories where name in ('Uncategorized', 'Transfer', 'Transfers')")
      .get() as { c: number };
    expect(bad.c).toBe(0);
  });

  it('keeps categories at most 2 levels deep', () => {
    current = createTestDb();
    seedCategories(current.db);
    const depth3 = current.sqlite
      .prepare('select count(*) as c from categories c join categories p on c.parent_id = p.id where p.parent_id is not null')
      .get() as { c: number };
    expect(depth3.c).toBe(0);
  });

  it('inserts the 4 built-in profiles with valid mappings', () => {
    current = createTestDb();
    const inserted = seedImportProfiles(current.db);
    expect(inserted).toBe(4);
    const rows = current.sqlite.prepare('select name, is_builtin, mapping from import_profiles order by id').all() as {
      name: string;
      is_builtin: number;
      mapping: string;
    }[];
    expect(rows.map((r) => r.name)).toEqual([...BUILTIN_PRESET_NAMES]);
    for (const row of rows) {
      expect(row.is_builtin).toBe(1);
      expect(() => parseImportMapping(row.mapping)).not.toThrow();
    }
  });

  it('is idempotent — running seedDatabase twice inserts nothing new', () => {
    current = createTestDb();
    seedDatabase(current.db);
    const before = current.db.get<{ c: number }>(sql`select (select count(*) from categories) + (select count(*) from import_profiles) as c`);
    seedDatabase(current.db);
    const after = current.db.get<{ c: number }>(sql`select (select count(*) from categories) + (select count(*) from import_profiles) as c`);
    expect(after.c).toBe(before.c);
    expect(after.c).toBe(41);
  });
});
