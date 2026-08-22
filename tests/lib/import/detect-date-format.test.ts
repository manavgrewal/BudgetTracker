import { describe, it, expect } from 'vitest';
import { detectDateFormat } from '@/lib/import/detect-date-format';

describe('detectDateFormat', () => {
  it('is unique when exactly one known format parses every sample', () => {
    // Numeric slash formats never match a month-name date, so 'DD-MMM-YYYY' is the only
    // survivor here.
    const result = detectDateFormat(['14-Mar-2026', '02-Jan-2026', '31-Dec-2025']);
    expect(result.status).toBe('unique');
    expect(result.detected).toBe('DD-MMM-YYYY');
    expect(result.candidates).toEqual(['DD-MMM-YYYY']);
  });

  it('resolves deterministically when two or more surviving formats agree on every sample', () => {
    // 'YYYY-MM-DD' and 'YYYY/MM/DD' share the exact same parsing logic in dates.ts (the
    // separator is not actually distinguished), so any ISO-shaped sample makes both
    // survive and they can never disagree. Tie-break is DATE_FORMATS declaration order,
    // where 'YYYY-MM-DD' is listed first.
    const result = detectDateFormat(['2026-03-14', '2026-01-05', '2025-12-31']);
    expect(result.status).toBe('resolved');
    expect(result.detected).toBe('YYYY-MM-DD');
    expect(result.candidates).toEqual(['YYYY-MM-DD', 'YYYY/MM/DD']);
  });

  it('is ambiguous when two or more surviving formats disagree on any sample (the real DD/MM vs MM/DD case)', () => {
    const result = detectDateFormat(['03/04/2026', '05/06/2026']);
    expect(result.status).toBe('ambiguous');
    expect(result.detected).toBeNull();
    expect(result.candidates).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY']);
  });

  it('is ambiguous based on ANY disagreeing sample, even when most samples happen to agree', () => {
    // '01/02/2026' happens to be day-or-month-agnostic-looking but isn't: MM/DD reads
    // Jan 2, DD/MM reads Feb 1 — they disagree on this single sample even though the rest
    // of the batch (if unambiguous) might not exist. One disagreement is enough to refuse.
    const result = detectDateFormat(['03/04/2026', '03/04/2026', '01/02/2026']);
    expect(result.status).toBe('ambiguous');
    expect(result.detected).toBeNull();
  });

  it('reports none when no known format parses every sample, without throwing', () => {
    const result = detectDateFormat(['not a date', 'also nonsense']);
    expect(result.status).toBe('none');
    expect(result.detected).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('reports none when every sample is blank, without throwing', () => {
    expect(detectDateFormat(['', '   '])).toEqual({ status: 'none', detected: null, candidates: [] });
    expect(detectDateFormat([])).toEqual({ status: 'none', detected: null, candidates: [] });
  });

  it('ignores blank samples mixed in with real ones', () => {
    const result = detectDateFormat(['14-Mar-2026', '', '  ', '02-Jan-2026']);
    expect(result.status).toBe('unique');
    expect(result.detected).toBe('DD-MMM-YYYY');
  });

  it('parses the Excel-mangled two-digit-year format on its own', () => {
    const result = detectDateFormat(['26-May-26', '02-Jan-26', '15-Dec-25']);
    expect(result.status).toBe('unique');
    expect(result.detected).toBe('DD-MMM-YY');
  });

  it('is a pure function: identical input always yields an identical result', () => {
    const input = ['03/04/2026', '05/06/2026'];
    expect(detectDateFormat(input)).toEqual(detectDateFormat([...input]));
  });
});
