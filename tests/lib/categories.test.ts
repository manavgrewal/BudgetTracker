import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, type TestDb } from '../helpers/db';
import { archiveCategory, categoryLabel, categoryTree, categoryWithDescendants, createCategory, listCategories, renameCategory } from '@/lib/categories';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('categories', () => {
  it('lists the seeded tree with parents first', () => {
    current = createSeededTestDb();
    const tree = categoryTree();
    expect(tree).toHaveLength(9);
    expect(tree[0].name).toBe('Income');
    expect(tree[0].children.map((c) => c.name)).toEqual(['Salary', 'Other Income']);
    expect(tree.find((c) => c.name === 'Kids')?.children).toEqual([]);
  });

  it('rolls a parent up to include every child (max depth 2)', () => {
    current = createSeededTestDb();
    const food = categoryIdByName(current.db, 'Food');
    const groceries = categoryIdByName(current.db, 'Groceries');
    const ids = categoryWithDescendants(food);
    expect(ids).toContain(food);
    expect(ids).toContain(groceries);
    expect(ids).toHaveLength(4);
    expect(categoryWithDescendants(groceries)).toEqual([groceries]);
  });

  it('labels a category with its parent for disambiguation', () => {
    current = createSeededTestDb();
    const all = listCategories();
    const general = categoryIdByName(current.db, 'General');
    expect(categoryLabel(general, all)).toBe('Shopping › General');
    expect(categoryLabel(categoryIdByName(current.db, 'Kids'), all)).toBe('Kids');
    expect(categoryLabel(null, all)).toBe('Uncategorized');
  });

  it('archives instead of deleting and hides archived rows by default', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    archiveCategory(coffee, true);
    expect(listCategories().some((c) => c.id === coffee)).toBe(false);
    expect(listCategories({ includeArchived: true }).some((c) => c.id === coffee)).toBe(true);
    const stillThere = current.sqlite.prepare('select is_archived from categories where id = ?').get(coffee) as { is_archived: number };
    expect(stillThere.is_archived).toBe(1);
  });

  it('creates and renames custom categories', () => {
    current = createSeededTestDb();
    const food = categoryIdByName(current.db, 'Food');
    const id = createCategory({ name: 'Takeout', parentId: food });
    expect(listCategories().find((c) => c.id === id)).toMatchObject({ name: 'Takeout', parentId: food });
    renameCategory(id, 'Delivery');
    expect(listCategories().find((c) => c.id === id)?.name).toBe('Delivery');
  });

  it('rejects a third level of nesting', () => {
    current = createSeededTestDb();
    const groceries = categoryIdByName(current.db, 'Groceries');
    expect(() => createCategory({ name: 'Too Deep', parentId: groceries })).toThrowError(/two levels/i);
  });
});
