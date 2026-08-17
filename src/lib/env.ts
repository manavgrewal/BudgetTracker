import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_TZ, readTz } from '@/lib/env-tz';

export interface AppEnv {
  secretKey: string;
  trustProxy: boolean;
  tz: string;
  port: number;
  dataDir: string;
}

// Re-exported so every existing importer of DEFAULT_TZ from '@/lib/env' keeps working
// unchanged — the actual constant lives in @/lib/env-tz (see that file's docblock for why).
export { DEFAULT_TZ };
export const DEFAULT_PORT = 3000;
export const DEFAULT_DATA_DIR = '/data';
export const MIN_SECRET_KEY_BYTES = 32;
/** Byte length used only when auto-generating a key — comfortably above MIN_SECRET_KEY_BYTES. */
export const GENERATED_SECRET_KEY_BYTES = 48;
export const SECRET_KEY_FILENAME = 'secret.key';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * readEnv() is called as a default-parameter expression all over the request path
 * (src/lib/auth/csrf.ts, src/lib/auth/ratelimit.ts, src/lib/auth/session.ts, ...), so once a
 * key has been read from — or generated onto — disk it is cached here for the life of the
 * process. Without this, zero-config installs would hit the filesystem (or worse, attempt to
 * generate a fresh key) on every single request. Keyed by resolved path, mirroring the
 * module-level singleton pattern src/db/client.ts uses for the database connection
 * (`instance` + `ensureInstance()` + a `setDbForTests` reset seam).
 */
let cachedKeyPath: string | null = null;
let cachedKeyValue: string | null = null;

/** Test seam, mirrors setDbForTests(): forces the next readEnv() call that falls through to
 *  the file-backed path to re-resolve from disk instead of reusing the cached value. */
export function resetSecretKeyCacheForTests(): void {
  cachedKeyPath = null;
  cachedKeyValue = null;
}

/**
 * Resolves SECRET_KEY when no env var is set: read `${dataDir}/secret.key` if present,
 * otherwise generate one. A present-but-invalid file is a hard error — it is NEVER silently
 * regenerated, since that would invalidate every enrolled two-factor device.
 */
function readOrGenerateSecretKeyFile(dataDir: string): string {
  const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);
  if (cachedKeyPath === keyPath && cachedKeyValue !== null) {
    return cachedKeyValue;
  }

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(keyPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let value: string;
  if (existing !== null) {
    value = existing.trim();
    if (Buffer.byteLength(value, 'utf8') < MIN_SECRET_KEY_BYTES) {
      throw new Error(
        `${keyPath} contains a key shorter than ${MIN_SECRET_KEY_BYTES} bytes. It will not be ` +
          'regenerated automatically — doing so would silently invalidate every enrolled ' +
          'two-factor device. Restore a valid key, or delete the file to generate a fresh one ' +
          '(only if you accept re-enrolling two-factor).',
      );
    }
  } else {
    const generated = crypto.randomBytes(GENERATED_SECRET_KEY_BYTES).toString('base64');
    fs.mkdirSync(dataDir, { recursive: true });
    // Exclusive create ('wx'): two processes racing to boot first (e.g. a Docker Compose
    // Swarm/replica start, or simply starting the container twice) must never let the second
    // writer clobber the first's key with renameSync's silent overwrite — the loser would then
    // cache a key that is no longer the one on disk, permanently undecryptable for every TOTP
    // secret it goes on to encrypt. 'wx' makes the OS refuse the write with EEXIST if the file
    // already exists, atomically, so exactly one process's key ever lands on disk; every other
    // racer just re-reads and adopts whatever won.
    try {
      fs.writeFileSync(keyPath, generated, { flag: 'wx', mode: 0o600 });
      value = generated;
      console.log(`[env] generated ${keyPath} — back this file up; losing it means re-enrolling two-factor devices`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      value = fs.readFileSync(keyPath, 'utf8').trim();
    }
  }

  cachedKeyPath = keyPath;
  cachedKeyValue = value;
  return value;
}

export function readEnv(source: Partial<NodeJS.ProcessEnv> = process.env): AppEnv {
  const dataDir = source.DATA_DIR && source.DATA_DIR.length > 0 ? source.DATA_DIR : DEFAULT_DATA_DIR;

  // An explicitly-set SECRET_KEY always wins, and a too-short one is a hard error with no
  // fallback to the file — misconfiguration must never be silently papered over. An empty/unset
  // env var (including the empty string a compose file's `${SECRET_KEY:-}` expands to when the
  // host variable is absent) is treated as "not provided" and falls through to the key file.
  const rawSecretKey = source.SECRET_KEY ?? '';
  let secretKey: string;
  if (rawSecretKey.length > 0) {
    if (Buffer.byteLength(rawSecretKey, 'utf8') < MIN_SECRET_KEY_BYTES) {
      throw new Error('SECRET_KEY must be at least 32 bytes');
    }
    secretKey = rawSecretKey;
  } else {
    secretKey = readOrGenerateSecretKeyFile(dataDir);
  }

  const rawPort = source.PORT;
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`PORT must be an integer between 1 and 65535, got "${rawPort}"`);
    }
    port = parsed;
  }

  return {
    secretKey,
    trustProxy: TRUTHY.has((source.TRUST_PROXY ?? '').trim().toLowerCase()),
    tz: readTz(source),
    port,
    dataDir,
  };
}
