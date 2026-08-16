import Papa from 'papaparse';
import { parseDateString } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';
import { decodeBuffer, type DetectedEncoding } from './decode';
import type { EncodingChoice, ImportMapping } from './mapping';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 10_000;

export class ImportLimitError extends Error {
  readonly code: 'file_too_large' | 'too_many_rows';
  constructor(code: 'file_too_large' | 'too_many_rows', message: string) {
    super(message);
    this.name = 'ImportLimitError';
    this.code = code;
  }
}

export interface CandidateRow {
  rowIndex: number;
  rawDate: string;
  date: string;
  rawDescription: string;
  amountCents: number;
  cells: string[];
}

export type RowErrorReason =
  | 'unparseable date'
  | 'missing description'
  | 'unparseable amount'
  | 'missing amount'
  | 'ambiguous amount'
  | 'malformed row';

export interface RowError {
  rowIndex: number;
  cells: string[];
  reason: RowErrorReason;
}

export interface ParseResult {
  rows: CandidateRow[];
  errors: RowError[];
  encoding: DetectedEncoding;
  skipped: number;
}

function splitRows(text: string): string[][] {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    // papaparse handles quoted embedded newlines and commas natively (Amex needs both).
  });
  return parsed.data.filter((row) => Array.isArray(row));
}

function cell(cells: string[], index: number | null): string {
  if (index === null) return '';
  const value = cells[index];
  return typeof value === 'string' ? value : '';
}

export function parseCsv(buf: Buffer, mapping: ImportMapping): ParseResult {
  if (buf.length > MAX_FILE_BYTES) {
    throw new ImportLimitError('file_too_large', `File is larger than ${MAX_FILE_BYTES} bytes`);
  }

  const { text, encoding } = decodeBuffer(buf, mapping.encoding);
  const allRows = splitRows(text);
  const skipCount = mapping.hasHeader ? Math.max(mapping.headerRows, 1) : mapping.headerRows;
  const dataRows = allRows.slice(skipCount);

  if (dataRows.length > MAX_ROWS) {
    throw new ImportLimitError('too_many_rows', `File has more than ${MAX_ROWS} rows`);
  }

  const rows: CandidateRow[] = [];
  const errors: RowError[] = [];
  let skipped = 0;

  dataRows.forEach((cells, rowIndex) => {
    if (mapping.skipRules && mapping.skipRules.containsAny.length > 0) {
      const joined = cells.join(' ').toUpperCase();
      if (mapping.skipRules.containsAny.some((needle) => joined.includes(needle.toUpperCase()))) {
        skipped += 1;
        return;
      }
    }

    if (cells.length === 1 && cells[0].trim() === '') {
      errors.push({ rowIndex, cells, reason: 'malformed row' });
      return;
    }

    const rawDate = cell(cells, mapping.dateCol).trim();
    const date = parseDateString(rawDate, mapping.dateFormat);
    if (date === null) {
      errors.push({ rowIndex, cells, reason: 'unparseable date' });
      return;
    }

    const rawDescription = mapping.descCols
      .map((index) => cell(cells, index).trim())
      .filter((part) => part.length > 0)
      .join(' ');
    if (rawDescription.length === 0) {
      errors.push({ rowIndex, cells, reason: 'missing description' });
      return;
    }

    let amountCents: number;
    if (mapping.amountMode === 'signed') {
      const parsed = parseAmountToCents(cell(cells, mapping.amountCol));
      if (parsed === null) {
        const blank = cell(cells, mapping.amountCol).trim().length === 0;
        errors.push({ rowIndex, cells, reason: blank ? 'missing amount' : 'unparseable amount' });
        return;
      }
      amountCents = mapping.signConvention === 'positive_is_spend' ? -parsed : parsed;
    } else {
      const debitRaw = cell(cells, mapping.debitCol).trim();
      const creditRaw = cell(cells, mapping.creditCol).trim();
      const debit = debitRaw.length === 0 ? null : parseAmountToCents(debitRaw);
      const credit = creditRaw.length === 0 ? null : parseAmountToCents(creditRaw);

      if (debitRaw.length > 0 && debit === null) {
        errors.push({ rowIndex, cells, reason: 'unparseable amount' });
        return;
      }
      if (creditRaw.length > 0 && credit === null) {
        errors.push({ rowIndex, cells, reason: 'unparseable amount' });
        return;
      }
      if (debit === null && credit === null) {
        errors.push({ rowIndex, cells, reason: 'missing amount' });
        return;
      }
      if (debit !== null && credit !== null && debit !== 0 && credit !== 0) {
        errors.push({ rowIndex, cells, reason: 'ambiguous amount' });
        return;
      }
      // -debit (not -|debit|) so a negative debit reads as a refund.
      amountCents = debit !== null && debit !== 0 ? -debit : (credit ?? 0);
    }

    rows.push({ rowIndex, rawDate, date, rawDescription, amountCents, cells });
  });

  return { rows, errors, encoding, skipped };
}

export function previewRawRows(
  buf: Buffer,
  encoding: EncodingChoice,
  limit = 10,
): { rows: string[][]; encoding: DetectedEncoding } {
  if (buf.length > MAX_FILE_BYTES) {
    throw new ImportLimitError('file_too_large', `File is larger than ${MAX_FILE_BYTES} bytes`);
  }
  const decoded = decodeBuffer(buf, encoding);
  return { rows: splitRows(decoded.text).slice(0, limit), encoding: decoded.encoding };
}
