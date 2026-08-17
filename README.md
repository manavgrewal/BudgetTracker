# Budget Tracker

A self-hosted household budget tracker that replaces Mint. Family members import bank CSV
exports (TD debit and Visa, Scotiabank, Amex Canada, or any other lender through a one-time
column-mapping wizard), the app categorizes spending and learns from corrections, and it tracks
monthly budgets per category and savings goals.

It runs as a single Docker container on a Synology NAS (or any Docker host), stays on your LAN,
stores everything in one SQLite file, and makes **no network calls at runtime**. No telemetry, no
cloud account, no bank API.

> **Installing?** Go to **[INSTALL.md](INSTALL.md)** — prerequisites, one command per platform
> (Linux, Windows, macOS, Raspberry Pi), a no-SSH Synology walkthrough, and update, uninstall,
> restore and troubleshooting instructions. The rest of this README is the reference material
> behind it.

- **CSV import from Canadian banks** — column-mapping wizard with built-in profiles, validated
  against real TD and Amex exports; any other bank works through the same wizard.
- **Learning categorizer** — accept or correct a guess and it remembers the merchant next time.
- **Household and per-person budgets** — set a monthly limit per category at the household level
  or for one person; it carries forward until you change it.
- **Savings goals** — log money set aside and see a pace projection.
- **Warranties** — record what you bought and how long it is covered, attach the receipt as a
  photo or a PDF, and search every word printed on it. Receipts are read by an OCR engine
  that runs entirely on the server: the language data ships inside the image, so this works
  on a LAN-only install with no internet connection at all.
- **SimpleFIN (optional)** — link accounts for automatic balance/transaction sync if you want it;
  CSV import always works without it.
- **Sharing packs** — export a redacted slice of your data to share with someone (an accountant,
  a co-owner) without handing over the whole database.
- **Multi-user with TOTP two-factor auth** — one admin-managed household, per-user passwords and
  optional authenticator-app 2FA.

---

## Quickstart

See **[INSTALL.md](./INSTALL.md)** for the full step-by-step setup (generating `SECRET_KEY`,
building or transferring the image, first run, and reverse-proxy/Tailscale options). The sections
below cover the same ground in more detail plus day-to-day operations.

---

## 1. Generate a SECRET_KEY

You need one random secret before the first start.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Put it in a `.env` file next to `docker-compose.yml`:

```
SECRET_KEY=paste-the-generated-value-here
TZ=America/Toronto
TRUST_PROXY=0
```

**Keep this value.** It is never used directly as a cipher key — encryption keys are derived from
it with HKDF-SHA256. If you lose or rotate it, every stored TOTP secret becomes undecryptable and
each user with two-factor authentication has to **re-enroll** their authenticator app. Nothing
else is affected: transactions, budgets, goals and passwords are untouched.

---

## 2. Install

**Fastest path: no build at all.** Pull a prebuilt multi-arch image from GHCR with
[`install/synology-compose-pull.yml`](install/synology-compose-pull.yml) — see
[INSTALL.md's quick start](INSTALL.md#quick-start--prebuilt-image-any-docker-host-no-build) for
the four steps. Everything below is the build-from-source alternative.

### Primary path: build on a PC, transfer the image

`next build` can exceed the RAM of entry-level NAS models, so build where you have memory to
spare and ship the finished image.

On your PC, from the project folder:

```bash
docker build -t budget-tracker:latest .
docker save budget-tracker:latest -o budget-tracker.tar
```

Copy `budget-tracker.tar`, `docker-compose.yml` and your `.env` to the NAS, then on the NAS:

```bash
docker load -i budget-tracker.tar
mkdir -p data
docker compose up -d
```

On Synology you can do the same through **Container Manager → Image → Add → Add from file**,
then create the container from `docker-compose.yml` under **Project**.

For a multi-architecture build (for example building on an x86 PC for an ARM64 NAS):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t budget-tracker:latest --load .
```

### Fallback: Building on the NAS

If the NAS has enough RAM (roughly 2 GB free), you can build in place:

```bash
docker compose build
docker compose up -d
```

Expect this to take a while, and expect it to fail on low-memory models — that is why the
build-elsewhere path above is the default.

### First run

Open `http://<nas-address>:3000`. The setup wizard creates the first account as the
administrator and seeds the category list plus the four built-in bank import profiles.
Registration is closed after that: the admin creates the other family members under
**Settings → Users** and hands out a temporary password. Because the admin knows that password,
the app **requires the new person to replace it** — their first sign-in lands on a
"choose your own password" screen, and nothing else in the app opens until they do. Changing it
signs them out of any other browser and leaves them signed in where they are. The same applies
after an admin uses **Reset password**. Two-factor authentication stays optional, from
**Settings → Profile**.

---

## 3. Use it

1. **Settings → Users** — add the rest of the household.
2. **Settings → Bank accounts** — add one account per bank account you import from (name,
   institution, type, and whether it is joint or belongs to one person). The first-run wizard
   offers this too. Accounts are deactivated, never deleted.
3. **Import** — pick an account, upload a CSV, check the preview, adjust the column
   mapping if the bank's layout differs, then commit. Editing a built-in profile automatically
   saves a private copy for that account; the shared preset is never modified.
4. **Review** — accept or fix the app's guesses. Every confirmation teaches it: it creates a rule
   for that merchant and updates the classifier.
5. **Budgets** — set monthly limits per category, at household level and per person. A limit you
   set in March applies to March and every month after it until you change it again.
6. **Goals** — log money you set aside and watch the pace projection.
7. **Reports** — category breakdowns, month-over-month trends, who-spent-what, CSV export.

Re-importing an overlapping date range is safe: duplicate rows are detected and skipped, and
undoing an import only deletes the transactions that no other import also covers.

---

## 4. Backups and restore

A job runs every night at **02:00 local time**. It writes `/data/backups/budget-YYYY-MM-DD.tar.gz`
— a `.tar.gz` archive containing a consistent `VACUUM INTO` copy of the database plus every receipt
file, not a live-file copy — keeps the most recent 14 (configurable under **Settings → Backups**),
then purges expired sessions and login attempts older than 30 days. Backups made before the
receipts feature shipped are a bare `budget-YYYY-MM-DD.db` file; both shapes are still listed,
still counted toward retention, and both still restore.

**Settings → Backups → Download backup now** produces a fresh archive and streams it to your
browser.

Backups are **unencrypted**. That is a deliberate choice for a LAN-only app. Since receipts joined
the archive, offsite copies can now carry receipt photographs too — these can show names,
addresses and partial card numbers, not just transaction data — so for offsite copies, point Hyper
Backup (or your NAS equivalent) at the `/data` share and turn on its client-side encryption there.

### Restore

**Settings → Backups → Restore** is the normal way to restore a backup. Pick a row, tick the
confirm box, and click **Restore and restart**: the app validates the archive completely before
staging anything, then restarts itself and applies the restore on the way back up, before the
database is opened — restoring under a live SQLite connection is how you corrupt one, which is
why the app restarts instead of restoring in place. The page will be unreachable for about 30
seconds; refresh it after that to see the outcome. The previous database is kept as
`data/budget.pre-restore-<timestamp>.db` and, for a `.tar.gz` restore, the previous receipts as
`data/receipts.pre-restore-<timestamp>/` — both are swept after 30 days, but the most recent of
each is always kept.

If the container has no restart policy, nothing is lost: the request survives on disk and is
applied automatically the next time the app is started, by hand or otherwise —
`docker-compose.yml` ships `restart: unless-stopped`, so this only matters for a custom setup.

A backup made by a *newer* version of Budget Tracker than the one currently running is refused,
with an explanation; upgrade first, then restore. Restoring an older backup works normally —
migrations run forward automatically on the boot that applies it. Deleting `-wal`/`-shm` files
before writing the restored database is handled for you and is not optional: SQLite in WAL mode
would otherwise replay the old write-ahead log on top of your restored database.

Restoring a v1.0.0 `.db` backup works the same way and only ever replaces `budget.db` — it never
touches `data/receipts/`, since a database-only backup says nothing about which receipt files
should exist; any warranty whose receipt is missing after a cross-version restore simply shows a
missing-file state in the UI.

#### If the app will not start

Use the bundled `restore-backup` script rather than copying files by hand: it detects which kind
of backup you gave it by looking at the file's contents, not its name, refuses anything it
doesn't recognise, and — for a `.tar.gz` archive — renames any existing `data/receipts/` aside
instead of deleting it, so a mistaken restore is recoverable.

```bash
docker compose down
docker compose run --rm --entrypoint node budget-tracker \
  --experimental-strip-types scripts/restore-backup.ts /data/backups/budget-2026-08-16.tar.gz
docker compose up -d
```

### Synology guidance

Put the `data` folder on a share covered by Hyper Backup or Snapshot Replication so the whole
`/data` directory (live database plus the nightly copies) goes offsite.

---

## 5. Transport security

**Recommended: put HTTPS in front of it.** Either

- a Synology reverse proxy (Control Panel → Login Portal → Advanced → Reverse Proxy) with a
  self-signed or Let's Encrypt certificate, or
- Tailscale, which gives every device an encrypted link and a stable name without exposing
  anything to the internet.

When you terminate TLS at a reverse proxy, set `TRUST_PROXY=1` so the app trusts
`X-Forwarded-Proto` (which switches the session cookie to `Secure`) and `X-Forwarded-For`
(which gives the rate limiter the real client IP). Leave `TRUST_PROXY=0` when nothing is in
front of the container — otherwise a client could forge those headers.

**The honest caveat about plain HTTP.** On a shared-key Wi-Fi network (ordinary WPA2 with one
Wi-Fi password), anybody who knows the password can decrypt other devices' traffic. Over plain
HTTP that exposes your login credentials and session cookie to any guest on the network. Plain
HTTP is a reasonable, documented opt-out for a network where you trust every device — it is not
a reasonable default if guests use your Wi-Fi.

This app is not designed for exposure to the public internet. Do not port-forward it.

---

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SECRET_KEY` | *(required)* | Random string, at least 32 bytes. Encryption keys are derived from it. |
| `TRUST_PROXY` | `0` | When `1`, trust `X-Forwarded-Proto` and `X-Forwarded-For`. Only behind a proxy you control. |
| `TZ` | `America/Toronto` | Timezone for date handling and the nightly job. |
| `PORT` | `3000` | Listening port inside the container. |
| `DATA_DIR` | `/data` | Where `budget.db`, `backups/`, `tmp/` and `receipts/` live. |

`data/receipts/` holds the receipt files. They are part of the nightly backup archive, and an
image update never touches them.

---

## 7. Troubleshooting

**The container restarts in a loop.** Check `docker compose logs budget-tracker`. The usual cause
is a missing `SECRET_KEY` (the app refuses to start without one) or a `/data` directory the
`node` user cannot write to. Fix ownership with `sudo chown -R 1000:1000 data`.

**`Error: Could not locate the bindings file` or `invalid ELF header`.** The native modules were
built for a different architecture. Rebuild the image on (or for) the target platform — see the
`buildx` command above.

**The healthcheck fails but the site loads.** The healthcheck runs inside the container against
`127.0.0.1`. If you changed `PORT`, make sure the compose healthcheck uses the same value.

**An import shows every row as a duplicate.** That is the expected result of re-uploading a file
you already imported. The counts in the summary tell you what happened; nothing was inserted
twice.

**The dates in an import look wrong (March 4 vs April 3).** The profile's date format does not
match the bank's. Change it in the preview's mapping editor and re-preview. Duplicate detection
is unaffected — it hashes the raw date string from the file, not the parsed date.

**Accented merchant names look like `MÃ‰TRO`.** The file is windows-1252 but was decoded as
UTF-8, or the reverse. Set the profile's encoding explicitly in the preview mapping editor
instead of leaving it on automatic.

**Every form fails with "Cross-origin request rejected".** The CSRF check compares `Origin`
against `Host`, and a reverse proxy that rewrites `Host` to the container's own name breaks the
comparison. Set `TRUST_PROXY=1` (so the app honours `X-Forwarded-Host`) and make the proxy send
the browser's hostname — nginx: `proxy_set_header X-Forwarded-Host $host;`. Only do this behind a
proxy you control.

**A user is locked out.** Failed sign-ins lock an account for 15 minutes, doubling on repeat
bursts. Either wait it out, or have an admin reset that user's password under
**Settings → Users**, which clears the lockout.

**Someone lost their phone and their recovery codes.** An admin can clear their two-factor
enrollment with **Reset MFA** under **Settings → Users**.

---

## 8. Development

```bash
npm install
npm test              # vitest
npm run typecheck
npm run dev           # needs SECRET_KEY and DATA_DIR in the environment
npm run build
```

Source layout: `src/app` (routes and pages), `src/lib` (all domain logic — this is where the
tests live), `src/db` (schema, client, seed), `src/components` (shared UI), `drizzle/`
(hand-written migrations, applied on boot), `fixtures/` (sample CSVs for the parser tests),
`docs/` (the design spec and this implementation plan).

---

## License

MIT — see [LICENSE](./LICENSE).
