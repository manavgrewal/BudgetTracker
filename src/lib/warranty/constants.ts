/**
 * Client-safe warranty constants and wording helpers (Ruling P4): this module is imported
 * by client components, so it must stay PURE -- no @/db import, no native db driver, no I/O.
 *
 * Subscription wording (spec section 19.6). An item is a subscription when its TYPE has
 * is_subscription = 1. That flag changes only the words on screen; status derivation stays
 * in src/lib/warranty/expiry.ts and knows nothing about subscriptions (MUST-19.12).
 */

/** MUST-19.11: the one place either verb is written. No component hard-codes them. */
export function expiryNoun(isSubscription: boolean): 'expires' | 'cancel by' {
  return isSubscription ? 'cancel by' : 'expires';
}

/** List rows and the dashboard widget: "expires 2027-03-01" / "cancel by 2027-03-01". */
export function expiryPhrase(isSubscription: boolean, expiryDate: string): string {
  return `${expiryNoun(isSubscription)} ${expiryDate}`;
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
 * T9 delta: the day-count form of the 'expiring' badge -- "Expires in 12 days" /
 * "Cancel in 12 days" -- shown by StatusBadge on both the list and the detail page.
 * `days` is expected to already be computed by the caller (daysBetweenIso(today, expiryDate)),
 * matching src/lib/warranty/expiry.ts's statusLabel() exactly except for the swapped verb
 * (MUST-19.11: this is the one other place either verb is written, and it is still here in
 * constants.ts, not hard-coded into a component).
 */
export function expiringSoonLabel(isSubscription: boolean, days: number): string {
  const verb = isSubscription ? 'Cancel' : 'Expires';
  if (days <= 0) return `${verb} today`;
  return `${verb} in ${days} ${days === 1 ? 'day' : 'days'}`;
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
