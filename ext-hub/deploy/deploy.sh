#!/usr/bin/env bash
# =============================================================================
# deploy.sh (exthub-deploy) - deploy a new release with automatic rollback
#
#   sudo exthub-deploy                      # latest commit of REPO_BRANCH
#   sudo exthub-deploy --ref v1.2.0         # a tag, branch or commit sha
#   sudo exthub-deploy --source /path/repo  # from a local checkout (no git fetch)
#   sudo exthub-deploy --skip-tests         # skip the test suites
#   sudo exthub-deploy --skip-extensions    # don't rebuild the extension zips
#
# Steps (each release is a fresh folder; the running one is never modified):
#    1. fetch code            git mirror -> releases/<YYYYmmddHHMMSS>_<sha>/
#    2. install dependencies  npm ci (reuses node_modules if package-lock is unchanged)
#    3. test                  ext-hub, CitaMate and RelaySwitch test suites
#    4. extensions            CitaMate + RelaySwitch zips with PUBLIC_URL as the
#                             default server -> releases/<x>/downloads/ (served at /downloads/)
#    5. link shared files     .env -> shared/.env
#    6. backup + migrate DB   shared/backups/pre-deploy-<release>.db, then migrations
#    7. switch                current -> new release (atomic symlink swap)
#    8. restart + health      /healthz must report the NEW release
#       on failure            switch back to the previous release automatically
#    9. clean up              keep the last KEEP_RELEASES releases
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }

require_root "$@"
load_config

REF="${REPO_BRANCH:-main}"
SOURCE_DIR=""
RUN_TESTS="${RUN_TESTS:-true}"
BUILD_EXTENSIONS="${BUILD_EXTENSIONS:-true}"
AUTO_ROLLBACK="${AUTO_ROLLBACK:-true}"
CITAMATE_SUBDIR="${CITAMATE_SUBDIR:-icp-autofill}"
RELAYSWITCH_SUBDIR="${RELAYSWITCH_SUBDIR:-relayswitch}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref)             REF="$2"; shift 2 ;;
        --source)          SOURCE_DIR="$(readlink -f "$2")"; shift 2 ;;
        --skip-tests)      RUN_TESTS=false; shift ;;
        --skip-extensions) BUILD_EXTENSIONS=false; shift ;;
        --no-rollback)     AUTO_ROLLBACK=false; shift ;;
        -h|--help)         sed -n '2,24p' "$0"; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac
done

acquire_lock
[[ -f "$APP_ENV_FILE" ]] || die "$APP_ENV_FILE missing - run setup-server.sh first."
PUBLIC_URL="$(app_env PUBLIC_URL)"
[[ -n "$PUBLIC_URL" ]] || die "PUBLIC_URL missing in $APP_ENV_FILE - run: sudo exthub-setup --nginx-only"

PREVIOUS="$(current_release)"
STARTED=$(date +%s)
NEW_RELEASE=""
SWITCHED=0
BUILD_DIR=""

# Before the switch: remove nothing live, mark the half-built release as failed.
# After the switch: roll back (when AUTO_ROLLBACK=true).
on_failure() {
    local rc=$?
    trap - ERR EXIT
    [[ -n "$BUILD_DIR" ]] && rm -rf "$BUILD_DIR"
    (( rc == 0 )) && return 0
    if [[ -n "$NEW_RELEASE" ]]; then
        if (( SWITCHED )); then
            show_recent_logs
            if [[ "$AUTO_ROLLBACK" == "true" && -n "$PREVIOUS" ]]; then
                warn "Rolling back to $PREVIOUS"
                switch_current "$PREVIOUS"
                pm2_reload || true
                if wait_healthy "$PREVIOUS" 60; then
                    ok "Rolled back to $PREVIOUS - the server is running the previous version."
                else
                    err "Previous release is not healthy either. Check: exthub-logs"
                fi
                history_add rollback "$PREVIOUS" auto "after failed deploy of $NEW_RELEASE"
            fi
        fi
        touch "$RELEASES_DIR/$NEW_RELEASE/.failed" 2>/dev/null || true
        history_add deploy "$NEW_RELEASE" failed "ref=$REF"
        err "Deploy of $NEW_RELEASE FAILED. It is kept (marked .failed) for inspection: $RELEASES_DIR/$NEW_RELEASE"
    fi
    exit "$rc"
}
trap on_failure EXIT

# extract <subdir> <dest>   copies one folder of the commit being deployed into dest.
extract() {
    local sub="$1" dest="$2" strip
    as_app mkdir -p "$dest"
    if [[ -n "$SOURCE_DIR" ]]; then
        [[ -d "$SOURCE_DIR/$sub" ]] || die "$SOURCE_DIR/$sub not found (is --source the repository root?)"
        rsync -a --exclude node_modules --exclude dist --exclude data --exclude .env "$SOURCE_DIR/$sub/" "$dest/"
        chown -R "$APP_USER:$APP_USER" "$dest"
    else
        strip=$(( $(echo "$sub" | tr -cd '/' | wc -c) + 1 ))
        as_app bash -c "git -C '$REPO_MIRROR' archive '$SHA' '$sub' | tar -x -C '$dest' --strip-components=$strip"
    fi
}

# npm_ci_cached <dir> <name> <dev|prod>   npm ci, reusing node_modules cached per package-lock + Node version.
npm_ci_cached() {
    local dir="$1" name="$2" kind="$3" key cache
    key="$(cat "$dir/package-lock.json" <(node -v) <(echo "$kind") | sha256sum | cut -c1-16)"
    cache="$SHARED_DIR/cache/node_modules-$name-$key"
    if [[ -d "$cache" ]]; then
        as_app cp -a "$cache" "$dir/node_modules"
        ok "$name: package-lock.json unchanged - reused cached node_modules"
    else
        local flags=(--no-audit --no-fund --loglevel=error)
        [[ "$kind" == "prod" ]] && flags+=(--omit=dev)
        (cd "$dir" && as_app npm ci "${flags[@]}")
        rm -rf "$SHARED_DIR/cache/node_modules-$name-"*
        as_app cp -a "$dir/node_modules" "$cache"
        ok "$name: npm ci done"
    fi
}

# ------------------------------------------------------------ 1. fetch ---
step "1/9 Fetching code"
if [[ -n "$SOURCE_DIR" ]]; then
    [[ -d "$SOURCE_DIR/$APP_SUBDIR" ]] || die "$SOURCE_DIR/$APP_SUBDIR not found (is --source the repository root?)"
    SHA="$(git -C "$SOURCE_DIR" rev-parse --verify --quiet HEAD 2>/dev/null || echo local)"
    [[ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null || true)" ]] && SHA="${SHA:0:7}-dirty"
else
    if [[ ! -d "$REPO_MIRROR/refs" ]]; then
        log "Cloning $REPO_URL (first deploy)"
        install -d -o "$APP_USER" -g "$APP_USER" "$REPO_MIRROR"
        as_app git clone --mirror --quiet "$REPO_URL" "$REPO_MIRROR"
    fi
    as_app git -C "$REPO_MIRROR" remote set-url origin "$REPO_URL"
    as_app git -C "$REPO_MIRROR" fetch --prune --quiet origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
    SHA="$(as_app git -C "$REPO_MIRROR" rev-parse --verify --quiet "${REF}^{commit}")" || die "Ref '$REF' not found in $REPO_URL"
fi
if [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then SHORT="${SHA:0:7}"; else SHORT="$(echo "$SHA" | tr -cd 'a-zA-Z0-9-' | cut -c1-13)"; fi
NEW_RELEASE="$(date +%Y%m%d%H%M%S)_${SHORT}"
RELEASE_DIR="$RELEASES_DIR/$NEW_RELEASE"
install -d -o "$APP_USER" -g "$APP_USER" "$RELEASE_DIR"

extract "$APP_SUBDIR" "$RELEASE_DIR"
# This commit's deploy scripts (installed to $SCRIPTS_DIR after a successful deploy)
extract "$DEPLOY_SUBDIR" "$RELEASE_DIR/.deploy"
as_app cp "$RELEASE_DIR/.env.example" "$RELEASE_DIR/.deploy/templates/app.env.example"
[[ -f "$RELEASE_DIR/package.json" ]] || die "No package.json in the release - check APP_SUBDIR=$APP_SUBDIR"
as_app tee "$RELEASE_DIR/REVISION" >/dev/null <<TXT
release=$NEW_RELEASE
commit=$SHA
ref=$REF
deployed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
deployed_by=${SUDO_USER:-root}
public_url=$PUBLIC_URL
TXT
ok "Release $NEW_RELEASE ($REF @ $SHORT)"

# ---------------------------------------------------- 2. dependencies ---
step "2/9 Installing dependencies"
npm_ci_cached "$RELEASE_DIR" ext-hub prod
if [[ "$BUILD_EXTENSIONS" == "true" || "$RUN_TESTS" == "true" ]]; then
    BUILD_DIR="$SHARED_DIR/cache/build-$NEW_RELEASE"
    # Same layout as the repository: the extensions' tests read ../ext-hub/seeds.
    extract "$CITAMATE_SUBDIR" "$BUILD_DIR/$CITAMATE_SUBDIR"
    extract "$RELAYSWITCH_SUBDIR" "$BUILD_DIR/$RELAYSWITCH_SUBDIR"
    as_app mkdir -p "$(dirname "$BUILD_DIR/$APP_SUBDIR")"
    as_app ln -sfn "$RELEASE_DIR" "$BUILD_DIR/$APP_SUBDIR"
    npm_ci_cached "$BUILD_DIR/$RELAYSWITCH_SUBDIR" relayswitch dev
fi

# ------------------------------------------------------------ 3. test ---
step "3/9 Tests"
if [[ "$RUN_TESTS" == "true" ]]; then
    # run_suite <name> <dir> <command...>   (no .env is linked yet: tests never see production settings)
    run_suite() {
        local name="$1" dir="$2"; shift 2
        local out="$RELEASE_DIR/.test-${name}.log"
        (cd "$dir" && as_app env NODE_ENV=test timeout 300 "$@" >"$out" 2>&1) || {
            tail -n 40 "$out"
            die "$name tests failed - nothing was changed on the live server."
        }
        ok "$name: $(grep -hoE '^# pass [0-9]+|Tests +[0-9]+ passed' "$out" | head -n1 | sed 's/^# //')"
    }
    run_suite ext-hub "$RELEASE_DIR" npm test --silent
    run_suite citamate "$BUILD_DIR/$CITAMATE_SUBDIR" node --test
    run_suite relayswitch "$BUILD_DIR/$RELAYSWITCH_SUBDIR" npx vitest run
else
    warn "Tests skipped"
fi

# ------------------------------------------------------ 4. extensions ---
step "4/9 Extension packages (default server: $PUBLIC_URL)"
if [[ "$BUILD_EXTENSIONS" == "true" ]]; then
    DL="$RELEASE_DIR/downloads"
    as_app mkdir -p "$DL"
    # CitaMate: no build step; set the default server and zip the folder.
    CM="$BUILD_DIR/$CITAMATE_SUBDIR"
    as_app sed -i -E "s|^(  API_BASE: )\"[^\"]*\"|\1\"${PUBLIC_URL}\"|" "$CM/config.js"
    grep -qF "API_BASE: \"${PUBLIC_URL}\"" "$CM/config.js" || die "Could not set API_BASE in $CITAMATE_SUBDIR/config.js"
    CM_VER="$(jq -r .version "$CM/manifest.json")"
    (cd "$CM" && as_app zip -qr "$DL/citamate-${CM_VER}.zip" . -x 'test/*' 'package*.json' 'node_modules/*' '*.log')
    ok "citamate-${CM_VER}.zip"
    # RelaySwitch: set the default server, build, zip dist/.
    RS="$BUILD_DIR/$RELAYSWITCH_SUBDIR"
    as_app sed -i -E "s|^(export const DEFAULT_API_BASE = )\"[^\"]*\";|\1\"${PUBLIC_URL}\";|" "$RS/src/shared/config.ts"
    grep -qF "DEFAULT_API_BASE = \"${PUBLIC_URL}\";" "$RS/src/shared/config.ts" || die "Could not set DEFAULT_API_BASE in $RELAYSWITCH_SUBDIR/src/shared/config.ts"
    (cd "$RS" && as_app npm run build --silent >/dev/null)
    RS_VER="$(jq -r .version "$RS/dist/manifest.json")"
    grep -qF "$PUBLIC_URL" "$RS/dist/background/index.js" || die "RelaySwitch build does not contain $PUBLIC_URL"
    (cd "$RS/dist" && as_app zip -qr "$DL/relayswitch-${RS_VER}.zip" .)
    ok "relayswitch-${RS_VER}.zip"
    as_app tee "$DL/INSTALL.txt" >/dev/null <<TXT
CitaMate ${CM_VER} and RelaySwitch ${RS_VER} - release ${NEW_RELEASE}
Default server: ${PUBLIC_URL}

Install in Chrome / Edge / Brave:
  1. Download the zip and unzip it into a folder you keep (don't delete it later).
  2. Open chrome://extensions and switch on "Developer mode" (top right).
  3. Click "Load unpacked" and pick the unzipped folder.
  4. Open the extension and sign in with your ext-hub account.
To update: unzip the new version over the same folder, then click the reload icon on chrome://extensions.
TXT
else
    warn "Extension packages skipped"
    if [[ -n "$PREVIOUS" && -d "$RELEASES_DIR/$PREVIOUS/downloads" ]]; then
        as_app cp -a "$RELEASES_DIR/$PREVIOUS/downloads" "$RELEASE_DIR/downloads"
        ok "Kept the zips of $PREVIOUS"
    fi
fi
[[ -n "$BUILD_DIR" ]] && rm -rf "$BUILD_DIR"
BUILD_DIR=""

# --------------------------------------------------- 5. shared files ---
step "5/9 Linking shared config"
as_app ln -sfn "$APP_ENV_FILE" "$RELEASE_DIR/.env"
ok ".env -> $APP_ENV_FILE"

# ---------------------------------------------- 6. backup + migrate ---
step "6/9 Database backup + migrations"
if [[ -f "$(db_file)" ]]; then
    BACKUP="$SHARED_DIR/backups/pre-deploy-${NEW_RELEASE}.db"
    backup_db "$BACKUP"
    ok "Backup: $BACKUP"
fi
(cd "$RELEASE_DIR" && as_app node src/cli.js migrate)

# ---------------------------------------------------------- 7. switch ---
step "7/9 Switching current -> $NEW_RELEASE"
switch_current "$NEW_RELEASE"
SWITCHED=1
ok "current -> $RELEASE_DIR"

# --------------------------------------------------- 8. restart + check ---
step "8/9 Restarting and checking health"
pm2_reload
wait_healthy "$NEW_RELEASE" || die "New release is not healthy."
# Through nginx too, as the extensions and the panel reach it.
if curl -fsS --max-time 5 -H "Host: $(echo "$PUBLIC_URL" | sed -E 's|^https?://||; s|/.*||')" http://127.0.0.1/healthz >/dev/null 2>&1 \
   || curl -fsSk --max-time 5 "$PUBLIC_URL/healthz" >/dev/null 2>&1; then
    ok "ext-hub is healthy on $NEW_RELEASE (direct and through nginx)"
else
    warn "ext-hub is healthy on $NEW_RELEASE, but nginx did not answer - check: sudo nginx -t; exthub-logs nginx"
fi
history_add deploy "$NEW_RELEASE" success "ref=$REF commit=$SHA previous=${PREVIOUS:-none}"

# The release is live and healthy: from here on nothing may undo it.
trap - EXIT
trap - ERR
set +e

# --------------------------------------------------------- 9. cleanup ---
step "9/9 Cleanup"
if [[ -d "$RELEASE_DIR/.deploy" ]]; then
    NGINX_CHANGED=0
    diff -rq "$RELEASE_DIR/.deploy/templates" "$SCRIPTS_DIR/templates" >/dev/null 2>&1 || NGINX_CHANGED=1
    rsync -a --delete "$RELEASE_DIR/.deploy/" "$SCRIPTS_DIR/"
    chmod +x "$SCRIPTS_DIR"/*.sh "$SCRIPTS_DIR"/tools/*.sh 2>/dev/null || true
    # New nginx templates in this commit: apply them now (nginx -t is checked first).
    if (( NGINX_CHANGED )); then
        if "$SCRIPTS_DIR/setup-server.sh" --nginx-only >/dev/null 2>&1; then ok "nginx config updated from this release's templates"
        else warn "Could not apply the new nginx templates - run: sudo exthub-setup --nginx-only"; fi
    fi
fi
mapfile -t ALL < <(ls -1 "$RELEASES_DIR" | sort)
REMOVE_COUNT=$(( ${#ALL[@]} - KEEP_RELEASES ))
for (( i = 0; i < REMOVE_COUNT; i++ )); do
    r="${ALL[$i]}"
    [[ "$r" == "$NEW_RELEASE" || "$r" == "$PREVIOUS" ]] && continue
    rm -rf "${RELEASES_DIR:?}/$r"
    log "Removed old release $r"
done
find "$SHARED_DIR/backups" -maxdepth 1 -name 'pre-deploy-*.db' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +$(( KEEP_DB_BACKUPS + 1 )) | cut -d' ' -f2- | xargs -r rm -f

echo
ok "${C_BOLD}Deployed $NEW_RELEASE in $(( $(date +%s) - STARTED ))s${C_RESET}  (previous: ${PREVIOUS:-none})"
echo "    Panel:       $PUBLIC_URL/app"
echo "    Extensions:  $PUBLIC_URL/downloads/"
echo "    Roll back any time with:  sudo exthub-rollback"
