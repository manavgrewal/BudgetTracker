import { daysBetweenIso } from '@/lib/dates';
import { expiringSoonLabel } from '@/lib/warranty/constants';
import { statusLabel, type WarrantyStatus } from '@/lib/warranty/expiry';

/** §10.2: active neutral · expiring amber · expired red · lifetime blue · unknown grey. */
const CLASSES: Record<WarrantyStatus, string> = {
  active: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100',
  expiring: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  expired: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  lifetime: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  unknown: 'bg-slate-200 text-slate-600 dark:bg-slate-900 dark:text-slate-400',
};

/**
 * Type-deltas T9: the day-count wording for 'expiring' swaps "Expires" for "Cancel" when the
 * item's type is a subscription (expiringSoonLabel, constants.ts). Every other status keeps
 * statusLabel()'s wording unchanged -- status derivation itself knows nothing about
 * subscriptions (MUST-19.12); only this label swap does.
 */
function labelFor(status: WarrantyStatus, expiryDate: string | null, today: string, isSubscription: boolean): string {
  if (status === 'expiring' && expiryDate !== null) {
    return expiringSoonLabel(isSubscription, daysBetweenIso(today, expiryDate));
  }
  return statusLabel(status, expiryDate, today);
}

export function StatusBadge({
  status,
  expiryDate,
  today,
  isSubscription = false,
}: {
  status: WarrantyStatus;
  expiryDate: string | null;
  today: string;
  isSubscription?: boolean;
}) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CLASSES[status]}`}>
      {labelFor(status, expiryDate, today, isSubscription)}
    </span>
  );
}
