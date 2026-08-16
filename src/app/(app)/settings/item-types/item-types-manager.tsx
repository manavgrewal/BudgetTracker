'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import {
  createItemTypeAction,
  deleteItemTypeAction,
  renameItemTypeAction,
  setSubscriptionAction,
  type ItemTypesFormState,
} from './actions';
import type { ItemTypeWithUsage } from '@/lib/warranty/types';

const initialState: ItemTypesFormState = {};

/**
 * Which of the three per-row actions most recently ran. Without this, a stale success
 * message from one row action (e.g. a rename) could render beside a fresh error from a
 * different one (e.g. a delete refusal) -- two unrelated results shown as if simultaneous.
 * Only the latest action's result is ever displayed.
 */
type RowActionSlot = 'rename' | 'flag' | 'delete' | null;

export function ItemTypesManager({ types }: { types: ItemTypeWithUsage[] }) {
  const [createState, create] = useActionState(createItemTypeAction, initialState);
  const [activeSlot, setActiveSlot] = useState<RowActionSlot>(null);

  const [renameState, rename] = useActionState(async (prev: ItemTypesFormState, formData: FormData) => {
    setActiveSlot('rename');
    return renameItemTypeAction(prev, formData);
  }, initialState);
  const [flagState, toggle] = useActionState(async (prev: ItemTypesFormState, formData: FormData) => {
    setActiveSlot('flag');
    return setSubscriptionAction(prev, formData);
  }, initialState);
  const [deleteState, remove] = useActionState(async (prev: ItemTypesFormState, formData: FormData) => {
    setActiveSlot('delete');
    return deleteItemTypeAction(prev, formData);
  }, initialState);

  const rowState =
    activeSlot === 'rename' ? renameState : activeSlot === 'flag' ? flagState : activeSlot === 'delete' ? deleteState : undefined;
  const rowError = rowState?.error;
  const rowMessage = rowState?.message;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Item types</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        The list members choose from when they record a warranty. Marking a type as a subscription changes
        the wording on those items: they show a <strong>cancel by</strong> date instead of an expiry date, and
        the dashboard reminds you before the period ends.
      </p>

      <form action={create} className="flex max-w-md flex-col gap-3">
        <h2 className="text-sm font-medium">Add a type</h2>
        <FormError message={createState.error} />
        {createState.message ? <p className="text-sm text-green-700 dark:text-green-400">{createState.message}</p> : null}
        <input
          name="name"
          placeholder="Type name (e.g. Appliance)"
          required
          maxLength={60}
          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
        <label className="flex items-center gap-2 text-sm">
          {/*
            No sibling hidden input here: FormData.get() returns the FIRST value for a
            repeated key, so a hidden "0" placed before this box would always win over the
            checkbox's "1" and the admin's choice would be silently discarded. The action's
            `formData.get('isSubscription') ?? '0'` already covers the unchecked case, since
            an unticked checkbox submits no entry for its name at all.
          */}
          <input type="checkbox" name="isSubscription" value="1" />
          This is a subscription (show a cancel-by date)
        </label>
        <SubmitButton>Add type</SubmitButton>
      </form>

      <FormError message={rowError} />
      {rowMessage ? <p className="text-sm text-green-700 dark:text-green-400">{rowMessage}</p> : null}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-2">Name</th>
            <th>Subscription</th>
            <th>Items using it</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {types.map((type) => (
            <tr key={type.id} className="border-b border-slate-100 align-top dark:border-slate-900">
              <td className="py-2">{type.name}</td>
              <td>{type.isSubscription ? 'yes' : 'no'}</td>
              <td>{type.usageCount}</td>
              <td className="py-2">
                <div className="flex flex-wrap gap-2">
                  <form action={rename} className="flex gap-1">
                    <input type="hidden" name="typeId" value={type.id} />
                    <input
                      name="name"
                      defaultValue={type.name}
                      maxLength={60}
                      aria-label={`Rename ${type.name}`}
                      className="w-40 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                    />
                    <button type="submit" className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">
                      Rename
                    </button>
                  </form>
                  <form action={toggle}>
                    <input type="hidden" name="typeId" value={type.id} />
                    <input type="hidden" name="isSubscription" value={type.isSubscription ? '0' : '1'} />
                    <button type="submit" className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">
                      {type.isSubscription ? 'Not a subscription' : 'Mark as subscription'}
                    </button>
                  </form>
                  <form action={remove}>
                    <input type="hidden" name="typeId" value={type.id} />
                    <button
                      type="submit"
                      disabled={type.usageCount > 0}
                      title={type.usageCount > 0 ? `${type.usageCount} item(s) use this type` : undefined}
                      className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50 dark:border-slate-700"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
