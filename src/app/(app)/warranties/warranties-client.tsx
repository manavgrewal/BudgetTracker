'use client';

import Link from 'next/link';
import { StatusBadge } from '@/components/warranty/StatusBadge';
import { formatCents } from '@/lib/money';
// Ruling P4: WARRANTY_SORTS/WarrantySort come from constants.ts (pure, client-safe), NOT
// from search.ts -- search.ts imports @/db/client, and a VALUE import from it (as opposed to
// a type-only one) drags better-sqlite3 into this client bundle and breaks `next build`.
import { expiryPhrase, WARRANTY_SORTS, type WarrantySort } from '@/lib/warranty/constants';
import { WARRANTY_STATUSES } from '@/lib/warranty/expiry';
import type { WarrantySearchResult } from '@/lib/warranty/search';

const SORT_LABELS: Record<WarrantySort, string> = {
  expiry: 'Soonest expiry',
  name: 'Name',
  purchase: 'Newest purchase',
};

export function WarrantiesClient({
  result,
  people,
  types,
  today,
  query,
  status,
  owner,
  typeId,
  sort,
}: {
  result: WarrantySearchResult;
  people: { id: number; name: string }[];
  /** Delta T9: an optional type filter/select, alongside status/owner/sort. */
  types: { id: number; name: string; isSubscription: boolean }[];
  today: string;
  query: string;
  status: string;
  owner: string;
  typeId: string;
  sort: WarrantySort;
}) {
  const searching = query.trim().length > 0 || status !== '' || owner !== '' || typeId !== '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Warranties</h1>
        <Link href="/warranties/new" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900">
          Add warranty
        </Link>
      </div>

      {result.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {result.error}
        </p>
      ) : null}

      {/* A plain GET form: ?q=/?status=/?owner=/?typeId=/?sort= are all linkable and survive
          refresh (Ruling P12). The type filter chip composes with every other filter here --
          it does not replace any of them (type-deltas.md T9). */}
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          Search
          <input
            name="q"
            defaultValue={query}
            placeholder="Any word on the receipt"
            className="w-64 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="flex flex-col gap-1">
          Status
          <select name="status" defaultValue={status} className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">All</option>
            {WARRANTY_STATUSES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Owner
          <select name="owner" defaultValue={owner} className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">All</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Type
          <select name="typeId" defaultValue={typeId} className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">All</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>{type.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Sort
          <select name="sort" defaultValue={sort} className="rounded border px-2 py-1 dark:bg-slate-900">
            {WARRANTY_SORTS.map((value) => (
              <option key={value} value={value}>{SORT_LABELS[value]}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded border px-3 py-1 dark:border-slate-700">Apply</button>
      </form>

      {result.rows.length === 0 ? (
        searching ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">No matches for that search.</p>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No warranties yet. <Link href="/warranties/new" className="underline">Add the first one</Link>.
          </p>
        )
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2">Item</th>
              <th>Type</th>
              <th>Vendor</th>
              <th>Purchase date</th>
              <th>Expiry</th>
              <th>Status</th>
              <th>Owner</th>
              <th className="text-right">Price</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-2">
                  <Link href={`/warranties/${row.id}`} className="hover:underline">{row.name}</Link>
                  {row.model ? <div className="text-xs text-slate-500">{row.model}</div> : null}
                </td>
                <td>{row.typeName ?? '—'}</td>
                <td>{row.vendor ?? '—'}</td>
                <td>{row.purchaseDate}</td>
                {/* Delta T9: expiryPhrase() supplies the "expires"/"cancel by" verb -- no
                    component hard-codes either word (MUST-19.11). */}
                <td>{row.expiryDate === null ? '—' : expiryPhrase(row.isSubscription, row.expiryDate)}</td>
                <td>
                  <StatusBadge status={row.status} expiryDate={row.expiryDate} today={today} isSubscription={row.isSubscription} />
                </td>
                <td>{row.ownerName}</td>
                <td className="text-right tabular-nums">{row.priceCents === null ? '—' : formatCents(row.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result.pageCount > 1 ? (
        <p className="text-xs text-slate-500">
          Page {result.page} of {result.pageCount} · {result.total} items
        </p>
      ) : null}
    </div>
  );
}
