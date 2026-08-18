import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { notificationOutbox } from '@/db/schema';
import { readEnv } from '@/lib/env';
import { getUserSettings, notifiableUsers } from '@/lib/notify/config';
import { evaluateBudgets } from '@/lib/notify/evaluate/budget';
import { evaluateComingDue } from '@/lib/notify/evaluate/coming-due';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';
import { evaluateStaleImport } from '@/lib/notify/evaluate/stale';
import { dailySlot, weeklySlot } from '@/lib/notify/evaluate/slots';
import { weeklyDigestKey } from '@/lib/notify/events';

/**
 * Slot-skip logging is deduped by (kind, userId) so a family sitting outside every slot's
 * catch-up window (the common case between ticks) does not write ~1000 identical "skipped"
 * lines a day (every 5-minute tick, times every user, times two slot kinds). A line is
 * emitted only when the SKIPPED SLOT DATE changes from the last one logged for that
 * (kind, userId); the slot advancing to a new day is still visible, just not every 5 minutes.
 */
let lastLoggedSlot = new Map<string, string>();

export function resetSlotSkipLogForTests(): void {
  lastLoggedSlot = new Map();
}

function logSlotSkipOnce(kind: 'daily' | 'weekly', userId: number, slotDate: string, hoursSince: number): void {
  const key = `${kind}:${userId}`;
  if (lastLoggedSlot.get(key) === slotDate) return;
  lastLoggedSlot.set(key, slotDate);
  console.log(`[notify] slot ${slotDate} (${kind}) for user ${userId} skipped (${hoursSince}h stale)`);
}

/**
 * MUST-3.11's dedup key already contains the slot date, so a digest already sent for this
 * user's current slot means every tick for the rest of the 48h catch-up window would
 * otherwise recompute categoryBreakdown/topMerchants/budgetProgress/reviewQueueCount only to
 * have enqueue() discard the result. This indexed existence check (served by
 * notification_outbox_dedup_uq's (user_id, ...) prefix) skips that recompute entirely once
 * the real send has already happened. coming_due has no equivalent check: its own query is
 * already a single cheap read, so the extra existence check would cost more than it saves.
 */
function digestAlreadySent(userId: number, slotDate: string): boolean {
  const row = getDb()
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.userId, userId), eq(notificationOutbox.dedupKey, weeklyDigestKey(slotDate))))
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * §6.2: what is evaluated when:
 *   coming_due, stale_import  → the user's DAILY slot
 *   weekly_digest             → the user's WEEKLY slot
 *   budget_threshold/exceeded → EVERY tick, fingerprint-guarded (§6.5)
 *   backup_failed, new_signin, restore_outcome → immediate (§6.6), never here
 *
 * MUST-6.7: a slot outside its catch-up window is skipped, logging exactly one line PER
 * SLOT (see logSlotSkipOnce) rather than once per five-minute tick for as long as the
 * install stays outside every window.
 * MUST-6.9: firing a slot twice is harmless: every key contains the slot date or the item
 * id, so a second evaluation inserts nothing.
 *
 * This function never throws into the scheduler: each user's evaluation is wrapped so one
 * bad row cannot stop the rest of the household from being told anything.
 */
export function runScheduledEvaluation(now: Date = new Date()): void {
  const { tz } = readEnv();

  for (const user of notifiableUsers()) {
    const settings = getUserSettings(user.id);

    try {
      const daily = dailySlot(now, settings.dailyHour, tz);
      if (daily.fires) {
        evaluateComingDue({ userId: user.id, now, tz });
        evaluateStaleImport({ userId: user.id, now, tz });
      } else {
        logSlotSkipOnce('daily', user.id, daily.slotDate, daily.hoursSince);
      }
    } catch (error) {
      console.error(`[notify] daily evaluation failed for user ${user.id}`, error);
    }

    try {
      const weekly = weeklySlot(now, settings.digestWeekday, settings.digestHour, tz);
      if (weekly.fires) {
        if (!digestAlreadySent(user.id, weekly.slotDate)) {
          evaluateWeeklyDigest({ userId: user.id, slotDate: weekly.slotDate, now });
        }
      } else {
        logSlotSkipOnce('weekly', user.id, weekly.slotDate, weekly.hoursSince);
      }
    } catch (error) {
      console.error(`[notify] weekly evaluation failed for user ${user.id}`, error);
    }
  }

  try {
    evaluateBudgets({ now, tz });
  } catch (error) {
    console.error('[notify] budget evaluation failed', error);
  }
}
