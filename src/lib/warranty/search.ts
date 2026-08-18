import { getSqlite } from '@/db/client';
import { addDaysIso, todayIso } from '@/lib/dates';
import {
  EXPIRING_SOON_DAYS,
  STATUS_CASE_SQL,
  type WarrantyStatus,
} from '@/lib/warranty/expiry';
import type { WarrantyItemRow } from '@/lib/warranty/items';
import { WARRANTY_SORTS, isWarrantySort, type BillingCycle, type ItemKind, type WarrantySort } from '@/lib/warranty/constants';

/** §17.22 */
export const WARRANTY_PAGE_SIZE = 50;
export const MAX_SEARCH_TERMS = 20;
export const MAX_SEARCH_CHARS = 200;

/** MUST-9.3: never a 500, never a raw SQLite message. */
export const SEARCH_SYNTAX_ERROR = "That search couldn't be understood — try different words.";

// Ruling P4: the sort names themselves live in constants.ts (client-safe); re-exported here
// so server code (this module, actions, pages) has one familiar import path for both.
export { WARRANTY_SORTS, isWarrantySort, type WarrantySort };

/**
 * True for every ASCII control character: code points 0 through 31 (the C0 set — NUL, tab,
 * newline, escape, unit separator, and so on) plus 127 (DEL). Deliberately built from plain
 * numeric comparisons against hex integer literals, never a regex escape sequence: escape
 * syntax written into this exact spot has, more than once, been corrupted in transit into a
 * literal raw control byte sitting in the source file instead of the intended two-character
 * escape text — this formulation has no escape syntax anywhere for anything to mis-decode.
 */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || codePoint === 0x7f;
}

/** Replaces every control character in `value` with an ordinary space, code point by code point. */
function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    out += isControlCodePoint(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  }
  return out;
}

/**
 * MUST-9.1 — FTS5 injection defence. FTS5 has its own query language: bare AND/OR/NOT/NEAR,
 * caret, colon, hyphen, star, parentheses and the double-quote character are all operators,
 * and an unbalanced quote is a syntax error that would otherwise surface as a 500 on a
 * perfectly ordinary search for `26" monitor`.
 *
 *   0. CRITICAL fix: scrub every control character (see isControlCodePoint above) to a
 *      plain space FIRST. None of them are whitespace to JS regex's `\s`, so left alone one
 *      survives term-splitting untouched and gets wrapped as its own literal quoted phrase;
 *      SQLite's FTS5 tokenizer then raises a genuine driver-level syntax error for that
 *      phrase (verified directly against better-sqlite3) — without this scrub, a request
 *      like GET /warranties?q=%00 would depend entirely on the safety net below instead of
 *      never producing a malformed query in the first place.
 *   1. trim, cap the raw input at 200 characters, split on whitespace
 *   2. drop empty terms; nothing left -> null (the caller omits MATCH entirely)
 *   3. wrap each term in double quotes, DOUBLING any internal double quote — a quoted
 *      string in FTS5 is a literal phrase, so every operator inside it loses its meaning
 *   4. append `*` to the LAST term only (type-ahead prefix matching), but only when that
 *      term still contains a letter or a digit: a lone double-quote character escapes to
 *      four double-quotes back to back — an empty phrase, and not a query worth
 *      constructing (spec §9.1's last table row)
 *   5. join with a single space (FTS5's implicit AND)
 *   6. cap at 20 terms
 */
export function escapeFtsQuery(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const terms = stripControlChars(raw)
    .trim()
    .slice(0, MAX_SEARCH_CHARS)
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, MAX_SEARCH_TERMS);
  if (terms.length === 0) return null;

  const quoted = terms.map((term) => `"${term.replace(/"/g, '""')}"`);
  const last = terms[terms.length - 1];
  if (/[\p{L}\p{N}]/u.test(last)) quoted[quoted.length - 1] = `${quoted[quoted.length - 1]}*`;
  return quoted.join(' ');
}

export interface WarrantyListItem extends WarrantyItemRow {
  status: WarrantyStatus;
  receiptCount: number;
}

export interface WarrantySearchFilter {
  q?: string | null;
  ownerUserId?: number | null;
  status?: WarrantyStatus | null;
  /** Delta T6: composes with q/ownerUserId/status/sort like every other filter here. */
  typeId?: number | null;
  sort?: WarrantySort;
  page?: number;
  today?: string;
}

export interface WarrantySearchResult {
  rows: WarrantyListItem[];
  total: number;
  page: number;
  pageCount: number;
  error?: string;
}

/**
 * MUST-9.4: default order is soonest expiry first, unknown/lifetime last. Searching FILTERS;
 * it does not reorder. An FTS `rank` ordering would shuffle the expiry list the moment
 * someone typed, which is the opposite of what this page is for.
 */
const ORDER_BY: Record<WarrantySort, string> = {
  expiry: 'i.expiry_date is null, i.expiry_date asc, i.name asc',
  name: 'i.name asc, i.expiry_date asc',
  purchase: 'i.purchase_date desc, i.name asc',
};

interface RawRow {
  id: number;
  name: string;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  purchase_date: string;
  warranty_months: number | null;
  is_lifetime: number;
  expiry_date: string | null;
  price_cents: number | null;
  owner_user_id: number;
  owner_name: string;
  transaction_id: number | null;
  type_id: number | null;
  type_name: string | null;
  is_subscription: number | null;
  kind: ItemKind | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  billing_cycle: BillingCycle | null;
  billing_amount_cents: number | null;
  principal_cents: number | null;
  interest_rate_bps: number | null;
  current_balance_cents: number | null;
  balance_updated_at: string | null;
  status: WarrantyStatus;
  receipt_count: number;
}

function toListItem(row: RawRow): WarrantyListItem {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    model: row.model,
    serial: row.serial,
    purchaseDate: row.purchase_date,
    warrantyMonths: row.warranty_months,
    isLifetime: row.is_lifetime === 1,
    expiryDate: row.expiry_date,
    priceCents: row.price_cents,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    transactionId: row.transaction_id,
    typeId: row.type_id,
    typeName: row.type_name,
    // Delta T6: the LEFT JOIN yields NULL for an untyped item -- normalise to false, same
    // as items.ts's toItemRow(), so callers never see a three-state value.
    isSubscription: row.is_subscription === 1,
    // v1.2.2: same normalisation, to 'warranty' instead of false (items.ts's toItemRow()).
    kind: row.kind ?? 'warranty',
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    billingCycle: row.billing_cycle,
    billingAmountCents: row.billing_amount_cents,
    principalCents: row.principal_cents,
    interestRateBps: row.interest_rate_bps,
    currentBalanceCents: row.current_balance_cents,
    balanceUpdatedAt: row.balance_updated_at,
    status: row.status,
    receiptCount: row.receipt_count,
  };
}

export function searchWarrantyItems(filter: WarrantySearchFilter = {}): WarrantySearchResult {
  const today = filter.today ?? todayIso();
  const soon = addDaysIso(today, EXPIRING_SOON_DAYS);
  // IMPORTANT 2 (defensive SQL-boundary guards): `page`/`sort` ultimately trace back to
  // parsed URL query params upstream of this function. Number.isFinite is checked BEFORE
  // Math.max/Math.floor so a NaN or +/-Infinity page value can't slip through arithmetic
  // that would otherwise pass a non-finite LIMIT/OFFSET straight to SQLite; an unrecognised
  // sort name falls back to the documented default instead of hitting ORDER_BY with a key
  // it doesn't have.
  const page = Number.isFinite(filter.page) ? Math.max(1, Math.floor(filter.page as number)) : 1;
  const sort = filter.sort !== undefined && isWarrantySort(filter.sort) ? filter.sort : 'expiry';
  const match = filter.q ? escapeFtsQuery(filter.q) : null;

  // Delta T6: LEFT JOIN, unconditional -- an untyped item (type_id null) must still list,
  // and type_name/is_subscription must be available on every row regardless of whether a
  // type filter is even in play.
  const joins = [
    `inner join users u on u.id = i.owner_user_id`,
    `left join warranty_item_types t on t.id = i.type_id`,
  ];
  // The JOIN and the MATCH clause are BOTH omitted when there is no query, so an empty
  // search box lists everything instead of listing nothing.
  if (match !== null) joins.push('join warranty_search s on s.rowid = i.id');

  const where: string[] = [];
  const whereParams: unknown[] = [];
  if (match !== null) {
    // MUST-9.2: always a BOUND parameter, never string concatenation.
    where.push('warranty_search match ?');
    whereParams.push(match);
  }
  if (filter.ownerUserId != null) {
    where.push('i.owner_user_id = ?');
    whereParams.push(filter.ownerUserId);
  }
  if (filter.status != null) {
    where.push(`${STATUS_CASE_SQL} = ?`);
    whereParams.push(today, soon, filter.status);
  }
  if (filter.typeId != null) {
    where.push('i.type_id = ?');
    whereParams.push(filter.typeId);
  }
  const whereSql = where.length > 0 ? `where ${where.join(' and ')}` : '';

  const from = `from warranty_items i ${joins.join(' ')} ${whereSql}`;
  const selectSql = `select i.*, u.name as owner_name, t.name as type_name, t.is_subscription as is_subscription,
      t.kind as kind,
      ${STATUS_CASE_SQL} as status,
      (select count(*) from warranty_receipts r where r.warranty_item_id = i.id) as receipt_count
    ${from}
    order by ${ORDER_BY[sort]}
    limit ? offset ?`;
  // Parameter order follows textual order: the SELECT's status CASE binds first.
  const selectParams = [today, soon, ...whereParams, WARRANTY_PAGE_SIZE, (page - 1) * WARRANTY_PAGE_SIZE];

  const sqlite = getSqlite();
  try {
    const rows = sqlite.prepare(selectSql).all(...selectParams) as RawRow[];
    const { total } = sqlite.prepare(`select count(*) as total ${from}`).get(...whereParams) as { total: number };
    return {
      rows: rows.map(toListItem),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / WARRANTY_PAGE_SIZE)),
    };
  } catch (error) {
    // IMPORTANT 2 (structural safety net, not string-matching): SQLite's FTS5 raises many
    // different English messages for what is fundamentally the same class of problem —
    // "unterminated string", "fts5: syntax error near ...", "no such column", "expected
    // integer", "unknown special query", and so on, and the exact wording is not a
    // contract this code should depend on keeping in sync with. What IS a stable contract
    // is the driver's own `.code`: every one of those cases surfaces as
    // `SQLITE_ERROR` (verified directly against better-sqlite3 for each). Scoped to
    // `match !== null` — a SQLITE_ERROR that has nothing to do with the MATCH clause (a
    // genuine bug elsewhere in this function) must still surface as a real error rather
    // than being swallowed as "that search couldn't be understood".
    const code = (error as { code?: string }).code;
    if (match !== null && code === 'SQLITE_ERROR') {
      return { rows: [], total: 0, page, pageCount: 1, error: SEARCH_SYNTAX_ERROR };
    }
    throw error;
  }
}

/**
 * MUST-10.5: the dashboard widget — status 'expiring', soonest first, top N. `limit` is the
 * caller's own cap (e.g. 5 for the widget); it is applied client-side, after
 * searchWarrantyItems() has already paged at WARRANTY_PAGE_SIZE, so `limit` must stay at or
 * under WARRANTY_PAGE_SIZE for this function to see enough rows to slice from.
 */
export function expiringSoonItems(
  limit: number,
  ownerUserId: number | null = null,
  today: string = todayIso(),
): WarrantyListItem[] {
  return searchWarrantyItems({ status: 'expiring', ownerUserId, sort: 'expiry', today }).rows.slice(0, limit);
}
