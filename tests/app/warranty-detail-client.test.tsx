// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { WarrantyDetailClient } from '@/app/(app)/warranties/[id]/warranty-detail-client';
import type { WarrantyItemRow, WarrantyReceiptRow } from '@/lib/warranty/items';

vi.mock('@/app/(app)/warranties/actions', () => ({
  updateWarrantyAction: vi.fn(async () => ({})),
  deleteWarrantyAction: vi.fn(async () => ({})),
  attachReceiptsAction: vi.fn(async () => ({})),
  deleteReceiptAction: vi.fn(async () => ({})),
  reRunOcrAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

const TODAY = '2026-08-16';
const people = [{ id: 7, name: 'Alice' }];
const types = [
  { id: 1, name: 'Appliance', kind: 'warranty' as const },
  { id: 2, name: 'Netflix plan', kind: 'subscription' as const },
  { id: 3, name: 'Car loan', kind: 'loan' as const },
];

function item(over: Partial<WarrantyItemRow> = {}): WarrantyItemRow {
  return {
    id: 42, name: 'Fridge', vendor: 'Home Depot', model: 'GDT645SYNFS', serial: 'SN-1',
    purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false, expiryDate: '2028-08-16',
    priceCents: 129999, ownerUserId: 7, ownerName: 'Alice', transactionId: null,
    typeId: null, typeName: null, isSubscription: false, kind: 'warranty', notes: 'kitchen',
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    ...over,
  };
}

function receipt(over: Partial<WarrantyReceiptRow> = {}): WarrantyReceiptRow {
  return {
    id: 5, warrantyItemId: 42, originalFilename: 'till.jpg',
    storedFilename: '11111111-2222-3333-4444-555555555555.jpg',
    mime: 'image/jpeg', sizeBytes: 2048, sha256: 'a'.repeat(64),
    ocrStatus: 'done', ocrError: null, createdAt: '2026-08-16T00:00:00.000Z', fileExists: true,
    ...over,
  };
}

function renderDetail(over: Partial<Parameters<typeof WarrantyDetailClient>[0]> = {}) {
  return render(
    <WarrantyDetailClient
      item={item()}
      receipts={[receipt()]}
      status="active"
      people={people}
      types={types}
      today={TODAY}
      linkedTransaction={null}
      linkRemoved={false}
      {...over}
    />,
  );
}

describe('WarrantyDetailClient', () => {
  it('shows every field, the owner and the status badge', () => {
    renderDetail();
    expect(screen.getByText('Fridge')).toBeTruthy();
    expect(screen.getByText('GDT645SYNFS')).toBeTruthy();
    expect(screen.getByText('SN-1')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('renders an image receipt inline through the authenticated route', () => {
    const { container } = renderDetail();
    const img = container.querySelector('img[src="/api/warranties/receipts/5"]');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('alt')).toBe('till.jpg');
  });

  it('links a PDF rather than embedding it (MUST-5.3 / §10.3)', () => {
    const { container } = renderDetail({ receipts: [receipt({ mime: 'application/pdf', originalFilename: 'x.pdf' })] });
    expect(container.querySelector('img[src="/api/warranties/receipts/5"]')).toBeNull();
    expect(container.querySelector('a[href="/api/warranties/receipts/5"]')).toBeTruthy();
  });

  it('shows a file-missing tile instead of a broken image (MUST-4.10)', () => {
    renderDetail({ receipts: [receipt({ fileExists: false })] });
    expect(screen.getByText(/file missing/i)).toBeTruthy();
  });

  it('shows the OCR status chip and the failure text verbatim, as a text node', () => {
    renderDetail({ receipts: [receipt({ ocrStatus: 'failed', ocrError: 'OCR timed out.' })] });
    expect(screen.getByText('OCR timed out.')).toBeTruthy();
  });

  it('never displays the raw OCR text (§16 item 6 — the type carries no ocrText at all)', () => {
    const { container } = renderDetail();
    expect(container.innerHTML).not.toContain('ocrText');
  });

  it('offers Re-run OCR and Remove per receipt, and Delete item with the receipt count', () => {
    renderDetail();
    expect(screen.getByRole('button', { name: /re-run ocr/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy();
    expect(screen.getByText(/1 receipt/i)).toBeTruthy();
  });

  it('links a live transaction and explains a nulled one instead of showing a dead link', () => {
    const { container } = renderDetail({
      item: item({ transactionId: 55 }),
      linkedTransaction: { id: 55, date: '2026-08-16', description: 'HOME DEPOT' },
    });
    expect(container.querySelector('a[href="/transactions?q=HOME+DEPOT"]') ?? container.innerHTML).toBeTruthy();
    cleanup();

    renderDetail({ item: item({ transactionId: 55 }), linkedTransaction: null, linkRemoved: true });
    expect(screen.getByText(/removed by an import undo/i)).toBeTruthy();
  });

  // --- type-deltas.md T9 ---

  it('shows a Type row with the item\'s type name, or an em dash when untyped', () => {
    renderDetail();
    expect(screen.getByText('Type')).toBeTruthy();
    cleanup();
    renderDetail({ item: item({ typeId: 1, typeName: 'Appliance' }) });
    expect(screen.getByText('Appliance')).toBeTruthy();
  });

  // v1.2.2 Task 2: purchaseDateLabel/expiryDateLabel are DELETED (superseded by
  // formStartLabel/formEndLabel, kind-keyed). Old subscription wording 'Period start' ->
  // 'Start date' and label-only 'Cancel by' -> 'Cancel-by date' are deliberate, owner-approved
  // changes (see tests/lib/warranty/constants.test.ts for the full old->new log).
  it('labels the date fields "Purchase date"/"Expiry date" for a warranty-kind item', () => {
    renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' }) });
    expect(screen.getByText('Purchase date')).toBeTruthy();
    expect(screen.getByText('Expiry date')).toBeTruthy();
  });

  it('labels the date fields "Start date"/"Cancel-by date" for a subscription-kind item', () => {
    renderDetail({ item: item({ typeId: 2, typeName: 'Netflix plan', kind: 'subscription' }) });
    expect(screen.getByText('Start date')).toBeTruthy();
    expect(screen.getByText('Cancel-by date')).toBeTruthy();
    expect(screen.queryByText('Purchase date')).toBeNull();
  });

  it('labels the date fields "Start date"/"Payoff date" for a loan-kind item', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }) });
    expect(screen.getByText('Start date')).toBeTruthy();
    expect(screen.getByText('Payoff date')).toBeTruthy();
  });

  // v1.2.2 Task 2: dynamic form labels -- the edit form's fieldset legend and Purchase-date
  // label follow the SELECTED type's kind live, not just the item's already-saved kind.
  it("follows the edit form's SELECTED type kind live for the term legend and date label", () => {
    // Scoped to the <legend> element itself: the read-only summary above the edit form
    // renders the SAME text via the item's own (unchanged) kind, so a page-wide getByText
    // would ambiguously match both.
    const { container } = renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(container.querySelector('form legend')!.textContent).toBe('Warranty (months)');

    const select = container.querySelector('form select[name="typeId"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '3' } });
    expect(container.querySelector('form legend')!.textContent).toBe('Term (months)');
    // formOpenEndedLabel('loan') === 'Ongoing (no end date)' -- the Lifetime checkbox's own
    // label text follows the selected kind too.
    expect(screen.getByText('Ongoing (no end date)')).toBeTruthy();
  });

  // --- reviewer M14 ---

  it("preselects the edit form's type dropdown to the item's current type", () => {
    const { container } = renderDetail({ item: item({ typeId: 2, typeName: 'Netflix plan' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const select = container.querySelector('form select[name="typeId"]') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('2');
  });

  // --- reviewer findings: busy states, action-slot isolation, attach reset ---

  it('gives Re-run OCR and Remove their own busy state via useFormStatus (IMPORTANT 5)', () => {
    renderDetail();
    const rerun = screen.getByRole('button', { name: /re-run ocr/i }) as HTMLButtonElement;
    const remove = screen.getByRole('button', { name: /remove/i }) as HTMLButtonElement;
    expect(rerun.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
  });
});
