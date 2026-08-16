import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { isSimplefinManaged, linkAccount, listLinks, saveClaimedConnection } from '@/lib/simplefin/connection';

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

import { forgetConnectionAction } from '@/app/(app)/settings/connections/actions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';

function setup() {
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  currentUser = { id: userId, name: 'Admin', username: 'admin', role: 'admin' };
  return { db: current.db };
}

describe('forgetConnectionAction', () => {
  it('deletes the connection AND unlinks every account, reverting them to CSV-managed', async () => {
    const { db } = setup();
    const accountId = insertTestAccount(db, { name: 'Bridge Chequing' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
    expect(isSimplefinManaged(accountId)).toBe(true);

    const result = await forgetConnectionAction();

    expect(listLinks()).toHaveLength(0);
    expect(isSimplefinManaged(accountId)).toBe(false);
    expect(result.message).toMatch(/Bridge Chequing/);
    expect(result.message).toMatch(/CSV import/i);
  });

  it('names every affected account when more than one was linked', async () => {
    const { db } = setup();
    const a = insertTestAccount(db, { name: 'Bridge Chequing' });
    const b = insertTestAccount(db, { name: 'Bridge Savings' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId: a, currency: 'CAD' });
    linkAccount({ simplefinAccountId: 'remote-2', accountId: b, currency: 'CAD' });

    const result = await forgetConnectionAction();

    expect(result.message).toMatch(/Bridge Chequing/);
    expect(result.message).toMatch(/Bridge Savings/);
    expect(isSimplefinManaged(a)).toBe(false);
    expect(isSimplefinManaged(b)).toBe(false);
  });

  it('rejects a cross-origin request and leaves the connection and its links alone (I2)', async () => {
    const { db } = setup();
    const accountId = insertTestAccount(db, { name: 'Bridge Chequing' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    const result = await forgetConnectionAction();

    expect(result.error).toBe('Cross-origin request rejected');
    expect(result.message).toBeUndefined();
    expect(listLinks()).toHaveLength(1);
    expect(isSimplefinManaged(accountId)).toBe(true);
  });

  it('reports a plain removal message when nothing was ever linked', async () => {
    setup();
    saveClaimedConnection(ACCESS_URL);

    const result = await forgetConnectionAction();

    expect(result.message).toMatch(/Connection removed/i);
    expect(result.message).not.toMatch(/CSV import/i);
  });
});
