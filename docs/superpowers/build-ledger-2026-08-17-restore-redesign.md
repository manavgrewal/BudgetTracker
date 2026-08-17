# SDD ledger — plan: .superpowers/sdd/gui-restore/task-brief.md + task-brief-2.md (spec §20, GUI restore v1.2.0)

User approved GUI restore 2026-08-16 ("ok makes sense"). Spec §20 committed (42 MUSTs). 2 tasks: (1) core mechanism, (2) UI + release v1.2.0.
Ruling: v1.2.0 not v1.1.1 (new feature = minor bump). Cost if wrong: cosmetic.
Ruling: spec author's 13 design decisions accepted wholesale (shared restore-core.ts module, prepareRestore/commitRestore split proving CLI tests pass unedited, rename-journal crash safety with forward completion, EX_TEMPFAIL 75 exit, one-way guard via migration count+timestamp, 30-day pre-restore sweep, §12.2 stale claim amended). Recorded in spec §17.33-46. Cost if wrong: each individually revisable.
Task 1 (restore core): complete pending report edit (commits 25ac586..c14c792, 3 fix rounds + report-integrity edit).
- Round 1: C1 per-step replay rule + boot-never-reaches-getDb (exit 75), C2 commit.json zod+path confinement, I3 CLI --allow-newer (Ruling: guard bypassable on CLI disaster path only), I4 existsSync recovery text, I5 written errors, I6 fsync.
- Round 2: D1 WAL-sidecar cleanup on incoming replay (reviewer proved impostor-WAL silent-replacement empirically), D2 recovery trio, D3 bounded restart (Ruling: accepted residual — read-only/full volume = designed boot loop, fail-stop over fail-corrupt).
- Round 3: recovery text preserves orphaned safety-copy WAL when dbTarget absent (regression from D2 fix).
- Ruling (parked): countMissingReceiptRows-throw-on-final-attempt mislabels restored db as impostor in recovery text — recoverable (file preserved, no sidecars to rm, rerun restore), pre-existing, documented in task report. Cost if wrong: operator confusion in an already-rare terminal state.
- Ruling: report-integrity edit (stale self-claim) done without a further re-review round — gitignored workspace artifact, no code delta.
NOTE: commits e778f8e..c14c792 went public early (rode two Synology-installer hotfix pushes user needed mid-install). Accepted: tests green throughout, no UI exposes staged restores yet.
Next: Task 2 (restore UI + release) — folds in the user-requested full visual redesign (modern fintech, light+dark) as its own task before release packaging.
Task 2 (restore UI): complete (commits c14c792..f4c43a0, 1 fix round — restore-error visibility, single audit line, confirm copy). A8/A9 manual Docker checks outstanding (user's real NAS is the test bed).
Design round (user-requested 2026-08-17): "UI looks beginner-made" — full visual redesign approved. User choices: modern fintech style, light+dark following device + manual toggle. Split: D1 design system + shell + auth/dashboard; D2 remaining pages. frontend-design skill (plugin cache d06d3ed49ff7) drives it. Release task last (v1.2.0).

## FINAL REVIEW v1.2.0 (Opus, 1d0fcd1..7b0e8fe): FIX FIRST — 3 Important cross-task + 6 minors. Fix wave f104370:
- SECURITY (blocking, was MY mid-install hotfix): chmod 777 on data dir made ${DATA_DIR} an unauthenticated restore-injection channel (staged dir applied at boot, admin gate only guards the GUI staging path) → 770. Ruling: my hotfix, my defect — logged plainly.
- INSTALL-SYNOLOGY.md no-SSH path still prescribed the failed ACL remedy + 3 /volume1 hardcodes → fixed.
- CHANGELOG: ### Security group added (MUST-20.40), Verify-note repositioned for About renderer.
- synology-compose.yml migration sentence for existing absolute-path users.
Parked for next release (final reviewer triage, all deferred): raw zlib error in confirm panel (boot path safe); stale refusal leaks into other row's panel; MUST-20.42 Dockerfile scripts/tar pin test absent; restore signs admin out unwarned (+ --allow-newer absent from README); D3 boot-loop INSTALL troubleshooting line; ~600MB restore headroom doc; reports em-dash-for-zero (accepted); D1's CalloutLink role parity; transactions 1280px wrap.
Design round: D1 approved zero fixes (reviewer recomputed contrast + traced nonce chain); D2 approved (em-dash ruling: accepted — fintech convention, disclosed).
Ruling: fix-wave commit made by controller (implementer balked on stale memory pause); wave was fully reviewed content, commit = bookkeeping.
Controller verification: typecheck clean, 1536/1536 green (own run). SHIP.
v1.2.0 COMPLETE: 14 commits 1d0fcd1..f104370.
