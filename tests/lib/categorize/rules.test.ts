import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../../helpers/db';
import { bumpRuleUsage, deleteExactRule, deleteRule, listRules, matchRule, upsertRuleFromCorrection } from '@/lib/categorize/rules';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('upsertRuleFromCorrection', () => {
  it('creates a rule and returns its id', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const coffee = categoryIdByName(current.db, 'Coffee');
    const id = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId });
    const rules = listRules('category');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id, pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, hitCount: 0 });
  });

  it('updates in place on conflict instead of piling up duplicates', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const coffee = categoryIdByName(current.db, 'Coffee');
    const restaurants = categoryIdByName(current.db, 'Restaurants');
    const first = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId });
    const second = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: userId });
    expect(second).toBe(first);
    expect(listRules('category')).toHaveLength(1);
    expect(listRules('category')[0].categoryId).toBe(restaurants);
  });

  it('treats (pattern, matchType, ruleKind) as the key', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null });
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null });
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: null });
    expect(listRules()).toHaveLength(3);
    expect(listRules('transfer')).toHaveLength(1);
  });
});

describe('matchRule', () => {
  function ruleset() {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const restaurants = categoryIdByName(current.db, 'Restaurants');
    const groceries = categoryIdByName(current.db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null });
    upsertRuleFromCorrection({ pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: restaurants, createdBy: null });
    upsertRuleFromCorrection({ pattern: 'TIM HORT', matchType: 'contains', ruleKind: 'category', categoryId: groceries, createdBy: null });
    return { coffee, restaurants, groceries, rules: listRules('category') };
  }

  it('prefers an exact match over any contains match', () => {
    const { coffee, rules } = ruleset();
    expect(matchRule('TIM HORTONS', 'category', rules)?.categoryId).toBe(coffee);
  });

  it('uses the longest contains pattern when no exact rule matches', () => {
    const { groceries, rules } = ruleset();
    expect(matchRule('TIM HORTONS EXPRESS', 'category', rules)?.categoryId).toBe(groceries);
  });

  it('returns null when nothing matches', () => {
    const { rules } = ruleset();
    expect(matchRule('LOBLAWS', 'category', rules)).toBeNull();
  });

  it('never returns a rule of a different kind', () => {
    current = createSeededTestDb();
    upsertRuleFromCorrection({ pattern: 'PAYMENT - THANK YOU', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: null });
    const all = listRules();
    expect(matchRule('PAYMENT - THANK YOU', 'category', all)).toBeNull();
    expect(matchRule('PAYMENT - THANK YOU', 'transfer', all)?.ruleKind).toBe('transfer');
  });

  it('breaks a length tie by lowest rule id', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const groceries = categoryIdByName(current.db, 'Groceries');
    const first = upsertRuleFromCorrection({ pattern: 'AAAA', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null });
    upsertRuleFromCorrection({ pattern: 'BBBB', matchType: 'contains', ruleKind: 'category', categoryId: groceries, createdBy: null });
    expect(matchRule('XX AAAA BBBB XX', 'category', listRules())?.id).toBe(first);
  });
});

describe('rule maintenance', () => {
  it('bumps hit count and last used', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const id = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null });
    bumpRuleUsage(id, new Date('2026-08-15T12:00:00.000Z'));
    bumpRuleUsage(id, new Date('2026-08-16T12:00:00.000Z'));
    const rule = listRules('category')[0];
    expect(rule.hitCount).toBe(2);
    expect(rule.lastUsedAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('deletes by id and by exact pattern', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const id = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null });
    upsertRuleFromCorrection({ pattern: 'TFR-TO', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: null });
    deleteRule(id);
    expect(listRules('category')).toHaveLength(0);
    expect(deleteExactRule('TFR-TO', 'transfer')).toBe(1);
    expect(listRules()).toHaveLength(0);
    expect(deleteExactRule('NOTHING', 'transfer')).toBe(0);
  });
});
