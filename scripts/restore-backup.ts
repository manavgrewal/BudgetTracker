#!/usr/bin/env node
/**
 * Rescue tool: restore a Budget Tracker backup artifact into a data directory.
 *
 * As of v1.2.0 this is a thin CLI shell over scripts/restore-core.ts, which holds every piece
 * of restore logic shared with the app-side boot hook (src/lib/backup/restore.ts). It remains
 * the disaster fallback for the one case the GUI cannot serve: the app does not boot at all,
 * so there is no Settings page to click.
 *
 *   docker compose down
 *   docker compose run --rm --entrypoint node budget-tracker \
 *     --experimental-strip-types scripts/restore-backup.ts /data/backups/budget-2026-08-16.tar.gz
 *   docker compose up -d
 *
 * ...or, from a checkout:  npm run restore-backup -- <artifact> [--data-dir ./data]
 *
 * This script is DELIBERATELY self-contained, exactly like scripts/reset-admin-password.ts:
 * the runtime image ships Next's standalone output, which does not include the project's
 * src/ tree, so the "@/..." import alias cannot resolve in the container. scripts/restore-
 * core.ts (and therefore this file) talks to node-tar and better-sqlite3 directly — both are
 * already present in the image.
 *
 * tests/scripts/restore-backup.test.ts pins RESTORE_STORED_NAME_RE against
 * src/lib/warranty/receipts.ts so the two can never drift apart unnoticed, and must keep
 * passing unmodified — it is the regression net for the security properties restore-core.ts
 * now holds.
 */
import { pathToFileURL } from 'node:url';
import {
  RESTORE_STORED_NAME_RE,
  RestoreError,
  detectArtifactKind,
  restoreFromArtifact,
  type ArtifactKind,
  type RestoreResult,
} from './restore-core.ts';

// Re-exported so tests/scripts/restore-backup.test.ts — the regression net for the tar-slip
// defence and the cross-version rules — keeps importing them from here, unmodified.
export { RESTORE_STORED_NAME_RE, RestoreError, detectArtifactKind, restoreFromArtifact };
export type { ArtifactKind, RestoreResult };

function resolveDataDir(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const flag = argv.indexOf('--data-dir');
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  return env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : '/data';
}

/**
 * Returns the artifact path: the first positional argument, i.e. the first entry that is
 * neither `--data-dir` nor the value immediately following it. Written as an explicit index
 * walk (not `argv.indexOf(arg)` inside a `.find()`) so a duplicated value — e.g. the artifact
 * path happening to equal the `--data-dir` value, or `--data-dir` appearing twice — cannot
 * make `indexOf` resolve to the wrong occurrence.
 */
function resolveArtifactArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir') {
      i += 1; // skip its value
      continue;
    }
    if (!argv[i].startsWith('--')) return argv[i];
  }
  return undefined;
}

function usage(): void {
  console.log(`Restore a Budget Tracker backup artifact into a data directory.

Usage:
  node --experimental-strip-types scripts/restore-backup.ts <artifact.tar.gz|artifact.db> [--data-dir /data] [--allow-newer]

Run this with the container STOPPED — restoring under a live SQLite connection is how you
corrupt a database. See INSTALL.md -> "Restoring from a backup".

  docker compose down
  docker compose run --rm --entrypoint node budget-tracker \\
    --experimental-strip-types scripts/restore-backup.ts /data/backups/budget-2026-08-16.tar.gz
  docker compose up -d

Both artifact shapes are accepted, detected by content, not filename:
  - a v1.1+ ".tar.gz" archive containing budget.db and every receipt file
  - a v1.0.0 bare ".db" SQLite snapshot (receipts/ is left completely untouched)

Data directory: --data-dir, else $DATA_DIR, else /data.

--allow-newer: bypass the one-way migration guard, which otherwise refuses a backup carrying
more applied migrations than this build ships. Use this ONLY when restoring a backup made by
a newer app version after deliberately rolling the running image back to recover from a bad
upgrade. It is CLI-only — there is no equivalent flag or setting for the GUI/boot restore
path, which can never bypass this guard.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const artifact = resolveArtifactArg(argv);
  if (!artifact) {
    console.error('Usage: restore-backup <artifact.tar.gz|artifact.db> [--data-dir /data]');
    console.error('Stop the container first. See INSTALL.md -> "Restoring from a backup".');
    process.exit(1);
  }
  const dataDir = resolveDataDir(argv);
  const allowNewerMigrations = argv.includes('--allow-newer');
  const result = restoreFromArtifact(artifact, { dataDir, allowNewerMigrations });
  console.log(`Restored ${result.kind === 'archive' ? 'archive' : 'database-only backup'} into ${dataDir}`);
  console.log(`  database restored: ${result.databaseRestored}`);
  console.log(`  receipt files restored: ${result.receiptsRestored}`);
  if (result.receiptsMovedAside) console.log(`  previous receipts kept at: ${result.receiptsMovedAside}`);
  // MUST-12.9: an explicit count, so a cross-version restore is honest about what is missing.
  console.log(`  ${result.missingReceiptRows} receipt rows reference files that are not present on disk.`);
  // Fix report BLOCKER 1a: only meaningful for a DB-only restore, which is the one case that
  // leaves a pre-existing receipts/ directory in place with mtimes the nightly sweep would
  // otherwise treat as stale.
  if (result.kind === 'sqlite') {
    console.log(
      `  ${result.receiptsTouched} existing receipt file(s) had their mtime refreshed so tonight's maintenance sweep will not treat them as orphans.`,
    );
  }
}

// Only run when invoked directly, so the test file can import the functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
