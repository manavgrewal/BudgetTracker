import { describe, it, expect } from 'vitest';
import { parseImportMapping, serializeImportMapping, importMappingSchema } from '@/lib/import/mapping';
import { BUILTIN_PRESETS, BUILTIN_PRESET_NAMES, getBuiltinPreset } from '@/lib/import/presets';

describe('importMappingSchema', () => {
  it('accepts every built-in preset', () => {
    for (const name of BUILTIN_PRESET_NAMES) {
      expect(() => importMappingSchema.parse(getBuiltinPreset(name))).not.toThrow();
    }
  });

  it('round-trips through JSON', () => {
    const mapping = getBuiltinPreset('Amex Canada');
    expect(parseImportMapping(serializeImportMapping(mapping))).toEqual(mapping);
  });

  it('rejects signed mode without an amount column', () => {
    const broken = { ...getBuiltinPreset('Amex Canada'), amountCol: null };
    expect(() => parseImportMapping(broken)).toThrowError(/amountCol is required/);
  });

  it('rejects debit_credit mode with no debit and no credit column', () => {
    const broken = { ...getBuiltinPreset('TD Visa'), debitCol: null, creditCol: null };
    expect(() => parseImportMapping(broken)).toThrowError(/debitCol or creditCol is required/);
  });

  it('rejects an empty descCols list', () => {
    const broken = { ...getBuiltinPreset('TD Visa'), descCols: [] };
    expect(() => parseImportMapping(broken)).toThrow();
  });

  it('pins the four built-in preset shapes from spec section 3', () => {
    expect(BUILTIN_PRESETS['TD Chequing/Debit'].mapping.amountMode).toBe('debit_credit');
    expect(BUILTIN_PRESETS['TD Visa'].mapping.hasHeader).toBe(false);
    expect(BUILTIN_PRESETS['Scotiabank Chequing/Debit'].mapping.signConvention).toBe('negative_is_spend');
    expect(BUILTIN_PRESETS['Amex Canada'].mapping.signConvention).toBe('positive_is_spend');
    expect(BUILTIN_PRESETS['Amex Canada'].mapping.hasHeader).toBe(true);
  });
});
