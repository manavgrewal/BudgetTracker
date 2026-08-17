import { addDaysIso, addMonthsClamped, daysBetweenIso } from '@/lib/dates';
import { openEndedDisplayLabel, type ItemKind } from '@/lib/warranty/constants';

/**
 * One constant driving the list badge, the status filter and the dashboard widget alike
 * (spec §3.7 / §17.1). Change it here and all three move together.
 */
export const EXPIRING_SOON_DAYS = 60;

export type WarrantyStatus = 'lifetime' | 'unknown' | 'expired' | 'expiring' | 'active';

export const WARRANTY_STATUSES: readonly WarrantyStatus[] = [
  'active',
  'expiring',
  'expired',
  'lifetime',
  'unknown',
];

export function isWarrantyStatus(value: string): value is WarrantyStatus {
  return (WARRANTY_STATUSES as readonly string[]).includes(value);
}

/**
 * MUST-3.6: expiry_date is computed at WRITE time and stored, never derived on read.
 * MUST-3.5: a lifetime warranty has no term and no expiry.
 */
export function computeExpiryDate(input: {
  purchaseDate: string;
  warrantyMonths: number | null;
  isLifetime: boolean;
}): string | null {
  if (input.isLifetime) return null;
  if (input.warrantyMonths === null) return null;
  return addMonthsClamped(input.purchaseDate, input.warrantyMonths);
}

/** MUST-3.14: coverage is inclusive — expired means strictly after expiry_date. */
export function warrantyStatus(
  input: { expiryDate: string | null; isLifetime: boolean },
  today: string,
): WarrantyStatus {
  if (input.isLifetime) return 'lifetime';
  if (input.expiryDate === null) return 'unknown';
  if (input.expiryDate < today) return 'expired';
  if (input.expiryDate <= addDaysIso(today, EXPIRING_SOON_DAYS)) return 'expiring';
  return 'active';
}

/**
 * review fix (v1.3.0): `kind` defaults to 'warranty' -- the same default StatusBadge itself
 * already carries, and the same value the generic (kind-less) status FILTER <select> in
 * warranties-client.tsx relies on to keep saying plain "Lifetime" for its neutral,
 * cross-kind option list. A caller that DOES know the item's kind (StatusBadge, given a real
 * row) now passes it through, so the 'lifetime' word matches openEndedDisplayLabel() -- the
 * one place this wording lives (MUST-19.11) -- instead of hardcoding 'Lifetime' regardless of
 * kind, which used to contradict the Expiry column's own per-kind open-ended label.
 */
export function statusLabel(
  status: WarrantyStatus,
  expiryDate: string | null,
  today: string,
  kind: ItemKind = 'warranty',
): string {
  switch (status) {
    case 'lifetime':
      return openEndedDisplayLabel(kind);
    case 'unknown':
      return 'Term unknown';
    case 'expired':
      return 'Expired';
    case 'active':
      return 'Active';
    case 'expiring': {
      if (expiryDate === null) return 'Expiring soon';
      const days = daysBetweenIso(today, expiryDate);
      if (days <= 0) return 'Expires today';
      return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
    }
  }
}

/**
 * The SAME rule as warrantyStatus(), expressed in SQL so the list, the filter counts and
 * the badge can never disagree (§3.7). Binds exactly two parameters, in this order:
 *   1. today  (ISO YYYY-MM-DD)
 *   2. soon   (= addDaysIso(today, EXPIRING_SOON_DAYS))
 * Assumes warranty_items is aliased `i`.
 */
export const STATUS_CASE_SQL = `case
  when i.is_lifetime = 1 then 'lifetime'
  when i.expiry_date is null then 'unknown'
  when i.expiry_date < ? then 'expired'
  when i.expiry_date <= ? then 'expiring'
  else 'active'
end`;
