/**
 * Semver parsing and classification (spec §4.3). PURE (MUST-2.1): no @/db import, no
 * @/lib/env import, no node builtin, no import of any kind.
 *
 * This module is imported by src/app/(app)/settings/updates-client.tsx to render the
 * severity badge, so the Ruling P4 client-bundle constraint applies here exactly as it does
 * to src/lib/warranty/constants.ts and src/lib/notify/events.ts: importing @/db here fails
 * the client webpack build outright.
 *
 * MUST-4.11: severity is computed HERE, in the app, from two version strings. It is never
 * read from the release payload. GitHub has no concept of "is this breaking for you": the
 * release title, the label set and the body are all free text a maintainer can get wrong.
 */
export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export type UpdateSeverity = 'none' | 'patch' | 'minor' | 'major';

/**
 * MUST-4.10: STRICT. One optional leading "v", then exactly three dot-separated runs of
 * digits. No pre-release, no build metadata, no leading zeros beyond a bare "0", no
 * surrounding whitespace.
 *
 * The strictness is the point. The repository has never published a pre-release, and a
 * version this classifier cannot reason about must never reach an auto-apply decision: a
 * rejected tag becomes a permanent check error (MUST-4.6) and is surfaced on the card
 * rather than guessed at.
 */
const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(value: string): Semver | null {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * MUST-4.9: total, and defined by exactly these four lines, in this order. The ordering is
 * load-bearing: a 1.9.9 -> 2.0.0 move is a MAJOR even though its minor and patch both go
 * down, and checking `remote.major > current.major` before the minor comparison is what
 * makes that true.
 */
export function classify(current: Semver, remote: Semver): UpdateSeverity {
  if (compareSemver(remote, current) <= 0) return 'none';
  if (remote.major > current.major) return 'major';
  if (remote.minor > current.minor) return 'minor';
  return 'patch';
}

/** MUST-4.2: re-serialised from the parsed integers, never passed through from a payload. */
export function formatSemver(value: Semver): string {
  return `${value.major}.${value.minor}.${value.patch}`;
}
