import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../../helpers/db';
import {
  drainOcrQueue,
  enqueueOcrJob,
  isOcrJobClaimed,
  ocrQueueDepth,
  resetOcrQueueForTests,
  sweepPendingReceipts,
} from '@/lib/warranty/ocr/queue';
import {
  OCR_TIMEOUT_MS,
  OCR_UNAVAILABLE_MESSAGE,
  OcrUnavailableError,
  setOcrEngineForTests,
} from '@/lib/warranty/ocr/engine';
import * as engineModule from '@/lib/warranty/ocr/engine';
import { SCANNED_PDF_MESSAGE, ScannedPdfError } from '@/lib/warranty/ocr/pdf';
import { readSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { writeReceiptFile } from '@/lib/warranty/receipts';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const ISO = '2026-08-16T12:00:00.000Z';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-queue-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  resetOcrQueueForTests();
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeItem(): number {
  const userId = insertTestUser(current!.db, { username: 'alice' });
  return current!.db.get<{ id: number }>(
    sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
        values ('Fridge', '2026-08-16', 0, ${userId}, ${ISO}, ${ISO}) returning id`,
  ).id;
}

function makeReceipt(itemId: number, storedFilename: string, status = 'pending'): number {
  return current!.db.get<{ id: number }>(
    sql`insert into warranty_receipts
          (warranty_item_id, original_filename, stored_filename, mime, size_bytes, sha256, ocr_status, created_at)
        values (${itemId}, 'r.jpg', ${storedFilename}, 'image/jpeg', 64, ${'a'.repeat(64)}, ${status}, ${ISO})
        returning id`,
  ).id;
}

describe('staged jobs', () => {
  it('writes a done sidecar with the raw text and the suggestions', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'HOME DEPOT #7042\nTOTAL 42.00' }) });
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(enqueueOcrJob({ kind: 'staged', stagingId })).toBe(true);
    await drainOcrQueue();
    const sidecar = readSidecar(stagingId);
    expect(sidecar?.status).toBe('done');
    expect(sidecar?.text).toContain('HOME DEPOT');
    expect(sidecar?.suggestions?.vendor).toBe('HOME DEPOT #7042');
    expect(sidecar?.suggestions?.priceCents).toBe(4200);
  });

  it('writes a failed sidecar when the engine is unavailable', async () => {
    setOcrEngineForTests({
      recognize: async () => {
        throw new OcrUnavailableError();
      },
    });
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    enqueueOcrJob({ kind: 'staged', stagingId });
    await drainOcrQueue();
    expect(readSidecar(stagingId)).toEqual({ status: 'failed', error: OCR_UNAVAILABLE_MESSAGE });
  });

  it('writes a failed sidecar carrying the scanned-PDF message', async () => {
    setOcrEngineForTests({
      recognize: async () => {
        throw new ScannedPdfError();
      },
    });
    const stagingId = writeStagedReceipt(Buffer.from('%PDF-1.7\n'), 'application/pdf');
    enqueueOcrJob({ kind: 'staged', stagingId });
    await drainOcrQueue();
    expect(readSidecar(stagingId)?.error).toBe(SCANNED_PDF_MESSAGE);
  });

  it('drains quietly when the staged file has already been purged', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'unused' }) });
    enqueueOcrJob({ kind: 'staged', stagingId: '11111111-2222-3333-4444-555555555555' });
    await drainOcrQueue();
    expect(ocrQueueDepth()).toBe(0);
  });
});

describe('receipt jobs', () => {
  it('stores the text, flips the row to done, and makes the item searchable', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'RONA SPATULA 4412' }) });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));

    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();

    const row = current!.db.get<{ ocr_status: string; ocr_text: string | null; ocr_error: string | null }>(
      sql`select ocr_status, ocr_text, ocr_error from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('done');
    expect(row.ocr_text).toBe('RONA SPATULA 4412');
    expect(row.ocr_error).toBeNull();

    const hit = current!.db.get<{ id: number }>(
      sql`select rowid as id from warranty_search where warranty_search match ${'"spatula"'}`,
    );
    expect(hit.id).toBe(itemId);
  });

  it('records failed plus the error text when the engine throws', async () => {
    setOcrEngineForTests({
      recognize: async () => {
        throw new Error('boom');
      },
    });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    const row = current!.db.get<{ ocr_status: string; ocr_error: string | null }>(
      sql`select ocr_status, ocr_error from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('failed');
    expect(row.ocr_error).toBe('boom');
  });

  it('truncates at MAX_OCR_TEXT_CHARS, notes it in ocr_error, and stays done', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'x'.repeat(120_000) }) });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    const row = current!.db.get<{ ocr_status: string; ocr_text: string; ocr_error: string | null }>(
      sql`select ocr_status, ocr_text, ocr_error from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('done');
    expect(row.ocr_text.length).toBeLessThan(120_000);
    expect(row.ocr_error).toContain('truncated');
  });

  it('fails the job when the file is missing from disk', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'unused' }) });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, '11111111-2222-3333-4444-555555555555.jpg');
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    const row = current!.db.get<{ ocr_status: string }>(
      sql`select ocr_status from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('failed');
  });
});

describe('claiming and FIFO order (MUST-7.10)', () => {
  it('refuses a second enqueue of a claimed job and runs jobs in order', async () => {
    const order: string[] = [];
    setOcrEngineForTests({
      recognize: async (filePath) => {
        order.push(path.basename(filePath));
        return { text: 'ok' };
      },
    });
    const a = writeStagedReceipt(JPEG, 'image/jpeg');
    const b = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(enqueueOcrJob({ kind: 'staged', stagingId: a })).toBe(true);
    expect(enqueueOcrJob({ kind: 'staged', stagingId: a })).toBe(false);
    expect(isOcrJobClaimed({ kind: 'staged', stagingId: a })).toBe(true);
    expect(enqueueOcrJob({ kind: 'staged', stagingId: b })).toBe(true);
    await drainOcrQueue();
    expect(order).toEqual([`${a}.jpg`, `${b}.jpg`]);
    expect(isOcrJobClaimed({ kind: 'staged', stagingId: a })).toBe(false);
  });
});

describe('sweepPendingReceipts (MUST-7.12)', () => {
  it('enqueues every pending row that is not already claimed', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'swept text' }) });
    const itemId = makeItem();
    const pendingA = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    const pendingB = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'), 'done');

    expect(sweepPendingReceipts()).toBe(2);
    await drainOcrQueue();

    for (const id of [pendingA, pendingB]) {
      const row = current!.db.get<{ ocr_status: string }>(
        sql`select ocr_status from warranty_receipts where id = ${id}`,
      );
      expect(row.ocr_status).toBe('done');
    }
  });

  it('is idempotent — a second sweep while a job is claimed enqueues nothing', () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'x' }) });
    const itemId = makeItem();
    makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    expect(sweepPendingReceipts()).toBe(1);
    expect(sweepPendingReceipts()).toBe(0);
  });
});

describe('queue depth (Ruling P6 — real assertions, not a vacuous +1)', () => {
  it('increments while a job is claimed for processing and decrements back to zero once drained', async () => {
    let releaseFirst!: (value: { text: string }) => void;
    const first = new Promise<{ text: string }>((resolve) => {
      releaseFirst = resolve;
    });
    setOcrEngineForTests({ recognize: () => first });

    const a = writeStagedReceipt(JPEG, 'image/jpeg');
    const b = writeStagedReceipt(JPEG, 'image/jpeg');

    expect(ocrQueueDepth()).toBe(0);
    enqueueOcrJob({ kind: 'staged', stagingId: a });
    // `a` was shifted off immediately by the pump and is now in-flight (awaiting `first`);
    // the queue array itself is still empty at this instant.
    expect(ocrQueueDepth()).toBe(0);
    enqueueOcrJob({ kind: 'staged', stagingId: b });
    // `b` cannot start until `a` finishes, so it is sitting in the queue right now.
    expect(ocrQueueDepth()).toBe(1);

    releaseFirst({ text: 'ok' });
    await drainOcrQueue();
    expect(ocrQueueDepth()).toBe(0);
    expect(readSidecar(a)?.status).toBe('done');
    expect(readSidecar(b)?.status).toBe('done');
  });
});

describe('queue never strands a job (IMPORTANT 3 fix report — Ruling P15 revisited)', () => {
  // See the comment on runQueue() in src/lib/warranty/ocr/queue.ts for the full reasoning.
  // The original P15 fix added a dead `if (queue.length > 0) continue;` branch: there is no
  // await between `queue.shift()` returning undefined and `pump = null`, so no enqueue can
  // land in that gap — the branch could never run and was removed. The invariant that
  // actually prevents stranding has exactly two paths, both covered directly below.

  it('path 1 — a job enqueued while another job is still in flight is picked up by the same drain, not dropped', async () => {
    let releaseFirst!: (value: { text: string }) => void;
    const first = new Promise<{ text: string }>((resolve) => {
      releaseFirst = resolve;
    });
    setOcrEngineForTests({ recognize: () => first });

    const a = writeStagedReceipt(JPEG, 'image/jpeg');
    enqueueOcrJob({ kind: 'staged', stagingId: a });

    // `a` is now the sole in-flight job (queue array empty, pump draining, pump !== null).
    // enqueueOcrJob for `b` must therefore take the "trust the existing pump" branch rather
    // than starting a second one.
    const b = writeStagedReceipt(JPEG, 'image/jpeg');
    setOcrEngineForTests({
      recognize: async () => ({ text: 'b-result' }),
    });
    expect(enqueueOcrJob({ kind: 'staged', stagingId: b })).toBe(true);

    releaseFirst({ text: 'a-result' });
    await drainOcrQueue();

    expect(readSidecar(a)?.status).toBe('done');
    expect(readSidecar(b)?.status).toBe('done');
    expect(readSidecar(b)?.text).toBe('b-result');
    expect(ocrQueueDepth()).toBe(0);
  });

  it('path 2 — an enqueue landing immediately after the queue has drained to idle starts a fresh pump', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'a-result' }) });
    const a = writeStagedReceipt(JPEG, 'image/jpeg');
    enqueueOcrJob({ kind: 'staged', stagingId: a });
    await drainOcrQueue();
    // The queue is now fully idle: pump === null, queue empty. This is the OTHER half of
    // the invariant — enqueueOcrJob's `pump === null` branch must itself start processing,
    // with no unrelated external "kick" required.
    expect(ocrQueueDepth()).toBe(0);

    setOcrEngineForTests({ recognize: async () => ({ text: 'b-result' }) });
    const b = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(enqueueOcrJob({ kind: 'staged', stagingId: b })).toBe(true);
    await drainOcrQueue();

    expect(readSidecar(b)?.status).toBe('done');
    expect(readSidecar(b)?.text).toBe('b-result');
  });
});

describe('Ruling P5 — timeout terminates and recreates the worker (MUST-7.11)', () => {
  it('terminates the cached worker when a job blows past OCR_TIMEOUT_MS, and still drains the queue', async () => {
    vi.useFakeTimers();
    const terminateSpy = vi.spyOn(engineModule, 'terminateOcrWorker').mockResolvedValue(undefined);

    // The hung job never resolves on its own — only a timeout can end it.
    setOcrEngineForTests({ recognize: () => new Promise(() => {}) });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    enqueueOcrJob({ kind: 'receipt', receiptId });

    const drainPromise = drainOcrQueue();
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS + 1000);
    await drainPromise;

    expect(terminateSpy).toHaveBeenCalled();
    const row = current!.db.get<{ ocr_status: string; ocr_error: string | null }>(
      sql`select ocr_status, ocr_error from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('failed');
    expect(row.ocr_error).toBe('OCR timed out.');
  });
});
