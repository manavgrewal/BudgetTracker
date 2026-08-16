import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  DEDUP_HASH_VERSION,
  assignOccurrenceIndexes,
  computeRowHashes,
  dedupDescription,
  dedupHash,
  findExistingByHashes,
} from '@/lib/import/dedup';
import { parseCsv } from '@/lib/import/parse';
import { getBuiltinPreset } from '@/lib/import/presets';
import { nowIso } from '@/lib/clock';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('dedupDescription — FROZEN normalization', () => {
  it('uppercases and collapses whitespace and does nothing else', () => {
    expect(dedupDescription('POS PURCHASE       TIM HORTONS #4821 TORONTO ON')).toBe(
      'POS PURCHASE TIM HORTONS #4821 TORONTO ON',
    );
    expect(dedupDescription('  tim   hortons  ')).toBe('TIM HORTONS');
    expect(dedupDescription('a\tb\r\nc')).toBe('A B C');
  });

  it('keeps every token the LEARNING normalizer is allowed to strip', () => {
    // Channel prefix, store number, long digit run, city + province tail all survive.
    const raw = 'INTERAC PURCHASE 4821 METRO #178 MISSISSAUGA ON';
    expect(dedupDescription(raw)).toBe('INTERAC PURCHASE 4821 METRO #178 MISSISSAUGA ON');
    expect(dedupDescription('PRE-AUTH PAYMENT ROGERS 000123456789')).toBe('PRE-AUTH PAYMENT ROGERS 000123456789');
  });

  it('keeps accented characters and punctuation intact', () => {
    expect(dedupDescription('café   république')).toBe('CAFÉ RÉPUBLIQUE');
    expect(dedupDescription('AMZN Mktp CA*RT4XY9083')).toBe('AMZN MKTP CA*RT4XY9083');
  });

  it('is structurally independent of the learning normalizer', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'import', 'dedup.ts'), 'utf8');
    expect(source).not.toContain('categorize/normalize');
    expect(source).not.toContain('normalizeMerchant');
  });
});

describe('dedupHash', () => {
  const input = {
    accountId: 7,
    rawDate: '03/14/2026',
    amountCents: -1234,
    rawDescription: 'tim   hortons #123',
    occurrenceIndex: 0,
  };

  it('hashes exactly version|account|rawDate|cents|dedupDesc|occurrence', () => {
    const expected = createHash('sha256').update('1|7|03/14/2026|-1234|TIM HORTONS #123|0').digest('hex');
    // Pinned literal so the frozen value is auditable without executing anything.
    // If the preimage above ever changes, do NOT update this literal to match —
    // the preimage is what's frozen; recompute only if the inputs above changed for a legitimate reason.
    expect(expected).toBe('9c454ed2e6fc780b8c203eae39610a55e541a735084535330414821017feaa92');
    expect(dedupHash(input)).toBe(expected);
    expect(DEDUP_HASH_VERSION).toBe(1);
  });

  it('trims the raw date string before hashing', () => {
    expect(dedupHash({ ...input, rawDate: '  03/14/2026 ' })).toBe(dedupHash(input));
  });

  it('changes when any component changes', () => {
    expect(dedupHash({ ...input, accountId: 8 })).not.toBe(dedupHash(input));
    expect(dedupHash({ ...input, amountCents: -1235 })).not.toBe(dedupHash(input));
    expect(dedupHash({ ...input, rawDate: '03/15/2026' })).not.toBe(dedupHash(input));
    expect(dedupHash({ ...input, rawDescription: 'TIM HORTONS #124' })).not.toBe(dedupHash(input));
    expect(dedupHash({ ...input, occurrenceIndex: 1 })).not.toBe(dedupHash(input));
  });

  it('is invariant to whitespace and case in the description', () => {
    expect(dedupHash({ ...input, rawDescription: 'TIM HORTONS #123' })).toBe(dedupHash(input));
    expect(dedupHash({ ...input, rawDescription: '  Tim\tHortons   #123  ' })).toBe(dedupHash(input));
  });
});

describe('assignOccurrenceIndexes', () => {
  const row = (rawDate: string, amountCents: number, rawDescription: string) => ({ rawDate, amountCents, rawDescription });

  it('numbers identical rows 0, 1, 2 in file order', () => {
    const out = assignOccurrenceIndexes([
      row('03/07/2026', -485, 'TIM HORTONS'),
      row('03/07/2026', -485, 'TIM HORTONS'),
      row('03/07/2026', -485, 'TIM HORTONS'),
    ]);
    expect(out.map((r) => r.occurrenceIndex)).toEqual([0, 1, 2]);
  });

  it('keeps separate counters per (rawDate, amount, description) group', () => {
    const out = assignOccurrenceIndexes([
      row('03/07/2026', -485, 'TIM HORTONS'),
      row('03/07/2026', -600, 'TIM HORTONS'),
      row('03/08/2026', -485, 'TIM HORTONS'),
      row('03/07/2026', -485, 'STARBUCKS'),
      row('03/07/2026', -485, 'TIM HORTONS'),
    ]);
    expect(out.map((r) => r.occurrenceIndex)).toEqual([0, 0, 0, 0, 1]);
  });

  it('groups by the FROZEN description, not the raw string', () => {
    const out = assignOccurrenceIndexes([row('03/07/2026', -485, 'tim  hortons'), row('03/07/2026', -485, 'TIM HORTONS')]);
    expect(out.map((r) => r.occurrenceIndex)).toEqual([0, 1]);
  });

  it('is stable — the same input always yields the same indexes', () => {
    const input = [row('03/07/2026', -485, 'A'), row('03/07/2026', -485, 'A')];
    expect(assignOccurrenceIndexes(input)).toEqual(assignOccurrenceIndexes(input));
  });
});

describe('computeRowHashes over real fixtures', () => {
  it('gives the two identical TD rows different hashes', () => {
    const { rows } = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
    const hashed = computeRowHashes(1, rows);
    const timmies = hashed.filter((r) => r.rawDate === '2026-03-07');
    expect(timmies).toHaveLength(2);
    expect(timmies[0].occurrenceIndex).toBe(0);
    expect(timmies[1].occurrenceIndex).toBe(1);
    expect(timmies[0].dedupHash).not.toBe(timmies[1].dedupHash);
  });

  it('stamps every row with the current hash version explicitly (not left to the schema default)', () => {
    const { rows } = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
    const hashed = computeRowHashes(1, rows);
    expect(hashed.every((r) => r.hashVersion === DEDUP_HASH_VERSION)).toBe(true);
  });

  it('is idempotent — re-parsing the same file yields identical hashes', () => {
    const mapping = getBuiltinPreset('TD Chequing/Debit');
    const first = computeRowHashes(1, parseCsv(fixture('td-chequing.csv'), mapping).rows);
    const second = computeRowHashes(1, parseCsv(fixture('td-chequing.csv'), mapping).rows);
    expect(second.map((r) => r.dedupHash)).toEqual(first.map((r) => r.dedupHash));
  });

  it('produces different hashes for the same file imported into a different account', () => {
    const mapping = getBuiltinPreset('TD Chequing/Debit');
    const rows = parseCsv(fixture('td-chequing.csv'), mapping).rows;
    expect(computeRowHashes(1, rows)[0].dedupHash).not.toBe(computeRowHashes(2, rows)[0].dedupHash);
  });

  it('error rows do not consume an occurrence index', () => {
    // An unparseable-date row sandwiched between two IDENTICAL valid rows. A broken
    // implementation that counts the error row (or lets it consume an index before
    // being dropped) would number the surviving pair [0, 2] instead of [0, 1].
    const csv = Buffer.from(
      ['2026-03-07,TIM HORTONS,4.85,,', '2026-13-45,BAD DATE ROW,10.00,,', '2026-03-07,TIM HORTONS,4.85,,'].join('\n') + '\n',
      'utf8',
    );
    const { rows, errors } = parseCsv(csv, getBuiltinPreset('TD Chequing/Debit'));
    expect(errors).toHaveLength(1);
    expect(rows).toHaveLength(2);
    const hashed = computeRowHashes(1, rows);
    expect(hashed.map((r) => r.occurrenceIndex)).toEqual([0, 1]);
  });

  it('is unchanged by a profile mapping edit that changes the PARSED date', () => {
    // Same file, two date formats: 03/04/2026 parses as March 4 or April 3.
    const csv = Buffer.from('03/04/2026,COFFEE SHOP,4.85,,0.00\n', 'utf8');
    const asMdy = parseCsv(csv, { ...getBuiltinPreset('TD Chequing/Debit'), dateFormat: 'MM/DD/YYYY' });
    const asDmy = parseCsv(csv, { ...getBuiltinPreset('TD Chequing/Debit'), dateFormat: 'DD/MM/YYYY' });
    expect(asMdy.rows[0].date).toBe('2026-03-04');
    expect(asDmy.rows[0].date).toBe('2026-04-03');
    expect(computeRowHashes(1, asMdy.rows)[0].dedupHash).toBe(computeRowHashes(1, asDmy.rows)[0].dedupHash);
  });

  it('is unchanged by a description-column mapping edit only when the joined text is unchanged', () => {
    const csv = Buffer.from('03/04/2026,-45.00,,PETRO-CANADA\n', 'utf8');
    const base = getBuiltinPreset('Scotiabank Chequing/Debit');
    const one = computeRowHashes(1, parseCsv(csv, base).rows)[0].dedupHash;
    const two = computeRowHashes(1, parseCsv(csv, { ...base, descCols: [3, 2] }).rows)[0].dedupHash;
    expect(two).toBe(one); // column 2 is empty, so the joined description is identical
  });
});

describe('findExistingByHashes', () => {
  it('maps existing hashes to their transaction ids, scoped to the account', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountA = insertTestAccount(current.db, { name: 'A' });
    const accountB = insertTestAccount(current.db, { name: 'B' });
    const hashA = dedupHash({ accountId: accountA, rawDate: '03/02/2026', amountCents: -485, rawDescription: 'TIM', occurrenceIndex: 0 });

    const inserted = current.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, dedup_hash, hash_version, created_by, created_at, updated_at)
      values (${accountA}, '2026-03-02', 'TIM', 'TIM', -485, ${hashA}, 1, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);

    const found = findExistingByHashes(accountA, [hashA, 'no-such-hash']);
    expect(found.get(hashA)).toBe(inserted.id);
    expect(found.has('no-such-hash')).toBe(false);
    expect(findExistingByHashes(accountB, [hashA]).size).toBe(0);
  });

  it('returns an empty map for an empty hash list', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    expect(findExistingByHashes(accountId, []).size).toBe(0);
  });

  it('never matches manual entries, whose dedup_hash is NULL', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    current.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, dedup_hash, hash_version, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'COFFEE', 'COFFEE', -500, null, 1, ${userId}, ${nowIso()}, ${nowIso()})`);
    current.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, dedup_hash, hash_version, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'COFFEE', 'COFFEE', -500, null, 1, ${userId}, ${nowIso()}, ${nowIso()})`);
    const count = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    expect(count.c).toBe(2); // two identical manual coffees are legitimate
    expect(findExistingByHashes(accountId, ['']).size).toBe(0);
  });
});
