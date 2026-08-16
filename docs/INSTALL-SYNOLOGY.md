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

1. **Create the folder.** Open **File Station**. If there is no `docker` shared folder, create
   one (Control Panel → Shared Folder → Create → name it `docker`). Inside `docker`, create a
   folder called `budget-tracker`, and inside that one, a folder called `data`.
   You should end up with `/volume1/docker/budget-tracker/data`.

2. **Upload the source.** Still in File Station, open `docker/budget-tracker` and use
   **Upload → Upload - Skip** to copy the whole project folder's contents into it (the
   `Dockerfile`, `package.json`, `src`, `drizzle`, `public`, `install`, and the rest). When you
   are done, `docker/budget-tracker/Dockerfile` must exist.

3. **Generate a SECRET_KEY.** This is the one secret the app needs. Any random string of at
   least 32 bytes works. Pick whichever is easiest:
   - On your computer, in a terminal: `openssl rand -base64 48`
   - On Windows PowerShell:
     `[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))`
   - Or use a password manager's "generate password" set to 60+ characters.

   Copy the result. **Keep it somewhere safe** — if you lose it, everyone who turned on
   two-factor authentication has to re-enroll. Nothing else is affected.

4. **Prepare the compose file.** Open `install/synology-compose.yml` from the project folder in
   any text editor. Find the line:
   ```
   SECRET_KEY: "PASTE-YOUR-GENERATED-KEY-HERE"
   ```
   Replace `PASTE-YOUR-GENERATED-KEY-HERE` with the key from step 3, keeping the quotes. Leave
   everything else alone. Copy the whole file to your clipboard.

5. **Create the Project.** Open **Container Manager → Project → Create**.
   - **Project name:** `budget-tracker`
   - **Path:** browse to `/volume1/docker/budget-tracker`
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
   should be **Running** and its health should turn green within about 30 seconds. If it is
   restarting in a loop, click it → **Log**; the usual cause is a missing or malformed
   SECRET_KEY.

7. **Open the app.** In a browser on the same network, go to:
   ```
   http://<your-nas-ip>:3000
   ```
   (Find the IP in Control Panel → Network → Network Interface.)

8. **Create the first account.** The setup wizard appears automatically. The account you create
   here is the administrator. It also seeds the category list and the four built-in bank import
   profiles.

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

The app writes a nightly copy to `/volume1/docker/budget-tracker/data/backups/`. Put that folder
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
