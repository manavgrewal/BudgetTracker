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

  it('requires SECRET_KEY rather than defaulting it', () => {
    expect(compose).toMatch(/SECRET_KEY:\s*\$\{SECRET_KEY:\?/);
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
});
