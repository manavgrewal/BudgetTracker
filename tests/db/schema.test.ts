import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, type TestDb } from '../helpers/db';
import { openDatabase } from '@/db/client';

const JOURNAL_ENTRY_COUNT = (
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
    entries: unknown[];
  }
).entries.length;

let current: TestDb | null = null;

afterEach(() => {
  current?.cleanup();
  current = null;
});

const EXPECTED_TABLES = [
  'accounts', 'bayes_category_totals', 'bayes_tokens', 'budgets', 'categories',
  'goal_contributions', 'goals', 'import_profiles', 'imports', 'login_attempts',
  'merchant_rules', 'notification_outbox', 'notification_prefs', 'notification_smtp',
  'notification_targets', 'notification_user_settings', 'sessions', 'settings',
  'simplefin_account_links', 'simplefin_connections', 'totp_recovery_codes',
  'transaction_imports', 'transactions', 'users', 'warranty_item_types', 'warranty_items',
  'warranty_receipts', 'warranty_search',
];

const EXPECTED_INDEXES = [
  'users_username_uq',
  'categories_parent_idx',
  'import_profiles_name_uq',
  'accounts_owner_idx',
  'imports_account_idx',
  'transactions_dedup_uq',
  'transactions_external_id_uq',
  'transactions_account_date_idx',
  'transactions_date_idx',
  'transactions_category_date_idx',
  'transactions_attributed_date_idx',
  'transactions_import_idx',
  'transactions_normalized_merchant_idx',
  'transaction_imports_import_idx',
  'merchant_rules_pattern_uq',
  'budgets_scope_user_category_month_uq',
  'goal_contributions_goal_idx',
  'sessions_user_idx',
  'sessions_expires_idx',
  'login_attempts_username_idx',
  'login_attempts_ip_idx',
  'totp_recovery_codes_user_idx',
  'simplefin_links_account_idx',
  'warranty_items_expiry_idx',
  'warranty_items_owner_idx',
  'warranty_items_transaction_idx',
  'warranty_receipts_stored_uq',
  'warranty_receipts_item_idx',
  'warranty_receipts_ocr_idx',
  'warranty_item_types_name_uq',
  'warranty_items_type_idx',
];

describe('database schema', () => {
  it('creates every table from spec section 3', () => {
    current = createTestDb();
    const rows = current.sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' " +
          "and name not like '__drizzle%' and name not like 'warranty\\_search\\_%' escape '\\' order by name",
      )
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(EXPECTED_TABLES);
  });

  it('creates every index enumerated in spec section 3', () => {
    current = createTestDb();
    const rows = current.sqlite
      .prepare("select name from sqlite_master where type = 'index' and name not like 'sqlite_%'")
      .all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    for (const expected of EXPECTED_INDEXES) {
      expect(names.has(expected), `missing index ${expected}`).toBe(true);
    }
  });

  it('applies foreign_keys, WAL and busy_timeout pragmas on open', () => {
    current = createTestDb();
    expect(current.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(String(current.sqlite.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(current.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('enforces foreign keys at runtime', () => {
    current = createTestDb();
    expect(() =>
      current!.sqlite
        .prepare("insert into accounts (name, institution, type, owner_user_id, is_active, created_at) values ('X','Y','cash', 9999, 1, '2026-01-01T00:00:00.000Z')")
        .run(),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('rejects duplicate (account_id, dedup_hash) but allows many NULL dedup_hash rows', () => {
    current = createTestDb();
    const { sqlite } = current;
    sqlite.prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin','2026-01-01T00:00:00.000Z')").run();
    sqlite.prepare("insert into accounts (id, name, institution, type, created_at) values (1,'Chq','TD','chequing','2026-01-01T00:00:00.000Z')").run();
    const insert = sqlite.prepare(
      "insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, dedup_hash, hash_version, created_by, created_at, updated_at) values (1, '2026-01-02', 'X', 'X', -100, ?, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    insert.run('hash-a');
    expect(() => insert.run('hash-a')).toThrowError(/UNIQUE constraint failed/);
    insert.run(null);
    insert.run(null);
    const count = sqlite.prepare('select count(*) as c from transactions where dedup_hash is null').get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('binds the budgets unique index even when user_id is NULL', () => {
    current = createTestDb();
    const { sqlite } = current;
    sqlite.prepare("insert into categories (id, name, sort_order) values (1, 'Food', 0)").run();
    const insert = sqlite.prepare(
      "insert into budgets (scope, user_id, category_id, amount_cents, effective_month, created_at) values (?, ?, 1, ?, '2026-01', '2026-01-01T00:00:00.000Z')",
    );
    insert.run('household', null, 50000);
    expect(() => insert.run('household', null, 60000)).toThrowError(/UNIQUE constraint failed/);
    // personal rows for the same category/month are a different key
    sqlite.prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin','2026-01-01T00:00:00.000Z')").run();
    insert.run('personal', 1, 20000);
    expect(() => insert.run('personal', 1, 30000)).toThrowError(/UNIQUE constraint failed/);
  });

  it('rejects duplicate merchant rules on (pattern, match_type, rule_kind)', () => {
    current = createTestDb();
    const { sqlite } = current;
    const insert = sqlite.prepare(
      "insert into merchant_rules (pattern, match_type, rule_kind, category_id, hit_count, created_at) values (?, ?, ?, null, 0, '2026-01-01T00:00:00.000Z')",
    );
    insert.run('TIM HORTONS', 'exact', 'category');
    expect(() => insert.run('TIM HORTONS', 'exact', 'category')).toThrowError(/UNIQUE constraint failed/);
    insert.run('TIM HORTONS', 'contains', 'category');
    insert.run('TIM HORTONS', 'exact', 'transfer');
    // 'rename' is a third independent kind: one pattern can carry a category
    // rule AND a rename rule at the same time.
    insert.run('TIM HORTONS', 'exact', 'rename');
    const kinds = (sqlite.prepare("select rule_kind from merchant_rules where pattern = 'TIM HORTONS' and match_type = 'exact' order by rule_kind").all() as { rule_kind: string }[]).map((r) => r.rule_kind);
    expect(kinds).toEqual(['category', 'rename', 'transfer']);
  });

  it('stores rename_to on rename rules and leaves it NULL elsewhere', () => {
    current = createTestDb();
    const { sqlite } = current;
    sqlite
      .prepare(
        "insert into merchant_rules (pattern, match_type, rule_kind, category_id, rename_to, hit_count, created_at) values ('MCDONALDS', 'exact', 'rename', null, ?, 0, '2026-01-01T00:00:00.000Z')",
      )
      .run("McDonald's");
    sqlite
      .prepare(
        "insert into merchant_rules (pattern, match_type, rule_kind, category_id, hit_count, created_at) values ('MCDONALDS', 'exact', 'category', null, 0, '2026-01-01T00:00:00.000Z')",
      )
      .run();
    const rows = sqlite.prepare('select rule_kind, rename_to from merchant_rules order by rule_kind').all() as {
      rule_kind: string;
      rename_to: string | null;
    }[];
    expect(rows).toEqual([
      { rule_kind: 'category', rename_to: null },
      { rule_kind: 'rename', rename_to: "McDonald's" },
    ]);
  });

  it('defaults the display columns to NULL so raw_description is the fallback', () => {
    current = createTestDb();
    const { sqlite } = current;
    sqlite.prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin','2026-01-01T00:00:00.000Z')").run();
    sqlite.prepare("insert into accounts (id, name, institution, type, created_at) values (1,'Chq','TD','chequing','2026-01-01T00:00:00.000Z')").run();
    sqlite
      .prepare(
        "insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, hash_version, created_by, created_at, updated_at) values (1, '2026-01-02', 'MCDONALDS #4821', 'MCDONALDS', -1200, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    const row = sqlite.prepare('select raw_description, display_description, display_source, external_id from transactions').get() as Record<string, unknown>;
    expect(row).toEqual({
      raw_description: 'MCDONALDS #4821',
      display_description: null,
      display_source: null,
      external_id: null,
    });
  });

  it('rejects duplicate (account_id, external_id) but allows many NULL external_id rows', () => {
    current = createTestDb();
    const { sqlite } = current;
    sqlite.prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin','2026-01-01T00:00:00.000Z')").run();
    sqlite.prepare("insert into accounts (id, name, institution, type, created_at) values (1,'Chq','TD','chequing','2026-01-01T00:00:00.000Z')").run();
    sqlite.prepare("insert into accounts (id, name, institution, type, created_at) values (2,'Visa','TD','credit','2026-01-01T00:00:00.000Z')").run();
    const insert = sqlite.prepare(
      'insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, external_id, hash_version, created_by, created_at, updated_at) values (?, \'2026-01-02\', \'X\', \'X\', -100, ?, 1, 1, \'2026-01-01T00:00:00.000Z\', \'2026-01-01T00:00:00.000Z\')',
    );
    insert.run(1, 'sf-txn-1');
    expect(() => insert.run(1, 'sf-txn-1')).toThrowError(/UNIQUE constraint failed/);
    // the same provider id in a DIFFERENT account is a different transaction
    insert.run(2, 'sf-txn-1');
    // CSV and manual rows keep external_id NULL and must not collide
    insert.run(1, null);
    insert.run(1, null);
    const nulls = sqlite.prepare('select count(*) as c from transactions where external_id is null').get() as { c: number };
    expect(nulls.c).toBe(2);
  });

  it('creates the SimpleFIN tables with the provider id as the link primary key', () => {
    current = createTestDb();
    const { sqlite } = current;
    sqlite.prepare("insert into accounts (id, name, institution, type, created_at) values (1,'Chq','TD','chequing','2026-01-01T00:00:00.000Z')").run();
    sqlite.prepare("insert into accounts (id, name, institution, type, created_at) values (2,'Visa','TD','credit','2026-01-01T00:00:00.000Z')").run();

    sqlite
      .prepare(
        "insert into simplefin_connections (access_url_encrypted, claimed_at, requests_today, requests_date, enabled, created_at) values ('cipher', '2026-01-01T00:00:00.000Z', 0, '2026-01-01', 1, '2026-01-01T00:00:00.000Z')",
      )
      .run();
    const connection = sqlite.prepare('select * from simplefin_connections').get() as Record<string, unknown>;
    expect(connection).toMatchObject({ access_url_encrypted: 'cipher', requests_today: 0, requests_date: '2026-01-01', enabled: 1, last_sync_at: null });

    const link = sqlite.prepare(
      "insert into simplefin_account_links (simplefin_account_id, account_id, currency, created_at) values (?, ?, 'CAD', '2026-01-01T00:00:00.000Z')",
    );
    link.run('remote-acct-1', 1);
    // A remote account can only be linked once.
    expect(() => link.run('remote-acct-1', 2)).toThrowError(/UNIQUE constraint failed/);
    link.run('remote-acct-2', 2);
    expect((sqlite.prepare('select count(*) as c from simplefin_account_links').get() as { c: number }).c).toBe(2);
  });

  it('enforces the account foreign key on a SimpleFIN link', () => {
    current = createTestDb();
    expect(() =>
      current!.sqlite
        .prepare(
          "insert into simplefin_account_links (simplefin_account_id, account_id, currency, created_at) values ('x', 9999, 'CAD', '2026-01-01T00:00:00.000Z')",
        )
        .run(),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('is safe to migrate twice (idempotent boot)', () => {
    current = createTestDb();
    const path = current.path;
    const tablesBefore = current.sqlite
      .prepare(
        "select count(*) as c from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'",
      )
      .get() as { c: number };
    // Close only the sqlite handle -- the file on disk survives, including the
    // __drizzle_migrations bookkeeping table that already records 0000_init as applied.
    current.sqlite.close();
    // Reopening the SAME already-migrated file must not throw: migrate() has to see
    // 0000_init recorded in __drizzle_migrations and skip re-running the DDL, rather than
    // attempting `CREATE TABLE users (...)` again and failing with "table users already exists".
    const again = openDatabase(path);
    expect(again.sqlite.prepare('select count(*) as c from users').get()).toEqual({ c: 0 });
    const tablesAfter = again.sqlite
      .prepare(
        "select count(*) as c from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'",
      )
      .get() as { c: number };
    expect(tablesAfter.c).toBe(tablesBefore.c);
    again.sqlite.close();
  });
});

// Migration 0001 (spec v1.5). These guard the hand-maintained regime specifically:
// nothing regenerates this SQL, so "both files ran, in order, exactly once" is only
// true as long as a test says so.
describe('migration 0001_add_must_change_password', () => {
  const appliedTags = (sqlite: TestDb['sqlite']): number =>
    (sqlite.prepare('select count(*) as c from __drizzle_migrations').get() as { c: number }).c;

  it('a fresh database runs ALL migrations, in journal order', () => {
    current = createTestDb();
    expect(appliedTags(current.sqlite)).toBe(JOURNAL_ENTRY_COUNT);

    const columns = current.sqlite.prepare('pragma table_info(users)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const flag = columns.find((column) => column.name === 'must_change_password');
    expect(flag).toBeDefined();
    expect(flag?.type.toLowerCase()).toBe('integer');
    expect(flag?.notnull).toBe(1);
    expect(String(flag?.dflt_value)).toBe('0');
  });

  it('defaults existing and new rows to 0 — nobody is retroactively gated', () => {
    current = createTestDb();
    current.sqlite
      .prepare(
        "insert into users (name, username, password_hash, role, created_at) values ('A','a','h','admin','2026-01-01T00:00:00.000Z')",
      )
      .run();
    const row = current.sqlite.prepare('select must_change_password as flag from users').get() as { flag: number };
    expect(row.flag).toBe(0);
  });

  it('reopening an already-migrated file applies 0001 exactly once', () => {
    current = createTestDb();
    const file = current.path;
    current.sqlite.close();

    const again = openDatabase(file);
    // Still every recorded migration from the journal, and the ALTER TABLE did not run a
    // second time (a repeat would throw "duplicate column name: must_change_password").
    expect(appliedTags(again.sqlite)).toBe(JOURNAL_ENTRY_COUNT);
    const flagColumns = (again.sqlite.prepare('pragma table_info(users)').all() as { name: string }[]).filter(
      (column) => column.name === 'must_change_password',
    );
    expect(flagColumns).toHaveLength(1);
    again.sqlite.close();
  });
});
