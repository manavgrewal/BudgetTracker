import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BACKFILL_MAX_GLOBAL,
  BACKFILL_WINDOW_MS,
  LOAN_BACKFILL_MAX,
  backfillLoanRule,
  checkLoanBackfill,
  resetLoanRateLimitsForTests,
  saveLoanRule,
  setLoanRateLimitClockForTests,
} from '@/lib/loans';
import { setupLoanTest, type LoanTestContext } from './fixtures';

let ctx: LoanTestContext;

beforeEach(() => {
  ctx = setupLoanTest();
});
afterEach(() => {
  ctx.t.cleanup();
  setLoanRateLimitClockForTests(null);
  resetLoanRateLimitsForTests();
});

describe('MUST-13.9 / MUST-13.10 / MUST-14.12: the backfill', () => {
  it('is off by default — saveLoanRule alone links nothing', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    ctx.spend('HONDA FIN SVC', -45_000, { date: '2026-02-01' });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    expect(ctx.balanceOf(itemId)).toBe(2_000_000);
    expect(ctx.t.sqlite.prepare('select count(*) as n from loan_payments').get()).toEqual({ n: 0 });
  });

  it('links only inside the 365-day window and reports the count and the total applied', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    ctx.spend('HONDA FIN SVC', -45_000, { date: '2026-02-01' });
    ctx.spend('HONDA FIN SVC', -45_000, { date: '2026-05-01' });
    ctx.spend('HONDA FIN SVC', -45_000, { date: '2024-01-01' }); // outside the window
    const ruleId = saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') })).toEqual({
      linked: 2,
      appliedCents: 90_000,
    });
    expect(ctx.balanceOf(itemId)).toBe(1_910_000);
  });

  it('stops at LOAN_BACKFILL_MAX', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 100_000_000 });
    for (let i = 0; i < LOAN_BACKFILL_MAX + 10; i += 1) ctx.spend('HONDA FIN SVC', -100, { date: '2026-05-01' });
    const ruleId = saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') }).linked).toBe(LOAN_BACKFILL_MAX);
  });

  it('the sixth backfill in a window is refused, and the bucket is global', () => {
    let now = 1_000_000;
    setLoanRateLimitClockForTests(() => now);
    resetLoanRateLimitsForTests();
    for (let i = 0; i < BACKFILL_MAX_GLOBAL; i += 1) expect(checkLoanBackfill().allowed).toBe(true);
    expect(checkLoanBackfill().allowed).toBe(false);
    now += BACKFILL_WINDOW_MS + 1;
    expect(checkLoanBackfill().allowed).toBe(true);
    setLoanRateLimitClockForTests(null);
  });
});
