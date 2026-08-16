import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/warranties/receipts/stage/[stagingId]/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let token: string;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-poll-route-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  token = createSession(insertTestUser(current.db, { username: 'alice' })).token;
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function poll(stagingId: string, opts: { token?: string | null; origin?: string | null } = {}) {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  const origin = opts.origin === undefined ? 'http://nas.local:3000' : opts.origin;
  if (origin !== null) headers.origin = origin;
  const sessionToken = opts.token === undefined ? token : opts.token;
  if (sessionToken) headers.cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  const request = new Request(`http://nas.local:3000/api/warranties/receipts/stage/${stagingId}`, { headers });
  return GET(request, { params: Promise.resolve({ stagingId }) });
}

describe('GET /api/warranties/receipts/stage/[stagingId]', () => {
  it('reports pending while the sidecar is absent', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const response = await poll(stagingId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  it('returns the suggestions on done, and never the raw OCR text', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, {
      status: 'done',
      text: 'RAW OCR TEXT THE CLIENT MUST NOT RECEIVE',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200, purchaseDate: '2026-08-16' },
    });
    const body = await (await poll(stagingId)).json();
    expect(body).toEqual({
      status: 'done',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200, purchaseDate: '2026-08-16' },
    });
    expect(JSON.stringify(body)).not.toContain('RAW OCR TEXT');
  });

  it('returns the error text on failed', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    expect(await (await poll(stagingId)).json()).toEqual({ status: 'failed', error: 'OCR timed out.' });
  });

  it('400s a staging id that is not a UUID, before any path is built', async () => {
    const response = await poll('../../budget.db');
    expect(response.status).toBe(400);
  });

  it('401s without a session and 403s a mismatched Origin', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect((await poll(stagingId, { token: null })).status).toBe(401);
    expect((await poll(stagingId, { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('allows a headerless request (plain HTTP on the LAN)', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect((await poll(stagingId, { origin: null })).status).toBe(200);
  });
});
