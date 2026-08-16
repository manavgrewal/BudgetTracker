import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from '@/db/client';
import { readEnv } from '@/lib/env';
import { APP_VERSION } from '@/lib/version';

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

  // `version` is on the error responses too: "which build is the one that is broken?" is
  // exactly the question being asked when this endpoint returns 503, and it leaks nothing
  // the footer of every page does not already show to anyone who can reach the app.

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
        version: APP_VERSION,
        time: time(),
      },
      { status: 503 },
    );
  }

  if (!isDataDirWritable()) {
    return Response.json(
      {
        status: 'error',
        db: 'ok',
        dataDir: 'error',
        error: 'data directory is not writable',
        version: APP_VERSION,
        time: time(),
      },
      { status: 503 },
    );
  }

  return Response.json({ status: 'ok', db: 'ok', dataDir: 'ok', version: APP_VERSION, time: time() }, { status: 200 });
}
