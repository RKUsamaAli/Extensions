#!/usr/bin/env bash
# =============================================================================
# exthub-restart - restart ext-hub (after editing /opt/ext-hub/shared/.env, or after a reboot without systemd)
#
#   sudo exthub-restart
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }
require_root "$@"
load_config
acquire_lock
release="$(current_release)"
[[ -n "$release" ]] || die "Nothing deployed yet - run: sudo exthub-deploy"
log "Restarting $release"
pm2_reload
wait_healthy "$release" && ok "Restarted and healthy." || { show_recent_logs; die "Not healthy after restart."; }
