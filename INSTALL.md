# Installing Budget Tracker

Budget Tracker runs as one Docker container with one SQLite file. There is no cloud account, no
sign-up, and no network traffic at runtime. Pick your platform below; each path ends with a URL
you can open.

**The image is built locally on your own machine.** Publishing prebuilt multi-arch images to
**GHCR** (so installs become pull-only with no build wait) is an explicitly deferred enhancement
— it needs a public repository decision first.

---

## Prerequisites

| | Minimum |
|---|---|
| **Architecture** | x86_64 (amd64) or ARM64 (aarch64). 32-bit is not supported. |
| **RAM to run** | ~1 GB free. |
| **RAM to build the image** | ~2 GB free (~4 GB on a Raspberry Pi). Build on a PC and transfer if you are short. |
| **Disk** | ~2 GB for the image, plus your data (a few MB per year of transactions). |
| **Docker** | Engine 20.10.23+ **with the Compose plugin** (`docker compose version` must work). The old standalone `docker-compose` binary is not supported. |
| **Synology** | DSM 7.2+ with **Container Manager** from Package Center. |
| **Windows** | Docker Desktop 4.20+ with the **WSL2** backend. |
| **macOS** | Docker Desktop 4.20+ (Apple silicon and Intel both work). |
| **Port** | 3000 on the host, or any other port via `--port` / `-Port`. |
| **Browser** | Any current Chrome, Edge, Firefox or Safari, on any device on your network. |

You also need a **SECRET_KEY**: one random string of at least 32 bytes. Every installer generates
it for you; the Synology no-SSH path asks you to paste one in.

> **Keep the SECRET_KEY.** It is never used directly as a cipher key — encryption keys are derived
> from it. If you lose or change it, everyone who turned on two-factor authentication has to
> re-enroll their authenticator app. Transactions, budgets, goals and passwords are unaffected.

---

## Quick start — Linux

```bash
cd budget-tracker
./install/install-linux.sh
```

The script checks Docker, generates a SECRET_KEY into `.env`, creates `./data`, builds the image,
starts the container, waits until `/api/health` answers, and prints your URL. If it never becomes
healthy, the script leaves the container **running** (for you to inspect with `docker compose
logs`) and exits non-zero instead of printing a false success banner — this applies to every
installer (Linux, Synology, Windows) the same way.

Useful variations:

```bash
./install/install-linux.sh --port 8080          # serve on a different host port
./install/install-linux.sh --load bt.tar        # use a prebuilt image instead of building
./install/install-linux.sh --dry-run            # show every action without doing any of it
```

## Quick start — Raspberry Pi

The Linux script covers the Pi; ARM64 is detected automatically. The requirements are stricter:

- **64-bit Raspberry Pi OS** on a **Pi 4 or Pi 5**. The 32-bit OS will not work.
- **2 GB of RAM to run** the app.
- **~4 GB of RAM to build the image on the device** — realistic only on a Pi 5 with 8 GB. On a
  Pi 4, build on a PC and transfer the image instead:

```bash
# on your PC
docker build -t budget-tracker:latest .
docker save budget-tracker:latest -o budget-tracker.tar
scp budget-tracker.tar pi@raspberrypi.local:~/budget-tracker/

# on the Pi
cd ~/budget-tracker
./install/install-linux.sh --load budget-tracker.tar
```

Put `./data` on the SD card only if you have nothing better; an external SSD is kinder to the
card and much faster.

## Quick start — Windows

Open PowerShell in the project folder:

```powershell
.\install\install-windows.ps1
```

The script checks Docker Desktop and WSL2 (and tells you exactly what to run if either is
missing), then follows the same steps as the Linux installer.

```powershell
.\install\install-windows.ps1 -Port 8080
.\install\install-windows.ps1 -Load .\budget-tracker.tar
.\install\install-windows.ps1 -DryRun
```

## Quick start — macOS

Install Docker Desktop, then use the Linux script — it works unchanged on macOS:

```bash
cd budget-tracker
./install/install-linux.sh
```

## Quick start — Synology

Two paths, pick one:

- **No terminal:** follow [docs/INSTALL-SYNOLOGY.md](docs/INSTALL-SYNOLOGY.md). It is a
  click-by-click Container Manager walkthrough — upload the folder, create a Project, paste
  `install/synology-compose.yml`, set your SECRET_KEY, start, open the URL.
- **Over SSH:**
  ```bash
  cd /volume1/docker/budget-tracker
  sudo ./install/install-synology.sh
  ```
  Add `--load budget-tracker.tar` if the NAS runs out of memory while building — entry-level
  models usually do.

## Quick start — QNAP, Unraid, TrueNAS SCALE, generic Docker host

Anything with Docker and the Compose plugin works with the Linux script. If your NAS only offers
a compose text box (no shell), copy `install/synology-compose.yml`, change the volume path to
something valid on your system, paste in your SECRET_KEY, and start it.

---

## After the install

1. Open the URL the installer printed. You land on the **setup wizard**.
2. The account you create there is the **administrator**. Creating it also seeds the category
   list and the four built-in bank import profiles.
3. The wizard then offers an optional **"add your bank accounts"** step. Skip it if you like —
   **Settings → Bank accounts** does the same thing later — but every CSV import has to land in
   an account, so this is the one thing worth doing straight away.
4. **Settings → Users** — add the rest of the household with temporary passwords. The app forces
   each of them to pick their own password at first sign-in; until they do, the only pages they
   can reach are that screen and sign-out. An admin **Reset password** re-arms the same prompt.
5. **Import** — upload a bank CSV, check the preview, commit.
6. **Recommended:** put HTTPS in front of it (reverse proxy or Tailscale) and set `TRUST_PROXY=1`
   in `.env`. See the README's transport-security section for why this matters on shared Wi-Fi.

---

## Updating

**Updates are manual.** Nothing schedules them, nothing auto-updates, and the app never nags you
with an "update available" banner. You run this when you decide to:

```bash
./install/update.sh          # Linux, macOS, Pi, Synology-over-SSH
```
```powershell
.\install\update.ps1         # Windows
```

Each run does eight things, in order:

1. `git pull --ff-only`, if this folder is a git checkout (skipped with a note otherwise).
2. Refreshes the base image (`docker pull node:22-bookworm-slim`) so OS-level security fixes
   arrive even when the app version has not changed.
3. Runs `npm update` — **patch and minor releases only**, inside the ranges already in the
   lockfile. Major version bumps are never taken automatically; those stay a deliberate,
   reviewed change you make on purpose.
4. Tags the image you are currently running as `budget-tracker:previous`. This is the rollback
   point, captured *before* anything replaces it.
5. Rebuilds.
6. Restarts.
7. Waits for the container to report healthy via `docker inspect` (its own internal
   `/api/health` check) for up to two minutes. This is deliberately **not** a curl to a host
   URL — it works correctly no matter what host port the install used with `--port`.
8. **If it never becomes healthy, rolls back automatically** — restores
   `budget-tracker:previous`, restarts, re-checks health, prints the failing container's logs,
   and exits non-zero so you know it happened.

**`/data` is never touched by any of it, including the rollback.** Your database, backups and
`.env` come through every path unchanged.

**If a rollback happens:** the container is back on the previous image, but any `git pull` or
`npm update` this run performed are still sitting in your working tree — rebuilding from here
would just reproduce the same broken image. Before trying again, discard those changes
(`git checkout -- package.json package-lock.json`, or `git stash`) and investigate the failure
with `docker compose logs budget-tracker`. If `budget-tracker:previous` doesn't exist yet (e.g.
this was the very first build), the updater says so explicitly and leaves the failed update in
place rather than guessing — the same recovery steps apply.

Flags: `--dry-run` (print the whole plan, including the rollback branch, and change nothing),
`--skip-git`, `--no-pull` (skip the base-image refresh), `--no-deps` (skip the dependency
update). On Windows: `-DryRun`, `-SkipGit`, `-NoPull`, `-NoDeps`.

See what it would do before committing to it:

```bash
./install/update.sh --dry-run
```

`./install/install-linux.sh --update` is the simpler entry point when you only want a rebuild
and restart with no dependency or base-image changes.

Synology without SSH: re-upload the source in File Station (leave the `data` folder alone), then
Container Manager → Project → **Build**, then **Start**.

## Uninstalling

```bash
./install/install-linux.sh --uninstall               # removes container + image, KEEPS ./data
./install/install-linux.sh --uninstall --purge-data  # also deletes ./data — irreversible
```
```powershell
.\install\install-windows.ps1 -Uninstall
.\install\install-windows.ps1 -Uninstall -PurgeData
```

## Restoring from a backup

The app writes a nightly copy to `data/backups/budget-YYYY-MM-DD.db` and keeps the most recent
14. **Settings → Backups → Download backup now** makes one on demand.

```bash
docker compose down
cd data
rm -f budget.db budget.db-wal budget.db-shm
cp backups/budget-2026-08-15.db budget.db
cd ..
docker compose up -d
```

Deleting the `-wal` and `-shm` files is not optional: SQLite runs in WAL mode and would otherwise
replay the old write-ahead log on top of the database you just restored.

## Keeping backups on a separate NAS

A backup that lives on the same disk as the database is not a backup. You can send the nightly
copies to another machine — but only the copies.

**The database itself must stay on local disk.** Do not put `data/budget.db` on an NFS or SMB
mount. SQLite in WAL mode relies on shared memory (`-shm`) and on POSIX advisory locks behaving
correctly; network filesystems implement both inconsistently, and the documented result is a
corrupted database, not a slow one. This is not a performance caveat you can accept — it is a
data-loss one. The same applies to a Synology shared folder mounted from another NAS, to an
iSCSI-mounted-then-reshared volume, and to Docker volumes whose driver is NFS.

**The backups directory is safe to put on a network mount.** `Settings → Backups` writes with
SQLite's `VACUUM INTO`, which produces a complete, standalone, already-consistent `.db` file and
then closes it. Nothing keeps it open, nothing locks it, and nothing writes to it again — so the
usual network-filesystem hazards do not apply.

### Option A — mount the NAS share at `/data/backups`

Mount the remote share on the host first (`/etc/fstab`, or DSM → Control Panel → Shared Folder),
then add a second volume line so `/data` stays local while `/data/backups` does not:

```yaml
services:
  budget-tracker:
    volumes:
      - ./data:/data                              # database — LOCAL DISK, always
      - /mnt/nas/budget-backups:/data/backups     # backups — network mount is fine
```

Order matters to Docker only in that the more specific path wins; `./data:/data` still holds
`budget.db`. Two things to check after the first night:

- the mount must be writable by UID 1000 (the container runs as `node`). For SMB, mount with
  `uid=1000,gid=1000`; for NFS, make sure the export is not `root_squash`-ing you into nobody.
- if the NAS is unreachable at backup time the backup fails and is logged, and the app keeps
  running normally. That is the intended failure mode — but nothing will tell you, so check
  `Settings → Backups` occasionally.

### Option B — keep everything local and rsync it out

Safer against a flaky mount, and it keeps a local copy as well. Leave `docker-compose.yml`
alone and copy the finished files on a schedule:

```bash
# /etc/cron.d/budget-tracker-offsite  (runs after the app's own nightly backup)
30 3 * * * youruser rsync -a --delete /srv/budget-tracker/data/backups/ nas:/volume1/backups/budget-tracker/
```

`rsync` only ever reads files `VACUUM INTO` has already finished writing, so there is no window
where it can copy a half-written snapshot. On Synology, **Hyper Backup** pointed at the
`data/backups` folder does the same job with client-side encryption — worth turning on, because
the backup files themselves are unencrypted SQLite databases.

Whichever option you choose, restore is unchanged: copy the chosen `.db` back over
`data/budget.db` using the procedure above, `-wal` and `-shm` deletion included.

---

## Troubleshooting FAQ

### "Port is already in use" / the page does not load

Something else owns port 3000. Pick another:

```bash
./install/install-linux.sh --port 8080
```
```powershell
.\install\install-windows.ps1 -Port 8080
```

This writes a `docker-compose.override.yml` mapping your chosen host port to the container's
3000. To see what is holding the port: `sudo lsof -i :3000` (Linux/macOS) or
`netstat -ano | findstr :3000` (Windows).

### Permission errors on `/data` (EACCES, "readonly database", restart loop)

The container runs as uid 1000 and must be able to write the data directory:

```bash
sudo chown -R 1000:1000 ./data
docker compose restart
```

On Synology, make sure the shared folder is not marked read-only and that
`/volume1/docker/budget-tracker/data` exists before the first start.

### I forgot my password

If you forgot your password, reset it from the host with the rescue script — it runs inside the
container:

```bash
docker compose exec budget-tracker node --experimental-strip-types \
  scripts/reset-admin-password.ts alice 'a brand new password'
```

It sets the new password (minimum 10 characters), reactivates the account if it was deactivated,
signs out every one of that user's sessions, and clears the failed-login lockout so the new
password works immediately. Run it with no arguments to see the usage text and the list of known
usernames.

**It does not touch two-factor authentication.** If that account has an authenticator enrolled,
sign-in still asks for a code after the new password. Add `--clear-mfa` when you also need to
remove the enrollment (see the SECRET_KEY section below):

```bash
docker compose exec budget-tracker node --experimental-strip-types \
  scripts/reset-admin-password.ts alice 'a brand new password' --clear-mfa
```

**On a Synology with no SSH,** you do not need a terminal on the NAS at all: **Container Manager
→ Container → `budget-tracker` → Details → Terminal → Create**, which opens a shell *inside* the
running container. Run the command there without the `docker compose exec budget-tracker` prefix:

```bash
node --experimental-strip-types scripts/reset-admin-password.ts alice 'a brand new password'
```

If another admin is still able to sign in, the easier route is **Settings → Users → Reset
password**.

### I forgot / lost my SECRET_KEY

If you forgot your SECRET_KEY: only two-factor authentication depends on it. Everything else —
transactions, budgets, goals, passwords — is unaffected.

Each user's TOTP secret is encrypted with a key derived from `SECRET_KEY`. Once the key is gone,
those secrets can never be decrypted again, so **no authenticator app can ever produce a code the
app will accept** for those accounts. A new password alone does not help — the sign-in still asks
for the second factor.

1. Generate a new one: `openssl rand -base64 48`
2. Put it in `.env` (or the Synology project's environment) and restart.
3. **Recovery codes still work.** They are stored as plain SHA-256 hashes and are *not* derived
   from `SECRET_KEY`, so they survive its loss. If anyone still has an unused recovery code from
   their enrollment, they can sign in with it right now — that is the quickest way back in.
4. Once *any* admin is signed in, clear each stale enrollment from the UI with **Settings → Users
   → Reset MFA**, and each user re-enrolls from **Settings → Profile**.
5. **If every admin is locked out and nobody has a recovery code,** use the rescue script with
   `--clear-mfa`. This is the only path that clears two-factor from outside the app:

   ```bash
   docker compose exec budget-tracker node --experimental-strip-types \
     scripts/reset-admin-password.ts alice 'a brand new password' --clear-mfa
   ```

   It sets the new password, turns `totp_enabled` off, deletes the undecryptable TOTP secret, and
   deletes that user's recovery codes — for **that one user only**. It prints exactly what it
   cleared. Everyone else's enrollment is untouched, so clear those from **Settings → Users →
   Reset MFA** after signing in. Without `--clear-mfa` the script only resets the password and
   says so: two-factor stays on and the account stays unreachable.

### "Cross-origin request rejected" on every form

The app compares the browser's `Origin` header against the request's `Host` on every change it
makes. A reverse proxy that rewrites `Host` to the container's own name (`localhost:3000`,
`budget-tracker:3000`) breaks that comparison, so every save, sign-in and settings change is
refused even though the page itself loads fine.

Fix it on both sides:

1. In `.env` (or the Synology project's environment), set `TRUST_PROXY=1` and restart. The app
   then honours `X-Forwarded-Host`.
2. Make the proxy actually send the browser's hostname. nginx:
   `proxy_set_header X-Forwarded-Host $host;` (plus `X-Forwarded-Proto $scheme;`). Caddy and
   Synology's built-in reverse proxy send it already. Traefik needs
   `passHostHeader = true` or the same header rule.

Only turn `TRUST_PROXY` on behind a proxy you control — with nothing in front of the container,
any client could forge that header.

### Two-factor codes are rejected even though they look right

The container's clock has drifted from your phone's. TOTP tolerates ±1 thirty-second step. Check
`docker compose exec budget-tracker date` against your phone, and fix the host clock (NTP) if
they disagree by more than half a minute.

### The container keeps restarting

```bash
docker compose logs --tail 50 budget-tracker
```

The two usual causes are a missing or too-short `SECRET_KEY` (the app refuses to start without at
least 32 bytes) and an unwritable `/data`.

### "Could not locate the bindings file" or "invalid ELF header"

The image was built for a different CPU architecture than the one running it. Rebuild on the
target, or build multi-arch:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t budget-tracker:latest --load .
```

### The healthcheck is red but the site works

The healthcheck runs inside the container against `127.0.0.1:3000`. If you changed the
container's `PORT`, update the healthcheck to match. Changing only the *host* port with
`--port` does not affect it.

### Can I keep the data on my other NAS / an NFS or SMB share?

The **backups** yes, the **database** no. `data/budget.db` must stay on local disk — SQLite's
WAL mode depends on shared memory and POSIX locking that network filesystems get wrong, and the
failure mode is a corrupted database rather than a slow one. `data/backups` is fine on a network
mount, because `VACUUM INTO` writes each snapshot as a complete standalone file and then closes
it. See [Keeping backups on a separate NAS](#keeping-backups-on-a-separate-nas) for a compose
snippet and an rsync alternative.

### The build runs out of memory

Build on a machine with more RAM and transfer the image:

```bash
docker build -t budget-tracker:latest .
docker save budget-tracker:latest -o budget-tracker.tar
# copy the tar over, then on the target:
./install/install-linux.sh --load budget-tracker.tar
```

---

## Manual QA checklist (per platform, after a real install)

The installers are exercised automatically in `--dry-run` mode by the test suite. A full
end-to-end install is verified by hand. Walk this list on each platform you support:

- [ ] Fresh install on an empty folder finishes and prints a URL.
- [ ] That URL loads and redirects to `/setup`.
- [ ] Creating the first account lands on the dashboard; `/setup` afterwards redirects to `/login`.
- [ ] `docker compose ps` shows the container as `healthy` within a minute.
- [ ] Importing a bank CSV works end to end and the transactions appear.
- [ ] Restarting the host brings the container back automatically (`restart: unless-stopped`).
- [ ] Running the installer a **second** time changes nothing and does not regenerate `.env`.
- [ ] `--port 8080` serves on 8080 and the old port is free.
- [ ] `--update` preserves all data.
- [ ] `--uninstall` leaves `./data` in place; `--purge-data` removes it.
- [ ] The rescue script resets a password and the user can sign in immediately.
- [ ] A nightly backup file appears under `data/backups/` after 02:00 local time.
