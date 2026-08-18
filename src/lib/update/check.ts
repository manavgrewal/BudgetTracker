import { adminUserIds } from '@/lib/notify/config';
import { scrubSecrets } from '@/lib/notify/crypto';
import { updateAvailableKey } from '@/lib/notify/events';
import { enqueue, kickOutbox } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { UpdateCheckError, fetchLatestRelease } from '@/lib/update/github';
import { classify, parseSemver, type UpdateSeverity } from '@/lib/update/semver';
import {
  readUpdateState,
  recordApplyOutcome,
  recordApplyRequested,
  recordCheckOutcome,
} from '@/lib/update/state';
import { WatchtowerError, triggerUpdate, watchtowerConfig, type TriggerOutcome } from '@/lib/update/watchtower';
import { APP_VERSION } from '@/lib/version';

/** MUST-5.5: one automatic attempt per 24 hours, counted from EVERY attempt. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckResult {
  severity: UpdateSeverity;
  currentVersion: string;
  latestVersion: string | null;
  /** True when the app fired a Watchtower apply as part of this check. */
  applied: boolean;
  /** True when an `update_available` notification was enqueued. */
  notified: boolean;
  error: string | null;
}

/**
 * MUST-5.5: compares against `update.last_checked_at`, which is written on every attempt —
 * success or failure — so a container in a crash-restart loop makes at most one GitHub
 * request per 24 hours, not one per boot, and a repeatedly failing check cannot become a
 * retry storm.
 */
export function dueForCheck(lastCheckedAt: string | null, now: Date): boolean {
  if (lastCheckedAt === null) return true;
  const last = Date.parse(lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= UPDATE_CHECK_INTERVAL_MS;
}

function scrub(text: string): string {
  const token = watchtowerConfig()?.token;
  return token === undefined ? text : scrubSecrets(text, [token]);
}

/**
 * MUST-7.4: the ordering is load-bearing.
 *   1. recordApplyRequested — written and COMMITTED before the fetch, because the request
 *      that follows may kill this process. reconcileApplyOnBoot then closes the loop.
 *   2..7 live in triggerUpdate (assert, fetch, classify the outcome).
 *
 * MUST-10.11: every string that can reach `update.last_apply_error`, console.* or the
 * browser goes through scrubSecrets with the token in the secret list.
 */
export async function applyUpdate(input: { version: string; now?: Date }): Promise<TriggerOutcome> {
  const at = input.now ?? new Date();
  const config = watchtowerConfig();
  if (config === null) throw new WatchtowerError('This install has no Watchtower companion to ask.', { permanent: true });

  recordApplyRequested({ version: input.version, at });
  try {
    const outcome = await triggerUpdate(config);
    // 'accepted-unconfirmed' records NO error: the app has just asked something to kill it.
    recordApplyOutcome({ at });
    return outcome;
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'The update request failed.';
    recordApplyOutcome({ at, error: scrubSecrets(raw, [config.token]) });
    throw error;
  }
}

/**
 * MUST-10.5: the scheduler tick and the Check-now button call THIS function. There is no
 * second code path, so a manual check and an automatic one can never classify the same pair
 * of versions differently.
 *
 * MUST-5.7: after a successful check, exactly one of five outcomes obtains, and this
 * function returns which.
 */
export async function runUpdateCheck(input: { now?: Date; manual?: boolean }): Promise<UpdateCheckResult> {
  const at = input.now ?? new Date();
  const currentVersion = APP_VERSION;
  const current = parseSemver(currentVersion);

  let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
  try {
    release = await fetchLatestRelease();
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : 'The update check failed.');
    // MUST-5.5: the stamp is written on a FAILED attempt too, before returning.
    recordCheckOutcome({ at, error: message });
    if (!(error instanceof UpdateCheckError)) console.error('[update] check failed', message);
    return { severity: 'none', currentVersion, latestVersion: null, applied: false, notified: false, error: message };
  }

  const remote = parseSemver(release.version);
  if (current === null || remote === null) {
    const message = 'This app could not compare its own version with the published one.';
    recordCheckOutcome({ at, error: message });
    return { severity: 'none', currentVersion, latestVersion: null, applied: false, notified: false, error: message };
  }

  const severity = classify(current, remote);
  if (severity === 'none') {
    recordCheckOutcome({ at, latestVersion: null, publishedAt: null });
    return { severity, currentVersion, latestVersion: null, applied: false, notified: false, error: null };
  }
  recordCheckOutcome({ at, latestVersion: release.version, publishedAt: release.publishedAt });

  const state = readUpdateState();
  const config = watchtowerConfig();
  let autoApply = state.autoApply;
  // MUST-5.8: UNCONDITIONAL, and placed BEFORE the apply branch rather than as a condition
  // inside it. There is no setting, environment variable or query parameter that makes a
  // major auto-apply. A major version is by definition the release where the maintainer is
  // telling you something changed underneath you, and this app runs a household's financial
  // records unattended on a NAS.
  if (severity === 'major') autoApply = false;

  if (autoApply && config !== null) {
    try {
      await applyUpdate({ version: release.version, now: at });
      // MUST-5.7 row 2: NO notification. The container is about to be replaced and Settings
      // -> About will show the new version.
      return { severity, currentVersion, latestVersion: release.version, applied: true, notified: false, error: null };
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : 'The update could not be applied.');
      console.error('[update] apply failed', message);
      return { severity, currentVersion, latestVersion: release.version, applied: false, notified: false, error: message };
    }
  }

  const notified = notifyUpdateAvailable({
    currentVersion,
    latestVersion: release.version,
    severity,
    publishedAt: release.publishedAt,
    canApplyInApp: config !== null,
    at,
  });
  return { severity, currentVersion, latestVersion: release.version, applied: false, notified, error: null };
}

/**
 * MUST-6.2: this — one enqueue() plus one kickOutbox() — is the third and last file the
 * new event touches. No migration. No src/db/schema.ts change. No settings-UI change,
 * because the toggle matrix is generated from the registry.
 *
 * MUST-4.3 (notify): audience 'admin', so this fans out to active admins only.
 */
function notifyUpdateAvailable(input: {
  currentVersion: string;
  latestVersion: string;
  severity: Exclude<UpdateSeverity, 'none'>;
  publishedAt: string | null;
  canApplyInApp: boolean;
  at: Date;
}): boolean {
  try {
    const { subject, body } = renderEvent({
      event: 'update_available',
      currentVersion: input.currentVersion,
      latestVersion: input.latestVersion,
      severity: input.severity,
      publishedAt: input.publishedAt,
      canApplyInApp: input.canApplyInApp,
    });
    let queued = 0;
    for (const userId of adminUserIds()) {
      queued += enqueue({
        userId,
        eventId: 'update_available',
        // MUST-5.9: the dedup key is per VERSION, so dismissing 1.4.0 and then having 1.5.0
        // published raises a new notice.
        dedupKey: updateAvailableKey(input.latestVersion),
        subject,
        body,
        at: input.at,
      }).inserted.length;
    }
    if (queued > 0) kickOutbox(input.at);
    return queued > 0;
  } catch (error) {
    // A notification failure may not break an update check, exactly as notify MUST-6.19's
    // raisers may not break a login or a boot.
    console.error('[update] update_available raise failed', error);
    return false;
  }
}
