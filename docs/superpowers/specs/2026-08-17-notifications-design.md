# Notifications — Design Spec (v1.3.0)

**Date:** 2026-08-17
**Status:** approved design. Ships as **v1.3.0**.
**Base specs:** `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (the master spec; §-references below without a prefix are to it) and `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md` (referenced as *warranty §n*). Everything here is **additive**: no committed migration is edited, no existing table is redesigned, no rule in either base spec is withdrawn.

Requirement labels (**MUST-n.m**) are binding and are written so that each one is testable.

---

## 1. Overview

Settings → Notifications. The household gets told about the things it would otherwise have to remember to go and look at: a warranty about to lapse, a subscription about to auto-renew, a budget it has burned through, a backup that did not run.

### 1.1 The dormancy rule — the single most important property

**MUST-1.1** The feature is **dormant until configured**. With no configured channel the app makes **zero** outbound network connections on account of notifications — no DNS lookup, no TCP connect, no probe, no "are you reachable" check at boot. This is the same opt-in-egress stance the SimpleFIN connector takes (§12) and it is enforced structurally, not by convention:

- Every one of the five new tables is created **empty** by migration 0006 and stays empty until a person fills in a form.
- The scheduler tick's **first** action is the dormancy check of MUST-6.4; when it is dormant the tick returns before touching any evaluation or sender code.
- The only two hosts the feature may ever contact are `api.telegram.org` and the SMTP host an admin typed in (§9).

**MUST-1.2** An install that never opens this page behaves exactly as v1.2.2 did.

### 1.2 Goals

- Two channels: **Telegram** (per-user bot + chat) and **Email** (household SMTP relay, per-user destination address).
- Eight launch events (§4.2), per-user and per-channel, with a per-channel **Send test** button.
- **Setup guides built into the page** (§11.7), written for a family member who has never heard of SMTP, plus a **Detect chat ID** helper (§8.2) so nobody has to hand-copy a numeric Telegram id out of a raw JSON response.
- An **event registry in code** so the statistical "predictive spending targets" feature planned for the next release adds events by appending to an array — **no migration, no schema change** (MUST-4.4).
- Credentials encrypted at rest under the existing `SECRET_KEY`-derived key material, never logged, never returned to the browser, masked in the UI after save.
- Delivery that survives a container restart, a dead SMTP relay, and a blocked Telegram bot without losing or duplicating the other channel's messages.

### 1.3 Non-goals for v1.3.0

Push/web-push, SMS, Slack/Discord/Matrix/ntfy, Apprise, per-event quiet hours, snooze, digest batching of unrelated events into one message, deep links into the app (MUST-10.4), inbound Telegram commands, HTML email, attachments, and any privacy mode that redacts amounts. All are listed in §21.

---

## 2. Architecture delta

| Concern | Decision |
|---|---|
| New page | `/settings/notifications` — `page.tsx`, `notifications-client.tsx`, `actions.ts` under `src/app/(app)/settings/notifications/` (**new directory**) |
| New route handlers | **none**. Every mutation is a server action; there is no multipart body and no download, so warranty §6.2's exception does not apply here |
| New library dir | `src/lib/notify/` (**new**) — layout in §2.1 |
| New migration | `drizzle/0006_notifications.sql` (**new**), journal idx **6**, `when` **1755734400000** |
| New runtime dep | **`nodemailer`** only (justified in §15) |
| Background work | the existing `src/lib/scheduler.ts` gains a fifth-minute notification tick; delivery uses an outbox table plus an in-process pump modelled directly on `src/lib/warranty/ocr/queue.ts` |
| Docker | **no change**. No new asset, no new base-image package, no new writable path |
| CSP / security headers | **no change**. All egress is server-side `fetch`/SMTP; the browser never talks to Telegram or the relay |

### 2.1 `src/lib/notify/` layout (all files new)

```
src/lib/notify/
  crypto.ts              encrypt/decrypt + scrubSecrets  (§5)
  events.ts              the event registry — PURE, client-safe  (§4)
  config.ts              SMTP row, targets, prefs, per-user options CRUD  (§3)
  outbox.ts              enqueue(), pumpOutbox(), backoff, boot expiry, retention  (§7)
  render.ts              subject/body builders per event — pure  (§10)
  egress.ts              TELEGRAM_API_ORIGIN + assertTelegramUrl  (§9)
  ratelimit.ts           in-memory Send-test buckets  (§13)
  raise.ts               immediate raisers: sign-in, backup failure, restore outcome  (§6.6)
  send/index.ts          deliver() dispatch, NotifyError, setNotifySenderForTests
  send/telegram.ts       sendTelegram() + fetchTelegramChats()  (§8.1, §8.2)
  send/email.ts
  evaluate/index.ts      runScheduledEvaluation(now)
  evaluate/slots.ts      slot + catch-up arithmetic — PURE  (§6.3)
  evaluate/coming-due.ts
  evaluate/budget.ts
  evaluate/digest.ts
  evaluate/stale.ts
```

**MUST-2.1** `src/lib/notify/events.ts`, `render.ts`, `egress.ts` and `evaluate/slots.ts` are **pure**: no `@/db` import, no `@/lib/env` import, no node builtin beyond `node:crypto` (which none of them need). `events.ts` in particular is imported by the client-side event matrix, so this is the same Ruling P4 constraint that governs `src/lib/warranty/constants.ts` — importing `@/db` there fails the client webpack build outright.

**MUST-2.2** `src/lib/notify/crypto.ts` and `send/*` are server-only and are never imported, directly or transitively, from a `*-client.tsx` file.

### 2.2 Files modified (exhaustive)

| File | Change |
|---|---|
| `src/db/schema.ts` | five new table mirrors (§3.8) |
| `src/lib/scheduler.ts` | `NOTIFY_TICK_CRON`, the tick, a boot-time tick, and one `raiseBackupFailed()` call in the existing nightly `catch` |
| `src/instrumentation-node.ts` | one guarded `raiseRestoreOutcome()` call, placed **after** `getDb()` and **before** `startScheduler()` (§14.2) |
| `src/lib/auth/login.ts` | one guarded `raiseNewSignin()` call immediately after `createSession()` on the success path (§14.3) |
| `src/lib/dates.ts` | two new pure helpers, `localHour()` and `localWeekday()` (§6.3) |
| `src/app/(app)/settings/page.tsx` | one new **non-admin** card linking to `/settings/notifications` (§11.1) |
| `src/components/icons.tsx` | one new `BellIcon` export |
| `package.json` | `version` → `1.3.0`; `nodemailer` added |
| `drizzle/meta/_journal.json` | idx 5 entry |
| `CHANGELOG.md`, `README.md`, `INSTALL.md` | §16 |

`src/components/app-shell/nav.ts` is **not** changed — notifications live under Settings, and the nav's longest-prefix rule already lights Settings up for `/settings/notifications`.

---

## 3. Data model

### 3.1 Migration discipline (restating the binding rule)

**MUST-3.1** Migrations are **append-only and hand-authored**. `drizzle-kit generate` is never run — there is no `0000_snapshot.json`, so it would diff against an empty baseline, re-emit all 24 existing tables, and silently drop every raw-SQL-only object. The order of work is fixed:

1. hand-author `drizzle/0006_notifications.sql`,
2. append the journal entry,
3. mirror the five tables in `src/db/schema.ts`.

**MUST-3.2** The journal entry appended to `drizzle/meta/_journal.json` is exactly:

```json
{ "idx": 6, "version": "6", "when": 1755734400000, "tag": "0006_notifications", "breakpoints": true }
```

**MUST-3.2a (slot 0005 is already taken).** At the time this spec was written, `drizzle/0005_billing_cycle.sql` — subscription/contract billing cycle and amount on `warranty_items` — was present and uncommitted in the working tree, holding journal idx **5** and `when` **1755648000000**. Notifications therefore takes **0006**. Append-only discipline means the numbers are first-come, not negotiable: whichever of the two lands first keeps its slot and the other renumbers. If 0005 has been dropped by the time implementation starts, notifications still stays at 0006 rather than backfilling the gap — a hole in the sequence is harmless, a reused index is not, because `_journal.json` is what decides whether a migration has already run on an existing install.

**MUST-3.3** Statements in the migration file are separated by the drizzle statement-breakpoint marker. **The splitter is comment-blind** — it splits on that marker and nothing else, wherever it appears, including inside a `--` comment. The marker therefore **MUST NOT** appear anywhere in the file's header comment or in any inline comment; the header below refers to it only in prose. Getting this wrong shreds the migration into fragments that fail to parse.

**MUST-3.4** The header comment repeats the drizzle-kit warning from `0000_init.sql` and extends its running enumeration of objects that exist only in SQL, exactly as `0004_item_type_kinds.sql` does.

### 3.2 `notification_smtp` — the household's outbound mailbox (admin-level)

One relay for the whole household, configured by an admin. At most one row, enforced in SQL rather than in the app layer (`CHECK (id = 1)`), because "at most one" is a property of the data, and because the app-layer-only convention `simplefin_connections` uses (§12) has no equivalent guard on a hand-written INSERT during a support session.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK, `CHECK (id = 1)` | singleton |
| `preset` | text, `CHECK IN ('brevo','smtp2go','gmail','custom')` | drives UI help copy only; the connection uses the stored host/port/security |
| `host` | text NOT NULL | |
| `port` | integer NOT NULL, `CHECK BETWEEN 1 AND 65535` | |
| `security` | text NOT NULL, `CHECK IN ('tls','starttls','none')` | `tls` = implicit TLS (465); `starttls` = upgrade on 587; `none` = plaintext, `custom` preset only (§8.2) |
| `username` | text NOT NULL | |
| `password_encrypted` | text NOT NULL | base64(iv ‖ tag ‖ ciphertext), AES-256-GCM, HKDF info `notify-smtp-v1` (§5) |
| `from_email` | text NOT NULL | envelope + header From |
| `from_name` | text NOT NULL DEFAULT `'Budget Tracker'` | |
| `enabled` | integer NOT NULL DEFAULT 1 | an admin can switch the relay off without deleting the credential |
| `last_error` | text | scrubbed (§5.3); surfaced in Settings |
| `last_error_at` | text | ISO datetime |
| `last_success_at` | text | ISO datetime |
| `created_at`, `updated_at` | text NOT NULL | ISO datetime |

### 3.3 `notification_targets` — where one person is reached on one channel

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | |
| `user_id` | integer NOT NULL → `users(id)` ON DELETE CASCADE | |
| `channel` | text NOT NULL, `CHECK IN ('telegram','email')` | |
| `destination` | text NOT NULL | telegram: numeric chat id; email: destination address |
| `secret_encrypted` | text | telegram: the bot token, HKDF info `notify-telegram-v1`; email: NULL |
| `enabled` | integer NOT NULL DEFAULT 1 | |
| `verified_at` | text | set by a **successful** Send test; the UI badges an unverified channel |
| `last_error`, `last_error_at`, `last_success_at` | text | per-channel failure surfacing (§7.5) |
| `created_at`, `updated_at` | text NOT NULL | |

Plus `CHECK ((channel = 'telegram' AND secret_encrypted IS NOT NULL) OR (channel = 'email' AND secret_encrypted IS NULL))` — an email target that somehow carried a credential, or a Telegram target that did not, would be a silent misconfiguration rather than a loud one.

`UNIQUE (user_id, channel)` — one Telegram and one email address per person. Deliberate: multiple destinations per channel is fan-out complexity nobody in a four-person household has asked for.

**MUST-3.5** Each user supplies their **own** bot token. A household could share one bot across members, but per-user tokens mean a member removing their channel revokes nothing of anyone else's, and one blocked bot cannot silence the household.

### 3.4 `notification_prefs` — the per-event, per-channel toggle matrix

```
PRIMARY KEY (user_id, event_id, channel)  -- WITHOUT ROWID
```

| Column | Type | Notes |
|---|---|---|
| `user_id` | integer NOT NULL → `users(id)` ON DELETE CASCADE | |
| `event_id` | text NOT NULL | **an opaque registry key, not an enum** — this is what makes MUST-4.4 true |
| `channel` | text NOT NULL, `CHECK IN ('telegram','email')` | |
| `enabled` | integer NOT NULL DEFAULT 0 | |

**MUST-3.6** `event_id` carries **no** `CHECK` constraint and **no** foreign key. A future event type is one appended entry in `src/lib/notify/events.ts` and nothing else. Rows whose `event_id` is not in the registry (the shape a downgrade leaves behind) are ignored on read and never rendered — they are not deleted, so a re-upgrade restores the user's choice.

**MUST-3.7 (sparse storage).** A row exists only where a user has actively changed a toggle. The effective value is `row?.enabled ?? registryDefault(event_id)` (§4.3). Nothing seeds this table — not migration 0006, not the setup wizard, not user creation.

### 3.5 `notification_user_settings` — the per-user knobs

One row per user, created lazily on first save. **An absent row means every default applies**, so a user who never opens the page still gets correct behaviour.

| Column | Type | Default | Check |
|---|---|---|---|
| `user_id` | integer PK → `users(id)` ON DELETE CASCADE | | |
| `coming_due_days` | integer NOT NULL | `14` | `BETWEEN 1 AND 365` |
| `budget_threshold_pct` | integer NOT NULL | `80` | `BETWEEN 1 AND 99` |
| `stale_import_weeks` | integer NOT NULL | `3` | `BETWEEN 1 AND 52` |
| `daily_hour` | integer NOT NULL | `8` | `BETWEEN 0 AND 23` |
| `digest_weekday` | integer NOT NULL | `1` | `BETWEEN 0 AND 6` (0 = Sunday) |
| `digest_hour` | integer NOT NULL | `8` | `BETWEEN 0 AND 23` |
| `created_at`, `updated_at` | text NOT NULL | | |

`budget_threshold_pct` is capped at 99 on purpose: 100 is the *other* event, and letting a user set the "approaching" threshold to 100 would produce two identical-looking messages for the same fact.

**MUST-3.8** These are typed columns rather than a JSON blob because every one of them is read inside a query predicate or a loop condition, and because a `CHECK` is the cheapest possible defence against a stored `0` that would make the scheduler nag every tick. New knobs in later releases cost a migration; new **events** do not (MUST-3.6), and events are the thing that grows.

### 3.6 `notification_outbox` — the queue, and the dedup guard

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | delivery order |
| `user_id` | integer NOT NULL → `users(id)` ON DELETE CASCADE | |
| `channel` | text NOT NULL, `CHECK IN ('telegram','email')` | |
| `event_id` | text NOT NULL | registry key, for the deliveries list and per-event debugging |
| `dedup_key` | text NOT NULL | §3.9 |
| `subject` | text NOT NULL | rendered at **evaluation** time, not send time |
| `body` | text NOT NULL | ditto |
| `status` | text NOT NULL DEFAULT `'pending'`, `CHECK IN ('pending','sent','failed')` | |
| `attempts` | integer NOT NULL DEFAULT 0 | |
| `next_attempt_at` | text NOT NULL | ISO datetime; set to `created_at` on insert |
| `last_error` | text | scrubbed (§5.3) |
| `created_at` | text NOT NULL | |
| `sent_at` | text | |

**MUST-3.9 (the dedup mechanism).** `UNIQUE (user_id, channel, dedup_key)`. Every enqueue is

```sql
INSERT INTO notification_outbox (...) VALUES (...) ON CONFLICT DO NOTHING
```

and `changes === 0` means "already fired". There is **no separate dedup table and no separate dedup bookkeeping**: the row that was sent *is* the guard, so the guard cannot drift from reality, and a crash between "decide to send" and "record that we sent" is impossible because they are the same statement.

**MUST-3.10** Rows are retained after delivery. Status `sent` and `failed` rows are the "Recent deliveries" list (§11.5) and the dedup memory; they are pruned only by §3.10's sweep.

### 3.7 Dedup keys, per event type

**MUST-3.11** Every event's dedup key is one of these exact strings. `user_id` and `channel` are already part of the unique index and are never repeated inside the key.

| Event | Dedup key | Fires at most |
|---|---|---|
| `coming_due` | `due:<itemId>:<expiryDate>` | once per item per expiry date, **ever** |
| `budget_threshold` | `budget:<h\|p>:<categoryId>:<YYYY-MM>:<pct>` | once per scope/category/month/threshold |
| `budget_exceeded` | `budget:<h\|p>:<categoryId>:<YYYY-MM>:100` | once per scope/category/month |
| `backup_failed` | `backup-failed:<YYYY-MM-DD>` | once per calendar day |
| `weekly_digest` | `digest:<slotDateIso>` | once per weekly slot |
| `new_signin` | `signin:<session created_at ISO>` | once per session created |
| `restore_outcome` | `restore:<outcome.finishedAt>` | once per restore |
| `stale_import` | `stale:<mondayOfThisWeekIso>` | once per calendar week while stale |

`<h|p>` is `h` for a household budget and `p` for the recipient's personal budget — the same category can cross both numbers in the same month and they are two different facts.

**MUST-3.12 (the pruning-safety invariant).** Every key above is either (a) bounded to a calendar period that evaluation only ever looks at within the current few days, or (b) derived from a monotonically increasing timestamp that never recurs. Therefore pruning a row (§3.10) can never resurrect an already-delivered event. Worked through:

- `coming_due` — the window is `expiry_date BETWEEN today AND today + N`. Once `expiry_date` is in the past the item cannot re-enter the window, so the pruned key can never be regenerated. Editing an item's expiry date changes the key, which is correct: it is a new fact.
- `budget_*` — evaluation only ever reads `currentMonth()`. A month old enough to be pruned is a month evaluation no longer visits.
- `backup_failed`, `stale_import`, `weekly_digest` — the slot key advances every day or week and never repeats.
- `new_signin`, `restore_outcome` — timestamps.

`restore_outcome` needs one extra guard because `result.json` persists on disk across boots: see MUST-14.2's 24-hour age check.

### 3.8 Indexes and retention

**MUST-3.13** Beyond the primary keys and the two unique indexes above:

- `notification_outbox_due_idx ON notification_outbox(status, next_attempt_at)` — the sender's only query.
- `notification_outbox_user_idx ON notification_outbox(user_id, id)` — the "Recent deliveries" list.

`notification_prefs`'s composite PK already covers every `user_id`-prefixed lookup. `notification_targets` is at most `2 × users` rows and needs nothing beyond its unique index.

**MUST-3.14 (retention).** `runMaintenanceSweep()` in `src/lib/backup.ts` gains a sixth purge: delete `notification_outbox` rows with `status IN ('sent','failed')` and `created_at` older than `OUTBOX_RETENTION_DAYS = 90`, returned as `outboxRowsPurged` on `SweepResult`. Ninety days is comfortably longer than the longest-lived dedup key that could still matter (a monthly budget key, ~31 days) and short enough that the table stays trivial.

### 3.9 Drizzle mirror

**MUST-3.15** `src/db/schema.ts` gains `notificationSmtp`, `notificationTargets`, `notificationPrefs`, `notificationUserSettings`, `notificationOutbox`, in that order, each with a docblock naming the SQL-only objects it cannot express (every `CHECK`, and `notification_prefs`'s `WITHOUT ROWID` storage class). Column order in the mirror matches the DDL so it stays readable against `pragma table_info(...)`, per the existing convention.

### 3.10 `drizzle/0006_notifications.sql` — exact SQL

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

---

## 4. The event registry

### 4.1 Shape

```ts
// src/lib/notify/events.ts — PURE (MUST-2.1)
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

export const NOTIFICATION_EVENTS: readonly NotificationEventDef[] = [ /* §4.2 */ ];

export function eventDef(id: string): NotificationEventDef | undefined;
export function isNotificationEventId(value: string): boolean;
export function eventsFor(role: 'admin' | 'member'): readonly NotificationEventDef[];
```

### 4.2 The eight launch events

| `id` | Label | Audience | Trigger | Default |
|---|---|---|---|---|
| `coming_due` | Something is coming due | all | `daily_slot` | **on** |
| `budget_threshold` | A budget is getting close | all | `tick` | off |
| `budget_exceeded` | A budget is blown | all | `tick` | **on** |
| `backup_failed` | The nightly backup failed | admin | `immediate` | **on** |
| `weekly_digest` | Weekly spending summary | all | `weekly_slot` | off |
| `new_signin` | New sign-in to your account | all | `immediate` | **on** |
| `restore_outcome` | A restore finished | admin | `immediate` | **on** |
| `stale_import` | Nothing has been imported lately | all | `daily_slot` | off |

**MUST-4.1** The defaults split on one line: **on** for "something is wrong, or a deadline is near"; **off** for the chattier informational events a person should opt into. `new_signin` is on by default because it is a security event and a security event nobody switched on protects nobody.

**MUST-4.2** A default of `on` has effect only once a channel exists. A user with no `notification_targets` row receives nothing, defaults notwithstanding (MUST-1.1).

**MUST-4.3** `audience: 'admin'` events are never enqueued for a member, are never rendered in a member's matrix, and are skipped for a user who has since been demoted from admin.

**MUST-4.4 (extension point).** Adding an event type is: append one entry to `NOTIFICATION_EVENTS`, add one `case` to `renderEvent()` (§10), and — for a scheduled event — one evaluator call. **No migration. No `src/db/schema.ts` change. No UI change** (the matrix is generated from the registry). The next release's predictive events (`on_pace_overshoot`, `unusual_transaction`, `price_creep`, `duplicate_charge`) land exactly this way, and a test asserts the matrix renders an unknown-to-the-test registry entry (MUST-17.4).

**MUST-4.5** An `id` is permanent once shipped. Renaming one silently resets every user's stored preference for it, because `notification_prefs` keys on the string.

### 4.3 Effective toggle resolution

```ts
function isEventEnabled(userId: number, eventId: string, channel: Channel): boolean
```
= `prefRow?.enabled ?? eventDef(eventId).defaultEnabled`, **and** the user is active, **and** the user's role satisfies `audience`, **and** an enabled `notification_targets` row exists for `(userId, channel)`, **and** for `channel = 'email'` an enabled `notification_smtp` row exists. All five conditions, in that order, in one function — no caller re-implements any part of it.

---

## 5. Secrets at rest

### 5.1 Construction

**MUST-5.1** `src/lib/notify/crypto.ts` uses the **same** construction and framing as `src/lib/auth/totp.ts` and `src/lib/simplefin/crypto.ts`: AES-256-GCM under `hkdfSync('sha256', SECRET_KEY, <empty salt>, <info>, 32)`, stored as `base64(iv ‖ tag ‖ ciphertext)` with a 12-byte IV and a 16-byte tag, in a single TEXT column. A payload of length ≤ 28 bytes is rejected as malformed before any decrypt is attempted.

**MUST-5.2** Two distinct info strings, so the two credential classes have independent key streams and neither is interchangeable with TOTP secrets or the SimpleFIN access URL:

```ts
export const SMTP_HKDF_INFO = 'notify-smtp-v1';
export const TELEGRAM_HKDF_INFO = 'notify-telegram-v1';
```

```ts
export function encryptSecret(plain: string, info: string, secretKey?: string): string;
export function decryptSecret(payload: string, info: string, secretKey?: string): string;
```

### 5.2 Never leaves the server

**MUST-5.3** No page prop, server-action return value, log line, or error message ever carries a plaintext SMTP password or bot token. The page receives `passwordSet: boolean` / `tokenSet: boolean`, never the value. The Telegram **chat id** *is* returned to the browser — the user typed it, it is not a credential, and they need to see it to check it.

**MUST-5.4** A decrypt failure (the shape a rotated `SECRET_KEY` produces) is caught and converted into the target/relay error `Stored credential could not be read. Re-enter it.` It is never a 500, and the underlying error is logged without the payload — the same handling `attemptLogin` gives a TOTP decrypt failure.

### 5.3 Scrubbing — mandatory, not defensive

**MUST-5.5** `scrubSecrets(text: string, secrets: string[]): string` replaces every occurrence of every non-empty secret with `[redacted]`, and is applied to **every** string written to `last_error`, to `console.error`, or returned to the browser from a send path.

This is load-bearing rather than belt-and-braces for two concrete reasons:

- the Telegram bot token is **in the request URL path** (`/bot<token>/sendMessage`), so any `fetch` error, redirect message, or stack frame that echoes the URL echoes the credential;
- nodemailer's authentication errors routinely quote the failing SMTP command line, which on some relays includes the base64-encoded `AUTH PLAIN` payload.

`scrubSecrets` therefore also redacts the base64 of `\0username\0password`, not only the raw password.

### 5.4 UI masking and rotation

**MUST-5.6** After a save, the password / token field renders empty with the placeholder `•••••••• (saved)`. Submitting the form with that field blank **keeps** the stored value when a row already exists, and is a validation error when creating one. There is no "reveal" affordance.

**MUST-5.7** `README.md` and `INSTALL.md`'s `SECRET_KEY` loss/rotation consequence list gains a third entry alongside TOTP enrollments and the SimpleFIN access URL: *the SMTP password and every Telegram bot token become unreadable and must be re-entered; nothing else is affected and no notification is lost, because the outbox rows themselves are plaintext.*

**MUST-5.8 (backups).** These credentials live in the database and are therefore inside the **unencrypted** backup archive, exactly as the SimpleFIN access URL and the TOTP secrets are (§12 threat model, warranty MUST-13.9). The Notifications page says so in one sentence, and `INSTALL.md`'s Hyper Backup client-side-encryption guidance is extended to name them. Restoring a backup taken before v1.3.0 leaves the five tables empty and the feature dormant — migrations run on boot and create them (warranty MUST-20.24).

---

## 6. Scheduler, slots and evaluation

### 6.1 The tick

**MUST-6.1** `src/lib/scheduler.ts` gains, alongside `NIGHTLY_CRON` and `OCR_SWEEP_CRON`:

```ts
export const NOTIFY_TICK_CRON = '*/5 * * * *';
```

registered with the same `{ timezone: tz }` as the existing tasks, stopped by `stopScheduler()`, and — like `runOcrSweep()` — **run once immediately at boot** so a container that was off through a slot catches up in seconds rather than in up to five minutes.

**MUST-6.2** Five minutes is the retry and catch-up granularity, not the latency floor. Immediate events (§6.6) insert their outbox row and kick the sender pump synchronously, so a sign-in alert leaves the box in seconds. The tick is the safety net: it recovers rows a crash left `pending`, applies backoff, and runs scheduled evaluation. This is exactly the OCR sweep's role for `warranty_receipts`.

**MUST-6.3 (single-flight).** One module-level `let ticking = false` guards evaluation, and the sender uses the `pump: Promise<void> | null` pattern of `src/lib/warranty/ocr/queue.ts` verbatim, including the invariant that **no `await` occurs between the queue-empty check and `pump = null`**. A tick that arrives while the previous one is still draining returns immediately. Justified by §2's single-container deployment; a multi-replica deployment is out of scope and would need a DB-level claim (§20 R4).

**MUST-6.4 (the dormancy bail, first statement in the tick).**

```ts
if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;
```

Two indexed reads against tables that are empty on a dormant install. Nothing below this line executes, so no evaluator runs, no renderer runs, and no transport module is even reached.

### 6.2 What is evaluated when

| Event | Trigger | Notes |
|---|---|---|
| `coming_due` | per-user daily slot | one outbox row per item (§6.4) |
| `budget_threshold` / `budget_exceeded` | every tick, fingerprint-guarded (§6.5) | so an afternoon import is reported in minutes, not tomorrow morning |
| `weekly_digest` | per-user weekly slot | |
| `stale_import` | per-user daily slot | |
| `backup_failed`, `new_signin`, `restore_outcome` | immediate (§6.6) | not evaluated by the tick at all |

### 6.3 Slot arithmetic and catch-up

**MUST-6.5** Slot arithmetic is **pure integer arithmetic on local wall-clock components** — never `Date` addition. Two new helpers in `src/lib/dates.ts` (which is isomorphic and TZ-aware already, and must stay free of node builtins):

```ts
export function localHour(now: Date, tz?: string): number;      // 0..23, Intl hourCycle 'h23'
export function localWeekday(now: Date, tz?: string): number;   // 0 = Sunday .. 6 = Saturday
```

**MUST-6.6** For a **daily** slot at hour `H`:

```
d          = localHour >= H ? 0 : 1
slotDate   = addDaysIso(todayIso(now, tz), -d)
hoursSince = d * 24 + (localHour - H)
```

For a **weekly** slot on weekday `W` at hour `H`:

```
d          = (localWeekday - W + 7) % 7
if (d === 0 && localHour < H) d = 7
slotDate   = addDaysIso(todayIso(now, tz), -d)
hoursSince = d * 24 + (localHour - H)
```

Both use `addDaysIso` from `src/lib/dates.ts`, which is already pure string math.

**MUST-6.7 (catch-up — the container was off at 08:00).** The slot fires if and only if `hoursSince <= MAX_CATCHUP_HOURS` for its kind:

```ts
export const DAILY_MAX_CATCHUP_HOURS = 12;
export const WEEKLY_MAX_CATCHUP_HOURS = 48;
```

So a container booting at 09:30 after missing its 08:00 slot **does** fire (1.5 h late). A container booting at 23:00 the following day does **not** — a "coming due" notice delivered 39 hours late, immediately ahead of the next day's, is noise. A skipped slot logs one line: `[notify] slot 2026-08-16 for user 3 skipped (39h stale)`. The weekly window is longer because a Monday-evening reboot would otherwise lose an entire week's digest.

**MUST-6.8** `hoursSince` is wall-clock hours, so on a DST transition day it is off by one. This is deliberate: being an hour out on a 12-hour window changes nothing, and the alternative — real instant arithmetic across a zone transition — is the class of bug this repo has consistently designed out (see `addMonthsClamped`, `parseDateString`).

**MUST-6.9** Firing a slot twice is harmless by construction: every scheduled event's dedup key either contains the slot date or is per-item, so a second evaluation of the same slot inserts nothing (MUST-3.9).

### 6.4 `coming_due`

**MUST-6.10** At the user's daily slot, select `warranty_items` where `is_lifetime = 0`, `expiry_date IS NOT NULL`, and `expiry_date BETWEEN todayIso AND addDaysIso(todayIso, coming_due_days)`.

**MUST-6.11 (scope).** A user is notified about items where `owner_user_id = <that user>`. `warranty_items.owner_user_id` is `NOT NULL` and defaults to the creator, so every item notifies exactly one person and nothing is orphaned. The household-visibility model (§6 roles) is about *reading* the app; broadcasting every member's expiring items to everybody is nagging, not visibility.

**MUST-6.12** One outbox row **per item**, key `due:<itemId>:<expiryDate>` — so an item is announced once and then never again, rather than nagging daily for the whole N-day window. This is the dedup shape the owner specified ("item + date window").

**MUST-6.13 (flood guard).** A single evaluation creates at most `MAX_NEW_ROWS_PER_USER_PER_EVALUATION = 20` new outbox rows for one user. Anything over the cap is simply not enqueued; the items are still inside the window tomorrow and are picked up at the next slot. This bounds the first-run backfill when someone with a large library configures a channel for the first time.

**MUST-6.14** Wording comes from `expiryPhraseForKind()` / `ITEM_KIND_LABELS` in `src/lib/warranty/constants.ts`, resolved through the item's `type_id → warranty_item_types.kind`. A loan says "paid off by", a subscription says "cancel by", a contract says "ends on" — MUST-19.11's "one place any of the four verbs is written" continues to bind, and notifications are not allowed to become a second place.

### 6.5 `budget_threshold` / `budget_exceeded`

**MUST-6.15** Evaluated on every tick, for the current month only (`currentMonth()`), over:

- **household** scope — `budgetProgress(month, 'household', null)`, delivered to every user with the event enabled;
- **personal** scope — `budgetProgress(month, 'personal', userId)`, delivered only to that user.

Only rows with a resolved `limitCents !== null` participate. Parents and children are independent rows (`budgetProgress` already applies the §3 rollup rule to the parent's `spentCents`), so a parent and one of its children may each cross and each gets its own message.

**MUST-6.16** `budget_exceeded` fires when `spentCents > limitCents`. `budget_threshold` fires when `pct >= budget_threshold_pct` and `pct < 100`. Both use the `pct` already computed by `budgetProgress()` — including its `$0`-limit branch — so the notification can never disagree with the progress bar the user is looking at.

**MUST-6.17** Both may fire in the same evaluation, in the rare case of a single import taking a category from under the threshold to over 100%. Two messages there is informative, and suppression logic would have to fabricate a dedup row for a message it never sent.

**MUST-6.18 (the fingerprint guard).** Before doing any of the above, `evaluate/budget.ts` computes

```sql
SELECT count(*) AS n, coalesce(max(id), 0) AS maxId, coalesce(max(updated_at), '') AS maxUpdated
  FROM transactions WHERE date BETWEEN <monthStart> AND <monthEnd>
```

(one query, served by the existing `transactions(date)` index) and combines it with the sorted list of participating user ids and their configured thresholds into a single string. If that string equals the module-level `lastBudgetKey` from the previous tick, budget evaluation is skipped entirely. `max(updated_at)` is in the fingerprint so that re-categorising an existing transaction — which changes neither the count nor the max id — still triggers re-evaluation. The participant/threshold part is in it so that a user who has just enabled the event or moved their threshold is evaluated on the very next tick. A restart clears the cache and costs exactly one extra evaluation, which is dedup-safe.

### 6.6 Immediate events

**MUST-6.19** `src/lib/notify/raise.ts` exports three functions. Each **must never throw** into its caller and each is wrapped internally in `try/catch` — a notification failure may not break a login, a boot, or a backup.

```ts
export function raiseNewSignin(input: { userId: number; at: Date; ip: string; userAgent: string | null; sessionCreatedAt: string }): void;
export function raiseBackupFailed(input: { error: unknown; at: Date }): void;
export function raiseRestoreOutcome(now?: Date): void;
```

Each enqueues (§7.1) and then kicks the sender pump without awaiting it.

---

## 7. Outbox and delivery

### 7.1 Enqueue

```ts
// src/lib/notify/outbox.ts
export function enqueue(input: {
  userId: number;
  eventId: string;
  dedupKey: string;
  subject: string;
  body: string;
  at?: Date;
}): { inserted: Channel[] };
```

**MUST-7.1** `enqueue()` resolves the user's enabled channels for that event via `isEventEnabled()` (§4.3) and inserts **one row per channel**, each with `ON CONFLICT DO NOTHING`, `attempts = 0`, `next_attempt_at = created_at`. Enqueueing is the only place channel fan-out happens, so per-channel isolation is structural: two rows, two independent lifecycles.

**MUST-7.2** Subject and body are rendered **at enqueue time**, not at send time. A message describes the world as it was when the event happened; re-rendering at send time after three retries would produce a "budget at 82%" alert that says 91%.

### 7.2 The pump

```ts
export async function pumpOutbox(now?: Date): Promise<{ sent: number; failed: number; deferred: number }>;
```

**MUST-7.3** Selects `status = 'pending' AND next_attempt_at <= now` ordered by `id`, limited to `OUTBOX_BATCH = 50` (served by `notification_outbox_due_idx`), and drains it **grouped by channel, each group inside its own `try/catch`**. A Telegram group that throws at the transport level cannot touch a single email row, and vice versa. Rows within a group are sent sequentially — household volume is a handful of messages a day and concurrency buys nothing but interleaved failure modes.

**MUST-7.4 (per-channel circuit break within a batch).** The first *transient* transport failure in a channel group defers every remaining row of that group to the same `next_attempt_at` without attempting them. Otherwise a dead relay costs `50 × 15 s` of connect timeouts inside one tick, and the tick would still be running when the next one fires.

**MUST-7.5 (pre-send revalidation).** Immediately before sending, the pump re-reads the row's target. If the target is gone, disabled, or (for email) the relay row is gone or disabled, the row is marked `failed` with `Channel was removed before delivery.` and **nothing is sent**. Removing a channel therefore stops egress at once, including for already-queued rows — the dormancy rule (MUST-1.1) holds even with a full outbox.

### 7.3 Retry and backoff

**MUST-7.6** On a transient failure: `attempts += 1`, `last_error = scrubSecrets(message)`, and

```
next_attempt_at = now + min(2 ** attempts * 60_000, 6h)
```

→ 1 m, 2 m, 4 m, 8 m, 16 m, 32 m, 64 m, 128 m. At `attempts >= MAX_ATTEMPTS = 8` the row becomes `status = 'failed'`. Total lifetime ≈ 4.2 hours, which comfortably outlives an SMTP relay's rate-limit window or a router reboot without letting a genuinely broken configuration retry forever.

**MUST-7.7** A **permanent** failure (`NotifyError.permanent === true`) skips backoff entirely and marks the row `failed` on the first attempt. Permanent means the request will never succeed unchanged: HTTP 400/401/403/404 from Telegram (bad token, bad chat id, bot blocked or deleted), and an SMTP 5xx (`nodemailer` `responseCode >= 500`) such as authentication failure or an invalid recipient. HTTP 429 and 5xx, DNS failures, connect timeouts, and SMTP 4xx are transient. A Telegram 429 body's `parameters.retry_after` seconds, when present, overrides the computed backoff.

**MUST-7.8 (boot expiry).** On the first tick after boot, every `pending` row with `created_at` older than `PENDING_MAX_AGE_HOURS = 24` is marked `failed` with `Not delivered within 24 hours.` This covers a container that was off for a week and, importantly, a **restored older database** whose outbox still contains rows that were pending when the backup was taken — without it, a restore would emit a flood of stale alerts about a world that no longer exists.

**MUST-7.9 (delivery guarantee, stated honestly).** Delivery is **at-least-once**. A crash between a successful send and the `status = 'sent'` write re-delivers that one message on the next tick. This is the correct trade for alerts: a duplicate "your backup failed" is a nuisance, a dropped one is the failure mode the feature exists to prevent.

### 7.4 Failure surfacing

**MUST-7.10** Every send outcome updates the relevant target row (`notification_targets` for Telegram and for the per-user email address; `notification_smtp` for relay-level SMTP failures): success clears `last_error` and sets `last_success_at`; failure sets `last_error` (scrubbed) and `last_error_at`. Settings renders these (§11.4), so "email stopped working three weeks ago" is visible on the page rather than only in `docker logs`.

**MUST-7.11** The pump logs one summary line per non-empty run — `[notify] sent 3, failed 0, deferred 2` — and one `console.error` per permanent failure. It never logs a subject or body (they contain amounts and merchant names) and never logs a credential.

---

## 8. Channels

### 8.1 Telegram

**MUST-8.1** `POST https://api.telegram.org/bot<token>/sendMessage`, raw `fetch`, `Content-Type: application/json`, body `{ chat_id, text, disable_web_page_preview: true }`, `signal: AbortSignal.timeout(15_000)`. No SDK, no new dependency.

**MUST-8.2** **No `parse_mode`.** Messages are plain text, so a merchant name, an OCR-derived warranty title, or a user-supplied display description can never be interpreted as markup or a link. This is the Telegram-side counterpart of warranty MUST-13.3 (OCR text is untrusted input), and it is why §10 renders one plain-text body for both channels.

**MUST-8.3** `text` is truncated to `TELEGRAM_MAX_CHARS = 4000` (the API limit is 4096) with a trailing `…` — a truncated digest is better than a rejected one.

**MUST-8.4** A non-2xx response is parsed for `{ description }` and surfaced verbatim as the error text; Telegram's descriptions ("chat not found", "bot was blocked by the user", "Unauthorized") are exactly what the user needs to see in Settings.

The step-by-step setup copy for this channel is specified in **§11.7.1** and is rendered inside the page.

### 8.2 The "Detect chat ID" helper

Asking a family member to open a raw JSON URL and find `message.chat.id` is the single worst step in Telegram setup, so the app does it for them.

**MUST-8.5** `src/lib/notify/send/telegram.ts` exports a second function:

```ts
export interface TelegramChat {
  chatId: string;      // as a string — Telegram ids exceed Number.MAX_SAFE_INTEGER territory in supergroups
  title: string;       // "Sam Grewal" or "Grewal Family" — from first_name/last_name/title/username
  kind: 'private' | 'group' | 'supergroup' | 'channel';
  lastMessageAt: string | null; // ISO datetime, from the update's date
}

export function fetchTelegramChats(botToken: string): Promise<TelegramChat[]>;
```

**MUST-8.6** It calls `GET https://api.telegram.org/bot<token>/getUpdates?limit=100&allowed_updates=["message"]`, with the same `assertTelegramUrl()` guard, the same `redirect: 'error'`, and the same 15 s abort as `sendMessage`. This is the **second and last** Telegram endpoint the app may ever call (§9.1); the destination host is unchanged, so the two-destination promise is unchanged.

**MUST-8.7** It **must not** consume the update queue. The call passes no `offset`, so Telegram leaves the updates in place and the helper can be pressed repeatedly. (Passing an `offset` would acknowledge the updates and make the second press return nothing — the exact confusing failure the helper exists to prevent.)

**MUST-8.8 (dedupe and shape).** Updates are reduced to a **unique set of chats** keyed by `chat.id`, keeping the most recent `date` per chat, sorted newest first, capped at `MAX_DETECTED_CHATS = 20`. `title` is derived as `chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || chat.id` and is **untrusted display text** — truncated to 80 characters and rendered as a text node, never markup (MUST-10.3 applies here too, because a person can name a Telegram group anything at all).

**MUST-8.9 (no token to the client).** The helper is a server action that reads the caller's **own** saved, encrypted token from `notification_targets` and decrypts it server-side. The token is **never** a parameter, never in the response, and never in an error message (`scrubSecrets`, MUST-5.5). A user can therefore only ever detect chats for their own bot; there is no code path by which one member's action reaches another member's token, because the action takes no arguments at all (MUST-12.4).

**MUST-8.10 (error copy).** Three outcomes, each with fixed wording:

- empty list → `No messages yet. Open Telegram, find your bot, send it any message, then press this again.`
- HTTP 401 → `That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.`
- anything else → Telegram's own `description`, prefixed `Telegram said: `.

**MUST-8.11** Pressing it before a token is saved is refused with `Save your bot token first.` — the button is disabled in that state anyway, but the action does not rely on the UI for that.

### 8.3 Email (SMTP)

**MUST-8.12** `nodemailer`. `createTransport({ host, port, secure, requireTLS, auth, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000, tls: { minVersion: 'TLSv1.2' } })` where `secure = (security === 'tls')` and `requireTLS = (security === 'starttls')`.

**MUST-8.13** `pool: false`, and the transport is created per pump-batch and closed after it. A household sends a handful of messages a day; a pooled connection to a third-party relay would spend its life idle-timing-out and reconnecting.

**MUST-8.14** `sendMail({ from: '"<from_name>" <from_email>', to: destination, subject, text })`. **`text` only — no `html`.** Same untrusted-input reasoning as MUST-8.2, and it removes the entire HTML-email test surface.

**MUST-8.15 (presets).** The picker prefills host / port / security and swaps the guide panel (§11.7.2). Every field stays editable afterwards; `preset` is stored so the right guide is shown and never changes connection behaviour.

| Preset | Host | Port | Security |
|---|---|---|---|
| **Brevo** | `smtp-relay.brevo.com` | 587 | STARTTLS |
| **SMTP2GO** | `mail.smtp2go.com` | 587 | STARTTLS |
| **Gmail** | `smtp.gmail.com` | 465 | TLS |
| **Custom SMTP** | *(blank)* | 587 | STARTTLS |

**MUST-8.16** `security = 'none'` is accepted only when `preset = 'custom'`, enforced by a server-side zod `.refine()`, and the form shows: *"Credentials and message contents will cross the network unencrypted. Only use this for a relay on your own LAN."*

**MUST-8.17** Saving the relay does **not** connect. Verification is the explicit **Send test email** button, which is the one place `transporter.sendMail` is called outside the pump. `transporter.verify()` is not used — a relay that accepts a connection but rejects the send is a false green light.

---

## 9. Egress policy

**MUST-9.1** Exactly two destinations are permitted, and only once configured:

1. `https://api.telegram.org` — literal origin, hard-coded. Exactly two endpoints on it: `sendMessage` (MUST-8.1) and `getUpdates` (MUST-8.6).
2. the SMTP `host`:`port` an admin entered.

**MUST-9.1a** Every external URL that appears in the setup guides of §11.7 — `telegram.org`, `brevo.com`, `smtp2go.com`, `myaccount.google.com` and the rest — is **text on the page**. Nothing in the app resolves, fetches, embeds, previews, or link-checks any of them. They are instructions for a person holding a browser, not addresses the server knows how to use.

**MUST-9.2** `src/lib/notify/egress.ts`:

```ts
export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
export function assertTelegramUrl(url: string): void; // throws unless new URL(url).origin === TELEGRAM_API_ORIGIN
```

`send/telegram.ts` calls `assertTelegramUrl()` on the URL it is about to fetch, immediately before the `fetch`. The bot token is interpolated into the **path**, so this guard also catches a malformed token that manages to inject a host.

**MUST-9.3** No redirect following: `fetch(..., { redirect: 'error' })`. A 3xx from `api.telegram.org` is a failure, not a hop to somewhere else.

**MUST-9.4** `tests/ops/notify-egress.test.ts` reads every file under `src/lib/notify/` and asserts: the only `fetch(` call sites are the two in `send/telegram.ts`; the only URL literal containing `://` anywhere in the tree is `TELEGRAM_API_ORIGIN` in `egress.ts`; and no file imports an HTTP client library. The same test reads `src/app/(app)/settings/notifications/` and asserts it contains **no** `fetch(` call and no `://` literal outside plain guide copy inside JSX text (MUST-9.1a). This is a source-level invariant test in the style of `tests/ops/restore-seams.test.ts`, and it is what stops a future "just fetch the exchange rate while we're here" from landing quietly.

**MUST-9.5** §2's "no runtime network calls" line in the master spec gains a second opt-in exception alongside SimpleFIN, worded the same way: dormant until configured, two destinations, both chosen by the user.

---

## 10. Message rendering

**MUST-10.1** `src/lib/notify/render.ts` exports one channel-agnostic function:

```ts
export function renderEvent(input: RenderInput): { subject: string; body: string };
```

Telegram sends `subject + '\n\n' + body`; email sends `subject` as the Subject header and `body` as the text part. One renderer, two envelopes — the two channels can never drift apart in wording, and every message is testable as a pure function.

**MUST-10.2** Money is formatted with `formatCents()` from `src/lib/money.ts`. Dates are ISO `YYYY-MM-DD`. Months are rendered with `monthLabel()` from `src/lib/dates.ts`.

**MUST-10.3** Every value interpolated from user or import data (merchant names, item names, category names, user agents) is treated as untrusted text: plain, never markup, and truncated — item/merchant/category names to 80 characters, user agents to 120.

### 10.1 Subjects and bodies

| Event | Subject | Body |
|---|---|---|
| `coming_due` | `Coming due: <item name>` | `<Kind label> "<name>" <verb> <date> (in N days).` plus vendor and price when set. Verb from `expiryPhraseForKind()`. |
| `budget_threshold` | `Budget <pct>%: <category> (<Month Year>)` | `<Household\|Your> <category> budget for <Month Year> is at <pct>% — <spent> of <limit>, <remaining> left.` |
| `budget_exceeded` | `Over budget: <category> (<Month Year>)` | `<Household\|Your> <category> budget for <Month Year> is blown — <spent> of <limit>, <over> over.` |
| `backup_failed` | `Nightly backup failed` | The date, the scrubbed error message, and: `The maintenance sweep still ran. Check Settings → Backups.` |
| `weekly_digest` | `Weekly summary — <from> to <to>` | §10.2 |
| `new_signin` | `New sign-in to your account` | `<name> signed in at <YYYY-MM-DD HH:mm> (<TZ>) from <ip>.` plus the truncated user agent, and `If this was not you, change your password in Settings.` |
| `restore_outcome` | `Restore succeeded` / `Restore FAILED` | Source name, who requested it, when it finished, receipts restored / missing counts, and the error on failure — read from `RestoreOutcome`. |
| `stale_import` | `No transactions imported in <N> weeks` | `The last import was <date> (<N> days ago). Bank exports are how this app learns what you spent.` |

### 10.2 Weekly digest body

Covers the **7 days ending the day before the slot date** — `from = addDaysIso(slotDate, -7)`, `to = addDaysIso(slotDate, -1)`. A fixed 7-day trailing window rather than a fixed Monday–Sunday week, so any chosen `digest_weekday` yields a complete week with no stale tail.

Composed from existing helpers only — `categoryBreakdown()` and `topMerchants()` in `src/lib/reports.ts`, `budgetProgress()` in `src/lib/budgets.ts`, `listReviewQueue()` in `src/lib/transactions.ts`:

```
Household spend: $1,284.55
Your spend:      $412.30

Top categories (household)
  Groceries     $402.11
  Restaurants   $188.40
  Gas           $121.00

Top merchants (household)
  LOBLAWS       $210.55
  PETRO-CANADA  $121.00

12 transactions still need review.
Over budget this month: Restaurants, Coffee.
```

Top 5 categories, top 3 merchants. Transfers and income are excluded by the existing report helpers. A week with no transactions renders `No transactions were recorded this week.` and still sends — silence would be indistinguishable from a broken channel.

**MUST-10.4 (no URLs).** No notification body contains a link. The server has no reliable idea of the URL the family uses (LAN IP, reverse-proxy hostname, Tailscale name — all different, none knowable from inside the container), and a wrong link is worse than no link. An optional `APP_BASE_URL` env var that would enable deep links is deferred (§21).

---

## 11. UI

`/settings/notifications`, reachable by **every** user. All existing primitives: `PageHeader`, `Card`/`CardHeader`/`CardBody`, `Notice`, `TableWrap`, `Field` and the `field-control` / `field-label` / `field-hint` classes from `src/components/ui/form.tsx`, `SubmitButton`, `btn btn--primary|--secondary|--danger`, and the `text-ink` / `text-muted` / `text-subtle` / `bg-*-soft` tokens. **No new CSS, no new design token, no new colour.**

### 11.1 Entry point

**MUST-11.1** `src/app/(app)/settings/page.tsx` gains a card **in the personal area** (after the Sessions card, before the admin grid), linking to `/settings/notifications`: *"Notifications — where the app messages you, and about what."* It is **not** added to `ADMIN_LINKS`; every member configures their own channels. One new `BellIcon` in `src/components/icons.tsx`.

### 11.2 Page structure

1. `PageHeader` — **Notifications** / *"Nothing is sent anywhere until you set up a channel below."*
2. **Status banner.** Dormant: `Notice` tone `info` — *"Notifications are off. This app makes no outbound connection until you configure a channel here."* Configured but with a live `last_error`: tone `error`, naming the channel and the error.
3. **Outbound email (SMTP)** — admins only (§11.3).
4. **Your channels** — everyone (§11.4).
5. **What you get told about** — the matrix and knobs (§11.5).
6. **Recent deliveries** (§11.6).

### 11.3 Outbound email — admin section

Rendered only when `user.role === 'admin'`. Preset `<select>` (Brevo / SMTP2GO / Gmail / Custom SMTP) whose change handler prefills host, port and security and swaps the guide panel (§11.7.2); then host, port, security `<select>`, username, password (masked per MUST-5.6), From address, From name. Buttons: **Save**, **Send test email**, **Remove SMTP settings** (`btn--danger`, with a confirmation step). Below: `last_success_at`, and `last_error` + `last_error_at` in a `Notice` tone `error` when set.

Members see none of this. Where a member's email channel is unusable for want of a relay, their email row shows: *"An admin needs to set up outbound email before this can send."*

### 11.4 Your channels

Two sub-cards.

**Telegram** — bot token (masked after save), chat ID, an enabled checkbox, **Send test message**, **Remove**, the guide panel of §11.7.1, and the **Detect chat ID** control:

**MUST-11.2 (Detect chat ID control).** A `btn--secondary` labelled **Detect chat ID**, sitting immediately beside the Chat ID field. It is disabled with the hint *"Save your bot token first"* until a token is stored. Pressing it calls `detectTelegramChatIdAction()` and renders one of three states:

- **chats found** — a radio list, one row per chat: the chat title, its kind (*Private chat* / *Group* / *Channel*), and *"last message <relative time>"*. Choosing one fills the Chat ID field; the raw id is shown in small `text-subtle` text beside each title so a person who *does* know their id can confirm it. Nothing is saved until the user presses Save.
- **nothing found** — a `Notice` tone `info` carrying MUST-8.10's exact sentence.
- **error** — a `Notice` tone `error` carrying MUST-8.10's exact wording for that case.

**Email** — destination address, enabled checkbox, **Send test email**, **Remove**. When no relay is configured, the "An admin needs to set up outbound email before this can send." sentence of §11.3 replaces the buttons.

Each sub-card shows its own `last_error` / `last_success_at`, and a saved-but-never-tested channel shows an *Unverified* badge until `verified_at` is set by a successful test.

### 11.5 What you get told about

**MUST-11.3** The matrix is **generated from `NOTIFICATION_EVENTS`**, filtered by `eventsFor(user.role)`. Rows are Event (label + blurb) × columns Telegram / Email, each a checkbox whose initial state is the effective value (MUST-3.7). A column for a channel the user has not configured renders disabled with the tooltip *"Set up this channel first."* No event is named in JSX anywhere; adding a registry entry adds a row with no UI work (MUST-4.4).

Below the matrix, the five knobs of §3.5 as labelled number/select inputs with their defaults visible in the hint text, then one **Save** covering both matrix and knobs in a single action.

**MUST-11.4** One sentence, always visible, under the matrix: *"Messages contain amounts, category names and merchant names, and are delivered by Telegram or by your email provider."* This feature is the first thing in the app that sends household financial detail off the LAN and the page has to say so plainly.

### 11.6 Recent deliveries

Last 20 `notification_outbox` rows for the current user (admins get a household-wide view with a name column), served by `notification_outbox_user_idx`: when, event label, channel, status badge, and the scrubbed `last_error` on failures. Read-only, no retry button — the pump owns retries, and a manual retry would need its own rate limit for no real benefit.

### 11.7 Built-in setup guides — exact copy

**MUST-11.5** Each configuration form carries a collapsible panel — a `<details>` with the summary **"How do I set this up?"** — holding a complete, ordered walkthrough. The guides are written for a family member who has never heard of SMTP: no jargon, no "simply", no assumed prior step, every button and page named exactly as the provider names it. Nobody should have to leave this page and go searching to finish setup.

**MUST-11.6** The copy below is **shipped verbatim**. It is content, not placeholder text. It lives in one module — `src/app/(app)/settings/notifications/guides.tsx` (**new**) — as plain JSX, so it is reviewable as prose and testable by string match. External addresses are plain text (MUST-9.1a); render them as text, not as `<a href>`, so nothing in the page can be made to fetch them and so the copy reads the same in an email-to-yourself or a screenshot.

**MUST-11.7** The Telegram panel is open by default until a token has been saved, and collapsed afterwards. The email panel follows the selected preset: changing the preset swaps the guide immediately, and only one preset's guide is ever rendered.

**MUST-11.8** Every guide ends with the same closing line, and the phrase **Send test** in it matches the button's label exactly.

#### 11.7.1 Telegram — "How do I set this up?"

> **Getting your bot token**
>
> 1. Open Telegram on your phone or computer.
> 2. In the search box at the top, type **BotFather** and open the account called **@BotFather**. It has a blue checkmark.
> 3. Press **Start**, then send the message `/newbot`.
> 4. BotFather asks for a name. Type anything you like — for example `Home Budget`. This is just the name that shows up on the messages.
> 5. BotFather then asks for a username. It has to be unused and it has to end in the word `bot` — for example `grewal_home_budget_bot`. If it says the name is taken, try another one.
> 6. BotFather replies with a message containing your token. It looks like this:
>    `123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx`
> 7. Copy that whole line — every character, including the numbers before the colon — and paste it into **Bot token** on this page. Then press **Save**.
>
> **Getting your Chat ID**
>
> A Telegram bot is not allowed to message you until you have messaged it first. That is a Telegram rule, not something this app can skip.
>
> 8. Back in Telegram, search for the username you chose in step 5 and open the chat with your new bot.
> 9. Press **Start**, or just send it the word `hello`. Anything will do.
> 10. Come back to this page and press **Detect chat ID**. The app asks Telegram which conversations your bot has received messages in, and lists them here.
> 11. Pick yourself from the list. If you set the bot up for a family group chat instead, add the bot to that group, send one message there, and press **Detect chat ID** again — the group will appear in the list too.
> 12. Press **Save**.
>
> If the list comes back empty, it almost always means step 9 did not go through. Send your bot another message and press **Detect chat ID** again.
>
> **About the token**
>
> Anyone who has your bot token can send messages as your bot, so treat it like a password. It is stored encrypted on this server, it is never shown again after you save it, and it never leaves this server.
>
> **Last step:** press **Send test message**. If it arrives in Telegram, you are done. Do not rely on notifications until you have seen a test arrive.

#### 11.7.2 Email — one guide per preset

Rendered under the preset picker; only the selected preset's guide appears.

**Brevo**

> Brevo sends the email for you. The free plan is enough for a household — around **300 emails a day**.
>
> 1. Go to **brevo.com** in your browser and create a free account, or sign in if you already have one.
> 2. Once you are signed in, click your account name in the top-right corner and choose **SMTP & API**.
> 3. Open the **SMTP** tab. You will see a server name, a port, and a **login** — write the login down, it is usually the email address you signed up with.
> 4. Press **Generate a new SMTP key**, give it any name (for example `Budget Tracker`), and press create.
> 5. Brevo shows you the key **once**. Copy it now — you cannot see it again later, though you can always generate another one.
> 6. Back on this page: **Server** and **Port** are already filled in for you (`smtp-relay.brevo.com`, port `587`, STARTTLS). Leave them alone.
> 7. Put the **login** from step 3 into **Username**, and the **SMTP key** from step 5 into **Password**. The SMTP key is not the same thing as your Brevo account password — the account password will not work here.
> 8. **From address** must be an address Brevo has verified as a sender. Your signup address already is. If you use a different one, Brevo will refuse to send.
> 9. Press **Save**.
>
> **Last step:** press **Send test email**. If it arrives, you are done. Do not rely on notifications until you have seen a test arrive.

**SMTP2GO**

> SMTP2GO sends the email for you. The free plan allows around **1,000 emails a month**, which is far more than a household will use.
>
> 1. Go to **smtp2go.com** in your browser and create a free account, or sign in.
> 2. In the menu on the left, open **Sending**, then **SMTP Users**.
> 3. Press **Add SMTP User**. Give it any name, and either let it generate a password or set one yourself.
> 4. Write down the **username** and **password** it shows you. These are only for sending email — they are not your SMTP2GO account login.
> 5. Back on this page: **Server** and **Port** are already filled in for you (`mail.smtp2go.com`, port `587`, STARTTLS). Leave them alone.
> 6. Put the username and password from step 4 into **Username** and **Password**.
> 7. **From address** must use a domain SMTP2GO has verified. If you have not added your own domain, use the sender address SMTP2GO gives you on the **Verified Senders** page.
> 8. Press **Save**.
>
> **Last step:** press **Send test email**. If it arrives, you are done. Do not rely on notifications until you have seen a test arrive.

**Gmail**

> Gmail can send these messages from your own address. It is the fiddliest of the three to set up, and Google limits how much it will send — in practice **about 100 to 150 messages a day**, which is plenty here.
>
> **Your normal Google password will not work.** Google requires a separate 16-character "App password" for programs like this one.
>
> 1. Go to **myaccount.google.com** and sign in.
> 2. Open **Security** in the menu on the left.
> 3. Find **2-Step Verification**. If it is off, turn it on and finish the setup — Google will not offer App passwords until it is on.
> 4. Still under **Security**, find **App passwords**. (If you cannot see it, search "App passwords" in the search box at the top of the page.)
> 5. Create one. If Google asks what it is for, choose **Mail**, and for the device choose **Other** and type `Budget Tracker`.
> 6. Google shows a 16-character password in four blocks, like `abcd efgh ijkl mnop`. Copy it. You can type it with or without the spaces.
> 7. Back on this page: **Server** and **Port** are already filled in for you (`smtp.gmail.com`, port `465`, TLS). Leave them alone.
> 8. Put your full Gmail address into **Username**, and the 16-character App password from step 6 into **Password**.
> 9. Put that same Gmail address into **From address**. Gmail rewrites the sender to the account you signed in as, so anything else will be replaced anyway.
> 10. Press **Save**.
>
> **Last step:** press **Send test email**. If it arrives, you are done. Do not rely on notifications until you have seen a test arrive.

**Custom SMTP**

> Use this if your email provider is not one of the three above, or if you run your own mail server on your network.
>
> Almost every provider has a help page called **"SMTP settings"** or **"Sending email using SMTP"**. It will list the four things this form needs. Search for your provider's name plus "SMTP settings" and you will find it.
>
> - **Server** — the address of the machine that sends the mail, for example `smtp.myprovider.com`. Not a web address, and no `https://` in front of it.
> - **Port** — a number. `587` is the usual one. `465` is the other common one, and goes with the **TLS** option below.
> - **Encryption** — how the connection is protected.
>   - **STARTTLS** — the normal choice, almost always with port 587.
>   - **TLS** — used with port 465.
>   - **None** — no protection at all. Your username, password and messages travel readable across the network. Only pick this for a mail server on your own home network, never for anything on the internet.
> - **Username** and **Password** — the sign-in details for sending. Many providers want a separate password for this, not your normal account password; their SMTP settings page will say so if they do.
> - **From address** — the address the email appears to come from. Most providers insist this matches the account you signed in as, and will refuse to send otherwise.
>
> **Last step:** press **Send test email**. If it arrives, you are done. Do not rely on notifications until you have seen a test arrive.

---

## 12. Server actions and security

**MUST-12.1** Every mutating server action calls `isSameOrigin(await headers())` **first**, before auth, before validation, before any read — the pattern in `src/app/(app)/settings/connections/actions.ts`, returning `{ error: CROSS_ORIGIN_ERROR }`.

**MUST-12.2** This feature adds **no route handler**, no anonymous path, no signed URL, no bearer token, no query-string secret.

**MUST-12.3** Admin gate: `saveSmtpAction`, `removeSmtpAction`, `testSmtpAction` call `requireAdmin()`. Everything else calls `requireUser()`.

**MUST-12.4 (the ownership rule).** **No action accepts a `userId` parameter.** Every per-user action derives the id from `requireUser()`. A member therefore cannot read, write, test, or delete another member's channel or preferences — not by tampering with a form field, because there is no field to tamper with. Likewise no action accepts an outbox row id.

**MUST-12.5** zod on every input, including: bot token `/^\d{5,15}:[A-Za-z0-9_-]{20,80}$/`; Telegram chat id `/^-?\d{1,20}$/`; destination email `z.string().email().max(254)`; host `1..255` chars with no scheme or whitespace; port `int 1..65535`; From address `z.string().email()`; From name `max 64`; every knob range-checked in zod **as well as** by the SQL `CHECK` (§3.5).

**MUST-12.6** All nine actions:

```ts
export interface NotificationsState { error?: string; message?: string }

saveSmtpAction(prev, formData): Promise<NotificationsState>          // admin
removeSmtpAction(): Promise<NotificationsState>                      // admin
testSmtpAction(): Promise<NotificationsState>                        // admin, rate-limited
saveTelegramTargetAction(prev, formData): Promise<NotificationsState>
saveEmailTargetAction(prev, formData): Promise<NotificationsState>
removeTargetAction(formData): Promise<NotificationsState>            // channel from form, user from session
testTargetAction(formData): Promise<NotificationsState>              // rate-limited
savePreferencesAction(prev, formData): Promise<NotificationsState>
detectTelegramChatIdAction(): Promise<DetectChatIdState>             // no arguments, rate-limited
```

```ts
export interface DetectChatIdState { error?: string; chats?: TelegramChat[] }
```

Each mutating action ends with `revalidatePath('/settings/notifications')`. `detectTelegramChatIdAction` mutates nothing and does not revalidate.

**MUST-12.7** Send-test bypasses the outbox: it calls the sender directly and returns the outcome synchronously, because immediate feedback is the entire point of the button. It writes no outbox row, but it **does** update the target's `last_error` / `last_success_at` / `verified_at`.

**MUST-12.8 (the helper's security posture).** `detectTelegramChatIdAction` takes **no arguments at all** — not a token, not a user id. It calls `isSameOrigin()` then `requireUser()`, loads *that* user's own `notification_targets` row, decrypts the token server-side, calls `fetchTelegramChats()`, and returns only `TelegramChat[]`. There is consequently no parameter through which a member could aim it at another member's bot, and no response field through which a token could escape. It is still a **mutating-shaped** action for CSRF purposes — it causes outbound network egress on the server — so it takes the strict `isSameOrigin()` check, not the relaxed `isSameOriginOrHeaderless()` reserved for read-only download GETs.

---

## 13. Rate limiting on the two user-triggered egress buttons

**MUST-13.1** In-memory token buckets in `src/lib/notify/ratelimit.ts`:

```ts
export const TEST_SEND_WINDOW_MS = 10 * 60_000;
export const TEST_SEND_MAX_PER_USER = 3;    // per (userId, channel)
export const TEST_SEND_MAX_GLOBAL = 10;     // across all users and channels

export const DETECT_CHAT_WINDOW_MS = 10 * 60_000;
export const DETECT_CHAT_MAX_PER_USER = 10; // per userId
```

Exceeding a send-test cap returns `Too many test messages. Try again in N minutes.` and sends nothing. The global cap exists because a household's Brevo free tier and a Telegram bot's per-minute allowance are shared resources one enthusiastic member can exhaust for everyone.

**MUST-13.1a** **Detect chat ID** gets a **separate, looser** bucket (`Too many attempts. Try again in N minutes.`). It is genuinely expected to be pressed several times in a row — the whole flow is "press it, realise you never messaged the bot, message the bot, press it again" — so a cap of three would punish correct use. Ten per ten minutes still bounds a stuck form, and unlike a test send it delivers nothing and consumes no provider quota. It has **no** global cap: each user's presses hit their own bot, so there is no shared resource to protect.

**MUST-13.2** In-memory rather than DB-backed, unlike `src/lib/auth/ratelimit.ts`. Different threat: the login limiter defends against an unauthenticated attacker who can retry across restarts, while these bound an authenticated household member's misclicks and a stuck form. A restart resetting the bucket is acceptable, and a member cannot restart the container. Recorded as a decision (§19.13).

**MUST-13.3** A `setNotifyRateLimitClockForTests()` seam (or an injectable `now`) so both windows are testable without real waiting.

---

## 14. Interactions with existing subsystems

### 14.1 Backup

**MUST-14.1** `src/lib/scheduler.ts`'s existing `catch` around `runNightlyJob(new Date())` gains `raiseBackupFailed({ error, at })`. The raise lives in the scheduler, not in `src/lib/backup.ts`, so the backup module acquires no notify import and its tests are untouched.

Settings → Backups' "run now" action also calls `runNightlyJob` and deliberately does **not** notify: an admin standing in front of the result page does not need to be emailed about it. The event is about the *unattended* path.

### 14.2 Restore

**MUST-14.2** `src/instrumentation-node.ts` gains one guarded call, placed **after** `getDb()` (the outcome has to be written into the restored database) and **before** `startScheduler()` (whose immediate boot tick then drains the row):

```ts
try { raiseRestoreOutcome(); } catch (error) { console.error('[notify] restore outcome raise failed', error); }
```

`raiseRestoreOutcome()` reads `readRestoreState().result` from `src/lib/backup/restore.ts` and enqueues **only** when `outcome.finishedAt` is within `RESTORE_NOTIFY_MAX_AGE_MS = 24h` of now. Without that age check, `result.json` persisting on disk would re-notify a months-old restore once its outbox row aged out under §3.14 — the single case where MUST-3.12's pruning-safety argument needs an explicit guard rather than following from the key's shape.

**MUST-14.3** The existing ordering rules of warranty §20 are untouched: `applyStagedRestoreOnBoot()` stays the first statement in the file, and the `'restart'` exit still happens before `getDb()`.

### 14.3 Login

**MUST-14.4** `src/lib/auth/login.ts` gains one guarded call immediately after `createSession(...)` on the success path, passing the session's `createdAt` as the dedup key input. It is fire-and-forget: the enqueue is a synchronous SQLite insert, the pump kick is not awaited, and the whole thing is inside `try/catch`. **A notification failure must never turn a successful login into an error.**

**MUST-14.5** The raise is in `attemptLogin`, not in the login server action, so any future authentication path inherits it, and so the existing timing-equalisation reasoning (Ruling (c)) stays confined to the failure paths it already governs — the raise happens only after a session exists.

### 14.4 Users

**MUST-14.6** Evaluation skips users with `is_active = 0`. Deactivating a member silences their notifications immediately without deleting their configuration, so reactivating restores it — consistent with §3's deactivate-never-delete rule. `users` rows are never hard-deleted, so the `ON DELETE CASCADE` clauses are belt-and-braces against a manual `DELETE` during support.

**MUST-14.7** Demoting an admin to member stops `backup_failed` and `restore_outcome` at the next evaluation (MUST-4.3); their stored prefs rows survive and take effect again on re-promotion.

### 14.5 SimpleFIN

**MUST-14.8** SimpleFIN syncs create `imports` rows (§12), so a household on SimpleFIN is never nagged by `stale_import`. No other interaction; the two features share only the crypto construction and the dormancy stance.

---

## 15. Dependencies

**MUST-15.1** Exactly one new runtime dependency: **`nodemailer`**.

Justification: SMTP is a stateful multi-step protocol — greeting, `EHLO` capability negotiation, an optional STARTTLS upgrade mid-socket, AUTH mechanism selection, MIME construction, header folding, dot-stuffing, and a response-code state machine — layered over TLS. Hand-rolling it on `node:net`/`node:tls` for a household budget app means owning a security-sensitive protocol implementation forever in exchange for saving one MIT-licensed dependency that is the de-facto Node standard and carries no runtime dependencies of its own. The API surface used is `createTransport`, `transporter.sendMail` and (not used, but stable) `transporter.verify` — unchanged since v4.

**MUST-15.2** Telegram uses **raw `fetch`** — one JSON POST. No SDK. `node-telegram-bot-api` and friends bring polling loops, an event emitter and a transitive dependency tree for one HTTP request.

**MUST-15.3** No new dev dependency beyond types. If `@types/nodemailer` lags the chosen major, a minimal `src/types/nodemailer.d.ts` declaring the three used members is preferable to loosening `strict`.

**MUST-15.4** `nodemailer` does no filesystem or network work at import time, so nothing in the dormancy rule is at risk from the import itself. It is **not** added to `serverExternalPackages` unless the Next build proves it necessary — it is pure JS with no native binding and no worker file, unlike the OCR stack of warranty §7.4.

---

## 16. Versioning and release

**MUST-16.0 (version collision to resolve before release).** The owner set this feature at **v1.3.0**. The in-flight billing-cycle work in the tree (MUST-3.2a) also labels itself v1.3.0. Both cannot be 1.3.0 unless they ship in the same release. Two acceptable resolutions, owner's call: **(a)** they ship together as 1.3.0, in which case `CHANGELOG.md`'s 1.3.0 section covers both and nothing here changes; or **(b)** billing-cycle ships first as 1.3.0 and notifications becomes **1.4.0**, in which case every `1.3.0` in §16 and in the revision history reads `1.4.0` and nothing else in this spec changes. No implementation work depends on which is chosen — this is a label, and the migration number (MUST-3.2a) is the part that actually had to be decided.

**MUST-16.1** `package.json` `version` → **`1.3.0`** (or `1.4.0` under MUST-16.0(b)). It remains the single source of truth: `src/lib/version.ts` imports it at build time, the footer and Settings → About render it, `/api/health` reports it, the update scripts print it.

**MUST-16.2** `CHANGELOG.md` gains `## [1.3.0] — 2026-08-17` in Keep-a-Changelog style with a fresh empty `## Unreleased` above it. `Added`: notifications with Telegram and SMTP email channels, eight events, per-user toggles, test sends. `Security`: SMTP passwords and bot tokens encrypted at rest under `SECRET_KEY`-derived keys; a new sign-in alert.

**MUST-16.3** Settings → About needs no code change (it renders `CHANGELOG.md` at request time).

**MUST-16.4** `README.md` and `INSTALL.md`: the `SECRET_KEY` consequence list (MUST-5.7), the second opt-in egress exception (MUST-9.5), and the backup-encryption note (MUST-5.8). `.env.example` is **unchanged** — this feature introduces no environment variable.

---

## 17. Testing

Vitest, colocated under `tests/` mirroring the source layout, exactly as the existing 1600+ test suite does. Every requirement above is stated so it can be tested; the list below is the minimum, not the ceiling.

**MUST-17.1 (the network gate).** No test in the suite performs real network I/O. `tests/lib/notify/**` stubs `globalThis.fetch` and asserts, in an `afterEach`, that no unexpected host was contacted. `send/index.ts` exposes `setNotifySenderForTests(fake)` / `resetNotifySenderForTests()`, mirroring the OCR engine seam (warranty MUST-7.17); every evaluation, outbox and integration test uses it, so nodemailer is never constructed outside `tests/lib/notify/email.test.ts`, which stubs the module.

### 17.1 Unit — `tests/lib/notify/`

- **`crypto.test.ts`** — round-trip under each info string; the two info strings produce different ciphertext for identical plaintext and cannot decrypt each other's payloads; a tampered tag throws; a payload of length ≤ 28 throws the malformed error rather than a crypto error; `scrubSecrets` redacts a raw token, a raw password, the token embedded in a Telegram URL path, and the base64 `AUTH PLAIN` form.
- **`events.test.ts`** — eight entries; every id matches `/^[a-z][a-z0-9_]*$/`; ids are unique; `eventsFor('member')` excludes both admin events; the exact default-enabled set of MUST-4.1.
- **`slots.test.ts`** — every line of MUST-6.6/6.7 as worked examples: daily at 08 evaluated at 07:59 → yesterday's slot, 25 h stale, **skipped**; at 08:00 → today, 0 h; at 19:00 → today, 11 h, fires; at 20:01 → 12 h, fires; at 21:00 → 13 h, **skipped**. Weekly with `W=1,H=8` evaluated Monday 07:00 → previous Monday, 167 h, **skipped**; Monday 09:00 → today, 1 h; Wednesday 09:00 → Monday, 49 h, **skipped**; Wednesday 07:00 → Monday, 47 h, fires. Plus `localHour`/`localWeekday` against a fixed instant in `America/Toronto` and in `UTC`.
- **`render.test.ts`** — all eight subjects and bodies against fixed inputs; a loan item renders "paid off by" and a subscription "cancel by" (proving MUST-6.14 goes through `warranty/constants.ts`); an 8000-character digest is truncated to 4000 with an ellipsis for Telegram and left whole for email; an item named `<b>x</b>` appears literally; a zero-transaction digest renders its empty sentence.
- **`outbox.test.ts`** — the backoff ladder produces exactly 1/2/4/8/16/32/64/128 minutes and caps at 6 h; attempt 8 flips to `failed`; a permanent error flips to `failed` at attempt 1; a duplicate `enqueue` with the same `(user, channel, dedup_key)` inserts nothing and reports it; a Telegram transport throw leaves every email row in the same batch `pending` and untouched (**per-channel isolation**); the circuit break defers the rest of a failing channel's batch without attempting it; MUST-7.5's pre-send revalidation refuses a removed target; MUST-7.8's boot expiry flips a 25-hour-old pending row and leaves a 23-hour-old one alone.
- **`dedup.test.ts`** — every key shape of MUST-3.11, and MUST-3.12 as an executable argument: run a full year of simulated daily evaluations against a fixed item set with the retention sweep running each night, and assert every event fires exactly the number of times the table says.
- **`telegram.test.ts`** — the request URL, method and JSON body; **no `parse_mode` key is present**; `redirect: 'error'`; the 15 s abort; 400/401/403/404 → permanent, 429/500/network → transient; `retry_after` honoured; `description` surfaced; `assertTelegramUrl` rejects `https://api.telegram.org.evil.com`, `http://api.telegram.org`, and a token containing `/`.
- **`detect-chats.test.ts`** — `fetchTelegramChats` hits `getUpdates` on the allowed origin with `assertTelegramUrl` applied; **no `offset` parameter is sent** (MUST-8.7), proved by a second call against the same stubbed response returning the same chats; several updates from one chat collapse to one entry keeping the newest date; ordering is newest-first and the list is capped at 20; `title` falls back through `title → first_name last_name → username → id`; a group named `<b>hi</b>` is returned as literal text; each of MUST-8.10's three outcomes produces its exact sentence; the token never appears in the returned value nor in any error string.
- **`email.test.ts`** — preset prefills exactly match the MUST-8.15 table; `secure`/`requireTLS` map correctly from all three security values; `security: 'none'` with a non-custom preset is a validation error; `sendMail` is called with `text` and **no `html`**; `responseCode >= 500` → permanent, 4xx → transient.
- **`ratelimit.test.ts`** — the fourth per-user test send in a window is refused, the eleventh global one is refused, the eleventh detect in a window is refused while the tenth is allowed, the two buckets are independent (exhausting test sends does not block detect), and all recover after the window.
- **`config.test.ts`** — MUST-3.7's sparse resolution (absent row → registry default; present row wins); MUST-4.3's admin filter; the five-condition `isEventEnabled` chain, each condition failed in isolation; `notification_user_settings` defaults returned for an absent row.

### 17.2 Evaluation — `tests/lib/notify/evaluate/`

- **`coming-due.test.ts`** — window boundaries at exactly `today` and exactly `today + N` (both in) and `today + N + 1` (out); a lifetime item never fires; only the owner is notified; editing the expiry date produces a second, correctly-keyed message; the MUST-6.13 cap of 20 with the remainder arriving at the next slot.
- **`budget.test.ts`** — 79% silent, 80% fires, 100% fires `budget_exceeded`; the same category does not re-fire the same month; raising the threshold mid-month fires again at the new number; household and personal fire independently for the same category; a parent fires on rolled-up child spend; an unbudgeted category never fires; the MUST-6.18 fingerprint skips a second tick with no data change, and does **not** skip after a re-categorisation (`max(updated_at)` moved), after a new user enables the event, or after a threshold change.
- **`digest.test.ts`** — the range is `[slot-7, slot-1]`; totals match the report helpers directly; the empty-week sentence.
- **`stale.test.ts`** — an install with zero imports never fires; `N × 7 - 1` days silent, `N × 7` fires; a second fire the same week is deduped; the following week fires again; a SimpleFIN-created `imports` row resets the clock.

### 17.3 Database — `tests/db/notification-schema.test.ts`

The migration applies cleanly on top of `0000`–`0004`; `_journal.json` idx/when/tag match MUST-3.2; all five tables and all four indexes exist; a second `notification_smtp` row is rejected by the `id = 1` CHECK; a telegram target with a NULL secret and an email target with a non-NULL secret are both rejected; a duplicate `(user_id, channel)` is rejected; a duplicate `(user_id, channel, dedup_key)` is rejected; every knob's range CHECK rejects `0` and the upper bound + 1; `notification_prefs` accepts an `event_id` that is not in the registry (**MUST-3.6, the extension-point guarantee, asserted in SQL**); deleting a user cascades all four child tables.

### 17.4 Scheduler and seams

- `tests/lib/scheduler.test.ts` gains: `NOTIFY_TICK_CRON === '*/5 * * * *'`; the task is registered and stopped with the others; the boot tick runs once; **the dormancy bail returns before any evaluator or sender is reached** (asserted with a spy on the fake sender and on the evaluator entry point); the nightly `catch` calls `raiseBackupFailed`, and a throwing `raiseBackupFailed` does not change `runNightlyJob`'s existing error propagation.
- `tests/ops/restore-seams.test.ts` gains: `raiseRestoreOutcome()` is called after `getDb()` and before `startScheduler()` in `src/instrumentation-node.ts`, and `applyStagedRestoreOnBoot()` is still the file's first statement.
- `tests/lib/auth/login.test.ts` gains: a successful login enqueues one `new_signin` row per enabled channel; a **failed** login enqueues nothing; a `raiseNewSignin` that throws still returns `{ status: 'ok' }`; a login with no configured channel writes no row at all.
- `tests/ops/notify-egress.test.ts` — MUST-9.4's source-level invariants.

### 17.5 Actions and client — `tests/app/`

- **`notifications-actions.test.ts`** — all nine actions reject a cross-origin request **before** doing anything else; `saveSmtpAction`/`removeSmtpAction`/`testSmtpAction` reject a member; a member's `removeTargetAction` cannot reach another member's row (there is no parameter by which to try — asserted against the action signature); a blank password on update keeps the stored value and on create is a validation error; no returned state and no page prop ever contains the plaintext password or token; `savePreferencesAction` writes only changed toggles (sparse); a rate-limited test send returns the message and calls no sender. For `detectTelegramChatIdAction`: it takes zero parameters (asserted on `Function.length`); it refuses with MUST-8.11's sentence when no token is saved; with two users each holding a different token it returns only the caller's own bot's chats; a rate-limited call performs no fetch; the returned `DetectChatIdState` contains no substring of the token.
- **`notifications-client.test.tsx`** — the dormant banner; the preset picker prefilling host/port/security and **swapping the guide panel so exactly one preset guide is in the DOM** (MUST-11.7); masked fields; the matrix generated from the registry, with **an injected registry entry unknown to the component rendering a row** (MUST-4.4/MUST-11.3); admin-only rows absent for a member; a disabled column for an unconfigured channel; `last_error` surfaced. Detect chat ID: disabled with its hint before a token is saved; a found list renders one radio per chat and selecting one fills the Chat ID field without saving; the empty and error states render MUST-8.10's exact sentences.
- **`notifications-guides.test.tsx`** — the guide copy is content, so it is pinned as content. The Telegram guide contains `@BotFather`, `/newbot`, the "a bot is not allowed to message you until you have messaged it first" explanation, and a **Detect chat ID** step. Each email guide contains its provider's exact page names (`SMTP & API`, `Sending` → `SMTP Users`, `App passwords`), its prefilled host, and its quota sentence; the Gmail guide states that the ordinary Google password will not work and requires 2-Step Verification. **All four email guides and the Telegram guide end with the closing line of MUST-11.8, and its "Send test" wording matches the rendered button label** (asserted against the button, not against a duplicated literal). No guide renders an `<a href>` (MUST-11.6).

### 17.6 Integration — `tests/integration/notify-flow.test.ts`

Against a temp SQLite file with the fake sender: configure SMTP and a Telegram target → import a CSV that pushes Groceries past 80% → tick → two outbox rows, one per channel, both `sent` → tick again → nothing new → push past 100% → one more pair → advance the clock a month → the same category fires again for the new month. Then: make the Telegram sender throw transiently and the email sender succeed → email delivers, Telegram backs off, `notification_targets.last_error` is set for Telegram only. Then: exhaust 8 attempts → `failed`, surfaced in the deliveries list. Then: remove the Telegram target with rows still pending → those rows resolve to `Channel was removed before delivery.` and the fake sender records **zero** further calls.

---

## 18. Acceptance criteria

### 18.1 Automated (must all pass before release)

- **AC1** `npm test` green, including every test in §17.
- **AC2** `npm run typecheck` clean under `strict`.
- **AC3** `tests/ops/notify-egress.test.ts` passes — the only outbound URL literal in `src/lib/notify/` is `api.telegram.org`, and the settings page directory contains no `fetch` call (MUST-9.4).
- **AC4** With no configured channel: a full boot plus twelve simulated ticks produce **zero** sender invocations and zero evaluator invocations (the dormancy assertion in §17.4).
- **AC5** No test performs real network I/O (MUST-17.1).
- **AC6** `drizzle/0006_notifications.sql` contains the statement-breakpoint marker **only** as a statement separator and **never** inside a comment — asserted by a test that strips comment lines and compares the marker count before and after.
- **AC7** A grep-style test asserts no `console.*` call in `src/lib/notify/` interpolates a subject, a body, or a decrypted secret.

### 18.2 Manual (documented QA checklist, run once per release)

- **A1** Fresh install, never open the page: `docker logs` shows no notify line beyond scheduler registration; a network capture on the host shows no traffic to `api.telegram.org` or any SMTP port over an hour.
- **A2** Configure Telegram **following only the on-screen guide, with no other tab open and no outside instructions** — this is the acceptance bar for §11.7.1, and a step that sends the tester searching elsewhere is a failed check, not a tester problem. Send test → message arrives within seconds. Deliberately corrupt the chat id → test fails with Telegram's own "chat not found" shown on the page.
- **A2b** Press **Detect chat ID** *before* messaging the bot → the empty-state sentence appears. Message the bot, press it again → your own chat is listed by name; select it and the Chat ID field fills. Press it a third time → the same chat is still listed (proving MUST-8.7's no-`offset` rule). Add the bot to a family group, send one message there, press again → both the private chat and the group appear, correctly labelled.
- **A3** Configure Brevo (or SMTP2GO) as admin **following only the on-screen guide**. Send test → mail arrives. Enter a wrong password → the failure is shown on the page, and the error text contains no fragment of the password.
- **A4** Configure Gmail **following only the on-screen guide**, using a 16-character app password → mail arrives, From rewritten by Gmail as the copy warns. Try it once with the ordinary Google password first → it fails, exactly as the guide says it will.
- **A5** Create a warranty item expiring in 10 days, set `coming_due_days = 14`, set `daily_hour` to the next clock hour → the message arrives at that hour and **does not** repeat the next day.
- **A6** Stop the container before the daily hour, start it 3 hours after → the missed slot fires at boot. Repeat with a 20-hour gap → it does not, and the skip is logged.
- **A7** Import a CSV that pushes a category past 80% → the alert arrives within one tick (≤ 5 min). Import more to pass 100% → the exceeded alert arrives; neither repeats.
- **A8** Sign in from a second device → the sign-in alert names the right time, IP and browser.
- **A9** Break the relay (wrong port), let a real event fire → Telegram still delivers, the email row retries and eventually shows a permanent failure in **Recent deliveries** with the relay's `last_error` on the SMTP card.
- **A10** Rotate `SECRET_KEY` and restart → both channels report "Stored credential could not be read. Re-enter it.", the app stays up, nothing 500s, and re-entering both credentials restores delivery.
- **A11** Restore a pre-1.3.0 backup → the app boots, the five tables exist and are empty, the page shows the dormant banner, nothing is sent.
- **A12** As a member: `/settings/notifications` loads, the SMTP section is absent, own channels and toggles work, and `/settings/users` remains refused.
- **A13** Press Send test four times in a minute → the fourth is refused with the wait message and no message is delivered. Press Detect chat ID four times in a row → all four work (separate, looser bucket, MUST-13.1a).
- **A14** Hand the page to a household member who has never set up an SMTP relay and watch them configure email start to finish using only the guide. Anything they have to ask about is a copy bug.

---

## 19. Decisions taken on the owner's behalf

Each is a single constant or a one-paragraph change if the owner wants it different.

1. **Tick cadence `*/5 * * * *`**, with immediate events kicking the pump directly so their latency is seconds, not minutes.
2. **Catch-up windows: 12 h daily, 48 h weekly.** Missed slots inside the window fire at boot; outside it they are skipped and logged.
3. **Default-on set:** `coming_due`, `budget_exceeded`, `backup_failed`, `restore_outcome`, `new_signin`. Default-off: `budget_threshold`, `weekly_digest`, `stale_import`.
4. **`coming_due` notifies the item's owner only**, not the whole household. A one-line change to broadcast.
5. **One outbox row per coming-due item**, announced once ever, rather than a daily digest of the window — the dedup shape the owner asked for. Capped at 20 new rows per user per evaluation.
6. **Budget events evaluate every tick** (fingerprint-guarded), not at the daily slot, so an afternoon import is reported the same afternoon.
7. **Threshold and exceeded may both fire** for a single import that jumps a category from under the threshold to over 100%. No suppression logic.
8. **Weekly digest covers the 7 days ending the day before the slot**, not a fixed Monday–Sunday week, so any chosen weekday yields a complete window.
9. **No URLs in any message** (MUST-10.4). An `APP_BASE_URL` env var enabling deep links is deferred.
10. **`stale_import` never fires on an install with zero imports** — a brand-new install must not nag before it has anything to be stale about.
11. **Nightly-backup failure notifies; the manual "run now" does not.**
12. **Per-user Telegram bot tokens**, not one shared household bot.
13. **Send-test rate limiting is in-memory**, unlike the DB-backed login limiter — different threat, and a restart resetting it is acceptable (MUST-13.2).
14. **At-least-once delivery**, with a crash mid-send able to duplicate one message. Stated in the spec rather than papered over.
15. **`PENDING_MAX_AGE_HOURS = 24`** — pending rows older than a day are abandoned at boot, which also handles the restored-database case.
16. **`OUTBOX_RETENTION_DAYS = 90`**, `MAX_ATTEMPTS = 8`, `OUTBOX_BATCH = 50`, `TELEGRAM_MAX_CHARS = 4000`, 15 s connect/request timeouts, 20 s SMTP socket timeout.
17. **`nodemailer` is the only new dependency**; Telegram uses raw `fetch`.
18. **Plain text on both channels** — no Telegram `parse_mode`, no HTML email.
19. **The singleton SMTP row is enforced in SQL** (`CHECK (id = 1)`), not only in the app layer as `simplefin_connections` does.
20. **`notification_prefs.event_id` carries no CHECK and no FK** — the deliberate cost of MUST-4.4, paid in exchange for future events needing no migration. Per-user *knobs* remain typed columns and do cost a migration.
21. **Chat-ID auto-discovery IS built** (§8.2), as a server action over `getUpdates` with no `offset`, its own looser rate-limit bucket, and no token ever reaching the browser. This adds a second Telegram endpoint but no second destination host. The alternative — telling a family member to open a raw JSON URL and find `message.chat.id` — was the worst step in the whole setup.
22. **`transporter.verify()` is not used** — only a real Send test proves a relay works.
23. **No amounts-redacting privacy mode.** One plainly-worded sentence on the page instead (MUST-11.4).
24. **Notifications page is reachable by every user** from a personal card on Settings, not from `ADMIN_LINKS`; only the SMTP section inside it is admin-gated.
25. **Setup guides live in the page, not in `INSTALL.md`.** Provider steps change, and documentation nobody opens at the moment of confusion is documentation that does not exist. The copy of §11.7 is a shipped deliverable with its own tests (§17.5) and its own acceptance checks (A2, A3, A4, A14).
26. **Guide URLs are rendered as plain text, not links** — MUST-11.6. It keeps the zero-egress claim trivially auditable, survives copy-paste into a screenshot or an email, and removes any question of what a click inside the app might reach.
27. **Quota figures are stated approximately** ("around 300 a day", "about 100 to 150 a day") because providers change them. They are there to reassure a person that the free tier is enough, not to be a specification.

---

## 20. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | A credential leaks into a log or a `last_error` — the bot token is *in the URL*, and SMTP errors quote AUTH lines | `scrubSecrets` mandatory on every error path (MUST-5.5), with unit tests for the URL and base64-AUTH shapes, plus AC7's no-secret-in-`console` assertion |
| R2 | A future contributor adds a third outbound call inside `src/lib/notify/` and quietly breaks the two-destination promise | `tests/ops/notify-egress.test.ts` (MUST-9.4) fails the build on any new URL literal or `fetch` site |
| R3 | A dedup key regresses and the app nags every five minutes — the most user-visible way this feature can fail | The guard is a unique index, not bookkeeping (MUST-3.9); `dedup.test.ts` simulates a full year of ticks with the retention sweep running and asserts exact fire counts |
| R4 | Two processes (a future replica, or a dev hot-reload edge case) both pump the outbox and double-send | Single-container deployment (§2); the in-memory single-flight guard mirrors the OCR queue; the unique index still prevents duplicate *rows*, so the worst case is a duplicate *send* of an existing row, which §19.14 already accepts. A DB-level claim column is the documented fix if replicas ever happen |
| R5 | A relay's free tier rate-limits or suspends the household for volume | The default-off set is the chatty half (§19.3); one message per event instance, never per tick; the §13 test-send caps; the §6.13 flood cap on first-run backfill |
| R6 | Gmail app passwords or a relay's sender-verification rules make first setup frustrating | The per-preset guides of §11.7.2 are mandatory shipped content, the Send test button gives immediate ground truth, and the relay's own error text is shown verbatim rather than replaced with a generic message. A2/A3/A4 are guide-only acceptance runs |
| R7 | An SMTP connect hangs and the tick overruns the next tick | 15 s connect / 20 s socket timeouts, the per-channel circuit break (MUST-7.4), the batch cap of 50, and the single-flight guard that makes an overlapping tick a no-op |
| R8 | Notifications turn the app's only-local-data property into a false claim | MUST-11.4's always-visible sentence, MUST-9.5's amendment to the master spec's network line, and MUST-5.8's backup note |
| R9 | A restored older database replays stale alerts | MUST-7.8's 24-hour boot expiry, plus MUST-14.2's 24-hour age check on the restore outcome itself |
| R10 | A provider renames a page and a guide goes stale — the copy is a snapshot of someone else's UI | Guides say what the page is *called* and what to look for, not where to click on a screen; the "search for your provider plus SMTP settings" fallback in the Custom guide covers every case; the copy is one reviewable module (`guides.tsx`) so a fix is a text edit, and its tests pin the sentences that matter rather than the whole prose |
| R11 | `getUpdates` returns nothing and the user concludes the app is broken | MUST-8.7's no-`offset` rule keeps the result stable across repeated presses, MUST-8.10's empty-state sentence names the actual cause and the fix, and the guide warns about the "message the bot first" rule *before* the user reaches the button |
| R12 | The concurrent billing-cycle work and this feature collide on the migration index, the `warranty_items` mirror in `src/db/schema.ts`, or the 1.3.0 label | MUST-3.2a fixes the index at 0006 and states the first-come rule; the two features touch disjoint tables (`warranty_items` versus the five new `notification_*` tables), so the only shared file is `src/db/schema.ts` and the conflict there is two independent appends; MUST-16.0 puts the version label in front of the owner rather than guessing |

---

## 21. Out of scope (explicitly deferred)

Predictive spending targets and their four events — `on_pace_overshoot`, `unusual_transaction`, `price_creep`, `duplicate_charge` — which are the next release and which this design is shaped to accept without a migration (MUST-4.4). Also: web push and PWA notifications; SMS; Slack, Discord, Matrix, ntfy, Apprise; per-event quiet hours and snooze; batching unrelated events into one message; deep links and the `APP_BASE_URL` env var they need; **inbound Telegram bot commands** (the outbound `getUpdates` read of §8.2 is chat discovery, not a command loop, and nothing in the app ever acts on a message's *content*); HTML email and attachments (the weekly digest as a PDF); multiple destinations per channel; a household-wide "notify everyone" toggle for `coming_due`; an amounts-redacting privacy mode; a manual retry button in Recent deliveries; a guided first-run wizard that walks a new install through channel setup; and notification rules a user can compose themselves rather than choosing from the registry.

---

## Revision history

- **v1.2** (2026-08-17): **migration renumbered 0005 → 0006** (MUST-3.2a). Concurrent, uncommitted billing-cycle work in the tree had already claimed `drizzle/0005_billing_cycle.sql`, journal idx 5, `when` 1755648000000; notifications moves to idx 6 / `when` 1755734400000, and the SQL-only enumeration in its header gains the billing-cycle entry at 13 with the notification entries shifting to 14–20. New MUST-16.0 puts the resulting **1.3.0 label collision** in front of the owner (ship together, or notifications becomes 1.4.0) rather than guessing; no implementation detail depends on the answer. New risk R12.
- **v1.1** (2026-08-17): owner addition during spec review — **built-in setup guides and Telegram chat-ID detection**. New §11.7 carries the verbatim, ship-as-written copy for five guides (Telegram, and one per email preset), rendered in collapsible panels beside each form and living in a new `guides.tsx` module; MUST-11.8 pins the shared closing line to the Send-test button label. New §8.2 specifies the **Detect chat ID** helper — a zero-argument server action reading the caller's own encrypted token, calling `getUpdates` **without an `offset`** so repeated presses stay idempotent, returning a deduped chat list as untrusted display text, with its own looser rate-limit bucket (MUST-13.1a) and three fixed outcome sentences. §8's email MUST tags renumbered to 8.12–8.17 and the preset help column moved into §11.7.2; §11.5's two MUSTs renumbered to 11.5/11.6; §9 gains MUST-9.1a (guide URLs are text, never fetched) and an extended egress test; §12 grows to nine actions plus MUST-12.8; §17 gains `detect-chats.test.ts` and `notifications-guides.test.tsx`; §18 gains A2b and A14 and makes A2/A3/A4 guide-only runs; §19 reverses decision 21 and adds 25–27; §20 gains R10 and R11. Telegram chat-ID auto-discovery leaves §21; inbound bot commands stay deferred.
- **v1.0** (2026-08-17): initial approved design. Notifications ship as app v1.3.0 — two channels (Telegram, SMTP email with Brevo / SMTP2GO / Gmail / Custom presets), eight launch events behind a code-side registry, per-user per-channel toggles, per-user knobs, Send test per channel. Five new tables in `drizzle/0006_notifications.sql`; dedup implemented as a unique index on the outbox itself; secrets encrypted under HKDF infos `notify-smtp-v1` and `notify-telegram-v1` alongside the existing `totp-v1` and `simplefin-v1`; a five-minute scheduler tick with 12 h / 48 h catch-up windows and a dormancy bail; an outbox with exponential backoff, per-channel isolation and at-least-once delivery.
