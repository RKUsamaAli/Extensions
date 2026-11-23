#!/usr/bin/env bash
# =============================================================================
# setup-server.sh (exthub-setup) - one-time provisioning of an Ubuntu 22.04 / 24.04 server
#
# What it does (safe to re-run; every step checks before it changes anything):
#    1. System update + base packages (git, build tools, nginx, certbot, ufw, fail2ban, sqlite3 ...)
#    2. Timezone, swap file, kernel limits
#    3. Node.js LTS + PM2
#    4. App user "exthub" and the directory layout under /opt/ext-hub
#    5. App config /opt/ext-hub/shared/.env with generated secrets
#    6. GitHub deploy key (only for a private repository)
#    7. Firewall (SSH, 80, 443), fail2ban, automatic security updates
#    8. nginx (+ HTTPS certificate from Let's Encrypt when a domain is given)
#    9. PM2 boot service, log rotation, daily DB backup cron
#   10. Installs the commands: exthub-deploy, exthub-rollback, exthub-status,
#       exthub-backup, exthub-cli, exthub-restart, exthub-logs, exthub-setup
#
# Usage (from a checkout of the repository on the server):
#   sudo ./setup-server.sh                                   # no domain: http://<server ip>
#   sudo ./setup-server.sh --domain api.example.com --email you@example.com   # HTTPS
#
#   sudo exthub-setup                  # re-run with values from /etc/ext-hub/deploy.env
#   sudo exthub-setup --ssl-only       # (re)issue the certificate + nginx config only
#   sudo exthub-setup --nginx-only     # re-render nginx config (+ PUBLIC_URL) only
#   sudo exthub-setup --scripts-only   # re-install the exthub-* commands only
#
# All options:
#   --domain D  --email E  --public-ip IP  --repo URL  --branch B
#   --ssl-mode letsencrypt|custom|none  --cert PATH --key PATH (custom)
#   --ssh-port N  --swap-mb N  --node-major N
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }

require_root "$@"
require_ubuntu

# ------------------------------------------------------------ arguments ---
MODE="full"
declare -A OPT=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain)       OPT[API_DOMAIN]="$2"; shift 2 ;;
        --email)        OPT[LETSENCRYPT_EMAIL]="$2"; shift 2 ;;
        --public-ip)    OPT[PUBLIC_IP]="$2"; shift 2 ;;
        --repo)         OPT[REPO_URL]="$2"; shift 2 ;;
        --branch)       OPT[REPO_BRANCH]="$2"; shift 2 ;;
        --ssl-mode)     OPT[SSL_MODE]="$2"; shift 2 ;;
        --cert)         OPT[SSL_CERT_PATH]="$2"; shift 2 ;;
        --key)          OPT[SSL_KEY_PATH]="$2"; shift 2 ;;
        --ssh-port)     OPT[SSH_PORT]="$2"; shift 2 ;;
        --swap-mb)      OPT[SWAP_SIZE_MB]="$2"; shift 2 ;;
        --node-major)   OPT[NODE_MAJOR]="$2"; shift 2 ;;
        --ssl-only)     MODE="ssl"; shift ;;
        --nginx-only)   MODE="nginx"; shift ;;
        --scripts-only) MODE="scripts"; shift ;;
        -h|--help)      sed -n '2,34p' "$0"; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac
done

# ------------------------------------------------- service management ---
# A normal VPS runs systemd. Containers often do not: fall back to `service`.
HAS_SYSTEMD=0
[[ -d /run/systemd/system ]] && HAS_SYSTEMD=1

svc_enable_start() {
    if (( HAS_SYSTEMD )); then
        systemctl enable --now "$1" >/dev/null 2>&1 || systemctl restart "$1"
    else
        service "$1" start >/dev/null 2>&1 || warn "No systemd: could not start $1 (start it manually)."
    fi
}
svc_restart() {
    if (( HAS_SYSTEMD )); then systemctl restart "$1"; else service "$1" restart >/dev/null 2>&1 || service "$1" start >/dev/null 2>&1 || warn "No systemd: could not restart $1."; fi
}
nginx_reload() {
    if (( HAS_SYSTEMD )); then
        systemctl enable nginx >/dev/null 2>&1 || true
        systemctl reload nginx 2>/dev/null || systemctl restart nginx
    elif pgrep -x nginx >/dev/null; then
        nginx -s reload
    else
        nginx
    fi
}

# --------------------------------------------------------- deploy.env ---
detect_public_ip() {
    local ip=""
    # AWS EC2 (IMDSv2), then a public "what is my IP" service.
    local token
    token="$(curl -fsS --max-time 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
    [[ -n "$token" ]] && ip="$(curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
    [[ "$ip" =~ ^[0-9.]+$ ]] || ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    [[ "$ip" =~ ^[0-9.]+$ ]] || ip="$(hostname -I | awk '{print $1}')"
    echo "$ip"
}

init_config() {
    mkdir -p "$(dirname "$DEPLOY_CONFIG")"
    if [[ ! -f "$DEPLOY_CONFIG" ]]; then
        cp "$SCRIPT_DIR/config/deploy.env.example" "$DEPLOY_CONFIG"
        chmod 600 "$DEPLOY_CONFIG"
        ok "Created $DEPLOY_CONFIG"
    fi
    local k
    # A domain without an explicit --ssl-mode means: get a Let's Encrypt certificate.
    if [[ -n "${OPT[API_DOMAIN]:-}" && -z "${OPT[SSL_MODE]:-}" ]]; then OPT[SSL_MODE]=letsencrypt; fi
    for k in "${!OPT[@]}"; do set_env_value "$DEPLOY_CONFIG" "$k" "${OPT[$k]}"; done
    load_config
    if [[ -z "${PUBLIC_IP:-}" ]]; then
        set_env_value "$DEPLOY_CONFIG" PUBLIC_IP "$(detect_public_ip)"
        load_config
    fi
    if [[ "${SSL_MODE:-none}" != "none" && -z "${API_DOMAIN:-}" ]]; then
        die "SSL_MODE=${SSL_MODE} needs a domain: pass --domain api.example.com (or --ssl-mode none)."
    fi
    if [[ "${SSL_MODE:-none}" == "letsencrypt" && -z "${LETSENCRYPT_EMAIL:-}" ]]; then
        die "Let's Encrypt needs an e-mail for expiry notices: pass --email you@example.com"
    fi
    ok "Public address: $(public_url)"
}

# ------------------------------------------------------- 1. packages ---
install_packages() {
    step "1/10 System packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git build-essential python3 \
        nginx certbot ufw fail2ban unattended-upgrades \
        sqlite3 jq logrotate rsync cron zip unzip openssl sudo
    ok "Packages installed"
}

# ------------------------------------------------- 2. system tuning ---
tune_system() {
    step "2/10 Timezone, swap, kernel limits"
    if (( HAS_SYSTEMD )); then
        timedatectl set-timezone "${TIMEZONE:-UTC}" || warn "Could not set timezone"
    else
        ln -sf "/usr/share/zoneinfo/${TIMEZONE:-UTC}" /etc/localtime && echo "${TIMEZONE:-UTC}" > /etc/timezone
    fi

    local swap_mb="${SWAP_SIZE_MB:-1024}"
    if (( swap_mb > 0 )) && ! swapon --show 2>/dev/null | grep -q '/swapfile'; then
        log "Creating ${swap_mb}MB swap file (protects small servers from out-of-memory crashes)"
        if { fallocate -l "${swap_mb}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="$swap_mb" status=none; } \
            && chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; then
            grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
            ok "Swap enabled"
        else
            rm -f /swapfile
            warn "Could not enable swap (not permitted here, e.g. inside a container) - skipped."
        fi
    else
        ok "Swap already configured (or disabled)"
    fi

    cat > /etc/sysctl.d/90-ext-hub.conf <<'CONF'
# ext-hub tuning (setup-server.sh)
vm.swappiness = 10
net.core.somaxconn = 4096
CONF
    sysctl --system >/dev/null 2>&1 || warn "Some kernel settings could not be applied here (container?) - skipped."
    ok "Kernel limits tuned"
}

# ------------------------------------------------------ 3. node + pm2 ---
install_node() {
    step "3/10 Node.js ${NODE_MAJOR:-22} + PM2"
    local want="${NODE_MAJOR:-22}" have=""
    command -v node >/dev/null && have="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [[ "$have" != "$want" ]]; then
        log "Installing Node.js ${want}.x from NodeSource"
        install -d -m 0755 /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${want}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
        apt-get update -y
        apt-get install -y nodejs
    fi
    ok "Node.js $(node -v), npm $(npm -v)"
    command -v pm2 >/dev/null || npm install -g pm2@latest --no-audit --no-fund
    ok "PM2 $(pm2 -v 2>/dev/null | tail -n1)"
}

# ------------------------------------------- 4. user + directory layout ---
create_layout() {
    step "4/10 App user and directories"
    if ! id "$APP_USER" >/dev/null 2>&1; then
        useradd --create-home --shell /bin/bash --comment "ext-hub" "$APP_USER"
        ok "Created user $APP_USER"
    fi
    load_config # refresh APP_HOME
    # /opt/ext-hub
    # |-- current -> releases/<timestamp>_<commit>   (what is running)
    # |-- releases/                                   (one folder per deploy: server + extension zips)
    # |-- repo.git/                                   (git mirror, fast fetches)
    # |-- scripts/                                    (installed deploy scripts)
    # `-- shared/                                     (survives deploys)
    #     |-- .env  data/  logs/  backups/  cache/
    install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$BASE_DIR" "$RELEASES_DIR" "$SHARED_DIR"
    install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$SHARED_DIR/data" "$SHARED_DIR/logs" "$SHARED_DIR/backups" "$SHARED_DIR/cache"
    install -d -m 0755 /var/www/letsencrypt
    touch "$HISTORY_FILE"
    chown "$APP_USER:$APP_USER" "$HISTORY_FILE"
    ok "Layout ready under $BASE_DIR"
}

# ------------------------------------------------------- 5. app .env ---
create_app_env() {
    step "5/10 Application config ($APP_ENV_FILE)"
    local example="$SCRIPT_DIR/../.env.example"
    [[ -r "$example" ]] || example="$SCRIPT_DIR/templates/app.env.example"
    [[ -r "$example" ]] || die "Cannot find ext-hub/.env.example - run this script from the repository checkout."
    if [[ ! -f "$APP_ENV_FILE" ]]; then
        cp "$example" "$APP_ENV_FILE"
        set_env_value "$APP_ENV_FILE" APP_SECRET "$(openssl rand -hex 32)"
        set_env_value "$APP_ENV_FILE" DATA_KEY "$(openssl rand -hex 32)"
        ok "Created $APP_ENV_FILE with fresh secrets (back it up: encrypted data needs DATA_KEY)"
    else
        ok "$APP_ENV_FILE exists - keeping your secrets"
    fi
    sync_app_env
}

# Values that always follow deploy.env / the server layout.
sync_app_env() {
    set_env_value "$APP_ENV_FILE" NODE_ENV production
    set_env_value "$APP_ENV_FILE" PUBLIC_URL "$(public_url)"
    set_env_value "$APP_ENV_FILE" HOST 127.0.0.1
    set_env_value "$APP_ENV_FILE" DB_FILE "$SHARED_DIR/data/ext-hub.db"
    set_env_value "$APP_ENV_FILE" TRUST_PROXY 1
    grep -qE '^PORT=' "$APP_ENV_FILE" || set_env_value "$APP_ENV_FILE" PORT 4000
    chown "$APP_USER:$APP_USER" "$APP_ENV_FILE"
    chmod 600 "$APP_ENV_FILE"
    ok "PUBLIC_URL=$(public_url)"
}

# ---------------------------------------------------- 6. deploy key ---
setup_deploy_key() {
    step "6/10 Repository access"
    if [[ "$REPO_URL" != git@* && "$REPO_URL" != ssh://* ]]; then
        ok "HTTPS repository URL - no deploy key needed (repository must be public)"
        return
    fi
    local ssh_dir="$APP_HOME/.ssh" key="$APP_HOME/.ssh/id_ed25519"
    install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$ssh_dir"
    [[ -f "$key" ]] || as_app ssh-keygen -t ed25519 -N '' -C "ext-hub-deploy@$(hostname)" -f "$key" >/dev/null
    local host; host="$(echo "$REPO_URL" | sed -E 's|^(ssh://)?git@([^:/]+).*|\2|')"
    if ! as_app ssh-keygen -F "$host" >/dev/null 2>&1; then
        ssh-keyscan -t ed25519,rsa "$host" 2>/dev/null >> "$ssh_dir/known_hosts"
        chown "$APP_USER:$APP_USER" "$ssh_dir/known_hosts"
    fi
    if as_app env GIT_SSH_COMMAND="ssh -o BatchMode=yes" git ls-remote "$REPO_URL" >/dev/null 2>&1; then
        ok "Deploy key already has access to $REPO_URL"
    else
        warn "Add this READ-ONLY deploy key to GitHub before the first deploy:"
        warn "  Repo -> Settings -> Deploy keys -> Add deploy key (leave 'Allow write access' unticked)"
        echo; cat "$key.pub"; echo
    fi
}

# ------------------------------------------------- 7. firewall etc. ---
setup_security() {
    step "7/10 Firewall, fail2ban, automatic security updates"
    local ssh_port="${SSH_PORT:-22}"
    ufw default deny incoming >/dev/null 2>&1 || true
    ufw default allow outgoing >/dev/null 2>&1 || true
    ufw allow "${ssh_port}/tcp" comment 'SSH' >/dev/null 2>&1 || true
    ufw allow 80/tcp comment 'HTTP' >/dev/null 2>&1 || true
    ufw allow 443/tcp comment 'HTTPS' >/dev/null 2>&1 || true
    if ufw --force enable >/dev/null 2>&1; then
        ok "ufw: allowing ${ssh_port}, 80, 443"
    else
        warn "FIREWALL NOT ACTIVE: ufw could not be enabled here (no kernel permission, e.g. a container)."
    fi
    warn "AWS: also open TCP 80 and 443 in the instance's Security Group (EC2 -> Security Groups -> Inbound rules)."

    cat > /etc/fail2ban/jail.d/ext-hub.local <<CONF
# ext-hub (setup-server.sh)
[sshd]
enabled  = true
port     = ${ssh_port}
maxretry = 5
bantime  = 1h

[nginx-limit-req]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/ext-hub.error.log
maxretry = 30
findtime = 60
bantime  = 10m
CONF
    touch /var/log/nginx/ext-hub.error.log
    svc_enable_start fail2ban
    svc_restart fail2ban
    ok "fail2ban configured (sshd + nginx rate-limit abuse)"

    cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
    ok "Unattended security upgrades enabled"
}

# --------------------------------------------------- 8. nginx + SSL ---
write_nginx() {
    local variant="$1" cert="${2:-}" key="${3:-}" server_name="${API_DOMAIN:-_}"
    install -m 0644 "$SCRIPT_DIR/templates/ext-hub-proxy.conf" /etc/nginx/snippets/ext-hub-proxy.conf
    install -m 0644 "$SCRIPT_DIR/templates/ext-hub-ssl.conf" /etc/nginx/snippets/ext-hub-ssl.conf
    render_template "$SCRIPT_DIR/templates/nginx-${variant}.conf.tpl" /etc/nginx/sites-available/ext-hub.conf \
        SERVER_NAME="$server_name" APP_PORT="$(app_env PORT 4000)" BASE_DIR="$BASE_DIR" SSL_CERT="$cert" SSL_KEY="$key"
    # Hosts without IPv6 cannot bind [::]:port.
    if [[ ! -s /proc/net/if_inet6 ]]; then
        sed -i '/listen \[::\]/d' /etc/nginx/sites-available/ext-hub.conf
        log "No IPv6 on this host - nginx listens on IPv4 only"
    fi
    ln -sfn /etc/nginx/sites-available/ext-hub.conf /etc/nginx/sites-enabled/ext-hub.conf
    rm -f /etc/nginx/sites-enabled/default
    nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx config test failed"; }
    nginx_reload
}

setup_nginx_ssl() {
    step "8/10 nginx + HTTPS (${SSL_MODE:-none})"
    case "${SSL_MODE:-none}" in
        none)
            write_nginx http
            warn "SSL_MODE=none: serving plain HTTP at $(public_url). Use a domain + HTTPS for real users:"
            warn "  sudo exthub-setup --domain api.example.com --email you@example.com"
            ;;
        custom)
            [[ -r "${SSL_CERT_PATH:-}" && -r "${SSL_KEY_PATH:-}" ]] || die "SSL_MODE=custom needs readable SSL_CERT_PATH and SSL_KEY_PATH in $DEPLOY_CONFIG"
            write_nginx https "$SSL_CERT_PATH" "$SSL_KEY_PATH"
            ok "nginx using your certificate $SSL_CERT_PATH"
            ;;
        letsencrypt)
            local live="/etc/letsencrypt/live/ext-hub"
            if [[ ! -f "$live/fullchain.pem" ]]; then
                write_nginx http   # serve the ACME challenge over plain HTTP first
                log "Requesting a certificate for $API_DOMAIN (its A record must point to ${PUBLIC_IP})"
                if ! certbot certonly --webroot -w /var/www/letsencrypt --cert-name ext-hub \
                        -d "$API_DOMAIN" --email "$LETSENCRYPT_EMAIL" \
                        --agree-tos --non-interactive --keep-until-expiring; then
                    warn "Certificate request failed. Usually DNS is not pointing here yet, or port 80 is closed."
                    warn "Create an A record $API_DOMAIN -> ${PUBLIC_IP}, wait a few minutes, then: sudo exthub-setup --ssl-only"
                    warn "Until then the server answers over plain HTTP."
                    return 0
                fi
            fi
            write_nginx https "$live/fullchain.pem" "$live/privkey.pem"
            install -d /etc/letsencrypt/renewal-hooks/deploy
            printf '#!/bin/sh\nnginx -s reload\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
            chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
            ok "HTTPS active at $(public_url) (auto-renewal via certbot.timer)"
            ;;
        *) die "Unknown SSL_MODE=${SSL_MODE}" ;;
    esac
}

# ------------------------------------------------ 9. pm2 + cron ---
setup_pm2_and_cron() {
    step "9/10 PM2 boot service, log rotation, backups"
    if (( HAS_SYSTEMD )); then
        env PATH="$PATH" "$(pm2_bin)" startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
        systemctl enable "pm2-${APP_USER}" >/dev/null 2>&1 || true
    else
        warn "No systemd: PM2 will not start automatically after a reboot (run: sudo exthub-restart)."
    fi
    if ! pm2_app ls -m 2>/dev/null | grep -q pm2-logrotate; then
        pm2_app install pm2-logrotate >/dev/null 2>&1 || warn "Could not install pm2-logrotate (logs will not rotate)"
    fi
    pm2_app set pm2-logrotate:max_size 20M >/dev/null 2>&1 || true
    pm2_app set pm2-logrotate:retain 14 >/dev/null 2>&1 || true
    pm2_app set pm2-logrotate:compress true >/dev/null 2>&1 || true

    cat > /etc/cron.d/ext-hub <<CONF
# ext-hub (setup-server.sh)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Daily database + config backup at 03:23
23 3 * * * root /usr/local/bin/exthub-backup --quiet >> ${SHARED_DIR}/logs/backup.log 2>&1
CONF
    chmod 644 /etc/cron.d/ext-hub
    svc_enable_start cron
    ok "Daily backup at 03:23"
}

# ---------------------------------------------- 10. install commands ---
install_scripts() {
    step "10/10 Installing exthub-* commands"
    install -d -m 0755 "$SCRIPTS_DIR"
    if [[ "$SCRIPT_DIR" != "$SCRIPTS_DIR" ]]; then
        rsync -a --delete --exclude 'templates/app.env.example' "$SCRIPT_DIR/" "$SCRIPTS_DIR/"
        [[ -r "$SCRIPT_DIR/../.env.example" ]] && cp "$SCRIPT_DIR/../.env.example" "$SCRIPTS_DIR/templates/app.env.example"
    fi
    chmod +x "$SCRIPTS_DIR"/*.sh "$SCRIPTS_DIR"/tools/*.sh
    local name
    for name in deploy rollback status backup; do
        ln -sfn "$SCRIPTS_DIR/${name}.sh" "/usr/local/bin/exthub-${name}"
    done
    ln -sfn "$SCRIPTS_DIR/setup-server.sh" /usr/local/bin/exthub-setup
    for name in cli restart logs; do
        ln -sfn "$SCRIPTS_DIR/tools/exthub-${name}.sh" "/usr/local/bin/exthub-${name}"
    done
    ok "Commands: exthub-deploy exthub-rollback exthub-status exthub-backup exthub-cli exthub-restart exthub-logs exthub-setup"
}

restart_if_deployed() {
    if [[ -L "$CURRENT_LINK" ]]; then
        log "Restarting ext-hub so it picks up configuration changes"
        pm2_reload && wait_healthy "$(current_release)" && ok "ext-hub healthy" || warn "ext-hub not healthy - check: exthub-logs"
        warn "PUBLIC_URL may have changed: run  sudo exthub-deploy  to rebuild the extension zips with the new address."
    fi
}

summary() {
    echo
    echo "${C_GREEN}${C_BOLD}Server setup complete.${C_RESET}"
    cat <<TXT

Next steps
  1. Deploy:                    sudo exthub-deploy
  2. First admin:               sudo exthub-cli create-admin admin
  3. Open the panel:            $(public_url)/app
  4. Extensions (with this server's address built in):
                                $(public_url)/downloads/

Useful commands
  exthub-status              what is running, releases, health
  exthub-deploy --ref <x>    deploy a branch / tag / commit
  exthub-rollback            go back to the previous release
  exthub-logs                follow the application logs
  Config: ${DEPLOY_CONFIG} (deploy)  and  ${APP_ENV_FILE} (app)
TXT
}

# ------------------------------------------------------------------ main ---
init_config
case "$MODE" in
    ssl|nginx)
        create_layout
        [[ -f "$APP_ENV_FILE" ]] && sync_app_env
        setup_nginx_ssl
        restart_if_deployed
        ;;
    scripts)
        install_scripts
        ;;
    full)
        install_packages
        tune_system
        install_node
        create_layout
        create_app_env
        setup_deploy_key
        setup_security
        setup_nginx_ssl
        setup_pm2_and_cron
        install_scripts
        restart_if_deployed
        summary
        ;;
esac
