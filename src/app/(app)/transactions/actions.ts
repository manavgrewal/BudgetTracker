'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { getOrCreateCashAccount } from '@/lib/accounts';
import { assignTransactionToLoan, loanLinksForTransactions, unassignTransactionFromLoan } from '@/lib/loans';
import { formatCents, parseAmountToCents } from '@/lib/money';
import { getWarrantyItem } from '@/lib/warranty/items';
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
// never reach attributed_user_id, hence the digits-only check before coercing.
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

  // F12 fix-round: checked BEFORE the generic schema parse so an omitted/blank selection (the
  // client now also guards this with `required`, but a stripped or hand-crafted request can
  // still arrive without it) reads as a friendly prompt rather than zod's generic
  // "Invalid request." -- the same courtesy every other choose-first control in this app owes
  // a person who submitted before picking anything.
  if (String(formData.get('itemId') ?? '').trim().length === 0) return { error: 'Pick a loan first.' };

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
  // combined payment; silence would hide a typo. This still takes priority over the F2 honest
  // amount-and-direction copy below -- a person linking a SECOND loan to the same money needs
  // to know that first, regardless of what happened to either loan's own balance.
  const txn = getTransaction(parsed.data.transactionId);
  const links = loanLinksForTransactions([parsed.data.transactionId]).get(parsed.data.transactionId) ?? [];
  const totalLinked = links.reduce((sum, link) => sum + link.amountCents, 0);
  if (txn !== null && totalLinked > Math.abs(txn.amountCents)) {
    return { message: 'Assigned. Note that this transaction is now linked to more than its own amount.' };
  }

  // F2 fix-round: "Assigned." on its own told a person a click registered, not what it DID to
  // the number on the loan they were looking at -- the whole reason to click this control.
  // txn.amount_cents is immutable (tests/lib/loans/invariants.test.ts), so its sign is a safe
  // read of direction even after the fact; result.appliedCents is the exact, already-clamped
  // figure assignTransactionToLoan moved (or didn't).
  const isPayment = txn !== null && txn.amountCents < 0;
  if (result.appliedCents === 0) {
    const item = getWarrantyItem(parsed.data.itemId);
    return {
      message:
        item !== null && item.currentBalanceCents === null
          ? 'Assigned. The balance was unknown, so it did not move.'
          : 'Assigned. The balance was already $0.00, so nothing came off.',
    };
  }
  if (isPayment) {
    const item = getWarrantyItem(parsed.data.itemId);
    if (item !== null && item.currentBalanceCents === 0) {
      return { message: `Assigned. ${formatCents(result.appliedCents)} came off; the balance is now $0.00.` };
    }
    return { message: `Assigned. ${formatCents(result.appliedCents)} came off the balance.` };
  }
  return { message: `Assigned. The balance went up ${formatCents(result.appliedCents)} (money in).` };
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
  // reflects the link's direction after the loan_payments row is gone (NEW-3).
  const txn = getTransaction(parsed.data.transactionId);

  let unassigned: boolean;
  let appliedCents = 0;
  try {
    // The link's own appliedCents is read here too, inside the SAME try/catch as the
    // reversal itself (NEW-1's guarantee) -- unassignTransactionFromLoan deletes the row and
    // only returns a boolean, so this is the one chance to know how much (if anything)
    // actually moved (F1 fix-round). A residual DB failure on EITHER read must still come
    // back as a normal action error, never a thrown stack trace.
    const linkBefore = (loanLinksForTransactions([parsed.data.transactionId]).get(parsed.data.transactionId) ?? []).find(
      (link) => link.itemId === parsed.data.itemId,
    );
    appliedCents = linkBefore?.appliedCents ?? 0;
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

  // F1 fix-round: a link recorded against an UNKNOWN (or already-zero) balance moved nothing
  // in the first place (link()'s NEW-2 guard) -- claiming the balance "went up/down by exactly
  // what came off it" would be false in exactly the case MUST-11.14's own docblock calls out.
  if (appliedCents === 0) {
    return { message: "Unassigned. That link never moved the balance, so there's nothing to restore." };
  }

  // NEW-3 fix-round: the old message ("gone back up") was FALSE for a disbursement, whose
  // unassign moves the balance back DOWN. Same sign-recovery the engine itself relies on
  // (unassignTransactionFromLoan / reverseLoanLinksForTransactions): negative = a payment, so
  // reversing it raises the balance; positive = a disbursement/adjustment, so reversing it
  // lowers it. F1 fix-round adds the actual amount, matching F2's assign-side voice.
  if (txn !== null && txn.amountCents > 0) {
    return { message: `Unassigned. The balance has gone back down by ${formatCents(appliedCents)}.` };
  }
  return { message: `Unassigned. The balance has gone back up by ${formatCents(appliedCents)}.` };
}
