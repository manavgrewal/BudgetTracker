import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  APPLY_MAX,
  APPLY_WINDOW_MS,
  CHECK_NOW_MAX,
  CHECK_NOW_WINDOW_MS,
  REVIEW_MAX,
  checkUpdateApply,
  checkUpdateCheckNow,
  checkUpdateReview,
  resetUpdateRateLimitsForTests,
  setUpdateRateLimitClockForTests,
} from '@/lib/update/ratelimit';

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  setUpdateRateLimitClockForTests(() => now);
  resetUpdateRateLimitsForTests();
});
afterEach(() => {
  setUpdateRateLimitClockForTests(null);
  resetUpdateRateLimitsForTests();
});

describe('MUST-10.7 / MUST-10.8: three global buckets', () => {
  it('refuses the sixth Check now in a window and recovers after it', () => {
    for (let i = 0; i < CHECK_NOW_MAX; i += 1) expect(checkUpdateCheckNow().allowed).toBe(true);
    const refused = checkUpdateCheckNow();
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMinutes).toBeGreaterThan(0);
    now += CHECK_NOW_WINDOW_MS + 1;
    expect(checkUpdateCheckNow().allowed).toBe(true);
  });

  it('refuses the fourth Apply in an hour and recovers after it', () => {
    for (let i = 0; i < APPLY_MAX; i += 1) expect(checkUpdateApply().allowed).toBe(true);
    expect(checkUpdateApply().allowed).toBe(false);
    now += APPLY_WINDOW_MS + 1;
    expect(checkUpdateApply().allowed).toBe(true);
  });

  it('the three buckets are independent', () => {
    for (let i = 0; i < CHECK_NOW_MAX; i += 1) checkUpdateCheckNow();
    expect(checkUpdateCheckNow().allowed).toBe(false);
    expect(checkUpdateReview().allowed).toBe(true);
    expect(checkUpdateApply().allowed).toBe(true);
    expect(REVIEW_MAX).toBeGreaterThan(CHECK_NOW_MAX);
  });
});
