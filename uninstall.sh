#!/usr/bin/env bash
# ==============================================================================
# Panel Naive + Mieru by RIXXX — uninstall.sh  v1.2.0
# Removes all panel components, services, and configs.
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_step()  { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }
die()       { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] && die "Run as root"

echo -e "\n${RED}${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${RED}${BOLD}║   Panel Naive + Mieru — UNINSTALL  v1.2.0            ║${NC}"
echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════╝${NC}\n"

echo -e "${YELLOW}WARNING: This will remove all panel data, users, and configurations.${NC}"
read -rp "Are you sure? Type 'yes' to confirm: " CONFIRM
[[ "$CONFIRM" != "yes" ]] && { log_info "Aborted."; exit 0; }

# ── Stop and disable services ─────────────────────────────────
log_step "Stopping services"
pm2 stop panel-naive-mieru   2>/dev/null || true
pm2 delete panel-naive-mieru 2>/dev/null || true
pm2 save 2>/dev/null || true

# New: naive.service
systemctl stop    naive 2>/dev/null || true
systemctl disable naive 2>/dev/null || true

# Legacy: caddy-naive (migration cleanup)
systemctl stop    caddy-naive 2>/dev/null || true
systemctl disable caddy-naive 2>/dev/null || true

# mita
systemctl stop    mita 2>/dev/null || true
# Note: mita .deb manages its own service; we leave mita installed

# ── Remove systemd units ──────────────────────────────────────
log_step "Removing systemd units"
rm -f /etc/systemd/system/naive.service
rm -f /etc/systemd/system/caddy-naive.service   # legacy cleanup
systemctl daemon-reload
log_info "Systemd units removed ✓"

# ── Remove binaries ───────────────────────────────────────────
log_step "Removing binaries"
rm -f /usr/local/bin/naive
rm -f /usr/local/bin/caddy-naive   # legacy cleanup
log_info "Binaries removed ✓"

# ── Remove config directories ─────────────────────────────────
log_step "Removing configuration"
rm -rf /etc/naive             # new naive config dir
rm -rf /etc/caddy-naive       # legacy caddy-naive dir (migration cleanup)
rm -rf /etc/rixxx-panel
log_info "Config directories removed ✓"

# ── Remove panel directory ────────────────────────────────────
log_step "Removing panel files"
rm -rf /opt/panel-naive-mieru
log_info "Panel files removed ✓"

# ── Remove database ───────────────────────────────────────────
log_step "Removing database"
shred -u /var/lib/rixxx-panel/db.sqlite 2>/dev/null || \
  rm -f /var/lib/rixxx-panel/db.sqlite
rm -rf /var/lib/rixxx-panel
log_info "Database removed ✓"

# ── Remove logs ───────────────────────────────────────────────
log_step "Removing logs"
rm -rf /var/log/naive
rm -rf /var/log/caddy-naive   # legacy
rm -f  /var/log/panel-naive-mieru.log
rm -f  /var/log/rixxx-panel-install.log
log_info "Logs removed ✓"

# ── Remove Certbot renewal hook ───────────────────────────────
rm -f /etc/letsencrypt/renewal-hooks/deploy/restart-naive.sh 2>/dev/null || true

# ── Remove sysctl tuning ──────────────────────────────────────
rm -f /etc/sysctl.d/99-rixxx-panel.conf
sysctl -p /etc/sysctl.conf 2>/dev/null || true

# ── UFW cleanup (optional) ────────────────────────────────────
read -rp "Remove UFW rules added by the panel? [y/N]: " UFW_CLEAN
if [[ "${UFW_CLEAN^^}" == "Y" ]]; then
  log_step "Cleaning UFW rules"
  ufw delete allow comment "NaiveProxy HTTPS" 2>/dev/null || true
  ufw delete allow comment "Mieru TCP"        2>/dev/null || true
  ufw delete allow comment "Mieru UDP"        2>/dev/null || true
  ufw delete allow comment "Panel Web UI"     2>/dev/null || true
  ufw delete allow comment "Certbot HTTP-01"  2>/dev/null || true
  ufw delete allow 8080/tcp 2>/dev/null || true
  log_info "UFW rules cleaned"
fi

echo ""
echo -e "${GREEN}${BOLD}✓ Uninstall complete.${NC}"
echo ""
echo -e "  Notes:"
echo -e "  - Mieru (mita) is still installed. To remove: ${CYAN}apt remove mita${NC}"
echo -e "  - Node.js and PM2 are still installed."
echo -e "  - Mieru config at /etc/mita/ is preserved."
echo -e "  - Let's Encrypt certificates preserved at /etc/letsencrypt/ (if any)."
echo ""
