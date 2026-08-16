import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { commitImport, previewUndoImport, undoImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { parseCsv } from '@/lib/import/parse';
import { getBuiltinPreset } from '@/lib/import/presets';
import { resetImportHooks, setImportHooks } from '@/lib/import/hooks';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
beforeEach(() => resetImportHooks());
afterEach(() => {
  resetImportHooks();
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
  const hashed = computeRowHashes(accountId, parsed.rows);
  return { db: current.db, sqlite: current.sqlite, userId, accountId, hashed };
}

describe('undoImport with no overlap', () => {
  it('deletes every row the import created', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });

    expect(previewUndoImport(result.importId)).toEqual({ importId: result.importId, willDelete: 9, willKeep: 0 });
    expect(undoImport(result.importId)).toEqual({ deleted: 9, kept: 0 });

    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from imports').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from transaction_imports').get() as { c: number }).c).toBe(0);
  });
});

describe('undoImport with overlapping imports — the sole-association rule', () => {
  it('keeps rows that another import also covers and deletes only the exclusive ones', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    const second = commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });

    // rows 3 and 4 are shared between the two imports
    expect(previewUndoImport(first.importId)).toEqual({ importId: first.importId, willDelete: 3, willKeep: 2 });
    expect(undoImport(first.importId)).toEqual({ deleted: 3, kept: 2 });

    const remaining = (sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;
    expect(remaining).toBe(6);
    expect((sqlite.prepare('select count(*) as c from imports').get() as { c: number }).c).toBe(1);
    expect((sqlite.prepare('select count(*) as c from transaction_imports where import_id = ?').get(second.importId) as { c: number }).c).toBe(6);
  });

  it('clears the denormalized import_id on kept rows', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });
    undoImport(first.importId);
    const dangling = sqlite.prepare('select count(*) as c from transactions where import_id = ?').get(first.importId) as { c: number };
    expect(dangling.c).toBe(0);
  });

  it('undoing the second import afterwards removes the rest', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    const second = commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });
    undoImport(first.importId);
    expect(undoImport(second.importId)).toEqual({ deleted: 6, kept: 0 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  it('a full re-import of the same file makes every row shared, so undo deletes nothing', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    commitImport({ accountId, profileId: null, filename: 'td-again.csv', importedBy: userId, rows: hashed, errors: [] });
    expect(previewUndoImport(first.importId)).toEqual({ importId: first.importId, willDelete: 0, willKeep: 9 });
    expect(undoImport(first.importId)).toEqual({ deleted: 0, kept: 9 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(9);
  });

  it('undoing the duplicate-hitting import leaves the original owning import untouched', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    // A creates T (T.import_id = A's id).
    const first = commitImport({ accountId, profileId: null, filename: 'a.csv', importedBy: userId, rows: hashed.slice(0, 1), errors: [] });
    // B duplicate-hits T: no new row, but an association to B is recorded.
    const second = commitImport({ accountId, profileId: null, filename: 'b.csv', importedBy: userId, rows: hashed.slice(0, 1), errors: [] });
    expect(second.rowsAdded).toBe(0);
    expect(second.rowsDuplicate).toBe(1);
    const transactionId = first.insertedTransactionIds[0];

    // Undoing B: T is shared (associated with both A and B), so it survives.
    expect(undoImport(second.importId)).toEqual({ deleted: 0, kept: 1 });

    const row = sqlite.prepare('select import_id from transactions where id = ?').get(transactionId) as { import_id: number | null };
    expect(row.import_id).toBe(first.importId);

    const surviving = sqlite
      .prepare('select count(*) as c from transaction_imports where transaction_id = ? and import_id = ?')
      .get(transactionId, first.importId) as { c: number };
    expect(surviving.c).toBe(1);

    const importAStillExists = sqlite.prepare('select count(*) as c from imports where id = ?').get(first.importId) as { c: number };
    expect(importAStillExists.c).toBe(1);
  });
});

describe('Bayes reversal on undo', () => {
  it('untrains only the deleted rows that had reached source = manual', () => {
    const { db, sqlite, userId, accountId, hashed } = setup();
    const untrain = vi.fn();
    setImportHooks({ untrain, tokenize: (value) => value.split(' ') });

    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');

    const ids = (sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual', normalized_merchant = 'METRO PLUS' where id = ${ids[0]}`);
    db.run(sql`update transactions set category_id = ${coffee}, categorization_source = 'bayes', normalized_merchant = 'TIM HORTONS' where id = ${ids[1]}`);
    db.run(sql`update transactions set category_id = ${coffee}, categorization_source = 'rule', normalized_merchant = 'STARBUCKS' where id = ${ids[2]}`);

    undoImport(result.importId);

    expect(untrain).toHaveBeenCalledTimes(1);
    expect(untrain).toHaveBeenCalledWith(['METRO', 'PLUS'], groceries);
  });

  it('does not untrain rows that survive because another import covers them', () => {
    const { db, sqlite, userId, accountId, hashed } = setup();
    const untrain = vi.fn();
    setImportHooks({ untrain, tokenize: (value) => value.split(' ') });

    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });

    const groceries = categoryIdByName(db, 'Groceries');
    const ids = (sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);
    // ids[4] is shared between the two imports; ids[0] is exclusive to the first.
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual', normalized_merchant = 'SHARED ROW' where id = ${ids[4]}`);
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual', normalized_merchant = 'EXCLUSIVE ROW' where id = ${ids[0]}`);

    undoImport(first.importId);

    expect(untrain).toHaveBeenCalledTimes(1);
    expect(untrain).toHaveBeenCalledWith(['EXCLUSIVE', 'ROW'], groceries);
  });

  it('skips manual rows whose category is NULL', () => {
    const { db, sqlite, userId, accountId, hashed } = setup();
    const untrain = vi.fn();
    setImportHooks({ untrain, tokenize: (value) => value.split(' ') });
    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const ids = (sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);
    db.run(sql`update transactions set category_id = null, categorization_source = 'manual' where id = ${ids[0]}`);
    undoImport(result.importId);
    expect(untrain).not.toHaveBeenCalled();
  });
});

describe('Bayes reversal through the real wiring', () => {
  it('decrements the real token counts when a confirmed row is deleted by undo', async () => {
    const { db, userId, accountId, hashed } = setup();
    const { confirmCategory } = await import('@/lib/categorize/engine');
    const { getVocabSize } = await import('@/lib/categorize/bayes');
    const groceries = categoryIdByName(db, 'Groceries');

    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const first = result.insertedTransactionIds[0];
    confirmCategory({ transactionId: first, categoryId: groceries, userId });

    const before = current!.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    undoImport(result.importId);

    const after = current!.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number };
    expect(after.c).toBe(0);
    expect(getVocabSize()).toBe(0);
  });
});
