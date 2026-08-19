import { daysBetweenIso } from '@/lib/dates';
import {
  CREEP_LOOKBACK_DAYS,
  CREEP_MIN_ABS_CENTS,
  CREEP_MIN_CHARGES,
  CREEP_MIN_PCT,
  CREEP_MONTHLY_GAP_MAX_DAYS,
  CREEP_MONTHLY_GAP_MIN_DAYS,
  CREEP_YEARLY_GAP_MAX_DAYS,
  CREEP_YEARLY_GAP_MIN_DAYS,
  DUPLICATE_LOOKBACK_DAYS,
  DUPLICATE_MIN_ABS_CENTS,
  DUPLICATE_WINDOW_DAYS,
  UNUSUAL_MIN_ABS_CENTS,
  UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS,
  UNUSUAL_MIN_SAMPLES,
  UNUSUAL_MULTIPLE,
} from '@/lib/predict/constants';
import { medianCents } from '@/lib/predict/stats';

/**
 * The three anomaly detectors, PURE (MUST-2.1). They decide over rows a caller has already
 * read; the queries live in src/lib/notify/evaluate/anomalies.ts.
 */

/** One non-transfer spend row, as the evaluator reads it. amountCents is signed. */
export interface SpendRow {
  id: number;
  date: string;
  merchant: string;
  categoryId: number | null;
  amountCents: number;
}

/** MUST-9.10 condition 1: a first import has no baseline to be unusual against. */
export function hasEnoughHouseholdHistory(firstDateIso: string | null, today: string): boolean {
  if (firstDateIso === null) return false;
  return daysBetweenIso(firstDateIso, today) >= UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS;
}

export interface UnusualVerdict {
  baselineCents: number;
  baselineKind: 'merchant' | 'category';
}

/**
 * MUST-9.10 conditions 2 to 5. Both samples arrive with the tested row already excluded
 * (MUST-9.11): including it pulls the median toward the outlier and makes a large charge
 * partly responsible for deciding it is not large.
 *
 * A zero baseline is refused because every charge is three times zero.
 */
export function unusualVerdict(input: {
  amountCents: number;
  merchantSample: number[];
  categorySample: number[];
}): UnusualVerdict | null {
  if (input.amountCents >= 0) return null;
  const spend = Math.abs(input.amountCents);
  if (spend < UNUSUAL_MIN_ABS_CENTS) return null;

  const kind: 'merchant' | 'category' | null =
    input.merchantSample.length >= UNUSUAL_MIN_SAMPLES
      ? 'merchant'
      : input.categorySample.length >= UNUSUAL_MIN_SAMPLES
        ? 'category'
        : null;
  if (kind === null) return null;

  const baselineCents = medianCents(kind === 'merchant' ? input.merchantSample : input.categorySample);
  if (baselineCents === null || baselineCents <= 0) return null;
  if (spend < UNUSUAL_MULTIPLE * baselineCents) return null;
  return { baselineCents, baselineKind: kind };
}

export interface CreepVerdict {
  transactionId: number;
  dateIso: string;
  newAmountCents: number;
  baselineCents: number;
  priorCount: number;
}

/** MUST-9.15: monthly and yearly are the two bands. Weekly and quarterly are out of scope. */
function isRecurringGap(medianGapDays: number): boolean {
  const monthly = medianGapDays >= CREEP_MONTHLY_GAP_MIN_DAYS && medianGapDays <= CREEP_MONTHLY_GAP_MAX_DAYS;
  const yearly = medianGapDays >= CREEP_YEARLY_GAP_MIN_DAYS && medianGapDays <= CREEP_YEARLY_GAP_MAX_DAYS;
  return monthly || yearly;
}

/**
 * MUST-9.15 and MUST-9.16, over one merchant's non-transfer spend rows from the last
 * CREEP_BASELINE_DAYS, ascending by date. Returns the newest charge when its price went up.
 *
 * MUST-9.17: the next month's charge at the new price does not fire again, because by then
 * the median of the preceding charges has moved and the percentage condition fails.
 */
export function creepVerdict(input: { charges: SpendRow[]; today: string }): CreepVerdict | null {
  const charges = [...input.charges].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  if (charges.length < CREEP_MIN_CHARGES) return null;

  const gaps: number[] = [];
  for (let index = 1; index < charges.length; index += 1) {
    gaps.push(daysBetweenIso(charges[index - 1].date, charges[index].date));
  }
  const medianGap = medianCents(gaps);
  if (medianGap === null || !isRecurringGap(medianGap)) return null;

  const latest = charges[charges.length - 1];
  if (daysBetweenIso(latest.date, input.today) > CREEP_LOOKBACK_DAYS) return null;

  const preceding = charges.slice(0, -1).map((charge) => Math.abs(charge.amountCents));
  const baselineCents = medianCents(preceding);
  if (baselineCents === null || baselineCents <= 0) return null;

  const newAmountCents = Math.abs(latest.amountCents);
  if (newAmountCents <= baselineCents) return null;

  const rise = newAmountCents - baselineCents;
  // Both thresholds, so neither a large cheap subscription nor a tiny expensive one slips
  // through on a technicality.
  if (rise * 100 < baselineCents * CREEP_MIN_PCT) return null;
  if (rise < CREEP_MIN_ABS_CENTS) return null;

  return { transactionId: latest.id, dateIso: latest.date, newAmountCents, baselineCents, priorCount: preceding.length };
}

export interface DuplicatePair {
  lowerId: number;
  higherId: number;
  merchant: string;
  amountCents: number;
  earlierDateIso: string;
  laterDateIso: string;
}

/**
 * MUST-9.20 to MUST-9.23. `rows` covers the last DUPLICATE_LOOKBACK_DAYS + DUPLICATE_WINDOW_DAYS
 * days, so a pair whose later half sits on the lookback boundary still has its earlier half.
 *
 * MUST-9.21: everything reaching here already survived transactions_dedup_uq and the
 * SimpleFIN external_id index, so it is either a genuine second charge or a bank reporting
 * one charge twice. The message says exactly that.
 */
export function findDuplicates(input: { rows: SpendRow[]; today: string }): DuplicatePair[] {
  const groups = new Map<string, SpendRow[]>();
  for (const row of input.rows) {
    if (row.amountCents >= 0) continue;
    if (Math.abs(row.amountCents) < DUPLICATE_MIN_ABS_CENTS) continue;
    const key = `${row.merchant}\u0000${row.amountCents}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const pairs: DuplicatePair[] = [];
  for (const group of groups.values()) {
    const ordered = group.slice().sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
    for (let index = 1; index < ordered.length; index += 1) {
      const later = ordered[index];
      // L-8: aligned with the unusual detector (src/lib/notify/evaluate/anomalies.ts), which
      // also rejects a future-dated row (a post-dated entry or a bad import) rather than
      // treating it as "within the last N days". Sorted ascending, so once `later` clears this
      // check every earlier row in the same group does too.
      if (later.date > input.today) continue;
      if (daysBetweenIso(later.date, input.today) > DUPLICATE_LOOKBACK_DAYS) continue;
      // MUST-9.23: the single NEAREST earlier match, never all of them. Three identical
      // charges on three consecutive days produce two events, not three.
      const earlier = ordered[index - 1];
      if (daysBetweenIso(earlier.date, later.date) > DUPLICATE_WINDOW_DAYS) continue;
      pairs.push({
        lowerId: Math.min(earlier.id, later.id),
        higherId: Math.max(earlier.id, later.id),
        merchant: later.merchant,
        amountCents: later.amountCents,
        earlierDateIso: earlier.date,
        laterDateIso: later.date,
      });
    }
  }
  return pairs.sort((a, b) => (a.laterDateIso === b.laterDateIso ? a.higherId - b.higherId : a.laterDateIso < b.laterDateIso ? -1 : 1));
}
