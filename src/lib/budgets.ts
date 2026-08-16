import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { budgets, transactions } from '@/db/schema';
import { listCategories, type CategoryRecord } from '@/lib/categories';
import { nowIso } from '@/lib/clock';
import { addMonths, isMonthKey, monthEnd, monthStart } from '@/lib/dates';
import { netSpentCents, pctOf } from '@/lib/money';

export type BudgetScope = 'household' | 'personal';

export interface BudgetRow {
  categoryId: number;
  categoryName: string;
  parentId: number | null;
  isIncome: boolean;
  isArchived: boolean;
  limitCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  pct: number | null;
  overBudget: boolean;
  children: BudgetRow[];
}

function assertMonth(month: string): void {
  if (!isMonthKey(month)) throw new Error(`Month must be YYYY-MM, got "${month}"`);
}

function scopeCondition(scope: BudgetScope, userId: number | null) {
  return scope === 'personal'
    ? and(eq(budgets.scope, 'personal'), eq(budgets.userId, userId as number))
    : and(eq(budgets.scope, 'household'), isNull(budgets.userId));
}

/**
 * The newest row at or before `month` for this (scope, user, category).
 * A row with amount_cents = NULL means "cleared from here forward" and resolves to null.
 */
export function resolveBudget(scope: BudgetScope, userId: number | null, categoryId: number, month: string): number | null {
  assertMonth(month);
  const row = getDb()
    .select({ amountCents: budgets.amountCents })
    .from(budgets)
    .where(and(scopeCondition(scope, userId), eq(budgets.categoryId, categoryId), lte(budgets.effectiveMonth, month)))
    .orderBy(sql`${budgets.effectiveMonth} desc`)
    .limit(1)
    .get();
  if (!row) return null;
  return row.amountCents;
}

export function upsertBudget(input: {
  scope: BudgetScope;
  userId: number | null;
  categoryId: number;
  month: string;
  amountCents: number | null;
}): void {
  assertMonth(input.month);
  if (input.scope === 'personal' && input.userId === null) throw new Error('Personal budgets require a user');
  if (input.scope === 'household' && input.userId !== null) throw new Error('Household budgets must not have a user');

  const db = getDb();
  const existing = db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(scopeCondition(input.scope, input.userId), eq(budgets.categoryId, input.categoryId), eq(budgets.effectiveMonth, input.month)),
    )
    .get();

  if (existing) {
    db.update(budgets).set({ amountCents: input.amountCents }).where(eq(budgets.id, existing.id)).run();
    return;
  }

  db.insert(budgets)
    .values({
      scope: input.scope,
      userId: input.userId,
      categoryId: input.categoryId,
      amountCents: input.amountCents,
      effectiveMonth: input.month,
      createdAt: nowIso(),
    })
    .run();
}

export function clearBudget(input: { scope: BudgetScope; userId: number | null; categoryId: number; month: string }): void {
  upsertBudget({ ...input, amountCents: null });
}

/**
 * Net spend per category for one month. Refunds net against spend, transfers are
 * excluded, and the result is keyed by the transaction's own category (rollup is
 * applied later, in budgetProgress).
 *
 * `scope` governs attribution: 'personal' filters to `attributedUserId` (required —
 * a missing user here is the same silent-wrong-number trap as an unguarded
 * `resolveBudget('personal', null, ...)`), 'household' always counts every row
 * regardless of attribution, and omitting `scope` falls back to filtering on
 * `attributedUserId` when one is given (back-compat for direct callers).
 */
export function categorySpend(
  month: string,
  opts: { attributedUserId?: number | null; scope?: BudgetScope } = {},
): Map<number, number> {
  assertMonth(month);
  if (opts.scope === 'personal' && (opts.attributedUserId === undefined || opts.attributedUserId === null)) {
    throw new Error('Personal category spend requires a user');
  }
  const clauses = [
    gte(transactions.date, monthStart(month)),
    lte(transactions.date, monthEnd(month)),
    eq(transactions.isTransfer, false),
    sql`${transactions.categoryId} is not null`,
  ];
  if (opts.scope !== 'household' && opts.attributedUserId !== undefined && opts.attributedUserId !== null) {
    clauses.push(eq(transactions.attributedUserId, opts.attributedUserId));
  }

  const rows = getDb()
    .select({ categoryId: transactions.categoryId, total: sql<number>`sum(${transactions.amountCents})` })
    .from(transactions)
    .where(and(...clauses))
    .groupBy(transactions.categoryId)
    .all();

  const result = new Map<number, number>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    result.set(row.categoryId, netSpentCents(row.total ?? 0));
  }
  return result;
}

/**
 * `pctOf` (money.ts) returns null for a zero limit, which is correct for "no limit"
 * but wrong for a real, explicit $0 limit: a $0 budget with any spend against it is
 * not "no data", it's maximally over. money.ts is not touched — this local branch
 * is the fix: a $0 limit with spend reports 100%, a $0 limit with no spend reports 0%.
 */
function computePct(limitCents: number | null, spentCents: number): number | null {
  if (limitCents === null) return null;
  if (limitCents === 0) return spentCents > 0 ? 100 : 0;
  return pctOf(spentCents, limitCents);
}

function buildRow(
  category: CategoryRecord,
  spendByCategory: Map<number, number>,
  scope: BudgetScope,
  userId: number | null,
  month: string,
  renderChildren: CategoryRecord[],
  rollupChildren: CategoryRecord[],
): BudgetRow {
  const childRows = renderChildren.map((child) =>
    buildRow(child, spendByCategory, scope, userId, month, [], []),
  );
  const ownSpend = spendByCategory.get(category.id) ?? 0;
  // Rollup rule: a parent counts its own transactions plus ALL children's — including
  // an archived child's, which is never rendered as its own row (rollupChildren is
  // archived-inclusive; renderChildren, used only for display, is not).
  const childrenSpend = rollupChildren.reduce((sum, child) => sum + (spendByCategory.get(child.id) ?? 0), 0);
  const spentCents = ownSpend + childrenSpend;
  const limitCents = resolveBudget(scope, userId, category.id, month);
  return {
    categoryId: category.id,
    categoryName: category.name,
    parentId: category.parentId,
    isIncome: category.isIncome,
    isArchived: category.isArchived,
    limitCents,
    spentCents,
    remainingCents: limitCents === null ? null : limitCents - spentCents,
    pct: computePct(limitCents, spentCents),
    overBudget: limitCents !== null && spentCents > limitCents,
    children: childRows,
  };
}

export function budgetProgress(month: string, scope: BudgetScope = 'household', userId: number | null = null): BudgetRow[] {
  assertMonth(month);
  if (scope === 'personal' && userId === null) throw new Error('Personal budget progress requires a user');

  // Archived-inclusive so an archived category's spend is never silently dropped from
  // the rollup; income categories are excluded entirely (finding 7 — not budgetable rows).
  const all = listCategories({ includeArchived: true }).filter((category) => !category.isIncome);
  const spendByCategory = categorySpend(month, {
    scope,
    attributedUserId: scope === 'personal' ? userId : undefined,
  });

  return all
    .filter((category) => category.parentId === null)
    // An archived top-level category only surfaces if it still carries real spend this
    // month (a read-only "(archived)" row) — otherwise it would just be dead clutter.
    .filter((category) => !category.isArchived || (spendByCategory.get(category.id) ?? 0) !== 0)
    .map((parent) => {
      const allChildren = all.filter((row) => row.parentId === parent.id);
      const renderChildren = allChildren.filter((row) => !row.isArchived);
      return buildRow(parent, spendByCategory, scope, userId, month, renderChildren, allChildren);
    });
}

/**
 * Totals across the TOP LEVEL only — children are already rolled into their parent.
 * Three numbers, deliberately not one "spent of limit": mixing all non-income spend
 * against only the rows that happen to have a resolved limit reads as a nonsense
 * percentage (e.g. "$3,200 of $1,000 budgeted" on a month with unbudgeted categories).
 *   - budgetedLimitCents / budgetedSpentCents: only rows with a resolved limit —
 *     this pair is what the progress bar should be driven by.
 *   - totalSpentCents: every non-income row's spend, budgeted or not (includes a
 *     surfaced archived top-level row's spend, per finding 2).
 */
export function budgetTotals(rows: BudgetRow[]): {
  budgetedLimitCents: number;
  budgetedSpentCents: number;
  totalSpentCents: number;
} {
  let budgetedLimitCents = 0;
  let budgetedSpentCents = 0;
  let totalSpentCents = 0;
  for (const row of rows) {
    if (row.isIncome) continue;
    totalSpentCents += row.spentCents;
    if (row.limitCents !== null) {
      budgetedLimitCents += row.limitCents;
      budgetedSpentCents += row.spentCents;
    }
  }
  return { budgetedLimitCents, budgetedSpentCents, totalSpentCents };
}

export function copyBudgetsFromPreviousMonth(month: string, scope: BudgetScope, userId: number | null): number {
  assertMonth(month);
  const previous = addMonths(month, -1);
  let copied = 0;
  // Archived-inclusive, to match budgetProgress: an archived category can still surface
  // as a read-only row carrying real spend, and dropping its limit here would silently
  // turn "$200 of $300" into unbudgeted spend the month after someone archives it.
  // Categories with no resolved limit last month are skipped anyway, so this only ever
  // copies limits that actually existed.
  for (const category of listCategories({ includeArchived: true })) {
    const amount = resolveBudget(scope, userId, category.id, previous);
    if (amount === null) continue;
    upsertBudget({ scope, userId, categoryId: category.id, month, amountCents: amount });
    copied += 1;
  }
  return copied;
}
