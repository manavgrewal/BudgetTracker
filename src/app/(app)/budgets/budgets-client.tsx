'use client';

import { useActionState, useState } from 'react';
import { BudgetProgressBar } from '@/components/BudgetProgressBar';
import { FormError } from '@/components/FormError';
import { addMonths } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import type { BudgetRow } from '@/lib/budgets';
import { copyPreviousMonthAction, setLimitAction, type BudgetActionState } from './actions';

const initial: BudgetActionState = {};

function Row({
  row,
  depth,
  scope,
  userId,
  month,
  action,
  editable,
}: {
  row: BudgetRow;
  depth: number;
  scope: 'household' | 'personal';
  userId: number | null;
  month: string;
  action: (formData: FormData) => void;
  editable: boolean;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 dark:border-slate-900">
        <td className="py-2" style={{ paddingLeft: `${depth * 20}px` }}>
          {row.categoryName}
          {row.isArchived ? <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">(archived)</span> : null}
        </td>
        <td className="w-40">
          {row.isArchived || !editable ? (
            // Two reasons a limit is not editable here. Archived categories can no longer
            // be actively budgeted (spec section 3) — the row is a read-only record of the
            // spend it still rolled up this month. And a non-admin looking at someone
            // else's personal section may only read it: setLimitAction rejects the write,
            // so rendering an input that always fails is a promise the server won't keep.
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {row.limitCents === null ? 'read-only' : `${formatCents(row.limitCents)} · read-only`}
            </span>
          ) : (
            <form action={action} className="flex items-center gap-1">
              <input type="hidden" name="scope" value={scope} />
              <input type="hidden" name="userId" value={userId ?? ''} />
              <input type="hidden" name="month" value={month} />
              <input type="hidden" name="categoryId" value={row.categoryId} />
              <input
                name="amount"
                defaultValue={row.limitCents === null ? '' : (row.limitCents / 100).toFixed(2)}
                placeholder="none"
                className="w-24 rounded border px-2 py-1 text-right text-xs dark:bg-slate-900"
              />
              <button type="submit" className="text-xs underline">save</button>
            </form>
          )}
        </td>
        <td className="text-right tabular-nums">{formatCents(row.spentCents)}</td>
        <td className="text-right tabular-nums">{row.remainingCents === null ? '—' : formatCents(row.remainingCents)}</td>
        <td className="w-40">
          <BudgetProgressBar limitCents={row.limitCents} spentCents={row.spentCents} label={row.categoryName} />
        </td>
      </tr>
      {row.children.map((child) => (
        <Row
          key={child.categoryId}
          row={child}
          depth={depth + 1}
          scope={scope}
          userId={userId}
          month={month}
          action={action}
          editable={editable}
        />
      ))}
    </>
  );
}

export function BudgetsClient({
  month,
  currentUserId,
  currentUserIsAdmin = false,
  household,
  householdTotals,
  personal,
}: {
  month: string;
  currentUserId: number;
  currentUserIsAdmin?: boolean;
  household: BudgetRow[];
  householdTotals: { budgetedLimitCents: number; budgetedSpentCents: number; totalSpentCents: number };
  personal: { userId: number; name: string; rows: BudgetRow[] }[];
}) {
  const [limitState, dispatchLimit] = useActionState(setLimitAction, initial);
  const [copyState, dispatchCopy] = useActionState(copyPreviousMonthAction, initial);

  // ONE banner, showing only the most recent submission. Two independent action states
  // rendered side by side meant a success message from a save sat next to a fresh error
  // from a copy (and the other way round), so the page reported two contradictory
  // outcomes at once. Remembering which action fired last is enough to keep the banner
  // honest without merging the two server actions.
  const [latest, setLatest] = useState<'limit' | 'copy' | null>(null);
  const action = (formData: FormData) => {
    setLatest('limit');
    dispatchLimit(formData);
  };
  const copyAction = (formData: FormData) => {
    setLatest('copy');
    dispatchCopy(formData);
  };
  const banner: BudgetActionState = latest === 'limit' ? limitState : latest === 'copy' ? copyState : initial;

  // Members may edit household budgets and their OWN personal budgets; admins may edit
  // anyone's (mirrors setLimitAction / copyPreviousMonthAction, spec section 6).
  const canEditPersonal = (userId: number) => currentUserIsAdmin || userId === currentUserId;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Budgets</h1>
        <a className="text-sm underline" href={`/budgets?month=${addMonths(month, -1)}`}>← {addMonths(month, -1)}</a>
        <strong className="text-sm">{month}</strong>
        <a className="text-sm underline" href={`/budgets?month=${addMonths(month, 1)}`}>{addMonths(month, 1)} →</a>
      </div>
      <FormError message={banner.error} />
      {banner.message ? <p className="text-sm text-green-700 dark:text-green-400">{banner.message}</p> : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">
            Household — spent {formatCents(householdTotals.budgetedSpentCents)} of {formatCents(householdTotals.budgetedLimitCents)} budgeted
            <span className="text-slate-500 dark:text-slate-400"> · {formatCents(householdTotals.totalSpentCents)} total spent</span>
          </h2>
          <form action={copyAction}>
            <input type="hidden" name="scope" value="household" />
            <input type="hidden" name="month" value={month} />
            <button type="submit" className="rounded border px-2 py-1 text-xs dark:border-slate-700">Copy previous month</button>
          </form>
        </div>
        <div className="max-w-xs">
          <BudgetProgressBar
            // No budgeted rows at all this month reads as "no budget", not a $0 budget —
            // only an explicit resolved limit on at least one row should drive this bar.
            limitCents={
              householdTotals.budgetedLimitCents === 0 && householdTotals.budgetedSpentCents === 0
                ? null
                : householdTotals.budgetedLimitCents
            }
            spentCents={householdTotals.budgetedSpentCents}
            label="Household budgeted total"
          />
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b dark:border-slate-800">
              <th className="py-2">Category</th>
              <th>Limit</th>
              <th className="text-right">Net spent</th>
              <th className="text-right">Remaining</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {household.map((row) => (
              // Household budgets are editable by every member (spec section 6).
              <Row key={row.categoryId} row={row} depth={0} scope="household" userId={null} month={month} action={action} editable />
            ))}
          </tbody>
        </table>
      </section>

      {personal.map((person) => (
        <section key={person.userId} className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">
              {person.name}
              {person.userId === currentUserId ? ' (you)' : ''}
              {canEditPersonal(person.userId) ? null : (
                <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">read-only</span>
              )}
            </h2>
            {/* Same ownership rule as the limit inputs: no copy button where the copy
                would be refused server-side by copyPreviousMonthAction. */}
            {canEditPersonal(person.userId) ? (
              <form action={copyAction}>
                <input type="hidden" name="scope" value="personal" />
                <input type="hidden" name="userId" value={person.userId} />
                <input type="hidden" name="month" value={month} />
                <button type="submit" className="rounded border px-2 py-1 text-xs dark:border-slate-700">Copy previous month</button>
              </form>
            ) : null}
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b dark:border-slate-800">
                <th className="py-2">Category</th>
                <th>Limit</th>
                <th className="text-right">Net spent</th>
                <th className="text-right">Remaining</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {person.rows.map((row) => (
                <Row
                  key={row.categoryId}
                  row={row}
                  depth={0}
                  scope="personal"
                  userId={person.userId}
                  month={month}
                  action={action}
                  editable={canEditPersonal(person.userId)}
                />
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Leaving a limit blank and saving clears the budget from {month} forward. Amounts you set apply to {month} and every later month until you
        change them again.
      </p>
    </div>
  );
}
