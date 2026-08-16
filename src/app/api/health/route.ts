import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from '@/db/client';
import { readEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** Container healthcheck also verifies the data dir actually accepts writes (not just that it exists). */
function isDataDirWritable(): boolean {
  try {
    const dir = readEnv().dataDir;
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.health-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  // Unauthenticated by design: this is the container healthcheck.
  const time = () => new Date().toISOString();

  try {
    const row = getSqlite().prepare('select 1 as ok').get() as { ok: number };
    if (row.ok !== 1) throw new Error('unexpected result');
  } catch (error) {
    return Response.json(
      {
        status: 'error',
        db: 'error',
        dataDir: 'unknown',
        error: error instanceof Error ? error.message : 'unknown',
        time: time(),
      },
      { status: 503 },
    );
  }

  if (!isDataDirWritable()) {
    return Response.json(
      { status: 'error', db: 'ok', dataDir: 'error', error: 'data directory is not writable', time: time() },
      { status: 503 },
    );
  }

  return Response.json({ status: 'ok', db: 'ok', dataDir: 'ok', time: time() }, { status: 200 });
}
