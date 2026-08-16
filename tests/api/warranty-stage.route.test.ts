import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { POST } from '@/app/api/warranties/receipts/stage/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { MAX_FILES_PER_UPLOAD, MAX_RECEIPT_BYTES, receiptTempDir } from '@/lib/warranty/receipts';
import { UNSUPPORTED_TYPE_MESSAGE } from '@/lib/warranty/sniff';
import { isOcrJobClaimed, resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let token: string;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-stage-route-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  token = createSession(insertTestUser(current.db, { username: 'alice' })).token;
  resetOcrQueueForTests();
  // A slow fake engine keeps jobs on the queue long enough to assert they were enqueued.
  setOcrEngineForTests({ recognize: () => new Promise(() => {}) });
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function upload(
  files: { name: string; bytes: Buffer; type?: string }[],
  opts: { token?: string | null; origin?: string | null; contentLength?: string } = {},
): Request {
  const form = new FormData();
  for (const file of files) {
    form.append('file', new File([new Uint8Array(file.bytes)], file.name, { type: file.type ?? 'application/octet-stream' }));
  }
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  const origin = opts.origin === undefined ? 'http://nas.local:3000' : opts.origin;
  if (origin !== null) headers.origin = origin;
  const sessionToken = opts.token === undefined ? token : opts.token;
  if (sessionToken) headers.cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  if (opts.contentLength) headers['content-length'] = opts.contentLength;
  return new Request('http://nas.local:3000/api/warranties/receipts/stage', { method: 'POST', headers, body: form });
}

describe('POST /api/warranties/receipts/stage', () => {
  it('stages a valid JPEG, returns its metadata, and enqueues an OCR job', async () => {
    const response = await POST(upload([{ name: 'receipt.jpg', bytes: JPEG, type: 'image/jpeg' }]));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      staged: { stagingId: string; originalFilename: string; mime: string; sizeBytes: number; sha256: string }[];
    };
    expect(body.staged).toHaveLength(1);
    expect(body.staged[0].mime).toBe('image/jpeg');
    expect(body.staged[0].originalFilename).toBe('receipt.jpg');
    expect(body.staged[0].sizeBytes).toBe(JPEG.length);
    expect(body.staged[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(receiptTempDir(), `${body.staged[0].stagingId}.jpg`))).toBe(true);
    // IMPORTANT 1 (review): `ocrQueueDepth() + 1 > 0` was a tautology — non-negative + 1 is
    // always > 0, so it stayed green even with enqueueOcrJob() deleted from the route.
    // isOcrJobClaimed() actually proves the route wired the staged file into the OCR queue:
    // the fake engine above never resolves, so the job the route enqueued is still claimed.
    expect(isOcrJobClaimed({ kind: 'staged', stagingId: body.staged[0].stagingId })).toBe(true);
  });

  it('accepts a part that is exactly MAX_RECEIPT_BYTES', async () => {
    const exact = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_RECEIPT_BYTES - 3)]);
    expect(exact.length).toBe(MAX_RECEIPT_BYTES);
    const response = await POST(upload([{ name: 'exact.jpg', bytes: exact, type: 'image/jpeg' }]));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { staged: { sizeBytes: number }[] };
    expect(body.staged[0].sizeBytes).toBe(MAX_RECEIPT_BYTES);
  });

  it('stages several parts in one request', async () => {
    const response = await POST(
      upload([
        { name: 'a.jpg', bytes: JPEG, type: 'image/jpeg' },
        { name: 'b.pdf', bytes: PDF, type: 'application/pdf' },
      ]),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { staged: { mime: string }[] };
    expect(body.staged.map((s) => s.mime)).toEqual(['image/jpeg', 'application/pdf']);
  });

  it('403s a mismatched Origin (MUST-6.3: the STRICT check, first)', async () => {
    const response = await POST(upload([{ name: 'a.jpg', bytes: JPEG }], { origin: 'http://evil.example' }));
    expect(response.status).toBe(403);
  });

  it('403s a headerless POST — the relaxed rule applies only to the read-only GETs', async () => {
    const response = await POST(upload([{ name: 'a.jpg', bytes: JPEG }], { origin: null }));
    expect(response.status).toBe(403);
  });

  it('401s without a session', async () => {
    const response = await POST(upload([{ name: 'a.jpg', bytes: JPEG }], { token: null }));
    expect(response.status).toBe(401);
  });

  it('413s an oversized declared Content-Length before buffering the body', async () => {
    const response = await POST(
      upload([{ name: 'a.jpg', bytes: JPEG }], { contentLength: String(10 * 1024 * 1024 * 5 + 1) }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('file_too_large');
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('413s a single oversized part inside an acceptable total, staging NOTHING', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const response = await POST(
      upload([
        { name: 'small.jpg', bytes: JPEG, type: 'image/jpeg' },
        { name: 'big.jpg', bytes: big, type: 'image/jpeg' },
      ]),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('file_too_large');
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('rejects six parts whole', async () => {
    const files = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i) => ({
      name: `r${i}.jpg`,
      bytes: JPEG,
      type: 'image/jpeg',
    }));
    const response = await POST(upload(files));
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('too_many_files');
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('400s a .jpg-named text file whatever Content-Type the client declared', async () => {
    const response = await POST(
      upload([{ name: 'receipt.jpg', bytes: Buffer.from('date,amount\n'), type: 'image/jpeg' }]),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe(UNSUPPORTED_TYPE_MESSAGE);
    expect(body.code).toBe('unsupported_type');
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('400s a HEIC drag-and-drop with the Preview-export advice', async () => {
    const heic = Buffer.alloc(64);
    heic.write('ftypheic', 4, 'ascii');
    const response = await POST(upload([{ name: 'IMG_0001.HEIC', bytes: heic, type: 'image/heic' }]));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Preview');
  });

  it('400s a zero-byte part and a request with no file part at all', async () => {
    expect((await POST(upload([{ name: 'empty.jpg', bytes: Buffer.alloc(0) }]))).status).toBe(400);
    expect((await POST(upload([]))).status).toBe(400);
  });

  it('MINOR 3: stages a blank-named part under a generated name instead of leaking a raw zod message', async () => {
    const response = await POST(upload([{ name: '   ', bytes: JPEG, type: 'image/jpeg' }]));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { staged: { originalFilename: string; mime: string }[] };
    expect(body.staged[0].originalFilename).toBe('receipt.jpg');
  });
});
