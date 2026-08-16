// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { GoalCard } from '@/components/GoalCard';
import { computePace, type GoalWithProgress } from '@/lib/goals';

afterEach(() => cleanup());

function goal(over: Partial<GoalWithProgress> & { targetCents: number; targetDate: string | null; contributions: { date: string; amountCents: number }[] }): GoalWithProgress {
  const pace = computePace({ targetCents: over.targetCents, targetDate: over.targetDate, contributions: over.contributions, today: '2026-08-15' });
  return {
    id: 1,
    name: 'Trip to Japan',
    ownerUserId: null,
    ownerName: null,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    savedCents: pace.savedCents,
    pace,
    ...over,
  } as GoalWithProgress;
}

describe('GoalCard', () => {
  it('shows the owner badge as Shared for a household goal', () => {
    render(<GoalCard goal={goal({ targetCents: 100000, targetDate: '2026-12-01', contributions: [] })} />);
    expect(screen.getByText('Shared')).toBeTruthy();
  });

  it('shows the member name for a personal goal', () => {
    render(<GoalCard goal={goal({ targetCents: 100000, targetDate: '2026-12-01', contributions: [], ownerUserId: 2, ownerName: 'Alice' })} />);
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('hides required-monthly when there is no target date', () => {
    render(<GoalCard goal={goal({ targetCents: 100000, targetDate: null, contributions: [{ date: '2026-08-01', amountCents: 10000 }] })} />);
    expect(screen.queryByText(/required monthly/i)).toBeNull();
  });

  it('says "No pace yet" instead of projecting from a zero average', () => {
    render(<GoalCard goal={goal({ targetCents: 100000, targetDate: '2026-12-01', contributions: [] })} />);
    expect(screen.getByText(/no pace yet/i)).toBeTruthy();
  });

  it('flags an overdue goal', () => {
    render(<GoalCard goal={goal({ targetCents: 100000, targetDate: '2026-01-01', contributions: [{ date: '2025-12-01', amountCents: 20000 }] })} />);
    expect(screen.getByText(/overdue/i)).toBeTruthy();
    expect(screen.getByText(/\$800\.00/)).toBeTruthy();
  });
});
