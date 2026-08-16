'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
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
import { findItemType } from '@/lib/warranty/types';

export interface WarrantyActionState {
  error?: string;
  message?: string;
}

export const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

/**
 * Warranty items are household-shared (§1.3): every signed-in member may create, edit or
 * delete any item or receipt. owner_user_id is ATTRIBUTION, not access control, so there is
 * deliberately no requireAdmin() anywhere in this file. Changing an item's type is likewise
 * not an admin action (type-deltas.md T8 / MUST-19.15) — only the type LIST is
 * admin-maintained (settings/item-types).
 */

const idField = z.coerce.number().int().positive();

const stagedSchema = z.array(
  z.object({
    stagingId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    originalFilename: z.string().trim().min(1).max(255),
  }),
);

function readStaged(formData: FormData): StagedReceiptRef[] {
  const raw = String(formData.get('staged') ?? '[]');
  // A malformed payload fails the whole save rather than committing part of it.
  return stagedSchema.parse(JSON.parse(raw));
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

function readMonths(formData: FormData): number | null {
  const raw = str(formData, 'warrantyMonths').trim();
  if (raw.length === 0) return null;
  if (!/^\d+$/.test(raw)) throw new Error('Warranty length must be a whole number of months.');
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
    return { error: messageOf(error, 'Could not save that warranty.') };
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
    return { error: messageOf(error, 'Could not save that warranty.') };
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
  if (!deleteWarrantyItem(id.data)) return { error: 'That warranty no longer exists.' };

  revalidateAll();
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
    return { error: messageOf(error, 'Could not attach that receipt.') };
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

  deleteWarrantyReceipt(id.data);
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
  // is a no-op inside enqueueOcrJob().
  resetReceiptForReOcr(id.data);
  revalidateAll(receipt.warrantyItemId);
  return { message: 'Reading that receipt again — the status will update shortly.' };
}
