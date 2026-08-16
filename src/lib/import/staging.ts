import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readEnv } from '@/lib/env';

export class StagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function stagingDir(): string {
  return path.join(readEnv().dataDir, 'tmp');
}

export function stagedFilePath(stagingId: string): string {
  // Path-traversal guard: only a UUID may ever reach path.join.
  if (!UUID_RE.test(stagingId)) throw new StagingError('Invalid staging id');
  return path.join(stagingDir(), `${stagingId}.csv`);
}

export function writeStagedFile(buf: Buffer): string {
  const dir = stagingDir();
  fs.mkdirSync(dir, { recursive: true });
  const stagingId = randomUUID();
  fs.writeFileSync(path.join(dir, `${stagingId}.csv`), buf);
  return stagingId;
}

export function readStagedFile(stagingId: string): Buffer {
  const file = stagedFilePath(stagingId);
  if (!fs.existsSync(file)) throw new StagingError('Staged upload not found or expired');
  return fs.readFileSync(file);
}

export function deleteStagedFile(stagingId: string): void {
  const file = stagedFilePath(stagingId);
  fs.rmSync(file, { force: true });
}

export function purgeStagedFiles(olderThanMs: number = DEFAULT_TTL_MS, now: Date = new Date()): number {
  const dir = stagingDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry);
    const stats = fs.statSync(file);
    if (now.getTime() - stats.mtimeMs > olderThanMs) {
      fs.rmSync(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}
