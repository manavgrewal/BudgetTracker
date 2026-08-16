import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { merchantRules } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { categoryLabel, createCategory, listCategories, type CategoryRecord } from '@/lib/categories';
import { listRules, upsertRuleFromCorrection, type MatchType, type MerchantRuleRecord, type RuleKind } from '@/lib/categorize/rules';
import { importMappingSchema, type ImportMapping } from '@/lib/import/mapping';
import { createProfile, getProfileByName, listProfiles } from '@/lib/import/presets';

export const RULES_PACK_FORMAT = 'budget-tracker-rules';
export const PROFILES_PACK_FORMAT = 'budget-tracker-profiles';
export const PACK_VERSION = 1;

export class PackFormatError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PackFormatError';
  }
}

export interface PackCategory {
  name: string;
  parent: string | null;
  is_income: boolean;
  icon: string | null;
  color: string | null;
}

export interface PackRule {
  pattern: string;
  match_type: MatchType;
  rule_kind: RuleKind;
  category: string | null;
  category_parent: string | null;
}

export interface RulesPack {
  format: typeof RULES_PACK_FORMAT;
  version: number;
  exported_at: string;
  categories: PackCategory[];
  rules: PackRule[];
}

export interface PackProfile {
  name: string;
  institution: string;
  mapping: ImportMapping;
}

export interface ProfilesPack {
  format: typeof PROFILES_PACK_FORMAT;
  version: number;
  exported_at: string;
  profiles: PackProfile[];
}

// ---------------------------------------------------------------- envelopes

/**
 * Controller ruling (a): a rules pack must never carry 'rename' or 'not_transfer'
 * rules — both are local display/override preferences, not shareable categorization
 * knowledge (spec section 11 excludes renames; the post-brief review round added
 * not_transfer for the same reason). On import, an entry with one of these kinds
 * (or any value this install doesn't recognise) is skipped gracefully and counted
 * — it must never fail the whole pack (user-friendliness watch-item from spec review).
 */
const IMPORTABLE_RULE_KINDS: readonly RuleKind[] = ['category', 'transfer'];
function isImportableRuleKind(kind: string): kind is RuleKind {
  return (IMPORTABLE_RULE_KINDS as readonly string[]).includes(kind);
}

const packCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  parent: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v ?? null),
  is_income: z.boolean().optional().transform((v) => v ?? false),
  icon: z.string().max(16).nullable().optional().transform((v) => v ?? null),
  color: z.string().max(32).nullable().optional().transform((v) => v ?? null),
});

// rule_kind and category_parent are documented supersets of the section 11
// example: the example shows the default case only. Both default cleanly, so a
// pack written straight from the spec still imports.
//
// rule_kind deliberately accepts ANY string here (not just 'category' | 'transfer'):
// per controller ruling (a), a pack entry carrying 'rename', 'not_transfer', or some
// value this install has never heard of is not a malformed pack — it's skipped
// gracefully downstream (previewRulesPackImport / importRulesPack), never rejected.
const packRuleSchema = z.object({
  pattern: z.string().trim().min(1).max(200),
  match_type: z.enum(['exact', 'contains']),
  rule_kind: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((v) => (v ?? 'category') as RuleKind),
  category: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v ?? null),
  category_parent: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v ?? null),
});

function checkEnvelope(input: unknown, format: string, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PackFormatError(`This file is not a Budget Tracker ${label} pack (expected a JSON object).`);
  }
  const record = input as Record<string, unknown>;
  if (record.format !== format) {
    throw new PackFormatError(
      `This file is not a Budget Tracker ${label} pack (found format ${JSON.stringify(record.format ?? null)}, expected "${format}").`,
    );
  }
  const version = record.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new PackFormatError(`This ${label} pack has an invalid version (${JSON.stringify(version ?? null)}).`);
  }
  if (version > PACK_VERSION) {
    throw new PackFormatError(
      `This ${label} pack was made by a newer version of Budget Tracker (pack version ${version}; this install understands ${PACK_VERSION}). Update this install first.`,
    );
  }
  return record;
}

const lower = (value: string) => value.trim().toLowerCase();

/**
 * Defensive guard against a hand-crafted (or malicious) pack that declares a
 * category nesting more than two levels deep, or a parent/child cycle. This
 * app's category model is hard-limited to two levels (createCategory throws if
 * asked to create a grandchild); without this check a deep pack would still
 * parse successfully and only blow up later, mid-import, as a raw uncaught
 * Error once the writer reaches the offending row. Rejecting up front, with a
 * clear message, keeps the whole pack format-rejection story consistent.
 */
function assertNoDeepNesting(pack: { categories: PackCategory[]; rules: PackRule[] }): void {
  const declaredParentOf = new Map<string, string>();
  for (const category of pack.categories) {
    if (category.parent !== null) declaredParentOf.set(lower(category.name), category.parent);
  }
  const usedAsParent = new Set<string>();
  for (const category of pack.categories) {
    if (category.parent !== null) usedAsParent.add(lower(category.parent));
  }
  for (const rule of pack.rules) {
    if (rule.category_parent !== null) usedAsParent.add(lower(rule.category_parent));
  }
  for (const parentName of usedAsParent) {
    const grandparent = declaredParentOf.get(parentName);
    if (grandparent !== undefined) {
      throw new PackFormatError(
        `This rules pack nests categories more than two levels deep ("${parentName}" is used as a parent, but is itself declared under "${grandparent}"), which isn't supported.`,
      );
    }
  }
}

export function parseRulesPack(input: unknown): RulesPack {
  const record = checkEnvelope(input, RULES_PACK_FORMAT, 'rules');
  const parsed = z
    .object({
      exported_at: z.string().optional().transform((v) => v ?? ''),
      categories: z.array(packCategorySchema),
      rules: z.array(packRuleSchema),
    })
    .safeParse(record);
  if (!parsed.success) {
    throw new PackFormatError(`This rules pack is malformed: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}.`);
  }
  assertNoDeepNesting(parsed.data);
  return {
    format: RULES_PACK_FORMAT,
    version: record.version as number,
    exported_at: parsed.data.exported_at,
    categories: parsed.data.categories,
    rules: parsed.data.rules,
  };
}

export function parseProfilesPack(input: unknown): ProfilesPack {
  const record = checkEnvelope(input, PROFILES_PACK_FORMAT, 'profiles');
  const parsed = z
    .object({
      exported_at: z.string().optional().transform((v) => v ?? ''),
      profiles: z.array(
        z.object({
          name: z.string().trim().min(1).max(80),
          institution: z.string().trim().min(1).max(80),
          mapping: importMappingSchema,
        }),
      ),
    })
    .safeParse(record);
  if (!parsed.success) {
    throw new PackFormatError(`This profiles pack is malformed: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}.`);
  }
  return {
    format: PROFILES_PACK_FORMAT,
    version: record.version as number,
    exported_at: parsed.data.exported_at,
    profiles: parsed.data.profiles,
  };
}

export function packFilename(format: string, at: Date = new Date()): string {
  return `${format}-${todayIso(at)}.json`;
}

// ------------------------------------------------------------- rules export

export interface RulesExportRow {
  ruleId: number;
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryLabel: string | null;
  hitCount: number;
}

function exportableRules(includeTransferRules: boolean): MerchantRuleRecord[] {
  const rules = listRules();
  return rules.filter((rule) => {
    // Controller ruling (a): rename and not_transfer rules are local-preference
    // kinds and never leave the system, even with the transfer toggle on.
    if (rule.ruleKind === 'rename' || rule.ruleKind === 'not_transfer') return false;
    return rule.ruleKind === 'transfer' ? includeTransferRules : true;
  });
}

export function previewRulesPackExport(opts: { includeTransferRules?: boolean } = {}): RulesExportRow[] {
  const all = listCategories({ includeArchived: true });
  return exportableRules(opts.includeTransferRules === true).map((rule) => ({
    ruleId: rule.id,
    pattern: rule.pattern,
    matchType: rule.matchType,
    ruleKind: rule.ruleKind,
    categoryLabel: rule.categoryId === null ? null : categoryLabel(rule.categoryId, all),
    hitCount: rule.hitCount,
  }));
}

export function exportRulesPack(
  opts: { includeTransferRules?: boolean; excludeRuleIds?: number[]; at?: Date } = {},
): RulesPack {
  const excluded = new Set(opts.excludeRuleIds ?? []);
  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const selected = exportableRules(opts.includeTransferRules === true).filter((rule) => !excluded.has(rule.id));

  const referenced = new Map<string, PackCategory>();
  const remember = (category: CategoryRecord) => {
    const parent = category.parentId === null ? null : byId.get(category.parentId) ?? null;
    const key = `${parent?.name ?? ''}|${category.name}`;
    if (!referenced.has(key)) {
      referenced.set(key, {
        name: category.name,
        parent: parent?.name ?? null,
        is_income: category.isIncome,
        icon: category.icon,
        color: category.color,
      });
    }
    // Emit the parent too so nothing in the pack dangles.
    if (parent) remember(parent);
  };

  const rules: PackRule[] = selected.map((rule) => {
    const category = rule.categoryId === null ? null : byId.get(rule.categoryId) ?? null;
    if (category) remember(category);
    const parent = category?.parentId ? byId.get(category.parentId) ?? null : null;
    return {
      pattern: rule.pattern,
      match_type: rule.matchType,
      rule_kind: rule.ruleKind,
      category: category?.name ?? null,
      category_parent: parent?.name ?? null,
    };
  });

  return {
    format: RULES_PACK_FORMAT,
    version: PACK_VERSION,
    exported_at: nowIso(opts.at ?? new Date()),
    categories: [...referenced.values()],
    rules,
  };
}

// ------------------------------------------------------------- rules import

function findCategory(all: CategoryRecord[], name: string, parentName: string | null): CategoryRecord | null {
  const candidates = all.filter((row) => lower(row.name) === lower(name));
  if (candidates.length === 0) return null;
  if (parentName === null) {
    return candidates.find((row) => row.parentId === null) ?? candidates[0];
  }
  const parent = all.find((row) => lower(row.name) === lower(parentName) && row.parentId === null);
  if (!parent) return candidates.find((row) => row.parentId === null) ?? null;
  return candidates.find((row) => row.parentId === parent.id) ?? null;
}

/** Resolve the parent a rule's category should sit under, using the pack's own category list. */
function resolveParentName(pack: RulesPack, rule: PackRule): string | null {
  if (rule.category_parent !== null) return rule.category_parent;
  if (rule.category === null) return null;
  const entry = pack.categories.find((c) => lower(c.name) === lower(rule.category as string));
  return entry?.parent ?? null;
}

export interface RulesImportConflict {
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  existingCategory: string | null;
  incomingCategory: string | null;
}

export interface RulesImportPlan {
  totalRules: number;
  newRules: number;
  unchanged: number;
  transferRules: number;
  /** Controller ruling (a): entries with an unsupported/unrecognised rule_kind (rename, not_transfer, or anything this install doesn't know) — never written, always counted. */
  skippedRules: number;
  conflicts: RulesImportConflict[];
  newCategories: string[];
}

export function previewRulesPackImport(input: unknown): RulesImportPlan {
  const pack = parseRulesPack(input);
  const all = listCategories({ includeArchived: true });
  const existing = listRules();

  const newCategories: string[] = [];
  const seenNew = new Set<string>();
  const noteCategory = (name: string, parentName: string | null) => {
    if (findCategory(all, name, parentName)) return;
    const key = `${lower(parentName ?? '')}|${lower(name)}`;
    if (seenNew.has(key)) return;
    seenNew.add(key);
    newCategories.push(name);
  };

  for (const category of pack.categories) {
    if (category.parent !== null) noteCategory(category.parent, null);
    noteCategory(category.name, category.parent);
  }

  let newRules = 0;
  let unchanged = 0;
  let transferRules = 0;
  let skippedRules = 0;
  const conflicts: RulesImportConflict[] = [];

  for (const rule of pack.rules) {
    if (!isImportableRuleKind(rule.rule_kind)) {
      skippedRules += 1;
      continue;
    }
    if (rule.rule_kind === 'transfer') transferRules += 1;
    const match = existing.find(
      (row) => row.pattern === rule.pattern && row.matchType === rule.match_type && row.ruleKind === rule.rule_kind,
    );
    if (!match) {
      newRules += 1;
      continue;
    }
    const incoming = rule.category === null ? null : findCategory(all, rule.category, resolveParentName(pack, rule));
    if ((match.categoryId ?? null) === (incoming?.id ?? null)) {
      unchanged += 1;
      continue;
    }
    conflicts.push({
      pattern: rule.pattern,
      matchType: rule.match_type,
      ruleKind: rule.rule_kind,
      existingCategory: match.categoryId === null ? null : categoryLabel(match.categoryId, all),
      incomingCategory: rule.category,
    });
  }

  return { totalRules: pack.rules.length, newRules, unchanged, transferRules, skippedRules, conflicts, newCategories };
}

export interface RulesImportResult {
  rulesAdded: number;
  rulesOverwritten: number;
  rulesKept: number;
  /** Controller ruling (a): entries skipped because their rule_kind isn't importable (rename, not_transfer, or unrecognised). */
  rulesSkipped: number;
  categoriesCreated: number;
}

export function importRulesPack(input: unknown, opts: { onConflict?: 'keep' | 'overwrite' } = {}): RulesImportResult {
  const pack = parseRulesPack(input);
  const onConflict = opts.onConflict ?? 'keep';

  let all = listCategories({ includeArchived: true });
  let categoriesCreated = 0;

  const ensureCategory = (name: string, parentName: string | null, meta?: PackCategory): CategoryRecord => {
    const found = findCategory(all, name, parentName);
    if (found) return found;

    let parentId: number | null = null;
    if (parentName !== null) {
      const parent = findCategory(all, parentName, null);
      if (parent) {
        parentId = parent.id;
      } else {
        const created = ensureCategory(parentName, null);
        parentId = created.id;
      }
    }
    createCategory({
      name: name.trim(),
      parentId,
      icon: meta?.icon ?? null,
      color: meta?.color ?? null,
      isIncome: meta?.is_income ?? false,
    });
    categoriesCreated += 1;
    all = listCategories({ includeArchived: true });
    const created = findCategory(all, name, parentName);
    if (!created) throw new Error(`Failed to create category ${name}`);
    return created;
  };

  // Parents first, then children, so a child never races its parent.
  for (const category of pack.categories.filter((c) => c.parent === null)) {
    ensureCategory(category.name, null, category);
  }
  for (const category of pack.categories.filter((c) => c.parent !== null)) {
    ensureCategory(category.name, category.parent, category);
  }

  const db = getDb();
  let rulesAdded = 0;
  let rulesOverwritten = 0;
  let rulesKept = 0;
  let rulesSkipped = 0;

  for (const rule of pack.rules) {
    if (!isImportableRuleKind(rule.rule_kind)) {
      rulesSkipped += 1;
      continue;
    }

    const parentName = resolveParentName(pack, rule);
    const category = rule.category === null ? null : ensureCategory(rule.category, parentName);

    const existing = db
      .select({ id: merchantRules.id, categoryId: merchantRules.categoryId })
      .from(merchantRules)
      .where(
        and(
          eq(merchantRules.pattern, rule.pattern),
          eq(merchantRules.matchType, rule.match_type),
          eq(merchantRules.ruleKind, rule.rule_kind),
        ),
      )
      .get();

    if (existing) {
      if ((existing.categoryId ?? null) === (category?.id ?? null)) continue;
      if (onConflict === 'keep') {
        rulesKept += 1;
        continue;
      }
      rulesOverwritten += 1;
    } else {
      rulesAdded += 1;
    }

    // Reuse the Task 12 upsert so the unique key stays the single source of truth,
    // then reset the provenance columns: imported rules carry no local history.
    upsertRuleFromCorrection({
      pattern: rule.pattern,
      matchType: rule.match_type,
      ruleKind: rule.rule_kind,
      categoryId: category?.id ?? null,
      createdBy: null,
    });
    db.update(merchantRules)
      .set({ hitCount: 0, lastUsedAt: null })
      .where(
        and(
          eq(merchantRules.pattern, rule.pattern),
          eq(merchantRules.matchType, rule.match_type),
          eq(merchantRules.ruleKind, rule.rule_kind),
        ),
      )
      .run();
  }

  return { rulesAdded, rulesOverwritten, rulesKept, rulesSkipped, categoriesCreated };
}

// ------------------------------------------------------------------ profiles

export interface ProfilesExportRow {
  profileId: number;
  name: string;
  institution: string;
  isBuiltin: boolean;
}

export function previewProfilesPackExport(): ProfilesExportRow[] {
  return listProfiles().map((profile) => ({
    profileId: profile.id,
    name: profile.name,
    institution: profile.institution,
    isBuiltin: profile.isBuiltin,
  }));
}

export function exportProfilesPack(opts: { profileIds?: number[]; at?: Date } = {}): ProfilesPack {
  const wanted = opts.profileIds ? new Set(opts.profileIds) : null;
  const profiles = listProfiles()
    .filter((profile) => (wanted ? wanted.has(profile.id) : true))
    // name, institution and mapping only — pure column-layout knowledge.
    .map((profile) => ({ name: profile.name, institution: profile.institution, mapping: profile.mapping }));

  return {
    format: PROFILES_PACK_FORMAT,
    version: PACK_VERSION,
    exported_at: nowIso(opts.at ?? new Date()),
    profiles,
  };
}

function availableProfileName(name: string): string {
  if (getProfileByName(name) === null) return name;
  let suffix = 2;
  while (getProfileByName(`${name} (${suffix})`) !== null) suffix += 1;
  return `${name} (${suffix})`;
}

export function previewProfilesPackImport(input: unknown): { totalProfiles: number; willRename: { from: string; to: string }[] } {
  const pack = parseProfilesPack(input);
  const willRename: { from: string; to: string }[] = [];
  const taken = new Set(listProfiles().map((p) => p.name));
  for (const profile of pack.profiles) {
    if (!taken.has(profile.name)) {
      taken.add(profile.name);
      continue;
    }
    let suffix = 2;
    while (taken.has(`${profile.name} (${suffix})`)) suffix += 1;
    const renamed = `${profile.name} (${suffix})`;
    taken.add(renamed);
    willRename.push({ from: profile.name, to: renamed });
  }
  return { totalProfiles: pack.profiles.length, willRename };
}

export interface ProfilesImportResult {
  added: { name: string; renamedFrom: string | null }[];
}

export function importProfilesPack(input: unknown): ProfilesImportResult {
  const pack = parseProfilesPack(input);
  const added: { name: string; renamedFrom: string | null }[] = [];
  for (const profile of pack.profiles) {
    const name = availableProfileName(profile.name);
    // Imported profiles are always non-builtin: createProfile hard-codes isBuiltin=false.
    createProfile({ name, institution: profile.institution, mapping: profile.mapping });
    added.push({ name, renamedFrom: name === profile.name ? null : profile.name });
  }
  return { added };
}
