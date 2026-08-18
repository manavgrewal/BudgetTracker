import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RANGE_PRESETS, isRangePresetId, rangeParams, resolveRange, type RangePresetId } from '@/lib/date-range';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const at = (today: string, preset: string) => resolveRange({ preset, from: null, to: null, today, fallback: null });

describe('MUST-11.1: seven presets, in order', () => {
  it('lists exactly the approved seven', () => {
    expect(RANGE_PRESETS.map((preset) => preset.id)).toEqual([
      'this_month',
      'last_month',
      'last_3_months',
      'last_6_months',
      'ytd',
      'last_year',
      'custom',
    ]);
    expect(RANGE_PRESETS.map((preset) => preset.label)).toEqual([
      'This month',
      'Last month',
      'Last 3 months',
      'Last 6 months',
      'Year to date',
      'Last year',
      'Custom',
    ]);
  });

  it('recognises its own ids and nothing else', () => {
    for (const preset of RANGE_PRESETS) expect(isRangePresetId(preset.id)).toBe(true);
    expect(isRangePresetId('last_30_days')).toBe(false);
    expect(isRangePresetId('')).toBe(false);
  });
});

describe('MUST-11.2: both endpoints of every preset', () => {
  it('resolves against 2026-08-18', () => {
    const endpoints = (preset: string) => {
      const range = at('2026-08-18', preset);
      return range === null ? null : [range.from, range.to];
    };
    expect(endpoints('this_month')).toEqual(['2026-08-01', '2026-08-31']);
    expect(endpoints('last_month')).toEqual(['2026-07-01', '2026-07-31']);
    expect(endpoints('last_3_months')).toEqual(['2026-06-01', '2026-08-31']);
    expect(endpoints('last_6_months')).toEqual(['2026-03-01', '2026-08-31']);
    expect(endpoints('ytd')).toEqual(['2026-01-01', '2026-08-31']);
    expect(endpoints('last_year')).toEqual(['2025-01-01', '2025-12-31']);
  });

  it('resolves across a year boundary', () => {
    expect(at('2026-01-05', 'last_3_months')).toMatchObject({ from: '2025-11-01', to: '2026-01-31' });
    expect(at('2026-01-05', 'last_month')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(at('2026-01-05', 'ytd')).toMatchObject({ from: '2026-01-01', to: '2026-01-31' });
    expect(at('2026-01-05', 'last_year')).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('resolves on the last day of a year and on a leap day', () => {
    expect(at('2026-12-31', 'this_month')).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
    expect(at('2026-12-31', 'last_6_months')).toMatchObject({ from: '2026-07-01', to: '2026-12-31' });
    expect(at('2028-02-29', 'this_month')).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
    expect(at('2028-02-29', 'last_month')).toMatchObject({ from: '2028-01-01', to: '2028-01-31' });
  });

  it('MUST-11.3: every "to" is a month end, so the range does not shift during the month', () => {
    // Two different days inside the same month must resolve identically. Comparing the same
    // `today` against itself would prove nothing about a pure function.
    for (const preset of ['this_month', 'last_3_months', 'last_6_months', 'ytd'] as const) {
      const first = at('2026-08-01', preset);
      const last = at('2026-08-31', preset);
      expect(first).toEqual(last);
      expect(first?.to).toBe('2026-08-31');
    }
  });
});

describe('MUST-11.6: precedence', () => {
  it('case 1: a recognised preset ignores any from or to in the URL entirely', () => {
    expect(
      resolveRange({ preset: 'last_month', from: '2020-01-01', to: '2020-12-31', today: '2026-08-18', fallback: null }),
    ).toEqual({ preset: 'last_month', from: '2026-07-01', to: '2026-07-31', label: 'Last month' });
  });

  it('case 2: an explicit custom preset reads from and to', () => {
    expect(resolveRange({ preset: 'custom', from: '2026-01-01', to: '2026-03-31', today: '2026-08-18', fallback: null })).toEqual({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-03-31',
      label: '2026-01-01 to 2026-03-31',
    });
  });

  it('case 3: a bare from/to pair with no preset resolves as custom, so old bookmarks keep working', () => {
    expect(resolveRange({ preset: null, from: '2026-01-01', to: '2026-03-31', today: '2026-08-18', fallback: null })).toMatchObject(
      { preset: 'custom', from: '2026-01-01', to: '2026-03-31' },
    );
    expect(
      resolveRange({ preset: 'not_a_preset', from: '2026-01-01', to: '2026-03-31', today: '2026-08-18', fallback: null }),
    ).toMatchObject({ preset: 'custom', from: '2026-01-01', to: '2026-03-31' });
  });

  it('case 4: nothing present gives the fallback, or null when there is none', () => {
    expect(resolveRange({ preset: null, from: null, to: null, today: '2026-08-18', fallback: 'last_6_months' })).toMatchObject({
      preset: 'last_6_months',
      from: '2026-03-01',
      to: '2026-08-31',
    });
    expect(resolveRange({ preset: null, from: null, to: null, today: '2026-08-18', fallback: null })).toBeNull();
  });
});

describe('MUST-11.5: custom validation', () => {
  it('discards an invalid endpoint and falls back when both are unusable', () => {
    expect(resolveRange({ preset: 'custom', from: 'nope', to: 'also-nope', today: '2026-08-18', fallback: null })).toBeNull();
    expect(
      resolveRange({ preset: 'custom', from: 'nope', to: 'also-nope', today: '2026-08-18', fallback: 'last_month' }),
    ).toMatchObject({ preset: 'last_month', from: '2026-07-01', to: '2026-07-31' });
  });

  it('fills the missing endpoint from the fallback and stays custom', () => {
    expect(
      resolveRange({ preset: 'custom', from: '2026-02-14', to: null, today: '2026-08-18', fallback: 'last_month' }),
    ).toMatchObject({ preset: 'custom', from: '2026-02-14', to: '2026-07-31' });
    // A missing `from` takes the fallback's own `from`, 2026-07-01, which is after the given
    // `to`, so MUST-11.5's swap puts the pair the right way round.
    expect(
      resolveRange({ preset: 'custom', from: null, to: '2026-02-14', today: '2026-08-18', fallback: 'last_month' }),
    ).toMatchObject({ preset: 'custom', from: '2026-02-14', to: '2026-07-01' });
  });

  it('swaps rather than rejecting a pair typed backwards', () => {
    expect(
      resolveRange({ preset: 'custom', from: '2026-03-31', to: '2026-01-01', today: '2026-08-18', fallback: null }),
    ).toMatchObject({ preset: 'custom', from: '2026-01-01', to: '2026-03-31' });
  });

  it('with no fallback, fills a missing "to" with the current month end and a missing "from" with the floor', () => {
    expect(resolveRange({ preset: null, from: '2026-01-01', to: null, today: '2026-08-18', fallback: null })).toMatchObject({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-08-31',
    });
    expect(resolveRange({ preset: null, from: null, to: '2026-03-31', today: '2026-08-18', fallback: null })).toMatchObject({
      preset: 'custom',
      from: '1900-01-01',
      to: '2026-03-31',
    });
  });
});

describe('MUST-11.7: fallback null means no range at all', () => {
  it('returns null so the caller applies no date filter', () => {
    expect(resolveRange({ preset: '', from: '', to: '', today: '2026-08-18', fallback: null })).toBeNull();
    expect(resolveRange({ preset: undefined, from: undefined, to: undefined, today: '2026-08-18', fallback: null })).toBeNull();
  });
});

describe('MUST-11.8: rangeParams is the one place a range becomes query parameters', () => {
  it('emits a token for a preset and the pair only for custom', () => {
    expect(rangeParams(null)).toEqual({});
    expect(rangeParams(at('2026-08-18', 'last_3_months'))).toEqual({ range: 'last_3_months' });
    expect(
      rangeParams(resolveRange({ preset: 'custom', from: '2026-01-01', to: '2026-03-31', today: '2026-08-18', fallback: null })),
    ).toEqual({ range: 'custom', from: '2026-01-01', to: '2026-03-31' });
  });

  it('round-trips every preset back through resolveRange to the same result', () => {
    for (const preset of RANGE_PRESETS) {
      if (preset.id === 'custom') continue;
      const first = at('2026-08-18', preset.id);
      const params = rangeParams(first);
      const second = resolveRange({
        preset: params.range ?? null,
        from: params.from ?? null,
        to: params.to ?? null,
        today: '2026-08-18',
        fallback: null,
      });
      expect(second).toEqual(first);
    }
  });
});

describe('MUST-11.9 and AC7: resolveRange is total', () => {
  it('never throws and always returns null or a valid ordered pair, over 1000 garbage inputs', () => {
    const garbage = [
      "';drop table transactions;--",
      '\u0000\uFFFF',
      'x'.repeat(5000),
      '2026-13-45',
      '2026-02-30',
      '../../etc/passwd',
      '{}',
      '[]',
      'null',
      'undefined',
      '-1',
      '1e309',
    ];
    let seed = 7;
    const pick = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return garbage[seed % garbage.length];
    };
    for (let run = 0; run < 1000; run += 1) {
      const result = resolveRange({
        preset: pick(),
        from: pick(),
        to: pick(),
        today: '2026-08-18',
        fallback: run % 2 === 0 ? null : 'last_6_months',
      });
      if (result === null) continue;
      expect(result.from <= result.to).toBe(true);
      expect(result.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('tolerates a non-string arriving from a repeated query parameter', () => {
    const weird = ['a', 'b'] as unknown as string;
    expect(() => resolveRange({ preset: weird, from: weird, to: weird, today: '2026-08-18', fallback: null })).not.toThrow();
  });
});

describe('MUST-11.4 and AC7: the timezone rule', () => {
  it('gives two different answers for two different todays with the same inputs', () => {
    const toronto = at('2026-08-31', 'this_month');
    const auckland = at('2026-09-01', 'this_month');
    expect(toronto).not.toEqual(auckland);
    expect(toronto?.from).toBe('2026-08-01');
    expect(auckland?.from).toBe('2026-09-01');
  });

  it('the module reads no clock and no environment', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/date-range.ts'), 'utf8');
    expect(source).not.toMatch(/new Date\b/);
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/todayIso/);
    expect(source).not.toMatch(/process\.env/);
    // MUST-2.3: @/lib/dates and nothing else.
    const imports = source.match(/from\s+'[^']+'/g) ?? [];
    expect(imports).toEqual(["from '@/lib/dates'"]);
  });
});
