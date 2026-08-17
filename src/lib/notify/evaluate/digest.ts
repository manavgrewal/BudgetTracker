import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { addDaysIso, currentMonth } from '@/lib/dates';
import { categoryBreakdown, topMerchants } from '@/lib/reports';
import { listReviewQueue } from '@/lib/transactions';
import { weeklyDigestKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent, type DigestLine } from '@/lib/notify/render';

const TOP_CATEGORIES = 5;
const TOP_MERCHANTS = 3;

function overBudgetNames(rows: BudgetRow[], acc: string[] = []): string[] {
  for (const row of rows) {
    if (row.overBudget) acc.push(row.categoryName);
    if (row.children.length > 0) overBudgetNames(row.children, acc);
  }
  return acc;
}

/**
 * §10.2 — the digest covers the 7 days ENDING THE DAY BEFORE the slot date:
 * from = addDaysIso(slotDate, -7), to = addDaysIso(slotDate, -1). A fixed trailing window
 * rather than a fixed Monday–Sunday week, so any chosen digest_weekday yields a complete
 * week with no stale tail (decision 8).
 *
 * Composed from EXISTING helpers only — categoryBreakdown() and topMerchants() in
 * reports.ts, budgetProgress() in budgets.ts, listReviewQueue() in transactions.ts.
 * Transfers and income are excluded by the report helpers themselves.
 *
 * A week with no transactions still sends: silence would be indistinguishable from a
 * broken channel.
 */
export function evaluateWeeklyDigest(input: { userId: number; slotDate: string; now: Date }): number {
  const from = addDaysIso(input.slotDate, -7);
  const to = addDaysIso(input.slotDate, -1);

  const householdCategories = categoryBreakdown({ from, to });
  const personalCategories = categoryBreakdown({ from, to, attributedUserId: input.userId });

  const sum = (rows: { spentCents: number }[]): number => rows.reduce((total, row) => total + row.spentCents, 0);

  const topCategories: DigestLine[] = householdCategories
    .slice()
    .sort((a, b) => b.spentCents - a.spentCents)
    .slice(0, TOP_CATEGORIES)
    .map((row) => ({ name: row.categoryName, cents: row.spentCents }));

  // TopMerchantRow's field is `normalizedMerchant` (src/lib/reports.ts) — the merchant name
  // as stored (lowercased by normalizeMerchant()), not the raw uppercase description.
  const topMerchantLines: DigestLine[] = topMerchants({ from, to, limit: TOP_MERCHANTS }).map((row) => ({
    name: row.normalizedMerchant,
    cents: row.spentCents,
  }));

  const { subject, body } = renderEvent({
    event: 'weekly_digest',
    fromIso: from,
    toIso: to,
    householdSpentCents: sum(householdCategories),
    personalSpentCents: sum(personalCategories),
    topCategories,
    topMerchants: topMerchantLines,
    reviewCount: listReviewQueue(1000).length,
    overBudget: overBudgetNames(budgetProgress(currentMonth(input.now), 'household', null)),
  });

  const result = enqueue({
    userId: input.userId,
    eventId: 'weekly_digest',
    dedupKey: weeklyDigestKey(input.slotDate),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}
