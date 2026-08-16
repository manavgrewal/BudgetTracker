import { eq, sql } from 'drizzle-orm';
import { nowIso } from '@/lib/clock';
import { serializeImportMapping } from '@/lib/import/mapping';
import { BUILTIN_PRESETS, BUILTIN_PRESET_NAMES } from '@/lib/import/presets';
import type { Db } from './client';
import { categories, importProfiles } from './schema';

export interface SeedCategory {
  name: string;
  isIncome: boolean;
  icon: string;
  color: string;
  children: string[];
}

/** Spec section 3. Transfers are a flag, not a category. Uncategorized is NULL, not a category. */
export const SEED_CATEGORIES: SeedCategory[] = [
  { name: 'Income', isIncome: true, icon: '💵', color: '#16a34a', children: ['Salary', 'Other Income'] },
  {
    name: 'Housing',
    isIncome: false,
    icon: '🏠',
    color: '#0ea5e9',
    children: ['Rent/Mortgage', 'Property Tax', 'Home Insurance', 'Utilities', 'Internet & Phone'],
  },
  { name: 'Food', isIncome: false, icon: '🍽️', color: '#f97316', children: ['Groceries', 'Restaurants', 'Coffee'] },
  {
    name: 'Transport',
    isIncome: false,
    icon: '🚗',
    color: '#6366f1',
    children: ['Gas', 'Car Payment', 'Car Insurance', 'Maintenance', 'Transit', 'Parking'],
  },
  { name: 'Shopping', isIncome: false, icon: '🛍️', color: '#ec4899', children: ['Clothing', 'Electronics', 'General'] },
  { name: 'Health', isIncome: false, icon: '🩺', color: '#14b8a6', children: ['Pharmacy', 'Dental', 'Fitness'] },
  {
    name: 'Personal',
    isIncome: false,
    icon: '🎧',
    color: '#a855f7',
    children: ['Subscriptions', 'Entertainment', 'Gifts', 'Travel'],
  },
  { name: 'Kids', isIncome: false, icon: '🧸', color: '#eab308', children: [] },
  { name: 'Fees', isIncome: false, icon: '🏦', color: '#64748b', children: ['Bank Fees', 'Interest'] },
];

/** Idempotent: uses the categories_name_parent_uq index to skip existing rows. */
export function seedCategories(db: Db): number {
  let inserted = 0;
  let sortOrder = 0;
  const createdAt = nowIso();

  for (const parent of SEED_CATEGORIES) {
    const existingParent = db
      .select({ id: categories.id })
      .from(categories)
      .where(sql`${categories.name} = ${parent.name} and ${categories.parentId} is null`)
      .get();

    let parentId: number;
    if (existingParent) {
      parentId = existingParent.id;
    } else {
      const row = db
        .insert(categories)
        .values({
          name: parent.name,
          parentId: null,
          icon: parent.icon,
          color: parent.color,
          isIncome: parent.isIncome,
          isArchived: false,
          sortOrder: sortOrder,
        })
        .returning({ id: categories.id })
        .get();
      parentId = row.id;
      inserted += 1;
    }
    sortOrder += 100;

    let childOrder = 1;
    for (const childName of parent.children) {
      const existingChild = db
        .select({ id: categories.id })
        .from(categories)
        .where(sql`${categories.name} = ${childName} and ${categories.parentId} = ${parentId}`)
        .get();
      if (!existingChild) {
        db.insert(categories)
          .values({
            name: childName,
            parentId,
            icon: parent.icon,
            color: parent.color,
            isIncome: parent.isIncome,
            isArchived: false,
            sortOrder: sortOrder - 100 + childOrder,
          })
          .run();
        inserted += 1;
      }
      childOrder += 1;
    }
  }
  void createdAt;
  return inserted;
}

/** Idempotent: built-in profiles are shared rows and are never mutated in place. */
export function seedImportProfiles(db: Db): number {
  let inserted = 0;
  for (const name of BUILTIN_PRESET_NAMES) {
    const preset = BUILTIN_PRESETS[name];
    const existing = db
      .select({ id: importProfiles.id })
      .from(importProfiles)
      .where(eq(importProfiles.name, preset.name))
      .get();
    if (existing) continue;
    db.insert(importProfiles)
      .values({
        name: preset.name,
        institution: preset.institution,
        isBuiltin: true,
        mapping: serializeImportMapping(preset.mapping),
        createdAt: nowIso(),
      })
      .run();
    inserted += 1;
  }
  return inserted;
}

export function seedDatabase(db: Db): void {
  seedCategories(db);
  seedImportProfiles(db);
}
