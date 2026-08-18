import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { UPDATE_CHECK_INTERVAL_MS, dueForCheck, runUpdateCheck } from '@/lib/update/check';
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
