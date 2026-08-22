/**
 * Every route that renders a category's name or the category hierarchy to a user. Found by
 * grepping the app for `listCategories`/`categoryName`/`categoryId`
 * rather than trusting the three routes the bug report happened to name:
 *   - /settings/managers  -- this page; the category table itself.
 *   - /transactions       -- the per-row category and the filter list.
 *   - /reports            -- category breakdown and series.
 *   - /budgets            -- budgetProgress() rows, keyed by category, incl. nested children.
 *   - /dashboard          -- the "this month's budgets" table (budgetProgress() again) and
 *                            the account-setup callout's category-driven copy.
 *   - /review             -- the category picker offered for each queued transaction.
 * A category mutation (create, rename, archive) must revalidate every one of these or Next's
 * client router cache serves the pre-mutation page for up to ~30s. Every category mutation
 * in actions.ts loops over this SAME constant -- and the test in
 * tests/app/managers-actions.test.ts reads it too -- so a route added here without a matching
 * revalidatePath call fails the test, instead of a future page silently joining the
 * "never revalidated" set the way /budgets, /reports and /dashboard did.
 *
 * This constant lives in its own module, separate from actions.ts, because actions.ts starts
 * with 'use server': a 'use server' file may export ONLY async functions, and an array export
 * there throws at require-time in production (every other export in that file already is an
 * async function, which is exactly why this was the one export that got away with it in dev
 * and in the vitest suite, neither of which apply 'use server' module semantics, and only broke
 * when the real Next server required the compiled module).
 */
export const CATEGORY_RENDERING_ROUTES = [
  '/settings/managers',
  '/transactions',
  '/reports',
  '/budgets',
  '/dashboard',
  '/review',
] as const;
