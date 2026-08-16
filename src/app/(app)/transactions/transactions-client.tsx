'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { formatCents } from '@/lib/money';
import type { TransactionPage } from '@/lib/transactions';
import {
  bulkCategorizeAction,
  bulkTransferAction,
  manualEntryAction,
  renameTransactionAction,
  setAttributionAction,
  setCategoryAction,
  type ActionState,
} from './actions';

interface Option { id: number; name: string; parentId?: number | null; isArchived?: boolean }

const initial: ActionState = {};

export function TransactionsClient({
  page,
  accounts,
  categories,
  people,
  today,
}: {
  page: TransactionPage;
  accounts: Option[];
  categories: Option[];
  people: Option[];
  today: string;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<{ id: number; current: string; merchant: string } | null>(null);
  const [manualState, manualAction] = useActionState(manualEntryAction, initial);
  const [rowState, rowAction] = useActionState(setCategoryAction, initial);
  const [attrState, attrAction] = useActionState(setAttributionAction, initial);
  const [bulkCatState, bulkCatAction] = useActionState(bulkCategorizeAction, initial);
  const [bulkTfrState, bulkTfrAction] = useActionState(bulkTransferAction, initial);
  const [renameState, renameAction] = useActionState(renameTransactionAction, initial);

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
  const notice = manualState.message ?? rowState.message ?? attrState.message ?? bulkCatState.message ?? bulkTfrState.message ?? renameState.message;
  const error = manualState.error ?? rowState.error ?? attrState.error ?? bulkCatState.error ?? bulkTfrState.error ?? renameState.error;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Transactions</h1>
      <FormError message={error} />
      {notice ? <p className="text-sm text-green-700 dark:text-green-400">{notice}</p> : null}

      {renaming ? (
        <form
          action={renameAction}
          onSubmit={() => setRenaming(null)}
          className="flex flex-col gap-3 rounded border border-slate-300 p-4 text-sm dark:border-slate-700"
        >
          <h2 className="font-medium">Rename this merchant</h2>
          <p className="text-xs text-slate-500">
            The bank&apos;s text is kept exactly as-is behind the scenes — renaming changes only what you see, and never affects duplicate
            detection or how the categorizer learns.
          </p>
          <input type="hidden" name="transactionId" value={renaming.id} />
          <label className="flex flex-col gap-1">
            Display name
            <input
              name="displayName"
              defaultValue={renaming.current}
              autoFocus
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            />
            <span className="text-xs text-slate-500">Leave it empty to go back to the bank&apos;s wording.</span>
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-slate-500">Apply to</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="scope" value="one" defaultChecked /> This transaction only
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="scope" value="all" /> All matching <code className="text-xs">{renaming.merchant}</code> + future imports
              (creates a rename rule)
            </label>
          </fieldset>
          <div className="flex gap-2">
            <SubmitButton>Save name</SubmitButton>
            <button type="button" onClick={() => setRenaming(null)} className="rounded border px-3 py-2 dark:border-slate-700">
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          Account
          <select name="account" className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">All</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Category
          <select name="category" className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">All</option>
            <option value="uncategorized">Uncategorized</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>{label(c.id)}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Person
          <select name="person" className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">Everyone</option>
            <option value="unattributed">Household/unattributed</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          From
          <input type="date" name="from" className="rounded border px-2 py-1 dark:bg-slate-900" />
        </label>
        <label className="flex flex-col gap-1">
          To
          <input type="date" name="to" className="rounded border px-2 py-1 dark:bg-slate-900" />
        </label>
        <label className="flex flex-col gap-1">
          Search
          <input name="q" placeholder="Merchant text" className="rounded border px-2 py-1 dark:bg-slate-900" />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="uncat" value="1" /> Uncategorized only
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="transfers" value="0" /> Hide transfers
        </label>
        <button type="submit" className="rounded bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900">Filter</button>
      </form>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3 rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
          <span>{selected.length} selected</span>
          <form action={bulkCatAction} className="flex items-end gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <select name="categoryId" className="rounded border px-2 py-1 dark:bg-slate-900">
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>{label(c.id)}</option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="createRules" defaultChecked /> create rules
            </label>
            <SubmitButton>Categorize</SubmitButton>
          </form>
          <form action={attrAction} className="flex items-end gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <select name="attributedUserId" className="rounded border px-2 py-1 dark:bg-slate-900">
              <option value="">Household/unattributed</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <SubmitButton>Attribute</SubmitButton>
          </form>
          <form action={bulkTfrAction} className="flex items-end gap-2">
            <input type="hidden" name="ids" value={selected.join(',')} />
            <input type="hidden" name="isTransfer" value="1" />
            <SubmitButton>Mark transfer</SubmitButton>
          </form>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b dark:border-slate-800">
              <th className="py-2" />
              <th>Date</th>
              <th>Account</th>
              <th>Description</th>
              <th className="text-right">Amount</th>
              <th>Category</th>
              <th>Person</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-2">
                  <input type="checkbox" checked={selected.includes(row.id)} onChange={() => toggle(row.id)} aria-label={`Select transaction ${row.id}`} />
                </td>
                <td>{row.date}</td>
                <td>{row.accountName}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => setRenaming({ id: row.id, current: row.displayDescription ?? row.rawDescription, merchant: row.normalizedMerchant })}
                    title={row.displayDescription ? `Bank text: ${row.rawDescription}` : 'Click to rename'}
                    className="text-left hover:underline"
                  >
                    {row.displayDescription ?? row.rawDescription}
                  </button>
                  {row.displaySource === 'manual' ? <span className="ml-2 rounded bg-sky-100 px-1 text-xs dark:bg-sky-950">renamed</span> : null}
                  {row.displaySource === 'rename' ? <span className="ml-2 rounded bg-sky-50 px-1 text-xs dark:bg-sky-900">rule</span> : null}
                  {row.isTransfer ? <span className="ml-2 rounded bg-slate-200 px-1 text-xs dark:bg-slate-800">transfer</span> : null}
                  {row.source === 'bayes' ? <span className="ml-2 rounded bg-amber-100 px-1 text-xs dark:bg-amber-950">guess</span> : null}
                </td>
                <td className="text-right tabular-nums">{formatCents(row.amountCents)}</td>
                <td>
                  <form action={rowAction} className="flex items-center gap-1">
                    <input type="hidden" name="transactionId" value={row.id} />
                    {/* Full (archived-inclusive) category list here, on purpose: if this row's
                        category was archived after the fact, it must still appear as a real
                        <option> so the browser's initial selection matches it. Otherwise the
                        select silently falls back to "Uncategorized" and an untouched "save"
                        click would clear (and untrain) a legitimate historical categorization.
                        Archived options are disabled so they can't be freshly assigned to a
                        different row. */}
                    <select name="categoryId" defaultValue={row.categoryId ?? ''} className="rounded border px-1 py-0.5 text-xs dark:bg-slate-900">
                      <option value="">Uncategorized</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id} disabled={c.isArchived}>
                          {label(c.id)}{c.isArchived ? ' (archived)' : ''}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="text-xs underline">save</button>
                  </form>
                </td>
                <td>
                  <form action={attrAction} className="flex items-center gap-1">
                    <input type="hidden" name="ids" value={row.id} />
                    <select name="attributedUserId" defaultValue={row.attributedUserId ?? ''} className="rounded border px-1 py-0.5 text-xs dark:bg-slate-900">
                      <option value="">Household</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <button type="submit" className="text-xs underline">save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm">
        Page {page.page} of {page.pageCount} — {page.total} transactions
      </p>

      <form action={manualAction} className="flex max-w-xl flex-col gap-3 rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
        <h2 className="font-medium">Add a transaction</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            Date
            <input type="date" name="date" defaultValue={today} required className="rounded border px-2 py-1 dark:bg-slate-900" />
          </label>
          <label className="flex flex-col gap-1">
            Account
            <select name="accountId" className="rounded border px-2 py-1 dark:bg-slate-900">
              <option value="cash">My cash</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1">
            Description
            <input name="description" required className="rounded border px-2 py-1 dark:bg-slate-900" />
          </label>
          <label className="flex flex-col gap-1">
            Amount
            <input name="amount" placeholder="12.34" required className="rounded border px-2 py-1 dark:bg-slate-900" />
          </label>
          <label className="flex flex-col gap-1">
            Direction
            <select name="direction" className="rounded border px-2 py-1 dark:bg-slate-900">
              <option value="spend">Money out</option>
              <option value="income">Money in</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Category
            <select name="categoryId" className="rounded border px-2 py-1 dark:bg-slate-900">
              <option value="">Leave to the categorizer</option>
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>{label(c.id)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Person
            <select name="attributedUserId" className="rounded border px-2 py-1 dark:bg-slate-900">
              <option value="">Account default</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
        <SubmitButton>Add transaction</SubmitButton>
      </form>
    </div>
  );
}
