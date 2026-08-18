import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import {
  APPLY_CONFIRM_MAX_AGE_MS,
  clearUpdateState,
  dismissVersion,
  isUpdateCheckEnabled,
  readUpdateState,
  recordApplyOutcome,
  recordApplyRequested,
  recordCheckOutcome,
  reconcileApplyOnBoot,
  setAutoApply,
  setUpdateChecksEnabled,
} from '@/lib/update/state';
import { APP_VERSION } from '@/lib/version';

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
  vi.restoreAllMocks();
});

function updateRows(): { key: string; value: string }[] {
  return t.sqlite
    .prepare(`select key, value from settings where key like 'update.%' order by key`)
    .all() as { key: string; value: string }[];
}

describe('MUST-1.1 / MUST-3.1: absence is the off state', () => {
  it('a virgin database has no update. row at all', () => {
    expect(updateRows()).toEqual([]);
    expect(isUpdateCheckEnabled()).toBe(false);
  });

  it('MUST-3.3: readUpdateState on a virgin database is all-off and all-null', () => {
    expect(readUpdateState()).toEqual({
      enabled: false,
      enabledBy: null,
      enabledAt: null,
      autoApply: false,
      lastCheckedAt: null,
      lastCheckError: null,
      latestVersion: null,
      latestPublishedAt: null,
      dismissedVersion: null,
      applyRequestedVersion: null,
      applyRequestedAt: null,
      lastAppliedAt: null,
      lastApplyError: null,
    });
  });
});

describe('MUST-3.2: every key round-trips', () => {
  it('enable records the caller, the timestamp and the flag', () => {
    const userId = insertTestUser(t.db, { username: 'admin1' });
    setUpdateChecksEnabled({ enabled: true, userId, at: new Date('2026-08-17T10:00:00.000Z') });
    const state = readUpdateState();
    expect(state.enabled).toBe(true);
    expect(state.enabledBy).toBe(userId);
    expect(state.enabledAt).toBe('2026-08-17T10:00:00.000Z');
    // MUST-3.2: absent means ON, once checks are enabled.
    expect(state.autoApply).toBe(true);
  });

  it('the check outcome writes the stamp on success and on failure', () => {
    const userId = insertTestUser(t.db, { username: 'admin2' });
    setUpdateChecksEnabled({ enabled: true, userId });
    recordCheckOutcome({
      at: new Date('2026-08-17T10:00:00.000Z'),
      latestVersion: '1.4.0',
      publishedAt: '2026-08-16T09:00:00.000Z',
      error: null,
    });
    let state = readUpdateState();
    expect(state.lastCheckedAt).toBe('2026-08-17T10:00:00.000Z');
    expect(state.latestVersion).toBe('1.4.0');
    expect(state.latestPublishedAt).toBe('2026-08-16T09:00:00.000Z');
    expect(state.lastCheckError).toBeNull();

    recordCheckOutcome({ at: new Date('2026-08-18T10:00:00.000Z'), error: 'GitHub returned 500.' });
    state = readUpdateState();
    expect(state.lastCheckedAt).toBe('2026-08-18T10:00:00.000Z');
    expect(state.lastCheckError).toBe('GitHub returned 500.');
    // A failed check does NOT invent, and does not clear, a previously observed version.
    expect(state.latestVersion).toBe('1.4.0');
  });

  it('a check that finds nothing newer deletes the cached version', () => {
    const userId = insertTestUser(t.db, { username: 'admin3' });
    setUpdateChecksEnabled({ enabled: true, userId });
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0', publishedAt: '2026-08-16T09:00:00.000Z' });
    recordCheckOutcome({ at: new Date(), latestVersion: null, publishedAt: null });
    const state = readUpdateState();
    expect(state.latestVersion).toBeNull();
    expect(state.latestPublishedAt).toBeNull();
  });

  it('dismiss and the auto-apply toggle round-trip', () => {
    const userId = insertTestUser(t.db, { username: 'admin4' });
    setUpdateChecksEnabled({ enabled: true, userId });
    setAutoApply(false);
    dismissVersion('1.4.0');
    const state = readUpdateState();
    expect(state.autoApply).toBe(false);
    expect(state.dismissedVersion).toBe('1.4.0');
  });

  it('fix round finding 3: dismissVersion(\'\') deletes the key rather than writing an empty string', () => {
    const userId = insertTestUser(t.db, { username: 'admin4b' });
    setUpdateChecksEnabled({ enabled: true, userId });
    dismissVersion('1.4.0');
    expect(readUpdateState().dismissedVersion).toBe('1.4.0');

    dismissVersion('');
    expect(readUpdateState().dismissedVersion).toBeNull();
  });
});

describe('MUST-3.5: autoApply is forced false while disabled', () => {
  it('reports false even with the stored key saying on', () => {
    const userId = insertTestUser(t.db, { username: 'admin5' });
    setUpdateChecksEnabled({ enabled: true, userId });
    setAutoApply(true);
    expect(readUpdateState().autoApply).toBe(true);
    // Write the flag directly so the stale-key case is exercised without going through
    // clearUpdateState()'s wipe.
    t.sqlite.prepare(`update settings set value = '0' where key = 'update.checks_enabled'`).run();
    const state = readUpdateState();
    expect(state.enabled).toBe(false);
    expect(state.autoApply).toBe(false);
  });
});

describe('MUST-3.4: disabling wipes everything but the flag', () => {
  it('leaves exactly one update. row, checks_enabled = 0', () => {
    const userId = insertTestUser(t.db, { username: 'admin6' });
    setUpdateChecksEnabled({ enabled: true, userId });
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0', publishedAt: '2026-08-16T09:00:00.000Z' });
    dismissVersion('1.4.0');
    recordApplyRequested({ version: '1.4.0', at: new Date() });
    recordApplyOutcome({ at: new Date(), error: 'boom' });
    expect(updateRows().length).toBeGreaterThan(5);

    setUpdateChecksEnabled({ enabled: false, userId });
    expect(updateRows()).toEqual([{ key: 'update.checks_enabled', value: '0' }]);
    // Re-enabling starts clean: no cached version, no stale error, no dismissed memory.
    setUpdateChecksEnabled({ enabled: true, userId });
    const state = readUpdateState();
    expect(state.latestVersion).toBeNull();
    expect(state.dismissedVersion).toBeNull();
    expect(state.lastCheckError).toBeNull();
    expect(state.lastApplyError).toBeNull();
  });

  it('clearUpdateState() on its own leaves the same single row', () => {
    const userId = insertTestUser(t.db, { username: 'admin7' });
    setUpdateChecksEnabled({ enabled: true, userId });
    recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
    clearUpdateState();
    expect(updateRows()).toEqual([{ key: 'update.checks_enabled', value: '0' }]);
  });
});

describe('MUST-7.6: the boot reconciler closes the loop', () => {
  it('returns immediately when no apply was ever requested', () => {
    reconcileApplyOnBoot(new Date());
    expect(updateRows()).toEqual([]);
  });

  it('confirms a matching version and clears the pending state', () => {
    const userId = insertTestUser(t.db, { username: 'admin8' });
    setUpdateChecksEnabled({ enabled: true, userId });
    recordCheckOutcome({ at: new Date('2026-08-17T10:00:00.000Z'), latestVersion: APP_VERSION });
    recordApplyRequested({ version: APP_VERSION, at: new Date('2026-08-17T10:01:00.000Z') });
    reconcileApplyOnBoot(new Date('2026-08-17T10:03:00.000Z'));

    const state = readUpdateState();
    expect(state.lastAppliedAt).toBe('2026-08-17T10:03:00.000Z');
    expect(state.applyRequestedVersion).toBeNull();
    expect(state.applyRequestedAt).toBeNull();
    expect(state.lastApplyError).toBeNull();
    expect(state.latestVersion).toBeNull();
  });

  it('times out a stale request past 30 minutes and records why', () => {
    const userId = insertTestUser(t.db, { username: 'admin9' });
    setUpdateChecksEnabled({ enabled: true, userId });
    recordApplyRequested({ version: '9.9.9', at: new Date('2026-08-17T10:00:00.000Z') });
    const later = new Date(Date.parse('2026-08-17T10:00:00.000Z') + APPLY_CONFIRM_MAX_AGE_MS + 1000);
    reconcileApplyOnBoot(later);

    const state = readUpdateState();
    expect(state.applyRequestedVersion).toBeNull();
    expect(state.applyRequestedAt).toBeNull();
    expect(state.lastApplyError).toBe(
      `The update was requested but the app is still on ${APP_VERSION}. Check the Watchtower container's logs.`,
    );
  });

  it('leaves a FRESH mismatched request pending — a boot can precede the replacement', () => {
    const userId = insertTestUser(t.db, { username: 'admin10' });
    setUpdateChecksEnabled({ enabled: true, userId });
    recordApplyRequested({ version: '9.9.9', at: new Date('2026-08-17T10:00:00.000Z') });
    reconcileApplyOnBoot(new Date('2026-08-17T10:05:00.000Z'));

    const state = readUpdateState();
    expect(state.applyRequestedVersion).toBe('9.9.9');
    expect(state.applyRequestedAt).toBe('2026-08-17T10:00:00.000Z');
    expect(state.lastApplyError).toBeNull();
  });
});

describe('MUST-7.7: the reconciler never throws into the boot path', () => {
  it('swallows a database failure and logs it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.sqlite.prepare('drop table settings').run();
    expect(() => reconcileApplyOnBoot(new Date())).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
