import type { Config } from 'drizzle-kit';

/**
 * WARNING: migrations under ./drizzle are hand-maintained, not drizzle-kit-generated.
 * `drizzle/meta/_journal.json` exists but there is NO `0000_snapshot.json`, so running
 * `drizzle-kit generate` against this config would diff the schema against an empty
 * baseline and emit a new migration that re-creates all 19 existing tables -- the next
 * boot would then fail with "table users already exists".
 *
 * That regenerated SQL would also silently DROP three objects that exist only in
 * drizzle/0000_init.sql (drizzle-kit cannot infer them from src/db/schema.ts):
 *   1. categories.parent_id's self-referential FK (`REFERENCES categories(id)`)
 *   2. the `categories_name_parent_uq` expression index (COALESCE(parent_id, 0))
 *   3. the `budgets_scope_user_category_month_uq` expression index (COALESCE(user_id, 0))
 *
 * Do not run `drizzle-kit generate` without first hand-authoring a matching
 * 0000_snapshot.json (or a fresh baseline snapshot) that accounts for all three.
 * There is intentionally no `db:generate` script in package.json for this reason.
 */
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.BUDGET_DB_PATH ?? './.tmp-data/budget.db',
  },
} satisfies Config;
