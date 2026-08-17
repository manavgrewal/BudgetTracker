import { readEnv } from '@/lib/env';
import { getUserSettings, notifiableUsers } from '@/lib/notify/config';
import { evaluateBudgets } from '@/lib/notify/evaluate/budget';
import { evaluateComingDue } from '@/lib/notify/evaluate/coming-due';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';
import { evaluateStaleImport } from '@/lib/notify/evaluate/stale';
import { dailySlot, weeklySlot } from '@/lib/notify/evaluate/slots';

/**
 * §6.2 — what is evaluated when:
 *   coming_due, stale_import  → the user's DAILY slot
 *   weekly_digest             → the user's WEEKLY slot
 *   budget_threshold/exceeded → EVERY tick, fingerprint-guarded (§6.5)
 *   backup_failed, new_signin, restore_outcome → immediate (§6.6), never here
 *
 * MUST-6.7 — a slot outside its catch-up window is skipped and logs exactly one line.
 * MUST-6.9 — firing a slot twice is harmless: every key contains the slot date or the item
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
        console.log(`[notify] slot ${daily.slotDate} for user ${user.id} skipped (${daily.hoursSince}h stale)`);
      }
    } catch (error) {
      console.error(`[notify] daily evaluation failed for user ${user.id}`, error);
    }

    try {
      const weekly = weeklySlot(now, settings.digestWeekday, settings.digestHour, tz);
      if (weekly.fires) {
        evaluateWeeklyDigest({ userId: user.id, slotDate: weekly.slotDate, now });
      } else {
        console.log(`[notify] slot ${weekly.slotDate} for user ${user.id} skipped (${weekly.hoursSince}h stale)`);
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
