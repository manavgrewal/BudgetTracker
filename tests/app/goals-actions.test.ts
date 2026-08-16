import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { addContribution, createGoal, getGoal, listContributions } from '@/lib/goals';

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member' } = {
  id: 1,
  name: 'Alice',
  username: 'alice',
  role: 'member',
};
let mockHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => mockHeaders,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import {
  addContributionAction,
  archiveGoalAction,
  createGoalAction,
  deleteContributionAction,
} from '@/app/(app)/goals/actions';

const SAME_ORIGIN = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
const CROSS_ORIGIN = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  mockHeaders = SAME_ORIGIN;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'member' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  const admin = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  currentUser = { id: alice, name: 'Alice', username: 'alice', role: 'member' };
  mockHeaders = SAME_ORIGIN;
  return { alice, bob, admin };
}

describe('createGoalAction', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    setup();
    mockHeaders = CROSS_ORIGIN;
    const result = await createGoalAction(
      {},
      formData({ name: 'Trip', target: '500.00', targetDate: '', owner: 'shared' }),
    );
    expect(result.error).toMatch(/cross-origin/i);
  });

  it("rejects a member creating a goal owned by another member", async () => {
    const { bob } = setup();
    const result = await createGoalAction(
      {},
      formData({ name: 'Trip', target: '500.00', targetDate: '', owner: String(bob) }),
    );
    expect(result.error).toMatch(/yourself or shared/i);
  });

  it("lets an admin create a goal owned by another member", async () => {
    const { admin, bob } = setup();
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await createGoalAction(
      {},
      formData({ name: 'Trip', target: '500.00', targetDate: '', owner: String(bob) }),
    );
    expect(result.message).toBeTruthy();
  });

  it('happy path: a member creates their own goal and a shared goal', async () => {
    const { alice } = setup();
    const own = await createGoalAction(
      {},
      formData({ name: 'New bike', target: '1500.00', targetDate: '2026-12-01', owner: String(alice) }),
    );
    expect(own.message).toBeTruthy();

    const shared = await createGoalAction(
      {},
      formData({ name: 'Emergency fund', target: '10000.00', targetDate: '', owner: 'shared' }),
    );
    expect(shared.message).toBeTruthy();
  });
});

describe('addContributionAction', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    const { alice } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: alice, targetCents: 100000, targetDate: null });
    mockHeaders = CROSS_ORIGIN;
    const result = await addContributionAction(
      {},
      formData({ goalId: String(goalId), amount: '50.00', date: '2026-08-05', note: '' }),
    );
    expect(result.error).toMatch(/cross-origin/i);
    expect(getGoal(goalId)!.savedCents).toBe(0);
  });

  it("rejects a member logging a contribution to another member's personal goal", async () => {
    const { bob } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: bob, targetCents: 100000, targetDate: null });
    const result = await addContributionAction(
      {},
      formData({ goalId: String(goalId), amount: '50.00', date: '2026-08-05', note: '' }),
    );
    expect(result.error).toMatch(/your own/i);
    expect(getGoal(goalId)!.savedCents).toBe(0);
  });

  it("lets an admin log a contribution to another member's personal goal", async () => {
    const { admin, bob } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: bob, targetCents: 100000, targetDate: null });
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await addContributionAction(
      {},
      formData({ goalId: String(goalId), amount: '50.00', date: '2026-08-05', note: '' }),
    );
    expect(result.message).toBeTruthy();
    expect(getGoal(goalId)!.savedCents).toBe(5000);
  });

  it('happy path: a member logs a contribution to their own goal and a shared goal', async () => {
    const { alice } = setup();
    const own = createGoal({ name: 'New bike', ownerUserId: alice, targetCents: 100000, targetDate: null });
    const ownResult = await addContributionAction(
      {},
      formData({ goalId: String(own), amount: '25.00', date: '2026-08-05', note: '' }),
    );
    expect(ownResult.message).toBeTruthy();
    expect(getGoal(own)!.savedCents).toBe(2500);

    const shared = createGoal({ name: 'Emergency fund', ownerUserId: null, targetCents: 100000, targetDate: null });
    const sharedResult = await addContributionAction(
      {},
      formData({ goalId: String(shared), amount: '10.00', date: '2026-08-05', note: '' }),
    );
    expect(sharedResult.message).toBeTruthy();
    expect(getGoal(shared)!.savedCents).toBe(1000);
  });
});

describe('archiveGoalAction', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    const { alice } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: alice, targetCents: 100000, targetDate: null });
    mockHeaders = CROSS_ORIGIN;
    const result = await archiveGoalAction({}, formData({ goalId: String(goalId), archived: '1' }));
    expect(result.error).toMatch(/cross-origin/i);
  });

  it("rejects a member archiving another member's personal goal", async () => {
    const { bob } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: bob, targetCents: 100000, targetDate: null });
    const result = await archiveGoalAction({}, formData({ goalId: String(goalId), archived: '1' }));
    expect(result.error).toMatch(/your own/i);
  });

  it("lets an admin archive another member's personal goal", async () => {
    const { admin, bob } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: bob, targetCents: 100000, targetDate: null });
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await archiveGoalAction({}, formData({ goalId: String(goalId), archived: '1' }));
    expect(result.message).toMatch(/archived/i);
  });

  it('happy path: a member archives their own goal and a shared goal', async () => {
    const { alice } = setup();
    const own = createGoal({ name: 'New bike', ownerUserId: alice, targetCents: 100000, targetDate: null });
    const ownResult = await archiveGoalAction({}, formData({ goalId: String(own), archived: '1' }));
    expect(ownResult.message).toMatch(/archived/i);

    const shared = createGoal({ name: 'Emergency fund', ownerUserId: null, targetCents: 100000, targetDate: null });
    const sharedResult = await archiveGoalAction({}, formData({ goalId: String(shared), archived: '1' }));
    expect(sharedResult.message).toMatch(/archived/i);
  });
});

describe('deleteContributionAction', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    const { alice } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: alice, targetCents: 100000, targetDate: null });
    const contributionId = addContribution({ goalId, userId: alice, amountCents: 3000, date: '2026-08-05' });
    mockHeaders = CROSS_ORIGIN;
    const result = await deleteContributionAction(
      {},
      formData({ goalId: String(goalId), contributionId: String(contributionId) }),
    );
    expect(result.error).toMatch(/cross-origin/i);
    expect(listContributions(goalId)).toHaveLength(1);
  });

  it("rejects a member removing a contribution from another member's personal goal", async () => {
    const { alice, bob } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: bob, targetCents: 100000, targetDate: null });
    const contributionId = addContribution({ goalId, userId: alice, amountCents: 3000, date: '2026-08-05' });
    const result = await deleteContributionAction(
      {},
      formData({ goalId: String(goalId), contributionId: String(contributionId) }),
    );
    expect(result.error).toMatch(/your own/i);
    expect(listContributions(goalId)).toHaveLength(1);
  });

  it("rejects a contributionId/goalId pairing that doesn't actually match", async () => {
    const { alice } = setup();
    const ownGoal = createGoal({ name: 'New bike', ownerUserId: alice, targetCents: 100000, targetDate: null });
    const otherGoal = createGoal({ name: 'Emergency fund', ownerUserId: null, targetCents: 100000, targetDate: null });
    const contributionId = addContribution({ goalId: otherGoal, userId: alice, amountCents: 3000, date: '2026-08-05' });
    // Owns ownGoal, but the contributionId actually belongs to otherGoal.
    const result = await deleteContributionAction(
      {},
      formData({ goalId: String(ownGoal), contributionId: String(contributionId) }),
    );
    expect(result.error).toMatch(/not found/i);
    expect(listContributions(otherGoal)).toHaveLength(1);
  });

  it("lets an admin remove a contribution from another member's personal goal", async () => {
    const { admin, bob } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: bob, targetCents: 100000, targetDate: null });
    const contributionId = addContribution({ goalId, userId: bob, amountCents: 3000, date: '2026-08-05' });
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await deleteContributionAction(
      {},
      formData({ goalId: String(goalId), contributionId: String(contributionId) }),
    );
    expect(result.message).toMatch(/removed/i);
    expect(listContributions(goalId)).toHaveLength(0);
  });

  it('happy path: a member removes a contribution from their own goal', async () => {
    const { alice } = setup();
    const goalId = createGoal({ name: 'New bike', ownerUserId: alice, targetCents: 100000, targetDate: null });
    const contributionId = addContribution({ goalId, userId: alice, amountCents: 3000, date: '2026-08-05' });
    const result = await deleteContributionAction(
      {},
      formData({ goalId: String(goalId), contributionId: String(contributionId) }),
    );
    expect(result.message).toMatch(/removed/i);
    expect(listContributions(goalId)).toHaveLength(0);
  });
});
