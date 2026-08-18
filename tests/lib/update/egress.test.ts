import { describe, it, expect } from 'vitest';
import {
  GITHUB_API_ORIGIN,
  GITHUB_CHANGELOG_PATH,
  GITHUB_RELEASES_PATH,
  assertGithubUrl,
  assertWatchtowerUrl,
} from '@/lib/update/egress';

describe('MUST-8.4: assertGithubUrl requires all five conditions', () => {
  it('accepts exactly the two permitted URLs', () => {
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_RELEASES_PATH}`)).not.toThrow();
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_CHANGELOG_PATH}?ref=v1.4.0`)).not.toThrow();
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_CHANGELOG_PATH}?ref=v10.20.30`)).not.toThrow();
  });

  it('rejects a look-alike host, plain http, and userinfo', () => {
    for (const bad of [
      `https://api.github.com.evil.com${GITHUB_RELEASES_PATH}`,
      `http://api.github.com${GITHUB_RELEASES_PATH}`,
      `https://user@api.github.com${GITHUB_RELEASES_PATH}`,
      `https://user:pass@api.github.com${GITHUB_RELEASES_PATH}`,
      `https://api.github.com:8443${GITHUB_RELEASES_PATH}`,
      'not a url',
    ]) {
      expect(() => assertGithubUrl(bad), bad).toThrowError(/refusing a GitHub request/);
    }
  });

  it('rejects every path but the two exact literals — a prefix check would let these through', () => {
    for (const bad of [
      `${GITHUB_API_ORIGIN}/repos/VibeLogicCode/BudgetTracker/issues`,
      `${GITHUB_API_ORIGIN}/repos/VibeLogicCode/BudgetTracker/releases`,
      `${GITHUB_API_ORIGIN}/repos/VibeLogicCode/BudgetTracker/contents/README.md`,
      `${GITHUB_API_ORIGIN}${GITHUB_RELEASES_PATH}/`,
      `${GITHUB_API_ORIGIN}/repos/VibeLogicCode/BudgetTracker/../../users`,
    ]) {
      expect(() => assertGithubUrl(bad), bad).toThrowError(/refusing a GitHub request/);
    }
  });

  it('pins the query shape: empty for releases, exactly ?ref=v<semver> for the changelog', () => {
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_RELEASES_PATH}?per_page=1`)).toThrowError(/refusing/);
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_CHANGELOG_PATH}`)).toThrowError(/refusing/);
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_CHANGELOG_PATH}?ref=main`)).toThrowError(/refusing/);
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_CHANGELOG_PATH}?ref=v1.4.0&x=1`)).toThrowError(/refusing/);
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_CHANGELOG_PATH}?ref=v1.4`)).toThrowError(/refusing/);
  });

  it('rejects a fragment', () => {
    expect(() => assertGithubUrl(`${GITHUB_API_ORIGIN}${GITHUB_RELEASES_PATH}#x`)).toThrowError(/refusing/);
  });
});

describe('MUST-8.6: assertWatchtowerUrl makes "internal" enforceable', () => {
  it('accepts a bare compose service label, localhost and private IP literals', () => {
    for (const good of [
      'http://watchtower:8080/v1/update',
      'http://watchtower/v1/update',
      'https://watchtower:8080/v1/update',
      'http://localhost:8080/v1/update',
      'http://127.0.0.1:8080/v1/update',
      'http://10.1.2.3:8080/v1/update',
      'http://172.16.0.9:8080/v1/update',
      'http://192.168.1.9:8080/v1/update',
      'http://169.254.1.1:8080/v1/update',
      'http://[::1]:8080/v1/update',
      'http://[fd00::1]:8080/v1/update',
      'http://[fe80::1]:8080/v1/update',
    ]) {
      expect(() => assertWatchtowerUrl(good), good).not.toThrow();
    }
  });

  it('refuses every dotted name that is not a private IP literal', () => {
    for (const bad of [
      'http://evil.example.com/v1/update',
      'https://8.8.8.8/v1/update',
      'http://172.32.0.1/v1/update', // just outside 172.16.0.0/12
      'http://11.0.0.1/v1/update', //  just outside 10.0.0.0/8
      'http://[2606:4700::1]/v1/update',
    ]) {
      expect(() => assertWatchtowerUrl(bad), bad).toThrowError(/non-internal host/);
    }
  });

  it('refuses a wrong path, a query, a fragment, userinfo and a non-http scheme', () => {
    for (const bad of [
      'http://watchtower:8080/',
      'http://watchtower:8080/v1/update?x=1',
      'http://watchtower:8080/v1/update#x',
      'http://u:p@watchtower:8080/v1/update',
      'ftp://watchtower/v1/update',
      'file:///v1/update',
      'watchtower:8080/v1/update',
    ]) {
      expect(() => assertWatchtowerUrl(bad), bad).toThrowError(/refusing a Watchtower request/);
    }
  });
});
