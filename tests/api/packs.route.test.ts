import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../helpers/db';
import { GET as rulesExport } from '@/app/api/packs/rules/export/route';
import { POST as rulesImport } from '@/app/api/packs/rules/import/route';
import { GET as profilesExport } from '@/app/api/packs/profiles/export/route';
import { POST as profilesImport } from '@/app/api/packs/profiles/import/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { upsertRuleFromCorrection, listRules } from '@/lib/categorize/rules';
import { listProfiles } from '@/lib/import/presets';
import { MAX_FILE_BYTES } from '@/lib/import/parse';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const admin = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' });
  const member = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: categoryIdByName(current.db, 'Coffee'), createdBy: admin });
  upsertRuleFromCorrection({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: admin });
  return { adminToken: createSession(admin).token, memberToken: createSession(member).token };
}

const headers = (token: string | null, origin = 'http://nas.local:3000') => ({
  origin,
  host: 'nas.local:3000',
  ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
});

function uploadRequest(url: string, body: string, token: string | null, fields: Record<string, string> = {}, origin = 'http://nas.local:3000') {
  const form = new FormData();
  form.append('file', new File([body], 'pack.json', { type: 'application/json' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request(url, { method: 'POST', headers: headers(token, origin), body: form });
}

describe('GET /api/packs/rules/export', () => {
  it('returns a JSON attachment for an admin, transfer rules excluded by default', async () => {
    const { adminToken } = setup();
    const response = await rulesExport(new Request('http://nas.local:3000/api/packs/rules/export', { headers: headers(adminToken) }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toMatch(/attachment; filename="budget-tracker-rules-\d{4}-\d{2}-\d{2}\.json"/);
    const pack = JSON.parse(await response.text()) as { rules: { pattern: string }[] };
    expect(pack.rules.map((r) => r.pattern)).toEqual(['TIM HORTONS']);
  });

  it('includes transfer rules when asked, and honours per-rule exclusion', async () => {
    const { adminToken } = setup();
    const withTransfers = await rulesExport(
      new Request('http://nas.local:3000/api/packs/rules/export?includeTransfers=1', { headers: headers(adminToken) }),
    );
    expect(JSON.parse(await withTransfers.text()).rules).toHaveLength(2);

    const timId = listRules('category')[0].id;
    const excluded = await rulesExport(
      new Request(`http://nas.local:3000/api/packs/rules/export?exclude=${timId}`, { headers: headers(adminToken) }),
    );
    expect(JSON.parse(await excluded.text()).rules).toHaveLength(0);
  });

  it('403s a member and 401s an anonymous caller', async () => {
    const { memberToken } = setup();
    expect((await rulesExport(new Request('http://nas.local:3000/api/packs/rules/export', { headers: headers(memberToken) }))).status).toBe(403);
    expect((await rulesExport(new Request('http://nas.local:3000/api/packs/rules/export', { headers: headers(null) }))).status).toBe(401);
  });

  // Controller ruling (b): same-origin is enforced on every pack route, including
  // this GET — matching the /api/backup/download precedent, since a plain
  // assertSameOrigin() is a no-op on safe methods.
  it('403s a cross-origin GET even from an authenticated admin', async () => {
    const { adminToken } = setup();
    const response = await rulesExport(
      new Request('http://nas.local:3000/api/packs/rules/export', { headers: headers(adminToken, 'http://evil.local') }),
    );
    expect(response.status).toBe(403);
  });
});

describe('POST /api/packs/rules/import', () => {
  const pack = JSON.stringify({
    format: 'budget-tracker-rules',
    version: 1,
    exported_at: '2026-08-15T12:00:00.000Z',
    categories: [{ name: 'Pets', parent: null, is_income: false, icon: null, color: null }],
    rules: [{ pattern: 'PET SUPPLIES', match_type: 'contains', category: 'Pets' }],
  });

  it('previews without writing, then applies', async () => {
    const { adminToken } = setup();
    const preview = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ applied: false, newRules: 1, newCategories: ['Pets'] });
    expect(listRules('category').some((r) => r.pattern === 'PET SUPPLIES')).toBe(false);

    const applied = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken, { mode: 'apply' }));
    expect(await applied.json()).toMatchObject({ applied: true, rulesAdded: 1, categoriesCreated: 1 });
    expect(listRules('category').some((r) => r.pattern === 'PET SUPPLIES')).toBe(true);
  });

  it('400s on a newer version with the message shown to the user', async () => {
    const { adminToken } = setup();
    const newer = JSON.stringify({ ...JSON.parse(pack), version: 2 });
    const response = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', newer, adminToken));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/newer version/i);
  });

  it('400s on an unknown format and on non-JSON', async () => {
    const { adminToken } = setup();
    const wrongFormat = JSON.stringify({ ...JSON.parse(pack), format: 'mint-export' });
    expect((await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', wrongFormat, adminToken))).status).toBe(400);
    const garbage = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', 'not json at all', adminToken));
    expect(garbage.status).toBe(400);
    expect((await garbage.json()).error).toMatch(/valid JSON/i);
  });

  it('403s a cross-origin post and 403s a member', async () => {
    const { adminToken, memberToken } = setup();
    expect((await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, adminToken, {}, 'http://evil.local'))).status).toBe(403);
    expect((await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', pack, memberToken))).status).toBe(403);
  });

  it('413s on the declared content-length alone, before formData() is ever called (controller fix — review finding 1 parity)', async () => {
    const { adminToken } = setup();
    const formDataSpy = vi.fn(async () => {
      throw new Error('formData() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(adminToken), 'content-length': String(MAX_FILE_BYTES + 1) }),
      formData: formDataSpy,
    } as unknown as Request;

    const response = await rulesImport(fakeRequest);
    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it('skips a rule with an unsupported rule_kind (e.g. rename) rather than 400ing the whole pack', async () => {
    const { adminToken } = setup();
    const withRename = JSON.stringify({
      format: 'budget-tracker-rules',
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [],
      rules: [{ pattern: 'MCDONALDS', match_type: 'exact', rule_kind: 'rename', category: null }],
    });
    const response = await rulesImport(uploadRequest('http://nas.local:3000/api/packs/rules/import', withRename, adminToken));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: false, skippedRules: 1, newRules: 0 });
  });
});

describe('profiles pack routes', () => {
  it('exports and re-imports with an auto-rename', async () => {
    const { adminToken } = setup();
    const exported = await profilesExport(new Request('http://nas.local:3000/api/packs/profiles/export', { headers: headers(adminToken) }));
    expect(exported.status).toBe(200);
    const body = await exported.text();
    expect(JSON.parse(body).profiles).toHaveLength(4);

    const preview = await profilesImport(uploadRequest('http://nas.local:3000/api/packs/profiles/import', body, adminToken));
    expect(await preview.json()).toMatchObject({ applied: false, totalProfiles: 4 });
    expect(listProfiles()).toHaveLength(4);

    const applied = await profilesImport(uploadRequest('http://nas.local:3000/api/packs/profiles/import', body, adminToken, { mode: 'apply' }));
    const result = (await applied.json()) as { added: { name: string }[] };
    expect(result.added.map((a) => a.name)).toEqual(['TD Chequing/Debit (2)', 'TD Visa (2)', 'Scotiabank Chequing/Debit (2)', 'Amex Canada (2)']);
    expect(listProfiles()).toHaveLength(8);
  });

  it('403s a member on export and import', async () => {
    const { memberToken } = setup();
    expect((await profilesExport(new Request('http://nas.local:3000/api/packs/profiles/export', { headers: headers(memberToken) }))).status).toBe(403);
    expect((await profilesImport(uploadRequest('http://nas.local:3000/api/packs/profiles/import', '{}', memberToken))).status).toBe(403);
  });

  it('403s a cross-origin GET on export', async () => {
    const { adminToken } = setup();
    const response = await profilesExport(
      new Request('http://nas.local:3000/api/packs/profiles/export', { headers: headers(adminToken, 'http://evil.local') }),
    );
    expect(response.status).toBe(403);
  });

  it('413s on the declared content-length alone, before formData() is ever called (controller fix — review finding 1 parity)', async () => {
    const { adminToken } = setup();
    const formDataSpy = vi.fn(async () => {
      throw new Error('formData() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(adminToken), 'content-length': String(MAX_FILE_BYTES + 1) }),
      formData: formDataSpy,
    } as unknown as Request;

    const response = await profilesImport(fakeRequest);
    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});
