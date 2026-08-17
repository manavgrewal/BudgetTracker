'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { WarrantiesIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import {
  createItemTypeAction,
  deleteItemTypeAction,
  renameItemTypeAction,
  setKindAction,
  type ItemTypesFormState,
} from './actions';
import type { ItemTypeWithUsage } from '@/lib/warranty/types';
import { ITEM_KINDS, ITEM_KIND_LABELS } from '@/lib/warranty/constants';

const initialState: ItemTypesFormState = {};

const rowInput = 'field-control w-auto px-2 py-1 text-xs';
const rowButton = 'btn btn--secondary btn--sm';

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
  const [flagState, changeKind] = useActionState(async (prev: ItemTypesFormState, formData: FormData) => {
    setActiveSlot('flag');
    return setKindAction(prev, formData);
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
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Item types"
        description={
          <>
            The list members choose from when they record an item. Each type has a{' '}
            <strong className="font-semibold text-ink">kind</strong> — warranty, subscription, contract or loan —
            which changes the wording on those items (for example, a subscription shows a{' '}
            <strong className="font-semibold text-ink">cancel by</strong> date instead of an expiry date), and the
            dashboard reminds you before the period ends.
          </>
        }
      />

      <Card className="max-w-md">
        <CardHeader title="Add a type" />
        <CardBody>
          <form action={create} className="flex flex-col gap-4">
            <FormError message={createState.error} />
            {createState.message ? <Notice tone="success">{createState.message}</Notice> : null}
            <Field label="Type name">
              <input name="name" placeholder="Appliance" required maxLength={60} className={inputClass} />
            </Field>
            <Field label="Kind">
              {/*
                A plain <select> -- FormData.get() only ever returns one value for this key
                either way, but a <select> also sidesteps the hidden-input-shadowing bug a
                checkbox had here (see the create-form regression tests): there is exactly one
                control and exactly one value, chosen, never inferred from absence.
              */}
              <select name="kind" defaultValue="warranty" className={selectClass}>
                {ITEM_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {ITEM_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <SubmitButton className="w-fit">Add type</SubmitButton>
          </form>
        </CardBody>
      </Card>

      <FormError message={rowError} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <Card>
        <CardHeader title="Types" description={`${types.length} type${types.length === 1 ? '' : 's'}.`} />
        {types.length === 0 ? (
          <EmptyState icon={WarrantiesIcon} title="No item types yet">
            Add one above — Appliance, Electronics and Subscription are a good start.
          </EmptyState>
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col" className="text-right">Items using it</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {types.map((type) => (
                <tr key={type.id} className="align-top">
                  <td className="font-medium text-ink">{type.name}</td>
                  <td>
                    <span className={type.kind === 'warranty' ? 'badge badge--muted' : 'badge badge--accent'}>
                      {ITEM_KIND_LABELS[type.kind]}
                    </span>
                  </td>
                  <td className="tabnum text-right text-muted">{type.usageCount}</td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <form action={rename} className="flex gap-1">
                        <input type="hidden" name="typeId" value={type.id} />
                        <input
                          name="name"
                          defaultValue={type.name}
                          maxLength={60}
                          aria-label={`Rename ${type.name}`}
                          className={`w-36 ${rowInput}`}
                        />
                        <button type="submit" className={rowButton}>
                          Rename
                        </button>
                      </form>
                      <form action={changeKind} className="flex gap-1">
                        <input type="hidden" name="typeId" value={type.id} />
                        <select
                          name="kind"
                          defaultValue={type.kind}
                          aria-label={`Kind of ${type.name}`}
                          className={rowInput}
                        >
                          {ITEM_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {ITEM_KIND_LABELS[kind]}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className={rowButton}>
                          Update kind
                        </button>
                      </form>
                      <form action={remove}>
                        <input type="hidden" name="typeId" value={type.id} />
                        <button
                          type="submit"
                          disabled={type.usageCount > 0}
                          title={type.usageCount > 0 ? `${type.usageCount} item(s) use this type` : undefined}
                          className={rowButton}
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
