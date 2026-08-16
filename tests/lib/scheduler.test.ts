import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, type TestDb } from '../helpers/db';
import { NIGHTLY_CRON, OCR_SWEEP_CRON, isSchedulerRunning, startScheduler, stopScheduler } from '@/lib/scheduler';

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
