import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db';
import {
  countActiveAdmins,
  countUsers,
  createFirstAdmin,
  createUser,
  createUserSchema,
  findUserById,
  findUserByUsername,
  listUsers,
  mustChangePassword,
  setMustChangePassword,
  setUserActive,
  setUserPassword,
  usernameSchema,
  usernameTaken,
} from '@/lib/auth/users';
import { verifyPassword } from '@/lib/auth/password';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('usernameSchema', () => {
  it('accepts sane usernames and rejects the rest', () => {
    expect(usernameSchema.safeParse('alice').success).toBe(true);
    expect(usernameSchema.safeParse('alice.smith_1-x').success).toBe(true);
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('a'.repeat(33)).success).toBe(false);
    expect(usernameSchema.safeParse('alice smith').success).toBe(false);
    expect(usernameSchema.safeParse('alice@example.com').success).toBe(false);
  });

  it('lowercases on parse so lookups are case-insensitive', () => {
    expect(usernameSchema.parse('  ALICE  ')).toBe('alice');
  });
});

describe('createUser', () => {
  it('stores an argon2 hash, never the plaintext', async () => {
    current = createTestDb();
    const user = await createUser({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'admin' });
    expect(user).toMatchObject({ name: 'Alice', username: 'alice', role: 'admin', isActive: true, totpEnabled: false });
    const stored = findUserByUsername('alice');
    expect(stored?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored?.passwordHash).not.toContain('correct horse battery');
    expect(await verifyPassword(stored!.passwordHash, 'correct horse battery')).toBe(true);
  });

  it('rejects a duplicate username case-insensitively', async () => {
    current = createTestDb();
    await createUser({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'admin' });
    expect(usernameTaken('ALICE')).toBe(true);
    await expect(createUser({ name: 'Other', username: 'ALICE', password: 'correct horse battery', role: 'member' })).rejects.toThrowError(
      /already taken/i,
    );
  });

  it('rejects a password shorter than 10 characters', async () => {
    current = createTestDb();
    await expect(createUser({ name: 'Alice', username: 'alice', password: 'short', role: 'admin' })).rejects.toThrow();
  });

  it('validates its input with zod', () => {
    expect(createUserSchema.safeParse({ name: '', username: 'alice', password: 'correct horse battery', role: 'admin' }).success).toBe(false);
    expect(createUserSchema.safeParse({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'root' }).success).toBe(false);
    expect(createUserSchema.safeParse({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'member' }).success).toBe(true);
  });
});

describe('user lifecycle', () => {
  it('lists users newest-id-last with no secrets attached', async () => {
    current = createTestDb();
    await createUser({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'admin' });
    await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const list = listUsers();
    expect(list.map((u) => u.username)).toEqual(['alice', 'bob']);
    expect(Object.keys(list[0])).not.toContain('passwordHash');
    expect(countUsers()).toBe(2);
  });

  it('deactivates instead of deleting, preserving the row', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    setUserActive(bob.id, false);
    expect(findUserById(bob.id)?.isActive).toBe(false);
    expect(countUsers()).toBe(2 - 1); // still exactly one row
    setUserActive(bob.id, true);
    expect(findUserById(bob.id)?.isActive).toBe(true);
  });

  it('refuses to deactivate the last active admin', async () => {
    current = createTestDb();
    const alice = await createUser({ name: 'Alice', username: 'alice', password: 'correct horse battery', role: 'admin' });
    expect(countActiveAdmins()).toBe(1);
    expect(() => setUserActive(alice.id, false)).toThrowError(/last active admin/i);
  });

  it('resets a password to a new argon2 hash', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const before = findUserByUsername('bob')!.passwordHash;
    await setUserPassword(bob.id, 'a whole new password');
    const after = findUserByUsername('bob')!.passwordHash;
    expect(after).not.toBe(before);
    expect(await verifyPassword(after, 'a whole new password')).toBe(true);
    expect(await verifyPassword(after, 'correct horse battery')).toBe(false);
  });

  it('returns null for an unknown user', () => {
    current = createTestDb();
    expect(findUserByUsername('nobody')).toBeNull();
    expect(findUserById(4242)).toBeNull();
  });
});

describe('must_change_password (spec v1.5)', () => {
  it('defaults to false — createUser only raises the flag when asked to', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    expect(bob.mustChangePassword).toBe(false);
    expect(mustChangePassword(bob.id)).toBe(false);
  });

  it('raises the flag when the caller asks (the admin user manager does)', async () => {
    current = createTestDb();
    const bob = await createUser({
      name: 'Bob',
      username: 'bob',
      password: 'correct horse battery',
      role: 'member',
      mustChangePassword: true,
    });
    expect(bob.mustChangePassword).toBe(true);
    expect(findUserById(bob.id)?.mustChangePassword).toBe(true);
  });

  it('never raises it for the setup wizard admin — they chose their own password', async () => {
    current = createTestDb();
    const admin = await createFirstAdmin({ name: 'Alice', username: 'alice', password: 'correct horse battery' });
    expect(admin.mustChangePassword).toBe(false);
    expect(mustChangePassword(admin.id)).toBe(false);
  });

  it('setUserPassword on its own leaves the flag exactly as it was', async () => {
    current = createTestDb();
    const bob = await createUser({
      name: 'Bob',
      username: 'bob',
      password: 'correct horse battery',
      role: 'member',
      mustChangePassword: true,
    });
    await setUserPassword(bob.id, 'a whole new password');
    // Still set: only the forced-change action clears it, and only the admin
    // actions set it. A self-service change from Settings must not move it either way.
    expect(mustChangePassword(bob.id)).toBe(true);
  });

  it('setMustChangePassword raises and lowers it', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    setMustChangePassword(bob.id, true);
    expect(mustChangePassword(bob.id)).toBe(true);
    setMustChangePassword(bob.id, false);
    expect(mustChangePassword(bob.id)).toBe(false);
  });
});
