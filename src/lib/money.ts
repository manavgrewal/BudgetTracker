const CENT_FORMATTER = new Intl.NumberFormat('en-CA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Parses a bank CSV amount cell into integer cents.
 * Handles: $ / CAD prefixes, thousands separators, unicode minus, accounting parentheses.
 * Returns null when the cell is blank or not a single well-formed number.
 */
export function parseAmountToCents(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.length === 0) return null;

  // Normalise unicode minus / non-breaking spaces.
  text = text.replace(/−/g, '-').replace(/ /g, ' ');

  let negative = false;
  const parenMatch = /^\((.*)\)$/.exec(text);
  if (parenMatch) {
    negative = true;
    text = parenMatch[1].trim();
  }

  // Strip currency words/symbols and spaces.
  text = text.replace(/(?:CAD|USD|\$)/gi, '').replace(/\s+/g, '');
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  text = text.replace(/,/g, '');

  if (text.length === 0) return null;
  if (!/^\d*(?:\.\d*)?$/.test(text)) return null;
  if (text === '.' || text === '') return null;

  const [whole, fraction = ''] = text.split('.');
  const wholePart = whole === '' ? '0' : whole;
  // Round half away from zero on the third decimal onward.
  const scaled = Number(`${wholePart}.${fraction}`) * 100;
  if (!Number.isFinite(scaled)) return null;
  const cents = Math.round(Math.abs(scaled) + Number.EPSILON * Math.abs(scaled));
  const signed = negative ? -cents : cents;
  return signed === 0 ? 0 : signed;
}

export function formatCents(cents: number, opts: { showSign?: boolean; currency?: boolean } = {}): string {
  const { showSign = false, currency = true } = opts;
  const negative = cents < 0;
  const body = CENT_FORMATTER.format(Math.abs(cents) / 100);
  const symbol = currency ? '$' : '';
  if (negative) return `-${symbol}${body}`;
  if (showSign && cents > 0) return `+${symbol}${body}`;
  return `${symbol}${body}`;
}

export function sumCents(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * Refund netting (spec section 3): net spend for a category is the NEGATION of the
 * signed sum of its rows. A positive (refund) amount therefore reduces spend.
 * Not clamped at zero — a net-positive non-income category is real information.
 */
export function netSpentCents(signedSum: number): number {
  const value = -signedSum;
  return value === 0 ? 0 : value;
}

export function absCents(cents: number): number {
  return Math.abs(cents);
}

export function pctOf(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return (part / whole) * 100;
}
