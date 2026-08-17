import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME_MAX, USER_AGENT_MAX, renderEvent, truncateText } from '@/lib/notify/render';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('MUST-2.1: render.ts is pure', () => {
  it('imports neither @/db nor @/lib/env nor a node builtin', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/notify/render.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/env/);
    expect(source).not.toMatch(/from\s+['"]node:/);
  });
});

describe('MUST-6.14 / §10.1: coming_due', () => {
  it('uses the warranty verb for each kind rather than writing its own', () => {
    const base = {
      event: 'coming_due',
      itemName: 'Dishwasher',
      expiryDate: '2026-09-01',
      todayIso: '2026-08-17',
      vendor: null,
      priceCents: null,
    } as const;
    expect(renderEvent({ ...base, kind: 'loan' }).body).toContain('paid off by');
    expect(renderEvent({ ...base, kind: 'subscription' }).body).toContain('cancel by');
    expect(renderEvent({ ...base, kind: 'contract' }).body).toContain('ends on');
    expect(renderEvent({ ...base, kind: 'warranty' }).body).toContain('expires');
  });

  it('renders the subject, the days remaining, and the optional vendor and price', () => {
    const { subject, body } = renderEvent({
      event: 'coming_due',
      itemName: 'Netflix',
      kind: 'subscription',
      expiryDate: '2026-08-27',
      todayIso: '2026-08-17',
      vendor: 'Netflix Canada',
      priceCents: 2299,
    });
    expect(subject).toBe('Coming due: Netflix');
    expect(body).toContain('in 10 days');
    expect(body).toContain('Netflix Canada');
    expect(body).toContain('$22.99');
  });

  it('says "tomorrow" and "today" rather than "in 1 days" / "in 0 days"', () => {
    const base = { event: 'coming_due', itemName: 'X', kind: 'warranty', todayIso: '2026-08-17', vendor: null, priceCents: null } as const;
    expect(renderEvent({ ...base, expiryDate: '2026-08-18' }).body).toContain('tomorrow');
    expect(renderEvent({ ...base, expiryDate: '2026-08-17' }).body).toContain('today');
  });
});

describe('§10.1: budget events', () => {
  it('renders the threshold subject and body with formatted money', () => {
    const { subject, body } = renderEvent({
      event: 'budget_threshold',
      scope: 'household',
      categoryName: 'Groceries',
      month: '2026-08',
      pct: 82,
      spentCents: 41000,
      limitCents: 50000,
    });
    expect(subject).toBe('Budget 82%: Groceries (August 2026)');
    expect(body).toBe('Household Groceries budget for August 2026 is at 82% — $410.00 of $500.00, $90.00 left.');
  });

  it('omits the "left" clause when a single jump takes pct past 100% (MUST-6.17)', () => {
    const { body } = renderEvent({
      event: 'budget_threshold',
      scope: 'household',
      categoryName: 'Gas',
      month: '2026-08',
      pct: 200,
      spentCents: 20000,
      limitCents: 10000,
    });
    expect(body).toBe('Household Gas budget for August 2026 is at 200% — $200.00 of $100.00.');
    expect(body).not.toContain('left');
  });

  it('says "Your" for the personal scope', () => {
    const { body } = renderEvent({
      event: 'budget_threshold',
      scope: 'personal',
      categoryName: 'Coffee',
      month: '2026-08',
      pct: 90,
      spentCents: 4500,
      limitCents: 5000,
    });
    expect(body.startsWith('Your Coffee budget')).toBe(true);
  });

  it('renders the exceeded subject and the amount over', () => {
    const { subject, body } = renderEvent({
      event: 'budget_exceeded',
      scope: 'household',
      categoryName: 'Restaurants',
      month: '2026-08',
      spentCents: 61000,
      limitCents: 50000,
    });
    expect(subject).toBe('Over budget: Restaurants (August 2026)');
    expect(body).toBe('Household Restaurants budget for August 2026 is blown — $610.00 of $500.00, $110.00 over.');
  });
});

describe('§10.1: the operational events', () => {
  it('backup_failed points at Settings and states the sweep still ran', () => {
    const { subject, body } = renderEvent({ event: 'backup_failed', dateIso: '2026-08-17', error: 'ENOSPC: no space left' });
    expect(subject).toBe('Nightly backup failed');
    expect(body).toContain('2026-08-17');
    expect(body).toContain('ENOSPC: no space left');
    expect(body).toContain('The maintenance sweep still ran. Check Settings → Backups.');
  });

  it('new_signin names the time, zone, ip and browser and tells the reader what to do', () => {
    const { subject, body } = renderEvent({
      event: 'new_signin',
      name: 'Sam',
      atLabel: '2026-08-17 21:14',
      tz: 'America/Toronto',
      ip: '192.168.1.44',
      userAgent: 'Mozilla/5.0 (iPhone)',
    });
    expect(subject).toBe('New sign-in to your account');
    expect(body).toContain('Sam signed in at 2026-08-17 21:14 (America/Toronto) from 192.168.1.44.');
    expect(body).toContain('Mozilla/5.0 (iPhone)');
    expect(body).toContain('If this was not you, change your password in Settings.');
  });

  it('restore_outcome distinguishes success from failure', () => {
    const base = {
      event: 'restore_outcome',
      sourceName: 'budget-2026-08-16.tar.gz',
      requestedByUsername: 'manav',
      finishedAt: '2026-08-17T03:12:04.000Z',
      receiptsRestored: 12,
      missingReceiptRows: 1,
    } as const;
    expect(renderEvent({ ...base, status: 'success', error: null }).subject).toBe('Restore succeeded');
    const failed = renderEvent({ ...base, status: 'failed', error: 'checksum mismatch' });
    expect(failed.subject).toBe('Restore FAILED');
    expect(failed.body).toContain('checksum mismatch');
    expect(failed.body).toContain('budget-2026-08-16.tar.gz');
    expect(failed.body).toContain('manav');
    expect(failed.body).toContain('12');
  });

  it('stale_import states the weeks, the last import and why it matters', () => {
    const { subject, body } = renderEvent({ event: 'stale_import', weeks: 3, lastImportIso: '2026-07-27', daysAgo: 21 });
    expect(subject).toBe('No transactions imported in 3 weeks');
    expect(body).toContain('The last import was 2026-07-27 (21 days ago).');
    expect(body).toContain('Bank exports are how this app learns what you spent.');
  });
});

describe('§10.2: the weekly digest', () => {
  const full = {
    event: 'weekly_digest',
    fromIso: '2026-08-10',
    toIso: '2026-08-16',
    householdSpentCents: 128455,
    personalSpentCents: 41230,
    topCategories: [
      { name: 'Groceries', cents: 40211 },
      { name: 'Restaurants', cents: 18840 },
      { name: 'Gas', cents: 12100 },
    ],
    topMerchants: [
      { name: 'LOBLAWS', cents: 21055 },
      { name: 'PETRO-CANADA', cents: 12100 },
    ],
    reviewCount: 12,
    overBudget: ['Restaurants', 'Coffee'],
  } as const;

  it('renders the subject as the date range', () => {
    expect(renderEvent(full).subject).toBe('Weekly summary — 2026-08-10 to 2026-08-16');
  });

  it('renders every section of the spec example', () => {
    const { body } = renderEvent(full);
    expect(body).toContain('Household spend: $1,284.55');
    expect(body).toContain('Your spend:');
    expect(body).toContain('$412.30');
    expect(body).toContain('Top categories (household)');
    expect(body).toContain('Groceries');
    expect(body).toContain('$402.11');
    expect(body).toContain('Top merchants (household)');
    expect(body).toContain('LOBLAWS');
    expect(body).toContain('12 transactions still need review.');
    expect(body).toContain('Over budget this month: Restaurants, Coffee.');
  });

  it('an empty week still sends, with its own sentence', () => {
    const { body } = renderEvent({
      ...full,
      householdSpentCents: 0,
      personalSpentCents: 0,
      topCategories: [],
      topMerchants: [],
      reviewCount: 0,
      overBudget: [],
    });
    expect(body).toContain('No transactions were recorded this week.');
  });
});

describe('MUST-10.3: untrusted values are plain and truncated', () => {
  it('renders markup literally', () => {
    const { subject, body } = renderEvent({
      event: 'coming_due',
      itemName: '<b>x</b>',
      kind: 'warranty',
      expiryDate: '2026-09-01',
      todayIso: '2026-08-17',
      vendor: null,
      priceCents: null,
    });
    expect(subject).toContain('<b>x</b>');
    expect(body).toContain('<b>x</b>');
  });

  it('truncates names to 80 characters and user agents to 120', () => {
    expect(NAME_MAX).toBe(80);
    expect(USER_AGENT_MAX).toBe(120);
    expect(truncateText('a'.repeat(200), NAME_MAX)).toHaveLength(NAME_MAX);
    expect(truncateText('a'.repeat(200), NAME_MAX).endsWith('…')).toBe(true);
    expect(truncateText('short', NAME_MAX)).toBe('short');

    const { body } = renderEvent({
      event: 'new_signin',
      name: 'Sam',
      atLabel: '2026-08-17 21:14',
      tz: 'UTC',
      ip: '1.2.3.4',
      userAgent: 'U'.repeat(400),
    });
    expect(body).not.toContain('U'.repeat(USER_AGENT_MAX + 1));
  });
});

describe('MUST-10.4: no notification body contains a link', () => {
  it('none of the eight bodies contains a URL scheme', () => {
    const inputs: Parameters<typeof renderEvent>[0][] = [
      { event: 'coming_due', itemName: 'X', kind: 'warranty', expiryDate: '2026-09-01', todayIso: '2026-08-17', vendor: null, priceCents: null },
      { event: 'budget_threshold', scope: 'household', categoryName: 'C', month: '2026-08', pct: 80, spentCents: 1, limitCents: 2 },
      { event: 'budget_exceeded', scope: 'personal', categoryName: 'C', month: '2026-08', spentCents: 3, limitCents: 2 },
      { event: 'backup_failed', dateIso: '2026-08-17', error: 'e' },
      { event: 'weekly_digest', fromIso: '2026-08-10', toIso: '2026-08-16', householdSpentCents: 0, personalSpentCents: 0, topCategories: [], topMerchants: [], reviewCount: 0, overBudget: [] },
      { event: 'new_signin', name: 'S', atLabel: 'x', tz: 'UTC', ip: '1.2.3.4', userAgent: null },
      { event: 'restore_outcome', status: 'success', sourceName: 's', requestedByUsername: 'u', finishedAt: 'f', receiptsRestored: 0, missingReceiptRows: 0, error: null },
      { event: 'stale_import', weeks: 3, lastImportIso: '2026-07-27', daysAgo: 21 },
    ];
    for (const input of inputs) {
      const { subject, body } = renderEvent(input);
      expect(`${subject}\n${body}`).not.toMatch(/https?:\/\//);
    }
  });
});
