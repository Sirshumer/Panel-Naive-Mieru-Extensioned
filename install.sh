#!/usr/bin/env bash
# ==============================================================================
# Panel Naive + Mieru by RIXXX — install.sh  v1.0.0
# Supports: Ubuntu 20.04/22.04/24.04, Debian 11/12 | x86_64, ARM64, ARMv7
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
# Temp config file the panel builds and applies via:  mita apply config <file>
MITA_STATE_FILE="/var/lib/rixxx-panel/mita-state.json"
CADDYFILE="/etc/caddy-naive/Caddyfile"
CADDY_BIN="/usr/local/bin/caddy-naive"
CURRENT_VERSION="1.0.0"
REPO_URL="https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX"
NAIVE_RELEASES="https://api.github.com/repos/klzgrad/naiveproxy/releases/latest"
MIERU_RELEASES="https://api.github.com/repos/enfein/mieru/releases/latest"

# ── i18n strings ──────────────────────────────────────────────────────────────
# Set LANG_RU=true if user selects Russian (default); false = English
LANG_RU=true

t() {
  # t <ru_text> <en_text>
  if $LANG_RU; then echo "$1"; else echo "$2"; fi
}

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Запустите скрипт от root (sudo bash install.sh) / Run as root (sudo bash install.sh)"

# ── Language selection — FIRST QUESTION ───────────────────────────────────────
select_language() {
  echo ""
  echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║   Panel Naive + Mieru by RIXXX  v${CURRENT_VERSION}          ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  Выберите язык / Select language:"
  echo -e "  ${CYAN}1)${NC} Русский ${GREEN}(по умолчанию / default)${NC}"
  echo -e "  ${CYAN}2)${NC} English"
  echo ""
  read -rp "  [1/2]: " LANG_CHOICE
  case "${LANG_CHOICE:-1}" in
    2) LANG_RU=false ;;
    *) LANG_RU=true  ;;
  esac
  echo ""
  if $LANG_RU; then
    log_info "Выбран язык: Русский"
  else
    log_info "Language selected: English"
  fi
}

# ── OS check ──────────────────────────────────────────────────────────────────
check_os() {
  log_step "$(t 'Проверка совместимости ОС' 'Checking OS compatibility')"
  [[ ! -f /etc/os-release ]] && die "$(t 'Не удалось определить ОС' 'Cannot determine OS')"
  source /etc/os-release
  case "$ID" in
    ubuntu)
      case "$VERSION_ID" in
        20.04|22.04|24.04) log_info "OS: Ubuntu $VERSION_ID ✓" ;;
        *) die "$(t "Неподдерживаемая Ubuntu: $VERSION_ID (20.04, 22.04, 24.04)" "Unsupported Ubuntu: $VERSION_ID (20.04, 22.04, 24.04)")" ;;
      esac ;;
    debian)
      case "$VERSION_ID" in
        11|12) log_info "OS: Debian $VERSION_ID ✓" ;;
        *) die "$(t "Неподдерживаемый Debian: $VERSION_ID (11, 12)" "Unsupported Debian: $VERSION_ID (11, 12)")" ;;
      esac ;;
    *) die "$(t "Неподдерживаемая ОС: $ID" "Unsupported OS: $ID")" ;;
  esac
}

# ── Idempotent check ──────────────────────────────────────────────────────────
check_existing() {
  if [[ -f "$PANEL_CONFIG" ]]; then
    log_warn "$(t 'Обнаружена существующая установка!' 'Existing installation detected!')"
    echo ""
    read -rp "$(t '  Переустановить поверх? [д/Н]: ' '  Reinstall over existing? [y/N]: ')" REINSTALL
    local ans="${REINSTALL:-N}"
    if $LANG_RU; then
      [[ "${ans^^}" =~ ^(Д|Y)$ ]] || { log_info "$(t 'Отменено.' 'Aborted.')"; exit 0; }
    else
      [[ "${ans^^}" == "Y" ]] || { log_info "Aborted."; exit 0; }
    fi
    # Backup before reinstall
    local ts; ts=$(date +%Y-%m-%d-%H%M%S)
    local bdir="$BACKUP_DIR/$ts"
    mkdir -p "$bdir"
    [[ -f "$CADDYFILE"       ]] && cp "$CADDYFILE"       "$bdir/" || true
    [[ -f "$MITA_STATE_FILE" ]] && cp "$MITA_STATE_FILE" "$bdir/" || true
    [[ -f "$PANEL_CONFIG"    ]] && cp "$PANEL_CONFIG"    "$bdir/" || true
    log_info "$(t "Резервная копия: $bdir" "Backup created: $bdir")"
  fi
}

# ── Architecture detection ────────────────────────────────────────────────────
detect_arch() {
  log_step "$(t 'Определение архитектуры' 'Detecting architecture')"
  local machine; machine=$(uname -m)
  case "$machine" in
    x86_64|amd64)  ARCH="amd64"; NAIVE_ARCH="linux-amd64"; DEB_ARCH="amd64"  ;;
    aarch64|arm64) ARCH="arm64"; NAIVE_ARCH="linux-arm64"; DEB_ARCH="arm64"  ;;
    armv7l)        ARCH="armv7"; NAIVE_ARCH="linux-arm";   DEB_ARCH="armhf"  ;;
    *) die "$(t "Неподдерживаемая архитектура: $machine" "Unsupported architecture: $machine")" ;;
  esac
  log_info "$(t "Архитектура" 'Architecture'): $machine → $ARCH ✓"
}

# ── NTP sync ──────────────────────────────────────────────────────────────────
sync_time() {
  log_step "$(t 'Синхронизация времени (NTP)' 'Synchronising system time (NTP)')"
  log_warn "$(t 'ВАЖНО: Mieru требует точного системного времени (±30 сек). Синхронизация критична!' \
             'IMPORTANT: Mieru requires accurate system time (±30 s). NTP sync is critical!')"
  timedatectl set-ntp true 2>/dev/null || true
  # Wait up to 15 s
  local synced=false
  for i in $(seq 1 15); do
    if timedatectl status 2>/dev/null | grep -q "synchronized: yes"; then
      synced=true; break
    fi
    sleep 1
  done
  if $synced; then
    log_info "$(t 'Время синхронизировано ✓' 'Time synchronised ✓')"
  else
    log_warn "$(t 'Синхронизация не подтверждена за 15 с!' 'Sync not confirmed within 15 s!')"
    log_warn "$(t 'Если Mieru не подключается — проверьте время: timedatectl status' \
               'If Mieru fails to connect — check time: timedatectl status')"
  fi
}

# ── Package dependencies ───────────────────────────────────────────────────────
install_deps() {
  log_step "$(t 'Установка зависимостей' 'Installing dependencies')"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    curl wget git ufw unzip tar gzip jq \
    ca-certificates gnupg lsb-release \
    systemd cron net-tools iproute2 \
    coreutils 2>/dev/null || \
  apt-get install -y \
    curl wget git ufw unzip tar gzip jq \
    ca-certificates gnupg lsb-release \
    systemd cron net-tools iproute2 coreutils
  log_info "$(t 'Зависимости установлены ✓' 'Dependencies installed ✓')"
}

# ── Node.js 20 LTS + PM2 ──────────────────────────────────────────────────────
install_nodejs() {
  log_step "$(t 'Установка Node.js 20 LTS' 'Installing Node.js 20 LTS')"
  if command -v node &>/dev/null && node --version | grep -qE "^v2[0-9]"; then
    log_info "Node.js $(node --version) — $(t 'уже установлен ✓' 'already installed ✓')"
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    log_info "Node.js $(node --version) $(t 'установлен ✓' 'installed ✓')"
  fi
  if command -v pm2 &>/dev/null; then
    log_info "PM2 $(pm2 --version) — $(t 'уже установлен ✓' 'already installed ✓')"
  else
    npm install -g pm2 --silent
    log_info "$(t 'PM2 установлен ✓' 'PM2 installed ✓')"
  fi
}

# ── NaiveProxy (caddy-naive binary) ──────────────────────────────────────────
install_naiveproxy() {
  log_step "$(t 'Установка NaiveProxy (caddy-naive)' 'Installing NaiveProxy (caddy-naive)')"
  log_info "$(t 'Запрос последнего релиза...' 'Fetching latest release...')"
  local release_json
  release_json=$(curl -fsSL "$NAIVE_RELEASES") || \
    die "$(t 'Ошибка запроса GitHub API для NaiveProxy' 'Cannot fetch NaiveProxy releases')"
  local tag; tag=$(echo "$release_json" | jq -r '.tag_name')
  log_info "$(t "Последняя версия NaiveProxy: $tag" "Latest NaiveProxy: $tag")"

  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$NAIVE_ARCH" \
    '.assets[] | select(.name | test("naiveproxy-.*" + $arch)) | select(.name | test("\\.tar\\.xz|\\.tar\\.gz|\\.zip")) | .browser_download_url' \
    | head -1)
  [[ -z "$asset_url" ]] && \
    asset_url=$(echo "$release_json" | jq -r \
      '.assets[] | select(.name | test("linux")) | .browser_download_url' | head -1)
  [[ -z "$asset_url" ]] && die "$(t "Не найден ассет NaiveProxy для $NAIVE_ARCH" "No NaiveProxy asset for $NAIVE_ARCH")"

  local tmp_dir; tmp_dir=$(mktemp -d)
  local archive_name; archive_name=$(basename "$asset_url")
  log_info "$(t "Загрузка: $asset_url" "Downloading: $asset_url")"
  wget -q --show-progress -O "$tmp_dir/$archive_name" "$asset_url" || \
    die "$(t 'Ошибка загрузки NaiveProxy' 'Failed to download NaiveProxy')"
  cd "$tmp_dir"
  [[ "$archive_name" == *.tar.xz ]] && tar -xJf "$archive_name"
  [[ "$archive_name" == *.tar.gz ]] && tar -xzf "$archive_name"
  [[ "$archive_name" == *.zip    ]] && unzip -q  "$archive_name"
  local caddy_bin
  caddy_bin=$(find "$tmp_dir" -type f -name "caddy*" ! -name "*.xz" ! -name "*.gz" ! -name "*.zip" | head -1)
  [[ -z "$caddy_bin" ]] && die "$(t 'Бинарный файл caddy не найден в архиве' 'caddy binary not found in archive')"
  install -m 755 "$caddy_bin" "$CADDY_BIN"
  rm -rf "$tmp_dir"; cd /
  NAIVE_VERSION=$("$CADDY_BIN" version 2>/dev/null | head -1 || echo "$tag")
  log_info "caddy-naive $(t 'установлен' 'installed') → $CADDY_BIN  ($NAIVE_VERSION) ✓"
}

# ── Mieru (mita) via .deb ─────────────────────────────────────────────────────
install_mieru() {
  log_step "$(t 'Установка Mieru (mita)' 'Installing Mieru (mita)')"
  log_info "$(t 'Запрос последнего релиза...' 'Fetching latest release...')"
  local release_json
  release_json=$(curl -fsSL "$MIERU_RELEASES") || \
    die "$(t 'Ошибка запроса GitHub API для Mieru' 'Cannot fetch Mieru releases')"
  local tag; tag=$(echo "$release_json" | jq -r '.tag_name')
  log_info "$(t "Последняя версия Mieru: $tag" "Latest Mieru: $tag")"

  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$DEB_ARCH" \
    '.assets[] | select(.name | test("mita.*" + $arch + "\\.deb")) | .browser_download_url' | head -1)
  [[ -z "$asset_url" ]] && \
    asset_url=$(echo "$release_json" | jq -r \
      --arg arch "$DEB_ARCH" \
      '.assets[] | select(.name | test($arch + "\\.deb")) | .browser_download_url' | head -1)
  [[ -z "$asset_url" ]] && die "$(t "Не найден .deb Mieru для $DEB_ARCH" "No Mieru .deb for $DEB_ARCH")"

  local deb_file; deb_file=$(mktemp /tmp/mieru-XXXXXX.deb)
  log_info "$(t "Загрузка: $asset_url" "Downloading: $asset_url")"
  wget -q --show-progress -O "$deb_file" "$asset_url" || \
    die "$(t 'Ошибка загрузки Mieru .deb' 'Failed to download Mieru .deb')"
  dpkg -i "$deb_file" 2>/dev/null || apt-get install -f -y
  rm -f "$deb_file"
  MIERU_VERSION=$(mita version 2>/dev/null | grep -oP 'v[\d.]+' | head -1 || echo "$tag")
  log_info "mita $(t 'установлен' 'installed') ($MIERU_VERSION) ✓"
}

# ── Interactive prompts (bilingual) ───────────────────────────────────────────
gather_config() {
  log_step "$(t 'Настройка' 'Configuration')"
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}   Panel Naive + Mieru — $(t 'Мастер установки' 'Setup Wizard')${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
  echo ""

  # Domain
  read -rp "$(echo -e "${CYAN}$(t 'Домен / имя хоста' 'Domain / hostname')${NC} ($(t 'напр.' 'e.g.') vpn.example.com): ")" INPUT_DOMAIN
  [[ -z "$INPUT_DOMAIN" ]] && die "$(t 'Домен не может быть пустым' 'Domain cannot be empty')"
  DOMAIN="$INPUT_DOMAIN"

  # Email for TLS
  read -rp "$(echo -e "${CYAN}Email $(t 'для TLS-сертификата' 'for TLS cert')${NC} ($(t 'напр.' 'e.g.') admin@example.com): ")" INPUT_EMAIL
  [[ -z "$INPUT_EMAIL" ]] && die "$(t 'Email не может быть пустым' 'Email cannot be empty')"
  ADMIN_EMAIL="$INPUT_EMAIL"

  # NaiveProxy port
  read -rp "$(echo -e "${CYAN}$(t 'Порт NaiveProxy HTTPS' 'NaiveProxy HTTPS port')${NC} [$(t 'по умолчанию' 'default'): 443]: ")" INPUT_NAIVE_PORT
  NAIVE_PORT="${INPUT_NAIVE_PORT:-443}"
  if ! [[ "$NAIVE_PORT" =~ ^[0-9]+$ ]] || (( NAIVE_PORT < 1 || NAIVE_PORT > 65535 )); then
    die "$(t "Некорректный порт: $NAIVE_PORT" "Invalid port: $NAIVE_PORT")"
  fi

  # Mieru port range
  echo ""
  echo -e "${YELLOW}$(t 'Mieru использует диапазон портов (TCP+UDP). По умолчанию: 2012-2022' \
                       'Mieru uses a port range (TCP+UDP). Default: 2012-2022')${NC}"
  read -rp "$(echo -e "${CYAN}$(t 'Начальный порт Mieru' 'Mieru start port')${NC} [$(t 'по умолчанию' 'default'): 2012]: ")" INPUT_MIERU_START
  MIERU_PORT_START="${INPUT_MIERU_START:-2012}"
  read -rp "$(echo -e "${CYAN}$(t 'Конечный порт Mieru  ' 'Mieru end port  ')${NC} [$(t 'по умолчанию' 'default'): 2022]: ")" INPUT_MIERU_END
  MIERU_PORT_END="${INPUT_MIERU_END:-2022}"
  for p in "$MIERU_PORT_START" "$MIERU_PORT_END"; do
    if ! [[ "$p" =~ ^[0-9]+$ ]] || (( p < 1025 || p > 65535 )); then
      die "$(t "Некорректный порт Mieru: $p (должен быть 1025-65535)" "Invalid Mieru port: $p (must be 1025-65535)")"
    fi
  done
  (( MIERU_PORT_END < MIERU_PORT_START )) && \
    die "$(t "Конечный порт ($MIERU_PORT_END) должен быть >= начального ($MIERU_PORT_START)" \
            "End port ($MIERU_PORT_END) must be >= start port ($MIERU_PORT_START)")"

  # Admin credentials
  echo ""
  read -rp "$(echo -e "${CYAN}$(t 'Имя администратора панели' 'Panel admin username')${NC} [$(t 'по умолчанию' 'default'): admin]: ")" INPUT_ADMIN_USER
  ADMIN_USER="${INPUT_ADMIN_USER:-admin}"
  read -rsp "$(echo -e "${CYAN}$(t 'Пароль администратора' 'Panel admin password')${NC} ($(t 'пусто = автогенерация' 'blank = auto-generate')): ")" INPUT_ADMIN_PASS
  echo ""
  if [[ -z "$INPUT_ADMIN_PASS" ]]; then
    ADMIN_PASS=$(tr -dc 'A-Za-z0-9@#%^&' </dev/urandom | head -c 20)
    log_info "$(t "Сгенерирован пароль: ${BOLD}$ADMIN_PASS${NC}" "Generated password: ${BOLD}$ADMIN_PASS${NC}")"
  else
    ADMIN_PASS="$INPUT_ADMIN_PASS"
  fi

  # UFW
  echo ""
  read -rp "$(echo -e "${CYAN}$(t 'Настроить UFW (файрвол)?' 'Configure UFW firewall?')${NC} [$(t 'Д/н' 'Y/n')]: ")" INPUT_UFW
  USE_UFW="${INPUT_UFW:-Y}"

  # Expose panel
  echo ""
  echo -e "${YELLOW}$(t 'Панель работает на 127.0.0.1:3000 (только через SSH-туннель, по умолчанию).' \
                       'Panel runs on 127.0.0.1:3000 (SSH-only by default).')${NC}"
  read -rp "$(echo -e "${CYAN}$(t 'Открыть панель публично через Caddy на порту 8080?' 'Expose panel publicly via Caddy on port 8080?')${NC} [$(t 'д/Н' 'y/N')]: ")" INPUT_EXPOSE
  EXPOSE_PANEL="${INPUT_EXPOSE:-N}"

  echo ""
  log_info "$(t 'Конфигурация собрана ✓' 'Configuration gathered ✓')"
}

# ── Caddyfile ─────────────────────────────────────────────────────────────────
write_caddyfile() {
  log_step "$(t 'Запись Caddyfile' 'Writing Caddyfile')"
  mkdir -p /etc/caddy-naive /var/log/caddy-naive
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
      # users are added by panel on user create/update
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
  log_info "$(t "Caddyfile записан → $CADDYFILE ✓" "Caddyfile written → $CADDYFILE ✓")"
}

# ── Mieru initial state file ──────────────────────────────────────────────────
# NOTE: mita does NOT use /etc/mita/server.json directly (internal protobuf store).
# The panel builds this JSON and applies it via:  mita apply config <file>
write_mita_state() {
  log_step "$(t 'Запись начального конфига Mieru' 'Writing initial Mieru state')"
  mkdir -p "$(dirname "$MITA_STATE_FILE")"

  local bindings=""
  for (( port=MIERU_PORT_START; port<=MIERU_PORT_END; port++ )); do
    bindings+="    {\"port\": $port, \"protocol\": \"TCP\"},"$'\n'
    bindings+="    {\"port\": $port, \"protocol\": \"UDP\"},"$'\n'
  done

  python3 - <<PYEOF
import json, sys
start = $MIERU_PORT_START
end   = $MIERU_PORT_END
cfg = {
    "portBindings": [
        {"port": p, "protocol": proto}
        for p in range(start, end + 1)
        for proto in ("TCP", "UDP")
    ],
    "users": [],
    "loggingLevel": "INFO",
    "mtu": 1350,
    "trafficConfig": {"pattern": "NOOP"}
}
with open("$MITA_STATE_FILE", "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF
  chmod 600 "$MITA_STATE_FILE"
  log_info "$(t "Mita state file → $MITA_STATE_FILE ✓" "Mita state file → $MITA_STATE_FILE ✓")"
}

# ── Systemd: caddy-naive ──────────────────────────────────────────────────────
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
ExecStart=${CADDY_BIN} run --config ${CADDYFILE} --adapter caddyfile
ExecReload=${CADDY_BIN} reload --config ${CADDYFILE} --adapter caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
}

# ── Systemd: mita (ensure exists) ────────────────────────────────────────────
write_mita_service() {
  if [[ ! -f /lib/systemd/system/mita.service ]] && \
     [[ ! -f /etc/systemd/system/mita.service ]]; then
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
  log_step "$(t 'Настройка UFW' 'Configuring UFW firewall')"
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow ssh
  ufw allow "${NAIVE_PORT}/tcp"   comment "NaiveProxy HTTPS"
  ufw allow "${MIERU_PORT_START}:${MIERU_PORT_END}/tcp" comment "Mieru TCP"
  ufw allow "${MIERU_PORT_START}:${MIERU_PORT_END}/udp" comment "Mieru UDP"
  [[ "${EXPOSE_PANEL^^}" =~ ^(Y|Д)$ ]] && ufw allow 8080/tcp comment "Panel Web UI"
  ufw --force enable
  log_info "$(t 'Правила UFW применены ✓' 'UFW rules applied ✓')"
}

# ── Panel installation ────────────────────────────────────────────────────────
install_panel() {
  log_step "$(t 'Установка веб-панели' 'Installing web panel')"
  mkdir -p "$PANEL_DIR"
  local script_dir; script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -d "$script_dir/panel" ]]; then
    cp -r "$script_dir/panel/"* "$PANEL_DIR/"
    log_info "$(t "Файлы панели скопированы из $script_dir/panel ✓" "Panel files copied from $script_dir/panel ✓")"
  else
    log_warn "$(t 'Исходники не найдены — клонирование из репозитория...' \
               'Panel source not found — cloning from repo...')"
    git clone --depth 1 "$REPO_URL" /tmp/panel-src 2>/dev/null || \
      die "$(t 'Не удалось клонировать репозиторий' 'Failed to clone panel source')"
    cp -r /tmp/panel-src/panel/* "$PANEL_DIR/"
    rm -rf /tmp/panel-src
  fi
  cd "$PANEL_DIR"
  npm install --production --silent
  log_info "$(t 'npm зависимости установлены ✓' 'npm dependencies installed ✓')"
  cd /
}

# ── config.json ───────────────────────────────────────────────────────────────
write_config_json() {
  log_step "$(t 'Запись /etc/rixxx-panel/config.json' 'Writing /etc/rixxx-panel/config.json')"
  mkdir -p /etc/rixxx-panel "$(dirname "$DB_PATH")"
  local server_ip
  server_ip=$(curl -4 -fsSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

  python3 - <<PYCFG
import json, hashlib
data = {
    "domain":          "$DOMAIN",
    "serverIp":        "$server_ip",
    "adminEmail":      "$ADMIN_EMAIL",
    "adminUser":       "$ADMIN_USER",
    "adminPassHash":   hashlib.sha256(b"$ADMIN_PASS").hexdigest(),
    "naivePort":       $NAIVE_PORT,
    "mieruPortStart":  $MIERU_PORT_START,
    "mieruPortEnd":    $MIERU_PORT_END,
    "panelPort":       3000,
    "panelHost":       "127.0.0.1",
    "exposePanel":     "$EXPOSE_PANEL".upper() in ("Y","Д"),
    "useUfw":          "$USE_UFW".upper() in ("Y","Д"),
    "dbPath":          "$DB_PATH",
    "caddyfile":       "$CADDYFILE",
    "mitaStateFile":   "$MITA_STATE_FILE",
    "trafficPattern":  "NOOP",
    "mtu":             1350,
    "language":        "ru" if True else "en",
    "version":         "$CURRENT_VERSION",
    "installedAt":     "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
with open("$PANEL_CONFIG", "w") as f:
    json.dump(data, f, indent=2)
import os; os.chmod("$PANEL_CONFIG", 0o600)
PYCFG

  log_info "$(t 'config.json записан ✓' 'config.json written ✓')"
}

write_version() {
  echo "$CURRENT_VERSION" > "$VERSION_FILE"
  log_info "$(t "Версия: $CURRENT_VERSION ✓" "Version: $CURRENT_VERSION ✓")"
}

# ── Start services ────────────────────────────────────────────────────────────
start_services() {
  log_step "$(t 'Запуск сервисов' 'Starting services')"
  systemctl daemon-reload

  # Apply mita config (builds internal protobuf store from our JSON state file)
  if mita apply config "$MITA_STATE_FILE" 2>/dev/null; then
    log_info "$(t 'mita config применён ✓' 'mita config applied ✓')"
  else
    log_warn "$(t 'mita apply config вернул ошибку (нормально при первом запуске)' \
               'mita apply config returned non-zero (normal on first run)')"
  fi

  # caddy-naive
  write_caddy_service
  systemctl enable caddy-naive
  systemctl restart caddy-naive && \
    log_info "$(t 'caddy-naive запущен ✓' 'caddy-naive started ✓')" || \
    log_warn "$(t 'caddy-naive не запустился — journalctl -u caddy-naive -n 30' \
               'caddy-naive failed — journalctl -u caddy-naive -n 30')"

  # mita
  write_mita_service
  systemctl enable mita
  systemctl restart mita && \
    log_info "$(t 'mita запущен ✓' 'mita started ✓')" || \
    log_warn "$(t 'mita не запустился — journalctl -u mita -n 30' \
               'mita failed — journalctl -u mita -n 30')"

  # PM2 panel
  cd "$PANEL_DIR"
  local panel_host="127.0.0.1"
  [[ "${EXPOSE_PANEL^^}" =~ ^(Y|Д)$ ]] && panel_host="0.0.0.0"
  pm2 delete panel-naive-mieru 2>/dev/null || true
  PANEL_HOST="$panel_host" PANEL_PORT=3000 \
    pm2 start server/index.js \
      --name panel-naive-mieru \
      --log /var/log/panel-naive-mieru.log \
      --time 2>/dev/null || \
  NODE_ENV=production PANEL_HOST="$panel_host" PANEL_PORT=3000 \
    pm2 start server/index.js --name panel-naive-mieru --time
  pm2 save
  pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash 2>/dev/null || true
  log_info "$(t 'Панель запущена через PM2 ✓' 'Panel started via PM2 ✓')"
  cd /
}

# ── Smoke tests ───────────────────────────────────────────────────────────────
smoke_test() {
  log_step "$(t 'Smoke-тесты' 'Running smoke tests')"
  sleep 4
  local pass=0 fail=0

  chk() {
    if eval "$2" &>/dev/null; then
      echo -e "  ${GREEN}✓${NC} $1"; (( pass++ ))
    else
      echo -e "  ${RED}✗${NC} $1"; (( fail++ ))
    fi
  }

  chk "caddy-naive active"       "systemctl is-active caddy-naive"
  chk "mita active"              "systemctl is-active mita"
  chk "Caddyfile valid"          "$CADDY_BIN validate --config $CADDYFILE --adapter caddyfile 2>/dev/null"
  chk "mita status OK"           "mita status 2>/dev/null | grep -qi 'running\|active\|listen'"
  chk "Panel responds :3000"     "curl -sf http://127.0.0.1:3000/ -o /dev/null"
  chk "config.json present"      "[[ -f $PANEL_CONFIG ]]"
  chk "mita-state.json present"  "[[ -f $MITA_STATE_FILE ]]"

  if timedatectl status 2>/dev/null | grep -q "synchronized: yes"; then
    echo -e "  ${GREEN}✓${NC} $(t 'Время синхронизировано' 'Time synchronised')"
    (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  $(t 'Время НЕ синхронизировано — критично для Mieru!' \
                                    'Time NOT synchronised — critical for Mieru!')"
  fi

  echo ""
  echo -e "  $(t 'Результат' 'Results'): ${GREEN}$pass $(t 'прошло' 'passed')${NC}  ${RED}$fail $(t 'упало' 'failed')${NC}"
  (( fail > 0 )) && log_warn "$(t 'Проверьте логи: journalctl -u caddy-naive mita -n 30' \
                                  'Check logs: journalctl -u caddy-naive mita -n 30')"
}

# ── UFW call ──────────────────────────────────────────────────────────────────
maybe_ufw() {
  local ans="${USE_UFW:-Y}"
  [[ "${ans^^}" =~ ^(Y|Д)$ ]] && setup_ufw || true
}

# ── Final banner ──────────────────────────────────────────────────────────────
print_banner() {
  local server_ip; server_ip=$(python3 -c "import json; print(json.load(open('$PANEL_CONFIG'))['serverIp'])" 2>/dev/null || hostname -I | awk '{print $1}')
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
  if $LANG_RU; then
    echo -e "${GREEN}${BOLD}║     Panel Naive + Mieru — Установка завершена  ✓         ║${NC}"
  else
    echo -e "${GREEN}${BOLD}║     Panel Naive + Mieru — Installation Complete  ✓       ║${NC}"
  fi
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${BOLD}$(t 'Домен' 'Domain'):${NC}              $DOMAIN"
  echo -e "  ${BOLD}$(t 'IP сервера' 'Server IP'):${NC}          $server_ip"
  echo -e "  ${BOLD}$(t 'Порт NaiveProxy' 'NaiveProxy port'):${NC}    $NAIVE_PORT"
  echo -e "  ${BOLD}$(t 'Порты Mieru' 'Mieru ports'):${NC}        $MIERU_PORT_START-$MIERU_PORT_END"
  echo ""
  echo -e "  ${BOLD}$(t 'Доступ к панели' 'Panel access'):${NC}"
  if [[ "${EXPOSE_PANEL^^}" =~ ^(Y|Д)$ ]]; then
    echo -e "    $(t 'Публичный URL' 'Public URL'):  ${CYAN}http://$server_ip:8080/${NC}"
  else
    echo -e "    SSH: ${CYAN}ssh -L 3000:127.0.0.1:3000 root@$server_ip${NC}"
    echo -e "    $(t 'Затем откройте' 'Then open'):  ${CYAN}http://localhost:3000/${NC}"
  fi
  echo ""
  echo -e "  ${BOLD}$(t 'Данные администратора' 'Admin credentials'):${NC}"
  echo -e "    $(t 'Логин' 'Username'): ${CYAN}$ADMIN_USER${NC}"
  echo -e "    $(t 'Пароль' 'Password'): ${CYAN}$ADMIN_PASS${NC}"
  echo ""
  echo -e "  ${BOLD}$(t 'Полезные команды' 'Useful commands'):${NC}"
  echo -e "    pm2 logs panel-naive-mieru"
  echo -e "    systemctl status caddy-naive mita"
  echo -e "    mita status"
  echo -e "    bash update.sh --status"
  echo ""
  echo -e "  ${YELLOW}${BOLD}⚠  $(t 'ВАЖНО: Сохраните пароль — он больше не будет показан!' \
                                    'IMPORTANT: Save the password — it will not be shown again!')${NC}"
  echo ""
  echo -e "  Telegram: ${CYAN}https://t.me/russian_paradice_vpn${NC}"
  echo -e "  $(t 'Донат' 'Donate'):    ${CYAN}https://app.lava.top/2107724612?tabId=donate${NC}"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  select_language
  check_os
  detect_arch
  check_existing
  sync_time
  install_deps
  install_nodejs
  install_naiveproxy
  install_mieru
  gather_config
  write_mita_state
  write_caddyfile
  write_config_json
  install_panel
  write_version
  maybe_ufw
  start_services
  smoke_test
  print_banner
}

main "$@"
