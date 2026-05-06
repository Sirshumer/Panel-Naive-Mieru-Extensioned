#!/usr/bin/env bash
# ==============================================================================
# Panel Naive + Mieru by RIXXX — update.sh
# Usage: bash update.sh [--dry-run] [--force] [--expose <domain>] [--ssh-only]
#                       [--status] [--repair] [--help] [-y]
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }
log_dry()   { echo -e "${YELLOW}[DRY-RUN]${NC} $*"; }
die()       { log_error "$*"; exit 1; }

# ── Constants ─────────────────────────────────────────────────────────────────
TARGET_VERSION="1.0.0"
PANEL_DIR="/opt/panel-naive-mieru"
PANEL_CONFIG="/etc/rixxx-panel/config.json"
VERSION_FILE="/etc/rixxx-panel/version"
BACKUP_DIR="/etc/rixxx-panel/backups"
CADDYFILE="/etc/caddy-naive/Caddyfile"
MITA_CONFIG_DIR="/etc/mita"
CADDY_BIN="/usr/local/bin/caddy-naive"
DB_PATH="/var/lib/rixxx-panel/db.sqlite"
NAIVE_RELEASES="https://api.github.com/repos/klzgrad/naiveproxy/releases/latest"
MIERU_RELEASES="https://api.github.com/repos/enfein/mieru/releases/latest"
REPO_RAW="https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main"

# ── Flags ─────────────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE=false
YES=false
MODE=""         # expose | ssh-only | repair | status | update
EXPOSE_DOMAIN=""

# ── Parse args ────────────────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)   DRY_RUN=true ;;
      --force)     FORCE=true ;;
      -y|--yes)    YES=true ;;
      --expose)    MODE="expose"; EXPOSE_DOMAIN="${2:-}"; shift ;;
      --ssh-only)  MODE="ssh-only" ;;
      --status)    MODE="status" ;;
      --repair)    MODE="repair" ;;
      --help|-h)   print_help; exit 0 ;;
      *) die "Unknown argument: $1  (use --help)" ;;
    esac
    shift
  done
  [[ -z "$MODE" ]] && MODE="update"
}

print_help() {
  cat <<EOF
${BOLD}Panel Naive + Mieru — update.sh${NC}

USAGE:
  bash update.sh [options]

OPTIONS:
  (no flag)              Update all components to latest versions
  --dry-run              Show what would be done without making changes
  --force                Force update even if already on latest version
  -y / --yes             Non-interactive (auto-confirm all prompts)
  --expose <domain>      Switch panel to public mode behind Caddy on :8080
  --ssh-only             Switch panel back to SSH-tunnel-only (127.0.0.1:3000)
  --status               Print full health report
  --repair               Restore broken configs from latest backup
  --help                 Show this help

EXAMPLES:
  bash update.sh                   # Interactive update
  bash update.sh --dry-run         # Preview changes
  bash update.sh --force -y        # Force update, non-interactive
  bash update.sh --status          # Health check
  bash update.sh --repair          # Fix broken installation
  bash update.sh --expose vpn.example.com  # Public panel
  bash update.sh --ssh-only        # Revert to SSH-only
EOF
}

# ── Prerequisite checks ───────────────────────────────────────────────────────
check_root()    { [[ $EUID -ne 0 ]] && die "Run as root"; }
check_install() {
  [[ ! -f "$PANEL_CONFIG" ]] && \
    die "Panel not installed. Run install.sh first."
}

load_config() {
  DOMAIN=$(jq -r '.domain'         "$PANEL_CONFIG")
  NAIVE_PORT=$(jq -r '.naivePort'  "$PANEL_CONFIG")
  MIERU_START=$(jq -r '.mieruPortStart' "$PANEL_CONFIG")
  MIERU_END=$(jq -r '.mieruPortEnd'     "$PANEL_CONFIG")
  EXPOSE=$(jq -r '.exposePanel'    "$PANEL_CONFIG")
  ADMIN_EMAIL=$(jq -r '.adminEmail' "$PANEL_CONFIG")
}

# ── Backup ────────────────────────────────────────────────────────────────────
auto_backup() {
  local ts
  ts=$(date +%Y-%m-%d-%H%M%S)
  local bdir="$BACKUP_DIR/$ts"

  $DRY_RUN && { log_dry "Would create backup at $bdir"; return; }

  mkdir -p "$bdir"
  [[ -f "$CADDYFILE"                    ]] && cp "$CADDYFILE"                    "$bdir/Caddyfile"
  [[ -f "$MITA_CONFIG_DIR/server.json"  ]] && cp "$MITA_CONFIG_DIR/server.json"  "$bdir/mita-server.json"
  [[ -f "$PANEL_CONFIG"                 ]] && cp "$PANEL_CONFIG"                 "$bdir/config.json"
  [[ -f "$MITA_CONFIG_DIR/users.json"   ]] && cp "$MITA_CONFIG_DIR/users.json"   "$bdir/mita-users.json"
  [[ -f /etc/systemd/system/caddy-naive.service ]] && \
    cp /etc/systemd/system/caddy-naive.service "$bdir/"
  [[ -f /etc/systemd/system/mita.service ]] && \
    cp /etc/systemd/system/mita.service "$bdir/"

  log_info "Backup created: $bdir"

  # Keep only latest 10 backups
  local count
  count=$(ls -1d "$BACKUP_DIR"/*/  2>/dev/null | wc -l)
  if (( count > 10 )); then
    ls -1dt "$BACKUP_DIR"/*/ | tail -n +11 | xargs rm -rf
    log_info "Old backups pruned (kept 10 most recent)"
  fi
  echo "$bdir"
}

rollback_from_backup() {
  local bdir="$1"
  [[ ! -d "$bdir" ]] && die "Backup directory not found: $bdir"

  log_step "Rolling back from $bdir"
  [[ -f "$bdir/Caddyfile"          ]] && cp "$bdir/Caddyfile"          "$CADDYFILE"
  [[ -f "$bdir/mita-server.json"   ]] && cp "$bdir/mita-server.json"   "$MITA_CONFIG_DIR/server.json"
  [[ -f "$bdir/config.json"        ]] && cp "$bdir/config.json"        "$PANEL_CONFIG"
  [[ -f "$bdir/mita-users.json"    ]] && cp "$bdir/mita-users.json"    "$MITA_CONFIG_DIR/users.json"
  systemctl daemon-reload
  systemctl restart caddy-naive mita 2>/dev/null || true
  log_info "Rollback complete ✓"
}

# ── Architecture detection ────────────────────────────────────────────────────
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  ARCH="amd64"; DEB_ARCH="amd64"; NAIVE_ARCH="linux-amd64"   ;;
    aarch64|arm64) ARCH="arm64"; DEB_ARCH="arm64"; NAIVE_ARCH="linux-arm64"   ;;
    armv7l)        ARCH="armv7"; DEB_ARCH="armhf"; NAIVE_ARCH="linux-arm"     ;;
    *) die "Unsupported arch: $(uname -m)" ;;
  esac
}

# ── Version comparison ────────────────────────────────────────────────────────
version_gt() {
  # Returns 0 (true) if $1 > $2
  [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" && "$1" != "$2" ]]
}

get_current_version() {
  [[ -f "$VERSION_FILE" ]] && cat "$VERSION_FILE" || echo "0.0.0"
}

# ── Update NaiveProxy ─────────────────────────────────────────────────────────
update_naiveproxy() {
  log_step "Checking NaiveProxy update"
  local release_json
  release_json=$(curl -fsSL "$NAIVE_RELEASES") || { log_warn "Cannot reach GitHub API for NaiveProxy"; return; }

  local remote_tag current_ver
  remote_tag=$(echo "$release_json" | jq -r '.tag_name')
  current_ver=$("$CADDY_BIN" version 2>/dev/null | head -1 || echo "none")

  log_info "Current: $current_ver  |  Latest: $remote_tag"

  if ! $FORCE && echo "$current_ver" | grep -qF "${remote_tag#v}"; then
    log_info "NaiveProxy already up-to-date ✓"
    return
  fi

  $DRY_RUN && { log_dry "Would update caddy-naive to $remote_tag"; return; }

  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$NAIVE_ARCH" \
    '.assets[] | select(.name | test("naiveproxy-.*" + $arch)) | select(.name | test("\\.tar\\.xz|\\.tar\\.gz|\\.zip")) | .browser_download_url' \
    | head -1)

  [[ -z "$asset_url" ]] && { log_warn "No NaiveProxy asset found for $NAIVE_ARCH"; return; }

  local tmp_dir; tmp_dir=$(mktemp -d)
  local archive_name; archive_name=$(basename "$asset_url")
  wget -q -O "$tmp_dir/$archive_name" "$asset_url"
  cd "$tmp_dir"
  [[ "$archive_name" == *.tar.xz ]] && tar -xJf "$archive_name"
  [[ "$archive_name" == *.tar.gz ]] && tar -xzf "$archive_name"
  [[ "$archive_name" == *.zip ]]    && unzip -q  "$archive_name"

  local caddy_bin
  caddy_bin=$(find "$tmp_dir" -type f -name "caddy*" ! -name "*.xz" ! -name "*.gz" ! -name "*.zip" | head -1)
  [[ -n "$caddy_bin" ]] && install -m 755 "$caddy_bin" "$CADDY_BIN"
  rm -rf "$tmp_dir"; cd /

  systemctl reload caddy-naive 2>/dev/null || systemctl restart caddy-naive
  log_info "NaiveProxy updated to $remote_tag ✓"
}

# ── Update Mieru ──────────────────────────────────────────────────────────────
update_mieru() {
  log_step "Checking Mieru update"
  local release_json
  release_json=$(curl -fsSL "$MIERU_RELEASES") || { log_warn "Cannot reach GitHub API for Mieru"; return; }

  local remote_tag current_ver
  remote_tag=$(echo "$release_json" | jq -r '.tag_name')
  current_ver=$(mita version 2>/dev/null | grep -oP 'v[\d.]+' | head -1 || echo "none")

  log_info "Current: $current_ver  |  Latest: $remote_tag"

  if ! $FORCE && [[ "$current_ver" == "$remote_tag" ]]; then
    log_info "Mieru already up-to-date ✓"
    return
  fi

  $DRY_RUN && { log_dry "Would update mita to $remote_tag"; return; }

  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$DEB_ARCH" \
    '.assets[] | select(.name | test("mita.*" + $arch + "\\.deb")) | .browser_download_url' \
    | head -1)

  [[ -z "$asset_url" ]] && { log_warn "No Mieru .deb for $DEB_ARCH"; return; }

  local deb; deb=$(mktemp /tmp/mieru-XXXXXX.deb)
  wget -q -O "$deb" "$asset_url"
  systemctl stop mita 2>/dev/null || true
  dpkg -i "$deb" 2>/dev/null || apt-get install -f -y
  rm -f "$deb"
  systemctl start mita
  log_info "Mieru updated to $remote_tag ✓"
}

# ── Update panel ──────────────────────────────────────────────────────────────
update_panel() {
  log_step "Updating web panel"
  $DRY_RUN && { log_dry "Would pull latest panel from $REPO_RAW"; return; }

  # Pull latest panel package.json and server
  local tmp; tmp=$(mktemp -d)
  git clone --depth 1 "https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX.git" "$tmp" 2>/dev/null || {
    log_warn "Could not clone latest panel — skipping panel update"
    rm -rf "$tmp"; return
  }

  if [[ -d "$tmp/panel" ]]; then
    pm2 stop panel-naive-mieru 2>/dev/null || true
    cp -r "$tmp/panel/"* "$PANEL_DIR/"
    cd "$PANEL_DIR" && npm install --production --silent && cd /
    pm2 restart panel-naive-mieru 2>/dev/null || \
      pm2 start "$PANEL_DIR/server/index.js" --name panel-naive-mieru --time
    log_info "Panel updated ✓"
  fi
  rm -rf "$tmp"
}

# ── Smoke tests ───────────────────────────────────────────────────────────────
smoke_test() {
  log_step "Running smoke tests"
  sleep 2

  local pass=0 fail=0

  check_svc() {
    if systemctl is-active --quiet "$1"; then
      echo -e "  ${GREEN}✓${NC} $1 active"; (( pass++ ))
    else
      echo -e "  ${RED}✗${NC} $1 INACTIVE"; (( fail++ ))
    fi
  }

  check_svc caddy-naive
  check_svc mita

  # caddy validate
  if "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Caddyfile valid"
    (( pass++ ))
  else
    echo -e "  ${RED}✗${NC} Caddyfile INVALID"
    (( fail++ ))
  fi

  # Panel HTTP
  if curl -sf http://127.0.0.1:3000/ -o /dev/null 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Panel HTTP :3000 OK"; (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  Panel :3000 not responding"
  fi

  # mita status
  if mita status 2>/dev/null | grep -qi "running\|active"; then
    echo -e "  ${GREEN}✓${NC} mita reports running"; (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  mita status unclear"
  fi

  echo ""
  echo -e "  Smoke: ${GREEN}$pass passed${NC}  ${RED}$fail failed${NC}"
  return $fail
}

# ── --status mode ─────────────────────────────────────────────────────────────
do_status() {
  echo -e "\n${BOLD}══════════════════════════════════════════${NC}"
  echo -e "${BOLD}   Panel Naive + Mieru — Status Report${NC}"
  echo -e "${BOLD}══════════════════════════════════════════${NC}\n"

  # Versions
  echo -e "${BOLD}Versions:${NC}"
  echo "  Panel:        $(get_current_version) (target: $TARGET_VERSION)"
  echo "  caddy-naive:  $($CADDY_BIN version 2>/dev/null | head -1 || echo 'not installed')"
  echo "  mita:         $(mita version 2>/dev/null | head -1 || echo 'not installed')"
  echo "  Node.js:      $(node --version 2>/dev/null || echo 'not installed')"
  echo "  PM2:          $(pm2 --version 2>/dev/null || echo 'not installed')"
  echo ""

  # Services
  echo -e "${BOLD}Services:${NC}"
  for svc in caddy-naive mita; do
    local status
    status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
    if [[ "$status" == "active" ]]; then
      echo -e "  ${GREEN}●${NC} $svc — active"
    else
      echo -e "  ${RED}●${NC} $svc — $status"
    fi
  done
  pm2_status=$(pm2 status panel-naive-mieru --no-color 2>/dev/null | grep panel-naive-mieru | awk '{print $10}' || echo "unknown")
  echo "  ● PM2 panel   — $pm2_status"
  echo ""

  # Config
  echo -e "${BOLD}Configuration:${NC}"
  if [[ -f "$PANEL_CONFIG" ]]; then
    jq '{ domain, serverIp, naivePort, mieruPortStart, mieruPortEnd, exposePanel, trafficPattern, mtu }' \
      "$PANEL_CONFIG" 2>/dev/null | sed 's/^/  /'
  else
    echo "  config.json NOT FOUND"
  fi
  echo ""

  # Ports
  echo -e "${BOLD}Listening ports:${NC}"
  ss -tlnup 2>/dev/null | grep -E ":(443|8443|3000|2012|2013|2014|2015|2016|2017|2018|2019|2020|2021|2022)" | \
    awk '{print "  "$5}' || true
  echo ""

  # Backups
  echo -e "${BOLD}Recent backups:${NC}"
  if [[ -d "$BACKUP_DIR" ]]; then
    ls -1dt "$BACKUP_DIR"/*/ 2>/dev/null | head -5 | while read -r d; do
      echo "  $(basename "$d")"
    done || echo "  (none)"
  else
    echo "  (none)"
  fi
  echo ""

  # Time
  echo -e "${BOLD}Time:${NC}"
  timedatectl status 2>/dev/null | grep -E "Local time|synchronized" | sed 's/^/  /' || true
  echo ""
}

# ── --expose mode ─────────────────────────────────────────────────────────────
do_expose() {
  log_step "Switching panel to public mode (expose)"
  [[ -z "$EXPOSE_DOMAIN" ]] && die "--expose requires a domain argument"

  $DRY_RUN && { log_dry "Would expose panel for domain $EXPOSE_DOMAIN"; return; }

  auto_backup >/dev/null

  jq --argjson v true '.exposePanel = $v' "$PANEL_CONFIG" > /tmp/cfg.tmp && \
    mv /tmp/cfg.tmp "$PANEL_CONFIG"

  # Add Caddy reverse proxy block for panel
  if ! grep -q "8080" "$CADDYFILE"; then
    cat >> "$CADDYFILE" <<EXPEOF

${EXPOSE_DOMAIN}:8080 {
  reverse_proxy 127.0.0.1:3000
}
EXPEOF
  fi

  # UFW
  ufw allow 8080/tcp comment "Panel Web UI" 2>/dev/null || true

  systemctl reload caddy-naive 2>/dev/null || systemctl restart caddy-naive
  pm2 restart panel-naive-mieru 2>/dev/null || true
  log_info "Panel now accessible at http://$EXPOSE_DOMAIN:8080/ ✓"
}

# ── --ssh-only mode ───────────────────────────────────────────────────────────
do_ssh_only() {
  log_step "Switching panel to SSH-only mode"

  $DRY_RUN && { log_dry "Would switch panel to 127.0.0.1:3000 (SSH-only)"; return; }

  auto_backup >/dev/null

  jq --argjson v false '.exposePanel = $v' "$PANEL_CONFIG" > /tmp/cfg.tmp && \
    mv /tmp/cfg.tmp "$PANEL_CONFIG"

  # Remove 8080 block from Caddyfile
  python3 - <<'PYEOF'
import re, sys
with open("/etc/caddy-naive/Caddyfile") as f:
    content = f.read()
# Remove any block matching :8080
content = re.sub(r'\n[^\n]*8080[^\n]*\{[^}]*\}', '', content, flags=re.DOTALL)
with open("/etc/caddy-naive/Caddyfile", "w") as f:
    f.write(content)
PYEOF

  ufw delete allow 8080/tcp 2>/dev/null || true
  systemctl reload caddy-naive 2>/dev/null || systemctl restart caddy-naive
  pm2 restart panel-naive-mieru 2>/dev/null || true
  log_info "Panel now SSH-only (127.0.0.1:3000) ✓"

  local server_ip; server_ip=$(jq -r '.serverIp' "$PANEL_CONFIG")
  echo ""
  echo -e "  SSH tunnel:  ${CYAN}ssh -L 3000:127.0.0.1:3000 root@$server_ip${NC}"
  echo -e "  Then open:   ${CYAN}http://localhost:3000/${NC}"
}

# ── --repair mode ─────────────────────────────────────────────────────────────
do_repair() {
  log_step "Repair mode — restoring from latest backup"

  local latest
  latest=$(ls -1dt "$BACKUP_DIR"/*/ 2>/dev/null | head -1)
  [[ -z "$latest" ]] && die "No backups found in $BACKUP_DIR"

  log_info "Using backup: $latest"

  if ! $YES; then
    read -rp "Restore from $latest? [y/N]: " confirm
    [[ "${confirm^^}" != "Y" ]] && { log_info "Aborted."; exit 0; }
  fi

  $DRY_RUN && { log_dry "Would rollback from $latest"; return; }

  rollback_from_backup "$latest"
  smoke_test || true
}

# ── Main update flow ──────────────────────────────────────────────────────────
do_update() {
  log_step "Updating Panel Naive + Mieru"
  detect_arch

  local current; current=$(get_current_version)
  log_info "Installed version: $current  |  Target: $TARGET_VERSION"

  if ! $FORCE && ! version_gt "$TARGET_VERSION" "$current"; then
    log_info "Already up-to-date ($current)"
    if ! $YES; then
      read -rp "Force update anyway? [y/N]: " confirm
      [[ "${confirm^^}" != "Y" ]] && { log_info "Nothing to do."; exit 0; }
    fi
  fi

  if ! $YES && ! $DRY_RUN; then
    read -rp "Proceed with update? [Y/n]: " confirm
    [[ "${confirm^^}" == "N" ]] && { log_info "Aborted."; exit 0; }
  fi

  auto_backup >/dev/null
  update_naiveproxy
  update_mieru
  update_panel

  $DRY_RUN && { log_info "[DRY-RUN] No changes were made."; return; }

  # Write new version
  echo "$TARGET_VERSION" > "$VERSION_FILE"
  log_info "Version file updated to $TARGET_VERSION ✓"

  smoke_test && log_info "Update completed successfully ✓" || \
    log_warn "Update completed with warnings — check services"
}

# ── Entry point ───────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  check_root

  case "$MODE" in
    status)   check_install; load_config; do_status ;;
    expose)   check_install; load_config; do_expose ;;
    ssh-only) check_install; load_config; do_ssh_only ;;
    repair)   check_install; load_config; do_repair ;;
    update)   check_install; load_config; do_update ;;
  esac
}

main "$@"
