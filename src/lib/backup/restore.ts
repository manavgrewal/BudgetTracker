/**
 * The app side of GUI restore-on-next-start (spec §20). This is the ONLY file under src/
 * allowed to import from scripts/ (MUST-20.5, pinned by tests/ops/restore-seams.test.ts) —
 * its whole job is to supply restore-core.ts's parameterised functions with the three
 * values only the app knows (readEnv().dataDir, a scratch path, migrationsFolder() from
 * @/db/client) and to own the on-disk state machine of §20.6.
 *
 * Importing @/db/client for migrationsFolder() does NOT open a database: src/db/client.ts
 * builds its singleton lazily inside ensureInstance(), so the import is inert
 * (tests/ops/restore-seams.test.ts pins that too).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { migrationsFolder } from '@/db/client';
import { readEnv } from '@/lib/env';
import { APP_VERSION } from '@/lib/version';
import { ARCHIVE_NAME_RE, LEGACY_NAME_RE, backupsDir, resolveSafeTarget } from '@/lib/backup/archive';
import {
  RestoreError,
  commitRestore,
  prepareRestore,
  sha256File,
  validateArtifact,
  type RestorePlan,
  type RestoreResult,
} from '../../../scripts/restore-core.ts';

export const RESTART_DELAY_MS = 1500;
/** EX_TEMPFAIL. Non-zero so an `on-failure` restart policy also brings the container back;
 *  `always` / `unless-stopped` (what docker-compose.yml ships) restart on any exit code. */
export const RESTART_EXIT_CODE = 75;
/** MUST-20.19/20.23: forward completion is capped, not retried forever. */
export const MAX_COMMIT_ATTEMPTS = 3;
/** MUST-20.33: thirty days, with the most recent of each kind always kept regardless of age. */
export const PRE_RESTORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface RestoreRequest {
  version: 1;
  payload: string;
  sourceName: string;
  kind: 'archive' | 'sqlite';
  bytes: number;
  sha256: string;
  appliedMigrations: number;
  requestedByUserId: number;
  requestedByUsername: string;
  requestedAt: string;
  appVersion: string;
}

export interface RestoreOutcome {
  version: 1;
  status: 'success' | 'failed';
  sourceName: string;
  kind: 'archive' | 'sqlite';
  requestedByUserId: number;
  requestedByUsername: string;
  requestedAt: string;
  finishedAt: string;
  safetyCopy: string | null;
  receiptsMovedAside: string | null;
  receiptsRestored: number;
  missingReceiptRows: number;
  receiptsTouched: number;
  error: string | null;
}

const requestSchema = z.object({
  version: z.literal(1),
  payload: z.literal('payload'),
  sourceName: z.string().min(1).max(120),
  kind: z.enum(['archive', 'sqlite']),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  appliedMigrations: z.number().int().nonnegative(),
  requestedByUserId: z.number().int().positive(),
  requestedByUsername: z.string().min(1).max(120),
  requestedAt: z.string().min(1),
  appVersion: z.string().min(1),
});

const outcomeSchema = z.object({
  version: z.literal(1),
  status: z.enum(['success', 'failed']),
  sourceName: z.string(),
  kind: z.enum(['archive', 'sqlite']),
  requestedByUserId: z.number(),
  requestedByUsername: z.string(),
  requestedAt: z.string(),
  finishedAt: z.string(),
  safetyCopy: z.string().nullable(),
  receiptsMovedAside: z.string().nullable(),
  receiptsRestored: z.number(),
  missingReceiptRows: z.number(),
  receiptsTouched: z.number(),
  error: z.string().nullable(),
});

export function stagedDir(): string {
  return path.join(readEnv().dataDir, 'restore-staged');
}

export function applyingDir(): string {
  return path.join(readEnv().dataDir, 'restore-applying');
}

export function resultPath(): string {
  return path.join(readEnv().dataDir, 'restore-result.json');
}

function markerPathOf(dir: string): string {
  return path.join(dir, 'restore-request.json');
}

function payloadPathOf(dir: string): string {
  return path.join(dir, 'payload');
}

function commitJsonPathOf(dir: string): string {
  return path.join(dir, 'commit.json');
}

/** MUST-20.13: a half-written file must never be readable. */
function writeJsonAtomically(target: string, value: unknown): void {
  const partial = `${target}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(partial, target);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A best-effort, non-throwing read used only to populate a FAILED outcome's descriptive
 * fields when the marker itself may be the thing that is broken. Never used to decide
 * whether a restore may proceed — requestSchema (via readMarkerStrict) is the only gate
 * for that.
 */
function readMarkerLoose(markerPath: string): Pick<
  RestoreRequest,
  'sourceName' | 'kind' | 'requestedByUserId' | 'requestedByUsername' | 'requestedAt'
> {
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    return {
      sourceName: typeof raw.sourceName === 'string' ? raw.sourceName : 'unknown',
      kind: raw.kind === 'sqlite' ? 'sqlite' : 'archive',
      requestedByUserId: typeof raw.requestedByUserId === 'number' ? raw.requestedByUserId : 0,
      requestedByUsername: typeof raw.requestedByUsername === 'string' ? raw.requestedByUsername : 'unknown',
      requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : new Date(0).toISOString(),
    };
  } catch {
    return {
      sourceName: 'unknown',
      kind: 'archive',
      requestedByUserId: 0,
      requestedByUsername: 'unknown',
      requestedAt: new Date(0).toISOString(),
    };
  }
}

function readMarkerStrict(markerPath: string): RestoreRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    throw new RestoreError('The staged restore marker is unreadable. Nothing was changed.');
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RestoreError('The staged restore marker failed validation. Nothing was changed.');
  }
  return parsed.data;
}

type MarkerFields = Pick<
  RestoreRequest,
  'sourceName' | 'kind' | 'requestedByUserId' | 'requestedByUsername' | 'requestedAt'
>;

function baseOutcomeFields(marker: MarkerFields, now: Date) {
  return {
    version: 1 as const,
    sourceName: marker.sourceName,
    kind: marker.kind,
    requestedByUserId: marker.requestedByUserId,
    requestedByUsername: marker.requestedByUsername,
    requestedAt: marker.requestedAt,
    finishedAt: now.toISOString(),
  };
}

function successOutcome(marker: MarkerFields, plan: RestorePlan, result: RestoreResult, now: Date): RestoreOutcome {
  return {
    ...baseOutcomeFields(marker, now),
    status: 'success',
    safetyCopy: plan.safetyCopy,
    receiptsMovedAside: plan.receiptsMovedAside,
    receiptsRestored: result.receiptsRestored,
    missingReceiptRows: result.missingReceiptRows,
    receiptsTouched: result.receiptsTouched,
    error: null,
  };
}

/**
 * MUST-20.12 / MUST-20.25: on a validation-type failure nothing happened, so every
 * mutation-bearing field is null/0. On the exhausted-retries path SOME steps may have
 * completed — `plan` carries whatever safety copies were actually made, and those are named
 * here (and in the recovery text) rather than being reported as if nothing had happened.
 */
function failedOutcome(marker: MarkerFields, error: string, now: Date, plan: RestorePlan | null = null): RestoreOutcome {
  return {
    ...baseOutcomeFields(marker, now),
    status: 'failed',
    safetyCopy: plan?.safetyCopy ?? null,
    receiptsMovedAside: plan?.receiptsMovedAside ?? null,
    receiptsRestored: 0,
    missingReceiptRows: 0,
    receiptsTouched: 0,
    error,
  };
}

function writeOutcome(outcome: RestoreOutcome): void {
  writeJsonAtomically(resultPath(), outcome);
  if (outcome.status === 'success') {
    console.log(`[restore] applied ${outcome.sourceName} (${outcome.kind}) requested by user ${outcome.requestedByUserId}`);
  } else {
    console.error(`[restore] FAILED ${outcome.sourceName}: ${outcome.error}`);
  }
}

export function readRestoreState(): { staged: RestoreRequest | null; result: RestoreOutcome | null } {
  let staged: RestoreRequest | null = null;
  try {
    const markerPath = markerPathOf(stagedDir());
    if (fs.existsSync(markerPath)) {
      const parsed = requestSchema.safeParse(JSON.parse(fs.readFileSync(markerPath, 'utf8')));
      if (parsed.success) staged = parsed.data;
    }
  } catch {
    staged = null;
  }

  let result: RestoreOutcome | null = null;
  try {
    const file = resultPath();
    if (fs.existsSync(file)) {
      const parsed = outcomeSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed.success) result = parsed.data;
    }
  } catch {
    result = null;
  }

  return { staged, result };
}

function resolveBackupPath(backupName: string): string {
  const dir = backupsDir();
  if (ARCHIVE_NAME_RE.test(backupName)) return resolveSafeTarget(dir, backupName, ARCHIVE_NAME_RE);
  if (LEGACY_NAME_RE.test(backupName)) return resolveSafeTarget(dir, backupName, LEGACY_NAME_RE);
  // MUST-20.2: the only artifacts restorable through the GUI are files already present in
  // ${DATA_DIR}/backups whose names match one of the two listed shapes.
  throw new RestoreError(`Refusing unsafe backup filename: ${backupName}`);
}

/**
 * MUST-20.9/20.10/20.14: validate the artifact, build tmp/<uuid>-restore/ (payload
 * hard-linked from backups/, marker written atomically), then commit it with a single
 * rename to restore-staged/ — one atomic filesystem operation is the commit point, so
 * restore-staged/ either does not exist or exists complete.
 */
export function stageRestore(args: {
  backupName: string;
  userId: number;
  username: string;
  now?: Date;
}): RestoreRequest {
  const now = args.now ?? new Date();
  const dataDir = readEnv().dataDir;

  if (fs.existsSync(stagedDir()) || fs.existsSync(applyingDir())) {
    throw new RestoreError('A restore is already staged; restart the app to apply it.');
  }

  const backupPath = resolveBackupPath(args.backupName);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(backupPath);
  } catch {
    throw new RestoreError(`No such backup: ${args.backupName}`);
  }
  if (!stats.isFile()) throw new RestoreError(`No such backup: ${args.backupName}`);

  const validateScratch = path.join(dataDir, 'tmp', `${randomUUID()}-restore`);
  let report;
  try {
    report = validateArtifact(backupPath, { scratchDir: validateScratch, migrationsFolder: migrationsFolder() });
  } finally {
    fs.rmSync(validateScratch, { recursive: true, force: true });
  }

  const stagingPath = path.join(dataDir, 'tmp', `${randomUUID()}-restore`);
  fs.mkdirSync(stagingPath, { recursive: true });
  try {
    const payloadPath = payloadPathOf(stagingPath);
    try {
      fs.linkSync(backupPath, payloadPath);
    } catch {
      fs.copyFileSync(backupPath, payloadPath);
    }

    const request: RestoreRequest = {
      version: 1,
      payload: 'payload',
      sourceName: args.backupName,
      kind: report.kind,
      bytes: report.bytes,
      sha256: report.sha256,
      appliedMigrations: report.appliedMigrations,
      requestedByUserId: args.userId,
      requestedByUsername: args.username,
      requestedAt: now.toISOString(),
      appVersion: APP_VERSION,
    };
    writeJsonAtomically(markerPathOf(stagingPath), request);

    // MUST-20.9: one rename is the whole commit point.
    fs.renameSync(stagingPath, stagedDir());

    console.log(
      `[restore] staged ${request.sourceName} (${request.kind}, ${request.bytes} bytes, sha256 ${request.sha256.slice(0, 12)}) requested by user ${request.requestedByUserId}`,
    );
    return request;
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

/** F18's recovery text: the literal commands an operator can run by hand. */
function buildRecoveryText(dataDir: string, plan: RestorePlan): string {
  const commands: string[] = [];
  if (plan.safetyCopy) {
    commands.push(`mv ${path.join(dataDir, plan.safetyCopy)} ${path.join(dataDir, 'budget.db')}`);
  }
  if (plan.receiptsMovedAside) {
    commands.push(`mv ${path.join(dataDir, plan.receiptsMovedAside)} ${path.join(dataDir, 'receipts')}`);
  }
  if (commands.length === 0) return 'No safety copy was made before the failure; nothing was changed.';
  return `Recover manually: ${commands.join(' && ')}`;
}

function failExhausted(applying: string, marker: MarkerFields, plan: RestorePlan, reason: string, now: Date): void {
  const dataDir = readEnv().dataDir;
  const recovery = buildRecoveryText(dataDir, plan);
  writeOutcome(failedOutcome(marker, `${reason} ${recovery}`, now, plan));
  const failedDir = path.join(dataDir, `restore-failed-${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.renameSync(applying, failedDir);
}

function runCommitAttempt(applying: string, marker: MarkerFields, plan: RestorePlan, dataDir: string, now: Date): void {
  try {
    const result = commitRestore(plan, { dataDir });
    writeOutcome(successOutcome(marker, plan, result, now));
    fs.rmSync(applying, { recursive: true, force: true });
  } catch (error) {
    if (plan.attempts >= MAX_COMMIT_ATTEMPTS) {
      failExhausted(applying, marker, plan, 'This restore step could not be completed after the maximum number of attempts.', now);
    }
    // Else: leave restore-applying/ (with commit.json already at the incremented attempts
    // count) exactly as it is. MUST-20.20: boot continues regardless; the next boot resumes.
  }
}

/**
 * MUST-20.19: restore-applying/ already existed when this boot started — a PREVIOUS boot
 * either died during prepare (no commit.json: discard outright, never re-prepared) or during
 * commit (commit.json present: resume under the attempt cap).
 */
function resumeApplying(applying: string, now: Date): void {
  const marker = readMarkerLoose(markerPathOf(applying));
  const commitJsonPath = commitJsonPathOf(applying);

  if (!fs.existsSync(commitJsonPath)) {
    writeOutcome(
      failedOutcome(
        marker,
        'The restore was interrupted before it reached the point of no return; nothing was changed.',
        now,
      ),
    );
    fs.rmSync(applying, { recursive: true, force: true });
    return;
  }

  const plan = JSON.parse(fs.readFileSync(commitJsonPath, 'utf8')) as RestorePlan;
  const dataDir = readEnv().dataDir;

  if (plan.attempts >= MAX_COMMIT_ATTEMPTS) {
    failExhausted(applying, marker, plan, 'This restore failed after the maximum number of attempts.', now);
    return;
  }

  const withAttempt: RestorePlan = { ...plan, attempts: plan.attempts + 1 };
  writeJsonAtomically(commitJsonPath, withAttempt);
  runCommitAttempt(applying, marker, withAttempt, dataDir, now);
}

/** The PREPARE phase for a freshly-promoted request: build the plan, write commit.json (the
 *  point of no return), then attempt the first commit. */
function prepareAndCommit(applying: string, marker: RestoreRequest, now: Date): void {
  const dataDir = readEnv().dataDir;
  let plan: RestorePlan;
  try {
    plan = prepareRestore(payloadPathOf(applying), {
      dataDir,
      scratchDir: applying,
      migrationsFolder: migrationsFolder(),
      now,
    });
  } catch (error) {
    // MUST-20.19/F15/F16: prepare failed. Live data is untouched by construction
    // (prepareRestore writes nothing outside scratchDir) — discard outright.
    writeOutcome(failedOutcome(marker, describeError(error), now));
    fs.rmSync(applying, { recursive: true, force: true });
    return;
  }

  const withAttempt: RestorePlan = { ...plan, attempts: 1 };
  writeJsonAtomically(commitJsonPathOf(applying), withAttempt);
  runCommitAttempt(applying, marker, withAttempt, dataDir, now);
}

/**
 * Still in STAGED: revalidate everything before promoting (MUST-20.14's second call, and
 * F12-F14's exact behaviour — a failure here removes restore-staged/, never creates
 * restore-applying/ at all).
 */
function promoteStagedAndPrepare(staged: string, applying: string, now: Date): void {
  const dataDir = readEnv().dataDir;
  const markerPath = markerPathOf(staged);
  let marker: RestoreRequest;
  try {
    marker = readMarkerStrict(markerPath);
    const payloadPath = payloadPathOf(staged);
    if (!fs.existsSync(payloadPath)) {
      throw new RestoreError('The staged backup payload is missing. Nothing was changed.');
    }
    if (sha256File(payloadPath) !== marker.sha256) {
      throw new RestoreError('The staged backup payload does not match its recorded checksum. Nothing was changed.');
    }
    const revalidateScratch = path.join(dataDir, 'tmp', `${randomUUID()}-restore`);
    try {
      validateArtifact(payloadPath, { scratchDir: revalidateScratch, migrationsFolder: migrationsFolder() });
    } finally {
      fs.rmSync(revalidateScratch, { recursive: true, force: true });
    }
  } catch (error) {
    const loose = readMarkerLoose(markerPath);
    writeOutcome(failedOutcome(loose, describeError(error), now));
    fs.rmSync(staged, { recursive: true, force: true });
    return;
  }

  // MUST-20.9-style single atomic claim: this request is now claimed exactly once.
  fs.renameSync(staged, applying);
  prepareAndCommit(applying, marker, now);
}

function runBootRestore(now: Date): void {
  const applying = applyingDir();
  if (fs.existsSync(applying)) {
    resumeApplying(applying, now);
    return;
  }
  const staged = stagedDir();
  if (!fs.existsSync(staged)) return; // MUST-20.27: the fast path — two stat calls, nothing logged.
  promoteStagedAndPrepare(staged, applying, now);
}

/**
 * MUST-20.20, and the single most important line in this file. ${DATA_DIR} is a bind mount
 * the owner can edit, so every input here is untrusted; and a container that refuses to boot
 * is a worse outcome than a restore that did not happen — the same call MUST-7.6 already
 * makes for the OCR assets. Every failure is recorded and swallowed.
 */
export function applyStagedRestoreOnBoot(now: Date = new Date()): void {
  try {
    runBootRestore(now);
  } catch (error) {
    console.error('[restore] boot hook failed; continuing boot with the current data', error);
    try {
      const candidates = [markerPathOf(applyingDir()), markerPathOf(stagedDir())];
      const found = candidates.find((candidate) => fs.existsSync(candidate));
      const marker = found ? readMarkerLoose(found) : readMarkerLoose('');
      writeOutcome(failedOutcome(marker, describeError(error), now));
    } catch {
      /* nothing more we can do */
    }
  }
}

const PRE_RESTORE_DB_RE = /^budget\.pre-restore-.+\.db$/;
const PRE_RESTORE_RECEIPTS_RE = /^receipts\.pre-restore-.+$/;
const RESTORE_FAILED_RE = /^restore-failed-.+$/;

function mtimeOf(target: string): number {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/** Removes every match older than PRE_RESTORE_MAX_AGE_MS except the single newest one, which
 *  is always kept regardless of age (MUST-20.33). */
function purgeAgedExceptNewest(dataDir: string, pattern: RegExp, now: Date, remove: (name: string) => void): number {
  const names = fs.readdirSync(dataDir).filter((name) => pattern.test(name));
  if (names.length === 0) return 0;
  const sorted = [...names].sort((a, b) => mtimeOf(path.join(dataDir, b)) - mtimeOf(path.join(dataDir, a)));
  let removed = 0;
  for (const name of sorted.slice(1)) {
    if (now.getTime() - mtimeOf(path.join(dataDir, name)) > PRE_RESTORE_MAX_AGE_MS) {
      remove(name);
      removed += 1;
    }
  }
  return removed;
}

function removeDbAndSidecars(dataDir: string, name: string): void {
  fs.rmSync(path.join(dataDir, name), { force: true });
  const stem = name.replace(/\.db$/, '');
  fs.rmSync(path.join(dataDir, `${stem}.db-wal`), { force: true });
  fs.rmSync(path.join(dataDir, `${stem}.db-shm`), { force: true });
}

/**
 * MUST-20.33: `budget.pre-restore-<stamp>.db` (with its `-wal`/`-shm` siblings),
 * `receipts.pre-restore-<stamp>` directories and `restore-failed-<stamp>` directories older
 * than 30 days are removed, except that the most recent of each kind is always kept
 * regardless of age — the newest undo is never the one that disappears.
 */
export function purgePreRestoreCopies(now: Date = new Date()): number {
  const dataDir = readEnv().dataDir;
  if (!fs.existsSync(dataDir)) return 0;
  let removed = 0;
  removed += purgeAgedExceptNewest(dataDir, PRE_RESTORE_DB_RE, now, (name) => removeDbAndSidecars(dataDir, name));
  removed += purgeAgedExceptNewest(dataDir, PRE_RESTORE_RECEIPTS_RE, now, (name) =>
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true }),
  );
  removed += purgeAgedExceptNewest(dataDir, RESTORE_FAILED_RE, now, (name) =>
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true }),
  );
  return removed;
}
