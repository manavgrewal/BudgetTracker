# SDD ledger — plan: docs/superpowers/plans/2026-08-16-warranty-tracker.md

Spec: docs/superpowers/specs/2026-08-16-warranty-tracker-design.md (binding authority)
Branch: main (established user-approved workflow — commit per task, push at end)
Base at start: 7b0b29e (plan commit; app v1.0.0 code base = 63deb7d spec commit over c4bddd7)
Models: Sonnet implementers; Opus reviewers on load-bearing tasks (1 migration, 3 storage, 5 OCR, 6 data layer, 7 routes, 8 actions, 11 backup); Sonnet reviewers elsewhere scaled to diff.
Ruling: run on main, no worktree — user's established project workflow from v1.0.0 build (29 commits on main); cost if wrong: messy history, user can revert.
Ruling: pre-flight conflict scan delegated to Opus subagent (token economy per user's standing instruction); table to be appended below; cost if wrong: scan quality depends on agent.

## Pre-flight scan: 60 rows, NOT-CLEAN, 17 findings — full table in preflight-scan.md. Rulings (carried into task dispatches):
- Ruling P1+P2 (T11): plan's test-edit line numbers wrong/incomplete for tar.gz format change — implementer must fix ALL tests broken by the format change (backup.test.ts:62-70,:92,:154 included); plan line refs advisory, spec (.tar.gz artifact) binding. Cost if wrong: red suite, caught immediately.
- Ruling P3 (T11): no `require()` in ESM vitest files — use import per existing test idiom.
- Ruling P4 (T6+T9): client-safe constants (WARRANTY_SORTS etc.) move to a pure module `src/lib/warranty/constants.ts`; search.ts re-exports server-side. Prevents better-sqlite3 entering client bundle. Cost if wrong: import churn.
- Ruling P5 (T5): MUST-7.11 binding — OCR timeout must terminate + recreate the worker, not just reject. Plan code incomplete; spec wins.
- Ruling P6 (T5): vacuous queue-depth test replaced with real increment assertion.
- Ruling P7+P8 (T10,T3): vacuous tests (querySelector ?? innerHTML fallback; not.toContain('ocrText'); duplicate sniff case) replaced with strict assertions; href encoding asserted against actual component output.
- Ruling P9 (T6): commitStaged must track adopted files DURING rename loop so catch-path unlinks them; plan's post-hoc tracking leaks on mid-transaction throw. Orphan sweep remains the net.
- Ruling P10 (T12,T7,T8): duplication — (a) check-ocr-assets.mjs paths pinned to resolveOcrAssets() by a test (ARGON2_OPTIONS precedent); (b) T7 imports STAGING_ID_RE, no inline regex; (c) T8 reuses SuggestedFields type from suggest.ts, no parallel Dto.
- Ruling P11 (T3): spec §15.1 wins — short (3-byte) buffers REJECTED by sniffer; plan's acceptance test inverted.
- Ruling P12 (T9): accept plan's GET-form+Apply search over spec §10.2's 250ms debounce — deliberate deviation, simpler, no client DB import; spec intent (usable search) met. Cost if wrong: UX nit, easily added later.
- Ruling P13 (T11): EXTEND (not delete) existing Hyper Backup unencrypted-backup wording — MUST-13.9.
- Ruling P14 (T5+T11): purgeStagedFiles must skip directories (stat check) — buildArchive's tmp dir must not kill nightly sweep.
- Ruling P15 (T5): enqueue-during-drain race — implementer must reason through interleaving, make drain loop re-check queue before idling, add covering test.
- Ruling P16 (T7): 413 pre-check test must be proven live (content-length may be unsettable on FormData Request) — else test the guard directly with a raw-body Request.
- Ruling P17 (global): GIT COMMIT PAUSE IN PLAN IS STALE — commits per task ARE required; git commands in plan advisory, commit actual final paths (T11 git mv case).

Task 1: fix round 1/5 (4 addressed, 0 open — header warning, title, journal-derived count, LIKE escape; commits 6e68b71..6432dee)
Task 1: complete (commits 7b0b29e..6432dee, review clean after 1 fix round)
Task 2: complete (commits 6432dee..42e59cb, review clean, zero findings)
Task 3: fix round 1/5 (6 addressed — WebP exact-byte sniff, adopt-source guard, adopt mtime refresh, sweep isFile guard [Ruling P14 satisfied for receipts sweep], MIN_SNIFF_BYTES pin, cross-module ext test; commits b4d0c32..cbcffdc)
Task 3: minor (deferred): sniff.ts HEIC brand-predicate redundancy (cosmetic, error-message path only)
Task 3: minor (deferred): receipts.ts read helpers swallow ReceiptStorageError silently alongside ENOENT — console.warn would aid injection-attempt visibility
Task 3: complete (commits 42e59cb..cbcffdc, review clean after 1 fix round)

## Mid-build scope addition (user, 2026-08-16 during Task 3): item types + subscriptions
- Spec amended to v1.1 (§19 addendum, committed aa54ffa). Task 5b brief + type-deltas.md in workspace. Task 5b runs after Task 5, before Task 6. T6/T8/T9/T10/T12 dispatches carry type-deltas.md deltas.
- Ruling: types get integer PKs (spec §19.11.28) — amendment author caught brief's TEXT-id/§3-conventions conflict; every existing table uses INTEGER AUTOINCREMENT. Cost if wrong: none, consistent either way.
- Ruling: subscription = is_subscription flag on type; field reuse verbatim (purchase_date=start, warranty_months=duration, expiry_date=end); cancel reminder = existing expiring-soon mechanics + wording swap. Cost if wrong: schema stays clean, wording adjustable.
- Ruling: type name NOT in FTS (filter not search text; rename must not need FTS rebuild).
- Ruling: deleting in-use type blocked with count (no cascade/set-null surprise).
Task 4: fix round 1/5 pending — Ruling: spec §8.3 CURRENCY_RE amended \d+ → \d{1,9} (quadratic backtracking on 100k digit-run OCR within spec's own cap; ceiling makes 10+ digit amounts invalid anyway). Cost if wrong: none — provably no valid amount lost.
Task 4: fix round 1/5 (2 addressed — CURRENCY_RE \d{1,9} + spec §8.3 amended + ReDoS regression tests; backward-walk documented+tested; commits 0e95abb..af083af)
Task 4: minor (deferred): residual CURRENCY_RE edge — >9-digit run with zero-heavy tail abutting .NN can truncate-match a small false amount (e.g. $1.23). Ruling: parked — suggestion is user-confirmed, never auto-commits (MUST-8.1); airtight fix is a leading (?<!\d) lookbehind; final review triages.
Task 4: complete (commits cbcffdc..af083af, review clean after 1 fix round)
Task 5: fix round 1/5 (6 addressed — errorHandler + wasm asset checks, idle-timer disarm, P15 dead branch removed w/ invariant re-derived independently by re-reviewer, zod sidecar, real pdf fixtures, scheduler testDb; commits a62ca71..8900e7f)
Task 5: minor (deferred): pdf.ts add verbosity: VerbosityLevel.ERRORS to getDocument — every standard-14-font PDF logs a warn in production; one line
Task 5: minor (deferred): engine-options.test.ts source-slice anchor matches a comment now — anchor on 'await createWorker(' instead
Task 5: minor (deferred): runQueue invariant comment should state enqueue-pushes-before-runQueue half of the invariant
Task 5: minor (deferred): corePath comment misleading (getCore.js ignores it); staged-purged job writes no sidecar (poller needs own timeout — T7 concern)
Task 5: complete (commits af083af..8900e7f, review clean after 1 fix round)
Task 5b: fix round 1/5 (4 addressed — hidden-input shadow removed + FormData.get-first regression tests, single message slot, SqliteError code mapping, td flex wrapper; commits b70d408..d5fabdf)
Task 5b: minor (deferred): types.ts:78 comment could note leftJoin escape-route for the drizzle qualifier trap
Task 5b: complete (commits 8900e7f..d5fabdf, review clean after 1 fix round)
Task 6: fix round 1/5 (7 addressed — control-char scrub via hex compare [byte-clean verified], structural SQLITE_ERROR net, deferred post-tx effects, size re-check, filename sanitise, test drain, cap doc; commits 78672a4..482b2c8)
Task 6: minor (deferred): resetReceiptForReOcr returns true even when job already in flight — caller can't distinguish 'already running' (M6)
Task 6: complete (commits d5fabdf..482b2c8, review clean after 1 fix round)
Note: raw control chars / backslash-u escapes get mangled in SendMessage transit AND in some Edit calls — spell character ranges in words or hex integers when dispatching.
Task 7: fix round 1/5 (5 addressed — isOcrJobClaimed assertion probe-verified, honest 50MB pre-check message, blank-filename fallback, boundary+inline-branch tests, INLINE_MIMES allowlist; commits 0abcebf..679834a)
Task 7: minor (deferred): chunked-transfer skips content-length pre-check (matches accepted import-route pattern); malformed multipart → 500; partial staging on fs throw (24h sweep is the net); prepared[] element typing
Task 7: complete (commits 482b2c8..679834a, review clean after 1 fix round)
Task 8: fix round 1/5 (7 addressed — CROSS_ORIGIN_ERROR moved to csrf.ts + build verified, written error messages + FK mapping, namespace-exhaustive gate test, staged cap, try/failure on all actions, household-shared pin test, STAGING_ID_RE import; commits 68e5188..a2bfee3)
Task 8: minor (deferred): reRunOcrAction ignores reset boolean (M6 lineage); attach revalidates before failure return (cosmetic)
Task 8: complete (commits 679834a..a2bfee3, review clean after 1 fix round)
Task 9: fix round 1/5 (11 addressed — FileList snapshot [CRITICAL: image receipts silently dropped], poll try/catch, non-ok poll failure surface, filesRef cleanup, LinkSubmitButton busy states, touchedRef, attach reset, pagination links, slot isolation, preselect test, statusLabel filter; commits 2ea8b3c..0ba964e)
Task 9: minor (deferred): shared notice is last-writer-wins across files (M7); timers array unpruned (M8); suggestion may overwrite prior suggestion in untouched field (M9, defensible per MUST-10.3); dead hidden staged input in EditForm (M11)
Task 9: complete (commits a2bfee3..0ba964e, review clean after 1 fix round)
Task 10: fix round 1/5 (1 addressed — subscription widget rows show 'Cancel by <date>' per MUST-19.10/19.13; commits ce8007c..c713d3d)
Task 10: complete (commits 0ba964e..c713d3d, review clean after 1 fix round)
Task 11: fix round 1/5 (8 addressed — README restore procedure, atomic .partial writes, aged -archive dir purge, restore SQLite preflight, tar-slip vector tests, one-way sentence, type-paired allow-list, spec §12.4 amendment; commits 6b3c352..984bc59)
Task 11: minor (deferred): restore rename-vs-copy I/O (M6); stray runNightlyBackup call in one test (M7); exit codes unpinned (M8)
Task 11: Ruling: spec §12.4/§2 amended to name scripts/restore-backup.ts (standalone image ships no src/) — plan self-review resolution formalized. Cost if wrong: doc-only.
Task 11: complete (commits c713d3d..984bc59, review clean after 1 fix round)
Task 12: review Approved with 1 Important (INSTALL.md duplicate encryption warning) — fix round 1 dispatched
Task 12: fix round 1/5 (1 addressed — INSTALL.md warning consolidated; commits 5179749..f42270d)
Task 12: complete (commits 984bc59..f42270d, review clean after 1 fix round)
ALL 13 TASKS COMPLETE. Final whole-branch review next: range 7b0b29e..f42270d (all code + spec amendments; excludes plan/spec-v1.0 doc commits).

## FINAL REVIEW (Opus, whole branch 7b0b29e..f42270d): 3 cross-task blockers found — all fixed in one wave (69476ff) + wave-breakage micro-fix (30f7fc0):
- CRITICAL: orphan sweep would delete ALL receipts 24h after a v1.0.0 DB-only restore (Task 3 sweep × Task 11 restore — cross-task seam). Fixed both halves: restore re-arms mtimes; sweep refuses empty-known+populated-dir.
- IMPORTANT: SIGKILL'd nightly leaks .partial archives forever — pruneBackups now purges aged partials.
- IMPORTANT: backup failure disabled maintenance sweep permanently — nightly job now isolates backup step, sweep always runs.
- Riders: pdfjs verbosity, spec §10.4 amendment, CROSS_ORIGIN_ERROR dedup (item-types), tessdata_fast recorded (§17.28 + §7.7 fix).
- Wave breakage fixed: unguarded utimesSync (DR CLI false-failure), shadowed adoption-mtime test, spec MUST-4.9 sentence, report count.
- Re-review verdict: SHIP. All 7 invariants held (origin-first, session auth, client-graph, untrusted text, integer cents, no egress, frozen migrations/dedup).
- Deferred minors triaged by final reviewer: ALL deferred (incl. pdfjs verbosity [fixed anyway as rider], CURRENCY_RE zero-pad [confirmed deferrable — user-confirmed suggestion only]). Noted: 9 other action files still declare local CROSS_ORIGIN_ERROR literals (pre-existing v1.0.0 pattern, not this feature's).
- Controller verification: typecheck clean + 1431/1431 green under bash (PowerShell run false-failed 30 install tests — bash absent from that PATH only).
COMPLETE: v1.1.0 ready. 30 commits 7b0b29e..30f7fc0.
