-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- NOTE ON SEPARATORS: drizzle's migrator splits this file on the breakpoint marker written
-- between each statement below, and on nothing else, and it does NOT skip comments. That
-- marker must therefore never appear inside a comment -- including this one, which is why
-- it is described here rather than quoted -- or the file is shredded into fragments that
-- will not parse.
--
-- Loan money-tracking (spec 2026-08-17, v1.3.1). Four nullable columns on warranty_items
-- and two new tables, both created EMPTY. This migration reverses the warranty spec's
-- section 17 item 29 ("loans are dates and documents only"): loans now carry a principal,
-- a display-only rate, and a balance that bank transactions can decrement.
--
-- TWO RULES DELIBERATELY LIVE IN THE APP LAYER, NOT HERE, both in
-- src/lib/warranty/items.ts, for the reason 0005's header already gives -- a CHECK on
-- warranty_items cannot see across to warranty_item_types.kind:
--   (a) which kinds may carry billing_cycle / billing_amount_cents (0005's rule, widened
--       by this release to include 'loan');
--   (b) current_balance_cents and balance_updated_at are both set or both NULL. This one
--       is cross-column, and ALTER TABLE ADD COLUMN does not re-validate existing rows
--       against a CHECK added that way, so a CHECK here would be weaker than it looks.
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after
-- this migration:
--   1. the categories.parent_id self-referencing foreign key             (0000)
--   2. the COALESCE(display_description, raw_description) index          (0000)
--   3. the COALESCE month expression index                               (0000)
--   4. every CHECK constraint on warranty_items                          (0002, extended here)
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
--  21. the CHECK constraints on the four loan money columns, and all
--      four columns arriving by ALTER TABLE ADD COLUMN                   (0007)
--  22. every CHECK constraint on loan_matcher_rules                      (0007)
--  23. the coalesce(account_id, -1) EXPRESSION in loan_matcher_rules_uq  (0007)
--  24. every CHECK constraint on loan_payments                           (0007)
ALTER TABLE `warranty_items` ADD COLUMN `principal_cents` integer CHECK (`principal_cents` IS NULL OR `principal_cents` >= 0);
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `interest_rate_bps` integer CHECK (`interest_rate_bps` IS NULL OR (`interest_rate_bps` >= 0 AND `interest_rate_bps` <= 1000000));
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `current_balance_cents` integer CHECK (`current_balance_cents` IS NULL OR `current_balance_cents` >= 0);
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `balance_updated_at` text;
--> statement-breakpoint
CREATE TABLE `loan_matcher_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
	`merchant_contains` text NOT NULL CHECK (length(trim(`merchant_contains`)) >= 3),
	`account_id` integer REFERENCES `accounts`(`id`) ON DELETE CASCADE,
	`enabled` integer NOT NULL DEFAULT 1,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `loan_matcher_rules_item_idx` ON `loan_matcher_rules` (`item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `loan_matcher_rules_uq` ON `loan_matcher_rules` (`item_id`, `merchant_contains`, coalesce(`account_id`, -1));
--> statement-breakpoint
CREATE TABLE `loan_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`txn_id` integer NOT NULL REFERENCES `transactions`(`id`) ON DELETE CASCADE,
	`item_id` integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
	`amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
	`applied_cents` integer NOT NULL CHECK (`applied_cents` >= 0 AND `applied_cents` <= `amount_cents`),
	`source` text NOT NULL CHECK (`source` IN ('rule', 'manual')),
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loan_payments_txn_item_uq` ON `loan_payments` (`txn_id`, `item_id`);
--> statement-breakpoint
CREATE INDEX `loan_payments_item_idx` ON `loan_payments` (`item_id`, `id`);
--> statement-breakpoint
CREATE INDEX `loan_payments_txn_idx` ON `loan_payments` (`txn_id`);
