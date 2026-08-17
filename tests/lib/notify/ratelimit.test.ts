import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DETECT_CHAT_MAX_PER_USER,
  DETECT_CHAT_WINDOW_MS,
  TEST_SEND_MAX_GLOBAL,
  TEST_SEND_MAX_PER_USER,
  TEST_SEND_WINDOW_MS,
  checkDetectChat,
  checkTestSend,
  resetNotifyRateLimitsForTests,
  setNotifyRateLimitClockForTests,
} from '@/lib/notify/ratelimit';

let clock = 0;

beforeEach(() => {
  clock = 1_700_000_000_000;
  setNotifyRateLimitClockForTests(() => clock);
  resetNotifyRateLimitsForTests();
});

afterEach(() => {
  setNotifyRateLimitClockForTests(null);
  resetNotifyRateLimitsForTests();
});

describe('MUST-13.1: the constants', () => {
  it('pins the two windows and three caps', () => {
    expect(TEST_SEND_WINDOW_MS).toBe(600_000);
    expect(TEST_SEND_MAX_PER_USER).toBe(3);
    expect(TEST_SEND_MAX_GLOBAL).toBe(10);
    expect(DETECT_CHAT_WINDOW_MS).toBe(600_000);
    expect(DETECT_CHAT_MAX_PER_USER).toBe(10);
  });
});

describe('MUST-13.1: send-test buckets', () => {
  it('refuses the fourth per-user test in a window and recovers after it', () => {
    for (let i = 0; i < 3; i += 1) expect(checkTestSend(1, 'email').allowed).toBe(true);
    const refused = checkTestSend(1, 'email');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMinutes).toBeGreaterThan(0);
    clock += TEST_SEND_WINDOW_MS + 1;
    expect(checkTestSend(1, 'email').allowed).toBe(true);
  });

  it('is per (userId, channel)', () => {
    for (let i = 0; i < 3; i += 1) checkTestSend(1, 'email');
    expect(checkTestSend(1, 'email').allowed).toBe(false);
    expect(checkTestSend(1, 'telegram').allowed).toBe(true);
    expect(checkTestSend(2, 'email').allowed).toBe(true);
  });

  it('refuses the eleventh global test across all users and channels', () => {
    let allowed = 0;
    for (let userId = 1; userId <= 10; userId += 1) {
      if (checkTestSend(userId, 'email').allowed) allowed += 1;
    }
    expect(allowed).toBe(TEST_SEND_MAX_GLOBAL);
    expect(checkTestSend(11, 'email').allowed).toBe(false);
    clock += TEST_SEND_WINDOW_MS + 1;
    expect(checkTestSend(11, 'email').allowed).toBe(true);
  });
});

describe('MUST-13.1a: the detect bucket is separate and looser', () => {
  it('allows the tenth and refuses the eleventh in a window', () => {
    for (let i = 0; i < DETECT_CHAT_MAX_PER_USER; i += 1) expect(checkDetectChat(1).allowed).toBe(true);
    expect(checkDetectChat(1).allowed).toBe(false);
    clock += DETECT_CHAT_WINDOW_MS + 1;
    expect(checkDetectChat(1).allowed).toBe(true);
  });

  it('has no global cap — each user’s presses hit their own bot', () => {
    for (let userId = 1; userId <= 30; userId += 1) expect(checkDetectChat(userId).allowed).toBe(true);
  });

  it('is independent of the send-test bucket in both directions', () => {
    for (let i = 0; i < 3; i += 1) checkTestSend(1, 'telegram');
    expect(checkTestSend(1, 'telegram').allowed).toBe(false);
    expect(checkDetectChat(1).allowed).toBe(true);

    resetNotifyRateLimitsForTests();
    for (let i = 0; i < DETECT_CHAT_MAX_PER_USER; i += 1) checkDetectChat(2);
    expect(checkDetectChat(2).allowed).toBe(false);
    expect(checkTestSend(2, 'telegram').allowed).toBe(true);
  });
});
