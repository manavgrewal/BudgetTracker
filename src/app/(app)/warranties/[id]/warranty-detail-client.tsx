'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { LoanProgressBar } from '@/components/LoanProgressBar';
import { SubmitButton } from '@/components/SubmitButton';
import { StatusBadge } from '@/components/warranty/StatusBadge';
import { ReceiptUploader, type StagedFile } from '@/components/warranty/ReceiptUploader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, labelClass, selectClass, textareaClass } from '@/components/ui/form';
import { formatCents } from '@/lib/money';
import type { LoanRule } from '@/lib/loans';
import {
  BILLING_CYCLE_LABELS,
  BILLING_CYCLES,
  billingAllowedForKind,
  billingAmountLabelForKind,
  billingCycleSuffixForKind,
  billingSectionLabelForKind,
  formEndLabel,
  formOpenEndedLabel,
  formStartLabel,
  formTermLabel,
  loanFieldsAllowedForKind,
  openEndedDisplayLabel,
  type ItemKind,
} from '@/lib/warranty/constants';
import type { WarrantyStatus } from '@/lib/warranty/expiry';
import type { WarrantyItemRow, WarrantyReceiptRow } from '@/lib/warranty/items';
import {
  attachReceiptsAction,
  deleteLoanRuleAction,
  deleteReceiptAction,
  deleteWarrantyAction,
  reRunOcrAction,
  saveLoanRuleAction,
  updateWarrantyAction,
  type WarrantyActionState,
} from '../actions';

const initial: WarrantyActionState = {};

const OCR_CHIP: Record<WarrantyReceiptRow['ocrStatus'], string> = {
  pending: 'Reading…',
  done: 'Read',
  failed: 'Could not read',
};

type TypeOption = { id: number; name: string; kind: ItemKind };

/**
 * IMPORTANT 5: a link-styled submit button with the same busy contract as SubmitButton,
 * for the small per-receipt actions (Re-run OCR / Remove) that don't want the filled-button
 * look. useFormStatus() only sees the nearest enclosing <form>, so each of these renders
 * inside its own single-button form -- exactly like the ones it replaces.
 */
function LinkSubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn btn--ghost btn--sm px-1.5 text-xs">
      {pending ? 'Working…' : children}
    </button>
  );
}

/** One label/value pair in the summary grid. */
function Detail({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0 sm:border-b-0 sm:py-0">
      <dt className="text-xs font-medium text-subtle">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
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
  rules,
  accounts,
  payoffFraction,
  lastPaymentAt,
  paymentCount,
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
  /** v1.3.1: the Payment matching sub-card's rules and account picker, loan-kind only. */
  rules: LoanRule[];
  accounts: { id: number; name: string }[];
  /** v1.3.1: from listLoans().find(...) on the server -- MUST-15.4's payoff math. */
  payoffFraction: number | null;
  lastPaymentAt: string | null;
  paymentCount: number;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Bug fix (v1.2.4): the swapped-in section (read-only view OR edit form, never both) lives
  // at this ref so a fallback scrollIntoView has something to target if it ever renders below
  // the fold -- the primary fix is REPLACING the view in place, not scrolling to it.
  const swapSectionRef = useRef<HTMLDivElement>(null);
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

  // v1.3.1: the Payment matching sub-card's own add/remove-rule state, reported inline within
  // the card rather than through the top FormError/Notice above -- it is not one of the five
  // actions the activeSlot mechanism disambiguates between.
  const [ruleState, addRule] = useActionState(saveLoanRuleAction, initial);
  // F3 fix-round: routed through useActionState (like addRule), not a bare fire-and-forget
  // reference -- a stale delete (the rule already removed in another tab) now surfaces "That
  // rule no longer exists." instead of failing silently. revalidateAll's own revalidatePath
  // call still refreshes `rules` from the server either way.
  const [deleteRuleState, removeRule] = useActionState(
    (_prev: WarrantyActionState, formData: FormData) => deleteLoanRuleAction(formData),
    initial,
  );

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

  // Bug fix (v1.2.4): a successful save (a message with no error) closes the edit form and
  // restores the read-only view -- "leaving edit (cancel/save) restores the view." Keyed on
  // the editState object itself, same idiom as the attach effect above, so this fires exactly
  // once per real save rather than on every render while editing is open.
  useEffect(() => {
    if (editState.message && !editState.error) {
      setEditing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editState]);

  // Bug fix (v1.2.4): the primary fix is REPLACING the read-only view with the edit form in
  // the same position (below), so scrolling is a fallback only -- guards against the edit
  // form ever rendering below the fold for some other reason (e.g. a very short viewport).
  useEffect(() => {
    // jsdom (the test environment) does not implement scrollIntoView at all -- guarded so
    // tests exercising `editing` don't crash on a method that simply isn't there.
    if (editing) swapSectionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [editing]);

  // Delta T9 (MUST-19.10), generalized to `kind` in v1.2.2 Task 2: every date label on this
  // page switches on the item's own kind through these helpers -- the only place either
  // wording lives. Supersedes purchaseDateLabel/termLabel/expiryDateLabel (controller ruling,
  // spec §19.12).
  const purchaseLabel = formStartLabel(item.kind);
  const termWordLabel = formTermLabel(item.kind);
  const expiryLabel = formEndLabel(item.kind);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{item.name}</h1>
          <StatusBadge status={status} expiryDate={item.expiryDate} today={today} kind={item.kind} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/warranties" className="btn btn--ghost btn--sm">Back to items</Link>
          <button type="button" onClick={() => setEditing((v) => !v)} className="btn btn--secondary btn--sm">
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
          <button type="button" onClick={() => setConfirming(true)} className="btn btn--ghost btn--sm money-neg">
            Delete item
          </button>
        </div>
      </div>

      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {confirming ? (
        <Card as="div" className="border-negative-soft">
          <CardBody className="pt-5">
            <form action={deleteAction} className="flex flex-col gap-3">
              <p className="text-sm text-ink">
                Delete <strong className="font-semibold">{item.name}</strong> and its {receipts.length} receipt{receipts.length === 1 ? '' : 's'}?
                This cannot be undone.
              </p>
              <input type="hidden" name="itemId" value={item.id} />
              <div className="flex gap-2">
                <SubmitButton variant="danger">Delete permanently</SubmitButton>
                <button type="button" onClick={() => setConfirming(false)} className="btn btn--secondary">
                  Cancel
                </button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {/* Bug fix (v1.2.4): the read-only view and the edit form now occupy the SAME position
          -- exactly one of them renders, never both -- so opening Edit replaces the view in
          place instead of appending a second form below it (and below Receipts) where a
          scrolled-down user would never see it appear. */}
      <div ref={swapSectionRef}>
        {editing ? (
          <EditForm item={item} people={people} types={types} today={today} action={editAction} />
        ) : (
          <Card>
            <CardBody className="pt-5">
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                <Detail label="Type">{item.typeName ?? '—'}</Detail>
                <Detail label="Vendor">{item.vendor ?? '—'}</Detail>
                <Detail label="Model">{item.model ?? '—'}</Detail>
                <Detail label="Serial number">{item.serial ?? '—'}</Detail>
                <Detail label={purchaseLabel}>{item.purchaseDate}</Detail>
                <Detail label={termWordLabel}>
                  {item.isLifetime
                    ? formOpenEndedLabel(item.kind)
                    : item.warrantyMonths === null
                      ? 'Unknown'
                      : `${item.warrantyMonths} months`}
                </Detail>
                {/* v1.3.0 fix: an open-ended item (isLifetime) has no expiry_date to show -- that
                    used to render as a bare blank/em dash here, which reads as broken. Show the
                    per-kind open-ended word instead; a non-lifetime item with a genuinely unknown
                    term still falls through to the em dash, unchanged. */}
                <Detail label={expiryLabel}>{item.isLifetime ? openEndedDisplayLabel(item.kind) : (item.expiryDate ?? '—')}</Detail>
                <Detail label="Price">{item.priceCents === null ? '—' : <Money cents={item.priceCents} plain />}</Detail>
                {billingAllowedForKind(item.kind) ? (
                  // review fix: cycle and amount are validated as a pair at the schema boundary
                  // (BILLING_PAIR_ERROR) -- render the value only when BOTH are present. Rendering
                  // one alone either lies (a blank placeholder next to "/ month", cycle set but no amount) or silently drops
                  // a value the member entered (amount set but no cycle shown) -- exactly the kind
                  // of blank-reads-as-broken defect task B set out to eliminate for the end date.
                  // F5 fix-round: this is now the ONLY billing/payment row on the page -- it used
                  // to be duplicated by a second "Payment" row in the money block below, showing
                  // the exact same cycle+amount twice under two different labels. The label
                  // itself is routed through the kind matrix (MUST-12.3) so a loan reads
                  // "Payment", not "Billing".
                  <Detail label={billingSectionLabelForKind(item.kind)}>
                    {item.billingCycle !== null && item.billingAmountCents !== null ? (
                      <>
                        <Money cents={item.billingAmountCents} plain /> {billingCycleSuffixForKind(item.kind, item.billingCycle)}
                      </>
                    ) : (
                      '—'
                    )}
                  </Detail>
                ) : null}
                <Detail label="Owner">{item.ownerName}</Detail>
                <Detail label="Notes">{item.notes ?? '—'}</Detail>
                <Detail label="Transaction">
                  {linkedTransaction ? (
                    <Link
                      href={`/transactions?q=${encodeURIComponent(linkedTransaction.description)}`}
                      className="text-accent-text underline underline-offset-2"
                    >
                      {linkedTransaction.date} · {linkedTransaction.description}
                    </Link>
                  ) : linkRemoved ? (
                    'The linked transaction was removed by an import undo'
                  ) : (
                    '—'
                  )}
                </Detail>
              </dl>

              {/* MUST-14.3: every row omitted when its value is null; the whole block omitted
                  when there is no principal AND no balance -- a loan item that has not had its
                  money fields filled in yet renders exactly like it did before this feature. */}
              {item.currentBalanceCents === null && item.principalCents === null ? null : (
                <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
                  {item.currentBalanceCents === null ? null : (
                    <>
                      <p className="money-lg">{formatCents(item.currentBalanceCents)}</p>
                      {/* MUST-11.8: "You set this on" and "Last payment" are labelled
                          DIFFERENTLY, because they answer different questions.
                          balance_updated_at is the human anchor. */}
                      {item.balanceUpdatedAt === null ? null : (
                        <p className="text-sm text-subtle">You set this on {item.balanceUpdatedAt.slice(0, 10)}</p>
                      )}
                    </>
                  )}
                  {/* F8 fix-round: a plain-voice heads-up next to the number people are about to
                      unassign a payment from -- removing an old link doesn't just undo one
                      transaction in isolation, it can leave the balance ahead of what the
                      household's latest paper statement says, and that's worth saying before
                      someone clicks Unassign expecting a plain undo. Gated on currentBalanceCents
                      too (micro round): a null balance isn't shown at all above, so a hint about
                      "the balance" would be pointing at a number that isn't even on the page. */}
                  {item.currentBalanceCents === null || paymentCount === 0 ? null : (
                    <p className="text-xs text-subtle">
                      Removing an old payment can push the balance above your latest statement figure.
                    </p>
                  )}
                  {payoffFraction === null ? null : <LoanProgressBar fraction={payoffFraction} label={item.name} />}
                  {/* F11 fix-round: the Detail rows below are dt/dd pairs and belong inside a
                      dl, same as the summary grid above -- they were previously loose divs. */}
                  {item.principalCents === null &&
                  item.interestRateBps === null &&
                  lastPaymentAt === null &&
                  paymentCount === 0 ? null : (
                    <dl className="flex flex-col gap-2">
                      {item.principalCents === null ? null : <Detail label="Original">{formatCents(item.principalCents)}</Detail>}
                      {item.interestRateBps === null ? null : (
                        <Detail label="Rate">{(item.interestRateBps / 100).toFixed(2)}%</Detail>
                      )}
                      {lastPaymentAt === null ? null : <Detail label="Last payment">{lastPaymentAt.slice(0, 10)}</Detail>}
                      {paymentCount === 0 ? null : <Detail label="Payments linked">{paymentCount}</Detail>}
                    </dl>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        )}
      </div>

      {/* MUST-14.5 / MUST-14.6 / MUST-13.9: loan-kind only. Always states the budget rule
          above the table, so the person reads it exactly where they are making the decision. */}
      {item.kind !== 'loan' ? null : (
        <Card>
          <CardHeader title="Payment matching" />
          <CardBody className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              When a transaction&apos;s merchant contains this text, the app treats it as a payment on this loan and
              takes it off the balance. The payment still counts in your budget and in your reports.
            </p>
            {rules.length === 0 ? null : (
              <>
                <TableWrap bare>
                  <thead>
                    <tr>
                      <th scope="col">Merchant contains</th>
                      <th scope="col">Account</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr key={rule.id}>
                        <td className="font-medium text-ink">{rule.merchantContains}</td>
                        <td className="text-muted">
                          {rule.accountId === null ? 'Any account' : (accounts.find((a) => a.id === rule.accountId)?.name ?? 'Any account')}
                        </td>
                        <td className="text-right">
                          <form action={removeRule}>
                            <input type="hidden" name="id" value={rule.id} />
                            <input type="hidden" name="itemId" value={item.id} />
                            <SubmitButton className="btn btn--ghost btn--sm">Remove</SubmitButton>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
                {/* F3 fix-round: the stale-delete case (removed already, e.g. in another tab)
                    now has somewhere to surface -- "That rule no longer exists." -- instead of
                    the click silently doing nothing. */}
                <FormError message={deleteRuleState.error} />
              </>
            )}
            <form action={addRule} className="flex flex-col gap-3">
              <input type="hidden" name="itemId" value={item.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Merchant contains">
                  <input name="merchantContains" className={inputClass} placeholder="e.g. HONDA FIN" />
                </Field>
                <Field label="Account">
                  <select name="accountId" className={selectClass} defaultValue="">
                    <option value="">Any account</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
              {/* MUST-13.9: UNCHECKED by default, and the hint says which case is which. A
                  person types today's balance and then saves a rule; back-filling a year of
                  payments would subtract them all from a figure that already accounts for
                  them. */}
              <label className="flex items-start gap-2 text-sm text-muted">
                <input type="checkbox" name="backfill" className="mt-1" />
                <span>
                  Also link matching payments from the last 12 months
                  <span className="field-hint block">
                    Only tick this if the balance you typed is the balance from before those payments. Ticking it
                    will subtract every payment it finds.
                  </span>
                </span>
              </label>
              <FormError message={ruleState.error} />
              {ruleState.message === undefined ? null : <Notice tone="success">{ruleState.message}</Notice>}
              <SubmitButton className="btn btn--primary self-start">Add rule</SubmitButton>
            </form>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title={<>Receipts ({receipts.length} receipt{receipts.length === 1 ? '' : 's'})</>}
          description="Photos and PDFs are stored on this machine and read offline."
        />
        <CardBody className="flex flex-col gap-4">
          {receipts.length === 0 ? (
            <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
              No receipts attached yet.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {receipts.map((receipt) => (
                <li
                  key={receipt.id}
                  className="flex w-48 flex-col gap-1.5 rounded-md border border-line bg-surface-2/50 p-2 text-xs"
                >
                  <span className="flex h-32 items-center justify-center overflow-hidden rounded-xs bg-surface">
                    {!receipt.fileExists ? (
                      <span className="text-subtle">file missing</span>
                    ) : receipt.mime === 'application/pdf' ? (
                      // MUST-5.3: PDFs are LINKED, never embedded. An inline same-origin PDF
                      // runs the viewer's JavaScript in our origin.
                      <a href={`/api/warranties/receipts/${receipt.id}`} className="text-accent-text underline underline-offset-2">Download PDF</a>
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
                  </span>
                  {/* MUST-13.3: original_filename and ocr_error are attacker-influenceable and
                      are rendered as TEXT NODES only, never as HTML. */}
                  <span className="truncate font-medium text-ink" title={receipt.originalFilename}>{receipt.originalFilename}</span>
                  <span className="text-subtle">{Math.round(receipt.sizeBytes / 1024)} KB · {OCR_CHIP[receipt.ocrStatus]}</span>
                  {receipt.ocrError ? <span className="money-neg">{receipt.ocrError}</span> : null}
                  <div className="flex gap-1">
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

          <form action={attachAction} className="flex flex-col gap-3 border-t border-line pt-4">
            <input type="hidden" name="itemId" value={item.id} />
            <input
              type="hidden"
              name="staged"
              value={JSON.stringify(staged.map((f) => ({ stagingId: f.stagingId, originalFilename: f.originalFilename })))}
            />
            <ReceiptUploader key={uploaderKey} onStagedChange={onStagedChange} label="Add another receipt" />
            <SubmitButton className="w-fit">Attach receipts</SubmitButton>
          </form>
        </CardBody>
      </Card>
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
  // v1.2.2 Task 2: the type <select> below used to be uncontrolled (defaultValue only), which
  // is fine for form submission but cannot drive live label wording. Tracked here purely so
  // the fieldset legend and the Purchase-date label can follow the SELECTED type's kind while
  // editing -- not just the item's already-saved kind -- without changing the field's `name`
  // or how the action reads it (still a plain <select name="typeId">).
  const [typeId, setTypeId] = useState(item.typeId === null ? '' : String(item.typeId));
  const selectedType = types.find((t) => String(t.id) === typeId);
  const selectedKind: ItemKind = selectedType?.kind ?? 'warranty';
  // v1.3.0: same live-follows-the-selected-kind treatment as the type/date fields above.
  const [billingCycle, setBillingCycle] = useState(item.billingCycle ?? '');
  const [billingAmount, setBillingAmount] = useState(
    item.billingAmountCents === null ? '' : (item.billingAmountCents / 100).toFixed(2),
  );
  const billingApplicable = billingAllowedForKind(selectedKind);
  useEffect(() => {
    if (!billingApplicable) {
      setBillingCycle('');
      setBillingAmount('');
    }
  }, [billingApplicable]);

  // v1.3.1: the loan money fields, seeded from the item -- this is what closes the review
  // finding where an unrelated edit used to null them out (the fields simply were not
  // rendered, and readItemInput() normalises an absent field to null). Same live-follows-the
  // -SELECTED-kind treatment as the billing pair above.
  const [principal, setPrincipal] = useState(item.principalCents === null ? '' : (item.principalCents / 100).toFixed(2));
  const [interestRate, setInterestRate] = useState(
    item.interestRateBps === null ? '' : (item.interestRateBps / 100).toFixed(2),
  );
  const [currentBalance, setCurrentBalance] = useState(
    item.currentBalanceCents === null ? '' : (item.currentBalanceCents / 100).toFixed(2),
  );
  // Fix wave item 4 (pre-tag follow-up): pinned via useState at mount, exactly like
  // `currentBalance` above -- NOT recomputed from the `item` prop on every render. A same-tab
  // revalidate (e.g. another action's revalidatePath) can update `item` while this form is
  // still open, and reading it live here would silently move the seed the action diffs
  // against out from under the open form.
  const [currentBalanceSeed] = useState(
    item.currentBalanceCents === null ? '' : (item.currentBalanceCents / 100).toFixed(2),
  );
  const loanApplicable = loanFieldsAllowedForKind(selectedKind);
  useEffect(() => {
    if (!loanApplicable) {
      setPrincipal('');
      setInterestRate('');
      setCurrentBalance('');
    }
  }, [loanApplicable]);

  return (
    <Card className="max-w-2xl">
      <CardHeader title="Edit this item" />
      <CardBody>
        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="transactionId" value={item.transactionId ?? ''} />
          <input type="hidden" name="staged" value="[]" />
          {/* Fix wave item 4: the balance this form was RENDERED with, pinned in the
              `currentBalanceSeed` state above at mount -- deliberately NOT the live
              `currentBalance` state, NOT re-read from the `item` prop on every render, and
              NOT gated on whether the loan fields are currently shown, so it still reflects
              the true render-time value even if the person switches the Type dropdown away
              from a loan kind mid-edit, or another action's revalidate updates `item` while
              this form stays open. The action compares the posted `currentBalance` against
              THIS to tell "untouched" from "edited", instead of against whatever is stored
              in the database at save time -- see actions.ts's readItemInput docblock. */}
          <input type="hidden" name="currentBalanceSeed" value={currentBalanceSeed} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2">
              <input name="name" required maxLength={200} defaultValue={item.name} className={inputClass} />
            </Field>
            <Field label="Type">
              <select
                name="typeId"
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                className={selectClass}
              >
                <option value="">— none —</option>
                {types.map((type) => (
                  <option key={type.id} value={type.id}>{type.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Vendor">
              <input name="vendor" maxLength={200} defaultValue={item.vendor ?? ''} className={inputClass} />
            </Field>
            <Field label="Model">
              <input name="model" maxLength={200} defaultValue={item.model ?? ''} className={inputClass} />
            </Field>
            <Field label="Serial number">
              <input name="serial" maxLength={200} defaultValue={item.serial ?? ''} className={inputClass} />
            </Field>
            <Field label={formStartLabel(selectedKind)}>
              <input type="date" name="purchaseDate" required max={today} defaultValue={item.purchaseDate} className={inputClass} />
            </Field>
            <Field label="Price">
              <input
                name="price"
                inputMode="decimal"
                defaultValue={item.priceCents === null ? '' : (item.priceCents / 100).toFixed(2)}
                className={inputClass}
              />
            </Field>

            {billingApplicable ? (
              <>
                <Field label={billingSectionLabelForKind(selectedKind)}>
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
                <Field label={billingAmountLabelForKind(selectedKind)}>
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

            {/* MUST-14.1: rendered exactly when the SELECTED type's kind is 'loan'. Hidden
                entirely otherwise, so an absent field posts as blank -> null, the same
                mechanism every other optional field on this form uses. */}
            {loanApplicable ? (
              <>
                <Field label="Original amount" hint="What you borrowed. Used for the payoff bar.">
                  <input
                    name="principal"
                    inputMode="decimal"
                    placeholder="e.g. 28000.00"
                    value={principal}
                    onChange={(e) => setPrincipal(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Interest rate" hint="Shown for reference only — this app does no interest math.">
                  <span className="flex items-center gap-2">
                    <input
                      name="interestRate"
                      inputMode="decimal"
                      placeholder="e.g. 5.49"
                      value={interestRate}
                      onChange={(e) => setInterestRate(e.target.value)}
                      className={`${inputClass} w-28`}
                    />
                    <span className="text-sm text-muted">%</span>
                  </span>
                </Field>
                <Field label="Balance still owed" hint="Today's balance. Payments you link will take it down from here.">
                  <input
                    name="currentBalance"
                    inputMode="decimal"
                    placeholder="e.g. 19550.00"
                    value={currentBalance}
                    onChange={(e) => setCurrentBalance(e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </>
            ) : null}
          </div>

          <fieldset className="flex flex-col gap-2">
            {/* v1.2.2 Task 2 (reviewer-flagged): this legend used to hard-code "Warranty
                length" regardless of the selected type's kind, breaking MUST-19.11's
                one-place rule -- the exact same bug as new-warranty-client.tsx. Routed
                through formTermLabel(), following the SELECTED type live, same as above. */}
            <legend className={labelClass}>{formTermLabel(selectedKind)}</legend>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="number"
                name="warrantyMonths"
                min={1}
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
                    if (e.target.checked) setMonths('');
                  }}
                  className="accent-accent"
                />
                {formOpenEndedLabel(selectedKind)}
              </label>
            </div>
          </fieldset>

          <Field label="Owner" className="max-w-xs">
            <select name="ownerUserId" defaultValue={String(item.ownerUserId)} className={selectClass}>
              {people.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Notes">
            <textarea name="notes" maxLength={2000} rows={3} defaultValue={item.notes ?? ''} className={textareaClass} />
          </Field>

          <SubmitButton className="w-fit">Save changes</SubmitButton>
        </form>
      </CardBody>
    </Card>
  );
}
