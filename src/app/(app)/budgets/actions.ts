'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { clearBudget, copyBudgetsFromPreviousMonth, resolveBudget, upsertBudget, type BudgetScope } from '@/lib/budgets';
import { isMonthKey } from '@/lib/dates';
import { formatCents, parseAmountToCents } from '@/lib/money';
import { suggestionsFor } from '@/lib/predict/history';

export interface BudgetActionState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
const STALE_SUGGESTION_ERROR = 'That suggestion is no longer available. Reload the page.';

const scopeSchema = z.enum(['household', 'personal']);
const monthSchema = z.string().refine(isMonthKey, { message: 'Month must be YYYY-MM.' });
const categoryIdSchema = z.coerce.number().int().positive();
// '' means "the acting user" for a personal scope; anything else must be a positive integer id.
const userIdField = z.string().trim().refine((v) => v === '' || /^\d+$/.test(v), { message: 'Invalid person selection.' });

export async function setLimitAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const categoryId = categoryIdSchema.safeParse(formData.get('categoryId'));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  const amountRaw = String(formData.get('amount') ?? '').trim();

  if (!scope.success || !month.success || !categoryId.success || !rawUserId.success) {
    return { error: 'Invalid request.' };
  }

  // Members may edit household budgets and their OWN personal budgets (spec section 6).
  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only edit your own personal budgets.' };
  }

  if (amountRaw === '') {
    clearBudget({ scope: scope.data, userId, categoryId: categoryId.data, month: month.data });
    revalidatePath('/budgets');
    return { message: 'Budget cleared from this month forward.' };
  }

  const cents = parseAmountToCents(amountRaw);
  if (cents === null || cents < 0) return { error: 'Enter a positive amount, or leave it blank to clear the budget.' };

  upsertBudget({ scope: scope.data, userId, categoryId: categoryId.data, month: month.data, amountCents: cents });
  revalidatePath('/budgets');
  return { message: 'Budget saved.' };
}

export async function copyPreviousMonthAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !rawUserId.success) return { error: 'Invalid request.' };

  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only copy your own personal budgets.' };
  }

  const copied = copyBudgetsFromPreviousMonth(month.data, scope.data as BudgetScope, userId);
  revalidatePath('/budgets');
  return { message: `Copied ${copied} budgets from the previous month.` };
}

/**
 * MUST-7.4: takes scope, userId, month and categoryId, and NO amount. The suggestion is
 * recomputed server-side from the same inputs the page used, so a crafted request cannot
 * write an arbitrary number through a path labelled "suggestion".
 */
export async function applySuggestionAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const categoryId = categoryIdSchema.safeParse(formData.get('categoryId'));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !categoryId.success || !rawUserId.success) {
    return { error: 'Invalid request.' };
  }

  // MUST-7.6: setLimitAction's rule, verbatim.
  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only edit your own personal budgets.' };
  }

  const result = suggestionsFor({ targetMonth: month.data, scope: scope.data, userId }).byCategory.get(categoryId.data);
  // MUST-7.5: never fall back to a stale number.
  if (result === undefined || !('suggestion' in result)) return { error: STALE_SUGGESTION_ERROR };

  // MUST-7.7: the existing write, so the existing effective-month semantics apply unchanged.
  upsertBudget({
    scope: scope.data,
    userId,
    categoryId: categoryId.data,
    month: month.data,
    amountCents: result.suggestion.suggestedCents,
  });
  revalidatePath('/budgets');
  return { message: `Budget set to ${formatCents(result.suggestion.suggestedCents, { currency: true })} from the suggestion.` };
}

/**
 * MUST-7.8: applies every available suggestion ONLY to categories whose resolved limit for
 * that month is currently null. A category with a limit somebody typed is skipped, always,
 * with no confirmation dialog and no override flag.
 */
export async function applyAllSuggestionsAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !rawUserId.success) return { error: 'Invalid request.' };

  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only edit your own personal budgets.' };
  }

  let set = 0;
  let skipped = 0;
  for (const [categoryId, result] of suggestionsFor({ targetMonth: month.data, scope: scope.data, userId }).byCategory) {
    if (!('suggestion' in result)) continue;
    if (resolveBudget(scope.data as BudgetScope, userId, categoryId, month.data) !== null) {
      skipped += 1;
      continue;
    }
    upsertBudget({ scope: scope.data, userId, categoryId, month: month.data, amountCents: result.suggestion.suggestedCents });
    set += 1;
  }

  revalidatePath('/budgets');
  return { message: `Set ${set} budgets from suggestions. Skipped ${skipped} categories that already had a limit.` };
}
