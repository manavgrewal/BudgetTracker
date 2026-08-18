import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { commitImport, undoImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import type { CandidateRow } from '@/lib/import/parse';
import {
  applyLoanMatchers,
  assignTransactionToLoan,
  debtOverTime,
  deleteLoanRule,
  listLoanRules,
  loansTotalOwedCents,
  saveLoanRule,
  unassignTransactionFromLoan,
} from '@/lib/loans';
import { categoryBreakdown } from '@/lib/reports';
import { setupLoanTest, type LoanTestContext } from '../lib/loans/fixtures';

/** MUST-19.5 / AC5: the loan feature end to end, against a real (temp-file) SQLite db. */

let ctx: LoanTestContext;

beforeEach(() => {
  ctx = setupLoanTest();
});
afterEach(() => {
  ctx.t.cleanup();
  vi.restoreAllMocks();
});

function row(over: { rawDescription: string; amountCents: number; date: string }): CandidateRow {
  return { rowIndex: 0, rawDate: over.date, date: over.date, rawDescription: over.rawDescription, amountCents: over.amountCents, cells: [] };
}

/** Commits a batch of rows and runs the SAME two post-commit steps commitStagedImport's real
 *  pipeline runs (loan matching), so this is the loan-relevant half of a real CSV import
 *  without pulling in the CSV-parsing/staging machinery that other suites already cover. */
function importRows(filename: string, rows: CandidateRow[]) {
  const hashed = computeRowHashes(ctx.accountId, rows);
  const committed = commitImport({ accountId: ctx.accountId, profileId: null, filename, importedBy: ctx.userId, rows: hashed, errors: [] });
  const loanLinksCreated = applyLoanMatchers(committed.insertedTransactionIds);
  return { ...committed, loanLinksCreated };
}

function deleteEveryRule(itemId: number): void {
  for (const rule of listLoanRules(itemId)) deleteLoanRule(rule.id);
}

it('MUST-19.5: create -> rule -> import -> undo -> re-import -> manual assign -> unassign', () => {
  // A loan item with a principal, a rate, a balance and a monthly payment.
  const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000, principalCents: 2_800_000 });
  saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });

  // A batch with two matching payments and one non-matching row.
  const rows = [
    row({ rawDescription: 'HONDA FIN SVC', amountCents: -45_000, date: '2026-08-01' }),
    row({ rawDescription: 'HONDA FIN SVC', amountCents: -45_000, date: '2026-08-02' }),
    row({ rawDescription: 'GROCERY STORE', amountCents: -12_000, date: '2026-08-03' }),
  ];
  const hashed = computeRowHashes(ctx.accountId, rows);
  const committed = commitImport({ accountId: ctx.accountId, profileId: null, filename: 'honda.csv', importedBy: ctx.userId, rows: hashed, errors: [] });

  // MUST-13.2: snapshot taken AFTER the transactions exist but BEFORE they are linked, so this
  // isolates the effect of LINKING specifically (importing itself obviously changes what
  // exists to report on; linking must not additionally change how it is reported).
  const breakdownBeforeLink = categoryBreakdown({ from: '2026-01-01', to: '2026-12-31' });

  const loanLinksCreated = applyLoanMatchers(committed.insertedTransactionIds);
  expect(loanLinksCreated).toBe(2);
  expect(ctx.balanceOf(itemId)).toBe(2_000_000 - 90_000);

  // MUST-13.2: the category totals are UNCHANGED by the linking.
  expect(categoryBreakdown({ from: '2026-01-01', to: '2026-12-31' })).toEqual(breakdownBeforeLink);

  // The dashboard summary and the debt series agree with the balance.
  expect(loansTotalOwedCents()).toBe(1_910_000);
  expect(debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' }).at(-1)!.owedCents).toBe(1_910_000);

  // Undo restores the balance to exactly what it was...
  const undone = undoImport(committed.importId);
  expect(undone.loanLinksReversed).toBe(2);
  expect(ctx.balanceOf(itemId)).toBe(2_000_000);

  // ...and re-importing drops it by exactly the same amount again.
  const second = importRows('honda-again.csv', [
    row({ rawDescription: 'HONDA FIN SVC', amountCents: -45_000, date: '2026-08-01' }),
    row({ rawDescription: 'HONDA FIN SVC', amountCents: -45_000, date: '2026-08-02' }),
    row({ rawDescription: 'GROCERY STORE', amountCents: -12_000, date: '2026-08-03' }),
  ]);
  expect(second.loanLinksCreated).toBe(2);
  expect(ctx.balanceOf(itemId)).toBe(1_910_000);

  // A manual assign and unassign leave the balance unchanged end to end.
  const unrelated = ctx.spend('COFFEE', -500);
  assignTransactionToLoan({ txnId: unrelated, itemId });
  expect(ctx.balanceOf(itemId)).toBe(1_909_500);
  unassignTransactionFromLoan({ txnId: unrelated, itemId });
  expect(ctx.balanceOf(itemId)).toBe(1_910_000);
});

it('AC5: a 500-row import with NO loan rules performs exactly one extra (dormancy) query and writes no link', () => {
  const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
  deleteEveryRule(itemId); // no rules at all: the loans-side dormancy bail (MUST-13.3) applies

  const rows: CandidateRow[] = [];
  for (let i = 0; i < 500; i += 1) rows.push(row({ rawDescription: `MERCHANT ${i}`, amountCents: -(1_000 + i), date: '2026-08-01' }));
  const hashed = computeRowHashes(ctx.accountId, rows);
  const committed = commitImport({ accountId: ctx.accountId, profileId: null, filename: 'bulk.csv', importedBy: ctx.userId, rows: hashed, errors: [] });
  expect(committed.insertedTransactionIds).toHaveLength(500);

  let prepared = 0;
  const original = ctx.t.sqlite.prepare.bind(ctx.t.sqlite);
  vi.spyOn(ctx.t.sqlite, 'prepare').mockImplementation(((sqlText: string) => {
    prepared += 1;
    return original(sqlText);
  }) as typeof ctx.t.sqlite.prepare);

  const loanLinksCreated = applyLoanMatchers(committed.insertedTransactionIds);
  expect(loanLinksCreated).toBe(0);
  // The ONE indexed read of activeRules() -- MUST-13.3's dormancy bail -- and nothing else:
  // a household with no loan rules pays one query per import, not a query per row.
  expect(prepared).toBe(1);
  expect((ctx.t.sqlite.prepare('select count(*) as n from loan_payments').get() as { n: number }).n).toBe(0);
});
