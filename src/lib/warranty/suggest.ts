import { addMonthsClamped, isIsoDate } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';

/**
 * Suggest-and-confirm (spec §8). Every extractor here is PURE: no I/O, no DB, and no clock
 * beyond the injected `today`, so the tests are deterministic. MUST-8.1: nothing here ever
 * auto-commits — the caller pre-fills form inputs the user can overwrite.
 */
export interface SuggestedFields {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
}

/** §8.3 step 5: a mis-read barcode or phone number must not present as a nine-figure total. */
export const MAX_SUGGESTED_PRICE_CENTS = 10_000_000;
export const MAX_SUGGESTION_AGE_MONTHS = 240;
export const MAX_VENDOR_CHARS = 60;

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(y: number, m: number, d: number): string | null {
  const candidate = `${y}-${pad2(m)}-${pad2(d)}`;
  return isIsoDate(candidate) ? candidate : null;
}

interface DateHit {
  index: number;
  iso: string;
}

function collectDateHits(text: string): DateHit[] {
  const hits: DateHit[] = [];

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const value = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (value) hits.push({ index: m.index ?? 0, iso: value });
  }

  // A/B/YYYY or A-B-YY. §8.1 step 3 ladder: A>12 -> DD/MM; else B>12 -> MM/DD; else MM/DD.
  for (const m of text.matchAll(/\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2}|\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const rawYear = Number(m[3]);
    const year = m[3].length === 2 ? 2000 + rawYear : rawYear;
    const [month, day] = a > 12 ? [b, a] : [a, b];
    const value = iso(year, month, day);
    if (value) hits.push({ index: m.index ?? 0, iso: value });
  }

  // DD Mon YYYY (the shape the Amex export already uses, base §3).
  for (const m of text.matchAll(/\b(\d{1,2})[\s-]([A-Za-z]{3,9})\.?,?[\s-](\d{4})\b/g)) {
    const month = MONTHS[m[2].slice(0, 3).toUpperCase()];
    if (!month) continue;
    const value = iso(Number(m[3]), month, Number(m[1]));
    if (value) hits.push({ index: m.index ?? 0, iso: value });
  }

  // Mon D, YYYY
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[1].slice(0, 3).toUpperCase()];
    if (!month) continue;
    const value = iso(Number(m[3]), month, Number(m[2]));
    if (value) hits.push({ index: m.index ?? 0, iso: value });
  }

  return hits;
}

export function suggestPurchaseDate(text: string, today: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const floor = addMonthsClamped(today, -MAX_SUGGESTION_AGE_MONTHS);
  const survivors = collectDateHits(text)
    .filter((hit) => hit.iso <= today && hit.iso >= floor)
    // §8.1 step 4: earliest OCCURRENCE in the text (receipt headers print the
    // transaction date before any expiry or promo date). Ties break on first match.
    .sort((a, b) => a.index - b.index);
  return survivors[0]?.iso;
}

const VENDOR_SKIP_RE = /^(receipt|invoice|order|tel|phone|fax|www\.|https?:|\d)/i;

export function suggestVendor(text: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
  for (const line of lines) {
    const letters = line.match(/\p{L}/gu)?.length ?? 0;
    if (letters < 3) continue;
    if (VENDOR_SKIP_RE.test(line)) continue;
    return line.slice(0, MAX_VENDOR_CHARS);
  }
  return undefined;
}

// Digit run bounded to 9 (not `\d+`) to prevent quadratic backtracking on a long unbroken
// digit run (garbled barcode OCR): an unbounded `\d+` alternative backtracks O(L) at each of
// L start positions, i.e. O(L^2) on the ~100k-char OCR cap. No valid amount is lost — a
// 10+-digit whole-dollar amount already exceeds the $100,000 ceiling and is rejected by
// centsOf() regardless (amended after Task 4 review; spec §8.3 step 3 mirrors this).
const CURRENCY_RE = /(?:\$\s*)?(\d{1,3}(?:,\d{3})*|\d{1,9})[.,](\d{2})(?!\d)/g;
const TOTAL_LINE_RE = /\b(total|amount due|grand total|balance due)\b/i;
const SUBTOTAL_RE = /\bsub[\s-]?total\b/i;

function centsOf(whole: string, fraction: string): number | null {
  // One money parser in the app (MUST-13.5): integer cents, no floats.
  const cents = parseAmountToCents(`${whole}.${fraction}`);
  if (cents === null) return null;
  const magnitude = Math.abs(cents);
  if (magnitude <= 0 || magnitude >= MAX_SUGGESTED_PRICE_CENTS) return null;
  return magnitude;
}

export function suggestPriceCents(text: string): number | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;

  // 1. TOTAL-line pass: the LAST currency number on the LAST qualifying line. Deliberately
  // more liberal than the spec's literal "last number" step: if the last candidate on the
  // line fails validation (e.g. it's >= the noise ceiling), we walk backward and try earlier
  // candidates on the same line rather than falling through to the anywhere-in-text fallback.
  const totalLines = text.split(/\r?\n/).filter((line) => TOTAL_LINE_RE.test(line) && !SUBTOTAL_RE.test(line));
  const lastTotalLine = totalLines[totalLines.length - 1];
  if (lastTotalLine !== undefined) {
    const matches = [...lastTotalLine.matchAll(CURRENCY_RE)];
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const cents = centsOf(matches[i][1], matches[i][2]);
      if (cents !== null) return cents;
    }
  }

  // 2. Fallback: the largest currency-formatted number anywhere.
  let best: number | undefined;
  for (const m of text.matchAll(CURRENCY_RE)) {
    const cents = centsOf(m[1], m[2]);
    if (cents === null) continue;
    if (best === undefined || cents > best) best = cents;
  }
  return best;
}

export function suggestFromOcrText(text: string, today: string): SuggestedFields {
  const out: SuggestedFields = {};
  const purchaseDate = suggestPurchaseDate(text, today);
  if (purchaseDate !== undefined) out.purchaseDate = purchaseDate;
  const vendor = suggestVendor(text);
  if (vendor !== undefined) out.vendor = vendor;
  const priceCents = suggestPriceCents(text);
  if (priceCents !== undefined) out.priceCents = priceCents;
  return out;
}
