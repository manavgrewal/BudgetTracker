'use client';

import { useActionState, useState } from 'react';
import { BudgetProgressBar } from '@/components/BudgetProgressBar';
import { FormError } from '@/components/FormError';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { addMonths, monthLabel } from '@/lib/dates';
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
      <tr>
        <td style={{ paddingLeft: `${16 + depth * 20}px` }} className={depth === 0 ? 'font-medium text-ink' : 'text-muted'}>
          {row.categoryName}
          {row.isArchived ? <span className="ml-1.5 text-xs text-subtle">(archived)</span> : null}
        </td>
        <td className="w-44">
          {row.isArchived || !editable ? (
            // Two reasons a limit is not editable here. Archived categories can no longer
            // be actively budgeted (spec section 3) — the row is a read-only record of the
            // spend it still rolled up this month. And a non-admin looking at someone
            // else's personal section may only read it: setLimitAction rejects the write,
            // so rendering an input that always fails is a promise the server won't keep.
            <span className="text-xs text-subtle">
              {row.limitCents === null ? 'read-only' : `${formatCents(row.limitCents)} · read-only`}
            </span>
          ) : (
            <form action={action} className="flex items-center gap-1.5">
              <input type="hidden" name="scope" value={scope} />
              <input type="hidden" name="userId" value={userId ?? ''} />
              <input type="hidden" name="month" value={month} />
              <input type="hidden" name="categoryId" value={row.categoryId} />
              <input
                name="amount"
                defaultValue={row.limitCents === null ? '' : (row.limitCents / 100).toFixed(2)}
                placeholder="none"
                aria-label={`Monthly limit for ${row.categoryName}`}
                className="field-control w-24 px-2 py-1 text-right text-xs"
              />
              <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">Save</button>
            </form>
          )}
        </td>
        <td className="text-right"><Money cents={row.spentCents} plain /></td>
        <td className="text-right">
          {row.remainingCents === null ? (
            <span className="text-subtle">—</span>
          ) : (
            <Money cents={row.remainingCents} />
          )}
        </td>
        <td className="w-44">
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

function BudgetTable({ children }: { children: React.ReactNode }) {
  return (
    <TableWrap bare>
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col">Limit</th>
          <th scope="col" className="text-right">Net spent</th>
          <th scope="col" className="text-right">Remaining</th>
          <th scope="col" />
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </TableWrap>
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

  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={monthLabel(month)}
        title="Budgets"
        description="A limit set here applies to this month and every month after it, until you change it again."
        actions={
          <nav aria-label="Change month" className="flex items-center gap-1 rounded-full border border-line bg-surface-2 p-1">
            <a className="btn btn--ghost btn--sm rounded-full" href={`/budgets?month=${previous}`}>← {previous}</a>
            <strong className="rounded-full bg-surface px-3 py-1 text-sm font-semibold shadow-flat">{month}</strong>
            <a className="btn btn--ghost btn--sm rounded-full" href={`/budgets?month=${next}`}>{next} →</a>
          </nav>
        }
      />

      <FormError message={banner.error} />
      {banner.message ? <Notice tone="success">{banner.message}</Notice> : null}

      <Card as="section">
        <CardHeader
          title={
            <>
              Household — spent {formatCents(householdTotals.budgetedSpentCents)} of {formatCents(householdTotals.budgetedLimitCents)} budgeted
              <span className="font-normal text-muted"> · {formatCents(householdTotals.totalSpentCents)} total spent</span>
            </>
          }
          action={
            <form action={copyAction}>
              <input type="hidden" name="scope" value="household" />
              <input type="hidden" name="month" value={month} />
              <button type="submit" className="btn btn--secondary btn--sm">Copy previous month</button>
            </form>
          }
        />
        <CardBody className="pb-4">
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
        </CardBody>
        <BudgetTable>
          {household.map((row) => (
            // Household budgets are editable by every member (spec section 6).
            <Row key={row.categoryId} row={row} depth={0} scope="household" userId={null} month={month} action={action} editable />
          ))}
        </BudgetTable>
      </Card>

      {personal.map((person) => (
        <Card as="section" key={person.userId}>
          <CardHeader
            title={
              <>
                {person.name}
                {person.userId === currentUserId ? ' (you)' : ''}
                {canEditPersonal(person.userId) ? null : (
                  <span className="ml-2 text-xs font-normal text-subtle">read-only</span>
                )}
              </>
            }
            description="Personal limits, on top of the household ones."
            action={
              /* Same ownership rule as the limit inputs: no copy button where the copy
                 would be refused server-side by copyPreviousMonthAction. */
              canEditPersonal(person.userId) ? (
                <form action={copyAction}>
                  <input type="hidden" name="scope" value="personal" />
                  <input type="hidden" name="userId" value={person.userId} />
                  <input type="hidden" name="month" value={month} />
                  <button type="submit" className="btn btn--secondary btn--sm">Copy previous month</button>
                </form>
              ) : null
            }
          />
          <BudgetTable>
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
          </BudgetTable>
        </Card>
      ))}

      <p className="text-xs text-subtle">
        Leaving a limit blank and saving clears the budget from {month} forward. Amounts you set apply to {month} and every later month until you
        change them again.
      </p>
    </div>
  );
}
