# Installing on a Synology NAS — Container Manager walkthrough

This is the **no SSH** path. Everything happens in DSM's web interface. If you are
comfortable with a terminal, `install/install-synology.sh` does the same thing in one command.

You will need about 20 minutes, most of it waiting for the image to build.

**Before you start**

- DSM 7.2 or newer with **Container Manager** installed (Package Center → search "Container
  Manager" → Install). Container Manager 20.10.23+ provides the `docker compose` support this
  project needs.
- About 2 GB of free RAM while the image builds. On DS220j-class hardware the build may run out
  of memory — if it does, skip to "Option B" in step 5.
- The project folder (this repository) on your computer, ready to upload.

---

## Option A: prebuilt image (fastest)

Skip the build entirely. GHCR hosts a ready-to-run multi-arch image, so Container Manager only
has to pull and start it — no 5–20 minute build wait, and no need to upload the source at all.
It is also zero-config: the app generates its own SECRET_KEY on first boot, so there is nothing
to fill in before starting.

- Create the `data` folder and give it Read/Write permission first — that's steps 1–2 below,
  and it matters just as much here: skip it and the container crash-loops until you fix it.
- Use [`install/synology-compose-pull.yml`](../install/synology-compose-pull.yml) instead of
  `install/synology-compose.yml` when you get to **Create the Project** (step 5): paste its
  contents there as-is.
- Skip step 3 (uploading the source) entirely — the pull compose has no `build:` line, so
  Container Manager never needs the project files.
- Skip step 4 (generating a SECRET_KEY) too — it's optional. Want to manage the key yourself
  anyway? Uncomment the `SECRET_KEY:` line in the pasted compose file and set it to a random
  string of at least 32 bytes before starting the project.

Prefer to build from source instead (for example, to audit the code yourself first)? Continue
with the walkthrough below.

## Option B: build from source

1. **Create the folder.** Open **File Station**. If there is no `docker` shared folder, create
   one (Control Panel → Shared Folder → Create → name it `docker`). Inside `docker`, create a
   folder called `budget-tracker`, and inside that one, a folder called `data`.
   You should end up with `/volumeN/docker/budget-tracker/data` — use whichever volume you use
   (e.g. `/volume1` or `/volume2`); the rest of this guide assumes that same volume throughout.

2. **Let the container write to `data`.** The app runs as **uid 1000** inside the container, and
   it stores the whole database in that folder — if it cannot write there, the container starts
   and then dies in a restart loop. In **File Station**, right-click the `data` folder →
   **Properties** → **Permission** tab → **Create**, and add a permission entry granting
   **Read/Write** (owner `docker` group, or `Everyone` on a home NAS if you would rather not
   create a user). Tick **Apply to this folder, sub-folders and files**, then **Save**.

   Do this *before* the first start. Fixing it afterwards works too — same steps, then restart
   the project — but the container will have been crash-looping in the meantime.

3. **Upload the source.** Still in File Station, open `docker/budget-tracker` and use
   **Upload → Upload - Skip** to copy the whole project folder's contents into it (the
   `Dockerfile`, `package.json`, `src`, `drizzle`, `public`, `install`, and the rest). When you
   are done, `docker/budget-tracker/Dockerfile` must exist.

4. **(Optional) Use your own SECRET_KEY.** Nothing to do here by default — the app generates its
   own key at `data/secret.key` the first time it starts and reuses it after that. Only if you
   want to manage the key yourself (e.g. to reuse the same one across a rebuild), open
   `install/synology-compose.yml` from the project folder in a text editor and uncomment:
   ```
   # SECRET_KEY: "set-your-own-if-you-prefer"
   ```
   replacing the value with any random string of at least 32 bytes:
   - On your computer, in a terminal: `openssl rand -base64 48`
   - On Windows PowerShell:
     `[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))`
   - Or use a password manager's "generate password" set to 60+ characters.

   **Keep whichever key ends up in use somewhere safe** — if it is lost or changed, everyone who
   turned on two-factor authentication has to re-enroll. Nothing else is affected. Copy the whole
   compose file to your clipboard either way.

5. **Create the Project.** Open **Container Manager → Project → Create**.
   - **Project name:** `budget-tracker`
   - **Path:** browse to `/volumeN/docker/budget-tracker` (the volume you used in step 1)
   - **Source:** choose **Create docker-compose.yml**, then paste the text from step 4 into the
     editor.
   - Click **Next**. Skip the web portal settings. Click **Done**.

   Container Manager now builds the image. **This takes 5–20 minutes** and the progress log
   scrolls by in the window — that is normal.

   **Option B — if the build fails with an out-of-memory error:** build the image on your PC
   instead (`docker build -t budget-tracker:latest .` then
   `docker save budget-tracker:latest -o budget-tracker.tar`), upload `budget-tracker.tar` via
   File Station, import it with **Container Manager → Image → Add → Add from file**, then edit
   the project's compose file to comment out the `build: .` line so it uses the loaded image.

6. **Check it started.** In **Container Manager → Container**, the `budget-tracker` container
   should be **Running** and its health should turn green within about 30 seconds.

   **If it is restarting in a loop,** click it → **Log**. There are two causes, and they look
   different:

   - **The `data` folder is not writable** (step 2). The log says `EACCES`, `SQLITE_CANTOPEN` or
     `attempt to write a readonly database`. Try redoing step 2's Read/Write permission and
     restarting the project — that's the no-SSH attempt. Synology's inherited ACLs sometimes
     override that File Station permission and the container still can't write, in which case
     you need the SSH remedy: connect over SSH (Control Panel → Terminal & SNMP → enable SSH
     first if needed) and run
     ```
     sudo synoacltool -del /volumeN/docker/budget-tracker/data && sudo chmod 770 /volumeN/docker/budget-tracker/data
     ```
     (substitute your volume from step 1), then restart the project. This also blocks the
     app from writing its auto-generated `data/secret.key`, so the symptoms look the same.
   - **You set your own SECRET_KEY and it is too short** (step 4). The log says the app refuses
     to start without at least 32 bytes. Edit the project's compose file and restart, or just
     comment the line back out and let the app generate one instead.

   You can tell them apart without reading logs: open `http://<your-nas-ip>:3000/api/health` in a
   browser. It answers with `"db"` and `"dataDir"` fields — `{"dataDir":"error"}` is the
   permission problem, and a page that never answers at all (container down) with a healthy
   folder is the SECRET_KEY one.

7. **Open the app.** In a browser on the same network, go to:
   ```
   http://<your-nas-ip>:3000
   ```
   (Find the IP in Control Panel → Network → Network Interface.)

8. **Create the first account.** The setup wizard appears automatically. The account you create
   here is the administrator. It also seeds the category list and the four built-in bank import
   profiles, then offers an optional step to add your bank accounts (you can skip it and do it
   later under **Settings → Bank accounts**).

9. **Add the household.** Settings → Users → add each family member with a temporary password.
   They change it at first sign-in.

10. **Turn on HTTPS (recommended).** Control Panel → Login Portal → Advanced → **Reverse Proxy**
    → Create. Source: your chosen hostname on port 443 (HTTPS). Destination: `localhost` port
    `3000`. Then edit the project's compose file and set `TRUST_PROXY: "1"`, and restart the
    project.

    Why this matters: on ordinary WPA2 Wi-Fi, anyone who knows the Wi-Fi password can read other
    devices' plain-HTTP traffic — including your login and session cookie. Plain HTTP is fine on
    a network where you trust every device; it is not fine if guests use your Wi-Fi.

---

## Backups

The app writes a nightly copy to `/volumeN/docker/budget-tracker/data/backups/` (the volume you
used in step 1). Put that folder
under **Hyper Backup** (and enable its client-side encryption) for offsite copies. There is also
**Settings → Backups → Download backup now** in the app itself.

## Updating

1. File Station → upload the new source over `docker/budget-tracker` (do **not** touch the
   `data` folder).
2. Container Manager → Project → `budget-tracker` → **Build** → then **Start**.

Your database, backups and settings are all inside `data`, which the update never touches.

## Uninstalling

Container Manager → Project → `budget-tracker` → **Stop** → **Delete**. Then delete the image
under **Image**. The `data` folder survives; delete it in File Station only if you really want
the data gone.
