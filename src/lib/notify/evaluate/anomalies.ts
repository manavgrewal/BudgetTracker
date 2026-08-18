import { and, asc, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, transactions } from '@/db/schema';
import { listCategories } from '@/lib/categories';
import { addDaysIso, todayIso } from '@/lib/dates';
import { isEventEnabled, notifiableUsers } from '@/lib/notify/config';
import { CHANNELS, duplicateChargeKey, subscriptionCreepKey, unusualTransactionKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { creepVerdict, findDuplicates, hasEnoughHouseholdHistory, unusualVerdict, type SpendRow } from '@/lib/predict/anomalies';
import {
  CREEP_BASELINE_DAYS,
  CREEP_LOOKBACK_DAYS,
  CREEP_MAX_PER_EVALUATION,
  DUPLICATE_LOOKBACK_DAYS,
  DUPLICATE_MAX_PER_EVALUATION,
  DUPLICATE_WINDOW_DAYS,
  UNUSUAL_BASELINE_DAYS,
  UNUSUAL_LOOKBACK_DAYS,
  UNUSUAL_MAX_PER_EVALUATION,
} from '@/lib/predict/constants';

/**
 * MUST-10.4: evaluateAnomalies runs on EVERY tick, so it needs the same guard evaluateBudgets
 * uses. A restart clears this cache and costs exactly one extra evaluation, which is dedup
 * safe because enqueue() is itself idempotent.
 */
let lastAnomalyKey: string | null = null;

/** MUST-10.7: called from the shared test reset helper, beside resetBudgetFingerprintForTests. */
export function resetAnomalyFingerprintForTests(): void {
  lastAnomalyKey = null;
}

interface AnomalyParticipant {
  userId: number;
  unusual: boolean;
  duplicate: boolean;
}

interface SliceRow extends SpendRow {
  accountName: string;
}

/**
 * MUST-10.10: a household with no user having either tick event enabled skips the fingerprint
 * query entirely. Zero enabled participants means zero queries.
 */
function participants(): AnomalyParticipant[] {
  const out: AnomalyParticipant[] = [];
  for (const user of notifiableUsers()) {
    const unusual = CHANNELS.some((channel) => isEventEnabled(user.id, 'unusual_transaction', channel));
    const duplicate = CHANNELS.some((channel) => isEventEnabled(user.id, 'duplicate_charge', channel));
    if (!unusual && !duplicate) continue;
    out.push({ userId: user.id, unusual, duplicate });
  }
  return out;
}

/**
 * MUST-10.4: one indexed count over the slice both tick detectors read, concatenated with the
 * participant list. MUST-10.5: max(updated_at) is in it so that re-categorising an existing
 * transaction, which changes neither the count nor the max id, still triggers a re-evaluation.
 * That matters because the unusual category baseline depends on category_id.
 */
function fingerprint(sliceStart: string, people: AnomalyParticipant[]): string {
  const row = getDb()
    .select({
      n: sql<number>`count(*)`,
      maxId: sql<number>`coalesce(max(${transactions.id}), 0)`,
      maxUpdated: sql<string>`coalesce(max(${transactions.updatedAt}), '')`,
    })
    .from(transactions)
    .where(gte(transactions.date, sliceStart))
    .get();

  const roster = people
    .slice()
    .sort((a, b) => a.userId - b.userId)
    .map((person) => `${person.userId}:${person.unusual ? 1 : 0}${person.duplicate ? 1 : 0}`)
    .join(',');
  return `${sliceStart}|${row?.n ?? 0}|${row?.maxId ?? 0}|${row?.maxUpdated ?? ''}|${roster}`;
}

/** MUST-9.10 condition 1's input: the oldest non-transfer row in the household. */
function earliestTransactionDate(): string | null {
  const row = getDb()
    .select({ first: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .where(eq(transactions.isTransfer, false))
    .get();
  return row?.first ?? null;
}

/** The one slice read (MUST-10.9), oldest first so MUST-9.13's cap takes the oldest five. */
function readSlice(sliceStart: string): SliceRow[] {
  return getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(gte(transactions.date, sliceStart), eq(transactions.isTransfer, false), lt(transactions.amountCents, 0)))
    .orderBy(asc(transactions.date), asc(transactions.id))
    .all();
}

/**
 * One baseline aggregate per candidate (MUST-10.9). MUST-9.11: the tested row is excluded in
 * the WHERE, because including it pulls the median toward the outlier.
 */
function baselineSamples(candidate: SliceRow, yearStart: string): { merchantSample: number[]; categorySample: number[] } {
  const match =
    candidate.categoryId === null
      ? eq(transactions.normalizedMerchant, candidate.merchant)
      : or(eq(transactions.normalizedMerchant, candidate.merchant), eq(transactions.categoryId, candidate.categoryId));

  const rows = getDb()
    .select({
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      magnitude: sql<number>`abs(${transactions.amountCents})`,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.date, yearStart),
        eq(transactions.isTransfer, false),
        lt(transactions.amountCents, 0),
        ne(transactions.id, candidate.id),
        match,
      ),
    )
    .all();

  const merchantSample: number[] = [];
  const categorySample: number[] = [];
  for (const row of rows) {
    if (row.merchant === candidate.merchant) merchantSample.push(row.magnitude);
    if (candidate.categoryId !== null && row.categoryId === candidate.categoryId) categorySample.push(row.magnitude);
  }
  return { merchantSample, categorySample };
}

interface UnusualFinding {
  row: SliceRow;
  baselineCents: number;
  baselineKind: 'merchant' | 'category';
}

function findUnusual(slice: SliceRow[], today: string): UnusualFinding[] {
  const lookbackStart = addDaysIso(today, -UNUSUAL_LOOKBACK_DAYS);
  const yearStart = addDaysIso(today, -UNUSUAL_BASELINE_DAYS);
  const findings: UnusualFinding[] = [];
  for (const row of slice) {
    // MUST-9.13: oldest first, and stop querying once the cap is met. The remainder are simply
    // not enqueued; this is a deliberate cap on noise, not a queue.
    if (findings.length >= UNUSUAL_MAX_PER_EVALUATION) break;
    if (row.date < lookbackStart) continue;
    const { merchantSample, categorySample } = baselineSamples(row, yearStart);
    const verdict = unusualVerdict({ amountCents: row.amountCents, merchantSample, categorySample });
    if (verdict === null) continue;
    findings.push({ row, baselineCents: verdict.baselineCents, baselineKind: verdict.baselineKind });
  }
  return findings;
}

/**
 * MUST-9.36: unusual_transaction and duplicate_charge are household-wide. The same transaction
 * is reported to every user with the event enabled, with no attribution filter, because a
 * large charge is a household fact and filtering it by attributed_user_id would hide exactly
 * the charges nobody has claimed yet.
 */
export function evaluateAnomalies(input: { now: Date; tz: string }): number {
  const people = participants();
  if (people.length === 0) {
    lastAnomalyKey = null;
    return 0;
  }

  const today = todayIso(input.now, input.tz);
  // Wider than the 14-day unusual window so a duplicate pair straddling the boundary keeps its
  // earlier half. A superset is strictly safer for the fingerprint.
  const sliceStart = addDaysIso(today, -(DUPLICATE_LOOKBACK_DAYS + DUPLICATE_WINDOW_DAYS));

  const key = fingerprint(sliceStart, people);
  if (key === lastAnomalyKey) return 0;

  if (!hasEnoughHouseholdHistory(earliestTransactionDate(), today)) {
    lastAnomalyKey = key;
    return 0;
  }

  const slice = readSlice(sliceStart);
  const categoryNames = new Map(listCategories({ includeArchived: true }).map((category) => [category.id, category.name]));
  const unusual = findUnusual(slice, today);
  const duplicates = findDuplicates({ rows: slice, today }).slice(0, DUPLICATE_MAX_PER_EVALUATION);

  let fired = 0;
  for (const person of people) {
    if (person.unusual) {
      for (const finding of unusual) {
        const { subject, body } = renderEvent({
          event: 'unusual_transaction',
          merchant: finding.row.merchant,
          accountName: finding.row.accountName,
          dateIso: finding.row.date,
          amountCents: finding.row.amountCents,
          baselineCents: finding.baselineCents,
          baselineKind: finding.baselineKind,
          categoryName: finding.row.categoryId === null ? null : (categoryNames.get(finding.row.categoryId) ?? null),
        });
        const result = enqueue({
          userId: person.userId,
          eventId: 'unusual_transaction',
          dedupKey: unusualTransactionKey(finding.row.id),
          subject,
          body,
          at: input.now,
        });
        if (result.inserted.length > 0) fired += 1;
      }
    }
    if (person.duplicate) {
      for (const pair of duplicates) {
        const { subject, body } = renderEvent({
          event: 'duplicate_charge',
          merchant: pair.merchant,
          amountCents: pair.amountCents,
          earlierDateIso: pair.earlierDateIso,
          laterDateIso: pair.laterDateIso,
        });
        const result = enqueue({
          userId: person.userId,
          eventId: 'duplicate_charge',
          dedupKey: duplicateChargeKey(pair.lowerId, pair.higherId),
          subject,
          body,
          at: input.now,
        });
        if (result.inserted.length > 0) fired += 1;
      }
    }
  }

  // MUST-10.6: recorded only after every participant has been processed without throwing.
  // Recording it first would let one participant's transient error burn the fingerprint for
  // the whole household.
  lastAnomalyKey = key;
  return fired;
}

/**
 * MUST-9.18: the user's daily slot. A price increase is not urgent enough to warrant a
 * per-tick scan, and 35 days of lookback means a container that was off for a week loses
 * nothing, so this needs no fingerprint (MUST-10.8).
 */
export function evaluateSubscriptionCreep(input: { userId: number; now: Date; tz: string }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'subscription_creep', channel))) return 0;

  const today = todayIso(input.now, input.tz);
  const recentStart = addDaysIso(today, -CREEP_LOOKBACK_DAYS);
  const yearStart = addDaysIso(today, -CREEP_BASELINE_DAYS);

  // Only merchants with a charge inside the lookback can possibly fire, so the year-long read
  // below is bounded by that list rather than by the whole table.
  const recentMerchants = getDb()
    .selectDistinct({ merchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(and(gte(transactions.date, recentStart), eq(transactions.isTransfer, false), lt(transactions.amountCents, 0)))
    .all()
    .map((row) => row.merchant);
  if (recentMerchants.length === 0) return 0;

  const rows = getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.date, yearStart),
        eq(transactions.isTransfer, false),
        lt(transactions.amountCents, 0),
        inArray(transactions.normalizedMerchant, recentMerchants),
      ),
    )
    .orderBy(asc(transactions.normalizedMerchant), asc(transactions.date), asc(transactions.id))
    .all();

  const byMerchant = new Map<string, SpendRow[]>();
  for (const row of rows) {
    const group = byMerchant.get(row.merchant) ?? [];
    group.push(row);
    byMerchant.set(row.merchant, group);
  }

  const findings: { merchant: string; verdict: NonNullable<ReturnType<typeof creepVerdict>> }[] = [];
  for (const [merchant, charges] of byMerchant) {
    const verdict = creepVerdict({ charges, today });
    if (verdict === null) continue;
    findings.push({ merchant, verdict });
  }
  findings.sort((a, b) => (a.verdict.dateIso === b.verdict.dateIso
    ? a.verdict.transactionId - b.verdict.transactionId
    : a.verdict.dateIso < b.verdict.dateIso ? -1 : 1));

  let fired = 0;
  for (const finding of findings.slice(0, CREEP_MAX_PER_EVALUATION)) {
    const { subject, body } = renderEvent({
      event: 'subscription_creep',
      merchant: finding.merchant,
      dateIso: finding.verdict.dateIso,
      newAmountCents: finding.verdict.newAmountCents,
      baselineCents: finding.verdict.baselineCents,
      priorCount: finding.verdict.priorCount,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'subscription_creep',
      dedupKey: subscriptionCreepKey(finding.verdict.transactionId),
      subject,
      body,
      at: input.now,
    });
    if (result.inserted.length > 0) fired += 1;
  }
  return fired;
}
