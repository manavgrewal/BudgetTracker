// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BudgetsClient } from '@/app/(app)/budgets/budgets-client';
import type { BudgetRow } from '@/lib/budgets';

vi.mock('@/app/(app)/budgets/actions', () => ({
  setLimitAction: vi.fn(async () => ({})),
  copyPreviousMonthAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

function makeRow(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    categoryId: 1,
    categoryName: 'Groceries',
    parentId: null,
    isIncome: false,
    isArchived: false,
    limitCents: 20000,
    spentCents: 5000,
    remainingCents: 15000,
    pct: 25,
    overBudget: false,
    children: [],
    ...overrides,
  };
}

describe('BudgetsClient — review finding 2: archived rows are read-only', () => {
  it('renders an archived row without an editable limit form', () => {
    const row = makeRow({ categoryId: 99, categoryName: 'Kids', isArchived: true, limitCents: null, remainingCents: null, pct: null });
    const { container, getByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(getByText('(archived)')).toBeTruthy();
    expect(getByText('read-only')).toBeTruthy();
    // No amount input/save form for this row.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const archivedRowCells = rows.find((r) => r.textContent?.includes('Kids'));
    expect(archivedRowCells?.querySelector('input[name="amount"]')).toBeNull();
  });

  it('still renders an editable limit form for a non-archived row', () => {
    const row = makeRow({ categoryId: 2, categoryName: 'Coffee' });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    const input = container.querySelector('input[name="amount"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.defaultValue).toBe('200.00');
  });
});

describe('BudgetsClient — polish item 5: other members’ personal sections are read-only', () => {
  const personalRow = makeRow({ categoryId: 7, categoryName: 'Hobbies', limitCents: 15000 });

  function renderFor(currentUserIsAdmin: boolean) {
    return render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin={currentUserIsAdmin}
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[
          { userId: 1, name: 'Alice', rows: [personalRow] },
          { userId: 2, name: 'Bob', rows: [personalRow] },
        ]}
      />,
    );
  }

  function sectionFor(container: HTMLElement, name: string): HTMLElement {
    const section = Array.from(container.querySelectorAll('section')).find((node) =>
      node.querySelector('h2')?.textContent?.startsWith(name),
    );
    if (!section) throw new Error(`no section for ${name}`);
    return section as HTMLElement;
  }

  it('a non-admin gets inputs and a copy button for themselves only', () => {
    const { container } = renderFor(false);

    const mine = sectionFor(container, 'Alice');
    expect(mine.querySelector('input[name="amount"]')).not.toBeNull();
    expect(mine.textContent).toContain('Copy previous month');

    const theirs = sectionFor(container, 'Bob');
    // No control that setLimitAction / copyPreviousMonthAction would refuse anyway.
    expect(theirs.querySelector('input[name="amount"]')).toBeNull();
    expect(theirs.textContent).not.toContain('Copy previous month');
    // The number itself is still visible — the household sees everything by design.
    expect(theirs.textContent).toContain('$150.00');
    expect(theirs.textContent).toContain('read-only');
  });

  it('an admin keeps the controls on everyone’s section', () => {
    const { container } = renderFor(true);
    for (const name of ['Alice', 'Bob']) {
      const section = sectionFor(container, name);
      expect(section.querySelector('input[name="amount"]')).not.toBeNull();
      expect(section.textContent).toContain('Copy previous month');
    }
  });

  it('household rows stay editable for a non-admin', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin={false}
        household={[makeRow()]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(container.querySelector('input[name="amount"]')).not.toBeNull();
  });
});

describe('BudgetsClient — polish item 7: one banner, not two', () => {
  it('renders neither message nor error before anything has been submitted', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow()]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    // A single banner slot means there is exactly one place a message can appear;
    // with no submission yet, neither the error role nor a success line is present.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.text-green-700')).toBeNull();
  });
});

describe('BudgetsClient — review finding 1: three-number household headline', () => {
  it('reports budgeted spend/limit separately from total spend, not one misleading ratio', () => {
    const row = makeRow();
    const { getByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 10000, budgetedSpentCents: 8000, totalSpentCents: 40000 }}
        personal={[]}
      />,
    );
    expect(getByText(/spent \$80\.00 of \$100\.00 budgeted/)).toBeTruthy();
    expect(getByText(/\$400\.00 total spent/)).toBeTruthy();
  });
});
