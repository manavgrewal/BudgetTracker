'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import BetterSqlite3 from 'better-sqlite3';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { todayIso } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';
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
import { isBillingCycle, type BillingCycle } from '@/lib/warranty/constants';

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

function revalidateAll(itemId?: number): void {
  revalidatePath('/warranties');
  revalidatePath('/dashboard');
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
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that warranty.' };
    if (!typeExistsOrNull(parsed.data.typeId)) return { error: ITEM_TYPE_MISSING_ERROR };
    itemId = createWarrantyItem(parsed.data, staged);
  } catch (error) {
    return failure(error, 'Could not save that warranty.');
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

  try {
    const parsed = readItemInput(formData, 0);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that warranty.' };
    if (!typeExistsOrNull(parsed.data.typeId)) return { error: ITEM_TYPE_MISSING_ERROR };
    if (!updateWarrantyItem(id.data, parsed.data)) return { error: 'That warranty no longer exists.' };
  } catch (error) {
    return failure(error, 'Could not save that warranty.');
  }

  revalidateAll(id.data);
  return { message: 'Warranty updated.' };
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
    if (!deleteWarrantyItem(id.data)) return { error: 'That warranty no longer exists.' };
  } catch (error) {
    return failure(error, 'Could not delete that warranty.');
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
  if (getWarrantyItem(id.data) === null) return { error: 'That warranty no longer exists.' };

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
