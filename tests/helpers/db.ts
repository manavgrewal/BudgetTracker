import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { openDatabase, setDbForTests, type Db } from '@/db/client';
import { seedDatabase } from '@/db/seed';
import { nowIso } from '@/lib/clock';

export interface TestDb {
  db: Db;
  sqlite: BetterSqlite3.Database;
  path: string;
  cleanup(): void;
}

export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-test-'));
  const file = path.join(dir, 'budget.db');
  const instance = openDatabase(file);
  setDbForTests(instance);
  return {
    db: instance.db,
    sqlite: instance.sqlite,
    path: file,
    cleanup() {
      setDbForTests(null);
      try {
        instance.sqlite.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function createSeededTestDb(): TestDb {
  const testDb = createTestDb();
  seedDatabase(testDb.db);
  return testDb;
}

export function insertTestUser(
  db: Db,
  over: Partial<{ name: string; username: string; role: 'admin' | 'member'; isActive: boolean }> = {},
): number {
  const name = over.name ?? 'Test User';
  const username = over.username ?? `user${Math.random().toString(36).slice(2, 8)}`;
  const role = over.role ?? 'admin';
  const isActive = over.isActive ?? true;
  const row = db
    .get<{ id: number }>(
      sql`insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
          values (${name}, ${username}, ${'x'}, ${role}, 0, ${isActive ? 1 : 0}, ${nowIso()})
          returning id`,
    );
  return row.id;
}

export function insertTestAccount(
  db: Db,
  over: Partial<{
    name: string;
    institution: string;
    type: 'chequing' | 'credit' | 'cash';
    ownerUserId: number | null;
    importProfileId: number | null;
  }> = {},
): number {
  const row = db.get<{ id: number }>(
    sql`insert into accounts (name, institution, type, owner_user_id, import_profile_id, is_active, created_at)
        values (${over.name ?? 'Joint Chequing'}, ${over.institution ?? 'TD Canada Trust'},
                ${over.type ?? 'chequing'}, ${over.ownerUserId ?? null}, ${over.importProfileId ?? null},
                1, ${nowIso()})
        returning id`,
  );
  return row.id;
}

export function categoryIdByName(db: Db, name: string): number {
  const row = db.get<{ id: number }>(sql`select id from categories where name = ${name} limit 1`);
  if (!row) throw new Error(`no seeded category named ${name}`);
  return row.id;
}
