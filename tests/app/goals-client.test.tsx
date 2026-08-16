// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { GoalsClient } from '@/app/(app)/goals/goals-client';
import { computePace, type GoalWithProgress } from '@/lib/goals';

vi.mock('@/app/(app)/goals/actions', () => ({
  createGoalAction: vi.fn(async () => ({})),
  addContributionAction: vi.fn(async () => ({})),
  archiveGoalAction: vi.fn(async () => ({})),
  deleteContributionAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

function goal(over: Partial<GoalWithProgress> = {}): GoalWithProgress {
  const pace = computePace({ targetCents: 100000, targetDate: null, contributions: [], today: '2026-08-16' });
  return {
    id: 1,
    name: 'Trip to Japan',
    ownerUserId: null,
    ownerName: null,
    targetCents: 100000,
    targetDate: null,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    savedCents: pace.savedCents,
    pace,
    ...over,
  } as GoalWithProgress;
}

function renderClient(over: { archived?: boolean; showArchived?: boolean } = {}) {
  return render(
    <GoalsClient
      today="2026-08-16"
      showArchived={over.showArchived ?? false}
      goals={[{ goal: goal({ archived: over.archived ?? false }), contributions: [] }]}
      people={[{ id: 1, name: 'Alice' }]}
    />,
  );
}

describe('GoalsClient — polish item 6: archived goals are reachable again', () => {
  it('offers a "Show archived" link when archived goals are hidden', () => {
    const { getByText } = renderClient();
    const link = getByText('Show archived') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/goals?archived=1');
  });

  it('flips to "Hide archived" once they are shown', () => {
    const { getByText } = renderClient({ showArchived: true });
    const link = getByText('Hide archived') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/goals');
  });

  it('an active goal offers Archive, submitting archived=1', () => {
    const { container, getByText } = renderClient();
    expect(getByText('Archive')).toBeTruthy();
    const field = container.querySelector('input[name="archived"]') as HTMLInputElement;
    expect(field.value).toBe('1');
  });

  it('an archived goal offers Restore instead, submitting archived=0', () => {
    const { container, getByText } = renderClient({ archived: true, showArchived: true });
    // archiveGoal(id, false) existed all along; nothing in the UI could reach it.
    expect(getByText('Restore')).toBeTruthy();
    expect(getByText('Archived')).toBeTruthy();
    const field = container.querySelector('input[name="archived"]') as HTMLInputElement;
    expect(field.value).toBe('0');
  });
});
