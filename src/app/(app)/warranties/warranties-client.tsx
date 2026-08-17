'use client';

import Link from 'next/link';
import { StatusBadge } from '@/components/warranty/StatusBadge';
import { WarrantiesIcon } from '@/components/icons';
import { Card, CardBody, CardFooter } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
// Ruling P4: WARRANTY_SORTS/WarrantySort come from constants.ts (pure, client-safe), NOT
// from search.ts -- search.ts imports @/db/client, and a VALUE import from it (as opposed to
// a type-only one) drags better-sqlite3 into this client bundle and breaks `next build`.
import { expiryPhraseForKind, WARRANTY_SORTS, type ItemKind, type WarrantySort } from '@/lib/warranty/constants';
import { statusLabel, WARRANTY_STATUSES } from '@/lib/warranty/expiry';
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
  types: { id: number; name: string; kind: ItemKind }[];
  today: string;
  query: string;
  status: string;
  owner: string;
  typeId: string;
  sort: WarrantySort;
}) {
  const searching = query.trim().length > 0 || status !== '' || owner !== '' || typeId !== '';

  // M12: Prev/Next must preserve every other filter/sort param currently in force -- page 2+
  // was otherwise unreachable (no link anywhere pointed at it), which is silent data loss
  // past WARRANTY_PAGE_SIZE (50) rows.
  function pageHref(page: number): string {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query);
    if (status) params.set('status', status);
    if (owner) params.set('owner', owner);
    if (typeId) params.set('typeId', typeId);
    if (sort !== 'expiry') params.set('sort', sort);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    return qs ? `/warranties?${qs}` : '/warranties';
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Contracts & Coverage"
        description="Receipts, coverage and cancel-by dates for everything worth keeping the paperwork on."
        actions={
          <Link href="/warranties/new" className="btn btn--primary">
            Add item
          </Link>
        }
      />

      {result.error ? <Notice tone="error">{result.error}</Notice> : null}

      <Card>
        <CardBody className="pt-5">
          {/* A plain GET form: ?q=/?status=/?owner=/?typeId=/?sort= are all linkable and survive
              refresh (Ruling P12). The type filter chip composes with every other filter here --
              it does not replace any of them (type-deltas.md T9). */}
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="Search" className="min-w-[14rem] flex-1">
              <input name="q" defaultValue={query} placeholder="Any word on the receipt or document" className={inputClass} />
            </Field>
            <Field label="Status">
              <select name="status" defaultValue={status} className={selectClass}>
                <option value="">All</option>
                {WARRANTY_STATUSES.map((value) => (
                  // M15: statusLabel() gives the human-readable text ("Active", "Expiring
                  // soon", ...); the option's VALUE stays the raw status code the server
                  // filters on. statusLabel() is subscription-agnostic by construction, and
                  // that is deliberate here too -- a filter option applies across both
                  // warranties and subscriptions at once, so it uses the neutral wording
                  // rather than either verb (expiryPhrase()'s "expires"/"cancel by" swap is
                  // for a single item's own row, not this generic bucket).
                  <option key={value} value={value}>{statusLabel(value, null, today)}</option>
                ))}
              </select>
            </Field>
            <Field label="Owner">
              <select name="owner" defaultValue={owner} className={selectClass}>
                <option value="">All</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Type">
              <select name="typeId" defaultValue={typeId} className={selectClass}>
                <option value="">All</option>
                {types.map((type) => (
                  <option key={type.id} value={type.id}>{type.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Sort">
              <select name="sort" defaultValue={sort} className={selectClass}>
                {WARRANTY_SORTS.map((value) => (
                  <option key={value} value={value}>{SORT_LABELS[value]}</option>
                ))}
              </select>
            </Field>
            <button type="submit" className="btn btn--primary">Apply</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        {result.rows.length === 0 ? (
          searching ? (
            <EmptyState icon={WarrantiesIcon} title="No matches for that search.">
              Try fewer words, or clear the status and owner filters.
            </EmptyState>
          ) : (
            <EmptyState
              icon={WarrantiesIcon}
              title="Nothing tracked yet"
              action={
                <Link href="/warranties/new" className="btn btn--primary btn--sm">
                  Add the first one
                </Link>
              }
            >
              Add a warranty, subscription, contract, or loan — snap the receipt and this will remember the
              model, the price and when the cover runs out.
            </EmptyState>
          )
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Type</th>
                <th scope="col">Vendor</th>
                <th scope="col">Purchase date</th>
                <th scope="col">Expiry</th>
                <th scope="col">Status</th>
                <th scope="col">Owner</th>
                <th scope="col" className="text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/warranties/${row.id}`} className="font-medium text-ink hover:text-accent-text">{row.name}</Link>
                    {row.model ? <div className="text-xs text-subtle">{row.model}</div> : null}
                  </td>
                  <td>
                    {row.typeName ? (
                      <span className="badge badge--slate">{row.typeName}</span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="text-muted">{row.vendor ?? '—'}</td>
                  <td className="tabnum whitespace-nowrap text-muted">{row.purchaseDate}</td>
                  {/* Delta T9, generalized to `kind` in v1.2.2 Task 2: expiryPhraseForKind()
                      supplies the expires/cancel by/ends on/paid off by verb -- no component
                      hard-codes any of them (MUST-19.11). */}
                  <td className="whitespace-nowrap text-muted">{row.expiryDate === null ? '—' : expiryPhraseForKind(row.kind, row.expiryDate)}</td>
                  <td>
                    <StatusBadge status={row.status} expiryDate={row.expiryDate} today={today} kind={row.kind} />
                  </td>
                  <td className="whitespace-nowrap text-muted">{row.ownerName}</td>
                  <td className="text-right">
                    {row.priceCents === null ? <span className="text-subtle">—</span> : <Money cents={row.priceCents} plain />}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}

        {result.pageCount > 1 ? (
          <CardFooter>
            <nav className="flex items-center gap-3" aria-label="Pages">
              <span>Page {result.page} of {result.pageCount} · {result.total} items</span>
              {result.page > 1 ? (
                <Link href={pageHref(result.page - 1)} className="font-medium text-accent-text underline underline-offset-2">Prev</Link>
              ) : null}
              {result.page < result.pageCount ? (
                <Link href={pageHref(result.page + 1)} className="font-medium text-accent-text underline underline-offset-2">Next</Link>
              ) : null}
            </nav>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
