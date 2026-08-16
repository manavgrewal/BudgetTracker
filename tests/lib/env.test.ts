import { describe, it, expect } from 'vitest';
import { readEnv, DEFAULT_TZ, DEFAULT_PORT, DEFAULT_DATA_DIR, MIN_SECRET_KEY_BYTES } from '@/lib/env';

const goodSecret = 'x'.repeat(MIN_SECRET_KEY_BYTES);

describe('readEnv', () => {
  it('requires SECRET_KEY', () => {
    expect(() => readEnv({})).toThrowError(/SECRET_KEY/);
  });

  it('rejects a SECRET_KEY shorter than 32 bytes', () => {
    expect(() => readEnv({ SECRET_KEY: 'short' })).toThrowError(/at least 32 bytes/);
  });

  it('counts bytes, not characters, for the SECRET_KEY length check', () => {
    // 16 x 3-byte characters = 48 bytes but only 16 code points.
    const multibyte = '中'.repeat(16);
    expect(multibyte.length).toBe(16);
    expect(readEnv({ SECRET_KEY: multibyte }).secretKey).toBe(multibyte);
  });

  it('applies defaults for everything optional', () => {
    const env = readEnv({ SECRET_KEY: goodSecret });
    expect(env).toEqual({
      secretKey: goodSecret,
      trustProxy: false,
      tz: DEFAULT_TZ,
      port: DEFAULT_PORT,
      dataDir: DEFAULT_DATA_DIR,
    });
  });

  it('parses TRUST_PROXY truthy values case-insensitively', () => {
    expect(readEnv({ SECRET_KEY: goodSecret, TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(readEnv({ SECRET_KEY: goodSecret, TRUST_PROXY: 'TRUE' }).trustProxy).toBe(true);
    expect(readEnv({ SECRET_KEY: goodSecret, TRUST_PROXY: 'yes' }).trustProxy).toBe(true);
    expect(readEnv({ SECRET_KEY: goodSecret, TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(readEnv({ SECRET_KEY: goodSecret, TRUST_PROXY: '' }).trustProxy).toBe(false);
  });

  it('parses PORT and rejects nonsense', () => {
    expect(readEnv({ SECRET_KEY: goodSecret, PORT: '8080' }).port).toBe(8080);
    expect(() => readEnv({ SECRET_KEY: goodSecret, PORT: 'abc' })).toThrowError(/PORT/);
  });

  it('honours TZ and DATA_DIR overrides', () => {
    const env = readEnv({ SECRET_KEY: goodSecret, TZ: 'UTC', DATA_DIR: '/srv/data' });
    expect(env.tz).toBe('UTC');
    expect(env.dataDir).toBe('/srv/data');
  });
});
