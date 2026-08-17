import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { warrantyItemTypes, warrantyItems } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { ITEM_KINDS, type ItemKind } from '@/lib/warranty/constants';

export interface ItemType {
  id: number;
  name: string;
  isSubscription: boolean;
  kind: ItemKind;
  createdAt: string;
}

export interface ItemTypeWithUsage extends ItemType {
  usageCount: number;
}

/** Spec section 19.2: trimmed, 1-60 characters. The CHECK in 0003 is the backstop. */
export const itemTypeNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(60, 'Name must be at most 60 characters');

/** v1.2.2: warranty / subscription / contract / loan. The CHECK in 0004 is the backstop. */
export const itemKindSchema = z.enum(ITEM_KINDS);

const idSchema = z.number().int().positive();

export class ItemTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemTypeError';
  }
}

/**
 * MUST-19.5: deleting a type that items still use is refused in the app layer, with the
 * count, so the admin is told what to do instead. The FK's default NO ACTION is only the
 * backstop underneath this (MUST-19.6).
 */
export class ItemTypeInUseError extends ItemTypeError {
  readonly typeId: number;
  readonly count: number;

  constructor(typeId: number, count: number) {
    super(
      `${count} ${count === 1 ? 'item uses' : 'items use'} this type. ` +
        'Change their type first, or rename this one.',
    );
    this.name = 'ItemTypeInUseError';
    this.typeId = typeId;
    this.count = count;
  }
}

const COLUMNS = {
  id: warrantyItemTypes.id,
  name: warrantyItemTypes.name,
  isSubscription: warrantyItemTypes.isSubscription,
  kind: warrantyItemTypes.kind,
  createdAt: warrantyItemTypes.createdAt,
} as const;

/** Ordered the way the dropdown and the admin table show it: case-insensitively by name. */
export function listItemTypes(): ItemType[] {
  return getDb()
    .select(COLUMNS)
    .from(warrantyItemTypes)
    .orderBy(sql`${warrantyItemTypes.name} collate nocase`)
    .all();
}

export function listItemTypesWithUsage(): ItemTypeWithUsage[] {
  return getDb()
    .select({
      ...COLUMNS,
      // Both tables have a column literally named "id" / "type_id" == "id" -- drizzle
      // renders ${warrantyItems.typeId} / ${warrantyItemTypes.id} inside this nested sql
      // template WITHOUT table qualifiers, so the naive form self-joins warranty_items to
      // its own id instead of correlating to the outer row. Hand-qualify both sides.
      usageCount: sql<number>`(select count(*) from warranty_items wi where wi.type_id = warranty_item_types.id)`,
    })
    .from(warrantyItemTypes)
    .orderBy(sql`${warrantyItemTypes.name} collate nocase`)
    .all();
}

export function findItemType(id: number): ItemType | null {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return null;
  return getDb().select(COLUMNS).from(warrantyItemTypes).where(eq(warrantyItemTypes.id, parsed.data)).get() ?? null;
}

/**
 * Pre-check for the COLLATE NOCASE unique index, so the admin reads
 * "A type called 'Laptop' already exists." instead of a raw SQLite message.
 * `exceptId` lets a rename keep its own row (including a pure case change).
 */
function findByNameCaseInsensitive(name: string, exceptId?: number): ItemType | null {
  const row = getDb()
    .select(COLUMNS)
    .from(warrantyItemTypes)
    .where(sql`${warrantyItemTypes.name} = ${name} collate nocase`)
    .get();
  if (!row) return null;
  if (exceptId !== undefined && row.id === exceptId) return null;
  return row;
}

function requireType(id: number): ItemType {
  const found = findItemType(id);
  if (!found) throw new ItemTypeError('That item type no longer exists.');
  return found;
}

export function createItemType(name: string, kind: ItemKind): ItemType {
  const clean = itemTypeNameSchema.parse(name);
  const cleanKind = itemKindSchema.parse(kind);
  const clash = findByNameCaseInsensitive(clean);
  if (clash) throw new ItemTypeError(`A type called "${clash.name}" already exists.`);
  return getDb()
    .insert(warrantyItemTypes)
    // is_subscription is derived from kind and kept in lockstep on every write (v1.2.2) --
    // see the docblock on warrantyItemTypes in src/db/schema.ts.
    .values({ name: clean, kind: cleanKind, isSubscription: cleanKind === 'subscription', createdAt: nowIso() })
    .returning(COLUMNS)
    .get();
}

/** MUST-19.7: always allowed, even while the type is in use -- the name lives in one place. */
export function renameItemType(id: number, name: string): ItemType {
  const typeId = idSchema.parse(id);
  requireType(typeId);
  const clean = itemTypeNameSchema.parse(name);
  const clash = findByNameCaseInsensitive(clean, typeId);
  if (clash) throw new ItemTypeError(`A type called "${clash.name}" already exists.`);
  return getDb()
    .update(warrantyItemTypes)
    .set({ name: clean })
    .where(eq(warrantyItemTypes.id, typeId))
    .returning(COLUMNS)
    .get();
}

/**
 * MUST-19.7: takes effect immediately on every item of this type -- that is the point.
 * Supersedes setItemTypeSubscription (v1.2.2): `isSubscription` is derived from `kind` and
 * written in the same statement, so it never drifts out of sync with it.
 */
export function setItemTypeKind(id: number, kind: ItemKind): ItemType {
  const typeId = idSchema.parse(id);
  requireType(typeId);
  const cleanKind = itemKindSchema.parse(kind);
  return getDb()
    .update(warrantyItemTypes)
    .set({ kind: cleanKind, isSubscription: cleanKind === 'subscription' })
    .where(eq(warrantyItemTypes.id, typeId))
    .returning(COLUMNS)
    .get();
}

export function typeUsageCount(id: number): number {
  const typeId = idSchema.parse(id);
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(warrantyItems)
    .where(eq(warrantyItems.typeId, typeId))
    .get();
  return row?.c ?? 0;
}

export function deleteItemType(id: number): void {
  const typeId = idSchema.parse(id);
  requireType(typeId);
  const used = typeUsageCount(typeId);
  if (used > 0) throw new ItemTypeInUseError(typeId, used);
  getDb().delete(warrantyItemTypes).where(eq(warrantyItemTypes.id, typeId)).run();
}
