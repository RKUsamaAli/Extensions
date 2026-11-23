#!/usr/bin/env bash
# =============================================================================
# common.sh - helpers shared by setup-server.sh, deploy.sh, rollback.sh ...
#
# Source it, don't run it:   source "$(dirname "$0")/lib/common.sh"
# =============================================================================

set -Eeuo pipefail

DEPLOY_CONFIG="${DEPLOY_CONFIG:-/etc/ext-hub/deploy.env}"

# ----------------------------------------------------------------- logging ---
if [[ -t 1 ]]; then
    C_RESET=$'\e[0m'; C_BLUE=$'\e[34m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_BOLD=$'\e[1m'
else
    C_RESET=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BOLD=''
fi
log()     { echo "${C_BLUE}[$(date '+%H:%M:%S')]${C_RESET} $*"; }
ok()      { echo "${C_GREEN}[  OK  ]${C_RESET} $*"; }
warn()    { echo "${C_YELLOW}[ WARN ]${C_RESET} $*" >&2; }
err()     { echo "${C_RED}[ FAIL ]${C_RESET} $*" >&2; }
die()     { err "$*"; exit 1; }
step()    { echo; echo "${C_BOLD}==> $*${C_RESET}"; }

# Print the failing command and line on unexpected errors.
# shellcheck disable=SC2154
trap 'rc=$?; err "Command failed (exit $rc) at ${BASH_SOURCE[0]##*/}:${LINENO}: ${BASH_COMMAND}"' ERR

# ---------------------------------------------------------------- guards ---
require_root() {
    [[ $EUID -eq 0 ]] || die "Run this as root: sudo $0 $*"
}

require_ubuntu() {
    [[ -r /etc/os-release ]] || die "Cannot detect the OS (/etc/os-release missing)."
    # shellcheck disable=SC1091
    . /etc/os-release
    [[ "${ID:-}" == "ubuntu" ]] || die "This script supports Ubuntu 22.04 / 24.04 only (found: ${PRETTY_NAME:-unknown})."
    case "${VERSION_ID:-}" in
        22.04|24.04) ;;
        *) warn "Tested on Ubuntu 22.04 and 24.04; you have ${VERSION_ID}. Continuing anyway." ;;
    esac
}

# --------------------------------------------------------------- config ---
# shellcheck disable=SC2034  # variables are used by the scripts that source this file
load_config() {
    [[ -r "$DEPLOY_CONFIG" ]] || die "Config $DEPLOY_CONFIG not found. Run setup-server.sh first."
    # shellcheck disable=SC1090
    source "$DEPLOY_CONFIG"
    : "${APP_USER:?missing in $DEPLOY_CONFIG}" "${BASE_DIR:?missing in $DEPLOY_CONFIG}"
    RELEASES_DIR="$BASE_DIR/releases"
    SHARED_DIR="$BASE_DIR/shared"
    CURRENT_LINK="$BASE_DIR/current"
    REPO_MIRROR="$BASE_DIR/repo.git"
    SCRIPTS_DIR="$BASE_DIR/scripts"
    HISTORY_FILE="$BASE_DIR/releases.log"
    APP_ENV_FILE="$SHARED_DIR/.env"
    KEEP_RELEASES="${KEEP_RELEASES:-5}"
    KEEP_DB_BACKUPS="${KEEP_DB_BACKUPS:-14}"
    HEALTHCHECK_TIMEOUT="${HEALTHCHECK_TIMEOUT:-60}"
    APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
    APP_HOME="${APP_HOME:-/home/$APP_USER}"
}

# Reads KEY from the app's shared .env (falls back to $2).
app_env() {
    local key="$1" default="${2:-}" value=""
    if [[ -r "$APP_ENV_FILE" ]]; then
        value="$(grep -E "^${key}=" "$APP_ENV_FILE" | tail -n1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"
    fi
    echo "${value:-$default}"
}

# Sets KEY=VALUE in a dotenv-style file (adds the line when missing).
set_env_value() {
    local file="$1" key="$2" value="$3"
    if grep -qE "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

# Path of the SQLite database (DB_FILE in the app .env).
db_file() {
    app_env DB_FILE "$SHARED_DIR/data/ext-hub.db"
}

# Consistent online copy of the database (safe while the app writes to it).
# backup_db <dest>   -> fails when the copy does not pass an integrity check
backup_db() {
    local src dest="$1"
    src="$(db_file)"
    [[ -f "$src" ]] || return 1
    sqlite3 "$src" ".timeout 10000" ".backup '$dest'"
    [[ "$(sqlite3 "$dest" 'PRAGMA integrity_check;')" == "ok" ]] || { err "Backup $dest failed the integrity check"; return 1; }
    chown "$APP_USER:$APP_USER" "$dest"
    chmod 600 "$dest"
}

# ------------------------------------------------------ run as app user ---
# as_app <command...>   runs a command as $APP_USER with its HOME (npm/pm2).
as_app() {
    sudo -u "$APP_USER" -H -- "$@"
}

# Absolute path of pm2: sudo's secure_path may not include npm's global bin dir.
pm2_bin() {
    command -v pm2 2>/dev/null || { [[ -x "$(npm prefix -g 2>/dev/null)/bin/pm2" ]] && echo "$(npm prefix -g)/bin/pm2"; } || echo pm2
}

pm2_app() {
    sudo -u "$APP_USER" -H -- "$(pm2_bin)" "$@"
}

# -------------------------------------------------------------- releases ---
current_release() {
    # Empty when nothing is deployed or the link points at a deleted folder.
    if [[ -L "$CURRENT_LINK" && -d "$(readlink -f "$CURRENT_LINK")" ]]; then basename "$(readlink -f "$CURRENT_LINK")"; fi
    return 0
}

# Successful releases, oldest first (failed ones carry a .failed marker).
list_releases() {
    [[ -d "$RELEASES_DIR" ]] || return 0
    local d
    for d in $(ls -1 "$RELEASES_DIR" | sort); do
        [[ -d "$RELEASES_DIR/$d" && ! -e "$RELEASES_DIR/$d/.failed" ]] && echo "$d"
    done
    return 0
}

# Release just before $1 in time order.
release_before() {
    local target="$1" prev="" r
    for r in $(list_releases); do
        [[ "$r" == "$target" ]] && { echo "$prev"; return 0; }
        prev="$r"
    done
    echo ""
}

# Atomically points current -> releases/<name>.
switch_current() {
    local name="$1"
    [[ -d "$RELEASES_DIR/$name" ]] || die "Release $name does not exist."
    ln -sfn "$RELEASES_DIR/$name" "$BASE_DIR/.current.tmp"
    mv -Tf "$BASE_DIR/.current.tmp" "$CURRENT_LINK"
}

history_add() {
    # history_add <action> <release> <status> [note]
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" "$2" "$3" "${4:-}" >> "$HISTORY_FILE"
}

# ------------------------------------------------------------- processes ---
# Starts or restarts ext-hub from the current release. ecosystem.config.js
# resolves to the real release folder, and /healthz reports its name, which
# is what wait_healthy() checks - so "healthy" always means "new code is live".
pm2_reload() {
    # delete + start (not reload): PM2 keeps the old cwd on reload, and the
    # cwd must follow the `current` symlink to the new release.
    pm2_app delete ext-hub >/dev/null 2>&1 || true
    pm2_app start "$CURRENT_LINK/ecosystem.config.js" --update-env >/dev/null
    pm2_app save --force >/dev/null
}

# Waits until /healthz answers with the expected release name.
wait_healthy() {
    local release="$1" timeout="${2:-$HEALTHCHECK_TIMEOUT}" port deadline body
    port="$(app_env PORT 4000)"
    deadline=$(( $(date +%s) + timeout ))
    while (( $(date +%s) < deadline )); do
        body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"
        [[ "$body" == *"\"release\":\"${release}\""* ]] && return 0
        sleep 2
    done
    err "ext-hub did not report release ${release} on 127.0.0.1:${port}/healthz within ${timeout}s (last answer: ${body:-none})"
    return 1
}

show_recent_logs() {
    local logs="$SHARED_DIR/logs"
    warn "Last log lines (full logs: $logs):"
    tail -n 25 "$logs/app.err.log" "$logs/app.out.log" 2>/dev/null || true
}

# ------------------------------------------------------------------ lock ---
# Prevents two deploys/rollbacks running at the same time.
acquire_lock() {
    exec 9>/var/lock/ext-hub-deploy.lock
    flock -n 9 || die "Another deploy or rollback is running. Try again in a minute."
}

# ------------------------------------------------------------- templates ---
# render_template <template> <dest> KEY=VALUE...   replaces {{KEY}} placeholders.
render_template() {
    local tpl="$1" dest="$2"; shift 2
    local content kv key value
    content="$(cat "$tpl")"
    for kv in "$@"; do
        key="${kv%%=*}"; value="${kv#*=}"
        content="${content//\{\{$key\}\}/$value}"
    done
    printf '%s\n' "$content" > "$dest"
}

# Public address of the API: https://<domain>, http://<domain> or http://<ip>.
public_url() {
    local host="${API_DOMAIN:-}"
    [[ -n "$host" ]] || host="${PUBLIC_IP:-}"
    if [[ -n "${API_DOMAIN:-}" && "${SSL_MODE:-letsencrypt}" != "none" ]]; then
        echo "https://${host}"
    else
        echo "http://${host}"
    fi
}
