import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ImportLimitError, MAX_ROWS, parseCsv, previewRawRows } from '@/lib/import/parse';
import { getBuiltinPreset } from '@/lib/import/presets';
import type { ImportMapping } from '@/lib/import/mapping';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

describe('TD Chequing/Debit preset', () => {
  const mapping = getBuiltinPreset('TD Chequing/Debit');

  it('parses every row of the fixture with no errors', () => {
    const result = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(9);
    expect(result.encoding).toBe('utf-8');
  });

  it('treats the debit column as money out and the credit column as money in', () => {
    const { rows } = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(rows[0]).toMatchObject({ rowIndex: 0, rawDate: '03/02/2026', date: '2026-03-02', amountCents: -485 });
    expect(rows[2]).toMatchObject({ date: '2026-03-04', amountCents: 214567 });
  });

  it('keeps the raw description verbatim, including the bank’s space runs', () => {
    const { rows } = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(rows[0].rawDescription).toBe('POS PURCHASE       TIM HORTONS #4821 TORONTO ON');
  });

  it('preserves the raw date string separately from the parsed date', () => {
    const { rows } = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(rows[6].rawDate).toBe('03/07/2026');
    expect(rows[6].date).toBe('2026-03-07');
  });
});

describe('TD Visa preset', () => {
  it('reads a refund out of the credit column as a positive amount', () => {
    const { rows, errors } = parseCsv(fixture('td-visa.csv'), getBuiltinPreset('TD Visa'));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(6);
    expect(rows[5]).toMatchObject({ rawDescription: 'AMZN Mktp CA*RT4XY9083 REFUND', amountCents: 4127 });
    expect(rows[3]).toMatchObject({ rawDescription: 'PAYMENT - THANK YOU', amountCents: 50000 });
  });
});

describe('Scotiabank preset', () => {
  it('reads the signed amount column with negative = money out', () => {
    const { rows, errors } = parseCsv(fixture('scotia.csv'), getBuiltinPreset('Scotiabank Chequing/Debit'));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ date: '2026-03-02', rawDescription: 'PETRO-CANADA 12345 BURLINGTON ON', amountCents: -4500 });
    expect(rows[2].amountCents).toBe(150000);
  });
});

describe('Amex Canada preset', () => {
  const mapping = getBuiltinPreset('Amex Canada');

  it('skips the header row and flips the sign (positive = charge)', () => {
    const { rows, errors } = parseCsv(fixture('amex.csv'), mapping);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ rowIndex: 0, date: '2026-03-02', rawDescription: 'CAFE DEPOT MONTREAL', amountCents: -1875 });
  });

  it('handles quoted embedded newlines without shifting the row alignment', () => {
    const { rows } = parseCsv(fixture('amex.csv'), mapping);
    expect(rows.map((r) => r.date)).toEqual(['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-07', '2026-03-09']);
  });

  it('turns a negative Amex amount into a positive credit', () => {
    const { rows } = parseCsv(fixture('amex.csv'), mapping);
    expect(rows[2]).toMatchObject({ rawDescription: 'AMEX PAYMENT RECEIVED - THANK YOU', amountCents: 35000 });
    expect(rows[4]).toMatchObject({ rawDescription: 'UNIQLO CANADA TORONTO', amountCents: 5999 });
  });

  it('ignores the Amex Category column in v1', () => {
    const { rows } = parseCsv(fixture('amex.csv'), mapping);
    expect(rows[0].rawDescription).not.toContain('Restaurant');
  });
});

describe('windows-1252 fixture', () => {
  it('reports the detected encoding and keeps accented merchants intact', () => {
    const result = parseCsv(fixture('td-chequing-win1252.csv'), getBuiltinPreset('TD Chequing/Debit'));
    expect(result.encoding).toBe('windows-1252');
    expect(result.errors).toEqual([]);
    expect(result.rows[0].rawDescription).toContain('CAFÉ RÉPUBLIQUE');
    expect(result.rows[1].rawDescription).toContain('MÉTRO PLUS');
  });
});

describe('row-level errors', () => {
  const mapping = getBuiltinPreset('TD Chequing/Debit');

  it('collects each failure without aborting the file', () => {
    const result = parseCsv(fixture('mint-like-edge-cases.csv'), mapping);
    expect(result.errors.map((e) => [e.rowIndex, e.reason])).toEqual([
      [0, 'unparseable date'],
      [1, 'unparseable amount'],
      [3, 'missing description'],
      [4, 'missing amount'],
      [5, 'ambiguous amount'],
    ]);
    expect(result.rows.map((r) => r.rowIndex)).toEqual([2, 6, 7]);
  });

  it('keeps a quoted comma inside one description cell', () => {
    const { rows } = parseCsv(fixture('mint-like-edge-cases.csv'), mapping);
    expect(rows[0]).toMatchObject({ rowIndex: 2, rawDescription: 'DESCRIPTION, WITH COMMA', amountCents: -2500 });
  });

  it('treats a negative debit as a refund', () => {
    const { rows } = parseCsv(fixture('mint-like-edge-cases.csv'), mapping);
    expect(rows[2]).toMatchObject({ rowIndex: 7, rawDescription: 'NEGATIVE DEBIT IS A REFUND', amountCents: 1999 });
  });

  it('numbers error rowIndexes on the same scale as row rowIndexes', () => {
    const result = parseCsv(fixture('mint-like-edge-cases.csv'), mapping);
    const all = [...result.rows.map((r) => r.rowIndex), ...result.errors.map((e) => e.rowIndex)].sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('mapping options', () => {
  it('joins multiple description columns with a single space', () => {
    const mapping: ImportMapping = { ...getBuiltinPreset('Scotiabank Chequing/Debit'), descCols: [3, 1] };
    const { rows } = parseCsv(fixture('scotia.csv'), mapping);
    expect(rows[0].rawDescription).toBe('PETRO-CANADA 12345 BURLINGTON ON -45.00');
  });

  it('applies skipRules', () => {
    const mapping: ImportMapping = {
      ...getBuiltinPreset('TD Chequing/Debit'),
      skipRules: { containsAny: ['E-TRANSFER', 'MONTHLY ACCOUNT FEE'] },
    };
    const result = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(result.skipped).toBe(2);
    expect(result.rows).toHaveLength(7);
    expect(result.rows.some((r) => r.rawDescription.includes('E-TRANSFER'))).toBe(false);
  });

  it('honours headerRows greater than 1', () => {
    const csv = Buffer.from(['bank export', 'Date,Amount,x,Desc', '03/02/2026,-45.00,,COFFEE'].join('\n'), 'utf8');
    const mapping: ImportMapping = { ...getBuiltinPreset('Scotiabank Chequing/Debit'), hasHeader: true, headerRows: 2 };
    const { rows, errors } = parseCsv(csv, mapping);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawDescription).toBe('COFFEE');
  });

  it('accepts an explicit encoding override from the mapping', () => {
    const mapping: ImportMapping = { ...getBuiltinPreset('TD Chequing/Debit'), encoding: 'windows-1252' };
    expect(parseCsv(fixture('td-chequing-win1252.csv'), mapping).encoding).toBe('windows-1252');
  });
});

describe('limits', () => {
  it('rejects a file over 5 MB', () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
    expect(() => parseCsv(big, getBuiltinPreset('TD Chequing/Debit'))).toThrowError(ImportLimitError);
    try {
      parseCsv(big, getBuiltinPreset('TD Chequing/Debit'));
    } catch (error) {
      expect((error as ImportLimitError).code).toBe('file_too_large');
    }
  });

  it('rejects a file over 10,000 rows', () => {
    const line = '03/02/2026,COFFEE,4.85,,0.00';
    const csv = Buffer.from(Array.from({ length: MAX_ROWS + 1 }, () => line).join('\n'), 'utf8');
    try {
      parseCsv(csv, getBuiltinPreset('TD Chequing/Debit'));
      throw new Error('expected ImportLimitError');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportLimitError);
      expect((error as ImportLimitError).code).toBe('too_many_rows');
    }
  });

  it('accepts exactly 10,000 rows', () => {
    const line = '03/02/2026,COFFEE,4.85,,0.00';
    const csv = Buffer.from(Array.from({ length: MAX_ROWS }, () => line).join('\n'), 'utf8');
    expect(parseCsv(csv, getBuiltinPreset('TD Chequing/Debit')).rows).toHaveLength(MAX_ROWS);
  });
});

describe('previewRawRows', () => {
  it('returns the first N raw rows including any header, for the mapping wizard', () => {
    const { rows, encoding } = previewRawRows(fixture('amex.csv'), 'auto', 3);
    expect(encoding).toBe('utf-8');
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe('Date');
    expect(rows[1][0]).toBe('03/02/2026');
    expect(rows[1][3]).toContain('\n');
  });

  it('defaults to 10 rows', () => {
    const { rows } = previewRawRows(fixture('td-chequing.csv'), 'auto');
    expect(rows).toHaveLength(9);
  });
});
