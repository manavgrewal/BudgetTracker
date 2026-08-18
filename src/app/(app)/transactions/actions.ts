'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { getOrCreateCashAccount } from '@/lib/accounts';
import { assignTransactionToLoan, loanLinksForTransactions, unassignTransactionFromLoan } from '@/lib/loans';
import { parseAmountToCents } from '@/lib/money';
import { isIsoDate } from '@/lib/dates';
import {
  bulkSetAttribution,
  bulkSetCategory,
  bulkSetTransfer,
  createManualTransaction,
  getTransaction,
  updateTransactionNotes,
} from '@/lib/transactions';
import { clearCategory, confirmCategory, setTransactionDisplayName, upsertRenameRule } from '@/lib/categorize/engine';

export interface ActionState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

const idList = z
  .string()
  .transform((value) => value.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0));

export async function manualEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const rawAmount = String(formData.get('amount') ?? '');
  const amountCents = parseAmountToCents(rawAmount);
  if (amountCents === null) return { error: 'Amount is not a number.' };

  const direction = String(formData.get('direction') ?? 'spend');
  const signed = direction === 'income' ? Math.abs(amountCents) : -Math.abs(amountCents);

  const accountRaw = String(formData.get('accountId') ?? '');
  const accountId = accountRaw === 'cash' ? getOrCreateCashAccount(user.id, user.name) : Number(accountRaw);

  const date = String(formData.get('date') ?? '');
  if (!isIsoDate(date)) return { error: 'Date must be YYYY-MM-DD.' };

  const categoryRaw = String(formData.get('categoryId') ?? '');
  const attributedRaw = String(formData.get('attributedUserId') ?? '');

  try {
    createManualTransaction({
      accountId,
      date,
      description: String(formData.get('description') ?? ''),
      amountCents: signed,
      categoryId: categoryRaw === '' ? null : Number(categoryRaw),
      attributedUserId: attributedRaw === '' ? null : Number(attributedRaw),
      notes: null,
      userId: user.id,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not save the transaction.' };
  }
  revalidatePath('/transactions');
  return { message: 'Transaction added.' };
}

export async function setCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const transactionId = Number(formData.get('transactionId'));
  const raw = String(formData.get('categoryId') ?? '');
  if (!Number.isInteger(transactionId) || transactionId <= 0) return { error: 'Invalid request.' };

  if (raw === '') clearCategory({ transactionId, userId: user.id });
  else confirmCategory({ transactionId, categoryId: Number(raw), userId: user.id });

  revalidatePath('/transactions');
  revalidatePath('/review');
  return { message: 'Category updated.' };
}

// '' means "household/unattributed"; anything else must be a positive integer user id.
// Number(raw) on a garbage string (e.g. a tampered <select> value) is NaN, which must
// never reach attributed_user_id — hence the digits-only check before coercing.
const attributedUserIdField = z.string().trim().refine((v) => v === '' || /^\d+$/.test(v), { message: 'Invalid person selection.' });

export async function setAttributionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireUser();
  const ids = idList.parse(String(formData.get('ids') ?? ''));
  const parsed = attributedUserIdField.safeParse(String(formData.get('attributedUserId') ?? ''));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid person selection.' };
  bulkSetAttribution(ids, parsed.data === '' ? null : Number(parsed.data));
  revalidatePath('/transactions');
  return { message: `Attribution updated for ${ids.length} transactions.` };
}

export async function bulkCategorizeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const ids = idList.parse(String(formData.get('ids') ?? ''));
  const categoryId = Number(formData.get('categoryId'));
  if (!Number.isInteger(categoryId) || categoryId <= 0) return { error: 'Pick a category first.' };
  const createRules = formData.get('createRules') === 'on';
  const changed = bulkSetCategory(ids, categoryId, user.id, createRules);
  revalidatePath('/transactions');
  revalidatePath('/review');
  return { message: `Categorized ${changed} transactions.` };
}

export async function bulkTransferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const ids = idList.parse(String(formData.get('ids') ?? ''));
  const isTransfer = formData.get('isTransfer') === '1';
  const changed = bulkSetTransfer(ids, isTransfer, user.id);
  revalidatePath('/transactions');
  return { message: `${isTransfer ? 'Marked' : 'Unmarked'} ${changed} transactions as transfers.` };
}

export async function saveNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireUser();
  const parsed = z.object({ transactionId: z.coerce.number().int().positive() }).safeParse({
    transactionId: formData.get('transactionId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };
  if (!getTransaction(parsed.data.transactionId)) return { error: 'That transaction no longer exists.' };

  const note = String(formData.get('notes') ?? '').trim();
  updateTransactionNotes(parsed.data.transactionId, note.length === 0 ? null : note);
  revalidatePath('/transactions');
  return { message: 'Note saved.' };
}

/**
 * Spec v1.4 two-scope rename.
 *   scope = 'one'  -> display_source = 'manual', no rule, never overwritten.
 *   scope = 'all'  -> creates/updates a rename rule on the normalized merchant
 *                     and bulk-applies it to every non-manual matching row.
 * An empty name clears the override and hands the row back to the rules.
 */
export async function renameTransactionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const transactionId = Number(formData.get('transactionId'));
  if (!Number.isInteger(transactionId) || transactionId <= 0) return { error: 'Invalid request.' };

  const row = getTransaction(transactionId);
  if (!row) return { error: 'That transaction no longer exists.' };

  const parsed = z
    .object({ displayName: z.string().trim().max(200), scope: z.enum(['one', 'all']) })
    .safeParse({ displayName: String(formData.get('displayName') ?? ''), scope: String(formData.get('scope') ?? 'one') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };

  if (parsed.data.displayName.length === 0) {
    setTransactionDisplayName({ transactionId, displayDescription: null, userId: user.id });
    revalidatePath('/transactions');
    revalidatePath('/review');
    return { message: 'Display name cleared — showing the bank text again.' };
  }

  if (parsed.data.scope === 'one') {
    setTransactionDisplayName({ transactionId, displayDescription: parsed.data.displayName, userId: user.id });
    revalidatePath('/transactions');
    revalidatePath('/review');
    return { message: 'Renamed this transaction only.' };
  }

  if (row.normalizedMerchant.length === 0) {
    return { error: 'This transaction has no merchant to match on — use "this transaction only".' };
  }
  const result = upsertRenameRule({
    pattern: row.normalizedMerchant,
    matchType: 'exact',
    renameTo: parsed.data.displayName,
    userId: user.id,
  });
  revalidatePath('/transactions');
  revalidatePath('/review');
  revalidatePath('/settings/managers');
  return {
    message: `Renamed ${result.rowsUpdated} matching transaction${result.rowsUpdated === 1 ? '' : 's'} and created a rule for future imports.`,
  };
}

const loanLinkSchema = z.object({
  transactionId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});

/**
 * MUST-13.13: nothing is derived from the client but txnId and itemId, both zod-validated as
 * positive integers and both existence-checked server-side. Warranty items are
 * household-shared with owner_user_id as attribution only, so any signed-in user may assign
 * a transaction to any loan -- the same posture the existing warranty actions take, and a
 * deliberate consistency rather than an oversight.
 *
 * MUST-14.12: no rate limit, consistent with every existing warranty and transaction action.
 */
export async function assignToLoanAction(formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();
  const parsed = loanLinkSchema.safeParse({
    transactionId: formData.get('transactionId'),
    itemId: formData.get('itemId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };

  let result: { linked: boolean; appliedCents: number };
  try {
    result = assignTransactionToLoan({ txnId: parsed.data.transactionId, itemId: parsed.data.itemId });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not assign that transaction.' };
  }
  revalidatePath('/transactions');
  revalidatePath('/dashboard');
  revalidatePath('/reports');
  if (!result.linked) return { message: 'That transaction is already linked to this loan.' };

  // MUST-14.10: over-linking SUCCEEDS and warns. A refusal here would block a legitimate
  // combined payment; silence would hide a typo.
  const txn = getTransaction(parsed.data.transactionId);
  const links = loanLinksForTransactions([parsed.data.transactionId]).get(parsed.data.transactionId) ?? [];
  const linked = links.reduce((sum, link) => sum + link.amountCents, 0);
  if (txn !== null && linked > Math.abs(txn.amountCents)) {
    return { message: 'Assigned. Note that this transaction is now linked to more than its own amount.' };
  }
  return { message: 'Assigned.' };
}

export async function unassignFromLoanAction(formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();
  const parsed = loanLinkSchema.safeParse({
    transactionId: formData.get('transactionId'),
    itemId: formData.get('itemId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };

  // Read BEFORE unassigning: amount_cents is immutable (src/db/schema.ts), so this still
  // reflects the link's direction after the loan_payments row is gone (NEW-3, below).
  const txn = getTransaction(parsed.data.transactionId);

  let unassigned: boolean;
  try {
    unassigned = unassignTransactionFromLoan({ txnId: parsed.data.transactionId, itemId: parsed.data.itemId });
  } catch (error) {
    // NEW-1 fix-round: the reversal itself is now clamped at zero and should not throw in
    // ordinary use, but a residual failure must still come back as a normal action error,
    // never a stack trace.
    return { error: error instanceof Error ? error.message : 'Could not unassign that transaction.' };
  }
  if (!unassigned) return { error: 'That transaction is not linked to this loan.' };

  revalidatePath('/transactions');
  revalidatePath('/dashboard');
  revalidatePath('/reports');

  // NEW-3 fix-round: the old message ("gone back up") was FALSE for a disbursement, whose
  // unassign moves the balance back DOWN. Same sign-recovery the engine itself relies on
  // (unassignTransactionFromLoan / reverseLoanLinksForTransactions): negative = a payment, so
  // reversing it raises the balance; positive = a disbursement/adjustment, so reversing it
  // lowers it.
  if (txn !== null && txn.amountCents > 0) {
    return { message: 'Unassigned. The balance has gone back down by exactly what came off it.' };
  }
  return { message: 'Unassigned. The balance has gone back up by exactly what came off it.' };
}
