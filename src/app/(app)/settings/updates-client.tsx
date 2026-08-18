'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { renderEmphasis } from '@/components/render-emphasis';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import type { UpdateSeverity } from '@/lib/update/semver';
import {
  applyUpdateAction,
  checkForUpdateNowAction,
  disableUpdateChecksAction,
  dismissUpdateAction,
  enableUpdateChecksAction,
  reviewUpdateAction,
  setAutoApplyAction,
  type ReviewUpdateState,
  type UpdateActionState,
} from './actions';

export interface UpdatesViewProps {
  currentVersion: string;
  enabled: boolean;
  autoApply: boolean;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  dismissedVersion: string | null;
  lastAppliedAt: string | null;
  lastApplyError: string | null;
  severity: UpdateSeverity;
  /** MUST-7.3: the card receives this boolean and NOTHING else about Watchtower. */
  canApplyInApp: boolean;
  watchtowerError: string | null;
}

const initial: UpdateActionState = {};

const SEVERITY_BADGE: Record<Exclude<UpdateSeverity, 'none'>, string> = {
  patch: 'Patch update',
  minor: 'Minor update',
  major: 'Major update',
};

/** notify §11.4's amendment, and the app's ONE timestamp convention. No relative strings. */
function stamp(iso: string | null): string {
  return iso === null ? 'Never' : iso.slice(0, 16).replace('T', ' ');
}

export function UpdatesClient(props: UpdatesViewProps) {
  const [enableState, enable] = useActionState(async () => enableUpdateChecksAction(), initial);
  const [disableState, disable] = useActionState(async () => disableUpdateChecksAction(), initial);
  const [autoState, saveAuto] = useActionState(setAutoApplyAction, initial);
  const [checkState, checkNow] = useActionState(async () => checkForUpdateNowAction(), initial);
  const [applyState, apply] = useActionState(async (_prev: UpdateActionState, formData: FormData) => applyUpdateAction(formData), initial);
  const [dismissState, dismiss] = useActionState(async (_prev: UpdateActionState, formData: FormData) => dismissUpdateAction(formData), initial);
  const [review, runReview, reviewPending] = useActionState(
    async (_prev: ReviewUpdateState, formData: FormData) => reviewUpdateAction(formData),
    {} as ReviewUpdateState,
  );
  const [panelOpen, setPanelOpen] = useState(false);

  const messages = [enableState, disableState, autoState, checkState, applyState, dismissState];
  const message = messages.map((s) => s.message).find((m) => m !== undefined);
  const error = messages.map((s) => s.error).find((e) => e !== undefined) ?? review.error;

  // MUST-9.3: the off state. One button, no other control.
  if (!props.enabled) {
    return (
      <Card>
        <CardHeader title="Updates" description={`Budget Tracker v${props.currentVersion} · update checks are off.`} />
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            This app does not check for updates unless you ask it to. Switch this on and once a day it will ask GitHub
            whether a newer version of Budget Tracker has been published. That request carries the version you are
            running and nothing else — not your data, not your address, not how many people use this install.
          </p>
          <p className="text-sm text-muted">
            Small updates (bug fixes and new features) install themselves. A major version never does: you will be
            told, shown exactly what changed, and asked.
          </p>
          <FormError message={error} />
          <form action={enable}>
            <SubmitButton className="btn btn--primary">Enable update checks</SubmitButton>
          </form>
        </CardBody>
      </Card>
    );
  }

  const severity = props.severity;
  const offered = severity !== 'none' && props.latestVersion !== null ? props.latestVersion : null;
  const dismissed = offered !== null && props.dismissedVersion === offered;

  return (
    <Card>
      <CardHeader
        title="Updates"
        description={
          offered === null
            ? `Up to date (v${props.currentVersion})`
            : `Version ${offered} is available`
        }
        action={
          offered === null || severity === 'none' ? null : (
            <span className="badge badge--amber">{SEVERITY_BADGE[severity]}</span>
          )
        }
      />
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm text-subtle">
          Last checked {stamp(props.lastCheckedAt)}
          {props.latestPublishedAt === null ? null : ` · published ${stamp(props.latestPublishedAt)}`}
          {props.lastAppliedAt === null ? null : ` · last updated ${stamp(props.lastAppliedAt)}`}
        </p>

        {props.lastCheckError === null ? null : <Notice tone="error">{props.lastCheckError}</Notice>}
        {props.lastApplyError === null ? null : <Notice tone="error">{props.lastApplyError}</Notice>}
        {props.watchtowerError === null ? null : <Notice tone="error">{props.watchtowerError}</Notice>}
        <FormError message={error} />
        {message === undefined ? null : <Notice tone="success">{message}</Notice>}

        <div className="flex flex-wrap items-center gap-3">
          <form action={checkNow}>
            <SubmitButton className="btn btn--secondary">Check now</SubmitButton>
          </form>
          <form action={saveAuto} className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" name="autoApply" defaultChecked={props.autoApply} />
              Install small updates automatically
            </label>
            <SubmitButton className="btn btn--ghost btn--sm">Save</SubmitButton>
          </form>
          <form action={disable} className="ml-auto">
            <SubmitButton className="btn btn--ghost">Disable update checks</SubmitButton>
          </form>
        </div>

        {offered === null ? null : dismissed ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted">Version {offered} is available — you chose to skip it for now.</p>
            <form action={dismiss}>
              <input type="hidden" name="version" value="" />
              <SubmitButton className="btn btn--ghost btn--sm">Show again</SubmitButton>
            </form>
          </div>
        ) : !props.canApplyInApp ? (
          // MUST-7.8: the apply button is ABSENT, not disabled. A disabled button invites a
          // click and then explains itself, and there is nothing to explain away.
          // MUST-7.9: shipped verbatim. Every path and filename is plain text, never an
          // <a href>. It keeps the zero-egress claim trivially auditable and it survives a
          // screenshot.
          <Notice tone="info" title="This install updates by hand.">
            {/* Fix wave item 3: the old copy claimed "no Watchtower companion... cannot
                replace itself" for EVERY !canApplyInApp install, which is false for a
                pre-1.3.1 compose file — that install still has Watchtower, and it may still
                be auto-pulling on its old daily timer, just without an HTTP endpoint this
                app can ask on demand. The wording below covers both realities honestly
                instead of asserting the wrong one for whichever install actually has no
                trigger at all (build from source, a bare `npm start`). */}
            <p>
              This app has no way to trigger an update for itself here. That is expected if you built from source or
              run it with a bare <code>npm start</code>. If your compose file predates 1.3.1 instead, it does not
              have this trigger either — but it may still have Watchtower&apos;s old daily auto-pull running in the
              background regardless, quietly updating this container without asking. Check that container&apos;s
              logs if you want to be sure either way.
            </p>
            <p>
              To move to the new version by hand, run <code>./install/update.sh</code> on Linux, macOS, a Raspberry
              Pi, or Synology over SSH, or <code>.\install\update.ps1</code> on Windows. Both scripts tag a rollback
              point first and put it back automatically if the new version does not come up healthy.
            </p>
            <p>
              If you installed with the prebuilt image, you can switch to in-app updates instead by replacing your
              compose file with the current <code>install/synology-compose-pull.yml</code> — see INSTALL.md, "Moving
              to in-app updates".
            </p>
          </Notice>
        ) : severity === 'major' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <form action={runReview}>
                <input type="hidden" name="version" value={offered} />
                {/* Review fix (MED): panelOpen is set from onClick, an ordinary, urgent
                    event handler, rather than from inside the form's action. React does
                    not commit a state update made INSIDE a pending action/transition until
                    that action settles, so setting it there left the panel (and therefore
                    reviewPending's "Fetching release notes…" line) invisible for the whole
                    length of the fetch; onClick fires before the transition starts. */}
                <SubmitButton className="btn btn--primary" onClick={() => setPanelOpen(true)}>
                  Review and update
                </SubmitButton>
              </form>
              <form action={dismiss}>
                <input type="hidden" name="version" value={offered} />
                <SubmitButton className="btn btn--ghost">Not now</SubmitButton>
              </form>
            </div>
            {!panelOpen ? null : (
              <div className="flex flex-col gap-3 rounded-md border border-line px-4 py-4">
                <h3 className="text-sm font-semibold text-ink">What changed in {offered}</h3>
                {reviewPending ? (
                  // Review fix (MED): this used to be indistinguishable from a genuinely
                  // failed fetch, because panelOpen flips true and review.release is still
                  // undefined for the entire duration of the request. Every review would
                  // flash the "could not be fetched" sentence before the real notes arrived.
                  <p className="text-sm text-muted">Fetching release notes…</p>
                ) : review.release === undefined ? (
                  // MUST-9.6: a failed changelog read must not become a wall that stops an
                  // admin updating. The confirm button below is still offered.
                  <p className="text-sm text-muted">
                    The release notes for {offered} could not be fetched. You can read them on the project&apos;s
                    releases page before deciding.
                  </p>
                ) : (
                  review.release.groups.map((group) => (
                    <div key={group.title} className="flex flex-col gap-1.5">
                      <h4 className="eyebrow">{group.title}</h4>
                      <ul className="flex flex-col gap-1 text-sm text-muted">
                        {group.items.map((item, index) => (
                          <li key={index} className="flex gap-2">
                            <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                            <span>{renderEmphasis(item)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
                <Notice tone="warning">
                  This is a major version. Read the notes above before continuing. Your data is not touched by an
                  update — the database stays where it is and migrations run automatically when the new version
                  starts.
                </Notice>
                <div className="flex flex-wrap items-center gap-3">
                  <form action={apply}>
                    <input type="hidden" name="version" value={offered} />
                    {/* MUST-9.5: the version is in the LABEL, so a stale panel cannot install
                        something the reader did not read about. */}
                    <SubmitButton className="btn btn--primary">Install {offered}</SubmitButton>
                  </form>
                  <button type="button" className="btn btn--ghost" onClick={() => setPanelOpen(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <form action={apply}>
              <input type="hidden" name="version" value={offered} />
              <SubmitButton className="btn btn--primary">Update now</SubmitButton>
            </form>
            <form action={dismiss}>
              <input type="hidden" name="version" value={offered} />
              <SubmitButton className="btn btn--ghost">Not now</SubmitButton>
            </form>
          </div>
        )}

        {/* MUST-9.9: no spinner, no polling, no auto-reload. The container is going away; a
            page trying to poll it is a page showing a network error. */}
      </CardBody>
    </Card>
  );
}
