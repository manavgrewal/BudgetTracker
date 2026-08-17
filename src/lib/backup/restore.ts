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
import { ARCHIVE_NAME_RE, LEGACY_NAME_RE, PARTIAL_MAX_AGE_MS, backupsDir, resolveSafeTarget } from '@/lib/backup/archive';
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

/**
 * CRITICAL (T1 review): commit.json lives on the same bind-mounted ${DATA_DIR} as everything
 * else here, so it is exactly as untrusted as restore-request.json (MUST-20.13) — a hand-
 * written or tampered commit.json is an unconstrained rename/unlink primitive at boot time if
 * it is ever trusted without validation. zod pins the shape; the path-containment check right
 * after it (assertPlanPathsAreSafe) pins that every path/from/to it names actually resolves
 * inside ${DATA_DIR}, so a tampered `to` of `/etc/passwd` (or `../../whatever`) is refused
 * before a single rename is attempted.
 */
const stepSchema = z.union([
  z.object({
    op: z.literal('rename'),
    from: z.string().min(1),
    to: z.string().min(1),
    optional: z.boolean().optional(),
    incoming: z.boolean().optional(),
  }),
  z.object({ op: z.literal('touch-receipts'), dir: z.string().min(1) }),
]);

const planSchema = z.object({
  version: z.literal(1),
  stamp: z.string().min(1),
  kind: z.enum(['archive', 'sqlite']),
  steps: z.array(stepSchema),
  attempts: z.number().int().nonnegative(),
  receiptsRestored: z.number().int().nonnegative(),
  safetyCopy: z.string().nullable(),
  receiptsMovedAside: z.string().nullable(),
});

function resolvesInside(dataDir: string, candidate: string): boolean {
  const resolvedDir = path.resolve(dataDir);
  const resolved = path.resolve(candidate);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

function assertPlanPathsAreSafe(plan: RestorePlan, dataDir: string): void {
  for (const step of plan.steps) {
    const paths: string[] =
      step.op === 'rename' ? [step.from, step.to] : step.op === 'touch-receipts' ? [step.dir] : [];
    for (const candidate of paths) {
      if (!resolvesInside(dataDir, candidate)) {
        throw new RestoreError('The restore commit journal references a path outside the data directory.');
      }
    }
  }
}

/**
 * The ONLY place commit.json is read. Never a bare cast: a truncated file (JSON.parse throws)
 * or one whose shape zod rejects is treated by the caller exactly like exhausted retries —
 * terminal, not silently discarded — so a corrupted or hand-edited commit.json can never wedge
 * the state machine in restore-applying/ forever (which would otherwise mean the GUI can never
 * stage another restore again).
 */
function readCommitJsonStrict(commitJsonPath: string, dataDir: string): RestorePlan {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(commitJsonPath, 'utf8'));
  } catch {
    throw new RestoreError('The restore commit journal is unreadable or corrupted.');
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RestoreError('The restore commit journal failed validation.');
  }
  const plan = parsed.data as RestorePlan;
  assertPlanPathsAreSafe(plan, dataDir);
  return plan;
}

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

/**
 * MUST-20.13/20.22: a half-written file must never be readable, AND (the `attempts` counter
 * specifically) the write must survive a power loss, not just a process crash — a rename
 * alone only guarantees the LATTER. The temp file is fsync'd before the rename; the
 * directory entry is best-effort fsync'd afterward (wrapped in its own try/catch: Windows,
 * and some filesystems, refuse to open a directory for reading at all).
 */
function writeJsonAtomically(target: string, value: unknown): void {
  const partial = `${target}.partial`;
  const fd = fs.openSync(partial, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(partial, target);
  try {
    const dirFd = fs.openSync(path.dirname(target), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* best-effort only — see docblock above */
  }
}

/**
 * MUST-20.12: restore-result.json's `error` field must be a written, operator-readable
 * sentence, never a raw errno/stack trace. RestoreError messages already are one; anything
 * else (ENOSPC, EIO, a thrown non-Error, an unanticipated bug) is logged in FULL to stderr by
 * every caller of this function already — this is only what reaches the JSON file.
 */
function describeError(error: unknown): string {
  if (error instanceof RestoreError) return error.message;
  return 'An unexpected error interrupted the restore. Check the container logs for details.';
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

/**
 * F18's recovery text: the literal commands an operator can run by hand. Built from the
 * ACTUAL filesystem state at failure time (fs.existsSync), never assumed from the plan alone
 * — `plan.safetyCopy` names a file that was never created if step 1 itself failed, and
 * `receipts.pre-restore-<stamp>` cannot simply be moved back to `receipts` if a LATER step
 * already renamed the incoming receipts into that path: `mv` would nest the old directory
 * INSIDE the new one instead of restoring it. Whichever of `budget.db`/`receipts` is
 * currently occupied gets moved aside to a `.failed-<stamp>` sibling first, so the safety
 * copy always lands at the real target path.
 */
function buildRecoveryText(dataDir: string, plan: RestorePlan): string {
  const commands: string[] = [];
  const dbTarget = path.join(dataDir, 'budget.db');
  const safetyCopyPath = plan.safetyCopy ? path.join(dataDir, plan.safetyCopy) : null;
  if (safetyCopyPath && fs.existsSync(safetyCopyPath)) {
    // T1 re-review D2: the same class of hazard D1 fixed for the automated replay path
    // applies here too, by hand — a stray -wal/-shm at the LIVE path would be replayed over
    // the recovered file the instant it is next opened. And the safety copy's OWN -wal/-shm
    // can hold a committed-but-uncheckpointed transaction — moving only the .db file back
    // would silently drop it, so the trio moves together. Every line is conditioned on the
    // file actually existing, checked at the moment this text is built, never assumed from
    // `plan` alone.
    //
    // T1 re-review round 2 (BLOCKER fix): a live -wal/-shm is NOT always impostor garbage.
    // The discriminator is `dbTarget` itself: getDb() always creates its main file before
    // ever writing a WAL frame, so an impostor's sidecars are NEVER seen without an impostor
    // main file sitting right beside them. If `dbTarget` is ABSENT but a -wal/-shm is
    // present anyway, that can only mean step 1/2 (renaming the ORIGINAL live db's own
    // -wal/-shm to the safety copy) failed after step 0 (renaming the main file) already
    // succeeded — this is the ORIGINAL database's own orphaned journal, possibly holding
    // committed transactions, and deleting it would be a straight data-loss regression. It
    // is preserved instead: moved to join the safety copy under its proper name (unless
    // that name is already occupied, in which case nothing safe can be inferred and it is
    // left alone for the operator to reconcile by hand).
    const liveWal = `${dbTarget}-wal`;
    const liveShm = `${dbTarget}-shm`;
    const safetyWal = `${safetyCopyPath}-wal`;
    const safetyShm = `${safetyCopyPath}-shm`;
    const steps: string[] = [];
    let safetyWalExists = fs.existsSync(safetyWal);
    let safetyShmExists = fs.existsSync(safetyShm);
    if (fs.existsSync(dbTarget)) {
      // An impostor main file is present — its sidecars, if any, are impostor garbage.
      steps.push(`mv ${dbTarget} ${path.join(dataDir, `budget.failed-${plan.stamp}.db`)}`);
      if (fs.existsSync(liveWal)) steps.push(`rm -f ${liveWal}`);
      if (fs.existsSync(liveShm)) steps.push(`rm -f ${liveShm}`);
    } else {
      // No main file — a sidecar here is the original database's own orphaned journal.
      if (fs.existsSync(liveWal) && !safetyWalExists) {
        steps.push(`mv ${liveWal} ${safetyWal}`);
        safetyWalExists = true;
      }
      if (fs.existsSync(liveShm) && !safetyShmExists) {
        steps.push(`mv ${liveShm} ${safetyShm}`);
        safetyShmExists = true;
      }
    }
    steps.push(`mv ${safetyCopyPath} ${dbTarget}`);
    if (safetyWalExists) steps.push(`mv ${safetyWal} ${liveWal}`);
    if (safetyShmExists) steps.push(`mv ${safetyShm} ${liveShm}`);
    commands.push(steps.join(' && '));
  }
  const receiptsTarget = path.join(dataDir, 'receipts');
  const receiptsAsidePath = plan.receiptsMovedAside ? path.join(dataDir, plan.receiptsMovedAside) : null;
  if (receiptsAsidePath && fs.existsSync(receiptsAsidePath)) {
    if (fs.existsSync(receiptsTarget)) {
      commands.push(
        `mv ${receiptsTarget} ${path.join(dataDir, `receipts.failed-${plan.stamp}`)} && mv ${receiptsAsidePath} ${receiptsTarget}`,
      );
    } else {
      commands.push(`mv ${receiptsAsidePath} ${receiptsTarget}`);
    }
  }
  if (commands.length === 0) {
    return 'No recoverable safety copy was found; inspect the data directory by hand.';
  }
  return `Recover manually: ${commands.join(' && ')}`;
}

/**
 * `'continue'` — boot may proceed to getDb() as normal. `'restart'` — MUST-20.23: a commit
 * was interrupted mid-step and has NOT exhausted its retry cap; commit.json (and therefore
 * restore-applying/) still exists, and the live budget.db may currently be missing or
 * mid-transition. The caller (src/instrumentation-node.ts) MUST NOT call getDb() in this
 * case — see applyStagedRestoreOnBoot()'s docblock — and must exit with RESTART_EXIT_CODE
 * instead, so the next boot resumes the same commit.json under the same attempt cap.
 */
type BootOutcome = 'continue' | 'restart';

function safeRemove(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    // A failed best-effort cleanup must never overturn a terminal outcome that was already
    // written successfully just before it (T1 review, IMPORTANT minor).
    console.warn(`[restore] could not remove ${target} after recording the outcome`, error);
  }
}

function failExhausted(applying: string, marker: MarkerFields, plan: RestorePlan, reason: string, now: Date): void {
  const dataDir = readEnv().dataDir;
  const recovery = buildRecoveryText(dataDir, plan);
  writeOutcome(failedOutcome(marker, `${reason} ${recovery}`, now, plan));
  const failedDir = path.join(dataDir, `restore-failed-${now.toISOString().replace(/[:.]/g, '-')}`);
  try {
    fs.renameSync(applying, failedDir);
  } catch (error) {
    console.warn(`[restore] could not rename ${applying} to ${failedDir}`, error);
  }
}

/**
 * CRITICAL (T1 review): a commit.json that fails to parse or fails zod/path validation is
 * treated exactly like exhausted retries — a TERMINAL failure, `restore-applying/` renamed
 * to `restore-failed-<stamp>/` — never silently `rm -rf`'d and never left in place. Either of
 * those would risk the state machine either destroying evidence or wedging forever (staging
 * refuses while `restore-applying/` exists — MUST-20.10 — so the GUI could never restore
 * again). None of the corrupt file's fields are trusted for the recovery text; the operator
 * is pointed at the renamed directory and the data directory itself.
 */
function failCorruptCommitJson(applying: string, marker: MarkerFields, reason: string, now: Date): void {
  writeOutcome(
    failedOutcome(
      marker,
      `${reason} The restore commit journal could not be trusted, so no automatic recovery text could be built. ` +
        `Inspect the renamed restore-applying/ directory and any budget.pre-restore-*.db / receipts.pre-restore-*/ ` +
        `files under the data directory by hand.`,
      now,
    ),
  );
  const dataDir = readEnv().dataDir;
  const failedDir = path.join(dataDir, `restore-failed-${now.toISOString().replace(/[:.]/g, '-')}`);
  try {
    fs.renameSync(applying, failedDir);
  } catch (error) {
    console.warn(`[restore] could not rename ${applying} to ${failedDir}`, error);
  }
}

function runCommitAttempt(applying: string, marker: MarkerFields, plan: RestorePlan, dataDir: string, now: Date): BootOutcome {
  // T1 review minor: the try block below covers ONLY commitRestore() itself — the one thing
  // that can genuinely fail and need a retry. A failure in the bookkeeping that follows a
  // SUCCESSFUL commit (writeOutcome, cleanup) must never be reinterpreted as "the commit
  // failed": that would misreport a real success as an exhausted failure, or worse, signal
  // 'restart' for a restore that has already, correctly, fully completed.
  let result: RestoreResult;
  try {
    result = commitRestore(plan, { dataDir, now });
  } catch (error) {
    if (plan.attempts >= MAX_COMMIT_ATTEMPTS) {
      failExhausted(
        applying,
        marker,
        plan,
        `This restore step could not be completed after the maximum number of attempts (${describeError(error)}).`,
        now,
      );
      return 'continue';
    }
    // CRITICAL (T1 review): commit.json already exists (the point of no return) and this
    // attempt did not exhaust the cap. Leave restore-applying/ exactly as it is — its
    // commit.json already has the incremented attempts count persisted, from BEFORE this
    // attempt ran — and signal 'restart' so the caller exits instead of proceeding to
    // getDb(). MUST-20.20 ("never throws") still holds: this function returns normally.
    console.error(`[restore] commit attempt ${plan.attempts} failed; signalling a restart to retry`, error);
    return 'restart';
  }

  try {
    writeOutcome(successOutcome(marker, plan, result, now));
  } catch (error) {
    console.error('[restore] the restore succeeded but recording the outcome failed', error);
  }
  safeRemove(applying);
  return 'continue';
}

/**
 * T1 re-review D3: writes commit.json's attempts count, guarding against the write ITSELF
 * failing (ENOSPC, a read-only filesystem, etc). A bare propagation to the top-level catch
 * here would return `'continue'` while commit.json still exists — precisely the condition
 * that lets `getDb()` create an impostor database (D1's root cause). On failure, re-read
 * commit.json fresh from disk — never trust the in-memory `withAttempt` value this call
 * failed to persist:
 *
 * - **Readable, and its PERSISTED attempts is under the cap** → `'restart'` is sound: the
 *   value on disk is UNCHANGED (this write never landed), so the next boot resumes from
 *   exactly the same state this one started from — no different than any other
 *   `'restart'`. (The cap-reached case is handled entirely by the caller BEFORE this
 *   function is ever invoked — `resumeApplying` already routes to `failExhausted` when
 *   `plan.attempts >= MAX_COMMIT_ATTEMPTS`, so this branch never has to consider it.)
 * - **Unreadable, or already at the cap** → treated as terminal, exactly like a corrupt
 *   commit.json (`failCorruptCommitJson`), which always converges: it renames
 *   restore-applying/ away, so no later boot can find this state again.
 *
 * The one case this does NOT bound is a filesystem that reliably fails every WRITE while
 * every READ keeps succeeding, forever, with attempts never reaching the cap — that
 * restarts indefinitely, BY DESIGN: terminality can only ever be recorded by a successful
 * write (both the failed outcome and the rename-away that makes it stick require one), so a
 * volume that is read-only or full produces a Docker-restart-policy-throttled boot loop
 * rather than a false "recorded as failed" that a genuinely half-applied restore does not
 * deserve. Fail-stop (keep retrying, change nothing further) beats fail-corrupt (declare
 * defeat on a guess and leave the state machine possibly wrong) here. The operator's fix is
 * to repair the volume (free space / remount writable), at which point the very next
 * restart either completes the commit or reaches the cap and resolves normally.
 */
function persistAttemptsOrTerminal(
  applying: string,
  marker: MarkerFields,
  commitJsonPath: string,
  dataDir: string,
  withAttempt: RestorePlan,
  now: Date,
): BootOutcome | null {
  try {
    writeJsonAtomically(commitJsonPath, withAttempt);
    return null; // wrote fine — caller proceeds normally
  } catch (writeError) {
    console.error('[restore] failed to persist the restore commit journal', writeError);
    try {
      const reread = readCommitJsonStrict(commitJsonPath, dataDir);
      if (reread.attempts < MAX_COMMIT_ATTEMPTS) return 'restart';
    } catch {
      /* unreadable: fall through to terminal below */
    }
    failCorruptCommitJson(applying, marker, describeError(writeError), now);
    return 'continue';
  }
}

/**
 * MUST-20.19: restore-applying/ already existed when this boot started — a PREVIOUS boot
 * either died during prepare (no commit.json: discard outright, never re-prepared) or during
 * commit (commit.json present: resume under the attempt cap).
 */
function resumeApplying(applying: string, now: Date): BootOutcome {
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
    safeRemove(applying);
    return 'continue';
  }

  const dataDir = readEnv().dataDir;
  let plan: RestorePlan;
  try {
    plan = readCommitJsonStrict(commitJsonPath, dataDir);
  } catch (error) {
    failCorruptCommitJson(applying, marker, describeError(error), now);
    return 'continue';
  }

  if (plan.attempts >= MAX_COMMIT_ATTEMPTS) {
    failExhausted(applying, marker, plan, 'This restore failed after the maximum number of attempts.', now);
    return 'continue';
  }

  // MUST-20.22: attempts is incremented and persisted BEFORE the first step of this run.
  const withAttempt: RestorePlan = { ...plan, attempts: plan.attempts + 1 };
  const guarded = persistAttemptsOrTerminal(applying, marker, commitJsonPath, dataDir, withAttempt, now);
  if (guarded !== null) return guarded;
  return runCommitAttempt(applying, marker, withAttempt, dataDir, now);
}

/** The PREPARE phase for a freshly-promoted request: build the plan, write commit.json (the
 *  point of no return), then attempt the first commit. */
function prepareAndCommit(applying: string, marker: RestoreRequest, now: Date): BootOutcome {
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
    safeRemove(applying);
    return 'continue';
  }

  const withAttempt: RestorePlan = { ...plan, attempts: 1 };
  const commitJsonPath = commitJsonPathOf(applying);
  const guarded = persistAttemptsOrTerminal(applying, marker, commitJsonPath, dataDir, withAttempt, now);
  if (guarded !== null) return guarded;
  return runCommitAttempt(applying, marker, withAttempt, dataDir, now);
}

/**
 * Still in STAGED: revalidate everything before promoting (MUST-20.14's second call, and
 * F12-F14's exact behaviour — a failure here removes restore-staged/, never creates
 * restore-applying/ at all).
 */
function promoteStagedAndPrepare(staged: string, applying: string, now: Date): BootOutcome {
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
    safeRemove(staged);
    return 'continue';
  }

  // MUST-20.9-style single atomic claim: this request is now claimed exactly once.
  fs.renameSync(staged, applying);
  return prepareAndCommit(applying, marker, now);
}

function runBootRestore(now: Date): BootOutcome {
  const applying = applyingDir();
  if (fs.existsSync(applying)) {
    return resumeApplying(applying, now);
  }
  const staged = stagedDir();
  if (!fs.existsSync(staged)) return 'continue'; // MUST-20.27: the fast path — two stat calls, nothing logged.
  return promoteStagedAndPrepare(staged, applying, now);
}

/**
 * MUST-20.20, and the single most important line in this file. ${DATA_DIR} is a bind mount
 * the owner can edit, so every input here is untrusted; and a container that refuses to boot
 * is a worse outcome than a restore that did not happen — the same call MUST-7.6 already
 * makes for the OCR assets. Every failure is recorded and swallowed — this function itself
 * never throws.
 *
 * MUST-20.23: its RETURN VALUE is part of the boot contract, not just informational.
 * `'restart'` means a commit is mid-flight and has not exhausted its retries — the caller
 * (src/instrumentation-node.ts) MUST exit with RESTART_EXIT_CODE instead of calling getDb().
 * Continuing to boot in that state would let getDb() CREATE a fresh, empty, migrated
 * budget.db at exactly the path the interrupted commit still needs to write its real payload
 * to, and the app would then serve (and possibly accept writes into) that empty database
 * until the next restart overwrites it — silently losing whatever was written in the
 * meantime. `'continue'` covers every other case: nothing staged, a discarded prepare-phase
 * death, a completed success, and an exhausted-retries terminal failure — all of which leave
 * `restore-applying/` gone and a definitive result recorded, so booting onward is safe.
 */
export function applyStagedRestoreOnBoot(now: Date = new Date()): BootOutcome {
  const resultFile = resultPath();
  const resultMtimeBefore = mtimeOf(resultFile);
  try {
    return runBootRestore(now);
  } catch (error) {
    console.error('[restore] boot hook failed; continuing boot with the current data', error);
    try {
      // T1 review minor: if an inner step already wrote a terminal outcome during THIS call
      // (e.g. the restore itself succeeded and only a best-effort cleanup afterward threw),
      // resultPath()'s mtime will have moved. Never clobber a true result with a synthesized
      // failure just because something unrelated threw after it was written.
      if (mtimeOf(resultFile) !== resultMtimeBefore) return 'continue';
      const candidates = [markerPathOf(applyingDir()), markerPathOf(stagedDir())];
      const found = candidates.find((candidate) => fs.existsSync(candidate));
      const marker = found ? readMarkerLoose(found) : readMarkerLoose('');
      writeOutcome(failedOutcome(marker, describeError(error), now));
    } catch {
      /* nothing more we can do */
    }
    // An UNANTICIPATED top-level error (as opposed to a known, caught commit-attempt
    // failure) does not by itself tell us whether a commit was in flight, and MUST-20.20's
    // governing principle is that a container which will not boot is worse than a restore
    // that did not happen — so this path continues boot, unlike the narrower, well-understood
    // 'restart' signal from runCommitAttempt() above.
    return 'continue';
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
  // T1 review minor: a restore-result.json.partial left by a writeJsonAtomically() call that
  // was killed before its rename — mirrors the existing `.partial` sweep rule for backup
  // archives (src/lib/backup/archive.ts's PARTIAL_MAX_AGE_MS), same 24h "nothing in flight
  // could still be writing it" reasoning, not the 30-day safety-copy window above.
  const partial = path.join(dataDir, 'restore-result.json.partial');
  if (fs.existsSync(partial) && now.getTime() - mtimeOf(partial) > PARTIAL_MAX_AGE_MS) {
    fs.rmSync(partial, { force: true });
    removed += 1;
  }
  return removed;
}
