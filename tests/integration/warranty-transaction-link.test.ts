import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';
import { createWarrantyItem, getWarrantyItem, type WarrantyInput } from '@/lib/warranty/items';
import { displayNameOf, getTransaction } from '@/lib/transactions';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-warranty-link-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('warranty ↔ transaction link (§11, MUST-3.7)', () => {
  it('derives the prefill server-side and survives the transaction being deleted', () => {
    const userId = insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const accountId = insertTestAccount(current!.db, { name: 'Joint Chequing' });
    const txnId = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, display_description, normalized_merchant,
                                amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-08-16', 'HOME DEPOT #7042', 'Home Depot', 'HOME DEPOT',
              -129999, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;

    // Exactly the derivation the add page performs (MUST-11.3).
    const txn = getTransaction(txnId)!;
    const input: WarrantyInput = {
      name: 'Fridge',
      vendor: displayNameOf(txn).replace(/\s+/g, ' ').trim().slice(0, 60),
      model: null,
      serial: null,
      purchaseDate: txn.date,
      warrantyMonths: 24,
      isLifetime: false,
      priceCents: Math.abs(txn.amountCents),
      ownerUserId: userId,
      transactionId: txn.id,
      // type-deltas.md T6: WarrantyInput now requires typeId; the transactions row action
      // leaves type unset for the member to choose (type-deltas.md T10) — NULL, not omitted.
      typeId: null,
      notes: null,
    };
    expect(input.vendor).toBe('Home Depot');
    expect(input.priceCents).toBe(129999);
    expect(input.purchaseDate).toBe('2026-08-16');

    const itemId = createWarrantyItem(input);
    expect(getWarrantyItem(itemId)!.transactionId).toBe(txnId);

    // An import undo deletes the transaction row directly; the FK does the rest.
    current!.db.run(sql`delete from transactions where id = ${txnId}`);

    const survivor = getWarrantyItem(itemId)!;
    expect(survivor).not.toBeNull();
    expect(survivor.transactionId).toBeNull();
    expect(survivor.name).toBe('Fridge');
    expect(survivor.priceCents).toBe(129999);
  });
});
