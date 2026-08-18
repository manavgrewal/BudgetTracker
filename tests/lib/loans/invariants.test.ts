import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const srcDir = path.join(root, 'src');
const rel = (file: string) => path.relative(root, file).replace(/\\/g, '/');

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** The raw text between a `(` and its matching `)`, counting parens from `from`. */
function parenBody(source: string, openParenIndex: number): string {
  let depth = 1;
  let i = openParenIndex + 1;
  const start = i;
  while (i < source.length && depth > 0) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') depth -= 1;
    i += 1;
  }
  return source.slice(start, i - 1);
}

/**
 * Every `.set({...})` argument list belonging to a `.update(transactions)` call, as raw
 * text. Scoped to the `transactions` table specifically -- `amountCents` is also a column on
 * `budgets` (src/lib/budgets.ts edits it freely and correctly), so a table-agnostic scan for
 * the property name alone would false-positive on an unrelated table.
 *
 * Not a real parser -- like the rest of this repo's source-scan tests (see
 * tests/ops/notify-egress.test.ts), this is a deliberately simple, good-enough check over this
 * codebase's own consistent style (`.update(transactions).set({ ... })` as one fluent chain),
 * not a general-purpose TS parser.
 */
function transactionsSetBlocks(source: string): string[] {
  const blocks: string[] = [];
  const updateCall = /\.update\(\s*transactions\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = updateCall.exec(source)) !== null) {
    const setKeyword = source.indexOf('.set(', match.index);
    if (setKeyword === -1) continue;
    blocks.push(parenBody(source, setKeyword + '.set'.length));
  }
  return blocks;
}

describe('NEW-4 fix-round: transactions.amount_cents stays immutable after insert', () => {
  it('no .update(transactions).set({...}) anywhere under src/ writes amountCents', () => {
    // src/lib/loans.ts's sign-recovery reversal (unassignTransactionFromLoan,
    // reverseLoanLinksForTransactions) and debtOverTime() all re-derive a loan_payments
    // row's direction from the LINKED TRANSACTION's amount_cents at read time, rather than
    // storing the sign a second time on the link row itself. That is only correct load-bearing
    // arithmetic if amount_cents genuinely never changes after the row is created — see the
    // comment on transactions.amountCents in src/db/schema.ts. A future edit feature that
    // wrote a corrected amount onto an existing row would silently invalidate every historical
    // loan balance reconstruction without touching a single line in loans.ts.
    const offenders: { file: string; snippet: string }[] = [];
    for (const file of filesUnder(srcDir)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const block of transactionsSetBlocks(source)) {
        if (/\bamountCents\s*:/.test(block)) {
          offenders.push({ file: rel(file), snippet: block.trim().slice(0, 120) });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sanity check: the scanner actually finds .update(transactions).set({...}) blocks when they exist', () => {
    // Guards against the scanner itself silently matching nothing (e.g. a future refactor of
    // this test's regex) and the invariant above passing for the wrong reason.
    const engineSource = fs.readFileSync(path.join(srcDir, 'lib/categorize/engine.ts'), 'utf8');
    const blocks = transactionsSetBlocks(engineSource);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((block) => block.includes('categoryId'))).toBe(true);
  });

  it('sanity check: an unrelated table\'s amountCents column (budgets) is correctly ignored', () => {
    const budgetsSource = fs.readFileSync(path.join(srcDir, 'lib/budgets.ts'), 'utf8');
    expect(budgetsSource).toMatch(/\.set\(\{\s*amountCents/); // the property really is written there
    expect(transactionsSetBlocks(budgetsSource)).toEqual([]); // but never via .update(transactions)
  });
});
