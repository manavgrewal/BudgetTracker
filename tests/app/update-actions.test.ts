import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { readUpdateState, recordCheckOutcome } from '@/lib/update/state';
import { APPLY_MAX, CHECK_NOW_MAX, checkUpdateApply, resetUpdateRateLimitsForTests } from '@/lib/update/ratelimit';
import { APP_VERSION } from '@/lib/version';

const sameOrigin = vi.hoisted(() => ({ value: true }));
const currentUser = vi.hoisted(() => ({ value: { id: 0, name: 'Sam', username: 'sam', role: 'admin' as 'admin' | 'member' } }));
const requireAdminState = vi.hoisted(() => ({ calls: 0 }));

vi.mock('next/headers', () => ({
  headers: async () =>
    sameOrigin.value
      ? new Headers({ host: 'budget.local', origin: 'http://budget.local' })
      : new Headers({ host: 'budget.local', origin: 'http://evil.example' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
  requireAdmin: async () => {
    requireAdminState.calls += 1;
    // Real requireAdmin() calls next/navigation's redirect(), which throws a
    // NEXT_REDIRECT-shaped error rather than returning — this mock throws the same shape
    // so a member is proven to never reach the domain call, not merely to receive an error.
    if (currentUser.value.role !== 'admin') throw new Error('redirect to /dashboard');
    return currentUser.value;
  },
}));

const actions = await import('@/app/(app)/settings/actions');

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let t: TestDb;

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

/** Routes GitHub calls to a fixed tag; anything else (e.g. a stray Watchtower call) gets a bare 200. */
function stubRelease(tag: string): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify({ tag_name: tag, published_at: '2026-08-16T09:00:00Z' }), { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

/** Every request (Watchtower or otherwise) gets the given status. */
function stubWatchtower(status: number): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return new Response('', { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  t = createTestDb();
  currentUser.value = { id: insertTestUser(t.db, { role: 'admin', username: 'sam', name: 'Sam' }), name: 'Sam', username: 'sam', role: 'admin' };
  sameOrigin.value = true;
  requireAdminState.calls = 0;
  fetchCalls = [];
  resetUpdateRateLimitsForTests();
  delete process.env.WATCHTOWER_URL;
  delete process.env.WATCHTOWER_TOKEN;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WATCHTOWER_URL;
  delete process.env.WATCHTOWER_TOKEN;
  resetUpdateRateLimitsForTests();
  t.cleanup();
});

describe('MUST-10.2 / MUST-10.4: origin and role, in that order', () => {
  it('all seven actions reject a cross-origin request BEFORE anything else', async () => {
    sameOrigin.value = false;
    const results = [
      await actions.enableUpdateChecksAction(),
      await actions.disableUpdateChecksAction(),
      await actions.setAutoApplyAction({}, form({ autoApply: 'on' })),
      await actions.checkForUpdateNowAction(),
      await actions.reviewUpdateAction(form({ version: '1.4.0' })),
      await actions.applyUpdateAction(form({ version: '1.4.0' })),
      await actions.dismissUpdateAction(form({ version: '1.4.0' })),
    ];
    for (const result of results) expect(result.error).toBe('Cross-origin request rejected');
    expect(fetchCalls).toHaveLength(0);
    expect(requireAdminState.calls).toBe(0);
  });

  it('every action goes through requireAdmin, so a member never reaches the domain call', async () => {
    currentUser.value.role = 'member';
    await expect(actions.enableUpdateChecksAction()).rejects.toThrow(/redirect/);
    await expect(actions.applyUpdateAction(form({ version: '1.4.0' }))).rejects.toThrow(/redirect/);
  });

  it('fix round finding 1: all seven actions reject a member, with zero state change', async () => {
    // A settings-row snapshot rather than one field, so ANY write by ANY of the seven —
    // not just the ones this suite happens to assert on individually — would fail this.
    const rowCount = (): number => (t.sqlite.prepare(`select count(*) as n from settings`).get() as { n: number }).n;
    currentUser.value.role = 'member';
    const before = rowCount();

    await expect(actions.enableUpdateChecksAction()).rejects.toThrow(/redirect/);
    await expect(actions.disableUpdateChecksAction()).rejects.toThrow(/redirect/);
    await expect(actions.setAutoApplyAction({}, form({ autoApply: 'on' }))).rejects.toThrow(/redirect/);
    await expect(actions.checkForUpdateNowAction()).rejects.toThrow(/redirect/);
    await expect(actions.reviewUpdateAction(form({ version: '1.4.0' }))).rejects.toThrow(/redirect/);
    await expect(actions.applyUpdateAction(form({ version: '1.4.0' }))).rejects.toThrow(/redirect/);
    await expect(actions.dismissUpdateAction(form({ version: '1.4.0' }))).rejects.toThrow(/redirect/);

    expect(rowCount()).toBe(before);
    expect(fetchCalls).toHaveLength(0);
  });

  it('MUST-10.3: no action accepts a userId', async () => {
    const other = insertTestUser(t.db, { username: 'other', role: 'admin' });
    await actions.enableUpdateChecksAction();
    expect(readUpdateState().enabledBy).toBe(currentUser.value.id);
    expect(readUpdateState().enabledBy).not.toBe(other);
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    // The forged field is simply never read.
    await actions.dismissUpdateAction(form({ version: '1.4.0', userId: String(other) }));
    expect(readUpdateState().dismissedVersion).toBe('1.4.0');
  });
});

describe("MUST-9.7: a stale version is refused against the server's own state", () => {
  it('applyUpdateAction refuses a version that is not update.latest_version', async () => {
    await actions.enableUpdateChecksAction();
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    const result = await actions.applyUpdateAction(form({ version: '1.3.9' }));
    expect(result.error).toBe('That version is no longer the one on offer. Press Check now and read the notes again.');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('Fix round finding 2 / 3: dismissUpdateAction hygiene', () => {
  it('refuses to pre-dismiss a version that is not update.latest_version', async () => {
    await actions.enableUpdateChecksAction();
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    const result = await actions.dismissUpdateAction(form({ version: '1.5.0' }));
    expect(result.error).toBe('That version is no longer the one on offer. Press Check now and read the notes again.');
    expect(readUpdateState().dismissedVersion).toBeNull();
  });

  it('"Show again" (an empty version) deletes the key rather than writing an empty string', async () => {
    await actions.enableUpdateChecksAction();
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    await actions.dismissUpdateAction(form({ version: '1.4.0' }));
    expect(readUpdateState().dismissedVersion).toBe('1.4.0');

    await actions.dismissUpdateAction(form({}));
    expect(readUpdateState().dismissedVersion).toBeNull();
    const row = t.sqlite.prepare(`select value from settings where key = 'update.dismissed_version'`).get();
    expect(row).toBeUndefined();
  });
});

describe('MUST-10.9 / MUST-10.10: a rate-limited action performs no egress', () => {
  it('the sixth Check now returns the wait message and fetches nothing', async () => {
    await actions.enableUpdateChecksAction();
    stubRelease(`v${APP_VERSION}`);
    for (let i = 0; i < CHECK_NOW_MAX; i += 1) await actions.checkForUpdateNowAction();
    const before = fetchCalls.length;
    const refused = await actions.checkForUpdateNowAction();
    expect(refused.error).toMatch(/^Too many attempts\. Try again in \d+ minutes\.$/);
    expect(fetchCalls.length).toBe(before);
  });

  it('Update now with no Watchtower burns no apply quota', async () => {
    delete process.env.WATCHTOWER_URL;
    await actions.enableUpdateChecksAction();
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    for (let i = 0; i < APPLY_MAX + 2; i += 1) {
      const result = await actions.applyUpdateAction(form({ version: '1.4.0' }));
      expect(result.error).toBe('This install has no Watchtower companion to ask.');
    }
    // The bucket is untouched, so a properly configured install still has all three.
    expect(checkUpdateApply().allowed).toBe(true);
  });
});

describe('MUST-7.3 / AC7: no returned state contains a token substring', () => {
  it('a 401 from Watchtower returns the fixed sentence and nothing of the token', async () => {
    process.env.WATCHTOWER_URL = 'http://watchtower:8080/v1/update';
    process.env.WATCHTOWER_TOKEN = 'super-secret-token-value';
    await actions.enableUpdateChecksAction();
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    stubWatchtower(401);
    const result = await actions.applyUpdateAction(form({ version: '1.4.0' }));
    expect(result.error).toBe(
      'Watchtower rejected the token. Check that WATCHTOWER_TOKEN matches WATCHTOWER_HTTP_API_TOKEN in your compose file.',
    );
    expect(JSON.stringify(result)).not.toContain('super-secret-token-value');
    expect(readUpdateState().lastApplyError).not.toContain('super-secret-token-value');
  });
});

describe('WATCH ITEM (Task 5 review): no action response ever echoes the configured Watchtower token', () => {
  it('greps every one of the seven actions\' JSON responses for the token substring', async () => {
    process.env.WATCHTOWER_URL = 'http://watchtower:8080/v1/update';
    process.env.WATCHTOWER_TOKEN = 'super-secret-token-value';

    const responses: unknown[] = [];

    responses.push(await actions.enableUpdateChecksAction());

    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    responses.push(await actions.setAutoApplyAction({}, form({ autoApply: 'on' })));

    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    stubRelease('v1.4.0');
    responses.push(await actions.reviewUpdateAction(form({ version: '1.4.0' })));

    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    stubWatchtower(401);
    responses.push(await actions.applyUpdateAction(form({ version: '1.4.0' })));

    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    stubRelease(`v${APP_VERSION}`);
    responses.push(await actions.checkForUpdateNowAction());

    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    responses.push(await actions.dismissUpdateAction(form({ version: '1.4.0' })));
    responses.push(await actions.disableUpdateChecksAction());

    expect(responses).toHaveLength(7);
    for (const result of responses) {
      const json = JSON.stringify(result);
      expect(json).not.toContain('super-secret-token-value');
      expect(json ?? '').not.toMatch(/Bearer\s+\S+/);
    }
  });
});

describe('MUST-3.4: disable leaves exactly one update. settings row', () => {
  it('wipes the cache, the error and the dismissal', async () => {
    await actions.enableUpdateChecksAction();
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    await actions.dismissUpdateAction(form({ version: '1.4.0' }));
    await actions.disableUpdateChecksAction();
    const rows = t.sqlite.prepare(`select key, value from settings where key like 'update.%'`).all();
    expect(rows).toEqual([{ key: 'update.checks_enabled', value: '0' }]);
  });
});
