-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- Warranty tracker (spec 2026-08-16). Objects that exist ONLY in SQL and have NO Drizzle
-- representation now number, after this migration:
--   1. the categories.parent_id self-referencing foreign key            (0000)
--   2. the COALESCE(display_description, raw_description) expression index (0000)
--   3. the COALESCE month expression index                              (0000)
--   4. every CHECK constraint declared below on warranty_items          (0002)
--   5. every CHECK constraint declared below on warranty_receipts       (0002)
--   6. the warranty_search FTS5 contentless virtual table               (0002)
--   7. its six triggers, which are its ONLY writer                      (0002)
-- Statements below are separated by the breakpoint marker line (arrow, then the words
-- statement hyphen breakpoint): Drizzle's migrator splits the file on that literal marker
-- and nothing else, which is what makes the CREATE TRIGGER ... BEGIN ...; ...; END; bodies
-- below safe. A splitter keyed on ";" would shred them.
-- NEVER write that marker literally anywhere in this file, comments included:
-- the splitter is comment-blind ("-->" immediately followed by "statement-breakpoint"
-- in a comment creates a bogus comment-only chunk that better-sqlite3 rejects).
CREATE TABLE `warranty_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`vendor` text,
	`model` text,
	`serial` text,
	`purchase_date` text NOT NULL,
	`warranty_months` integer,
	`is_lifetime` integer DEFAULT 0 NOT NULL,
	`expiry_date` text,
	`price_cents` integer,
	`owner_user_id` integer NOT NULL REFERENCES `users`(`id`),
	`transaction_id` integer REFERENCES `transactions`(`id`) ON DELETE SET NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (`is_lifetime` IN (0, 1)),
	CHECK (`is_lifetime` = 0 OR (`warranty_months` IS NULL AND `expiry_date` IS NULL)),
	CHECK (`warranty_months` IS NULL OR `warranty_months` > 0),
	CHECK ((`warranty_months` IS NULL) = (`expiry_date` IS NULL)),
	CHECK (`price_cents` IS NULL OR `price_cents` >= 0)
);
--> statement-breakpoint
CREATE INDEX `warranty_items_expiry_idx` ON `warranty_items` (`expiry_date`);
--> statement-breakpoint
CREATE INDEX `warranty_items_owner_idx` ON `warranty_items` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX `warranty_items_transaction_idx` ON `warranty_items` (`transaction_id`);
--> statement-breakpoint
CREATE TABLE `warranty_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`warranty_item_id` integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
	`original_filename` text NOT NULL,
	`stored_filename` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`ocr_text` text,
	`ocr_status` text DEFAULT 'pending' NOT NULL,
	`ocr_error` text,
	`created_at` text NOT NULL,
	CHECK (`ocr_status` IN ('pending', 'done', 'failed')),
	CHECK (`mime` IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
	CHECK (`size_bytes` > 0 AND `size_bytes` <= 10485760)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warranty_receipts_stored_uq` ON `warranty_receipts` (`stored_filename`);
--> statement-breakpoint
CREATE INDEX `warranty_receipts_item_idx` ON `warranty_receipts` (`warranty_item_id`);
--> statement-breakpoint
CREATE INDEX `warranty_receipts_ocr_idx` ON `warranty_receipts` (`ocr_status`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `warranty_search` USING fts5(
	`name`, `vendor`, `model`, `notes`, `ocr_text`,
	content='', contentless_delete=1,
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `warranty_search_item_ai` AFTER INSERT ON `warranty_items` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_item_au`
AFTER UPDATE OF `name`, `vendor`, `model`, `notes` ON `warranty_items` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_item_ad` AFTER DELETE ON `warranty_items` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_receipt_ai` AFTER INSERT ON `warranty_receipts` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`warranty_item_id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`warranty_item_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_receipt_au`
AFTER UPDATE OF `ocr_text` ON `warranty_receipts` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`warranty_item_id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`warranty_item_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_receipt_ad` AFTER DELETE ON `warranty_receipts` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = old.`warranty_item_id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = old.`warranty_item_id`;
END;
