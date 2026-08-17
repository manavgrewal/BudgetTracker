import { describe, it, expect } from 'vitest';
import {
  ITEM_KINDS,
  ITEM_KIND_LABELS,
  coveredThroughLabel,
  expiryDateLabel,
  expiryNoun,
  expiryNounForKind,
  expiryPhrase,
  expiryPhraseForKind,
  expiringSoonLabel,
  expiringSoonLabelForKind,
  formOpenEndedLabel,
  formStartLabel,
  formTermLabel,
  isItemKind,
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

describe('item kinds (v1.2.2 — Contracts & Coverage)', () => {
  it('lists the four kinds and recognises them with the guard', () => {
    expect(ITEM_KINDS).toEqual(['warranty', 'subscription', 'contract', 'loan']);
    for (const kind of ITEM_KINDS) expect(isItemKind(kind)).toBe(true);
    expect(isItemKind('lease')).toBe(false);
  });

  it('has a human label for every kind, for the admin select', () => {
    expect(ITEM_KIND_LABELS).toEqual({
      warranty: 'Warranty',
      subscription: 'Subscription',
      contract: 'Contract',
      loan: 'Loan',
    });
  });

  it('matches the user-approved wording matrix exactly', () => {
    expect(formStartLabel('warranty')).toBe('Purchase date');
    expect(formTermLabel('warranty')).toBe('Warranty (months)');
    expect(expiryNounForKind('warranty')).toBe('expires');
    expect(formOpenEndedLabel('warranty')).toBe('Lifetime warranty');

    expect(formStartLabel('subscription')).toBe('Start date');
    expect(formTermLabel('subscription')).toBe('Duration (months)');
    expect(expiryNounForKind('subscription')).toBe('cancel by');
    expect(formOpenEndedLabel('subscription')).toBe('Ongoing (no end date)');

    expect(formStartLabel('contract')).toBe('Start date');
    expect(formTermLabel('contract')).toBe('Term (months)');
    expect(expiryNounForKind('contract')).toBe('ends on');
    expect(formOpenEndedLabel('contract')).toBe('Open-ended');

    expect(formStartLabel('loan')).toBe('Start date');
    expect(formTermLabel('loan')).toBe('Term (months)');
    expect(expiryNounForKind('loan')).toBe('paid off by');
    expect(formOpenEndedLabel('loan')).toBe('Ongoing (no end date)');
  });

  it('builds the expiry phrase for every kind', () => {
    expect(expiryPhraseForKind('warranty', '2027-03-01')).toBe('expires 2027-03-01');
    expect(expiryPhraseForKind('subscription', '2027-03-01')).toBe('cancel by 2027-03-01');
    expect(expiryPhraseForKind('contract', '2027-03-01')).toBe('ends on 2027-03-01');
    expect(expiryPhraseForKind('loan', '2027-03-01')).toBe('paid off by 2027-03-01');
  });

  it('builds the day-count expiring-soon badge label for every kind', () => {
    expect(expiringSoonLabelForKind('warranty', 12)).toBe('Expires in 12 days');
    expect(expiringSoonLabelForKind('subscription', 1)).toBe('Cancel in 1 day');
    expect(expiringSoonLabelForKind('contract', 0)).toBe('Ends today');
    expect(expiringSoonLabelForKind('loan', 3)).toBe('Paid off in 3 days');
  });

  it('the boolean helpers are thin wrappers that produce identical text to before (compile-compat)', () => {
    expect(expiryNoun(false)).toBe(expiryNounForKind('warranty'));
    expect(expiryNoun(true)).toBe(expiryNounForKind('subscription'));
    expect(expiryPhrase(false, '2027-03-01')).toBe(expiryPhraseForKind('warranty', '2027-03-01'));
    expect(expiryPhrase(true, '2027-03-01')).toBe(expiryPhraseForKind('subscription', '2027-03-01'));
    expect(expiringSoonLabel(false, 12)).toBe(expiringSoonLabelForKind('warranty', 12));
    expect(expiringSoonLabel(true, 12)).toBe(expiringSoonLabelForKind('subscription', 12));
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
