import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { createAccount, createAccountSchema, getAccount, getOrCreateCashAccount, listAccounts, setAccountActive } from '@/lib/accounts';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('accounts', () => {
  it('creates and lists accounts, hiding inactive ones by default', () => {
    current = createSeededTestDb();
    const alice = insertTestUser(current.db, { username: 'alice' });
    const joint = createAccount({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null });
    const personal = createAccount({ name: 'Alice Visa', institution: 'TD Canada Trust', type: 'credit', ownerUserId: alice });

    expect(listAccounts().map((a) => a.id)).toEqual([joint, personal]);
    expect(getAccount(joint)).toMatchObject({ name: 'Joint Chequing', ownerUserId: null, isActive: true });
    setAccountActive(personal, false);
    expect(listAccounts().map((a) => a.id)).toEqual([joint]);
    expect(listAccounts({ includeInactive: true })).toHaveLength(2);
  });

  it('validates input', () => {
    expect(createAccountSchema.safeParse({ name: '', institution: 'TD', type: 'chequing', ownerUserId: null }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'X', institution: 'TD', type: 'savings', ownerUserId: null }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'X', institution: 'TD', type: 'cash', ownerUserId: null }).success).toBe(true);
  });

  it('creates a personal cash account on demand and returns the same one afterwards', () => {
    current = createSeededTestDb();
    const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const first = getOrCreateCashAccount(alice, 'Alice');
    const second = getOrCreateCashAccount(alice, 'Alice');
    expect(second).toBe(first);
    expect(getAccount(first)).toMatchObject({ name: 'Alice Cash', type: 'cash', ownerUserId: alice });
    expect(listAccounts()).toHaveLength(1);
  });
});
