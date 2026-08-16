#!/usr/bin/env bash
# Budget Tracker — Synology DSM installer for people comfortable with SSH.
# The no-SSH path is docs/INSTALL-SYNOLOGY.md (Container Manager walkthrough).
set -euo pipefail

SERVICE="budget-tracker"
IMAGE="budget-tracker:latest"
PORT=3000
MODE="install"
PURGE_DATA=0
DRY_RUN=0
LOAD_TAR=""
SYNO_ROOT="/volume1/docker/budget-tracker"

# Resolved the same way as install-linux.sh: compose commands must run against
# THIS script's own project directory, never whatever the caller's CWD happens
# to be — otherwise "--uninstall" from an unrelated directory that also has a
# docker-compose.yml would tear down that unrelated stack instead.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Budget Tracker installer (Synology DSM, over SSH)

Usage: sudo install/install-synology.sh [options]

Options:
  --update            Rebuild and restart. Data is preserved.
  --uninstall         Stop and remove the container and image. Data is kept.
  --purge-data        With --uninstall, also delete the data directory.
  --load <image.tar>  docker load a PC-built image instead of building on the NAS.
                      Recommended: "next build" can exceed the RAM of entry-level models.
  --port <n>          Host port (default 3000).
  --root <path>       Install root (default /volume1/docker/budget-tracker).
                      Must end in a "budget-tracker" directory; "/" and other
                      unscoped roots are refused because --purge-data does
                      "rm -rf <root>/data".
  --dry-run           Print every action without doing any of them.
  --help              Show this message.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --update) MODE="update"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --purge-data) PURGE_DATA=1; shift ;;
    --load) LOAD_TAR="${2:-}"; if [ -z "$LOAD_TAR" ]; then echo "--load needs a path" >&2; exit 2; fi; shift 2 ;;
    --port) PORT="${2:-}"; if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$'; then echo "--port needs a number" >&2; exit 2; fi; shift 2 ;;
    --root) SYNO_ROOT="${2:-}"; if [ -z "$SYNO_ROOT" ]; then echo "--root needs a path" >&2; exit 2; fi; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would run: $*"
  else
    "$@"
  fi
}

# --root is fed straight into "rm -rf <root>/data" under --purge-data, so a
# careless value is catastrophic: --root / would rm -rf //data == /data at the
# real filesystem root. Refuse anything that isn't a specific, scoped
# "...budget-tracker" directory — always, dry-run or not, since this is input
# validation rather than a side effect.
validate_root() {
  case "$SYNO_ROOT" in
    ""|/)
      die "--root must not be empty or '/' — refusing to operate at the filesystem root." ;;
  esac
  local base
  base="$(basename "$SYNO_ROOT")"
  if [ "$base" != "budget-tracker" ]; then
    die "--root must end in a 'budget-tracker' directory (got: ${SYNO_ROOT}). This keeps --purge-data's rm -rf scoped to an install-specific folder, never a shared parent."
  fi
}

validate_root

if [ ! -f "${PROJECT_DIR}/docker-compose.yml" ]; then
  warn "docker-compose.yml was not found in ${PROJECT_DIR}. Run this script from inside the project folder."
  [ "$DRY_RUN" -eq 1 ] || die "Fix the problem above and run this script again."
fi

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
    return 0
  fi
  if [ -r /dev/urandom ] && command -v base64 >/dev/null 2>&1; then
    head -c 48 /dev/urandom | base64 | tr -d '\n'
    return 0
  fi
  die "Could not generate a SECRET_KEY: neither openssl nor /dev/urandom is available."
}

wait_for_health() {
  step "Waiting for /api/health"
  local url="http://127.0.0.1:${PORT}/api/health"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would poll ${url}"
    return 0
  fi
  local waited=0
  while [ "$waited" -lt 120 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      say "Healthy after ${waited}s."
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  warn "Not healthy after 120s."
  return 1
}

print_failure() {
  cat <<EOF

============================================================
 Budget Tracker did NOT report healthy within the timeout.

 The container is left RUNNING on purpose, so you can investigate:
   docker compose logs --tail 100 ${SERVICE}
   docker compose ps
   curl -v http://127.0.0.1:${PORT}/api/health

 Common causes: a missing or too-short SECRET_KEY, an unwritable data
 directory, or an image built for the wrong CPU architecture.
============================================================
EOF
}

# cd into the project directory before doing anything with docker compose, so
# every compose command below runs against THIS project's compose file.
cd "$PROJECT_DIR"

step "Synology install root: ${SYNO_ROOT}"
say "Data will live at ${SYNO_ROOT}/data — put that share under Hyper Backup for offsite copies."

step "Checking prerequisites"
if command -v docker >/dev/null 2>&1; then
  say "docker: $(docker --version 2>/dev/null || echo present)"
else
  warn "Docker was not found. Install Container Manager from Package Center first,"
  warn "then reconnect over SSH so /usr/local/bin is on your PATH."
  [ "$DRY_RUN" -eq 1 ] || die "Container Manager is required."
fi
if docker compose version >/dev/null 2>&1; then
  say "compose plugin: $(docker compose version --short 2>/dev/null || echo present)"
else
  warn "'docker compose' is unavailable. Container Manager 20.10.23 or newer provides it."
  [ "$DRY_RUN" -eq 1 ] || die "The compose plugin is required."
fi

if [ "$MODE" = "uninstall" ]; then
  step "Removing the container"
  say "Running: docker compose down"
  run docker compose down
  run docker image rm "$IMAGE" || warn "Image ${IMAGE} was not present."
  if [ "$PURGE_DATA" -eq 1 ]; then
    step "Deleting ${SYNO_ROOT}/data as requested by --purge-data"
    if [ "$DRY_RUN" -eq 1 ]; then
      run rm -rf "${SYNO_ROOT}/data"
      say "(dry run — no data was actually deleted)"
    elif [ ! -d "${SYNO_ROOT}/data" ]; then
      say "There was no ${SYNO_ROOT}/data directory to delete."
    else
      rm -rf "${SYNO_ROOT}/data"
      if [ -d "${SYNO_ROOT}/data" ]; then
        warn "Could not fully delete ${SYNO_ROOT}/data (check permissions). Remove it manually."
      else
        say "Data deleted."
      fi
    fi
  else
    say "Your data was kept at ${SYNO_ROOT}/data."
  fi
  exit 0
fi

step "Preparing directories"
run mkdir -p "${SYNO_ROOT}/data"
say "Setting ownership to uid 1000 (the container's non-root user)"
run chown -R 1000:1000 "${SYNO_ROOT}/data" || warn "chown failed; rerun this script with sudo if the app reports EACCES."

step "Configuring"
if [ -f "${SYNO_ROOT}/.env" ] && grep -q '^SECRET_KEY=.\+' "${SYNO_ROOT}/.env"; then
  say "${SYNO_ROOT}/.env already has a SECRET_KEY — leaving it untouched."
else
  say "Generating a SECRET_KEY and writing ${SYNO_ROOT}/.env"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would write: ${SYNO_ROOT}/.env"
  else
    SECRET="$(generate_secret)"
    printf 'SECRET_KEY=%s\nTRUST_PROXY=0\nTZ=America/Toronto\n' "$SECRET" > "${SYNO_ROOT}/.env"
    chmod 600 "${SYNO_ROOT}/.env"
    say "wrote ${SYNO_ROOT}/.env"
  fi
fi

if [ -n "$LOAD_TAR" ]; then
  step "Loading the prebuilt image"
  run docker load -i "$LOAD_TAR"
else
  step "Building on the NAS (slow on entry-level models — consider --load instead)"
  say "Running: docker compose build"
  run docker compose build
fi

step "Starting"
say "Running: docker compose up -d"
run docker compose up -d

if wait_for_health; then
  cat <<EOF

============================================================
 Budget Tracker is running on your NAS.

   http://<your-nas-address>:${PORT}

 Next: open the URL, create the first (administrator) account,
 then add the rest of the household under Settings -> Users.

 Recommended: put an HTTPS reverse proxy in front of it
 (Control Panel -> Login Portal -> Advanced -> Reverse Proxy)
 and set TRUST_PROXY=1 in ${SYNO_ROOT}/.env afterwards.
============================================================
EOF
else
  print_failure
  exit 1
fi
