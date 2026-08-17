import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    /**
     * Mirrors drizzle/0001_add_must_change_password.sql. Declared last because
     * ALTER TABLE ADD COLUMN appends physically — keep this in the same order as
     * the DDL so the mirror stays readable against `pragma table_info(users)`.
     */
    mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [uniqueIndex('users_username_uq').on(t.username)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    parentId: integer('parent_id'),
    icon: text('icon'),
    color: text('color'),
    isIncome: integer('is_income', { mode: 'boolean' }).notNull().default(false),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('categories_parent_idx').on(t.parentId)],
);

export const importProfiles = sqliteTable(
  'import_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    institution: text('institution').notNull(),
    isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
    mapping: text('mapping').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('import_profiles_name_uq').on(t.name)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    institution: text('institution').notNull(),
    type: text('type', { enum: ['chequing', 'credit', 'cash'] }).notNull(),
    ownerUserId: integer('owner_user_id').references(() => users.id),
    importProfileId: integer('import_profile_id').references(() => importProfiles.id),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('accounts_owner_idx').on(t.ownerUserId)],
);

export const imports = sqliteTable(
  'imports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    profileId: integer('profile_id').references(() => importProfiles.id),
    filename: text('filename').notNull(),
    importedBy: integer('imported_by').notNull().references(() => users.id),
    rowsAdded: integer('rows_added').notNull().default(0),
    rowsDuplicate: integer('rows_duplicate').notNull().default(0),
    rowsError: integer('rows_error').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('imports_account_idx').on(t.accountId, t.createdAt)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    importId: integer('import_id').references(() => imports.id, { onDelete: 'set null' }),
    attributedUserId: integer('attributed_user_id').references(() => users.id),
    date: text('date').notNull(),
    // raw_description is immutable truth: dedup hashing and the categorizer read
    // only this and normalized_merchant. display_description is presentation only.
    rawDescription: text('raw_description').notNull(),
    displayDescription: text('display_description'),
    displaySource: text('display_source', { enum: ['manual', 'rename'] }),
    normalizedMerchant: text('normalized_merchant').notNull(),
    amountCents: integer('amount_cents').notNull(),
    categoryId: integer('category_id').references(() => categories.id),
    categorizationSource: text('categorization_source', {
      enum: ['rule', 'bayes', 'manual', 'none'],
    })
      .notNull()
      .default('none'),
    confidence: real('confidence'),
    isTransfer: integer('is_transfer', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    dedupHash: text('dedup_hash'),
    hashVersion: integer('hash_version').notNull().default(1),
    /** SimpleFIN provider transaction id (spec section 12). NULL for CSV and manual rows. */
    externalId: text('external_id'),
    createdBy: integer('created_by').notNull().references(() => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('transactions_dedup_uq')
      .on(t.accountId, t.dedupHash)
      .where(sql`${t.dedupHash} is not null`),
    uniqueIndex('transactions_external_id_uq')
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('transactions_account_date_idx').on(t.accountId, t.date),
    index('transactions_date_idx').on(t.date),
    index('transactions_category_date_idx').on(t.categoryId, t.date),
    index('transactions_attributed_date_idx').on(t.attributedUserId, t.date),
    index('transactions_import_idx').on(t.importId),
    index('transactions_normalized_merchant_idx').on(t.normalizedMerchant),
  ],
);

export const transactionImports = sqliteTable(
  'transaction_imports',
  {
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    importId: integer('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.importId] }),
    index('transaction_imports_import_idx').on(t.importId),
  ],
);

export const merchantRules = sqliteTable(
  'merchant_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pattern: text('pattern').notNull(),
    matchType: text('match_type', { enum: ['exact', 'contains'] }).notNull(),
    ruleKind: text('rule_kind', { enum: ['category', 'transfer', 'rename', 'not_transfer'] }).notNull().default('category'),
    categoryId: integer('category_id').references(() => categories.id),
    /** Set only on rule_kind = 'rename'; NULL on category and transfer rules. */
    renameTo: text('rename_to'),
    createdBy: integer('created_by').references(() => users.id),
    hitCount: integer('hit_count').notNull().default(0),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('merchant_rules_pattern_uq').on(t.pattern, t.matchType, t.ruleKind)],
);

export const bayesTokens = sqliteTable(
  'bayes_tokens',
  {
    token: text('token').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.token, t.categoryId] }), index('bayes_tokens_token_idx').on(t.token)],
);

export const bayesCategoryTotals = sqliteTable('bayes_category_totals', {
  categoryId: integer('category_id')
    .primaryKey()
    .references(() => categories.id, { onDelete: 'cascade' }),
  docCount: integer('doc_count').notNull().default(0),
  tokenTotal: integer('token_total').notNull().default(0),
});

export const budgets = sqliteTable(
  'budgets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope', { enum: ['household', 'personal'] }).notNull(),
    userId: integer('user_id').references(() => users.id),
    categoryId: integer('category_id').notNull().references(() => categories.id),
    amountCents: integer('amount_cents'),
    effectiveMonth: text('effective_month').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('budgets_lookup_idx').on(t.categoryId, t.effectiveMonth)],
  // budgets_scope_user_category_month_uq is an expression index; see drizzle/0000_init.sql
);

export const goals = sqliteTable('goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  ownerUserId: integer('owner_user_id').references(() => users.id),
  targetCents: integer('target_cents').notNull(),
  targetDate: text('target_date'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});

export const goalContributions = sqliteTable(
  'goal_contributions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    goalId: integer('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    userId: integer('user_id').notNull().references(() => users.id),
    amountCents: integer('amount_cents').notNull(),
    date: text('date').notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('goal_contributions_goal_idx').on(t.goalId, t.date)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    ip: text('ip').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('login_attempts_username_idx').on(t.username, t.createdAt),
    index('login_attempts_ip_idx').on(t.ip, t.createdAt),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** SimpleFIN (spec section 12). Stays empty until an admin claims a setup token. */
export const simplefinConnections = sqliteTable('simplefin_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** base64(iv || tag || ciphertext), AES-256-GCM under HKDF info 'simplefin-v1'. */
  accessUrlEncrypted: text('access_url_encrypted').notNull(),
  claimedAt: text('claimed_at').notNull(),
  lastSyncAt: text('last_sync_at'),
  requestsToday: integer('requests_today').notNull().default(0),
  requestsDate: text('requests_date').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const simplefinAccountLinks = sqliteTable(
  'simplefin_account_links',
  {
    /** The provider's account id is the PK: a remote account links to at most one local account. */
    simplefinAccountId: text('simplefin_account_id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    lastBalanceCents: integer('last_balance_cents'),
    lastBalanceDate: text('last_balance_date'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('simplefin_links_account_idx').on(t.accountId)],
);

export const totpRecoveryCodes = sqliteTable(
  'totp_recovery_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: text('used_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('totp_recovery_codes_user_idx').on(t.userId),
    uniqueIndex('totp_recovery_codes_hash_uq').on(t.userId, t.codeHash),
  ],
);

/**
 * Warranty tracker (spec 2026-08-16 §3). Mirrors drizzle/0002_warranty_tracker.sql.
 *
 * NOT represented here — these objects exist ONLY in that raw SQL file (MUST-3.4):
 *   - every CHECK constraint on both tables,
 *   - the `warranty_search` FTS5 contentless virtual table
 *     (contentless_delete=1, tokenize='unicode61 remove_diacritics 2', rowid = warranty_items.id),
 *   - its six triggers — warranty_search_item_ai / _au / _ad and
 *     warranty_search_receipt_ai / _au / _ad — which are the index's ONLY writer.
 * Application code must never INSERT, UPDATE or DELETE `warranty_search` directly (MUST-3.12).
 */
export const warrantyItems = sqliteTable(
  'warranty_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    vendor: text('vendor'),
    model: text('model'),
    serial: text('serial'),
    purchaseDate: text('purchase_date').notNull(),
    warrantyMonths: integer('warranty_months'),
    isLifetime: integer('is_lifetime', { mode: 'boolean' }).notNull().default(false),
    /** Computed at write time by addMonthsClamped(); never derived on read (MUST-3.6). */
    expiryDate: text('expiry_date'),
    /** Positive magnitude, unlike transactions.amount_cents (MUST-3.2 / §17.26). */
    priceCents: integer('price_cents'),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id),
    /** ON DELETE SET NULL: an import undo must not take the receipt evidence with it (MUST-3.7). */
    transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /**
     * Spec section 19.3, added by drizzle/0003_warranty_item_types.sql. Declared last
     * because ALTER TABLE ADD COLUMN appends physically -- same convention as
     * users.mustChangePassword, so the mirror stays readable against
     * `pragma table_info(warranty_items)`. Nullable: a type is optional, and NULL means
     * "unclassified" (there is no Uncategorised row). No onDelete clause on purpose --
     * deleting a type that is in use is blocked in the app layer (MUST-19.5/19.6).
     */
    typeId: integer('type_id').references(() => warrantyItemTypes.id),
    /**
     * v1.3.0, added by drizzle/0005_billing_cycle.sql. Declared last -- same
     * ALTER-TABLE-ADD-COLUMN convention as typeId above. Both nullable: only an item whose
     * TYPE has kind 'subscription' or 'contract' ever carries a non-NULL value here, and
     * that rule is enforced in the app layer (src/lib/warranty/items.ts), never derived on
     * read -- a CHECK on this table cannot see across to warranty_item_types.kind.
     */
    billingCycle: text('billing_cycle', { enum: ['monthly', 'annual'] }),
    billingAmountCents: integer('billing_amount_cents'),
  },
  (t) => [
    index('warranty_items_expiry_idx').on(t.expiryDate),
    index('warranty_items_owner_idx').on(t.ownerUserId),
    index('warranty_items_transaction_idx').on(t.transactionId),
    index('warranty_items_type_idx').on(t.typeId),
  ],
);

export const warrantyReceipts = sqliteTable(
  'warranty_receipts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    warrantyItemId: integer('warranty_item_id')
      .notNull()
      .references(() => warrantyItems.id, { onDelete: 'cascade' }),
    /** Display only: never a path component, never rendered as HTML (MUST-3.8). */
    originalFilename: text('original_filename').notNull(),
    /** Server-generated `${randomUUID()}.${sniffedExt}` (MUST-4.2). */
    storedFilename: text('stored_filename').notNull(),
    mime: text('mime', { enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    ocrText: text('ocr_text'),
    /** Exactly three values — there is deliberately no 'running' state (§7.5). */
    ocrStatus: text('ocr_status', { enum: ['pending', 'done', 'failed'] }).notNull().default('pending'),
    ocrError: text('ocr_error'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('warranty_receipts_stored_uq').on(t.storedFilename),
    index('warranty_receipts_item_idx').on(t.warrantyItemId),
    index('warranty_receipts_ocr_idx').on(t.ocrStatus),
  ],
);

/**
 * Admin-maintained item types (spec section 19.2, amended v1.2.2 section 19 -- kinds).
 * Mirrors drizzle/0003_warranty_item_types.sql and drizzle/0004_item_type_kinds.sql.
 *
 * NOT represented here -- these exist ONLY in those raw SQL files (MUST-3.4 / MUST-19.3):
 *   - CHECK (is_subscription IN (0,1)) and CHECK (length(trim(name)) BETWEEN 1 AND 60)  (0003)
 *   - the COLLATE NOCASE collation on warranty_item_types_name_uq, which is what makes
 *     'Laptop' and 'laptop' the same type (ASCII-only folding -- accepted, section 19.2) (0003)
 *   - CHECK (kind IN ('warranty','subscription','contract','loan'))                     (0004)
 *
 * `kind` (0004) is now the classifier: warranty / subscription / contract / loan. It arrives
 * by ALTER TABLE ADD COLUMN, so -- same convention as users.mustChangePassword and
 * warrantyItems.typeId -- it is declared LAST here, physically the last column.
 * `is_subscription` is KEPT for old readers (append-only discipline) and is maintained by
 * src/lib/warranty/types.ts as `kind === 'subscription'` on every write, so it never drifts
 * out of sync with `kind`. The period start, length and end are still
 * warranty_items.purchase_date / warranty_months / expiry_date reused verbatim (MUST-19.8).
 * The kind changes wording only, never derivation (MUST-19.12).
 */
export const warrantyItemTypes = sqliteTable(
  'warranty_item_types',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    isSubscription: integer('is_subscription', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    kind: text('kind', { enum: ['warranty', 'subscription', 'contract', 'loan'] }).notNull().default('warranty'),
  },
  (t) => [uniqueIndex('warranty_item_types_name_uq').on(t.name)],
);
