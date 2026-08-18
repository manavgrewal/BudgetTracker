/**
 * MUST-10.7: in-memory token buckets for the three user-triggered update actions.
 *
 * MUST-10.8: these are GLOBAL, not per-user, which is the opposite of the notify test-send
 * bucket and is deliberate. There is one GitHub quota per source IP and one install to
 * update, so the shared resource is the install itself: two admins pressing Check now are
 * contending for the same thing.
 *
 * MUST-10.10: APPLY_MAX = 3 per hour is not a security boundary. An admin can already
 * restart the container. It bounds a stuck form and a double-click storm against a
 * container that is mid-replacement.
 */
export const CHECK_NOW_WINDOW_MS = 10 * 60_000;
export const CHECK_NOW_MAX = 5;
export const REVIEW_WINDOW_MS = 10 * 60_000;
export const REVIEW_MAX = 10;
export const APPLY_WINDOW_MS = 60 * 60_000;
export const APPLY_MAX = 3;

export interface RateVerdict {
  allowed: boolean;
  retryAfterMinutes: number;
}

/** The seam, so all three windows are testable without real waiting. */
let clock: () => number = () => Date.now();

export function setUpdateRateLimitClockForTests(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

const checkNowStamps: number[] = [];
const reviewStamps: number[] = [];
const applyStamps: number[] = [];

export function resetUpdateRateLimitsForTests(): void {
  checkNowStamps.length = 0;
  reviewStamps.length = 0;
  applyStamps.length = 0;
}

function prune(stamps: number[], now: number, windowMs: number): void {
  while (stamps.length > 0 && (stamps[0] as number) <= now - windowMs) stamps.shift();
}

function verdict(stamps: number[], now: number, windowMs: number): RateVerdict {
  const oldest = stamps[0] ?? now;
  const waitMs = Math.max(0, oldest + windowMs - now);
  return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
}

/**
 * MUST-10.9: a token is consumed only once the caller has passed every configuration guard,
 * so pressing Update now on an install with no Watchtower cannot burn apply quota while
 * doing nothing. The ordering is the caller's responsibility and every call site below
 * carries a comment saying so. This is the same discipline notify's runTest establishes.
 */
function take(stamps: number[], now: number, windowMs: number, max: number): RateVerdict {
  prune(stamps, now, windowMs);
  if (stamps.length >= max) return verdict(stamps, now, windowMs);
  stamps.push(now);
  return { allowed: true, retryAfterMinutes: 0 };
}

export function checkUpdateCheckNow(now: number = clock()): RateVerdict {
  return take(checkNowStamps, now, CHECK_NOW_WINDOW_MS, CHECK_NOW_MAX);
}

export function checkUpdateReview(now: number = clock()): RateVerdict {
  return take(reviewStamps, now, REVIEW_WINDOW_MS, REVIEW_MAX);
}

export function checkUpdateApply(now: number = clock()): RateVerdict {
  return take(applyStamps, now, APPLY_WINDOW_MS, APPLY_MAX);
}
