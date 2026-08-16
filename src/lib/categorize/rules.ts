import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { merchantRules } from '@/db/schema';
import { nowIso } from '@/lib/clock';

export type MatchType = 'exact' | 'contains';
/**
 * 'not_transfer' is an exact-match-only override: it teaches the engine that a
 * pattern which CARD_PAYMENT_PATTERNS would otherwise auto-flag is NOT actually
 * a transfer for this merchant, without disabling the pattern list for anyone
 * else (see detectTransfer in engine.ts).
 */
export type RuleKind = 'category' | 'transfer' | 'rename' | 'not_transfer';

export interface MerchantRuleRecord {
  id: number;
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryId: number | null;
  /** Set only on rule_kind = 'rename'. */
  renameTo: string | null;
  createdBy: number | null;
  hitCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export function listRules(kind?: RuleKind): MerchantRuleRecord[] {
  const query = getDb().select().from(merchantRules);
  const rows = kind ? query.where(eq(merchantRules.ruleKind, kind)).all() : query.all();
  return rows.sort((a, b) => a.id - b.id);
}

/** Exact wins; otherwise the longest contains pattern wins; ties break on lowest id. */
export function matchRule(
  normalizedMerchant: string,
  kind: RuleKind,
  rules: MerchantRuleRecord[],
): MerchantRuleRecord | null {
  let bestContains: MerchantRuleRecord | null = null;
  for (const rule of rules) {
    if (rule.ruleKind !== kind) continue;
    if (rule.matchType === 'exact') {
      if (rule.pattern === normalizedMerchant) return rule;
      continue;
    }
    if (rule.pattern.length === 0) continue;
    if (!normalizedMerchant.includes(rule.pattern)) continue;
    if (
      bestContains === null ||
      rule.pattern.length > bestContains.pattern.length ||
      (rule.pattern.length === bestContains.pattern.length && rule.id < bestContains.id)
    ) {
      bestContains = rule;
    }
  }
  return bestContains;
}

export function upsertRuleFromCorrection(input: {
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryId: number | null;
  /** Only meaningful for rule_kind = 'rename'; ignored (stored NULL) otherwise. */
  renameTo?: string | null;
  createdBy: number | null;
  at?: Date;
}): number {
  const db = getDb();
  const renameTo = input.ruleKind === 'rename' ? (input.renameTo ?? null) : null;
  db.insert(merchantRules)
    .values({
      pattern: input.pattern,
      matchType: input.matchType,
      ruleKind: input.ruleKind,
      categoryId: input.categoryId,
      renameTo,
      createdBy: input.createdBy,
      hitCount: 0,
      lastUsedAt: null,
      createdAt: nowIso(input.at ?? new Date()),
    })
    .onConflictDoUpdate({
      target: [merchantRules.pattern, merchantRules.matchType, merchantRules.ruleKind],
      set: { categoryId: input.categoryId, renameTo, createdBy: input.createdBy },
    })
    .run();

  const row = getDb()
    .select({ id: merchantRules.id })
    .from(merchantRules)
    .where(
      and(
        eq(merchantRules.pattern, input.pattern),
        eq(merchantRules.matchType, input.matchType),
        eq(merchantRules.ruleKind, input.ruleKind),
      ),
    )
    .get();
  if (!row) throw new Error('rule upsert failed');
  return row.id;
}

export function deleteRule(id: number): void {
  getDb().delete(merchantRules).where(eq(merchantRules.id, id)).run();
}

export function deleteExactRule(pattern: string, kind: RuleKind): number {
  const result = getDb()
    .delete(merchantRules)
    .where(and(eq(merchantRules.pattern, pattern), eq(merchantRules.matchType, 'exact'), eq(merchantRules.ruleKind, kind)))
    .run();
  return Number(result.changes ?? 0);
}

export function bumpRuleUsage(id: number, at: Date = new Date()): void {
  getDb()
    .update(merchantRules)
    .set({ hitCount: sql`${merchantRules.hitCount} + 1`, lastUsedAt: nowIso(at) })
    .where(eq(merchantRules.id, id))
    .run();
}
