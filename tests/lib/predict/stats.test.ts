import { describe, it, expect } from 'vitest';
import { ceilToDollar, divRound, meanCents, medianCents, spreadCents, trendOf } from '@/lib/predict/stats';

describe('MUST-3.3: divRound is half away from zero in all four sign quadrants', () => {
  it('rounds the documented cases', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(5, -2)).toBe(-3);
    expect(divRound(-5, -2)).toBe(3);
    expect(divRound(4, 2)).toBe(2);
    expect(divRound(0, 7)).toBe(0);
  });

  it('rounds a bare half away from zero rather than to even', () => {
    expect(divRound(1, 2)).toBe(1);
    expect(divRound(-1, 2)).toBe(-1);
    expect(divRound(3, 2)).toBe(2);
    // Math.round(-2.5) is -2 in JavaScript. This is the case that made the primitive necessary.
    expect(divRound(-5, 2)).not.toBe(-2);
  });

  it('throws rather than returning Infinity on a zero denominator', () => {
    expect(() => divRound(1, 0)).toThrow();
  });
});

describe('MUST-3.4: ceilToDollar', () => {
  it('rounds a non-negative amount up to the next whole dollar', () => {
    expect(ceilToDollar(0)).toBe(0);
    expect(ceilToDollar(1)).toBe(100);
    expect(ceilToDollar(99)).toBe(100);
    expect(ceilToDollar(100)).toBe(100);
    expect(ceilToDollar(101)).toBe(200);
  });

  it('throws on a negative input rather than guessing', () => {
    expect(() => ceilToDollar(-1)).toThrow();
  });
});

describe('MUST-5.1: medianCents', () => {
  it('returns null for an empty series', () => {
    expect(medianCents([])).toBeNull();
  });

  it('takes the middle element of an odd-length series exactly', () => {
    expect(medianCents([300, 100, 200])).toBe(200);
    expect(medianCents([500])).toBe(500);
  });

  it('rounds the two middle elements half away from zero on an even-length series', () => {
    expect(medianCents([100, 201])).toBe(151);
    expect(medianCents([-100, -201])).toBe(-151);
    expect(medianCents([100, 200, 300, 400])).toBe(250);
  });

  it('handles an all-zero series and a series with negatives', () => {
    expect(medianCents([0, 0, 0])).toBe(0);
    expect(medianCents([-500, 100, 700])).toBe(100);
  });

  it('never mutates its input', () => {
    const input = [300, 100, 200];
    medianCents(input);
    expect(input).toEqual([300, 100, 200]);
  });
});

describe('MUST-5.3: meanCents', () => {
  it('returns null for an empty series and divRounds otherwise', () => {
    expect(meanCents([])).toBeNull();
    expect(meanCents([100, 200, 301])).toBe(200);
    expect(meanCents([1, 2])).toBe(2);
    expect(meanCents([-1, -2])).toBe(-2);
  });

  it('never mutates its input', () => {
    const input = [5, 7];
    meanCents(input);
    expect(input).toEqual([5, 7]);
  });
});

describe('MUST-5.9: spreadCents is max minus min', () => {
  it('measures the window and returns null when empty', () => {
    expect(spreadCents([])).toBeNull();
    expect(spreadCents([100])).toBe(0);
    expect(spreadCents([100, -50, 900])).toBe(950);
  });
});

describe('MUST-5.4: trendOf is a two-half mean comparison', () => {
  it('is unknown under six values', () => {
    expect(trendOf([])).toEqual({ direction: 'unknown', deltaCents: 0 });
    expect(trendOf([100, 200, 300, 400, 500])).toEqual({ direction: 'unknown', deltaCents: 0 });
  });

  it('rises when the later half clears the threshold', () => {
    // prior mean 10000, recent mean 13000, delta 3000. Threshold is max(2000, 1000) = 2000.
    expect(trendOf([10000, 10000, 10000, 13000, 13000, 13000])).toEqual({ direction: 'rising', deltaCents: 3000 });
  });

  it('falls when the later half drops past the threshold', () => {
    expect(trendOf([13000, 13000, 13000, 10000, 10000, 10000])).toEqual({ direction: 'falling', deltaCents: -3000 });
  });

  it('is flat just under the threshold and rising exactly at it', () => {
    // prior mean 10000, so the 10 percent rule gives 1000 and the $20 floor binds at 2000.
    expect(trendOf([10000, 10000, 10000, 11999, 11999, 11999]).direction).toBe('flat');
    expect(trendOf([10000, 10000, 10000, 12000, 12000, 12000]).direction).toBe('rising');
  });

  it('lets the 10 percent rule bind when the prior half is large', () => {
    // prior mean 100000, so 10 percent is 10000 and beats the $20 floor.
    expect(trendOf([100000, 100000, 100000, 105000, 105000, 105000]).direction).toBe('flat');
    expect(trendOf([100000, 100000, 100000, 110000, 110000, 110000]).direction).toBe('rising');
  });

  it('uses the absolute prior mean, so a refund-heavy earlier half still gets a threshold', () => {
    expect(trendOf([-100000, -100000, -100000, 0, 0, 0]).direction).toBe('rising');
  });
});
