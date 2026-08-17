// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ItemTypesManager } from '@/app/(app)/settings/item-types/item-types-manager';
import type { ItemTypeWithUsage } from '@/lib/warranty/types';

// Server actions aren't under test here -- only the form the reviewer's 5b lesson is about.
vi.mock('@/app/(app)/settings/item-types/actions', () => ({
  createItemTypeAction: vi.fn(async () => ({})),
  renameItemTypeAction: vi.fn(async () => ({})),
  setKindAction: vi.fn(async () => ({})),
  deleteItemTypeAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

function type(over: Partial<ItemTypeWithUsage> = {}): ItemTypeWithUsage {
  return {
    id: 1,
    name: 'Laptop',
    isSubscription: false,
    kind: 'warranty',
    createdAt: '2026-08-16T00:00:00.000Z',
    usageCount: 0,
    ...over,
  };
}

describe('ItemTypesManager — create form (5b lesson, made enforceable)', () => {
  it('renders exactly ONE [name="kind"] control in the create form', () => {
    const { container } = render(<ItemTypesManager types={[]} />);
    // 5b regression: a hidden input sharing the same `name` as the real control silently wins
    // over the admin's choice via FormData.get()'s first-value semantics. A plain <select> has
    // no such sibling, but this pins the invariant directly: exactly one element named "kind"
    // inside the "Add a type" form, full stop.
    const createForm = screen.getByRole('button', { name: /add type/i }).closest('form')!;
    const kindControls = createForm.querySelectorAll('[name="kind"]');
    expect(kindControls).toHaveLength(1);
    expect(kindControls[0].tagName).toBe('SELECT');
    expect(container.querySelectorAll('form [name="kind"]').length).toBeGreaterThanOrEqual(1);
  });

  it('offers all four kinds as options, defaulting to Warranty', () => {
    render(<ItemTypesManager types={[]} />);
    const select = screen.getByRole('button', { name: /add type/i }).closest('form')!.querySelector('select[name="kind"]') as HTMLSelectElement;
    const optionLabels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels).toEqual(['Warranty', 'Subscription', 'Contract', 'Loan']);
    expect(select.value).toBe('warranty');
  });

  it('lists a row per type, with its own kind select carrying the current value', () => {
    render(<ItemTypesManager types={[type({ id: 5, name: 'Netflix', kind: 'subscription', isSubscription: true })]} />);
    expect(screen.getByText('Netflix')).toBeTruthy();
    const rowSelect = screen.getByRole('combobox', { name: /kind of netflix/i }) as HTMLSelectElement;
    expect(rowSelect.value).toBe('subscription');
  });
});
