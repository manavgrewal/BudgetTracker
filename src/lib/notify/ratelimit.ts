import type { Channel } from '@/lib/notify/events';

/**
 * MUST-13.1 / MUST-13.1a — in-memory token buckets for the two user-triggered egress
 * buttons.
 *
 * MUST-13.2 — in-memory rather than DB-backed, unlike src/lib/auth/ratelimit.ts. Different
 * threat: the login limiter defends against an unauthenticated attacker who can retry
 * across restarts, while these bound an authenticated household member's misclicks and a
 * stuck form. A restart resetting the bucket is acceptable, and a member cannot restart
 * the container (§19.13).
 */
export const TEST_SEND_WINDOW_MS = 10 * 60_000;
export const TEST_SEND_MAX_PER_USER = 3; // per (userId, channel)
export const TEST_SEND_MAX_GLOBAL = 10; // across all users and channels

export const DETECT_CHAT_WINDOW_MS = 10 * 60_000;
export const DETECT_CHAT_MAX_PER_USER = 10; // per userId, and NO global cap

export interface RateVerdict {
  allowed: boolean;
  retryAfterMinutes: number;
}

/** MUST-13.3: the seam, so both windows are testable without real waiting. */
let clock: () => number = () => Date.now();

export function setNotifyRateLimitClockForTests(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

const testSendByUser = new Map<string, number[]>();
const testSendGlobal: number[] = [];
const detectByUser = new Map<number, number[]>();

export function resetNotifyRateLimitsForTests(): void {
  testSendByUser.clear();
  testSendGlobal.length = 0;
  detectByUser.clear();
}

function prune(stamps: number[], now: number, windowMs: number): void {
  while (stamps.length > 0 && (stamps[0] as number) <= now - windowMs) stamps.shift();
}

function verdict(stamps: number[], now: number, windowMs: number): RateVerdict {
  const oldest = stamps[0] ?? now;
  const waitMs = Math.max(0, oldest + windowMs - now);
  return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
}

/** Consumes a token when it returns allowed; the caller then sends nothing on a refusal. */
export function checkTestSend(userId: number, channel: Channel, now: number = clock()): RateVerdict {
  const key = `${userId}:${channel}`;
  const perUser = testSendByUser.get(key) ?? [];
  prune(perUser, now, TEST_SEND_WINDOW_MS);
  prune(testSendGlobal, now, TEST_SEND_WINDOW_MS);

  if (perUser.length >= TEST_SEND_MAX_PER_USER) {
    testSendByUser.set(key, perUser);
    return verdict(perUser, now, TEST_SEND_WINDOW_MS);
  }
  // The global cap exists because a household's Brevo free tier and a Telegram bot's
  // per-minute allowance are shared resources one enthusiastic member can exhaust for
  // everyone (MUST-13.1).
  if (testSendGlobal.length >= TEST_SEND_MAX_GLOBAL) {
    testSendByUser.set(key, perUser);
    return verdict(testSendGlobal, now, TEST_SEND_WINDOW_MS);
  }

  perUser.push(now);
  testSendGlobal.push(now);
  testSendByUser.set(key, perUser);
  return { allowed: true, retryAfterMinutes: 0 };
}

/**
 * MUST-13.1a — a separate, LOOSER bucket. Detect chat ID is genuinely expected to be
 * pressed several times in a row ("press it, realise you never messaged the bot, message
 * the bot, press it again"), so a cap of three would punish correct use. No global cap:
 * each user's presses hit their own bot, so there is no shared resource to protect.
 */
export function checkDetectChat(userId: number, now: number = clock()): RateVerdict {
  const stamps = detectByUser.get(userId) ?? [];
  prune(stamps, now, DETECT_CHAT_WINDOW_MS);
  if (stamps.length >= DETECT_CHAT_MAX_PER_USER) {
    detectByUser.set(userId, stamps);
    return verdict(stamps, now, DETECT_CHAT_WINDOW_MS);
  }
  stamps.push(now);
  detectByUser.set(userId, stamps);
  return { allowed: true, retryAfterMinutes: 0 };
}
