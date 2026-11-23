#!/usr/bin/env bash
# =============================================================================
# status.sh (exthub-status) - one screen overview of the server
#
#   sudo exthub-status
# Shows: current release, health, PM2 process, extension zips, releases
# available for rollback, certificate expiry, disk and memory.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }
trap - ERR
set +e

require_root "$@"
load_config

CURRENT="$(current_release)"
PUBLIC_URL="$(app_env PUBLIC_URL)"
echo "${C_BOLD}ext-hub${C_RESET}   $(hostname)   $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "  address: ${PUBLIC_URL}   (panel: ${PUBLIC_URL}/app)"
echo "  current: ${CURRENT:-<nothing deployed>}"
[[ -n "$CURRENT" ]] && grep -E '^(commit|ref|deployed_at|deployed_by)=' "$RELEASES_DIR/$CURRENT/REVISION" 2>/dev/null | sed 's/^/           /'

echo
echo "${C_BOLD}Health${C_RESET}"
port="$(app_env PORT 4000)"
if body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" 2>/dev/null)"; then ok "app    $body"; else err "app    not responding on 127.0.0.1:${port}"; fi
if code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "${PUBLIC_URL}/healthz" 2>/dev/null)" && [[ "$code" == 200 ]]; then
    ok "public ${PUBLIC_URL}/healthz"
else
    warn "public ${PUBLIC_URL}/healthz answered ${code:-nothing} from this server (firewall / Security Group / DNS?)"
fi

echo
echo "${C_BOLD}Process${C_RESET}"
pm2_app ls 2>/dev/null || warn "PM2 is not running for user $APP_USER"

echo
echo "${C_BOLD}Extensions${C_RESET} (${PUBLIC_URL}/downloads/)"
ls -1 "$CURRENT_LINK/downloads" 2>/dev/null | sed 's/^/  /' || echo "  none"

echo
echo "${C_BOLD}Releases${C_RESET} (exthub-rollback --to <name>)"
for r in $(ls -1 "$RELEASES_DIR" 2>/dev/null | sort); do
    mark="   "; [[ "$r" == "$CURRENT" ]] && mark=" ->"
    [[ -e "$RELEASES_DIR/$r/.failed" ]] && echo "$mark $r (failed)" || echo "$mark $r"
done

echo
echo "${C_BOLD}TLS certificate${C_RESET}"
cert="/etc/letsencrypt/live/ext-hub/fullchain.pem"
[[ "${SSL_MODE:-}" == "custom" ]] && cert="${SSL_CERT_PATH:-}"
if [[ "${SSL_MODE:-none}" != "none" && -r "$cert" ]]; then
    echo "  expires: $(openssl x509 -enddate -noout -in "$cert" | cut -d= -f2)"
else
    echo "  none (SSL_MODE=${SSL_MODE:-none})"
fi

echo
echo "${C_BOLD}Resources${C_RESET}"
free -h | sed 's/^/  /'
df -h "$BASE_DIR" | sed 's/^/  /'
echo "  database: $(du -h "$(db_file)" 2>/dev/null | cut -f1)   backups: $(ls -1 "$SHARED_DIR/backups" 2>/dev/null | wc -l) files"
