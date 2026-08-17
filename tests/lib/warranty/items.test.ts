import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import {
  BILLING_KIND_ERROR,
  FUTURE_PURCHASE_DATE_ERROR,
  LIFETIME_WITH_TERM_ERROR,
  attachStagedReceipts,
  createWarrantyItem,
  deleteWarrantyItem,
  deleteWarrantyReceipt,
  getWarrantyItem,
  getWarrantyReceipt,
  listStoredFilenames,
  listWarrantyReceipts,
  resetReceiptForReOcr,
  sha256AlreadyOnItem,
  updateWarrantyItem,
  warrantyInputSchema,
  type WarrantyInput,
} from '@/lib/warranty/items';
import { receiptFileExists } from '@/lib/warranty/receipts';
import { findStagedReceipt, readSidecar, writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { drainOcrQueue, ocrQueueDepth, resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';
import { createItemType, renameItemType } from '@/lib/warranty/types';
import { MAX_RECEIPT_BYTES } from '@/lib/warranty/receipts';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let ownerId: number;

const TODAY = '2026-08-16';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-warranty-items-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  ownerId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  resetOcrQueueForTests();
  setOcrEngineForTests({ recognize: async () => ({ text: 'ENGINE TEXT' }) });
});

afterEach(async () => {
  // M7: a test that enqueues an OCR job (directly, or indirectly via commitStaged's now-
  // deferred-but-still-eventually-called enqueueOcrJob) without itself awaiting
  // drainOcrQueue() would otherwise leave that job's pump running past this test's own
  // teardown -- it can then resolve against the NEXT test's freshly-opened database (or,
  // outside this suite's faked engine, the real OCR engine), producing flaky, hard-to-trace
  // failures far from their actual cause. Draining here, before the db is closed and before
  // the fake engine is torn down, guarantees every job started by this test finishes with
  // the same db/engine it was queued against.
  await drainOcrQueue();
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ref = (stagingId: string, originalFilename = 'receipt.jpg') => ({ stagingId, originalFilename });

function input(over: Partial<WarrantyInput> = {}): WarrantyInput {
  return {
    name: 'Fridge',
    vendor: 'Home Depot',
    model: 'GDT645SYNFS',
    serial: null,
    purchaseDate: TODAY,
    warrantyMonths: 24,
    isLifetime: false,
    priceCents: 129999,
    ownerUserId: ownerId,
    transactionId: null,
    typeId: null,
    notes: null,
    ...over,
  };
}

describe('warrantyInputSchema', () => {
  const schema = () => warrantyInputSchema(TODAY);

  it('accepts a well-formed item', () => {
    expect(schema().safeParse(input()).success).toBe(true);
  });

  it('rejects lifetime combined with a term (MUST-3.5)', () => {
    const parsed = schema().safeParse(input({ isLifetime: true, warrantyMonths: 12 }));
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0].message).toBe(LIFETIME_WITH_TERM_ERROR);
  });

  it('accepts lifetime with no term', () => {
    expect(schema().safeParse(input({ isLifetime: true, warrantyMonths: null })).success).toBe(true);
  });

  it('accepts an unknown term (null months, not lifetime)', () => {
    expect(schema().safeParse(input({ warrantyMonths: null })).success).toBe(true);
  });

  it('rejects a future purchase date and a pre-1970 one', () => {
    const future = schema().safeParse(input({ purchaseDate: '2026-08-17' }));
    expect(future.success).toBe(false);
    expect(future.success === false && future.error.issues[0].message).toBe(FUTURE_PURCHASE_DATE_ERROR);
    expect(schema().safeParse(input({ purchaseDate: '1969-12-31' })).success).toBe(false);
    expect(schema().safeParse(input({ purchaseDate: 'not-a-date' })).success).toBe(false);
    expect(schema().safeParse(input({ purchaseDate: TODAY })).success).toBe(true);
  });

  it('rejects a name over 200 chars, notes over 2000, and a non-integer price', () => {
    expect(schema().safeParse(input({ name: 'x'.repeat(201) })).success).toBe(false);
    expect(schema().safeParse(input({ name: '   ' })).success).toBe(false);
    expect(schema().safeParse(input({ notes: 'x'.repeat(2001) })).success).toBe(false);
    expect(schema().safeParse(input({ priceCents: 12.5 })).success).toBe(false);
    expect(schema().safeParse(input({ priceCents: -1 })).success).toBe(false);
    expect(schema().safeParse(input({ warrantyMonths: 0 })).success).toBe(false);
  });

  it('normalises blank optional text to null', () => {
    const parsed = schema().parse(input({ vendor: '  ', model: '', serial: '  ', notes: '' }));
    expect(parsed).toMatchObject({ vendor: null, model: null, serial: null, notes: null });
  });

  it('accepts a null typeId ("unclassified") and rejects a non-positive one (delta T6)', () => {
    expect(schema().safeParse(input({ typeId: null })).success).toBe(true);
    expect(schema().safeParse(input({ typeId: 0 })).success).toBe(false);
    expect(schema().safeParse(input({ typeId: -1 })).success).toBe(false);
    expect(schema().safeParse(input({ typeId: 1.5 })).success).toBe(false);
  });

  // v1.3.0: billing cycle + amount for subscriptions/contracts (§ user request). This
  // schema is shape-only (a real enum value, or null/omitted) -- whether billing even
  // APPLIES to the item's kind is checked separately, by createWarrantyItem/
  // updateWarrantyItem below, since that needs a DB lookup of the type's kind.
  describe('billing cycle and amount (shape only)', () => {
    it('accepts omitted billing fields, defaulting to undefined (normalised to null on write)', () => {
      const parsed = schema().safeParse(input());
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.billingCycle).toBeUndefined();
      expect(parsed.success && parsed.data.billingAmountCents).toBeUndefined();
    });

    it('accepts null and both valid billing cycle values', () => {
      expect(schema().safeParse(input({ billingCycle: null })).success).toBe(true);
      expect(schema().safeParse(input({ billingCycle: 'monthly' })).success).toBe(true);
      expect(schema().safeParse(input({ billingCycle: 'annual' })).success).toBe(true);
    });

    it('rejects a billing cycle outside monthly/annual', () => {
      const parsed = schema().safeParse(input({ billingCycle: 'weekly' as unknown as WarrantyInput['billingCycle'] }));
      expect(parsed.success).toBe(false);
      expect(parsed.success === false && parsed.error.issues[0].message).toBe('Billing must be Monthly or Annual.');
    });

    it('accepts a non-negative billing amount and rejects a negative one', () => {
      expect(schema().safeParse(input({ billingAmountCents: 0 })).success).toBe(true);
      expect(schema().safeParse(input({ billingAmountCents: 1599 })).success).toBe(true);
      const parsed = schema().safeParse(input({ billingAmountCents: -1 }));
      expect(parsed.success).toBe(false);
      expect(parsed.success === false && parsed.error.issues[0].message).toBe('The amount must be a positive number.');
    });

    it('rejects a non-integer billing amount', () => {
      expect(schema().safeParse(input({ billingAmountCents: 15.5 })).success).toBe(false);
    });
  });
});

describe('createWarrantyItem', () => {
  it('computes and stores expiry_date at write time (MUST-3.6)', () => {
    const id = createWarrantyItem(input({ purchaseDate: '2026-01-31', warrantyMonths: 1 }));
    expect(getWarrantyItem(id)?.expiryDate).toBe('2026-02-28');
  });

  it('stores null expiry for lifetime and for an unknown term', () => {
    const lifetime = createWarrantyItem(input({ isLifetime: true, warrantyMonths: null }));
    expect(getWarrantyItem(lifetime)?.expiryDate).toBeNull();
    expect(getWarrantyItem(lifetime)?.isLifetime).toBe(true);
    const unknown = createWarrantyItem(input({ warrantyMonths: null }));
    expect(getWarrantyItem(unknown)?.expiryDate).toBeNull();
  });

  it('joins the owner name for display', () => {
    const id = createWarrantyItem(input());
    expect(getWarrantyItem(id)?.ownerName).toBe('Alice');
  });

  it('returns null for an unknown id', () => {
    expect(getWarrantyItem(999)).toBeNull();
  });
});

// v1.3.0: billing cycle + amount for subscriptions/contracts (§ user request).
describe('billing cycle and amount', () => {
  it('round-trips billingCycle and billingAmountCents on create for a subscription type', () => {
    const sub = createItemType('Streaming Billing', 'subscription');
    const id = createWarrantyItem(input({ typeId: sub.id, billingCycle: 'monthly', billingAmountCents: 1599 }));
    const row = getWarrantyItem(id)!;
    expect(row.billingCycle).toBe('monthly');
    expect(row.billingAmountCents).toBe(1599);
  });

  it('round-trips billingCycle and billingAmountCents on create for a contract type', () => {
    const contract = createItemType('Gym Billing', 'contract');
    const id = createWarrantyItem(input({ typeId: contract.id, billingCycle: 'annual', billingAmountCents: 49999 }));
    const row = getWarrantyItem(id)!;
    expect(row.billingCycle).toBe('annual');
    expect(row.billingAmountCents).toBe(49999);
  });

  it('defaults billingCycle/billingAmountCents to null when omitted', () => {
    const id = createWarrantyItem(input());
    const row = getWarrantyItem(id)!;
    expect(row.billingCycle).toBeNull();
    expect(row.billingAmountCents).toBeNull();
  });

  it('round-trips a change to billing fields on update', () => {
    const sub = createItemType('Streaming Billing Update', 'subscription');
    const id = createWarrantyItem(input({ typeId: sub.id, billingCycle: 'monthly', billingAmountCents: 999 }));
    updateWarrantyItem(id, input({ typeId: sub.id, billingCycle: 'annual', billingAmountCents: 9999 }));
    const row = getWarrantyItem(id)!;
    expect(row.billingCycle).toBe('annual');
    expect(row.billingAmountCents).toBe(9999);
  });

  it('clears billing fields back to null on update', () => {
    const sub = createItemType('Streaming Billing Clear', 'subscription');
    const id = createWarrantyItem(input({ typeId: sub.id, billingCycle: 'monthly', billingAmountCents: 999 }));
    updateWarrantyItem(id, input({ typeId: sub.id, billingCycle: null, billingAmountCents: null }));
    const row = getWarrantyItem(id)!;
    expect(row.billingCycle).toBeNull();
    expect(row.billingAmountCents).toBeNull();
  });

  it('refuses billingCycle on a warranty-kind item, and writes nothing', () => {
    const warranty = createItemType('Appliance Billing', 'warranty');
    expect(() => createWarrantyItem(input({ typeId: warranty.id, billingCycle: 'monthly' }))).toThrowError(
      BILLING_KIND_ERROR,
    );
  });

  it('refuses billingAmountCents on a loan-kind item, and writes nothing', () => {
    const loan = createItemType('Car Loan Billing', 'loan');
    expect(() => createWarrantyItem(input({ typeId: loan.id, billingAmountCents: 100 }))).toThrowError(
      BILLING_KIND_ERROR,
    );
  });

  it('refuses billing fields on an untyped item (untyped normalises to warranty)', () => {
    expect(() => createWarrantyItem(input({ typeId: null, billingCycle: 'monthly' }))).toThrowError(BILLING_KIND_ERROR);
  });

  it('refuses billing fields on update just like on create', () => {
    const warranty = createItemType('Appliance Billing Update', 'warranty');
    const id = createWarrantyItem(input({ typeId: warranty.id }));
    expect(() => updateWarrantyItem(id, input({ typeId: warranty.id, billingAmountCents: 500 }))).toThrowError(
      BILLING_KIND_ERROR,
    );
    // Nothing was written: the item is untouched.
    expect(getWarrantyItem(id)!.billingAmountCents).toBeNull();
  });

  it('allows a subscription/contract item to have no billing set at all', () => {
    const sub = createItemType('Streaming No Billing', 'subscription');
    const id = createWarrantyItem(input({ typeId: sub.id }));
    const row = getWarrantyItem(id)!;
    expect(row.billingCycle).toBeNull();
    expect(row.billingAmountCents).toBeNull();
  });
});

describe('item types (delta T6)', () => {
  it('writes type_id and surfaces typeName/isSubscription true for a subscription type', () => {
    const sub = createItemType('Streaming Items', 'subscription');
    const id = createWarrantyItem(input({ typeId: sub.id }));
    const row = getWarrantyItem(id)!;
    expect(row.typeId).toBe(sub.id);
    expect(row.typeName).toBe('Streaming Items');
    expect(row.isSubscription).toBe(true);
  });

  it('an untyped item surfaces typeName null and isSubscription false, and is still listed', () => {
    const id = createWarrantyItem(input({ typeId: null }));
    const row = getWarrantyItem(id)!;
    expect(row.typeId).toBeNull();
    expect(row.typeName).toBeNull();
    expect(row.isSubscription).toBe(false);
  });

  it('v1.2.2: surfaces the type\'s kind, defaulting to warranty when untyped', () => {
    const loan = createItemType('Car Loan Items', 'loan');
    const typedId = createWarrantyItem(input({ typeId: loan.id }));
    const untypedId = createWarrantyItem(input({ typeId: null }));
    expect(getWarrantyItem(typedId)!.kind).toBe('loan');
    expect(getWarrantyItem(untypedId)!.kind).toBe('warranty');
  });

  it('updateWarrantyItem writes a new type_id', () => {
    const type = createItemType('Laptop Items', 'warranty');
    const id = createWarrantyItem(input({ typeId: null }));
    updateWarrantyItem(id, input({ typeId: type.id }));
    const row = getWarrantyItem(id)!;
    expect(row.typeId).toBe(type.id);
    expect(row.typeName).toBe('Laptop Items');
    expect(row.isSubscription).toBe(false);
  });

  it('renaming a type changes typeName on the next read with no FTS row change', () => {
    const type = createItemType('Gadget Items', 'warranty');
    const id = createWarrantyItem(input({ typeId: type.id, name: 'Rename Probe Item' }));
    const before = current!.db.get<{ c: number }>(
      sql`select count(*) as c from warranty_search where warranty_search match ${'"Probe"'}`,
    );
    renameItemType(type.id, 'Gizmo Items');
    expect(getWarrantyItem(id)?.typeName).toBe('Gizmo Items');
    const after = current!.db.get<{ c: number }>(
      sql`select count(*) as c from warranty_search where warranty_search match ${'"Probe"'}`,
    );
    expect(after.c).toBe(before.c);
  });
});

describe('updateWarrantyItem', () => {
  it('recomputes expiry in the same write when the term changes', () => {
    const id = createWarrantyItem(input({ purchaseDate: '2026-08-16', warrantyMonths: 24 }));
    updateWarrantyItem(id, input({ purchaseDate: '2026-08-16', warrantyMonths: 12 }));
    expect(getWarrantyItem(id)?.expiryDate).toBe('2027-08-16');
    updateWarrantyItem(id, input({ purchaseDate: '2026-03-31', warrantyMonths: 1 }));
    expect(getWarrantyItem(id)?.expiryDate).toBe('2026-04-30');
  });

  it('clears months and expiry when switched to lifetime', () => {
    const id = createWarrantyItem(input());
    updateWarrantyItem(id, input({ isLifetime: true, warrantyMonths: null }));
    const row = getWarrantyItem(id)!;
    expect(row.isLifetime).toBe(true);
    expect(row.warrantyMonths).toBeNull();
    expect(row.expiryDate).toBeNull();
  });

  it('bumps updated_at and returns false for an unknown id', () => {
    const id = createWarrantyItem(input(), [], '2026-08-16T00:00:00.000Z');
    updateWarrantyItem(id, input({ name: 'Dishwasher' }), '2026-08-17T00:00:00.000Z');
    const row = getWarrantyItem(id)!;
    expect(row.name).toBe('Dishwasher');
    expect(row.updatedAt).toBe('2026-08-17T00:00:00.000Z');
    expect(row.createdAt).toBe('2026-08-16T00:00:00.000Z');
    expect(updateWarrantyItem(999, input())).toBe(false);
  });
});

describe('attachStagedReceipts (MUST-6.8)', () => {
  it('moves the file into receipts/, inserts the row, and deletes the sidecar', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'STAGED RECEIPT TEXT' });
    const id = createWarrantyItem(input(), [ref(stagingId)]);

    const receipts = listWarrantyReceipts(id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].ocrStatus).toBe('done');
    expect(receipts[0].mime).toBe('image/jpeg');
    expect(receipts[0].sizeBytes).toBe(JPEG.length);
    expect(receipts[0].fileExists).toBe(true);
    expect(receiptFileExists(receipts[0].storedFilename)).toBe(true);
    expect(findStagedReceipt(stagingId)).toBeNull();
    expect(readSidecar(stagingId)).toBeNull();

    // The OCR text landed in the index, not just the row.
    const hit = current!.db.get<{ id: number }>(
      sql`select rowid as id from warranty_search where warranty_search match ${'"STAGED"'}`,
    );
    expect(hit.id).toBe(id);
  });

  it('inserts as pending and enqueues an OCR job when there is no sidecar', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    const [receipt] = listWarrantyReceipts(id);
    // The commit enqueued it; draining runs the injected fake engine.
    await drainOcrQueue();
    expect(getWarrantyReceipt(receipt.id)?.ocrStatus).toBe('done');
  });

  it('skips a staging id whose file has already been purged, without failing the save', () => {
    const id = createWarrantyItem(input(), [ref('11111111-2222-3333-4444-555555555555')]);
    expect(listWarrantyReceipts(id)).toHaveLength(0);
    expect(getWarrantyItem(id)).not.toBeNull();
  });

  it('skips a staged file that no longer sniffs to an accepted type', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    fs.writeFileSync(findStagedReceipt(stagingId)!.path, Buffer.from('PK not an image'));
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    expect(listWarrantyReceipts(id)).toHaveLength(0);
  });

  it('attaches to an existing item and flags a duplicate sha256 without blocking (MUST-6.9)', () => {
    const first = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(first)]);
    const digest = listWarrantyReceipts(id)[0].sha256;
    expect(sha256AlreadyOnItem(id, digest)).toBe(true);
    expect(sha256AlreadyOnItem(id, 'b'.repeat(64))).toBe(false);

    const second = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(attachStagedReceipts(id, [ref(second)])).toHaveLength(1);
    expect(listWarrantyReceipts(id)).toHaveLength(2);
  });
});

describe('commit-time re-validation (M4 / M5)', () => {
  it('skips a staged file that has grown past MAX_RECEIPT_BYTES since upload, without failing the save', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    // Simulate a staged file that grew (or was swapped) between upload and save.
    const oversized = Buffer.concat([JPEG, Buffer.alloc(MAX_RECEIPT_BYTES)]);
    fs.writeFileSync(findStagedReceipt(stagingId)!.path, oversized);
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    // The item itself still saves; only this one receipt is skipped.
    expect(getWarrantyItem(id)).not.toBeNull();
    expect(listWarrantyReceipts(id)).toHaveLength(0);
  });

  it('skips a staged file that has been truncated to zero bytes', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    fs.writeFileSync(findStagedReceipt(stagingId)!.path, Buffer.alloc(0));
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    expect(listWarrantyReceipts(id)).toHaveLength(0);
  });

  it('sanitises slashes, backslashes, quotes and control characters out of originalFilename', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const nul = String.fromCharCode(0);
    const id = createWarrantyItem(input(), [ref(stagingId, `..\\/evil${nul}"name.jpg`)]);
    const [receipt] = listWarrantyReceipts(id);
    expect(receipt.originalFilename).toBe('..evilname.jpg');
  });

  it('falls back to a generated name when sanitising leaves nothing displayable', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(stagingId, '///\\\\"""')]);
    const [receipt] = listWarrantyReceipts(id);
    expect(receipt.originalFilename).toBe(`receipt.${receipt.storedFilename.split('.').pop()}`);
  });
});

describe('deferred post-transaction effects (IMPORTANT 3)', () => {
  it('a mid-transaction throw leaves an earlier sidecar intact and enqueues nothing', () => {
    const survivorId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(survivorId, { status: 'done', text: 'SIDECAR SHOULD SURVIVE' });
    // No sidecar for this one: committing successfully would have enqueued an OCR job for it.
    const pendingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const failingId = writeStagedReceipt(JPEG, 'image/jpeg');

    // Force the THIRD receipt's INSERT to fail, deterministically, so the whole transaction
    // rolls back -- simulating "something goes wrong mid-commit" without depending on a real
    // constraint that commit-time re-validation (M4) might otherwise legitimately route
    // around (a skip, not a throw).
    current!.sqlite.exec(`
      CREATE TEMP TRIGGER force_fail_third_receipt
      BEFORE INSERT ON warranty_receipts
      WHEN NEW.original_filename = 'FORCE_FAIL.jpg'
      BEGIN
        SELECT RAISE(ABORT, 'forced failure for test');
      END;
    `);

    expect(() =>
      createWarrantyItem(input(), [
        ref(survivorId, 'survivor.jpg'),
        ref(pendingId, 'pending.jpg'),
        ref(failingId, 'FORCE_FAIL.jpg'),
      ]),
    ).toThrow();

    // Nothing committed: the whole transaction (item + all three receipt rows) rolled back.
    const itemCount = current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`);
    expect(itemCount.c).toBe(0);

    // The survivor's sidecar-deletion was queued as a deferred effect while the transaction
    // was still open; since the transaction never actually committed, that effect must never
    // have run -- the sidecar is still exactly where it was.
    expect(readSidecar(survivorId)).not.toBeNull();
    // Likewise the pending receipt's OCR-enqueue was queued as a deferred effect and
    // abandoned: nothing should have reached the real queue.
    expect(ocrQueueDepth()).toBe(0);
  });

  it('a successful commit still deletes sidecars and enqueues OCR jobs as before', async () => {
    const withSidecar = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(withSidecar, { status: 'done', text: 'SHOULD BE DELETED' });
    const withoutSidecar = writeStagedReceipt(JPEG, 'image/jpeg');

    const id = createWarrantyItem(input(), [ref(withSidecar), ref(withoutSidecar)]);

    // Deferred effects flush synchronously right after the transaction returns -- no await
    // needed to observe them.
    expect(readSidecar(withSidecar)).toBeNull();
    const receipts = listWarrantyReceipts(id);
    const pendingReceipt = receipts.find((r) => r.ocrStatus === 'pending')!;
    expect(pendingReceipt).toBeDefined();

    await drainOcrQueue();
    expect(getWarrantyReceipt(pendingReceipt.id)?.ocrStatus).toBe('done');
  });
});

describe('deletion (MUST-4.8)', () => {
  it('removes the receipt row, its FTS text and its file', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'DELETEME TOKEN' });
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    const [receipt] = listWarrantyReceipts(id);

    expect(deleteWarrantyReceipt(receipt.id)).toBe(true);
    expect(listWarrantyReceipts(id)).toHaveLength(0);
    expect(receiptFileExists(receipt.storedFilename)).toBe(false);
    const hit = current!.db.get<{ c: number }>(
      sql`select count(*) as c from warranty_search where warranty_search match ${'"DELETEME"'}`,
    );
    expect(hit.c).toBe(0);
    expect(deleteWarrantyReceipt(receipt.id)).toBe(false);
  });

  it('deleting the item cascades the rows and unlinks every file', () => {
    const a = writeStagedReceipt(JPEG, 'image/jpeg');
    const b = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(a), ref(b)]);
    const stored = listWarrantyReceipts(id).map((r) => r.storedFilename);
    expect(stored).toHaveLength(2);

    expect(deleteWarrantyItem(id)).toBe(true);
    expect(getWarrantyItem(id)).toBeNull();
    for (const name of stored) expect(receiptFileExists(name)).toBe(false);
    const count = current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_search`);
    expect(count.c).toBe(0);
    expect(deleteWarrantyItem(id)).toBe(false);
  });
});

describe('resetReceiptForReOcr (MUST-7.16)', () => {
  it('sets pending, clears text and error, and re-enqueues', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    const [receipt] = listWarrantyReceipts(id);
    expect(receipt.ocrStatus).toBe('failed');
    expect(receipt.ocrError).toBe('OCR timed out.');

    expect(resetReceiptForReOcr(receipt.id)).toBe(true);
    await drainOcrQueue();

    const after = getWarrantyReceipt(receipt.id)!;
    expect(after.ocrStatus).toBe('done');
    expect(after.ocrError).toBeNull();
    expect(resetReceiptForReOcr(999)).toBe(false);
  });
});

describe('listStoredFilenames', () => {
  it('returns every stored_filename for the orphan sweep', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    expect(listStoredFilenames()).toEqual([listWarrantyReceipts(id)[0].storedFilename]);
  });
});

describe('missing files degrade quietly (MUST-4.10)', () => {
  it('reports fileExists false instead of throwing', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    const [receipt] = listWarrantyReceipts(id);
    fs.rmSync(path.join(dataDir, 'receipts', receipt.storedFilename), { force: true });
    expect(listWarrantyReceipts(id)[0].fileExists).toBe(false);
    expect(getWarrantyReceipt(receipt.id)?.fileExists).toBe(false);
  });
});
