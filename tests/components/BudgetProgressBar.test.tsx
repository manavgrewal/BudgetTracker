// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BudgetProgressBar } from '@/components/BudgetProgressBar';

afterEach(() => cleanup());

describe('BudgetProgressBar', () => {
  it('exposes the progress to assistive tech', () => {
    render(<BudgetProgressBar limitCents={80000} spentCents={20000} label="Groceries" />);
    const bar = screen.getByRole('progressbar', { name: 'Groceries' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('clamps the visual fill at 100% but reports the true percentage', () => {
    render(<BudgetProgressBar limitCents={10000} spentCents={15000} label="Coffee" />);
    const bar = screen.getByRole('progressbar', { name: 'Coffee' });
    expect(bar.getAttribute('aria-valuenow')).toBe('150');
    expect(bar.getAttribute('data-over-budget')).toBe('true');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('renders a no-budget state instead of a bar when there is no limit', () => {
    render(<BudgetProgressBar limitCents={null} spentCents={15000} label="Kids" />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('No budget')).toBeTruthy();
  });
});
