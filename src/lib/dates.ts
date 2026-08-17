// Deliberately @/lib/env-tz, NOT @/lib/env: this module is shared/isomorphic (reachable from
// client components via *-client.tsx), and @/lib/env statically imports node:fs/path/crypto
// for its SECRET_KEY file resolution, which cannot be bundled for the browser. See
// env-tz.ts's docblock.
import { readTz } from '@/lib/env-tz';

export type DateFormat =
  | 'MM/DD/YYYY'
  | 'DD/MM/YYYY'
  | 'YYYY-MM-DD'
  | 'YYYY/MM/DD'
  | 'MM/DD/YY'
  | 'DD-MMM-YYYY'
  | 'MMM DD, YYYY';

export const DATE_FORMATS: readonly DateFormat[] = [
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'MM/DD/YY',
  'DD-MMM-YYYY',
  'MMM DD, YYYY',
];

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

export function isDateFormat(value: string): value is DateFormat {
  return (DATE_FORMATS as readonly string[]).includes(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function buildIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Pure string math — never constructs a Date, so no timezone can shift the day. */
export function parseDateString(raw: string, format: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  switch (format) {
    case 'MM/DD/YYYY':
    case 'DD/MM/YYYY': {
      const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(text);
      if (!m) return null;
      const a = Number(m[1]);
      const b = Number(m[2]);
      const year = Number(m[3]);
      return format === 'MM/DD/YYYY' ? buildIso(year, a, b) : buildIso(year, b, a);
    }
    case 'MM/DD/YY': {
      const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/.exec(text);
      if (!m) return null;
      const yy = Number(m[3]);
      const year = yy >= 70 ? 1900 + yy : 2000 + yy;
      return buildIso(year, Number(m[1]), Number(m[2]));
    }
    case 'YYYY-MM-DD':
    case 'YYYY/MM/DD': {
      const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
      if (!m) return null;
      return buildIso(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    case 'DD-MMM-YYYY': {
      const m = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/.exec(text);
      if (!m) return null;
      const month = MONTH_NAMES[m[2].slice(0, 3).toUpperCase()];
      if (!month) return null;
      return buildIso(Number(m[3]), month, Number(m[1]));
    }
    case 'MMM DD, YYYY': {
      const m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
      if (!m) return null;
      const month = MONTH_NAMES[m[1].slice(0, 3).toUpperCase()];
      if (!month) return null;
      return buildIso(Number(m[3]), month, Number(m[2]));
    }
    default:
      return null;
  }
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return buildIso(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10))) === value;
}

export function isMonthKey(value: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return `${month}-${pad2(daysInMonth(year, m))}`;
}

function monthToIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1);
}

function indexToMonth(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${pad2(month)}`;
}

export function addMonths(month: string, delta: number): string {
  return indexToMonth(monthToIndex(month) + delta);
}

/**
 * Warranty expiry arithmetic (spec 2026-08-16 §3.6): CLAMP to the last day of the target
 * month. Date.prototype.setMonth OVERFLOWS instead (Jan 31 + 1 month -> Mar 2/3), which
 * would silently move a February expiry into March. Pure string math, so no timezone and
 * no DST boundary can shift the day.
 */
export function addMonthsClamped(isoDate: string, months: number): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const d = Number(isoDate.slice(8, 10));
  const t = m - 1 + months;
  const year = y + Math.floor(t / 12);
  const month = ((t % 12) + 12) % 12 + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Days-from-civil (proleptic Gregorian). Integer-only, no Date object. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/** ISO date + N days, pure string math (a DST boundary can never shift the result). */
export function addDaysIso(isoDate: string, days: number): string {
  const total = daysFromCivil(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), Number(isoDate.slice(8, 10))) + days;
  const { y, m, d } = civilFromDays(total);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Signed whole days from `fromIso` to `toIso`. */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  return (
    daysFromCivil(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)), Number(toIso.slice(8, 10))) -
    daysFromCivil(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)), Number(fromIso.slice(8, 10)))
  );
}

export function monthsBetween(fromMonth: string, toMonth: string): number {
  return monthToIndex(toMonth) - monthToIndex(fromMonth);
}

export function monthRange(startMonth: string, endMonth: string): string[] {
  const out: string[] = [];
  const start = monthToIndex(startMonth);
  const end = monthToIndex(endMonth);
  for (let i = start; i <= end; i += 1) out.push(indexToMonth(i));
  return out;
}

/** Whole calendar months from `fromIso` to `toIso`, minimum 1 (goal pace math, spec section 3). */
export function wholeMonthsUntil(fromIso: string, toIso: string): number {
  const diff = monthsBetween(monthOf(fromIso), monthOf(toIso));
  return Math.max(1, diff);
}

export function todayIso(now: Date = new Date(), tz?: string): string {
  const zone = tz ?? safeTz();
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function currentMonth(now: Date = new Date(), tz?: string): string {
  return monthOf(todayIso(now, tz));
}

const FULL_MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * '2026-08' -> 'August 2026', for headings and eyebrows.
 *
 * A lookup table rather than Intl: a month key has no day and no zone, and
 * feeding a synthesised Date to a formatter is exactly how a month key ends up
 * displaying as the previous month somewhere east of UTC. Unparseable input is
 * handed back untouched so a heading degrades to the raw key instead of NaN.
 */
export function monthLabel(month: string): string {
  if (!isMonthKey(month)) return month;
  const [year, index] = month.split('-');
  return `${FULL_MONTH_NAMES[Number(index) - 1]} ${year}`;
}

function safeTz(): string {
  return readTz();
}

/**
 * Budget effective-month resolution: the newest candidate month at or before `month`.
 * Returns null when no candidate applies yet.
 */
export function resolveEffectiveMonth(candidates: string[], month: string): string | null {
  let best: string | null = null;
  for (const candidate of candidates) {
    if (candidate > month) continue;
    if (best === null || candidate > best) best = candidate;
  }
  return best;
}
