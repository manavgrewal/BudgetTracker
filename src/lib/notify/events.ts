/**
 * The event registry (spec §4): PURE and client-safe (MUST-2.1). No @/db import, no
 * @/lib/env import, no node builtin: this module is imported by the client-side toggle
 * matrix, and importing @/db here fails the client webpack build outright (Ruling P4, the
 * same constraint that governs src/lib/warranty/constants.ts).
 *
 * MUST-4.4: the extension point. Adding an event type is: append one entry below, add one
 * case to renderEvent() in render.ts, and (for a scheduled event) one evaluator call. No
 * migration. No src/db/schema.ts change. No UI change: the matrix is generated from this
 * array.
 *
 * MUST-4.5: an `id` is PERMANENT once shipped. notification_prefs keys on the string, so
 * renaming one silently resets every user's stored preference for it.
 */
export type Channel = 'telegram' | 'email';
export const CHANNELS: readonly Channel[] = ['telegram', 'email'];

export function isChannel(value: string): value is Channel {
  return value === 'telegram' || value === 'email';
}

/** `h` for a household budget, `p` for the recipient's personal one (MUST-3.11). */
export type BudgetScopeKey = 'household' | 'personal';

export type NotificationAudience = 'all' | 'admin';
export type NotificationTrigger = 'daily_slot' | 'weekly_slot' | 'tick' | 'immediate';

export interface NotificationEventDef {
  /** The stable storage key. Never renamed once shipped (MUST-4.5). */
  readonly id: string;
  readonly label: string;
  /** One sentence under the label in the toggle matrix. */
  readonly blurb: string;
  readonly audience: NotificationAudience;
  readonly trigger: NotificationTrigger;
  readonly defaultEnabled: boolean;
}

/**
 * MUST-4.1: the defaults split on one line: ON for "something is wrong, or a deadline is
 * near"; OFF for the chattier informational events a person should opt into. new_signin
 * is on because a security event nobody switched on protects nobody.
 *
 * MUST-4.2: a default of ON has effect only once a channel exists. A user with no
 * notification_targets row receives nothing, defaults notwithstanding.
 */
export const NOTIFICATION_EVENTS: readonly NotificationEventDef[] = [
  {
    id: 'coming_due',
    label: 'Something is coming due',
    blurb: 'A warranty, subscription, contract or loan reaches its date soon.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: true,
  },
  {
    id: 'budget_threshold',
    label: 'A budget is getting close',
    blurb: 'A category has passed the percentage you set for this month.',
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: false,
  },
  {
    id: 'budget_exceeded',
    label: 'A budget is blown',
    blurb: 'A category has spent more than its limit for this month.',
    audience: 'all',
    trigger: 'tick',
    defaultEnabled: true,
  },
  {
    id: 'backup_failed',
    label: 'The nightly backup failed',
    blurb: 'The unattended 2am backup did not complete.',
    audience: 'admin',
    trigger: 'immediate',
    defaultEnabled: true,
  },
  {
    id: 'weekly_digest',
    label: 'Weekly spending summary',
    blurb: 'What the household spent over the last seven days.',
    audience: 'all',
    trigger: 'weekly_slot',
    defaultEnabled: false,
  },
  {
    id: 'new_signin',
    label: 'New sign-in to your account',
    blurb: 'Somebody signed in as you, from somewhere.',
    audience: 'all',
    trigger: 'immediate',
    defaultEnabled: true,
  },
  {
    id: 'restore_outcome',
    label: 'A restore finished',
    blurb: 'A backup was restored into this install, successfully or not.',
    audience: 'admin',
    trigger: 'immediate',
    defaultEnabled: true,
  },
  {
    id: 'stale_import',
    label: 'Nothing has been imported lately',
    blurb: 'No bank export has landed for the number of weeks you set.',
    audience: 'all',
    trigger: 'daily_slot',
    defaultEnabled: false,
  },
  {
    id: 'update_available',
    label: 'An update is available',
    blurb: 'A newer version of Budget Tracker is published and is waiting for your say-so.',
    audience: 'admin',
    trigger: 'tick',
    defaultEnabled: true,
  },
];

export function eventDef(id: string): NotificationEventDef | undefined {
  return NOTIFICATION_EVENTS.find((event) => event.id === id);
}

export function isNotificationEventId(value: string): boolean {
  return eventDef(value) !== undefined;
}

/**
 * MUST-4.3: audience 'admin' events are never enqueued for a member, never rendered in a
 * member's matrix, and are skipped for a user who has since been demoted.
 */
export function eventsFor(role: 'admin' | 'member'): readonly NotificationEventDef[] {
  return role === 'admin' ? NOTIFICATION_EVENTS : NOTIFICATION_EVENTS.filter((event) => event.audience === 'all');
}

/**
 * MUST-3.11: the dedup keys, exactly. user_id and channel are already part of the unique
 * index (MUST-3.9) and are never repeated inside a key.
 *
 * MUST-3.12 (pruning safety): every key below is either bounded to a calendar period that
 * evaluation only visits within the current few days, or derived from a monotonically
 * increasing timestamp that never recurs, so the 400-day retention sweep can never
 * resurrect an already-delivered event.
 */
function scopeLetter(scope: BudgetScopeKey): 'h' | 'p' {
  return scope === 'household' ? 'h' : 'p';
}

/** Once per item per expiry date, EVER. Editing the date is a new fact and a new key. */
export function comingDueKey(itemId: number, expiryDate: string): string {
  return `due:${itemId}:${expiryDate}`;
}

/** Once per scope/category/month/threshold. The pct is the user's configured threshold. */
export function budgetThresholdKey(scope: BudgetScopeKey, categoryId: number, month: string, pct: number): string {
  return `budget:${scopeLetter(scope)}:${categoryId}:${month}:${pct}`;
}

/** Once per scope/category/month. Pinned at 100 so it can never collide with a threshold. */
export function budgetExceededKey(scope: BudgetScopeKey, categoryId: number, month: string): string {
  return `budget:${scopeLetter(scope)}:${categoryId}:${month}:100`;
}

export function backupFailedKey(dateIso: string): string {
  return `backup-failed:${dateIso}`;
}

export function weeklyDigestKey(slotDateIso: string): string {
  return `digest:${slotDateIso}`;
}

export function newSigninKey(sessionCreatedAt: string): string {
  return `signin:${sessionCreatedAt}`;
}

export function restoreOutcomeKey(finishedAt: string): string {
  return `restore:${finishedAt}`;
}

export function staleImportKey(mondayIso: string): string {
  return `stale:${mondayIso}`;
}

/**
 * Once per remote version, ever. Versions only ever go up, so this key never recurs.
 *
 * MUST-6.3 (pruning safety, honestly stated): there is ONE residual case. An install that
 * stays on its current version for more than 400 days while the same newer release remains
 * the latest will have its `update:<version>` row pruned by the retention sweep and will be
 * told once more, on the following check, that that version is available. One reminder every
 * 400 days about an update you have been ignoring for 400 days is correct behaviour, not a
 * defect, and it is the only condition under which this key can regenerate.
 */
export function updateAvailableKey(version: string): string {
  return `update:${version}`;
}
