// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ExpiringSoonCard, EXPIRING_WIDGET_LIMIT } from '@/components/warranty/ExpiringSoonCard';
import type { WarrantyListItem } from '@/lib/warranty/search';

afterEach(() => cleanup());

const TODAY = '2026-08-16';

function item(over: Partial<WarrantyListItem> = {}): WarrantyListItem {
  return {
    id: 1, name: 'Kettle', vendor: 'Canadian Tire', model: null, serial: null,
    purchaseDate: '2026-07-16', warrantyMonths: 1, isLifetime: false, expiryDate: '2026-08-26',
    priceCents: 4999, ownerUserId: 7, ownerName: 'Alice', transactionId: null,
    // type-deltas.md T6: WarrantyItemRow (and therefore WarrantyListItem) now requires these
    // fields unconditionally -- null/false/'warranty' is the "untyped item" shape (v1.2.2
    // adds `kind`, defaulting the same way isSubscription already did).
    typeId: null, typeName: null, isSubscription: false, kind: 'warranty',
    notes: null,
    createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
    billingCycle: null, billingAmountCents: null,
    principalCents: null, interestRateBps: null, currentBalanceCents: null, balanceUpdatedAt: null,
    status: 'expiring', receiptCount: 0,
    ...over,
  };
}

describe('ExpiringSoonCard (MUST-10.5)', () => {
  it('renders nothing at all when the list is empty', () => {
    const { container } = render(<ExpiringSoonCard items={[]} today={TODAY} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows name, vendor and the day count for each item', () => {
    render(<ExpiringSoonCard items={[item()]} today={TODAY} />);
    expect(screen.getByText('Kettle')).toBeTruthy();
    expect(screen.getByText('Canadian Tire')).toBeTruthy();
    expect(screen.getByText('Expires in 10 days')).toBeTruthy();
  });

  // v1.2.2 Task 2: dashboard widget title "Warranties expiring soon" -> "Coming due"
  // (section rename to Contracts & Coverage).
  it('titles the card "Coming due"', () => {
    render(<ExpiringSoonCard items={[item()]} today={TODAY} />);
    expect(screen.getByText('Coming due')).toBeTruthy();
  });

  it('caps at five and links to the filtered list', () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ id: i + 1, name: `Item ${i}` }));
    const { container } = render(<ExpiringSoonCard items={many} today={TODAY} />);
    expect(EXPIRING_WIDGET_LIMIT).toBe(5);
    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(container.querySelector('a[href="/warranties?status=expiring"]')).toBeTruthy();
  });

  it('links each row to its own detail page', () => {
    const { container } = render(<ExpiringSoonCard items={[item({ id: 42 })]} today={TODAY} />);
    expect(container.querySelector('a[href="/warranties/42"]')).toBeTruthy();
  });
});

describe('ExpiringSoonCard type badge and subscription wording (type-deltas.md T10)', () => {
  it('shows a type badge carrying the type name when the item has a type', () => {
    const { container } = render(
      <ExpiringSoonCard items={[item({ typeId: 3, typeName: 'Appliance' })]} today={TODAY} />,
    );
    const badge = container.querySelector('[data-testid="type-badge"]');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('Appliance');
  });

  it('renders no type badge slot at all when typeName is null', () => {
    const { container } = render(<ExpiringSoonCard items={[item({ typeName: null })]} today={TODAY} />);
    expect(container.querySelector('[data-testid="type-badge"]')).toBeNull();
  });

  it('shows the cancel-by DATE for a subscription item, not a day count (MUST-19.10/19.13)', () => {
    render(
      <ExpiringSoonCard
        items={[item({ typeId: 2, typeName: 'Subscription', isSubscription: true, kind: 'subscription', expiryDate: '2026-08-26' })]}
        today={TODAY}
      />,
    );
    expect(screen.getByText('Cancel by 2026-08-26')).toBeTruthy();
    expect(screen.queryByText('Expires in 10 days')).toBeNull();
    expect(screen.queryByText('Cancel in 10 days')).toBeNull();
  });

  it('keeps "Expires in N days" wording (a day count) for a warranty-kind item even when typed', () => {
    render(<ExpiringSoonCard items={[item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' })]} today={TODAY} />);
    expect(screen.getByText('Expires in 10 days')).toBeTruthy();
    expect(screen.queryByText('Cancel by 2026-08-26')).toBeNull();
  });

  // v1.2.2 Task 2: contract/loan get the same date-style treatment as subscription --
  // day-count stays exclusive to the warranty kind.
  it('shows the end DATE (not a day count) for contract and loan kinds', () => {
    render(
      <ExpiringSoonCard
        items={[
          item({ id: 20, typeId: 4, typeName: 'Gym contract', kind: 'contract', expiryDate: '2026-08-26' }),
          item({ id: 21, typeId: 5, typeName: 'Car loan', kind: 'loan', expiryDate: '2026-08-26' }),
        ]}
        today={TODAY}
      />,
    );
    expect(screen.getByText('Ends on 2026-08-26')).toBeTruthy();
    expect(screen.getByText('Paid off by 2026-08-26')).toBeTruthy();
  });
});
