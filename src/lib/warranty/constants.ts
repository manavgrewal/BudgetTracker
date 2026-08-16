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
