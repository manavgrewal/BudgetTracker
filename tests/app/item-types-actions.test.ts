import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';

const ADMIN = { id: 1, name: 'Alice', username: 'alice', role: 'admin' as const };
let adminAllowed = true;
let mockHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => {
    if (!adminAllowed) throw new Error('FORBIDDEN');
    return ADMIN;
  }),
}));

vi.mock('next/headers', () => ({ headers: async () => mockHeaders }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  createItemTypeAction,
  deleteItemTypeAction,
  renameItemTypeAction,
  setSubscriptionAction,
} from '@/app/(app)/settings/item-types/actions';
import { listItemTypes } from '@/lib/warranty/types';

const SAME_ORIGIN = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
const CROSS_ORIGIN = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  mockHeaders = SAME_ORIGIN;
  adminAllowed = true;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function idOf(name: string): number {
  return listItemTypes().find((t) => t.name === name)!.id;
}

describe('cross-origin rejection (MUST-13.1)', () => {
  it('rejects every mutating action before touching the database', async () => {
    current = createTestDb();
    mockHeaders = CROSS_ORIGIN;
    const laptop = idOf('Laptop');
    for (const result of [
      await createItemTypeAction({}, formData({ name: 'Router', isSubscription: '0' })),
      await renameItemTypeAction({}, formData({ typeId: String(laptop), name: 'Notebook' })),
      await setSubscriptionAction({}, formData({ typeId: String(laptop), isSubscription: '1' })),
      await deleteItemTypeAction({}, formData({ typeId: String(laptop) })),
    ]) {
      expect(result.error).toMatch(/cross-origin/i);
    }
    expect(listItemTypes().map((t) => t.name)).toEqual(['Appliance', 'Laptop', 'Subscription']);
  });
});

describe('admin gate', () => {
  it('refuses a non-admin caller', async () => {
    current = createTestDb();
    adminAllowed = false;
    await expect(createItemTypeAction({}, formData({ name: 'Router', isSubscription: '0' }))).rejects.toThrow(
      /FORBIDDEN/,
    );
  });
});

describe('subscription flag FormData shape (regression: hidden-input shadowing)', () => {
  // The create form used to render `<input type="hidden" name="isSubscription" value="0">`
  // as a sibling BEFORE `<input type="checkbox" name="isSubscription" value="1">`.
  // FormData.get() returns the FIRST value for a repeated key, so a checked box still
  // produced formData.get('isSubscription') === '0' -- the admin's choice was silently
  // discarded. The hidden input was deleted; these tests lock in the two real shapes an
  // HTML form can actually submit for a checkbox, plus (for documentation) the duplicate-
  // key shape the old broken form used to produce.

  it('is a subscription when the checkbox key is present with value "1" (box checked)', async () => {
    current = createTestDb();
    await createItemTypeAction({}, formData({ name: 'Streaming service', isSubscription: '1' }));
    expect(listItemTypes().find((t) => t.name === 'Streaming service')).toMatchObject({ isSubscription: true });
  });

  it('is NOT a subscription when the checkbox key is absent entirely (box unchecked)', async () => {
    current = createTestDb();
    await createItemTypeAction({}, formData({ name: 'Router' }));
    expect(listItemTypes().find((t) => t.name === 'Router')).toMatchObject({ isSubscription: false });
  });

  it('documents current get()-first semantics for the old duplicate-key shape', async () => {
    current = createTestDb();
    const fd = new FormData();
    fd.set('name', 'Legacy shape');
    fd.append('isSubscription', '0');
    fd.append('isSubscription', '1');
    await createItemTypeAction({}, fd);
    // formData.get('isSubscription') resolves to the FIRST appended value ('0'), exactly
    // the failure mode the hidden input produced -- documented here, not relied upon.
    expect(listItemTypes().find((t) => t.name === 'Legacy shape')).toMatchObject({ isSubscription: false });
  });
});

describe('happy paths and refusals', () => {
  it('creates, renames, toggles and deletes', async () => {
    current = createTestDb();
    expect((await createItemTypeAction({}, formData({ name: ' Router ', isSubscription: '0' }))).message).toBeTruthy();
    const router = idOf('Router');
    expect((await renameItemTypeAction({}, formData({ typeId: String(router), name: 'Modem' }))).message).toBeTruthy();
    expect(
      (await setSubscriptionAction({}, formData({ typeId: String(router), isSubscription: '1' }))).message,
    ).toBeTruthy();
    expect(listItemTypes().find((t) => t.id === router)).toMatchObject({ name: 'Modem', isSubscription: true });
    expect((await deleteItemTypeAction({}, formData({ typeId: String(router) }))).message).toBeTruthy();
    expect(listItemTypes().some((t) => t.id === router)).toBe(false);
  });

  it('surfaces the duplicate-name message instead of throwing', async () => {
    current = createTestDb();
    const result = await createItemTypeAction({}, formData({ name: 'laptop', isSubscription: '0' }));
    expect(result.error).toMatch(/already exists/i);
  });

  it('surfaces the in-use count instead of deleting (MUST-19.5)', async () => {
    current = createTestDb();
    current.sqlite
      .prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin','2026-08-16T00:00:00.000Z')")
      .run();
    const laptop = idOf('Laptop');
    current.sqlite
      .prepare(
        `insert into warranty_items
          (name, purchase_date, warranty_months, is_lifetime, expiry_date, owner_user_id, type_id, created_at, updated_at)
         values ('ThinkPad','2026-08-16',24,0,'2028-08-16',1,?, '2026-08-16T00:00:00.000Z','2026-08-16T00:00:00.000Z')`,
      )
      .run(laptop);
    const result = await deleteItemTypeAction({}, formData({ typeId: String(laptop) }));
    expect(result.error).toMatch(/1 item uses this type/i);
    expect(listItemTypes().some((t) => t.id === laptop)).toBe(true);
  });
});
