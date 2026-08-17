/**
 * Table wrapper. Wide financial tables must scroll inside their own box rather
 * than pushing the page sideways on a phone, and the rounded clip is what keeps
 * a sticky header from spilling over the card's corner.
 *
 * `.data-table` (globals.css) does the actual cell styling, so a page writes
 * plain <thead>/<tbody> markup and gets the house table for free.
 */
export function TableWrap({
  children,
  className = '',
  bare = false,
}: {
  children: React.ReactNode;
  /** Extra classes for the scroll container. */
  className?: string;
  /** Inside a Card already? Drop the border and radius so they do not double up. */
  bare?: boolean;
}) {
  const shell = bare ? '' : 'rounded-lg border border-line bg-surface shadow-card';
  return (
    <div className={`w-full overflow-x-auto ${shell} ${className}`}>
      <table className="data-table">{children}</table>
    </div>
  );
}

/** Right-aligned, tabular-figure cell for amounts. */
export function AmountCell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`money text-right ${className}`}>{children}</td>;
}
