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
 *   warranty:     Purchase date / Warranty (months) / expires    / Lifetime warranty
 *   subscription: Start date    / Duration (months)  / cancel by / Ongoing (no end date)
 *   contract:     Start date    / Term (months)       / ends on   / Open-ended
 *   loan:         Start date    / Term (months)       / paid off by / Ongoing (no end date)
 */
const KIND_WORDING: Record<
  ItemKind,
  { start: string; term: string; expiryVerb: string; expiringVerb: string; openEnded: string }
> = {
  warranty: {
    start: 'Purchase date',
    term: 'Warranty (months)',
    expiryVerb: 'expires',
    expiringVerb: 'Expires',
    openEnded: 'Lifetime warranty',
  },
  subscription: {
    start: 'Start date',
    term: 'Duration (months)',
    expiryVerb: 'cancel by',
    expiringVerb: 'Cancel',
    openEnded: 'Ongoing (no end date)',
  },
  contract: {
    start: 'Start date',
    term: 'Term (months)',
    expiryVerb: 'ends on',
    expiringVerb: 'Ends',
    openEnded: 'Open-ended',
  },
  loan: {
    start: 'Start date',
    term: 'Term (months)',
    expiryVerb: 'paid off by',
    expiringVerb: 'Paid off',
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

/** "No end date" wording -- the lifetime checkbox's label / the open-ended state, keyed by kind. */
export function formOpenEndedLabel(kind: ItemKind): string {
  return KIND_WORDING[kind].openEnded;
}

/** MUST-19.11, generalized: the one place any of the four verbs is written. */
export function expiryNounForKind(kind: ItemKind): string {
  return KIND_WORDING[kind].expiryVerb;
}

/** List rows and the dashboard widget: "expires 2027-03-01" / "cancel by 2027-03-01" / etc. */
export function expiryPhraseForKind(kind: ItemKind, expiryDate: string): string {
  return `${expiryNounForKind(kind)} ${expiryDate}`;
}

/** MUST-19.11: the one place either verb is written. No component hard-codes them. */
export function expiryNoun(isSubscription: boolean): 'expires' | 'cancel by' {
  return expiryNounForKind(isSubscription ? 'subscription' : 'warranty') as 'expires' | 'cancel by';
}

/** List rows and the dashboard widget: "expires 2027-03-01" / "cancel by 2027-03-01". */
export function expiryPhrase(isSubscription: boolean, expiryDate: string): string {
  return expiryPhraseForKind(isSubscription ? 'subscription' : 'warranty', expiryDate);
}

export function purchaseDateLabel(isSubscription: boolean): string {
  return isSubscription ? 'Period start' : 'Purchase date';
}

export function termLabel(isSubscription: boolean): string {
  return isSubscription ? 'Period length' : 'Warranty length';
}

export function expiryDateLabel(isSubscription: boolean): string {
  return isSubscription ? 'Cancel by' : 'Expiry date';
}

/** MUST-10.4's live computed date beside the months input. */
export function coveredThroughLabel(isSubscription: boolean): string {
  return isSubscription ? 'Cancel by' : 'Covered through';
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
