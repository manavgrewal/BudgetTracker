'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { CheckIcon } from '@/components/icons';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { selectClass } from '@/components/ui/form';
import type { TransactionRow } from '@/lib/transactions';
import { acceptGuessAction, applyToAllMatchingAction, fixCategoryAction, markTransferAction, type ReviewState } from './actions';

const initial: ReviewState = {};

/** Dense enough to sit three-across in a row of actions without shouting. */
const pickerClass = 'field-control w-auto max-w-[12rem] px-2 py-1 text-xs';

export function ReviewClient({
  total,
  rows,
  categories,
}: {
  total: number;
  rows: (TransactionRow & { matchingCount: number })[];
  categories: { id: number; name: string; parentId: number | null }[];
}) {
  const [acceptState, accept] = useActionState(acceptGuessAction, initial);
  const [fixState, fix] = useActionState(fixCategoryAction, initial);
  const [allState, applyAll] = useActionState(applyToAllMatchingAction, initial);
  const [transferState, markTransfer] = useActionState(markTransferAction, initial);

  const label = (id: number) => {
    const category = categories.find((c) => c.id === id);
    if (!category) return 'Uncategorized';
    const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };

  const notice = acceptState.message ?? fixState.message ?? allState.message ?? transferState.message;
  const error = acceptState.error ?? fixState.error ?? allState.error ?? transferState.error;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={`${total} waiting`}
        title="Review queue"
        description="Transactions the categorizer could not place with confidence. Correcting one teaches it."
      />
      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={CheckIcon} title="Nothing to review. Everything is categorized.">
            New imports land here whenever the categorizer is unsure.
          </EmptyState>
        </Card>
      ) : null}

      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id} className="card flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm">
                <strong className="font-semibold text-ink">{row.normalizedMerchant}</strong>{' '}
                <span className="text-muted">— {row.rawDescription}</span>
              </span>
              <Money cents={row.amountCents} className="text-base font-semibold" />
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-subtle">
              <span className="tabnum">{row.date}</span>
              <span aria-hidden="true">·</span>
              <span>{row.accountName}</span>
              <span aria-hidden="true">·</span>
              {row.source === 'bayes' && row.categoryName ? (
                <span className="badge badge--amber">
                  guessed {row.categoryName} (margin {row.confidence?.toFixed(2)})
                </span>
              ) : (
                <span className="badge badge--slate">uncategorized</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {row.source === 'bayes' && row.categoryId ? (
                <form action={accept}>
                  <input type="hidden" name="transactionId" value={row.id} />
                  <button type="submit" className="btn btn--primary btn--sm">
                    <CheckIcon className="h-3.5 w-3.5" />
                    Accept {row.categoryName}
                  </button>
                </form>
              ) : null}
              <form action={fix} className="flex items-center gap-1.5">
                <input type="hidden" name="transactionId" value={row.id} />
                <select
                  name="categoryId"
                  defaultValue={row.categoryId ?? ''}
                  aria-label={`Category for ${row.normalizedMerchant}`}
                  className={pickerClass}
                >
                  <option value="">Choose a category…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{label(c.id)}</option>
                  ))}
                </select>
                <button type="submit" className="btn btn--secondary btn--sm">Set</button>
              </form>
              {row.matchingCount > 1 ? (
                <form action={applyAll} className="flex items-center gap-1.5">
                  <input type="hidden" name="normalizedMerchant" value={row.normalizedMerchant} />
                  <select
                    name="categoryId"
                    defaultValue={row.categoryId ?? ''}
                    aria-label={`Category for all ${row.matchingCount} matching ${row.normalizedMerchant}`}
                    className={pickerClass}
                  >
                    <option value="">Choose a category…</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{label(c.id)}</option>
                    ))}
                  </select>
                  <button type="submit" className="btn btn--secondary btn--sm">
                    Apply to all {row.matchingCount} matching + create rule
                  </button>
                </form>
              ) : null}
              <form action={markTransfer}>
                <input type="hidden" name="transactionId" value={row.id} />
                <button type="submit" className="btn btn--ghost btn--sm">Mark as transfer</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
