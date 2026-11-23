#!/usr/bin/env bash
# =============================================================================
# exthub-cli - run the ext-hub admin CLI as the app user, in the current release
#
#   sudo exthub-cli create-admin admin                  # prints a generated password
#   sudo exthub-cli reset-password admin
#   sudo exthub-cli grant ali citamate 2026-12-31 2     # access until that date, 2 devices
#   sudo exthub-cli grant ali relayswitch never 1
#   sudo exthub-cli users
#   sudo exthub-cli maintenance
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }
trap - ERR
require_root "$@"
load_config
[[ -L "$CURRENT_LINK" ]] || die "Nothing deployed yet - run: sudo exthub-deploy"
cd "$CURRENT_LINK" && exec sudo -u "$APP_USER" -H node src/cli.js "$@"
