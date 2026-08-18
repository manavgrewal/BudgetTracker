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
import { MIN_HISTORY_MONTHS } from '@/lib/predict/constants';
import type { BudgetPredictions, CategorySuggestion, SectionPredictions } from '@/lib/predict/suggest';
import {
  applyAllSuggestionsAction,
  applySuggestionAction,
  copyPreviousMonthAction,
  setLimitAction,
  type BudgetActionState,
} from './actions';

const initial: BudgetActionState = {};

/** Everything a row needs from the predictions, resolved once per section. */
interface RowPredictions {
  suggestionOf: Map<number, CategorySuggestion>;
  projectionOf: Map<number, number>;
  /** MUST-14.4: the number the projection's title sentence names. */
  dayOfMonth: number;
}

function Row({
  row,
  depth,
  scope,
  userId,
  month,
  action,
  applyAction,
  editable,
  predict,
}: {
  row: BudgetRow;
  depth: number;
  scope: 'household' | 'personal';
  userId: number | null;
  month: string;
  action: (formData: FormData) => void;
  applyAction: (formData: FormData) => void;
  editable: boolean;
  predict: RowPredictions | null;
}) {
  const suggestion = predict?.suggestionOf.get(row.categoryId) ?? null;
  const projection = predict?.projectionOf.get(row.categoryId) ?? null;

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
            <>
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
              {suggestion ? (
                <form action={applyAction}>
                  <input type="hidden" name="scope" value={scope} />
                  <input type="hidden" name="userId" value={userId ?? ''} />
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="categoryId" value={row.categoryId} />
                  <button
                    type="submit"
                    className="btn btn--ghost btn--sm px-2 text-xs"
                    title={`Median of the last ${suggestion.monthsUsed} full months${
                      suggestion.trend.direction === 'rising'
                        ? ', adjusted for a rising trend'
                        : suggestion.trend.direction === 'falling'
                          ? ', adjusted for a falling trend'
                          : ''
                    }${suggestion.seasonalApplied ? ', adjusted for the same month last year' : ''}. Confidence: ${suggestion.confidence}.`}
                  >
                    Use {formatCents(suggestion.suggestedCents, { currency: true })}
                  </button>
                </form>
              ) : null}
            </>
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
          {projection !== null && predict !== null ? (
            <p
              className={`mt-1 text-xs ${row.limitCents !== null && projection > row.limitCents ? 'text-negative' : 'text-muted'}`}
              title={`Assumes the rest of the month looks like the ${predict.dayOfMonth} days so far.`}
            >
              On pace for {formatCents(projection, { currency: true })}
            </p>
          ) : null}
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
          applyAction={applyAction}
          editable={editable}
          predict={predict}
        />
      ))}
    </>
  );
}

function BudgetTable({ children, paceTitle }: { children: React.ReactNode; paceTitle?: string }) {
  return (
    <TableWrap bare>
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col">Limit</th>
          <th scope="col" className="text-right">Net spent</th>
          <th scope="col" className="text-right">Remaining</th>
          <th scope="col" title={paceTitle}>{paceTitle ? 'Progress and pace' : null}</th>
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
  predictions = null,
}: {
  month: string;
  currentUserId: number;
  currentUserIsAdmin?: boolean;
  household: BudgetRow[];
  householdTotals: { budgetedLimitCents: number; budgetedSpentCents: number; totalSpentCents: number };
  personal: { userId: number; name: string; rows: BudgetRow[] }[];
  /** MUST-14.1: null for a past or future month, and on any caller that has none. */
  predictions?: BudgetPredictions | null;
}) {
  const [limitState, dispatchLimit] = useActionState(setLimitAction, initial);
  const [copyState, dispatchCopy] = useActionState(copyPreviousMonthAction, initial);
  const [applyState, dispatchApply] = useActionState(applySuggestionAction, initial);
  const [applyAllState, dispatchApplyAll] = useActionState(applyAllSuggestionsAction, initial);

  // ONE banner, showing only the most recent submission. Independent action states
  // rendered side by side meant a success message from a save sat next to a fresh error
  // from a copy (and the other way round), so the page reported two contradictory
  // outcomes at once. Remembering which action fired last is enough to keep the banner
  // honest without merging the server actions.
  const [latest, setLatest] = useState<'limit' | 'copy' | 'apply' | 'applyAll' | null>(null);
  const action = (formData: FormData) => {
    setLatest('limit');
    dispatchLimit(formData);
  };
  const copyAction = (formData: FormData) => {
    setLatest('copy');
    dispatchCopy(formData);
  };
  const applyAction = (formData: FormData) => {
    setLatest('apply');
    dispatchApply(formData);
  };
  const applyAllAction = (formData: FormData) => {
    setLatest('applyAll');
    dispatchApplyAll(formData);
  };
  const banner: BudgetActionState =
    latest === 'limit'
      ? limitState
      : latest === 'copy'
        ? copyState
        : latest === 'apply'
          ? applyState
          : latest === 'applyAll'
            ? applyAllState
            : initial;

  // Members may edit household budgets and their OWN personal budgets; admins may edit
  // anyone's (mirrors setLimitAction / copyPreviousMonthAction, spec section 6).
  const canEditPersonal = (userId: number) => currentUserIsAdmin || userId === currentUserId;

  // MUST-14.2: two Map.get calls are the whole of the client's involvement, built once per
  // section rather than per row.
  const rowPredict = (section: SectionPredictions | undefined): RowPredictions | null =>
    predictions == null || section === undefined
      ? null
      : {
          suggestionOf: new Map(section.suggestions.map((entry) => [entry.categoryId, entry])),
          projectionOf: new Map(section.projections.map((entry) => [entry.categoryId, entry.projectedCents])),
          dayOfMonth: predictions.dayOfMonth,
        };

  const householdPredict = rowPredict(predictions?.household);
  const personalPredict = new Map(
    (predictions?.personal ?? []).map((entry) => [entry.userId, rowPredict(entry.predictions)]),
  );
  const paceTitle = predictions ? 'Appears from the 7th of the month.' : undefined;

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
            <>
              <form action={copyAction}>
                <input type="hidden" name="scope" value="household" />
                <input type="hidden" name="month" value={month} />
                <button type="submit" className="btn btn--secondary btn--sm">Copy previous month</button>
              </form>
              <form action={applyAllAction}>
                <input type="hidden" name="scope" value="household" />
                <input type="hidden" name="month" value={month} />
                <button
                  type="submit"
                  className="btn btn--secondary btn--sm"
                  title="Only fills in categories with no limit set. Nothing you have typed is changed."
                >
                  Apply all suggestions
                </button>
              </form>
            </>
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
          {predictions !== null && predictions.monthsUsed < MIN_HISTORY_MONTHS ? (
            <p className="text-sm text-muted">Suggestions appear once there are three full calendar months of history.</p>
          ) : null}
        </CardBody>
        <BudgetTable paceTitle={paceTitle}>
          {household.map((row) => (
            // Household budgets are editable by every member (spec section 6).
            <Row
              key={row.categoryId}
              row={row}
              depth={0}
              scope="household"
              userId={null}
              month={month}
              action={action}
              applyAction={applyAction}
              editable
              predict={householdPredict}
            />
          ))}
        </BudgetTable>
      </Card>

      {personal.map((person) => {
        const personPredict = personalPredict.get(person.userId) ?? null;
        const personNoAttribution =
          predictions?.personal.find((entry) => entry.userId === person.userId)?.predictions.noAttribution ?? false;
        const showHistorySentence = predictions !== null && predictions.monthsUsed < MIN_HISTORY_MONTHS;
        return (
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
                  <>
                    <form action={copyAction}>
                      <input type="hidden" name="scope" value="personal" />
                      <input type="hidden" name="userId" value={person.userId} />
                      <input type="hidden" name="month" value={month} />
                      <button type="submit" className="btn btn--secondary btn--sm">Copy previous month</button>
                    </form>
                    <form action={applyAllAction}>
                      <input type="hidden" name="scope" value="personal" />
                      <input type="hidden" name="userId" value={person.userId} />
                      <input type="hidden" name="month" value={month} />
                      <button
                        type="submit"
                        className="btn btn--secondary btn--sm"
                        title="Only fills in categories with no limit set. Nothing you have typed is changed."
                      >
                        Apply all suggestions
                      </button>
                    </form>
                  </>
                ) : null
              }
            />
            {showHistorySentence || personNoAttribution ? (
              <CardBody className="pt-5 pb-0">
                {showHistorySentence ? (
                  <p className="text-sm text-muted">Suggestions appear once there are three full calendar months of history.</p>
                ) : null}
                {personNoAttribution ? (
                  <p className="text-sm text-muted">
                    No transactions are attributed to you yet, so there is nothing to base a personal suggestion on.
                  </p>
                ) : null}
              </CardBody>
            ) : null}
            <BudgetTable paceTitle={paceTitle}>
              {person.rows.map((row) => (
                <Row
                  key={row.categoryId}
                  row={row}
                  depth={0}
                  scope="personal"
                  userId={person.userId}
                  month={month}
                  action={action}
                  applyAction={applyAction}
                  editable={canEditPersonal(person.userId)}
                  predict={personPredict}
                />
              ))}
            </BudgetTable>
          </Card>
        );
      })}

      <p className="text-xs text-subtle">
        Leaving a limit blank and saving clears the budget from {month} forward. Amounts you set apply to {month} and every later month until you
        change them again.
      </p>
    </div>
  );
}
