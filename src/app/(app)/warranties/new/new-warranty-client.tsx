'use client';

import { useActionState, useCallback, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { ReceiptUploader, type StagedFile, type SuggestedFieldsDto } from '@/components/warranty/ReceiptUploader';
import { isIsoDate } from '@/lib/dates';
import { coveredThroughLabel } from '@/lib/warranty/constants';
import { computeExpiryDate } from '@/lib/warranty/expiry';
import { createWarrantyAction, type WarrantyActionState } from '../actions';

export interface WarrantyPrefill {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
  transactionId?: number;
}

const initial: WarrantyActionState = {};

function centsToInput(cents: number | undefined): string {
  return cents === undefined ? '' : (cents / 100).toFixed(2);
}

export function NewWarrantyClient({
  people,
  types,
  currentUserId,
  today,
  prefill,
}: {
  people: { id: number; name: string }[];
  /** Delta T9: an optional type dropdown -- "— none —" plus listItemTypes(). */
  types: { id: number; name: string; isSubscription: boolean }[];
  currentUserId: number;
  today: string;
  prefill: WarrantyPrefill;
}) {
  const [state, action] = useActionState(createWarrantyAction, initial);

  // MUST-11.4 / MUST-10.3: values that arrive as prefill are user-visible by the time the
  // form renders, so `touched` starts true for them and OCR can never overwrite them.
  const [purchaseDate, setPurchaseDate] = useState(prefill.purchaseDate ?? '');
  const [vendor, setVendor] = useState(prefill.vendor ?? '');
  const [price, setPrice] = useState(centsToInput(prefill.priceCents));
  const [touched, setTouched] = useState({
    purchaseDate: prefill.purchaseDate !== undefined,
    vendor: prefill.vendor !== undefined,
    price: prefill.priceCents !== undefined,
  });
  const [suggested, setSuggested] = useState({ purchaseDate: false, vendor: false, price: false });

  const [months, setMonths] = useState('');
  const [isLifetime, setIsLifetime] = useState(false);
  const [typeId, setTypeId] = useState('');
  const [staged, setStaged] = useState<StagedFile[]>([]);

  const onStagedChange = useCallback((files: StagedFile[]) => setStaged(files), []);

  /** MUST-10.3: only EMPTY, untouched fields are filled from a suggestion. */
  const onSuggestions = useCallback(
    (fields: SuggestedFieldsDto) => {
      setTouched((current) => {
        if (fields.purchaseDate && !current.purchaseDate) {
          setPurchaseDate(fields.purchaseDate);
          setSuggested((s) => ({ ...s, purchaseDate: true }));
        }
        if (fields.vendor && !current.vendor) {
          setVendor(fields.vendor);
          setSuggested((s) => ({ ...s, vendor: true }));
        }
        if (fields.priceCents !== undefined && !current.price) {
          setPrice(centsToInput(fields.priceCents));
          setSuggested((s) => ({ ...s, price: true }));
        }
        return current;
      });
    },
    [],
  );

  const monthsNumber = /^\d+$/.test(months) ? Number(months) : null;
  const expiry =
    !isLifetime && monthsNumber !== null && monthsNumber > 0 && isIsoDate(purchaseDate)
      ? computeExpiryDate({ purchaseDate, warrantyMonths: monthsNumber, isLifetime: false })
      : null;
  // Delta T9: the selected type's is_subscription flag decides the wording -- "Covered
  // through" vs "Cancel by" -- via coveredThroughLabel(), the one place this wording lives
  // (MUST-19.11). No type selected reads as a non-subscription item.
  const selectedType = types.find((t) => String(t.id) === typeId);
  const isSubscription = selectedType?.isSubscription ?? false;

  const suggestedNote = (flag: boolean, clear: () => void) =>
    flag ? (
      <span className="text-xs text-slate-500">
        suggested from receipt{' '}
        <button type="button" onClick={clear} className="underline">clear</button>
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Add warranty</h1>
      <FormError message={state.error} />

      <ReceiptUploader onStagedChange={onStagedChange} onSuggestions={onSuggestions} />

      <form action={action} className="flex max-w-2xl flex-col gap-3 text-sm">
        <input
          type="hidden"
          name="staged"
          value={JSON.stringify(staged.map((f) => ({ stagingId: f.stagingId, originalFilename: f.originalFilename })))}
        />
        <input type="hidden" name="transactionId" value={prefill.transactionId ?? ''} />

        <label className="flex flex-col gap-1">
          Name
          <input name="name" required maxLength={200} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
        </label>

        <label className="flex flex-col gap-1">
          Type
          <select
            name="typeId"
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="w-56 rounded border px-2 py-1 dark:bg-slate-900"
          >
            <option value="">— none —</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>{type.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          Vendor
          <input
            name="vendor"
            maxLength={200}
            value={vendor}
            onChange={(e) => {
              setVendor(e.target.value);
              setTouched((t) => ({ ...t, vendor: true }));
              setSuggested((s) => ({ ...s, vendor: false }));
            }}
            className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
          {suggestedNote(suggested.vendor, () => {
            setVendor('');
            setSuggested((s) => ({ ...s, vendor: false }));
          })}
        </label>

        <label className="flex flex-col gap-1">
          Model
          <input name="model" maxLength={200} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
        </label>

        <label className="flex flex-col gap-1">
          Serial number
          <input name="serial" maxLength={200} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
        </label>

        <label className="flex flex-col gap-1">
          Purchase date
          <input
            type="date"
            name="purchaseDate"
            required
            max={today}
            value={purchaseDate}
            onChange={(e) => {
              setPurchaseDate(e.target.value);
              setTouched((t) => ({ ...t, purchaseDate: true }));
              setSuggested((s) => ({ ...s, purchaseDate: false }));
            }}
            className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
          {suggestedNote(suggested.purchaseDate, () => {
            setPurchaseDate('');
            setSuggested((s) => ({ ...s, purchaseDate: false }));
          })}
        </label>

        <fieldset className="flex flex-col gap-1">
          <legend>Warranty length</legend>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="number"
              name="warrantyMonths"
              min={1}
              placeholder="months"
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
                  // MUST-3.5: a lifetime warranty has no term to store.
                  if (e.target.checked) setMonths('');
                }}
              />
              Lifetime
            </label>
            {/* MUST-10.4: the clamp rule is visible rather than surprising. Delta T9: the
                label itself swaps to "Cancel by" for a subscription type. */}
            {expiry ? (
              <span className="text-slate-600 dark:text-slate-300">
                {coveredThroughLabel(isSubscription)} {expiry}
              </span>
            ) : null}
          </div>
          <span className="text-xs text-slate-500">Leave both blank if you do not know the term.</span>
        </fieldset>

        <label className="flex flex-col gap-1">
          Price
          <input
            name="price"
            inputMode="decimal"
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              setTouched((t) => ({ ...t, price: true }));
              setSuggested((s) => ({ ...s, price: false }));
            }}
            className="w-40 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
          {suggestedNote(suggested.price, () => {
            setPrice('');
            setSuggested((s) => ({ ...s, price: false }));
          })}
        </label>

        <label className="flex flex-col gap-1">
          Owner
          <select name="ownerUserId" defaultValue={String(currentUserId)} className="w-56 rounded border px-2 py-1 dark:bg-slate-900">
            {people.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          Notes
          <textarea name="notes" maxLength={2000} rows={3} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
        </label>

        {/* Never disabled by OCR: the Save button's only busy state is the form submission
            itself, via useFormStatus inside SubmitButton (MUST-10.2 step 2). */}
        <SubmitButton className="w-fit">Save warranty</SubmitButton>
      </form>
    </div>
  );
}
