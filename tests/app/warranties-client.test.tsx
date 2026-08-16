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
    typeId: null, typeName: null, isSubscription: false, notes: null,
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    status: 'active', receiptCount: 1,
    ...over,
  };
}

function result(rows: WarrantyListItem[], over: Partial<WarrantySearchResult> = {}): WarrantySearchResult {
  return { rows, total: rows.length, page: 1, pageCount: 1, ...over };
}

const people = [{ id: 7, name: 'Alice' }, { id: 8, name: 'Bob' }];
const types = [
  { id: 1, name: 'Appliance', isSubscription: false },
  { id: 2, name: 'Subscription', isSubscription: true },
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

  it('distinguishes "no warranties yet" from "no matches for that search"', () => {
    renderList(result([]));
    expect(screen.getByText(/No warranties yet/i)).toBeTruthy();
    cleanup();
    renderList(result([]), { query: 'zzzz' });
    expect(screen.getByText(/No matches/i)).toBeTruthy();
  });

  it('links each row to its detail page and offers Add warranty', () => {
    const { container } = renderList(result([item({ id: 42 })]));
    expect(container.querySelector('a[href="/warranties/42"]')).toBeTruthy();
    expect(container.querySelector('a[href="/warranties/new"]')).toBeTruthy();
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
        }),
      ]),
    );
    expect(screen.getByText('Cancel in 30 days')).toBeTruthy();
  });
});
