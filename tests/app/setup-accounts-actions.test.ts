import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };
let requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
}));

const redirected: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirected.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import { saveSetupAccountsAction } from '@/app/(auth)/setup/accounts/actions';
import { listAccounts } from '@/lib/accounts';

let current: TestDb | null = null;

beforeEach(() => {
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
  redirected.length = 0;
  current = createSeededTestDb();
  const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  currentUser = { id: adminId, name: 'Admin', username: 'admin', role: 'admin' };
});

afterEach(() => {
  current?.cleanup();
  current = null;
});

function payload(rows: unknown): FormData {
  const fd = new FormData();
  fd.set('accounts', JSON.stringify(rows));
  return fd;
}

describe('saveSetupAccountsAction (optional first-run accounts step)', () => {
  it('creates every row and sends the admin to the dashboard', async () => {
    await expect(
      saveSetupAccountsAction({}, payload([
        { name: 'Joint Chequing', type: 'chequing', owner: '' },
        { name: 'Joint Visa', type: 'credit', owner: '' },
      ])),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(redirected).toEqual(['/dashboard']);
    expect(listAccounts().map((a) => a.name)).toEqual(['Joint Chequing', 'Joint Visa']);
    expect(listAccounts().every((a) => a.ownerUserId === null)).toBe(true);
  });

  it('records the admin as owner when they pick themselves', async () => {
    await expect(
      saveSetupAccountsAction({}, payload([{ name: 'My Visa', type: 'credit', owner: String(currentUser.id) }])),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(listAccounts()[0].ownerUserId).toBe(currentUser.id);
  });

  it('falls back to Joint for an owner id that is not the admin (nobody else exists yet)', async () => {
    await expect(
      saveSetupAccountsAction({}, payload([{ name: 'Forged', type: 'chequing', owner: '9999' }])),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(listAccounts()[0].ownerUserId).toBeNull();
  });

  it('skipping (an empty list) creates nothing and still moves on', async () => {
    await expect(saveSetupAccountsAction({}, payload([]))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirected).toEqual(['/dashboard']);
    expect(listAccounts()).toHaveLength(0);
  });

  it('refuses a nameless row instead of creating half the list', async () => {
    const result = await saveSetupAccountsAction({}, payload([
      { name: 'Joint Chequing', type: 'chequing', owner: '' },
      { name: '   ', type: 'chequing', owner: '' },
    ]));
    expect(result.error).toMatch(/name/i);
    expect(listAccounts()).toHaveLength(0);
    expect(redirected).toEqual([]);
  });

  it('rejects a cross-origin request before creating anything', async () => {
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });
    const result = await saveSetupAccountsAction({}, payload([{ name: 'Attacker', type: 'chequing', owner: '' }]));
    expect(result.error).toBe('Cross-origin request rejected');
    expect(listAccounts()).toHaveLength(0);
  });
});
