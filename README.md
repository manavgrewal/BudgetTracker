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
**Settings → Users**, hands out a temporary password, and each person changes it (and optionally
turns on two-factor authentication) at their first sign-in.

---

## 3. Use it

1. **Settings → Users** — add the rest of the household.
2. **Import** — pick or create an account, upload a CSV, check the preview, adjust the column
   mapping if the bank's layout differs, then commit. Editing a built-in profile automatically
   saves a private copy for that account; the shared preset is never modified.
3. **Review** — accept or fix the app's guesses. Every confirmation teaches it: it creates a rule
   for that merchant and updates the classifier.
4. **Budgets** — set monthly limits per category, at household level and per person. A limit you
   set in March applies to March and every month after it until you change it again.
5. **Goals** — log money you set aside and watch the pace projection.
6. **Reports** — category breakdowns, month-over-month trends, who-spent-what, CSV export.

Re-importing an overlapping date range is safe: duplicate rows are detected and skipped, and
undoing an import only deletes the transactions that no other import also covers.

---

## 4. Backups and restore

A job runs every night at **02:00 local time**. It writes `/data/backups/budget-YYYY-MM-DD.db`
(a consistent `VACUUM INTO` copy, not a file copy), keeps the most recent 14 (configurable under
**Settings → Backups**), then purges expired sessions and login attempts older than 30 days.

**Settings → Backups → Download backup now** produces a fresh copy and streams it to your
browser.

Backups are **unencrypted** SQLite files. That is a deliberate choice for a LAN-only app. For
offsite copies, point Hyper Backup (or your NAS equivalent) at the `/data` share and turn on its
client-side encryption there.

### Restore

```bash
docker compose down
cd data
rm -f budget.db budget.db-wal budget.db-shm
cp backups/budget-2026-08-15.db budget.db
cd ..
docker compose up -d
```

Deleting the `-wal` and `-shm` files matters: SQLite in WAL mode will otherwise replay the old
write-ahead log on top of your restored database.

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
| `DATA_DIR` | `/data` | Where `budget.db`, `backups/` and `tmp/` live. |

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
