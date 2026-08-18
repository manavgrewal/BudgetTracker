# In-app updates and loan money-tracking — Design Spec (v1.3.1)

**Date:** 2026-08-17
**Status:** approved design. Ships as **v1.3.1**.
**Base specs:** `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (the master spec; §-references without a prefix are to it), `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md` (*warranty §n*) and `docs/superpowers/specs/2026-08-17-notifications-design.md` (*notify §n*).

Requirement labels (**MUST-n.m**) are binding and are written so that each one is testable.

This release carries **two features that share nothing but a version number**, plus a folded-in chore list:

1. **The update experience** — an opt-in update check against GitHub, semver-classified, with patch/minor auto-apply through Watchtower's HTTP API and an explicit review-and-confirm flow for majors.
2. **Loan money-tracking** — principal, rate, balance and payment linkage on loan-kind items in Contracts & Coverage, with a dashboard card and a debt-over-time report.

One base-spec decision is **reversed** here, deliberately and in the open: warranty §17 item 29 ("Loans are dates and documents only — no balance, no payment schedule, no interest math") is withdrawn by §12 below. Nothing else in any base spec is withdrawn. Interest **math** stays out of scope (§13.1) — the rate is a display-only field.

---

## 1. Overview

### 1.1 What an admin sees

Settings → About already renders the running version and the changelog timeline. It gains one card above the changelog: **Updates**. On a fresh install that card says the checks are off and offers a single button. Nothing else changes until somebody presses it.

Contracts & Coverage already tracks a loan as a start date, a term and a payoff date. A loan-kind item gains four money fields and a way to have the bank statement keep the balance honest, so "what do we still owe on the car" stops being a number somebody looks up on another website.

### 1.2 The dormancy rule, restated for a third feature

**MUST-1.1** Update checks are **dead until an admin enables them**. With `update.checks_enabled` absent or `'0'`, the app makes **zero** outbound connections on account of updates — no DNS lookup, no probe, no "is there a newer version" call at boot. This is the same structural stance notify §1.1 takes and the same one §12 (SimpleFIN) takes:

- The enable flag lives in the existing `settings` key/value table and is **absent** on every install, new or upgraded (§3.1). Nothing seeds it.
- `runUpdateTick()`'s **first** statement is the enable check (§5.2); when it is off the tick returns before touching any check, classifier, notifier or apply path.
- The only host the feature may ever contact is `api.github.com`, plus the Watchtower endpoint on the compose network, which is not the internet (§8).

**MUST-1.2** An install that never presses "Enable update checks" behaves, network-wise, exactly as v1.3.0 did.

**MUST-1.3** Loan money-tracking adds **no** outbound connection of any kind, ever. It is entirely local data.

### 1.3 Goals

- An update check a household can turn on in one click and forget, that never surprises them with a breaking change.
- Patch and minor releases applied unattended; a major release parked behind a screen that shows the actual changelog of the version being offered.
- A loan whose balance goes down on its own when the payment lands in the bank export, and which can also be corrected by hand at any time.
- A debt line the household can look at once a quarter.

### 1.4 Non-goals for v1.3.1

Amortization schedules, interest accrual, payoff projections, extra-payment what-ifs, loan amortisation tables, multi-currency, per-loan lenders as first-class entities, rollback of an applied update from inside the app, update channels/betas, delta updates, and update checking on any host but `api.github.com`. All are listed in §23.

---

## 2. Architecture delta

| Concern | Decision |
|---|---|
| New library dir | `src/lib/update/` (**new**) — layout in §2.1 |
| New library file | `src/lib/loans.ts` (**new**) — the loan read model, matcher and reversal (§13) |
| New migration | `drizzle/0007_loans.sql` (**new**), journal idx **7**, `when` **1755820800000**. **The update feature needs no migration at all** (MUST-3.1) |
| New page | **none.** Updates extend `src/app/(app)/settings/about-panel.tsx`; loans extend the existing Contracts & Coverage, transactions, dashboard and reports pages |
| New route handlers | **none.** Every mutation is a server action |
| New runtime dep | **none.** GitHub and Watchtower are one `fetch` each; the debt chart reuses the existing `recharts` dependency |
| New notification event | one — `update_available` (§6). Proves notify MUST-4.4: no migration, no `src/db/schema.ts` change, no UI change |
| New env vars | `WATCHTOWER_URL`, `WATCHTOWER_TOKEN` — both optional, both absent on a build-from-source install (§7.4) |
| Scheduler | `runUpdateTick()` runs on the existing `NOTIFY_TICK_CRON` callback, **before** `runNotifyTick()`, with its own independent dormancy check (§5.2) |
| Docker | **no image change.** `install/synology-compose-pull.yml` changes (§16); `Dockerfile` gains one linter directive (§17.2) |
| CSP / security headers | **no change.** All egress is server-side `fetch`; the browser never talks to GitHub or Watchtower |

### 2.1 `src/lib/update/` layout (all files new)

```
src/lib/update/
  semver.ts       parseSemver / compareSemver / classify — PURE  (§4.3)
  egress.ts       GITHUB_API_ORIGIN + assertGithubUrl + assertWatchtowerUrl — PURE  (§8)
  github.ts       fetchLatestRelease() + fetchRemoteChangelog()  (§4.2)
  watchtower.ts   watchtowerConfig() + triggerUpdate()  (§7)
  state.ts        the settings-table reads and writes  (§3)
  ratelimit.ts    in-memory Check-now and Apply buckets  (§10.3)
  check.ts        runUpdateCheck(now) — the orchestrator  (§5)
```

**MUST-2.1** `src/lib/update/semver.ts` and `src/lib/update/egress.ts` are **pure**: no `@/db` import, no `@/lib/env` import, no node builtin. They are the update feature's counterpart to notify MUST-2.1, and `semver.ts` in particular is imported by the About client to render a severity badge, so the Ruling P4 client-bundle constraint applies to it exactly as it does to `src/lib/warranty/constants.ts`.

**MUST-2.2** `src/lib/update/github.ts`, `watchtower.ts`, `state.ts` and `check.ts` are server-only and are never imported, directly or transitively, from a `*-client.tsx` file. Only `import type` is permitted there.

**MUST-2.3** `src/lib/update/egress.ts` holds the **only** `://` string literal anywhere under `src/lib/update/`, mirroring the rule `src/lib/notify/egress.ts` already lives under. The Watchtower URL is **not** a literal anywhere in the tree: it arrives from `WATCHTOWER_URL` (§7.2) and its default value is written once, in YAML, in `install/synology-compose-pull.yml`.

### 2.2 Files modified (exhaustive)

| File | Change | Feature |
|---|---|---|
| `src/lib/env.ts` | `AppEnv` gains `watchtowerUrl: string \| null` and `watchtowerToken: string \| null` (§7.2) | update |
| `src/lib/scheduler.ts` | the notify cron callback and the boot call each gain a leading `runUpdateTick()`; new export `runUpdateTick` | update |
| `src/lib/notify/events.ts` | one appended `NOTIFICATION_EVENTS` entry + one `updateAvailableKey()` builder (§6) | update |
| `src/lib/notify/render.ts` | one `RenderInput` union member + one `case` (§6.2) | update |
| `src/app/(app)/settings/about-panel.tsx` | the Updates card, above the changelog timeline (§9) | update |
| `src/app/(app)/settings/actions.ts` | six new update server actions (§10) | update |
| `src/components/icons.tsx` | `UpdateIcon`, `LoanIcon` | both |
| `src/db/schema.ts` | five appended `warrantyItems` columns; two new table mirrors (§11.6) | loans |
| `src/lib/warranty/constants.ts` | `billingAllowedForKind` widened; the billing wording matrix (§12) | loans |
| `src/lib/warranty/items.ts` | `WarrantyItemRow` / `WarrantyInput` / `warrantyInputSchema` / the two writers gain the loan fields (§11.4) | loans |
| `src/lib/warranty/types.ts` | `setItemTypeKind`'s clearing pass covers the loan fields and the item's matcher rules (§12.3) | loans |
| `src/lib/warranty/search.ts` | `RawRow` / `toListItem` / the `select` gain the loan columns | loans |
| `src/instrumentation-node.ts` | one guarded `reconcileApplyOnBoot()` call, after `getDb()` and before `startScheduler()` (§7.3) | update |
| `src/lib/import/commit.ts` | `undoImport`'s reversal call and `UndoResult.loanLinksReversed` (§13.6) | loans |
| `src/lib/import/flow.ts` | one `applyLoanMatchers()` call after `runEngine` | loans |
| `src/lib/simplefin/sync.ts` | the same call after its `runEngine` | loans |
| `src/lib/transactions.ts` | one call at the end of `createManualTransaction` | loans |
| `src/lib/categorize/engine.ts` | one call at the end of `confirmCategory`, on **every** path (§13.4) | loans |
| `src/app/(app)/warranties/*` | the loan money fieldset and the matcher-rule editor (§14) | loans |
| `src/app/(app)/warranties/actions.ts` | loan field readers; three matcher-rule actions (§14.4) | loans |
| `src/app/(app)/transactions/transactions-client.tsx` + `actions.ts` | the "Assign to loan" row control and two actions (§14.3) | loans |
| `src/app/(app)/dashboard/page.tsx` | one `<LoansCard />` (§15.1) | loans |
| `src/app/(app)/reports/page.tsx` + `reports-client.tsx` | the debt-over-time card (§15.2) | loans |
| `src/components/LoansCard.tsx`, `src/components/LoanProgressBar.tsx`, `src/components/charts/DebtTrendChart.tsx` | **new** | loans |
| `install/synology-compose-pull.yml` | Watchtower switched to HTTP-API mode; app service gains two env vars; header rewritten (§16.1) | update |
| `.github/workflows/release-image.yml` | `checkout@v4`→`@v5`, `setup-node@v4`→`@v5` (§17.1) | chore |
| `Dockerfile` | one `# check=skip=SecretsUsedInArgOrEnv` directive (§17.2) | chore |
| `install/update.sh`, `install/update.ps1` | the "no in-app banner" copy amended (§16.3) | update |
| `package.json` | `version` → `1.3.1` | both |
| `drizzle/meta/_journal.json` | idx 7 entry | loans |
| `CHANGELOG.md`, `README.md`, `INSTALL.md`, `docs/INSTALL-SYNOLOGY.md` | §18 | both |

The table is exhaustive for **source, ops and documentation** files. Test files are enumerated separately in §19, and the two amended ops tests (`tests/ops/notify-egress.test.ts`, `tests/ops/install.test.ts`) are specified in §8.4 and MUST-8.9 because their amendments are part of the egress argument rather than a consequence of it.

`src/components/app-shell/nav.ts` is **not** changed. Neither feature adds a route.

---

## 3. Update state — stored without a migration

### 3.1 The claim, and why it holds

**MUST-3.1** The update feature adds **no table, no column and no migration**. All of its state is key/value rows in the existing `settings` table, read and written through the existing `getSetting` / `setSetting` / `deleteSetting` helpers in `src/lib/settings.ts`. `drizzle/0007_loans.sql` is a **loans-only** migration; a test asserts it contains no string matching `/update/i` outside its header prose.

This is not a convenience. It is what makes MUST-1.1 structurally true rather than conventionally true: there is no column with a default, no seeded row, no `NOT NULL … DEFAULT 1` anywhere that could turn the feature on for somebody who never asked for it. Absence is the off state.

### 3.2 The keys

**MUST-3.2** `src/lib/update/state.ts` owns every one of these strings; no other module writes a `settings` key beginning `update.`.

| Key | Values | Written by |
|---|---|---|
| `update.checks_enabled` | `'1'` / `'0'`; **absent means off** | the enable/disable actions |
| `update.enabled_by` | user id, as a decimal string | the enable action |
| `update.enabled_at` | ISO datetime | the enable action |
| `update.auto_apply` | `'1'` / `'0'`; **absent means on** once checks are enabled (§5.3) | the auto-apply toggle |
| `update.last_checked_at` | ISO datetime — written on **every** attempt, success or failure (MUST-5.5) | `runUpdateCheck` |
| `update.last_check_error` | scrubbed one-line message; deleted on success | `runUpdateCheck` |
| `update.latest_version` | the last observed remote semver, e.g. `1.4.0`; deleted when the remote is not newer | `runUpdateCheck` |
| `update.latest_published_at` | ISO datetime from the release payload, when present | `runUpdateCheck` |
| `update.dismissed_version` | a version the admin pressed **Not now** on (§9.3) | the dismiss action |
| `update.apply_requested_version` | the version an apply was fired for | `applyUpdate` |
| `update.apply_requested_at` | ISO datetime, written **before** the Watchtower request (§7.3) | `applyUpdate` |
| `update.last_applied_at` | ISO datetime, written when an apply is confirmed | `applyUpdate` / the boot reconciler |
| `update.last_apply_error` | scrubbed one-line message; deleted on success | `applyUpdate` |

**MUST-3.3** `src/lib/update/state.ts` exports a single reader that returns the whole picture, so no caller assembles it from loose `getSetting` calls:

```ts
export interface UpdateState {
  enabled: boolean;
  enabledBy: number | null;
  enabledAt: string | null;
  autoApply: boolean;              // false when !enabled, regardless of the stored key
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  dismissedVersion: string | null;
  applyRequestedVersion: string | null;
  applyRequestedAt: string | null;
  lastAppliedAt: string | null;
  lastApplyError: string | null;
}

export function readUpdateState(): UpdateState;
export function isUpdateCheckEnabled(): boolean;   // one indexed settings read; the dormancy gate
export function setUpdateChecksEnabled(input: { enabled: boolean; userId: number; at?: Date }): void;
export function setAutoApply(enabled: boolean): void;
export function recordCheckOutcome(input: { at: Date; latestVersion?: string | null; publishedAt?: string | null; error?: string | null }): void;
export function recordApplyRequested(input: { version: string; at: Date }): void;
export function recordApplyOutcome(input: { at: Date; error?: string | null }): void;
export function dismissVersion(version: string): void;
export function clearUpdateState(): void;          // used by the disable action (MUST-3.4)
```

**MUST-3.4** Disabling update checks **deletes every `update.` key except `update.checks_enabled = '0'`**. Turning the feature off must leave no cached remote version to render, no stale error banner and no dismissed-version memory that would silently swallow the next notice if it were turned back on. Off means off, and re-enabling starts clean.

**MUST-3.5** `readUpdateState()` returns `autoApply: false` whenever `enabled` is false, regardless of what is stored, so no caller can reach an apply path through a stale key.

---

## 4. The update check

### 4.1 What is being asked

**MUST-4.1** The check compares `APP_VERSION` (from `src/lib/version.ts`, the existing build-time `package.json` import) with the latest published GitHub release of the public repository `VibeLogicCode/BudgetTracker`. No authentication token is ever sent. The repository is public; an unauthenticated `api.github.com` caller gets 60 requests per hour per source IP, and this feature's ceiling is one scheduled check per day plus a rate-limited button (§10.3), so the quota is never a design consideration.

### 4.2 `src/lib/update/github.ts`

```ts
export interface RemoteRelease {
  /** The release tag exactly as GitHub reports it, e.g. "v1.4.0". */
  tag: string;
  /** The tag with one optional leading "v" stripped, e.g. "1.4.0". */
  version: string;
  publishedAt: string | null;
}

export class UpdateCheckError extends Error {
  readonly permanent: boolean;
}

export function fetchLatestRelease(): Promise<RemoteRelease>;
export function fetchRemoteChangelog(version: string): Promise<string>;
```

**MUST-4.2** Exactly **two** endpoints are ever called, and they are the only two `fetch(` call sites under `src/lib/update/`:

1. `GET https://api.github.com/repos/VibeLogicCode/BudgetTracker/releases/latest`
2. `GET https://api.github.com/repos/VibeLogicCode/BudgetTracker/contents/CHANGELOG.md?ref=v<version>`

The second is pinned to the release's own tag rather than the default branch, so the changelog an admin reads on the confirm screen is the changelog **of the version being offered**, not whatever `main` happens to hold. `<version>` is the already-parsed semver from step 1, re-serialised from its integer components (`${major}.${minor}.${patch}`) rather than passed through from the response — a value that survived `parseSemver` cannot contain a path or query character.

**MUST-4.3** Both requests carry, and carry nothing else:

```
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
User-Agent: BudgetTracker/<APP_VERSION>
```

No `Authorization`. No cookie. No telemetry field. GitHub requires a `User-Agent`; ours names the product and its version and nothing about the install — not its hostname, not its data directory, not its user count. This is stated in the UI copy of §9.2 because "checks for updates" and "phones home" are different things and the page has to say which one this is.

**MUST-4.4** Both requests use `signal: AbortSignal.timeout(15_000)` and `redirect: 'error'`, exactly as notify MUST-9.3 requires of Telegram. A 3xx from `api.github.com` is a failure, not a hop.

**MUST-4.5** `assertGithubUrl()` (§8.2) is called on the URL immediately before each `fetch`.

**MUST-4.6 (response handling).** From endpoint 1 the only fields read are `tag_name` (string) and `published_at` (string or absent). `draft` and `prerelease` releases are refused by the endpoint itself (`/releases/latest` excludes both), and a `tag_name` that fails `parseSemver` (§4.3) raises a permanent `UpdateCheckError` with `That release tag is not a version this app can compare.` rather than being guessed at. From endpoint 2 the only fields read are `encoding` (must equal `'base64'`), `size` (must be ≤ `MAX_CHANGELOG_BYTES = 512 * 1024`) and `content`. A response failing either guard raises a permanent error; the confirm screen then renders §9.4's fallback sentence instead of a changelog.

**MUST-4.7 (error classification).** `UpdateCheckError.permanent` is `true` for HTTP 401/403/404/422 and for a malformed payload; `false` for 429, any 5xx, a DNS failure, a connect timeout and an abort. A transient failure writes `update.last_check_error` and is retried at the next daily tick; a permanent one does the same. There is no backoff ladder, because there is at most one automatic attempt per day already (MUST-5.5).

**MUST-4.8 (the remote changelog is untrusted text).** `fetchRemoteChangelog` returns a decoded UTF-8 string and nothing else. It is parsed by the **existing** `parseChangelog()` from `src/lib/changelog.ts` — a pure function over a string, already unit-tested — and rendered by the **existing** `renderEmphasis()` bold-run renderer in `about-panel.tsx`. Nothing about the remote path introduces a markdown library, and `dangerouslySetInnerHTML` appears nowhere. Before rendering, the parsed release is bounded: at most `MAX_CHANGELOG_GROUPS = 12` groups, `MAX_CHANGELOG_ITEMS = 200` items in total, each item truncated to 500 characters and each group title to 60, using the same `truncateText` discipline notify MUST-10.3 applies to merchant names. A repository is a place a person can write anything; the confirm screen treats it that way.

### 4.3 `src/lib/update/semver.ts` — PURE

```ts
export interface Semver { readonly major: number; readonly minor: number; readonly patch: number }
export type UpdateSeverity = 'none' | 'patch' | 'minor' | 'major';

/** Strict: one optional leading "v", then exactly three dot-separated runs of digits.
 *  No pre-release, no build metadata, no leading zeros beyond a bare "0". */
export function parseSemver(value: string): Semver | null;
export function compareSemver(a: Semver, b: Semver): number;
export function classify(current: Semver, remote: Semver): UpdateSeverity;
export function formatSemver(value: Semver): string;
```

**MUST-4.9** `classify` is total and is defined by exactly these four lines, in order:

1. `compareSemver(remote, current) <= 0` → `'none'`
2. `remote.major > current.major` → `'major'`
3. `remote.minor > current.minor` → `'minor'`
4. otherwise → `'patch'`

**MUST-4.10** `parseSemver` rejects anything with a pre-release or build suffix (`1.4.0-rc.1`, `1.4.0+build`). The repository has never published one, and a version this classifier cannot reason about must never reach an auto-apply decision. A rejected tag is a permanent check error (MUST-4.6), surfaced on the card, and **never** auto-applied.

**MUST-4.11** The severity is computed **in the app**, from the two version strings, never read from the release payload. GitHub has no concept of "is this breaking for you"; the release title, the label set and the body are all free text a maintainer can get wrong.

---

## 5. The check tick and the policy

### 5.1 `src/lib/update/check.ts`

```ts
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckResult {
  severity: UpdateSeverity;
  currentVersion: string;
  latestVersion: string | null;
  /** True when the app fired a Watchtower apply as part of this check. */
  applied: boolean;
  /** True when an `update_available` notification was enqueued. */
  notified: boolean;
  error: string | null;
}

export function runUpdateCheck(input: { now?: Date; manual?: boolean }): Promise<UpdateCheckResult>;
```

### 5.2 The tick, and why notify's dormancy bail is untouched

**MUST-5.1** `src/lib/scheduler.ts` gains:

```ts
export function runUpdateTick(now: Date = new Date()): void {
  // The dormancy gate is the tick's first statement: one indexed read of a settings key
  // that is ABSENT on every install nobody has enabled this on.
  if (!isUpdateCheckEnabled()) return;
  if (updateTicking) return;
  const state = readUpdateState();
  if (!dueForCheck(state.lastCheckedAt, now)) return;   // UPDATE_CHECK_INTERVAL_MS
  updateTicking = true;
  void runUpdateCheck({ now })
    .catch((error) => console.error('[update] check failed', error))
    .finally(() => { updateTicking = false; });
}
```

**MUST-5.2** `runUpdateTick()` is called from the **existing** `NOTIFY_TICK_CRON` task callback and from the existing boot call, in both cases **immediately before** `runNotifyTick()`:

```ts
notifyTask = cron.schedule(NOTIFY_TICK_CRON, () => { runUpdateTick(); runNotifyTick(); }, { timezone: tz });
...
runUpdateTick();
runNotifyTick();
```

No new cron expression, no new `ScheduledTask`, no new timezone plumbing.

**MUST-5.3 (notify MUST-6.4 is unchanged, verbatim).** The update tick is a **separate function with its own independent gate**, deliberately not folded into `runNotifyTick`'s dormancy bail. `if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;` remains literally the first statement after the single-flight guard in `runNotifyTick`, and `tests/lib/scheduler.test.ts`'s existing dormancy assertion is unamended. The consequence is the correct one: an install with update checks on and no notification channel still checks for updates, and an install with a notification channel and no update checks still makes no GitHub call.

**MUST-5.4** `runUpdateTick` has its own module-level `let updateTicking = false` single-flight guard, reset by `stopScheduler()` alongside `bootExpiryDone`.

**MUST-5.5 (one attempt per day, whatever happens).** `runUpdateCheck` writes `update.last_checked_at` on **every** attempt, before returning, whether the fetch succeeded or threw. `dueForCheck` compares against that stamp. A container in a crash-restart loop therefore makes at most one GitHub request per 24 hours, not one per boot, and a repeatedly failing check cannot become a retry storm.

**MUST-5.6** A **manual** check (`manual: true`, from the Check-now button) ignores `dueForCheck` — that is the entire point of the button — but is bounded by its own rate-limit bucket (§10.3) and still refreshes `update.last_checked_at`, so a manual check also resets the daily clock.

### 5.3 The policy

**MUST-5.7** After a successful check, exactly one of these five outcomes obtains, and `runUpdateCheck` returns which:

| Condition | Action |
|---|---|
| `severity === 'none'` | delete `update.latest_version` / `update.latest_published_at`; nothing else |
| `'patch'` or `'minor'`, `autoApply` on, Watchtower configured | fire the apply (§7.3). **No notification** — the container is about to be replaced and About will show the new version |
| `'patch'` or `'minor'`, `autoApply` **off** | enqueue `update_available` (§6); the card offers a manual **Update now** button |
| `'patch'` or `'minor'`, Watchtower **not** configured | enqueue `update_available`; the card shows §7.4's fallback copy |
| `'major'` | **never** auto-applies, under any setting. Enqueue `update_available`; the card shows **Review and update** (§9.3) |

**MUST-5.8** The major rule is unconditional and is expressed as a guard inside `runUpdateCheck` (`if (severity === 'major') autoApply = false;`) placed **before** the apply branch, not as a condition inside it. There is no setting, environment variable or query parameter that makes a major auto-apply. A major version is by definition the release where the maintainer is telling you something changed underneath you, and this app runs a household's financial records unattended on a NAS.

**MUST-5.9** `update.dismissed_version` suppresses only the **card's prominence** (§9.3), never the check itself and never the `update_available` dedup. Dismissing 1.4.0 and then having 1.5.0 published raises a new notice, because the dedup key is per version (§6.1).

---

## 6. The `update_available` event — the registry extension, proved

### 6.1 The registry entry

**MUST-6.1** `src/lib/notify/events.ts` gains exactly one appended entry and one appended key builder. Nothing else in that file changes:

```ts
  {
    id: 'update_available',
    label: 'An update is available',
    blurb: 'A newer version of Budget Tracker is published and is waiting for your say-so.',
    audience: 'admin',
    trigger: 'tick',
    defaultEnabled: true,
  },
```

```ts
/** Once per remote version, ever. Versions only ever go up, so this key never recurs. */
export function updateAvailableKey(version: string): string {
  return `update:${version}`;
}
```

`audience: 'admin'` because only an admin can act on it (§10.1). `defaultEnabled: true` under notify MUST-4.1's rule: this is the "a deadline is near / something needs attention" half, not the chatty half — and like every default it has no effect until a channel exists (notify MUST-4.2) **and** until update checks are enabled, which is a second, independent opt-in.

**MUST-6.2 (the no-migration claim, discharged in full).** Adding this event touches:

- `src/lib/notify/events.ts` — one array entry, one key builder;
- `src/lib/notify/render.ts` — one `RenderInput` union member, one `case`;
- `src/lib/update/check.ts` — one `enqueue()` + `kickOutbox()` call.

and **nothing else**. No migration. No `src/db/schema.ts` change. No change to `notification_prefs`, whose `event_id` deliberately carries no CHECK and no foreign key (notify MUST-3.6). No change to the settings UI, because the toggle matrix is generated from the registry (notify MUST-11.3). `tests/db/notification-schema.test.ts`'s existing "accepts an event_id that is not in the registry" assertion already proves the storage half; §19.4 adds the assertion that the rendered matrix gains a row for `update_available` with no component edit. This is the first real exercise of notify MUST-4.4 and it is treated as a claim to be discharged, not an assumption.

**MUST-6.3 (pruning safety, honestly stated).** Per notify MUST-3.12, every dedup key must be safe against the 400-day retention sweep. `update:<version>` is derived from a value that only ever increases — a version, once superseded, is never offered again, because `/releases/latest` reports exactly one version and the check only enqueues when `severity !== 'none'`. There is **one** residual case, and it is stated rather than papered over: an install that stays on 1.3.1 for more than 400 days while 1.4.0 remains the latest release will have its `update:1.4.0` row pruned and will be told once more, on the following check, that 1.4.0 is available. One reminder every 400 days about an update you have been ignoring for 400 days is correct behaviour, not a defect, and it is the only condition under which the key can regenerate.

### 6.2 Rendering

**MUST-6.4** `src/lib/notify/render.ts` gains one union member and one `case`. The `RenderInput` member:

```ts
  | {
      event: 'update_available';
      currentVersion: string;
      latestVersion: string;
      severity: 'patch' | 'minor' | 'major';
      publishedAt: string | null;
      canApplyInApp: boolean;
    }
```

Subject and body:

| Severity | Subject | Body |
|---|---|---|
| `major` | `Budget Tracker 1.4.0 is available (major update)` | `You are running 1.3.1. Version 1.4.0 is a major update, so this app will not install it on its own. Open Settings, read what changed, and press Review and update when you are ready.` |
| `patch` / `minor` | `Budget Tracker 1.4.0 is available` | `You are running 1.3.1. Version 1.4.0 is published.` + one of the two sentences below |

The second sentence is `Automatic updates are switched off, so open Settings and press Update now when you want it.` when `canApplyInApp` is true, and `This install cannot update itself — see Settings for how to update it by hand.` when it is false.

**MUST-6.5** No body carries a URL, per notify MUST-10.4. `publishedAt`, when present, is rendered with the app's one timestamp convention (`iso.slice(0, 16).replace('T', ' ')`, notify §11.4's amendment) and nothing else. Version strings are re-serialised from parsed integers (MUST-4.2), so nothing from the remote payload reaches a message body unparsed.

**MUST-6.6** `renderEvent`'s switch keeps its no-`default` shape: the declared return type means a union member with no matching `case` is a TS2366 compile error. That is the safety net, and it is why the union member and the case land in the same change.

---

## 7. Applying an update — Watchtower HTTP API

### 7.1 The mechanism

**MUST-7.1** The app never touches the Docker socket, never shells out, never writes a compose file and never restarts itself. It sends **one HTTP request** to the Watchtower companion container on the compose network, and Watchtower — which already holds the socket, already carries the label scope, and is already the thing that updates this app on a prebuilt-image install — does the rest.

`GET <WATCHTOWER_URL>` with header `Authorization: Bearer <WATCHTOWER_TOKEN>`. The method is `GET` because that is the shape Watchtower's own documentation specifies for `/v1/update` and the endpoint's contract is Watchtower's to define, not ours. Any 2xx is "accepted".

### 7.2 Configuration and `src/lib/update/watchtower.ts`

**MUST-7.2** `src/lib/env.ts`'s `AppEnv` gains two nullable fields, read the same way `TRUST_PROXY` is:

```ts
  watchtowerUrl: string | null;    // WATCHTOWER_URL, empty string treated as absent
  watchtowerToken: string | null;  // WATCHTOWER_TOKEN, empty string treated as absent
```

Neither is required. Neither has a default. `readEnv()` does **not** validate the URL — a malformed value must not stop the app booting; it is validated at the point of use by `assertWatchtowerUrl` (§8.3) and reported on the card.

```ts
// src/lib/update/watchtower.ts
export interface WatchtowerConfig { url: string; token: string }

/** null when either env var is absent, or when the URL fails assertWatchtowerUrl. */
export function watchtowerConfig(source?: Partial<NodeJS.ProcessEnv>): WatchtowerConfig | null;

export type TriggerOutcome = 'accepted' | 'accepted-unconfirmed';
export function triggerUpdate(config: WatchtowerConfig): Promise<TriggerOutcome>;
```

**MUST-7.3 (the token never reaches the browser).** No page prop, server-action return value, log line or error message carries `WATCHTOWER_TOKEN`. The About card receives `canApplyInApp: boolean` and nothing more. Every string written to `update.last_apply_error`, to `console.error`, or returned to the browser from the apply path passes through `scrubSecrets(text, [token])` — the existing helper from `src/lib/notify/crypto.ts`, reused rather than reimplemented. This matters for the same reason notify MUST-5.5 does: an `Authorization` header can end up quoted in a fetch error or a redirect message.

### 7.3 The apply, and the request that never gets an answer

**MUST-7.4** `applyUpdate` is ordered as follows, and the ordering is load-bearing:

1. `recordApplyRequested({ version, at })` — **written and committed before the fetch**, because the request that follows may kill this process.
2. `assertWatchtowerUrl(config.url)`.
3. `fetch(config.url, { method: 'GET', headers: { Authorization: 'Bearer …' }, redirect: 'error', signal: AbortSignal.timeout(30_000) })`.
4. On a 2xx: `recordApplyOutcome({ at })` → `'accepted'`.
5. On 401/403: `recordApplyOutcome({ at, error: 'Watchtower rejected the token. Check that WATCHTOWER_TOKEN matches WATCHTOWER_HTTP_API_TOKEN in your compose file.' })` and throw a permanent error.
6. On any other non-2xx: record the status line, scrubbed, and throw.
7. On an abort, a socket reset or `ECONNRESET` **after the request was written**: return `'accepted-unconfirmed'` and record no error.

**MUST-7.5 (why step 7 exists).** Watchtower's `/v1/update` handler performs the update and then responds. The container being replaced is this one. It is therefore entirely normal for the connection to die before a response arrives — the app has just asked something to kill it. Treating that as a failure would show a red error on the last screen a person sees before the app comes back healthy on the new version, which is the worst possible false negative. Step 7 returns `'accepted-unconfirmed'` and the UI says so plainly (§9.5).

**MUST-7.6 (the boot reconciler).** On boot, `src/lib/update/state.ts`'s `reconcileApplyOnBoot()` runs — called from `src/instrumentation-node.ts` immediately after `raiseRestoreOutcome()` (notify MUST-14.2's slot, so `getDb()` has run and `startScheduler()` has not), inside its own `try/catch`:

- if `update.apply_requested_version` is absent, return;
- if it equals `APP_VERSION`, the apply worked: write `update.last_applied_at`, delete `apply_requested_*`, delete `update.last_apply_error`, delete `update.latest_version`;
- if `update.apply_requested_at` is older than `APPLY_CONFIRM_MAX_AGE_MS = 30 * 60_000` and the version still does not match, the apply did not happen: delete `apply_requested_*` and write `update.last_apply_error = 'The update was requested but the app is still on <current>. Check the Watchtower container's logs.'`;
- otherwise leave the pending state alone, so a boot that happens to precede the replacement does not erase the record.

This is what turns "we fired a request into the dark" into a state machine with a definite end, and it is the reason step 1 writes before the fetch.

**MUST-7.7** `reconcileApplyOnBoot()` must never throw into the boot path, exactly as notify MUST-14.2's raise must not. Warranty §20's ordering rules are untouched: `applyStagedRestoreOnBoot()` stays the first statement in `src/instrumentation-node.ts`, and the `'restart'` exit still happens before `getDb()`.

### 7.4 The fallback — installs that cannot update themselves

**MUST-7.8** When `watchtowerConfig()` returns `null` — a build-from-source `docker-compose.yml` install, a bare `npm start`, or a pull install whose compose predates §16.1 — the card renders check results normally and shows **no apply button at all**. The button is not disabled; it is absent, because a disabled button invites a click and then explains itself, and there is nothing to explain away.

**MUST-7.9 (fallback copy, shipped verbatim).** In place of the button, inside a `Notice` tone `info`:

> **This install updates by hand.**
>
> There is no Watchtower companion for the app to ask, so it cannot replace itself. That is normal if you built from source or if you set this up before version 1.3.1.
>
> To move to the new version, run `./install/update.sh` on Linux, macOS, a Raspberry Pi, or Synology over SSH, or `.\install\update.ps1` on Windows. Both scripts tag a rollback point first and put it back automatically if the new version does not come up healthy.
>
> If you installed with the prebuilt image, you can switch to in-app updates instead by replacing your compose file with the current `install/synology-compose-pull.yml` — see INSTALL.md, "Moving to in-app updates".

Every path and filename above is plain text, never an `<a href>`, for the same reasons notify MUST-11.6 gives: it keeps the zero-egress claim trivially auditable and it survives a screenshot.

---

## 8. Egress — the amended model

This is the section a reviewer should attack first, so it is written to be attacked.

### 8.1 The complete destination list, after this release

**MUST-8.1** The app may contact exactly **three** external destinations, and each is dormant until somebody configures it:

| # | Destination | Gate | Since |
|---|---|---|---|
| 1 | the user's own SimpleFIN bridge | a claimed SimpleFIN connection exists | §12, v1.0 |
| 2 | `api.telegram.org` and the SMTP host an admin typed in | an enabled `notification_targets` row exists | notify §9, v1.3.0 |
| 3 | `api.github.com` | `update.checks_enabled === '1'` | **this spec**, v1.3.1 |

**MUST-8.2** The Watchtower endpoint is **not** on that list, and the distinction is substantive rather than a definitional convenience. It is (a) reached by a compose service name that resolves only on the project's private bridge network, (b) never published to the host — the compose file gives Watchtower no `ports:` mapping — and (c) structurally prevented from being an internet address by `assertWatchtowerUrl` (§8.3), which refuses every hostname that is not a bare label, `localhost`, or a private/loopback IP literal. It is the same category of call as the healthcheck's `fetch('http://127.0.0.1:3000/api/health')` that `docker-compose.yml` already runs: traffic that never leaves the machine. §16.1's compose comment and README/INSTALL's egress paragraph both say this in as many words, because a claim like this is worth nothing if it is only true in the code.

**MUST-8.3** Master spec §2's "No runtime network calls" line gains a **third** opt-in exception, worded like the other two: *"...and update checks (2026-08-17 spec), dormant until an admin enables them and then reaching only `api.github.com`."*

### 8.2 `src/lib/update/egress.ts` — PURE

```ts
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_REPO_PATH = '/repos/VibeLogicCode/BudgetTracker';

/** Throws unless: origin === GITHUB_API_ORIGIN, no userinfo, no fragment, the pathname is
 *  one of the two exact literals below, and the search is either empty or exactly the
 *  pinned `?ref=v<semver>` the changelog read uses. */
export function assertGithubUrl(url: string): void;

/** Throws unless the URL is an unpublished, non-public endpoint (§8.3). */
export function assertWatchtowerUrl(url: string): void;
```

**MUST-8.4** `assertGithubUrl` requires **all five** conditions, and the reasoning is the same one notify MUST-9.2 sets out for Telegram. `URL` normalises dot-segments *before* any check runs, so a value that folds down to a different host can still read back an innocent `origin`; and a userinfo section (`https://api.github.com@evil.com`) lands in `host`, not in a separate field a naive check would notice. The five:

1. `parsed.origin === GITHUB_API_ORIGIN`;
2. `parsed.username === '' && parsed.password === ''`;
3. `parsed.hash === ''`;
4. `parsed.pathname` is exactly one of:
   - `` `${GITHUB_REPO_PATH}/releases/latest` ``
   - `` `${GITHUB_REPO_PATH}/contents/CHANGELOG.md` ``
5. `parsed.search` is `''` for the first path, and matches `/^\?ref=v\d+\.\d+\.\d+$/` for the second.

Pinning the **exact** pathnames rather than a prefix is deliberate: a prefix check on `/repos/VibeLogicCode/BudgetTracker` would happily allow `/issues`, `/comments`, or `/contents/<anything>`, and this feature has no business reading any of them. Pinning the query shape closes the one place a caller-supplied value reaches the URL.

**MUST-8.5** Each of the two `fetch` sites in `src/lib/update/github.ts` calls `assertGithubUrl()` on the string it is about to fetch, on the line immediately above the `fetch`. Not in a helper, not in a wrapper — immediately above, so the guard and the call cannot drift apart in a later edit.

### 8.3 `assertWatchtowerUrl` — making "internal" enforceable

**MUST-8.6** `assertWatchtowerUrl(url)` throws unless **all** of:

1. the URL parses;
2. `protocol` is `http:` or `https:`;
3. `username === '' && password === ''`;
4. `pathname === '/v1/update'`;
5. `search === '' && hash === ''`;
6. the hostname is non-public, meaning one of:
   - a **bare label** — `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i` with no dot, which is what a Docker Compose service name is (`watchtower`);
   - `localhost`;
   - an IPv4 literal inside `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` or `169.254.0.0/16`;
   - `[::1]`, or an IPv6 literal inside `fc00::/7` or `fe80::/10`.

Any hostname containing a dot that is not one of those IP literals is refused with `refusing a Watchtower request to a non-internal host`. A dotted name could resolve anywhere, and this function is pure — it cannot and must not resolve DNS to find out. The shipped default (`http://watchtower:8080/v1/update`) is a bare label and passes; `http://evil.example.com/v1/update` does not; `http://watchtower:8080/v1/update?x=1` does not; `http://user@watchtower:8080/v1/update` does not. The accepted bare-label branch carries the same residual limitation honestly, not hidden: a dotless name could still resolve publicly, via resolv.conf search domains or a dotless TLD, but `WATCHTOWER_URL` is operator-set env, not attacker input.

**MUST-8.7** A `WATCHTOWER_URL` that fails this guard makes `watchtowerConfig()` return `null`, which puts the install on the §7.4 fallback path and surfaces `The WATCHTOWER_URL in your compose file is not a valid internal address.` on the card. It is never a 500 and never a silent no-op.

### 8.4 Amendments to `tests/ops/notify-egress.test.ts`

**MUST-8.8** The file keeps its name and its existing assertions, and is generalised from one scanned tree to two with a per-tree allowlist. Concretely:

1. The two `describe` titles that say "src/lib/notify/" are rewritten to name both trees; the file's leading comment states that it is the **whole app's** egress invariant test, not notifications' alone.
2. The "every `fetch(` is in `send/telegram.ts`, and there are exactly two" test becomes a table-driven assertion over both trees:

| Tree | Allowed `fetch(` file | Expected count |
|---|---|---|
| `src/lib/notify` | `src/lib/notify/send/telegram.ts` | 2 (`sendMessage`, `getUpdates`) |
| `src/lib/update` | `src/lib/update/github.ts` | 2 (`releases/latest`, `contents/CHANGELOG.md`) |
| `src/lib/update` | `src/lib/update/watchtower.ts` | 1 (`/v1/update`) |

Any `fetch(` anywhere else under either tree fails, exactly as today.

3. The "only URL literal containing `://`" test gains a second case: under `src/lib/update/`, the only such literal is `GITHUB_API_ORIGIN` in `egress.ts`, asserted as `["'https://api.github.com'"]`. **`watchtower.ts` must contain no `://` literal** — the URL comes from the environment. This is the assertion that makes MUST-2.3 mechanical.
4. The "no HTTP client library" test runs over both trees.
5. A new test asserts that `assertGithubUrl` is called on the line immediately preceding each `fetch(` in `github.ts`, and `assertWatchtowerUrl` likewise in `watchtower.ts` — a source-level check in the style of `tests/ops/restore-seams.test.ts`, because MUST-8.5's "immediately above" is the part a refactor loses first.
6. A new test asserts `src/lib/update/semver.ts` and `src/lib/update/egress.ts` import no `@/db`, no `@/lib/env` and no `node:` builtin (MUST-2.1), reusing the existing pure-module loop.
7. The existing MUST-2.2 client-import test's banned-module regex gains `@/lib/update/(github|watchtower|state|check)`, with the same `import type` exemption.
8. A new test asserts that `src/lib/update/` contains **no** `Authorization` literal other than the single `Bearer` header construction in `watchtower.ts`, and no `console.*` call interpolating `token`, `Authorization` or `bearer` — the update-side counterpart of AC7.

**MUST-8.9** `tests/ops/install.test.ts`'s app-wide `fetch()` allowlist (its "the app makes no network call unless SimpleFIN is configured" test) gains two entries — `src/lib/update/github.ts` and `src/lib/update/watchtower.ts` — each with the one-line comment naming this spec, exactly as the notify entry names notify MUST-9.5. Its `describe('no auto-update anywhere in the codebase')` block is **renamed** to `describe('the updater is opt-in and never bypasses the scheduler's gate')` and its two assertions are amended: `src/lib/scheduler.ts` still must not match `/update\.(sh|ps1)/` or `/npm update|docker (pull|compose)/` — the scheduler must never shell out or drive Docker directly — and a new assertion requires it to contain `isUpdateCheckEnabled`, so the gate cannot be removed while the tick stays. A block whose title now contradicts the shipped behaviour is worse than no block; renaming it and tightening it is the honest fix.

---

## 9. Update UI — Settings → About

`AboutPanel` is a server component rendered as the last child of `/settings` (`src/app/(app)/settings/page.tsx:124`). It gains a sibling card **above** it. All existing primitives: `Card` / `CardHeader` / `CardBody`, `Notice`, `Field`, `SubmitButton`, `btn btn--primary|--secondary|--ghost`, `badge badge--*`, and the `text-ink` / `text-muted` / `text-subtle` tokens. **No new CSS, no new design token, no new colour.**

### 9.1 Structure

**MUST-9.1** A new `src/app/(app)/settings/updates-card.tsx` (**new**, server component) is rendered from `settings/page.tsx` immediately before `<AboutPanel />`, and **only for `user.role === 'admin'`**. A member's Settings page is byte-identical to v1.3.0's. The card's own client half — the buttons, the confirm dialog and the changelog panel — lives in `src/app/(app)/settings/updates-client.tsx` (**new**).

**MUST-9.2** The card is not added to `ADMIN_LINKS`. It is a card with controls, not a link to another page, for the same reason the Sessions card is.

### 9.2 The off state

**MUST-9.3** With checks disabled the card renders, verbatim:

> **Updates**
> Budget Tracker v1.3.1 · update checks are off.
>
> This app does not check for updates unless you ask it to. Switch this on and once a day it will ask GitHub whether a newer version of Budget Tracker has been published. That request carries the version you are running and nothing else — not your data, not your address, not how many people use this install.
>
> Small updates (bug fixes and new features) install themselves. A major version never does: you will be told, shown exactly what changed, and asked.

with one `btn btn--primary` labelled **Enable update checks**. No other control is rendered in this state.

### 9.3 The on state

**MUST-9.4** With checks enabled the card shows, in order:

1. **Status line** — `Up to date (v1.3.1)`, or `Version 1.4.0 is available` with a `badge badge--amber` reading `Minor update` / `Patch update` / `Major update`.
2. **Last checked** — `iso.slice(0, 16).replace('T', ' ')`, or `Never` — the app's one timestamp convention, no relative strings (notify §11.4's amendment binds here too).
3. **A `Notice` tone `error`** when `update.last_check_error` or `update.last_apply_error` is set, carrying the scrubbed message.
4. **Controls**: **Check now** (`btn btn--secondary`); an **Install small updates automatically** checkbox posting to `setAutoApplyAction`; **Disable update checks** (`btn btn--ghost`).
5. **The action for the current finding**, per MUST-5.7:
   - patch/minor, apply available → **Update now** (`btn btn--primary`);
   - major → **Review and update** (`btn btn--primary`), which expands the §9.4 panel;
   - no apply path → §7.9's fallback notice.
6. **Not now** (`btn btn--ghost`) beside either primary, writing `update.dismissed_version`. A dismissed version collapses the card back to its status line with `Version 1.4.0 is available — you chose to skip it for now.` and a **Show again** control. It never suppresses the notification, never stops the daily check, and never survives a newer version being published (MUST-5.9).

### 9.4 The major-update review panel

**MUST-9.5** Pressing **Review and update** calls `reviewUpdateAction()`, which fetches and parses the **remote** `CHANGELOG.md` at the offered release's tag (MUST-4.2 endpoint 2), and renders the single section whose heading begins `[<version>]`. The panel shows:

- a heading: `What changed in 1.4.0`;
- the parsed groups and bullets, bounded per MUST-4.8, rendered with the **same** `renderEmphasis()` bold-run helper `AboutPanel` already uses on the local changelog — one renderer, two sources, so remote and local notes cannot drift in appearance;
- a `Notice` tone `warning`: *"This is a major version. Read the notes above before continuing. Your data is not touched by an update — the database stays where it is and migrations run automatically when the new version starts."*;
- a confirm button labelled **Install 1.4.0** (the version is in the label, so a stale panel cannot install something the reader did not read about) and a **Cancel**.

**MUST-9.6** When the changelog fetch fails or the version's section is missing, the panel renders instead: *"The release notes for 1.4.0 could not be fetched. You can read them on the project's releases page before deciding."* — plain text, no link — and the confirm button is still offered. A failed changelog read must not become a wall that stops an admin updating.

**MUST-9.7** `applyUpdateAction` re-reads the current state server-side and refuses when the submitted version does not equal `update.latest_version`, with `That version is no longer the one on offer. Press Check now and read the notes again.` The version travels in the form so a stale tab cannot install a version its reader never saw — and it is checked against the server's own state, never trusted.

### 9.5 After firing an apply

**MUST-9.8** The three outcomes get three fixed sentences:

- `'accepted'` → *"Update requested. Watchtower is pulling 1.4.0 and will restart this app in a moment. Reload this page in a minute or two."*
- `'accepted-unconfirmed'` → *"Update requested. This app is being replaced right now, so it could not wait for a reply. Reload this page in a minute or two — the version at the bottom of this card will tell you whether it worked."*
- an error → the scrubbed message in a `Notice` tone `error`.

**MUST-9.9** No spinner, no polling, no auto-reload. The container is going away; a page trying to poll it is a page showing a network error. A plain instruction to reload is the honest interface.

---

## 10. Update server actions, security and rate limits

### 10.1 The actions

**MUST-10.1** Six new actions, all exported from the existing `src/app/(app)/settings/actions.ts`:

```ts
export interface UpdateActionState { error?: string; message?: string }

enableUpdateChecksAction(): Promise<UpdateActionState>;                          // admin
disableUpdateChecksAction(): Promise<UpdateActionState>;                         // admin
setAutoApplyAction(_prev, formData): Promise<UpdateActionState>;                 // admin
checkForUpdateNowAction(): Promise<UpdateActionState>;                           // admin, rate-limited
reviewUpdateAction(formData): Promise<ReviewUpdateState>;                        // admin, rate-limited
applyUpdateAction(formData): Promise<UpdateActionState>;                         // admin, rate-limited
```

```ts
export interface ReviewUpdateState { error?: string; release?: ChangelogRelease; version?: string }
```

**MUST-10.2** Every one of them calls `isSameOrigin(await headers())` **first** — before auth, before validation, before any read — returning `{ error: CROSS_ORIGIN_ERROR }`, exactly the shape `src/app/(app)/settings/notifications/actions.ts`'s `guard()` uses. Then `await requireAdmin()`. Then validation. Then the domain call. Then `revalidatePath('/settings')`.

`reviewUpdateAction` mutates nothing and does not revalidate — but it takes the **strict** `isSameOrigin()`, not the relaxed `isSameOriginOrHeaderless()`, because it causes outbound egress on the server. This is exactly the reasoning notify MUST-12.8 gives for `detectTelegramChatIdAction`.

**MUST-10.3 (the ownership rule).** No update action accepts a `userId`. `enableUpdateChecksAction` records the caller's id from `requireAdmin()` into `update.enabled_by`. The only parameters any of them accept are `enabled` (a checkbox) and `version` (a semver string, zod-validated against `/^\d+\.\d+\.\d+$/` and then re-checked against server state per MUST-9.7).

**MUST-10.4** This feature adds **no route handler**, no anonymous path, no signed URL, no bearer token in a query string, and no way to trigger an update without an authenticated admin session on a same-origin request.

### 10.2 Where the check actually runs

**MUST-10.5** `checkForUpdateNowAction` and the scheduler tick both call the same `runUpdateCheck()`. There is no second code path, so a manual check and an automatic one can never classify the same pair of versions differently.

**MUST-10.6** A manual check that finds a patch/minor with auto-apply on **does** fire the apply, same as the scheduled path. Pressing "Check now" on an install configured to install small updates automatically installs the small update; anything else would be a surprising second policy.

### 10.3 `src/lib/update/ratelimit.ts`

**MUST-10.7** In-memory token buckets, modelled directly on `src/lib/notify/ratelimit.ts` — same `RateVerdict` shape, same prune-then-verdict structure, same clock seam:

```ts
export const CHECK_NOW_WINDOW_MS = 10 * 60_000;
export const CHECK_NOW_MAX = 5;      // GLOBAL, not per-user
export const REVIEW_WINDOW_MS = 10 * 60_000;
export const REVIEW_MAX = 10;        // GLOBAL
export const APPLY_WINDOW_MS = 60 * 60_000;
export const APPLY_MAX = 3;          // GLOBAL

export interface RateVerdict { allowed: boolean; retryAfterMinutes: number }
export function checkUpdateCheckNow(now?: number): RateVerdict;
export function checkUpdateReview(now?: number): RateVerdict;
export function checkUpdateApply(now?: number): RateVerdict;
export function setUpdateRateLimitClockForTests(next: (() => number) | null): void;
export function resetUpdateRateLimitsForTests(): void;
```

**MUST-10.8** These buckets are **global, not per-user**, which is the opposite of the notify test-send bucket and is deliberate: there is one GitHub quota per source IP and one install to update, so the shared resource is the install itself. Two admins pressing Check now are contending for the same thing.

**MUST-10.9** A token is consumed only once the action has passed every configuration guard, so pressing **Update now** on an install with no Watchtower cannot burn apply quota while doing nothing. This is the ordering notify's `runTest` already establishes and its comment already explains.

**MUST-10.10** Exceeding a cap returns `Too many attempts. Try again in N minutes.` and performs no egress. `APPLY_MAX = 3` per hour is not a security boundary — an admin can already restart the container — it bounds a stuck form and a double-click storm against a container that is mid-replacement.

### 10.4 Scrubbing

**MUST-10.11** Every string written to `update.last_check_error`, `update.last_apply_error`, `console.*`, or returned to the browser from `src/lib/update/` passes through `scrubSecrets(text, secrets)` from `src/lib/notify/crypto.ts`, with the Watchtower token in the secret list on every apply path. The function is imported, not reimplemented; a second scrubber is a second thing to get wrong.

---

## 11. Loans — data model and migration 0007

### 11.1 Migration discipline

**MUST-11.1** Migrations are **append-only and hand-authored**. `drizzle-kit generate` is never run: there is no `0000_snapshot.json`, so it would diff against an empty baseline and re-emit the whole schema. The order of work is fixed:

1. hand-author `drizzle/0007_loans.sql`;
2. append the journal entry;
3. mirror the columns and tables in `src/db/schema.ts`.

**MUST-11.2** The journal entry appended to `drizzle/meta/_journal.json` is exactly:

```json
{ "idx": 7, "version": "6", "when": 1755820800000, "tag": "0007_loans", "breakpoints": true }
```

(`1755734400000 + 86400000`, one day after 0006, matching the file's existing one-per-day cadence.)

**MUST-11.3** The drizzle statement-breakpoint marker separates statements and appears **nowhere else in the file** — not in the header comment, not in an inline comment. The splitter is comment-blind: it splits on that marker wherever it appears, and a copy inside a comment shreds the migration into fragments that will not parse. The header below refers to it in prose only.

**MUST-11.4** The header comment repeats the drizzle-kit warning from `0000_init.sql` and extends the running enumeration of SQL-only objects, which stood at **20** after 0006.

### 11.2 The five new `warranty_items` columns

**MUST-11.5** All five arrive by `ALTER TABLE ADD COLUMN` — legal here for the same reason `type_id` (0003) and the billing pair (0005) were — and are declared **physically last**, after `billing_amount_cents`, matching the convention documented in `src/db/schema.ts`.

| Column | Type | Notes |
|---|---|---|
| `principal_cents` | integer, nullable | what was borrowed. `CHECK (IS NULL OR >= 0)` |
| `interest_rate_bps` | integer, nullable | **display only**, no math anywhere (MUST-13.1). Basis points, so 5.49% is `549`. `CHECK (IS NULL OR (>= 0 AND <= 1000000))` |
| `current_balance_cents` | integer, nullable | what is still owed, today. `CHECK (IS NULL OR >= 0)` |
| `balance_updated_at` | text, nullable | ISO datetime. **The human anchor** — set only when a person types a balance, never by a matched payment (§11.3) |

That is four columns. The fifth is not a new column: `billing_cycle` and `billing_amount_cents` already exist (0005) and are **unlocked** for loans by an app-layer rule change (§12.1), which is why this migration rebuilds no table.

**MUST-11.6 (why no table rebuild).** The rule "billing fields only apply to subscriptions and contracts" is enforced **in the app layer**, in `assertBillingMatchesKind()` in `src/lib/warranty/items.ts`, and **not** in SQL. `drizzle/0005_billing_cycle.sql`'s own header says why: *"a CHECK on `warranty_items` cannot see across to `warranty_item_types.kind`."* The SQL CHECKs on those two columns constrain their value domain (`IN ('monthly','annual')`, `>= 0`) and say nothing about kind. Widening the rule to include loans is therefore a **one-predicate change to `billingAllowedForKind`** and touches no DDL at all. There is no `ALTER TABLE ... DROP CONSTRAINT` in SQLite and no twelve-step table rebuild in this migration, and the reason is that 0005 put the rule in the right place to begin with.

**MUST-11.7 (the balance/anchor pairing rule lives in the app layer too).** `current_balance_cents` and `balance_updated_at` must be both set or both null. That is a **cross-column** invariant, and this migration deliberately does **not** express it as a SQL CHECK: `ALTER TABLE ADD COLUMN` with a cross-column CHECK is the one shape 0005's precedent does not cover, and SQLite does not re-validate existing rows against a CHECK added this way, so the constraint would be weaker than it looks while being riskier to add. It is enforced in `src/lib/warranty/items.ts` beside `assertBillingMatchesKind`, by the same argument that migration's header already makes, and asserted by a test in `tests/lib/warranty/items.test.ts` rather than in `tests/db/`.

### 11.3 The two anchors, and what `balance_updated_at` means

**MUST-11.8** This is the single most important definition in the loans half, because the report depends on it:

- `current_balance_cents` is **always current**. A matched or manually assigned payment decrements it; an unassign increments it back; a direct edit sets it.
- `balance_updated_at` is **only** written when a **person types a balance** — on the item create form and the item edit form. A payment never touches it.

So `balance_updated_at` answers "when did a human last tell us the truth about this balance", which is exactly the question the debt reconstruction needs (§15.3). The display value "Balance as of …" the UI shows is *not* this column: it is `max(balance_updated_at, newest loan_payments.created_at)`, derived in `listLoans()` with one query, and the two are labelled differently in the UI ("You set this on …" versus "Last payment …").

### 11.4 `loan_matcher_rules`

**MUST-11.9** One loan may have several rules (a mortgage that shows up under two merchant strings after a lender rebrands). A rule is per item, optionally narrowed to one account.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | |
| `item_id` | integer NOT NULL → `warranty_items(id)` ON DELETE CASCADE | |
| `merchant_contains` | text NOT NULL | a substring, `CHECK (length(trim(...)) >= 3)` |
| `account_id` | integer → `accounts(id)` ON DELETE CASCADE, nullable | NULL = any account |
| `enabled` | integer NOT NULL DEFAULT 1 | |
| `created_at`, `updated_at` | text NOT NULL | |

**MUST-11.10** The three-character minimum is a real guard, not tidiness: a one- or two-character substring matches most merchant strings in a household's history, and the first import after such a rule was saved would assign every transaction to a loan. It is enforced in SQL **and** in zod.

**MUST-11.11** `merchant_contains` is matched against `transactions.normalized_merchant`, which `normalizeMerchant()` **uppercases** (`src/lib/categorize/normalize.ts:116`). The stored value is therefore uppercased on write and compared with `instr(t.normalized_merchant, ?) > 0` against the uppercased parameter — no `lower()` wrapper on either side. (This is the same normalizer-casing trap the notify build hit in its R1 review finding; it is called out here so it is not hit twice.)

**MUST-11.12** `MAX_RULES_PER_LOAN = 5`, enforced in the save action. The matcher loads every enabled rule **once per batch** in a single query, not once per transaction, so the per-transaction cost is a loop over a handful of substrings.

### 11.5 `loan_payments`

**MUST-11.13** The link row between a transaction and a loan.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | |
| `txn_id` | integer NOT NULL → `transactions(id)` ON DELETE CASCADE | |
| `item_id` | integer NOT NULL → `warranty_items(id)` ON DELETE CASCADE | |
| `amount_cents` | integer NOT NULL, `CHECK (> 0)` | `abs(transaction.amount_cents)` — the payment, as it actually was |
| `applied_cents` | integer NOT NULL, `CHECK (>= 0 AND <= amount_cents)` | how much of it actually came off the balance |
| `source` | text NOT NULL, `CHECK IN ('rule','manual')` | |
| `created_at` | text NOT NULL | |

**MUST-11.14 (why two amount columns).** `amount_cents` is the honest record of the payment. `applied_cents` is what the balance actually moved by, which differs whenever the decrement clamped at zero (a final payment larger than the remaining balance) or whenever the loan had no balance being tracked (`applied_cents = 0`). An unassign or an import undo adds back **`applied_cents`**, so a reversal restores the balance *exactly*, with no drift, in every clamping case. One column would force a choice between an inaccurate record and an inaccurate reversal.

**MUST-11.15 (idempotency is the index, not bookkeeping).** `UNIQUE (txn_id, item_id)`, and every link insert is `INSERT ... ON CONFLICT DO NOTHING` with `changes === 0` meaning "already linked, do not decrement". This is deliberately the same shape as notify MUST-3.9's dedup: the row that recorded the payment **is** the guard, so the guard cannot drift from reality, and a crash between "decide to apply" and "record that we applied" is impossible because they are the same statement — the decrement runs in the same transaction, conditional on `changes > 0`.

**MUST-11.16** `UNIQUE (txn_id, item_id)` — not `UNIQUE (txn_id)` — because one transaction may legitimately fund two loans (a combined payment). The rule path never exploits this (MUST-13.3); only a person can create the second link, and the UI warns when the linked total exceeds the transaction (§14.3).

### 11.6 Indexes, Drizzle mirror and the header enumeration

**MUST-11.17** Indexes beyond the primary keys:

- `loan_matcher_rules_item_idx ON loan_matcher_rules(item_id)` — the per-item editor;
- `loan_matcher_rules_uq UNIQUE ON loan_matcher_rules(item_id, merchant_contains, coalesce(account_id, -1))` — an expression index, so "the same rule twice" is impossible including in the account-agnostic case where a plain unique index would let two NULLs through;
- `loan_payments_txn_item_uq UNIQUE ON loan_payments(txn_id, item_id)` — MUST-11.15;
- `loan_payments_item_idx ON loan_payments(item_id, id)` — the per-loan payment list and the report's backward walk;
- `loan_payments_txn_idx ON loan_payments(txn_id)` — the transactions page's "is this row already assigned" lookup and the undo reversal.

`warranty_items` needs no new index: `warranty_items_type_idx` already serves the kind join, and the table is small.

**MUST-11.18** `src/db/schema.ts` gains the four new `warrantyItems` columns appended after `billingAmountCents`, then `loanMatcherRules` and `loanPayments` in that order, each with a docblock naming the SQL-only objects it cannot express. Column order in the mirrors matches the DDL, per the existing convention.

**MUST-11.19** The migration header's SQL-only enumeration continues from 20:

```
--  21. the CHECK constraints on the four loan money columns, and all four
--      columns arriving by ALTER TABLE ADD COLUMN                        (0007)
--  22. every CHECK constraint on loan_matcher_rules                      (0007)
--  23. the coalesce(account_id, -1) EXPRESSION in the rule unique index  (0007)
--  24. every CHECK constraint on loan_payments                           (0007)
```

The two app-layer rules — billing-by-kind (MUST-11.6) and the balance/anchor pairing (MUST-11.7) — are named in the header as rules that deliberately have **no** SQL representation, extending the note 0005 already makes.

### 11.7 `drizzle/0007_loans.sql` — exact SQL

```sql
-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- NOTE ON SEPARATORS: drizzle's migrator splits this file on the breakpoint marker written
-- between each statement below, and on nothing else, and it does NOT skip comments. That
-- marker must therefore never appear inside a comment -- including this one, which is why
-- it is described here rather than quoted -- or the file is shredded into fragments that
-- will not parse.
--
-- Loan money-tracking (spec 2026-08-17, v1.3.1). Four nullable columns on warranty_items
-- and two new tables, both created EMPTY. This migration reverses the warranty spec's
-- section 17 item 29 ("loans are dates and documents only"): loans now carry a principal,
-- a display-only rate, and a balance that bank transactions can decrement.
--
-- TWO RULES DELIBERATELY LIVE IN THE APP LAYER, NOT HERE, both in
-- src/lib/warranty/items.ts, for the reason 0005's header already gives -- a CHECK on
-- warranty_items cannot see across to warranty_item_types.kind:
--   (a) which kinds may carry billing_cycle / billing_amount_cents (0005's rule, widened
--       by this release to include 'loan');
--   (b) current_balance_cents and balance_updated_at are both set or both NULL. This one
--       is cross-column, and ALTER TABLE ADD COLUMN does not re-validate existing rows
--       against a CHECK added that way, so a CHECK here would be weaker than it looks.
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after
-- this migration:
--   1. the categories.parent_id self-referencing foreign key             (0000)
--   2. the COALESCE(display_description, raw_description) index          (0000)
--   3. the COALESCE month expression index                               (0000)
--   4. every CHECK constraint on warranty_items                          (0002, extended here)
--   5. every CHECK constraint on warranty_receipts                       (0002)
--   6. the warranty_search FTS5 contentless virtual table                (0002)
--   7. its six triggers, which are its ONLY writer                       (0002)
--   8. the is_subscription/name CHECK constraints on warranty_item_types (0003)
--   9. the COLLATE NOCASE collation on warranty_item_types_name_uq       (0003)
--  10. warranty_items.type_id arriving by ALTER TABLE ADD COLUMN         (0003)
--  11. the CHECK constraint on warranty_item_types.kind                  (0004)
--  12. warranty_item_types.kind itself, by ALTER TABLE ADD COLUMN        (0004)
--  13. the CHECK constraints on billing_cycle and billing_amount_cents,
--      and both columns arriving by ALTER TABLE ADD COLUMN               (0005)
--  14. the id = 1 singleton CHECK on notification_smtp                   (0006)
--  15. every other CHECK constraint on notification_smtp                 (0006)
--  16. every CHECK constraint on notification_targets, including the     (0006)
--      channel/secret_encrypted pairing rule
--  17. every CHECK constraint on notification_prefs                      (0006)
--  18. every CHECK constraint on notification_user_settings              (0006)
--  19. every CHECK constraint on notification_outbox                     (0006)
--  20. notification_prefs' WITHOUT ROWID storage class                   (0006)
--  21. the CHECK constraints on the four loan money columns, and all
--      four columns arriving by ALTER TABLE ADD COLUMN                   (0007)
--  22. every CHECK constraint on loan_matcher_rules                      (0007)
--  23. the coalesce(account_id, -1) EXPRESSION in loan_matcher_rules_uq  (0007)
--  24. every CHECK constraint on loan_payments                           (0007)
ALTER TABLE `warranty_items` ADD COLUMN `principal_cents` integer CHECK (`principal_cents` IS NULL OR `principal_cents` >= 0);
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `interest_rate_bps` integer CHECK (`interest_rate_bps` IS NULL OR (`interest_rate_bps` >= 0 AND `interest_rate_bps` <= 1000000));
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `current_balance_cents` integer CHECK (`current_balance_cents` IS NULL OR `current_balance_cents` >= 0);
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `balance_updated_at` text;
--> statement-breakpoint
CREATE TABLE `loan_matcher_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
	`merchant_contains` text NOT NULL CHECK (length(trim(`merchant_contains`)) >= 3),
	`account_id` integer REFERENCES `accounts`(`id`) ON DELETE CASCADE,
	`enabled` integer NOT NULL DEFAULT 1,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `loan_matcher_rules_item_idx` ON `loan_matcher_rules` (`item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `loan_matcher_rules_uq` ON `loan_matcher_rules` (`item_id`, `merchant_contains`, coalesce(`account_id`, -1));
--> statement-breakpoint
CREATE TABLE `loan_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`txn_id` integer NOT NULL REFERENCES `transactions`(`id`) ON DELETE CASCADE,
	`item_id` integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
	`amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
	`applied_cents` integer NOT NULL CHECK (`applied_cents` >= 0 AND `applied_cents` <= `amount_cents`),
	`source` text NOT NULL CHECK (`source` IN ('rule', 'manual')),
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loan_payments_txn_item_uq` ON `loan_payments` (`txn_id`, `item_id`);
--> statement-breakpoint
CREATE INDEX `loan_payments_item_idx` ON `loan_payments` (`item_id`, `id`);
--> statement-breakpoint
CREATE INDEX `loan_payments_txn_idx` ON `loan_payments` (`txn_id`);
```

---

## 12. Lifting the billing rule for loans, and the wording matrix

### 12.1 The one-predicate change

**MUST-12.1** In `src/lib/warranty/constants.ts`:

```ts
/** v1.3.1: widened to include 'loan'. A loan's billing pair is its regular PAYMENT
 *  (see BILLING_WORDING) -- the amount and the cadence, not an interest calculation. */
export function billingAllowedForKind(kind: ItemKind): boolean {
  return kind !== 'warranty';
}
```

That is the entire server-side rule change. `assertBillingMatchesKind()` in `items.ts` calls this predicate, `setItemTypeKind()`'s clearing pass calls it, and both forms gate their fieldset on it — so one edit moves every one of them together, which is exactly the property MUST-19.11's "one place" rule exists to preserve.

**MUST-12.2** A warranty-kind item still may not carry billing fields, and `BILLING_KIND_ERROR` is reworded to match: `Billing details only apply to subscriptions, contracts and loans.`

### 12.2 The billing wording matrix

**MUST-12.3** `src/lib/warranty/constants.ts` gains a second wording matrix beside `KIND_WORDING`, and the kind-agnostic `billingCycleSuffix(cycle)` is **deleted**, not wrapped. Every call site (`warranties-client.tsx`'s Billing cell, `warranty-detail-client.tsx`'s read view) has the item's `kind` in scope already and is routed through the kind-keyed helper. This follows the precedent warranty §19.12's Reviewer-Issue-1 ruling set when it deleted `purchaseDateLabel` and its three siblings rather than leaving two independent places where wording was written.

```ts
const BILLING_WORDING: Record<ItemKind, { section: string; amount: string; monthly: string; annual: string }> = {
  warranty:     { section: 'Billing', amount: 'Amount',         monthly: '/ month',  annual: '/ year'  },
  subscription: { section: 'Billing', amount: 'Amount',         monthly: '/ month',  annual: '/ year'  },
  contract:     { section: 'Billing', amount: 'Amount',         monthly: '/ month',  annual: '/ year'  },
  loan:         { section: 'Payment', amount: 'Payment amount', monthly: 'per month', annual: 'per year' },
};

export function billingSectionLabelForKind(kind: ItemKind): string;
export function billingAmountLabelForKind(kind: ItemKind): string;
export function billingCycleSuffixForKind(kind: ItemKind, cycle: BillingCycle): string;
```

The `warranty` row exists only so the record is total; it is unreachable through the UI, because `billingAllowedForKind('warranty')` is false.

**MUST-12.4** `BILLING_CYCLE_LABELS` (`Monthly` / `Annual`) is unchanged and shared — the cadence has the same name for a subscription and for a loan; only the noun around it differs.

### 12.3 What happens when a type's kind changes

**MUST-12.5** `setItemTypeKind()` already clears `billing_cycle` and `billing_amount_cents` on every item of a type whose kind moves to one where `billingAllowedForKind` is false, in the same transaction as the kind write. It gains a second clearing pass, in that same transaction, for a type moving **away from `loan`**:

- `principal_cents`, `interest_rate_bps`, `current_balance_cents`, `balance_updated_at` → NULL;
- every `loan_matcher_rules` row for those items → **deleted** (a matcher rule can only mean something for a loan);
- every `loan_payments` row → **kept**. Those rows are historical facts about transactions, not configuration, and deleting them would silently rewrite what the household paid. They become inert: `listLoans()` and the debt report both filter on `kind = 'loan'` with a non-null balance, so nothing reads them until the type becomes a loan again — at which point re-entering a balance moves the anchor to now (MUST-11.8) and the old rows are correctly excluded from the reconstruction anyway.

**MUST-12.6** The billing pair moves with the same rule it always had: a type moving from `loan` to `subscription` **keeps** its billing pair (both kinds allow it) and only the loan money fields are cleared. A type moving from `loan` to `warranty` loses both sets.

---

## 13. Loans — payment linkage

### 13.1 The scope line

**MUST-13.1** `interest_rate_bps` is **display only**. No code path multiplies it, accrues it, projects it or amortises with it. It is rendered as `5.49%` beside the balance and appears in no calculation anywhere. A test asserts that `interest_rate_bps` / `interestRateBps` appears in no arithmetic expression in `src/lib/loans.ts` — grep-shaped, in the style of the existing `console.*` invariant.

**MUST-13.2** Loan payments **stay in their spending category and in every budget**. `applyLoanMatchers` never writes `is_transfer`, never writes `category_id`, never writes `attributed_user_id`, and never touches the `transactions` table at all. `budgetProgress`, `categoryBreakdown`, `cashflowTrend`, `topMerchants` and `personSpendSplit` do not read `loan_payments`. A car payment is money that left the household this month; hiding it from the budget would make the budget wrong. Asserted directly: a test imports a payment, links it to a loan, and shows the category total is unchanged.

### 13.2 `src/lib/loans.ts`

```ts
export const MAX_RULES_PER_LOAN = 5;
export const LOAN_BACKFILL_DAYS = 365;
export const LOAN_BACKFILL_MAX = 500;

export interface LoanSummary {
  itemId: number; name: string; ownerUserId: number; ownerName: string;
  principalCents: number | null; interestRateBps: number | null;
  currentBalanceCents: number | null; balanceUpdatedAt: string | null;
  billingCycle: BillingCycle | null; billingAmountCents: number | null;
  startDate: string; expiryDate: string | null; isLifetime: boolean;
  /** 0..1, or null when principal or balance is unset, or principal is 0. */
  payoffFraction: number | null;
  /** First scheduled payment on or after today, or null. §15.1. */
  nextPaymentDate: string | null;
  lastPaymentAt: string | null;
  paymentCount: number;
}

export function listLoans(today?: string): LoanSummary[];
export function loansTotalOwedCents(): number;

export interface LoanRule { id: number; itemId: number; merchantContains: string; accountId: number | null; enabled: boolean }
export function listLoanRules(itemId: number): LoanRule[];
export function saveLoanRule(input: { itemId: number; merchantContains: string; accountId: number | null; enabled: boolean; at?: Date }): number;
export function deleteLoanRule(id: number): boolean;

export interface LoanLink { id: number; txnId: number; itemId: number; itemName: string; amountCents: number; appliedCents: number; source: 'rule' | 'manual' }
export function loanLinksForTransactions(txnIds: number[]): Map<number, LoanLink[]>;

/** Never throws. Returns how many links it created. */
export function applyLoanMatchers(txnIds: number[], at?: Date): number;
export function backfillLoanRule(ruleId: number, opts?: { days?: number; max?: number; at?: Date }): number;
export function assignTransactionToLoan(input: { txnId: number; itemId: number; at?: Date }): { linked: boolean; appliedCents: number };
export function unassignTransactionFromLoan(input: { txnId: number; itemId: number }): boolean;
/** Called inside undoImport's transaction, BEFORE the delete. Returns rows reversed. */
export function reverseLoanLinksForTransactions(txnIds: number[]): number;

export interface DebtPoint { month: string; owedCents: number | null }
export function debtOverTime(months: number, opts?: { endMonth?: string; today?: string }): DebtPoint[];
```

### 13.3 The rule matcher

**MUST-13.3** `applyLoanMatchers(txnIds)` does, in one `db.transaction`:

1. load every **enabled** rule whose item is a loan-kind item with a non-null `current_balance_cents`, once, in one query joining `loan_matcher_rules` → `warranty_items` → `warranty_item_types`; if there are none, return 0 immediately (this is the loans-side dormancy bail — a household with no loans pays one indexed read per import);
2. load the candidate transactions by id (`date`, `normalized_merchant`, `amount_cents`, `account_id`, `is_transfer`);
3. skip a transaction that `is_transfer`, that has `amount_cents >= 0` (a loan payment is money out), or that **already has any `loan_payments` row**;
4. for each remaining transaction, take the **first** matching rule ordered by `loan_matcher_rules.id` ascending — matching meaning `instr(normalized_merchant, upper(merchant_contains)) > 0` and (`rule.account_id IS NULL` or `rule.account_id = txn.account_id`);
5. insert the link with `amount_cents = abs(txn.amount_cents)`, `applied_cents = min(abs(txn.amount_cents), item.current_balance_cents)`, `source = 'rule'`, `ON CONFLICT DO NOTHING`; when `changes > 0`, `UPDATE warranty_items SET current_balance_cents = current_balance_cents - <applied>` for that item.

**MUST-13.4 (one link per transaction, from the rule path).** Step 3's "already has any link" check and step 4's "first rule wins" together guarantee the rule path creates at most one link per transaction, ever. Without it, two loans whose rules both match one merchant string would each take the full payment off their balance and the household would appear to have paid twice.

**MUST-13.5** `applyLoanMatchers` **never throws into its caller**. It is wrapped internally in `try/catch` and logs `[loans] matcher failed` on error, for the same reason notify MUST-6.19's raisers are: a loan-matching failure may not break an import, a SimpleFIN sync, a manual entry or a category confirmation. Its callers treat it exactly as `flow.ts` already treats `runEngine` — a post-commit side effect outside the commit transaction, with its own failure flag on the result.

**MUST-13.6** The decrement floors at zero (step 5's `min`), and `applied_cents` records the clamped figure so the reversal is exact (MUST-11.14). A payment against a loan already at zero produces a link row with `applied_cents = 0` — the payment is recorded, the balance stays at zero, and nothing is silently swallowed.

### 13.4 Where the matcher is called

**MUST-13.7** Exactly five call sites, and no others:

| Site | Placement |
|---|---|
| `src/lib/import/flow.ts` `commitStagedImport` | immediately after the existing `runEngine(committed.insertedTransactionIds)`, in the same non-throwing slot, adding `loanLinksCreated` to `CommitFlowResult` |
| `src/lib/simplefin/sync.ts` | immediately after its `runEngine(insertedIds)`, same contract |
| `src/lib/transactions.ts` `createManualTransaction` | last statement, on the inserted id |
| `src/lib/categorize/engine.ts` `confirmCategory` | **last statement on every path, including the idempotent early return** (MUST-13.8) |
| `src/lib/loans.ts` `backfillLoanRule` | the opt-in historical pass (MUST-13.9) |

**MUST-13.8 (why `confirmCategory`'s early return still matches).** `confirmCategory` returns early, before any write, when the transaction is already `source = 'manual'` with the same category. If the matcher call sat after that guard, a transaction confirmed before a loan rule existed could never be picked up by re-confirming it — which is exactly what a person does when they notice a payment did not get assigned. The call therefore sits at the very end of the function body **and** on the early-return path, and it is cheap: `applyLoanMatchers` bails on its first query when no loan rules exist.

The cost is worth stating rather than hiding: `bulkCategorizeAction` loops `confirmCategory`, so a 50-row bulk confirm makes 50 `applyLoanMatchers` calls and, on a household with no loans, 50 single-row indexed reads against an empty join. That is a bounded, sub-millisecond cost on a user-initiated action, and it buys the property that a person can always fix a missed assignment by re-confirming the row. Batching the call up into the action layer would put a fifth caller in a sixth place and is the change to make if that cost ever shows up in a profile.

**MUST-13.9 (backfill is opt-in and off by default).** Saving a rule offers a checkbox: **"Also link matching payments from the last 12 months"**, unchecked by default, with the hint *"Only tick this if the balance you typed is the balance from before those payments. Ticking it will subtract every payment it finds."* Unticked, the rule affects only transactions that arrive from now on.

This default is the whole point. A person types today's balance and then saves a rule; back-filling a year of payments would subtract them all from a figure that already accounts for them, and the loan would appear nearly paid off. The checkbox exists for the other case — somebody entering the original balance from the loan agreement — and the hint says which case is which.

**MUST-13.10** `backfillLoanRule` scans transactions with `date >= addDaysIso(today, -LOAN_BACKFILL_DAYS)` (served by `transactions_date_idx`), applies the same matching and clamping rules, and stops after `LOAN_BACKFILL_MAX = 500` links. It runs inside one transaction and reports its count in the action's success message: `Rule saved. 14 past payments linked, $4,830.00 taken off the balance.`

### 13.5 Manual assign and unassign

**MUST-13.11** `assignTransactionToLoan` performs the same insert-and-decrement as the rule path with `source = 'manual'`, with two differences: it does **not** skip a transaction that already has a link to a *different* loan (MUST-11.16), and it does **not** require the transaction to be negative — a household may want a loan disbursement or an adjustment on the record. It still refuses a transaction that is already linked **to this same loan** (the unique index makes that a no-op, reported as `linked: false`).

**MUST-13.12** `unassignTransactionFromLoan` deletes the link row and adds `applied_cents` back to `current_balance_cents` in the same transaction. Neither operation touches `balance_updated_at` (MUST-11.8).

**MUST-13.13** Both actions derive nothing from the client but `txnId` and `itemId`, both zod-validated as positive integers, both existence-checked server-side. Warranty items are household-shared with `owner_user_id` as attribution only (the docblock in `warranties/actions.ts` says so), so any signed-in user may assign a transaction to any loan — the same posture the existing warranty actions take, and a deliberate consistency rather than an oversight.

### 13.6 Import undo

**MUST-13.14** `undoImport` in `src/lib/import/commit.ts` gains **one call**, inside its existing `db.transaction`, placed **after** `partitionByAssociation` and the Bayes untrain and **before** `tx.delete(transactions)`:

```ts
const loanRowsReversed = reverseLoanLinksForTransactions(sole);
```

`reverseLoanLinksForTransactions` adds each row's `applied_cents` back to its item's `current_balance_cents` and deletes the link rows. The `ON DELETE CASCADE` on `loan_payments.txn_id` would remove the rows anyway — but a cascade cannot restore a balance, so the explicit reversal must run first. `UndoResult` gains `loanLinksReversed: number`.

**MUST-13.15** Transactions **kept** by an undo (those shared with another import, the `shared` partition) keep their loan links untouched, which is correct: the transaction still exists, the payment still happened.

**MUST-13.16 (the delete-site invariant).** `tx.delete(transactions)` in `undoImport` is the **only** place in the codebase that deletes a transaction row. A test asserts this by grep, so that a future second delete path cannot silently skip the reversal. If one is ever added, it must call `reverseLoanLinksForTransactions` first, and the test's failure message says so.

**MUST-13.17** Deleting a loan **item** (`deleteWarrantyItem`) cascades `loan_matcher_rules` and `loan_payments` away and needs no reversal — the balance being restored belongs to a row that no longer exists.

---

## 14. Loans — UI and server actions

### 14.1 The item form

**MUST-14.1** Both `new-warranty-client.tsx` and `warranty-detail-client.tsx`'s `EditForm` gain a **Loan** fieldset, rendered exactly when `selectedKind === 'loan'`, sitting after the existing billing pair and before the term fieldset. It follows the live-kind pattern already in place: it keys off the `selectedKind` derived from the controlled `typeId` select, and a `useEffect` clears its state when the kind moves away from `loan`, exactly as the billing pair's `useEffect` does today.

Fields, all optional, in a `grid gap-4 sm:grid-cols-2`:

| Label | `name` | Control | Hint |
|---|---|---|---|
| Original amount | `principal` | `field-control`, `inputMode="decimal"` | `What you borrowed. Used for the payoff bar.` |
| Interest rate | `interestRate` | `field-control w-28`, `inputMode="decimal"`, suffix `%` | `Shown for reference only — this app does no interest math.` |
| Balance still owed | `currentBalance` | `field-control`, `inputMode="decimal"` | `Today's balance. Payments you link will take it down from here.` |

**MUST-14.2 (the anchor is written only here).** Submitting either form with a non-empty `currentBalance` sets `current_balance_cents` **and** `balance_updated_at = now`. Submitting it empty sets both to NULL. This is the only place `balance_updated_at` is ever written (MUST-11.8), and the read-only detail view labels it `You set this on <date>` so the distinction is visible to the person, not just to the code.

**MUST-14.3** The detail page's read-only summary gains, for a loan with money fields: the balance as a `money-lg` figure, the payoff bar (§15.1's component), `Original <amount>`, `Rate <n.nn>%`, `Payment <amount> <suffix>` using `billingCycleSuffixForKind`, `Last payment <date>` and `<n> payments linked`. Every one of those rows is omitted when its value is null; the whole block is omitted when `current_balance_cents` and `principal_cents` are both null.

**MUST-14.4** Money is parsed with the existing `parseAmountToCents` from `src/lib/money.ts` and `Math.abs`, exactly as `readPriceCents` in `warranties/actions.ts` already does. The rate is parsed as a decimal percent and stored as basis points: `Math.round(percent * 100)`, range-checked 0–10000% in zod as well as in SQL.

### 14.2 The matcher-rule editor

**MUST-14.5** The detail page gains a **Payment matching** sub-card, rendered only for a loan-kind item, holding the item's rules as a small table (merchant text, account or `Any account`, enabled, Remove) plus an add row: a text input `merchantContains`, an account `<select>` defaulting to `Any account`, the MUST-13.9 backfill checkbox, and an **Add rule** submit.

**MUST-14.6** Above the table, always visible: *"When a transaction's merchant contains this text, the app treats it as a payment on this loan and takes it off the balance. The payment still counts in your budget and in your reports."* — MUST-13.2, stated where the person is making the decision rather than only in the spec.

**MUST-14.7** The add form refuses, with fixed wording: fewer than 3 characters (`Use at least three characters, or this will match almost everything.`); more than `MAX_RULES_PER_LOAN` (`Five rules per loan is the limit.`); a duplicate (`That rule already exists on this loan.`, from the unique index, translated in the action's `failure()` alongside the existing FK translation).

### 14.3 The transactions row control

**MUST-14.8** `transactions-client.tsx`'s last cell — currently the `Create warranty` link, its established precedent for a per-row action — gains a loan control, rendered only when `row.isTransfer` is false and the page was given a non-empty `loanOptions` list:

- **not linked** → an inline `<form>` with a `<select name="itemId">` using the shared `rowControl` class, first option `Assign to loan…`, and a small `Assign` submit;
- **linked** → the loan's name as `text-xs text-muted` plus an `Unassign` `btn btn--ghost btn--sm`.

**MUST-14.9** `transactions/page.tsx` passes `loanOptions` (from `listLoans()`, filtered to loans with a non-null balance) and `loanLinks` (from `loanLinksForTransactions()` over the page's row ids — one query, served by `loan_payments_txn_idx`). When `loanOptions` is empty the whole control is absent, so a household with no loans sees the transactions page exactly as it is today.

**MUST-14.10** When assigning would take the sum of a transaction's links past its own amount, the action still succeeds — a combined payment is legitimate — and returns a warning message: `Assigned. Note that this transaction is now linked to more than its own amount.` A refusal here would block a real case; silence would hide a typo.

### 14.4 Server actions

**MUST-14.11** New actions, following the fixed house order (`isSameOrigin` → `requireUser` → zod → domain → `revalidatePath`):

```ts
// src/app/(app)/warranties/actions.ts
saveLoanRuleAction(_prev, formData): Promise<WarrantyActionState>;    // rate-limited when backfilling
deleteLoanRuleAction(formData): Promise<WarrantyActionState>;

// src/app/(app)/transactions/actions.ts
assignToLoanAction(_prev, formData): Promise<ActionState>;
unassignFromLoanAction(formData): Promise<ActionState>;
```

`readItemInput()` in `warranties/actions.ts` gains three readers (`readPrincipalCents`, `readInterestRateBps`, `readBalanceCents`) beside the existing `readPriceCents` / `readBillingAmountCents`, feeding the widened `warrantyInputSchema`.

**MUST-14.12 (rate limits, and where there deliberately are none).** The loan CRUD and assign/unassign actions carry **no** rate limit, consistent with every existing warranty and transaction action: the threat model is an authenticated household member on a same-origin request, and the repo's only limiters today guard unauthenticated login and outbound egress. The **one** exception is `saveLoanRuleAction` **with the backfill box ticked**, which scans up to a year of transactions:

```ts
// src/lib/loans.ts
export const BACKFILL_WINDOW_MS = 10 * 60_000;
export const BACKFILL_MAX_GLOBAL = 5;
export function checkLoanBackfill(now?: number): RateVerdict;
export function setLoanRateLimitClockForTests(next: (() => number) | null): void;
export function resetLoanRateLimitsForTests(): void;
```

Refused with `Too many backfills. Try again in N minutes.`, and the rule is still saved — only the historical pass is skipped, reported as `Rule saved, but the backfill was skipped: too many in the last few minutes.`

**MUST-14.13** This is the third in-memory bucket in the codebase (notify's, update's, this one). They stay separate because their windows, scopes and reset semantics differ and a shared abstraction over three call sites would be one abstraction and three special cases. If a fourth appears, extract then.

**MUST-14.14** `revalidateAll()` in `warranties/actions.ts` gains `/transactions` and `/reports` to its existing list, because a rule save can move a balance that both pages render.

---

## 15. Loans — dashboard and reports

### 15.1 The dashboard Loans card

**MUST-15.1** `src/components/LoansCard.tsx` (**new**) is a **self-hiding** component in the manner of `ExpiringSoonCard`: `if (loans.length === 0) return null;`, where `loans` is `listLoans()` filtered to items with a non-null `current_balance_cents` **or** a non-null `principal_cents`. The dashboard renders it unconditionally between `ExpiringSoonCard` and the budgets card; a household with no loans sees no card and no gap.

**MUST-15.2** The card shows a header total — `Total owed` with `loansTotalOwedCents()` as a `money-lg` figure — then one row per loan:

- the loan's name and, when `nextPaymentDate` is set, `Next payment <date>`;
- the balance, right-aligned;
- `<LoanProgressBar>` beneath, when `payoffFraction` is non-null;
- `Rate <n.nn>%` in `text-subtle` when set.

**MUST-15.3** `src/components/LoanProgressBar.tsx` (**new**) renders `payoffFraction` as a percentage paid off, with `role="progressbar"` and `aria-valuenow/min/max`, on the same `h-2 w-full overflow-hidden rounded-full bg-surface-3` track `GoalCard` and `BudgetProgressBar` already use. Its fill is `bg-positive-solid` throughout, with no warning band.

It is a separate component rather than a reuse of `BudgetProgressBar` because that component's colour mapping is a **warning system** — green under, amber past 80%, red over — and here more progress is unambiguously good. Bending it would mean a car loan 85% paid off rendering amber. The track markup is copied; the tone logic is not, because the tone logic is the part that is wrong for this use.

**MUST-15.4** `payoffFraction = clamp(1 - balance / principal, 0, 1)` and is `null` unless both are set and `principal > 0`. `nextPaymentDate` is the first date on or after today in the sequence `addMonthsClamped(startDate, k)` for `billing_cycle = 'monthly'` (`k = 1, 2, 3, …`) or `addMonthsClamped(startDate, 12k)` for `'annual'`; it is `null` when `billing_cycle` is null, and it is capped at `expiry_date` when that is set — there is no next payment after the payoff date. `addMonthsClamped` is the existing helper in `src/lib/dates.ts`, so month-end clamping (a loan that started on the 31st) is already solved and no new date arithmetic is written.

### 15.2 The reports debt line

**MUST-15.5** `src/components/charts/DebtTrendChart.tsx` (**new**) is a recharts `LineChart` — the first line chart in the codebase — modelled on `CashflowChart`'s skeleton: same `h-64`, same cents-to-dollars mapping, same `CHART_GRID` / `AXIS_TICK` / `TOOLTIP_CURSOR` / `tooltipStyles()` imports from `src/components/charts/chart-theme.ts`, so it follows the theme toggle with no JS. The single series is `var(--negative-solid)` — this is money owed — and it sets `connectNulls={false}` so a gap in the data reads as a gap (MUST-15.7).

**MUST-15.6** The reports page gains a card titled **Debt over time**, rendered only when `listLoans()` has at least one loan with a non-null balance, using the existing `EmptyState` / `CardBody` ternary the page's other cards use. Below the chart, always visible: *"The line starts when you first recorded a balance for each loan, and is reconstructed by adding back the payments you have linked since."*

**MUST-15.7 (the reconstruction, exactly).** `debtOverTime(months)` returns one point per calendar month, oldest first. For a month whose last day is `E`:

For each loan `L`:
- if `E < date(L.created_at)` → `L` contributes `0`. The loan did not exist; nothing was owed on it.
- else if `L.current_balance_cents IS NULL` or `L.balance_updated_at IS NULL` → `L` contributes `0`. No balance is being tracked; there is nothing to reconstruct and nothing to hide.
- else if `E < date(L.balance_updated_at)` → `L` contributes **unknown**. A person typed a balance after this month, which discarded whatever the balance was before it; anything plotted here would be invented.
- else → `L` contributes `L.current_balance_cents + Σ applied_cents` over `loan_payments` rows for `L` with `date(created_at) > E`.

The month's `owedCents` is the sum of the contributions **unless any loan contributed unknown**, in which case it is `null` and the line breaks. A total that silently drops a loan for some months and includes it for others is a chart that lies about a trend, which is the one thing a trend chart must not do.

**MUST-15.8** The whole series is computed from **two** queries — one over `warranty_items` joined to `warranty_item_types`, one over `loan_payments` grouped by `(item_id, month)` — and then folded in memory over the month axis produced by the existing `monthRange` / `addMonths` helpers, the same pair `cashflowTrend` uses. No per-month query, no N+1.

**MUST-15.9** The reconstruction walks **backwards from the present**, never forwards from the principal. The present balance is the one number a person has verified; the principal is a figure from a contract that may never have matched the first statement.

---

## 16. Compose, install and the update path for existing installs

### 16.1 `install/synology-compose-pull.yml`

**MUST-16.1** The `watchtower` service's environment becomes:

```yaml
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_CLEANUP: "true"
      # HTTP-API mode: Watchtower now updates ONLY when the app asks it to, over the private
      # network these two containers share. Turning this on stops its own daily poll, which is
      # why WATCHTOWER_POLL_INTERVAL is gone -- the app's Settings -> About page is in charge now.
      WATCHTOWER_HTTP_API_UPDATE: "true"
      # This token is a fence between the two containers, not a secret from the internet: the
      # port below is never published to the host, so nothing outside this project's network can
      # reach the endpoint at all. Change it if you like -- it must match WATCHTOWER_TOKEN on the
      # budget-tracker service above, and nowhere else.
      WATCHTOWER_HTTP_API_TOKEN: "budget-tracker-local-update"
      TZ: "America/Toronto"
```

**MUST-16.2** `WATCHTOWER_POLL_INTERVAL` is **removed**. No `ports:` mapping is added, at any point, for any reason: the endpoint listens on 8080 inside the container and is reachable only by service name from the compose network. A published port would put an unauthenticated-by-default container-control endpoint on the LAN.

**MUST-16.3** The `budget-tracker` service's `environment:` gains:

```yaml
      WATCHTOWER_URL: "http://watchtower:8080/v1/update"
      WATCHTOWER_TOKEN: "budget-tracker-local-update"
```

`watchtower` is the compose service name and resolves only on the project network. Both values are literal in the file and must match Watchtower's own.

**MUST-16.4 (the header comment is rewritten).** The file's `UPDATES ARE AUTOMATIC BY DEFAULT` block is replaced, because after this change it would be false. The new block says, in plain English: that updates are now driven from inside the app; that they are **off until an admin turns them on** at Settings → About; that once on, small updates install themselves and major ones ask first; that Watchtower is still here and still holds the Docker socket, but now acts only when the app asks; and that the pinning instructions are unchanged. The existing plain-English `SECURITY NOTE ON WATCHTOWER` block stays, with one added sentence naming the HTTP endpoint and the fact that it is not published to the host.

**MUST-16.5 (the regression this creates, and how it is closed).** An install that adopts the new YAML and never enables update checks receives **no updates at all**, where the old file gave it daily automatic ones. That is a real regression for a person who upgrades their compose and then does nothing, and it is closed deliberately rather than accepted:

- the compose header says so, in the first paragraph;
- `docs/INSTALL-SYNOLOGY.md`'s Updating section says so;
- and on a Watchtower-capable install with checks off, the Updates card's off-state copy (§9.2) is the first thing under the changelog on a page every admin already visits. It is a button, not a document.

A2 in §21.2 is the acceptance check for exactly this path.

### 16.2 Migration for existing installs

**MUST-16.6** `docs/INSTALL-SYNOLOGY.md` gains a **Moving to in-app updates (1.3.1)** block beside the existing "Adopting auto-updates on an existing pre-1.2.3 install" block, with the identical three-step shape, because the mechanism is identical:

1. Container Manager → **Project** → `budget-tracker` → **Stop**.
2. **YAML Configurations** → replace the whole YAML with the current contents of `install/synology-compose-pull.yml`.
3. **Save** / **Build**, then start the project again — then open **Settings → About** and press **Enable update checks**.

Step 3's second half is not optional garnish; it is the step that replaces what the poll interval used to do, and it is written into the numbered list for that reason.

**MUST-16.7** An install that keeps its old compose keeps its daily Watchtower poll and simply has no `WATCHTOWER_URL`, so the app puts it on the §7.4 fallback path: the card checks and reports, and tells the reader to update by hand or to adopt the new compose. Nothing breaks, and the two mechanisms never both fire, because the old compose has no HTTP API to fire.

### 16.3 The manual updaters

**MUST-16.8** `install/update.sh` and `install/update.ps1` are unchanged in behaviour. Their **copy** is amended in one place each: the line `This updater is manual only: no scheduler, no auto-update, no in-app banner.` becomes

```
This updater is manual only: no scheduler, no auto-update. (The prebuilt-image install
has an opt-in in-app update check at Settings -> About; this script is the build-from-
source path and is unaffected by it.)
```

`tests/ops/install.test.ts`'s three assertions on that line are amended to match: `/manual only/i` and `/no auto-update/i` still hold; `/no scheduler/i` still holds; the `/no in-app banner/i` assertion is **replaced** with one requiring the parenthetical to name `Settings -> About`. Leaving a test asserting a sentence the product has outgrown is how a suite starts lying.

**MUST-16.9** `INSTALL.md`'s "**Updates are manual.** Nothing schedules them, nothing auto-updates, and the app never nags you with an 'update available' banner." is rewritten for the build-from-source section it heads, and a new short section above it covers the prebuilt-image path and the opt-in check. `tests/ops/install.test.ts`'s `describes the update flow as manual-only with rollback` assertions are re-scoped to the build-from-source subsection rather than the whole document.

---

## 17. Folded-in chores

These are the items parked at the end of the v1.3.0 build. Each is small; each is listed so none is lost.

### 17.1 Workflow action bumps

**MUST-17.1** `.github/workflows/release-image.yml`: `actions/checkout@v4` → `@v5` (both jobs) and `actions/setup-node@v4` → `@v5`, clearing the Node 24 deprecation warnings. `tests/ops/release-image.test.ts`'s pin assertions already check only `@v\d+$` and the `actions/checkout@v` / `actions/setup-node@v` prefixes, so they pass unchanged. No other action is bumped in this release.

### 17.2 The Dockerfile linter directive

**MUST-17.2** `Dockerfile` line 27 is `ENV SECRET_KEY=build-time-placeholder-secret-key-0123456789`, which BuildKit's `SecretsUsedInArgOrEnv` check flags on every build. The suppression is added as a **parser directive**, which BuildKit requires to be at the very top of the file, before any instruction and adjacent to the existing `# syntax=` line — **not** beside line 27, where a `# check=` comment is inert:

```dockerfile
# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
```

and the comment already above line 27 gains one sentence naming the placeholder explicitly, so the skip is traceable to the thing it excuses:

```dockerfile
# Placeholder so any module that reads env at import time can load during the build. It is
# never baked into the runtime image. This literal is why the file carries
# `# check=skip=SecretsUsedInArgOrEnv` at the top: the value is a fixed, public,
# build-stage-only string, not a credential.
```

**MUST-17.3** `tests/ops/docker.test.ts` gains an assertion that the directive is present, that it appears within the first two lines, and that the runtime stage contains no `ENV SECRET_KEY` — so the skip can never quietly start excusing a real secret in the shipped layer.

### 17.3 The two vacuous tests

**MUST-17.4** Both tests in `tests/app/notifications-actions.test.ts` were rendered vacuous by v1.3.0's pref-wipe fix, which made `savePreferencesAction` skip channels the caller has not configured. Neither test configures a target for the calling user, so **no pref row is written for any reason** and both assertions pass without exercising the rule they name.

- **`MUST-4.3: a member cannot enable an admin-only event`** — currently passes even if `eventsFor()` returned every event. Fixed by adding `saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true })` before the call, **and** by submitting a second, non-admin toggle in the same form. The test then asserts that the non-admin event's row **was** written while `backup_failed`'s was **not** — which is the audience filter, rather than the dormancy skip wearing its name.
- **`MUST-12.4: a forged userId field does not touch another member's prefs or knobs`** — the knobs half is genuine; the prefs half is not. Fixed by the same one-line `saveEmailTarget` for the caller, after which the test asserts both halves: the other member's row is untouched **and** the caller's own row was written.

**MUST-17.5** While fixing them: `'pref:weekly_digest:email': 'off'` is misleading, because `checkbox()` is presence-based and the string `'off'` reads as *checked*. The unchecked case is expressed by **omitting the field**, and both tests are corrected to do so.

### 17.4 The relay-test title

**MUST-17.6** `it('still refuses when no relay has been saved at all — the relay-exists guard runs before quota is spent')` asserts only the error string; swapping the guard and the limiter in `runTest` would leave it green. It is fixed by making the body prove the title: after the refusal, save a relay and a target and assert the caller still has all three test sends, exactly as the two tests above it already do. The title stays; the body earns it.

### 17.5 The dead relay re-check

**MUST-17.7** In `runTest` in `src/app/(app)/settings/notifications/actions.ts`, the email branch re-reads the relay and returns the no-relay error a third time (`const relay = getSmtp(); if (!relay) return {...}`). That branch is **unreachable**: every path reaching it has already proved the relay exists, and there is no `await` on any I/O in between — better-sqlite3 is synchronous and `checkTestSend` is an in-memory call — so the TOCTOU window its original justification invoked does not exist.

The fix hoists the single `getSmtp()` read above the `if (opts.relayOnly)` split into one `relay` binding used by both the guard and the send, removing one redundant query and one unreachable branch, and dropping the third copy of the `'An admin needs to set up outbound email before this can send.'` literal (which the file writes three times). The literal is promoted to a module constant, `NO_RELAY_ERROR`, matching the `NO_RELAY` constant `notifications-client.tsx` already declares for the same sentence.

**MUST-17.8** The relay re-read in `outbox.ts`'s `buildRequest` is **live and mandated** by notify MUST-7.5's pre-send revalidation — enqueue and pump are separated in time, so it genuinely fires. It is not touched, and a comment says why, so the next reader does not "clean up" a load-bearing check by analogy with this one.

---

## 18. Versioning and release

**MUST-18.1** `package.json` `version` → **`1.3.1`**. It remains the single source of truth: `src/lib/version.ts` imports it at build time, the footer and Settings → About render it, `/api/health` reports it, the update scripts print it, and — new in this release — `runUpdateCheck` compares against it and `reconcileApplyOnBoot` matches against it.

**MUST-18.2** The number is `1.3.1` by the owner's decision. Under strict semver a release that adds features is a minor, and this one adds two; the label is the owner's to set and it is set. Nothing in the implementation depends on it, with one exception worth naming: `classify()` will report a **patch** update to anyone moving from 1.3.0 to 1.3.1, which means an install with auto-apply on takes this release unattended. That is the intended outcome and it is the reason the release-notes entry leads with the compose change (MUST-16.5) rather than burying it.

**MUST-18.3** `CHANGELOG.md` gains `## [1.3.1] - 2026-08-17` in Keep-a-Changelog style with a fresh empty `## Unreleased` above it:

- **Added** — opt-in in-app update checks with automatic small updates and a review screen for major ones; loan money-tracking (principal, rate, balance) with automatic payment matching, a dashboard Loans card and a debt-over-time report.
- **Changed** — the prebuilt-image compose file now drives Watchtower from the app instead of polling daily; existing installs keep working and are shown how to move over.
- **Fixed** — the folded-in chores of §17.

**MUST-18.4** Settings → About needs no change to render the new entry — it reads `CHANGELOG.md` at request time — but it **does** gain the Updates card above it (§9), which is a separate component in a separate file.

**MUST-18.5** `README.md` and `INSTALL.md` gain: the third opt-in egress exception naming `api.github.com` (MUST-8.3); the two new environment variables with their "optional, prebuilt-image installs only" framing; and the update-path rewrite of §16.3. `.env.example` gains `WATCHTOWER_URL` and `WATCHTOWER_TOKEN` **commented out**, with a one-line note that they are set by the prebuilt-image compose file and are not needed for a build-from-source install.

---

## 19. Testing

Vitest, colocated under `tests/` mirroring the source layout. Every requirement above is written to be testable; the list below is the minimum, not the ceiling.

**MUST-19.1 (the network gate).** No test performs real network I/O. `tests/lib/update/**` stubs `globalThis.fetch` and asserts in an `afterEach` that no unexpected host was contacted. `src/lib/update/github.ts` and `watchtower.ts` are exercised through the stub; there is no live-network test in the suite and no `it.skipIf(offline)` escape hatch.

### 19.1 Update — unit, `tests/lib/update/`

- **`semver.test.ts`** — `parseSemver` accepts `1.4.0` and `v1.4.0`, rejects `1.4`, `1.4.0.1`, `1.4.0-rc.1`, `1.4.0+build`, `latest`, `''` and a 40-character string; `compareSemver` orders correctly across all three components; `classify` returns each of the four values, including `'none'` for an equal pair and for a **lower** remote (a downgrade is never an update).
- **`egress.test.ts`** — `assertGithubUrl` accepts the two exact URLs and rejects: `https://api.github.com.evil.com/...`, `http://api.github.com/...`, `https://user@api.github.com/...`, `https://api.github.com/repos/VibeLogicCode/BudgetTracker/issues`, `.../contents/README.md`, a `?ref=main` query, a `?ref=v1.4.0&x=1` query, and a fragment. `assertWatchtowerUrl` accepts `http://watchtower:8080/v1/update`, `http://localhost:8080/v1/update`, `http://192.168.1.9:8080/v1/update`, `http://[::1]:8080/v1/update`; rejects `http://evil.example.com/v1/update`, `https://8.8.8.8/v1/update`, `http://watchtower:8080/v1/update?x=1`, `http://watchtower:8080/`, `ftp://watchtower/v1/update`, and `http://u:p@watchtower:8080/v1/update`.
- **`github.test.ts`** — the two request URLs, methods and headers exactly; **no `Authorization` header is present**; `redirect: 'error'`; the 15 s abort; 401/403/404/422 → permanent, 429/500/network → transient; a `tag_name` of `nightly` produces the MUST-4.6 permanent error and **no** classification; a changelog `size` over 512 KiB is refused; `encoding: 'utf-8'` is refused; the decoded body round-trips through `parseChangelog` and the bounding of MUST-4.8 truncates a 400-item release to 200.
- **`watchtower.test.ts`** — the request is a `GET` to the configured URL with `Authorization: Bearer <token>`; `watchtowerConfig()` returns null when either var is absent, when either is empty, and when the URL fails the guard; a 2xx → `'accepted'`; a 401 → a permanent error whose message contains **no substring of the token**; an `AbortError` after the request → `'accepted-unconfirmed'`, with `update.last_apply_error` left unset.
- **`state.test.ts`** — every key round-trips; `readUpdateState()` on a virgin database returns `enabled: false, autoApply: false` and all-null; `autoApply` is forced false while disabled (MUST-3.5); `clearUpdateState()` leaves exactly one `update.` row, `checks_enabled = '0'` (MUST-3.4); `reconcileApplyOnBoot` confirms a matching version, times out a stale request past 30 minutes, and leaves a fresh mismatched one pending.
- **`check.test.ts`** — each of MUST-5.7's five outcomes, driven by a stubbed release and a stubbed `APP_VERSION`; a major **never** applies even with `autoApply` on and Watchtower present (MUST-5.8); `update.last_checked_at` is written on a **failed** check (MUST-5.5); a second `runUpdateCheck` inside 24 h from the tick is skipped and from the button is not (MUST-5.6); a dismissed version still enqueues nothing new and still checks (MUST-5.9).
- **`ratelimit.test.ts`** — the sixth Check-now in a window is refused; the fourth Apply in an hour is refused; the three buckets are independent; all recover after their windows; the clock seam works without real waiting.

### 19.2 Update — event and scheduler

- `tests/lib/notify/events.test.ts` — the registry is now **nine** entries; `update_available` is admin-audience and default-on; `eventsFor('member')` excludes it; ids remain unique and match `/^[a-z][a-z0-9_]*$/`.
- `tests/lib/notify/render.test.ts` — the three `update_available` bodies (major, patch-with-apply, patch-without-apply) against fixed inputs; no body contains `http`; the version strings render exactly.
- `tests/lib/notify/dedup.test.ts` — `updateAvailableKey` fires once per version; a second check at the same version enqueues nothing; a newer version enqueues again; and the 400-day regeneration case of MUST-6.3 is asserted **as specified behaviour**, not as a bug.
- `tests/lib/scheduler.test.ts` — `runUpdateTick` returns before any GitHub call when checks are disabled (spied on a fake fetch); it returns before a call when the last check was 23 hours ago and proceeds at 25; the cron callback calls it **before** `runNotifyTick`; a throwing `runUpdateCheck` does not prevent `runNotifyTick` from running; **the existing notify dormancy assertion is unchanged and still passes** (MUST-5.3); `stopScheduler()` resets `updateTicking`.
- `tests/ops/restore-seams.test.ts` — `reconcileApplyOnBoot()` is called after `getDb()` and before `startScheduler()` in `src/instrumentation-node.ts`, and `applyStagedRestoreOnBoot()` is still the file's first statement.

### 19.3 Update — actions and client, `tests/app/`

- **`update-actions.test.ts`** (**new**) — all six actions reject a cross-origin request **before** anything else; all six reject a member; no action accepts a `userId` (asserted on `Function.length` and on the parsed form keys); `applyUpdateAction` refuses a version that is not `update.latest_version` with MUST-9.7's sentence; a rate-limited action performs **no** fetch; no returned state contains any substring of `WATCHTOWER_TOKEN`; `disableUpdateChecksAction` leaves exactly one `update.` settings row; `enableUpdateChecksAction` records the caller's id.
- **`updates-card.test.tsx`** (**new**) — the off state renders MUST-9.3's copy and exactly one button; the on state renders the status line, the severity badge, the timestamp in `iso.slice(0,16)` form, and the correct primary control for each of MUST-5.7's outcomes; with no Watchtower the apply button is **absent** (not disabled) and §7.9's copy is present; the review panel renders the remote changelog through `renderEmphasis` and renders `<b>x</b>` in a bullet as literal text; MUST-9.8's three sentences; a member's `/settings` renders no Updates card at all.

### 19.4 The registry-extension proof

**MUST-19.2** `tests/app/notifications-client.test.tsx` gains: the toggle matrix renders a row for `update_available` for an **admin** with **no component change**, and does not render it for a member. This is the executable form of MUST-6.2 and it is the point of the whole registry design.

### 19.5 Loans — database, `tests/db/loan-schema.test.ts` (new)

The migration applies cleanly on top of `0000`–`0006`; `_journal.json` idx/when/tag match MUST-11.2; the four columns exist on `warranty_items` with the right types and are physically last (`pragma table_info`); both tables and all five indexes exist; a negative `principal_cents` / `current_balance_cents` is rejected; an `interest_rate_bps` of `1000001` is rejected; a two-character `merchant_contains` is rejected; a duplicate `(item_id, merchant_contains, NULL)` is rejected **twice over** (proving the `coalesce` expression index, which a plain unique index would not catch); a duplicate `(txn_id, item_id)` is rejected; `applied_cents > amount_cents` is rejected; `source = 'auto'` is rejected; deleting a transaction cascades its links; deleting an item cascades its links and rules; deleting an account nulls nothing and cascades the rule.

**MUST-19.3** A test asserts `drizzle/0007_loans.sql` contains the statement-breakpoint marker **only** as a separator — comment lines stripped, marker count compared before and after — the same assertion AC6 makes for 0006.

### 19.6 Loans — unit, `tests/lib/`

- **`loans/matcher.test.ts`** — a matching transaction creates one link and decrements the balance; running the matcher twice over the same id creates nothing the second time and decrements nothing (MUST-11.15); a positive-amount transaction, a transfer, and an already-linked transaction are all skipped; two rules matching one transaction produce **one** link, from the lower rule id (MUST-13.4); an account-scoped rule ignores another account's transaction; matching is case-insensitive against the uppercasing normalizer (MUST-11.11); a payment larger than the balance clamps to zero with `applied_cents` recording the clamped figure (MUST-13.6); a matcher that throws internally returns 0 and does not propagate (MUST-13.5); with zero loan rules the function performs exactly one query.
- **`loans/reversal.test.ts`** — unassign restores the exact balance in the clamped case, the zero-balance case and the ordinary case; `undoImport` restores balances for `sole` transactions and leaves `shared` ones linked; a round trip of import → match → undo → re-import → match leaves the balance exactly where it started.
- **`loans/backfill.test.ts`** — off by default; on, it links only inside the 365-day window; it stops at 500; it reports its count and the total applied; the rate-limit refusal still saves the rule.
- **`loans/summary.test.ts`** — `payoffFraction` is null without a principal, null at `principal = 0`, `0` at full balance, `1` at zero balance, and clamped when a balance somehow exceeds the principal; `nextPaymentDate` for monthly and annual, for a loan started on the 31st (`addMonthsClamped`), null with no cycle, and null past `expiry_date`; `loansTotalOwedCents` sums only non-null balances.
- **`loans/debt-over-time.test.ts`** — MUST-15.7 clause by clause: a month before the item existed contributes 0; a month before `balance_updated_at` makes the point `null`; a month after it equals balance plus the payments since; two loans where one is unknown makes the whole point `null`; a direct balance edit today truncates the series to today and the older months become `null`; the series is computed in two queries (asserted with a query counter).
- **`warranty/constants.test.ts`** — `billingAllowedForKind('loan')` is now true and `('warranty')` is still false; the three new billing helpers return the MUST-12.3 table for all four kinds; `billingCycleSuffix` **no longer exists** (an import of it is a type error, asserted by a compile-time check in the test file).
- **`warranty/items.test.ts`** — a loan may now save a billing pair and a warranty still may not, with the reworded error; the balance/anchor pairing rule rejects a balance with no anchor and an anchor with no balance (MUST-11.7); the rate round-trips through basis points; a rate of 100.01% is rejected.
- **`warranty/types.test.ts`** — flipping a type from `loan` to `warranty` clears all four money fields and the billing pair, deletes the rules and **keeps** the payments, all in one transaction; flipping `loan` → `subscription` keeps the billing pair and clears only the money fields.

### 19.7 Loans — actions and client, `tests/app/`

- **`warranties-actions.test.ts`** — the three loan readers parse and round-trip; the rule actions reject cross-origin first; the sixth rule on a loan is refused; a duplicate rule returns the translated message; `revalidateAll` covers `/transactions` and `/reports`.
- **`transactions-actions.test.ts`** — `assignToLoanAction` links and decrements; assigning twice to the same loan is a no-op; assigning to a second loan is allowed and returns MUST-14.10's warning; `unassignFromLoanAction` restores exactly; both reject cross-origin first; both reject a nonexistent id without a 500.
- **`transactions-client.test.tsx`** — with no loans, the assign control is absent entirely; with loans, an unlinked row renders the select and a linked row renders the name and Unassign; a transfer row renders neither.
- **`warranty-detail-client.test.tsx`** / **`new-warranty-client.test.tsx`** — the loan fieldset appears only for a loan-kind type and disappears live when the type select changes; the Payment matching card is loan-only; the billing labels read `Payment` / `Payment amount` / `per month` for a loan and `Billing` / `Amount` / `/ month` for a subscription.
- **`loans-card.test.tsx`** (**new**) — renders nothing with no loans; renders the total, per-loan rows, the payoff bar with the right `aria-valuenow`, and omits the rate row when unset.

### 19.8 Regression guards

**MUST-19.4** Three grep-shaped invariant tests, in the style of the existing `console.*` and restore-seam checks:

1. `tx.delete(transactions)` appears exactly once in `src/`, in `undoImport` (MUST-13.16), with a failure message naming `reverseLoanLinksForTransactions`.
2. `src/lib/loans.ts` contains no arithmetic operator applied to `interestRateBps` (MUST-13.1).
3. `src/lib/budgets.ts`, `src/lib/reports.ts` and `src/lib/categorize/engine.ts` contain no reference to `loan_payments` or `loanPayments` (MUST-13.2).

### 19.9 Integration

**MUST-19.5** `tests/integration/loan-flow.test.ts` (**new**), against a temp SQLite file: create a loan type and a loan item with a principal, a rate, a balance and a monthly payment → add a matcher rule with backfill off → import a CSV containing two matching payments and one non-matching → balance drops by exactly the two payments, the category total is unchanged, the dashboard summary and the debt series both agree → undo the import → the balance is exactly what it was → re-import → the balance drops again by the same amount → manually assign an unrelated transaction → unassign it → the balance is unchanged end to end.

**MUST-19.6** `tests/integration/update-flow.test.ts` (**new**), with a stubbed fetch: checks disabled → a boot plus twelve simulated ticks perform **zero** fetches → enable → one tick fetches once → a second tick within 24 h fetches nothing → a stubbed 1.3.2 release with auto-apply on fires exactly one Watchtower request and enqueues no notification → a stubbed 2.0.0 release fires **no** Watchtower request and enqueues one `update_available` for the admin only → the review action fetches the changelog at `?ref=v2.0.0` → the apply action refuses a stale version → disable → the state is cleared and further ticks fetch nothing.

---

## 20. Acceptance criteria

### 20.1 Automated (must all pass before release)

- **AC1** `npm test` green, including every test in §19.
- **AC2** `npm run typecheck` clean under `strict`.
- **AC3** `tests/ops/notify-egress.test.ts` passes with its §8.4 amendments — the only URL literals in the two egress trees are `api.telegram.org` and `api.github.com`; every `fetch(` site is one of the five allowed; each is preceded by its assert.
- **AC4** With update checks disabled: a full boot plus twelve simulated ticks produce **zero** `fetch` invocations from `src/lib/update/` (MUST-19.6's first clause).
- **AC5** With no loan matcher rules: a 500-row CSV import performs exactly one extra query on account of loans, and no `loan_payments` row is written.
- **AC6** `drizzle/0007_loans.sql` contains the statement-breakpoint marker only as a separator (MUST-19.3), and contains no `update`-feature object (MUST-3.1).
- **AC7** No `console.*` call in `src/lib/update/` interpolates a token or an `Authorization` value, and no returned action state contains a token substring (MUST-8.8 item 8).
- **AC8** A major version never auto-applies: a property-style test over 200 generated version pairs asserts `classify(...) === 'major'` implies zero Watchtower requests, for every combination of `autoApply` and Watchtower presence.
- **AC9** `tests/ops/release-image.test.ts` passes with its amended Watchtower assertions — `WATCHTOWER_HTTP_API_UPDATE: "true"` present, `WATCHTOWER_HTTP_API_TOKEN` present, `WATCHTOWER_POLL_INTERVAL` **absent**, no `ports:` block in the watchtower service, and the app service carrying both `WATCHTOWER_URL` and `WATCHTOWER_TOKEN` with values matching the token.
- **AC10** `tests/ops/install.test.ts` passes with its MUST-8.9 and §16.3 amendments — the app-wide `fetch()` allowlist names the two update files, and the renamed opt-in block asserts `src/lib/scheduler.ts` still shells out to nothing and still contains `isUpdateCheckEnabled`.

### 20.2 Manual (documented QA checklist, run once per release)

- **A1** Fresh install, never open Settings → About: a network capture on the host shows no traffic to `api.github.com` over an hour, and `docker logs` shows no `[update]` line.
- **A2** Replace an existing pull-install's compose with the new file and start it. **Without touching anything else**, confirm the app comes up healthy, Watchtower is running, and no update happens. Then open Settings → About, press **Enable update checks**, and confirm the card moves to its on state and reports the current version as up to date. This is MUST-16.5's acceptance run and a tester who cannot find the button is a copy bug, not a tester problem.
- **A3** Publish a patch release to GHCR. With auto-apply on, wait for the daily tick (or press **Check now**) → the app is replaced and comes back on the new version within a few minutes, Settings → About shows the new number, and `update.last_applied_at` is set. Confirm the browser showed MUST-9.8's `accepted` or `accepted-unconfirmed` sentence and never a red error.
- **A4** Repeat A3 with auto-apply **off** → nothing is applied, the card offers **Update now**, and (with a Telegram or email channel configured) the `update_available` message arrives naming the version.
- **A5** Publish a major-numbered release → **nothing is applied under any setting**. The card offers **Review and update**; pressing it shows that version's actual changelog section; the confirm button's label carries the version. Cancel → nothing happens. Confirm → the update proceeds.
- **A6** Break `WATCHTOWER_TOKEN` in the app service only → **Update now** fails with the token message, the message contains no fragment of either token, and the app stays up.
- **A7** Remove the watchtower service entirely → the card checks and reports normally and shows §7.9's fallback copy with no apply button anywhere on the page.
- **A8** Disable update checks → every `update.` row but the flag is gone, the card returns to its off state with no cached version, and an hour's network capture is silent again.
- **A9** As a member: `/settings` shows no Updates card, and no update action succeeds from a crafted request.
- **A10** Create a loan item with a principal, a rate, a balance and a monthly payment. Confirm the form says **Payment** and **per month**, not **Billing** and **/ month**.
- **A11** Add a matcher rule with backfill **off**, then import a statement containing two payments → the balance drops by exactly those two, both appear as linked on the transactions page, and the category's budget number is **unchanged**.
- **A12** Undo that import → the balance returns to exactly its previous value, to the cent, including the case where one payment was larger than the remaining balance.
- **A13** Add a rule with backfill **on** against a year of history → the count in the success message matches the number of linked rows, and the balance drops by the reported total.
- **A14** Assign an unrelated transaction to a loan by hand, then unassign it → the balance is unchanged end to end and the row's control returns to the select.
- **A15** Dashboard: the Loans card shows the total, a payoff bar that matches the numbers, and the next payment date. Delete every loan's money fields → the card disappears entirely rather than rendering empty.
- **A16** Reports: the debt line starts at the month of the oldest balance you recorded, breaks where a loan's history is unknown, and the sentence under it explains why.
- **A17** Change a loan type's kind to Warranty → the money fields and the matching rules are gone, the payments the household made are still visible on the transactions page, and nothing 500s.
- **A18** Restore a pre-1.3.1 backup → the app boots, the four columns and two tables exist and are empty, no loan card appears, and update checks are off.

---

## 21. Decisions taken on the owner's behalf

Each is a single constant or a one-paragraph change if the owner wants it different.

1. **Update state lives in the `settings` key/value table**, so the update feature ships with no migration and absence is the off state (MUST-3.1).
2. **Disabling checks wipes every other `update.` key** (MUST-3.4). Off means off, not paused.
3. **`/releases/latest`, not `/tags`.** Tags include anything anyone pushed; the latest release is a deliberate act by the maintainer.
4. **The changelog is fetched pinned to the release's tag** (`?ref=v<version>`), so the notes shown are the notes for the version being offered.
5. **A tag that fails strict semver is never auto-applied** and is reported as a check error (MUST-4.10). Pre-releases and build metadata are refused outright.
6. **Severity is computed in the app from two version strings**, never read from the release payload (MUST-4.11).
7. **One check per 24 hours, counted from every attempt including failures** (MUST-5.5), so a crash loop cannot become a request storm.
8. **A manual check ignores the interval but still resets it**, and still applies a small update if auto-apply is on (MUST-5.6, MUST-10.6).
9. **`runUpdateTick` is a separate function with its own gate**, so notify's dormancy bail is untouched and each feature's zero-egress claim stands alone (MUST-5.3).
10. **`update_available` is admin-audience and default-on**, and fires only when the app will *not* apply the update itself.
11. **The 400-day pruning edge is documented rather than engineered away** (MUST-6.3): one extra reminder after 400 days of ignoring an update is correct behaviour.
12. **Watchtower is called with `GET`**, matching its own documented invocation, because the endpoint's contract is Watchtower's to define.
13. **A dropped connection after the request is `accepted-unconfirmed`, not a failure** (MUST-7.5), with a boot reconciler to close the loop (MUST-7.6).
14. **`WATCHTOWER_POLL_INTERVAL` is removed**, per the owner's API-only decision, and the resulting "no updates until you enable them" regression is closed with copy and a one-click button rather than accepted (MUST-16.5).
15. **The Watchtower token is a fixed literal in the compose file.** The port is never published; the fence is the network, and the token is the second fence. Both are documented in plain English in the file.
16. **Watchtower is exempt from the egress list, and the exemption is enforced** by `assertWatchtowerUrl`'s non-public-host rule rather than asserted in prose (MUST-8.2, MUST-8.6).
17. **No apply button when there is no apply path** — absent, not disabled (MUST-7.8).
18. **Update rate-limit buckets are global, not per-user**, because the contended resource is the install (MUST-10.8).
19. **Warranty §17 item 29 is reversed.** Loans carry money. Interest **math** remains out of scope, and the rate is display-only with a grep test to keep it that way (MUST-13.1).
20. **The billing-kind rule is widened by one predicate** because 0005 put it in the app layer; no table rebuild, no DDL (MUST-11.6).
21. **The balance/anchor pairing rule is also app-layer**, because a cross-column CHECK added by `ALTER TABLE ADD COLUMN` would be weaker than it looks (MUST-11.7).
22. **`loan_payments` carries two amount columns.** `amount_cents` is the honest record; `applied_cents` makes reversal exact in every clamping case (MUST-11.14).
23. **`balance_updated_at` is the human anchor only** — payments never touch it — which is what makes the debt reconstruction well-defined (MUST-11.8).
24. **Backfill is opt-in and unchecked by default** (MUST-13.9), because the common case is typing today's balance and backfilling would subtract payments it already accounts for.
25. **The rule path creates at most one link per transaction; only a person can create a second** (MUST-13.4, MUST-11.16).
26. **A month where any loan's history is unknown plots nothing** rather than a total over a shifting subset (MUST-15.7).
27. **The debt series is reconstructed backwards from the present**, never forwards from the principal (MUST-15.9).
28. **Loan payments stay in their category and in every budget** (MUST-13.2), asserted by both a behavioural test and a grep invariant.
29. **`billingCycleSuffix` is deleted rather than wrapped**, following warranty §19.12's Reviewer-Issue-1 precedent, so wording lives in exactly one place.
30. **A separate `LoanProgressBar`** rather than bending `BudgetProgressBar`, whose colour mapping is a warning system that would render an 85%-paid loan amber (MUST-15.3).
31. **No rate limit on ordinary loan actions**, matching every existing warranty and transaction action; one bucket on the backfill, which is the only expensive one (MUST-14.12).
32. **Three separate in-memory limiters, no shared abstraction yet.** Extract at the fourth (MUST-14.13).
33. **The Dockerfile check directive goes at the top of the file**, where BuildKit actually reads it, with the explanatory comment staying at line 27 (MUST-17.2). A `# check=` beside the `ENV` would be inert and would look like it worked.
34. **`install.test.ts`'s "no auto-update anywhere" block is renamed and tightened, not deleted** (MUST-8.9). A block whose title contradicts the product is worse than no block.

---

## 22. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | An update check becomes a phone-home, or a future contributor adds a fourth destination | `src/lib/update/egress.ts` is the only place a `://` literal may live under that tree; `tests/ops/notify-egress.test.ts`'s amended, table-driven invariant (§8.4) fails the build on any new literal, `fetch` site, or missing assert. MUST-4.3 pins the exact headers, and AC7 pins what may be logged |
| R2 | Watchtower's `/v1/update` is reachable from the LAN and lets anyone restart the household's app | No `ports:` mapping, ever (MUST-16.2); `assertWatchtowerUrl` refuses every public host (MUST-8.6); the token is a second fence; both facts are stated in the compose file and in INSTALL.md so the claim is auditable rather than assumed |
| R3 | An auto-applied update breaks the install unattended | Majors never auto-apply, under any setting, guarded before the apply branch (MUST-5.8) and asserted over 200 generated version pairs (AC8). Patch/minor auto-apply is itself a toggle. Migrations already run on boot and the healthcheck already gates the container |
| R4 | The apply request never returns and the UI reports a false failure on the last screen before a successful update | MUST-7.5's `accepted-unconfirmed` outcome, MUST-7.6's boot reconciler with a 30-minute timeout, and MUST-9.8's three fixed sentences. No spinner, no polling a container that is going away |
| R5 | Adopting the new compose silently ends the automatic updates a household relied on | Called out as a regression, not glossed (MUST-16.5): the compose header, `INSTALL-SYNOLOGY.md`'s numbered step 3, and the off-state card on a page every admin visits. A2 is the acceptance run |
| R6 | The remote changelog is attacker-controlled text rendered in the app | Fetched server-side only; parsed by the existing pure `parseChangelog`; rendered by the existing bold-run renderer; bounded to 12 groups / 200 items / 500 characters each (MUST-4.8); no markdown library, no `dangerouslySetInnerHTML`. A test renders `<b>x</b>` in a bullet and asserts it appears literally |
| R7 | The Watchtower token leaks into a log, a `last_apply_error`, or a page prop | `scrubSecrets` from the existing notify crypto module on every apply path (MUST-10.11); the card receives `canApplyInApp: boolean` and nothing else (MUST-7.3); AC7's grep assertion; a unit test asserts a 401's message contains no token substring |
| R8 | A loan balance drifts from reality after an import undo, and the household stops trusting the number | `applied_cents` makes reversal exact in every clamping case (MUST-11.14); the reversal runs **before** the delete inside the same transaction (MUST-13.14); a grep invariant pins `tx.delete(transactions)` to one site (MUST-13.16); `tests/lib/loans/reversal.test.ts` runs the full import → match → undo → re-import round trip and A12 repeats it by hand |
| R9 | A new matcher rule silently subtracts a year of payments from a balance that already accounted for them | Backfill is off by default and its hint names both cases explicitly (MUST-13.9); the success message reports the count **and** the total applied, so the mistake is visible immediately rather than discovered a month later; unassign and rule-delete are both available |
| R10 | Two rules match one payment and the balance drops twice | The rule path creates at most one link per transaction, "first rule by id wins", enforced by a skip on any existing link plus a first-match break (MUST-13.4), with a dedicated test |
| R11 | The debt chart shows a plausible but invented history | The reconstruction is defined clause by clause (MUST-15.7) and refuses to plot a month it cannot derive; the sentence under the chart says where the line comes from; a manual balance edit truncating the series is a tested case, not a surprise |
| R12 | Widening the billing rule needs a SQLite table rebuild, which is the one migration shape this repo has no precedent for | It does not: 0005 deliberately put the kind rule in the app layer and said why. The change is one predicate (MUST-11.6), and the migration is four `ADD COLUMN`s and two `CREATE TABLE`s with no rebuild anywhere |
| R13 | Reversing warranty §17 item 29 leaves two specs disagreeing about whether loans carry money | The reversal is stated in this spec's preamble, in §12's opening, in the migration header comment, and in the warranty spec's revision history when this ships. One decision, four places a reader could be standing |
| R14 | `update_available` proves nothing about MUST-4.4 because the implementer edits something extra | MUST-6.2 enumerates the three files that may change and §19.4 asserts the matrix gains a row with no component edit. The claim is discharged by a test, not by a paragraph |

---

## 23. Out of scope (explicitly deferred)

**Updates:** rollback of an applied update from inside the app (the shell updaters keep their `budget-tracker:previous` tag; the container path relies on re-pinning a version tag in compose); update channels or betas; scheduling an update for a chosen hour; a maintenance-window setting; showing the diff between two versions; verifying image signatures or provenance attestations; any registry other than GHCR; any check host other than `api.github.com`; a Watchtower-less apply path (writing compose, touching the Docker socket, or self-restarting); and an `update_applied` notification event confirming a completed update — the card and the changelog already say which version is running.

**Loans:** amortization schedules and payment breakdowns; interest accrual of any kind; payoff-date projection from the payment history; extra-payment and refinance what-ifs; escrow, fees, or per-payment principal/interest splits; multi-currency; lenders as first-class records; a loan account type in `accounts`; automatic balance reconciliation against an imported statement balance; per-loan attachments beyond the receipts every item already supports; a loan-specific report page; and treating a loan payment as a transfer or excluding it from budgets, which §13.1's MUST-13.2 rules out on purpose rather than defers.

---

## Revision history

- **v1.0** (2026-08-17): initial approved design. Ships as **v1.3.1**. Two features. **Updates:** opt-in checks against `api.github.com` (two pinned endpoints, no auth, no migration — state lives in the `settings` table), semver classified in-app, patch/minor auto-applied through Watchtower's HTTP API on the compose network, majors never auto-applied and instead raising the new `update_available` registry event plus a review-and-confirm screen showing the offered version's own changelog. `api.github.com` becomes the third opt-in egress destination; Watchtower is exempted by an enforceable non-public-host guard rather than by assertion, and `tests/ops/notify-egress.test.ts` is generalised to cover both egress trees. **Loans:** `drizzle/0007_loans.sql` (idx 7, `when` 1755820800000) adds four nullable money columns to `warranty_items` and the `loan_matcher_rules` / `loan_payments` tables; the billing-kind rule is widened by one app-layer predicate with no table rebuild; balances move by matcher rule, by manual assign, or by direct edit, with `applied_cents` making every reversal exact and import-undo restoring them before the cascade; a self-hiding dashboard card and the codebase's first line chart. Warranty §17 item 29 is reversed. Folds in the five v1.3.0 parked chores.
