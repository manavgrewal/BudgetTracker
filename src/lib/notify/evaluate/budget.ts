import { and, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { currentMonth, monthEnd, monthStart } from '@/lib/dates';
import { getUserSettings, isEventEnabled, notifiableUsers } from '@/lib/notify/config';
import { CHANNELS, budgetExceededKey, budgetThresholdKey, type BudgetScopeKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';

/**
 * MUST-6.18 — the fingerprint guard. Budget events are evaluated on EVERY tick so an
 * afternoon import is reported in minutes rather than tomorrow morning (decision 6); the
 * fingerprint is what keeps that cheap.
 *
 * A restart clears this cache and costs exactly one extra evaluation, which is dedup-safe.
 */
let lastBudgetKey: string | null = null;

export function resetBudgetFingerprintForTests(): void {
  lastBudgetKey = null;
}

interface Participant {
  userId: number;
  thresholdPct: number;
}

/** Flatten budgetProgress()'s parent/child tree — parents and children are independent rows. */
function flatten(rows: BudgetRow[], acc: BudgetRow[] = []): BudgetRow[] {
  for (const row of rows) {
    acc.push(row);
    if (row.children.length > 0) flatten(row.children, acc);
  }
  return acc;
}

function fingerprint(month: string, participants: Participant[]): string {
  // One query, served by the existing transactions(date) index.
  const row = getDb()
    .select({
      n: sql<number>`count(*)`,
      maxId: sql<number>`coalesce(max(${transactions.id}), 0)`,
      maxUpdated: sql<string>`coalesce(max(${transactions.updatedAt}), '')`,
    })
    .from(transactions)
    .where(and(gte(transactions.date, monthStart(month)), lte(transactions.date, monthEnd(month))))
    .get();

  // max(updated_at) is in the fingerprint so that RE-CATEGORISING an existing transaction —
  // which changes neither the count nor the max id — still triggers re-evaluation. The
  // participant/threshold part is in it so a user who has just enabled the event or moved
  // their threshold is evaluated on the very next tick.
  const people = participants
    .slice()
    .sort((a, b) => a.userId - b.userId)
    .map((p) => `${p.userId}:${p.thresholdPct}`)
    .join(',');
  return `${month}|${row?.n ?? 0}|${row?.maxId ?? 0}|${row?.maxUpdated ?? ''}|${people}`;
}

function participantsFor(eventId: string): Participant[] {
  const out: Participant[] = [];
  for (const user of notifiableUsers()) {
    if (!CHANNELS.some((channel) => isEventEnabled(user.id, eventId, channel))) continue;
    out.push({ userId: user.id, thresholdPct: getUserSettings(user.id).budgetThresholdPct });
  }
  return out;
}

function fireFor(input: {
  userId: number;
  scope: BudgetScopeKey;
  row: BudgetRow;
  month: string;
  thresholdPct: number;
  now: Date;
}): number {
  const { row, scope, month, userId, thresholdPct, now } = input;
  if (row.limitCents === null || row.pct === null) return 0;

  let fired = 0;

  // MUST-6.16: both use the pct budgetProgress() already computed — including its $0-limit
  // branch — so the notification can never disagree with the progress bar the user is
  // looking at. MUST-6.17: both may fire in the same evaluation — a single import that
  // jumps straight past 100% still owes the threshold message, so pct is deliberately NOT
  // capped below 100 here; the exceeded check below is independent.
  if (row.pct >= thresholdPct) {
    const { subject, body } = renderEvent({
      event: 'budget_threshold',
      scope,
      categoryName: row.categoryName,
      month,
      pct: row.pct,
      spentCents: row.spentCents,
      limitCents: row.limitCents,
    });
    const result = enqueue({
      userId,
      eventId: 'budget_threshold',
      dedupKey: budgetThresholdKey(scope, row.categoryId, month, thresholdPct),
      subject,
      body,
      at: now,
    });
    if (result.inserted.length > 0) fired += 1;
  }

  if (row.spentCents > row.limitCents) {
    const { subject, body } = renderEvent({
      event: 'budget_exceeded',
      scope,
      categoryName: row.categoryName,
      month,
      spentCents: row.spentCents,
      limitCents: row.limitCents,
    });
    const result = enqueue({
      userId,
      eventId: 'budget_exceeded',
      dedupKey: budgetExceededKey(scope, row.categoryId, month),
      subject,
      body,
      at: now,
    });
    if (result.inserted.length > 0) fired += 1;
  }

  return fired;
}

/**
 * MUST-6.15 — evaluated on every tick, for the CURRENT MONTH only, over:
 *   - household scope: budgetProgress(month, 'household', null), delivered to every user
 *     with the event enabled;
 *   - personal scope: budgetProgress(month, 'personal', userId), delivered only to that user.
 * Only rows with a resolved limitCents participate. Parents and children are independent
 * (budgetProgress already applies the rollup rule to the parent's spentCents), so a parent
 * and one of its children may each cross and each gets its own message.
 */
export function evaluateBudgets(input: { now: Date; tz: string }): number {
  const month = currentMonth(input.now, input.tz);

  // The participant set is the union of both budget events — the threshold value only
  // matters for budget_threshold, but a user who has only budget_exceeded on still has to
  // appear in the fingerprint so enabling it re-evaluates on the next tick.
  const thresholdPeople = participantsFor('budget_threshold');
  const exceededPeople = participantsFor('budget_exceeded');
  const everyone = new Map<number, Participant>();
  for (const person of [...thresholdPeople, ...exceededPeople]) {
    everyone.set(person.userId, person);
  }
  if (everyone.size === 0) {
    lastBudgetKey = null;
    return 0;
  }

  const key = fingerprint(month, [...everyone.values()]);
  if (key === lastBudgetKey) return 0;
  lastBudgetKey = key;

  let fired = 0;
  const householdRows = flatten(budgetProgress(month, 'household', null));

  for (const person of everyone.values()) {
    for (const row of householdRows) {
      fired += fireFor({ userId: person.userId, scope: 'household', row, month, thresholdPct: person.thresholdPct, now: input.now });
    }
    for (const row of flatten(budgetProgress(month, 'personal', person.userId))) {
      fired += fireFor({ userId: person.userId, scope: 'personal', row, month, thresholdPct: person.thresholdPct, now: input.now });
    }
  }

  return fired;
}
