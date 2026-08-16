import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { receiptTempDir } from '@/lib/warranty/receipts';
import { RECEIPT_EXTS, extForMime, mimeForExt, type ReceiptMime } from '@/lib/warranty/sniff';
import type { SuggestedFields } from '@/lib/warranty/suggest';

/**
 * Staged receipt uploads (spec §6.3). Suggestions must pre-fill the NEW-ITEM form, which
 * means OCR has to run before any warranty_items row exists. Staged files live in the
 * existing ${DATA_DIR}/tmp and are therefore already covered by purgeStagedFiles()'s
 * 24-hour mtime sweep — that helper iterates EVERY entry in the directory, so its purge
 * logic needs no change.
 */
export interface StagedReceipt {
  stagingId: string;
  originalFilename: string;
  mime: ReceiptMime;
  sizeBytes: number;
  sha256: string;
}

/**
 * MUST-6.7: a sidecar FILE, not an in-memory map, so a container restart mid-flow degrades
 * to "no suggestions" instead of losing a member's upload.
 */
export interface OcrSidecar {
  status: 'done' | 'failed';
  text?: string;
  error?: string;
  suggestions?: SuggestedFields;
}

/**
 * M4: mirrors the OcrSidecar interface above and is the project idiom (see
 * src/lib/import/mapping.ts) for validating a JSON blob read back off disk — a hand-cast
 * `JSON.parse(...) as OcrSidecar` would happily "believe" any structurally-wrong object
 * (e.g. a sidecar half-written by a future version of this app, or corrupted in a way that
 * still parses as valid JSON). safeParse turns that into the same "no suggestions" outcome
 * as a parse failure, rather than handing a malformed object to a caller that trusts its
 * shape.
 */
const suggestedFieldsSchema = z.object({
  purchaseDate: z.string().optional(),
  vendor: z.string().optional(),
  priceCents: z.number().optional(),
});

const ocrSidecarSchema = z.object({
  status: z.enum(['done', 'failed']),
  text: z.string().optional(),
  error: z.string().optional(),
  suggestions: suggestedFieldsSchema.optional(),
});

export const STAGING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ReceiptStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptStagingError';
  }
}

function assertStagingId(stagingId: string): void {
  // Path-traversal guard: only a UUID may ever reach path.join, exactly as
  // stagedFilePath() does in src/lib/import/staging.ts.
  if (typeof stagingId !== 'string' || !STAGING_ID_RE.test(stagingId)) {
    throw new ReceiptStagingError('Invalid staging id');
  }
}

export function writeStagedReceipt(buf: Buffer, mime: ReceiptMime): string {
  const dir = receiptTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const stagingId = randomUUID();
  fs.writeFileSync(path.join(dir, `${stagingId}.${extForMime(mime)}`), buf);
  return stagingId;
}

export function findStagedReceipt(stagingId: string): { path: string; mime: ReceiptMime } | null {
  assertStagingId(stagingId);
  const dir = receiptTempDir();
  for (const ext of RECEIPT_EXTS) {
    const candidate = path.join(dir, `${stagingId}.${ext}`);
    if (!fs.existsSync(candidate)) continue;
    const mime = mimeForExt(ext);
    if (mime === null) continue;
    return { path: candidate, mime };
  }
  return null;
}

export function sidecarPath(stagingId: string): string {
  assertStagingId(stagingId);
  return path.join(receiptTempDir(), `${stagingId}.ocr.json`);
}

export function writeSidecar(stagingId: string, payload: OcrSidecar): void {
  fs.mkdirSync(receiptTempDir(), { recursive: true });
  fs.writeFileSync(sidecarPath(stagingId), JSON.stringify(payload), 'utf8');
}

export function readSidecar(stagingId: string): OcrSidecar | null {
  const file = sidecarPath(stagingId);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A half-written or corrupt (invalid JSON) sidecar means "no suggestions", never a 500.
    return null;
  }
  // A structurally-invalid sidecar (valid JSON, wrong shape) is treated the same way.
  const result = ocrSidecarSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function deleteSidecar(stagingId: string): void {
  fs.rmSync(sidecarPath(stagingId), { force: true });
}

export function deleteStagedReceipt(stagingId: string): void {
  const found = findStagedReceipt(stagingId);
  if (found) fs.rmSync(found.path, { force: true });
}
