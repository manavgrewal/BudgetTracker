import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import {
  NIGHTLY_CRON,
  NOTIFY_TICK_CRON,
  OCR_SWEEP_CRON,
  isSchedulerRunning,
  runNightlyTick,
  runNotifyTick,
  startScheduler,
  stopScheduler,
} from '@/lib/scheduler';
import * as backupModule from '@/lib/backup';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import * as evaluateModule from '@/lib/notify/evaluate';
import { drainOutboxForTests } from '@/lib/notify/outbox';
import * as raiseModule from '@/lib/notify/raise';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';

// M8: startScheduler() runs the OCR sweep once at boot, which calls getDb() via
// sweepPendingReceipts(). Without an isolated test db, that call falls through to the
// shared .tmp-data/budget.db used by every other test in the suite that doesn't set one up
// itself — leaking rows/side effects across test files. createTestDb() points getDb() at a
// throwaway temp-directory database for the duration of each test instead.
let current: TestDb | null = null;

beforeEach(() => {
  current = createTestDb();
});

afterEach(() => {
  stopScheduler();
  current?.cleanup();
  current = null;
});

describe('scheduler', () => {
  it('keeps the nightly cron and adds a ten-minute OCR sweep (MUST-7.12)', () => {
    expect(NIGHTLY_CRON).toBe('0 2 * * *');
    expect(OCR_SWEEP_CRON).toBe('*/10 * * * *');
  });

  it('is idempotent and stops cleanly', () => {
    startScheduler();
    expect(isSchedulerRunning()).toBe(true);
    startScheduler();
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  it('also runs the sweep once at boot, not only on the tick', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    expect(source).toContain('sweepPendingReceipts');
    expect(source).toContain('runOcrSweep();');
  });
});

describe('MUST-6.1 / MUST-6.4: the notification tick', () => {
  it('pins the cron expression', () => {
    expect(NOTIFY_TICK_CRON).toBe('*/5 * * * *');
  });

  it('AC4: on a dormant install the tick reaches neither the evaluator nor the sender', async () => {
    const t = createTestDb();
    const sender = vi.fn(async () => {});
    const evaluate = vi.spyOn(evaluateModule, 'runScheduledEvaluation');
    setNotifySenderForTests(sender);
    try {
      for (let i = 0; i < 12; i += 1) runNotifyTick(new Date(Date.now() + i * 5 * 60_000));
      await drainOutboxForTests();
      // The empty-outbox/zero-row assertions below hold even if the dormancy bail itself
      // were deleted (there is nothing configured to evaluate or send either way), so the
      // evaluator spy is what actually proves the bail short-circuited the tick.
      expect(evaluate).not.toHaveBeenCalled();
      expect(sender).not.toHaveBeenCalled();
      const { n } = t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
      expect(n).toBe(0);

      // Enabling a channel lifts the dormancy bail: the very next tick must reach the
      // evaluator exactly once.
      const userId = insertTestUser(t.db, { username: 'dormancy-probe' });
      saveSmtp({
        preset: 'brevo',
        host: 'h',
        port: 587,
        security: 'starttls',
        username: 'u',
        password: 'p',
        fromEmail: 'f@e.com',
        fromName: 'Budget Tracker',
        enabled: true,
      });
      saveEmailTarget({ userId, destination: 'probe@example.com', enabled: true });
      runNotifyTick(new Date());
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      evaluate.mockRestore();
      resetNotifySenderForTests();
      t.cleanup();
    }
  });

  it('registers and stops the notify task with the others', () => {
    startScheduler();
    expect(isSchedulerRunning()).toBe(true);
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  it('MUST-14.1: a nightly failure raises backup_failed with the same error the job threw', () => {
    const boom = new Error('ENOSPC: no space left on device');
    const nightly = vi.spyOn(backupModule, 'runNightlyJob').mockImplementation(() => {
      throw boom;
    });
    const raise = vi.spyOn(raiseModule, 'raiseBackupFailed').mockImplementation(() => {});
    try {
      const at = new Date('2026-08-17T06:00:00Z');
      // Deleting the raiseBackupFailed call from the scheduler's nightly catch would leave
      // runNightlyTick's own error handling intact (it still logs and swallows), so the
      // meaningful assertion is that the raise was actually reached with the real error —
      // not merely that runNightlyTick didn't throw.
      expect(() => runNightlyTick(at)).not.toThrow();
      expect(nightly).toHaveBeenCalledWith(at);
      expect(raise).toHaveBeenCalledWith({ error: boom, at });
    } finally {
      raise.mockRestore();
      nightly.mockRestore();
    }
  });
});
