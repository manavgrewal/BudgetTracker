export type NormalizeFn = (raw: string) => string;
export type TokenizeFn = (normalizedMerchant: string) => string[];
export type UntrainFn = (tokens: string[], categoryId: number) => void;

export interface ImportHooks {
  normalizeMerchant: NormalizeFn;
  tokenize: TokenizeFn;
  untrain: UntrainFn;
}

/**
 * Placeholder implementations so the import pipeline can be built and tested
 * before the categorization engine exists.
 *   Task 11 replaces `normalizeMerchant` with the learning normalizer.
 *   Task 12 replaces `tokenize` and `untrain` with the Bayes implementations.
 */
const DEFAULTS: ImportHooks = {
  normalizeMerchant: (raw) => raw.toUpperCase().replace(/\s+/g, ' ').trim(),
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
