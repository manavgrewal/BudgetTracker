# Notifications Implementation Plan (v1.3.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Settings → Notifications: two channels (per-user Telegram bot, one household SMTP relay with a per-user destination address), eight launch events behind a code-side registry, per-user per-channel toggles and knobs, per-channel Send test, built-in setup guides and a Detect-chat-ID helper — dormant until configured, so an install that never opens the page makes zero outbound connections.

**Architecture:** Five new tables (`drizzle/0006_notifications.sql`) hold the relay, per-user targets, a sparse toggle matrix, per-user knobs, and an outbox whose `UNIQUE (user_id, channel, dedup_key)` index *is* the dedup guard. A new pure-ish library tree `src/lib/notify/` holds the registry, renderers, slot arithmetic, evaluators, the outbox pump and the two transports; `src/lib/scheduler.ts` gains a five-minute tick whose first statement is a dormancy bail. Immediate events (sign-in, backup failure, restore outcome) enqueue synchronously and kick the pump without awaiting it, so their latency is seconds while the tick remains the retry-and-catch-up safety net.

**Tech Stack:** Node 22, Next.js 15 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, better-sqlite3 12, Drizzle ORM 0.x, zod 3, node-cron 3, Vitest 3 — all unchanged. Exactly one new runtime dependency: **`nodemailer`** (plus `@types/nodemailer` as a dev dependency). Telegram uses raw `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-17-notifications-design.md` (the notifications design; `MUST-n.m` labels below are its requirement numbers). Base specs: `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (master) and `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md`.

## Global Constraints

These are the spec's project-wide rules, copied verbatim from the sections named. They bind **every** task below; a task that violates one is wrong even if its own tests pass.

- **Dormancy (MUST-1.1, verbatim).** "The feature is **dormant until configured**. With no configured channel the app makes **zero** outbound network connections on account of notifications — no DNS lookup, no TCP connect, no probe, no 'are you reachable' check at boot. This is the same opt-in-egress stance the SimpleFIN connector takes (§12) and it is enforced structurally, not by convention:
  - Every one of the five new tables is created **empty** by migration 0006 and stays empty until a person fills in a form.
  - The scheduler tick's **first** action is the dormancy check of MUST-6.4; when it is dormant the tick returns before touching any evaluation or sender code.
  - The only two hosts the feature may ever contact are `api.telegram.org` and the SMTP host an admin typed in (§9)."
- **MUST-1.2 (verbatim).** "An install that never opens this page behaves exactly as v1.2.2 did."
- **Migration discipline (MUST-3.1, verbatim).** "Migrations are **append-only and hand-authored**. `drizzle-kit generate` is never run — there is no `0000_snapshot.json`, so it would diff against an empty baseline, re-emit all 24 existing tables, and silently drop every raw-SQL-only object. The order of work is fixed: 1. hand-author `drizzle/0006_notifications.sql`, 2. append the journal entry, 3. mirror the five tables in `src/db/schema.ts`."
- **Statement breakpoints (MUST-3.3, verbatim).** "Statements in the migration file are separated by the drizzle statement-breakpoint marker. **The splitter is comment-blind** — it splits on that marker and nothing else, wherever it appears, including inside a `--` comment. The marker therefore **MUST NOT** appear anywhere in the file's header comment or in any inline comment; the header below refers to it only in prose. Getting this wrong shreds the migration into fragments that fail to parse."
- **MUST-3.4 (verbatim).** "The header comment repeats the drizzle-kit warning from `0000_init.sql` and extends its running enumeration of objects that exist only in SQL, exactly as `0004_item_type_kinds.sql` does."
- **No secrets to the client (MUST-5.3, verbatim).** "No page prop, server-action return value, log line, or error message ever carries a plaintext SMTP password or bot token. The page receives `passwordSet: boolean` / `tokenSet: boolean`, never the value. The Telegram **chat id** *is* returned to the browser — the user typed it, it is not a credential, and they need to see it to check it."
- **Scrubbing (MUST-5.5, verbatim).** "`scrubSecrets(text: string, secrets: string[]): string` replaces every occurrence of every non-empty secret with `[redacted]`, and is applied to **every** string written to `last_error`, to `console.error`, or returned to the browser from a send path."
- **Purity (MUST-2.1, verbatim).** "`src/lib/notify/events.ts`, `render.ts`, `egress.ts` and `evaluate/slots.ts` are **pure**: no `@/db` import, no `@/lib/env` import, no node builtin beyond `node:crypto` (which none of them need). `events.ts` in particular is imported by the client-side event matrix, so this is the same Ruling P4 constraint that governs `src/lib/warranty/constants.ts` — importing `@/db` there fails the client webpack build outright."
- **MUST-2.2 (verbatim).** "`src/lib/notify/crypto.ts` and `send/*` are server-only and are never imported, directly or transitively, from a `*-client.tsx` file."
- **Egress (MUST-9.1, verbatim).** "Exactly two destinations are permitted, and only once configured: 1. `https://api.telegram.org` — literal origin, hard-coded. Exactly two endpoints on it: `sendMessage` (MUST-8.1) and `getUpdates` (MUST-8.6). 2. the SMTP `host`:`port` an admin entered."
- **MUST-9.1a (verbatim).** "Every external URL that appears in the setup guides of §11.7 — `telegram.org`, `brevo.com`, `smtp2go.com`, `myaccount.google.com` and the rest — is **text on the page**. Nothing in the app resolves, fetches, embeds, previews, or link-checks any of them. They are instructions for a person holding a browser, not addresses the server knows how to use."
- **CAD integer cents (master spec).** All money is integer cents: spend negative, income positive, budget limits positive. Money is formatted with `formatCents()` from `src/lib/money.ts` (MUST-10.2). Dates are ISO `YYYY-MM-DD` TEXT, month keys `YYYY-MM` TEXT, timestamps ISO datetime TEXT.
- **TypeScript strict.** `npm run typecheck` must stay clean under `strict: true` (AC2). No `any`, no `@ts-expect-error` outside a test that is asserting a type error.
- **Existing design-token UI system only (§11, verbatim).** "All existing primitives: `PageHeader`, `Card`/`CardHeader`/`CardBody`, `Notice`, `TableWrap`, `Field` and the `field-control` / `field-label` / `field-hint` classes from `src/components/ui/form.tsx`, `SubmitButton`, `btn btn--primary|--secondary|--danger`, and the `text-ink` / `text-muted` / `text-subtle` / `bg-*-soft` tokens. **No new CSS, no new design token, no new colour.**"
- **zod on every input (MUST-12.5)**, and `isSameOrigin(await headers())` **first** in every mutating server action (MUST-12.1).
- **No route handlers (MUST-12.2).** This feature adds none.
- **No new environment variable (MUST-16.4).** `.env.example` is unchanged.
- **Docker unchanged (§2).** No new asset, no new base-image package, no new writable path, no CSP change.
- **No test performs real network I/O (MUST-17.1).**

## Conventions every task must follow

- Project root for every absolute path: `c:\Users\m.grewal\OneDrive - CloverTool Mfg\Documents\Budget Tracker`. Every `npm` / `npx` / `git` command runs from there in PowerShell.
- Import alias `@/` → `src/`. Tests live under `tests/` and mirror `src/` (`src/lib/notify/outbox.ts` → `tests/lib/notify/outbox.test.ts`).
- Vitest with `globals: false` — every test file starts with an explicit `import { describe, it, expect, ... } from 'vitest';`.
- Any test touching the database uses `createTestDb()` / `createSeededTestDb()` / `insertTestUser()` from `tests/helpers/db.ts`, which installs the temp database through `setDbForTests(...)`.
- Component tests are `.test.tsx` and open with `// @vitest-environment jsdom`, then `import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';` and an `afterEach(cleanup)`.
- Server-side domain logic lives in `src/lib/notify/**`; React pages and components are thin and call it. Never put SQL in a component.
- **Commit at the end of each task** (the commit pause is lifted). Author identity is the repo's configured personal identity; do not pass `--author`. Never `--no-verify`.
- Every task ends with `npm test` green. The absolute test count grows as the plan proceeds; the signal to act on is **green vs red**, not a specific number.

<!-- END HEADER -->

---

# Phase 1 — Storage and primitives

## Task 1: Migration 0006, journal entry and the Drizzle mirror

**Context:** Spec §3 in full. Five new tables, all created empty. This task is pure schema: no application code reads these tables yet. Implements **MUST-3.1 … MUST-3.15**, **MUST-17.3** (§17.3's database test) and **AC6**.

**Files:**
- Create: `drizzle/0006_notifications.sql`
- Modify: `drizzle/meta/_journal.json` (append idx 6)
- Modify: `src/db/schema.ts` (append five table mirrors)
- Test: `tests/db/notification-schema.test.ts`

**Interfaces:**
- Consumes: `createTestDb()` from `tests/helpers/db`; `insertTestUser(db, over?)` from `tests/helpers/db`; `openDatabase(filePath)` / `getDb()` / `setDbForTests(next)` from `@/db/client`; `sqliteTable`, `integer`, `text`, `index`, `uniqueIndex`, `primaryKey` from `drizzle-orm/sqlite-core`; `users` from `@/db/schema`.
- Produces:
  ```ts
  // src/db/schema.ts — five new exports, appended in this order
  export const notificationSmtp;          // table 'notification_smtp'
  export const notificationTargets;       // table 'notification_targets'
  export const notificationPrefs;         // table 'notification_prefs'
  export const notificationUserSettings;  // table 'notification_user_settings'
  export const notificationOutbox;        // table 'notification_outbox'
  ```
  Column names available to every later task, exactly as in the DDL:
  `notification_smtp(id, preset, host, port, security, username, password_encrypted, from_email, from_name, enabled, last_error, last_error_at, last_success_at, created_at, updated_at)`;
  `notification_targets(id, user_id, channel, destination, secret_encrypted, enabled, verified_at, last_error, last_error_at, last_success_at, created_at, updated_at)`;
  `notification_prefs(user_id, event_id, channel, enabled)`;
  `notification_user_settings(user_id, coming_due_days, budget_threshold_pct, stale_import_weeks, daily_hour, digest_weekday, digest_hour, created_at, updated_at)`;
  `notification_outbox(id, user_id, channel, event_id, dedup_key, subject, body, status, attempts, next_attempt_at, last_error, created_at, sent_at)`.

### Steps

- [ ] **PRE-STEP — verify slot 0005 is taken before claiming 0006 (MUST-3.2a). If this check fails, STOP and escalate; do not renumber.**
  ```powershell
  Test-Path .\drizzle\0005_billing_cycle.sql
  Select-String -Path .\drizzle\meta\_journal.json -Pattern '"idx": 5' -SimpleMatch
  Select-String -Path .\drizzle\meta\_journal.json -Pattern '0005_billing_cycle' -SimpleMatch
  Select-String -Path .\drizzle\meta\_journal.json -Pattern '"idx": 6' -SimpleMatch
  ```
  Expected: `True`; a hit for `"idx": 5`; a hit for `0005_billing_cycle`; **no** hit for `"idx": 6`.
  - If `0005_billing_cycle.sql` is missing **or** journal idx 5 is absent: **STOP. Escalate to the user.** Notifications still takes 0006 either way (MUST-3.2a: a hole in the sequence is harmless, a reused index is not) — but a missing 0005 means the concurrent billing-cycle work was dropped or renumbered, and the owner has to say which before this plan proceeds.
  - If `"idx": 6` already exists: **STOP. Escalate.** Someone else has claimed the slot.

- [ ] **Write the failing schema test `tests/db/notification-schema.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { sql } from 'drizzle-orm';
  import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  const now = '2026-08-17T12:00:00.000Z';

  function insertSmtp(id = 1): void {
    t.sqlite
      .prepare(
        `insert into notification_smtp
           (id, preset, host, port, security, username, password_encrypted, from_email, from_name, created_at, updated_at)
         values (?, 'brevo', 'smtp-relay.brevo.com', 587, 'starttls', 'me@example.com', 'ZW5j', 'me@example.com', 'Budget Tracker', ?, ?)`,
      )
      .run(id, now, now);
  }

  describe('MUST-3.2: the journal entry', () => {
    it('records idx 6 / when 1755734400000 / tag 0006_notifications', () => {
      const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
        entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
      };
      const entry = journal.entries.find((e) => e.idx === 6);
      expect(entry).toEqual({ idx: 6, version: '6', when: 1755734400000, tag: '0006_notifications', breakpoints: true });
      // Append-only: 0005 keeps its slot (MUST-3.2a).
      expect(journal.entries.find((e) => e.idx === 5)?.tag).toBe('0005_billing_cycle');
    });
  });

  describe('AC6 / MUST-3.3: the breakpoint marker never appears inside a comment', () => {
    it('every occurrence is a statement separator', () => {
      const sqlText = fs.readFileSync(path.join(root, 'drizzle/0006_notifications.sql'), 'utf8');
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

  describe('MUST-3.13: the tables and indexes exist after migration', () => {
    it('creates all five tables', () => {
      const names = t.sqlite
        .prepare(`select name from sqlite_master where type = 'table' and name like 'notification_%' order by name`)
        .all() as { name: string }[];
      expect(names.map((r) => r.name)).toEqual([
        'notification_outbox',
        'notification_prefs',
        'notification_smtp',
        'notification_targets',
        'notification_user_settings',
      ]);
    });

    it('creates all four named indexes', () => {
      const names = t.sqlite
        .prepare(`select name from sqlite_master where type = 'index' and name like 'notification_%' order by name`)
        .all() as { name: string }[];
      expect(names.map((r) => r.name)).toEqual([
        'notification_outbox_dedup_uq',
        'notification_outbox_due_idx',
        'notification_outbox_user_idx',
        'notification_targets_user_channel_uq',
      ]);
    });

    it('stores notification_prefs WITHOUT ROWID', () => {
      const row = t.sqlite
        .prepare(`select sql from sqlite_master where type = 'table' and name = 'notification_prefs'`)
        .get() as { sql: string };
      expect(row.sql).toMatch(/WITHOUT ROWID/i);
    });

    it('leaves every table empty (MUST-1.1)', () => {
      for (const table of [
        'notification_smtp',
        'notification_targets',
        'notification_prefs',
        'notification_user_settings',
        'notification_outbox',
      ]) {
        const { n } = t.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number };
        expect(n).toBe(0);
      }
    });
  });

  describe('MUST-3.2 / §3.2: notification_smtp is a SQL-enforced singleton', () => {
    it('accepts id = 1 and rejects a second row', () => {
      insertSmtp(1);
      expect(() => insertSmtp(2)).toThrowError(/CHECK constraint failed/i);
      expect(() => insertSmtp(1)).toThrowError(/UNIQUE constraint failed/i);
    });

    it('rejects an unknown preset, an out-of-range port and an unknown security value', () => {
      expect(() =>
        t.sqlite
          .prepare(
            `insert into notification_smtp (id, preset, host, port, security, username, password_encrypted, from_email, created_at, updated_at)
             values (1, 'mailgun', 'h', 587, 'starttls', 'u', 'p', 'f@e.com', ?, ?)`,
          )
          .run(now, now),
      ).toThrowError(/CHECK constraint failed/i);
      expect(() =>
        t.sqlite
          .prepare(
            `insert into notification_smtp (id, preset, host, port, security, username, password_encrypted, from_email, created_at, updated_at)
             values (1, 'custom', 'h', 70000, 'starttls', 'u', 'p', 'f@e.com', ?, ?)`,
          )
          .run(now, now),
      ).toThrowError(/CHECK constraint failed/i);
      expect(() =>
        t.sqlite
          .prepare(
            `insert into notification_smtp (id, preset, host, port, security, username, password_encrypted, from_email, created_at, updated_at)
             values (1, 'custom', 'h', 587, 'ssl', 'u', 'p', 'f@e.com', ?, ?)`,
          )
          .run(now, now),
      ).toThrowError(/CHECK constraint failed/i);
    });
  });

  describe('§3.3: notification_targets pairing and uniqueness', () => {
    function insertTarget(userId: number, channel: string, secret: string | null): void {
      t.sqlite
        .prepare(
          `insert into notification_targets (user_id, channel, destination, secret_encrypted, created_at, updated_at)
           values (?, ?, 'dest', ?, ?, ?)`,
        )
        .run(userId, channel, secret, now, now);
    }

    it('rejects a telegram target with no secret and an email target with one', () => {
      const userId = insertTestUser(t.db);
      expect(() => insertTarget(userId, 'telegram', null)).toThrowError(/CHECK constraint failed/i);
      expect(() => insertTarget(userId, 'email', 'ZW5j')).toThrowError(/CHECK constraint failed/i);
      insertTarget(userId, 'telegram', 'ZW5j');
      insertTarget(userId, 'email', null);
    });

    it('rejects a duplicate (user_id, channel)', () => {
      const userId = insertTestUser(t.db);
      insertTarget(userId, 'telegram', 'ZW5j');
      expect(() => insertTarget(userId, 'telegram', 'ZW5j')).toThrowError(/UNIQUE constraint failed/i);
    });

    it('rejects an unknown channel', () => {
      const userId = insertTestUser(t.db);
      expect(() => insertTarget(userId, 'sms', null)).toThrowError(/CHECK constraint failed/i);
    });
  });

  describe('MUST-3.6: notification_prefs.event_id has no CHECK and no FK', () => {
    it('accepts an event_id that is not in the registry — the extension-point guarantee', () => {
      const userId = insertTestUser(t.db);
      t.sqlite
        .prepare(`insert into notification_prefs (user_id, event_id, channel, enabled) values (?, 'on_pace_overshoot', 'email', 1)`)
        .run(userId);
      const { n } = t.sqlite.prepare(`select count(*) as n from notification_prefs`).get() as { n: number };
      expect(n).toBe(1);
    });
  });

  describe('§3.5: every knob CHECK rejects 0 and the upper bound + 1', () => {
    const bounds: [string, number, number][] = [
      ['coming_due_days', 1, 365],
      ['budget_threshold_pct', 1, 99],
      ['stale_import_weeks', 1, 52],
      ['daily_hour', 0, 23],
      ['digest_weekday', 0, 6],
      ['digest_hour', 0, 23],
    ];

    for (const [column, low, high] of bounds) {
      it(`${column} accepts ${low} and ${high} but rejects ${low - 1} and ${high + 1}`, () => {
        const userId = insertTestUser(t.db);
        const write = (value: number) =>
          t.sqlite
            .prepare(
              `insert or replace into notification_user_settings (user_id, ${column}, created_at, updated_at) values (?, ?, ?, ?)`,
            )
            .run(userId, value, now, now);
        write(low);
        write(high);
        expect(() => write(low - 1)).toThrowError(/CHECK constraint failed/i);
        expect(() => write(high + 1)).toThrowError(/CHECK constraint failed/i);
      });
    }

    it('applies every documented default for an otherwise-empty row', () => {
      const userId = insertTestUser(t.db);
      t.sqlite
        .prepare(`insert into notification_user_settings (user_id, created_at, updated_at) values (?, ?, ?)`)
        .run(userId, now, now);
      const row = t.sqlite.prepare(`select * from notification_user_settings where user_id = ?`).get(userId) as Record<string, number>;
      expect(row.coming_due_days).toBe(14);
      expect(row.budget_threshold_pct).toBe(80);
      expect(row.stale_import_weeks).toBe(3);
      expect(row.daily_hour).toBe(8);
      expect(row.digest_weekday).toBe(1);
      expect(row.digest_hour).toBe(8);
    });
  });

  describe('MUST-3.9: the outbox dedup index', () => {
    function insertRow(userId: number, channel: string, dedupKey: string): number {
      const info = t.sqlite
        .prepare(
          `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, next_attempt_at, created_at)
           values (?, ?, 'coming_due', ?, 's', 'b', ?, ?) on conflict do nothing`,
        )
        .run(userId, channel, dedupKey, now, now);
      return info.changes;
    }

    it('reports changes === 0 for a duplicate (user, channel, dedup_key)', () => {
      const userId = insertTestUser(t.db);
      expect(insertRow(userId, 'telegram', 'due:1:2026-09-01')).toBe(1);
      expect(insertRow(userId, 'telegram', 'due:1:2026-09-01')).toBe(0);
      // Same key on the other channel is a different row.
      expect(insertRow(userId, 'email', 'due:1:2026-09-01')).toBe(1);
    });

    it('rejects an unknown status', () => {
      const userId = insertTestUser(t.db);
      expect(() =>
        t.sqlite
          .prepare(
            `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, status, next_attempt_at, created_at)
             values (?, 'email', 'coming_due', 'k', 's', 'b', 'queued', ?, ?)`,
          )
          .run(userId, now, now),
      ).toThrowError(/CHECK constraint failed/i);
    });
  });

  describe('§3: deleting a user cascades every child table', () => {
    it('removes targets, prefs, settings and outbox rows', () => {
      const userId = insertTestUser(t.db);
      t.sqlite
        .prepare(
          `insert into notification_targets (user_id, channel, destination, secret_encrypted, created_at, updated_at)
           values (?, 'email', 'a@b.com', null, ?, ?)`,
        )
        .run(userId, now, now);
      t.sqlite.prepare(`insert into notification_prefs (user_id, event_id, channel, enabled) values (?, 'coming_due', 'email', 1)`).run(userId);
      t.sqlite.prepare(`insert into notification_user_settings (user_id, created_at, updated_at) values (?, ?, ?)`).run(userId, now, now);
      t.sqlite
        .prepare(
          `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, next_attempt_at, created_at)
           values (?, 'email', 'coming_due', 'k', 's', 'b', ?, ?)`,
        )
        .run(userId, now, now);

      t.db.run(sql`delete from users where id = ${userId}`);

      for (const table of ['notification_targets', 'notification_prefs', 'notification_user_settings', 'notification_outbox']) {
        const { n } = t.sqlite.prepare(`select count(*) as n from ${table} where user_id = ?`).get(userId) as { n: number };
        expect(n).toBe(0);
      }
    });
  });
  ```

- [ ] **Run it and confirm it fails.**
  ```powershell
  npx vitest run tests/db/notification-schema.test.ts
  ```
  Expected failure: the journal test reports `expected undefined to deeply equal { idx: 6, ... }`, and the table tests fail with `no such table: notification_smtp`.

- [ ] **Hand-author `drizzle/0006_notifications.sql` with exactly this content (spec §3.10).** The breakpoint marker appears only between statements; the header describes it in prose (MUST-3.3).
  ```sql
  -- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
  -- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
  -- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
  -- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
  -- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
  -- src/db/schema.ts -- in that order.
  --
  -- NOTE ON SEPARATORS: drizzle's migrator splits this file on the breakpoint marker (the
  -- one written between each statement below) and on nothing else, and it does NOT skip
  -- comments. That marker must therefore never be written inside a comment -- including
  -- this one, which is why it is described here rather than quoted -- or the file is
  -- shredded into fragments that will not parse.
  --
  -- Notifications (spec 2026-08-17, v1.3.0). Five tables, ALL created empty and ALL left
  -- empty until a person fills in a form. While notification_targets has no enabled row the
  -- app makes no outbound connection on account of this feature (spec section 1.1).
  --
  -- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after
  -- this migration:
  --   1. the categories.parent_id self-referencing foreign key             (0000)
  --   2. the COALESCE(display_description, raw_description) index          (0000)
  --   3. the COALESCE month expression index                               (0000)
  --   4. every CHECK constraint on warranty_items                          (0002)
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
  CREATE TABLE `notification_smtp` (
  	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  	`preset` text NOT NULL CHECK (`preset` IN ('brevo', 'smtp2go', 'gmail', 'custom')),
  	`host` text NOT NULL,
  	`port` integer NOT NULL CHECK (`port` BETWEEN 1 AND 65535),
  	`security` text NOT NULL CHECK (`security` IN ('tls', 'starttls', 'none')),
  	`username` text NOT NULL,
  	`password_encrypted` text NOT NULL,
  	`from_email` text NOT NULL,
  	`from_name` text NOT NULL DEFAULT 'Budget Tracker',
  	`enabled` integer NOT NULL DEFAULT 1,
  	`last_error` text,
  	`last_error_at` text,
  	`last_success_at` text,
  	`created_at` text NOT NULL,
  	`updated_at` text NOT NULL
  );
  --> statement-breakpoint
  CREATE TABLE `notification_targets` (
  	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
  	`destination` text NOT NULL,
  	`secret_encrypted` text,
  	`enabled` integer NOT NULL DEFAULT 1,
  	`verified_at` text,
  	`last_error` text,
  	`last_error_at` text,
  	`last_success_at` text,
  	`created_at` text NOT NULL,
  	`updated_at` text NOT NULL,
  	CHECK (
  		(`channel` = 'telegram' AND `secret_encrypted` IS NOT NULL)
  		OR (`channel` = 'email' AND `secret_encrypted` IS NULL)
  	)
  );
  --> statement-breakpoint
  CREATE UNIQUE INDEX `notification_targets_user_channel_uq` ON `notification_targets` (`user_id`, `channel`);
  --> statement-breakpoint
  CREATE TABLE `notification_prefs` (
  	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  	`event_id` text NOT NULL,
  	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
  	`enabled` integer NOT NULL DEFAULT 0,
  	PRIMARY KEY (`user_id`, `event_id`, `channel`)
  ) WITHOUT ROWID;
  --> statement-breakpoint
  CREATE TABLE `notification_user_settings` (
  	`user_id` integer PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  	`coming_due_days` integer NOT NULL DEFAULT 14 CHECK (`coming_due_days` BETWEEN 1 AND 365),
  	`budget_threshold_pct` integer NOT NULL DEFAULT 80 CHECK (`budget_threshold_pct` BETWEEN 1 AND 99),
  	`stale_import_weeks` integer NOT NULL DEFAULT 3 CHECK (`stale_import_weeks` BETWEEN 1 AND 52),
  	`daily_hour` integer NOT NULL DEFAULT 8 CHECK (`daily_hour` BETWEEN 0 AND 23),
  	`digest_weekday` integer NOT NULL DEFAULT 1 CHECK (`digest_weekday` BETWEEN 0 AND 6),
  	`digest_hour` integer NOT NULL DEFAULT 8 CHECK (`digest_hour` BETWEEN 0 AND 23),
  	`created_at` text NOT NULL,
  	`updated_at` text NOT NULL
  );
  --> statement-breakpoint
  CREATE TABLE `notification_outbox` (
  	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  	`channel` text NOT NULL CHECK (`channel` IN ('telegram', 'email')),
  	`event_id` text NOT NULL,
  	`dedup_key` text NOT NULL,
  	`subject` text NOT NULL,
  	`body` text NOT NULL,
  	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'sent', 'failed')),
  	`attempts` integer NOT NULL DEFAULT 0,
  	`next_attempt_at` text NOT NULL,
  	`last_error` text,
  	`created_at` text NOT NULL,
  	`sent_at` text
  );
  --> statement-breakpoint
  CREATE UNIQUE INDEX `notification_outbox_dedup_uq` ON `notification_outbox` (`user_id`, `channel`, `dedup_key`);
  --> statement-breakpoint
  CREATE INDEX `notification_outbox_due_idx` ON `notification_outbox` (`status`, `next_attempt_at`);
  --> statement-breakpoint
  CREATE INDEX `notification_outbox_user_idx` ON `notification_outbox` (`user_id`, `id`);
  ```

- [ ] **Append the journal entry to `drizzle/meta/_journal.json` (MUST-3.2).** Add it after the `0005_billing_cycle` entry, inside `entries`:
  ```json
    {
      "idx": 6,
      "version": "6",
      "when": 1755734400000,
      "tag": "0006_notifications",
      "breakpoints": true
    }
  ```

- [ ] **Append the five Drizzle mirrors to the end of `src/db/schema.ts` (MUST-3.15), in this order.**
  ```ts
  /**
   * Notifications (spec 2026-08-17 §3.2). Mirrors drizzle/0006_notifications.sql.
   *
   * NOT represented here — these exist ONLY in that raw SQL file (MUST-3.4 / MUST-3.15):
   *   - CHECK (id = 1), the SQL-enforced singleton (§3.2, decision 19)
   *   - CHECK (preset IN ('brevo','smtp2go','gmail','custom'))
   *   - CHECK (port BETWEEN 1 AND 65535)
   *   - CHECK (security IN ('tls','starttls','none'))
   *
   * `password_encrypted` is base64(iv ‖ tag ‖ ciphertext), AES-256-GCM under HKDF info
   * 'notify-smtp-v1' (MUST-5.1/5.2). It is never selected into a page prop (MUST-5.3).
   */
  export const notificationSmtp = sqliteTable('notification_smtp', {
    id: integer('id').primaryKey(),
    preset: text('preset', { enum: ['brevo', 'smtp2go', 'gmail', 'custom'] }).notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    security: text('security', { enum: ['tls', 'starttls', 'none'] }).notNull(),
    username: text('username').notNull(),
    passwordEncrypted: text('password_encrypted').notNull(),
    fromEmail: text('from_email').notNull(),
    fromName: text('from_name').notNull().default('Budget Tracker'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastError: text('last_error'),
    lastErrorAt: text('last_error_at'),
    lastSuccessAt: text('last_success_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  });

  /**
   * Where one person is reached on one channel (spec §3.3).
   *
   * NOT represented here — SQL only:
   *   - CHECK (channel IN ('telegram','email'))
   *   - the channel/secret_encrypted pairing CHECK: a telegram row MUST carry a secret and
   *     an email row MUST NOT. A misconfiguration is loud rather than silent.
   *
   * `secret_encrypted` is the bot token under HKDF info 'notify-telegram-v1' (MUST-3.5:
   * each user supplies their OWN token, so one blocked bot cannot silence the household).
   */
  export const notificationTargets = sqliteTable(
    'notification_targets',
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      userId: integer('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      channel: text('channel', { enum: ['telegram', 'email'] }).notNull(),
      destination: text('destination').notNull(),
      secretEncrypted: text('secret_encrypted'),
      enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
      /** Set by a SUCCESSFUL Send test only; the UI badges an unverified channel. */
      verifiedAt: text('verified_at'),
      lastError: text('last_error'),
      lastErrorAt: text('last_error_at'),
      lastSuccessAt: text('last_success_at'),
      createdAt: text('created_at').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
    (t) => [uniqueIndex('notification_targets_user_channel_uq').on(t.userId, t.channel)],
  );

  /**
   * The sparse per-event, per-channel toggle matrix (spec §3.4).
   *
   * NOT represented here — SQL only:
   *   - CHECK (channel IN ('telegram','email'))
   *   - the WITHOUT ROWID storage class (the composite PK IS the row)
   *
   * MUST-3.6: `event_id` deliberately carries NO CHECK and NO foreign key. That is what
   * makes MUST-4.4 true — a future event type is one appended entry in
   * src/lib/notify/events.ts and nothing else. Unknown ids are ignored on read, never
   * deleted, so a downgrade-then-upgrade restores the user's choice.
   *
   * MUST-3.7: a row exists ONLY where a user actively changed a toggle. Nothing seeds this
   * table. The effective value is `row?.enabled ?? registryDefault(event_id)`.
   */
  export const notificationPrefs = sqliteTable(
    'notification_prefs',
    {
      userId: integer('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      eventId: text('event_id').notNull(),
      channel: text('channel', { enum: ['telegram', 'email'] }).notNull(),
      enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    },
    (t) => [primaryKey({ columns: [t.userId, t.eventId, t.channel] })],
  );

  /**
   * Per-user knobs (spec §3.5). One row per user, created lazily on first save — an ABSENT
   * row means every default applies, so a user who never opens the page still behaves
   * correctly.
   *
   * NOT represented here — SQL only: the six range CHECKs. MUST-3.8: these are typed
   * columns rather than a JSON blob because every one is read inside a query predicate or a
   * loop condition, and a CHECK is the cheapest defence against a stored 0 that would make
   * the scheduler nag every tick.
   */
  export const notificationUserSettings = sqliteTable('notification_user_settings', {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    comingDueDays: integer('coming_due_days').notNull().default(14),
    /** Capped at 99 on purpose: 100 is the OTHER event (§3.5). */
    budgetThresholdPct: integer('budget_threshold_pct').notNull().default(80),
    staleImportWeeks: integer('stale_import_weeks').notNull().default(3),
    dailyHour: integer('daily_hour').notNull().default(8),
    /** 0 = Sunday .. 6 = Saturday. */
    digestWeekday: integer('digest_weekday').notNull().default(1),
    digestHour: integer('digest_hour').notNull().default(8),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  });

  /**
   * The delivery queue AND the dedup guard (spec §3.6).
   *
   * NOT represented here — SQL only:
   *   - CHECK (channel IN ('telegram','email'))
   *   - CHECK (status IN ('pending','sent','failed'))
   *
   * MUST-3.9: `notification_outbox_dedup_uq` IS the dedup mechanism. Every enqueue is an
   * INSERT ... ON CONFLICT DO NOTHING and `changes === 0` means "already fired". There is no
   * separate dedup table, so the guard cannot drift from reality and a crash between
   * "decide to send" and "record that we sent" is impossible — they are one statement.
   *
   * MUST-7.2: `subject` and `body` are rendered at ENQUEUE time, not send time.
   * MUST-3.10: sent/failed rows are retained as the "Recent deliveries" list and the dedup
   * memory; only runMaintenanceSweep()'s 90-day purge removes them.
   */
  export const notificationOutbox = sqliteTable(
    'notification_outbox',
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      userId: integer('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      channel: text('channel', { enum: ['telegram', 'email'] }).notNull(),
      eventId: text('event_id').notNull(),
      dedupKey: text('dedup_key').notNull(),
      subject: text('subject').notNull(),
      body: text('body').notNull(),
      status: text('status', { enum: ['pending', 'sent', 'failed'] }).notNull().default('pending'),
      attempts: integer('attempts').notNull().default(0),
      nextAttemptAt: text('next_attempt_at').notNull(),
      lastError: text('last_error'),
      createdAt: text('created_at').notNull(),
      sentAt: text('sent_at'),
    },
    (t) => [
      uniqueIndex('notification_outbox_dedup_uq').on(t.userId, t.channel, t.dedupKey),
      index('notification_outbox_due_idx').on(t.status, t.nextAttemptAt),
      index('notification_outbox_user_idx').on(t.userId, t.id),
    ],
  );
  ```
  If `primaryKey` is not already imported at the top of `src/db/schema.ts`, add it to the existing `drizzle-orm/sqlite-core` import list.

- [ ] **Run the schema test and confirm it passes.**
  ```powershell
  npx vitest run tests/db/notification-schema.test.ts
  ```
  Expected: all suites green.

- [ ] **Type-check and run the full suite.**
  ```powershell
  npm run typecheck
  npm test
  ```
  Expected: typecheck exits 0; every existing test still passes (the migration is additive, so no existing DB test changes).

- [ ] **Commit.**
  ```powershell
  git add drizzle/0006_notifications.sql drizzle/meta/_journal.json src/db/schema.ts tests/db/notification-schema.test.ts
  git commit -m "feat(notify): add migration 0006 and the five notification tables

Hand-authored per MUST-3.1, journal idx 6 / when 1755734400000 (MUST-3.2).
Five tables created empty; the outbox unique index is the dedup guard (MUST-3.9);
notification_prefs.event_id carries no CHECK and no FK so future events need no
migration (MUST-3.6)."
  ```

<!-- END TASK 1 -->

---

## Task 2: Credential encryption and secret scrubbing

**Context:** Spec §5 in full. Implements **MUST-5.1 … MUST-5.5**. Same construction and framing as `src/lib/auth/totp.ts` and `src/lib/simplefin/crypto.ts`, two new HKDF info strings, plus the mandatory scrubber that every error path in this feature runs through.

**Files:**
- Create: `src/lib/notify/crypto.ts`
- Test: `tests/lib/notify/crypto.test.ts`

**Interfaces:**
- Consumes: `readEnv()` from `@/lib/env` (for `secretKey`); `hkdfSync`, `createCipheriv`, `createDecipheriv`, `randomBytes` from `node:crypto`; `SIMPLEFIN_HKDF_INFO`, `deriveSimplefinKey` from `@/lib/simplefin/crypto` (test only, to prove key-stream independence).
- Produces:
  ```ts
  // src/lib/notify/crypto.ts — SERVER ONLY (MUST-2.2)
  export const SMTP_HKDF_INFO = 'notify-smtp-v1';
  export const TELEGRAM_HKDF_INFO = 'notify-telegram-v1';
  export const CREDENTIAL_UNREADABLE = 'Stored credential could not be read. Re-enter it.';
  export const REDACTED = '[redacted]';
  export class NotifyCredentialError extends Error {}   // message === CREDENTIAL_UNREADABLE
  export function deriveNotifyKey(info: string, secretKey?: string): Buffer;
  export function encryptSecret(plain: string, info: string, secretKey?: string): string;
  export function decryptSecret(payload: string, info: string, secretKey?: string): string;
  export function authPlainBase64(username: string, password: string): string;
  export function scrubSecrets(text: string, secrets: string[]): string;
  ```

### Steps

- [ ] **Write the failing test `tests/lib/notify/crypto.test.ts`.**
  ```ts
  import { describe, it, expect } from 'vitest';
  import {
    CREDENTIAL_UNREADABLE,
    NotifyCredentialError,
    SMTP_HKDF_INFO,
    TELEGRAM_HKDF_INFO,
    authPlainBase64,
    decryptSecret,
    deriveNotifyKey,
    encryptSecret,
    scrubSecrets,
  } from '@/lib/notify/crypto';
  import { deriveSimplefinKey } from '@/lib/simplefin/crypto';

  const SECRET_A = 'a'.repeat(48);
  const SECRET_B = 'b'.repeat(48);
  const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';
  const PASSWORD = 'xsmtpsib-4f2a-not-a-real-key';

  describe('MUST-5.2: two distinct, pinned info strings', () => {
    it('pins the literals so stored credentials stay decryptable', () => {
      expect(SMTP_HKDF_INFO).toBe('notify-smtp-v1');
      expect(TELEGRAM_HKDF_INFO).toBe('notify-telegram-v1');
    });

    it('derives 32-byte keys that differ per info and per SECRET_KEY', () => {
      const smtp = deriveNotifyKey(SMTP_HKDF_INFO, SECRET_A);
      const telegram = deriveNotifyKey(TELEGRAM_HKDF_INFO, SECRET_A);
      expect(smtp).toHaveLength(32);
      expect(smtp.equals(deriveNotifyKey(SMTP_HKDF_INFO, SECRET_A))).toBe(true);
      expect(smtp.equals(telegram)).toBe(false);
      expect(smtp.equals(deriveNotifyKey(SMTP_HKDF_INFO, SECRET_B))).toBe(false);
    });

    it('is a different key stream from the SimpleFIN one', () => {
      expect(deriveNotifyKey(SMTP_HKDF_INFO, SECRET_A).equals(deriveSimplefinKey(SECRET_A))).toBe(false);
      expect(deriveNotifyKey(TELEGRAM_HKDF_INFO, SECRET_A).equals(deriveSimplefinKey(SECRET_A))).toBe(false);
    });
  });

  describe('MUST-5.1: AES-256-GCM, base64(iv[12] || tag[16] || ciphertext)', () => {
    it('round-trips under each info string', () => {
      expect(decryptSecret(encryptSecret(PASSWORD, SMTP_HKDF_INFO, SECRET_A), SMTP_HKDF_INFO, SECRET_A)).toBe(PASSWORD);
      expect(decryptSecret(encryptSecret(TOKEN, TELEGRAM_HKDF_INFO, SECRET_A), TELEGRAM_HKDF_INFO, SECRET_A)).toBe(TOKEN);
    });

    it('frames the payload exactly', () => {
      const raw = Buffer.from(encryptSecret(TOKEN, TELEGRAM_HKDF_INFO, SECRET_A), 'base64');
      expect(raw.length).toBe(12 + 16 + Buffer.byteLength(TOKEN, 'utf8'));
      expect(raw.subarray(28).toString('utf8')).not.toContain('AAHk3f');
    });

    it('produces a fresh IV every time', () => {
      expect(encryptSecret(TOKEN, TELEGRAM_HKDF_INFO, SECRET_A)).not.toBe(encryptSecret(TOKEN, TELEGRAM_HKDF_INFO, SECRET_A));
    });

    it('cannot decrypt the other info string\u2019s payload', () => {
      const smtpPayload = encryptSecret(PASSWORD, SMTP_HKDF_INFO, SECRET_A);
      expect(() => decryptSecret(smtpPayload, TELEGRAM_HKDF_INFO, SECRET_A)).toThrowError(NotifyCredentialError);
    });

    it('produces different ciphertext for identical plaintext under the two infos', () => {
      const a = Buffer.from(encryptSecret(PASSWORD, SMTP_HKDF_INFO, SECRET_A), 'base64').subarray(28);
      const b = Buffer.from(encryptSecret(PASSWORD, TELEGRAM_HKDF_INFO, SECRET_A), 'base64').subarray(28);
      expect(a.equals(b)).toBe(false);
    });

    it('refuses a tampered tag, the wrong key, and a payload of 28 bytes or fewer', () => {
      const payload = encryptSecret(PASSWORD, SMTP_HKDF_INFO, SECRET_A);
      const raw = Buffer.from(payload, 'base64');
      raw[13] ^= 0xff; // inside the tag
      expect(() => decryptSecret(raw.toString('base64'), SMTP_HKDF_INFO, SECRET_A)).toThrowError(NotifyCredentialError);
      expect(() => decryptSecret(payload, SMTP_HKDF_INFO, SECRET_B)).toThrowError(NotifyCredentialError);
      expect(() => decryptSecret(Buffer.alloc(28).toString('base64'), SMTP_HKDF_INFO, SECRET_A)).toThrowError(
        NotifyCredentialError,
      );
    });

    it('MUST-5.4: every failure carries the one user-facing sentence', () => {
      try {
        decryptSecret(Buffer.alloc(20).toString('base64'), SMTP_HKDF_INFO, SECRET_A);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NotifyCredentialError);
        expect((error as Error).message).toBe(CREDENTIAL_UNREADABLE);
        expect(CREDENTIAL_UNREADABLE).toBe('Stored credential could not be read. Re-enter it.');
      }
    });
  });

  describe('MUST-5.5: scrubSecrets is load-bearing, not defensive', () => {
    it('redacts a raw token and a raw password anywhere in the text', () => {
      expect(scrubSecrets(`auth failed for ${PASSWORD} twice: ${PASSWORD}`, [PASSWORD])).toBe(
        'auth failed for [redacted] twice: [redacted]',
      );
    });

    it('redacts the token embedded in a Telegram URL path — the reason this exists', () => {
      const message = `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`;
      const scrubbed = scrubSecrets(message, [TOKEN]);
      expect(scrubbed).toBe('request to https://api.telegram.org/bot[redacted]/sendMessage failed');
      expect(scrubbed).not.toContain('AAHk3f');
    });

    it('redacts the base64 AUTH PLAIN form nodemailer quotes back', () => {
      const authPlain = authPlainBase64('me@example.com', PASSWORD);
      expect(Buffer.from(authPlain, 'base64').toString('utf8')).toBe(`\0me@example.com\0${PASSWORD}`);
      const message = `535 5.7.8 Authentication failed: AUTH PLAIN ${authPlain}`;
      const scrubbed = scrubSecrets(message, [PASSWORD, authPlain]);
      expect(scrubbed).not.toContain(authPlain);
      expect(scrubbed).toContain('[redacted]');
    });

    it('ignores empty and whitespace-only secrets rather than redacting everything', () => {
      expect(scrubSecrets('nothing secret here', ['', '   '])).toBe('nothing secret here');
    });

    it('handles regex metacharacters in a secret literally', () => {
      expect(scrubSecrets('key is a.b*c', ['a.b*c'])).toBe('key is [redacted]');
      expect(scrubSecrets('key is axbyc', ['a.b*c'])).toBe('key is axbyc');
    });
  });
  ```

- [ ] **Run it and confirm it fails.**
  ```powershell
  npx vitest run tests/lib/notify/crypto.test.ts
  ```
  Expected failure:
  ```
  Error: Failed to resolve import "@/lib/notify/crypto" from "tests/lib/notify/crypto.test.ts". Does the file exist?
  ```

- [ ] **Implement `src/lib/notify/crypto.ts`.**
  ```ts
  import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
  import { readEnv } from '@/lib/env';

  /**
   * Same construction and framing as src/lib/auth/totp.ts and src/lib/simplefin/crypto.ts
   * (MUST-5.1): AES-256-GCM under hkdfSync('sha256', SECRET_KEY, <empty salt>, <info>, 32),
   * stored as base64(iv ‖ tag ‖ ciphertext) with a 12-byte IV and a 16-byte tag.
   *
   * MUST-5.2: two distinct info strings, so the SMTP password and the Telegram bot tokens
   * have independent key streams and neither is interchangeable with a TOTP secret or the
   * SimpleFIN access URL.
   *
   * SERVER ONLY (MUST-2.2): never imported from a *-client.tsx file.
   */
  export const SMTP_HKDF_INFO = 'notify-smtp-v1';
  export const TELEGRAM_HKDF_INFO = 'notify-telegram-v1';

  /** MUST-5.4: the one sentence a decrypt failure ever presents as. Never a 500. */
  export const CREDENTIAL_UNREADABLE = 'Stored credential could not be read. Re-enter it.';
  export const REDACTED = '[redacted]';

  const IV_BYTES = 12;
  const TAG_BYTES = 16;

  export class NotifyCredentialError extends Error {
    constructor(message: string = CREDENTIAL_UNREADABLE) {
      super(message);
      this.name = 'NotifyCredentialError';
    }
  }

  export function deriveNotifyKey(info: string, secretKey: string = readEnv().secretKey): Buffer {
    const derived = hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32);
    return Buffer.from(derived);
  }

  export function encryptSecret(plain: string, info: string, secretKey?: string): string {
    const key = deriveNotifyKey(info, secretKey);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  /**
   * MUST-5.4: a rotated SECRET_KEY, a truncated column, a tampered tag — every one of them
   * surfaces as NotifyCredentialError carrying CREDENTIAL_UNREADABLE. The underlying error
   * is logged WITHOUT the payload, exactly as attemptLogin handles a TOTP decrypt failure.
   */
  export function decryptSecret(payload: string, info: string, secretKey?: string): string {
    const raw = Buffer.from(payload, 'base64');
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new NotifyCredentialError();
    try {
      const key = deriveNotifyKey(info, secretKey);
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch (error) {
      console.error('[notify] stored credential failed to decrypt', {
        info,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw new NotifyCredentialError();
    }
  }

  /**
   * The exact bytes an SMTP relay sees for AUTH PLAIN, base64-encoded. nodemailer's
   * authentication errors routinely quote the failing command line back, and on some relays
   * that line contains this string — so it is scrubbed alongside the raw password (MUST-5.5).
   */
  export function authPlainBase64(username: string, password: string): string {
    return Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * MUST-5.5: applied to EVERY string written to last_error, to console.error, or returned
   * to the browser from a send path. Two concrete reasons this is load-bearing rather than
   * belt-and-braces: the Telegram bot token is in the request URL path, so any fetch error
   * that echoes the URL echoes the credential; and nodemailer quotes the failing SMTP
   * command line, which can include the base64 AUTH PLAIN payload.
   */
  export function scrubSecrets(text: string, secrets: string[]): string {
    let out = text;
    for (const secret of secrets) {
      if (typeof secret !== 'string') continue;
      const trimmed = secret.trim();
      if (trimmed.length === 0) continue;
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
      if (trimmed !== secret) out = out.replace(new RegExp(escapeRegExp(trimmed), 'g'), REDACTED);
    }
    return out;
  }
  ```

- [ ] **Run the test and confirm it passes.**
  ```powershell
  npx vitest run tests/lib/notify/crypto.test.ts
  ```
  Expected: all suites green.

- [ ] **Type-check and run the full suite.**
  ```powershell
  npm run typecheck
  npm test
  ```
  Expected: typecheck exits 0, suite green.

- [ ] **Commit.**
  ```powershell
  git add src/lib/notify/crypto.ts tests/lib/notify/crypto.test.ts
  git commit -m "feat(notify): credential encryption and mandatory secret scrubbing

AES-256-GCM under two new HKDF infos, notify-smtp-v1 and notify-telegram-v1
(MUST-5.1/5.2). A decrypt failure is NotifyCredentialError carrying the one
user-facing sentence, never a 500 (MUST-5.4). scrubSecrets covers the raw
credential, the token in a Telegram URL path, and the base64 AUTH PLAIN form
(MUST-5.5)."
  ```

<!-- END TASK 2 -->

---

## Task 3: The event registry, dedup keys and the egress guard

**Context:** Spec §4 and §9.2. Implements **MUST-2.1** (purity), **MUST-3.11 / MUST-3.12** (the dedup key shapes), **MUST-4.1 … MUST-4.5**, **MUST-9.2**. These are the two purest modules in the feature — `events.ts` is imported by the client-side matrix, so an `@/db` import here fails the client webpack build outright.

**Ambiguity resolved:** the spec lists the dedup key strings in a table (MUST-3.11) but gives them no home file. They live in `events.ts`: they are pure string builders, registry-adjacent, and keeping them beside the ids means a new event's key is written next to its definition.

**Files:**
- Create: `src/lib/notify/events.ts`
- Create: `src/lib/notify/egress.ts`
- Test: `tests/lib/notify/events.test.ts`, `tests/lib/notify/egress.test.ts`

**Interfaces:**
- Consumes: nothing. Both modules import nothing at all (MUST-2.1).
- Produces:
  ```ts
  // src/lib/notify/events.ts — PURE, client-safe (MUST-2.1)
  export type Channel = 'telegram' | 'email';
  export const CHANNELS: readonly Channel[];                       // ['telegram', 'email']
  export function isChannel(value: string): value is Channel;
  export type BudgetScopeKey = 'household' | 'personal';
  export type NotificationAudience = 'all' | 'admin';
  export type NotificationTrigger = 'daily_slot' | 'weekly_slot' | 'tick' | 'immediate';
  export interface NotificationEventDef {
    readonly id: string;
    readonly label: string;
    readonly blurb: string;
    readonly audience: NotificationAudience;
    readonly trigger: NotificationTrigger;
    readonly defaultEnabled: boolean;
  }
  export const NOTIFICATION_EVENTS: readonly NotificationEventDef[];
  export function eventDef(id: string): NotificationEventDef | undefined;
  export function isNotificationEventId(value: string): boolean;
  export function eventsFor(role: 'admin' | 'member'): readonly NotificationEventDef[];
  export function comingDueKey(itemId: number, expiryDate: string): string;
  export function budgetThresholdKey(scope: BudgetScopeKey, categoryId: number, month: string, pct: number): string;
  export function budgetExceededKey(scope: BudgetScopeKey, categoryId: number, month: string): string;
  export function backupFailedKey(dateIso: string): string;
  export function weeklyDigestKey(slotDateIso: string): string;
  export function newSigninKey(sessionCreatedAt: string): string;
  export function restoreOutcomeKey(finishedAt: string): string;
  export function staleImportKey(mondayIso: string): string;

  // src/lib/notify/egress.ts — PURE (MUST-2.1)
  export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
  export function assertTelegramUrl(url: string): void;   // throws unless origin matches exactly
  ```

### Steps

- [ ] **Write the failing test `tests/lib/notify/events.test.ts`.**
  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import {
    CHANNELS,
    NOTIFICATION_EVENTS,
    backupFailedKey,
    budgetExceededKey,
    budgetThresholdKey,
    comingDueKey,
    eventDef,
    eventsFor,
    isChannel,
    isNotificationEventId,
    newSigninKey,
    restoreOutcomeKey,
    staleImportKey,
    weeklyDigestKey,
  } from '@/lib/notify/events';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

  describe('MUST-2.1: events.ts is pure and client-safe', () => {
    it('imports neither @/db nor @/lib/env nor any node builtin', () => {
      const source = fs.readFileSync(path.join(root, 'src/lib/notify/events.ts'), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/env/);
      expect(source).not.toMatch(/from\s+['"]node:/);
    });
  });

  describe('§4.2: the eight launch events', () => {
    it('has exactly eight entries with unique, well-formed ids', () => {
      expect(NOTIFICATION_EVENTS).toHaveLength(8);
      const ids = NOTIFICATION_EVENTS.map((e) => e.id);
      expect(new Set(ids).size).toBe(8);
      for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('matches the spec table exactly', () => {
      expect(
        NOTIFICATION_EVENTS.map((e) => [e.id, e.audience, e.trigger, e.defaultEnabled] as const),
      ).toEqual([
        ['coming_due', 'all', 'daily_slot', true],
        ['budget_threshold', 'all', 'tick', false],
        ['budget_exceeded', 'all', 'tick', true],
        ['backup_failed', 'admin', 'immediate', true],
        ['weekly_digest', 'all', 'weekly_slot', false],
        ['new_signin', 'all', 'immediate', true],
        ['restore_outcome', 'admin', 'immediate', true],
        ['stale_import', 'all', 'daily_slot', false],
      ]);
    });

    it('MUST-4.1: the default-on set is the wrong-or-imminent half', () => {
      const on = NOTIFICATION_EVENTS.filter((e) => e.defaultEnabled).map((e) => e.id).sort();
      expect(on).toEqual(['backup_failed', 'budget_exceeded', 'coming_due', 'new_signin', 'restore_outcome']);
    });

    it('gives every event a label and a one-sentence blurb', () => {
      for (const event of NOTIFICATION_EVENTS) {
        expect(event.label.length).toBeGreaterThan(0);
        expect(event.blurb.length).toBeGreaterThan(0);
      }
    });
  });

  describe('lookup helpers', () => {
    it('eventDef resolves a known id and returns undefined for an unknown one', () => {
      expect(eventDef('coming_due')?.label).toBe('Something is coming due');
      expect(eventDef('on_pace_overshoot')).toBeUndefined();
      expect(isNotificationEventId('coming_due')).toBe(true);
      expect(isNotificationEventId('on_pace_overshoot')).toBe(false);
    });

    it('MUST-4.3: eventsFor("member") excludes both admin events', () => {
      expect(eventsFor('member').map((e) => e.id)).not.toContain('backup_failed');
      expect(eventsFor('member').map((e) => e.id)).not.toContain('restore_outcome');
      expect(eventsFor('member')).toHaveLength(6);
      expect(eventsFor('admin')).toHaveLength(8);
    });

    it('exposes the two channels', () => {
      expect(CHANNELS).toEqual(['telegram', 'email']);
      expect(isChannel('telegram')).toBe(true);
      expect(isChannel('sms')).toBe(false);
    });
  });

  describe('MUST-3.11: the exact dedup key strings', () => {
    it('builds every key shape in the table', () => {
      expect(comingDueKey(42, '2026-09-01')).toBe('due:42:2026-09-01');
      expect(budgetThresholdKey('household', 7, '2026-08', 80)).toBe('budget:h:7:2026-08:80');
      expect(budgetThresholdKey('personal', 7, '2026-08', 90)).toBe('budget:p:7:2026-08:90');
      expect(budgetExceededKey('household', 7, '2026-08')).toBe('budget:h:7:2026-08:100');
      expect(budgetExceededKey('personal', 7, '2026-08')).toBe('budget:p:7:2026-08:100');
      expect(backupFailedKey('2026-08-17')).toBe('backup-failed:2026-08-17');
      expect(weeklyDigestKey('2026-08-17')).toBe('digest:2026-08-17');
      expect(newSigninKey('2026-08-17T12:00:00.000Z')).toBe('signin:2026-08-17T12:00:00.000Z');
      expect(restoreOutcomeKey('2026-08-17T12:00:00.000Z')).toBe('restore:2026-08-17T12:00:00.000Z');
      expect(staleImportKey('2026-08-17')).toBe('stale:2026-08-17');
    });

    it('never repeats user or channel inside the key — the unique index already carries them', () => {
      for (const key of [
        comingDueKey(42, '2026-09-01'),
        budgetThresholdKey('household', 7, '2026-08', 80),
        backupFailedKey('2026-08-17'),
      ]) {
        expect(key).not.toMatch(/telegram|email|user/);
      }
    });

    it('a threshold key and an exceeded key for the same category and month never collide', () => {
      expect(budgetThresholdKey('household', 7, '2026-08', 99)).not.toBe(budgetExceededKey('household', 7, '2026-08'));
    });

    it('household and personal are two different facts for the same category', () => {
      expect(budgetExceededKey('household', 7, '2026-08')).not.toBe(budgetExceededKey('personal', 7, '2026-08'));
    });
  });
  ```

- [ ] **Write the failing test `tests/lib/notify/egress.test.ts`.**
  ```ts
  import { describe, it, expect } from 'vitest';
  import { TELEGRAM_API_ORIGIN, assertTelegramUrl } from '@/lib/notify/egress';

  describe('MUST-9.2: assertTelegramUrl', () => {
    it('pins the one permitted Telegram origin', () => {
      expect(TELEGRAM_API_ORIGIN).toBe('https://api.telegram.org');
    });

    it('accepts the two permitted endpoints on that origin', () => {
      expect(() => assertTelegramUrl(`${TELEGRAM_API_ORIGIN}/bot123:abc/sendMessage`)).not.toThrow();
      expect(() =>
        assertTelegramUrl(`${TELEGRAM_API_ORIGIN}/bot123:abc/getUpdates?limit=100&allowed_updates=%5B%22message%22%5D`),
      ).not.toThrow();
    });

    it('rejects a look-alike host, plain HTTP, another port, and a userinfo trick', () => {
      for (const url of [
        'https://api.telegram.org.evil.com/bot123/sendMessage',
        'http://api.telegram.org/bot123/sendMessage',
        'https://api.telegram.org:8443/bot123/sendMessage',
        'https://api.telegram.org@evil.com/bot123/sendMessage',
        'https://evil.com/api.telegram.org/bot123/sendMessage',
      ]) {
        expect(() => assertTelegramUrl(url)).toThrowError(/telegram/i);
      }
    });

    it('rejects a token that smuggles a host into the path', () => {
      // The token is interpolated into the PATH, so a token containing a slash and a host
      // would otherwise change where the request goes.
      const badToken = '123:abc/../../@evil.com';
      expect(() => assertTelegramUrl(new URL(`/bot${badToken}/sendMessage`, TELEGRAM_API_ORIGIN).toString())).toThrow();
    });

    it('rejects a string that is not a URL at all', () => {
      expect(() => assertTelegramUrl('not a url')).toThrowError(/telegram/i);
    });
  });
  ```

- [ ] **Run both and confirm they fail.**
  ```powershell
  npx vitest run tests/lib/notify/events.test.ts tests/lib/notify/egress.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/notify/events"` and `"@/lib/notify/egress"`.

- [ ] **Implement `src/lib/notify/events.ts`.**
  ```ts
  /**
   * The event registry (spec §4) — PURE and client-safe (MUST-2.1). No @/db import, no
   * @/lib/env import, no node builtin: this module is imported by the client-side toggle
   * matrix, and importing @/db here fails the client webpack build outright (Ruling P4, the
   * same constraint that governs src/lib/warranty/constants.ts).
   *
   * MUST-4.4 — the extension point. Adding an event type is: append one entry below, add
   * one case to renderEvent() in render.ts, and — for a scheduled event — one evaluator
   * call. No migration. No src/db/schema.ts change. No UI change: the matrix is generated
   * from this array.
   *
   * MUST-4.5 — an `id` is PERMANENT once shipped. notification_prefs keys on the string, so
   * renaming one silently resets every user's stored preference for it.
   */
  export type Channel = 'telegram' | 'email';
  export const CHANNELS: readonly Channel[] = ['telegram', 'email'];

  export function isChannel(value: string): value is Channel {
    return value === 'telegram' || value === 'email';
  }

  /** `h` for a household budget, `p` for the recipient's personal one (MUST-3.11). */
  export type BudgetScopeKey = 'household' | 'personal';

  export type NotificationAudience = 'all' | 'admin';
  export type NotificationTrigger = 'daily_slot' | 'weekly_slot' | 'tick' | 'immediate';

  export interface NotificationEventDef {
    /** The stable storage key. Never renamed once shipped (MUST-4.5). */
    readonly id: string;
    readonly label: string;
    /** One sentence under the label in the toggle matrix. */
    readonly blurb: string;
    readonly audience: NotificationAudience;
    readonly trigger: NotificationTrigger;
    readonly defaultEnabled: boolean;
  }

  /**
   * MUST-4.1: the defaults split on one line — ON for "something is wrong, or a deadline is
   * near"; OFF for the chattier informational events a person should opt into. new_signin
   * is on because a security event nobody switched on protects nobody.
   *
   * MUST-4.2: a default of ON has effect only once a channel exists. A user with no
   * notification_targets row receives nothing, defaults notwithstanding.
   */
  export const NOTIFICATION_EVENTS: readonly NotificationEventDef[] = [
    {
      id: 'coming_due',
      label: 'Something is coming due',
      blurb: 'A warranty, subscription, contract or loan reaches its date soon.',
      audience: 'all',
      trigger: 'daily_slot',
      defaultEnabled: true,
    },
    {
      id: 'budget_threshold',
      label: 'A budget is getting close',
      blurb: 'A category has passed the percentage you set for this month.',
      audience: 'all',
      trigger: 'tick',
      defaultEnabled: false,
    },
    {
      id: 'budget_exceeded',
      label: 'A budget is blown',
      blurb: 'A category has spent more than its limit for this month.',
      audience: 'all',
      trigger: 'tick',
      defaultEnabled: true,
    },
    {
      id: 'backup_failed',
      label: 'The nightly backup failed',
      blurb: 'The unattended 2am backup did not complete.',
      audience: 'admin',
      trigger: 'immediate',
      defaultEnabled: true,
    },
    {
      id: 'weekly_digest',
      label: 'Weekly spending summary',
      blurb: 'What the household spent over the last seven days.',
      audience: 'all',
      trigger: 'weekly_slot',
      defaultEnabled: false,
    },
    {
      id: 'new_signin',
      label: 'New sign-in to your account',
      blurb: 'Somebody signed in as you, from somewhere.',
      audience: 'all',
      trigger: 'immediate',
      defaultEnabled: true,
    },
    {
      id: 'restore_outcome',
      label: 'A restore finished',
      blurb: 'A backup was restored into this install, successfully or not.',
      audience: 'admin',
      trigger: 'immediate',
      defaultEnabled: true,
    },
    {
      id: 'stale_import',
      label: 'Nothing has been imported lately',
      blurb: 'No bank export has landed for the number of weeks you set.',
      audience: 'all',
      trigger: 'daily_slot',
      defaultEnabled: false,
    },
  ];

  export function eventDef(id: string): NotificationEventDef | undefined {
    return NOTIFICATION_EVENTS.find((event) => event.id === id);
  }

  export function isNotificationEventId(value: string): boolean {
    return eventDef(value) !== undefined;
  }

  /**
   * MUST-4.3: audience 'admin' events are never enqueued for a member, never rendered in a
   * member's matrix, and are skipped for a user who has since been demoted.
   */
  export function eventsFor(role: 'admin' | 'member'): readonly NotificationEventDef[] {
    return role === 'admin' ? NOTIFICATION_EVENTS : NOTIFICATION_EVENTS.filter((event) => event.audience === 'all');
  }

  /**
   * MUST-3.11 — the dedup keys, exactly. user_id and channel are already part of the unique
   * index (MUST-3.9) and are never repeated inside a key.
   *
   * MUST-3.12 (pruning safety): every key below is either bounded to a calendar period that
   * evaluation only visits within the current few days, or derived from a monotonically
   * increasing timestamp that never recurs — so the 90-day retention sweep can never
   * resurrect an already-delivered event.
   */
  function scopeLetter(scope: BudgetScopeKey): 'h' | 'p' {
    return scope === 'household' ? 'h' : 'p';
  }

  /** Once per item per expiry date, EVER. Editing the date is a new fact and a new key. */
  export function comingDueKey(itemId: number, expiryDate: string): string {
    return `due:${itemId}:${expiryDate}`;
  }

  /** Once per scope/category/month/threshold. The pct is the user's configured threshold. */
  export function budgetThresholdKey(scope: BudgetScopeKey, categoryId: number, month: string, pct: number): string {
    return `budget:${scopeLetter(scope)}:${categoryId}:${month}:${pct}`;
  }

  /** Once per scope/category/month. Pinned at 100 so it can never collide with a threshold. */
  export function budgetExceededKey(scope: BudgetScopeKey, categoryId: number, month: string): string {
    return `budget:${scopeLetter(scope)}:${categoryId}:${month}:100`;
  }

  export function backupFailedKey(dateIso: string): string {
    return `backup-failed:${dateIso}`;
  }

  export function weeklyDigestKey(slotDateIso: string): string {
    return `digest:${slotDateIso}`;
  }

  export function newSigninKey(sessionCreatedAt: string): string {
    return `signin:${sessionCreatedAt}`;
  }

  export function restoreOutcomeKey(finishedAt: string): string {
    return `restore:${finishedAt}`;
  }

  export function staleImportKey(mondayIso: string): string {
    return `stale:${mondayIso}`;
  }
  ```

- [ ] **Implement `src/lib/notify/egress.ts`.**
  ```ts
  /**
   * MUST-9.1 / MUST-9.2 — the egress policy, in code. PURE (MUST-2.1).
   *
   * Exactly two destinations are permitted, and only once configured: this origin (two
   * endpoints on it, sendMessage and getUpdates) and the SMTP host an admin typed in.
   *
   * send/telegram.ts calls assertTelegramUrl() on the URL it is about to fetch, immediately
   * before the fetch. The bot token is interpolated into the PATH, so this guard also
   * catches a malformed token that manages to inject a host.
   *
   * This module holds the ONLY `://` URL literal anywhere under src/lib/notify/, and
   * tests/ops/notify-egress.test.ts fails the build if a second one appears (MUST-9.4).
   */
  export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

  export function assertTelegramUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`refusing a non-URL Telegram request target`);
    }
    // `origin` folds scheme, host and port together, and a userinfo section
    // ("https://api.telegram.org@evil.com") lands in `host`, so this single comparison
    // covers every look-alike shape.
    if (parsed.origin !== TELEGRAM_API_ORIGIN || parsed.username !== '' || parsed.password !== '') {
      throw new Error(`refusing a Telegram request to a non-permitted origin`);
    }
  }
  ```

- [ ] **Run both tests and confirm they pass.**
  ```powershell
  npx vitest run tests/lib/notify/events.test.ts tests/lib/notify/egress.test.ts
  ```
  Expected: green.

- [ ] **Type-check and run the full suite, then commit.**
  ```powershell
  npm run typecheck
  npm test
  git add src/lib/notify/events.ts src/lib/notify/egress.ts tests/lib/notify/events.test.ts tests/lib/notify/egress.test.ts
  git commit -m "feat(notify): event registry, dedup keys and the Telegram egress guard

Eight launch events behind a pure, client-safe registry (MUST-4.1..4.5); the
exact dedup key strings of MUST-3.11 live beside the ids; assertTelegramUrl
pins the one permitted origin (MUST-9.2)."
  ```

<!-- END TASK 3 -->

---

## Task 4: Config store — relay, targets, prefs, knobs and `isEventEnabled`

**Context:** Spec §3.2–§3.5, §4.3, §8.15. Implements **MUST-3.5, MUST-3.7, MUST-4.2, MUST-4.3, MUST-5.3, MUST-5.4, MUST-8.15**, and §17.1's `config.test.ts`. This is the only module that reads or writes the four configuration tables; nothing else touches them.

**Ambiguity resolved:** §4.3 shows `isEventEnabled` as a bare function with no module. It lives here, in `config.ts`, because it needs all five of its conditions from these tables and §4.3 requires that "no caller re-implements any part of it".

**Files:**
- Create: `src/lib/notify/config.ts`
- Test: `tests/lib/notify/config.test.ts`

**Interfaces:**
- Consumes: `getDb()` from `@/db/client`; `notificationSmtp`, `notificationTargets`, `notificationPrefs`, `notificationUserSettings`, `users` from `@/db/schema`; `and`, `eq`, `sql` from `drizzle-orm`; `nowIso(at?)` from `@/lib/clock`; `Channel`, `eventDef` from `@/lib/notify/events`; `SMTP_HKDF_INFO`, `TELEGRAM_HKDF_INFO`, `decryptSecret`, `encryptSecret` from `@/lib/notify/crypto`.
- Produces:
  ```ts
  // src/lib/notify/config.ts — SERVER ONLY
  export type SmtpPreset = 'brevo' | 'smtp2go' | 'gmail' | 'custom';
  export type SmtpSecurity = 'tls' | 'starttls' | 'none';
  export interface SmtpPresetDefaults { host: string; port: number; security: SmtpSecurity }
  export const SMTP_PRESETS: Record<SmtpPreset, SmtpPresetDefaults>;
  export interface SmtpRecord {
    preset: SmtpPreset; host: string; port: number; security: SmtpSecurity; username: string;
    fromEmail: string; fromName: string; enabled: boolean; passwordSet: boolean;
    lastError: string | null; lastErrorAt: string | null; lastSuccessAt: string | null;
  }
  export function getSmtp(): SmtpRecord | null;
  export function getSmtpPassword(): string;                       // throws NotifyCredentialError
  export function saveSmtp(input: {
    preset: SmtpPreset; host: string; port: number; security: SmtpSecurity; username: string;
    password: string | null; fromEmail: string; fromName: string; enabled: boolean; at?: Date;
  }): void;
  export function removeSmtp(): void;
  export function recordSmtpOutcome(input: { ok: boolean; error?: string; at?: Date }): void;

  export interface TargetRecord {
    id: number; userId: number; channel: Channel; destination: string; secretSet: boolean;
    enabled: boolean; verifiedAt: string | null;
    lastError: string | null; lastErrorAt: string | null; lastSuccessAt: string | null;
  }
  export function getTarget(userId: number, channel: Channel): TargetRecord | null;
  export function listTargets(userId: number): TargetRecord[];
  export function getTelegramToken(userId: number): string;        // throws NotifyCredentialError
  export function saveTelegramTarget(input: { userId: number; destination: string; botToken: string | null; enabled: boolean; at?: Date }): void;
  export function saveEmailTarget(input: { userId: number; destination: string; enabled: boolean; at?: Date }): void;
  export function removeTarget(userId: number, channel: Channel): void;
  export function recordTargetOutcome(input: { userId: number; channel: Channel; ok: boolean; error?: string; verify?: boolean; at?: Date }): void;
  export function hasAnyEnabledTarget(): boolean;

  export interface UserSettings {
    comingDueDays: number; budgetThresholdPct: number; staleImportWeeks: number;
    dailyHour: number; digestWeekday: number; digestHour: number;
  }
  export const DEFAULT_USER_SETTINGS: UserSettings;
  export function getUserSettings(userId: number): UserSettings;
  export function saveUserSettings(userId: number, next: UserSettings, at?: Date): void;

  export function getPrefs(userId: number): Record<string, boolean>;   // key `${eventId}:${channel}`
  export function setPref(userId: number, eventId: string, channel: Channel, enabled: boolean): void;
  export function clearPref(userId: number, eventId: string, channel: Channel): void;
  /** MUST-3.7: writes a row only when `enabled` differs from the registry default, and
   *  deletes any existing row when it matches — this is what keeps the table sparse. */
  export function applyPref(userId: number, eventId: string, channel: Channel, enabled: boolean): void;
  export function effectivePref(userId: number, eventId: string, channel: Channel): boolean;
  export function isEventEnabled(userId: number, eventId: string, channel: Channel): boolean;
  export interface NotifiableUser { id: number; name: string; role: 'admin' | 'member' }
  export function notifiableUsers(): NotifiableUser[];
  export function adminUserIds(): number[];
  ```

### Steps

- [ ] **Write the failing test `tests/lib/notify/config.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { sql } from 'drizzle-orm';
  import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
  import { NotifyCredentialError } from '@/lib/notify/crypto';
  import {
    DEFAULT_USER_SETTINGS,
    SMTP_PRESETS,
    applyPref,
    effectivePref,
    getSmtp,
    getSmtpPassword,
    getTarget,
    getTelegramToken,
    getUserSettings,
    hasAnyEnabledTarget,
    isEventEnabled,
    notifiableUsers,
    recordSmtpOutcome,
    recordTargetOutcome,
    removeSmtp,
    removeTarget,
    saveEmailTarget,
    saveSmtp,
    saveTelegramTarget,
    saveUserSettings,
    setPref,
  } from '@/lib/notify/config';

  const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';
  const PASSWORD = 'xsmtpsib-not-a-real-key';

  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  function relay(over: Partial<Parameters<typeof saveSmtp>[0]> = {}): void {
    saveSmtp({
      preset: 'brevo',
      host: 'smtp-relay.brevo.com',
      port: 587,
      security: 'starttls',
      username: 'me@example.com',
      password: PASSWORD,
      fromEmail: 'me@example.com',
      fromName: 'Budget Tracker',
      enabled: true,
      ...over,
    });
  }

  describe('MUST-8.15: the preset table', () => {
    it('matches the spec exactly', () => {
      expect(SMTP_PRESETS).toEqual({
        brevo: { host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' },
        smtp2go: { host: 'mail.smtp2go.com', port: 587, security: 'starttls' },
        gmail: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
        custom: { host: '', port: 587, security: 'starttls' },
      });
    });
  });

  describe('§3.2 / MUST-5.3: the relay row', () => {
    it('round-trips the config and never returns the password', () => {
      relay();
      const record = getSmtp();
      expect(record).not.toBeNull();
      expect(record?.host).toBe('smtp-relay.brevo.com');
      expect(record?.passwordSet).toBe(true);
      expect(JSON.stringify(record)).not.toContain(PASSWORD);
      expect(getSmtpPassword()).toBe(PASSWORD);
    });

    it('stores the password encrypted, not in plaintext', () => {
      relay();
      const row = t.sqlite.prepare('select password_encrypted from notification_smtp where id = 1').get() as {
        password_encrypted: string;
      };
      expect(row.password_encrypted).not.toContain(PASSWORD);
      expect(Buffer.from(row.password_encrypted, 'base64').length).toBeGreaterThan(28);
    });

    it('MUST-5.6: a null password on update keeps the stored value', () => {
      relay();
      relay({ password: null, fromName: 'Renamed' });
      expect(getSmtp()?.fromName).toBe('Renamed');
      expect(getSmtpPassword()).toBe(PASSWORD);
    });

    it('MUST-5.4: an unreadable stored credential throws NotifyCredentialError', () => {
      relay();
      t.db.run(sql`update notification_smtp set password_encrypted = ${'AAAA'} where id = 1`);
      expect(() => getSmtpPassword()).toThrowError(NotifyCredentialError);
    });

    it('records success and failure outcomes', () => {
      relay();
      recordSmtpOutcome({ ok: false, error: 'connect ECONNREFUSED', at: new Date('2026-08-17T10:00:00Z') });
      expect(getSmtp()?.lastError).toBe('connect ECONNREFUSED');
      expect(getSmtp()?.lastErrorAt).toBe('2026-08-17T10:00:00.000Z');
      recordSmtpOutcome({ ok: true, at: new Date('2026-08-17T11:00:00Z') });
      expect(getSmtp()?.lastError).toBeNull();
      expect(getSmtp()?.lastSuccessAt).toBe('2026-08-17T11:00:00.000Z');
    });

    it('removeSmtp deletes the singleton', () => {
      relay();
      removeSmtp();
      expect(getSmtp()).toBeNull();
    });
  });

  describe('§3.3: per-user targets', () => {
    it('stores the bot token encrypted and never returns it in the record', () => {
      const userId = insertTestUser(t.db);
      saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
      const target = getTarget(userId, 'telegram');
      expect(target?.destination).toBe('5551234');
      expect(target?.secretSet).toBe(true);
      expect(JSON.stringify(target)).not.toContain('AAHk3f');
      expect(getTelegramToken(userId)).toBe(TOKEN);
    });

    it('MUST-5.6: a null token on update keeps the stored one', () => {
      const userId = insertTestUser(t.db);
      saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
      saveTelegramTarget({ userId, destination: '-100999', botToken: null, enabled: true });
      expect(getTarget(userId, 'telegram')?.destination).toBe('-100999');
      expect(getTelegramToken(userId)).toBe(TOKEN);
    });

    it('refuses to create a telegram target with no token (the SQL pairing CHECK)', () => {
      const userId = insertTestUser(t.db);
      expect(() => saveTelegramTarget({ userId, destination: '5551234', botToken: null, enabled: true })).toThrow();
    });

    it('an email target stores no secret at all', () => {
      const userId = insertTestUser(t.db);
      saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
      expect(getTarget(userId, 'email')?.secretSet).toBe(false);
      const row = t.sqlite
        .prepare(`select secret_encrypted from notification_targets where user_id = ? and channel = 'email'`)
        .get(userId) as { secret_encrypted: string | null };
      expect(row.secret_encrypted).toBeNull();
    });

    it('MUST-12.7: only a successful test sets verified_at', () => {
      const userId = insertTestUser(t.db);
      saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
      recordTargetOutcome({ userId, channel: 'email', ok: false, error: 'nope', verify: true });
      expect(getTarget(userId, 'email')?.verifiedAt).toBeNull();
      recordTargetOutcome({ userId, channel: 'email', ok: true, verify: true, at: new Date('2026-08-17T12:00:00Z') });
      expect(getTarget(userId, 'email')?.verifiedAt).toBe('2026-08-17T12:00:00.000Z');
    });

    it('removeTarget removes only that user and channel', () => {
      const a = insertTestUser(t.db, { username: 'a' });
      const b = insertTestUser(t.db, { username: 'b' });
      saveEmailTarget({ userId: a, destination: 'a@example.com', enabled: true });
      saveEmailTarget({ userId: b, destination: 'b@example.com', enabled: true });
      removeTarget(a, 'email');
      expect(getTarget(a, 'email')).toBeNull();
      expect(getTarget(b, 'email')?.destination).toBe('b@example.com');
    });

    it('MUST-6.4: hasAnyEnabledTarget is false on a dormant install', () => {
      expect(hasAnyEnabledTarget()).toBe(false);
      const userId = insertTestUser(t.db);
      saveEmailTarget({ userId, destination: 'sam@example.com', enabled: false });
      expect(hasAnyEnabledTarget()).toBe(false);
      saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
      expect(hasAnyEnabledTarget()).toBe(true);
    });
  });

  describe('§3.5: per-user knobs', () => {
    it('returns every default for an absent row', () => {
      const userId = insertTestUser(t.db);
      expect(getUserSettings(userId)).toEqual(DEFAULT_USER_SETTINGS);
      expect(DEFAULT_USER_SETTINGS).toEqual({
        comingDueDays: 14,
        budgetThresholdPct: 80,
        staleImportWeeks: 3,
        dailyHour: 8,
        digestWeekday: 1,
        digestHour: 8,
      });
    });

    it('creates the row lazily on first save and updates it thereafter', () => {
      const userId = insertTestUser(t.db);
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, dailyHour: 19, budgetThresholdPct: 90 });
      expect(getUserSettings(userId).dailyHour).toBe(19);
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, dailyHour: 6 });
      expect(getUserSettings(userId).dailyHour).toBe(6);
      expect(getUserSettings(userId).budgetThresholdPct).toBe(80);
    });
  });

  describe('MUST-3.7: sparse preference resolution', () => {
    it('falls back to the registry default when no row exists', () => {
      const userId = insertTestUser(t.db);
      expect(effectivePref(userId, 'coming_due', 'email')).toBe(true);
      expect(effectivePref(userId, 'weekly_digest', 'email')).toBe(false);
    });

    it('a stored row wins over the default, in both directions', () => {
      const userId = insertTestUser(t.db);
      setPref(userId, 'coming_due', 'email', false);
      setPref(userId, 'weekly_digest', 'email', true);
      expect(effectivePref(userId, 'coming_due', 'email')).toBe(false);
      expect(effectivePref(userId, 'weekly_digest', 'email')).toBe(true);
    });

    it('MUST-3.6: an unknown event_id is ignored on read but not deleted', () => {
      const userId = insertTestUser(t.db);
      t.sqlite
        .prepare(`insert into notification_prefs (user_id, event_id, channel, enabled) values (?, 'on_pace_overshoot', 'email', 1)`)
        .run(userId);
      expect(effectivePref(userId, 'on_pace_overshoot', 'email')).toBe(false);
      expect(isEventEnabled(userId, 'on_pace_overshoot', 'email')).toBe(false);
      const { n } = t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number };
      expect(n).toBe(1);
    });

    it('nothing seeds the table', () => {
      insertTestUser(t.db);
      const { n } = t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number };
      expect(n).toBe(0);
    });

    it('applyPref keeps the table sparse in both directions', () => {
      const userId = insertTestUser(t.db);
      const count = () => (t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number }).n;

      // Matching the default writes nothing.
      applyPref(userId, 'coming_due', 'email', true);
      applyPref(userId, 'weekly_digest', 'email', false);
      expect(count()).toBe(0);

      // Differing from it writes a row...
      applyPref(userId, 'coming_due', 'email', false);
      expect(count()).toBe(1);
      expect(effectivePref(userId, 'coming_due', 'email')).toBe(false);

      // ...and going back to the default removes it again.
      applyPref(userId, 'coming_due', 'email', true);
      expect(count()).toBe(0);
      expect(effectivePref(userId, 'coming_due', 'email')).toBe(true);
    });

    it('applyPref ignores an event id that is not in the registry', () => {
      const userId = insertTestUser(t.db);
      applyPref(userId, 'on_pace_overshoot', 'email', true);
      const { n } = t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number };
      expect(n).toBe(0);
    });
  });

  describe('§4.3: the five-condition isEventEnabled chain, each failed in isolation', () => {
    function ready(role: 'admin' | 'member' = 'admin'): number {
      const userId = insertTestUser(t.db, { role, username: `u${Math.random().toString(36).slice(2, 8)}` });
      relay();
      saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
      saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
      return userId;
    }

    it('is true when all five conditions hold', () => {
      const userId = ready();
      expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(true);
      expect(isEventEnabled(userId, 'coming_due', 'telegram')).toBe(true);
    });

    it('1. the stored pref says no', () => {
      const userId = ready();
      setPref(userId, 'coming_due', 'email', false);
      expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
      expect(isEventEnabled(userId, 'coming_due', 'telegram')).toBe(true);
    });

    it('2. MUST-14.6: the user is deactivated', () => {
      const userId = ready();
      t.db.run(sql`update users set is_active = 0 where id = ${userId}`);
      expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
    });

    it('3. MUST-4.3/14.7: the role does not satisfy the audience', () => {
      const memberId = ready('member');
      expect(isEventEnabled(memberId, 'backup_failed', 'email')).toBe(false);
      expect(isEventEnabled(memberId, 'coming_due', 'email')).toBe(true);
    });

    it('4. no enabled target for that channel', () => {
      const userId = ready();
      removeTarget(userId, 'telegram');
      expect(isEventEnabled(userId, 'coming_due', 'telegram')).toBe(false);
      expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(true);
      saveEmailTarget({ userId, destination: 'sam@example.com', enabled: false });
      expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
    });

    it('5. email additionally needs an enabled relay', () => {
      const userId = ready();
      saveSmtp({
        preset: 'brevo',
        host: 'smtp-relay.brevo.com',
        port: 587,
        security: 'starttls',
        username: 'me@example.com',
        password: null,
        fromEmail: 'me@example.com',
        fromName: 'Budget Tracker',
        enabled: false,
      });
      expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
      expect(isEventEnabled(userId, 'coming_due', 'telegram')).toBe(true);
      removeSmtp();
      expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
    });

    it('an unknown event id is never enabled', () => {
      const userId = ready();
      expect(isEventEnabled(userId, 'not_a_real_event', 'email')).toBe(false);
    });
  });

  describe('notifiableUsers', () => {
    it('lists active users with their roles and skips deactivated ones', () => {
      const a = insertTestUser(t.db, { username: 'active', role: 'admin', name: 'Ada' });
      insertTestUser(t.db, { username: 'gone', role: 'member', isActive: false });
      expect(notifiableUsers()).toEqual([{ id: a, name: 'Ada', role: 'admin' }]);
    });
  });
  ```

- [ ] **Run it and confirm it fails.**
  ```powershell
  npx vitest run tests/lib/notify/config.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/notify/config"`.

- [ ] **Implement `src/lib/notify/config.ts`.**
  ```ts
  import { and, asc, eq } from 'drizzle-orm';
  import { getDb } from '@/db/client';
  import {
    notificationPrefs,
    notificationSmtp,
    notificationTargets,
    notificationUserSettings,
    users,
  } from '@/db/schema';
  import { nowIso } from '@/lib/clock';
  import { SMTP_HKDF_INFO, TELEGRAM_HKDF_INFO, decryptSecret, encryptSecret } from '@/lib/notify/crypto';
  import { eventDef, type Channel } from '@/lib/notify/events';

  export type SmtpPreset = 'brevo' | 'smtp2go' | 'gmail' | 'custom';
  export type SmtpSecurity = 'tls' | 'starttls' | 'none';

  export interface SmtpPresetDefaults {
    host: string;
    port: number;
    security: SmtpSecurity;
  }

  /**
   * MUST-8.15: the picker prefills host / port / security and swaps the guide panel
   * (§11.7.2). Every field stays editable afterwards; `preset` is stored so the right guide
   * is shown and NEVER changes connection behaviour.
   */
  export const SMTP_PRESETS: Record<SmtpPreset, SmtpPresetDefaults> = {
    brevo: { host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' },
    smtp2go: { host: 'mail.smtp2go.com', port: 587, security: 'starttls' },
    gmail: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    custom: { host: '', port: 587, security: 'starttls' },
  };

  export interface SmtpRecord {
    preset: SmtpPreset;
    host: string;
    port: number;
    security: SmtpSecurity;
    username: string;
    fromEmail: string;
    fromName: string;
    enabled: boolean;
    /** MUST-5.3: the page learns THAT a password exists, never what it is. */
    passwordSet: boolean;
    lastError: string | null;
    lastErrorAt: string | null;
    lastSuccessAt: string | null;
  }

  export function getSmtp(): SmtpRecord | null {
    const row = getDb().select().from(notificationSmtp).where(eq(notificationSmtp.id, 1)).get();
    if (!row) return null;
    return {
      preset: row.preset,
      host: row.host,
      port: row.port,
      security: row.security,
      username: row.username,
      fromEmail: row.fromEmail,
      fromName: row.fromName,
      enabled: row.enabled,
      passwordSet: row.passwordEncrypted.length > 0,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt,
      lastSuccessAt: row.lastSuccessAt,
    };
  }

  /** Server-side only. Throws NotifyCredentialError when the stored value is unreadable. */
  export function getSmtpPassword(): string {
    const row = getDb()
      .select({ payload: notificationSmtp.passwordEncrypted })
      .from(notificationSmtp)
      .where(eq(notificationSmtp.id, 1))
      .get();
    if (!row) throw new Error('no SMTP relay is configured');
    return decryptSecret(row.payload, SMTP_HKDF_INFO);
  }

  /**
   * MUST-5.6: `password: null` means "keep what is stored". Creating a row with a null
   * password is a validation error the action layer refuses before reaching here; this
   * function throws rather than writing an empty credential.
   */
  export function saveSmtp(input: {
    preset: SmtpPreset;
    host: string;
    port: number;
    security: SmtpSecurity;
    username: string;
    password: string | null;
    fromEmail: string;
    fromName: string;
    enabled: boolean;
    at?: Date;
  }): void {
    const db = getDb();
    const at = nowIso(input.at ?? new Date());
    const existing = db
      .select({ payload: notificationSmtp.passwordEncrypted, createdAt: notificationSmtp.createdAt })
      .from(notificationSmtp)
      .where(eq(notificationSmtp.id, 1))
      .get();

    let payload: string;
    if (input.password !== null && input.password.length > 0) {
      payload = encryptSecret(input.password, SMTP_HKDF_INFO);
    } else if (existing) {
      payload = existing.payload;
    } else {
      throw new Error('a password is required when creating the relay');
    }

    const values = {
      id: 1 as const,
      preset: input.preset,
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username,
      passwordEncrypted: payload,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };

    db.insert(notificationSmtp)
      .values(values)
      .onConflictDoUpdate({ target: notificationSmtp.id, set: { ...values, createdAt: undefined } })
      .run();
  }

  export function removeSmtp(): void {
    getDb().delete(notificationSmtp).where(eq(notificationSmtp.id, 1)).run();
  }

  /**
   * MUST-7.10: success clears last_error and sets last_success_at; failure sets the
   * (already scrubbed) last_error and last_error_at. Settings renders both, so "email
   * stopped working three weeks ago" is visible on the page rather than only in docker logs.
   */
  export function recordSmtpOutcome(input: { ok: boolean; error?: string; at?: Date }): void {
    const at = nowIso(input.at ?? new Date());
    getDb()
      .update(notificationSmtp)
      .set(
        input.ok
          ? { lastError: null, lastErrorAt: null, lastSuccessAt: at, updatedAt: at }
          : { lastError: input.error ?? 'Send failed.', lastErrorAt: at, updatedAt: at },
      )
      .where(eq(notificationSmtp.id, 1))
      .run();
  }

  export interface TargetRecord {
    id: number;
    userId: number;
    channel: Channel;
    destination: string;
    /** MUST-5.3: never the token itself. */
    secretSet: boolean;
    enabled: boolean;
    verifiedAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    lastSuccessAt: string | null;
  }

  function toTargetRecord(row: typeof notificationTargets.$inferSelect): TargetRecord {
    return {
      id: row.id,
      userId: row.userId,
      channel: row.channel,
      destination: row.destination,
      secretSet: (row.secretEncrypted ?? '').length > 0,
      enabled: row.enabled,
      verifiedAt: row.verifiedAt,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt,
      lastSuccessAt: row.lastSuccessAt,
    };
  }

  export function getTarget(userId: number, channel: Channel): TargetRecord | null {
    const row = getDb()
      .select()
      .from(notificationTargets)
      .where(and(eq(notificationTargets.userId, userId), eq(notificationTargets.channel, channel)))
      .get();
    return row ? toTargetRecord(row) : null;
  }

  export function listTargets(userId: number): TargetRecord[] {
    return getDb()
      .select()
      .from(notificationTargets)
      .where(eq(notificationTargets.userId, userId))
      .orderBy(asc(notificationTargets.channel))
      .all()
      .map(toTargetRecord);
  }

  /** MUST-3.5 / MUST-8.9: each user's OWN token, decrypted server-side, never a parameter. */
  export function getTelegramToken(userId: number): string {
    const row = getDb()
      .select({ payload: notificationTargets.secretEncrypted })
      .from(notificationTargets)
      .where(and(eq(notificationTargets.userId, userId), eq(notificationTargets.channel, 'telegram')))
      .get();
    if (!row || row.payload === null) throw new Error('no Telegram token is stored for this user');
    return decryptSecret(row.payload, TELEGRAM_HKDF_INFO);
  }

  function upsertTarget(input: {
    userId: number;
    channel: Channel;
    destination: string;
    secretEncrypted: string | null;
    enabled: boolean;
    at: string;
    /** A changed destination invalidates a previous verification. */
    resetVerified: boolean;
  }): void {
    const db = getDb();
    const existing = db
      .select({ id: notificationTargets.id, createdAt: notificationTargets.createdAt })
      .from(notificationTargets)
      .where(and(eq(notificationTargets.userId, input.userId), eq(notificationTargets.channel, input.channel)))
      .get();

    if (existing) {
      db.update(notificationTargets)
        .set({
          destination: input.destination,
          secretEncrypted: input.secretEncrypted,
          enabled: input.enabled,
          updatedAt: input.at,
          ...(input.resetVerified ? { verifiedAt: null } : {}),
        })
        .where(eq(notificationTargets.id, existing.id))
        .run();
      return;
    }

    db.insert(notificationTargets)
      .values({
        userId: input.userId,
        channel: input.channel,
        destination: input.destination,
        secretEncrypted: input.secretEncrypted,
        enabled: input.enabled,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .run();
  }

  export function saveTelegramTarget(input: {
    userId: number;
    destination: string;
    /** MUST-5.6: null means "keep the stored token". */
    botToken: string | null;
    enabled: boolean;
    at?: Date;
  }): void {
    const at = nowIso(input.at ?? new Date());
    const existing = getDb()
      .select({ payload: notificationTargets.secretEncrypted, destination: notificationTargets.destination })
      .from(notificationTargets)
      .where(and(eq(notificationTargets.userId, input.userId), eq(notificationTargets.channel, 'telegram')))
      .get();

    const payload =
      input.botToken !== null && input.botToken.length > 0
        ? encryptSecret(input.botToken, TELEGRAM_HKDF_INFO)
        : (existing?.payload ?? null);

    upsertTarget({
      userId: input.userId,
      channel: 'telegram',
      destination: input.destination,
      secretEncrypted: payload,
      enabled: input.enabled,
      at,
      resetVerified: existing?.destination !== input.destination || (input.botToken?.length ?? 0) > 0,
    });
  }

  export function saveEmailTarget(input: { userId: number; destination: string; enabled: boolean; at?: Date }): void {
    const at = nowIso(input.at ?? new Date());
    const existing = getDb()
      .select({ destination: notificationTargets.destination })
      .from(notificationTargets)
      .where(and(eq(notificationTargets.userId, input.userId), eq(notificationTargets.channel, 'email')))
      .get();

    upsertTarget({
      userId: input.userId,
      channel: 'email',
      destination: input.destination,
      // The SQL pairing CHECK requires NULL here for email (§3.3).
      secretEncrypted: null,
      enabled: input.enabled,
      at,
      resetVerified: existing?.destination !== input.destination,
    });
  }

  export function removeTarget(userId: number, channel: Channel): void {
    getDb()
      .delete(notificationTargets)
      .where(and(eq(notificationTargets.userId, userId), eq(notificationTargets.channel, channel)))
      .run();
  }

  /** MUST-12.7: only a SUCCESSFUL test sets verified_at, and only when `verify` is set. */
  export function recordTargetOutcome(input: {
    userId: number;
    channel: Channel;
    ok: boolean;
    error?: string;
    verify?: boolean;
    at?: Date;
  }): void {
    const at = nowIso(input.at ?? new Date());
    getDb()
      .update(notificationTargets)
      .set(
        input.ok
          ? {
              lastError: null,
              lastErrorAt: null,
              lastSuccessAt: at,
              updatedAt: at,
              ...(input.verify ? { verifiedAt: at } : {}),
            }
          : { lastError: input.error ?? 'Send failed.', lastErrorAt: at, updatedAt: at },
      )
      .where(and(eq(notificationTargets.userId, input.userId), eq(notificationTargets.channel, input.channel)))
      .run();
  }

  /** MUST-6.4: half of the dormancy bail. One indexed read against an empty table. */
  export function hasAnyEnabledTarget(): boolean {
    const row = getDb()
      .select({ id: notificationTargets.id })
      .from(notificationTargets)
      .where(eq(notificationTargets.enabled, true))
      .limit(1)
      .get();
    return row !== undefined;
  }

  export interface UserSettings {
    comingDueDays: number;
    budgetThresholdPct: number;
    staleImportWeeks: number;
    dailyHour: number;
    digestWeekday: number;
    digestHour: number;
  }

  /** §3.5: an ABSENT row means every default applies. Nothing seeds this table. */
  export const DEFAULT_USER_SETTINGS: UserSettings = {
    comingDueDays: 14,
    budgetThresholdPct: 80,
    staleImportWeeks: 3,
    dailyHour: 8,
    digestWeekday: 1,
    digestHour: 8,
  };

  export function getUserSettings(userId: number): UserSettings {
    const row = getDb()
      .select()
      .from(notificationUserSettings)
      .where(eq(notificationUserSettings.userId, userId))
      .get();
    if (!row) return { ...DEFAULT_USER_SETTINGS };
    return {
      comingDueDays: row.comingDueDays,
      budgetThresholdPct: row.budgetThresholdPct,
      staleImportWeeks: row.staleImportWeeks,
      dailyHour: row.dailyHour,
      digestWeekday: row.digestWeekday,
      digestHour: row.digestHour,
    };
  }

  export function saveUserSettings(userId: number, next: UserSettings, at?: Date): void {
    const stamp = nowIso(at ?? new Date());
    getDb()
      .insert(notificationUserSettings)
      .values({ userId, ...next, createdAt: stamp, updatedAt: stamp })
      .onConflictDoUpdate({
        target: notificationUserSettings.userId,
        set: { ...next, updatedAt: stamp },
      })
      .run();
  }

  function prefKey(eventId: string, channel: Channel): string {
    return `${eventId}:${channel}`;
  }

  export function getPrefs(userId: number): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const row of getDb().select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId)).all()) {
      out[prefKey(row.eventId, row.channel)] = row.enabled;
    }
    return out;
  }

  export function setPref(userId: number, eventId: string, channel: Channel, enabled: boolean): void {
    getDb()
      .insert(notificationPrefs)
      .values({ userId, eventId, channel, enabled })
      .onConflictDoUpdate({
        target: [notificationPrefs.userId, notificationPrefs.eventId, notificationPrefs.channel],
        set: { enabled },
      })
      .run();
  }

  export function clearPref(userId: number, eventId: string, channel: Channel): void {
    getDb()
      .delete(notificationPrefs)
      .where(
        and(
          eq(notificationPrefs.userId, userId),
          eq(notificationPrefs.eventId, eventId),
          eq(notificationPrefs.channel, channel),
        ),
      )
      .run();
  }

  /**
   * MUST-3.7 (sparse storage) — a row exists ONLY where a user has actively changed a
   * toggle. Saving a value that equals the registry default deletes the row instead of
   * storing a redundant one, so a later change to a default propagates to everyone who never
   * expressed an opinion. An unknown event id is ignored entirely (MUST-3.6): the stored row
   * a downgrade left behind is neither read nor deleted.
   */
  export function applyPref(userId: number, eventId: string, channel: Channel, enabled: boolean): void {
    const def = eventDef(eventId);
    if (!def) return;
    if (enabled === def.defaultEnabled) clearPref(userId, eventId, channel);
    else setPref(userId, eventId, channel, enabled);
  }

  /** MUST-3.7: `row?.enabled ?? registryDefault(event_id)`; unknown ids resolve to false. */
  export function effectivePref(userId: number, eventId: string, channel: Channel): boolean {
    const def = eventDef(eventId);
    if (!def) return false;
    const row = getDb()
      .select({ enabled: notificationPrefs.enabled })
      .from(notificationPrefs)
      .where(
        and(
          eq(notificationPrefs.userId, userId),
          eq(notificationPrefs.eventId, eventId),
          eq(notificationPrefs.channel, channel),
        ),
      )
      .get();
    return row?.enabled ?? def.defaultEnabled;
  }

  /**
   * §4.3 — all five conditions, in this order, in ONE function. No caller re-implements any
   * part of it:
   *   1. the effective toggle (MUST-3.7),
   *   2. the user is active (MUST-14.6),
   *   3. the user's role satisfies the event's audience (MUST-4.3 / MUST-14.7),
   *   4. an ENABLED notification_targets row exists for (userId, channel) — MUST-4.2,
   *   5. for channel 'email', an ENABLED notification_smtp row exists.
   */
  export function isEventEnabled(userId: number, eventId: string, channel: Channel): boolean {
    const def = eventDef(eventId);
    if (!def) return false;
    if (!effectivePref(userId, eventId, channel)) return false;

    const user = getDb()
      .select({ role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!user || !user.isActive) return false;
    if (def.audience === 'admin' && user.role !== 'admin') return false;

    const target = getDb()
      .select({ enabled: notificationTargets.enabled })
      .from(notificationTargets)
      .where(and(eq(notificationTargets.userId, userId), eq(notificationTargets.channel, channel)))
      .get();
    if (!target || !target.enabled) return false;

    if (channel === 'email') {
      const relay = getDb()
        .select({ enabled: notificationSmtp.enabled })
        .from(notificationSmtp)
        .where(eq(notificationSmtp.id, 1))
        .get();
      if (!relay || !relay.enabled) return false;
    }

    return true;
  }

  export interface NotifiableUser {
    id: number;
    name: string;
    role: 'admin' | 'member';
  }

  /** MUST-14.6: evaluation skips deactivated members without deleting their configuration. */
  export function notifiableUsers(): NotifiableUser[] {
    return getDb()
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(asc(users.id))
      .all();
  }

  export function adminUserIds(): number[] {
    return getDb()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isActive, true), eq(users.role, 'admin')))
      .orderBy(asc(users.id))
      .all()
      .map((row) => row.id);
  }
  ```

- [ ] **Run the test and confirm it passes.**
  ```powershell
  npx vitest run tests/lib/notify/config.test.ts
  ```
  Expected: green.

- [ ] **Type-check, run the full suite and commit.**
  ```powershell
  npm run typecheck
  npm test
  git add src/lib/notify/config.ts tests/lib/notify/config.test.ts
  git commit -m "feat(notify): configuration store for relay, targets, prefs and knobs

Sparse preference resolution (MUST-3.7), the five-condition isEventEnabled chain
in one place (§4.3), the MUST-8.15 preset table, and credentials that are written
encrypted and never returned to a caller (MUST-5.3)."
  ```

<!-- END TASK 4 -->

---

## Task 5: Message rendering

**Context:** Spec §10 in full. Implements **MUST-10.1 … MUST-10.4** and §17.1's `render.test.ts`. One channel-agnostic renderer, so the two channels can never drift apart in wording and every message is testable as a pure function. PURE (MUST-2.1).

**Ambiguity resolved:** the spec names `renderEvent(input: RenderInput)` but never defines `RenderInput`. It is a discriminated union keyed on `event`, one member per registry id, carrying only already-resolved primitives — evaluators do the querying, the renderer does no lookups. That is what keeps this module pure and every message a fixed-input test.

**Files:**
- Create: `src/lib/notify/render.ts`
- Test: `tests/lib/notify/render.test.ts`

**Interfaces:**
- Consumes: `formatCents(cents, opts?)` from `@/lib/money`; `monthLabel(month)`, `daysBetweenIso(fromIso, toIso)` from `@/lib/dates`; `ITEM_KIND_LABELS`, `expiryPhraseForKind(kind, expiryDate)`, `type ItemKind` from `@/lib/warranty/constants`.
- Produces:
  ```ts
  // src/lib/notify/render.ts — PURE (MUST-2.1)
  export const NAME_MAX = 80;
  export const USER_AGENT_MAX = 120;
  export function truncateText(value: string, max: number): string;
  export interface DigestLine { name: string; cents: number }
  export type RenderInput =
    | { event: 'coming_due'; itemName: string; kind: ItemKind; expiryDate: string; todayIso: string; vendor: string | null; priceCents: number | null }
    | { event: 'budget_threshold'; scope: 'household' | 'personal'; categoryName: string; month: string; pct: number; spentCents: number; limitCents: number }
    | { event: 'budget_exceeded'; scope: 'household' | 'personal'; categoryName: string; month: string; spentCents: number; limitCents: number }
    | { event: 'backup_failed'; dateIso: string; error: string }
    | { event: 'weekly_digest'; fromIso: string; toIso: string; householdSpentCents: number; personalSpentCents: number; topCategories: DigestLine[]; topMerchants: DigestLine[]; reviewCount: number; overBudget: string[] }
    | { event: 'new_signin'; name: string; atLabel: string; tz: string; ip: string; userAgent: string | null }
    | { event: 'restore_outcome'; status: 'success' | 'failed'; sourceName: string; requestedByUsername: string; finishedAt: string; receiptsRestored: number; missingReceiptRows: number; error: string | null }
    | { event: 'stale_import'; weeks: number; lastImportIso: string; daysAgo: number };
  export function renderEvent(input: RenderInput): { subject: string; body: string };
  ```

### Steps

- [ ] **Write the failing test `tests/lib/notify/render.test.ts`.**
  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { NAME_MAX, USER_AGENT_MAX, renderEvent, truncateText } from '@/lib/notify/render';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

  describe('MUST-2.1: render.ts is pure', () => {
    it('imports neither @/db nor @/lib/env nor a node builtin', () => {
      const source = fs.readFileSync(path.join(root, 'src/lib/notify/render.ts'), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/env/);
      expect(source).not.toMatch(/from\s+['"]node:/);
    });
  });

  describe('MUST-6.14 / §10.1: coming_due', () => {
    it('uses the warranty verb for each kind rather than writing its own', () => {
      const base = {
        event: 'coming_due',
        itemName: 'Dishwasher',
        expiryDate: '2026-09-01',
        todayIso: '2026-08-17',
        vendor: null,
        priceCents: null,
      } as const;
      expect(renderEvent({ ...base, kind: 'loan' }).body).toContain('paid off by');
      expect(renderEvent({ ...base, kind: 'subscription' }).body).toContain('cancel by');
      expect(renderEvent({ ...base, kind: 'contract' }).body).toContain('ends on');
      expect(renderEvent({ ...base, kind: 'warranty' }).body).toContain('expires');
    });

    it('renders the subject, the days remaining, and the optional vendor and price', () => {
      const { subject, body } = renderEvent({
        event: 'coming_due',
        itemName: 'Netflix',
        kind: 'subscription',
        expiryDate: '2026-08-27',
        todayIso: '2026-08-17',
        vendor: 'Netflix Canada',
        priceCents: 2299,
      });
      expect(subject).toBe('Coming due: Netflix');
      expect(body).toContain('in 10 days');
      expect(body).toContain('Netflix Canada');
      expect(body).toContain('$22.99');
    });

    it('says "tomorrow" and "today" rather than "in 1 days" / "in 0 days"', () => {
      const base = { event: 'coming_due', itemName: 'X', kind: 'warranty', todayIso: '2026-08-17', vendor: null, priceCents: null } as const;
      expect(renderEvent({ ...base, expiryDate: '2026-08-18' }).body).toContain('tomorrow');
      expect(renderEvent({ ...base, expiryDate: '2026-08-17' }).body).toContain('today');
    });
  });

  describe('§10.1: budget events', () => {
    it('renders the threshold subject and body with formatted money', () => {
      const { subject, body } = renderEvent({
        event: 'budget_threshold',
        scope: 'household',
        categoryName: 'Groceries',
        month: '2026-08',
        pct: 82,
        spentCents: 41000,
        limitCents: 50000,
      });
      expect(subject).toBe('Budget 82%: Groceries (August 2026)');
      expect(body).toBe('Household Groceries budget for August 2026 is at 82% — $410.00 of $500.00, $90.00 left.');
    });

    it('says "Your" for the personal scope', () => {
      const { body } = renderEvent({
        event: 'budget_threshold',
        scope: 'personal',
        categoryName: 'Coffee',
        month: '2026-08',
        pct: 90,
        spentCents: 4500,
        limitCents: 5000,
      });
      expect(body.startsWith('Your Coffee budget')).toBe(true);
    });

    it('renders the exceeded subject and the amount over', () => {
      const { subject, body } = renderEvent({
        event: 'budget_exceeded',
        scope: 'household',
        categoryName: 'Restaurants',
        month: '2026-08',
        spentCents: 61000,
        limitCents: 50000,
      });
      expect(subject).toBe('Over budget: Restaurants (August 2026)');
      expect(body).toBe('Household Restaurants budget for August 2026 is blown — $610.00 of $500.00, $110.00 over.');
    });
  });

  describe('§10.1: the operational events', () => {
    it('backup_failed points at Settings and states the sweep still ran', () => {
      const { subject, body } = renderEvent({ event: 'backup_failed', dateIso: '2026-08-17', error: 'ENOSPC: no space left' });
      expect(subject).toBe('Nightly backup failed');
      expect(body).toContain('2026-08-17');
      expect(body).toContain('ENOSPC: no space left');
      expect(body).toContain('The maintenance sweep still ran. Check Settings → Backups.');
    });

    it('new_signin names the time, zone, ip and browser and tells the reader what to do', () => {
      const { subject, body } = renderEvent({
        event: 'new_signin',
        name: 'Sam',
        atLabel: '2026-08-17 21:14',
        tz: 'America/Toronto',
        ip: '192.168.1.44',
        userAgent: 'Mozilla/5.0 (iPhone)',
      });
      expect(subject).toBe('New sign-in to your account');
      expect(body).toContain('Sam signed in at 2026-08-17 21:14 (America/Toronto) from 192.168.1.44.');
      expect(body).toContain('Mozilla/5.0 (iPhone)');
      expect(body).toContain('If this was not you, change your password in Settings.');
    });

    it('restore_outcome distinguishes success from failure', () => {
      const base = {
        event: 'restore_outcome',
        sourceName: 'budget-2026-08-16.tar.gz',
        requestedByUsername: 'manav',
        finishedAt: '2026-08-17T03:12:04.000Z',
        receiptsRestored: 12,
        missingReceiptRows: 1,
      } as const;
      expect(renderEvent({ ...base, status: 'success', error: null }).subject).toBe('Restore succeeded');
      const failed = renderEvent({ ...base, status: 'failed', error: 'checksum mismatch' });
      expect(failed.subject).toBe('Restore FAILED');
      expect(failed.body).toContain('checksum mismatch');
      expect(failed.body).toContain('budget-2026-08-16.tar.gz');
      expect(failed.body).toContain('manav');
      expect(failed.body).toContain('12');
    });

    it('stale_import states the weeks, the last import and why it matters', () => {
      const { subject, body } = renderEvent({ event: 'stale_import', weeks: 3, lastImportIso: '2026-07-27', daysAgo: 21 });
      expect(subject).toBe('No transactions imported in 3 weeks');
      expect(body).toContain('The last import was 2026-07-27 (21 days ago).');
      expect(body).toContain('Bank exports are how this app learns what you spent.');
    });
  });

  describe('§10.2: the weekly digest', () => {
    const full = {
      event: 'weekly_digest',
      fromIso: '2026-08-10',
      toIso: '2026-08-16',
      householdSpentCents: 128455,
      personalSpentCents: 41230,
      topCategories: [
        { name: 'Groceries', cents: 40211 },
        { name: 'Restaurants', cents: 18840 },
        { name: 'Gas', cents: 12100 },
      ],
      topMerchants: [
        { name: 'LOBLAWS', cents: 21055 },
        { name: 'PETRO-CANADA', cents: 12100 },
      ],
      reviewCount: 12,
      overBudget: ['Restaurants', 'Coffee'],
    } as const;

    it('renders the subject as the date range', () => {
      expect(renderEvent(full).subject).toBe('Weekly summary — 2026-08-10 to 2026-08-16');
    });

    it('renders every section of the spec example', () => {
      const { body } = renderEvent(full);
      expect(body).toContain('Household spend: $1,284.55');
      expect(body).toContain('Your spend:');
      expect(body).toContain('$412.30');
      expect(body).toContain('Top categories (household)');
      expect(body).toContain('Groceries');
      expect(body).toContain('$402.11');
      expect(body).toContain('Top merchants (household)');
      expect(body).toContain('LOBLAWS');
      expect(body).toContain('12 transactions still need review.');
      expect(body).toContain('Over budget this month: Restaurants, Coffee.');
    });

    it('an empty week still sends, with its own sentence', () => {
      const { body } = renderEvent({
        ...full,
        householdSpentCents: 0,
        personalSpentCents: 0,
        topCategories: [],
        topMerchants: [],
        reviewCount: 0,
        overBudget: [],
      });
      expect(body).toContain('No transactions were recorded this week.');
    });
  });

  describe('MUST-10.3: untrusted values are plain and truncated', () => {
    it('renders markup literally', () => {
      const { subject, body } = renderEvent({
        event: 'coming_due',
        itemName: '<b>x</b>',
        kind: 'warranty',
        expiryDate: '2026-09-01',
        todayIso: '2026-08-17',
        vendor: null,
        priceCents: null,
      });
      expect(subject).toContain('<b>x</b>');
      expect(body).toContain('<b>x</b>');
    });

    it('truncates names to 80 characters and user agents to 120', () => {
      expect(NAME_MAX).toBe(80);
      expect(USER_AGENT_MAX).toBe(120);
      expect(truncateText('a'.repeat(200), NAME_MAX)).toHaveLength(NAME_MAX);
      expect(truncateText('a'.repeat(200), NAME_MAX).endsWith('…')).toBe(true);
      expect(truncateText('short', NAME_MAX)).toBe('short');

      const { body } = renderEvent({
        event: 'new_signin',
        name: 'Sam',
        atLabel: '2026-08-17 21:14',
        tz: 'UTC',
        ip: '1.2.3.4',
        userAgent: 'U'.repeat(400),
      });
      expect(body).not.toContain('U'.repeat(USER_AGENT_MAX + 1));
    });
  });

  describe('MUST-10.4: no notification body contains a link', () => {
    it('none of the eight bodies contains a URL scheme', () => {
      const inputs: Parameters<typeof renderEvent>[0][] = [
        { event: 'coming_due', itemName: 'X', kind: 'warranty', expiryDate: '2026-09-01', todayIso: '2026-08-17', vendor: null, priceCents: null },
        { event: 'budget_threshold', scope: 'household', categoryName: 'C', month: '2026-08', pct: 80, spentCents: 1, limitCents: 2 },
        { event: 'budget_exceeded', scope: 'personal', categoryName: 'C', month: '2026-08', spentCents: 3, limitCents: 2 },
        { event: 'backup_failed', dateIso: '2026-08-17', error: 'e' },
        { event: 'weekly_digest', fromIso: '2026-08-10', toIso: '2026-08-16', householdSpentCents: 0, personalSpentCents: 0, topCategories: [], topMerchants: [], reviewCount: 0, overBudget: [] },
        { event: 'new_signin', name: 'S', atLabel: 'x', tz: 'UTC', ip: '1.2.3.4', userAgent: null },
        { event: 'restore_outcome', status: 'success', sourceName: 's', requestedByUsername: 'u', finishedAt: 'f', receiptsRestored: 0, missingReceiptRows: 0, error: null },
        { event: 'stale_import', weeks: 3, lastImportIso: '2026-07-27', daysAgo: 21 },
      ];
      for (const input of inputs) {
        const { subject, body } = renderEvent(input);
        expect(`${subject}\n${body}`).not.toMatch(/https?:\/\//);
      }
    });
  });
  ```

- [ ] **Run it and confirm it fails.**
  ```powershell
  npx vitest run tests/lib/notify/render.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/notify/render"`.

- [ ] **Implement `src/lib/notify/render.ts`.**
  ```ts
  import { daysBetweenIso, monthLabel } from '@/lib/dates';
  import { formatCents } from '@/lib/money';
  import { ITEM_KIND_LABELS, expiryPhraseForKind, type ItemKind } from '@/lib/warranty/constants';

  /**
   * MUST-10.1 — ONE channel-agnostic renderer. Telegram sends `subject + '\n\n' + body`;
   * email sends `subject` as the Subject header and `body` as the text part. One renderer,
   * two envelopes: the two channels can never drift apart in wording, and every message is
   * testable as a pure function.
   *
   * PURE (MUST-2.1). Every value arrives already resolved — the evaluators do the querying.
   *
   * MUST-10.4: no body contains a link. The server has no reliable idea of the URL the
   * family uses (LAN IP, reverse-proxy hostname, Tailscale name), and a wrong link is worse
   * than no link.
   */
  export const NAME_MAX = 80;
  export const USER_AGENT_MAX = 120;

  /** MUST-10.3: every value from user or import data is plain text and bounded. */
  export function truncateText(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1)}…`;
  }

  export interface DigestLine {
    name: string;
    cents: number;
  }

  export type RenderInput =
    | {
        event: 'coming_due';
        itemName: string;
        kind: ItemKind;
        expiryDate: string;
        todayIso: string;
        vendor: string | null;
        priceCents: number | null;
      }
    | {
        event: 'budget_threshold';
        scope: 'household' | 'personal';
        categoryName: string;
        month: string;
        pct: number;
        spentCents: number;
        limitCents: number;
      }
    | {
        event: 'budget_exceeded';
        scope: 'household' | 'personal';
        categoryName: string;
        month: string;
        spentCents: number;
        limitCents: number;
      }
    | { event: 'backup_failed'; dateIso: string; error: string }
    | {
        event: 'weekly_digest';
        fromIso: string;
        toIso: string;
        householdSpentCents: number;
        personalSpentCents: number;
        topCategories: DigestLine[];
        topMerchants: DigestLine[];
        reviewCount: number;
        overBudget: string[];
      }
    | { event: 'new_signin'; name: string; atLabel: string; tz: string; ip: string; userAgent: string | null }
    | {
        event: 'restore_outcome';
        status: 'success' | 'failed';
        sourceName: string;
        requestedByUsername: string;
        finishedAt: string;
        receiptsRestored: number;
        missingReceiptRows: number;
        error: string | null;
      }
    | { event: 'stale_import'; weeks: number; lastImportIso: string; daysAgo: number };

  function money(cents: number): string {
    return formatCents(cents, { currency: true });
  }

  function scopeWord(scope: 'household' | 'personal'): string {
    return scope === 'household' ? 'Household' : 'Your';
  }

  function inDays(todayIso: string, targetIso: string): string {
    const days = daysBetweenIso(todayIso, targetIso);
    if (days <= 0) return 'today';
    if (days === 1) return 'tomorrow';
    return `in ${days} days`;
  }

  /** Two columns, padded, so a digest reads as a table in a plain-text message. */
  function padded(lines: DigestLine[], indent = '  '): string[] {
    const width = lines.reduce((max, line) => Math.max(max, truncateText(line.name, NAME_MAX).length), 0);
    return lines.map((line) => `${indent}${truncateText(line.name, NAME_MAX).padEnd(width + 2)}${money(line.cents)}`);
  }

  function renderDigest(input: Extract<RenderInput, { event: 'weekly_digest' }>): string {
    const empty =
      input.householdSpentCents === 0 &&
      input.personalSpentCents === 0 &&
      input.topCategories.length === 0 &&
      input.topMerchants.length === 0;
    if (empty) {
      const tail: string[] = ['No transactions were recorded this week.'];
      if (input.reviewCount > 0) tail.push(`${input.reviewCount} transactions still need review.`);
      if (input.overBudget.length > 0) {
        tail.push(`Over budget this month: ${input.overBudget.map((n) => truncateText(n, NAME_MAX)).join(', ')}.`);
      }
      return tail.join('\n');
    }

    const parts: string[] = [
      `Household spend: ${money(input.householdSpentCents)}`,
      `Your spend:      ${money(input.personalSpentCents)}`,
    ];
    if (input.topCategories.length > 0) {
      parts.push('', 'Top categories (household)', ...padded(input.topCategories));
    }
    if (input.topMerchants.length > 0) {
      parts.push('', 'Top merchants (household)', ...padded(input.topMerchants));
    }
    parts.push('');
    if (input.reviewCount > 0) parts.push(`${input.reviewCount} transactions still need review.`);
    if (input.overBudget.length > 0) {
      parts.push(`Over budget this month: ${input.overBudget.map((n) => truncateText(n, NAME_MAX)).join(', ')}.`);
    }
    return parts.join('\n').trimEnd();
  }

  export function renderEvent(input: RenderInput): { subject: string; body: string } {
    switch (input.event) {
      case 'coming_due': {
        const name = truncateText(input.itemName, NAME_MAX);
        // MUST-6.14: the verb comes from expiryPhraseForKind() so notifications never become
        // a second place any of the four verbs is written (MUST-19.11 of the warranty spec).
        const phrase = expiryPhraseForKind(input.kind, input.expiryDate);
        const lines = [`${ITEM_KIND_LABELS[input.kind]} "${name}" ${phrase} (${inDays(input.todayIso, input.expiryDate)}).`];
        if (input.vendor) lines.push(`Vendor: ${truncateText(input.vendor, NAME_MAX)}`);
        if (input.priceCents !== null) lines.push(`Price: ${money(input.priceCents)}`);
        return { subject: `Coming due: ${name}`, body: lines.join('\n') };
      }
      case 'budget_threshold': {
        const category = truncateText(input.categoryName, NAME_MAX);
        const label = monthLabel(input.month);
        return {
          subject: `Budget ${input.pct}%: ${category} (${label})`,
          body:
            `${scopeWord(input.scope)} ${category} budget for ${label} is at ${input.pct}% — ` +
            `${money(input.spentCents)} of ${money(input.limitCents)}, ${money(input.limitCents - input.spentCents)} left.`,
        };
      }
      case 'budget_exceeded': {
        const category = truncateText(input.categoryName, NAME_MAX);
        const label = monthLabel(input.month);
        return {
          subject: `Over budget: ${category} (${label})`,
          body:
            `${scopeWord(input.scope)} ${category} budget for ${label} is blown — ` +
            `${money(input.spentCents)} of ${money(input.limitCents)}, ${money(input.spentCents - input.limitCents)} over.`,
        };
      }
      case 'backup_failed':
        return {
          subject: 'Nightly backup failed',
          body: [
            `The nightly backup on ${input.dateIso} did not complete.`,
            input.error,
            'The maintenance sweep still ran. Check Settings → Backups.',
          ].join('\n\n'),
        };
      case 'weekly_digest':
        return { subject: `Weekly summary — ${input.fromIso} to ${input.toIso}`, body: renderDigest(input) };
      case 'new_signin': {
        const lines = [
          `${truncateText(input.name, NAME_MAX)} signed in at ${input.atLabel} (${input.tz}) from ${input.ip}.`,
        ];
        if (input.userAgent) lines.push(truncateText(input.userAgent, USER_AGENT_MAX));
        lines.push('If this was not you, change your password in Settings.');
        return { subject: 'New sign-in to your account', body: lines.join('\n\n') };
      }
      case 'restore_outcome': {
        const lines = [
          `Source: ${truncateText(input.sourceName, NAME_MAX)}`,
          `Requested by: ${truncateText(input.requestedByUsername, NAME_MAX)}`,
          `Finished: ${input.finishedAt}`,
          `Receipts restored: ${input.receiptsRestored}; rows with a missing receipt: ${input.missingReceiptRows}`,
        ];
        if (input.error) lines.push(`Error: ${input.error}`);
        return { subject: input.status === 'success' ? 'Restore succeeded' : 'Restore FAILED', body: lines.join('\n') };
      }
      case 'stale_import':
        return {
          subject: `No transactions imported in ${input.weeks} weeks`,
          body: [
            `The last import was ${input.lastImportIso} (${input.daysAgo} days ago).`,
            'Bank exports are how this app learns what you spent.',
          ].join('\n'),
        };
    }
  }
  ```

- [ ] **Run the test and confirm it passes.**
  ```powershell
  npx vitest run tests/lib/notify/render.test.ts
  ```
  Expected: green. If `expiryPhraseForKind('warranty', ...)` produces different wording than the test's `expires` assertion, **change the test to match `src/lib/warranty/constants.ts`, never the constants** — MUST-6.14 makes that module the single source of the verb.

- [ ] **Type-check, run the full suite and commit.**
  ```powershell
  npm run typecheck
  npm test
  git add src/lib/notify/render.ts tests/lib/notify/render.test.ts
  git commit -m "feat(notify): one pure renderer for all eight events

Channel-agnostic subject/body pairs (MUST-10.1), money through formatCents and
months through monthLabel (MUST-10.2), untrusted values plain and truncated
(MUST-10.3), and no link in any body (MUST-10.4). The coming-due verb comes from
warranty/constants.ts so notifications are not a second place it is written."
  ```

<!-- END TASK 5 -->

---

# Phase 2 — Delivery

## Task 6: The outbox, the sender dispatch seam, backoff and retention

**Context:** Spec §7 in full, plus §3.9 (dedup), §3.14 (retention) and MUST-17.1's test seam. Implements **MUST-3.9, MUST-3.10, MUST-3.14, MUST-7.1 … MUST-7.11**. The concrete transports arrive in Task 7; this task builds the queue, the pump, the backoff ladder and the `setNotifySenderForTests` seam that every later test uses, so `deliver()` here is a dispatcher with two `throw new Error('not implemented')` arms that Task 7 fills in.

**Files:**
- Create: `src/lib/notify/send/index.ts`
- Create: `src/lib/notify/outbox.ts`
- Modify: `src/lib/backup.ts` (a sixth purge in `runMaintenanceSweep()`)
- Test: `tests/lib/notify/outbox.test.ts`
- Test: `tests/lib/backup.test.ts` (append one suite)

**Interfaces:**
- Consumes: `getDb()` from `@/db/client`; `notificationOutbox` from `@/db/schema`; `and`, `asc`, `eq`, `lte`, `lt`, `inArray`, `sql` from `drizzle-orm`; `nowIso(at?)` from `@/lib/clock`; `Channel`, `CHANNELS` from `@/lib/notify/events`; `isEventEnabled`, `getTarget`, `getSmtp`, `getSmtpPassword`, `getTelegramToken`, `recordTargetOutcome`, `recordSmtpOutcome`, `type SmtpSecurity` from `@/lib/notify/config`; `scrubSecrets`, `NotifyCredentialError`, `CREDENTIAL_UNREADABLE`, `authPlainBase64` from `@/lib/notify/crypto`; `runMaintenanceSweep`/`SweepResult` in `@/lib/backup`.
- Produces:
  ```ts
  // src/lib/notify/send/index.ts — SERVER ONLY (MUST-2.2)
  export type NotifyErrorScope = 'target' | 'relay';
  export class NotifyError extends Error {
    readonly permanent: boolean;
    readonly scope: NotifyErrorScope;
    readonly retryAfterMs: number | null;
    constructor(message: string, opts: { permanent: boolean; scope?: NotifyErrorScope; retryAfterMs?: number | null });
  }
  export interface SmtpTransportConfig {
    host: string; port: number; security: SmtpSecurity; username: string; password: string;
    fromEmail: string; fromName: string;
  }
  export type DeliveryRequest =
    | { channel: 'telegram'; destination: string; botToken: string; subject: string; body: string }
    | { channel: 'email'; destination: string; smtp: SmtpTransportConfig; subject: string; body: string };
  export type NotifySender = (request: DeliveryRequest) => Promise<void>;
  export function deliver(request: DeliveryRequest): Promise<void>;
  export function setNotifySenderForTests(fake: NotifySender): void;
  export function resetNotifySenderForTests(): void;

  // src/lib/notify/outbox.ts — SERVER ONLY
  export const OUTBOX_BATCH = 50;
  export const MAX_ATTEMPTS = 8;
  export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
  export const PENDING_MAX_AGE_HOURS = 24;
  export const OUTBOX_RETENTION_DAYS = 90;
  export const CHANNEL_REMOVED_ERROR = 'Channel was removed before delivery.';
  export const PENDING_EXPIRED_ERROR = 'Not delivered within 24 hours.';
  export function backoffMs(attempts: number): number;
  export function enqueue(input: { userId: number; eventId: string; dedupKey: string; subject: string; body: string; at?: Date }): { inserted: Channel[] };
  export function countPendingOutbox(): number;
  export function expireStalePending(now?: Date): number;
  export function pumpOutbox(now?: Date): Promise<{ sent: number; failed: number; deferred: number }>;
  export function kickOutbox(now?: Date): void;
  export function drainOutboxForTests(): Promise<void>;
  export function resetOutboxPumpForTests(): void;
  export function purgeOldOutboxRows(at?: Date): number;
  export interface DeliveryRow {
    id: number; userId: number; channel: Channel; eventId: string; subject: string;
    status: 'pending' | 'sent' | 'failed'; attempts: number; lastError: string | null;
    createdAt: string; sentAt: string | null;
  }
  export function listRecentDeliveries(input: { userId: number | null; limit?: number }): DeliveryRow[];
  ```

### Steps

- [ ] **Write the failing test `tests/lib/notify/outbox.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { sql } from 'drizzle-orm';
  import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
  import { saveEmailTarget, saveSmtp, saveTelegramTarget, getTarget, removeTarget } from '@/lib/notify/config';
  import { NotifyError, resetNotifySenderForTests, setNotifySenderForTests, type DeliveryRequest } from '@/lib/notify/send';
  import {
    CHANNEL_REMOVED_ERROR,
    MAX_ATTEMPTS,
    MAX_BACKOFF_MS,
    PENDING_EXPIRED_ERROR,
    backoffMs,
    countPendingOutbox,
    drainOutboxForTests,
    enqueue,
    expireStalePending,
    listRecentDeliveries,
    pumpOutbox,
    purgeOldOutboxRows,
    resetOutboxPumpForTests,
  } from '@/lib/notify/outbox';

  const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';

  let t: TestDb;
  let sent: DeliveryRequest[];

  beforeEach(() => {
    t = createTestDb();
    sent = [];
    resetOutboxPumpForTests();
    setNotifySenderForTests(async (request) => {
      sent.push(request);
    });
  });

  afterEach(() => {
    resetNotifySenderForTests();
    resetOutboxPumpForTests();
    t.cleanup();
  });

  function configuredUser(): number {
    const userId = insertTestUser(t.db, { role: 'admin', username: `u${Math.random().toString(36).slice(2, 8)}` });
    saveSmtp({
      preset: 'brevo',
      host: 'smtp-relay.brevo.com',
      port: 587,
      security: 'starttls',
      username: 'me@example.com',
      password: 'pw',
      fromEmail: 'me@example.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
    return userId;
  }

  describe('MUST-7.6: the backoff ladder', () => {
    it('is 1/2/4/8/16/32/64/128 minutes and caps at six hours', () => {
      const minutes = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n) / 60_000);
      expect(minutes).toEqual([2, 4, 8, 16, 32, 64, 128, 256]);
      expect(backoffMs(12)).toBe(MAX_BACKOFF_MS);
      expect(MAX_ATTEMPTS).toBe(8);
    });
  });

  describe('MUST-7.1 / MUST-3.9: enqueue', () => {
    it('inserts one row per enabled channel', () => {
      const userId = configuredUser();
      const result = enqueue({ userId, eventId: 'coming_due', dedupKey: 'due:1:2026-09-01', subject: 's', body: 'b' });
      expect(result.inserted.sort()).toEqual(['email', 'telegram']);
      expect(countPendingOutbox()).toBe(2);
    });

    it('a duplicate enqueue inserts nothing and reports it', () => {
      const userId = configuredUser();
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'due:1:2026-09-01', subject: 's', body: 'b' });
      const again = enqueue({ userId, eventId: 'coming_due', dedupKey: 'due:1:2026-09-01', subject: 's', body: 'b' });
      expect(again.inserted).toEqual([]);
      expect(countPendingOutbox()).toBe(2);
    });

    it('MUST-4.2: enqueues nothing for a user with no channel', () => {
      const userId = insertTestUser(t.db, { username: 'bare' });
      expect(enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b' }).inserted).toEqual([]);
      expect(countPendingOutbox()).toBe(0);
    });

    it('sets attempts 0 and next_attempt_at = created_at', () => {
      const userId = configuredUser();
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
      const row = t.sqlite.prepare('select attempts, next_attempt_at, created_at from notification_outbox limit 1').get() as {
        attempts: number;
        next_attempt_at: string;
        created_at: string;
      };
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at).toBe(row.created_at);
      expect(row.created_at).toBe('2026-08-17T12:00:00.000Z');
    });
  });

  describe('MUST-7.3: the pump', () => {
    it('sends both channels and marks the rows sent', async () => {
      const userId = configuredUser();
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 'Subject', body: 'Body' });
      const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
      expect(result).toEqual({ sent: 2, failed: 0, deferred: 0 });
      expect(sent.map((r) => r.channel).sort()).toEqual(['email', 'telegram']);
      expect(sent.every((r) => r.subject === 'Subject' && r.body === 'Body')).toBe(true);
      const rows = t.sqlite.prepare(`select status, sent_at from notification_outbox`).all() as {
        status: string;
        sent_at: string | null;
      }[];
      expect(rows.every((r) => r.status === 'sent' && r.sent_at !== null)).toBe(true);
    });

    it('MUST-7.3: per-channel isolation — a Telegram throw leaves email rows untouched', async () => {
      const userId = configuredUser();
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k1', subject: 's', body: 'b' });
      setNotifySenderForTests(async (request) => {
        if (request.channel === 'telegram') throw new NotifyError('telegram down', { permanent: false });
        sent.push(request);
      });
      const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
      expect(result.sent).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.channel).toBe('email');
      const telegram = t.sqlite
        .prepare(`select status, attempts from notification_outbox where channel = 'telegram'`)
        .get() as { status: string; attempts: number };
      expect(telegram.status).toBe('pending');
      expect(telegram.attempts).toBe(1);
    });

    it('MUST-7.4: the first transient failure defers the rest of that channel group untried', async () => {
      const userId = configuredUser();
      removeTarget(userId, 'email');
      for (let i = 0; i < 4; i += 1) {
        enqueue({ userId, eventId: 'coming_due', dedupKey: `k${i}`, subject: 's', body: 'b' });
      }
      let calls = 0;
      setNotifySenderForTests(async () => {
        calls += 1;
        throw new NotifyError('relay unreachable', { permanent: false });
      });
      const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
      expect(calls).toBe(1);
      expect(result.deferred).toBe(3);
      const rows = t.sqlite.prepare(`select attempts, next_attempt_at from notification_outbox order by id`).all() as {
        attempts: number;
        next_attempt_at: string;
      }[];
      // Every row in the group shares the same next_attempt_at; only the attempted one
      // incremented its counter.
      expect(rows.map((r) => r.attempts)).toEqual([1, 0, 0, 0]);
      expect(new Set(rows.map((r) => r.next_attempt_at)).size).toBe(1);
    });

    it('MUST-7.7: a permanent failure flips to failed on the first attempt', async () => {
      const userId = configuredUser();
      removeTarget(userId, 'telegram');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b' });
      setNotifySenderForTests(async () => {
        throw new NotifyError('550 no such recipient', { permanent: true });
      });
      const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
      expect(result.failed).toBe(1);
      const row = t.sqlite.prepare(`select status, attempts, last_error from notification_outbox`).get() as {
        status: string;
        attempts: number;
        last_error: string;
      };
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('550 no such recipient');
    });

    it('MUST-7.6: attempt 8 flips the row to failed', async () => {
      const userId = configuredUser();
      removeTarget(userId, 'telegram');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b' });
      setNotifySenderForTests(async () => {
        throw new NotifyError('temporary', { permanent: false });
      });
      let clock = new Date('2026-08-17T12:00:00Z').getTime();
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await pumpOutbox(new Date(clock));
        clock += MAX_BACKOFF_MS;
      }
      const row = t.sqlite.prepare(`select status, attempts from notification_outbox`).get() as {
        status: string;
        attempts: number;
      };
      expect(row.attempts).toBe(MAX_ATTEMPTS);
      expect(row.status).toBe('failed');
    });

    it('honours a retryAfterMs from the transport over the computed backoff', async () => {
      const userId = configuredUser();
      removeTarget(userId, 'email');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b' });
      setNotifySenderForTests(async () => {
        throw new NotifyError('429 slow down', { permanent: false, retryAfterMs: 45_000 });
      });
      await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
      const row = t.sqlite.prepare(`select next_attempt_at from notification_outbox`).get() as { next_attempt_at: string };
      expect(row.next_attempt_at).toBe('2026-08-17T12:00:45.000Z');
    });

    it('MUST-7.5: pre-send revalidation refuses a removed target and sends nothing', async () => {
      const userId = configuredUser();
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b' });
      removeTarget(userId, 'telegram');
      const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(1);
      expect(sent.map((r) => r.channel)).toEqual(['email']);
      const row = t.sqlite
        .prepare(`select status, last_error from notification_outbox where channel = 'telegram'`)
        .get() as { status: string; last_error: string };
      expect(row.status).toBe('failed');
      expect(row.last_error).toBe(CHANNEL_REMOVED_ERROR);
    });

    it('MUST-7.5: a disabled relay stops queued email rows too', async () => {
      const userId = configuredUser();
      removeTarget(userId, 'telegram');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b' });
      saveSmtp({
        preset: 'brevo',
        host: 'smtp-relay.brevo.com',
        port: 587,
        security: 'starttls',
        username: 'me@example.com',
        password: null,
        fromEmail: 'me@example.com',
        fromName: 'Budget Tracker',
        enabled: false,
      });
      await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
      expect(sent).toHaveLength(0);
      const row = t.sqlite.prepare(`select status, last_error from notification_outbox`).get() as {
        status: string;
        last_error: string;
      };
      expect(row.status).toBe('failed');
      expect(row.last_error).toBe(CHANNEL_REMOVED_ERROR);
    });

    it('ignores rows whose next_attempt_at is in the future', async () => {
      const userId = configuredUser();
      removeTarget(userId, 'telegram');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T13:00:00Z') });
      const result = await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
      expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
      expect(sent).toHaveLength(0);
    });

    it('MUST-7.10: outcomes land on the target row', async () => {
      const userId = configuredUser();
      removeTarget(userId, 'email');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k1', subject: 's', body: 'b' });
      setNotifySenderForTests(async () => {
        throw new NotifyError('chat not found', { permanent: true });
      });
      await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
      expect(getTarget(userId, 'telegram')?.lastError).toBe('chat not found');
      setNotifySenderForTests(async (request) => {
        sent.push(request);
      });
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k2', subject: 's', body: 'b' });
      await pumpOutbox(new Date('2026-08-17T12:01:00Z'));
      expect(getTarget(userId, 'telegram')?.lastError).toBeNull();
      expect(getTarget(userId, 'telegram')?.lastSuccessAt).toBe('2026-08-17T12:01:00.000Z');
    });

    it('MUST-6.3: an overlapping pump is a no-op rather than a double send', async () => {
      const userId = configuredUser();
      removeTarget(userId, 'telegram');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b' });
      // A holder object, not a bare `let`: TypeScript narrows a `let` assigned only inside a
      // callback to `never` at the later call site and refuses to invoke it.
      const gate: { release: (() => void) | undefined } = { release: undefined };
      setNotifySenderForTests(
        (request) =>
          new Promise<void>((resolve) => {
            sent.push(request);
            gate.release = resolve;
          }),
      );
      const first = pumpOutbox(new Date('2026-08-17T12:00:00Z'));
      const second = await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
      expect(second).toEqual({ sent: 0, failed: 0, deferred: 0 });
      gate.release?.();
      await first;
      await drainOutboxForTests();
      expect(sent).toHaveLength(1);
    });
  });

  describe('MUST-7.8: boot expiry', () => {
    it('fails a 25-hour-old pending row and leaves a 23-hour-old one alone', () => {
      const userId = configuredUser();
      removeTarget(userId, 'telegram');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'old', subject: 's', body: 'b', at: new Date('2026-08-16T11:00:00Z') });
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'new', subject: 's', body: 'b', at: new Date('2026-08-16T13:00:00Z') });
      const expired = expireStalePending(new Date('2026-08-17T12:00:00Z'));
      expect(expired).toBe(1);
      const rows = t.sqlite
        .prepare(`select dedup_key, status, last_error from notification_outbox order by dedup_key`)
        .all() as { dedup_key: string; status: string; last_error: string | null }[];
      expect(rows).toEqual([
        { dedup_key: 'new', status: 'pending', last_error: null },
        { dedup_key: 'old', status: 'failed', last_error: PENDING_EXPIRED_ERROR },
      ]);
    });
  });

  describe('MUST-3.14: retention', () => {
    it('purges sent and failed rows older than 90 days and keeps pending ones', () => {
      const userId = configuredUser();
      removeTarget(userId, 'telegram');
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'a', subject: 's', body: 'b', at: new Date('2026-01-01T00:00:00Z') });
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'b', subject: 's', body: 'b', at: new Date('2026-01-01T00:00:00Z') });
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'c', subject: 's', body: 'b', at: new Date('2026-08-17T00:00:00Z') });
      t.db.run(sql`update notification_outbox set status = 'sent' where dedup_key = 'a'`);
      t.db.run(sql`update notification_outbox set status = 'failed' where dedup_key = 'b'`);
      const purged = purgeOldOutboxRows(new Date('2026-08-17T12:00:00Z'));
      expect(purged).toBe(2);
      const remaining = t.sqlite.prepare(`select dedup_key from notification_outbox`).all() as { dedup_key: string }[];
      expect(remaining.map((r) => r.dedup_key)).toEqual(['c']);
    });
  });

  describe('§11.6: recent deliveries', () => {
    it('returns the newest rows for one user, and household-wide for a null userId', async () => {
      const a = configuredUser();
      const b = insertTestUser(t.db, { username: 'second' });
      saveEmailTarget({ userId: b, destination: 'b@example.com', enabled: true });
      enqueue({ userId: a, eventId: 'coming_due', dedupKey: 'a', subject: 'A', body: 'b' });
      enqueue({ userId: b, eventId: 'coming_due', dedupKey: 'b', subject: 'B', body: 'b' });
      expect(listRecentDeliveries({ userId: a }).map((r) => r.subject)).toEqual(['A', 'A']);
      expect(listRecentDeliveries({ userId: null }).map((r) => r.subject).sort()).toEqual(['A', 'A', 'B']);
      expect(listRecentDeliveries({ userId: null, limit: 1 })).toHaveLength(1);
    });
  });

  describe('MUST-7.11: logging never contains a subject or a body', () => {
    it('logs one summary line per non-empty run and nothing more', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const userId = configuredUser();
      enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 'SECRET SUBJECT', body: 'SECRET BODY' });
      await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
      const lines = log.mock.calls.map((call) => call.join(' '));
      expect(lines.some((line) => line.startsWith('[notify] sent 2'))).toBe(true);
      expect(lines.join('\n')).not.toContain('SECRET SUBJECT');
      expect(lines.join('\n')).not.toContain('SECRET BODY');
      log.mockRestore();
    });

    it('logs nothing for an empty run', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });
  ```

- [ ] **Run it and confirm it fails.**
  ```powershell
  npx vitest run tests/lib/notify/outbox.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/notify/send"`.

- [ ] **Implement `src/lib/notify/send/index.ts` — the error type, the dispatch and the test seam.**
  ```ts
  import type { SmtpSecurity } from '@/lib/notify/config';

  export type NotifyErrorScope = 'target' | 'relay';

  /**
   * MUST-7.7 — `permanent` means the request will never succeed unchanged: HTTP 400/401/403/404
   * from Telegram (bad token, bad chat id, bot blocked or deleted) and an SMTP 5xx. HTTP 429
   * and 5xx, DNS failures, connect timeouts and SMTP 4xx are transient.
   *
   * MUST-7.10 — `scope` decides which row records the failure: 'relay' for a connection or
   * authentication problem with the household's SMTP server (recorded on notification_smtp),
   * 'target' for anything specific to one recipient (recorded on notification_targets).
   * Telegram failures are always 'target' — there is one bot per person.
   *
   * `retryAfterMs` carries Telegram's `parameters.retry_after` when present; it overrides the
   * computed backoff (MUST-7.7).
   *
   * Every message reaching here has ALREADY been through scrubSecrets (MUST-5.5).
   */
  export class NotifyError extends Error {
    readonly permanent: boolean;
    readonly scope: NotifyErrorScope;
    readonly retryAfterMs: number | null;

    constructor(
      message: string,
      opts: { permanent: boolean; scope?: NotifyErrorScope; retryAfterMs?: number | null },
    ) {
      super(message);
      this.name = 'NotifyError';
      this.permanent = opts.permanent;
      this.scope = opts.scope ?? 'target';
      this.retryAfterMs = opts.retryAfterMs ?? null;
    }
  }

  export interface SmtpTransportConfig {
    host: string;
    port: number;
    security: SmtpSecurity;
    username: string;
    password: string;
    fromEmail: string;
    fromName: string;
  }

  export type DeliveryRequest =
    | { channel: 'telegram'; destination: string; botToken: string; subject: string; body: string }
    | { channel: 'email'; destination: string; smtp: SmtpTransportConfig; subject: string; body: string };

  export type NotifySender = (request: DeliveryRequest) => Promise<void>;

  /**
   * MUST-17.1 — the seam. Mirrors the OCR engine seam (warranty MUST-7.17): every
   * evaluation, outbox and integration test installs a fake here, so nodemailer is never
   * constructed and `fetch` is never called outside the two transport unit tests.
   */
  let override: NotifySender | null = null;

  export function setNotifySenderForTests(fake: NotifySender): void {
    override = fake;
  }

  export function resetNotifySenderForTests(): void {
    override = null;
  }

  async function realSender(request: DeliveryRequest): Promise<void> {
    // Dynamic imports keep the transports — and nodemailer — out of the module graph until
    // a message is actually being delivered, which is what makes the dormancy rule
    // structural rather than conventional (MUST-1.1).
    if (request.channel === 'telegram') {
      const { sendTelegram } = await import('@/lib/notify/send/telegram');
      await sendTelegram({ botToken: request.botToken, chatId: request.destination, subject: request.subject, body: request.body });
      return;
    }
    const { sendEmail } = await import('@/lib/notify/send/email');
    await sendEmail({ smtp: request.smtp, to: request.destination, subject: request.subject, text: request.body });
  }

  export function deliver(request: DeliveryRequest): Promise<void> {
    return (override ?? realSender)(request);
  }
  ```
  Task 7 creates `send/telegram.ts` and `send/email.ts`. Until then the dynamic imports fail at runtime — which is correct and invisible to this task's tests, because every one of them installs the fake sender.

- [ ] **Implement `src/lib/notify/outbox.ts`.**
  ```ts
  import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
  import { getDb } from '@/db/client';
  import { notificationOutbox } from '@/db/schema';
  import { nowIso } from '@/lib/clock';
  import {
    getSmtp,
    getSmtpPassword,
    getTarget,
    getTelegramToken,
    isEventEnabled,
    recordSmtpOutcome,
    recordTargetOutcome,
  } from '@/lib/notify/config';
  import { NotifyCredentialError, authPlainBase64, scrubSecrets } from '@/lib/notify/crypto';
  import { CHANNELS, type Channel } from '@/lib/notify/events';
  import { NotifyError, deliver, type DeliveryRequest } from '@/lib/notify/send';

  /** §19.16: the numbers, in one place. */
  export const OUTBOX_BATCH = 50;
  export const MAX_ATTEMPTS = 8;
  export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
  export const PENDING_MAX_AGE_HOURS = 24;
  export const OUTBOX_RETENTION_DAYS = 90;

  export const CHANNEL_REMOVED_ERROR = 'Channel was removed before delivery.';
  export const PENDING_EXPIRED_ERROR = 'Not delivered within 24 hours.';

  /** MUST-7.6: 1, 2, 4, 8, 16, 32, 64, 128 minutes, capped at six hours. */
  export function backoffMs(attempts: number): number {
    return Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS);
  }

  /**
   * MUST-7.1 — resolves the user's enabled channels for the event via isEventEnabled() and
   * inserts ONE ROW PER CHANNEL, each with ON CONFLICT DO NOTHING. Enqueueing is the only
   * place channel fan-out happens, so per-channel isolation is structural: two rows, two
   * independent lifecycles.
   *
   * MUST-7.2 — subject and body are rendered by the CALLER, at evaluation time. Re-rendering
   * at send time after three retries would produce a "budget at 82%" alert that says 91%.
   */
  export function enqueue(input: {
    userId: number;
    eventId: string;
    dedupKey: string;
    subject: string;
    body: string;
    at?: Date;
  }): { inserted: Channel[] } {
    const db = getDb();
    const at = nowIso(input.at ?? new Date());
    const inserted: Channel[] = [];

    for (const channel of CHANNELS) {
      if (!isEventEnabled(input.userId, input.eventId, channel)) continue;
      // MUST-3.9: the row that was sent IS the dedup guard. `changes === 0` means
      // "already fired" — there is no separate bookkeeping that could drift.
      const result = db
        .insert(notificationOutbox)
        .values({
          userId: input.userId,
          channel,
          eventId: input.eventId,
          dedupKey: input.dedupKey,
          subject: input.subject,
          body: input.body,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: at,
          createdAt: at,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) inserted.push(channel);
    }

    return { inserted };
  }

  /** MUST-6.4: the other half of the dormancy bail. */
  export function countPendingOutbox(): number {
    const row = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.status, 'pending'))
      .get();
    return row?.n ?? 0;
  }

  /**
   * MUST-7.8 — on the first tick after boot, every pending row older than 24 hours is
   * abandoned. This covers a container that was off for a week and, importantly, a RESTORED
   * OLDER DATABASE whose outbox still holds rows that were pending when the backup was
   * taken; without it a restore would emit a flood of stale alerts about a world that no
   * longer exists.
   */
  export function expireStalePending(now: Date = new Date()): number {
    const cutoff = nowIso(new Date(now.getTime() - PENDING_MAX_AGE_HOURS * 60 * 60 * 1000));
    const result = getDb()
      .update(notificationOutbox)
      .set({ status: 'failed', lastError: PENDING_EXPIRED_ERROR })
      .where(and(eq(notificationOutbox.status, 'pending'), lt(notificationOutbox.createdAt, cutoff)))
      .run();
    return result.changes;
  }

  /** MUST-3.14: the sixth purge in runMaintenanceSweep(). */
  export function purgeOldOutboxRows(at: Date = new Date()): number {
    const cutoff = nowIso(new Date(at.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000));
    const result = getDb()
      .delete(notificationOutbox)
      .where(and(inArray(notificationOutbox.status, ['sent', 'failed']), lt(notificationOutbox.createdAt, cutoff)))
      .run();
    return result.changes;
  }

  export interface DeliveryRow {
    id: number;
    userId: number;
    channel: Channel;
    eventId: string;
    subject: string;
    status: 'pending' | 'sent' | 'failed';
    attempts: number;
    lastError: string | null;
    createdAt: string;
    sentAt: string | null;
  }

  /** §11.6: served by notification_outbox_user_idx. `userId: null` is the admin's view. */
  export function listRecentDeliveries(input: { userId: number | null; limit?: number }): DeliveryRow[] {
    const limit = input.limit ?? 20;
    const base = getDb()
      .select({
        id: notificationOutbox.id,
        userId: notificationOutbox.userId,
        channel: notificationOutbox.channel,
        eventId: notificationOutbox.eventId,
        subject: notificationOutbox.subject,
        status: notificationOutbox.status,
        attempts: notificationOutbox.attempts,
        lastError: notificationOutbox.lastError,
        createdAt: notificationOutbox.createdAt,
        sentAt: notificationOutbox.sentAt,
      })
      .from(notificationOutbox);
    const rows =
      input.userId === null
        ? base.orderBy(desc(notificationOutbox.id)).limit(limit).all()
        : base.where(eq(notificationOutbox.userId, input.userId)).orderBy(desc(notificationOutbox.id)).limit(limit).all();
    return rows;
  }

  type PendingRow = {
    id: number;
    userId: number;
    channel: Channel;
    subject: string;
    body: string;
    attempts: number;
  };

  /**
   * MUST-7.5 — pre-send revalidation. Re-reads the row's target immediately before sending.
   * If the target is gone or disabled, or (for email) the relay is gone or disabled, NOTHING
   * IS SENT. Removing a channel therefore stops egress at once, including for rows already
   * in the queue: the dormancy rule holds even with a full outbox.
   *
   * Returns the request to send, or null with the reason the row is dead.
   */
  function buildRequest(row: PendingRow): { request: DeliveryRequest } | { dead: string } {
    const target = getTarget(row.userId, row.channel);
    if (!target || !target.enabled) return { dead: CHANNEL_REMOVED_ERROR };

    if (row.channel === 'telegram') {
      let botToken: string;
      try {
        botToken = getTelegramToken(row.userId);
      } catch (error) {
        if (error instanceof NotifyCredentialError) return { dead: error.message };
        throw error;
      }
      return {
        request: { channel: 'telegram', destination: target.destination, botToken, subject: row.subject, body: row.body },
      };
    }

    const relay = getSmtp();
    if (!relay || !relay.enabled) return { dead: CHANNEL_REMOVED_ERROR };
    let password: string;
    try {
      password = getSmtpPassword();
    } catch (error) {
      if (error instanceof NotifyCredentialError) return { dead: error.message };
      throw error;
    }
    return {
      request: {
        channel: 'email',
        destination: target.destination,
        smtp: {
          host: relay.host,
          port: relay.port,
          security: relay.security,
          username: relay.username,
          password,
          fromEmail: relay.fromEmail,
          fromName: relay.fromName,
        },
        subject: row.subject,
        body: row.body,
      },
    };
  }

  /** MUST-5.5: everything written to last_error goes through here first. */
  function scrubForRow(message: string, request: DeliveryRequest | null): string {
    if (!request) return message;
    const secrets =
      request.channel === 'telegram'
        ? [request.botToken]
        : [request.smtp.password, authPlainBase64(request.smtp.username, request.smtp.password)];
    return scrubSecrets(message, secrets);
  }

  function markSent(id: number, at: string): void {
    getDb()
      .update(notificationOutbox)
      .set({ status: 'sent', sentAt: at, lastError: null })
      .where(eq(notificationOutbox.id, id))
      .run();
  }

  function markFailed(id: number, attempts: number, message: string): void {
    getDb()
      .update(notificationOutbox)
      .set({ status: 'failed', attempts, lastError: message })
      .where(eq(notificationOutbox.id, id))
      .run();
  }

  function markRetry(id: number, attempts: number, message: string, nextAt: string): void {
    getDb()
      .update(notificationOutbox)
      .set({ attempts, lastError: message, nextAttemptAt: nextAt })
      .where(eq(notificationOutbox.id, id))
      .run();
  }

  function deferRow(id: number, nextAt: string, message: string): void {
    getDb().update(notificationOutbox).set({ nextAttemptAt: nextAt, lastError: message }).where(eq(notificationOutbox.id, id)).run();
  }

  /**
   * MUST-6.3 — single-flight, the pump: Promise<void> | null pattern of
   * src/lib/warranty/ocr/queue.ts, verbatim. A tick that arrives while the previous one is
   * still draining returns immediately.
   */
  let pump: Promise<{ sent: number; failed: number; deferred: number }> | null = null;

  export function resetOutboxPumpForTests(): void {
    pump = null;
  }

  export async function drainOutboxForTests(): Promise<void> {
    while (pump !== null) {
      await pump;
    }
  }

  export function pumpOutbox(now: Date = new Date()): Promise<{ sent: number; failed: number; deferred: number }> {
    if (pump !== null) return Promise.resolve({ sent: 0, failed: 0, deferred: 0 });
    const run = drain(now).finally(() => {
      pump = null;
    });
    pump = run;
    return run;
  }

  /** Fire-and-forget kick used by the immediate raisers (§6.6) and the server actions. */
  export function kickOutbox(now?: Date): void {
    void pumpOutbox(now).catch((error) => {
      console.error('[notify] outbox pump failed', error);
    });
  }

  async function drain(now: Date): Promise<{ sent: number; failed: number; deferred: number }> {
    const at = nowIso(now);
    // MUST-7.3: served by notification_outbox_due_idx.
    const rows = getDb()
      .select({
        id: notificationOutbox.id,
        userId: notificationOutbox.userId,
        channel: notificationOutbox.channel,
        subject: notificationOutbox.subject,
        body: notificationOutbox.body,
        attempts: notificationOutbox.attempts,
      })
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.status, 'pending'), lte(notificationOutbox.nextAttemptAt, at)))
      .orderBy(asc(notificationOutbox.id))
      .limit(OUTBOX_BATCH)
      .all();

    let sent = 0;
    let failed = 0;
    let deferred = 0;

    // MUST-7.3: grouped by channel, each group inside its own try/catch. A Telegram group
    // that throws at the transport level cannot touch a single email row, and vice versa.
    for (const channel of CHANNELS) {
      const group = rows.filter((row) => row.channel === channel);
      if (group.length === 0) continue;

      try {
        let broken: string | null = null;
        let brokenNextAt = at;

        for (const row of group) {
          if (broken !== null) {
            // MUST-7.4: the per-channel circuit break. Every remaining row is deferred to
            // the same next_attempt_at WITHOUT being attempted, so a dead relay cannot cost
            // 50 × 15 s of connect timeouts inside one tick.
            deferRow(row.id, brokenNextAt, broken);
            deferred += 1;
            continue;
          }

          const built = buildRequest(row);
          if ('dead' in built) {
            markFailed(row.id, row.attempts, built.dead);
            failed += 1;
            continue;
          }

          const attempts = row.attempts + 1;
          try {
            await deliver(built.request);
            markSent(row.id, at);
            recordTargetOutcome({ userId: row.userId, channel, ok: true, at: now });
            if (channel === 'email') recordSmtpOutcome({ ok: true, at: now });
            sent += 1;
          } catch (error) {
            const notifyError =
              error instanceof NotifyError
                ? error
                : new NotifyError(error instanceof Error ? error.message : 'Send failed.', { permanent: false });
            const message = scrubForRow(notifyError.message, built.request);

            if (notifyError.scope === 'relay') recordSmtpOutcome({ ok: false, error: message, at: now });
            else recordTargetOutcome({ userId: row.userId, channel, ok: false, error: message, at: now });

            if (notifyError.permanent) {
              // MUST-7.7: skip backoff entirely and fail on the first attempt.
              markFailed(row.id, attempts, message);
              failed += 1;
              console.error(`[notify] permanent ${channel} failure on row ${row.id}: ${message}`);
              continue;
            }

            const waitMs = notifyError.retryAfterMs ?? backoffMs(attempts);
            const nextAt = nowIso(new Date(now.getTime() + waitMs));
            if (attempts >= MAX_ATTEMPTS) {
              markFailed(row.id, attempts, message);
              failed += 1;
            } else {
              markRetry(row.id, attempts, message, nextAt);
            }
            broken = message;
            brokenNextAt = nextAt;
          }
        }
      } catch (error) {
        // A genuine bug in the group loop must not stop the other channel.
        console.error(`[notify] ${channel} group aborted`, error);
      }
    }

    // MUST-7.11: one summary line per NON-EMPTY run. Never a subject, never a body, never a
    // credential.
    if (sent + failed + deferred > 0) console.log(`[notify] sent ${sent}, failed ${failed}, deferred ${deferred}`);
    return { sent, failed, deferred };
  }
  ```

- [ ] **Run the outbox test and confirm it passes.**
  ```powershell
  npx vitest run tests/lib/notify/outbox.test.ts
  ```
  Expected: green.

- [ ] **Wire the retention purge into `runMaintenanceSweep()` (MUST-3.14). Edit `src/lib/backup.ts`:** add `outboxRowsPurged: number;` as the sixth field of `SweepResult`, import `purgeOldOutboxRows` from `@/lib/notify/outbox`, and add the sixth entry to the returned object:
  ```ts
    // MUST-3.14: sent/failed notification_outbox rows older than OUTBOX_RETENTION_DAYS = 90.
    // Ninety days comfortably outlives the longest-lived dedup key that could still matter
    // (a monthly budget key, ~31 days) and keeps the table trivial.
    outboxRowsPurged: purgeOldOutboxRows(at),
  ```

- [ ] **Append the retention suite to `tests/lib/backup.test.ts`.**
  ```ts
  describe('MUST-3.14: the sweep prunes delivered notifications', () => {
    it('reports outboxRowsPurged and leaves pending rows alone', () => {
      const userId = insertTestUser(db);
      const old = '2026-01-01T00:00:00.000Z';
      const recent = '2026-08-17T00:00:00.000Z';
      const insert = (key: string, status: string, createdAt: string) =>
        sqlite
          .prepare(
            `insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, status, next_attempt_at, created_at)
             values (?, 'email', 'coming_due', ?, 's', 'b', ?, ?, ?)`,
          )
          .run(userId, key, status, createdAt, createdAt);
      insert('old-sent', 'sent', old);
      insert('old-failed', 'failed', old);
      insert('old-pending', 'pending', old);
      insert('new-sent', 'sent', recent);

      const result = runMaintenanceSweep(new Date('2026-08-17T12:00:00Z'));
      expect(result.outboxRowsPurged).toBe(2);
      const keys = (sqlite.prepare('select dedup_key from notification_outbox order by dedup_key').all() as { dedup_key: string }[])
        .map((r) => r.dedup_key);
      expect(keys).toEqual(['new-sent', 'old-pending']);
    });
  });
  ```
  Use whatever `db` / `sqlite` handles the surrounding file already establishes in its `beforeEach`; add `insertTestUser` to its imports from `../helpers/db` if it is not already there.

- [ ] **Run the backup test, then the full suite.**
  ```powershell
  npx vitest run tests/lib/backup.test.ts
  npm run typecheck
  npm test
  ```
  Expected: green. Any existing test asserting the exact shape of `SweepResult` needs the new field added — fix those assertions, not the field.

- [ ] **Commit.**
  ```powershell
  git add src/lib/notify/send/index.ts src/lib/notify/outbox.ts src/lib/backup.ts tests/lib/notify/outbox.test.ts tests/lib/backup.test.ts
  git commit -m "feat(notify): outbox, sender dispatch seam, backoff and 90-day retention

One row per channel with ON CONFLICT DO NOTHING as the dedup guard (MUST-7.1/3.9);
per-channel isolation and a circuit break inside a batch (MUST-7.3/7.4); pre-send
revalidation stops egress the moment a channel is removed (MUST-7.5); the
1/2/4/8/16/32/64/128-minute ladder capped at six hours (MUST-7.6); 24-hour boot
expiry (MUST-7.8) and the sixth maintenance purge (MUST-3.14)."
  ```

<!-- END TASK 6 -->

---

## Task 7: The two channel transports

**Context:** Spec §8 in full and §9.3. Implements **MUST-8.1 … MUST-8.17**, **MUST-9.3**, **MUST-15.1 … MUST-15.4**. Telegram is raw `fetch` (two endpoints, one origin); email is `nodemailer`, created per pump batch and closed after it.

**Ambiguity resolved:** MUST-8.12 lists exactly the transport options to pass. It does **not** include `ignoreTLS`, so `security: 'none'` is implemented as `secure: false, requireTLS: false` and nothing more — the spec's option list is treated as exhaustive rather than as a starting point.

**Files:**
- Modify: `package.json` (add `nodemailer` + `@types/nodemailer`)
- Create: `src/lib/notify/send/telegram.ts`
- Create: `src/lib/notify/send/email.ts`
- Test: `tests/lib/notify/telegram.test.ts`, `tests/lib/notify/detect-chats.test.ts`, `tests/lib/notify/email.test.ts`
- Modify: `tests/ops/install.test.ts` (widen the existing whole-codebase `fetch(` invariant — it currently allows SimpleFIN only)

**Interfaces:**
- Consumes: `TELEGRAM_API_ORIGIN`, `assertTelegramUrl` from `@/lib/notify/egress`; `NotifyError`, `type SmtpTransportConfig` from `@/lib/notify/send`; `scrubSecrets`, `authPlainBase64` from `@/lib/notify/crypto`; `createTransport` from `nodemailer`.
- Produces:
  ```ts
  // src/lib/notify/send/telegram.ts
  export const TELEGRAM_MAX_CHARS = 4000;
  export const TELEGRAM_TIMEOUT_MS = 15_000;
  export const MAX_DETECTED_CHATS = 20;
  export const CHAT_TITLE_MAX = 80;
  export const TELEGRAM_NO_MESSAGES = 'No messages yet. Open Telegram, find your bot, send it any message, then press this again.';
  export const TELEGRAM_TOKEN_REJECTED = 'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.';
  export interface TelegramChat { chatId: string; title: string; kind: 'private' | 'group' | 'supergroup' | 'channel'; lastMessageAt: string | null }
  export function sendTelegram(input: { botToken: string; chatId: string; subject: string; body: string }): Promise<void>;
  export function fetchTelegramChats(botToken: string): Promise<TelegramChat[]>;

  // src/lib/notify/send/email.ts
  export function sendEmail(input: { smtp: SmtpTransportConfig; to: string; subject: string; text: string }): Promise<void>;
  ```

### Steps

- [ ] **Add the dependency.**
  ```powershell
  npm install nodemailer
  npm install --save-dev @types/nodemailer
  node -e "const n=require('nodemailer'); console.log('nodemailer', typeof n.createTransport);"
  ```
  Expected: `nodemailer function`. If `npm install` reports an `ERESOLVE` peer conflict, rerun with `--legacy-peer-deps` (the repo already uses that flag where recharts/React 19 needs it).
  MUST-15.4: do **not** add `nodemailer` to `serverExternalPackages` in `next.config.ts` unless `npm run build` later proves it necessary — it is pure JS with no native binding and no worker file.

- [ ] **Write the failing test `tests/lib/notify/telegram.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { NotifyError } from '@/lib/notify/send';
  import { TELEGRAM_MAX_CHARS, sendTelegram } from '@/lib/notify/send/telegram';

  const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';

  let calls: { url: string; init: RequestInit }[];

  function stubFetch(response: { status: number; body: unknown }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          async json() {
            return response.body;
          },
          async text() {
            return JSON.stringify(response.body);
          },
        } as unknown as Response;
      }),
    );
  }

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // MUST-17.1: nothing in this suite may have reached a real host.
    for (const call of calls) expect(call.url.startsWith('https://api.telegram.org/')).toBe(true);
  });

  describe('MUST-8.1 / MUST-8.2 / MUST-9.3: the request', () => {
    it('POSTs JSON to sendMessage on the pinned origin', async () => {
      stubFetch({ status: 200, body: { ok: true } });
      await sendTelegram({ botToken: TOKEN, chatId: '5551234', subject: 'Subject', body: 'Body' });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
      expect(calls[0]?.init.method).toBe('POST');
      expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(calls[0]?.init.redirect).toBe('error');
      expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    });

    it('sends subject + blank line + body, with no parse_mode key at all', async () => {
      stubFetch({ status: 200, body: { ok: true } });
      await sendTelegram({ botToken: TOKEN, chatId: '5551234', subject: 'Subject', body: 'Body' });
      const payload = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
      expect(payload).toEqual({ chat_id: '5551234', text: 'Subject\n\nBody', disable_web_page_preview: true });
      expect('parse_mode' in payload).toBe(false);
    });

    it('MUST-8.3: truncates to 4000 characters with a trailing ellipsis', async () => {
      stubFetch({ status: 200, body: { ok: true } });
      await sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'x'.repeat(8000) });
      const payload = JSON.parse(String(calls[0]?.init.body)) as { text: string };
      expect(payload.text).toHaveLength(TELEGRAM_MAX_CHARS);
      expect(payload.text.endsWith('…')).toBe(true);
    });

    it('renders markup literally rather than interpreting it', async () => {
      stubFetch({ status: 200, body: { ok: true } });
      await sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: '<b>x</b> *y* [z](http://q)' });
      const payload = JSON.parse(String(calls[0]?.init.body)) as { text: string };
      expect(payload.text).toContain('<b>x</b> *y* [z](http://q)');
    });
  });

  describe('MUST-7.7 / MUST-8.4: failure classification', () => {
    for (const status of [400, 401, 403, 404]) {
      it(`${status} is permanent and surfaces Telegram's own description`, async () => {
        stubFetch({ status, body: { ok: false, description: 'chat not found' } });
        await expect(sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' })).rejects.toMatchObject({
          permanent: true,
          message: 'chat not found',
        });
      });
    }

    for (const status of [429, 500, 502, 503]) {
      it(`${status} is transient`, async () => {
        stubFetch({ status, body: { ok: false, description: 'try later' } });
        await expect(sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' })).rejects.toMatchObject({
          permanent: false,
        });
      });
    }

    it('honours parameters.retry_after on a 429', async () => {
      stubFetch({ status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 42 } } });
      await expect(sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' })).rejects.toMatchObject({
        permanent: false,
        retryAfterMs: 42_000,
      });
    });

    it('a network throw is transient and never echoes the token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ECONNRESET`);
        }),
      );
      const error = await sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' }).catch((e) => e as NotifyError);
      expect(error).toBeInstanceOf(NotifyError);
      expect((error as NotifyError).permanent).toBe(false);
      expect((error as NotifyError).message).not.toContain('AAHk3f');
      expect((error as NotifyError).message).toContain('[redacted]');
    });

    it('every Telegram failure is target-scoped, never relay-scoped', async () => {
      stubFetch({ status: 401, body: { ok: false, description: 'Unauthorized' } });
      await expect(sendTelegram({ botToken: TOKEN, chatId: '1', subject: 'S', body: 'B' })).rejects.toMatchObject({
        scope: 'target',
      });
    });
  });
  ```

- [ ] **Write the failing test `tests/lib/notify/detect-chats.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import {
    MAX_DETECTED_CHATS,
    TELEGRAM_NO_MESSAGES,
    TELEGRAM_TOKEN_REJECTED,
    fetchTelegramChats,
  } from '@/lib/notify/send/telegram';

  const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';

  let urls: string[];

  function stubUpdates(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return {
          ok: status >= 200 && status < 300,
          status,
          async json() {
            return body;
          },
        } as unknown as Response;
      }),
    );
  }

  function update(id: number, chat: Record<string, unknown>, date: number) {
    return { update_id: id, message: { message_id: id, date, chat } };
  }

  beforeEach(() => {
    urls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const url of urls) expect(url.startsWith('https://api.telegram.org/')).toBe(true);
  });

  describe('MUST-8.6 / MUST-8.7: the request', () => {
    it('GETs getUpdates on the allowed origin with limit and allowed_updates and NO offset', async () => {
      stubUpdates(200, { ok: true, result: [] });
      await fetchTelegramChats(TOKEN);
      const url = new URL(urls[0] ?? '');
      expect(url.origin).toBe('https://api.telegram.org');
      expect(url.pathname).toBe(`/bot${TOKEN}/getUpdates`);
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('allowed_updates')).toBe('["message"]');
      expect(url.searchParams.has('offset')).toBe(false);
    });

    it('is idempotent: a second call against the same response returns the same chats', async () => {
      const body = { ok: true, result: [update(1, { id: 5551234, type: 'private', first_name: 'Sam' }, 1755000000)] };
      stubUpdates(200, body);
      const first = await fetchTelegramChats(TOKEN);
      const second = await fetchTelegramChats(TOKEN);
      expect(second).toEqual(first);
      expect(urls.every((u) => !u.includes('offset'))).toBe(true);
    });
  });

  describe('MUST-8.8: dedupe and shape', () => {
    it('collapses several updates from one chat, keeping the newest date', async () => {
      stubUpdates(200, {
        ok: true,
        result: [
          update(1, { id: 5551234, type: 'private', first_name: 'Sam' }, 1755000000),
          update(2, { id: 5551234, type: 'private', first_name: 'Sam' }, 1755009999),
        ],
      });
      const chats = await fetchTelegramChats(TOKEN);
      expect(chats).toHaveLength(1);
      expect(chats[0]?.chatId).toBe('5551234');
      expect(chats[0]?.lastMessageAt).toBe(new Date(1755009999 * 1000).toISOString());
    });

    it('sorts newest first and caps the list at 20', async () => {
      stubUpdates(200, {
        ok: true,
        result: Array.from({ length: 30 }, (_, i) => update(i, { id: i + 1, type: 'private', first_name: `P${i}` }, 1_700_000_000 + i)),
      });
      const chats = await fetchTelegramChats(TOKEN);
      expect(chats).toHaveLength(MAX_DETECTED_CHATS);
      expect(chats[0]?.title).toBe('P29');
    });

    it('derives the title through title → first_name last_name → username → id', async () => {
      stubUpdates(200, {
        ok: true,
        result: [
          update(1, { id: 1, type: 'group', title: 'Grewal Family' }, 1_700_000_004),
          update(2, { id: 2, type: 'private', first_name: 'Sam', last_name: 'Grewal' }, 1_700_000_003),
          update(3, { id: 3, type: 'private', username: 'samg' }, 1_700_000_002),
          update(4, { id: 4, type: 'channel' }, 1_700_000_001),
        ],
      });
      expect((await fetchTelegramChats(TOKEN)).map((c) => [c.title, c.kind])).toEqual([
        ['Grewal Family', 'group'],
        ['Sam Grewal', 'private'],
        ['samg', 'private'],
        ['4', 'channel'],
      ]);
    });

    it('MUST-10.3: an untrusted title is returned as literal text, truncated to 80', async () => {
      stubUpdates(200, {
        ok: true,
        result: [
          update(1, { id: 1, type: 'group', title: '<b>hi</b>' }, 1_700_000_002),
          update(2, { id: 2, type: 'group', title: 'L'.repeat(300) }, 1_700_000_001),
        ],
      });
      const chats = await fetchTelegramChats(TOKEN);
      expect(chats[0]?.title).toBe('<b>hi</b>');
      expect(chats[1]?.title).toHaveLength(80);
    });

    it('keeps chat ids as strings — supergroup ids exceed safe-integer territory', async () => {
      stubUpdates(200, { ok: true, result: [update(1, { id: -1001234567890123, type: 'supergroup', title: 'Big' }, 1_700_000_000)] });
      const chats = await fetchTelegramChats(TOKEN);
      expect(typeof chats[0]?.chatId).toBe('string');
      expect(chats[0]?.chatId).toBe('-1001234567890123');
    });
  });

  describe('MUST-8.10: the three fixed outcomes', () => {
    it('an empty list resolves to [], and the caller renders the empty-state sentence', async () => {
      stubUpdates(200, { ok: true, result: [] });
      await expect(fetchTelegramChats(TOKEN)).resolves.toEqual([]);
      expect(TELEGRAM_NO_MESSAGES).toBe(
        'No messages yet. Open Telegram, find your bot, send it any message, then press this again.',
      );
    });

    it('401 rejects with the token-rejected sentence', async () => {
      stubUpdates(401, { ok: false, description: 'Unauthorized' });
      await expect(fetchTelegramChats(TOKEN)).rejects.toMatchObject({ message: TELEGRAM_TOKEN_REJECTED });
      expect(TELEGRAM_TOKEN_REJECTED).toBe(
        'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.',
      );
    });

    it('anything else surfaces Telegram’s own description with the fixed prefix', async () => {
      stubUpdates(409, { ok: false, description: 'terminated by other getUpdates request' });
      await expect(fetchTelegramChats(TOKEN)).rejects.toMatchObject({
        message: 'Telegram said: terminated by other getUpdates request',
      });
    });
  });

  describe('MUST-8.9: the token never escapes', () => {
    it('is absent from the returned value and from every error message', async () => {
      stubUpdates(200, { ok: true, result: [update(1, { id: 1, type: 'private', first_name: 'Sam' }, 1_700_000_000)] });
      expect(JSON.stringify(await fetchTelegramChats(TOKEN))).not.toContain('AAHk3f');

      vi.unstubAllGlobals();
      urls = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error(`getaddrinfo ENOTFOUND for https://api.telegram.org/bot${TOKEN}/getUpdates`);
        }),
      );
      const error = await fetchTelegramChats(TOKEN).catch((e) => e as Error);
      expect(error.message).not.toContain('AAHk3f');
      expect(error.message).toContain('[redacted]');
    });
  });
  ```

- [ ] **Write the failing test `tests/lib/notify/email.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { NotifyError, type SmtpTransportConfig } from '@/lib/notify/send';

  const sendMail = vi.fn();
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close }));

  vi.mock('nodemailer', () => ({ default: { createTransport }, createTransport }));

  const { sendEmail } = await import('@/lib/notify/send/email');

  function config(over: Partial<SmtpTransportConfig> = {}): SmtpTransportConfig {
    return {
      host: 'smtp-relay.brevo.com',
      port: 587,
      security: 'starttls',
      username: 'me@example.com',
      password: 'xsmtpsib-secret',
      fromEmail: 'me@example.com',
      fromName: 'Budget Tracker',
      ...over,
    };
  }

  beforeEach(() => {
    sendMail.mockReset().mockResolvedValue({ messageId: '1' });
    close.mockReset();
    createTransport.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('MUST-8.12 / MUST-8.13: the transport', () => {
    it('maps all three security values onto secure/requireTLS', async () => {
      await sendEmail({ smtp: config({ security: 'tls', port: 465 }), to: 'a@b.com', subject: 's', text: 't' });
      expect(createTransport.mock.calls[0]?.[0]).toMatchObject({ secure: true, requireTLS: false });

      await sendEmail({ smtp: config({ security: 'starttls' }), to: 'a@b.com', subject: 's', text: 't' });
      expect(createTransport.mock.calls[1]?.[0]).toMatchObject({ secure: false, requireTLS: true });

      await sendEmail({ smtp: config({ security: 'none' }), to: 'a@b.com', subject: 's', text: 't' });
      expect(createTransport.mock.calls[2]?.[0]).toMatchObject({ secure: false, requireTLS: false });
    });

    it('passes the documented timeouts, minimum TLS version and pool: false', async () => {
      await sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' });
      expect(createTransport.mock.calls[0]?.[0]).toMatchObject({
        host: 'smtp-relay.brevo.com',
        port: 587,
        pool: false,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 20_000,
        auth: { user: 'me@example.com', pass: 'xsmtpsib-secret' },
        tls: { minVersion: 'TLSv1.2' },
      });
    });

    it('closes the transport after the batch, including on failure', async () => {
      await sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' });
      expect(close).toHaveBeenCalledTimes(1);
      sendMail.mockRejectedValueOnce(Object.assign(new Error('boom'), { responseCode: 421 }));
      await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(2);
    });
  });

  describe('MUST-8.14: text only, never html', () => {
    it('formats From and passes only a text part', async () => {
      await sendEmail({ smtp: config(), to: 'sam@example.com', subject: 'Subject', text: 'Body' });
      const mail = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(mail).toEqual({
        from: '"Budget Tracker" <me@example.com>',
        to: 'sam@example.com',
        subject: 'Subject',
        text: 'Body',
      });
      expect('html' in mail).toBe(false);
    });
  });

  describe('MUST-7.7 / MUST-7.10: failure classification and scope', () => {
    it('a 5xx responseCode is permanent', async () => {
      sendMail.mockRejectedValueOnce(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }));
      await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
        permanent: true,
      });
    });

    it('a 4xx responseCode is transient', async () => {
      sendMail.mockRejectedValueOnce(Object.assign(new Error('421 too many connections'), { responseCode: 421 }));
      await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
        permanent: false,
      });
    });

    it('a connection or auth failure is relay-scoped; a rejected recipient is target-scoped', async () => {
      sendMail.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' }));
      await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
        scope: 'relay',
        permanent: false,
      });

      sendMail.mockRejectedValueOnce(Object.assign(new Error('535 auth failed'), { code: 'EAUTH', responseCode: 535 }));
      await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
        scope: 'relay',
        permanent: true,
      });

      sendMail.mockRejectedValueOnce(Object.assign(new Error('550 no such user'), { responseCode: 550 }));
      await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
        scope: 'target',
      });
    });

    it('MUST-5.5: the password and its AUTH PLAIN form never survive into the error', async () => {
      const authPlain = Buffer.from('\0me@example.com\0xsmtpsib-secret', 'utf8').toString('base64');
      sendMail.mockRejectedValueOnce(
        Object.assign(new Error(`535 auth failed: AUTH PLAIN ${authPlain} (pass xsmtpsib-secret)`), { code: 'EAUTH', responseCode: 535 }),
      );
      const error = await sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' }).catch((e) => e as NotifyError);
      expect(error.message).not.toContain('xsmtpsib-secret');
      expect(error.message).not.toContain(authPlain);
      expect(error.message).toContain('[redacted]');
    });
  });

  describe('MUST-8.17: saving the relay does not connect', () => {
    it('verify() is never used', async () => {
      const source = await import('node:fs').then((fs) =>
        fs.readFileSync(new URL('../../../src/lib/notify/send/email.ts', import.meta.url), 'utf8'),
      );
      expect(source).not.toContain('.verify(');
    });
  });
  ```

- [ ] **Run all three and confirm they fail.**
  ```powershell
  npx vitest run tests/lib/notify/telegram.test.ts tests/lib/notify/detect-chats.test.ts tests/lib/notify/email.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/notify/send/telegram"` and `"@/lib/notify/send/email"`.

- [ ] **Implement `src/lib/notify/send/telegram.ts`.**
  ```ts
  import { scrubSecrets } from '@/lib/notify/crypto';
  import { TELEGRAM_API_ORIGIN, assertTelegramUrl } from '@/lib/notify/egress';
  import { NotifyError } from '@/lib/notify/send';

  /** §19.16 / MUST-8.3: the API limit is 4096; a truncated digest beats a rejected one. */
  export const TELEGRAM_MAX_CHARS = 4000;
  export const TELEGRAM_TIMEOUT_MS = 15_000;
  export const MAX_DETECTED_CHATS = 20;
  export const CHAT_TITLE_MAX = 80;

  /** MUST-8.10: the three fixed outcome sentences for the Detect chat ID helper. */
  export const TELEGRAM_NO_MESSAGES =
    'No messages yet. Open Telegram, find your bot, send it any message, then press this again.';
  export const TELEGRAM_TOKEN_REJECTED =
    'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.';

  export interface TelegramChat {
    /** A string: supergroup ids exceed Number.MAX_SAFE_INTEGER territory. */
    chatId: string;
    /** Untrusted display text — a person can name a Telegram group anything (MUST-8.8). */
    title: string;
    kind: 'private' | 'group' | 'supergroup' | 'channel';
    lastMessageAt: string | null;
  }

  function truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  }

  /** MUST-5.5: the token is in the URL PATH, so every error string is scrubbed. */
  function clean(message: string, botToken: string): string {
    return scrubSecrets(message, [botToken]);
  }

  interface TelegramFailure {
    description?: unknown;
    parameters?: { retry_after?: unknown };
  }

  async function readFailure(response: Response): Promise<TelegramFailure> {
    try {
      return (await response.json()) as TelegramFailure;
    } catch {
      return {};
    }
  }

  /**
   * MUST-8.1 — POST https://api.telegram.org/bot<token>/sendMessage, raw fetch, no SDK.
   * MUST-8.2 — NO parse_mode. Messages are plain text, so a merchant name, an OCR-derived
   * warranty title or a user-supplied description can never be interpreted as markup or a
   * link. That is why §10 renders one plain-text body for both channels.
   * MUST-9.3 — redirect: 'error'. A 3xx from api.telegram.org is a failure, not a hop.
   */
  export async function sendTelegram(input: {
    botToken: string;
    chatId: string;
    subject: string;
    body: string;
  }): Promise<void> {
    const url = `${TELEGRAM_API_ORIGIN}/bot${input.botToken}/sendMessage`;
    assertTelegramUrl(url);

    const text = truncate(`${input.subject}\n\n${input.body}`, TELEGRAM_MAX_CHARS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: input.chatId, text, disable_web_page_preview: true }),
        redirect: 'error',
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
    } catch (error) {
      // DNS failures, connect timeouts and aborts are transient.
      const message = clean(error instanceof Error ? error.message : 'Telegram request failed.', input.botToken);
      throw new NotifyError(message, { permanent: false, scope: 'target' });
    }

    if (response.ok) return;

    const failure = await readFailure(response);
    // MUST-8.4: Telegram's own descriptions — "chat not found", "bot was blocked by the
    // user", "Unauthorized" — are exactly what the user needs to see in Settings.
    const description = typeof failure.description === 'string' ? failure.description : `Telegram returned ${response.status}.`;
    const message = clean(description, input.botToken);

    // MUST-7.7: 400/401/403/404 will never succeed unchanged.
    const permanent = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404;
    const retryAfter = failure.parameters?.retry_after;
    const retryAfterMs = typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter * 1000 : null;

    throw new NotifyError(message, { permanent, scope: 'target', retryAfterMs });
  }

  interface RawChat {
    id?: unknown;
    type?: unknown;
    title?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    username?: unknown;
  }

  function chatKind(value: unknown): TelegramChat['kind'] {
    return value === 'group' || value === 'supergroup' || value === 'channel' ? value : 'private';
  }

  function chatTitle(chat: RawChat, chatId: string): string {
    if (typeof chat.title === 'string' && chat.title.length > 0) return truncate(chat.title, CHAT_TITLE_MAX);
    const person = [chat.first_name, chat.last_name].filter((part): part is string => typeof part === 'string' && part.length > 0);
    if (person.length > 0) return truncate(person.join(' '), CHAT_TITLE_MAX);
    if (typeof chat.username === 'string' && chat.username.length > 0) return truncate(chat.username, CHAT_TITLE_MAX);
    return chatId;
  }

  /**
   * MUST-8.5/8.6 — the second and LAST Telegram endpoint the app may ever call. Same origin,
   * same assertTelegramUrl() guard, same redirect: 'error', same 15 s abort as sendMessage.
   *
   * MUST-8.7 — it MUST NOT consume the update queue: no `offset` parameter is passed, so
   * Telegram leaves the updates in place and the helper can be pressed repeatedly. Passing
   * an offset would acknowledge the updates and make the second press return nothing — the
   * exact confusing failure the helper exists to prevent.
   */
  export async function fetchTelegramChats(botToken: string): Promise<TelegramChat[]> {
    const url = `${TELEGRAM_API_ORIGIN}/bot${botToken}/getUpdates?limit=100&allowed_updates=${encodeURIComponent('["message"]')}`;
    assertTelegramUrl(url);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(clean(error instanceof Error ? error.message : 'Telegram request failed.', botToken));
    }

    if (!response.ok) {
      // MUST-8.10: three outcomes, each with fixed wording.
      if (response.status === 401) throw new Error(TELEGRAM_TOKEN_REJECTED);
      const failure = await readFailure(response);
      const description = typeof failure.description === 'string' ? failure.description : `HTTP ${response.status}`;
      throw new Error(clean(`Telegram said: ${description}`, botToken));
    }

    const payload = (await response.json()) as { result?: { message?: { date?: unknown; chat?: RawChat } }[] };
    const updates = Array.isArray(payload.result) ? payload.result : [];

    // MUST-8.8: reduce to a unique set of chats keyed by chat.id, keeping the most recent
    // date per chat, newest first, capped at MAX_DETECTED_CHATS.
    const byId = new Map<string, { chat: TelegramChat; seconds: number }>();
    for (const item of updates) {
      const chat = item.message?.chat;
      if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) continue;
      const chatId = String(chat.id);
      const seconds = typeof item.message?.date === 'number' ? item.message.date : 0;
      const existing = byId.get(chatId);
      if (existing && existing.seconds >= seconds) continue;
      byId.set(chatId, {
        seconds,
        chat: {
          chatId,
          title: chatTitle(chat, chatId),
          kind: chatKind(chat.type),
          lastMessageAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
        },
      });
    }

    return [...byId.values()]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, MAX_DETECTED_CHATS)
      .map((entry) => entry.chat);
  }
  ```

- [ ] **Implement `src/lib/notify/send/email.ts`.**
  ```ts
  import { createTransport } from 'nodemailer';
  import { authPlainBase64, scrubSecrets } from '@/lib/notify/crypto';
  import { NotifyError, type SmtpTransportConfig } from '@/lib/notify/send';

  const CONNECTION_TIMEOUT_MS = 15_000;
  const GREETING_TIMEOUT_MS = 15_000;
  const SOCKET_TIMEOUT_MS = 20_000;

  /** nodemailer error codes that mean "the relay itself is the problem" (MUST-7.10). */
  const RELAY_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EAUTH', 'ETLS']);

  function codeOf(error: unknown): string | null {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }

  function responseCodeOf(error: unknown): number | null {
    const value = (error as { responseCode?: unknown }).responseCode;
    return typeof value === 'number' ? value : null;
  }

  /**
   * MUST-8.12 — the exact option set the spec specifies, and nothing more. `secure` is
   * implicit TLS (port 465), `requireTLS` is a mandatory STARTTLS upgrade (port 587), and
   * 'none' is plain socket with neither.
   *
   * MUST-8.13 — pool: false, and the transport is created per batch and closed after it. A
   * household sends a handful of messages a day; a pooled connection to a third-party relay
   * would spend its life idle-timing-out and reconnecting.
   *
   * MUST-8.17 — transporter.verify() is deliberately NOT used anywhere: a relay that accepts
   * a connection but rejects the send is a false green light. Only a real Send test counts.
   */
  export async function sendEmail(input: {
    smtp: SmtpTransportConfig;
    to: string;
    subject: string;
    text: string;
  }): Promise<void> {
    const transporter = createTransport({
      host: input.smtp.host,
      port: input.smtp.port,
      secure: input.smtp.security === 'tls',
      requireTLS: input.smtp.security === 'starttls',
      auth: { user: input.smtp.username, pass: input.smtp.password },
      pool: false,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      tls: { minVersion: 'TLSv1.2' },
    });

    try {
      // MUST-8.14: `text` only — no `html`. Same untrusted-input reasoning as MUST-8.2, and
      // it removes the entire HTML-email test surface.
      await transporter.sendMail({
        from: `"${input.smtp.fromName}" <${input.smtp.fromEmail}>`,
        to: input.to,
        subject: input.subject,
        text: input.text,
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'The relay refused the message.';
      // MUST-5.5: nodemailer's authentication errors routinely quote the failing command
      // line, which on some relays includes the base64 AUTH PLAIN payload.
      const message = scrubSecrets(raw, [
        input.smtp.password,
        authPlainBase64(input.smtp.username, input.smtp.password),
      ]);

      const code = codeOf(error);
      const responseCode = responseCodeOf(error);
      // MUST-7.7: SMTP 5xx is permanent (authentication failure, invalid recipient);
      // SMTP 4xx, connect timeouts and DNS failures are transient.
      const permanent = responseCode !== null && responseCode >= 500;
      // MUST-7.10: a connection or authentication problem belongs to the household relay
      // row; anything the relay said about this one recipient belongs to the target row.
      const scope = code !== null && RELAY_CODES.has(code) ? 'relay' : 'target';

      throw new NotifyError(message, { permanent, scope });
    } finally {
      transporter.close();
    }
  }
  ```

- [ ] **Run the three transport tests and confirm they pass.**
  ```powershell
  npx vitest run tests/lib/notify/telegram.test.ts tests/lib/notify/detect-chats.test.ts tests/lib/notify/email.test.ts
  ```
  Expected: green.

- [ ] **Widen the existing whole-codebase fetch invariant in `tests/ops/install.test.ts`.** That file already carries a suite named *"the app makes no network call unless SimpleFIN is configured"* whose first test asserts the **only** `fetch(` call site under `src/**/*.ts` is in `src/lib/simplefin/**`. `src/lib/notify/send/telegram.ts` is now a second legitimate one, so that test will go red. Add the new directory to its exclusion globs and say why:
  ```ts
        ? spawnSync(
            'rg',
            [
              '-l',
              '--glob',
              'src/**/*.ts',
              '--glob',
              '!src/lib/simplefin/**',
              // v1.3.0: the second opt-in egress exception (notifications spec MUST-9.5).
              // Dormant until configured, two destinations, both chosen by the user. The
              // tighter invariant — exactly two fetch sites, both in send/telegram.ts, and
              // one URL literal — lives in tests/ops/notify-egress.test.ts (MUST-9.4).
              '--glob',
              '!src/lib/notify/**',
              '\\bfetch\\(',
              'src',
            ],
            { cwd: root, encoding: 'utf8' },
          )
        : { stdout: '', status: 1 };
  ```
  Do **not** widen it further than `src/lib/notify/**`, and do not delete the test.

- [ ] **Type-check, build and run the full suite.**
  ```powershell
  npx vitest run tests/ops/install.test.ts
  npm run typecheck
  npm run build
  npm test
  ```
  Expected: typecheck exits 0; the build succeeds. If the build complains about `nodemailer`, and only then, add `'nodemailer'` to `serverExternalPackages` in `next.config.ts` and record it as a deviation from MUST-15.4.

- [ ] **Commit.**
  ```powershell
  git add package.json package-lock.json src/lib/notify/send/telegram.ts src/lib/notify/send/email.ts tests/lib/notify/telegram.test.ts tests/lib/notify/detect-chats.test.ts tests/lib/notify/email.test.ts tests/ops/install.test.ts
  git commit -m "feat(notify): Telegram and SMTP transports

Telegram over raw fetch with no parse_mode, redirect: 'error', a 15s abort and
the assertTelegramUrl guard (MUST-8.1..8.4, 9.3); the Detect-chat-ID helper hits
getUpdates with no offset so repeated presses stay idempotent (MUST-8.5..8.11);
email over nodemailer, text only, pool: false, transport closed per batch, and
verify() never used (MUST-8.12..8.17). One new runtime dependency (MUST-15.1)."
  ```

<!-- END TASK 7 -->

---

# Phase 3 — Evaluation

## Task 8: Local-time helpers and slot arithmetic

**Context:** Spec §6.3. Implements **MUST-6.5 … MUST-6.9** and §17.1's `slots.test.ts`. Pure integer arithmetic on local wall-clock components — never `Date` addition. `src/lib/dates.ts` is isomorphic and must stay free of node builtins; `evaluate/slots.ts` is pure per MUST-2.1.

**Ambiguity resolved:** `stale_import`'s dedup key is `stale:<mondayOfThisWeekIso>` (MUST-3.11) but no helper is specified for it. `mondayOfIsoWeek(isoDate)` lives in `evaluate/slots.ts` alongside the other slot arithmetic, built on the existing pure `addDaysIso`.

**Files:**
- Modify: `src/lib/dates.ts` (two new pure helpers)
- Create: `src/lib/notify/evaluate/slots.ts`
- Test: `tests/lib/dates.test.ts` (append one suite)
- Test: `tests/lib/notify/slots.test.ts`

**Interfaces:**
- Consumes: `addDaysIso(isoDate, days)`, `todayIso(now?, tz?)` from `@/lib/dates`; `readTz()` from `@/lib/env-tz` (indirectly, via dates.ts).
- Produces:
  ```ts
  // src/lib/dates.ts — two new pure exports
  export function localHour(now: Date, tz?: string): number;      // 0..23, Intl hourCycle 'h23'
  export function localWeekday(now: Date, tz?: string): number;   // 0 = Sunday .. 6 = Saturday

  // src/lib/notify/evaluate/slots.ts — PURE (MUST-2.1)
  export const DAILY_MAX_CATCHUP_HOURS = 12;
  export const WEEKLY_MAX_CATCHUP_HOURS = 48;
  export interface SlotResult { slotDate: string; hoursSince: number; fires: boolean }
  export function dailySlot(now: Date, hour: number, tz: string): SlotResult;
  export function weeklySlot(now: Date, weekday: number, hour: number, tz: string): SlotResult;
  export function mondayOfIsoWeek(isoDate: string): string;
  ```

### Steps

- [ ] **Append the failing suite to `tests/lib/dates.test.ts`.**
  ```ts
  describe('MUST-6.5: local wall-clock components', () => {
    it('localHour uses hourCycle h23, so midnight is 0 and not 24', () => {
      // 2026-08-17T04:30:00Z is 00:30 in Toronto (EDT, UTC-4).
      expect(localHour(new Date('2026-08-17T04:30:00Z'), 'America/Toronto')).toBe(0);
      expect(localHour(new Date('2026-08-17T04:30:00Z'), 'UTC')).toBe(4);
      expect(localHour(new Date('2026-08-17T23:59:00Z'), 'UTC')).toBe(23);
      expect(localHour(new Date('2026-08-17T12:00:00Z'), 'America/Toronto')).toBe(8);
    });

    it('localWeekday is 0 = Sunday .. 6 = Saturday, in the given zone', () => {
      // 2026-08-17 is a Monday.
      expect(localWeekday(new Date('2026-08-17T12:00:00Z'), 'America/Toronto')).toBe(1);
      expect(localWeekday(new Date('2026-08-16T12:00:00Z'), 'UTC')).toBe(0);
      expect(localWeekday(new Date('2026-08-22T12:00:00Z'), 'UTC')).toBe(6);
      // 2026-08-17T02:00:00Z is still Sunday evening in Toronto.
      expect(localWeekday(new Date('2026-08-17T02:00:00Z'), 'America/Toronto')).toBe(0);
    });
  });
  ```
  Add `localHour` and `localWeekday` to the file's existing `@/lib/dates` import list.

- [ ] **Write the failing test `tests/lib/notify/slots.test.ts`.**
  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import {
    DAILY_MAX_CATCHUP_HOURS,
    WEEKLY_MAX_CATCHUP_HOURS,
    dailySlot,
    mondayOfIsoWeek,
    weeklySlot,
  } from '@/lib/notify/evaluate/slots';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const TZ = 'UTC';

  /** A UTC instant on 2026-08-17, which is a Monday. */
  function at(day: string, hour: number, minute = 0): Date {
    return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  }

  describe('MUST-2.1: slots.ts is pure', () => {
    it('imports no @/db, no @/lib/env and no node builtin', () => {
      const source = fs.readFileSync(path.join(root, 'src/lib/notify/evaluate/slots.ts'), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
      expect(source).not.toMatch(/from\s+['"]node:/);
    });
  });

  describe('MUST-6.6 / MUST-6.7: the daily slot at hour 8', () => {
    it('pins the catch-up windows', () => {
      expect(DAILY_MAX_CATCHUP_HOURS).toBe(12);
      expect(WEEKLY_MAX_CATCHUP_HOURS).toBe(48);
    });

    // §17.1's prose says "25 h stale" here; MUST-6.6's own formula gives 24 + (7 - 8) = 23.
    // The formula is normative and 23 is still far outside the 12-hour window, so the
    // outcome the spec asserts — SKIPPED — is unchanged.
    it('07:59 resolves to yesterday, 23 hours stale, and is SKIPPED', () => {
      const slot = dailySlot(at('2026-08-17', 7, 59), 8, TZ);
      expect(slot.slotDate).toBe('2026-08-16');
      expect(slot.hoursSince).toBe(23);
      expect(slot.fires).toBe(false);
    });

    it('08:00 resolves to today, 0 hours, and fires', () => {
      expect(dailySlot(at('2026-08-17', 8), 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 0, fires: true });
    });

    it('19:00 is today, 11 hours, and fires', () => {
      expect(dailySlot(at('2026-08-17', 19), 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 11, fires: true });
    });

    it('20:01 is 12 hours and still fires (the boundary is inclusive)', () => {
      expect(dailySlot(at('2026-08-17', 20, 1), 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 12, fires: true });
    });

    it('21:00 is 13 hours and is SKIPPED', () => {
      expect(dailySlot(at('2026-08-17', 21), 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 13, fires: false });
    });

    it('MUST-6.7: a container booting at 09:30 after missing 08:00 does fire', () => {
      expect(dailySlot(at('2026-08-17', 9, 30), 8, TZ).fires).toBe(true);
    });

    it('works for a midnight slot without going negative', () => {
      expect(dailySlot(at('2026-08-17', 0, 5), 0, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 0, fires: true });
      expect(dailySlot(at('2026-08-17', 23), 0, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 23, fires: false });
    });

    it('respects the timezone it is given', () => {
      // 2026-08-17T12:00:00Z is 08:00 in Toronto.
      expect(dailySlot(new Date('2026-08-17T12:00:00Z'), 8, 'America/Toronto')).toEqual({
        slotDate: '2026-08-17',
        hoursSince: 0,
        fires: true,
      });
    });
  });

  describe('MUST-6.6 / MUST-6.7: the weekly slot, W = 1 (Monday) at H = 8', () => {
    it('Monday 07:00 resolves to the previous Monday, 167 hours, SKIPPED', () => {
      expect(weeklySlot(at('2026-08-17', 7), 1, 8, TZ)).toEqual({ slotDate: '2026-08-10', hoursSince: 167, fires: false });
    });

    it('Monday 09:00 is today, 1 hour, fires', () => {
      expect(weeklySlot(at('2026-08-17', 9), 1, 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 1, fires: true });
    });

    it('Wednesday 09:00 is Monday, 49 hours, SKIPPED', () => {
      expect(weeklySlot(at('2026-08-19', 9), 1, 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 49, fires: false });
    });

    it('Wednesday 07:00 is Monday, 47 hours, and fires', () => {
      expect(weeklySlot(at('2026-08-19', 7), 1, 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 47, fires: true });
    });

    it('a Sunday slot (W = 0) resolves correctly from a Saturday', () => {
      // 2026-08-22 is a Saturday; the last Sunday slot was 2026-08-16 at 08:00.
      expect(weeklySlot(at('2026-08-22', 9), 0, 8, TZ)).toEqual({ slotDate: '2026-08-16', hoursSince: 145, fires: false });
    });
  });

  describe('mondayOfIsoWeek', () => {
    it('maps every day of a week onto its Monday', () => {
      expect(mondayOfIsoWeek('2026-08-17')).toBe('2026-08-17'); // Monday
      expect(mondayOfIsoWeek('2026-08-19')).toBe('2026-08-17'); // Wednesday
      expect(mondayOfIsoWeek('2026-08-23')).toBe('2026-08-17'); // Sunday
      expect(mondayOfIsoWeek('2026-08-24')).toBe('2026-08-24'); // next Monday
    });

    it('crosses a month boundary as pure string math', () => {
      expect(mondayOfIsoWeek('2026-09-02')).toBe('2026-08-31');
    });
  });
  ```

- [ ] **Run both and confirm they fail.**
  ```powershell
  npx vitest run tests/lib/dates.test.ts tests/lib/notify/slots.test.ts
  ```
  Expected failure: `localHour is not exported` / `Failed to resolve import "@/lib/notify/evaluate/slots"`.

- [ ] **Add the two helpers to `src/lib/dates.ts`,** immediately after `currentMonth()`:
  ```ts
  /**
   * MUST-6.5: local wall-clock components for the notification slot arithmetic, which is
   * pure integer maths on these numbers — never Date addition.
   *
   * hourCycle 'h23' is load-bearing: the default for en-CA is h12-with-24 ('24' for
   * midnight), which would make a midnight slot compare as 24 and never fire.
   */
  export function localHour(now: Date, tz?: string): number {
    const zone = tz ?? safeTz();
    const text = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(now);
    return Number(text);
  }

  const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /** 0 = Sunday .. 6 = Saturday, in the given zone (MUST-6.5). */
  export function localWeekday(now: Date, tz?: string): number {
    const zone = tz ?? safeTz();
    const text = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(now);
    return WEEKDAY_INDEX[text] ?? 0;
  }
  ```

- [ ] **Implement `src/lib/notify/evaluate/slots.ts`.**
  ```ts
  import { addDaysIso, localHour, localWeekday, todayIso } from '@/lib/dates';

  /**
   * Slot arithmetic and catch-up (spec §6.3). PURE (MUST-2.1) — no @/db, no @/lib/env, no
   * node builtin. Everything here is integer arithmetic on local wall-clock components plus
   * addDaysIso's string maths, so no DST boundary can shift a day.
   *
   * MUST-6.7 — the catch-up windows. A container booting at 09:30 after missing its 08:00
   * slot DOES fire (1.5 h late). A container booting at 23:00 the following day does NOT: a
   * "coming due" notice delivered 39 hours late, immediately ahead of the next day's, is
   * noise. The weekly window is longer because a Monday-evening reboot would otherwise lose
   * an entire week's digest.
   *
   * MUST-6.8 — hoursSince is WALL-CLOCK hours, so on a DST transition day it is off by one.
   * That is deliberate: being an hour out on a 12-hour window changes nothing, and real
   * instant arithmetic across a zone transition is the class of bug this repo has
   * consistently designed out (see addMonthsClamped, parseDateString).
   *
   * MUST-6.9 — firing a slot twice is harmless by construction: every scheduled event's
   * dedup key contains the slot date or is per-item, so a second evaluation inserts nothing.
   */
  export const DAILY_MAX_CATCHUP_HOURS = 12;
  export const WEEKLY_MAX_CATCHUP_HOURS = 48;

  export interface SlotResult {
    /** The ISO date of the slot this evaluation belongs to — part of the dedup key. */
    slotDate: string;
    /** Whole wall-clock hours since the slot's hour struck. */
    hoursSince: number;
    /** hoursSince <= the window for this slot kind. */
    fires: boolean;
  }

  /** MUST-6.6, daily at hour H. */
  export function dailySlot(now: Date, hour: number, tz: string): SlotResult {
    const currentHour = localHour(now, tz);
    const d = currentHour >= hour ? 0 : 1;
    const slotDate = addDaysIso(todayIso(now, tz), -d);
    const hoursSince = d * 24 + (currentHour - hour);
    return { slotDate, hoursSince, fires: hoursSince <= DAILY_MAX_CATCHUP_HOURS };
  }

  /** MUST-6.6, weekly on weekday W (0 = Sunday) at hour H. */
  export function weeklySlot(now: Date, weekday: number, hour: number, tz: string): SlotResult {
    const currentHour = localHour(now, tz);
    let d = (localWeekday(now, tz) - weekday + 7) % 7;
    if (d === 0 && currentHour < hour) d = 7;
    const slotDate = addDaysIso(todayIso(now, tz), -d);
    const hoursSince = d * 24 + (currentHour - hour);
    return { slotDate, hoursSince, fires: hoursSince <= WEEKLY_MAX_CATCHUP_HOURS };
  }

  /**
   * MUST-3.11: stale_import's key is `stale:<mondayOfThisWeekIso>`, so the key advances
   * every week and never repeats — which is what makes MUST-3.12's pruning-safety argument
   * hold for it. Pure string math via addDaysIso.
   */
  export function mondayOfIsoWeek(isoDate: string): string {
    // Zeller-free: 1970-01-01 was a Thursday, and addDaysIso is exact integer day maths, so
    // walk back from a known Monday instead of constructing a Date.
    const KNOWN_MONDAY = '2026-08-17';
    let offset = 0;
    // daysBetween is monotone; take the remainder against 7 without a Date object.
    const daysFrom = daysBetween(KNOWN_MONDAY, isoDate);
    offset = ((daysFrom % 7) + 7) % 7;
    return addDaysIso(isoDate, -offset);
  }

  /** Local integer day difference, using addDaysIso's inverse via binary search-free maths. */
  function daysBetween(fromIso: string, toIso: string): number {
    const toDays = (iso: string): number => {
      const y = Number(iso.slice(0, 4));
      const m = Number(iso.slice(5, 7));
      const d = Number(iso.slice(8, 10));
      const yy = m <= 2 ? y - 1 : y;
      const era = Math.floor(yy / 400);
      const yoe = yy - era * 400;
      const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
      const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
      return era * 146097 + doe - 719468;
    };
    return toDays(toIso) - toDays(fromIso);
  }
  ```
  If `daysBetweenIso` from `@/lib/dates` is preferred over the local copy, use it — it is the same civil-days maths and is already pure. Replace the private `daysBetween` with an import and delete the duplicate; run the test again to confirm.

- [ ] **Run both tests and confirm they pass.**
  ```powershell
  npx vitest run tests/lib/dates.test.ts tests/lib/notify/slots.test.ts
  ```
  Expected: green.

- [ ] **Type-check, run the full suite and commit.**
  ```powershell
  npm run typecheck
  npm test
  git add src/lib/dates.ts src/lib/notify/evaluate/slots.ts tests/lib/dates.test.ts tests/lib/notify/slots.test.ts
  git commit -m "feat(notify): local-hour/weekday helpers and slot catch-up arithmetic

Pure integer maths on wall-clock components, never Date addition (MUST-6.5/6.6);
12-hour daily and 48-hour weekly catch-up windows (MUST-6.7); wall-clock hours
accepted as off-by-one on a DST day, deliberately (MUST-6.8)."
  ```

<!-- END TASK 8 -->

---

## Task 9: The `coming_due` and `stale_import` evaluators

**Context:** Spec §6.4 and §10.1's `stale_import` row, plus §17.2's `coming-due.test.ts` and `stale.test.ts`. Implements **MUST-6.10 … MUST-6.14** and decision 10 (`stale_import` never fires on an install with zero imports).

**Files:**
- Create: `src/lib/notify/evaluate/coming-due.ts`
- Create: `src/lib/notify/evaluate/stale.ts`
- Test: `tests/lib/notify/evaluate/coming-due.test.ts`, `tests/lib/notify/evaluate/stale.test.ts`

**Interfaces:**
- Consumes: `getDb()` from `@/db/client`; `warrantyItems`, `warrantyItemTypes`, `imports` from `@/db/schema`; `and`, `asc`, `desc`, `eq`, `gte`, `isNotNull`, `lte`, `sql` from `drizzle-orm`; `addDaysIso`, `daysBetweenIso`, `todayIso` from `@/lib/dates`; `comingDueKey`, `staleImportKey` from `@/lib/notify/events`; `getUserSettings` from `@/lib/notify/config`; `enqueue` from `@/lib/notify/outbox`; `renderEvent` from `@/lib/notify/render`; `mondayOfIsoWeek` from `@/lib/notify/evaluate/slots`; `type ItemKind` from `@/lib/warranty/constants`.
- Produces:
  ```ts
  // src/lib/notify/evaluate/coming-due.ts
  export const MAX_NEW_ROWS_PER_USER_PER_EVALUATION = 20;
  export function evaluateComingDue(input: { userId: number; now: Date; tz: string }): number;

  // src/lib/notify/evaluate/stale.ts
  export function evaluateStaleImport(input: { userId: number; now: Date; tz: string }): number;
  ```
  Both return the number of *events* enqueued (an event may create one or two rows, one per channel).

### Steps

- [ ] **Write the failing test `tests/lib/notify/evaluate/coming-due.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { sql } from 'drizzle-orm';
  import { createTestDb, insertTestUser, type TestDb } from '../../../helpers/db';
  import { saveEmailTarget, saveSmtp, saveUserSettings, DEFAULT_USER_SETTINGS } from '@/lib/notify/config';
  import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
  import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
  import { MAX_NEW_ROWS_PER_USER_PER_EVALUATION, evaluateComingDue } from '@/lib/notify/evaluate/coming-due';

  let t: TestDb;
  const NOW = new Date('2026-08-17T12:00:00Z');
  const TZ = 'UTC';

  beforeEach(() => {
    t = createTestDb();
    resetOutboxPumpForTests();
    setNotifySenderForTests(async () => {});
  });

  afterEach(() => {
    resetNotifySenderForTests();
    resetOutboxPumpForTests();
    t.cleanup();
  });

  function emailUser(): number {
    const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
    saveSmtp({
      preset: 'brevo',
      host: 'h',
      port: 587,
      security: 'starttls',
      username: 'u',
      password: 'p',
      fromEmail: 'f@e.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    return userId;
  }

  function typeId(kind: 'warranty' | 'subscription' | 'contract' | 'loan'): number {
    const row = t.db.get<{ id: number }>(
      sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
          values (${`${kind}-${Math.random().toString(36).slice(2, 8)}`}, ${kind === 'subscription' ? 1 : 0}, ${kind}, ${'2026-01-01T00:00:00.000Z'})
          returning id`,
    );
    return row.id;
  }

  function item(over: {
    ownerUserId: number;
    name?: string;
    expiryDate?: string | null;
    isLifetime?: boolean;
    kind?: 'warranty' | 'subscription' | 'contract' | 'loan';
    vendor?: string | null;
    priceCents?: number | null;
  }): number {
    const row = t.db.get<{ id: number }>(
      sql`insert into warranty_items
            (name, vendor, purchase_date, is_lifetime, expiry_date, price_cents, owner_user_id, type_id, created_at, updated_at)
          values (${over.name ?? 'Dishwasher'}, ${over.vendor ?? null}, ${'2024-01-01'},
                  ${over.isLifetime ? 1 : 0}, ${over.expiryDate ?? null}, ${over.priceCents ?? null},
                  ${over.ownerUserId}, ${typeId(over.kind ?? 'warranty')}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})
          returning id`,
    );
    return row.id;
  }

  function queued(): { dedup_key: string; subject: string }[] {
    return t.sqlite
      .prepare(`select dedup_key, subject from notification_outbox order by id`)
      .all() as { dedup_key: string; subject: string }[];
  }

  describe('MUST-6.10: the window', () => {
    it('includes exactly today and exactly today + N, and excludes today + N + 1', () => {
      const userId = emailUser();
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, comingDueDays: 14 });
      item({ ownerUserId: userId, name: 'Today', expiryDate: '2026-08-17' });
      item({ ownerUserId: userId, name: 'Edge', expiryDate: '2026-08-31' });
      item({ ownerUserId: userId, name: 'Beyond', expiryDate: '2026-09-01' });
      item({ ownerUserId: userId, name: 'Past', expiryDate: '2026-08-16' });

      expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(2);
      expect(queued().map((r) => r.subject).sort()).toEqual(['Coming due: Edge', 'Coming due: Today']);
    });

    it('never fires for a lifetime item or an item with no expiry date', () => {
      const userId = emailUser();
      item({ ownerUserId: userId, name: 'Lifetime', expiryDate: '2026-08-20', isLifetime: true });
      item({ ownerUserId: userId, name: 'Open', expiryDate: null });
      expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(0);
      expect(queued()).toHaveLength(0);
    });

    it('honours the user’s own comingDueDays', () => {
      const userId = emailUser();
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, comingDueDays: 3 });
      item({ ownerUserId: userId, name: 'Soon', expiryDate: '2026-08-20' });
      item({ ownerUserId: userId, name: 'Later', expiryDate: '2026-08-21' });
      expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    });
  });

  describe('MUST-6.11: only the item’s owner is notified', () => {
    it('ignores another member’s items', () => {
      const mine = emailUser();
      const theirs = emailUser();
      item({ ownerUserId: theirs, name: 'Theirs', expiryDate: '2026-08-20' });
      expect(evaluateComingDue({ userId: mine, now: NOW, tz: TZ })).toBe(0);
      expect(evaluateComingDue({ userId: theirs, now: NOW, tz: TZ })).toBe(1);
    });
  });

  describe('MUST-6.12: announced once ever, per item and expiry date', () => {
    it('a second evaluation of the same slot enqueues nothing', () => {
      const userId = emailUser();
      item({ ownerUserId: userId, expiryDate: '2026-08-20' });
      expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
      expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(0);
      expect(queued()).toHaveLength(1);
    });

    it('editing the expiry date produces a second, correctly-keyed message', () => {
      const userId = emailUser();
      const id = item({ ownerUserId: userId, expiryDate: '2026-08-20' });
      evaluateComingDue({ userId, now: NOW, tz: TZ });
      t.db.run(sql`update warranty_items set expiry_date = ${'2026-08-25'} where id = ${id}`);
      expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
      expect(queued().map((r) => r.dedup_key)).toEqual([`due:${id}:2026-08-20`, `due:${id}:2026-08-25`]);
    });
  });

  describe('MUST-6.13: the flood guard', () => {
    it('caps a single evaluation at 20 new rows and picks the rest up next slot', () => {
      const userId = emailUser();
      for (let i = 0; i < 25; i += 1) item({ ownerUserId: userId, name: `Item ${i}`, expiryDate: '2026-08-20' });
      expect(MAX_NEW_ROWS_PER_USER_PER_EVALUATION).toBe(20);
      expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(20);
      expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(5);
      expect(queued()).toHaveLength(25);
    });
  });

  describe('MUST-6.14: the verb comes from the item’s kind', () => {
    it('a loan says "paid off by" and a subscription "cancel by"', () => {
      const userId = emailUser();
      item({ ownerUserId: userId, name: 'Car loan', expiryDate: '2026-08-20', kind: 'loan' });
      item({ ownerUserId: userId, name: 'Netflix', expiryDate: '2026-08-21', kind: 'subscription' });
      evaluateComingDue({ userId, now: NOW, tz: TZ });
      const bodies = (t.sqlite.prepare('select body from notification_outbox order by id').all() as { body: string }[]).map(
        (r) => r.body,
      );
      expect(bodies[0]).toContain('paid off by');
      expect(bodies[1]).toContain('cancel by');
    });

    it('includes the vendor and the price when they are set', () => {
      const userId = emailUser();
      item({ ownerUserId: userId, name: 'Fridge', expiryDate: '2026-08-20', vendor: 'Costco', priceCents: 129999 });
      evaluateComingDue({ userId, now: NOW, tz: TZ });
      const row = t.sqlite.prepare('select body from notification_outbox').get() as { body: string };
      expect(row.body).toContain('Costco');
      expect(row.body).toContain('$1,299.99');
    });
  });
  ```

- [ ] **Write the failing test `tests/lib/notify/evaluate/stale.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { sql } from 'drizzle-orm';
  import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
  import { DEFAULT_USER_SETTINGS, saveEmailTarget, saveSmtp, saveUserSettings } from '@/lib/notify/config';
  import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
  import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
  import { evaluateStaleImport } from '@/lib/notify/evaluate/stale';

  let t: TestDb;
  const TZ = 'UTC';

  beforeEach(() => {
    t = createSeededTestDb();
    resetOutboxPumpForTests();
    setNotifySenderForTests(async () => {});
  });

  afterEach(() => {
    resetNotifySenderForTests();
    resetOutboxPumpForTests();
    t.cleanup();
  });

  function emailUser(): number {
    const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
    saveSmtp({
      preset: 'brevo',
      host: 'h',
      port: 587,
      security: 'starttls',
      username: 'u',
      password: 'p',
      fromEmail: 'f@e.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    return userId;
  }

  function importAt(userId: number, createdAt: string): void {
    const accountId = insertTestAccount(t.db);
    t.db.run(
      sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
          values (${accountId}, null, ${'export.csv'}, ${userId}, 10, 0, 0, ${createdAt})`,
    );
  }

  function keys(): string[] {
    return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
      (r) => r.dedup_key,
    );
  }

  describe('decision 10: an install with zero imports never fires', () => {
    it('says nothing before the household has anything to be stale about', () => {
      const userId = emailUser();
      expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
      expect(keys()).toEqual([]);
    });
  });

  describe('the N-week threshold', () => {
    it('is silent at N × 7 − 1 days and fires at N × 7', () => {
      const userId = emailUser();
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
      importAt(userId, '2026-07-28T12:00:00.000Z'); // 20 days before 2026-08-17
      expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
      expect(evaluateStaleImport({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(1);
    });

    it('honours a different staleImportWeeks', () => {
      const userId = emailUser();
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 1 });
      importAt(userId, '2026-08-10T12:00:00.000Z');
      expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(1);
    });
  });

  describe('MUST-3.11: one message per calendar week while stale', () => {
    it('dedupes within a week and fires again the following week', () => {
      const userId = emailUser();
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
      importAt(userId, '2026-07-01T12:00:00.000Z');
      expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(1); // Monday
      expect(evaluateStaleImport({ userId, now: new Date('2026-08-19T12:00:00Z'), tz: TZ })).toBe(0); // Wednesday
      expect(evaluateStaleImport({ userId, now: new Date('2026-08-24T12:00:00Z'), tz: TZ })).toBe(1); // next Monday
      expect(keys()).toEqual(['stale:2026-08-17', 'stale:2026-08-24']);
    });
  });

  describe('MUST-14.8: any imports row resets the clock, including a SimpleFIN sync', () => {
    it('a recent import silences the event', () => {
      const userId = emailUser();
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
      importAt(userId, '2026-07-01T12:00:00.000Z');
      importAt(userId, '2026-08-16T12:00:00.000Z');
      expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
    });
  });

  describe('the body', () => {
    it('names the last import date and the days since', () => {
      const userId = emailUser();
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
      importAt(userId, '2026-07-27T12:00:00.000Z');
      evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ });
      const row = t.sqlite.prepare('select subject, body from notification_outbox').get() as {
        subject: string;
        body: string;
      };
      expect(row.subject).toBe('No transactions imported in 3 weeks');
      expect(row.body).toContain('The last import was 2026-07-27 (21 days ago).');
    });
  });
  ```

- [ ] **Run both and confirm they fail.**
  ```powershell
  npx vitest run tests/lib/notify/evaluate/coming-due.test.ts tests/lib/notify/evaluate/stale.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/notify/evaluate/coming-due"`.

- [ ] **Implement `src/lib/notify/evaluate/coming-due.ts`.**
  ```ts
  import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm';
  import { getDb } from '@/db/client';
  import { warrantyItemTypes, warrantyItems } from '@/db/schema';
  import { addDaysIso, todayIso } from '@/lib/dates';
  import { getUserSettings } from '@/lib/notify/config';
  import { comingDueKey } from '@/lib/notify/events';
  import { enqueue } from '@/lib/notify/outbox';
  import { renderEvent } from '@/lib/notify/render';
  import { isItemKind, type ItemKind } from '@/lib/warranty/constants';

  /**
   * MUST-6.13 — the flood guard. A single evaluation creates at most this many new outbox
   * ROWS for one user. Anything over the cap is simply not enqueued; the items are still
   * inside the window tomorrow and are picked up at the next slot. This bounds the first-run
   * backfill when somebody with a large library configures a channel for the first time.
   */
  export const MAX_NEW_ROWS_PER_USER_PER_EVALUATION = 20;

  /**
   * MUST-6.10 — at the user's daily slot: items where is_lifetime = 0, expiry_date IS NOT
   * NULL, and expiry_date BETWEEN todayIso AND addDaysIso(todayIso, coming_due_days).
   *
   * MUST-6.11 — a user is notified about items where owner_user_id is that user.
   * warranty_items.owner_user_id is NOT NULL and defaults to the creator, so every item
   * notifies exactly one person and nothing is orphaned. Broadcasting every member's
   * expiring items to everybody is nagging, not visibility.
   *
   * MUST-6.12 — one outbox row PER ITEM, key `due:<itemId>:<expiryDate>`, so an item is
   * announced once and then never again rather than nagging daily for the whole window.
   */
  export function evaluateComingDue(input: { userId: number; now: Date; tz: string }): number {
    const settings = getUserSettings(input.userId);
    const today = todayIso(input.now, input.tz);
    const horizon = addDaysIso(today, settings.comingDueDays);

    const rows = getDb()
      .select({
        id: warrantyItems.id,
        name: warrantyItems.name,
        vendor: warrantyItems.vendor,
        priceCents: warrantyItems.priceCents,
        expiryDate: warrantyItems.expiryDate,
        kind: warrantyItemTypes.kind,
      })
      .from(warrantyItems)
      .leftJoin(warrantyItemTypes, eq(warrantyItems.typeId, warrantyItemTypes.id))
      .where(
        and(
          eq(warrantyItems.ownerUserId, input.userId),
          eq(warrantyItems.isLifetime, false),
          isNotNull(warrantyItems.expiryDate),
          gte(warrantyItems.expiryDate, today),
          lte(warrantyItems.expiryDate, horizon),
        ),
      )
      .orderBy(asc(warrantyItems.expiryDate), asc(warrantyItems.id))
      .all();

    let enqueued = 0;
    for (const row of rows) {
      if (enqueued >= MAX_NEW_ROWS_PER_USER_PER_EVALUATION) break;
      const expiryDate = row.expiryDate;
      if (expiryDate === null) continue;
      // MUST-6.14: the verb comes from expiryPhraseForKind() through render.ts. An item with
      // no type is 'warranty', matching the app's own unclassified default.
      const kind: ItemKind = row.kind !== null && isItemKind(row.kind) ? row.kind : 'warranty';
      const { subject, body } = renderEvent({
        event: 'coming_due',
        itemName: row.name,
        kind,
        expiryDate,
        todayIso: today,
        vendor: row.vendor,
        priceCents: row.priceCents,
      });
      const result = enqueue({
        userId: input.userId,
        eventId: 'coming_due',
        dedupKey: comingDueKey(row.id, expiryDate),
        subject,
        body,
        at: input.now,
      });
      if (result.inserted.length > 0) enqueued += 1;
    }
    return enqueued;
  }
  ```

- [ ] **Implement `src/lib/notify/evaluate/stale.ts`.**
  ```ts
  import { desc } from 'drizzle-orm';
  import { getDb } from '@/db/client';
  import { imports } from '@/db/schema';
  import { daysBetweenIso, todayIso } from '@/lib/dates';
  import { getUserSettings } from '@/lib/notify/config';
  import { staleImportKey } from '@/lib/notify/events';
  import { mondayOfIsoWeek } from '@/lib/notify/evaluate/slots';
  import { enqueue } from '@/lib/notify/outbox';
  import { renderEvent } from '@/lib/notify/render';

  /**
   * Decision 10 — an install with ZERO imports never fires. A brand-new install must not nag
   * before it has anything to be stale about.
   *
   * MUST-14.8 — SimpleFIN syncs create `imports` rows too, so a household on SimpleFIN is
   * never nagged by this event. The query deliberately looks at every import in the
   * household, not only the ones this user made: staleness is a property of the data, not of
   * who last pressed the button.
   *
   * MUST-3.11 — one message per calendar week while stale, keyed on the Monday of the
   * current week, so the key advances every week and never repeats.
   */
  export function evaluateStaleImport(input: { userId: number; now: Date; tz: string }): number {
    const latest = getDb()
      .select({ createdAt: imports.createdAt })
      .from(imports)
      .orderBy(desc(imports.createdAt))
      .limit(1)
      .get();
    if (!latest) return 0;

    const settings = getUserSettings(input.userId);
    const today = todayIso(input.now, input.tz);
    const lastImportIso = latest.createdAt.slice(0, 10);
    const daysAgo = daysBetweenIso(lastImportIso, today);
    if (daysAgo < settings.staleImportWeeks * 7) return 0;

    const { subject, body } = renderEvent({
      event: 'stale_import',
      weeks: settings.staleImportWeeks,
      lastImportIso,
      daysAgo,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'stale_import',
      dedupKey: staleImportKey(mondayOfIsoWeek(today)),
      subject,
      body,
      at: input.now,
    });
    return result.inserted.length > 0 ? 1 : 0;
  }
  ```

- [ ] **Run both tests and confirm they pass.**
  ```powershell
  npx vitest run tests/lib/notify/evaluate/coming-due.test.ts tests/lib/notify/evaluate/stale.test.ts
  ```
  Expected: green.

- [ ] **Type-check, run the full suite and commit.**
  ```powershell
  npm run typecheck
  npm test
  git add src/lib/notify/evaluate/coming-due.ts src/lib/notify/evaluate/stale.ts tests/lib/notify/evaluate
  git commit -m "feat(notify): coming-due and stale-import evaluators

Owner-scoped window with inclusive boundaries and a 20-row flood cap
(MUST-6.10..6.13); the expiry verb comes from warranty/constants.ts (MUST-6.14);
stale-import is silent on an install with zero imports and fires once a calendar
week thereafter (decision 10, MUST-3.11)."
  ```

<!-- END TASK 9 -->

---

## Task 10: Budget and digest evaluators, and the scheduled-evaluation entry point

**Context:** Spec §6.2, §6.5 and §10.2, plus §17.2's `budget.test.ts` and `digest.test.ts`. Implements **MUST-6.15 … MUST-6.18** and the per-user slot dispatch that Task 11's tick calls.

**Files:**
- Create: `src/lib/notify/evaluate/budget.ts`
- Create: `src/lib/notify/evaluate/digest.ts`
- Create: `src/lib/notify/evaluate/index.ts`
- Test: `tests/lib/notify/evaluate/budget.test.ts`, `tests/lib/notify/evaluate/digest.test.ts`

**Interfaces:**
- Consumes: `budgetProgress(month, scope, userId)` and `type BudgetRow` from `@/lib/budgets`; `categoryBreakdown(...)`, `topMerchants(...)` from `@/lib/reports`; `listReviewQueue(limit?, offset?)` from `@/lib/transactions`; `currentMonth(now?, tz?)`, `monthStart(month)`, `monthEnd(month)`, `addDaysIso`, `todayIso` from `@/lib/dates`; `transactions` from `@/db/schema`; `getUserSettings`, `notifiableUsers`, `isEventEnabled` from `@/lib/notify/config`; `budgetExceededKey`, `budgetThresholdKey`, `weeklyDigestKey` from `@/lib/notify/events`; `enqueue` from `@/lib/notify/outbox`; `renderEvent` from `@/lib/notify/render`; `dailySlot`, `weeklySlot` from `@/lib/notify/evaluate/slots`; `evaluateComingDue` from `@/lib/notify/evaluate/coming-due`; `evaluateStaleImport` from `@/lib/notify/evaluate/stale`; `readEnv()` from `@/lib/env`.
- Produces:
  ```ts
  // src/lib/notify/evaluate/budget.ts
  export function evaluateBudgets(input: { now: Date; tz: string }): number;
  export function resetBudgetFingerprintForTests(): void;

  // src/lib/notify/evaluate/digest.ts
  export function evaluateWeeklyDigest(input: { userId: number; slotDate: string; now: Date }): number;

  // src/lib/notify/evaluate/index.ts
  export function runScheduledEvaluation(now?: Date): void;
  ```

### Steps

- [ ] **Write the failing test `tests/lib/notify/evaluate/budget.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { sql } from 'drizzle-orm';
  import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
  import { upsertBudget } from '@/lib/budgets';
  import { DEFAULT_USER_SETTINGS, saveEmailTarget, saveSmtp, saveUserSettings, setPref } from '@/lib/notify/config';
  import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
  import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
  import { evaluateBudgets, resetBudgetFingerprintForTests } from '@/lib/notify/evaluate/budget';

  let t: TestDb;
  let accountId: number;
  const TZ = 'UTC';
  const NOW = new Date('2026-08-17T12:00:00Z');

  beforeEach(() => {
    t = createSeededTestDb();
    accountId = insertTestAccount(t.db);
    resetOutboxPumpForTests();
    resetBudgetFingerprintForTests();
    setNotifySenderForTests(async () => {});
  });

  afterEach(() => {
    resetNotifySenderForTests();
    resetOutboxPumpForTests();
    resetBudgetFingerprintForTests();
    t.cleanup();
  });

  function emailUser(): number {
    const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
    saveSmtp({
      preset: 'brevo',
      host: 'h',
      port: 587,
      security: 'starttls',
      username: 'u',
      password: 'p',
      fromEmail: 'f@e.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    // budget_threshold is default-off (MUST-4.1); every test here wants it on.
    setPref(userId, 'budget_threshold', 'email', true);
    return userId;
  }

  function spend(categoryId: number, cents: number, attributedUserId: number | null = null, date = '2026-08-05'): void {
    t.db.run(
      sql`insert into transactions
            (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
             attributed_user_id, is_transfer, source, dedup_hash, created_at, updated_at)
          values (${accountId}, ${date}, ${-cents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                  ${attributedUserId}, 0, ${'csv'}, ${`h${Math.random()}`}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})`,
    );
  }

  function keys(): string[] {
    return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
      (r) => r.dedup_key,
    );
  }

  describe('MUST-6.16: the thresholds', () => {
    it('is silent at 79%, fires the threshold at 80%, and fires exceeded past 100%', () => {
      const userId = emailUser();
      const groceries = categoryIdByName(t.db, 'Groceries');
      upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });

      spend(groceries, 39500); // 79%
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);

      resetBudgetFingerprintForTests();
      spend(groceries, 500); // 80%
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
      expect(keys()).toEqual([`budget:h:${groceries}:2026-08:80`]);

      resetBudgetFingerprintForTests();
      spend(groceries, 15000); // 110%
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
      expect(keys()).toContain(`budget:h:${groceries}:2026-08:100`);
    });

    it('MUST-6.17: a single import that jumps from under the threshold to over 100% fires both', () => {
      const userId = emailUser();
      const gas = categoryIdByName(t.db, 'Gas');
      upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
      spend(gas, 20000);
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
      expect(keys().sort()).toEqual([`budget:h:${gas}:2026-08:100`, `budget:h:${gas}:2026-08:80`]);
    });

    it('does not re-fire the same category in the same month', () => {
      const userId = emailUser();
      const gas = categoryIdByName(t.db, 'Gas');
      upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
      spend(gas, 9000);
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
      resetBudgetFingerprintForTests();
      spend(gas, 100);
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    });

    it('raising the threshold mid-month fires again at the new number', () => {
      const userId = emailUser();
      const gas = categoryIdByName(t.db, 'Gas');
      upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
      spend(gas, 9500);
      evaluateBudgets({ now: NOW, tz: TZ });
      expect(keys()).toEqual([`budget:h:${gas}:2026-08:80`]);
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 90 });
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
      expect(keys()).toContain(`budget:h:${gas}:2026-08:90`);
    });

    it('an unbudgeted category never fires', () => {
      emailUser();
      spend(categoryIdByName(t.db, 'Gas'), 999999);
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    });
  });

  describe('MUST-6.15: household and personal scopes are independent facts', () => {
    it('the same category can fire once for each scope', () => {
      const userId = emailUser();
      const coffee = categoryIdByName(t.db, 'Coffee');
      upsertBudget({ scope: 'household', userId: null, categoryId: coffee, month: '2026-08', amountCents: 10000 });
      upsertBudget({ scope: 'personal', userId, categoryId: coffee, month: '2026-08', amountCents: 5000 });
      spend(coffee, 9000, userId);
      evaluateBudgets({ now: NOW, tz: TZ });
      expect(keys().sort()).toEqual(
        [`budget:h:${coffee}:2026-08:100`, `budget:h:${coffee}:2026-08:80`, `budget:p:${coffee}:2026-08:100`, `budget:p:${coffee}:2026-08:80`].sort(),
      );
    });

    it('a personal budget only reaches its own owner', () => {
      const mine = emailUser();
      const theirs = emailUser();
      const coffee = categoryIdByName(t.db, 'Coffee');
      upsertBudget({ scope: 'personal', userId: mine, categoryId: coffee, month: '2026-08', amountCents: 5000 });
      spend(coffee, 9000, mine);
      evaluateBudgets({ now: NOW, tz: TZ });
      const rows = t.sqlite.prepare('select distinct user_id from notification_outbox').all() as { user_id: number }[];
      expect(rows.map((r) => r.user_id)).toEqual([mine]);
      expect(theirs).toBeGreaterThan(0);
    });

    it('a household budget reaches every user with the event enabled', () => {
      const a = emailUser();
      const b = emailUser();
      const gas = categoryIdByName(t.db, 'Gas');
      upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
      spend(gas, 20000);
      evaluateBudgets({ now: NOW, tz: TZ });
      const owners = new Set(
        (t.sqlite.prepare('select user_id from notification_outbox').all() as { user_id: number }[]).map((r) => r.user_id),
      );
      expect([...owners].sort()).toEqual([a, b].sort());
    });
  });

  describe('MUST-6.18: the fingerprint guard', () => {
    it('skips a second tick when nothing has changed', () => {
      const userId = emailUser();
      const gas = categoryIdByName(t.db, 'Gas');
      upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
      spend(gas, 20000);
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
      // Second tick with no data change: no work at all, and nothing new enqueued.
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
      expect(keys()).toHaveLength(2);
    });

    it('does NOT skip after a re-categorisation (max(updated_at) moved)', () => {
      const userId = emailUser();
      const gas = categoryIdByName(t.db, 'Gas');
      const coffee = categoryIdByName(t.db, 'Coffee');
      upsertBudget({ scope: 'household', userId: null, categoryId: coffee, month: '2026-08', amountCents: 10000 });
      spend(gas, 20000);
      evaluateBudgets({ now: NOW, tz: TZ });
      expect(keys()).toEqual([]);
      t.db.run(sql`update transactions set category_id = ${coffee}, updated_at = ${'2026-08-17T11:59:00.000Z'}`);
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    });

    it('does NOT skip after a new user enables the event', () => {
      const a = emailUser();
      const gas = categoryIdByName(t.db, 'Gas');
      upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
      spend(gas, 20000);
      evaluateBudgets({ now: NOW, tz: TZ });
      const b = emailUser();
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
      expect(b).toBeGreaterThan(a);
    });

    it('does NOT skip after a threshold change', () => {
      const userId = emailUser();
      const gas = categoryIdByName(t.db, 'Gas');
      upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
      spend(gas, 8500);
      evaluateBudgets({ now: NOW, tz: TZ });
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 90 });
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0); // 85% is below the new 90
      saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 84 });
      expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    });
  });
  ```

- [ ] **Write the failing test `tests/lib/notify/evaluate/digest.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { sql } from 'drizzle-orm';
  import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
  import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
  import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
  import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
  import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';

  let t: TestDb;
  let accountId: number;
  const NOW = new Date('2026-08-17T12:00:00Z');

  beforeEach(() => {
    t = createSeededTestDb();
    accountId = insertTestAccount(t.db);
    resetOutboxPumpForTests();
    setNotifySenderForTests(async () => {});
  });

  afterEach(() => {
    resetNotifySenderForTests();
    resetOutboxPumpForTests();
    t.cleanup();
  });

  function emailUser(): number {
    const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
    saveSmtp({
      preset: 'brevo',
      host: 'h',
      port: 587,
      security: 'starttls',
      username: 'u',
      password: 'p',
      fromEmail: 'f@e.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    setPref(userId, 'weekly_digest', 'email', true); // default-off (MUST-4.1)
    return userId;
  }

  function spend(categoryId: number, cents: number, date: string, attributedUserId: number | null = null, merchant = 'LOBLAWS'): void {
    t.db.run(
      sql`insert into transactions
            (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
             attributed_user_id, is_transfer, source, dedup_hash, created_at, updated_at)
          values (${accountId}, ${date}, ${-cents}, ${merchant}, ${merchant.toLowerCase()}, ${categoryId},
                  ${attributedUserId}, 0, ${'csv'}, ${`h${Math.random()}`}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})`,
    );
  }

  function body(): string {
    const row = t.sqlite.prepare('select body from notification_outbox').get() as { body: string };
    return row.body;
  }

  describe('§10.2: the window is [slot − 7, slot − 1]', () => {
    it('includes the seven days ending the day before the slot and excludes the slot day itself', () => {
      const userId = emailUser();
      const groceries = categoryIdByName(t.db, 'Groceries');
      spend(groceries, 1000, '2026-08-10'); // in (slot − 7)
      spend(groceries, 2000, '2026-08-16'); // in (slot − 1)
      spend(groceries, 4000, '2026-08-17'); // the slot day — OUT
      spend(groceries, 8000, '2026-08-09'); // before the window — OUT

      expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
      const subject = (t.sqlite.prepare('select subject from notification_outbox').get() as { subject: string }).subject;
      expect(subject).toBe('Weekly summary — 2026-08-10 to 2026-08-16');
      expect(body()).toContain('Household spend: $30.00');
    });

    it('reports the recipient’s own attributed spend separately', () => {
      const userId = emailUser();
      const groceries = categoryIdByName(t.db, 'Groceries');
      spend(groceries, 1000, '2026-08-12', userId);
      spend(groceries, 3000, '2026-08-13', null);
      evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW });
      expect(body()).toContain('Household spend: $40.00');
      expect(body()).toContain('$10.00');
    });

    it('names the top categories and merchants', () => {
      const userId = emailUser();
      spend(categoryIdByName(t.db, 'Groceries'), 40211, '2026-08-12', null, 'LOBLAWS');
      spend(categoryIdByName(t.db, 'Gas'), 12100, '2026-08-13', null, 'PETRO-CANADA');
      evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW });
      expect(body()).toContain('Top categories (household)');
      expect(body()).toContain('Groceries');
      expect(body()).toContain('Top merchants (household)');
      expect(body()).toContain('LOBLAWS');
    });
  });

  describe('§10.2: an empty week still sends', () => {
    it('renders the empty sentence rather than staying silent', () => {
      const userId = emailUser();
      expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
      expect(body()).toContain('No transactions were recorded this week.');
    });
  });

  describe('MUST-3.11: once per weekly slot', () => {
    it('dedupes a second evaluation of the same slot and fires for the next one', () => {
      const userId = emailUser();
      expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
      expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(0);
      expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-24', now: new Date('2026-08-24T12:00:00Z') })).toBe(1);
      const keys = (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
        (r) => r.dedup_key,
      );
      expect(keys).toEqual(['digest:2026-08-17', 'digest:2026-08-24']);
    });
  });
  ```

- [ ] **Run both and confirm they fail.**
  ```powershell
  npx vitest run tests/lib/notify/evaluate/budget.test.ts tests/lib/notify/evaluate/digest.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/notify/evaluate/budget"`.

- [ ] **Implement `src/lib/notify/evaluate/budget.ts`.**
  ```ts
  import { and, gte, lte, sql } from 'drizzle-orm';
  import { getDb } from '@/db/client';
  import { transactions } from '@/db/schema';
  import { budgetProgress, type BudgetRow } from '@/lib/budgets';
  import { currentMonth, monthEnd, monthStart } from '@/lib/dates';
  import { getUserSettings, isEventEnabled, notifiableUsers } from '@/lib/notify/config';
  import { CHANNELS, budgetExceededKey, budgetThresholdKey, type BudgetScopeKey } from '@/lib/notify/events';
  import { enqueue } from '@/lib/notify/outbox';
  import { renderEvent } from '@/lib/notify/render';

  /**
   * MUST-6.18 — the fingerprint guard. Budget events are evaluated on EVERY tick so an
   * afternoon import is reported in minutes rather than tomorrow morning (decision 6); the
   * fingerprint is what keeps that cheap.
   *
   * A restart clears this cache and costs exactly one extra evaluation, which is dedup-safe.
   */
  let lastBudgetKey: string | null = null;

  export function resetBudgetFingerprintForTests(): void {
    lastBudgetKey = null;
  }

  interface Participant {
    userId: number;
    thresholdPct: number;
  }

  /** Flatten budgetProgress()'s parent/child tree — parents and children are independent rows. */
  function flatten(rows: BudgetRow[], acc: BudgetRow[] = []): BudgetRow[] {
    for (const row of rows) {
      acc.push(row);
      if (row.children.length > 0) flatten(row.children, acc);
    }
    return acc;
  }

  function fingerprint(month: string, participants: Participant[]): string {
    // One query, served by the existing transactions(date) index.
    const row = getDb()
      .select({
        n: sql<number>`count(*)`,
        maxId: sql<number>`coalesce(max(${transactions.id}), 0)`,
        maxUpdated: sql<string>`coalesce(max(${transactions.updatedAt}), '')`,
      })
      .from(transactions)
      .where(and(gte(transactions.date, monthStart(month)), lte(transactions.date, monthEnd(month))))
      .get();

    // max(updated_at) is in the fingerprint so that RE-CATEGORISING an existing transaction —
    // which changes neither the count nor the max id — still triggers re-evaluation. The
    // participant/threshold part is in it so a user who has just enabled the event or moved
    // their threshold is evaluated on the very next tick.
    const people = participants
      .slice()
      .sort((a, b) => a.userId - b.userId)
      .map((p) => `${p.userId}:${p.thresholdPct}`)
      .join(',');
    return `${month}|${row?.n ?? 0}|${row?.maxId ?? 0}|${row?.maxUpdated ?? ''}|${people}`;
  }

  function participantsFor(eventId: string): Participant[] {
    const out: Participant[] = [];
    for (const user of notifiableUsers()) {
      if (!CHANNELS.some((channel) => isEventEnabled(user.id, eventId, channel))) continue;
      out.push({ userId: user.id, thresholdPct: getUserSettings(user.id).budgetThresholdPct });
    }
    return out;
  }

  function fireFor(input: {
    userId: number;
    scope: BudgetScopeKey;
    row: BudgetRow;
    month: string;
    thresholdPct: number;
    now: Date;
  }): number {
    const { row, scope, month, userId, thresholdPct, now } = input;
    if (row.limitCents === null || row.pct === null) return 0;

    let fired = 0;

    // MUST-6.16: both use the pct budgetProgress() already computed — including its $0-limit
    // branch — so the notification can never disagree with the progress bar the user is
    // looking at. MUST-6.17: both may fire in the same evaluation.
    if (row.pct >= thresholdPct && row.pct < 100) {
      const { subject, body } = renderEvent({
        event: 'budget_threshold',
        scope,
        categoryName: row.categoryName,
        month,
        pct: row.pct,
        spentCents: row.spentCents,
        limitCents: row.limitCents,
      });
      const result = enqueue({
        userId,
        eventId: 'budget_threshold',
        dedupKey: budgetThresholdKey(scope, row.categoryId, month, thresholdPct),
        subject,
        body,
        at: now,
      });
      if (result.inserted.length > 0) fired += 1;
    }

    if (row.spentCents > row.limitCents) {
      const { subject, body } = renderEvent({
        event: 'budget_exceeded',
        scope,
        categoryName: row.categoryName,
        month,
        spentCents: row.spentCents,
        limitCents: row.limitCents,
      });
      const result = enqueue({
        userId,
        eventId: 'budget_exceeded',
        dedupKey: budgetExceededKey(scope, row.categoryId, month),
        subject,
        body,
        at: now,
      });
      if (result.inserted.length > 0) fired += 1;
    }

    return fired;
  }

  /**
   * MUST-6.15 — evaluated on every tick, for the CURRENT MONTH only, over:
   *   - household scope: budgetProgress(month, 'household', null), delivered to every user
   *     with the event enabled;
   *   - personal scope: budgetProgress(month, 'personal', userId), delivered only to that user.
   * Only rows with a resolved limitCents participate. Parents and children are independent
   * (budgetProgress already applies the rollup rule to the parent's spentCents), so a parent
   * and one of its children may each cross and each gets its own message.
   */
  export function evaluateBudgets(input: { now: Date; tz: string }): number {
    const month = currentMonth(input.now, input.tz);

    // The participant set is the union of both budget events — the threshold value only
    // matters for budget_threshold, but a user who has only budget_exceeded on still has to
    // appear in the fingerprint so enabling it re-evaluates on the next tick.
    const thresholdPeople = participantsFor('budget_threshold');
    const exceededPeople = participantsFor('budget_exceeded');
    const everyone = new Map<number, Participant>();
    for (const person of [...thresholdPeople, ...exceededPeople]) {
      everyone.set(person.userId, person);
    }
    if (everyone.size === 0) {
      lastBudgetKey = null;
      return 0;
    }

    const key = fingerprint(month, [...everyone.values()]);
    if (key === lastBudgetKey) return 0;
    lastBudgetKey = key;

    let fired = 0;
    const householdRows = flatten(budgetProgress(month, 'household', null));

    for (const person of everyone.values()) {
      for (const row of householdRows) {
        fired += fireFor({ userId: person.userId, scope: 'household', row, month, thresholdPct: person.thresholdPct, now: input.now });
      }
      for (const row of flatten(budgetProgress(month, 'personal', person.userId))) {
        fired += fireFor({ userId: person.userId, scope: 'personal', row, month, thresholdPct: person.thresholdPct, now: input.now });
      }
    }

    return fired;
  }
  ```

- [ ] **Implement `src/lib/notify/evaluate/digest.ts`.**
  ```ts
  import { budgetProgress, type BudgetRow } from '@/lib/budgets';
  import { addDaysIso, currentMonth } from '@/lib/dates';
  import { categoryBreakdown, topMerchants } from '@/lib/reports';
  import { listReviewQueue } from '@/lib/transactions';
  import { weeklyDigestKey } from '@/lib/notify/events';
  import { enqueue } from '@/lib/notify/outbox';
  import { renderEvent, type DigestLine } from '@/lib/notify/render';

  const TOP_CATEGORIES = 5;
  const TOP_MERCHANTS = 3;

  function overBudgetNames(rows: BudgetRow[], acc: string[] = []): string[] {
    for (const row of rows) {
      if (row.overBudget) acc.push(row.categoryName);
      if (row.children.length > 0) overBudgetNames(row.children, acc);
    }
    return acc;
  }

  /**
   * §10.2 — the digest covers the 7 days ENDING THE DAY BEFORE the slot date:
   * from = addDaysIso(slotDate, -7), to = addDaysIso(slotDate, -1). A fixed trailing window
   * rather than a fixed Monday–Sunday week, so any chosen digest_weekday yields a complete
   * week with no stale tail (decision 8).
   *
   * Composed from EXISTING helpers only — categoryBreakdown() and topMerchants() in
   * reports.ts, budgetProgress() in budgets.ts, listReviewQueue() in transactions.ts.
   * Transfers and income are excluded by the report helpers themselves.
   *
   * A week with no transactions still sends: silence would be indistinguishable from a
   * broken channel.
   */
  export function evaluateWeeklyDigest(input: { userId: number; slotDate: string; now: Date }): number {
    const from = addDaysIso(input.slotDate, -7);
    const to = addDaysIso(input.slotDate, -1);

    const householdCategories = categoryBreakdown({ from, to });
    const personalCategories = categoryBreakdown({ from, to, attributedUserId: input.userId });

    const sum = (rows: { spentCents: number }[]): number => rows.reduce((total, row) => total + row.spentCents, 0);

    const topCategories: DigestLine[] = householdCategories
      .slice()
      .sort((a, b) => b.spentCents - a.spentCents)
      .slice(0, TOP_CATEGORIES)
      .map((row) => ({ name: row.categoryName, cents: row.spentCents }));

    const topMerchantLines: DigestLine[] = topMerchants({ from, to, limit: TOP_MERCHANTS }).map((row) => ({
      name: row.merchant,
      cents: row.spentCents,
    }));

    const { subject, body } = renderEvent({
      event: 'weekly_digest',
      fromIso: from,
      toIso: to,
      householdSpentCents: sum(householdCategories),
      personalSpentCents: sum(personalCategories),
      topCategories,
      topMerchants: topMerchantLines,
      reviewCount: listReviewQueue(1000).length,
      overBudget: overBudgetNames(budgetProgress(currentMonth(input.now), 'household', null)),
    });

    const result = enqueue({
      userId: input.userId,
      eventId: 'weekly_digest',
      dedupKey: weeklyDigestKey(input.slotDate),
      subject,
      body,
      at: input.now,
    });
    return result.inserted.length > 0 ? 1 : 0;
  }
  ```
  Match `categoryBreakdown`'s and `topMerchants`' real field names against `src/lib/reports.ts` (`CategoryBreakdownRow`, `TopMerchantRow`) when implementing; if a field is named differently there, use the real name and adjust nothing else.

- [ ] **Implement `src/lib/notify/evaluate/index.ts`.**
  ```ts
  import { readEnv } from '@/lib/env';
  import { getUserSettings, notifiableUsers } from '@/lib/notify/config';
  import { evaluateBudgets } from '@/lib/notify/evaluate/budget';
  import { evaluateComingDue } from '@/lib/notify/evaluate/coming-due';
  import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';
  import { evaluateStaleImport } from '@/lib/notify/evaluate/stale';
  import { dailySlot, weeklySlot } from '@/lib/notify/evaluate/slots';

  /**
   * §6.2 — what is evaluated when:
   *   coming_due, stale_import  → the user's DAILY slot
   *   weekly_digest             → the user's WEEKLY slot
   *   budget_threshold/exceeded → EVERY tick, fingerprint-guarded (§6.5)
   *   backup_failed, new_signin, restore_outcome → immediate (§6.6), never here
   *
   * MUST-6.7 — a slot outside its catch-up window is skipped and logs exactly one line.
   * MUST-6.9 — firing a slot twice is harmless: every key contains the slot date or the item
   * id, so a second evaluation inserts nothing.
   *
   * This function never throws into the scheduler: each user's evaluation is wrapped so one
   * bad row cannot stop the rest of the household from being told anything.
   */
  export function runScheduledEvaluation(now: Date = new Date()): void {
    const { tz } = readEnv();

    for (const user of notifiableUsers()) {
      const settings = getUserSettings(user.id);

      try {
        const daily = dailySlot(now, settings.dailyHour, tz);
        if (daily.fires) {
          evaluateComingDue({ userId: user.id, now, tz });
          evaluateStaleImport({ userId: user.id, now, tz });
        } else {
          console.log(`[notify] slot ${daily.slotDate} for user ${user.id} skipped (${daily.hoursSince}h stale)`);
        }
      } catch (error) {
        console.error(`[notify] daily evaluation failed for user ${user.id}`, error);
      }

      try {
        const weekly = weeklySlot(now, settings.digestWeekday, settings.digestHour, tz);
        if (weekly.fires) {
          evaluateWeeklyDigest({ userId: user.id, slotDate: weekly.slotDate, now });
        } else {
          console.log(`[notify] slot ${weekly.slotDate} for user ${user.id} skipped (${weekly.hoursSince}h stale)`);
        }
      } catch (error) {
        console.error(`[notify] weekly evaluation failed for user ${user.id}`, error);
      }
    }

    try {
      evaluateBudgets({ now, tz });
    } catch (error) {
      console.error('[notify] budget evaluation failed', error);
    }
  }
  ```

- [ ] **Run both tests and confirm they pass.**
  ```powershell
  npx vitest run tests/lib/notify/evaluate/budget.test.ts tests/lib/notify/evaluate/digest.test.ts
  ```
  Expected: green.

- [ ] **Type-check, run the full suite and commit.**
  ```powershell
  npm run typecheck
  npm test
  git add src/lib/notify/evaluate tests/lib/notify/evaluate
  git commit -m "feat(notify): budget and digest evaluators plus the slot dispatcher

Budgets evaluated every tick behind the MUST-6.18 fingerprint (count, max id,
max updated_at, participants and their thresholds); household and personal are
independent facts (MUST-6.15) and threshold plus exceeded may both fire
(MUST-6.17); the digest covers [slot-7, slot-1] and still sends for an empty
week (§10.2)."
  ```

<!-- END TASK 10 -->

---

## Task 11: Immediate raisers, the scheduler tick and the three wiring seams

**Context:** Spec §6.1, §6.6 and §14. Implements **MUST-6.1 … MUST-6.4**, **MUST-6.19**, **MUST-14.1 … MUST-14.5**, and §17.4's scheduler, restore-seam and login assertions. After this task the feature is functionally complete on the server side; only the UI and the actions remain.

**Files:**
- Create: `src/lib/notify/raise.ts`
- Modify: `src/lib/scheduler.ts`, `src/instrumentation-node.ts`, `src/lib/auth/login.ts`
- Test: `tests/lib/notify/raise.test.ts`
- Test: `tests/lib/scheduler.test.ts`, `tests/ops/restore-seams.test.ts`, `tests/lib/auth/login.test.ts` (append suites)

**Interfaces:**
- Consumes: `readEnv()` from `@/lib/env`; `readRestoreState()`, `type RestoreOutcome` from `@/lib/backup/restore`; `adminUserIds`, `hasAnyEnabledTarget` from `@/lib/notify/config`; `backupFailedKey`, `newSigninKey`, `restoreOutcomeKey` from `@/lib/notify/events`; `enqueue`, `kickOutbox`, `countPendingOutbox`, `expireStalePending`, `pumpOutbox` from `@/lib/notify/outbox`; `renderEvent` from `@/lib/notify/render`; `runScheduledEvaluation` from `@/lib/notify/evaluate`; `scrubSecrets` from `@/lib/notify/crypto`; `todayIso`, `localHour` from `@/lib/dates`; `users` from `@/db/schema`.
- Produces:
  ```ts
  // src/lib/notify/raise.ts
  export const RESTORE_NOTIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  export function raiseNewSignin(input: { userId: number; at: Date; ip: string; userAgent: string | null; sessionCreatedAt: string }): void;
  export function raiseBackupFailed(input: { error: unknown; at: Date }): void;
  export function raiseRestoreOutcome(now?: Date): void;

  // src/lib/scheduler.ts
  export const NOTIFY_TICK_CRON = '*/5 * * * *';
  export function runNotifyTick(now?: Date): void;   // exported for the test's dormancy assertion
  ```

### Steps

- [ ] **Write the failing test `tests/lib/notify/raise.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
  import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
  import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
  import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
  import { RESTORE_NOTIFY_MAX_AGE_MS, raiseBackupFailed, raiseNewSignin, raiseRestoreOutcome } from '@/lib/notify/raise';

  const readRestoreState = vi.hoisted(() => vi.fn());
  vi.mock('@/lib/backup/restore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/backup/restore')>()),
    readRestoreState,
  }));

  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
    resetOutboxPumpForTests();
    setNotifySenderForTests(async () => {});
    readRestoreState.mockReset().mockReturnValue({ staged: null, result: null });
  });

  afterEach(() => {
    resetNotifySenderForTests();
    resetOutboxPumpForTests();
    t.cleanup();
  });

  function emailUser(role: 'admin' | 'member' = 'admin'): number {
    const userId = insertTestUser(t.db, { role, username: `u${Math.random().toString(36).slice(2, 8)}`, name: 'Sam' });
    saveSmtp({
      preset: 'brevo',
      host: 'h',
      port: 587,
      security: 'starttls',
      username: 'u',
      password: 'p',
      fromEmail: 'f@e.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    return userId;
  }

  function rows(): { user_id: number; event_id: string; dedup_key: string; subject: string; body: string }[] {
    return t.sqlite
      .prepare('select user_id, event_id, dedup_key, subject, body from notification_outbox order by id')
      .all() as never;
  }

  describe('MUST-6.19: raiseNewSignin', () => {
    it('enqueues one row keyed on the session created_at', () => {
      const userId = emailUser();
      raiseNewSignin({
        userId,
        at: new Date('2026-08-17T21:14:00Z'),
        ip: '192.168.1.44',
        userAgent: 'Mozilla/5.0',
        sessionCreatedAt: '2026-08-17T21:14:00.000Z',
      });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]?.dedup_key).toBe('signin:2026-08-17T21:14:00.000Z');
      expect(rows()[0]?.body).toContain('192.168.1.44');
    });

    it('never throws, even when the database is unusable', () => {
      t.sqlite.close();
      expect(() =>
        raiseNewSignin({ userId: 1, at: new Date(), ip: '1.2.3.4', userAgent: null, sessionCreatedAt: 'x' }),
      ).not.toThrow();
    });
  });

  describe('MUST-6.19 / MUST-14.1: raiseBackupFailed', () => {
    it('enqueues one row per active admin, keyed on the calendar day', () => {
      const admin = emailUser('admin');
      const member = emailUser('member');
      raiseBackupFailed({ error: new Error('ENOSPC: no space left'), at: new Date('2026-08-17T02:00:00Z') });
      expect(rows().map((r) => r.user_id)).toEqual([admin]);
      expect(rows()[0]?.dedup_key).toBe('backup-failed:2026-08-17');
      expect(rows()[0]?.body).toContain('ENOSPC: no space left');
      expect(member).toBeGreaterThan(0);
    });

    it('fires at most once per calendar day', () => {
      emailUser('admin');
      raiseBackupFailed({ error: new Error('a'), at: new Date('2026-08-17T02:00:00Z') });
      raiseBackupFailed({ error: new Error('b'), at: new Date('2026-08-17T03:00:00Z') });
      expect(rows()).toHaveLength(1);
    });

    it('never throws', () => {
      t.sqlite.close();
      expect(() => raiseBackupFailed({ error: new Error('x'), at: new Date() })).not.toThrow();
    });
  });

  describe('MUST-14.2: raiseRestoreOutcome', () => {
    const outcome = {
      version: 1,
      status: 'success',
      sourceName: 'budget-2026-08-16.tar.gz',
      kind: 'archive',
      requestedByUserId: 1,
      requestedByUsername: 'manav',
      requestedAt: '2026-08-17T03:00:00.000Z',
      finishedAt: '2026-08-17T03:12:04.000Z',
      safetyCopy: null,
      receiptsMovedAside: null,
      receiptsRestored: 12,
      missingReceiptRows: 1,
      receiptsTouched: 13,
      error: null,
    } as const;

    it('enqueues for every admin when the outcome is fresh', () => {
      const admin = emailUser('admin');
      readRestoreState.mockReturnValue({ staged: null, result: outcome });
      raiseRestoreOutcome(new Date('2026-08-17T04:00:00Z'));
      expect(rows().map((r) => r.user_id)).toEqual([admin]);
      expect(rows()[0]?.dedup_key).toBe('restore:2026-08-17T03:12:04.000Z');
      expect(rows()[0]?.subject).toBe('Restore succeeded');
    });

    it('skips an outcome older than 24 hours — result.json persists across boots', () => {
      emailUser('admin');
      readRestoreState.mockReturnValue({ staged: null, result: outcome });
      raiseRestoreOutcome(new Date(new Date(outcome.finishedAt).getTime() + RESTORE_NOTIFY_MAX_AGE_MS + 1000));
      expect(rows()).toHaveLength(0);
    });

    it('does nothing when there is no result at all', () => {
      emailUser('admin');
      raiseRestoreOutcome(new Date('2026-08-17T04:00:00Z'));
      expect(rows()).toHaveLength(0);
    });

    it('never throws', () => {
      readRestoreState.mockImplementation(() => {
        throw new Error('unreadable');
      });
      expect(() => raiseRestoreOutcome(new Date())).not.toThrow();
    });
  });
  ```

- [ ] **Run it and confirm it fails.**
  ```powershell
  npx vitest run tests/lib/notify/raise.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/notify/raise"`.

- [ ] **Implement `src/lib/notify/raise.ts`.**
  ```ts
  import { eq } from 'drizzle-orm';
  import { getDb } from '@/db/client';
  import { users } from '@/db/schema';
  import { readEnv } from '@/lib/env';
  import { readRestoreState } from '@/lib/backup/restore';
  import { todayIso } from '@/lib/dates';
  import { adminUserIds } from '@/lib/notify/config';
  import { scrubSecrets } from '@/lib/notify/crypto';
  import { backupFailedKey, newSigninKey, restoreOutcomeKey } from '@/lib/notify/events';
  import { enqueue, kickOutbox } from '@/lib/notify/outbox';
  import { renderEvent } from '@/lib/notify/render';

  /**
   * §6.6 — the three immediate raisers.
   *
   * MUST-6.19 — each MUST NEVER THROW into its caller and each is wrapped internally in
   * try/catch: a notification failure may not break a login, a boot, or a backup.
   *
   * MUST-6.2 — each enqueues (a synchronous SQLite insert) and then kicks the sender pump
   * WITHOUT awaiting it, so a sign-in alert leaves the box in seconds rather than waiting up
   * to five minutes for the tick.
   */

  /**
   * MUST-14.2 — result.json persists on disk across boots, so without this guard an
   * outbox row aging out under the 90-day sweep would let a months-old restore re-notify.
   * This is the single case where MUST-3.12's pruning-safety argument needs an explicit
   * guard rather than following from the key's shape.
   */
  export const RESTORE_NOTIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function messageOf(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    return 'The backup job failed without an error message.';
  }

  export function raiseNewSignin(input: {
    userId: number;
    at: Date;
    ip: string;
    userAgent: string | null;
    sessionCreatedAt: string;
  }): void {
    try {
      const { tz } = readEnv();
      const atLabel = `${todayIso(input.at, tz)} ${new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(input.at)}`;

      const { subject, body } = renderEvent({
        event: 'new_signin',
        name: signinName(input.userId),
        atLabel,
        tz,
        ip: input.ip,
        userAgent: input.userAgent,
      });

      const result = enqueue({
        userId: input.userId,
        eventId: 'new_signin',
        dedupKey: newSigninKey(input.sessionCreatedAt),
        subject,
        body,
        at: input.at,
      });
      if (result.inserted.length > 0) kickOutbox(input.at);
    } catch (error) {
      console.error('[notify] new sign-in raise failed', error);
    }
  }

  function signinName(userId: number): string {
    const row = getDb().select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
    return row?.name ?? 'Somebody';
  }

  /**
   * MUST-14.1 — raised from the SCHEDULER's existing catch around runNightlyJob, not from
   * src/lib/backup.ts, so the backup module acquires no notify import and its tests are
   * untouched. Settings → Backups' "run now" deliberately does NOT notify: an admin standing
   * in front of the result page does not need to be emailed about it.
   *
   * MUST-4.3: audience 'admin', so this fans out to active admins only.
   */
  export function raiseBackupFailed(input: { error: unknown; at: Date }): void {
    try {
      const { tz } = readEnv();
      const dateIso = todayIso(input.at, tz);
      // MUST-5.5: a backup error can echo a path or a command line; scrub it anyway.
      const { subject, body } = renderEvent({
        event: 'backup_failed',
        dateIso,
        error: scrubSecrets(messageOf(input.error), []),
      });
      let queued = 0;
      for (const userId of adminUserIds()) {
        queued += enqueue({
          userId,
          eventId: 'backup_failed',
          dedupKey: backupFailedKey(dateIso),
          subject,
          body,
          at: input.at,
        }).inserted.length;
      }
      if (queued > 0) kickOutbox(input.at);
    } catch (error) {
      console.error('[notify] backup failure raise failed', error);
    }
  }

  /**
   * MUST-14.2 — called from src/instrumentation-node.ts, AFTER getDb() (the outcome has to be
   * written into the restored database) and BEFORE startScheduler() (whose immediate boot
   * tick then drains the row).
   */
  export function raiseRestoreOutcome(now: Date = new Date()): void {
    try {
      const outcome = readRestoreState().result;
      if (!outcome) return;

      const finishedMs = Date.parse(outcome.finishedAt);
      if (!Number.isFinite(finishedMs) || now.getTime() - finishedMs > RESTORE_NOTIFY_MAX_AGE_MS) return;

      const { subject, body } = renderEvent({
        event: 'restore_outcome',
        status: outcome.status,
        sourceName: outcome.sourceName,
        requestedByUsername: outcome.requestedByUsername,
        finishedAt: outcome.finishedAt,
        receiptsRestored: outcome.receiptsRestored,
        missingReceiptRows: outcome.missingReceiptRows,
        error: outcome.error,
      });

      let queued = 0;
      for (const userId of adminUserIds()) {
        queued += enqueue({
          userId,
          eventId: 'restore_outcome',
          dedupKey: restoreOutcomeKey(outcome.finishedAt),
          subject,
          body,
          at: now,
        }).inserted.length;
      }
      if (queued > 0) kickOutbox(now);
    } catch (error) {
      console.error('[notify] restore outcome raise failed', error);
    }
  }
  ```
  Note the static `@/db/client` and `@/db/schema` imports: `src/lib/auth/login.ts` already imports `getDb`, so this adds nothing to the login path's module graph, and MUST-2.2 is satisfied because `raise.ts` is never reached from a `*-client.tsx` file (the egress test in Task 15 asserts that).

- [ ] **Add the tick to `src/lib/scheduler.ts`.** Add these imports and exports, register the task beside the other two, stop it in `stopScheduler()`, run it once at boot, and add the raise to the existing nightly `catch`:
  ```ts
  import { raiseBackupFailed } from '@/lib/notify/raise';
  import { runScheduledEvaluation } from '@/lib/notify/evaluate';
  import { countPendingOutbox, expireStalePending, pumpOutbox } from '@/lib/notify/outbox';
  import { hasAnyEnabledTarget } from '@/lib/notify/config';

  /** MUST-6.1: five minutes is the retry and catch-up granularity, not the latency floor. */
  export const NOTIFY_TICK_CRON = '*/5 * * * *';

  let notifyTask: ScheduledTask | null = null;
  /** MUST-6.3: single-flight. A tick arriving while the last one is still running is a no-op. */
  let ticking = false;
  /** MUST-7.8: the 24-hour pending expiry runs on the FIRST tick after boot, once. */
  let bootExpiryDone = false;

  export function runNotifyTick(now: Date = new Date()): void {
    if (ticking) return;
    // MUST-6.4 — the dormancy bail, the FIRST statement in the tick. Two indexed reads
    // against tables that are empty on a dormant install. Nothing below this line executes,
    // so no evaluator runs, no renderer runs, and no transport module is even reached.
    if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;

    ticking = true;
    try {
      if (!bootExpiryDone) {
        bootExpiryDone = true;
        const expired = expireStalePending(now);
        if (expired > 0) console.log(`[notify] expired ${expired} pending row(s) older than 24h`);
      }
      runScheduledEvaluation(now);
    } catch (error) {
      console.error('[notify] tick failed', error);
    } finally {
      ticking = false;
    }
    // The pump owns its own single-flight guard and is deliberately not awaited: a slow
    // relay must not hold the cron callback open into the next tick.
    void pumpOutbox(now).catch((error) => console.error('[notify] pump failed', error));
  }
  ```
  In `startScheduler()`, inside the nightly task's existing `catch (error)` block, immediately after the existing `console.error(...)` line, add:
  ```ts
        // MUST-14.1: the UNATTENDED path notifies. The "run now" action deliberately does not.
        raiseBackupFailed({ error, at: new Date() });
  ```
  Then, beside the OCR registration:
  ```ts
    notifyTask = cron.schedule(NOTIFY_TICK_CRON, () => runNotifyTick(), { timezone: tz });
    console.log(`[scheduler] notification tick registered for ${NOTIFY_TICK_CRON} (${tz})`);
  ```
  and, next to the existing boot-time `runOcrSweep()` call:
  ```ts
    // MUST-6.1: run once immediately at boot, so a container that was off through a slot
    // catches up in seconds rather than in up to five minutes.
    runNotifyTick();
  ```
  In `stopScheduler()`:
  ```ts
    notifyTask?.stop();
    notifyTask = null;
    bootExpiryDone = false;
  ```

- [ ] **Append the scheduler suite to `tests/lib/scheduler.test.ts`.**
  ```ts
  describe('MUST-6.1 / MUST-6.4: the notification tick', () => {
    it('pins the cron expression', () => {
      expect(NOTIFY_TICK_CRON).toBe('*/5 * * * *');
    });

    it('AC4: on a dormant install the tick reaches neither the evaluator nor the sender', async () => {
      const t = createTestDb();
      const sender = vi.fn(async () => {});
      setNotifySenderForTests(sender);
      try {
        for (let i = 0; i < 12; i += 1) runNotifyTick(new Date(Date.now() + i * 5 * 60_000));
        await drainOutboxForTests();
        expect(sender).not.toHaveBeenCalled();
        const { n } = t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
        expect(n).toBe(0);
      } finally {
        resetNotifySenderForTests();
        t.cleanup();
      }
    });

    it('registers and stops the notify task with the others', () => {
      startScheduler();
      expect(isSchedulerRunning()).toBe(true);
      stopScheduler();
      expect(isSchedulerRunning()).toBe(false);
    });

    it('MUST-14.1: a nightly failure raises backup_failed without changing error propagation', () => {
      const raise = vi.spyOn(raiseModule, 'raiseBackupFailed').mockImplementation(() => {
        throw new Error('raise exploded');
      });
      try {
        // runNightlyJob's own contract is unchanged: it still throws its own error, and a
        // throwing raise is swallowed by the scheduler's catch rather than replacing it.
        expect(() => raiseModule.raiseBackupFailed({ error: new Error('x'), at: new Date() })).toThrow('raise exploded');
      } finally {
        raise.mockRestore();
      }
    });
  });
  ```
  Add the needed imports to the file's header: `NOTIFY_TICK_CRON`, `runNotifyTick` from `@/lib/scheduler`; `createTestDb` from `../helpers/db`; `setNotifySenderForTests`, `resetNotifySenderForTests` from `@/lib/notify/send`; `drainOutboxForTests` from `@/lib/notify/outbox`; `* as raiseModule` from `@/lib/notify/raise`.

- [ ] **Add the guarded call to `src/instrumentation-node.ts` (MUST-14.2), placed after `getDb();` and before `startScheduler();`.**
  ```ts
  // MUST-14.2: AFTER getDb() (the outcome has to be written into the restored database) and
  // BEFORE startScheduler() (whose immediate boot tick then drains the row). The guard is
  // mandatory: a notification failure must never stop the app from booting.
  try {
    raiseRestoreOutcome();
  } catch (error) {
    console.error('[notify] restore outcome raise failed', error);
  }
  ```
  with `import { raiseRestoreOutcome } from '@/lib/notify/raise';` added to the import block. MUST-14.3: do not move `applyStagedRestoreOnBoot()` — it stays the file's first statement, and the `'restart'` exit stays before `getDb()`.

- [ ] **Append the ordering assertions to `tests/ops/restore-seams.test.ts`.**
  ```ts
  describe('MUST-14.2 / MUST-14.3: the notification raise sits between getDb and startScheduler', () => {
    const source = read('src/instrumentation-node.ts');

    it('calls raiseRestoreOutcome() after getDb() and before startScheduler()', () => {
      const getDbAt = source.indexOf('getDb();');
      const raiseAt = source.indexOf('raiseRestoreOutcome()');
      const schedulerAt = source.indexOf('startScheduler()');
      expect(getDbAt).toBeGreaterThan(-1);
      expect(raiseAt).toBeGreaterThan(getDbAt);
      expect(schedulerAt).toBeGreaterThan(raiseAt);
    });

    it('wraps it so a notify failure cannot stop the boot', () => {
      expect(source).toMatch(/try\s*\{\s*raiseRestoreOutcome\(\);\s*\}\s*catch/);
    });

    it('leaves applyStagedRestoreOnBoot() as the first statement', () => {
      const firstStatement = source.indexOf('applyStagedRestoreOnBoot()');
      expect(firstStatement).toBeGreaterThan(-1);
      expect(firstStatement).toBeLessThan(source.indexOf('getDb();'));
    });
  });
  ```

- [ ] **Add the guarded raise to `src/lib/auth/login.ts` (MUST-14.4 / MUST-14.5),** immediately after the existing `const session = createSession(user.id, {...});` line in `attemptLogin`, before the `return`:
  ```ts
    // MUST-14.4: fire-and-forget. The enqueue is a synchronous SQLite insert and the pump
    // kick is not awaited. A notification failure must NEVER turn a successful login into an
    // error, so raiseNewSignin is itself internally guarded (MUST-6.19) and wrapped again
    // here. MUST-14.5: this lives in attemptLogin, not in the login server action, so any
    // future authentication path inherits it, and the timing-equalisation reasoning of
    // Ruling (c) stays confined to the failure paths it already governs.
    try {
      raiseNewSignin({
        userId: user.id,
        at,
        ip: input.ip,
        userAgent: input.userAgent ?? null,
        sessionCreatedAt: session.expiresAt,
      });
    } catch (error) {
      console.error('[notify] sign-in raise failed', error);
    }
  ```
  with `import { raiseNewSignin } from '@/lib/notify/raise';` added at the top. **If `createSession` returns the session's `createdAt`,** use that instead of `expiresAt` for `sessionCreatedAt` — MUST-3.11's key is `signin:<session created_at ISO>`. Check `src/lib/auth/session.ts`'s `createSession` return shape first; if it does not expose `createdAt`, add it to the returned object (it is already written to the row) rather than substituting a different timestamp, and update `tests/lib/auth/session.test.ts`'s shape assertion accordingly.

- [ ] **Append the login suite to `tests/lib/auth/login.test.ts`.**
  ```ts
  describe('MUST-14.4: a successful login raises new_signin', () => {
    it('enqueues one row per enabled channel', async () => {
      const userId = await createLoginUser({ username: 'sam', password: 'correct horse battery staple' });
      saveSmtp({
        preset: 'brevo',
        host: 'h',
        port: 587,
        security: 'starttls',
        username: 'u',
        password: 'p',
        fromEmail: 'f@e.com',
        fromName: 'Budget Tracker',
        enabled: true,
      });
      saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
      setNotifySenderForTests(async () => {});

      const result = await attemptLogin({ username: 'sam', password: 'correct horse battery staple', ip: '1.2.3.4' });
      expect(result.status).toBe('ok');
      const rows = sqlite.prepare(`select event_id from notification_outbox`).all() as { event_id: string }[];
      expect(rows.map((r) => r.event_id)).toEqual(['new_signin']);
      resetNotifySenderForTests();
    });

    it('a FAILED login enqueues nothing', async () => {
      const userId = await createLoginUser({ username: 'sam', password: 'correct horse battery staple' });
      saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
      await attemptLogin({ username: 'sam', password: 'wrong', ip: '1.2.3.4' });
      const { n } = sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
      expect(n).toBe(0);
    });

    it('a login with no configured channel writes no row at all', async () => {
      await createLoginUser({ username: 'sam', password: 'correct horse battery staple' });
      const result = await attemptLogin({ username: 'sam', password: 'correct horse battery staple', ip: '1.2.3.4' });
      expect(result.status).toBe('ok');
      const { n } = sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
      expect(n).toBe(0);
    });

    it('a throwing raiseNewSignin still returns { status: "ok" }', async () => {
      await createLoginUser({ username: 'sam', password: 'correct horse battery staple' });
      const raise = vi.spyOn(raiseModule, 'raiseNewSignin').mockImplementation(() => {
        throw new Error('raise exploded');
      });
      const result = await attemptLogin({ username: 'sam', password: 'correct horse battery staple', ip: '1.2.3.4' });
      expect(result.status).toBe('ok');
      raise.mockRestore();
    });
  });
  ```
  Reuse whatever helper the surrounding file already has for creating a user with a password (named `createLoginUser` above); if it is called something else, use the real name. Add the imports for `saveEmailTarget`, `saveSmtp`, `setNotifySenderForTests`, `resetNotifySenderForTests` and `* as raiseModule`.
  Note: because `attemptLogin` calls `raiseNewSignin` directly rather than through the module namespace, `vi.spyOn(raiseModule, ...)` will not intercept it under ESM. If the spy does not take effect, replace that last test with a `vi.mock('@/lib/notify/raise', ...)` factory at the top of a **separate** file `tests/lib/auth/login-notify.test.ts` holding just that assertion, and keep the other three here.

- [ ] **Run every touched test file.**
  ```powershell
  npx vitest run tests/lib/notify/raise.test.ts tests/lib/scheduler.test.ts tests/ops/restore-seams.test.ts tests/lib/auth/login.test.ts
  ```
  Expected: green.

- [ ] **Type-check, build, run the full suite and commit.**
  ```powershell
  npm run typecheck
  npm run build
  npm test
  git add src/lib/notify/raise.ts src/lib/scheduler.ts src/instrumentation-node.ts src/lib/auth/login.ts tests/lib/notify/raise.test.ts tests/lib/scheduler.test.ts tests/ops/restore-seams.test.ts tests/lib/auth/login.test.ts
  git commit -m "feat(notify): immediate raisers, the five-minute tick and the three wiring seams

The tick's first statement is the dormancy bail (MUST-6.4) and it runs once at
boot for catch-up (MUST-6.1); the three raisers never throw into a login, a boot
or a backup (MUST-6.19); the restore raise sits between getDb() and
startScheduler() with applyStagedRestoreOnBoot() still first (MUST-14.2/14.3)."
  ```

<!-- END TASK 11 -->

---

# Phase 4 — Actions and UI

## Task 12: Rate limiting and the nine server actions

**Context:** Spec §12 and §13 in full. Implements **MUST-12.1 … MUST-12.8**, **MUST-13.1 … MUST-13.3**, **MUST-5.6**, **MUST-8.11**, and §17.5's `notifications-actions.test.ts`.

**Files:**
- Create: `src/lib/notify/ratelimit.ts`
- Create: `src/app/(app)/settings/notifications/actions.ts`
- Test: `tests/lib/notify/ratelimit.test.ts`, `tests/app/notifications-actions.test.ts`

**Interfaces:**
- Consumes: `headers()` from `next/headers`; `revalidatePath` from `next/cache`; `isSameOrigin`, `CROSS_ORIGIN_ERROR` from `@/lib/auth/csrf`; `requireUser()`, `requireAdmin()` from `@/lib/auth/session`; `z` from `zod`; everything exported by `@/lib/notify/config`; `deliver`, `NotifyError` from `@/lib/notify/send`; `fetchTelegramChats`, `TELEGRAM_NO_MESSAGES`, `type TelegramChat` from `@/lib/notify/send/telegram`; `scrubSecrets`, `NotifyCredentialError` from `@/lib/notify/crypto`; `CHANNELS`, `NOTIFICATION_EVENTS`, `eventsFor`, `isChannel`, `isNotificationEventId`, `type Channel` from `@/lib/notify/events`.
- Produces:
  ```ts
  // src/lib/notify/ratelimit.ts
  export const TEST_SEND_WINDOW_MS = 10 * 60_000;
  export const TEST_SEND_MAX_PER_USER = 3;
  export const TEST_SEND_MAX_GLOBAL = 10;
  export const DETECT_CHAT_WINDOW_MS = 10 * 60_000;
  export const DETECT_CHAT_MAX_PER_USER = 10;
  export interface RateVerdict { allowed: boolean; retryAfterMinutes: number }
  export function checkTestSend(userId: number, channel: Channel, now?: number): RateVerdict;
  export function checkDetectChat(userId: number, now?: number): RateVerdict;
  export function setNotifyRateLimitClockForTests(clock: (() => number) | null): void;
  export function resetNotifyRateLimitsForTests(): void;

  // src/app/(app)/settings/notifications/actions.ts — 'use server'
  export interface NotificationsState { error?: string; message?: string }
  export interface DetectChatIdState { error?: string; chats?: TelegramChat[] }
  export async function saveSmtpAction(prev: NotificationsState, formData: FormData): Promise<NotificationsState>;
  export async function removeSmtpAction(): Promise<NotificationsState>;
  export async function testSmtpAction(): Promise<NotificationsState>;
  export async function saveTelegramTargetAction(prev: NotificationsState, formData: FormData): Promise<NotificationsState>;
  export async function saveEmailTargetAction(prev: NotificationsState, formData: FormData): Promise<NotificationsState>;
  export async function removeTargetAction(formData: FormData): Promise<NotificationsState>;
  export async function testTargetAction(formData: FormData): Promise<NotificationsState>;
  export async function savePreferencesAction(prev: NotificationsState, formData: FormData): Promise<NotificationsState>;
  export async function detectTelegramChatIdAction(): Promise<DetectChatIdState>;
  ```

### Steps

- [ ] **Write the failing test `tests/lib/notify/ratelimit.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import {
    DETECT_CHAT_MAX_PER_USER,
    DETECT_CHAT_WINDOW_MS,
    TEST_SEND_MAX_GLOBAL,
    TEST_SEND_MAX_PER_USER,
    TEST_SEND_WINDOW_MS,
    checkDetectChat,
    checkTestSend,
    resetNotifyRateLimitsForTests,
    setNotifyRateLimitClockForTests,
  } from '@/lib/notify/ratelimit';

  let clock = 0;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    setNotifyRateLimitClockForTests(() => clock);
    resetNotifyRateLimitsForTests();
  });

  afterEach(() => {
    setNotifyRateLimitClockForTests(null);
    resetNotifyRateLimitsForTests();
  });

  describe('MUST-13.1: the constants', () => {
    it('pins the two windows and three caps', () => {
      expect(TEST_SEND_WINDOW_MS).toBe(600_000);
      expect(TEST_SEND_MAX_PER_USER).toBe(3);
      expect(TEST_SEND_MAX_GLOBAL).toBe(10);
      expect(DETECT_CHAT_WINDOW_MS).toBe(600_000);
      expect(DETECT_CHAT_MAX_PER_USER).toBe(10);
    });
  });

  describe('MUST-13.1: send-test buckets', () => {
    it('refuses the fourth per-user test in a window and recovers after it', () => {
      for (let i = 0; i < 3; i += 1) expect(checkTestSend(1, 'email').allowed).toBe(true);
      const refused = checkTestSend(1, 'email');
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterMinutes).toBeGreaterThan(0);
      clock += TEST_SEND_WINDOW_MS + 1;
      expect(checkTestSend(1, 'email').allowed).toBe(true);
    });

    it('is per (userId, channel)', () => {
      for (let i = 0; i < 3; i += 1) checkTestSend(1, 'email');
      expect(checkTestSend(1, 'email').allowed).toBe(false);
      expect(checkTestSend(1, 'telegram').allowed).toBe(true);
      expect(checkTestSend(2, 'email').allowed).toBe(true);
    });

    it('refuses the eleventh global test across all users and channels', () => {
      let allowed = 0;
      for (let userId = 1; userId <= 10; userId += 1) {
        if (checkTestSend(userId, 'email').allowed) allowed += 1;
      }
      expect(allowed).toBe(TEST_SEND_MAX_GLOBAL);
      expect(checkTestSend(11, 'email').allowed).toBe(false);
      clock += TEST_SEND_WINDOW_MS + 1;
      expect(checkTestSend(11, 'email').allowed).toBe(true);
    });
  });

  describe('MUST-13.1a: the detect bucket is separate and looser', () => {
    it('allows the tenth and refuses the eleventh in a window', () => {
      for (let i = 0; i < DETECT_CHAT_MAX_PER_USER; i += 1) expect(checkDetectChat(1).allowed).toBe(true);
      expect(checkDetectChat(1).allowed).toBe(false);
      clock += DETECT_CHAT_WINDOW_MS + 1;
      expect(checkDetectChat(1).allowed).toBe(true);
    });

    it('has no global cap — each user’s presses hit their own bot', () => {
      for (let userId = 1; userId <= 30; userId += 1) expect(checkDetectChat(userId).allowed).toBe(true);
    });

    it('is independent of the send-test bucket in both directions', () => {
      for (let i = 0; i < 3; i += 1) checkTestSend(1, 'telegram');
      expect(checkTestSend(1, 'telegram').allowed).toBe(false);
      expect(checkDetectChat(1).allowed).toBe(true);

      resetNotifyRateLimitsForTests();
      for (let i = 0; i < DETECT_CHAT_MAX_PER_USER; i += 1) checkDetectChat(2);
      expect(checkDetectChat(2).allowed).toBe(false);
      expect(checkTestSend(2, 'telegram').allowed).toBe(true);
    });
  });
  ```

- [ ] **Run it and confirm it fails, then implement `src/lib/notify/ratelimit.ts`.**
  ```powershell
  npx vitest run tests/lib/notify/ratelimit.test.ts
  ```
  ```ts
  import type { Channel } from '@/lib/notify/events';

  /**
   * MUST-13.1 / MUST-13.1a — in-memory token buckets for the two user-triggered egress
   * buttons.
   *
   * MUST-13.2 — in-memory rather than DB-backed, unlike src/lib/auth/ratelimit.ts. Different
   * threat: the login limiter defends against an unauthenticated attacker who can retry
   * across restarts, while these bound an authenticated household member's misclicks and a
   * stuck form. A restart resetting the bucket is acceptable, and a member cannot restart
   * the container (§19.13).
   */
  export const TEST_SEND_WINDOW_MS = 10 * 60_000;
  export const TEST_SEND_MAX_PER_USER = 3; // per (userId, channel)
  export const TEST_SEND_MAX_GLOBAL = 10; // across all users and channels

  export const DETECT_CHAT_WINDOW_MS = 10 * 60_000;
  export const DETECT_CHAT_MAX_PER_USER = 10; // per userId, and NO global cap

  export interface RateVerdict {
    allowed: boolean;
    retryAfterMinutes: number;
  }

  /** MUST-13.3: the seam, so both windows are testable without real waiting. */
  let clock: () => number = () => Date.now();

  export function setNotifyRateLimitClockForTests(next: (() => number) | null): void {
    clock = next ?? (() => Date.now());
  }

  const testSendByUser = new Map<string, number[]>();
  const testSendGlobal: number[] = [];
  const detectByUser = new Map<number, number[]>();

  export function resetNotifyRateLimitsForTests(): void {
    testSendByUser.clear();
    testSendGlobal.length = 0;
    detectByUser.clear();
  }

  function prune(stamps: number[], now: number, windowMs: number): void {
    while (stamps.length > 0 && (stamps[0] as number) <= now - windowMs) stamps.shift();
  }

  function verdict(stamps: number[], now: number, windowMs: number): RateVerdict {
    const oldest = stamps[0] ?? now;
    const waitMs = Math.max(0, oldest + windowMs - now);
    return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
  }

  /** Consumes a token when it returns allowed; the caller then sends nothing on a refusal. */
  export function checkTestSend(userId: number, channel: Channel, now: number = clock()): RateVerdict {
    const key = `${userId}:${channel}`;
    const perUser = testSendByUser.get(key) ?? [];
    prune(perUser, now, TEST_SEND_WINDOW_MS);
    prune(testSendGlobal, now, TEST_SEND_WINDOW_MS);

    if (perUser.length >= TEST_SEND_MAX_PER_USER) {
      testSendByUser.set(key, perUser);
      return verdict(perUser, now, TEST_SEND_WINDOW_MS);
    }
    // The global cap exists because a household's Brevo free tier and a Telegram bot's
    // per-minute allowance are shared resources one enthusiastic member can exhaust for
    // everyone (MUST-13.1).
    if (testSendGlobal.length >= TEST_SEND_MAX_GLOBAL) {
      testSendByUser.set(key, perUser);
      return verdict(testSendGlobal, now, TEST_SEND_WINDOW_MS);
    }

    perUser.push(now);
    testSendGlobal.push(now);
    testSendByUser.set(key, perUser);
    return { allowed: true, retryAfterMinutes: 0 };
  }

  /**
   * MUST-13.1a — a separate, LOOSER bucket. Detect chat ID is genuinely expected to be
   * pressed several times in a row ("press it, realise you never messaged the bot, message
   * the bot, press it again"), so a cap of three would punish correct use. No global cap:
   * each user's presses hit their own bot, so there is no shared resource to protect.
   */
  export function checkDetectChat(userId: number, now: number = clock()): RateVerdict {
    const stamps = detectByUser.get(userId) ?? [];
    prune(stamps, now, DETECT_CHAT_WINDOW_MS);
    if (stamps.length >= DETECT_CHAT_MAX_PER_USER) {
      detectByUser.set(userId, stamps);
      return verdict(stamps, now, DETECT_CHAT_WINDOW_MS);
    }
    stamps.push(now);
    detectByUser.set(userId, stamps);
    return { allowed: true, retryAfterMinutes: 0 };
  }
  ```

- [ ] **Write the failing test `tests/app/notifications-actions.test.ts`.**
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
  import { getSmtp, getTarget, getUserSettings, saveEmailTarget, saveSmtp, saveTelegramTarget } from '@/lib/notify/config';
  import { resetNotifyRateLimitsForTests } from '@/lib/notify/ratelimit';
  import { resetNotifySenderForTests, setNotifySenderForTests, NotifyError } from '@/lib/notify/send';
  import { resetOutboxPumpForTests } from '@/lib/notify/outbox';

  const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';
  const PASSWORD = 'xsmtpsib-not-a-real-key';

  const headerBag = vi.hoisted(() => ({ value: new Headers({ host: 'budget.local', origin: 'http://budget.local' }) }));
  const currentUser = vi.hoisted(() => ({ value: { id: 0, name: 'Sam', username: 'sam', role: 'admin' as 'admin' | 'member' } }));
  const fetchChats = vi.hoisted(() => vi.fn());

  vi.mock('next/headers', () => ({ headers: async () => headerBag.value }));
  vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
  vi.mock('@/lib/auth/session', () => ({
    requireUser: async () => currentUser.value,
    requireAdmin: async () => {
      if (currentUser.value.role !== 'admin') throw new Error('forbidden');
      return currentUser.value;
    },
  }));
  vi.mock('@/lib/notify/send/telegram', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/notify/send/telegram')>()),
    fetchTelegramChats: fetchChats,
  }));

  const actions = await import('@/app/(app)/settings/notifications/actions');

  let t: TestDb;

  function relay(): void {
    saveSmtp({
      preset: 'brevo',
      host: 'smtp-relay.brevo.com',
      port: 587,
      security: 'starttls',
      username: 'me@example.com',
      password: PASSWORD,
      fromEmail: 'me@example.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
  }

  function form(entries: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.append(key, value);
    return data;
  }

  beforeEach(() => {
    t = createTestDb();
    currentUser.value = { id: insertTestUser(t.db, { role: 'admin', username: 'sam', name: 'Sam' }), name: 'Sam', username: 'sam', role: 'admin' };
    headerBag.value = new Headers({ host: 'budget.local', origin: 'http://budget.local' });
    resetNotifyRateLimitsForTests();
    resetOutboxPumpForTests();
    setNotifySenderForTests(async () => {});
    fetchChats.mockReset();
  });

  afterEach(() => {
    resetNotifySenderForTests();
    resetNotifyRateLimitsForTests();
    resetOutboxPumpForTests();
    t.cleanup();
  });

  describe('MUST-12.1: every mutating action rejects a cross-origin request first', () => {
    it('refuses all nine before touching auth, validation or the database', async () => {
      headerBag.value = new Headers({ host: 'budget.local', origin: 'http://evil.example' });
      const empty = form({});
      const results = [
        await actions.saveSmtpAction({}, empty),
        await actions.removeSmtpAction(),
        await actions.testSmtpAction(),
        await actions.saveTelegramTargetAction({}, empty),
        await actions.saveEmailTargetAction({}, empty),
        await actions.removeTargetAction(empty),
        await actions.testTargetAction(empty),
        await actions.savePreferencesAction({}, empty),
        await actions.detectTelegramChatIdAction(),
      ];
      expect(results).toHaveLength(9);
      for (const result of results) expect(result.error).toBe('Cross-origin request rejected');
      const { n } = t.sqlite.prepare('select count(*) as n from notification_smtp').get() as { n: number };
      expect(n).toBe(0);
    });
  });

  describe('MUST-12.3: the admin gate', () => {
    it('refuses a member on the three SMTP actions and allows them everything else', async () => {
      currentUser.value.role = 'member';
      await expect(actions.saveSmtpAction({}, form({}))).rejects.toThrow();
      await expect(actions.removeSmtpAction()).rejects.toThrow();
      await expect(actions.testSmtpAction()).rejects.toThrow();
      const ok = await actions.saveEmailTargetAction({}, form({ destination: 'sam@example.com', enabled: 'on' }));
      expect(ok.error).toBeUndefined();
    });
  });

  describe('MUST-12.4: no action accepts a userId, and none accepts an outbox row id', () => {
    it('removeTargetAction takes only a channel and derives the user from the session', async () => {
      const other = insertTestUser(t.db, { username: 'other' });
      saveEmailTarget({ userId: other, destination: 'other@example.com', enabled: true });
      saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });

      // Even with a userId field present in the body, the other member's row survives.
      await actions.removeTargetAction(form({ channel: 'email', userId: String(other) }));
      expect(getTarget(currentUser.value.id, 'email')).toBeNull();
      expect(getTarget(other, 'email')?.destination).toBe('other@example.com');
    });

    it('detectTelegramChatIdAction has zero declared parameters', () => {
      expect(actions.detectTelegramChatIdAction.length).toBe(0);
    });
  });

  describe('MUST-12.5 / MUST-5.6: SMTP validation and masking', () => {
    it('creates the relay and never returns the password', async () => {
      const result = await actions.saveSmtpAction(
        {},
        form({
          preset: 'brevo',
          host: 'smtp-relay.brevo.com',
          port: '587',
          security: 'starttls',
          username: 'me@example.com',
          password: PASSWORD,
          fromEmail: 'me@example.com',
          fromName: 'Budget Tracker',
          enabled: 'on',
        }),
      );
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(getSmtp()?.passwordSet).toBe(true);
    });

    it('a blank password on CREATE is a validation error', async () => {
      const result = await actions.saveSmtpAction(
        {},
        form({
          preset: 'custom',
          host: 'mail.local',
          port: '587',
          security: 'starttls',
          username: 'u',
          password: '',
          fromEmail: 'f@e.com',
          fromName: 'Budget Tracker',
          enabled: 'on',
        }),
      );
      expect(result.error).toMatch(/password/i);
      expect(getSmtp()).toBeNull();
    });

    it('a blank password on UPDATE keeps the stored value', async () => {
      relay();
      const result = await actions.saveSmtpAction(
        {},
        form({
          preset: 'brevo',
          host: 'smtp-relay.brevo.com',
          port: '587',
          security: 'starttls',
          username: 'me@example.com',
          password: '',
          fromEmail: 'new@example.com',
          fromName: 'Budget Tracker',
          enabled: 'on',
        }),
      );
      expect(result.error).toBeUndefined();
      expect(getSmtp()?.fromEmail).toBe('new@example.com');
      expect(getSmtp()?.passwordSet).toBe(true);
    });

    it('MUST-8.16: security "none" is refused unless the preset is custom', async () => {
      const base = {
        host: 'mail.local',
        port: '25',
        security: 'none',
        username: 'u',
        password: 'p',
        fromEmail: 'f@e.com',
        fromName: 'Budget Tracker',
        enabled: 'on',
      };
      expect((await actions.saveSmtpAction({}, form({ ...base, preset: 'gmail' }))).error).toMatch(/custom/i);
      expect((await actions.saveSmtpAction({}, form({ ...base, preset: 'custom' }))).error).toBeUndefined();
    });

    it('rejects a host with a scheme, a bad port, and a bad From address', async () => {
      const base = {
        preset: 'custom',
        port: '587',
        security: 'starttls',
        username: 'u',
        password: 'p',
        fromEmail: 'f@e.com',
        fromName: 'Budget Tracker',
        enabled: 'on',
      };
      expect((await actions.saveSmtpAction({}, form({ ...base, host: 'https://mail.local' }))).error).toBeDefined();
      expect((await actions.saveSmtpAction({}, form({ ...base, host: 'mail.local', port: '70000' }))).error).toBeDefined();
      expect((await actions.saveSmtpAction({}, form({ ...base, host: 'mail.local', fromEmail: 'nope' }))).error).toBeDefined();
    });
  });

  describe('MUST-12.5: Telegram validation', () => {
    it('rejects a malformed token and a malformed chat id', async () => {
      expect((await actions.saveTelegramTargetAction({}, form({ destination: '5551234', botToken: 'nope', enabled: 'on' }))).error).toBeDefined();
      expect((await actions.saveTelegramTargetAction({}, form({ destination: 'abc', botToken: TOKEN, enabled: 'on' }))).error).toBeDefined();
      expect((await actions.saveTelegramTargetAction({}, form({ destination: '-1001234567890', botToken: TOKEN, enabled: 'on' }))).error).toBeUndefined();
    });

    it('never returns the token', async () => {
      const result = await actions.saveTelegramTargetAction({}, form({ destination: '5551234', botToken: TOKEN, enabled: 'on' }));
      expect(JSON.stringify(result)).not.toContain('AAHk3f');
    });
  });

  describe('MUST-12.7: Send test bypasses the outbox', () => {
    it('calls the sender directly, writes no outbox row, and sets verified_at', async () => {
      relay();
      saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
      const calls: string[] = [];
      setNotifySenderForTests(async (request) => {
        calls.push(request.channel);
      });
      const result = await actions.testTargetAction(form({ channel: 'email' }));
      expect(result.message).toBeDefined();
      expect(calls).toEqual(['email']);
      const { n } = t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
      expect(n).toBe(0);
      expect(getTarget(currentUser.value.id, 'email')?.verifiedAt).not.toBeNull();
    });

    it('surfaces the transport error and does not verify on failure', async () => {
      relay();
      saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
      setNotifySenderForTests(async () => {
        throw new NotifyError('535 auth failed', { permanent: true, scope: 'relay' });
      });
      const result = await actions.testTargetAction(form({ channel: 'email' }));
      expect(result.error).toContain('535 auth failed');
      expect(getTarget(currentUser.value.id, 'email')?.verifiedAt).toBeNull();
    });

    it('MUST-13.1: the fourth test send in a window is refused and calls no sender', async () => {
      relay();
      saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
      let calls = 0;
      setNotifySenderForTests(async () => {
        calls += 1;
      });
      for (let i = 0; i < 3; i += 1) await actions.testTargetAction(form({ channel: 'email' }));
      const refused = await actions.testTargetAction(form({ channel: 'email' }));
      expect(refused.error).toMatch(/Too many test messages\. Try again in \d+ minutes\./);
      expect(calls).toBe(3);
    });
  });

  describe('MUST-3.7: savePreferencesAction writes only changed toggles', () => {
    it('stores a row only where the value differs from the registry default', async () => {
      const result = await actions.savePreferencesAction(
        {},
        form({
          // coming_due defaults to ON: unchecking it must write a row.
          'pref:weekly_digest:email': 'on', // default OFF -> row
          comingDueDays: '21',
          budgetThresholdPct: '85',
          staleImportWeeks: '2',
          dailyHour: '19',
          digestWeekday: '5',
          digestHour: '7',
        }),
      );
      expect(result.error).toBeUndefined();
      const rows = t.sqlite
        .prepare('select event_id, channel, enabled from notification_prefs order by event_id, channel')
        .all() as { event_id: string; channel: string; enabled: number }[];
      expect(rows).toContainEqual({ event_id: 'weekly_digest', channel: 'email', enabled: 1 });
      expect(rows).toContainEqual({ event_id: 'coming_due', channel: 'email', enabled: 0 });
      // MUST-3.7: a value that MATCHES the registry default writes no row at all.
      // budget_threshold defaults to off and was left unchecked, so it must be absent.
      expect(rows.some((r) => r.event_id === 'budget_threshold')).toBe(false);
      expect(rows.some((r) => r.event_id === 'stale_import')).toBe(false);
      expect(getUserSettings(currentUser.value.id)).toEqual({
        comingDueDays: 21,
        budgetThresholdPct: 85,
        staleImportWeeks: 2,
        dailyHour: 19,
        digestWeekday: 5,
        digestHour: 7,
      });
    });

    it('range-checks every knob in zod as well as in SQL', async () => {
      const base = {
        comingDueDays: '14',
        budgetThresholdPct: '80',
        staleImportWeeks: '3',
        dailyHour: '8',
        digestWeekday: '1',
        digestHour: '8',
      };
      expect((await actions.savePreferencesAction({}, form({ ...base, budgetThresholdPct: '100' }))).error).toBeDefined();
      expect((await actions.savePreferencesAction({}, form({ ...base, comingDueDays: '0' }))).error).toBeDefined();
      expect((await actions.savePreferencesAction({}, form({ ...base, dailyHour: '24' }))).error).toBeDefined();
    });

    it('MUST-4.3: a member cannot enable an admin-only event', async () => {
      currentUser.value.role = 'member';
      await actions.savePreferencesAction(
        {},
        form({
          'pref:backup_failed:email': 'on',
          comingDueDays: '14',
          budgetThresholdPct: '80',
          staleImportWeeks: '3',
          dailyHour: '8',
          digestWeekday: '1',
          digestHour: '8',
        }),
      );
      const rows = t.sqlite.prepare(`select event_id from notification_prefs where event_id = 'backup_failed'`).all();
      expect(rows).toHaveLength(0);
    });
  });

  describe('MUST-8.9 / MUST-8.11 / MUST-12.8: detectTelegramChatIdAction', () => {
    it('refuses with the exact sentence when no token is saved', async () => {
      const result = await actions.detectTelegramChatIdAction();
      expect(result.error).toBe('Save your bot token first.');
      expect(fetchChats).not.toHaveBeenCalled();
    });

    it('returns only the caller’s own bot’s chats', async () => {
      const other = insertTestUser(t.db, { username: 'other' });
      saveTelegramTarget({ userId: other, destination: '1', botToken: '999999999:OTHERtokenxxxxxxxxxxxxxxxxxxxx', enabled: true });
      saveTelegramTarget({ userId: currentUser.value.id, destination: '2', botToken: TOKEN, enabled: true });
      fetchChats.mockResolvedValue([{ chatId: '2', title: 'Sam', kind: 'private', lastMessageAt: null }]);

      const result = await actions.detectTelegramChatIdAction();
      expect(fetchChats).toHaveBeenCalledTimes(1);
      expect(fetchChats.mock.calls[0]?.[0]).toBe(TOKEN);
      expect(result.chats).toEqual([{ chatId: '2', title: 'Sam', kind: 'private', lastMessageAt: null }]);
      expect(JSON.stringify(result)).not.toContain('AAHk3f');
      expect(JSON.stringify(result)).not.toContain('OTHERtoken');
    });

    it('MUST-8.10: an empty list is not an error — the caller renders the empty state', async () => {
      saveTelegramTarget({ userId: currentUser.value.id, destination: '2', botToken: TOKEN, enabled: true });
      fetchChats.mockResolvedValue([]);
      expect(await actions.detectTelegramChatIdAction()).toEqual({ chats: [] });
    });

    it('surfaces the transport’s sentence unchanged, scrubbed of the token', async () => {
      saveTelegramTarget({ userId: currentUser.value.id, destination: '2', botToken: TOKEN, enabled: true });
      fetchChats.mockRejectedValue(new Error(`boom for bot${TOKEN}`));
      const result = await actions.detectTelegramChatIdAction();
      expect(result.error).not.toContain('AAHk3f');
      expect(result.chats).toBeUndefined();
    });

    it('MUST-13.1a: the eleventh call in a window performs no fetch', async () => {
      saveTelegramTarget({ userId: currentUser.value.id, destination: '2', botToken: TOKEN, enabled: true });
      fetchChats.mockResolvedValue([]);
      for (let i = 0; i < 10; i += 1) await actions.detectTelegramChatIdAction();
      const refused = await actions.detectTelegramChatIdAction();
      expect(refused.error).toMatch(/Too many attempts\. Try again in \d+ minutes\./);
      expect(fetchChats).toHaveBeenCalledTimes(10);
    });
  });
  ```

- [ ] **Run it and confirm it fails, then implement `src/app/(app)/settings/notifications/actions.ts`.**
  ```powershell
  npx vitest run tests/app/notifications-actions.test.ts
  ```
  ```ts
  'use server';

  import { headers } from 'next/headers';
  import { revalidatePath } from 'next/cache';
  import { z } from 'zod';
  import { isSameOrigin } from '@/lib/auth/csrf';
  import { requireAdmin, requireUser } from '@/lib/auth/session';
  import {
    SMTP_PRESETS,
    applyPref,
    getSmtp,
    getSmtpPassword,
    getTarget,
    getTelegramToken,
    getUserSettings,
    recordSmtpOutcome,
    recordTargetOutcome,
    removeSmtp,
    removeTarget,
    saveEmailTarget,
    saveSmtp,
    saveTelegramTarget,
    saveUserSettings,
    type SmtpPreset,
  } from '@/lib/notify/config';
  import { NotifyCredentialError, scrubSecrets } from '@/lib/notify/crypto';
  import { CHANNELS, eventsFor, isChannel, type Channel } from '@/lib/notify/events';
  import { checkDetectChat, checkTestSend } from '@/lib/notify/ratelimit';
  import { deliver, NotifyError } from '@/lib/notify/send';
  import { fetchTelegramChats, type TelegramChat } from '@/lib/notify/send/telegram';

  export interface NotificationsState {
    error?: string;
    message?: string;
  }

  export interface DetectChatIdState {
    error?: string;
    chats?: TelegramChat[];
  }

  /**
   * Lives here as a private const, not an export: Next 15 permits ONLY async function
   * exports from a 'use server' file (the same reason src/app/(app)/warranties/actions.ts
   * cannot re-export it).
   */
  const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
  const TOKEN_FIRST = 'Save your bot token first.';
  const PATH = '/settings/notifications';

  /** MUST-12.5: a host, not a URL. No scheme, no whitespace, no path. */
  const hostSchema = z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9.:_-]+$/, 'Server must be a hostname, with no https:// in front of it.');

  const smtpSchema = z
    .object({
      preset: z.enum(['brevo', 'smtp2go', 'gmail', 'custom']),
      host: hostSchema,
      port: z.coerce.number().int().min(1).max(65535),
      security: z.enum(['tls', 'starttls', 'none']),
      username: z.string().min(1).max(254),
      password: z.string().max(512),
      fromEmail: z.string().email().max(254),
      fromName: z.string().min(1).max(64),
      enabled: z.boolean(),
    })
    // MUST-8.16: plaintext is accepted only for a relay on the user's own LAN.
    .refine((value) => value.security !== 'none' || value.preset === 'custom', {
      message: 'Unencrypted SMTP is only available with the Custom SMTP preset.',
      path: ['security'],
    });

  const telegramSchema = z.object({
    destination: z.string().regex(/^-?\d{1,20}$/, 'Chat ID must be a number, optionally starting with a minus sign.'),
    botToken: z
      .string()
      .regex(/^\d{5,15}:[A-Za-z0-9_-]{20,80}$/, 'That does not look like a bot token. Copy the whole line BotFather sent.')
      .or(z.literal('')),
    enabled: z.boolean(),
  });

  const emailTargetSchema = z.object({
    destination: z.string().email().max(254),
    enabled: z.boolean(),
  });

  const knobsSchema = z.object({
    comingDueDays: z.coerce.number().int().min(1).max(365),
    budgetThresholdPct: z.coerce.number().int().min(1).max(99),
    staleImportWeeks: z.coerce.number().int().min(1).max(52),
    dailyHour: z.coerce.number().int().min(0).max(23),
    digestWeekday: z.coerce.number().int().min(0).max(6),
    digestHour: z.coerce.number().int().min(0).max(23),
  });

  function text(formData: FormData, key: string): string {
    const value = formData.get(key);
    return typeof value === 'string' ? value.trim() : '';
  }

  function checkbox(formData: FormData, key: string): boolean {
    return formData.get(key) !== null;
  }

  function firstIssue(error: z.ZodError): string {
    return error.issues[0]?.message ?? 'That input was not valid.';
  }

  async function guard(): Promise<NotificationsState | null> {
    // MUST-12.1: FIRST — before auth, before validation, before any read.
    if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
    return null;
  }

  export async function saveSmtpAction(_prev: NotificationsState, formData: FormData): Promise<NotificationsState> {
    const blocked = await guard();
    if (blocked) return blocked;
    await requireAdmin(); // MUST-12.3

    const parsed = smtpSchema.safeParse({
      preset: text(formData, 'preset'),
      host: text(formData, 'host'),
      port: text(formData, 'port'),
      security: text(formData, 'security'),
      username: text(formData, 'username'),
      password: text(formData, 'password'),
      fromEmail: text(formData, 'fromEmail'),
      fromName: text(formData, 'fromName') || 'Budget Tracker',
      enabled: checkbox(formData, 'enabled'),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };

    // MUST-5.6: blank keeps the stored value on update, and is an error on create.
    const password = parsed.data.password.length > 0 ? parsed.data.password : null;
    if (password === null && getSmtp() === null) return { error: 'A password is required the first time you save the relay.' };

    saveSmtp({ ...parsed.data, password });
    revalidatePath(PATH);
    return { message: 'Outbound email saved. Press Send test email to prove it works.' };
  }

  export async function removeSmtpAction(): Promise<NotificationsState> {
    const blocked = await guard();
    if (blocked) return blocked;
    await requireAdmin();
    removeSmtp();
    revalidatePath(PATH);
    return { message: 'Outbound email removed. Email notifications will not send until it is set up again.' };
  }

  export async function testSmtpAction(): Promise<NotificationsState> {
    const blocked = await guard();
    if (blocked) return blocked;
    const user = await requireAdmin();
    return runTest(user.id, 'email', { relayOnly: true });
  }

  export async function saveTelegramTargetAction(_prev: NotificationsState, formData: FormData): Promise<NotificationsState> {
    const blocked = await guard();
    if (blocked) return blocked;
    const user = await requireUser(); // MUST-12.4: the id comes from the session, never a field.

    const parsed = telegramSchema.safeParse({
      destination: text(formData, 'destination'),
      botToken: text(formData, 'botToken'),
      enabled: checkbox(formData, 'enabled'),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };

    const botToken = parsed.data.botToken.length > 0 ? parsed.data.botToken : null;
    if (botToken === null && getTarget(user.id, 'telegram') === null) {
      return { error: 'A bot token is required the first time you save this channel.' };
    }

    saveTelegramTarget({ userId: user.id, destination: parsed.data.destination, botToken, enabled: parsed.data.enabled });
    revalidatePath(PATH);
    return { message: 'Telegram saved. Press Send test message to prove it works.' };
  }

  export async function saveEmailTargetAction(_prev: NotificationsState, formData: FormData): Promise<NotificationsState> {
    const blocked = await guard();
    if (blocked) return blocked;
    const user = await requireUser();

    const parsed = emailTargetSchema.safeParse({
      destination: text(formData, 'destination'),
      enabled: checkbox(formData, 'enabled'),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };

    saveEmailTarget({ userId: user.id, destination: parsed.data.destination, enabled: parsed.data.enabled });
    revalidatePath(PATH);
    return { message: 'Email address saved. Press Send test email to prove it works.' };
  }

  export async function removeTargetAction(formData: FormData): Promise<NotificationsState> {
    const blocked = await guard();
    if (blocked) return blocked;
    const user = await requireUser();

    const channel = text(formData, 'channel');
    if (!isChannel(channel)) return { error: 'Unknown channel.' };

    removeTarget(user.id, channel);
    revalidatePath(PATH);
    return { message: channel === 'telegram' ? 'Telegram removed.' : 'Email address removed.' };
  }

  export async function testTargetAction(formData: FormData): Promise<NotificationsState> {
    const blocked = await guard();
    if (blocked) return blocked;
    const user = await requireUser();

    const channel = text(formData, 'channel');
    if (!isChannel(channel)) return { error: 'Unknown channel.' };
    return runTest(user.id, channel, { relayOnly: false });
  }

  /**
   * MUST-12.7 — Send test bypasses the outbox: it calls the sender directly and returns the
   * outcome synchronously, because immediate feedback is the entire point of the button. It
   * writes no outbox row, but it DOES update last_error / last_success_at / verified_at.
   */
  async function runTest(userId: number, channel: Channel, opts: { relayOnly: boolean }): Promise<NotificationsState> {
    const verdict = checkTestSend(userId, channel);
    if (!verdict.allowed) {
      return { error: `Too many test messages. Try again in ${verdict.retryAfterMinutes} minutes.` };
    }

    const target = getTarget(userId, channel);
    if (!target) return { error: 'Set this channel up first.' };

    const subject = 'Budget Tracker test message';
    const body = 'This is a test from Budget Tracker. If you can read it, this channel works.';

    try {
      if (channel === 'telegram') {
        await deliver({ channel: 'telegram', destination: target.destination, botToken: getTelegramToken(userId), subject, body });
      } else {
        const relay = getSmtp();
        if (!relay) return { error: 'An admin needs to set up outbound email before this can send.' };
        await deliver({
          channel: 'email',
          destination: target.destination,
          smtp: {
            host: relay.host,
            port: relay.port,
            security: relay.security,
            username: relay.username,
            password: getSmtpPassword(),
            fromEmail: relay.fromEmail,
            fromName: relay.fromName,
          },
          subject,
          body,
        });
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'The test could not be sent.';
      // MUST-5.5: belt and braces — the transports scrub already, a credential-read failure
      // does not go near one, and anything else must not slip through.
      const message = scrubSecrets(raw, []);
      if (error instanceof NotifyError && error.scope === 'relay') recordSmtpOutcome({ ok: false, error: message });
      else recordTargetOutcome({ userId, channel, ok: false, error: message });
      revalidatePath(PATH);
      return { error: message };
    }

    recordTargetOutcome({ userId, channel, ok: true, verify: true });
    if (channel === 'email') recordSmtpOutcome({ ok: true });
    revalidatePath(PATH);
    return {
      message: opts.relayOnly
        ? 'Test email sent through the relay. Check the inbox.'
        : channel === 'telegram'
          ? 'Test message sent. Check Telegram.'
          : 'Test email sent. Check your inbox.',
    };
  }

  export async function savePreferencesAction(_prev: NotificationsState, formData: FormData): Promise<NotificationsState> {
    const blocked = await guard();
    if (blocked) return blocked;
    const user = await requireUser();

    const parsed = knobsSchema.safeParse({
      comingDueDays: text(formData, 'comingDueDays'),
      budgetThresholdPct: text(formData, 'budgetThresholdPct'),
      staleImportWeeks: text(formData, 'staleImportWeeks'),
      dailyHour: text(formData, 'dailyHour'),
      digestWeekday: text(formData, 'digestWeekday'),
      digestHour: text(formData, 'digestHour'),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };

    // MUST-4.3: only the events this role may see are writable, so a forged field for an
    // admin-only event from a member is ignored rather than stored.
    // MUST-3.7: applyPref writes a row only where the value differs from the registry
    // default, and deletes the row when it matches — the table stays sparse.
    for (const event of eventsFor(user.role)) {
      for (const channel of CHANNELS) {
        applyPref(user.id, event.id, channel, checkbox(formData, `pref:${event.id}:${channel}`));
      }
    }
    saveUserSettings(user.id, parsed.data);
    revalidatePath(PATH);
    return { message: 'Saved.' };
  }

  /**
   * MUST-12.8 — the helper's security posture. It takes NO ARGUMENTS AT ALL: not a token,
   * not a user id. It calls isSameOrigin() then requireUser(), loads THAT user's own
   * notification_targets row, decrypts the token server-side, calls fetchTelegramChats(),
   * and returns only TelegramChat[]. There is consequently no parameter through which a
   * member could aim it at another member's bot, and no response field through which a
   * token could escape.
   *
   * It is still MUTATING-SHAPED for CSRF purposes — it causes outbound network egress on the
   * server — so it takes the strict isSameOrigin() check, not isSameOriginOrHeaderless().
   *
   * It mutates nothing and therefore does not revalidate (MUST-12.6).
   */
  export async function detectTelegramChatIdAction(): Promise<DetectChatIdState> {
    if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
    const user = await requireUser();

    // MUST-8.11: the button is disabled in this state anyway, but the action does not rely
    // on the UI for that.
    const target = getTarget(user.id, 'telegram');
    if (!target || !target.secretSet) return { error: TOKEN_FIRST };

    // MUST-13.1a: its own, looser bucket, checked BEFORE any egress.
    const verdict = checkDetectChat(user.id);
    if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

    let botToken: string;
    try {
      botToken = getTelegramToken(user.id);
    } catch (error) {
      if (error instanceof NotifyCredentialError) return { error: error.message };
      throw error;
    }

    try {
      return { chats: await fetchTelegramChats(botToken) };
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Telegram could not be reached.';
      return { error: scrubSecrets(raw, [botToken]) };
    }
  }
  ```

- [ ] **Run both tests and confirm they pass.**
  ```powershell
  npx vitest run tests/lib/notify/ratelimit.test.ts tests/app/notifications-actions.test.ts
  ```
  Expected: green.

- [ ] **Type-check, run the full suite and commit.**
  ```powershell
  npm run typecheck
  npm test
  git add src/lib/notify/ratelimit.ts "src/app/(app)/settings/notifications/actions.ts" tests/lib/notify/ratelimit.test.ts tests/app/notifications-actions.test.ts
  git commit -m "feat(notify): rate limits and the nine server actions

isSameOrigin first on all nine (MUST-12.1), admin gate on the three SMTP actions
(MUST-12.3), and no action anywhere accepts a userId or an outbox row id
(MUST-12.4). Send test bypasses the outbox and reports synchronously (MUST-12.7);
detectTelegramChatIdAction takes zero arguments and reads only the caller's own
encrypted token (MUST-12.8). Two independent in-memory buckets (MUST-13.1/13.1a)."
  ```

<!-- END TASK 12 -->

---

## Task 13: The built-in setup guides

**Context:** Spec §11.7 in full. Implements **MUST-11.5, MUST-11.6, MUST-11.8** and §17.5's `notifications-guides.test.tsx`. **The copy below is shipped verbatim. It is content, not placeholder text** — reproduce it exactly, including the emphasis and the code-formatted literals.

**Files:**
- Create: `src/app/(app)/settings/notifications/guides.tsx`
- Test: `tests/app/notifications-guides.test.tsx`

**Interfaces:**
- Consumes: `type SmtpPreset` from `@/lib/notify/config`.
- Produces:
  ```ts
  // src/app/(app)/settings/notifications/guides.tsx
  export const GUIDE_CLOSING_ACTION: Record<'telegram' | SmtpPreset, string>;  // the exact button label each guide names
  export function TelegramGuide(): React.ReactElement;
  export function EmailGuide({ preset }: { preset: SmtpPreset }): React.ReactElement;
  export function GuidePanel({ open, children }: { open: boolean; children: React.ReactNode }): React.ReactElement;
  ```

### Steps

- [ ] **Write the failing test `tests/app/notifications-guides.test.tsx`.**
  ```tsx
  // @vitest-environment jsdom
  import { describe, it, expect, afterEach } from 'vitest';
  import { render, cleanup } from '@testing-library/react';
  import { EmailGuide, GuidePanel, TelegramGuide } from '@/app/(app)/settings/notifications/guides';
  import type { SmtpPreset } from '@/lib/notify/config';

  afterEach(cleanup);

  const CLOSING_TELEGRAM =
    'Last step: press Send test message. If it arrives in Telegram, you are done. Do not rely on notifications until you have seen a test arrive.';
  const CLOSING_EMAIL =
    'Last step: press Send test email. If it arrives, you are done. Do not rely on notifications until you have seen a test arrive.';

  function textOf(element: HTMLElement): string {
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  describe('MUST-11.6: the Telegram guide is shipped content', () => {
    const { container } = { container: document.createElement('div') };

    it('names BotFather, /newbot, the message-first rule and the Detect chat ID step', () => {
      const { container } = render(<TelegramGuide />);
      const copy = textOf(container);
      expect(copy).toContain('@BotFather');
      expect(copy).toContain('/newbot');
      expect(copy).toContain('A Telegram bot is not allowed to message you until you have messaged it first.');
      expect(copy).toContain('Detect chat ID');
      expect(copy).toContain('123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx');
      expect(copy).toContain('treat it like a password');
    });

    it('MUST-11.8: ends with the closing line naming the exact button label', () => {
      const copy = textOf(render(<TelegramGuide />).container);
      expect(copy).toContain(CLOSING_TELEGRAM);
      expect(copy.endsWith(CLOSING_TELEGRAM)).toBe(true);
    });

    it('renders every external address as text, never as a link', () => {
      const { container } = render(<TelegramGuide />);
      expect(container.querySelectorAll('a')).toHaveLength(0);
    });

    expect(container).toBeDefined();
  });

  describe('MUST-11.6: the four email guides', () => {
    const cases: [SmtpPreset, string[], string][] = [
      ['brevo', ['brevo.com', 'SMTP & API', 'Generate a new SMTP key', 'smtp-relay.brevo.com', '300 emails a day'], CLOSING_EMAIL],
      ['smtp2go', ['smtp2go.com', 'Sending', 'SMTP Users', 'mail.smtp2go.com', '1,000 emails a month'], CLOSING_EMAIL],
      ['gmail', ['myaccount.google.com', '2-Step Verification', 'App passwords', 'smtp.gmail.com', '100 to 150 messages a day'], CLOSING_EMAIL],
      ['custom', ['SMTP settings', 'STARTTLS', '587', '465'], CLOSING_EMAIL],
    ];

    for (const [preset, needles, closing] of cases) {
      it(`${preset} names its provider's own page names, its prefilled host and its quota`, () => {
        const copy = textOf(render(<EmailGuide preset={preset} />).container);
        for (const needle of needles) expect(copy).toContain(needle);
        expect(copy.endsWith(closing)).toBe(true);
      });

      it(`${preset} renders no <a href>`, () => {
        expect(render(<EmailGuide preset={preset} />).container.querySelectorAll('a')).toHaveLength(0);
      });
    }

    it('the Gmail guide states the ordinary Google password will not work', () => {
      const copy = textOf(render(<EmailGuide preset="gmail" />).container);
      expect(copy).toContain('Your normal Google password will not work.');
      expect(copy).toContain('16-character');
    });

    it('the Brevo guide warns the SMTP key is not the account password', () => {
      const copy = textOf(render(<EmailGuide preset="brevo" />).container);
      expect(copy).toContain('The SMTP key is not the same thing as your Brevo account password');
    });

    it('the Custom guide names the three encryption choices and the plaintext warning', () => {
      const copy = textOf(render(<EmailGuide preset="custom" />).container);
      expect(copy).toContain('Only pick this for a mail server on your own home network, never for anything on the internet.');
    });
  });

  describe('MUST-11.5 / MUST-11.7: the panel', () => {
    it('is a <details> whose summary is the shared question', () => {
      const { container } = render(
        <GuidePanel open>
          <p>body</p>
        </GuidePanel>,
      );
      const details = container.querySelector('details');
      expect(details).not.toBeNull();
      expect(details?.open).toBe(true);
      expect(container.querySelector('summary')?.textContent).toBe('How do I set this up?');
    });

    it('renders collapsed when open is false', () => {
      const { container } = render(
        <GuidePanel open={false}>
          <p>body</p>
        </GuidePanel>,
      );
      expect(container.querySelector('details')?.open).toBe(false);
    });
  });
  ```
  The `{ container }` destructure at the top of the first `describe` is scaffolding for the trailing `expect(container).toBeDefined()`; drop both if the implementer prefers — they assert nothing about the product.

- [ ] **Run it and confirm it fails, then implement `src/app/(app)/settings/notifications/guides.tsx`.**
  ```powershell
  npx vitest run tests/app/notifications-guides.test.tsx
  ```
  ```tsx
  import type { SmtpPreset } from '@/lib/notify/config';

  /**
   * MUST-11.5 / MUST-11.6 — the built-in setup guides. This copy is SHIPPED VERBATIM from
   * spec §11.7. It is content, not placeholder text, and it lives in one module so it is
   * reviewable as prose and testable by string match (§17.5, R10).
   *
   * MUST-9.1a / decision 26 — every external address here is PLAIN TEXT, never an <a href>.
   * Nothing in the app resolves, fetches, embeds, previews or link-checks any of them. That
   * keeps the zero-egress claim trivially auditable, survives copy-paste into a screenshot,
   * and removes any question of what a click inside the app might reach.
   *
   * MUST-11.8 — every guide ends with the same closing line, and the phrase "Send test" in
   * it matches the button's label exactly. The test asserts that against the rendered
   * button, not against a duplicated literal.
   */
  export const GUIDE_CLOSING_ACTION: Record<'telegram' | SmtpPreset, string> = {
    telegram: 'Send test message',
    brevo: 'Send test email',
    smtp2go: 'Send test email',
    gmail: 'Send test email',
    custom: 'Send test email',
  };

  function Closing({ action }: { action: string }) {
    return (
      <p className="text-sm text-muted">
        <strong className="font-semibold text-ink">Last step:</strong> press <strong className="font-semibold text-ink">{action}</strong>.{' '}
        {action === 'Send test message'
          ? 'If it arrives in Telegram, you are done.'
          : 'If it arrives, you are done.'}{' '}
        Do not rely on notifications until you have seen a test arrive.
      </p>
    );
  }

  function Heading({ children }: { children: React.ReactNode }) {
    return <p className="text-sm font-semibold text-ink">{children}</p>;
  }

  /** MUST-11.5: a <details> with the shared summary, so every form carries the same shape. */
  export function GuidePanel({ open, children }: { open: boolean; children: React.ReactNode }) {
    return (
      <details open={open} className="rounded-md bg-info-soft px-3.5 py-3 text-sm text-info-soft-fg">
        <summary className="cursor-pointer font-semibold">How do I set this up?</summary>
        <div className="mt-3 flex flex-col gap-3">{children}</div>
      </details>
    );
  }

  export function TelegramGuide() {
    return (
      <>
        <Heading>Getting your bot token</Heading>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>Open Telegram on your phone or computer.</li>
          <li>
            In the search box at the top, type <strong className="font-semibold text-ink">BotFather</strong> and open the account called{' '}
            <strong className="font-semibold text-ink">@BotFather</strong>. It has a blue checkmark.
          </li>
          <li>
            Press <strong className="font-semibold text-ink">Start</strong>, then send the message <code>/newbot</code>.
          </li>
          <li>
            BotFather asks for a name. Type anything you like — for example <code>Home Budget</code>. This is just the name that shows up
            on the messages.
          </li>
          <li>
            BotFather then asks for a username. It has to be unused and it has to end in the word <code>bot</code> — for example{' '}
            <code>grewal_home_budget_bot</code>. If it says the name is taken, try another one.
          </li>
          <li>
            BotFather replies with a message containing your token. It looks like this:{' '}
            <code>123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx</code>
          </li>
          <li>
            Copy that whole line — every character, including the numbers before the colon — and paste it into{' '}
            <strong className="font-semibold text-ink">Bot token</strong> on this page. Then press{' '}
            <strong className="font-semibold text-ink">Save</strong>.
          </li>
        </ol>

        <Heading>Getting your Chat ID</Heading>
        <p className="text-sm text-muted">
          A Telegram bot is not allowed to message you until you have messaged it first. That is a Telegram rule, not something this app
          can skip.
        </p>
        <ol start={8} className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>Back in Telegram, search for the username you chose in step 5 and open the chat with your new bot.</li>
          <li>
            Press <strong className="font-semibold text-ink">Start</strong>, or just send it the word <code>hello</code>. Anything will do.
          </li>
          <li>
            Come back to this page and press <strong className="font-semibold text-ink">Detect chat ID</strong>. The app asks Telegram
            which conversations your bot has received messages in, and lists them here.
          </li>
          <li>
            Pick yourself from the list. If you set the bot up for a family group chat instead, add the bot to that group, send one message
            there, and press <strong className="font-semibold text-ink">Detect chat ID</strong> again — the group will appear in the list
            too.
          </li>
          <li>
            Press <strong className="font-semibold text-ink">Save</strong>.
          </li>
        </ol>
        <p className="text-sm text-muted">
          If the list comes back empty, it almost always means step 9 did not go through. Send your bot another message and press{' '}
          <strong className="font-semibold text-ink">Detect chat ID</strong> again.
        </p>

        <Heading>About the token</Heading>
        <p className="text-sm text-muted">
          Anyone who has your bot token can send messages as your bot, so treat it like a password. It is stored encrypted on this server,
          it is never shown again after you save it, and it never leaves this server.
        </p>

        <Closing action={GUIDE_CLOSING_ACTION.telegram} />
      </>
    );
  }

  function BrevoGuide() {
    return (
      <>
        <p className="text-sm text-muted">
          Brevo sends the email for you. The free plan is enough for a household — around{' '}
          <strong className="font-semibold text-ink">300 emails a day</strong>.
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>
            Go to <strong className="font-semibold text-ink">brevo.com</strong> in your browser and create a free account, or sign in if you
            already have one.
          </li>
          <li>
            Once you are signed in, click your account name in the top-right corner and choose{' '}
            <strong className="font-semibold text-ink">SMTP &amp; API</strong>.
          </li>
          <li>
            Open the <strong className="font-semibold text-ink">SMTP</strong> tab. You will see a server name, a port, and a{' '}
            <strong className="font-semibold text-ink">login</strong> — write the login down, it is usually the email address you signed up
            with.
          </li>
          <li>
            Press <strong className="font-semibold text-ink">Generate a new SMTP key</strong>, give it any name (for example{' '}
            <code>Budget Tracker</code>), and press create.
          </li>
          <li>
            Brevo shows you the key <strong className="font-semibold text-ink">once</strong>. Copy it now — you cannot see it again later,
            though you can always generate another one.
          </li>
          <li>
            Back on this page: <strong className="font-semibold text-ink">Server</strong> and{' '}
            <strong className="font-semibold text-ink">Port</strong> are already filled in for you (<code>smtp-relay.brevo.com</code>, port{' '}
            <code>587</code>, STARTTLS). Leave them alone.
          </li>
          <li>
            Put the <strong className="font-semibold text-ink">login</strong> from step 3 into{' '}
            <strong className="font-semibold text-ink">Username</strong>, and the{' '}
            <strong className="font-semibold text-ink">SMTP key</strong> from step 5 into{' '}
            <strong className="font-semibold text-ink">Password</strong>. The SMTP key is not the same thing as your Brevo account password
            — the account password will not work here.
          </li>
          <li>
            <strong className="font-semibold text-ink">From address</strong> must be an address Brevo has verified as a sender. Your signup
            address already is. If you use a different one, Brevo will refuse to send.
          </li>
          <li>
            Press <strong className="font-semibold text-ink">Save</strong>.
          </li>
        </ol>
        <Closing action={GUIDE_CLOSING_ACTION.brevo} />
      </>
    );
  }

  function Smtp2goGuide() {
    return (
      <>
        <p className="text-sm text-muted">
          SMTP2GO sends the email for you. The free plan allows around{' '}
          <strong className="font-semibold text-ink">1,000 emails a month</strong>, which is far more than a household will use.
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>
            Go to <strong className="font-semibold text-ink">smtp2go.com</strong> in your browser and create a free account, or sign in.
          </li>
          <li>
            In the menu on the left, open <strong className="font-semibold text-ink">Sending</strong>, then{' '}
            <strong className="font-semibold text-ink">SMTP Users</strong>.
          </li>
          <li>
            Press <strong className="font-semibold text-ink">Add SMTP User</strong>. Give it any name, and either let it generate a password
            or set one yourself.
          </li>
          <li>
            Write down the <strong className="font-semibold text-ink">username</strong> and{' '}
            <strong className="font-semibold text-ink">password</strong> it shows you. These are only for sending email — they are not your
            SMTP2GO account login.
          </li>
          <li>
            Back on this page: <strong className="font-semibold text-ink">Server</strong> and{' '}
            <strong className="font-semibold text-ink">Port</strong> are already filled in for you (<code>mail.smtp2go.com</code>, port{' '}
            <code>587</code>, STARTTLS). Leave them alone.
          </li>
          <li>
            Put the username and password from step 4 into <strong className="font-semibold text-ink">Username</strong> and{' '}
            <strong className="font-semibold text-ink">Password</strong>.
          </li>
          <li>
            <strong className="font-semibold text-ink">From address</strong> must use a domain SMTP2GO has verified. If you have not added
            your own domain, use the sender address SMTP2GO gives you on the{' '}
            <strong className="font-semibold text-ink">Verified Senders</strong> page.
          </li>
          <li>
            Press <strong className="font-semibold text-ink">Save</strong>.
          </li>
        </ol>
        <Closing action={GUIDE_CLOSING_ACTION.smtp2go} />
      </>
    );
  }

  function GmailGuide() {
    return (
      <>
        <p className="text-sm text-muted">
          Gmail can send these messages from your own address. It is the fiddliest of the three to set up, and Google limits how much it
          will send — in practice <strong className="font-semibold text-ink">about 100 to 150 messages a day</strong>, which is plenty here.
        </p>
        <p className="text-sm text-muted">
          <strong className="font-semibold text-ink">Your normal Google password will not work.</strong> Google requires a separate
          16-character &ldquo;App password&rdquo; for programs like this one.
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>
            Go to <strong className="font-semibold text-ink">myaccount.google.com</strong> and sign in.
          </li>
          <li>
            Open <strong className="font-semibold text-ink">Security</strong> in the menu on the left.
          </li>
          <li>
            Find <strong className="font-semibold text-ink">2-Step Verification</strong>. If it is off, turn it on and finish the setup —
            Google will not offer App passwords until it is on.
          </li>
          <li>
            Still under <strong className="font-semibold text-ink">Security</strong>, find{' '}
            <strong className="font-semibold text-ink">App passwords</strong>. (If you cannot see it, search &ldquo;App passwords&rdquo; in
            the search box at the top of the page.)
          </li>
          <li>
            Create one. If Google asks what it is for, choose <strong className="font-semibold text-ink">Mail</strong>, and for the device
            choose <strong className="font-semibold text-ink">Other</strong> and type <code>Budget Tracker</code>.
          </li>
          <li>
            Google shows a 16-character password in four blocks, like <code>abcd efgh ijkl mnop</code>. Copy it. You can type it with or
            without the spaces.
          </li>
          <li>
            Back on this page: <strong className="font-semibold text-ink">Server</strong> and{' '}
            <strong className="font-semibold text-ink">Port</strong> are already filled in for you (<code>smtp.gmail.com</code>, port{' '}
            <code>465</code>, TLS). Leave them alone.
          </li>
          <li>
            Put your full Gmail address into <strong className="font-semibold text-ink">Username</strong>, and the 16-character App password
            from step 6 into <strong className="font-semibold text-ink">Password</strong>.
          </li>
          <li>
            Put that same Gmail address into <strong className="font-semibold text-ink">From address</strong>. Gmail rewrites the sender to
            the account you signed in as, so anything else will be replaced anyway.
          </li>
          <li>
            Press <strong className="font-semibold text-ink">Save</strong>.
          </li>
        </ol>
        <Closing action={GUIDE_CLOSING_ACTION.gmail} />
      </>
    );
  }

  function CustomGuide() {
    return (
      <>
        <p className="text-sm text-muted">
          Use this if your email provider is not one of the three above, or if you run your own mail server on your network.
        </p>
        <p className="text-sm text-muted">
          Almost every provider has a help page called <strong className="font-semibold text-ink">&ldquo;SMTP settings&rdquo;</strong> or{' '}
          <strong className="font-semibold text-ink">&ldquo;Sending email using SMTP&rdquo;</strong>. It will list the four things this form
          needs. Search for your provider&rsquo;s name plus &ldquo;SMTP settings&rdquo; and you will find it.
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
          <li>
            <strong className="font-semibold text-ink">Server</strong> — the address of the machine that sends the mail, for example{' '}
            <code>smtp.myprovider.com</code>. Not a web address, and no <code>https://</code> in front of it.
          </li>
          <li>
            <strong className="font-semibold text-ink">Port</strong> — a number. <code>587</code> is the usual one. <code>465</code> is the
            other common one, and goes with the <strong className="font-semibold text-ink">TLS</strong> option below.
          </li>
          <li>
            <strong className="font-semibold text-ink">Encryption</strong> — how the connection is protected.
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                <strong className="font-semibold text-ink">STARTTLS</strong> — the normal choice, almost always with port 587.
              </li>
              <li>
                <strong className="font-semibold text-ink">TLS</strong> — used with port 465.
              </li>
              <li>
                <strong className="font-semibold text-ink">None</strong> — no protection at all. Your username, password and messages travel
                readable across the network. Only pick this for a mail server on your own home network, never for anything on the internet.
              </li>
            </ul>
          </li>
          <li>
            <strong className="font-semibold text-ink">Username</strong> and <strong className="font-semibold text-ink">Password</strong> —
            the sign-in details for sending. Many providers want a separate password for this, not your normal account password; their SMTP
            settings page will say so if they do.
          </li>
          <li>
            <strong className="font-semibold text-ink">From address</strong> — the address the email appears to come from. Most providers
            insist this matches the account you signed in as, and will refuse to send otherwise.
          </li>
        </ul>
        <Closing action={GUIDE_CLOSING_ACTION.custom} />
      </>
    );
  }

  /** MUST-11.7: only the selected preset's guide is ever rendered. */
  export function EmailGuide({ preset }: { preset: SmtpPreset }) {
    switch (preset) {
      case 'brevo':
        return <BrevoGuide />;
      case 'smtp2go':
        return <Smtp2goGuide />;
      case 'gmail':
        return <GmailGuide />;
      case 'custom':
        return <CustomGuide />;
    }
  }
  ```

- [ ] **Run the guide test and confirm it passes.**
  ```powershell
  npx vitest run tests/app/notifications-guides.test.tsx
  ```
  Expected: green. The `textContent`-with-collapsed-whitespace comparison is what makes the JSX markup irrelevant to the assertions; if a sentence fails to match, fix the **JSX** so the rendered prose is byte-for-byte the spec's, not the test.

- [ ] **Type-check, run the full suite and commit.**
  ```powershell
  npm run typecheck
  npm test
  git add "src/app/(app)/settings/notifications/guides.tsx" tests/app/notifications-guides.test.tsx
  git commit -m "feat(notify): the five built-in setup guides, verbatim

Telegram plus one per email preset, in one reviewable module (MUST-11.5/11.6).
Every external address is plain text, never an <a href> (MUST-9.1a, decision 26),
and every guide closes with the shared line naming its Send test button
(MUST-11.8)."
  ```

<!-- END TASK 13 -->

---

## Task 14: The Notifications page

**Context:** Spec §11.1 – §11.6. Implements **MUST-11.1 … MUST-11.4**, **MUST-11.7**, **MUST-5.6** (the UI half), **MUST-5.8** (the one-sentence backup note), and §17.5's `notifications-client.test.tsx`. Existing primitives and design tokens only — no new CSS, no new colour.

**Files:**
- Create: `src/app/(app)/settings/notifications/page.tsx`
- Create: `src/app/(app)/settings/notifications/notifications-client.tsx`
- Modify: `src/components/icons.tsx` (one `BellIcon`)
- Modify: `src/app/(app)/settings/page.tsx` (one personal card)
- Test: `tests/app/notifications-client.test.tsx`
- Test: `tests/app/settings-page-notifications.test.tsx`

**Interfaces:**
- Consumes: `requireUser()` from `@/lib/auth/session`; `getSmtp`, `getPrefs`, `getUserSettings`, `listTargets`, `SMTP_PRESETS`, `type SmtpPreset`, `type SmtpRecord`, `type TargetRecord`, `type UserSettings` from `@/lib/notify/config`; `listRecentDeliveries`, `type DeliveryRow` from `@/lib/notify/outbox`; `NOTIFICATION_EVENTS`, `eventsFor`, `CHANNELS`, `type Channel`, `type NotificationEventDef` from `@/lib/notify/events`; the nine actions and `type NotificationsState` / `type DetectChatIdState` from `./actions`; `TelegramGuide`, `EmailGuide`, `GuidePanel` from `./guides`; `PageHeader`, `Card`, `CardHeader`, `CardBody`, `Notice`, `TableWrap`, `Field`, `inputClass`, `selectClass`, `hintClass` from `@/components/ui/*`; `SubmitButton` from `@/components/SubmitButton`; `BellIcon` from `@/components/icons`; `useActionState`, `useState` from `react`.
- Produces:
  ```ts
  // src/app/(app)/settings/notifications/notifications-client.tsx — 'use client'
  export interface NotificationsPageData {
    role: 'admin' | 'member';
    /** Admins only — a member never receives the relay record (§11.3). */
    smtp: SmtpRecord | null;
    /** Everyone — whether an enabled relay exists, so a member's email card explains itself. */
    relayConfigured: boolean;
    targets: { telegram: TargetRecord | null; email: TargetRecord | null };
    events: readonly NotificationEventDef[];
    prefs: Record<string, boolean>;          // `${eventId}:${channel}` -> effective value
    settings: UserSettings;
    deliveries: (DeliveryRow & { userName: string })[];
    presets: typeof SMTP_PRESETS;
  }
  export function NotificationsClient(props: NotificationsPageData): React.ReactElement;

  // src/components/icons.tsx
  export function BellIcon(props: IconProps): React.ReactElement;
  ```
  **MUST-5.3 restated for this task:** `NotificationsPageData` carries `passwordSet` / `secretSet` booleans and never a credential. A test asserts the serialized props contain neither.

### Steps

- [ ] **Write the failing test `tests/app/notifications-client.test.tsx`.**
  ```tsx
  // @vitest-environment jsdom
  import { describe, it, expect, afterEach, vi } from 'vitest';
  import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
  import { NotificationsClient, type NotificationsPageData } from '@/app/(app)/settings/notifications/notifications-client';
  import { SMTP_PRESETS } from '@/lib/notify/config';
  import { NOTIFICATION_EVENTS, eventsFor } from '@/lib/notify/events';

  const detect = vi.hoisted(() => vi.fn());
  vi.mock('@/app/(app)/settings/notifications/actions', () => ({
    saveSmtpAction: vi.fn(async () => ({})),
    removeSmtpAction: vi.fn(async () => ({})),
    testSmtpAction: vi.fn(async () => ({})),
    saveTelegramTargetAction: vi.fn(async () => ({})),
    saveEmailTargetAction: vi.fn(async () => ({})),
    removeTargetAction: vi.fn(async () => ({})),
    testTargetAction: vi.fn(async () => ({})),
    savePreferencesAction: vi.fn(async () => ({})),
    detectTelegramChatIdAction: detect,
  }));

  afterEach(() => {
    cleanup();
    detect.mockReset();
  });

  const SETTINGS = {
    comingDueDays: 14,
    budgetThresholdPct: 80,
    staleImportWeeks: 3,
    dailyHour: 8,
    digestWeekday: 1,
    digestHour: 8,
  };

  function props(over: Partial<NotificationsPageData> = {}): NotificationsPageData {
    const role = over.role ?? 'admin';
    return {
      role,
      smtp: null,
      relayConfigured: over.smtp != null,
      targets: { telegram: null, email: null },
      events: over.events ?? eventsFor(role),
      prefs: {},
      settings: SETTINGS,
      deliveries: [],
      presets: SMTP_PRESETS,
      ...over,
    };
  }

  function target(over: Partial<NonNullable<NotificationsPageData['targets']['email']>> = {}) {
    return {
      id: 1,
      userId: 1,
      channel: 'email' as const,
      destination: 'sam@example.com',
      secretSet: false,
      enabled: true,
      verifiedAt: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null,
      ...over,
    };
  }

  describe('MUST-11.2: the status banner', () => {
    it('says the app makes no outbound connection when nothing is configured', () => {
      const { container } = render(<NotificationsClient {...props()} />);
      expect(container.textContent).toContain(
        'Notifications are off. This app makes no outbound connection until you configure a channel here.',
      );
    });

    it('surfaces a live last_error, naming the channel', () => {
      const { container } = render(
        <NotificationsClient
          {...props({
            targets: { telegram: null, email: target({ lastError: 'chat not found', lastErrorAt: '2026-08-17T12:00:00.000Z' }) },
          })}
        />,
      );
      expect(container.textContent).toContain('chat not found');
      expect(container.textContent).toMatch(/email/i);
    });
  });

  describe('MUST-11.1 / §11.3: the admin SMTP section', () => {
    it('is absent for a member and present for an admin', () => {
      expect(render(<NotificationsClient {...props({ role: 'member' })} />).container.textContent).not.toContain('Outbound email');
      cleanup();
      expect(render(<NotificationsClient {...props({ role: 'admin' })} />).container.textContent).toContain('Outbound email');
    });

    it('MUST-8.15 / MUST-11.7: changing the preset prefills host/port/security and swaps the guide', () => {
      const { container, getByLabelText } = render(<NotificationsClient {...props()} />);
      const preset = getByLabelText(/preset/i) as HTMLSelectElement;

      fireEvent.change(preset, { target: { value: 'gmail' } });
      expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe('smtp.gmail.com');
      expect((getByLabelText(/^port/i) as HTMLInputElement).value).toBe('465');
      expect((getByLabelText(/encryption/i) as HTMLSelectElement).value).toBe('tls');
      expect(container.textContent).toContain('myaccount.google.com');
      expect(container.textContent).not.toContain('smtp2go.com');

      fireEvent.change(preset, { target: { value: 'smtp2go' } });
      expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe('mail.smtp2go.com');
      expect(container.textContent).toContain('smtp2go.com');
      expect(container.textContent).not.toContain('myaccount.google.com');
    });

    it('MUST-5.6: the password field is empty with the saved placeholder, and offers no reveal', () => {
      const { getByLabelText, container } = render(
        <NotificationsClient
          {...props({
            smtp: {
              preset: 'brevo',
              host: 'smtp-relay.brevo.com',
              port: 587,
              security: 'starttls',
              username: 'me@example.com',
              fromEmail: 'me@example.com',
              fromName: 'Budget Tracker',
              enabled: true,
              passwordSet: true,
              lastError: null,
              lastErrorAt: null,
              lastSuccessAt: '2026-08-17T12:00:00.000Z',
            },
          })}
        />,
      );
      const password = getByLabelText(/^password/i) as HTMLInputElement;
      expect(password.value).toBe('');
      expect(password.placeholder).toBe('•••••••• (saved)');
      expect(password.type).toBe('password');
      expect(container.textContent).not.toMatch(/reveal|show password/i);
    });

    it('a member whose email channel has no relay sees the explanation instead of the buttons', () => {
      const { container, queryByText } = render(
        <NotificationsClient {...props({ role: 'member', smtp: null, targets: { telegram: null, email: target() } })} />,
      );
      expect(container.textContent).toContain('An admin needs to set up outbound email before this can send.');
      expect(queryByText('Send test email')).toBeNull();
    });
  });

  describe('MUST-11.3: the matrix is generated from the registry', () => {
    it('renders one row per event with a Telegram and an Email checkbox', () => {
      const { container } = render(<NotificationsClient {...props()} />);
      for (const event of NOTIFICATION_EVENTS) {
        expect(container.textContent).toContain(event.label);
        expect(container.querySelector(`input[name="pref:${event.id}:telegram"]`)).not.toBeNull();
        expect(container.querySelector(`input[name="pref:${event.id}:email"]`)).not.toBeNull();
      }
    });

    it('MUST-4.4: an injected registry entry the component has never heard of renders a row', () => {
      const future = {
        id: 'on_pace_overshoot',
        label: 'On pace to overshoot',
        blurb: 'Spending is tracking above the month’s limit.',
        audience: 'all',
        trigger: 'tick',
        defaultEnabled: false,
      } as const;
      const { container } = render(<NotificationsClient {...props({ events: [...eventsFor('admin'), future] })} />);
      expect(container.textContent).toContain('On pace to overshoot');
      expect(container.querySelector('input[name="pref:on_pace_overshoot:email"]')).not.toBeNull();
    });

    it('MUST-4.3: admin-only rows are absent for a member', () => {
      const { container } = render(<NotificationsClient {...props({ role: 'member' })} />);
      expect(container.textContent).not.toContain('The nightly backup failed');
      expect(container.textContent).not.toContain('A restore finished');
    });

    it('a column for an unconfigured channel is disabled and explains why', () => {
      const { container } = render(<NotificationsClient {...props({ targets: { telegram: null, email: target() } })} />);
      const telegram = container.querySelector('input[name="pref:coming_due:telegram"]') as HTMLInputElement;
      const email = container.querySelector('input[name="pref:coming_due:email"]') as HTMLInputElement;
      expect(telegram.disabled).toBe(true);
      expect(telegram.title).toBe('Set up this channel first.');
      expect(email.disabled).toBe(false);
    });

    it('reflects the effective value, not the raw stored one', () => {
      const { container } = render(
        <NotificationsClient
          {...props({
            targets: { telegram: null, email: target() },
            prefs: { 'coming_due:email': false, 'weekly_digest:email': true },
          })}
        />,
      );
      expect((container.querySelector('input[name="pref:coming_due:email"]') as HTMLInputElement).defaultChecked).toBe(false);
      expect((container.querySelector('input[name="pref:weekly_digest:email"]') as HTMLInputElement).defaultChecked).toBe(true);
      expect((container.querySelector('input[name="pref:budget_exceeded:email"]') as HTMLInputElement).defaultChecked).toBe(true);
    });

    it('MUST-11.4: the always-visible sentence about what the messages contain', () => {
      const { container } = render(<NotificationsClient {...props()} />);
      expect(container.textContent).toContain(
        'Messages contain amounts, category names and merchant names, and are delivered by Telegram or by your email provider.',
      );
    });

    it('MUST-5.8: the page says these credentials are inside the unencrypted backup', () => {
      const { container } = render(<NotificationsClient {...props()} />);
      expect(container.textContent).toMatch(/backup/i);
    });

    it('renders the five knobs with their defaults in the hint text', () => {
      const { container, getByLabelText } = render(<NotificationsClient {...props()} />);
      for (const name of ['comingDueDays', 'budgetThresholdPct', 'staleImportWeeks', 'dailyHour', 'digestWeekday', 'digestHour']) {
        expect(container.querySelector(`[name="${name}"]`)).not.toBeNull();
      }
      expect((getByLabelText(/days before/i) as HTMLInputElement).defaultValue).toBe('14');
    });
  });

  describe('MUST-11.2: Detect chat ID', () => {
    it('MUST-8.11: is disabled with its hint before a token is saved', () => {
      const { getByText, container } = render(<NotificationsClient {...props()} />);
      const button = getByText('Detect chat ID') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain('Save your bot token first');
    });

    it('renders a radio per chat and fills the Chat ID field on selection without saving', async () => {
      detect.mockResolvedValue({
        chats: [
          { chatId: '5551234', title: 'Sam Grewal', kind: 'private', lastMessageAt: '2026-08-17T12:00:00.000Z' },
          { chatId: '-1001234567890', title: 'Grewal Family', kind: 'group', lastMessageAt: '2026-08-16T12:00:00.000Z' },
        ],
      });
      const { getByText, container, getByLabelText } = render(
        <NotificationsClient
          {...props({ targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null } })}
        />,
      );
      fireEvent.click(getByText('Detect chat ID'));
      await waitFor(() => expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2));
      expect(container.textContent).toContain('Grewal Family');
      expect(container.textContent).toContain('-1001234567890');

      fireEvent.click(container.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement);
      expect((getByLabelText(/chat id/i) as HTMLInputElement).value).toBe('-1001234567890');
      // Nothing is saved until Save is pressed.
      const actions = await import('@/app/(app)/settings/notifications/actions');
      expect(actions.saveTelegramTargetAction).not.toHaveBeenCalled();
    });

    it('MUST-8.10: renders the exact empty-state and error sentences', async () => {
      const withToken = props({
        targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null },
      });

      detect.mockResolvedValue({ chats: [] });
      const first = render(<NotificationsClient {...withToken} />);
      fireEvent.click(first.getByText('Detect chat ID'));
      await waitFor(() =>
        expect(first.container.textContent).toContain(
          'No messages yet. Open Telegram, find your bot, send it any message, then press this again.',
        ),
      );
      cleanup();

      detect.mockResolvedValue({
        error: 'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.',
      });
      const second = render(<NotificationsClient {...withToken} />);
      fireEvent.click(second.getByText('Detect chat ID'));
      await waitFor(() =>
        expect(second.container.textContent).toContain(
          'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.',
        ),
      );
    });
  });

  describe('MUST-11.8: the guide closing line matches the rendered button label', () => {
    it('asserts against the button, not a duplicated literal', () => {
      const { getByText, container } = render(
        <NotificationsClient
          {...props({ targets: { telegram: target({ channel: 'telegram', destination: '1', secretSet: true }), email: null } })}
        />,
      );
      const label = (getByText('Send test message') as HTMLButtonElement).textContent ?? '';
      expect(container.textContent).toContain(`press ${label}`);
    });
  });

  describe('§11.4: the unverified badge', () => {
    it('shows until verified_at is set', () => {
      const unverified = render(<NotificationsClient {...props({ targets: { telegram: null, email: target() } })} />);
      expect(unverified.container.textContent).toContain('Unverified');
      cleanup();
      const verified = render(
        <NotificationsClient {...props({ targets: { telegram: null, email: target({ verifiedAt: '2026-08-17T12:00:00.000Z' }) } })} />,
      );
      expect(verified.container.textContent).not.toContain('Unverified');
    });
  });

  describe('§11.6: recent deliveries', () => {
    it('lists when, event, channel, status and the scrubbed error, with no retry button', () => {
      const { container, queryByText } = render(
        <NotificationsClient
          {...props({
            deliveries: [
              {
                id: 3,
                userId: 1,
                userName: 'Sam',
                channel: 'email',
                eventId: 'coming_due',
                subject: 'Coming due: Dishwasher',
                status: 'failed',
                attempts: 8,
                lastError: '550 mailbox unavailable',
                createdAt: '2026-08-17T12:00:00.000Z',
                sentAt: null,
              },
            ],
          })}
        />,
      );
      expect(container.textContent).toContain('Something is coming due');
      expect(container.textContent).toContain('550 mailbox unavailable');
      expect(queryByText(/retry/i)).toBeNull();
    });
  });

  describe('MUST-5.3: no credential ever reaches these props', () => {
    it('the serialized props contain no password and no token field', () => {
      const serialized = JSON.stringify(props({ targets: { telegram: target({ channel: 'telegram', secretSet: true }), email: target() } }));
      expect(serialized).not.toMatch(/"password"/);
      expect(serialized).not.toMatch(/"botToken"/);
      expect(serialized).not.toMatch(/"secretEncrypted"/);
      expect(serialized).toContain('"secretSet":true');
    });
  });
  ```

- [ ] **Write the failing test `tests/app/settings-page-notifications.test.tsx`.**
  ```tsx
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const settingsPage = fs.readFileSync(path.join(root, 'src/app/(app)/settings/page.tsx'), 'utf8');

  describe('MUST-11.1: the Settings entry point', () => {
    it('links to /settings/notifications with the specified blurb', () => {
      expect(settingsPage).toContain('/settings/notifications');
      expect(settingsPage).toContain('where the app messages you, and about what');
    });

    it('is a PERSONAL card, not an ADMIN_LINKS entry — every member configures their own', () => {
      const adminBlock = settingsPage.slice(settingsPage.indexOf('ADMIN_LINKS'), settingsPage.indexOf('export default'));
      expect(adminBlock).not.toContain('/settings/notifications');
    });

    it('uses the new BellIcon', () => {
      expect(settingsPage).toContain('BellIcon');
      expect(fs.readFileSync(path.join(root, 'src/components/icons.tsx'), 'utf8')).toContain('export function BellIcon');
    });

    it('MUST-9.4 precursor: the notifications directory contains no fetch call', () => {
      const dir = path.join(root, 'src/app/(app)/settings/notifications');
      for (const entry of fs.readdirSync(dir)) {
        if (!/\.tsx?$/.test(entry)) continue;
        expect(fs.readFileSync(path.join(dir, entry), 'utf8')).not.toMatch(/\bfetch\s*\(/);
      }
    });
  });
  ```

- [ ] **Run both and confirm they fail.**
  ```powershell
  npx vitest run tests/app/notifications-client.test.tsx tests/app/settings-page-notifications.test.tsx
  ```
  Expected failure: `Failed to resolve import "@/app/(app)/settings/notifications/notifications-client"`.

- [ ] **Add `BellIcon` to `src/components/icons.tsx`,** following the shape of the existing icons in that file (same `IconProps`, same `viewBox`, same `stroke="currentColor"` conventions):
  ```tsx
  export function BellIcon(props: IconProps) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
        <path d="M13.7 20a2 2 0 0 1-3.4 0" />
      </svg>
    );
  }
  ```
  Match the exact prop-spreading and default-className pattern the neighbouring icons use; do not introduce a new one.

- [ ] **Add the personal card to `src/app/(app)/settings/page.tsx` (MUST-11.1),** between the existing Sessions card and the `{user.role === 'admin' ? (` admin grid, and add `BellIcon` to the `@/components/icons` import list:
  ```tsx
        <Card>
          <CardHeader title="Notifications" description="Where the app messages you, and about what." />
          <CardBody>
            <Link
              href="/settings/notifications"
              className="group flex items-start gap-3 rounded-md p-1 transition-colors hover:text-accent-text"
            >
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-fg"
              >
                <BellIcon className="h-[1.15rem] w-[1.15rem]" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-semibold text-ink">Notifications</span>
                <span className="text-sm text-muted">Telegram and email alerts. Nothing is sent until you set a channel up.</span>
              </span>
              <ArrowRightIcon className="mt-1 h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
            </Link>
          </CardBody>
        </Card>
  ```

- [ ] **Implement `src/app/(app)/settings/notifications/page.tsx` — the server component.**
  ```tsx
  import { requireUser } from '@/lib/auth/session';
  import { getDb } from '@/db/client';
  import { users } from '@/db/schema';
  import { PageHeader } from '@/components/ui/PageHeader';
  import { SMTP_PRESETS, getPrefs, getSmtp, getTarget, getUserSettings } from '@/lib/notify/config';
  import { eventsFor, NOTIFICATION_EVENTS } from '@/lib/notify/events';
  import { listRecentDeliveries } from '@/lib/notify/outbox';
  import { NotificationsClient, type NotificationsPageData } from './notifications-client';

  export const dynamic = 'force-dynamic';

  export default async function NotificationsPage() {
    const user = await requireUser();

    // MUST-3.7: the page renders EFFECTIVE values, resolved once here so the client never
    // re-implements the fallback rule.
    const stored = getPrefs(user.id);
    const prefs: Record<string, boolean> = {};
    for (const event of eventsFor(user.role)) {
      for (const channel of ['telegram', 'email'] as const) {
        prefs[`${event.id}:${channel}`] = stored[`${event.id}:${channel}`] ?? event.defaultEnabled;
      }
    }

    // §11.6: admins get the household-wide view with a name column.
    const nameById = new Map(
      getDb()
        .select({ id: users.id, name: users.name })
        .from(users)
        .all()
        .map((row) => [row.id, row.name] as const),
    );
    const deliveries = listRecentDeliveries({ userId: user.role === 'admin' ? null : user.id }).map((row) => ({
      ...row,
      userName: nameById.get(row.userId) ?? 'Unknown',
    }));

    const relay = getSmtp();

    const data: NotificationsPageData = {
      role: user.role,
      // MUST-5.3: getSmtp() returns passwordSet, never the password; getTarget() returns
      // secretSet, never the token. §11.3: members see none of the relay's configuration,
      // only whether one exists, so their email card can explain itself.
      smtp: user.role === 'admin' ? relay : null,
      relayConfigured: relay?.enabled === true,
      targets: { telegram: getTarget(user.id, 'telegram'), email: getTarget(user.id, 'email') },
      events: eventsFor(user.role),
      prefs,
      settings: getUserSettings(user.id),
      deliveries,
      presets: SMTP_PRESETS,
    };

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Notifications" description="Nothing is sent anywhere until you set up a channel below." />
        <NotificationsClient {...data} />
        {/* NOTIFICATION_EVENTS is imported so a future contributor sees the registry is the
            single source of the matrix; eventsFor() above is the filtered view. */}
        <span className="hidden">{NOTIFICATION_EVENTS.length}</span>
      </div>
    );
  }
  ```
  Delete the hidden `<span>` and the `NOTIFICATION_EVENTS` import if the reviewer objects — it documents intent but renders nothing.

- [ ] **Implement `src/app/(app)/settings/notifications/notifications-client.tsx`.** The full component is long; these are its binding shapes and the pieces the tests pin. Build it out of the existing primitives only.
  ```tsx
  'use client';

  import { useActionState, useState } from 'react';
  import { Card, CardBody, CardHeader } from '@/components/ui/Card';
  import { Notice } from '@/components/ui/Notice';
  import { TableWrap } from '@/components/ui/Table';
  import { Field, hintClass, inputClass, selectClass } from '@/components/ui/form';
  import { SubmitButton } from '@/components/SubmitButton';
  import type { SmtpPreset, SmtpRecord, TargetRecord, UserSettings } from '@/lib/notify/config';
  import type { SMTP_PRESETS } from '@/lib/notify/config';
  import type { NotificationEventDef } from '@/lib/notify/events';
  import type { DeliveryRow } from '@/lib/notify/outbox';
  import { eventDef } from '@/lib/notify/events';
  import {
    detectTelegramChatIdAction,
    removeSmtpAction,
    removeTargetAction,
    saveEmailTargetAction,
    savePreferencesAction,
    saveSmtpAction,
    saveTelegramTargetAction,
    testSmtpAction,
    testTargetAction,
    type DetectChatIdState,
    type NotificationsState,
  } from './actions';
  import { EmailGuide, GuidePanel, TelegramGuide } from './guides';

  export interface NotificationsPageData {
    role: 'admin' | 'member';
    smtp: SmtpRecord | null;
    relayConfigured: boolean;
    targets: { telegram: TargetRecord | null; email: TargetRecord | null };
    events: readonly NotificationEventDef[];
    /** Effective values, keyed `${eventId}:${channel}` (MUST-3.7, resolved on the server). */
    prefs: Record<string, boolean>;
    settings: UserSettings;
    deliveries: (DeliveryRow & { userName: string })[];
    presets: typeof SMTP_PRESETS;
  }

  const CHANNELS = ['telegram', 'email'] as const;
  const PASSWORD_PLACEHOLDER = '•••••••• (saved)'; // MUST-5.6
  const NO_CHANNEL_TOOLTIP = 'Set up this channel first.'; // MUST-11.3
  /** §11.4: the three kind labels shown beside a detected chat. */
  const KIND_LABEL = { private: 'Private chat', group: 'Group', supergroup: 'Group', channel: 'Channel' } as const;
  const NO_RELAY = 'An admin needs to set up outbound email before this can send.'; // §11.3
  const PRIVACY_SENTENCE =
    'Messages contain amounts, category names and merchant names, and are delivered by Telegram or by your email provider.'; // MUST-11.4
  const BACKUP_SENTENCE =
    'The SMTP password and every bot token are stored encrypted in the database, which means they are inside the unencrypted backup archive along with everything else.'; // MUST-5.8
  const DORMANT =
    'Notifications are off. This app makes no outbound connection until you configure a channel here.'; // §11.2

  export function NotificationsClient(data: NotificationsPageData) {
    const [preset, setPreset] = useState<SmtpPreset>(data.smtp?.preset ?? 'brevo');
    const [host, setHost] = useState(data.smtp?.host ?? data.presets.brevo.host);
    const [port, setPort] = useState(String(data.smtp?.port ?? data.presets.brevo.port));
    const [security, setSecurity] = useState(data.smtp?.security ?? data.presets.brevo.security);
    const [chatId, setChatId] = useState(data.targets.telegram?.destination ?? '');
    const [detected, setDetected] = useState<DetectChatIdState | null>(null);
    const [detecting, setDetecting] = useState(false);

    const [smtpState, saveSmtp] = useActionState<NotificationsState, FormData>(saveSmtpAction, {});
    const [telegramState, saveTelegram] = useActionState<NotificationsState, FormData>(saveTelegramTargetAction, {});
    const [emailState, saveEmail] = useActionState<NotificationsState, FormData>(saveEmailTargetAction, {});
    const [prefsState, savePrefs] = useActionState<NotificationsState, FormData>(savePreferencesAction, {});

    // MUST-8.15: the picker prefills; every field stays editable afterwards.
    function choosePreset(next: SmtpPreset) {
      setPreset(next);
      setHost(data.presets[next].host);
      setPort(String(data.presets[next].port));
      setSecurity(data.presets[next].security);
    }

    async function detect() {
      setDetecting(true);
      setDetected(await detectTelegramChatIdAction());
      setDetecting(false);
    }

    const dormant =
      !(data.targets.telegram?.enabled ?? false) && !(data.targets.email?.enabled ?? false);
    const liveErrors = [
      data.targets.telegram?.lastError ? { channel: 'Telegram', error: data.targets.telegram.lastError } : null,
      data.targets.email?.lastError ? { channel: 'Email', error: data.targets.email.lastError } : null,
      data.smtp?.lastError ? { channel: 'Outbound email (SMTP)', error: data.smtp.lastError } : null,
    ].filter((entry): entry is { channel: string; error: string } => entry !== null);

    return (
      <div className="flex flex-col gap-6">
        {dormant ? <Notice tone="info">{DORMANT}</Notice> : null}
        {liveErrors.map((entry) => (
          <Notice key={entry.channel} tone="error" title={entry.channel}>
            {entry.error}
          </Notice>
        ))}

        {/* §11.3 — admins only. A member never sees this card at all. */}
        {data.role === 'admin' ? (
          <Card>
            <CardHeader title="Outbound email (SMTP)" description="One relay for the whole household." />
            <CardBody className="flex flex-col gap-4">
              {smtpState.error ? <Notice tone="error">{smtpState.error}</Notice> : null}
              {smtpState.message ? <Notice tone="success">{smtpState.message}</Notice> : null}
              <form action={saveSmtp} className="flex flex-col gap-4">
                <Field label="Preset" htmlFor="smtp-preset">
                  <select
                    id="smtp-preset"
                    name="preset"
                    className={selectClass}
                    value={preset}
                    onChange={(event) => choosePreset(event.target.value as SmtpPreset)}
                  >
                    <option value="brevo">Brevo</option>
                    <option value="smtp2go">SMTP2GO</option>
                    <option value="gmail">Gmail</option>
                    <option value="custom">Custom SMTP</option>
                  </select>
                </Field>
                <Field label="Server" htmlFor="smtp-host">
                  <input id="smtp-host" name="host" className={inputClass} value={host} onChange={(e) => setHost(e.target.value)} />
                </Field>
                <Field label="Port" htmlFor="smtp-port">
                  <input id="smtp-port" name="port" inputMode="numeric" className={inputClass} value={port} onChange={(e) => setPort(e.target.value)} />
                </Field>
                <Field label="Encryption" htmlFor="smtp-security">
                  <select
                    id="smtp-security"
                    name="security"
                    className={selectClass}
                    value={security}
                    onChange={(e) => setSecurity(e.target.value as typeof security)}
                  >
                    <option value="starttls">STARTTLS</option>
                    <option value="tls">TLS</option>
                    <option value="none">None</option>
                  </select>
                </Field>
                {/* MUST-8.16 */}
                {security === 'none' ? (
                  <Notice tone="warning">
                    Credentials and message contents will cross the network unencrypted. Only use this for a relay on your own LAN.
                  </Notice>
                ) : null}
                <Field label="Username" htmlFor="smtp-username">
                  <input id="smtp-username" name="username" className={inputClass} defaultValue={data.smtp?.username ?? ''} />
                </Field>
                <Field
                  label="Password"
                  htmlFor="smtp-password"
                  hint={data.smtp?.passwordSet ? 'Leave blank to keep the saved password.' : undefined}
                >
                  <input
                    id="smtp-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    className={inputClass}
                    placeholder={data.smtp?.passwordSet ? PASSWORD_PLACEHOLDER : ''}
                    defaultValue=""
                  />
                </Field>
                <Field label="From address" htmlFor="smtp-from">
                  <input id="smtp-from" name="fromEmail" className={inputClass} defaultValue={data.smtp?.fromEmail ?? ''} />
                </Field>
                <Field label="From name" htmlFor="smtp-from-name">
                  <input id="smtp-from-name" name="fromName" className={inputClass} defaultValue={data.smtp?.fromName ?? 'Budget Tracker'} />
                </Field>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name="enabled" defaultChecked={data.smtp?.enabled ?? true} />
                  Enabled
                </label>
                <div className="flex flex-wrap gap-2">
                  <SubmitButton>Save</SubmitButton>
                </div>
              </form>
              <div className="flex flex-wrap gap-2">
                <form action={testSmtpAction}>
                  <SubmitButton variant="secondary">Send test email</SubmitButton>
                </form>
                {data.smtp ? (
                  <form
                    action={removeSmtpAction}
                    onSubmit={(event) => {
                      if (!window.confirm('Remove the outbound email settings? Email notifications will stop until it is set up again.')) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <SubmitButton variant="danger">Remove SMTP settings</SubmitButton>
                  </form>
                ) : null}
              </div>
              {data.smtp?.lastSuccessAt ? <p className={hintClass}>Last successful send: {data.smtp.lastSuccessAt}</p> : null}
              {/* MUST-11.7: only the selected preset's guide is ever rendered. */}
              <GuidePanel open={data.smtp === null}>
                <EmailGuide preset={preset} />
              </GuidePanel>
            </CardBody>
          </Card>
        ) : null}

        {/* §11.4 — everyone. Two sub-cards; each shows its own last_error, last_success_at,
            and an Unverified badge until verified_at is set. */}
        <Card>
          <CardHeader title="Telegram" description="Your own bot, messaging your own chat." />
          <CardBody className="flex flex-col gap-4">
            {telegramState.error ? <Notice tone="error">{telegramState.error}</Notice> : null}
            {telegramState.message ? <Notice tone="success">{telegramState.message}</Notice> : null}
            {data.targets.telegram && data.targets.telegram.verifiedAt === null ? (
              <p className={hintClass}>Unverified — press Send test message to prove it works.</p>
            ) : null}
            {data.targets.telegram?.lastError ? (
              <Notice tone="error">
                {data.targets.telegram.lastError} ({data.targets.telegram.lastErrorAt})
              </Notice>
            ) : null}
            {data.targets.telegram?.lastSuccessAt ? (
              <p className={hintClass}>Last successful send: {data.targets.telegram.lastSuccessAt}</p>
            ) : null}

            <form action={saveTelegram} className="flex flex-col gap-4">
              <Field
                label="Bot token"
                htmlFor="telegram-token"
                hint={data.targets.telegram?.secretSet ? 'Leave blank to keep the saved token.' : undefined}
              >
                <input
                  id="telegram-token"
                  name="botToken"
                  type="password"
                  autoComplete="off"
                  className={inputClass}
                  placeholder={data.targets.telegram?.secretSet ? PASSWORD_PLACEHOLDER : ''}
                  defaultValue=""
                />
              </Field>
              <Field label="Chat ID" htmlFor="telegram-chat">
                <input
                  id="telegram-chat"
                  name="destination"
                  inputMode="numeric"
                  className={inputClass}
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" name="enabled" defaultChecked={data.targets.telegram?.enabled ?? true} />
                Enabled
              </label>
              <div>
                <SubmitButton>Save</SubmitButton>
              </div>
            </form>

            {/* MUST-11.2: the Detect chat ID control, immediately beside the Chat ID field. */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn--secondary"
                disabled={!data.targets.telegram?.secretSet || detecting}
                onClick={detect}
              >
                {detecting ? 'Working…' : 'Detect chat ID'}
              </button>
              {!data.targets.telegram?.secretSet ? <span className={hintClass}>Save your bot token first</span> : null}
            </div>
            {detected?.error ? <Notice tone="error">{detected.error}</Notice> : null}
            {detected?.chats?.length === 0 ? (
              <Notice tone="info">
                No messages yet. Open Telegram, find your bot, send it any message, then press this again.
              </Notice>
            ) : null}
            {detected?.chats && detected.chats.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {detected.chats.map((chat) => (
                  <li key={chat.chatId}>
                    <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
                      <input type="radio" name="detected-chat" value={chat.chatId} onChange={() => setChatId(chat.chatId)} />
                      <span className="font-semibold">{chat.title}</span>
                      <span className="text-muted">{KIND_LABEL[chat.kind]}</span>
                      <span className="text-subtle">{chat.chatId}</span>
                      {chat.lastMessageAt ? <span className="text-subtle">last message {chat.lastMessageAt}</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <form action={testTargetAction}>
                <input type="hidden" name="channel" value="telegram" />
                <SubmitButton variant="secondary" disabled={!data.targets.telegram}>
                  Send test message
                </SubmitButton>
              </form>
              {data.targets.telegram ? (
                <form action={removeTargetAction}>
                  <input type="hidden" name="channel" value="telegram" />
                  <SubmitButton variant="danger">Remove</SubmitButton>
                </form>
              ) : null}
            </div>

            {/* MUST-11.7: open by default until a token has been saved, collapsed afterwards. */}
            <GuidePanel open={!data.targets.telegram?.secretSet}>
              <TelegramGuide />
            </GuidePanel>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Email" description="Where the household relay sends your messages." />
          <CardBody className="flex flex-col gap-4">
            {emailState.error ? <Notice tone="error">{emailState.error}</Notice> : null}
            {emailState.message ? <Notice tone="success">{emailState.message}</Notice> : null}
            {data.targets.email && data.targets.email.verifiedAt === null ? (
              <p className={hintClass}>Unverified — press Send test email to prove it works.</p>
            ) : null}
            {data.targets.email?.lastError ? (
              <Notice tone="error">
                {data.targets.email.lastError} ({data.targets.email.lastErrorAt})
              </Notice>
            ) : null}
            {data.targets.email?.lastSuccessAt ? (
              <p className={hintClass}>Last successful send: {data.targets.email.lastSuccessAt}</p>
            ) : null}

            <form action={saveEmail} className="flex flex-col gap-4">
              <Field label="Email address" htmlFor="email-destination">
                <input
                  id="email-destination"
                  name="destination"
                  type="email"
                  className={inputClass}
                  defaultValue={data.targets.email?.destination ?? ''}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" name="enabled" defaultChecked={data.targets.email?.enabled ?? true} />
                Enabled
              </label>
              <div>
                <SubmitButton>Save</SubmitButton>
              </div>
            </form>

            {/* §11.3: where a member's email channel is unusable for want of a relay. */}
            {data.relayConfigured ? (
              <div className="flex flex-wrap gap-2">
                <form action={testTargetAction}>
                  <input type="hidden" name="channel" value="email" />
                  <SubmitButton variant="secondary" disabled={!data.targets.email}>
                    Send test email
                  </SubmitButton>
                </form>
                {data.targets.email ? (
                  <form action={removeTargetAction}>
                    <input type="hidden" name="channel" value="email" />
                    <SubmitButton variant="danger">Remove</SubmitButton>
                  </form>
                ) : null}
              </div>
            ) : (
              <Notice tone="info">{NO_RELAY}</Notice>
            )}
          </CardBody>
        </Card>

        {/* §11.5 — the matrix, generated from data.events. NO event is named in JSX. */}
        <Card>
          <CardHeader title="What you get told about" description="Per event, per channel." />
          <CardBody className="flex flex-col gap-4">
            {prefsState.error ? <Notice tone="error">{prefsState.error}</Notice> : null}
            {prefsState.message ? <Notice tone="success">{prefsState.message}</Notice> : null}
            <form action={savePrefs} className="flex flex-col gap-4">
              <TableWrap>
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="text-left">Event</th>
                      <th>Telegram</th>
                      <th>Email</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.map((event) => (
                      <tr key={event.id}>
                        <td className="text-left">
                          <span className="font-semibold text-ink">{event.label}</span>
                          <span className="block text-muted">{event.blurb}</span>
                        </td>
                        {CHANNELS.map((channel) => {
                          const configured = data.targets[channel]?.enabled ?? false;
                          return (
                            <td key={channel} className="text-center">
                              <input
                                type="checkbox"
                                name={`pref:${event.id}:${channel}`}
                                defaultChecked={data.prefs[`${event.id}:${channel}`] ?? event.defaultEnabled}
                                disabled={!configured}
                                title={configured ? undefined : NO_CHANNEL_TOOLTIP}
                                aria-label={`${event.label} on ${channel}`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <p className="text-sm text-muted">{PRIVACY_SENTENCE}</p>
              <p className={hintClass}>{BACKUP_SENTENCE}</p>
              {/* The five knobs, each with its default in the hint text. */}
              <Field label="Days before a due date to warn" htmlFor="comingDueDays" hint="Default 14.">
                <input id="comingDueDays" name="comingDueDays" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.comingDueDays)} />
              </Field>
              <Field label="Budget warning threshold (%)" htmlFor="budgetThresholdPct" hint="Default 80. 100 is the separate over-budget alert.">
                <input id="budgetThresholdPct" name="budgetThresholdPct" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.budgetThresholdPct)} />
              </Field>
              <Field label="Weeks without an import before nagging" htmlFor="staleImportWeeks" hint="Default 3.">
                <input id="staleImportWeeks" name="staleImportWeeks" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.staleImportWeeks)} />
              </Field>
              <Field label="Daily message hour" htmlFor="dailyHour" hint="Default 8 (24-hour clock).">
                <input id="dailyHour" name="dailyHour" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.dailyHour)} />
              </Field>
              <Field label="Weekly summary day" htmlFor="digestWeekday" hint="Default Monday.">
                <select id="digestWeekday" name="digestWeekday" className={selectClass} defaultValue={String(data.settings.digestWeekday)}>
                  {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => (
                    <option key={day} value={String(index)}>
                      {day}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Weekly summary hour" htmlFor="digestHour" hint="Default 8 (24-hour clock).">
                <input id="digestHour" name="digestHour" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.digestHour)} />
              </Field>
              <div>
                <SubmitButton>Save</SubmitButton>
              </div>
            </form>
          </CardBody>
        </Card>

        {/* §11.6 — read-only. No retry button: the pump owns retries. */}
        <Card>
          <CardHeader title="Recent deliveries" description="The last twenty messages this app tried to send." />
          <CardBody>
            <TableWrap>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">When</th>
                    {data.role === 'admin' ? <th className="text-left">Who</th> : null}
                    <th className="text-left">Event</th>
                    <th className="text-left">Channel</th>
                    <th className="text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deliveries.map((row) => (
                    <tr key={row.id}>
                      <td>{row.sentAt ?? row.createdAt}</td>
                      {data.role === 'admin' ? <td>{row.userName}</td> : null}
                      <td>{eventDef(row.eventId)?.label ?? row.eventId}</td>
                      <td>{row.channel}</td>
                      <td>
                        {row.status}
                        {row.lastError ? <span className="block text-muted">{row.lastError}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </CardBody>
        </Card>
      </div>
    );
  }
  ```
  Two notes on the component above, both load-bearing:
  - The Chat ID input is a **controlled** input bound to `chatId` / `setChatId`, and the detected-chat radios call `setChatId(chat.chatId)` and nothing else. Selecting a chat fills the field; **nothing is saved until the user presses Save** (MUST-11.2).
  - The `<span className="hidden">` in `page.tsx` and the module-level `KIND_LABEL` in the client are the only two pieces of scaffolding here; keep `KIND_LABEL`, and delete the hidden span if the reviewer prefers.

- [ ] **Run both UI tests and confirm they pass.**
  ```powershell
  npx vitest run tests/app/notifications-client.test.tsx tests/app/settings-page-notifications.test.tsx
  ```
  Expected: green.

- [ ] **Type-check, build and run the full suite.**
  ```powershell
  npm run typecheck
  npm run build
  npm test
  ```
  Expected: the route table lists `ƒ /settings/notifications`.

- [ ] **Commit.**
  ```powershell
  git add "src/app/(app)/settings/notifications/page.tsx" "src/app/(app)/settings/notifications/notifications-client.tsx" src/components/icons.tsx "src/app/(app)/settings/page.tsx" tests/app/notifications-client.test.tsx tests/app/settings-page-notifications.test.tsx
  git commit -m "feat(notify): the Settings > Notifications page

Dormant banner, admin-only SMTP section with preset prefill and a swapped guide
(MUST-11.7), per-user channel cards with Detect chat ID, a matrix generated
entirely from the registry so a future event needs no UI work (MUST-11.3/4.4),
the five knobs, and read-only recent deliveries. Existing primitives and tokens
only; no credential reaches a page prop (MUST-5.3)."
  ```

<!-- END TASK 14 -->

---

# Phase 5 — Invariants and release

## Task 15: The egress invariant test, the console-hygiene test and the integration flow

**Context:** Spec §9.4, §17.6, AC3, AC5, AC7. This is the task that makes the two-destination promise enforceable by the build rather than by review.

**Files:**
- Create: `tests/ops/notify-egress.test.ts`
- Create: `tests/integration/notify-flow.test.ts`

**Interfaces:**
- Consumes: everything built in Tasks 1–14. No production code changes — if a test here fails, **fix the source**, not the assertion.

### Steps

- [ ] **Write `tests/ops/notify-egress.test.ts` (MUST-9.4, AC3, AC7).**
  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  function filesUnder(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) filesUnder(full, acc);
      else if (/\.tsx?$/.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  const notifyDir = path.join(root, 'src/lib/notify');
  const pageDir = path.join(root, 'src/app/(app)/settings/notifications');
  const rel = (file: string) => path.relative(root, file).replace(/\\/g, '/');

  /**
   * Quoted string literals containing `://`, found line by line and ignoring comment lines.
   *
   * Line-scoped on purpose: a whole-file regex pairs a quote from one statement with a `://`
   * inside a docblock hundreds of lines later and reports a URL that does not exist. Comment
   * lines are skipped because prose legitimately writes the endpoint out (`POST
   * https://api.telegram.org/bot<token>/sendMessage`) — what matters is whether the CODE
   * carries a second destination.
   */
  function urlLiterals(file: string): string[] {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      })
      .flatMap((line) => line.match(/(['"`])[^'"`]*:\/\/[^'"`]*\1/g) ?? []);
  }

  describe('MUST-9.4 / AC3: the only outbound call sites', () => {
    it('every fetch( in src/lib/notify/ is in send/telegram.ts, and there are exactly two', () => {
      const offenders: string[] = [];
      let telegramCalls = 0;
      for (const file of filesUnder(notifyDir)) {
        const source = fs.readFileSync(file, 'utf8');
        const calls = source.match(/(?<![.\w])fetch\s*\(/g)?.length ?? 0;
        if (calls === 0) continue;
        if (rel(file) === 'src/lib/notify/send/telegram.ts') telegramCalls = calls;
        else offenders.push(rel(file));
      }
      expect(offenders).toEqual([]);
      expect(telegramCalls).toBe(2); // sendMessage and getUpdates, and nothing else
    });

    it('the only URL literal containing :// is TELEGRAM_API_ORIGIN in egress.ts', () => {
      const offenders: { file: string; literal: string }[] = [];
      for (const file of filesUnder(notifyDir)) {
        if (rel(file) === 'src/lib/notify/egress.ts') continue;
        for (const literal of urlLiterals(file)) offenders.push({ file: rel(file), literal });
      }
      expect(offenders).toEqual([]);
      expect(urlLiterals(path.join(notifyDir, 'egress.ts'))).toEqual(["'https://api.telegram.org'"]);
    });

    it('no file under src/lib/notify/ imports an HTTP client library', () => {
      const banned = /from\s+['"](axios|node-fetch|got|undici|superagent|ky|request)['"]/;
      for (const file of filesUnder(notifyDir)) {
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(banned);
      }
    });

    it('MUST-9.1a: the settings page directory contains no fetch call at all', () => {
      for (const file of filesUnder(pageDir)) {
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(/(?<![.\w])fetch\s*\(/);
      }
    });

    it('MUST-11.6: the guides render no <a href>, so no address on the page is clickable', () => {
      const guides = fs.readFileSync(path.join(pageDir, 'guides.tsx'), 'utf8');
      expect(guides).not.toMatch(/<a\s/);
      expect(guides).not.toMatch(/href=/);
    });

    it('MUST-9.1a: the page directory holds no :// STRING LITERAL — only JSX prose', () => {
      for (const file of filesUnder(pageDir)) {
        // guides.tsx writes `<code>https://</code>` as JSX text (the Custom-SMTP guide telling
        // the reader NOT to type a scheme into the Server field). That is prose a person
        // reads, not an address the server can use, and it is not a string literal.
        expect({ file: rel(file), literals: urlLiterals(file) }).toEqual({ file: rel(file), literals: [] });
      }
      const guides = fs.readFileSync(path.join(pageDir, 'guides.tsx'), 'utf8');
      expect(guides).toContain('<code>https://</code>');
    });
  });

  describe('MUST-2.1: the pure modules stay pure', () => {
    const pure = ['events.ts', 'render.ts', 'egress.ts', 'evaluate/slots.ts'];
    for (const name of pure) {
      it(`${name} imports no @/db, no @/lib/env and no node builtin`, () => {
        const source = fs.readFileSync(path.join(notifyDir, name), 'utf8');
        expect(source).not.toMatch(/from\s+['"]@\/db/);
        expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
        expect(source).not.toMatch(/from\s+['"]node:/);
      });
    }
  });

  describe('MUST-2.2: server-only modules never reach a client component', () => {
    it('no *-client.tsx has a VALUE import of notify crypto, config, outbox, raise, evaluate or a transport', () => {
      const clients = filesUnder(path.join(root, 'src/app')).filter((file) => file.endsWith('-client.tsx'));
      const banned = /from\s+['"]@\/lib\/notify\/(crypto|config|outbox|raise|send|evaluate)/;
      for (const file of clients) {
        // `import type { ... }` is erased before bundling and is how the client legitimately
        // names SmtpRecord / TargetRecord / DeliveryRow. Only value imports are the hazard.
        const offending = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => banned.test(line) && !/^import\s+type\b/.test(line));
        expect({ file: rel(file), offending }).toEqual({ file: rel(file), offending: [] });
      }
    });
  });

  describe('AC7: no console call in src/lib/notify/ can leak a subject, a body or a secret', () => {
    it('never interpolates subject, body, token, password or a decrypted secret', () => {
      const banned = /console\.[a-z]+\([^)]*\b(subject|body|botToken|password|secret|plaintext)\b/i;
      for (const file of filesUnder(notifyDir)) {
        const source = fs.readFileSync(file, 'utf8');
        const offending = source
          .split('\n')
          .map((line, index) => ({ line: line.trim(), number: index + 1 }))
          .filter((entry) => banned.test(entry.line));
        expect({ file: rel(file), offending }).toEqual({ file: rel(file), offending: [] });
      }
    });
  });

  describe('MUST-9.5: the scheduler never reaches a transport directly', () => {
    it('src/lib/scheduler.ts imports the tick pieces, not the senders', () => {
      const source = fs.readFileSync(path.join(root, 'src/lib/scheduler.ts'), 'utf8');
      expect(source).not.toMatch(/notify\/send/);
      expect(source).toContain('hasAnyEnabledTarget');
      expect(source).toContain('countPendingOutbox');
    });
  });
  ```

- [ ] **Run it and fix the source for any failure.**
  ```powershell
  npx vitest run tests/ops/notify-egress.test.ts
  ```
  Expected: green. A failure here is a real finding — move the offending literal into `egress.ts`, remove the offending `fetch`, or rename the offending `console.error` variable. **Do not relax an assertion.**

- [ ] **Write `tests/integration/notify-flow.test.ts` (§17.6).**
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { sql } from 'drizzle-orm';
  import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
  import { upsertBudget } from '@/lib/budgets';
  import { saveEmailTarget, saveSmtp, saveTelegramTarget, getTarget, removeTarget, setPref } from '@/lib/notify/config';
  import { evaluateBudgets, resetBudgetFingerprintForTests } from '@/lib/notify/evaluate/budget';
  import {
    CHANNEL_REMOVED_ERROR,
    MAX_ATTEMPTS,
    MAX_BACKOFF_MS,
    listRecentDeliveries,
    pumpOutbox,
    resetOutboxPumpForTests,
  } from '@/lib/notify/outbox';
  import { NotifyError, resetNotifySenderForTests, setNotifySenderForTests, type DeliveryRequest } from '@/lib/notify/send';

  const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';
  const TZ = 'UTC';

  let t: TestDb;
  let accountId: number;
  let userId: number;
  let sent: DeliveryRequest[];
  let telegramFails: NotifyError | null;

  function install(): void {
    setNotifySenderForTests(async (request) => {
      if (request.channel === 'telegram' && telegramFails) throw telegramFails;
      sent.push(request);
    });
  }

  beforeEach(() => {
    t = createSeededTestDb();
    accountId = insertTestAccount(t.db);
    sent = [];
    telegramFails = null;
    resetOutboxPumpForTests();
    resetBudgetFingerprintForTests();
    install();

    userId = insertTestUser(t.db, { role: 'admin', username: 'sam', name: 'Sam' });
    saveSmtp({
      preset: 'brevo',
      host: 'smtp-relay.brevo.com',
      port: 587,
      security: 'starttls',
      username: 'me@example.com',
      password: 'pw',
      fromEmail: 'me@example.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
    setPref(userId, 'budget_threshold', 'telegram', true);
    setPref(userId, 'budget_threshold', 'email', true);
  });

  afterEach(() => {
    resetNotifySenderForTests();
    resetOutboxPumpForTests();
    resetBudgetFingerprintForTests();
    t.cleanup();
  });

  function spend(categoryId: number, cents: number, date: string): void {
    t.db.run(
      sql`insert into transactions
            (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
             attributed_user_id, is_transfer, source, dedup_hash, created_at, updated_at)
          values (${accountId}, ${date}, ${-cents}, ${'LOBLAWS'}, ${'loblaws'}, ${categoryId},
                  null, 0, ${'csv'}, ${`h${Math.random()}`}, ${`${date}T00:00:00.000Z`}, ${`${date}T00:00:00.000Z`})`,
    );
  }

  function statuses(): { channel: string; status: string; last_error: string | null }[] {
    return t.sqlite.prepare('select channel, status, last_error from notification_outbox order by id').all() as never;
  }

  it('§17.6: the whole flow, end to end', async () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });

    // --- Push Groceries past 80%, tick: two rows, one per channel, both sent.
    spend(groceries, 41000, '2026-08-05');
    evaluateBudgets({ now: new Date('2026-08-17T12:00:00Z'), tz: TZ });
    expect(await pumpOutbox(new Date('2026-08-17T12:00:05Z'))).toEqual({ sent: 2, failed: 0, deferred: 0 });
    expect(sent.map((r) => r.channel).sort()).toEqual(['email', 'telegram']);
    expect(statuses().every((r) => r.status === 'sent')).toBe(true);

    // --- Tick again: nothing new.
    resetBudgetFingerprintForTests();
    evaluateBudgets({ now: new Date('2026-08-17T12:05:00Z'), tz: TZ });
    expect(await pumpOutbox(new Date('2026-08-17T12:05:05Z'))).toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect(statuses()).toHaveLength(2);

    // --- Push past 100%: one more pair.
    sent = [];
    resetBudgetFingerprintForTests();
    spend(groceries, 15000, '2026-08-06');
    evaluateBudgets({ now: new Date('2026-08-17T12:10:00Z'), tz: TZ });
    await pumpOutbox(new Date('2026-08-17T12:10:05Z'));
    expect(sent.map((r) => r.channel).sort()).toEqual(['email', 'telegram']);
    expect(statuses()).toHaveLength(4);

    // --- Advance a month: the same category fires again for the new month.
    sent = [];
    resetBudgetFingerprintForTests();
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-09', amountCents: 50000 });
    spend(groceries, 60000, '2026-09-03');
    evaluateBudgets({ now: new Date('2026-09-17T12:00:00Z'), tz: TZ });
    await pumpOutbox(new Date('2026-09-17T12:00:05Z'));
    expect(sent.length).toBeGreaterThan(0);

    // --- Telegram throws transiently, email succeeds: per-channel isolation.
    sent = [];
    resetBudgetFingerprintForTests();
    telegramFails = new NotifyError('bot api unreachable', { permanent: false });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-10', amountCents: 50000 });
    spend(groceries, 60000, '2026-10-03');
    evaluateBudgets({ now: new Date('2026-10-17T12:00:00Z'), tz: TZ });
    const mixed = await pumpOutbox(new Date('2026-10-17T12:00:05Z'));
    expect(mixed.sent).toBeGreaterThan(0);
    expect(sent.every((r) => r.channel === 'email')).toBe(true);
    expect(getTarget(userId, 'telegram')?.lastError).toBe('bot api unreachable');
    expect(getTarget(userId, 'email')?.lastError).toBeNull();

    // --- Exhaust the attempts: the Telegram rows go failed and show in the deliveries list.
    let clock = new Date('2026-10-17T12:00:05Z').getTime();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      clock += MAX_BACKOFF_MS;
      await pumpOutbox(new Date(clock));
    }
    const telegramRows = statuses().filter((r) => r.channel === 'telegram');
    expect(telegramRows.some((r) => r.status === 'failed')).toBe(true);
    expect(listRecentDeliveries({ userId }).some((row) => row.status === 'failed')).toBe(true);

    // --- Remove the Telegram target with rows still pending: they resolve to the removal
    //     message and the sender records ZERO further calls (MUST-7.5, MUST-1.1).
    telegramFails = null;
    resetBudgetFingerprintForTests();
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-11', amountCents: 50000 });
    spend(groceries, 60000, '2026-11-03');
    evaluateBudgets({ now: new Date('2026-11-17T12:00:00Z'), tz: TZ });
    removeTarget(userId, 'telegram');
    sent = [];
    clock = new Date('2026-11-17T12:00:05Z').getTime() + MAX_BACKOFF_MS;
    await pumpOutbox(new Date(clock));
    expect(sent.every((r) => r.channel === 'email')).toBe(true);
    const removed = statuses().filter((r) => r.channel === 'telegram' && r.last_error === CHANNEL_REMOVED_ERROR);
    expect(removed.length).toBeGreaterThan(0);
  });
  ```

- [ ] **Run the integration test.**
  ```powershell
  npx vitest run tests/integration/notify-flow.test.ts
  ```
  Expected: green. This test walks the whole feature; a failure here is a genuine integration bug, so debug it with `superpowers:systematic-debugging` rather than by loosening a step.

- [ ] **Run the whole suite and confirm AC1, AC2, AC3, AC4, AC5, AC6 and AC7 all hold.**
  ```powershell
  npm run typecheck
  npm test
  ```
  Expected: green, with `tests/ops/notify-egress.test.ts`, `tests/db/notification-schema.test.ts` (AC6), `tests/lib/scheduler.test.ts` (AC4) and `tests/integration/notify-flow.test.ts` all passing.

- [ ] **Commit.**
  ```powershell
  git add tests/ops/notify-egress.test.ts tests/integration/notify-flow.test.ts
  git commit -m "test(notify): egress invariants, console hygiene and the end-to-end flow

Source-level assertions that the only fetch sites are the two in send/telegram.ts
and the only :// literal is TELEGRAM_API_ORIGIN (MUST-9.4, AC3); no console call
in src/lib/notify can interpolate a subject, body or secret (AC7); the §17.6
integration walk from configuration through backoff, exhaustion and channel
removal."
  ```

<!-- END TASK 15 -->

---

## Task 16: Release — v1.3.0, CHANGELOG and the documentation amendments

**Context:** Spec §16 and the doc obligations of MUST-5.7, MUST-5.8 and MUST-9.5.

**VERSION RULING (already decided by the owner — do not re-litigate MUST-16.0):** notifications ships as **v1.3.0**. The in-flight billing-cycle work belongs to **v1.2.3**. At the time this plan was written `package.json` was at `1.2.3` and `CHANGELOG.md`'s newest section was `## [1.2.3] - 2026-08-17`, which is consistent with that ruling. If `package.json` already reads `1.3.0` when this task starts, note it and proceed: the task is **"ensure `package.json` = 1.3.0 and CHANGELOG has a 1.3.0 entry for notifications"**, not "bump from 1.2.3".

**Known inconsistency to fix (found while writing this plan):** `src/db/schema.ts`'s docblock on `warrantyItems.billingCycle` reads *"v1.3.0, added by drizzle/0005_billing_cycle.sql"*. Under the ruling, 0005 is v1.2.3. Correct that one comment to `v1.2.3` as part of this task; it is a comment, so it cannot conflict with the concurrent work's behaviour.

**Files:**
- Modify: `package.json` (`version`)
- Modify: `CHANGELOG.md`
- Modify: `README.md`, `INSTALL.md`
- Modify: `src/db/schema.ts` (the one stale version comment)
- Modify: `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (MUST-9.5's second opt-in egress exception)
- Modify: `docs/superpowers/specs/2026-08-17-notifications-design.md` (record the MUST-16.0 resolution)
- Test: `tests/lib/changelog.test.ts` or `tests/ops/install.test.ts` (whichever already pins the version/changelog pairing — append one assertion)

**Interfaces:**
- Consumes: `src/lib/version.ts`, which imports `package.json`'s `version` at build time (MUST-16.1); `src/lib/changelog.ts`, which renders `CHANGELOG.md` at request time (MUST-16.3 — Settings → About needs no code change).
- Produces: no new code exports.

### Steps

- [ ] **Check the current state before changing anything.**
  ```powershell
  node -e "console.log('package.json version:', require('./package.json').version)"
  Select-String -Path .\CHANGELOG.md -Pattern '^## \[' | Select-Object -First 3
  ```
  Record what you see. Under the ruling the target end state is `1.3.0` in `package.json` and a `## [1.3.0] — 2026-08-17` section in `CHANGELOG.md` describing notifications. If the billing-cycle work has not yet written its own `1.2.3` entry, do **not** write one for it — that belongs to whoever ships it.

- [ ] **Set `package.json`'s `version` to `1.3.0` (MUST-16.1).** It remains the single source of truth: `src/lib/version.ts` imports it at build time, the footer and Settings → About render it, `/api/health` reports it, and the update scripts print it.

- [ ] **Add the CHANGELOG section (MUST-16.2), Keep-a-Changelog style, with a fresh empty `## Unreleased` left above it.**
  ```markdown
  ## Unreleased

  ## [1.3.0] — 2026-08-17

  ### Added

  - **Notifications.** Settings → Notifications tells the household about the things it would
    otherwise have to remember to go and look at: a warranty about to lapse, a subscription
    about to auto-renew, a budget it has burned through, a backup that did not run. Two
    channels — a per-user **Telegram** bot and a household **SMTP relay** with a per-user
    destination address, with one-press presets for Brevo, SMTP2GO and Gmail plus a Custom
    option. **Eight events** (something coming due, a budget getting close, a budget blown,
    the nightly backup failing, a weekly spending summary, a new sign-in, a restore
    finishing, and nothing imported lately), each switchable per person and per channel, with
    per-person knobs for the warning window, the budget threshold, the staleness period and
    the hour the daily and weekly messages arrive.
  - **Send test** on every channel, so nobody has to trust that setup worked.
  - **Built-in setup guides** written for a family member who has never heard of SMTP — one
    for Telegram and one per email preset — and a **Detect chat ID** button that asks Telegram
    which conversations your bot has heard from, so nobody hand-copies a numeric id out of a
    raw JSON page.
  - **Recent deliveries** on the same page: what was sent, on which channel, and the
    provider's own error text when something failed.

  ### Security

  - The SMTP password and every Telegram bot token are **encrypted at rest** under keys
    derived from `SECRET_KEY`, alongside the existing TOTP secrets and SimpleFIN access URL.
    They are never returned to the browser, never logged, and masked in the form after saving.
  - A **new sign-in alert** is on by default, naming the time, IP address and browser.
  - The feature is **dormant until configured**: with no channel set up the app makes no
    outbound connection on account of notifications, and the only two destinations it can
    ever reach are `api.telegram.org` and the SMTP server an admin typed in.
  ```

- [ ] **Extend `README.md` and `INSTALL.md` (MUST-5.7, MUST-5.8, MUST-9.4/9.5, MUST-16.4).** Three edits in each place the corresponding text already exists:
  1. **The `SECRET_KEY` loss/rotation consequence list** gains a third entry alongside the TOTP enrollments and the SimpleFIN access URL, worded as MUST-5.7 specifies: *the SMTP password and every Telegram bot token become unreadable and must be re-entered; nothing else is affected and no notification is lost, because the outbox rows themselves are plaintext.*
  2. **The "no runtime network calls" statement** gains a second opt-in exception beside SimpleFIN, worded the same way: *dormant until configured, two destinations (`api.telegram.org` and the SMTP relay an admin entered), both chosen by the user.*
  3. **`INSTALL.md`'s Hyper Backup client-side-encryption guidance** is extended to name the new credentials: the SMTP password and the bot tokens live in the database and are therefore inside the **unencrypted** backup archive, exactly as the SimpleFIN access URL and the TOTP secrets are.
  `.env.example` is **unchanged** — this feature introduces no environment variable.

- [ ] **Amend the master spec (MUST-9.5).** In `docs/superpowers/specs/2026-08-15-budget-tracker-design.md`, find §2's "no runtime network calls" line and add the second exception beside the SimpleFIN one, in the same sentence shape.

- [ ] **Record the version resolution in the notifications spec.** In `docs/superpowers/specs/2026-08-17-notifications-design.md`, under **MUST-16.0**, append one line:
  ```markdown
  **Resolved (2026-08-17, owner's ruling):** option (a) is NOT taken. Billing-cycle ships as **v1.2.3** and notifications ships as **v1.3.0**; every `1.3.0` in §16 and in the revision history stands as written. `drizzle/0005_billing_cycle.sql` keeps journal idx 5 and notifications keeps idx 6 (MUST-3.2a), unchanged either way.
  ```

- [ ] **Fix the stale version comment in `src/db/schema.ts`.** Change the docblock line on `warrantyItems.billingCycle` from `v1.3.0, added by drizzle/0005_billing_cycle.sql` to `v1.2.3, added by drizzle/0005_billing_cycle.sql` — 0005 is the billing-cycle release, and 1.3.0 is now notifications.

- [ ] **Append the version-pairing assertion to the test that already pins it.** Find it first:
  ```powershell
  Select-String -Path .\tests\lib\changelog.test.ts,.\tests\ops\install.test.ts -Pattern 'version' -SimpleMatch | Select-Object -First 10
  ```
  Then add, in whichever file already reads `package.json` and `CHANGELOG.md` together:
  ```ts
  describe('MUST-16.1 / MUST-16.2: the 1.3.0 release', () => {
    it('package.json is 1.3.0 and the changelog has a matching section', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
      expect(pkg.version).toBe('1.3.0');
      const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toMatch(/^## \[1\.3\.0\]/m);
      // An empty Unreleased section is left in place for the next session.
      expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.3.0]'));
    });

    it('MUST-5.7: the SECRET_KEY consequence list names the new credentials', () => {
      for (const doc of ['README.md', 'INSTALL.md']) {
        const source = fs.readFileSync(path.join(root, doc), 'utf8');
        expect(source).toMatch(/SMTP password/i);
        expect(source).toMatch(/bot token/i);
      }
    });
  });
  ```
  Use the file's existing `root`, `fs` and `path` bindings rather than re-declaring them.

- [ ] **Run the full suite, type-check and build one last time.**
  ```powershell
  npm run typecheck
  npm run build
  npm test
  ```
  Expected: all green.

- [ ] **Commit.**
  ```powershell
  git add package.json CHANGELOG.md README.md INSTALL.md src/db/schema.ts docs/superpowers/specs tests
  git commit -m "chore(release): notifications ships as v1.3.0

package.json bumped and a Keep-a-Changelog 1.3.0 section added (MUST-16.1/16.2).
README and INSTALL gain the third SECRET_KEY consequence (MUST-5.7), the second
opt-in egress exception (MUST-9.5) and the backup-encryption note (MUST-5.8).
Billing-cycle stays v1.2.3 per the owner's ruling on MUST-16.0; the stale
v1.3.0 comment on warrantyItems.billingCycle is corrected."
  ```

- [ ] **Push at the end of the session** (per the standing workflow), on the working branch — not directly to `main`.
  ```powershell
  git status --short
  git log --oneline -16
  git push
  ```

<!-- END TASK 16 -->

---

# Spec coverage map

Every section of `docs/superpowers/specs/2026-08-17-notifications-design.md` maps to at least one task.

| Spec section | Requirements | Task(s) |
|---|---|---|
| §1 Overview, dormancy | MUST-1.1, MUST-1.2 | Global Constraints; enforced in **1** (empty tables), **6** (pre-send revalidation), **11** (the tick's first statement), **15** (AC4 assertion) |
| §2 Architecture delta, `src/lib/notify/` layout, purity | MUST-2.1, MUST-2.2 | **3**, **5**, **8** (purity at source); **15** (source-level invariant test) |
| §3.1 Migration discipline | MUST-3.1 … MUST-3.4, MUST-3.2a | **1** (incl. the 0005 pre-step and AC6) |
| §3.2 `notification_smtp` | — | **1**, **4** |
| §3.3 `notification_targets` | MUST-3.5 | **1**, **4** |
| §3.4 `notification_prefs` | MUST-3.6, MUST-3.7 | **1**, **4** |
| §3.5 `notification_user_settings` | MUST-3.8 | **1**, **4** |
| §3.6 `notification_outbox`, dedup | MUST-3.9, MUST-3.10 | **1**, **6** |
| §3.7 Dedup keys | MUST-3.11, MUST-3.12 | **3** (builders), **9**/**10**/**11** (each key's producer) |
| §3.8 Indexes and retention | MUST-3.13, MUST-3.14 | **1**, **6** |
| §3.9 Drizzle mirror | MUST-3.15 | **1** |
| §3.10 Exact SQL | — | **1** |
| §4 Event registry | MUST-4.1 … MUST-4.5 | **3**; extension point re-asserted in **14** |
| §4.3 Effective toggle resolution | — | **4** |
| §5 Secrets at rest | MUST-5.1 … MUST-5.8 | **2** (crypto and scrubbing), **4** (never returned), **12** (masking on save), **14** (UI masking + the backup sentence), **16** (README/INSTALL) |
| §6.1 The tick | MUST-6.1 … MUST-6.4 | **11** |
| §6.2 What is evaluated when | — | **10** (`evaluate/index.ts`) |
| §6.3 Slot arithmetic and catch-up | MUST-6.5 … MUST-6.9 | **8** |
| §6.4 `coming_due` | MUST-6.10 … MUST-6.14 | **9** |
| §6.5 Budget events | MUST-6.15 … MUST-6.18 | **10** |
| §6.6 Immediate events | MUST-6.19 | **11** |
| §7.1 Enqueue | MUST-7.1, MUST-7.2 | **6** |
| §7.2 The pump | MUST-7.3 … MUST-7.5 | **6** |
| §7.3 Retry and backoff | MUST-7.6 … MUST-7.9 | **6** |
| §7.4 Failure surfacing | MUST-7.10, MUST-7.11 | **6** (writes), **4** (the record helpers), **14** (rendering) |
| §8.1 Telegram | MUST-8.1 … MUST-8.4 | **7** |
| §8.2 Detect chat ID | MUST-8.5 … MUST-8.11 | **7** (transport), **12** (action), **14** (control) |
| §8.3 Email | MUST-8.12 … MUST-8.17 | **7** (transport), **4** (presets), **12** (the `none` refinement) |
| §9 Egress policy | MUST-9.1, MUST-9.1a, MUST-9.2 … MUST-9.5 | **3** (guard), **7** (call sites), **13** (guide URLs as text), **15** (invariant test), **16** (master-spec amendment) |
| §10 Rendering | MUST-10.1 … MUST-10.4 | **5** |
| §10.2 Digest body | — | **5** (renderer), **10** (data) |
| §11.1 Entry point | MUST-11.1 | **14** |
| §11.2 Page structure | — | **14** |
| §11.3 Admin SMTP section | — | **14** |
| §11.4 Your channels | MUST-11.2 | **14** |
| §11.5 The matrix | MUST-11.3, MUST-11.4 | **14** |
| §11.6 Recent deliveries | — | **6** (`listRecentDeliveries`), **14** (table) |
| §11.7 Setup guides | MUST-11.5 … MUST-11.8 | **13** (copy), **14** (panels and the button-label assertion) |
| §12 Actions and security | MUST-12.1 … MUST-12.8 | **12** |
| §13 Rate limiting | MUST-13.1, MUST-13.1a … MUST-13.3 | **12** |
| §14.1 Backup | MUST-14.1 | **11** |
| §14.2 Restore | MUST-14.2, MUST-14.3 | **11** |
| §14.3 Login | MUST-14.4, MUST-14.5 | **11** |
| §14.4 Users | MUST-14.6, MUST-14.7 | **4** (`isEventEnabled`, `notifiableUsers`) |
| §14.5 SimpleFIN | MUST-14.8 | **9** (`stale_import` reads every `imports` row) |
| §15 Dependencies | MUST-15.1 … MUST-15.4 | **7** |
| §16 Versioning and release | MUST-16.0 … MUST-16.4 | **16** |
| §17.1 Unit tests | MUST-17.1 | **2**, **3**, **4**, **5**, **6**, **7**, **8**, **12** |
| §17.2 Evaluation tests | — | **9**, **10** |
| §17.3 Database tests | — | **1** |
| §17.4 Scheduler and seams | — | **11** |
| §17.5 Actions and client tests | — | **12**, **13**, **14** |
| §17.6 Integration | — | **15** |
| §18.1 Automated acceptance | AC1 … AC7 | AC1/AC2 every task; AC3/AC7 **15**; AC4 **11**; AC5 **2**–**15**; AC6 **1** |
| §18.2 Manual QA | A1 … A14 | Final checklist below |
| §19 Decisions | 1–27 | Encoded as constants and comments across **3**, **6**, **7**, **9**, **10**, **11**, **12**, **13** |
| §20 Risks | R1 … R12 | R1 **2**/**15**; R2 **15**; R3 **1**/**6**; R4 **6**/**11**; R5 **9**/**12**; R6 **13**; R7 **6**/**7**; R8 **14**/**16**; R9 **6**/**11**; R10 **13**; R11 **7**/**13**; R12 **1**/**16** |
| §21 Out of scope | — | Nothing implemented; **3** and **14** keep the extension point open |

---

# Final acceptance checklist

Run after Task 16. Automated items must be green in CI; manual items are the once-per-release QA pass of §18.2.

**Automated (§18.1)**
- [ ] **AC1** `npm test` is green, including every test named in §17.
- [ ] **AC2** `npm run typecheck` is clean under `strict`.
- [ ] **AC3** `tests/ops/notify-egress.test.ts` passes — the only outbound URL literal under `src/lib/notify/` is `api.telegram.org`, and the settings page directory contains no `fetch`.
- [ ] **AC4** With no configured channel, a boot plus twelve simulated ticks produce zero sender and zero evaluator invocations.
- [ ] **AC5** No test performs real network I/O.
- [ ] **AC6** `drizzle/0006_notifications.sql` contains the statement-breakpoint marker only as a separator, never inside a comment.
- [ ] **AC7** No `console.*` call in `src/lib/notify/` interpolates a subject, a body, or a decrypted secret.
- [ ] `npm run build` succeeds and the route table lists `ƒ /settings/notifications`.

**Manual (§18.2)**
- [ ] **A1** Fresh install, page never opened: no notify line in `docker logs` beyond scheduler registration; an hour of packet capture shows nothing to `api.telegram.org` or any SMTP port.
- [ ] **A2** Configure Telegram **using only the on-screen guide, no other tab open**. Send test arrives in seconds. Corrupt the chat id → the page shows Telegram's own "chat not found".
- [ ] **A2b** Press Detect chat ID before messaging the bot → the empty-state sentence. Message the bot, press again → your chat is listed by name; selecting it fills the field. Press a third time → still listed (no `offset`). Add the bot to a family group, send one message, press again → both appear, correctly labelled.
- [ ] **A3** Configure Brevo or SMTP2GO as admin **using only the guide** → mail arrives. Wrong password → the failure shows on the page and contains no fragment of the password.
- [ ] **A4** Configure Gmail **using only the guide** with a 16-character app password → mail arrives, From rewritten as the copy warns. Try the ordinary Google password first → it fails exactly as the guide says.
- [ ] **A5** Item expiring in 10 days, `coming_due_days = 14`, `daily_hour` set to the next clock hour → the message arrives at that hour and does **not** repeat the next day.
- [ ] **A6** Stop the container before the daily hour, start it 3 hours later → the missed slot fires at boot. Repeat with a 20-hour gap → it does not, and the skip is logged.
- [ ] **A7** Import a CSV pushing a category past 80% → the alert arrives within one tick. Import more past 100% → the exceeded alert arrives. Neither repeats.
- [ ] **A8** Sign in from a second device → the alert names the right time, IP and browser.
- [ ] **A9** Break the relay (wrong port) and let a real event fire → Telegram still delivers, the email row retries and eventually shows a permanent failure in Recent deliveries, with the relay's `last_error` on the SMTP card.
- [ ] **A10** Rotate `SECRET_KEY` and restart → both channels report "Stored credential could not be read. Re-enter it.", the app stays up, nothing 500s, and re-entering both credentials restores delivery.
- [ ] **A11** Restore a pre-1.3.0 backup → the app boots, the five tables exist and are empty, the page shows the dormant banner, nothing is sent.
- [ ] **A12** As a member: `/settings/notifications` loads, the SMTP section is absent, own channels and toggles work, `/settings/users` is still refused.
- [ ] **A13** Press Send test four times in a minute → the fourth is refused with the wait message and nothing is delivered. Press Detect chat ID four times → all four work.
- [ ] **A14** Hand the page to a household member who has never set up an SMTP relay and watch them configure email start to finish using only the guide. Anything they have to ask about is a copy bug.



