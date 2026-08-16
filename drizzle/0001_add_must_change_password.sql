-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the column in
-- src/db/schema.ts -- in that order.
--
-- Forced password change on first login (spec v1.5, supersedes ruling R29).
-- Existing rows default to 0: nobody who already signed in is retroactively gated.
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT 0 NOT NULL;
