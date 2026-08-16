import { describe, it, expect } from 'vitest';
import { parseAmountToCents, formatCents, sumCents, netSpentCents, absCents, pctOf } from '@/lib/money';

describe('parseAmountToCents', () => {
  it('parses plain decimals', () => {
    expect(parseAmountToCents('12.34')).toBe(1234);
    expect(parseAmountToCents('0.05')).toBe(5);
    expect(parseAmountToCents('100')).toBe(10000);
    expect(parseAmountToCents('100.')).toBe(10000);
    expect(parseAmountToCents('.5')).toBe(50);
  });

  it('parses negatives, currency symbols, thousands separators and padding', () => {
    expect(parseAmountToCents('-12.34')).toBe(-1234);
    expect(parseAmountToCents('$1,234.56')).toBe(123456);
    expect(parseAmountToCents('  -$1,234.56 ')).toBe(-123456);
    expect(parseAmountToCents('CAD 45.00')).toBe(4500);
  });

  it('parses accounting parentheses as negative', () => {
    expect(parseAmountToCents('(12.34)')).toBe(-1234);
    expect(parseAmountToCents('($1,000.00)')).toBe(-100000);
  });

  it('parses the unicode minus sign banks sometimes emit', () => {
    expect(parseAmountToCents('−12.34')).toBe(-1234);
  });

  it('rounds half away from zero at the cent', () => {
    expect(parseAmountToCents('1.005')).toBe(101);
    expect(parseAmountToCents('-1.005')).toBe(-101);
    expect(parseAmountToCents('1.004')).toBe(100);
  });

  it('returns null for blank and unparseable input', () => {
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents('   ')).toBeNull();
    expect(parseAmountToCents('n/a')).toBeNull();
    expect(parseAmountToCents('12.34.56')).toBeNull();
    expect(parseAmountToCents('--5')).toBeNull();
  });

  it('never returns negative zero', () => {
    expect(Object.is(parseAmountToCents('-0.00'), 0)).toBe(true);
  });
});

describe('formatCents', () => {
  it('formats positive and negative cents', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(-123456)).toBe('-$1,234.56');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
  });

  it('can force an explicit + sign', () => {
    expect(formatCents(500, { showSign: true })).toBe('+$5.00');
    expect(formatCents(-500, { showSign: true })).toBe('-$5.00');
    expect(formatCents(0, { showSign: true })).toBe('$0.00');
  });

  it('can drop the currency symbol', () => {
    expect(formatCents(-123456, { currency: false })).toBe('-1,234.56');
  });
});

describe('sumCents / netSpentCents', () => {
  it('sums an empty list to zero', () => {
    expect(sumCents([])).toBe(0);
  });

  it('nets refunds against spend in the same category', () => {
    // $120 groceries spend, then a $20 return posted to the same category
    const signedSum = sumCents([-12000, 2000]);
    expect(signedSum).toBe(-10000);
    expect(netSpentCents(signedSum)).toBe(10000);
  });

  it('reports a category that is net positive as negative spend (not clamped)', () => {
    expect(netSpentCents(sumCents([-1000, 5000]))).toBe(-4000);
  });

  it('absCents and pctOf behave', () => {
    expect(absCents(-250)).toBe(250);
    expect(pctOf(2500, 10000)).toBe(25);
    expect(pctOf(2500, 0)).toBeNull();
  });
});
