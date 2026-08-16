import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/backup/download/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { tempDir } from '@/lib/backup';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-backup-api-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function request(token: string | null, origin = 'http://nas.local:3000', host = 'nas.local:3000') {
  const headers: Record<string, string> = {};
  if (host) headers.host = host;
  if (origin) headers.origin = origin;
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new Request('http://nas.local:3000/api/backup/download', { headers });
}

describe('GET /api/backup/download', () => {
  it('streams a SQLite copy to an admin and unlinks the temp file', async () => {
    const admin = insertTestUser(current!.db, { username: 'admin', role: 'admin' });
    const response = await GET(request(createSession(admin).token));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/gzip');
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="budget-');
    expect(response.headers.get('content-disposition')).toContain('.tar.gz"');

    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 2).toJSON().data).toEqual([0x1f, 0x8b]);

    const leftovers = fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()) : [];
    expect(leftovers).toEqual([]);
  });

  it('403s a non-admin member', async () => {
    const member = insertTestUser(current!.db, { username: 'bob', role: 'member' });
    expect((await GET(request(createSession(member).token))).status).toBe(403);
  });

  it('401s without a session', async () => {
    expect((await GET(request(null))).status).toBe(401);
  });

  it('403s a cross-origin request even with a valid session cookie', async () => {
    // A GET is normally exempt from CSRF checks, but this route returns the
    // whole database, so a PRESENT and mismatched Origin must be refused here.
    const admin = insertTestUser(current!.db, { username: 'admin2', role: 'admin' });
    const { token } = createSession(admin);
    const response = await GET(request(token, 'http://evil.local'));
    expect(response.status).toBe(403);
    const leftovers = fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()) : [];
    expect(leftovers).toEqual([]);
  });

  it('serves a header-less request — the plain-HTTP LAN default deployment', async () => {
    // Controller ruling: the download link on a plain-HTTP install sends
    // neither Origin (same-origin navigation) nor Sec-Fetch-* (omitted on
    // non-trustworthy origins). Rejecting that broke the backup download on
    // the documented default deployment and bought nothing, since a cross-site
    // click is indistinguishable there. Auth is still enforced.
    const admin = insertTestUser(current!.db, { username: 'admin4', role: 'admin' });
    const response = await GET(request(createSession(admin).token, ''));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toJSON().data).toEqual([0x1f, 0x8b]);
  });

  it('still 401s/403s a header-less request without an admin session', async () => {
    const member = insertTestUser(current!.db, { username: 'bob2', role: 'member' });
    expect((await GET(request(null, ''))).status).toBe(401);
    expect((await GET(request(createSession(member).token, ''))).status).toBe(403);
  });

  it('403s a header-less request that nevertheless declares a cross-site fetch', async () => {
    const admin = insertTestUser(current!.db, { username: 'admin5', role: 'admin' });
    const response = await GET(
      new Request('http://nas.local:3000/api/backup/download', {
        headers: { host: 'nas.local:3000', 'sec-fetch-site': 'cross-site', cookie: `${SESSION_COOKIE_NAME}=${createSession(admin).token}` },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('unlinks the temp file even when opening the stream fails', async () => {
    const admin = insertTestUser(current!.db, { username: 'admin3', role: 'admin' });
    const { token } = createSession(admin);
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(() => {
      throw new Error('disk read failed');
    });

    const response = await GET(request(token));
    expect(response.status).toBe(500);
    spy.mockRestore();

    const leftovers = fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()) : [];
    expect(leftovers).toEqual([]);
  });
});
