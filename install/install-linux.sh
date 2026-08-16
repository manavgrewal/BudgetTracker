#!/usr/bin/env bash
# Budget Tracker — Linux / Raspberry Pi installer.
# Idempotent: safe to run again. Never overwrites an existing SECRET_KEY.
set -euo pipefail

SERVICE="budget-tracker"
IMAGE="budget-tracker:latest"
PORT=3000
MODE="install"
PURGE_DATA=0
DRY_RUN=0
LOAD_TAR=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OVERRIDE_FILE="${PROJECT_DIR}/docker-compose.override.yml"

usage() {
  cat <<'EOF'
Budget Tracker installer (Linux, Raspberry Pi, generic Docker hosts)

Usage: install/install-linux.sh [options]

Options:
  --update            Rebuild the image and restart. Your /data is preserved.
  --uninstall         Stop and remove the container and image. /data is kept.
  --purge-data        With --uninstall, also delete ./data. IRREVERSIBLE.
  --load <image.tar>  Load a prebuilt image (docker load) instead of building.
                      Use this on a Raspberry Pi with little RAM: build on a PC
                      with "docker save budget-tracker:latest -o budget-tracker.tar".
  --port <n>          Serve on this host port instead of 3000. Not passing this
                      on a later run reverts to 3000 and removes any earlier override.
  --dry-run           Print every action without doing any of them.
  --help              Show this message.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --update) MODE="update"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --purge-data) PURGE_DATA=1; shift ;;
    --load) LOAD_TAR="${2:-}"; if [ -z "$LOAD_TAR" ]; then echo "--load needs a path to an image tarball" >&2; exit 2; fi; shift 2 ;;
    --port) PORT="${2:-}"; if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$'; then echo "--port needs a number" >&2; exit 2; fi; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Every side effect goes through run() so --dry-run is honest by construction.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would run: $*"
  else
    "$@"
  fi
}

write_file() {
  # write_file <path> <<'CONTENT'
  local target="$1"
  local content
  content="$(cat)"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would write: ${target}"
    return 0
  fi
  printf '%s\n' "$content" > "$target"
  say "wrote ${target}"
}

distro_hint() {
  local id="unknown"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
  fi
  case "$id" in
    ubuntu|debian|raspbian)
      say "  curl -fsSL https://get.docker.com | sudo sh"
      say "  sudo usermod -aG docker \"\$USER\"   # then log out and back in" ;;
    fedora|rhel|centos)
      say "  sudo dnf install -y docker docker-compose-plugin && sudo systemctl enable --now docker" ;;
    arch)
      say "  sudo pacman -S --needed docker docker-compose && sudo systemctl enable --now docker" ;;
    alpine)
      say "  sudo apk add docker docker-cli-compose && sudo rc-update add docker && sudo service docker start" ;;
    *)
      say "  See https://docs.docker.com/engine/install/ for your distribution." ;;
  esac
}

check_prereqs() {
  step "Checking prerequisites"
  local missing=0

  if command -v docker >/dev/null 2>&1; then
    say "docker: $(docker --version 2>/dev/null || echo present)"
  else
    missing=1
    warn "Docker is not installed. Install it with:"
    distro_hint
  fi

  if docker compose version >/dev/null 2>&1; then
    say "compose plugin: $(docker compose version --short 2>/dev/null || echo present)"
  else
    missing=1
    warn "The Docker Compose plugin is missing. On most distributions:"
    say "  sudo apt-get install -y docker-compose-plugin   # or your package manager's equivalent"
    say "  (the old standalone 'docker-compose' binary is not supported)"
  fi

  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64|aarch64|arm64) say "architecture: ${arch}" ;;
    *) warn "Unsupported architecture '${arch}'. Only x86_64 and arm64 are supported." ; missing=1 ;;
  esac

  if [ ! -f "${PROJECT_DIR}/docker-compose.yml" ]; then
    warn "docker-compose.yml was not found in ${PROJECT_DIR}. Run this script from inside the project folder."
    missing=1
  fi

  if [ "$missing" -ne 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "Continuing anyway because this is a dry run."
    else
      die "Fix the problems above and run this script again."
    fi
  fi
}

generate_secret() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s' "<generated at install time>"
    return 0
  fi
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

ensure_env() {
  step "Configuring"
  local env_file="${PROJECT_DIR}/.env"
  if [ -f "$env_file" ] && grep -q '^SECRET_KEY=.\+' "$env_file"; then
    say "${env_file} already has a SECRET_KEY — leaving it untouched."
    return 0
  fi
  say "Generating a SECRET_KEY (48 random bytes) and writing ${env_file}"
  say "Keep this file. Losing SECRET_KEY means every two-factor enrollment has to be redone."
  local secret
  secret="$(generate_secret)"
  write_file "$env_file" <<EOF
# Budget Tracker configuration. Generated by install/install-linux.sh.
# Keep SECRET_KEY safe: losing it forces every user with MFA to re-enroll.
SECRET_KEY=${secret}
TRUST_PROXY=0
TZ=$(cat /etc/timezone 2>/dev/null || echo America/Toronto)
EOF
  if [ "$DRY_RUN" -eq 0 ]; then
    chmod 600 "$env_file"
  fi
}

ensure_port_override() {
  if [ "$PORT" -eq 3000 ]; then
    if [ -f "$OVERRIDE_FILE" ]; then
      step "No --port given; removing the port override left by an earlier run"
      run rm -f "$OVERRIDE_FILE"
    fi
    return 0
  fi
  step "Mapping the app to host port ${PORT}"
  write_file "$OVERRIDE_FILE" <<EOF
# Generated by install/install-linux.sh --port ${PORT}
services:
  ${SERVICE}:
    ports:
      - "${PORT}:3000"
EOF
}

# Single source of truth for "what port is the app actually reachable on right
# now" — reads the override file instead of trusting the $PORT variable, so a
# stale override (or one written on a previous run) can never desync the
# banner/health-check from what docker compose will actually publish.
effective_port() {
  if [ -f "$OVERRIDE_FILE" ]; then
    local parsed
    parsed="$(grep -Eo '"[0-9]+:3000"' "$OVERRIDE_FILE" 2>/dev/null | head -n1 | tr -d '"' | cut -d: -f1)"
    if [ -n "$parsed" ]; then
      printf '%s' "$parsed"
      return 0
    fi
  fi
  printf '%s' "$PORT"
}

ensure_data_dir() {
  step "Preparing ./data"
  run mkdir -p "${PROJECT_DIR}/data"
  say "The container runs as uid 1000; ./data must be writable by it."
  run chown -R 1000:1000 "${PROJECT_DIR}/data" || warn "Could not chown ./data — if the container reports EACCES, run: sudo chown -R 1000:1000 ./data"
}

build_or_load() {
  if [ -n "$LOAD_TAR" ]; then
    step "Loading the prebuilt image from ${LOAD_TAR}"
    if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$LOAD_TAR" ]; then
      die "No such image tarball: ${LOAD_TAR}"
    fi
    run docker load -i "$LOAD_TAR"
    say "Loaded ${IMAGE}. Skipping the build."
    return 0
  fi
  step "Building the image (this takes a few minutes the first time)"
  say "Running: docker compose build"
  run docker compose build
}

start_stack() {
  step "Starting the container"
  say "Running: docker compose up -d"
  run docker compose up -d
}

wait_for_health() {
  local port="$1"
  step "Waiting for the app to report healthy on /api/health"
  local url="http://127.0.0.1:${port}/api/health"
  say "Polling ${url} for up to 120 seconds"
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
  warn "The app did not become healthy within 120 seconds."
  say "Check the logs with: docker compose logs ${SERVICE}"
  return 1
}

print_success() {
  local port="$1"
  local host
  # "|| true" matters here: on hosts where "hostname -I" is unsupported (BusyBox,
  # some macOS/BSD variants), pipefail would otherwise propagate its failure into
  # this assignment and, under set -e, kill the script before printing the URL.
  host="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  [ -n "$host" ] || host="localhost"
  cat <<EOF

============================================================
 Budget Tracker is running.

   http://${host}:${port}
   http://localhost:${port}

 First run:
   1. Open the URL above. You will land on the setup wizard.
   2. Create the first account — it becomes the administrator.
   3. Add the rest of the household under Settings -> Users.
   4. Import a bank CSV from the Import page.

 Useful commands (run from ${PROJECT_DIR}):
   docker compose logs -f ${SERVICE}     # watch the logs
   install/install-linux.sh --update     # rebuild and restart
   install/install-linux.sh --uninstall  # remove, keeping ./data
============================================================
EOF
}

print_failure() {
  local port="$1"
  cat <<EOF

============================================================
 Budget Tracker did NOT report healthy within the timeout.

 The container is left RUNNING on purpose, so you can investigate:
   docker compose logs --tail 100 ${SERVICE}
   docker compose ps
   curl -v http://127.0.0.1:${port}/api/health

 Common causes: a missing or too-short SECRET_KEY, an unwritable ./data, or an
 image built for the wrong CPU architecture. See INSTALL.md's troubleshooting FAQ.
============================================================
EOF
}

do_install() {
  check_prereqs
  ensure_env
  ensure_port_override
  ensure_data_dir
  build_or_load
  start_stack
  local port
  port="$(effective_port)"
  if wait_for_health "$port"; then
    print_success "$port"
  else
    print_failure "$port"
    exit 1
  fi
}

do_update() {
  check_prereqs
  step "Updating in place — ./data is preserved and never touched"
  build_or_load
  say "Running: docker compose up -d"
  run docker compose up -d
  local port
  port="$(effective_port)"
  if wait_for_health "$port"; then
    say "Update complete. Your data was preserved."
  else
    print_failure "$port"
    exit 1
  fi
}

do_uninstall() {
  step "Removing the container"
  say "Running: docker compose down"
  run docker compose down
  step "Removing the image"
  run docker image rm "$IMAGE" || warn "Image ${IMAGE} was not present."
  if [ "$PURGE_DATA" -eq 1 ]; then
    step "Deleting ./data as requested by --purge-data"
    warn "This deletes your database and every backup under ${PROJECT_DIR}/data."
    if [ "$DRY_RUN" -eq 1 ]; then
      run rm -rf "${PROJECT_DIR}/data"
      say "(dry run — no data was actually deleted)"
    elif [ ! -d "${PROJECT_DIR}/data" ]; then
      say "There was no ./data directory to delete."
    else
      rm -rf "${PROJECT_DIR}/data"
      if [ -d "${PROJECT_DIR}/data" ]; then
        warn "Could not fully delete ./data (check permissions). Remove it manually."
      else
        say "Data deleted."
      fi
    fi
  else
    say "Your data was kept at ${PROJECT_DIR}/data — rerun with --purge-data to delete it."
  fi
}

cd "$PROJECT_DIR"
if [ "$DRY_RUN" -eq 1 ]; then
  say "*** DRY RUN — nothing will be changed. ***"
fi

case "$MODE" in
  install) do_install ;;
  update) do_update ;;
  uninstall) do_uninstall ;;
esac
