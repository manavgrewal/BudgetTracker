-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- Warranty item types and subscriptions (spec 2026-08-16 section 19). Objects that exist
-- ONLY in SQL and have NO Drizzle representation now number, after this migration:
--   1. the categories.parent_id self-referencing foreign key            (0000)
--   2. the COALESCE(display_description, raw_description) index         (0000)
--   3. the COALESCE month expression index                              (0000)
--   4. every CHECK constraint on warranty_items                         (0002)
--   5. every CHECK constraint on warranty_receipts                      (0002)
--   6. the warranty_search FTS5 contentless virtual table               (0002)
--   7. its six triggers, which are its ONLY writer                      (0002)
--   8. both CHECK constraints on warranty_item_types below              (0003)
--   9. the COLLATE NOCASE collation on warranty_item_types_name_uq      (0003)
--  10. warranty_items.type_id arriving by ALTER TABLE ADD COLUMN        (0003)
-- The type name is deliberately NOT indexed in warranty_search: a type is a filter, not
-- search text, and renaming one must never trigger an FTS rebuild (MUST-19.16).
CREATE TABLE `warranty_item_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_subscription` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	CHECK (`is_subscription` IN (0, 1)),
	CHECK (length(trim(`name`)) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warranty_item_types_name_uq` ON `warranty_item_types` (`name` COLLATE NOCASE);
--> statement-breakpoint
INSERT INTO `warranty_item_types` (`name`, `is_subscription`, `created_at`) VALUES
	('Laptop', 0, '2026-08-16T00:00:00.000Z'),
	('Appliance', 0, '2026-08-16T00:00:00.000Z'),
	('Subscription', 1, '2026-08-16T00:00:00.000Z');
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `type_id` integer REFERENCES `warranty_item_types`(`id`);
--> statement-breakpoint
CREATE INDEX `warranty_items_type_idx` ON `warranty_items` (`type_id`);
