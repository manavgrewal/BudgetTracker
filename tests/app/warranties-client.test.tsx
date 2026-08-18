// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { WarrantiesClient } from '@/app/(app)/warranties/warranties-client';
import type { WarrantyListItem, WarrantySearchResult } from '@/lib/warranty/search';

afterEach(() => cleanup());

const TODAY = '2026-08-16';

function item(over: Partial<WarrantyListItem> = {}): WarrantyListItem {
  return {
    id: 1, name: 'Fridge', vendor: 'Home Depot', model: 'GDT645SYNFS', serial: null,
    purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false, expiryDate: '2028-08-16',
    priceCents: 129999, ownerUserId: 7, ownerName: 'Alice', transactionId: null,
    typeId: null, typeName: null, isSubscription: false, kind: 'warranty', notes: null,
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    billingCycle: null, billingAmountCents: null,
    principalCents: null, interestRateBps: null, currentBalanceCents: null, balanceUpdatedAt: null,
    status: 'active', receiptCount: 1,
    ...over,
  };
}

function result(rows: WarrantyListItem[], over: Partial<WarrantySearchResult> = {}): WarrantySearchResult {
  return { rows, total: rows.length, page: 1, pageCount: 1, ...over };
}

const people = [{ id: 7, name: 'Alice' }, { id: 8, name: 'Bob' }];
const types = [
  { id: 1, name: 'Appliance', kind: 'warranty' as const },
  { id: 2, name: 'Subscription', kind: 'subscription' as const },
];

function renderList(res: WarrantySearchResult, over: Partial<Parameters<typeof WarrantiesClient>[0]> = {}) {
  return render(
    <WarrantiesClient
      result={res}
      people={people}
      types={types}
      today={TODAY}
      query=""
      status=""
      owner=""
      typeId=""
      sort="expiry"
      {...over}
    />,
  );
}

describe('WarrantiesClient', () => {
  it('renders every column of §10.2', () => {
    const { container } = renderList(result([item()]));
    expect(screen.getByText('Fridge')).toBeTruthy();
    expect(screen.getByText('GDT645SYNFS')).toBeTruthy();
    expect(screen.getByText('Home Depot')).toBeTruthy();
    expect(screen.getByText('2026-08-16')).toBeTruthy();
    // Delta T9: the Expiry cell reads through expiryPhrase() -- "expires 2028-08-16" for a
    // non-subscription item -- rather than the bare date.
    expect(screen.getByText(/2028-08-16/)).toBeTruthy();
    // M15: the status filter's <select> now also spells out "Active" as an option label
    // (statusLabel(), not the raw 'active' code), and the owner filter's <select> lists
    // Alice by name -- scope both assertions to the table body to avoid a duplicate-text
    // ambiguity against those two filter controls.
    const tbodyText = container.querySelector('tbody')?.textContent;
    expect(tbodyText).toContain('Active');
    expect(tbodyText).toContain('Alice');
  });

  it('shows the expiring badge with a day count', () => {
    renderList(result([item({ status: 'expiring', expiryDate: '2026-09-15' })]));
    expect(screen.getByText('Expires in 30 days')).toBeTruthy();
  });

  it('drives ?q= from a GET form so a search is linkable and survives refresh', () => {
    const { container } = renderList(result([item()]), { query: 'fridge' });
    const form = container.querySelector('form[method="get"]')!;
    expect(form).toBeTruthy();
    const search = form.querySelector('input[name="q"]') as HTMLInputElement;
    expect(search.defaultValue).toBe('fridge');
    expect(form.querySelector('select[name="status"]')).toBeTruthy();
    expect(form.querySelector('select[name="owner"]')).toBeTruthy();
    expect(form.querySelector('select[name="sort"]')).toBeTruthy();
  });

  it('offers all six status filter options including unknown', () => {
    const { container } = renderList(result([item()]));
    const options = Array.from(container.querySelectorAll('select[name="status"] option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', 'active', 'expiring', 'expired', 'lifetime', 'unknown']);
  });

  // v1.2.2 Task 2: "No warranties yet" -> "Nothing tracked yet" (section rename to
  // Contracts & Coverage; the empty state now names all four kinds).
  it('distinguishes "nothing tracked yet" from "no matches for that search"', () => {
    renderList(result([]));
    expect(screen.getByText(/Nothing tracked yet/i)).toBeTruthy();
    expect(screen.getByText(/warranty, subscription, contract, or loan/i)).toBeTruthy();
    cleanup();
    renderList(result([]), { query: 'zzzz' });
    expect(screen.getByText(/No matches/i)).toBeTruthy();
  });

  // v1.2.2 Task 2: page title "Warranties" -> "Contracts & Coverage"; button "Add warranty"
  // -> "Add item" (section rename, labels only -- the route stays /warranties/new).
  it('titles the page "Contracts & Coverage" and offers Add item', () => {
    const { container } = renderList(result([item()]));
    expect(screen.getByText('Contracts & Coverage')).toBeTruthy();
    expect(screen.getByText('Add item')).toBeTruthy();
    expect(container.querySelector('a[href="/warranties/new"]')).toBeTruthy();
  });

  it('links each row to its detail page', () => {
    const { container } = renderList(result([item({ id: 42 })]));
    expect(container.querySelector('a[href="/warranties/42"]')).toBeTruthy();
  });

  it('surfaces the malformed-query message instead of a crash', () => {
    renderList(result([], { error: "That search couldn't be understood — try different words." }), { query: 'a"b' });
    expect(screen.getByText(/couldn't be understood/)).toBeTruthy();
  });

  // --- type-deltas.md T9 ---

  it('shows a Type column with the type name, or an em dash when untyped', () => {
    const { container } = renderList(
      result([item({ typeId: 1, typeName: 'Appliance' }), item({ id: 2, name: 'Netflix' })]),
    );
    const cells = Array.from(container.querySelectorAll('tbody td:nth-child(2)')).map((td) => td.textContent);
    expect(cells).toEqual(['Appliance', '—']);
  });

  it('offers a type filter select that composes with q/status/owner/sort', () => {
    const { container } = renderList(result([item()]), { typeId: '2' });
    const form = container.querySelector('form[method="get"]')!;
    const typeSelect = form.querySelector('select[name="typeId"]') as HTMLSelectElement;
    expect(typeSelect).toBeTruthy();
    expect(typeSelect.value).toBe('2');
    const optionValues = Array.from(typeSelect.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['', '1', '2']);
  });

  it('renders subscription rows with "cancel by" wording instead of "expires"', () => {
    renderList(
      result([
        item({
          status: 'expiring',
          expiryDate: '2026-09-15',
          typeId: 2,
          typeName: 'Subscription',
          isSubscription: true,
          kind: 'subscription',
        }),
      ]),
    );
    expect(screen.getByText('Cancel in 30 days')).toBeTruthy();
  });

  // v1.2.2 Task 2: kind now drives the row wording directly (isSubscription is kept on the
  // data row for backward compat, but the UI reads `kind`) -- contract/loan get their own verb.
  it('renders contract and loan rows with their own expiry verb', () => {
    renderList(
      result([
        item({ id: 10, expiryDate: '2028-08-16', kind: 'contract' }),
        item({ id: 11, expiryDate: '2028-08-16', kind: 'loan' }),
      ]),
    );
    expect(screen.getByText(/ends on 2028-08-16/)).toBeTruthy();
    expect(screen.getByText(/paid off by 2028-08-16/)).toBeTruthy();
  });

  // --- v1.3.0: open-ended display label (task B) ---

  it('shows the per-kind open-ended word in the Expiry cell instead of a blank/dash for an open-ended item', () => {
    const { container } = renderList(
      result([
        item({ id: 20, isLifetime: true, expiryDate: null, kind: 'warranty' }),
        item({ id: 21, isLifetime: true, expiryDate: null, kind: 'subscription' }),
        item({ id: 22, isLifetime: true, expiryDate: null, kind: 'contract' }),
        item({ id: 23, isLifetime: true, expiryDate: null, kind: 'loan' }),
      ]),
    );
    const cells = Array.from(container.querySelectorAll('tbody td:nth-child(5)')).map((td) => td.textContent);
    expect(cells).toEqual(['Lifetime', 'Lifetime', 'Ongoing', 'Open-ended']);
  });

  // --- v1.3.0: billing cycle and amount (task A) ---

  it('shows the Billing column with the formatted amount and cycle suffix when set', () => {
    const { container } = renderList(
      result([
        item({ id: 30, kind: 'subscription', typeId: 2, typeName: 'Subscription', billingCycle: 'monthly', billingAmountCents: 1599 }),
      ]),
    );
    const cell = container.querySelector('tbody td:nth-child(9)');
    expect(cell?.textContent).toBe('$15.99 / month');
  });

  it('shows an em dash in the Billing column for a warranty item and for an unset subscription', () => {
    const { container } = renderList(
      result([
        item({ id: 31, kind: 'warranty' }),
        item({ id: 32, kind: 'subscription', typeId: 2, typeName: 'Subscription' }),
      ]),
    );
    const cells = Array.from(container.querySelectorAll('tbody td:nth-child(9)')).map((td) => td.textContent);
    expect(cells).toEqual(['—', '—']);
  });

  // review fix: a partial pair must never render the amount alone (silently dropping the
  // cycle the member chose) nor the cycle alone against a blank amount -- both collapse to
  // a plain em dash, same as neither being set.
  it('shows an em dash for a partial billing pair, in either direction', () => {
    const { container } = renderList(
      result([
        item({ id: 33, kind: 'subscription', typeId: 2, typeName: 'Subscription', billingCycle: 'monthly', billingAmountCents: null }),
        item({ id: 34, kind: 'subscription', typeId: 2, typeName: 'Subscription', billingCycle: null, billingAmountCents: 1599 }),
      ]),
    );
    const cells = Array.from(container.querySelectorAll('tbody td:nth-child(9)')).map((td) => td.textContent);
    expect(cells).toEqual(['—', '—']);
  });
});
