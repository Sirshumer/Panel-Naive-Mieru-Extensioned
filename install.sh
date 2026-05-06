#!/usr/bin/env bash
# ==============================================================================
# Panel Naive + Mieru by RIXXX — install.sh
# Supports: Ubuntu 20.04/22.04/24.04, Debian 11/12 | x86_64, ARM64
# ==============================================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }
die()       { log_error "$*"; exit 1; }

# ── Constants ─────────────────────────────────────────────────────────────────
PANEL_DIR="/opt/panel-naive-mieru"
PANEL_CONFIG="/etc/rixxx-panel/config.json"
VERSION_FILE="/etc/rixxx-panel/version"
BACKUP_DIR="/etc/rixxx-panel/backups"
DB_PATH="/var/lib/rixxx-panel/db.sqlite"
CADDYFILE="/etc/caddy-naive/Caddyfile"
MITA_CONFIG_DIR="/etc/mita"
CADDY_BIN="/usr/local/bin/caddy-naive"
CURRENT_VERSION="1.0.0"
REPO_URL="https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX"
NAIVE_RELEASES="https://api.github.com/repos/klzgrad/naiveproxy/releases/latest"
MIERU_RELEASES="https://api.github.com/repos/enfein/mieru/releases/latest"

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "This script must be run as root (sudo bash install.sh)"

# ── OS check ──────────────────────────────────────────────────────────────────
check_os() {
  log_step "Checking OS compatibility"
  if [[ ! -f /etc/os-release ]]; then
    die "Cannot determine OS. Only Ubuntu/Debian are supported."
  fi
  source /etc/os-release
  case "$ID" in
    ubuntu)
      case "$VERSION_ID" in
        20.04|22.04|24.04) log_info "OS: Ubuntu $VERSION_ID ✓" ;;
        *) die "Unsupported Ubuntu version: $VERSION_ID (supported: 20.04, 22.04, 24.04)" ;;
      esac
      ;;
    debian)
      case "$VERSION_ID" in
        11|12) log_info "OS: Debian $VERSION_ID ✓" ;;
        *) die "Unsupported Debian version: $VERSION_ID (supported: 11, 12)" ;;
      esac
      ;;
    *) die "Unsupported OS: $ID. Only Ubuntu and Debian are supported." ;;
  esac
}

# ── Architecture detection ────────────────────────────────────────────────────
detect_arch() {
  log_step "Detecting system architecture"
  local machine
  machine=$(uname -m)
  case "$machine" in
    x86_64|amd64)   ARCH="amd64";  ARCH_ALT="x86_64";  DEB_ARCH="amd64"  ;;
    aarch64|arm64)  ARCH="arm64";  ARCH_ALT="aarch64"; DEB_ARCH="arm64"  ;;
    armv7l)         ARCH="armv7";  ARCH_ALT="armv7l";  DEB_ARCH="armhf"  ;;
    *) die "Unsupported architecture: $machine (supported: x86_64, aarch64, armv7l)" ;;
  esac
  log_info "Architecture: $machine → $ARCH ✓"
}

# ── NTP sync ──────────────────────────────────────────────────────────────────
sync_time() {
  log_step "Synchronising system time (NTP)"
  timedatectl set-ntp true 2>/dev/null || true
  # Wait up to 10 s for sync
  for i in $(seq 1 10); do
    if timedatectl status 2>/dev/null | grep -q "synchronized: yes"; then
      log_info "Time synchronised ✓"
      return
    fi
    sleep 1
  done
  log_warn "Time sync not confirmed within 10 s — continuing anyway"
}

# ── Package dependencies ───────────────────────────────────────────────────────
install_deps() {
  log_step "Installing system dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    curl wget git ufw unzip tar gzip jq \
    ca-certificates gnupg lsb-release \
    systemd cron net-tools iproute2 \
    shred coreutils 2>/dev/null || \
  apt-get install -y \
    curl wget git ufw unzip tar gzip jq \
    ca-certificates gnupg lsb-release \
    systemd cron net-tools iproute2
  log_info "Dependencies installed ✓"
}

# ── Node.js 20 + PM2 ──────────────────────────────────────────────────────────
install_nodejs() {
  log_step "Installing Node.js 20 LTS"
  if command -v node &>/dev/null && node --version | grep -q "^v2[0-9]"; then
    log_info "Node.js $(node --version) already installed ✓"
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    log_info "Node.js $(node --version) installed ✓"
  fi

  if command -v pm2 &>/dev/null; then
    log_info "PM2 $(pm2 --version) already installed ✓"
  else
    npm install -g pm2 --silent
    log_info "PM2 installed ✓"
  fi
}

# ── NaiveProxy (caddy-naive binary) ──────────────────────────────────────────
install_naiveproxy() {
  log_step "Installing NaiveProxy (caddy-naive)"

  # Map arch to naiveproxy release filename suffix
  case "$ARCH" in
    amd64) NAIVE_ARCH="linux-amd64"    ;;
    arm64) NAIVE_ARCH="linux-arm64"    ;;
    armv7) NAIVE_ARCH="linux-arm"      ;;
  esac

  log_info "Fetching latest NaiveProxy release info..."
  local release_json
  release_json=$(curl -fsSL "$NAIVE_RELEASES" 2>/dev/null) || \
    die "Cannot fetch NaiveProxy releases from GitHub API"

  local tag
  tag=$(echo "$release_json" | jq -r '.tag_name')
  log_info "Latest NaiveProxy: $tag"

  # Find the caddy asset for this arch (pattern: naiveproxy-<tag>-linux-<arch>.tar.xz or .tar.gz or .zip)
  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$NAIVE_ARCH" \
    '.assets[] | select(.name | test("naiveproxy-.*" + $arch)) | select(.name | test("\\.tar\\.xz|\\.tar\\.gz|\\.zip")) | .browser_download_url' \
    | head -1)

  if [[ -z "$asset_url" ]]; then
    # Fallback: try without arch prefix in asset name
    asset_url=$(echo "$release_json" | jq -r \
      '.assets[] | select(.name | test("linux")) | .browser_download_url' | head -1)
  fi

  [[ -z "$asset_url" ]] && die "Could not find NaiveProxy asset for $NAIVE_ARCH"

  log_info "Downloading: $asset_url"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  local archive_name
  archive_name=$(basename "$asset_url")
  wget -q --show-progress -O "$tmp_dir/$archive_name" "$asset_url" || \
    die "Failed to download NaiveProxy binary"

  # Extract
  cd "$tmp_dir"
  if [[ "$archive_name" == *.tar.xz ]]; then
    tar -xJf "$archive_name"
  elif [[ "$archive_name" == *.tar.gz ]]; then
    tar -xzf "$archive_name"
  elif [[ "$archive_name" == *.zip ]]; then
    unzip -q "$archive_name"
  fi

  # Find caddy binary inside extracted folder
  local caddy_bin
  caddy_bin=$(find "$tmp_dir" -type f -name "caddy*" ! -name "*.xz" ! -name "*.gz" ! -name "*.zip" | head -1)
  [[ -z "$caddy_bin" ]] && die "caddy binary not found in NaiveProxy archive"

  install -m 755 "$caddy_bin" "$CADDY_BIN"
  rm -rf "$tmp_dir"
  cd /

  # Store version
  NAIVE_VERSION=$("$CADDY_BIN" version 2>/dev/null | head -1 || echo "$tag")
  log_info "caddy-naive installed at $CADDY_BIN  ($NAIVE_VERSION) ✓"
}

# ── Mieru (mita) ──────────────────────────────────────────────────────────────
install_mieru() {
  log_step "Installing Mieru (mita)"

  log_info "Fetching latest Mieru release info..."
  local release_json
  release_json=$(curl -fsSL "$MIERU_RELEASES" 2>/dev/null) || \
    die "Cannot fetch Mieru releases from GitHub API"

  local tag
  tag=$(echo "$release_json" | jq -r '.tag_name')
  log_info "Latest Mieru: $tag"

  # Find .deb asset matching architecture
  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$DEB_ARCH" \
    '.assets[] | select(.name | test("mita.*" + $arch + "\\.deb")) | .browser_download_url' \
    | head -1)

  if [[ -z "$asset_url" ]]; then
    asset_url=$(echo "$release_json" | jq -r \
      --arg arch "$DEB_ARCH" \
      '.assets[] | select(.name | test($arch + "\\.deb")) | .browser_download_url' \
      | head -1)
  fi

  [[ -z "$asset_url" ]] && die "Could not find Mieru .deb for $DEB_ARCH"

  log_info "Downloading: $asset_url"
  local deb_file
  deb_file=$(mktemp /tmp/mieru-XXXXXX.deb)
  wget -q --show-progress -O "$deb_file" "$asset_url" || \
    die "Failed to download Mieru .deb"

  dpkg -i "$deb_file" 2>/dev/null || apt-get install -f -y
  rm -f "$deb_file"

  MIERU_VERSION=$(mita version 2>/dev/null | grep -oP 'v[\d.]+' | head -1 || echo "$tag")
  log_info "mita installed  ($MIERU_VERSION) ✓"
}

# ── Interactive prompts ───────────────────────────────────────────────────────
gather_config() {
  log_step "Configuration"

  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}   Panel Naive + Mieru — Setup Wizard${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
  echo ""

  # Domain
  read -rp "$(echo -e "${CYAN}Domain / hostname${NC} (e.g. vpn.example.com): ")" INPUT_DOMAIN
  [[ -z "$INPUT_DOMAIN" ]] && die "Domain cannot be empty"
  DOMAIN="$INPUT_DOMAIN"

  # Email for TLS
  read -rp "$(echo -e "${CYAN}Email for TLS cert${NC} (e.g. admin@example.com): ")" INPUT_EMAIL
  [[ -z "$INPUT_EMAIL" ]] && die "Email cannot be empty"
  ADMIN_EMAIL="$INPUT_EMAIL"

  # NaiveProxy port
  read -rp "$(echo -e "${CYAN}NaiveProxy HTTPS port${NC} [default: 443]: ")" INPUT_NAIVE_PORT
  NAIVE_PORT="${INPUT_NAIVE_PORT:-443}"
  if ! [[ "$NAIVE_PORT" =~ ^[0-9]+$ ]] || (( NAIVE_PORT < 1 || NAIVE_PORT > 65535 )); then
    die "Invalid port: $NAIVE_PORT"
  fi

  # Mieru port range
  echo ""
  echo -e "${YELLOW}Mieru uses a port range (UDP). Default: 2012-2022${NC}"
  read -rp "$(echo -e "${CYAN}Mieru start port${NC} [default: 2012]: ")" INPUT_MIERU_START
  MIERU_PORT_START="${INPUT_MIERU_START:-2012}"
  read -rp "$(echo -e "${CYAN}Mieru end port${NC}   [default: 2022]: ")" INPUT_MIERU_END
  MIERU_PORT_END="${INPUT_MIERU_END:-2022}"

  for p in "$MIERU_PORT_START" "$MIERU_PORT_END"; do
    if ! [[ "$p" =~ ^[0-9]+$ ]] || (( p < 1025 || p > 65535 )); then
      die "Invalid Mieru port: $p (must be 1025-65535)"
    fi
  done
  (( MIERU_PORT_END < MIERU_PORT_START )) && \
    die "Mieru end port ($MIERU_PORT_END) must be >= start port ($MIERU_PORT_START)"

  # Admin credentials
  echo ""
  read -rp "$(echo -e "${CYAN}Panel admin username${NC} [default: admin]: ")" INPUT_ADMIN_USER
  ADMIN_USER="${INPUT_ADMIN_USER:-admin}"

  read -rsp "$(echo -e "${CYAN}Panel admin password${NC} (leave blank to auto-generate): ")" INPUT_ADMIN_PASS
  echo ""
  if [[ -z "$INPUT_ADMIN_PASS" ]]; then
    ADMIN_PASS=$(tr -dc 'A-Za-z0-9@#%^&' </dev/urandom | head -c 20)
    log_info "Generated admin password: ${BOLD}$ADMIN_PASS${NC}"
  else
    ADMIN_PASS="$INPUT_ADMIN_PASS"
  fi

  # UFW setup
  echo ""
  read -rp "$(echo -e "${CYAN}Configure UFW firewall?${NC} [Y/n]: ")" INPUT_UFW
  USE_UFW="${INPUT_UFW:-Y}"

  # Panel expose mode
  echo ""
  echo -e "${YELLOW}Panel runs on 127.0.0.1:3000 (SSH-only by default).${NC}"
  read -rp "$(echo -e "${CYAN}Expose panel publicly via Caddy on port 8080?${NC} [y/N]: ")" INPUT_EXPOSE
  EXPOSE_PANEL="${INPUT_EXPOSE:-N}"

  echo ""
  log_info "Configuration gathered ✓"
}

# ── Caddy-naive Caddyfile ─────────────────────────────────────────────────────
write_caddyfile() {
  log_step "Writing Caddyfile"
  mkdir -p /etc/caddy-naive
  mkdir -p /var/log/caddy-naive

  cat > "$CADDYFILE" <<CADDYEOF
{
  order forward_proxy before file_server
  admin off
  log {
    output file /var/log/caddy-naive/access.log {
      roll_size 50mb
      roll_keep 5
    }
  }
}

:${NAIVE_PORT}, ${DOMAIN}:${NAIVE_PORT} {
  tls ${ADMIN_EMAIL}
  route {
    forward_proxy {
      basic_auth dummy_placeholder placeholder_pass_$(tr -dc 'a-z0-9' </dev/urandom | head -c 8)
      hide_ip
      hide_via
      probe_resistance secret_$(tr -dc 'a-z0-9' </dev/urandom | head -c 12)
    }
    file_server {
      root /var/www/html
    }
  }
}
CADDYEOF
  log_info "Caddyfile written to $CADDYFILE ✓"
}

# ── Mieru (mita) base config ──────────────────────────────────────────────────
write_mita_config() {
  log_step "Writing Mieru server config"
  mkdir -p "$MITA_CONFIG_DIR"

  # Build portBindings array for the port range
  local bindings=""
  for (( port=MIERU_PORT_START; port<=MIERU_PORT_END; port++ )); do
    bindings+="    {\"port\": $port, \"protocol\": \"TCP\"},"$'\n'
    bindings+="    {\"port\": $port, \"protocol\": \"UDP\"},"$'\n'
  done
  # Remove trailing comma
  bindings="${bindings%,*}"
  bindings="${bindings%,$'\n'}"

  cat > "$MITA_CONFIG_DIR/server.json" <<MIERUEOF
{
  "portBindings": [
$(echo "$bindings" | sed '$ s/,$//')
  ],
  "users": [],
  "loggingLevel": "INFO",
  "mtu": 1350,
  "trafficConfig": {
    "pattern": "NOOP"
  }
}
MIERUEOF
  log_info "Mieru config written to $MITA_CONFIG_DIR/server.json ✓"
}

# ── Systemd unit: caddy-naive ─────────────────────────────────────────────────
write_caddy_service() {
  cat > /etc/systemd/system/caddy-naive.service <<SVCEOF
[Unit]
Description=Caddy NaiveProxy Server
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
Group=root
ExecStart=${CADDY_BIN} run --config ${CADDYFILE} --adapter caddyfile
ExecReload=${CADDY_BIN} reload --config ${CADDYFILE} --adapter caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
}

# ── Systemd unit: mita ────────────────────────────────────────────────────────
write_mita_service() {
  # mita installs its own service via .deb; ensure it is enabled
  if [[ -f /lib/systemd/system/mita.service ]] || \
     [[ -f /etc/systemd/system/mita.service ]]; then
    log_info "mita.service already present"
  else
    cat > /etc/systemd/system/mita.service <<MITSVC
[Unit]
Description=Mieru Proxy Server (mita)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/mita run
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
MITSVC
  fi
}

# ── UFW ───────────────────────────────────────────────────────────────────────
setup_ufw() {
  log_step "Configuring UFW firewall"
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow ssh
  ufw allow "${NAIVE_PORT}/tcp" comment "NaiveProxy HTTPS"
  ufw allow "${MIERU_PORT_START}:${MIERU_PORT_END}/tcp" comment "Mieru TCP"
  ufw allow "${MIERU_PORT_START}:${MIERU_PORT_END}/udp" comment "Mieru UDP"

  if [[ "${EXPOSE_PANEL^^}" == "Y" ]]; then
    ufw allow 8080/tcp comment "Panel Web UI"
  fi

  ufw --force enable
  log_info "UFW rules applied ✓"
}

# ── Panel installation ────────────────────────────────────────────────────────
install_panel() {
  log_step "Installing web panel"
  mkdir -p "$PANEL_DIR"

  # Copy panel files from installer location (same repo)
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [[ -d "$script_dir/panel" ]]; then
    cp -r "$script_dir/panel/"* "$PANEL_DIR/"
    log_info "Panel files copied from $script_dir/panel ✓"
  else
    log_warn "Panel source not found at $script_dir/panel — cloning from repo..."
    git clone --depth 1 "$REPO_URL" /tmp/panel-src 2>/dev/null || \
      die "Failed to clone panel source"
    cp -r /tmp/panel-src/panel/* "$PANEL_DIR/"
    rm -rf /tmp/panel-src
  fi

  # Install npm dependencies
  cd "$PANEL_DIR"
  npm install --production --silent
  log_info "Panel npm dependencies installed ✓"
  cd /
}

# ── Config JSON ───────────────────────────────────────────────────────────────
write_config_json() {
  log_step "Writing /etc/rixxx-panel/config.json"
  mkdir -p /etc/rixxx-panel
  mkdir -p "$(dirname "$DB_PATH")"

  local server_ip
  server_ip=$(curl -4 -fsSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

  cat > "$PANEL_CONFIG" <<CFGJSON
{
  "domain": "${DOMAIN}",
  "serverIp": "${server_ip}",
  "adminEmail": "${ADMIN_EMAIL}",
  "adminUser": "${ADMIN_USER}",
  "adminPassHash": "$(echo -n "$ADMIN_PASS" | sha256sum | awk '{print $1}')",
  "naivePort": ${NAIVE_PORT},
  "mieruPortStart": ${MIERU_PORT_START},
  "mieruPortEnd": ${MIERU_PORT_END},
  "panelPort": 3000,
  "panelHost": "127.0.0.1",
  "exposePanel": $(echo "${EXPOSE_PANEL^^}" | grep -q "^Y" && echo true || echo false),
  "useUfw": $(echo "${USE_UFW^^}" | grep -q "^Y" && echo true || echo false),
  "dbPath": "${DB_PATH}",
  "caddyfile": "${CADDYFILE}",
  "mitaConfigDir": "${MITA_CONFIG_DIR}",
  "trafficPattern": "NOOP",
  "mtu": 1350,
  "version": "${CURRENT_VERSION}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
CFGJSON

  chmod 600 "$PANEL_CONFIG"
  log_info "config.json written ✓"
}

# ── Version file ──────────────────────────────────────────────────────────────
write_version() {
  mkdir -p /etc/rixxx-panel
  echo "$CURRENT_VERSION" > "$VERSION_FILE"
  log_info "Version file written: $CURRENT_VERSION ✓"
}

# ── Start / enable services ───────────────────────────────────────────────────
start_services() {
  log_step "Enabling and starting services"
  systemctl daemon-reload

  # Apply mita config
  if mita apply config "$MITA_CONFIG_DIR/server.json" 2>/dev/null; then
    log_info "mita config applied ✓"
  else
    log_warn "mita apply config returned non-zero (may be normal on first run)"
  fi

  # caddy-naive
  write_caddy_service
  systemctl enable caddy-naive
  systemctl restart caddy-naive && log_info "caddy-naive started ✓" || \
    log_warn "caddy-naive failed to start (check: journalctl -u caddy-naive -n 30)"

  # mita
  write_mita_service
  systemctl enable mita
  systemctl restart mita && log_info "mita started ✓" || \
    log_warn "mita failed to start (check: journalctl -u mita -n 30)"

  # PM2 panel
  cd "$PANEL_DIR"
  local panel_host="127.0.0.1"
  [[ "${EXPOSE_PANEL^^}" == "Y" ]] && panel_host="0.0.0.0"

  pm2 delete panel-naive-mieru 2>/dev/null || true
  PANEL_HOST="$panel_host" PANEL_PORT=3000 \
    pm2 start server/index.js \
      --name panel-naive-mieru \
      --env production \
      --log /var/log/panel-naive-mieru.log \
      --time 2>/dev/null || \
  NODE_ENV=production PANEL_HOST="$panel_host" PANEL_PORT=3000 \
    pm2 start server/index.js --name panel-naive-mieru --time
  pm2 save
  pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash 2>/dev/null || true
  log_info "Panel started via PM2 ✓"
  cd /
}

# ── Smoke tests ───────────────────────────────────────────────────────────────
smoke_test() {
  log_step "Running smoke tests"
  sleep 3

  local pass=0 fail=0

  # 1. caddy-naive
  if systemctl is-active --quiet caddy-naive; then
    echo -e "  ${GREEN}✓${NC} caddy-naive is active"
    (( pass++ ))
  else
    echo -e "  ${RED}✗${NC} caddy-naive is NOT active"
    (( fail++ ))
  fi

  # 2. mita
  if systemctl is-active --quiet mita; then
    echo -e "  ${GREEN}✓${NC} mita is active"
    (( pass++ ))
  else
    echo -e "  ${RED}✗${NC} mita is NOT active"
    (( fail++ ))
  fi

  # 3. Panel HTTP
  if curl -sf http://127.0.0.1:3000/ -o /dev/null; then
    echo -e "  ${GREEN}✓${NC} Panel responds on http://127.0.0.1:3000/"
    (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  Panel not responding yet on :3000 (may still be starting)"
  fi

  # 4. NTP
  if timedatectl status 2>/dev/null | grep -q "synchronized: yes"; then
    echo -e "  ${GREEN}✓${NC} Time synchronised"
    (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  Time sync not confirmed"
  fi

  # 5. Config file
  if [[ -f "$PANEL_CONFIG" ]]; then
    echo -e "  ${GREEN}✓${NC} config.json present"
    (( pass++ ))
  else
    echo -e "  ${RED}✗${NC} config.json MISSING"
    (( fail++ ))
  fi

  echo ""
  echo -e "  Smoke test: ${GREEN}$pass passed${NC}  ${RED}$fail failed${NC}"
  [[ $fail -gt 0 ]] && log_warn "Some tests failed — check logs with: journalctl -u caddy-naive -n 30"
}

# ── Final banner ──────────────────────────────────────────────────────────────
print_banner() {
  local server_ip
  server_ip=$(jq -r '.serverIp' "$PANEL_CONFIG" 2>/dev/null || hostname -I | awk '{print $1}')

  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║       Panel Naive + Mieru — Installation Complete    ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${BOLD}Domain:${NC}          $DOMAIN"
  echo -e "  ${BOLD}Server IP:${NC}       $server_ip"
  echo -e "  ${BOLD}NaiveProxy port:${NC} $NAIVE_PORT"
  echo -e "  ${BOLD}Mieru ports:${NC}     $MIERU_PORT_START-$MIERU_PORT_END"
  echo ""
  echo -e "  ${BOLD}Panel access:${NC}"
  if [[ "${EXPOSE_PANEL^^}" == "Y" ]]; then
    echo -e "    Public URL:  http://$server_ip:8080/"
  else
    echo -e "    SSH tunnel:  ssh -L 3000:127.0.0.1:3000 root@$server_ip"
    echo -e "    Then open:   http://localhost:3000/"
  fi
  echo ""
  echo -e "  ${BOLD}Admin credentials:${NC}"
  echo -e "    Username: ${CYAN}$ADMIN_USER${NC}"
  echo -e "    Password: ${CYAN}$ADMIN_PASS${NC}"
  echo ""
  echo -e "  ${BOLD}Useful commands:${NC}"
  echo -e "    pm2 logs panel-naive-mieru"
  echo -e "    systemctl status caddy-naive mita"
  echo -e "    mita status"
  echo -e "    bash update.sh --status"
  echo ""
  echo -e "  ${BOLD}Telegram:${NC} https://t.me/russian_paradice_vpn"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  echo -e "${CYAN}${BOLD}"
  echo "  ██████╗  ██╗ ██╗  ██╗ ██╗  ██╗ ██╗  ██╗"
  echo "  ██╔══██╗ ██║ ╚██╗██╔╝ ╚██╗██╔╝ ╚██╗██╔╝"
  echo "  ██████╔╝ ██║  ╚███╔╝   ╚███╔╝   ╚███╔╝ "
  echo "  ██╔══██╗ ██║  ██╔██╗   ██╔██╗   ██╔██╗ "
  echo "  ██║  ██║ ██║ ██╔╝ ██╗ ██╔╝ ██╗ ██╔╝ ██╗"
  echo "  ╚═╝  ╚═╝ ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝"
  echo -e "${NC}"
  echo -e "  ${BOLD}Panel Naive + Mieru Installer v${CURRENT_VERSION}${NC}"
  echo -e "  by RIXXX  |  https://t.me/russian_paradice_vpn"
  echo ""

  check_os
  detect_arch
  sync_time
  install_deps
  install_nodejs
  install_naiveproxy
  install_mieru
  gather_config
  write_mita_config
  write_caddyfile
  write_config_json
  install_panel
  write_version

  [[ "${USE_UFW^^}" =~ ^Y ]] && setup_ufw

  start_services
  smoke_test
  print_banner
}

main "$@"
