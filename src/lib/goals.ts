import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { goalContributions, goals, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { addMonths, isIsoDate, monthOf, monthsBetween, todayIso, wholeMonthsUntil } from '@/lib/dates';

export interface GoalRecord {
  id: number;
  name: string;
  ownerUserId: number | null;
  ownerName: string | null;
  targetCents: number;
  targetDate: string | null;
  archived: boolean;
  createdAt: string;
}

export interface GoalPace {
  savedCents: number;
  remainingCents: number;
  met: boolean;
  monthsRemaining: number | null;
  requiredMonthlyCents: number | null;
  avgMonthlyCents: number;
  projectedFinishMonth: string | null;
  noPace: boolean;
  overdue: boolean;
}

export interface GoalWithProgress extends GoalRecord {
  savedCents: number;
  pace: GoalPace;
}

export interface ContributionRecord {
  id: number;
  goalId: number;
  userId: number;
  userName: string;
  amountCents: number;
  date: string;
  note: string | null;
}

export const createGoalSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  ownerUserId: z.number().int().positive().nullable(),
  targetCents: z.number().int().positive('Target must be greater than zero'),
  targetDate: z
    .string()
    .refine((value) => isIsoDate(value), 'Target date must be YYYY-MM-DD')
    .nullable(),
});

export const contributionSchema = z.object({
  goalId: z.number().int().positive(),
  amountCents: z.number().int().refine((value) => value !== 0, 'Amount cannot be zero'),
  date: z.string().refine(isIsoDate, 'Date must be YYYY-MM-DD'),
  note: z.string().trim().max(200).nullable().optional(),
});

const TRAILING_MONTHS = 3;

export function computePace(input: {
  targetCents: number;
  targetDate: string | null;
  contributions: { date: string; amountCents: number }[];
  today?: string;
}): GoalPace {
  const today = input.today ?? todayIso();
  const currentMonthKey = monthOf(today);
  const windowStart = addMonths(currentMonthKey, -(TRAILING_MONTHS - 1));

  const savedCents = input.contributions.reduce((sum, row) => sum + row.amountCents, 0);
  const remainingCents = input.targetCents - savedCents;
  const met = remainingCents <= 0;

  // ---- trailing average ----
  let windowSum = 0;
  let firstMonth: string | null = null;
  for (const contribution of input.contributions) {
    const month = monthOf(contribution.date);
    if (firstMonth === null || month < firstMonth) firstMonth = month;
    if (month >= windowStart && month <= currentMonthKey) windowSum += contribution.amountCents;
  }
  const denominatorStart = firstMonth !== null && firstMonth > windowStart ? firstMonth : windowStart;
  const monthsCounted = Math.max(1, monthsBetween(denominatorStart, currentMonthKey) + 1);
  const avgMonthlyCents = input.contributions.length === 0 ? 0 : Math.round(windowSum / monthsCounted);

  const noPace = !met && avgMonthlyCents <= 0;
  let projectedFinishMonth: string | null = null;
  if (met) projectedFinishMonth = currentMonthKey;
  else if (avgMonthlyCents > 0) projectedFinishMonth = addMonths(currentMonthKey, Math.ceil(remainingCents / avgMonthlyCents));

  // ---- required monthly ----
  let monthsRemaining: number | null = null;
  let requiredMonthlyCents: number | null = null;
  let overdue = false;

  if (input.targetDate !== null) {
    overdue = input.targetDate < today && !met;
    if (overdue) {
      monthsRemaining = 0;
      requiredMonthlyCents = remainingCents;
    } else if (met) {
      monthsRemaining = wholeMonthsUntil(today, input.targetDate);
      requiredMonthlyCents = 0;
    } else {
      monthsRemaining = wholeMonthsUntil(today, input.targetDate);
      requiredMonthlyCents = Math.ceil(remainingCents / monthsRemaining);
    }
  }

  return {
    savedCents,
    remainingCents,
    met,
    monthsRemaining,
    requiredMonthlyCents,
    avgMonthlyCents,
    projectedFinishMonth,
    noPace,
    overdue,
  };
}

export function createGoal(input: { name: string; ownerUserId: number | null; targetCents: number; targetDate: string | null }): number {
  const parsed = createGoalSchema.parse(input);
  const row = getDb()
    .insert(goals)
    .values({
      name: parsed.name,
      ownerUserId: parsed.ownerUserId,
      targetCents: parsed.targetCents,
      targetDate: parsed.targetDate,
      archived: false,
      createdAt: nowIso(),
    })
    .returning({ id: goals.id })
    .get();
  return row.id;
}

export function addContribution(input: {
  goalId: number;
  userId: number;
  amountCents: number;
  date: string;
  note?: string | null;
}): number {
  const parsed = contributionSchema.parse({
    goalId: input.goalId,
    amountCents: input.amountCents,
    date: input.date,
    note: input.note ?? null,
  });
  const row = getDb()
    .insert(goalContributions)
    .values({
      goalId: parsed.goalId,
      userId: input.userId,
      amountCents: parsed.amountCents,
      date: parsed.date,
      note: parsed.note ?? null,
      createdAt: nowIso(),
    })
    .returning({ id: goalContributions.id })
    .get();
  return row.id;
}

export function listContributions(goalId: number): ContributionRecord[] {
  return getDb()
    .select({
      id: goalContributions.id,
      goalId: goalContributions.goalId,
      userId: goalContributions.userId,
      userName: users.name,
      amountCents: goalContributions.amountCents,
      date: goalContributions.date,
      note: goalContributions.note,
    })
    .from(goalContributions)
    .innerJoin(users, eq(users.id, goalContributions.userId))
    .where(eq(goalContributions.goalId, goalId))
    .orderBy(desc(goalContributions.date), desc(goalContributions.id))
    .all();
}

function baseGoals() {
  return getDb()
    .select({
      id: goals.id,
      name: goals.name,
      ownerUserId: goals.ownerUserId,
      ownerName: users.name,
      targetCents: goals.targetCents,
      targetDate: goals.targetDate,
      archived: goals.archived,
      createdAt: goals.createdAt,
    })
    .from(goals)
    .leftJoin(users, eq(users.id, goals.ownerUserId));
}

function attachProgress(record: GoalRecord, today: string): GoalWithProgress {
  const contributions = getDb()
    .select({ date: goalContributions.date, amountCents: goalContributions.amountCents })
    .from(goalContributions)
    .where(eq(goalContributions.goalId, record.id))
    .all();
  const pace = computePace({ targetCents: record.targetCents, targetDate: record.targetDate, contributions, today });
  return { ...record, savedCents: pace.savedCents, pace };
}

export function listGoals(opts: { includeArchived?: boolean; today?: string } = {}): GoalWithProgress[] {
  const today = opts.today ?? todayIso();
  const rows = baseGoals().orderBy(asc(goals.id)).all();
  return rows.filter((row) => opts.includeArchived || !row.archived).map((row) => attachProgress(row, today));
}

export function getGoal(goalId: number, today?: string): GoalWithProgress | null {
  const row = baseGoals().where(eq(goals.id, goalId)).get();
  if (!row) return null;
  return attachProgress(row, today ?? todayIso());
}

export function archiveGoal(goalId: number, archived: boolean): void {
  getDb().update(goals).set({ archived }).where(eq(goals.id, goalId)).run();
}

export function deleteContribution(contributionId: number): void {
  getDb().delete(goalContributions).where(eq(goalContributions.id, contributionId)).run();
}

/** Exported for the dashboard's goal cards: total saved across active goals. */
export function totalSavedAcrossGoals(today?: string): number {
  return listGoals({ today }).reduce((sum, goal) => sum + goal.savedCents, 0);
}
