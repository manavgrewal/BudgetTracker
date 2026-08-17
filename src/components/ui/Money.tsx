import { formatCents } from '@/lib/money';

/**
 * A signed amount, coloured by its sign and set in tabular figures.
 *
 * One component so the money pair is applied identically on every surface —
 * a ledger row, a report total, a warranty price — instead of each page
 * deciding for itself which green it likes.
 *
 * `plain` is for magnitudes rather than signed amounts: "spent this month" is
 * a positive number that means money left, so painting it green would be a
 * lie. Those keep the tabular figures and drop the colour.
 */
export function Money({
  cents,
  showSign = false,
  plain = false,
  className = '',
}: {
  cents: number;
  showSign?: boolean;
  plain?: boolean;
  className?: string;
}) {
  const tone = plain ? '' : cents < 0 ? 'money-neg' : cents > 0 ? 'money-pos' : '';
  return <span className={`money ${tone} ${className}`}>{formatCents(cents, { showSign })}</span>;
}
