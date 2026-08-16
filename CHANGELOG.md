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

### Added

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
