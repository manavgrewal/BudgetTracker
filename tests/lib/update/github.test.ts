import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_CHANGELOG_BYTES,
  MAX_CHANGELOG_GROUPS,
  MAX_CHANGELOG_ITEMS,
  UNPARSEABLE_TAG_ERROR,
  UpdateCheckError,
  boundRelease,
  fetchLatestRelease,
  fetchRemoteChangelog,
} from '@/lib/update/github';
import { parseChangelog } from '@/lib/changelog';
import { APP_VERSION } from '@/lib/version';

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  // MUST-19.1: no test in this file may reach a real network. Restoring the real fetch in
  // an afterEach is what stops a later test in the same file from doing so by accident.
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('MUST-4.2 / MUST-4.3 / MUST-4.4: the release request, exactly', () => {
  it('is one GET to the pinned endpoint with the three fixed headers and no Authorization', async () => {
    stub(() => json({ tag_name: 'v1.4.0', published_at: '2026-08-16T09:00:00Z' }));
    const release = await fetchLatestRelease();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/VibeLogicCode/BudgetTracker/releases/latest');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toEqual({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `BudgetTracker/${APP_VERSION}`,
    });
    expect(Object.keys(headers)).not.toContain('Authorization');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(release).toEqual({ tag: 'v1.4.0', version: '1.4.0', publishedAt: '2026-08-16T09:00:00Z' });
  });

  it('MUST-4.6: a tag that fails parseSemver is a PERMANENT error and is never classified', async () => {
    stub(() => json({ tag_name: 'nightly', published_at: null }));
    await expect(fetchLatestRelease()).rejects.toMatchObject({ message: UNPARSEABLE_TAG_ERROR, permanent: true });
  });

  it('MUST-4.10: a pre-release tag is refused outright', async () => {
    stub(() => json({ tag_name: 'v2.0.0-rc.1' }));
    await expect(fetchLatestRelease()).rejects.toMatchObject({ permanent: true });
  });

  it('tolerates a missing published_at', async () => {
    stub(() => json({ tag_name: '1.4.0' }));
    await expect(fetchLatestRelease()).resolves.toEqual({ tag: '1.4.0', version: '1.4.0', publishedAt: null });
  });
});

describe('MUST-4.7: error classification', () => {
  it.each([401, 403, 404, 422])('treats HTTP %i as permanent', async (status) => {
    stub(() => new Response('', { status }));
    const error = await fetchLatestRelease().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateCheckError);
    expect((error as UpdateCheckError).permanent).toBe(true);
  });

  it.each([429, 500, 502, 503])('treats HTTP %i as transient', async (status) => {
    stub(() => new Response('', { status }));
    const error = await fetchLatestRelease().catch((e: unknown) => e);
    expect((error as UpdateCheckError).permanent).toBe(false);
  });

  it('treats a DNS failure, a connect timeout and an abort as transient', async () => {
    stub(() => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    });
    const error = await fetchLatestRelease().catch((e: unknown) => e);
    expect((error as UpdateCheckError).permanent).toBe(false);
  });

  it('treats a malformed payload as permanent', async () => {
    stub(() => new Response('not json', { status: 200 }));
    const error = await fetchLatestRelease().catch((e: unknown) => e);
    expect((error as UpdateCheckError).permanent).toBe(true);
  });
});

describe('MUST-4.2 endpoint 2 / MUST-4.6: the changelog read is pinned to the release tag', () => {
  function contents(text: string, over: Record<string, unknown> = {}): Response {
    const content = Buffer.from(text, 'utf8').toString('base64');
    return json({ encoding: 'base64', size: Buffer.byteLength(text, 'utf8'), content, ...over });
  }

  it('requests ?ref=v<version> and decodes base64', async () => {
    stub(() => contents('# Changelog\n\n## [1.4.0] - 2026-08-16\n\n### Added\n\n- A thing.\n'));
    const text = await fetchRemoteChangelog('1.4.0');
    expect(calls[0]!.url).toBe(
      'https://api.github.com/repos/VibeLogicCode/BudgetTracker/contents/CHANGELOG.md?ref=v1.4.0',
    );
    expect(text).toContain('## [1.4.0] - 2026-08-16');
  });

  it('refuses a non-base64 encoding and an oversized file', async () => {
    stub(() => contents('x', { encoding: 'utf-8' }));
    await expect(fetchRemoteChangelog('1.4.0')).rejects.toMatchObject({ permanent: true });

    stub(() => contents('x', { size: MAX_CHANGELOG_BYTES + 1 }));
    await expect(fetchRemoteChangelog('1.4.0')).rejects.toMatchObject({ permanent: true });
  });

  it('refuses a version string that is not a bare semver, before any fetch', async () => {
    stub(() => contents('x'));
    await expect(fetchRemoteChangelog('main')).rejects.toMatchObject({ permanent: true });
    expect(calls).toHaveLength(0);
  });
});

describe('MUST-4.8: the remote changelog is untrusted text and is bounded', () => {
  it('truncates a 400-item release to 200 items across at most 12 groups', () => {
    const groups = Array.from({ length: 20 }, (_, g) => {
      const items = Array.from({ length: 20 }, (_, i) => `- item ${g}-${i} ${'x'.repeat(600)}`).join('\n');
      return `### Group ${'G'.repeat(80)}${g}\n\n${items}`;
    }).join('\n\n');
    const parsed = parseChangelog(`## [1.4.0] - 2026-08-16\n\n${groups}\n`);
    const bounded = boundRelease(parsed[0]!);

    expect(bounded.groups.length).toBeLessThanOrEqual(MAX_CHANGELOG_GROUPS);
    const total = bounded.groups.reduce((n, group) => n + group.items.length, 0);
    expect(total).toBe(MAX_CHANGELOG_ITEMS);
    for (const group of bounded.groups) {
      expect(group.title.length).toBeLessThanOrEqual(60);
      for (const item of group.items) expect(item.length).toBeLessThanOrEqual(500);
    }
  });
});
