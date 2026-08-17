import { desc } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { imports } from '@/db/schema';
import { daysBetweenIso, todayIso } from '@/lib/dates';
import { getUserSettings } from '@/lib/notify/config';
import { staleImportKey } from '@/lib/notify/events';
import { mondayOfIsoWeek } from '@/lib/notify/evaluate/slots';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';

/**
 * Decision 10 — an install with ZERO imports never fires. A brand-new install must not nag
 * before it has anything to be stale about.
 *
 * MUST-14.8 — SimpleFIN syncs create `imports` rows too, so a household on SimpleFIN is
 * never nagged by this event. The query deliberately looks at every import in the
 * household, not only the ones this user made: staleness is a property of the data, not of
 * who last pressed the button.
 *
 * MUST-3.11 — one message per calendar week while stale, keyed on the Monday of the
 * current week, so the key advances every week and never repeats.
 */
export function evaluateStaleImport(input: { userId: number; now: Date; tz: string }): number {
  const latest = getDb()
    .select({ createdAt: imports.createdAt })
    .from(imports)
    .orderBy(desc(imports.createdAt))
    .limit(1)
    .get();
  if (!latest) return 0;

  const settings = getUserSettings(input.userId);
  const today = todayIso(input.now, input.tz);
  const lastImportIso = latest.createdAt.slice(0, 10);
  const daysAgo = daysBetweenIso(lastImportIso, today);
  if (daysAgo < settings.staleImportWeeks * 7) return 0;

  const { subject, body } = renderEvent({
    event: 'stale_import',
    weeks: settings.staleImportWeeks,
    lastImportIso,
    daysAgo,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'stale_import',
    dedupKey: staleImportKey(mondayOfIsoWeek(today)),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}
