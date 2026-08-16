import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { bayesCategoryTotals, bayesTokens } from '@/db/schema';
import { SETTING_BAYES_VOCAB_SIZE, getIntSetting, setIntSetting } from '@/lib/settings';

/**
 * Multinomial naive Bayes with Laplace smoothing, trained only on
 * source = 'manual' transactions (spec section 4 step 4).
 *
 * The gate is the LOG-LIKELIHOOD MARGIN between the best and runner-up
 * category, not a normalized posterior: NB posteriors saturate toward 1.0 on
 * almost any input, which makes a "p >= 0.8" style threshold vacuous.
 */
export const BAYES_MARGIN_THRESHOLD = 2.0;
export const BAYES_MIN_KNOWN_TOKENS = 2;

export function getVocabSize(): number {
  return Math.max(0, getIntSetting(SETTING_BAYES_VOCAB_SIZE, 0));
}

function setVocabSize(value: number): void {
  setIntSetting(SETTING_BAYES_VOCAB_SIZE, Math.max(0, value));
}

function tokenExistsAnywhere(token: string): boolean {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(bayesTokens)
    .where(eq(bayesTokens.token, token))
    .get();
  return (row?.c ?? 0) > 0;
}

export function train(tokens: string[], categoryId: number): void {
  const db = getDb();
  db.transaction((tx) => {
    let vocab = getVocabSize();
    for (const token of tokens) {
      if (!tokenExistsAnywhere(token)) vocab += 1;
      tx.insert(bayesTokens)
        .values({ token, categoryId, count: 1 })
        .onConflictDoUpdate({
          target: [bayesTokens.token, bayesTokens.categoryId],
          set: { count: sql`${bayesTokens.count} + 1` },
        })
        .run();
    }
    tx.insert(bayesCategoryTotals)
      .values({ categoryId, docCount: 1, tokenTotal: tokens.length })
      .onConflictDoUpdate({
        target: bayesCategoryTotals.categoryId,
        set: {
          docCount: sql`${bayesCategoryTotals.docCount} + 1`,
          tokenTotal: sql`${bayesCategoryTotals.tokenTotal} + ${tokens.length}`,
        },
      })
      .run();
    setVocabSize(vocab);
  });
}

export function untrain(tokens: string[], categoryId: number): void {
  const db = getDb();
  db.transaction((tx) => {
    let vocab = getVocabSize();
    for (const token of tokens) {
      const existing = tx
        .select({ count: bayesTokens.count })
        .from(bayesTokens)
        .where(and(eq(bayesTokens.token, token), eq(bayesTokens.categoryId, categoryId)))
        .get();
      if (!existing) continue;

      if (existing.count <= 1) {
        tx.delete(bayesTokens).where(and(eq(bayesTokens.token, token), eq(bayesTokens.categoryId, categoryId))).run();
        if (!tokenExistsAnywhere(token)) vocab -= 1;
      } else {
        tx.update(bayesTokens)
          .set({ count: sql`${bayesTokens.count} - 1` })
          .where(and(eq(bayesTokens.token, token), eq(bayesTokens.categoryId, categoryId)))
          .run();
      }
    }

    const totals = tx
      .select({ docCount: bayesCategoryTotals.docCount, tokenTotal: bayesCategoryTotals.tokenTotal })
      .from(bayesCategoryTotals)
      .where(eq(bayesCategoryTotals.categoryId, categoryId))
      .get();
    if (totals) {
      tx.update(bayesCategoryTotals)
        .set({
          docCount: Math.max(0, totals.docCount - 1),
          tokenTotal: Math.max(0, totals.tokenTotal - tokens.length),
        })
        .where(eq(bayesCategoryTotals.categoryId, categoryId))
        .run();
    }

    setVocabSize(vocab);
  });
}

export function recomputeVocabSize(): number {
  const row = getDb()
    .select({ c: sql<number>`count(distinct ${bayesTokens.token})` })
    .from(bayesTokens)
    .get();
  const value = row?.c ?? 0;
  setVocabSize(value);
  return value;
}

export function scoreCategories(tokens: string[]): { categoryId: number; score: number }[] {
  const db = getDb();
  const totals = db
    .select({
      categoryId: bayesCategoryTotals.categoryId,
      docCount: bayesCategoryTotals.docCount,
      tokenTotal: bayesCategoryTotals.tokenTotal,
    })
    .from(bayesCategoryTotals)
    .all();

  if (totals.length === 0) return [];

  // A category fully untrained back to doc_count = 0 keeps its row (see untrain()),
  // and MUST stay in the running rather than being dropped, so a lone survivor is
  // never stranded without a runner-up. The class prior itself is Laplace-smoothed
  // — log((docCount + 1) / (totalDocs + numCategories)) — rather than the raw
  // log(docCount / totalDocs): an un-smoothed prior sends a doc_count = 0 category
  // to log(0) = -Infinity, which makes the MARGIN infinite and defeats the
  // BAYES_MARGIN_THRESHOLD gate entirely (every future classification would clear
  // an infinite margin, and Infinity cannot be stored in a numeric column). The
  // Laplace-smoothed prior keeps every score finite while still preserving the
  // existing test numbers exactly when doc counts are equal (the prior terms
  // cancel out of the margin).
  const numCategories = totals.length;
  const totalDocs = totals.reduce((sum, row) => sum + row.docCount, 0);

  const knownTokens = tokens.filter((token) => tokenExistsAnywhere(token));
  const vocab = getVocabSize();

  const counts = new Map<string, number>();
  if (knownTokens.length > 0) {
    for (const row of db.select().from(bayesTokens).all()) {
      counts.set(`${row.token}|${row.categoryId}`, row.count);
    }
  }

  return totals
    .map((row) => {
      let score = Math.log((row.docCount + 1) / (totalDocs + numCategories));
      for (const token of knownTokens) {
        const count = counts.get(`${token}|${row.categoryId}`) ?? 0;
        score += Math.log((count + 1) / (row.tokenTotal + vocab));
      }
      return { categoryId: row.categoryId, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function classify(tokens: string[]): { categoryId: number; margin: number } | null {
  const knownTokens = tokens.filter((token) => tokenExistsAnywhere(token));
  // The gate counts DISTINCT known tokens, not instances: tokenize('PIZZA PIZZA')
  // must not clear a >=2 gate off a single vocabulary hit repeated twice.
  const distinctKnownCount = new Set(knownTokens).size;
  if (distinctKnownCount < BAYES_MIN_KNOWN_TOKENS) return null;

  const scores = scoreCategories(tokens);
  // A runner-up is required: with a single trained category the margin is undefined.
  if (scores.length < 2) return null;

  const margin = scores[0].score - scores[1].score;
  // Belt-and-braces: the Laplace-smoothed prior keeps this finite in every
  // reachable state, but guard anyway rather than ever persist a non-finite
  // value into transactions.confidence.
  if (!Number.isFinite(margin)) return null;
  if (margin < BAYES_MARGIN_THRESHOLD) return null;
  return { categoryId: scores[0].categoryId, margin };
}

export function resetBayes(): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(bayesTokens).run();
    tx.delete(bayesCategoryTotals).run();
  });
  setVocabSize(0);
}
