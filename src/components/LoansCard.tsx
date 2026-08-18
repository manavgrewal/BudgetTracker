import { formatCents } from '@/lib/money';
import type { LoanSummary } from '@/lib/loans';
import { Card, CardHeader } from '@/components/ui/Card';
import { LoanProgressBar } from '@/components/LoanProgressBar';

/**
 * MUST-15.1: SELF-HIDING, in the manner of ExpiringSoonCard. The dashboard renders it
 * unconditionally; a household with no loans sees no card and no gap.
 *
 * MUST-15.2 / MUST-15.3: one row per loan carrying either field, the total in the header, the
 * payoff bar (Task 11's LoanProgressBar) when a fraction exists, and the next-payment date /
 * display-only interest rate when set.
 */
export function LoansCard({ loans, totalOwedCents }: { loans: LoanSummary[]; totalOwedCents: number }) {
  const shown = loans.filter((loan) => loan.currentBalanceCents !== null || loan.principalCents !== null);
  if (shown.length === 0) return null;

  // Review fix-round: a listed loan with a NULL balance renders '—' below rather than being
  // silently folded into totalOwedCents at 0 -- the hint says so next to the figure, so the
  // total doesn't read as "everything" when it is actually "everything we're tracking".
  const hasUntrackedBalance = shown.some((loan) => loan.currentBalanceCents === null);

  return (
    <Card>
      <CardHeader
        title="Loans"
        description="What the household still owes."
        action={
          <span className="flex items-center gap-2">
            {hasUntrackedBalance ? (
              <span className="text-xs text-subtle">(excludes loans without a tracked balance)</span>
            ) : null}
            <span className="money-lg" aria-label={`Total owed ${formatCents(totalOwedCents)}`}>
              {formatCents(totalOwedCents)}
            </span>
          </span>
        }
      />
      <ul className="border-t border-line text-sm">
        {shown.map((loan) => (
          <li key={loan.itemId} className="flex flex-col gap-1.5 border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
            <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="font-medium text-ink">{loan.name}</span>
              <span className="money whitespace-nowrap">
                {loan.currentBalanceCents === null ? '—' : formatCents(loan.currentBalanceCents)}
              </span>
            </span>
            {loan.payoffFraction === null ? null : <LoanProgressBar fraction={loan.payoffFraction} label={loan.name} />}
            <span className="flex flex-wrap gap-x-3 text-xs text-subtle">
              {loan.nextPaymentDate === null ? null : <span>Next payment {loan.nextPaymentDate}</span>}
              {loan.interestRateBps === null ? null : <span>Rate {(loan.interestRateBps / 100).toFixed(2)}%</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
