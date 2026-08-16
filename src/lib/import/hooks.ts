import { untrain as bayesUntrain } from '@/lib/categorize/bayes';
import { normalizeMerchant as learningNormalizeMerchant, tokenize as learningTokenize } from '@/lib/categorize/normalize';

export type NormalizeFn = (raw: string) => string;
export type TokenizeFn = (normalizedMerchant: string) => string[];
export type UntrainFn = (tokens: string[], categoryId: number) => void;

export interface ImportHooks {
  normalizeMerchant: NormalizeFn;
  tokenize: TokenizeFn;
  untrain: UntrainFn;
}

/**
 * Final wiring. The indirection stays so `undoImport` can be tested with a spy
 * (see tests/lib/import/undo.test.ts) without reaching into the Bayes tables.
 */
const DEFAULTS: ImportHooks = {
  normalizeMerchant: learningNormalizeMerchant,
  tokenize: learningTokenize,
  untrain: bayesUntrain,
};

let hooks: ImportHooks = { ...DEFAULTS };

export function getImportHooks(): ImportHooks {
  return hooks;
}

export function setImportHooks(partial: Partial<ImportHooks>): void {
  hooks = { ...hooks, ...partial };
}

export function resetImportHooks(): void {
  hooks = { ...DEFAULTS };
}
