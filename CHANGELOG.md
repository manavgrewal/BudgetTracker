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

## [1.3.0] - 2026-08-17

### Added

- **Notifications.** A new Settings -> Notifications page tells the household about the
  things it would otherwise have to remember to check on: something coming due, a budget
  getting close or blown through, the nightly backup failing, a new sign-in, a restore
  finishing, or nothing imported in a while. Eight events in total, each switchable per
  person and per channel.
- **Two channels.** A personal Telegram bot per user, and a household SMTP relay with a
  personal destination address per user. Email setup has one-press presets for Brevo,
  SMTP2GO and Gmail, plus a Custom option for anything else.
- **Send test** on every channel, so nobody has to trust that setup worked and wait for
  the real thing to fire.
- **Built-in setup guides**, written for someone who has never touched SMTP or a Telegram
  bot before, one for Telegram and one per email preset, shown right beside the form they
  describe. A **Detect chat ID** button asks Telegram which conversations your bot has
  heard from and lists them by name, so nobody has to copy a numeric id out of a raw JSON
  page.
- **Per-person schedule and threshold controls**: the warning window before something
  comes due, the budget percentage that counts as close, the staleness period for "nothing
  imported lately", and the hour the daily and weekly messages go out. Daily and weekly
  sends catch up on a missed slot after downtime instead of silently skipping it.
- **Recent deliveries** on the same page, showing what was sent, on which channel, and the
  provider's own error text when a send failed.

### Security

- The SMTP password and every Telegram bot token are encrypted at rest under keys derived
  from `SECRET_KEY`, the same way the existing TOTP secrets and the SimpleFIN access URL
  already are. They are never sent back to the browser, never logged, and shown masked in
  the form after saving.
- **A new sign-in alert is on by default**, naming the time, IP address and browser, so a
  household notices a login it did not expect.
- **Dormant until configured.** With no channel set up, notifications make no outbound
  connection at all, and the only two destinations the feature can ever reach, once
  someone does configure it, are `api.telegram.org` and the SMTP server an admin typed in.

## [1.2.4] - 2026-08-17

### Fixed

- **Edit no longer opens below the item detail view.** On a Contracts & Coverage item's
  detail page, clicking Edit used to render the edit form BELOW the still-visible read-only
  view, so a scrolled-down member saw no change and assumed the click did nothing. The edit
  form now replaces the read-only view in place; Cancel edit (or a successful save) restores
  the view.
- **Success message now names the item's actual kind.** Saving an edit used to always say
  "Warranty updated.", even for a subscription, contract, or loan. The confirmation now reads
  "Subscription updated.", "Contract updated.", "Loan updated.", or "Warranty updated." to
  match the item's own type, reusing the existing per-kind noun matrix in
  `src/lib/warranty/constants.ts`. A handful of generic error strings in `actions.ts` that
  hard-coded "warranty" regardless of kind (e.g. "That warranty no longer exists.") were swept
  to the neutral "item" wording at the same time.

## [1.2.3] - 2026-08-17

### Added

- **Automatic updates for the prebuilt-image install.** `install/synology-compose-pull.yml`
  now ships a Watchtower companion service alongside `budget-tracker`. Watchtower polls GHCR
  once a day, pulls a newer `:latest` image when one is published, and recreates the
  container against it. You no longer need to re-pull manually or click Update in Container
  Manager. Database migrations already run automatically on boot, so the container can be
  replaced unattended without any extra step. Scoped to this app only via
  `com.centurylinklabs.watchtower.enable: "true"` on the budget-tracker service and
  `WATCHTOWER_LABEL_ENABLE` on watchtower, so the socket access it needs never reaches any
  other container on the host.
- **Billing cycle and amount for subscriptions and contracts.** The add/edit item form now
  shows a Billing cycle select (Monthly/Annual, defaulting to "Not set") and an amount field
  for items whose type is a subscription or contract, never for warranty or loan. The item
  detail page and the items list show the formatted amount and cycle (e.g. "$15.99 / month")
  wherever it is set. Enforced server-side by looking up the selected type's kind, matching
  every other kind-dependent rule in the tracker (migration `0005_billing_cycle.sql` adds the
  two nullable, CHECK-constrained columns to `warranty_items`).

### Changed

- Pinning `synology-compose-pull.yml` to a specific version tag now also means opting out of
  auto-updates: Watchtower only replaces a container when a newer image lands for the tag it
  is already running, so a pinned numeric tag is left alone. The compose file's comments and
  `docs/INSTALL-SYNOLOGY.md` now document this trade-off and how to remove the watchtower
  service entirely if you would rather it not run at all.
- `docs/INSTALL-SYNOLOGY.md`'s update instructions now lead with "nothing to do" for the
  default auto-updating install, keep the manual tag-edit path for pinned installs, and note
  that Container Manager's Image tab "Update" button does not work for GHCR images (Docker
  Hub only), which is why Watchtower exists in the compose file at all.

### Fixed

- Existing pre-1.2.3 installs of the prebuilt image had no update mechanism at all: Container
  Manager cannot detect GHCR updates and never re-pulls an already-present `:latest` tag, so
  those installs were effectively stuck on whatever image they first pulled. Documented the
  one-time YAML-replace step to adopt the new compose file and gain auto-updates.
- An open-ended item (the "no end date" / Lifetime checkbox) used to render its end date as a
  bare blank or em dash on the items list and detail page, indistinguishable from missing data.
  It now shows a proper per-kind word instead: "Lifetime" for a warranty or subscription,
  "Ongoing" for a contract, "Open-ended" for a loan. Open-ended items were already excluded
  from the dashboard's "Coming due" widget and every expiring-soon query; a regression test
  now pins that guarantee.
- Mobile menu now opens in view when scrolled (was rendering off-screen at page top).

## [1.2.2] - 2026-08-17

### Added

- **Contract and loan item kinds.** Item types now carry a `kind` (warranty, subscription,
  contract, or loan) alongside the existing subscription flag (kept, and derived from `kind`
  on every write). Loans and contracts reuse the exact same start-date/term/end-date fields as
  warranties and subscriptions; loans are dates and documents only, with no balance, payment
  schedule, or interest math (deliberate scope cut).
- **Kind-aware wording** throughout the tracker: the add/edit forms, the list, the detail page
  and the dashboard widget all show labels and verbs (start date / term / end date / "expires"
  vs. "cancel by" vs. "ends on" vs. "paid off by") that follow the item's own kind, and, on
  the add and edit forms, follow the **currently selected type live**, before saving.

### Changed

- **The warranty tracker is renamed "Contracts & Coverage"** in the navigation, the list page
  title and the add-item header. The rename reflects user feedback that the tracker had grown
  past warranties alone. Labels only: every route, action and field name is unchanged.
- Form labels changed to match the new kind matrix: "Warranty length" → "Warranty (months)",
  a subscription's "Period start" → "Start date", "Period length" → "Duration (months)", and
  the "Cancel by" label → "Cancel-by date" (detail page) / "Active through" (live badge).
  Deliberate, owner-approved wording changes. See the design spec §19.12 for the full list.
- Dashboard widget retitled "Warranties expiring soon" → **"Coming due"**.
- List page empty state retitled "No warranties yet" → "Nothing tracked yet", naming all four
  kinds.

## [1.2.1] - 2026-08-17

### Added

- **Zero-config SECRET_KEY.** A fresh install no longer needs one set at all: if `SECRET_KEY`
  is unset on first boot, the app generates a random key itself at `data/secret.key` and
  reuses it on every start after that. Setting `SECRET_KEY` yourself still works exactly as
  before and always takes precedence. This only removes the requirement, not the option.
- **Prebuilt multi-arch images on GHCR.** Tagging a release (`v*`) or running the new
  `Release image` workflow by hand builds and pushes `ghcr.io/vibelogiccode/budgettracker`
  for linux/amd64 and linux/arm64, tagged with both the version and `latest`. Paired with a
  new pull-only compose file, `install/synology-compose-pull.yml`, installing no longer
  requires a source checkout or a `docker build`. It is an Immich-style paste-and-go install
  on Synology, QNAP, Unraid, or any other Docker host.

### Changed

- `docker-compose.yml`, `install/synology-compose.yml` and `install/synology-compose-pull.yml`
  no longer require `SECRET_KEY` to be set before starting: the pull compose drops the
  placeholder line entirely, and the other two ship it commented out as an optional override.
  The install scripts (`install-linux.sh`, `install-windows.ps1`, `install-synology.sh`) are
  unchanged: they still generate a `.env` with its own `SECRET_KEY` up front, which remains
  best practice for a script-driven install and simply takes precedence over the generated
  file, same as any other explicitly-set `SECRET_KEY`.

## [1.2.0] - 2026-08-17

**Verify after updating:** restore a backup once via Settings → Backups → Restore: the app
will restart itself, be unreachable for about 30 seconds, and show the restore outcome on
Settings → Backups when it comes back. If your container runs without a restart policy
(docker-compose.yml ships restart: unless-stopped, so this is only relevant for a custom
setup), starting it back up by hand applies the restore the same way.

### Added

- **Restore from Settings.** Restoring a backup no longer requires stopping the container by
  hand: pick a backup on **Settings → Backups**, tick the confirm box and click **Restore and
  restart**. The archive is fully validated before anything is staged, then the app restarts
  itself and applies the restore on the way back up, before the database is opened. The page
  is unreachable for about 30 seconds, and refreshing it afterwards shows whether the restore
  succeeded. The previous database and (for a `.tar.gz` restore) the previous receipts folder
  are kept as timestamped safety copies and swept after 30 days, with the most recent of each
  always kept. If the container has no restart policy, nothing is lost: the request survives
  on disk and is applied the next time the app is started, by hand or otherwise. A backup made
  by a newer version of Budget Tracker than the one running is refused with an explanation.
- **A modern visual redesign**, light and dark, following your device's theme by default with
  a manual toggle in the header that remembers your choice. Every page (dashboard,
  transactions, import, review, budgets, goals, reports, warranties and every settings page)
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
  covered: months, or a Lifetime tick for the things that never expire. A new Warranties
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
  index. Searching for a store name, a model number or a line item finds the item, and
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
  counted against your retention setting, and still restore. Restoring one leaves your
  receipts folder completely untouched. A v1.1 archive cannot be restored by a v1.0.0
  install; downgrading has never been supported.
- Restoring is now driven by `npm run restore-backup`, which detects the artifact type by its
  contents rather than its file name, refuses anything it does not recognise, and moves an
  existing receipts folder aside rather than deleting it. It is still an offline procedure
  with the container stopped. There is deliberately no in-app restore button.
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
  exported text, while leaving plain numbers (the whole Amount column) as numbers.
- Transaction search treats `%` and `_` literally instead of as SQL wildcards, so
  searching for "50%" no longer matches "5000".
- Busy guards on the import undo button and the bank-profile wizard upload prevent a
  double-click from repeating the request.
- `scripts/reset-admin-password.ts` refuses a database path that does not exist instead of
  silently creating an empty database and reporting that the account is missing.

### Security

- The receipt file route is session-authenticated with an Origin check, serves the stored
  content type rather than a sniffed one, and hands PDFs over as downloads instead of
  opening them inline: a same-origin inline PDF would run the viewer's JavaScript in this
  app's origin.
- Search input is escaped into full-text-search syntax as literal phrases, so a query
  containing a quote or the word `AND` returns results instead of an error.
- Uploaded files are accepted on their leading bytes only, never on their name or the type
  the browser claims, and are stored under server-generated names that can never contain a
  path.
- Backup archives now contain photographs of receipts. They remain unencrypted, exactly like
  the database: if you copy them off the NAS, use your backup tool's client-side encryption.
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
- **Sharing packs**: export and import privacy-preserving merchant-rule and import-profile
  packs.
- **SimpleFIN connector** (optional, dormant until configured): claim-once setup token, an
  encrypted access URL, manual sync with overlap windows, and the same undo path as CSV.
- **Installers and operations**: Linux, Windows and Synology install scripts, a
  manual-only update script with automatic rollback, a Docker image that runs non-root on
  a read-only root filesystem, a container healthcheck, and a password-reset rescue tool.
