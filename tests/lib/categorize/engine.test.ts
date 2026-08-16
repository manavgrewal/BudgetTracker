import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  CARD_PAYMENT_PATTERNS,
  applyCategoryToMatching,
  applyRenameRules,
  buildContext,
  categorizeTransaction,
  clearCategory,
  confirmCategory,
  deleteRenameRule,
  detectTransfer,
  eligibleForRerun,
  rerunEngine,
  resolveRename,
  reviewQueueCount,
  reviewQueueIds,
  runEngine,
  setTransactionDisplayName,
  setTransferFlag,
  upsertRenameRule,
} from '@/lib/categorize/engine';
import { listRules, matchRule, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { classify, train } from '@/lib/categorize/bayes';
import { normalizeMerchant, tokenize } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const add = (rawDescription: string, amountCents = -1000, date = '2026-03-02') => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${date}, ${rawDescription}, ${normalizeMerchant(rawDescription)}, ${amountCents}, 'none', ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, userId, accountId, add };
}

const readTxn = (sqlite: TestDb['sqlite'], id: number) =>
  sqlite.prepare('select category_id, categorization_source, confidence, is_transfer, normalized_merchant from transactions where id = ?').get(id) as {
    category_id: number | null;
    categorization_source: string;
    confidence: number | null;
    is_transfer: number;
    normalized_merchant: string;
  };

describe('transfer detection', () => {
  it('flags card-payment patterns', () => {
    setup();
    const ctx = buildContext();
    expect(detectTransfer('PAYMENT - THANK YOU', ctx)).toBe(true);
    expect(detectTransfer('AMEX PAYMENT RECEIVED - THANK YOU', ctx)).toBe(true);
    expect(detectTransfer('SCOTIA VISA PAYMENT', ctx)).toBe(true);
    expect(detectTransfer('TFR-TO C/C 4520********1234', ctx)).toBe(true);
    expect(detectTransfer('TFR-FR SAVINGS', ctx)).toBe(true);
    expect(CARD_PAYMENT_PATTERNS.length).toBeGreaterThan(5);
  });

  it('NEVER auto-flags an e-transfer', () => {
    setup();
    const ctx = buildContext();
    expect(detectTransfer('E-TRANSFER SENT J DOE', ctx)).toBe(false);
    expect(detectTransfer('INTERAC E-TRANSFER RECEIVED', ctx)).toBe(false);
    expect(detectTransfer('E-TRANSFER SENT LANDLORD', ctx)).toBe(false);
    expect(detectTransfer('EMAIL TRANSFER TO MOM', ctx)).toBe(false);
  });

  it('leaves ordinary merchants alone', () => {
    setup();
    const ctx = buildContext();
    expect(detectTransfer('TIM HORTONS', ctx)).toBe(false);
    expect(detectTransfer('LOBLAWS', ctx)).toBe(false);
  });

  it('honours a learned exact transfer rule', () => {
    setup();
    upsertRuleFromCorrection({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: null });
    const ctx = buildContext();
    expect(detectTransfer('E-TRANSFER SENT J DOE', ctx)).toBe(true);
    // exact only — a similar e-transfer must not be caught
    expect(detectTransfer('E-TRANSFER SENT J DOE JR', ctx)).toBe(false);
  });
});

describe('categorizeTransaction ordering', () => {
  it('prefers an exact rule over a contains rule and over Bayes', () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null });
    upsertRuleFromCorrection({ pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: restaurants, createdBy: null });
    for (let i = 0; i < 3; i += 1) train(['TIM', 'HORTONS'], groceries);
    for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], restaurants);

    const outcome = categorizeTransaction({ id: 1, normalizedMerchant: 'TIM HORTONS' }, buildContext());
    expect(outcome).toMatchObject({ categoryId: coffee, source: 'rule', confidence: null, isTransfer: false });
  });

  it('falls back to a contains rule', () => {
    const { db } = setup();
    const restaurants = categoryIdByName(db, 'Restaurants');
    upsertRuleFromCorrection({ pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: restaurants, createdBy: null });
    expect(categorizeTransaction({ id: 1, normalizedMerchant: 'TIM HORTONS EXPRESS' }, buildContext())).toMatchObject({
      categoryId: restaurants,
      source: 'rule',
    });
  });

  it('falls back to Bayes and records the margin as confidence', () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    for (let i = 0; i < 3; i += 1) train(['TIM', 'HORTONS'], coffee);
    for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], groceries);

    const outcome = categorizeTransaction({ id: 1, normalizedMerchant: 'TIM HORTONS' }, buildContext());
    expect(outcome.source).toBe('bayes');
    expect(outcome.categoryId).toBe(coffee);
    expect(outcome.confidence).toBeCloseTo(classify(tokenize('TIM HORTONS'))!.margin, 6);
  });

  it('leaves a row uncategorized when nothing matches', () => {
    setup();
    expect(categorizeTransaction({ id: 1, normalizedMerchant: 'SOME NEW SHOP' }, buildContext())).toMatchObject({
      categoryId: null,
      source: 'none',
      confidence: null,
      isTransfer: false,
    });
  });

  it('short-circuits on a transfer and does not categorize it', () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'PAYMENT', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null });
    expect(categorizeTransaction({ id: 1, normalizedMerchant: 'PAYMENT - THANK YOU' }, buildContext())).toMatchObject({
      categoryId: null,
      source: 'none',
      isTransfer: true,
    });
  });
});

describe('runEngine', () => {
  it('writes the outcome and bumps rule hit counts', () => {
    const { db, sqlite, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const ruleId = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null });
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');

    const result = runEngine([id]);
    expect(result).toMatchObject({ processed: 1, categorized: 1, transfers: 0, skipped: 0 });
    expect(readTxn(sqlite, id)).toMatchObject({ category_id: coffee, categorization_source: 'rule', is_transfer: 0 });
    expect(listRules('category').find((r) => r.id === ruleId)?.hitCount).toBe(1);
  });

  it('sets is_transfer on card payments', () => {
    const { sqlite, add } = setup();
    const id = add('PAYMENT - THANK YOU', 50000);
    const result = runEngine([id]);
    expect(result.transfers).toBe(1);
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
  });

  it('NEVER touches a manual or rule row', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId });

    const manualId = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manualId}`);
    const ruleId = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON', -1200);
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'rule' where id = ${ruleId}`);

    const result = runEngine([manualId, ruleId]);
    expect(result).toMatchObject({ processed: 0, skipped: 2 });
    expect(readTxn(sqlite, manualId).category_id).toBe(groceries);
    expect(readTxn(sqlite, ruleId).category_id).toBe(groceries);
  });

  it('DOES re-process an unaccepted bayes row', () => {
    const { db, sqlite, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes', confidence = 2.5 where id = ${id}`);
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null });

    expect(runEngine([id])).toMatchObject({ processed: 1, categorized: 1 });
    expect(readTxn(sqlite, id)).toMatchObject({ category_id: coffee, categorization_source: 'rule', confidence: null });
  });

  it('rerunEngine only picks eligible rows, optionally scoped to an account', () => {
    const { db, add, accountId } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add('SOME NEW SHOP');
    const bayesRow = add('ANOTHER SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes' where id = ${bayesRow}`);
    const manual = add('THIRD SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manual}`);

    expect(eligibleForRerun().sort()).toEqual([uncategorized, bayesRow].sort());
    expect(eligibleForRerun({ accountId }).sort()).toEqual([uncategorized, bayesRow].sort());
    expect(eligibleForRerun({ accountId: accountId + 999 })).toEqual([]);
    expect(rerunEngine().processed).toBe(2);
  });
});

describe('the learning loop', () => {
  it('confirmCategory sets manual, creates an exact rule and trains Bayes', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');

    confirmCategory({ transactionId: id, categoryId: coffee, userId });

    expect(readTxn(sqlite, id)).toMatchObject({ category_id: coffee, categorization_source: 'manual', confidence: null });
    const rules = listRules('category');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'TIM HORTONS', matchType: 'exact', categoryId: coffee, createdBy: userId });
    const trained = sqlite.prepare('select token, count from bayes_tokens where category_id = ? order by token').all(coffee);
    expect(trained).toEqual([{ token: 'HORTONS', count: 1 }, { token: 'TIM', count: 1 }]);
  });

  it('a correction untrains the old category and retrains the new one', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');

    confirmCategory({ transactionId: id, categoryId: coffee, userId });
    confirmCategory({ transactionId: id, categoryId: restaurants, userId });

    expect((sqlite.prepare('select count(*) as c from bayes_tokens where category_id = ?').get(coffee) as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from bayes_tokens where category_id = ?').get(restaurants) as { c: number }).c).toBe(2);
    expect(listRules('category')).toHaveLength(1);
    expect(listRules('category')[0].categoryId).toBe(restaurants);
  });

  it('accepting a Bayes guess is a confirmation, not a re-guess', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    for (let i = 0; i < 3; i += 1) train(['TIM', 'HORTONS'], coffee);
    for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], groceries);

    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    runEngine([id]);
    expect(readTxn(sqlite, id).categorization_source).toBe('bayes');

    confirmCategory({ transactionId: id, categoryId: coffee, userId });
    expect(readTxn(sqlite, id)).toMatchObject({ categorization_source: 'manual', category_id: coffee, confidence: null });
    // The accepted row leaves the review queue permanently.
    expect(reviewQueueIds()).not.toContain(id);
  });

  it('can create a confirmation without a rule when asked', () => {
    const { db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('ONE OFF PURCHASE');
    confirmCategory({ transactionId: id, categoryId: coffee, userId, createRule: false });
    expect(listRules('category')).toHaveLength(0);
  });

  it('clearCategory untrains and returns the row to uncategorized', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    confirmCategory({ transactionId: id, categoryId: coffee, userId });
    clearCategory({ transactionId: id, userId });
    expect(readTxn(sqlite, id)).toMatchObject({ category_id: null, categorization_source: 'none' });
    expect((sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
  });

  it('applyCategoryToMatching confirms every matching row and creates one rule', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    const b = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON', -600, '2026-03-05');
    const c = add('LOBLAWS #1042 BURLINGTON ON');

    expect(applyCategoryToMatching({ normalizedMerchant: 'TIM HORTONS', categoryId: coffee, userId })).toBe(2);
    expect(readTxn(sqlite, a).categorization_source).toBe('manual');
    expect(readTxn(sqlite, b).categorization_source).toBe('manual');
    expect(readTxn(sqlite, c).categorization_source).toBe('none');
    expect(listRules('category')).toHaveLength(1);
  });
});

describe('transfer toggling', () => {
  it('turning the flag on teaches an EXACT transfer rule', () => {
    const { sqlite, add, userId } = setup();
    const id = add('E-TRANSFER SENT J DOE');
    setTransferFlag({ transactionId: id, isTransfer: true, userId });
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    const rules = listRules('transfer');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null });
  });

  it('turning it off removes the learned rule', () => {
    const { sqlite, add, userId } = setup();
    const id = add('E-TRANSFER SENT J DOE');
    setTransferFlag({ transactionId: id, isTransfer: true, userId });
    setTransferFlag({ transactionId: id, isTransfer: false, userId });
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
    expect(listRules('transfer')).toHaveLength(0);
  });

  it('un-flagging a card-payment-pattern row teaches a not_transfer override that survives rerun', () => {
    const { sqlite, add, userId } = setup();
    const id = add('PAYMENT - THANK YOU', 50000);
    runEngine([id]);
    expect(readTxn(sqlite, id).is_transfer).toBe(1);

    setTransferFlag({ transactionId: id, isTransfer: false, userId });
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
    const rules = listRules('not_transfer');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'PAYMENT - THANK YOU', matchType: 'exact', ruleKind: 'not_transfer', categoryId: null });

    // Without the override, rerunEngine would re-flag it on the very next pass.
    rerunEngine();
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
  });

  it('re-flagging as a transfer removes any earlier not_transfer override', () => {
    const { sqlite, add, userId } = setup();
    const id = add('PAYMENT - THANK YOU', 50000);
    runEngine([id]);
    setTransferFlag({ transactionId: id, isTransfer: false, userId });
    expect(listRules('not_transfer')).toHaveLength(1);

    setTransferFlag({ transactionId: id, isTransfer: true, userId });
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    expect(listRules('not_transfer')).toHaveLength(0);
    expect(detectTransfer('PAYMENT - THANK YOU', buildContext())).toBe(true);
  });
});

describe('merchant renames', () => {
  const readDisplay = (sqlite: TestDb['sqlite'], id: number) =>
    sqlite.prepare('select raw_description, display_description, display_source, normalized_merchant from transactions where id = ?').get(id) as {
      raw_description: string;
      display_description: string | null;
      display_source: string | null;
      normalized_merchant: string;
    };

  it('resolves a rename rule with exact-then-longest-contains precedence', () => {
    const { userId } = setup();
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });
    upsertRenameRule({ pattern: 'MCD', matchType: 'contains', renameTo: 'Mickey D', userId });
    upsertRenameRule({ pattern: 'MCDONALDS EXPRESS', matchType: 'contains', renameTo: "McDonald's Express", userId });

    const ctx = buildContext();
    expect(resolveRename('MCDONALDS', ctx)).toBe("McDonald's");
    expect(resolveRename('MCDONALDS EXPRESS TERMINAL', ctx)).toBe("McDonald's Express");
    expect(resolveRename('MCD CAFE', ctx)).toBe('Mickey D');
    expect(resolveRename('TIM HORTONS', ctx)).toBeNull();
  });

  it('applies on import through runEngine and leaves the raw text alone', () => {
    const { sqlite, add, userId } = setup();
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');

    runEngine([id]);

    expect(readDisplay(sqlite, id)).toEqual({
      raw_description: 'POS PURCHASE MCDONALDS #4821 TORONTO ON',
      display_description: "McDonald's",
      display_source: 'rename',
      normalized_merchant: 'MCDONALDS',
    });
  });

  it('never changes raw_description, normalized_merchant or the dedup hash', () => {
    const { db, sqlite, add, userId } = setup();
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    db.run(sql`update transactions set dedup_hash = 'frozen-hash-value' where id = ${id}`);
    const before = sqlite.prepare('select raw_description, normalized_merchant, dedup_hash from transactions where id = ?').get(id);

    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });
    setTransactionDisplayName({ transactionId: id, displayDescription: 'Lunch place', userId });
    applyRenameRules();

    const after = sqlite.prepare('select raw_description, normalized_merchant, dedup_hash from transactions where id = ?').get(id);
    expect(after).toEqual(before);
  });

  it('bulk-applies retroactively when the rule is created', () => {
    const { sqlite, add, userId } = setup();
    const a = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    const b = add('POS PURCHASE MCDONALDS #1099 OAKVILLE ON', -1500, '2026-03-05');
    const other = add('LOBLAWS #1042 BURLINGTON ON');

    const result = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });
    expect(result.rowsUpdated).toBe(2);
    expect(readDisplay(sqlite, a).display_description).toBe("McDonald's");
    expect(readDisplay(sqlite, b).display_description).toBe("McDonald's");
    expect(readDisplay(sqlite, other).display_description).toBeNull();
  });

  it('re-applies when the rule text is edited', () => {
    const { sqlite, add, userId } = setup();
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: 'Golden Arches', userId });
    expect(readDisplay(sqlite, id).display_description).toBe('Golden Arches');
    expect(listRules('rename')).toHaveLength(1);
  });

  it('MANUAL WINS: a manual rename is never overwritten by a rule, a re-run, or a rule edit', () => {
    const { sqlite, add, userId } = setup();
    const manual = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    const ruled = add('POS PURCHASE MCDONALDS #1099 OAKVILLE ON', -1500, '2026-03-05');

    setTransactionDisplayName({ transactionId: manual, displayDescription: 'Lunch with Bob', userId });
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });

    expect(readDisplay(sqlite, manual)).toMatchObject({ display_description: 'Lunch with Bob', display_source: 'manual' });
    expect(readDisplay(sqlite, ruled)).toMatchObject({ display_description: "McDonald's", display_source: 'rename' });

    runEngine([manual, ruled]);
    applyRenameRules();
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: 'Golden Arches', userId });

    expect(readDisplay(sqlite, manual)).toMatchObject({ display_description: 'Lunch with Bob', display_source: 'manual' });
    expect(readDisplay(sqlite, ruled).display_description).toBe('Golden Arches');
  });

  it('clearing a manual rename hands the row back to the rules', () => {
    const { sqlite, add, userId } = setup();
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });
    setTransactionDisplayName({ transactionId: id, displayDescription: 'Lunch with Bob', userId });
    expect(readDisplay(sqlite, id).display_source).toBe('manual');

    setTransactionDisplayName({ transactionId: id, displayDescription: null, userId });
    expect(readDisplay(sqlite, id)).toMatchObject({ display_description: "McDonald's", display_source: 'rename' });
  });

  it('deleting the rule clears only the rows it set', () => {
    const { sqlite, add, userId } = setup();
    const ruled = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    const manual = add('POS PURCHASE MCDONALDS #1099 OAKVILLE ON', -1500, '2026-03-05');
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });
    setTransactionDisplayName({ transactionId: manual, displayDescription: 'Lunch with Bob', userId });

    const result = deleteRenameRule({ pattern: 'MCDONALDS', matchType: 'exact' });
    expect(result.ruleId).not.toBeNull();
    expect(result.rowsCleared).toBe(1);
    expect(readDisplay(sqlite, ruled)).toMatchObject({ display_description: null, display_source: null });
    expect(readDisplay(sqlite, manual)).toMatchObject({ display_description: 'Lunch with Bob', display_source: 'manual' });
    expect(listRules('rename')).toHaveLength(0);
  });

  it('deleting a rule that does not exist is a no-op', () => {
    setup();
    expect(deleteRenameRule({ pattern: 'NOTHING', matchType: 'exact' })).toEqual({ ruleId: null, rowsCleared: 0 });
  });

  it('a rename rule and a category rule coexist on the same pattern', () => {
    const { db, sqlite, add, userId } = setup();
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    upsertRuleFromCorrection({ pattern: 'MCDONALDS', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: userId });
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId });

    runEngine([id]);
    expect(readTxn(sqlite, id)).toMatchObject({ category_id: restaurants, categorization_source: 'rule' });
    expect(readDisplay(sqlite, id).display_description).toBe("McDonald's");
    expect(listRules()).toHaveLength(2);
  });

  it('rename rules never leak into category or transfer matching', () => {
    const { add, userId } = setup();
    upsertRenameRule({ pattern: 'PAYMENT - THANK YOU', matchType: 'exact', renameTo: 'Card payment', userId });
    const ctx = buildContext();
    expect(matchRule('PAYMENT - THANK YOU', 'category', ctx.rules)).toBeNull();
    // The card-payment pattern list still flags it; the rename rule is not what did that.
    expect(detectTransfer('PAYMENT - THANK YOU', ctx)).toBe(true);
    expect(detectTransfer('MCDONALDS', ctx)).toBe(false);
    expect(add).toBeTypeOf('function');
  });

  it('rejects an empty rename target', () => {
    const { userId } = setup();
    expect(() => upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: '   ', userId })).toThrowError(/non-empty display name/);
  });
});

describe('review queue', () => {
  it('contains uncategorized rows and unconfirmed bayes rows only', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add('SOME NEW SHOP');
    const bayesRow = add('ANOTHER SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes', confidence = 3.1 where id = ${bayesRow}`);
    const ruleRow = add('THIRD SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'rule' where id = ${ruleRow}`);
    const manualRow = add('FOURTH SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manualRow}`);

    expect(reviewQueueIds().sort()).toEqual([uncategorized, bayesRow].sort());
    expect(reviewQueueCount()).toBe(2);
  });

  it('excludes transfers, which never need a category', () => {
    const { add } = setup();
    const transfer = add('PAYMENT - THANK YOU', 50000);
    runEngine([transfer]);
    expect(reviewQueueIds()).not.toContain(transfer);
    expect(reviewQueueCount()).toBe(0);
  });

  it('paginates', () => {
    const { add } = setup();
    const ids = [add('SHOP A'), add('SHOP B'), add('SHOP C')];
    expect(reviewQueueIds(2, 0)).toHaveLength(2);
    expect(reviewQueueIds(2, 2)).toHaveLength(1);
    expect(reviewQueueCount()).toBe(ids.length);
  });
});
