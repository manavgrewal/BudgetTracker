import { describe, it, expect } from 'vitest';
import { addMonths, currentMonth, monthEnd, monthStart } from '@/lib/dates';
import { rangeParams, resolveRange } from '@/lib/date-range';

const TODAY = '2026-08-18';

describe('MUST-13.2 and AC9: Reports keeps its v1.3.1 default exactly', () => {
  it('an empty query string resolves to the same pair the old inline expression produced', () => {
    const range = resolveRange({ preset: null, from: null, to: null, today: TODAY, fallback: 'last_6_months' });
    const legacyMonth = '2026-08';
    expect(range?.from).toBe(monthStart(addMonths(legacyMonth, -5)));
    expect(range?.to).toBe(monthEnd(legacyMonth));
  });

  it('holds for the real current month too, so the assertion is not fixture-bound', () => {
    const month = currentMonth();
    const today = `${month}-15`;
    const range = resolveRange({ preset: null, from: null, to: null, today, fallback: 'last_6_months' });
    expect(range?.from).toBe(monthStart(addMonths(month, -5)));
    expect(range?.to).toBe(monthEnd(month));
  });
});

describe('MUST-13.6 and AC9: Transactions keeps having no default date filter', () => {
  it('an empty query string resolves to null, so no date clause is added', () => {
    expect(resolveRange({ preset: null, from: null, to: null, today: TODAY, fallback: null })).toBeNull();
  });

  it('an existing-style bookmark still resolves to exactly its two dates', () => {
    const range = resolveRange({ preset: null, from: '2026-01-01', to: '2026-03-31', today: TODAY, fallback: null });
    expect(range?.from).toBe('2026-01-01');
    expect(range?.to).toBe('2026-03-31');
    expect(range?.preset).toBe('custom');
  });
});

describe('MUST-13.3 and MUST-13.9: the export link and the route agree', () => {
  it('a preset link carries the token and the route resolves it to the same pair', () => {
    const pageRange = resolveRange({ preset: 'last_3_months', from: null, to: null, today: TODAY, fallback: 'last_6_months' });
    const params = rangeParams(pageRange);
    expect(params).toEqual({ range: 'last_3_months' });
    const routeRange = resolveRange({
      preset: params.range ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
      today: TODAY,
      fallback: null,
    });
    expect(routeRange?.from).toBe(pageRange?.from);
    expect(routeRange?.to).toBe(pageRange?.to);
  });
});
