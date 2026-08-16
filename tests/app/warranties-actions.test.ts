import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';

let currentUser = { id: 1, name: 'Alice', username: 'alice', role: 'member' as const };
let originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(originHeaders),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

import {
  CROSS_ORIGIN_ERROR,
  attachReceiptsAction,
  createWarrantyAction,
  deleteReceiptAction,
  deleteWarrantyAction,
  reRunOcrAction,
  updateWarrantyAction,
} from '@/app/(app)/warranties/actions';
import { getWarrantyItem, listWarrantyReceipts } from '@/lib/warranty/items';
import { receiptFileExists } from '@/lib/warranty/receipts';
import { writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';
import { listItemTypes } from '@/lib/warranty/types';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let ownerId: number;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-warranty-actions-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };
  current = createSeededTestDb();
  ownerId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  currentUser = { id: ownerId, name: 'Alice', username: 'alice', role: 'member' };
  resetOcrQueueForTests();
  setOcrEngineForTests({ recognize: async () => ({ text: 'engine text' }) });
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function baseFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    name: 'Fridge',
    vendor: 'Home Depot',
    model: 'GDT645SYNFS',
    serial: '',
    purchaseDate: '2026-08-16',
    warrantyMonths: '24',
    price: '$1,299.99',
    ownerUserId: String(ownerId),
    transactionId: '',
    notes: '',
    staged: '[]',
    ...over,
  };
}

/** Runs a redirecting action and returns the path it redirected to. */
async function redirectPath(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  throw new Error('expected a redirect');
}

describe('cross-origin rejection comes FIRST (MUST-13.1)', () => {
  const cases: [string, (fd: FormData) => Promise<{ error?: string }>][] = [
    ['createWarrantyAction', (fd) => createWarrantyAction({}, fd)],
    ['updateWarrantyAction', (fd) => updateWarrantyAction({}, fd)],
    ['deleteWarrantyAction', (fd) => deleteWarrantyAction({}, fd)],
    ['attachReceiptsAction', (fd) => attachReceiptsAction({}, fd)],
    ['deleteReceiptAction', (fd) => deleteReceiptAction({}, fd)],
    ['reRunOcrAction', (fd) => reRunOcrAction({}, fd)],
  ];

  it.each(cases)('%s refuses a mismatched Origin without touching the database', async (_name, run) => {
    originHeaders = { origin: 'http://evil.example', host: 'nas.local:3000' };
    const before = current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c;
    const result = await run(formData(baseFields({ itemId: '1', receiptId: '1' })));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(before);
  });
});

describe('createWarrantyAction', () => {
  it('creates the item, converts the price to cents, and redirects to the detail page', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    expect(to).toMatch(/^\/warranties\/\d+$/);
    const id = Number(to.split('/').pop());
    const item = getWarrantyItem(id)!;
    expect(item.name).toBe('Fridge');
    expect(item.priceCents).toBe(129999);
    expect(item.expiryDate).toBe('2028-08-16');
    expect(item.ownerUserId).toBe(ownerId);
  });

  it('stores a positive magnitude even if the price arrives signed (§17.26)', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ price: '-1299.99' }))));
    expect(getWarrantyItem(Number(to.split('/').pop()))!.priceCents).toBe(129999);
  });

  it('handles the Lifetime checkbox by clearing the term', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ isLifetime: 'on', warrantyMonths: '' }))),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()))!;
    expect(item.isLifetime).toBe(true);
    expect(item.warrantyMonths).toBeNull();
    expect(item.expiryDate).toBeNull();
  });

  it('rejects lifetime combined with a term', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ isLifetime: 'on', warrantyMonths: '12' })));
    expect(result.error).toContain('lifetime');
  });

  it('rejects a future purchase date, a name over 200 chars and a non-numeric price', async () => {
    const tomorrow = '2999-01-01';
    expect((await createWarrantyAction({}, formData(baseFields({ purchaseDate: tomorrow })))).error).toBeTruthy();
    expect((await createWarrantyAction({}, formData(baseFields({ name: 'x'.repeat(201) })))).error).toBeTruthy();
    expect((await createWarrantyAction({}, formData(baseFields({ price: 'lots' })))).error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('commits staged receipts with the item', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'STAGED WORD' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'till.jpg' }]) })),
      ),
    );
    const receipts = listWarrantyReceipts(Number(to.split('/').pop()));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].originalFilename).toBe('till.jpg');
    expect(receipts[0].ocrStatus).toBe('done');
  });

  it('rejects a malformed staged payload rather than saving half of it', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ staged: '{"not":"an array"}' })));
    expect(result.error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('accepts a transactionId and links the two', async () => {
    const accountId = insertTestAccount(current!.db, { name: 'Joint Chequing' });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-08-16', 'HOME DEPOT', 'HOME DEPOT', -129999, ${ownerId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ transactionId: String(txn.id) }))),
    );
    expect(getWarrantyItem(Number(to.split('/').pop()))!.transactionId).toBe(txn.id);
  });

  // Delta T8 (type-deltas.md): typeId round-trips; empty/'none' -> null; deleted/unknown
  // typeId is refused with a readable message and nothing is written; omitted -> stored NULL.
  it('round-trips a typeId and surfaces isSubscription from the type', async () => {
    const subscriptionType = listItemTypes().find((t) => t.name === 'Subscription')!;
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ typeId: String(subscriptionType.id) }))),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()))!;
    expect(item.typeId).toBe(subscriptionType.id);
    expect(item.typeName).toBe('Subscription');
    expect(item.isSubscription).toBe(true);
  });

  it('stores NULL when typeId is omitted', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const item = getWarrantyItem(Number(to.split('/').pop()))!;
    expect(item.typeId).toBeNull();
    expect(item.typeName).toBeNull();
    expect(item.isSubscription).toBe(false);
  });

  it('treats an empty string and "none" as NULL', async () => {
    const to1 = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ typeId: '' }))));
    expect(getWarrantyItem(Number(to1.split('/').pop()))!.typeId).toBeNull();
    const to2 = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ typeId: 'none' }))));
    expect(getWarrantyItem(Number(to2.split('/').pop()))!.typeId).toBeNull();
  });

  it('refuses an unknown typeId and writes nothing', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ typeId: '999999' })));
    expect(result.error).toBe('That item type no longer exists.');
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });
});

describe('updateWarrantyAction', () => {
  it('updates fields and recomputes expiry', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const result = await updateWarrantyAction(
      {},
      formData(baseFields({ itemId: String(id), name: 'Dishwasher', warrantyMonths: '12' })),
    );
    expect(result.message).toBeTruthy();
    const item = getWarrantyItem(id)!;
    expect(item.name).toBe('Dishwasher');
    expect(item.expiryDate).toBe('2027-08-16');
  });

  it('errors on an unknown item id', async () => {
    const result = await updateWarrantyAction({}, formData(baseFields({ itemId: '99999' })));
    expect(result.error).toBeTruthy();
  });

  it('round-trips a typeId change on update', async () => {
    const laptop = listItemTypes().find((t) => t.name === 'Laptop')!;
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const result = await updateWarrantyAction({}, formData(baseFields({ itemId: String(id), typeId: String(laptop.id) })));
    expect(result.message).toBeTruthy();
    const item = getWarrantyItem(id)!;
    expect(item.typeId).toBe(laptop.id);
    expect(item.typeName).toBe('Laptop');
  });

  it('refuses an unknown typeId on update and leaves the item unchanged', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const result = await updateWarrantyAction(
      {},
      formData(baseFields({ itemId: String(id), name: 'Should not stick', typeId: '999999' })),
    );
    expect(result.error).toBe('That item type no longer exists.');
    const item = getWarrantyItem(id)!;
    expect(item.name).toBe('Fridge');
    expect(item.typeId).toBeNull();
  });
});

describe('deleteWarrantyAction', () => {
  it('removes the item, its receipt rows, its FTS entries and its files, then redirects', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'DOOMED WORD' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'till.jpg' }]) })),
      ),
    );
    const id = Number(to.split('/').pop());
    const stored = listWarrantyReceipts(id)[0].storedFilename;

    expect(await redirectPath(() => deleteWarrantyAction({}, formData({ itemId: String(id) })))).toBe('/warranties');
    expect(getWarrantyItem(id)).toBeNull();
    expect(receiptFileExists(stored)).toBe(false);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_receipts`).c).toBe(0);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_search`).c).toBe(0);
  });
});

describe('attachReceiptsAction / deleteReceiptAction / reRunOcrAction', () => {
  it('attaches to an existing item and warns about a duplicate without blocking it', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());

    const first = writeStagedReceipt(JPEG, 'image/jpeg');
    await attachReceiptsAction(
      {},
      formData({ itemId: String(id), staged: JSON.stringify([{ stagingId: first, originalFilename: 'a.jpg' }]) }),
    );
    const second = writeStagedReceipt(JPEG, 'image/jpeg');
    const result = await attachReceiptsAction(
      {},
      formData({ itemId: String(id), staged: JSON.stringify([{ stagingId: second, originalFilename: 'a.jpg' }]) }),
    );
    expect(listWarrantyReceipts(id)).toHaveLength(2);
    expect(result.message).toContain('already');
  });

  it('deletes one receipt', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'a.jpg' }]) })),
      ),
    );
    const id = Number(to.split('/').pop());
    const receipt = listWarrantyReceipts(id)[0];
    const result = await deleteReceiptAction({}, formData({ receiptId: String(receipt.id) }));
    expect(result.message).toBeTruthy();
    expect(listWarrantyReceipts(id)).toHaveLength(0);
    expect(receiptFileExists(receipt.storedFilename)).toBe(false);
  });

  it('re-runs OCR and is safe to click twice', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'a.jpg' }]) })),
      ),
    );
    const receipt = listWarrantyReceipts(Number(to.split('/').pop()))[0];
    expect((await reRunOcrAction({}, formData({ receiptId: String(receipt.id) }))).message).toBeTruthy();
    expect((await reRunOcrAction({}, formData({ receiptId: String(receipt.id) }))).message).toBeTruthy();
  });

  it('errors on unknown ids instead of throwing', async () => {
    expect((await deleteReceiptAction({}, formData({ receiptId: '99999' }))).error).toBeTruthy();
    expect((await reRunOcrAction({}, formData({ receiptId: '99999' }))).error).toBeTruthy();
    expect((await deleteReceiptAction({}, formData({ receiptId: 'abc' }))).error).toBeTruthy();
  });
});
