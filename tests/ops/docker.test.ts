import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), name), 'utf8');

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');

  it('uses the glibc bookworm-slim base in every stage', () => {
    const froms = dockerfile.match(/^FROM .+$/gm) ?? [];
    expect(froms.length).toBeGreaterThanOrEqual(3);
    for (const line of froms) {
      expect(line).toContain('node:22-bookworm-slim');
    }
    expect(dockerfile).not.toContain('alpine');
  });

  it('ships the Next standalone output', () => {
    expect(dockerfile).toContain('.next/standalone');
    expect(dockerfile).toContain('.next/static');
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
  });

  it('copies the native modules explicitly (output tracing misses .node binaries)', () => {
    expect(dockerfile).toContain('node_modules/better-sqlite3');
    expect(dockerfile).toContain('node_modules/argon2');
  });

  it('copies the drizzle migrations, which are read from the working directory at boot', () => {
    expect(dockerfile).toMatch(/COPY .*\/app\/drizzle \.\/drizzle/);
  });

  it('copies CHANGELOG.md, which Settings → About reads from the working directory', () => {
    // Without this the About panel silently degrades to "no changelog available" in the
    // container only — the exact class of bug that never shows up in dev.
    expect(dockerfile).toMatch(/COPY .*\/app\/CHANGELOG\.md \.\/CHANGELOG\.md/);
  });

  it('runs as a non-root user and declares the data volume', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('VOLUME ["/data"]');
  });

  it('has a healthcheck that hits /api/health', () => {
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/api/health');
  });

  it('binds to all interfaces via HOSTNAME=0.0.0.0 (the unreachable-container classic)', () => {
    expect(dockerfile).toContain('HOSTNAME=0.0.0.0');
  });

  it('healthchecks with node -e, not curl/wget (absent from bookworm-slim)', () => {
    const healthcheckLine = dockerfile.slice(dockerfile.indexOf('HEALTHCHECK'));
    expect(healthcheckLine).toContain('node -e');
    expect(healthcheckLine).not.toContain('curl');
    expect(healthcheckLine).not.toContain('wget');
  });

  it('keeps the compiler toolchain out of the runtime stage', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).not.toContain('g++');
    expect(runtimeStage).not.toContain('build-essential');
  });

  it('copies the OCR and PDF assets that output tracing cannot see (R1)', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).toMatch(/COPY .*\/app\/vendor \.\/vendor/);
    expect(runtimeStage).toContain('node_modules/tesseract.js ');
    expect(runtimeStage).toContain('node_modules/tesseract.js-core');
    expect(runtimeStage).toContain('node_modules/pdfjs-dist');
  });

  it('creates /data/receipts alongside the other data directories', () => {
    expect(dockerfile).toMatch(/mkdir -p \/data \/data\/backups \/data\/tmp \/data\/receipts/);
  });

  it('fails the BUILD, not production, when an asset is missing (MUST-7.9 / acceptance A3)', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).toContain('RUN node scripts/check-ocr-assets.mjs');
    // The guard must run AFTER the COPY lines it checks, or it proves nothing.
    expect(runtimeStage.indexOf('RUN node scripts/check-ocr-assets.mjs')).toBeGreaterThan(
      runtimeStage.indexOf('node_modules/tesseract.js-core'),
    );
  });

  it('MUST-17.2 / MUST-17.3: the check directive is a parser directive at the top of the file', () => {
    const firstTwo = dockerfile.split('\n').slice(0, 2).map((line) => line.trim());
    expect(firstTwo[0]).toBe('# syntax=docker/dockerfile:1');
    expect(firstTwo[1]).toBe('# check=skip=SecretsUsedInArgOrEnv');
  });

  it('MUST-17.3: the skip can never quietly start excusing a real secret in the shipped layer', () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtime).not.toMatch(/^ENV SECRET_KEY=/m);
    // ...and the one ENV it does excuse is still the fixed build-stage placeholder.
    expect(dockerfile).toContain('ENV SECRET_KEY=build-time-placeholder-secret-key-0123456789');
    expect(dockerfile).toMatch(/build-stage-only string, not a credential/);
  });
});

describe('.dockerignore', () => {
  const dockerignore = read('.dockerignore');

  it('does NOT exclude vendor/, which carries the offline OCR language data (MUST-7.9)', () => {
    const lines = dockerignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).not.toContain('vendor');
    expect(lines).not.toContain('vendor/');
    expect(lines).not.toContain('/vendor');
  });
});

describe('version and changelog', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string; dependencies: Record<string, string> };
  const changelog = read('CHANGELOG.md');

  it('keeps package.json and the newest changelog section on the same version', () => {
    const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
    expect(newest, 'CHANGELOG.md has no dated version section').toBeTruthy();
    expect(pkg.version).toBe(newest![1]);
  });

  it('declares the three new runtime dependencies (§17.27)', () => {
    for (const name of ['tesseract.js', 'pdfjs-dist', 'tar']) {
      expect(pkg.dependencies[name], `missing dependency ${name}`).toBeTruthy();
    }
  });

  it('has a dated 1.2.3 section and a fresh empty Unreleased above it', () => {
    expect(changelog).toContain('## [1.2.3] - 2026-08-17');
    expect(changelog).toContain('## [1.2.2] - 2026-08-17');
    expect(changelog).toContain('## [1.2.1] - 2026-08-17');
    expect(changelog).toContain('## [1.2.0] - 2026-08-17');
    const unreleased = changelog.indexOf('## Unreleased');
    const released123 = changelog.indexOf('## [1.2.3]');
    const released122 = changelog.indexOf('## [1.2.2]');
    const released121 = changelog.indexOf('## [1.2.1]');
    const released120 = changelog.indexOf('## [1.2.0]');
    expect(unreleased).toBeGreaterThan(-1);
    expect(unreleased).toBeLessThan(released123);
    expect(released123).toBeLessThan(released122);
    expect(released122).toBeLessThan(released121);
    expect(released121).toBeLessThan(released120);
    // Unreleased must be empty going into 1.2.3 — nothing this session wrote should still be
    // sitting above the new dated section.
    expect(changelog.slice(unreleased, released123)).not.toContain('Watchtower auto-update');
    // The previously-unreleased 1.2.2 entry was ABSORBED into its own dated section, not left
    // sitting in Unreleased — same invariant carried forward for each prior release in turn.
    expect(changelog.slice(unreleased, released123)).not.toContain('Contract and loan item kinds');
    expect(changelog.slice(unreleased, released123)).not.toContain('Prebuilt multi-arch images');
    // §17.23's original absorption invariant, restored alongside each release added since: whatever
    // was absorbed into 1.2.0 at THAT release must not still be sitting in Unreleased either.
    expect(changelog.slice(unreleased, released120)).not.toContain('Forced password change');
  });

  it('records the backup format change in 1.1.0', () => {
    const section = changelog.slice(changelog.indexOf('## [1.1.0]'), changelog.indexOf('## [1.0.0]'));
    expect(section).toContain('tar.gz');
    expect(section).toMatch(/older `?\.db`? backups still restore|still restore/i);
    expect(section).toContain('Warranty');
  });
});

describe('docker-compose.yml', () => {
  const compose = read('docker-compose.yml');

  it('mounts /data and keeps the root filesystem read-only', () => {
    expect(compose).toContain('/data');
    expect(compose).toMatch(/read_only:\s*true/);
  });

  it('mounts a tmpfs at /tmp because the Node runtime needs a tmpdir', () => {
    expect(compose).toContain('tmpfs:');
    expect(compose).toContain('/tmp');
  });

  it('drops all capabilities and forbids privilege escalation', () => {
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('no-new-privileges:true');
  });

  it('does not require SECRET_KEY — it is optional, zero-config by default', () => {
    expect(compose).not.toMatch(/SECRET_KEY:\s*\$\{SECRET_KEY:\?/);
    expect(compose).toMatch(/SECRET_KEY:\s*\$\{SECRET_KEY:-\}/);
  });

  it('defines a healthcheck', () => {
    expect(compose).toContain('healthcheck:');
    expect(compose).toContain('/api/health');
  });

  it('healthchecks with node -e, not curl/wget (absent from bookworm-slim)', () => {
    const healthcheckBlock = compose.slice(compose.indexOf('healthcheck:'));
    expect(healthcheckBlock).toContain('node');
    expect(healthcheckBlock).not.toContain('curl');
    expect(healthcheckBlock).not.toContain('wget');
  });
});

describe('README.md', () => {
  const readme = read('README.md');

  it('documents both install paths, with PC-build first', () => {
    expect(readme).toContain('docker save');
    expect(readme).toContain('docker load');
    expect(readme.indexOf('docker save')).toBeLessThan(readme.indexOf('Building on the NAS'));
  });

  it('documents SECRET_KEY generation and the loss consequence', () => {
    expect(readme).toContain('randomBytes');
    expect(readme).toMatch(/re-?enroll/i);
  });

  it('documents the restore procedure including the -wal and -shm files', () => {
    expect(readme).toContain('-wal');
    expect(readme).toContain('-shm');
  });

  it('recommends HTTPS and states the plain-HTTP caveat honestly', () => {
    expect(readme).toContain('Tailscale');
    expect(readme).toMatch(/reverse proxy/i);
    expect(readme).toMatch(/WPA2|wifi password|Wi-Fi password/i);
  });

  it('mentions the TRUST_PROXY switch', () => {
    expect(readme).toContain('TRUST_PROXY');
  });

  it('documents the warranty tracker and its offline OCR', () => {
    expect(readme).toMatch(/warrant/i);
    expect(readme).toMatch(/OCR/);
    expect(readme).toMatch(/offline|no internet|LAN-only/i);
  });
});
