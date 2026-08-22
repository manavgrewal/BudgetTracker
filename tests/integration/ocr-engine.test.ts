import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import { setSetting } from '@/lib/settings';
import { OCR_TIMEOUT_MESSAGE, OCR_TIMEOUT_MS, releaseOcrEngine } from '@/lib/warranty/ocr/engine';
import * as engineModule from '@/lib/warranty/ocr/engine';
import { detResize } from '@/lib/warranty/ocr/onnx/detect';
import { preprocessReceipt } from '@/lib/warranty/ocr/onnx/preprocess';
import {
  SETTING_OCR_ENGINE,
  SETTING_OCR_ENGINE_PROBED_VERSION,
  probeCacheKey,
  resetOcrProbeForTests,
} from '@/lib/warranty/ocr/onnx/probe';
import { setOnnxSessionsForTests, type OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';
import { drainOcrQueue, enqueueOcrJob, resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { resetReceiptForReOcr } from '@/lib/warranty/items';
import { receiptsDir } from '@/lib/warranty/receipts';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { solidRgb } from '../helpers/ocr-images';

const DICT = ['', 'S', 'P', 'A', 'T', 'U', 'L', ' '];
const WIDTH = 1400;
const HEIGHT = 900;

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let storedFilename: string;

/**
 * The detection tensor's shape must come from detResize(PREPROCESSED dims). preprocessReceipt
 * resizes and may deskew, so those differ from the stored file's nominal size, and
 * detectBoxes throws on a spatial-dimension mismatch. Deriving them from WIDTH and HEIGHT
 * would fail every case in this file for a reason unrelated to what it is testing.
 */
async function fakeSessions(over: Partial<OnnxOcrSessions> = {}): Promise<OnnxOcrSessions> {
  const pre = await preprocessReceipt(path.join(receiptsDir(), storedFilename));
  const geometry = detResize(pre.width, pre.height);
  return {
    runDet: async () => {
      const map = new Float32Array(geometry.resizeW * geometry.resizeH);
      for (let y = 10; y < 34; y += 1) for (let x = 10; x < 140; x += 1) map[y * geometry.resizeW + x] = 0.95;
      return { data: map, dims: [1, 1, geometry.resizeH, geometry.resizeW] };
    },
    runCls: async (input) => {
      const batch = input.dims[0];
      const data = new Float32Array(batch * 2);
      for (let n = 0; n < batch; n += 1) data[n * 2] = 0.99;
      return { data, dims: [batch, 2] };
    },
    runRec: async (input) => {
      const batch = input.dims[0];
      const steps = [1, 2, 3, 4, 5, 6, 3];
      const data = new Float32Array(batch * steps.length * DICT.length);
      for (let n = 0; n < batch; n += 1) {
        steps.forEach((cls, t) => {
          data[(n * steps.length + t) * DICT.length + cls] = 0.95;
        });
      }
      return { data, dims: [batch, steps.length, DICT.length] };
    },
    clsInputHeight: 80,
    clsInputWidth: 160,
    recClassCount: DICT.length,
    dictionary: DICT,
    ...over,
  };
}

function makeReceipt(): number {
  const db = (current as TestDb).db;
  const userId = insertTestUser(db);
  const itemId = Number(
    (
      db.get(sql`
        insert into warranty_items (name, purchase_date, owner_user_id, created_at, updated_at)
        values ('Kitchen kit', '2026-08-18', ${userId}, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')
        returning id
      `) as { id: number }
    ).id,
  );
  return Number(
    (
      db.get(sql`
        insert into warranty_receipts
          (warranty_item_id, stored_filename, original_filename, mime, size_bytes, sha256, ocr_status, created_at)
        values (${itemId}, ${storedFilename}, 'receipt.png', 'image/png', 1, ${'a'.repeat(64)}, 'pending', '2026-08-18T00:00:00.000Z')
        returning id
      `) as { id: number }
    ).id,
  );
}

function statusOf(receiptId: number): { ocr_status: string; ocr_text: string | null; ocr_error: string | null } {
  return (current as TestDb).db.get(
    sql`select ocr_status, ocr_text, ocr_error from warranty_receipts where id = ${receiptId}`,
  ) as { ocr_status: string; ocr_text: string | null; ocr_error: string | null };
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-int-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  resetOcrQueueForTests();
  resetOcrProbeForTests();
  setSetting(SETTING_OCR_ENGINE, 'onnx');
  setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, probeCacheKey());
  fs.mkdirSync(receiptsDir(), { recursive: true });
  storedFilename = '00000000-0000-4000-8000-000000000001.png';
  fs.writeFileSync(
    path.join(receiptsDir(), storedFilename),
    await sharp(solidRgb(WIDTH, HEIGHT, [250, 250, 250]), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
      .png()
      .toBuffer(),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setOnnxSessionsForTests(null);
  await releaseOcrEngine();
  resetOcrQueueForTests();
  resetOcrProbeForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('MUST-13.4: the whole engine path against a fake session set', () => {
  it('drains a pending receipt to done and indexes its text', async () => {
    setOnnxSessionsForTests(await fakeSessions());
    const receiptId = makeReceipt();
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    const row = statusOf(receiptId);
    expect(row.ocr_status).toBe('done');
    expect(row.ocr_text).toContain('SPATULA');
    const hit = (current as TestDb).db.get(
      sql`select rowid as id from warranty_search where warranty_search match ${'"spatula"'}`,
    );
    expect(hit).toBeTruthy();
  });

  it('MUST-9.2: the unmodified re-run resets and re-reads on the same engine', async () => {
    setOnnxSessionsForTests(await fakeSessions());
    const receiptId = makeReceipt();
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    resetReceiptForReOcr(receiptId);
    expect(statusOf(receiptId).ocr_status).toBe('pending');
    await drainOcrQueue();
    expect(statusOf(receiptId).ocr_status).toBe('done');
  });

  it('records a throwing session as failed with its message and leaves the index consistent', async () => {
    setOnnxSessionsForTests(
      await fakeSessions({
        runRec: async () => {
          throw new Error('rec kernel exploded');
        },
      }),
    );
    const receiptId = makeReceipt();
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    const row = statusOf(receiptId);
    expect(row.ocr_status).toBe('failed');
    expect(row.ocr_error).toBe('rec kernel exploded');
    expect(row.ocr_text).toBeNull();
  });

  it('MUST-4.40: a session that never settles fails with the timeout message and releases the engine once', async () => {
    // Same timer handling as tests/lib/warranty/ocr/queue.test.ts's "Ruling P5" suite:
    // install fake timers, start the drain, advance past OCR_TIMEOUT_MS, then await the
    // drain. Do not await the drain before advancing; it never settles on its own, which is
    // the whole point of the fixture.
    vi.useFakeTimers();
    const releaseSpy = vi.spyOn(engineModule, 'releaseOcrEngine');
    setOnnxSessionsForTests(await fakeSessions({ runDet: () => new Promise(() => {}) }));
    const receiptId = makeReceipt();
    enqueueOcrJob({ kind: 'receipt', receiptId });

    const drainPromise = drainOcrQueue();
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS + 1000);
    await drainPromise;

    const row = statusOf(receiptId);
    expect(row.ocr_status).toBe('failed');
    expect(row.ocr_error).toBe(OCR_TIMEOUT_MESSAGE);
    // A race abandons the caller's await but does not cancel the call, so a wedged engine
    // must be explicitly discarded or every future job queues behind it.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
