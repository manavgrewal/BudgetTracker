import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import {
  ItemTypeInUseError,
  createItemType,
  deleteItemType,
  findItemType,
  listItemTypes,
  listItemTypesWithUsage,
  renameItemType,
  setItemTypeKind,
  typeUsageCount,
} from '@/lib/warranty/types';

let current: TestDb | null = null;

afterEach(() => {
  current?.cleanup();
  current = null;
});

const ISO = '2026-08-16T12:00:00.000Z';

function setup(): { userId: number } {
  current = createTestDb();
  return { userId: insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' }) };
}

function insertItem(typeId: number | null, userId: number, name = 'Fridge'): number {
  const info = current!.sqlite
    .prepare(
      `insert into warranty_items
        (name, purchase_date, warranty_months, is_lifetime, expiry_date, owner_user_id, type_id, created_at, updated_at)
       values (?, '2026-08-16', 24, 0, '2028-08-16', ?, ?, ?, ?)`,
    )
    .run(name, userId, typeId, ISO, ISO);
  return Number(info.lastInsertRowid);
}

function idOf(name: string): number {
  const found = listItemTypes().find((t) => t.name === name);
  if (!found) throw new Error(`no type named ${name}`);
  return found.id;
}

describe('listItemTypes', () => {
  it('returns the seeded types (including v1.2.2 Contract/Loan) ordered case-insensitively by name', () => {
    setup();
    createItemType('zebra', 'warranty');
    createItemType('Anvil', 'warranty');
    expect(listItemTypes().map((t) => t.name)).toEqual([
      'Anvil',
      'Appliance',
      'Contract',
      'Laptop',
      'Loan',
      'Subscription',
      'zebra',
    ]);
  });

  it('maps is_subscription to a boolean', () => {
    setup();
    expect(listItemTypes().find((t) => t.name === 'Subscription')!.isSubscription).toBe(true);
    expect(listItemTypes().find((t) => t.name === 'Laptop')!.isSubscription).toBe(false);
  });

  it('returns kind for every seeded type, including the v1.2.2 backfill and additions', () => {
    setup();
    const byName = Object.fromEntries(listItemTypes().map((t) => [t.name, t.kind]));
    expect(byName).toEqual({
      Laptop: 'warranty',
      Appliance: 'warranty',
      Subscription: 'subscription',
      Contract: 'contract',
      Loan: 'loan',
    });
  });
});

describe('createItemType', () => {
  it('trims the name and stores the kind, keeping is_subscription in lockstep', () => {
    setup();
    const created = createItemType('  Streaming service  ', 'subscription');
    expect(created.name).toBe('Streaming service');
    expect(created.kind).toBe('subscription');
    expect(created.isSubscription).toBe(true);
    expect(findItemType(created.id)).toMatchObject({ name: 'Streaming service', kind: 'subscription', isSubscription: true });
  });

  it('stores a contract and a loan with is_subscription false', () => {
    setup();
    const contract = createItemType('Gym membership', 'contract');
    expect(contract.kind).toBe('contract');
    expect(contract.isSubscription).toBe(false);
    const loan = createItemType('Car loan', 'loan');
    expect(loan.kind).toBe('loan');
    expect(loan.isSubscription).toBe(false);
  });

  it('rejects an empty name and one over 60 characters', () => {
    setup();
    expect(() => createItemType('   ', 'warranty')).toThrowError(/name is required/i);
    expect(() => createItemType('x'.repeat(61), 'warranty')).toThrowError(/60/);
    expect(createItemType('x'.repeat(60), 'warranty').name).toHaveLength(60);
  });

  it('rejects an unknown kind (zod backstop behind the CHECK constraint)', () => {
    setup();
    const invalidKind = 'lease' as unknown as Parameters<typeof createItemType>[1];
    expect(() => createItemType('Whatever', invalidKind)).toThrow();
  });

  it('rejects a duplicate that differs only in case, with a readable message', () => {
    setup();
    expect(() => createItemType('laptop', 'warranty')).toThrowError(/already exists/i);
    expect(() => createItemType('LAPTOP', 'warranty')).toThrowError(/Laptop/);
    expect(listItemTypes()).toHaveLength(5);
  });
});

describe('renameItemType / setItemTypeKind', () => {
  it('renames, including while the type is in use', () => {
    const { userId } = setup();
    const laptop = idOf('Laptop');
    const itemId = insertItem(laptop, userId);
    const renamed = renameItemType(laptop, '  Notebook  ');
    expect(renamed.name).toBe('Notebook');
    const row = current!.sqlite.prepare('select type_id from warranty_items where id = ?').get(itemId) as {
      type_id: number;
    };
    expect(row.type_id).toBe(laptop);
  });

  it('allows renaming a type to its own name in different case, but not onto another type', () => {
    setup();
    const laptop = idOf('Laptop');
    expect(renameItemType(laptop, 'LAPTOP').name).toBe('LAPTOP');
    expect(() => renameItemType(laptop, 'appliance')).toThrowError(/already exists/i);
  });

  it('changes kind across all four values, keeping is_subscription in lockstep', () => {
    setup();
    const laptop = idOf('Laptop');
    expect(setItemTypeKind(laptop, 'subscription')).toMatchObject({ kind: 'subscription', isSubscription: true });
    expect(findItemType(laptop)).toMatchObject({ kind: 'subscription', isSubscription: true });
    expect(setItemTypeKind(laptop, 'contract')).toMatchObject({ kind: 'contract', isSubscription: false });
    expect(setItemTypeKind(laptop, 'loan')).toMatchObject({ kind: 'loan', isSubscription: false });
    expect(setItemTypeKind(laptop, 'warranty')).toMatchObject({ kind: 'warranty', isSubscription: false });
  });

  it('throws a readable error for an unknown id', () => {
    setup();
    expect(() => renameItemType(9999, 'Nope')).toThrowError(/no longer exists|not found/i);
    expect(findItemType(9999)).toBeNull();
  });
});

describe('typeUsageCount / listItemTypesWithUsage', () => {
  it('counts only the items of that type', () => {
    const { userId } = setup();
    const laptop = idOf('Laptop');
    const appliance = idOf('Appliance');
    insertItem(laptop, userId, 'ThinkPad');
    insertItem(laptop, userId, 'MacBook');
    insertItem(appliance, userId, 'Fridge');
    insertItem(null, userId, 'Unclassified thing');
    expect(typeUsageCount(laptop)).toBe(2);
    expect(typeUsageCount(appliance)).toBe(1);
    const usage = Object.fromEntries(listItemTypesWithUsage().map((t) => [t.name, t.usageCount]));
    expect(usage).toEqual({ Appliance: 1, Contract: 0, Laptop: 2, Loan: 0, Subscription: 0 });
  });
});

describe('deleteItemType', () => {
  it('deletes an unused type', () => {
    setup();
    const spare = createItemType('Spare', 'warranty');
    deleteItemType(spare.id);
    expect(findItemType(spare.id)).toBeNull();
  });

  it('refuses a type in use, reports the count, and changes nothing (MUST-19.5)', () => {
    const { userId } = setup();
    const laptop = idOf('Laptop');
    insertItem(laptop, userId, 'ThinkPad');
    insertItem(laptop, userId, 'MacBook');

    let caught: unknown;
    try {
      deleteItemType(laptop);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ItemTypeInUseError);
    expect((caught as ItemTypeInUseError).count).toBe(2);
    expect((caught as ItemTypeInUseError).typeId).toBe(laptop);
    expect((caught as Error).message).toMatch(/2 items use this type/i);

    // No cascade and no set-null: the type and both items survive untouched.
    expect(findItemType(laptop)).not.toBeNull();
    const rows = current!.sqlite
      .prepare('select count(*) as c from warranty_items where type_id = ?')
      .get(laptop) as { c: number };
    expect(rows.c).toBe(2);
  });

  it('says "1 item" for a single user of the type', () => {
    const { userId } = setup();
    const laptop = idOf('Laptop');
    insertItem(laptop, userId);
    expect(() => deleteItemType(laptop)).toThrowError(/1 item uses this type/i);
  });

  it('throws a readable error for an unknown id', () => {
    setup();
    expect(() => deleteItemType(9999)).toThrowError(/no longer exists|not found/i);
  });
});
