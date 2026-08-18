# Warranty Tracker — Design Spec

**Date:** 2026-08-16
**Status:** v1.1 — approved design (owner-locked decisions captured; §17 lists the defaults chosen on the owner's behalf for review). §19 is the mid-build addendum for warranty item types and subscriptions; §1–§18 are unchanged and their numbering is stable because the implementation plan cites it.
**Target release:** Budget Tracker **v1.1.0** (feature addition to the shipped v1.0.0 app).
**Companion spec:** `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (the base app). That document is **not** modified by this feature; section references written as "base §N" point into it.

---

## 1. Overview

Track the warranties on things the household buys, with the receipt itself as the evidence, and make every word printed on that receipt searchable. A member photographs a receipt with their phone, the server OCRs it in the background, the app proposes purchase date / vendor / total from the OCR text, the member confirms, and the item lands in a list that says at a glance what is still covered and what expires soon.

### 1.1 Goals

- **G1.** Record a purchased item's warranty: name, vendor, model, serial, purchase date, warranty length (months or lifetime), price, notes, owner.
- **G2.** Attach one or more receipt files (phone photo or PDF) per item, stored on the existing data volume.
- **G3.** OCR every uploaded receipt **server-side and offline**, and keep the raw text.
- **G4.** Full-text search across item fields *and* receipt OCR text — "any word on the receipt" finds the item: vendor, model number, store name, a line item.
- **G5.** Suggest-and-confirm: heuristics over the OCR text pre-fill the form; the user always confirms. Suggestions never auto-commit.
- **G6.** At-a-glance expiry status: active / expiring soon / expired / lifetime, plus a dashboard widget for the next 60 days.
- **G7.** One-click creation from an existing transaction, linking the two.
- **G8.** Backups keep working, now covering the receipt files as well as the database, without breaking restores of v1.0.0 backups.
- **G9.** Zero new runtime network egress. The app stays LAN-only and offline (base §2).

### 1.2 Non-goals — see §16 for the full out-of-scope list

The headline exclusions: no expiry notifications of any kind, no image processing/thumbnails, no OCR of scanned PDFs, no claim-tracking workflow, no private-per-person visibility, no editing of OCR text, no HEIC.

### 1.3 Visibility model

Warranty items are **household-shared**, matching the family-trust model in base §6: every signed-in member sees every item, and any member may create, edit, or delete any item or receipt. `owner_user_id` is *attribution*, not access control — it is displayed, filterable, and defaults to the creating user. There is no admin-only surface in this feature.

---

## 2. Architecture delta

Everything below is additive to base §2. No existing subsystem is redesigned.

| Concern | Decision |
|---|---|
| New pages | `/warranties`, `/warranties/new`, `/warranties/[id]` under `src/app/(app)/` |
| New route handlers | exactly **three**: `POST /api/warranties/receipts/stage` (the only multipart upload), `GET /api/warranties/receipts/stage/[stagingId]` (OCR poll), `GET /api/warranties/receipts/[id]` (authenticated file stream). Every other mutation is a server action. |
| New library dirs | `src/lib/warranty/` (items, receipts, search, expiry, suggest, sniff, staging, `ocr/`), `src/lib/backup/` gains `archive.ts` (restore logic lives in `scripts/restore-backup.ts` instead of a `restore.ts` here — amended T11: standalone image ships no `src/`) |
| New migration | `drizzle/0002_warranty_tracker.sql`, journal idx **2**, `when` **1755388800000** |
| New runtime deps | `tesseract.js` (pulls `tesseract.js-core`), `pdfjs-dist`, `tar` |
| New vendored asset | `vendor/tessdata/eng.traineddata.gz`, committed to the repo |
| Background work | the existing `src/lib/scheduler.ts` gains an OCR sweep tick; a new in-process FIFO queue (concurrency 1) does the work |
| Docker | explicit `COPY` lines for the OCR/PDF assets, `mkdir /data/receipts`, and a build-time asset check |
| Base image | **unchanged** (`node:22-bookworm-slim`). Tesseract runs as WASM; no `apt-get install tesseract-ocr`. |

**MUST-2.1** No dependency added by this feature may perform network I/O at runtime. `tesseract.js`'s default CDN behaviour is explicitly disabled (§7.2); `pdfjs-dist` is used with the legacy Node build and no remote font/CMap fetching; `tar` is pure filesystem.

**MUST-2.2** `next.config.ts` adds `tesseract.js`, `tesseract.js-core` and `pdfjs-dist` to `serverExternalPackages`. The tesseract worker is loaded **by file path** from `node_modules`; if Next bundles it, that path stops existing and the library falls back to its CDN defaults — the exact failure this spec forbids.

**MUST-2.3** No change to the CSP in `src/lib/auth/security-headers.ts` is required or permitted by this feature. `img-src 'self' data:` already covers receipt images served from our own origin. See §13.4 for the one Permissions-Policy risk.

**MUST-2.4 (route precedence).** `receipts/stage/route.ts` and `receipts/[id]/route.ts` sit at the same routing depth. Next resolves the **static** `stage` segment ahead of the dynamic `[id]`, which is the intended behaviour and the reason `[id]` MUST accept only a positive integer (§5) — a request for `/api/warranties/receipts/stage` can then never be mistaken for a receipt lookup, in either direction.

---

## 3. Data model

### 3.1 Migration discipline (restating the binding rule)

**MUST-3.1** Migrations are **append-only and hand-authored**. `drizzle-kit generate` is never run (there is no `0000_snapshot.json`; it would diff against an empty baseline, re-emit all 19 existing tables, and silently drop the raw-SQL-only objects). There is intentionally no `db:generate` script in `package.json`. The order of work is fixed:

1. hand-author `drizzle/0002_warranty_tracker.sql`,
2. append the journal entry,
3. mirror the two tables in `src/db/schema.ts`.

**MUST-3.2** The journal entry appended to `drizzle/meta/_journal.json` is exactly:

```json
{ "idx": 2, "version": "6", "when": 1755388800000, "tag": "0002_warranty_tracker", "breakpoints": true }
```

**MUST-3.3** Statements in the migration file are separated by `--> statement-breakpoint`. Drizzle's migrator splits the file on that marker and nothing else (verified in `node_modules/drizzle-orm/migrator.js`), which is what makes the `CREATE TRIGGER … BEGIN … ; … END;` bodies in §3.5 safe — a splitter keyed on `;` would shred them.

**MUST-3.4** `0002`'s header comment repeats the drizzle-kit warning from `0000_init.sql` and **extends its enumeration of objects that exist only in SQL**. Before this feature the list was three items (the `categories.parent_id` self-FK, and the two `COALESCE` expression indexes). This migration adds: the `warranty_search` FTS5 virtual table, its six triggers, and every `CHECK` constraint declared below. The mirror in `schema.ts` carries a docblock naming them so the two files stay legible against each other.

### 3.2 `warranty_items`

```sql
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
```

Field rules:

- **`name`** required, trimmed, 1–200 chars.
- **`vendor` / `model` / `serial` / `notes`** optional free text (≤ 200 chars; `notes` ≤ 2000). `serial` is deliberately **not** unique — two identical appliances, a serial mis-read by OCR, and a blank both have to be storable.
- **`purchase_date`** required ISO `YYYY-MM-DD` (base §3's date convention). Must not be in the future relative to today in `TZ`; must not precede `1970-01-01`.
- **`warranty_months`** nullable positive integer. NULL with `is_lifetime = 0` means *warranty length unknown* — a legitimate state (you have the receipt, you don't know the term).
- **`is_lifetime`** boolean. **MUST-3.5** `is_lifetime = 1` ⇒ `warranty_months IS NULL` **and** `expiry_date IS NULL`. Enforced by CHECK *and* by zod at the action boundary; a lifetime warranty has no expiry to compute.
- **`expiry_date`** stored, **computed at write time** by §3.6, never computed on read. **MUST-3.6** `expiry_date IS NULL` ⇔ `warranty_months IS NULL` (CHECK above). Any write that changes `purchase_date`, `warranty_months`, or `is_lifetime` MUST recompute it in the same statement.
- **`price_cents`** nullable **integer cents** (base §3: integer cents everywhere, no floats). Stored as a positive magnitude — a purchase price, not a signed ledger amount. This is a deliberate divergence from `transactions.amount_cents` (spend negative) and §11 converts with `Math.abs`.
- **`owner_user_id`** NOT NULL, defaults to the creating user, editable to any active user. Users are deactivated and never deleted (base §3), so no `ON DELETE` clause is needed.
- **`transaction_id`** nullable, **`ON DELETE SET NULL`**. **MUST-3.7** Undoing an import that deletes the linked transaction MUST null the link and MUST NOT delete the warranty item. The receipt evidence outlives the ledger row. This is a database-level guarantee (`undoImport()` in `src/lib/import/commit.ts` deletes transaction rows directly; the FK does the rest, and `foreign_keys = ON` is set on every connection in `src/db/client.ts`). There is **no** unique index on `transaction_id`: one purchase can produce several warranty items (a fridge and a dishwasher on one Home Depot receipt).
- **`created_at` / `updated_at`** ISO datetime strings, maintained by app code.

### 3.3 `warranty_receipts`

```sql
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
```

- **Many receipts per item** (a till receipt plus a warranty card plus an emailed PDF).
- **`original_filename`** is *display only*, capped at 255 chars, and **MUST-3.8** never participates in a filesystem path and is never rendered as HTML (§13.3).
- **`stored_filename`** is server-generated (§4.2). The unique index makes a name collision a loud constraint failure rather than a silently overwritten file.
- **`sha256`** hex digest of the file bytes, computed once at upload. Used for the duplicate-attachment warning (§6.4) and for restore verification.
- **`ocr_status`** is exactly the three values `'pending' | 'done' | 'failed'`. There is deliberately no `'running'` state — see §7.5 for how an interrupted job is recovered.
- **`ocr_text`** NULL until OCR completes; capped at `MAX_OCR_TEXT_CHARS = 100_000` (truncated with a trailing marker, and the truncation noted in `ocr_error` while `ocr_status` stays `'done'`). Without a cap, one pathological PDF bloats both the row and the FTS index.
- **`ocr_error`** human-readable, shown verbatim in the UI as text.

### 3.4 Full-text search table

**Fact, verified in this repo:** `better-sqlite3@12` bundles **SQLite 3.53.2 with FTS5 compiled in**, including the `contentless_delete=1` option (SQLite ≥ 3.43). No extension loading, no build flags, no new dependency.

**Verified during spec authoring, against the installed `node_modules/better-sqlite3`:** the complete DDL of §3.2–§3.5 executes cleanly; every CHECK in §3.2 rejects its violation and accepts the lifetime and unknown-term rows; `metro` matches `MÉTRO` through the tokenizer; a prefix query matches a model number; deleting an item with receipts leaves **zero** FTS rows; and deleting a linked transaction nulls `transaction_id` while the item survives. The SQL below is not a sketch.

```sql
CREATE VIRTUAL TABLE `warranty_search` USING fts5(
	`name`, `vendor`, `model`, `notes`, `ocr_text`,
	content='', contentless_delete=1,
	tokenize='unicode61 remove_diacritics 2'
);
```

**Design note — why contentless rather than literal external-content.** FTS5's `content=` option binds an index to **exactly one** backing table or view. This index has to span two (`warranty_items` plus the OCR text of its `warranty_receipts`), so the correct FTS5 form is a **contentless** table with `contentless_delete=1`, maintained entirely by triggers. It behaves the way the approved design asks for — no duplicated storage of the column values inside a shadow content table, rows keyed by the item id, kept in sync by triggers — and it additionally supports `DELETE … WHERE rowid = ?`, which a plain `content=''` table (pre-3.43 semantics) does not. This is the one deviation from the literal wording of the approved design and it is a correctness fix, not a scope change (§17.6).

**MUST-3.9** `warranty_search.rowid` **is** `warranty_items.id`. One FTS row per item; receipt text is concatenated into the item's row. Search returns items, never receipts.

**MUST-3.10** The tokenizer is `unicode61 remove_diacritics 2`, so `MÉTRO` is found by typing `metro` — the same French-Canadian concern that drove base §5's encoding work.

### 3.5 Triggers

Six triggers keep the index in step. The reindex body is identical in three of them; only the key differs.

```sql
CREATE TRIGGER `warranty_search_item_ai` AFTER INSERT ON `warranty_items` BEGIN
	DELETE FROM `warranty_search` WHERE rowid = new.`id`;
	INSERT INTO `warranty_search`(rowid, `name`, `vendor`, `model`, `notes`, `ocr_text`)
		SELECT i.`id`, i.`name`, i.`vendor`, i.`model`, i.`notes`,
			(SELECT group_concat(r.`ocr_text`, ' ') FROM `warranty_receipts` r
				WHERE r.`warranty_item_id` = i.`id` AND r.`ocr_text` IS NOT NULL)
		FROM `warranty_items` i WHERE i.`id` = new.`id`;
END;
```

- `warranty_search_item_ai` — AFTER INSERT ON `warranty_items` (above).
- `warranty_search_item_au` — AFTER UPDATE **OF `name`, `vendor`, `model`, `notes`** ON `warranty_items`, same body keyed on `new.id`. Narrowing to those four columns keeps `updated_at` bumps and expiry recomputations from re-tokenizing a large OCR blob.
- `warranty_search_item_ad` — AFTER DELETE ON `warranty_items`: `DELETE FROM warranty_search WHERE rowid = old.id;`
- `warranty_search_receipt_ai` — AFTER INSERT ON `warranty_receipts`, body keyed on `new.warranty_item_id`.
- `warranty_search_receipt_au` — AFTER UPDATE **OF `ocr_text`** ON `warranty_receipts`, keyed on `new.warranty_item_id`.
- `warranty_search_receipt_ad` — AFTER DELETE ON `warranty_receipts`, keyed on `old.warranty_item_id`.

**Cascade-order safety.** Deleting an item fires both `warranty_search_item_ad` and (via the FK cascade) `warranty_search_receipt_ad` for each receipt. Either firing order converges on an empty index for that rowid: the receipt trigger's re-insert is a `SELECT … FROM warranty_items WHERE id = old.warranty_item_id`, which returns no rows once the item is gone, and if it fires first the item trigger's unconditional `DELETE` cleans up after it. **MUST-3.11** A test asserts `SELECT count(*) FROM warranty_search = 0` after deleting an item that had receipts.

**MUST-3.12** Application code never writes to `warranty_search` directly. The triggers are the only writer.

### 3.6 Expiry computation — clamp-to-last-day

**MUST-3.13** `expiry_date` is computed by pure ISO-string arithmetic in `addMonthsClamped(isoDate, months)`, added to `src/lib/dates.ts` alongside the existing `addMonths(month, delta)` helper. It MUST NOT use `Date.prototype.setMonth`, which *overflows* (Jan 31 + 1 month → Mar 2/3) and would silently move a February expiry into March.

Rule, exactly:

1. Split `purchase_date` into `y`, `m` (1–12), `d`.
2. `t = (m - 1) + months`; `year = y + Math.floor(t / 12)`; `month = (t % 12) + 1`.
3. `day = min(d, daysInMonth(year, month))` — **clamp to the last day of the target month**.
4. Emit zero-padded `YYYY-MM-DD`.

Worked examples that MUST appear as test cases:

| purchase_date | months | expiry_date | why |
|---|---|---|---|
| 2026-01-31 | 1 | 2026-02-28 | clamp; 2026 is not a leap year |
| 2024-01-31 | 1 | 2024-02-29 | clamp; 2024 is a leap year |
| 2024-02-29 | 12 | 2025-02-28 | leap day clamps to Feb 28 |
| 2026-03-31 | 1 | 2026-04-30 | 31-day → 30-day month |
| 2026-08-31 | 6 | 2027-02-28 | year rollover + clamp |
| 2026-01-31 | 12 | 2027-01-31 | no clamp needed |
| 2026-08-16 | 24 | 2028-08-16 | plain case |
| 2026-12-31 | 1 | 2027-01-31 | December rollover |

**MUST-3.14 (coverage is inclusive).** An item is covered **through and including** `expiry_date`. Expired means `expiry_date < today`.

### 3.7 Derived status (never stored)

`EXPIRING_SOON_DAYS = 60` is a single exported constant in `src/lib/warranty/expiry.ts`, used by the list badge, the filter, and the dashboard widget alike. Status is derived from `today` (in `TZ`, via the existing `todayIso()`) and `soon = addDaysIso(today, 60)` — `addDaysIso` being a second small helper added to `src/lib/dates.ts` next to `addMonthsClamped`, likewise operating on ISO strings rather than `Date` objects so a DST boundary can never shift a date:

```
lifetime   when is_lifetime = 1
unknown    when expiry_date IS NULL and is_lifetime = 0
expired    when expiry_date <  today
expiring   when expiry_date <= soon        (and >= today)
active     otherwise
```

The same `CASE` expression is used in SQL for filtering and sorting so the list, the filter counts, and the badge can never disagree. `unknown` is a fifth badge the approved design did not enumerate; the data model permits the state, so the UI must name it rather than mislabel it (§17.5).

### 3.8 Drizzle mirror (`src/db/schema.ts`)

**MUST-3.15** `warrantyItems` and `warrantyReceipts` are appended **at the end of** `schema.ts`, in the same order as their `CREATE TABLE` statements in `0002`, following the file's existing convention that declaration order mirrors DDL order (see the `mustChangePassword` docblock). Column names, nullability, defaults and FK actions mirror the SQL exactly. A docblock above them states that the `CHECK` constraints, the `warranty_search` virtual table and its six triggers exist **only** in `drizzle/0002_warranty_tracker.sql`, per MUST-3.4.

---

## 4. Receipt file storage

### 4.1 Location

**MUST-4.1** Receipts live at `${DATA_DIR}/receipts/` — inside the existing bind-mounted data volume, alongside `budget.db`, `backups/` and `tmp/`. The container stays disposable; an image update never touches receipts. `receiptsDir()` in `src/lib/warranty/receipts.ts` resolves it from `readEnv().dataDir`, exactly as `backupsDir()`/`stagingDir()` do. The directory is created with `mkdirSync(..., { recursive: true })` on first use, and pre-created in the Dockerfile's `mkdir -p` line so it is `node`-owned under the read-only rootfs.

Flat directory, no sharding: a household generates hundreds of files, not millions.

### 4.2 Naming and traversal defence

**MUST-4.2** `stored_filename = ${randomUUID()}.${ext}` where `ext` is derived **from the sniffed content type** (`jpg | png | webp | pdf`) — never from the uploaded filename, never from the client's `Content-Type`.

**MUST-4.3** Every path build goes through a guard modelled on `resolveSafeTarget()` in `src/lib/backup.ts` and `stagedFilePath()` in `src/lib/import/staging.ts`:

```
STORED_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/
```

The guard (a) rejects any name failing that regex, and (b) re-checks that `path.dirname(path.resolve(dir, name)) === path.resolve(dir)` before any `fs` call. Two independent lines of defence, matching the existing precedent.

**MUST-4.4** A receipt is **only ever located by its database id**. No route, action, or helper accepts a client-supplied path, filename, or directory component.

### 4.3 Accepted types — magic-byte sniffing

**MUST-4.5** The accepted set is exactly four types, decided by **leading bytes**, never by extension and never by the browser-declared MIME:

| Type | Signature |
|---|---|
| `image/jpeg` | `FF D8 FF` at offset 0 |
| `image/png` | `89 50 4E 47 0D 0A 1A 0A` at offset 0 |
| `image/webp` | `52 49 46 46` (`RIFF`) at offset 0 **and** `57 45 42 50` (`WEBP`) at offset 8 |
| `application/pdf` | `25 50 44 46 2D` (`%PDF-`) at offset 0 |

Anything else is rejected with "That file type isn't supported. Upload a JPEG, PNG, WebP or PDF." `sniffReceiptType(buf): ReceiptMime | null` is a pure function in `src/lib/warranty/sniff.ts`.

### 4.4 Size cap

**MUST-4.6** `MAX_RECEIPT_BYTES = 10 * 1024 * 1024` (10485760). Enforced three times: a `Content-Length` pre-check that 413s before the body is buffered (the pattern already used by the import routes), a post-read length check, and the `CHECK` constraint in §3.3. A zero-byte file is rejected.

### 4.5 Write, delete, and orphan rules

**MUST-4.7 (write order).** Buffer → sniff → hash → write to `${DATA_DIR}/tmp/<uuid>.<ext>` → `fs.renameSync` into `receipts/` (same filesystem, atomic) → insert the row. If the insert throws, the file is unlinked in a `finally`.

**MUST-4.8 (delete order).** Delete the DB row first (inside the transaction; the FTS trigger fires), then unlink the file best-effort. A failed unlink is logged, never surfaced as an error, and swept later. Deleting a **warranty item** cascades its receipt rows and then unlinks each of their files.

**MUST-4.9 (orphan sweep).** The nightly maintenance sweep (`runMaintenanceSweep()` in `src/lib/backup.ts`) gains `receiptOrphansPurged`: files in `receipts/` with **no** matching `stored_filename` row **and** an mtime older than 24 h are removed. The age guard prevents a race with an in-flight upload. The result is logged on the existing `[backup]` line. **(amended at final review)** The sweep also refuses to run at all — logging a warning and purging nothing — when the database references **zero** receipts but `receipts/` still has files in it (restore protection, §12.9); a crash-orphan on a genuinely zero-receipt install is deliberately left in place until at least one receipt row exists, rather than guessed at.

**MUST-4.10 (missing file is not an error state).** A row whose file is absent renders as "file missing" in the gallery (§10.3), and the download route returns **410 Gone** with a plain-text body. This is the state a v1.0.0 backup restore produces (§12.4) and it must degrade quietly.

---

## 5. Serving receipts

`GET /api/warranties/receipts/[id]` — the only way a receipt's bytes reach a browser.

**MUST-5.1** Order of checks, all before any filesystem access:
1. `isSameOriginOrHeaderless(request.headers)` → else 403. This is the download-GET rule from `src/lib/auth/csrf.ts`: reject a **present-and-mismatched** Origin/`Sec-Fetch-Site`, allow a request carrying neither, because the documented default deployment is plain HTTP on the LAN where an `<img>` load and a navigation send no Origin and browsers omit fetch metadata on non-trustworthy origins. Same precedent as `/api/backup/download`.
2. `userFromRequest(request)` → else 401. **No anonymous access, ever.** There is no signed-URL, no token-in-query, no public path.
3. Parse `id` as a positive integer → else 400.
4. Look the row up by id → 404 if absent.

**MUST-5.2** The response `Content-Type` comes from the **stored** `mime` column (itself constrained to the four-value safe list), never from the request and never sniffed at read time.

**MUST-5.3** `Content-Disposition` is `inline` **only** for `image/jpeg`, `image/png` and `image/webp`. `application/pdf` is served as `attachment; filename="<sanitised original name>"`. Rationale: a same-origin inline PDF opens in the browser's PDF viewer, which executes JavaScript embedded in the document within our origin; `object-src 'none'` in the CSP does not cover a top-level navigation to the file. The gallery therefore links PDFs rather than embedding them (§10.3). The `filename` is derived from `original_filename` with everything outside `[A-Za-z0-9._-]` replaced by `_`, truncated to 100 chars, and quoted.

**MUST-5.4** Additional headers: `Cache-Control: private, no-store`, and `Content-Length`. `X-Content-Type-Options: nosniff` already arrives from `securityHeaders()` via middleware, which matches `/api/*`.

**MUST-5.5** The body is streamed from disk (`fs.createReadStream` → `ReadableStream`), not read fully into memory: at 10 MB × several concurrent image loads, `readFileSync` is a needless RSS spike on a NAS.

**MUST-5.6** If the DB row exists but the file does not, return **410 Gone**, `text/plain`, body `Receipt file is missing from this install.`

---

## 6. Capture and upload

### 6.1 The control

**MUST-6.1** The file control is exactly:

```html
<input type="file" name="file" accept="image/*,application/pdf" capture="environment" multiple />
```

`capture="environment"` makes a phone open the rear camera directly; a desktop browser ignores it and shows the file picker. **No native app, no `getUserMedia`, no canvas capture.** `multiple` lets a member add the till receipt and the warranty card in one go.

### 6.2 Why the upload is a route handler, not a server action

**MUST-6.2** File bytes MUST NOT travel through a Next server action. Next 15's server actions carry a **1 MB default body limit** (`experimental.serverActions.bodySizeLimit`), so a 10 MB receipt would fail with an opaque error. Raising that limit globally would also raise it for every other action in the app. Route handlers have no such limit, and the codebase already routes CSV bytes through `/api/import/*` for the same reason. Every *other* warranty mutation (create, edit, delete, attach, re-OCR) is a server action carrying only JSON-sized payloads.

### 6.3 The staging endpoint

`POST /api/warranties/receipts/stage` (multipart/form-data, one or more `file` parts):

**MUST-6.3** `assertSameOrigin(request)` — the **strict** check, first, before anything else. This is a mutating request; the relaxed headerless rule of §5 does not apply to it.
**MUST-6.4** `userFromRequest` → 401 if absent.
**MUST-6.5** Two size gates, both required. (a) A `Content-Length` pre-check against `MAX_UPLOAD_BYTES = MAX_RECEIPT_BYTES * MAX_FILES_PER_UPLOAD` where `MAX_FILES_PER_UPLOAD = 5`, refusing **before** the body is buffered → 413 `{ error, code: 'file_too_large' }`, mirroring the import routes' response shape. (b) After parsing, each individual part is checked against `MAX_RECEIPT_BYTES` and the part count against `MAX_FILES_PER_UPLOAD`. A request that fails (b) is rejected whole — no partial staging.
**MUST-6.6** For each part: sniff (§4.3) → size check → sha256 → write `${DATA_DIR}/tmp/<uuid>.<ext>` → enqueue an OCR job of kind `staged`.

Response: `{ staged: [{ stagingId, originalFilename, mime, sizeBytes, sha256 }] }`.

**Why staging exists.** Suggestions must pre-fill the *new-item* form, which means OCR has to run before any `warranty_items` row exists. Staged files live in the existing `${DATA_DIR}/tmp` directory and are therefore already covered by `purgeStagedFiles()`'s 24-hour mtime sweep — that helper iterates every entry in the directory, so no change to its purge logic is needed.

**MUST-6.7** The OCR worker writes its result to a sidecar `${DATA_DIR}/tmp/<uuid>.ocr.json` = `{ status: 'done' | 'failed', text?, error?, suggestions? }`. A sidecar file, rather than an in-memory map, so a container restart mid-flow degrades to "no suggestions" instead of losing a member's upload.

`GET /api/warranties/receipts/stage/[stagingId]` returns `{ status: 'pending' | 'done' | 'failed', suggestions?, error? }` — session-authenticated, `isSameOriginOrHeaderless`, `stagingId` validated against the UUID regex before any path is built. The client polls it every 1.5 s and stops after 3 minutes with "Still processing — save now and re-run OCR from the item page."

### 6.4 Committing staged files

The `createWarrantyAction` / `attachReceiptsAction` server actions take `stagingIds: string[]` plus the confirmed field values.

**MUST-6.8** For each staging id, inside one DB transaction per item: re-validate the staged file still exists and still sniffs to an accepted type, `rename` it into `receipts/` under a fresh `stored_filename`, insert the `warranty_receipts` row with the sidecar's `ocr_text`/`status` **if present**, otherwise with `ocr_status = 'pending'` — in which case the background sweep picks it up (§7.5). Delete the sidecar. **The staging id is never trusted as a path** (§4.3 regex guard).

**MUST-6.9** If a file with the same `sha256` is already attached to the same item, the UI warns ("This looks like a receipt you already added") but does not block — a duplicate is a user judgement, not an error.

---

## 7. OCR

### 7.1 Engine

**MUST-7.1** OCR is **server-side `tesseract.js`** (Tesseract compiled to WASM). No change to the Docker base image, no `apt-get install tesseract-ocr`, no native binary.

**MUST-7.2** Recognition runs in tesseract.js's **Node worker** (its own process), so the Next.js event loop is never blocked by a multi-second recognise call.

### 7.2 Offline assets — the hard invariant

**MUST-7.3 (no runtime egress).** By default tesseract.js fetches its worker script, its `.wasm` core, and `eng.traineddata` from a CDN on first use. On this app that is **forbidden**: the install is LAN-only and frequently has no route to the internet, and base §2 states there are no runtime network calls. Every asset MUST be resolved from a **local absolute filesystem path**:

| Option | Value |
|---|---|
| `workerPath` | `<app>/node_modules/tesseract.js/src/worker-script/node/index.js` |
| `corePath` | `<app>/node_modules/tesseract.js-core` (directory; the library selects the SIMD/non-SIMD build) |
| `langPath` | `<app>/vendor/tessdata` (contains `eng.traineddata.gz`) |
| `gzip` | `true` (matches the `.gz` asset) |
| `cachePath` | `${DATA_DIR}/tmp` |
| `cacheMethod` | `'none'` |
| `logger` | omitted in production; a no-op in tests |

`cacheMethod: 'none'` keeps the library from writing a copy of the language data anywhere (the rootfs is read-only), and `cachePath` inside `DATA_DIR` is the belt-and-braces for any write path that ignores it.

**MUST-7.4** `resolveOcrAssets()` in `src/lib/warranty/ocr/assets.ts` is the single place these paths are computed, resolved against the app root (`process.cwd()`, which is `/app` in the container and the repo root in dev/test). It returns absolute paths only.

**MUST-7.5 (testable invariant).** A unit test asserts that every value returned by `resolveOcrAssets()` (a) is an absolute path, (b) does **not** match `/^[a-z]+:\/\//i` — i.e. is not a URL of any scheme, and (c) exists on disk via `fs.existsSync`. A second test asserts the OCR module's construction call passes all four of `workerPath`, `corePath`, `langPath`, `cachePath` — a missing option is how the CDN default silently comes back.

**MUST-7.6 (fail loudly, degrade gracefully).** `assertOcrAssets()` runs at boot from `src/instrumentation-node.ts` and logs one line: either `[ocr] assets ok (…)` or `[ocr] MISSING: …`. Missing assets **do not** crash the app — receipts still upload, and jobs complete as `ocr_status = 'failed'` with `ocr_error = 'OCR engine unavailable on this install.'` A warranty tracker without OCR is still a warranty tracker; a container that refuses to boot is not.

### 7.3 Language data provenance

**MUST-7.7** `eng.traineddata.gz` is **committed to the repository** at `vendor/tessdata/eng.traineddata.gz` (~1.9 MB — the `tessdata_fast` variant; amended at final review, see §17.28). `scripts/fetch-tessdata.mjs` is a documented one-time regeneration helper (run by a maintainer with internet access; never invoked by a build, a test, or the app). A test asserts the file's sha256 matches a constant recorded in `src/lib/warranty/ocr/assets.ts`, so a corrupt or swapped file is caught in CI rather than at a family member's first upload.

Rejected alternative: pulling the data from an npm package such as `@tesseract.js-data/eng`. It keeps a binary out of git, but it makes an offline-critical asset depend on the continued publication of a third-party data package and on npm resolution at build time. Vendoring is deterministic. (§17.21)

### 7.4 Docker packaging risk

**MUST-7.8** Next's `standalone` output tracing cannot know that a `.wasm` blob, a worker script loaded by string path, and a `.traineddata.gz` under `vendor/` are runtime inputs — the same class of miss that already forced explicit `COPY` lines for `better-sqlite3`'s `.node` binary, `drizzle/`, `scripts/` and `CHANGELOG.md`. The runtime stage therefore adds:

```dockerfile
COPY --from=builder --chown=node:node /app/vendor ./vendor
COPY --from=builder --chown=node:node /app/node_modules/tesseract.js ./node_modules/tesseract.js
COPY --from=builder --chown=node:node /app/node_modules/tesseract.js-core ./node_modules/tesseract.js-core
COPY --from=builder --chown=node:node /app/node_modules/pdfjs-dist ./node_modules/pdfjs-dist
```

and `/data/receipts` joins the existing `mkdir -p /data /data/backups /data/tmp`.

**MUST-7.9 (acceptance check A3).** The runner stage runs `RUN node scripts/check-ocr-assets.mjs` **at build time**, which fails the build if any of the four asset paths is absent. A tracing miss must break `docker build`, not production. `.dockerignore` MUST NOT exclude `vendor/` (it currently excludes `node_modules`, `.next`, `.git`, `.tmp-data`, `docs`, `coverage`, `*.db*`, `.env*` — no change needed, stated so a future edit does not break it).

### 7.5 Queue and lifecycle

**MUST-7.10** A single in-process FIFO queue with **concurrency 1** (`src/lib/warranty/ocr/queue.ts`). Household scale: a burst is three receipts, not three hundred. One tesseract worker is created lazily, reused across jobs, and terminated after 60 s idle to release its ~100 MB RSS.

Job kinds: `{ kind: 'staged', stagingId }` and `{ kind: 'receipt', receiptId }`.

**MUST-7.11** Per-job timeout `OCR_TIMEOUT_MS = 120_000`. On timeout the worker is terminated and recreated, and the job records `'failed'` with `ocr_error = 'OCR timed out.'`

**MUST-7.12 (recovery without a 'running' state).** `ocr_status` has only three values, so an in-flight job is tracked by an in-memory claimed-id set, not in the database. A crash therefore leaves rows in `'pending'`. The scheduler (`src/lib/scheduler.ts`) gains a tick — **every 10 minutes**, plus once at boot — that enqueues every `warranty_receipts` row with `ocr_status = 'pending'` that is not currently claimed. Self-healing, idempotent, and it costs one indexed query (`warranty_receipts_ocr_idx`).

**MUST-7.13** Status transitions are `pending → done` or `pending → failed` only. Re-OCR (§7.7) resets a row to `'pending'` and clears `ocr_text`/`ocr_error`; the `warranty_search_receipt_au` trigger reindexes on both the clear and the refill.

### 7.6 PDFs — text layer only

**MUST-7.14** PDFs are **not** rasterised and **not** run through Tesseract. Text is extracted from the PDF's text layer with `pdfjs-dist`'s legacy Node build (`getDocument` → per-page `getTextContent()`, concatenated with newlines), with remote font/CMap fetching disabled.

**MUST-7.15** If extraction yields fewer than **20 non-whitespace characters**, the receipt is recorded as `ocr_status = 'failed'` with `ocr_error = 'This PDF has no text layer — it looks like a scan. Scanned-PDF OCR is not supported yet; photograph the receipt instead.'` The file is still stored, still viewable, still deletable. OCR of scanned PDFs is explicitly deferred (§16).

Rejected alternative: `pdf-parse`. Its published build executes a demo-file read at require time when `module.parent` is unset, which breaks under bundlers and in ESM contexts, and it is unmaintained. (§17.10)

### 7.7 Re-OCR

**MUST-7.16** Every receipt in the detail view has a **Re-run OCR** action (server action, `isSameOrigin` first). It sets the row to `'pending'`, clears `ocr_text` and `ocr_error`, and enqueues a `receipt` job. Purpose: retry a failure, and re-read receipts after an engine or language-data upgrade. It is idempotent and safe to click repeatedly (a second click on a claimed row is a no-op).

### 7.8 Test seam

**MUST-7.17** The engine is reached only through a hook module modelled on `src/lib/import/hooks.ts`:

```ts
export interface OcrEngine { recognize(filePath: string, mime: ReceiptMime): Promise<{ text: string }>; }
export function getOcrEngine(): OcrEngine;
export function setOcrEngineForTests(engine: OcrEngine | null): void;
```

**No test in the suite ever loads real WASM or reads `eng.traineddata`.** Tests inject a fake engine returning fixture text. The only code paths that touch the real engine are the asset-resolution unit tests (§7.2, which stat files but do not run recognition) and the manual Docker acceptance checks (§15.4).

---

## 8. Field suggestion (suggest-and-confirm)

**MUST-8.1** Suggestions **never auto-commit**. They pre-fill form inputs the user can overwrite, each rendered with a "suggested from receipt" affordance and a one-click clear. Saving is always an explicit act.

**MUST-8.2** `ocr_text` is stored raw and indexed **regardless** of whether any heuristic matched. Search does not depend on extraction succeeding.

**MUST-8.3** All extractors are **pure functions** over the OCR string in `src/lib/warranty/suggest.ts`, returning `{ purchaseDate?: string; vendor?: string; priceCents?: number }` with each field independently optional. No I/O, no DB access, no clock access beyond an injected `today` parameter (so tests are deterministic).

### 8.1 Purchase date

1. Collect every match of: ISO `YYYY-MM-DD`; `D/M/YYYY` or `M/D/YYYY` with `/` or `-` separators (2- or 4-digit year, 2-digit years mapping to 2000–2099); `DD Mon YYYY` and `Mon D, YYYY` with English month names/abbreviations (the `DD Mon YYYY` shape is what the Amex export already uses, base §3).
2. Discard candidates that are not valid calendar dates, that fall **after** `today` (in `TZ`), or that fall more than **20 years** before it.
3. **Ambiguity rule for `A/B/YYYY`**, applied in order: if `A > 12` read as `DD/MM`; else if `B > 12` read as `MM/DD`; else **default to `MM/DD/YYYY`** and let the user correct it — the dominant print format on Canadian POS terminals. Documented default, not a guess presented as fact (§17.22).
4. Among survivors, take the **earliest occurrence in the text** (receipt headers print the transaction date before any expiry or promo date). Ties break on first match.

### 8.2 Vendor

The first line among the **first five non-empty lines** that: contains ≥ 3 letters; is not entirely digits/punctuation; and does not match `/^(receipt|invoice|order|tel|phone|fax|www\.|https?:|\d)/i`. Whitespace-collapsed, trimmed, capped at 60 chars. No title-casing — the raw text is what the store calls itself.

### 8.3 Total

1. **TOTAL-line pass.** Lines matching `/\b(total|amount due|grand total|balance due)\b/i` **and not** matching `/\bsub[\s-]?total\b/i`. Take the **last** currency-formatted number on the **last** such line — receipts print subtotal, tax, then total.
2. **Fallback.** The largest currency-formatted number anywhere in the text.
3. Currency shape: `/(?:\$\s*)?(\d{1,3}(?:,\d{3})*|\d{1,9})[.,](\d{2})(?!\d)/` (digit run bounded to 9 to prevent quadratic backtracking on garbled digit-run OCR; amounts that long always exceed the ceiling anyway — amended after Task 4 review).
4. Convert with the existing `parseAmountToCents()` from `src/lib/money.ts` — one money parser in the app, integer cents, no floats.
5. **Noise ceiling:** ignore any candidate ≥ `10_000_000` cents ($100,000). A mis-read barcode or a phone number can otherwise present as a nine-figure total.
6. Suggested `price_cents` is always a **positive magnitude** (§3.2).

---

## 9. Search

### 9.1 Query construction

**MUST-9.1 (FTS5 injection defence).** User search input is **never** interpolated into an FTS5 query as-is. FTS5 has its own query language: bare `AND`/`OR`/`NOT`/`NEAR`, `^`, `:`, `-`, `*`, `(`, `)` and `"` are operators, and an unbalanced quote is a syntax error that surfaces as a 500 on a perfectly ordinary search for `26" monitor`.

Exact strategy, implemented once in `escapeFtsQuery(raw: string): string | null` in `src/lib/warranty/search.ts`:

1. Trim; split on `/\s+/`.
2. Drop empty terms. If nothing remains, return `null` → **the caller omits the MATCH clause entirely** and lists everything.
3. Each term becomes `"` + `term.replace(/"/g, '""')` + `"` — **wrap in double quotes, doubling any internal double quote**. A quoted string in FTS5 is a literal phrase, so every operator inside it loses its meaning.
4. Append `*` to the **last** term only, giving type-ahead prefix matching on the word being typed.
5. Join with a single space (FTS5's implicit AND).
6. Cap at 20 terms and 200 characters of raw input.

Worked examples that MUST appear as test cases:

| input | produced query |
|---|---|
| `tim hortons` | `"tim" "hortons"*` |
| `26" monitor` | `"26""" "monitor"*` |
| `dewalt AND drill` | `"dewalt" "AND" "drill"*` (AND is matched as a word, not an operator) |
| `GDT645SYNFS` | `"GDT645SYNFS"*` |
| `   ` | `null` → no MATCH clause |
| `"` | `""""` |

**MUST-9.2** The produced string is passed as a **bound parameter** to `… WHERE warranty_search MATCH ?`. Never string-concatenated into SQL.

**MUST-9.3** A malformed-query safety net: if SQLite still raises an FTS5 syntax error, the action catches it and returns "That search couldn't be understood — try different words," never a 500 and never a raw SQLite message.

### 9.2 Query shape

```sql
SELECT i.*, <status CASE>
  FROM warranty_items i
  JOIN warranty_search s ON s.rowid = i.id      -- omitted when the query is null
 WHERE warranty_search MATCH ?                  -- omitted when the query is null
   AND (? IS NULL OR i.owner_user_id = ?)
   AND (? IS NULL OR <status CASE> = ?)
 ORDER BY <sort>
 LIMIT 50 OFFSET ?
```

**MUST-9.4** Default sort is `expiry_date IS NULL, expiry_date ASC, name ASC` — soonest expiry first, unknown/lifetime last. The user can switch to name or purchase date. Searching **filters**; it does not reorder (an FTS `rank` ordering would shuffle the expiry list the moment someone typed, which is the opposite of what this page is for). Page size 50.

---

## 10. UI

### 10.1 Navigation

**MUST-10.1** `src/app/(app)/layout.tsx`'s `NAV` array gains `{ href: '/warranties', label: 'Warranties' }` immediately after Goals. No badge.

### 10.2 List page — `/warranties`

Server component + `warranties-client.tsx`, matching the existing page/client split.

- Columns: **Item** (name, with model as secondary text) · **Vendor** · **Purchase date** · **Expiry** · **Status** badge · **Owner**.
- Status badge: `active` (neutral) · `expiring` (amber, "expires in N days") · `expired` (red) · `lifetime` (blue) · `unknown` (grey, "term unknown").
- Search box (FTS, §9), debounced 250 ms, driving a `?q=` URL parameter so a search is linkable and survives refresh.
- Filters: status (all / active / expiring / expired / lifetime / unknown) and owner (all / each active user). Sort control per MUST-9.4.
- Empty states distinguish "no warranties yet" (with the Add call to action) from "no matches for that search".
- "Add warranty" button → `/warranties/new`.

### 10.3 Add flow — `/warranties/new`

**MUST-10.2** OCR **never blocks the form.** The sequence:

1. The member picks or photographs one or more files. Each uploads immediately to the staging endpoint (§6.3) and shows a thumbnail (the browser's own `URL.createObjectURL` preview — no server-side image processing).
2. A status line reads **"Reading receipt… you can fill this in and save now; suggestions will appear when it's done."** The Save button is enabled the entire time.
3. When polling reports `done`, any **empty** field among purchase date / vendor / price is filled from the suggestion and flagged "suggested from receipt". **MUST-10.3** A field the user has already typed into is never overwritten.
4. When polling reports `failed`, the status line shows the error text and the form carries on unchanged.
5. Save → `createWarrantyAction` (§6.4) → redirect to the detail page.

Form fields: name (required) · vendor · model · serial · purchase date (required, date input) · warranty length as **months** *or* a **Lifetime** checkbox (checking it disables and clears the months input, per MUST-3.5) · price · owner (defaults to the current user) · notes.

**MUST-10.4** The computed expiry date is displayed live beside the months input ("Covered through 2028-08-16") so the clamp rule (§3.6) is visible rather than surprising.

### 10.4 Detail view — `/warranties/[id]`

- All fields, the owner, the computed status badge, and — when `transaction_id` is set — a link to the linked transaction. When the link has been nulled by an import undo, the page says "The linked transaction was removed by an import undo" rather than showing a dead link. **(amended at final review)** This message cannot actually be produced by the build as specified: `ON DELETE SET NULL` (MUST-3.7) makes a nulled `transaction_id` indistinguishable from one that was never linked, so only a dangling id left by an FK-off restore ever triggers it.
- **Receipt gallery:** images rendered inline via `/api/warranties/receipts/[id]` (click to open full size); PDFs shown as a labelled download link (§5.3); each tile shows the original filename, size, OCR status chip, and — on failure — the error text.
- Per receipt: **Re-run OCR**, **Remove** (confirm).
- **Add receipt**: the same staged-upload control, committing through `attachReceiptsAction`.
- **Edit** (inline form) and **Delete item** (confirm dialog naming the item and its receipt count).
- OCR text itself is **not displayed and not editable** (§16) — it is search fuel, often noisy, and showing it invites the "let me fix this" request this release is not taking.

### 10.5 Dashboard widget

**MUST-10.5** A "Warranties expiring soon" card on `/dashboard` listing items with status `expiring` (§3.7), sorted by expiry ascending, **top 5**, each showing name, vendor and "expires in N days", with a "View all" link to `/warranties?status=expiring`. Hidden entirely when the count is zero — the dashboard already has enough on it.

**MUST-10.6** The widget respects the dashboard's existing person switcher: Household shows every item; a selected person shows only items where `owner_user_id` matches. Consistent with how every other widget on that page scopes.

---

## 11. Transactions integration

**MUST-11.1** The transactions table gains a row action **"Create warranty"**, linking to `/warranties/new?transactionId=<id>`.

**MUST-11.2** The action is **hidden on rows with `is_transfer = 1`** — a transfer is not a purchase.

**MUST-11.3** Prefill is computed **server-side** from the transaction row. The query parameter carries only the id; no field value is ever trusted from the URL. The server loads the transaction (404 if absent) and derives:

| Warranty field | From |
|---|---|
| `purchase_date` | `transactions.date` (already ISO) |
| `price_cents` | `Math.abs(transactions.amount_cents)` — the ledger stores spend negative, warranties store a positive price (§3.2) |
| `vendor` | `display_description ?? raw_description`, trimmed, whitespace-collapsed, capped at 60 chars |
| `transaction_id` | the id |

**MUST-11.4** Prefilled fields remain editable, and OCR suggestions arriving later MUST NOT overwrite them — they are user-visible values by the time the form renders, and MUST-10.3 already covers this.

**MUST-11.5** Nothing about `transactions` changes: no column, no index, no behaviour. The link is owned entirely by `warranty_items.transaction_id`, and its `ON DELETE SET NULL` (MUST-3.7) means the import-undo path in `src/lib/import/commit.ts` needs no modification either.

---

## 12. Backup and restore

### 12.1 The new artifact

**MUST-12.1** A backup is now a **gzipped tar archive** containing:

```
budget.db          (a VACUUM INTO snapshot, not the live file)
receipts/<files>   (every file in ${DATA_DIR}/receipts)
```

Nightly name `budget-YYYY-MM-DD.tar.gz` in `${DATA_DIR}/backups/`; on-demand downloads are built in `${DATA_DIR}/tmp` and unlinked after streaming, exactly as today.

**MUST-12.2** Archive creation keeps the existing `VACUUM INTO` discipline from base §8: delete the target if present (`VACUUM INTO` errors on an existing file), snapshot the DB to `${DATA_DIR}/tmp/<uuid>.db`, add it to the archive as `budget.db`, add `receipts/`, then unlink the temp snapshot in a `finally`. Filenames still pass through `resolveSafeTarget()`.

**MUST-12.3** `listBackups()` recognises **both** `budget-YYYY-MM-DD.tar.gz` and the legacy `budget-YYYY-MM-DD.db`, so a v1.0.0 install's existing backups stay visible, listed and prunable after the upgrade. Retention counting spans both.

`tar` (node-tar, pure JS) is the archiver. Node ships `zlib` but no tar writer, and hand-rolling one to save a dependency is the wrong trade for a data-integrity path.

**Disk note (documented in INSTALL.md, not enforced):** retention × (database + all receipts). Fourteen nightly copies of a 300 MB receipt library is 4 GB. The backups page already lists each artifact's size (`listBackups()` returns `bytes` today), and the retention setting already exists in Settings — so this is a documentation change, not a feature.

### 12.2 Restore

**MUST-12.4** Restore stays what it is today — an **offline procedure with the container stopped** — now backed by a helper so it is testable and hard to get wrong: `restoreFromArtifact(artifactPath, { dataDir })` exported directly from `scripts/restore-backup.ts` (`npm run restore-backup`) rather than from a separate `src/lib/backup/restore.ts` (amended T11: the runtime image ships Next's standalone output, which has no `src/` tree, so a rescue script cannot import from `@/lib/...` inside the container — the same constraint `scripts/reset-admin-password.ts` already lives under). There is **no in-app restore button**: restoring under a live SQLite connection is how you corrupt a database.

**MUST-12.5 Format detection is by magic bytes, never by file extension:**

| Leading bytes | Artifact | Action |
|---|---|---|
| `1F 8B` | v1.1 archive | restore DB **and** receipts |
| `SQLite format 3\0` | v1.0 DB-only backup | restore DB **only** |
| anything else | — | refuse with a clear message; touch nothing |

**MUST-12.6 (tar-slip defence).** Extraction accepts **only** the entry `budget.db` and entries matching `receipts/<STORED_NAME_RE>`. Absolute paths, `..` segments, symlinks, hardlinks, device nodes and any other entry are rejected and the whole restore aborts. node-tar's own protections are relied on **in addition to**, not instead of, this allow-list.

**MUST-12.7** Restoring the database removes the stale `budget.db-wal` and `budget.db-shm` files, as the current INSTALL.md procedure already instructs — otherwise SQLite replays an old write-ahead log over the restored file.

**MUST-12.8** Restoring receipts is **non-destructive**: the existing `receipts/` directory is renamed to `receipts.pre-restore-<timestamp>/` and the archive's directory is written fresh. Nothing is deleted; recovering from a mistaken restore is a rename.

### 12.3 Backwards compatibility — the binding rule

**MUST-12.9** A v1.0.0 DB-only `.db` backup MUST restore cleanly into a v1.1.0 install:

- The database is replaced; migrations run on next boot and add the (empty) warranty tables.
- **`data/receipts/` MUST NOT be deleted, emptied, or modified.** A DB-only artifact says nothing about receipts, and treating silence as "delete them" would destroy files the backup was never responsible for.
- Any `warranty_receipts` row in the restored database whose file is absent renders "file missing" (MUST-4.10) and its download route returns 410 (MUST-5.6). The item, its fields, and its OCR text remain searchable — the text lives in the database, not the file.
- The restore tool prints an explicit count: `N receipt rows reference files that are not present on disk.`

### 12.4 Reverse compatibility

**MUST-12.10** A v1.1 `.tar.gz` archive is **not** restorable by a v1.0.0 install. The restore tool in v1.1.0 says so if handed an artifact it cannot read, and INSTALL.md states the one-way direction. Downgrading is not supported and never was (migrations are append-only).

---

## 13. Security invariants (restated, all binding)

- **MUST-13.1** Every **mutating** server action calls `isSameOrigin(await headers())` **first**, before auth, before validation, before any read — the pattern in `src/app/(app)/transactions/actions.ts`. Mutating route handlers call `assertSameOrigin(request)`. The relaxed `isSameOriginOrHeaderless` is used **only** on the two authenticated read-only GETs this feature adds (§5, §6.3 poll).
- **MUST-13.2** Everything is session-authenticated. This feature adds **no** anonymous route, no signed URL, no bearer token, no query-string secret. The only public paths in the app remain login and setup.
- **MUST-13.3 (OCR text is untrusted input).** OCR text and `original_filename` are attacker-influenceable in principle (a receipt is an arbitrary image). They are: rendered as **text nodes only**, never as HTML and never through `dangerouslySetInnerHTML`; passed into FTS only via the escaper of §9.1 and always as a bound parameter; never used to build a path; never used in a `Content-Type`; and sanitised before appearing in a `Content-Disposition` filename (§5.3).
- **MUST-13.4 (Permissions-Policy risk).** The app currently sends `Permissions-Policy: camera=(), …`. `<input capture>` normally routes through the OS camera intent rather than `getUserMedia`, so the policy should not block it — but browser implementations differ, and this must be **verified on a real phone** (acceptance check A5, §15.4). The pre-approved remedy if it is blocked is to relax that one directive to `camera=(self)`, which is still strictly tighter than the browser default. No other header changes.
- **MUST-13.5** Integer cents everywhere. `price_cents` is an integer; no float ever touches a money value; conversion goes through `src/lib/money.ts`.
- **MUST-13.6** No new runtime network egress (§7.2). The SimpleFIN connector in base §12 remains the app's only opt-in exception and is untouched by this feature.
- **MUST-13.7** TypeScript strict; zod validation on every action input and every route body, including the multipart parts.
- **MUST-13.8** Container hardening is unchanged: non-root, read-only rootfs, tmpfs `/tmp`, `/data` writable. OCR writes only to `/tmp` and `${DATA_DIR}` (MUST-7.3).
- **MUST-13.9** Receipts land inside the **unencrypted** backup archive, exactly like the database (base §8's accepted LAN-only trade-off). INSTALL.md's Hyper Backup client-side-encryption guidance is extended to say that offsite copies now include photographs of receipts, which carry names, addresses and partial card numbers.

---

## 14. Versioning and release

**MUST-14.1** `package.json` `version` → **`1.1.0`**. It is the single source of truth: `src/lib/version.ts` imports it at build time, the footer and Settings → About render it, `/api/health` reports it, and the update scripts print it before and after.

**MUST-14.2** `CHANGELOG.md` gains a `## [1.1.0] — 2026-08-16` section in Keep-a-Changelog style with the standard headings, and a fresh empty `## Unreleased` above it. **Note:** the current `Unreleased` section already carries shipped-but-unreleased work (forced password change, goal un-archiving, skip-rule reporting, the About panel). Those entries are **absorbed into 1.1.0** — this is the release that ships them. The warranty entries are added under `Added`, plus a `Changed` note that backups are now `.tar.gz` archives including receipts and that older `.db` backups still restore.

**MUST-14.3** Settings → About needs no code change: it renders `CHANGELOG.md` from `process.cwd()` at request time and reads the version from the build-time constant.

---

## 15. Testing

Vitest, colocated under `tests/` mirroring the source layout, exactly as the existing suite does. **Every requirement above is stated so that it can be tested; the list below is the minimum, not the ceiling.**

### 15.1 Unit — `tests/lib/warranty/`, `tests/lib/dates.test.ts`

- **Expiry (`expiry.test.ts`, `dates.test.ts`):** all eight worked examples of §3.6 verbatim; a property check that `addMonthsClamped` never returns an invalid calendar date across months 1–120 from every day of 2024–2027; an explicit assertion that the result differs from `new Date(...).setMonth(...)` for Jan 31 + 1 month (the regression this rule exists to prevent); status derivation at all five outcomes including the exact boundaries `expiry = today` (→ `expiring`, coverage inclusive), `expiry = today - 1` (→ `expired`), `expiry = today + 60` (→ `expiring`), `expiry = today + 61` (→ `active`).
- **Suggestion heuristics (`suggest.test.ts`):** ISO / slash / `DD Mon YYYY` / `Mon D, YYYY` dates; the ambiguity ladder (`13/05/2026` → DD/MM, `05/13/2026` → MM/DD, `05/06/2026` → MM/DD default); future dates and >20-year-old dates discarded; earliest-occurrence tie-break; vendor picked past a leading phone number/`www.` line; TOTAL beating SUBTOTAL, last-total-line wins, largest-amount fallback; the $100,000 noise ceiling; empty text yields an empty suggestion object; every extractor returns cents as an integer.
- **FTS escaping (`search.test.ts`):** the six table rows of §9.1 exactly; a term containing `AND`/`OR`/`NOT`/`NEAR` matched as a word; unbalanced quote input produces a query SQLite accepts (executed against a real in-memory FTS5 table, not just string-compared); whitespace-only → `null`; the 20-term / 200-char caps.
- **Magic-byte sniffing (`sniff.test.ts`):** correct detection of all four types; a `.jpg`-named PNG detected as PNG; a `.pdf`-named ZIP rejected; a RIFF file that is not WEBP rejected; an empty buffer and a 3-byte buffer rejected; a text file declared `image/jpeg` by the client rejected.
- **Storage naming (`receipts.test.ts`):** `STORED_NAME_RE` rejects `../../etc/passwd`, `a/b.jpg`, `x.exe`, an uppercase-hex UUID, and a UUID with no extension; the resolve guard refuses a name that escapes the directory; sha256 matches a known fixture digest.
- **OCR assets (`ocr/assets.test.ts`):** MUST-7.5's three assertions; the `eng.traineddata.gz` sha256 constant; the construction call passes all four path options.
- **Archive (`tests/lib/backup-archive.test.ts`):** artifact type detection by magic bytes for gzip / SQLite / garbage; the extraction allow-list rejects `../evil`, `/etc/passwd`, a symlink entry and an unexpected top-level file.

### 15.2 Database — `tests/db/schema.test.ts`

- The migration applies cleanly on top of `0000` + `0001`; `_journal.json` idx/when/tag match MUST-3.2; the two new tables and every index exist.
- FTS5 is available and `sqlite_version() >= 3.43` (the `contentless_delete` floor).
- Every CHECK constraint rejects its violation: lifetime with months set; lifetime with an expiry; months set with expiry NULL; expiry set with months NULL; `warranty_months = 0`; negative `price_cents`; an out-of-list `mime`; an out-of-list `ocr_status`; `size_bytes = 0`; `size_bytes = 10485761`.
- Trigger coverage: insert item → one FTS row; update `name` → reindexed; update `updated_at` alone → **no** reindex; insert receipt with OCR text → item findable by a word from the receipt; update `ocr_text` → old text no longer matches, new text does; delete receipt → its text no longer matches but the item still does; delete item with two receipts → `count(*) FROM warranty_search = 0` (MUST-3.11).
- Deleting a `users` row is not attempted (users are deactivated, never deleted); deleting a `transactions` row sets `warranty_items.transaction_id` to NULL and leaves the item intact.

### 15.3 Integration — `tests/integration/warranty-flow.test.ts`, `tests/api/`

- **Upload → OCR → suggest → save**, end to end against a temp SQLite file with a **mocked engine** (MUST-7.17): stage a fixture JPEG → queue drains → sidecar written → suggestions returned → save with confirmed fields → file moved into `receipts/` → row inserted with the OCR text → item findable by a word that appears only on the receipt.
- **Save before OCR finishes:** commit with no sidecar → row is `pending` → the scheduler sweep enqueues it → completes → FTS updated.
- **OCR failure path:** engine throws → `failed` + error text stored → re-OCR resets to `pending` and succeeds on the second pass.
- **PDF:** a text-layer PDF fixture extracts and indexes; an image-only PDF fixture lands `failed` with the scanned-PDF message.
- **Search:** multi-word AND; prefix match on a partial model number; diacritic-insensitive match (`metro` finds `MÉTRO`); owner and status filters compose with the search; a query with `"` and `AND` returns results instead of throwing.
- **File route auth (`tests/api/warranty-receipt.route.test.ts`):** no session → 401; mismatched `Origin` → 403; **absent** Origin and `Sec-Fetch-Site` → 200 (the plain-HTTP LAN case); unknown id → 404; row present, file absent → 410; image → `inline`; PDF → `attachment`; `Content-Type` comes from the stored mime even when the file bytes are something else.
- **Upload route:** strict origin check rejects a mismatched Origin **and** a headerless POST; oversized `Content-Length` → 413; a single oversized part inside an acceptable total → 413 with **nothing** staged; six parts → rejected whole; a `.jpg`-named text file → 400; a valid upload → staged file present in `tmp` and an OCR job enqueued.
- **Backup with receipts:** create two items with receipts → build the archive → it contains `budget.db` and both files → restore into an empty data dir → database and both files present, sha256 unchanged, items searchable.
- **Old-backup restore:** a v1.0.0-shaped `.db` artifact restores → the pre-existing `receipts/` directory is untouched → a warranty row whose file is missing renders "file missing" and its route returns 410 → the restore tool reports the missing-file count.
- **Transaction link:** create a transaction via the import pipeline → create a warranty from it (prefill values asserted: date, `abs` price, vendor from the display description) → undo the import → the transaction is deleted, the warranty **survives** with `transaction_id IS NULL` (MUST-3.7).
- **Server actions (`tests/app/warranties-actions.test.ts`):** every mutating action rejects a cross-origin request **before** doing anything else; zod rejects a lifetime+months combination, a future purchase date, a name over 200 chars, a non-integer price; delete removes rows, files and FTS entries together.

### 15.4 Manual acceptance checks (documented QA checklist, run once per release)

Base §10's process stands: manual QA in lieu of a browser-automation suite.

- **A1 — offline OCR.** Run the container attached to a Docker network with `internal: true` (no egress). Upload a photographed receipt. OCR reaches `done`. *This is the check that proves MUST-7.3.*
- **A2 — asset presence in the image.** `docker run --rm --entrypoint node budget-tracker:latest -e "['vendor/tessdata/eng.traineddata.gz','node_modules/tesseract.js-core','node_modules/tesseract.js/src/worker-script/node/index.js','node_modules/pdfjs-dist'].forEach(p=>require('fs').accessSync(p))"` exits 0.
- **A3 — build-time guard.** Deleting one of those `COPY` lines makes `docker build` fail at `scripts/check-ocr-assets.mjs` (MUST-7.9).
- **A4 — hardened runtime.** With `read_only: true` and the tmpfs `/tmp` from `docker-compose.yml`, upload and OCR still succeed; no write is attempted outside `/tmp` and `/data`.
- **A5 — camera.** On iOS Safari and Android Chrome, the Add form's file control opens the rear camera directly (MUST-13.4). If it does not, apply the pre-approved `camera=(self)` remedy and re-test.
- **A6 — cross-version restore.** Take a backup on a v1.0.0 install, upgrade to v1.1.0, restore that `.db` artifact: the app boots, migrations apply, existing data is intact, `receipts/` is untouched.
- **A7 — ARM64.** The WASM core runs on a Raspberry Pi 5 / ARM64 Synology; record the wall-clock time for a single 3 MB receipt so INSTALL.md can set an honest expectation.

---

## 16. Out of scope (explicitly deferred)

1. **Expiry reminders of any kind** — no email, no push, no webhook. The dashboard widget and the list badge are the whole notification surface. (Base §1 already excludes email/push app-wide.)
2. **Thumbnails and image resizing** — no `sharp`, no native image dependency, no derived files. Browsers scale the full-size image with CSS; the `10 MB` cap keeps that honest.
3. **OCR of scanned PDFs** — text-layer extraction only (§7.6). A scan gets a clear failure message telling the member to photograph the receipt instead.
4. **Warranty claim tracking** — no claim status, no RMA numbers, no vendor correspondence log.
5. **Per-person private visibility** — every member sees every item (§1.3). Making a warranty private would be the app's first private-data surface and needs its own design.
6. **Editing OCR text** — the raw text is machine output, stored as-is. The user corrects the *fields*, which is what they actually care about.
7. **HEIC/HEIF** — not accepted. **Known limitation with workaround:** iPhones shooting in HEIC convert to JPEG automatically when a photo is uploaded through a web file input or taken via `capture`, so the ordinary phone path already works. A HEIC file dragged from a Mac's Photos library is the case that fails, and the message says: "HEIC isn't supported. On a Mac, open the image in Preview and export it as JPEG, or upload it from your phone instead."
8. Multi-language OCR (English only), barcode/QR extraction, automatic item-name suggestion, per-item reminders, sharing warranties between installs (base §11 packs), and warranty data in reports/CSV export.

---

## 17. Decisions taken on the user's behalf

Defaults chosen while writing this spec. Each is a single constant or a one-paragraph change if the owner wants it different.

1. **`EXPIRING_SOON_DAYS = 60`** — one exported constant driving the badge, the filter and the dashboard widget.
2. **`MAX_RECEIPT_BYTES = 10485760`** (10 × 1024², not 10,000,000).
3. **Clamp-to-last-day** month arithmetic with the eight worked examples in §3.6; a new `addMonthsClamped()` in `src/lib/dates.ts`.
4. **Coverage is inclusive of `expiry_date`** — expired means strictly after it.
5. **A fifth status, `unknown`**, for a non-lifetime item with no warranty term. The data model allows the state; the UI has to name it.
6. **FTS5 `content='' , contentless_delete=1`** instead of literal external-content, because external content binds to exactly one source table and this index spans two (§3.4).
7. **Tokenizer `unicode61 remove_diacritics 2`** so `metro` finds `MÉTRO`.
8. **Prefix `*` on the last search term only** — type-ahead without turning every word into a prefix scan.
9. **PDFs are served as `attachment`, images as `inline`** (§5.3), because a same-origin inline PDF runs the viewer's JavaScript in our origin.
10. **`pdfjs-dist` legacy build for PDF text**, `pdf-parse` rejected (unmaintained; require-time demo-file read).
11. **Backup artifact is `.tar.gz` via node-tar**, format detected on restore by **magic bytes**, restore implemented as a CLI helper plus the documented offline procedure — **no in-app restore button**.
12. **Receipt restore moves the existing directory aside** (`receipts.pre-restore-<ts>/`) rather than deleting it.
13. **Staged-upload flow with a `<uuid>.ocr.json` sidecar** so suggestions can pre-fill the form before the item row exists, and so a restart degrades to "no suggestions" instead of a lost upload.
14. **Missing OCR assets degrade rather than crash** — uploads keep working; jobs record `failed` with "OCR engine unavailable".
15. **`cacheMethod: 'none'`** for tesseract.js (nothing to write under a read-only rootfs).
16. **Exactly one multipart endpoint**; every other mutation is a server action (Next's 1 MB action body limit, §6.2).
17. **Any member may edit or delete any warranty item**, matching the household-trust model; `owner_user_id` is attribution and defaults to the creator.
18. **"Create warranty" is hidden on `is_transfer` rows.**
19. **Dashboard widget: top 5, hidden when empty, scoped by the existing person switcher.**
20. **No unique constraint on `transaction_id`** — one receipt can yield several warranties.
21. **`eng.traineddata.gz` vendored into the repo** (~15 MB) rather than pulled from an npm data package (§7.3).
22. **List page size 50; `MAX_FILES_PER_UPLOAD = 5`; ambiguous `A/B/YYYY` defaults to MM/DD; total-amount noise ceiling $100,000; `MAX_OCR_TEXT_CHARS = 100_000`; OCR timeout 120 s; OCR sweep every 10 minutes; staged-poll give-up at 3 minutes; idle worker terminated after 60 s.**
23. **v1.1.0 absorbs the existing `Unreleased` CHANGELOG entries** (forced password change, goal un-archiving, skip-rule reporting, About panel) — this is the release that ships them.
24. **`Permissions-Policy: camera=()` is left as-is** pending acceptance check A5, with `camera=(self)` pre-approved as the remedy if a phone blocks the capture control.
25. **`serial` is stored but not unique and not validated** — OCR mis-reads and blanks must both be storable.
26. **`price_cents` is a positive magnitude**, unlike `transactions.amount_cents`; §11 converts with `Math.abs`.
27. **Three new runtime dependencies** (`tesseract.js`, `pdfjs-dist`, `tar`) and no base-image change.
28. **`tessdata_fast` chosen over `tessdata_best`/standard (~15MB): 8x smaller image, faster cold OCR on Pi/NAS; accuracy trade accepted for receipt-search use. (recorded at final review)**
29. **Loans are dates and documents only — no balance, no payment schedule, no interest math.** A loan item type (v1.2.2, §19.12) reuses the exact same purchase/term/expiry triple as every other kind: start date, term in months, a computed "paid off by" date. Tracking a running balance or amortization would be a different feature (a lending tracker), not a generalization of the warranty/coverage tracker this spec builds. Deliberate scope cut, taken on the owner's behalf when the kind was requested.

---

## 18. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Next standalone tracing omits the WASM core, worker script, or traineddata → the library silently falls back to its CDN and OCR fails on an offline LAN | Explicit `COPY` lines (§7.4), a **build-time** asset check that fails `docker build` (MUST-7.9), a boot log line (MUST-7.6), and acceptance checks A1–A3 |
| R2 | `Permissions-Policy: camera=()` blocks the capture control on some phone browser | Acceptance check A5 with the pre-approved `camera=(self)` remedy (MUST-13.4) |
| R3 | Backup size growth: 14 nightly archives × a large receipt library | Retention is already configurable; the backups page shows archive size; INSTALL.md documents the arithmetic (§12.1) |
| R4 | WASM OCR is slow on ARM64 (a NAS or a Pi) | Concurrency 1, a Node worker so the event loop is free, the UI never blocks on OCR (MUST-10.2), a 120 s timeout, and acceptance check A7 records a real number for the docs |
| R5 | Tesseract's memory footprint on a 1 GB NAS | One reused worker, terminated after 60 s idle; concurrency 1 caps the peak at a single instance |
| R6 | A restore extracts a hostile archive | Entry allow-list plus node-tar's own protections, applied together (MUST-12.6) |
| R7 | FTS5 index drifts out of sync with the tables | Triggers are the only writer (MUST-3.12); the delete/insert reindex is idempotent; cascade ordering is proved by test (MUST-3.11) |

---

## 19. Addendum — item types and subscriptions (v1.1, mid-build)

**Status of this section.** Requested by the owner on 2026-08-16, after Tasks 1–3 of the implementation plan had already landed (`drizzle/0002_warranty_tracker.sql` is committed and therefore immutable). Everything here is **additive**: no section above is renumbered, no committed migration is edited, and no rule in §1–§18 is withdrawn. Where this section says something that §3–§10 does not mention, this section governs; where the two overlap, they agree by construction.

Two requirements:

1. A warranty item has a **type** — laptop, appliance, subscription, whatever the household needs — chosen from a list an **admin** maintains in the settings area.
2. **Subscriptions** are tracked in the same tracker, with a period start and end and a duration, and with a reminder to cancel before the period rolls over.

The second requirement is met with **no new columns**: a subscription is a warranty item whose type is flagged `is_subscription`, and the existing purchase/term/expiry triple already describes a subscription period exactly (§19.5).

### 19.1 Migration discipline

**MUST-19.1** This is migration **`drizzle/0003_warranty_item_types.sql`**, journal idx **3**, `when` **1755475200000**, tag `0003_warranty_item_types`. `0002` is committed and immutable; nothing in it is edited. The discipline of §3.1 applies unchanged and in the same fixed order: hand-author the SQL, append the journal entry, mirror in `src/db/schema.ts`. `drizzle-kit generate` is still never run.

**MUST-19.2** The journal entry appended to `drizzle/meta/_journal.json` is exactly:

```json
{ "idx": 3, "version": "6", "when": 1755475200000, "tag": "0003_warranty_item_types", "breakpoints": true }
```

**MUST-19.3** `0003` repeats the drizzle-kit warning header of `0000`/`0002` and **extends** the MUST-3.4 enumeration of objects that exist only in SQL. `0003` adds three: the `CHECK` constraints on `warranty_item_types`, the `COLLATE NOCASE` unique index on its `name`, and the fact that `warranty_items.type_id` arrives by `ALTER TABLE`. Statements are separated by `--> statement-breakpoint`, and — because Drizzle's splitter is comment-blind — that marker **never** appears inside a comment in the file.

### 19.2 `warranty_item_types`

```sql
CREATE TABLE `warranty_item_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_subscription` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	CHECK (`is_subscription` IN (0, 1)),
	CHECK (length(trim(`name`)) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warranty_item_types_name_uq` ON `warranty_item_types` (`name` COLLATE NOCASE);
```

- **`id`** — `integer PRIMARY KEY AUTOINCREMENT`, matching every other table in this schema (§3.2, §3.3, base §3). Ids are integers in this app; TEXT is for dates, timestamps and free text.
- **`name`** — required, trimmed by the application, 1–60 characters, **unique case-insensitively**. `Laptop` and `laptop` are the same type. Uniqueness is enforced by the `COLLATE NOCASE` unique index, and the app pre-checks with `where name = ? collate nocase` so the member sees "A type called 'Laptop' already exists." instead of a raw SQLite constraint message. **Known limit, accepted:** SQLite's `NOCASE` folds ASCII `A–Z` only, so `Café` and `CAFÉ` would both be storable. Household scale; not worth a custom collation.
- **`is_subscription`** — `INTEGER` 0/1 (the app's boolean convention; `CHECK` pins the domain). It is the **only** thing that distinguishes a subscription from a warranty anywhere in this feature.
- **`created_at`** — ISO datetime TEXT, as everywhere else.

**MUST-19.4 (seeded in the migration).** `0003` inserts three rows so the dropdown is never empty on first boot:

| `name` | `is_subscription` |
|---|---|
| Laptop | 0 |
| Appliance | 0 |
| Subscription | 1 |

`created_at` is the literal `'2026-08-16T00:00:00.000Z'` — a migration cannot call `nowIso()`, and a fixed timestamp keeps the migration deterministic and its test exact. The rows are ordinary rows: an admin may rename or delete them like any other.

### 19.3 `warranty_items.type_id`

```sql
ALTER TABLE `warranty_items` ADD COLUMN `type_id` integer REFERENCES `warranty_item_types`(`id`);
--> statement-breakpoint
CREATE INDEX `warranty_items_type_idx` ON `warranty_items` (`type_id`);
```

- **Nullable.** Type is optional: an item recorded before this feature existed, or one the member does not want to classify, has `type_id IS NULL` and behaves exactly as it does today. There is no "Uncategorised" row in the types table — NULL says it.
- **`ALTER TABLE ADD COLUMN` is legal here** with `foreign_keys = ON` (set on every connection, `src/db/client.ts`) precisely because the added column's default is NULL, which is SQLite's stated condition for adding a column carrying a `REFERENCES` clause.
- **No `ON DELETE` clause**, deliberately. See §19.4.
- **The column is appended physically**, as `must_change_password` was in `0001`; the Drizzle mirror declares it last on `warrantyItems` for the same reason and with the same style of docblock.
- **No trigger changes.** `warranty_search_item_au` fires `AFTER UPDATE OF name, vendor, model, notes` — `type_id` is not in that list, so changing an item's type does not re-tokenize its OCR blob. That is the intended behaviour (§19.8).

### 19.4 Deleting a type that is in use is blocked in the app layer

**MUST-19.5** `deleteItemType(id)` **refuses** when any `warranty_items` row references the type, and the refusal carries the count: *"3 items use this type. Change their type first, or rename this one."* The block is in the application layer, in `src/lib/warranty/types.ts`, as a typed error the server action catches and renders — not a stack trace and not a silent success.

**MUST-19.6** There is **no `ON DELETE CASCADE`** (it would delete warranty items — the evidence this whole feature exists to keep) and **no `ON DELETE SET NULL`** (it would silently strip the type off every affected item, which is a data change the admin did not ask for and cannot see). With no clause, SQLite's default `NO ACTION` makes an unguarded delete raise `FOREIGN KEY constraint failed` — the database is the backstop, the app-layer check is the user-facing behaviour, and both are tested.

**MUST-19.7** Renaming a type is always allowed, including while it is in use: the name is stored in exactly one place, so a rename is a single UPDATE with no fan-out and no reindex (§19.8). Toggling `is_subscription` is likewise always allowed and takes effect immediately on every item of that type — that is the point of putting the flag on the type rather than on the item.

### 19.5 Subscriptions reuse the warranty fields verbatim

**MUST-19.8** A subscription introduces **no new date columns and no new table**. The existing fields carry the subscription period:

| Warranty field | Read as, when the item's type has `is_subscription = 1` |
|---|---|
| `purchase_date` | subscription period **start** |
| `warranty_months` | subscription **duration** in months |
| `expiry_date` | subscription period **end** — the date to cancel by |
| `is_lifetime` | a perpetual/never-expiring subscription; unchanged semantics (MUST-3.5: months and expiry both NULL) |
| everything else (`name`, `vendor`, `price_cents`, `owner_user_id`, `notes`, receipts, `transaction_id`) | unchanged |

Every rule already written keeps working with no special case: `expiry_date` is still computed at write time by `addMonthsClamped()` (MUST-3.6, and the clamp is *right* for subscriptions — a 1-month subscription started Jan 31 ends Feb 28); coverage is still inclusive (MUST-3.14); the CHECK constraints of §3.2 still hold; a receipt is still a receipt.

**MUST-19.9 (cancel reminders are the existing expiring-soon mechanics, nothing more).** "Remind me to cancel" is served by what §3.7 and §10.5 already build: `EXPIRING_SOON_DAYS = 60`, the derived `expiring` status, the list badge and filter, and the dashboard widget. **No scheduler tick, no email, no push, no per-item reminder date** — §16 item 1 stands for subscriptions exactly as it stands for warranties. The only thing that changes is the words on screen (§19.6).

### 19.6 UI wording keyed on `is_subscription`

**MUST-19.10** When an item's type has `is_subscription = 1`, the surfaces that talk about expiry switch nouns:

| Surface | Warranty wording | Subscription wording |
|---|---|---|
| List row / expiry column | `expires 2027-03-01` | `cancel by 2027-03-01` |
| Status badge, `expiring` | `Expires in 12 days` | `Cancel in 12 days` |
| Dashboard widget row | `expires in 12 days` | `cancel by 2027-03-01` |
| Detail page, date labels | Purchase date / Warranty length / Covered through | Period start / Period length / Cancel by |
| Add & edit form, live computed date | `Covered through 2027-03-01` (MUST-10.4) | `Cancel by 2027-03-01` |

**MUST-19.11** The rule lives in **one** place — `expiryNoun(isSubscription): 'expires' | 'cancel by'` and its siblings in `src/lib/warranty/constants.ts`, a **pure, client-safe module that imports no database code** (Ruling P4 precedent: anything a client component imports must not drag `better-sqlite3` into the bundle). Every list, badge, widget and detail row calls that helper; no component hard-codes either verb.

**MUST-19.12** The status *derivation* is untouched. `warrantyStatus()`, `STATUS_CASE_SQL` and `EXPIRING_SOON_DAYS` in `src/lib/warranty/expiry.ts` do not learn about subscriptions — a subscription that ends in 12 days is `expiring`, exactly like a warranty. Only the label changes. This keeps the filter, the counts, the SQL and the badge in the single agreement §3.7 exists to guarantee.

### 19.7 Type in the rest of the UI

**MUST-19.13** Type appears as:

- an **optional dropdown** on the add and edit forms (`— none —` plus every type, ordered by name, case-insensitively);
- a **column and a filter** on the warranties list (`?typeId=` alongside the existing `?q=`, `?status=`, owner and sort parameters — filtering composes, it does not replace);
- a **badge** on each dashboard-widget row, so "Netflix — cancel by 2027-03-01" reads as a subscription at a glance.

**MUST-19.14 (admin-only management page).** `/settings/item-types`, listed under **Administration** in Settings as "Item types", implemented as `src/app/(app)/settings/item-types/{page.tsx, actions.ts, item-types-manager.tsx}` and gated exactly the way `settings/users` is gated: `await requireAdmin()` in the page, `await requireAdmin()` in every action, and the Settings index link rendered only for `role === 'admin'`. Non-admins never see the entry and cannot reach the actions. The page supports: list (with a usage count per type), add, rename, toggle `is_subscription`, and delete — delete refusing with the count message of MUST-19.5. Every mutating action calls `isSameOrigin(await headers())` **first** (MUST-13.1), validates with zod (MUST-13.7), and `revalidatePath('/settings/item-types')` on success.

**MUST-19.15** Choosing, changing or clearing an item's type is **not** an admin action — any member may do it on any item, matching the household-trust model of §1.3. Only the *list of types* is admin-maintained.

### 19.8 The type name is deliberately **not** in the FTS index

**MUST-19.16** `warranty_search` is unchanged: five columns (`name`, `vendor`, `model`, `notes`, `ocr_text`), six triggers, no seventh. Type name is **not** indexed, and no trigger is added on `warranty_item_types`.

Three reasons, in order of weight:

1. **A type is a filter, not search text.** The list already offers a type filter (MUST-19.13); indexing the name would make typing `laptop` also return every laptop, drowning the item actually named "Laptop stand" in a result set the member cannot narrow.
2. **A rename must stay a single UPDATE.** If the name were indexed, renaming a type would have to reindex every item of that type — an FTS rebuild fanning out over rows whose OCR blobs may run to 100 000 characters each (MUST-3.10's cap), triggered by an admin edit that changed nothing about those items. Keeping it out means a rename touches exactly one row.
3. **The index would need a seventh trigger** on a table whose entire purpose is a 3-row lookup list, for no search the type filter does not already answer.

### 19.9 Drizzle mirror

**MUST-19.17** `warrantyItemTypes` is appended at the **end** of `src/db/schema.ts` (after `warrantyReceipts`, mirroring DDL order per MUST-3.15), and `typeId` is added as the **last** property of `warrantyItems` with a docblock explaining that `ALTER TABLE ADD COLUMN` appends physically — the same convention and the same reasoning as `users.mustChangePassword`. The `CHECK` constraints and the `COLLATE NOCASE` on the unique index have no Drizzle representation and are named in the docblock, per MUST-3.4/MUST-19.3.

### 19.10 Testing additions

On top of §15, all binding:

- **Migration (`tests/db/warranty-item-types.test.ts`):** journal idx 3 / `when` 1755475200000 / tag / `breakpoints: true` exactly; the file contains `--> statement-breakpoint` and extends the SQL-only enumeration; `warranty_item_types` exists after `createTestDb()`; `warranty_items_type_idx` and `warranty_item_types_name_uq` exist; **the three seeded rows are present after migration** with the right `is_subscription` flags and nothing else; a duplicate name differing only in case is rejected by the unique index; `is_subscription = 2` and a blank/61-character name are rejected by their CHECKs; `type_id` accepts NULL, accepts a real id, and rejects an unknown id with `FOREIGN KEY constraint failed`; deleting a referenced type raises `FOREIGN KEY constraint failed` at the database level (the backstop behind MUST-19.5); the existing whole-schema assertions in `tests/db/schema.test.ts` are extended (`warranty_item_types` sorts **before** `warranty_items` under SQLite's binary `order by name`).
- **Types library (`tests/lib/warranty/types.test.ts`):** create / list / rename / toggle / delete round-trip; name trimmed; empty and 61-character names rejected by zod; case-insensitive duplicate rejected with a readable message on both create and rename; `listItemTypes()` ordered case-insensitively by name; `typeUsageCount()` counts only items of that type; **`deleteItemType()` on a type used by two items throws the typed in-use error carrying `count === 2`**, and the type and both items are still there afterwards; deleting an unused type succeeds; rename succeeds *while* the type is in use and the items keep pointing at it.
- **Wording (`tests/lib/warranty/constants.test.ts`):** `expiryNoun(true) === 'cancel by'`, `expiryNoun(false) === 'expires'`, and the subscription/warranty phrase swap for the list, detail and widget strings — asserted on the helper, and asserted again at the component level in the T9/T10 tests so a hard-coded verb cannot creep back in.
- **Actions (`tests/app/item-types-actions.test.ts`):** every mutating action rejects a cross-origin request **before** touching the database, and rejects a non-admin caller.

### 19.11 Decisions taken on the owner's behalf in this addendum

Extending §17, same rules — each is one constant or one paragraph if the owner wants it different.

28. **Integer primary key** for `warranty_item_types`, matching every other table (the request said "match §3's conventions"; §3's convention for ids is integer, for dates and timestamps TEXT).
29. **`warranty_items_type_idx`** added alongside the column, so the type filter and the in-use count are indexed lookups rather than table scans — the same reasoning that gave `owner_user_id` and `transaction_id` their indexes in §3.2.
30. **Three seeded types only** (Laptop, Appliance, Subscription), created and deletable like any other row; the seed exists so the first dropdown is not empty, not to be a taxonomy.
31. **`NOCASE` uniqueness is ASCII-only** — accepted (§19.2).
32. **The wording rule is a helper, not a column** — `expiryNoun()` in the client-safe `src/lib/warranty/constants.ts`; no denormalised "is_subscription" copy on `warranty_items`, so toggling the flag on a type is instantly correct everywhere.

### 19.12 Amendment (v1.2.2) — the tracker generalizes to "Contracts & Coverage": kinds

**Status of this amendment.** Requested by the owner on 2026-08-17, after v1.2.0/v1.2.1 shipped. Everything here is **additive** on top of §19: the boolean `is_subscription` flag from §19.2 is **not removed** — it is kept for old readers and is now *derived from* the new `kind` column below, maintained in lockstep on every write. No rule in §1–§19.11 is withdrawn.

**The change.** A type's single boolean (subscription / not-subscription) becomes a four-value **`kind`**: `warranty`, `subscription`, `contract`, `loan`. The household's use case grew from "warranties and subscriptions" to "anything with a start date and a term that eventually needs attention" — a phone contract, a car loan — and all three already fit the existing purchase/term/expiry triple (§19.5) without a new column.

**Migration `drizzle/0004_item_type_kinds.sql`** (journal idx 4, `when` 1755561600000): adds `kind TEXT NOT NULL DEFAULT 'warranty' CHECK (kind IN ('warranty','subscription','contract','loan'))` to `warranty_item_types` by `ALTER TABLE ADD COLUMN` (same legality argument as §19.3's `type_id`); backfills `kind = 'subscription'` for every row where `is_subscription = 1`; seeds `Contract` (`kind = 'contract'`) and `Loan` (`kind = 'loan'`), each guarded by `INSERT ... SELECT ... WHERE NOT EXISTS (... COLLATE NOCASE)` so a household that already created its own type named "Contract" or "Loan" before upgrading never gets a silent duplicate.

**Collision outcome, spelled out (reviewer Issue 3).** The NOT EXISTS guard is a skip, not a merge or a promotion: if a household's own pre-existing type is literally named "Contract" (case-insensitively), the seed insert for `kind = 'contract'` is skipped entirely, and that pre-existing row is **never reclassified by name**. It keeps whatever `kind` the plain `ALTER TABLE ADD COLUMN` default gave it (`'warranty'`, unless it happened to also have `is_subscription = 1`, in which case the backfill above already promoted it to `'subscription'`) — the household's own row survives untouched, and no duplicate "Contract" row is ever added. Verified directly in `tests/db/warranty-item-type-kinds.test.ts`'s upgrade-path suite. `created_at` for the two new seeds is the literal `'2026-08-17T00:00:00.000Z'`, same discipline as §19.2's three original seeds.

**The wording matrix (`src/lib/warranty/constants.ts`)**, per kind — start-date label / term-length label / end-date label / expiry verb / covered-through label / open-ended label:

| Kind | Start date label | Term label | End date label | Expiry verb | Covered-through label | Open-ended label |
|---|---|---|---|---|---|---|
| `warranty` | Purchase date | Warranty (months) | Expiry date | expires | Covered through | Lifetime warranty |
| `subscription` | Start date | Duration (months) | Cancel-by date | cancel by | Active through | Ongoing (no end date) |
| `contract` | Start date | Term (months) | End date | ends on | In effect through | Open-ended |
| `loan` | Start date | Term (months) | Payoff date | paid off by | Term runs through | Ongoing (no end date) |

Helpers: `formStartLabel(kind)`, `formTermLabel(kind)`, `formEndLabel(kind)`, `formOpenEndedLabel(kind)`, `coveredThroughLabelForKind(kind)`, `expiryNounForKind(kind)`, `expiryPhraseForKind(kind, date)`, `expiringSoonLabelForKind(kind, days)`.

**Reviewer Issue 1, resolved by controller ruling.** The first cut of this amendment (Task 1) claimed the pre-existing boolean helpers would "become thin wrappers" over the kind matrix without naming which ones, while `purchaseDateLabel`/`termLabel`/`expiryDateLabel`/`coveredThroughLabel` kept their own separate hand-written bodies unchanged — leaving MUST-19.11's "one place" rule broken twice over (the boolean helpers and the kind helpers each independently hard-coding wording), and the pages still calling the boolean four directly with old wording (including two literal, un-routed `<legend>Warranty length</legend>` occurrences in `new-warranty-client.tsx` and `warranty-detail-client.tsx`). **Only three** boolean helpers are actually kept, as thin wrappers producing byte-identical output (`isSubscription ? 'subscription' : 'warranty'`): `expiryNoun` → `expiryNounForKind`, `expiryPhrase` → `expiryPhraseForKind`, `expiringSoonLabel` → `expiringSoonLabelForKind`. **The other four are DELETED, not wrapped** — `purchaseDateLabel`, `termLabel`, `expiryDateLabel`, `coveredThroughLabel` no longer exist; every call site (the add form, the edit form, the detail page's read-only summary, and the two hard-coded legends) is routed through the kind matrix instead. The owner approved the resulting wording changes as deliberate:

| Deleted helper (boolean) | Superseded by (kind-keyed) | Warranty text | Subscription text: old → new |
|---|---|---|---|
| `purchaseDateLabel` | `formStartLabel` | Purchase date (unchanged) | 'Period start' → **'Start date'** |
| `termLabel` | `formTermLabel` | 'Warranty length' → **'Warranty (months)'** | 'Period length' → **'Duration (months)'** |
| `expiryDateLabel` | `formEndLabel` | Expiry date (unchanged) | 'Cancel by' → **'Cancel-by date'** |
| `coveredThroughLabel` | `coveredThroughLabelForKind` | Covered through (unchanged) | 'Cancel by' → **'Active through'** |

`contract` and `loan` have no prior wording to compare — they are new. The full old→new log, with every changed test assertion, is in `tests/lib/warranty/constants.test.ts`.

**`setItemTypeSubscription(id, isSubscription)` is superseded by `setItemTypeKind(id, kind)`** — same MUST-19.7 rule (always allowed, takes effect immediately on every item of that type), now writing `kind` and the derived `is_subscription` in the same statement so they can never drift apart.

**Admin page** (`/settings/item-types`): the subscription checkbox becomes a `kind` `<select>` with four human-labelled options, on both the "add a type" form and each row's kind control. MUST-19.14's other guarantees (admin-only, cross-origin check first, zod validation, `revalidatePath`) are unchanged.

**Loans carry no balance.** See §17 item 29: a loan type is dates and documents only, exactly like every other kind — no payment schedule, no running balance, no interest math. That is a deliberate scope cut, not a deferred feature.

### 19.13 Amendment continued (v1.2.2 Task 2) — wording rollout and the section rename

Task 1 above built the migration, the library and the admin page as a foundation; this task wires the kind matrix into every surface that renders a warranty item, and renames the section.

**Section rename, labels only.** The nav item, the list page title and the add-page header change from "Warranties"/"Add warranty" to **"Contracts & Coverage"**/**"Add item"** — routes are unchanged (`/warranties`, `/warranties/new`, `/warranties/[id]`), and so are every action name, form field `name`, and server action contract. `AppShell`'s nav rail and mobile menu already render every label inside a `truncate` span; there is no separate short-label mechanism on `NavItem`, and this amendment does not add one — the longer label relies on that existing ellipsis behaviour, a deliberate choice over adding a second label field for one nav entry. The empty state on the list page changes from "No warranties yet" to **"Nothing tracked yet — add a warranty, subscription, contract, or loan..."**; the dashboard widget retitles from "Warranties expiring soon" to **"Coming due"**; the search placeholder broadens from "Any word on the receipt" to "Any word on the receipt or document"; "Back to warranties" becomes "Back to items" on the add and detail pages.

**Kind-driven rendering.** `WarrantiesClient` (list), `WarrantyDetailClient` (detail, both the read-only summary and the edit form), `ExpiringSoonCard` (dashboard widget) and `NewWarrantyClient` (add form) all read `row.kind` / `item.kind` / the selected type's `kind` instead of `isSubscription`. `StatusBadge` takes a `kind?: ItemKind` prop (default `'warranty'`), superseding its `isSubscription?: boolean` prop, and calls `expiringSoonLabelForKind`. The dashboard widget's day-count-vs-date split from MUST-19.10 generalizes unchanged: `warranty` stays a day count ("Expires in 12 days"); `subscription`/`contract`/`loan` all show the end date instead (`expiryPhraseForKind`, capitalized) — the split is on `kind === 'warranty'`, not on a subscription flag.

**Dynamic form labels.** On both the add form and the edit form, the Purchase-date field label, the term-length `<legend>` and the Lifetime checkbox's own label text all follow the **currently selected type's kind live** (tracked in a small piece of component state — `typeId`, looked up against the `types` list on every render), not just the item's already-saved kind. Choosing no type, or a warranty-kind type, reads as plain warranty wording. This closes reviewer Issue 1's other half: the edit form's type `<select>` was previously uncontrolled (`defaultValue` only), which is fine for submission but cannot drive a live label — it is now a controlled input (`value`/`onChange`) with the same `name="typeId"` and the same preselect behaviour as before.

---

## 20. GUI restore-on-next-start (v1.2.0)

**Status of this section.** Requested and approved by the owner on 2026-08-16, after v1.1.0 shipped (commit `1d0fcd1`). Everything here is **additive**: no section above is renumbered, no committed migration is edited, and **no rule in §1–§19 is withdrawn** — with exactly one amendment, stated plainly so it cannot be missed:

> **§12.2 / §17.11 said "there is deliberately no in-app restore button."** That sentence is **superseded** by this section. The reason behind it is *not* withdrawn: restoring under a live SQLite connection still corrupts a database, and this feature never does that. The button does not restore anything. It **validates** an artifact, **stages** it, and **stops the process**; the restore itself is performed by the next boot, **before a single database connection is opened**. MUST-12.4's real invariant — *the database is never replaced while it is open* — holds exactly as before, and is now enforced by the code path rather than by a paragraph in INSTALL.md.

The CLI (`scripts/restore-backup.ts`) **remains, unchanged in behaviour and still documented**, as the disaster fallback for the one case the GUI cannot serve: the app does not boot at all, so there is no Settings page to click.

### 20.1 What this feature is

**MUST-20.1** Settings → Backups gains a **Restore** control on every listed backup row (both `budget-YYYY-MM-DD.tar.gz` and legacy `budget-YYYY-MM-DD.db` — MUST-12.3 already lists both, and both restore). Activating it opens an inline confirm step; confirming stages the restore and restarts the app; the restore is applied on the way back up.

**MUST-20.2** The **only** artifacts that can be restored through the GUI are files **already present in `${DATA_DIR}/backups`** whose names match `ARCHIVE_NAME_RE` or `LEGACY_NAME_RE`. There is **no upload**, no path input, no URL, no "restore from elsewhere". The client sends a *filename*, never a path, and that filename is resolved through the existing `resolveSafeTarget()` (§12.1's controller ruling (b)) before any `fs` call touches it. Restoring an arbitrary file remains a CLI-only, shell-access-only operation.

**MUST-20.3** No schema change. The marker and the result are **files** under `${DATA_DIR}`, not tables: the boot hook has to read them *before* the database exists in a usable state, and a file is both cheaper and readable with `cat` when something has gone wrong. The hand-authored-migration discipline of §3.1/§19.1 is untouched because there is nothing to migrate.

### 20.2 Shared code — resolving the CLI's no-src-imports rule

The tension, stated exactly: the boot hook runs **inside** Next's standalone bundle (it may import `@/…`, it may not import a loose `.ts` file at runtime); the CLI runs **outside** it, under `node --experimental-strip-types`, in an image that ships no `src/` tree (MUST-12.4's amended note, the same constraint `scripts/reset-admin-password.ts` lives under). Neither may import the other.

**MUST-20.4** The resolution is **extraction, not duplication**. A single module `scripts/restore-core.ts` holds every piece of restore logic that both sides need. It is:

- **alias-free** — it imports only from `node:*`, `better-sqlite3`, `tar`, and relative siblings. **No `@/…` import may ever appear in it**, and MUST-20.42 makes that a test, not a convention.
- **parameterised, never environment-reading** — it takes `dataDir`, `scratchDir` and `migrationsFolder` as arguments. It never calls `readEnv()`, never reads `process.env`, never calls `process.cwd()`.
- **erasable-syntax only** — no `enum`, no `namespace`, no parameter properties, and type-only imports written as `import type`, because `--experimental-strip-types` erases rather than compiles.

`scripts/restore-backup.ts` becomes a thin CLI shell over it and **re-exports its existing public surface** (`RESTORE_STORED_NAME_RE`, `RestoreError`, `ArtifactKind`, `detectArtifactKind`, `restoreFromArtifact`, `RestoreResult`) so `tests/scripts/restore-backup.test.ts` keeps passing **unmodified** — that file is the regression net for the security properties being moved, and it must not be rewritten in the same change that moves them.

**MUST-20.5** The app side reaches `restore-core.ts` through one thin wrapper, `src/lib/backup/restore.ts`, which is the *only* file in `src/` allowed to import from `scripts/`. The wrapper's whole job is to supply the three parameters (`readEnv().dataDir`, a scratch path, `migrationsFolder()` from `@/db/client`) and to own the state machine of §20.6. Importing `@/db/client` for `migrationsFolder()` does **not** open a database — `src/db/client.ts` is lazy (`instance` stays `null` until `ensureInstance()`), and MUST-20.42 pins that.

**MUST-20.6** The existing pin test stays and is extended: `RESTORE_STORED_NAME_RE` must be `.source`-equal to `STORED_NAME_RE` in `src/lib/warranty/receipts.ts`. That equality is now the *only* remaining deliberate duplication in the restore path, and it exists solely because the CLI cannot import `src/`.

**MUST-20.7** `restore-core.ts` splits the existing monolithic `restoreFromArtifact()` into a **prepare / commit pair**, and `restoreFromArtifact()` is re-expressed in terms of them so the CLI's observable behaviour is bit-for-bit what it is today (amended T1: CLI gains safety copy, preflight, and `--allow-newer`; recorded deviations):

```ts
export function prepareRestore(
  artifactPath: string,
  opts: { dataDir: string; scratchDir: string; migrationsFolder: string; now: Date },
): RestorePlan;              // extracts, validates, builds the incoming files. Touches NO live path.

export function commitRestore(
  plan: RestorePlan,
  opts: { dataDir: string },
): RestoreResult;            // replays plan.steps. Every step is individually idempotent.

export function restoreFromArtifact(       // unchanged signature, unchanged behaviour
  artifactPath: string,
  opts: { dataDir: string; now?: Date },
): RestoreResult;            // = prepare + commit + rm -rf scratch, in a finally
```

`prepareRestore()` is **provably non-mutating with respect to live data**: it writes only inside `scratchDir`. That property is what makes the crash-safety argument of §20.7 short enough to be true.

### 20.3 On-disk layout

**MUST-20.8** Exactly these paths, all directly under `${DATA_DIR}`:

```
${DATA_DIR}/
  budget.db                                   the live database (unchanged)
  backups/                                    (unchanged)
  receipts/                                   (unchanged)
  tmp/
    <uuid>-restore/                           staging under construction; NOT yet a request
      payload                                 the artifact, hard-linked from backups/ (copy fallback)
      restore-request.json                    the marker
  restore-staged/                             a committed request, waiting for the next boot
    payload
    restore-request.json
  restore-applying/                           a request the current boot has claimed
    payload
    restore-request.json
    commit.json                               the rename journal (§20.7) — its EXISTENCE is the point of no return
    work/                                     prepareRestore()'s scratch: extracted archive, budget.db.incoming, receipts.incoming/
  restore-failed-<stamp>/                     an attempt that exhausted its retries; kept for forensics, NEVER retried
  restore-result.json                         the outcome of the last boot-time restore (what Settings reads)
  budget.pre-restore-<stamp>.db               safety copy of the database (+ -wal, -shm siblings if they existed)
  receipts.pre-restore-<stamp>/               safety copy of receipts (archive restores only) — the §12.8 convention, reused
```

`<stamp>` is `now.toISOString().replace(/[:.]/g, '-')`, the format `restore-backup.ts` already uses.

**MUST-20.9** Staging is built at `${DATA_DIR}/tmp/<uuid>-restore/` and **committed by renaming that whole directory** to `${DATA_DIR}/restore-staged/`. One `rename(2)` on the same filesystem is the single atomic commit point: `restore-staged/` either does not exist, or exists complete. There is no window in which a marker names a payload that is not fully written.

**MUST-20.10** At most **one** restore may be staged or applying at a time. Staging refuses if either `restore-staged/` or `restore-applying/` exists.

### 20.4 The marker and the result — exact shapes

**MUST-20.11** `restore-request.json`:

```json
{
  "version": 1,
  "payload": "payload",
  "sourceName": "budget-2026-08-16.tar.gz",
  "kind": "archive",
  "bytes": 41238912,
  "sha256": "9f2c…",
  "appliedMigrations": 4,
  "requestedByUserId": 3,
  "requestedByUsername": "meena",
  "requestedAt": "2026-08-16T21:04:11.482Z",
  "appVersion": "1.2.0"
}
```

`version` is a hard gate: a marker whose `version` is not `1` is refused at boot (recorded, cleared, boot continues) rather than guessed at. Every field is validated by a zod schema on read — the file is inside `${DATA_DIR}`, which is a bind mount the owner can edit, so it is **untrusted input** exactly like a user upload.

**MUST-20.12** `restore-result.json`:

```json
{
  "version": 1,
  "status": "success",
  "sourceName": "budget-2026-08-16.tar.gz",
  "kind": "archive",
  "requestedByUserId": 3,
  "requestedByUsername": "meena",
  "requestedAt": "2026-08-16T21:04:11.482Z",
  "finishedAt": "2026-08-16T21:04:53.106Z",
  "safetyCopy": "budget.pre-restore-2026-08-16T21-04-49-772Z.db",
  "receiptsMovedAside": "receipts.pre-restore-2026-08-16T21-04-49-772Z",
  "receiptsRestored": 128,
  "missingReceiptRows": 0,
  "receiptsTouched": 0,
  "error": null
}
```

`status` is `"success"` or `"failed"`; on `"failed"`, `error` carries a **written, operator-readable** sentence (never a stack trace, never a raw `errno`) and the mutation-bearing fields are whatever actually happened — on a validation failure they are all `null`/`0`, because nothing happened.

**MUST-20.13** Both files are written **atomically**: to a `.partial` sibling, then `rename`d into place. A half-written `restore-result.json` must never be readable by the Settings page.

### 20.5 Validation — everything, before anything is staged

**MUST-20.14** `validateArtifact(artifactPath, { scratchDir, migrationsFolder })` in `restore-core.ts` runs the **complete** check set and returns a `ValidationReport`. It is called **twice**: once by the server action before staging, and again by the boot hook before applying. The second call is not paranoia — the payload has survived a process restart and a filesystem in between.

The checks, in order, all of them fatal:

1. **Existence and shape.** The file exists, is a regular file, and is non-empty.
2. **Magic bytes (MUST-12.5, unchanged).** `1F 8B` → `archive`; `SQLite format 3\0` → `sqlite`; anything else → refuse. **Never** the file extension.
3. **Tar entry allow-list (MUST-12.6, unchanged).** `assertArchiveEntriesAreSafe()` — a first pass over the listing, before a byte is written: only `budget.db` (File), `receipts` (Directory) and `receipts/<RESTORE_STORED_NAME_RE>` (File) are accepted; every accepted name also pins the expected entry **type**; absolute paths, `..` segments, symlinks, hardlinks and device nodes abort the whole restore. node-tar's own protections are relied on **in addition to** this, not instead of it.
4. **Extract to scratch** (archive only), into `scratchDir`, `preservePaths: false`.
5. **SQLite preflight of the contained `budget.db`** (extended from today's magic-byte-only check):
   - magic bytes are `SQLite format 3\0` (a well-formed tar can carry a `budget.db` entry that is a File full of garbage);
   - it opens `readonly` and `PRAGMA quick_check` returns exactly `ok`;
   - `sqlite_master` contains at minimum the tables `users`, `accounts` and `transactions` — i.e. it is *a Budget Tracker database*, not some other SQLite file that happened to be renamed.
6. **The one-way guard** of §20.5.1.

**MUST-20.15** Validation failures return a **written error to the UI** and stage nothing. The scratch directory is removed in a `finally`. No path under `${DATA_DIR}` other than `tmp/<uuid>-restore/` is touched, created or renamed by a failed validation — this is testable and MUST-20.36 tests it.

#### 20.5.1 The one-way rule, made checkable

**MUST-20.16** The rule of §12.4 is unchanged in intent (restore is one-way; downgrading is not supported) and is now **enforced at validation time** instead of only being documented:

- Drizzle's better-sqlite3 migrator records applied migrations in `__drizzle_migrations (id, hash, created_at)`, where `created_at` is the migration's `folderMillis` — i.e. **exactly the `when` value** in `drizzle/meta/_journal.json`. This is a stable, inspectable fact about a backup, readable with a `readonly` connection and no migration run.
- Let `localMaxWhen` / `localCount` be the maximum `when` and the entry count in the **running code's** `drizzle/meta/_journal.json`, and `backupMaxWhen` / `backupCount` the same from the backup's `__drizzle_migrations`.
- **Refuse the restore if `backupMaxWhen > localMaxWhen` or `backupCount > localCount`.** Message: *"This backup was made by a newer version of Budget Tracker than the one running (it carries N applied migrations; this version ships M). Upgrade the app first, then restore."*
- A missing `__drizzle_migrations` table counts as `0`/`0` and is **allowed** — that is a pre-migrator or hand-made database, and forward migration is exactly what should happen to it.
- **Older backups need no guard at all.** Migrations run forward on the very next `getDb()` call, after the restore, on the boot that applied it (MUST-20.24). That is the honest answer to "restoring an old backup", and it is why nothing here tries to *downgrade* anything.

Both conditions are checked because either alone can be fooled: `when` alone misses a same-day migration added after the local one, and `count` alone misses a reordered journal. Together they are the strongest statement that can be made **before** a migration has run, which is the only moment at which it can be made.

### 20.6 The state machine

**MUST-20.17** Exactly four states, and the transition into each is a single atomic filesystem operation:

```
  (none)
     │  server action: validate → build tmp/<uuid>-restore/ → RENAME to restore-staged/
     ▼
  STAGED            restore-staged/ exists
     │  boot hook: revalidate → RENAME to restore-applying/
     ▼
  APPLYING          restore-applying/ exists, commit.json ABSENT   → prepare phase, live data provably untouched
     │  prepare succeeds → WRITE commit.json  (the point of no return)
     ▼
  COMMITTING        restore-applying/ exists, commit.json PRESENT  → replaying renames, resumable
     │                                    │
     │ all steps done                     │ attempts exhausted (3)
     ▼                                    ▼
  DONE                                 FAILED
  write restore-result.json,           write restore-result.json (status failed, recovery text),
  rm -rf restore-applying/             RENAME restore-applying/ → restore-failed-<stamp>/
```

**MUST-20.18** The boot hook is the only reader of `STAGED` and the only writer of every other transition. It runs **before any database connection is opened** — see §20.8.

**MUST-20.19 (no boot loops, ever).** The transition `STAGED → APPLYING` is a rename, so a given staged request is claimed **exactly once**. If a boot finds `restore-applying/` **without** `commit.json`, the previous attempt died during prepare — live data is provably untouched (MUST-20.7) — and the attempt is **discarded outright**: recorded as failed, `rm -rf`, boot continues. It is never re-prepared. If a boot finds `restore-applying/` **with** `commit.json`, it resumes the commit (§20.7) under a hard attempt cap. There is no path on which the same request is prepared twice, and no path on which a failure re-arms itself.

**MUST-20.20** The boot hook **never throws**. Its entire body is wrapped; any unanticipated error is logged, recorded in `restore-result.json` on a best-effort basis, and swallowed. A container that will not boot is a worse outcome than a restore that did not happen, and this is the same reasoning MUST-7.6 already applies to the OCR assets.

### 20.7 The commit journal — why a SIGKILL cannot produce a mixture

**MUST-20.21** `prepareRestore()` produces a `RestorePlan` whose `steps` are a **totally ordered list of individually idempotent filesystem operations**, every path absolute and fixed at plan time (so a replay reuses the same `<stamp>`):

```ts
type RestoreStep =
  | { op: 'unlink'; path: string }                    // budget.db-wal, budget.db-shm  (MUST-12.7)
  | { op: 'rename'; from: string; to: string; optional?: boolean }
  | { op: 'touch-receipts'; dir: string };            // the MUST-12.9 mtime re-arm, bare-db restores only
```

For an **archive** restore, in this exact order:

| # | Step |
|---|---|
| 1 | `rename budget.db → budget.pre-restore-<stamp>.db` *(optional: absent on a first-run install)* |
| 2 | `rename budget.db-wal → budget.pre-restore-<stamp>.db-wal` *(optional)* |
| 3 | `rename budget.db-shm → budget.pre-restore-<stamp>.db-shm` *(optional)* |
| 4 | `rename receipts → receipts.pre-restore-<stamp>` *(optional)* — the §12.8 non-destructive rule, reused verbatim |
| 5 | `rename work/receipts.incoming → receipts` |
| 6 | `rename work/budget.db.incoming → budget.db` |

For a **bare-db** restore: steps 1–3, then `rename work/budget.db.incoming → budget.db`, then `touch-receipts receipts/`. **`receipts/` is never renamed, emptied or modified** — MUST-12.9, unchanged, and the mtime re-arm exists for exactly the reason its docblock in `restore-backup.ts` already gives.

**MUST-20.22 (idempotent replay).** Each step is executed only if it has not already happened, decided from the filesystem, not from a flag:

- `rename`: if `from` exists → rename. Else if `to` exists → already done, skip. Else if `optional` → skip. Else → hard error.
- `unlink`: `rmSync(path, { force: true })` — idempotent by construction.
- `touch-receipts`: per-file `utimesSync` in its own `try/catch`, counting only what it touched (the existing `touchReceiptFiles()` semantics, including its per-file EPERM tolerance).

`commit.json` holds `{ version: 1, stamp, kind, steps, attempts }`. **`attempts` is incremented and fsynced *before* the first step of each run**, so a step that reliably kills the process still terminates the loop. At `attempts > 3` the attempt is abandoned per MUST-20.19's FAILED branch.

**MUST-20.23 (the crash-safety statement, in full).** For every point at which the process can be killed:

- **Before the `tmp/<uuid>-restore/` → `restore-staged/` rename:** nothing is staged; the orphan is swept by age (MUST-20.32). Live data untouched.
- **Between staging and the process exit, or between the exit and the restart:** the request survives as `restore-staged/` and is applied by whichever boot comes next, however much later. Live data untouched until then.
- **During prepare (APPLYING, no `commit.json`):** live data untouched by construction; the attempt is discarded on the next boot.
- **During commit (COMMITTING):** the next boot replays the remaining steps **before any request is served and before any database connection is opened**. Therefore *no request, and no database connection, ever observes a partially applied restore.* This is the precise form of the "never a mix" guarantee: it is not that the filesystem is never momentarily mixed — no POSIX filesystem can promise a multi-object atomic swap — it is that the mixture is **unobservable**, because the only code that could observe it is the code that finishes it.
- **After the last step, before `restore-result.json` is written:** the replay is a no-op (every step reads as already done), the result is written, the applying directory is removed. The restore is complete either way; only the *report* was at risk.

**MUST-20.24** After a successful commit the boot hook returns and boot continues normally — `getDb()` opens the **restored** database and Drizzle's migrator runs forward over it (idempotent, append-only). This is the whole of the old-backup story: an artifact from any shipped version migrates up on the boot that restores it.

**MUST-20.25** Forward completion is chosen over automatic rollback. On the exhausted-retries path the safety copies are **left in place and named in `restore-result.json`**, together with the literal `mv` commands that undo the attempt, rather than an automatic rollback being attempted — a rollback is itself a multi-step rename sequence, and a mechanism that has just failed three times is not the thing to trust with the recovery. The manual undo and the CLI (§20.10) are the fallbacks, in that order.

### 20.8 The boot seam

**MUST-20.26** The hook is invoked from `src/instrumentation-node.ts` as the **first statement in the module body**, before `getDb()` and before `startScheduler()`:

```ts
import { getDb } from '@/db/client';
import { applyStagedRestoreOnBoot } from '@/lib/backup/restore';
// ...

// MUST-20.26: this runs BEFORE the first getDb(). Nothing above opens a connection:
// src/db/client.ts constructs its singleton lazily inside ensureInstance(), so importing
// it is inert. Next awaits register() before the server accepts a request, so no route
// module can beat this to the database either.
applyStagedRestoreOnBoot();

getDb();
```

This placement is load-bearing and is stated as a rule, not left to inspection: **`applyStagedRestoreOnBoot()` must precede every `getDb()`/`getSqlite()` call reachable from boot.** MUST-20.42 pins both halves — the laziness of `src/db/client.ts`, and the ordering inside `instrumentation-node.ts`.

**MUST-20.27** The fast path is one `fs.existsSync` on `restore-staged/` plus one on `restore-applying/`. On the overwhelmingly common boot, the feature costs two `stat` calls and logs nothing.

### 20.9 The restart

**MUST-20.28** After a successful stage the server action arms the exit and returns normally. The exit **must not** pre-empt the HTTP response:

```ts
export const RESTART_DELAY_MS = 1500;
/** EX_TEMPFAIL. Non-zero so an `on-failure` restart policy also brings the container back;
 *  `always` / `unless-stopped` (what docker-compose.yml ships) restart on any exit code. */
export const RESTART_EXIT_CODE = 75;

function armRestart(): void {
  setTimeout(() => {
    stopScheduler();
    closeDb();          // checkpoints the WAL, so the boot-time safety copy is a clean file
    process.exit(RESTART_EXIT_CODE);
  }, RESTART_DELAY_MS).unref();
}
```

`unref()` is correct and not a hazard: the listening HTTP server keeps the event loop alive on its own, so an unref'd timer still fires; and if the process were already exiting for another reason, the timer being unref'd is precisely what stops it from delaying that.

**MUST-20.29** `closeDb()` before exit is not cosmetic — it checkpoints and removes the WAL, so the safety copy taken at boot is a single self-contained file rather than a database plus a write-ahead log that must be kept together.

**MUST-20.30** The UI says, verbatim in substance: **"Restoring — the app will restart. Refresh this page in about 30 seconds."** The confirm step, *before* anything happens, says which backup will be restored, that current data will be replaced, that a copy of the current database is kept as `data/budget.pre-restore-<timestamp>.db`, and that the container must have a restart policy (docker-compose.yml ships `restart: unless-stopped`) — **and that if it does not, the restore still applies the next time the app is started by hand.** Nothing is lost by a missing restart policy; only the automatic part is.

**MUST-20.31** A staged request is **never expired by age.** A container that stays down for a week still applies the restore on the boot that comes after. Only the *uncommitted* `tmp/<uuid>-restore/` staging directory is swept (MUST-20.32) — that one is, by definition, a request that was never made.

### 20.10 Sweeps and the disk cost of undo

**MUST-20.32** `purgeStagedFiles()` in `src/lib/import/staging.ts` already removes stale `<uuid>-archive` directories from `${DATA_DIR}/tmp` once they are older than 24 h, for exactly the reason a killed backup leaves one behind. Its directory rule is **extended to `-restore`** by the same argument and the same age constant. This is a two-word change and one test; nothing else in that sweep moves.

**MUST-20.33** The nightly maintenance sweep gains one new job: `budget.pre-restore-*.db` (with its `-wal`/`-shm` siblings), `receipts.pre-restore-*/` and `restore-failed-*/` older than **30 days** are removed, **except that the most recent of each kind is always kept regardless of age**. Rationale, stated because auto-deleting a user's undo needs one: before this feature a restore was a rare, deliberate, shell-access event and its safety copies leaked forever without anyone noticing; a restore that is one click away can leave a 300 MB `receipts.pre-restore-*/` behind every time it is used. Thirty days is long past the point at which a bad restore has been noticed, and "always keep the newest" means the most recent undo is never the one that disappears. This also retroactively bounds the leak the v1.1.0 CLI already had.

**MUST-20.34** `restore-result.json` is **not** swept. It is a single small file and it is the only record of what happened.

### 20.11 Failure table

Every row: **live data is either untouched or fully restored**, the marker is cleared or advanced, and the boot completes.

| # | Where | Trigger | Behaviour | Live data |
|---|---|---|---|---|
| F1 | stage | filename fails `ARCHIVE_NAME_RE`/`LEGACY_NAME_RE`, or resolves outside `backups/` | written error, nothing staged | untouched |
| F2 | stage | artifact missing, empty, or not a regular file | written error | untouched |
| F3 | stage | magic bytes are neither gzip nor SQLite | *"That file is neither a `.tar.gz` archive nor a SQLite backup."* | untouched |
| F4 | stage | tar entry allow-list violation (`..`, absolute, symlink, wrong entry type, unexpected name) | *"Refusing to extract unexpected archive entries: …"* | untouched |
| F5 | stage | inner `budget.db` is not SQLite / `quick_check` ≠ `ok` / required tables absent | *"…is not a usable Budget Tracker database. Nothing was changed."* | untouched |
| F6 | stage | one-way guard: backup carries more applied migrations than the code ships | *"…made by a newer version… Upgrade the app first, then restore."* | untouched |
| F7 | stage | `restore-staged/` or `restore-applying/` already exists | *"A restore is already staged; restart the app to apply it."* | untouched |
| F8 | stage | ENOSPC / EIO while copying the payload | scratch dir removed in `finally`, written error | untouched |
| F9 | stage | SIGKILL before the commit rename | orphan `tmp/<uuid>-restore/`, swept at 24 h (MUST-20.32) | untouched |
| F10 | restart | SIGKILL after the commit rename, before `process.exit` | request survives as `STAGED`; applied on the next boot | untouched until then |
| F11 | restart | container has no restart policy | request survives as `STAGED`; applied on the next manual start (MUST-20.31) | untouched until then |
| F12 | boot | `restore-request.json` unparseable, fails zod, or `version !== 1` | recorded failed, `restore-staged/` removed, boot continues | untouched |
| F13 | boot | payload missing, or sha256 does not match the marker | recorded failed, removed, boot continues | untouched |
| F14 | boot | re-validation fails (any of F3–F6, on the second pass) | recorded failed, removed, boot continues | untouched |
| F15 | boot | SIGKILL during prepare (`commit.json` absent) | attempt discarded, recorded failed, `rm -rf`, boot continues | untouched (MUST-20.7) |
| F16 | boot | ENOSPC during prepare | same as F15, with the disk-space error recorded | untouched |
| F17 | boot | SIGKILL mid-commit (`commit.json` present) | next boot replays the remaining steps and completes | fully restored, before anything can observe otherwise |
| F18 | boot | a commit step hard-errors 3 times | recorded failed with the literal `mv` recovery commands; `restore-applying/` → `restore-failed-<stamp>/`; never retried | whatever the steps achieved, with both safety copies present and named |
| F19 | boot | `restore-result.json` cannot be written | logged to stderr; the restore itself still completed; applying dir removed | fully restored |
| F20 | boot | anything unanticipated | caught, logged, boot continues (MUST-20.20) | untouched or fully restored |

### 20.12 UI

**MUST-20.35** Settings → Backups (`src/app/(app)/settings/backups/`):

- Each row gains a **Restore** button. Activating it expands an **inline confirm panel** on that row — not a `window.confirm`, which is untestable and cannot carry the wording MUST-20.30 requires. The panel names the backup, states that current data will be replaced, names the safety copy, and requires an explicit checkbox (*"I understand this replaces the current data"*) before its **"Restore and restart"** submit button enables. **Cancel** collapses it. Only one row's panel may be open at a time.
- After a successful stage the whole page switches to the restarting notice (MUST-20.30) and every control is disabled — there is nothing useful left to click, and the process is about to end.
- A **result banner** at the top of the page renders the last boot-time restore from `restore-result.json`: on success, *"Restored `budget-2026-08-16.tar.gz` on 2026-08-16 21:04 — 128 receipt files restored. The previous database was kept as `budget.pre-restore-….db`."*; on failure, the recorded `error` sentence verbatim, in the existing `FormError` treatment.
- Failures from the action itself render through the existing `FormError` / message pair already on this page. No new component.

**MUST-20.36** The server action, in `src/app/(app)/settings/backups/actions.ts`, in this order and no other: `isSameOrigin(await headers())` **first** (MUST-13.1) → `requireAdmin()` (MUST-20.37) → zod parse of `{ name, confirm }` → `resolveSafeTarget()` → validate → stage → arm the restart → return. A cross-origin caller must be rejected **before** the filename is even read, and the test asserts that by observing that no filesystem call happened.

**MUST-20.37** Admin-gated exactly like the rest of Settings → Backups: the page already calls `requireAdmin()`, and the action calls it again — the page gate is UI, the action gate is the security boundary. A non-admin session gets a written refusal, not a redirect, from the action.

**MUST-20.38** One audit line on the server, both ways: `[restore] staged <sourceName> (<kind>, <bytes> bytes, sha256 <first 12>) requested by user <id>` at stage, and at boot `[restore] applied <sourceName> …` or `[restore] FAILED <sourceName>: <error>`.

### 20.13 Security invariants (all of §13 continues to bind)

- **MUST-13.1 unchanged** — `isSameOrigin()` first on the mutating action. This feature adds no route handler, so `assertSameOrigin`/`isSameOriginOrHeaderless` are not involved at all.
- **MUST-13.2 unchanged** — session-authenticated, admin-only. No anonymous surface, no token, no signed URL.
- **Untrusted-input discipline extends to `${DATA_DIR}`.** `restore-request.json`, `commit.json` and the payload live on a bind mount. All three are parsed with zod, and the payload is re-validated in full at boot. A hostile `restore-request.json` can at worst point at a file that fails validation.
- **The tar-slip defence is not weakened, relaxed, or re-implemented** — it is the same function, moved (MUST-20.4), still covered by the same `tests/scripts/restore-backup.test.ts` fixtures including the hand-rolled ustar symlink and absolute-path archives.
- **MUST-13.8 unchanged** — non-root, read-only rootfs, tmpfs `/tmp`. Every path this feature writes is under `${DATA_DIR}`.
- **No new dependency and no new network egress.** `tar` and `better-sqlite3` are already in the image; `zod` is already a dependency.
- **No new Dockerfile line.** `COPY /app/scripts ./scripts` already ships `restore-core.ts` into the runtime image, and the app half is bundled by Next. MUST-20.42 pins that with an ops test rather than trusting it.

### 20.14 Versioning and release

**MUST-20.39** `package.json` `version` → **`1.2.0`** (minor: new feature, no breaking change). The single-source-of-truth chain of MUST-14.1 is unchanged — `src/lib/version.ts`, the footer, Settings → About, `/api/health`, the update scripts.

**MUST-20.40** `CHANGELOG.md` gains `## [1.2.0] — 2026-08-16` with a fresh empty `## Unreleased` above it: **Added** — GUI restore-on-next-start with full pre-staging validation and a boot-time apply; the last-restore outcome on Settings → Backups. **Changed** — the restore documentation now leads with the GUI path, with the CLI kept as the disaster fallback; `.pre-restore-*` safety copies are swept after 30 days (the most recent is always kept). **Security** — restores are admin-only, same-origin-checked, and limited to artifacts already present in `${DATA_DIR}/backups`; a backup carrying migrations the running code does not ship is refused.

**MUST-20.41** `README.md` §4 "Restore" and `INSTALL.md` "Restoring from a backup" are **rewritten to lead with the GUI path** — Settings → Backups → Restore → confirm → wait ~30 s — and to keep the CLI, verbatim as it is today, under a clearly-labelled *"If the app will not start"* heading. Both must state: the safety copies and where they are; that the restore applies on the next start even if the container has no restart policy; that a backup from a newer version is refused; and that `-wal`/`-shm` handling is automatic. The sentence *"there is deliberately no in-app restore button"* is removed from both files — it is now false, and a stale safety claim is worse than no claim.

### 20.15 Testing

On top of §15, all binding. Vitest with explicit imports, TS strict, no globals.

**Unit — `tests/scripts/restore-core.test.ts` (new):**
- every check of MUST-20.14, each in isolation: empty file, 3-byte file, directory-instead-of-file, gzip that is not a tar, tar whose `budget.db` is a directory, tar whose `receipts` is a plain file, tar carrying `../evil`, `/etc/passwd`, a symlink entry, an unexpected top-level entry (these reuse the existing hand-rolled ustar fixtures);
- `budget.db` present but garbage → refused; `budget.db` a valid but *empty* SQLite file with no `users` table → refused with the "not a usable Budget Tracker database" message; a deliberately corrupted page → `quick_check` fails → refused;
- **the one-way guard, four cases:** backup with fewer applied migrations → allowed; equal → allowed; `backupMaxWhen > localMaxWhen` → refused; `backupCount > localCount` with an equal max `when` → refused; `__drizzle_migrations` absent → allowed;
- `prepareRestore()` **writes nothing outside `scratchDir`** — asserted by snapshotting a `readdir` of the whole data dir before and after, for both artifact kinds and for a failing artifact;
- `commitRestore()` replay: run the full step list, then run it again → second run is a no-op returning the same result; run it truncated after each step index in turn (simulating a kill) and then replay to completion → **final state is byte-identical to the uninterrupted run**, asserted by sha256 of `budget.db` and a sorted listing of `receipts/`;
- `attempts` increments before each replay and the 3-attempt cap terminates.

**Unit — `tests/scripts/restore-backup.test.ts` (existing, UNCHANGED):** must pass without edits after the extraction. If a test in it needs changing, the refactor was not behaviour-preserving.

**Unit — `tests/lib/backup-restore.test.ts` (new), the state machine:**
- staging builds `tmp/<uuid>-restore/` and commits by rename; the marker validates against its zod schema; sha256 matches the payload;
- `STAGED` → `APPLYING` → `DONE`: the happy path for an archive and for a bare `.db`, each asserting the safety copies exist and the restored data is present;
- `APPLYING` with no `commit.json` → discarded, recorded failed, live data byte-identical to before;
- `APPLYING` with `commit.json` and steps half-done → resumed to completion;
- `attempts: 3` in `commit.json` → not retried, `restore-failed-<stamp>/` created, boot continues;
- marker with `version: 2`, marker failing zod, payload absent, sha256 mismatch → each recorded failed, staged dir gone, live data untouched;
- **the hook never throws**: with `${DATA_DIR}` made unwritable, `applyStagedRestoreOnBoot()` returns normally.

**MUST-20.42 — guard tests (`tests/ops/restore-seams.test.ts`, new).** These are the tests that keep the two seams of §20.2 and §20.8 from silently breaking:
- **MUST-20.4:** `scripts/restore-core.ts` and `scripts/restore-backup.ts` contain **no** `@/` import — a source scan, so the CLI's no-src-imports rule fails a test rather than failing in a container;
- **MUST-20.4:** neither file contains `enum `, `namespace `, or a non-`import type` type-only import that `--experimental-strip-types` would reject;
- **MUST-20.5:** `src/lib/backup/restore.ts` is the only file under `src/` importing from `scripts/`;
- **MUST-20.26:** `src/instrumentation-node.ts` calls `applyStagedRestoreOnBoot()` at a lower source index than its first `getDb()`;
- **MUST-20.26:** importing `@/db/client` opens no database — `databasePath()` is pointed at a path that does not exist, the module is imported, and no file is created.

**Integration — `tests/integration/gui-restore-flow.test.ts` (new):** seed a database with two warranty items and two receipt files → `runNightlyBackup()` → stage that archive through the real action path (with an admin session and a same-origin header set) → assert `restore-staged/` and the marker → mutate the live data (delete an item, add a third receipt) → run `applyStagedRestoreOnBoot()` → the two original items are back, both receipt files are present with unchanged sha256, the third is in `receipts.pre-restore-*/`, `budget.pre-restore-*.db` contains the mutated data, `restore-result.json` reports success, and the staged/applying directories are gone. Then the same flow with a **legacy `.db`** artifact: `receipts/` is untouched, every file's mtime is re-armed, `missingReceiptRows` is reported.

**Action tests (`tests/app/backups-actions.test.ts`, extended):** cross-origin → rejected **before** any `fs` call; non-admin → written refusal; a name that is not a listed backup → refused; `../../etc/passwd` and an absolute path → refused by `resolveSafeTarget`; `confirm` unchecked → refused; a second stage while one is staged → refused; the happy path returns the restarting message and **arms exactly one timer** (asserted with fake timers; `process.exit` is stubbed).

**Client test (`tests/app/backups-client.test.tsx`, extended):** the confirm panel names the backup; the submit button is disabled until the checkbox is ticked; Cancel collapses it; only one panel opens at a time; the success and failure result banners render their respective texts.

**Sweep tests:** `purgeStagedFiles()` removes an aged `<uuid>-restore` directory and leaves a fresh one (mirroring the existing `-archive` assertions); the nightly sweep removes a 31-day-old `budget.pre-restore-*.db` / `receipts.pre-restore-*/` / `restore-failed-*/` but **keeps the most recent of each kind** even at 400 days old.

**Manual acceptance checks, added to §15.4:**
- **A8 — the real restart.** On a real Docker install: make a backup, change some data, restore it from Settings, watch the container exit and come back, refresh after ~30 s, confirm the data and the result banner.
- **A9 — no restart policy.** `docker run` without `--restart`: the container exits and stays down; starting it by hand applies the restore (MUST-20.31).
- **A10 — the kill test.** `docker kill -s KILL` during the boot apply (a large receipt library makes the window reachable); restart; the restore completes and the result banner reports success.
- **A11 — refusal.** Hand a v1.1.0 install a backup taken from a build carrying a fifth migration; the UI refuses with the MUST-20.16 message and nothing is staged.

### 20.16 Decisions taken on the owner's behalf in this addendum

Extending §17 and §19.11, same rules — each is one constant or one paragraph if the owner wants it different.

33. **Shared module over duplication.** `scripts/restore-core.ts`, imported by both sides, rather than a second copy of the validation logic in `src/` behind pin tests. Duplicating a tar-slip defence is how one of the two copies quietly stops being fixed.
34. **`RESTART_EXIT_CODE = 75`** (EX_TEMPFAIL) rather than `0`, so an `on-failure` restart policy also brings the container back.
35. **`RESTART_DELAY_MS = 1500`.**
36. **The safety copy is a `rename`, not a `copy`** — instant, no doubled disk, and the old database is still fully intact under a new name.
37. **The safety copy is taken at boot, not at stage time**, so it captures the database as it actually was at the moment of replacement, with the WAL already checkpointed by MUST-20.29.
38. **No receipts manifest.** For an archive restore the existing `receipts.pre-restore-<stamp>/` rename *is* the safety copy, for free; for a bare-db restore `receipts/` is not touched at all. A manifest would be a third thing to keep in sync with two directories that already describe themselves.
39. **`PRAGMA quick_check`, not `integrity_check`** — the same class of answer, in a fraction of the time on a multi-gigabyte database, on a path the operator is watching a spinner for.
40. **The Budget-Tracker-ness check is `users` + `accounts` + `transactions`**, three tables that have existed since `0000_init` and will not be renamed.
41. **Forward completion, not automatic rollback** (MUST-20.25).
42. **A staged request never expires** (MUST-20.31); only the uncommitted staging directory is swept.
43. **30-day sweep of `.pre-restore-*` with the most recent always kept** (MUST-20.33), which also bounds the leak v1.1.0's CLI already has.
44. **An inline confirm panel with a checkbox**, not `window.confirm` and not a type-the-filename gate: the checkbox is testable, carries the wording, and is proportionate to an action that keeps a full undo copy.
45. **The restore is applied by the boot hook, not by a Docker entrypoint script.** The entrypoint would not cover `npm run dev`, would need its own type-stripping invocation, and would put a security-critical path outside the test suite's reach.
46. **No cancel-a-staged-restore control.** The window between staging and exit is 1.5 s, and after the exit there is no UI to cancel from. Deleting `data/restore-staged/` is the documented manual escape.

### 20.17 Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R8 | Next's build refuses, or output-tracing drops, the `scripts/restore-core.ts` import from `src/lib/backup/restore.ts` | The module is a plain alias-free TS file in the project root's `tsconfig` include; `tar` bundles and `better-sqlite3` is already in `serverExternalPackages`; the ops test of MUST-20.42 fails the build rather than production |
| R9 | The container has no restart policy and the owner thinks the restore was lost | The confirm step says so up front; the request survives as `restore-staged/` and applies on the next manual start (MUST-20.31, acceptance A9) |
| R10 | A boot-time failure re-arms itself and the container loops | The `STAGED → APPLYING` rename claims a request exactly once; prepare-phase deaths are discarded outright; commit replays are capped at 3; the hook never throws (MUST-20.19, MUST-20.20) |
| R11 | An operator hand-edits `${DATA_DIR}/restore-request.json` | zod on read, `version` gate, full re-validation of the payload at boot, and the payload can only ever be a file that passes §20.5 |
| R12 | Safety copies fill the disk now that restores are cheap | The 30-day sweep with a most-recent exemption (MUST-20.33), and the sizes are visible on the same page as the retention setting |
| R13 | The response does not reach the browser before the process exits | 1.5 s delay armed only *after* the action returns its state, on a timer that cannot itself hold the process open (MUST-20.28), plus acceptance check A8 |

---

## Revision history

- **v1.0** (2026-08-16): initial approved design for the warranty tracker, targeting Budget Tracker v1.1.0.
- **v1.1** (2026-08-16): §19 addendum — warranty item types (admin-maintained list, migration `0003`) and subscriptions tracked through the existing purchase/term/expiry fields with `is_subscription`-keyed wording. User-requested mid-build, after Tasks 1–3 had landed; §1–§18 unchanged.
- **v1.2** (2026-08-16): §20 addendum — GUI restore-on-next-start, targeting Budget Tracker v1.2.0. Adds an admin-only Restore control to Settings → Backups that validates and stages an artifact and restarts the process; the restore is applied by the boot hook before any database connection opens. Amends §12.2/§17.11's "no in-app restore button" while preserving the invariant behind it; extracts the restore logic into `scripts/restore-core.ts` shared by the CLI and the app; no schema change. §1–§19 otherwise unchanged.
- **v1.2.1** (2026-08-17): infrastructure release, no design change to this spec — GitHub Actions publishes multi-arch images to GHCR on version tags, the Synology install path becomes paste-and-go (no source checkout, no build), and `SECRET_KEY` auto-generates at `data/secret.key` on first boot when unset. §1–§20 unchanged; noted here only for revision-history continuity between v1.2 and v1.2.2.
- **v1.2.2** (2026-08-17): §19.12/§19.13 amendment — the warranty tracker generalizes to "Contracts & Coverage": item types gain a four-value `kind` (warranty/subscription/contract/loan), migration `0004_item_type_kinds.sql`, superseding `setItemTypeSubscription` with `setItemTypeKind` and adding the per-kind wording matrix to `src/lib/warranty/constants.ts`. `is_subscription` is kept, derived from `kind`. §17 item 29 records the loan scope cut (dates and documents only, no balance math). Ships as two tasks landing together: Task 1 built the migration/library/admin-page foundation; Task 2 (§19.13) supersedes the four boolean label helpers with kind-keyed equivalents, wires kind-driven wording into every warranty-item surface (list, detail, dashboard widget, add/edit forms with live dynamic labels), and renames the section to "Contracts & Coverage" (labels only — routes unchanged). §1–§19.11 and §20 otherwise unchanged.
- **Amended 2026-08-17 (v1.3.1):** §17 item 29 ("Loans are dates and documents only — no balance, no payment schedule, no interest math") is **withdrawn** by `docs/superpowers/specs/2026-08-17-update-loans-design.md` §12. Loans now carry a principal, a display-only rate and a balance that bank transactions decrement. Interest **math** remains out of scope, enforced by a grep invariant. Nothing else in this spec is withdrawn.
