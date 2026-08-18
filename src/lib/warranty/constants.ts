/**
 * Client-safe warranty constants and wording helpers (Ruling P4): this module is imported
 * by client components, so it must stay PURE -- no @/db import, no native db driver, no I/O.
 *
 * Subscription wording (spec section 19.6). An item is a subscription when its TYPE has
 * is_subscription = 1. That flag changes only the words on screen; status derivation stays
 * in src/lib/warranty/expiry.ts and knows nothing about subscriptions (MUST-19.12).
 *
 * v1.2.2 amendment: the tracker generalizes to "Contracts & Coverage" -- warranty,
 * subscription, contract and loan `kind`s (spec section 19, amended). The boolean
 * `isSubscription` helpers below are KEPT as thin wrappers over the `kind`-keyed ones
 * (isSub ? 'subscription' : 'warranty') so every existing call site keeps compiling AND
 * keeps showing the exact same words -- warranty/subscription wording is identical between
 * the old boolean matrix and the new kind matrix. Wiring contract/loan wording into pages
 * is Task 2; this module only builds the foundation.
 */

/** v1.2.2: the four kinds an item type can be. Loans are dates + documents only -- no
 * balance math (spec section 17, decision recorded there). */
export const ITEM_KINDS = ['warranty', 'subscription', 'contract', 'loan'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export function isItemKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

/** Human labels for the admin page's kind <select> (four options, one per kind). */
export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  warranty: 'Warranty',
  subscription: 'Subscription',
  contract: 'Contract',
  loan: 'Loan',
};

/**
 * The user-approved wording matrix (v1.2.2): what the add/edit form's date labels say, what
 * verb the expiry phrase uses, and what the "no end date" state is called, per kind.
 *
 *   warranty:     Purchase date / Warranty (months) / expires    / Expiry date  / Covered through    / Lifetime warranty
 *   subscription: Start date    / Duration (months)  / cancel by / Cancel-by date / Active through    / Ongoing (no end date)
 *   contract:     Start date    / Term (months)      / ends on   / End date     / In effect through  / Open-ended
 *   loan:         Start date    / Term (months)      / paid off by / Payoff date / Term runs through / Ongoing (no end date)
 *
 * v1.2.2 Task 2 (controller ruling): this matrix SUPERSEDES the four old boolean label
 * helpers (`purchaseDateLabel`, `termLabel`, `expiryDateLabel`, `coveredThroughLabel`), which
 * are DELETED, not kept as wrappers -- keeping them alongside this matrix would leave
 * MUST-19.11's "one place" rule broken twice over. The wording changes below are deliberate
 * and owner-approved (spec §19.12): 'Warranty length' -> 'Warranty (months)', 'Period start'
 * -> 'Start date', 'Period length' -> 'Duration (months)', 'Cancel by' (label) -> 'Cancel-by
 * date' / 'Active through' depending on which of the two old helpers it replaces.
 */
const KIND_WORDING: Record<
  ItemKind,
  {
    start: string;
    term: string;
    expiryVerb: string;
    expiringVerb: string;
    end: string;
    coveredThrough: string;
    openEnded: string;
  }
> = {
  warranty: {
    start: 'Purchase date',
    term: 'Warranty (months)',
    expiryVerb: 'expires',
    expiringVerb: 'Expires',
    end: 'Expiry date',
    coveredThrough: 'Covered through',
    openEnded: 'Lifetime warranty',
  },
  subscription: {
    start: 'Start date',
    term: 'Duration (months)',
    expiryVerb: 'cancel by',
    expiringVerb: 'Cancel',
    end: 'Cancel-by date',
    coveredThrough: 'Active through',
    openEnded: 'Ongoing (no end date)',
  },
  contract: {
    start: 'Start date',
    term: 'Term (months)',
    expiryVerb: 'ends on',
    expiringVerb: 'Ends',
    end: 'End date',
    coveredThrough: 'In effect through',
    openEnded: 'Open-ended',
  },
  loan: {
    start: 'Start date',
    term: 'Term (months)',
    expiryVerb: 'paid off by',
    expiringVerb: 'Paid off',
    end: 'Payoff date',
    coveredThrough: 'Term runs through',
    openEnded: 'Ongoing (no end date)',
  },
};

/** Add/edit form date-field label, keyed by kind. */
export function formStartLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].start;
}

/** Add/edit form term-length label, keyed by kind. */
export function formTermLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].term;
}

/**
 * Detail-page end-date field label, keyed by kind. Supersedes `expiryDateLabel`
 * (v1.2.2 Task 2 controller ruling -- see the KIND_WORDING docblock above).
 */
export function formEndLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].end;
}

/** "No end date" wording -- the lifetime checkbox's label / the open-ended state, keyed by kind. */
export function formOpenEndedLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].openEnded;
}

/**
 * MUST-10.4's live computed date beside the term input, keyed by kind. Supersedes
 * `coveredThroughLabel` (v1.2.2 Task 2 controller ruling -- see the KIND_WORDING docblock
 * above).
 */
export function coveredThroughLabelForKind(kind: ItemKind): string {
  return KIND_WORDING[kind].coveredThrough;
}

/** MUST-19.11, generalized: the one place any of the four verbs is written. */
export function expiryNounForKind(kind: ItemKind): string {
  return KIND_WORDING[kind].expiryVerb;
}

/** List rows and the dashboard widget: "expires 2027-03-01" / "cancel by 2027-03-01" / etc. */
export function expiryPhraseForKind(kind: ItemKind, expiryDate: string): string {
  return `${expiryNounForKind(kind)} ${expiryDate}`;
}

/**
 * MUST-19.11: the one place either verb is written. No component hard-codes them.
 * Return type widened to `string` (not a two-value literal union) -- now that
 * `expiryNounForKind` has four possible outputs, a literal-union return type here would
 * require an unchecked cast to compile, which is exactly the kind of silent-mismatch risk
 * the type system should catch, not paper over (v1.2.2 Task 2 review fix).
 */
export function expiryNoun(isSubscription: boolean): string {
  return expiryNounForKind(isSubscription ? 'subscription' : 'warranty');
}

/** List rows and the dashboard widget: "expires 2027-03-01" / "cancel by 2027-03-01". */
export function expiryPhrase(isSubscription: boolean, expiryDate: string): string {
  return expiryPhraseForKind(isSubscription ? 'subscription' : 'warranty', expiryDate);
}

/**
 * T9 delta, generalized in v1.2.2: the day-count form of the 'expiring' badge -- "Expires in
 * 12 days" / "Cancel in 12 days" / "Ends in 12 days" / "Paid off in 12 days" -- shown by
 * StatusBadge across every kind. `days` is expected to already be computed by the caller
 * (daysBetweenIso(today, expiryDate)), matching src/lib/warranty/expiry.ts's statusLabel()
 * exactly except for the swapped verb (MUST-19.11: this is the one other place any of the
 * four verbs is written, and it is still here in constants.ts, not hard-coded into a
 * component). Wiring contract/loan into the badge itself is Task 2's job; this helper is
 * ready for it now.
 */
export function expiringSoonLabelForKind(kind: ItemKind, days: number): string {
  const verb = KIND_WORDING[kind].expiringVerb;
  if (days <= 0) return `${verb} today`;
  return `${verb} in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * T9 delta: the day-count form of the 'expiring' badge -- "Expires in 12 days" /
 * "Cancel in 12 days" -- shown by StatusBadge on both the list and the detail page.
 */
export function expiringSoonLabel(isSubscription: boolean, days: number): string {
  return expiringSoonLabelForKind(isSubscription ? 'subscription' : 'warranty', days);
}

/**
 * Ruling P4: the list page's sort control is rendered by a client component, so the sort
 * names themselves must not transitively import @/db or the native db driver -- src/lib/
 * warranty/search.ts (which does) re-exports these for server-side use instead of
 * redeclaring them.
 */
export type WarrantySort = 'expiry' | 'name' | 'purchase';
export const WARRANTY_SORTS: readonly WarrantySort[] = ['expiry', 'name', 'purchase'];

export function isWarrantySort(value: string): value is WarrantySort {
  return (WARRANTY_SORTS as readonly string[]).includes(value);
}

/**
 * v1.3.0 user request: billing cycle + amount for subscriptions and contracts only. Kept
 * here (not items.ts) for the same client-safety reason as everything else in this file --
 * the add/edit forms are client components and need the enum, the labels and the display
 * suffix without dragging in @/db.
 */
export const BILLING_CYCLES = ['monthly', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export function isBillingCycle(value: string): value is BillingCycle {
  return (BILLING_CYCLES as readonly string[]).includes(value);
}

/** The add/edit form's Billing <select> options. */
export const BILLING_CYCLE_LABELS: Record<BillingCycle, string> = {
  monthly: 'Monthly',
  annual: 'Annual',
};

/**
 * v1.3.1: widened to include 'loan'. A loan's billing pair is its regular PAYMENT
 * (see BILLING_WORDING) -- the amount and the cadence, not an interest calculation.
 *
 * This is the ENTIRE server-side rule change. assertBillingMatchesKind() in items.ts calls
 * this predicate, setItemTypeKind()'s clearing pass calls it, and both forms gate their
 * fieldset on it -- so one edit moves every one of them together. The rule lives here, in
 * the app layer, rather than in SQL, because a CHECK on warranty_items cannot see across to
 * warranty_item_types.kind; drizzle/0005_billing_cycle.sql's own header says so, which is
 * why widening it needs no DDL and no table rebuild (MUST-11.6).
 */
export function billingAllowedForKind(kind: ItemKind): boolean {
  return kind !== 'warranty';
}

/** v1.3.1: the four money columns are loan-only, by the same app-layer argument. */
export function loanFieldsAllowedForKind(kind: ItemKind): boolean {
  return kind === 'loan';
}

/**
 * MUST-12.3: the second wording matrix, beside KIND_WORDING. The `warranty` row exists only
 * so the record is total; it is unreachable through the UI, because
 * billingAllowedForKind('warranty') is false.
 *
 * MUST-12.4: BILLING_CYCLE_LABELS (Monthly / Annual) is unchanged and shared -- the cadence
 * has the same name for a subscription and for a loan; only the noun around it differs.
 */
const BILLING_WORDING: Record<ItemKind, { section: string; amount: string; monthly: string; annual: string }> = {
  warranty: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
  subscription: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
  contract: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
  loan: { section: 'Payment', amount: 'Payment amount', monthly: 'per month', annual: 'per year' },
};

export function billingSectionLabelForKind(kind: ItemKind): string {
  return BILLING_WORDING[kind].section;
}

export function billingAmountLabelForKind(kind: ItemKind): string {
  return BILLING_WORDING[kind].amount;
}

/** Appended after the formatted amount: `${formatCents(cents)} ${billingCycleSuffixForKind(kind, cycle)}` -> "$15.99 / month". */
export function billingCycleSuffixForKind(kind: ItemKind, cycle: BillingCycle): string {
  return cycle === 'monthly' ? BILLING_WORDING[kind].monthly : BILLING_WORDING[kind].annual;
}

/**
 * The user-approved per-kind label shown in place of a blank end date when an item is
 * open-ended (the "no end date" / Lifetime checkbox, i.e. isLifetime = true). Deliberately a
 * SEPARATE matrix from KIND_WORDING's `openEnded` above: that one is the checkbox's own
 * label text ("Lifetime warranty", "Ongoing (no end date)", ...); this one is the short
 * word shown wherever the end date itself would otherwise render blank (list rows, the
 * detail page's end-date field) -- the two read very differently on purpose.
 */
const OPEN_ENDED_DISPLAY_LABEL: Record<ItemKind, string> = {
  warranty: 'Lifetime',
  subscription: 'Lifetime',
  contract: 'Ongoing',
  loan: 'Open-ended',
};

export function openEndedDisplayLabel(kind: ItemKind): string {
  return OPEN_ENDED_DISPLAY_LABEL[kind];
}
