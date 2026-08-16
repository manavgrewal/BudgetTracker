export interface AppEnv {
  secretKey: string;
  trustProxy: boolean;
  tz: string;
  port: number;
  dataDir: string;
}

export const DEFAULT_TZ = 'America/Toronto';
export const DEFAULT_PORT = 3000;
export const DEFAULT_DATA_DIR = '/data';
export const MIN_SECRET_KEY_BYTES = 32;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function readEnv(source: Partial<NodeJS.ProcessEnv> = process.env): AppEnv {
  const secretKey = source.SECRET_KEY ?? '';
  if (secretKey.length === 0) {
    throw new Error('SECRET_KEY is required (random string of at least 32 bytes)');
  }
  if (Buffer.byteLength(secretKey, 'utf8') < MIN_SECRET_KEY_BYTES) {
    throw new Error('SECRET_KEY must be at least 32 bytes');
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
    tz: source.TZ && source.TZ.length > 0 ? source.TZ : DEFAULT_TZ,
    port,
    dataDir: source.DATA_DIR && source.DATA_DIR.length > 0 ? source.DATA_DIR : DEFAULT_DATA_DIR,
  };
}
