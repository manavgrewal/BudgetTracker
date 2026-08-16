# Post-release polish batch — report

Date: 2026-08-16
Scope: Item 1 (forced password change on first login) + Item 2 (14 approved polish items).
No git commits were made.

## Verification

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run` | **77 files, 982 tests, 0 failures** (935 before → +47) |
| `npm run build` | succeeds; `/change-password` appears in the route table |

**No pre-existing test needed changing.** Every one of the 935 tests that was green before is
still green, unmodified. All 47 new tests are additions.

One environment note: `tests/ops/install.test.ts` (78 tests) fails when the runner cannot spawn
`bash` — `spawnSync('bash', …)` returns `status: null`. That is a PATH artifact of the shell the
suite is launched from, not a code change; running the suite from a shell with Git Bash on PATH
passes all 78. The numbers above are from that shell.

---

## Item 1 — Forced password change on first login

Owner decision, supersedes ruling R29. Spec revision **v1.5**.

### Migration (#2 under the hand-maintained regime)

- `drizzle/0001_add_must_change_password.sql` — a single `ALTER TABLE users ADD
  must_change_password integer DEFAULT 0 NOT NULL`, with a header pointing at the same
  hand-maintained warning that `0000_init.sql` and `drizzle.config.ts` carry.
- `drizzle/meta/_journal.json` — one appended entry matching the existing shape exactly:
  `idx: 1`, `version: "6"`, `tag: "0001_add_must_change_password"`, `breakpoints: true`, and
  `when: 1755302400000`. The existing `when` (1755216000000) is exactly midnight UTC; the new one
  is exactly midnight UTC one day later, keeping the fixed-timestamp convention and the ordering.
- `src/db/schema.ts` — `mustChangePassword` mirrored on `users`, declared **last** because
  `ALTER TABLE ADD COLUMN` appends physically, so the mirror reads in the same order as
  `pragma table_info(users)`.
- `drizzle-kit` was **not** run. No snapshot exists, so generating would have re-emitted the whole
  schema; the SQL is hand-authored as the regime requires.

Tests (`tests/db/schema.test.ts`, 3 new):
- a fresh database records **2** migrations and gets the column with the right type/notnull/default;
- existing and new rows default to `0` (nobody is retroactively gated);
- reopening an already-migrated file leaves the count at 2 and the column present exactly once —
  a re-run would throw `duplicate column name`.
The pre-existing idempotency test is untouched and still passes.

### Setting the flag

| Path | Flag | Why |
| --- | --- | --- |
| Admin user manager `createUserAction` | **set** | the admin typed the password |
| Admin `resetPasswordAction` | **set** | same |
| Setup-wizard admin (`createFirstAdmin`) | not set | they chose it themselves |
| Self-service change (Settings → Profile) | untouched | not an admin-issued secret |

`createUser` takes `mustChangePassword?: boolean` as an explicit argument, deliberately **not**
part of `createUserSchema` — it is never read from a form field. `setUserPassword` writes only the
hash and never moves the flag; each of the three callers states its own answer.

### Enforcement

- `src/app/(app)/layout.tsx` gates: after `requireUser()`, a flagged user is redirected to
  `/change-password`. Every authenticated page lives under this layout.
- `/change-password` lives in the **(auth)** group, not (app) — the app layout is the thing that
  redirects there, so rendering under it would be an infinite bounce. Middleware still bounces a
  cookie-less visitor to `/login`, and `requireUser()` covers an expired session.
- The page itself redirects to `/dashboard` when the flag is clear, so it is harmless as a bookmark.
- Logout stays reachable: the interstitial renders a sibling (never nested) logout form.

**Decision — APIs are NOT gated, pages only.** Documented in the layout docblock and in spec §6.
The flag's threat model is "an admin knows this password", not "this session is compromised", so
it is a UX nudge, not a session invalidation. An admin who wants the session dead already has
Deactivate and Reset password, both of which destroy every session outright. Gating `/api/*` would
break the logout POST and every in-flight fetch while buying nothing against that threat.

### The change form

`src/app/(auth)/change-password/actions.ts`, house pattern throughout: `isSameOrigin` first →
`requireUser` → zod (`currentPassword` non-empty, `newPassword` through `passwordSchema`, so
`MIN_PASSWORD_LENGTH` is enforced by the same rule as everywhere else). It verifies the current
password, refuses a no-op "change" to the same password, writes the new hash, clears the flag,
destroys the user's **other** sessions via a new `destroyOtherSessionsForUser(userId, keepToken)`
in `session.ts`, and redirects to `/dashboard`. Keeping the current session is deliberate — signing
out the browser mid-flow would bounce the user straight back to `/login`.

Tests: `tests/app/change-password.test.ts` (11) and `tests/app/users-actions.test.ts` (5), plus 5 in
`tests/lib/auth/users.test.ts`. They cover: flag set on admin create and admin reset; not set by the
setup admin, not moved by `setUserPassword`; layout gate redirects a flagged user and lets an
unflagged one through (and still sends a signed-out visitor to `/login`, not the interstitial);
cross-origin rejection; wrong current password; too-short new password; same-password refusal;
success clears the flag and stores a verifiable new hash; other sessions die, the current one
survives, and other users' sessions are untouched.

### Docs

- `README.md` first-run section and `INSTALL.md` step 4 rewritten.
- Spec §3 `users` gains the column and the "must" wording; §6 gains the forced-change bullet
  including the API-gating rationale; revision history gains **v1.5**.

### One deviation worth naming

`change-password-form.tsx` receives `minLength` as a **prop** instead of importing
`MIN_PASSWORD_LENGTH`. That constant lives in `@/lib/auth/password`, which also pulls in argon2 —
importing it from a client component drags `node:crypto` into the browser bundle and the build
fails outright. The server page reads the real constant and passes the number down, so there is
still one source of truth.

---

## Item 2 — Polish batch (all 14)

**1. CSV formula-injection guard.** `csvCell` (`src/lib/reports.ts`) now prefixes `'` when a field
starts with `=`, `+`, `-`, `@` or tab; RFC 4180 quoting runs afterwards, unchanged.

> **Deviation, called out deliberately.** A literal reading breaks the export. Spend is stored
> negative, so the Amount column is full of `-45.00`; prefixing those makes them *text* in Excel and
> every sum in the sheet stops working — the one thing people export a CSV to do. The guard
> therefore exempts plain numeric literals (`/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/`). Anything
> with an operator in it, e.g. `-2+3`, still fails that test and is still guarded.

Tests: all five triggers, quoting-on-top-of-guard, the numeric exemption, and the requested
`=SUM(1)`-in-a-note case asserting the note is guarded *and* `-45.00` is not.

**2. LIKE escaping.** `src/lib/transactions.ts` escapes `\`, `%` and `_` in the needle (escape char
first) and every clause now carries an explicit `ESCAPE '\'`. Tests: `"50%"` matches only the
literal row and not `5000`; `"FEE_"` matches only the underscore row; a literal backslash search
works.

**3. `copyBudgetsFromPreviousMonth` includes archived categories.** Now iterates
`listCategories({ includeArchived: true })`, consistent with `budgetProgress` surfacing archived
spend. Rows with no resolved limit are skipped anyway, so only real limits move. Test added.

**4. `createManualTransaction` runs the engine even with a category.** `runEngine([id])` now runs
**before** `confirmCategory`, while the row is still uncategorized so the engine's eligibility
filter (`category_id IS NULL OR source = 'bayes'`) lets it through. `confirmCategory` then overwrites
whatever the engine guessed with the user's explicit choice and never touches `is_transfer` or the
display columns. Verified `runEngine`'s scope already respects `source='manual'`, so nothing can
override a manual category. Tests: manual `"TD VISA PAYMENT"` with a category gets `is_transfer=1`
while keeping `category_id` and `source='manual'`; rename rules also apply now.

**5. Other members' personal budget sections are read-only for non-admins.** `BudgetsClient` takes
`currentUserIsAdmin` and drops the limit inputs and the copy button where `setLimitAction` /
`copyPreviousMonthAction` would refuse the write anyway; the amount still renders, since the
household sees everything by design. Household rows stay editable for everyone. 3 render tests.

**6. Goals "Show archived" toggle + Restore.** `/goals?archived=1` (a link, not client state —
archiving reloads via `revalidatePath`, so a `useState` toggle would reset itself). Archived cards
show an "Archived" label and a Restore button submitting `archived=0`, which reaches the
already-existing `archiveGoal(id, false)`. 4 render tests.

**7. Single shared banner on Budgets.** One banner slot showing only the most recent submission,
tracked by which action last dispatched. The two server actions are unchanged (so the existing
client test's module mock still holds); what changed is that a stale success can no longer sit next
to a fresh error.

**8. Busy guards.** The import **Undo** button is now `disabled` while its two-request sequence
runs, released in a `finally`. The **wizard upload** uses the house `SubmitButton`
(`useFormStatus`) rather than a local flag —

> **Finding worth recording:** a local `busy` flag set inside an async *form action* does not
> render until that action settles (React 19 holds state updates made inside an async transition).
> A first attempt with `setBusy(true)` provably did not disable the button. `useFormStatus` reads
> the form's real pending state and works. The same latent limitation applies to the pre-existing
> `busy` flags on the Import page's **Preview** and **Import** buttons, which are driven the same
> way — **not changed**, as they are outside the 14 approved items, but they are decorative today
> and would want the same `SubmitButton` treatment.

Tests: both guards, asserting disabled while in flight and released afterwards.

**9. Preview reports skipped rows.** `preview.skipped` is rendered in the preview header when > 0
("N skipped by profile rules"). Previously a mis-typed skip rule that swallowed half the file looked
exactly like a short file. 2 tests (shown when > 0, absent at 0).

**10. `reset-admin-password.ts` opens with `fileMustExist: true`.** better-sqlite3 creates a missing
file by default, so a typo in `DATA_DIR` silently produced an empty database and the misleading
"No user named alice. Known users: (none)" — plus a stray `budget.db`. Now a friendly error naming
the path and the two env vars. 2 tests, including "does not create the file".

**11. `REVIEW_WHERE` exported from `engine.ts`.** `listReviewQueue` imports it; the duplicated
predicate in `transactions.ts` is deleted. The three consumers (`listReviewQueue`, `reviewQueueIds`,
`reviewQueueCount`) now share one definition. Covered by the existing review-queue tests.

**12. `resetMfaAction` destroys the target's sessions.** Mirrors `resetPasswordAction`: a live
session on a lost phone must not outlive the MFA it was granted under. 3 tests (sessions die, other
users untouched, and clearing MFA does not raise the password flag).

**13. Dead-code sweep — removed, zero references remaining (grep-verified):**
- `countActiveSessions` (`session.ts`) — also dropped the now-unused `sql` import.
- `buildSessionCookieHeader` (`cookie-header.ts`) — the cleared variant is kept and now carries a
  note explaining why only it exists.
- `resolveBudget`'s dead `effectiveMonth` select.
- the redundant `?? new Date()` in `ratelimit.ts`'s `nowIso(input.at)` call (`nowIso` already
  defaults).
- `remainingRecoveryCodes` (settings actions) — an unused `'use server'` RPC export, i.e. a
  needlessly exposed endpoint; its now-unused `countUnusedRecoveryCodes` import went with it (the
  function itself is still used by `settings/page.tsx`).
- also removed: the `like` import in `transactions.ts`, unused after item 2.

**14. Stale comments.**
- `dedup.ts` `CHUNK = 400`: the comment claimed a 999 limit. Corrected — `SQLITE_MAX_VARIABLE_NUMBER`
  is 32766 in the builds better-sqlite3 ships (999 applied before SQLite 3.32). Value kept at 400;
  the comment now says the point is a predictable statement size, not the exact ceiling.
  `engine.ts`'s `ID_CHUNK` comment repeated the same 999 claim and now points at the dedup note.
- TD chequing/visa: **there was no such comment in `presets.ts`.** The deferred minor in the build
  ledger reads "TD chequing/visa mappings byte-identical **uncommented**" — the two presets have
  since diverged (chequing is fixture-validated ISO-dated, Visa is `MM/DD/YYYY`), so there was
  nothing stale to correct. Closed the underlying minor instead: a comment now records that the
  divergence is real rather than a copy-paste slip, and that everything else genuinely does match.

---

## Files touched

Source: `src/db/schema.ts`, `src/lib/auth/{users,session,cookie-header,ratelimit}.ts`,
`src/lib/{transactions,budgets,reports}.ts`, `src/lib/categorize/engine.ts`,
`src/lib/import/{dedup,presets}.ts`, `src/app/(app)/layout.tsx`,
`src/app/(app)/settings/{actions.ts,users/actions.ts}`,
`src/app/(app)/budgets/{page.tsx,budgets-client.tsx}`,
`src/app/(app)/goals/{page.tsx,goals-client.tsx}`,
`src/app/(app)/import/import-client.tsx`, `src/app/(app)/import/wizard/wizard-client.tsx`,
`scripts/reset-admin-password.ts`.

New: `drizzle/0001_add_must_change_password.sql`,
`src/app/(auth)/change-password/{page.tsx,actions.ts,change-password-form.tsx}`,
`tests/app/{change-password,users-actions}.test.ts`,
`tests/app/{goals-client,wizard-client}.test.tsx`.

Tests extended: `tests/db/schema.test.ts`, `tests/lib/auth/users.test.ts`,
`tests/lib/{transactions,budgets,reports}.test.ts`, `tests/scripts/reset-admin-password.test.ts`,
`tests/app/{budgets-client,import-client}.test.tsx`.

Docs: `README.md`, `INSTALL.md`, `docs/superpowers/specs/2026-08-15-budget-tracker-design.md`,
`drizzle/meta/_journal.json`.

---

# Addendum — three follow-up items (owner-approved mid-review)

Date: 2026-08-16. Built on top of the diff above; no commits.

## Verification (whole repo, after all six items)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run` | **79 files, 1006 tests, 0 failures** (982 → +24) |
| `npm run build` | succeeds |

Still zero pre-existing tests rewritten. Three existing tests were *extended* with new
assertions rather than changed: `tests/api/health.route.test.ts` (the response gained a field),
`tests/ops/docker.test.ts` (the Dockerfile gained a COPY), `tests/ops/install.test.ts` (INSTALL.md
gained a section, and update.sh's version print is now pinned). No existing assertion was
weakened or deleted.

---

## 1. App versioning + in-app revision log

**`package.json` version** was already `"1.0.0"`; left as the single source of truth.

**`src/lib/version.ts`** exports `APP_VERSION` via a **build-time JSON import**
(`import packageJson from '../../package.json'`), not a runtime file read. Verified in the built
output: `.next/server/app/api/health/route.js` contains the inlined literal `let d="1.0.0"` and
no `package.json` read at all. This matters because the standalone runtime's working directory is
not the project root — a `readFileSync` would either miss, or find *Next's own* generated
standalone `package.json`. A test asserts the module imports the JSON and never touches `fs`.

**`CHANGELOG.md`** — Keep a Changelog 1.1.0, SemVer. Top-of-file HTML comment states the rule:
every update session bumps `package.json` **and** moves the Unreleased notes into a dated section,
noting that update.sh/ps1, About and `/api/health` all surface the number, so a bump with no entry
is visible as a gap. Contains a `1.0.0 — 2026-08-16` entry covering the release (CSV import with
the four Canadian presets, learning categorizer, budgets, goals, TOTP auth, backups, sharing
packs, SimpleFIN, installers) and an `Unreleased` section.

> **Judgement call:** the brief said "an Unreleased section *template*". I filled it with the real
> contents of this polish batch rather than leaving a stub. The forced password change and the 14
> polish items are genuinely shipped-but-unreleased against 1.0.0, so an empty section would have
> made the changelog inaccurate on the day it was created. It still serves as the template — the
> group headings are the standard set and a test enforces that.

**`src/lib/changelog.ts`** reads the file at **runtime** (prose people reread; inlining kilobytes
into the bundle to save one read is the wrong trade) from `process.cwd()`, with a
`BUDGET_CHANGELOG_PATH` test override in the same spirit as `BUDGET_DB_PATH`. A missing file
returns `null` / `[]` — never a throw. The parser is ~60 lines, no new dependency: `## release`,
`### group`, `- item`, wrapped-bullet joining, HTML-comment skipping, and anything unrecognised
kept as a note rather than dropped.

**Settings → About** (`about-panel.tsx`, server component) renders the version plus the parsed
changelog as headings and lists. **Footer** on every `(app)` page shows `Budget Tracker vX.Y.Z`
linking to Settings. **`/api/health`** gains `version` on all three responses — including the two
503s, since "which build is broken?" is exactly the question being asked then, and it exposes
nothing the page footer does not already show to anyone who can reach the app.

**Dockerfile** copies `CHANGELOG.md` into the runner next to `drizzle/`, with a matching assertion
in `docker.test.ts`. (Next's tracing happened to include it in `.next/standalone` on this build,
but that is incidental — the explicit COPY is what makes it deterministic.)

**update.sh / update.ps1: verified, no change needed.** `app_version()` in update.sh runs
`sed -nE 's/.*"version"...` over package.json and takes the first match → `1.0.0`; update.ps1 uses
`(ConvertFrom-Json).version` → `1.0.0`. Both were executed directly to confirm. Added a test that
pins update.sh's printed version against the real `package.json` field, so a future field move
shows up as a failure instead of an update log reading "unknown".

Tests: `tests/lib/changelog.test.ts` (14) and `tests/app/about-panel.test.tsx` (5), plus the
health and docker/install additions.

## 2. INSTALL.md — "Keeping backups on a separate NAS"

New section after *Restoring from a backup*, plus a matching FAQ entry
("Can I keep the data on my other NAS / an NFS or SMB share?") that links back to it.

States the rule plainly rather than implying it: **the database must stay on local disk** — WAL
mode depends on shared memory and POSIX advisory locking that network filesystems implement
inconsistently, and the documented outcome is a corrupted database, not a slow one; called out as
a data-loss caveat, not a performance one, and extended to Synology remote shares, re-shared iSCSI
volumes and NFS-driver Docker volumes. **The backups directory is safe on a network mount**,
because `VACUUM INTO` writes a complete standalone file and closes it — nothing keeps it open.

Two patterns given: (A) a compose snippet with `./data:/data` *plus*
`/mnt/nas/budget-backups:/data/backups`, with the two things that actually bite — UID 1000 write
access (`uid=1000,gid=1000` for SMB, no `root_squash` for NFS) and the fact that an unreachable
NAS fails the backup silently, so check the page occasionally; (B) an rsync-cron alternative that
keeps a local copy too, with a note that rsync can never catch a half-written snapshot, and a
pointer to Synology Hyper Backup for client-side encryption (the backup files are unencrypted
SQLite databases). Restore is explicitly unchanged. Covered by an `install.test.ts` assertion.

## 3. Import page Preview/Import busy guards

Correcting my own earlier note: **only the Preview button was decorative.** The Import (commit)
button, `rePreview` and Undo are plain `onClick`/`onChange` handlers, where a local `busy` flag
does render immediately. Only Preview is a **form action**, and React 19 holds state updates made
inside an async action until it settles — so `setBusy(true)` at the top of `upload()` never
rendered.

- **Preview** now uses the house `SubmitButton` (`useFormStatus`), and the dead `setBusy` calls in
  `upload()` are gone with a comment explaining which mechanism applies where.
- **Import** and **rePreview** keep `busy`, but both are now wrapped in `try/finally`. They were
  not before: a thrown fetch — a connection dropped mid-import is the realistic case — left the
  button disabled forever, with rows possibly already committed and no way to find out from that
  screen.

Two tests: Preview disabled for the duration of an in-flight upload and released after; Import
disabled during commit and **released on failure**, with the error surfaced.

## Files touched in this addendum

New: `CHANGELOG.md`, `src/lib/version.ts`, `src/lib/changelog.ts`,
`src/app/(app)/settings/about-panel.tsx`, `tests/lib/changelog.test.ts`,
`tests/app/about-panel.test.tsx`.

Modified: `Dockerfile`, `INSTALL.md`, `src/app/(app)/layout.tsx`,
`src/app/(app)/settings/page.tsx`, `src/app/(app)/import/import-client.tsx`,
`src/app/api/health/route.ts`, `tests/api/health.route.test.ts`, `tests/ops/docker.test.ts`,
`tests/ops/install.test.ts`, `tests/app/import-client.test.tsx`.

Unchanged after verification: `package.json` (already 1.0.0), `install/update.sh`,
`install/update.ps1`.
