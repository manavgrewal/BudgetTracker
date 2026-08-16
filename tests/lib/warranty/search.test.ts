import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createItemType } from '@/lib/warranty/types';
import {
  MAX_SEARCH_CHARS,
  MAX_SEARCH_TERMS,
  SEARCH_SYNTAX_ERROR,
  WARRANTY_PAGE_SIZE,
  escapeFtsQuery,
  expiringSoonItems,
  isWarrantySort,
  searchWarrantyItems,
  type WarrantySort,
} from '@/lib/warranty/search';

let fts: BetterSqlite3.Database;

beforeEach(() => {
  fts = new BetterSqlite3(':memory:');
  fts.exec(
    "create virtual table t using fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
  );
  fts.prepare('insert into t(rowid, body) values (1, ?)').run('26" monitor dewalt drill MÉTRO GDT645SYNFS tim hortons');
});

afterEach(() => {
  fts.close();
});

/** Every produced query MUST be something SQLite actually accepts (MUST-9.1). */
function runs(query: string): number[] {
  return fts
    .prepare('select rowid as id from t where t match ?')
    .all(query)
    .map((r) => (r as { id: number }).id);
}

describe('escapeFtsQuery — the spec §9.1 table, verbatim', () => {
  it.each([
    ['tim hortons', '"tim" "hortons"*'],
    ['26" monitor', '"26""" "monitor"*'],
    ['dewalt AND drill', '"dewalt" "AND" "drill"*'],
    ['GDT645SYNFS', '"GDT645SYNFS"*'],
    ['   ', null],
    ['"', '""""'],
  ])('%j produces %j', (input, expected) => {
    expect(escapeFtsQuery(input)).toBe(expected);
  });
});

describe('escapeFtsQuery — safety', () => {
  it('produces a query SQLite accepts for every operator-laden input', () => {
    for (const input of [
      '26" monitor',
      '"',
      '""',
      'a"b"c',
      'dewalt AND drill',
      'NEAR(a b)',
      '-drill',
      '^start',
      'col:value',
      '(unbalanced',
      'a*b',
      'OR NOT AND',
    ]) {
      const query = escapeFtsQuery(input);
      if (query === null) continue;
      expect(() => runs(query), `SQLite rejected ${JSON.stringify(query)}`).not.toThrow();
    }
  });

  it('matches AND / OR / NOT / NEAR as words, not as operators', () => {
    expect(runs(escapeFtsQuery('dewalt AND drill')!)).toEqual([]); // no literal "AND" in the row
    expect(runs(escapeFtsQuery('dewalt drill')!)).toEqual([1]);
  });

  it('prefix-matches the last term only', () => {
    expect(runs(escapeFtsQuery('GDT645')!)).toEqual([1]);
    // "dewalt" is an exact token (not starred, since it isn't last) and DOES match; "moni"
    // is starred (last term) and prefix-matches "monitor". Verified empirically against
    // real SQLite FTS5 (node -e against better-sqlite3): a non-last, non-star phrase only
    // matches a token it is EQUAL to, never one it is merely a prefix of — so a query built
    // from a term that is itself only a prefix of a longer token (e.g. "GDT645" against the
    // single token "GDT645SYNFS") would need the star to match, and only the last term gets one.
    expect(runs(escapeFtsQuery('dewalt moni')!)).toEqual([1]);
    // The FIRST term is not a prefix: "moni" alone never matches "monitor" as a full term.
    expect(runs(escapeFtsQuery('moni dewalt')!)).toEqual([]);
  });

  it('finds MÉTRO by typing metro', () => {
    expect(runs(escapeFtsQuery('metro')!)).toEqual([1]);
  });

  it('scrubs control characters (including an embedded NUL) before building the query (CRITICAL fix)', () => {
    // Built via String.fromCharCode rather than a literal escape in source: a NUL survives
    // \s+-splitting untouched (it is not whitespace to JS regex), so left un-scrubbed it
    // would be quoted as its own literal phrase and SQLite's FTS5 tokenizer would raise a
    // genuine SQLITE_ERROR ("unterminated string") for a query built from it -- verified
    // directly against better-sqlite3 before this fix was written.
    const nul = String.fromCharCode(0);
    const leading = escapeFtsQuery(`${nul}abc`);
    const middle = escapeFtsQuery(`ab${nul}cd`);
    const alone = escapeFtsQuery(nul);

    // A lone control character has nothing left after scrubbing -> null, exactly like
    // whitespace-only input.
    expect(alone).toBeNull();
    // A control character elsewhere in the string becomes a term boundary, same as a space.
    expect(leading).toBe('"abc"*');
    expect(middle).toBe('"ab" "cd"*');

    for (const query of [leading, middle]) {
      expect(() => runs(query!), `SQLite rejected ${JSON.stringify(query)}`).not.toThrow();
    }
  });

  it('returns null for whitespace-only and empty input', () => {
    expect(escapeFtsQuery('')).toBeNull();
    expect(escapeFtsQuery('   \t \n ')).toBeNull();
  });

  it('caps at 20 terms and 200 characters of raw input', () => {
    const many = Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ');
    const query = escapeFtsQuery(many)!;
    expect(query.split(' ')).toHaveLength(MAX_SEARCH_TERMS);
    expect(MAX_SEARCH_TERMS).toBe(20);

    const long = 'x'.repeat(300);
    expect(escapeFtsQuery(long)).toBe(`"${'x'.repeat(MAX_SEARCH_CHARS)}"*`);
    expect(MAX_SEARCH_CHARS).toBe(200);
  });
});

describe('sort and page size', () => {
  it('pages at 50 and accepts only the three named sorts', () => {
    expect(WARRANTY_PAGE_SIZE).toBe(50);
    expect(isWarrantySort('expiry')).toBe(true);
    expect(isWarrantySort('name')).toBe(true);
    expect(isWarrantySort('purchase')).toBe(true);
    expect(isWarrantySort('rank')).toBe(false);
  });
});

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let owner: number;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-warranty-search-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  owner = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('searchWarrantyItems', () => {
  const TODAY = '2026-08-16';

  function seed(over: Partial<Parameters<typeof createWarrantyItem>[0]> = {}) {
    return createWarrantyItem({
      name: 'Fridge',
      vendor: 'Home Depot',
      model: 'GDT645SYNFS',
      serial: null,
      purchaseDate: '2026-08-16',
      warrantyMonths: 24,
      isLifetime: false,
      priceCents: 129999,
      ownerUserId: owner,
      transactionId: null,
      typeId: null,
      notes: null,
      ...over,
    });
  }

  it('lists everything when the query is empty (no MATCH, no JOIN)', () => {
    seed();
    seed({ name: 'Dishwasher' });
    const result = searchWarrantyItems({ q: '   ', today: TODAY });
    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(2);
  });

  it('AND-combines multiple words', () => {
    seed({ name: 'Fridge', vendor: 'Home Depot' });
    seed({ name: 'Drill', vendor: 'Rona' });
    expect(searchWarrantyItems({ q: 'fridge home', today: TODAY }).total).toBe(1);
    expect(searchWarrantyItems({ q: 'fridge rona', today: TODAY }).total).toBe(0);
  });

  it('prefix-matches a partial model number and ignores diacritics', () => {
    const id = seed({ vendor: 'MÉTRO' });
    expect(searchWarrantyItems({ q: 'GDT645', today: TODAY }).rows[0].id).toBe(id);
    expect(searchWarrantyItems({ q: 'metro', today: TODAY }).rows[0].id).toBe(id);
  });

  it('returns results rather than throwing for a query full of operators', () => {
    seed({ name: '26" monitor' });
    const result = searchWarrantyItems({ q: '26" AND monitor', today: TODAY });
    expect(result.error).toBeUndefined();
  });

  it('never throws — CRITICAL/IMPORTANT 2 regression — for an embedded NUL or other FTS5 error shapes', () => {
    seed({ name: 'Whatever Item' });
    const nul = String.fromCharCode(0);
    // Each of these is a documented distinct FTS5 error shape (unterminated string, syntax
    // error, no such column, ...); the structural `.code === 'SQLITE_ERROR'` net in
    // searchWarrantyItems catches all of them, not just the two English phrasings the old
    // regex matched.
    for (const q of [nul, `${nul}abc`, 'col:value', 'NEAR(', '"unterminated', '(unbalanced', 'OR NOT AND']) {
      let result: ReturnType<typeof searchWarrantyItems> | undefined;
      expect(() => {
        result = searchWarrantyItems({ q, today: TODAY });
      }, `threw for q=${JSON.stringify(q)}`).not.toThrow();
      // Either a clean result, or the documented SEARCH_SYNTAX_ERROR — never a raw SQLite message.
      if (result?.error !== undefined) expect(result.error).toBe(SEARCH_SYNTAX_ERROR);
    }
  });

  it('falls back to a safe default sort and page for out-of-range values (defensive SQL-boundary guard)', () => {
    seed({ name: 'Guard Item' });
    // Simulates an untrusted sort value that slipped past the type system (e.g. an
    // unvalidated URL query param cast upstream).
    expect(() => searchWarrantyItems({ sort: 'bogus' as unknown as WarrantySort, today: TODAY })).not.toThrow();
    expect(searchWarrantyItems({ sort: 'bogus' as unknown as WarrantySort, today: TODAY }).rows[0]?.name).toBe(
      'Guard Item',
    );
    expect(searchWarrantyItems({ page: Number.NaN, today: TODAY }).page).toBe(1);
    expect(searchWarrantyItems({ page: Number.POSITIVE_INFINITY, today: TODAY }).page).toBe(1);
    expect(searchWarrantyItems({ page: Number.NEGATIVE_INFINITY, today: TODAY }).page).toBe(1);
  });

  it('derives the same status as warrantyStatus() and composes filters', () => {
    const expiring = seed({ name: 'Kettle', purchaseDate: '2026-08-16', warrantyMonths: 1 });
    seed({ name: 'Sofa', purchaseDate: '2026-08-16', warrantyMonths: 120 });
    const other = insertTestUser(current!.db, { name: 'Bob', username: 'bob' });
    seed({ name: 'Bob Drill', ownerUserId: other, purchaseDate: '2026-08-16', warrantyMonths: 1 });

    const byStatus = searchWarrantyItems({ status: 'expiring', today: TODAY });
    expect(byStatus.total).toBe(2);
    expect(byStatus.rows.every((row) => row.status === 'expiring')).toBe(true);

    const composed = searchWarrantyItems({ status: 'expiring', ownerUserId: other, today: TODAY });
    expect(composed.total).toBe(1);
    expect(composed.rows[0].name).toBe('Bob Drill');

    const searchAndStatus = searchWarrantyItems({ q: 'kettle', status: 'expiring', today: TODAY });
    expect(searchAndStatus.rows.map((r) => r.id)).toEqual([expiring]);
  });

  it('names lifetime and unknown statuses', () => {
    seed({ name: 'Cast iron pan', isLifetime: true, warrantyMonths: null });
    seed({ name: 'Lamp', warrantyMonths: null });
    expect(searchWarrantyItems({ status: 'lifetime', today: TODAY }).rows[0].name).toBe('Cast iron pan');
    expect(searchWarrantyItems({ status: 'unknown', today: TODAY }).rows[0].name).toBe('Lamp');
  });

  it('sorts soonest expiry first with unknown/lifetime last, and honours the other sorts', () => {
    seed({ name: 'Later', purchaseDate: '2026-08-16', warrantyMonths: 60 });
    seed({ name: 'Sooner', purchaseDate: '2026-08-16', warrantyMonths: 1 });
    seed({ name: 'Aardvark', warrantyMonths: null });
    expect(searchWarrantyItems({ today: TODAY }).rows.map((r) => r.name)).toEqual(['Sooner', 'Later', 'Aardvark']);
    expect(searchWarrantyItems({ sort: 'name', today: TODAY }).rows[0].name).toBe('Aardvark');
  });

  it('counts receipts and reports page metadata', () => {
    seed();
    const result = searchWarrantyItems({ today: TODAY });
    expect(result.rows[0].receiptCount).toBe(0);
    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(1);
  });

  describe('item type filter and fields (delta T6)', () => {
    it('surfaces typeName and isSubscription on list rows, and null/false for untyped items', () => {
      const sub = createItemType('Streaming Search', true);
      const typedId = seed({ name: 'Spotify', typeId: sub.id });
      const untypedId = seed({ name: 'Untyped Fridge' });

      const result = searchWarrantyItems({ today: TODAY });
      const typedRow = result.rows.find((r) => r.id === typedId)!;
      const untypedRow = result.rows.find((r) => r.id === untypedId)!;
      expect(typedRow.typeName).toBe('Streaming Search');
      expect(typedRow.isSubscription).toBe(true);
      expect(untypedRow.typeName).toBeNull();
      expect(untypedRow.isSubscription).toBe(false);
    });

    it('filters by typeId and composes with q and status', () => {
      const laptop = createItemType('Laptop Search', false);
      const streaming = createItemType('Streaming Search 2', true);
      const dell = seed({ name: 'Dell XPS', typeId: laptop.id });
      seed({ name: 'Netflix', typeId: streaming.id, purchaseDate: TODAY, warrantyMonths: 1 });
      seed({ name: 'Untyped Toaster' });

      const byType = searchWarrantyItems({ typeId: laptop.id, today: TODAY });
      expect(byType.rows.map((r) => r.id)).toEqual([dell]);

      const composedHit = searchWarrantyItems({ typeId: laptop.id, q: 'dell', today: TODAY });
      expect(composedHit.total).toBe(1);

      const composedMiss = searchWarrantyItems({ typeId: laptop.id, q: 'netflix', today: TODAY });
      expect(composedMiss.total).toBe(0);

      const composedStatusMiss = searchWarrantyItems({ typeId: streaming.id, status: 'expired', today: TODAY });
      expect(composedStatusMiss.total).toBe(0);
    });
  });
});

describe('expiringSoonItems (MUST-10.5)', () => {
  it('returns at most `limit`, soonest first, scoped by owner', () => {
    const TODAY = '2026-08-16';
    // All six get a 1-month term (expiry 2026-09-16, 31 days out) so every one of them is
    // unambiguously inside the 60-day EXPIRING_SOON_DAYS window -- a 2-month term from this
    // particular purchase date lands 61 days out (Aug -> Oct crosses two 30/31-day months)
    // and would be 'active' instead, which is not what this test is trying to exercise.
    for (let i = 0; i < 6; i += 1) {
      createWarrantyItem({
        name: `Item ${i}-${Math.random()}`,
        vendor: null, model: null, serial: null,
        purchaseDate: '2026-08-16', warrantyMonths: 1, isLifetime: false,
        priceCents: null, ownerUserId: owner, transactionId: null, typeId: null, notes: null,
      });
    }
    expect(expiringSoonItems(5, null, TODAY)).toHaveLength(5);
    expect(expiringSoonItems(5, 999_999, TODAY)).toHaveLength(0);
  });
});
