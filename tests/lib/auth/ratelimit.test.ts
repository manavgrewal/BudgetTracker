import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db';
import {
  ATTEMPT_RETENTION_DAYS,
  USERNAME_BASE_LOCKOUT_MS,
  USERNAME_MAX_FAILURES,
  USERNAME_MAX_LOCKOUT_MS,
  USER_IP_LOCKOUT_MS,
  USER_IP_MAX_FAILURES,
  checkLockout,
  clearAttemptsFor,
  clientIpFromHeaders,
  purgeOldLoginAttempts,
  recordLoginAttempt,
} from '@/lib/auth/ratelimit';
import type { AppEnv } from '@/lib/env';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const T0 = new Date('2026-08-15T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function fail(username: string, ip: string, minutes: number) {
  recordLoginAttempt({ username, ip, success: false, at: at(minutes) });
}

describe('layer A — per (username, ip)', () => {
  it('locks after 5 failures from the same IP inside 15 minutes', () => {
    current = createTestDb();
    for (let i = 0; i < USER_IP_MAX_FAILURES - 1; i += 1) fail('alice', '10.0.0.5', i);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(4) }).locked).toBe(false);

    fail('alice', '10.0.0.5', 4);
    const status = checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(5) });
    expect(status.locked).toBe(true);
    expect(status.reason).toBe('user_ip');
    // locked until last failure + 15 min
    expect(status.retryAfterMs).toBe(USER_IP_LOCKOUT_MS - 60_000);
  });

  it('does not lock a different IP for the same username', () => {
    current = createTestDb();
    for (let i = 0; i < 5; i += 1) fail('alice', '10.0.0.5', i);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.9', at: at(5) }).locked).toBe(false);
  });

  it('does not lock a different username from the same IP', () => {
    current = createTestDb();
    for (let i = 0; i < 5; i += 1) fail('alice', '10.0.0.5', i);
    expect(checkLockout({ username: 'bob', ip: '10.0.0.5', at: at(5) }).locked).toBe(false);
  });

  it('expires the lockout 15 minutes after the last failure (strict boundary)', () => {
    current = createTestDb();
    for (let i = 0; i < 5; i += 1) fail('alice', '10.0.0.5', i);
    // until = last failure (min 4) + 15 min = min 19, exclusive: locked just before it,
    // unlocked exactly at it (a retryAfterMs of 0 at the boundary would be incoherent
    // for a Retry-After caller, so the comparison is strict `now < until`, not `<=`).
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: new Date(at(19).getTime() - 1) }).locked).toBe(true);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(19) }).locked).toBe(false);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(20) }).locked).toBe(false);
  });

  it('never locks when 5 failures are spread wider than the 15-minute window', () => {
    current = createTestDb();
    // 0, 5, 10, 15, 20 min — newest-to-5th-newest gap is 20 min, over the window.
    for (let i = 0; i < 5; i += 1) fail('alice', '10.0.0.5', i * 5);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(21) }).locked).toBe(false);
  });

  it('a 6th failure recorded after the lockout has expired does not re-lock', () => {
    current = createTestDb();
    for (let i = 0; i < 5; i += 1) fail('alice', '10.0.0.5', i); // burst 0..4, locked until 19
    fail('alice', '10.0.0.5', 25); // recorded well after the burst's own lockout expired
    // the only qualifying quintuple is still 0..4 (until 19); the lone failure at 25
    // can't pair with 4 companions inside its own 15-min window, so it can't re-lock.
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(25) }).locked).toBe(false);
  });

  it('stays locked through the original window when a failure lands mid-lockout (self-release fix)', () => {
    current = createTestDb();
    // 0,0,0,0,14 -> burst qualifies (gap 14 <= 15), locked until 14 + 15 = 29.
    fail('alice', '10.0.0.5', 0);
    fail('alice', '10.0.0.5', 0);
    fail('alice', '10.0.0.5', 0);
    fail('alice', '10.0.0.5', 0);
    fail('alice', '10.0.0.5', 14);
    let status = checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(20) });
    expect(status.locked).toBe(true);
    expect(status.retryAfterMs).toBe(9 * 60_000); // until 29, now 20 -> 9 min left

    // A 6th failure lands at minute 20, *during* the active lockout. Anchoring only
    // on the single newest failure would let this cancel the lockout (newest=20,
    // 5th-newest=0, gap 20 > 15 -> "not a burst"). The window scan must still find
    // the quintuple {14,0,0,0,0} and keep the account locked until 29.
    fail('alice', '10.0.0.5', 20);
    status = checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(25) });
    expect(status.locked).toBe(true);
    expect(status.retryAfterMs).toBe(4 * 60_000); // still anchored on until 29

    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(29) }).locked).toBe(false);
  });

  it('a successful login resets the layer-A counter', () => {
    current = createTestDb();
    for (let i = 0; i < 4; i += 1) fail('alice', '10.0.0.5', i);
    recordLoginAttempt({ username: 'alice', ip: '10.0.0.5', success: true, at: at(5) });
    fail('alice', '10.0.0.5', 6);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(7) }).locked).toBe(false);
  });

  it('is case-insensitive on the username', () => {
    current = createTestDb();
    for (let i = 0; i < 5; i += 1) fail('Alice', '10.0.0.5', i);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: at(5) }).locked).toBe(true);
  });
});

describe('layer B — per username, IP-rotation resistant', () => {
  it('locks after 10 failures from 10 DIFFERENT IPs (layer A never trips)', () => {
    current = createTestDb();
    for (let i = 0; i < 10; i += 1) fail('alice', `10.0.0.${i + 1}`, i);
    // layer A sees a single failure per IP
    const fromFreshIp = checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(10) });
    expect(fromFreshIp.locked).toBe(true);
    expect(fromFreshIp.reason).toBe('username');
  });

  it('does not lock when 10 failures are spread wider than the 15-minute burst window', () => {
    current = createTestDb();
    for (let i = 0; i < 10; i += 1) fail('alice', `10.0.0.${i + 1}`, i * 5); // 0..45 min
    expect(checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(46) }).locked).toBe(false);
  });

  it('doubles the lockout on each repeat round', () => {
    current = createTestDb();
    for (let i = 0; i < 10; i += 1) fail('alice', `10.0.0.${i + 1}`, i);
    let status = checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(10) });
    expect(status.retryAfterMs).toBe(USERNAME_BASE_LOCKOUT_MS - 60_000); // round 1 = 15 min

    // second burst of 10 → round 2 = 30 min
    for (let i = 0; i < 10; i += 1) fail('alice', `10.0.1.${i + 1}`, 30 + i);
    status = checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(40) });
    expect(status.locked).toBe(true);
    expect(status.retryAfterMs).toBe(USERNAME_BASE_LOCKOUT_MS * 2 - 60_000);

    // third burst → round 3 = 60 min
    for (let i = 0; i < 10; i += 1) fail('alice', `10.0.2.${i + 1}`, 80 + i);
    status = checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(90) });
    expect(status.retryAfterMs).toBe(USERNAME_BASE_LOCKOUT_MS * 4 - 60_000);
  });

  it('caps the backoff at 24 hours', () => {
    current = createTestDb();
    for (let i = 0; i < 200; i += 1) fail('alice', `10.0.${Math.floor(i / 250)}.${i % 250}`, i * 0.05);
    const status = checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(10) });
    expect(status.locked).toBe(true);
    expect(status.retryAfterMs).toBeLessThanOrEqual(USERNAME_MAX_LOCKOUT_MS);
  });

  it('a successful login clears the backoff history', () => {
    current = createTestDb();
    for (let i = 0; i < 10; i += 1) fail('alice', `10.0.0.${i + 1}`, i);
    recordLoginAttempt({ username: 'alice', ip: '10.0.0.5', success: true, at: at(20) });
    for (let i = 0; i < 9; i += 1) fail('alice', `10.0.3.${i + 1}`, 21 + i);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(30) }).locked).toBe(false);
  });

  it('ignores failures older than 24 hours', () => {
    current = createTestDb();
    for (let i = 0; i < 10; i += 1) fail('alice', `10.0.0.${i + 1}`, i);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(60 * 25) }).locked).toBe(false);
  });

  it('clearAttemptsFor wipes a username (admin unlock)', () => {
    current = createTestDb();
    for (let i = 0; i < 10; i += 1) fail('alice', `10.0.0.${i + 1}`, i);
    expect(clearAttemptsFor('alice')).toBe(10);
    expect(checkLockout({ username: 'alice', ip: '10.0.0.200', at: at(10) }).locked).toBe(false);
  });
});

describe('clientIpFromHeaders', () => {
  const base: AppEnv = { secretKey: 'x'.repeat(32), trustProxy: false, tz: 'UTC', port: 3000, dataDir: '/data', watchtowerUrl: null, watchtowerToken: null };

  it('uses the socket IP when TRUST_PROXY is off', () => {
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    expect(clientIpFromHeaders(headers, '10.0.0.5', base)).toBe('10.0.0.5');
  });

  it('uses the first X-Forwarded-For entry when TRUST_PROXY is on', () => {
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    expect(clientIpFromHeaders(headers, '10.0.0.5', { ...base, trustProxy: true })).toBe('1.2.3.4');
  });

  it('falls back to the socket IP when the proxy header is absent, then to "unknown"', () => {
    expect(clientIpFromHeaders(new Headers(), '10.0.0.5', { ...base, trustProxy: true })).toBe('10.0.0.5');
    expect(clientIpFromHeaders(new Headers(), null, base)).toBe('unknown');
  });
});

describe('purgeOldLoginAttempts', () => {
  it('deletes rows older than the retention window and keeps newer ones', () => {
    current = createTestDb();
    expect(ATTEMPT_RETENTION_DAYS).toBe(30);
    fail('alice', '10.0.0.5', -60 * 24 * 40); // 40 days ago
    fail('alice', '10.0.0.5', -60 * 24 * 10); // 10 days ago
    expect(purgeOldLoginAttempts(T0)).toBe(1);
    const remaining = current!.sqlite.prepare('select count(*) as c from login_attempts').get() as { c: number };
    expect(remaining.c).toBe(1);
  });
});
