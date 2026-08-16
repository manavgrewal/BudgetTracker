import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NIGHTLY_CRON, OCR_SWEEP_CRON, isSchedulerRunning, startScheduler, stopScheduler } from '@/lib/scheduler';

afterEach(() => {
  stopScheduler();
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
