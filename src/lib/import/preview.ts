import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { categories } from '@/db/schema';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { buildContext, categorizeTransaction } from '@/lib/categorize/engine';
import { computeRowHashes, findExistingByHashes } from './dedup';
import type { ImportMapping } from './mapping';
import { parseCsv, type RowError } from './parse';
import { readStagedFile } from './staging';
import type { DetectedEncoding } from './decode';

export const PREVIEW_ROW_LIMIT = 200;

export interface PreviewRow {
  rowIndex: number;
  rawDate: string;
  date: string;
  rawDescription: string;
  normalizedMerchant: string;
  amountCents: number;
  occurrenceIndex: number;
  dedupHash: string;
  isDuplicate: boolean;
  duplicateTransactionId: number | null;
  predictedCategoryId: number | null;
  predictedCategoryName: string | null;
  predictedSource: 'rule' | 'bayes' | 'none';
  isTransfer: boolean;
}

export interface PreviewResult {
  stagingId: string;
  filename: string;
  accountId: number;
  profileId: number | null;
  encoding: DetectedEncoding;
  mapping: ImportMapping;
  rows: PreviewRow[];
  errors: RowError[];
  totalRows: number;
  duplicateCount: number;
  errorCount: number;
  skipped: number;
  truncated: boolean;
}

export function buildPreview(input: {
  stagingId: string;
  filename: string;
  accountId: number;
  profileId: number | null;
  mapping: ImportMapping;
}): PreviewResult {
  const buf = readStagedFile(input.stagingId);
  const parsed = parseCsv(buf, input.mapping);
  const hashed = computeRowHashes(input.accountId, parsed.rows);
  const existing = findExistingByHashes(
    input.accountId,
    hashed.map((row) => row.dedupHash),
  );

  const ctx = buildContext();
  const categoryNames = new Map<number, string>(
    getDb().select({ id: categories.id, name: categories.name }).from(categories).all().map((row) => [row.id, row.name]),
  );

  let duplicateCount = 0;
  const rows: PreviewRow[] = [];

  for (const row of hashed) {
    const duplicateTransactionId = existing.get(row.dedupHash) ?? null;
    if (duplicateTransactionId !== null) duplicateCount += 1;

    if (rows.length < PREVIEW_ROW_LIMIT) {
      const normalizedMerchant = normalizeMerchant(row.rawDescription);
      const outcome = categorizeTransaction({ id: 0, normalizedMerchant }, ctx);
      rows.push({
        rowIndex: row.rowIndex,
        rawDate: row.rawDate,
        date: row.date,
        rawDescription: row.rawDescription,
        normalizedMerchant,
        amountCents: row.amountCents,
        occurrenceIndex: row.occurrenceIndex,
        dedupHash: row.dedupHash,
        isDuplicate: duplicateTransactionId !== null,
        duplicateTransactionId,
        predictedCategoryId: outcome.categoryId,
        predictedCategoryName: outcome.categoryId === null ? null : categoryNames.get(outcome.categoryId) ?? null,
        predictedSource: outcome.source,
        isTransfer: outcome.isTransfer,
      });
    }
  }

  return {
    stagingId: input.stagingId,
    filename: input.filename,
    accountId: input.accountId,
    profileId: input.profileId,
    encoding: parsed.encoding,
    mapping: input.mapping,
    rows,
    errors: parsed.errors,
    totalRows: hashed.length,
    duplicateCount,
    errorCount: parsed.errors.length,
    skipped: parsed.skipped,
    truncated: hashed.length > PREVIEW_ROW_LIMIT,
  };
}
