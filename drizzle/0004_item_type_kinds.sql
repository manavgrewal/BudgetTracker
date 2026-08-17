-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- Item-type kinds (spec 2026-08-16 section 19, amended v1.2.2: user feedback --
-- the tracker generalizes to "Contracts & Coverage", covering warranty, subscription,
-- contract and loan kinds). `is_subscription` is KEPT -- append-only discipline, and it
-- stays consistent for every existing row via this migration's backfill below -- but it
-- is no longer the only classifier: `kind` is. The library (src/lib/warranty/types.ts)
-- maintains `is_subscription = (kind = 'subscription')` on every write from here on, so
-- any reader that only ever learned about the old flag keeps working unchanged.
-- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after
-- this migration:
--   1. the categories.parent_id self-referencing foreign key            (0000)
--   2. the COALESCE(display_description, raw_description) index         (0000)
--   3. the COALESCE month expression index                              (0000)
--   4. every CHECK constraint on warranty_items                         (0002)
--   5. every CHECK constraint on warranty_receipts                      (0002)
--   6. the warranty_search FTS5 contentless virtual table               (0002)
--   7. its six triggers, which are its ONLY writer                      (0002)
--   8. the is_subscription/name CHECK constraints on warranty_item_types (0003)
--   9. the COLLATE NOCASE collation on warranty_item_types_name_uq      (0003)
--  10. warranty_items.type_id arriving by ALTER TABLE ADD COLUMN        (0003)
--  11. the CHECK constraint on warranty_item_types.kind below           (0004)
--  12. warranty_item_types.kind itself arriving by ALTER TABLE ADD COLUMN (0004)
ALTER TABLE `warranty_item_types` ADD COLUMN `kind` text NOT NULL DEFAULT 'warranty' CHECK (`kind` IN ('warranty', 'subscription', 'contract', 'loan'));
--> statement-breakpoint
UPDATE `warranty_item_types` SET `kind` = 'subscription' WHERE `is_subscription` = 1;
--> statement-breakpoint
INSERT INTO `warranty_item_types` (`name`, `is_subscription`, `kind`, `created_at`)
	SELECT 'Contract', 0, 'contract', '2026-08-17T00:00:00.000Z'
	WHERE NOT EXISTS (SELECT 1 FROM `warranty_item_types` WHERE `name` = 'Contract' COLLATE NOCASE);
--> statement-breakpoint
INSERT INTO `warranty_item_types` (`name`, `is_subscription`, `kind`, `created_at`)
	SELECT 'Loan', 0, 'loan', '2026-08-17T00:00:00.000Z'
	WHERE NOT EXISTS (SELECT 1 FROM `warranty_item_types` WHERE `name` = 'Loan' COLLATE NOCASE);
