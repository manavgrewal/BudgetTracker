import { desc, inArray } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { warrantyReceipts } from '@/db/schema';

/**
 * Defect fix (v1.5.0): Settings -> About needs an honest answer to "is OCR actually working
 * on this install", not just "which engine is configured". A run-time ONNX throw (a model
 * mismatch, a `sharp` failure, a shape-guard rejection) fails every receipt permanently
 * without ever touching the settings-table probe verdict or crashing the process — so neither
 * `ocr.engine` nor the crash guard in onnx/probe.ts sees it. The one place this IS visible is
 * warranty_receipts.ocr_status itself: every receipt since the break reads 'failed'.
 *
 * How many of the most-recently-PROCESSED receipts must all be 'failed' before that reads as
 * "the engine itself is broken" rather than "a few bad photos". Fewer than this many is not
 * enough evidence either way — a fresh install with zero or one receipt is not "systemically
 * failing", it simply has no history yet, which is why isOcrFailingSystemically() returns
 * false for both cases rather than treating "not enough data" as a pass.
 */
export const OCR_SYSTEMIC_FAILURE_STREAK = 3;

/**
 * True only when at least OCR_SYSTEMIC_FAILURE_STREAK receipts have reached a terminal OCR
 * state (done or failed — 'pending' carries no verdict yet and is excluded rather than
 * counted either way) and every one of the most recent of those failed. One bad receipt among
 * otherwise-successful ones reads as a bad receipt, not a systemic failure.
 */
export function isOcrFailingSystemically(): boolean {
  const rows = getDb()
    .select({ ocrStatus: warrantyReceipts.ocrStatus })
    .from(warrantyReceipts)
    .where(inArray(warrantyReceipts.ocrStatus, ['done', 'failed']))
    .orderBy(desc(warrantyReceipts.id))
    .limit(OCR_SYSTEMIC_FAILURE_STREAK)
    .all();
  if (rows.length < OCR_SYSTEMIC_FAILURE_STREAK) return false;
  return rows.every((row) => row.ocrStatus === 'failed');
}
