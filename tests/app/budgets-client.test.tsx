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
