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

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import {
  createAccountAction,
  renameAccountAction,
  setAccountActiveAction,
  setAccountOwnerAction,
} from '@/app/(app)/settings/accounts/actions';
import { getAccount, listAccounts } from '@/lib/accounts';

let current: TestDb | null = null;

beforeEach(() => {
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
});

afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  const bobId = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  currentUser = { id: adminId, name: 'Admin', username: 'admin', role: 'admin' };
  return { db: current.db, adminId, bobId };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('createAccountAction', () => {
  it('creates a joint account that immediately shows up in listAccounts', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', owner: '' }));

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/Joint Chequing/);
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null, isActive: true });
  });

  it('accepts a blank institution — a cash jar has no bank', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: 'Grocery Cash', institution: '', type: 'cash', owner: '' }));

    expect(result.error).toBeUndefined();
    expect(listAccounts()[0]).toMatchObject({ name: 'Grocery Cash', institution: '', type: 'cash' });
  });

  it('assigns a personal owner when one is picked', async () => {
    const { bobId } = setup();
    await createAccountAction({}, formData({ name: 'Bob Visa', institution: 'Amex', type: 'credit', owner: String(bobId) }));
    expect(listAccounts()[0]).toMatchObject({ name: 'Bob Visa', ownerUserId: bobId });
  });

  it('refuses a nameless account', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: '   ', institution: 'TD', type: 'chequing', owner: '' }));
    expect(result.error).toMatch(/name/i);
    expect(listAccounts()).toHaveLength(0);
  });

  it('refuses an unsupported type instead of writing an unusable row', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: 'Savings', institution: 'TD', type: 'savings', owner: '' }));
    expect(result.error).toBeTruthy();
    expect(listAccounts()).toHaveLength(0);
  });

  it('refuses an owner who does not exist rather than throwing a foreign-key error', async () => {
    setup();
    const result = await createAccountAction({}, formData({ name: 'Ghost Account', institution: 'TD', type: 'chequing', owner: '9999' }));
    expect(result.error).toMatch(/no longer exists/i);
    expect(listAccounts()).toHaveLength(0);
  });

  it('rejects a cross-origin request before touching the database', async () => {
    setup();
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });
    const result = await createAccountAction({}, formData({ name: 'Attacker Account', institution: 'X', type: 'chequing', owner: '' }));
    expect(result.error).toBe('Cross-origin request rejected');
    expect(listAccounts()).toHaveLength(0);
  });
});

describe('renameAccountAction', () => {
  it('renames without changing the id the transactions point at', async () => {
    setup();
    await createAccountAction({}, formData({ name: 'Chequeing', institution: 'TD', type: 'chequing', owner: '' }));
    const id = listAccounts()[0].id;

    const result = await renameAccountAction({}, formData({ accountId: String(id), name: 'Joint Chequing' }));

    expect(result.message).toMatch(/Joint Chequing/);
    expect(getAccount(id)).toMatchObject({ id, name: 'Joint Chequing' });
  });

  it('refuses a blank name and an unknown account', async () => {
    setup();
    await createAccountAction({}, formData({ name: 'Joint', institution: 'TD', type: 'chequing', owner: '' }));
    const id = listAccounts()[0].id;

    expect((await renameAccountAction({}, formData({ accountId: String(id), name: '  ' }))).error).toBeTruthy();
    expect((await renameAccountAction({}, formData({ accountId: '4242', name: 'Nope' }))).error).toMatch(/no longer exists/i);
    expect(getAccount(id)).toMatchObject({ name: 'Joint' });
  });

  it('rejects a cross-origin request', async () => {
    setup();
    await createAccountAction({}, formData({ name: 'Joint', institution: 'TD', type: 'chequing', owner: '' }));
    const id = listAccounts()[0].id;
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    expect((await renameAccountAction({}, formData({ accountId: String(id), name: 'Owned' }))).error).toBe('Cross-origin request rejected');
    expect(getAccount(id)).toMatchObject({ name: 'Joint' });
  });
});

describe('setAccountOwnerAction', () => {
  it('moves an account between a person and Joint', async () => {
    const { bobId } = setup();
    await createAccountAction({}, formData({ name: 'Joint Chequing', institution: 'TD', type: 'chequing', owner: '' }));
    const id = listAccounts()[0].id;

    await setAccountOwnerAction({}, formData({ accountId: String(id), owner: String(bobId) }));
    expect(getAccount(id)!.ownerUserId).toBe(bobId);

    const backToJoint = await setAccountOwnerAction({}, formData({ accountId: String(id), owner: '' }));
    expect(backToJoint.message).toMatch(/Joint/i);
    expect(getAccount(id)!.ownerUserId).toBeNull();
  });

  it('refuses an owner who does not exist', async () => {
    setup();
    await createAccountAction({}, formData({ name: 'Joint Chequing', institution: 'TD', type: 'chequing', owner: '' }));
    const id = listAccounts()[0].id;

    expect((await setAccountOwnerAction({}, formData({ accountId: String(id), owner: '9999' }))).error).toMatch(/no longer exists/i);
    expect(getAccount(id)!.ownerUserId).toBeNull();
  });

  it('rejects a cross-origin request', async () => {
    const { bobId } = setup();
    await createAccountAction({}, formData({ name: 'Joint Chequing', institution: 'TD', type: 'chequing', owner: '' }));
    const id = listAccounts()[0].id;
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    expect((await setAccountOwnerAction({}, formData({ accountId: String(id), owner: String(bobId) }))).error).toBe('Cross-origin request rejected');
    expect(getAccount(id)!.ownerUserId).toBeNull();
  });
});

describe('setAccountActiveAction (archive only — there is no delete)', () => {
  it('deactivates and reactivates, keeping the row either way', async () => {
    setup();
    await createAccountAction({}, formData({ name: 'Old Visa', institution: 'TD', type: 'credit', owner: '' }));
    const id = listAccounts()[0].id;

    const off = await setAccountActiveAction({}, formData({ accountId: String(id), active: '0' }));
    expect(off.message).toMatch(/deactivated/i);
    expect(listAccounts()).toHaveLength(0);
    expect(listAccounts({ includeInactive: true })).toHaveLength(1);
    expect(getAccount(id)).toMatchObject({ id, isActive: false });

    await setAccountActiveAction({}, formData({ accountId: String(id), active: '1' }));
    expect(listAccounts()).toHaveLength(1);
  });

  it('refuses a malformed request and an unknown account', async () => {
    setup();
    expect((await setAccountActiveAction({}, formData({ accountId: '1', active: 'yes' }))).error).toBe('Invalid request.');
    expect((await setAccountActiveAction({}, formData({ accountId: '4242', active: '0' }))).error).toMatch(/no longer exists/i);
  });

  it('rejects a cross-origin request', async () => {
    setup();
    await createAccountAction({}, formData({ name: 'Old Visa', institution: 'TD', type: 'credit', owner: '' }));
    const id = listAccounts()[0].id;
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    expect((await setAccountActiveAction({}, formData({ accountId: String(id), active: '0' }))).error).toBe('Cross-origin request rejected');
    expect(getAccount(id)!.isActive).toBe(true);
  });
});
