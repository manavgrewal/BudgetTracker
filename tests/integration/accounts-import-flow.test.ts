import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

/**
 * C1 regression test: on a fresh install nothing could create a bank account,
 * so the whole import pipeline was unreachable through the UI even though
 * src/lib/accounts.ts was fully implemented and fully unit-tested.
 *
 * This test therefore goes through the ACTION SURFACE — the server action a
 * human actually triggers — and then through the real import route, rather
 * than calling createAccount() directly the way tests/lib/accounts.test.ts
 * does. A lib-level test passes happily while no caller exists; this one does
 * not.
 */

let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };
const sameOriginHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

// Partial mock: only requireAdmin (which needs a cookie store) is faked. The
// session helpers the route handler uses stay real, so the request below is
// authenticated the same way a browser's would be.
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireAdmin: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => sameOriginHeaders,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { createAccountAction } from '@/app/(app)/settings/accounts/actions';
import { POST as previewRoute } from '@/app/api/import/preview/route';
import { listAccounts } from '@/lib/accounts';
import { getProfileByName } from '@/lib/import/presets';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;
let token: string;
let profileId: number;

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-accounts-flow-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
  const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  currentUser = { id: adminId, name: 'Admin', username: 'admin', role: 'admin' };
  token = createSession(adminId).token;
  profileId = getProfileByName('TD Chequing/Debit')!.id;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function uploadRequest(accountId: number | string) {
  const form = new FormData();
  form.append('file', new File([fixture('td-chequing.csv')], 'td-chequing.csv', { type: 'text/csv' }));
  form.append('accountId', String(accountId));
  form.append('profileId', String(profileId));
  return new Request('http://nas.local:3000/api/import/preview', {
    method: 'POST',
    headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000', cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: form,
  });
}

describe('fresh install: create an account through the UI action, then import into it', () => {
  it('starts with nothing importable — the state that made the import page a dead end', async () => {
    expect(listAccounts()).toHaveLength(0);
    // What the Import page used to send with no accounts to choose from: a
    // zod failure the family could do nothing about (I5). The page now shows
    // an empty state pointing at /settings/accounts instead of ever sending this.
    const response = await previewRoute(uploadRequest(0));
    expect(response.status).toBe(400);
  });

  it('createAccountAction -> listAccounts -> import preview accepts the new account', async () => {
    const created = await createAccountAction(
      {},
      formData({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', owner: '' }),
    );
    expect(created.error).toBeUndefined();

    // 1. The account the action created is the one the pickers list.
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Joint Chequing', isActive: true });

    // 2. And the import pipeline accepts it end to end.
    const response = await previewRoute(uploadRequest(accounts[0].id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { totalRows: number; rows: { rawDescription: string }[] };
    expect(body.totalRows).toBe(9);
    expect(body.rows.length).toBeGreaterThan(0);
  });

  it('a deactivated account drops out of the pickers but the id still resolves for history', async () => {
    await createAccountAction({}, formData({ name: 'Old Visa', institution: 'TD', type: 'credit', owner: '' }));
    const id = listAccounts()[0].id;

    const { setAccountActiveAction } = await import('@/app/(app)/settings/accounts/actions');
    await setAccountActiveAction({}, formData({ accountId: String(id), active: '0' }));

    expect(listAccounts()).toHaveLength(0);
    expect(listAccounts({ includeInactive: true })).toHaveLength(1);
  });
});
