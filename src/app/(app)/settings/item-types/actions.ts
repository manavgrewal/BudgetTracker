'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import BetterSqlite3 from 'better-sqlite3';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import {
  ItemTypeError,
  createItemType,
  deleteItemType,
  itemKindSchema,
  itemTypeNameSchema,
  renameItemType,
  setItemTypeKind,
} from '@/lib/warranty/types';

export interface ItemTypesFormState {
  error?: string;
  message?: string;
}

const PATH = '/settings/item-types';

const typeIdSchema = z.coerce.number().int().positive();

function failure(error: unknown, fallback: string): ItemTypesFormState {
  // ItemTypeError / ItemTypeInUseError messages are written for the admin to read.
  if (error instanceof ItemTypeError) return { error: error.message };
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? fallback };
  // Defense in depth for races the app-layer prechecks in src/lib/warranty/types.ts cannot
  // fully close (e.g. two concurrent creates of the same name, or an item inserted between
  // deleteItemType()'s usage check and its DELETE): translate the raw SQLite constraint into
  // the same wording the precheck would have produced, instead of a driver-level message.
  if (error instanceof BetterSqlite3.SqliteError) {
    if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return { error: 'Items still use this type.' };
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { error: 'A type with that name already exists.' };
  }
  return { error: fallback };
}

export async function createItemTypeAction(
  _prev: ItemTypesFormState,
  formData: FormData,
): Promise<ItemTypesFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ name: itemTypeNameSchema, kind: itemKindSchema })
    .safeParse({ name: formData.get('name') ?? '', kind: formData.get('kind') ?? 'warranty' });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  try {
    const created = createItemType(parsed.data.name, parsed.data.kind);
    revalidatePath(PATH);
    return { message: `Added ${created.name}.` };
  } catch (error) {
    return failure(error, 'Could not add that type.');
  }
}

export async function renameItemTypeAction(
  _prev: ItemTypesFormState,
  formData: FormData,
): Promise<ItemTypesFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ typeId: typeIdSchema, name: itemTypeNameSchema })
    .safeParse({ typeId: formData.get('typeId'), name: formData.get('name') ?? '' });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  try {
    const renamed = renameItemType(parsed.data.typeId, parsed.data.name);
    revalidatePath(PATH);
    return { message: `Renamed to ${renamed.name}.` };
  } catch (error) {
    return failure(error, 'Could not rename that type.');
  }
}

/** Supersedes setSubscriptionAction (v1.2.2): the row control is now a kind <select>. */
export async function setKindAction(
  _prev: ItemTypesFormState,
  formData: FormData,
): Promise<ItemTypesFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ typeId: typeIdSchema, kind: itemKindSchema })
    .safeParse({ typeId: formData.get('typeId'), kind: formData.get('kind') });
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    const updated = setItemTypeKind(parsed.data.typeId, parsed.data.kind);
    revalidatePath(PATH);
    // Every item of this type changes wording immediately -- say so.
    return { message: `${updated.name} is now a ${updated.kind}.` };
  } catch (error) {
    return failure(error, 'Could not update that type.');
  }
}

export async function deleteItemTypeAction(
  _prev: ItemTypesFormState,
  formData: FormData,
): Promise<ItemTypesFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ typeId: typeIdSchema }).safeParse({ typeId: formData.get('typeId') });
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    deleteItemType(parsed.data.typeId);
    revalidatePath(PATH);
    return { message: 'Type deleted.' };
  } catch (error) {
    // ItemTypeInUseError carries the count; failure() passes its message straight through.
    return failure(error, 'Could not delete that type.');
  }
}
