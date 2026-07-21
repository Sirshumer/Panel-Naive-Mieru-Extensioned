#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  Hysteria2 Auto-Installer — by RIXXX (multi-arch)
#  Panel Naive + Mieru + Hysteria2 by RIXXX
#
#  Integrates Hy2 as a THIRD protocol into the existing Naive+Mieru panel.
#  KEY DIFFERENCES from the standalone donor installer:
#    • PORT is configurable (HY_PORT, default 443/udp) — coexists with Caddy
#      on 443/tcp. Naive uses TCP/443, Hy2 uses UDP/HY_PORT.
#    • Users live in the panel's SQLite `users` table (shared pool). The panel
#      backend (writeHysteriaConfig) rewrites the `auth.userpass` block from the
#      DB. The bootstrap config below writes an EMPTY userpass map; the panel
#      fills it in on first apply (and on every add/delete/edit).
#    • Certificate is SHARED with Caddy (USE_CADDY_CERT=1) — no second ACME,
#      no second email. Our Caddy already runs `protocols h1 h2` (HTTP/3 OFF)
#      so UDP/443 is already free; we still keep the H3-disable safety net for
#      any legacy Caddyfile that predates that change.
#
#  ENV:
#    HY_DOMAIN       (required) — server domain (matches Caddy site + cert CN)
#    HY_PORT         (optional) — UDP listen port, default 443
#    HY_EMAIL        (optional) — only used in standalone ACME mode
#    HY_PASSWORD     (optional) — bootstrap fallback password (panel overwrites)
#    USE_CADDY_CERT  (0/1)      — 1 = reuse Caddy's cert (recommended), default 1
# ═══════════════════════════════════════════════════════════════════════════

set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

DOMAIN="${HY_DOMAIN:-}"
HY_PORT="${HY_PORT:-443}"
EMAIL="${HY_EMAIL:-admin@example.com}"
PASSWORD="${HY_PASSWORD:-}"
USE_CADDY_CERT="${USE_CADDY_CERT:-1}"

if [[ -z "$DOMAIN" ]]; then
  echo "ERROR: missing env HY_DOMAIN"
  exit 1
fi

# Validate port is numeric and in range.
if ! [[ "$HY_PORT" =~ ^[0-9]+$ ]] || (( HY_PORT < 1 || HY_PORT > 65535 )); then
  echo "ERROR: HY_PORT must be 1–65535 (got: $HY_PORT)"
  exit 1
fi

log()  { echo "$1"; }
step() { echo "STEP:$1"; }

case "$(uname -m)" in
  x86_64)  HY_ARCH="amd64" ;;
  aarch64) HY_ARCH="arm64" ;;
  armv7l)  HY_ARCH="arm"   ;;
  *)       HY_ARCH="amd64" ;;
esac
log "  Arch: $(uname -m) → Hy2:${HY_ARCH}"
log "  Порт Hy2: ${HY_PORT}/udp (Naive остаётся на 443/tcp)"

# ══════════════════════════════════════════════════════
step 1
log "▶ Установка зависимостей..."
# ══════════════════════════════════════════════════════

apt-get update -qq -o DPkg::Lock::Timeout=60 2>/dev/null || true
apt-get install -y -qq curl wget jq libcap2-bin ca-certificates 2>/dev/null || true
log "✅ Зависимости готовы"

# ══════════════════════════════════════════════════════
step 2
log "▶ UDP-оптимизации..."
# ══════════════════════════════════════════════════════

cat > /etc/sysctl.d/99-rixxx-tune.conf << 'SYSCTLEOF'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.core.rmem_default=2500000
net.core.wmem_default=2500000
net.ipv4.tcp_fastopen=3
SYSCTLEOF
sysctl --system >/dev/null 2>&1 || true

log "✅ Сетевой тюнинг применён"

# ══════════════════════════════════════════════════════
step 3
log "▶ Настройка файрволла (UFW, если активен)..."
# ══════════════════════════════════════════════════════

# Only touch UFW if it is installed AND already active — the panel install
# manages its own firewall policy. We just make sure UDP/HY_PORT is open.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "Status: active"; then
  ufw allow "${HY_PORT}/udp" >/dev/null 2>&1 || true
  log "✅ UFW: ${HY_PORT}/udp открыт"
else
  log "  UFW не активен — пропускаем (порт откроется на уровне провайдера/iptables)"
fi

# ══════════════════════════════════════════════════════
step 4
log "▶ Загрузка Hysteria2 (arch: ${HY_ARCH})..."
# ══════════════════════════════════════════════════════

HY_VERSION=$(curl -fsSL --connect-timeout 10 \
  https://api.github.com/repos/apernet/hysteria/releases/latest 2>/dev/null \
  | jq -r '.tag_name' 2>/dev/null || echo "")
[[ -z "$HY_VERSION" || "$HY_VERSION" == "null" ]] && HY_VERSION="app/v2.5.2"

log "  Версия: ${HY_VERSION}"
HY_URL="https://github.com/apernet/hysteria/releases/download/${HY_VERSION}/hysteria-linux-${HY_ARCH}"

wget -q --timeout=120 "${HY_URL}" -O /usr/local/bin/hysteria 2>&1 || {
  log "⚠ Не удалось скачать ${HY_VERSION}, fallback → app/v2.5.2"
  wget -q --timeout=120 \
    "https://github.com/apernet/hysteria/releases/download/app/v2.5.2/hysteria-linux-${HY_ARCH}" \
    -O /usr/local/bin/hysteria || {
    log "ERROR: Не удалось скачать hysteria!"
    exit 1
  }
}

if [[ ! -s /usr/local/bin/hysteria ]]; then
  log "ERROR: бинарник hysteria пустой"
  exit 1
fi

chmod +x /usr/local/bin/hysteria
setcap 'cap_net_bind_service=+ep' /usr/local/bin/hysteria 2>/dev/null || true

HY_VER=$(/usr/local/bin/hysteria version 2>&1 | head -n1 || echo "unknown")
log "✅ Hysteria2 установлена: $HY_VER"

# ══════════════════════════════════════════════════════
step 5
log "▶ Создание базового конфига..."
# ══════════════════════════════════════════════════════

mkdir -p /etc/hysteria

# Bootstrap config. The panel backend (writeHysteriaConfig) OWNS the
# `auth.userpass` map and rewrites it from the SQLite users table on every
# add/delete/edit. We seed it with an OPTIONAL bootstrap password so the
# service can start immediately even before the first panel apply.
cat > /etc/hysteria/config.yaml << HYCFGEOF
# ═══════════════════════════════════════════════
#  Hysteria2 — by RIXXX  (managed by RIXXX Panel)
#  https://v2.hysteria.network/
#  ⚠ auth.userpass ниже управляется панелью (SQLite users где protocols
#     содержит "hy2"). Ручные правки в этом блоке будут перезаписаны.
# ═══════════════════════════════════════════════

# Caddy занимает TCP/${HY_PORT}; Hy2 работает поверх QUIC (UDP), TCP ему не нужен.
listen: :${HY_PORT}

auth:
  type: userpass
  userpass:
HYCFGEOF

# Seed a bootstrap credential only if provided (so the service is valid on
# first boot). The panel replaces the whole map on first apply.
if [[ -n "$PASSWORD" ]]; then
  echo "    bootstrap: \"${PASSWORD}\"" >> /etc/hysteria/config.yaml
else
  echo "    {}" >> /etc/hysteria/config.yaml
fi

cat >> /etc/hysteria/config.yaml << 'HYMASQEOF'

# Маскировка: отдаёт ту же статичную страницу что Caddy. Нет лишних
# внешних запросов → нет ошибок H3_GENERAL_PROTOCOL_ERROR в логах.
masquerade:
  type: file
  file:
    dir: /var/www/html
HYMASQEOF

# Ensure a masquerade HTML root exists (standalone Hy2 without Caddy).
mkdir -p /var/www/html
if [[ ! -f /var/www/html/index.html ]]; then
  cat > /var/www/html/index.html << 'MASQEOF'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Loading</title>
<style>body{background:#080808;height:100vh;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif}.bar{width:200px;height:3px;background:#151515;overflow:hidden;border-radius:2px;margin-bottom:25px}.fill{height:100%;width:40%;background:#fff;animation:slide 1.4s infinite ease-in-out}@keyframes slide{0%{transform:translateX(-100%)}50%{transform:translateX(50%)}100%{transform:translateX(200%)}}.t{color:#555;font-size:13px;letter-spacing:3px;font-weight:600}</style>
</head><body><div class="bar"><div class="fill"></div></div><div class="t">LOADING CONTENT</div></body></html>
MASQEOF
fi

if [[ "$USE_CADDY_CERT" == "1" ]]; then
  # ── Освобождаем UDP/443 для Hy2: наш Caddy уже с `protocols h1 h2` (HTTP/3
  # OFF), но на случай легаси-Caddyfile — отключаем H3 и перезагружаем Caddy.
  # Мы правим ИМЕННО naive-Caddyfile панели: /etc/caddy-naive/Caddyfile.
  CADDYFILE=""
  for CF in /etc/caddy-naive/Caddyfile /etc/caddy/Caddyfile; do
    [[ -f "$CF" ]] && { CADDYFILE="$CF"; break; }
  done

  if [[ -n "$CADDYFILE" ]] && ! grep -q "protocols h1 h2" "$CADDYFILE"; then
    log "  Отключаем HTTP/3 в Caddy (${CADDYFILE}) — освобождаем UDP/${HY_PORT}..."
    cp "$CADDYFILE" "${CADDYFILE}.bak.$(date +%s)" 2>/dev/null || true
    if command -v python3 >/dev/null 2>&1; then
      CF_PATH="$CADDYFILE" python3 << 'PYEOF' || true
import re, os
p = os.environ['CF_PATH']
with open(p) as f: src = f.read()
m = re.match(r'^\s*\{([^{}]*)\}', src, re.DOTALL)
if m:
    inner = m.group(1)
    if 'protocols h1 h2' not in inner:
        new_inner = inner.rstrip() + '\n  servers {\n    protocols h1 h2\n  }\n'
        src = '{' + new_inner + '}' + src[m.end():]
else:
    src = '{\n  servers {\n    protocols h1 h2\n  }\n}\n\n' + src
with open(p, 'w') as f: f.write(src)
print("Caddyfile updated: HTTP/3 disabled")
PYEOF
    fi
    systemctl reload caddy-naive 2>/dev/null || systemctl restart caddy-naive 2>/dev/null \
      || systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
    sleep 2
    log "✅ HTTP/3 отключён, UDP/${HY_PORT} свободен"
  else
    log "  Caddy уже без HTTP/3 (или Caddyfile не найден) — UDP/${HY_PORT} свободен"
  fi

  # Caddy может получить сертификат от любого CA (LE / ZeroSSL / Google).
  CADDY_CERT_ROOTS=(
    "/var/lib/caddy/.local/share/caddy/certificates"
    "/root/.local/share/caddy/certificates"
  )
  CADDY_CERT_DIR=""

  log "  Ждём сертификат от Caddy (до 150с, любой CA)..."
  for i in $(seq 1 75); do
    for ROOT in "${CADDY_CERT_ROOTS[@]}"; do
      [[ -d "$ROOT" ]] || continue
      FOUND=$(find "$ROOT" -type f -name "${DOMAIN}.crt" 2>/dev/null | head -1)
      if [[ -n "$FOUND" && -f "${FOUND%.crt}.key" ]]; then
        CADDY_CERT_DIR="$(dirname "$FOUND")"
        CA_NAME="$(basename "$(dirname "$CADDY_CERT_DIR")")"
        log "✅ Сертификат найден (${i}х2 с) — CA: ${CA_NAME}"
        break 2
      fi
    done
    sleep 2
  done

  if [[ -z "$CADDY_CERT_DIR" ]]; then
    log "⚠ Сертификат Caddy не найден за 150с."
    log "  Hy2 НЕ запускается с собственным ACME (риск Let's Encrypt 429)."
    log "  Почините Caddy, потом: systemctl restart hysteria-server"
    cat >> /etc/hysteria/config.yaml << 'HYNOTLSEOF'
# ⚠ Сертификат не был готов при установке.
# После починки Caddy:
#   1) find /var/lib/caddy -name '*.crt'
#   2) tls:
#        cert: /var/lib/caddy/.../<domain>.crt
#        key:  /var/lib/caddy/.../<domain>.key
#   3) systemctl restart hysteria-server
HYNOTLSEOF
  else
    chmod -R 755 "$(dirname "$CADDY_CERT_DIR")" 2>/dev/null || true
    chmod 644 "${CADDY_CERT_DIR}/${DOMAIN}.crt" 2>/dev/null || true
    chmod 640 "${CADDY_CERT_DIR}/${DOMAIN}.key" 2>/dev/null || true

    cat >> /etc/hysteria/config.yaml << HYTLSEOF

tls:
  cert: ${CADDY_CERT_DIR}/${DOMAIN}.crt
  key:  ${CADDY_CERT_DIR}/${DOMAIN}.key
HYTLSEOF

    # Watcher: при обновлении сертификата Caddy → рестарт Hy2.
    cat > /etc/systemd/system/caddy-cert-watcher.path << WATCHEOF
[Unit]
Description=Watch Caddy cert for changes -> restart hysteria-server

[Path]
PathModified=${CADDY_CERT_DIR}

[Install]
WantedBy=multi-user.target
WATCHEOF

    cat > /etc/systemd/system/caddy-cert-watcher.service << 'WATCHSVCEOF'
[Unit]
Description=Restart hysteria-server on Caddy cert change

[Service]
Type=oneshot
ExecStart=/bin/systemctl restart hysteria-server.service
WATCHSVCEOF

    systemctl daemon-reload
    systemctl enable caddy-cert-watcher.path >/dev/null 2>&1 || true
    systemctl start  caddy-cert-watcher.path >/dev/null 2>&1 || true
    log "✅ caddy-cert-watcher настроен"
  fi

else
  # Standalone Hy2: собственный ACME-сертификат (порт 80 должен быть свободен).
  cat >> /etc/hysteria/config.yaml << HYACMEEOF

acme:
  domains:
    - ${DOMAIN}
  email: ${EMAIL}
  ca: letsencrypt
  listenHost: 0.0.0.0
HYACMEEOF
fi

cat >> /etc/hysteria/config.yaml << 'HYBWEOF'

ignoreClientBandwidth: true

quic:
  initStreamReceiveWindow: 8388608
  maxStreamReceiveWindow: 8388608
  initConnReceiveWindow: 20971520
  maxConnReceiveWindow: 20971520
  maxIdleTimeout: 30s
  keepAlivePeriod: 10s
  disablePathMTUDiscovery: false
HYBWEOF

log "✅ Конфиг /etc/hysteria/config.yaml создан (порт ${HY_PORT}/udp)"

# ══════════════════════════════════════════════════════
step 6
log "▶ Systemd сервис Hysteria..."
# ══════════════════════════════════════════════════════

if [[ "$USE_CADDY_CERT" == "1" ]]; then
  HY_AFTER="After=network.target network-online.target caddy-naive.service"
  HY_WANTS="Wants=caddy-naive.service"
else
  HY_AFTER="After=network.target network-online.target"
  HY_WANTS=""
fi

cat > /etc/systemd/system/hysteria-server.service << HYSVCEOF
[Unit]
Description=Hysteria2 Server (by RIXXX)
Documentation=https://v2.hysteria.network/
${HY_AFTER}
${HY_WANTS}
Requires=network-online.target
StartLimitIntervalSec=60s
StartLimitBurst=3

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/local/bin/hysteria server --config /etc/hysteria/config.yaml
WorkingDirectory=/etc/hysteria
LimitNOFILE=1048576
LimitNPROC=512
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
HYSVCEOF

systemctl daemon-reload
systemctl enable hysteria-server >/dev/null 2>&1 || true

log "✅ Systemd сервис создан"

# ══════════════════════════════════════════════════════
step 7
log "▶ Запуск Hysteria2..."
# ══════════════════════════════════════════════════════

systemctl restart hysteria-server 2>&1 || true

for i in $(seq 1 20); do
  STATUS=$(systemctl is-active hysteria-server 2>/dev/null || echo "unknown")
  if [[ "$STATUS" == "active" ]]; then
    log "✅ Hysteria2 запущена (${i}с)"
    break
  elif [[ "$STATUS" == "failed" ]]; then
    log "⚠ hysteria-server: failed — смотрите ниже:"
    journalctl -u hysteria-server -n 20 --no-pager 2>/dev/null || true
    systemctl reset-failed hysteria-server 2>/dev/null || true
    systemctl start hysteria-server 2>/dev/null || true
    break
  fi
  sleep 1
  if [[ $i -eq 20 ]]; then
    log "⚠ Hy2 не запустилась за 20с. Диагностика:"
    log "  journalctl -u hysteria-server -n 50 --no-pager"
  fi
done

step DONE
log ""
log "╔════════════════════════════════════════════════════╗"
log "║   ✅ Hysteria2 успешно установлен!                 ║"
log "║   Домен: ${DOMAIN}"
log "║   Порт : ${HY_PORT}/udp"
log "║   hysteria2://****@${DOMAIN}:${HY_PORT}?sni=${DOMAIN}"
log "╚════════════════════════════════════════════════════╝"
log ""

exit 0
