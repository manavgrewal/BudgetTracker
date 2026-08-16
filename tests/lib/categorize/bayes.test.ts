import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, type TestDb } from '../../helpers/db';
import {
  BAYES_MARGIN_THRESHOLD,
  BAYES_MIN_KNOWN_TOKENS,
  classify,
  getVocabSize,
  recomputeVocabSize,
  resetBayes,
  scoreCategories,
  train,
  untrain,
} from '@/lib/categorize/bayes';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function twoCategories() {
  current = createSeededTestDb();
  const coffee = categoryIdByName(current.db, 'Coffee');
  const groceries = categoryIdByName(current.db, 'Groceries');
  for (let i = 0; i < 3; i += 1) train(['TIM', 'HORTONS'], coffee);
  for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], groceries);
  return { coffee, groceries, db: current.db, sqlite: current.sqlite };
}

describe('train', () => {
  it('records token counts, doc counts and token totals', () => {
    const { coffee, sqlite } = twoCategories();
    const tokens = sqlite.prepare('select token, count from bayes_tokens where category_id = ? order by token').all(coffee) as {
      token: string;
      count: number;
    }[];
    expect(tokens).toEqual([{ token: 'HORTONS', count: 3 }, { token: 'TIM', count: 3 }]);
    const totals = sqlite.prepare('select doc_count, token_total from bayes_category_totals where category_id = ?').get(coffee) as {
      doc_count: number;
      token_total: number;
    };
    expect(totals).toEqual({ doc_count: 3, token_total: 6 });
  });

  it('maintains the vocabulary size incrementally in settings', () => {
    const { sqlite } = twoCategories();
    expect(getVocabSize()).toBe(4);
    const stored = sqlite.prepare("select value from settings where key = 'bayes_vocab_size'").get() as { value: string };
    expect(stored.value).toBe('4');
    expect(recomputeVocabSize()).toBe(4);
  });

  it('does not double-count a token shared between categories', () => {
    const { groceries } = twoCategories();
    train(['TIM', 'MARKET'], groceries);
    expect(getVocabSize()).toBe(5); // MARKET is new, TIM is not
    expect(recomputeVocabSize()).toBe(5);
  });

  it('ignores an empty token list but still counts the document', () => {
    const { coffee, sqlite } = twoCategories();
    train([], coffee);
    const totals = sqlite.prepare('select doc_count, token_total from bayes_category_totals where category_id = ?').get(coffee) as {
      doc_count: number;
      token_total: number;
    };
    expect(totals).toEqual({ doc_count: 4, token_total: 6 });
  });
});

describe('untrain', () => {
  it('exactly reverses a train', () => {
    const { coffee, sqlite } = twoCategories();
    const before = {
      tokens: sqlite.prepare('select token, category_id, count from bayes_tokens order by token, category_id').all(),
      totals: sqlite.prepare('select * from bayes_category_totals order by category_id').all(),
      vocab: getVocabSize(),
    };
    train(['STARBUCKS', 'CAFE'], coffee);
    untrain(['STARBUCKS', 'CAFE'], coffee);
    expect(sqlite.prepare('select token, category_id, count from bayes_tokens order by token, category_id').all()).toEqual(before.tokens);
    expect(sqlite.prepare('select * from bayes_category_totals order by category_id').all()).toEqual(before.totals);
    expect(getVocabSize()).toBe(before.vocab);
  });

  it('removes a token row when its count reaches zero and shrinks the vocabulary', () => {
    const { coffee, sqlite } = twoCategories();
    train(['ESPRESSO'], coffee);
    expect(getVocabSize()).toBe(5);
    untrain(['ESPRESSO'], coffee);
    const rows = sqlite.prepare("select count(*) as c from bayes_tokens where token = 'ESPRESSO'").get() as { c: number };
    expect(rows.c).toBe(0);
    expect(getVocabSize()).toBe(4);
  });

  it('keeps the vocabulary entry while another category still uses the token', () => {
    const { coffee, groceries } = twoCategories();
    train(['SHARED'], coffee);
    train(['SHARED'], groceries);
    expect(getVocabSize()).toBe(5);
    untrain(['SHARED'], coffee);
    expect(getVocabSize()).toBe(5);
    untrain(['SHARED'], groceries);
    expect(getVocabSize()).toBe(4);
  });

  it('never drives counts or the vocabulary below zero', () => {
    const { coffee } = twoCategories();
    untrain(['NEVER', 'TRAINED'], coffee);
    untrain(['TIM', 'HORTONS'], coffee);
    untrain(['TIM', 'HORTONS'], coffee);
    untrain(['TIM', 'HORTONS'], coffee);
    untrain(['TIM', 'HORTONS'], coffee);
    expect(getVocabSize()).toBeGreaterThanOrEqual(0);
    expect(recomputeVocabSize()).toBe(getVocabSize());
  });
});

describe('classify', () => {
  it('assigns the trained category with a comfortable margin', () => {
    const { coffee } = twoCategories();
    const result = classify(['TIM', 'HORTONS']);
    expect(result).not.toBeNull();
    expect(result!.categoryId).toBe(coffee);
    expect(result!.margin).toBeCloseTo(2.7726, 3);
    expect(BAYES_MARGIN_THRESHOLD).toBe(2.0);
  });

  it('returns null when the margin is below the threshold', () => {
    twoCategories();
    // one token from each category -> perfectly balanced, margin 0
    expect(classify(['TIM', 'METRO'])).toBeNull();
  });

  it('returns null with fewer than two known tokens', () => {
    twoCategories();
    expect(BAYES_MIN_KNOWN_TOKENS).toBe(2);
    expect(classify(['TIM'])).toBeNull();
    expect(classify(['TIM', 'UNSEEN'])).toBeNull();
    expect(classify(['UNSEEN', 'ALSOUNSEEN'])).toBeNull();
    expect(classify([])).toBeNull();
  });

  it('returns null while only one category has been trained', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    for (let i = 0; i < 5; i += 1) train(['TIM', 'HORTONS'], coffee);
    expect(classify(['TIM', 'HORTONS'])).toBeNull();
  });

  it('ignores unknown tokens rather than penalising the whole document', () => {
    const { coffee } = twoCategories();
    expect(classify(['TIM', 'HORTONS', 'ZZZUNSEEN'])?.categoryId).toBe(coffee);
  });

  it('exposes raw scores for diagnostics, ordered best first', () => {
    const { coffee, groceries } = twoCategories();
    const scores = scoreCategories(['TIM', 'HORTONS']);
    expect(scores).toHaveLength(2);
    expect(scores[0].categoryId).toBe(coffee);
    expect(scores[1].categoryId).toBe(groceries);
    expect(scores[0].score).toBeGreaterThan(scores[1].score);
    expect(scores[0].score - scores[1].score).toBeCloseTo(2.7726, 3);
  });

  it('follows the training set after a correction is untrained and retrained', () => {
    const { coffee, groceries } = twoCategories();
    for (let i = 0; i < 6; i += 1) {
      untrain(['TIM', 'HORTONS'], coffee);
      train(['TIM', 'HORTONS'], groceries);
    }
    const result = classify(['TIM', 'HORTONS']);
    expect(result?.categoryId).toBe(groceries);
    // The Laplace-smoothed prior must keep the margin finite even once coffee's
    // doc_count has been driven fully to zero — an unsmoothed log(0/total) would
    // make this Infinity, which defeats the margin threshold and cannot be stored
    // in transactions.confidence (an IEEE Infinity serializes as null in JSON).
    expect(Number.isFinite(result!.margin)).toBe(true);
    expect(result!.margin).toBeCloseTo(2.7849, 3);
  });

  it('gates on DISTINCT known tokens, not instances of a repeated one', () => {
    // tokenize('TIM TIM') would yield ['TIM', 'TIM']: two known-token instances
    // but only one distinct vocabulary hit, which must NOT clear the >=2 gate.
    twoCategories();
    expect(classify(['TIM', 'TIM'])).toBeNull();
  });
});

describe('resetBayes', () => {
  it('wipes every table and the cached vocabulary size', () => {
    const { sqlite } = twoCategories();
    resetBayes();
    expect((sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from bayes_category_totals').get() as { c: number }).c).toBe(0);
    expect(getVocabSize()).toBe(0);
    expect(classify(['TIM', 'HORTONS'])).toBeNull();
  });
});
