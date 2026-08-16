import { and, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { categories, transactions, users } from '@/db/schema';
import { listCategories } from '@/lib/categories';
import { addMonths, monthEnd, monthOf, monthRange, monthStart } from '@/lib/dates';
import { netSpentCents } from '@/lib/money';
import { listTransactions, type TransactionFilter } from '@/lib/transactions';

export interface DateRange {
  from: string;
  to: string;
}

export const UNATTRIBUTED_LABEL = 'Household/unattributed';

type PersonScope = number | 'unattributed' | null | undefined;

function personClause(scope: PersonScope): SQL | null {
  if (scope === undefined || scope === null) return null;
  if (scope === 'unattributed') return isNull(transactions.attributedUserId);
  return eq(transactions.attributedUserId, scope);
}

function rangeClauses(range: DateRange, scope: PersonScope): SQL[] {
  const clauses: SQL[] = [
    gte(transactions.date, range.from),
    lte(transactions.date, range.to),
    // Transfers are excluded from every report series.
    eq(transactions.isTransfer, false),
  ];
  const person = personClause(scope);
  if (person) clauses.push(person);
  return clauses;
}

export interface CategoryBreakdownRow {
  categoryId: number | null;
  categoryName: string;
  parentId: number | null;
  isIncome: boolean;
  spentCents: number;
}

export function categoryBreakdown(
  input: DateRange & { attributedUserId?: PersonScope; rollup?: boolean; includeIncome?: boolean },
): CategoryBreakdownRow[] {
  const rows = getDb()
    .select({ categoryId: transactions.categoryId, total: sql<number>`sum(${transactions.amountCents})` })
    .from(transactions)
    .where(and(...rangeClauses(input, input.attributedUserId)))
    .groupBy(transactions.categoryId)
    .all();

  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const spendByCategory = new Map<number | null, number>();
  for (const row of rows) spendByCategory.set(row.categoryId, netSpentCents(row.total ?? 0));

  const result: CategoryBreakdownRow[] = [];
  const emit = (categoryId: number | null, spentCents: number) => {
    const category = categoryId === null ? null : byId.get(categoryId);
    const isIncome = category?.isIncome ?? false;
    if (!input.includeIncome && isIncome) return;
    result.push({
      categoryId,
      categoryName: category?.name ?? 'Uncategorized',
      parentId: category?.parentId ?? null,
      isIncome,
      spentCents,
    });
  };

  if (input.rollup) {
    const rolled = new Map<number | null, number>();
    for (const [categoryId, spent] of spendByCategory) {
      if (categoryId === null) {
        rolled.set(null, (rolled.get(null) ?? 0) + spent);
        continue;
      }
      const category = byId.get(categoryId);
      const target = category?.parentId ?? categoryId;
      rolled.set(target, (rolled.get(target) ?? 0) + spent);
    }
    for (const [categoryId, spent] of rolled) emit(categoryId, spent);
  } else {
    for (const [categoryId, spent] of spendByCategory) emit(categoryId, spent);
  }

  return result.sort((a, b) => b.spentCents - a.spentCents);
}

export interface MonthTrendRow {
  month: string;
  incomeCents: number;
  spendCents: number;
  netCents: number;
}

export function cashflowTrend(months: number, opts: { endMonth?: string; attributedUserId?: PersonScope } = {}): MonthTrendRow[] {
  const endMonth = opts.endMonth ?? monthOf(new Date().toISOString().slice(0, 10));
  const startMonth = addMonths(endMonth, -(months - 1));
  const keys = monthRange(startMonth, endMonth);

  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      isIncome: categories.isIncome,
      total: sql<number>`sum(${transactions.amountCents})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...rangeClauses({ from: monthStart(startMonth), to: monthEnd(endMonth) }, opts.attributedUserId)))
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, categories.isIncome)
    .all();

  const income = new Map<string, number>();
  const spend = new Map<string, number>();
  for (const row of rows) {
    // Income counts ONLY is_income categories; everything else (including
    // uncategorized rows) is spend, netted.
    if (row.isIncome) income.set(row.month, (income.get(row.month) ?? 0) + (row.total ?? 0));
    else spend.set(row.month, (spend.get(row.month) ?? 0) + (row.total ?? 0));
  }

  return keys.map((month) => {
    const incomeCents = income.get(month) ?? 0;
    const spendCents = netSpentCents(spend.get(month) ?? 0);
    return { month, incomeCents, spendCents, netCents: incomeCents - spendCents };
  });
}

export interface CategoryMonthTrend {
  categoryId: number;
  categoryName: string;
  byMonth: Record<string, number>;
  totalCents: number;
}

export function categoryMonthOverMonth(input: {
  fromMonth: string;
  toMonth: string;
  attributedUserId?: PersonScope;
  limit?: number;
}): { months: string[]; rows: CategoryMonthTrend[] } {
  const months = monthRange(input.fromMonth, input.toMonth);
  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      categoryId: transactions.categoryId,
      total: sql<number>`sum(${transactions.amountCents})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        ...rangeClauses({ from: monthStart(input.fromMonth), to: monthEnd(input.toMonth) }, input.attributedUserId),
        eq(categories.isIncome, false),
      ),
    )
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, transactions.categoryId)
    .all();

  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const trends = new Map<number, CategoryMonthTrend>();

  for (const row of rows) {
    if (row.categoryId === null) continue;
    let trend = trends.get(row.categoryId);
    if (!trend) {
      trend = {
        categoryId: row.categoryId,
        categoryName: byId.get(row.categoryId)?.name ?? 'Unknown',
        byMonth: Object.fromEntries(months.map((month) => [month, 0])),
        totalCents: 0,
      };
      trends.set(row.categoryId, trend);
    }
    const spent = netSpentCents(row.total ?? 0);
    trend.byMonth[row.month] = spent;
    trend.totalCents += spent;
  }

  const sorted = [...trends.values()].sort((a, b) => b.totalCents - a.totalCents);
  return { months, rows: input.limit ? sorted.slice(0, input.limit) : sorted };
}

export interface PersonSplitRow {
  userId: number | null;
  label: string;
  spentCents: number;
}

export function personSpendSplit(input: DateRange): PersonSplitRow[] {
  const rows = getDb()
    .select({ userId: transactions.attributedUserId, total: sql<number>`sum(${transactions.amountCents})` })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...rangeClauses(input, undefined), sql`coalesce(${categories.isIncome}, 0) = 0`))
    .groupBy(transactions.attributedUserId)
    .all();

  const people = getDb().select({ id: users.id, name: users.name }).from(users).all();
  const spendByUser = new Map<number | null, number>();
  for (const row of rows) spendByUser.set(row.userId, netSpentCents(row.total ?? 0));

  const result: PersonSplitRow[] = people
    .filter((person) => spendByUser.has(person.id))
    .map((person) => ({ userId: person.id, label: person.name, spentCents: spendByUser.get(person.id) ?? 0 }));

  // The unattributed bucket is always present — never silently dropped.
  result.push({ userId: null, label: UNATTRIBUTED_LABEL, spentCents: spendByUser.get(null) ?? 0 });
  return result.sort((a, b) => b.spentCents - a.spentCents);
}

export interface TopMerchantRow {
  normalizedMerchant: string;
  spentCents: number;
  count: number;
}

export function topMerchants(input: DateRange & { limit?: number; attributedUserId?: PersonScope }): TopMerchantRow[] {
  const rows = getDb()
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      total: sql<number>`sum(${transactions.amountCents})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...rangeClauses(input, input.attributedUserId), sql`coalesce(${categories.isIncome}, 0) = 0`))
    .groupBy(transactions.normalizedMerchant)
    .all();

  return rows
    .map((row) => ({ normalizedMerchant: row.normalizedMerchant, spentCents: netSpentCents(row.total ?? 0), count: row.count }))
    .filter((row) => row.spentCents > 0)
    .sort((a, b) => b.spentCents - a.spentCents)
    .slice(0, input.limit ?? 10);
}

export interface CsvColumn<T> {
  key: keyof T & string;
  header: string;
}

/**
 * Fields a spreadsheet would execute rather than display. Excel/Sheets/LibreOffice all
 * treat a leading =, +, - or @ as the start of a formula, and a leading tab as a cell
 * separator that shifts the payload into the next cell — so a transaction note reading
 * `=SUM(1)` (or worse, a WEBSERVICE/HYPERLINK call) would run on open. Bank descriptions
 * are attacker-influenced text in exactly the way this attack needs.
 */
const FORMULA_TRIGGER = /^[=+\-@\t]/;

/**
 * ...except a plain number. Spend is stored negative, so the Amount column is full of
 * values like "-45.00": those start with a trigger character but are numeric literals,
 * not formulas, and quoting them as text would break every sum in the exported sheet —
 * the one thing people export a CSV to do. Anything with an operator in it ("-2+3") fails
 * this test and is still guarded.
 */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * RFC 4180 quoting is preserved exactly as before; the injection guard is a separate,
 * earlier step that prefixes a single quote. The apostrophe is what spreadsheets read as
 * "this cell is literal text" — it is not shown in the cell, and a plain-text reader sees
 * one extra leading character, which is the accepted cost of the guard.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_TRIGGER.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function transactionsCsv(filter: TransactionFilter): string {
  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const page = listTransactions({ ...filter, page: 1, pageSize: 200 });
  const rows: Record<string, unknown>[] = [];

  for (let pageNumber = 1; pageNumber <= page.pageCount; pageNumber += 1) {
    const chunk = pageNumber === 1 ? page : listTransactions({ ...filter, page: pageNumber, pageSize: 200 });
    for (const row of chunk.rows) {
      const category = row.categoryId === null ? null : byId.get(row.categoryId);
      const parent = category?.parentId ? byId.get(category.parentId) : undefined;
      rows.push({
        Date: row.date,
        Account: row.accountName,
        Description: row.rawDescription,
        Merchant: row.normalizedMerchant,
        Amount: (row.amountCents / 100).toFixed(2),
        Category: category ? (parent ? `${parent.name} > ${category.name}` : category.name) : 'Uncategorized',
        Person: row.attributedUserName ?? UNATTRIBUTED_LABEL,
        Transfer: row.isTransfer ? 'yes' : 'no',
        Source: row.source,
        Notes: row.notes ?? '',
      });
    }
  }

  return toCsv(rows, [
    { key: 'Date', header: 'Date' },
    { key: 'Account', header: 'Account' },
    { key: 'Description', header: 'Description' },
    { key: 'Merchant', header: 'Merchant' },
    { key: 'Amount', header: 'Amount' },
    { key: 'Category', header: 'Category' },
    { key: 'Person', header: 'Person' },
    { key: 'Transfer', header: 'Transfer' },
    { key: 'Source', header: 'Source' },
    { key: 'Notes', header: 'Notes' },
  ]);
}
