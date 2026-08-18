import { describe, it, expect } from 'vitest';
import { classify, compareSemver, formatSemver, parseSemver, type Semver } from '@/lib/update/semver';

const v = (major: number, minor: number, patch: number): Semver => ({ major, minor, patch });

describe('MUST-4.10: parseSemver is strict', () => {
  it('accepts three dot-separated runs of digits, with one optional leading v', () => {
    expect(parseSemver('1.4.0')).toEqual(v(1, 4, 0));
    expect(parseSemver('v1.4.0')).toEqual(v(1, 4, 0));
    expect(parseSemver('0.0.0')).toEqual(v(0, 0, 0));
    expect(parseSemver('10.20.30')).toEqual(v(10, 20, 30));
  });

  it('rejects everything else, including a pre-release and build metadata', () => {
    for (const bad of [
      '1.4',
      '1.4.0.1',
      '1.4.0-rc.1',
      '1.4.0+build',
      'v1.4.0-rc.1',
      'latest',
      '',
      'vv1.4.0',
      '1.04.0',
      ' 1.4.0',
      '1.4.0 ',
      'a'.repeat(40),
    ]) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });

  it('accepts a bare zero but not a leading zero beyond it', () => {
    expect(parseSemver('0.1.0')).toEqual(v(0, 1, 0));
    expect(parseSemver('00.1.0')).toBeNull();
    expect(parseSemver('1.0.00')).toBeNull();
  });
});

describe('compareSemver orders across all three components', () => {
  it('sorts by major, then minor, then patch', () => {
    expect(compareSemver(v(2, 0, 0), v(1, 9, 9))).toBeGreaterThan(0);
    expect(compareSemver(v(1, 4, 0), v(1, 3, 9))).toBeGreaterThan(0);
    expect(compareSemver(v(1, 3, 1), v(1, 3, 0))).toBeGreaterThan(0);
    expect(compareSemver(v(1, 3, 0), v(1, 3, 0))).toBe(0);
    expect(compareSemver(v(1, 3, 0), v(1, 3, 1))).toBeLessThan(0);
  });
});

describe('MUST-4.9: classify is total and defined by exactly four lines, in order', () => {
  it('returns none for an equal pair and for a LOWER remote', () => {
    expect(classify(v(1, 3, 1), v(1, 3, 1))).toBe('none');
    expect(classify(v(1, 3, 1), v(1, 3, 0))).toBe('none');
    expect(classify(v(2, 0, 0), v(1, 9, 9))).toBe('none'); // a downgrade is never an update
  });

  it('returns major, minor and patch in that precedence', () => {
    expect(classify(v(1, 3, 1), v(2, 0, 0))).toBe('major');
    // A major bump wins even when the minor and patch go DOWN.
    expect(classify(v(1, 9, 9), v(2, 0, 0))).toBe('major');
    expect(classify(v(1, 3, 1), v(1, 4, 0))).toBe('minor');
    expect(classify(v(1, 3, 1), v(1, 4, 0))).not.toBe('patch');
    expect(classify(v(1, 3, 1), v(1, 3, 2))).toBe('patch');
  });

  it('classifies 1.3.0 -> 1.3.1 as a patch (MUST-18.2, stated consequence)', () => {
    expect(classify(v(1, 3, 0), v(1, 3, 1))).toBe('patch');
  });
});

describe('formatSemver re-serialises from integers (MUST-4.2)', () => {
  it('round-trips and drops any leading v', () => {
    expect(formatSemver(parseSemver('v1.4.0')!)).toBe('1.4.0');
    expect(formatSemver(v(10, 0, 3))).toBe('10.0.3');
  });
});
