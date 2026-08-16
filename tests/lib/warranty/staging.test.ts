import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReceiptStagingError,
  STAGING_ID_RE,
  deleteSidecar,
  deleteStagedReceipt,
  findStagedReceipt,
  readSidecar,
  sidecarPath,
  writeSidecar,
  writeStagedReceipt,
} from '@/lib/warranty/staging';
import { receiptTempDir } from '@/lib/warranty/receipts';

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-staging-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

describe('writeStagedReceipt / findStagedReceipt', () => {
  it('writes into the existing DATA_DIR/tmp so purgeStagedFiles already covers it', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(STAGING_ID_RE.test(stagingId)).toBe(true);
    expect(fs.existsSync(path.join(receiptTempDir(), `${stagingId}.jpg`))).toBe(true);
  });

  it('finds a staged file and reports its mime from the stored extension', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const found = findStagedReceipt(stagingId);
    expect(found?.mime).toBe('image/jpeg');
    expect(found?.path).toBe(path.join(receiptTempDir(), `${stagingId}.jpg`));
  });

  it('returns null for an id with no file (expired, or lost to a restart)', () => {
    expect(findStagedReceipt('11111111-2222-3333-4444-555555555555')).toBeNull();
  });

  it('never lets a non-UUID reach path.join (MUST-4.3 / MUST-6.8)', () => {
    for (const bad of ['../budget.db', 'a/b', '', '../../etc/passwd', 'not-a-uuid']) {
      expect(() => findStagedReceipt(bad)).toThrowError(ReceiptStagingError);
      expect(() => sidecarPath(bad)).toThrowError(ReceiptStagingError);
    }
  });

  it('deletes the staged file and is safe to call twice', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    deleteStagedReceipt(stagingId);
    expect(findStagedReceipt(stagingId)).toBeNull();
    expect(() => deleteStagedReceipt(stagingId)).not.toThrow();
  });
});

describe('OCR sidecar (MUST-6.7)', () => {
  it('round-trips a done payload with suggestions', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, {
      status: 'done',
      text: 'HOME DEPOT\nTOTAL 42.00',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200 },
    });
    expect(readSidecar(stagingId)).toEqual({
      status: 'done',
      text: 'HOME DEPOT\nTOTAL 42.00',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200 },
    });
  });

  it('round-trips a failed payload', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    expect(readSidecar(stagingId)).toEqual({ status: 'failed', error: 'OCR timed out.' });
  });

  it('reads null before the worker has written anything (still pending)', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(readSidecar(stagingId)).toBeNull();
  });

  it('reads null rather than throwing on a corrupt sidecar', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    fs.writeFileSync(sidecarPath(stagingId), '{not json');
    expect(readSidecar(stagingId)).toBeNull();
  });

  it('reads null on a structurally-invalid sidecar (valid JSON, wrong shape) rather than trusting a bad cast (M4)', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    fs.writeFileSync(sidecarPath(stagingId), JSON.stringify({ status: 'not-a-real-status' }));
    expect(readSidecar(stagingId)).toBeNull();

    fs.writeFileSync(sidecarPath(stagingId), JSON.stringify({ status: 'done', priceCents: 4200 }));
    // `priceCents` at the top level (not nested under `suggestions`) is not part of the
    // schema, but zod's default (non-strict) object parsing ignores unknown keys rather
    // than rejecting the whole payload — this asserts the still-valid subset comes back.
    expect(readSidecar(stagingId)).toEqual({ status: 'done' });

    fs.writeFileSync(sidecarPath(stagingId), JSON.stringify(['not', 'an', 'object']));
    expect(readSidecar(stagingId)).toBeNull();
  });

  it('deletes the sidecar and is safe to call twice', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'x' });
    deleteSidecar(stagingId);
    expect(readSidecar(stagingId)).toBeNull();
    expect(() => deleteSidecar(stagingId)).not.toThrow();
  });
});
