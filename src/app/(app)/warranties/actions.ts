'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import BetterSqlite3 from 'better-sqlite3';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { nowIso } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import {
  MAX_RULES_PER_LOAN,
  backfillLoanRule,
  checkLoanBackfill,
  deleteLoanRule,
  listLoanRules,
  saveLoanRule,
} from '@/lib/loans';
import { formatCents, parseAmountToCents } from '@/lib/money';
import {
  attachStagedReceipts,
  countReceiptsWithSha,
  createWarrantyItem,
  deleteWarrantyItem,
  deleteWarrantyReceipt,
  getWarrantyItem,
  getWarrantyReceipt,
  resetReceiptForReOcr,
  updateWarrantyItem,
  warrantyInputSchema,
  type StagedReceiptRef,
} from '@/lib/warranty/items';
import { MAX_FILES_PER_UPLOAD } from '@/lib/warranty/receipts';
import { STAGING_ID_RE } from '@/lib/warranty/staging';
import { findItemType } from '@/lib/warranty/types';
import { ITEM_KIND_LABELS, isBillingCycle, type BillingCycle, type ItemKind } from '@/lib/warranty/constants';

export interface WarrantyActionState {
  error?: string;
  message?: string;
}

/**
 * CROSS_ORIGIN_ERROR is deliberately NOT re-exported here: Next 15 allows only async
 * function exports from a 'use server' file — `next build` fails on any other export from a
 * module carrying this directive, and npm test/typecheck cannot catch that class of error.
 * The canonical string lives in @/lib/auth/csrf (a plain module) and is imported directly by
 * both this file and its test.
 */

/**
 * Warranty items are household-shared (§1.3): every signed-in member may create, edit or
 * delete any item or receipt. owner_user_id is ATTRIBUTION, not access control, so there is
 * deliberately no requireAdmin() anywhere in this file. Changing an item's type is likewise
 * not an admin action (type-deltas.md T8 / MUST-19.15) — only the type LIST is
 * admin-maintained (settings/item-types).
 */

const idField = z.coerce.number().int().positive();

const stagedSchema = z
  .array(
    z.object({
      stagingId: z.string().regex(STAGING_ID_RE),
      originalFilename: z.string().trim().min(1).max(255),
    }),
  )
  // M4: an unbounded array would otherwise reach the write transaction untouched.
  .max(MAX_FILES_PER_UPLOAD);

const UPLOAD_INVALID_ERROR = 'That upload is no longer valid — please choose the files again.';

/**
 * IMPORTANT 2: `JSON.parse` throws a raw SyntaxError ("Unexpected token…") and
 * `stagedSchema.parse` throws a ZodError whose `.message` is a JSON dump — neither is fit to
 * show a user. Both collapse to the same written message here; safeParse (not parse) means
 * a malformed payload never reaches messageOf()/failure()'s generic "is this a real Error"
 * fallback with the wrong text attached.
 */
function readStaged(formData: FormData): StagedReceiptRef[] {
  const raw = String(formData.get('staged') ?? '[]');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(UPLOAD_INVALID_ERROR);
  }
  const parsed = stagedSchema.safeParse(json);
  if (!parsed.success) throw new Error(UPLOAD_INVALID_ERROR);
  return parsed.data;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '');
}

/** '' -> null; anything else must parse as money, as a positive magnitude (§17.26). */
function readPriceCents(formData: FormData): number | null {
  const raw = str(formData, 'price').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('Price is not a number.');
  return Math.abs(cents);
}

/** '' -> null; anything else must be one of the two billing cycle values (§ user request). */
function readBillingCycle(formData: FormData): BillingCycle | null {
  const raw = str(formData, 'billingCycle').trim();
  if (raw.length === 0) return null;
  if (!isBillingCycle(raw)) throw new Error('Billing must be Monthly or Annual.');
  return raw;
}

/** '' -> null; anything else must parse as money, as a non-negative magnitude, same as price. */
function readBillingAmountCents(formData: FormData): number | null {
  const raw = str(formData, 'billingAmount').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('The amount is not a number.');
  return Math.abs(cents);
}

/** '' -> null; anything else must parse as money, as a non-negative magnitude, same as price. */
function readPrincipalCents(formData: FormData): number | null {
  const raw = str(formData, 'principal').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('The original amount is not a number.');
  return Math.abs(cents);
}

/**
 * MUST-14.4: parsed as a decimal PERCENT and stored as BASIS POINTS -- 5.49% is 549. The
 * 0-10000% range is checked here, in zod, and again by the CHECK in 0007.
 * MUST-13.1: this is the only arithmetic the rate is ever subject to, and it is a unit
 * conversion at the form boundary, not a calculation.
 */
function readInterestRateBps(formData: FormData): number | null {
  const raw = str(formData, 'interestRate').trim();
  if (raw.length === 0) return null;
  const percent = Number(raw);
  if (!Number.isFinite(percent)) throw new Error('The interest rate is not a number.');
  if (percent < 0 || percent > 10_000) throw new Error('That rate is out of range.');
  return Math.round(percent * 100);
}

function readBalanceCents(formData: FormData): number | null {
  const raw = str(formData, 'currentBalance').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('The balance is not a number.');
  return Math.abs(cents);
}

function readMonths(formData: FormData): number | null {
  const raw = str(formData, 'warrantyMonths').trim();
  if (raw.length === 0) return null;
  // v1.2.2: kind-agnostic wording -- this validator has no access to (and does not thread
  // through) the selected type's kind, so it can't say "Term" vs "Warranty (months)" per
  // kind. "The term" reads correctly for every kind (warranty/subscription/contract/loan)
  // without hard-coding one of them. Old text was 'Warranty length must be a whole number of
  // months.' -- wrong once a Contract/Loan's form legend says 'Term (months)'.
  if (!/^\d+$/.test(raw)) throw new Error('The term must be a whole number of months.');
  return Number(raw);
}

function readOptionalId(formData: FormData, key: string): number | null {
  const raw = str(formData, key).trim();
  if (raw.length === 0) return null;
  const parsed = idField.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${key}.`);
  return parsed.data;
}

/**
 * Delta T8 (type-deltas.md): '' or 'none' -> null (unclassified, a legitimate value — there
 * is no Uncategorised row); anything else must be a positive integer. Existence against
 * warranty_item_types is checked separately, AFTER this shape check, so a bad id reads as
 * "That item type no longer exists." rather than a generic validation message.
 */
function readTypeId(formData: FormData): number | null {
  const raw = str(formData, 'typeId').trim();
  if (raw.length === 0 || raw === 'none') return null;
  const parsed = idField.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid item type.');
  return parsed.data;
}

function readItemInput(formData: FormData, fallbackOwnerId: number) {
  const owner = readOptionalId(formData, 'ownerUserId') ?? fallbackOwnerId;
  // Hoisted so the anchor written just below can be derived from the SAME parsed value,
  // rather than re-reading (and re-parsing) the balance field a second time.
  const balanceCents = readBalanceCents(formData);
  return warrantyInputSchema(todayIso()).safeParse({
    name: str(formData, 'name'),
    vendor: str(formData, 'vendor'),
    model: str(formData, 'model'),
    serial: str(formData, 'serial'),
    purchaseDate: str(formData, 'purchaseDate'),
    warrantyMonths: readMonths(formData),
    // An HTML checkbox posts 'on' when ticked and nothing at all when not.
    isLifetime: formData.get('isLifetime') !== null,
    priceCents: readPriceCents(formData),
    ownerUserId: owner,
    transactionId: readOptionalId(formData, 'transactionId'),
    typeId: readTypeId(formData),
    notes: str(formData, 'notes'),
    billingCycle: readBillingCycle(formData),
    billingAmountCents: readBillingAmountCents(formData),
    principalCents: readPrincipalCents(formData),
    interestRateBps: readInterestRateBps(formData),
    currentBalanceCents: balanceCents,
    // MUST-11.8: the HUMAN anchor. Written here and NOWHERE else -- never by a matched
    // payment, never by an unassign, never by an import undo. It answers "when did a person
    // last tell us the truth about this balance", which is exactly the question the debt
    // reconstruction needs.
    balanceUpdatedAt: balanceCents === null ? null : nowIso(),
  });
}

/**
 * Delta T8: the type must still exist at write time — a race where an admin deletes an
 * unused type while this form is open. Returning early here (instead of letting the FK
 * throw) means the caller reads a plain readable message instead of a raw SQLite error.
 */
function typeExistsOrNull(typeId: number | null): boolean {
  return typeId === null || findItemType(typeId) !== null;
}

/**
 * MUST-19.11, generalized to success copy: an untyped item (or one whose type lookup somehow
 * misses) reads as a plain warranty, matching the same `?? 'warranty'` fallback the client
 * components use when following the selected/saved type's kind (see the note in
 * warranty-detail-client.tsx and new-warranty-client.tsx).
 */
function kindForTypeId(typeId: number | null): ItemKind {
  return (typeId !== null ? findItemType(typeId)?.kind : undefined) ?? 'warranty';
}

const ITEM_TYPE_MISSING_ERROR = 'That item type no longer exists.';

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * IMPORTANT 2c: ownerUserId and transactionId are only shape-checked by zod (positive
 * integer) — neither is confirmed to exist before the write, so a tampered value (or a
 * genuine race, e.g. the owner's account being deleted between page load and submit) reaches
 * the database and fails its FK constraint. Translate that raw SqliteError into the same
 * kind of written message a precheck would have produced, instead of leaking
 * "FOREIGN KEY constraint failed" through messageOf()'s generic Error branch. Modelled on
 * the identical idiom in settings/item-types/actions.ts's failure().
 */
function failure(error: unknown, fallback: string): WarrantyActionState {
  if (error instanceof BetterSqlite3.SqliteError && error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return { error: 'That person or transaction no longer exists.' };
  }
  return { error: messageOf(error, fallback) };
}

// MUST-14.14: a rule save can move a balance both /transactions and /reports render.
function revalidateAll(itemId?: number): void {
  revalidatePath('/warranties');
  revalidatePath('/dashboard');
  revalidatePath('/transactions');
  revalidatePath('/reports');
  if (itemId !== undefined) revalidatePath(`/warranties/${itemId}`);
}

export async function createWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  // MUST-13.1: origin FIRST, before auth, before validation, before any read.
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  let itemId: number;
  try {
    const staged = readStaged(formData);
    const parsed = readItemInput(formData, user.id);
    // Kind-neutral fallback (MUST-19.11): nothing here has resolved a kind yet at the point a
    // shape-validation error fires, so "item" (not "warranty") is the generic noun -- same
    // reasoning as readMonths()'s "The term" above.
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that item.' };
    if (!typeExistsOrNull(parsed.data.typeId)) return { error: ITEM_TYPE_MISSING_ERROR };
    itemId = createWarrantyItem(parsed.data, staged);
  } catch (error) {
    return failure(error, 'Could not save that item.');
  }

  revalidateAll(itemId);
  // Outside the try: redirect() signals by throwing, and catching it would swallow it.
  redirect(`/warranties/${itemId}`);
}

export async function updateWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };

  let savedKind: ItemKind = 'warranty';
  try {
    const parsed = readItemInput(formData, 0);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that item.' };
    if (!typeExistsOrNull(parsed.data.typeId)) return { error: ITEM_TYPE_MISSING_ERROR };
    if (!updateWarrantyItem(id.data, parsed.data)) return { error: 'That item no longer exists.' };
    // Bug fix (v1.2.4): this used to say "Warranty updated." unconditionally -- wrong for a
    // subscription/contract/loan. The saved type's kind decides the noun, the same fallback
    // the client components use for an untyped item (MUST-19.11, one place per wording rule).
    savedKind = kindForTypeId(parsed.data.typeId);
  } catch (error) {
    return failure(error, 'Could not save that item.');
  }

  revalidateAll(id.data);
  return { message: `${ITEM_KIND_LABELS[savedKind]} updated.` };
}

export async function deleteWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };

  // M5: errors as return values, never thrown to the client — same contract as every other
  // action, even though deleteWarrantyItem's own failure modes are narrow today.
  try {
    if (!deleteWarrantyItem(id.data)) return { error: 'That item no longer exists.' };
  } catch (error) {
    return failure(error, 'Could not delete that item.');
  }

  revalidateAll();
  // Outside the try: redirect() signals by throwing, and catching it would swallow it.
  redirect('/warranties');
}

export async function attachReceiptsAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };
  if (getWarrantyItem(id.data) === null) return { error: 'That item no longer exists.' };

  let attached: number[];
  let duplicate = false;
  try {
    const staged = readStaged(formData);
    attached = attachStagedReceipts(id.data, staged);
    // MUST-6.9: a duplicate digest on the same item WARNS; it never blocks — a duplicate is
    // a user judgement, not an error. Two rows sharing a digest is exactly that case.
    for (const receiptId of attached) {
      const row = getWarrantyReceipt(receiptId);
      if (row && countReceiptsWithSha(id.data, row.sha256) > 1) duplicate = true;
    }
  } catch (error) {
    return failure(error, 'Could not attach that receipt.');
  }

  revalidateAll(id.data);
  if (attached.length === 0) return { error: 'That upload expired — please choose the file again.' };
  return {
    message: duplicate
      ? `Added ${attached.length} receipt(s). This looks like a receipt you already added.`
      : `Added ${attached.length} receipt(s).`,
  };
}

export async function deleteReceiptAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('receiptId'));
  if (!id.success) return { error: 'Invalid request.' };
  const receipt = getWarrantyReceipt(id.data);
  if (receipt === null) return { error: 'That receipt no longer exists.' };

  // M5: errors as return values, never thrown to the client.
  try {
    deleteWarrantyReceipt(id.data);
  } catch (error) {
    return failure(error, 'Could not remove that receipt.');
  }
  revalidateAll(receipt.warrantyItemId);
  return { message: 'Receipt removed.' };
}

export async function reRunOcrAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('receiptId'));
  if (!id.success) return { error: 'Invalid request.' };
  const receipt = getWarrantyReceipt(id.data);
  if (receipt === null) return { error: 'That receipt no longer exists.' };

  // MUST-7.16: idempotent and safe to click repeatedly — a second click on a claimed row
  // is a no-op inside enqueueOcrJob(). M5: errors as return values, never thrown.
  try {
    resetReceiptForReOcr(id.data);
  } catch (error) {
    return failure(error, 'Could not re-run OCR for that receipt.');
  }
  revalidateAll(receipt.warrantyItemId);
  return { message: 'Reading that receipt again — the status will update shortly.' };
}

const RULE_TOO_SHORT = 'Use at least three characters, or this will match almost everything.';
const RULE_LIMIT = 'Five rules per loan is the limit.';
const RULE_DUPLICATE = 'That rule already exists on this loan.';

const loanRuleSchema = z.object({
  itemId: z.coerce.number().int().positive(),
  merchantContains: z.string().trim().min(3, RULE_TOO_SHORT).max(120),
  accountId: z.coerce.number().int().positive().nullable(),
  backfill: z.boolean(),
});

export async function saveLoanRuleAction(_prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const accountRaw = str(formData, 'accountId').trim();
  const parsed = loanRuleSchema.safeParse({
    itemId: str(formData, 'itemId'),
    merchantContains: str(formData, 'merchantContains'),
    accountId: accountRaw.length === 0 ? null : accountRaw,
    backfill: formData.get('backfill') !== null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that rule.' };

  const item = getWarrantyItem(parsed.data.itemId);
  if (!item) return { error: 'That item no longer exists.' };
  if (item.kind !== 'loan') return { error: 'Payment matching only applies to loans.' };
  if (listLoanRules(item.id).length >= MAX_RULES_PER_LOAN) return { error: RULE_LIMIT };

  let ruleId: number;
  try {
    ruleId = saveLoanRule({
      itemId: parsed.data.itemId,
      merchantContains: parsed.data.merchantContains,
      accountId: parsed.data.accountId,
      enabled: true,
    });
  } catch (error) {
    // MUST-14.7: the unique index's message, translated beside the existing FK translation.
    if (error instanceof BetterSqlite3.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { error: RULE_DUPLICATE };
    }
    return failure(error, 'Could not save that rule.');
  }

  let message = 'Rule saved. It will apply to payments that arrive from now on.';
  if (parsed.data.backfill) {
    // MUST-14.12: the ONE loan action with a limit, and the rule is still saved when it is
    // refused -- only the historical pass is skipped.
    const verdict = checkLoanBackfill();
    if (!verdict.allowed) {
      message = 'Rule saved, but the backfill was skipped: too many in the last few minutes.';
    } else {
      const { linked, appliedCents } = backfillLoanRule(ruleId);
      message = `Rule saved. ${linked} past payments linked, ${formatCents(appliedCents)} taken off the balance.`;
    }
  }
  revalidateAll(parsed.data.itemId);
  return { message };
}

export async function deleteLoanRuleAction(formData: FormData): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();
  const parsed = z
    .object({ id: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() })
    .safeParse({ id: formData.get('id'), itemId: formData.get('itemId') });
  if (!parsed.success) return { error: 'Invalid request.' };
  if (!deleteLoanRule(parsed.data.id)) return { error: 'That rule no longer exists.' };
  revalidateAll(parsed.data.itemId);
  return { message: 'Rule removed. Payments already linked are untouched.' };
}
