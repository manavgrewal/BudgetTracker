import { describe, it, expect } from 'vitest';
import {
  EXPIRING_SOON_DAYS,
  STATUS_CASE_SQL,
  WARRANTY_STATUSES,
  computeExpiryDate,
  isWarrantyStatus,
  statusLabel,
  warrantyStatus,
} from '@/lib/warranty/expiry';

const TODAY = '2026-08-16';

describe('computeExpiryDate', () => {
  it('is null for a lifetime warranty', () => {
    expect(computeExpiryDate({ purchaseDate: TODAY, warrantyMonths: null, isLifetime: true })).toBeNull();
  });

  it('is null for an unknown term', () => {
    expect(computeExpiryDate({ purchaseDate: TODAY, warrantyMonths: null, isLifetime: false })).toBeNull();
  });

  it('clamps to the last day of the target month', () => {
    expect(computeExpiryDate({ purchaseDate: '2026-01-31', warrantyMonths: 1, isLifetime: false })).toBe('2026-02-28');
    expect(computeExpiryDate({ purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false })).toBe('2028-08-16');
  });

  it('ignores warrantyMonths when isLifetime is true (MUST-3.5)', () => {
    expect(computeExpiryDate({ purchaseDate: TODAY, warrantyMonths: 12, isLifetime: true })).toBeNull();
  });
});

describe('warrantyStatus (spec §3.7)', () => {
  it('exposes the five statuses and a 60-day window', () => {
    expect(EXPIRING_SOON_DAYS).toBe(60);
    expect([...WARRANTY_STATUSES].sort()).toEqual(['active', 'expired', 'expiring', 'lifetime', 'unknown']);
    expect(isWarrantyStatus('expiring')).toBe(true);
    expect(isWarrantyStatus('nonsense')).toBe(false);
  });

  it('returns lifetime before anything else', () => {
    expect(warrantyStatus({ expiryDate: null, isLifetime: true }, TODAY)).toBe('lifetime');
  });

  it('returns unknown for a non-lifetime item with no expiry', () => {
    expect(warrantyStatus({ expiryDate: null, isLifetime: false }, TODAY)).toBe('unknown');
  });

  it('treats coverage as inclusive of expiry_date (MUST-3.14)', () => {
    expect(warrantyStatus({ expiryDate: '2026-08-16', isLifetime: false }, TODAY)).toBe('expiring');
    expect(warrantyStatus({ expiryDate: '2026-08-15', isLifetime: false }, TODAY)).toBe('expired');
  });

  it('draws the expiring/active boundary at exactly 60 days', () => {
    expect(warrantyStatus({ expiryDate: '2026-10-15', isLifetime: false }, TODAY)).toBe('expiring'); // today + 60
    expect(warrantyStatus({ expiryDate: '2026-10-16', isLifetime: false }, TODAY)).toBe('active'); // today + 61
  });
});

describe('statusLabel', () => {
  it('names each badge the way the list page renders it', () => {
    expect(statusLabel('lifetime', null, TODAY)).toBe('Lifetime');
    expect(statusLabel('unknown', null, TODAY)).toBe('Term unknown');
    expect(statusLabel('expired', '2026-08-15', TODAY)).toBe('Expired');
    expect(statusLabel('active', '2027-01-01', TODAY)).toBe('Active');
    expect(statusLabel('expiring', '2026-08-16', TODAY)).toBe('Expires today');
    expect(statusLabel('expiring', '2026-08-17', TODAY)).toBe('Expires in 1 day');
    expect(statusLabel('expiring', '2026-10-15', TODAY)).toBe('Expires in 60 days');
  });
});

describe('STATUS_CASE_SQL', () => {
  it('binds exactly two parameters, today then soon', () => {
    expect(STATUS_CASE_SQL.split('?')).toHaveLength(3);
    expect(STATUS_CASE_SQL).toContain('i.is_lifetime');
    expect(STATUS_CASE_SQL).toContain('i.expiry_date');
  });
});
