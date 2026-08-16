import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, type TestDb } from '../helpers/db';

const FAKE_USER = { id: 1, name: 'Alice', username: 'alice', role: 'admin' as const };

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => FAKE_USER),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { saveWizardProfileAction } from '@/app/(app)/import/actions';
import { getBuiltinPreset, getProfileByName, listProfiles } from '@/lib/import/presets';
import { writeStagedFile, stagedFilePath } from '@/lib/import/staging';

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-wizard-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('saveWizardProfileAction (new-bank wizard)', () => {
  it('saves a new named profile from the mapping and deletes the staged sample file', async () => {
    const stagingId = writeStagedFile(Buffer.from('sample'));
    const mapping = getBuiltinPreset('Scotiabank Chequing/Debit');

    const result = await saveWizardProfileAction(
      {},
      formData({
        name: 'Tangerine Chequing',
        institution: 'Tangerine',
        mapping: JSON.stringify(mapping),
        stagingId,
      }),
    );

    expect(result.message).toMatch(/Saved "Tangerine Chequing"/);
    const saved = getProfileByName('Tangerine Chequing');
    expect(saved).toMatchObject({ name: 'Tangerine Chequing', institution: 'Tangerine', isBuiltin: false });
    expect(saved!.mapping).toEqual(mapping);
    expect(fs.existsSync(stagedFilePath(stagingId))).toBe(false);
  });

  it('rejects a duplicate profile name without creating a second row', async () => {
    const before = listProfiles().length;
    const mapping = getBuiltinPreset('Scotiabank Chequing/Debit');

    const result = await saveWizardProfileAction(
      {},
      formData({ name: 'TD Chequing/Debit', institution: 'TD Canada Trust', mapping: JSON.stringify(mapping) }),
    );

    expect(result.error).toMatch(/already exists/i);
    expect(listProfiles()).toHaveLength(before);
  });

  it('rejects a malformed mapping instead of saving a broken profile', async () => {
    const before = listProfiles().length;
    const result = await saveWizardProfileAction(
      {},
      formData({ name: 'Broken Bank', institution: 'Some Bank', mapping: JSON.stringify({ ...getBuiltinPreset('TD Visa'), descCols: [] }) }),
    );

    expect(result.error).toBeTruthy();
    expect(listProfiles()).toHaveLength(before);
    expect(getProfileByName('Broken Bank')).toBeNull();
  });
});
