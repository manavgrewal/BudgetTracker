# In-app Updates and Loan Money-Tracking Implementation Plan (v1.3.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two features that share nothing but a version number. **(1) The update experience** — an opt-in daily check against `api.github.com`, classified by a pure in-app semver comparator, with patch/minor auto-apply through Watchtower's HTTP API on the compose network and an explicit review-and-confirm screen for majors, all dead until an admin presses one button. **(2) Loan money-tracking** — principal, display-only rate, balance and payment linkage on loan-kind items in Contracts & Coverage, with matcher rules that decrement the balance from the bank export, exact reversal on undo, a self-hiding dashboard card and a debt-over-time report. Plus the five chores parked at the end of the v1.3.0 build.

**Architecture:** The update feature adds **no migration at all** — every byte of its state is a key/value row in the existing `settings` table, and absence is the off state (MUST-3.1). A new library tree `src/lib/update/` holds two pure modules (`semver.ts`, `egress.ts`), two egress modules (`github.ts`, `watchtower.ts`), a settings-backed `state.ts`, an in-memory `ratelimit.ts` and the `check.ts` orchestrator; `src/lib/scheduler.ts` gains `runUpdateTick()` on the existing `NOTIFY_TICK_CRON` callback with its own independent dormancy gate, deliberately *not* folded into `runNotifyTick`'s bail. One new registry event, `update_available`, discharges notify MUST-4.4 by proving an event can be added with no migration, no `src/db/schema.ts` change and no UI edit. Loans arrive in `drizzle/0007_loans.sql` (journal idx **7**, `when` **1755820800000**): four nullable money columns on `warranty_items` by `ALTER TABLE ADD COLUMN`, plus `loan_matcher_rules` and `loan_payments`, whose `UNIQUE (txn_id, item_id)` index *is* the idempotency guard. A new `src/lib/loans.ts` owns the matcher, the manual assign/unassign, the exact reversal and the debt reconstruction.

**Tech Stack:** Node 22, Next.js 15 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, better-sqlite3 12, Drizzle ORM 0.x, zod 3, node-cron 3, nodemailer, recharts, Vitest 3 — all unchanged. **Zero new runtime dependencies:** GitHub and Watchtower are one `fetch` each, and the debt chart reuses the existing `recharts`.

**Spec:** `docs/superpowers/specs/2026-08-17-update-loans-design.md` (the design; `MUST-n.m` labels below are its requirement numbers, and bare `§n` references are its sections). Base specs: `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (master), `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md` (*warranty §n*) and `docs/superpowers/specs/2026-08-17-notifications-design.md` (*notify §n*).

## Global Constraints

These are the spec's project-wide rules, copied verbatim from the sections named. They bind **every** task below; a task that violates one is wrong even if its own tests pass.

- **Update dormancy (MUST-1.1, verbatim).** "Update checks are **dead until an admin enables them**. With `update.checks_enabled` absent or `'0'`, the app makes **zero** outbound connections on account of updates — no DNS lookup, no probe, no 'is there a newer version' call at boot. This is the same structural stance notify §1.1 takes and the same one §12 (SimpleFIN) takes:
  - The enable flag lives in the existing `settings` key/value table and is **absent** on every install, new or upgraded (§3.1). Nothing seeds it.
  - `runUpdateTick()`'s **first** statement is the enable check (§5.2); when it is off the tick returns before touching any check, classifier, notifier or apply path.
  - The only host the feature may ever contact is `api.github.com`, plus the Watchtower endpoint on the compose network, which is not the internet (§8)."
- **MUST-1.2 (verbatim).** "An install that never presses 'Enable update checks' behaves, network-wise, exactly as v1.3.0 did."
- **MUST-1.3 (verbatim).** "Loan money-tracking adds **no** outbound connection of any kind, ever. It is entirely local data."
- **No migration for the update feature (MUST-3.1, verbatim).** "The update feature adds **no table, no column and no migration**. All of its state is key/value rows in the existing `settings` table, read and written through the existing `getSetting` / `setSetting` / `deleteSetting` helpers in `src/lib/settings.ts`. `drizzle/0007_loans.sql` is a **loans-only** migration; a test asserts it contains no string matching `/update/i` outside its header prose."
- **Migration discipline (MUST-11.1, verbatim).** "Migrations are **append-only and hand-authored**. `drizzle-kit generate` is never run: there is no `0000_snapshot.json`, so it would diff against an empty baseline and re-emit the whole schema. The order of work is fixed: 1. hand-author `drizzle/0007_loans.sql`; 2. append the journal entry; 3. mirror the columns and tables in `src/db/schema.ts`."
- **Statement breakpoints (MUST-11.3, verbatim).** "The drizzle statement-breakpoint marker separates statements and appears **nowhere else in the file** — not in the header comment, not in an inline comment. The splitter is comment-blind: it splits on that marker wherever it appears, and a copy inside a comment shreds the migration into fragments that will not parse. The header below refers to it in prose only."
- **Purity (MUST-2.1, verbatim).** "`src/lib/update/semver.ts` and `src/lib/update/egress.ts` are **pure**: no `@/db` import, no `@/lib/env` import, no node builtin. They are the update feature's counterpart to notify MUST-2.1, and `semver.ts` in particular is imported by the About client to render a severity badge, so the Ruling P4 client-bundle constraint applies to it exactly as it does to `src/lib/warranty/constants.ts`."
- **MUST-2.2 (verbatim).** "`src/lib/update/github.ts`, `watchtower.ts`, `state.ts` and `check.ts` are server-only and are never imported, directly or transitively, from a `*-client.tsx` file. Only `import type` is permitted there."
- **MUST-2.3 (verbatim).** "`src/lib/update/egress.ts` holds the **only** `://` string literal anywhere under `src/lib/update/`, mirroring the rule `src/lib/notify/egress.ts` already lives under. The Watchtower URL is **not** a literal anywhere in the tree: it arrives from `WATCHTOWER_URL` (§7.2) and its default value is written once, in YAML, in `install/synology-compose-pull.yml`."
- **Egress, the complete list (MUST-8.1, verbatim).** "The app may contact exactly **three** external destinations, and each is dormant until somebody configures it: 1. the user's own SimpleFIN bridge; 2. `api.telegram.org` and the SMTP host an admin typed in; 3. `api.github.com`." The Watchtower endpoint is **not** on that list (MUST-8.2) and is kept off it by `assertWatchtowerUrl`'s non-public-host rule, not by assertion.
- **Guards are adjacent to the call (MUST-8.5, verbatim).** "Each of the two `fetch` sites in `src/lib/update/github.ts` calls `assertGithubUrl()` on the string it is about to fetch, on the line immediately above the `fetch`. Not in a helper, not in a wrapper — immediately above, so the guard and the call cannot drift apart in a later edit." The same rule binds `assertWatchtowerUrl` in `watchtower.ts`.
- **No secrets to the client (MUST-7.3, verbatim).** "No page prop, server-action return value, log line or error message carries `WATCHTOWER_TOKEN`. The About card receives `canApplyInApp: boolean` and nothing more. Every string written to `update.last_apply_error`, to `console.error`, or returned to the browser from the apply path passes through `scrubSecrets(text, [token])` — the existing helper from `src/lib/notify/crypto.ts`, reused rather than reimplemented."
- **Scrubbing (MUST-10.11, verbatim).** "Every string written to `update.last_check_error`, `update.last_apply_error`, `console.*`, or returned to the browser from `src/lib/update/` passes through `scrubSecrets(text, secrets)` from `src/lib/notify/crypto.ts`, with the Watchtower token in the secret list on every apply path. The function is imported, not reimplemented; a second scrubber is a second thing to get wrong."
- **Majors never auto-apply (MUST-5.8, verbatim).** "The major rule is unconditional and is expressed as a guard inside `runUpdateCheck` (`if (severity === 'major') autoApply = false;`) placed **before** the apply branch, not as a condition inside it. There is no setting, environment variable or query parameter that makes a major auto-apply."
- **Interest is display only (MUST-13.1, verbatim).** "`interest_rate_bps` is **display only**. No code path multiplies it, accrues it, projects it or amortises with it. It is rendered as `5.49%` beside the balance and appears in no calculation anywhere."
- **Loan payments stay in the budget (MUST-13.2, verbatim).** "Loan payments **stay in their spending category and in every budget**. `applyLoanMatchers` never writes `is_transfer`, never writes `category_id`, never writes `attributed_user_id`, and never touches the `transactions` table at all. `budgetProgress`, `categoryBreakdown`, `cashflowTrend`, `topMerchants` and `personSpendSplit` do not read `loan_payments`."
- **Wording comes from the kind matrix (MUST-12.3, verbatim).** "`src/lib/warranty/constants.ts` gains a second wording matrix beside `KIND_WORDING`, and the kind-agnostic `billingCycleSuffix(cycle)` is **deleted**, not wrapped. Every call site … has the item's `kind` in scope already and is routed through the kind-keyed helper."
- **CAD integer cents (master spec).** All money is integer cents: spend negative, income positive, balances and principals positive. Money is formatted with `formatCents()` and parsed with `parseAmountToCents()` from `src/lib/money.ts`. Dates are ISO `YYYY-MM-DD` TEXT, month keys `YYYY-MM` TEXT, timestamps ISO datetime TEXT.
- **Same-origin first (MUST-10.2 / MUST-14.11).** `isSameOrigin(await headers())` is the **first** statement of every server action added by this release — before auth, before validation, before any read — returning `{ error: CROSS_ORIGIN_ERROR }`. Then `requireAdmin()` (update) or `requireUser()` (loans). Then zod. Then the domain call. Then `revalidatePath`.
- **No route handlers (MUST-10.4, verbatim).** "This feature adds **no route handler**, no anonymous path, no signed URL, no bearer token in a query string, and no way to trigger an update without an authenticated admin session on a same-origin request."
- **Existing design-token UI system only (§9 opening, verbatim).** "All existing primitives: `Card` / `CardHeader` / `CardBody`, `Notice`, `Field`, `SubmitButton`, `btn btn--primary|--secondary|--ghost`, `badge badge--*`, and the `text-ink` / `text-muted` / `text-subtle` tokens. **No new CSS, no new design token, no new colour.**"
- **One timestamp convention.** Every datetime this release renders is `iso.slice(0, 16).replace('T', ' ')` (notify §11.4's amendment). No relative strings, anywhere.
- **TypeScript strict.** `npx tsc --noEmit` must stay clean under `strict: true` (AC2). No `any`, no `@ts-expect-error` outside a test that is asserting a type error.
- **No test performs real network I/O (MUST-19.1).** `tests/lib/update/**` stubs `globalThis.fetch` and asserts in an `afterEach` that no unexpected host was contacted. There is no live-network test and no `it.skipIf(offline)` escape hatch.

## Conventions every task must follow

- Project root for every absolute path: `c:\Users\m.grewal\OneDrive - CloverTool Mfg\Documents\Budget Tracker`. Every `npm` / `npx` / `git` command runs from there in PowerShell.
- Import alias `@/` → `src/`. Tests live under `tests/` and mirror `src/` (`src/lib/update/state.ts` → `tests/lib/update/state.test.ts`).
- Vitest with `globals: false` — every test file starts with an explicit `import { describe, it, expect, ... } from 'vitest';`.
- Any test touching the database uses `createTestDb()` / `createSeededTestDb()` / `insertTestUser()` from `tests/helpers/db.ts`, which installs the temp database through `setDbForTests(...)`.
- Component tests are `.test.tsx` and open with `// @vitest-environment jsdom`, then `import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';` and an `afterEach(cleanup)`.
- Server-side domain logic lives in `src/lib/update/**` and `src/lib/loans.ts`; React pages and components are thin and call it. Never put SQL in a component.
- **Per-task verification is targeted, not global.** Each task ends with `npx vitest run <the files this task touched>` plus `npx tsc --noEmit`. **`npm test` (the full suite) and `npm run build` run in the release task only** — Task 15. A task that green-lights itself on a full-suite run has wasted twenty minutes it did not need to spend.
- **Commit at the end of each task** (the commit pause is lifted). The author identity is the repo's configured personal identity, **`VibeLogicCode <VibeLogicCode@users.noreply.github.com>`** — do not pass `--author`, and **do not add a `Co-Authored-By: Claude` trailer or any other Claude/Anthropic attribution to any commit in this plan**. Never `--no-verify`.
- The signal to act on at the end of a task is **green vs red** on the files that task touched, not an absolute test count.

<!-- END HEADER -->

---

# Phase 1 — Loans storage, and the two pure update modules

## Task 1: Migration 0007, the journal entry and the Drizzle mirrors

**Context:** Spec §11 in full. Four nullable money columns on `warranty_items` by `ALTER TABLE ADD COLUMN`, plus `loan_matcher_rules` and `loan_payments`, both created **empty**. This task is pure schema: no application code reads these tables yet. Implements **MUST-11.1 … MUST-11.19**, **MUST-3.1** (the migration carries no update-feature object), **MUST-19.3** and **AC6**.

**Note on the spec's own arithmetic:** §11.2's heading says "The five new `warranty_items` columns" and then its own prose says *"That is four columns. The fifth is not a new column"* — `billing_cycle` / `billing_amount_cents` already exist from 0005 and are unlocked by an app-layer predicate in Task 9. **This migration adds exactly four columns.** MUST-11.18's "the four new `warrantyItems` columns" is the authoritative count.

**Files:**
- Create: `drizzle/0007_loans.sql`
- Modify: `drizzle/meta/_journal.json` (append idx 7)
- Modify: `src/db/schema.ts` (four appended `warrantyItems` columns; two new table mirrors)
- Test: `tests/db/loan-schema.test.ts` (**new**)

**Interfaces:**
- Consumes: `createTestDb()` / `insertTestUser()` / `insertTestAccount()` / `type TestDb` from `tests/helpers/db`; `index`, `integer`, `sqliteTable`, `text`, `uniqueIndex` from `drizzle-orm/sqlite-core`; the existing `users`, `accounts`, `transactions`, `warrantyItems`, `warrantyItemTypes` tables in `src/db/schema.ts`.
- Produces:
  ```ts
  // src/db/schema.ts — four appended columns on the EXISTING warrantyItems table
  principalCents;        // 'principal_cents'        integer | null
  interestRateBps;       // 'interest_rate_bps'      integer | null
  currentBalanceCents;   // 'current_balance_cents'  integer | null
  balanceUpdatedAt;      // 'balance_updated_at'     text    | null

  // src/db/schema.ts — two new exports, appended in this order, at the END of the file
  export const loanMatcherRules;  // table 'loan_matcher_rules'
  export const loanPayments;      // table 'loan_payments'
  ```
  Column names available to every later task, exactly as in the DDL:
  `loan_matcher_rules(id, item_id, merchant_contains, account_id, enabled, created_at, updated_at)`;
  `loan_payments(id, txn_id, item_id, amount_cents, applied_cents, source, created_at)`.

### Steps

- [ ] **PRE-STEP — verify 0006 is the newest migration before claiming 0007 (MUST-11.1). If this check fails, STOP and escalate; do not renumber.**
  ```powershell
  Test-Path .\drizzle\0006_notifications.sql
  Test-Path .\drizzle\0007_loans.sql
  Select-String -Path .\drizzle\meta\_journal.json -Pattern '"idx": 6' -SimpleMatch
  Select-String -Path .\drizzle\meta\_journal.json -Pattern '0006_notifications' -SimpleMatch
  Select-String -Path .\drizzle\meta\_journal.json -Pattern '"idx": 7' -SimpleMatch
  ```
  Expected: `True`; `False`; a hit for `"idx": 6`; a hit for `0006_notifications`; **no** hit for `"idx": 7`.
  - If `0006_notifications.sql` is missing **or** journal idx 6 is absent: **STOP. Escalate to the user.** The notifications release is this plan's baseline; a missing 0006 means the branch is not where this plan thinks it is.
  - If `0007_loans.sql` exists **or** `"idx": 7` already exists: **STOP. Escalate.** Someone else has claimed the slot. A hole in the sequence is harmless; a reused index is not.

- [ ] **Write the failing schema test `tests/db/loan-schema.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { createTestDb, insertTestUser, insertTestAccount, type TestDb } from '../helpers/db';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  const now = '2026-08-17T12:00:00.000Z';

  /** A loan-kind type, a loan item, an account and a payment transaction. */
  function seedLoan(): { itemId: number; accountId: number; txnId: number } {
    const userId = insertTestUser(t.db, { username: 'loanowner' });
    const accountId = insertTestAccount(t.db, { name: 'Chequing' });
    t.sqlite
      .prepare(`insert into warranty_item_types (id, name, is_subscription, kind, created_at) values (1, 'Car loan', 0, 'loan', ?)`)
      .run(now);
    const item = t.sqlite
      .prepare(
        `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
         values ('Civic', '2024-01-15', 0, ?, 1, ?, ?) returning id`,
      )
      .get(userId, now, now) as { id: number };
    const txn = t.sqlite
      .prepare(
        `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
         values (?, '2026-08-01', 'HONDA FIN SVC', 'HONDA FIN SVC', -45000, ?, ?, ?) returning id`,
      )
      .get(accountId, userId, now, now) as { id: number };
    return { itemId: item.id, accountId, txnId: txn.id };
  }

  describe('MUST-11.2: the journal entry', () => {
    it('records idx 7 / when 1755820800000 / tag 0007_loans', () => {
      const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
        entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
      };
      const entry = journal.entries.find((e) => e.idx === 7);
      expect(entry).toEqual({ idx: 7, version: '6', when: 1755820800000, tag: '0007_loans', breakpoints: true });
      // One day after 0006, matching the file's existing one-per-day cadence.
      const prior = journal.entries.find((e) => e.idx === 6);
      expect(entry!.when - prior!.when).toBe(86_400_000);
    });
  });

  describe('AC6 / MUST-19.3: the breakpoint marker never appears inside a comment', () => {
    it('every occurrence is a statement separator', () => {
      const sqlText = fs.readFileSync(path.join(root, 'drizzle/0007_loans.sql'), 'utf8');
      const marker = ['-->', 'statement-breakpoint'].join(' ');
      const total = sqlText.split(marker).length - 1;
      const withoutComments = sqlText
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--') || line.trimStart().startsWith(marker))
        .join('\n');
      expect(withoutComments.split(marker).length - 1).toBe(total);
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('MUST-3.1 / AC6: 0007 is a loans-only migration', () => {
    it('carries no update-feature object outside the header prose', () => {
      const sqlText = fs.readFileSync(path.join(root, 'drizzle/0007_loans.sql'), 'utf8');
      const statements = sqlText
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(statements).not.toMatch(/update/i);
      // ...and the settings table is untouched: absence is the update feature's off state.
      expect(statements).not.toMatch(/settings/i);
    });
  });

  describe('MUST-11.5 / MUST-11.17: the shapes exist after migration', () => {
    it('adds the four money columns to warranty_items, physically last', () => {
      const cols = t.sqlite.prepare(`pragma table_info(warranty_items)`).all() as { name: string; type: string }[];
      const tail = cols.slice(-4).map((c) => c.name);
      expect(tail).toEqual(['principal_cents', 'interest_rate_bps', 'current_balance_cents', 'balance_updated_at']);
      const byName = new Map(cols.map((c) => [c.name, c.type.toLowerCase()]));
      expect(byName.get('principal_cents')).toBe('integer');
      expect(byName.get('interest_rate_bps')).toBe('integer');
      expect(byName.get('current_balance_cents')).toBe('integer');
      expect(byName.get('balance_updated_at')).toBe('text');
    });

    it('creates both tables, empty', () => {
      const names = t.sqlite
        .prepare(`select name from sqlite_master where type = 'table' and name like 'loan_%' order by name`)
        .all() as { name: string }[];
      expect(names.map((r) => r.name)).toEqual(['loan_matcher_rules', 'loan_payments']);
      for (const table of ['loan_matcher_rules', 'loan_payments']) {
        const { n } = t.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number };
        expect(n).toBe(0);
      }
    });

    it('creates all five named indexes', () => {
      const names = t.sqlite
        .prepare(`select name from sqlite_master where type = 'index' and name like 'loan_%' order by name`)
        .all() as { name: string }[];
      expect(names.map((r) => r.name)).toEqual([
        'loan_matcher_rules_item_idx',
        'loan_matcher_rules_uq',
        'loan_payments_item_idx',
        'loan_payments_txn_idx',
        'loan_payments_txn_item_uq',
      ]);
    });
  });

  describe('MUST-11.5: the money-column CHECK constraints', () => {
    it('rejects a negative principal and a negative balance', () => {
      const { itemId } = seedLoan();
      expect(() =>
        t.sqlite.prepare(`update warranty_items set principal_cents = -1 where id = ?`).run(itemId),
      ).toThrowError(/CHECK constraint failed/i);
      expect(() =>
        t.sqlite.prepare(`update warranty_items set current_balance_cents = -1 where id = ?`).run(itemId),
      ).toThrowError(/CHECK constraint failed/i);
    });

    it('accepts zero and rejects a rate above 10000% (1000000 bps)', () => {
      const { itemId } = seedLoan();
      t.sqlite.prepare(`update warranty_items set principal_cents = 0, current_balance_cents = 0 where id = ?`).run(itemId);
      t.sqlite.prepare(`update warranty_items set interest_rate_bps = 1000000 where id = ?`).run(itemId);
      expect(() =>
        t.sqlite.prepare(`update warranty_items set interest_rate_bps = 1000001 where id = ?`).run(itemId),
      ).toThrowError(/CHECK constraint failed/i);
      expect(() =>
        t.sqlite.prepare(`update warranty_items set interest_rate_bps = -1 where id = ?`).run(itemId),
      ).toThrowError(/CHECK constraint failed/i);
    });
  });

  describe('MUST-11.9 / MUST-11.10 / MUST-11.17: loan_matcher_rules', () => {
    function addRule(itemId: number, merchant: string, accountId: number | null): void {
      t.sqlite
        .prepare(
          `insert into loan_matcher_rules (item_id, merchant_contains, account_id, enabled, created_at, updated_at)
           values (?, ?, ?, 1, ?, ?)`,
        )
        .run(itemId, merchant, accountId, now, now);
    }

    it('rejects a two-character merchant substring', () => {
      const { itemId } = seedLoan();
      expect(() => addRule(itemId, 'HO', null)).toThrowError(/CHECK constraint failed/i);
      // ...and rejects three characters that are only whitespace-padded to length.
      expect(() => addRule(itemId, ' A ', null)).toThrowError(/CHECK constraint failed/i);
      addRule(itemId, 'HON', null);
    });

    it('MUST-11.17: the coalesce(account_id, -1) expression index catches a duplicate NULL pair', () => {
      const { itemId, accountId } = seedLoan();
      addRule(itemId, 'HONDA FIN', null);
      // A plain UNIQUE index would let this through, because NULL != NULL in SQL.
      expect(() => addRule(itemId, 'HONDA FIN', null)).toThrowError(/UNIQUE constraint failed/i);
      addRule(itemId, 'HONDA FIN', accountId);
      expect(() => addRule(itemId, 'HONDA FIN', accountId)).toThrowError(/UNIQUE constraint failed/i);
    });

    it('cascades on account delete', () => {
      const { itemId, accountId } = seedLoan();
      addRule(itemId, 'HONDA FIN', accountId);
      t.sqlite.prepare(`delete from accounts where id = ?`).run(accountId);
      const { n } = t.sqlite.prepare(`select count(*) as n from loan_matcher_rules`).get() as { n: number };
      expect(n).toBe(0);
    });
  });

  describe('MUST-11.13 … MUST-11.16: loan_payments', () => {
    function addLink(txnId: number, itemId: number, amount: number, applied: number, source = 'rule'): void {
      t.sqlite
        .prepare(
          `insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(txnId, itemId, amount, applied, source, now);
    }

    it('rejects a non-positive amount, an over-applied figure and an unknown source', () => {
      const { itemId, txnId } = seedLoan();
      expect(() => addLink(txnId, itemId, 0, 0)).toThrowError(/CHECK constraint failed/i);
      expect(() => addLink(txnId, itemId, 45000, 45001)).toThrowError(/CHECK constraint failed/i);
      expect(() => addLink(txnId, itemId, 45000, -1)).toThrowError(/CHECK constraint failed/i);
      expect(() => addLink(txnId, itemId, 45000, 0, 'auto')).toThrowError(/CHECK constraint failed/i);
      addLink(txnId, itemId, 45000, 45000);
    });

    it('MUST-11.15: (txn_id, item_id) is unique, and MUST-11.16 lets one txn fund two loans', () => {
      const { itemId, txnId } = seedLoan();
      addLink(txnId, itemId, 45000, 45000);
      expect(() => addLink(txnId, itemId, 45000, 0)).toThrowError(/UNIQUE constraint failed/i);
      const second = t.sqlite
        .prepare(
          `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
           values ('Boat', '2024-02-01', 0, (select owner_user_id from warranty_items where id = ?), 1, ?, ?) returning id`,
        )
        .get(itemId, now, now) as { id: number };
      addLink(txnId, second.id, 45000, 5000);
      const { n } = t.sqlite.prepare(`select count(*) as n from loan_payments where txn_id = ?`).get(txnId) as { n: number };
      expect(n).toBe(2);
    });

    it('cascades away with its transaction, and with its item', () => {
      const { itemId, txnId } = seedLoan();
      addLink(txnId, itemId, 45000, 45000);
      t.sqlite.prepare(`delete from transactions where id = ?`).run(txnId);
      expect((t.sqlite.prepare(`select count(*) as n from loan_payments`).get() as { n: number }).n).toBe(0);

      const { itemId: second, txnId: secondTxn } = (() => {
        const txn = t.sqlite
          .prepare(
            `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
             values ((select id from accounts limit 1), '2026-09-01', 'HONDA FIN SVC', 'HONDA FIN SVC', -45000,
                     (select owner_user_id from warranty_items where id = ?), ?, ?) returning id`,
          )
          .get(itemId, now, now) as { id: number };
        return { itemId, txnId: txn.id };
      })();
      addLink(secondTxn, second, 45000, 45000);
      t.sqlite.prepare(`delete from warranty_items where id = ?`).run(second);
      expect((t.sqlite.prepare(`select count(*) as n from loan_payments`).get() as { n: number }).n).toBe(0);
    });
  });
  ```

- [ ] **Run it and watch it fail.**
  ```powershell
  npx vitest run tests/db/loan-schema.test.ts
  ```
  Expected: red, on the missing `drizzle/0007_loans.sql`.

- [ ] **Hand-author `drizzle/0007_loans.sql`, exactly as §11.7 specifies.** The header extends 0006's enumeration from 20 to 24 and names the two rules that deliberately have no SQL representation. **The breakpoint marker appears only between statements — never inside a comment (MUST-11.3).**
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

- [ ] **Append the journal entry (MUST-11.2).** In `drizzle/meta/_journal.json`, after the `idx: 6` object, add:
  ```json
      {
        "idx": 7,
        "version": "6",
        "when": 1755820800000,
        "tag": "0007_loans",
        "breakpoints": true
      }
  ```
  (`1755734400000 + 86400000`, one day after 0006.)

- [ ] **Append the four columns to `warrantyItems` in `src/db/schema.ts` (MUST-11.18).** They go **after** `billingAmountCents`, before the closing `},` of the column object, following the existing ALTER-TABLE-ADD-COLUMN-is-physically-last convention:
  ```ts
      /**
       * v1.3.1, added by drizzle/0007_loans.sql. Declared last -- same
       * ALTER-TABLE-ADD-COLUMN convention as typeId and the billing pair above. All four
       * nullable, and only an item whose TYPE has kind 'loan' ever carries a non-NULL value.
       *
       * NOT represented here -- SQL only:
       *   - CHECK (principal_cents IS NULL OR principal_cents >= 0)
       *   - CHECK (interest_rate_bps IS NULL OR (>= 0 AND <= 1000000))
       *   - CHECK (current_balance_cents IS NULL OR current_balance_cents >= 0)
       *
       * MUST-13.1: interest_rate_bps is DISPLAY ONLY. Basis points, so 5.49% is 549. No code
       * path multiplies, accrues, projects or amortises with it, and a grep invariant in
       * tests/ops/loan-invariants.test.ts keeps it that way.
       *
       * MUST-11.7/MUST-11.8: current_balance_cents and balance_updated_at are both set or
       * both NULL -- a CROSS-COLUMN rule, enforced in src/lib/warranty/items.ts rather than
       * by a CHECK, because ALTER TABLE ADD COLUMN does not re-validate existing rows against
       * a CHECK added that way. balance_updated_at is the HUMAN anchor: it is written only
       * when a person types a balance, never by a matched payment, which is exactly what
       * makes the debt reconstruction in src/lib/loans.ts well-defined.
       */
      principalCents: integer('principal_cents'),
      interestRateBps: integer('interest_rate_bps'),
      currentBalanceCents: integer('current_balance_cents'),
      balanceUpdatedAt: text('balance_updated_at'),
  ```

- [ ] **Append the two table mirrors at the END of `src/db/schema.ts` (MUST-11.18), in this order.**
  ```ts
  /**
   * Loan payment matching (spec 2026-08-17 §11.4). Mirrors drizzle/0007_loans.sql.
   *
   * NOT represented here — SQL only:
   *   - CHECK (length(trim(merchant_contains)) >= 3)
   *   - the coalesce(account_id, -1) EXPRESSION inside loan_matcher_rules_uq, which is what
   *     makes "the same rule twice" impossible in the account-agnostic case too. A plain
   *     uniqueIndex() on (itemId, merchantContains, accountId) would let two NULLs through,
   *     so it is deliberately NOT declared below: a weaker index with the same name is worse
   *     than none, because a future drizzle-kit push could use it to replace the real one.
   *
   * MUST-11.10: the three-character minimum is a real guard, not tidiness. A one- or
   * two-character substring matches most merchant strings in a household's history, and the
   * first import after such a rule was saved would assign every transaction to a loan. It is
   * enforced in SQL and again in zod.
   *
   * MUST-11.11: merchant_contains is compared against transactions.normalized_merchant, which
   * normalizeMerchant() UPPERCASES. The stored value is uppercased on write and compared with
   * instr(...) > 0 against the uppercased parameter — no lower() wrapper on either side.
   */
  export const loanMatcherRules = sqliteTable(
    'loan_matcher_rules',
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      itemId: integer('item_id')
        .notNull()
        .references(() => warrantyItems.id, { onDelete: 'cascade' }),
      merchantContains: text('merchant_contains').notNull(),
      /** NULL means "any account". */
      accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
      enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
      createdAt: text('created_at').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
    (t) => [index('loan_matcher_rules_item_idx').on(t.itemId)],
  );

  /**
   * The link row between a transaction and a loan (spec 2026-08-17 §11.5). Mirrors
   * drizzle/0007_loans.sql.
   *
   * NOT represented here — SQL only:
   *   - CHECK (amount_cents > 0)
   *   - CHECK (applied_cents >= 0 AND applied_cents <= amount_cents)
   *   - CHECK (source IN ('rule','manual'))
   *
   * MUST-11.14: TWO amount columns, deliberately. amount_cents is the honest record of the
   * payment; applied_cents is what the balance actually moved by, which differs whenever the
   * decrement clamped at zero. A reversal adds back applied_cents, so it restores the balance
   * exactly, with no drift, in every clamping case.
   *
   * MUST-11.15: loan_payments_txn_item_uq IS the idempotency guard, the same shape
   * notification_outbox_dedup_uq takes. Every link insert is INSERT ... ON CONFLICT DO
   * NOTHING and `changes === 0` means "already linked, do not decrement"; the decrement runs
   * in the same transaction, conditional on changes > 0, so a crash between "decide to apply"
   * and "record that we applied" is impossible — they are one statement.
   *
   * MUST-11.16: (txn_id, item_id), not (txn_id) — one transaction may legitimately fund two
   * loans. The rule path never exploits this (MUST-13.4); only a person can create the second.
   */
  export const loanPayments = sqliteTable(
    'loan_payments',
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      txnId: integer('txn_id')
        .notNull()
        .references(() => transactions.id, { onDelete: 'cascade' }),
      itemId: integer('item_id')
        .notNull()
        .references(() => warrantyItems.id, { onDelete: 'cascade' }),
      amountCents: integer('amount_cents').notNull(),
      appliedCents: integer('applied_cents').notNull(),
      source: text('source', { enum: ['rule', 'manual'] }).notNull(),
      createdAt: text('created_at').notNull(),
    },
    (t) => [
      uniqueIndex('loan_payments_txn_item_uq').on(t.txnId, t.itemId),
      index('loan_payments_item_idx').on(t.itemId, t.id),
      index('loan_payments_txn_idx').on(t.txnId),
    ],
  );
  ```

- [ ] **Run the schema test and the neighbouring database suites.**
  ```powershell
  npx vitest run tests/db/loan-schema.test.ts tests/db/schema.test.ts tests/db/warranty-schema.test.ts tests/db/notification-schema.test.ts
  npx tsc --noEmit
  ```
  Expected: green. If `tests/db/schema.test.ts` pins a table or column census, update that census — it is a count, not an invariant.

- [ ] **Commit.**
  ```powershell
  git add drizzle/0007_loans.sql drizzle/meta/_journal.json src/db/schema.ts tests/db/loan-schema.test.ts
  git commit -m "feat(loans): migration 0007 - money columns and the two link tables

Four nullable money columns on warranty_items by ALTER TABLE ADD COLUMN, plus
loan_matcher_rules and loan_payments, both created empty (MUST-11.1..11.19).
loan_payments_txn_item_uq IS the idempotency guard; loan_matcher_rules_uq uses a
coalesce(account_id, -1) expression so a duplicate account-agnostic rule is
impossible. The balance/anchor pairing and the billing-by-kind rule stay in the
app layer, for the reason 0005's header already gives. Journal idx 7."
  ```

<!-- END TASK 1 -->

---

## Task 2: `src/lib/update/semver.ts` and `src/lib/update/egress.ts` — the two pure modules

**Context:** Spec §4.3 and §8.2–§8.3. Implements **MUST-2.1** (purity), **MUST-2.3** (the only `://` literal), **MUST-4.9, MUST-4.10, MUST-4.11**, **MUST-8.4, MUST-8.6**, and §19.1's `semver.test.ts` and `egress.test.ts`. These are the purest modules in the feature: `semver.ts` is imported by the About **client** to render a severity badge, so an `@/db` import here fails the client webpack build outright (Ruling P4, the same constraint that governs `src/lib/warranty/constants.ts`). Nothing in this task touches the database, the environment or the network.

**Files:**
- Create: `src/lib/update/semver.ts`
- Create: `src/lib/update/egress.ts`
- Test: `tests/lib/update/semver.test.ts` (**new**), `tests/lib/update/egress.test.ts` (**new**)

**Interfaces:**
- Consumes: nothing. No imports at all, of any kind, in either file.
- Produces:
  ```ts
  // src/lib/update/semver.ts
  export interface Semver { readonly major: number; readonly minor: number; readonly patch: number }
  export type UpdateSeverity = 'none' | 'patch' | 'minor' | 'major';
  export function parseSemver(value: string): Semver | null;
  export function compareSemver(a: Semver, b: Semver): number;
  export function classify(current: Semver, remote: Semver): UpdateSeverity;
  export function formatSemver(value: Semver): string;

  // src/lib/update/egress.ts
  export const GITHUB_API_ORIGIN = 'https://api.github.com';
  export const GITHUB_REPO_PATH = '/repos/VibeLogicCode/BudgetTracker';
  export const GITHUB_RELEASES_PATH: string;   // `${GITHUB_REPO_PATH}/releases/latest`
  export const GITHUB_CHANGELOG_PATH: string;  // `${GITHUB_REPO_PATH}/contents/CHANGELOG.md`
  export function assertGithubUrl(url: string): void;
  export function assertWatchtowerUrl(url: string): void;
  ```

### Steps

- [ ] **Write the failing `tests/lib/update/semver.test.ts` (§19.1).**
  ```ts
  import { describe, it, expect } from 'vitest';
  import { classify, compareSemver, formatSemver, parseSemver, type Semver } from '@/lib/update/semver';

  const v = (major: number, minor: number, patch: number): Semver => ({ major, minor, patch });

  describe('MUST-4.10: parseSemver is strict', () => {
    it('accepts three dot-separated runs of digits, with one optional leading v', () => {
      expect(parseSemver('1.4.0')).toEqual(v(1, 4, 0));
      expect(parseSemver('v1.4.0')).toEqual(v(1, 4, 0));
      expect(parseSemver('0.0.0')).toEqual(v(0, 0, 0));
      expect(parseSemver('10.20.30')).toEqual(v(10, 20, 30));
    });

    it('rejects everything else, including a pre-release and build metadata', () => {
      for (const bad of [
        '1.4',
        '1.4.0.1',
        '1.4.0-rc.1',
        '1.4.0+build',
        'v1.4.0-rc.1',
        'latest',
        '',
        'vv1.4.0',
        '1.04.0',
        ' 1.4.0',
        '1.4.0 ',
        'a'.repeat(40),
      ]) {
        expect(parseSemver(bad), bad).toBeNull();
      }
    });

    it('accepts a bare zero but not a leading zero beyond it', () => {
      expect(parseSemver('0.1.0')).toEqual(v(0, 1, 0));
      expect(parseSemver('00.1.0')).toBeNull();
      expect(parseSemver('1.0.00')).toBeNull();
    });
  });

  describe('compareSemver orders across all three components', () => {
    it('sorts by major, then minor, then patch', () => {
      expect(compareSemver(v(2, 0, 0), v(1, 9, 9))).toBeGreaterThan(0);
      expect(compareSemver(v(1, 4, 0), v(1, 3, 9))).toBeGreaterThan(0);
      expect(compareSemver(v(1, 3, 1), v(1, 3, 0))).toBeGreaterThan(0);
      expect(compareSemver(v(1, 3, 0), v(1, 3, 0))).toBe(0);
      expect(compareSemver(v(1, 3, 0), v(1, 3, 1))).toBeLessThan(0);
    });
  });

  describe('MUST-4.9: classify is total and defined by exactly four lines, in order', () => {
    it('returns none for an equal pair and for a LOWER remote', () => {
      expect(classify(v(1, 3, 1), v(1, 3, 1))).toBe('none');
      expect(classify(v(1, 3, 1), v(1, 3, 0))).toBe('none');
      expect(classify(v(2, 0, 0), v(1, 9, 9))).toBe('none'); // a downgrade is never an update
    });

    it('returns major, minor and patch in that precedence', () => {
      expect(classify(v(1, 3, 1), v(2, 0, 0))).toBe('major');
      // A major bump wins even when the minor and patch go DOWN.
      expect(classify(v(1, 9, 9), v(2, 0, 0))).toBe('major');
      expect(classify(v(1, 3, 1), v(1, 4, 0))).toBe('minor');
      expect(classify(v(1, 3, 1), v(1, 4, 0))).not.toBe('patch');
      expect(classify(v(1, 3, 1), v(1, 3, 2))).toBe('patch');
    });

    it('classifies 1.3.0 -> 1.3.1 as a patch (MUST-18.2, stated consequence)', () => {
      expect(classify(v(1, 3, 0), v(1, 3, 1))).toBe('patch');
    });
  });

  describe('formatSemver re-serialises from integers (MUST-4.2)', () => {
    it('round-trips and drops any leading v', () => {
      expect(formatSemver(parseSemver('v1.4.0')!)).toBe('1.4.0');
      expect(formatSemver(v(10, 0, 3))).toBe('10.0.3');
    });
  });
  ```

- [ ] **Write `src/lib/update/semver.ts` (MUST-2.1: no imports, at all).**
  ```ts
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
   * read from the release payload. GitHub has no concept of "is this breaking for you" — the
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
  ```

- [ ] **Write the failing `tests/lib/update/egress.test.ts` (§19.1).**
  ```ts
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
  ```

- [ ] **Write `src/lib/update/egress.ts` (MUST-2.1 pure; MUST-2.3: this file holds the only `://` literal under `src/lib/update/`).**
  ```ts
  /**
   * MUST-8.1 / MUST-8.4 / MUST-8.6: the update feature's egress policy, in code. PURE
   * (MUST-2.1): no @/db import, no @/lib/env import, no node builtin, no import of any kind.
   *
   * MUST-2.3: this module holds the ONLY `://` string literal anywhere under
   * src/lib/update/, mirroring the rule src/lib/notify/egress.ts already lives under, and
   * tests/ops/notify-egress.test.ts fails the build if a second one appears. The Watchtower
   * URL is deliberately NOT a literal anywhere in this tree: it arrives from WATCHTOWER_URL,
   * and its default value is written once, in YAML, in install/synology-compose-pull.yml.
   */
  export const GITHUB_API_ORIGIN = 'https://api.github.com';
  export const GITHUB_REPO_PATH = '/repos/VibeLogicCode/BudgetTracker';

  /** MUST-4.2: the only two endpoints this app may ever call on api.github.com. */
  export const GITHUB_RELEASES_PATH = `${GITHUB_REPO_PATH}/releases/latest`;
  export const GITHUB_CHANGELOG_PATH = `${GITHUB_REPO_PATH}/contents/CHANGELOG.md`;

  /** MUST-8.4 condition 5: the one place a caller-supplied value reaches the URL. */
  const CHANGELOG_REF_PATTERN = /^\?ref=v\d+\.\d+\.\d+$/;

  /**
   * MUST-8.4: all five conditions, and the reasoning is the same one notify's Telegram guard
   * sets out. `new URL()` normalises dot-segments BEFORE any check runs, so a value that folds
   * down to a different path can still read back an innocent `origin`; and a userinfo section
   * ("https://api.github.com@evil.com") lands in `host`, not in a separate field a naive check
   * would notice.
   *
   * Pinning the EXACT pathnames rather than a prefix is deliberate: a prefix check on
   * /repos/VibeLogicCode/BudgetTracker would happily allow /issues, /comments, or
   * /contents/<anything>, and this feature has no business reading any of them.
   */
  export function assertGithubUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('refusing a GitHub request to a non-URL target');
    }
    // `origin` folds scheme, host and port together, so this single comparison covers
    // api.github.com.evil.com, plain http, and a non-443 port at once.
    if (parsed.origin !== GITHUB_API_ORIGIN) {
      throw new Error('refusing a GitHub request to a non-permitted origin');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new Error('refusing a GitHub request carrying userinfo');
    }
    if (parsed.hash !== '') {
      throw new Error('refusing a GitHub request carrying a fragment');
    }
    if (parsed.pathname === GITHUB_RELEASES_PATH) {
      if (parsed.search !== '') throw new Error('refusing a GitHub request with an unexpected query');
      return;
    }
    if (parsed.pathname === GITHUB_CHANGELOG_PATH) {
      if (!CHANGELOG_REF_PATTERN.test(parsed.search)) {
        throw new Error('refusing a GitHub request with an unexpected query');
      }
      return;
    }
    throw new Error('refusing a GitHub request to an unrecognized path');
  }

  /** A Docker Compose service name: one label, no dot. `watchtower` is the shipped default. */
  const BARE_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
  const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

  function isPrivateIpv4(hostname: string): boolean {
    const match = IPV4.exec(hostname);
    if (match === null) return false;
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    if (a === 127) return true; //             127.0.0.0/8
    if (a === 10) return true; //              10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    return false;
  }

  function isPrivateIpv6(hostname: string): boolean {
    // URL.hostname keeps the brackets off but lowercases the literal.
    if (hostname === '[::1]') return true;
    const inner = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (inner === '::1') return true;
    // fc00::/7 is fc.. or fd..; fe80::/10 is fe8./fe9./fea./feb.
    if (/^f[cd][0-9a-f]{0,2}:/i.test(inner)) return true;
    if (/^fe[89ab][0-9a-f]?:/i.test(inner)) return true;
    return false;
  }

  /**
   * MUST-8.6 / MUST-8.2: this function is what makes the Watchtower exemption from the
   * three-destination egress list enforceable rather than asserted. It refuses every hostname
   * that is not a bare compose label, `localhost`, or a private/loopback IP literal.
   *
   * A dotted name could resolve anywhere, and this function is PURE — it cannot and must not
   * resolve DNS to find out. So any dotted hostname that is not one of the IP literals below
   * is refused outright, which is stricter than "is it actually internal" and is the correct
   * direction to err in.
   */
  export function assertWatchtowerUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('refusing a Watchtower request to a non-URL target');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('refusing a Watchtower request on a non-HTTP scheme');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new Error('refusing a Watchtower request carrying userinfo');
    }
    if (parsed.pathname !== '/v1/update') {
      throw new Error('refusing a Watchtower request to an unrecognized path');
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new Error('refusing a Watchtower request carrying a query or fragment');
    }
    const host = parsed.hostname;
    const internal =
      host === 'localhost' || (!host.includes('.') && !host.includes(':') && BARE_LABEL.test(host)) || isPrivateIpv4(host) || isPrivateIpv6(host);
    if (!internal) {
      throw new Error('refusing a Watchtower request to a non-internal host');
    }
  }
  ```

- [ ] **Run both test files and the type-check.**
  ```powershell
  npx vitest run tests/lib/update/semver.test.ts tests/lib/update/egress.test.ts
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Prove purity by hand before the invariant test exists (Task 14 automates this).**
  ```powershell
  Select-String -Path .\src\lib\update\semver.ts,.\src\lib\update\egress.ts -Pattern '^import' -SimpleMatch
  ```
  Expected: **no output at all**. Neither file imports anything.

- [ ] **Commit.**
  ```powershell
  git add src/lib/update/semver.ts src/lib/update/egress.ts tests/lib/update/semver.test.ts tests/lib/update/egress.test.ts
  git commit -m "feat(update): pure semver classification and the egress guards

parseSemver is strict - one optional leading v and three digit runs, no
pre-release, no build metadata - so a tag this classifier cannot reason about
never reaches an auto-apply decision (MUST-4.10). classify() is four lines in a
load-bearing order (MUST-4.9) and severity is computed here, never read from the
release payload (MUST-4.11). assertGithubUrl pins both exact pathnames and the
?ref=v<semver> query shape; assertWatchtowerUrl refuses every hostname that is
not a bare compose label, localhost or a private IP literal, which is what makes
the Watchtower egress exemption enforceable rather than asserted (MUST-8.6).
Both files import nothing (MUST-2.1)."
  ```

<!-- END TASK 2 -->

---

# Phase 2 — The update feature's server side

## Task 3: `src/lib/update/state.ts` — settings-backed state and the boot reconciler

**Context:** Spec §3 in full and §7.3's `reconcileApplyOnBoot`. Implements **MUST-3.1 … MUST-3.5**, **MUST-7.6**, **MUST-7.7**, and §19.1's `state.test.ts`. This is the module that makes MUST-1.1 structurally true rather than conventionally true: there is no column with a default, no seeded row, nothing that could turn the feature on for somebody who never asked. **Absence is the off state.**

**Files:**
- Create: `src/lib/update/state.ts`
- Test: `tests/lib/update/state.test.ts` (**new**)

**Interfaces:**
- Consumes: `getSetting(key)` / `setSetting(key, value)` / `deleteSetting(key)` from `@/lib/settings`; `APP_VERSION` from `@/lib/version`.
- Produces:
  ```ts
  export const APPLY_CONFIRM_MAX_AGE_MS = 30 * 60_000;

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
  export function isUpdateCheckEnabled(): boolean;
  export function setUpdateChecksEnabled(input: { enabled: boolean; userId: number; at?: Date }): void;
  export function setAutoApply(enabled: boolean): void;
  export function recordCheckOutcome(input: { at: Date; latestVersion?: string | null; publishedAt?: string | null; error?: string | null }): void;
  export function recordApplyRequested(input: { version: string; at: Date }): void;
  export function recordApplyOutcome(input: { at: Date; error?: string | null }): void;
  export function dismissVersion(version: string): void;
  export function clearUpdateState(): void;
  export function reconcileApplyOnBoot(now?: Date): void;
  ```

### Steps

- [ ] **Write the failing `tests/lib/update/state.test.ts` (§19.1).**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
  import {
    APPLY_CONFIRM_MAX_AGE_MS,
    clearUpdateState,
    dismissVersion,
    isUpdateCheckEnabled,
    readUpdateState,
    recordApplyOutcome,
    recordApplyRequested,
    recordCheckOutcome,
    reconcileApplyOnBoot,
    setAutoApply,
    setUpdateChecksEnabled,
  } from '@/lib/update/state';
  import { APP_VERSION } from '@/lib/version';

  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
    vi.restoreAllMocks();
  });

  function updateRows(): { key: string; value: string }[] {
    return t.sqlite
      .prepare(`select key, value from settings where key like 'update.%' order by key`)
      .all() as { key: string; value: string }[];
  }

  describe('MUST-1.1 / MUST-3.1: absence is the off state', () => {
    it('a virgin database has no update. row at all', () => {
      expect(updateRows()).toEqual([]);
      expect(isUpdateCheckEnabled()).toBe(false);
    });

    it('MUST-3.3: readUpdateState on a virgin database is all-off and all-null', () => {
      expect(readUpdateState()).toEqual({
        enabled: false,
        enabledBy: null,
        enabledAt: null,
        autoApply: false,
        lastCheckedAt: null,
        lastCheckError: null,
        latestVersion: null,
        latestPublishedAt: null,
        dismissedVersion: null,
        applyRequestedVersion: null,
        applyRequestedAt: null,
        lastAppliedAt: null,
        lastApplyError: null,
      });
    });
  });

  describe('MUST-3.2: every key round-trips', () => {
    it('enable records the caller, the timestamp and the flag', () => {
      const userId = insertTestUser(t.db, { username: 'admin1' });
      setUpdateChecksEnabled({ enabled: true, userId, at: new Date('2026-08-17T10:00:00.000Z') });
      const state = readUpdateState();
      expect(state.enabled).toBe(true);
      expect(state.enabledBy).toBe(userId);
      expect(state.enabledAt).toBe('2026-08-17T10:00:00.000Z');
      // MUST-3.2: absent means ON, once checks are enabled.
      expect(state.autoApply).toBe(true);
    });

    it('the check outcome writes the stamp on success and on failure', () => {
      const userId = insertTestUser(t.db, { username: 'admin2' });
      setUpdateChecksEnabled({ enabled: true, userId });
      recordCheckOutcome({
        at: new Date('2026-08-17T10:00:00.000Z'),
        latestVersion: '1.4.0',
        publishedAt: '2026-08-16T09:00:00.000Z',
        error: null,
      });
      let state = readUpdateState();
      expect(state.lastCheckedAt).toBe('2026-08-17T10:00:00.000Z');
      expect(state.latestVersion).toBe('1.4.0');
      expect(state.latestPublishedAt).toBe('2026-08-16T09:00:00.000Z');
      expect(state.lastCheckError).toBeNull();

      recordCheckOutcome({ at: new Date('2026-08-18T10:00:00.000Z'), error: 'GitHub returned 500.' });
      state = readUpdateState();
      expect(state.lastCheckedAt).toBe('2026-08-18T10:00:00.000Z');
      expect(state.lastCheckError).toBe('GitHub returned 500.');
      // A failed check does NOT invent, and does not clear, a previously observed version.
      expect(state.latestVersion).toBe('1.4.0');
    });

    it('a check that finds nothing newer deletes the cached version', () => {
      const userId = insertTestUser(t.db, { username: 'admin3' });
      setUpdateChecksEnabled({ enabled: true, userId });
      recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0', publishedAt: '2026-08-16T09:00:00.000Z' });
      recordCheckOutcome({ at: new Date(), latestVersion: null, publishedAt: null });
      const state = readUpdateState();
      expect(state.latestVersion).toBeNull();
      expect(state.latestPublishedAt).toBeNull();
    });

    it('dismiss and the auto-apply toggle round-trip', () => {
      const userId = insertTestUser(t.db, { username: 'admin4' });
      setUpdateChecksEnabled({ enabled: true, userId });
      setAutoApply(false);
      dismissVersion('1.4.0');
      const state = readUpdateState();
      expect(state.autoApply).toBe(false);
      expect(state.dismissedVersion).toBe('1.4.0');
    });
  });

  describe('MUST-3.5: autoApply is forced false while disabled', () => {
    it('reports false even with the stored key saying on', () => {
      const userId = insertTestUser(t.db, { username: 'admin5' });
      setUpdateChecksEnabled({ enabled: true, userId });
      setAutoApply(true);
      expect(readUpdateState().autoApply).toBe(true);
      // Write the flag directly so the stale-key case is exercised without going through
      // clearUpdateState()'s wipe.
      t.sqlite.prepare(`update settings set value = '0' where key = 'update.checks_enabled'`).run();
      const state = readUpdateState();
      expect(state.enabled).toBe(false);
      expect(state.autoApply).toBe(false);
    });
  });

  describe('MUST-3.4: disabling wipes everything but the flag', () => {
    it('leaves exactly one update. row, checks_enabled = 0', () => {
      const userId = insertTestUser(t.db, { username: 'admin6' });
      setUpdateChecksEnabled({ enabled: true, userId });
      recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0', publishedAt: '2026-08-16T09:00:00.000Z' });
      dismissVersion('1.4.0');
      recordApplyRequested({ version: '1.4.0', at: new Date() });
      recordApplyOutcome({ at: new Date(), error: 'boom' });
      expect(updateRows().length).toBeGreaterThan(5);

      setUpdateChecksEnabled({ enabled: false, userId });
      expect(updateRows()).toEqual([{ key: 'update.checks_enabled', value: '0' }]);
      // Re-enabling starts clean: no cached version, no stale error, no dismissed memory.
      setUpdateChecksEnabled({ enabled: true, userId });
      const state = readUpdateState();
      expect(state.latestVersion).toBeNull();
      expect(state.dismissedVersion).toBeNull();
      expect(state.lastCheckError).toBeNull();
      expect(state.lastApplyError).toBeNull();
    });

    it('clearUpdateState() on its own leaves the same single row', () => {
      const userId = insertTestUser(t.db, { username: 'admin7' });
      setUpdateChecksEnabled({ enabled: true, userId });
      recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
      clearUpdateState();
      expect(updateRows()).toEqual([{ key: 'update.checks_enabled', value: '0' }]);
    });
  });

  describe('MUST-7.6: the boot reconciler closes the loop', () => {
    it('returns immediately when no apply was ever requested', () => {
      reconcileApplyOnBoot(new Date());
      expect(updateRows()).toEqual([]);
    });

    it('confirms a matching version and clears the pending state', () => {
      const userId = insertTestUser(t.db, { username: 'admin8' });
      setUpdateChecksEnabled({ enabled: true, userId });
      recordCheckOutcome({ at: new Date('2026-08-17T10:00:00.000Z'), latestVersion: APP_VERSION });
      recordApplyRequested({ version: APP_VERSION, at: new Date('2026-08-17T10:01:00.000Z') });
      reconcileApplyOnBoot(new Date('2026-08-17T10:03:00.000Z'));

      const state = readUpdateState();
      expect(state.lastAppliedAt).toBe('2026-08-17T10:03:00.000Z');
      expect(state.applyRequestedVersion).toBeNull();
      expect(state.applyRequestedAt).toBeNull();
      expect(state.lastApplyError).toBeNull();
      expect(state.latestVersion).toBeNull();
    });

    it('times out a stale request past 30 minutes and records why', () => {
      const userId = insertTestUser(t.db, { username: 'admin9' });
      setUpdateChecksEnabled({ enabled: true, userId });
      recordApplyRequested({ version: '9.9.9', at: new Date('2026-08-17T10:00:00.000Z') });
      const later = new Date(Date.parse('2026-08-17T10:00:00.000Z') + APPLY_CONFIRM_MAX_AGE_MS + 1000);
      reconcileApplyOnBoot(later);

      const state = readUpdateState();
      expect(state.applyRequestedVersion).toBeNull();
      expect(state.applyRequestedAt).toBeNull();
      expect(state.lastApplyError).toBe(
        `The update was requested but the app is still on ${APP_VERSION}. Check the Watchtower container's logs.`,
      );
    });

    it('leaves a FRESH mismatched request pending — a boot can precede the replacement', () => {
      const userId = insertTestUser(t.db, { username: 'admin10' });
      setUpdateChecksEnabled({ enabled: true, userId });
      recordApplyRequested({ version: '9.9.9', at: new Date('2026-08-17T10:00:00.000Z') });
      reconcileApplyOnBoot(new Date('2026-08-17T10:05:00.000Z'));

      const state = readUpdateState();
      expect(state.applyRequestedVersion).toBe('9.9.9');
      expect(state.applyRequestedAt).toBe('2026-08-17T10:00:00.000Z');
      expect(state.lastApplyError).toBeNull();
    });
  });

  describe('MUST-7.7: the reconciler never throws into the boot path', () => {
    it('swallows a database failure and logs it', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      t.sqlite.prepare('drop table settings').run();
      expect(() => reconcileApplyOnBoot(new Date())).not.toThrow();
      expect(spy).toHaveBeenCalled();
    });
  });
  ```

- [ ] **Write `src/lib/update/state.ts`.**
  ```ts
  import { deleteSetting, getSetting, setSetting } from '@/lib/settings';
  import { APP_VERSION } from '@/lib/version';

  /**
   * MUST-3.1: the update feature adds NO table, NO column and NO migration. Every byte of
   * its state is a key/value row in the existing `settings` table, and this module owns every
   * one of those strings (MUST-3.2) — no other module writes a key beginning `update.`.
   *
   * That is not a convenience. It is what makes MUST-1.1 structurally true rather than
   * conventionally true: there is no column with a default, no seeded row, no
   * `NOT NULL ... DEFAULT 1` anywhere that could turn the feature on for somebody who never
   * asked for it. ABSENCE IS THE OFF STATE.
   */
  const KEY_ENABLED = 'update.checks_enabled';
  const KEY_ENABLED_BY = 'update.enabled_by';
  const KEY_ENABLED_AT = 'update.enabled_at';
  const KEY_AUTO_APPLY = 'update.auto_apply';
  const KEY_LAST_CHECKED_AT = 'update.last_checked_at';
  const KEY_LAST_CHECK_ERROR = 'update.last_check_error';
  const KEY_LATEST_VERSION = 'update.latest_version';
  const KEY_LATEST_PUBLISHED_AT = 'update.latest_published_at';
  const KEY_DISMISSED_VERSION = 'update.dismissed_version';
  const KEY_APPLY_REQUESTED_VERSION = 'update.apply_requested_version';
  const KEY_APPLY_REQUESTED_AT = 'update.apply_requested_at';
  const KEY_LAST_APPLIED_AT = 'update.last_applied_at';
  const KEY_LAST_APPLY_ERROR = 'update.last_apply_error';

  /** MUST-3.4: every key the disable action wipes. The flag itself is written, not deleted. */
  const WIPED_ON_DISABLE = [
    KEY_ENABLED_BY,
    KEY_ENABLED_AT,
    KEY_AUTO_APPLY,
    KEY_LAST_CHECKED_AT,
    KEY_LAST_CHECK_ERROR,
    KEY_LATEST_VERSION,
    KEY_LATEST_PUBLISHED_AT,
    KEY_DISMISSED_VERSION,
    KEY_APPLY_REQUESTED_VERSION,
    KEY_APPLY_REQUESTED_AT,
    KEY_LAST_APPLIED_AT,
    KEY_LAST_APPLY_ERROR,
  ] as const;

  /** MUST-7.6: past this, an unconfirmed apply is declared not to have happened. */
  export const APPLY_CONFIRM_MAX_AGE_MS = 30 * 60_000;

  export interface UpdateState {
    enabled: boolean;
    enabledBy: number | null;
    enabledAt: string | null;
    /** MUST-3.5: false when !enabled, regardless of what is stored. */
    autoApply: boolean;
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

  function iso(at: Date): string {
    return at.toISOString();
  }

  function writeOrDelete(key: string, value: string | null | undefined): void {
    if (value === null || value === undefined || value.length === 0) deleteSetting(key);
    else setSetting(key, value);
  }

  /**
   * MUST-1.1 / MUST-5.1: the dormancy gate. ONE indexed read of a settings key that is ABSENT
   * on every install nobody has enabled this on. runUpdateTick()'s first statement.
   */
  export function isUpdateCheckEnabled(): boolean {
    return getSetting(KEY_ENABLED) === '1';
  }

  /**
   * MUST-3.3: a single reader that returns the whole picture, so no caller assembles it from
   * loose getSetting calls and no two callers can disagree about what the state is.
   */
  export function readUpdateState(): UpdateState {
    const enabled = isUpdateCheckEnabled();
    const enabledByRaw = getSetting(KEY_ENABLED_BY);
    const enabledBy = enabledByRaw === null ? null : Number.parseInt(enabledByRaw, 10);
    return {
      enabled,
      enabledBy: enabledBy !== null && Number.isFinite(enabledBy) ? enabledBy : null,
      enabledAt: getSetting(KEY_ENABLED_AT),
      // MUST-3.2: absent means ON once checks are enabled. MUST-3.5: forced false while
      // disabled, so no caller can reach an apply path through a stale key.
      autoApply: enabled ? getSetting(KEY_AUTO_APPLY) !== '0' : false,
      lastCheckedAt: getSetting(KEY_LAST_CHECKED_AT),
      lastCheckError: getSetting(KEY_LAST_CHECK_ERROR),
      latestVersion: getSetting(KEY_LATEST_VERSION),
      latestPublishedAt: getSetting(KEY_LATEST_PUBLISHED_AT),
      dismissedVersion: getSetting(KEY_DISMISSED_VERSION),
      applyRequestedVersion: getSetting(KEY_APPLY_REQUESTED_VERSION),
      applyRequestedAt: getSetting(KEY_APPLY_REQUESTED_AT),
      lastAppliedAt: getSetting(KEY_LAST_APPLIED_AT),
      lastApplyError: getSetting(KEY_LAST_APPLY_ERROR),
    };
  }

  /**
   * MUST-3.4: turning the feature OFF deletes every `update.` key except the flag itself.
   * Off means off, and re-enabling starts clean — no cached remote version to render, no
   * stale error banner, and no dismissed-version memory that would silently swallow the next
   * notice if it were turned back on.
   */
  export function clearUpdateState(): void {
    for (const key of WIPED_ON_DISABLE) deleteSetting(key);
    setSetting(KEY_ENABLED, '0');
  }

  export function setUpdateChecksEnabled(input: { enabled: boolean; userId: number; at?: Date }): void {
    if (!input.enabled) {
      clearUpdateState();
      return;
    }
    // Enabling also starts clean, so a re-enable never resurrects the previous run's cache.
    for (const key of WIPED_ON_DISABLE) deleteSetting(key);
    setSetting(KEY_ENABLED, '1');
    setSetting(KEY_ENABLED_BY, String(input.userId));
    setSetting(KEY_ENABLED_AT, iso(input.at ?? new Date()));
  }

  export function setAutoApply(enabled: boolean): void {
    setSetting(KEY_AUTO_APPLY, enabled ? '1' : '0');
  }

  /**
   * MUST-5.5: `update.last_checked_at` is written on EVERY attempt, success or failure, before
   * runUpdateCheck returns. A container in a crash-restart loop therefore makes at most one
   * GitHub request per 24 hours, not one per boot.
   */
  export function recordCheckOutcome(input: {
    at: Date;
    latestVersion?: string | null;
    publishedAt?: string | null;
    error?: string | null;
  }): void {
    setSetting(KEY_LAST_CHECKED_AT, iso(input.at));
    if (input.error !== undefined && input.error !== null) {
      setSetting(KEY_LAST_CHECK_ERROR, input.error);
      // A failure does not invent a version, and does not clear the last one we did observe.
      return;
    }
    deleteSetting(KEY_LAST_CHECK_ERROR);
    writeOrDelete(KEY_LATEST_VERSION, input.latestVersion ?? null);
    writeOrDelete(KEY_LATEST_PUBLISHED_AT, input.publishedAt ?? null);
  }

  /** MUST-7.4 step 1: written and COMMITTED before the fetch, because it may kill this process. */
  export function recordApplyRequested(input: { version: string; at: Date }): void {
    deleteSetting(KEY_LAST_APPLY_ERROR);
    setSetting(KEY_APPLY_REQUESTED_VERSION, input.version);
    setSetting(KEY_APPLY_REQUESTED_AT, iso(input.at));
  }

  export function recordApplyOutcome(input: { at: Date; error?: string | null }): void {
    if (input.error !== undefined && input.error !== null) {
      setSetting(KEY_LAST_APPLY_ERROR, input.error);
      return;
    }
    deleteSetting(KEY_LAST_APPLY_ERROR);
    setSetting(KEY_LAST_APPLIED_AT, iso(input.at));
  }

  /** MUST-5.9: suppresses only the card's prominence, never the check and never the dedup. */
  export function dismissVersion(version: string): void {
    setSetting(KEY_DISMISSED_VERSION, version);
  }

  /**
   * MUST-7.6: what turns "we fired a request into the dark" into a state machine with a
   * definite end, and the reason recordApplyRequested writes BEFORE the fetch.
   *
   * MUST-7.7: this must NEVER throw into the boot path, exactly as notify's
   * raiseRestoreOutcome must not. Called from src/instrumentation-node.ts after getDb() and
   * before startScheduler().
   */
  export function reconcileApplyOnBoot(now: Date = new Date()): void {
    try {
      const requested = getSetting(KEY_APPLY_REQUESTED_VERSION);
      if (requested === null) return;

      if (requested === APP_VERSION) {
        // The apply worked: the container we asked to be replaced is the one we are not.
        setSetting(KEY_LAST_APPLIED_AT, iso(now));
        deleteSetting(KEY_APPLY_REQUESTED_VERSION);
        deleteSetting(KEY_APPLY_REQUESTED_AT);
        deleteSetting(KEY_LAST_APPLY_ERROR);
        deleteSetting(KEY_LATEST_VERSION);
        deleteSetting(KEY_LATEST_PUBLISHED_AT);
        console.log(`[update] confirmed apply to ${APP_VERSION}`);
        return;
      }

      const requestedAt = getSetting(KEY_APPLY_REQUESTED_AT);
      const requestedMs = requestedAt === null ? Number.NaN : Date.parse(requestedAt);
      if (Number.isFinite(requestedMs) && now.getTime() - requestedMs > APPLY_CONFIRM_MAX_AGE_MS) {
        deleteSetting(KEY_APPLY_REQUESTED_VERSION);
        deleteSetting(KEY_APPLY_REQUESTED_AT);
        setSetting(
          KEY_LAST_APPLY_ERROR,
          `The update was requested but the app is still on ${APP_VERSION}. Check the Watchtower container's logs.`,
        );
        return;
      }
      // Otherwise leave the pending state alone: a boot that happens to precede the
      // replacement must not erase the record of what was asked for.
    } catch (error) {
      console.error('[update] boot reconciliation failed', error);
    }
  }
  ```

- [ ] **Run the state test and the type-check.**
  ```powershell
  npx vitest run tests/lib/update/state.test.ts
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Commit.**
  ```powershell
  git add src/lib/update/state.ts tests/lib/update/state.test.ts
  git commit -m "feat(update): settings-backed state and the boot reconciler

Every byte of update state is a settings key/value row, so the feature ships
with no table, no column and no migration, and absence is the off state
(MUST-3.1). This module owns every 'update.' string (MUST-3.2). Disabling wipes
every key but the flag, so re-enabling starts clean (MUST-3.4), and readUpdateState
forces autoApply false while disabled so no caller can reach an apply path
through a stale key (MUST-3.5). reconcileApplyOnBoot turns 'we fired a request
into the dark' into a state machine with a definite end (MUST-7.6) and can never
throw into the boot path (MUST-7.7)."
  ```

<!-- END TASK 3 -->

---

## Task 4: `src/lib/update/github.ts` — the two endpoints, and nothing else

**Context:** Spec §4.1, §4.2 and §8.2's call-site rule. Implements **MUST-4.1 … MUST-4.8** and **MUST-8.5**, plus §19.1's `github.test.ts` and **MUST-19.1** (no test performs real network I/O). Two `fetch` sites, each with `assertGithubUrl()` on the line **immediately above** it — not in a helper, not in a wrapper, because that adjacency is the part a refactor loses first.

**Files:**
- Create: `src/lib/update/github.ts`
- Test: `tests/lib/update/github.test.ts` (**new**)

**Interfaces:**
- Consumes: `GITHUB_API_ORIGIN`, `GITHUB_CHANGELOG_PATH`, `GITHUB_RELEASES_PATH`, `assertGithubUrl` from `@/lib/update/egress`; `formatSemver`, `parseSemver` from `@/lib/update/semver`; `APP_VERSION` from `@/lib/version`; `parseChangelog`, `type ChangelogRelease` from `@/lib/changelog`; `truncateText` from `@/lib/notify/render`.
- Produces:
  ```ts
  export const GITHUB_TIMEOUT_MS = 15_000;
  export const MAX_CHANGELOG_BYTES = 512 * 1024;
  export const MAX_CHANGELOG_GROUPS = 12;
  export const MAX_CHANGELOG_ITEMS = 200;
  export const CHANGELOG_ITEM_MAX = 500;
  export const CHANGELOG_TITLE_MAX = 60;
  export const UNPARSEABLE_TAG_ERROR = 'That release tag is not a version this app can compare.';

  export interface RemoteRelease { tag: string; version: string; publishedAt: string | null }
  export class UpdateCheckError extends Error { readonly permanent: boolean }
  export function fetchLatestRelease(): Promise<RemoteRelease>;
  export function fetchRemoteChangelog(version: string): Promise<string>;
  export function boundRelease(release: ChangelogRelease): ChangelogRelease;
  ```

### Steps

- [ ] **Write the failing `tests/lib/update/github.test.ts` (§19.1, MUST-19.1).**
  ```ts
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
  ```

- [ ] **Write `src/lib/update/github.ts`.** Note the two `fetch` sites and the `assertGithubUrl()` immediately above each — **MUST-8.5, and Task 14 asserts the adjacency at source level.**
  ```ts
  import { parseChangelog, type ChangelogRelease } from '@/lib/changelog';
  import { truncateText } from '@/lib/notify/render';
  import { GITHUB_API_ORIGIN, GITHUB_CHANGELOG_PATH, GITHUB_RELEASES_PATH, assertGithubUrl } from '@/lib/update/egress';
  import { formatSemver, parseSemver } from '@/lib/update/semver';
  import { APP_VERSION } from '@/lib/version';

  /**
   * MUST-4.1: the check compares APP_VERSION with the latest published GitHub release of the
   * PUBLIC repository VibeLogicCode/BudgetTracker. No authentication token is ever sent — an
   * unauthenticated api.github.com caller gets 60 requests per hour per source IP, and this
   * feature's ceiling is one scheduled check per day plus a rate-limited button, so the quota
   * is never a design consideration.
   *
   * MUST-2.2: server-only. Never imported, directly or transitively, from a *-client.tsx.
   */
  export const GITHUB_TIMEOUT_MS = 15_000;
  export const MAX_CHANGELOG_BYTES = 512 * 1024;
  export const MAX_CHANGELOG_GROUPS = 12;
  export const MAX_CHANGELOG_ITEMS = 200;
  export const CHANGELOG_ITEM_MAX = 500;
  export const CHANGELOG_TITLE_MAX = 60;

  export const UNPARSEABLE_TAG_ERROR = 'That release tag is not a version this app can compare.';
  const MALFORMED_ERROR = 'GitHub returned something this app could not read.';
  const CHANGELOG_UNREADABLE = 'The release notes could not be read.';

  export interface RemoteRelease {
    /** The release tag exactly as GitHub reports it, e.g. "v1.4.0". */
    tag: string;
    /** The tag with one optional leading "v" stripped, e.g. "1.4.0". */
    version: string;
    publishedAt: string | null;
  }

  /**
   * MUST-4.7: `permanent` is true for HTTP 401/403/404/422 and for a malformed payload; false
   * for 429, any 5xx, a DNS failure, a connect timeout and an abort. There is no backoff
   * ladder, because there is at most one automatic attempt per day already (MUST-5.5).
   */
  export class UpdateCheckError extends Error {
    readonly permanent: boolean;

    constructor(message: string, options: { permanent: boolean }) {
      super(message);
      this.name = 'UpdateCheckError';
      this.permanent = options.permanent;
    }
  }

  /** MUST-4.3: these three, and nothing else. No Authorization. No cookie. No telemetry field. */
  function headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub requires a User-Agent; ours names the product and its version and nothing
      // about the install — not its hostname, not its data directory, not its user count.
      'User-Agent': `BudgetTracker/${APP_VERSION}`,
    };
  }

  function statusIsPermanent(status: number): boolean {
    return status === 401 || status === 403 || status === 404 || status === 422;
  }

  /** MUST-4.4: 15 s abort and redirect: 'error'. A 3xx from api.github.com is a failure, not a hop. */
  async function get(url: string): Promise<Response> {
    try {
      // Deliberately NOT hoisted into a helper above the fetch: MUST-8.5 requires the guard on
      // the line immediately preceding each call site. See the two call sites below.
      return await fetch(url, {
        method: 'GET',
        headers: headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The GitHub request failed.';
      throw new UpdateCheckError(message, { permanent: false });
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new UpdateCheckError(MALFORMED_ERROR, { permanent: true });
    }
  }

  /**
   * MUST-4.2 endpoint 1. MUST-4.6: the ONLY fields read are tag_name and published_at. draft
   * and prerelease releases are refused by the endpoint itself — /releases/latest excludes
   * both — and a tag_name that fails parseSemver raises a PERMANENT error rather than being
   * guessed at, which is what keeps an unclassifiable version away from an auto-apply
   * decision (MUST-4.10).
   */
  export async function fetchLatestRelease(): Promise<RemoteRelease> {
    const url = `${GITHUB_API_ORIGIN}${GITHUB_RELEASES_PATH}`;
    assertGithubUrl(url);
    const response = await get(url);
    if (!response.ok) {
      throw new UpdateCheckError(`GitHub returned ${response.status}.`, { permanent: statusIsPermanent(response.status) });
    }

    const payload = (await readJson(response)) as { tag_name?: unknown; published_at?: unknown };
    const tag = typeof payload.tag_name === 'string' ? payload.tag_name : '';
    const parsed = parseSemver(tag);
    if (parsed === null) throw new UpdateCheckError(UNPARSEABLE_TAG_ERROR, { permanent: true });

    return {
      tag,
      // Re-serialised from the parsed integers, never passed through (MUST-4.2).
      version: formatSemver(parsed),
      publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
    };
  }

  /**
   * MUST-4.2 endpoint 2, pinned to the release's OWN tag rather than the default branch, so
   * the changelog an admin reads on the confirm screen is the changelog of the version being
   * offered — not whatever `main` happens to hold.
   *
   * `version` is re-serialised from parseSemver's integer components before it reaches the
   * URL: a value that survived parseSemver cannot contain a path or query character.
   */
  export async function fetchRemoteChangelog(version: string): Promise<string> {
    const parsed = parseSemver(version);
    if (parsed === null) throw new UpdateCheckError(UNPARSEABLE_TAG_ERROR, { permanent: true });

    const url = `${GITHUB_API_ORIGIN}${GITHUB_CHANGELOG_PATH}?ref=v${formatSemver(parsed)}`;
    assertGithubUrl(url);
    const response = await get(url);
    if (!response.ok) {
      throw new UpdateCheckError(`GitHub returned ${response.status}.`, { permanent: statusIsPermanent(response.status) });
    }

    // MUST-4.6: the only fields read are encoding, size and content, and both guards are
    // permanent failures — the confirm screen then renders MUST-9.6's fallback sentence.
    const payload = (await readJson(response)) as { encoding?: unknown; size?: unknown; content?: unknown };
    if (payload.encoding !== 'base64') throw new UpdateCheckError(CHANGELOG_UNREADABLE, { permanent: true });
    if (typeof payload.size !== 'number' || payload.size > MAX_CHANGELOG_BYTES) {
      throw new UpdateCheckError(CHANGELOG_UNREADABLE, { permanent: true });
    }
    if (typeof payload.content !== 'string') throw new UpdateCheckError(CHANGELOG_UNREADABLE, { permanent: true });

    return Buffer.from(payload.content, 'base64').toString('utf8');
  }

  /**
   * MUST-4.8: a repository is a place a person can write anything, and the confirm screen
   * treats it that way. The decoded text is parsed by the EXISTING pure parseChangelog() and
   * rendered by the EXISTING renderEmphasis() bold-run helper — no markdown library,
   * no dangerouslySetInnerHTML anywhere — and the parsed result is bounded here, with the
   * same truncateText discipline notify MUST-10.3 applies to merchant names.
   */
  export function boundRelease(release: ChangelogRelease): ChangelogRelease {
    const groups: ChangelogRelease['groups'] = [];
    let budget = MAX_CHANGELOG_ITEMS;
    for (const group of release.groups.slice(0, MAX_CHANGELOG_GROUPS)) {
      if (budget <= 0) break;
      const items = group.items.slice(0, budget).map((item) => truncateText(item, CHANGELOG_ITEM_MAX));
      budget -= items.length;
      groups.push({ title: truncateText(group.title, CHANGELOG_TITLE_MAX), items });
    }
    return {
      heading: truncateText(release.heading, CHANGELOG_TITLE_MAX),
      notes: release.notes.slice(0, MAX_CHANGELOG_GROUPS).map((note) => truncateText(note, CHANGELOG_ITEM_MAX)),
      groups,
    };
  }

  /** Re-exported so callers parse remote text with the same reader the About panel uses. */
  export { parseChangelog };
  ```

- [ ] **Run the github test and the type-check.**
  ```powershell
  npx vitest run tests/lib/update/github.test.ts
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Verify the guard adjacency by eye before Task 14 automates it (MUST-8.5).**
  ```powershell
  Select-String -Path .\src\lib\update\github.ts -Pattern 'assertGithubUrl\(|await get\(|fetch\(' -Context 0,1
  ```
  Expected: `assertGithubUrl(url);` on the line directly above each `await get(url);`, and exactly **one** literal `fetch(` in the file — inside `get()`. The count is two *endpoints*, one *call site*; Task 14's table entry for `src/lib/update/github.ts` is therefore `1`, not `2`, and Task 14 records why.

- [ ] **Commit.**
  ```powershell
  git add src/lib/update/github.ts tests/lib/update/github.test.ts
  git commit -m "feat(update): the two GitHub endpoints, guarded and bounded

Exactly two endpoints on api.github.com, both GET, both carrying only Accept,
X-GitHub-Api-Version and a User-Agent naming the product and its version - no
Authorization, no cookie, no telemetry field (MUST-4.3). redirect: 'error' and a
15s abort (MUST-4.4). assertGithubUrl on the line immediately above the call
(MUST-8.5). The changelog read is pinned to the release's own tag, with the ref
re-serialised from parsed integers so a caller-supplied value can never reach the
URL (MUST-4.2). A tag that fails strict semver is a permanent error, never a
guess (MUST-4.6/4.10), and the parsed remote notes are bounded to 12 groups /
200 items / 500 characters because a repository is a place a person can write
anything (MUST-4.8)."
  ```

<!-- END TASK 4 -->

---

## Task 5: `WATCHTOWER_URL` / `WATCHTOWER_TOKEN` in `AppEnv`, and `src/lib/update/watchtower.ts`

**Context:** Spec §7.1–§7.3 and §8.3's consequence. Implements **MUST-7.1 … MUST-7.5**, **MUST-7.8**, **MUST-8.7**, **MUST-10.11** (the scrubber on every apply path), and §19.1's `watchtower.test.ts`. The app never touches the Docker socket, never shells out, never writes a compose file and never restarts itself: it sends **one HTTP request** to a container that already holds the socket.

**Files:**
- Modify: `src/lib/env.ts` (`AppEnv` gains two nullable fields)
- Create: `src/lib/update/watchtower.ts`
- Test: `tests/lib/env.test.ts` (append), `tests/lib/update/watchtower.test.ts` (**new**)

**Interfaces:**
- Consumes: `assertWatchtowerUrl` from `@/lib/update/egress`; `scrubSecrets` from `@/lib/notify/crypto`; `readEnv` from `@/lib/env`.
- Produces:
  ```ts
  // src/lib/env.ts — AppEnv gains, after `dataDir`
  watchtowerUrl: string | null;
  watchtowerToken: string | null;

  // src/lib/update/watchtower.ts
  export const WATCHTOWER_TIMEOUT_MS = 30_000;
  export const WATCHTOWER_BAD_URL_ERROR = 'The WATCHTOWER_URL in your compose file is not a valid internal address.';
  export const WATCHTOWER_TOKEN_ERROR = 'Watchtower rejected the token. Check that WATCHTOWER_TOKEN matches WATCHTOWER_HTTP_API_TOKEN in your compose file.';
  export interface WatchtowerConfig { url: string; token: string }
  export type TriggerOutcome = 'accepted' | 'accepted-unconfirmed';
  export class WatchtowerError extends Error { readonly permanent: boolean }
  export function watchtowerConfig(source?: Partial<NodeJS.ProcessEnv>): WatchtowerConfig | null;
  export function watchtowerConfigError(source?: Partial<NodeJS.ProcessEnv>): string | null;
  export function triggerUpdate(config: WatchtowerConfig): Promise<TriggerOutcome>;
  ```

### Steps

- [ ] **Extend `AppEnv` in `src/lib/env.ts` (MUST-7.2).** Add to the interface, after `dataDir`:
  ```ts
    /**
     * v1.3.1 (spec §7.2). Both optional, both absent on a build-from-source install; the
     * prebuilt-image compose file in install/synology-compose-pull.yml sets them.
     *
     * readEnv() deliberately does NOT validate the URL. A malformed value must not stop the
     * app booting — it is validated at the point of use by assertWatchtowerUrl() and reported
     * on the Updates card instead (MUST-8.7).
     */
    watchtowerUrl: string | null;
    watchtowerToken: string | null;
  ```
  and to the returned object in `readEnv()`, after `dataDir`, read the same way `TRUST_PROXY` is — with the empty string treated as absent:
  ```ts
      watchtowerUrl: (source.WATCHTOWER_URL ?? '').trim().length > 0 ? (source.WATCHTOWER_URL as string).trim() : null,
      watchtowerToken: (source.WATCHTOWER_TOKEN ?? '').trim().length > 0 ? (source.WATCHTOWER_TOKEN as string).trim() : null,
  ```

- [ ] **Append to `tests/lib/env.test.ts`.** Use the file's existing `describe`/`readEnv` imports rather than re-declaring them.
  ```ts
  describe('MUST-7.2: the two optional Watchtower variables', () => {
    it('are null when absent and null when empty', () => {
      const base = { SECRET_KEY: 'x'.repeat(40), DATA_DIR: '/tmp/bt-env-test' };
      expect(readEnv(base).watchtowerUrl).toBeNull();
      expect(readEnv(base).watchtowerToken).toBeNull();
      expect(readEnv({ ...base, WATCHTOWER_URL: '', WATCHTOWER_TOKEN: '' }).watchtowerUrl).toBeNull();
      expect(readEnv({ ...base, WATCHTOWER_URL: '', WATCHTOWER_TOKEN: '' }).watchtowerToken).toBeNull();
    });

    it('are read and trimmed, and a malformed URL does NOT stop the app booting', () => {
      const base = { SECRET_KEY: 'x'.repeat(40), DATA_DIR: '/tmp/bt-env-test' };
      const env = readEnv({ ...base, WATCHTOWER_URL: '  http://watchtower:8080/v1/update ', WATCHTOWER_TOKEN: ' tok ' });
      expect(env.watchtowerUrl).toBe('http://watchtower:8080/v1/update');
      expect(env.watchtowerToken).toBe('tok');
      // MUST-8.7: validation happens at the point of use, not here.
      expect(() => readEnv({ ...base, WATCHTOWER_URL: 'not a url', WATCHTOWER_TOKEN: 'tok' })).not.toThrow();
    });
  });
  ```

- [ ] **Write the failing `tests/lib/update/watchtower.test.ts` (§19.1).**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import {
    WATCHTOWER_BAD_URL_ERROR,
    WATCHTOWER_TOKEN_ERROR,
    WatchtowerError,
    triggerUpdate,
    watchtowerConfig,
    watchtowerConfigError,
  } from '@/lib/update/watchtower';

  const realFetch = globalThis.fetch;
  let calls: { url: string; init: RequestInit }[] = [];

  const GOOD = { WATCHTOWER_URL: 'http://watchtower:8080/v1/update', WATCHTOWER_TOKEN: 'budget-tracker-local-update' };

  function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  describe('MUST-7.8 / MUST-8.7: watchtowerConfig is null unless both vars are usable', () => {
    it('returns the pair when both are present and the URL passes the guard', () => {
      expect(watchtowerConfig(GOOD)).toEqual({ url: GOOD.WATCHTOWER_URL, token: GOOD.WATCHTOWER_TOKEN });
      expect(watchtowerConfigError(GOOD)).toBeNull();
    });

    it('returns null when either is absent or empty, with no error to report', () => {
      expect(watchtowerConfig({ WATCHTOWER_URL: GOOD.WATCHTOWER_URL })).toBeNull();
      expect(watchtowerConfig({ WATCHTOWER_TOKEN: GOOD.WATCHTOWER_TOKEN })).toBeNull();
      expect(watchtowerConfig({ WATCHTOWER_URL: '', WATCHTOWER_TOKEN: '' })).toBeNull();
      // No compose file, nothing to complain about — this is the ordinary fallback path.
      expect(watchtowerConfigError({})).toBeNull();
    });

    it('returns null AND a reportable error when the URL fails the guard', () => {
      const bad = { WATCHTOWER_URL: 'http://evil.example.com/v1/update', WATCHTOWER_TOKEN: 'tok' };
      expect(watchtowerConfig(bad)).toBeNull();
      expect(watchtowerConfigError(bad)).toBe(WATCHTOWER_BAD_URL_ERROR);
    });
  });

  describe('MUST-7.1 / MUST-7.4: the apply request', () => {
    it('is a GET carrying a bearer token, redirect: error and a 30s abort', async () => {
      stub(() => new Response('', { status: 200 }));
      await expect(triggerUpdate(watchtowerConfig(GOOD)!)).resolves.toBe('accepted');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(GOOD.WATCHTOWER_URL);
      expect(calls[0]!.init.method).toBe('GET');
      expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${GOOD.WATCHTOWER_TOKEN}`);
      expect(calls[0]!.init.redirect).toBe('error');
      expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    });

    it('MUST-7.4 step 5: a 401 or 403 is a permanent error naming the compose variables', async () => {
      for (const status of [401, 403]) {
        calls = [];
        stub(() => new Response('', { status }));
        const error = (await triggerUpdate(watchtowerConfig(GOOD)!).catch((e: unknown) => e)) as WatchtowerError;
        expect(error).toBeInstanceOf(WatchtowerError);
        expect(error.permanent).toBe(true);
        expect(error.message).toBe(WATCHTOWER_TOKEN_ERROR);
      }
    });

    it('MUST-7.3 / MUST-10.11: no error message contains any substring of the token', async () => {
      const token = 'budget-tracker-local-update';
      stub(() => {
        throw new Error(`connect ECONNREFUSED with Authorization: Bearer ${token}`);
      });
      const error = (await triggerUpdate({ url: GOOD.WATCHTOWER_URL, token }).catch((e: unknown) => e)) as WatchtowerError;
      expect(error.message).not.toContain(token);
      expect(error.message).toContain('[redacted]');
    });

    it('MUST-7.5: an abort AFTER the request was written is accepted-unconfirmed, not a failure', async () => {
      stub(() => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });
      await expect(triggerUpdate(watchtowerConfig(GOOD)!)).resolves.toBe('accepted-unconfirmed');

      stub(() => {
        const error = new Error('socket hang up') as Error & { code?: string };
        error.code = 'ECONNRESET';
        throw error;
      });
      await expect(triggerUpdate(watchtowerConfig(GOOD)!)).resolves.toBe('accepted-unconfirmed');
    });

    it('MUST-7.4 step 6: any other non-2xx is a scrubbed status line and a throw', async () => {
      stub(() => new Response('', { status: 500 }));
      const error = (await triggerUpdate(watchtowerConfig(GOOD)!).catch((e: unknown) => e)) as WatchtowerError;
      expect(error.permanent).toBe(false);
      expect(error.message).toContain('500');
    });

    it('refuses to fetch at all when the URL fails the guard', async () => {
      stub(() => new Response('', { status: 200 }));
      await expect(triggerUpdate({ url: 'http://evil.example.com/v1/update', token: 'tok' })).rejects.toBeInstanceOf(
        WatchtowerError,
      );
      expect(calls).toHaveLength(0);
    });
  });
  ```

- [ ] **Write `src/lib/update/watchtower.ts`.** **MUST-2.3: there is no `://` literal in this file.** The URL arrives from the environment.
  ```ts
  import { readEnv } from '@/lib/env';
  import { scrubSecrets } from '@/lib/notify/crypto';
  import { assertWatchtowerUrl } from '@/lib/update/egress';

  /**
   * MUST-7.1: the app never touches the Docker socket, never shells out, never writes a
   * compose file and never restarts itself. It sends ONE HTTP request to the Watchtower
   * companion container on the compose network, and Watchtower — which already holds the
   * socket, already carries the label scope, and is already the thing that updates this app on
   * a prebuilt-image install — does the rest.
   *
   * The method is GET because that is the shape Watchtower's own documentation specifies for
   * /v1/update: the endpoint's contract is Watchtower's to define, not ours. Any 2xx is
   * "accepted".
   *
   * MUST-2.3: no `://` string literal appears in this file. The URL comes from WATCHTOWER_URL
   * and its default value is written once, in YAML, in install/synology-compose-pull.yml.
   * MUST-2.2: server-only. Never imported from a *-client.tsx.
   */
  export const WATCHTOWER_TIMEOUT_MS = 30_000;

  export const WATCHTOWER_BAD_URL_ERROR = 'The WATCHTOWER_URL in your compose file is not a valid internal address.';
  export const WATCHTOWER_TOKEN_ERROR =
    'Watchtower rejected the token. Check that WATCHTOWER_TOKEN matches WATCHTOWER_HTTP_API_TOKEN in your compose file.';

  export interface WatchtowerConfig {
    url: string;
    token: string;
  }

  export type TriggerOutcome = 'accepted' | 'accepted-unconfirmed';

  export class WatchtowerError extends Error {
    readonly permanent: boolean;

    constructor(message: string, options: { permanent: boolean }) {
      super(message);
      this.name = 'WatchtowerError';
      this.permanent = options.permanent;
    }
  }

  function pair(source: Partial<NodeJS.ProcessEnv> | undefined): { url: string; token: string } | null {
    if (source === undefined) {
      const env = readEnv();
      if (env.watchtowerUrl === null || env.watchtowerToken === null) return null;
      return { url: env.watchtowerUrl, token: env.watchtowerToken };
    }
    const url = (source.WATCHTOWER_URL ?? '').trim();
    const token = (source.WATCHTOWER_TOKEN ?? '').trim();
    if (url.length === 0 || token.length === 0) return null;
    return { url, token };
  }

  /**
   * MUST-7.8 / MUST-8.7: null on a build-from-source install, a bare `npm start`, or a pull
   * install whose compose predates §16.1 — and null, too, when the URL fails the guard, which
   * puts that install on the same fallback path with a reportable reason. Never a 500, never a
   * silent no-op.
   */
  export function watchtowerConfig(source?: Partial<NodeJS.ProcessEnv>): WatchtowerConfig | null {
    const found = pair(source);
    if (found === null) return null;
    try {
      assertWatchtowerUrl(found.url);
    } catch {
      return null;
    }
    return found;
  }

  /** The card's reason line: non-null only when both vars are SET and the URL is unusable. */
  export function watchtowerConfigError(source?: Partial<NodeJS.ProcessEnv>): string | null {
    const found = pair(source);
    if (found === null) return null;
    try {
      assertWatchtowerUrl(found.url);
      return null;
    } catch {
      return WATCHTOWER_BAD_URL_ERROR;
    }
  }

  /**
   * MUST-7.5: Watchtower's /v1/update handler performs the update and THEN responds — and the
   * container being replaced is this one. It is therefore entirely normal for the connection
   * to die before a response arrives: the app has just asked something to kill it. Treating
   * that as a failure would show a red error on the last screen a person sees before the app
   * comes back healthy on the new version, which is the worst possible false negative.
   */
  function isReplacementSignal(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    const code = (error as Error & { code?: string }).code;
    if (code === 'ECONNRESET' || code === 'EPIPE') return true;
    return /socket hang up|aborted|ECONNRESET|EPIPE/i.test(error.message);
  }

  /**
   * MUST-10.11: every string this function can produce passes through scrubSecrets with the
   * token in the secret list. An Authorization header can end up quoted in a fetch error or a
   * redirect message, which is exactly the hazard notify MUST-5.5 exists for.
   */
  function clean(message: string, token: string): string {
    return scrubSecrets(message, [token]);
  }

  export async function triggerUpdate(config: WatchtowerConfig): Promise<TriggerOutcome> {
    try {
      assertWatchtowerUrl(config.url);
    } catch {
      throw new WatchtowerError(WATCHTOWER_BAD_URL_ERROR, { permanent: true });
    }

    let response: Response;
    try {
      // MUST-8.5: the guard is immediately above the call. Task 14 asserts the adjacency.
      assertWatchtowerUrl(config.url);
      response = await fetch(config.url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(WATCHTOWER_TIMEOUT_MS),
      });
    } catch (error) {
      // MUST-7.4 step 7 / MUST-7.5.
      if (isReplacementSignal(error)) return 'accepted-unconfirmed';
      const raw = error instanceof Error ? error.message : 'The Watchtower request failed.';
      throw new WatchtowerError(clean(raw, config.token), { permanent: false });
    }

    if (response.ok) return 'accepted';
    if (response.status === 401 || response.status === 403) {
      throw new WatchtowerError(WATCHTOWER_TOKEN_ERROR, { permanent: true });
    }
    throw new WatchtowerError(clean(`Watchtower returned ${response.status}.`, config.token), { permanent: false });
  }
  ```

- [ ] **Run the two test files and the type-check.**
  ```powershell
  npx vitest run tests/lib/update/watchtower.test.ts tests/lib/env.test.ts
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Commit.**
  ```powershell
  git add src/lib/env.ts src/lib/update/watchtower.ts tests/lib/env.test.ts tests/lib/update/watchtower.test.ts
  git commit -m "feat(update): the Watchtower HTTP-API client and its two env vars

One GET with a bearer token to a container that already holds the Docker socket -
the app never touches the socket, never shells out and never restarts itself
(MUST-7.1). A dropped connection AFTER the request was written is
'accepted-unconfirmed', not a failure, because the container being replaced is
this one and a red error on the last screen before a successful update is the
worst possible false negative (MUST-7.5). watchtowerConfig returns null when
either var is absent or the URL fails assertWatchtowerUrl, which puts the install
on the manual-update fallback with a reportable reason rather than a 500
(MUST-7.8/8.7). Every error string is scrubbed with the token in the secret list
(MUST-10.11), and the file contains no :// literal (MUST-2.3)."
  ```

<!-- END TASK 5 -->

---

## Task 6: The orchestrator, the `update_available` event, the tick and the boot seam

**Context:** Spec §5 and §6 in full, plus §7.3's boot slot. Implements **MUST-5.1 … MUST-5.9**, **MUST-6.1 … MUST-6.6**, **MUST-7.6** (the wiring half), **MUST-10.5**, **MUST-10.6**, and §19.2's event, render, dedup, scheduler and restore-seam assertions. This task also **discharges notify MUST-4.4**: adding an event touches exactly three files — `events.ts`, `render.ts` and the caller — with no migration, no `src/db/schema.ts` change and no UI edit.

**Files:**
- Create: `src/lib/update/check.ts`
- Modify: `src/lib/notify/events.ts` (one appended entry, one appended key builder)
- Modify: `src/lib/notify/render.ts` (one `RenderInput` member, one `case`)
- Modify: `src/lib/scheduler.ts` (`runUpdateTick`, the cron callback, the boot call, the `stopScheduler` reset)
- Modify: `src/instrumentation-node.ts` (one guarded `reconcileApplyOnBoot()` call)
- Test: `tests/lib/update/check.test.ts` (**new**); append to `tests/lib/notify/events.test.ts`, `tests/lib/notify/render.test.ts`, `tests/lib/notify/dedup.test.ts`, `tests/lib/scheduler.test.ts`, `tests/ops/restore-seams.test.ts`

**Interfaces:**
- Consumes: `readUpdateState`, `recordApplyOutcome`, `recordApplyRequested`, `recordCheckOutcome`, `isUpdateCheckEnabled`, `reconcileApplyOnBoot` from `@/lib/update/state`; `fetchLatestRelease`, `UpdateCheckError` from `@/lib/update/github`; `triggerUpdate`, `watchtowerConfig`, `WatchtowerError` from `@/lib/update/watchtower`; `classify`, `parseSemver`, `type UpdateSeverity` from `@/lib/update/semver`; `APP_VERSION` from `@/lib/version`; `adminUserIds` from `@/lib/notify/config`; `enqueue`, `kickOutbox` from `@/lib/notify/outbox`; `renderEvent` from `@/lib/notify/render`; `updateAvailableKey` from `@/lib/notify/events`; `scrubSecrets` from `@/lib/notify/crypto`.
- Produces:
  ```ts
  // src/lib/update/check.ts
  export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  export interface UpdateCheckResult {
    severity: UpdateSeverity;
    currentVersion: string;
    latestVersion: string | null;
    applied: boolean;
    notified: boolean;
    error: string | null;
  }
  export function dueForCheck(lastCheckedAt: string | null, now: Date): boolean;
  export function runUpdateCheck(input: { now?: Date; manual?: boolean }): Promise<UpdateCheckResult>;
  export function applyUpdate(input: { version: string; now?: Date }): Promise<TriggerOutcome>;

  // src/lib/notify/events.ts
  export function updateAvailableKey(version: string): string;   // `update:${version}`
  // NOTIFICATION_EVENTS gains one entry, id 'update_available' — the registry is now NINE.

  // src/lib/scheduler.ts
  export function runUpdateTick(now?: Date): void;
  ```

### Steps

- [ ] **Append the registry entry to `src/lib/notify/events.ts` (MUST-6.1).** One array entry, at the END of `NOTIFICATION_EVENTS`. Nothing else in that file changes except the appended key builder below.
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
  and, at the END of the file, beside the other key builders:
  ```ts
  /**
   * Once per remote version, ever. Versions only ever go up, so this key never recurs.
   *
   * MUST-6.3 (pruning safety, honestly stated): there is ONE residual case. An install that
   * stays on its current version for more than 400 days while the same newer release remains
   * the latest will have its `update:<version>` row pruned by the retention sweep and will be
   * told once more, on the following check, that that version is available. One reminder every
   * 400 days about an update you have been ignoring for 400 days is correct behaviour, not a
   * defect, and it is the only condition under which this key can regenerate.
   */
  export function updateAvailableKey(version: string): string {
    return `update:${version}`;
  }
  ```

- [ ] **Append the union member and the `case` to `src/lib/notify/render.ts` (MUST-6.4).** Add to the END of the `RenderInput` union:
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
  and, at the END of `renderEvent`'s switch — **the switch keeps its no-`default` shape (MUST-6.6): the declared return type means a union member with no matching case is a TS2366 compile error, which is the safety net and the reason both land in the same change**:
  ```ts
      case 'update_available': {
        const major = input.severity === 'major';
        const subject = major
          ? `Budget Tracker ${input.latestVersion} is available (major update)`
          : `Budget Tracker ${input.latestVersion} is available`;
        if (major) {
          return {
            subject,
            body:
              `You are running ${input.currentVersion}. Version ${input.latestVersion} is a major update, so this ` +
              'app will not install it on its own. Open Settings, read what changed, and press Review and update ' +
              'when you are ready.' +
              publishedLine(input.publishedAt),
          };
        }
        // MUST-6.5: no body carries a URL (notify MUST-10.4), and publishedAt renders with the
        // app's one timestamp convention and nothing else. Version strings are re-serialised
        // from parsed integers upstream (MUST-4.2), so nothing from the remote payload reaches
        // a message body unparsed.
        const tail = input.canApplyInApp
          ? 'Automatic updates are switched off, so open Settings and press Update now when you want it.'
          : 'This install cannot update itself — see Settings for how to update it by hand.';
        return {
          subject,
          body: `You are running ${input.currentVersion}. Version ${input.latestVersion} is published. ${tail}${publishedLine(input.publishedAt)}`,
        };
      }
  ```
  and, beside the file's other private helpers (near `inDays`):
  ```ts
  /** notify §11.4's amendment: iso.slice(0, 16).replace('T', ' ') is the app's ONE convention. */
  function publishedLine(publishedAt: string | null): string {
    if (publishedAt === null) return '';
    return `\n\nPublished ${publishedAt.slice(0, 16).replace('T', ' ')}.`;
  }
  ```

- [ ] **Write `src/lib/update/check.ts`.**
  ```ts
  import { adminUserIds } from '@/lib/notify/config';
  import { scrubSecrets } from '@/lib/notify/crypto';
  import { updateAvailableKey } from '@/lib/notify/events';
  import { enqueue, kickOutbox } from '@/lib/notify/outbox';
  import { renderEvent } from '@/lib/notify/render';
  import { UpdateCheckError, fetchLatestRelease } from '@/lib/update/github';
  import { classify, parseSemver, type UpdateSeverity } from '@/lib/update/semver';
  import {
    readUpdateState,
    recordApplyOutcome,
    recordApplyRequested,
    recordCheckOutcome,
  } from '@/lib/update/state';
  import { WatchtowerError, triggerUpdate, watchtowerConfig, type TriggerOutcome } from '@/lib/update/watchtower';
  import { APP_VERSION } from '@/lib/version';

  /** MUST-5.5: one automatic attempt per 24 hours, counted from EVERY attempt. */
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

  /**
   * MUST-5.5: compares against `update.last_checked_at`, which is written on every attempt —
   * success or failure — so a container in a crash-restart loop makes at most one GitHub
   * request per 24 hours, not one per boot, and a repeatedly failing check cannot become a
   * retry storm.
   */
  export function dueForCheck(lastCheckedAt: string | null, now: Date): boolean {
    if (lastCheckedAt === null) return true;
    const last = Date.parse(lastCheckedAt);
    if (!Number.isFinite(last)) return true;
    return now.getTime() - last >= UPDATE_CHECK_INTERVAL_MS;
  }

  function scrub(text: string): string {
    const token = watchtowerConfig()?.token;
    return token === undefined ? text : scrubSecrets(text, [token]);
  }

  /**
   * MUST-7.4: the ordering is load-bearing.
   *   1. recordApplyRequested — written and COMMITTED before the fetch, because the request
   *      that follows may kill this process. reconcileApplyOnBoot then closes the loop.
   *   2..7 live in triggerUpdate (assert, fetch, classify the outcome).
   *
   * MUST-10.11: every string that can reach `update.last_apply_error`, console.* or the
   * browser goes through scrubSecrets with the token in the secret list.
   */
  export async function applyUpdate(input: { version: string; now?: Date }): Promise<TriggerOutcome> {
    const at = input.now ?? new Date();
    const config = watchtowerConfig();
    if (config === null) throw new WatchtowerError('This install has no Watchtower companion to ask.', { permanent: true });

    recordApplyRequested({ version: input.version, at });
    try {
      const outcome = await triggerUpdate(config);
      // 'accepted-unconfirmed' records NO error: the app has just asked something to kill it.
      recordApplyOutcome({ at });
      return outcome;
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'The update request failed.';
      recordApplyOutcome({ at, error: scrubSecrets(raw, [config.token]) });
      throw error;
    }
  }

  /**
   * MUST-10.5: the scheduler tick and the Check-now button call THIS function. There is no
   * second code path, so a manual check and an automatic one can never classify the same pair
   * of versions differently.
   *
   * MUST-5.7: after a successful check, exactly one of five outcomes obtains, and this
   * function returns which.
   */
  export async function runUpdateCheck(input: { now?: Date; manual?: boolean }): Promise<UpdateCheckResult> {
    const at = input.now ?? new Date();
    const currentVersion = APP_VERSION;
    const current = parseSemver(currentVersion);

    let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
    try {
      release = await fetchLatestRelease();
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : 'The update check failed.');
      // MUST-5.5: the stamp is written on a FAILED attempt too, before returning.
      recordCheckOutcome({ at, error: message });
      if (!(error instanceof UpdateCheckError)) console.error('[update] check failed', message);
      return { severity: 'none', currentVersion, latestVersion: null, applied: false, notified: false, error: message };
    }

    const remote = parseSemver(release.version);
    if (current === null || remote === null) {
      const message = 'This app could not compare its own version with the published one.';
      recordCheckOutcome({ at, error: message });
      return { severity: 'none', currentVersion, latestVersion: null, applied: false, notified: false, error: message };
    }

    const severity = classify(current, remote);
    if (severity === 'none') {
      recordCheckOutcome({ at, latestVersion: null, publishedAt: null });
      return { severity, currentVersion, latestVersion: null, applied: false, notified: false, error: null };
    }
    recordCheckOutcome({ at, latestVersion: release.version, publishedAt: release.publishedAt });

    const state = readUpdateState();
    const config = watchtowerConfig();
    let autoApply = state.autoApply;
    // MUST-5.8: UNCONDITIONAL, and placed BEFORE the apply branch rather than as a condition
    // inside it. There is no setting, environment variable or query parameter that makes a
    // major auto-apply. A major version is by definition the release where the maintainer is
    // telling you something changed underneath you, and this app runs a household's financial
    // records unattended on a NAS.
    if (severity === 'major') autoApply = false;

    if (autoApply && config !== null) {
      try {
        await applyUpdate({ version: release.version, now: at });
        // MUST-5.7 row 2: NO notification. The container is about to be replaced and Settings
        // -> About will show the new version.
        return { severity, currentVersion, latestVersion: release.version, applied: true, notified: false, error: null };
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : 'The update could not be applied.');
        console.error('[update] apply failed', message);
        return { severity, currentVersion, latestVersion: release.version, applied: false, notified: false, error: message };
      }
    }

    const notified = notifyUpdateAvailable({
      currentVersion,
      latestVersion: release.version,
      severity,
      publishedAt: release.publishedAt,
      canApplyInApp: config !== null,
      at,
    });
    return { severity, currentVersion, latestVersion: release.version, applied: false, notified, error: null };
  }

  /**
   * MUST-6.2: this — one enqueue() plus one kickOutbox() — is the third and last file the
   * new event touches. No migration. No src/db/schema.ts change. No settings-UI change,
   * because the toggle matrix is generated from the registry.
   *
   * MUST-4.3 (notify): audience 'admin', so this fans out to active admins only.
   */
  function notifyUpdateAvailable(input: {
    currentVersion: string;
    latestVersion: string;
    severity: Exclude<UpdateSeverity, 'none'>;
    publishedAt: string | null;
    canApplyInApp: boolean;
    at: Date;
  }): boolean {
    try {
      const { subject, body } = renderEvent({
        event: 'update_available',
        currentVersion: input.currentVersion,
        latestVersion: input.latestVersion,
        severity: input.severity,
        publishedAt: input.publishedAt,
        canApplyInApp: input.canApplyInApp,
      });
      let queued = 0;
      for (const userId of adminUserIds()) {
        queued += enqueue({
          userId,
          eventId: 'update_available',
          // MUST-5.9: the dedup key is per VERSION, so dismissing 1.4.0 and then having 1.5.0
          // published raises a new notice.
          dedupKey: updateAvailableKey(input.latestVersion),
          subject,
          body,
          at: input.at,
        }).inserted.length;
      }
      if (queued > 0) kickOutbox(input.at);
      return queued > 0;
    } catch (error) {
      // A notification failure may not break an update check, exactly as notify MUST-6.19's
      // raisers may not break a login or a boot.
      console.error('[update] update_available raise failed', error);
      return false;
    }
  }
  ```

- [ ] **Wire the tick into `src/lib/scheduler.ts` (MUST-5.1 … MUST-5.4).** Add the two imports, the module-level flag, the exported tick, the two call sites and the `stopScheduler()` reset. **`runNotifyTick` is not touched — MUST-5.3.**
  ```ts
  // ...beside the existing imports
  import { dueForCheck, runUpdateCheck } from '@/lib/update/check';
  import { isUpdateCheckEnabled, readUpdateState } from '@/lib/update/state';
  ```
  ```ts
  /** MUST-5.4: runUpdateTick's own single-flight guard, reset by stopScheduler(). */
  let updateTicking = false;

  /**
   * MUST-5.1 / MUST-5.3: a SEPARATE function with its OWN independent gate, deliberately not
   * folded into runNotifyTick's dormancy bail. The consequence is the correct one: an install
   * with update checks on and no notification channel still checks for updates, and an install
   * with a notification channel and no update checks still makes no GitHub call.
   */
  export function runUpdateTick(now: Date = new Date()): void {
    // The dormancy gate is the tick's first statement: one indexed read of a settings key
    // that is ABSENT on every install nobody has enabled this on.
    if (!isUpdateCheckEnabled()) return;
    if (updateTicking) return;
    const state = readUpdateState();
    if (!dueForCheck(state.lastCheckedAt, now)) return; // UPDATE_CHECK_INTERVAL_MS
    updateTicking = true;
    void runUpdateCheck({ now })
      .catch((error) => console.error('[update] check failed', error))
      .finally(() => {
        updateTicking = false;
      });
  }
  ```
  In `startScheduler()`, replace the cron registration and the boot call (MUST-5.2 — **no new cron expression, no new `ScheduledTask`, no new timezone plumbing**):
  ```ts
    notifyTask = cron.schedule(
      NOTIFY_TICK_CRON,
      () => {
        runUpdateTick();
        runNotifyTick();
      },
      { timezone: tz },
    );
  ```
  ```ts
    // MUST-5.2: immediately before runNotifyTick, on the boot path too.
    runUpdateTick();
    runNotifyTick();
  ```
  and in `stopScheduler()`, beside `bootExpiryDone = false;`:
  ```ts
    updateTicking = false;
  ```

- [ ] **Wire the boot reconciler into `src/instrumentation-node.ts` (MUST-7.6, MUST-7.7).** Add the import beside the others, and the guarded call **immediately after** the existing `raiseRestoreOutcome()` try/catch and **before** `startScheduler()`. Warranty §20's ordering is untouched: `applyStagedRestoreOnBoot()` stays the file's first statement and the `'restart'` exit still happens before `getDb()`.
  ```ts
  import { reconcileApplyOnBoot } from '@/lib/update/state';
  ```
  ```ts
  // MUST-7.6: AFTER getDb() above (the outcome is written into the restored database) and
  // BEFORE startScheduler() below. reconcileApplyOnBoot is internally guarded (MUST-7.7) and
  // never throws today; this catch is the same belt-and-braces the raise above carries, so a
  // future change to that guarantee cannot take the boot down with it.
  try {
    reconcileApplyOnBoot();
  } catch (error) {
    console.error('[update] boot reconciliation failed', error);
  }
  ```

- [ ] **Write `tests/lib/update/check.test.ts` (§19.1, AC8).**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
  import { UPDATE_CHECK_INTERVAL_MS, dueForCheck, runUpdateCheck } from '@/lib/update/check';
  import { classify, parseSemver } from '@/lib/update/semver';
  import { readUpdateState, setAutoApply, setUpdateChecksEnabled } from '@/lib/update/state';
  import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
  import { setNotifySenderForTests, resetNotifySenderForTests } from '@/lib/notify/send';
  import { APP_VERSION } from '@/lib/version';

  const realFetch = globalThis.fetch;
  let githubCalls = 0;
  let watchtowerCalls = 0;
  let adminId = 0;
  let t: TestDb;

  const WATCHTOWER = { WATCHTOWER_URL: 'http://watchtower:8080/v1/update', WATCHTOWER_TOKEN: 'tok' };

  function stubRelease(tag: string, publishedAt: string | null = '2026-08-16T09:00:00Z'): void {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        githubCalls += 1;
        return new Response(JSON.stringify({ tag_name: tag, published_at: publishedAt }), { status: 200 });
      }
      watchtowerCalls += 1;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
  }

  function withWatchtower(on: boolean): void {
    if (on) {
      process.env.WATCHTOWER_URL = WATCHTOWER.WATCHTOWER_URL;
      process.env.WATCHTOWER_TOKEN = WATCHTOWER.WATCHTOWER_TOKEN;
    } else {
      delete process.env.WATCHTOWER_URL;
      delete process.env.WATCHTOWER_TOKEN;
    }
  }

  function outboxRows(): { event_id: string; dedup_key: string; user_id: number }[] {
    return t.sqlite
      .prepare(`select event_id, dedup_key, user_id from notification_outbox order by id`)
      .all() as { event_id: string; dedup_key: string; user_id: number }[];
  }

  beforeEach(() => {
    t = createTestDb();
    githubCalls = 0;
    watchtowerCalls = 0;
    adminId = insertTestUser(t.db, { username: 'admin', role: 'admin' });
    setUpdateChecksEnabled({ enabled: true, userId: adminId });
    // A configured channel, so an enqueue actually produces a row (notify MUST-4.2).
    saveSmtp({
      preset: 'custom', host: 'localhost', port: 25, security: 'none', username: 'u',
      password: 'p', fromEmail: 'a@b.com', fromName: 'BT', enabled: true,
    });
    saveEmailTarget({ userId: adminId, destination: 'admin@example.com', enabled: true });
    setNotifySenderForTests(async () => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    withWatchtower(false);
    resetNotifySenderForTests();
    t.cleanup();
    vi.restoreAllMocks();
  });

  describe('MUST-5.5: dueForCheck counts from every attempt', () => {
    it('is due with no stamp, not due at 23 hours, due at 25', () => {
      const now = new Date('2026-08-18T12:00:00.000Z');
      expect(dueForCheck(null, now)).toBe(true);
      expect(dueForCheck(new Date(now.getTime() - 23 * 3_600_000).toISOString(), now)).toBe(false);
      expect(dueForCheck(new Date(now.getTime() - 25 * 3_600_000).toISOString(), now)).toBe(true);
      expect(UPDATE_CHECK_INTERVAL_MS).toBe(86_400_000);
    });
  });

  describe('MUST-5.7: the five outcomes', () => {
    it('none — deletes the cached version and does nothing else', async () => {
      stubRelease(`v${APP_VERSION}`);
      const result = await runUpdateCheck({ now: new Date() });
      expect(result).toMatchObject({ severity: 'none', latestVersion: null, applied: false, notified: false });
      expect(readUpdateState().latestVersion).toBeNull();
      expect(outboxRows()).toEqual([]);
    });

    it('patch with auto-apply on and Watchtower present — applies, and enqueues NOTHING', async () => {
      withWatchtower(true);
      setAutoApply(true);
      stubRelease('v99.0.0'.replace('99', String(Number(APP_VERSION.split('.')[0])))); // same major
      // Use an explicit patch bump rather than string surgery:
      stubRelease(`v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`);
      const result = await runUpdateCheck({ now: new Date() });
      expect(result.severity).toBe('patch');
      expect(result.applied).toBe(true);
      expect(result.notified).toBe(false);
      expect(watchtowerCalls).toBe(1);
      expect(outboxRows()).toEqual([]);
    });

    it('patch with auto-apply OFF — enqueues update_available and applies nothing', async () => {
      withWatchtower(true);
      setAutoApply(false);
      stubRelease(`v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`);
      const result = await runUpdateCheck({ now: new Date() });
      expect(result.applied).toBe(false);
      expect(result.notified).toBe(true);
      expect(watchtowerCalls).toBe(0);
      expect(outboxRows().map((r) => r.event_id)).toContain('update_available');
    });

    it('patch with NO Watchtower — enqueues, and the body says the install cannot update itself', async () => {
      withWatchtower(false);
      setAutoApply(true);
      stubRelease(`v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`);
      const result = await runUpdateCheck({ now: new Date() });
      expect(result.applied).toBe(false);
      expect(result.notified).toBe(true);
      expect(watchtowerCalls).toBe(0);
      const body = t.sqlite.prepare(`select body from notification_outbox limit 1`).get() as { body: string };
      expect(body.body).toContain('cannot update itself');
    });

    it('MUST-5.8 / AC8: a major NEVER applies, under any combination of settings', async () => {
      for (const auto of [true, false]) {
        for (const watchtower of [true, false]) {
          watchtowerCalls = 0;
          withWatchtower(watchtower);
          setUpdateChecksEnabled({ enabled: true, userId: adminId });
          setAutoApply(auto);
          stubRelease(`v${Number(APP_VERSION.split('.')[0]) + 1}.0.0`);
          const result = await runUpdateCheck({ now: new Date() });
          expect(result.severity, `auto=${auto} watchtower=${watchtower}`).toBe('major');
          expect(result.applied).toBe(false);
          expect(watchtowerCalls).toBe(0);
        }
      }
    });

    it('AC8: over 200 generated pairs, classify major implies zero Watchtower requests', () => {
      const current = parseSemver(APP_VERSION)!;
      let majors = 0;
      for (let i = 0; i < 200; i += 1) {
        const remote = {
          major: current.major + (i % 3),
          minor: (i * 7) % 12,
          patch: (i * 13) % 20,
        };
        if (classify(current, remote) === 'major') {
          majors += 1;
          expect(remote.major).toBeGreaterThan(current.major);
        }
      }
      expect(majors).toBeGreaterThan(0);
    });
  });

  describe('MUST-5.5 / MUST-5.9: the stamp and the dismissal', () => {
    it('writes last_checked_at on a FAILED check', async () => {
      globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
      const at = new Date('2026-08-18T12:00:00.000Z');
      const result = await runUpdateCheck({ now: at });
      expect(result.error).toContain('500');
      expect(readUpdateState().lastCheckedAt).toBe(at.toISOString());
      expect(readUpdateState().lastCheckError).toContain('500');
    });

    it('a second check at the same version enqueues nothing new', async () => {
      withWatchtower(false);
      setAutoApply(false);
      const next = `v${APP_VERSION.split('.').slice(0, 2).join('.')}.${Number(APP_VERSION.split('.')[2]) + 1}`;
      stubRelease(next);
      await runUpdateCheck({ now: new Date('2026-08-18T12:00:00.000Z') });
      const first = outboxRows().length;
      await runUpdateCheck({ now: new Date('2026-08-19T12:00:00.000Z'), manual: true });
      expect(outboxRows().length).toBe(first);
      expect(outboxRows()[0]!.dedup_key).toBe(`update:${next.slice(1)}`);
    });
  });
  ```

- [ ] **Append to `tests/lib/notify/events.test.ts` (§19.2).** Update the two existing counts and add the new assertions.
  ```ts
  describe('MUST-6.1: the update_available registry entry', () => {
    it('brings the registry to nine and is admin-audience, default-on, tick-triggered', () => {
      expect(NOTIFICATION_EVENTS).toHaveLength(9);
      const entry = eventDef('update_available');
      expect(entry).toEqual({
        id: 'update_available',
        label: 'An update is available',
        blurb: 'A newer version of Budget Tracker is published and is waiting for your say-so.',
        audience: 'admin',
        trigger: 'tick',
        defaultEnabled: true,
      });
    });

    it('MUST-4.3: eventsFor(member) excludes it', () => {
      expect(eventsFor('member').some((e) => e.id === 'update_available')).toBe(false);
      expect(eventsFor('admin').some((e) => e.id === 'update_available')).toBe(true);
    });

    it('MUST-6.3: the dedup key is per version and only ever goes up', () => {
      expect(updateAvailableKey('1.4.0')).toBe('update:1.4.0');
      expect(updateAvailableKey('1.4.0')).not.toBe(updateAvailableKey('1.5.0'));
    });
  });
  ```
  The file's existing `expect(NOTIFICATION_EVENTS).toHaveLength(8)`, `expect(eventsFor('member')).toHaveLength(6)` and `expect(eventsFor('admin')).toHaveLength(8)` become **9 / 6 / 9** — the member count is unchanged, which is itself the audience filter working.

- [ ] **Append to `tests/lib/notify/render.test.ts` (§19.2).**
  ```ts
  describe('MUST-6.4 / MUST-6.5: update_available renders three bodies and no URL', () => {
    const base = { event: 'update_available' as const, currentVersion: '1.3.1', latestVersion: '1.4.0', publishedAt: null };

    it('major', () => {
      const { subject, body } = renderEvent({ ...base, severity: 'major', canApplyInApp: true });
      expect(subject).toBe('Budget Tracker 1.4.0 is available (major update)');
      expect(body).toBe(
        'You are running 1.3.1. Version 1.4.0 is a major update, so this app will not install it on its own. ' +
          'Open Settings, read what changed, and press Review and update when you are ready.',
      );
    });

    it('patch with an apply path', () => {
      const { subject, body } = renderEvent({ ...base, severity: 'patch', canApplyInApp: true });
      expect(subject).toBe('Budget Tracker 1.4.0 is available');
      expect(body).toBe(
        'You are running 1.3.1. Version 1.4.0 is published. Automatic updates are switched off, so open Settings ' +
          'and press Update now when you want it.',
      );
    });

    it('minor with no apply path', () => {
      const { body } = renderEvent({ ...base, severity: 'minor', canApplyInApp: false });
      expect(body).toContain('This install cannot update itself');
    });

    it('renders publishedAt with the app\'s one timestamp convention and carries no URL', () => {
      const { body } = renderEvent({ ...base, severity: 'patch', canApplyInApp: true, publishedAt: '2026-08-16T09:00:00Z' });
      expect(body).toContain('Published 2026-08-16 09:00.');
      expect(body).not.toMatch(/https?:/);
    });
  });
  ```

- [ ] **Append to `tests/lib/scheduler.test.ts` (§19.2).** **Do not touch the existing dormancy assertion — MUST-5.3 requires it to stay literally unamended.**
  ```ts
  describe('MUST-5.1 … MUST-5.4: the update tick', () => {
    it('AC4: with checks disabled, a boot plus twelve ticks perform ZERO fetches', () => {
      const spy = vi.fn(async () => new Response('', { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = spy as unknown as typeof fetch;
      try {
        startScheduler();
        for (let i = 0; i < 12; i += 1) runUpdateTick(new Date(Date.now() + i * 5 * 60_000));
        expect(spy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('respects the 24-hour interval: nothing at 23 hours, a check at 25', async () => {
      const userId = insertTestUser(current!.db, { username: 'sched-admin', role: 'admin' });
      setUpdateChecksEnabled({ enabled: true, userId });
      recordCheckOutcome({ at: new Date('2026-08-18T00:00:00.000Z'), latestVersion: null });
      const spy = vi.fn(async () => new Response(JSON.stringify({ tag_name: `v${APP_VERSION}` }), { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = spy as unknown as typeof fetch;
      try {
        runUpdateTick(new Date('2026-08-18T23:00:00.000Z'));
        expect(spy).not.toHaveBeenCalled();
        runUpdateTick(new Date('2026-08-19T01:00:00.000Z'));
        await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('MUST-5.2: the cron callback and the boot path call it BEFORE runNotifyTick', () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
      expect(source).toMatch(/runUpdateTick\(\);\s*\n\s*runNotifyTick\(\);/);
      // Two occurrences: the cron callback and the boot call.
      expect(source.match(/runUpdateTick\(\);/g)).toHaveLength(2);
    });

    it('MUST-5.3: notify\'s dormancy bail is still the first statement after its single-flight guard', () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
      expect(source).toContain('if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;');
    });

    it('MUST-5.4: stopScheduler resets the update single-flight guard', () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
      expect(source).toMatch(/bootExpiryDone = false;[\s\S]{0,200}updateTicking = false;/);
    });

    it('a throwing runUpdateCheck does not prevent runNotifyTick from running', () => {
      const userId = insertTestUser(current!.db, { username: 'sched-admin2', role: 'admin' });
      setUpdateChecksEnabled({ enabled: true, userId });
      const realFetch = globalThis.fetch;
      globalThis.fetch = (() => {
        throw new Error('network down');
      }) as unknown as typeof fetch;
      try {
        expect(() => {
          runUpdateTick(new Date());
          runNotifyTick(new Date());
        }).not.toThrow();
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
  ```
  Add `runUpdateTick` to the file's existing `@/lib/scheduler` import, plus `import { recordCheckOutcome, setUpdateChecksEnabled } from '@/lib/update/state';` and `import { APP_VERSION } from '@/lib/version';`.

- [ ] **Append to `tests/ops/restore-seams.test.ts` (§19.2).** Use the file's existing `read` binding.
  ```ts
  describe('MUST-7.6 / MUST-7.7: the update reconciler sits between getDb and startScheduler', () => {
    const source = read('src/instrumentation-node.ts');

    it('calls reconcileApplyOnBoot() after raiseRestoreOutcome() and before startScheduler()', () => {
      const raiseAt = source.indexOf('raiseRestoreOutcome()');
      const reconcileAt = source.indexOf('reconcileApplyOnBoot()');
      const schedulerAt = source.indexOf('startScheduler()');
      expect(reconcileAt).toBeGreaterThan(raiseAt);
      expect(schedulerAt).toBeGreaterThan(reconcileAt);
      expect(source.lastIndexOf('getDb();')).toBeLessThan(reconcileAt);
    });

    it('wraps it so a reconciliation failure cannot stop the boot', () => {
      expect(source).toMatch(/try\s*\{\s*reconcileApplyOnBoot\(\);\s*\}\s*catch/);
    });

    it('leaves applyStagedRestoreOnBoot() as the first statement (warranty §20 untouched)', () => {
      expect(source.indexOf('applyStagedRestoreOnBoot()')).toBeLessThan(source.indexOf('getDb();'));
    });
  });
  ```

- [ ] **Append the 400-day regeneration case to `tests/lib/notify/dedup.test.ts` (§19.2, MUST-6.3), asserted as SPECIFIED BEHAVIOUR rather than as a bug.**
  ```ts
  describe('MUST-6.3: update:<version> and the one condition under which it regenerates', () => {
    it('fires once per version, and again only after the 400-day sweep removes the row', () => {
      const key = updateAvailableKey('1.4.0');
      const userId = insertTestUser(t.db, { username: 'dedup-admin', role: 'admin' });
      saveEmailTarget({ userId, destination: 'a@b.com', enabled: true });
      const first = enqueue({ userId, eventId: 'update_available', dedupKey: key, subject: 's', body: 'b', at: new Date('2026-08-18T00:00:00Z') });
      expect(first.inserted.length).toBeGreaterThan(0);
      const second = enqueue({ userId, eventId: 'update_available', dedupKey: key, subject: 's', body: 'b', at: new Date('2026-08-19T00:00:00Z') });
      expect(second.inserted).toEqual([]);
      // A newer version is a new key and enqueues again.
      const newer = enqueue({ userId, eventId: 'update_available', dedupKey: updateAvailableKey('1.5.0'), subject: 's', body: 'b', at: new Date('2026-08-20T00:00:00Z') });
      expect(newer.inserted.length).toBeGreaterThan(0);
      // ...and after the retention sweep removes the 1.4.0 row, one more reminder is CORRECT.
      t.sqlite.prepare(`delete from notification_outbox where dedup_key = ?`).run(key);
      const afterPrune = enqueue({ userId, eventId: 'update_available', dedupKey: key, subject: 's', body: 'b', at: new Date('2027-10-01T00:00:00Z') });
      expect(afterPrune.inserted.length).toBeGreaterThan(0);
    });
  });
  ```

- [ ] **Run every touched test file and the type-check.**
  ```powershell
  npx vitest run tests/lib/update/check.test.ts tests/lib/notify/events.test.ts tests/lib/notify/render.test.ts tests/lib/notify/dedup.test.ts tests/lib/scheduler.test.ts tests/ops/restore-seams.test.ts
  npx tsc --noEmit
  ```
  Expected: green. **If `renderEvent` reports TS2366, the `case` is missing — that is MUST-6.6's safety net doing its job, not a spurious error.**

- [ ] **Commit.**
  ```powershell
  git add src/lib/update/check.ts src/lib/notify/events.ts src/lib/notify/render.ts src/lib/scheduler.ts src/instrumentation-node.ts tests
  git commit -m "feat(update): the check orchestrator, the update_available event and the tick

runUpdateCheck is the ONE code path both the tick and the Check-now button take,
so a manual check and an automatic one can never classify the same version pair
differently (MUST-10.5). The major guard is unconditional and sits BEFORE the
apply branch, not inside it (MUST-5.8). last_checked_at is written on every
attempt including failures, so a crash loop cannot become a retry storm
(MUST-5.5).

update_available discharges notify MUST-4.4 in full: one registry entry, one
render case, one enqueue call - no migration, no schema change, no UI edit
(MUST-6.2). runUpdateTick is a separate function with its own gate, so notify's
dormancy bail is untouched and each feature's zero-egress claim stands alone
(MUST-5.3). reconcileApplyOnBoot is wired between getDb() and startScheduler(),
guarded, with warranty section 20's boot ordering unchanged (MUST-7.6/7.7)."
  ```

<!-- END TASK 6 -->

---

## Task 7: `src/lib/update/ratelimit.ts` and the six server actions

**Context:** Spec §10 in full. Implements **MUST-10.1 … MUST-10.11** and §19.3's `update-actions.test.ts`. Six actions on the existing `src/app/(app)/settings/actions.ts`; three in-memory **global** buckets, which is the opposite of the notify test-send bucket and is deliberate.

**Files:**
- Create: `src/lib/update/ratelimit.ts`
- Modify: `src/app/(app)/settings/actions.ts` (six new actions and their imports)
- Test: `tests/lib/update/ratelimit.test.ts` (**new**), `tests/app/update-actions.test.ts` (**new**)

**Interfaces:**
- Consumes: `isSameOrigin` from `@/lib/auth/csrf`; `requireAdmin` from `@/lib/auth/session`; the file's existing module-local `CROSS_ORIGIN_ERROR`; `runUpdateCheck`, `applyUpdate` from `@/lib/update/check`; `readUpdateState`, `setAutoApply`, `setUpdateChecksEnabled`, `dismissVersion` from `@/lib/update/state`; `fetchRemoteChangelog`, `boundRelease`, `parseChangelog` from `@/lib/update/github`; `watchtowerConfig` from `@/lib/update/watchtower`; `type ChangelogRelease` from `@/lib/changelog`.
- Produces:
  ```ts
  // src/lib/update/ratelimit.ts
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

  // src/app/(app)/settings/actions.ts
  export interface UpdateActionState { error?: string; message?: string }
  export interface ReviewUpdateState { error?: string; release?: ChangelogRelease; version?: string }
  export async function enableUpdateChecksAction(): Promise<UpdateActionState>;
  export async function disableUpdateChecksAction(): Promise<UpdateActionState>;
  export async function setAutoApplyAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState>;
  export async function checkForUpdateNowAction(): Promise<UpdateActionState>;
  export async function reviewUpdateAction(formData: FormData): Promise<ReviewUpdateState>;
  export async function applyUpdateAction(formData: FormData): Promise<UpdateActionState>;
  export async function dismissUpdateAction(formData: FormData): Promise<UpdateActionState>;
  ```
  **Note:** the spec's MUST-10.1 lists six actions but §9.3 item 6 also requires a **Not now** control writing `update.dismissed_version`, and MUST-3.2 names "the dismiss action" as that key's writer. `dismissUpdateAction` is therefore the seventh export; it takes the same `isSameOrigin` → `requireAdmin` → zod order, mutates one settings key, causes **no** egress, and carries no rate limit. This is the one place the plan adds an export the spec's own count omits, and it is recorded here rather than smuggled in.

### Steps

- [ ] **Write `src/lib/update/ratelimit.ts`, modelled directly on `src/lib/notify/ratelimit.ts` — same `RateVerdict` shape, same prune-then-verdict structure, same clock seam.**
  ```ts
  /**
   * MUST-10.7: in-memory token buckets for the three user-triggered update actions.
   *
   * MUST-10.8: these are GLOBAL, not per-user, which is the opposite of the notify test-send
   * bucket and is deliberate. There is one GitHub quota per source IP and one install to
   * update, so the shared resource is the install itself: two admins pressing Check now are
   * contending for the same thing.
   *
   * MUST-10.10: APPLY_MAX = 3 per hour is not a security boundary — an admin can already
   * restart the container — it bounds a stuck form and a double-click storm against a
   * container that is mid-replacement.
   */
  export const CHECK_NOW_WINDOW_MS = 10 * 60_000;
  export const CHECK_NOW_MAX = 5;
  export const REVIEW_WINDOW_MS = 10 * 60_000;
  export const REVIEW_MAX = 10;
  export const APPLY_WINDOW_MS = 60 * 60_000;
  export const APPLY_MAX = 3;

  export interface RateVerdict {
    allowed: boolean;
    retryAfterMinutes: number;
  }

  /** The seam, so all three windows are testable without real waiting. */
  let clock: () => number = () => Date.now();

  export function setUpdateRateLimitClockForTests(next: (() => number) | null): void {
    clock = next ?? (() => Date.now());
  }

  const checkNowStamps: number[] = [];
  const reviewStamps: number[] = [];
  const applyStamps: number[] = [];

  export function resetUpdateRateLimitsForTests(): void {
    checkNowStamps.length = 0;
    reviewStamps.length = 0;
    applyStamps.length = 0;
  }

  function prune(stamps: number[], now: number, windowMs: number): void {
    while (stamps.length > 0 && (stamps[0] as number) <= now - windowMs) stamps.shift();
  }

  function verdict(stamps: number[], now: number, windowMs: number): RateVerdict {
    const oldest = stamps[0] ?? now;
    const waitMs = Math.max(0, oldest + windowMs - now);
    return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
  }

  /**
   * MUST-10.9: a token is consumed only once the caller has passed every configuration guard,
   * so pressing Update now on an install with no Watchtower cannot burn apply quota while
   * doing nothing. The ordering is the caller's responsibility and every call site below
   * carries a comment saying so — this is the same discipline notify's runTest establishes.
   */
  function take(stamps: number[], now: number, windowMs: number, max: number): RateVerdict {
    prune(stamps, now, windowMs);
    if (stamps.length >= max) return verdict(stamps, now, windowMs);
    stamps.push(now);
    return { allowed: true, retryAfterMinutes: 0 };
  }

  export function checkUpdateCheckNow(now: number = clock()): RateVerdict {
    return take(checkNowStamps, now, CHECK_NOW_WINDOW_MS, CHECK_NOW_MAX);
  }

  export function checkUpdateReview(now: number = clock()): RateVerdict {
    return take(reviewStamps, now, REVIEW_WINDOW_MS, REVIEW_MAX);
  }

  export function checkUpdateApply(now: number = clock()): RateVerdict {
    return take(applyStamps, now, APPLY_WINDOW_MS, APPLY_MAX);
  }
  ```

- [ ] **Write `tests/lib/update/ratelimit.test.ts` (§19.1).**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import {
    APPLY_MAX,
    APPLY_WINDOW_MS,
    CHECK_NOW_MAX,
    CHECK_NOW_WINDOW_MS,
    REVIEW_MAX,
    checkUpdateApply,
    checkUpdateCheckNow,
    checkUpdateReview,
    resetUpdateRateLimitsForTests,
    setUpdateRateLimitClockForTests,
  } from '@/lib/update/ratelimit';

  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    setUpdateRateLimitClockForTests(() => now);
    resetUpdateRateLimitsForTests();
  });
  afterEach(() => {
    setUpdateRateLimitClockForTests(null);
    resetUpdateRateLimitsForTests();
  });

  describe('MUST-10.7 / MUST-10.8: three global buckets', () => {
    it('refuses the sixth Check now in a window and recovers after it', () => {
      for (let i = 0; i < CHECK_NOW_MAX; i += 1) expect(checkUpdateCheckNow().allowed).toBe(true);
      const refused = checkUpdateCheckNow();
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterMinutes).toBeGreaterThan(0);
      now += CHECK_NOW_WINDOW_MS + 1;
      expect(checkUpdateCheckNow().allowed).toBe(true);
    });

    it('refuses the fourth Apply in an hour and recovers after it', () => {
      for (let i = 0; i < APPLY_MAX; i += 1) expect(checkUpdateApply().allowed).toBe(true);
      expect(checkUpdateApply().allowed).toBe(false);
      now += APPLY_WINDOW_MS + 1;
      expect(checkUpdateApply().allowed).toBe(true);
    });

    it('the three buckets are independent', () => {
      for (let i = 0; i < CHECK_NOW_MAX; i += 1) checkUpdateCheckNow();
      expect(checkUpdateCheckNow().allowed).toBe(false);
      expect(checkUpdateReview().allowed).toBe(true);
      expect(checkUpdateApply().allowed).toBe(true);
      expect(REVIEW_MAX).toBeGreaterThan(CHECK_NOW_MAX);
    });
  });
  ```

- [ ] **Add the six-plus-one actions to `src/app/(app)/settings/actions.ts`.** Reuse the file's existing module-local `CROSS_ORIGIN_ERROR` and its `headers` / `revalidatePath` / `z` imports; add the domain imports at the top.
  ```ts
  import { requireAdmin } from '@/lib/auth/session';
  import { parseChangelog } from '@/lib/changelog';
  import type { ChangelogRelease } from '@/lib/changelog';
  import { applyUpdate, runUpdateCheck } from '@/lib/update/check';
  import { boundRelease, fetchRemoteChangelog } from '@/lib/update/github';
  import { checkUpdateApply, checkUpdateCheckNow, checkUpdateReview } from '@/lib/update/ratelimit';
  import { dismissVersion, readUpdateState, setAutoApply, setUpdateChecksEnabled } from '@/lib/update/state';
  import { watchtowerConfig } from '@/lib/update/watchtower';
  ```
  ```ts
  export interface UpdateActionState {
    error?: string;
    message?: string;
  }

  export interface ReviewUpdateState {
    error?: string;
    release?: ChangelogRelease;
    version?: string;
  }

  const UPDATE_PATH = '/settings';
  const STALE_VERSION_ERROR = 'That version is no longer the one on offer. Press Check now and read the notes again.';
  const NO_UPDATE_ERROR = 'There is no update on offer right now.';

  /**
   * MUST-10.3 (the ownership rule): no update action accepts a userId. The only parameters any
   * of them take are `enabled` (a checkbox) and `version` (a semver string), and the version is
   * re-checked against the server's own state before anything acts on it (MUST-9.7).
   */
  const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'That is not a version this app can act on.');

  /**
   * MUST-10.2: origin FIRST, before auth, before validation, before any read — exactly the
   * shape settings/notifications/actions.ts's guard() uses.
   */
  async function updateGuard(): Promise<UpdateActionState | null> {
    if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
    return null;
  }

  export async function enableUpdateChecksAction(): Promise<UpdateActionState> {
    const blocked = await updateGuard();
    if (blocked) return blocked;
    const user = await requireAdmin();
    // MUST-10.3: the caller's id comes from the session, never from a field.
    setUpdateChecksEnabled({ enabled: true, userId: user.id });
    revalidatePath(UPDATE_PATH);
    return { message: 'Update checks are on. This app will ask GitHub once a day whether a newer version is published.' };
  }

  export async function disableUpdateChecksAction(): Promise<UpdateActionState> {
    const blocked = await updateGuard();
    if (blocked) return blocked;
    const user = await requireAdmin();
    // MUST-3.4: this wipes every update. key but the flag. Off means off.
    setUpdateChecksEnabled({ enabled: false, userId: user.id });
    revalidatePath(UPDATE_PATH);
    return { message: 'Update checks are off. Nothing about updates leaves this machine now.' };
  }

  export async function setAutoApplyAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
    const blocked = await updateGuard();
    if (blocked) return blocked;
    await requireAdmin();
    if (!readUpdateState().enabled) return { error: 'Turn update checks on first.' };
    // An HTML checkbox posts 'on' when ticked and nothing at all when not.
    setAutoApply(formData.get('autoApply') !== null);
    revalidatePath(UPDATE_PATH);
    return { message: 'Saved.' };
  }

  export async function checkForUpdateNowAction(): Promise<UpdateActionState> {
    const blocked = await updateGuard();
    if (blocked) return blocked;
    await requireAdmin();
    if (!readUpdateState().enabled) return { error: 'Turn update checks on first.' };

    // MUST-10.9: quota is spent only once every configuration guard has passed.
    const verdict = checkUpdateCheckNow();
    if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

    // MUST-5.6 / MUST-10.5 / MUST-10.6: a manual check ignores the daily interval but still
    // refreshes the stamp, and still applies a small update when auto-apply is on. Pressing
    // Check now on an install configured to install small updates automatically installs the
    // small update; anything else would be a surprising second policy.
    const result = await runUpdateCheck({ now: new Date(), manual: true });
    revalidatePath(UPDATE_PATH);
    if (result.error !== null) return { error: result.error };
    if (result.applied) return { message: `Version ${result.latestVersion} is being installed now.` };
    if (result.latestVersion === null) return { message: 'You are on the newest published version.' };
    return { message: `Version ${result.latestVersion} is available.` };
  }

  /**
   * MUST-10.2: this action mutates nothing and does not revalidate — but it takes the STRICT
   * isSameOrigin(), not the relaxed isSameOriginOrHeaderless(), because it causes outbound
   * egress on the server. Same reasoning notify MUST-12.8 gives for detectTelegramChatIdAction.
   */
  export async function reviewUpdateAction(formData: FormData): Promise<ReviewUpdateState> {
    if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
    await requireAdmin();

    const parsed = versionSchema.safeParse(String(formData.get('version') ?? ''));
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
    const state = readUpdateState();
    if (state.latestVersion === null) return { error: NO_UPDATE_ERROR };
    if (state.latestVersion !== parsed.data) return { error: STALE_VERSION_ERROR };

    const verdict = checkUpdateReview();
    if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

    try {
      const markdown = await fetchRemoteChangelog(parsed.data);
      const release = parseChangelog(markdown).find((entry) => entry.heading.startsWith(`[${parsed.data}]`));
      // MUST-9.6: a failed or missing changelog must not become a wall that stops an admin
      // updating — the panel renders its fallback sentence and still offers the confirm button.
      if (release === undefined) return { version: parsed.data };
      return { version: parsed.data, release: boundRelease(release) };
    } catch {
      return { version: parsed.data };
    }
  }

  export async function applyUpdateAction(formData: FormData): Promise<UpdateActionState> {
    const blocked = await updateGuard();
    if (blocked) return blocked;
    await requireAdmin();

    const parsed = versionSchema.safeParse(String(formData.get('version') ?? ''));
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

    const state = readUpdateState();
    if (!state.enabled) return { error: 'Turn update checks on first.' };
    if (state.latestVersion === null) return { error: NO_UPDATE_ERROR };
    // MUST-9.7: the version travels in the form so a stale tab cannot install a version its
    // reader never saw — and it is checked against the server's own state, never trusted.
    if (state.latestVersion !== parsed.data) return { error: STALE_VERSION_ERROR };
    // MUST-10.9: no Watchtower means no apply path, and burning apply quota while doing
    // nothing would be the wrong order.
    if (watchtowerConfig() === null) return { error: 'This install has no Watchtower companion to ask.' };

    const verdict = checkUpdateApply();
    if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

    try {
      const outcome = await applyUpdate({ version: parsed.data, now: new Date() });
      revalidatePath(UPDATE_PATH);
      // MUST-9.8: two of the three fixed sentences. The third is the scrubbed error below.
      return {
        message:
          outcome === 'accepted'
            ? `Update requested. Watchtower is pulling ${parsed.data} and will restart this app in a moment. Reload this page in a minute or two.`
            : `Update requested. This app is being replaced right now, so it could not wait for a reply. Reload this page in a minute or two — the version at the bottom of this card will tell you whether it worked.`,
      };
    } catch (error) {
      revalidatePath(UPDATE_PATH);
      // MUST-7.3 / MUST-10.11: applyUpdate already scrubbed this with the token in the secret
      // list before it was written to update.last_apply_error; it is returned as-is.
      return { error: error instanceof Error ? error.message : 'The update could not be requested.' };
    }
  }

  /** §9.3 item 6 / MUST-5.9. Suppresses only the card's prominence — never the check, never the dedup. */
  export async function dismissUpdateAction(formData: FormData): Promise<UpdateActionState> {
    const blocked = await updateGuard();
    if (blocked) return blocked;
    await requireAdmin();
    const raw = String(formData.get('version') ?? '');
    if (raw.length === 0) {
      dismissVersion('');
      revalidatePath(UPDATE_PATH);
      return { message: 'Showing this again.' };
    }
    const parsed = versionSchema.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
    dismissVersion(parsed.data);
    revalidatePath(UPDATE_PATH);
    return { message: `Skipping ${parsed.data} for now. You will still be told when a newer version is published.` };
  }
  ```

- [ ] **Write `tests/app/update-actions.test.ts` (§19.3).** Mock `next/headers`, `next/cache` and `@/lib/auth/session` the way `tests/app/notifications-actions.test.ts` already does, then:
  ```ts
  describe('MUST-10.2 / MUST-10.4: origin and role, in that order', () => {
    it('all seven actions reject a cross-origin request BEFORE anything else', async () => {
      sameOrigin.value = false;
      const results = [
        await actions.enableUpdateChecksAction(),
        await actions.disableUpdateChecksAction(),
        await actions.setAutoApplyAction({}, form({ autoApply: 'on' })),
        await actions.checkForUpdateNowAction(),
        await actions.reviewUpdateAction(form({ version: '1.4.0' })),
        await actions.applyUpdateAction(form({ version: '1.4.0' })),
        await actions.dismissUpdateAction(form({ version: '1.4.0' })),
      ];
      for (const result of results) expect(result.error).toBe('Cross-origin request rejected');
      expect(fetchCalls).toHaveLength(0);
      expect(requireAdminCalls).toBe(0);
    });

    it('every action goes through requireAdmin, so a member never reaches the domain call', async () => {
      currentUser.value.role = 'member';
      await expect(actions.enableUpdateChecksAction()).rejects.toThrow(/redirect/);
      await expect(actions.applyUpdateAction(form({ version: '1.4.0' }))).rejects.toThrow(/redirect/);
    });

    it('MUST-10.3: no action accepts a userId', async () => {
      const other = insertTestUser(t.db, { username: 'other', role: 'admin' });
      await actions.enableUpdateChecksAction();
      expect(readUpdateState().enabledBy).toBe(currentUser.value.id);
      expect(readUpdateState().enabledBy).not.toBe(other);
      // The forged field is simply never read.
      await actions.dismissUpdateAction(form({ version: '1.4.0', userId: String(other) }));
      expect(readUpdateState().dismissedVersion).toBe('1.4.0');
    });
  });

  describe('MUST-9.7: a stale version is refused against the server\'s own state', () => {
    it('applyUpdateAction refuses a version that is not update.latest_version', async () => {
      await actions.enableUpdateChecksAction();
      recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
      const result = await actions.applyUpdateAction(form({ version: '1.3.9' }));
      expect(result.error).toBe('That version is no longer the one on offer. Press Check now and read the notes again.');
      expect(fetchCalls).toHaveLength(0);
    });
  });

  describe('MUST-10.9 / MUST-10.10: a rate-limited action performs no egress', () => {
    it('the sixth Check now returns the wait message and fetches nothing', async () => {
      await actions.enableUpdateChecksAction();
      stubRelease(`v${APP_VERSION}`);
      for (let i = 0; i < CHECK_NOW_MAX; i += 1) await actions.checkForUpdateNowAction();
      const before = fetchCalls.length;
      const refused = await actions.checkForUpdateNowAction();
      expect(refused.error).toMatch(/^Too many attempts\. Try again in \d+ minutes\.$/);
      expect(fetchCalls.length).toBe(before);
    });

    it('Update now with no Watchtower burns no apply quota', async () => {
      delete process.env.WATCHTOWER_URL;
      await actions.enableUpdateChecksAction();
      recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
      for (let i = 0; i < APPLY_MAX + 2; i += 1) {
        const result = await actions.applyUpdateAction(form({ version: '1.4.0' }));
        expect(result.error).toBe('This install has no Watchtower companion to ask.');
      }
      // The bucket is untouched, so a properly configured install still has all three.
      expect(checkUpdateApply().allowed).toBe(true);
    });
  });

  describe('MUST-7.3 / AC7: no returned state contains a token substring', () => {
    it('a 401 from Watchtower returns the fixed sentence and nothing of the token', async () => {
      process.env.WATCHTOWER_URL = 'http://watchtower:8080/v1/update';
      process.env.WATCHTOWER_TOKEN = 'super-secret-token-value';
      await actions.enableUpdateChecksAction();
      recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
      stubWatchtower(401);
      const result = await actions.applyUpdateAction(form({ version: '1.4.0' }));
      expect(result.error).toBe(
        'Watchtower rejected the token. Check that WATCHTOWER_TOKEN matches WATCHTOWER_HTTP_API_TOKEN in your compose file.',
      );
      expect(JSON.stringify(result)).not.toContain('super-secret-token-value');
      expect(readUpdateState().lastApplyError).not.toContain('super-secret-token-value');
    });
  });

  describe('MUST-3.4: disable leaves exactly one update. settings row', () => {
    it('wipes the cache, the error and the dismissal', async () => {
      await actions.enableUpdateChecksAction();
      recordCheckOutcome({ at: new Date(), latestVersion: '1.4.0' });
      await actions.dismissUpdateAction(form({ version: '1.4.0' }));
      await actions.disableUpdateChecksAction();
      const rows = t.sqlite.prepare(`select key, value from settings where key like 'update.%'`).all();
      expect(rows).toEqual([{ key: 'update.checks_enabled', value: '0' }]);
    });
  });
  ```

- [ ] **Run the two test files and the type-check.**
  ```powershell
  npx vitest run tests/lib/update/ratelimit.test.ts tests/app/update-actions.test.ts tests/app/settings-actions.test.ts
  npx tsc --noEmit
  ```
  Expected: green. **`next build` fails on any non-async export from a `'use server'` file** — `UpdateActionState` and `ReviewUpdateState` are `interface` declarations (erased at build time) and `UPDATE_PATH` / `versionSchema` / `updateGuard` are module-local and unexported, so nothing here trips that rule. Do not export a constant from this file.

- [ ] **Commit.**
  ```powershell
  git add src/lib/update/ratelimit.ts "src/app/(app)/settings/actions.ts" tests/lib/update/ratelimit.test.ts tests/app/update-actions.test.ts
  git commit -m "feat(update): three global rate-limit buckets and the settings actions

isSameOrigin first in every action, before auth, before validation, before any
read (MUST-10.2); requireAdmin second; no action accepts a userId (MUST-10.3).
reviewUpdateAction takes the strict origin check rather than the relaxed one
because it causes outbound egress, the same reasoning notify gives for
detectTelegramChatId. applyUpdateAction re-checks the submitted version against
the server's own state, so a stale tab cannot install a version its reader never
saw (MUST-9.7). The buckets are GLOBAL, not per-user, because the contended
resource is the install (MUST-10.8), and a token is spent only after every
configuration guard has passed, so Update now with no Watchtower burns no quota
(MUST-10.9)."
  ```

<!-- END TASK 7 -->

---

## Task 8: The Updates card — Settings → About

**Context:** Spec §9 in full and §7.4's fallback copy. Implements **MUST-7.8**, **MUST-7.9**, **MUST-9.1 … MUST-9.9**, and §19.3's `updates-card.test.tsx`. Existing primitives and design tokens only — **no new CSS, no new design token, no new colour.** The copy in this task is **shipped verbatim**: it is content, not placeholder text.

**Files:**
- Create: `src/app/(app)/settings/updates-card.tsx` (server component)
- Create: `src/app/(app)/settings/updates-client.tsx` (client component)
- Modify: `src/app/(app)/settings/page.tsx` (render it, admin only, immediately before `<AboutPanel />`)
- Modify: `src/components/icons.tsx` (`UpdateIcon`)
- Test: `tests/app/updates-card.test.tsx` (**new**)

**Interfaces:**
- Consumes: `readUpdateState` from `@/lib/update/state`; `watchtowerConfig`, `watchtowerConfigError` from `@/lib/update/watchtower`; `classify`, `parseSemver`, `type UpdateSeverity` from `@/lib/update/semver` (a **pure** module, so the client may import it — MUST-2.1); `APP_VERSION` from `@/lib/version`; `Card`/`CardBody`/`CardHeader`, `Notice`, `SubmitButton`, `FormError`; the seven actions from `./actions`; `type ChangelogRelease` from `@/lib/changelog` (**`import type` only**).
- Produces:
  ```ts
  // src/app/(app)/settings/updates-card.tsx
  export function UpdatesCard(): Promise<React.ReactElement>;   // async server component

  // src/app/(app)/settings/updates-client.tsx
  export interface UpdatesViewProps {
    currentVersion: string;
    enabled: boolean;
    autoApply: boolean;
    lastCheckedAt: string | null;
    lastCheckError: string | null;
    latestVersion: string | null;
    latestPublishedAt: string | null;
    dismissedVersion: string | null;
    lastAppliedAt: string | null;
    lastApplyError: string | null;
    severity: UpdateSeverity;
    /** MUST-7.3: the card receives this boolean and NOTHING else about Watchtower. */
    canApplyInApp: boolean;
    watchtowerError: string | null;
  }
  export function UpdatesClient(props: UpdatesViewProps): React.ReactElement;
  ```

### Steps

- [ ] **Add `UpdateIcon` to `src/components/icons.tsx`, under the `/* ---- Chrome ---- */` section, routed through the shared `Glyph`.**
  ```tsx
  export function UpdateIcon(props: IconProps) {
    return (
      <Glyph {...props}>
        <path d="M12 4.5a7.5 7.5 0 1 0 7.1 5.1" />
        <path d="M19.5 4.5v5h-5" />
      </Glyph>
    );
  }
  ```

- [ ] **Write `src/app/(app)/settings/updates-card.tsx` (MUST-9.1).**
  ```tsx
  import { classify, parseSemver, type UpdateSeverity } from '@/lib/update/semver';
  import { readUpdateState } from '@/lib/update/state';
  import { watchtowerConfig, watchtowerConfigError } from '@/lib/update/watchtower';
  import { APP_VERSION } from '@/lib/version';
  import { UpdatesClient } from './updates-client';

  /**
   * MUST-9.1: rendered from settings/page.tsx immediately before <AboutPanel />, and ONLY for
   * user.role === 'admin'. A member's Settings page is byte-identical to v1.3.0's.
   *
   * MUST-9.2: this is NOT added to ADMIN_LINKS. It is a card with controls, not a link to
   * another page, for the same reason the Sessions card is.
   *
   * MUST-7.3: the client half receives `canApplyInApp: boolean` and nothing more. No page
   * prop carries WATCHTOWER_TOKEN, or WATCHTOWER_URL, or any fragment of either.
   */
  export function UpdatesCard() {
    const state = readUpdateState();

    const current = parseSemver(APP_VERSION);
    const remote = state.latestVersion === null ? null : parseSemver(state.latestVersion);
    const severity: UpdateSeverity = current !== null && remote !== null ? classify(current, remote) : 'none';

    return (
      <UpdatesClient
        currentVersion={APP_VERSION}
        enabled={state.enabled}
        autoApply={state.autoApply}
        lastCheckedAt={state.lastCheckedAt}
        lastCheckError={state.lastCheckError}
        latestVersion={state.latestVersion}
        latestPublishedAt={state.latestPublishedAt}
        dismissedVersion={state.dismissedVersion}
        lastAppliedAt={state.lastAppliedAt}
        lastApplyError={state.lastApplyError}
        severity={severity}
        canApplyInApp={watchtowerConfig() !== null}
        watchtowerError={watchtowerConfigError()}
      />
    );
  }
  ```

- [ ] **Write `src/app/(app)/settings/updates-client.tsx` (MUST-9.3 … MUST-9.9). Every string below ships verbatim.**
  ```tsx
  'use client';

  import { useActionState, useState } from 'react';
  import { FormError } from '@/components/FormError';
  import { SubmitButton } from '@/components/SubmitButton';
  import { Card, CardBody, CardHeader } from '@/components/ui/Card';
  import { Notice } from '@/components/ui/Notice';
  import type { ChangelogRelease } from '@/lib/changelog';
  import type { UpdateSeverity } from '@/lib/update/semver';
  import {
    applyUpdateAction,
    checkForUpdateNowAction,
    disableUpdateChecksAction,
    dismissUpdateAction,
    enableUpdateChecksAction,
    reviewUpdateAction,
    setAutoApplyAction,
    type ReviewUpdateState,
    type UpdateActionState,
  } from './actions';

  export interface UpdatesViewProps {
    currentVersion: string;
    enabled: boolean;
    autoApply: boolean;
    lastCheckedAt: string | null;
    lastCheckError: string | null;
    latestVersion: string | null;
    latestPublishedAt: string | null;
    dismissedVersion: string | null;
    lastAppliedAt: string | null;
    lastApplyError: string | null;
    severity: UpdateSeverity;
    canApplyInApp: boolean;
    watchtowerError: string | null;
  }

  const initial: UpdateActionState = {};

  const SEVERITY_BADGE: Record<Exclude<UpdateSeverity, 'none'>, string> = {
    patch: 'Patch update',
    minor: 'Minor update',
    major: 'Major update',
  };

  /** notify §11.4's amendment, and the app's ONE timestamp convention. No relative strings. */
  function stamp(iso: string | null): string {
    return iso === null ? 'Never' : iso.slice(0, 16).replace('T', ' ');
  }

  /**
   * The SAME bold-run renderer AboutPanel uses on the local changelog — one renderer, two
   * sources, so remote and local notes cannot drift in appearance. It handles exactly this one
   * inline form and nothing else, and dangerouslySetInnerHTML appears nowhere (MUST-4.8).
   */
  function renderEmphasis(text: string): React.ReactNode {
    if (!text.includes('**')) return text;
    return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
      index % 2 === 1 ? (
        <strong key={index} className="font-semibold text-ink">
          {part}
        </strong>
      ) : (
        part
      ),
    );
  }

  export function UpdatesClient(props: UpdatesViewProps) {
    const [enableState, enable] = useActionState(async () => enableUpdateChecksAction(), initial);
    const [disableState, disable] = useActionState(async () => disableUpdateChecksAction(), initial);
    const [autoState, saveAuto] = useActionState(setAutoApplyAction, initial);
    const [checkState, checkNow] = useActionState(async () => checkForUpdateNowAction(), initial);
    const [applyState, apply] = useActionState(async (_prev: UpdateActionState, formData: FormData) => applyUpdateAction(formData), initial);
    const [dismissState, dismiss] = useActionState(async (_prev: UpdateActionState, formData: FormData) => dismissUpdateAction(formData), initial);
    const [review, runReview] = useActionState(async (_prev: ReviewUpdateState, formData: FormData) => reviewUpdateAction(formData), {} as ReviewUpdateState);
    const [panelOpen, setPanelOpen] = useState(false);

    const messages = [enableState, disableState, autoState, checkState, applyState, dismissState];
    const message = messages.map((s) => s.message).find((m) => m !== undefined);
    const error = messages.map((s) => s.error).find((e) => e !== undefined) ?? review.error;

    // MUST-9.3: the off state. One button, no other control.
    if (!props.enabled) {
      return (
        <Card>
          <CardHeader title="Updates" description={`Budget Tracker v${props.currentVersion} · update checks are off.`} />
          <CardBody className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              This app does not check for updates unless you ask it to. Switch this on and once a day it will ask GitHub
              whether a newer version of Budget Tracker has been published. That request carries the version you are
              running and nothing else — not your data, not your address, not how many people use this install.
            </p>
            <p className="text-sm text-muted">
              Small updates (bug fixes and new features) install themselves. A major version never does: you will be
              told, shown exactly what changed, and asked.
            </p>
            <FormError message={error} />
            <form action={enable}>
              <SubmitButton className="btn btn--primary">Enable update checks</SubmitButton>
            </form>
          </CardBody>
        </Card>
      );
    }

    const severity = props.severity;
    const offered = severity !== 'none' && props.latestVersion !== null ? props.latestVersion : null;
    const dismissed = offered !== null && props.dismissedVersion === offered;

    return (
      <Card>
        <CardHeader
          title="Updates"
          description={
            offered === null
              ? `Up to date (v${props.currentVersion})`
              : `Version ${offered} is available`
          }
          action={
            offered === null || severity === 'none' ? null : (
              <span className="badge badge--amber">{SEVERITY_BADGE[severity]}</span>
            )
          }
        />
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-subtle">
            Last checked {stamp(props.lastCheckedAt)}
            {props.latestPublishedAt === null ? null : ` · published ${stamp(props.latestPublishedAt)}`}
            {props.lastAppliedAt === null ? null : ` · last updated ${stamp(props.lastAppliedAt)}`}
          </p>

          {props.lastCheckError === null ? null : <Notice tone="error">{props.lastCheckError}</Notice>}
          {props.lastApplyError === null ? null : <Notice tone="error">{props.lastApplyError}</Notice>}
          {props.watchtowerError === null ? null : <Notice tone="error">{props.watchtowerError}</Notice>}
          <FormError message={error} />
          {message === undefined ? null : <Notice tone="success">{message}</Notice>}

          <div className="flex flex-wrap items-center gap-3">
            <form action={checkNow}>
              <SubmitButton className="btn btn--secondary">Check now</SubmitButton>
            </form>
            <form action={saveAuto} className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" name="autoApply" defaultChecked={props.autoApply} />
                Install small updates automatically
              </label>
              <SubmitButton className="btn btn--ghost btn--sm">Save</SubmitButton>
            </form>
            <form action={disable} className="ml-auto">
              <SubmitButton className="btn btn--ghost">Disable update checks</SubmitButton>
            </form>
          </div>

          {offered === null ? null : dismissed ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted">Version {offered} is available — you chose to skip it for now.</p>
              <form action={dismiss}>
                <input type="hidden" name="version" value="" />
                <SubmitButton className="btn btn--ghost btn--sm">Show again</SubmitButton>
              </form>
            </div>
          ) : !props.canApplyInApp ? (
            // MUST-7.8: the apply button is ABSENT, not disabled. A disabled button invites a
            // click and then explains itself, and there is nothing to explain away.
            // MUST-7.9: shipped verbatim. Every path and filename is plain text, never an
            // <a href> — it keeps the zero-egress claim trivially auditable and it survives a
            // screenshot.
            <Notice tone="info" title="This install updates by hand.">
              <p>
                There is no Watchtower companion for the app to ask, so it cannot replace itself. That is normal if you
                built from source or if you set this up before version 1.3.1.
              </p>
              <p>
                To move to the new version, run <code>./install/update.sh</code> on Linux, macOS, a Raspberry Pi, or
                Synology over SSH, or <code>.\install\update.ps1</code> on Windows. Both scripts tag a rollback point
                first and put it back automatically if the new version does not come up healthy.
              </p>
              <p>
                If you installed with the prebuilt image, you can switch to in-app updates instead by replacing your
                compose file with the current <code>install/synology-compose-pull.yml</code> — see INSTALL.md, "Moving
                to in-app updates".
              </p>
            </Notice>
          ) : severity === 'major' ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <form
                  action={(formData: FormData) => {
                    setPanelOpen(true);
                    return runReview(formData);
                  }}
                >
                  <input type="hidden" name="version" value={offered} />
                  <SubmitButton className="btn btn--primary">Review and update</SubmitButton>
                </form>
                <form action={dismiss}>
                  <input type="hidden" name="version" value={offered} />
                  <SubmitButton className="btn btn--ghost">Not now</SubmitButton>
                </form>
              </div>
              {!panelOpen ? null : (
                <div className="flex flex-col gap-3 rounded-md border border-line px-4 py-4">
                  <h3 className="text-sm font-semibold text-ink">What changed in {offered}</h3>
                  {review.release === undefined ? (
                    // MUST-9.6: a failed changelog read must not become a wall that stops an
                    // admin updating — the confirm button below is still offered.
                    <p className="text-sm text-muted">
                      The release notes for {offered} could not be fetched. You can read them on the project&apos;s
                      releases page before deciding.
                    </p>
                  ) : (
                    review.release.groups.map((group) => (
                      <div key={group.title} className="flex flex-col gap-1.5">
                        <h4 className="eyebrow">{group.title}</h4>
                        <ul className="flex flex-col gap-1 text-sm text-muted">
                          {group.items.map((item, index) => (
                            <li key={index} className="flex gap-2">
                              <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                              <span>{renderEmphasis(item)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                  <Notice tone="warning">
                    This is a major version. Read the notes above before continuing. Your data is not touched by an
                    update — the database stays where it is and migrations run automatically when the new version
                    starts.
                  </Notice>
                  <div className="flex flex-wrap items-center gap-3">
                    <form action={apply}>
                      <input type="hidden" name="version" value={offered} />
                      {/* MUST-9.5: the version is in the LABEL, so a stale panel cannot install
                          something the reader did not read about. */}
                      <SubmitButton className="btn btn--primary">Install {offered}</SubmitButton>
                    </form>
                    <button type="button" className="btn btn--ghost" onClick={() => setPanelOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <form action={apply}>
                <input type="hidden" name="version" value={offered} />
                <SubmitButton className="btn btn--primary">Update now</SubmitButton>
              </form>
              <form action={dismiss}>
                <input type="hidden" name="version" value={offered} />
                <SubmitButton className="btn btn--ghost">Not now</SubmitButton>
              </form>
            </div>
          )}

          {/* MUST-9.9: no spinner, no polling, no auto-reload. The container is going away; a
              page trying to poll it is a page showing a network error. */}
        </CardBody>
      </Card>
    );
  }
  ```

- [ ] **Render it from `src/app/(app)/settings/page.tsx` (MUST-9.1).** Add the import beside `AboutPanel`'s, and the conditional render immediately before `<AboutPanel />`:
  ```tsx
  import { UpdatesCard } from './updates-card';
  ```
  ```tsx
        {/* MUST-9.1: admin only. A member's Settings page is byte-identical to v1.3.0's. */}
        {user.role === 'admin' ? <UpdatesCard /> : null}

        {/* Last: the version and revision log are reference material, not a task. */}
        <AboutPanel />
  ```

- [ ] **Write `tests/app/updates-card.test.tsx` (§19.3).**
  ```tsx
  // @vitest-environment jsdom
  import { describe, it, expect, afterEach, vi } from 'vitest';
  import { render, cleanup, screen } from '@testing-library/react';
  import { UpdatesClient, type UpdatesViewProps } from '@/app/(app)/settings/updates-client';

  vi.mock('@/app/(app)/settings/actions', () => ({
    enableUpdateChecksAction: vi.fn(async () => ({})),
    disableUpdateChecksAction: vi.fn(async () => ({})),
    setAutoApplyAction: vi.fn(async () => ({})),
    checkForUpdateNowAction: vi.fn(async () => ({})),
    reviewUpdateAction: vi.fn(async () => ({})),
    applyUpdateAction: vi.fn(async () => ({})),
    dismissUpdateAction: vi.fn(async () => ({})),
  }));

  afterEach(cleanup);

  const base: UpdatesViewProps = {
    currentVersion: '1.3.1',
    enabled: true,
    autoApply: true,
    lastCheckedAt: '2026-08-18T09:30:00.000Z',
    lastCheckError: null,
    latestVersion: null,
    latestPublishedAt: null,
    dismissedVersion: null,
    lastAppliedAt: null,
    lastApplyError: null,
    severity: 'none',
    canApplyInApp: true,
    watchtowerError: null,
  };

  describe('MUST-9.3: the off state', () => {
    it('renders the verbatim copy and exactly one button', () => {
      render(<UpdatesClient {...base} enabled={false} autoApply={false} lastCheckedAt={null} />);
      expect(screen.getByText('Budget Tracker v1.3.1 · update checks are off.')).toBeTruthy();
      expect(
        screen.getByText(/That request carries the version you are running and nothing else/),
      ).toBeTruthy();
      expect(screen.getByText(/A major version never does/)).toBeTruthy();
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(screen.getByRole('button').textContent).toContain('Enable update checks');
    });
  });

  describe('MUST-9.4: the on state', () => {
    it('shows Up to date, the timestamp in iso.slice(0,16) form, and the three controls', () => {
      render(<UpdatesClient {...base} />);
      expect(screen.getByText('Up to date (v1.3.1)')).toBeTruthy();
      expect(screen.getByText(/Last checked 2026-08-18 09:30/)).toBeTruthy();
      for (const label of ['Check now', 'Install small updates automatically', 'Disable update checks']) {
        expect(screen.getByText(new RegExp(label))).toBeTruthy();
      }
      expect(screen.queryByText('Update now')).toBeNull();
    });

    it('renders Never when nothing has been checked yet', () => {
      render(<UpdatesClient {...base} lastCheckedAt={null} />);
      expect(screen.getByText(/Last checked Never/)).toBeTruthy();
    });

    it.each([
      ['patch', 'Patch update', 'Update now'],
      ['minor', 'Minor update', 'Update now'],
      ['major', 'Major update', 'Review and update'],
    ] as const)('%s offers the right badge and primary control', (severity, badge, control) => {
      render(<UpdatesClient {...base} severity={severity} latestVersion="1.4.0" />);
      expect(screen.getByText('Version 1.4.0 is available')).toBeTruthy();
      expect(screen.getByText(badge)).toBeTruthy();
      expect(screen.getByText(control)).toBeTruthy();
      expect(screen.getByText('Not now')).toBeTruthy();
    });

    it('surfaces a check error and an apply error in error notices', () => {
      render(<UpdatesClient {...base} lastCheckError="GitHub returned 500." lastApplyError="Watchtower said no." />);
      expect(screen.getByText('GitHub returned 500.')).toBeTruthy();
      expect(screen.getByText('Watchtower said no.')).toBeTruthy();
    });

    it('MUST-5.9: a dismissed version collapses to the status line and a Show again control', () => {
      render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" dismissedVersion="1.4.0" />);
      expect(screen.getByText('Version 1.4.0 is available — you chose to skip it for now.')).toBeTruthy();
      expect(screen.getByText('Show again')).toBeTruthy();
      expect(screen.queryByText('Update now')).toBeNull();
    });
  });

  describe('MUST-7.8 / MUST-7.9: no apply path', () => {
    it('renders the fallback copy and NO apply button anywhere — absent, not disabled', () => {
      render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" canApplyInApp={false} />);
      expect(screen.getByText('This install updates by hand.')).toBeTruthy();
      expect(screen.getByText(/Both scripts tag a rollback point first/)).toBeTruthy();
      expect(screen.getByText('install/synology-compose-pull.yml')).toBeTruthy();
      expect(screen.queryByText('Update now')).toBeNull();
      expect(screen.queryByText('Review and update')).toBeNull();
      // MUST-11.6's rule, applied here too: no address on the page is clickable.
      expect(document.querySelectorAll('a[href]')).toHaveLength(0);
    });

    it('MUST-8.7: a malformed WATCHTOWER_URL is reported, not swallowed', () => {
      render(
        <UpdatesClient
          {...base}
          canApplyInApp={false}
          watchtowerError="The WATCHTOWER_URL in your compose file is not a valid internal address."
        />,
      );
      expect(screen.getByText('The WATCHTOWER_URL in your compose file is not a valid internal address.')).toBeTruthy();
    });
  });

  describe('MUST-7.3: the card never receives a token', () => {
    it('the props type carries canApplyInApp and no credential field', () => {
      const keys = Object.keys(base);
      expect(keys).toContain('canApplyInApp');
      for (const key of keys) expect(key.toLowerCase()).not.toContain('token');
      expect(JSON.stringify(base).toLowerCase()).not.toContain('bearer');
    });
  });
  ```
  Add a companion assertion to the existing `tests/app/about-panel.test.tsx` or `tests/app/settings-page-notifications.test.tsx` — whichever already renders the settings page for both roles — that **a member's `/settings` renders no Updates card at all** (§19.3's last clause):
  ```tsx
  it('MUST-9.1: a member sees no Updates card', async () => {
    currentUser.value.role = 'member';
    render(await SettingsPage());
    expect(screen.queryByText('Updates')).toBeNull();
  });
  ```

- [ ] **Run the component tests and the type-check.**
  ```powershell
  npx vitest run tests/app/updates-card.test.tsx tests/app/about-panel.test.tsx
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Commit.**
  ```powershell
  git add "src/app/(app)/settings/updates-card.tsx" "src/app/(app)/settings/updates-client.tsx" "src/app/(app)/settings/page.tsx" src/components/icons.tsx tests/app
  git commit -m "feat(update): the Updates card on Settings - About

Admin only, above the changelog timeline, not in ADMIN_LINKS (MUST-9.1/9.2). The
off state is one paragraph of plain English and one button. The on state shows a
status line, a severity badge, the app's one timestamp convention, Check now, the
auto-apply checkbox and Disable. A major offers Review and update, which renders
the OFFERED version's own changelog through the same bold-run renderer AboutPanel
uses on the local one, behind a warning notice and a confirm button whose label
carries the version (MUST-9.5). With no Watchtower the apply button is ABSENT,
not disabled, and section 7.9's fallback copy ships verbatim with every path as
plain text rather than a link (MUST-7.8/7.9). No spinner, no polling, no
auto-reload: the container is going away (MUST-9.9). The card receives
canApplyInApp and nothing else about Watchtower (MUST-7.3)."
  ```

<!-- END TASK 8 -->

---

# Phase 3 — Loans

## Task 9: The billing rule widened by one predicate, the wording matrix, and the loan money fields

**Context:** Spec §12 in full and §11.4's app-layer half. Implements **MUST-12.1 … MUST-12.6**, **MUST-11.7** (the balance/anchor pairing rule), **MUST-14.4**'s parsing contract, and §19.6's `constants.test.ts`, `items.test.ts` and `types.test.ts`. **This is a one-predicate change plus a wording matrix — there is no DDL here at all**, because 0005 deliberately put the kind rule in the app layer and said why.

**Files:**
- Modify: `src/lib/warranty/constants.ts` (`billingAllowedForKind`; the `BILLING_WORDING` matrix; **delete** `billingCycleSuffix`)
- Modify: `src/lib/warranty/items.ts` (`BILLING_KIND_ERROR` reworded; `WarrantyItemRow`, `WarrantyInput`, `warrantyInputSchema`, `ITEM_COLUMNS`, both writers; `assertLoanFieldsMatchKind`; `assertBalanceAnchorPairing`)
- Modify: `src/lib/warranty/types.ts` (`setItemTypeKind`'s second clearing pass)
- Modify: `src/lib/warranty/search.ts` (`RawRow`, `toListItem`)
- Test: `tests/lib/warranty/constants.test.ts`, `tests/lib/warranty/items.test.ts`, `tests/lib/warranty/types.test.ts`, `tests/lib/warranty/search.test.ts` (append to each)

**Resolution of a spec cross-reference:** MUST-12.2 says "`BILLING_KIND_ERROR` is reworded" inside §12.1, which is otherwise about `constants.ts`. The constant actually lives in `src/lib/warranty/items.ts:250`. **It is reworded where it is; it does not move.** Only `billingAllowedForKind` and the wording matrix change in `constants.ts`.

**Interfaces:**
- Consumes: `findItemType` from `@/lib/warranty/types`; `parseAmountToCents` from `@/lib/money`.
- Produces:
  ```ts
  // src/lib/warranty/constants.ts
  export function billingAllowedForKind(kind: ItemKind): boolean;   // widened
  export function billingSectionLabelForKind(kind: ItemKind): string;
  export function billingAmountLabelForKind(kind: ItemKind): string;
  export function billingCycleSuffixForKind(kind: ItemKind, cycle: BillingCycle): string;
  export function loanFieldsAllowedForKind(kind: ItemKind): boolean;   // kind === 'loan'
  // export function billingCycleSuffix(cycle) -- DELETED

  // src/lib/warranty/items.ts
  export const BILLING_KIND_ERROR = 'Billing details only apply to subscriptions, contracts and loans.';
  export const LOAN_KIND_ERROR = 'Loan amounts only apply to loans.';
  export const BALANCE_ANCHOR_ERROR = 'A balance and the date it was set must both be present, or both absent.';
  // WarrantyItemRow / WarrantyInput gain:
  //   principalCents, interestRateBps, currentBalanceCents, balanceUpdatedAt
  ```

### Steps

- [ ] **Widen the predicate and add the wording matrix in `src/lib/warranty/constants.ts` (MUST-12.1, MUST-12.3, MUST-12.4).** Replace `billingAllowedForKind` and **delete `billingCycleSuffix` outright** — not wrapped, per warranty §19.12's Reviewer-Issue-1 precedent, so wording lives in exactly one place.
  ```ts
  /**
   * v1.3.1: widened to include 'loan'. A loan's billing pair is its regular PAYMENT
   * (see BILLING_WORDING) -- the amount and the cadence, not an interest calculation.
   *
   * This is the ENTIRE server-side rule change. assertBillingMatchesKind() in items.ts calls
   * this predicate, setItemTypeKind()'s clearing pass calls it, and both forms gate their
   * fieldset on it -- so one edit moves every one of them together. The rule lives here, in
   * the app layer, rather than in SQL, because a CHECK on warranty_items cannot see across to
   * warranty_item_types.kind; drizzle/0005_billing_cycle.sql's own header says so, which is
   * why widening it needs no DDL and no table rebuild (MUST-11.6).
   */
  export function billingAllowedForKind(kind: ItemKind): boolean {
    return kind !== 'warranty';
  }

  /** v1.3.1: the four money columns are loan-only, by the same app-layer argument. */
  export function loanFieldsAllowedForKind(kind: ItemKind): boolean {
    return kind === 'loan';
  }

  /**
   * MUST-12.3: the second wording matrix, beside KIND_WORDING. The `warranty` row exists only
   * so the record is total; it is unreachable through the UI, because
   * billingAllowedForKind('warranty') is false.
   *
   * MUST-12.4: BILLING_CYCLE_LABELS (Monthly / Annual) is unchanged and shared -- the cadence
   * has the same name for a subscription and for a loan; only the noun around it differs.
   */
  const BILLING_WORDING: Record<ItemKind, { section: string; amount: string; monthly: string; annual: string }> = {
    warranty: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
    subscription: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
    contract: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
    loan: { section: 'Payment', amount: 'Payment amount', monthly: 'per month', annual: 'per year' },
  };

  export function billingSectionLabelForKind(kind: ItemKind): string {
    return BILLING_WORDING[kind].section;
  }

  export function billingAmountLabelForKind(kind: ItemKind): string {
    return BILLING_WORDING[kind].amount;
  }

  export function billingCycleSuffixForKind(kind: ItemKind, cycle: BillingCycle): string {
    return cycle === 'monthly' ? BILLING_WORDING[kind].monthly : BILLING_WORDING[kind].annual;
  }
  ```

- [ ] **Update the two call sites of the deleted helper.** `warranties-client.tsx`'s Billing cell and `warranty-detail-client.tsx`'s read view both already have the item's `kind` in scope; route each through `billingCycleSuffixForKind(item.kind, item.billingCycle)`. Find them first:
  ```powershell
  Select-String -Path .\src -Pattern 'billingCycleSuffix' -SimpleMatch -Recurse
  ```
  Expected after the edit: **zero** hits for the bare `billingCycleSuffix(` form anywhere under `src/`.

- [ ] **Extend `src/lib/warranty/items.ts`.** Reword the error, add the two new guards, and thread the four fields through the row type, the input type, the schema, `ITEM_COLUMNS` and both writers.
  ```ts
  /** MUST-12.2: reworded, because a loan may now carry a billing pair. */
  export const BILLING_KIND_ERROR = 'Billing details only apply to subscriptions, contracts and loans.';
  export const LOAN_KIND_ERROR = 'Loan amounts only apply to loans.';
  /** MUST-11.7: the cross-column rule that deliberately has no SQL representation. */
  export const BALANCE_ANCHOR_ERROR = 'A balance and the date it was set must both be present, or both absent.';

  /**
   * MUST-11.7: current_balance_cents and balance_updated_at are both set or both NULL. This
   * is a CROSS-COLUMN invariant, and 0007 deliberately does not express it as a SQL CHECK:
   * ALTER TABLE ADD COLUMN does not re-validate existing rows against a CHECK added that way,
   * so the constraint would be weaker than it looks while being riskier to add. It is enforced
   * here, beside assertBillingMatchesKind, by the same argument that migration's header makes.
   */
  function assertBalanceAnchorPairing(currentBalanceCents: number | null, balanceUpdatedAt: string | null): void {
    if ((currentBalanceCents === null) !== (balanceUpdatedAt === null)) throw new Error(BALANCE_ANCHOR_ERROR);
  }

  /** Loan-only money, by the same app-layer argument billing already lives under. */
  function assertLoanFieldsMatchKind(
    typeId: number | null,
    values: { principalCents: number | null; interestRateBps: number | null; currentBalanceCents: number | null; balanceUpdatedAt: string | null },
  ): void {
    const empty =
      values.principalCents === null &&
      values.interestRateBps === null &&
      values.currentBalanceCents === null &&
      values.balanceUpdatedAt === null;
    if (empty) return;
    if (!loanFieldsAllowedForKind(kindForTypeId(typeId))) throw new Error(LOAN_KIND_ERROR);
  }
  ```
  `WarrantyItemRow` and `WarrantyInput` each gain, at the END, matching the DDL order:
  ```ts
    /**
     * v1.3.1 (spec §11.2). Loan money. Always present on a read row (NULL for every
     * non-loan item), never omitted -- matching every other nullable column above.
     * MUST-13.1: interestRateBps is basis points and is DISPLAY ONLY.
     */
    principalCents: number | null;
    interestRateBps: number | null;
    currentBalanceCents: number | null;
    balanceUpdatedAt: string | null;
  ```
  (on `WarrantyInput` the four are `?:` optional, normalised to `null` before either writer, exactly as the billing pair already is).
  `warrantyInputSchema` gains, inside the object:
  ```ts
        principalCents: z.number().int('The original amount must be a whole number of cents').nonnegative().nullable().optional(),
        // MUST-14.4: 0-10000%, range-checked in zod as well as in SQL.
        interestRateBps: z.number().int().min(0).max(1_000_000, 'That rate is out of range.').nullable().optional(),
        currentBalanceCents: z.number().int('The balance must be a whole number of cents').nonnegative().nullable().optional(),
        balanceUpdatedAt: z.string().min(1).nullable().optional(),
  ```
  and, inside the existing `.superRefine`, beside the billing-pair check:
  ```ts
        // MUST-11.7, at the schema boundary as well as in the writers.
        const balanceSet = value.currentBalanceCents !== null && value.currentBalanceCents !== undefined;
        const anchorSet = value.balanceUpdatedAt !== null && value.balanceUpdatedAt !== undefined;
        if (balanceSet !== anchorSet) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentBalance'], message: BALANCE_ANCHOR_ERROR });
        }
  ```
  `ITEM_COLUMNS` gains the four, after `billingAmountCents`. Both writers gain the normalisation and the two new asserts, immediately beside the existing `assertBillingMatchesKind` call and **before** the transaction opens:
  ```ts
    const principalCents = input.principalCents ?? null;
    const interestRateBps = input.interestRateBps ?? null;
    const currentBalanceCents = input.currentBalanceCents ?? null;
    const balanceUpdatedAt = input.balanceUpdatedAt ?? null;
    assertBillingMatchesKind(input.typeId, billingCycle, billingAmountCents);
    assertLoanFieldsMatchKind(input.typeId, { principalCents, interestRateBps, currentBalanceCents, balanceUpdatedAt });
    assertBalanceAnchorPairing(currentBalanceCents, balanceUpdatedAt);
  ```
  and each writer's `.values({ ... })` / `.set({ ... })` spread gains `principalCents, interestRateBps, currentBalanceCents, balanceUpdatedAt` beside the billing pair, so an omitted optional never reaches better-sqlite3's bind step as `undefined`.

- [ ] **Add the second clearing pass to `setItemTypeKind` in `src/lib/warranty/types.ts` (MUST-12.5, MUST-12.6).** In the SAME transaction as the kind write, after the existing billing branch:
  ```ts
      /**
       * MUST-12.5: a type moving AWAY from 'loan' loses its loan money and its matcher rules
       * -- a matcher rule can only mean something for a loan -- but KEEPS every loan_payments
       * row. Those rows are historical facts about transactions, not configuration, and
       * deleting them would silently rewrite what the household paid. They become inert:
       * listLoans() and the debt report both filter on kind = 'loan' with a non-null balance,
       * so nothing reads them until the type becomes a loan again -- at which point
       * re-entering a balance moves the anchor to now (MUST-11.8) and the old rows are
       * correctly excluded from the reconstruction anyway.
       *
       * MUST-12.6: the billing pair moves with the rule it always had. loan -> subscription
       * KEEPS the pair (both kinds allow it) and clears only the money fields;
       * loan -> warranty loses both sets.
       */
      if (!loanFieldsAllowedForKind(cleanKind)) {
        const itemIds = tx
          .select({ id: warrantyItems.id })
          .from(warrantyItems)
          .where(eq(warrantyItems.typeId, typeId))
          .all()
          .map((row) => row.id);
        if (itemIds.length > 0) {
          tx.update(warrantyItems)
            .set({ principalCents: null, interestRateBps: null, currentBalanceCents: null, balanceUpdatedAt: null })
            .where(inArray(warrantyItems.id, itemIds))
            .run();
          tx.delete(loanMatcherRules).where(inArray(loanMatcherRules.itemId, itemIds)).run();
        }
      }
  ```
  Add `inArray` to the `drizzle-orm` import, `loanMatcherRules` to the `@/db/schema` import, and `loanFieldsAllowedForKind` to the `@/lib/warranty/constants` import.

- [ ] **Extend `src/lib/warranty/search.ts`.** The query is `select i.*`, so the four columns arrive automatically: add them to `RawRow` and map them in `toListItem`.
  ```ts
    principal_cents: number | null;
    interest_rate_bps: number | null;
    current_balance_cents: number | null;
    balance_updated_at: string | null;
  ```
  ```ts
      principalCents: row.principal_cents,
      interestRateBps: row.interest_rate_bps,
      currentBalanceCents: row.current_balance_cents,
      balanceUpdatedAt: row.balance_updated_at,
  ```

- [ ] **Append the tests (§19.6).**
  ```ts
  // tests/lib/warranty/constants.test.ts
  describe('MUST-12.1 … MUST-12.4: the widened rule and the wording matrix', () => {
    it('billingAllowedForKind is true for loan and still false for warranty', () => {
      expect(billingAllowedForKind('loan')).toBe(true);
      expect(billingAllowedForKind('subscription')).toBe(true);
      expect(billingAllowedForKind('contract')).toBe(true);
      expect(billingAllowedForKind('warranty')).toBe(false);
    });

    it('loanFieldsAllowedForKind is true for loan alone', () => {
      expect(ITEM_KINDS.filter((kind) => loanFieldsAllowedForKind(kind))).toEqual(['loan']);
    });

    it('returns the MUST-12.3 table for all four kinds', () => {
      for (const kind of ['warranty', 'subscription', 'contract'] as const) {
        expect(billingSectionLabelForKind(kind)).toBe('Billing');
        expect(billingAmountLabelForKind(kind)).toBe('Amount');
        expect(billingCycleSuffixForKind(kind, 'monthly')).toBe('/ month');
        expect(billingCycleSuffixForKind(kind, 'annual')).toBe('/ year');
      }
      expect(billingSectionLabelForKind('loan')).toBe('Payment');
      expect(billingAmountLabelForKind('loan')).toBe('Payment amount');
      expect(billingCycleSuffixForKind('loan', 'monthly')).toBe('per month');
      expect(billingCycleSuffixForKind('loan', 'annual')).toBe('per year');
      // MUST-12.4: the cadence labels are shared and unchanged.
      expect(BILLING_CYCLE_LABELS).toEqual({ monthly: 'Monthly', annual: 'Annual' });
    });

    it('MUST-12.3: the kind-agnostic billingCycleSuffix is DELETED, not wrapped', () => {
      // A source-level check rather than a type error: a real `import { billingCycleSuffix }`
      // in this file would break `tsc --noEmit` for the whole suite, which is a worse signal
      // than a failing assertion. Wording must live in exactly one place.
      const source = fs.readFileSync(path.join(root, 'src/lib/warranty/constants.ts'), 'utf8');
      expect(source).not.toMatch(/export function billingCycleSuffix\s*\(/);
      const callers = fs
        .readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
        .filter((name) => /\.tsx?$/.test(name))
        .filter((name) => /billingCycleSuffix\s*\(/.test(fs.readFileSync(path.join(root, 'src', name), 'utf8')))
        .filter((name) => !/billingCycleSuffixForKind\s*\(/.test(fs.readFileSync(path.join(root, 'src', name), 'utf8')));
      expect(callers).toEqual([]);
    });
  });
  ```
  ```ts
  // tests/lib/warranty/items.test.ts
  describe('MUST-12.1 / MUST-12.2 / MUST-11.7: loan money on an item', () => {
    it('a loan may now save a billing pair and a warranty still may not', () => {
      const loanType = createItemType({ name: 'Car loan', kind: 'loan' });
      expect(() =>
        createWarrantyItem({ ...baseInput, typeId: loanType.id, billingCycle: 'monthly', billingAmountCents: 45000 }),
      ).not.toThrow();
      const warrantyType = createItemType({ name: 'Appliance', kind: 'warranty' });
      expect(() =>
        createWarrantyItem({ ...baseInput, typeId: warrantyType.id, billingCycle: 'monthly', billingAmountCents: 45000 }),
      ).toThrowError('Billing details only apply to subscriptions, contracts and loans.');
    });

    it('the four money fields are refused on a non-loan kind', () => {
      const subType = createItemType({ name: 'Streaming', kind: 'subscription' });
      expect(() => createWarrantyItem({ ...baseInput, typeId: subType.id, principalCents: 100 })).toThrowError(
        'Loan amounts only apply to loans.',
      );
    });

    it('MUST-11.7: a balance with no anchor, and an anchor with no balance, are both rejected', () => {
      const loanType = createItemType({ name: 'Car loan 2', kind: 'loan' });
      expect(() =>
        createWarrantyItem({ ...baseInput, typeId: loanType.id, currentBalanceCents: 100, balanceUpdatedAt: null }),
      ).toThrowError('A balance and the date it was set must both be present, or both absent.');
      expect(() =>
        createWarrantyItem({ ...baseInput, typeId: loanType.id, currentBalanceCents: null, balanceUpdatedAt: '2026-08-18T00:00:00.000Z' }),
      ).toThrowError('A balance and the date it was set must both be present, or both absent.');
    });

    it('MUST-14.4: the rate round-trips through basis points and 100.01% is rejected in SQL', () => {
      const loanType = createItemType({ name: 'Car loan 3', kind: 'loan' });
      const id = createWarrantyItem({ ...baseInput, typeId: loanType.id, interestRateBps: 549 });
      expect(getWarrantyItem(id)?.interestRateBps).toBe(549);
      expect(() => createWarrantyItem({ ...baseInput, typeId: loanType.id, interestRateBps: 1_000_001 })).toThrow();
    });
  });
  ```
  ```ts
  // tests/lib/warranty/types.test.ts
  describe('MUST-12.5 / MUST-12.6: what a kind flip clears', () => {
    it('loan -> warranty clears the money and the billing pair, deletes the rules, KEEPS the payments', () => {
      const { typeId, itemId, txnId } = seedLoanWithRuleAndPayment();
      setItemTypeKind(typeId, 'warranty');
      const item = getWarrantyItem(itemId)!;
      expect([item.principalCents, item.interestRateBps, item.currentBalanceCents, item.balanceUpdatedAt]).toEqual([
        null, null, null, null,
      ]);
      expect([item.billingCycle, item.billingAmountCents]).toEqual([null, null]);
      expect(t.sqlite.prepare('select count(*) as n from loan_matcher_rules').get()).toEqual({ n: 0 });
      // Historical facts about what the household paid survive.
      expect(t.sqlite.prepare('select count(*) as n from loan_payments where txn_id = ?').get(txnId)).toEqual({ n: 1 });
    });

    it('loan -> subscription KEEPS the billing pair and clears only the money fields', () => {
      const { typeId, itemId } = seedLoanWithRuleAndPayment();
      setItemTypeKind(typeId, 'subscription');
      const item = getWarrantyItem(itemId)!;
      expect(item.billingCycle).toBe('monthly');
      expect(item.billingAmountCents).toBe(45000);
      expect(item.currentBalanceCents).toBeNull();
      expect(t.sqlite.prepare('select count(*) as n from loan_matcher_rules').get()).toEqual({ n: 0 });
    });
  });
  ```

- [ ] **Run the warranty suites and the type-check.**
  ```powershell
  npx vitest run tests/lib/warranty tests/app/warranties-actions.test.ts tests/app/warranties-client.test.tsx tests/app/warranty-detail-client.test.tsx
  npx tsc --noEmit
  ```
  Expected: green. A red `tsc` naming `billingCycleSuffix` is the deletion doing its job — fix the call site, do not restore the helper.

- [ ] **Commit.**
  ```powershell
  git add src/lib/warranty src/app tests/lib/warranty
  git commit -m "feat(loans): widen the billing rule by one predicate and add loan money fields

billingAllowedForKind becomes kind !== 'warranty' - the entire server-side rule
change, with no DDL and no table rebuild, because 0005 deliberately put the kind
rule in the app layer and said why (MUST-11.6/12.1). billingCycleSuffix is
DELETED rather than wrapped, following warranty section 19.12's precedent, and
every call site is routed through the kind-keyed matrix so wording lives in
exactly one place (MUST-12.3). The four money columns are loan-only and the
balance/anchor pairing is enforced beside assertBillingMatchesKind, because
ALTER TABLE ADD COLUMN would make a cross-column CHECK weaker than it looks
(MUST-11.7). A kind flip away from loan clears the money and the rules in the
same transaction but KEEPS the payments: those are facts about what the household
paid, not configuration (MUST-12.5)."
  ```

<!-- END TASK 9 -->

---

## Task 10: `src/lib/loans.ts` — the matcher, the manual links, the exact reversal and the five call sites

**Context:** Spec §13 in full. Implements **MUST-13.1 … MUST-13.17**, **MUST-11.11**, **MUST-11.12**, **MUST-11.14**, **MUST-11.15**, **MUST-14.12**'s backfill bucket, and §19.6's `matcher.test.ts`, `reversal.test.ts` and `backfill.test.ts`. The read model (`listLoans`, `debtOverTime`) lands in Task 12; this task is the write side.

**Files:**
- Create: `src/lib/loans.ts`
- Modify: `src/lib/import/commit.ts` (`UndoResult.loanLinksReversed`; one call inside the existing transaction)
- Modify: `src/lib/import/flow.ts` (`CommitFlowResult.loanLinksCreated`; one call after `runEngine`)
- Modify: `src/lib/simplefin/sync.ts` (the same call after its `runEngine`)
- Modify: `src/lib/transactions.ts` (one call at the end of `createManualTransaction`)
- Modify: `src/lib/categorize/engine.ts` (one call at the end of `confirmCategory`, **on every path**)
- Test: `tests/lib/loans/matcher.test.ts`, `tests/lib/loans/reversal.test.ts`, `tests/lib/loans/backfill.test.ts`, `tests/lib/loans/summary.test.ts` (**all new**). `summary.test.ts` is written here rather than in Task 12 because `listLoans` is built here; its assertions are the §19.6 `summary.test.ts` list, reproduced in Task 12 for reference only.

**Interfaces:**
- Consumes: `getDb` from `@/db/client`; `loanMatcherRules`, `loanPayments`, `transactions`, `warrantyItems`, `warrantyItemTypes` from `@/db/schema`; `and`, `asc`, `eq`, `gte`, `inArray`, `isNotNull`, `sql` from `drizzle-orm`; `addDaysIso`, `todayIso` from `@/lib/dates`; `nowIso` from `@/lib/clock`; `type RateVerdict` from `@/lib/notify/ratelimit` (**`import type` only** — a structural type, no runtime coupling).
- Produces:
  ```ts
  export const MAX_RULES_PER_LOAN = 5;
  export const LOAN_BACKFILL_DAYS = 365;
  export const LOAN_BACKFILL_MAX = 500;
  export const BACKFILL_WINDOW_MS = 10 * 60_000;
  export const BACKFILL_MAX_GLOBAL = 5;

  export interface LoanRule { id: number; itemId: number; merchantContains: string; accountId: number | null; enabled: boolean }
  export function listLoanRules(itemId: number): LoanRule[];
  export function saveLoanRule(input: { itemId: number; merchantContains: string; accountId: number | null; enabled: boolean; at?: Date }): number;
  export function deleteLoanRule(id: number): boolean;

  export interface LoanLink { id: number; txnId: number; itemId: number; itemName: string; amountCents: number; appliedCents: number; source: 'rule' | 'manual' }
  export function loanLinksForTransactions(txnIds: number[]): Map<number, LoanLink[]>;

  export function applyLoanMatchers(txnIds: number[], at?: Date): number;
  export function backfillLoanRule(ruleId: number, opts?: { days?: number; max?: number; at?: Date }): { linked: number; appliedCents: number };
  export function assignTransactionToLoan(input: { txnId: number; itemId: number; at?: Date }): { linked: boolean; appliedCents: number };
  export function unassignTransactionFromLoan(input: { txnId: number; itemId: number }): boolean;
  export function reverseLoanLinksForTransactions(txnIds: number[]): number;

  export function checkLoanBackfill(now?: number): RateVerdict;
  export function setLoanRateLimitClockForTests(next: (() => number) | null): void;
  export function resetLoanRateLimitsForTests(): void;

  // The loan SUMMARY read model also lands here, because Task 11's transactions page and
  // warranty detail page both consume it. Only debtOverTime waits for Task 12.
  export interface LoanSummary {
    itemId: number; name: string; ownerUserId: number; ownerName: string;
    principalCents: number | null; interestRateBps: number | null;
    currentBalanceCents: number | null; balanceUpdatedAt: string | null;
    billingCycle: BillingCycle | null; billingAmountCents: number | null;
    startDate: string; expiryDate: string | null; isLifetime: boolean;
    /** 0..1, or null when principal or balance is unset, or principal is 0. */
    payoffFraction: number | null;
    /** First scheduled payment on or after today, or null (§15.1). */
    nextPaymentDate: string | null;
    lastPaymentAt: string | null;
    paymentCount: number;
  }
  export function listLoans(today?: string): LoanSummary[];
  export function loansTotalOwedCents(): number;
  ```

**Two spec signatures resolved here, and recorded rather than smuggled in:**
- §13.2 declares `backfillLoanRule(...): number`, but **MUST-13.10** requires the success message to read `Rule saved. 14 past payments linked, $4,830.00 taken off the balance.` — a count *and* a total. A single number cannot carry both, so the return type is widened to `{ linked: number; appliedCents: number }`. Nothing else in the spec reads this value.
- §13.2 groups `listLoans` / `loansTotalOwedCents` with the read model, which §15 covers. They are **built in this task**, not Task 12, because Task 11's transactions page (`loanOptions`) and warranty detail page (the payoff bar) both consume them and Task 11 runs first. `debtOverTime` genuinely belongs to Task 12: nothing before the reports card reads it.

### Steps

- [ ] **Write `src/lib/loans.ts`'s write side.** (`listLoans`, `loansTotalOwedCents` and `debtOverTime` are appended in Task 12; leave the file's read-model section for that task rather than stubbing it.)
  ```ts
  import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
  import { getDb } from '@/db/client';
  import { loanMatcherRules, loanPayments, transactions, warrantyItemTypes, warrantyItems } from '@/db/schema';
  import { nowIso } from '@/lib/clock';
  import { addDaysIso, todayIso } from '@/lib/dates';
  import type { RateVerdict } from '@/lib/notify/ratelimit';

  /**
   * Loan money-tracking (spec 2026-08-17 §13).
   *
   * MUST-13.1: interest_rate_bps is DISPLAY ONLY. Nothing in this file multiplies, accrues,
   * projects or amortises with it, and tests/ops/loan-invariants.test.ts asserts that by grep.
   *
   * MUST-13.2: loan payments STAY in their spending category and in every budget. Nothing here
   * writes is_transfer, category_id or attributed_user_id, and nothing here touches the
   * `transactions` table at all. A car payment is money that left the household this month;
   * hiding it from the budget would make the budget wrong.
   */
  export const MAX_RULES_PER_LOAN = 5;
  export const LOAN_BACKFILL_DAYS = 365;
  export const LOAN_BACKFILL_MAX = 500;

  /**
   * MUST-14.12 / MUST-14.13: the third in-memory bucket in the codebase (notify's, update's,
   * this one). They stay separate because their windows, scopes and reset semantics differ and
   * a shared abstraction over three call sites would be one abstraction and three special
   * cases. If a fourth appears, extract then.
   *
   * This is the ONE loan action that carries a limit: ordinary loan CRUD and assign/unassign
   * carry none, consistent with every existing warranty and transaction action. The backfill
   * is the only expensive one — it scans up to a year of transactions.
   */
  export const BACKFILL_WINDOW_MS = 10 * 60_000;
  export const BACKFILL_MAX_GLOBAL = 5;

  let backfillClock: () => number = () => Date.now();
  const backfillStamps: number[] = [];

  export function setLoanRateLimitClockForTests(next: (() => number) | null): void {
    backfillClock = next ?? (() => Date.now());
  }

  export function resetLoanRateLimitsForTests(): void {
    backfillStamps.length = 0;
  }

  export function checkLoanBackfill(now: number = backfillClock()): RateVerdict {
    while (backfillStamps.length > 0 && (backfillStamps[0] as number) <= now - BACKFILL_WINDOW_MS) backfillStamps.shift();
    if (backfillStamps.length >= BACKFILL_MAX_GLOBAL) {
      const oldest = backfillStamps[0] ?? now;
      const waitMs = Math.max(0, oldest + BACKFILL_WINDOW_MS - now);
      return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
    }
    backfillStamps.push(now);
    return { allowed: true, retryAfterMinutes: 0 };
  }

  // ---------------------------------------------------------------- matcher rules

  export interface LoanRule {
    id: number;
    itemId: number;
    merchantContains: string;
    accountId: number | null;
    enabled: boolean;
  }

  export function listLoanRules(itemId: number): LoanRule[] {
    return getDb()
      .select({
        id: loanMatcherRules.id,
        itemId: loanMatcherRules.itemId,
        merchantContains: loanMatcherRules.merchantContains,
        accountId: loanMatcherRules.accountId,
        enabled: loanMatcherRules.enabled,
      })
      .from(loanMatcherRules)
      .where(eq(loanMatcherRules.itemId, itemId))
      .orderBy(asc(loanMatcherRules.id))
      .all();
  }

  /**
   * MUST-11.11: merchant_contains is stored UPPERCASED, because it is compared against
   * transactions.normalized_merchant and normalizeMerchant() uppercases. No lower() wrapper on
   * either side. (This is the same normalizer-casing trap the notify build hit in its R1
   * review finding; it is called out here so it is not hit twice.)
   *
   * MUST-11.12: MAX_RULES_PER_LOAN is enforced here as well as in the action, so a caller that
   * does not route through the action cannot exceed it either.
   */
  export function saveLoanRule(input: {
    itemId: number;
    merchantContains: string;
    accountId: number | null;
    enabled: boolean;
    at?: Date;
  }): number {
    const at = nowIso(input.at ?? new Date());
    const merchant = input.merchantContains.trim().toUpperCase();
    if (merchant.length < 3) throw new Error('Use at least three characters, or this will match almost everything.');
    if (listLoanRules(input.itemId).length >= MAX_RULES_PER_LOAN) throw new Error('Five rules per loan is the limit.');
    const row = getDb()
      .insert(loanMatcherRules)
      .values({
        itemId: input.itemId,
        merchantContains: merchant,
        accountId: input.accountId,
        enabled: input.enabled,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: loanMatcherRules.id })
      .get();
    return row.id;
  }

  export function deleteLoanRule(id: number): boolean {
    return getDb().delete(loanMatcherRules).where(eq(loanMatcherRules.id, id)).run().changes > 0;
  }

  // ---------------------------------------------------------------- links

  export interface LoanLink {
    id: number;
    txnId: number;
    itemId: number;
    itemName: string;
    amountCents: number;
    appliedCents: number;
    source: 'rule' | 'manual';
  }

  /** One query, served by loan_payments_txn_idx. Used by the transactions page. */
  export function loanLinksForTransactions(txnIds: number[]): Map<number, LoanLink[]> {
    const out = new Map<number, LoanLink[]>();
    if (txnIds.length === 0) return out;
    const rows = getDb()
      .select({
        id: loanPayments.id,
        txnId: loanPayments.txnId,
        itemId: loanPayments.itemId,
        itemName: warrantyItems.name,
        amountCents: loanPayments.amountCents,
        appliedCents: loanPayments.appliedCents,
        source: loanPayments.source,
      })
      .from(loanPayments)
      .innerJoin(warrantyItems, eq(warrantyItems.id, loanPayments.itemId))
      .where(inArray(loanPayments.txnId, txnIds))
      .orderBy(asc(loanPayments.id))
      .all();
    for (const row of rows) {
      const list = out.get(row.txnId) ?? [];
      list.push(row);
      out.set(row.txnId, list);
    }
    return out;
  }

  interface ActiveRule {
    ruleId: number;
    itemId: number;
    merchantContains: string;
    accountId: number | null;
    balanceCents: number;
  }

  /**
   * Every ENABLED rule whose item is a loan-kind item with a non-null current_balance_cents,
   * in ONE query. This is the loans-side dormancy bail: a household with no loans pays one
   * indexed read per import and nothing else (AC5).
   */
  function activeRules(tx: ReturnType<typeof getDb>): ActiveRule[] {
    return tx
      .select({
        ruleId: loanMatcherRules.id,
        itemId: loanMatcherRules.itemId,
        merchantContains: loanMatcherRules.merchantContains,
        accountId: loanMatcherRules.accountId,
        balanceCents: sql<number>`${warrantyItems.currentBalanceCents}`,
      })
      .from(loanMatcherRules)
      .innerJoin(warrantyItems, eq(warrantyItems.id, loanMatcherRules.itemId))
      .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
      .where(
        and(
          eq(loanMatcherRules.enabled, true),
          eq(warrantyItemTypes.kind, 'loan'),
          sql`${warrantyItems.currentBalanceCents} is not null`,
        ),
      )
      .orderBy(asc(loanMatcherRules.id))
      .all();
  }

  /**
   * MUST-11.15: the link row IS the guard. INSERT ... ON CONFLICT DO NOTHING, and the
   * decrement runs in the SAME statement sequence, conditional on changes > 0 — so a crash
   * between "decide to apply" and "record that we applied" is impossible.
   *
   * MUST-11.14 / MUST-13.6: applied_cents records the CLAMPED figure, so a reversal restores
   * the balance exactly, with no drift, in every clamping case. A payment against a loan
   * already at zero produces a link row with applied_cents = 0 — the payment is recorded, the
   * balance stays at zero, and nothing is silently swallowed.
   */
  function link(
    tx: ReturnType<typeof getDb>,
    input: { txnId: number; itemId: number; amountCents: number; balanceCents: number; source: 'rule' | 'manual'; at: string },
  ): number | null {
    const applied = Math.max(0, Math.min(input.amountCents, input.balanceCents));
    const result = tx
      .insert(loanPayments)
      .values({
        txnId: input.txnId,
        itemId: input.itemId,
        amountCents: input.amountCents,
        appliedCents: applied,
        source: input.source,
        createdAt: input.at,
      })
      .onConflictDoNothing()
      .run();
    if (result.changes === 0) return null;
    if (applied > 0) {
      tx.update(warrantyItems)
        .set({ currentBalanceCents: sql`${warrantyItems.currentBalanceCents} - ${applied}` })
        // MUST-11.8: balance_updated_at is NOT touched. It is the human anchor.
        .where(eq(warrantyItems.id, input.itemId))
        .run();
    }
    return applied;
  }

  interface Candidate {
    id: number;
    accountId: number;
    normalizedMerchant: string;
    amountCents: number;
    isTransfer: boolean;
  }

  function candidates(tx: ReturnType<typeof getDb>, txnIds: number[]): Candidate[] {
    return tx
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        normalizedMerchant: transactions.normalizedMerchant,
        amountCents: transactions.amountCents,
        isTransfer: transactions.isTransfer,
      })
      .from(transactions)
      .where(inArray(transactions.id, txnIds))
      .orderBy(asc(transactions.id))
      .all();
  }

  function alreadyLinked(tx: ReturnType<typeof getDb>, txnIds: number[]): Set<number> {
    if (txnIds.length === 0) return new Set();
    const rows = tx.select({ txnId: loanPayments.txnId }).from(loanPayments).where(inArray(loanPayments.txnId, txnIds)).all();
    return new Set(rows.map((row) => row.txnId));
  }

  /**
   * MUST-13.3: the rule matcher, in one db.transaction.
   *
   * MUST-13.4 (one link per transaction, from the rule path): step 3's "already has any link"
   * check and step 4's "first rule by id wins" together guarantee the rule path creates at most
   * one link per transaction, EVER. Without it, two loans whose rules both match one merchant
   * string would each take the full payment off their balance and the household would appear
   * to have paid twice.
   *
   * MUST-13.5: this function NEVER throws into its caller. A loan-matching failure may not
   * break an import, a SimpleFIN sync, a manual entry or a category confirmation.
   */
  export function applyLoanMatchers(txnIds: number[], at: Date = new Date()): number {
    if (txnIds.length === 0) return 0;
    try {
      const stamp = nowIso(at);
      return getDb().transaction((tx) => {
        const rules = activeRules(tx);
        if (rules.length === 0) return 0; // the loans-side dormancy bail
        const balances = new Map(rules.map((rule) => [rule.itemId, rule.balanceCents]));
        const linked = alreadyLinked(tx, txnIds);

        let created = 0;
        for (const txn of candidates(tx, txnIds)) {
          if (txn.isTransfer) continue;
          if (txn.amountCents >= 0) continue; // a loan payment is money out
          if (linked.has(txn.id)) continue;

          const match = rules.find(
            (rule) =>
              txn.normalizedMerchant.includes(rule.merchantContains) &&
              (rule.accountId === null || rule.accountId === txn.accountId),
          );
          if (match === undefined) continue;

          const amount = Math.abs(txn.amountCents);
          const applied = link(tx, {
            txnId: txn.id,
            itemId: match.itemId,
            amountCents: amount,
            balanceCents: balances.get(match.itemId) ?? 0,
            source: 'rule',
            at: stamp,
          });
          if (applied === null) continue;
          balances.set(match.itemId, (balances.get(match.itemId) ?? 0) - applied);
          linked.add(txn.id);
          created += 1;
        }
        return created;
      });
    } catch (error) {
      console.error('[loans] matcher failed', error);
      return 0;
    }
  }

  /**
   * MUST-13.9 / MUST-13.10: the opt-in historical pass. Scans transactions with
   * date >= addDaysIso(today, -LOAN_BACKFILL_DAYS) — served by transactions_date_idx — applies
   * the same matching and clamping rules, and stops after LOAN_BACKFILL_MAX links. One
   * transaction, and it reports both the count and the total applied so a mistake is visible
   * immediately rather than discovered a month later.
   */
  export function backfillLoanRule(
    ruleId: number,
    opts: { days?: number; max?: number; at?: Date } = {},
  ): { linked: number; appliedCents: number } {
    const at = opts.at ?? new Date();
    const since = addDaysIso(todayIso(at), -(opts.days ?? LOAN_BACKFILL_DAYS));
    const cap = opts.max ?? LOAN_BACKFILL_MAX;
    try {
      const stamp = nowIso(at);
      return getDb().transaction((tx) => {
        const rule = activeRules(tx).find((candidate) => candidate.ruleId === ruleId);
        if (rule === undefined) return { linked: 0, appliedCents: 0 };

        const rows = tx
          .select({
            id: transactions.id,
            accountId: transactions.accountId,
            amountCents: transactions.amountCents,
          })
          .from(transactions)
          .where(
            and(
              gte(transactions.date, since),
              eq(transactions.isTransfer, false),
              sql`${transactions.amountCents} < 0`,
              sql`instr(${transactions.normalizedMerchant}, ${rule.merchantContains}) > 0`,
              rule.accountId === null ? sql`1 = 1` : eq(transactions.accountId, rule.accountId),
              sql`not exists (select 1 from ${loanPayments} lp where lp.txn_id = ${transactions.id})`,
            ),
          )
          .orderBy(asc(transactions.date), asc(transactions.id))
          .limit(cap)
          .all();

        let balance = rule.balanceCents;
        let linked = 0;
        let appliedTotal = 0;
        for (const row of rows) {
          const applied = link(tx, {
            txnId: row.id,
            itemId: rule.itemId,
            amountCents: Math.abs(row.amountCents),
            balanceCents: balance,
            source: 'rule',
            at: stamp,
          });
          if (applied === null) continue;
          balance -= applied;
          appliedTotal += applied;
          linked += 1;
        }
        return { linked, appliedCents: appliedTotal };
      });
    } catch (error) {
      console.error('[loans] backfill failed', error);
      return { linked: 0, appliedCents: 0 };
    }
  }

  /**
   * MUST-13.11: the same insert-and-decrement as the rule path, with source 'manual' and two
   * differences: it does NOT skip a transaction that already has a link to a DIFFERENT loan
   * (MUST-11.16 — a combined payment is legitimate), and it does NOT require the transaction
   * to be negative, because a household may want a loan disbursement or an adjustment on the
   * record. It still refuses a transaction already linked to THIS loan; the unique index makes
   * that a no-op, reported as linked: false.
   */
  export function assignTransactionToLoan(input: { txnId: number; itemId: number; at?: Date }): {
    linked: boolean;
    appliedCents: number;
  } {
    const stamp = nowIso(input.at ?? new Date());
    return getDb().transaction((tx) => {
      const txn = tx
        .select({ amountCents: transactions.amountCents })
        .from(transactions)
        .where(eq(transactions.id, input.txnId))
        .get();
      if (!txn) throw new Error('That transaction no longer exists.');

      const item = tx
        .select({ balance: warrantyItems.currentBalanceCents })
        .from(warrantyItems)
        .where(eq(warrantyItems.id, input.itemId))
        .get();
      if (!item) throw new Error('That loan no longer exists.');

      const amount = Math.abs(txn.amountCents);
      if (amount === 0) throw new Error('A zero-amount transaction cannot be a loan payment.');
      const applied = link(tx, {
        txnId: input.txnId,
        itemId: input.itemId,
        amountCents: amount,
        balanceCents: item.balance ?? 0,
        source: 'manual',
        at: stamp,
      });
      return applied === null ? { linked: false, appliedCents: 0 } : { linked: true, appliedCents: applied };
    });
  }

  /**
   * MUST-13.12: deletes the link row and adds applied_cents back to current_balance_cents in
   * the SAME transaction. Neither operation touches balance_updated_at (MUST-11.8).
   */
  export function unassignTransactionFromLoan(input: { txnId: number; itemId: number }): boolean {
    return getDb().transaction((tx) => {
      const row = tx
        .select({ appliedCents: loanPayments.appliedCents })
        .from(loanPayments)
        .where(and(eq(loanPayments.txnId, input.txnId), eq(loanPayments.itemId, input.itemId)))
        .get();
      if (!row) return false;
      tx.delete(loanPayments)
        .where(and(eq(loanPayments.txnId, input.txnId), eq(loanPayments.itemId, input.itemId)))
        .run();
      if (row.appliedCents > 0) {
        tx.update(warrantyItems)
          .set({ currentBalanceCents: sql`coalesce(${warrantyItems.currentBalanceCents}, 0) + ${row.appliedCents}` })
          .where(eq(warrantyItems.id, input.itemId))
          .run();
      }
      return true;
    });
  }

  /**
   * MUST-13.14: called INSIDE undoImport's existing transaction, BEFORE tx.delete(transactions).
   *
   * The ON DELETE CASCADE on loan_payments.txn_id would remove the rows anyway — but a cascade
   * cannot restore a balance, so the explicit reversal must run first. Returns rows reversed.
   */
  export function reverseLoanLinksForTransactions(txnIds: number[]): number {
    if (txnIds.length === 0) return 0;
    const db = getDb();
    const rows = db
      .select({ itemId: loanPayments.itemId, appliedCents: loanPayments.appliedCents })
      .from(loanPayments)
      .where(inArray(loanPayments.txnId, txnIds))
      .all();
    if (rows.length === 0) return 0;

    const byItem = new Map<number, number>();
    for (const row of rows) byItem.set(row.itemId, (byItem.get(row.itemId) ?? 0) + row.appliedCents);
    for (const [itemId, applied] of byItem) {
      if (applied === 0) continue;
      db.update(warrantyItems)
        .set({ currentBalanceCents: sql`coalesce(${warrantyItems.currentBalanceCents}, 0) + ${applied}` })
        .where(eq(warrantyItems.id, itemId))
        .run();
    }
    db.delete(loanPayments).where(inArray(loanPayments.txnId, txnIds)).run();
    return rows.length;
  }
  ```
  **Note on `reverseLoanLinksForTransactions` and the enclosing transaction:** it uses `getDb()` rather than a passed-in `tx` handle. better-sqlite3 transactions are synchronous and `db.transaction()` nests statements on the same connection, so calls made through `getDb()` inside an open transaction join it. That is the same pattern `undoImport`'s `untrain()` hook already relies on; do not change it to take a `tx` parameter without also changing the Bayes hook, or the two will disagree about what "inside the transaction" means.

- [ ] **Append the loan summary read model to the same file.** Add `users` to the `@/db/schema` import, `addMonthsClamped` and `todayIso` to the `@/lib/dates` import, and `import type { BillingCycle } from '@/lib/warranty/constants';`.
  ```ts
  /**
   * MUST-15.4: payoffFraction = clamp(1 - balance / principal, 0, 1), null unless both are set
   * and principal > 0. A zero principal would divide by zero; null is the honest answer.
   */
  function payoff(principalCents: number | null, balanceCents: number | null): number | null {
    if (principalCents === null || balanceCents === null || principalCents <= 0) return null;
    return Math.min(1, Math.max(0, 1 - balanceCents / principalCents));
  }

  /**
   * MUST-15.4: the first date on or after today in addMonthsClamped(startDate, k) for 'monthly'
   * or addMonthsClamped(startDate, 12k) for 'annual'; null when billing_cycle is null, and
   * capped at expiry_date when that is set -- there is no next payment after the payoff date.
   * addMonthsClamped is the EXISTING helper, so month-end clamping (a loan that started on the
   * 31st) is already solved and no new date arithmetic is written here.
   */
  function nextPayment(input: {
    startDate: string;
    cycle: BillingCycle | null;
    expiryDate: string | null;
    today: string;
  }): string | null {
    if (input.cycle === null) return null;
    const step = input.cycle === 'monthly' ? 1 : 12;
    // A loan that started decades ago must not spin: 1200 steps is a century of months.
    for (let k = 1; k <= 1200; k += 1) {
      const date = addMonthsClamped(input.startDate, step * k);
      if (date < input.today) continue;
      if (input.expiryDate !== null && date > input.expiryDate) return null;
      return date;
    }
    return null;
  }

  export interface LoanSummary {
    itemId: number;
    name: string;
    ownerUserId: number;
    ownerName: string;
    principalCents: number | null;
    interestRateBps: number | null;
    currentBalanceCents: number | null;
    balanceUpdatedAt: string | null;
    billingCycle: BillingCycle | null;
    billingAmountCents: number | null;
    startDate: string;
    expiryDate: string | null;
    isLifetime: boolean;
    payoffFraction: number | null;
    nextPaymentDate: string | null;
    lastPaymentAt: string | null;
    paymentCount: number;
  }

  export function listLoans(today: string = todayIso()): LoanSummary[] {
    const rows = getDb()
      .select({
        itemId: warrantyItems.id,
        name: warrantyItems.name,
        ownerUserId: warrantyItems.ownerUserId,
        ownerName: users.name,
        principalCents: warrantyItems.principalCents,
        interestRateBps: warrantyItems.interestRateBps,
        currentBalanceCents: warrantyItems.currentBalanceCents,
        balanceUpdatedAt: warrantyItems.balanceUpdatedAt,
        billingCycle: warrantyItems.billingCycle,
        billingAmountCents: warrantyItems.billingAmountCents,
        startDate: warrantyItems.purchaseDate,
        expiryDate: warrantyItems.expiryDate,
        isLifetime: warrantyItems.isLifetime,
        // MUST-11.8: the DISPLAY "as of" value the UI shows is max(anchor, newest payment), and
        // the two are labelled differently ("You set this on ..." versus "Last payment ...").
        lastPaymentAt: sql<string | null>`(select max(created_at) from ${loanPayments} lp where lp.item_id = ${warrantyItems.id})`,
        paymentCount: sql<number>`(select count(*) from ${loanPayments} lp where lp.item_id = ${warrantyItems.id})`,
      })
      .from(warrantyItems)
      .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
      .innerJoin(users, eq(users.id, warrantyItems.ownerUserId))
      .where(eq(warrantyItemTypes.kind, 'loan'))
      .orderBy(asc(warrantyItems.name), asc(warrantyItems.id))
      .all();

    return rows.map((row) => ({
      ...row,
      payoffFraction: payoff(row.principalCents, row.currentBalanceCents),
      nextPaymentDate: nextPayment({
        startDate: row.startDate,
        cycle: row.billingCycle,
        expiryDate: row.expiryDate,
        today,
      }),
    }));
  }

  export function loansTotalOwedCents(): number {
    return listLoans().reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);
  }
  ```

- [ ] **Wire the five call sites (MUST-13.7). Exactly five, and no others.**

  **`src/lib/import/flow.ts`** — `CommitFlowResult` gains `loanLinksCreated: number;`, and immediately after the existing `runEngine` try/catch/finally block, in the same non-throwing slot:
  ```ts
    // MUST-13.7: a post-commit side effect outside the commit transaction, exactly as
    // runEngine already is. applyLoanMatchers is internally guarded (MUST-13.5) and returns 0
    // on failure rather than throwing an import away.
    const loanLinksCreated = applyLoanMatchers(committed.insertedTransactionIds);
  ```
  and `loanLinksCreated` is added to the returned object.

  **`src/lib/simplefin/sync.ts`** — immediately after its `runEngine` try/catch, the same call on `insertedIds`, with the count added to the sync result alongside `engineFailed`.

  **`src/lib/transactions.ts`** — the last statement of `createManualTransaction`, before `return row.id;`:
  ```ts
    // MUST-13.7: a hand-typed loan payment is a loan payment. Runs after confirmCategory so
    // the row is in its final state, and is cheap when no loan rules exist.
    applyLoanMatchers([row.id]);
  ```

  **`src/lib/categorize/engine.ts`** — `confirmCategory` gains the call on **every** path, including the idempotent early return:
  ```ts
      if (row.categoryId === input.categoryId) {
        // Already confirmed to the same category: nothing to retrain.
        //
        // MUST-13.8: the matcher call sits on THIS path too. A transaction confirmed before a
        // loan rule existed could otherwise never be picked up by re-confirming it -- which is
        // exactly what a person does when they notice a payment did not get assigned. It is
        // cheap: applyLoanMatchers bails on its first query when no loan rules exist.
        //
        // The cost is worth stating rather than hiding: bulkCategorizeAction loops
        // confirmCategory, so a 50-row bulk confirm makes 50 applyLoanMatchers calls and, on a
        // household with no loans, 50 single-row indexed reads against an empty join. That is
        // a bounded, sub-millisecond cost on a user-initiated action, and it buys the property
        // that a person can always fix a missed assignment by re-confirming the row. Batching
        // it into the action layer would put a fifth caller in a sixth place and is the change
        // to make if that cost ever shows up in a profile.
        applyLoanMatchers([input.transactionId], at);
        return;
      }
  ```
  and, as the last statement of the function body, after `train(tokens, input.categoryId);`:
  ```ts
    applyLoanMatchers([input.transactionId], at);
  ```

  **`src/lib/import/commit.ts`** — `UndoResult` gains `loanLinksReversed: number;`, and inside the existing `db.transaction`, **after** the Bayes untrain loop and **before** `tx.delete(transactions)`:
  ```ts
        // MUST-13.14: BEFORE the delete. The ON DELETE CASCADE on loan_payments.txn_id would
        // remove the rows anyway -- but a cascade cannot restore a balance, so the explicit
        // reversal must run first.
        loanRowsReversed = reverseLoanLinksForTransactions(sole);
  ```
  with `let loanRowsReversed = 0;` declared just inside the transaction callback and `loanLinksReversed: loanRowsReversed` added to the returned object. **MUST-13.15:** the `shared` partition is untouched — the transaction still exists, the payment still happened.

- [ ] **Write `tests/lib/loans/matcher.test.ts` (§19.6).**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
  import { applyLoanMatchers, loanLinksForTransactions, saveLoanRule } from '@/lib/loans';

  let t: TestDb;
  let accountId = 0;
  let userId = 0;
  let typeId = 0;

  beforeEach(() => {
    t = createSeededTestDb();
    userId = insertTestUser(t.db, { username: 'loans' });
    accountId = insertTestAccount(t.db, { name: 'Chequing' });
    const type = t.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`)
      .get(NOW) as { id: number };
    typeId = type.id;
  });
  afterEach(() => {
    t.cleanup();
    vi.restoreAllMocks();
  });

  const NOW = '2026-08-18T12:00:00.000Z';

  function seedLoan(over: { name?: string; balanceCents?: number | null; principalCents?: number | null } = {}): {
    itemId: number;
    accountId: number;
  } {
    const balance = over.balanceCents === undefined ? 2_000_000 : over.balanceCents;
    const row = t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
         values (?, '2024-01-15', 0, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get(over.name ?? 'Civic', userId, typeId, over.principalCents ?? null, balance, balance === null ? null : NOW, NOW, NOW) as {
      id: number;
    };
    return { itemId: row.id, accountId };
  }

  function spend(
    merchant: string,
    amountCents: number,
    over: { accountId?: number; isTransfer?: boolean; date?: string; categoryId?: number | null } = {},
  ): number {
    const row = t.sqlite
      .prepare(
        `insert into transactions
           (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, is_transfer, created_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get(
        over.accountId ?? accountId,
        over.date ?? '2026-08-01',
        merchant,
        // The engine's normalizer uppercases; the fixture matches what it would have written.
        merchant.toUpperCase(),
        amountCents,
        over.categoryId ?? null,
        over.isTransfer === true ? 1 : 0,
        userId,
        NOW,
        NOW,
      ) as { id: number };
    return row.id;
  }

  function balanceOf(itemId: number): number | null {
    return (t.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(itemId) as { b: number | null }).b;
  }

  /** better-sqlite3 exposes no counter, so count prepares through the driver's own hook. */
  function queryCount(): number {
    return prepared;
  }
  let prepared = 0;
  beforeEach(() => {
    prepared = 0;
    const original = t.sqlite.prepare.bind(t.sqlite);
    vi.spyOn(t.sqlite, 'prepare').mockImplementation(((sqlText: string) => {
      prepared += 1;
      return original(sqlText);
    }) as typeof t.sqlite.prepare);
  });

  describe('MUST-13.3 … MUST-13.6: the rule matcher', () => {
    it('links one matching transaction and decrements the balance', () => {
      const { itemId } = seedLoan({ balanceCents: 2_000_000 });
      saveLoanRule({ itemId, merchantContains: 'honda fin', accountId: null, enabled: true });
      const txnId = spend('HONDA FIN SVC', -45_000);
      expect(applyLoanMatchers([txnId])).toBe(1);
      expect(balanceOf(itemId)).toBe(1_955_000);
      expect(loanLinksForTransactions([txnId]).get(txnId)![0]).toMatchObject({ appliedCents: 45_000, source: 'rule' });
    });

    it('MUST-11.15: running it twice over the same id creates nothing and decrements nothing', () => {
      const { itemId } = seedLoan({ balanceCents: 2_000_000 });
      saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
      const txnId = spend('HONDA FIN SVC', -45_000);
      applyLoanMatchers([txnId]);
      expect(applyLoanMatchers([txnId])).toBe(0);
      expect(balanceOf(itemId)).toBe(1_955_000);
    });

    it('MUST-11.11: matching is case-insensitive against the uppercasing normalizer', () => {
      const { itemId } = seedLoan({ balanceCents: 2_000_000 });
      // The rule is typed in lower case; the stored value is uppercased on write.
      saveLoanRule({ itemId, merchantContains: 'honda fin', accountId: null, enabled: true });
      expect(applyLoanMatchers([spend('honda fin svc', -45_000)])).toBe(1);
    });

    it('skips a positive amount, a transfer and an already-linked transaction', () => {
      const { itemId } = seedLoan({ balanceCents: 2_000_000 });
      saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
      expect(applyLoanMatchers([spend('HONDA FIN SVC', 45_000)])).toBe(0);
      expect(applyLoanMatchers([spend('HONDA FIN SVC', -45_000, { isTransfer: true })])).toBe(0);
      expect(balanceOf(itemId)).toBe(2_000_000);
    });

    it('MUST-13.4: two rules matching one transaction produce ONE link, from the lower rule id', () => {
      const first = seedLoan({ name: 'Car', balanceCents: 2_000_000 });
      const second = seedLoan({ name: 'Boat', balanceCents: 500_000 });
      const lowRuleId = saveLoanRule({ itemId: first.itemId, merchantContains: 'HONDA', accountId: null, enabled: true });
      const highRuleId = saveLoanRule({ itemId: second.itemId, merchantContains: 'HONDA', accountId: null, enabled: true });
      expect(lowRuleId).toBeLessThan(highRuleId);
      const txnId = spend('HONDA FIN SVC', -45_000);
      expect(applyLoanMatchers([txnId])).toBe(1);
      expect(balanceOf(first.itemId)).toBe(1_955_000);
      expect(balanceOf(second.itemId)).toBe(500_000);
    });

    it('an account-scoped rule ignores another account\'s transaction', () => {
      const other = insertTestAccount(t.db, { name: 'Other' });
      const { itemId, accountId } = seedLoan({ balanceCents: 2_000_000 });
      saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId, enabled: true });
      expect(applyLoanMatchers([spend('HONDA FIN SVC', -45_000, { accountId: other })])).toBe(0);
      expect(applyLoanMatchers([spend('HONDA FIN SVC', -45_000, { accountId })])).toBe(1);
    });

    it('MUST-13.6: a payment larger than the balance clamps to zero, recording the clamped figure', () => {
      const { itemId } = seedLoan({ balanceCents: 30_000 });
      saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
      const txnId = spend('HONDA FIN SVC', -45_000);
      applyLoanMatchers([txnId]);
      expect(balanceOf(itemId)).toBe(0);
      const link = loanLinksForTransactions([txnId]).get(txnId)![0]!;
      expect(link.amountCents).toBe(45_000);
      expect(link.appliedCents).toBe(30_000);
      // A further payment against a zero balance is RECORDED, applies nothing, swallows nothing.
      const second = spend('HONDA FIN SVC', -45_000);
      applyLoanMatchers([second]);
      expect(loanLinksForTransactions([second]).get(second)![0]!.appliedCents).toBe(0);
      expect(balanceOf(itemId)).toBe(0);
    });

    it('MUST-13.5: an internal failure returns 0 and does not propagate', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      t.sqlite.prepare('drop table loan_matcher_rules').run();
      expect(() => applyLoanMatchers([1, 2, 3])).not.toThrow();
      expect(applyLoanMatchers([1, 2, 3])).toBe(0);
      expect(spy).toHaveBeenCalled();
    });

    it('AC5: with zero loan rules it performs exactly ONE query and writes nothing', () => {
      const before = queryCount();
      expect(applyLoanMatchers([spend('GROCERY', -5_000)])).toBe(0);
      expect(queryCount() - before).toBe(1);
      expect(t.sqlite.prepare('select count(*) as n from loan_payments').get()).toEqual({ n: 0 });
    });
  });

  describe('MUST-13.2: a linked payment stays in its category and in every budget', () => {
    it('the category total is unchanged by linking', () => {
      const groceries = categoryIdByName(t.db, 'Groceries');
      const { itemId } = seedLoan({ balanceCents: 2_000_000 });
      saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
      const txnId = spend('HONDA FIN SVC', -45_000, { categoryId: groceries });
      const before = categoryBreakdown({ from: '2026-01-01', to: '2026-12-31' });
      applyLoanMatchers([txnId]);
      expect(categoryBreakdown({ from: '2026-01-01', to: '2026-12-31' })).toEqual(before);
      // ...and nothing on the transaction itself moved.
      const row = t.sqlite.prepare('select is_transfer, category_id, attributed_user_id from transactions where id = ?').get(txnId);
      expect(row).toEqual({ is_transfer: 0, category_id: groceries, attributed_user_id: null });
    });
  });
  ```

- [ ] **Write `tests/lib/loans/reversal.test.ts` (§19.6, R8).**
  ```ts
  describe('MUST-11.14 / MUST-13.12: unassign restores the exact balance', () => {
    it.each([
      ['ordinary', 2_000_000, 45_000, 1_955_000],
      ['clamped', 30_000, 45_000, 0],
      ['zero balance', 0, 45_000, 0],
    ])('%s', (_label, start, payment, afterLink) => {
      const { itemId } = seedLoan({ balanceCents: start });
      const txnId = spend('HONDA FIN SVC', -payment);
      assignTransactionToLoan({ txnId, itemId });
      expect(balanceOf(itemId)).toBe(afterLink);
      expect(unassignTransactionFromLoan({ txnId, itemId })).toBe(true);
      expect(balanceOf(itemId)).toBe(start);
    });
  });

  describe('MUST-13.14 / MUST-13.15: import undo', () => {
    it('restores balances for sole transactions and leaves shared ones linked', () => {
      // ...commit two imports sharing one transaction, match, then undo the first.
      const result = undoImport(firstImportId);
      expect(result.loanLinksReversed).toBe(1);
      expect(balanceOf(itemId)).toBe(startBalance - sharedPayment);
      expect(loanLinksForTransactions([sharedTxnId]).get(sharedTxnId)).toHaveLength(1);
    });

    it('R8: import -> match -> undo -> re-import -> match leaves the balance exactly where it started', () => {
      const start = balanceOf(itemId);
      const first = commitFixture();
      applyLoanMatchers(first.insertedTransactionIds);
      const moved = balanceOf(itemId);
      expect(moved).toBeLessThan(start);
      undoImport(first.importId);
      expect(balanceOf(itemId)).toBe(start);
      const second = commitFixture();
      applyLoanMatchers(second.insertedTransactionIds);
      expect(balanceOf(itemId)).toBe(moved);
    });
  });

  describe('MUST-13.11 / MUST-11.16: manual assign', () => {
    it('allows a second loan on the same transaction and refuses a second link to the same loan', () => {
      const car = seedLoan({ name: 'Car', balanceCents: 2_000_000 });
      const boat = seedLoan({ name: 'Boat', balanceCents: 500_000 });
      const txnId = spend('COMBINED PAYMENT', -60_000);
      expect(assignTransactionToLoan({ txnId, itemId: car.itemId })).toEqual({ linked: true, appliedCents: 60_000 });
      expect(assignTransactionToLoan({ txnId, itemId: car.itemId })).toEqual({ linked: false, appliedCents: 0 });
      expect(assignTransactionToLoan({ txnId, itemId: boat.itemId })).toEqual({ linked: true, appliedCents: 60_000 });
    });

    it('does not require a negative amount — a disbursement or an adjustment may be recorded', () => {
      const { itemId } = seedLoan({ balanceCents: 2_000_000 });
      const txnId = spend('LOAN DISBURSEMENT', 60_000);
      expect(assignTransactionToLoan({ txnId, itemId }).linked).toBe(true);
    });
  });
  ```

- [ ] **Write `tests/lib/loans/backfill.test.ts` (§19.6).**
  ```ts
  describe('MUST-13.9 / MUST-13.10 / MUST-14.12: the backfill', () => {
    it('is off by default — saveLoanRule alone links nothing', () => {
      const { itemId } = seedLoan({ balanceCents: 2_000_000 });
      spend('HONDA FIN SVC', -45_000, { date: '2026-02-01' });
      saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
      expect(balanceOf(itemId)).toBe(2_000_000);
      expect(t.sqlite.prepare('select count(*) as n from loan_payments').get()).toEqual({ n: 0 });
    });

    it('links only inside the 365-day window and reports the count and the total applied', () => {
      const { itemId } = seedLoan({ balanceCents: 2_000_000 });
      spend('HONDA FIN SVC', -45_000, { date: '2026-02-01' });
      spend('HONDA FIN SVC', -45_000, { date: '2026-05-01' });
      spend('HONDA FIN SVC', -45_000, { date: '2024-01-01' }); // outside the window
      const ruleId = saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
      expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') })).toEqual({
        linked: 2,
        appliedCents: 90_000,
      });
      expect(balanceOf(itemId)).toBe(1_910_000);
    });

    it('stops at LOAN_BACKFILL_MAX', () => {
      const { itemId } = seedLoan({ balanceCents: 100_000_000 });
      for (let i = 0; i < LOAN_BACKFILL_MAX + 10; i += 1) spend('HONDA FIN SVC', -100, { date: '2026-05-01' });
      const ruleId = saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
      expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') }).linked).toBe(LOAN_BACKFILL_MAX);
    });

    it('the sixth backfill in a window is refused, and the bucket is global', () => {
      let now = 1_000_000;
      setLoanRateLimitClockForTests(() => now);
      resetLoanRateLimitsForTests();
      for (let i = 0; i < BACKFILL_MAX_GLOBAL; i += 1) expect(checkLoanBackfill().allowed).toBe(true);
      expect(checkLoanBackfill().allowed).toBe(false);
      now += BACKFILL_WINDOW_MS + 1;
      expect(checkLoanBackfill().allowed).toBe(true);
      setLoanRateLimitClockForTests(null);
    });
  });
  ```

- [ ] **Run the loan suites and every suite whose file this task touched.**
  ```powershell
  npx vitest run tests/lib/loans tests/lib/import tests/lib/categorize/engine.test.ts tests/lib/transactions.test.ts tests/lib/simplefin
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Commit.**
  ```powershell
  git add src/lib/loans.ts src/lib/import src/lib/simplefin src/lib/transactions.ts src/lib/categorize/engine.ts tests/lib/loans tests/lib
  git commit -m "feat(loans): the matcher, the manual links and the exact reversal

The rule path creates at most ONE link per transaction, ever - a skip on any
existing link plus first-rule-by-id-wins - so two loans matching one merchant
string cannot each take the full payment off their balance (MUST-13.4). The
unique index IS the idempotency guard and the decrement runs conditional on
changes > 0, so a crash between deciding and recording is impossible
(MUST-11.15). applied_cents records the clamped figure, which is what makes
unassign and import-undo restore the balance exactly in every clamping case
(MUST-11.14). applyLoanMatchers never throws into its caller and bails on its
first query when no loan rules exist, which is the loans-side dormancy bail
(MUST-13.5, AC5). Five call sites and no others, including confirmCategory's
idempotent early return, so re-confirming a row is always a way to fix a missed
assignment (MUST-13.7/13.8). undoImport reverses BEFORE the delete, because a
cascade cannot restore a balance (MUST-13.14). Nothing here touches the
transactions table: loan payments stay in their category and in every budget
(MUST-13.2)."
  ```

<!-- END TASK 10 -->

---

## Task 11: The loan fieldset, the matcher-rule editor and the transactions row control

**Context:** Spec §14 in full. Implements **MUST-14.1 … MUST-14.14**, **MUST-11.8**'s UI half (the anchor is written in exactly one place), **MUST-13.13**, and §19.7's action and client tests.

**Files:**
- Modify: `src/app/(app)/warranties/new/new-warranty-client.tsx` (the Loan fieldset)
- Modify: `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` (the Loan fieldset in `EditForm`, the read-only money block, the Payment matching sub-card)
- Modify: `src/app/(app)/warranties/[id]/page.tsx` (pass `rules` and `accounts`)
- Modify: `src/app/(app)/warranties/actions.ts` (three loan readers; `saveLoanRuleAction`; `deleteLoanRuleAction`; `revalidateAll`)
- Modify: `src/app/(app)/transactions/transactions-client.tsx` (the last cell gains the loan control)
- Modify: `src/app/(app)/transactions/page.tsx` (`loanOptions`, `loanLinks`)
- Modify: `src/app/(app)/transactions/actions.ts` (`assignToLoanAction`, `unassignFromLoanAction`)
- Modify: `src/components/icons.tsx` (`LoanIcon`)
- Create: `src/components/LoanProgressBar.tsx` — **created here, not in Task 12**, because the detail page's read-only money block below is its first consumer. Task 12's `LoansCard` is its second.
- Test: `tests/app/warranties-actions.test.ts`, `tests/app/transactions-actions.test.ts`, `tests/app/transactions-client.test.tsx`, `tests/app/warranty-detail-client.test.tsx`, `tests/app/new-warranty-client.test.tsx` (append to each)

**Interfaces:**
- Consumes: `listLoanRules`, `saveLoanRule`, `deleteLoanRule`, `backfillLoanRule`, `checkLoanBackfill`, `MAX_RULES_PER_LOAN`, `assignTransactionToLoan`, `unassignTransactionFromLoan`, `loanLinksForTransactions`, `listLoans` from `@/lib/loans`; `loanFieldsAllowedForKind`, `billingAmountLabelForKind`, `billingSectionLabelForKind`, `billingCycleSuffixForKind` from `@/lib/warranty/constants`; `parseAmountToCents`, `formatCents` from `@/lib/money`.
- Produces:
  ```ts
  // src/app/(app)/warranties/actions.ts
  export async function saveLoanRuleAction(_prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState>;
  export async function deleteLoanRuleAction(formData: FormData): Promise<WarrantyActionState>;

  // src/app/(app)/transactions/actions.ts
  export async function assignToLoanAction(formData: FormData): Promise<ActionState>;
  export async function unassignFromLoanAction(formData: FormData): Promise<ActionState>;
  ```

### Steps

- [ ] **Add `LoanIcon` to `src/components/icons.tsx`, in the Navigation section beside `WarrantiesIcon`.**
  ```tsx
  export function LoanIcon(props: IconProps) {
    return (
      <Glyph {...props}>
        <path d="M3 7.5h18v9H3z" />
        <path d="M12 14.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z" />
        <path d="M6.5 10.2v3.6M17.5 10.2v3.6" />
      </Glyph>
    );
  }
  ```

- [ ] **Add the three loan readers and the two rule actions to `src/app/(app)/warranties/actions.ts` (MUST-14.4, MUST-14.7, MUST-14.11, MUST-14.14).** The readers sit beside the existing `readPriceCents` / `readBillingAmountCents`:
  ```ts
  /** '' -> null; anything else must parse as money, as a non-negative magnitude, same as price. */
  function readPrincipalCents(formData: FormData): number | null {
    const raw = str(formData, 'principal').trim();
    if (raw.length === 0) return null;
    const cents = parseAmountToCents(raw);
    if (cents === null) throw new Error('The original amount is not a number.');
    return Math.abs(cents);
  }

  /**
   * MUST-14.4: parsed as a decimal PERCENT and stored as BASIS POINTS -- 5.49% is 549. The
   * 0-10000% range is checked here, in zod, and again by the CHECK in 0007.
   * MUST-13.1: this is the only arithmetic the rate is ever subject to, and it is a unit
   * conversion at the form boundary, not a calculation.
   */
  function readInterestRateBps(formData: FormData): number | null {
    const raw = str(formData, 'interestRate').trim();
    if (raw.length === 0) return null;
    const percent = Number(raw);
    if (!Number.isFinite(percent)) throw new Error('The interest rate is not a number.');
    if (percent < 0 || percent > 10_000) throw new Error('That rate is out of range.');
    return Math.round(percent * 100);
  }

  function readBalanceCents(formData: FormData): number | null {
    const raw = str(formData, 'currentBalance').trim();
    if (raw.length === 0) return null;
    const cents = parseAmountToCents(raw);
    if (cents === null) throw new Error('The balance is not a number.');
    return Math.abs(cents);
  }
  ```
  `readItemInput` gains the four fields. **MUST-14.2 / MUST-11.8: this is the ONLY place `balanceUpdatedAt` is ever written** — a non-empty balance sets both, an empty one sets both to NULL:
  ```ts
      principalCents: readPrincipalCents(formData),
      interestRateBps: readInterestRateBps(formData),
      currentBalanceCents: balanceCents,
      // MUST-11.8: the HUMAN anchor. Written here and NOWHERE else -- never by a matched
      // payment, never by an unassign, never by an import undo. It answers "when did a person
      // last tell us the truth about this balance", which is exactly the question the debt
      // reconstruction needs.
      balanceUpdatedAt: balanceCents === null ? null : nowIso(),
  ```
  with `const balanceCents = readBalanceCents(formData);` hoisted above the `safeParse` call, and `nowIso` imported from `@/lib/clock`.

  The two rule actions, following the fixed house order:
  ```ts
  const RULE_TOO_SHORT = 'Use at least three characters, or this will match almost everything.';
  const RULE_LIMIT = 'Five rules per loan is the limit.';
  const RULE_DUPLICATE = 'That rule already exists on this loan.';

  const loanRuleSchema = z.object({
    itemId: z.coerce.number().int().positive(),
    merchantContains: z.string().trim().min(3, RULE_TOO_SHORT).max(120),
    accountId: z.coerce.number().int().positive().nullable(),
    backfill: z.boolean(),
  });

  export async function saveLoanRuleAction(_prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState> {
    if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
    await requireUser();

    const accountRaw = str(formData, 'accountId').trim();
    const parsed = loanRuleSchema.safeParse({
      itemId: str(formData, 'itemId'),
      merchantContains: str(formData, 'merchantContains'),
      accountId: accountRaw.length === 0 ? null : accountRaw,
      backfill: formData.get('backfill') !== null,
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that rule.' };

    const item = getWarrantyItem(parsed.data.itemId);
    if (!item) return { error: 'That item no longer exists.' };
    if (item.kind !== 'loan') return { error: 'Payment matching only applies to loans.' };
    if (listLoanRules(item.id).length >= MAX_RULES_PER_LOAN) return { error: RULE_LIMIT };

    let ruleId: number;
    try {
      ruleId = saveLoanRule({
        itemId: parsed.data.itemId,
        merchantContains: parsed.data.merchantContains,
        accountId: parsed.data.accountId,
        enabled: true,
      });
    } catch (error) {
      // MUST-14.7: the unique index's message, translated beside the existing FK translation.
      if (error instanceof BetterSqlite3.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { error: RULE_DUPLICATE };
      }
      return failure(error, 'Could not save that rule.');
    }

    let message = 'Rule saved. It will apply to payments that arrive from now on.';
    if (parsed.data.backfill) {
      // MUST-14.12: the ONE loan action with a limit, and the rule is still saved when it is
      // refused -- only the historical pass is skipped.
      const verdict = checkLoanBackfill();
      if (!verdict.allowed) {
        message = 'Rule saved, but the backfill was skipped: too many in the last few minutes.';
      } else {
        const { linked, appliedCents } = backfillLoanRule(ruleId);
        message = `Rule saved. ${linked} past payments linked, ${formatCents(appliedCents)} taken off the balance.`;
      }
    }
    revalidateAll(parsed.data.itemId);
    return { message };
  }

  export async function deleteLoanRuleAction(formData: FormData): Promise<WarrantyActionState> {
    if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
    await requireUser();
    const parsed = z
      .object({ id: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() })
      .safeParse({ id: formData.get('id'), itemId: formData.get('itemId') });
    if (!parsed.success) return { error: 'Invalid request.' };
    if (!deleteLoanRule(parsed.data.id)) return { error: 'That rule no longer exists.' };
    revalidateAll(parsed.data.itemId);
    return { message: 'Rule removed. Payments already linked are untouched.' };
  }
  ```
  and `revalidateAll` gains the two paths (MUST-14.14 — **a rule save can move a balance that both pages render**):
  ```ts
  function revalidateAll(itemId?: number): void {
    revalidatePath('/warranties');
    revalidatePath('/dashboard');
    revalidatePath('/transactions');
    revalidatePath('/reports');
    if (itemId !== undefined) revalidatePath(`/warranties/${itemId}`);
  }
  ```

- [ ] **Add the two transaction actions to `src/app/(app)/transactions/actions.ts` (MUST-14.10, MUST-14.11, MUST-13.13).**
  ```ts
  const loanLinkSchema = z.object({
    transactionId: z.coerce.number().int().positive(),
    itemId: z.coerce.number().int().positive(),
  });

  /**
   * MUST-13.13: nothing is derived from the client but txnId and itemId, both zod-validated as
   * positive integers and both existence-checked server-side. Warranty items are
   * household-shared with owner_user_id as attribution only, so any signed-in user may assign
   * a transaction to any loan -- the same posture the existing warranty actions take, and a
   * deliberate consistency rather than an oversight.
   *
   * MUST-14.12: no rate limit, consistent with every existing warranty and transaction action.
   */
  export async function assignToLoanAction(formData: FormData): Promise<ActionState> {
    if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
    await requireUser();
    const parsed = loanLinkSchema.safeParse({
      transactionId: formData.get('transactionId'),
      itemId: formData.get('itemId'),
    });
    if (!parsed.success) return { error: 'Invalid request.' };

    let result: { linked: boolean; appliedCents: number };
    try {
      result = assignTransactionToLoan({ txnId: parsed.data.transactionId, itemId: parsed.data.itemId });
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not assign that transaction.' };
    }
    revalidatePath('/transactions');
    revalidatePath('/dashboard');
    revalidatePath('/reports');
    if (!result.linked) return { message: 'That transaction is already linked to this loan.' };

    // MUST-14.10: over-linking SUCCEEDS and warns. A refusal here would block a legitimate
    // combined payment; silence would hide a typo.
    const txn = getTransaction(parsed.data.transactionId);
    const links = loanLinksForTransactions([parsed.data.transactionId]).get(parsed.data.transactionId) ?? [];
    const linked = links.reduce((sum, link) => sum + link.amountCents, 0);
    if (txn !== null && linked > Math.abs(txn.amountCents)) {
      return { message: 'Assigned. Note that this transaction is now linked to more than its own amount.' };
    }
    return { message: 'Assigned.' };
  }

  export async function unassignFromLoanAction(formData: FormData): Promise<ActionState> {
    if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
    await requireUser();
    const parsed = loanLinkSchema.safeParse({
      transactionId: formData.get('transactionId'),
      itemId: formData.get('itemId'),
    });
    if (!parsed.success) return { error: 'Invalid request.' };
    if (!unassignTransactionFromLoan({ txnId: parsed.data.transactionId, itemId: parsed.data.itemId })) {
      return { error: 'That transaction is not linked to this loan.' };
    }
    revalidatePath('/transactions');
    revalidatePath('/dashboard');
    revalidatePath('/reports');
    return { message: 'Unassigned. The balance has gone back up by exactly what came off it.' };
  }
  ```

- [ ] **Add the Loan fieldset to both item forms (MUST-14.1).** It follows the live-kind pattern already in place: keyed off `selectedKind`, with a `useEffect` clearing its state when the kind moves away from `loan`, exactly as the billing pair's does today. Sits **after** the existing billing pair and **before** the term fieldset, inside the same `grid gap-4 sm:grid-cols-2`. Identical in `new-warranty-client.tsx` and in `warranty-detail-client.tsx`'s `EditForm`, except that the detail form seeds its state from the item.
  ```tsx
  const [principal, setPrincipal] = useState('');
  const [interestRate, setInterestRate] = useState('');
  const [currentBalance, setCurrentBalance] = useState('');
  const loanApplicable = loanFieldsAllowedForKind(selectedKind);
  useEffect(() => {
    if (!loanApplicable) {
      setPrincipal('');
      setInterestRate('');
      setCurrentBalance('');
    }
  }, [loanApplicable]);
  ```
  ```tsx
  {/* MUST-14.1: rendered exactly when the SELECTED type's kind is 'loan'. Hidden entirely
      otherwise, so an absent field posts as blank -> null, the same mechanism every other
      optional field on this form uses. */}
  {loanApplicable ? (
    <>
      <Field label="Original amount" hint="What you borrowed. Used for the payoff bar.">
        <input
          name="principal"
          inputMode="decimal"
          placeholder="e.g. 28000.00"
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="Interest rate" hint="Shown for reference only — this app does no interest math.">
        <span className="flex items-center gap-2">
          <input
            name="interestRate"
            inputMode="decimal"
            placeholder="e.g. 5.49"
            value={interestRate}
            onChange={(e) => setInterestRate(e.target.value)}
            className={`${inputClass} w-28`}
          />
          <span className="text-sm text-muted">%</span>
        </span>
      </Field>
      <Field label="Balance still owed" hint="Today's balance. Payments you link will take it down from here.">
        <input
          name="currentBalance"
          inputMode="decimal"
          placeholder="e.g. 19550.00"
          value={currentBalance}
          onChange={(e) => setCurrentBalance(e.target.value)}
          className={inputClass}
        />
      </Field>
    </>
  ) : null}
  ```
  Both forms' **billing** labels are re-routed through the kind matrix (MUST-12.3): `<Field label={billingSectionLabelForKind(selectedKind)}>` and `<Field label={billingAmountLabelForKind(selectedKind)}>`.

- [ ] **Write `src/components/LoanProgressBar.tsx` (MUST-15.3).** It is created here because the detail page below is its first consumer; Task 12's `LoansCard` imports the same component.
  ```tsx
  /**
   * MUST-15.3: a SEPARATE component rather than a reuse of BudgetProgressBar, whose colour
   * mapping is a WARNING SYSTEM -- green under, amber past 80%, red over. Here more progress is
   * unambiguously good, and bending that component would mean a car loan 85% paid off rendering
   * amber. The track markup is copied; the tone logic is not, because the tone logic is the part
   * that is wrong for this use. The fill is bg-positive-solid throughout, with no warning band.
   */
  export function LoanProgressBar({ fraction, label }: { fraction: number; label: string }) {
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    return (
      <div
        role="progressbar"
        aria-label={`${label} paid off`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
      >
        <div
          style={{ width: `${pct}%` }}
          className="h-full rounded-full bg-positive-solid transition-[width] duration-300 ease-out"
        />
      </div>
    );
  }
  ```

- [ ] **Add the read-only money block to the detail page (MUST-14.3).** Every row is omitted when its value is null; the whole block is omitted when `currentBalanceCents` and `principalCents` are both null. `payoffFraction`, `lastPaymentAt` and `paymentCount` come from the page's own `listLoans().find((loan) => loan.itemId === item.id)` lookup, added to `warranties/[id]/page.tsx` alongside `rules` and `accounts`.
  ```tsx
  {item.currentBalanceCents === null && item.principalCents === null ? null : (
    <div className="flex flex-col gap-3">
      {item.currentBalanceCents === null ? null : (
        <>
          <p className="money-lg">{formatCents(item.currentBalanceCents)}</p>
          {/* MUST-11.8: "You set this on" and "Last payment" are labelled DIFFERENTLY, because
              they answer different questions. balance_updated_at is the human anchor. */}
          {item.balanceUpdatedAt === null ? null : (
            <p className="text-sm text-subtle">You set this on {item.balanceUpdatedAt.slice(0, 10)}</p>
          )}
        </>
      )}
      {payoffFraction === null ? null : <LoanProgressBar fraction={payoffFraction} label={item.name} />}
      {item.principalCents === null ? null : <Detail label="Original">{formatCents(item.principalCents)}</Detail>}
      {item.interestRateBps === null ? null : (
        <Detail label="Rate">{(item.interestRateBps / 100).toFixed(2)}%</Detail>
      )}
      {item.billingCycle === null || item.billingAmountCents === null ? null : (
        <Detail label="Payment">
          {formatCents(item.billingAmountCents)} {billingCycleSuffixForKind(item.kind, item.billingCycle)}
        </Detail>
      )}
      {lastPaymentAt === null ? null : <Detail label="Last payment">{lastPaymentAt.slice(0, 10)}</Detail>}
      {paymentCount === 0 ? null : <Detail label="Payments linked">{paymentCount}</Detail>}
    </div>
  )}
  ```

- [ ] **Add the Payment matching sub-card to the detail page, loan-kind only (MUST-14.5, MUST-14.6, MUST-13.9).**
  ```tsx
  {item.kind !== 'loan' ? null : (
    <Card>
      <CardHeader title="Payment matching" />
      <CardBody className="flex flex-col gap-4">
        {/* MUST-14.6: MUST-13.2, stated where the person is making the decision rather than
            only in the spec. Always visible, above the table. */}
        <p className="text-sm text-muted">
          When a transaction&apos;s merchant contains this text, the app treats it as a payment on this loan and takes
          it off the balance. The payment still counts in your budget and in your reports.
        </p>
        {rules.length === 0 ? null : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Merchant contains</th>
                <th scope="col">Account</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="font-medium text-ink">{rule.merchantContains}</td>
                  <td className="text-muted">
                    {rule.accountId === null ? 'Any account' : (accounts.find((a) => a.id === rule.accountId)?.name ?? 'Any account')}
                  </td>
                  <td className="text-right">
                    <form action={removeRule}>
                      <input type="hidden" name="id" value={rule.id} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <SubmitButton className="btn btn--ghost btn--sm">Remove</SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        <form action={addRule} className="flex flex-col gap-3">
          <input type="hidden" name="itemId" value={item.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Merchant contains">
              <input name="merchantContains" className={inputClass} placeholder="e.g. HONDA FIN" />
            </Field>
            <Field label="Account">
              <select name="accountId" className={selectClass} defaultValue="">
                <option value="">Any account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {/* MUST-13.9: UNCHECKED by default, and the hint says which case is which. A person
              types today's balance and then saves a rule; back-filling a year of payments
              would subtract them all from a figure that already accounts for them. */}
          <label className="flex items-start gap-2 text-sm text-muted">
            <input type="checkbox" name="backfill" className="mt-1" />
            <span>
              Also link matching payments from the last 12 months
              <span className="field-hint block">
                Only tick this if the balance you typed is the balance from before those payments. Ticking it will
                subtract every payment it finds.
              </span>
            </span>
          </label>
          <FormError message={ruleState.error} />
          {ruleState.message === undefined ? null : <Notice tone="success">{ruleState.message}</Notice>}
          <SubmitButton className="btn btn--primary self-start">Add rule</SubmitButton>
        </form>
      </CardBody>
    </Card>
  )}
  ```

- [ ] **Add the transactions row control (MUST-14.8, MUST-14.9).** `transactions/page.tsx` gains two props — **when `loanOptions` is empty the whole control is absent, so a household with no loans sees the transactions page exactly as it is today**:
  ```tsx
      loanOptions={listLoans()
        .filter((loan) => loan.currentBalanceCents !== null)
        .map((loan) => ({ id: loan.itemId, name: loan.name }))}
      loanLinks={Object.fromEntries(loanLinksForTransactions(page.rows.map((row) => row.id)))}
  ```
  and `transactions-client.tsx`'s last cell — the one that currently holds `Create warranty` — gains, beneath it:
  ```tsx
  {/* MUST-14.8: a transfer never carries a loan control, and neither does a page that was
      given no loans. The established precedent for a per-row action is the link above. */}
  {row.isTransfer || loanOptions.length === 0 ? null : (loanLinks[row.id] ?? []).length > 0 ? (
    <span className="flex items-center gap-1.5">
      <span className="text-xs text-muted">{loanLinks[row.id]![0]!.itemName}</span>
      <form action={unassignLoan}>
        <input type="hidden" name="transactionId" value={row.id} />
        <input type="hidden" name="itemId" value={loanLinks[row.id]![0]!.itemId} />
        <SubmitButton className="btn btn--ghost btn--sm">Unassign</SubmitButton>
      </form>
    </span>
  ) : (
    <form action={assignLoan} className="flex items-center gap-1.5">
      <input type="hidden" name="transactionId" value={row.id} />
      <select name="itemId" defaultValue="" aria-label={`Assign transaction ${row.id} to a loan`} className={rowControl}>
        <option value="">Assign to loan…</option>
        {loanOptions.map((loan) => (
          <option key={loan.id} value={loan.id}>{loan.name}</option>
        ))}
      </select>
      <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">Assign</button>
    </form>
  )}
  ```

- [ ] **Append the tests (§19.7).**
  ```ts
  // tests/app/warranties-actions.test.ts
  describe('MUST-14.4 / MUST-14.7 / MUST-14.14: the loan readers and the rule actions', () => {
    it('the three readers parse and round-trip, and the rate becomes basis points', async () => {
      await actions.createWarrantyAction({}, form({ ...loanForm, principal: '28,000.00', interestRate: '5.49', currentBalance: '$19,550.00' }));
      const item = latestItem();
      expect(item.principalCents).toBe(2_800_000);
      expect(item.interestRateBps).toBe(549);
      expect(item.currentBalanceCents).toBe(1_955_000);
      // MUST-14.2 / MUST-11.8: the anchor is written here, and only here.
      expect(item.balanceUpdatedAt).not.toBeNull();
    });

    it('an empty balance sets BOTH the balance and the anchor to null', async () => {
      await actions.createWarrantyAction({}, form({ ...loanForm, currentBalance: '' }));
      const item = latestItem();
      expect(item.currentBalanceCents).toBeNull();
      expect(item.balanceUpdatedAt).toBeNull();
    });

    it('both rule actions reject a cross-origin request first', async () => {
      sameOrigin.value = false;
      expect((await actions.saveLoanRuleAction({}, form({ itemId: '1', merchantContains: 'HONDA' }))).error).toBe(CROSS_ORIGIN_ERROR);
      expect((await actions.deleteLoanRuleAction(form({ id: '1', itemId: '1' }))).error).toBe(CROSS_ORIGIN_ERROR);
    });

    it('refuses fewer than three characters, the sixth rule, and a duplicate — each with its fixed wording', async () => {
      const itemId = seedLoanItem();
      expect((await actions.saveLoanRuleAction({}, form({ itemId: String(itemId), merchantContains: 'HO' }))).error).toBe(
        'Use at least three characters, or this will match almost everything.',
      );
      for (let i = 0; i < MAX_RULES_PER_LOAN; i += 1) {
        await actions.saveLoanRuleAction({}, form({ itemId: String(itemId), merchantContains: `RULE${i}` }));
      }
      expect((await actions.saveLoanRuleAction({}, form({ itemId: String(itemId), merchantContains: 'ONEMORE' }))).error).toBe(
        'Five rules per loan is the limit.',
      );
      const second = seedLoanItem();
      await actions.saveLoanRuleAction({}, form({ itemId: String(second), merchantContains: 'HONDA FIN' }));
      expect((await actions.saveLoanRuleAction({}, form({ itemId: String(second), merchantContains: 'HONDA FIN' }))).error).toBe(
        'That rule already exists on this loan.',
      );
    });

    it('MUST-14.14: revalidateAll covers /transactions and /reports', async () => {
      const itemId = seedLoanItem();
      revalidated.length = 0;
      await actions.saveLoanRuleAction({}, form({ itemId: String(itemId), merchantContains: 'HONDA FIN' }));
      expect(revalidated).toContain('/transactions');
      expect(revalidated).toContain('/reports');
    });
  });
  ```
  ```ts
  // tests/app/transactions-actions.test.ts
  describe('MUST-14.8 … MUST-14.11: assign and unassign', () => {
    it('links and decrements; a second assign to the same loan is a reported no-op', async () => {
      const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
      expect((await actions.assignToLoanAction(form({ transactionId: String(txnId), itemId: String(itemId) }))).message).toBe('Assigned.');
      expect(balanceOf(itemId)).toBe(1_955_000);
      expect((await actions.assignToLoanAction(form({ transactionId: String(txnId), itemId: String(itemId) }))).message).toBe(
        'That transaction is already linked to this loan.',
      );
      expect(balanceOf(itemId)).toBe(1_955_000);
    });

    it('MUST-14.10: a second LOAN on the same transaction succeeds and warns', async () => {
      const { itemId: car, txnId } = seedLoanAndSpend(2_000_000, -45_000);
      const boat = seedLoanItem({ balanceCents: 500_000 });
      await actions.assignToLoanAction(form({ transactionId: String(txnId), itemId: String(car) }));
      const result = await actions.assignToLoanAction(form({ transactionId: String(txnId), itemId: String(boat) }));
      expect(result.message).toBe('Assigned. Note that this transaction is now linked to more than its own amount.');
      expect(result.error).toBeUndefined();
    });

    it('unassign restores exactly, and a nonexistent id is an error, not a 500', async () => {
      const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
      await actions.assignToLoanAction(form({ transactionId: String(txnId), itemId: String(itemId) }));
      await actions.unassignFromLoanAction(form({ transactionId: String(txnId), itemId: String(itemId) }));
      expect(balanceOf(itemId)).toBe(2_000_000);
      expect((await actions.assignToLoanAction(form({ transactionId: '999999', itemId: String(itemId) }))).error).toBe(
        'That transaction no longer exists.',
      );
    });

    it('both reject a cross-origin request first', async () => {
      sameOrigin.value = false;
      expect((await actions.assignToLoanAction(form({ transactionId: '1', itemId: '1' }))).error).toBe(CROSS_ORIGIN_ERROR);
      expect((await actions.unassignFromLoanAction(form({ transactionId: '1', itemId: '1' }))).error).toBe(CROSS_ORIGIN_ERROR);
    });
  });
  ```
  ```tsx
  // tests/app/transactions-client.test.tsx
  describe('MUST-14.8 / MUST-14.9: the row control', () => {
    it('with no loans, the assign control is absent entirely', () => {
      render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
      expect(screen.queryByText('Assign to loan…')).toBeNull();
      expect(screen.queryByText('Assign')).toBeNull();
    });

    it('an unlinked row renders the select; a linked row renders the name and Unassign', () => {
      render(
        <TransactionsClient
          {...baseProps}
          loanOptions={[{ id: 7, name: 'Civic' }]}
          loanLinks={{ [linkedRowId]: [{ id: 1, txnId: linkedRowId, itemId: 7, itemName: 'Civic', amountCents: 45000, appliedCents: 45000, source: 'manual' }] }}
        />,
      );
      expect(screen.getByText('Assign to loan…')).toBeTruthy();
      expect(screen.getByText('Civic')).toBeTruthy();
      expect(screen.getByText('Unassign')).toBeTruthy();
    });

    it('a transfer row renders neither control', () => {
      render(<TransactionsClient {...transferOnlyProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
      expect(screen.queryByText('Assign to loan…')).toBeNull();
    });
  });
  ```
  ```tsx
  // tests/app/warranty-detail-client.test.tsx and new-warranty-client.test.tsx
  describe('MUST-14.1 / MUST-14.5 / MUST-12.3: the loan surfaces', () => {
    it('the loan fieldset appears only for a loan-kind type and disappears live', () => {
      render(<NewWarrantyClient {...props} types={[subType, loanType]} />);
      expect(screen.queryByText('Balance still owed')).toBeNull();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: String(loanType.id) } });
      expect(screen.getByText('Balance still owed')).toBeTruthy();
      expect(screen.getByText('Shown for reference only — this app does no interest math.')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: String(subType.id) } });
      expect(screen.queryByText('Balance still owed')).toBeNull();
    });

    it('the billing labels read Payment / Payment amount / per month for a loan', () => {
      render(<NewWarrantyClient {...props} types={[subType, loanType]} />);
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: String(loanType.id) } });
      expect(screen.getByText('Payment')).toBeTruthy();
      expect(screen.getByText('Payment amount')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: String(subType.id) } });
      expect(screen.getByText('Billing')).toBeTruthy();
      expect(screen.getByText('Amount')).toBeTruthy();
    });

    it('MUST-14.5 / MUST-14.6: the Payment matching card is loan-only and states the budget rule', () => {
      render(<WarrantyDetailClient {...detailProps} item={{ ...loanItem, kind: 'loan' }} />);
      expect(screen.getByText('Payment matching')).toBeTruthy();
      expect(screen.getByText(/The payment still counts in your budget and in your reports\./)).toBeTruthy();
      cleanup();
      render(<WarrantyDetailClient {...detailProps} item={{ ...loanItem, kind: 'subscription' }} />);
      expect(screen.queryByText('Payment matching')).toBeNull();
    });
  });
  ```

- [ ] **Run the touched suites and the type-check.**
  ```powershell
  npx vitest run tests/app/warranties-actions.test.ts tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx tests/app/warranty-detail-client.test.tsx tests/app/new-warranty-client.test.tsx tests/app/warranties-client.test.tsx
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Commit.**
  ```powershell
  git add "src/app/(app)/warranties" "src/app/(app)/transactions" src/components/icons.tsx tests/app
  git commit -m "feat(loans): the loan fieldset, the matcher editor and the assign control

The Loan fieldset follows the live-kind pattern the billing pair already uses and
appears exactly when the SELECTED type is a loan. Submitting a non-empty balance
writes current_balance_cents AND balance_updated_at; submitting it empty sets both
to null - and this is the ONLY place the anchor is ever written, which is what
makes the debt reconstruction well-defined (MUST-14.2/11.8). The Payment matching
card states MUST-13.2 where the person is making the decision, and the backfill
checkbox is unchecked by default with a hint naming both cases (MUST-13.9).
Over-linking a transaction succeeds and warns rather than refusing a legitimate
combined payment (MUST-14.10). With no loans the transactions page is byte-for-
byte what it is today (MUST-14.9). revalidateAll now covers /transactions and
/reports, because a rule save can move a balance both pages render (MUST-14.14)."
  ```

<!-- END TASK 11 -->

---

## Task 12: The read model, the dashboard Loans card and the debt-over-time report

**Context:** Spec §15's presentation half. Implements **MUST-15.1 … MUST-15.3** and **MUST-15.5 … MUST-15.9**, plus §19.6's `debt-over-time.test.ts`. (**MUST-15.4**'s `payoffFraction` / `nextPaymentDate` derivations and their `summary.test.ts` landed in Task 10 with `listLoans`, and `LoanProgressBar` in Task 11 with its first consumer.) This adds the codebase's **first line chart**, and the reconstruction is defined clause by clause because a chart that plots a total over a shifting subset of loans lies about a trend, which is the one thing a trend chart must not do.

**Files:**
- Modify: `src/lib/loans.ts` (append `DebtPoint` and `debtOverTime` — `LoanSummary` / `listLoans` / `loansTotalOwedCents` landed in Task 10, because Task 11 consumes them)
- Create: `src/components/LoansCard.tsx`, `src/components/charts/DebtTrendChart.tsx` (`LoanProgressBar.tsx` was created in Task 11, whose detail page is its first consumer)
- Modify: `src/app/(app)/dashboard/page.tsx` (one `<LoansCard />`)
- Modify: `src/app/(app)/reports/page.tsx` + `reports-client.tsx` (the Debt over time card)
- Test: `tests/lib/loans/summary.test.ts`, `tests/lib/loans/debt-over-time.test.ts`, `tests/app/loans-card.test.tsx` (**all new**)

**Interfaces:**
- Consumes: `addMonths`, `addMonthsClamped`, `monthEnd`, `monthOf`, `monthRange`, `todayIso` from `@/lib/dates`; `formatCents` from `@/lib/money`; `AXIS_TICK`, `CHART_GRID`, `TOOLTIP_CURSOR`, `tooltipStyles` from `@/components/charts/chart-theme`; `Card`/`CardBody`/`CardHeader`, `EmptyState`, `LoanIcon`.
- Produces:
  ```ts
  export interface DebtPoint { month: string; owedCents: number | null }
  export function debtOverTime(months: number, opts?: { endMonth?: string; today?: string }): DebtPoint[];

  export function LoansCard(props: { loans: LoanSummary[]; totalOwedCents: number }): React.ReactElement | null;
  export function DebtTrendChart(props: { data: DebtPoint[] }): React.ReactElement;
  ```

### Steps

- [ ] **Append the debt reconstruction to `src/lib/loans.ts`.** Add `addMonths`, `monthEnd`, `monthOf` and `monthRange` to the `@/lib/dates` import (`addMonthsClamped` and `todayIso` are already there from Task 10).
  ```ts
  export interface DebtPoint {
    month: string;
    owedCents: number | null;
  }

  /**
   * MUST-15.7: the reconstruction, exactly. One point per calendar month, oldest first. For a
   * month whose last day is E, each loan L contributes:
   *   - E < date(L.created_at)                      -> 0        (the loan did not exist)
   *   - L.current_balance_cents IS NULL, or
   *     L.balance_updated_at IS NULL                -> 0        (no balance is being tracked)
   *   - E < date(L.balance_updated_at)              -> UNKNOWN  (a person typed a balance after
   *       this month, which discarded whatever it was before; anything plotted here would be
   *       invented)
   *   - otherwise -> L.current_balance_cents + SUM(applied_cents) over rows with created_at > E
   *
   * The month's owedCents is the sum UNLESS any loan contributed unknown, in which case it is
   * null and the line breaks. A total that silently drops a loan for some months and includes
   * it for others is a chart that lies about a trend.
   *
   * MUST-15.9: the walk goes BACKWARDS from the present, never forwards from the principal. The
   * present balance is the one number a person has verified; the principal is a figure from a
   * contract that may never have matched the first statement.
   *
   * MUST-15.8: TWO queries, then a fold in memory over the month axis produced by the existing
   * monthRange/addMonths helpers -- the same pair cashflowTrend uses. No per-month query, no N+1.
   */
  export function debtOverTime(months: number, opts: { endMonth?: string; today?: string } = {}): DebtPoint[] {
    const today = opts.today ?? todayIso();
    const endMonth = opts.endMonth ?? monthOf(today);
    const keys = monthRange(addMonths(endMonth, -(months - 1)), endMonth);

    const loans = getDb()
      .select({
        itemId: warrantyItems.id,
        createdAt: warrantyItems.createdAt,
        balanceCents: warrantyItems.currentBalanceCents,
        anchorAt: warrantyItems.balanceUpdatedAt,
      })
      .from(warrantyItems)
      .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
      .where(eq(warrantyItemTypes.kind, 'loan'))
      .all();
    if (loans.length === 0) return keys.map((month) => ({ month, owedCents: null }));

    const applied = getDb()
      .select({
        itemId: loanPayments.itemId,
        month: sql<string>`substr(${loanPayments.createdAt}, 1, 7)`,
        total: sql<number>`sum(${loanPayments.appliedCents})`,
      })
      .from(loanPayments)
      .groupBy(loanPayments.itemId, sql`substr(${loanPayments.createdAt}, 1, 7)`)
      .all();

    const byItem = new Map<number, Map<string, number>>();
    for (const row of applied) {
      const inner = byItem.get(row.itemId) ?? new Map<string, number>();
      inner.set(row.month, (inner.get(row.month) ?? 0) + (row.total ?? 0));
      byItem.set(row.itemId, inner);
    }

    return keys.map((month) => {
      const end = monthEnd(month);
      let total = 0;
      for (const loan of loans) {
        if (end < loan.createdAt.slice(0, 10)) continue;
        if (loan.balanceCents === null || loan.anchorAt === null) continue;
        if (end < loan.anchorAt.slice(0, 10)) return { month, owedCents: null };
        let owed = loan.balanceCents;
        for (const [paymentMonth, cents] of byItem.get(loan.itemId) ?? []) {
          // "created_at > E" is the whole of every LATER month, since E is a month end.
          if (paymentMonth > month) owed += cents;
        }
        total += owed;
      }
      return { month, owedCents: total };
    });
  }
  ```

- [ ] **Write `src/components/LoansCard.tsx` (MUST-15.1, MUST-15.2).** It imports the `LoanProgressBar` Task 11 created.
  ```tsx
  import { formatCents } from '@/lib/money';
  import type { LoanSummary } from '@/lib/loans';
  import { Card, CardHeader } from '@/components/ui/Card';
  import { LoanProgressBar } from '@/components/LoanProgressBar';

  /**
   * MUST-15.1: SELF-HIDING, in the manner of ExpiringSoonCard. The dashboard renders it
   * unconditionally; a household with no loans sees no card and no gap.
   */
  export function LoansCard({ loans, totalOwedCents }: { loans: LoanSummary[]; totalOwedCents: number }) {
    const shown = loans.filter((loan) => loan.currentBalanceCents !== null || loan.principalCents !== null);
    if (shown.length === 0) return null;

    return (
      <Card>
        <CardHeader title="Loans" description="What the household still owes." action={<span className="money-lg">{formatCents(totalOwedCents)}</span>} />
        <ul className="border-t border-line text-sm">
          {shown.map((loan) => (
            <li key={loan.itemId} className="flex flex-col gap-1.5 border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
              <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="font-medium text-ink">{loan.name}</span>
                <span className="money whitespace-nowrap">
                  {loan.currentBalanceCents === null ? '—' : formatCents(loan.currentBalanceCents)}
                </span>
              </span>
              {loan.payoffFraction === null ? null : <LoanProgressBar fraction={loan.payoffFraction} label={loan.name} />}
              <span className="flex flex-wrap gap-x-3 text-xs text-subtle">
                {loan.nextPaymentDate === null ? null : <span>Next payment {loan.nextPaymentDate}</span>}
                {loan.interestRateBps === null ? null : <span>Rate {(loan.interestRateBps / 100).toFixed(2)}%</span>}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    );
  }
  ```

- [ ] **Write `src/components/charts/DebtTrendChart.tsx` (MUST-15.5).**
  ```tsx
  'use client';

  import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
  import type { DebtPoint } from '@/lib/loans';
  import { AXIS_TICK, CHART_GRID, TOOLTIP_CURSOR, tooltipStyles } from './chart-theme';

  /**
   * The codebase's first line chart, modelled on CashflowChart's skeleton: same h-64, same
   * cents-to-dollars mapping, same theme imports, so it follows the theme toggle with no JS.
   *
   * The single series is var(--negative-solid) -- this is money owed -- and connectNulls is
   * FALSE so a gap in the data reads as a gap (MUST-15.7). A line that bridged an unknown month
   * would be inventing the very thing the reconstruction refuses to invent.
   */
  export function DebtTrendChart({ data }: { data: DebtPoint[] }) {
    const series = data.map((point) => ({
      month: point.month,
      Owed: point.owedCents === null ? null : point.owedCents / 100,
    }));
    return (
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...CHART_GRID} />
            <XAxis dataKey="month" {...AXIS_TICK} />
            <YAxis {...AXIS_TICK} width={64} />
            <Tooltip formatter={(value: number) => `$${value.toFixed(2)}`} cursor={TOOLTIP_CURSOR} {...tooltipStyles()} />
            <Line type="monotone" dataKey="Owed" stroke="var(--negative-solid)" strokeWidth={2} dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }
  ```

- [ ] **Render both (MUST-15.1, MUST-15.6).** `dashboard/page.tsx` gains the import, the two calls and the card **between `ExpiringSoonCard` and the budgets card**:
  ```tsx
        <ExpiringSoonCard items={expiring} today={today} />

        {/* MUST-15.1: self-hiding. Rendered unconditionally; absent when there is nothing to say. */}
        <LoansCard loans={listLoans(today)} totalOwedCents={loansTotalOwedCents()} />
  ```
  `reports/page.tsx` passes `debt={debtOverTime(24)}` and `hasLoans={listLoans().some((loan) => loan.currentBalanceCents !== null)}`, and `reports-client.tsx` gains the card using the same `EmptyState` / `CardBody` ternary its other cards use:
  ```tsx
  {!hasLoans ? null : (
    <Card>
      <CardHeader title="Debt over time" description="Total owed across every loan with a balance." />
      {debt.every((point) => point.owedCents === null) ? (
        <EmptyState icon={LoanIcon} title="Not enough history to draw a line yet">
          Record a balance on a loan and the line starts from that month.
        </EmptyState>
      ) : (
        <CardBody className="flex flex-col gap-3">
          <DebtTrendChart data={debt} />
          {/* MUST-15.6: always visible, because a reader is entitled to know where a line comes from. */}
          <p className="text-sm text-muted">
            The line starts when you first recorded a balance for each loan, and is reconstructed by adding back the
            payments you have linked since.
          </p>
        </CardBody>
      )}
    </Card>
  )}
  ```

- [ ] **`tests/lib/loans/summary.test.ts` was written in Task 10** alongside `listLoans`, since that is where the read model now lives. Re-run it here to confirm nothing in this task regressed it; do not duplicate it.

  For reference, the assertions it carries (§19.6):
  ```ts
  describe('MUST-15.4: payoffFraction and nextPaymentDate', () => {
    it('payoffFraction is null without a principal and at principal = 0', () => {
      expect(loanWith({ principalCents: null, currentBalanceCents: 100_000 }).payoffFraction).toBeNull();
      // A zero principal would divide by zero; null is the honest answer, not Infinity or 1.
      expect(loanWith({ principalCents: 0, currentBalanceCents: 100_000 }).payoffFraction).toBeNull();
      expect(loanWith({ principalCents: 100_000, currentBalanceCents: null }).payoffFraction).toBeNull();
    });

    it('is 0 at a full balance, 1 at zero, and clamped when a balance exceeds the principal', () => {
      expect(loanWith({ principalCents: 100_000, currentBalanceCents: 100_000 }).payoffFraction).toBe(0);
      expect(loanWith({ principalCents: 100_000, currentBalanceCents: 0 }).payoffFraction).toBe(1);
      expect(loanWith({ principalCents: 100_000, currentBalanceCents: 150_000 }).payoffFraction).toBe(0);
    });

    it('nextPaymentDate handles monthly, annual, a loan started on the 31st, and no cycle', () => {
      expect(loanWith({ startDate: '2026-01-15', billingCycle: 'monthly' }, '2026-08-18').nextPaymentDate).toBe('2026-09-15');
      expect(loanWith({ startDate: '2024-03-01', billingCycle: 'annual' }, '2026-08-18').nextPaymentDate).toBe('2027-03-01');
      // addMonthsClamped, so a January 31st start lands on February 28th rather than March 3rd.
      expect(loanWith({ startDate: '2026-01-31', billingCycle: 'monthly' }, '2026-02-01').nextPaymentDate).toBe('2026-02-28');
      expect(loanWith({ startDate: '2026-01-15', billingCycle: null }, '2026-08-18').nextPaymentDate).toBeNull();
    });

    it('is null past the payoff date — there is no next payment after the end', () => {
      expect(loanWith({ startDate: '2020-01-15', billingCycle: 'monthly', expiryDate: '2026-01-15' }, '2026-08-18').nextPaymentDate).toBeNull();
    });

    it('loansTotalOwedCents sums only non-null balances', () => {
      // two loans with balances and one without
      expect(loansTotalOwedCents()).toBe(2_455_000);
    });
  });
  ```

- [ ] **Write `tests/lib/loans/debt-over-time.test.ts` (§19.6, MUST-15.7 clause by clause).**
  ```ts
  describe('MUST-15.7: the reconstruction, clause by clause', () => {
    it('a month before the item existed contributes 0', () => {
      const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
      expect(series.find((p) => p.month === '2026-03')!.owedCents).toBe(0);
    });

    it('a month before balance_updated_at makes the whole point null', () => {
      // anchor set 2026-06-10; the balance before that was discarded.
      const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
      expect(series.find((p) => p.month === '2026-05')!.owedCents).toBeNull();
      expect(series.find((p) => p.month === '2026-06')!.owedCents).not.toBeNull();
    });

    it('a month after the anchor equals the balance plus the payments made since', () => {
      const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
      expect(series.find((p) => p.month === '2026-06')!.owedCents).toBe(1_955_000 + 45_000 + 45_000);
      expect(series.find((p) => p.month === '2026-08')!.owedCents).toBe(1_955_000);
    });

    it('two loans where one is unknown makes the whole point null, not a partial total', () => {
      // Second loan anchored in 2026-07.
      const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
      expect(series.find((p) => p.month === '2026-06')!.owedCents).toBeNull();
      expect(series.find((p) => p.month === '2026-07')!.owedCents).toBe(2_455_000);
    });

    it('a loan with no balance being tracked contributes 0 rather than unknown', () => {
      const series = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
      expect(series.every((p) => p.owedCents !== null)).toBe(true);
    });

    it('a direct balance edit today truncates the series — the older months become null', () => {
      updateBalance(itemId, 1_000_000, '2026-08-18T00:00:00.000Z');
      const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
      expect(series.slice(0, 5).every((p) => p.owedCents === null)).toBe(true);
      expect(series.at(-1)!.owedCents).toBe(1_000_000);
    });

    it('MUST-15.8: the whole series is computed from exactly TWO queries', () => {
      const before = queryCount();
      debtOverTime(24, { endMonth: '2026-08', today: '2026-08-18' });
      expect(queryCount() - before).toBe(2);
    });
  });
  ```

- [ ] **Write `tests/app/loans-card.test.tsx` (§19.7).**
  ```tsx
  describe('MUST-15.1 … MUST-15.3: the dashboard card', () => {
    it('renders nothing at all with no loans', () => {
      const { container } = render(<LoansCard loans={[]} totalOwedCents={0} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when every loan has neither a balance nor a principal', () => {
      const { container } = render(<LoansCard loans={[bare]} totalOwedCents={0} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders the total, one row per loan, and the payoff bar with the right aria-valuenow', () => {
      render(<LoansCard loans={[civic]} totalOwedCents={1_955_000} />);
      expect(screen.getByText('$19,550.00')).toBeTruthy();
      expect(screen.getByText('Civic')).toBeTruthy();
      expect(screen.getByText('Next payment 2026-09-15')).toBeTruthy();
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
      expect(screen.getByText('Rate 5.49%')).toBeTruthy();
    });

    it('omits the rate row when unset', () => {
      render(<LoansCard loans={[{ ...civic, interestRateBps: null }]} totalOwedCents={1_955_000} />);
      expect(screen.queryByText(/^Rate /)).toBeNull();
    });
  });
  ```

- [ ] **Run the new suites and the pages they touch.**
  ```powershell
  npx vitest run tests/lib/loans tests/app/loans-card.test.tsx tests/lib/reports.test.ts
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Commit.**
  ```powershell
  git add src/lib/loans.ts src/components "src/app/(app)/dashboard/page.tsx" "src/app/(app)/reports" tests
  git commit -m "feat(loans): the dashboard card and the debt-over-time line

LoansCard is self-hiding in the manner of ExpiringSoonCard, so a household with
no loans sees no card and no gap (MUST-15.1). DebtTrendChart is the codebase's
first line chart, modelled on CashflowChart's skeleton so it follows the theme
toggle with no JS.

debtOverTime walks BACKWARDS from the present, never forwards from the principal:
the present balance is the one number a person has verified (MUST-15.9). A month
where any loan's history is unknown plots NOTHING rather than a total over a
shifting subset, and connectNulls is false so the gap reads as a gap (MUST-15.7).
Two queries and an in-memory fold over the month axis, no N+1 (MUST-15.8)."
  ```

<!-- END TASK 12 -->

---

# Phase 4 — Ops, invariants and release

## Task 13: Compose, the workflow bumps, the Dockerfile directive and the five parked chores

**Context:** Spec §16 and §17 in full. Implements **MUST-16.1 … MUST-16.9**, **MUST-17.1 … MUST-17.8**, **AC9**, and the §16.3 half of **AC10**. Each chore is small; each is listed so none is lost. The egress-test amendments of §8.4 and MUST-8.9's `fetch()` allowlist land in **Task 14**, not here — see that task's note on the split.

**Files:**
- Modify: `install/synology-compose-pull.yml` (Watchtower to HTTP-API mode; two app env vars; the header rewritten)
- Modify: `tests/ops/release-image.test.ts` (the amended Watchtower assertions — AC9)
- Modify: `.github/workflows/release-image.yml` (`checkout@v4`→`@v5` in both jobs, `setup-node@v4`→`@v5`)
- Modify: `Dockerfile` (the parser directive and one explanatory sentence)
- Modify: `tests/ops/docker.test.ts` (MUST-17.3)
- Modify: `install/update.sh`, `install/update.ps1` (one copy line each)
- Modify: `INSTALL.md`, `docs/INSTALL-SYNOLOGY.md`
- Modify: `tests/ops/install.test.ts` (the §16.3 copy assertions only)
- Modify: `tests/app/notifications-actions.test.ts` (MUST-17.4, MUST-17.5, MUST-17.6)
- Modify: `src/app/(app)/settings/notifications/actions.ts` (MUST-17.7's dead re-check)
- Modify: `src/lib/notify/outbox.ts` (MUST-17.8's one comment)

### Steps

- [ ] **Rewrite the Watchtower service in `install/synology-compose-pull.yml` (MUST-16.1, MUST-16.2).** `WATCHTOWER_POLL_INTERVAL` is **removed**. **No `ports:` mapping is added, at any point, for any reason.**
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

- [ ] **Give the app service the two variables (MUST-16.3).** In the `budget-tracker` service's `environment:` block, after `DATA_DIR: /data`:
  ```yaml
        # In-app updates (v1.3.1). `watchtower` is the compose service name and resolves only on
        # this project's private network -- it is not an internet address, and the app refuses to
        # send this request to any host that is not a bare service label, localhost, or a private
        # IP literal. Both values are literal here and must match Watchtower's own, below.
        WATCHTOWER_URL: "http://watchtower:8080/v1/update"
        WATCHTOWER_TOKEN: "budget-tracker-local-update"
  ```

- [ ] **Rewrite the file's header block (MUST-16.4, MUST-16.5).** The `UPDATES ARE AUTOMATIC BY DEFAULT` block is **replaced** — after this change it would be false. The existing plain-English `SECURITY NOTE ON WATCHTOWER` block **stays**, with one added sentence.
  ```yaml
  # UPDATES ARE NOW DRIVEN FROM INSIDE THE APP, AND THEY START OFF. From version 1.3.1 this file
  # no longer polls for new images on a timer. Instead, Watchtower sits and waits, and the app
  # asks it to update when you have told the app to check. READ THIS PART: until an admin opens
  # Settings -> About and presses "Enable update checks", THIS INSTALL RECEIVES NO UPDATES AT
  # ALL. If you are replacing an older copy of this file, that is a change in behaviour and it is
  # one click to undo -- go and press the button once the project is running.
  #
  # Once it is on, the app asks GitHub once a day whether a newer version has been published.
  # Bug-fix and feature releases install themselves. A major version never does: you are told,
  # shown exactly what changed in that version, and asked. Database migrations already run
  # automatically on boot, so unattended container replacement is safe by design, and the app's
  # current version is always visible at Settings -> About after it restarts.
  #
  # This exists because Synology Container Manager cannot detect updates for GHCR images (its
  # Image tab "Update" button only works for Docker Hub) and never re-pulls an existing tag on
  # its own -- without Watchtower, an install pinned to ":latest" would in practice never update.
  #
  # PINNING A VERSION (opts OUT of updates entirely): to stay on a known-good release instead of
  # always taking the newest one, change "ghcr.io/vibelogiccode/budgettracker:latest" below to a
  # specific version tag, e.g. "ghcr.io/vibelogiccode/budgettracker:1.3.1". Watchtower only ever
  # replaces a container when a *new* image lands for the tag that container is running, so a
  # pinned numeric tag never changes underneath you. If you would rather Watchtower not run at
  # all in that case, delete the watchtower service block below (or its container_name
  # budget-tracker-watchtower) too; either way, remember you are now responsible for coming back
  # here and bumping the tag by hand.
  ```
  and appended to the existing security note:
  ```yaml
  # One more thing, new in 1.3.1: Watchtower now also listens on an HTTP endpoint (port 8080
  # inside its own container) so the app can ask it to update. That port is NEVER published to
  # the host -- there is no ports: mapping on the watchtower service and there must never be one
  # -- so the endpoint is reachable only by service name from this project's private network, in
  # the same way the healthcheck above talks to 127.0.0.1. The token above is a second fence
  # behind that one.
  ```

- [ ] **Amend `tests/ops/release-image.test.ts` (AC9).** Replace the `WATCHTOWER_POLL_INTERVAL` assertion and add the two new ones, using the file's existing `watchtowerService` / `budgetTrackerService` / `pullCompose` bindings.
  ```ts
    it('ships a label-scoped watchtower companion driven by the app over the HTTP API', () => {
      expect(watchtowerService).toContain('image: containrrr/watchtower:latest');
      expect(watchtowerService).toContain('container_name: budget-tracker-watchtower');
      expect(watchtowerService).toMatch(/restart:\s*unless-stopped/);
      expect(watchtowerService).toContain('/var/run/docker.sock:/var/run/docker.sock');
      expect(watchtowerService).toMatch(/WATCHTOWER_LABEL_ENABLE:\s*"true"/);
      expect(watchtowerService).toMatch(/WATCHTOWER_CLEANUP:\s*"true"/);
      // v1.3.1 (MUST-16.1): HTTP-API mode replaces the daily poll.
      expect(watchtowerService).toMatch(/WATCHTOWER_HTTP_API_UPDATE:\s*"true"/);
      expect(watchtowerService).toMatch(/WATCHTOWER_HTTP_API_TOKEN:\s*"[^"]+"/);
      expect(watchtowerService).not.toContain('WATCHTOWER_POLL_INTERVAL');
    });

    it('MUST-16.2: the watchtower service publishes NO port to the host, ever', () => {
      // An unauthenticated-by-default container-control endpoint on the LAN is exactly the
      // thing the private-network argument in MUST-8.2 depends on not existing.
      expect(watchtowerService).not.toMatch(/^\s*ports:/m);
    });

    it('MUST-16.3: the app service carries both variables, and the token matches Watchtower\'s', () => {
      expect(budgetTrackerService).toMatch(/WATCHTOWER_URL:\s*"http:\/\/watchtower:8080\/v1\/update"/);
      const appToken = /WATCHTOWER_TOKEN:\s*"([^"]+)"/.exec(budgetTrackerService)?.[1];
      const watchtowerToken = /WATCHTOWER_HTTP_API_TOKEN:\s*"([^"]+)"/.exec(watchtowerService)?.[1];
      expect(appToken).toBeDefined();
      expect(appToken).toBe(watchtowerToken);
    });

    it('MUST-16.4 / MUST-16.5: the header says updates are off until an admin turns them on', () => {
      expect(pullCompose).not.toMatch(/UPDATES ARE AUTOMATIC BY DEFAULT/);
      expect(pullCompose).toMatch(/Settings -> About/);
      expect(pullCompose).toMatch(/RECEIVES NO UPDATES AT\s*#?\s*ALL/);
      expect(pullCompose).toMatch(/docker\.sock/);
      expect(pullCompose).toMatch(/never published to the host/i);
    });
  ```
  The existing `documents auto-updates as the default` test asserts `/automatic/i` and `/opts? out of auto-updates|opting out/i`; the first still passes on "install themselves … automatically", and the second no longer does. **Rename that test to `documents how updates work now and how to opt out of them entirely`** and change the second regex to `/opts? OUT of updates entirely|opting out/i`, matching the rewritten header. A test asserting a sentence the product has outgrown is how a suite starts lying.

- [ ] **Bump the two workflow actions (MUST-17.1).** In `.github/workflows/release-image.yml`: `actions/checkout@v4` → `actions/checkout@v5` at **both** occurrences (the guard job and the build job), and `actions/setup-node@v4` → `actions/setup-node@v5`. **No other action is bumped in this release.** `tests/ops/release-image.test.ts`'s pin assertions check only `@v\d+$` and the `actions/checkout@v` / `actions/setup-node@v` prefixes, so they pass unchanged.
  ```powershell
  Select-String -Path .\.github\workflows\release-image.yml -Pattern 'uses: actions/'
  ```
  Expected: `actions/checkout@v5` twice, `actions/setup-node@v5` once.

- [ ] **Add the Dockerfile parser directive (MUST-17.2).** It goes at the **very top**, adjacent to the existing `# syntax=` line — **not** beside line 27, where a `# check=` comment is inert and would look like it worked.
  ```dockerfile
  # syntax=docker/dockerfile:1
  # check=skip=SecretsUsedInArgOrEnv
  ```
  and the comment already above the `ENV SECRET_KEY=` line gains one sentence naming the placeholder explicitly, so the skip is traceable to the thing it excuses:
  ```dockerfile
  # Placeholder so any module that reads env at import time can load during the build. It is
  # never baked into the runtime image. This literal is why the file carries
  # `# check=skip=SecretsUsedInArgOrEnv` at the top: the value is a fixed, public,
  # build-stage-only string, not a credential.
  ```

- [ ] **Append to `tests/ops/docker.test.ts` (MUST-17.3).** Use the file's existing `dockerfile` binding.
  ```ts
    it('MUST-17.2 / MUST-17.3: the check directive is a parser directive at the top of the file', () => {
      const firstTwo = dockerfile.split('\n').slice(0, 2).map((line) => line.trim());
      expect(firstTwo[0]).toBe('# syntax=docker/dockerfile:1');
      expect(firstTwo[1]).toBe('# check=skip=SecretsUsedInArgOrEnv');
    });

    it('MUST-17.3: the skip can never quietly start excusing a real secret in the shipped layer', () => {
      const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
      expect(runtime).not.toMatch(/^ENV SECRET_KEY=/m);
      // ...and the one ENV it does excuse is still the fixed build-stage placeholder.
      expect(dockerfile).toContain('ENV SECRET_KEY=build-time-placeholder-secret-key-0123456789');
      expect(dockerfile).toMatch(/build-stage-only string, not a credential/);
    });
  ```

- [ ] **Amend the two updater scripts' copy (MUST-16.8).** In `install/update.sh` line 173 and `install/update.ps1` line 150, the printed line becomes:
  ```
  This updater is manual only: no scheduler, no auto-update. (The prebuilt-image install
  has an opt-in in-app update check at Settings -> About; this script is the build-from-
  source path and is unaffected by it.)
  ```
  Each script's own header comment (`update.sh` line 4, `update.ps1` line 5) keeps `MANUAL ONLY` and `no scheduler, no auto-update` and drops `no in-app banner`, replacing it with `(the prebuilt-image install has an opt-in in-app check; this is the build-from-source path)`.

- [ ] **Amend `tests/ops/install.test.ts`'s copy assertions (MUST-16.8, MUST-16.9).** In the `update.sh` block, the `/no in-app banner/i` assertion is **replaced** — leaving a test asserting a sentence the product has outgrown is how a suite starts lying:
  ```ts
    it('states plainly that it is manual only', () => {
      expect(result.stdout).toMatch(/manual only/i);
      expect(result.stdout).toMatch(/no scheduler/i);
      expect(result.stdout).toMatch(/no auto-update/i);
      // v1.3.1 (MUST-16.8): the "no in-app banner" claim is no longer true of the product as a
      // whole, so this script now says which path it is and where the other one lives.
      expect(result.stdout).toMatch(/Settings -> About/);
      expect(result.stdout).toMatch(/build-from-\s*source/i);
    });
  ```
  The `update.ps1` mirror test gains the same two assertions beside its existing `/manual only/i`. The `describes the update flow as manual-only with rollback (spec v1.4)` block is **re-scoped to the build-from-source subsection** (MUST-16.9) rather than the whole document:
  ```ts
    it('describes the build-from-source update flow as manual-only with rollback', () => {
      // MUST-16.9: re-scoped. INSTALL.md now covers BOTH paths, and the manual-only claim is
      // true of exactly one of them; asserting it against the whole document would make the
      // prebuilt-image section unwritable.
      const start = install.indexOf('## Updating a build-from-source install');
      expect(start).toBeGreaterThan(-1);
      const section = install.slice(start);
      expect(section).toMatch(/Updates are manual/i);
      expect(section).toMatch(/patch and minor/i);
      expect(section).toMatch(/rolls back automatically|auto-?rollback/i);
      expect(section).toContain('budget-tracker:previous');
      expect(section).toContain('--no-deps');
    });

    it('MUST-16.9: a short prebuilt-image section above it covers the opt-in in-app check', () => {
      const prebuilt = install.indexOf('## Updating a prebuilt-image install');
      expect(prebuilt).toBeGreaterThan(-1);
      expect(prebuilt).toBeLessThan(install.indexOf('## Updating a build-from-source install'));
      expect(install.slice(prebuilt)).toMatch(/Settings -> About/);
      expect(install.slice(prebuilt)).toMatch(/off until|opt-in/i);
    });
  ```

- [ ] **Write the two INSTALL.md sections (MUST-16.9) and the INSTALL-SYNOLOGY.md block (MUST-16.6).** In `INSTALL.md`, `## Updating a prebuilt-image install` goes **above** `## Updating a build-from-source install` (the renamed existing section) and says: updates are driven from the app, they are **off until an admin turns them on** at Settings → About, small updates then install themselves and a major asks first, and an install whose compose predates 1.3.1 keeps its old daily poll and is shown how to move over. In `docs/INSTALL-SYNOLOGY.md`, add **Moving to in-app updates (1.3.1)** beside the existing "Adopting auto-updates on an existing pre-1.2.3 install" block, with the identical three-step shape:
  ```markdown
  ### Moving to in-app updates (1.3.1)

  1. Container Manager → **Project** → `budget-tracker` → **Stop**.
  2. **YAML Configurations** → replace the whole YAML with the current contents of
     `install/synology-compose-pull.yml`.
  3. **Save** / **Build**, then start the project again — then open **Settings → About** and
     press **Enable update checks**.

  Step 3's second half is not optional garnish. The new compose file no longer polls on a timer,
  so until you press that button this install receives no updates at all. It is one click, on a
  page you already visit to see which version you are running.
  ```
  and the Updating section gains the same sentence, per MUST-16.5's second bullet.

- [ ] **Fix the two vacuous tests in `tests/app/notifications-actions.test.ts` (MUST-17.4, MUST-17.5).** Both were rendered vacuous by v1.3.0's pref-wipe fix: neither configures a target for the calling user, so **no pref row is written for any reason** and both assertions pass without exercising the rule they name.
  ```ts
    it('MUST-4.3: a member cannot enable an admin-only event', async () => {
      currentUser.value.role = 'member';
      // Without a configured channel the pref save skips every channel, so this test used to
      // pass even if eventsFor() returned every event. A target makes the write path real.
      saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
      await actions.savePreferencesAction(
        {},
        form({
          'pref:backup_failed:email': 'on',
          // A second, NON-admin toggle in the same form, so the assertion below distinguishes
          // the audience filter from the dormancy skip wearing its name.
          'pref:weekly_digest:email': 'on',
          comingDueDays: '14',
          budgetThresholdPct: '80',
          staleImportWeeks: '3',
          dailyHour: '8',
          digestWeekday: '1',
          digestHour: '8',
        }),
      );
      expect(t.sqlite.prepare(`select event_id from notification_prefs where event_id = 'backup_failed'`).all()).toHaveLength(0);
      expect(t.sqlite.prepare(`select event_id from notification_prefs where event_id = 'weekly_digest'`).all()).toHaveLength(1);
    });
  ```
  and, in the `MUST-12.4` test, add the same one-line `saveEmailTarget` for the caller before the call, assert **both** halves (the other member's row is untouched **and** the caller's own row was written), and — **MUST-17.5** — express the unchecked case by **omitting** the field rather than sending `'off'`, because `checkbox()` is presence-based and the string `'off'` reads as *checked*:
  ```ts
      saveEmailTarget({ userId: currentUser.value.id, destination: 'me@example.com', enabled: true });
      await actions.savePreferencesAction(
        {},
        form({
          userId: String(other),
          // 'pref:weekly_digest:email' is OMITTED: that is what unchecked looks like. Sending
          // the string 'off' would have been read as CHECKED (MUST-17.5).
          comingDueDays: '14',
          budgetThresholdPct: '80',
          staleImportWeeks: '3',
          dailyHour: '8',
          digestWeekday: '1',
          digestHour: '8',
        }),
      );
      // The other member's row survives...
      expect(row?.enabled).toBe(1);
      // ...and the caller's OWN pref was written, which is the half that was vacuous before.
      const mine = t.sqlite
        .prepare('select enabled from notification_prefs where user_id = ? and event_id = ? and channel = ?')
        .get(currentUser.value.id, 'weekly_digest', 'email') as { enabled: number } | undefined;
      expect(mine).toBeUndefined(); // omitted == unchecked == the registry default (OFF), so no row
  ```

- [ ] **Make the relay-test title earn its body (MUST-17.6).** The title stays; the body proves it.
  ```ts
    it('still refuses when no relay has been saved at all — the relay-exists guard runs before quota is spent', async () => {
      const result = await actions.testSmtpAction();
      expect(result.error).toBe(NO_RELAY_ERROR);
      // The title claims the guard runs BEFORE the limiter. Prove it: after the refusal, a
      // properly configured relay must still have all three test sends available. Swapping the
      // guard and the limiter in runTest would leave the assertion above green and this one red.
      saveSmtp({ preset: 'custom', host: 'localhost', port: 25, security: 'none', username: 'u', password: 'p', fromEmail: 'a@b.com', fromName: 'BT', enabled: true });
      saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
      setNotifySenderForTests(async () => {});
      for (let i = 0; i < TEST_SEND_MAX_PER_USER; i += 1) {
        expect((await actions.testSmtpAction()).error).toBeUndefined();
      }
      expect((await actions.testSmtpAction()).error).toMatch(/Too many test messages/);
    });
  ```

- [ ] **Remove the dead relay re-check in `runTest` (MUST-17.7).** The email branch re-reads the relay and returns the no-relay error a **third** time. That branch is **unreachable**: every path reaching it has already proved the relay exists, and there is no `await` on any I/O in between — better-sqlite3 is synchronous and `checkTestSend` is an in-memory call — so the TOCTOU window its original justification invoked does not exist. Hoist the single `getSmtp()` read above the `if (opts.relayOnly)` split into one `relay` binding used by both the guard and the send, and promote the thrice-written literal to a module constant matching the one `notifications-client.tsx` already declares:
  ```ts
  const NO_RELAY_ERROR = 'An admin needs to set up outbound email before this can send.';
  ```
  ```ts
  async function runTest(userId: number, channel: Channel, opts: { relayOnly: boolean }): Promise<NotificationsState> {
    // One read, used by both the guard and the send below. better-sqlite3 is synchronous and
    // nothing between here and the send awaits any I/O, so there is no TOCTOU window for a
    // second read to close -- the third copy of this check was unreachable (MUST-17.7).
    const relay = channel === 'email' ? getSmtp() : null;
    let destination: string;

    if (opts.relayOnly) {
      if (!relay) return { error: NO_RELAY_ERROR };
      destination = getTarget(userId, 'email')?.destination ?? relay.fromEmail;
    } else {
      const target = getTarget(userId, channel);
      if (!target) return { error: 'Set this channel up first.' };
      if (channel === 'email' && relay === null) return { error: NO_RELAY_ERROR };
      destination = target.destination;
    }
    /* ...unchanged through the quota check... */
      } else {
        // `relay` is non-null on every path that reaches here: both branches above return when
        // it is missing.
        credential = getSmtpPassword();
        await deliver({
          channel: 'email',
          destination,
          smtp: {
            host: relay!.host,
            port: relay!.port,
            security: relay!.security,
            username: relay!.username,
            password: credential,
            fromEmail: relay!.fromEmail,
            fromName: relay!.fromName,
          },
          subject,
          body,
        });
      }
  ```

- [ ] **Add the one comment MUST-17.8 requires to `src/lib/notify/outbox.ts`,** so the next reader does not "clean up" a load-bearing check by analogy with the one just removed. Above `buildRequest`'s relay read:
  ```ts
    // NOT the same as the re-read removed from runTest in v1.3.1 (spec MUST-17.7/17.8). THIS one
    // is live and mandated by MUST-7.5's pre-send revalidation: enqueue and pump are separated in
    // time -- minutes, or hours across a retry ladder -- so the relay genuinely can be changed or
    // removed in between. Do not "simplify" it by analogy with runTest's.
  ```

- [ ] **Run every ops and notifications suite this task touched.**
  ```powershell
  npx vitest run tests/ops/release-image.test.ts tests/ops/docker.test.ts tests/ops/install.test.ts tests/app/notifications-actions.test.ts tests/lib/notify/outbox.test.ts
  npx tsc --noEmit
  ```
  Expected: green.

- [ ] **Commit.**
  ```powershell
  git add install .github Dockerfile INSTALL.md docs/INSTALL-SYNOLOGY.md "src/app/(app)/settings/notifications/actions.ts" src/lib/notify/outbox.ts tests/ops tests/app
  git commit -m "chore: compose HTTP-API mode, workflow bumps, and the five parked chores

Watchtower moves to HTTP-API mode and loses its daily poll, so the app drives
updates instead (MUST-16.1). No ports: mapping is added, ever - that absence is
what the private-network argument in MUST-8.2 rests on, and a test now pins it.
The header says plainly that adopting this file means no updates until somebody
presses one button, because that regression is real and is closed with copy and a
button rather than accepted (MUST-16.5). INSTALL.md grows a prebuilt-image
section and its manual-only assertions are re-scoped to the build-from-source one
(MUST-16.9).

checkout@v4 -> v5 and setup-node@v4 -> v5 clear the Node 24 deprecation warnings.
The Dockerfile check directive goes at the TOP, where BuildKit actually reads it,
with the explanatory comment staying at the ENV line (MUST-17.2). Two vacuous
notification tests are given the target they were missing, so they exercise the
audience filter rather than the dormancy skip wearing its name (MUST-17.4); the
relay-test body is made to earn its title (MUST-17.6); and runTest's unreachable
third relay re-check is removed while outbox.ts's live one gains a comment saying
why it is not the same thing (MUST-17.7/17.8)."
  ```

<!-- END TASK 13 -->

---

## Task 14: The egress invariants, the loan grep guards and the two integration walks

**Context:** Spec §8.4, §19.8, §19.9, AC3, AC4, AC5, AC7, AC8 and the MUST-8.9 half of AC10. This is the task that makes the three-destination promise enforceable **by the build** rather than by review.

**All of the egress-test amendments live here and nowhere else.** Task 13 deliberately does not touch `tests/ops/notify-egress.test.ts` or `install.test.ts`'s `fetch()` allowlist: those two changes are part of the egress argument rather than a consequence of it (spec §2.2's note), and splitting them across two tasks would leave the repo in a state where the allowlist and the invariant disagree.

**Files:**
- Modify: `tests/ops/notify-egress.test.ts` (generalised from one scanned tree to two)
- Modify: `tests/ops/install.test.ts` (the app-wide `fetch()` allowlist; the renamed and tightened opt-in block)
- Create: `tests/ops/loan-invariants.test.ts`
- Create: `tests/integration/update-flow.test.ts`, `tests/integration/loan-flow.test.ts`

### Steps

- [ ] **Generalise `tests/ops/notify-egress.test.ts` from one tree to two (MUST-8.8).** The file keeps its name and every existing assertion; the leading comment is rewritten to state that it is the **whole app's** egress invariant test, not notifications' alone, and the two `describe` titles that say "src/lib/notify/" are rewritten to name both trees.
  1. Add the second tree and the table:
  ```ts
  const updateDir = path.join(root, 'src/lib/update');

  /**
   * MUST-8.8 item 2: table-driven over BOTH egress trees. `expected` counts literal `fetch(`
   * CALL SITES, not endpoints: github.ts reaches two endpoints through one private `get()`
   * helper, so its count is 1. Any `fetch(` anywhere else under either tree fails, exactly as
   * it does today.
   */
  const FETCH_SITES: { dir: string; file: string; expected: number }[] = [
    { dir: notifyDir, file: 'src/lib/notify/send/telegram.ts', expected: 2 }, // sendMessage, getUpdates
    { dir: updateDir, file: 'src/lib/update/github.ts', expected: 1 }, // one get(), two pinned endpoints
    { dir: updateDir, file: 'src/lib/update/watchtower.ts', expected: 1 }, // /v1/update
  ];

  it('every fetch( under src/lib/notify/ and src/lib/update/ is on the allowlist, with the expected count', () => {
    const counts = new Map<string, number>();
    const offenders: string[] = [];
    for (const dir of [notifyDir, updateDir]) {
      for (const file of filesUnder(dir)) {
        const calls = fs.readFileSync(file, 'utf8').match(/(?<![.\w])fetch\s*\(/g)?.length ?? 0;
        if (calls === 0) continue;
        const name = rel(file);
        if (FETCH_SITES.some((site) => site.file === name)) counts.set(name, calls);
        else offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
    for (const site of FETCH_SITES) expect({ file: site.file, calls: counts.get(site.file) }).toEqual({ file: site.file, calls: site.expected });
  });
  ```
  2. Extend the URL-literal test with the second case (**this is the assertion that makes MUST-2.3 mechanical**):
  ```ts
  it('MUST-2.3: the only :// literal under src/lib/update/ is GITHUB_API_ORIGIN in egress.ts', () => {
    const offenders: { file: string; literal: string }[] = [];
    for (const file of filesUnder(updateDir)) {
      if (rel(file) === 'src/lib/update/egress.ts') continue;
      for (const literal of urlLiterals(file)) offenders.push({ file: rel(file), literal });
    }
    expect(offenders).toEqual([]);
    expect(urlLiterals(path.join(updateDir, 'egress.ts'))).toEqual(["'https://api.github.com'"]);
    // watchtower.ts MUST contain no :// literal at all -- the URL comes from the environment.
    expect(urlLiterals(path.join(updateDir, 'watchtower.ts'))).toEqual([]);
  });
  ```
  3. Run the existing "no HTTP client library" loop over both trees (`for (const dir of [notifyDir, updateDir])`).
  4. Add the adjacency test (MUST-8.8 item 5, in the style of `restore-seams.test.ts`, **because MUST-8.5's "immediately above" is the part a refactor loses first**):
  ```ts
  it('MUST-8.5: the assert is on the line immediately preceding each fetch(', () => {
    const cases = [
      { file: 'src/lib/update/github.ts', guard: 'assertGithubUrl(' },
      { file: 'src/lib/update/watchtower.ts', guard: 'assertWatchtowerUrl(' },
    ];
    for (const { file, guard } of cases) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
      const fetchLines = lines
        .map((line, index) => ({ line, index }))
        .filter((entry) => /(?<![.\w])fetch\s*\(/.test(entry.line));
      expect(fetchLines.length).toBeGreaterThan(0);
      for (const { index } of fetchLines) {
        const previous = (lines[index - 1] ?? '').trim();
        expect({ file, previous }).toEqual({ file, previous: expect.stringContaining(guard) as unknown as string });
      }
    }
  });
  ```
  5. Add `src/lib/update/semver.ts` and `src/lib/update/egress.ts` to the existing pure-module loop (MUST-2.1), keyed on their own directory.
  6. Extend the existing MUST-2.2 client-import banned regex with the update tree, keeping the `import type` exemption:
  ```ts
  const banned = /from\s+['"]@\/lib\/(notify\/(crypto|config|outbox|raise|send|evaluate)|update\/(github|watchtower|state|check))/;
  ```
  7. Add the update-side counterpart of AC7 (MUST-8.8 item 8):
  ```ts
  it('AC7: src/lib/update/ holds one Authorization literal and logs no credential', () => {
    const authLines: string[] = [];
    const consoleOffenders: string[] = [];
    for (const file of filesUnder(updateDir)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (/Authorization/.test(trimmed)) authLines.push(`${rel(file)}: ${trimmed}`);
        if (/console\.[a-z]+\([^)]*\b(token|Authorization|bearer)\b/i.test(trimmed)) consoleOffenders.push(`${rel(file)}: ${trimmed}`);
      }
    }
    expect(authLines).toHaveLength(1);
    expect(authLines[0]).toContain('src/lib/update/watchtower.ts');
    expect(authLines[0]).toContain('Bearer ');
    expect(consoleOffenders).toEqual([]);
  });
  ```

- [ ] **Amend `tests/ops/install.test.ts` (MUST-8.9, AC10).** The app-wide `fetch()` allowlist gains two entries, each with the one-line comment naming this spec, exactly as the notify entry names notify MUST-9.5:
  ```ts
        path.join(srcRoot, 'lib', 'notify', 'send', 'telegram.ts'),
        // v1.3.1: the third opt-in egress exception (update spec MUST-8.1). Dormant until an
        // admin presses Enable update checks; one host, two pinned endpoints, no auth.
        path.join(srcRoot, 'lib', 'update', 'github.ts'),
        // v1.3.1: NOT an internet destination (update spec MUST-8.2). A compose service name on
        // the project's private bridge network, with assertWatchtowerUrl refusing every public
        // host structurally -- the same category as the healthcheck's 127.0.0.1 call.
        path.join(srcRoot, 'lib', 'update', 'watchtower.ts'),
  ```
  and `describe('no auto-update anywhere in the codebase')` is **renamed and tightened** — a block whose title now contradicts the shipped behaviour is worse than no block, so renaming it and tightening it is the honest fix:
  ```ts
  describe("the updater is opt-in and never bypasses the scheduler's gate", () => {
    it('does not shell out to the updater scripts or drive Docker from the scheduler', () => {
      const scheduler = read('src/lib/scheduler.ts');
      expect(scheduler).not.toMatch(/update\.(sh|ps1)/);
      expect(scheduler).not.toMatch(/npm update|docker (pull|compose)/);
    });

    it('MUST-8.9: the tick cannot lose its dormancy gate while the tick stays', () => {
      const scheduler = read('src/lib/scheduler.ts');
      expect(scheduler).toContain('runUpdateTick');
      expect(scheduler).toContain('isUpdateCheckEnabled');
    });
  });
  ```

- [ ] **Write `tests/ops/loan-invariants.test.ts` (MUST-19.4).** Three grep-shaped invariants, in the style of the existing `console.*` and restore-seam checks.
  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  function srcFiles(dir = path.join(root, 'src'), acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) srcFiles(full, acc);
      else if (/\.tsx?$/.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  describe('MUST-13.16: exactly one place deletes a transaction row', () => {
    it('is undoImport, which must reverse the loan links first', () => {
      const sites = srcFiles()
        .filter((file) => /(?<![.\w])tx\.delete\(transactions\)/.test(fs.readFileSync(file, 'utf8')))
        .map((file) => path.relative(root, file).replace(/\\/g, '/'));
      expect(
        sites,
        'A second transaction-delete path must call reverseLoanLinksForTransactions() BEFORE the delete: the ON DELETE CASCADE removes the link rows, but a cascade cannot restore a balance.',
      ).toEqual(['src/lib/import/commit.ts']);

      const commit = read('src/lib/import/commit.ts');
      expect(commit.indexOf('reverseLoanLinksForTransactions')).toBeLessThan(commit.indexOf('tx.delete(transactions)'));
    });
  });

  describe('MUST-13.1: the interest rate is display only', () => {
    it('no arithmetic operator is ever applied to interestRateBps in src/lib/loans.ts', () => {
      const offenders = read('src/lib/loans.ts')
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter((entry) => !entry.line.startsWith('//') && !entry.line.startsWith('*'))
        .filter((entry) => /interestRateBps\s*[*/+-]|[*/+-]\s*interestRateBps/.test(entry.line));
      expect(offenders).toEqual([]);
    });
  });

  describe('MUST-13.2: loan payments are invisible to every spend calculation', () => {
    it('budgets, reports and the categorizer never read the link table', () => {
      for (const file of ['src/lib/budgets.ts', 'src/lib/reports.ts', 'src/lib/categorize/engine.ts']) {
        const source = read(file);
        expect({ file, hit: /loan_payments|loanPayments/.test(source) }).toEqual({ file, hit: false });
      }
    });
  });
  ```
  **Note on the third invariant:** `src/lib/categorize/engine.ts` imports `applyLoanMatchers`, not `loanPayments`, so the grep stays clean. If a future change needs the table there, the invariant is the conversation to have first.

- [ ] **Write `tests/integration/update-flow.test.ts` (MUST-19.6, AC4, AC8).** With a stubbed fetch, against a temp SQLite file, walk the whole feature:
  ```ts
  it('MUST-19.6: dormant -> enabled -> patch auto-applies -> major never does -> disabled', async () => {
    // 1. Checks disabled: a boot plus twelve simulated ticks perform ZERO fetches (AC4).
    startScheduler();
    for (let i = 0; i < 12; i += 1) runUpdateTick(new Date(base + i * 5 * 60_000));
    expect(fetchCalls).toHaveLength(0);
    stopScheduler();

    // 2. Enable. One tick fetches once; a second within 24 hours fetches nothing.
    await enableUpdateChecksAction();
    stubRelease(`v${APP_VERSION}`);
    runUpdateTick(new Date(base));
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
    runUpdateTick(new Date(base + 60_000));
    expect(fetchCalls).toHaveLength(1);

    // 3. A patch release with auto-apply on fires exactly ONE Watchtower request and enqueues
    //    no notification -- the container is about to be replaced.
    withWatchtower(true);
    setAutoApply(true);
    stubRelease(patchOf(APP_VERSION));
    const patch = await runUpdateCheck({ now: new Date(base + DAY), manual: true });
    expect(patch).toMatchObject({ severity: 'patch', applied: true, notified: false });
    expect(watchtowerCalls).toBe(1);
    expect(outboxRows()).toEqual([]);

    // 4. A major fires NO Watchtower request and enqueues one update_available, for the admin
    //    only (AC8, MUST-5.8, MUST-4.3).
    watchtowerCalls = 0;
    stubRelease(majorOf(APP_VERSION));
    const major = await runUpdateCheck({ now: new Date(base + 2 * DAY), manual: true });
    expect(major).toMatchObject({ severity: 'major', applied: false, notified: true });
    expect(watchtowerCalls).toBe(0);
    expect(outboxRows().map((r) => r.user_id)).toEqual([adminId]);

    // 5. The review action fetches the changelog pinned to that version's tag...
    stubChangelog('## [2.0.0] - 2026-09-01\n\n### Changed\n\n- Everything.\n');
    const reviewed = await reviewUpdateAction(form({ version: '2.0.0' }));
    expect(lastFetchUrl()).toContain('?ref=v2.0.0');
    expect(reviewed.release?.groups[0]?.items[0]).toBe('Everything.');

    // 6. ...and the apply action refuses a stale version.
    expect((await applyUpdateAction(form({ version: '1.9.9' }))).error).toContain('no longer the one on offer');

    // 7. Disable: the state is cleared and further ticks fetch nothing (MUST-3.4, MUST-1.1).
    await disableUpdateChecksAction();
    const before = fetchCalls.length;
    for (let i = 0; i < 12; i += 1) runUpdateTick(new Date(base + 3 * DAY + i * 5 * 60_000));
    expect(fetchCalls.length).toBe(before);
    expect(updateSettingsRows()).toEqual([{ key: 'update.checks_enabled', value: '0' }]);
  });
  ```

- [ ] **Write `tests/integration/loan-flow.test.ts` (MUST-19.5, AC5).** Against a temp SQLite file:
  ```ts
  it('MUST-19.5: create -> rule -> import -> undo -> re-import -> manual assign -> unassign', () => {
    // A loan item with a principal, a rate, a balance and a monthly payment.
    const itemId = createLoan({ principalCents: 2_800_000, interestRateBps: 549, currentBalanceCents: 2_000_000, billingCycle: 'monthly', billingAmountCents: 45_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });

    // A CSV with two matching payments and one non-matching row.
    const groceriesBefore = categoryBreakdown({ from: '2026-01-01', to: '2026-12-31' });
    const first = importCsv(FIXTURE);
    expect(first.loanLinksCreated).toBe(2);
    expect(balanceOf(itemId)).toBe(2_000_000 - 90_000);

    // MUST-13.2: the category totals are UNCHANGED by the linking.
    expect(categoryBreakdown({ from: '2026-01-01', to: '2026-12-31' })).toEqual(groceriesBefore);

    // The dashboard summary and the debt series agree with the balance.
    expect(loansTotalOwedCents()).toBe(1_910_000);
    expect(debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' }).at(-1)!.owedCents).toBe(1_910_000);

    // Undo restores the balance to exactly what it was...
    const undone = undoImport(first.importId);
    expect(undone.loanLinksReversed).toBe(2);
    expect(balanceOf(itemId)).toBe(2_000_000);

    // ...and re-importing drops it by exactly the same amount again.
    const second = importCsv(FIXTURE);
    expect(second.loanLinksCreated).toBe(2);
    expect(balanceOf(itemId)).toBe(1_910_000);

    // A manual assign and unassign leave the balance unchanged end to end.
    const unrelated = spend('COFFEE', -500);
    assignTransactionToLoan({ txnId: unrelated, itemId });
    expect(balanceOf(itemId)).toBe(1_909_500);
    unassignTransactionFromLoan({ txnId: unrelated, itemId });
    expect(balanceOf(itemId)).toBe(1_910_000);
  });

  it('AC5: a 500-row import with NO loan rules performs one extra query and writes no link', () => {
    deleteEveryRule();
    const before = queryCount();
    const result = importCsv(FIVE_HUNDRED_ROWS);
    expect(result.loanLinksCreated).toBe(0);
    expect(queryCount() - before - baselineImportQueries).toBe(1);
    expect(t.sqlite.prepare('select count(*) as n from loan_payments').get()).toEqual({ n: 0 });
  });
  ```

- [ ] **Run the invariants and both integration walks.**
  ```powershell
  npx vitest run tests/ops/notify-egress.test.ts tests/ops/install.test.ts tests/ops/loan-invariants.test.ts tests/integration/update-flow.test.ts tests/integration/loan-flow.test.ts
  npx tsc --noEmit
  ```
  Expected: green. An integration failure here is a genuine integration bug — debug it with `superpowers:systematic-debugging` rather than by loosening a step.

- [ ] **Commit.**
  ```powershell
  git add tests/ops tests/integration
  git commit -m "test: egress invariants over both trees, loan grep guards and the two flows

notify-egress.test.ts keeps its name and every existing assertion and is
generalised from one scanned tree to two with a per-tree allowlist, so it is now
the whole app's egress invariant test rather than notifications' alone
(MUST-8.8). The table pins fetch CALL SITES, the :// literal test makes MUST-2.3
mechanical, and a new source-level check asserts the guard sits on the line
immediately above each fetch - the part a refactor loses first (MUST-8.5).

install.test.ts's app-wide allowlist names the two update files with the comment
that says why each is there, and its 'no auto-update anywhere' block is renamed
and tightened rather than deleted: a block whose title contradicts the product is
worse than no block (MUST-8.9). Three loan grep invariants pin the single
transaction-delete site, the display-only rate and the budget-invisibility of the
link table (MUST-19.4). Both integration walks run end to end."
  ```

<!-- END TASK 14 -->

---

## Task 15: Release — v1.3.1, the CHANGELOG and the documentation amendments

**Context:** Spec §18 in full, plus MUST-8.3's master-spec amendment and MUST-18.5's `.env.example` note. **This is the only task that runs the full suite and the production build.**

**Files:**
- Modify: `package.json` (`version` → `1.3.1`)
- Modify: `CHANGELOG.md`
- Modify: `README.md`, `INSTALL.md`
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (MUST-8.3's third opt-in egress exception)
- Modify: `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md` (record the §17-item-29 reversal, R13)
- Modify: `tests/ops/docker.test.ts` (its existing `keeps package.json and the newest changelog section on the same version` census)

**Interfaces:**
- Consumes: `src/lib/version.ts`, which imports `package.json`'s `version` at build time (MUST-18.1); `src/lib/changelog.ts`, which reads `CHANGELOG.md` at request time (MUST-18.4 — Settings → About needs **no code change** to render the new entry).
- Produces: no new code exports.

### Steps

- [ ] **Check the current state before changing anything.**
  ```powershell
  node -e "console.log('package.json version:', require('./package.json').version)"
  Select-String -Path .\CHANGELOG.md -Pattern '^## \[' | Select-Object -First 3
  ```
  Expected at the start of this task: `1.3.0`, with `## [1.3.0] - 2026-08-17` as the newest section. If `package.json` already reads `1.3.1`, note it and proceed — the task is **"ensure `package.json` = 1.3.1 and CHANGELOG has a 1.3.1 entry"**, not "bump from 1.3.0".

- [ ] **Set `package.json`'s `version` to `1.3.1` (MUST-18.1).** It remains the single source of truth: `src/lib/version.ts` imports it at build time, the footer and Settings → About render it, `/api/health` reports it, the update scripts print it, and — new in this release — `runUpdateCheck` compares against it and `reconcileApplyOnBoot` matches against it.

  **MUST-18.2, stated rather than discovered:** under strict semver a release that adds features is a minor, and this one adds two; the label is the owner's to set and it is set. `classify()` will therefore report a **patch** update to anyone moving from 1.3.0 to 1.3.1, which means an install with auto-apply on takes this release unattended. That is the intended outcome, and it is why the release-notes entry below **leads with the compose change**.

- [ ] **Add the CHANGELOG section (MUST-18.3), Keep-a-Changelog style, with a fresh empty `## Unreleased` left above it.** Match the file's existing conventions exactly: `## [x.y.z] - YYYY-MM-DD` with a plain hyphen, `->` rather than an arrow glyph, and **no em dashes anywhere in this file** — every dash in the entry below is a hyphen, a parenthesis or a full stop.
  ```markdown
  ## Unreleased

  ## [1.3.1] - 2026-08-17

  ### Changed

  - **The prebuilt-image compose file now drives Watchtower from the app instead of polling
    daily.** If you replace your compose file with the new one, updates are OFF until you turn
    them on: open Settings -> About and press "Enable update checks", once. Existing installs
    that keep their current compose keep their daily poll and carry on exactly as before; the
    app notices, and tells you how to move over. docs/INSTALL-SYNOLOGY.md has the three steps.

  ### Added

  - **In-app update checks, off until you ask for them.** Settings -> About gains an Updates
    card. Switch it on and once a day the app asks GitHub whether a newer version of Budget
    Tracker has been published. That request carries the version you are running and nothing
    else: not your data, not your address, not how many people use this install. Until you
    press the button it makes no such request at all.
  - **Small updates install themselves; a major version never does.** Bug-fix and feature
    releases are applied unattended through the Watchtower companion. A major version is parked
    behind a screen that shows that version's own release notes, a plain warning that your data
    is not touched, and a confirm button with the version number in its label. There is no
    setting that changes this.
  - **A notification when an update is waiting**, for admins, on whichever channel they already
    use. It fires only when the app will not apply the update itself.
  - **Loan money-tracking.** A loan item in Contracts & Coverage now carries what you borrowed,
    the interest rate (shown for reference, never used in a calculation), the balance still
    owed, and its regular payment. The form says "Payment" and "per month" for a loan, where a
    subscription says "Billing" and "/ month".
  - **Payment matching.** Tell a loan what its payments look like on your statement and the
    balance goes down on its own as they land, with an opt-in pass over the last twelve months
    for the case where the balance you typed predates them. The payment still counts in your
    budget and in your reports, because it is money that left the household.
  - **A Loans card on the dashboard** showing the total owed, a payoff bar and the next payment
    date, and a **Debt over time** line on the Reports page. The line breaks where a loan's
    history is unknown rather than inventing a number.

  ### Fixed

  - The release workflow moves to actions/checkout@v5 and actions/setup-node@v5, clearing the
    Node 24 deprecation warnings.
  - The Docker build no longer warns about the build-stage SECRET_KEY placeholder.
  - Two notification tests were passing without exercising the rule they named, and a third
    asserted less than its title claimed. All three now prove what they say.
  - An unreachable third relay check in the notifications test-send path is gone, and the one
    in the outbox that IS load-bearing now says so.
  ```

- [ ] **Extend `README.md` and `INSTALL.md` (MUST-8.3, MUST-18.5).** Three edits, in the places the corresponding text already exists:
  1. **The "no runtime network calls" statement** gains a **third** opt-in exception beside SimpleFIN and notifications, worded the same way: *update checks (2026-08-17 spec), dormant until an admin enables them and then reaching only `api.github.com`, one host and two endpoints, with no authentication and nothing about the install in the request.*
  2. **A short paragraph on the two new environment variables**, framed as *optional, prebuilt-image installs only*: `WATCHTOWER_URL` and `WATCHTOWER_TOKEN` are set by `install/synology-compose-pull.yml` and are not needed for a build-from-source install. Name the fact that the Watchtower endpoint is on the compose network and is never published to the host, so it is not a fourth egress destination (MUST-8.2).
  3. **The update-path rewrite of §16.3**, already made in `INSTALL.md` by Task 13; check `README.md`'s shorter version says the same thing rather than the old "the app never nags you with an 'update available' banner".

- [ ] **Add the two variables to `.env.example`, COMMENTED OUT (MUST-18.5).** Append:
  ```bash
  # Optional, and only for the prebuilt-image install. install/synology-compose-pull.yml sets
  # these two for you; a build-from-source install does not need them and leaves them unset.
  # WATCHTOWER_URL points at the Watchtower companion on the compose network - the app refuses
  # to send this request to anything that is not a bare service name, localhost, or a private
  # IP literal - and WATCHTOWER_TOKEN must match WATCHTOWER_HTTP_API_TOKEN in that same file.
  # WATCHTOWER_URL=http://watchtower:8080/v1/update
  # WATCHTOWER_TOKEN=budget-tracker-local-update
  ```

- [ ] **Amend the master spec (MUST-8.3).** In `docs/superpowers/specs/2026-08-15-budget-tracker-design.md`, find §2's "No runtime network calls" line — which already carries the SimpleFIN and notifications exceptions — and add the third in the same sentence shape:
  ```markdown
  ...and update checks (2026-08-17 spec), dormant until an admin enables them and then reaching only `api.github.com`.
  ```

- [ ] **Record the reversal in the warranty spec (R13).** `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md`'s revision history gains one line, so a reader standing in that document is not left believing a decision this release withdrew:
  ```markdown
  - **Amended 2026-08-17 (v1.3.1):** §17 item 29 ("Loans are dates and documents only — no balance, no payment schedule, no interest math") is **withdrawn** by `docs/superpowers/specs/2026-08-17-update-loans-design.md` §12. Loans now carry a principal, a display-only rate and a balance that bank transactions decrement. Interest **math** remains out of scope, enforced by a grep invariant. Nothing else in this spec is withdrawn.
  ```

- [ ] **Update the version census in `tests/ops/docker.test.ts`.** Its existing `keeps package.json and the newest changelog section on the same version` test reads both files; it should pass unchanged. Its `has a dated 1.2.3 section and a fresh empty Unreleased above it` test pins an older release and also passes unchanged. Add one assertion beside them:
  ```ts
    it('MUST-18.1 / MUST-18.3: the 1.3.1 release', () => {
      const pkg = JSON.parse(read('package.json')) as { version: string };
      expect(pkg.version).toBe('1.3.1');
      const changelog = read('CHANGELOG.md');
      expect(changelog).toMatch(/^## \[1\.3\.1\] - 2026-08-17$/m);
      // An empty Unreleased section is left in place for the next session.
      expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.3.1]'));
      // MUST-18.2: the compose change leads, because auto-apply installs this release unattended.
      const section = changelog.slice(changelog.indexOf('## [1.3.1]'), changelog.indexOf('## [1.3.0]'));
      expect(section.indexOf('### Changed')).toBeLessThan(section.indexOf('### Added'));
    });

    it('MUST-8.3 / MUST-18.5: the docs name the third egress exception and the two new variables', () => {
      for (const doc of ['README.md', 'INSTALL.md']) {
        const source = read(doc);
        expect(source).toContain('api.github.com');
        expect(source).toContain('WATCHTOWER_URL');
        expect(source).toContain('WATCHTOWER_TOKEN');
      }
      const example = read('.env.example');
      expect(example).toMatch(/^# WATCHTOWER_URL=/m);
      expect(example).toMatch(/^# WATCHTOWER_TOKEN=/m);
    });
  ```

- [ ] **Run the FULL gate. This is the only task that does so.**
  ```powershell
  npx tsc --noEmit
  npm run build
  npm test
  ```
  Expected: all three green, with `ƒ /settings` still in the route table and no new route added by either feature.

- [ ] **Walk the automated acceptance criteria explicitly (§20.1).** Each maps to a test that must be green in the run above; confirm by name rather than by vibe:
  ```powershell
  npx vitest run tests/ops/notify-egress.test.ts tests/ops/install.test.ts tests/ops/loan-invariants.test.ts tests/db/loan-schema.test.ts tests/lib/scheduler.test.ts tests/lib/update tests/lib/loans tests/integration/update-flow.test.ts tests/integration/loan-flow.test.ts
  ```
  AC1 `npm test`; AC2 `tsc`; AC3 `notify-egress.test.ts`; AC4 the scheduler's twelve-tick assertion; AC5 `loan-flow.test.ts`'s second test; AC6 `loan-schema.test.ts`; AC7 `notify-egress.test.ts`'s Authorization block and `update-actions.test.ts`'s token assertion; AC8 `check.test.ts`'s 200-pair test; AC9 `release-image.test.ts`; AC10 `install.test.ts`.

- [ ] **Commit.**
  ```powershell
  git add package.json CHANGELOG.md README.md INSTALL.md .env.example docs tests
  git commit -m "chore(release): in-app updates and loan money-tracking ship as v1.3.1

package.json bumped and a Keep-a-Changelog 1.3.1 section added, leading with the
compose change because auto-apply installs this release unattended (MUST-18.2/18.3).
README and INSTALL gain the third opt-in egress exception naming api.github.com
(MUST-8.3) and the two optional prebuilt-image-only variables; .env.example
carries both, commented out (MUST-18.5). The master spec's no-runtime-network-
calls line gains its third exception, and the warranty spec's revision history
records that section 17 item 29 is withdrawn - one decision, and now every
document a reader could be standing in agrees about it (R13)."
  ```

- [ ] **Push at the end of the session** (per the standing workflow), on the working branch — not directly to `main`.
  ```powershell
  git status --short
  git log --oneline -15
  git push
  ```

<!-- END TASK 15 -->

---

# Spec coverage map

Every section of `docs/superpowers/specs/2026-08-17-update-loans-design.md` maps to at least one task.

| Spec section | Requirements | Task(s) |
|---|---|---|
| §1 Overview, the dormancy rule | MUST-1.1, MUST-1.2, MUST-1.3 | Global Constraints; enforced in **3** (absence is the off state), **6** (the tick's first statement), **14** (AC4 and the integration walk) |
| §2 Architecture delta, `src/lib/update/` layout, purity | MUST-2.1, MUST-2.2, MUST-2.3 | **2** (purity at source), **4**/**5** (server-only), **14** (the source-level invariants) |
| §2.2 Files modified (exhaustive) | — | **3**–**13**, one file at a time; §19's test files in **1**–**14** |
| §3.1 No migration | MUST-3.1 | **3**; asserted in **1** (0007 carries no update object) |
| §3.2 The keys | MUST-3.2 | **3** |
| §3.3 The single reader | MUST-3.3, MUST-3.5 | **3** |
| §3.4 Disable wipes | MUST-3.4 | **3**; re-asserted in **7** (the action) and **14** (the walk) |
| §4.1 What is being asked | MUST-4.1 | **4** |
| §4.2 `github.ts` | MUST-4.2 … MUST-4.8 | **4** |
| §4.3 `semver.ts` | MUST-4.9, MUST-4.10, MUST-4.11 | **2** |
| §5.1 `check.ts` | — | **6** |
| §5.2 The tick | MUST-5.1 … MUST-5.6 | **6** |
| §5.3 The policy | MUST-5.7, MUST-5.8, MUST-5.9 | **6**; AC8's 200-pair assertion in **6**, the walk in **14** |
| §6.1 The registry entry | MUST-6.1, MUST-6.2, MUST-6.3 | **6** |
| §6.2 Rendering | MUST-6.4, MUST-6.5, MUST-6.6 | **6** |
| §7.1 The mechanism | MUST-7.1 | **5** |
| §7.2 Configuration | MUST-7.2, MUST-7.3 | **5** (env + client), **8** (the card receives one boolean) |
| §7.3 The apply and the boot reconciler | MUST-7.4 … MUST-7.7 | **5** (the request), **3** (the reconciler), **6** (the wiring) |
| §7.4 The fallback | MUST-7.8, MUST-7.9 | **5** (null config), **8** (the verbatim copy) |
| §8.1 The destination list | MUST-8.1, MUST-8.2, MUST-8.3 | **2** (the guards), **13** (the compose statement), **15** (the master spec) |
| §8.2 `assertGithubUrl` | MUST-8.4, MUST-8.5 | **2** (the guard), **4** (the call sites), **14** (the adjacency test) |
| §8.3 `assertWatchtowerUrl` | MUST-8.6, MUST-8.7 | **2**, **5** |
| §8.4 Egress-test amendments | MUST-8.8, MUST-8.9 | **14**, and **only** **14** |
| §9.1 Structure | MUST-9.1, MUST-9.2 | **8** |
| §9.2 The off state | MUST-9.3 | **8** |
| §9.3 The on state | MUST-9.4 | **8**; the dismiss action in **7** |
| §9.4 The review panel | MUST-9.5, MUST-9.6, MUST-9.7 | **8** (the panel), **7** (the two actions) |
| §9.5 After firing an apply | MUST-9.8, MUST-9.9 | **7** (the two sentences), **8** (no spinner) |
| §10.1 The actions | MUST-10.1 … MUST-10.4 | **7** |
| §10.2 Where the check runs | MUST-10.5, MUST-10.6 | **6**, **7** |
| §10.3 Rate limits | MUST-10.7 … MUST-10.10 | **7** |
| §10.4 Scrubbing | MUST-10.11 | **5** (the transport), **6** (the orchestrator) |
| §11.1 Migration discipline | MUST-11.1 … MUST-11.4 | **1** (incl. the 0006 pre-step and AC6) |
| §11.2 The money columns | MUST-11.5, MUST-11.6, MUST-11.7 | **1** (DDL), **9** (the two app-layer rules) |
| §11.3 The two anchors | MUST-11.8 | **9** (the writers), **11** (the one write site), **12** (the reconstruction) |
| §11.4 `loan_matcher_rules` | MUST-11.9 … MUST-11.12 | **1** (DDL), **10** (the uppercasing and the cap) |
| §11.5 `loan_payments` | MUST-11.13 … MUST-11.16 | **1** (DDL), **10** (the guard and the two amounts) |
| §11.6 Indexes and the mirror | MUST-11.17, MUST-11.18, MUST-11.19 | **1** |
| §11.7 Exact SQL | — | **1** |
| §12.1 The one-predicate change | MUST-12.1, MUST-12.2 | **9** |
| §12.2 The wording matrix | MUST-12.3, MUST-12.4 | **9** (the matrix), **11** (the form labels) |
| §12.3 Kind changes | MUST-12.5, MUST-12.6 | **9** |
| §13.1 The scope line | MUST-13.1, MUST-13.2 | **10** (the code), **14** (the grep invariants) |
| §13.2 `src/lib/loans.ts` | — | **10** (write side **and** the summary read model), **12** (the debt reconstruction) |
| §13.3 The matcher | MUST-13.3 … MUST-13.6 | **10** |
| §13.4 The five call sites | MUST-13.7 … MUST-13.10 | **10** |
| §13.5 Manual assign/unassign | MUST-13.11 … MUST-13.13 | **10** (domain), **11** (actions) |
| §13.6 Import undo | MUST-13.14 … MUST-13.17 | **10**; the delete-site invariant in **14** |
| §14.1 The item form | MUST-14.1 … MUST-14.4 | **11** |
| §14.2 The matcher editor | MUST-14.5 … MUST-14.7 | **11** |
| §14.3 The row control | MUST-14.8 … MUST-14.10 | **11** |
| §14.4 Server actions | MUST-14.11 … MUST-14.14 | **11** (actions), **10** (the backfill bucket) |
| §15.1 The dashboard card | MUST-15.1 … MUST-15.4 | **10** (MUST-15.4's derivations), **11** (`LoanProgressBar`, MUST-15.3), **12** (the card, MUST-15.1/15.2) |
| §15.2 The debt line | MUST-15.5 … MUST-15.9 | **12** |
| §16.1 Compose | MUST-16.1 … MUST-16.5 | **13** (incl. AC9) |
| §16.2 Existing installs | MUST-16.6, MUST-16.7 | **13** |
| §16.3 The manual updaters | MUST-16.8, MUST-16.9 | **13** |
| §17.1 Workflow bumps | MUST-17.1 | **13** |
| §17.2 The Dockerfile directive | MUST-17.2, MUST-17.3 | **13** |
| §17.3 The two vacuous tests | MUST-17.4, MUST-17.5 | **13** |
| §17.4 The relay-test title | MUST-17.6 | **13** |
| §17.5 The dead relay re-check | MUST-17.7, MUST-17.8 | **13** |
| §18 Versioning and release | MUST-18.1 … MUST-18.5 | **15** |
| §19.1 Update unit tests | MUST-19.1 | **2**, **3**, **4**, **5**, **6**, **7** |
| §19.2 Event and scheduler tests | — | **6** |
| §19.3 Update actions and client | — | **7**, **8** |
| §19.4 The registry-extension proof | MUST-19.2 | **6** (the registry), **8**'s companion assertion in `notifications-client.test.tsx` |
| §19.5 Loans database tests | MUST-19.3 | **1** |
| §19.6 Loans unit tests | — | **9**, **10**, **12** |
| §19.7 Loans actions and client | — | **11**, **12** |
| §19.8 Regression guards | MUST-19.4 | **14** |
| §19.9 Integration | MUST-19.5, MUST-19.6 | **14** |
| §20.1 Automated acceptance | AC1 … AC10 | AC1/AC2 **15**; AC3/AC7/AC10 **14**; AC4 **6**+**14**; AC5 **10**+**14**; AC6 **1**; AC8 **6**; AC9 **13** |
| §20.2 Manual QA | A1 … A18 | Final checklist below |
| §21 Decisions taken on the owner's behalf | 1–34 | Encoded as constants and comments across **1**–**14**; 33 and 34 in **13**/**14** |
| §22 Risks | R1 … R14 | R1 **2**/**14**; R2 **2**/**13**; R3 **6**; R4 **3**/**5**/**8**; R5 **13**; R6 **4**/**8**; R7 **5**/**7**/**14**; R8 **10**/**14**; R9 **10**/**11**; R10 **10**; R11 **12**; R12 **9**; R13 **1**/**9**/**15**; R14 **6** |
| §23 Out of scope | — | Nothing implemented; **2** and **6** keep the extension points open |

---

# Final acceptance checklist

Run after Task 15. Automated items must be green in CI; manual items are the once-per-release QA pass of §20.2.

**Automated (§20.1)**
- [ ] **AC1** `npm test` is green, including every test named in §19.
- [ ] **AC2** `npx tsc --noEmit` is clean under `strict`.
- [ ] **AC3** `tests/ops/notify-egress.test.ts` passes with its §8.4 amendments — the only URL literals in the two egress trees are `api.telegram.org` and `api.github.com`; every `fetch(` site is on the allowlist; each is preceded by its assert.
- [ ] **AC4** With update checks disabled, a full boot plus twelve simulated ticks produce **zero** `fetch` invocations from `src/lib/update/`.
- [ ] **AC5** With no loan matcher rules, a 500-row CSV import performs exactly one extra query on account of loans, and no `loan_payments` row is written.
- [ ] **AC6** `drizzle/0007_loans.sql` contains the statement-breakpoint marker only as a separator, and contains no update-feature object.
- [ ] **AC7** No `console.*` call in `src/lib/update/` interpolates a token or an `Authorization` value, and no returned action state contains a token substring.
- [ ] **AC8** A major version never auto-applies: over 200 generated version pairs, `classify(...) === 'major'` implies zero Watchtower requests, for every combination of `autoApply` and Watchtower presence.
- [ ] **AC9** `tests/ops/release-image.test.ts` passes with its amended Watchtower assertions — `WATCHTOWER_HTTP_API_UPDATE` and `WATCHTOWER_HTTP_API_TOKEN` present, `WATCHTOWER_POLL_INTERVAL` absent, no `ports:` block on the watchtower service, and the app service carrying both variables with a matching token.
- [ ] **AC10** `tests/ops/install.test.ts` passes with its MUST-8.9 and §16.3 amendments.
- [ ] `npm run build` succeeds and **no new route** appears in the route table.

**Manual (§20.2)**
- [ ] **A1** Fresh install, never open Settings → About: an hour's network capture shows no traffic to `api.github.com`, and `docker logs` shows no `[update]` line.
- [ ] **A2** Replace an existing pull-install's compose with the new file and start it. **Without touching anything else**, confirm the app comes up healthy, Watchtower is running, and no update happens. Then open Settings → About, press **Enable update checks**, and confirm the card moves to its on state and reports the current version as up to date. A tester who cannot find the button is a copy bug, not a tester problem.
- [ ] **A3** Publish a patch release to GHCR. With auto-apply on, wait for the daily tick (or press **Check now**) → the app is replaced and comes back on the new version within a few minutes, Settings → About shows the new number, and `update.last_applied_at` is set. Confirm the browser showed MUST-9.8's `accepted` or `accepted-unconfirmed` sentence and never a red error.
- [ ] **A4** Repeat A3 with auto-apply **off** → nothing is applied, the card offers **Update now**, and (with a channel configured) the `update_available` message arrives naming the version.
- [ ] **A5** Publish a major-numbered release → **nothing is applied under any setting**. The card offers **Review and update**; pressing it shows that version's actual changelog section; the confirm button's label carries the version. Cancel → nothing happens. Confirm → the update proceeds.
- [ ] **A6** Break `WATCHTOWER_TOKEN` in the app service only → **Update now** fails with the token message, the message contains no fragment of either token, and the app stays up.
- [ ] **A7** Remove the watchtower service entirely → the card checks and reports normally and shows §7.9's fallback copy with no apply button anywhere on the page.
- [ ] **A8** Disable update checks → every `update.` row but the flag is gone, the card returns to its off state with no cached version, and an hour's network capture is silent again.
- [ ] **A9** As a member: `/settings` shows no Updates card, and no update action succeeds from a crafted request.
- [ ] **A10** Create a loan item with a principal, a rate, a balance and a monthly payment. Confirm the form says **Payment** and **per month**, not **Billing** and **/ month**.
- [ ] **A11** Add a matcher rule with backfill **off**, then import a statement containing two payments → the balance drops by exactly those two, both appear as linked on the transactions page, and the category's budget number is **unchanged**.
- [ ] **A12** Undo that import → the balance returns to exactly its previous value, to the cent, including the case where one payment was larger than the remaining balance.
- [ ] **A13** Add a rule with backfill **on** against a year of history → the count in the success message matches the number of linked rows, and the balance drops by the reported total.
- [ ] **A14** Assign an unrelated transaction to a loan by hand, then unassign it → the balance is unchanged end to end and the row's control returns to the select.
- [ ] **A15** Dashboard: the Loans card shows the total, a payoff bar that matches the numbers, and the next payment date. Delete every loan's money fields → the card disappears entirely rather than rendering empty.
- [ ] **A16** Reports: the debt line starts at the month of the oldest balance you recorded, breaks where a loan's history is unknown, and the sentence under it explains why.
- [ ] **A17** Change a loan type's kind to Warranty → the money fields and the matching rules are gone, the payments the household made are still visible on the transactions page, and nothing 500s.
- [ ] **A18** Restore a pre-1.3.1 backup → the app boots, the four columns and two tables exist and are empty, no loan card appears, and update checks are off.
