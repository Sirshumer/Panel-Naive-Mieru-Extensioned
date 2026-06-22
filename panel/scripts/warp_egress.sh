#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# warp_egress.sh — Cloudflare WARP as a server-wide EGRESS mode for RIXXX panel.
#
# Goal: route the server's OUTBOUND traffic through Cloudflare WARP so the real
# server IP is hidden from upstream destinations (privacy + IP-block evasion).
#
# BUG-162 (CRITICAL): in v1.5.1 enabling WARP routed EVERYTHING (AllowedIPs
#   0.0.0.0/0, wg-quick Table=auto) into the tunnel — including the SSH and panel
#   MANAGEMENT channels — so the operator lost all access (only the hoster console
#   recovered the box). Worse, the unit was `systemctl enable`d, so a reboot
#   brought the server down AGAIN automatically.
#
#   Fix: we NO LONGER let wg-quick install a blanket default route. Instead we use
#   `Table = off` (wg-quick touches NOTHING in the routing tables) and install our
#   OWN policy routing in PostUp/PreDown:
#     • a dedicated route table (RT_TABLE) whose default route is the WARP iface
#     • a low-priority ip rule that sends traffic to that table
#     • HIGH-PRIORITY exception rules (evaluated FIRST) that keep the management
#       plane on the MAIN table: SSH port, panel port, the local subnet, the
#       default gateway, the WARP endpoint itself, and — crucially — replies to
#       any INBOUND/ESTABLISHED connection (so SSH/panel sessions never break).
#   Result: only locally-originated egress (the proxy's upstream traffic) goes via
#   WARP; the control channel always uses the native route. If the tunnel dies,
#   management access SURVIVES (the exception rules + main table remain).
#
# Mode is server-wide (NOT per-user, NOT per-key). It is MUTUALLY EXCLUSIVE with
# the Mieru cascade — the panel guarantees only one egress mode is ever active.
#
# Autostart: NOT enabled by default (BUG-162). The unit is only `systemctl enable`d
#   when WARP_PERSIST=1 is set (the panel sets it only on explicit operator
#   confirmation). Otherwise WARP does not come back after a reboot, so a bad
#   tunnel can never silently re-down the box on restart.
#
# Usage:
#   warp_egress.sh setup            # register (if needed) + generate + wg up
#   warp_egress.sh teardown         # wg down + remove route artifacts (idempotent)
#   warp_egress.sh status           # JSON-ish status incl. measured egress IP
#   warp_egress.sh egress-ip        # just print the current public egress IP
#
# Env (optional, supplied by the panel):
#   WARP_SSH_PORT    SSH port to keep on the native route   (default: detected/22)
#   WARP_PANEL_PORT  panel port to keep on the native route (default: 3000)
#   WARP_PERSIST     "1" → enable autostart on boot         (default: off)
#
# Idempotent: re-running setup re-applies cleanly; teardown leaves a clean host
# with NO leftover routes / rules / interfaces (lesson from BUG-150).
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail

# Absolute path to THIS script — embedded into the wg conf PostUp/PreDown so
# wg-quick (run by systemd at boot too) can call back for policy routing.
WARP_SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "$0")"

WG_IFACE="warp"
WG_CONF="/etc/wireguard/${WG_IFACE}.conf"
WGCF_DIR="/etc/rixxx-panel/warp"
WGCF_ACCOUNT="${WGCF_DIR}/wgcf-account.toml"
WGCF_PROFILE="${WGCF_DIR}/wgcf-profile.conf"
WARP_ENDPOINT_HOST="engage.cloudflareclient.com"

# BUG-162 policy-routing constants. We pick fixed, high (=evaluated-first) priority
# ip-rule numbers for the management-plane exceptions, and a single low-priority
# rule that finally sends everything else into the WARP table.
RT_TABLE="51820"            # dedicated route table id for WARP default route
RT_NAME="warp"
PRIO_EXCEPT_BASE="9000"     # exception rules (lower number = higher priority)
PRIO_DEFAULT="9500"         # "everything else → WARP table" rule
MARK_CONN="0x5152"          # conntrack mark for inbound/established (keep native)

# Management ports to keep on the native route (overridable via env from panel).
SSH_PORT="${WARP_SSH_PORT:-}"
PANEL_PORT="${WARP_PANEL_PORT:-3000}"

log() { echo "[warp] $*"; }
err() { echo "[warp][ERROR] $*" >&2; }
die() { err "$*"; exit 1; }

# Detect the active SSH port(s) from sshd config / listening sockets; default 22.
detect_ssh_port() {
  local p=""
  p="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/{print $2}' /etc/ssh/sshd_config 2>/dev/null | head -1)"
  [[ -z "$p" ]] && p="$(ss -tlnp 2>/dev/null | awk '/sshd/{split($4,a,":"); print a[length(a)]}' | head -1)"
  [[ -z "$p" ]] && p="22"
  echo "$p"
}

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
# BUG-161 (v1.5.1): detect whether the host actually has working IPv6. Many VPS
#   are IPv4-only (IPv6 disabled in the kernel). The wgcf profile always ships an
#   IPv6 Address + `AllowedIPs = ::/0`; wg-quick then runs `ip -6 address add …`
#   which fails ("IPv6 is disabled on this device") and rolls the WHOLE interface
#   back, so the tunnel never comes up. We strip every IPv6 bit from the conf when
#   the host has no IPv6, bringing WARP up IPv4-only.
host_has_ipv6() {
  # Kernel IPv6 fully disabled?
  if [[ -f /proc/sys/net/ipv6/conf/all/disable_ipv6 ]] \
     && [[ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)" == "1" ]]; then
    return 1
  fi
  # No /proc/net/if_inet6 → no IPv6 stack at all.
  [[ -e /proc/net/if_inet6 ]] || return 1
  # Need at least one usable (global or link) IPv6 address on some interface.
  ip -6 addr show scope global 2>/dev/null | grep -q "inet6" && return 0
  ip -6 addr show 2>/dev/null | grep -q "inet6" && return 0
  return 1
}

build_wg_conf() {
  [[ -f "$WGCF_PROFILE" ]] || die "no wgcf profile to build from"
  mkdir -p /etc/wireguard

  [[ -z "$SSH_PORT" ]] && SSH_PORT="$(detect_ssh_port)"

  # 1) start from the wgcf [Interface]/[Peer] keys, dropping DNS (we manage our
  #    own routing and don't want resolvconf surprises on headless boxes) and the
  #    profile's Address/AllowedIPs (we rebuild them below, hardened).
  local IFACE_PRIV IFACE_ADDR4 PEER_PUB PEER_PSK PEER_EP
  IFACE_PRIV="$(awk -F'=' '/^[[:space:]]*PrivateKey[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WGCF_PROFILE")"
  PEER_PUB="$(awk -F'=' '/^[[:space:]]*PublicKey[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WGCF_PROFILE")"
  PEER_PSK="$(awk -F'=' '/^[[:space:]]*PresharedKey[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WGCF_PROFILE")"
  PEER_EP="$(awk -F'=' '/^[[:space:]]*Endpoint[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WGCF_PROFILE")"
  # IPv4 interface address only (BUG-161: skip IPv6 to avoid the failing add).
  IFACE_ADDR4="$(awk '/^[[:space:]]*Address[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0); n=split($0,a,/[[:space:]]*,[[:space:]]*/); for(i=1;i<=n;i++){if(index(a[i],":")==0){print a[i]; exit}}}' "$WGCF_PROFILE")"
  [[ -z "$IFACE_ADDR4" ]] && IFACE_ADDR4="172.16.0.2/32"
  [[ -z "$IFACE_PRIV" || -z "$PEER_PUB" || -z "$PEER_EP" ]] && die "wgcf profile missing keys/endpoint"

  local v6=0
  host_has_ipv6 && v6=1
  [[ "$v6" == "1" ]] && log "IPv6 detected (kept IPv4-only routing anyway for safety)" \
                     || log "no usable IPv6 on host — IPv4-only WARP config"

  # 2) write a self-contained conf with Table=off (wg-quick must NOT touch the
  #    routing tables) and our own PostUp/PreDown policy routing.
  #    AllowedIPs stays 0.0.0.0/0 (the crypto-routing scope: which dst the peer
  #    accepts) but Table=off means it does NOT become a default route — WE add a
  #    scoped default only in RT_TABLE, with management exceptions in main.
  {
    echo "# Generated by warp_egress.sh (BUG-162: Table=off + scoped policy routing)"
    echo "[Interface]"
    echo "PrivateKey = ${IFACE_PRIV}"
    echo "Address = ${IFACE_ADDR4}"
    echo "Table = off"
    echo "PostUp = ${WARP_SELF} route-up %i"
    echo "PreDown = ${WARP_SELF} route-down %i"
    echo ""
    echo "[Peer]"
    echo "PublicKey = ${PEER_PUB}"
    [[ -n "$PEER_PSK" ]] && echo "PresharedKey = ${PEER_PSK}"
    echo "AllowedIPs = 0.0.0.0/0"
    echo "Endpoint = ${PEER_EP}"
    echo "PersistentKeepalive = 25"
  } > "$WG_CONF"

  chmod 600 "$WG_CONF"
  log "wrote ${WG_CONF} (Table=off, SSH=${SSH_PORT}, panel=${PANEL_PORT})"
}

# ── default gateway / local subnet / WARP endpoint helpers ───────────────────
default_gw()    { ip route show default 2>/dev/null | awk '/default/{print $3; exit}'; }
default_dev()   { ip route show default 2>/dev/null | awk '/default/{print $5; exit}'; }
local_subnet()  {
  local dev; dev="$(default_dev)"
  [[ -z "$dev" ]] && return 0
  ip -o -4 addr show dev "$dev" 2>/dev/null | awk '{print $4; exit}'
}
warp_endpoint_ip() {
  # The literal endpoint IP must stay on the NATIVE route (anti-loop).
  local ep host; ep="$(awk -F'=' '/^[[:space:]]*Endpoint[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WG_CONF" 2>/dev/null)"
  host="${ep%%:*}"
  if [[ "$host" =~ ^[0-9.]+$ ]]; then echo "$host"
  else getent hosts "$host" 2>/dev/null | awk '{print $1; exit}'; fi
}

# ── BUG-162: install scoped policy routing — only egress via WARP, control plane
#    (SSH/panel/local/gateway/established) stays on the native route. ───────────
route_up() {
  local dev="${1:-$WG_IFACE}"
  [[ -z "$SSH_PORT" ]] && SSH_PORT="$(detect_ssh_port)"

  # 1) WARP default route lives ONLY in our dedicated table.
  ip route replace default dev "$dev" table "$RT_TABLE" 2>/dev/null \
    || ip route add default dev "$dev" table "$RT_TABLE" 2>/dev/null || true

  # 2) Keep replies to INBOUND/ESTABLISHED connections on the native route, so
  #    active SSH/panel/proxy-client sessions are never hijacked into the tunnel.
  #    Mark such packets with conntrack and steer the mark to main.
  if command -v iptables &>/dev/null; then
    iptables -t mangle -C OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j CONNMARK --restore-mark 2>/dev/null \
      || iptables -t mangle -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j CONNMARK --restore-mark 2>/dev/null || true
    # SSH + panel inbound → save a connmark so their replies stay native.
    iptables -t mangle -C INPUT -p tcp --dport "$SSH_PORT" -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null \
      || iptables -t mangle -A INPUT -p tcp --dport "$SSH_PORT" -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    iptables -t mangle -C INPUT -p tcp --dport "$PANEL_PORT" -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null \
      || iptables -t mangle -A INPUT -p tcp --dport "$PANEL_PORT" -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
  fi

  # 3) HIGH-PRIORITY exception rules (evaluated before the WARP rule) → main table.
  local p="$PRIO_EXCEPT_BASE"
  # 3a. fwmark of established/inbound replies → main
  ip rule add prio "$p" fwmark "$MARK_CONN" lookup main 2>/dev/null || true; p=$((p+1))
  # 3b. locally-originated SSH/panel server replies (sport) → main
  ip rule add prio "$p" ipproto tcp sport "$SSH_PORT"   lookup main 2>/dev/null || true; p=$((p+1))
  ip rule add prio "$p" ipproto tcp sport "$PANEL_PORT" lookup main 2>/dev/null || true; p=$((p+1))
  # 3c. local subnet + default gateway → main (never tunnel LAN/gw)
  local sub gw ep
  sub="$(local_subnet)"; gw="$(default_gw)"; ep="$(warp_endpoint_ip)"
  [[ -n "$sub" ]] && { ip rule add prio "$p" to "$sub" lookup main 2>/dev/null || true; p=$((p+1)); }
  [[ -n "$gw"  ]] && { ip rule add prio "$p" to "${gw}/32" lookup main 2>/dev/null || true; p=$((p+1)); }
  # 3d. WARP endpoint itself → main (anti-loop: the tunnel packets must exit native)
  [[ -n "$ep"  ]] && { ip rule add prio "$p" to "${ep}/32" lookup main 2>/dev/null || true; p=$((p+1)); }

  # 4) FINALLY: everything else → WARP table (lowest of our priorities).
  ip rule add prio "$PRIO_DEFAULT" lookup "$RT_TABLE" 2>/dev/null || true

  ip route flush cache 2>/dev/null || true
  log "policy routing installed (control plane preserved: SSH ${SSH_PORT}, panel ${PANEL_PORT}, subnet ${sub:-?}, gw ${gw:-?})"
}

# ── remove every policy-routing artifact we added (idempotent) ────────────────
route_down() {
  # Delete our ip rules by priority (covers any leftover from prior runs).
  local p
  for p in $(seq "$PRIO_EXCEPT_BASE" $((PRIO_EXCEPT_BASE+10))) "$PRIO_DEFAULT"; do
    while ip rule show 2>/dev/null | grep -qE "^${p}:"; do
      ip rule del prio "$p" 2>/dev/null || break
    done
  done
  # Drop the WARP route table.
  ip route flush table "$RT_TABLE" 2>/dev/null || true
  # Remove our mangle marks.
  if command -v iptables &>/dev/null; then
    iptables -t mangle -D OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j CONNMARK --restore-mark 2>/dev/null || true
    iptables -t mangle -D INPUT -p tcp --dport "${SSH_PORT:-22}"   -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    iptables -t mangle -D INPUT -p tcp --dport "${PANEL_PORT:-3000}" -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
  fi
  ip route flush cache 2>/dev/null || true
  log "policy routing removed"
}

# ── bring the tunnel up ──────────────────────────────────────────────────────
# BUG-162: do NOT enable autostart unless WARP_PERSIST=1 (explicit operator
#   confirmation). A non-persistent WARP can never silently re-down the box on
#   reboot — if anything is wrong, a reboot restores native access.
warp_up() {
  # Stop any stale instance first so re-setup is clean.
  systemctl stop "wg-quick@${WG_IFACE}" 2>/dev/null || true
  ip link del "$WG_IFACE" 2>/dev/null || true
  route_down  # clear any stale rules before re-applying

  if [[ "${WARP_PERSIST:-0}" == "1" ]]; then
    systemctl enable "wg-quick@${WG_IFACE}" 2>/dev/null || true
    log "autostart ENABLED (WARP_PERSIST=1)"
  else
    systemctl disable "wg-quick@${WG_IFACE}" 2>/dev/null || true
    log "autostart DISABLED (default) — WARP will NOT survive reboot"
  fi

  if ! systemctl start "wg-quick@${WG_IFACE}" 2>/dev/null; then
    # Fall back to a direct wg-quick up if the unit is unavailable.
    wg-quick up "$WG_IFACE" 2>/dev/null || true
  fi
  # Verify the tunnel actually came up. If wg-quick rolled back, tear the
  # half-built state down cleanly so we never leave artifacts (BUG-150/162).
  if ! ip link show "$WG_IFACE" &>/dev/null; then
    warp_down
    die "wg-quick up failed (interface ${WG_IFACE} not present after start)"
  fi
}

# ── full, idempotent teardown — leave NO artifacts ────────────────────────────
warp_down() {
  systemctl stop "wg-quick@${WG_IFACE}" 2>/dev/null || true
  systemctl disable "wg-quick@${WG_IFACE}" 2>/dev/null || true
  # PreDown in the conf calls route-down, but call it again here so teardown is
  # robust even if the interface is already gone / conf was removed.
  route_down
  # Direct down in case it was started outside systemd.
  wg-quick down "$WG_IFACE" 2>/dev/null || true
  # Hard-remove the interface if anything is left behind.
  ip link del "$WG_IFACE" 2>/dev/null || true
  # Legacy cleanup: v1.5.1 used wg-quick Table=auto with fwmark 0xca6c — remove
  # any lingering rule/table from a box that ran the old (broken) version.
  local legacy="0xca6c"
  while ip rule show 2>/dev/null | grep -q "fwmark ${legacy}"; do
    ip rule del fwmark "${legacy}" 2>/dev/null || break
  done
  ip route flush table "$((16#ca6c))" 2>/dev/null || true
  # Remove the generated interface config so a stale conf can't be re-applied.
  rm -f "$WG_CONF"
  ip route flush cache 2>/dev/null || true
  log "WARP egress torn down (interface, routes, rules, marks, conf removed)"
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
  setup)      do_setup ;;
  teardown)   do_teardown ;;
  status)     do_status ;;
  egress-ip)  measure_egress_ip ;;
  # Called by wg-quick PostUp/PreDown (%i = interface). Internal use.
  route-up)   route_up "${2:-$WG_IFACE}" ;;
  route-down) route_down ;;
  *) die "unknown action '$ACTION' (use: setup|teardown|status|egress-ip)" ;;
esac
