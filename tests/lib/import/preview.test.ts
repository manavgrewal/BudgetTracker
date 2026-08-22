import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { buildPreview, PREVIEW_ROW_LIMIT } from '@/lib/import/preview';
import { writeStagedFile } from '@/lib/import/staging';
import { getBuiltinPreset } from '@/lib/import/presets';
import { commitImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { parseCsv } from '@/lib/import/parse';
import { upsertRuleFromCorrection } from '@/lib/categorize/rules';
import type { ImportMapping } from '@/lib/import/mapping';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-preview-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function setup(fixtureName = 'td-chequing.csv') {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const stagingId = writeStagedFile(fixture(fixtureName));
  return { db: current.db, sqlite: current.sqlite, userId, accountId, stagingId };
}

describe('buildPreview', () => {
  it('returns parsed rows with hashes, the detected encoding and the row counts', () => {
    const { accountId, stagingId } = setup();
    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });

    expect(preview).toMatchObject({ stagingId, filename: 'td.csv', accountId, encoding: 'utf-8', totalRows: 9, duplicateCount: 0, errorCount: 0, skipped: 0, truncated: false });
    expect(preview.rows).toHaveLength(9);
    expect(preview.rows[0]).toMatchObject({
      rowIndex: 0,
      rawDate: '2026-03-02',
      date: '2026-03-02',
      amountCents: -485,
      normalizedMerchant: 'TIM HORTONS',
      occurrenceIndex: 0,
      isDuplicate: false,
      duplicateTransactionId: null,
    });
    expect(preview.rows[0].dedupHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('flags rows already present in the database', () => {
    const { userId, accountId, stagingId } = setup();
    const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
    const hashed = computeRowHashes(accountId, parsed.rows);
    const committed = commitImport({ accountId, profileId: null, filename: 'first.csv', importedBy: userId, rows: hashed.slice(0, 4), errors: [] });

    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
    expect(preview.duplicateCount).toBe(4);
    expect(preview.rows.slice(0, 4).every((r) => r.isDuplicate)).toBe(true);
    expect(preview.rows[0].duplicateTransactionId).toBe(committed.insertedTransactionIds[0]);
    expect(preview.rows[4].isDuplicate).toBe(false);
  });

  it('scopes duplicate detection to the account', () => {
    const { db, userId, accountId, stagingId } = setup();
    const otherAccount = insertTestAccount(db, { name: 'Other' });
    const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
    commitImport({ accountId: otherAccount, profileId: null, filename: 'other.csv', importedBy: userId, rows: computeRowHashes(otherAccount, parsed.rows), errors: [] });

    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
    expect(preview.duplicateCount).toBe(0);
  });

  it('predicts a category per row without writing anything', () => {
    const { db, accountId, stagingId, sqlite } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null });

    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
    expect(preview.rows[0]).toMatchObject({ predictedCategoryId: coffee, predictedCategoryName: 'Coffee', predictedSource: 'rule' });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  it('marks card payments as transfers in the preview', () => {
    const { accountId, stagingId } = setup('td-visa.csv');
    const preview = buildPreview({ stagingId, filename: 'visa.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Visa') });
    const payment = preview.rows.find((r) => r.rawDescription === 'PAYMENT - THANK YOU');
    expect(payment?.isTransfer).toBe(true);
    expect(preview.rows.find((r) => r.rawDescription.startsWith('ESSO'))?.isTransfer).toBe(false);
  });

  it('lists error rows without dropping them silently', () => {
    // TD Visa's layout (date, desc, debit, credit) matches this fixture's columns
    // and its MM/DD/YYYY date format, unlike TD Chequing/Debit which now expects
    // ISO dates (src/lib/import/presets.ts, corrected against real exports).
    const { accountId, stagingId } = setup('mint-like-edge-cases.csv');
    const preview = buildPreview({ stagingId, filename: 'edge.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Visa') });
    expect(preview.errorCount).toBe(5);
    expect(preview.errors.map((e) => e.reason)).toContain('unparseable date');
    expect(preview.totalRows).toBe(3);
  });

  it('reports the detected encoding for a windows-1252 file', () => {
    // Same MM/DD/YYYY-vs-ISO reasoning as above: TD Visa's mapping fits this fixture.
    const { accountId, stagingId } = setup('td-chequing-win1252.csv');
    const preview = buildPreview({ stagingId, filename: 'fr.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Visa') });
    expect(preview.encoding).toBe('windows-1252');
    expect(preview.rows[0].rawDescription).toContain('CAFÉ RÉPUBLIQUE');
  });

  it('truncates the preview table but keeps the true totals', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const line = (n: number) => `2026-03-02,SHOP ${n},4.85,,0.00`;
    const csv = Buffer.from(Array.from({ length: PREVIEW_ROW_LIMIT + 25 }, (_, i) => line(i)).join('\n'), 'utf8');
    const stagingId = writeStagedFile(csv);

    const preview = buildPreview({ stagingId, filename: 'big.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
    expect(preview.rows).toHaveLength(PREVIEW_ROW_LIMIT);
    expect(preview.totalRows).toBe(PREVIEW_ROW_LIMIT + 25);
    expect(preview.truncated).toBe(true);
  });

  describe('dateFormatDetection (PENDING-FIXES #1, option B)', () => {
    it('is unique for a file whose date column only fits one known format', () => {
      // amex.csv's dates are "02 Mar 2026" etc — only 'DD-MMM-YYYY' parses them.
      const { accountId, stagingId } = setup('amex.csv');
      const preview = buildPreview({ stagingId, filename: 'amex.csv', accountId, profileId: null, mapping: getBuiltinPreset('Amex Canada') });
      expect(preview.dateFormatDetection.status).toBe('unique');
      expect(preview.dateFormatDetection.detected).toBe('DD-MMM-YYYY');
    });

    it('resolves deterministically when the surviving formats can never disagree', () => {
      // td-chequing.csv's dates are ISO ("2026-03-02"), which both 'YYYY-MM-DD' and
      // 'YYYY/MM/DD' parse identically (see dates.ts) — a harmless tie, not a real
      // ambiguity, so detection still names one winner instead of asking the user.
      const { accountId, stagingId } = setup();
      const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect(preview.dateFormatDetection.status).toBe('resolved');
      expect(preview.dateFormatDetection.detected).toBe('YYYY-MM-DD');
      expect(preview.dateFormatDetection.candidates).toContain('YYYY/MM/DD');
    });

    it('is ambiguous for a real DD/MM vs MM/DD file and still honours the explicitly chosen dateFormat', () => {
      current = createSeededTestDb();
      const accountId = insertTestAccount(current.db);
      const csv = Buffer.from(
        ['03/04/2026,SHOP A,4.85,,0.00', '05/06/2026,SHOP B,10.00,,0.00'].join('\n'),
        'utf8',
      );
      const stagingId = writeStagedFile(csv);
      const mapping: ImportMapping = { ...getBuiltinPreset('TD Chequing/Debit'), dateFormat: 'MM/DD/YYYY' };

      const preview = buildPreview({ stagingId, filename: 'ambiguous.csv', accountId, profileId: null, mapping });
      expect(preview.dateFormatDetection.status).toBe('ambiguous');
      expect(preview.dateFormatDetection.detected).toBeNull();
      expect(preview.dateFormatDetection.candidates).toEqual(expect.arrayContaining(['MM/DD/YYYY', 'DD/MM/YYYY']));
      // The explicit mapping.dateFormat still won — rows parsed as MM/DD/YYYY, not
      // overridden by detection disagreeing with it.
      expect(preview.rows[0].date).toBe('2026-03-04');
      expect(preview.rows[1].date).toBe('2026-05-06');
    });

    it('reports none, without throwing, when nothing in the date column parses', () => {
      current = createSeededTestDb();
      const accountId = insertTestAccount(current.db);
      const csv = Buffer.from(['N/A,SHOP A,4.85,,0.00', 'N/A,SHOP B,10.00,,0.00'].join('\n'), 'utf8');
      const stagingId = writeStagedFile(csv);

      const preview = buildPreview({ stagingId, filename: 'none.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect(preview.dateFormatDetection).toEqual({ status: 'none', detected: null, candidates: [] });
      expect(preview.errorCount).toBe(2);
    });

    it('samples the raw date column even for rows the current dateFormat fails to parse', () => {
      // The mapping below is wrong on purpose (ISO expected, file is MM/DD/YYYY), so every
      // row lands in `errors` with reason 'unparseable date' — detection must still see the
      // raw column via those error rows' cells, not just successfully parsed rows.
      current = createSeededTestDb();
      const accountId = insertTestAccount(current.db);
      const csv = Buffer.from(['03/14/2026,SHOP A,4.85,,0.00', '01/05/2026,SHOP B,10.00,,0.00'].join('\n'), 'utf8');
      const stagingId = writeStagedFile(csv);

      const preview = buildPreview({ stagingId, filename: 'wrong-format.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect(preview.errorCount).toBe(2);
      expect(preview.dateFormatDetection.status).toBe('unique');
      expect(preview.dateFormatDetection.detected).toBe('MM/DD/YYYY');
    });
  });
});
