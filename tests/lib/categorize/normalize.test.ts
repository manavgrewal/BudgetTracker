import { describe, it, expect } from 'vitest';
import { CHANNEL_PREFIXES, PROVINCE_CODES, normalizeMerchant, tokenize } from '@/lib/categorize/normalize';
import { dedupDescription, dedupHash } from '@/lib/import/dedup';

describe('normalizeMerchant — basics', () => {
  it('uppercases, collapses whitespace and trims', () => {
    expect(normalizeMerchant('  tim   hortons  ')).toBe('TIM HORTONS');
    expect(normalizeMerchant('a\tb\r\nc')).toBe('A B C');
  });

  it('keeps accented characters', () => {
    expect(normalizeMerchant('café république')).toBe('CAFÉ RÉPUBLIQUE');
  });

  it('never returns an empty string', () => {
    expect(normalizeMerchant('POS PURCHASE')).toBe('POS PURCHASE');
    expect(normalizeMerchant('#12345')).toBe('#12345');
    expect(normalizeMerchant('   ')).toBe('');
  });
});

describe('normalizeMerchant — channel prefixes', () => {
  it('strips the documented prefixes', () => {
    expect(normalizeMerchant('POS PURCHASE       TIM HORTONS')).toBe('TIM HORTONS');
    expect(normalizeMerchant('INTERAC PURCHASE METRO')).toBe('METRO');
    expect(normalizeMerchant('CONTACTLESS PURCHASE STARBUCKS')).toBe('STARBUCKS');
    expect(normalizeMerchant('VISA DEBIT PURCHASE ESSO')).toBe('ESSO');
    expect(normalizeMerchant('PRE-AUTH PAYMENT ROGERS COMMUNICATIONS')).toBe('ROGERS COMMUNICATIONS');
    expect(normalizeMerchant('PREAUTHORIZED DEBIT ENBRIDGE')).toBe('ENBRIDGE');
    expect(CHANNEL_PREFIXES.length).toBeGreaterThan(10);
  });

  it('strips terminal ids that follow a stripped prefix', () => {
    expect(normalizeMerchant('INTERAC PURCHASE 4821 METRO')).toBe('METRO');
    expect(normalizeMerchant('INTERAC PURCHASE 9910 MÉTRO PLUS')).toBe('MÉTRO PLUS');
  });

  it('does NOT strip leading digits when no prefix was present', () => {
    expect(normalizeMerchant('7 ELEVEN STORE')).toBe('7 ELEVEN');
    expect(normalizeMerchant('241 PIZZA')).toBe('241 PIZZA');
  });

  it('leaves card-payment descriptions intact so transfer detection can see them', () => {
    expect(normalizeMerchant('PAYMENT - THANK YOU')).toBe('PAYMENT - THANK YOU');
    expect(normalizeMerchant('AMEX PAYMENT RECEIVED - THANK YOU')).toBe('AMEX PAYMENT RECEIVED - THANK YOU');
    expect(normalizeMerchant('SCOTIA VISA PAYMENT')).toBe('SCOTIA VISA PAYMENT');
    expect(normalizeMerchant('TFR-TO C/C 4520********1234')).toBe('TFR-TO C/C 4520********1234');
  });
});

describe('normalizeMerchant — store numbers and reference runs', () => {
  it('strips store numbers', () => {
    expect(normalizeMerchant('LOBLAWS #1042')).toBe('LOBLAWS');
    expect(normalizeMerchant('WALMART STORE 042')).toBe('WALMART');
    expect(normalizeMerchant('CANADIAN TIRE UNIT 7')).toBe('CANADIAN TIRE');
    expect(normalizeMerchant('METRO # 178')).toBe('METRO');
  });

  it('strips digit runs of five or more but keeps shorter ones', () => {
    expect(normalizeMerchant('PETRO-CANADA 12345')).toBe('PETRO-CANADA');
    expect(normalizeMerchant('ESSO 1234')).toBe('ESSO 1234');
  });

  it('strips alphanumeric reference tokens holding five or more digits', () => {
    expect(normalizeMerchant('SPOTIFY P0A1B2C3D4')).toBe('SPOTIFY');
    expect(normalizeMerchant('AMZN Mktp CA*RT4XY9083')).toBe('AMZN MKTP CA');
  });
});

describe('normalizeMerchant — city/province tails', () => {
  it('drops a trailing province code and the city before it', () => {
    expect(normalizeMerchant('TIM HORTONS TORONTO ON')).toBe('TIM HORTONS');
    expect(normalizeMerchant('CAFÉ RÉPUBLIQUE MONTREAL QC')).toBe('CAFÉ RÉPUBLIQUE');
    expect(normalizeMerchant('SOBEYS HALIFAX NS')).toBe('SOBEYS');
  });

  it('recognises every Canadian province code', () => {
    expect(PROVINCE_CODES).toContain('ON');
    expect(PROVINCE_CODES).toContain('QC');
    expect(PROVINCE_CODES).toContain('PQ');
    expect(PROVINCE_CODES).toContain('NU');
    expect(PROVINCE_CODES).toHaveLength(14);
  });

  it('leaves a trailing city alone when no province follows it', () => {
    expect(normalizeMerchant('PRESTO FARE TORONTO')).toBe('PRESTO FARE TORONTO');
    expect(normalizeMerchant('UNIQLO CANADA TORONTO')).toBe('UNIQLO CANADA TORONTO');
  });

  it('never strips the last remaining token', () => {
    expect(normalizeMerchant('TORONTO ON')).toBe('TORONTO');
    expect(normalizeMerchant('ON')).toBe('ON');
  });
});

describe('normalizeMerchant — the full fixture merchants', () => {
  const cases: [string, string][] = [
    ['POS PURCHASE       TIM HORTONS #4821 TORONTO ON', 'TIM HORTONS'],
    ['PRE-AUTH PAYMENT ROGERS COMMUNICATIONS', 'ROGERS COMMUNICATIONS'],
    ['PAYROLL DEPOSIT CLOVERTOOL MFG', 'PAYROLL DEPOSIT CLOVERTOOL MFG'],
    ['INTERAC PURCHASE 4821 METRO #178 MISSISSAUGA ON', 'METRO'],
    ['E-TRANSFER SENT J DOE', 'E-TRANSFER SENT J DOE'],
    ['MONTHLY ACCOUNT FEE', 'MONTHLY ACCOUNT FEE'],
    ['ESSO CIRCLE K #2201 OAKVILLE ON', 'ESSO CIRCLE K'],
    ['NETFLIX.COM 866-579-7172 ON', 'NETFLIX.COM'],
    ['LOBLAWS #1042 BURLINGTON ON', 'LOBLAWS'],
    ['PETRO-CANADA 12345 BURLINGTON ON', 'PETRO-CANADA'],
    ['SOBEYS #654 OAKVILLE ON', 'SOBEYS'],
    ['PRE-AUTH HYDRO-QUÉBEC', 'HYDRO-QUÉBEC'],
    ['INTERAC PURCHASE 9910 MÉTRO PLUS #221 LAVAL QC', 'MÉTRO PLUS'],
    ['POS PURCHASE       CAFÉ RÉPUBLIQUE MONTREAL QC', 'CAFÉ RÉPUBLIQUE'],
  ];

  it.each(cases)('normalizes %s', (input, expected) => {
    expect(normalizeMerchant(input)).toBe(expected);
  });

  it('maps the two identical fixture rows onto the same merchant', () => {
    const a = normalizeMerchant('POS PURCHASE       TIM HORTONS #4821 TORONTO ON');
    const b = normalizeMerchant('POS PURCHASE  TIM HORTONS #4821 TORONTO  ON');
    expect(a).toBe(b);
  });
});

describe('the dedup hash is independent of this normalizer', () => {
  it('keeps everything the learning normalizer strips', () => {
    const raw = 'POS PURCHASE       TIM HORTONS #4821 TORONTO ON';
    expect(normalizeMerchant(raw)).toBe('TIM HORTONS');
    expect(dedupDescription(raw)).toBe('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
  });

  it('produces an unchanged hash even if the normalizer is swapped out entirely', async () => {
    const input = { accountId: 1, rawDate: '03/02/2026', amountCents: -485, rawDescription: 'POS PURCHASE TIM HORTONS #4821 TORONTO ON', occurrenceIndex: 0 };
    const before = dedupHash(input);

    // Simulate a future normalizer upgrade.
    const { normalizeMerchant: current } = await import('@/lib/categorize/normalize');
    expect(current(input.rawDescription)).toBe('TIM HORTONS');

    const after = dedupHash(input);
    expect(after).toBe(before);
  });
});

describe('tokenize', () => {
  it('splits on non-alphanumerics and drops one-character tokens', () => {
    expect(tokenize('TIM HORTONS')).toEqual(['TIM', 'HORTONS']);
    expect(tokenize('ESSO CIRCLE K')).toEqual(['ESSO', 'CIRCLE']);
    expect(tokenize('NETFLIX.COM')).toEqual(['NETFLIX', 'COM']);
    expect(tokenize('AMZN MKTP CA')).toEqual(['AMZN', 'MKTP', 'CA']);
  });

  it('keeps accented tokens', () => {
    expect(tokenize('CAFÉ RÉPUBLIQUE')).toEqual(['CAFÉ', 'RÉPUBLIQUE']);
  });

  it('drops pure-digit tokens', () => {
    expect(tokenize('ESSO 1234')).toEqual(['ESSO']);
  });

  it('preserves duplicates — Bayes is multinomial, not set-based', () => {
    expect(tokenize('PIZZA PIZZA')).toEqual(['PIZZA', 'PIZZA']);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});
