import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { getWarrantyItem } from '@/lib/warranty/items';
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

/**
 * MUST-12.5/12.6: a loan-kind type, an item with a billing pair and loan money, one matcher
 * rule and one linked payment -- so a kind flip away from 'loan' has something real to clear
 * (money + rule) and something real that must survive (the payment). Mirrors
 * tests/db/loan-schema.test.ts's own seedLoan(), which pins the same shapes at the SQL layer.
 */
function seedLoanWithRuleAndPayment(): { typeId: number; itemId: number; txnId: number } {
  const userId = insertTestUser(current!.db, { name: 'Bob', username: 'bob-loan' });
  const accountId = insertTestAccount(current!.db, { name: 'Loan Chequing' });
  const loan = createItemType('Car Loan Flip', 'loan');
  const itemInfo = current!.sqlite
    .prepare(
      `insert into warranty_items
        (name, purchase_date, is_lifetime, owner_user_id, type_id, billing_cycle, billing_amount_cents,
         principal_cents, interest_rate_bps, current_balance_cents, balance_updated_at, created_at, updated_at)
       values ('Civic', '2024-01-15', 0, ?, ?, 'monthly', 45000, 2500000, 549, 2000000, ?, ?, ?)`,
    )
    .run(userId, loan.id, ISO, ISO, ISO);
  const itemId = Number(itemInfo.lastInsertRowid);
  current!.sqlite
    .prepare(
      `insert into loan_matcher_rules (item_id, merchant_contains, account_id, enabled, created_at, updated_at)
       values (?, 'HONDA FIN', ?, 1, ?, ?)`,
    )
    .run(itemId, accountId, ISO, ISO);
  const txnInfo = current!.sqlite
    .prepare(
      `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
       values (?, '2026-08-01', 'HONDA FIN SVC', 'HONDA FIN SVC', -45000, ?, ?, ?)`,
    )
    .run(accountId, userId, ISO, ISO);
  const txnId = Number(txnInfo.lastInsertRowid);
  current!.sqlite
    .prepare(
      `insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
       values (?, ?, 45000, 45000, 'manual', ?)`,
    )
    .run(txnId, itemId, ISO);
  return { typeId: loan.id, itemId, txnId };
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

  // review fix (v1.3.0): switching a type's kind to one where billing is disallowed must
  // clear billing_cycle/billing_amount_cents on every item of that type, in the same
  // transaction -- otherwise the invariant documented in drizzle/0005_billing_cycle.sql
  // ("only subscription/contract items ever carry non-NULL billing columns") goes stale in
  // the database the moment an admin recategorises a type from Settings -> Item types,
  // bypassing the item-write path (assertBillingMatchesKind in items.ts) entirely.
  describe('setItemTypeKind clears stale billing on the type flip', () => {
    function billingOf(itemId: number): { billing_cycle: string | null; billing_amount_cents: number | null } {
      return current!.sqlite
        .prepare('select billing_cycle, billing_amount_cents from warranty_items where id = ?')
        .get(itemId) as { billing_cycle: string | null; billing_amount_cents: number | null };
    }

    it('nulls both billing columns on every item when the new kind disallows billing', () => {
      const { userId } = setup();
      const sub = createItemType('Streaming Kind Flip', 'subscription');
      const itemId = insertItem(sub.id, userId, 'Netflix');
      current!.sqlite
        .prepare('update warranty_items set billing_cycle = ?, billing_amount_cents = ? where id = ?')
        .run('monthly', 1599, itemId);
      expect(billingOf(itemId)).toEqual({ billing_cycle: 'monthly', billing_amount_cents: 1599 });

      setItemTypeKind(sub.id, 'warranty');

      expect(billingOf(itemId)).toEqual({ billing_cycle: null, billing_amount_cents: null });
    });

    // v1.3.1: widened -- 'warranty' is now the ONLY kind that disallows billing, so a flip
    // to 'loan' (allowed since MUST-12.1) keeps the pair, same as the "two ALLOWED kinds"
    // case just below.
    it('keeps billing when flipping to loan too, since loan now allows billing (MUST-12.1)', () => {
      const { userId } = setup();
      const contract = createItemType('Gym Kind Flip', 'contract');
      const itemId = insertItem(contract.id, userId, 'Gym membership');
      current!.sqlite
        .prepare('update warranty_items set billing_cycle = ?, billing_amount_cents = ? where id = ?')
        .run('annual', 49999, itemId);

      setItemTypeKind(contract.id, 'loan');

      expect(billingOf(itemId)).toEqual({ billing_cycle: 'annual', billing_amount_cents: 49999 });
    });

    it('leaves billing untouched when flipping between the two ALLOWED kinds', () => {
      const { userId } = setup();
      const sub = createItemType('Streaming Kind Flip Allowed', 'subscription');
      const itemId = insertItem(sub.id, userId, 'Spotify');
      current!.sqlite
        .prepare('update warranty_items set billing_cycle = ?, billing_amount_cents = ? where id = ?')
        .run('monthly', 999, itemId);

      setItemTypeKind(sub.id, 'contract');

      expect(billingOf(itemId)).toEqual({ billing_cycle: 'monthly', billing_amount_cents: 999 });
    });

    it('leaves other types items alone', () => {
      const { userId } = setup();
      const sub = createItemType('Streaming Kind Flip Scope', 'subscription');
      const otherSub = createItemType('Other Streaming Kind Flip Scope', 'subscription');
      const flippedItem = insertItem(sub.id, userId, 'Flipped');
      const untouchedItem = insertItem(otherSub.id, userId, 'Untouched');
      for (const id of [flippedItem, untouchedItem]) {
        current!.sqlite
          .prepare('update warranty_items set billing_cycle = ?, billing_amount_cents = ? where id = ?')
          .run('monthly', 500, id);
      }

      setItemTypeKind(sub.id, 'warranty');

      expect(billingOf(flippedItem)).toEqual({ billing_cycle: null, billing_amount_cents: null });
      expect(billingOf(untouchedItem)).toEqual({ billing_cycle: 'monthly', billing_amount_cents: 500 });
    });
  });
});

describe('MUST-12.5 / MUST-12.6: what a kind flip clears', () => {
  it('loan -> warranty clears the money and the billing pair, deletes the rules, KEEPS the payments', () => {
    setup();
    const { typeId, itemId, txnId } = seedLoanWithRuleAndPayment();
    setItemTypeKind(typeId, 'warranty');
    const item = getWarrantyItem(itemId)!;
    expect([item.principalCents, item.interestRateBps, item.currentBalanceCents, item.balanceUpdatedAt]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect([item.billingCycle, item.billingAmountCents]).toEqual([null, null]);
    expect(current!.sqlite.prepare('select count(*) as n from loan_matcher_rules').get()).toEqual({ n: 0 });
    // Historical facts about what the household paid survive.
    expect(current!.sqlite.prepare('select count(*) as n from loan_payments where txn_id = ?').get(txnId)).toEqual({
      n: 1,
    });
  });

  it('loan -> subscription KEEPS the billing pair and clears only the money fields', () => {
    setup();
    const { typeId, itemId } = seedLoanWithRuleAndPayment();
    setItemTypeKind(typeId, 'subscription');
    const item = getWarrantyItem(itemId)!;
    expect(item.billingCycle).toBe('monthly');
    expect(item.billingAmountCents).toBe(45000);
    expect(item.currentBalanceCents).toBeNull();
    expect(current!.sqlite.prepare('select count(*) as n from loan_matcher_rules').get()).toEqual({ n: 0 });
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
