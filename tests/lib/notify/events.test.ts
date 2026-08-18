import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS,
  NOTIFICATION_EVENTS,
  backupFailedKey,
  budgetExceededKey,
  budgetPaceKey,
  budgetThresholdKey,
  comingDueKey,
  duplicateChargeKey,
  eventDef,
  eventsFor,
  isChannel,
  isNotificationEventId,
  newSigninKey,
  predictedVsActualKey,
  restoreOutcomeKey,
  staleImportKey,
  subscriptionCreepKey,
  suggestedBudgetRefreshKey,
  unusualTransactionKey,
  updateAvailableKey,
  weeklyDigestKey,
} from '@/lib/notify/events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('MUST-2.1: events.ts is pure and client-safe', () => {
  it('imports neither @/db nor @/lib/env nor any node builtin', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/notify/events.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/env/);
    expect(source).not.toMatch(/from\s+['"]node:/);
  });
});

describe('the fifteen registered events', () => {
  it('has exactly fifteen entries with unique, well-formed ids', () => {
    expect(NOTIFICATION_EVENTS).toHaveLength(15);
    const ids = NOTIFICATION_EVENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(15);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('matches the spec table exactly', () => {
    expect(
      NOTIFICATION_EVENTS.map((e) => [e.id, e.audience, e.trigger, e.defaultEnabled] as const),
    ).toEqual([
      ['coming_due', 'all', 'daily_slot', true],
      ['budget_threshold', 'all', 'tick', false],
      ['budget_exceeded', 'all', 'tick', true],
      ['backup_failed', 'admin', 'immediate', true],
      ['weekly_digest', 'all', 'weekly_slot', false],
      ['new_signin', 'all', 'immediate', true],
      ['restore_outcome', 'admin', 'immediate', true],
      ['stale_import', 'all', 'daily_slot', false],
      ['update_available', 'admin', 'tick', true],
      ['budget_pace', 'all', 'daily_slot', true],
      ['unusual_transaction', 'all', 'tick', true],
      ['subscription_creep', 'all', 'daily_slot', true],
      ['duplicate_charge', 'all', 'tick', true],
      ['predicted_vs_actual', 'all', 'daily_slot', false],
      ['suggested_budget_refresh', 'all', 'daily_slot', false],
    ]);
  });

  it('MUST-4.1: the default-on set is the wrong-or-imminent half', () => {
    const on = NOTIFICATION_EVENTS.filter((e) => e.defaultEnabled).map((e) => e.id).sort();
    expect(on).toEqual([
      'backup_failed',
      'budget_exceeded',
      'budget_pace',
      'coming_due',
      'duplicate_charge',
      'new_signin',
      'restore_outcome',
      'subscription_creep',
      'unusual_transaction',
      'update_available',
    ]);
  });

  it('gives every event a label and a one-sentence blurb', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.label.length).toBeGreaterThan(0);
      expect(event.blurb.length).toBeGreaterThan(0);
    }
  });
});

describe('lookup helpers', () => {
  it('eventDef resolves a known id and returns undefined for an unknown one', () => {
    expect(eventDef('coming_due')?.label).toBe('Something is coming due');
    expect(eventDef('on_pace_overshoot')).toBeUndefined();
    expect(isNotificationEventId('coming_due')).toBe(true);
    expect(isNotificationEventId('on_pace_overshoot')).toBe(false);
  });

  it('MUST-4.3: eventsFor("member") excludes both admin events', () => {
    expect(eventsFor('member').map((e) => e.id)).not.toContain('backup_failed');
    expect(eventsFor('member').map((e) => e.id)).not.toContain('restore_outcome');
    expect(eventsFor('member')).toHaveLength(12);
    expect(eventsFor('admin')).toHaveLength(15);
  });

  it('exposes the two channels', () => {
    expect(CHANNELS).toEqual(['telegram', 'email']);
    expect(isChannel('telegram')).toBe(true);
    expect(isChannel('sms')).toBe(false);
  });
});

describe('MUST-3.11: the exact dedup key strings', () => {
  it('builds every key shape in the table', () => {
    expect(comingDueKey(42, '2026-09-01')).toBe('due:42:2026-09-01');
    expect(budgetThresholdKey('household', 7, '2026-08', 80)).toBe('budget:h:7:2026-08:80');
    expect(budgetThresholdKey('personal', 7, '2026-08', 90)).toBe('budget:p:7:2026-08:90');
    expect(budgetExceededKey('household', 7, '2026-08')).toBe('budget:h:7:2026-08:100');
    expect(budgetExceededKey('personal', 7, '2026-08')).toBe('budget:p:7:2026-08:100');
    expect(backupFailedKey('2026-08-17')).toBe('backup-failed:2026-08-17');
    expect(weeklyDigestKey('2026-08-17')).toBe('digest:2026-08-17');
    expect(newSigninKey('2026-08-17T12:00:00.000Z')).toBe('signin:2026-08-17T12:00:00.000Z');
    expect(restoreOutcomeKey('2026-08-17T12:00:00.000Z')).toBe('restore:2026-08-17T12:00:00.000Z');
    expect(staleImportKey('2026-08-17')).toBe('stale:2026-08-17');
  });

  it('never repeats user or channel inside the key — the unique index already carries them', () => {
    for (const key of [
      comingDueKey(42, '2026-09-01'),
      budgetThresholdKey('household', 7, '2026-08', 80),
      backupFailedKey('2026-08-17'),
    ]) {
      expect(key).not.toMatch(/telegram|email|user/);
    }
  });

  it('a threshold key and an exceeded key for the same category and month never collide', () => {
    expect(budgetThresholdKey('household', 7, '2026-08', 99)).not.toBe(budgetExceededKey('household', 7, '2026-08'));
  });

  it('household and personal are two different facts for the same category', () => {
    expect(budgetExceededKey('household', 7, '2026-08')).not.toBe(budgetExceededKey('personal', 7, '2026-08'));
  });
});

describe('MUST-6.1: the update_available registry entry', () => {
  it('brings the registry to nine and is admin-audience, default-on, tick-triggered', () => {
    expect(NOTIFICATION_EVENTS).toHaveLength(15);
    const entry = eventDef('update_available');
    expect(entry).toEqual({
      id: 'update_available',
      label: 'An update is available',
      blurb: 'A newer version of Budget Tracker is published and is waiting for your say-so.',
      audience: 'admin',
      trigger: 'tick',
      defaultEnabled: true,
    });
  });

  it('MUST-4.3: eventsFor(member) excludes it', () => {
    expect(eventsFor('member').some((e) => e.id === 'update_available')).toBe(false);
    expect(eventsFor('admin').some((e) => e.id === 'update_available')).toBe(true);
  });

  it('MUST-6.3: the dedup key is per version and only ever goes up', () => {
    expect(updateAvailableKey('1.4.0')).toBe('update:1.4.0');
    expect(updateAvailableKey('1.4.0')).not.toBe(updateAvailableKey('1.5.0'));
  });
});

describe('spec section 9: the six predictive dedup keys', () => {
  it('builds every key shape in the table', () => {
    expect(budgetPaceKey('household', 7, '2026-08')).toBe('pace:h:7:2026-08');
    expect(budgetPaceKey('personal', 7, '2026-08')).toBe('pace:p:7:2026-08');
    expect(unusualTransactionKey(4211)).toBe('unusual:4211');
    expect(subscriptionCreepKey(4211)).toBe('creep:4211');
    expect(duplicateChargeKey(31, 44)).toBe('dupe:31:44');
    expect(predictedVsActualKey('2026-07')).toBe('predvs:2026-07');
    expect(suggestedBudgetRefreshKey('2026-08')).toBe('suggest:2026-08');
  });

  it('MUST-9.22: a duplicate pair keys the same way whichever row the scan reaches first', () => {
    expect(duplicateChargeKey(44, 31)).toBe(duplicateChargeKey(31, 44));
  });

  it('a pace key never collides with a threshold or an exceeded key', () => {
    expect(budgetPaceKey('household', 7, '2026-08')).not.toBe(budgetExceededKey('household', 7, '2026-08'));
    expect(budgetPaceKey('household', 7, '2026-08')).not.toBe(budgetThresholdKey('household', 7, '2026-08', 80));
  });

  it('carries neither the user nor the channel, which the unique index already holds', () => {
    for (const key of [budgetPaceKey('personal', 7, '2026-08'), unusualTransactionKey(1), predictedVsActualKey('2026-07')]) {
      expect(key).not.toMatch(/telegram|email|user/);
    }
  });
});
