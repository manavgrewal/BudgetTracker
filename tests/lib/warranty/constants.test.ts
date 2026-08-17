import { describe, it, expect } from 'vitest';
import {
  ITEM_KINDS,
  ITEM_KIND_LABELS,
  coveredThroughLabelForKind,
  expiryNoun,
  expiryNounForKind,
  expiryPhrase,
  expiryPhraseForKind,
  expiringSoonLabel,
  expiringSoonLabelForKind,
  formEndLabel,
  formOpenEndedLabel,
  formStartLabel,
  formTermLabel,
  isItemKind,
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
});

/**
 * v1.2.2 Task 2 controller ruling: `purchaseDateLabel`, `termLabel`, `expiryDateLabel` and
 * `coveredThroughLabel` (the boolean-keyed detail/form label helpers) are DELETED, superseded
 * by the kind-keyed matrix below -- not kept as wrappers, unlike expiryNoun/expiryPhrase/
 * expiringSoonLabel above. The owner approved the resulting wording changes as deliberate.
 * Old -> new, logged here so the change is traceable from the test that used to pin the old
 * text:
 *
 *   purchaseDateLabel(false)      'Purchase date'    -> formStartLabel('warranty')      'Purchase date'    (same)
 *   purchaseDateLabel(true)       'Period start'      -> formStartLabel('subscription')  'Start date'       (CHANGED)
 *   termLabel(false)              'Warranty length'   -> formTermLabel('warranty')       'Warranty (months)'(CHANGED)
 *   termLabel(true)               'Period length'     -> formTermLabel('subscription')   'Duration (months)'(CHANGED)
 *   expiryDateLabel(false)        'Expiry date'       -> formEndLabel('warranty')        'Expiry date'      (same)
 *   expiryDateLabel(true)         'Cancel by'         -> formEndLabel('subscription')    'Cancel-by date'   (CHANGED)
 *   coveredThroughLabel(false)    'Covered through'   -> coveredThroughLabelForKind('warranty')     'Covered through'  (same)
 *   coveredThroughLabel(true)     'Cancel by'         -> coveredThroughLabelForKind('subscription') 'Active through'   (CHANGED)
 */
describe('kind-keyed form/detail labels (v1.2.2 Task 2 — supersede the boolean helpers)', () => {
  it('formStartLabel matches the approved matrix, including the changed subscription wording', () => {
    expect(formStartLabel('warranty')).toBe('Purchase date');
    expect(formStartLabel('subscription')).toBe('Start date');
    expect(formStartLabel('contract')).toBe('Start date');
    expect(formStartLabel('loan')).toBe('Start date');
  });

  it('formTermLabel matches the approved matrix, including the changed warranty/subscription wording', () => {
    expect(formTermLabel('warranty')).toBe('Warranty (months)');
    expect(formTermLabel('subscription')).toBe('Duration (months)');
    expect(formTermLabel('contract')).toBe('Term (months)');
    expect(formTermLabel('loan')).toBe('Term (months)');
  });

  it('formEndLabel supersedes expiryDateLabel, including the changed subscription wording', () => {
    expect(formEndLabel('warranty')).toBe('Expiry date');
    expect(formEndLabel('subscription')).toBe('Cancel-by date');
    expect(formEndLabel('contract')).toBe('End date');
    expect(formEndLabel('loan')).toBe('Payoff date');
  });

  it('coveredThroughLabelForKind supersedes coveredThroughLabel, including the changed subscription wording', () => {
    expect(coveredThroughLabelForKind('warranty')).toBe('Covered through');
    expect(coveredThroughLabelForKind('subscription')).toBe('Active through');
    expect(coveredThroughLabelForKind('contract')).toBe('In effect through');
    expect(coveredThroughLabelForKind('loan')).toBe('Term runs through');
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
