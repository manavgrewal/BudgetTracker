import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/health/route';
import { setDbForTests } from '@/db/client';
import { APP_VERSION } from '@/lib/version';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('GET /api/health', () => {
  it('reports ok when the database answers and the data dir is writable', async () => {
    current = createTestDb();
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      db: string;
      dataDir: string;
      version: string;
      time: string;
    };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.dataDir).toBe('ok');
    // Pinned against package.json, not a literal — a version bump must not need a test edit.
    expect(body.version).toBe(APP_VERSION);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it('reports 503 when the database is unreachable', async () => {
    current = createTestDb();
    current.sqlite.close();
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('error');
    // "Which build is the broken one?" is asked precisely when this returns 503.
    expect(body.version).toBe(APP_VERSION);
    setDbForTests(null);
  });

  it('reports 503 when the data directory cannot be written to', async () => {
    current = createTestDb();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-health-'));
    // A regular file standing in for a directory component makes any mkdirSync
    // underneath it fail with ENOTDIR, on both Windows and POSIX.
    const blockerFile = path.join(base, 'blocker');
    fs.writeFileSync(blockerFile, 'x');
    const badDataDir = path.join(blockerFile, 'nested', 'data');
    const original = process.env.DATA_DIR;
    process.env.DATA_DIR = badDataDir;
    try {
      const response = await GET();
      expect(response.status).toBe(503);
      const body = (await response.json()) as { status: string; db: string; dataDir: string };
      expect(body.status).toBe('error');
      expect(body.db).toBe('ok');
      expect(body.dataDir).toBe('error');
    } finally {
      if (original === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = original;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
