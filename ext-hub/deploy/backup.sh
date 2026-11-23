#!/usr/bin/env bash
# =============================================================================
# backup.sh (exthub-backup) - back up the database and configuration
#
#   sudo exthub-backup            # runs daily from /etc/cron.d/ext-hub
#   sudo exthub-backup --quiet
#
# Creates shared/backups/daily-<date>.tar.gz containing:
#   ext-hub.db  (consistent online copy, safe while the app runs)
#   .env        (APP_SECRET + DATA_KEY: encrypted data is unreadable without them)
#   deploy.env  (deploy settings)
# and keeps the newest KEEP_DB_BACKUPS archives.
#
# Copy these archives OFF the server too (e.g. scp / rclone / S3) - a backup on
# the same disk does not survive losing the server.
#
# Restore:  sudo -u exthub pm2 stop ext-hub
#           mkdir /tmp/restore && tar -xzf daily-<date>.tar.gz -C /tmp/restore
#           cp /tmp/restore/ext-hub.db /opt/ext-hub/shared/data/ext-hub.db
#           rm -f /opt/ext-hub/shared/data/ext-hub.db-wal /opt/ext-hub/shared/data/ext-hub.db-shm
#           chown exthub:exthub /opt/ext-hub/shared/data/ext-hub.db
#           sudo exthub-restart
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }

require_root "$@"
load_config
QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

[[ -f "$(db_file)" ]] || die "No database at $(db_file) yet."

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

backup_db "$WORK/ext-hub.db"
cp "$APP_ENV_FILE" "$WORK/.env"
cp "$DEPLOY_CONFIG" "$WORK/deploy.env"

ARCHIVE="$SHARED_DIR/backups/daily-${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" ext-hub.db .env deploy.env
chown "$APP_USER:$APP_USER" "$ARCHIVE"
chmod 600 "$ARCHIVE"

find "$SHARED_DIR/backups" -maxdepth 1 -name 'daily-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +$(( KEEP_DB_BACKUPS + 1 )) | cut -d' ' -f2- | xargs -r rm -f || true

(( QUIET )) || ok "Backup written: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
(( QUIET )) && echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] backup ok: $ARCHIVE"
exit 0
