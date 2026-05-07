#!/usr/bin/env bash
# ==============================================================================
# Panel Naive + Mieru by RIXXX — update.sh  v1.2.0
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
TARGET_VERSION="1.2.0"
PANEL_DIR="/opt/panel-naive-mieru"
PANEL_CONFIG="/etc/rixxx-panel/config.json"
VERSION_FILE="/etc/rixxx-panel/version"
BACKUP_DIR="/etc/rixxx-panel/backups"
DB_PATH="/var/lib/rixxx-panel/db.sqlite"
MITA_STATE_FILE="/var/lib/rixxx-panel/mita-state.json"

# Blocker 6: naive paths (replaces caddy-naive)
NAIVE_BIN="/usr/local/bin/naive"
NAIVE_CONFIG_DIR="/etc/naive"
NAIVE_CONFIG="${NAIVE_CONFIG_DIR}/config.json"
NAIVE_HTPASSWD="${NAIVE_CONFIG_DIR}/htpasswd"

NAIVE_RELEASES="https://api.github.com/repos/klzgrad/naiveproxy/releases/latest"
MIERU_RELEASES="https://api.github.com/repos/enfein/mieru/releases/latest"
REPO_RAW="https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main"

# ── Flags ─────────────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE=false
YES=false
MODE=""
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
${BOLD}Panel Naive + Mieru — update.sh  v${TARGET_VERSION}${NC}

USAGE:
  bash update.sh [options]

OPTIONS:
  (no flag)              Update all components to latest versions
  --dry-run              Show what would be done without making changes
  --force                Force update even if already on latest version
  -y / --yes             Non-interactive (auto-confirm all prompts)
  --expose <domain>      Switch panel to public mode on :8080
  --ssh-only             Switch panel back to SSH-tunnel-only (127.0.0.1:3000)
  --status               Print full health report
  --repair               Rebuild configs from SQLite DB; restart services
  --help                 Show this help

EXAMPLES:
  bash update.sh                   # Interactive update
  bash update.sh --dry-run         # Preview changes
  bash update.sh --force -y        # Force update, non-interactive
  bash update.sh --status          # Health check
  bash update.sh --repair          # Fix broken installation
  bash update.sh --expose vpn.example.com
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
  DOMAIN=$(jq -r '.domain'              "$PANEL_CONFIG")
  NAIVE_PORT=$(jq -r '.naivePort'       "$PANEL_CONFIG")
  MIERU_START=$(jq -r '.mieruPortStart' "$PANEL_CONFIG")
  MIERU_END=$(jq -r '.mieruPortEnd'     "$PANEL_CONFIG")
  EXPOSE=$(jq -r '.exposePanel'         "$PANEL_CONFIG")
  ADMIN_EMAIL=$(jq -r '.adminEmail'     "$PANEL_CONFIG")
}

# ── Backup ────────────────────────────────────────────────────────────────────
auto_backup() {
  local ts; ts=$(date +%Y-%m-%d-%H%M%S)
  local bdir="$BACKUP_DIR/$ts"

  $DRY_RUN && { log_dry "Would create backup at $bdir"; echo "$bdir"; return; }

  mkdir -p "$bdir"
  [[ -f "$NAIVE_CONFIG"                         ]] && cp "$NAIVE_CONFIG"   "$bdir/naive-config.json"
  [[ -f "$NAIVE_HTPASSWD"                       ]] && cp "$NAIVE_HTPASSWD" "$bdir/htpasswd"
  [[ -f "$MITA_STATE_FILE"                      ]] && cp "$MITA_STATE_FILE" "$bdir/mita-state.json"
  [[ -f "$PANEL_CONFIG"                         ]] && cp "$PANEL_CONFIG"   "$bdir/config.json"
  [[ -f /etc/systemd/system/naive.service       ]] && cp /etc/systemd/system/naive.service "$bdir/"
  [[ -f /etc/systemd/system/mita.service        ]] && cp /etc/systemd/system/mita.service  "$bdir/"
  # Legacy caddy files (kept for rollback safety)
  [[ -f /etc/caddy-naive/Caddyfile              ]] && cp /etc/caddy-naive/Caddyfile "$bdir/Caddyfile.old" || true

  log_info "Backup created: $bdir"

  local count; count=$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | wc -l)
  if (( count > 10 )); then
    ls -1dt "$BACKUP_DIR"/*/ | tail -n +11 | xargs rm -rf
    log_info "Old backups pruned (kept 10 most recent)"
  fi
  echo "$bdir"
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
  [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" && "$1" != "$2" ]]
}

get_current_version() {
  if [[ -f "$VERSION_FILE" ]]; then
    grep '^panel_version=' "$VERSION_FILE" 2>/dev/null | cut -d= -f2 || cat "$VERSION_FILE"
  else
    echo "0.0.0"
  fi
}

get_naive_version_file() {
  if [[ -f "$VERSION_FILE" ]]; then
    grep '^naive_version=' "$VERSION_FILE" 2>/dev/null | cut -d= -f2 || echo "unknown"
  else
    echo "unknown"
  fi
}

# ── Blocker 6: rebuild htpasswd from SQLite DB ────────────────────────────────
rebuild_htpasswd_from_db() {
  log_step "Rebuilding htpasswd from SQLite database"
  [[ ! -f "$DB_PATH" ]] && { log_warn "DB not found at $DB_PATH — skipping htpasswd rebuild"; return; }

  mkdir -p "$NAIVE_CONFIG_DIR"
  # Use Node to read DB and write htpasswd (bcrypt hashes already stored)
  node -e "
    const Database = require('better-sqlite3');
    const fs       = require('fs');
    const db       = new Database('$DB_PATH', { readonly: true });
    const users    = db.prepare(\"SELECT username, passHash FROM users\").all();
    const lines    = users.map(u => u.username + ':' + u.passHash).join('\n');
    fs.writeFileSync('$NAIVE_HTPASSWD', lines + (lines ? '\n' : ''), { mode: 0o640 });
    console.log('[htpasswd] wrote', users.length, 'user(s)');
    db.close();
  " 2>/dev/null || {
    log_warn "Node htpasswd rebuild failed — htpasswd will be empty until panel rewrites it"
    : > "$NAIVE_HTPASSWD"
    chmod 640 "$NAIVE_HTPASSWD"
  }
  log_info "htpasswd rebuilt ✓"
}

# ── Blocker 6: rebuild naive config.json from panel config ───────────────────
rebuild_naive_config() {
  log_step "Rebuilding naive config.json"
  [[ ! -f "$PANEL_CONFIG" ]] && { log_warn "Panel config not found — skipping naive config rebuild"; return; }

  mkdir -p "$NAIVE_CONFIG_DIR" /var/log/naive
  local naive_port; naive_port=$(jq -r '.naivePort // 443' "$PANEL_CONFIG")
  local domain;     domain=$(jq -r '.domain // "localhost"' "$PANEL_CONFIG")

  # Check for existing cert paths
  local tls_block=""
  local le_cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
  local le_key="/etc/letsencrypt/live/${domain}/privkey.pem"
  if [[ -f "$le_cert" ]]; then
    tls_block=",
  \"cert\": \"${le_cert}\",
  \"key\":  \"${le_key}\""
  fi

  cat > "$NAIVE_CONFIG" <<NAIVECFG
{
  "listen": "https://:${naive_port}",
  "name":   "${domain}",
  "auth":   "${NAIVE_HTPASSWD}",
  "padding": true,
  "log":    "/var/log/naive/access.log"${tls_block}
}
NAIVECFG
  chmod 640 "$NAIVE_CONFIG"
  log_info "naive config.json rebuilt ✓"
}

# ── Blocker 6: rebuild mita state from SQLite + panel config ─────────────────
rebuild_mita_state() {
  log_step "Rebuilding mita-state.json from database"
  [[ ! -f "$DB_PATH" ]] && { log_warn "DB not found — skipping mita state rebuild"; return; }

  node -e "
    const Database = require('better-sqlite3');
    const fs       = require('fs');
    const db       = new Database('$DB_PATH', { readonly: true });
    const cfg      = JSON.parse(fs.readFileSync('$PANEL_CONFIG', 'utf8'));
    const users    = db.prepare(\"SELECT username, password, protocols FROM users\").all()
      .filter(u => { try { return JSON.parse(u.protocols || '[]').includes('mieru'); } catch { return true; } })
      .map(u => ({ name: u.username, password: u.password || '' }));

    const portBindings = [];
    for (let p = cfg.mieruPortStart; p <= cfg.mieruPortEnd; p++) {
      portBindings.push({ port: p, protocol: 'TCP' });
      if (cfg.udpEnabled) portBindings.push({ port: p, protocol: 'UDP' });
    }

    const state = { portBindings, users, loggingLevel: 'INFO', mtu: cfg.mtu || 1400 };
    const pat = cfg.trafficPattern || 'NOOP';
    if (pat !== 'NOOP') {
      const patMap = {
        RANDOM_PADDING:            { seed: true,  tcpFragment: false, nonce: false },
        RANDOM_PADDING_AGGRESSIVE: { seed: true,  tcpFragment: true,  nonce: true  },
        CUSTOM:                    { seed: true,  tcpFragment: true,  nonce: true  }
      };
      if (patMap[pat]) state.trafficPattern = patMap[pat];
    }

    fs.writeFileSync('$MITA_STATE_FILE', JSON.stringify(state, null, 2), { mode: 0o600 });
    console.log('[mita-state] wrote', users.length, 'user(s)');
    db.close();
  " 2>/dev/null || {
    log_warn "Node mita state rebuild failed"
    return 1
  }
  log_info "mita-state.json rebuilt ✓"
}

# ── Ensure naive.service exists (migration from caddy-naive) ──────────────────
ensure_naive_service() {
  if [[ ! -f /etc/systemd/system/naive.service ]]; then
    log_step "Creating naive.service (migration from caddy-naive)"
    local naive_bin="${NAIVE_BIN}"
    cat > /etc/systemd/system/naive.service <<SVCEOF
[Unit]
Description=NaiveProxy Server
Documentation=https://github.com/klzgrad/naiveproxy
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=simple
User=root
ExecStart=${naive_bin} ${NAIVE_CONFIG}
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
SVCEOF
    systemctl daemon-reload
    systemctl enable naive 2>/dev/null || true
  fi

  # Disable/remove old caddy-naive if present
  if systemctl is-enabled caddy-naive &>/dev/null 2>&1; then
    systemctl stop    caddy-naive 2>/dev/null || true
    systemctl disable caddy-naive 2>/dev/null || true
    log_info "caddy-naive.service disabled (replaced by naive.service)"
  fi
}

# ── Update NaiveProxy ─────────────────────────────────────────────────────────
update_naiveproxy() {
  log_step "Checking NaiveProxy update"
  detect_arch

  local release_json
  release_json=$(curl -fsSL "$NAIVE_RELEASES") || { log_warn "Cannot reach GitHub API for NaiveProxy"; return; }

  local remote_tag; remote_tag=$(echo "$release_json" | jq -r '.tag_name')
  local current_ver; current_ver=$("$NAIVE_BIN" --version 2>/dev/null | head -1 || get_naive_version_file)
  log_info "Current: $current_ver  |  Latest: $remote_tag"

  if ! $FORCE && echo "$current_ver" | grep -qF "${remote_tag#v}"; then
    log_info "NaiveProxy already up-to-date ✓"
    return
  fi

  $DRY_RUN && { log_dry "Would update naive to $remote_tag"; return; }

  # Strict arch match (same as install.sh)
  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$NAIVE_ARCH" \
    '.assets[] | select(.name | endswith("-" + $arch + ".tar.xz")) | .browser_download_url' \
    | head -1)
  if [[ -z "$asset_url" ]]; then
    asset_url=$(echo "$release_json" | jq -r \
      --arg arch "$NAIVE_ARCH" \
      '.assets[] | select((.name | endswith("-" + $arch + ".tar.gz")) or (.name | endswith("-" + $arch + ".zip"))) | .browser_download_url' \
      | head -1)
  fi
  [[ -z "$asset_url" ]] && { log_warn "No NaiveProxy asset found for $NAIVE_ARCH"; return; }

  local tmp_dir; tmp_dir=$(mktemp -d)
  local archive_name; archive_name=$(basename "$asset_url")
  wget -q -O "$tmp_dir/$archive_name" "$asset_url"
  cd "$tmp_dir"
  [[ "$archive_name" == *.tar.xz ]] && tar -xJf "$archive_name"
  [[ "$archive_name" == *.tar.gz ]] && tar -xzf "$archive_name"
  [[ "$archive_name" == *.zip    ]] && unzip -q  "$archive_name"

  local naive_bin_found
  naive_bin_found=$(find "$tmp_dir" -type f -name "naive"      ! -name "*.xz" ! -name "*.gz" | head -1)
  [[ -z "$naive_bin_found" ]] && \
  naive_bin_found=$(find "$tmp_dir" -type f -name "naiveproxy" ! -name "*.xz" ! -name "*.gz" | head -1)
  [[ -n "$naive_bin_found" ]] && install -m 755 "$naive_bin_found" "$NAIVE_BIN"
  rm -rf "$tmp_dir"; cd /

  systemctl restart naive 2>/dev/null || true

  # Update version file
  if [[ -f "$VERSION_FILE" ]]; then
    local new_ver; new_ver=$("$NAIVE_BIN" --version 2>/dev/null | head -1 || echo "$remote_tag")
    # Replace naive_version line
    sed -i "s|^naive_version=.*|naive_version=${new_ver}|" "$VERSION_FILE" 2>/dev/null || \
      echo "naive_version=${new_ver}" >> "$VERSION_FILE"
  fi

  log_info "NaiveProxy updated to $remote_tag ✓"
}

# ── Update Mieru ──────────────────────────────────────────────────────────────
update_mieru() {
  log_step "Checking Mieru update"
  detect_arch

  local release_json
  release_json=$(curl -fsSL "$MIERU_RELEASES") || { log_warn "Cannot reach GitHub API for Mieru"; return; }

  local remote_tag; remote_tag=$(echo "$release_json" | jq -r '.tag_name')
  local current_ver; current_ver=$(mita version 2>/dev/null | grep -oP 'v[\d.]+' | head -1 || echo "none")
  log_info "Current: $current_ver  |  Latest: $remote_tag"

  if ! $FORCE && [[ "$current_ver" == "$remote_tag" ]]; then
    log_info "Mieru already up-to-date ✓"
    return
  fi

  $DRY_RUN && { log_dry "Would update mita to $remote_tag"; return; }

  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$DEB_ARCH" \
    '.assets[] | select(.name | test("mita.*" + $arch + "\\.deb")) | .browser_download_url' | head -1)
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
  sleep 3

  local pass=0 fail=0

  check_svc() {
    if systemctl is-active --quiet "$1"; then
      echo -e "  ${GREEN}✓${NC} $1 active"; (( pass++ ))
    else
      echo -e "  ${RED}✗${NC} $1 INACTIVE"; (( fail++ ))
    fi
  }

  check_svc naive
  check_svc mita

  # Blocker 5: naive --version instead of caddy validate
  if "$NAIVE_BIN" --version &>/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} naive --version OK"; (( pass++ ))
  else
    echo -e "  ${RED}✗${NC} naive --version FAILED"; (( fail++ ))
  fi

  # Naive config present
  if [[ -f "$NAIVE_CONFIG" ]]; then
    echo -e "  ${GREEN}✓${NC} naive config.json present"; (( pass++ ))
  else
    echo -e "  ${RED}✗${NC} naive config.json MISSING"; (( fail++ ))
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
  echo -e "${BOLD}   Panel Naive + Mieru v${TARGET_VERSION} — Status Report${NC}"
  echo -e "${BOLD}══════════════════════════════════════════${NC}\n"

  # Versions
  echo -e "${BOLD}Versions:${NC}"
  echo "  Panel:        $(get_current_version) (target: $TARGET_VERSION)"
  echo "  naive:        $("$NAIVE_BIN" --version 2>/dev/null | head -1 || echo 'not installed')"
  echo "  mita:         $(mita version 2>/dev/null | head -1 || echo 'not installed')"
  echo "  Node.js:      $(node --version 2>/dev/null || echo 'not installed')"
  echo "  PM2:          $(pm2 --version 2>/dev/null || echo 'not installed')"
  echo ""

  # Version file details
  if [[ -f "$VERSION_FILE" ]]; then
    echo -e "${BOLD}Version file ($VERSION_FILE):${NC}"
    sed 's/^/  /' "$VERSION_FILE"
    echo ""
  fi

  # Services
  echo -e "${BOLD}Services:${NC}"
  for svc in naive mita; do
    local status; status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
    if [[ "$status" == "active" ]]; then
      echo -e "  ${GREEN}●${NC} $svc — active"
    else
      echo -e "  ${RED}●${NC} $svc — $status"
    fi
  done
  # Legacy caddy-naive check
  local caddy_status; caddy_status=$(systemctl is-active caddy-naive 2>/dev/null || echo "not installed")
  if [[ "$caddy_status" == "active" ]]; then
    echo -e "  ${YELLOW}●${NC} caddy-naive — active (legacy, should be replaced by naive.service)"
  fi
  local pm2_status; pm2_status=$(pm2 status panel-naive-mieru --no-color 2>/dev/null | grep panel-naive-mieru | awk '{print $10}' || echo "unknown")
  echo "  ● PM2 panel   — $pm2_status"
  echo ""

  # Config
  echo -e "${BOLD}Configuration:${NC}"
  if [[ -f "$PANEL_CONFIG" ]]; then
    jq '{ domain, serverIp, naivePort, mieruPortStart, mieruPortEnd, exposePanel, trafficPattern, mtu, udpEnabled }' \
      "$PANEL_CONFIG" 2>/dev/null | sed 's/^/  /'
  else
    echo "  config.json NOT FOUND"
  fi
  echo ""

  # Naive config
  echo -e "${BOLD}NaiveProxy config (${NAIVE_CONFIG}):${NC}"
  if [[ -f "$NAIVE_CONFIG" ]]; then
    jq '{ listen, name, auth, padding }' "$NAIVE_CONFIG" 2>/dev/null | sed 's/^/  /' || \
      sed 's/^/  /' "$NAIVE_CONFIG"
  else
    echo "  naive config.json NOT FOUND"
  fi
  echo ""

  # Ports
  echo -e "${BOLD}Listening ports:${NC}"
  ss -tlnup 2>/dev/null | grep -E ":(443|80|8080|3000|20[0-9]{2})" | \
    awk '{print "  "$5}' || true
  echo ""

  # htpasswd user count
  echo -e "${BOLD}htpasswd users:${NC}"
  if [[ -f "$NAIVE_HTPASSWD" ]]; then
    echo "  $(wc -l < "$NAIVE_HTPASSWD") user(s) in $NAIVE_HTPASSWD"
  else
    echo "  htpasswd NOT FOUND"
  fi
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

  # Time sync
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

  # Open UFW port 8080
  ufw allow 8080/tcp comment "Panel Web UI" 2>/dev/null || true

  pm2 restart panel-naive-mieru 2>/dev/null || true
  log_info "Panel accessible at http://$EXPOSE_DOMAIN:8080/ (direct via PM2) ✓"
  log_info "Or use an nginx/caddy reverse proxy for HTTPS on :8080"
}

# ── --ssh-only mode ───────────────────────────────────────────────────────────
do_ssh_only() {
  log_step "Switching panel to SSH-only mode"

  $DRY_RUN && { log_dry "Would switch panel to 127.0.0.1:3000 (SSH-only)"; return; }

  auto_backup >/dev/null

  jq --argjson v false '.exposePanel = $v' "$PANEL_CONFIG" > /tmp/cfg.tmp && \
    mv /tmp/cfg.tmp "$PANEL_CONFIG"

  ufw delete allow 8080/tcp 2>/dev/null || true
  pm2 restart panel-naive-mieru 2>/dev/null || true
  log_info "Panel now SSH-only (127.0.0.1:3000) ✓"

  local server_ip; server_ip=$(jq -r '.serverIp' "$PANEL_CONFIG")
  echo ""
  echo -e "  SSH tunnel:  ${CYAN}ssh -L 3000:127.0.0.1:3000 root@$server_ip${NC}"
  echo -e "  Then open:   ${CYAN}http://localhost:3000/${NC}"
}

# ── --repair mode (Blocker 6) ─────────────────────────────────────────────────
# Rebuild ALL configs from SQLite DB; no data loss
do_repair() {
  log_step "Repair mode — rebuilding configs from SQLite database"

  if ! $YES; then
    read -rp "Rebuild naive config, htpasswd and mita state from DB? [y/N]: " confirm
    [[ "${confirm^^}" != "Y" ]] && { log_info "Aborted."; exit 0; }
  fi

  $DRY_RUN && { log_dry "Would rebuild all configs from $DB_PATH"; return; }

  auto_backup >/dev/null

  # Step 1: Rebuild htpasswd (bcrypt hashes from DB)
  rebuild_htpasswd_from_db

  # Step 2: Rebuild naive config.json
  rebuild_naive_config

  # Step 3: Rebuild mita-state.json
  rebuild_mita_state && \
    mita apply config "$MITA_STATE_FILE" 2>/dev/null || \
    log_warn "mita apply returned non-zero — check: mita status"

  # Step 4: Ensure naive.service is present
  ensure_naive_service

  # Step 5: Restart services
  systemctl daemon-reload
  systemctl restart naive 2>/dev/null && log_info "naive restarted ✓" || \
    log_warn "naive restart failed — journalctl -u naive -n 20"
  systemctl restart mita  2>/dev/null && log_info "mita restarted ✓" || \
    log_warn "mita restart failed — journalctl -u mita -n 20"
  pm2 restart panel-naive-mieru 2>/dev/null || true

  smoke_test || log_warn "Some smoke tests failed — check above"
  log_info "Repair complete ✓"
}

# ── Main update flow ──────────────────────────────────────────────────────────
do_update() {
  log_step "Updating Panel Naive + Mieru to v${TARGET_VERSION}"
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

  # Ensure naive.service exists after update (migration)
  ensure_naive_service

  $DRY_RUN && { log_info "[DRY-RUN] No changes were made."; return; }

  # Update version file
  if [[ -f "$VERSION_FILE" ]]; then
    sed -i "s|^panel_version=.*|panel_version=${TARGET_VERSION}|" "$VERSION_FILE" 2>/dev/null || \
      echo "panel_version=${TARGET_VERSION}" >> "$VERSION_FILE"
  else
    echo "panel_version=${TARGET_VERSION}" > "$VERSION_FILE"
  fi
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
