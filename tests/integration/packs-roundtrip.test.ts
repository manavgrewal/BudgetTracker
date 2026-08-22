import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../helpers/db';
import { exportProfilesPack, exportRulesPack, importProfilesPack, importRulesPack, previewRulesPackImport } from '@/lib/packs';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { createCategory, listCategories } from '@/lib/categories';
import { createProfile, getBuiltinPreset, getProfileByName, listProfiles } from '@/lib/import/presets';
import { buildContext, categorizeTransaction } from '@/lib/categorize/engine';
import { normalizeMerchant } from '@/lib/categorize/normalize';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/** Build a "sender" database, take a pack out of it, then throw the database away. */
function packFromSender(includeTransferRules: boolean) {
  const sender = createSeededTestDb();
  const userId = insertTestUser(sender.db, { name: 'Alice', username: 'alice' });
  const food = categoryIdByName(sender.db, 'Food');
  const pets = createCategory({ name: 'Pets', parentId: null });
  const vet = createCategory({ name: 'Vet', parentId: pets });

  upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: categoryIdByName(sender.db, 'Coffee'), createdBy: userId });
  upsertRuleFromCorrection({ pattern: 'LOBLAWS', matchType: 'contains', ruleKind: 'category', categoryId: categoryIdByName(sender.db, 'Groceries'), createdBy: userId });
  upsertRuleFromCorrection({ pattern: 'RIVERSIDE ANIMAL HOSPITAL', matchType: 'exact', ruleKind: 'category', categoryId: vet, createdBy: userId });
  upsertRuleFromCorrection({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: userId });
  createProfile({ name: 'Tangerine Chequing', institution: 'Tangerine', mapping: { ...getBuiltinPreset('Scotiabank Chequing/Debit'), dateFormat: 'YYYY-MM-DD' } });

  const rules = exportRulesPack({ includeTransferRules });
  const profiles = exportProfilesPack();
  void food;
  sender.cleanup();
  return { rules, profiles };
}

describe('rules pack round trip onto a fresh database', () => {
  it('creates the missing categories by name and lands every rule', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();

    const plan = previewRulesPackImport(rules);
    expect(plan.totalRules).toBe(3);
    expect(plan.newRules).toBe(3);
    expect(plan.newCategories.sort()).toEqual(['Pets', 'Vet']);

    const result = importRulesPack(rules);
    expect(result).toMatchObject({ rulesAdded: 3, rulesOverwritten: 0, rulesKept: 0, categoriesCreated: 2 });

    const all = listCategories();
    const pets = all.find((c) => c.name === 'Pets')!;
    const vet = all.find((c) => c.name === 'Vet')!;
    expect(pets.parentId).toBeNull();
    expect(vet.parentId).toBe(pets.id);

    // Existing seeded categories were reused, not duplicated.
    expect(all.filter((c) => c.name === 'Coffee')).toHaveLength(1);
    const coffee = categoryIdByName(current.db, 'Coffee');
    expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(coffee);
    expect(listRules('category').find((r) => r.pattern === 'RIVERSIDE ANIMAL HOSPITAL')?.categoryId).toBe(vet.id);
  });

  it('the imported rules immediately drive the categorizer', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(rules);

    const ctx = buildContext();
    const merchant = normalizeMerchant('POS PURCHASE       TIM HORTONS #4821 TORONTO ON');
    const outcome = categorizeTransaction({ id: 1, normalizedMerchant: merchant }, ctx);
    expect(outcome.source).toBe('rule');
    expect(outcome.categoryId).toBe(categoryIdByName(current.db, 'Coffee'));
  });

  it('leaves the receiver Bayes model completely untouched', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(rules);
    expect((current.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
    expect((current.sqlite.prepare('select count(*) as c from accounts').get() as { c: number }).c).toBe(0);
  });

  it('carries no transfer rules unless the sender opted in', () => {
    const withoutTransfers = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(withoutTransfers.rules);
    expect(listRules('transfer')).toHaveLength(0);
    current.cleanup();
    current = null;

    const withTransfers = packFromSender(true);
    current = createSeededTestDb();
    importRulesPack(withTransfers.rules);
    expect(listRules('transfer').map((r) => r.pattern)).toEqual(['E-TRANSFER SENT J DOE']);
    expect(listRules('transfer')[0].matchType).toBe('exact');
  });

  it('respects keep on the second import and overwrite when asked', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(rules);

    // The receiver reclassifies TIM HORTONS locally, then re-imports the pack.
    // (Brief's literal test hardcoded createdBy: 1, but a fresh seeded test db has
    // no users row yet — insert one so the FK on merchant_rules.created_by holds.)
    const receiverUserId = insertTestUser(current.db, { name: 'Receiver', username: 'receiver' });
    const restaurants = categoryIdByName(current.db, 'Restaurants');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: receiverUserId });

    const kept = importRulesPack(rules);
    expect(kept).toMatchObject({ rulesAdded: 0, rulesKept: 1, rulesOverwritten: 0 });
    expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(restaurants);

    const overwritten = importRulesPack(rules, { onConflict: 'overwrite' });
    expect(overwritten).toMatchObject({ rulesAdded: 0, rulesKept: 0, rulesOverwritten: 1 });
    expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(categoryIdByName(current.db, 'Coffee'));
  });

  it('is idempotent when nothing changed', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(rules);
    const before = listRules().length;
    const again = importRulesPack(rules);
    expect(again).toEqual({ rulesAdded: 0, rulesOverwritten: 0, rulesKept: 0, rulesSkipped: 0, categoriesCreated: 0 });
    expect(listRules().length).toBe(before);
  });
});

describe('profiles pack round trip onto a fresh database', () => {
  it('renames colliding built-in names and lands the custom profile as-is', () => {
    const { profiles } = packFromSender(false);
    current = createSeededTestDb();

    const result = importProfilesPack(profiles);
    expect(result.added.map((a) => a.name)).toEqual([
      'TD Chequing/Debit (2)',
      'TD Visa (2)',
      'Scotiabank Chequing/Debit (2)',
      'Amex Canada (2)',
      'Tangerine Chequing',
    ]);
    expect(listProfiles()).toHaveLength(9);

    const tangerine = getProfileByName('Tangerine Chequing')!;
    expect(tangerine.isBuiltin).toBe(false);
    expect(tangerine.mapping!.dateFormat).toBe('YYYY-MM-DD');
    expect(getProfileByName('TD Visa')?.isBuiltin).toBe(true);
    expect(getProfileByName('TD Visa (2)')?.isBuiltin).toBe(false);
  });
});
