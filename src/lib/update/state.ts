import { deleteSetting, getSetting, setSetting } from '@/lib/settings';
import { APP_VERSION } from '@/lib/version';

/**
 * MUST-3.1: the update feature adds NO table, NO column and NO migration. Every byte of
 * its state is a key/value row in the existing `settings` table, and this module owns every
 * one of those strings (MUST-3.2): no other module writes a key beginning `update.`.
 *
 * That is not a convenience. It is what makes MUST-1.1 structurally true rather than
 * conventionally true: there is no column with a default, no seeded row, no
 * `NOT NULL ... DEFAULT 1` anywhere that could turn the feature on for somebody who never
 * asked for it. ABSENCE IS THE OFF STATE.
 */
const KEY_ENABLED = 'update.checks_enabled';
const KEY_ENABLED_BY = 'update.enabled_by';
const KEY_ENABLED_AT = 'update.enabled_at';
const KEY_AUTO_APPLY = 'update.auto_apply';
const KEY_LAST_CHECKED_AT = 'update.last_checked_at';
const KEY_LAST_CHECK_ERROR = 'update.last_check_error';
const KEY_LATEST_VERSION = 'update.latest_version';
const KEY_LATEST_PUBLISHED_AT = 'update.latest_published_at';
const KEY_DISMISSED_VERSION = 'update.dismissed_version';
const KEY_APPLY_REQUESTED_VERSION = 'update.apply_requested_version';
const KEY_APPLY_REQUESTED_AT = 'update.apply_requested_at';
const KEY_LAST_APPLIED_AT = 'update.last_applied_at';
const KEY_LAST_APPLY_ERROR = 'update.last_apply_error';
/**
 * Fix wave item 1(c): the version of the LAST apply request that the reconciler timed out
 * (still on the old version past the 30-minute window). It exists so a version that can
 * never actually replace this container — a pinned image tag is the concrete case — does not
 * get auto-retried once a day forever. Set only by reconcilePendingApply's timeout branch;
 * cleared by a fresh apply request (recordApplyRequested) or a confirmed apply.
 */
const KEY_LAST_APPLY_FAILED_VERSION = 'update.last_apply_failed_version';

/** MUST-3.4: every key the disable action wipes. The flag itself is written, not deleted. */
const WIPED_ON_DISABLE = [
  KEY_ENABLED_BY,
  KEY_ENABLED_AT,
  KEY_AUTO_APPLY,
  KEY_LAST_CHECKED_AT,
  KEY_LAST_CHECK_ERROR,
  KEY_LATEST_VERSION,
  KEY_LATEST_PUBLISHED_AT,
  KEY_DISMISSED_VERSION,
  KEY_APPLY_REQUESTED_VERSION,
  KEY_APPLY_REQUESTED_AT,
  KEY_LAST_APPLIED_AT,
  KEY_LAST_APPLY_ERROR,
  KEY_LAST_APPLY_FAILED_VERSION,
] as const;

/** MUST-7.6: past this, an unconfirmed apply is declared not to have happened. */
export const APPLY_CONFIRM_MAX_AGE_MS = 30 * 60_000;

export interface UpdateState {
  enabled: boolean;
  enabledBy: number | null;
  enabledAt: string | null;
  /** MUST-3.5: false when !enabled, regardless of what is stored. */
  autoApply: boolean;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  dismissedVersion: string | null;
  applyRequestedVersion: string | null;
  applyRequestedAt: string | null;
  lastAppliedAt: string | null;
  lastApplyError: string | null;
  /** Fix wave item 1(c): non-null only while auto-apply is skipping this exact version. */
  lastApplyFailedVersion: string | null;
}

function iso(at: Date): string {
  return at.toISOString();
}

function writeOrDelete(key: string, value: string | null | undefined): void {
  if (value === null || value === undefined || value.length === 0) deleteSetting(key);
  else setSetting(key, value);
}

/**
 * MUST-1.1 / MUST-5.1: the dormancy gate. ONE indexed read of a settings key that is ABSENT
 * on every install nobody has enabled this on. runUpdateTick()'s first statement.
 */
export function isUpdateCheckEnabled(): boolean {
  return getSetting(KEY_ENABLED) === '1';
}

/**
 * MUST-3.3: a single reader that returns the whole picture, so no caller assembles it from
 * loose getSetting calls and no two callers can disagree about what the state is.
 */
export function readUpdateState(): UpdateState {
  const enabled = isUpdateCheckEnabled();
  const enabledByRaw = getSetting(KEY_ENABLED_BY);
  const enabledBy = enabledByRaw === null ? null : Number.parseInt(enabledByRaw, 10);
  return {
    enabled,
    enabledBy: enabledBy !== null && Number.isFinite(enabledBy) ? enabledBy : null,
    enabledAt: getSetting(KEY_ENABLED_AT),
    // MUST-3.2: absent means ON once checks are enabled. MUST-3.5: forced false while
    // disabled, so no caller can reach an apply path through a stale key.
    autoApply: enabled ? getSetting(KEY_AUTO_APPLY) !== '0' : false,
    lastCheckedAt: getSetting(KEY_LAST_CHECKED_AT),
    lastCheckError: getSetting(KEY_LAST_CHECK_ERROR),
    latestVersion: getSetting(KEY_LATEST_VERSION),
    latestPublishedAt: getSetting(KEY_LATEST_PUBLISHED_AT),
    dismissedVersion: getSetting(KEY_DISMISSED_VERSION),
    applyRequestedVersion: getSetting(KEY_APPLY_REQUESTED_VERSION),
    applyRequestedAt: getSetting(KEY_APPLY_REQUESTED_AT),
    lastAppliedAt: getSetting(KEY_LAST_APPLIED_AT),
    lastApplyError: getSetting(KEY_LAST_APPLY_ERROR),
    lastApplyFailedVersion: getSetting(KEY_LAST_APPLY_FAILED_VERSION),
  };
}

/**
 * MUST-3.4: turning the feature OFF deletes every `update.` key except the flag itself.
 * Off means off, and re-enabling starts clean: no cached remote version to render, no
 * stale error banner, and no dismissed-version memory that would silently swallow the next
 * notice if it were turned back on.
 */
export function clearUpdateState(): void {
  for (const key of WIPED_ON_DISABLE) deleteSetting(key);
  setSetting(KEY_ENABLED, '0');
}

export function setUpdateChecksEnabled(input: { enabled: boolean; userId: number; at?: Date }): void {
  if (!input.enabled) {
    clearUpdateState();
    return;
  }
  // Enabling also starts clean, so a re-enable never resurrects the previous run's cache.
  for (const key of WIPED_ON_DISABLE) deleteSetting(key);
  setSetting(KEY_ENABLED, '1');
  setSetting(KEY_ENABLED_BY, String(input.userId));
  setSetting(KEY_ENABLED_AT, iso(input.at ?? new Date()));
}

export function setAutoApply(enabled: boolean): void {
  setSetting(KEY_AUTO_APPLY, enabled ? '1' : '0');
}

/**
 * MUST-5.5: `update.last_checked_at` is written on EVERY attempt, success or failure, before
 * runUpdateCheck returns. A container in a crash-restart loop therefore makes at most one
 * GitHub request per 24 hours, not one per boot.
 */
export function recordCheckOutcome(input: {
  at: Date;
  latestVersion?: string | null;
  publishedAt?: string | null;
  error?: string | null;
}): void {
  setSetting(KEY_LAST_CHECKED_AT, iso(input.at));
  if (input.error !== undefined && input.error !== null) {
    setSetting(KEY_LAST_CHECK_ERROR, input.error);
    // A failure does not invent a version, and does not clear the last one we did observe.
    return;
  }
  deleteSetting(KEY_LAST_CHECK_ERROR);
  writeOrDelete(KEY_LATEST_VERSION, input.latestVersion ?? null);
  writeOrDelete(KEY_LATEST_PUBLISHED_AT, input.publishedAt ?? null);
}

/** MUST-7.4 step 1: written and COMMITTED before the fetch, because it may kill this process. */
export function recordApplyRequested(input: { version: string; at: Date }): void {
  deleteSetting(KEY_LAST_APPLY_ERROR);
  // Fix wave item 1(c): a fresh attempt — automatic against a NEWER version, or a manual
  // retry of the same one — deserves a clean slate rather than an auto-apply guard that
  // remembers last time's failure forever.
  deleteSetting(KEY_LAST_APPLY_FAILED_VERSION);
  setSetting(KEY_APPLY_REQUESTED_VERSION, input.version);
  setSetting(KEY_APPLY_REQUESTED_AT, iso(input.at));
}

/**
 * Fix wave item 1(a): Watchtower's 2xx means it ACCEPTED the request, not that it replaced
 * anything — a pinned image tag can 2xx and never restart this container. Acceptance is
 * therefore recorded here as "no error", nothing more; `update.last_applied_at` is written
 * ONLY by reconcilePendingApply(), below, once a real boot (or a later check tick, for an
 * install that never reboots) has had the chance to prove the running version actually
 * changed. `recordApplyRequested` already committed the pending apply-request state that
 * reconciliation resolves, before the fetch that may kill this process.
 */
export function recordApplyOutcome(input: { at: Date; error?: string | null }): void {
  if (input.error !== undefined && input.error !== null) {
    setSetting(KEY_LAST_APPLY_ERROR, input.error);
    return;
  }
  deleteSetting(KEY_LAST_APPLY_ERROR);
}

/**
 * MUST-5.9: suppresses only the card's prominence, never the check and never the dedup.
 *
 * Fix round finding 3: routed through writeOrDelete rather than a bare setSetting, so
 * dismissVersion('') (the "Show again" un-dismiss call) DELETES the key instead of writing
 * an empty-string row. getSetting() returns exactly what was stored, never coercing '' to
 * null, so a bare setSetting('') would have left readUpdateState().dismissedVersion as ''.
 * That is a falsy-but-not-null value the About panel and Task 8's card logic would have had
 * to guard against separately, and easily wouldn't have.
 */
export function dismissVersion(version: string): void {
  writeOrDelete(KEY_DISMISSED_VERSION, version);
}

/**
 * MUST-7.6: what turns "we fired a request into the dark" into a state machine with a
 * definite end, and the reason recordApplyRequested writes BEFORE the fetch.
 *
 * Fix wave item 1(a)/1(b): the ONLY place `update.last_applied_at` is written. Originally
 * this ran on boot alone (`reconcileApplyOnBoot`), which is sufficient for an install that
 * genuinely restarts into the new version, but a compose file that pins its image tag lets
 * Watchtower 2xx-accept a request that replaces nothing — the container never reboots, so a
 * boot-only reconciler could never close the loop for that install. `runUpdateCheck` (in
 * check.ts) therefore calls this SAME function at the top of every tick too, not just
 * instrumentation-node.ts at boot: a later check tick is what finally notices the 30-minute
 * window has passed with the version unchanged, at which point it is honest about the
 * failure (writes `update.last_apply_error`, the card's existing error path) instead of
 * silently pretending the update landed.
 */
function reconcilePendingApplyUnguarded(now: Date): void {
  const requested = getSetting(KEY_APPLY_REQUESTED_VERSION);
  if (requested === null) return;

  if (requested === APP_VERSION) {
    // The apply worked: the container we asked to be replaced is the one we are not.
    setSetting(KEY_LAST_APPLIED_AT, iso(now));
    deleteSetting(KEY_APPLY_REQUESTED_VERSION);
    deleteSetting(KEY_APPLY_REQUESTED_AT);
    deleteSetting(KEY_LAST_APPLY_ERROR);
    deleteSetting(KEY_LATEST_VERSION);
    deleteSetting(KEY_LATEST_PUBLISHED_AT);
    deleteSetting(KEY_LAST_APPLY_FAILED_VERSION);
    console.log(`[update] confirmed apply to ${APP_VERSION}`);
    return;
  }

  const requestedAt = getSetting(KEY_APPLY_REQUESTED_AT);
  const requestedMs = requestedAt === null ? Number.NaN : Date.parse(requestedAt);
  if (Number.isFinite(requestedMs) && now.getTime() - requestedMs > APPLY_CONFIRM_MAX_AGE_MS) {
    // The apply did not happen: still on the old version, well past the window Watchtower
    // needed to have already replaced this container by. delete apply_requested_* and admit
    // it via the same last_apply_error path the card already renders.
    deleteSetting(KEY_APPLY_REQUESTED_VERSION);
    deleteSetting(KEY_APPLY_REQUESTED_AT);
    setSetting(
      KEY_LAST_APPLY_ERROR,
      `The update was requested but the app is still on ${APP_VERSION}. Check the Watchtower container's logs.`,
    );
    // Fix wave item 1(c): remember which version this was so the NEXT check's auto-apply
    // branch skips re-triggering it. Without this a version that can never actually replace
    // the container (a pinned image tag, concretely) would be re-fired once a day forever,
    // each time 2xx-"accepted" and each time going nowhere.
    setSetting(KEY_LAST_APPLY_FAILED_VERSION, requested);
    return;
  }
  // Otherwise leave the pending state alone: a check (or boot) that happens to precede the
  // replacement must not erase the record of what was asked for.
}

/**
 * Exported so check.ts's runUpdateCheck can call the exact same reconciliation every tick,
 * not only reconcileApplyOnBoot below. Never throws (MUST-7.7's guarantee, generalised
 * beyond just the boot path now that a check tick relies on it too).
 */
export function reconcilePendingApply(now: Date = new Date()): void {
  try {
    reconcilePendingApplyUnguarded(now);
  } catch (error) {
    console.error('[update] apply reconciliation failed', error);
  }
}

/**
 * MUST-7.7: this must NEVER throw into the boot path, exactly as notify's
 * raiseRestoreOutcome must not. Called from src/instrumentation-node.ts after getDb() and
 * before startScheduler().
 */
export function reconcileApplyOnBoot(now: Date = new Date()): void {
  reconcilePendingApply(now);
}
