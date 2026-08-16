import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { POST as rawPreviewRoute } from '@/app/api/import/raw-preview/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { MAX_FILE_BYTES } from '@/lib/import/parse';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;
let token: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-rawpreview-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  token = createSession(userId).token;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function headers(withAuth = true): Record<string, string> {
  return {
    origin: 'http://nas.local:3000',
    host: 'nas.local:3000',
    ...(withAuth ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
  };
}

function uploadRequest(file: File, withAuth = true) {
  const form = new FormData();
  form.append('file', file);
  return new Request('http://nas.local:3000/api/import/raw-preview', {
    method: 'POST',
    headers: headers(withAuth),
    body: form,
  });
}

describe('POST /api/import/raw-preview', () => {
  it('stages the sample file and returns the first raw rows with column indexes implied by array position', async () => {
    const response = await rawPreviewRoute(uploadRequest(new File([fixture('scotia.csv')], 'scotia.csv', { type: 'text/csv' })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stagingId: string; rows: string[][]; encoding: string };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.length).toBeLessThanOrEqual(10);
    expect(fs.existsSync(path.join(tempDir, 'tmp', `${body.stagingId}.csv`))).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await rawPreviewRoute(uploadRequest(new File(['a,b,c'], 'x.csv'), false));
    expect(response.status).toBe(401);
  });

  it('rejects a request with no file', async () => {
    const form = new FormData();
    const request = new Request('http://nas.local:3000/api/import/raw-preview', { method: 'POST', headers: headers(), body: form });
    expect((await rawPreviewRoute(request)).status).toBe(400);
  });

  it('413s an oversized file instead of staging it', async () => {
    const oversized = new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'huge.csv', { type: 'text/csv' });
    const response = await rawPreviewRoute(uploadRequest(oversized));
    expect(response.status).toBe(413);
    // Nothing should have been written to the staging directory.
    const tmp = path.join(tempDir, 'tmp');
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toHaveLength(0);
  });

  it('rejects on the declared content-length alone, before formData is ever called (review finding 1)', async () => {
    const formDataSpy = vi.fn(async () => {
      throw new Error('formData() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(), 'content-length': String(MAX_FILE_BYTES + 1) }),
      formData: formDataSpy,
    } as unknown as Request;

    const response = await rawPreviewRoute(fakeRequest);
    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});
