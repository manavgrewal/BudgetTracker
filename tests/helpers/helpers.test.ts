import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, insertTestAccount, categoryIdByName, type TestDb } from './db';

// Task 3+ consume createSeededTestDb/insertTestUser/insertTestAccount/categoryIdByName
// immediately and verbatim. This file proves their db.get<T>(sql`INSERT ... RETURNING id`)
// mechanic actually returns a usable row on the installed drizzle-orm/better-sqlite3
// version, rather than leaving that assumption unverified until a later task's tests
// fail for an unrelated reason.

let current: TestDb | null = null;

afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('test db helpers', () => {
  it('createSeededTestDb seeds categories and import profiles', () => {
    current = createSeededTestDb();
    const categoryCount = current.sqlite.prepare('select count(*) as c from categories').get() as { c: number };
    const profileCount = current.sqlite.prepare('select count(*) as c from import_profiles').get() as { c: number };
    expect(categoryCount.c).toBe(37);
    expect(profileCount.c).toBe(4);
  });

  it('insertTestUser inserts a row and returns a usable id', () => {
    current = createSeededTestDb();
    const id = insertTestUser(current.db, { username: 'alice', role: 'admin' });
    expect(typeof id).toBe('number');
    const row = current.sqlite.prepare('select username, role, is_active from users where id = ?').get(id) as {
      username: string;
      role: string;
      is_active: number;
    };
    expect(row).toEqual({ username: 'alice', role: 'admin', is_active: 1 });
  });

  it('insertTestUser respects overrides for name and isActive', () => {
    current = createSeededTestDb();
    const id = insertTestUser(current.db, { name: 'Bob Smith', role: 'member', isActive: false });
    const row = current.sqlite.prepare('select name, role, is_active from users where id = ?').get(id) as {
      name: string;
      role: string;
      is_active: number;
    };
    expect(row).toEqual({ name: 'Bob Smith', role: 'member', is_active: 0 });
  });

  it('insertTestAccount inserts a row and returns a usable id', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const id = insertTestAccount(current.db, { name: 'Test Chequing', ownerUserId: userId });
    expect(typeof id).toBe('number');
    const row = current.sqlite.prepare('select name, owner_user_id, is_active from accounts where id = ?').get(id) as {
      name: string;
      owner_user_id: number;
      is_active: number;
    };
    expect(row).toEqual({ name: 'Test Chequing', owner_user_id: userId, is_active: 1 });
  });

  it('insertTestAccount applies default name/institution/type when no overrides given', () => {
    current = createSeededTestDb();
    const id = insertTestAccount(current.db);
    const row = current.sqlite.prepare('select name, institution, type from accounts where id = ?').get(id) as {
      name: string;
      institution: string;
      type: string;
    };
    expect(row).toEqual({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing' });
  });

  it('categoryIdByName resolves a seeded category to its id', () => {
    current = createSeededTestDb();
    const id = categoryIdByName(current.db, 'Groceries');
    expect(typeof id).toBe('number');
    const row = current.sqlite.prepare('select name from categories where id = ?').get(id) as { name: string };
    expect(row.name).toBe('Groceries');
  });

  it('categoryIdByName throws for an unknown name', () => {
    current = createSeededTestDb();
    expect(() => categoryIdByName(current!.db, 'Nonexistent Category XYZ')).toThrowError(/no seeded category named/);
  });
});
