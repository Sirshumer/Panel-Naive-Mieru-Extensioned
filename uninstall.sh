#!/usr/bin/env bash
# ==============================================================================
# Panel Naive + Mieru by RIXXX — uninstall.sh  v1.2.5
# Removes all panel components, services, configs, and data.
#
# v1.2.3: Full cleanup for caddy-forwardproxy-naive migration.
# v1.2.5: Also removes /var/lib/caddy (ACME cert storage, Bug 43).
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_step()  { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }
die()       { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] && die "Run as root (sudo bash uninstall.sh)"

echo -e "\n${RED}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${RED}${BOLD}║   Panel Naive + Mieru — UNINSTALL  v1.2.5                ║${NC}"
echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}\n"

echo -e "${YELLOW}${BOLD}WARNING:${NC} This will permanently remove ALL panel data, users,"
echo -e "         configurations, binaries, and log files."
echo ""
read -rp "Type 'yes' to confirm uninstall: " CONFIRM
[[ "$CONFIRM" != "yes" ]] && { log_info "Aborted."; exit 0; }

# ── Stop and disable services ─────────────────────────────────────────────────
log_step "Stopping and disabling services"

# PM2 panel process
pm2 stop   panel-naive-mieru 2>/dev/null || true
pm2 delete panel-naive-mieru 2>/dev/null || true
pm2 save   2>/dev/null || true
log_info "PM2 panel process removed ✓"

# v1.2.3 primary: caddy-naive.service
if systemctl is-active caddy-naive &>/dev/null 2>&1 || \
   systemctl is-enabled caddy-naive &>/dev/null 2>&1; then
  systemctl stop    caddy-naive 2>/dev/null || true
  systemctl disable caddy-naive 2>/dev/null || true
  log_info "caddy-naive.service stopped and disabled ✓"
fi

# Legacy v1.2.x: naive.service
if systemctl is-active naive &>/dev/null 2>&1 || \
   systemctl is-enabled naive &>/dev/null 2>&1; then
  systemctl stop    naive 2>/dev/null || true
  systemctl disable naive 2>/dev/null || true
  log_info "naive.service (legacy) stopped and disabled ✓"
fi

# mita: stop but keep mita package installed (user choice below)
systemctl stop mita 2>/dev/null || true
log_info "mita stopped ✓"

# ── Remove systemd unit files ─────────────────────────────────────────────────
log_step "Removing systemd unit files"
rm -f /etc/systemd/system/caddy-naive.service   # v1.2.3
rm -f /etc/systemd/system/naive.service         # v1.2.x legacy
# Note: mita.service is managed by its .deb package — not removed here
systemctl daemon-reload
log_info "Systemd units removed ✓"

# ── Remove binaries ───────────────────────────────────────────────────────────
log_step "Removing binaries"
# v1.2.3: caddy-forwardproxy-naive binary
if [[ -f /usr/local/bin/caddy-naive ]]; then
  rm -f /usr/local/bin/caddy-naive
  log_info "/usr/local/bin/caddy-naive removed ✓"
fi
# v1.2.x legacy: standalone naive binary
if [[ -f /usr/local/bin/naive ]]; then
  rm -f /usr/local/bin/naive
  log_info "/usr/local/bin/naive (legacy) removed ✓"
fi
log_info "Binaries removed ✓"

# ── Remove configuration directories ─────────────────────────────────────────
log_step "Removing configuration directories"
# v1.2.3: Caddy config dir (Caddyfile, probe_secret, version)
if [[ -d /etc/caddy-naive ]]; then
  rm -rf /etc/caddy-naive
  log_info "/etc/caddy-naive removed ✓"
fi
# v1.2.x legacy: naive config dir (config.json, htpasswd)
if [[ -d /etc/naive ]]; then
  rm -rf /etc/naive
  log_info "/etc/naive (legacy) removed ✓"
fi
# Panel config
rm -rf /etc/rixxx-panel
log_info "/etc/rixxx-panel removed ✓"
log_info "Configuration directories removed ✓"

# ── Remove fake site ──────────────────────────────────────────────────────────
log_step "Removing fake site"
if [[ -d /var/www/fake-site ]]; then
  rm -rf /var/www/fake-site
  log_info "/var/www/fake-site removed ✓"
else
  log_info "Fake site directory not found (skipped)"
fi

# ── Remove panel directory ────────────────────────────────────────────────────
log_step "Removing panel files"
if [[ -d /opt/panel-naive-mieru ]]; then
  rm -rf /opt/panel-naive-mieru
  log_info "/opt/panel-naive-mieru removed ✓"
fi
log_info "Panel files removed ✓"

# ── Remove database and runtime data ─────────────────────────────────────────
log_step "Removing database and runtime data"
if [[ -f /var/lib/rixxx-panel/db.sqlite ]]; then
  shred -u /var/lib/rixxx-panel/db.sqlite 2>/dev/null || \
    rm -f /var/lib/rixxx-panel/db.sqlite
  log_info "SQLite database securely removed ✓"
fi
rm -rf /var/lib/rixxx-panel
# Bug 43 / v1.2.5: /var/lib/caddy stores ACME TLS certificates — remove on uninstall
rm -rf /var/lib/caddy 2>/dev/null || true
log_info "Runtime data removed ✓"

# ── Remove logs ───────────────────────────────────────────────────────────────
log_step "Removing logs"
rm -rf /var/log/caddy-naive                    # v1.2.3 caddy access logs
rm -rf /var/log/naive                          # v1.2.x legacy naive logs
rm -f  /var/log/panel-naive-mieru.log          # PM2 panel log
rm -f  /var/log/rixxx-panel-install.log        # install log
log_info "Logs removed ✓"

# ── Remove Certbot renewal hook (v1.2.x legacy) ───────────────────────────────
if [[ -f /etc/letsencrypt/renewal-hooks/deploy/restart-naive.sh ]]; then
  rm -f /etc/letsencrypt/renewal-hooks/deploy/restart-naive.sh
  log_info "Certbot renewal hook removed ✓"
fi

# ── Remove sysctl tuning ──────────────────────────────────────────────────────
if [[ -f /etc/sysctl.d/99-rixxx-panel.conf ]]; then
  rm -f /etc/sysctl.d/99-rixxx-panel.conf
  sysctl -p /etc/sysctl.conf 2>/dev/null || true
  log_info "Sysctl tuning removed ✓"
fi

# ── UFW cleanup (optional) ────────────────────────────────────────────────────
echo ""
read -rp "Remove UFW rules added by the panel? [y/N]: " UFW_CLEAN
if [[ "${UFW_CLEAN^^}" == "Y" ]]; then
  log_step "Cleaning UFW rules"
  # v1.2.3 rules
  ufw delete allow comment "CaddyNaive HTTPS"  2>/dev/null || true
  # v1.2.x legacy rules
  ufw delete allow comment "NaiveProxy HTTPS"  2>/dev/null || true
  # Common rules
  ufw delete allow comment "Mieru TCP"         2>/dev/null || true
  ufw delete allow comment "Mieru UDP"         2>/dev/null || true
  ufw delete allow comment "Panel Web UI"      2>/dev/null || true
  ufw delete allow comment "Certbot HTTP-01"   2>/dev/null || true
  ufw delete allow 8080/tcp                    2>/dev/null || true
  log_info "UFW rules cleaned ✓"
fi

# ── Optional: remove mita package ────────────────────────────────────────────
echo ""
read -rp "Also remove the mita (Mieru) package via apt? [y/N]: " REMOVE_MITA
if [[ "${REMOVE_MITA^^}" == "Y" ]]; then
  log_step "Removing mita package"
  apt-get remove -y mita 2>/dev/null || true
  apt-get autoremove -y  2>/dev/null || true
  rm -rf /etc/mita       2>/dev/null || true
  log_info "mita package removed ✓"
fi

# ── Final summary ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║   Uninstall complete ✓                                    ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Removed:${NC}"
echo -e "    • caddy-naive binary + service + Caddyfile"
echo -e "    • Legacy naive binary + service (v1.2.x)"
echo -e "    • Panel files (/opt/panel-naive-mieru)"
echo -e "    • Configuration (/etc/rixxx-panel, /etc/caddy-naive)"
echo -e "    • Fake site (/var/www/fake-site)"
echo -e "    • Database (/var/lib/rixxx-panel/db.sqlite)"
echo -e "    • Logs (/var/log/caddy-naive, /var/log/panel-naive-mieru.log)"
echo ""
echo -e "  ${BOLD}Still installed:${NC}"
[[ "${REMOVE_MITA^^}" != "Y" ]] && \
  echo -e "    • Mieru (mita) — remove with: ${CYAN}apt remove mita${NC}"
echo -e "    • Node.js and PM2 — remove with: ${CYAN}npm uninstall -g pm2 && apt remove nodejs${NC}"
echo -e "    • Let's Encrypt certificates — preserved at /etc/letsencrypt/ (if any)"
echo ""
