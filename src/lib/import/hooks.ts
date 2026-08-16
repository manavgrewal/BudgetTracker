import { normalizeMerchant as learningNormalizeMerchant } from '@/lib/categorize/normalize';

export type NormalizeFn = (raw: string) => string;
export type TokenizeFn = (normalizedMerchant: string) => string[];
export type UntrainFn = (tokens: string[], categoryId: number) => void;

export interface ImportHooks {
  normalizeMerchant: NormalizeFn;
  tokenize: TokenizeFn;
  untrain: UntrainFn;
}

/** Task 12 replaces `tokenize` and `untrain` with the Bayes implementations. */
const DEFAULTS: ImportHooks = {
  normalizeMerchant: learningNormalizeMerchant,
  tokenize: (normalized) => normalized.split(/[^0-9A-Za-zÀ-ÿ]+/u).filter((t) => t.length > 1),
  untrain: () => {},
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
