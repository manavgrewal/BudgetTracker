'use client';

import { useActionState, useCallback, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { StatusBadge } from '@/components/warranty/StatusBadge';
import { ReceiptUploader, type StagedFile } from '@/components/warranty/ReceiptUploader';
import { formatCents } from '@/lib/money';
import { expiryDateLabel, purchaseDateLabel, termLabel } from '@/lib/warranty/constants';
import type { WarrantyStatus } from '@/lib/warranty/expiry';
import type { WarrantyItemRow, WarrantyReceiptRow } from '@/lib/warranty/items';
import {
  attachReceiptsAction,
  deleteReceiptAction,
  deleteWarrantyAction,
  reRunOcrAction,
  updateWarrantyAction,
  type WarrantyActionState,
} from '../actions';

const initial: WarrantyActionState = {};

const OCR_CHIP: Record<WarrantyReceiptRow['ocrStatus'], string> = {
  pending: 'Reading…',
  done: 'Read',
  failed: 'Could not read',
};

type TypeOption = { id: number; name: string; isSubscription: boolean };

/**
 * IMPORTANT 5: a link-styled submit button with the same busy contract as SubmitButton,
 * for the small per-receipt actions (Re-run OCR / Remove) that don't want the filled-button
 * look. useFormStatus() only sees the nearest enclosing <form>, so each of these renders
 * inside its own single-button form -- exactly like the ones it replaces.
 */
function LinkSubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="underline disabled:opacity-60">
      {pending ? 'Working…' : children}
    </button>
  );
}

export function WarrantyDetailClient({
  item,
  receipts,
  status,
  people,
  types,
  today,
  linkedTransaction,
  linkRemoved,
}: {
  item: WarrantyItemRow;
  receipts: WarrantyReceiptRow[];
  status: WarrantyStatus;
  people: { id: number; name: string }[];
  /** Delta T9: an optional type dropdown, same list as the add form. */
  types: TypeOption[];
  today: string;
  linkedTransaction: { id: number; date: string; description: string } | null;
  linkRemoved: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  // M10: bumped after a successful attach to remount <ReceiptUploader> with a clean slate --
  // otherwise a second click posts the SAME (now-consumed) staging ids and the action fails
  // with "That upload expired". ReceiptUploader owns its file-tile state internally, so a
  // fresh key is the only way to reset it from here.
  const [uploaderKey, setUploaderKey] = useState(0);
  const onStagedChange = useCallback((files: StagedFile[]) => setStaged(files), []);

  // M13: which of the five actions below most recently ran. Without this, an error/message
  // from one (e.g. a stale Re-run OCR result) could render beside an unrelated result from
  // another (e.g. a fresh Remove) merged in by `??` -- only the latest action's own result is
  // ever shown, mirroring settings/item-types/item-types-manager.tsx's activeSlot pattern.
  type ActionSlot = 'edit' | 'delete' | 'attach' | 'remove' | 'ocr' | null;
  const [activeSlot, setActiveSlot] = useState<ActionSlot>(null);

  const [editState, editAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('edit');
    return updateWarrantyAction(prev, formData);
  }, initial);
  const [deleteState, deleteAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('delete');
    return deleteWarrantyAction(prev, formData);
  }, initial);
  const [attachState, attachAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('attach');
    return attachReceiptsAction(prev, formData);
  }, initial);
  const [removeState, removeAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('remove');
    return deleteReceiptAction(prev, formData);
  }, initial);
  const [ocrState, ocrAction] = useActionState(async (prev: WarrantyActionState, formData: FormData) => {
    setActiveSlot('ocr');
    return reRunOcrAction(prev, formData);
  }, initial);

  const slotState =
    activeSlot === 'edit'
      ? editState
      : activeSlot === 'delete'
        ? deleteState
        : activeSlot === 'attach'
          ? attachState
          : activeSlot === 'remove'
            ? removeState
            : activeSlot === 'ocr'
              ? ocrState
              : undefined;
  const error = slotState?.error;
  const notice = slotState?.message;

  // M10: a successful attach (a message with no error) clears the staged list and remounts
  // the uploader. Keyed on the attachState object itself -- useActionState hands back a new
  // object only when the action actually ran, so this fires exactly once per real attach.
  useEffect(() => {
    if (attachState.message && !attachState.error) {
      setStaged([]);
      setUploaderKey((key) => key + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachState]);

  // Delta T9 (MUST-19.10): every date label on this page switches on the item's own
  // isSubscription flag through these three helpers -- the only place either wording lives.
  const purchaseLabel = purchaseDateLabel(item.isSubscription);
  const termWordLabel = termLabel(item.isSubscription);
  const expiryLabel = expiryDateLabel(item.isSubscription);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{item.name}</h1>
          <StatusBadge status={status} expiryDate={item.expiryDate} today={today} isSubscription={item.isSubscription} />
        </div>
        <Link href="/warranties" className="text-sm underline">Back to warranties</Link>
      </div>

      <FormError message={error} />
      {notice ? <p className="text-sm text-green-700 dark:text-green-400">{notice}</p> : null}

      <dl className="grid max-w-2xl grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt className="text-slate-500">Type</dt><dd>{item.typeName ?? '—'}</dd>
        <dt className="text-slate-500">Vendor</dt><dd>{item.vendor ?? '—'}</dd>
        <dt className="text-slate-500">Model</dt><dd>{item.model ?? '—'}</dd>
        <dt className="text-slate-500">Serial number</dt><dd>{item.serial ?? '—'}</dd>
        <dt className="text-slate-500">{purchaseLabel}</dt><dd>{item.purchaseDate}</dd>
        <dt className="text-slate-500">{termWordLabel}</dt>
        <dd>{item.isLifetime ? 'Lifetime' : item.warrantyMonths === null ? 'Unknown' : `${item.warrantyMonths} months`}</dd>
        <dt className="text-slate-500">{expiryLabel}</dt><dd>{item.expiryDate ?? '—'}</dd>
        <dt className="text-slate-500">Price</dt><dd>{item.priceCents === null ? '—' : formatCents(item.priceCents)}</dd>
        <dt className="text-slate-500">Owner</dt><dd>{item.ownerName}</dd>
        <dt className="text-slate-500">Notes</dt><dd>{item.notes ?? '—'}</dd>
        <dt className="text-slate-500">Transaction</dt>
        <dd>
          {linkedTransaction ? (
            <Link href={`/transactions?q=${encodeURIComponent(linkedTransaction.description)}`} className="underline">
              {linkedTransaction.date} · {linkedTransaction.description}
            </Link>
          ) : linkRemoved ? (
            'The linked transaction was removed by an import undo'
          ) : (
            '—'
          )}
        </dd>
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Receipts ({receipts.length} receipt{receipts.length === 1 ? '' : 's'})</h2>
        {receipts.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">No receipts attached yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-4">
            {receipts.map((receipt) => (
              <li key={receipt.id} className="flex w-48 flex-col gap-1 rounded border p-2 text-xs dark:border-slate-700">
                {!receipt.fileExists ? (
                  <span className="text-slate-500">file missing</span>
                ) : receipt.mime === 'application/pdf' ? (
                  // MUST-5.3: PDFs are LINKED, never embedded — an inline same-origin PDF
                  // runs the viewer's JavaScript in our origin.
                  <a href={`/api/warranties/receipts/${receipt.id}`} className="underline">Download PDF</a>
                ) : (
                  <a href={`/api/warranties/receipts/${receipt.id}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/warranties/receipts/${receipt.id}`}
                      alt={receipt.originalFilename}
                      className="max-h-32 w-full object-contain"
                    />
                  </a>
                )}
                {/* MUST-13.3: original_filename and ocr_error are attacker-influenceable and
                    are rendered as TEXT NODES only, never as HTML. */}
                <span className="truncate" title={receipt.originalFilename}>{receipt.originalFilename}</span>
                <span className="text-slate-500">{Math.round(receipt.sizeBytes / 1024)} KB · {OCR_CHIP[receipt.ocrStatus]}</span>
                {receipt.ocrError ? <span className="text-red-700 dark:text-red-300">{receipt.ocrError}</span> : null}
                <div className="flex gap-2">
                  <form action={ocrAction}>
                    <input type="hidden" name="receiptId" value={receipt.id} />
                    <LinkSubmitButton>Re-run OCR</LinkSubmitButton>
                  </form>
                  <form
                    action={removeAction}
                    onSubmit={(event) => {
                      if (!confirm(`Remove ${receipt.originalFilename}?`)) event.preventDefault();
                    }}
                  >
                    <input type="hidden" name="receiptId" value={receipt.id} />
                    <LinkSubmitButton>Remove</LinkSubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form action={attachAction} className="flex flex-col gap-2">
          <input type="hidden" name="itemId" value={item.id} />
          <input
            type="hidden"
            name="staged"
            value={JSON.stringify(staged.map((f) => ({ stagingId: f.stagingId, originalFilename: f.originalFilename })))}
          />
          <ReceiptUploader key={uploaderKey} onStagedChange={onStagedChange} label="Add another receipt" />
          <SubmitButton className="w-fit">Attach receipts</SubmitButton>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex gap-3">
          <button type="button" onClick={() => setEditing((v) => !v)} className="rounded border px-3 py-1 text-sm dark:border-slate-700">
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
          <button type="button" onClick={() => setConfirming(true)} className="rounded border px-3 py-1 text-sm text-red-700 dark:border-slate-700 dark:text-red-300">
            Delete item
          </button>
        </div>

        {confirming ? (
          <form action={deleteAction} className="flex flex-col gap-2 rounded border border-red-300 p-3 text-sm dark:border-red-800">
            <p>
              Delete <strong>{item.name}</strong> and its {receipts.length} receipt{receipts.length === 1 ? '' : 's'}?
              This cannot be undone.
            </p>
            <input type="hidden" name="itemId" value={item.id} />
            <div className="flex gap-2">
              <SubmitButton>Delete permanently</SubmitButton>
              <button type="button" onClick={() => setConfirming(false)} className="rounded border px-3 py-2 dark:border-slate-700">
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {editing ? <EditForm item={item} people={people} types={types} today={today} action={editAction} /> : null}
      </section>
    </div>
  );
}

function EditForm({
  item,
  people,
  types,
  today,
  action,
}: {
  item: WarrantyItemRow;
  people: { id: number; name: string }[];
  types: TypeOption[];
  today: string;
  action: (formData: FormData) => void;
}) {
  const [isLifetime, setIsLifetime] = useState(item.isLifetime);
  const [months, setMonths] = useState(item.warrantyMonths === null ? '' : String(item.warrantyMonths));

  return (
    <form action={action} className="flex max-w-2xl flex-col gap-3 text-sm">
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="transactionId" value={item.transactionId ?? ''} />
      <input type="hidden" name="staged" value="[]" />

      <label className="flex flex-col gap-1">
        Name
        <input name="name" required maxLength={200} defaultValue={item.name} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Type
        <select name="typeId" defaultValue={item.typeId ?? ''} className="w-56 rounded border px-2 py-1 dark:bg-slate-900">
          <option value="">— none —</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>{type.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Vendor
        <input name="vendor" maxLength={200} defaultValue={item.vendor ?? ''} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Model
        <input name="model" maxLength={200} defaultValue={item.model ?? ''} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Serial number
        <input name="serial" maxLength={200} defaultValue={item.serial ?? ''} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Purchase date
        <input type="date" name="purchaseDate" required max={today} defaultValue={item.purchaseDate} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend>Warranty length</legend>
        <input
          type="number"
          name="warrantyMonths"
          min={1}
          value={months}
          disabled={isLifetime}
          onChange={(e) => setMonths(e.target.value)}
          className="w-28 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="isLifetime"
            checked={isLifetime}
            onChange={(e) => {
              setIsLifetime(e.target.checked);
              if (e.target.checked) setMonths('');
            }}
          />
          Lifetime
        </label>
      </fieldset>
      <label className="flex flex-col gap-1">
        Price
        <input name="price" inputMode="decimal" defaultValue={item.priceCents === null ? '' : (item.priceCents / 100).toFixed(2)} className="w-40 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Owner
        <select name="ownerUserId" defaultValue={String(item.ownerUserId)} className="w-56 rounded border px-2 py-1 dark:bg-slate-900">
          {people.map((person) => (
            <option key={person.id} value={person.id}>{person.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Notes
        <textarea name="notes" maxLength={2000} rows={3} defaultValue={item.notes ?? ''} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <SubmitButton className="w-fit">Save changes</SubmitButton>
    </form>
  );
}
