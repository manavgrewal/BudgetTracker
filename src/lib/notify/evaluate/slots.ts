import { addDaysIso, daysBetweenIso, localHour, localWeekday, todayIso } from '@/lib/dates';

/**
 * Slot arithmetic and catch-up (spec §6.3). PURE (MUST-2.1) — no @/db, no @/lib/env, no
 * node builtin. Everything here is integer arithmetic on local wall-clock components plus
 * addDaysIso's string maths, so no DST boundary can shift a day.
 *
 * MUST-6.7 — the catch-up windows. A container booting at 09:30 after missing its 08:00
 * slot DOES fire (1.5 h late). A container booting at 23:00 the following day does NOT: a
 * "coming due" notice delivered 39 hours late, immediately ahead of the next day's, is
 * noise. The weekly window is longer because a Monday-evening reboot would otherwise lose
 * an entire week's digest.
 *
 * MUST-6.8 — hoursSince is WALL-CLOCK hours, so on a DST transition day it is off by one.
 * That is deliberate: being an hour out on a 12-hour window changes nothing, and real
 * instant arithmetic across a zone transition is the class of bug this repo has
 * consistently designed out (see addMonthsClamped, parseDateString).
 *
 * MUST-6.9 — firing a slot twice is harmless by construction: every scheduled event's
 * dedup key contains the slot date or is per-item, so a second evaluation inserts nothing.
 */
export const DAILY_MAX_CATCHUP_HOURS = 12;
export const WEEKLY_MAX_CATCHUP_HOURS = 48;

export interface SlotResult {
  /** The ISO date of the slot this evaluation belongs to — part of the dedup key. */
  slotDate: string;
  /** Whole wall-clock hours since the slot's hour struck. */
  hoursSince: number;
  /** hoursSince <= the window for this slot kind. */
  fires: boolean;
}

/** MUST-6.6, daily at hour H. */
export function dailySlot(now: Date, hour: number, tz: string): SlotResult {
  const currentHour = localHour(now, tz);
  const d = currentHour >= hour ? 0 : 1;
  const slotDate = addDaysIso(todayIso(now, tz), -d);
  const hoursSince = d * 24 + (currentHour - hour);
  return { slotDate, hoursSince, fires: hoursSince <= DAILY_MAX_CATCHUP_HOURS };
}

/** MUST-6.6, weekly on weekday W (0 = Sunday) at hour H. */
export function weeklySlot(now: Date, weekday: number, hour: number, tz: string): SlotResult {
  const currentHour = localHour(now, tz);
  let d = (localWeekday(now, tz) - weekday + 7) % 7;
  if (d === 0 && currentHour < hour) d = 7;
  const slotDate = addDaysIso(todayIso(now, tz), -d);
  const hoursSince = d * 24 + (currentHour - hour);
  return { slotDate, hoursSince, fires: hoursSince <= WEEKLY_MAX_CATCHUP_HOURS };
}

/**
 * MUST-3.11: stale_import's key is `stale:<mondayOfThisWeekIso>`, so the key advances
 * every week and never repeats — which is what makes MUST-3.12's pruning-safety argument
 * hold for it. Pure string math via addDaysIso and daysBetweenIso.
 */
export function mondayOfIsoWeek(isoDate: string): string {
  // Zeller-free: 1970-01-01 was a Thursday, and addDaysIso/daysBetweenIso are exact
  // integer day maths, so walk back from a known Monday instead of constructing a Date.
  const KNOWN_MONDAY = '2026-08-17';
  const daysFrom = daysBetweenIso(KNOWN_MONDAY, isoDate);
  const offset = ((daysFrom % 7) + 7) % 7;
  return addDaysIso(isoDate, -offset);
}
