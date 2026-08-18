import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { POST as previewRoute } from '@/app/api/import/preview/route';
import { POST as commitRoute } from '@/app/api/import/commit/route';
import { POST as undoRoute } from '@/app/api/import/undo/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { createAccount } from '@/lib/accounts';
import { getBuiltinPreset, getProfileByName } from '@/lib/import/presets';
import { MAX_FILE_BYTES } from '@/lib/import/parse';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;
let token: string;
let accountId: number;
let profileId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-api-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  token = createSession(userId).token;
  accountId = createAccount({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null });
  profileId = getProfileByName('TD Chequing/Debit')!.id;
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

function uploadRequest(withAuth = true, origin = 'http://nas.local:3000') {
  const form = new FormData();
  form.append('file', new File([fixture('td-chequing.csv')], 'td-chequing.csv', { type: 'text/csv' }));
  form.append('accountId', String(accountId));
  form.append('profileId', String(profileId));
  return new Request('http://nas.local:3000/api/import/preview', {
    method: 'POST',
    headers: { ...headers(withAuth), origin },
    body: form,
  });
}

function jsonRequest(url: string, body: unknown, withAuth = true) {
  return new Request(url, {
    method: 'POST',
    headers: { ...headers(withAuth), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/import/preview', () => {
  it('stages the upload and returns the preview', async () => {
    const response = await previewRoute(uploadRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stagingId: string; totalRows: number; rows: unknown[]; encoding: string };
    expect(body.totalRows).toBe(9);
    expect(body.rows).toHaveLength(9);
    expect(body.encoding).toBe('utf-8');
    expect(fs.existsSync(path.join(tempDir, 'tmp', `${body.stagingId}.csv`))).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    expect((await previewRoute(uploadRequest(false))).status).toBe(401);
  });

  it('rejects a cross-origin request', async () => {
    expect((await previewRoute(uploadRequest(true, 'http://evil.local'))).status).toBe(403);
  });

  it('404s on an unknown account', async () => {
    const response = await previewRoute(
      jsonRequest('http://nas.local:3000/api/import/preview', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId: 9999,
        profileId,
      }),
    );
    expect(response.status).toBe(404);
  });

  it('410s when the staged file is gone', async () => {
    const response = await previewRoute(
      jsonRequest('http://nas.local:3000/api/import/preview', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId,
        profileId,
      }),
    );
    expect(response.status).toBe(410);
  });

  it('413s an oversized upload and leaves the staging directory empty (review finding 4)', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'huge.csv', { type: 'text/csv' }));
    form.append('accountId', String(accountId));
    form.append('profileId', String(profileId));
    const request = new Request('http://nas.local:3000/api/import/preview', {
      method: 'POST',
      headers: headers(),
      body: form,
    });
    const response = await previewRoute(request);
    expect(response.status).toBe(413);
    // file.size is checked before the buffer is ever staged to disk.
    const tmp = path.join(tempDir, 'tmp');
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toHaveLength(0);
  });

  it('rejects on the declared content-length alone, before formData/json is ever called (review finding 1)', async () => {
    const formDataSpy = vi.fn(async () => {
      throw new Error('formData() must not be called once content-length already exceeds the cap');
    });
    const jsonSpy = vi.fn(async () => {
      throw new Error('json() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(), 'content-length': String(MAX_FILE_BYTES + 1) }),
      formData: formDataSpy,
      json: jsonSpy,
    } as unknown as Request;

    const response = await previewRoute(fakeRequest);
    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/import/commit and /api/import/undo', () => {
  it('commits the staged import and then undoes it', async () => {
    const previewResponse = await previewRoute(uploadRequest());
    const preview = (await previewResponse.json()) as { stagingId: string };

    const commitResponse = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: preview.stagingId,
        filename: 'td-chequing.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    expect(commitResponse.status).toBe(200);
    const committed = (await commitResponse.json()) as { importId: number; rowsAdded: number; needsReview: number };
    expect(committed.rowsAdded).toBe(9);
    expect(committed.needsReview).toBe(8);

    const dialog = await undoRoute(jsonRequest('http://nas.local:3000/api/import/undo', { importId: committed.importId }));
    expect(await dialog.json()).toMatchObject({ willDelete: 9, willKeep: 0 });

    const undone = await undoRoute(jsonRequest('http://nas.local:3000/api/import/undo', { importId: committed.importId, confirm: true }));
    expect(await undone.json()).toEqual({ deleted: 9, kept: 0, loanLinksReversed: 0 });
    expect((current!.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  it('rejects a commit with a malformed mapping', async () => {
    const response = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId,
        profileId,
        mapping: { ...getBuiltinPreset('TD Chequing/Debit'), descCols: [] },
      }),
    );
    expect(response.status).toBe(400);
  });

  it('404s a commit against an unknown (foreign) account id', async () => {
    const response = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId: 999999,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    expect(response.status).toBe(404);
  });

  it('404s a commit against an unknown (foreign) profile id', async () => {
    const response = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId,
        profileId: 999999,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    expect(response.status).toBe(404);
  });

  it('commit route rejects on the declared content-length alone, before json() is ever called (review finding 1)', async () => {
    const jsonSpy = vi.fn(async () => {
      throw new Error('json() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(), 'content-length': String(MAX_FILE_BYTES + 1) }),
      json: jsonSpy,
    } as unknown as Request;

    const response = await commitRoute(fakeRequest);
    expect(response.status).toBe(413);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('404s an undo of an unknown importId instead of silently no-opping (review finding 6)', async () => {
    const dialog = await undoRoute(jsonRequest('http://nas.local:3000/api/import/undo', { importId: 999999 }));
    expect(dialog.status).toBe(404);

    const confirmed = await undoRoute(jsonRequest('http://nas.local:3000/api/import/undo', { importId: 999999, confirm: true }));
    expect(confirmed.status).toBe(404);
  });
});
