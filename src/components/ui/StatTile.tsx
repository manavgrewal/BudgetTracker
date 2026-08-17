/**
 * The big-number display. Money is the content of this product, so the tile is
 * mostly whitespace around one figure: an eyebrow that names what is counted,
 * the number, and at most one line of context under it.
 *
 * `tone` colours the figure — 'positive'/'negative' are the money pair and are
 * the same two tokens used everywhere else an amount is signed.
 * `emphasis` promotes one tile per row to the hero size; a grid of equally loud
 * numbers has no hierarchy at all.
 */
export type StatTone = 'default' | 'positive' | 'negative' | 'accent';

const TONE_CLASS: Record<StatTone, string> = {
  default: 'text-ink',
  positive: 'money-pos',
  negative: 'money-neg',
  accent: 'text-accent-text',
};

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  emphasis = false,
  footer,
  className = '',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: StatTone;
  emphasis?: boolean;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card flex flex-col gap-2 p-5 sm:p-6 ${className}`}>
      <span className="eyebrow">{label}</span>
      <span className={`${emphasis ? 'money-xl' : 'money-lg'} ${TONE_CLASS[tone]}`}>{value}</span>
      {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      {footer ? <div className="mt-1">{footer}</div> : null}
    </div>
  );
}
