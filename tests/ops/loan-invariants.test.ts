import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function srcFiles(dir = path.join(root, 'src'), acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * The repo's established stripComments pattern (see tests/ops/install.test.ts), so a docblock
 * that MENTIONS `tx.delete(transactions)` in prose -- loans.ts's own reverseLoanLinksForTransactions
 * comment does exactly that -- can't false-trip this scan into reporting a second delete site.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('MUST-13.16: exactly one place deletes a transaction row', () => {
  it('is undoImport, which must reverse the loan links first', () => {
    const sites = srcFiles()
      .filter((file) => /(?<![.\w])tx\.delete\(transactions\)/.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    expect(
      sites,
      'A second transaction-delete path must call reverseLoanLinksForTransactions() BEFORE the delete: the ON DELETE CASCADE removes the link rows, but a cascade cannot restore a balance.',
    ).toEqual(['src/lib/import/commit.ts']);

    const commit = read('src/lib/import/commit.ts');
    expect(commit.indexOf('reverseLoanLinksForTransactions')).toBeLessThan(commit.indexOf('tx.delete(transactions)'));
  });
});

describe('MUST-13.1: the interest rate is display only', () => {
  it('no arithmetic operator is ever applied to interestRateBps in src/lib/loans.ts', () => {
    const offenders = read('src/lib/loans.ts')
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter((entry) => !entry.line.startsWith('//') && !entry.line.startsWith('*'))
      .filter((entry) => /interestRateBps\s*[*/+-]|[*/+-]\s*interestRateBps/.test(entry.line));
    expect(offenders).toEqual([]);
  });
});

describe('MUST-13.2: loan payments are invisible to every spend calculation', () => {
  it('budgets, reports and the categorizer never read the link table', () => {
    for (const file of ['src/lib/budgets.ts', 'src/lib/reports.ts', 'src/lib/categorize/engine.ts']) {
      const source = read(file);
      expect({ file, hit: /loan_payments|loanPayments/.test(source) }).toEqual({ file, hit: false });
    }
  });
});
