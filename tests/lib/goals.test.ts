import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import {
  addContribution,
  archiveGoal,
  computePace,
  contributionSchema,
  createGoal,
  createGoalSchema,
  deleteContribution,
  getGoal,
  listContributions,
  listGoals,
} from '@/lib/goals';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const TODAY = '2026-08-15';

describe('computePace — the happy path', () => {
  it('divides the remainder over the whole months until the target date', () => {
    const pace = computePace({ targetCents: 100000, targetDate: '2026-12-01', contributions: [], today: TODAY });
    expect(pace).toMatchObject({
      savedCents: 0,
      remainingCents: 100000,
      met: false,
      monthsRemaining: 4,
      requiredMonthlyCents: 25000,
      avgMonthlyCents: 0,
      projectedFinishMonth: null,
      noPace: true,
      overdue: false,
    });
  });

  it('averages the trailing three calendar months and projects a finish', () => {
    const pace = computePace({
      targetCents: 100000,
      targetDate: '2026-12-01',
      contributions: [
        { date: '2026-06-01', amountCents: 10000 },
        { date: '2026-07-01', amountCents: 20000 },
        { date: '2026-08-01', amountCents: 30000 },
      ],
      today: TODAY,
    });
    expect(pace.savedCents).toBe(60000);
    expect(pace.remainingCents).toBe(40000);
    expect(pace.avgMonthlyCents).toBe(20000);
    expect(pace.projectedFinishMonth).toBe('2026-10');
    expect(pace.noPace).toBe(false);
  });

  it('uses all history when it is shorter than three months', () => {
    const pace = computePace({
      targetCents: 100000,
      targetDate: null,
      contributions: [{ date: '2026-08-01', amountCents: 30000 }],
      today: TODAY,
    });
    expect(pace.avgMonthlyCents).toBe(30000);
  });

  it('counts only the trailing window in the numerator but keeps a 3-month denominator', () => {
    const pace = computePace({
      targetCents: 200000,
      targetDate: null,
      contributions: [
        { date: '2026-01-01', amountCents: 90000 },
        { date: '2026-08-01', amountCents: 30000 },
      ],
      today: TODAY,
    });
    expect(pace.savedCents).toBe(120000);
    expect(pace.avgMonthlyCents).toBe(10000);
  });

  it('rounds required monthly up so the goal is actually reached', () => {
    const pace = computePace({ targetCents: 100001, targetDate: '2026-11-01', contributions: [], today: TODAY });
    expect(pace.monthsRemaining).toBe(3);
    expect(pace.requiredMonthlyCents).toBe(33334);
  });
});

describe('computePace — the three edge branches', () => {
  it('hides required-monthly when there is no target date', () => {
    const pace = computePace({ targetCents: 100000, targetDate: null, contributions: [], today: TODAY });
    expect(pace.requiredMonthlyCents).toBeNull();
    expect(pace.monthsRemaining).toBeNull();
    expect(pace.overdue).toBe(false);
  });

  it('says "no pace yet" when the trailing average is zero or negative', () => {
    const zero = computePace({ targetCents: 100000, targetDate: null, contributions: [{ date: '2026-01-01', amountCents: 5000 }], today: TODAY });
    expect(zero.avgMonthlyCents).toBe(0);
    expect(zero.noPace).toBe(true);
    expect(zero.projectedFinishMonth).toBeNull();

    const negative = computePace({
      targetCents: 100000,
      targetDate: null,
      contributions: [
        { date: '2026-08-01', amountCents: 5000 },
        { date: '2026-08-02', amountCents: -9000 },
      ],
      today: TODAY,
    });
    expect(negative.avgMonthlyCents).toBeLessThanOrEqual(0);
    expect(negative.noPace).toBe(true);
    expect(negative.projectedFinishMonth).toBeNull();
  });

  it('flags overdue with the full remaining as the required amount', () => {
    const pace = computePace({
      targetCents: 100000,
      targetDate: '2026-01-01',
      contributions: [{ date: '2025-12-01', amountCents: 20000 }],
      today: TODAY,
    });
    expect(pace.overdue).toBe(true);
    expect(pace.monthsRemaining).toBe(0);
    expect(pace.requiredMonthlyCents).toBe(80000);
  });

  it('is not overdue once the goal is met, even past the target date', () => {
    const pace = computePace({
      targetCents: 100000,
      targetDate: '2026-01-01',
      contributions: [{ date: '2025-12-01', amountCents: 120000 }],
      today: TODAY,
    });
    expect(pace.met).toBe(true);
    expect(pace.overdue).toBe(false);
    expect(pace.remainingCents).toBe(-20000);
    expect(pace.requiredMonthlyCents).toBe(0);
    expect(pace.noPace).toBe(false);
    expect(pace.projectedFinishMonth).toBe('2026-08');
  });

  it('handles a target date inside the current month (floor of one month)', () => {
    const pace = computePace({ targetCents: 60000, targetDate: '2026-08-31', contributions: [], today: TODAY });
    expect(pace.monthsRemaining).toBe(1);
    expect(pace.requiredMonthlyCents).toBe(60000);
    expect(pace.overdue).toBe(false);
  });

  it('handles a zero target without dividing by zero', () => {
    const pace = computePace({ targetCents: 0, targetDate: '2026-12-01', contributions: [], today: TODAY });
    expect(pace.met).toBe(true);
    expect(pace.requiredMonthlyCents).toBe(0);
  });
});

describe('goal storage', () => {
  function setup() {
    current = createSeededTestDb();
    const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob' });
    return { db: current.db, sqlite: current.sqlite, alice, bob };
  }

  it('creates shared and personal goals with an owner label', () => {
    const { alice } = setup();
    const shared = createGoal({ name: 'Emergency fund', ownerUserId: null, targetCents: 1000000, targetDate: null });
    const personal = createGoal({ name: 'New bike', ownerUserId: alice, targetCents: 150000, targetDate: '2026-12-01' });

    const list = listGoals({ today: TODAY });
    expect(list.map((g) => g.id)).toEqual([shared, personal]);
    expect(list.find((g) => g.id === shared)).toMatchObject({ ownerUserId: null, ownerName: null });
    expect(list.find((g) => g.id === personal)).toMatchObject({ ownerUserId: alice, ownerName: 'Alice' });
  });

  it('sums contributions into savedCents and computes the pace', () => {
    const { alice, bob } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: null, targetCents: 100000, targetDate: '2026-12-01' });
    addContribution({ goalId, userId: alice, amountCents: 30000, date: '2026-07-05' });
    addContribution({ goalId, userId: bob, amountCents: 30000, date: '2026-08-05', note: 'bonus' });

    const goal = getGoal(goalId, TODAY)!;
    expect(goal.savedCents).toBe(60000);
    expect(goal.pace.remainingCents).toBe(40000);
    expect(goal.pace.requiredMonthlyCents).toBe(10000);

    const contributions = listContributions(goalId);
    expect(contributions).toHaveLength(2);
    expect(contributions[0]).toMatchObject({ userName: 'Bob', amountCents: 30000, note: 'bonus' });
    expect(contributions[1]).toMatchObject({ userName: 'Alice', note: null });
  });

  it('hides archived goals by default and keeps the row', () => {
    const { alice } = setup();
    const goalId = createGoal({ name: 'Old goal', ownerUserId: alice, targetCents: 5000, targetDate: null });
    archiveGoal(goalId, true);
    expect(listGoals({ today: TODAY })).toHaveLength(0);
    expect(listGoals({ includeArchived: true, today: TODAY })).toHaveLength(1);
    archiveGoal(goalId, false);
    expect(listGoals({ today: TODAY })).toHaveLength(1);
  });

  it('deletes a contribution and reduces savedCents', () => {
    const { alice } = setup();
    const goalId = createGoal({ name: 'Trip', ownerUserId: null, targetCents: 100000, targetDate: null });
    const contributionId = addContribution({ goalId, userId: alice, amountCents: 30000, date: '2026-08-05' });
    expect(getGoal(goalId, TODAY)!.savedCents).toBe(30000);
    deleteContribution(contributionId);
    expect(getGoal(goalId, TODAY)!.savedCents).toBe(0);
  });

  it('validates its input with zod', () => {
    expect(createGoalSchema.safeParse({ name: '', ownerUserId: null, targetCents: 100, targetDate: null }).success).toBe(false);
    expect(createGoalSchema.safeParse({ name: 'X', ownerUserId: null, targetCents: 0, targetDate: null }).success).toBe(false);
    expect(createGoalSchema.safeParse({ name: 'X', ownerUserId: null, targetCents: 100, targetDate: '2026-13-01' }).success).toBe(false);
    expect(createGoalSchema.safeParse({ name: 'X', ownerUserId: null, targetCents: 100, targetDate: '2026-12-01' }).success).toBe(true);
    expect(contributionSchema.safeParse({ goalId: 1, amountCents: 0, date: '2026-08-05', note: null }).success).toBe(false);
    expect(contributionSchema.safeParse({ goalId: 1, amountCents: 100, date: '2026-08-05', note: null }).success).toBe(true);
  });

  it('returns null for an unknown goal', () => {
    setup();
    expect(getGoal(4242, TODAY)).toBeNull();
  });
});
