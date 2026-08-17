-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- NOTE ON SEPARATORS: drizzle's migrator splits this file on the breakpoint marker (the
-- one written between each statement below) and on nothing else, and it does NOT skip
-- comments. That marker must therefore never be written inside a comment -- including
-- this one, which is why it is described here rather than quoted -- or the file is
-- shredded into fragments that will not parse.
--
-- Notifications (spec 2026-08-17, v1.3.0). Five tables, ALL created empty and ALL left
-- empty until a person fills in a form. While notification_targets has no enabled row the
-- app makes no outbound connection on account of this feature (spec section 1.1).
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after
-- this migration:
--   1. the categories.parent_id self-referencing foreign key             (0000)
--   2. the COALESCE(display_description, raw_description) index          (0000)
--   3. the COALESCE month expression index                               (0000)
--   4. every CHECK constraint on warranty_items                          (0002)
--   5. every CHECK constraint on warranty_receipts                       (0002)
--   6. the warranty_search FTS5 contentless virtual table                (0002)
--   7. its six triggers, which are its ONLY writer                       (0002)
--   8. the is_subscription/name CHECK constraints on warranty_item_types (0003)
--   9. the COLLATE NOCASE collation on warranty_item_types_name_uq       (0003)
--  10. warranty_items.type_id arriving by ALTER TABLE ADD COLUMN         (0003)
--  11. the CHECK constraint on warranty_item_types.kind                  (0004)
--  12. warranty_item_types.kind itself, by ALTER TABLE ADD COLUMN        (0004)
--  13. the CHECK constraints on billing_cycle and billing_amount_cents,
--      and both columns arriving by ALTER TABLE ADD COLUMN               (0005)
--  14. the id = 1 singleton CHECK on notification_smtp                   (0006)
--  15. every other CHECK constraint on notification_smtp                 (0006)
--  16. every CHECK constraint on notification_targets, including the     (0006)
--      channel/secret_encrypted pairing rule
--  17. every CHECK constraint on notification_prefs                      (0006)
--  18. every CHECK constraint on notification_user_settings              (0006)
--  19. every CHECK constraint on notification_outbox                     (0006)
--  20. notification_prefs' WITHOUT ROWID storage class                   (0006)
CREATE TABLE `notification_smtp` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`preset` text NOT NULL CHECK (`preset` IN ('brevo', 'smtp2go', 'gmail', 'custom')),
	`host` text NOT NULL,
	`port` integer NOT NULL CHECK (`port` BETWEEN 1 AND 65535),
	`security` text NOT NULL CHECK (`security` IN ('tls', 'starttls', 'none')),
	`username` text NOT NULL,
	`password_encrypted` text NOT NULL,
	`from_email` text NOT NULL,
	`from_name` text NOT NULL DEFAULT 'Budget Tracker',
	`enabled` integer NOT NULL DEFAULT 1,
	`last_error` text,
	`last_error_at` text,
	`last_success_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
	`destination` text NOT NULL,
	`secret_encrypted` text,
	`enabled` integer NOT NULL DEFAULT 1,
	`verified_at` text,
	`last_error` text,
	`last_error_at` text,
	`last_success_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (
		(`channel` = 'telegram' AND `secret_encrypted` IS NOT NULL)
		OR (`channel` = 'email' AND `secret_encrypted` IS NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_targets_user_channel_uq` ON `notification_targets` (`user_id`, `channel`);
--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`event_id` text NOT NULL,
	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
	`enabled` integer NOT NULL DEFAULT 0,
	PRIMARY KEY (`user_id`, `event_id`, `channel`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `notification_user_settings` (
	`user_id` integer PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`coming_due_days` integer NOT NULL DEFAULT 14 CHECK (`coming_due_days` BETWEEN 1 AND 365),
	`budget_threshold_pct` integer NOT NULL DEFAULT 80 CHECK (`budget_threshold_pct` BETWEEN 1 AND 99),
	`stale_import_weeks` integer NOT NULL DEFAULT 3 CHECK (`stale_import_weeks` BETWEEN 1 AND 52),
	`daily_hour` integer NOT NULL DEFAULT 8 CHECK (`daily_hour` BETWEEN 0 AND 23),
	`digest_weekday` integer NOT NULL DEFAULT 1 CHECK (`digest_weekday` BETWEEN 0 AND 6),
	`digest_hour` integer NOT NULL DEFAULT 8 CHECK (`digest_hour` BETWEEN 0 AND 23),
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
	`event_id` text NOT NULL,
	`dedup_key` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'sent', 'failed')),
	`attempts` integer NOT NULL DEFAULT 0,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_dedup_uq` ON `notification_outbox` (`user_id`, `channel`, `dedup_key`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_due_idx` ON `notification_outbox` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_user_idx` ON `notification_outbox` (`user_id`, `id`);
