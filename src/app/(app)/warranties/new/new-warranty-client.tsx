'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { ReceiptUploader, type StagedFile, type SuggestedFieldsDto } from '@/components/warranty/ReceiptUploader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field, inputClass, labelClass, selectClass, textareaClass } from '@/components/ui/form';
import { isIsoDate } from '@/lib/dates';
import {
  BILLING_CYCLE_LABELS,
  BILLING_CYCLES,
  billingAllowedForKind,
  coveredThroughLabelForKind,
  formOpenEndedLabel,
  formStartLabel,
  formTermLabel,
  type ItemKind,
} from '@/lib/warranty/constants';
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
  types: { id: number; name: string; kind: ItemKind }[];
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

  // IMPORTANT 6: `touched` mirrored into a ref, kept in sync by the effect below. onSuggestions
  // reads touchedRef.current directly instead of using setTouched's updater purely to PEEK at
  // the latest value (as it did before) -- a setState updater must be a pure function of its
  // previous value, and calling setPurchaseDate/setVendor/setPrice/setSuggested from inside
  // one is a side effect that React StrictMode's double-invocation would run twice. Reading a
  // ref carries no such contract and still sees the up-to-date value, since this callback only
  // ever runs from an async fetch resolution that lands strictly after any render+effect
  // cycle a same-tick keystroke would have already completed -- the race protection MUST-10.3
  // depends on is unchanged.
  const touchedRef = useRef(touched);
  useEffect(() => {
    touchedRef.current = touched;
  }, [touched]);

  const [months, setMonths] = useState('');
  const [isLifetime, setIsLifetime] = useState(false);
  const [typeId, setTypeId] = useState('');
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [billingCycle, setBillingCycle] = useState('');
  const [billingAmount, setBillingAmount] = useState('');

  const onStagedChange = useCallback((files: StagedFile[]) => setStaged(files), []);

  /** MUST-10.3: only EMPTY, untouched fields are filled from a suggestion. */
  const onSuggestions = useCallback((fields: SuggestedFieldsDto) => {
    const current = touchedRef.current;
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
  }, []);

  const monthsNumber = /^\d+$/.test(months) ? Number(months) : null;
  const expiry =
    !isLifetime && monthsNumber !== null && monthsNumber > 0 && isIsoDate(purchaseDate)
      ? computeExpiryDate({ purchaseDate, warrantyMonths: monthsNumber, isLifetime: false })
      : null;
  // Delta T9, generalized to `kind` in v1.2.2 Task 2: the selected type's kind decides every
  // date label on this form -- via the KIND_WORDING matrix helpers in constants.ts, the one
  // place this wording lives (MUST-19.11). No type selected reads as a plain warranty.
  const selectedType = types.find((t) => String(t.id) === typeId);
  const selectedKind: ItemKind = selectedType?.kind ?? 'warranty';
  // v1.3.0: Billing fields only apply to subscription/contract kinds. Switching the type
  // away from one of those clears whatever was entered, so a stale value never gets to
  // submit alongside a kind that does not carry billing (fields simply leave the DOM, and
  // an absent form field posts as blank -> null, same mechanism as every other optional
  // field on this form).
  const billingApplicable = billingAllowedForKind(selectedKind);
  useEffect(() => {
    if (!billingApplicable) {
      setBillingCycle('');
      setBillingAmount('');
    }
  }, [billingApplicable]);

  /**
   * The prefill marker. OCR filling a blank field is helpful right up until nobody can
   * tell which values a machine guessed, so each guessed field says so and offers the
   * one-click way out.
   */
  const suggestedNote = (flag: boolean, clear: () => void) =>
    flag ? (
      <span className="flex items-center gap-1.5 text-xs text-warning">
        suggested from receipt
        <button type="button" onClick={clear} className="btn btn--ghost btn--sm px-1.5 text-xs underline">
          clear
        </button>
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Contracts & Coverage"
        title="Add item"
        description="Attach the receipt first and the date, vendor and price fill themselves in."
        actions={
          <Link href="/warranties" className="btn btn--ghost btn--sm">
            Back to items
          </Link>
        }
      />
      <FormError message={state.error} />

      <Card>
        <CardHeader title="Receipt" description="Photograph it or attach a PDF. Reading happens on this machine — nothing is uploaded anywhere." />
        <CardBody>
          <ReceiptUploader onStagedChange={onStagedChange} onSuggestions={onSuggestions} />
        </CardBody>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader title="The item" />
        <CardBody>
          <form action={action} className="flex flex-col gap-4">
            <input
              type="hidden"
              name="staged"
              value={JSON.stringify(staged.map((f) => ({ stagingId: f.stagingId, originalFilename: f.originalFilename })))}
            />
            <input type="hidden" name="transactionId" value={prefill.transactionId ?? ''} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" className="sm:col-span-2">
                <input name="name" required maxLength={200} className={inputClass} />
              </Field>

              <Field label="Type">
                <select name="typeId" value={typeId} onChange={(e) => setTypeId(e.target.value)} className={selectClass}>
                  <option value="">— none —</option>
                  {types.map((type) => (
                    <option key={type.id} value={type.id}>{type.name}</option>
                  ))}
                </select>
              </Field>

              <Field
                label="Vendor"
                htmlFor="warranty-vendor"
                hint={suggestedNote(suggested.vendor, () => {
                  setVendor('');
                  setSuggested((s) => ({ ...s, vendor: false }));
                })}
              >
                <input
                  id="warranty-vendor"
                  name="vendor"
                  maxLength={200}
                  value={vendor}
                  onChange={(e) => {
                    setVendor(e.target.value);
                    setTouched((t) => ({ ...t, vendor: true }));
                    setSuggested((s) => ({ ...s, vendor: false }));
                  }}
                  className={inputClass}
                />
              </Field>

              <Field label="Model">
                <input name="model" maxLength={200} className={inputClass} />
              </Field>

              <Field label="Serial number">
                <input name="serial" maxLength={200} className={inputClass} />
              </Field>

              <Field
                label={formStartLabel(selectedKind)}
                htmlFor="warranty-purchase-date"
                hint={suggestedNote(suggested.purchaseDate, () => {
                  setPurchaseDate('');
                  setSuggested((s) => ({ ...s, purchaseDate: false }));
                })}
              >
                <input
                  id="warranty-purchase-date"
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
                  className={inputClass}
                />
              </Field>

              <Field
                label="Price"
                htmlFor="warranty-price"
                hint={suggestedNote(suggested.price, () => {
                  setPrice('');
                  setSuggested((s) => ({ ...s, price: false }));
                })}
              >
                <input
                  id="warranty-price"
                  name="price"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => {
                    setPrice(e.target.value);
                    setTouched((t) => ({ ...t, price: true }));
                    setSuggested((s) => ({ ...s, price: false }));
                  }}
                  className={inputClass}
                />
              </Field>

              {/* v1.3.0: Billing only applies to subscription/contract kinds -- hidden
                  entirely for warranty/loan, so an absent field posts as blank -> null
                  (readBillingCycle/readBillingAmountCents in actions.ts). */}
              {billingApplicable ? (
                <>
                  <Field label="Billing">
                    <select
                      name="billingCycle"
                      value={billingCycle}
                      onChange={(e) => setBillingCycle(e.target.value)}
                      className={selectClass}
                    >
                      <option value="">Not set</option>
                      {BILLING_CYCLES.map((cycle) => (
                        <option key={cycle} value={cycle}>{BILLING_CYCLE_LABELS[cycle]}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Amount">
                    <input
                      name="billingAmount"
                      inputMode="decimal"
                      placeholder="e.g. 15.99"
                      value={billingAmount}
                      onChange={(e) => setBillingAmount(e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                </>
              ) : null}
            </div>

            <fieldset className="flex flex-col gap-2">
              {/* v1.2.2 Task 2 (reviewer-flagged): this legend used to hard-code "Warranty
                  length" regardless of the selected type's kind, breaking MUST-19.11's
                  one-place rule. Routed through formTermLabel() like every other date label
                  on this form. */}
              <legend className={labelClass}>{formTermLabel(selectedKind)}</legend>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="number"
                  name="warrantyMonths"
                  min={1}
                  placeholder="months"
                  value={months}
                  disabled={isLifetime}
                  aria-label={formTermLabel(selectedKind)}
                  onChange={(e) => setMonths(e.target.value)}
                  className="field-control w-28"
                />
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    name="isLifetime"
                    checked={isLifetime}
                    onChange={(e) => {
                      setIsLifetime(e.target.checked);
                      // MUST-3.5: a lifetime warranty has no term to store.
                      if (e.target.checked) setMonths('');
                    }}
                    className="accent-accent"
                  />
                  {formOpenEndedLabel(selectedKind)}
                </label>
                {/* MUST-10.4: the clamp rule is visible rather than surprising. Delta T9,
                    generalized to `kind` in v1.2.2 Task 2: the label switches per the
                    selected type's kind via coveredThroughLabelForKind(). */}
                {expiry ? (
                  <span className="badge badge--accent">
                    {coveredThroughLabelForKind(selectedKind)} {expiry}
                  </span>
                ) : null}
              </div>
              <span className="field-hint">Leave both blank if you do not know the term.</span>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Owner">
                <select name="ownerUserId" defaultValue={String(currentUserId)} className={selectClass}>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>{person.name}</option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Notes">
              <textarea name="notes" maxLength={2000} rows={3} className={textareaClass} />
            </Field>

            {/* Never disabled by OCR: the Save button's only busy state is the form submission
                itself, via useFormStatus inside SubmitButton (MUST-10.2 step 2). */}
            <SubmitButton className="w-fit">Save warranty</SubmitButton>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
