# Budget Tracker — Design Spec

**Date:** 2026-08-15
**Status:** v1.4 — approved design (v1.1 review revisions + §11 sharing packs + §9 install experience + §12 SimpleFIN connector, merchant renames, manual-only update tooling). Implementation plan in progress.
**Working name:** Budget Tracker (final name TBD by user, cosmetic only)

## 1. Overview

Self-hosted household budget tracker replacing Mint. Family members import bank CSV exports (Canadian banks), the app categorizes spending and learns vendor→category mappings from corrections, tracks monthly budgets per category, and tracks savings goals. Runs as a single Docker container on a Synology NAS (or any Docker host), LAN-only, with secure local authentication.

### Goals

- Import CSV exports from TD (debit + Visa), Scotiabank (debit), Amex Canada, and any other Canadian bank via a one-time column-mapping wizard.
- Auto-categorize transactions; learn from user corrections over time (Mint-like behavior).
- Track spend by category: monthly budgets at household level and per-person level.
- Savings goals: shared or per-person, with pace projections.
- Scalable user count: start with 1–2, grow to 4+ family members. Admin creates accounts as needed.
- Secure login (password + optional TOTP MFA) even though hosting is LAN-only.
- One-file database, trivial backups, no *mandatory* cloud dependency at runtime (the optional SimpleFIN connector in §12 is the single exception, dormant until a user configures it).
- Shareable knowledge packs: export/import merchant→category rules and bank import profiles as JSON — share learned categorization with friends/family without sharing any transactions, amounts, or accounts (§11).
- Optional automatic transaction fetch via a user-supplied SimpleFIN bridge, as an alternative to CSV on a per-account basis (§12).
- User-controlled merchant renames: a friendly display name per merchant or per transaction, without touching the raw description the dedup hash and the categorizer depend on (§4).

### Non-goals (v1)

- Bank API sync via **Plaid or Flinks** — rejected: commercial aggregators, account signup, credentials brokered by a third party. The optional SimpleFIN connector (§12) is the only bank-sync path, it is off until configured, and CSV import remains the default.
- Google/OIDC login — rejected: requires public HTTPS domain + internet at login.
- Passkeys/WebAuthn — clean v1.5 candidate, requires HTTPS on LAN; not in v1.
- Cross-account transfer pair-matching (opposite amounts within N days) — v2; v1 uses pattern rules + manual flag.
- Email/push notifications, receipts/attachments, investments, multi-currency (CAD integer cents only), recurring-subscription detection (v2 candidate), regex rules editor, public internet exposure, native mobile apps (responsive web instead).

## 2. Architecture

- **Framework:** Next.js 15 (App Router) + React 19 + TypeScript. Single codebase: UI, API route handlers / server actions, background jobs.
- **Database:** SQLite file at `/data/budget.db`, accessed via better-sqlite3 + Drizzle ORM. Drizzle migrations run automatically on startup. Connection init pragmas: `foreign_keys = ON` (off by default in SQLite — FKs are decorative without this), `journal_mode = WAL`, `busy_timeout = 5000`.
- **UI:** Tailwind CSS, Recharts for charts. Responsive (phone/tablet/desktop browsers). Next image optimization disabled (`images.unoptimized`) — no remote images, avoids runtime cache writes.
- **Runtime:** Node 22, single Docker container, **`node:22-bookworm-slim`** base (glibc — better-sqlite3 and argon2 ship glibc prebuilds; Alpine/musl would force slow source compiles, catastrophic under ARM64 QEMU emulation). Multi-stage build with Next `standalone` output; compiled native `.node` binaries copied explicitly into the runtime stage (output tracing does not reliably include them). Non-root user. Multi-arch: x86_64 + ARM64.
- **Scheduler:** in-process nightly job (node-cron) for backups and maintenance sweeps.
- **No runtime network calls** to any external service — with one opt-in exception: user-initiated sync requests to the user's own configured SimpleFIN bridge (§12). No telemetry ever.
- **Validation:** zod on all inputs (API + forms + CSV rows).

### Deployment targets

Synology Container Manager (primary), any Linux with Docker/Podman, QNAP, Unraid, TrueNAS SCALE, Raspberry Pi 4/5, Docker Desktop on Windows/Mac.

**Primary install path:** build image on a PC (`docker build`), transfer via `docker save` / `docker load` (or a compose `build:` on capable hardware). `next build` can exceed the RAM of entry-level NAS models — building on the NAS is the fallback, not the default. README documents both.

**Transport:** HTTPS via Synology reverse proxy (self-signed or Let's Encrypt) or Tailscale is the **recommended default** — see threat model in §6. Plain HTTP on a trusted LAN is a documented, explicit opt-out.

### Configuration (env vars)

- `SECRET_KEY` — required; random string ≥ 32 bytes. Never used directly as a cipher key; keys are derived via HKDF (§6). Generated once by user at install (README shows command). **Loss/rotation consequence (README):** all TOTP enrollments become undecryptable; users re-enroll MFA. Nothing else is affected.
- `TRUST_PROXY` — default off. When on, trust `X-Forwarded-Proto` (Secure-cookie switching behind TLS-terminating reverse proxy) and `X-Forwarded-For` (client IP for rate limiting). Off = socket values used.
- `TZ` — timezone for date handling and nightly jobs (default `America/Toronto`).
- `PORT` — default 3000.
- `DATA_DIR` — default `/data`.

## 3. Data model

All money stored as **integer cents**, spend negative, income positive. Budget limits stored positive. All dates stored as ISO `YYYY-MM-DD` strings (SQLite TEXT). Timestamps as ISO datetime.

**Refunds/returns (routine on credit cards):** a positive amount in a non-income category **nets against** that category's spend (budget progress uses the category's net). Income series/reporting counts only `is_income` categories. Refunds never inflate income.

### users
`id, name, username (unique), password_hash (argon2id), role ('admin'|'member'), totp_secret_encrypted (nullable), totp_enabled (bool), is_active (bool), created_at`

- First-run setup wizard creates the first user as admin.
- Admin creates additional users (name + temporary password); user sets own password (+ optional TOTP) at first login.
- Deactivate, never delete — preserves attribution history.

### accounts
`id, name, institution, type ('chequing'|'credit'|'cash'), owner_user_id (nullable FK users), import_profile_id (nullable FK), is_active, created_at`

- `owner_user_id = NULL` means joint/household account.
- Each user gets a personal Cash account (created on demand) for manual entries.
- **An account is CSV-managed or SimpleFIN-managed, never both.** Linking an account to a SimpleFIN remote account (§12) disables CSV import for it — the Import page refuses that account with an explanation, and the link step warns before it takes effect. Unlinking restores CSV import. Feeding one account from both sources would produce two dedup regimes on the same rows (`dedup_hash` for CSV, `external_id` for SimpleFIN) that cannot see each other, so every overlapping transaction would land twice.

### import_profiles
`id, name, institution, is_builtin (bool), mapping (JSON), created_at`

`mapping` JSON fields: `hasHeader (bool), headerRows (int), dateCol, dateFormat, descCols (array, joined with space), amountMode ('signed'|'debit_credit'), amountCol / debitCol+creditCol, signConvention ('negative_is_spend'|'positive_is_spend'), encoding ('auto'|'utf-8'|'windows-1252'), skipRules (optional)`.

**Built-in presets are copy-on-write:** the first time a user adjusts a built-in profile's mapping at preview, the app forks it into a new profile attached to that account. Built-ins are never mutated in place (they're shared rows).

**Built-in presets (4):**
| Preset | Shape (best-effort default) |
|---|---|
| TD Chequing/Debit | Headerless: `YYYY-MM-DD, Description, Debit, Credit, Balance`. Debit column = money out. Fixture-validated against the user's real export (2026-08-16): every field quoted (including numeric; empty fields render as a bare `,,`), LF-only line endings, ISO date. |
| TD Visa | Same headerless 5-column shape as TD chequing, `MM/DD/YYYY` dates. Fixture-validated against the user's real export (2026-08-16): unquoted fields, CRLF line endings — matched the preset exactly, no change needed. |
| Scotiabank Chequing/Debit | Signed-amount CSV; negative = money out; exact column layout confirmed against user's real export during fixture work (first import runs the mapping preview regardless). |
| Amex Canada | Headered, 17 columns (`Date, Date Processed, Description, Card Member, Account #, Amount, Flexible, Foreign Spend Amount, Commission, Exchange Rate, Additional Information, Merchant, Address, City / Province, Postal Code, Country, Reference`); Description at column index 2, Amount at index 5; date format `DD Mon YYYY` (e.g. `02 Mar 2026`); positive = charge. Parser must handle quoted embedded newlines — the real export's multi-line quoting occurs in the **Address** and **City / Province** columns, not a "Category"/"Extended Details" column (there is no Category column in this export). Fixture-validated against the user's real export (2026-08-16); the extra Merchant/Card Member/Reference columns are ignored in v1 (possible categorizer hint, v2). |

Presets are **best-effort defaults**: every first import of an account runs through the preview step, where the user confirms parsing looks right and can adjust the mapping (forking the profile per above). During implementation, presets are validated against fixture files built from the user's real exports (values scrubbed). Format drift is self-correcting via the preview step.

**New-bank wizard:** upload sample CSV → app shows first ~10 raw rows → user assigns columns (date, description, amount or debit/credit), date format, sign convention → saved as a new named profile. This is how "any Canadian lender" is supported without hardcoding.

### imports
`id, account_id, profile_id, filename, imported_by (FK users), rows_added, rows_duplicate, rows_error, created_at`

### transaction_imports
`transaction_id (FK), import_id (FK), created_at` — composite PK.

Association recorded **both** when an import inserts a transaction **and** when it skips a row as a duplicate of an existing transaction. This is what makes undo safe with overlapping exports (TD/Scotia date-range downloads overlap routinely).

**Undo import:** delete only transactions whose *sole* import association is the undone import; for transactions also covered by other imports, remove the association only. Bayes token counts are reversed for deleted rows that had reached `source = 'manual'` (recomputed from each row's `normalized_merchant` token multiset — no token→transaction link table needed). Confirmation dialog shows counts (will delete N, will keep M shared with other imports).

### transactions
`id, account_id, import_id (nullable — NULL = manual entry), attributed_user_id (nullable FK users), date, raw_description, display_description (nullable), display_source ('manual'|'rename'|NULL), normalized_merchant, amount_cents, category_id (nullable), categorization_source ('rule'|'bayes'|'manual'|'none'), confidence (real, nullable — stores the Bayes log-margin), is_transfer (bool), notes (nullable), dedup_hash (nullable), hash_version (int), external_id (nullable — SimpleFIN transaction id, §12), created_by (FK users), created_at, updated_at`

**Display description (user-facing rename):** `raw_description` is immutable truth — dedup hashing and categorizer learning read ONLY raw/normalized fields. `display_description` is what the UI shows when set (falls back to raw). `display_source` records who set it: `'manual'` (per-transaction edit — always wins, never overwritten by rules) or `'rename'` (applied by a merchant rename rule). Renaming a merchant offers "this transaction only" (manual) or "all matching + future" (creates a rename rule, §4).

**SimpleFIN rows** carry `external_id` with a **partial unique index on `(account_id, external_id) WHERE external_id IS NOT NULL`** — provider-id dedup, exact across any overlap window. CSV rows keep `external_id = NULL`.

**Attribution (who spent it):** `attributed_user_id` defaults to the account's `owner_user_id` (so personal-account spend is automatically personal). For joint accounts it defaults to NULL = household/unattributed. Editable inline and in bulk. **Personal views, personal budgets, and per-person reports scope on `attributed_user_id`** — without this, a family running a joint chequing + joint Visa (the normal case) would see near-zero personal spend everywhere. Unattributed spend counts toward household budgets/reports only, and reports show it as its own "Household/unattributed" bucket.

**Uncategorized representation:** `category_id = NULL` is the *only* representation of uncategorized (rendered as "Uncategorized" in the UI). There is no seeded Uncategorized category.

**Dedup:**
- `dedup_hash = sha256(hash_version | account_id | raw_date_string (trimmed) | amount_cents | dedup_desc | occurrence_index)`
- `dedup_desc` = raw description, uppercased, whitespace-collapsed — a deliberately **frozen, minimal** normalization, versioned by `hash_version` (v1), fully independent of the §4 learning normalizer. The learning normalizer's strip-list is expected to evolve; if the hash depended on it, every normalizer upgrade would silently break duplicate detection for all existing rows. Raw date string (not the parsed date) keeps the hash independent of date-format mapping edits.
- `occurrence_index` counts identical (raw_date_string, amount_cents, dedup_desc) rows *within the same file*, in row order — makes re-imports and overlapping exports idempotent while allowing two genuinely identical same-day purchases in one file. Rows that fail to parse do not consume an index (they're excluded before counting).
- **Partial unique index** on `(account_id, dedup_hash) WHERE dedup_hash IS NOT NULL`.
- **Manual entries: `dedup_hash = NULL`** — no file, no occurrence group; two identical manual $5 coffees are legitimate and must not collide.

`is_transfer = true` excludes the row from all spend/income reporting.

### categories
`id, name, parent_id (nullable, max depth 2), icon, color, is_income (bool), is_archived (bool), sort_order`

- Transactions may be assigned to **any** category, parent or leaf.
- **Rollup rule:** a budget or report on a parent category counts the parent's own transactions **plus all its children's**. Budget UI shows parents with children nested beneath.
- Categories are **archive-only** — never hard-deleted (transactions, rules, budgets reference them).

Seeded on setup (editable): Income (Salary, Other Income); Housing (Rent/Mortgage, Property Tax, Home Insurance, Utilities, Internet & Phone); Food (Groceries, Restaurants, Coffee); Transport (Gas, Car Payment, Car Insurance, Maintenance, Transit, Parking); Shopping (Clothing, Electronics, General); Health (Pharmacy, Dental, Fitness); Personal (Subscriptions, Entertainment, Gifts, Travel); Kids; Fees (Bank Fees, Interest). Transfers are a flag, not a category; uncategorized is `NULL`, not a category.

### merchant_rules
`id, pattern (normalized string), match_type ('exact'|'contains'), rule_kind ('category'|'transfer'|'rename'), category_id (nullable — NULL for transfer and rename rules), rename_to (nullable — set only for rename rules, NULL otherwise), created_by, hit_count, last_used_at, created_at`

- **UNIQUE(pattern, match_type, rule_kind)** — the learning loop's upsert conflicts on this; without it, corrections would accumulate duplicate rules. Adding `rename` as a third kind means one pattern can carry a category rule and a rename rule independently, which is exactly what you want: "MCDONALD'S" both files under Restaurants *and* displays as "McDonald's".
- Created/updated automatically from user corrections — category corrections create category rules; transfer-flag toggles create **exact-match** transfer rules only (a contains-rule learned from an e-transfer description would over-match unrelated e-transfers); renaming a merchant "for all matching" creates a rename rule carrying the new display text in `rename_to` (§4). Manageable in Settings (list, edit, delete).

### bayes_tokens
`token, category_id, count` (composite PK).

### bayes_category_totals
`category_id (PK), doc_count, token_total` — `token_total` needed for multinomial Laplace smoothing without re-aggregating on every classification. Vocabulary size cached in `settings` (`bayes_vocab_size`), maintained incrementally.

### budgets
`id, scope ('household'|'personal'), user_id (nullable — required when scope='personal', NULL for household), category_id, amount_cents (nullable — NULL = "budget cleared from this month forward"), effective_month ('YYYY-MM'), created_at`

- A budget row applies from `effective_month` forward until a newer row exists for the same (scope, user_id, category_id). Monthly amounts persist without re-entry.
- **Unique expression index** on `(scope, COALESCE(user_id, 0), category_id, effective_month)` — plain UNIQUE won't bind because SQLite treats NULL `user_id` values as distinct.
- **Edit semantics:** editing a limit while viewing month M upserts a row with `effective_month = M` (never retroactively mutates an earlier row). Clearing a budget writes an `amount_cents = NULL` row at M.
- Household budget progress counts **all** non-transfer net spend in the category (rollup rule applies). Personal budget progress counts net spend where `attributed_user_id` = that user.

### goals
`id, name, owner_user_id (nullable — NULL = shared), target_cents, target_date (nullable), archived, created_at`

### goal_contributions
`id, goal_id, user_id, amount_cents, date, note (nullable), created_at`

Contributions are manual log entries (money set aside), not linked to transactions in v1.

**Pace math:** saved = Σ contributions; remaining = target − saved. Required monthly = remaining ÷ whole months from now until `target_date` (minimum 1). Projected finish = based on average monthly contribution over trailing 3 calendar months (or all history if shorter). **Edge branches:** no `target_date` → required-monthly hidden; trailing average ≤ 0 → show "no pace yet" instead of a projection; `target_date` in the past with remaining > 0 → flag overdue, required = full remaining.

### totp_recovery_codes
`id, user_id (FK), code_hash (SHA-256), used_at (nullable), created_at` — 8 rows per enrollment, single-use (§6). Regenerating recovery codes replaces the user's set.

### sessions
`token_hash (PK — SHA-256 of the random 256-bit cookie token), user_id, created_at, expires_at, last_seen_at, user_agent, ip`

### login_attempts
`id, username, ip, success (bool), created_at`

### settings
`key, value` — misc app settings (backup retention, `bayes_vocab_size`, etc.).

### simplefin_connections
`id, access_url_encrypted (AES-256-GCM, §12), claimed_at, last_sync_at (nullable), requests_today (int), requests_date ('YYYY-MM-DD'), enabled (bool), created_at`

- At most one row in v1 (one bridge per install); the table is a table rather than a `settings` key because the access URL is a credential and deserves its own column, and because the daily counter needs typed integer arithmetic.
- `requests_today` / `requests_date` are the app-side guard against the bridge's ~24 requests/day/token limit: the counter resets whenever `requests_date` is not today (in `TZ`), and a sync is refused past 20 with a message rather than burning the last few requests.
- Rows are never created by the app on its own — the table stays empty until an admin claims a setup token.

### simplefin_account_links
`simplefin_account_id (TEXT, PK — the provider's account id), account_id (FK accounts), currency, last_balance_cents (nullable), last_balance_date (nullable), created_at`

- One row per linked remote account. The PK is the provider id, so a remote account cannot be linked to two local accounts.
- A local `account_id` appearing here is SimpleFIN-managed and CSV import is refused for it (see **accounts** above). Deleting the link row restores CSV import.
- `currency` is stored as reported. Anything other than `CAD` is surfaced as a warning at link time and on every sync — v1 stores integer cents with no conversion, so a non-CAD account would silently mix currencies in reports.

### Indexes & maintenance (beyond PKs and the dedup index)
- `transactions(account_id, date)`, `transactions(date)`, `transactions(category_id, date)`, `transactions(attributed_user_id, date)`, `transactions(import_id)`, `transactions(normalized_merchant)` — drive the transactions table, dashboard trends, top merchants, review-queue badge, undo.
- **Partial unique index** on `transactions(account_id, external_id) WHERE external_id IS NOT NULL` — provider-id dedup for SimpleFIN rows (§12); CSV and manual rows keep `external_id = NULL` and are unaffected.
- `merchant_rules` unique key as above; `login_attempts(username, created_at)`, `login_attempts(ip, created_at)`; `sessions(user_id)`, `sessions(expires_at)`; `simplefin_account_links(account_id)`.
- Nightly maintenance sweep: purge expired sessions, purge `login_attempts` older than 30 days.

## 4. Categorization engine ("the learning")

Runs on newly imported and newly entered transactions. **Re-run on demand touches only rows with `category_id IS NULL` or unaccepted `source = 'bayes'` rows — never `manual` or `rule` rows** (re-running must not overwrite human decisions).

1. **Normalize** `raw_description` → `normalized_merchant` (the *learning* normalizer — free to evolve; dedup does not depend on it):
   - Uppercase; collapse whitespace.
   - Strip POS/channel prefixes: `POS PURCHASE`, `PREAUTHORIZED`, `PRE-AUTH`, `CONTACTLESS`, `INTERAC PURCHASE`, `VISA DEBIT`, etc. (maintained list).
   - Strip store numbers (`#1234`, `STORE 042`), long digit/reference runs (≥5 digits), and trailing `CITY PROVINCE` tails (two-letter Canadian province codes).
2. **Exact rule match** on `normalized_merchant` → category, source `rule`.
3. **Contains rule match** (longest pattern wins) → source `rule`.
4. **Naive Bayes** (multinomial, Laplace smoothing) over tokens of `normalized_merchant`, trained **only on `source = 'manual'` transactions**. Assign when the **log-likelihood margin** between top and runner-up category is **≥ 2.0** *and* at least 2 tokens exist in the training vocabulary; store the margin in `confidence`, source `bayes`. (A normalized-posterior threshold is the wrong gate: NB posteriors saturate toward 1.0 on almost any input, and "≥ 0.8 and ≥ 2× runner-up" is mathematically vacuous — ≥ 0.8 already forces ≥ 4×.)
5. Otherwise: uncategorized (`category_id NULL`, source `none`).

**Merchant renames (display only):** after normalization and alongside categorization, the engine applies **rename rules** (`rule_kind = 'rename'`, matched on `normalized_merchant` with the same exact-then-longest-contains precedence as category rules). A match writes `display_description = rename_to` and `display_source = 'rename'`.

- **Manual wins, always.** A row with `display_source = 'manual'` is never touched by a rename rule — not on import, not on re-run, not when the rule is edited. That is the whole precedence: `manual` > `rename` > unset (fall back to `raw_description`).
- **Renames never feed the machine.** `raw_description` stays immutable and `normalized_merchant` keeps deriving from it, so the dedup hash (§3, frozen) and every categorizer input — rule matching, Bayes tokens — are completely unaffected by what a row is *called* in the UI. Renaming is a presentation layer over untouched truth.
- **Creating or editing a rename rule bulk-applies it** to every existing matching row whose `display_source` is not `'manual'`, so the rename is retroactive without a re-import. Deleting a rename rule clears `display_description`/`display_source` on the rows it had set (`display_source = 'rename'` only), returning them to the raw text.
- Per-transaction rename ("this transaction only") sets `display_source = 'manual'` and creates no rule.

**Confirmed state & the learning loop:** accepting a Bayes guess, or manually setting/correcting a category, sets `source = 'manual'` — this is the *confirmed* state and the Bayes training set. Every confirmation (a) upserts an exact `merchant_rule` for that normalized merchant, (b) incrementally updates Bayes token counts (decrementing the old category's counts on recategorization). Bulk action in UI: "apply category to all N matching transactions + create rule."

**Review queue** = `category_id IS NULL` rows **plus all `source = 'bayes'` rows** (auto-assigned but not yet confirmed). One-click accept (→ `manual`, trains) or fix. Accepted rows leave the queue permanently; nothing re-enters it unless re-categorized by the engine after a reset.

**Transfer detection** runs before categorization: contains-match against *card-payment* patterns (`PAYMENT - THANK YOU`, `TD VISA PAYMENT`, `AMEX PAYMENT`, `TFR-TO`/`TFR-FR` between own accounts) sets `is_transfer`. **E-transfers are never auto-flagged** — an e-transfer to your own account is textually indistinguishable from rent to a landlord or a gift, and auto-flagging would silently erase real spending from reports. Users toggle those manually; a toggle teaches an exact-match transfer rule. Cross-account pair-matching is deferred to v2 (see Non-goals).

## 5. CSV import pipeline

1. Upload file (drag-drop), pick account — account remembers its profile; first time, pick preset or run wizard.
2. **Decode:** strict UTF-8 decode first; on failure, fall back to windows-1252 via iconv-lite (papaparse consumes strings — it has no encoding layer). Detected encoding shown on preview and overridable via the profile's `encoding` field. (French-Canadian merchant names — MÉTRO, CAFÉ — are exactly where a wrong guess produces mojibake.)
3. Parse with papaparse (quoted multi-line fields supported — Amex requires it). Apply profile mapping → candidate rows (raw date string, parsed date, description, amount_cents). Row-level errors (unparseable date/amount) collected, not fatal. Reject files > 5 MB or > 10,000 rows.
4. **Preview screen:** parsed table, duplicate rows flagged (dedup_hash already in DB), predicted category per row, error rows listed. User confirms (or adjusts mapping → profile forks if built-in → re-preview).
5. Commit: insert non-duplicates, record `transaction_imports` associations (including duplicate hits — see §3), create `imports` row, run transfer detection + categorizer.
6. Result summary: "N added, M duplicates skipped, E errors, K need review" with link to Review queue.
7. **Undo import** available from import history — safe-undo semantics per §3 `transaction_imports`.

## 6. Users, auth, security

**Threat model:** LAN-only app. Defends against: nosy guests on the wifi, a lost device with a saved session, accidental port exposure. **Honest caveat:** against a wifi guest specifically, plain HTTP is insufficient — shared-PSK WPA2 traffic is decryptable by anyone with the wifi password, exposing login credentials and session cookies. That is why HTTPS (reverse proxy or Tailscale) is the recommended default (§2) and plain HTTP is a documented opt-out for networks the household fully trusts. Not defending against nation-states.

- **Passwords:** argon2id (64 MB memory, time cost 3), min length 10, no composition rules (NIST-style).
- **Sessions:** random 256-bit token in httpOnly cookie, `SameSite=Lax`; `Secure` flag on when serving HTTPS directly or when `TRUST_PROXY` is on and `X-Forwarded-Proto: https`; server stores SHA-256 of token; 30-day sliding expiry; "log out everywhere" per user.
- **Rate limiting (two independent layers):** per (username, ip): 5 failures in 15 min → 15-min lockout. Per username regardless of IP: 10 failures in 15 min → lockout with exponential backoff (15 min doubling per repeat) — an attacker on the LAN can rotate IPs, so an IP-keyed limiter alone is bypassable. Client IP from socket unless `TRUST_PROXY`. Generic error messages (no user enumeration).
- **TOTP MFA (optional per user):** otplib; QR enrollment; secret encrypted at rest with **AES-256-GCM under a key derived via HKDF-SHA256(SECRET_KEY, info='totp-v1')**; stored as base64(iv ‖ tag ‖ ciphertext) in the single column; ±1 time-step tolerance. **Recovery codes:** 8 single-use codes, each 16 random base32 chars (~80 bits), stored SHA-256-hashed — entropy makes argon2 unnecessary and avoids 64 MB × 8 hash verification on a NAS. **Admin "reset MFA"** action clears a member's TOTP enrollment (lost phone + lost codes ≠ permanent lockout).
- **Roles / authorization matrix:**
  - *All members:* full household visibility (dashboard person-switcher, all transactions, all reports); categorize, attribute, and transfer-flag any transaction; edit household budgets and shared goals; manage own personal budgets, own goals, own password/MFA. Family-trust model — the household sees everything by design.
  - *Admin additionally:* user management (create/deactivate/reset password/reset MFA), categories manager, merchant-rules manager, import-profiles manager, backups, **SimpleFIN connections (§12)** — claiming a setup token and linking accounts hands the app read-only bank credentials, so it is admin-only.
- **First-run:** if `users` is empty, `/setup` wizard: create admin → seed categories → optionally create accounts. Registration closed otherwise; only admins add users.
- **Headers/CSRF:** strict CSP (self-only), `X-Frame-Options: DENY`, Referrer-Policy. Primary CSRF check: **Origin header verified against Host** on all mutating requests (server actions get Next.js origin checking; custom route handlers implement the same). `Sec-Fetch-Site` used opportunistically only — browsers omit fetch-metadata on plain-HTTP (non-trustworthy) origins, so it cannot be the primary check.
- **Container hardening:** non-root user, read-only root FS, `/data` writable, **tmpfs mounted at `/tmp`** (Node runtime needs a tmpdir; Next cache writes avoided via `images.unoptimized` — if any `.next/cache` write path remains, tmpfs-mount it too), no added capabilities.
- **Backups are unencrypted SQLite copies** (LAN-only threat model accepted); README notes Hyper Backup client-side encryption for offsite copies.

## 7. Pages / UI

| Page | Contents |
|---|---|
| Dashboard | Person scope switcher (Household / each member — scopes by attribution, §3). Current-month category budget bars (budget vs actual, parents roll up children), 12-month cashflow trend (income vs spend, transfers excluded), top merchants this month, goals progress cards, review-queue count badge. |
| Transactions | Paginated table; filters: account, category, person (attribution), date range, text search, uncategorized-only. Inline category + attribution editing, bulk select → categorize / attribute / mark transfer. **Inline display-name edit:** the description cell shows `display_description` when set (raw otherwise, with the raw text available on hover/expand); saving a new name asks **"this transaction only"** (sets `display_source='manual'`) or **"all matching + future"** (creates a rename rule and bulk-applies it, §4). Manual entry form (date, account, description, amount, category). |
| Review queue | Uncategorized + unconfirmed Bayes rows; accept / fix / bulk-apply + rule creation. |
| Import | Upload → decode/preview → commit flow; import history with safe undo; new-bank mapping wizard. |
| Budgets | Month picker. Household section + per-person section: category rows (parents with nested children) with limit, net spent, remaining, progress bar; add/edit limits (upsert at viewed month); clear budget; copy-previous-month. |
| Goals | Goal cards (owner badge: member name or Shared): saved / target, target date, required-monthly, projected finish (with §3 edge branches); add contribution; archive. |
| Reports | Category breakdown (pie/bar) for arbitrary date range; month-over-month category trends; per-person spend split (attribution buckets incl. "Household/unattributed"); CSV export of any filtered view. |
| Settings | Profile (password, TOTP). Admin: users (create/deactivate/reset password/reset MFA), categories manager (archive-only), merchant rules manager (category, transfer **and rename** rules, incl. rules-pack export/import, §11), import profiles (incl. profile-pack export/import, §11), **Connections (SimpleFIN)** (claim a setup token, link/unlink remote accounts, Sync now, request-budget and error display, §12), backup (download now, view nightly history). |

Design language: clean, data-dense, Mint-adjacent. Dark/light per system preference. (Visual design decided at implementation time; not a spec concern beyond "responsive, accessible, charts readable".)

## 8. Backup & operations

- Nightly (02:00 local) in-process job: delete target file if present, then `VACUUM INTO '/data/backups/budget-YYYY-MM-DD.db'` (`VACUUM INTO` errors on existing files — container restarts after 02:00 would otherwise fail the day's backup permanently); retain most recent 14 (configurable). Then maintenance sweep (§3).
- Settings → "Download backup now": `VACUUM INTO '/data/tmp/<uuid>.db'`, stream to browser, unlink after (only `/data` is writable; must not collide with nightly filenames).
- Restore procedure (README): stop container → replace `/data/budget.db` (and remove `-wal`/`-shm` files) with backup → start.
- Synology guidance: put `/data` on a share covered by Hyper Backup / Snapshot Replication for offsite.
- Logs to stdout (docker logs). Health endpoint `/api/health` for container healthcheck.

## 9. Repository & delivery

- Git repo in project folder (commits currently paused at user request). Structure: standard Next.js (`src/app`, `src/lib`, `src/db`, `src/components`), `fixtures/` for CSV test files, `docs/` for specs/plans, `install/` for installers, `Dockerfile`, `docker-compose.yml`, `README.md` (overview + pointer to INSTALL.md; HTTPS via reverse proxy; Tailscale; SECRET_KEY generation + loss consequences).

### Install experience (user-friendly packaging)

Goal: installs like a regular app — prerequisites stated, one script or one guided walkthrough per platform, working URL at the end.

- **`INSTALL.md`** — master doc: prerequisite matrix per platform (x86_64/ARM64, ~1 GB RAM free, Docker/Container Manager version floors, port 3000 or override), per-platform quick-starts, update, uninstall, restore-from-backup, troubleshooting FAQ (port in use, `/data` permissions, forgot password, forgot SECRET_KEY).
- **`install/install-linux.sh`** — idempotent: checks Docker + compose plugin (prints distro-specific install commands if missing), generates `SECRET_KEY` (`openssl rand -base64 48`), writes `.env` + compose override, builds image, `docker compose up -d`, waits on `/api/health`, prints URL + first-run instructions. Flags: `--update` (rebuild, restart, data preserved), `--uninstall` (container/image removed, `/data` kept unless `--purge-data`).
- **`install/install-windows.ps1`** — same flow for Windows: checks Docker Desktop + WSL2 (guides enablement if missing), then identical steps.
- **Raspberry Pi:** covered by `install-linux.sh` (ARM64 auto-detected); INSTALL.md gets a dedicated Pi section — requires 64-bit Raspberry Pi OS (Pi 4/5), 2 GB RAM to run; on-device image build needs ~4 GB (Pi 5), otherwise build on a PC and transfer via `docker save`/`docker load` (script supports `--load <image.tar>`).
- **Synology (primary target, two paths):** `docs/INSTALL-SYNOLOGY.md` click-by-click Container Manager walkthrough (create Project → paste prepared `install/synology-compose.yml` → set SECRET_KEY → start → open URL) requiring no SSH; and `install/install-synology.sh` for SSH-comfortable users (same script family as Linux).
- **`install/update.sh` / `install/update.ps1` — manual-only, semver-safe, self-rolling-back.** The user runs these by hand; there is **no scheduler, no auto-update, and no in-app "update available" banner** (both are §13 v2 candidates). Each run, in order: (1) optional `git pull --ff-only` when the folder is a configured git checkout — skipped with a note otherwise; (2) **base-image refresh** (`docker pull node:22-bookworm-slim`) so security fixes in the base arrive without a version bump; (3) **semver-safe dependency update** — `npm update` respecting the lockfile's caret ranges, i.e. **patch and minor only**; major upgrades are never taken automatically and stay a deliberate manual-with-AI task; (4) **tag the currently running image as the rollback point** (`budget-tracker:previous`) before anything replaces it; (5) rebuild; (6) restart; (7) **poll `/api/health`**; (8) **auto-rollback** if it does not become healthy inside the timeout — retag `budget-tracker:previous` back to `:latest`, restart, re-verify, and report the failure with the log excerpt. `/data` is never touched by any step, including the rollback. Prints the app version and the dependency-change summary before and after.
- **Rescue tooling:** `scripts/reset-admin-password.ts` (run via `docker exec`, resets a named user's password + clears their lockout; documented in INSTALL.md FAQ).
- **Distribution default: local image build** (fully offline, no accounts). Optional later enhancement (explicitly deferred, needs a GitHub repo decision): publish multi-arch images to GHCR so installs become pull-only with no build wait.
- Installer scripts are tested by running them in CI-style dry-run mode (`--dry-run` prints planned actions); full end-to-end install verified manually per platform (documented QA checklist).

## 10. Testing strategy

- **Unit (Vitest):** learning normalizer; frozen dedup normalization — including the invariant that dedup hashes are **unchanged by learning-normalizer upgrades and profile mapping edits**; each built-in preset parser against fixture CSVs (built from user's real exports, values scrubbed; Amex fixture includes quoted multi-line fields); encoding detection (UTF-8 vs windows-1252 incl. accented merchants); mapping wizard parser; dedup hashing (same-day duplicates, re-import idempotency, error rows not consuming occurrence indexes, manual-entry NULL exemption); categorizer rules + Bayes (train/correct/reclassify, accept→manual transition, log-margin gating, re-run never touches manual/rule rows); transfer detection (card-payment patterns only; e-transfers untouched); refund netting; budget effective-month resolution, unique-index semantics, clear-budget rows, rollup math; attribution scoping (personal budgets vs household with joint accounts); goal pace math incl. edge branches; TOTP encrypt/decrypt (HKDF + GCM framing); recovery-code flow; two-layer rate limiting incl. IP-rotation bypass resistance; **merchant renames** (rename rule matched exact-then-longest-contains; `display_source='manual'` never overwritten by a rule or a re-run; creating/editing a rule bulk-applies retroactively; deleting a rule clears only the rows it set; `raw_description`, `normalized_merchant` and the dedup hash provably unchanged by any rename); **SimpleFIN units** (setup-token base64 decode → claim URL; access-URL encrypt/decrypt under HKDF info `'simplefin-v1'`; basic-auth credentials parsed out of the access URL and never logged; ≤90-day window arithmetic with 5-day overlap; unix `posted` → ISO date in `TZ`; amount → integer cents with negative = debit; pending rows skipped; daily request-counter guard refusing past 20 and resetting on date change; non-CAD currency warning).
- **Integration:** full import pipeline (upload → decode → preview → commit → overlapping second import → undo of first import preserves shared rows) against a temp SQLite file; auth flows (login, lockout + backoff, TOTP enroll + login, MFA reset by admin, session expiry); setup wizard; sharing packs round-trip (export → import on fresh DB → categories created by name, rules land, conflicts respect keep/overwrite, transfer rules excluded by default, version/format rejection); **SimpleFIN sync against a mocked bridge** (claim once → reusing a spent setup token is rejected; first sync inserts, immediate second sync over an overlapping window inserts nothing thanks to `external_id`; each sync creates an `imports` row and undo behaves exactly like a CSV import; `errlist` entries are surfaced rather than swallowed; a linked account refuses CSV import and unlinking restores it); **update-script rollback logic** (the bash-testable parts: health-poll failure triggers the retag-and-restart path, `/data` is never in any destructive command, `--dry-run` prints the whole plan including the rollback branch).
- **Process:** TDD (superpowers workflow) during implementation. Manual QA checklist for UI flows in lieu of browser-automation suite (v1 token/effort economy); Playwright smoke tests are a v2 candidate.

## 11. Sharing packs (rules & profiles)

Two export/import formats for sharing learned knowledge between installs **without any personal data**. Both are JSON files with a versioned envelope; import rejects unknown `format` or newer `version` with a clear message. Both live in Settings (admin), per §7.

### Rules pack
```json
{ "format": "budget-tracker-rules", "version": 1, "exported_at": "...",
  "categories": [{ "name": "Coffee", "parent": "Food", "is_income": false, "icon": "...", "color": "..." }],
  "rules": [{ "pattern": "TIM HORTONS", "match_type": "exact", "category": "Coffee" }] }
```
Rules may carry two optional fields: `rule_kind` (`"category"` default | `"transfer"` — present only when transfer rules are explicitly included) and `category_parent` (disambiguates a leaf name that repeats under two parents). Packs without them — like the example above — import cleanly.
- Contains **category definitions** (referenced by name + parent name — receiver installs have different row ids) and **category rules only**.
- **Rename rules (`rule_kind = 'rename'`, §4) are not exported in v1** and are rejected on import, so the pack format stays at version 1. They are display preferences rather than categorization knowledge, and the v1 envelope enumerates category rules. Sharing them is a §13 candidate.
- **Never contains:** transactions, amounts, accounts, users, Bayes token statistics (derived from personal history; the receiver's Bayes retrains from their own confirmations).
- **Transfer rules excluded by default** (exact e-transfer descriptors can embed personal names); an explicit "include transfer rules" toggle exists for intra-household use.
- **Export preview:** full list of patterns about to be exported, with per-rule exclusion checkboxes, shown before the file is generated — the user sees every string that will leave the system.
- **Import preview:** counts + list (N new rules, M conflicts, K new categories). Category matching is by name (case-insensitive), parents created as needed, matched categories reused. Conflict (pattern+match_type exists with a different category): default **keep existing**, per-import "overwrite with incoming" option. Imported rules get `created_by = NULL`, `hit_count = 0`.

### Profile pack
```json
{ "format": "budget-tracker-profiles", "version": 1, "exported_at": "...",
  "profiles": [{ "name": "Scotiabank Chequing", "institution": "Scotiabank", "mapping": { } }] }
```
- Contains import profiles' `name, institution, mapping` JSON only — pure column-layout knowledge, no personal data by construction.
- Import: name collision → auto-rename ("Scotiabank Chequing (2)"). Imported profiles are non-builtin.

## 12. SimpleFIN connector (optional)

**Dormant until configured.** No SimpleFIN table has a row and no request is ever made until an admin pastes a setup token. An install that never touches this section behaves exactly like §1–§11 describe: CSV only, zero network traffic at runtime.

SimpleFIN is chosen over Plaid/Flinks because it is a read-only, user-brokered protocol: the user obtains a token from their own bridge, the app exchanges it once for a read-only access URL, and there is no commercial relationship, no OAuth redirect, and no third party holding the user's banking credentials on the app's behalf.

### Protocol facts (per the SimpleFIN developer docs)

- A **setup token** is a base64 string that decodes to a **claim URL**.
- `POST` to the claim URL with `Content-Length: 0` **claims it exactly once** and returns an **access URL** with basic-auth credentials embedded (`https://user:pass@host/path`). The setup token is spent — reusing it fails, and the app must treat that as a normal, explainable error.
- `GET <access-url>/accounts?version=2&start-date=<unix>&end-date=<unix>` returns
  ```json
  { "accounts": [ { "id": "...", "name": "...", "currency": "CAD", "balance": "1234.56", "balance-date": 1755216000,
                    "transactions": [ { "id": "...", "posted": 1755216000, "amount": "-12.34", "description": "...", "pending": false } ] } ],
    "errlist": [] }
  ```
- The window must be **≤ 90 days**. Rate limit is roughly **24 requests per day per token**.
- Recommended practice: re-request with a **5-day overlap** so late-posting transactions are not missed.

### Design

- **Claim (admin, Settings → Connections):** paste the setup token → the app base64-decodes it, POSTs the claim, and stores the returned access URL **encrypted at rest with AES-256-GCM under a key derived via HKDF-SHA256(SECRET_KEY, info='simplefin-v1')**, framed as base64(iv ‖ tag ‖ ciphertext) — the same crypto module and framing as the TOTP secrets in §6, with a different `info` string so the two key streams are independent. The plaintext access URL is never logged, never rendered in the UI, and never leaves the server.
- **Mapping:** after claiming, the app lists the remote accounts and the admin maps each one it wants to a local account. Unmapped remote accounts are simply ignored. One remote account maps to at most one local account (`simplefin_account_links` PK), and a mapped local account becomes SimpleFIN-managed (see §3 **accounts**: CSV import is then refused for it, with a warning shown before the link is created and CSV restored on unlink).
- **Sync is manual only.** A "Sync now" button, admin-triggered. There is no scheduler, no background poll, and no auto-sync on login (a scheduled variant is a §13 candidate).
- **Window:** `end-date` = now; `start-date` = `min(last_sync_at − 5 days, now − 90 days)`, and `now − 90 days` on a first sync. The 5-day overlap is deliberate and safe: `external_id` makes re-seeing a transaction a no-op.
- **Row mapping:** `pending: true` rows are **skipped entirely** (they change id and amount before settling). `amount` → integer cents, negative = debit, matching the app's sign convention with no transformation. `posted` (unix seconds) → ISO `YYYY-MM-DD` in the configured `TZ`. `description` → `raw_description`, then the normal §4 pipeline runs: normalize → rename rules → transfer detection → categorizer.
- **Dedup:** `external_id` = the provider's transaction id, protected by the partial unique index on `(account_id, external_id)` (§3). This is exact and cheap; the CSV `dedup_hash` machinery is not used for SimpleFIN rows and stays `NULL` on them.
- **Every sync creates an `imports` row** (`filename` = a synthetic label such as `simplefin 2026-08-15 14:03`), records `transaction_imports` associations for inserted *and* duplicate-skipped rows, and is therefore **undoable exactly like a CSV import** — same safe-undo semantics, same shared-row protection (§3).
- **Request-budget guard:** every outbound call increments `requests_today` (resetting when `requests_date` is not today in `TZ`). At **20** the app refuses to sync and says so, leaving headroom under the bridge's ~24/day limit rather than discovering the ceiling by hitting it.
- **`errlist` is always surfaced.** Bridge-reported errors are shown verbatim in the Connections UI and in the sync result, never swallowed. A non-empty `errlist` with zero accounts is reported as a failed sync.
- **Currency:** anything other than `CAD` produces a visible warning at link time and on every sync. v1 stores integer cents with no conversion (§1 non-goals), so mixing currencies would corrupt reports.

### Threat model note

The stored access URL **is** a read-only credential for the user's bank data — losing it is comparable to losing a read-only bank export feed. Hence: encrypted at rest under a `SECRET_KEY`-derived key, admin-only to view or manage, never written to logs or backups in plaintext (it lives in the database, so it is inside the unencrypted SQLite backup — the §8 guidance to enable Hyper Backup's client-side encryption for offsite copies matters more once a connection exists, and the Connections UI says so). Rotating `SECRET_KEY` makes the stored access URL undecryptable and the admin must re-claim a fresh setup token — the same consequence, and the same remedy, as the TOTP enrollments in §6.

## 13. v2 candidates (explicitly deferred)

Recurring-subscription detection, passkeys/WebAuthn, cross-account transfer pair-matching, Amex Category column as categorizer hint, per-merchant attribution learning, Playwright suite, receipt attachments, net-worth/account-balance tracking from CSV balance columns, per-category rollover budgets, **SimpleFIN scheduled auto-sync** (a nightly job driving §12 instead of the manual button), **in-app "update available" banner** (the update tooling in §9 is deliberately manual-only and silent in v1), **rename rules in sharing packs** (needs a pack format bump, §11).

---

## Revision history

- **v1.0** (2026-08-15): initial approved design.
- **v1.4** (2026-08-15): three approved design changes. **(1) Update tooling is manual-only** — §9's `update.sh`/`update.ps1` bullet rewritten: base-image refresh, semver-safe (patch/minor) dependency updates, rebuild, restart, health-check, and auto-rollback to the previous image tag when unhealthy; optional git-pull when a repo is configured; explicitly no scheduler, no auto-update, no in-app banner (banner moved to §13). **(2) SimpleFIN connector** — new §12, dormant until configured: claim-once setup token, access URL encrypted under HKDF-SHA256(SECRET_KEY, info='simplefin-v1'), manual "Sync now", 5-day overlap windows within the ≤90-day limit, pending rows skipped, `external_id` partial-unique dedup, an `imports` row per sync so undo works exactly as CSV does, app-side 20/day request guard, `errlist` always surfaced, non-CAD warning, and the hard rule that an account is CSV-managed or SimpleFIN-managed but never both. New tables `simplefin_connections` and `simplefin_account_links`; §1 non-goals narrowed from "no bank API sync" to "no Plaid/Flinks"; §2 network-calls line carries the opt-in exception; §6 roles matrix and §7 Settings gain Connections; §10 gains the mocked-bridge tests. **(3) Merchant renames** — `merchant_rules.rule_kind` gains `'rename'` plus a nullable `rename_to`; `transactions` gains `display_description`/`display_source`; §4 gains a rename-application block with `manual > rename > raw` precedence, retroactive bulk-apply, and the invariant that renames never touch `raw_description`, `normalized_merchant` or the dedup hash; §7 Transactions gains the two-scope display-name edit. Rename rules are excluded from §11 sharing packs in v1 (§13 candidate). Old §12 v2 candidates renumbered to §13.
- **v1.3** (2026-08-15): §9 expanded with install experience per user request — INSTALL.md, per-platform installer scripts (Linux/Windows/Synology SSH), Synology no-SSH walkthrough, update/uninstall flows, reset-admin-password rescue script, local-build distribution default (GHCR prebuilt images deferred).
- **v1.2** (2026-08-15): added §11 sharing packs (rules pack + profile pack export/import, privacy-preserving by construction) per user request; Settings row and tests updated; v2 candidates renumbered to §12.
- **v1.1** (2026-08-15): applied 30 merged findings from two independent adversarial reviews (Opus + Fable agents). Material changes: frozen versioned dedup normalization independent of the learning normalizer; `transaction_imports` join table for overlap-safe undo; confirmed-state semantics (`source='manual'` = training set, review queue = NULL ∪ unconfirmed bayes); `attributed_user_id` for per-person scoping with joint accounts; Bayes gate changed from vacuous posterior threshold to log-likelihood margin; category rollup rule; refund netting rule; budget uniqueness/clear/edit semantics; e-transfer auto-flagging removed; copy-on-write presets; encoding detection; base image Alpine→bookworm-slim; backup VACUUM INTO fixes; HTTPS as recommended default with honest wifi-guest caveat; two-layer rate limiting; HKDF/GCM framing for TOTP secrets; SHA-256 recovery codes; admin MFA reset; index enumeration + FK pragma + retention sweeps.
