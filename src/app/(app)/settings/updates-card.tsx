import { classify, parseSemver, type UpdateSeverity } from '@/lib/update/semver';
import { readUpdateState } from '@/lib/update/state';
import { watchtowerConfig, watchtowerConfigError } from '@/lib/update/watchtower';
import { APP_VERSION } from '@/lib/version';
import { UpdatesClient } from './updates-client';

/**
 * MUST-9.1: rendered from settings/page.tsx immediately before <AboutPanel />, and ONLY for
 * user.role === 'admin'. A member's Settings page is byte-identical to v1.3.0's.
 *
 * MUST-9.2: this is NOT added to ADMIN_LINKS. It is a card with controls, not a link to
 * another page, for the same reason the Sessions card is.
 *
 * MUST-7.3: the client half receives `canApplyInApp: boolean` and nothing more. No page
 * prop carries WATCHTOWER_TOKEN, or WATCHTOWER_URL, or any fragment of either.
 *
 * Review fix (bug): NOT async, deliberately. readUpdateState()/watchtowerConfig() are both
 * synchronous, and an async component can only be rendered by Next's RSC pipeline. Marking
 * it async made it impossible to unit-test SettingsPage() with plain react-dom (as
 * settings-page-notifications.test.tsx does), the same reason AboutPanel is a plain function
 * too, and `render()`ing it as a member never touches this path so the bug went unnoticed.
 */
export function UpdatesCard() {
  const state = readUpdateState();

  const current = parseSemver(APP_VERSION);
  const remote = state.latestVersion === null ? null : parseSemver(state.latestVersion);
  const severity: UpdateSeverity = current !== null && remote !== null ? classify(current, remote) : 'none';

  return (
    <UpdatesClient
      currentVersion={APP_VERSION}
      enabled={state.enabled}
      autoApply={state.autoApply}
      lastCheckedAt={state.lastCheckedAt}
      lastCheckError={state.lastCheckError}
      latestVersion={state.latestVersion}
      latestPublishedAt={state.latestPublishedAt}
      dismissedVersion={state.dismissedVersion}
      lastAppliedAt={state.lastAppliedAt}
      lastApplyError={state.lastApplyError}
      severity={severity}
      canApplyInApp={watchtowerConfig() !== null}
      watchtowerError={watchtowerConfigError()}
    />
  );
}
