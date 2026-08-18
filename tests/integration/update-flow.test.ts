import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { runUpdateCheck } from '@/lib/update/check';
import { resetUpdateRateLimitsForTests } from '@/lib/update/ratelimit';
import { setAutoApply } from '@/lib/update/state';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { runUpdateTick, startScheduler, stopScheduler } from '@/lib/scheduler';
import { APP_VERSION } from '@/lib/version';

/**
 * MUST-19.6 / AC4 / AC8: the whole update feature, end to end, against a real (temp-file)
 * SQLite db and a stubbed fetch -- dormant, then enabled, then a patch that auto-applies, a
 * major that never does, the review/apply actions, and disabled again.
 */

const sameOrigin = vi.hoisted(() => ({ value: true }));
const currentUser = vi.hoisted(() => ({ value: { id: 0, name: 'Sam', username: 'sam', role: 'admin' as 'admin' | 'member' } }));

vi.mock('next/headers', () => ({
  headers: async () => (sameOrigin.value ? new Headers({ host: 'budget.local', origin: 'http://budget.local' }) : new Headers({ host: 'budget.local' })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
  requireAdmin: async () => currentUser.value,
}));

const actions = await import('@/app/(app)/settings/actions');

const DAY = 24 * 60 * 60 * 1000;
const realFetch = globalThis.fetch;

let t: TestDb;
let adminId = 0;
let fetchCalls: string[] = [];
let watchtowerCalls = 0;
let releaseTag = '';
let releasePublishedAt: string | null = '2026-08-16T09:00:00Z';
let changelogMarkdown = '';

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

/** major/minor/patch bump helpers, so the probe stays correct if APP_VERSION ever moves. */
function patchOf(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}
function majorOf(version: string): string {
  const [major] = version.split('.').map(Number);
  return `${major + 1}.0.0`;
}

function stubRelease(tag: string, publishedAt: string | null = '2026-08-16T09:00:00Z'): void {
  releaseTag = tag;
  releasePublishedAt = publishedAt;
}
function stubChangelog(markdown: string): void {
  changelogMarkdown = markdown;
}
function lastFetchUrl(): string {
  return fetchCalls[fetchCalls.length - 1] ?? '';
}
function withWatchtower(on: boolean): void {
  if (on) {
    process.env.WATCHTOWER_URL = 'http://watchtower:8080/v1/update';
    process.env.WATCHTOWER_TOKEN = 'a-fine-token-value-long-enough';
  } else {
    delete process.env.WATCHTOWER_URL;
    delete process.env.WATCHTOWER_TOKEN;
  }
}
function outboxRows(): { event_id: string; user_id: number }[] {
  return t.sqlite.prepare(`select event_id, user_id from notification_outbox order by id`).all() as { event_id: string; user_id: number }[];
}
function updateSettingsRows(): { key: string; value: string }[] {
  return t.sqlite.prepare(`select key, value from settings where key like 'update.%' order by key`).all() as { key: string; value: string }[];
}

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.includes('/contents/CHANGELOG.md')) {
      const content = Buffer.from(changelogMarkdown, 'utf8').toString('base64');
      return new Response(JSON.stringify({ encoding: 'base64', size: changelogMarkdown.length, content }), { status: 200 });
    }
    if (url.includes('/releases/latest')) {
      return new Response(JSON.stringify({ tag_name: releaseTag, published_at: releasePublishedAt }), { status: 200 });
    }
    watchtowerCalls += 1;
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  t = createTestDb();
  adminId = insertTestUser(t.db, { username: 'admin', role: 'admin' });
  currentUser.value = { id: adminId, name: 'Sam', username: 'sam', role: 'admin' };
  sameOrigin.value = true;
  fetchCalls = [];
  watchtowerCalls = 0;
  releaseTag = '';
  releasePublishedAt = '2026-08-16T09:00:00Z';
  changelogMarkdown = '';
  resetUpdateRateLimitsForTests();
  installFetch();
  // A configured channel, so update_available actually produces an outbox row (notify MUST-4.2).
  saveSmtp({
    preset: 'custom',
    host: 'localhost',
    port: 25,
    security: 'none',
    username: 'u',
    password: 'p',
    fromEmail: 'a@b.com',
    fromName: 'BT',
    enabled: true,
  });
  saveEmailTarget({ userId: adminId, destination: 'admin@example.com', enabled: true });
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  stopScheduler();
  globalThis.fetch = realFetch;
  withWatchtower(false);
  resetNotifySenderForTests();
  resetUpdateRateLimitsForTests();
  t.cleanup();
  vi.restoreAllMocks();
});

it('MUST-19.6: dormant -> enabled -> patch auto-applies -> major never does -> disabled', async () => {
  const base = new Date('2026-08-18T00:00:00.000Z').getTime();

  // 1. Checks disabled: a boot plus twelve simulated ticks perform ZERO fetches (AC4).
  startScheduler();
  for (let i = 0; i < 12; i += 1) runUpdateTick(new Date(base + i * 5 * 60_000));
  expect(fetchCalls).toHaveLength(0);
  stopScheduler();

  // 2. Enable. One tick fetches once; a second within 24 hours fetches nothing.
  await actions.enableUpdateChecksAction();
  stubRelease(`v${APP_VERSION}`);
  runUpdateTick(new Date(base));
  await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
  runUpdateTick(new Date(base + 60_000));
  expect(fetchCalls).toHaveLength(1);

  // 3. A patch release with auto-apply on fires exactly ONE Watchtower request and enqueues
  //    no notification -- the container is about to be replaced.
  withWatchtower(true);
  setAutoApply(true);
  stubRelease(`v${patchOf(APP_VERSION)}`);
  const patch = await runUpdateCheck({ now: new Date(base + DAY), manual: true });
  expect(patch).toMatchObject({ severity: 'patch', applied: true, notified: false });
  expect(watchtowerCalls).toBe(1);
  expect(outboxRows()).toEqual([]);

  // 4. A major fires NO Watchtower request and enqueues one update_available, for the admin
  //    only (AC8, MUST-5.8, MUST-4.3).
  watchtowerCalls = 0;
  stubRelease(`v${majorOf(APP_VERSION)}`);
  const major = await runUpdateCheck({ now: new Date(base + 2 * DAY), manual: true });
  expect(major).toMatchObject({ severity: 'major', applied: false, notified: true });
  expect(watchtowerCalls).toBe(0);
  expect(outboxRows().map((r) => r.user_id)).toEqual([adminId]);

  // 5. The review action fetches the changelog pinned to that version's tag...
  const offeredVersion = majorOf(APP_VERSION);
  stubChangelog(`## [${offeredVersion}] - 2026-09-01\n\n### Changed\n\n- Everything.\n`);
  const reviewed = await actions.reviewUpdateAction(form({ version: offeredVersion }));
  expect(lastFetchUrl()).toContain(`?ref=v${offeredVersion}`);
  expect(reviewed.release?.groups[0]?.items[0]).toBe('Everything.');

  // 6. ...and the apply action refuses a stale version.
  const applyStale = await actions.applyUpdateAction(form({ version: '0.0.1' }));
  expect(applyStale.error).toContain('no longer the one on offer');

  // 7. Disable: the state is cleared and further ticks fetch nothing (MUST-3.4, MUST-1.1).
  await actions.disableUpdateChecksAction();
  const before = fetchCalls.length;
  for (let i = 0; i < 12; i += 1) runUpdateTick(new Date(base + 3 * DAY + i * 5 * 60_000));
  expect(fetchCalls.length).toBe(before);
  expect(updateSettingsRows()).toEqual([{ key: 'update.checks_enabled', value: '0' }]);
});
