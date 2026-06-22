#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# warp_egress.sh — Cloudflare WARP as a server-wide EGRESS mode for RIXXX panel.
#
# Goal: route ALL of the server's OUTBOUND traffic through Cloudflare WARP so the
# server's real IP is never exposed to upstream destinations (privacy + IP-block
# evasion). Inbound NaiveProxy/Mieru connections keep working: WireGuard's
# fwmark/policy-routing (wg-quick `Table = auto`) sends only locally-originated
# traffic out via WARP, while replies to inbound sockets follow their original
# route, and the WARP UDP endpoint itself is excluded from the tunnel (anti-loop).
#
# Mode is server-wide (NOT per-user, NOT per-key). It is MUTUALLY EXCLUSIVE with
# the Mieru cascade — the panel guarantees only one egress mode is ever active.
#
# Usage:
#   warp_egress.sh setup            # register (if needed) + generate + wg up
#   warp_egress.sh teardown         # wg down + remove route artifacts (idempotent)
#   warp_egress.sh status           # JSON-ish status incl. measured egress IP
#   warp_egress.sh egress-ip        # just print the current public egress IP
#
# Idempotent: re-running setup re-applies cleanly; teardown leaves a clean host
# with NO leftover routes / rules / interfaces (lesson from BUG-150: a partial
# teardown that leaves routing artifacts breaks the box). Survives reboot via the
# wg-quick@warp systemd unit.
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail

WG_IFACE="warp"
WG_CONF="/etc/wireguard/${WG_IFACE}.conf"
WGCF_DIR="/etc/rixxx-panel/warp"
WGCF_ACCOUNT="${WGCF_DIR}/wgcf-account.toml"
WGCF_PROFILE="${WGCF_DIR}/wgcf-profile.conf"
WARP_ENDPOINT_HOST="engage.cloudflareclient.com"

log() { echo "[warp] $*"; }
err() { echo "[warp][ERROR] $*" >&2; }
die() { err "$*"; exit 1; }

# ── arch → wgcf release asset ────────────────────────────────────────────────
wgcf_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "linux_amd64" ;;
    aarch64|arm64) echo "linux_arm64" ;;
    armv7l|armv7)  echo "linux_armv7" ;;
    *)             echo "linux_amd64" ;;
  esac
}

# ── lazy install: wgcf + wireguard-tools + resolvconf ────────────────────────
ensure_packages() {
  if ! command -v wg-quick &>/dev/null; then
    log "installing wireguard-tools…"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq wireguard-tools 2>/dev/null || apt-get install -y wireguard-tools || \
      die "failed to install wireguard-tools"
  fi
  # resolvconf lets wg-quick apply DNS = … without clobbering the system resolver.
  command -v resolvconf &>/dev/null || \
    apt-get install -y -qq openresolv 2>/dev/null || apt-get install -y -qq resolvconf 2>/dev/null || true

  if ! command -v wgcf &>/dev/null; then
    log "installing wgcf…"
    local arch ver url tmp
    arch="$(wgcf_arch)"
    # Pin to a known wgcf release; fall back to 'latest' redirect if the API is reachable.
    ver="2.2.22"
    url="https://github.com/ViRb3/wgcf/releases/download/v${ver}/wgcf_${ver}_${arch}"
    tmp="$(mktemp)"
    if ! curl -fsSL --max-time 60 -o "$tmp" "$url" 2>/dev/null; then
      # Try latest as a fallback.
      url="https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_${ver}_${arch}"
      curl -fsSL --max-time 60 -o "$tmp" "$url" 2>/dev/null || die "failed to download wgcf"
    fi
    install -m 0755 "$tmp" /usr/local/bin/wgcf || die "failed to install wgcf binary"
    rm -f "$tmp"
  fi
}

# ── ensure WARP account + WireGuard profile exist ─────────────────────────────
ensure_profile() {
  mkdir -p "$WGCF_DIR"
  chmod 700 "$WGCF_DIR"
  if [[ ! -f "$WGCF_ACCOUNT" ]]; then
    log "registering a free Cloudflare WARP account…"
    ( cd "$WGCF_DIR" && WGCF_LICENSE_KEY="" yes | wgcf register --accept-tos ) \
      || die "wgcf register failed"
  fi
  log "generating WireGuard profile…"
  ( cd "$WGCF_DIR" && wgcf generate ) || die "wgcf generate failed"
  [[ -f "$WGCF_PROFILE" ]] || die "wgcf profile not generated"
}

# ── build /etc/wireguard/warp.conf from the wgcf profile ─────────────────────
# We take the wgcf profile and harden it for a server egress:
#   • Table = auto    → wg-quick installs default routes + fwmark suppress rules,
#                       which is exactly what protects inbound sockets & endpoint.
#   • PostUp/PreDown  → add/remove an explicit RETURN-style exclusion is NOT
#                       needed because wg-quick already excludes the endpoint, but
#                       we DISABLE the wg-quick DNS push on low-RAM/headless boxes
#                       only if resolvconf is missing (avoids a hard failure).
build_wg_conf() {
  [[ -f "$WGCF_PROFILE" ]] || die "no wgcf profile to build from"
  mkdir -p /etc/wireguard
  # Strip any DNS line if resolvconf is unavailable (wg-quick would fail otherwise).
  if command -v resolvconf &>/dev/null; then
    cp "$WGCF_PROFILE" "$WG_CONF"
  else
    grep -v -i '^[[:space:]]*DNS' "$WGCF_PROFILE" > "$WG_CONF"
  fi
  chmod 600 "$WG_CONF"
  log "wrote ${WG_CONF}"
}

# ── bring the tunnel up via the persistent systemd unit (survives reboot) ─────
warp_up() {
  # Stop any stale instance first so re-setup is clean.
  systemctl stop "wg-quick@${WG_IFACE}" 2>/dev/null || true
  ip link del "$WG_IFACE" 2>/dev/null || true

  systemctl enable "wg-quick@${WG_IFACE}" 2>/dev/null || true
  if ! systemctl start "wg-quick@${WG_IFACE}" 2>/dev/null; then
    # Fall back to a direct wg-quick up if the unit is unavailable.
    wg-quick up "$WG_IFACE" || die "wg-quick up failed"
  fi
}

# ── full, idempotent teardown — leave NO artifacts ────────────────────────────
warp_down() {
  systemctl stop "wg-quick@${WG_IFACE}" 2>/dev/null || true
  systemctl disable "wg-quick@${WG_IFACE}" 2>/dev/null || true
  # Direct down in case it was started outside systemd.
  wg-quick down "$WG_IFACE" 2>/dev/null || true
  # Hard-remove the interface if anything is left behind.
  ip link del "$WG_IFACE" 2>/dev/null || true
  # Remove any leftover wg-quick policy rules / fwmark routes for this iface.
  # wg-quick uses fwmark 0xca6c by default; clean the rule+table if it lingers.
  local mark="0xca6c"
  while ip rule show 2>/dev/null | grep -q "fwmark ${mark}"; do
    ip rule del fwmark "${mark}" 2>/dev/null || break
  done
  ip route flush table "$((16#ca6c))" 2>/dev/null || true
  # Remove the generated interface config so a stale conf can't be re-applied.
  rm -f "$WG_CONF"
  log "WARP egress torn down (interface, routes, rules, conf removed)"
}

# ── measure the public egress IP (what the world sees) ───────────────────────
measure_egress_ip() {
  local ip=""
  ip="$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null)"
  [[ -z "$ip" ]] && ip="$(curl -s --max-time 8 https://ifconfig.me 2>/dev/null)"
  echo "$ip"
}

# Cloudflare's own trace endpoint reports warp=on/off + the egress IP.
warp_trace() {
  curl -s --max-time 8 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null
}

# ─────────────────────────────────────────────────────────────────────────────
do_setup() {
  ensure_packages
  ensure_profile
  build_wg_conf
  warp_up
  sleep 2
  do_status || true
}

do_teardown() {
  warp_down
}

do_status() {
  local active="inactive" handshake="" egress="" warp_flag=""
  if ip link show "$WG_IFACE" &>/dev/null; then
    active="active"
    handshake="$(wg show "$WG_IFACE" latest-handshakes 2>/dev/null | awk '{print $2}' | head -1)"
  fi
  egress="$(measure_egress_ip)"
  warp_flag="$(warp_trace | awk -F= '/^warp=/{print $2}')"
  echo "iface        : ${WG_IFACE}"
  echo "state        : ${active}"
  echo "handshake    : ${handshake:-none}"
  echo "egressIP     : ${egress:-unknown}"
  echo "warp         : ${warp_flag:-unknown}"
  # exit 0 if the interface is up; non-zero otherwise (callers may ignore).
  [[ "$active" == "active" ]]
}

ACTION="${1:-}"
case "$ACTION" in
  setup)     do_setup ;;
  teardown)  do_teardown ;;
  status)    do_status ;;
  egress-ip) measure_egress_ip ;;
  *) die "unknown action '$ACTION' (use: setup|teardown|status|egress-ip)" ;;
esac
