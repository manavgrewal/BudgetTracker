import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Vitest transpiles TSX itself; tsconfig says "preserve" for Next, so force automatic here.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': path.resolve(rootDir, 'src') },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
    // better-sqlite3 is a native addon: forks (not worker threads) keep it stable.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    env: {
      SECRET_KEY: 'test-secret-key-0123456789-abcdefghijklmnop',
      TZ: 'America/Toronto',
      DATA_DIR: path.resolve(rootDir, '.tmp-data'),
    },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
