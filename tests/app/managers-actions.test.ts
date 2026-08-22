import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, categoryIdByName, insertTestUser, type TestDb } from '../helpers/db';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';

let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { requireAdmin } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';
import { deleteProfileAction, deleteRuleAction } from '@/app/(app)/settings/managers/actions';
import { createProfile, getBuiltinPreset, getProfile, getProfileByName, listProfiles } from '@/lib/import/presets';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin' });
  currentUser = { id: userId, name: 'Admin', username: 'admin', role: 'admin' };
  return { db: current.db, userId };
}

describe('deleteRuleAction — missing input validation (finding 2)', () => {
  it('returns a clean error for a non-numeric ruleId instead of a silent no-op success', async () => {
    setup();
    const result = await deleteRuleAction({}, formData({ ruleId: 'nope' }));
    expect(result.error).toBeTruthy();
  });

  it('returns an error when the rule does not exist instead of claiming success', async () => {
    setup();
    const result = await deleteRuleAction({}, formData({ ruleId: '999999' }));
    expect(result.error).toBeTruthy();
  });

  it('still deletes a real rule', async () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const ruleId = upsertRuleFromCorrection({
      pattern: 'TIM HORTONS',
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: coffee,
      createdBy: userId,
    });
    const result = await deleteRuleAction({}, formData({ ruleId: String(ruleId) }));
    expect(result.message).toBeTruthy();
    expect(listRules().find((r) => r.id === ruleId)).toBeUndefined();
  });
});

describe('deleteProfileAction (PENDING-FIXES.md #2: a mapping could not be deleted by anyone)', () => {
  it('refuses to delete a built-in profile', async () => {
    setup();
    const builtin = getProfileByName('TD Visa')!;
    const result = await deleteProfileAction({}, formData({ profileId: String(builtin.id) }));
    expect(result.error).toMatch(/built-in/i);
    expect(listProfiles()).toHaveLength(4);
  });

  it('deletes an unused custom profile and revalidates the managers page', async () => {
    setup();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    vi.mocked(revalidatePath).mockClear();
    const result = await deleteProfileAction({}, formData({ profileId: String(id) }));
    expect(result.message).toBeTruthy();
    expect(getProfile(id)).toBeNull();
    expect(vi.mocked(revalidatePath).mock.calls.map((call) => call[0])).toContain('/settings/managers');
  });

  it('refuses to delete a profile an account still uses', async () => {
    const { db } = setup();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    insertTestAccount(db, { name: 'Joint Chequing', importProfileId: id });
    const result = await deleteProfileAction({}, formData({ profileId: String(id) }));
    expect(result.error).toMatch(/account/i);
    expect(getProfile(id)).not.toBeNull();
  });

  it('refuses a non-admin caller', async () => {
    setup();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(deleteProfileAction({}, formData({ profileId: String(id) }))).rejects.toThrow(/not admin/);
    expect(getProfile(id)).not.toBeNull();
  });
});
