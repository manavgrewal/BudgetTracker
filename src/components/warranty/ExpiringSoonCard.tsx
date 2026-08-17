import Link from 'next/link';
import { daysBetweenIso } from '@/lib/dates';
import { expiringSoonLabel, expiryPhrase } from '@/lib/warranty/constants';
import type { WarrantyListItem } from '@/lib/warranty/search';
import { ArrowRightIcon } from '@/components/icons';
import { Card, CardHeader } from '@/components/ui/Card';

/** §17.19 / MUST-10.5: top 5, hidden when empty. */
export const EXPIRING_WIDGET_LIMIT = 5;

/** Sentence-initial capitalization only — the phrase itself (verb + wording) is untouched. */
function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

export function ExpiringSoonCard({ items, today }: { items: WarrantyListItem[]; today: string }) {
  // Hidden entirely when the count is zero — the dashboard already has enough on it.
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Warranties expiring soon"
        action={
          <Link
            href="/warranties?status=expiring"
            className="btn btn--ghost btn--sm text-accent-text hover:text-accent-text"
          >
            View all
            <ArrowRightIcon className="h-4 w-4" />
          </Link>
        }
      />
      <ul className="border-t border-line text-sm">
        {items.slice(0, EXPIRING_WIDGET_LIMIT).map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3 last:border-b-0 sm:px-6"
          >
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Link href={`/warranties/${row.id}`} className="font-medium text-ink hover:text-accent-text">
                {row.name}
              </Link>
              {row.vendor ? <span className="text-subtle">{row.vendor}</span> : null}
              {/* type-deltas.md T10: a type badge, skipped entirely when the item is
                  untyped — no empty pill left behind. */}
              {row.typeName ? (
                <span data-testid="type-badge" className="badge badge--slate">
                  {row.typeName}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-sm font-medium text-warning">
              {/* Every row here already carries status 'expiring' (expiringSoonItems()'s own
                  filter), which per warrantyStatus() in expiry.ts is only ever reached with a
                  non-null expiryDate. MUST-19.10 / MUST-19.13 / type-deltas.md T10: a warranty
                  row stays a day count ("Expires in N days", via expiringSoonLabel — the same
                  helper StatusBadge uses); a subscription row is the cancel-by DATE itself
                  ("Cancel by 2027-03-01", via expiryPhrase()'s "cancel by <date>", capitalized
                  to match this card's sentence-initial convention) rather than a day count. */}
              {row.isSubscription
                ? capitalize(expiryPhrase(true, row.expiryDate as string))
                : expiringSoonLabel(false, daysBetweenIso(today, row.expiryDate as string))}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
