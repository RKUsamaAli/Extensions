#!/usr/bin/env bash
# =============================================================================
# exthub-logs - follow logs
#
#   sudo exthub-logs            # application (PM2)
#   sudo exthub-logs errors     # only warnings and errors (JSON lines, via jq)
#   sudo exthub-logs nginx      # nginx access + error logs
#   sudo exthub-logs deploys    # deploy / rollback history
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }
trap - ERR
require_root "$@"
load_config
case "${1:-app}" in
    nginx)   exec tail -n 50 -F /var/log/nginx/ext-hub.access.log /var/log/nginx/ext-hub.error.log ;;
    errors)  tail -n 200 -F "$SHARED_DIR"/logs/app.out.log "$SHARED_DIR"/logs/app.err.log \
                 | grep --line-buffered -E '"level":"(warn|error)"' | jq -c --unbuffered . 2>/dev/null ;;
    deploys) exec tail -n 30 "$HISTORY_FILE" ;;
    *)       pm2_app logs ext-hub --lines 100 ;;
esac
