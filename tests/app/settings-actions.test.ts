import { describe, it, expect, vi, afterEach } from 'vitest';

// confirmTotpEnrollmentAction's error-path branches (no cookie / garbage cookie)
// never touch the database — they return before requireUser()'s session lookup
// even matters for this — so @/lib/auth/session is mocked wholesale here rather
// than needing a real test DB + session cookie.
const FAKE_USER = { id: 1, name: 'Alice', username: 'alice', role: 'admin' as const };

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => FAKE_USER),
}));

let cookieValue: { value: string } | undefined;
const fakeCookieStore = {
  get: (_name: string) => cookieValue,
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
  cookies: async () => fakeCookieStore,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { confirmTotpEnrollmentAction } from '@/app/(app)/settings/actions';

afterEach(() => {
  cookieValue = undefined;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('confirmTotpEnrollmentAction — finding 6c: pending-enrollment cookie', () => {
  it('returns a clean error (not a throw) when there is no pending-enrollment cookie', async () => {
    cookieValue = undefined;
    const result = await confirmTotpEnrollmentAction({}, formData({ code: '123456' }));
    expect(result.error).toMatch(/expired/i);
  });

  it('returns the same clean error when the cookie value is garbage/undecryptable, rather than throwing', async () => {
    cookieValue = { value: 'not-a-valid-encrypted-payload' };
    const result = await confirmTotpEnrollmentAction({}, formData({ code: '123456' }));
    expect(result.error).toMatch(/expired/i);
  });

  it('rejects a malformed code before ever reading the pending secret (zod schema, spec-compliance fold-in)', async () => {
    cookieValue = undefined;
    const result = await confirmTotpEnrollmentAction({}, formData({ code: 'not-a-code' }));
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/expired/i);
  });
});
