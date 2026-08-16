import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { commitImport, listImportHistory } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { parseCsv } from '@/lib/import/parse';
import { getBuiltinPreset } from '@/lib/import/presets';
import { resetImportHooks } from '@/lib/import/hooks';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
beforeEach(() => resetImportHooks());
afterEach(() => {
  current?.cleanup();
  current = null;
});

function tdRows(accountId: number) {
  const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
  return { hashed: computeRowHashes(accountId, parsed.rows), errors: parsed.errors };
}

describe('commitImport', () => {
  it('inserts every non-duplicate row and reports the counts', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed, errors } = tdRows(accountId);

    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors });

    expect(result.rowsAdded).toBe(9);
    expect(result.rowsDuplicate).toBe(0);
    expect(result.rowsError).toBe(0);
    expect(result.insertedTransactionIds).toHaveLength(9);
    const count = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    expect(count.c).toBe(9);
  });

  it('stores date, raw description, amount, dedup hash and hash version', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed, errors } = tdRows(accountId);
    commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors });

    const row = current.sqlite
      .prepare('select date, raw_description, normalized_merchant, amount_cents, dedup_hash, hash_version, categorization_source, is_transfer, category_id from transactions order by id limit 1')
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      date: '2026-03-02',
      raw_description: 'POS PURCHASE       TIM HORTONS #4821 TORONTO ON',
      amount_cents: -485,
      hash_version: 1,
      categorization_source: 'none',
      is_transfer: 0,
      category_id: null,
    });
    expect(row.dedup_hash).toBe(hashed[0].dedupHash);
    expect(row.normalized_merchant).toBe('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
  });

  it('defaults attribution to the account owner and leaves joint accounts unattributed', () => {
    current = createSeededTestDb();
    const alice = insertTestUser(current.db, { username: 'alice' });
    const personal = insertTestAccount(current.db, { name: 'Alice Visa', type: 'credit', ownerUserId: alice });
    const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });

    const personalRows = tdRows(personal);
    commitImport({ accountId: personal, profileId: null, filename: 'a.csv', importedBy: alice, rows: personalRows.hashed, errors: [] });
    const jointRows = tdRows(joint);
    commitImport({ accountId: joint, profileId: null, filename: 'b.csv', importedBy: alice, rows: jointRows.hashed, errors: [] });

    const personalAttribution = current.sqlite.prepare('select distinct attributed_user_id as a from transactions where account_id = ?').all(personal);
    const jointAttribution = current.sqlite.prepare('select distinct attributed_user_id as a from transactions where account_id = ?').all(joint);
    expect(personalAttribution).toEqual([{ a: alice }]);
    expect(jointAttribution).toEqual([{ a: null }]);
  });

  it('records an association for every inserted row', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);
    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });

    const links = current.sqlite.prepare('select count(*) as c from transaction_imports where import_id = ?').get(result.importId) as { c: number };
    expect(links.c).toBe(9);
  });

  it('records an association for DUPLICATE rows too, and inserts nothing new', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);

    const first = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const second = commitImport({ accountId, profileId: null, filename: 'td-again.csv', importedBy: userId, rows: hashed, errors: [] });

    expect(second.rowsAdded).toBe(0);
    expect(second.rowsDuplicate).toBe(9);
    expect(second.duplicateTransactionIds.sort()).toEqual(first.insertedTransactionIds.sort());

    const total = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    expect(total.c).toBe(9);
    const secondLinks = current.sqlite.prepare('select count(*) as c from transaction_imports where import_id = ?').get(second.importId) as { c: number };
    expect(secondLinks.c).toBe(9);
  });

  it('handles a partially overlapping second export', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);

    commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    const second = commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });

    expect(second.rowsDuplicate).toBe(2);
    expect(second.rowsAdded).toBe(4);
    const total = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    expect(total.c).toBe(9);
  });

  it('creates the imports row with the filename, importer and counts', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const accountId = insertTestAccount(current.db);
    const parsed = parseCsv(fixture('mint-like-edge-cases.csv'), getBuiltinPreset('TD Chequing/Debit'));
    const hashed = computeRowHashes(accountId, parsed.rows);

    const result = commitImport({ accountId, profileId: null, filename: 'edge.csv', importedBy: userId, rows: hashed, errors: parsed.errors });

    const row = current.sqlite.prepare('select * from imports where id = ?').get(result.importId) as Record<string, unknown>;
    expect(row).toMatchObject({ filename: 'edge.csv', imported_by: userId, rows_added: 3, rows_duplicate: 0, rows_error: 5 });

    const history = listImportHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ filename: 'edge.csv', importedByName: 'Alice', rowsAdded: 3, rowsError: 5 });
  });

  it('is atomic — a failure inserts nothing', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);
    const broken = [...hashed];
    broken[4] = { ...broken[4], amountCents: 'nope' as unknown as number };

    expect(() => commitImport({ accountId, profileId: null, filename: 'bad.csv', importedBy: userId, rows: broken, errors: [] })).toThrow();
    const total = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    const importsCount = current.sqlite.prepare('select count(*) as c from imports').get() as { c: number };
    expect(total.c).toBe(0);
    expect(importsCount.c).toBe(0);
  });

  it('accepts an empty row list', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const result = commitImport({ accountId, profileId: null, filename: 'empty.csv', importedBy: userId, rows: [], errors: [] });
    expect(result).toMatchObject({ rowsAdded: 0, rowsDuplicate: 0, rowsError: 0 });
  });
});
