'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { archiveCategory, createCategory, renameCategory } from '@/lib/categories';
import { deleteRule, listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { deleteRenameRule, upsertRenameRule } from '@/lib/categorize/engine';
import { createProfile, deleteProfile, getProfile, updateProfileMapping } from '@/lib/import/presets';
import { importMappingSchema } from '@/lib/import/mapping';

export interface ManagerState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

export async function createCategoryAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ name: z.string().trim().min(1, 'Name is required').max(60), parentId: z.string() })
    .safeParse({ name: formData.get('name') ?? '', parentId: String(formData.get('parentId') ?? '') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  try {
    createCategory({ name: parsed.data.name, parentId: parsed.data.parentId === '' ? null : Number(parsed.data.parentId) });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the category.' };
  }
  revalidatePath('/settings/managers');
  return { message: 'Category created.' };
}

export async function renameCategoryAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const id = Number(formData.get('categoryId'));
  const name = String(formData.get('name') ?? '').trim();
  if (!Number.isInteger(id) || id <= 0 || name.length === 0) return { error: 'Invalid request.' };
  renameCategory(id, name);
  revalidatePath('/settings/managers');
  return { message: 'Category renamed.' };
}

/** Archive only — transactions, rules and budgets reference categories forever. */
export async function archiveCategoryAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const id = Number(formData.get('categoryId'));
  const archived = formData.get('archived') === '1';
  if (!Number.isInteger(id) || id <= 0) return { error: 'Invalid request.' };
  archiveCategory(id, archived);
  revalidatePath('/settings/managers');
  return { message: archived ? 'Category archived.' : 'Category restored.' };
}

export async function updateRuleAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const admin = await requireAdmin();
  const parsed = z
    .object({
      pattern: z.string().trim().min(1).max(200),
      matchType: z.enum(['exact', 'contains']),
      // 'not_transfer' added post-brief (controller ruling c): an exact-match-only
      // override that undoes a card-payment pattern's auto-transfer-flag for one merchant.
      ruleKind: z.enum(['category', 'transfer', 'rename', 'not_transfer']),
      categoryId: z.string(),
      renameTo: z.string().trim().max(200),
    })
    .safeParse({
      pattern: formData.get('pattern') ?? '',
      matchType: formData.get('matchType') ?? 'exact',
      ruleKind: formData.get('ruleKind') ?? 'category',
      categoryId: String(formData.get('categoryId') ?? ''),
      renameTo: String(formData.get('renameTo') ?? ''),
    });
  if (!parsed.success) return { error: 'Invalid rule.' };

  // Rename rules go through the engine so the change is applied retroactively.
  if (parsed.data.ruleKind === 'rename') {
    if (parsed.data.renameTo.length === 0) return { error: 'A rename rule needs a display name.' };
    const result = upsertRenameRule({
      pattern: parsed.data.pattern,
      matchType: parsed.data.matchType,
      renameTo: parsed.data.renameTo,
      userId: admin.id,
    });
    revalidatePath('/settings/managers');
    revalidatePath('/transactions');
    return { message: `Rename rule saved and applied to ${result.rowsUpdated} transaction${result.rowsUpdated === 1 ? '' : 's'}.` };
  }

  upsertRuleFromCorrection({
    pattern: parsed.data.pattern,
    matchType: parsed.data.matchType,
    ruleKind: parsed.data.ruleKind,
    categoryId:
      parsed.data.ruleKind === 'transfer' || parsed.data.ruleKind === 'not_transfer' || parsed.data.categoryId === ''
        ? null
        : Number(parsed.data.categoryId),
    createdBy: admin.id,
  });
  revalidatePath('/settings/managers');
  return { message: 'Rule saved.' };
}

export async function deleteRuleAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ ruleId: z.coerce.number().int().positive() }).safeParse({ ruleId: formData.get('ruleId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const target = listRules().find((rule) => rule.id === parsed.data.ruleId);
  if (!target) return { error: 'That rule no longer exists.' };

  // Deleting a rename rule must also clear the rows it set (spec section 4).
  if (target.ruleKind === 'rename') {
    const result = deleteRenameRule({ pattern: target.pattern, matchType: target.matchType });
    revalidatePath('/settings/managers');
    revalidatePath('/transactions');
    return { message: `Rename rule deleted; ${result.rowsCleared} transaction${result.rowsCleared === 1 ? '' : 's'} went back to the bank text.` };
  }

  deleteRule(target.id);
  revalidatePath('/settings/managers');
  return { message: 'Rule deleted.' };
}

export async function saveProfileMappingAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const profileId = Number(formData.get('profileId'));
  const mapping = importMappingSchema.safeParse(JSON.parse(String(formData.get('mapping') ?? '{}')));
  if (!Number.isInteger(profileId) || !mapping.success) return { error: 'Invalid mapping.' };
  const profile = getProfile(profileId);
  if (!profile) return { error: 'Unknown profile.' };
  if (profile.isBuiltin) {
    // Built-ins are shared rows and are never mutated in place — fork instead.
    createProfile({ name: `${profile.name} (custom)`, institution: profile.institution, mapping: mapping.data });
    revalidatePath('/settings/managers');
    return { message: `Built-in profiles cannot be edited. Saved a copy named "${profile.name} (custom)".` };
  }
  updateProfileMapping(profileId, mapping.data);
  revalidatePath('/settings/managers');
  return { message: 'Profile updated.' };
}

/** Admin-only (PENDING-FIXES.md #2). deleteProfile() itself refuses a built-in or an
 *  in-use profile; this just turns that refusal into a form message like its siblings. */
export async function deleteProfileAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const profileId = Number(formData.get('profileId'));
  if (!Number.isInteger(profileId) || profileId <= 0) return { error: 'Invalid request.' };
  try {
    deleteProfile(profileId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not delete that profile.' };
  }
  revalidatePath('/settings/managers');
  return { message: 'Profile deleted.' };
}
