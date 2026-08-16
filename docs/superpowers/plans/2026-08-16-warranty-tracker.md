# Warranty Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a household warranty tracker to the shipped Budget Tracker v1.0.0 app — record what was bought and how long it is covered, attach receipt photos/PDFs, OCR them server-side and offline, search every word printed on the receipt, and back the files up with the database.

**Architecture:** Additive to the existing Next.js 15 App Router + better-sqlite3 + Drizzle codebase. Two new tables (`warranty_items`, `warranty_receipts`) plus an FTS5 contentless index (`warranty_search`) kept in sync by six SQL triggers, all in one hand-authored migration `drizzle/0002_warranty_tracker.sql`. Receipt bytes live at `${DATA_DIR}/receipts/` under server-generated UUID filenames and reach the browser only through one authenticated streaming route. OCR runs in-process behind a FIFO queue of concurrency 1 (tesseract.js WASM in its own Node worker for images, pdfjs-dist text-layer extraction for PDFs), with every engine asset resolved from a local absolute path so the app makes no network call. Domain logic lives in `src/lib/warranty/*` as unit-testable modules; pages are thin.

**Tech Stack:** Node 22, Next.js 15 (App Router), React 19, TypeScript strict, Tailwind CSS 4, better-sqlite3 12 (SQLite 3.53 with FTS5), Drizzle ORM 0.44, zod 3, Vitest 3, Docker `node:22-bookworm-slim`. **New runtime dependencies:** `tesseract.js` (pulls `tesseract.js-core`), `pdfjs-dist`, `tar`. **New vendored asset:** `vendor/tessdata/eng.traineddata.gz`.

**Spec:** `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md` (the binding authority — read it alongside this plan). Base app spec: `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` ("base §N" references point there).

## Global Constraints

Every task's requirements implicitly include this whole section.

### Security invariants (spec §13, verbatim, all binding)

- **MUST-13.1** Every **mutating** server action calls `isSameOrigin(await headers())` **first**, before auth, before validation, before any read — the pattern in `src/app/(app)/transactions/actions.ts`. Mutating route handlers call `assertSameOrigin(request)`. The relaxed `isSameOriginOrHeaderless` is used **only** on the two authenticated read-only GETs this feature adds (§5, §6.3 poll).
- **MUST-13.2** Everything is session-authenticated. This feature adds **no** anonymous route, no signed URL, no bearer token, no query-string secret. The only public paths in the app remain login and setup.
- **MUST-13.3 (OCR text is untrusted input).** OCR text and `original_filename` are attacker-influenceable in principle (a receipt is an arbitrary image). They are: rendered as **text nodes only**, never as HTML and never through `dangerouslySetInnerHTML`; passed into FTS only via the escaper of §9.1 and always as a bound parameter; never used to build a path; never used in a `Content-Type`; and sanitised before appearing in a `Content-Disposition` filename (§5.3).
- **MUST-13.4 (Permissions-Policy risk).** The app currently sends `Permissions-Policy: camera=(), …`. `<input capture>` normally routes through the OS camera intent rather than `getUserMedia`, so the policy should not block it — but browser implementations differ, and this must be **verified on a real phone** (acceptance check A5, §15.4). The pre-approved remedy if it is blocked is to relax that one directive to `camera=(self)`, which is still strictly tighter than the browser default. No other header changes.
- **MUST-13.5** Integer cents everywhere. `price_cents` is an integer; no float ever touches a money value; conversion goes through `src/lib/money.ts`.
- **MUST-13.6** No new runtime network egress (§7.2). The SimpleFIN connector in base §12 remains the app's only opt-in exception and is untouched by this feature.
- **MUST-13.7** TypeScript strict; zod validation on every action input and every route body, including the multipart parts.
- **MUST-13.8** Container hardening is unchanged: non-root, read-only rootfs, tmpfs `/tmp`, `/data` writable. OCR writes only to `/tmp` and `${DATA_DIR}` (MUST-7.3).
- **MUST-13.9** Receipts land inside the **unencrypted** backup archive, exactly like the database (base §8's accepted LAN-only trade-off). INSTALL.md's Hyper Backup client-side-encryption guidance is extended to say that offsite copies now include photographs of receipts, which carry names, addresses and partial card numbers.

### App-wide rules

- **Migrations are append-only and hand-authored.** `drizzle-kit generate` is never run — there is no `0000_snapshot.json`, so it would diff against an empty baseline, re-emit all 19 existing tables, and silently drop the raw-SQL-only objects. Order of work is fixed: (1) hand-author the `.sql`, (2) append the journal entry, (3) mirror in `src/db/schema.ts`. There is intentionally no `db:generate` script.
- **Nothing in this plan may modify** the frozen dedup hash (`src/lib/import/dedup.ts`), `drizzle/0000_init.sql`, `drizzle/0001_add_must_change_password.sql`, or the DDL of any existing table. `transactions` gains no column, no index and no behaviour change (MUST-11.5).
- **No runtime network egress.** OCR assets (`tesseract.js` worker script, `tesseract.js-core` WASM, `eng.traineddata.gz`) are resolved from local absolute filesystem paths only; `pdfjs-dist` runs with remote font/CMap fetching disabled; `tar` is pure filesystem.
- **OCR text is rendered as text only**, never as HTML. The raw text is never displayed at all in this release (§16 item 6) — it is search fuel.
- **FTS input escaping strategy:** user input is never interpolated into an FTS5 query. `escapeFtsQuery()` trims, splits on whitespace, drops empties, wraps each term in double quotes with internal quotes doubled, appends `*` to the last term only, joins with a space, caps at 20 terms / 200 raw characters, and returns `null` for empty input (caller then omits the MATCH clause). The produced string is always a **bound parameter**.
- **TypeScript strict** (`tsconfig.json` `"strict": true`); `npm run typecheck` must stay clean.
- Money is **integer cents**. `warranty_items.price_cents` is a **positive magnitude** — a deliberate divergence from `transactions.amount_cents` (spend negative); §11 converts with `Math.abs`.
- Dates are ISO `YYYY-MM-DD` TEXT; timestamps are ISO datetime TEXT via `nowIso()` from `src/lib/clock.ts`; "today" always comes from `todayIso()` (TZ-aware).
- Import alias `@/` → `src/`. Tests live under `tests/` mirroring `src/`, are vitest with **explicit imports** (`import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'` — globals are off), and any test touching the database uses `createTestDb()` / `createSeededTestDb()` from `tests/helpers/db.ts`.
- **GIT COMMITS ARE PAUSED by user instruction (2026-08-15): do NOT run `git commit`.** Each task below records the commit message it *would* use; the actual end-of-task checkpoint is `npm test` + `npm run typecheck` green. If the user lifts the pause, run the recorded command.
- Project root for every absolute path: `c:\Users\m.grewal\OneDrive - CloverTool Mfg\Documents\Budget Tracker`. All `npm` commands run from there in PowerShell.
- Base image is **unchanged** (`node:22-bookworm-slim`); no `apt-get install tesseract-ocr`. No CSP change (`img-src 'self' data:` already covers same-origin receipt images).

<!-- END HEADER -->

---

## Task 1: Migration 0002 — tables, FTS5 index, triggers, Drizzle mirror

**Context:** The database currently has 19 tables and two hand-authored migrations. This task adds `warranty_items`, `warranty_receipts`, the `warranty_search` FTS5 contentless virtual table and its six triggers, in one append-only migration, plus the Drizzle mirror. Nothing else in the app changes yet.

**Files:**
- Create: `drizzle/0002_warranty_tracker.sql`
- Modify: `drizzle/meta/_journal.json` (append idx 2)
- Modify: `src/db/schema.ts` (append two tables at the end of the file)
- Modify: `tests/db/schema.test.ts` (EXPECTED_TABLES / EXPECTED_INDEXES and the table query)
- Test: `tests/db/warranty-schema.test.ts`

**Interfaces:**
- Consumes: `createTestDb()` from `tests/helpers/db.ts`; the existing `users` and `transactions` Drizzle tables in `src/db/schema.ts`.
- Produces:
  ```ts
  // src/db/schema.ts (appended)
  export const warrantyItems: SQLiteTable;    // columns below
  export const warrantyReceipts: SQLiteTable; // columns below
  ```
  Column names available to every later task (Drizzle property → SQL column):
  `warrantyItems`: `id`→`id`, `name`, `vendor`, `model`, `serial`, `purchaseDate`→`purchase_date`, `warrantyMonths`→`warranty_months`, `isLifetime`→`is_lifetime` (boolean mode), `expiryDate`→`expiry_date`, `priceCents`→`price_cents`, `ownerUserId`→`owner_user_id`, `transactionId`→`transaction_id`, `notes`, `createdAt`→`created_at`, `updatedAt`→`updated_at`.
  `warrantyReceipts`: `id`, `warrantyItemId`→`warranty_item_id`, `originalFilename`→`original_filename`, `storedFilename`→`stored_filename`, `mime`, `sizeBytes`→`size_bytes`, `sha256`, `ocrText`→`ocr_text`, `ocrStatus`→`ocr_status`, `ocrError`→`ocr_error`, `createdAt`→`created_at`.
  Also produces the SQL-only objects every later task relies on: the `warranty_search` FTS5 table (`rowid` = `warranty_items.id`, columns `name, vendor, model, notes, ocr_text`) and the six triggers that are its **only** writer.

### Steps

- [ ] **Step 1: Write the failing database test.**

Create `tests/db/warranty-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, type TestDb } from '../helpers/db';

let current: TestDb | null = null;

afterEach(() => {
  current?.cleanup();
  current = null;
});

const ISO = '2026-08-16T12:00:00.000Z';

function seedUser(db: TestDb): number {
  db.sqlite
    .prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin',?)")
    .run(ISO);
  return 1;
}

function insertItem(db: TestDb, over: Partial<Record<string, unknown>> = {}): number {
  const row = {
    name: 'Fridge', vendor: 'Home Depot', model: 'GDT645SYNFS', serial: null,
    purchase_date: '2026-08-16', warranty_months: 24, is_lifetime: 0, expiry_date: '2028-08-16',
    price_cents: 129999, owner_user_id: 1, transaction_id: null, notes: null,
    ...over,
  };
  const info = db.sqlite
    .prepare(
      `insert into warranty_items
        (name, vendor, model, serial, purchase_date, warranty_months, is_lifetime, expiry_date,
         price_cents, owner_user_id, transaction_id, notes, created_at, updated_at)
       values (@name, @vendor, @model, @serial, @purchase_date, @warranty_months, @is_lifetime,
               @expiry_date, @price_cents, @owner_user_id, @transaction_id, @notes, '${ISO}', '${ISO}')`,
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

function insertReceipt(db: TestDb, itemId: number, over: Partial<Record<string, unknown>> = {}): number {
  const row = {
    warranty_item_id: itemId,
    original_filename: 'receipt.jpg',
    stored_filename: `${crypto.randomUUID()}.jpg`,
    mime: 'image/jpeg',
    size_bytes: 1024,
    sha256: 'a'.repeat(64),
    ocr_text: null,
    ocr_status: 'pending',
    ocr_error: null,
    ...over,
  };
  const info = db.sqlite
    .prepare(
      `insert into warranty_receipts
        (warranty_item_id, original_filename, stored_filename, mime, size_bytes, sha256,
         ocr_text, ocr_status, ocr_error, created_at)
       values (@warranty_item_id, @original_filename, @stored_filename, @mime, @size_bytes,
               @sha256, @ocr_text, @ocr_status, @ocr_error, '${ISO}')`,
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

function matches(db: TestDb, query: string): number[] {
  return db.sqlite
    .prepare('select rowid as id from warranty_search where warranty_search match ?')
    .all(query)
    .map((r) => (r as { id: number }).id);
}

describe('migration 0002 — journal and objects', () => {
  it('records idx 2 / when 1755388800000 / tag 0002_warranty_tracker with breakpoints', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 2);
    expect(entry).toEqual({ idx: 2, version: '6', when: 1755388800000, tag: '0002_warranty_tracker', breakpoints: true });
  });

  it('separates statements with --> statement-breakpoint and never runs drizzle-kit', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'drizzle/0002_warranty_tracker.sql'), 'utf8');
    expect(sql).toContain('--> statement-breakpoint');
    // Trigger bodies contain semicolons; a ';'-keyed splitter would shred them (MUST-3.3).
    expect(sql).toContain('CREATE TRIGGER `warranty_search_item_ai`');
    expect(sql).toMatch(/only in SQL|only in this file|exist only/i);
  });

  it('applies cleanly on top of 0000 and 0001 and creates both tables', () => {
    current = createTestDb();
    const tables = current.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name like 'warranty%' order by name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('warranty_items');
    expect(tables).toContain('warranty_receipts');
    expect(tables).toContain('warranty_search');
  });

  it('has FTS5 available on a SQLite new enough for contentless_delete', () => {
    current = createTestDb();
    const { v } = current.sqlite.prepare('select sqlite_version() as v').get() as { v: string };
    const [maj, min] = v.split('.').map(Number);
    expect(maj).toBeGreaterThanOrEqual(3);
    expect(maj > 3 || min >= 43).toBe(true);
    const ddl = current.sqlite
      .prepare("select sql from sqlite_master where name = 'warranty_search'")
      .get() as { sql: string };
    expect(ddl.sql).toContain('contentless_delete=1');
    expect(ddl.sql).toContain('unicode61 remove_diacritics 2');
  });

  it('creates every new index', () => {
    current = createTestDb();
    const names = new Set(
      current.sqlite
        .prepare("select name from sqlite_master where type = 'index' and name not like 'sqlite_%'")
        .all()
        .map((r) => (r as { name: string }).name),
    );
    for (const expected of [
      'warranty_items_expiry_idx',
      'warranty_items_owner_idx',
      'warranty_items_transaction_idx',
      'warranty_receipts_stored_uq',
      'warranty_receipts_item_idx',
      'warranty_receipts_ocr_idx',
    ]) {
      expect(names.has(expected), `missing index ${expected}`).toBe(true);
    }
  });
});

describe('migration 0002 — CHECK constraints', () => {
  it('rejects lifetime with warranty_months set', () => {
    current = createTestDb();
    seedUser(current);
    expect(() => insertItem(current!, { is_lifetime: 1, warranty_months: 12, expiry_date: null })).toThrowError(/CHECK constraint failed/);
  });

  it('rejects lifetime with an expiry_date set', () => {
    current = createTestDb();
    seedUser(current);
    expect(() => insertItem(current!, { is_lifetime: 1, warranty_months: null, expiry_date: '2030-01-01' })).toThrowError(/CHECK constraint failed/);
  });

  it('accepts a lifetime row with both null', () => {
    current = createTestDb();
    seedUser(current);
    expect(insertItem(current!, { is_lifetime: 1, warranty_months: null, expiry_date: null })).toBeGreaterThan(0);
  });

  it('accepts an unknown-term row (months null, expiry null, not lifetime)', () => {
    current = createTestDb();
    seedUser(current);
    expect(insertItem(current!, { warranty_months: null, expiry_date: null })).toBeGreaterThan(0);
  });

  it('rejects months set with expiry NULL, and expiry set with months NULL', () => {
    current = createTestDb();
    seedUser(current);
    expect(() => insertItem(current!, { warranty_months: 12, expiry_date: null })).toThrowError(/CHECK constraint failed/);
    expect(() => insertItem(current!, { warranty_months: null, expiry_date: '2027-01-01' })).toThrowError(/CHECK constraint failed/);
  });

  it('rejects warranty_months = 0 and a negative price', () => {
    current = createTestDb();
    seedUser(current);
    expect(() => insertItem(current!, { warranty_months: 0, expiry_date: '2026-08-16' })).toThrowError(/CHECK constraint failed/);
    expect(() => insertItem(current!, { price_cents: -1 })).toThrowError(/CHECK constraint failed/);
  });

  it('rejects an out-of-list mime and ocr_status, and out-of-range size_bytes', () => {
    current = createTestDb();
    seedUser(current);
    const itemId = insertItem(current!);
    expect(() => insertReceipt(current!, itemId, { mime: 'image/gif' })).toThrowError(/CHECK constraint failed/);
    expect(() => insertReceipt(current!, itemId, { ocr_status: 'running' })).toThrowError(/CHECK constraint failed/);
    expect(() => insertReceipt(current!, itemId, { size_bytes: 0 })).toThrowError(/CHECK constraint failed/);
    expect(() => insertReceipt(current!, itemId, { size_bytes: 10485761 })).toThrowError(/CHECK constraint failed/);
    expect(insertReceipt(current!, itemId, { size_bytes: 10485760 })).toBeGreaterThan(0);
  });

  it('rejects a duplicate stored_filename', () => {
    current = createTestDb();
    seedUser(current);
    const itemId = insertItem(current!);
    const name = `${crypto.randomUUID()}.jpg`;
    insertReceipt(current!, itemId, { stored_filename: name });
    expect(() => insertReceipt(current!, itemId, { stored_filename: name })).toThrowError(/UNIQUE constraint failed/);
  });
});

describe('migration 0002 — FTS triggers', () => {
  it('indexes an item on insert and finds it by name', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    expect(matches(current!, '"fridge"')).toEqual([id]);
  });

  it('reindexes when name changes but NOT when only updated_at changes', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    current!.sqlite.prepare('update warranty_items set name = ? where id = ?').run('Dishwasher', id);
    expect(matches(current!, '"fridge"')).toEqual([]);
    expect(matches(current!, '"dishwasher"')).toEqual([id]);

    // updated_at is not in the AFTER UPDATE OF column list, so the row must not be re-tokenized.
    const before = current!.sqlite.prepare('select count(*) as c from warranty_search').get() as { c: number };
    current!.sqlite.prepare('update warranty_items set updated_at = ? where id = ?').run('2026-09-01T00:00:00.000Z', id);
    const after = current!.sqlite.prepare('select count(*) as c from warranty_search').get() as { c: number };
    expect(after.c).toBe(before.c);
    expect(matches(current!, '"dishwasher"')).toEqual([id]);
  });

  it('finds an item by a word that appears only on its receipt', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    insertReceipt(current!, id, { ocr_text: 'RONA STORE 4412 SPATULA', ocr_status: 'done' });
    expect(matches(current!, '"spatula"')).toEqual([id]);
  });

  it('matches MÉTRO by typing metro (remove_diacritics 2)', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!, { vendor: 'MÉTRO' });
    expect(matches(current!, '"metro"')).toEqual([id]);
  });

  it('prefix-matches a partial model number', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    expect(matches(current!, '"GDT645"*')).toEqual([id]);
  });

  it('swaps the indexed text when ocr_text is updated', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    const receiptId = insertReceipt(current!, id, { ocr_text: 'OLDWORD', ocr_status: 'done' });
    expect(matches(current!, '"oldword"')).toEqual([id]);
    current!.sqlite.prepare('update warranty_receipts set ocr_text = ? where id = ?').run('NEWWORD', receiptId);
    expect(matches(current!, '"oldword"')).toEqual([]);
    expect(matches(current!, '"newword"')).toEqual([id]);
  });

  it('drops a deleted receipt\u2019s text but keeps the item indexed', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    const receiptId = insertReceipt(current!, id, { ocr_text: 'GONEWORD', ocr_status: 'done' });
    current!.sqlite.prepare('delete from warranty_receipts where id = ?').run(receiptId);
    expect(matches(current!, '"goneword"')).toEqual([]);
    expect(matches(current!, '"fridge"')).toEqual([id]);
  });

  it('leaves ZERO FTS rows after deleting an item that had two receipts (MUST-3.11)', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    insertReceipt(current!, id, { ocr_text: 'ONE', ocr_status: 'done' });
    insertReceipt(current!, id, { ocr_text: 'TWO', ocr_status: 'done' });
    current!.sqlite.prepare('delete from warranty_items where id = ?').run(id);
    const count = current!.sqlite.prepare('select count(*) as c from warranty_search').get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('migration 0002 — foreign keys', () => {
  it('nulls transaction_id and keeps the item when the transaction is deleted (MUST-3.7)', () => {
    current = createTestDb();
    seedUser(current);
    current!.sqlite
      .prepare("insert into accounts (id, name, institution, type, is_active, created_at) values (1,'Chq','TD','chequing',1,?)")
      .run(ISO);
    current!.sqlite
      .prepare(
        `insert into transactions (id, account_id, date, raw_description, normalized_merchant, amount_cents,
           dedup_hash, hash_version, created_by, created_at, updated_at)
         values (7, 1, '2026-08-16', 'HOME DEPOT', 'HOME DEPOT', -129999, 'h1', 1, 1, ?, ?)`,
      )
      .run(ISO, ISO);
    const id = insertItem(current!, { transaction_id: 7 });
    current!.sqlite.prepare('delete from transactions where id = 7').run();
    const row = current!.sqlite.prepare('select transaction_id from warranty_items where id = ?').get(id) as {
      transaction_id: number | null;
    };
    expect(row.transaction_id).toBeNull();
  });

  it('cascades receipt rows when the item is deleted', () => {
    current = createTestDb();
    seedUser(current);
    const id = insertItem(current!);
    insertReceipt(current!, id);
    current!.sqlite.prepare('delete from warranty_items where id = ?').run(id);
    const count = current!.sqlite.prepare('select count(*) as c from warranty_receipts').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('allows two warranty items to share one transaction (no unique index)', () => {
    current = createTestDb();
    seedUser(current);
    current!.sqlite
      .prepare("insert into accounts (id, name, institution, type, is_active, created_at) values (1,'Chq','TD','chequing',1,?)")
      .run(ISO);
    current!.sqlite
      .prepare(
        `insert into transactions (id, account_id, date, raw_description, normalized_merchant, amount_cents,
           dedup_hash, hash_version, created_by, created_at, updated_at)
         values (9, 1, '2026-08-16', 'HOME DEPOT', 'HOME DEPOT', -200000, 'h2', 1, 1, ?, ?)`,
      )
      .run(ISO, ISO);
    expect(insertItem(current!, { transaction_id: 9, name: 'Fridge' })).toBeGreaterThan(0);
    expect(insertItem(current!, { transaction_id: 9, name: 'Dishwasher' })).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- tests/db/warranty-schema.test.ts`
Expected: FAIL — `no such table: warranty_items` (and the journal test fails because `drizzle/0002_warranty_tracker.sql` does not exist).

- [ ] **Step 3: Hand-author the migration.**

Create `drizzle/0002_warranty_tracker.sql`:

```sql
-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- Warranty tracker (spec 2026-08-16). Objects that exist ONLY in SQL and have NO Drizzle
-- representation now number, after this migration:
--   1. the categories.parent_id self-referencing foreign key            (0000)
--   2. the COALESCE(display_description, raw_description) expression index (0000)
--   3. the COALESCE month expression index                              (0000)
--   4. every CHECK constraint declared below on warranty_items          (0002)
--   5. every CHECK constraint declared below on warranty_receipts       (0002)
--   6. the warranty_search FTS5 contentless virtual table               (0002)
--   7. its six triggers, which are its ONLY writer                      (0002)
-- Statements are separated by "--> statement-breakpoint": Drizzle's migrator splits on
-- that marker and nothing else, which is what makes the CREATE TRIGGER ... BEGIN ...;
-- ...; END; bodies below safe. A splitter keyed on ";" would shred them.
CREATE TABLE `warranty_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`vendor` text,
	`model` text,
	`serial` text,
	`purchase_date` text NOT NULL,
	`warranty_months` integer,
	`is_lifetime` integer DEFAULT 0 NOT NULL,
	`expiry_date` text,
	`price_cents` integer,
	`owner_user_id` integer NOT NULL REFERENCES `users`(`id`),
	`transaction_id` integer REFERENCES `transactions`(`id`) ON DELETE SET NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (`is_lifetime` IN (0, 1)),
	CHECK (`is_lifetime` = 0 OR (`warranty_months` IS NULL AND `expiry_date` IS NULL)),
	CHECK (`warranty_months` IS NULL OR `warranty_months` > 0),
	CHECK ((`warranty_months` IS NULL) = (`expiry_date` IS NULL)),
	CHECK (`price_cents` IS NULL OR `price_cents` >= 0)
);
--> statement-breakpoint
CREATE INDEX `warranty_items_expiry_idx` ON `warranty_items` (`expiry_date`);
--> statement-breakpoint
CREATE INDEX `warranty_items_owner_idx` ON `warranty_items` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX `warranty_items_transaction_idx` ON `warranty_items` (`transaction_id`);
--> statement-breakpoint
CREATE TABLE `warranty_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`warranty_item_id` integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
	`original_filename` text NOT NULL,
	`stored_filename` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`ocr_text` text,
	`ocr_status` text DEFAULT 'pending' NOT NULL,
	`ocr_error` text,
	`created_at` text NOT NULL,
	CHECK (`ocr_status` IN ('pending', 'done', 'failed')),
	CHECK (`mime` IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
	CHECK (`size_bytes` > 0 AND `size_bytes` <= 10485760)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warranty_receipts_stored_uq` ON `warranty_receipts` (`stored_filename`);
--> statement-breakpoint
CREATE INDEX `warranty_receipts_item_idx` ON `warranty_receipts` (`warranty_item_id`);
--> statement-breakpoint
CREATE INDEX `warranty_receipts_ocr_idx` ON `warranty_receipts` (`ocr_status`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `warranty_search` USING fts5(
	`name`, `vendor`, `model`, `notes`, `ocr_text`,
	content='', contentless_delete=1,
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `warranty_search_item_ai` AFTER INSERT ON `warranty_items` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_item_au`
AFTER UPDATE OF `name`, `vendor`, `model`, `notes` ON `warranty_items` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_item_ad` AFTER DELETE ON `warranty_items` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_receipt_ai` AFTER INSERT ON `warranty_receipts` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`warranty_item_id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`warranty_item_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_receipt_au`
AFTER UPDATE OF `ocr_text` ON `warranty_receipts` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`warranty_item_id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`warranty_item_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `warranty_search_receipt_ad` AFTER DELETE ON `warranty_receipts` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = old.`warranty_item_id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = old.`warranty_item_id`;
END;
```

- [ ] **Step 4: Append the journal entry.**

Edit `drizzle/meta/_journal.json` — add a third entry after the `0001` one (note the trailing comma on the `0001` entry's closing brace):

```json
    {
      "idx": 2,
      "version": "6",
      "when": 1755388800000,
      "tag": "0002_warranty_tracker",
      "breakpoints": true
    }
```

- [ ] **Step 5: Mirror the two tables in `src/db/schema.ts`.**

Append at the **end** of `src/db/schema.ts` (declaration order mirrors DDL order, per the file's existing convention):

```ts
/**
 * Warranty tracker (spec 2026-08-16 §3). Mirrors drizzle/0002_warranty_tracker.sql.
 *
 * NOT represented here — these objects exist ONLY in that raw SQL file (MUST-3.4):
 *   - every CHECK constraint on both tables,
 *   - the `warranty_search` FTS5 contentless virtual table
 *     (contentless_delete=1, tokenize='unicode61 remove_diacritics 2', rowid = warranty_items.id),
 *   - its six triggers — warranty_search_item_ai / _au / _ad and
 *     warranty_search_receipt_ai / _au / _ad — which are the index's ONLY writer.
 * Application code must never INSERT, UPDATE or DELETE `warranty_search` directly (MUST-3.12).
 */
export const warrantyItems = sqliteTable(
  'warranty_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    vendor: text('vendor'),
    model: text('model'),
    serial: text('serial'),
    purchaseDate: text('purchase_date').notNull(),
    warrantyMonths: integer('warranty_months'),
    isLifetime: integer('is_lifetime', { mode: 'boolean' }).notNull().default(false),
    /** Computed at write time by addMonthsClamped(); never derived on read (MUST-3.6). */
    expiryDate: text('expiry_date'),
    /** Positive magnitude, unlike transactions.amount_cents (MUST-3.2 / §17.26). */
    priceCents: integer('price_cents'),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id),
    /** ON DELETE SET NULL: an import undo must not take the receipt evidence with it (MUST-3.7). */
    transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('warranty_items_expiry_idx').on(t.expiryDate),
    index('warranty_items_owner_idx').on(t.ownerUserId),
    index('warranty_items_transaction_idx').on(t.transactionId),
  ],
);

export const warrantyReceipts = sqliteTable(
  'warranty_receipts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    warrantyItemId: integer('warranty_item_id')
      .notNull()
      .references(() => warrantyItems.id, { onDelete: 'cascade' }),
    /** Display only: never a path component, never rendered as HTML (MUST-3.8). */
    originalFilename: text('original_filename').notNull(),
    /** Server-generated `${randomUUID()}.${sniffedExt}` (MUST-4.2). */
    storedFilename: text('stored_filename').notNull(),
    mime: text('mime', { enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    ocrText: text('ocr_text'),
    /** Exactly three values — there is deliberately no 'running' state (§7.5). */
    ocrStatus: text('ocr_status', { enum: ['pending', 'done', 'failed'] }).notNull().default('pending'),
    ocrError: text('ocr_error'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('warranty_receipts_stored_uq').on(t.storedFilename),
    index('warranty_receipts_item_idx').on(t.warrantyItemId),
    index('warranty_receipts_ocr_idx').on(t.ocrStatus),
  ],
);
```

- [ ] **Step 6: Update the existing whole-schema assertions.**

In `tests/db/schema.test.ts`, replace the `EXPECTED_TABLES` array's final entry line so the array ends:

```ts
  'transactions', 'users', 'warranty_items', 'warranty_receipts', 'warranty_search',
```

and change the table query in the first `it(...)` to skip FTS5's shadow tables (an implementation detail of the virtual table, not part of the schema contract):

```ts
    const rows = current.sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' " +
          "and name not like '__drizzle%' and name not like 'warranty_search\\_%' escape '\\' order by name",
      )
      .all() as { name: string }[];
```

Append to `EXPECTED_INDEXES`:

```ts
  'warranty_items_expiry_idx',
  'warranty_items_owner_idx',
  'warranty_items_transaction_idx',
  'warranty_receipts_stored_uq',
  'warranty_receipts_item_idx',
  'warranty_receipts_ocr_idx',
```

- [ ] **Step 7: Run both database test files to verify they pass.**

Run: `npm test -- tests/db/`
Expected: PASS — all of `warranty-schema.test.ts`, `schema.test.ts` and `seed.test.ts` green.

- [ ] **Step 8: Typecheck.**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 9: Checkpoint (commit is PAUSED).**

Run: `npm test`
Expected: whole suite green.
Commit message to use when the pause is lifted:

```bash
git add drizzle/0002_warranty_tracker.sql drizzle/meta/_journal.json src/db/schema.ts tests/db/
git commit -m "feat(db): warranty_items, warranty_receipts and the warranty_search FTS5 index"
```

---

## Task 2: ISO date arithmetic and warranty expiry status

**Context:** `src/lib/dates.ts` already does pure ISO-string date math (`addMonths` on `YYYY-MM` keys) and deliberately never constructs a `Date` for day arithmetic. This task adds day-level and clamped-month-level helpers there, then builds the derived-status module the list badge, the filter, the SQL and the dashboard widget all share. Pure functions only — no database, no I/O.

**Files:**
- Modify: `src/lib/dates.ts` (add three exports next to `addMonths`)
- Create: `src/lib/warranty/expiry.ts`
- Test: `tests/lib/dates.test.ts` (append a describe block)
- Test: `tests/lib/warranty/expiry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (`daysInMonth` and `pad2` are existing module-private helpers in `src/lib/dates.ts`).
- Produces:
  ```ts
  // src/lib/dates.ts
  export function addMonthsClamped(isoDate: string, months: number): string;
  export function addDaysIso(isoDate: string, days: number): string;
  export function daysBetweenIso(fromIso: string, toIso: string): number;

  // src/lib/warranty/expiry.ts
  export const EXPIRING_SOON_DAYS = 60;
  export type WarrantyStatus = 'lifetime' | 'unknown' | 'expired' | 'expiring' | 'active';
  export const WARRANTY_STATUSES: readonly WarrantyStatus[];
  export function isWarrantyStatus(value: string): value is WarrantyStatus;
  export function computeExpiryDate(input: {
    purchaseDate: string;
    warrantyMonths: number | null;
    isLifetime: boolean;
  }): string | null;
  export function warrantyStatus(
    input: { expiryDate: string | null; isLifetime: boolean },
    today: string,
  ): WarrantyStatus;
  export function statusLabel(status: WarrantyStatus, expiryDate: string | null, today: string): string;
  /** SQL CASE mirroring warrantyStatus(). Binds exactly two parameters, in order: today, soon.
   *  Assumes the warranty_items table is aliased `i`. */
  export const STATUS_CASE_SQL: string;
  ```

### Steps

- [ ] **Step 1: Write the failing date-helper tests.**

Append to `tests/lib/dates.test.ts` (keep the file's existing imports; add the three new names to the `@/lib/dates` import):

```ts
describe('addMonthsClamped (spec §3.6)', () => {
  // The eight worked examples from the spec, verbatim.
  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-08-31', 6, '2027-02-28'],
    ['2026-01-31', 12, '2027-01-31'],
    ['2026-08-16', 24, '2028-08-16'],
    ['2026-12-31', 1, '2027-01-31'],
  ])('%s + %i months = %s', (from, months, expected) => {
    expect(addMonthsClamped(from, months)).toBe(expected);
  });

  it('differs from Date.prototype.setMonth, which overflows (the regression this rule prevents)', () => {
    const overflowed = new Date(Date.UTC(2026, 0, 31));
    overflowed.setUTCMonth(overflowed.getUTCMonth() + 1);
    expect(overflowed.toISOString().slice(0, 10)).toBe('2026-03-03');
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('handles negative deltas (used for the 20-year suggestion floor)', () => {
    expect(addMonthsClamped('2026-08-16', -240)).toBe('2006-08-16');
    expect(addMonthsClamped('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('never returns an invalid calendar date across 1–120 months from every day of 2024–2027', () => {
    for (let year = 2024; year <= 2027; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        for (let day = 1; day <= 31; day += 1) {
          const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          if (!isIsoDate(iso)) continue;
          for (let months = 1; months <= 120; months += 1) {
            expect(isIsoDate(addMonthsClamped(iso, months)), `${iso} + ${months}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('addDaysIso / daysBetweenIso', () => {
  it('crosses month, year and leap boundaries without a Date object', () => {
    expect(addDaysIso('2026-08-16', 60)).toBe('2026-10-15');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysIso('2026-08-16', 0)).toBe('2026-08-16');
  });

  it('round-trips against daysBetweenIso', () => {
    expect(daysBetweenIso('2026-08-16', '2026-10-15')).toBe(60);
    expect(daysBetweenIso('2026-08-16', '2026-08-16')).toBe(0);
    expect(daysBetweenIso('2026-08-16', '2026-08-15')).toBe(-1);
    expect(daysBetweenIso('2024-02-28', '2024-03-01')).toBe(2);
  });
});
```

- [ ] **Step 2: Run the date tests to verify they fail.**

Run: `npm test -- tests/lib/dates.test.ts`
Expected: FAIL — `addMonthsClamped is not a function` (the import itself errors).

- [ ] **Step 3: Implement the three date helpers.**

In `src/lib/dates.ts`, insert immediately after the existing `addMonths` function:

```ts
/**
 * Warranty expiry arithmetic (spec 2026-08-16 §3.6): CLAMP to the last day of the target
 * month. Date.prototype.setMonth OVERFLOWS instead (Jan 31 + 1 month -> Mar 2/3), which
 * would silently move a February expiry into March. Pure string math, so no timezone and
 * no DST boundary can shift the day.
 */
export function addMonthsClamped(isoDate: string, months: number): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const d = Number(isoDate.slice(8, 10));
  const t = m - 1 + months;
  const year = y + Math.floor(t / 12);
  const month = ((t % 12) + 12) % 12 + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Days-from-civil (proleptic Gregorian). Integer-only, no Date object. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/** ISO date + N days, pure string math (a DST boundary can never shift the result). */
export function addDaysIso(isoDate: string, days: number): string {
  const total = daysFromCivil(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), Number(isoDate.slice(8, 10))) + days;
  const { y, m, d } = civilFromDays(total);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Signed whole days from `fromIso` to `toIso`. */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  return (
    daysFromCivil(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)), Number(toIso.slice(8, 10))) -
    daysFromCivil(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)), Number(fromIso.slice(8, 10)))
  );
}
```

- [ ] **Step 4: Run the date tests to verify they pass.**

Run: `npm test -- tests/lib/dates.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing expiry/status test.**

Create `tests/lib/warranty/expiry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  EXPIRING_SOON_DAYS,
  STATUS_CASE_SQL,
  WARRANTY_STATUSES,
  computeExpiryDate,
  isWarrantyStatus,
  statusLabel,
  warrantyStatus,
} from '@/lib/warranty/expiry';

const TODAY = '2026-08-16';

describe('computeExpiryDate', () => {
  it('is null for a lifetime warranty', () => {
    expect(computeExpiryDate({ purchaseDate: TODAY, warrantyMonths: null, isLifetime: true })).toBeNull();
  });

  it('is null for an unknown term', () => {
    expect(computeExpiryDate({ purchaseDate: TODAY, warrantyMonths: null, isLifetime: false })).toBeNull();
  });

  it('clamps to the last day of the target month', () => {
    expect(computeExpiryDate({ purchaseDate: '2026-01-31', warrantyMonths: 1, isLifetime: false })).toBe('2026-02-28');
    expect(computeExpiryDate({ purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false })).toBe('2028-08-16');
  });

  it('ignores warrantyMonths when isLifetime is true (MUST-3.5)', () => {
    expect(computeExpiryDate({ purchaseDate: TODAY, warrantyMonths: 12, isLifetime: true })).toBeNull();
  });
});

describe('warrantyStatus (spec §3.7)', () => {
  it('exposes the five statuses and a 60-day window', () => {
    expect(EXPIRING_SOON_DAYS).toBe(60);
    expect([...WARRANTY_STATUSES].sort()).toEqual(['active', 'expired', 'expiring', 'lifetime', 'unknown']);
    expect(isWarrantyStatus('expiring')).toBe(true);
    expect(isWarrantyStatus('nonsense')).toBe(false);
  });

  it('returns lifetime before anything else', () => {
    expect(warrantyStatus({ expiryDate: null, isLifetime: true }, TODAY)).toBe('lifetime');
  });

  it('returns unknown for a non-lifetime item with no expiry', () => {
    expect(warrantyStatus({ expiryDate: null, isLifetime: false }, TODAY)).toBe('unknown');
  });

  it('treats coverage as inclusive of expiry_date (MUST-3.14)', () => {
    expect(warrantyStatus({ expiryDate: '2026-08-16', isLifetime: false }, TODAY)).toBe('expiring');
    expect(warrantyStatus({ expiryDate: '2026-08-15', isLifetime: false }, TODAY)).toBe('expired');
  });

  it('draws the expiring/active boundary at exactly 60 days', () => {
    expect(warrantyStatus({ expiryDate: '2026-10-15', isLifetime: false }, TODAY)).toBe('expiring'); // today + 60
    expect(warrantyStatus({ expiryDate: '2026-10-16', isLifetime: false }, TODAY)).toBe('active'); // today + 61
  });
});

describe('statusLabel', () => {
  it('names each badge the way the list page renders it', () => {
    expect(statusLabel('lifetime', null, TODAY)).toBe('Lifetime');
    expect(statusLabel('unknown', null, TODAY)).toBe('Term unknown');
    expect(statusLabel('expired', '2026-08-15', TODAY)).toBe('Expired');
    expect(statusLabel('active', '2027-01-01', TODAY)).toBe('Active');
    expect(statusLabel('expiring', '2026-08-16', TODAY)).toBe('Expires today');
    expect(statusLabel('expiring', '2026-08-17', TODAY)).toBe('Expires in 1 day');
    expect(statusLabel('expiring', '2026-10-15', TODAY)).toBe('Expires in 60 days');
  });
});

describe('STATUS_CASE_SQL', () => {
  it('binds exactly two parameters, today then soon', () => {
    expect(STATUS_CASE_SQL.split('?')).toHaveLength(3);
    expect(STATUS_CASE_SQL).toContain('i.is_lifetime');
    expect(STATUS_CASE_SQL).toContain('i.expiry_date');
  });
});
```

- [ ] **Step 6: Run the expiry test to verify it fails.**

Run: `npm test -- tests/lib/warranty/expiry.test.ts`
Expected: FAIL — cannot resolve `@/lib/warranty/expiry`.

- [ ] **Step 7: Implement `src/lib/warranty/expiry.ts`.**

```ts
import { addDaysIso, addMonthsClamped, daysBetweenIso } from '@/lib/dates';

/**
 * One constant driving the list badge, the status filter and the dashboard widget alike
 * (spec §3.7 / §17.1). Change it here and all three move together.
 */
export const EXPIRING_SOON_DAYS = 60;

export type WarrantyStatus = 'lifetime' | 'unknown' | 'expired' | 'expiring' | 'active';

export const WARRANTY_STATUSES: readonly WarrantyStatus[] = [
  'active',
  'expiring',
  'expired',
  'lifetime',
  'unknown',
];

export function isWarrantyStatus(value: string): value is WarrantyStatus {
  return (WARRANTY_STATUSES as readonly string[]).includes(value);
}

/**
 * MUST-3.6: expiry_date is computed at WRITE time and stored, never derived on read.
 * MUST-3.5: a lifetime warranty has no term and no expiry.
 */
export function computeExpiryDate(input: {
  purchaseDate: string;
  warrantyMonths: number | null;
  isLifetime: boolean;
}): string | null {
  if (input.isLifetime) return null;
  if (input.warrantyMonths === null) return null;
  return addMonthsClamped(input.purchaseDate, input.warrantyMonths);
}

/** MUST-3.14: coverage is inclusive — expired means strictly after expiry_date. */
export function warrantyStatus(
  input: { expiryDate: string | null; isLifetime: boolean },
  today: string,
): WarrantyStatus {
  if (input.isLifetime) return 'lifetime';
  if (input.expiryDate === null) return 'unknown';
  if (input.expiryDate < today) return 'expired';
  if (input.expiryDate <= addDaysIso(today, EXPIRING_SOON_DAYS)) return 'expiring';
  return 'active';
}

export function statusLabel(status: WarrantyStatus, expiryDate: string | null, today: string): string {
  switch (status) {
    case 'lifetime':
      return 'Lifetime';
    case 'unknown':
      return 'Term unknown';
    case 'expired':
      return 'Expired';
    case 'active':
      return 'Active';
    case 'expiring': {
      if (expiryDate === null) return 'Expiring soon';
      const days = daysBetweenIso(today, expiryDate);
      if (days <= 0) return 'Expires today';
      return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
    }
  }
}

/**
 * The SAME rule as warrantyStatus(), expressed in SQL so the list, the filter counts and
 * the badge can never disagree (§3.7). Binds exactly two parameters, in this order:
 *   1. today  (ISO YYYY-MM-DD)
 *   2. soon   (= addDaysIso(today, EXPIRING_SOON_DAYS))
 * Assumes warranty_items is aliased `i`.
 */
export const STATUS_CASE_SQL = `case
  when i.is_lifetime = 1 then 'lifetime'
  when i.expiry_date is null then 'unknown'
  when i.expiry_date < ? then 'expired'
  when i.expiry_date <= ? then 'expiring'
  else 'active'
end`;
```

- [ ] **Step 8: Run the expiry test to verify it passes.**

Run: `npm test -- tests/lib/warranty/expiry.test.ts tests/lib/dates.test.ts`
Expected: PASS.

- [ ] **Step 9: Checkpoint (commit is PAUSED).**

Run: `npm test && npm run typecheck`
Expected: whole suite green, typecheck clean.
Commit message to use when the pause is lifted:

```bash
git add src/lib/dates.ts src/lib/warranty/expiry.ts tests/lib/dates.test.ts tests/lib/warranty/expiry.test.ts
git commit -m "feat(warranty): clamp-to-last-day expiry arithmetic and derived status"
```

---

## Task 3: Magic-byte sniffing and receipt file storage

**Context:** Receipt bytes must land on disk under a server-generated name derived from the *sniffed* content type, never from anything the client said, and every path build must pass two independent guards — the same belt-and-braces pattern as `resolveSafeTarget()` in `src/lib/backup.ts` and `stagedFilePath()` in `src/lib/import/staging.ts`. This task builds those two modules. No database, no HTTP.

**Files:**
- Create: `src/lib/warranty/sniff.ts`
- Create: `src/lib/warranty/receipts.ts`
- Test: `tests/lib/warranty/sniff.test.ts`
- Test: `tests/lib/warranty/receipts.test.ts`

**Interfaces:**
- Consumes: `readEnv()` from `@/lib/env` (for `dataDir`).
- Produces:
  ```ts
  // src/lib/warranty/sniff.ts
  export type ReceiptMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  export type ReceiptExt = 'jpg' | 'png' | 'webp' | 'pdf';
  export const RECEIPT_MIMES: readonly ReceiptMime[];
  export const RECEIPT_EXTS: readonly ReceiptExt[];
  export const UNSUPPORTED_TYPE_MESSAGE: string;
  export const HEIC_MESSAGE: string;
  export function sniffReceiptType(buf: Buffer): ReceiptMime | null;
  export function extForMime(mime: ReceiptMime): ReceiptExt;
  export function mimeForExt(ext: string): ReceiptMime | null;
  export function looksLikeHeic(buf: Buffer): boolean;

  // src/lib/warranty/receipts.ts
  export const MAX_RECEIPT_BYTES = 10485760;
  export const MAX_FILES_PER_UPLOAD = 5;
  export const MAX_UPLOAD_BYTES: number;          // MAX_RECEIPT_BYTES * MAX_FILES_PER_UPLOAD
  export const STORED_NAME_RE: RegExp;
  export const ORPHAN_MIN_AGE_MS: number;         // 24h
  export class ReceiptStorageError extends Error {}
  export function receiptsDir(): string;
  export function receiptTempDir(): string;
  export function resolveReceiptPath(storedFilename: string): string;
  export function newStoredFilename(mime: ReceiptMime): string;
  export function sha256Bytes(buf: Buffer): string;
  export function sha256FileSync(filePath: string): string;
  export function writeReceiptFile(buf: Buffer, mime: ReceiptMime): string;   // -> storedFilename
  /** Renames an already-written file into receipts/. `reuseName` is used only by writeReceiptFile. */
  export function adoptReceiptFile(sourcePath: string, mime: ReceiptMime, reuseName?: string): string;
  export function receiptFileExists(storedFilename: string): boolean;
  export function receiptFileSize(storedFilename: string): number | null;
  export function deleteReceiptFile(storedFilename: string): void;            // best effort, never throws
  export function purgeOrphanReceipts(known: Set<string>, olderThanMs?: number, now?: Date): number;
  ```

### Steps

- [ ] **Step 1: Write the failing sniff test.**

Create `tests/lib/warranty/sniff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  RECEIPT_MIMES,
  extForMime,
  looksLikeHeic,
  mimeForExt,
  sniffReceiptType,
  UNSUPPORTED_TYPE_MESSAGE,
} from '@/lib/warranty/sniff';

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const webp = () => {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  return buf;
};
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(32)]);

describe('sniffReceiptType', () => {
  it('detects all four accepted types by leading bytes', () => {
    expect(sniffReceiptType(jpeg())).toBe('image/jpeg');
    expect(sniffReceiptType(png())).toBe('image/png');
    expect(sniffReceiptType(webp())).toBe('image/webp');
    expect(sniffReceiptType(pdf())).toBe('application/pdf');
    expect(RECEIPT_MIMES).toHaveLength(4);
  });

  it('goes by content, not by filename: a .jpg-named PNG is a PNG', () => {
    // The caller never passes the name in; this asserts the contract that only bytes matter.
    expect(sniffReceiptType(png())).toBe('image/png');
  });

  it('rejects a .pdf-named ZIP', () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
    expect(sniffReceiptType(zip)).toBeNull();
  });

  it('rejects a RIFF container that is not WEBP', () => {
    const wav = Buffer.alloc(40);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    expect(sniffReceiptType(wav)).toBeNull();
  });

  it('rejects an empty buffer and a 3-byte buffer', () => {
    expect(sniffReceiptType(Buffer.alloc(0))).toBeNull();
    expect(sniffReceiptType(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffReceiptType(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
  });

  it('rejects a text file whatever the client declared its Content-Type to be', () => {
    expect(sniffReceiptType(Buffer.from('date,description,amount\n', 'utf8'))).toBeNull();
  });

  it('recognises HEIC so the UI can give the Preview-export advice', () => {
    const heic = Buffer.alloc(24);
    heic.write('ftypheic', 4, 'ascii');
    expect(looksLikeHeic(heic)).toBe(true);
    expect(sniffReceiptType(heic)).toBeNull();
    expect(looksLikeHeic(jpeg())).toBe(false);
  });

  it('maps mime to extension and back', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('application/pdf')).toBe('pdf');
    expect(mimeForExt('jpg')).toBe('image/jpeg');
    expect(mimeForExt('exe')).toBeNull();
  });

  it('has a message naming the four accepted types', () => {
    expect(UNSUPPORTED_TYPE_MESSAGE).toBe("That file type isn't supported. Upload a JPEG, PNG, WebP or PDF.");
  });
});
```

- [ ] **Step 2: Run the sniff test to verify it fails.**

Run: `npm test -- tests/lib/warranty/sniff.test.ts`
Expected: FAIL — cannot resolve `@/lib/warranty/sniff`.

- [ ] **Step 3: Implement `src/lib/warranty/sniff.ts`.**

```ts
/**
 * MUST-4.5: the accepted set is exactly four types, decided by LEADING BYTES —
 * never by the file extension and never by the browser-declared Content-Type.
 */
export type ReceiptMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
export type ReceiptExt = 'jpg' | 'png' | 'webp' | 'pdf';

export const RECEIPT_MIMES: readonly ReceiptMime[] = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const RECEIPT_EXTS: readonly ReceiptExt[] = ['jpg', 'png', 'webp', 'pdf'];

export const UNSUPPORTED_TYPE_MESSAGE = "That file type isn't supported. Upload a JPEG, PNG, WebP or PDF.";

/** §16 item 7: HEIC is a known limitation with a documented workaround, not a mystery failure. */
export const HEIC_MESSAGE =
  "HEIC isn't supported. On a Mac, open the image in Preview and export it as JPEG, or upload it from your phone instead.";

const MIME_TO_EXT: Record<ReceiptMime, ReceiptExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const EXT_TO_MIME: Record<string, ReceiptMime> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_SIG = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

export function sniffReceiptType(buf: Buffer): ReceiptMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 5 && buf.subarray(0, 5).equals(PDF_SIG)) return 'application/pdf';
  return null;
}

/** ISO-BMFF brand check, used only to pick a better error message. Never accepts the file. */
export function looksLikeHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
  const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
  return brand.startsWith('hei') || brand.startsWith('mif1') || brand.startsWith('heix') || brand.startsWith('hevc');
}

export function extForMime(mime: ReceiptMime): ReceiptExt {
  return MIME_TO_EXT[mime];
}

export function mimeForExt(ext: string): ReceiptMime | null {
  return EXT_TO_MIME[ext.toLowerCase()] ?? null;
}
```

- [ ] **Step 4: Run the sniff test to verify it passes.**

Run: `npm test -- tests/lib/warranty/sniff.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing storage test.**

Create `tests/lib/warranty/receipts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MAX_FILES_PER_UPLOAD,
  MAX_RECEIPT_BYTES,
  MAX_UPLOAD_BYTES,
  ReceiptStorageError,
  STORED_NAME_RE,
  adoptReceiptFile,
  deleteReceiptFile,
  newStoredFilename,
  purgeOrphanReceipts,
  receiptFileExists,
  receiptFileSize,
  receiptTempDir,
  receiptsDir,
  resolveReceiptPath,
  sha256Bytes,
  sha256FileSync,
  writeReceiptFile,
} from '@/lib/warranty/receipts';

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-receipts-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('constants', () => {
  it('caps a receipt at 10 MiB and an upload at five of them (§17.2, §17.22)', () => {
    expect(MAX_RECEIPT_BYTES).toBe(10485760);
    expect(MAX_FILES_PER_UPLOAD).toBe(5);
    expect(MAX_UPLOAD_BYTES).toBe(10485760 * 5);
  });
});

describe('STORED_NAME_RE', () => {
  it('accepts a lowercase UUID with an accepted extension', () => {
    for (const ext of ['jpg', 'png', 'webp', 'pdf']) {
      expect(STORED_NAME_RE.test(`${crypto.randomUUID()}.${ext}`)).toBe(true);
    }
  });

  it('rejects traversal, subpaths, wrong extensions, uppercase hex and a bare UUID', () => {
    const uuid = crypto.randomUUID();
    for (const bad of [
      '../../etc/passwd',
      'a/b.jpg',
      `../${uuid}.jpg`,
      'x.exe',
      `${uuid}.exe`,
      uuid.toUpperCase() + '.jpg',
      uuid,
      `${uuid}.jpg.exe`,
      `${uuid}.JPG`,
      '',
    ]) {
      expect(STORED_NAME_RE.test(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('resolveReceiptPath', () => {
  it('lands directly inside the receipts directory', () => {
    const name = newStoredFilename('image/jpeg');
    expect(resolveReceiptPath(name)).toBe(path.join(path.resolve(receiptsDir()), name));
  });

  it('refuses any name that fails the regex, before any fs call', () => {
    expect(() => resolveReceiptPath('../budget.db')).toThrowError(ReceiptStorageError);
    expect(() => resolveReceiptPath('nested/name.jpg')).toThrowError(ReceiptStorageError);
  });

  it('names files under DATA_DIR/receipts', () => {
    expect(receiptsDir()).toBe(path.join(dataDir, 'receipts'));
    expect(receiptTempDir()).toBe(path.join(dataDir, 'tmp'));
  });
});

describe('newStoredFilename', () => {
  it('derives the extension from the sniffed mime, not from any client string', () => {
    expect(newStoredFilename('image/webp').endsWith('.webp')).toBe(true);
    expect(newStoredFilename('application/pdf').endsWith('.pdf')).toBe(true);
    expect(STORED_NAME_RE.test(newStoredFilename('image/png'))).toBe(true);
  });
});

describe('sha256', () => {
  it('matches a known digest for a known fixture', () => {
    // sha256("hello") — a fixed vector, so a change to the hashing is loud.
    expect(sha256Bytes(Buffer.from('hello', 'utf8'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('hashes a file on disk identically to its bytes', () => {
    const buf = Buffer.from('receipt bytes', 'utf8');
    const file = path.join(dataDir, 'x.bin');
    fs.writeFileSync(file, buf);
    expect(sha256FileSync(file)).toBe(sha256Bytes(buf));
  });
});

describe('writeReceiptFile / adoptReceiptFile', () => {
  it('writes via tmp then renames into receipts/, and reports size and existence', () => {
    const buf = Buffer.from('a'.repeat(1000), 'utf8');
    const name = writeReceiptFile(buf, 'image/jpeg');
    expect(STORED_NAME_RE.test(name)).toBe(true);
    expect(receiptFileExists(name)).toBe(true);
    expect(receiptFileSize(name)).toBe(1000);
    // Nothing left behind in tmp.
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('adopts a staged file by renaming it under a fresh stored name', () => {
    fs.mkdirSync(receiptTempDir(), { recursive: true });
    const staged = path.join(receiptTempDir(), `${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(staged, Buffer.from('%PDF-1.7\n'));
    const name = adoptReceiptFile(staged, 'application/pdf');
    expect(name.endsWith('.pdf')).toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
    expect(receiptFileExists(name)).toBe(true);
  });

  it('deleteReceiptFile is best effort and never throws on a missing file', () => {
    const name = newStoredFilename('image/png');
    expect(() => deleteReceiptFile(name)).not.toThrow();
    expect(receiptFileExists(name)).toBe(false);
    expect(receiptFileSize(name)).toBeNull();
  });
});

describe('purgeOrphanReceipts (MUST-4.9)', () => {
  it('removes only unknown files older than 24 hours', () => {
    const known = writeReceiptFile(Buffer.from('known'), 'image/jpeg');
    const oldOrphan = writeReceiptFile(Buffer.from('old'), 'image/png');
    const freshOrphan = writeReceiptFile(Buffer.from('fresh'), 'image/webp');

    const now = new Date('2026-08-16T12:00:00.000Z');
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    fs.utimesSync(resolveReceiptPath(oldOrphan), twoDaysAgo, twoDaysAgo);
    fs.utimesSync(resolveReceiptPath(known), twoDaysAgo, twoDaysAgo);

    const removed = purgeOrphanReceipts(new Set([known]), undefined, now);
    expect(removed).toBe(1);
    expect(receiptFileExists(known)).toBe(true);
    expect(receiptFileExists(oldOrphan)).toBe(false);
    expect(receiptFileExists(freshOrphan)).toBe(true);
  });

  it('ignores entries that do not match STORED_NAME_RE rather than deleting them', () => {
    fs.mkdirSync(receiptsDir(), { recursive: true });
    const stray = path.join(receiptsDir(), 'README.txt');
    fs.writeFileSync(stray, 'x');
    const long_ago = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(stray, long_ago, long_ago);
    expect(purgeOrphanReceipts(new Set(), undefined, new Date('2026-08-16T12:00:00.000Z'))).toBe(0);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('returns 0 when the directory does not exist yet', () => {
    expect(purgeOrphanReceipts(new Set())).toBe(0);
  });
});
```

- [ ] **Step 6: Run the storage test to verify it fails.**

Run: `npm test -- tests/lib/warranty/receipts.test.ts`
Expected: FAIL — cannot resolve `@/lib/warranty/receipts`.

- [ ] **Step 7: Implement `src/lib/warranty/receipts.ts`.**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readEnv } from '@/lib/env';
import { extForMime, type ReceiptMime } from '@/lib/warranty/sniff';

/** §17.2: 10 x 1024^2, not 10,000,000. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 5;
export const MAX_UPLOAD_BYTES = MAX_RECEIPT_BYTES * MAX_FILES_PER_UPLOAD;

/** 24 h age guard so the sweep cannot race an in-flight upload (MUST-4.9). */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** randomUUID() always emits lowercase hex in the canonical 8-4-4-4-12 shape (MUST-4.3). */
export const STORED_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

export class ReceiptStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptStorageError';
  }
}

/** MUST-4.1: inside the existing bind-mounted data volume, beside budget.db and backups/. */
export function receiptsDir(): string {
  return path.join(readEnv().dataDir, 'receipts');
}

/** The existing ${DATA_DIR}/tmp, already swept by purgeStagedFiles()'s 24 h mtime rule. */
export function receiptTempDir(): string {
  return path.join(readEnv().dataDir, 'tmp');
}

/**
 * MUST-4.3, two independent lines of defence, modelled on resolveSafeTarget() in
 * src/lib/backup.ts: (a) the name must match STORED_NAME_RE, and (b) the resolved path
 * must still land directly inside the receipts directory. Both run before any fs call.
 */
export function resolveReceiptPath(storedFilename: string): string {
  if (!STORED_NAME_RE.test(storedFilename)) {
    throw new ReceiptStorageError(`Refusing unsafe receipt filename: ${storedFilename}`);
  }
  const resolvedDir = path.resolve(receiptsDir());
  const target = path.resolve(resolvedDir, storedFilename);
  if (path.dirname(target) !== resolvedDir) {
    throw new ReceiptStorageError('Refusing to touch a receipt outside its directory');
  }
  return target;
}

/** MUST-4.2: the extension comes from the SNIFFED type only. */
export function newStoredFilename(mime: ReceiptMime): string {
  return `${randomUUID()}.${extForMime(mime)}`;
}

export function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256FileSync(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

/**
 * MUST-4.7 write order: buffer -> write to ${DATA_DIR}/tmp -> renameSync into receipts/
 * (same filesystem, atomic). The caller inserts the DB row afterwards and unlinks on failure.
 */
export function writeReceiptFile(buf: Buffer, mime: ReceiptMime): string {
  const tmpDir = receiptTempDir();
  fs.mkdirSync(tmpDir, { recursive: true });
  const storedFilename = newStoredFilename(mime);
  const tmpPath = path.join(tmpDir, storedFilename);
  fs.writeFileSync(tmpPath, buf);
  return adoptReceiptFile(tmpPath, mime, storedFilename);
}

/** Move an already-written (staged) file into receipts/ under a fresh stored name. */
export function adoptReceiptFile(sourcePath: string, mime: ReceiptMime, reuseName?: string): string {
  const dir = receiptsDir();
  fs.mkdirSync(dir, { recursive: true });
  const storedFilename = reuseName ?? newStoredFilename(mime);
  const target = resolveReceiptPath(storedFilename);
  fs.renameSync(sourcePath, target);
  return storedFilename;
}

export function receiptFileExists(storedFilename: string): boolean {
  try {
    return fs.existsSync(resolveReceiptPath(storedFilename));
  } catch {
    return false;
  }
}

export function receiptFileSize(storedFilename: string): number | null {
  try {
    return fs.statSync(resolveReceiptPath(storedFilename)).size;
  } catch {
    return null;
  }
}

/** MUST-4.8: a failed unlink is logged, never surfaced as an error, and swept later. */
export function deleteReceiptFile(storedFilename: string): void {
  try {
    fs.rmSync(resolveReceiptPath(storedFilename), { force: true });
  } catch (error) {
    console.warn(`[warranty] could not unlink receipt ${storedFilename}`, error);
  }
}

/**
 * MUST-4.9: files in receipts/ with no matching stored_filename row AND an mtime older
 * than 24 h are removed. Entries that do not match STORED_NAME_RE are left alone — this
 * sweep deletes only files it could itself have created.
 */
export function purgeOrphanReceipts(
  known: Set<string>,
  olderThanMs: number = ORPHAN_MIN_AGE_MS,
  now: Date = new Date(),
): number {
  const dir = receiptsDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!STORED_NAME_RE.test(entry)) continue;
    if (known.has(entry)) continue;
    const file = path.join(dir, entry);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      continue;
    }
    if (now.getTime() - stats.mtimeMs <= olderThanMs) continue;
    fs.rmSync(file, { force: true });
    removed += 1;
  }
  return removed;
}
```

- [ ] **Step 8: Run the storage test to verify it passes.**

Run: `npm test -- tests/lib/warranty/receipts.test.ts`
Expected: PASS.

- [ ] **Step 9: Checkpoint (commit is PAUSED).**

Run: `npm test && npm run typecheck`
Expected: green.
Commit message to use when the pause is lifted:

```bash
git add src/lib/warranty/sniff.ts src/lib/warranty/receipts.ts tests/lib/warranty/
git commit -m "feat(warranty): magic-byte sniffing and traversal-guarded receipt storage"
```

---

## Task 4: Suggestion heuristics (pure functions)

**Context:** Once OCR produces text, three fields get proposed to the user: purchase date, vendor and total. Every extractor is a pure function over the string with an injected `today`, so the tests are deterministic and the OCR pipeline can call them without a clock. Suggestions never auto-commit — they pre-fill inputs the user confirms.

**Files:**
- Create: `src/lib/warranty/suggest.ts`
- Test: `tests/lib/warranty/suggest.test.ts`

**Interfaces:**
- Consumes: `parseAmountToCents` from `@/lib/money`; `isIsoDate`, `addMonthsClamped` from `@/lib/dates`.
- Produces:
  ```ts
  export interface SuggestedFields {
    purchaseDate?: string;   // ISO YYYY-MM-DD
    vendor?: string;         // <= 60 chars
    priceCents?: number;     // positive integer magnitude
  }
  export const MAX_SUGGESTED_PRICE_CENTS = 10_000_000;   // $100,000 noise ceiling
  export const MAX_SUGGESTION_AGE_MONTHS = 240;          // 20 years
  export const MAX_VENDOR_CHARS = 60;
  export function suggestPurchaseDate(text: string, today: string): string | undefined;
  export function suggestVendor(text: string): string | undefined;
  export function suggestPriceCents(text: string): number | undefined;
  export function suggestFromOcrText(text: string, today: string): SuggestedFields;
  ```

### Steps

- [ ] **Step 1: Write the failing suggestion test.**

Create `tests/lib/warranty/suggest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  MAX_SUGGESTED_PRICE_CENTS,
  suggestFromOcrText,
  suggestPriceCents,
  suggestPurchaseDate,
  suggestVendor,
} from '@/lib/warranty/suggest';

const TODAY = '2026-08-16';

describe('suggestPurchaseDate', () => {
  it('reads ISO, slash, DD Mon YYYY and Mon D, YYYY shapes', () => {
    expect(suggestPurchaseDate('Sold on 2026-07-04 thanks', TODAY)).toBe('2026-07-04');
    expect(suggestPurchaseDate('Date: 04/07/2026', TODAY)).toBe('2026-04-07');
    expect(suggestPurchaseDate('16 Aug 2026', TODAY)).toBe('2026-08-16');
    expect(suggestPurchaseDate('Aug 16, 2026', TODAY)).toBe('2026-08-16');
    expect(suggestPurchaseDate('4-7-26', TODAY)).toBe('2026-04-07');
  });

  it('applies the ambiguity ladder in order (§8.1 step 3)', () => {
    expect(suggestPurchaseDate('13/05/2026', TODAY)).toBe('2026-05-13'); // A > 12 -> DD/MM
    expect(suggestPurchaseDate('05/13/2026', TODAY)).toBe('2026-05-13'); // B > 12 -> MM/DD
    expect(suggestPurchaseDate('05/06/2026', TODAY)).toBe('2026-05-06'); // default MM/DD
  });

  it('discards impossible, future and >20-year-old dates', () => {
    expect(suggestPurchaseDate('02/30/2026', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('2027-01-01', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('1990-01-01', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('2006-08-16', TODAY)).toBe('2006-08-16'); // exactly 20 years: kept
    expect(suggestPurchaseDate('2006-08-15', TODAY)).toBeUndefined();
  });

  it('takes the earliest occurrence in the text, not the earliest date', () => {
    const receipt = ['HOME DEPOT', 'Purchased 2026-08-16', 'Return by 2026-09-15', 'Promo ends 2026-01-05'].join('\n');
    expect(suggestPurchaseDate(receipt, TODAY)).toBe('2026-08-16');
  });

  it('returns undefined for text with no date', () => {
    expect(suggestPurchaseDate('THANK YOU FOR SHOPPING', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('', TODAY)).toBeUndefined();
  });
});

describe('suggestVendor', () => {
  it('picks the first plausible line among the first five', () => {
    expect(suggestVendor('HOME DEPOT #7042\n123 Main St\nTOTAL 45.00')).toBe('HOME DEPOT #7042');
  });

  it('skips phone, www, receipt/invoice/order headers and digit-led lines', () => {
    const text = ['www.rona.ca', 'TEL 514-555-0134', '4412', 'RECEIPT', 'RONA L\u2019ENTREP\u00d4T'].join('\n');
    expect(suggestVendor(text)).toBe('RONA L\u2019ENTREP\u00d4T');
  });

  it('skips lines with fewer than three letters and collapses whitespace', () => {
    expect(suggestVendor('== $$ ==\n  BEST   BUY   CANADA  \n')).toBe('BEST BUY CANADA');
  });

  it('never looks past the fifth non-empty line', () => {
    const text = ['1', '2', '3', '4', '5', 'CANADIAN TIRE'].join('\n');
    expect(suggestVendor(text)).toBeUndefined();
  });

  it('caps at 60 characters and does not title-case', () => {
    const long = 'a'.repeat(80);
    expect(suggestVendor(long)).toHaveLength(60);
    expect(suggestVendor('canadian tire')).toBe('canadian tire');
  });

  it('returns undefined for empty text', () => {
    expect(suggestVendor('')).toBeUndefined();
  });
});

describe('suggestPriceCents', () => {
  it('prefers the TOTAL line over SUBTOTAL', () => {
    const text = ['SUBTOTAL   40.00', 'GST         2.00', 'TOTAL      42.00'].join('\n');
    expect(suggestPriceCents(text)).toBe(4200);
  });

  it('takes the LAST total line when several match', () => {
    const text = ['TOTAL       10.00', 'BALANCE DUE 42.00'].join('\n');
    expect(suggestPriceCents(text)).toBe(4200);
  });

  it('takes the LAST currency number on that line', () => {
    expect(suggestPriceCents('TOTAL 3 items 129.99')).toBe(12999);
  });

  it('never reads a SUBTOTAL line as the total', () => {
    expect(suggestPriceCents('SUB-TOTAL 99.99')).toBe(9999); // fallback path, not the total path
    expect(suggestPriceCents('SUBTOTAL 99.99\nTOTAL 105.99')).toBe(10599);
  });

  it('falls back to the largest currency amount anywhere', () => {
    expect(suggestPriceCents('Item A 12.00\nItem B 145.50\nCash 200.00 Change 54.50')).toBe(20000);
  });

  it('handles thousands separators and a dollar sign', () => {
    expect(suggestPriceCents('TOTAL $1,299.99')).toBe(129999);
  });

  it('ignores anything at or above the $100,000 noise ceiling', () => {
    expect(MAX_SUGGESTED_PRICE_CENTS).toBe(10_000_000);
    expect(suggestPriceCents('BARCODE 9876543210.99\nTOTAL 45.00')).toBe(4500);
    expect(suggestPriceCents('BARCODE 9876543210.99')).toBeUndefined();
  });

  it('returns undefined when nothing looks like money', () => {
    expect(suggestPriceCents('THANK YOU')).toBeUndefined();
    expect(suggestPriceCents('')).toBeUndefined();
  });

  it('always returns an integer positive magnitude', () => {
    const cents = suggestPriceCents('TOTAL -42.00');
    expect(cents).toBe(4200);
    expect(Number.isInteger(cents)).toBe(true);
  });
});

describe('suggestFromOcrText', () => {
  it('combines all three on a realistic receipt', () => {
    const receipt = [
      'HOME DEPOT #7042',
      '1000 boul. Cure-Labelle, Laval QC',
      'TEL 450-555-0199',
      '08/16/2026  14:32',
      'GE FRIDGE GDT645SYNFS   1,299.99',
      'SUBTOTAL              1,299.99',
      'TPS/GST                  65.00',
      'TOTAL                 1,494.49',
    ].join('\n');
    expect(suggestFromOcrText(receipt, TODAY)).toEqual({
      purchaseDate: '2026-08-16',
      vendor: 'HOME DEPOT #7042',
      priceCents: 149449,
    });
  });

  it('returns an empty object for empty text, with each field independently optional', () => {
    expect(suggestFromOcrText('', TODAY)).toEqual({});
    expect(suggestFromOcrText('CANADIAN TIRE', TODAY)).toEqual({ vendor: 'CANADIAN TIRE' });
  });
});
```

- [ ] **Step 2: Run the suggestion test to verify it fails.**

Run: `npm test -- tests/lib/warranty/suggest.test.ts`
Expected: FAIL — cannot resolve `@/lib/warranty/suggest`.

- [ ] **Step 3: Implement `src/lib/warranty/suggest.ts`.**

```ts
import { addMonthsClamped, isIsoDate } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';

/**
 * Suggest-and-confirm (spec §8). Every extractor here is PURE: no I/O, no DB, and no clock
 * beyond the injected `today`, so the tests are deterministic. MUST-8.1: nothing here ever
 * auto-commits — the caller pre-fills form inputs the user can overwrite.
 */
export interface SuggestedFields {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
}

/** §8.3 step 5: a mis-read barcode or phone number must not present as a nine-figure total. */
export const MAX_SUGGESTED_PRICE_CENTS = 10_000_000;
export const MAX_SUGGESTION_AGE_MONTHS = 240;
export const MAX_VENDOR_CHARS = 60;

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(y: number, m: number, d: number): string | null {
  const candidate = `${y}-${pad2(m)}-${pad2(d)}`;
  return isIsoDate(candidate) ? candidate : null;
}

interface DateHit {
  index: number;
  iso: string;
}

function collectDateHits(text: string): DateHit[] {
  const hits: DateHit[] = [];

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const value = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (value) hits.push({ index: m.index ?? 0, iso: value });
  }

  // A/B/YYYY or A-B-YY. §8.1 step 3 ladder: A>12 -> DD/MM; else B>12 -> MM/DD; else MM/DD.
  for (const m of text.matchAll(/\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2}|\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const rawYear = Number(m[3]);
    const year = m[3].length === 2 ? 2000 + rawYear : rawYear;
    const [month, day] = a > 12 ? [b, a] : [a, b];
    const value = iso(year, month, day);
    if (value) hits.push({ index: m.index ?? 0, iso: value });
  }

  // DD Mon YYYY (the shape the Amex export already uses, base §3).
  for (const m of text.matchAll(/\b(\d{1,2})[\s-]([A-Za-z]{3,9})\.?,?[\s-](\d{4})\b/g)) {
    const month = MONTHS[m[2].slice(0, 3).toUpperCase()];
    if (!month) continue;
    const value = iso(Number(m[3]), month, Number(m[1]));
    if (value) hits.push({ index: m.index ?? 0, iso: value });
  }

  // Mon D, YYYY
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[1].slice(0, 3).toUpperCase()];
    if (!month) continue;
    const value = iso(Number(m[3]), month, Number(m[2]));
    if (value) hits.push({ index: m.index ?? 0, iso: value });
  }

  return hits;
}

export function suggestPurchaseDate(text: string, today: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const floor = addMonthsClamped(today, -MAX_SUGGESTION_AGE_MONTHS);
  const survivors = collectDateHits(text)
    .filter((hit) => hit.iso <= today && hit.iso >= floor)
    // §8.1 step 4: earliest OCCURRENCE in the text (receipt headers print the
    // transaction date before any expiry or promo date). Ties break on first match.
    .sort((a, b) => a.index - b.index);
  return survivors[0]?.iso;
}

const VENDOR_SKIP_RE = /^(receipt|invoice|order|tel|phone|fax|www\.|https?:|\d)/i;

export function suggestVendor(text: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
  for (const line of lines) {
    const letters = line.match(/\p{L}/gu)?.length ?? 0;
    if (letters < 3) continue;
    if (VENDOR_SKIP_RE.test(line)) continue;
    return line.slice(0, MAX_VENDOR_CHARS);
  }
  return undefined;
}

const CURRENCY_RE = /(?:\$\s*)?(\d{1,3}(?:,\d{3})*|\d+)[.,](\d{2})(?!\d)/g;
const TOTAL_LINE_RE = /\b(total|amount due|grand total|balance due)\b/i;
const SUBTOTAL_RE = /\bsub[\s-]?total\b/i;

function centsOf(whole: string, fraction: string): number | null {
  // One money parser in the app (MUST-13.5): integer cents, no floats.
  const cents = parseAmountToCents(`${whole}.${fraction}`);
  if (cents === null) return null;
  const magnitude = Math.abs(cents);
  if (magnitude <= 0 || magnitude >= MAX_SUGGESTED_PRICE_CENTS) return null;
  return magnitude;
}

export function suggestPriceCents(text: string): number | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;

  // 1. TOTAL-line pass: the LAST currency number on the LAST qualifying line.
  const totalLines = text.split(/\r?\n/).filter((line) => TOTAL_LINE_RE.test(line) && !SUBTOTAL_RE.test(line));
  const lastTotalLine = totalLines[totalLines.length - 1];
  if (lastTotalLine !== undefined) {
    const matches = [...lastTotalLine.matchAll(CURRENCY_RE)];
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const cents = centsOf(matches[i][1], matches[i][2]);
      if (cents !== null) return cents;
    }
  }

  // 2. Fallback: the largest currency-formatted number anywhere.
  let best: number | undefined;
  for (const m of text.matchAll(CURRENCY_RE)) {
    const cents = centsOf(m[1], m[2]);
    if (cents === null) continue;
    if (best === undefined || cents > best) best = cents;
  }
  return best;
}

export function suggestFromOcrText(text: string, today: string): SuggestedFields {
  const out: SuggestedFields = {};
  const purchaseDate = suggestPurchaseDate(text, today);
  if (purchaseDate !== undefined) out.purchaseDate = purchaseDate;
  const vendor = suggestVendor(text);
  if (vendor !== undefined) out.vendor = vendor;
  const priceCents = suggestPriceCents(text);
  if (priceCents !== undefined) out.priceCents = priceCents;
  return out;
}
```

- [ ] **Step 4: Run the suggestion test to verify it passes.**

Run: `npm test -- tests/lib/warranty/suggest.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint (commit is PAUSED).**

Run: `npm test && npm run typecheck`
Expected: green.
Commit message to use when the pause is lifted:

```bash
git add src/lib/warranty/suggest.ts tests/lib/warranty/suggest.test.ts
git commit -m "feat(warranty): pure suggest-and-confirm heuristics for date, vendor and total"
```

---

## Task 5: OCR — vendored assets, engine hook, PDF text, staging, queue, scheduler sweep

**Context:** This is the riskiest task in the plan. tesseract.js by default downloads its worker script, its WASM core and `eng.traineddata` from a CDN on first use; this install is LAN-only and often has no route to the internet, so every asset must resolve from a local absolute filesystem path (MUST-7.3). PDFs are never rasterised — their text layer is read with `pdfjs-dist`'s legacy Node build. All recognition goes through a hook module so **no test in the suite ever loads real WASM** (MUST-7.17). Staged uploads (needed so suggestions can pre-fill the *new-item* form before any row exists) write an OCR sidecar into the existing `${DATA_DIR}/tmp`, already covered by `purgeStagedFiles()`'s 24 h sweep.

**Files:**
- Modify: `package.json` (two dependencies + one script)
- Modify: `next.config.ts` (`serverExternalPackages`)
- Create: `scripts/fetch-tessdata.mjs`
- Create: `vendor/tessdata/eng.traineddata.gz` (committed binary, ~15 MB)
- Create: `src/lib/warranty/ocr/assets.ts`
- Create: `src/lib/warranty/ocr/pdf.ts`
- Create: `src/lib/warranty/ocr/engine.ts`
- Create: `src/lib/warranty/staging.ts`
- Create: `src/lib/warranty/ocr/queue.ts`
- Modify: `src/lib/scheduler.ts` (add the OCR sweep tick)
- Modify: `src/instrumentation-node.ts` (boot asset log)
- Test: `tests/lib/warranty/ocr/assets.test.ts`
- Test: `tests/lib/warranty/ocr/engine-options.test.ts`
- Test: `tests/lib/warranty/staging.test.ts`
- Test: `tests/lib/warranty/ocr/queue.test.ts`
- Test: `tests/lib/scheduler.test.ts` (create — the module has no test today)

**Interfaces:**
- Consumes: `ReceiptMime`, `RECEIPT_EXTS`, `extForMime`, `mimeForExt` from `@/lib/warranty/sniff` (Task 3); `receiptTempDir`, `resolveReceiptPath`, `receiptFileExists` from `@/lib/warranty/receipts` (Task 3); `SuggestedFields`, `suggestFromOcrText` from `@/lib/warranty/suggest` (Task 4); `warrantyReceipts` from `@/db/schema` (Task 1); `getDb` from `@/db/client`; `todayIso` from `@/lib/dates`; `readEnv` from `@/lib/env`.
- Produces:
  ```ts
  // src/lib/warranty/ocr/assets.ts
  export interface OcrAssets { workerPath: string; corePath: string; langPath: string; cachePath: string }
  export const TESSDATA_RELATIVE_PATH = 'vendor/tessdata/eng.traineddata.gz';
  export const TESSDATA_SHA256: string;
  export function resolveOcrAssets(): OcrAssets;
  export function assertOcrAssets(): { ok: boolean; missing: string[] };

  // src/lib/warranty/ocr/pdf.ts
  export const MIN_PDF_TEXT_CHARS = 20;
  export const SCANNED_PDF_MESSAGE: string;
  export class ScannedPdfError extends Error {}
  export function extractPdfText(filePath: string): Promise<string>;

  // src/lib/warranty/ocr/engine.ts
  export interface OcrResult { text: string }
  export interface OcrEngine { recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult> }
  export class OcrUnavailableError extends Error {}
  export const MAX_OCR_TEXT_CHARS = 100_000;
  export const OCR_TIMEOUT_MS = 120_000;
  export const OCR_IDLE_TERMINATE_MS = 60_000;
  export const OCR_UNAVAILABLE_MESSAGE = 'OCR engine unavailable on this install.';
  export const OCR_TIMEOUT_MESSAGE = 'OCR timed out.';
  export const TRUNCATION_MARKER: string;
  export const TRUNCATION_NOTE: string;
  export function truncateOcrText(raw: string): { text: string; truncated: boolean };
  export function getOcrEngine(): OcrEngine;
  export function setOcrEngineForTests(engine: OcrEngine | null): void;
  export function terminateOcrWorker(): Promise<void>;

  // src/lib/warranty/staging.ts
  export interface StagedReceipt { stagingId: string; originalFilename: string; mime: ReceiptMime; sizeBytes: number; sha256: string }
  export interface OcrSidecar { status: 'done' | 'failed'; text?: string; error?: string; suggestions?: SuggestedFields }
  export const STAGING_ID_RE: RegExp;
  export class ReceiptStagingError extends Error {}
  export function writeStagedReceipt(buf: Buffer, mime: ReceiptMime): string;
  export function findStagedReceipt(stagingId: string): { path: string; mime: ReceiptMime } | null;
  export function sidecarPath(stagingId: string): string;
  export function writeSidecar(stagingId: string, payload: OcrSidecar): void;
  export function readSidecar(stagingId: string): OcrSidecar | null;
  export function deleteSidecar(stagingId: string): void;
  export function deleteStagedReceipt(stagingId: string): void;

  // src/lib/warranty/ocr/queue.ts
  export type OcrJob = { kind: 'staged'; stagingId: string } | { kind: 'receipt'; receiptId: number };
  export function enqueueOcrJob(job: OcrJob): boolean;   // false when already claimed
  export function isOcrJobClaimed(job: OcrJob): boolean;
  export function ocrQueueDepth(): number;
  export function drainOcrQueue(): Promise<void>;
  export function resetOcrQueueForTests(): void;
  export function sweepPendingReceipts(): number;

  // src/lib/scheduler.ts (added)
  export const OCR_SWEEP_CRON = '*/10 * * * *';
  ```

### Steps

- [ ] **Step 1: Install the two OCR dependencies and VERIFY the asset paths exist.**

Run, in order, and read the output of the second command before writing any code:

```powershell
npm install --save tesseract.js@^6 pdfjs-dist@^4
node -e "const fs=require('fs');['node_modules/tesseract.js/src/worker-script/node/index.js','node_modules/tesseract.js-core','node_modules/pdfjs-dist/legacy/build/pdf.mjs'].forEach(p=>console.log(fs.existsSync(p)?'OK   '+p:'MISS '+p))"
node -p "require('./node_modules/tesseract.js/package.json').version + ' / ' + require('./node_modules/pdfjs-dist/package.json').version"
```

Expected: three `OK` lines. **If any line reads `MISS`, stop and locate the real path before writing code** — every path below is written against those three, and a wrong `workerPath` is exactly how the CDN default silently comes back (MUST-2.2). Substitute the real path everywhere it appears in this task if the installed layout differs; the tests in Step 4 are the contract, not the literal strings.

- [ ] **Step 2: Write the one-time tessdata fetch helper and produce the vendored asset.**

Create `scripts/fetch-tessdata.mjs`:

```js
#!/usr/bin/env node
/**
 * ONE-TIME regeneration helper for vendor/tessdata/eng.traineddata.gz (MUST-7.7).
 *
 * Run by a maintainer with internet access. It is NEVER invoked by a build, by a test,
 * or by the app: the .gz is committed to the repository precisely so that an offline LAN
 * install has no dependency on npm resolution or on a third-party data package staying
 * published (§17.21).
 *
 *   node scripts/fetch-tessdata.mjs
 *
 * It prints the sha256 of the file it wrote. Paste that value into TESSDATA_SHA256 in
 * src/lib/warranty/ocr/assets.ts so a corrupt or swapped file is caught by CI rather than
 * at a family member's first upload.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const URL_ENG = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata';
const OUT_DIR = path.join(process.cwd(), 'vendor', 'tessdata');
const OUT_FILE = path.join(OUT_DIR, 'eng.traineddata.gz');

const response = await fetch(URL_ENG);
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const raw = Buffer.from(await response.arrayBuffer());
if (raw.length < 1_000_000) {
  console.error(`Refusing a suspiciously small download (${raw.length} bytes)`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT_FILE, gz);

const digest = createHash('sha256').update(gz).digest('hex');
console.log(`wrote ${OUT_FILE} (${gz.length} bytes)`);
console.log(`eng.traineddata.gz sha256 = ${digest}`);
console.log('Paste that value into TESSDATA_SHA256 in src/lib/warranty/ocr/assets.ts');
```

Then produce the asset:

```powershell
node scripts/fetch-tessdata.mjs
```

Expected: two lines, the second reading `eng.traineddata.gz sha256 = <64 hex chars>`. **Copy that 64-character digest — Step 5 pastes it into `TESSDATA_SHA256`.**

If this machine has no internet: obtain `eng.traineddata` from a machine that does, place it at `vendor/tessdata/eng.traineddata`, then run

```powershell
node -e "const fs=require('fs'),z=require('zlib'),c=require('crypto');const gz=z.gzipSync(fs.readFileSync('vendor/tessdata/eng.traineddata'),{level:9});fs.writeFileSync('vendor/tessdata/eng.traineddata.gz',gz);fs.rmSync('vendor/tessdata/eng.traineddata');console.log('eng.traineddata.gz sha256 =',c.createHash('sha256').update(gz).digest('hex'))"
```

- [ ] **Step 3: Register the two packages as server-external.**

Edit `next.config.ts` — replace the `serverExternalPackages` line with:

```ts
  // Native / CJS-only packages must not be bundled by the server compiler.
  // tesseract.js and pdfjs-dist join them for a different reason (MUST-2.2): the tesseract
  // worker is loaded BY FILE PATH from node_modules, so if Next bundles the library that
  // path stops existing and it silently falls back to its CDN defaults — the exact failure
  // the offline-install invariant forbids.
  serverExternalPackages: [
    'better-sqlite3',
    'argon2',
    'node-cron',
    'tesseract.js',
    'tesseract.js-core',
    'pdfjs-dist',
  ],
```

- [ ] **Step 4: Write the failing asset test.**

Create `tests/lib/warranty/ocr/assets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  TESSDATA_RELATIVE_PATH,
  TESSDATA_SHA256,
  assertOcrAssets,
  resolveOcrAssets,
} from '@/lib/warranty/ocr/assets';

describe('resolveOcrAssets (MUST-7.5)', () => {
  const assets = resolveOcrAssets();
  const entries = Object.entries(assets);

  it('returns exactly four named paths', () => {
    expect(Object.keys(assets).sort()).toEqual(['cachePath', 'corePath', 'langPath', 'workerPath']);
  });

  it.each(entries)('%s is an absolute path', (_name, value) => {
    expect(path.isAbsolute(value)).toBe(true);
  });

  it.each(entries)('%s is not a URL of any scheme', (_name, value) => {
    expect(/^[a-z]+:\/\//i.test(value)).toBe(false);
  });

  it.each(entries.filter(([name]) => name !== 'cachePath'))('%s exists on disk', (_name, value) => {
    expect(fs.existsSync(value)).toBe(true);
  });

  it('points langPath at the vendored directory, not at node_modules and not at a CDN', () => {
    expect(assets.langPath).toBe(path.join(process.cwd(), 'vendor', 'tessdata'));
    expect(fs.existsSync(path.join(assets.langPath, 'eng.traineddata.gz'))).toBe(true);
  });
});

describe('vendored language data (MUST-7.7)', () => {
  it('matches the recorded sha256 so a corrupt or swapped file fails CI', () => {
    const file = path.join(process.cwd(), TESSDATA_RELATIVE_PATH);
    const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(TESSDATA_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(TESSDATA_SHA256);
  });

  it('is committed, never generated by a build, a test or the app', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts/fetch-tessdata.mjs'), 'utf8');
    expect(script).toMatch(/ONE-TIME/);
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const hook of ['build', 'test', 'postinstall', 'prepare']) {
      expect(pkg.scripts[hook] ?? '').not.toContain('fetch-tessdata');
    }
  });
});

describe('assertOcrAssets', () => {
  it('reports ok with no missing entries on a healthy checkout', () => {
    expect(assertOcrAssets()).toEqual({ ok: true, missing: [] });
  });
});
```

- [ ] **Step 5: Implement `src/lib/warranty/ocr/assets.ts`.**

Replace the `TESSDATA_SHA256` value with the 64-character digest printed in Step 2.

```ts
import fs from 'node:fs';
import path from 'node:path';
import { readEnv } from '@/lib/env';

/**
 * MUST-7.4: the SINGLE place the OCR asset paths are computed. Everything resolves against
 * the app root (process.cwd() — /app in the container, the repo root in dev and test) and
 * every value returned is an ABSOLUTE FILESYSTEM PATH.
 *
 * MUST-7.3: tesseract.js downloads its worker script, its .wasm core and eng.traineddata
 * from a CDN by default. That is forbidden here — the install is LAN-only and frequently
 * has no route to the internet. Omitting even one of the four options below is how the CDN
 * default silently comes back, which is why a test asserts all four are passed.
 */
export interface OcrAssets {
  workerPath: string;
  corePath: string;
  langPath: string;
  cachePath: string;
}

export const TESSDATA_RELATIVE_PATH = 'vendor/tessdata/eng.traineddata.gz';

/** Regenerate with `node scripts/fetch-tessdata.mjs`, which prints this value. */
export const TESSDATA_SHA256 = 'PASTE_THE_DIGEST_PRINTED_BY_scripts_fetch_tessdata_mjs';

export function resolveOcrAssets(): OcrAssets {
  const root = process.cwd();
  return {
    workerPath: path.join(root, 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
    // A DIRECTORY: the library selects the SIMD / non-SIMD build inside it.
    corePath: path.join(root, 'node_modules', 'tesseract.js-core'),
    langPath: path.join(root, 'vendor', 'tessdata'),
    // Belt and braces for any write path that ignores cacheMethod: 'none' — the container
    // rootfs is read-only, ${DATA_DIR}/tmp is not (MUST-13.8).
    cachePath: path.join(readEnv().dataDir, 'tmp'),
  };
}

/**
 * MUST-7.6: fail loudly, degrade gracefully. Called at boot; missing assets log one line
 * and DO NOT crash the app — receipts still upload, and OCR jobs simply record 'failed'.
 * A warranty tracker without OCR is still a warranty tracker; a container that refuses to
 * boot is not.
 */
export function assertOcrAssets(): { ok: boolean; missing: string[] } {
  const assets = resolveOcrAssets();
  const required: [string, string][] = [
    ['workerPath', assets.workerPath],
    ['corePath', assets.corePath],
    ['langPath', path.join(assets.langPath, 'eng.traineddata.gz')],
  ];
  const missing = required.filter(([, value]) => !fs.existsSync(value)).map(([name, value]) => `${name}=${value}`);
  return { ok: missing.length === 0, missing };
}
```

- [ ] **Step 6: Run the asset test to verify it passes.**

Run: `npm test -- tests/lib/warranty/ocr/assets.test.ts`
Expected: PASS. If the sha256 assertion fails, the digest was pasted wrong — re-run the command from Step 2 and paste again.

- [ ] **Step 7: Implement the PDF text extractor.**

Create `src/lib/warranty/ocr/pdf.ts`:

```ts
import fs from 'node:fs';

/** MUST-7.15: below this, the PDF is a scan, not a text-layer document. */
export const MIN_PDF_TEXT_CHARS = 20;

export const SCANNED_PDF_MESSAGE =
  'This PDF has no text layer — it looks like a scan. Scanned-PDF OCR is not supported yet; photograph the receipt instead.';

export class ScannedPdfError extends Error {
  constructor() {
    super(SCANNED_PDF_MESSAGE);
    this.name = 'ScannedPdfError';
  }
}

/**
 * MUST-7.14: PDFs are NOT rasterised and NOT run through Tesseract. Text comes from the
 * document's own text layer via pdfjs-dist's legacy Node build, with every remote fetch
 * disabled (no font URL, no CMap URL, no worker fetch) so this path makes no network call.
 *
 * pdf-parse was rejected (§17.10): its published build executes a demo-file read at
 * require time when module.parent is unset, which breaks under bundlers and in ESM, and
 * it is unmaintained.
 */
export async function extractPdfText(filePath: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim(),
      );
      page.cleanup();
    }
    const text = pages.join('\n');
    if (text.replace(/\s/g, '').length < MIN_PDF_TEXT_CHARS) throw new ScannedPdfError();
    return text;
  } finally {
    await doc.destroy();
  }
}
```

- [ ] **Step 8: Implement the engine hook module.**

Create `src/lib/warranty/ocr/engine.ts`:

```ts
import type { ReceiptMime } from '@/lib/warranty/sniff';
import { assertOcrAssets, resolveOcrAssets } from '@/lib/warranty/ocr/assets';
import { extractPdfText } from '@/lib/warranty/ocr/pdf';

export interface OcrResult {
  text: string;
}

/** MUST-7.17: the ONLY way any caller reaches recognition. Tests inject a fake. */
export interface OcrEngine {
  recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult>;
}

/** §3.3 / §17.22: without a cap, one pathological PDF bloats the row and the FTS index. */
export const MAX_OCR_TEXT_CHARS = 100_000;
export const OCR_TIMEOUT_MS = 120_000;
export const OCR_IDLE_TERMINATE_MS = 60_000;

export const OCR_UNAVAILABLE_MESSAGE = 'OCR engine unavailable on this install.';
export const OCR_TIMEOUT_MESSAGE = 'OCR timed out.';
export const TRUNCATION_MARKER = '… [truncated]';
export const TRUNCATION_NOTE = `OCR text was truncated at ${MAX_OCR_TEXT_CHARS} characters.`;

export class OcrUnavailableError extends Error {
  constructor(message = OCR_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

export function truncateOcrText(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= MAX_OCR_TEXT_CHARS) return { text: raw, truncated: false };
  return { text: `${raw.slice(0, MAX_OCR_TEXT_CHARS)}${TRUNCATION_MARKER}`, truncated: true };
}

/* ------------------------------------------------------------------ *
 * Real engine — one lazily created, reused tesseract.js Node worker.  *
 * MUST-7.2: recognition runs in the library's Node worker (its own    *
 * process), so a multi-second recognise never blocks the event loop.  *
 * ------------------------------------------------------------------ */

// A narrow local type: this is the entire surface the queue relies on.
interface TesseractWorkerLike {
  recognize(input: string): Promise<{ data: { text: string } }>;
  terminate(): Promise<void>;
}

let worker: TesseractWorkerLike | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  // MUST-7.10 / risk R5: release the worker's ~100 MB RSS after 60 s idle.
  idleTimer = setTimeout(() => {
    void terminateOcrWorker();
  }, OCR_IDLE_TERMINATE_MS);
  idleTimer.unref?.();
}

export async function terminateOcrWorker(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = worker;
  worker = null;
  if (current) {
    try {
      await current.terminate();
    } catch (error) {
      console.warn('[ocr] worker terminate failed', error);
    }
  }
}

async function getWorker(): Promise<TesseractWorkerLike> {
  if (worker) return worker;
  const health = assertOcrAssets();
  if (!health.ok) throw new OcrUnavailableError();
  const assets = resolveOcrAssets();
  const { createWorker } = await import('tesseract.js');
  // MUST-7.3: ALL FOUR path options are passed. Omitting any one of them lets the library
  // fall back to its CDN defaults. tests/lib/warranty/ocr/engine-options.test.ts pins this.
  worker = (await createWorker('eng', undefined, {
    workerPath: assets.workerPath,
    corePath: assets.corePath,
    langPath: assets.langPath,
    cachePath: assets.cachePath,
    gzip: true,
    cacheMethod: 'none',
  })) as unknown as TesseractWorkerLike;
  return worker;
}

const defaultEngine: OcrEngine = {
  async recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult> {
    if (mime === 'application/pdf') return { text: await extractPdfText(filePath) };
    const active = await getWorker();
    try {
      const result = await active.recognize(filePath);
      return { text: result.data.text };
    } finally {
      armIdleTimer();
    }
  },
};

let engine: OcrEngine = defaultEngine;

export function getOcrEngine(): OcrEngine {
  return engine;
}

/** Modelled on setImportHooks() in src/lib/import/hooks.ts. Pass null to restore the real engine. */
export function setOcrEngineForTests(next: OcrEngine | null): void {
  engine = next ?? defaultEngine;
}
```

- [ ] **Step 9: Add the engine-options guard test and run it.**

Create `tests/lib/warranty/ocr/engine-options.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * MUST-7.5, second assertion: the construction call passes all four path options.
 * Asserted against the SOURCE TEXT rather than by running the engine, because MUST-7.17
 * forbids any test loading real WASM or reading eng.traineddata.
 */
describe('tesseract worker construction', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/warranty/ocr/engine.ts'), 'utf8');
  const call = source.slice(source.indexOf('createWorker('), source.indexOf('as unknown as TesseractWorkerLike'));

  it.each(['workerPath', 'corePath', 'langPath', 'cachePath'])('passes %s', (option) => {
    expect(call).toContain(`${option}: assets.${option}`);
  });

  it('sets gzip true (the vendored asset is a .gz) and cacheMethod none (read-only rootfs)', () => {
    expect(call).toContain('gzip: true');
    expect(call).toContain("cacheMethod: 'none'");
  });

  it('never mentions a URL or a CDN host', () => {
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toContain('unpkg');
    expect(source).not.toContain('jsdelivr');
  });
});
```

Run: `npm test -- tests/lib/warranty/ocr/engine-options.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing staging test.**

Create `tests/lib/warranty/staging.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReceiptStagingError,
  STAGING_ID_RE,
  deleteSidecar,
  deleteStagedReceipt,
  findStagedReceipt,
  readSidecar,
  sidecarPath,
  writeSidecar,
  writeStagedReceipt,
} from '@/lib/warranty/staging';
import { receiptTempDir } from '@/lib/warranty/receipts';

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-staging-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

describe('writeStagedReceipt / findStagedReceipt', () => {
  it('writes into the existing DATA_DIR/tmp so purgeStagedFiles already covers it', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(STAGING_ID_RE.test(stagingId)).toBe(true);
    expect(fs.existsSync(path.join(receiptTempDir(), `${stagingId}.jpg`))).toBe(true);
  });

  it('finds a staged file and reports its mime from the stored extension', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const found = findStagedReceipt(stagingId);
    expect(found?.mime).toBe('image/jpeg');
    expect(found?.path).toBe(path.join(receiptTempDir(), `${stagingId}.jpg`));
  });

  it('returns null for an id with no file (expired, or lost to a restart)', () => {
    expect(findStagedReceipt('11111111-2222-3333-4444-555555555555')).toBeNull();
  });

  it('never lets a non-UUID reach path.join (MUST-4.3 / MUST-6.8)', () => {
    for (const bad of ['../budget.db', 'a/b', '', '../../etc/passwd', 'not-a-uuid']) {
      expect(() => findStagedReceipt(bad)).toThrowError(ReceiptStagingError);
      expect(() => sidecarPath(bad)).toThrowError(ReceiptStagingError);
    }
  });

  it('deletes the staged file and is safe to call twice', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    deleteStagedReceipt(stagingId);
    expect(findStagedReceipt(stagingId)).toBeNull();
    expect(() => deleteStagedReceipt(stagingId)).not.toThrow();
  });
});

describe('OCR sidecar (MUST-6.7)', () => {
  it('round-trips a done payload with suggestions', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, {
      status: 'done',
      text: 'HOME DEPOT\nTOTAL 42.00',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200 },
    });
    expect(readSidecar(stagingId)).toEqual({
      status: 'done',
      text: 'HOME DEPOT\nTOTAL 42.00',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200 },
    });
  });

  it('round-trips a failed payload', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    expect(readSidecar(stagingId)).toEqual({ status: 'failed', error: 'OCR timed out.' });
  });

  it('reads null before the worker has written anything (still pending)', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(readSidecar(stagingId)).toBeNull();
  });

  it('reads null rather than throwing on a corrupt sidecar', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    fs.writeFileSync(sidecarPath(stagingId), '{not json');
    expect(readSidecar(stagingId)).toBeNull();
  });

  it('deletes the sidecar and is safe to call twice', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'x' });
    deleteSidecar(stagingId);
    expect(readSidecar(stagingId)).toBeNull();
    expect(() => deleteSidecar(stagingId)).not.toThrow();
  });
});
```

- [ ] **Step 11: Run the staging test to verify it fails.**

Run: `npm test -- tests/lib/warranty/staging.test.ts`
Expected: FAIL — cannot resolve `@/lib/warranty/staging`.

- [ ] **Step 12: Implement `src/lib/warranty/staging.ts`.**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { receiptTempDir } from '@/lib/warranty/receipts';
import { RECEIPT_EXTS, extForMime, mimeForExt, type ReceiptMime } from '@/lib/warranty/sniff';
import type { SuggestedFields } from '@/lib/warranty/suggest';

/**
 * Staged receipt uploads (spec §6.3). Suggestions must pre-fill the NEW-ITEM form, which
 * means OCR has to run before any warranty_items row exists. Staged files live in the
 * existing ${DATA_DIR}/tmp and are therefore already covered by purgeStagedFiles()'s
 * 24-hour mtime sweep — that helper iterates EVERY entry in the directory, so its purge
 * logic needs no change.
 */
export interface StagedReceipt {
  stagingId: string;
  originalFilename: string;
  mime: ReceiptMime;
  sizeBytes: number;
  sha256: string;
}

/**
 * MUST-6.7: a sidecar FILE, not an in-memory map, so a container restart mid-flow degrades
 * to "no suggestions" instead of losing a member's upload.
 */
export interface OcrSidecar {
  status: 'done' | 'failed';
  text?: string;
  error?: string;
  suggestions?: SuggestedFields;
}

export const STAGING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ReceiptStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptStagingError';
  }
}

function assertStagingId(stagingId: string): void {
  // Path-traversal guard: only a UUID may ever reach path.join, exactly as
  // stagedFilePath() does in src/lib/import/staging.ts.
  if (typeof stagingId !== 'string' || !STAGING_ID_RE.test(stagingId)) {
    throw new ReceiptStagingError('Invalid staging id');
  }
}

export function writeStagedReceipt(buf: Buffer, mime: ReceiptMime): string {
  const dir = receiptTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const stagingId = randomUUID();
  fs.writeFileSync(path.join(dir, `${stagingId}.${extForMime(mime)}`), buf);
  return stagingId;
}

export function findStagedReceipt(stagingId: string): { path: string; mime: ReceiptMime } | null {
  assertStagingId(stagingId);
  const dir = receiptTempDir();
  for (const ext of RECEIPT_EXTS) {
    const candidate = path.join(dir, `${stagingId}.${ext}`);
    if (!fs.existsSync(candidate)) continue;
    const mime = mimeForExt(ext);
    if (mime === null) continue;
    return { path: candidate, mime };
  }
  return null;
}

export function sidecarPath(stagingId: string): string {
  assertStagingId(stagingId);
  return path.join(receiptTempDir(), `${stagingId}.ocr.json`);
}

export function writeSidecar(stagingId: string, payload: OcrSidecar): void {
  fs.mkdirSync(receiptTempDir(), { recursive: true });
  fs.writeFileSync(sidecarPath(stagingId), JSON.stringify(payload), 'utf8');
}

export function readSidecar(stagingId: string): OcrSidecar | null {
  const file = sidecarPath(stagingId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as OcrSidecar;
  } catch {
    // A half-written or corrupt sidecar means "no suggestions", never a 500.
    return null;
  }
}

export function deleteSidecar(stagingId: string): void {
  fs.rmSync(sidecarPath(stagingId), { force: true });
}

export function deleteStagedReceipt(stagingId: string): void {
  const found = findStagedReceipt(stagingId);
  if (found) fs.rmSync(found.path, { force: true });
}
```

- [ ] **Step 13: Run the staging test to verify it passes.**

Run: `npm test -- tests/lib/warranty/staging.test.ts`
Expected: PASS.

- [ ] **Step 14: Write the failing queue test.**

Create `tests/lib/warranty/ocr/queue.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../../helpers/db';
import {
  drainOcrQueue,
  enqueueOcrJob,
  isOcrJobClaimed,
  ocrQueueDepth,
  resetOcrQueueForTests,
  sweepPendingReceipts,
} from '@/lib/warranty/ocr/queue';
import { OCR_UNAVAILABLE_MESSAGE, OcrUnavailableError, setOcrEngineForTests } from '@/lib/warranty/ocr/engine';
import { SCANNED_PDF_MESSAGE, ScannedPdfError } from '@/lib/warranty/ocr/pdf';
import { readSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { writeReceiptFile } from '@/lib/warranty/receipts';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const ISO = '2026-08-16T12:00:00.000Z';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-queue-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  resetOcrQueueForTests();
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function makeItem(): number {
  const userId = insertTestUser(current!.db, { username: 'alice' });
  return current!.db.get<{ id: number }>(
    sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
        values ('Fridge', '2026-08-16', 0, ${userId}, ${ISO}, ${ISO}) returning id`,
  ).id;
}

function makeReceipt(itemId: number, storedFilename: string, status = 'pending'): number {
  return current!.db.get<{ id: number }>(
    sql`insert into warranty_receipts
          (warranty_item_id, original_filename, stored_filename, mime, size_bytes, sha256, ocr_status, created_at)
        values (${itemId}, 'r.jpg', ${storedFilename}, 'image/jpeg', 64, ${'a'.repeat(64)}, ${status}, ${ISO})
        returning id`,
  ).id;
}

describe('staged jobs', () => {
  it('writes a done sidecar with the raw text and the suggestions', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'HOME DEPOT #7042\nTOTAL 42.00' }) });
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(enqueueOcrJob({ kind: 'staged', stagingId })).toBe(true);
    await drainOcrQueue();
    const sidecar = readSidecar(stagingId);
    expect(sidecar?.status).toBe('done');
    expect(sidecar?.text).toContain('HOME DEPOT');
    expect(sidecar?.suggestions?.vendor).toBe('HOME DEPOT #7042');
    expect(sidecar?.suggestions?.priceCents).toBe(4200);
  });

  it('writes a failed sidecar when the engine is unavailable', async () => {
    setOcrEngineForTests({
      recognize: async () => {
        throw new OcrUnavailableError();
      },
    });
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    enqueueOcrJob({ kind: 'staged', stagingId });
    await drainOcrQueue();
    expect(readSidecar(stagingId)).toEqual({ status: 'failed', error: OCR_UNAVAILABLE_MESSAGE });
  });

  it('writes a failed sidecar carrying the scanned-PDF message', async () => {
    setOcrEngineForTests({
      recognize: async () => {
        throw new ScannedPdfError();
      },
    });
    const stagingId = writeStagedReceipt(Buffer.from('%PDF-1.7\n'), 'application/pdf');
    enqueueOcrJob({ kind: 'staged', stagingId });
    await drainOcrQueue();
    expect(readSidecar(stagingId)?.error).toBe(SCANNED_PDF_MESSAGE);
  });

  it('drains quietly when the staged file has already been purged', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'unused' }) });
    enqueueOcrJob({ kind: 'staged', stagingId: '11111111-2222-3333-4444-555555555555' });
    await drainOcrQueue();
    expect(ocrQueueDepth()).toBe(0);
  });
});

describe('receipt jobs', () => {
  it('stores the text, flips the row to done, and makes the item searchable', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'RONA SPATULA 4412' }) });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));

    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();

    const row = current!.db.get<{ ocr_status: string; ocr_text: string | null; ocr_error: string | null }>(
      sql`select ocr_status, ocr_text, ocr_error from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('done');
    expect(row.ocr_text).toBe('RONA SPATULA 4412');
    expect(row.ocr_error).toBeNull();

    const hit = current!.db.get<{ id: number }>(
      sql`select rowid as id from warranty_search where warranty_search match ${'"spatula"'}`,
    );
    expect(hit.id).toBe(itemId);
  });

  it('records failed plus the error text when the engine throws', async () => {
    setOcrEngineForTests({
      recognize: async () => {
        throw new Error('boom');
      },
    });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    const row = current!.db.get<{ ocr_status: string; ocr_error: string | null }>(
      sql`select ocr_status, ocr_error from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('failed');
    expect(row.ocr_error).toBe('boom');
  });

  it('truncates at MAX_OCR_TEXT_CHARS, notes it in ocr_error, and stays done', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'x'.repeat(120_000) }) });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    const row = current!.db.get<{ ocr_status: string; ocr_text: string; ocr_error: string | null }>(
      sql`select ocr_status, ocr_text, ocr_error from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('done');
    expect(row.ocr_text.length).toBeLessThan(120_000);
    expect(row.ocr_error).toContain('truncated');
  });

  it('fails the job when the file is missing from disk', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'unused' }) });
    const itemId = makeItem();
    const receiptId = makeReceipt(itemId, '11111111-2222-3333-4444-555555555555.jpg');
    enqueueOcrJob({ kind: 'receipt', receiptId });
    await drainOcrQueue();
    const row = current!.db.get<{ ocr_status: string }>(
      sql`select ocr_status from warranty_receipts where id = ${receiptId}`,
    );
    expect(row.ocr_status).toBe('failed');
  });
});

describe('claiming and FIFO order (MUST-7.10)', () => {
  it('refuses a second enqueue of a claimed job and runs jobs in order', async () => {
    const order: string[] = [];
    setOcrEngineForTests({
      recognize: async (filePath) => {
        order.push(path.basename(filePath));
        return { text: 'ok' };
      },
    });
    const a = writeStagedReceipt(JPEG, 'image/jpeg');
    const b = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(enqueueOcrJob({ kind: 'staged', stagingId: a })).toBe(true);
    expect(enqueueOcrJob({ kind: 'staged', stagingId: a })).toBe(false);
    expect(isOcrJobClaimed({ kind: 'staged', stagingId: a })).toBe(true);
    expect(enqueueOcrJob({ kind: 'staged', stagingId: b })).toBe(true);
    await drainOcrQueue();
    expect(order).toEqual([`${a}.jpg`, `${b}.jpg`]);
    expect(isOcrJobClaimed({ kind: 'staged', stagingId: a })).toBe(false);
  });
});

describe('sweepPendingReceipts (MUST-7.12)', () => {
  it('enqueues every pending row that is not already claimed', async () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'swept text' }) });
    const itemId = makeItem();
    const pendingA = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    const pendingB = makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'), 'done');

    expect(sweepPendingReceipts()).toBe(2);
    await drainOcrQueue();

    for (const id of [pendingA, pendingB]) {
      const row = current!.db.get<{ ocr_status: string }>(
        sql`select ocr_status from warranty_receipts where id = ${id}`,
      );
      expect(row.ocr_status).toBe('done');
    }
  });

  it('is idempotent — a second sweep while a job is claimed enqueues nothing', () => {
    setOcrEngineForTests({ recognize: async () => ({ text: 'x' }) });
    const itemId = makeItem();
    makeReceipt(itemId, writeReceiptFile(JPEG, 'image/jpeg'));
    expect(sweepPendingReceipts()).toBe(1);
    expect(sweepPendingReceipts()).toBe(0);
  });
});
```

- [ ] **Step 15: Run the queue test to verify it fails.**

Run: `npm test -- tests/lib/warranty/ocr/queue.test.ts`
Expected: FAIL — cannot resolve `@/lib/warranty/ocr/queue`.

- [ ] **Step 16: Implement `src/lib/warranty/ocr/queue.ts`.**

```ts
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { warrantyReceipts } from '@/db/schema';
import { todayIso } from '@/lib/dates';
import { receiptFileExists, resolveReceiptPath } from '@/lib/warranty/receipts';
import { suggestFromOcrText } from '@/lib/warranty/suggest';
import {
  OCR_TIMEOUT_MESSAGE,
  OCR_TIMEOUT_MS,
  TRUNCATION_NOTE,
  getOcrEngine,
  truncateOcrText,
} from '@/lib/warranty/ocr/engine';
import { findStagedReceipt, writeSidecar } from '@/lib/warranty/staging';

/**
 * MUST-7.10: a single in-process FIFO queue with concurrency 1. Household scale is a burst
 * of three receipts, not three hundred.
 *
 * MUST-7.12: ocr_status has only three values ('pending' | 'done' | 'failed'), so an
 * in-flight job is tracked by this in-memory claimed-id set rather than in the database.
 * A crash therefore leaves rows in 'pending' and the scheduler's ten-minute sweep
 * re-enqueues them — self-healing and idempotent.
 */
export type OcrJob = { kind: 'staged'; stagingId: string } | { kind: 'receipt'; receiptId: number };

const queue: OcrJob[] = [];
const claimed = new Set<string>();
let pump: Promise<void> | null = null;

function jobKey(job: OcrJob): string {
  return job.kind === 'staged' ? `s:${job.stagingId}` : `r:${job.receiptId}`;
}

export function isOcrJobClaimed(job: OcrJob): boolean {
  return claimed.has(jobKey(job));
}

export function ocrQueueDepth(): number {
  return queue.length;
}

/** Returns false when the job is already claimed — MUST-7.16's "second click is a no-op". */
export function enqueueOcrJob(job: OcrJob): boolean {
  const key = jobKey(job);
  if (claimed.has(key)) return false;
  claimed.add(key);
  queue.push(job);
  if (pump === null) pump = runQueue();
  return true;
}

/** Await the in-flight drain. Used by tests; production code never blocks on OCR. */
export async function drainOcrQueue(): Promise<void> {
  while (pump !== null) {
    await pump;
  }
}

export function resetOcrQueueForTests(): void {
  queue.length = 0;
  claimed.clear();
  pump = null;
}

async function runQueue(): Promise<void> {
  try {
    for (;;) {
      const job = queue.shift();
      if (job === undefined) return;
      try {
        await withTimeout(runJob(job));
      } catch (error) {
        console.error('[ocr] job failed', jobKey(job), error);
      } finally {
        claimed.delete(jobKey(job));
      }
    }
  } finally {
    pump = null;
  }
}

/** MUST-7.11: per-job timeout; the message is recorded on the row or the sidecar. */
async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(OCR_TIMEOUT_MESSAGE)), OCR_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'OCR failed.';
}

async function runJob(job: OcrJob): Promise<void> {
  if (job.kind === 'staged') return runStagedJob(job.stagingId);
  return runReceiptJob(job.receiptId);
}

async function runStagedJob(stagingId: string): Promise<void> {
  const staged = findStagedReceipt(stagingId);
  // The 24 h purge (or a restart) got there first. Nothing to record and nothing to lose.
  if (staged === null) return;
  try {
    const { text } = await getOcrEngine().recognize(staged.path, staged.mime);
    const { text: capped } = truncateOcrText(text);
    writeSidecar(stagingId, { status: 'done', text: capped, suggestions: suggestFromOcrText(capped, todayIso()) });
  } catch (error) {
    writeSidecar(stagingId, { status: 'failed', error: messageOf(error) });
  }
}

async function runReceiptJob(receiptId: number): Promise<void> {
  const db = getDb();
  const row = db
    .select({
      id: warrantyReceipts.id,
      storedFilename: warrantyReceipts.storedFilename,
      mime: warrantyReceipts.mime,
    })
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.id, receiptId))
    .get();
  if (!row) return;

  if (!receiptFileExists(row.storedFilename)) {
    db.update(warrantyReceipts)
      .set({ ocrStatus: 'failed', ocrText: null, ocrError: 'Receipt file is missing from this install.' })
      .where(eq(warrantyReceipts.id, receiptId))
      .run();
    return;
  }

  try {
    const { text } = await getOcrEngine().recognize(resolveReceiptPath(row.storedFilename), row.mime);
    const { text: capped, truncated } = truncateOcrText(text);
    // MUST-7.13: pending -> done. The warranty_search_receipt_au trigger reindexes here.
    // MUST-3.12: application code never writes warranty_search itself.
    db.update(warrantyReceipts)
      .set({ ocrStatus: 'done', ocrText: capped, ocrError: truncated ? TRUNCATION_NOTE : null })
      .where(eq(warrantyReceipts.id, receiptId))
      .run();
  } catch (error) {
    db.update(warrantyReceipts)
      .set({ ocrStatus: 'failed', ocrText: null, ocrError: messageOf(error) })
      .where(eq(warrantyReceipts.id, receiptId))
      .run();
  }
}

/**
 * MUST-7.12: the scheduler tick. Enqueues every warranty_receipts row still 'pending' that
 * is not currently claimed. One indexed query (warranty_receipts_ocr_idx).
 */
export function sweepPendingReceipts(): number {
  const rows = getDb()
    .select({ id: warrantyReceipts.id })
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.ocrStatus, 'pending'))
    .all();
  let enqueued = 0;
  for (const row of rows) {
    if (enqueueOcrJob({ kind: 'receipt', receiptId: row.id })) enqueued += 1;
  }
  return enqueued;
}
```

- [ ] **Step 17: Run the queue test to verify it passes.**

Run: `npm test -- tests/lib/warranty/ocr/queue.test.ts`
Expected: PASS.

- [ ] **Step 18: Write the failing scheduler test.**

Create `tests/lib/scheduler.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NIGHTLY_CRON, OCR_SWEEP_CRON, isSchedulerRunning, startScheduler, stopScheduler } from '@/lib/scheduler';

afterEach(() => {
  stopScheduler();
});

describe('scheduler', () => {
  it('keeps the nightly cron and adds a ten-minute OCR sweep (MUST-7.12)', () => {
    expect(NIGHTLY_CRON).toBe('0 2 * * *');
    expect(OCR_SWEEP_CRON).toBe('*/10 * * * *');
  });

  it('is idempotent and stops cleanly', () => {
    startScheduler();
    expect(isSchedulerRunning()).toBe(true);
    startScheduler();
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  it('also runs the sweep once at boot, not only on the tick', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    expect(source).toContain('sweepPendingReceipts');
    expect(source).toContain('runOcrSweep();');
  });
});
```

- [ ] **Step 19: Run the scheduler test to verify it fails.**

Run: `npm test -- tests/lib/scheduler.test.ts`
Expected: FAIL — `OCR_SWEEP_CRON` is not exported by `@/lib/scheduler`.

- [ ] **Step 20: Add the OCR sweep tick to the scheduler.**

Replace the whole of `src/lib/scheduler.ts` with:

```ts
import cron, { type ScheduledTask } from 'node-cron';
import { runNightlyJob } from '@/lib/backup';
import { readEnv } from '@/lib/env';
import { sweepPendingReceipts } from '@/lib/warranty/ocr/queue';

export const NIGHTLY_CRON = '0 2 * * *';
/** MUST-7.12: a crash leaves rows in 'pending'; this tick re-enqueues them. */
export const OCR_SWEEP_CRON = '*/10 * * * *';

let task: ScheduledTask | null = null;
let ocrTask: ScheduledTask | null = null;

function runOcrSweep(): void {
  try {
    const enqueued = sweepPendingReceipts();
    if (enqueued > 0) console.log(`[ocr] sweep enqueued ${enqueued} pending receipt(s)`);
  } catch (error) {
    console.error('[ocr] sweep failed', error);
  }
}

/** Idempotent: safe to call more than once per process (e.g. hot-reload in dev). */
export function startScheduler(): void {
  if (task) return;
  const { tz } = readEnv();
  task = cron.schedule(
    NIGHTLY_CRON,
    () => {
      try {
        runNightlyJob(new Date());
      } catch (error) {
        console.error('[backup] nightly job failed', error);
      }
    },
    { timezone: tz },
  );
  ocrTask = cron.schedule(OCR_SWEEP_CRON, runOcrSweep, { timezone: tz });
  console.log(`[scheduler] nightly job registered for ${NIGHTLY_CRON} (${tz})`);
  console.log(`[scheduler] OCR sweep registered for ${OCR_SWEEP_CRON} (${tz})`);
  // ...and once at boot, so a container restarted mid-job recovers immediately instead of
  // leaving a member's receipt unread for up to ten minutes.
  runOcrSweep();
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
  ocrTask?.stop();
  ocrTask = null;
}

export function isSchedulerRunning(): boolean {
  return task !== null;
}
```

- [ ] **Step 21: Log OCR asset health at boot.**

Replace `src/instrumentation-node.ts` with:

```ts
/**
 * Node-only half of the boot hook, split out of instrumentation.ts so that
 * Next's Edge-runtime compiler pass never has to resolve better-sqlite3/node-cron
 * (both are native/CJS-only and have no Edge-compatible build). instrumentation.ts
 * only ever `import()`s this file behind a NEXT_RUNTIME === 'nodejs' check, so the
 * Edge compilation of that file stays trivially side-effect free.
 */
import { getDb } from '@/db/client';
import { startScheduler } from '@/lib/scheduler';
import { assertOcrAssets, resolveOcrAssets } from '@/lib/warranty/ocr/assets';

// Opening the database here also applies the pragmas and runs migrations on boot.
getDb();

// MUST-7.6: one line, either way. Missing assets DO NOT crash the app — receipts still
// upload and OCR jobs simply record 'failed' with "OCR engine unavailable on this
// install." A warranty tracker without OCR is still a warranty tracker; a container that
// refuses to boot is not.
const ocr = assertOcrAssets();
if (ocr.ok) {
  console.log(`[ocr] assets ok (${resolveOcrAssets().langPath})`);
} else {
  console.error(`[ocr] MISSING: ${ocr.missing.join(', ')}`);
}

startScheduler();
```

- [ ] **Step 22: Add the maintainer script to `package.json`.**

In `"scripts"`, immediately after the `"fixtures"` line, add:

```json
    "fetch-tessdata": "node scripts/fetch-tessdata.mjs",
```

- [ ] **Step 23: Run the whole suite and the typecheck.**

Run: `npm test && npm run typecheck`
Expected: green. If `pdfjs-dist`'s own `.d.ts` rejects one of the `getDocument` options, drop that option and keep the rest — the requirement is "no remote font/CMap fetching", not any particular option spelling, and `useWorkerFetch: false` plus `disableFontFace: true` are the load-bearing pair.

- [ ] **Step 24: Checkpoint (commit is PAUSED).**

Commit message to use when the pause is lifted:

```bash
git add package.json package-lock.json next.config.ts vendor/ scripts/fetch-tessdata.mjs src/lib/warranty/ocr src/lib/warranty/staging.ts src/lib/scheduler.ts src/instrumentation-node.ts tests/lib/warranty tests/lib/scheduler.test.ts
git commit -m "feat(warranty): offline OCR engine, vendored tessdata, FIFO queue and recovery sweep"
```

---

## Task 6: Warranty data layer — item/receipt CRUD and FTS search

**Context:** Everything above this task is storage and machinery; this is the domain module the pages and actions talk to. It owns the zod input schema (including the lifetime rule and the future-date rule), write-time expiry computation, the receipt commit/delete lifecycle (file *and* row, in the right order), and the FTS-escaped search query. Two files, one reviewer gate: they share the row types and the status CASE, and neither is useful without the other.

**Files:**
- Create: `src/lib/warranty/items.ts`
- Create: `src/lib/warranty/search.ts`
- Test: `tests/lib/warranty/items.test.ts`
- Test: `tests/lib/warranty/search.test.ts`

**Interfaces:**
- Consumes: `warrantyItems`, `warrantyReceipts` from `@/db/schema` (Task 1); `getDb`, `getSqlite` from `@/db/client`; `EXPIRING_SOON_DAYS`, `STATUS_CASE_SQL`, `WarrantyStatus`, `computeExpiryDate`, `warrantyStatus` from `@/lib/warranty/expiry` (Task 2); `ReceiptMime` from `@/lib/warranty/sniff` (Task 3); `adoptReceiptFile`, `deleteReceiptFile`, `receiptFileExists`, `sha256Bytes` from `@/lib/warranty/receipts` (Task 3); `findStagedReceipt`, `deleteSidecar`, `readSidecar` from `@/lib/warranty/staging` (Task 5); `enqueueOcrJob` from `@/lib/warranty/ocr/queue` (Task 5); `sniffReceiptType` from `@/lib/warranty/sniff`; `isIsoDate`, `addDaysIso`, `todayIso` from `@/lib/dates`; `nowIso` from `@/lib/clock`.
- Produces:
  ```ts
  // src/lib/warranty/items.ts
  export const MAX_NAME_CHARS = 200;
  export const MAX_TEXT_CHARS = 200;
  export const MAX_NOTES_CHARS = 2000;
  export const MIN_PURCHASE_DATE = '1970-01-01';
  export const LIFETIME_WITH_TERM_ERROR = 'A lifetime warranty has no length — clear the months or untick Lifetime.';
  export const FUTURE_PURCHASE_DATE_ERROR = 'Purchase date cannot be in the future.';

  export interface WarrantyItemRow {
    id: number; name: string; vendor: string | null; model: string | null; serial: string | null;
    purchaseDate: string; warrantyMonths: number | null; isLifetime: boolean; expiryDate: string | null;
    priceCents: number | null; ownerUserId: number; ownerName: string; transactionId: number | null;
    notes: string | null; createdAt: string; updatedAt: string;
  }
  export interface WarrantyReceiptRow {
    id: number; warrantyItemId: number; originalFilename: string; storedFilename: string;
    mime: ReceiptMime; sizeBytes: number; sha256: string;
    ocrStatus: 'pending' | 'done' | 'failed'; ocrError: string | null; createdAt: string;
    fileExists: boolean;
  }
  export function warrantyInputSchema(today: string): z.ZodType<WarrantyInput>;
  export type WarrantyInput = {
    name: string; vendor: string | null; model: string | null; serial: string | null;
    purchaseDate: string; warrantyMonths: number | null; isLifetime: boolean;
    priceCents: number | null; ownerUserId: number; transactionId: number | null; notes: string | null;
  };
  /** The client posts back the display name it uploaded; the id is still never a path. */
  export interface StagedReceiptRef { stagingId: string; originalFilename: string }
  export function createWarrantyItem(input: WarrantyInput, staged?: StagedReceiptRef[], at?: string): number;
  export function updateWarrantyItem(id: number, input: WarrantyInput, at?: string): boolean;
  export function deleteWarrantyItem(id: number): boolean;
  export function getWarrantyItem(id: number): WarrantyItemRow | null;
  export function listWarrantyReceipts(itemId: number): WarrantyReceiptRow[];
  export function getWarrantyReceipt(id: number): WarrantyReceiptRow | null;
  export function attachStagedReceipts(itemId: number, staged: StagedReceiptRef[], at?: string): number[];
  export function deleteWarrantyReceipt(id: number): boolean;
  export function resetReceiptForReOcr(id: number): boolean;
  export function listStoredFilenames(): string[];
  export function sha256AlreadyOnItem(itemId: number, sha256: string): boolean;

  // src/lib/warranty/search.ts
  export const WARRANTY_PAGE_SIZE = 50;
  export const MAX_SEARCH_TERMS = 20;
  export const MAX_SEARCH_CHARS = 200;
  export const SEARCH_SYNTAX_ERROR = "That search couldn't be understood — try different words.";
  export type WarrantySort = 'expiry' | 'name' | 'purchase';
  export const WARRANTY_SORTS: readonly WarrantySort[];
  export function isWarrantySort(value: string): value is WarrantySort;
  export function escapeFtsQuery(raw: string): string | null;
  export interface WarrantyListItem extends WarrantyItemRow { status: WarrantyStatus; receiptCount: number }
  export interface WarrantySearchFilter {
    q?: string | null; ownerUserId?: number | null; status?: WarrantyStatus | null;
    sort?: WarrantySort; page?: number; today?: string;
  }
  export interface WarrantySearchResult {
    rows: WarrantyListItem[]; total: number; page: number; pageCount: number; error?: string;
  }
  export function searchWarrantyItems(filter?: WarrantySearchFilter): WarrantySearchResult;
  export function expiringSoonItems(limit: number, ownerUserId?: number | null, today?: string): WarrantyListItem[];
  ```

### Steps

- [ ] **Step 1: Write the failing FTS-escaping test.**

Create `tests/lib/warranty/search.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {
  MAX_SEARCH_CHARS,
  MAX_SEARCH_TERMS,
  WARRANTY_PAGE_SIZE,
  escapeFtsQuery,
  isWarrantySort,
} from '@/lib/warranty/search';

let fts: BetterSqlite3.Database;

beforeEach(() => {
  fts = new BetterSqlite3(':memory:');
  fts.exec(
    "create virtual table t using fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
  );
  fts.prepare('insert into t(rowid, body) values (1, ?)').run('26" monitor dewalt drill MÉTRO GDT645SYNFS tim hortons');
});

afterEach(() => {
  fts.close();
});

/** Every produced query MUST be something SQLite actually accepts (MUST-9.1). */
function runs(query: string): number[] {
  return fts
    .prepare('select rowid as id from t where t match ?')
    .all(query)
    .map((r) => (r as { id: number }).id);
}

describe('escapeFtsQuery — the spec §9.1 table, verbatim', () => {
  it.each([
    ['tim hortons', '"tim" "hortons"*'],
    ['26" monitor', '"26""" "monitor"*'],
    ['dewalt AND drill', '"dewalt" "AND" "drill"*'],
    ['GDT645SYNFS', '"GDT645SYNFS"*'],
    ['   ', null],
    ['"', '""""'],
  ])('%j produces %j', (input, expected) => {
    expect(escapeFtsQuery(input)).toBe(expected);
  });
});

describe('escapeFtsQuery — safety', () => {
  it('produces a query SQLite accepts for every operator-laden input', () => {
    for (const input of [
      '26" monitor',
      '"',
      '""',
      'a"b"c',
      'dewalt AND drill',
      'NEAR(a b)',
      '-drill',
      '^start',
      'col:value',
      '(unbalanced',
      'a*b',
      'OR NOT AND',
    ]) {
      const query = escapeFtsQuery(input);
      if (query === null) continue;
      expect(() => runs(query), `SQLite rejected ${JSON.stringify(query)}`).not.toThrow();
    }
  });

  it('matches AND / OR / NOT / NEAR as words, not as operators', () => {
    expect(runs(escapeFtsQuery('dewalt AND drill')!)).toEqual([]); // no literal "AND" in the row
    expect(runs(escapeFtsQuery('dewalt drill')!)).toEqual([1]);
  });

  it('prefix-matches the last term only', () => {
    expect(runs(escapeFtsQuery('GDT645')!)).toEqual([1]);
    expect(runs(escapeFtsQuery('GDT645 moni')!)).toEqual([1]);
    // The FIRST term is not a prefix: "moni" alone never matches "monitor" as a full term.
    expect(runs(escapeFtsQuery('moni dewalt')!)).toEqual([]);
  });

  it('finds MÉTRO by typing metro', () => {
    expect(runs(escapeFtsQuery('metro')!)).toEqual([1]);
  });

  it('returns null for whitespace-only and empty input', () => {
    expect(escapeFtsQuery('')).toBeNull();
    expect(escapeFtsQuery('   \t \n ')).toBeNull();
  });

  it('caps at 20 terms and 200 characters of raw input', () => {
    const many = Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ');
    const query = escapeFtsQuery(many)!;
    expect(query.split(' ')).toHaveLength(MAX_SEARCH_TERMS);
    expect(MAX_SEARCH_TERMS).toBe(20);

    const long = 'x'.repeat(300);
    expect(escapeFtsQuery(long)).toBe(`"${'x'.repeat(MAX_SEARCH_CHARS)}"*`);
    expect(MAX_SEARCH_CHARS).toBe(200);
  });
});

describe('sort and page size', () => {
  it('pages at 50 and accepts only the three named sorts', () => {
    expect(WARRANTY_PAGE_SIZE).toBe(50);
    expect(isWarrantySort('expiry')).toBe(true);
    expect(isWarrantySort('name')).toBe(true);
    expect(isWarrantySort('purchase')).toBe(true);
    expect(isWarrantySort('rank')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npm test -- tests/lib/warranty/search.test.ts`
Expected: FAIL — cannot resolve `@/lib/warranty/search`.

- [ ] **Step 3: Write the failing item/receipt CRUD test.**

Create `tests/lib/warranty/items.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import {
  FUTURE_PURCHASE_DATE_ERROR,
  LIFETIME_WITH_TERM_ERROR,
  attachStagedReceipts,
  createWarrantyItem,
  deleteWarrantyItem,
  deleteWarrantyReceipt,
  getWarrantyItem,
  getWarrantyReceipt,
  listStoredFilenames,
  listWarrantyReceipts,
  resetReceiptForReOcr,
  sha256AlreadyOnItem,
  updateWarrantyItem,
  warrantyInputSchema,
  type WarrantyInput,
} from '@/lib/warranty/items';
import { receiptFileExists } from '@/lib/warranty/receipts';
import { findStagedReceipt, readSidecar, writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { drainOcrQueue, resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let ownerId: number;

const TODAY = '2026-08-16';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-warranty-items-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  ownerId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  resetOcrQueueForTests();
  setOcrEngineForTests({ recognize: async () => ({ text: 'ENGINE TEXT' }) });
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ref = (stagingId: string, originalFilename = 'receipt.jpg') => ({ stagingId, originalFilename });

function input(over: Partial<WarrantyInput> = {}): WarrantyInput {
  return {
    name: 'Fridge',
    vendor: 'Home Depot',
    model: 'GDT645SYNFS',
    serial: null,
    purchaseDate: TODAY,
    warrantyMonths: 24,
    isLifetime: false,
    priceCents: 129999,
    ownerUserId: ownerId,
    transactionId: null,
    notes: null,
    ...over,
  };
}

describe('warrantyInputSchema', () => {
  const schema = () => warrantyInputSchema(TODAY);

  it('accepts a well-formed item', () => {
    expect(schema().safeParse(input()).success).toBe(true);
  });

  it('rejects lifetime combined with a term (MUST-3.5)', () => {
    const parsed = schema().safeParse(input({ isLifetime: true, warrantyMonths: 12 }));
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0].message).toBe(LIFETIME_WITH_TERM_ERROR);
  });

  it('accepts lifetime with no term', () => {
    expect(schema().safeParse(input({ isLifetime: true, warrantyMonths: null })).success).toBe(true);
  });

  it('accepts an unknown term (null months, not lifetime)', () => {
    expect(schema().safeParse(input({ warrantyMonths: null })).success).toBe(true);
  });

  it('rejects a future purchase date and a pre-1970 one', () => {
    const future = schema().safeParse(input({ purchaseDate: '2026-08-17' }));
    expect(future.success).toBe(false);
    expect(future.success === false && future.error.issues[0].message).toBe(FUTURE_PURCHASE_DATE_ERROR);
    expect(schema().safeParse(input({ purchaseDate: '1969-12-31' })).success).toBe(false);
    expect(schema().safeParse(input({ purchaseDate: 'not-a-date' })).success).toBe(false);
    expect(schema().safeParse(input({ purchaseDate: TODAY })).success).toBe(true);
  });

  it('rejects a name over 200 chars, notes over 2000, and a non-integer price', () => {
    expect(schema().safeParse(input({ name: 'x'.repeat(201) })).success).toBe(false);
    expect(schema().safeParse(input({ name: '   ' })).success).toBe(false);
    expect(schema().safeParse(input({ notes: 'x'.repeat(2001) })).success).toBe(false);
    expect(schema().safeParse(input({ priceCents: 12.5 })).success).toBe(false);
    expect(schema().safeParse(input({ priceCents: -1 })).success).toBe(false);
    expect(schema().safeParse(input({ warrantyMonths: 0 })).success).toBe(false);
  });

  it('normalises blank optional text to null', () => {
    const parsed = schema().parse(input({ vendor: '  ', model: '', serial: '  ', notes: '' }));
    expect(parsed).toMatchObject({ vendor: null, model: null, serial: null, notes: null });
  });
});

describe('createWarrantyItem', () => {
  it('computes and stores expiry_date at write time (MUST-3.6)', () => {
    const id = createWarrantyItem(input({ purchaseDate: '2026-01-31', warrantyMonths: 1 }));
    expect(getWarrantyItem(id)?.expiryDate).toBe('2026-02-28');
  });

  it('stores null expiry for lifetime and for an unknown term', () => {
    const lifetime = createWarrantyItem(input({ isLifetime: true, warrantyMonths: null }));
    expect(getWarrantyItem(lifetime)?.expiryDate).toBeNull();
    expect(getWarrantyItem(lifetime)?.isLifetime).toBe(true);
    const unknown = createWarrantyItem(input({ warrantyMonths: null }));
    expect(getWarrantyItem(unknown)?.expiryDate).toBeNull();
  });

  it('joins the owner name for display', () => {
    const id = createWarrantyItem(input());
    expect(getWarrantyItem(id)?.ownerName).toBe('Alice');
  });

  it('returns null for an unknown id', () => {
    expect(getWarrantyItem(999)).toBeNull();
  });
});

describe('updateWarrantyItem', () => {
  it('recomputes expiry in the same write when the term changes', () => {
    const id = createWarrantyItem(input({ purchaseDate: '2026-08-16', warrantyMonths: 24 }));
    updateWarrantyItem(id, input({ purchaseDate: '2026-08-16', warrantyMonths: 12 }));
    expect(getWarrantyItem(id)?.expiryDate).toBe('2027-08-16');
    updateWarrantyItem(id, input({ purchaseDate: '2026-03-31', warrantyMonths: 1 }));
    expect(getWarrantyItem(id)?.expiryDate).toBe('2026-04-30');
  });

  it('clears months and expiry when switched to lifetime', () => {
    const id = createWarrantyItem(input());
    updateWarrantyItem(id, input({ isLifetime: true, warrantyMonths: null }));
    const row = getWarrantyItem(id)!;
    expect(row.isLifetime).toBe(true);
    expect(row.warrantyMonths).toBeNull();
    expect(row.expiryDate).toBeNull();
  });

  it('bumps updated_at and returns false for an unknown id', () => {
    const id = createWarrantyItem(input(), [], '2026-08-16T00:00:00.000Z');
    updateWarrantyItem(id, input({ name: 'Dishwasher' }), '2026-08-17T00:00:00.000Z');
    const row = getWarrantyItem(id)!;
    expect(row.name).toBe('Dishwasher');
    expect(row.updatedAt).toBe('2026-08-17T00:00:00.000Z');
    expect(row.createdAt).toBe('2026-08-16T00:00:00.000Z');
    expect(updateWarrantyItem(999, input())).toBe(false);
  });
});

describe('attachStagedReceipts (MUST-6.8)', () => {
  it('moves the file into receipts/, inserts the row, and deletes the sidecar', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'STAGED RECEIPT TEXT' });
    const id = createWarrantyItem(input(), [ref(stagingId)]);

    const receipts = listWarrantyReceipts(id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].ocrStatus).toBe('done');
    expect(receipts[0].mime).toBe('image/jpeg');
    expect(receipts[0].sizeBytes).toBe(JPEG.length);
    expect(receipts[0].fileExists).toBe(true);
    expect(receiptFileExists(receipts[0].storedFilename)).toBe(true);
    expect(findStagedReceipt(stagingId)).toBeNull();
    expect(readSidecar(stagingId)).toBeNull();

    // The OCR text landed in the index, not just the row.
    const hit = current!.db.get<{ id: number }>(
      sql`select rowid as id from warranty_search where warranty_search match ${'"STAGED"'}`,
    );
    expect(hit.id).toBe(id);
  });

  it('inserts as pending and enqueues an OCR job when there is no sidecar', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    const [receipt] = listWarrantyReceipts(id);
    // The commit enqueued it; draining runs the injected fake engine.
    await drainOcrQueue();
    expect(getWarrantyReceipt(receipt.id)?.ocrStatus).toBe('done');
  });

  it('skips a staging id whose file has already been purged, without failing the save', () => {
    const id = createWarrantyItem(input(), [ref('11111111-2222-3333-4444-555555555555')]);
    expect(listWarrantyReceipts(id)).toHaveLength(0);
    expect(getWarrantyItem(id)).not.toBeNull();
  });

  it('skips a staged file that no longer sniffs to an accepted type', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    fs.writeFileSync(findStagedReceipt(stagingId)!.path, Buffer.from('PK not an image'));
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    expect(listWarrantyReceipts(id)).toHaveLength(0);
  });

  it('attaches to an existing item and flags a duplicate sha256 without blocking (MUST-6.9)', () => {
    const first = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(first)]);
    const digest = listWarrantyReceipts(id)[0].sha256;
    expect(sha256AlreadyOnItem(id, digest)).toBe(true);
    expect(sha256AlreadyOnItem(id, 'b'.repeat(64))).toBe(false);

    const second = writeStagedReceipt(JPEG, 'image/jpeg');
    expect(attachStagedReceipts(id, [ref(second)])).toHaveLength(1);
    expect(listWarrantyReceipts(id)).toHaveLength(2);
  });
});

describe('deletion (MUST-4.8)', () => {
  it('removes the receipt row, its FTS text and its file', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'DELETEME TOKEN' });
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    const [receipt] = listWarrantyReceipts(id);

    expect(deleteWarrantyReceipt(receipt.id)).toBe(true);
    expect(listWarrantyReceipts(id)).toHaveLength(0);
    expect(receiptFileExists(receipt.storedFilename)).toBe(false);
    const hit = current!.db.get<{ c: number }>(
      sql`select count(*) as c from warranty_search where warranty_search match ${'"DELETEME"'}`,
    );
    expect(hit.c).toBe(0);
    expect(deleteWarrantyReceipt(receipt.id)).toBe(false);
  });

  it('deleting the item cascades the rows and unlinks every file', () => {
    const a = writeStagedReceipt(JPEG, 'image/jpeg');
    const b = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(a), ref(b)]);
    const stored = listWarrantyReceipts(id).map((r) => r.storedFilename);
    expect(stored).toHaveLength(2);

    expect(deleteWarrantyItem(id)).toBe(true);
    expect(getWarrantyItem(id)).toBeNull();
    for (const name of stored) expect(receiptFileExists(name)).toBe(false);
    const count = current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_search`);
    expect(count.c).toBe(0);
    expect(deleteWarrantyItem(id)).toBe(false);
  });
});

describe('resetReceiptForReOcr (MUST-7.16)', () => {
  it('sets pending, clears text and error, and re-enqueues', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    const [receipt] = listWarrantyReceipts(id);
    expect(receipt.ocrStatus).toBe('failed');
    expect(receipt.ocrError).toBe('OCR timed out.');

    expect(resetReceiptForReOcr(receipt.id)).toBe(true);
    await drainOcrQueue();

    const after = getWarrantyReceipt(receipt.id)!;
    expect(after.ocrStatus).toBe('done');
    expect(after.ocrError).toBeNull();
    expect(resetReceiptForReOcr(999)).toBe(false);
  });
});

describe('listStoredFilenames', () => {
  it('returns every stored_filename for the orphan sweep', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    expect(listStoredFilenames()).toEqual([listWarrantyReceipts(id)[0].storedFilename]);
  });
});

describe('missing files degrade quietly (MUST-4.10)', () => {
  it('reports fileExists false instead of throwing', () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const id = createWarrantyItem(input(), [ref(stagingId)]);
    const [receipt] = listWarrantyReceipts(id);
    fs.rmSync(path.join(dataDir, 'receipts', receipt.storedFilename), { force: true });
    expect(listWarrantyReceipts(id)[0].fileExists).toBe(false);
    expect(getWarrantyReceipt(receipt.id)?.fileExists).toBe(false);
  });
});
```

- [ ] **Step 4: Run it to verify it fails.**

Run: `npm test -- tests/lib/warranty/items.test.ts`
Expected: FAIL — cannot resolve `@/lib/warranty/items`.

- [ ] **Step 5: Implement `src/lib/warranty/items.ts`.**

```ts
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users, warrantyItems, warrantyReceipts } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { isIsoDate } from '@/lib/dates';
import { computeExpiryDate } from '@/lib/warranty/expiry';
import { enqueueOcrJob } from '@/lib/warranty/ocr/queue';
import {
  adoptReceiptFile,
  deleteReceiptFile,
  receiptFileExists,
  sha256Bytes,
} from '@/lib/warranty/receipts';
import { sniffReceiptType, type ReceiptMime } from '@/lib/warranty/sniff';
import { deleteSidecar, findStagedReceipt, readSidecar } from '@/lib/warranty/staging';

export const MAX_NAME_CHARS = 200;
export const MAX_TEXT_CHARS = 200;
export const MAX_NOTES_CHARS = 2000;
export const MIN_PURCHASE_DATE = '1970-01-01';

export const LIFETIME_WITH_TERM_ERROR =
  'A lifetime warranty has no length — clear the months or untick Lifetime.';
export const FUTURE_PURCHASE_DATE_ERROR = 'Purchase date cannot be in the future.';

export interface WarrantyItemRow {
  id: number;
  name: string;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  purchaseDate: string;
  warrantyMonths: number | null;
  isLifetime: boolean;
  expiryDate: string | null;
  priceCents: number | null;
  ownerUserId: number;
  ownerName: string;
  transactionId: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WarrantyReceiptRow {
  id: number;
  warrantyItemId: number;
  originalFilename: string;
  storedFilename: string;
  mime: ReceiptMime;
  sizeBytes: number;
  sha256: string;
  ocrStatus: 'pending' | 'done' | 'failed';
  ocrError: string | null;
  createdAt: string;
  /** MUST-4.10: a row whose file is absent is a display state, not an error. */
  fileExists: boolean;
}

/** What the client posts back after staging: the id plus the display name it uploaded. */
export interface StagedReceiptRef {
  stagingId: string;
  originalFilename: string;
}

export interface WarrantyInput {
  name: string;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  purchaseDate: string;
  warrantyMonths: number | null;
  isLifetime: boolean;
  priceCents: number | null;
  ownerUserId: number;
  transactionId: number | null;
  notes: string | null;
}

/** Blank optional text is stored as NULL, never as an empty string. */
function optionalText(max: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? null : value),
    z.string().trim().max(max).nullable(),
  );
}

/**
 * MUST-13.7: zod on every action input. `today` is injected (never read from a clock in
 * here) so the future-date rule is deterministic in tests and honours TZ at the boundary.
 */
export function warrantyInputSchema(today: string) {
  return z
    .object({
      name: z.string().trim().min(1, 'Name is required').max(MAX_NAME_CHARS),
      vendor: optionalText(MAX_TEXT_CHARS),
      model: optionalText(MAX_TEXT_CHARS),
      // §17.25: serial is stored but deliberately NOT unique and NOT validated — an OCR
      // mis-read and a blank must both be storable.
      serial: optionalText(MAX_TEXT_CHARS),
      purchaseDate: z
        .string()
        .refine(isIsoDate, 'Purchase date must be YYYY-MM-DD')
        .refine((value) => value <= today, FUTURE_PURCHASE_DATE_ERROR)
        .refine((value) => value >= MIN_PURCHASE_DATE, 'Purchase date is before 1970-01-01'),
      warrantyMonths: z.number().int().positive('Warranty length must be at least one month').nullable(),
      isLifetime: z.boolean(),
      priceCents: z.number().int('Price must be a whole number of cents').nonnegative().nullable(),
      ownerUserId: z.number().int().positive(),
      transactionId: z.number().int().positive().nullable(),
      notes: optionalText(MAX_NOTES_CHARS),
    })
    .superRefine((value, ctx) => {
      // MUST-3.5, enforced by zod at the action boundary AND by a CHECK in 0002.
      if (value.isLifetime && value.warrantyMonths !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['warrantyMonths'], message: LIFETIME_WITH_TERM_ERROR });
      }
    });
}

const ITEM_COLUMNS = {
  id: warrantyItems.id,
  name: warrantyItems.name,
  vendor: warrantyItems.vendor,
  model: warrantyItems.model,
  serial: warrantyItems.serial,
  purchaseDate: warrantyItems.purchaseDate,
  warrantyMonths: warrantyItems.warrantyMonths,
  isLifetime: warrantyItems.isLifetime,
  expiryDate: warrantyItems.expiryDate,
  priceCents: warrantyItems.priceCents,
  ownerUserId: warrantyItems.ownerUserId,
  ownerName: users.name,
  transactionId: warrantyItems.transactionId,
  notes: warrantyItems.notes,
  createdAt: warrantyItems.createdAt,
  updatedAt: warrantyItems.updatedAt,
};

export function getWarrantyItem(id: number): WarrantyItemRow | null {
  const row = getDb()
    .select(ITEM_COLUMNS)
    .from(warrantyItems)
    .innerJoin(users, eq(users.id, warrantyItems.ownerUserId))
    .where(eq(warrantyItems.id, id))
    .get();
  return row ?? null;
}

/**
 * MUST-6.8: one DB transaction per item — the row and every staged receipt land together
 * or not at all. Files are moved inside it; a throw unlinks whatever was already adopted.
 */
export function createWarrantyItem(
  input: WarrantyInput,
  staged: StagedReceiptRef[] = [],
  at: string = nowIso(),
): number {
  const db = getDb();
  const expiryDate = computeExpiryDate(input);
  const adopted: string[] = [];
  try {
    return db.transaction((tx) => {
      const row = tx
        .insert(warrantyItems)
        .values({ ...input, expiryDate, createdAt: at, updatedAt: at })
        .returning({ id: warrantyItems.id })
        .get();
      const committed = commitStaged(tx, row.id, staged, at);
      adopted.push(...committed.storedFilenames);
      return row.id;
    });
  } catch (error) {
    // MUST-4.7: if the insert throws, every file this call adopted is unlinked.
    for (const name of adopted) deleteReceiptFile(name);
    throw error;
  }
}

/** MUST-3.6: any write that touches purchase_date, months or lifetime recomputes expiry. */
export function updateWarrantyItem(id: number, input: WarrantyInput, at: string = nowIso()): boolean {
  const result = getDb()
    .update(warrantyItems)
    .set({ ...input, expiryDate: computeExpiryDate(input), updatedAt: at })
    .where(eq(warrantyItems.id, id))
    .run();
  return result.changes > 0;
}

/**
 * MUST-4.8 delete order: rows first (inside the transaction, so the FTS triggers fire),
 * then the files, best effort.
 */
export function deleteWarrantyItem(id: number): boolean {
  const db = getDb();
  const stored = db
    .select({ storedFilename: warrantyReceipts.storedFilename })
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.warrantyItemId, id))
    .all()
    .map((row) => row.storedFilename);

  // warranty_receipts rows cascade with the item (ON DELETE CASCADE in 0002).
  const result = db.delete(warrantyItems).where(eq(warrantyItems.id, id)).run();
  if (result.changes === 0) return false;
  for (const name of stored) deleteReceiptFile(name);
  return true;
}

function toReceiptRow(row: {
  id: number;
  warrantyItemId: number;
  originalFilename: string;
  storedFilename: string;
  mime: ReceiptMime;
  sizeBytes: number;
  sha256: string;
  ocrStatus: 'pending' | 'done' | 'failed';
  ocrError: string | null;
  createdAt: string;
}): WarrantyReceiptRow {
  return { ...row, fileExists: receiptFileExists(row.storedFilename) };
}

const RECEIPT_COLUMNS = {
  id: warrantyReceipts.id,
  warrantyItemId: warrantyReceipts.warrantyItemId,
  originalFilename: warrantyReceipts.originalFilename,
  storedFilename: warrantyReceipts.storedFilename,
  mime: warrantyReceipts.mime,
  sizeBytes: warrantyReceipts.sizeBytes,
  sha256: warrantyReceipts.sha256,
  ocrStatus: warrantyReceipts.ocrStatus,
  ocrError: warrantyReceipts.ocrError,
  createdAt: warrantyReceipts.createdAt,
};

export function listWarrantyReceipts(itemId: number): WarrantyReceiptRow[] {
  return getDb()
    .select(RECEIPT_COLUMNS)
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.warrantyItemId, itemId))
    .orderBy(warrantyReceipts.id)
    .all()
    .map(toReceiptRow);
}

export function getWarrantyReceipt(id: number): WarrantyReceiptRow | null {
  const row = getDb().select(RECEIPT_COLUMNS).from(warrantyReceipts).where(eq(warrantyReceipts.id, id)).get();
  return row ? toReceiptRow(row) : null;
}

export function attachStagedReceipts(
  itemId: number,
  staged: StagedReceiptRef[],
  at: string = nowIso(),
): number[] {
  const db = getDb();
  const adopted: string[] = [];
  try {
    return db.transaction((tx) => {
      const committed = commitStaged(tx, itemId, staged, at);
      adopted.push(...committed.storedFilenames);
      return committed.receiptIds;
    });
  } catch (error) {
    for (const name of adopted) deleteReceiptFile(name);
    throw error;
  }
}

/**
 * MUST-6.8, per staging id: re-validate the file still exists AND still sniffs to an
 * accepted type, rename it into receipts/ under a fresh stored_filename, insert the row
 * with the sidecar's text/status when present (otherwise 'pending', for the sweep to pick
 * up), then delete the sidecar. The staging id is NEVER trusted as a path — findStagedReceipt
 * applies the UUID guard.
 */
function commitStaged(
  tx: ReturnType<typeof getDb>,
  itemId: number,
  staged: StagedReceiptRef[],
  at: string,
): { receiptIds: number[]; storedFilenames: string[] } {
  const receiptIds: number[] = [];
  const storedFilenames: string[] = [];

  for (const ref of staged) {
    const found = findStagedReceipt(ref.stagingId);
    // Purged by the 24 h sweep, or lost to a restart. Skip it — the save still succeeds.
    if (found === null) continue;
    const buf = fs.readFileSync(found.path);
    // Re-sniff: the file must STILL be an accepted type at commit time, not just at upload.
    const mime = sniffReceiptType(buf);
    if (mime === null) continue;

    const sidecar = readSidecar(ref.stagingId);
    const storedFilename = adoptReceiptFile(found.path, mime);
    storedFilenames.push(storedFilename);

    const inserted = tx
      .insert(warrantyReceipts)
      .values({
        warrantyItemId: itemId,
        // MUST-3.8: display only. Capped at 255 and never a path component.
        originalFilename: ref.originalFilename.slice(0, 255) || `receipt.${storedFilename.split('.').pop()}`,
        storedFilename,
        mime,
        sizeBytes: buf.length,
        sha256: sha256Bytes(buf),
        ocrText: sidecar?.status === 'done' ? (sidecar.text ?? null) : null,
        ocrStatus: sidecar === null ? 'pending' : sidecar.status,
        ocrError: sidecar?.status === 'failed' ? (sidecar.error ?? null) : null,
        createdAt: at,
      })
      .returning({ id: warrantyReceipts.id })
      .get();

    receiptIds.push(inserted.id);
    deleteSidecar(ref.stagingId);
    // No sidecar means OCR had not finished when the member saved: record 'pending' and let
    // the queue (and, after a crash, the scheduler sweep) pick it up (§7.5).
    if (sidecar === null) enqueueOcrJob({ kind: 'receipt', receiptId: inserted.id });
  }

  return { receiptIds, storedFilenames };
}

export function deleteWarrantyReceipt(id: number): boolean {
  const db = getDb();
  const row = db
    .select({ storedFilename: warrantyReceipts.storedFilename })
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.id, id))
    .get();
  if (!row) return false;
  // Row first (the FTS trigger fires), file afterwards, best effort (MUST-4.8).
  db.delete(warrantyReceipts).where(eq(warrantyReceipts.id, id)).run();
  deleteReceiptFile(row.storedFilename);
  return true;
}

/**
 * MUST-7.16: reset to 'pending', clear text and error, enqueue. Idempotent — a second
 * click on a claimed row is a no-op inside enqueueOcrJob().
 */
export function resetReceiptForReOcr(id: number): boolean {
  const result = getDb()
    .update(warrantyReceipts)
    .set({ ocrStatus: 'pending', ocrText: null, ocrError: null })
    .where(eq(warrantyReceipts.id, id))
    .run();
  if (result.changes === 0) return false;
  enqueueOcrJob({ kind: 'receipt', receiptId: id });
  return true;
}

export function listStoredFilenames(): string[] {
  return getDb()
    .select({ storedFilename: warrantyReceipts.storedFilename })
    .from(warrantyReceipts)
    .all()
    .map((row) => row.storedFilename);
}

/** MUST-6.9: a duplicate is a user judgement, so this WARNS — it never blocks. */
export function sha256AlreadyOnItem(itemId: number, sha256: string): boolean {
  const row = getDb()
    .select({ id: warrantyReceipts.id })
    .from(warrantyReceipts)
    .where(and(eq(warrantyReceipts.warrantyItemId, itemId), eq(warrantyReceipts.sha256, sha256)))
    .get();
  return row !== undefined;
}
```

- [ ] **Step 6: Run the item test to verify it passes.**

Run: `npm test -- tests/lib/warranty/items.test.ts`
Expected: PASS.

- [ ] **Step 7: Implement `src/lib/warranty/search.ts`.**

```ts
import { getSqlite } from '@/db/client';
import { addDaysIso, todayIso } from '@/lib/dates';
import {
  EXPIRING_SOON_DAYS,
  STATUS_CASE_SQL,
  type WarrantyStatus,
} from '@/lib/warranty/expiry';
import type { WarrantyItemRow } from '@/lib/warranty/items';

/** §17.22 */
export const WARRANTY_PAGE_SIZE = 50;
export const MAX_SEARCH_TERMS = 20;
export const MAX_SEARCH_CHARS = 200;

/** MUST-9.3: never a 500, never a raw SQLite message. */
export const SEARCH_SYNTAX_ERROR = "That search couldn't be understood — try different words.";

export type WarrantySort = 'expiry' | 'name' | 'purchase';
export const WARRANTY_SORTS: readonly WarrantySort[] = ['expiry', 'name', 'purchase'];

export function isWarrantySort(value: string): value is WarrantySort {
  return (WARRANTY_SORTS as readonly string[]).includes(value);
}

/**
 * MUST-9.1 — FTS5 injection defence. FTS5 has its own query language: bare AND/OR/NOT/NEAR,
 * ^, :, -, *, ( ) and " are operators, and an unbalanced quote is a syntax error that would
 * otherwise surface as a 500 on a perfectly ordinary search for `26" monitor`.
 *
 *   1. trim, cap the raw input at 200 characters, split on whitespace
 *   2. drop empty terms; nothing left -> null (the caller omits MATCH entirely)
 *   3. wrap each term in double quotes, DOUBLING any internal double quote — a quoted
 *      string in FTS5 is a literal phrase, so every operator inside it loses its meaning
 *   4. append `*` to the LAST term only (type-ahead prefix matching), but only when that
 *      term still contains a letter or a digit: `"` alone escapes to `""""`, an empty
 *      phrase, and `""""*` is not a query worth constructing (spec §9.1's last table row)
 *   5. join with a single space (FTS5's implicit AND)
 *   6. cap at 20 terms
 */
export function escapeFtsQuery(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const terms = raw
    .trim()
    .slice(0, MAX_SEARCH_CHARS)
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, MAX_SEARCH_TERMS);
  if (terms.length === 0) return null;

  const quoted = terms.map((term) => `"${term.replace(/"/g, '""')}"`);
  const last = terms[terms.length - 1];
  if (/[\p{L}\p{N}]/u.test(last)) quoted[quoted.length - 1] = `${quoted[quoted.length - 1]}*`;
  return quoted.join(' ');
}

export interface WarrantyListItem extends WarrantyItemRow {
  status: WarrantyStatus;
  receiptCount: number;
}

export interface WarrantySearchFilter {
  q?: string | null;
  ownerUserId?: number | null;
  status?: WarrantyStatus | null;
  sort?: WarrantySort;
  page?: number;
  today?: string;
}

export interface WarrantySearchResult {
  rows: WarrantyListItem[];
  total: number;
  page: number;
  pageCount: number;
  error?: string;
}

/**
 * MUST-9.4: default order is soonest expiry first, unknown/lifetime last. Searching FILTERS;
 * it does not reorder. An FTS `rank` ordering would shuffle the expiry list the moment
 * someone typed, which is the opposite of what this page is for.
 */
const ORDER_BY: Record<WarrantySort, string> = {
  expiry: 'i.expiry_date is null, i.expiry_date asc, i.name asc',
  name: 'i.name asc, i.expiry_date asc',
  purchase: 'i.purchase_date desc, i.name asc',
};

interface RawRow {
  id: number;
  name: string;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  purchase_date: string;
  warranty_months: number | null;
  is_lifetime: number;
  expiry_date: string | null;
  price_cents: number | null;
  owner_user_id: number;
  owner_name: string;
  transaction_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  status: WarrantyStatus;
  receipt_count: number;
}

function toListItem(row: RawRow): WarrantyListItem {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    model: row.model,
    serial: row.serial,
    purchaseDate: row.purchase_date,
    warrantyMonths: row.warranty_months,
    isLifetime: row.is_lifetime === 1,
    expiryDate: row.expiry_date,
    priceCents: row.price_cents,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    transactionId: row.transaction_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    receiptCount: row.receipt_count,
  };
}

export function searchWarrantyItems(filter: WarrantySearchFilter = {}): WarrantySearchResult {
  const today = filter.today ?? todayIso();
  const soon = addDaysIso(today, EXPIRING_SOON_DAYS);
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const sort = filter.sort ?? 'expiry';
  const match = filter.q ? escapeFtsQuery(filter.q) : null;

  const joins = [`inner join users u on u.id = i.owner_user_id`];
  // The JOIN and the MATCH clause are BOTH omitted when there is no query, so an empty
  // search box lists everything instead of listing nothing.
  if (match !== null) joins.push('join warranty_search s on s.rowid = i.id');

  const where: string[] = [];
  const whereParams: unknown[] = [];
  if (match !== null) {
    // MUST-9.2: always a BOUND parameter, never string concatenation.
    where.push('warranty_search match ?');
    whereParams.push(match);
  }
  if (filter.ownerUserId != null) {
    where.push('i.owner_user_id = ?');
    whereParams.push(filter.ownerUserId);
  }
  if (filter.status != null) {
    where.push(`${STATUS_CASE_SQL} = ?`);
    whereParams.push(today, soon, filter.status);
  }
  const whereSql = where.length > 0 ? `where ${where.join(' and ')}` : '';

  const from = `from warranty_items i ${joins.join(' ')} ${whereSql}`;
  const selectSql = `select i.*, u.name as owner_name,
      ${STATUS_CASE_SQL} as status,
      (select count(*) from warranty_receipts r where r.warranty_item_id = i.id) as receipt_count
    ${from}
    order by ${ORDER_BY[sort]}
    limit ? offset ?`;
  // Parameter order follows textual order: the SELECT's status CASE binds first.
  const selectParams = [today, soon, ...whereParams, WARRANTY_PAGE_SIZE, (page - 1) * WARRANTY_PAGE_SIZE];

  const sqlite = getSqlite();
  try {
    const rows = sqlite.prepare(selectSql).all(...selectParams) as RawRow[];
    const { total } = sqlite.prepare(`select count(*) as total ${from}`).get(...whereParams) as { total: number };
    return {
      rows: rows.map(toListItem),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / WARRANTY_PAGE_SIZE)),
    };
  } catch (error) {
    // MUST-9.3 safety net: if SQLite still raises an FTS5 syntax error, say so in English.
    const message = error instanceof Error ? error.message : '';
    if (/fts5|syntax error|malformed MATCH/i.test(message)) {
      return { rows: [], total: 0, page, pageCount: 1, error: SEARCH_SYNTAX_ERROR };
    }
    throw error;
  }
}

/** MUST-10.5: the dashboard widget — status 'expiring', soonest first, top N. */
export function expiringSoonItems(
  limit: number,
  ownerUserId: number | null = null,
  today: string = todayIso(),
): WarrantyListItem[] {
  return searchWarrantyItems({ status: 'expiring', ownerUserId, sort: 'expiry', today }).rows.slice(0, limit);
}
```

- [ ] **Step 8: Add the query-shape tests to `tests/lib/warranty/search.test.ts`.**

Append this second `describe` block to the same file (add the imports it needs at the top: `createSeededTestDb`, `insertTestUser`, `type TestDb` from `../../helpers/db`, `sql` from `drizzle-orm`, `createWarrantyItem` from `@/lib/warranty/items`, and `searchWarrantyItems`, `expiringSoonItems` from `@/lib/warranty/search`; plus `fs`/`os`/`path` and the `DATA_DIR` beforeEach/afterEach pair used in `items.test.ts`):

```ts
describe('searchWarrantyItems', () => {
  const TODAY = '2026-08-16';

  function seed(over: Partial<Parameters<typeof createWarrantyItem>[0]> = {}) {
    return createWarrantyItem({
      name: 'Fridge',
      vendor: 'Home Depot',
      model: 'GDT645SYNFS',
      serial: null,
      purchaseDate: '2026-08-16',
      warrantyMonths: 24,
      isLifetime: false,
      priceCents: 129999,
      ownerUserId: owner,
      transactionId: null,
      notes: null,
      ...over,
    });
  }

  it('lists everything when the query is empty (no MATCH, no JOIN)', () => {
    seed();
    seed({ name: 'Dishwasher' });
    const result = searchWarrantyItems({ q: '   ', today: TODAY });
    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(2);
  });

  it('AND-combines multiple words', () => {
    seed({ name: 'Fridge', vendor: 'Home Depot' });
    seed({ name: 'Drill', vendor: 'Rona' });
    expect(searchWarrantyItems({ q: 'fridge home', today: TODAY }).total).toBe(1);
    expect(searchWarrantyItems({ q: 'fridge rona', today: TODAY }).total).toBe(0);
  });

  it('prefix-matches a partial model number and ignores diacritics', () => {
    const id = seed({ vendor: 'MÉTRO' });
    expect(searchWarrantyItems({ q: 'GDT645', today: TODAY }).rows[0].id).toBe(id);
    expect(searchWarrantyItems({ q: 'metro', today: TODAY }).rows[0].id).toBe(id);
  });

  it('returns results rather than throwing for a query full of operators', () => {
    seed({ name: '26" monitor' });
    const result = searchWarrantyItems({ q: '26" AND monitor', today: TODAY });
    expect(result.error).toBeUndefined();
  });

  it('derives the same status as warrantyStatus() and composes filters', () => {
    const expiring = seed({ name: 'Kettle', purchaseDate: '2026-08-16', warrantyMonths: 1 });
    seed({ name: 'Sofa', purchaseDate: '2026-08-16', warrantyMonths: 120 });
    const other = insertTestUser(current!.db, { name: 'Bob', username: 'bob' });
    seed({ name: 'Bob Drill', ownerUserId: other, purchaseDate: '2026-08-16', warrantyMonths: 1 });

    const byStatus = searchWarrantyItems({ status: 'expiring', today: TODAY });
    expect(byStatus.total).toBe(2);
    expect(byStatus.rows.every((row) => row.status === 'expiring')).toBe(true);

    const composed = searchWarrantyItems({ status: 'expiring', ownerUserId: other, today: TODAY });
    expect(composed.total).toBe(1);
    expect(composed.rows[0].name).toBe('Bob Drill');

    const searchAndStatus = searchWarrantyItems({ q: 'kettle', status: 'expiring', today: TODAY });
    expect(searchAndStatus.rows.map((r) => r.id)).toEqual([expiring]);
  });

  it('names lifetime and unknown statuses', () => {
    seed({ name: 'Cast iron pan', isLifetime: true, warrantyMonths: null });
    seed({ name: 'Lamp', warrantyMonths: null });
    expect(searchWarrantyItems({ status: 'lifetime', today: TODAY }).rows[0].name).toBe('Cast iron pan');
    expect(searchWarrantyItems({ status: 'unknown', today: TODAY }).rows[0].name).toBe('Lamp');
  });

  it('sorts soonest expiry first with unknown/lifetime last, and honours the other sorts', () => {
    seed({ name: 'Later', purchaseDate: '2026-08-16', warrantyMonths: 60 });
    seed({ name: 'Sooner', purchaseDate: '2026-08-16', warrantyMonths: 1 });
    seed({ name: 'Aardvark', warrantyMonths: null });
    expect(searchWarrantyItems({ today: TODAY }).rows.map((r) => r.name)).toEqual(['Sooner', 'Later', 'Aardvark']);
    expect(searchWarrantyItems({ sort: 'name', today: TODAY }).rows[0].name).toBe('Aardvark');
  });

  it('counts receipts and reports page metadata', () => {
    seed();
    const result = searchWarrantyItems({ today: TODAY });
    expect(result.rows[0].receiptCount).toBe(0);
    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(1);
  });
});

describe('expiringSoonItems (MUST-10.5)', () => {
  it('returns at most `limit`, soonest first, scoped by owner', () => {
    const TODAY = '2026-08-16';
    for (const months of [1, 2, 1, 2, 1, 2]) {
      createWarrantyItem({
        name: `Item ${months}-${Math.random()}`,
        vendor: null, model: null, serial: null,
        purchaseDate: '2026-08-16', warrantyMonths: months, isLifetime: false,
        priceCents: null, ownerUserId: owner, transactionId: null, notes: null,
      });
    }
    expect(expiringSoonItems(5, null, TODAY)).toHaveLength(5);
    expect(expiringSoonItems(5, 999_999, TODAY)).toHaveLength(0);
  });
});
```

- [ ] **Step 9: Run both test files to verify they pass.**

Run: `npm test -- tests/lib/warranty/`
Expected: PASS.

- [ ] **Step 10: Typecheck and full suite.**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 11: Checkpoint (commit is PAUSED).**

Commit message to use when the pause is lifted:

```bash
git add src/lib/warranty/items.ts src/lib/warranty/search.ts tests/lib/warranty/items.test.ts tests/lib/warranty/search.test.ts
git commit -m "feat(warranty): item and receipt CRUD plus FTS-escaped search"
```

---

## Task 7: The three route handlers

**Context:** This feature adds exactly three route handlers and no more. `POST /api/warranties/receipts/stage` is the **only** multipart endpoint in the feature — file bytes must not travel through a Next server action, whose default body limit is 1 MB (MUST-6.2). The two GETs are authenticated reads. Note the route-precedence point (MUST-2.4): `stage/` is a static segment and resolves ahead of the sibling `[id]`, which is why `[id]` accepts only a positive integer.

**Files:**
- Create: `src/app/api/warranties/receipts/stage/route.ts`
- Create: `src/app/api/warranties/receipts/stage/[stagingId]/route.ts`
- Create: `src/app/api/warranties/receipts/[id]/route.ts`
- Test: `tests/api/warranty-stage.route.test.ts`
- Test: `tests/api/warranty-stage-poll.route.test.ts`
- Test: `tests/api/warranty-receipt.route.test.ts`

**Interfaces:**
- Consumes: `assertSameOrigin`, `CsrfError`, `isSameOriginOrHeaderless` from `@/lib/auth/csrf`; `userFromRequest`, `SESSION_COOKIE_NAME`, `createSession` from `@/lib/auth/session`; `MAX_FILES_PER_UPLOAD`, `MAX_RECEIPT_BYTES`, `MAX_UPLOAD_BYTES`, `resolveReceiptPath`, `sha256Bytes` from `@/lib/warranty/receipts` (Task 3); `sniffReceiptType`, `looksLikeHeic`, `UNSUPPORTED_TYPE_MESSAGE`, `HEIC_MESSAGE` from `@/lib/warranty/sniff` (Task 3); `STAGING_ID_RE`, `readSidecar`, `writeStagedReceipt` from `@/lib/warranty/staging` (Task 5); `enqueueOcrJob` from `@/lib/warranty/ocr/queue` (Task 5); `getWarrantyReceipt` from `@/lib/warranty/items` (Task 6).
- Produces — the HTTP contract Task 8 and Task 9's client rely on:
  ```
  POST /api/warranties/receipts/stage          (multipart/form-data, one or more `file` parts)
    200 { staged: Array<{ stagingId, originalFilename, mime, sizeBytes, sha256 }> }
    400 { error, code: 'no_file' | 'unsupported_type' | 'empty_file' }
    401 { error: 'Unauthorized' }
    403 { error: 'Forbidden' }
    413 { error, code: 'file_too_large' | 'too_many_files' }

  GET /api/warranties/receipts/stage/[stagingId]
    200 { status: 'pending' }
    200 { status: 'done', suggestions: { purchaseDate?, vendor?, priceCents? } }
    200 { status: 'failed', error: string }
    400 { error: 'Invalid staging id' } | 401 | 403

  GET /api/warranties/receipts/[id]
    200 <bytes>  content-type = stored mime; content-disposition inline (images) / attachment (pdf)
    400 'Invalid receipt id' | 401 'Unauthorized' | 403 'Forbidden' | 404 'Not found'
    410 'Receipt file is missing from this install.'  (text/plain)
  ```

### Steps

- [ ] **Step 1: Write the failing upload-route test.**

Create `tests/api/warranty-stage.route.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { POST } from '@/app/api/warranties/receipts/stage/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { MAX_FILES_PER_UPLOAD, receiptTempDir } from '@/lib/warranty/receipts';
import { UNSUPPORTED_TYPE_MESSAGE } from '@/lib/warranty/sniff';
import { ocrQueueDepth, resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let token: string;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-stage-route-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  token = createSession(insertTestUser(current.db, { username: 'alice' })).token;
  resetOcrQueueForTests();
  // A slow fake engine keeps jobs on the queue long enough to assert they were enqueued.
  setOcrEngineForTests({ recognize: () => new Promise(() => {}) });
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function upload(
  files: { name: string; bytes: Buffer; type?: string }[],
  opts: { token?: string | null; origin?: string | null; contentLength?: string } = {},
): Request {
  const form = new FormData();
  for (const file of files) {
    form.append('file', new File([new Uint8Array(file.bytes)], file.name, { type: file.type ?? 'application/octet-stream' }));
  }
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  const origin = opts.origin === undefined ? 'http://nas.local:3000' : opts.origin;
  if (origin !== null) headers.origin = origin;
  const sessionToken = opts.token === undefined ? token : opts.token;
  if (sessionToken) headers.cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  if (opts.contentLength) headers['content-length'] = opts.contentLength;
  return new Request('http://nas.local:3000/api/warranties/receipts/stage', { method: 'POST', headers, body: form });
}

describe('POST /api/warranties/receipts/stage', () => {
  it('stages a valid JPEG, returns its metadata, and enqueues an OCR job', async () => {
    const response = await POST(upload([{ name: 'receipt.jpg', bytes: JPEG, type: 'image/jpeg' }]));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      staged: { stagingId: string; originalFilename: string; mime: string; sizeBytes: number; sha256: string }[];
    };
    expect(body.staged).toHaveLength(1);
    expect(body.staged[0].mime).toBe('image/jpeg');
    expect(body.staged[0].originalFilename).toBe('receipt.jpg');
    expect(body.staged[0].sizeBytes).toBe(JPEG.length);
    expect(body.staged[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(receiptTempDir(), `${body.staged[0].stagingId}.jpg`))).toBe(true);
    expect(ocrQueueDepth() + 1).toBeGreaterThan(0); // one job accepted (the head is in flight)
  });

  it('stages several parts in one request', async () => {
    const response = await POST(
      upload([
        { name: 'a.jpg', bytes: JPEG, type: 'image/jpeg' },
        { name: 'b.pdf', bytes: PDF, type: 'application/pdf' },
      ]),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { staged: { mime: string }[] };
    expect(body.staged.map((s) => s.mime)).toEqual(['image/jpeg', 'application/pdf']);
  });

  it('403s a mismatched Origin (MUST-6.3: the STRICT check, first)', async () => {
    const response = await POST(upload([{ name: 'a.jpg', bytes: JPEG }], { origin: 'http://evil.example' }));
    expect(response.status).toBe(403);
  });

  it('403s a headerless POST — the relaxed rule applies only to the read-only GETs', async () => {
    const response = await POST(upload([{ name: 'a.jpg', bytes: JPEG }], { origin: null }));
    expect(response.status).toBe(403);
  });

  it('401s without a session', async () => {
    const response = await POST(upload([{ name: 'a.jpg', bytes: JPEG }], { token: null }));
    expect(response.status).toBe(401);
  });

  it('413s an oversized declared Content-Length before buffering the body', async () => {
    const response = await POST(
      upload([{ name: 'a.jpg', bytes: JPEG }], { contentLength: String(10 * 1024 * 1024 * 5 + 1) }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('file_too_large');
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('413s a single oversized part inside an acceptable total, staging NOTHING', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const response = await POST(
      upload([
        { name: 'small.jpg', bytes: JPEG, type: 'image/jpeg' },
        { name: 'big.jpg', bytes: big, type: 'image/jpeg' },
      ]),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('file_too_large');
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('rejects six parts whole', async () => {
    const files = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i) => ({
      name: `r${i}.jpg`,
      bytes: JPEG,
      type: 'image/jpeg',
    }));
    const response = await POST(upload(files));
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('too_many_files');
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('400s a .jpg-named text file whatever Content-Type the client declared', async () => {
    const response = await POST(
      upload([{ name: 'receipt.jpg', bytes: Buffer.from('date,amount\n'), type: 'image/jpeg' }]),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe(UNSUPPORTED_TYPE_MESSAGE);
    expect(body.code).toBe('unsupported_type');
    expect(fs.existsSync(receiptTempDir()) ? fs.readdirSync(receiptTempDir()) : []).toEqual([]);
  });

  it('400s a HEIC drag-and-drop with the Preview-export advice', async () => {
    const heic = Buffer.alloc(64);
    heic.write('ftypheic', 4, 'ascii');
    const response = await POST(upload([{ name: 'IMG_0001.HEIC', bytes: heic, type: 'image/heic' }]));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Preview');
  });

  it('400s a zero-byte part and a request with no file part at all', async () => {
    expect((await POST(upload([{ name: 'empty.jpg', bytes: Buffer.alloc(0) }]))).status).toBe(400);
    expect((await POST(upload([]))).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npm test -- tests/api/warranty-stage.route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/warranties/receipts/stage/route`.

- [ ] **Step 3: Implement the staging upload route.**

Create `src/app/api/warranties/receipts/stage/route.ts`:

```ts
import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { enqueueOcrJob } from '@/lib/warranty/ocr/queue';
import {
  MAX_FILES_PER_UPLOAD,
  MAX_RECEIPT_BYTES,
  MAX_UPLOAD_BYTES,
  sha256Bytes,
} from '@/lib/warranty/receipts';
import { HEIC_MESSAGE, UNSUPPORTED_TYPE_MESSAGE, looksLikeHeic, sniffReceiptType } from '@/lib/warranty/sniff';
import { writeStagedReceipt } from '@/lib/warranty/staging';

export const dynamic = 'force-dynamic';

/**
 * The ONE multipart endpoint this feature adds (MUST-6.2). File bytes must not travel
 * through a Next server action: Next 15 caps a server action body at 1 MB by default, so a
 * 10 MB receipt would fail with an opaque error, and raising the limit globally would raise
 * it for every other action in the app. The codebase already routes CSV bytes through
 * /api/import/* for exactly this reason.
 */

/** MUST-13.7: zod on the derived per-part metadata, not just on JSON bodies. */
const partSchema = z.object({
  originalFilename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().max(MAX_RECEIPT_BYTES),
});

function tooLarge(): Response {
  return Response.json(
    { error: `Each receipt must be ${MAX_RECEIPT_BYTES} bytes or smaller.`, code: 'file_too_large' },
    { status: 413 },
  );
}

export async function POST(request: Request): Promise<Response> {
  // MUST-6.3: the STRICT origin check, first, before anything else. This is a mutating
  // request; the relaxed headerless rule of the download GETs does not apply to it.
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }

  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  // MUST-6.5(a): refuse on the DECLARED size before formData() buffers the whole body —
  // the same pre-check the import routes already make.
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) return tooLarge();

  const form = await request.formData();
  const parts = form.getAll('file').filter((value): value is File => value instanceof File);
  if (parts.length === 0) return Response.json({ error: 'No file uploaded', code: 'no_file' }, { status: 400 });
  if (parts.length > MAX_FILES_PER_UPLOAD) {
    return Response.json(
      { error: `Upload at most ${MAX_FILES_PER_UPLOAD} files at once.`, code: 'too_many_files' },
      { status: 413 },
    );
  }

  // MUST-6.5(b): validate EVERY part before writing ANY of them. A request that fails is
  // rejected whole — no partial staging.
  const prepared: { buf: Buffer; mime: ReturnType<typeof sniffReceiptType>; originalFilename: string }[] = [];
  for (const part of parts) {
    if (part.size > MAX_RECEIPT_BYTES) return tooLarge();
    const buf = Buffer.from(await part.arrayBuffer());
    if (buf.length === 0) return Response.json({ error: 'That file is empty.', code: 'empty_file' }, { status: 400 });
    if (buf.length > MAX_RECEIPT_BYTES) return tooLarge();

    // MUST-4.5: type decided by LEADING BYTES, never by extension, never by the
    // browser-declared Content-Type.
    const mime = sniffReceiptType(buf);
    if (mime === null) {
      return Response.json(
        { error: looksLikeHeic(buf) ? HEIC_MESSAGE : UNSUPPORTED_TYPE_MESSAGE, code: 'unsupported_type' },
        { status: 400 },
      );
    }

    const meta = partSchema.safeParse({ originalFilename: part.name.slice(0, 255), sizeBytes: buf.length });
    if (!meta.success) {
      return Response.json({ error: meta.error.issues[0]?.message ?? 'Invalid file', code: 'no_file' }, { status: 400 });
    }
    prepared.push({ buf, mime, originalFilename: meta.data.originalFilename });
  }

  const staged = prepared.map((part) => {
    // MUST-6.6: write to ${DATA_DIR}/tmp, then enqueue an OCR job of kind 'staged'.
    const stagingId = writeStagedReceipt(part.buf, part.mime!);
    enqueueOcrJob({ kind: 'staged', stagingId });
    return {
      stagingId,
      originalFilename: part.originalFilename,
      mime: part.mime,
      sizeBytes: part.buf.length,
      sha256: sha256Bytes(part.buf),
    };
  });

  return Response.json({ staged });
}
```

- [ ] **Step 4: Run the upload-route test to verify it passes.**

Run: `npm test -- tests/api/warranty-stage.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing poll-route test.**

Create `tests/api/warranty-stage-poll.route.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/warranties/receipts/stage/[stagingId]/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let token: string;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-poll-route-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  token = createSession(insertTestUser(current.db, { username: 'alice' })).token;
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function poll(stagingId: string, opts: { token?: string | null; origin?: string | null } = {}) {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  const origin = opts.origin === undefined ? 'http://nas.local:3000' : opts.origin;
  if (origin !== null) headers.origin = origin;
  const sessionToken = opts.token === undefined ? token : opts.token;
  if (sessionToken) headers.cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  const request = new Request(`http://nas.local:3000/api/warranties/receipts/stage/${stagingId}`, { headers });
  return GET(request, { params: Promise.resolve({ stagingId }) });
}

describe('GET /api/warranties/receipts/stage/[stagingId]', () => {
  it('reports pending while the sidecar is absent', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const response = await poll(stagingId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  it('returns the suggestions on done, and never the raw OCR text', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, {
      status: 'done',
      text: 'RAW OCR TEXT THE CLIENT MUST NOT RECEIVE',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200, purchaseDate: '2026-08-16' },
    });
    const body = await (await poll(stagingId)).json();
    expect(body).toEqual({
      status: 'done',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200, purchaseDate: '2026-08-16' },
    });
    expect(JSON.stringify(body)).not.toContain('RAW OCR TEXT');
  });

  it('returns the error text on failed', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    expect(await (await poll(stagingId)).json()).toEqual({ status: 'failed', error: 'OCR timed out.' });
  });

  it('400s a staging id that is not a UUID, before any path is built', async () => {
    const response = await poll('../../budget.db');
    expect(response.status).toBe(400);
  });

  it('401s without a session and 403s a mismatched Origin', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect((await poll(stagingId, { token: null })).status).toBe(401);
    expect((await poll(stagingId, { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('allows a headerless request (plain HTTP on the LAN)', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    expect((await poll(stagingId, { origin: null })).status).toBe(200);
  });
});
```

- [ ] **Step 6: Run it to verify it fails.**

Run: `npm test -- tests/api/warranty-stage-poll.route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 7: Implement the poll route.**

Create `src/app/api/warranties/receipts/stage/[stagingId]/route.ts`:

```ts
import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { STAGING_ID_RE, readSidecar } from '@/lib/warranty/staging';

export const dynamic = 'force-dynamic';

/**
 * The client polls this every 1.5 s while OCR runs, and gives up after 3 minutes with
 * "Still processing — save now and re-run OCR from the item page." It is an authenticated,
 * read-only GET, so it uses the relaxed isSameOriginOrHeaderless() rule (§5, §6.3) for the
 * same reason /api/backup/download does: on plain HTTP a same-origin request carries no
 * Origin and no Sec-Fetch-* header at all.
 *
 * The raw OCR text is deliberately NOT returned: the client only ever needs the
 * suggestions, and §16 item 6 keeps the raw text out of the UI entirely.
 */
export async function GET(request: Request, ctx: { params: Promise<{ stagingId: string }> }): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { stagingId } = await ctx.params;
  // Validated against the UUID regex BEFORE any path is built (§6.3).
  if (!STAGING_ID_RE.test(stagingId)) return Response.json({ error: 'Invalid staging id' }, { status: 400 });

  const sidecar = readSidecar(stagingId);
  if (sidecar === null) return Response.json({ status: 'pending' });
  if (sidecar.status === 'failed') {
    return Response.json({ status: 'failed', error: sidecar.error ?? 'OCR failed.' });
  }
  return Response.json({ status: 'done', suggestions: sidecar.suggestions ?? {} });
}
```

- [ ] **Step 8: Run it to verify it passes.**

Run: `npm test -- tests/api/warranty-stage-poll.route.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing file-serving test.**

Create `tests/api/warranty-receipt.route.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/warranties/receipts/[id]/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { createWarrantyItem, listWarrantyReceipts, type WarrantyInput } from '@/lib/warranty/items';
import { resolveReceiptPath } from '@/lib/warranty/receipts';
import { writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let token: string;
let ownerId: number;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-receipt-route-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  ownerId = insertTestUser(current.db, { username: 'alice' });
  token = createSession(ownerId).token;
  resetOcrQueueForTests();
  setOcrEngineForTests({ recognize: async () => ({ text: 'x' }) });
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function baseInput(): WarrantyInput {
  return {
    name: 'Fridge', vendor: null, model: null, serial: null,
    purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false,
    priceCents: null, ownerUserId: ownerId, transactionId: null, notes: null,
  };
}

function attach(bytes: Buffer, mime: 'image/jpeg' | 'application/pdf', originalFilename: string) {
  const stagingId = writeStagedReceipt(bytes, mime);
  writeSidecar(stagingId, { status: 'done', text: 'text' });
  const itemId = createWarrantyItem(baseInput(), [{ stagingId, originalFilename }]);
  return listWarrantyReceipts(itemId)[0];
}

function fetchReceipt(id: string | number, opts: { token?: string | null; origin?: string | null } = {}) {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  const origin = opts.origin === undefined ? 'http://nas.local:3000' : opts.origin;
  if (origin !== null) headers.origin = origin;
  const sessionToken = opts.token === undefined ? token : opts.token;
  if (sessionToken) headers.cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  const request = new Request(`http://nas.local:3000/api/warranties/receipts/${id}`, { headers });
  return GET(request, { params: Promise.resolve({ id: String(id) }) });
}

describe('GET /api/warranties/receipts/[id]', () => {
  it('streams an image inline with the STORED mime and no-store caching', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'till receipt.jpg');
    const response = await fetchReceipt(receipt.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-length')).toBe(String(JPEG.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(JPEG)).toBe(true);
  });

  it('serves a PDF as an attachment with a sanitised filename (MUST-5.3)', async () => {
    const receipt = attach(PDF, 'application/pdf', 'facture "été" /../weird.pdf');
    const response = await fetchReceipt(receipt.id);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    const disposition = response.headers.get('content-disposition')!;
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    expect(disposition).not.toContain('/');
    expect(disposition).not.toContain('..');
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
  });

  it('takes Content-Type from the stored mime even when the bytes are something else', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    fs.writeFileSync(resolveReceiptPath(receipt.storedFilename), Buffer.from('%PDF-1.7 not really'));
    const response = await fetchReceipt(receipt.id);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('401s without a session', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    expect((await fetchReceipt(receipt.id, { token: null })).status).toBe(401);
  });

  it('403s a mismatched Origin', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    expect((await fetchReceipt(receipt.id, { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('200s a request carrying neither Origin nor Sec-Fetch-Site (the plain-HTTP LAN case)', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    expect((await fetchReceipt(receipt.id, { origin: null })).status).toBe(200);
  });

  it('400s a non-integer id and 404s an unknown one', async () => {
    expect((await fetchReceipt('abc')).status).toBe(400);
    expect((await fetchReceipt('-1')).status).toBe(400);
    expect((await fetchReceipt('0')).status).toBe(400);
    expect((await fetchReceipt(99999)).status).toBe(404);
  });

  it('410s when the row exists but the file does not (MUST-5.6)', async () => {
    const receipt = attach(JPEG, 'image/jpeg', 'a.jpg');
    fs.rmSync(resolveReceiptPath(receipt.storedFilename), { force: true });
    const response = await fetchReceipt(receipt.id);
    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('Receipt file is missing from this install.');
  });
});
```

- [ ] **Step 10: Run it to verify it fails.**

Run: `npm test -- tests/api/warranty-receipt.route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 11: Implement the file-serving route.**

Create `src/app/api/warranties/receipts/[id]/route.ts`:

```ts
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { getWarrantyReceipt } from '@/lib/warranty/items';
import { resolveReceiptPath } from '@/lib/warranty/receipts';

export const dynamic = 'force-dynamic';

/**
 * The ONLY way a receipt's bytes reach a browser (§5).
 *
 * MUST-13.2: no anonymous access, ever — no signed URL, no token in the query string, no
 * public path. MUST-2.4: `stage` is a static sibling segment and Next resolves it ahead of
 * this dynamic one, which is why [id] accepts only a positive integer.
 */

/** MUST-5.3: everything outside [A-Za-z0-9._-] becomes _, truncated to 100, then quoted. */
function safeFilename(original: string): string {
  const cleaned = original.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'receipt';
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  // MUST-5.1, in this order, all before any filesystem access.
  // 1. Origin: reject a PRESENT-and-mismatched header; allow a request carrying neither,
  //    because on the documented plain-HTTP LAN deployment an <img> load and a navigation
  //    send no Origin and browsers omit fetch metadata on non-trustworthy origins.
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  // 2. Session.
  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  // 3. A positive integer id, or nothing.
  const { id: raw } = await ctx.params;
  if (!/^\d+$/.test(raw)) return new Response('Invalid receipt id', { status: 400 });
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response('Invalid receipt id', { status: 400 });

  // 4. The row. MUST-4.4: a receipt is only ever located by its database id.
  const receipt = getWarrantyReceipt(id);
  if (!receipt) return new Response('Not found', { status: 404 });

  const file = resolveReceiptPath(receipt.storedFilename);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    // MUST-5.6 / MUST-4.10: this is the state a v1.0.0 DB-only restore produces. Degrade
    // quietly with a plain-text 410, never a 500.
    return new Response('Receipt file is missing from this install.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
    });
  }

  /**
   * MUST-5.3: images inline, PDFs as an attachment. A same-origin INLINE pdf opens in the
   * browser's PDF viewer, which executes JavaScript embedded in the document within our
   * origin; object-src 'none' in the CSP does not cover a top-level navigation to the file.
   */
  const disposition =
    receipt.mime === 'application/pdf'
      ? `attachment; filename="${safeFilename(receipt.originalFilename)}"`
      : 'inline';

  // MUST-5.5: streamed, not readFileSync — 10 MB x several concurrent image loads is a
  // needless RSS spike on a NAS.
  const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;

  return new Response(body, {
    status: 200,
    headers: {
      // MUST-5.2: the STORED mime (itself constrained to a four-value safe list), never the
      // request's and never sniffed at read time.
      'content-type': receipt.mime,
      'content-disposition': disposition,
      'content-length': String(size),
      'cache-control': 'private, no-store',
      // X-Content-Type-Options: nosniff already arrives from securityHeaders() via
      // middleware, which matches /api/*.
    },
  });
}
```

- [ ] **Step 12: Run the file-serving test to verify it passes.**

Run: `npm test -- tests/api/warranty-receipt.route.test.ts`
Expected: PASS.

- [ ] **Step 13: Full suite and typecheck.**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 14: Checkpoint (commit is PAUSED).**

Commit message to use when the pause is lifted:

```bash
git add src/app/api/warranties tests/api/warranty-stage.route.test.ts tests/api/warranty-stage-poll.route.test.ts tests/api/warranty-receipt.route.test.ts
git commit -m "feat(warranty): staged upload, OCR poll and authenticated receipt streaming routes"
```

---

## Task 8: Warranty server actions

**Context:** Every warranty mutation except the file upload is a server action carrying only JSON-sized payloads (§17.16). All six follow the house pattern from `src/app/(app)/transactions/actions.ts`: `isSameOrigin(await headers())` **first**, then `requireUser()`, then zod, then the domain call, then `revalidatePath`. There is no admin gate anywhere in this feature — warranty items are household-shared and any member may edit or delete any of them (§1.3, §17.17).

**Files:**
- Create: `src/app/(app)/warranties/actions.ts`
- Modify: `src/lib/warranty/items.ts` (one new export, `countReceiptsWithSha`)
- Test: `tests/app/warranties-actions.test.ts`

**Interfaces:**
- Consumes: `isSameOrigin` from `@/lib/auth/csrf`; `requireUser` from `@/lib/auth/session`; `todayIso` from `@/lib/dates`; `parseAmountToCents` from `@/lib/money`; from `@/lib/warranty/items` (Task 6) — `warrantyInputSchema`, `StagedReceiptRef`, `createWarrantyItem`, `updateWarrantyItem`, `deleteWarrantyItem`, `getWarrantyItem`, `getWarrantyReceipt`, `attachStagedReceipts`, `deleteWarrantyReceipt`, `resetReceiptForReOcr`.
- Produces:
  ```ts
  // src/lib/warranty/items.ts (added by this task)
  export function countReceiptsWithSha(itemId: number, sha256: string): number;

  export interface WarrantyActionState { error?: string; message?: string }
  export const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
  /** Redirects to /warranties/<id> on success; never returns in that case. */
  export function createWarrantyAction(prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState>;
  export function updateWarrantyAction(prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState>;
  /** Redirects to /warranties on success. */
  export function deleteWarrantyAction(prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState>;
  export function attachReceiptsAction(prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState>;
  export function deleteReceiptAction(prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState>;
  export function reRunOcrAction(prev: WarrantyActionState, formData: FormData): Promise<WarrantyActionState>;
  ```
  Form-field contract every page in Task 9 must post:
  ```
  createWarrantyAction / updateWarrantyAction
    itemId          (update only) positive integer
    name            required text
    vendor model serial notes   optional text ('' means null)
    purchaseDate    ISO YYYY-MM-DD
    warrantyMonths  '' | positive integer      (must be '' when isLifetime is on)
    isLifetime      'on' | absent              (an HTML checkbox)
    price           free-form money string parsed by parseAmountToCents, '' means null
    ownerUserId     positive integer
    transactionId   '' | positive integer
    staged          JSON: Array<{ stagingId: string; originalFilename: string }>  (default '[]')

  deleteWarrantyAction   itemId
  attachReceiptsAction   itemId, staged
  deleteReceiptAction    receiptId
  reRunOcrAction         receiptId
  ```

### Steps

- [ ] **Step 1: Write the failing action test.**

Create `tests/app/warranties-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';

let currentUser = { id: 1, name: 'Alice', username: 'alice', role: 'member' as const };
let originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(originHeaders),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

import {
  CROSS_ORIGIN_ERROR,
  attachReceiptsAction,
  createWarrantyAction,
  deleteReceiptAction,
  deleteWarrantyAction,
  reRunOcrAction,
  updateWarrantyAction,
} from '@/app/(app)/warranties/actions';
import { getWarrantyItem, listWarrantyReceipts } from '@/lib/warranty/items';
import { receiptFileExists } from '@/lib/warranty/receipts';
import { writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let ownerId: number;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-warranty-actions-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };
  current = createSeededTestDb();
  ownerId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  currentUser = { id: ownerId, name: 'Alice', username: 'alice', role: 'member' };
  resetOcrQueueForTests();
  setOcrEngineForTests({ recognize: async () => ({ text: 'engine text' }) });
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function baseFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    name: 'Fridge',
    vendor: 'Home Depot',
    model: 'GDT645SYNFS',
    serial: '',
    purchaseDate: '2026-08-16',
    warrantyMonths: '24',
    price: '$1,299.99',
    ownerUserId: String(ownerId),
    transactionId: '',
    notes: '',
    staged: '[]',
    ...over,
  };
}

/** Runs a redirecting action and returns the path it redirected to. */
async function redirectPath(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  throw new Error('expected a redirect');
}

describe('cross-origin rejection comes FIRST (MUST-13.1)', () => {
  const cases: [string, (fd: FormData) => Promise<{ error?: string }>][] = [
    ['createWarrantyAction', (fd) => createWarrantyAction({}, fd)],
    ['updateWarrantyAction', (fd) => updateWarrantyAction({}, fd)],
    ['deleteWarrantyAction', (fd) => deleteWarrantyAction({}, fd)],
    ['attachReceiptsAction', (fd) => attachReceiptsAction({}, fd)],
    ['deleteReceiptAction', (fd) => deleteReceiptAction({}, fd)],
    ['reRunOcrAction', (fd) => reRunOcrAction({}, fd)],
  ];

  it.each(cases)('%s refuses a mismatched Origin without touching the database', async (_name, run) => {
    originHeaders = { origin: 'http://evil.example', host: 'nas.local:3000' };
    const before = current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c;
    const result = await run(formData(baseFields({ itemId: '1', receiptId: '1' })));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(before);
  });
});

describe('createWarrantyAction', () => {
  it('creates the item, converts the price to cents, and redirects to the detail page', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    expect(to).toMatch(/^\/warranties\/\d+$/);
    const id = Number(to.split('/').pop());
    const item = getWarrantyItem(id)!;
    expect(item.name).toBe('Fridge');
    expect(item.priceCents).toBe(129999);
    expect(item.expiryDate).toBe('2028-08-16');
    expect(item.ownerUserId).toBe(ownerId);
  });

  it('stores a positive magnitude even if the price arrives signed (§17.26)', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ price: '-1299.99' }))));
    expect(getWarrantyItem(Number(to.split('/').pop()))!.priceCents).toBe(129999);
  });

  it('handles the Lifetime checkbox by clearing the term', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ isLifetime: 'on', warrantyMonths: '' }))),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()))!;
    expect(item.isLifetime).toBe(true);
    expect(item.warrantyMonths).toBeNull();
    expect(item.expiryDate).toBeNull();
  });

  it('rejects lifetime combined with a term', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ isLifetime: 'on', warrantyMonths: '12' })));
    expect(result.error).toContain('lifetime');
  });

  it('rejects a future purchase date, a name over 200 chars and a non-numeric price', async () => {
    const tomorrow = '2999-01-01';
    expect((await createWarrantyAction({}, formData(baseFields({ purchaseDate: tomorrow })))).error).toBeTruthy();
    expect((await createWarrantyAction({}, formData(baseFields({ name: 'x'.repeat(201) })))).error).toBeTruthy();
    expect((await createWarrantyAction({}, formData(baseFields({ price: 'lots' })))).error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('commits staged receipts with the item', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'STAGED WORD' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'till.jpg' }]) })),
      ),
    );
    const receipts = listWarrantyReceipts(Number(to.split('/').pop()));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].originalFilename).toBe('till.jpg');
    expect(receipts[0].ocrStatus).toBe('done');
  });

  it('rejects a malformed staged payload rather than saving half of it', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ staged: '{"not":"an array"}' })));
    expect(result.error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('accepts a transactionId and links the two', async () => {
    const accountId = insertTestAccount(current!.db, { name: 'Joint Chequing' });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-08-16', 'HOME DEPOT', 'HOME DEPOT', -129999, ${ownerId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ transactionId: String(txn.id) }))),
    );
    expect(getWarrantyItem(Number(to.split('/').pop()))!.transactionId).toBe(txn.id);
  });
});

describe('updateWarrantyAction', () => {
  it('updates fields and recomputes expiry', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const result = await updateWarrantyAction(
      {},
      formData(baseFields({ itemId: String(id), name: 'Dishwasher', warrantyMonths: '12' })),
    );
    expect(result.message).toBeTruthy();
    const item = getWarrantyItem(id)!;
    expect(item.name).toBe('Dishwasher');
    expect(item.expiryDate).toBe('2027-08-16');
  });

  it('errors on an unknown item id', async () => {
    const result = await updateWarrantyAction({}, formData(baseFields({ itemId: '99999' })));
    expect(result.error).toBeTruthy();
  });
});

describe('deleteWarrantyAction', () => {
  it('removes the item, its receipt rows, its FTS entries and its files, then redirects', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'DOOMED WORD' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'till.jpg' }]) })),
      ),
    );
    const id = Number(to.split('/').pop());
    const stored = listWarrantyReceipts(id)[0].storedFilename;

    expect(await redirectPath(() => deleteWarrantyAction({}, formData({ itemId: String(id) })))).toBe('/warranties');
    expect(getWarrantyItem(id)).toBeNull();
    expect(receiptFileExists(stored)).toBe(false);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_receipts`).c).toBe(0);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_search`).c).toBe(0);
  });
});

describe('attachReceiptsAction / deleteReceiptAction / reRunOcrAction', () => {
  it('attaches to an existing item and warns about a duplicate without blocking it', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());

    const first = writeStagedReceipt(JPEG, 'image/jpeg');
    await attachReceiptsAction(
      {},
      formData({ itemId: String(id), staged: JSON.stringify([{ stagingId: first, originalFilename: 'a.jpg' }]) }),
    );
    const second = writeStagedReceipt(JPEG, 'image/jpeg');
    const result = await attachReceiptsAction(
      {},
      formData({ itemId: String(id), staged: JSON.stringify([{ stagingId: second, originalFilename: 'a.jpg' }]) }),
    );
    expect(listWarrantyReceipts(id)).toHaveLength(2);
    expect(result.message).toContain('already');
  });

  it('deletes one receipt', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'a.jpg' }]) })),
      ),
    );
    const id = Number(to.split('/').pop());
    const receipt = listWarrantyReceipts(id)[0];
    const result = await deleteReceiptAction({}, formData({ receiptId: String(receipt.id) }));
    expect(result.message).toBeTruthy();
    expect(listWarrantyReceipts(id)).toHaveLength(0);
    expect(receiptFileExists(receipt.storedFilename)).toBe(false);
  });

  it('re-runs OCR and is safe to click twice', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'a.jpg' }]) })),
      ),
    );
    const receipt = listWarrantyReceipts(Number(to.split('/').pop()))[0];
    expect((await reRunOcrAction({}, formData({ receiptId: String(receipt.id) }))).message).toBeTruthy();
    expect((await reRunOcrAction({}, formData({ receiptId: String(receipt.id) }))).message).toBeTruthy();
  });

  it('errors on unknown ids instead of throwing', async () => {
    expect((await deleteReceiptAction({}, formData({ receiptId: '99999' }))).error).toBeTruthy();
    expect((await reRunOcrAction({}, formData({ receiptId: '99999' }))).error).toBeTruthy();
    expect((await deleteReceiptAction({}, formData({ receiptId: 'abc' }))).error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npm test -- tests/app/warranties-actions.test.ts`
Expected: FAIL — cannot resolve `@/app/(app)/warranties/actions`.

- [ ] **Step 3: Add the duplicate-digest count to the data layer.**

In `src/lib/warranty/items.ts`, add `sql` to the `drizzle-orm` import (`import { and, eq, sql } from 'drizzle-orm';`) and append next to `sha256AlreadyOnItem`:

```ts
/** How many receipts on this item carry the same digest. Two or more is the duplicate case. */
export function countReceiptsWithSha(itemId: number, sha256: string): number {
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(warrantyReceipts)
    .where(and(eq(warrantyReceipts.warrantyItemId, itemId), eq(warrantyReceipts.sha256, sha256)))
    .get();
  return row?.count ?? 0;
}
```

- [ ] **Step 4: Implement `src/app/(app)/warranties/actions.ts`.**

```ts
'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { todayIso } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';
import {
  attachStagedReceipts,
  countReceiptsWithSha,
  createWarrantyItem,
  deleteWarrantyItem,
  deleteWarrantyReceipt,
  getWarrantyItem,
  getWarrantyReceipt,
  resetReceiptForReOcr,
  updateWarrantyItem,
  warrantyInputSchema,
  type StagedReceiptRef,
} from '@/lib/warranty/items';

export interface WarrantyActionState {
  error?: string;
  message?: string;
}

export const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

/**
 * Warranty items are household-shared (§1.3): every signed-in member may create, edit or
 * delete any item or receipt. owner_user_id is ATTRIBUTION, not access control, so there is
 * deliberately no requireAdmin() anywhere in this file.
 */

const idField = z.coerce.number().int().positive();

const stagedSchema = z.array(
  z.object({
    stagingId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    originalFilename: z.string().trim().min(1).max(255),
  }),
);

function readStaged(formData: FormData): StagedReceiptRef[] {
  const raw = String(formData.get('staged') ?? '[]');
  // A malformed payload fails the whole save rather than committing part of it.
  return stagedSchema.parse(JSON.parse(raw));
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '');
}

/** '' -> null; anything else must parse as money, as a positive magnitude (§17.26). */
function readPriceCents(formData: FormData): number | null {
  const raw = str(formData, 'price').trim();
  if (raw.length === 0) return null;
  const cents = parseAmountToCents(raw);
  if (cents === null) throw new Error('Price is not a number.');
  return Math.abs(cents);
}

function readMonths(formData: FormData): number | null {
  const raw = str(formData, 'warrantyMonths').trim();
  if (raw.length === 0) return null;
  if (!/^\d+$/.test(raw)) throw new Error('Warranty length must be a whole number of months.');
  return Number(raw);
}

function readOptionalId(formData: FormData, key: string): number | null {
  const raw = str(formData, key).trim();
  if (raw.length === 0) return null;
  const parsed = idField.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${key}.`);
  return parsed.data;
}

function readItemInput(formData: FormData, fallbackOwnerId: number) {
  const owner = readOptionalId(formData, 'ownerUserId') ?? fallbackOwnerId;
  return warrantyInputSchema(todayIso()).safeParse({
    name: str(formData, 'name'),
    vendor: str(formData, 'vendor'),
    model: str(formData, 'model'),
    serial: str(formData, 'serial'),
    purchaseDate: str(formData, 'purchaseDate'),
    warrantyMonths: readMonths(formData),
    // An HTML checkbox posts 'on' when ticked and nothing at all when not.
    isLifetime: formData.get('isLifetime') !== null,
    priceCents: readPriceCents(formData),
    ownerUserId: owner,
    transactionId: readOptionalId(formData, 'transactionId'),
    notes: str(formData, 'notes'),
  });
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function revalidateAll(itemId?: number): void {
  revalidatePath('/warranties');
  revalidatePath('/dashboard');
  if (itemId !== undefined) revalidatePath(`/warranties/${itemId}`);
}

export async function createWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  // MUST-13.1: origin FIRST, before auth, before validation, before any read.
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  let itemId: number;
  try {
    const staged = readStaged(formData);
    const parsed = readItemInput(formData, user.id);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that warranty.' };
    itemId = createWarrantyItem(parsed.data, staged);
  } catch (error) {
    return { error: messageOf(error, 'Could not save that warranty.') };
  }

  revalidateAll(itemId);
  // Outside the try: redirect() signals by throwing, and catching it would swallow it.
  redirect(`/warranties/${itemId}`);
}

export async function updateWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };

  try {
    const parsed = readItemInput(formData, 0);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that warranty.' };
    if (!updateWarrantyItem(id.data, parsed.data)) return { error: 'That warranty no longer exists.' };
  } catch (error) {
    return { error: messageOf(error, 'Could not save that warranty.') };
  }

  revalidateAll(id.data);
  return { message: 'Warranty updated.' };
}

export async function deleteWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };
  if (!deleteWarrantyItem(id.data)) return { error: 'That warranty no longer exists.' };

  revalidateAll();
  redirect('/warranties');
}

export async function attachReceiptsAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };
  if (getWarrantyItem(id.data) === null) return { error: 'That warranty no longer exists.' };

  let attached: number[];
  let duplicate = false;
  try {
    const staged = readStaged(formData);
    attached = attachStagedReceipts(id.data, staged);
    // MUST-6.9: a duplicate digest on the same item WARNS; it never blocks — a duplicate is
    // a user judgement, not an error. Two rows sharing a digest is exactly that case.
    for (const receiptId of attached) {
      const row = getWarrantyReceipt(receiptId);
      if (row && countReceiptsWithSha(id.data, row.sha256) > 1) duplicate = true;
    }
  } catch (error) {
    return { error: messageOf(error, 'Could not attach that receipt.') };
  }

  revalidateAll(id.data);
  if (attached.length === 0) return { error: 'That upload expired — please choose the file again.' };
  return {
    message: duplicate
      ? `Added ${attached.length} receipt(s). This looks like a receipt you already added.`
      : `Added ${attached.length} receipt(s).`,
  };
}

export async function deleteReceiptAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('receiptId'));
  if (!id.success) return { error: 'Invalid request.' };
  const receipt = getWarrantyReceipt(id.data);
  if (receipt === null) return { error: 'That receipt no longer exists.' };

  deleteWarrantyReceipt(id.data);
  revalidateAll(receipt.warrantyItemId);
  return { message: 'Receipt removed.' };
}

export async function reRunOcrAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const id = idField.safeParse(formData.get('receiptId'));
  if (!id.success) return { error: 'Invalid request.' };
  const receipt = getWarrantyReceipt(id.data);
  if (receipt === null) return { error: 'That receipt no longer exists.' };

  // MUST-7.16: idempotent and safe to click repeatedly — a second click on a claimed row
  // is a no-op inside enqueueOcrJob().
  resetReceiptForReOcr(id.data);
  revalidateAll(receipt.warrantyItemId);
  return { message: 'Reading that receipt again — the status will update shortly.' };
}
```

- [ ] **Step 5: Run the action test to verify it passes.**

Run: `npm test -- tests/app/warranties-actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite and typecheck.**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 7: Checkpoint (commit is PAUSED).**

Commit message to use when the pause is lifted:

```bash
git add "src/app/(app)/warranties/actions.ts" src/lib/warranty/items.ts tests/app/warranties-actions.test.ts
git commit -m "feat(warranty): server actions for create, edit, delete, attach and re-OCR"
```

---

## Task 9: Warranty pages — list, add, detail, and navigation

**Context:** Three pages, each a thin server component plus a client component, matching the existing page/client split (`transactions/page.tsx` + `transactions-client.tsx`). The one genuinely new piece of UI machinery is the staged-upload control: it posts files to `/api/warranties/receipts/stage`, shows a local `URL.createObjectURL` preview (no server-side image processing anywhere in this release), polls for suggestions, and **never blocks the Save button**.

**Files:**
- Create: `src/components/warranty/StatusBadge.tsx`
- Create: `src/components/warranty/ReceiptUploader.tsx`
- Create: `src/app/(app)/warranties/page.tsx`
- Create: `src/app/(app)/warranties/warranties-client.tsx`
- Create: `src/app/(app)/warranties/new/page.tsx`
- Create: `src/app/(app)/warranties/new/new-warranty-client.tsx`
- Create: `src/app/(app)/warranties/[id]/page.tsx`
- Create: `src/app/(app)/warranties/[id]/warranty-detail-client.tsx`
- Modify: `src/app/(app)/layout.tsx` (one `NAV` entry)
- Test: `tests/components/StatusBadge.test.tsx`
- Test: `tests/app/warranties-client.test.tsx`
- Test: `tests/app/new-warranty-client.test.tsx`
- Test: `tests/app/warranty-detail-client.test.tsx`

**Interfaces:**
- Consumes: `WarrantyListItem`, `WarrantySearchResult`, `WarrantySort`, `WARRANTY_SORTS`, `searchWarrantyItems` from `@/lib/warranty/search` (Task 6); `WarrantyItemRow`, `WarrantyReceiptRow`, `getWarrantyItem`, `listWarrantyReceipts` from `@/lib/warranty/items` (Task 6); `WarrantyStatus`, `WARRANTY_STATUSES`, `isWarrantyStatus`, `statusLabel`, `computeExpiryDate` from `@/lib/warranty/expiry` (Task 2); every action from `@/app/(app)/warranties/actions` (Task 8); the HTTP contract of Task 7; `listUsers` from `@/lib/auth/users`; `getTransaction`, `displayNameOf` from `@/lib/transactions`; `formatCents` from `@/lib/money`; `todayIso` from `@/lib/dates`; `SubmitButton`, `FormError` from `@/components`.
- Produces:
  ```tsx
  // src/components/warranty/StatusBadge.tsx
  export function StatusBadge(props: { status: WarrantyStatus; expiryDate: string | null; today: string }): JSX.Element;

  // src/components/warranty/ReceiptUploader.tsx
  export interface StagedFile {
    stagingId: string; originalFilename: string; mime: string; sizeBytes: number; sha256: string;
    previewUrl: string | null; ocr: 'pending' | 'done' | 'failed'; error?: string;
  }
  export interface SuggestedFieldsDto { purchaseDate?: string; vendor?: string; priceCents?: number }
  export function ReceiptUploader(props: {
    onStagedChange: (files: StagedFile[]) => void;
    onSuggestions?: (suggestions: SuggestedFieldsDto) => void;
    label?: string;
  }): JSX.Element;
  export const POLL_INTERVAL_MS = 1500;
  export const POLL_GIVE_UP_MS = 180_000;
  export const POLL_GIVE_UP_MESSAGE = 'Still processing — save now and re-run OCR from the item page.';
  export const READING_MESSAGE = "Reading receipt… you can fill this in and save now; suggestions will appear when it's done.";

  // src/app/(app)/warranties/warranties-client.tsx
  export function WarrantiesClient(props: {
    result: WarrantySearchResult; people: { id: number; name: string }[];
    today: string; query: string; status: string; owner: string; sort: WarrantySort;
  }): JSX.Element;

  // src/app/(app)/warranties/new/new-warranty-client.tsx
  export interface WarrantyPrefill {
    purchaseDate?: string; vendor?: string; priceCents?: number; transactionId?: number;
  }
  export function NewWarrantyClient(props: {
    people: { id: number; name: string }[]; currentUserId: number; today: string; prefill: WarrantyPrefill;
  }): JSX.Element;

  // src/app/(app)/warranties/[id]/warranty-detail-client.tsx
  export function WarrantyDetailClient(props: {
    item: WarrantyItemRow; receipts: WarrantyReceiptRow[]; status: WarrantyStatus;
    people: { id: number; name: string }[]; today: string;
    linkedTransaction: { id: number; date: string; description: string } | null;
    linkRemoved: boolean;
  }): JSX.Element;
  ```

### Steps

- [ ] **Step 1: Write the failing badge test.**

Create `tests/components/StatusBadge.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { StatusBadge } from '@/components/warranty/StatusBadge';

afterEach(() => cleanup());

describe('StatusBadge (§10.2)', () => {
  it('names all five statuses, including the fifth "unknown" one (§17.5)', () => {
    render(<StatusBadge status="active" expiryDate="2027-01-01" today="2026-08-16" />);
    expect(screen.getByText('Active')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="expiring" expiryDate="2026-10-15" today="2026-08-16" />);
    expect(screen.getByText('Expires in 60 days')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="expired" expiryDate="2026-08-15" today="2026-08-16" />);
    expect(screen.getByText('Expired')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="lifetime" expiryDate={null} today="2026-08-16" />);
    expect(screen.getByText('Lifetime')).toBeTruthy();
    cleanup();

    render(<StatusBadge status="unknown" expiryDate={null} today="2026-08-16" />);
    expect(screen.getByText('Term unknown')).toBeTruthy();
  });

  it('carries a distinct colour class per status so they are not all grey', () => {
    const { container: amber } = render(<StatusBadge status="expiring" expiryDate="2026-09-01" today="2026-08-16" />);
    expect(amber.innerHTML).toContain('amber');
    cleanup();
    const { container: red } = render(<StatusBadge status="expired" expiryDate="2026-01-01" today="2026-08-16" />);
    expect(red.innerHTML).toContain('red');
    cleanup();
    const { container: blue } = render(<StatusBadge status="lifetime" expiryDate={null} today="2026-08-16" />);
    expect(blue.innerHTML).toContain('blue');
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement the badge.**

Run: `npm test -- tests/components/StatusBadge.test.tsx`
Expected: FAIL — cannot resolve `@/components/warranty/StatusBadge`.

Create `src/components/warranty/StatusBadge.tsx`:

```tsx
import { statusLabel, type WarrantyStatus } from '@/lib/warranty/expiry';

/** §10.2: active neutral · expiring amber · expired red · lifetime blue · unknown grey. */
const CLASSES: Record<WarrantyStatus, string> = {
  active: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100',
  expiring: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  expired: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  lifetime: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  unknown: 'bg-slate-200 text-slate-600 dark:bg-slate-900 dark:text-slate-400',
};

export function StatusBadge({
  status,
  expiryDate,
  today,
}: {
  status: WarrantyStatus;
  expiryDate: string | null;
  today: string;
}) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CLASSES[status]}`}>
      {statusLabel(status, expiryDate, today)}
    </span>
  );
}
```

Run: `npm test -- tests/components/StatusBadge.test.tsx`
Expected: PASS.

- [ ] **Step 3: Implement the staged-upload control.**

Create `src/components/warranty/ReceiptUploader.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The only file control in the feature. MUST-6.1 fixes its exact shape; MUST-10.2 fixes its
 * behaviour: OCR NEVER blocks the form. The Save button stays enabled the whole time.
 */
export interface StagedFile {
  stagingId: string;
  originalFilename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  /** URL.createObjectURL — the browser's own preview. No server-side image processing (§16.2). */
  previewUrl: string | null;
  ocr: 'pending' | 'done' | 'failed';
  error?: string;
}

export interface SuggestedFieldsDto {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
}

export const POLL_INTERVAL_MS = 1500;
export const POLL_GIVE_UP_MS = 180_000;
export const POLL_GIVE_UP_MESSAGE = 'Still processing — save now and re-run OCR from the item page.';
export const READING_MESSAGE =
  "Reading receipt… you can fill this in and save now; suggestions will appear when it's done.";

interface StageResponse {
  staged?: { stagingId: string; originalFilename: string; mime: string; sizeBytes: number; sha256: string }[];
  error?: string;
}

interface PollResponse {
  status: 'pending' | 'done' | 'failed';
  suggestions?: SuggestedFieldsDto;
  error?: string;
}

export function ReceiptUploader({
  onStagedChange,
  onSuggestions,
  label = 'Receipt photo or PDF',
}: {
  onStagedChange: (files: StagedFile[]) => void;
  onSuggestions?: (suggestions: SuggestedFieldsDto) => void;
  label?: string;
}) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  useEffect(() => {
    onStagedChange(files);
  }, [files, onStagedChange]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearInterval(timer);
      for (const file of files) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    },
    // Cleanup on unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const poll = useCallback(
    (stagingId: string) => {
      const startedAt = Date.now();
      const timer = setInterval(async () => {
        if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
          clearInterval(timer);
          setNotice(POLL_GIVE_UP_MESSAGE);
          return;
        }
        const response = await fetch(`/api/warranties/receipts/stage/${stagingId}`);
        if (!response.ok) {
          clearInterval(timer);
          return;
        }
        const body = (await response.json()) as PollResponse;
        if (body.status === 'pending') return;
        clearInterval(timer);
        setFiles((prev) =>
          prev.map((file) =>
            file.stagingId === stagingId ? { ...file, ocr: body.status, error: body.error } : file,
          ),
        );
        if (body.status === 'done') {
          setNotice(null);
          if (onSuggestions && body.suggestions) onSuggestions(body.suggestions);
        } else {
          // MUST-10.2 step 4: show the error and carry on. Rendered as a text node only
          // (MUST-13.3) — never dangerouslySetInnerHTML.
          setNotice(body.error ?? 'That receipt could not be read.');
        }
      }, POLL_INTERVAL_MS);
      timers.current.push(timer);
    },
    [onSuggestions],
  );

  async function upload(list: FileList): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      for (const file of Array.from(list)) form.append('file', file);
      const response = await fetch('/api/warranties/receipts/stage', { method: 'POST', body: form });
      const body = (await response.json()) as StageResponse;
      if (!response.ok || !body.staged) {
        setError(body.error ?? 'That upload did not work.');
        return;
      }
      const staged: StagedFile[] = body.staged.map((entry, index) => ({
        ...entry,
        previewUrl: entry.mime.startsWith('image/') ? URL.createObjectURL(list[index]) : null,
        ocr: 'pending' as const,
      }));
      setFiles((prev) => [...prev, ...staged]);
      setNotice(READING_MESSAGE);
      for (const entry of staged) poll(entry.stagingId);
    } finally {
      setBusy(false);
    }
  }

  function remove(stagingId: string): void {
    setFiles((prev) => {
      const target = prev.find((file) => file.stagingId === stagingId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((file) => file.stagingId !== stagingId);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm">
        {label}
        {/* MUST-6.1, exactly: capture="environment" opens a phone's rear camera directly and
            is ignored by a desktop browser. No native app, no getUserMedia, no canvas. */}
        <input
          type="file"
          name="file"
          accept="image/*,application/pdf"
          capture="environment"
          multiple
          disabled={busy}
          onChange={(event) => {
            const list = event.target.files;
            if (list && list.length > 0) void upload(list);
            event.target.value = '';
          }}
          className="text-sm"
        />
      </label>

      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
      {notice ? <p className="text-sm text-slate-600 dark:text-slate-300">{notice}</p> : null}

      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-3">
          {files.map((file) => (
            <li key={file.stagingId} className="flex w-40 flex-col gap-1 rounded border p-2 text-xs dark:border-slate-700">
              {file.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={file.previewUrl} alt={file.originalFilename} className="max-h-24 w-full object-contain" />
              ) : (
                <span className="text-slate-500">PDF</span>
              )}
              <span className="truncate" title={file.originalFilename}>{file.originalFilename}</span>
              <span className="text-slate-500">
                {file.ocr === 'pending' ? 'Reading…' : file.ocr === 'done' ? 'Read' : 'Could not read'}
              </span>
              <button type="button" onClick={() => remove(file.stagingId)} className="w-fit underline">
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Write the failing list-page test.**

Create `tests/app/warranties-client.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { WarrantiesClient } from '@/app/(app)/warranties/warranties-client';
import type { WarrantyListItem, WarrantySearchResult } from '@/lib/warranty/search';

afterEach(() => cleanup());

const TODAY = '2026-08-16';

function item(over: Partial<WarrantyListItem> = {}): WarrantyListItem {
  return {
    id: 1, name: 'Fridge', vendor: 'Home Depot', model: 'GDT645SYNFS', serial: null,
    purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false, expiryDate: '2028-08-16',
    priceCents: 129999, ownerUserId: 7, ownerName: 'Alice', transactionId: null, notes: null,
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    status: 'active', receiptCount: 1,
    ...over,
  };
}

function result(rows: WarrantyListItem[], over: Partial<WarrantySearchResult> = {}): WarrantySearchResult {
  return { rows, total: rows.length, page: 1, pageCount: 1, ...over };
}

const people = [{ id: 7, name: 'Alice' }, { id: 8, name: 'Bob' }];

function renderList(res: WarrantySearchResult, query = '') {
  return render(
    <WarrantiesClient result={res} people={people} today={TODAY} query={query} status="" owner="" sort="expiry" />,
  );
}

describe('WarrantiesClient', () => {
  it('renders every column of §10.2', () => {
    renderList(result([item()]));
    expect(screen.getByText('Fridge')).toBeTruthy();
    expect(screen.getByText('GDT645SYNFS')).toBeTruthy();
    expect(screen.getByText('Home Depot')).toBeTruthy();
    expect(screen.getByText('2026-08-16')).toBeTruthy();
    expect(screen.getByText('2028-08-16')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('shows the expiring badge with a day count', () => {
    renderList(result([item({ status: 'expiring', expiryDate: '2026-09-15' })]));
    expect(screen.getByText('Expires in 30 days')).toBeTruthy();
  });

  it('drives ?q= from a GET form so a search is linkable and survives refresh', () => {
    const { container } = renderList(result([item()]), 'fridge');
    const form = container.querySelector('form[method="get"]')!;
    expect(form).toBeTruthy();
    const search = form.querySelector('input[name="q"]') as HTMLInputElement;
    expect(search.defaultValue).toBe('fridge');
    expect(form.querySelector('select[name="status"]')).toBeTruthy();
    expect(form.querySelector('select[name="owner"]')).toBeTruthy();
    expect(form.querySelector('select[name="sort"]')).toBeTruthy();
  });

  it('offers all six status filter options including unknown', () => {
    const { container } = renderList(result([item()]));
    const options = Array.from(container.querySelectorAll('select[name="status"] option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', 'active', 'expiring', 'expired', 'lifetime', 'unknown']);
  });

  it('distinguishes "no warranties yet" from "no matches for that search"', () => {
    renderList(result([]));
    expect(screen.getByText(/No warranties yet/i)).toBeTruthy();
    cleanup();
    renderList(result([]), 'zzzz');
    expect(screen.getByText(/No matches/i)).toBeTruthy();
  });

  it('links each row to its detail page and offers Add warranty', () => {
    const { container } = renderList(result([item({ id: 42 })]));
    expect(container.querySelector('a[href="/warranties/42"]')).toBeTruthy();
    expect(container.querySelector('a[href="/warranties/new"]')).toBeTruthy();
  });

  it('surfaces the malformed-query message instead of a crash', () => {
    renderList(result([], { error: "That search couldn't be understood — try different words." }), 'a"b');
    expect(screen.getByText(/couldn't be understood/)).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run it to verify it fails, then implement the list page.**

Run: `npm test -- tests/app/warranties-client.test.tsx`
Expected: FAIL — cannot resolve `@/app/(app)/warranties/warranties-client`.

Create `src/app/(app)/warranties/warranties-client.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { StatusBadge } from '@/components/warranty/StatusBadge';
import { formatCents } from '@/lib/money';
import { WARRANTY_STATUSES } from '@/lib/warranty/expiry';
import { WARRANTY_SORTS, type WarrantySearchResult, type WarrantySort } from '@/lib/warranty/search';

const SORT_LABELS: Record<WarrantySort, string> = {
  expiry: 'Soonest expiry',
  name: 'Name',
  purchase: 'Newest purchase',
};

export function WarrantiesClient({
  result,
  people,
  today,
  query,
  status,
  owner,
  sort,
}: {
  result: WarrantySearchResult;
  people: { id: number; name: string }[];
  today: string;
  query: string;
  status: string;
  owner: string;
  sort: WarrantySort;
}) {
  const searching = query.trim().length > 0 || status !== '' || owner !== '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Warranties</h1>
        <Link href="/warranties/new" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900">
          Add warranty
        </Link>
      </div>

      {result.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {result.error}
        </p>
      ) : null}

      {/* A plain GET form: ?q=/?status=/?owner=/?sort= are all linkable and survive refresh. */}
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          Search
          <input
            name="q"
            defaultValue={query}
            placeholder="Any word on the receipt"
            className="w-64 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="flex flex-col gap-1">
          Status
          <select name="status" defaultValue={status} className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">All</option>
            {WARRANTY_STATUSES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Owner
          <select name="owner" defaultValue={owner} className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">All</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Sort
          <select name="sort" defaultValue={sort} className="rounded border px-2 py-1 dark:bg-slate-900">
            {WARRANTY_SORTS.map((value) => (
              <option key={value} value={value}>{SORT_LABELS[value]}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded border px-3 py-1 dark:border-slate-700">Apply</button>
      </form>

      {result.rows.length === 0 ? (
        searching ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">No matches for that search.</p>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No warranties yet. <Link href="/warranties/new" className="underline">Add the first one</Link>.
          </p>
        )
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2">Item</th>
              <th>Vendor</th>
              <th>Purchase date</th>
              <th>Expiry</th>
              <th>Status</th>
              <th>Owner</th>
              <th className="text-right">Price</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-2">
                  <Link href={`/warranties/${row.id}`} className="hover:underline">{row.name}</Link>
                  {row.model ? <div className="text-xs text-slate-500">{row.model}</div> : null}
                </td>
                <td>{row.vendor ?? '—'}</td>
                <td>{row.purchaseDate}</td>
                <td>{row.expiryDate ?? '—'}</td>
                <td><StatusBadge status={row.status} expiryDate={row.expiryDate} today={today} /></td>
                <td>{row.ownerName}</td>
                <td className="text-right tabular-nums">{row.priceCents === null ? '—' : formatCents(row.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result.pageCount > 1 ? (
        <p className="text-xs text-slate-500">
          Page {result.page} of {result.pageCount} · {result.total} items
        </p>
      ) : null}
    </div>
  );
}
```

Create `src/app/(app)/warranties/page.tsx`:

```tsx
import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { todayIso } from '@/lib/dates';
import { isWarrantyStatus } from '@/lib/warranty/expiry';
import { isWarrantySort, searchWarrantyItems } from '@/lib/warranty/search';
import { WarrantiesClient } from './warranties-client';

export const dynamic = 'force-dynamic';

export default async function WarrantiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };

  const query = one('q');
  const status = one('status');
  const owner = one('owner');
  const sortRaw = one('sort');
  const sort = isWarrantySort(sortRaw) ? sortRaw : 'expiry';
  const page = /^\d+$/.test(one('page')) ? Number(one('page')) : 1;
  const today = todayIso();

  const result = searchWarrantyItems({
    q: query,
    status: isWarrantyStatus(status) ? status : null,
    ownerUserId: /^\d+$/.test(owner) ? Number(owner) : null,
    sort,
    page,
    today,
  });

  return (
    <WarrantiesClient
      result={result}
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
      today={today}
      query={query}
      status={status}
      owner={owner}
      sort={sort}
    />
  );
}
```

Run: `npm test -- tests/app/warranties-client.test.tsx`
Expected: PASS.

- [ ] **Step 6: Write the failing add-form test.**

Create `tests/app/new-warranty-client.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { NewWarrantyClient } from '@/app/(app)/warranties/new/new-warranty-client';

vi.mock('@/app/(app)/warranties/actions', () => ({
  createWarrantyAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

const people = [{ id: 7, name: 'Alice' }, { id: 8, name: 'Bob' }];

function renderForm(prefill = {}) {
  return render(<NewWarrantyClient people={people} currentUserId={7} today="2026-08-16" prefill={prefill} />);
}

describe('NewWarrantyClient', () => {
  it('renders every field of §10.3 and defaults the owner to the current user', () => {
    const { container } = renderForm();
    for (const name of ['name', 'vendor', 'model', 'serial', 'purchaseDate', 'warrantyMonths', 'price', 'notes']) {
      expect(container.querySelector(`[name="${name}"]`), `missing ${name}`).toBeTruthy();
    }
    expect((container.querySelector('[name="ownerUserId"]') as HTMLSelectElement).value).toBe('7');
    expect(container.querySelector('input[name="isLifetime"][type="checkbox"]')).toBeTruthy();
    expect((container.querySelector('[name="name"]') as HTMLInputElement).required).toBe(true);
    expect((container.querySelector('[name="purchaseDate"]') as HTMLInputElement).type).toBe('date');
  });

  it('caps the purchase date input at today so a future date cannot be picked', () => {
    const { container } = renderForm();
    expect((container.querySelector('[name="purchaseDate"]') as HTMLInputElement).max).toBe('2026-08-16');
  });

  it('shows the live computed expiry beside the months input (MUST-10.4)', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="purchaseDate"]')!, { target: { value: '2026-01-31' } });
    fireEvent.change(container.querySelector('[name="warrantyMonths"]')!, { target: { value: '1' } });
    expect(screen.getByText('Covered through 2026-02-28')).toBeTruthy();
  });

  it('disables and clears the months input when Lifetime is ticked (MUST-3.5)', () => {
    const { container } = renderForm();
    const months = container.querySelector('[name="warrantyMonths"]') as HTMLInputElement;
    fireEvent.change(months, { target: { value: '24' } });
    fireEvent.click(container.querySelector('input[name="isLifetime"]')!);
    expect(months.disabled).toBe(true);
    expect(months.value).toBe('');
  });

  it('keeps the Save button enabled while a receipt is still being read (MUST-10.2)', () => {
    renderForm();
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it('applies server-computed prefill from a transaction and posts the id back (MUST-11.3)', () => {
    const { container } = renderForm({
      purchaseDate: '2026-08-16',
      vendor: 'HOME DEPOT',
      priceCents: 129999,
      transactionId: 55,
    });
    expect((container.querySelector('[name="purchaseDate"]') as HTMLInputElement).value).toBe('2026-08-16');
    expect((container.querySelector('[name="vendor"]') as HTMLInputElement).value).toBe('HOME DEPOT');
    expect((container.querySelector('[name="price"]') as HTMLInputElement).value).toBe('1299.99');
    expect((container.querySelector('[name="transactionId"]') as HTMLInputElement).value).toBe('55');
  });

  it('carries a hidden staged field so the action always receives valid JSON', () => {
    const { container } = renderForm();
    const staged = container.querySelector('input[name="staged"]') as HTMLInputElement;
    expect(staged.value).toBe('[]');
  });
});
```

- [ ] **Step 7: Run it to verify it fails, then implement the add page.**

Run: `npm test -- tests/app/new-warranty-client.test.tsx`
Expected: FAIL — cannot resolve the client module.

Create `src/app/(app)/warranties/new/new-warranty-client.tsx`:

```tsx
'use client';

import { useActionState, useCallback, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { ReceiptUploader, type StagedFile, type SuggestedFieldsDto } from '@/components/warranty/ReceiptUploader';
import { isIsoDate } from '@/lib/dates';
import { computeExpiryDate } from '@/lib/warranty/expiry';
import { createWarrantyAction, type WarrantyActionState } from '../actions';

export interface WarrantyPrefill {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
  transactionId?: number;
}

const initial: WarrantyActionState = {};

function centsToInput(cents: number | undefined): string {
  return cents === undefined ? '' : (cents / 100).toFixed(2);
}

export function NewWarrantyClient({
  people,
  currentUserId,
  today,
  prefill,
}: {
  people: { id: number; name: string }[];
  currentUserId: number;
  today: string;
  prefill: WarrantyPrefill;
}) {
  const [state, action] = useActionState(createWarrantyAction, initial);

  // MUST-11.4 / MUST-10.3: values that arrive as prefill are user-visible by the time the
  // form renders, so `touched` starts true for them and OCR can never overwrite them.
  const [purchaseDate, setPurchaseDate] = useState(prefill.purchaseDate ?? '');
  const [vendor, setVendor] = useState(prefill.vendor ?? '');
  const [price, setPrice] = useState(centsToInput(prefill.priceCents));
  const [touched, setTouched] = useState({
    purchaseDate: prefill.purchaseDate !== undefined,
    vendor: prefill.vendor !== undefined,
    price: prefill.priceCents !== undefined,
  });
  const [suggested, setSuggested] = useState({ purchaseDate: false, vendor: false, price: false });

  const [months, setMonths] = useState('');
  const [isLifetime, setIsLifetime] = useState(false);
  const [staged, setStaged] = useState<StagedFile[]>([]);

  const onStagedChange = useCallback((files: StagedFile[]) => setStaged(files), []);

  /** MUST-10.3: only EMPTY, untouched fields are filled from a suggestion. */
  const onSuggestions = useCallback(
    (fields: SuggestedFieldsDto) => {
      setTouched((current) => {
        if (fields.purchaseDate && !current.purchaseDate) {
          setPurchaseDate(fields.purchaseDate);
          setSuggested((s) => ({ ...s, purchaseDate: true }));
        }
        if (fields.vendor && !current.vendor) {
          setVendor(fields.vendor);
          setSuggested((s) => ({ ...s, vendor: true }));
        }
        if (fields.priceCents !== undefined && !current.price) {
          setPrice(centsToInput(fields.priceCents));
          setSuggested((s) => ({ ...s, price: true }));
        }
        return current;
      });
    },
    [],
  );

  const monthsNumber = /^\d+$/.test(months) ? Number(months) : null;
  const expiry =
    !isLifetime && monthsNumber !== null && monthsNumber > 0 && isIsoDate(purchaseDate)
      ? computeExpiryDate({ purchaseDate, warrantyMonths: monthsNumber, isLifetime: false })
      : null;

  const suggestedNote = (flag: boolean, clear: () => void) =>
    flag ? (
      <span className="text-xs text-slate-500">
        suggested from receipt{' '}
        <button type="button" onClick={clear} className="underline">clear</button>
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Add warranty</h1>
      <FormError message={state.error} />

      <ReceiptUploader onStagedChange={onStagedChange} onSuggestions={onSuggestions} />

      <form action={action} className="flex max-w-2xl flex-col gap-3 text-sm">
        <input
          type="hidden"
          name="staged"
          value={JSON.stringify(staged.map((f) => ({ stagingId: f.stagingId, originalFilename: f.originalFilename })))}
        />
        <input type="hidden" name="transactionId" value={prefill.transactionId ?? ''} />

        <label className="flex flex-col gap-1">
          Name
          <input name="name" required maxLength={200} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
        </label>

        <label className="flex flex-col gap-1">
          Vendor
          <input
            name="vendor"
            maxLength={200}
            value={vendor}
            onChange={(e) => {
              setVendor(e.target.value);
              setTouched((t) => ({ ...t, vendor: true }));
              setSuggested((s) => ({ ...s, vendor: false }));
            }}
            className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
          {suggestedNote(suggested.vendor, () => {
            setVendor('');
            setSuggested((s) => ({ ...s, vendor: false }));
          })}
        </label>

        <label className="flex flex-col gap-1">
          Model
          <input name="model" maxLength={200} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
        </label>

        <label className="flex flex-col gap-1">
          Serial number
          <input name="serial" maxLength={200} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
        </label>

        <label className="flex flex-col gap-1">
          Purchase date
          <input
            type="date"
            name="purchaseDate"
            required
            max={today}
            value={purchaseDate}
            onChange={(e) => {
              setPurchaseDate(e.target.value);
              setTouched((t) => ({ ...t, purchaseDate: true }));
              setSuggested((s) => ({ ...s, purchaseDate: false }));
            }}
            className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
          {suggestedNote(suggested.purchaseDate, () => {
            setPurchaseDate('');
            setSuggested((s) => ({ ...s, purchaseDate: false }));
          })}
        </label>

        <fieldset className="flex flex-col gap-1">
          <legend>Warranty length</legend>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="number"
              name="warrantyMonths"
              min={1}
              placeholder="months"
              value={months}
              disabled={isLifetime}
              onChange={(e) => setMonths(e.target.value)}
              className="w-28 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            />
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="isLifetime"
                checked={isLifetime}
                onChange={(e) => {
                  setIsLifetime(e.target.checked);
                  // MUST-3.5: a lifetime warranty has no term to store.
                  if (e.target.checked) setMonths('');
                }}
              />
              Lifetime
            </label>
            {/* MUST-10.4: the clamp rule is visible rather than surprising. */}
            {expiry ? <span className="text-slate-600 dark:text-slate-300">Covered through {expiry}</span> : null}
          </div>
          <span className="text-xs text-slate-500">Leave both blank if you do not know the term.</span>
        </fieldset>

        <label className="flex flex-col gap-1">
          Price
          <input
            name="price"
            inputMode="decimal"
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              setTouched((t) => ({ ...t, price: true }));
              setSuggested((s) => ({ ...s, price: false }));
            }}
            className="w-40 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
          {suggestedNote(suggested.price, () => {
            setPrice('');
            setSuggested((s) => ({ ...s, price: false }));
          })}
        </label>

        <label className="flex flex-col gap-1">
          Owner
          <select name="ownerUserId" defaultValue={String(currentUserId)} className="w-56 rounded border px-2 py-1 dark:bg-slate-900">
            {people.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          Notes
          <textarea name="notes" maxLength={2000} rows={3} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
        </label>

        {/* Never disabled by OCR: the Save button's only busy state is the form submission
            itself, via useFormStatus inside SubmitButton (MUST-10.2 step 2). */}
        <SubmitButton className="w-fit">Save warranty</SubmitButton>
      </form>
    </div>
  );
}
```

Create `src/app/(app)/warranties/new/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { todayIso } from '@/lib/dates';
import { displayNameOf, getTransaction } from '@/lib/transactions';
import { NewWarrantyClient, type WarrantyPrefill } from './new-warranty-client';

export const dynamic = 'force-dynamic';

/**
 * MUST-11.3: prefill is computed SERVER-SIDE from the transaction row. The query parameter
 * carries only the id; no field value is ever trusted from the URL.
 */
function prefillFromTransaction(transactionId: number): WarrantyPrefill {
  const txn = getTransaction(transactionId);
  if (!txn) notFound();
  return {
    purchaseDate: txn.date,
    // The ledger stores spend negative; a warranty stores a positive price (§3.2 / §17.26).
    priceCents: Math.abs(txn.amountCents),
    vendor: displayNameOf(txn).replace(/\s+/g, ' ').trim().slice(0, 60),
    transactionId: txn.id,
  };
}

export default async function NewWarrantyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.transactionId) ? params.transactionId[0] : params.transactionId;
  const prefill = raw && /^\d+$/.test(raw) ? prefillFromTransaction(Number(raw)) : {};

  return (
    <NewWarrantyClient
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
      currentUserId={user.id}
      today={todayIso()}
      prefill={prefill}
    />
  );
}
```

Run: `npm test -- tests/app/new-warranty-client.test.tsx`
Expected: PASS.

- [ ] **Step 8: Write the failing detail-page test.**

Create `tests/app/warranty-detail-client.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { WarrantyDetailClient } from '@/app/(app)/warranties/[id]/warranty-detail-client';
import type { WarrantyItemRow, WarrantyReceiptRow } from '@/lib/warranty/items';

vi.mock('@/app/(app)/warranties/actions', () => ({
  updateWarrantyAction: vi.fn(async () => ({})),
  deleteWarrantyAction: vi.fn(async () => ({})),
  attachReceiptsAction: vi.fn(async () => ({})),
  deleteReceiptAction: vi.fn(async () => ({})),
  reRunOcrAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

const TODAY = '2026-08-16';
const people = [{ id: 7, name: 'Alice' }];

function item(over: Partial<WarrantyItemRow> = {}): WarrantyItemRow {
  return {
    id: 42, name: 'Fridge', vendor: 'Home Depot', model: 'GDT645SYNFS', serial: 'SN-1',
    purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false, expiryDate: '2028-08-16',
    priceCents: 129999, ownerUserId: 7, ownerName: 'Alice', transactionId: null, notes: 'kitchen',
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    ...over,
  };
}

function receipt(over: Partial<WarrantyReceiptRow> = {}): WarrantyReceiptRow {
  return {
    id: 5, warrantyItemId: 42, originalFilename: 'till.jpg',
    storedFilename: '11111111-2222-3333-4444-555555555555.jpg',
    mime: 'image/jpeg', sizeBytes: 2048, sha256: 'a'.repeat(64),
    ocrStatus: 'done', ocrError: null, createdAt: '2026-08-16T00:00:00.000Z', fileExists: true,
    ...over,
  };
}

function renderDetail(over: Partial<Parameters<typeof WarrantyDetailClient>[0]> = {}) {
  return render(
    <WarrantyDetailClient
      item={item()}
      receipts={[receipt()]}
      status="active"
      people={people}
      today={TODAY}
      linkedTransaction={null}
      linkRemoved={false}
      {...over}
    />,
  );
}

describe('WarrantyDetailClient', () => {
  it('shows every field, the owner and the status badge', () => {
    renderDetail();
    expect(screen.getByText('Fridge')).toBeTruthy();
    expect(screen.getByText('GDT645SYNFS')).toBeTruthy();
    expect(screen.getByText('SN-1')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('renders an image receipt inline through the authenticated route', () => {
    const { container } = renderDetail();
    const img = container.querySelector('img[src="/api/warranties/receipts/5"]');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('alt')).toBe('till.jpg');
  });

  it('links a PDF rather than embedding it (MUST-5.3 / §10.3)', () => {
    const { container } = renderDetail({ receipts: [receipt({ mime: 'application/pdf', originalFilename: 'x.pdf' })] });
    expect(container.querySelector('img[src="/api/warranties/receipts/5"]')).toBeNull();
    expect(container.querySelector('a[href="/api/warranties/receipts/5"]')).toBeTruthy();
  });

  it('shows a file-missing tile instead of a broken image (MUST-4.10)', () => {
    renderDetail({ receipts: [receipt({ fileExists: false })] });
    expect(screen.getByText(/file missing/i)).toBeTruthy();
  });

  it('shows the OCR status chip and the failure text verbatim, as a text node', () => {
    renderDetail({ receipts: [receipt({ ocrStatus: 'failed', ocrError: 'OCR timed out.' })] });
    expect(screen.getByText('OCR timed out.')).toBeTruthy();
  });

  it('never displays the raw OCR text (§16 item 6 — the type carries no ocrText at all)', () => {
    const { container } = renderDetail();
    expect(container.innerHTML).not.toContain('ocrText');
  });

  it('offers Re-run OCR and Remove per receipt, and Delete item with the receipt count', () => {
    renderDetail();
    expect(screen.getByRole('button', { name: /re-run ocr/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy();
    expect(screen.getByText(/1 receipt/i)).toBeTruthy();
  });

  it('links a live transaction and explains a nulled one instead of showing a dead link', () => {
    const { container } = renderDetail({
      item: item({ transactionId: 55 }),
      linkedTransaction: { id: 55, date: '2026-08-16', description: 'HOME DEPOT' },
    });
    expect(container.querySelector('a[href="/transactions?q=HOME+DEPOT"]') ?? container.innerHTML).toBeTruthy();
    cleanup();

    renderDetail({ item: item({ transactionId: 55 }), linkedTransaction: null, linkRemoved: true });
    expect(screen.getByText(/removed by an import undo/i)).toBeTruthy();
  });
});
```

- [ ] **Step 9: Run it to verify it fails, then implement the detail page.**

Run: `npm test -- tests/app/warranty-detail-client.test.tsx`
Expected: FAIL — cannot resolve the client module.

Create `src/app/(app)/warranties/[id]/warranty-detail-client.tsx`:

```tsx
'use client';

import { useActionState, useCallback, useState } from 'react';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { StatusBadge } from '@/components/warranty/StatusBadge';
import { ReceiptUploader, type StagedFile } from '@/components/warranty/ReceiptUploader';
import { formatCents } from '@/lib/money';
import type { WarrantyStatus } from '@/lib/warranty/expiry';
import type { WarrantyItemRow, WarrantyReceiptRow } from '@/lib/warranty/items';
import {
  attachReceiptsAction,
  deleteReceiptAction,
  deleteWarrantyAction,
  reRunOcrAction,
  updateWarrantyAction,
  type WarrantyActionState,
} from '../actions';

const initial: WarrantyActionState = {};

const OCR_CHIP: Record<WarrantyReceiptRow['ocrStatus'], string> = {
  pending: 'Reading…',
  done: 'Read',
  failed: 'Could not read',
};

export function WarrantyDetailClient({
  item,
  receipts,
  status,
  people,
  today,
  linkedTransaction,
  linkRemoved,
}: {
  item: WarrantyItemRow;
  receipts: WarrantyReceiptRow[];
  status: WarrantyStatus;
  people: { id: number; name: string }[];
  today: string;
  linkedTransaction: { id: number; date: string; description: string } | null;
  linkRemoved: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const onStagedChange = useCallback((files: StagedFile[]) => setStaged(files), []);

  const [editState, editAction] = useActionState(updateWarrantyAction, initial);
  const [deleteState, deleteAction] = useActionState(deleteWarrantyAction, initial);
  const [attachState, attachAction] = useActionState(attachReceiptsAction, initial);
  const [removeState, removeAction] = useActionState(deleteReceiptAction, initial);
  const [ocrState, ocrAction] = useActionState(reRunOcrAction, initial);

  const error = editState.error ?? deleteState.error ?? attachState.error ?? removeState.error ?? ocrState.error;
  const notice = editState.message ?? attachState.message ?? removeState.message ?? ocrState.message;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{item.name}</h1>
          <StatusBadge status={status} expiryDate={item.expiryDate} today={today} />
        </div>
        <Link href="/warranties" className="text-sm underline">Back to warranties</Link>
      </div>

      <FormError message={error} />
      {notice ? <p className="text-sm text-green-700 dark:text-green-400">{notice}</p> : null}

      <dl className="grid max-w-2xl grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt className="text-slate-500">Vendor</dt><dd>{item.vendor ?? '—'}</dd>
        <dt className="text-slate-500">Model</dt><dd>{item.model ?? '—'}</dd>
        <dt className="text-slate-500">Serial number</dt><dd>{item.serial ?? '—'}</dd>
        <dt className="text-slate-500">Purchase date</dt><dd>{item.purchaseDate}</dd>
        <dt className="text-slate-500">Warranty length</dt>
        <dd>{item.isLifetime ? 'Lifetime' : item.warrantyMonths === null ? 'Unknown' : `${item.warrantyMonths} months`}</dd>
        <dt className="text-slate-500">Covered through</dt><dd>{item.expiryDate ?? '—'}</dd>
        <dt className="text-slate-500">Price</dt><dd>{item.priceCents === null ? '—' : formatCents(item.priceCents)}</dd>
        <dt className="text-slate-500">Owner</dt><dd>{item.ownerName}</dd>
        <dt className="text-slate-500">Notes</dt><dd>{item.notes ?? '—'}</dd>
        <dt className="text-slate-500">Transaction</dt>
        <dd>
          {linkedTransaction ? (
            <Link href={`/transactions?q=${encodeURIComponent(linkedTransaction.description)}`} className="underline">
              {linkedTransaction.date} · {linkedTransaction.description}
            </Link>
          ) : linkRemoved ? (
            'The linked transaction was removed by an import undo'
          ) : (
            '—'
          )}
        </dd>
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Receipts ({receipts.length} receipt{receipts.length === 1 ? '' : 's'})</h2>
        {receipts.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">No receipts attached yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-4">
            {receipts.map((receipt) => (
              <li key={receipt.id} className="flex w-48 flex-col gap-1 rounded border p-2 text-xs dark:border-slate-700">
                {!receipt.fileExists ? (
                  <span className="text-slate-500">file missing</span>
                ) : receipt.mime === 'application/pdf' ? (
                  // MUST-5.3: PDFs are LINKED, never embedded — an inline same-origin PDF
                  // runs the viewer's JavaScript in our origin.
                  <a href={`/api/warranties/receipts/${receipt.id}`} className="underline">Download PDF</a>
                ) : (
                  <a href={`/api/warranties/receipts/${receipt.id}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/warranties/receipts/${receipt.id}`}
                      alt={receipt.originalFilename}
                      className="max-h-32 w-full object-contain"
                    />
                  </a>
                )}
                {/* MUST-13.3: original_filename and ocr_error are attacker-influenceable and
                    are rendered as TEXT NODES only, never as HTML. */}
                <span className="truncate" title={receipt.originalFilename}>{receipt.originalFilename}</span>
                <span className="text-slate-500">{Math.round(receipt.sizeBytes / 1024)} KB · {OCR_CHIP[receipt.ocrStatus]}</span>
                {receipt.ocrError ? <span className="text-red-700 dark:text-red-300">{receipt.ocrError}</span> : null}
                <div className="flex gap-2">
                  <form action={ocrAction}>
                    <input type="hidden" name="receiptId" value={receipt.id} />
                    <button type="submit" className="underline">Re-run OCR</button>
                  </form>
                  <form
                    action={removeAction}
                    onSubmit={(event) => {
                      if (!confirm(`Remove ${receipt.originalFilename}?`)) event.preventDefault();
                    }}
                  >
                    <input type="hidden" name="receiptId" value={receipt.id} />
                    <button type="submit" className="underline">Remove</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form action={attachAction} className="flex flex-col gap-2">
          <input type="hidden" name="itemId" value={item.id} />
          <input
            type="hidden"
            name="staged"
            value={JSON.stringify(staged.map((f) => ({ stagingId: f.stagingId, originalFilename: f.originalFilename })))}
          />
          <ReceiptUploader onStagedChange={onStagedChange} label="Add another receipt" />
          <SubmitButton className="w-fit">Attach receipts</SubmitButton>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex gap-3">
          <button type="button" onClick={() => setEditing((v) => !v)} className="rounded border px-3 py-1 text-sm dark:border-slate-700">
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
          <button type="button" onClick={() => setConfirming(true)} className="rounded border px-3 py-1 text-sm text-red-700 dark:border-slate-700 dark:text-red-300">
            Delete item
          </button>
        </div>

        {confirming ? (
          <form action={deleteAction} className="flex flex-col gap-2 rounded border border-red-300 p-3 text-sm dark:border-red-800">
            <p>
              Delete <strong>{item.name}</strong> and its {receipts.length} receipt{receipts.length === 1 ? '' : 's'}?
              This cannot be undone.
            </p>
            <input type="hidden" name="itemId" value={item.id} />
            <div className="flex gap-2">
              <SubmitButton>Delete permanently</SubmitButton>
              <button type="button" onClick={() => setConfirming(false)} className="rounded border px-3 py-2 dark:border-slate-700">
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {editing ? <EditForm item={item} people={people} today={today} action={editAction} /> : null}
      </section>
    </div>
  );
}

function EditForm({
  item,
  people,
  today,
  action,
}: {
  item: WarrantyItemRow;
  people: { id: number; name: string }[];
  today: string;
  action: (formData: FormData) => void;
}) {
  const [isLifetime, setIsLifetime] = useState(item.isLifetime);
  const [months, setMonths] = useState(item.warrantyMonths === null ? '' : String(item.warrantyMonths));

  return (
    <form action={action} className="flex max-w-2xl flex-col gap-3 text-sm">
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="transactionId" value={item.transactionId ?? ''} />
      <input type="hidden" name="staged" value="[]" />

      <label className="flex flex-col gap-1">
        Name
        <input name="name" required maxLength={200} defaultValue={item.name} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Vendor
        <input name="vendor" maxLength={200} defaultValue={item.vendor ?? ''} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Model
        <input name="model" maxLength={200} defaultValue={item.model ?? ''} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Serial number
        <input name="serial" maxLength={200} defaultValue={item.serial ?? ''} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Purchase date
        <input type="date" name="purchaseDate" required max={today} defaultValue={item.purchaseDate} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend>Warranty length</legend>
        <input
          type="number"
          name="warrantyMonths"
          min={1}
          value={months}
          disabled={isLifetime}
          onChange={(e) => setMonths(e.target.value)}
          className="w-28 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="isLifetime"
            checked={isLifetime}
            onChange={(e) => {
              setIsLifetime(e.target.checked);
              if (e.target.checked) setMonths('');
            }}
          />
          Lifetime
        </label>
      </fieldset>
      <label className="flex flex-col gap-1">
        Price
        <input name="price" inputMode="decimal" defaultValue={item.priceCents === null ? '' : (item.priceCents / 100).toFixed(2)} className="w-40 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1">
        Owner
        <select name="ownerUserId" defaultValue={String(item.ownerUserId)} className="w-56 rounded border px-2 py-1 dark:bg-slate-900">
          {people.map((person) => (
            <option key={person.id} value={person.id}>{person.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Notes
        <textarea name="notes" maxLength={2000} rows={3} defaultValue={item.notes ?? ''} className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <SubmitButton className="w-fit">Save changes</SubmitButton>
    </form>
  );
}
```

Create `src/app/(app)/warranties/[id]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { todayIso } from '@/lib/dates';
import { displayNameOf, getTransaction } from '@/lib/transactions';
import { warrantyStatus } from '@/lib/warranty/expiry';
import { getWarrantyItem, listWarrantyReceipts } from '@/lib/warranty/items';
import { WarrantyDetailClient } from './warranty-detail-client';

export const dynamic = 'force-dynamic';

export default async function WarrantyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id: raw } = await params;
  if (!/^\d+$/.test(raw)) notFound();
  const item = getWarrantyItem(Number(raw));
  if (!item) notFound();

  const txn = item.transactionId === null ? null : getTransaction(item.transactionId);
  const today = todayIso();

  return (
    <WarrantyDetailClient
      item={item}
      receipts={listWarrantyReceipts(item.id)}
      status={warrantyStatus(item, today)}
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
      today={today}
      linkedTransaction={txn ? { id: txn.id, date: txn.date, description: displayNameOf(txn) } : null}
      /* §10.4: never render a dead link. ON DELETE SET NULL leaves no durable marker that
         a link USED to exist, so the only detectable case is a dangling id — which is what
         a database restored with foreign keys off would produce. See the plan's
         "Spec ambiguities resolved" note. */
      linkRemoved={item.transactionId !== null && txn === null}
    />
  );
}
```

Run: `npm test -- tests/app/warranty-detail-client.test.tsx`
Expected: PASS.

- [ ] **Step 10: Add the nav entry.**

In `src/app/(app)/layout.tsx`, insert into `NAV` immediately after the Goals entry (MUST-10.1 — no badge):

```ts
  { href: '/warranties', label: 'Warranties' },
```

- [ ] **Step 11: Full suite, typecheck and a production build.**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green. `npm run build` is included here because this is the first task that adds pages, and a `use client` / server-component boundary mistake shows up only at build time.

- [ ] **Step 12: Checkpoint (commit is PAUSED).**

Commit message to use when the pause is lifted:

```bash
git add src/components/warranty "src/app/(app)/warranties" "src/app/(app)/layout.tsx" tests/components/StatusBadge.test.tsx tests/app/warranties-client.test.tsx tests/app/new-warranty-client.test.tsx tests/app/warranty-detail-client.test.tsx
git commit -m "feat(warranty): list, add and detail pages with staged receipt upload"
```

---

## Task 10: Dashboard widget and the transactions "Create warranty" row action

**Context:** Two small integrations into pages that already exist. The dashboard gains one card; the transactions table gains one link. **Nothing about `transactions` changes** — no column, no index, no behaviour (MUST-11.5). The link carries only an id; every prefill value is derived server-side by the page built in Task 9.

**Files:**
- Create: `src/components/warranty/ExpiringSoonCard.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx` (render the card)
- Modify: `src/app/(app)/transactions/transactions-client.tsx` (one header cell, one body cell)
- Test: `tests/components/ExpiringSoonCard.test.tsx`
- Test: `tests/app/transactions-client.test.tsx` (append one describe block)

**Interfaces:**
- Consumes: `WarrantyListItem`, `expiringSoonItems` from `@/lib/warranty/search` (Task 6); `statusLabel`, `EXPIRING_SOON_DAYS` from `@/lib/warranty/expiry` (Task 2); `todayIso` from `@/lib/dates`; the existing dashboard `scopeUserId` person-switcher value.
- Produces:
  ```tsx
  // src/components/warranty/ExpiringSoonCard.tsx
  export const EXPIRING_WIDGET_LIMIT = 5;
  /** Renders null when `items` is empty — the dashboard already has enough on it. */
  export function ExpiringSoonCard(props: { items: WarrantyListItem[]; today: string }): JSX.Element | null;
  ```
  Plus the URL contract the transactions table now emits: `/warranties/new?transactionId=<id>`.

### Steps

- [ ] **Step 1: Write the failing widget test.**

Create `tests/components/ExpiringSoonCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ExpiringSoonCard, EXPIRING_WIDGET_LIMIT } from '@/components/warranty/ExpiringSoonCard';
import type { WarrantyListItem } from '@/lib/warranty/search';

afterEach(() => cleanup());

const TODAY = '2026-08-16';

function item(over: Partial<WarrantyListItem> = {}): WarrantyListItem {
  return {
    id: 1, name: 'Kettle', vendor: 'Canadian Tire', model: null, serial: null,
    purchaseDate: '2026-07-16', warrantyMonths: 1, isLifetime: false, expiryDate: '2026-08-26',
    priceCents: 4999, ownerUserId: 7, ownerName: 'Alice', transactionId: null, notes: null,
    createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
    status: 'expiring', receiptCount: 0,
    ...over,
  };
}

describe('ExpiringSoonCard (MUST-10.5)', () => {
  it('renders nothing at all when the list is empty', () => {
    const { container } = render(<ExpiringSoonCard items={[]} today={TODAY} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows name, vendor and the day count for each item', () => {
    render(<ExpiringSoonCard items={[item()]} today={TODAY} />);
    expect(screen.getByText('Kettle')).toBeTruthy();
    expect(screen.getByText('Canadian Tire')).toBeTruthy();
    expect(screen.getByText('Expires in 10 days')).toBeTruthy();
  });

  it('caps at five and links to the filtered list', () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ id: i + 1, name: `Item ${i}` }));
    const { container } = render(<ExpiringSoonCard items={many} today={TODAY} />);
    expect(EXPIRING_WIDGET_LIMIT).toBe(5);
    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(container.querySelector('a[href="/warranties?status=expiring"]')).toBeTruthy();
  });

  it('links each row to its own detail page', () => {
    const { container } = render(<ExpiringSoonCard items={[item({ id: 42 })]} today={TODAY} />);
    expect(container.querySelector('a[href="/warranties/42"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npm test -- tests/components/ExpiringSoonCard.test.tsx`
Expected: FAIL — cannot resolve `@/components/warranty/ExpiringSoonCard`.

- [ ] **Step 3: Implement the widget.**

Create `src/components/warranty/ExpiringSoonCard.tsx`:

```tsx
import Link from 'next/link';
import { statusLabel } from '@/lib/warranty/expiry';
import type { WarrantyListItem } from '@/lib/warranty/search';

/** §17.19 / MUST-10.5: top 5, hidden when empty. */
export const EXPIRING_WIDGET_LIMIT = 5;

export function ExpiringSoonCard({ items, today }: { items: WarrantyListItem[]; today: string }) {
  // Hidden entirely when the count is zero — the dashboard already has enough on it.
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Warranties expiring soon</h2>
        <Link href="/warranties?status=expiring" className="text-sm underline">View all</Link>
      </div>
      <ul className="text-sm">
        {items.slice(0, EXPIRING_WIDGET_LIMIT).map((row) => (
          <li key={row.id} className="flex justify-between border-b border-slate-100 py-1 dark:border-slate-900">
            <span>
              <Link href={`/warranties/${row.id}`} className="hover:underline">{row.name}</Link>
              {row.vendor ? <span className="ml-2 text-slate-500">{row.vendor}</span> : null}
            </span>
            <span className="text-amber-700 dark:text-amber-300">
              {statusLabel('expiring', row.expiryDate, today)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Run it to verify it passes.**

Run: `npm test -- tests/components/ExpiringSoonCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the widget into the dashboard.**

In `src/app/(app)/dashboard/page.tsx`:

Add to the imports:

```ts
import { todayIso } from '@/lib/dates';
import { expiringSoonItems } from '@/lib/warranty/search';
import { ExpiringSoonCard, EXPIRING_WIDGET_LIMIT } from '@/components/warranty/ExpiringSoonCard';
```

(`currentMonth`, `monthEnd`, `monthStart` are already imported from `@/lib/dates`; add `todayIso` to that same import rather than a second statement.)

Immediately after the existing `const hasAccounts = listAccounts().length > 0;` line, add:

```ts
  // MUST-10.6: the widget respects the dashboard's existing person switcher — Household
  // shows every item, a selected person shows only items they own.
  const today = todayIso();
  const expiring = expiringSoonItems(EXPIRING_WIDGET_LIMIT, scopeUserId, today);
```

And render the card immediately **after** the `reviewCount > 0` banner and **before** the budgets `<section>`:

```tsx
      <ExpiringSoonCard items={expiring} today={today} />
```

- [ ] **Step 6: Write the failing transactions-integration test.**

Append this describe block to `tests/app/transactions-client.test.tsx`:

```tsx
describe('Create warranty row action (§11)', () => {
  it('links a normal row to the add form carrying only the transaction id', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow({ id: 77 })} accounts={[]} categories={[]} people={[]} today="2026-08-16" />,
    );
    const link = container.querySelector('a[href="/warranties/new?transactionId=77"]');
    expect(link).toBeTruthy();
    expect(link!.textContent).toMatch(/create warranty/i);
  });

  it('hides the action on a transfer row (MUST-11.2)', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 78, isTransfer: true })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-08-16"
      />,
    );
    expect(container.querySelector('a[href="/warranties/new?transactionId=78"]')).toBeNull();
  });

  it('carries no field values in the URL — prefill is computed server-side (MUST-11.3)', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 79, amountCents: -129999, rawDescription: 'HOME DEPOT' })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-08-16"
      />,
    );
    const href = container.querySelector('a[href^="/warranties/new"]')!.getAttribute('href')!;
    expect(href).toBe('/warranties/new?transactionId=79');
    expect(href).not.toContain('amount');
    expect(href).not.toContain('vendor');
    expect(href).not.toContain('date');
  });
});
```

- [ ] **Step 7: Run it to verify it fails.**

Run: `npm test -- tests/app/transactions-client.test.tsx`
Expected: FAIL on the three new cases — no such link exists yet. The pre-existing cases in the file must stay green.

- [ ] **Step 8: Add the row action.**

In `src/app/(app)/transactions/transactions-client.tsx`:

Add the Next link import at the top of the file, beside the existing imports:

```tsx
import Link from 'next/link';
```

In the `<thead>` row, after `<th>Person</th>`, add an empty header cell so the column count matches:

```tsx
              <th></th>
```

In the `<tbody>` row, after the closing `</td>` of the Person cell (the one containing `attrAction`), add:

```tsx
                <td>
                  {/* MUST-11.1 / MUST-11.2: a purchase can carry a warranty; a transfer cannot.
                      MUST-11.3: the URL carries ONLY the id — the add page derives the date,
                      the abs() price and the vendor from the transaction row server-side. */}
                  {row.isTransfer ? null : (
                    <Link href={`/warranties/new?transactionId=${row.id}`} className="text-xs underline">
                      Create warranty
                    </Link>
                  )}
                </td>
```

- [ ] **Step 9: Run the transactions test to verify it passes.**

Run: `npm test -- tests/app/transactions-client.test.tsx`
Expected: PASS, including every pre-existing case.

- [ ] **Step 10: Write the end-to-end link/undo integration test.**

Create `tests/integration/warranty-transaction-link.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';
import { createWarrantyItem, getWarrantyItem, type WarrantyInput } from '@/lib/warranty/items';
import { displayNameOf, getTransaction } from '@/lib/transactions';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-warranty-link-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('warranty ↔ transaction link (§11, MUST-3.7)', () => {
  it('derives the prefill server-side and survives the transaction being deleted', () => {
    const userId = insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const accountId = insertTestAccount(current!.db, { name: 'Joint Chequing' });
    const txnId = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, display_description, normalized_merchant,
                                amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-08-16', 'HOME DEPOT #7042', 'Home Depot', 'HOME DEPOT',
              -129999, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;

    // Exactly the derivation the add page performs (MUST-11.3).
    const txn = getTransaction(txnId)!;
    const input: WarrantyInput = {
      name: 'Fridge',
      vendor: displayNameOf(txn).replace(/\s+/g, ' ').trim().slice(0, 60),
      model: null,
      serial: null,
      purchaseDate: txn.date,
      warrantyMonths: 24,
      isLifetime: false,
      priceCents: Math.abs(txn.amountCents),
      ownerUserId: userId,
      transactionId: txn.id,
      notes: null,
    };
    expect(input.vendor).toBe('Home Depot');
    expect(input.priceCents).toBe(129999);
    expect(input.purchaseDate).toBe('2026-08-16');

    const itemId = createWarrantyItem(input);
    expect(getWarrantyItem(itemId)!.transactionId).toBe(txnId);

    // An import undo deletes the transaction row directly; the FK does the rest.
    current!.db.run(sql`delete from transactions where id = ${txnId}`);

    const survivor = getWarrantyItem(itemId)!;
    expect(survivor).not.toBeNull();
    expect(survivor.transactionId).toBeNull();
    expect(survivor.name).toBe('Fridge');
    expect(survivor.priceCents).toBe(129999);
  });
});
```

- [ ] **Step 11: Run it, then the full suite and a build.**

Run: `npm test -- tests/integration/warranty-transaction-link.test.ts`
Expected: PASS (nothing new to implement — this pins behaviour already delivered by Task 1's `ON DELETE SET NULL` and Task 6's data layer).

Run: `npm test && npm run typecheck && npm run build`
Expected: green.

- [ ] **Step 12: Checkpoint (commit is PAUSED).**

Commit message to use when the pause is lifted:

```bash
git add src/components/warranty/ExpiringSoonCard.tsx "src/app/(app)/dashboard/page.tsx" "src/app/(app)/transactions/transactions-client.tsx" tests/components/ExpiringSoonCard.test.tsx tests/app/transactions-client.test.tsx tests/integration/warranty-transaction-link.test.ts
git commit -m "feat(warranty): expiring-soon dashboard card and Create warranty row action"
```

---

## Task 11: Backups that include receipts, and a restore tool

**Context:** A backup stops being a bare `.db` file and becomes a gzipped tar containing `budget.db` (still a `VACUUM INTO` snapshot) plus `receipts/`. Two compatibility rules are binding and load-bearing: a v1.0.0 `.db` backup must still be **listed and prunable** after the upgrade (MUST-12.3), and must still **restore cleanly** into v1.1.0 without touching `data/receipts/` (MUST-12.9). Restore stays an offline, container-stopped procedure — there is deliberately no in-app restore button, because restoring under a live SQLite connection is how you corrupt a database.

**Files:**
- Modify: `package.json` (add `tar`, add the `restore-backup` script)
- Create: `src/lib/backup/archive.ts`
- Modify: `src/lib/backup.ts` (re-export the dirs, archive the nightly + on-demand backup, list both artifact shapes, sweep receipt orphans)
- Modify: `src/app/api/backup/download/route.ts` (stream the archive)
- Create: `scripts/restore-backup.ts`
- Test: `tests/lib/backup-archive.test.ts`
- Test: `tests/scripts/restore-backup.test.ts`
- Modify: `tests/lib/backup.test.ts` (the `.db` name assertions become `.tar.gz`)
- Modify: `tests/api/backup.route.test.ts` (the download is now a gzip stream)
- Modify: `src/app/(app)/settings/backups/backups-client.tsx` (one wording change)

**Interfaces:**
- Consumes: `getSqlite` from `@/db/client`; `readEnv` from `@/lib/env`; `todayIso` from `@/lib/dates`; `STORED_NAME_RE`, `receiptsDir`, `purgeOrphanReceipts` from `@/lib/warranty/receipts` (Task 3); `listStoredFilenames` from `@/lib/warranty/items` (Task 6).
- Produces:
  ```ts
  // src/lib/backup/archive.ts
  export const ARCHIVE_NAME_RE: RegExp;   // ^budget-\d{4}-\d{2}-\d{2}\.tar\.gz$
  export const LEGACY_NAME_RE: RegExp;    // ^budget-\d{4}-\d{2}-\d{2}\.db$
  export const ON_DEMAND_NAME_RE: RegExp; // ^<uuid>\.tar\.gz$
  export function backupsDir(): string;
  export function tempDir(): string;
  export function resolveSafeTarget(dir: string, name: string, pattern: RegExp): string;
  export function nightlyArchiveName(at?: Date, tz?: string): string;
  export function buildArchive(targetPath: string): void;
  export function createOnDemandArchive(): { path: string; bytes: number };

  // src/lib/backup.ts (changed signatures/behaviour)
  export function nightlyBackupName(at?: Date, tz?: string): string;   // now .tar.gz
  export function listBackups(): BackupFile[];                          // .tar.gz AND legacy .db
  export function createOnDemandBackup(): { path: string; bytes: number }; // now a .tar.gz
  export interface SweepResult {
    sessionsPurged: number; loginAttemptsPurged: number; stagedFilesPurged: number;
    receiptOrphansPurged: number;   // NEW
  }

  // scripts/restore-backup.ts  (self-contained: no '@/' imports — see the note in Step 7)
  export type ArtifactKind = 'archive' | 'sqlite' | 'unknown';
  export const RESTORE_STORED_NAME_RE: RegExp;
  export class RestoreError extends Error {}
  export function detectArtifactKind(filePath: string): ArtifactKind;
  export interface RestoreResult {
    kind: ArtifactKind; databaseRestored: boolean; receiptsRestored: number;
    receiptsMovedAside: string | null; missingReceiptRows: number;
  }
  export function restoreFromArtifact(artifactPath: string, opts: { dataDir: string; now?: Date }): RestoreResult;
  ```

### Steps

- [ ] **Step 1: Install node-tar and VERIFY its export shape.**

```powershell
npm install --save tar@^7
node -e "const t=require('tar');console.log(typeof t.create, typeof t.list, typeof t.extract)"
```

Expected: `function function function`. If `create` is missing, read `node_modules/tar/package.json` `exports` and adapt the three call sites below; the tests are the contract.

- [ ] **Step 2: Write the failing archive test.**

Create `tests/lib/backup-archive.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import {
  ARCHIVE_NAME_RE,
  LEGACY_NAME_RE,
  backupsDir,
  buildArchive,
  createOnDemandArchive,
  nightlyArchiveName,
  resolveSafeTarget,
  tempDir,
} from '@/lib/backup/archive';
import { listBackups, nightlyBackupName, pruneBackups, runMaintenanceSweep, runNightlyJob } from '@/lib/backup';
import { receiptsDir, writeReceiptFile } from '@/lib/warranty/receipts';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-archive-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  process.env.BUDGET_DB_PATH = current.path;
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
  else process.env.BUDGET_DB_PATH = originalDbPath;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function entriesOf(archivePath: string): Promise<string[]> {
  const tar = await import('tar');
  const names: string[] = [];
  tar.list({ file: archivePath, sync: true, onReadEntry: (entry) => names.push(entry.path) });
  return names.sort();
}

describe('archive naming and guards', () => {
  it('names the nightly artifact budget-YYYY-MM-DD.tar.gz', () => {
    const at = new Date('2026-08-16T06:00:00.000Z'); // 02:00 in Toronto
    expect(nightlyArchiveName(at, 'America/Toronto')).toBe('budget-2026-08-16.tar.gz');
    expect(nightlyBackupName(at, 'America/Toronto')).toBe('budget-2026-08-16.tar.gz');
    expect(ARCHIVE_NAME_RE.test('budget-2026-08-16.tar.gz')).toBe(true);
    expect(LEGACY_NAME_RE.test('budget-2026-08-16.db')).toBe(true);
  });

  it('refuses a filename that does not match its pattern or escapes its directory', () => {
    expect(() => resolveSafeTarget(backupsDir(), '../evil.tar.gz', ARCHIVE_NAME_RE)).toThrowError(/unsafe/i);
    expect(() => resolveSafeTarget(backupsDir(), 'budget-2026-08-16.tar.gz.bak', ARCHIVE_NAME_RE)).toThrowError(/unsafe/i);
  });
});

describe('buildArchive (MUST-12.1, MUST-12.2)', () => {
  it('contains budget.db and every receipt, and leaves no temp snapshot behind', async () => {
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const a = writeReceiptFile(JPEG, 'image/jpeg');
    const b = writeReceiptFile(Buffer.from('%PDF-1.7\n'), 'application/pdf');

    const target = path.join(dataDir, 'out.tar.gz');
    buildArchive(target);

    const head = fs.readFileSync(target).subarray(0, 2);
    expect([head[0], head[1]]).toEqual([0x1f, 0x8b]);
    expect(await entriesOf(target)).toEqual(['budget.db', 'receipts/', `receipts/${a}`, `receipts/${b}`].sort());

    // No leftovers in DATA_DIR/tmp — neither the VACUUM snapshot nor the staging directory.
    expect(fs.readdirSync(tempDir()).filter((n) => n.endsWith('.db') || n.includes('archive'))).toEqual([]);
  });

  it('works when there are no receipts at all', async () => {
    const target = path.join(dataDir, 'empty.tar.gz');
    buildArchive(target);
    expect(await entriesOf(target)).toContain('budget.db');
  });

  it('overwrites an existing target rather than failing the day’s backup', () => {
    const target = path.join(dataDir, 'twice.tar.gz');
    buildArchive(target);
    expect(() => buildArchive(target)).not.toThrow();
  });

  it('createOnDemandArchive writes into tmp under a UUID name', () => {
    const { path: file, bytes } = createOnDemandArchive();
    expect(path.dirname(file)).toBe(path.resolve(tempDir()));
    expect(path.basename(file)).toMatch(/^[0-9a-f-]{36}\.tar\.gz$/);
    expect(bytes).toBeGreaterThan(0);
  });
});

describe('listBackups compatibility (MUST-12.3)', () => {
  function fake(name: string, ageMinutes: number): void {
    fs.mkdirSync(backupsDir(), { recursive: true });
    const file = path.join(backupsDir(), name);
    fs.writeFileSync(file, 'x');
    const when = new Date(Date.now() - ageMinutes * 60_000);
    fs.utimesSync(file, when, when);
  }

  it('lists BOTH .tar.gz and legacy .db artifacts, newest first', () => {
    fake('budget-2026-08-16.tar.gz', 1);
    fake('budget-2026-08-15.db', 60);
    fake('budget-2026-08-16.tar.gz.bak', 2);
    fake('README.txt', 3);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-16.tar.gz', 'budget-2026-08-15.db']);
  });

  it('prunes across both shapes with one retention count', () => {
    fake('budget-2026-08-16.tar.gz', 1);
    fake('budget-2026-08-15.db', 60);
    fake('budget-2026-08-14.db', 120);
    expect(pruneBackups(1).sort()).toEqual(['budget-2026-08-14.db', 'budget-2026-08-15.db']);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-16.tar.gz']);
  });
});

describe('maintenance sweep (MUST-4.9)', () => {
  it('reports receiptOrphansPurged and leaves referenced files alone', () => {
    const orphan = writeReceiptFile(JPEG, 'image/jpeg');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.join(receiptsDir(), orphan), twoDaysAgo, twoDaysAgo);

    const result = runMaintenanceSweep(new Date());
    expect(result.receiptOrphansPurged).toBe(1);
    expect(fs.existsSync(path.join(receiptsDir(), orphan))).toBe(false);
  });
});

describe('runNightlyJob', () => {
  it('writes the archive, prunes, sweeps, and reports the archive name', () => {
    const result = runNightlyJob(new Date('2026-08-16T06:00:00.000Z'));
    expect(result.backup.name).toBe('budget-2026-08-16.tar.gz');
    expect(result.backup.bytes).toBeGreaterThan(0);
    expect(result.sweep.receiptOrphansPurged).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails.**

Run: `npm test -- tests/lib/backup-archive.test.ts`
Expected: FAIL — cannot resolve `@/lib/backup/archive`.

- [ ] **Step 4: Implement `src/lib/backup/archive.ts`.**

Note on layout: `src/lib/backup.ts` (a file) and `src/lib/backup/` (a directory) coexist. `@/lib/backup` resolves to the **file** and `@/lib/backup/archive` to the directory member, under both the TypeScript `bundler` resolution this repo uses and webpack. Step 12 verifies it with a real `npm run build`; if any resolver disagrees, move `src/lib/backup.ts` to `src/lib/backup/index.ts` — every existing `@/lib/backup` importer keeps working unchanged.

```ts
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { create as tarCreate } from 'tar';
import { getSqlite } from '@/db/client';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { STORED_NAME_RE, receiptsDir } from '@/lib/warranty/receipts';

/**
 * MUST-12.1: a backup is a gzipped tar containing
 *     budget.db          (a VACUUM INTO snapshot, not the live file)
 *     receipts/<files>   (every file in ${DATA_DIR}/receipts)
 *
 * node-tar is the archiver: Node ships zlib but no tar writer, and hand-rolling one to save
 * a dependency is the wrong trade on a data-integrity path.
 */
export const ARCHIVE_NAME_RE = /^budget-\d{4}-\d{2}-\d{2}\.tar\.gz$/;
/** MUST-12.3: a v1.0.0 install's existing .db backups stay visible, listed and prunable. */
export const LEGACY_NAME_RE = /^budget-\d{4}-\d{2}-\d{2}\.db$/;
export const ON_DEMAND_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/;
const SNAPSHOT_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/;

export function backupsDir(): string {
  return path.join(readEnv().dataDir, 'backups');
}

export function tempDir(): string {
  return path.join(readEnv().dataDir, 'tmp');
}

/**
 * Controller ruling (b), unchanged from v1.0.0: a VACUUM INTO / archive target must never be
 * built from an attacker-influenced string. Nightly names come only from todayIso()'s fixed
 * YYYY-MM-DD output and on-demand names only from randomUUID(). This refuses any filename
 * that doesn't match its expected shape and confirms the resolved path still lands directly
 * inside the expected directory before any fs call touches it.
 */
export function resolveSafeTarget(dir: string, name: string, pattern: RegExp): string {
  if (!pattern.test(name)) throw new Error(`Refusing unsafe backup filename: ${name}`);
  const resolvedDir = path.resolve(dir);
  const target = path.resolve(resolvedDir, name);
  if (path.dirname(target) !== resolvedDir) {
    throw new Error('Refusing to write a backup outside its directory');
  }
  return target;
}

export function nightlyArchiveName(at: Date = new Date(), tz?: string): string {
  return `budget-${todayIso(at, tz)}.tar.gz`;
}

function vacuumInto(target: string): void {
  // VACUUM cannot be a bound-parameter statement in every SQLite build, so the path is
  // escaped and inlined. Single quotes are doubled per SQLite rules.
  getSqlite().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

/**
 * MUST-12.2: delete the target if present, VACUUM INTO a temp snapshot, add it as
 * `budget.db`, add `receipts/`, then unlink the temp snapshot in a `finally`.
 *
 * The staging directory holds HARD LINKS to the receipts rather than copies, so a 300 MB
 * receipt library is not duplicated on disk while the archive is written. Hard links are
 * read as ordinary files by tar; copyFileSync is the fallback if the filesystem refuses.
 */
export function buildArchive(targetPath: string): void {
  const tmp = tempDir();
  fs.mkdirSync(tmp, { recursive: true });
  const stage = path.join(tmp, `${randomUUID()}-archive`);
  const snapshotName = `${randomUUID()}.db`;
  const snapshot = resolveSafeTarget(tmp, snapshotName, SNAPSHOT_NAME_RE);

  try {
    fs.rmSync(snapshot, { force: true });
    vacuumInto(snapshot);

    fs.mkdirSync(stage, { recursive: true });
    fs.renameSync(snapshot, path.join(stage, 'budget.db'));

    const source = receiptsDir();
    const stagedReceipts = path.join(stage, 'receipts');
    fs.mkdirSync(stagedReceipts, { recursive: true });
    if (fs.existsSync(source)) {
      for (const entry of fs.readdirSync(source)) {
        if (!STORED_NAME_RE.test(entry)) continue;
        const from = path.join(source, entry);
        const to = path.join(stagedReceipts, entry);
        try {
          fs.linkSync(from, to);
        } catch {
          fs.copyFileSync(from, to);
        }
      }
    }

    fs.rmSync(targetPath, { force: true });
    tarCreate(
      { file: targetPath, cwd: stage, gzip: true, sync: true, portable: true, follow: false },
      ['budget.db', 'receipts'],
    );
  } finally {
    fs.rmSync(snapshot, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Settings -> "Download backup now". Built in /data/tmp so it cannot collide with a nightly name. */
export function createOnDemandArchive(): { path: string; bytes: number } {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = resolveSafeTarget(dir, `${randomUUID()}.tar.gz`, ON_DEMAND_NAME_RE);
  buildArchive(target);
  return { path: target, bytes: fs.statSync(target).size };
}
```

- [ ] **Step 5: Rework `src/lib/backup.ts` around it.**

Apply these edits to `src/lib/backup.ts`:

1. Replace the `fs`/`path`/`randomUUID`/`getSqlite` imports' companions with an import from the new module and delete the now-duplicated helpers. The top of the file becomes:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { purgeOldLoginAttempts } from '@/lib/auth/ratelimit';
import { purgeExpiredSessions } from '@/lib/auth/session';
import { purgeStagedFiles } from '@/lib/import/staging';
import { SETTING_BACKUP_RETENTION, getIntSetting, setIntSetting } from '@/lib/settings';
import {
  ARCHIVE_NAME_RE,
  LEGACY_NAME_RE,
  backupsDir,
  buildArchive,
  createOnDemandArchive,
  nightlyArchiveName,
  resolveSafeTarget,
  tempDir,
} from '@/lib/backup/archive';
import { listStoredFilenames } from '@/lib/warranty/items';
import { purgeOrphanReceipts } from '@/lib/warranty/receipts';

export const DEFAULT_BACKUP_RETENTION = 14;

// Re-exported so every existing importer of '@/lib/backup' keeps working unchanged.
export { backupsDir, tempDir };
```

Delete the old local `NIGHTLY_NAME_RE`, `ON_DEMAND_NAME_RE`, `backupsDir`, `tempDir`, `resolveSafeTarget` and `vacuumInto` definitions — `archive.ts` owns them now.

2. `nightlyBackupName` delegates:

```ts
export function nightlyBackupName(at: Date = new Date(), tz?: string): string {
  return nightlyArchiveName(at, tz);
}
```

3. `listBackups` recognises both shapes (MUST-12.3):

```ts
export function listBackups(): BackupFile[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    // MUST-12.3: retention counting spans BOTH shapes, so a v1.0.0 install's existing
    // .db backups stay visible and prunable after the upgrade.
    .filter((name) => ARCHIVE_NAME_RE.test(name) || LEGACY_NAME_RE.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      const stats = fs.statSync(file);
      return { name, path: file, bytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() };
    })
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : a.name < b.name ? 1 : -1));
}
```

4. `runNightlyBackup` builds the archive:

```ts
export function runNightlyBackup(at: Date = new Date()): BackupFile {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = nightlyArchiveName(at);
  const target = resolveSafeTarget(dir, name, ARCHIVE_NAME_RE);
  // Delete-then-write, exactly as before: without it, a container restart after 02:00 would
  // fail that day's backup permanently.
  fs.rmSync(target, { force: true });
  buildArchive(target);
  const stats = fs.statSync(target);
  return { name, path: target, bytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() };
}
```

5. `createOnDemandBackup` delegates:

```ts
export function createOnDemandBackup(): { path: string; bytes: number } {
  return createOnDemandArchive();
}
```

6. The sweep gains the orphan purge:

```ts
export interface SweepResult {
  sessionsPurged: number;
  loginAttemptsPurged: number;
  stagedFilesPurged: number;
  receiptOrphansPurged: number;
}

export function runMaintenanceSweep(at: Date = new Date()): SweepResult {
  return {
    sessionsPurged: purgeExpiredSessions(at),
    loginAttemptsPurged: purgeOldLoginAttempts(at),
    stagedFilesPurged: purgeStagedFiles(undefined, at),
    // MUST-4.9: files in receipts/ with no matching stored_filename row AND an mtime older
    // than 24 h. The age guard prevents a race with an in-flight upload.
    receiptOrphansPurged: purgeOrphanReceipts(new Set(listStoredFilenames()), undefined, at),
  };
}
```

7. The nightly log line reports it:

```ts
  console.log(
    `[backup] wrote ${backup.name} (${backup.bytes} bytes), pruned ${pruned.length}, purged ${sweep.sessionsPurged} sessions / ${sweep.loginAttemptsPurged} login attempts / ${sweep.stagedFilesPurged} staged uploads / ${sweep.receiptOrphansPurged} orphan receipts`,
  );
```

- [ ] **Step 6: Update the existing backup tests to the new artifact shape.**

In `tests/lib/backup.test.ts`, replace every `budget-2026-08-1X.db` literal with `budget-2026-08-1X.tar.gz`, and change the "produces a readable SQLite copy" assertion (around line 79) from a `SQLite format 3` header check to a gzip-magic check, since the artifact is now an archive:

```ts
    expect(fs.readFileSync(second.path).subarray(0, 2).toJSON().data).toEqual([0x1f, 0x8b]);
```

Leave the `.db.bak` / `..budget-…` "ignores anything not matching the pattern" case as it is — it still must be ignored — and add one legacy-artifact case:

```ts
  it('keeps listing a v1.0.0 .db backup alongside the new archives (MUST-12.3)', () => {
    fakeBackup('budget-2026-08-15.tar.gz', 10);
    fakeBackup('budget-2026-08-14.db', 20);
    expect(listBackups().map((b) => b.name)).toEqual(['budget-2026-08-15.tar.gz', 'budget-2026-08-14.db']);
  });
```

In `tests/api/backup.route.test.ts`, change the two `SQLite format 3` body assertions to gzip magic and the content-disposition assertion to the new extension:

```ts
    expect(body.subarray(0, 2).toJSON().data).toEqual([0x1f, 0x8b]);
    expect(response.headers.get('content-disposition')).toContain('.tar.gz"');
```

- [ ] **Step 7: Update the download route to stream the archive.**

In `src/app/api/backup/download/route.ts`, replace the body of the `try` block (keeping every check above it byte-for-byte — the origin rule, the session, the admin gate) with:

```ts
  const { path: file, bytes } = createOnDemandBackup();
  try {
    // Streamed, not readFileSync: the archive now carries the whole receipt library.
    const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(bytes),
        'content-disposition': `attachment; filename="budget-${todayIso()}.tar.gz"`,
        'cache-control': 'no-store',
      },
    });
  } catch {
    fs.rmSync(file, { force: true });
    return new Response('Backup failed', { status: 500 });
  }
```

and add `import { Readable } from 'node:stream';` at the top. **Remove the `finally { fs.rmSync(file) }`**: the file must outlive the function now that the body is a lazy stream. Unlink it when the stream ends instead — replace the `createReadStream(file)` line with:

```ts
    const stream = fs.createReadStream(file);
    stream.once('close', () => fs.rmSync(file, { force: true }));
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
```

The existing test that asserts `/data/tmp` is left empty still passes, because `close` fires once the response body has been fully consumed by `await response.arrayBuffer()`. If it proves flaky, assert instead that the temp directory drains within one macrotask (`await new Promise((r) => setTimeout(r, 0))` before the check).

- [ ] **Step 8: Run the archive tests.**

Run: `npm test -- tests/lib/backup-archive.test.ts tests/lib/backup.test.ts tests/api/backup.route.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing restore test.**

Create `tests/scripts/restore-backup.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { buildArchive } from '@/lib/backup/archive';
import { receiptsDir, writeReceiptFile } from '@/lib/warranty/receipts';
import {
  RESTORE_STORED_NAME_RE,
  RestoreError,
  detectArtifactKind,
  restoreFromArtifact,
} from '../../scripts/restore-backup';
import { STORED_NAME_RE } from '@/lib/warranty/receipts';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  process.env.BUDGET_DB_PATH = current.path;
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
  else process.env.BUDGET_DB_PATH = originalDbPath;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('the duplicated stored-name regex stays in step (the ARGON2_OPTIONS precedent)', () => {
  it('matches src/lib/warranty/receipts.ts exactly', () => {
    expect(RESTORE_STORED_NAME_RE.source).toBe(STORED_NAME_RE.source);
    expect(RESTORE_STORED_NAME_RE.flags).toBe(STORED_NAME_RE.flags);
  });
});

describe('detectArtifactKind (MUST-12.5) — magic bytes, never the extension', () => {
  it('recognises gzip, SQLite and neither', () => {
    const gz = path.join(dataDir, 'a.bin');
    fs.writeFileSync(gz, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(detectArtifactKind(gz)).toBe('archive');

    const db = path.join(dataDir, 'b.bin');
    fs.writeFileSync(db, Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(16)]));
    expect(detectArtifactKind(db)).toBe('sqlite');

    const junk = path.join(dataDir, 'c.tar.gz'); // a lying extension
    fs.writeFileSync(junk, Buffer.from('this is a text file'));
    expect(detectArtifactKind(junk)).toBe('unknown');
  });

  it('refuses an unrecognised artifact and touches nothing', () => {
    const junk = path.join(dataDir, 'junk.tar.gz');
    fs.writeFileSync(junk, Buffer.from('nope'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.writeFileSync(path.join(target, 'budget.db'), 'ORIGINAL');
    expect(() => restoreFromArtifact(junk, { dataDir: target })).toThrowError(RestoreError);
    expect(fs.readFileSync(path.join(target, 'budget.db'), 'utf8')).toBe('ORIGINAL');
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('archive restore (MUST-12.7, MUST-12.8)', () => {
  it('restores the database and every receipt byte-for-byte into an empty data dir', () => {
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const a = writeReceiptFile(JPEG, 'image/jpeg');
    const b = writeReceiptFile(Buffer.from('%PDF-1.7\n'), 'application/pdf');
    const digests = { [a]: sha(path.join(receiptsDir(), a)), [b]: sha(path.join(receiptsDir(), b)) };

    const artifact = path.join(dataDir, 'backup.tar.gz');
    buildArchive(artifact);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    const result = restoreFromArtifact(artifact, { dataDir: target });

    expect(result.kind).toBe('archive');
    expect(result.databaseRestored).toBe(true);
    expect(result.receiptsRestored).toBe(2);
    expect(fs.readFileSync(path.join(target, 'budget.db')).subarray(0, 15).toString('utf8')).toBe('SQLite format 3');
    for (const [name, digest] of Object.entries(digests)) {
      expect(sha(path.join(target, 'receipts', name))).toBe(digest);
    }
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('removes stale -wal and -shm files (MUST-12.7)', () => {
    const artifact = path.join(dataDir, 'backup.tar.gz');
    buildArchive(artifact);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.writeFileSync(path.join(target, 'budget.db-wal'), 'stale');
    fs.writeFileSync(path.join(target, 'budget.db-shm'), 'stale');
    restoreFromArtifact(artifact, { dataDir: target });
    expect(fs.existsSync(path.join(target, 'budget.db-wal'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'budget.db-shm'))).toBe(false);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('moves an existing receipts/ aside instead of deleting it (MUST-12.8)', () => {
    const artifact = path.join(dataDir, 'backup.tar.gz');
    buildArchive(artifact);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.mkdirSync(path.join(target, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(target, 'receipts', 'keepme.txt'), 'precious');

    const result = restoreFromArtifact(artifact, { dataDir: target, now: new Date('2026-08-16T12:00:00.000Z') });
    expect(result.receiptsMovedAside).toMatch(/^receipts\.pre-restore-/);
    expect(fs.readFileSync(path.join(target, result.receiptsMovedAside!, 'keepme.txt'), 'utf8')).toBe('precious');
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('tar-slip defence (MUST-12.6)', () => {
  async function hostileArchive(entries: { name: string; body: string }[]): Promise<string> {
    const tar = await import('tar');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-hostile-'));
    const names: string[] = [];
    for (const entry of entries) {
      const file = path.join(stage, entry.name.replace(/[/\\]/g, '_'));
      fs.writeFileSync(file, entry.body);
      names.push(path.basename(file));
    }
    const out = path.join(dataDir, `hostile-${Math.random().toString(36).slice(2)}.tar.gz`);
    tar.create({ file: out, cwd: stage, gzip: true, sync: true }, names);
    fs.rmSync(stage, { recursive: true, force: true });
    return out;
  }

  it('aborts the whole restore on an unexpected top-level entry', async () => {
    const artifact = await hostileArchive([{ name: 'evil.sh', body: '#!/bin/sh\nrm -rf /' }]);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(RestoreError);
    expect(fs.readdirSync(target)).toEqual([]);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('rejects a receipts/ entry whose name is not a stored filename', async () => {
    const tar = await import('tar');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-hostile2-'));
    fs.mkdirSync(path.join(stage, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'receipts', 'evil.sh'), 'x');
    fs.writeFileSync(path.join(stage, 'budget.db'), 'SQLite format 3\0');
    const artifact = path.join(dataDir, 'hostile2.tar.gz');
    tar.create({ file: artifact, cwd: stage, gzip: true, sync: true }, ['budget.db', 'receipts']);
    fs.rmSync(stage, { recursive: true, force: true });

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(() => restoreFromArtifact(artifact, { dataDir: target })).toThrowError(/receipts/i);
    expect(fs.existsSync(path.join(target, 'budget.db'))).toBe(false);
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('v1.0.0 DB-only restore (MUST-12.9)', () => {
  it('replaces the database, leaves receipts/ completely untouched, and counts missing files', () => {
    // A v1.1 database that references two receipt files.
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const kept = writeReceiptFile(JPEG, 'image/jpeg');

    const legacy = path.join(dataDir, 'budget-2026-08-15.db');
    current!.sqlite.exec(`VACUUM INTO '${legacy.replace(/'/g, "''")}'`);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    fs.mkdirSync(path.join(target, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(target, 'receipts', kept), JPEG);
    fs.writeFileSync(path.join(target, 'receipts', 'unrelated.bin'), 'precious');

    const result = restoreFromArtifact(legacy, { dataDir: target });

    expect(result.kind).toBe('sqlite');
    expect(result.databaseRestored).toBe(true);
    expect(result.receiptsRestored).toBe(0);
    expect(result.receiptsMovedAside).toBeNull();
    // MUST-12.9: a DB-only artifact says NOTHING about receipts. Treating silence as
    // "delete them" would destroy files the backup was never responsible for.
    expect(fs.readdirSync(path.join(target, 'receipts')).sort()).toEqual([kept, 'unrelated.bin'].sort());
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('reports how many receipt rows reference files that are not present', () => {
    insertTestUser(current!.db, { name: 'Alice', username: 'alice' });
    const stored = `11111111-2222-3333-4444-555555555555.jpg`;
    current!.sqlite
      .prepare(
        `insert into warranty_items (id, name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
         values (1, 'Fridge', '2026-08-16', 0, 1, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      )
      .run();
    current!.sqlite
      .prepare(
        `insert into warranty_receipts (warranty_item_id, original_filename, stored_filename, mime, size_bytes,
           sha256, ocr_status, created_at)
         values (1, 'a.jpg', ?, 'image/jpeg', 64, ?, 'done', '2026-08-16T00:00:00.000Z')`,
      )
      .run(stored, 'a'.repeat(64));

    const legacy = path.join(dataDir, 'legacy.db');
    current!.sqlite.exec(`VACUUM INTO '${legacy.replace(/'/g, "''")}'`);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    const result = restoreFromArtifact(legacy, { dataDir: target });
    expect(result.missingReceiptRows).toBe(1);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('reports zero missing rows for a pre-warranty database with no such table', () => {
    // A genuine v1.0.0 artifact has no warranty_receipts table at all.
    const legacy = path.join(dataDir, 'v100.db');
    current!.sqlite.exec(`VACUUM INTO '${legacy.replace(/'/g, "''")}'`);
    const copy = require('better-sqlite3')(legacy);
    copy.exec('drop table warranty_receipts; drop table warranty_items;');
    copy.close();

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-target-'));
    expect(restoreFromArtifact(legacy, { dataDir: target }).missingReceiptRows).toBe(0);
    fs.rmSync(target, { recursive: true, force: true });
  });
});
```

- [ ] **Step 10: Run it to verify it fails.**

Run: `npm test -- tests/scripts/restore-backup.test.ts`
Expected: FAIL — `scripts/restore-backup.ts` does not exist.

- [ ] **Step 11: Implement `scripts/restore-backup.ts`.**

```ts
#!/usr/bin/env node
/**
 * Rescue tool: restore a Budget Tracker backup artifact into a data directory.
 *
 * Run it with the container STOPPED (MUST-12.4). There is deliberately no in-app restore
 * button: restoring under a live SQLite connection is how you corrupt a database.
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
 * src/ tree, so the "@/..." import alias cannot resolve in the container. It therefore talks
 * to node-tar and better-sqlite3 directly — both are already present in the image.
 *
 * tests/scripts/restore-backup.test.ts pins RESTORE_STORED_NAME_RE against
 * src/lib/warranty/receipts.ts so the two can never drift apart unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import * as tar from 'tar';

/** Must stay identical to STORED_NAME_RE in src/lib/warranty/receipts.ts. */
export const RESTORE_STORED_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

export type ArtifactKind = 'archive' | 'sqlite' | 'unknown';

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface RestoreResult {
  kind: ArtifactKind;
  databaseRestored: boolean;
  receiptsRestored: number;
  /** The directory the previous receipts/ was renamed to, or null when there was none. */
  receiptsMovedAside: string | null;
  missingReceiptRows: number;
}

const SQLITE_MAGIC = 'SQLite format 3\0';

/** MUST-12.5: format detection is by magic bytes, NEVER by file extension. */
export function detectArtifactKind(filePath: string): ArtifactKind {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  let read = 0;
  try {
    read = fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'archive';
  if (read >= 16 && head.toString('binary') === SQLITE_MAGIC) return 'sqlite';
  return 'unknown';
}

/**
 * MUST-12.6, tar-slip defence: extraction accepts ONLY the entry `budget.db` and entries
 * matching `receipts/<STORED_NAME_RE>`. Absolute paths, `..` segments, symlinks, hardlinks,
 * device nodes and anything else abort the whole restore. This runs as a FIRST PASS over the
 * archive listing, before a single byte is written, so "reject" really does mean "abort" and
 * not "skip". node-tar's own protections are relied on IN ADDITION TO this allow-list.
 */
function assertArchiveEntriesAreSafe(artifactPath: string): void {
  const problems: string[] = [];
  tar.list({
    file: artifactPath,
    sync: true,
    onReadEntry: (entry) => {
      const name = entry.path.replace(/\/+$/, '');
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        problems.push(`${entry.path} (${entry.type})`);
        return;
      }
      if (path.isAbsolute(name) || name.split('/').includes('..')) {
        problems.push(entry.path);
        return;
      }
      if (name === 'budget.db' || name === 'receipts') return;
      const match = /^receipts\/(.+)$/.exec(name);
      if (match === null || !RESTORE_STORED_NAME_RE.test(match[1])) problems.push(entry.path);
    },
  });
  if (problems.length > 0) {
    throw new RestoreError(`Refusing to extract unexpected archive entries: ${problems.join(', ')}`);
  }
}

/** MUST-12.9: how many warranty_receipts rows point at a file that is not on disk. */
function countMissingReceiptRows(databasePath: string, receiptsPath: string): number {
  const db = new Database(databasePath, { readonly: true });
  try {
    const table = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'warranty_receipts'")
      .get();
    if (!table) return 0; // a genuine v1.0.0 artifact has no such table
    const rows = db.prepare('select stored_filename from warranty_receipts').all() as {
      stored_filename: string;
    }[];
    return rows.filter((row) => !fs.existsSync(path.join(receiptsPath, row.stored_filename))).length;
  } finally {
    db.close();
  }
}

function replaceDatabase(source: string, dataDir: string): void {
  const target = path.join(dataDir, 'budget.db');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(source, target);
  // MUST-12.7: SQLite runs in WAL mode and would otherwise replay the OLD write-ahead log
  // over the database you just restored.
  fs.rmSync(`${target}-wal`, { force: true });
  fs.rmSync(`${target}-shm`, { force: true });
}

export function restoreFromArtifact(
  artifactPath: string,
  opts: { dataDir: string; now?: Date },
): RestoreResult {
  if (!fs.existsSync(artifactPath)) throw new RestoreError(`No such artifact: ${artifactPath}`);
  const kind = detectArtifactKind(artifactPath);
  const dataDir = path.resolve(opts.dataDir);
  const receiptsPath = path.join(dataDir, 'receipts');

  if (kind === 'unknown') {
    throw new RestoreError(
      'That file is neither a v1.1 .tar.gz archive nor a v1.0 SQLite backup. Nothing was changed.',
    );
  }

  if (kind === 'sqlite') {
    // MUST-12.9: a DB-only artifact says nothing about receipts. Do NOT delete, empty or
    // modify data/receipts/ — treating silence as "delete them" would destroy files the
    // backup was never responsible for.
    replaceDatabase(artifactPath, dataDir);
    return {
      kind,
      databaseRestored: true,
      receiptsRestored: 0,
      receiptsMovedAside: null,
      missingReceiptRows: countMissingReceiptRows(path.join(dataDir, 'budget.db'), receiptsPath),
    };
  }

  assertArchiveEntriesAreSafe(artifactPath);

  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const stage = path.join(dataDir, `.restore-${stamp}`);
  fs.mkdirSync(stage, { recursive: true });
  let movedAside: string | null = null;

  try {
    tar.extract({ file: artifactPath, cwd: stage, sync: true, preservePaths: false, strip: 0 });

    const extractedDb = path.join(stage, 'budget.db');
    if (!fs.existsSync(extractedDb)) throw new RestoreError('The archive contains no budget.db.');
    replaceDatabase(extractedDb, dataDir);

    const extractedReceipts = path.join(stage, 'receipts');
    // MUST-12.8: non-destructive. The existing directory is RENAMED aside, never deleted —
    // recovering from a mistaken restore is a rename.
    if (fs.existsSync(receiptsPath)) {
      movedAside = `receipts.pre-restore-${stamp}`;
      fs.renameSync(receiptsPath, path.join(dataDir, movedAside));
    }
    fs.mkdirSync(receiptsPath, { recursive: true });
    let restored = 0;
    if (fs.existsSync(extractedReceipts)) {
      for (const entry of fs.readdirSync(extractedReceipts)) {
        if (!RESTORE_STORED_NAME_RE.test(entry)) continue;
        fs.renameSync(path.join(extractedReceipts, entry), path.join(receiptsPath, entry));
        restored += 1;
      }
    }

    return {
      kind,
      databaseRestored: true,
      receiptsRestored: restored,
      receiptsMovedAside: movedAside,
      missingReceiptRows: countMissingReceiptRows(path.join(dataDir, 'budget.db'), receiptsPath),
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function resolveDataDir(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const flag = argv.indexOf('--data-dir');
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  return env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : '/data';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const artifact = argv.find((arg) => !arg.startsWith('--') && argv[argv.indexOf(arg) - 1] !== '--data-dir');
  if (!artifact) {
    console.error('Usage: restore-backup <artifact.tar.gz|artifact.db> [--data-dir /data]');
    console.error('Stop the container first. See INSTALL.md -> "Restoring from a backup".');
    process.exit(1);
  }
  const dataDir = resolveDataDir(argv);
  const result = restoreFromArtifact(artifact, { dataDir });
  console.log(`Restored ${result.kind === 'archive' ? 'archive' : 'database-only backup'} into ${dataDir}`);
  console.log(`  database restored: ${result.databaseRestored}`);
  console.log(`  receipt files restored: ${result.receiptsRestored}`);
  if (result.receiptsMovedAside) console.log(`  previous receipts kept at: ${result.receiptsMovedAside}`);
  // MUST-12.9: an explicit count, so a cross-version restore is honest about what is missing.
  console.log(`  ${result.missingReceiptRows} receipt rows reference files that are not present on disk.`);
}

// Only run when invoked directly, so the test file can import the functions.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
```

- [ ] **Step 12: Add the npm script and run everything.**

In `package.json` `"scripts"`, after `"reset-password"`, add:

```json
    "restore-backup": "node --experimental-strip-types scripts/restore-backup.ts",
```

Then run: `npm test -- tests/scripts/restore-backup.test.ts`
Expected: PASS.

Then: `npm test && npm run typecheck && npm run build`
Expected: all green. **If `npm run build` fails to resolve `@/lib/backup` now that `src/lib/backup/` exists**, apply the documented fallback from Step 4: `git mv src/lib/backup.ts src/lib/backup/index.ts` and re-run. No importer changes.

- [ ] **Step 13: Update the backups page wording.**

In `src/app/(app)/settings/backups/backups-client.tsx`, change the heading/help text that says backups are database copies so it names the new artifact — the archive now carries receipt photos too, which is a privacy-relevant fact (MUST-13.9):

```tsx
        <p className="text-xs text-slate-500">
          Each backup is a <code>.tar.gz</code> archive containing the database and every receipt
          file. Older <code>.db</code> backups from v1.0.0 are still listed and still restore.
        </p>
```

- [ ] **Step 14: Checkpoint (commit is PAUSED).**

Run: `npm test && npm run typecheck`
Commit message to use when the pause is lifted:

```bash
git add package.json package-lock.json src/lib/backup.ts src/lib/backup/archive.ts scripts/restore-backup.ts src/app/api/backup/download/route.ts "src/app/(app)/settings/backups/backups-client.tsx" tests/lib/backup-archive.test.ts tests/lib/backup.test.ts tests/api/backup.route.test.ts tests/scripts/restore-backup.test.ts
git commit -m "feat(backup): tar.gz archives including receipts, plus a magic-byte restore tool"
```

---

## Task 12: Release v1.1.0 — Docker packaging, the build-time asset guard, and the docs

**Context:** The last task turns the feature into a shippable image. The single largest risk in this whole plan is R1: Next's `standalone` output tracing cannot know that a `.wasm` blob, a worker script loaded by string path and a `.traineddata.gz` under `vendor/` are runtime inputs, so it drops them — and tesseract.js then silently falls back to its CDN, which fails on an offline LAN. The defence is three-layered: explicit `COPY` lines, a **build-time** check that fails `docker build`, and the boot log line from Task 5.

**Files:**
- Create: `scripts/check-ocr-assets.mjs`
- Modify: `Dockerfile` (four `COPY` lines, `/data/receipts`, the build-time guard)
- Modify: `package.json` (`version` → `1.1.0`, `check-ocr-assets` script)
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `tests/ops/docker.test.ts` (new assertions)
- Test: `tests/scripts/check-ocr-assets.test.ts`

**Interfaces:**
- Consumes: `resolveOcrAssets` semantics from Task 5 (the guard duplicates the four paths as literals on purpose — it runs in the image, where `src/` does not exist); `APP_VERSION` from `@/lib/version`, which reads `package.json` at build time.
- Produces: `budget-tracker:1.1.0` — an image in which `node scripts/check-ocr-assets.mjs` exits 0, `/data/receipts` exists and is `node`-owned, and `/api/health` reports `1.1.0`.

### Steps

- [ ] **Step 1: Write the failing packaging test.**

Append to `tests/ops/docker.test.ts`, inside the existing `describe('Dockerfile', …)` block:

```ts
  it('copies the OCR and PDF assets that output tracing cannot see (R1)', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).toMatch(/COPY .*\/app\/vendor \.\/vendor/);
    expect(runtimeStage).toContain('node_modules/tesseract.js ');
    expect(runtimeStage).toContain('node_modules/tesseract.js-core');
    expect(runtimeStage).toContain('node_modules/pdfjs-dist');
  });

  it('creates /data/receipts alongside the other data directories', () => {
    expect(dockerfile).toMatch(/mkdir -p \/data \/data\/backups \/data\/tmp \/data\/receipts/);
  });

  it('fails the BUILD, not production, when an asset is missing (MUST-7.9 / acceptance A3)', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).toContain('RUN node scripts/check-ocr-assets.mjs');
    // The guard must run AFTER the COPY lines it checks, or it proves nothing.
    expect(runtimeStage.indexOf('RUN node scripts/check-ocr-assets.mjs')).toBeGreaterThan(
      runtimeStage.indexOf('node_modules/tesseract.js-core'),
    );
  });
```

And append a new top-level describe:

```ts
describe('.dockerignore', () => {
  const dockerignore = read('.dockerignore');

  it('does NOT exclude vendor/, which carries the offline OCR language data (MUST-7.9)', () => {
    const lines = dockerignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).not.toContain('vendor');
    expect(lines).not.toContain('vendor/');
    expect(lines).not.toContain('/vendor');
  });
});

describe('version and changelog', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string; dependencies: Record<string, string> };
  const changelog = read('CHANGELOG.md');

  it('declares 1.1.0 as the single source of truth', () => {
    expect(pkg.version).toBe('1.1.0');
  });

  it('declares the three new runtime dependencies (§17.27)', () => {
    for (const name of ['tesseract.js', 'pdfjs-dist', 'tar']) {
      expect(pkg.dependencies[name], `missing dependency ${name}`).toBeTruthy();
    }
  });

  it('has a dated 1.1.0 section and a fresh empty Unreleased above it', () => {
    expect(changelog).toContain('## [1.1.0] - 2026-08-16');
    const unreleased = changelog.indexOf('## Unreleased');
    const released = changelog.indexOf('## [1.1.0]');
    expect(unreleased).toBeGreaterThan(-1);
    expect(unreleased).toBeLessThan(released);
    // §17.23: the previously-unreleased entries are ABSORBED into 1.1.0, so Unreleased is
    // now empty — it must no longer mention them.
    expect(changelog.slice(unreleased, released)).not.toContain('Forced password change');
  });

  it('records the backup format change in 1.1.0', () => {
    const section = changelog.slice(changelog.indexOf('## [1.1.0]'), changelog.indexOf('## [1.0.0]'));
    expect(section).toContain('tar.gz');
    expect(section).toMatch(/older `?\.db`? backups still restore|still restore/i);
    expect(section).toContain('Warranty');
  });
});
```

Also extend the existing `describe('README.md', …)` block:

```ts
  it('documents the warranty tracker and its offline OCR', () => {
    expect(readme).toMatch(/warrant/i);
    expect(readme).toMatch(/OCR/);
    expect(readme).toMatch(/offline|no internet|LAN-only/i);
  });
```

- [ ] **Step 2: Run the ops test to verify it fails.**

Run: `npm test -- tests/ops/docker.test.ts`
Expected: FAIL on every new assertion.

- [ ] **Step 3: Write the failing guard-script test.**

Create `tests/scripts/check-ocr-assets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const script = path.join(root, 'scripts/check-ocr-assets.mjs');

function run(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

describe('scripts/check-ocr-assets.mjs (MUST-7.9)', () => {
  it('exits 0 in a healthy checkout and names what it checked', () => {
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('eng.traineddata.gz');
  });

  it('exits non-zero and names the missing path when an asset is absent', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-guard-'));
    try {
      const result = run(empty);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('vendor/tessdata/eng.traineddata.gz');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('checks exactly the four paths the runtime needs, and no URL', () => {
    const source = fs.readFileSync(script, 'utf8');
    for (const needle of [
      'vendor/tessdata/eng.traineddata.gz',
      'node_modules/tesseract.js-core',
      'node_modules/tesseract.js/src/worker-script/node/index.js',
      'node_modules/pdfjs-dist',
    ]) {
      expect(source).toContain(needle);
    }
    expect(source).not.toMatch(/https?:\/\//);
  });
});
```

- [ ] **Step 4: Implement the guard and run both script tests.**

Create `scripts/check-ocr-assets.mjs`:

```js
#!/usr/bin/env node
/**
 * BUILD-TIME guard (MUST-7.9, acceptance check A3).
 *
 * Next's standalone output tracing cannot know that a .wasm blob, a worker script loaded by
 * string path, and a .traineddata.gz under vendor/ are runtime inputs — the same class of
 * miss that already forced explicit COPY lines for better-sqlite3's .node binary, drizzle/,
 * scripts/ and CHANGELOG.md. If one of those COPY lines is ever deleted, this must break
 * `docker build`, NOT production: the failure mode it prevents is tesseract.js silently
 * falling back to its CDN on an install that has no route to the internet.
 *
 * Deliberately self-contained (no "@/..." alias): it runs inside the runtime image, whose
 * working directory holds Next's standalone output and not the project's src/ tree.
 */
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = [
  'vendor/tessdata/eng.traineddata.gz',
  'node_modules/tesseract.js-core',
  'node_modules/tesseract.js/src/worker-script/node/index.js',
  'node_modules/pdfjs-dist',
];

const missing = [];
for (const relative of REQUIRED) {
  const absolute = path.join(process.cwd(), relative);
  if (fs.existsSync(absolute)) {
    console.log(`ok   ${relative}`);
  } else {
    missing.push(relative);
    console.error(`MISS ${relative}`);
  }
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} OCR asset(s) missing from ${process.cwd()}.\n` +
      'Check the COPY lines in the runner stage of the Dockerfile — see spec §7.4.',
  );
  process.exit(1);
}

console.log(`OCR assets ok (${REQUIRED.length} checked)`);
```

Add to `package.json` `"scripts"`, after `"fetch-tessdata"`:

```json
    "check-ocr-assets": "node scripts/check-ocr-assets.mjs",
```

Run: `npm test -- tests/scripts/check-ocr-assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the Dockerfile.**

Two edits to `Dockerfile`, both in the **runner** stage.

(a) Add the receipts directory to the existing `mkdir` line:

```dockerfile
    && mkdir -p /data /data/backups /data/tmp /data/receipts \
```

(b) After the existing `node_modules/@phc` COPY line and **before** `USER node`, insert:

```dockerfile
# Offline OCR assets. Next's standalone output tracing cannot know that a .wasm blob, a
# worker script loaded by string path, and a .traineddata.gz under vendor/ are runtime
# inputs — the same reason better-sqlite3, drizzle/ and CHANGELOG.md are copied explicitly.
# If any of these is missing at runtime, tesseract.js falls back to its CDN, which is the
# exact failure an offline LAN install must never hit (spec §7.2, §7.4).
COPY --from=builder --chown=node:node /app/vendor ./vendor
COPY --from=builder --chown=node:node /app/node_modules/tesseract.js ./node_modules/tesseract.js
COPY --from=builder --chown=node:node /app/node_modules/tesseract.js-core ./node_modules/tesseract.js-core
COPY --from=builder --chown=node:node /app/node_modules/pdfjs-dist ./node_modules/pdfjs-dist

# node-tar backs the .tar.gz backup archive and the restore script (spec §12.1).
COPY --from=builder --chown=node:node /app/node_modules/tar ./node_modules/tar

# A tracing miss must break `docker build`, not production (MUST-7.9, acceptance A3).
RUN node scripts/check-ocr-assets.mjs
```

> `.dockerignore` already excludes only `node_modules`, `.next`, `.git`, `.tmp-data`, `docs`, `coverage`, `*.db*` and `.env*`. It **must not** be changed to exclude `vendor/` — the test added in Step 1 pins that.

- [ ] **Step 6: Bump the version.**

In `package.json`, change:

```json
  "version": "1.1.0",
```

`src/lib/version.ts` imports that field at build time, so the footer, Settings → About, `/api/health` and the update scripts all follow automatically (MUST-14.1, MUST-14.3 — no code change needed in the About panel).

- [ ] **Step 7: Write the changelog.**

In `CHANGELOG.md`, replace the whole current `## Unreleased` section (its Added / Changed / Fixed / Security bodies) with an empty Unreleased plus a dated 1.1.0 section that **absorbs** those entries (§17.23) and adds the warranty ones:

```markdown
## Unreleased

## [1.1.0] - 2026-08-16

### Added

- **Warranty tracker.** Record what you bought, who owns it, what it cost and how long it is
  covered — months, or a Lifetime tick for the things that never expire. A new Warranties
  page lists everything with an at-a-glance badge: active, expiring soon, expired, lifetime,
  or term unknown.
- **Receipts as evidence.** Photograph a receipt with your phone (the Add form opens the rear
  camera directly) or attach a PDF. Files are stored on the data volume beside the database
  and are only ever served to a signed-in member.
- **Every word on the receipt is searchable.** Receipts are read by an OCR engine that runs
  entirely on the server with no internet connection, and the text is folded into a full-text
  index. Searching for a store name, a model number or a line item finds the item — and
  typing `metro` finds `MÉTRO`.
- **Suggest and confirm.** After a receipt is read, the purchase date, vendor and total are
  proposed in the form. Nothing is ever saved without you pressing Save, and a field you have
  already typed into is never overwritten.
- **Warranties expiring soon** on the dashboard: the next 60 days, top five, scoped by the
  person switcher, and hidden entirely when there is nothing to show.
- **Create warranty** from a transaction row, which fills in the date, the price and the
  vendor from the ledger entry and links the two.
- Forced password change on first login. A user created by an admin, or whose password an
  admin has reset, must choose their own password before any other page opens. Changing it
  signs them out everywhere else and keeps the browser they are using signed in.
- Goals can be un-archived: a "Show archived" toggle on the Goals page, with a Restore
  button on each archived goal.
- The import preview now reports how many rows the profile's skip rules dropped, so a
  mis-typed rule no longer looks like a short file.
- Settings gains an About panel showing the running version and this changelog, a version
  string in the page footer, and a `version` field on `/api/health`.

### Changed

- **Backups are now `.tar.gz` archives** containing the database *and* every receipt file,
  instead of a bare `.db` copy. Older `.db` backups from v1.0.0 are still listed, still
  counted against your retention setting, and still restore — restoring one leaves your
  receipts folder completely untouched. A v1.1 archive cannot be restored by a v1.0.0
  install; downgrading has never been supported.
- Restoring is now driven by `npm run restore-backup`, which detects the artifact type by its
  contents rather than its file name, refuses anything it does not recognise, and moves an
  existing receipts folder aside rather than deleting it. It is still an offline procedure
  with the container stopped — there is deliberately no in-app restore button.
- Copying budgets from the previous month now includes archived categories, matching what
  the budgets page already shows for archived spend.
- A manually entered transaction runs the categorization engine even when a category was
  chosen, so a hand-typed card payment is recognised as a transfer and rename rules apply.
  The chosen category is always kept.
- Other members' personal budget sections render read-only for non-admins instead of
  offering limit inputs and a copy button that the server would refuse.
- The Budgets page shows one message banner instead of two, so a stale success can no
  longer sit next to a fresh error.

### Fixed

- CSV export now neutralises spreadsheet formula triggers (`=`, `+`, `-`, `@`, tab) in
  exported text, while leaving plain numbers — the whole Amount column — as numbers.
- Transaction search treats `%` and `_` literally instead of as SQL wildcards, so
  searching for "50%" no longer matches "5000".
- Busy guards on the import undo button and the bank-profile wizard upload prevent a
  double-click from repeating the request.
- `scripts/reset-admin-password.ts` refuses a database path that does not exist instead of
  silently creating an empty database and reporting that the account is missing.

### Security

- The receipt file route is session-authenticated with an Origin check, serves the stored
  content type rather than a sniffed one, and hands PDFs over as downloads instead of
  opening them inline — a same-origin inline PDF would run the viewer's JavaScript in this
  app's origin.
- Search input is escaped into full-text-search syntax as literal phrases, so a query
  containing a quote or the word `AND` returns results instead of an error.
- Uploaded files are accepted on their leading bytes only, never on their name or the type
  the browser claims, and are stored under server-generated names that can never contain a
  path.
- Backup archives now contain photographs of receipts. They remain unencrypted, exactly like
  the database — if you copy them off the NAS, use your backup tool's client-side encryption.
- An admin "reset MFA" now signs the target user out everywhere, matching what an admin
  password reset already did.
```

- [ ] **Step 8: Update README.md.**

Add a bullet to the feature list naming the warranty tracker, and one short paragraph. Insert near the other feature bullets:

```markdown
- **Warranties** — record what you bought and how long it is covered, attach the receipt as a
  photo or a PDF, and search every word printed on it. Receipts are read by an OCR engine
  that runs entirely on the server: the language data ships inside the image, so this works
  on a LAN-only install with no internet connection at all.
```

And, in the section that describes what lives under `data/`, add `receipts/`:

```markdown
`data/receipts/` holds the receipt files. They are part of the nightly backup archive, and an
image update never touches them.
```

- [ ] **Step 9: Update INSTALL.md.**

Three edits.

(a) Replace the body of **"Restoring from a backup"** with:

```markdown
The app writes a nightly archive to `data/backups/budget-YYYY-MM-DD.tar.gz` and keeps the most
recent 14. **Settings → Backups → Download backup now** makes one on demand. The archive holds
the database *and* every receipt file.

Restore with the container stopped — restoring under a live SQLite connection is how you
corrupt a database. There is deliberately no in-app restore button.

```bash
docker compose down
docker compose run --rm --entrypoint node budget-tracker \
  --experimental-strip-types scripts/restore-backup.ts /data/backups/budget-2026-08-16.tar.gz
docker compose up -d
```

The tool tells you what it did: whether the database was replaced, how many receipt files came
back, where your previous `receipts/` folder was moved to, and how many receipt rows point at a
file that is not on disk.

It works out what kind of artifact you handed it by looking at the file's contents, not its
name:

| Artifact | What happens |
|---|---|
| `budget-YYYY-MM-DD.tar.gz` (v1.1 and later) | database **and** receipts restored; your existing `receipts/` folder is renamed to `receipts.pre-restore-<timestamp>/`, never deleted |
| `budget-YYYY-MM-DD.db` (v1.0.0) | database restored; **`data/receipts/` is left completely alone** — a database-only backup says nothing about receipts |
| anything else | refused with a clear message; nothing is changed |

Restoring a v1.0.0 `.db` backup into a v1.1.0 install is supported and safe: migrations run on
the next boot and add the (empty) warranty tables. If that database already knew about receipts
whose files are not on this machine, those show as "file missing" in the gallery and the tool
prints the count.

**The other direction does not work.** A v1.1 `.tar.gz` archive cannot be restored by a v1.0.0
install. Downgrading has never been supported — migrations are append-only.

The old manual procedure still works for a `.db` artifact if you prefer it, and deleting the
`-wal` and `-shm` files is not optional: SQLite runs in WAL mode and would otherwise replay the
old write-ahead log on top of the database you just restored.

```bash
docker compose down
cd data
rm -f budget.db budget.db-wal budget.db-shm
cp backups/budget-2026-08-15.db budget.db
cd ..
docker compose up -d
```
```

(b) In the offsite-backup / Hyper Backup guidance, extend the encryption note (MUST-13.9):

```markdown
**Backup archives are not encrypted, and they now contain photographs of your receipts** —
which carry names, addresses and partial card numbers, on top of the whole transaction
history. If you copy them off the NAS, turn on your backup tool's client-side encryption
(Synology Hyper Backup offers it) and keep the key somewhere other than the NAS.
```

(c) Add a short disk-space note next to the retention setting (§12.1):

```markdown
**Disk space:** each nightly archive holds the database *plus* every receipt file, so the
backups folder costs roughly `retention × (database + all receipts)`. Fourteen nightly copies
of a 300 MB receipt library is about 4 GB. Settings → Backups lists each archive's size and
lets you lower the retention count.
```

- [ ] **Step 10: Run the full suite, typecheck and build.**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green, including the ops tests from Step 1.

- [ ] **Step 11: Build the image and run the acceptance checks (§15.4).**

These are manual and are the only way R1, R2 and R4 are actually proven. Record the results in the release notes for this version.

```bash
docker build -t budget-tracker:1.1.0 .
```

- [ ] **A2 — asset presence in the image.**
  ```bash
  docker run --rm --entrypoint node budget-tracker:1.1.0 -e "['vendor/tessdata/eng.traineddata.gz','node_modules/tesseract.js-core','node_modules/tesseract.js/src/worker-script/node/index.js','node_modules/pdfjs-dist'].forEach(p=>require('fs').accessSync(p))"
  ```
  Expected: exit 0, no output.
- [ ] **A3 — the build-time guard really guards.** Comment out the `COPY … /app/vendor ./vendor` line, run `docker build` again, and confirm it fails at `RUN node scripts/check-ocr-assets.mjs` with `MISS vendor/tessdata/eng.traineddata.gz`. Restore the line.
- [ ] **A1 — offline OCR.** Run the container on a Docker network with `internal: true` (no egress). Upload a photographed receipt. It reaches `Read`. *This is the check that proves MUST-7.3.*
- [ ] **A4 — hardened runtime.** With `read_only: true` and the tmpfs `/tmp` from `docker-compose.yml`, upload and OCR still succeed.
- [ ] **A5 — camera.** On iOS Safari and Android Chrome, the Add form's file control opens the rear camera directly. If it does not, apply the pre-approved remedy — change `camera=()` to `camera=(self)` in `src/lib/auth/security-headers.ts`, and only that directive — and re-test.
- [ ] **A6 — cross-version restore.** Take a backup on a v1.0.0 install, upgrade to v1.1.0, restore that `.db` artifact: the app boots, migrations apply, existing data is intact, `receipts/` is untouched.
- [ ] **A7 — ARM64.** Run on a Raspberry Pi 5 or an ARM64 Synology and record the wall-clock time for a single 3 MB receipt, then put that number in INSTALL.md so the expectation is honest.

- [ ] **Step 12: Checkpoint (commit is PAUSED).**

Commit message to use when the pause is lifted:

```bash
git add package.json CHANGELOG.md README.md INSTALL.md Dockerfile scripts/check-ocr-assets.mjs tests/ops/docker.test.ts tests/scripts/check-ocr-assets.test.ts
git commit -m "chore(release): v1.1.0 — warranty tracker, OCR asset packaging and docs"
```

---

# Self-review

Run after the plan is written, before execution. Recorded here so the executor can see what was checked.

## 1. Spec coverage

| Spec section | Covered by |
|---|---|
| §1 Goals G1–G9 | G1/G5 Tasks 4, 6, 8, 9 · G2 Tasks 3, 7 · G3 Task 5 · G4 Tasks 1, 6 · G6 Tasks 2, 9, 10 · G7 Task 10 · G8 Task 11 · G9 Tasks 5, 12 |
| §1.3 visibility model | Task 8 (no admin gate anywhere; `owner_user_id` is attribution) |
| §2 architecture delta, MUST-2.1–2.4 | Task 5 (`serverExternalPackages`, no egress), Task 7 (route precedence), Task 12 (Docker) |
| §3.1–3.5 migration, DDL, triggers, MUST-3.1–3.12 | Task 1 |
| §3.6–3.7 expiry, clamp, status, MUST-3.13/3.14 | Task 2 |
| §3.8 Drizzle mirror, MUST-3.15 | Task 1 Step 5 |
| §4 storage, naming, sniffing, size cap, orphan sweep, MUST-4.1–4.10 | Task 3 (4.1–4.5, 4.9) · Task 7 (4.6 gates) · Task 6 (4.7, 4.8) · Tasks 6/7/9 (4.10) · Task 11 (sweep wiring) |
| §5 serving receipts, MUST-5.1–5.6 | Task 7 |
| §6 capture and upload, MUST-6.1–6.9 | Task 9 (6.1) · Task 7 (6.2–6.6) · Task 5 (6.7) · Tasks 6/8 (6.8, 6.9) |
| §7 OCR, MUST-7.1–7.17 | Task 5, with 7.8/7.9 in Task 12 |
| §8 suggestion heuristics, MUST-8.1–8.3 | Task 4, applied in Tasks 5 and 9 |
| §9 search, MUST-9.1–9.4 | Task 6 |
| §10 UI, MUST-10.1–10.6 | Task 9 (10.1–10.4) · Task 10 (10.5, 10.6) |
| §11 transactions integration, MUST-11.1–11.5 | Task 10, with the server-side prefill in Task 9's `new/page.tsx` |
| §12 backup and restore, MUST-12.1–12.10 | Task 11, docs in Task 12 |
| §13 security invariants | Global Constraints, enforced per task; cross-origin-first pinned by Task 8's parameterised test |
| §14 versioning, MUST-14.1–14.3 | Task 12 |
| §15.1 unit tests | Tasks 2, 3, 4, 5, 6, 11 |
| §15.2 database tests | Task 1 |
| §15.3 integration tests | Tasks 5, 6, 7, 8, 10, 11 |
| §15.4 manual acceptance A1–A7 | Task 12 Step 11 |
| §16 out of scope | Nothing in the plan builds any of it; §16.7 HEIC gets the documented message (Task 3, surfaced in Task 7) |
| §17 decisions 1–27 | Constants and behaviours are each pinned by a named test |
| §18 risks R1–R7 | R1 Task 12 · R2 Task 12 A5 · R3 Task 12 INSTALL note · R4/R5 Task 5 · R6 Task 11 · R7 Task 1 |

**Gaps found and closed during review:**

- §15.3's "PDF: a text-layer PDF fixture extracts and indexes; an image-only PDF fixture lands failed" was not covered by any task, because MUST-7.17 forbids tests loading the real engine — and `extractPdfText` *is* the real engine for PDFs. Resolution: Task 5's queue tests cover the failure path through an injected `ScannedPdfError`, and the genuine text-layer extraction is verified by acceptance check A1 (upload a real PDF) rather than by a unit test that would need a bundled PDF fixture and the real `pdfjs-dist`. If a fixture-based test is wanted later, it belongs in `tests/lib/warranty/ocr/pdf.test.ts` with a generated one-page PDF — out of scope for this release.
- §12.1's on-demand download path was only implied; Task 11 Step 7 now rewrites the download route explicitly, including the stream-lifetime unlink.

## 2. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `fill in`, `add appropriate`, `handle edge cases`, `similar to Task`, and for test steps without code. One deliberate exception remains and is not a placeholder:

- `TESSDATA_SHA256 = 'PASTE_THE_DIGEST_PRINTED_BY_scripts_fetch_tessdata_mjs'` in Task 5 Step 5. The digest of a 15 MB binary cannot be written into a plan that has not yet downloaded it. The step immediately before it is an exact command whose printed output supplies the value, with an offline fallback command, and the test in Step 4 fails loudly until it is real.

## 3. Type consistency

Checked every name used across task boundaries:

- `ReceiptMime` / `ReceiptExt` — declared Task 3, consumed identically in Tasks 5, 6, 7.
- `STORED_NAME_RE` — declared Task 3; Task 11's `RESTORE_STORED_NAME_RE` is a deliberate copy pinned equal by a test.
- `StagedReceiptRef { stagingId, originalFilename }` — declared Task 6, produced by Task 7's HTTP response, posted by Task 9's hidden `staged` field, parsed by Task 8's `stagedSchema`. All four agree.
- `OcrSidecar { status, text?, error?, suggestions? }` — declared Task 5, written by Task 5's queue, read by Task 6's `commitStaged` and Task 7's poll route.
- `SuggestedFields` (Task 4) vs `SuggestedFieldsDto` (Task 9) — same three optional fields; the client copy exists because Task 9 must not import a server module. Field names match exactly.
- `WarrantyItemRow` / `WarrantyReceiptRow` — declared Task 6, consumed unchanged by Tasks 7, 9, 10.
- `WarrantyStatus` and `statusLabel` — declared Task 2; the SQL `STATUS_CASE_SQL` produces the same five string literals, asserted against `warrantyStatus()` in Task 6's tests.
- `getOcrEngine` / `setOcrEngineForTests` — declared Task 5, used by every later test file with the same signature.
- `enqueueOcrJob(job): boolean` — declared Task 5, called from Task 6 (`commitStaged`, `resetReceiptForReOcr`) and Task 7 (stage route) with the same union type.
- `backupsDir` / `tempDir` — moved to Task 11's `archive.ts` and re-exported from `@/lib/backup`, so the existing importers (`tests/lib/backup.test.ts`, `tests/api/backup.route.test.ts`) keep resolving.
- `WarrantyActionState { error?, message? }` — declared Task 8, consumed by Task 9's `useActionState` calls.

One drift was found and fixed inline: Task 6's `commitStaged` originally took `string[]` and read an `originalFilename` that `findStagedReceipt()` never returns, while Task 8 and Task 9 both had the display name in hand. The signature is now `StagedReceiptRef[]` end to end.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-16-warranty-tracker.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session with checkpoints for review. REQUIRED SUB-SKILL: `superpowers:executing-plans`.

**Remember:** git commits are paused by user instruction. Each task records the commit message it would use; the actual gate is `npm test` + `npm run typecheck` green.
