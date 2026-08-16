'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { formatCents } from '@/lib/money';
import type { TransactionRow } from '@/lib/transactions';
import { acceptGuessAction, applyToAllMatchingAction, fixCategoryAction, markTransferAction, type ReviewState } from './actions';

const initial: ReviewState = {};

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
      <h1 className="text-xl font-semibold">Review queue ({total})</h1>
      <FormError message={error} />
      {notice ? <p className="text-sm text-green-700 dark:text-green-400">{notice}</p> : null}
      {rows.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-400">Nothing to review. Everything is categorized.</p> : null}

      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id} className="rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <strong>{row.normalizedMerchant}</strong> — {row.rawDescription}
              </span>
              <span className="tabular-nums">{formatCents(row.amountCents)}</span>
            </div>
            <div className="text-xs text-slate-500">
              {row.date} · {row.accountName}
              {row.source === 'bayes' && row.categoryName ? ` · guessed ${row.categoryName} (margin ${row.confidence?.toFixed(2)})` : ' · uncategorized'}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {row.source === 'bayes' && row.categoryId ? (
                <form action={accept}>
                  <input type="hidden" name="transactionId" value={row.id} />
                  <button type="submit" className="rounded bg-slate-900 px-2 py-1 text-xs text-white dark:bg-slate-100 dark:text-slate-900">
                    Accept {row.categoryName}
                  </button>
                </form>
              ) : null}
              <form action={fix} className="flex items-center gap-1">
                <input type="hidden" name="transactionId" value={row.id} />
                <select name="categoryId" defaultValue={row.categoryId ?? ''} className="rounded border px-1 py-1 text-xs dark:bg-slate-900">
                  <option value="">Choose a category…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{label(c.id)}</option>
                  ))}
                </select>
                <button type="submit" className="rounded border px-2 py-1 text-xs dark:border-slate-700">Set</button>
              </form>
              {row.matchingCount > 1 ? (
                <form action={applyAll} className="flex items-center gap-1">
                  <input type="hidden" name="normalizedMerchant" value={row.normalizedMerchant} />
                  <select name="categoryId" defaultValue={row.categoryId ?? ''} className="rounded border px-1 py-1 text-xs dark:bg-slate-900">
                    <option value="">Choose a category…</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{label(c.id)}</option>
                    ))}
                  </select>
                  <button type="submit" className="rounded border px-2 py-1 text-xs dark:border-slate-700">
                    Apply to all {row.matchingCount} matching + create rule
                  </button>
                </form>
              ) : null}
              <form action={markTransfer}>
                <input type="hidden" name="transactionId" value={row.id} />
                <button type="submit" className="rounded border px-2 py-1 text-xs dark:border-slate-700">Mark as transfer</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
