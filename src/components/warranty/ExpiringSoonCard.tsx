import Link from 'next/link';
import { daysBetweenIso } from '@/lib/dates';
import { expiringSoonLabel, expiryPhrase } from '@/lib/warranty/constants';
import type { WarrantyListItem } from '@/lib/warranty/search';

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
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Warranties expiring soon</h2>
        <Link href="/warranties?status=expiring" className="text-sm underline">View all</Link>
      </div>
      <ul className="text-sm">
        {items.slice(0, EXPIRING_WIDGET_LIMIT).map((row) => (
          <li key={row.id} className="flex justify-between border-b border-slate-100 py-1 dark:border-slate-900">
            <span>
              <Link href={`/warranties/${row.id}`} className="hover:underline">{row.name}</Link>
              {row.vendor ? <span className="ml-2 text-slate-500">{row.vendor}</span> : null}
              {/* type-deltas.md T10: a type badge, skipped entirely when the item is
                  untyped — no empty pill left behind. */}
              {row.typeName ? (
                <span
                  data-testid="type-badge"
                  className="ml-2 rounded bg-slate-100 px-1 text-xs dark:bg-slate-800"
                >
                  {row.typeName}
                </span>
              ) : null}
            </span>
            <span className="text-amber-700 dark:text-amber-300">
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
    </section>
  );
}
