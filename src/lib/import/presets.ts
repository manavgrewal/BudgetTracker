import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, importProfiles } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { parseImportMapping, serializeImportMapping, type ImportMapping } from './mapping';

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
      // Real export (fixture-validated 2026-08-16): quote-all fields, LF-only, ISO date.
      dateFormat: 'YYYY-MM-DD',
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
  // The two TD presets shipped with byte-identical mappings originally, which read as a
  // copy-paste slip. They are no longer identical and the difference is real, not a typo:
  // the chequing/debit export is ISO-dated (fixture-validated above) while the Visa export
  // is MM/DD/YYYY. Everything else genuinely does match — same headerless four-column
  // debit/credit layout — so keep both entries rather than aliasing one to the other.
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
      // Real export (fixture-validated 2026-08-16): 17 columns, "DD Mon YYYY" dates —
      // dates.ts's 'DD-MMM-YYYY' regex already accepts the space-separated form.
      dateFormat: 'DD-MMM-YYYY',
      // Real column order pushes Description/Amount right of the preset's original
      // guess: Date, Date Processed, Description, Card Member, Account #, Amount, ...
      descCols: [2],
      amountMode: 'signed',
      amountCol: 5,
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

// ---- appended in Task 8 ----

export interface ProfileRecord {
  id: number;
  name: string;
  institution: string;
  isBuiltin: boolean;
  mapping: ImportMapping;
}

function toRecord(row: { id: number; name: string; institution: string; isBuiltin: boolean; mapping: string }): ProfileRecord {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    isBuiltin: row.isBuiltin,
    mapping: parseImportMapping(row.mapping),
  };
}

export function listProfiles(): ProfileRecord[] {
  return getDb().select().from(importProfiles).orderBy(importProfiles.id).all().map(toRecord);
}

export function getProfile(profileId: number): ProfileRecord | null {
  const row = getDb().select().from(importProfiles).where(eq(importProfiles.id, profileId)).get();
  return row ? toRecord(row) : null;
}

export function getProfileByName(name: string): ProfileRecord | null {
  const row = getDb().select().from(importProfiles).where(eq(importProfiles.name, name)).get();
  return row ? toRecord(row) : null;
}

export function createProfile(input: { name: string; institution: string; mapping: ImportMapping }): number {
  const row = getDb()
    .insert(importProfiles)
    .values({
      name: input.name,
      institution: input.institution,
      isBuiltin: false,
      mapping: serializeImportMapping(input.mapping),
      createdAt: nowIso(),
    })
    .returning({ id: importProfiles.id })
    .get();
  return row.id;
}

export function updateProfileMapping(profileId: number, mapping: ImportMapping): void {
  const existing = getProfile(profileId);
  if (!existing) throw new Error(`No import profile ${profileId}`);
  if (existing.isBuiltin) {
    throw new Error('Built-in profiles are shared and cannot be edited in place — fork it instead');
  }
  getDb()
    .update(importProfiles)
    .set({ mapping: serializeImportMapping(mapping) })
    .where(eq(importProfiles.id, profileId))
    .run();
}

export function mappingsEqual(a: ImportMapping, b: ImportMapping): boolean {
  return serializeImportMapping(a) === serializeImportMapping(b);
}

/**
 * Copy-on-write (spec section 3): the first time a user adjusts a built-in profile's
 * mapping at preview, fork it into a new profile named after the account.
 * Non-built-in profiles are edited in place.
 */
export function forkProfileIfBuiltin(input: { profileId: number; accountName: string; mapping: ImportMapping }): number {
  const existing = getProfile(input.profileId);
  if (!existing) throw new Error(`No import profile ${input.profileId}`);
  if (mappingsEqual(existing.mapping, input.mapping)) return existing.id;

  if (!existing.isBuiltin) {
    updateProfileMapping(existing.id, input.mapping);
    return existing.id;
  }

  let name = `${existing.name} (${input.accountName})`;
  let suffix = 1;
  while (getProfileByName(name) !== null) {
    suffix += 1;
    name = `${existing.name} (${input.accountName}) ${suffix}`;
  }
  return createProfile({ name, institution: existing.institution, mapping: input.mapping });
}

export function setAccountProfile(accountId: number, profileId: number): void {
  getDb().update(accounts).set({ importProfileId: profileId }).where(eq(accounts.id, accountId)).run();
}
