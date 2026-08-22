import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { nowIso } from '@/lib/clock';
import {
  createProfile,
  deleteProfile,
  forkProfileIfBuiltin,
  getBuiltinPreset,
  getProfile,
  getProfileByName,
  listProfiles,
  mappingsEqual,
  setAccountProfile,
  updateProfileMapping,
} from '@/lib/import/presets';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('profile store', () => {
  it('lists the four seeded built-ins with parsed mappings', () => {
    current = createSeededTestDb();
    const profiles = listProfiles();
    expect(profiles).toHaveLength(4);
    expect(profiles.every((p) => p.isBuiltin)).toBe(true);
    expect(profiles[0].mapping.amountMode).toBe('debit_credit');
  });

  it('creates and reads back a custom profile', () => {
    current = createSeededTestDb();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: { ...getBuiltinPreset('Scotiabank Chequing/Debit'), dateFormat: 'YYYY-MM-DD' },
    });
    const profile = getProfile(id);
    expect(profile).toMatchObject({ id, name: 'Tangerine Chequing', isBuiltin: false });
    expect(profile?.mapping.dateFormat).toBe('YYYY-MM-DD');
    expect(getProfileByName('Tangerine Chequing')?.id).toBe(id);
  });

  it('rejects a duplicate profile name', () => {
    current = createSeededTestDb();
    expect(() =>
      createProfile({ name: 'TD Visa', institution: 'TD Canada Trust', mapping: getBuiltinPreset('TD Visa') }),
    ).toThrow();
  });
});

describe('copy-on-write built-ins', () => {
  it('never mutates a built-in in place', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    expect(() => updateProfileMapping(builtin.id, { ...builtin.mapping, dateFormat: 'YYYY-MM-DD' })).toThrowError(
      /built-in/i,
    );
    expect(getProfile(builtin.id)?.mapping.dateFormat).toBe('MM/DD/YYYY');
  });

  it('returns the same profile id when the mapping is unchanged', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const id = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: builtin.mapping });
    expect(id).toBe(builtin.id);
    expect(listProfiles()).toHaveLength(4);
  });

  it('forks into a new named profile when the mapping is edited', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const edited = { ...builtin.mapping, dateFormat: 'YYYY-MM-DD' };
    const forkedId = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: edited });
    expect(forkedId).not.toBe(builtin.id);

    const forked = getProfile(forkedId)!;
    expect(forked.isBuiltin).toBe(false);
    expect(forked.name).toBe('TD Visa (Joint Visa)');
    expect(forked.mapping.dateFormat).toBe('YYYY-MM-DD');

    // built-in untouched
    expect(getProfile(builtin.id)?.mapping.dateFormat).toBe('MM/DD/YYYY');
    expect(listProfiles()).toHaveLength(5);
  });

  it('does not collide when two accounts fork the same built-in', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const a = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: { ...builtin.mapping, dateFormat: 'YYYY-MM-DD' } });
    const b = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: { ...builtin.mapping, dateFormat: 'DD/MM/YYYY' } });
    expect(a).not.toBe(b);
    expect(getProfile(b)?.name).toBe('TD Visa (Joint Visa) 2');
  });

  it('edits a non-built-in fork in place instead of forking again', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    const forkedId = forkProfileIfBuiltin({ profileId: builtin.id, accountName: 'Joint Visa', mapping: { ...builtin.mapping, dateFormat: 'YYYY-MM-DD' } });
    const again = forkProfileIfBuiltin({ profileId: forkedId, accountName: 'Joint Visa', mapping: { ...builtin.mapping, dateFormat: 'DD/MM/YYYY' } });
    expect(again).toBe(forkedId);
    expect(getProfile(forkedId)?.mapping.dateFormat).toBe('DD/MM/YYYY');
    expect(listProfiles()).toHaveLength(5);
  });
});

describe('mappingsEqual', () => {
  it('ignores key order and compares by value', () => {
    const a = getBuiltinPreset('TD Visa');
    const b = { ...a };
    expect(mappingsEqual(a, b)).toBe(true);
    expect(mappingsEqual(a, { ...a, descCols: [1, 2] })).toBe(false);
    expect(mappingsEqual(a, { ...a, skipRules: { containsAny: ['X'] } })).toBe(false);
  });
});

describe('setAccountProfile', () => {
  it('remembers the profile on the account', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Joint Visa', type: 'credit' });
    const builtin = getProfileByName('TD Visa')!;
    setAccountProfile(accountId, builtin.id);
    const row = current.sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number;
    };
    expect(row.import_profile_id).toBe(builtin.id);
  });
});

describe('deleteProfile (PENDING-FIXES.md #2: a mapping could not be deleted by anyone)', () => {
  it('refuses to delete a built-in profile', () => {
    current = createSeededTestDb();
    const builtin = getProfileByName('TD Visa')!;
    expect(() => deleteProfile(builtin.id)).toThrowError(/built-in/i);
    expect(listProfiles()).toHaveLength(4);
  });

  it('deletes an unused custom profile', () => {
    current = createSeededTestDb();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    deleteProfile(id);
    expect(getProfile(id)).toBeNull();
    expect(listProfiles()).toHaveLength(4);
  });

  it('refuses to delete a profile an account still uses, leaving it intact', () => {
    current = createSeededTestDb();
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    insertTestAccount(current.db, { name: 'Joint Chequing', importProfileId: id });
    expect(() => deleteProfile(id)).toThrowError(/account/i);
    expect(getProfile(id)).not.toBeNull();
  });

  it('refuses to delete a profile a past import still references, leaving it intact', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin' });
    const accountId = insertTestAccount(current.db, { name: 'Old Account' });
    const id = createProfile({
      name: 'Tangerine Chequing',
      institution: 'Tangerine',
      mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    });
    current.sqlite
      .prepare(
        `insert into imports (account_id, profile_id, filename, imported_by, created_at) values (?, ?, ?, ?, ?)`,
      )
      .run(accountId, id, 'old.csv', userId, nowIso());
    expect(() => deleteProfile(id)).toThrowError(/import/i);
    expect(getProfile(id)).not.toBeNull();
  });

  it('throws for an unknown profile id', () => {
    current = createSeededTestDb();
    expect(() => deleteProfile(999999)).toThrowError(/no import profile/i);
  });
});
