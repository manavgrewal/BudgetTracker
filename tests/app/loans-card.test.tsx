// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { LoansCard } from '@/components/LoansCard';
import type { LoanSummary } from '@/lib/loans';

afterEach(() => cleanup());

const civic: LoanSummary = {
  itemId: 1,
  name: 'Civic',
  ownerUserId: 1,
  ownerName: 'Alice',
  principalCents: 2_800_000,
  interestRateBps: 549,
  currentBalanceCents: 1_955_000,
  balanceUpdatedAt: '2026-08-01T00:00:00.000Z',
  billingCycle: 'monthly',
  billingAmountCents: 45_000,
  startDate: '2026-01-15',
  expiryDate: null,
  isLifetime: false,
  payoffFraction: 0.3,
  nextPaymentDate: '2026-09-15',
  lastPaymentAt: '2026-08-01T00:00:00.000Z',
  paymentCount: 3,
};

const bare: LoanSummary = {
  ...civic,
  itemId: 2,
  name: 'Bare',
  principalCents: null,
  currentBalanceCents: null,
  balanceUpdatedAt: null,
  payoffFraction: null,
};

/** A loan with a principal but no tracked balance -- unlike `bare`, this one still clears the
 *  "has a balance or a principal" filter and is SHOWN, rendering its row as '—'. */
const principalOnly: LoanSummary = {
  ...civic,
  itemId: 3,
  name: 'Untracked loan',
  currentBalanceCents: null,
  balanceUpdatedAt: null,
  payoffFraction: null,
};

describe('MUST-15.1 … MUST-15.3: the dashboard card', () => {
  it('renders nothing at all with no loans', () => {
    const { container } = render(<LoansCard loans={[]} totalOwedCents={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when every loan has neither a balance nor a principal', () => {
    const { container } = render(<LoansCard loans={[bare]} totalOwedCents={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the total, one row per loan, and the payoff bar with the right aria-valuenow', () => {
    // totalOwedCents is deliberately NOT the single row's balance — a household's total is
    // loansTotalOwedCents() across every loan, which need not equal any one shown row, so the
    // two must render independently rather than coincide on the same text.
    render(<LoansCard loans={[civic]} totalOwedCents={2_500_000} />);
    expect(screen.getByText('$25,000.00')).toBeTruthy();
    expect(screen.getByText('$19,550.00')).toBeTruthy();
    expect(screen.getByText('Civic')).toBeTruthy();
    expect(screen.getByText('Next payment 2026-09-15')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByText('Rate 5.49%')).toBeTruthy();
  });

  it('omits the rate row when unset', () => {
    render(<LoansCard loans={[{ ...civic, interestRateBps: null }]} totalOwedCents={1_955_000} />);
    expect(screen.queryByText(/^Rate /)).toBeNull();
  });

  it('review fix-round: the total carries an accessible "Total owed" name, and the hint appears only when a shown loan has no tracked balance', () => {
    const { rerender } = render(<LoansCard loans={[civic, principalOnly]} totalOwedCents={1_955_000} />);
    expect(screen.getByLabelText('Total owed $19,550.00')).toBeTruthy();
    expect(screen.getByText('(excludes loans without a tracked balance)')).toBeTruthy();

    rerender(<LoansCard loans={[civic]} totalOwedCents={1_955_000} />);
    expect(screen.queryByText('(excludes loans without a tracked balance)')).toBeNull();
  });
});
