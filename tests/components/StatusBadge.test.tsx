// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { StatusBadge } from '@/components/warranty/StatusBadge';

afterEach(() => cleanup());

describe('StatusBadge (§10.2)', () => {
  it('names all five statuses, including the fifth "unknown" one (§17.5)', () => {
    render(<StatusBadge status="active" expiryDate="2027-01-01" today="2026-08-16" />);
    expect(screen.getByText('Active')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="expiring" expiryDate="2026-10-15" today="2026-08-16" />);
    expect(screen.getByText('Expires in 60 days')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="expired" expiryDate="2026-08-15" today="2026-08-16" />);
    expect(screen.getByText('Expired')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="lifetime" expiryDate={null} today="2026-08-16" />);
    expect(screen.getByText('Lifetime')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="unknown" expiryDate={null} today="2026-08-16" />);
    expect(screen.getByText('Term unknown')).toBeTruthy();
  });

  it('carries a distinct colour class per status so they are not all grey', () => {
    const { container: amber } = render(<StatusBadge status="expiring" expiryDate="2026-09-01" today="2026-08-16" />);
    expect(amber.innerHTML).toContain('amber');
    cleanup();
    const { container: red } = render(<StatusBadge status="expired" expiryDate="2026-01-01" today="2026-08-16" />);
    expect(red.innerHTML).toContain('red');
    cleanup();
    const { container: blue } = render(<StatusBadge status="lifetime" expiryDate={null} today="2026-08-16" />);
    expect(blue.innerHTML).toContain('blue');
  });

  it('renders a subscription cancel-by phrasing when kind is subscription (type-deltas T9)', () => {
    render(
      <StatusBadge status="expiring" expiryDate="2026-09-15" today="2026-08-16" kind="subscription" />,
    );
    expect(screen.getByText('Cancel in 30 days')).toBeTruthy();
  });

  // v1.2.2 Task 2: generalized from the boolean isSubscription prop to `kind` -- contract and
  // loan get their own verb, exactly like subscription already did.
  it('renders contract and loan phrasing per kind', () => {
    render(<StatusBadge status="expiring" expiryDate="2026-09-15" today="2026-08-16" kind="contract" />);
    expect(screen.getByText('Ends in 30 days')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="expiring" expiryDate="2026-09-15" today="2026-08-16" kind="loan" />);
    expect(screen.getByText('Paid off in 30 days')).toBeTruthy();
  });

  it('defaults to warranty wording when kind is omitted', () => {
    render(<StatusBadge status="expiring" expiryDate="2026-09-15" today="2026-08-16" />);
    expect(screen.getByText('Expires in 30 days')).toBeTruthy();
  });
});
