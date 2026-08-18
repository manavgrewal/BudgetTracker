import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyLoanMatchers, listLoans, loansTotalOwedCents, saveLoanRule } from '@/lib/loans';
import { setupLoanTest, type LoanTestContext } from './fixtures';

let ctx: LoanTestContext;

beforeEach(() => {
  ctx = setupLoanTest();
});
afterEach(() => {
  ctx.t.cleanup();
});

/**
 * Full control over the columns listLoans() reads, beyond what the shared seedLoan fixture
 * exposes (purchase_date, billing_cycle, billing_amount_cents, expiry_date, is_lifetime).
 */
function seedLoanFull(over: {
  name?: string;
  purchaseDate?: string;
  billingCycle?: 'monthly' | 'annual' | null;
  billingAmountCents?: number | null;
  expiryDate?: string | null;
  isLifetime?: boolean;
  principalCents?: number | null;
  interestRateBps?: number | null;
  balanceCents?: number | null;
  ownerUserId?: number;
}): number {
  const balance = over.balanceCents === undefined ? 2_000_000 : over.balanceCents;
  const expiryDate = over.expiryDate ?? null;
  // CHECK (warranty_months IS NULL) = (expiry_date IS NULL) on warranty_items: the two are
  // paired. The real app computes expiry_date FROM warranty_months at write time; these
  // tests only exercise listLoans()'s read side, so any non-null placeholder satisfies it.
  const warrantyMonths = expiryDate === null ? null : 1;
  const row = ctx.t.sqlite
    .prepare(
      `insert into warranty_items
         (name, purchase_date, warranty_months, is_lifetime, expiry_date, owner_user_id, type_id, principal_cents, interest_rate_bps,
          current_balance_cents, balance_updated_at, billing_cycle, billing_amount_cents, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
    )
    .get(
      over.name ?? 'Civic',
      over.purchaseDate ?? '2024-01-15',
      warrantyMonths,
      over.isLifetime ? 1 : 0,
      expiryDate,
      over.ownerUserId ?? ctx.userId,
      ctx.typeId,
      over.principalCents ?? null,
      over.interestRateBps ?? null,
      balance,
      balance === null ? null : '2026-08-18T12:00:00.000Z',
      over.billingCycle ?? null,
      over.billingAmountCents ?? null,
      '2026-08-18T12:00:00.000Z',
      '2026-08-18T12:00:00.000Z',
    ) as { id: number };
  return row.id;
}

describe('MUST-15.4: listLoans read model', () => {
  it('payoffFraction is clamp(1 - balance/principal, 0, 1), and null when principal or balance is unset', () => {
    const partial = seedLoanFull({ name: 'Partial', principalCents: 1_000_000, balanceCents: 250_000 });
    const noPrincipal = seedLoanFull({ name: 'NoPrincipal', principalCents: null, balanceCents: 250_000 });
    const noBalance = seedLoanFull({ name: 'NoBalance', principalCents: 1_000_000, balanceCents: null });
    const zeroPrincipal = seedLoanFull({ name: 'ZeroPrincipal', principalCents: 0, balanceCents: 0 });
    const paidOff = seedLoanFull({ name: 'PaidOff', principalCents: 1_000_000, balanceCents: 0 });

    const byId = new Map(listLoans().map((loan) => [loan.itemId, loan]));
    expect(byId.get(partial)!.payoffFraction).toBe(0.75);
    expect(byId.get(noPrincipal)!.payoffFraction).toBeNull();
    expect(byId.get(noBalance)!.payoffFraction).toBeNull();
    expect(byId.get(zeroPrincipal)!.payoffFraction).toBeNull();
    expect(byId.get(paidOff)!.payoffFraction).toBe(1);
  });

  it('nextPaymentDate is the first monthly/annual date on or after today, capped at expiry', () => {
    const monthly = seedLoanFull({ name: 'Monthly', purchaseDate: '2024-01-15', billingCycle: 'monthly' });
    const annual = seedLoanFull({ name: 'Annual', purchaseDate: '2024-01-15', billingCycle: 'annual' });
    const noCycle = seedLoanFull({ name: 'NoCycle', purchaseDate: '2024-01-15', billingCycle: null });
    const alreadyPaidOff = seedLoanFull({
      name: 'AlreadyPaidOff',
      purchaseDate: '2024-01-15',
      billingCycle: 'monthly',
      expiryDate: '2026-08-20', // before the next monthly date (2026-09-15)
    });

    const byId = new Map(listLoans('2026-08-18').map((loan) => [loan.itemId, loan]));
    expect(byId.get(monthly)!.nextPaymentDate).toBe('2026-09-15');
    expect(byId.get(annual)!.nextPaymentDate).toBe('2027-01-15');
    expect(byId.get(noCycle)!.nextPaymentDate).toBeNull();
    expect(byId.get(alreadyPaidOff)!.nextPaymentDate).toBeNull();
  });

  it('lastPaymentAt and paymentCount come from linked loan_payments rows', () => {
    const itemId = seedLoanFull({ name: 'Civic' });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const txn1 = ctx.spend('HONDA FIN SVC', -10_000, { date: '2026-01-01' });
    applyLoanMatchers([txn1], new Date('2026-01-02T00:00:00.000Z'));
    const txn2 = ctx.spend('HONDA FIN SVC', -10_000, { date: '2026-02-01' });
    applyLoanMatchers([txn2], new Date('2026-02-02T00:00:00.000Z'));

    const loan = listLoans().find((row) => row.itemId === itemId)!;
    expect(loan.paymentCount).toBe(2);
    expect(loan.lastPaymentAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('a loan with no payments has paymentCount 0 and lastPaymentAt null', () => {
    const itemId = seedLoanFull({ name: 'Untouched' });
    const loan = listLoans().find((row) => row.itemId === itemId)!;
    expect(loan.paymentCount).toBe(0);
    expect(loan.lastPaymentAt).toBeNull();
  });

  it('carries ownerName from the joined user row', () => {
    const otherOwner = ctx.t.sqlite
      .prepare(`insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at) values (?, ?, 'x', 'admin', 0, 1, ?) returning id`)
      .get('Bea', `bea${Math.random().toString(36).slice(2, 8)}`, '2026-08-18T12:00:00.000Z') as { id: number };
    const itemId = seedLoanFull({ name: 'Beas Loan', ownerUserId: otherOwner.id });
    const loan = listLoans().find((row) => row.itemId === itemId)!;
    expect(loan.ownerName).toBe('Bea');
  });

  it('excludes item types whose kind is not loan', () => {
    const warrantyType = ctx.t.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Dishwasher', 0, 'warranty', ?) returning id`)
      .get('2026-08-18T12:00:00.000Z') as { id: number };
    ctx.t.sqlite
      .prepare(
        `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
         values ('Dell XPS', '2024-01-15', 0, ?, ?, ?, ?)`,
      )
      .run(ctx.userId, warrantyType.id, '2026-08-18T12:00:00.000Z', '2026-08-18T12:00:00.000Z');
    const loan = seedLoanFull({ name: 'Civic' });

    const names = listLoans().map((row) => row.name);
    expect(names).toEqual(['Civic']);
    expect(listLoans().map((row) => row.itemId)).toEqual([loan]);
  });

  it('orders by name', () => {
    seedLoanFull({ name: 'Zamboni Loan' });
    seedLoanFull({ name: 'Auto Loan' });
    expect(listLoans().map((row) => row.name)).toEqual(['Auto Loan', 'Zamboni Loan']);
  });
});

describe('loansTotalOwedCents', () => {
  it('sums current_balance_cents across every loan, treating null as zero', () => {
    seedLoanFull({ name: 'A', balanceCents: 500_00 });
    seedLoanFull({ name: 'B', balanceCents: null });
    seedLoanFull({ name: 'C', balanceCents: 1_000_00 });
    expect(loansTotalOwedCents()).toBe(1_500_00);
  });

  it('is zero with no loans at all', () => {
    expect(loansTotalOwedCents()).toBe(0);
  });
});
