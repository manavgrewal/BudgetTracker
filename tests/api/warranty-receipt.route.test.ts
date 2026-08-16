import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/warranties/receipts/[id]/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { createWarrantyItem, listWarrantyReceipts, type WarrantyInput } from '@/lib/warranty/items';
import { resolveReceiptPath } from '@/lib/warranty/receipts';
import { writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let token: string;
let ownerId: number;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-receipt-route-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  ownerId = insertTestUser(current.db, { username: 'alice' });
  token = createSession(ownerId).token;
  resetOcrQueueForTests();
  setOcrEngineForTests({ recognize: async () => ({ text: 'x' }) });
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

function baseInput(): WarrantyInput {
  return {
    name: 'Fridge', vendor: null, model: null, serial: null,
    purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false,
    priceCents: null, ownerUserId: ownerId, transactionId: null, typeId: null, notes: null,
  };
}

function attach(bytes: Buffer, mime: 'image/jpeg' | 'application/pdf', originalFilename: string) {
  const stagingId = writeStagedReceipt(bytes, mime);
  writeSidecar(stagingId, { status: 'done', text: 'text' });
  const itemId = createWarrantyItem(baseInput(), [{ stagingId, originalFilename }]);
  return listWarrantyReceipts(itemId)[0];
}

function fetchReceipt(id: string | number, opts: { token?: string | null; origin?: string | null } = {}) {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  const origin = opts.origin === undefined ? 'http://nas.local:3000' : opts.origin;
  if (origin !== null) headers.origin = origin;
  const sessionToken = opts.token === undefined ? token : opts.token;
  if (sessionToken) headers.cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  const request = new Request(`http://nas.local:3000/api/warranties/receipts/${id}`, { headers });
  return GET(request, { params: Promise.resolve({ id: String(id) }) });
}

describe('GET /api/warranties/receipts/[id]', () => {
  it('streams an image inline with the STORED mime and no-store caching', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'till receipt.jpg');
    const response = await fetchReceipt(receipt.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-length')).toBe(String(JPEG.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(JPEG)).toBe(true);
  });

  it('serves a PDF as an attachment with a sanitised filename (MUST-5.3)', async () => {
    const receipt = attach(PDF, 'application/pdf', 'facture "été" /../weird.pdf');
    const response = await fetchReceipt(receipt.id);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    const disposition = response.headers.get('content-disposition')!;
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    expect(disposition).not.toContain('/');
    expect(disposition).not.toContain('..');
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
  });

  it('takes Content-Type from the stored mime even when the bytes are something else', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    fs.writeFileSync(resolveReceiptPath(receipt.storedFilename), Buffer.from('%PDF-1.7 not really'));
    const response = await fetchReceipt(receipt.id);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('401s without a session', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    expect((await fetchReceipt(receipt.id, { token: null })).status).toBe(401);
  });

  it('403s a mismatched Origin', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    expect((await fetchReceipt(receipt.id, { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('200s a request carrying neither Origin nor Sec-Fetch-Site (the plain-HTTP LAN case)', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    expect((await fetchReceipt(receipt.id, { origin: null })).status).toBe(200);
  });

  it('400s a non-integer id and 404s an unknown one', async () => {
    expect((await fetchReceipt('abc')).status).toBe(400);
    expect((await fetchReceipt('-1')).status).toBe(400);
    expect((await fetchReceipt('0')).status).toBe(400);
    expect((await fetchReceipt(99999)).status).toBe(404);
  });

  it('410s when the row exists but the file does not (MUST-5.6)', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    fs.rmSync(resolveReceiptPath(receipt.storedFilename), { force: true });
    const response = await fetchReceipt(receipt.id);
    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('Receipt file is missing from this install.');
  });
});
