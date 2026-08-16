import { describe, it, expect } from 'vitest';
import {
  MAX_SUGGESTED_PRICE_CENTS,
  suggestFromOcrText,
  suggestPriceCents,
  suggestPurchaseDate,
  suggestVendor,
} from '@/lib/warranty/suggest';

const TODAY = '2026-08-16';

describe('suggestPurchaseDate', () => {
  it('reads ISO, slash, DD Mon YYYY and Mon D, YYYY shapes', () => {
    expect(suggestPurchaseDate('Sold on 2026-07-04 thanks', TODAY)).toBe('2026-07-04');
    expect(suggestPurchaseDate('Date: 04/07/2026', TODAY)).toBe('2026-04-07');
    expect(suggestPurchaseDate('16 Aug 2026', TODAY)).toBe('2026-08-16');
    expect(suggestPurchaseDate('Aug 16, 2026', TODAY)).toBe('2026-08-16');
    expect(suggestPurchaseDate('4-7-26', TODAY)).toBe('2026-04-07');
  });

  it('applies the ambiguity ladder in order (§8.1 step 3)', () => {
    expect(suggestPurchaseDate('13/05/2026', TODAY)).toBe('2026-05-13'); // A > 12 -> DD/MM
    expect(suggestPurchaseDate('05/13/2026', TODAY)).toBe('2026-05-13'); // B > 12 -> MM/DD
    expect(suggestPurchaseDate('05/06/2026', TODAY)).toBe('2026-05-06'); // default MM/DD
  });

  it('discards impossible, future and >20-year-old dates', () => {
    expect(suggestPurchaseDate('02/30/2026', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('2027-01-01', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('1990-01-01', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('2006-08-16', TODAY)).toBe('2006-08-16'); // exactly 20 years: kept
    expect(suggestPurchaseDate('2006-08-15', TODAY)).toBeUndefined();
  });

  it('takes the earliest occurrence in the text, not the earliest date', () => {
    const receipt = ['HOME DEPOT', 'Purchased 2026-08-16', 'Return by 2026-09-15', 'Promo ends 2026-01-05'].join('\n');
    expect(suggestPurchaseDate(receipt, TODAY)).toBe('2026-08-16');
  });

  it('returns undefined for text with no date', () => {
    expect(suggestPurchaseDate('THANK YOU FOR SHOPPING', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('', TODAY)).toBeUndefined();
  });
});

describe('suggestVendor', () => {
  it('picks the first plausible line among the first five', () => {
    expect(suggestVendor('HOME DEPOT #7042\n123 Main St\nTOTAL 45.00')).toBe('HOME DEPOT #7042');
  });

  it('skips phone, www, receipt/invoice/order headers and digit-led lines', () => {
    const text = ['www.rona.ca', 'TEL 514-555-0134', '4412', 'RECEIPT', 'RONA L’ENTREPÔT'].join('\n');
    expect(suggestVendor(text)).toBe('RONA L’ENTREPÔT');
  });

  it('skips lines with fewer than three letters and collapses whitespace', () => {
    expect(suggestVendor('== $$ ==\n  BEST   BUY   CANADA  \n')).toBe('BEST BUY CANADA');
  });

  it('never looks past the fifth non-empty line', () => {
    const text = ['1', '2', '3', '4', '5', 'CANADIAN TIRE'].join('\n');
    expect(suggestVendor(text)).toBeUndefined();
  });

  it('caps at 60 characters and does not title-case', () => {
    const long = 'a'.repeat(80);
    expect(suggestVendor(long)).toHaveLength(60);
    expect(suggestVendor('canadian tire')).toBe('canadian tire');
  });

  it('returns undefined for empty text', () => {
    expect(suggestVendor('')).toBeUndefined();
  });
});

describe('suggestPriceCents', () => {
  it('prefers the TOTAL line over SUBTOTAL', () => {
    const text = ['SUBTOTAL   40.00', 'GST         2.00', 'TOTAL      42.00'].join('\n');
    expect(suggestPriceCents(text)).toBe(4200);
  });

  it('takes the LAST total line when several match', () => {
    const text = ['TOTAL       10.00', 'BALANCE DUE 42.00'].join('\n');
    expect(suggestPriceCents(text)).toBe(4200);
  });

  it('takes the LAST currency number on that line', () => {
    expect(suggestPriceCents('TOTAL 3 items 129.99')).toBe(12999);
  });

  it('never reads a SUBTOTAL line as the total', () => {
    expect(suggestPriceCents('SUB-TOTAL 99.99')).toBe(9999); // fallback path, not the total path
    expect(suggestPriceCents('SUBTOTAL 99.99\nTOTAL 105.99')).toBe(10599);
  });

  it('falls back to the largest currency amount anywhere', () => {
    expect(suggestPriceCents('Item A 12.00\nItem B 145.50\nCash 200.00 Change 54.50')).toBe(20000);
  });

  it('handles thousands separators and a dollar sign', () => {
    expect(suggestPriceCents('TOTAL $1,299.99')).toBe(129999);
  });

  it('ignores anything at or above the $100,000 noise ceiling', () => {
    expect(MAX_SUGGESTED_PRICE_CENTS).toBe(10_000_000);
    expect(suggestPriceCents('BARCODE 9876543210.99\nTOTAL 45.00')).toBe(4500);
    expect(suggestPriceCents('BARCODE 9876543210.99')).toBeUndefined();
  });

  it('returns undefined when nothing looks like money', () => {
    expect(suggestPriceCents('THANK YOU')).toBeUndefined();
    expect(suggestPriceCents('')).toBeUndefined();
  });

  it('always returns an integer positive magnitude', () => {
    const cents = suggestPriceCents('TOTAL -42.00');
    expect(cents).toBe(4200);
    expect(Number.isInteger(cents)).toBe(true);
  });
});

describe('suggestFromOcrText', () => {
  it('combines all three on a realistic receipt', () => {
    const receipt = [
      'HOME DEPOT #7042',
      '1000 boul. Cure-Labelle, Laval QC',
      'TEL 450-555-0199',
      '08/16/2026  14:32',
      'GE FRIDGE GDT645SYNFS   1,299.99',
      'SUBTOTAL              1,299.99',
      'TPS/GST                  65.00',
      'TOTAL                 1,494.49',
    ].join('\n');
    expect(suggestFromOcrText(receipt, TODAY)).toEqual({
      purchaseDate: '2026-08-16',
      vendor: 'HOME DEPOT #7042',
      priceCents: 149449,
    });
  });

  it('returns an empty object for empty text, with each field independently optional', () => {
    expect(suggestFromOcrText('', TODAY)).toEqual({});
    expect(suggestFromOcrText('CANADIAN TIRE', TODAY)).toEqual({ vendor: 'CANADIAN TIRE' });
  });
});
