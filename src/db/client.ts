import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readEnv } from '@/lib/env';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbInstance {
  db: Db;
  sqlite: BetterSqlite3.Database;
}

let instance: DbInstance | null = null;

// BUDGET_DB_PATH / BUDGET_MIGRATIONS_DIR are dev/test-only overrides (not documented in
// README/.env.example, not set by docker-compose.yml): the container path always resolves
// through DATA_DIR and process.cwd()/drizzle below.
export function databasePath(): string {
  const override = process.env.BUDGET_DB_PATH;
  if (override && override.length > 0) return override;
  return path.join(readEnv().dataDir, 'budget.db');
}

export function migrationsFolder(): string {
  return process.env.BUDGET_MIGRATIONS_DIR ?? path.join(process.cwd(), 'drizzle');
}

/**
 * The ONLY place a better-sqlite3 Database is constructed.
 * Every connection gets foreign_keys=ON, journal_mode=WAL, busy_timeout=5000,
 * then Drizzle migrations are applied (idempotent).
 */
export function openDatabase(filePath: string): DbInstance {
  const sqlite = new BetterSqlite3(filePath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, sqlite };
}

function ensureInstance(): DbInstance {
  if (!instance) {
    instance = openDatabase(databasePath());
  }
  return instance;
}

export function getDb(): Db {
  return ensureInstance().db;
}

export function getSqlite(): BetterSqlite3.Database {
  return ensureInstance().sqlite;
}

/** Test seam: point the module-level singleton at a temp database. */
export function setDbForTests(next: DbInstance | null): void {
  instance = next;
}

export function closeDb(): void {
  instance?.sqlite.close();
  instance = null;
}
