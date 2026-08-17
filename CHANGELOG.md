<!--
  HOW TO KEEP THIS FILE

  Every update session does two things, together, in the same change:
    1. bump "version" in package.json (that field is the single source of truth), and
    2. move the Unreleased notes below into a new dated section for that version.

  install/update.sh and install/update.ps1 both print package.json's version before and
  after an update, Settings -> About shows it next to this file's contents, and
  /api/health reports it — so a bump with no entry here is immediately visible as a gap.

  Format follows Keep a Changelog (https://keepachangelog.com/en/1.1.0/) and the version
  numbers follow Semantic Versioning. Keep the group headings to the standard set:
  Added, Changed, Deprecated, Removed, Fixed, Security. Leave the Unreleased section in
  place (empty is fine) so the next session has somewhere to write.
-->

# Changelog

All notable changes to Budget Tracker are recorded here.

## Unreleased

## [1.2.2] - 2026-08-17

### Added

- **Contract and loan item kinds.** Item types now carry a `kind` — warranty, subscription,
  contract, or loan — alongside the existing subscription flag (kept, and derived from `kind`
  on every write). Loans and contracts reuse the exact same start-date/term/end-date fields as
  warranties and subscriptions; loans are dates and documents only — no balance, no payment
  schedule, no interest math (deliberate scope cut).
- **Kind-aware wording** throughout the tracker: the add/edit forms, the list, the detail page
  and the dashboard widget all show labels and verbs (start date / term / end date / "expires"
  vs. "cancel by" vs. "ends on" vs. "paid off by") that follow the item's own kind — and, on
  the add and edit forms, follow the **currently selected type live**, before saving.

### Changed

- **The warranty tracker is renamed "Contracts & Coverage"** in the navigation, the list page
  title and the add-item header — user feedback that the tracker had grown past warranties
  alone. Labels only: every route, action and field name is unchanged.
- Form labels changed to match the new kind matrix: "Warranty length" → "Warranty (months)",
  a subscription's "Period start" → "Start date", "Period length" → "Duration (months)", and
  the "Cancel by" label → "Cancel-by date" (detail page) / "Active through" (live badge).
  Deliberate, owner-approved wording changes — see the design spec §19.12 for the full list.
- Dashboard widget retitled "Warranties expiring soon" → **"Coming due"**.
- List page empty state retitled "No warranties yet" → "Nothing tracked yet", naming all four
  kinds.

## [1.2.1] - 2026-08-17

### Added

- **Zero-config SECRET_KEY.** A fresh install no longer needs one set at all: if `SECRET_KEY`
  is unset on first boot, the app generates a random key itself at `data/secret.key` and
  reuses it on every start after that. Setting `SECRET_KEY` yourself still works exactly as
  before and always takes precedence — this only removes the requirement, not the option.
- **Prebuilt multi-arch images on GHCR.** Tagging a release (`v*`) or running the new
  `Release image` workflow by hand builds and pushes `ghcr.io/manavgrewal/budgettracker`
  for linux/amd64 and linux/arm64, tagged with both the version and `latest`. Paired with a
  new pull-only compose file, `install/synology-compose-pull.yml`, installing no longer
  requires a source checkout or a `docker build` — Immich-style paste-and-go, on Synology,
  QNAP, Unraid, or any other Docker host.

### Changed

- `docker-compose.yml`, `install/synology-compose.yml` and `install/synology-compose-pull.yml`
  no longer require `SECRET_KEY` to be set before starting — the pull compose drops the
  placeholder line entirely, and the other two ship it commented out as an optional override.
  The install scripts (`install-linux.sh`, `install-windows.ps1`, `install-synology.sh`) are
  unchanged: they still generate a `.env` with its own `SECRET_KEY` up front, which remains
  best practice for a script-driven install and simply takes precedence over the generated
  file, same as any other explicitly-set `SECRET_KEY`.

## [1.2.0] - 2026-08-17

**Verify after updating:** restore a backup once via Settings → Backups → Restore — the app
will restart itself, be unreachable for about 30 seconds, and show the restore outcome on
Settings → Backups when it comes back. If your container runs without a restart policy
(docker-compose.yml ships restart: unless-stopped, so this is only relevant for a custom
setup), starting it back up by hand applies the restore the same way.

### Added

- **Restore from Settings.** Restoring a backup no longer requires stopping the container by
  hand: pick a backup on **Settings → Backups**, tick the confirm box and click **Restore and
  restart**. The archive is fully validated before anything is staged, then the app restarts
  itself and applies the restore on the way back up, before the database is opened — the page
  is unreachable for about 30 seconds, and refreshing it afterwards shows whether the restore
  succeeded. The previous database and (for a `.tar.gz` restore) the previous receipts folder
  are kept as timestamped safety copies and swept after 30 days, with the most recent of each
  always kept. If the container has no restart policy, nothing is lost: the request survives
  on disk and is applied the next time the app is started, by hand or otherwise. A backup made
  by a newer version of Budget Tracker than the one running is refused with an explanation.
- **A modern visual redesign**, light and dark, following your device's theme by default with
  a manual toggle in the header that remembers your choice. Every page — dashboard,
  transactions, import, review, budgets, goals, reports, warranties and every settings page —
  now shares one design system: a real navigation rail on desktop that collapses to a top bar
  and menu on phones, consistent cards, tables, buttons and empty states, and signed amounts
  coloured by sign. Accessibility pass included: clearer focus rings, labelled icon-only
  buttons, and form fields properly associated with their labels.

### Changed

- The `restore-backup` CLI gains `--allow-newer` to bypass the one-way migration guard for a
  genuine disaster-recovery case, and now takes its own timestamped safety copy of the
  database (and receipts, for an archive) before writing anything, with the same preflight
  validation the in-app restore uses.
- The README and INSTALL guides now lead with the Settings → Backups restore path, keeping the
  CLI procedure as the documented fallback for when the app will not start at all.

### Fixed

- Synology installs no longer assume `/volume1`: the installer roots at wherever the project
  checkout actually lives, so any-volume installs work correctly.
- An inherited Synology ACL on the data directory could leave the database unopenable
  (`SQLITE_CANTOPEN`) even with permissions showing `777`; the installer now removes the
  inherited ACL so the container can actually write to it.
- Existing Synology installs updating from the old absolute-path compose file: move your
  existing `data` folder into the project folder (or keep your old absolute-path `volumes:`
  line) before pasting in the new compose, otherwise the app boots empty against a fresh
  `./data`.

### Security

- Restoring a backup is admin-only and same-origin-checked, and restorable artifacts are
  limited to files already inside `data/backups` that match the backup naming pattern.
- A backup made by a newer version of Budget Tracker than the one running is refused (the
  `restore-backup` CLI's `--allow-newer` flag overrides this for disaster recovery).
- The Synology data directory is no longer created world-writable: the installer now sets
  `chmod 770` instead of `777`.

## [1.1.0] - 2026-08-16

### Added

- **Warranty tracker.** Record what you bought, who owns it, what it cost and how long it is
  covered — months, or a Lifetime tick for the things that never expire. A new Warranties
  page lists everything with an at-a-glance badge: active, expiring soon, expired, lifetime,
  or term unknown.
- **Item types**, admin-maintained under **Settings → Item types** (Laptop, Appliance and
  Subscription seeded), and **subscription tracking**: a subscription item reuses the same
  purchase-date/months fields as a period start and length, is labelled "cancel by" instead
  of "expires" throughout, and is covered by the same dashboard reminder before the period
  ends. A type still in use by an item cannot be deleted until those items are moved to
  another type.
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

## [1.0.0] - 2026-08-16

Initial release: a self-hosted household budget tracker for a home NAS.

### Added

- **CSV import** with built-in Canadian bank presets (TD Chequing/Debit, TD Visa,
  Scotiabank Chequing/Debit, Amex Canada), a preview-and-confirm step with an editable
  column mapping, copy-on-write profile forking, encoding detection, a versioned duplicate
  hash that survives overlapping exports, per-import undo, and a wizard that builds a
  profile for any other bank from a sample file.
- **Learning categorizer**: merchant rules plus a naive-Bayes classifier that trains on
  confirmed corrections, transfer detection for card payments, merchant renames with
  `manual > rename > raw` precedence, and a review queue of everything uncategorized or
  auto-guessed.
- **Budgets**, household and per-person, with monthly limits that carry forward until
  changed, category rollup, refunds netting against spend, and copy-from-previous-month.
- **Goals** with contributions, trailing-average pace, required monthly amount against a
  target date, and archiving.
- **Accounts, transactions and reports**: manual entries, bulk categorize/attribute/
  transfer actions, per-person attribution on joint accounts, cashflow trend, category
  breakdown, month-over-month comparison, top merchants, and CSV export.
- **Authentication and security**: argon2id passwords, a first-run setup wizard, optional
  TOTP two-factor with QR enrollment and single-use recovery codes, admin MFA reset,
  server-side sessions with sliding expiry, two-layer login rate limiting, an
  Origin-verified CSRF check on every mutating request, and a strict nonce-based CSP.
- **Backups**: scheduled and on-demand `VACUUM INTO` snapshots with retention, download
  from the browser, and a documented restore procedure.
- **Sharing packs**: export and import merchant-rule and import-profile packs,
  privacy-preserving by construction.
- **SimpleFIN connector** (optional, dormant until configured): claim-once setup token, an
  encrypted access URL, manual sync with overlap windows, and the same undo path as CSV.
- **Installers and operations**: Linux, Windows and Synology install scripts, a
  manual-only update script with automatic rollback, a Docker image that runs non-root on
  a read-only root filesystem, a container healthcheck, and a password-reset rescue tool.
