-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- drizzle/meta/_journal.json exists but there is NO 0000_snapshot.json, so running
-- `drizzle-kit generate` against this project would diff the schema against an empty
-- baseline and emit a new migration that re-creates all 19 tables already defined below --
-- the next boot would then fail with "table users already exists".
--
-- That regenerated SQL would also silently DROP three objects that exist ONLY here,
-- not in src/db/schema.ts (drizzle-kit cannot infer them from the Drizzle schema builder):
--   1. categories.parent_id's self-referential FK (REFERENCES categories(id))
--   2. the categories_name_parent_uq expression index (COALESCE(parent_id, 0))
--   3. the budgets_scope_user_category_month_uq expression index (COALESCE(user_id, 0))
--
-- Do not run `drizzle-kit generate` without first hand-authoring a matching snapshot
-- that accounts for all three. There is intentionally no db:generate script in package.json.
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`totp_secret_encrypted` text,
	`totp_enabled` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer REFERENCES `categories`(`id`),
	`icon` text,
	`color` text,
	`is_income` integer DEFAULT 0 NOT NULL,
	`is_archived` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_parent_uq` ON `categories` (`name`, COALESCE(`parent_id`, 0));
--> statement-breakpoint
CREATE TABLE `import_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`institution` text NOT NULL,
	`is_builtin` integer DEFAULT 0 NOT NULL,
	`mapping` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_profiles_name_uq` ON `import_profiles` (`name`);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`institution` text NOT NULL,
	`type` text NOT NULL,
	`owner_user_id` integer REFERENCES `users`(`id`),
	`import_profile_id` integer REFERENCES `import_profiles`(`id`),
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `accounts_owner_idx` ON `accounts` (`owner_user_id`);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL REFERENCES `accounts`(`id`),
	`profile_id` integer REFERENCES `import_profiles`(`id`),
	`filename` text NOT NULL,
	`imported_by` integer NOT NULL REFERENCES `users`(`id`),
	`rows_added` integer DEFAULT 0 NOT NULL,
	`rows_duplicate` integer DEFAULT 0 NOT NULL,
	`rows_error` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `imports_account_idx` ON `imports` (`account_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL REFERENCES `accounts`(`id`),
	`import_id` integer REFERENCES `imports`(`id`) ON DELETE SET NULL,
	`attributed_user_id` integer REFERENCES `users`(`id`),
	`date` text NOT NULL,
	`raw_description` text NOT NULL,
	`display_description` text,
	`display_source` text,
	`normalized_merchant` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`category_id` integer REFERENCES `categories`(`id`),
	`categorization_source` text DEFAULT 'none' NOT NULL,
	`confidence` real,
	`is_transfer` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`dedup_hash` text,
	`hash_version` integer DEFAULT 1 NOT NULL,
	`external_id` text,
	`created_by` integer NOT NULL REFERENCES `users`(`id`),
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_dedup_uq` ON `transactions` (`account_id`, `dedup_hash`) WHERE `dedup_hash` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_external_id_uq` ON `transactions` (`account_id`, `external_id`) WHERE `external_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`, `date`);
--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);
--> statement-breakpoint
CREATE INDEX `transactions_category_date_idx` ON `transactions` (`category_id`, `date`);
--> statement-breakpoint
CREATE INDEX `transactions_attributed_date_idx` ON `transactions` (`attributed_user_id`, `date`);
--> statement-breakpoint
CREATE INDEX `transactions_import_idx` ON `transactions` (`import_id`);
--> statement-breakpoint
CREATE INDEX `transactions_normalized_merchant_idx` ON `transactions` (`normalized_merchant`);
--> statement-breakpoint
CREATE TABLE `transaction_imports` (
	`transaction_id` integer NOT NULL REFERENCES `transactions`(`id`) ON DELETE CASCADE,
	`import_id` integer NOT NULL REFERENCES `imports`(`id`) ON DELETE CASCADE,
	`created_at` text NOT NULL,
	PRIMARY KEY (`transaction_id`, `import_id`)
);
--> statement-breakpoint
CREATE INDEX `transaction_imports_import_idx` ON `transaction_imports` (`import_id`);
--> statement-breakpoint
CREATE TABLE `merchant_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`match_type` text NOT NULL,
	`rule_kind` text DEFAULT 'category' NOT NULL,
	`category_id` integer REFERENCES `categories`(`id`),
	`rename_to` text,
	`created_by` integer REFERENCES `users`(`id`),
	`hit_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_rules_pattern_uq` ON `merchant_rules` (`pattern`, `match_type`, `rule_kind`);
--> statement-breakpoint
CREATE TABLE `bayes_tokens` (
	`token` text NOT NULL,
	`category_id` integer NOT NULL REFERENCES `categories`(`id`) ON DELETE CASCADE,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY (`token`, `category_id`)
);
--> statement-breakpoint
CREATE INDEX `bayes_tokens_token_idx` ON `bayes_tokens` (`token`);
--> statement-breakpoint
CREATE TABLE `bayes_category_totals` (
	`category_id` integer PRIMARY KEY NOT NULL REFERENCES `categories`(`id`) ON DELETE CASCADE,
	`doc_count` integer DEFAULT 0 NOT NULL,
	`token_total` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`user_id` integer REFERENCES `users`(`id`),
	`category_id` integer NOT NULL REFERENCES `categories`(`id`),
	`amount_cents` integer,
	`effective_month` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_scope_user_category_month_uq` ON `budgets` (`scope`, COALESCE(`user_id`, 0), `category_id`, `effective_month`);
--> statement-breakpoint
CREATE INDEX `budgets_lookup_idx` ON `budgets` (`category_id`, `effective_month`);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` integer REFERENCES `users`(`id`),
	`target_cents` integer NOT NULL,
	`target_date` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goal_contributions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` integer NOT NULL REFERENCES `goals`(`id`) ON DELETE CASCADE,
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`amount_cents` integer NOT NULL,
	`date` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goal_contributions_goal_idx` ON `goal_contributions` (`goal_id`, `date`);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`user_agent` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`ip` text NOT NULL,
	`success` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_username_idx` ON `login_attempts` (`username`, `created_at`);
--> statement-breakpoint
CREATE INDEX `login_attempts_ip_idx` ON `login_attempts` (`ip`, `created_at`);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `simplefin_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`access_url_encrypted` text NOT NULL,
	`claimed_at` text NOT NULL,
	`last_sync_at` text,
	`requests_today` integer DEFAULT 0 NOT NULL,
	`requests_date` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `simplefin_account_links` (
	`simplefin_account_id` text PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE CASCADE,
	`currency` text NOT NULL,
	`last_balance_cents` integer,
	`last_balance_date` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `simplefin_links_account_idx` ON `simplefin_account_links` (`account_id`);
--> statement-breakpoint
CREATE TABLE `totp_recovery_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`code_hash` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `totp_recovery_codes_user_idx` ON `totp_recovery_codes` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `totp_recovery_codes_hash_uq` ON `totp_recovery_codes` (`user_id`, `code_hash`);
