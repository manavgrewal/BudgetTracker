import { daysBetweenIso } from '@/lib/dates';
import { expiringSoonLabelForKind, type ItemKind } from '@/lib/warranty/constants';
import { statusLabel, type WarrantyStatus } from '@/lib/warranty/expiry';

/**
 * §10.2: active neutral · expiring amber · expired red · lifetime blue · unknown grey.
 *
 * The modifiers are named after the hue rather than after a semantic token
 * because the hue IS the spec here — the five statuses are defined by colour,
 * and "expiring" is not the same idea as the app's generic warning state.
 * Each one resolves to theme tokens in globals.css.
 */
const CLASSES: Record<WarrantyStatus, string> = {
  active: 'badge--slate',
  expiring: 'badge--amber',
  expired: 'badge--red',
  lifetime: 'badge--blue',
  unknown: 'badge--muted',
};

/**
 * Type-deltas T9, generalized to `kind` in v1.2.2 Task 2: the day-count wording for
 * 'expiring' swaps "Expires" for "Cancel"/"Ends"/"Paid off" per kind (expiringSoonLabelForKind,
 * constants.ts). Every other status keeps statusLabel()'s wording unchanged -- status
 * derivation itself knows nothing about kinds (MUST-19.12); only this label swap does.
 */
function labelFor(status: WarrantyStatus, expiryDate: string | null, today: string, kind: ItemKind): string {
  if (status === 'expiring' && expiryDate !== null) {
    return expiringSoonLabelForKind(kind, daysBetweenIso(today, expiryDate));
  }
  return statusLabel(status, expiryDate, today);
}

export function StatusBadge({
  status,
  expiryDate,
  today,
  kind = 'warranty',
}: {
  status: WarrantyStatus;
  expiryDate: string | null;
  today: string;
  kind?: ItemKind;
}) {
  return (
    <span className={`badge ${CLASSES[status]}`}>{labelFor(status, expiryDate, today, kind)}</span>
  );
}
