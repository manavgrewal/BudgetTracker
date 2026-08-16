import { describe, it, expect } from 'vitest';
import {
  coveredThroughLabel,
  expiryDateLabel,
  expiryNoun,
  expiryPhrase,
  purchaseDateLabel,
  termLabel,
} from '@/lib/warranty/constants';

describe('subscription wording (MUST-19.10 / MUST-19.11)', () => {
  it('swaps the expiry noun on the flag and nothing else', () => {
    expect(expiryNoun(false)).toBe('expires');
    expect(expiryNoun(true)).toBe('cancel by');
  });

  it('builds the list/widget phrase', () => {
    expect(expiryPhrase(false, '2027-03-01')).toBe('expires 2027-03-01');
    expect(expiryPhrase(true, '2027-03-01')).toBe('cancel by 2027-03-01');
  });

  it('labels the detail page dates as a subscription period', () => {
    expect(purchaseDateLabel(false)).toBe('Purchase date');
    expect(purchaseDateLabel(true)).toBe('Period start');
    expect(termLabel(false)).toBe('Warranty length');
    expect(termLabel(true)).toBe('Period length');
    expect(expiryDateLabel(false)).toBe('Expiry date');
    expect(expiryDateLabel(true)).toBe('Cancel by');
    expect(coveredThroughLabel(false)).toBe('Covered through');
    expect(coveredThroughLabel(true)).toBe('Cancel by');
  });
});

describe('client safety (Ruling P4)', () => {
  it('imports nothing from the database layer', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/warranty/constants.ts'), 'utf8');
    // A client component imports this module; a db import would pull better-sqlite3
    // into the browser bundle.
    expect(source).not.toMatch(/from '@\/db\//);
    expect(source).not.toMatch(/better-sqlite3|drizzle-orm/);
  });
});
