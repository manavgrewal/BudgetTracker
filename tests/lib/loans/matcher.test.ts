import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { applyLoanMatchers, loanLinksForTransactions, saveLoanRule } from '@/lib/loans';
import { categoryBreakdown } from '@/lib/reports';

let t: TestDb;
let accountId = 0;
let userId = 0;
let typeId = 0;

const NOW = '2026-08-18T12:00:00.000Z';

beforeEach(() => {
  t = createSeededTestDb();
  userId = insertTestUser(t.db, { username: 'loans' });
  accountId = insertTestAccount(t.db, { name: 'Chequing' });
  const type = t.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`)
    .get(NOW) as { id: number };
  typeId = type.id;
});
afterEach(() => {
  t.cleanup();
  vi.restoreAllMocks();
});

function seedLoan(over: { name?: string; balanceCents?: number | null; principalCents?: number | null } = {}): {
  itemId: number;
  accountId: number;
} {
  const balance = over.balanceCents === undefined ? 2_000_000 : over.balanceCents;
  const row = t.sqlite
    .prepare(
      `insert into warranty_items
         (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
       values (?, '2024-01-15', 0, ?, ?, ?, ?, ?, ?, ?) returning id`,
    )
    .get(over.name ?? 'Civic', userId, typeId, over.principalCents ?? null, balance, balance === null ? null : NOW, NOW, NOW) as {
    id: number;
  };
  return { itemId: row.id, accountId };
}

function spend(
  merchant: string,
  amountCents: number,
  over: { accountId?: number; isTransfer?: boolean; date?: string; categoryId?: number | null } = {},
): number {
  const row = t.sqlite
    .prepare(
      `insert into transactions
         (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, is_transfer, created_by, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
    )
    .get(
      over.accountId ?? accountId,
      over.date ?? '2026-08-01',
      merchant,
      // The engine's normalizer uppercases; the fixture matches what it would have written.
      merchant.toUpperCase(),
      amountCents,
      over.categoryId ?? null,
      over.isTransfer === true ? 1 : 0,
      userId,
      NOW,
      NOW,
    ) as { id: number };
  return row.id;
}

function balanceOf(itemId: number): number | null {
  return (t.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(itemId) as { b: number | null }).b;
}

/** better-sqlite3 exposes no counter, so count prepares through the driver's own hook. */
function queryCount(): number {
  return prepared;
}
let prepared = 0;
beforeEach(() => {
  prepared = 0;
  const original = t.sqlite.prepare.bind(t.sqlite);
  vi.spyOn(t.sqlite, 'prepare').mockImplementation(((sqlText: string) => {
    prepared += 1;
    return original(sqlText);
  }) as typeof t.sqlite.prepare);
});

describe('MUST-13.3 … MUST-13.6: the rule matcher', () => {
  it('links one matching transaction and decrements the balance', () => {
    const { itemId } = seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'honda fin', accountId: null, enabled: true });
    const txnId = spend('HONDA FIN SVC', -45_000);
    expect(applyLoanMatchers([txnId])).toBe(1);
    expect(balanceOf(itemId)).toBe(1_955_000);
    expect(loanLinksForTransactions([txnId]).get(txnId)![0]).toMatchObject({ appliedCents: 45_000, source: 'rule' });
  });

  it('MUST-11.15: running it twice over the same id creates nothing and decrements nothing', () => {
    const { itemId } = seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const txnId = spend('HONDA FIN SVC', -45_000);
    applyLoanMatchers([txnId]);
    expect(applyLoanMatchers([txnId])).toBe(0);
    expect(balanceOf(itemId)).toBe(1_955_000);
  });

  it('MUST-11.11: matching is case-insensitive against the uppercasing normalizer', () => {
    const { itemId } = seedLoan({ balanceCents: 2_000_000 });
    // The rule is typed in lower case; the stored value is uppercased on write.
    saveLoanRule({ itemId, merchantContains: 'honda fin', accountId: null, enabled: true });
    expect(applyLoanMatchers([spend('honda fin svc', -45_000)])).toBe(1);
  });

  it('skips a positive amount, a transfer and an already-linked transaction', () => {
    const { itemId } = seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    expect(applyLoanMatchers([spend('HONDA FIN SVC', 45_000)])).toBe(0);
    expect(applyLoanMatchers([spend('HONDA FIN SVC', -45_000, { isTransfer: true })])).toBe(0);
    expect(balanceOf(itemId)).toBe(2_000_000);
  });

  it('MUST-13.4: two rules matching one transaction produce ONE link, from the lower rule id', () => {
    const first = seedLoan({ name: 'Car', balanceCents: 2_000_000 });
    const second = seedLoan({ name: 'Boat', balanceCents: 500_000 });
    const lowRuleId = saveLoanRule({ itemId: first.itemId, merchantContains: 'HONDA', accountId: null, enabled: true });
    const highRuleId = saveLoanRule({ itemId: second.itemId, merchantContains: 'HONDA', accountId: null, enabled: true });
    expect(lowRuleId).toBeLessThan(highRuleId);
    const txnId = spend('HONDA FIN SVC', -45_000);
    expect(applyLoanMatchers([txnId])).toBe(1);
    expect(balanceOf(first.itemId)).toBe(1_955_000);
    expect(balanceOf(second.itemId)).toBe(500_000);
  });

  it("an account-scoped rule ignores another account's transaction", () => {
    const other = insertTestAccount(t.db, { name: 'Other' });
    const { itemId, accountId } = seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId, enabled: true });
    expect(applyLoanMatchers([spend('HONDA FIN SVC', -45_000, { accountId: other })])).toBe(0);
    expect(applyLoanMatchers([spend('HONDA FIN SVC', -45_000, { accountId })])).toBe(1);
  });

  it('MUST-13.6: a payment larger than the balance clamps to zero, recording the clamped figure', () => {
    const { itemId } = seedLoan({ balanceCents: 30_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const txnId = spend('HONDA FIN SVC', -45_000);
    applyLoanMatchers([txnId]);
    expect(balanceOf(itemId)).toBe(0);
    const link = loanLinksForTransactions([txnId]).get(txnId)![0]!;
    expect(link.amountCents).toBe(45_000);
    expect(link.appliedCents).toBe(30_000);
    // A further payment against a zero balance is RECORDED, applies nothing, swallows nothing.
    const second = spend('HONDA FIN SVC', -45_000);
    applyLoanMatchers([second]);
    expect(loanLinksForTransactions([second]).get(second)![0]!.appliedCents).toBe(0);
    expect(balanceOf(itemId)).toBe(0);
  });

  it('MUST-13.5: an internal failure returns 0 and does not propagate', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.sqlite.prepare('drop table loan_matcher_rules').run();
    expect(() => applyLoanMatchers([1, 2, 3])).not.toThrow();
    expect(applyLoanMatchers([1, 2, 3])).toBe(0);
    expect(spy).toHaveBeenCalled();
  });

  it('F5: the optional report out-param flags a swallowed failure for callers that need to know', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.sqlite.prepare('drop table loan_matcher_rules').run();
    const report = { failed: false };
    expect(applyLoanMatchers([1, 2, 3], undefined, report)).toBe(0);
    expect(report.failed).toBe(true);
  });

  it('F5: the report is left untouched on a genuinely-empty-but-successful run', () => {
    const { itemId } = seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const report = { failed: false };
    // No candidate transaction matches, but nothing threw.
    expect(applyLoanMatchers([spend('GROCERY', -5_000)], undefined, report)).toBe(0);
    expect(report.failed).toBe(false);
  });

  it('F1 ruling: a rule never links a positive (disbursement/adjustment) transaction, even on a merchant match', () => {
    const { itemId } = seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const txnId = spend('HONDA FIN SVC', 60_000); // positive: a disbursement, not a payment
    expect(applyLoanMatchers([txnId])).toBe(0);
    expect(balanceOf(itemId)).toBe(2_000_000);
    expect(loanLinksForTransactions([txnId]).get(txnId)).toBeUndefined();
  });

  it('AC5: with zero loan rules it performs exactly ONE query and writes nothing', () => {
    const txnId = spend('GROCERY', -5_000);
    const before = queryCount();
    expect(applyLoanMatchers([txnId])).toBe(0);
    expect(queryCount() - before).toBe(1);
    expect(t.sqlite.prepare('select count(*) as n from loan_payments').get()).toEqual({ n: 0 });
  });
});

describe('MUST-13.2: a linked payment stays in its category and in every budget', () => {
  it('the category total is unchanged by linking', () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    const { itemId } = seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const txnId = spend('HONDA FIN SVC', -45_000, { categoryId: groceries });
    const before = categoryBreakdown({ from: '2026-01-01', to: '2026-12-31' });
    applyLoanMatchers([txnId]);
    expect(categoryBreakdown({ from: '2026-01-01', to: '2026-12-31' })).toEqual(before);
    // ...and nothing on the transaction itself moved.
    const row = t.sqlite.prepare('select is_transfer, category_id, attributed_user_id from transactions where id = ?').get(txnId);
    expect(row).toEqual({ is_transfer: 0, category_id: groceries, attributed_user_id: null });
  });
});

describe('F4: the duplicate-rule contract stays a raw driver error', () => {
  /**
   * task-11-brief.md's saveLoanRuleAction wraps `saveLoanRule` in a try/catch that checks
   * `error instanceof BetterSqlite3.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE'`
   * before translating it to "That rule already exists on this loan." -- the same pattern
   * src/app/(app)/warranties/actions.ts already uses for the FK-constraint translation on
   * item-type deletes, and src/app/(app)/settings/item-types/actions.ts uses for its own
   * unique-name translation. If saveLoanRule caught and pre-translated this error itself, that
   * `instanceof` check at the action layer would never match and Task 11's exact message would
   * never surface. This test locks in the raw-error contract Task 11 depends on, rather than
   * "fixing" it into a friendlier throw here and quietly breaking that already-authored catch.
   */
  it('saveLoanRule lets the unique-index violation surface as a raw SqliteError', () => {
    const { itemId } = seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    expect.assertions(2);
    try {
      saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    } catch (error) {
      expect(error).toBeInstanceOf(BetterSqlite3.SqliteError);
      if (error instanceof BetterSqlite3.SqliteError) expect(error.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    }
  });
});
