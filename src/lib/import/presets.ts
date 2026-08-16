import type { ImportMapping } from './mapping';

export const BUILTIN_PRESET_NAMES = [
  'TD Chequing/Debit',
  'TD Visa',
  'Scotiabank Chequing/Debit',
  'Amex Canada',
] as const;

export type BuiltinPresetName = (typeof BUILTIN_PRESET_NAMES)[number];

export interface BuiltinPreset {
  name: BuiltinPresetName;
  institution: string;
  mapping: ImportMapping;
}

/**
 * Best-effort defaults (spec section 3). Every FIRST import of an account runs the
 * preview step, where the user confirms or edits the mapping; editing a built-in
 * forks it into a per-account profile (copy-on-write, Task 8).
 */
export const BUILTIN_PRESETS: Record<BuiltinPresetName, BuiltinPreset> = {
  'TD Chequing/Debit': {
    name: 'TD Chequing/Debit',
    institution: 'TD Canada Trust',
    mapping: {
      hasHeader: false,
      headerRows: 0,
      dateCol: 0,
      dateFormat: 'MM/DD/YYYY',
      descCols: [1],
      amountMode: 'debit_credit',
      amountCol: null,
      debitCol: 2,
      creditCol: 3,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
    },
  },
  'TD Visa': {
    name: 'TD Visa',
    institution: 'TD Canada Trust',
    mapping: {
      hasHeader: false,
      headerRows: 0,
      dateCol: 0,
      dateFormat: 'MM/DD/YYYY',
      descCols: [1],
      amountMode: 'debit_credit',
      amountCol: null,
      debitCol: 2,
      creditCol: 3,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
    },
  },
  'Scotiabank Chequing/Debit': {
    name: 'Scotiabank Chequing/Debit',
    institution: 'Scotiabank',
    mapping: {
      hasHeader: false,
      headerRows: 0,
      dateCol: 0,
      dateFormat: 'MM/DD/YYYY',
      descCols: [3],
      amountMode: 'signed',
      amountCol: 1,
      debitCol: null,
      creditCol: null,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
    },
  },
  'Amex Canada': {
    name: 'Amex Canada',
    institution: 'American Express Canada',
    mapping: {
      hasHeader: true,
      headerRows: 1,
      dateCol: 0,
      dateFormat: 'MM/DD/YYYY',
      descCols: [1],
      amountMode: 'signed',
      amountCol: 2,
      debitCol: null,
      creditCol: null,
      // Amex reports charges as POSITIVE numbers.
      signConvention: 'positive_is_spend',
      encoding: 'auto',
      skipRules: null,
    },
  },
};

export function getBuiltinPreset(name: BuiltinPresetName): ImportMapping {
  return BUILTIN_PRESETS[name].mapping;
}
