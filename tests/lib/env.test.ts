import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readEnv,
  resetSecretKeyCacheForTests,
  DEFAULT_TZ,
  DEFAULT_PORT,
  DEFAULT_DATA_DIR,
  MIN_SECRET_KEY_BYTES,
  SECRET_KEY_FILENAME,
} from '@/lib/env';

const goodSecret = 'x'.repeat(MIN_SECRET_KEY_BYTES);

const tmpDirs: string[] = [];
function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-env-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetSecretKeyCacheForTests();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readEnv', () => {
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
      watchtowerUrl: null,
      watchtowerToken: null,
      ocrEngineOverride: null,
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

  it('takes the SECRET_KEY env var verbatim, including surrounding whitespace (unlike the key file, which is trimmed)', () => {
    const padded = `  ${goodSecret}  `;
    const env = readEnv({ SECRET_KEY: padded });
    expect(env.secretKey).toBe(padded);
  });
});

describe('readEnv — zero-config SECRET_KEY file resolution', () => {
  it('generates a key file when no SECRET_KEY is set and none exists yet', () => {
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);
    expect(fs.existsSync(keyPath)).toBe(false);

    const env = readEnv({ DATA_DIR: dataDir });

    expect(fs.existsSync(keyPath)).toBe(true);
    expect(Buffer.byteLength(env.secretKey, 'utf8')).toBeGreaterThanOrEqual(MIN_SECRET_KEY_BYTES);
    // 48 random bytes, base64-encoded.
    expect(env.secretKey).toBe(fs.readFileSync(keyPath, 'utf8').trim());
    expect(Buffer.from(env.secretKey, 'base64').length).toBe(48);
  });

  it('treats an empty-string SECRET_KEY (e.g. an unset compose ${VAR:-}) as not provided', () => {
    const dataDir = freshDataDir();
    const env = readEnv({ SECRET_KEY: '', DATA_DIR: dataDir });
    expect(fs.existsSync(path.join(dataDir, SECRET_KEY_FILENAME))).toBe(true);
    expect(env.secretKey.length).toBeGreaterThan(0);
  });

  it('writes the key file with mode 0600 (POSIX platforms only)', () => {
    if (process.platform === 'win32') return;
    const dataDir = freshDataDir();
    readEnv({ DATA_DIR: dataDir });
    const mode = fs.statSync(path.join(dataDir, SECRET_KEY_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('never leaves a partially-written temp file behind after generation', () => {
    const dataDir = freshDataDir();
    readEnv({ DATA_DIR: dataDir });
    const entries = fs.readdirSync(dataDir);
    expect(entries).toEqual([SECRET_KEY_FILENAME]);
  });

  it('reads back an existing valid key file instead of generating a new one', () => {
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);
    const existingKey = 'y'.repeat(64);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, `${existingKey}\n`); // trailing newline, as an editor might leave

    const env = readEnv({ DATA_DIR: dataDir });
    expect(env.secretKey).toBe(existingKey);
  });

  it('is idempotent: a second readEnv() call returns the same key without rewriting the file', () => {
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);

    const first = readEnv({ DATA_DIR: dataDir }).secretKey;
    const mtimeAfterFirst = fs.statSync(keyPath).mtimeMs;

    resetSecretKeyCacheForTests();
    const second = readEnv({ DATA_DIR: dataDir }).secretKey;
    const mtimeAfterSecond = fs.statSync(keyPath).mtimeMs;

    expect(second).toBe(first);
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst);
  });

  it('caches the resolved key across calls without re-reading the file from disk', () => {
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);

    const first = readEnv({ DATA_DIR: dataDir }).secretKey;
    // Mutate the file directly, WITHOUT resetting the cache — a real cache means readEnv()
    // must not notice, since it never touches disk again for this dataDir this process.
    fs.writeFileSync(keyPath, 'z'.repeat(64));
    const second = readEnv({ DATA_DIR: dataDir }).secretKey;

    expect(second).toBe(first);
  });

  it('hard-errors on a present-but-too-short key file, and does not regenerate it', () => {
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, 'too-short');

    expect(() => readEnv({ DATA_DIR: dataDir })).toThrowError(/shorter than 32 bytes/);
    // Never silently regenerated: the same bad content is still there afterwards.
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('too-short');
  });

  it('a too-short SECRET_KEY env var still hard-errors even when a valid key file exists', () => {
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, goodSecret);

    expect(() => readEnv({ SECRET_KEY: 'short', DATA_DIR: dataDir })).toThrowError(/at least 32 bytes/);
  });

  it('a valid SECRET_KEY env var always wins over an existing key file', () => {
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, 'y'.repeat(64));

    const env = readEnv({ SECRET_KEY: goodSecret, DATA_DIR: dataDir });
    expect(env.secretKey).toBe(goodSecret);
  });

  it('adopts the winning key instead of clobbering it when another process wins a first-boot generation race', () => {
    // Two processes can both find no key file (ENOENT) and both decide to generate. The
    // exclusive-create ('wx') write is what makes only one of them actually land on disk —
    // simulated here by having the very first writeFileSync call plant a DIFFERENT key (as a
    // concurrent winner would) and then fail with EEXIST, exactly as the real flag would.
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);
    const winnersKey = 'w'.repeat(64);
    const realWriteFileSync = fs.writeFileSync.bind(fs);

    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      realWriteFileSync(keyPath, winnersKey, { mode: 0o600 });
      const err = new Error('EEXIST: file already exists, open') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    });

    try {
      const env = readEnv({ DATA_DIR: dataDir });
      // The loser must adopt the winner's key from disk, NOT cache the value it tried (and
      // failed) to write — losing that distinction is how a TOTP secret becomes permanently
      // undecryptable.
      expect(env.secretKey).toBe(winnersKey);
      expect(spy).toHaveBeenCalledTimes(1);
      const attemptedValue = spy.mock.calls[0]?.[1];
      expect(attemptedValue).not.toBe(winnersKey);
      expect(fs.readFileSync(keyPath, 'utf8')).toBe(winnersKey);
    } finally {
      spy.mockRestore();
    }
  });

  it('hard-errors, and never adopts, when the EEXIST race winner planted an invalid (too-short) key', () => {
    // Same race as above, except the process that won the race planted garbage instead of a
    // real generated key. The loser must hard-error exactly like an ordinary too-short-file
    // read would — silently adopting it would violate the module's own never-silently-accept
    // rule just as badly as regenerating over it would.
    const dataDir = freshDataDir();
    const keyPath = path.join(dataDir, SECRET_KEY_FILENAME);
    const garbageWinner = 'too-short'; // 9 bytes, well under MIN_SECRET_KEY_BYTES
    const realWriteFileSync = fs.writeFileSync.bind(fs);

    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      realWriteFileSync(keyPath, garbageWinner, { mode: 0o600 });
      const err = new Error('EEXIST: file already exists, open') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    });

    try {
      expect(() => readEnv({ DATA_DIR: dataDir })).toThrowError(/shorter than 32 bytes/);
      // Never regenerated either: the garbage the "winner" planted is still there afterwards.
      expect(fs.readFileSync(keyPath, 'utf8')).toBe(garbageWinner);
    } finally {
      spy.mockRestore();
    }
  });

  it('rethrows a non-EEXIST error from the generation write instead of swallowing it', () => {
    const dataDir = freshDataDir();
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    });

    try {
      expect(() => readEnv({ DATA_DIR: dataDir })).toThrowError(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('MUST-7.2: the two optional Watchtower variables', () => {
  it('are null when absent and null when empty', () => {
    const base = { SECRET_KEY: 'x'.repeat(40), DATA_DIR: '/tmp/bt-env-test' };
    expect(readEnv(base).watchtowerUrl).toBeNull();
    expect(readEnv(base).watchtowerToken).toBeNull();
    expect(readEnv({ ...base, WATCHTOWER_URL: '', WATCHTOWER_TOKEN: '' }).watchtowerUrl).toBeNull();
    expect(readEnv({ ...base, WATCHTOWER_URL: '', WATCHTOWER_TOKEN: '' }).watchtowerToken).toBeNull();
  });

  it('are read and trimmed, and a malformed URL does NOT stop the app booting', () => {
    const base = { SECRET_KEY: 'x'.repeat(40), DATA_DIR: '/tmp/bt-env-test' };
    const env = readEnv({ ...base, WATCHTOWER_URL: '  http://watchtower:8080/v1/update ', WATCHTOWER_TOKEN: ' tok ' });
    expect(env.watchtowerUrl).toBe('http://watchtower:8080/v1/update');
    expect(env.watchtowerToken).toBe('tok');
    // MUST-8.7: validation happens at the point of use, not here.
    expect(() => readEnv({ ...base, WATCHTOWER_URL: 'not a url', WATCHTOWER_TOKEN: 'tok' })).not.toThrow();
  });
});

describe('OCR_ENGINE override (v1.5.0 defect fix)', () => {
  const base = { SECRET_KEY: 'x'.repeat(40), DATA_DIR: '/tmp/bt-env-test' };

  it('is null when absent or empty, unlike the Watchtower URL this is a hard error, not a defer', () => {
    expect(readEnv(base).ocrEngineOverride).toBeNull();
    expect(readEnv({ ...base, OCR_ENGINE: '' }).ocrEngineOverride).toBeNull();
  });

  it('accepts exactly "tesseract" or "onnx"', () => {
    expect(readEnv({ ...base, OCR_ENGINE: 'tesseract' }).ocrEngineOverride).toBe('tesseract');
    expect(readEnv({ ...base, OCR_ENGINE: 'onnx' }).ocrEngineOverride).toBe('onnx');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(readEnv({ ...base, OCR_ENGINE: '  onnx  ' }).ocrEngineOverride).toBe('onnx');
  });

  it('F6 defect fix: lower-cases before validating, matching TRUST_PROXY, so a differently-cased value still boots', () => {
    expect(readEnv({ ...base, OCR_ENGINE: 'ONNX' }).ocrEngineOverride).toBe('onnx');
    expect(readEnv({ ...base, OCR_ENGINE: 'Tesseract' }).ocrEngineOverride).toBe('tesseract');
    expect(readEnv({ ...base, OCR_ENGINE: '  OnNx  ' }).ocrEngineOverride).toBe('onnx');
  });

  it('is a hard startup error on anything else, matching SECRET_KEY, unlike the deferred Watchtower URL check above', () => {
    expect(() => readEnv({ ...base, OCR_ENGINE: 'tesseract-v2' })).toThrowError(/OCR_ENGINE/);
    expect(() => readEnv({ ...base, OCR_ENGINE: '0' })).toThrow();
  });
});
