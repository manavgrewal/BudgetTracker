import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { UPDATE_CHECK_INTERVAL_MS, dueForCheck, runUpdateCheck } from '@/lib/update/check';
import { setSetting } from '@/lib/settings';
import { APPLY_CONFIRM_MAX_AGE_MS } from '@/lib/update/state';
import { APPLY_MAX, resetUpdateRateLimitsForTests } from '@/lib/update/ratelimit';
import { classify, parseSemver } from '@/lib/update/semver';
import { readUpdateState, setAutoApply, setUpdateChecksEnabled } from '@/lib/update/state';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import { setNotifySenderForTests, resetNotifySenderForTests } from '@/lib/notify/send';
import { APP_VERSION } from '@/lib/version';

const realFetch = globalThis.fetch;
let githubCalls = 0;
let watchtowerCalls = 0;
let adminId = 0;
let t: TestDb;

const WATCHTOWER = { WATCHTOWER_URL: 'http://watchtower:8080/v1/update', WATCHTOWER_TOKEN: 'test-token-123' };

function stubRelease(tag: string, publishedAt: string | null = '2026-08-16T09:00:00Z'): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      githubCalls += 1;
      return new Response(JSON.stringify({ tag_name: tag, published_at: publishedAt }), { status: 200 });
    }
    watchtowerCalls += 1;
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

function withWatchtower(on: boolean): void {
  if (on) {
    process.env.WATCHTOWER_URL = WATCHTOWER.WATCHTOWER_URL;
    process.env.WATCHTOWER_TOKEN = WATCHTOWER.WATCHTOWER_TOKEN;
  } else {
    delete process.env.WATCHTOWER_URL;
    delete process.env.WATCHTOWER_TOKEN;
  }
}

function outboxRows(): { event_id: string; dedup_key: string; user_id: number }[] {
  return t.sqlite
    .prepare(`select event_id, dedup_key, user_id from notification_outbox order by id`)
    .all() as { event_id: string; dedup_key: string; user_id: number }[];
}

beforeEach(() => {
  t = createTestDb();
  githubCalls = 0;
  watchtowerCalls = 0;
  // Fix round finding 4: the apply rate-limit bucket is now consulted from inside
  // runUpdateCheck's auto-apply branch, so it must be reset per test the same way the DB is —
  // otherwise an earlier test's successful auto-apply would silently eat into this one's quota.
  resetUpdateRateLimitsForTests();
  adminId = insertTestUser(t.db, { username: 'admin', role: 'admin' });
  setUpdateChecksEnabled({ enabled: true, userId: adminId });
  // A configured channel, so an enqueue actually produces a row (notify MUST-4.2).
  saveSmtp({
    preset: 'custom', host: 'localhost', port: 25, security: 'none', username: 'u',
    password: 'p', fromEmail: 'a@b.com', fromName: 'BT', enabled: true,
  });
  saveEmailTarget({ userId: adminId, destination: 'admin@example.com', enabled: true });
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  withWatchtower(false);
  resetNotifySenderForTests();
  resetUpdateRateLimitsForTests();
  t.cleanup();
  vi.restoreAllMocks();
});

describe('MUST-5.5: dueForCheck counts from every attempt', () => {
  it('is due with no stamp, not due at 23 hours, due at 25', () => {
    const now = new Date('2026-08-18T12:00:00.000Z');
    expect(dueForCheck(null, now)).toBe(true);
    expect(dueForCheck(new Date(now.getTime() - 23 * 3_600_000).toISOString(), now)).toBe(false);
    expect(dueForCheck(new Date(now.getTime() - 25 * 3_600_000).toISOString(), now)).toBe(true);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(86_400_000);
  });
});

describe('MUST-5.7: the five outcomes', () => {
  it('none — deletes the cached version and does nothing else', async () => {
    stubRelease(`v${APP_VERSION}`);
    const result = await runUpdateCheck({ now: new Date() });
    expect(result).toMatchObject({ severity: 'none', latestVersion: null, applied: false, notified: false });
    expect(readUpdateState().latestVersion).toBeNull();
    expect(outboxRows()).toEqual([]);
  });

  it('patch with auto-apply on and Watchtower present — applies, and enqueues NOTHING', async () => {
    withWatchtower(true);
    setAutoApply(true);
    stubRelease(`v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`);
    const result = await runUpdateCheck({ now: new Date() });
    expect(result.severity).toBe('patch');
    expect(result.applied).toBe(true);
    expect(result.notified).toBe(false);
    expect(watchtowerCalls).toBe(1);
    expect(outboxRows()).toEqual([]);
  });

  it('minor with auto-apply on and Watchtower present — applies, and enqueues NOTHING', async () => {
    withWatchtower(true);
    setAutoApply(true);
    stubRelease(`v${APP_VERSION.split('.')[0]}.${Number(APP_VERSION.split('.')[1]) + 1}.0`);
    const result = await runUpdateCheck({ now: new Date() });
    expect(result.severity).toBe('minor');
    expect(result.applied).toBe(true);
    expect(result.notified).toBe(false);
    expect(watchtowerCalls).toBe(1);
    expect(outboxRows()).toEqual([]);
  });

  it('patch with auto-apply OFF — enqueues update_available and applies nothing', async () => {
    withWatchtower(true);
    setAutoApply(false);
    stubRelease(`v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`);
    const result = await runUpdateCheck({ now: new Date() });
    expect(result.applied).toBe(false);
    expect(result.notified).toBe(true);
    expect(watchtowerCalls).toBe(0);
    expect(outboxRows().map((r) => r.event_id)).toContain('update_available');
  });

  it('patch with NO Watchtower — enqueues, and the body says the install cannot update itself', async () => {
    withWatchtower(false);
    setAutoApply(true);
    stubRelease(`v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`);
    const result = await runUpdateCheck({ now: new Date() });
    expect(result.applied).toBe(false);
    expect(result.notified).toBe(true);
    expect(watchtowerCalls).toBe(0);
    const body = t.sqlite.prepare(`select body from notification_outbox limit 1`).get() as { body: string };
    expect(body.body).toContain('cannot update itself');
  });

  it('MUST-5.8 / AC8: a major NEVER applies, under any combination of settings', async () => {
    for (const auto of [true, false]) {
      for (const watchtower of [true, false]) {
        watchtowerCalls = 0;
        withWatchtower(watchtower);
        setUpdateChecksEnabled({ enabled: true, userId: adminId });
        setAutoApply(auto);
        stubRelease(`v${Number(APP_VERSION.split('.')[0]) + 1}.0.0`);
        const result = await runUpdateCheck({ now: new Date() });
        expect(result.severity, `auto=${auto} watchtower=${watchtower}`).toBe('major');
        expect(result.applied).toBe(false);
        expect(watchtowerCalls).toBe(0);
      }
    }
  });

  it('documents classify()\'s own property over 200 generated pairs: major severity implies remote.major > current.major', () => {
    // NOT an AC8 proof by itself — classify() never touches Watchtower, so this can't show
    // zero requests on its own. It pins the classifier's definition (semver.test.ts owns the
    // full contract); the test below is what actually exercises the Watchtower call count.
    const current = parseSemver(APP_VERSION)!;
    let majors = 0;
    for (let i = 0; i < 200; i += 1) {
      const remote = {
        major: current.major + (i % 3),
        minor: (i * 7) % 12,
        patch: (i * 13) % 20,
      };
      if (classify(current, remote) === 'major') {
        majors += 1;
        expect(remote.major).toBeGreaterThan(current.major);
      }
    }
    expect(majors).toBeGreaterThan(0);
  });

  it('AC8: a spread of generated major pairs run through the REAL check make zero Watchtower calls', async () => {
    withWatchtower(true);
    setAutoApply(true);
    const current = parseSemver(APP_VERSION)!;
    let checked = 0;
    for (let i = 0; i < 12; i += 1) {
      const remote = { major: current.major + 1 + (i % 3), minor: (i * 7) % 12, patch: (i * 13) % 20 };
      expect(classify(current, remote)).toBe('major');
      watchtowerCalls = 0;
      stubRelease(`v${remote.major}.${remote.minor}.${remote.patch}`);
      const result = await runUpdateCheck({ now: new Date() });
      expect(result.severity, `pair ${JSON.stringify(remote)}`).toBe('major');
      expect(result.applied).toBe(false);
      expect(watchtowerCalls).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(12);
  });
});

describe('MUST-5.5 / MUST-5.9: the stamp and the dismissal', () => {
  it('writes last_checked_at on a FAILED check', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const at = new Date('2026-08-18T12:00:00.000Z');
    const result = await runUpdateCheck({ now: at });
    expect(result.error).toContain('500');
    expect(readUpdateState().lastCheckedAt).toBe(at.toISOString());
    expect(readUpdateState().lastCheckError).toContain('500');
  });

  it('a second check at the same version enqueues nothing new', async () => {
    withWatchtower(false);
    setAutoApply(false);
    const next = `v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`;
    stubRelease(next);
    await runUpdateCheck({ now: new Date('2026-08-18T12:00:00.000Z') });
    const first = outboxRows().length;
    await runUpdateCheck({ now: new Date('2026-08-19T12:00:00.000Z'), manual: true });
    expect(outboxRows().length).toBe(first);
    expect(outboxRows()[0]!.dedup_key).toBe(`update:${next.slice(1)}`);
  });
});

describe('Fix round finding 4: the APPLY bucket bounds the internal auto-apply path too', () => {
  it('auto-apply on, 5 rapid manual checks — Watchtower is triggered at most APPLY_MAX times', async () => {
    withWatchtower(true);
    setAutoApply(true);
    const next = `v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`;
    stubRelease(next);

    for (let i = 0; i < 5; i += 1) {
      await runUpdateCheck({ now: new Date(), manual: true });
    }

    // Without the internal gate, a spammed Check-now button would drive one real
    // /v1/update request per call — five, here — against a container that is (once the
    // first one lands) already mid-replacement.
    expect(watchtowerCalls).toBeLessThanOrEqual(APPLY_MAX);
    expect(watchtowerCalls).toBe(APPLY_MAX);
  });

  it('a rate-limited auto-apply attempt falls through to the notify path rather than erroring', async () => {
    withWatchtower(true);
    setAutoApply(true);
    const next = `v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`;
    stubRelease(next);

    for (let i = 0; i < APPLY_MAX; i += 1) {
      const result = await runUpdateCheck({ now: new Date(), manual: true });
      expect(result.applied).toBe(true);
    }
    const refused = await runUpdateCheck({ now: new Date(), manual: true });
    expect(refused.applied).toBe(false);
    expect(refused.error).toBeNull();
    expect(refused.notified).toBe(true);
    expect(watchtowerCalls).toBe(APPLY_MAX);
  });
});

/**
 * Final pre-tag fix wave, MEDIUM: Watchtower 2xx-"accepts" a request even when it replaces
 * nothing at all -- a pinned image tag is the concrete case, since Watchtower only ever
 * replaces a container when a NEWER image actually lands for the tag it is running. Before
 * this fix, that acceptance got recorded as `update.last_applied_at` (check.ts's
 * recordApplyOutcome call, now emptied of that write), which permanently suppressed the
 * `update_available` notification (MUST-5.7's "no notification, the container is about to be
 * replaced" branch) even though the container never actually changed, and re-fired the same
 * no-op Watchtower request once a day forever.
 */
describe('Fix wave item 1: the pinned-tag scenario -- acceptance is not application', () => {
  it('end to end: accepted -> still on the old version past the 30-minute window -> honest error -> notification fires -> the next tick does NOT re-trigger', async () => {
    withWatchtower(true);
    setAutoApply(true);
    const next = `v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`;
    stubRelease(next);

    // Day 1: the tick fires the apply. Watchtower 2xx-accepts it (the compose pins its tag,
    // so nothing is actually replaced), and the app -- correctly, per MUST-5.7 -- raises no
    // notification, because from here it looks exactly like an update in flight.
    const day1 = await runUpdateCheck({ now: new Date('2026-08-18T00:00:00.000Z') });
    expect(day1).toMatchObject({ severity: 'patch', applied: true, notified: false });
    expect(watchtowerCalls).toBe(1);
    let state = readUpdateState();
    expect(state.applyRequestedVersion).toBe(next.slice(1));
    expect(state.lastAppliedAt).toBeNull(); // fix wave item 1(a): acceptance never wrote this.

    // Day 2: still on the same version (APP_VERSION never changed -- the container never
    // rebooted), and well past the reconciler's 30-minute window. This tick's OWN
    // reconcilePendingApply call is what finally notices, since a boot that will never
    // happen could not have.
    const day2At = new Date(Date.parse('2026-08-18T00:00:00.000Z') + APPLY_CONFIRM_MAX_AGE_MS + 60_000);
    const day2 = await runUpdateCheck({ now: day2At });
    expect(day2.applied).toBe(false);
    expect(day2.notified).toBe(true);
    // The honest failure, via the SAME last_apply_error path the card already renders.
    state = readUpdateState();
    expect(state.applyRequestedVersion).toBeNull();
    expect(state.lastAppliedAt).toBeNull();
    expect(state.lastApplyError).toContain(`still on ${APP_VERSION}`);
    expect(state.lastApplyFailedVersion).toBe(next.slice(1));
    // Fix wave item 1(c): NOT re-triggered -- still exactly the one call from day 1.
    expect(watchtowerCalls).toBe(1);
    expect(outboxRows().map((r) => r.event_id)).toContain('update_available');

    // Day 3: same version still offered. Auto-apply stays skipped; still no second call.
    const day3 = await runUpdateCheck({ now: new Date('2026-08-20T00:00:00.000Z') });
    expect(day3.applied).toBe(false);
    expect(watchtowerCalls).toBe(1);
  });

  it('the normal path is unaffected: a version that DOES change is confirmed and stamped, not skipped', async () => {
    withWatchtower(true);
    setAutoApply(true);
    // Simulate "the boot after the replacement" the way state.test.ts's reconciler tests do:
    // offer the version the app is ALREADY running, so reconcilePendingApply's "does the
    // requested version match APP_VERSION" branch is the one that fires.
    setSetting('update.apply_requested_version', APP_VERSION);
    setSetting('update.apply_requested_at', new Date('2026-08-18T00:00:00.000Z').toISOString());

    stubRelease(`v${APP_VERSION}`); // severity 'none' this tick -- the reconciler runs regardless.
    const result = await runUpdateCheck({ now: new Date('2026-08-18T00:05:00.000Z') });
    expect(result.severity).toBe('none');

    const state = readUpdateState();
    expect(state.lastAppliedAt).toBe('2026-08-18T00:05:00.000Z');
    expect(state.applyRequestedVersion).toBeNull();
    expect(state.lastApplyFailedVersion).toBeNull();
    expect(watchtowerCalls).toBe(0);
  });
});
