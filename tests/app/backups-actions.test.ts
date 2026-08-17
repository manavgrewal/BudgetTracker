import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const headerBag = { value: new Headers() };
vi.mock('next/headers', () => ({ headers: async () => headerBag.value }));

const requireAdmin = vi.fn(async () => ({ id: 3, username: 'meena', role: 'admin' as const }));
vi.mock('@/lib/auth/session', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const stageRestore = vi.fn();
vi.mock('@/lib/backup/restore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backup/restore')>()),
  stageRestore: (...args: unknown[]) => stageRestore(...args),
}));

import { stageRestoreAction } from '@/app/(app)/settings/backups/actions';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const sameOrigin = () => new Headers({ host: 'nas.local:3000', origin: 'http://nas.local:3000' });

beforeEach(() => {
  headerBag.value = sameOrigin();
  requireAdmin.mockClear();
  stageRestore.mockReset();
  stageRestore.mockReturnValue({
    sourceName: 'budget-2026-08-16.tar.gz',
    kind: 'archive',
    bytes: 4_194_304,
    sha256: '0'.repeat(64),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('MUST-20.36: stageRestoreAction gate order', () => {
  it('rejects a cross-origin request before reading anything from disk', async () => {
    headerBag.value = new Headers({ host: 'nas.local:3000', origin: 'http://evil.example' });
    const spy = vi.spyOn(fs, 'existsSync');
    const state = await stageRestoreAction({}, form({ name: 'budget-2026-08-16.tar.gz', confirm: 'on' }));
    expect(state.error).toBe('Cross-origin request rejected');
    expect(requireAdmin).not.toHaveBeenCalled();
    expect(stageRestore).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled(); // the gate really is FIRST
  });

  it('refuses a non-admin caller', async () => {
    requireAdmin.mockRejectedValueOnce(new Error('not admin'));
    const state = await stageRestoreAction({}, form({ name: 'budget-2026-08-16.tar.gz', confirm: 'on' }));
    expect(state.error).toBeDefined();
    expect(stageRestore).not.toHaveBeenCalled();
  });

  it.each([
    ['../../etc/passwd'],
    ['/etc/passwd'],
    ['budget-2026-08-16.tar.gz.bak'],
    ['budget-2026-08-16.tar.gz.partial'],
    ['not-a-backup'],
    [''],
  ])('refuses the filename %j', async (name) => {
    const state = await stageRestoreAction({}, form({ name, confirm: 'on' }));
    expect(state.error).toMatch(/backup/i);
    expect(stageRestore).not.toHaveBeenCalled();
  });

  it('refuses when the confirmation box was not ticked', async () => {
    const state = await stageRestoreAction({}, form({ name: 'budget-2026-08-16.tar.gz' }));
    expect(state.error).toMatch(/confirm/i);
    expect(stageRestore).not.toHaveBeenCalled();
  });

  it('turns a RestoreError into a written message, not a stack trace', async () => {
    const { RestoreError } = await import('../../scripts/restore-core.ts');
    stageRestore.mockImplementation(() => {
      throw new RestoreError('That backup is empty. Nothing was changed.');
    });
    const state = await stageRestoreAction({}, form({ name: 'budget-2026-08-16.tar.gz', confirm: 'on' }));
    expect(state.error).toBe('That backup is empty. Nothing was changed.');
    expect(state.restarting).toBeFalsy();
  });

  it('MUST-20.10: refuses a second stage while one is already staged/applying, and arms no timer', async () => {
    const { RestoreError } = await import('../../scripts/restore-core.ts');
    stageRestore.mockImplementation(() => {
      throw new RestoreError('A restore is already staged; restart the app to apply it.');
    });
    vi.useFakeTimers();
    try {
      const state = await stageRestoreAction({}, form({ name: 'budget-2026-08-16.tar.gz', confirm: 'on' }));
      expect(state.error).toBe('A restore is already staged; restart the app to apply it.');
      expect(state.restarting).toBeFalsy();
      expect(vi.getTimerCount()).toBe(0); // the exit is never armed on a refusal
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MUST-20.28: the restart is armed once, after the response', () => {
  it('returns the restarting state and arms exactly one timer', async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`); // so the test can observe it without dying
    }) as never);
    try {
      const state = await stageRestoreAction({}, form({ name: 'budget-2026-08-16.tar.gz', confirm: 'on' }));
      expect(state.restarting).toBe(true);
      expect(state.message).toMatch(/restart/i);
      expect(vi.getTimerCount()).toBe(1);
      expect(exit).not.toHaveBeenCalled(); // NOT before the response
      expect(() => vi.advanceTimersByTime(2000)).toThrowError('exit:75');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm the timer when validation fails', async () => {
    vi.useFakeTimers();
    try {
      const state = await stageRestoreAction({}, form({ name: 'not-a-backup', confirm: 'on' }));
      expect(state.error).toBeDefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
