'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { TransactionsIcon } from '@/components/icons';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { Field, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { type ResolvedRange } from '@/lib/date-range';
import type { LoanLink } from '@/lib/loans';
import type { TransactionPage } from '@/lib/transactions';
import {
  assignToLoanAction,
  bulkCategorizeAction,
  bulkTransferAction,
  manualEntryAction,
  renameTransactionAction,
  setAttributionAction,
  setCategoryAction,
  unassignFromLoanAction,
  type ActionState,
} from './actions';

interface Option { id: number; name: string; parentId?: number | null; isArchived?: boolean }
interface LoanOption { id: number; name: string }

const initial: ActionState = {};

/** The dense per-row controls: small, quiet, and not competing with the amounts. */
const rowControl = 'field-control w-auto max-w-[11rem] px-2 py-1 text-xs';

export function TransactionsClient({
  page,
  accounts,
  categories,
  people,
  today,
  range = null,
  loanOptions = [],
  loanLinks = {},
}: {
  page: TransactionPage;
  accounts: Option[];
  categories: Option[];
  people: Option[];
  today: string;
  range?: ResolvedRange | null;
  /** v1.3.1: loans with a balance still owed. Empty for a household with none (MUST-14.9). */
  loanOptions?: LoanOption[];
  loanLinks?: Record<number, LoanLink[]>;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<{ id: number; current: string; merchant: string } | null>(null);
  const [manualState, manualAction] = useActionState(manualEntryAction, initial);
  const [rowState, rowAction] = useActionState(setCategoryAction, initial);
  const [attrState, attrAction] = useActionState(setAttributionAction, initial);
  const [bulkCatState, bulkCatAction] = useActionState(bulkCategorizeAction, initial);
  const [bulkTfrState, bulkTfrAction] = useActionState(bulkTransferAction, initial);
  const [renameState, renameAction] = useActionState(renameTransactionAction, initial);
  const [assignState, assignLoan] = useActionState(
    (_prev: ActionState, formData: FormData) => assignToLoanAction(formData),
    initial,
  );
  const [unassignState, unassignLoan] = useActionState(
    (_prev: ActionState, formData: FormData) => unassignFromLoanAction(formData),
    initial,
  );

  const label = (id: number | null) => {
    if (id === null) return 'Uncategorized';
    const category = categories.find((c) => c.id === id);
    if (!category) return 'Uncategorized';
    const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };

  // Filters, bulk actions and new entries must only ever assign a live category.
  // The per-row select below intentionally uses the full `categories` list instead
  // (including archived) so a row already carrying an archived category still
  // renders its real name and keeps it selected rather than silently falling back
  // to "Uncategorized" the moment that category is archived (see finding: archived-
  // category silent-clear hazard).
  const activeCategories = categories.filter((c) => !c.isArchived);

  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const notice =
    manualState.message ?? rowState.message ?? attrState.message ?? bulkCatState.message ?? bulkTfrState.message ??
    renameState.message ?? assignState.message ?? unassignState.message;
  const error =
    manualState.error ?? rowState.error ?? attrState.error ?? bulkCatState.error ?? bulkTfrState.error ??
    renameState.error ?? assignState.error ?? unassignState.error;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Transactions" description="Every line from every account, with what it was spent on." />

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {renaming ? (
        <Card as="div">
          <CardHeader
            title="Rename this merchant"
            description="The bank's text is kept exactly as-is behind the scenes — renaming changes only what you see, and never affects duplicate detection or how the categorizer learns."
          />
          <CardBody>
            <form action={renameAction} onSubmit={() => setRenaming(null)} className="flex flex-col gap-4">
              <input type="hidden" name="transactionId" value={renaming.id} />
              <Field label="Display name" hint="Leave it empty to go back to the bank's wording." className="max-w-md">
                <input name="displayName" defaultValue={renaming.current} autoFocus className={inputClass} />
              </Field>
              <fieldset className="flex flex-col gap-2">
                <legend className={labelClass}>Apply to</legend>
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="radio" name="scope" value="one" defaultChecked className="accent-accent" /> This transaction only
                </label>
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="radio" name="scope" value="all" className="accent-accent" /> All matching{' '}
                  <code className="rounded bg-surface-2 px-1 font-mono text-xs text-ink">{renaming.merchant}</code> + future imports
                  (creates a rename rule)
                </label>
              </fieldset>
              <div className="flex gap-2">
                <SubmitButton>Save name</SubmitButton>
                <button type="button" onClick={() => setRenaming(null)} className="btn btn--secondary">
                  Cancel
                </button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      <Card as="div">
        <CardBody className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="Account">
              <select name="account" className={selectClass}>
                <option value="">All</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Category">
              <select name="category" className={selectClass}>
                <option value="">All</option>
                <option value="uncategorized">Uncategorized</option>
                {activeCategories.map((c) => (
                  <option key={c.id} value={c.id}>{label(c.id)}</option>
                ))}
              </select>
            </Field>
            <Field label="Person">
              <select name="person" className={selectClass}>
                <option value="">Everyone</option>
                <option value="unattributed">Household/unattributed</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <DateRangePicker
              allowAny
              value={range?.preset ?? ''}
              from={range?.from ?? ''}
              to={range?.to ?? ''}
              today={today}
            />
            <Field label="Search" className="min-w-[12rem] flex-1">
              <input name="q" placeholder="Merchant text" className={inputClass} />
            </Field>
            <div className="flex flex-wrap items-center gap-4 py-2">
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" name="uncat" value="1" className="accent-accent" /> Uncategorized only
              </label>
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" name="transfers" value="0" className="accent-accent" /> Hide transfers
              </label>
            </div>
            <button type="submit" className="btn btn--primary">Filter</button>
          </form>
        </CardBody>
      </Card>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-accent-soft bg-accent-soft px-4 py-3">
          <span className="py-2 text-sm font-semibold text-accent-soft-fg">{selected.length} selected</span>
          <form action={bulkCatAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <select name="categoryId" aria-label="Category for the selected transactions" className={selectClass}>
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>{label(c.id)}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm text-accent-soft-fg">
              <input type="checkbox" name="createRules" defaultChecked className="accent-accent" /> create rules
            </label>
            <SubmitButton>Categorize</SubmitButton>
          </form>
          <form action={attrAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <select name="attributedUserId" aria-label="Person for the selected transactions" className={selectClass}>
              <option value="">Household/unattributed</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <SubmitButton>Attribute</SubmitButton>
          </form>
          <form action={bulkTfrAction} className="flex items-center gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <input type="hidden" name="isTransfer" value="1" />
            <SubmitButton variant="secondary">Mark transfer</SubmitButton>
          </form>
        </div>
      ) : null}

      <Card as="div">
        <TableWrap bare>
          <thead>
            <tr>
              <th scope="col" className="w-8" />
              <th scope="col">Date</th>
              <th scope="col">Account</th>
              <th scope="col">Description</th>
              <th scope="col" className="text-right">Amount</th>
              <th scope="col">Category</th>
              <th scope="col">Person</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                    aria-label={`Select transaction ${row.id}`}
                    className="accent-accent"
                  />
                </td>
                <td className="tabnum whitespace-nowrap text-muted">{row.date}</td>
                <td className="whitespace-nowrap text-muted">{row.accountName}</td>
                <td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setRenaming({ id: row.id, current: row.displayDescription ?? row.rawDescription, merchant: row.normalizedMerchant })}
                      title={row.displayDescription ? `Bank text: ${row.rawDescription}` : 'Click to rename'}
                      className="rounded-xs text-left font-medium text-ink hover:text-accent-text"
                    >
                      {row.displayDescription ?? row.rawDescription}
                    </button>
                    {row.displaySource === 'manual' ? <span className="badge badge--blue">renamed</span> : null}
                    {row.displaySource === 'rename' ? <span className="badge badge--blue">rule</span> : null}
                    {row.isTransfer ? <span className="badge badge--slate">transfer</span> : null}
                    {row.source === 'bayes' ? <span className="badge badge--amber">guess</span> : null}
                  </span>
                </td>
                <AmountCell className="whitespace-nowrap">
                  <Money cents={row.amountCents} />
                </AmountCell>
                <td>
                  <form action={rowAction} className="flex items-center gap-1.5">
                    <input type="hidden" name="transactionId" value={row.id} />
                    {/* Full (archived-inclusive) category list here, on purpose: if this row's
                        category was archived after the fact, it must still appear as a real
                        <option> so the browser's initial selection matches it. Otherwise the
                        select silently falls back to "Uncategorized" and an untouched "save"
                        click would clear (and untrain) a legitimate historical categorization.
                        Archived options are disabled so they can't be freshly assigned to a
                        different row. */}
                    <select
                      name="categoryId"
                      defaultValue={row.categoryId ?? ''}
                      aria-label={`Category for transaction ${row.id}`}
                      className={rowControl}
                    >
                      <option value="">Uncategorized</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id} disabled={c.isArchived}>
                          {label(c.id)}{c.isArchived ? ' (archived)' : ''}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">Save</button>
                  </form>
                </td>
                <td>
                  <form action={attrAction} className="flex items-center gap-1.5">
                    <input type="hidden" name="ids" value={row.id} />
                    <select
                      name="attributedUserId"
                      defaultValue={row.attributedUserId ?? ''}
                      aria-label={`Person for transaction ${row.id}`}
                      className={rowControl}
                    >
                      <option value="">Household</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">Save</button>
                  </form>
                </td>
                <td className="whitespace-nowrap">
                  {/* MUST-11.1 / MUST-11.2: a purchase can carry a warranty; a transfer cannot.
                      MUST-11.3: the URL carries ONLY the id. The add page derives the date,
                      the abs() price and the vendor from the transaction row server-side. */}
                  {row.isTransfer ? null : (
                    <Link href={`/warranties/new?transactionId=${row.id}`} className="btn btn--ghost btn--sm text-xs text-accent-text">
                      Create warranty
                    </Link>
                  )}
                  {/* MUST-14.8: a transfer never carries a loan control, and neither does a
                      page that was given no loans. The established precedent for a per-row
                      action is the link above.
                      F4 fix-round: EVERY link on the row gets its own line and its own
                      Unassign, not just the first -- a combined payment split across two
                      loans used to hide the second link entirely. The assign select is now
                      ALWAYS shown alongside existing links (not replaced by them), which is
                      what makes the over-link warn path (MUST-14.10) reachable from the UI at
                      all -- it used to be dead code once a row had one link, since the
                      control that could create a second one had already disappeared. */}
                  {row.isTransfer || loanOptions.length === 0 ? null : (
                    <span className="flex flex-col items-end gap-1">
                      {(loanLinks[row.id] ?? []).map((link) => (
                        <span key={link.id} className="flex items-center gap-1.5">
                          <span className="text-xs text-muted">{link.itemName}</span>
                          <form action={unassignLoan}>
                            <input type="hidden" name="transactionId" value={row.id} />
                            <input type="hidden" name="itemId" value={link.itemId} />
                            <SubmitButton className="btn btn--ghost btn--sm">Unassign</SubmitButton>
                          </form>
                        </span>
                      ))}
                      <form action={assignLoan} className="flex items-center gap-1.5">
                        <input type="hidden" name="transactionId" value={row.id} />
                        {/* F12 fix-round: `required` blocks the browser from submitting with
                            nothing picked, and the blank option is `disabled` so it can only
                            ever be the placeholder, never a real (empty) selection -- paired
                            with assignToLoanAction's own server-side check for the friendly
                            "Pick a loan first." message a stripped/tampered request would
                            otherwise get back as a bare "Invalid request." */}
                        <select
                          name="itemId"
                          defaultValue=""
                          required
                          aria-label={`Assign transaction ${row.id} to a loan`}
                          className={rowControl}
                        >
                          <option value="" disabled>Assign to loan…</option>
                          {loanOptions.map((loan) => (
                            <option key={loan.id} value={loan.id}>{loan.name}</option>
                          ))}
                        </select>
                        <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">Assign</button>
                      </form>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        {page.rows.length === 0 ? (
          <EmptyState icon={TransactionsIcon} title="Nothing matches these filters">
            Widen the date range or clear the search — or import a statement to get some transactions in here.
          </EmptyState>
        ) : null}
        <CardFooter>
          Page {page.page} of {page.pageCount} — {page.total} transactions
        </CardFooter>
      </Card>

      <Card as="div" className="max-w-2xl">
        <CardHeader title="Add a transaction" description="For cash and anything the bank will never send you." />
        <CardBody>
          <form action={manualAction} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date">
                <input type="date" name="date" defaultValue={today} required className={inputClass} />
              </Field>
              <Field label="Account">
                <select name="accountId" className={selectClass}>
                  <option value="cash">My cash</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <input name="description" required className={inputClass} />
              </Field>
              <Field label="Amount">
                <input name="amount" placeholder="12.34" required className={inputClass} />
              </Field>
              <Field label="Direction">
                <select name="direction" className={selectClass}>
                  <option value="spend">Money out</option>
                  <option value="income">Money in</option>
                </select>
              </Field>
              <Field label="Category">
                <select name="categoryId" className={selectClass}>
                  <option value="">Leave to the categorizer</option>
                  {activeCategories.map((c) => (
                    <option key={c.id} value={c.id}>{label(c.id)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Person">
                <select name="attributedUserId" className={selectClass}>
                  <option value="">Account default</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <SubmitButton className="w-fit">Add transaction</SubmitButton>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
