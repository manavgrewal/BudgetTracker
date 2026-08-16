import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, type TestDb } from '../../helpers/db';
import {
  deleteConnection,
  getConnection,
  isSimplefinManaged,
  linkAccount,
  listLinks,
  saveClaimedConnection,
} from '@/lib/simplefin/connection';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';

describe('deleteConnection — "forget" must not permanently lock accounts out of CSV import', () => {
  it('clears every account link along with the connection row', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Bridge Chequing' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
    expect(isSimplefinManaged(accountId)).toBe(true);

    deleteConnection();

    expect(getConnection()).toBeNull();
    expect(listLinks()).toHaveLength(0);
    // The account reverts to CSV-managed — otherwise the CSV-exclusivity guard
    // in flow.ts would refuse it forever with no UI left to unlink from.
    expect(isSimplefinManaged(accountId)).toBe(false);
  });

  it('clears links for every account, not just the first', () => {
    current = createSeededTestDb();
    const a = insertTestAccount(current.db, { name: 'Bridge Chequing' });
    const b = insertTestAccount(current.db, { name: 'Bridge Savings' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId: a, currency: 'CAD' });
    linkAccount({ simplefinAccountId: 'remote-2', accountId: b, currency: 'CAD' });

    deleteConnection();

    expect(isSimplefinManaged(a)).toBe(false);
    expect(isSimplefinManaged(b)).toBe(false);
  });

  it('is a no-op (no throw) when nothing is configured', () => {
    current = createSeededTestDb();
    expect(() => deleteConnection()).not.toThrow();
    expect(getConnection()).toBeNull();
    expect(listLinks()).toHaveLength(0);
  });
});
