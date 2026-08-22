import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../../helpers/db';
import { OCR_SYSTEMIC_FAILURE_STREAK, isOcrFailingSystemically } from '@/lib/warranty/ocr/health';

let current: TestDb | null = null;
const ISO = '2026-08-16T12:00:00.000Z';

beforeEach(() => {
  current = createSeededTestDb();
});

afterEach(() => {
  current?.cleanup();
  current = null;
});

function makeItem(): number {
  const userId = insertTestUser(current!.db, { username: 'alice' });
  return current!.db.get<{ id: number }>(
    sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
        values ('Fridge', '2026-08-16', 0, ${userId}, ${ISO}, ${ISO}) returning id`,
  ).id;
}

function makeReceipt(itemId: number, status: 'pending' | 'done' | 'failed'): number {
  return current!.db.get<{ id: number }>(
    sql`insert into warranty_receipts
          (warranty_item_id, original_filename, stored_filename, mime, size_bytes, sha256, ocr_status, created_at)
        values (${itemId}, 'r.jpg', ${`${Math.random()}.jpg`}, 'image/jpeg', 64, ${'a'.repeat(64)}, ${status}, ${ISO})
        returning id`,
  ).id;
}

describe('defect fix (v1.5.0): isOcrFailingSystemically', () => {
  it('is false on a fresh install with zero receipts — no evidence is not the same as failing', () => {
    expect(isOcrFailingSystemically()).toBe(false);
  });

  it(`is false with fewer than ${OCR_SYSTEMIC_FAILURE_STREAK} processed receipts, even if every one of them failed`, () => {
    const itemId = makeItem();
    for (let i = 0; i < OCR_SYSTEMIC_FAILURE_STREAK - 1; i += 1) makeReceipt(itemId, 'failed');
    expect(isOcrFailingSystemically()).toBe(false);
  });

  it(`is true once the ${OCR_SYSTEMIC_FAILURE_STREAK} most recent processed receipts all failed`, () => {
    const itemId = makeItem();
    for (let i = 0; i < OCR_SYSTEMIC_FAILURE_STREAK; i += 1) makeReceipt(itemId, 'failed');
    expect(isOcrFailingSystemically()).toBe(true);
  });

  it('is false when even one of the most recent processed receipts succeeded', () => {
    const itemId = makeItem();
    makeReceipt(itemId, 'done');
    for (let i = 0; i < OCR_SYSTEMIC_FAILURE_STREAK - 1; i += 1) makeReceipt(itemId, 'failed');
    expect(isOcrFailingSystemically()).toBe(false);
  });

  it('excludes pending receipts from the streak — an in-flight job carries no verdict yet', () => {
    const itemId = makeItem();
    for (let i = 0; i < OCR_SYSTEMIC_FAILURE_STREAK; i += 1) makeReceipt(itemId, 'failed');
    // A brand-new upload just queued behind them must not reset or interfere with the streak.
    makeReceipt(itemId, 'pending');
    expect(isOcrFailingSystemically()).toBe(true);
  });

  it('looks at the MOST RECENT receipts, not an all-time count — an old bad streak recovers', () => {
    const itemId = makeItem();
    for (let i = 0; i < OCR_SYSTEMIC_FAILURE_STREAK; i += 1) makeReceipt(itemId, 'failed');
    for (let i = 0; i < OCR_SYSTEMIC_FAILURE_STREAK; i += 1) makeReceipt(itemId, 'done');
    expect(isOcrFailingSystemically()).toBe(false);
  });
});
