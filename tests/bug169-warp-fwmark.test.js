// ─────────────────────────────────────────────────────────────────────────────
// v1.5.5 — BUG-169 (CRITICAL): panel WARP returns blocked_return even on a clean
// hoster where a BARE wgcf tunnel (Table=off, NO policy routing) reaches a
// Cloudflare egress IP. Proven on server 192187:
//   • bare `curl --interface wgtest` → 104.28.197.7 (CF-IP)         → WORKS
//   • panel setup, same server/endpoint/fresh acct → rx=92 tx=4.8GB → FAILS
// The ONLY difference is the panel's policy routing (fwmark + ip rule table
// 51820) layered over Table=off. Our routing was MISSING the canonical wg-quick
// `add_default()` return-path mechanism, so the encrypted reply UDP from
// Cloudflare never made it back to the wg socket (rx≈92 = handshake only).
//
// THE FIX (mirrors wg-quick add_default):
//   1. `wg set <iface> fwmark <T>`           — WG marks its OWN envelope UDP.
//   2. `ip rule add not fwmark <T> table <T>`— everything EXCEPT the envelope
//                                              goes into the tunnel table.
//   3. conntrack save/restore of the envelope mark on the UDP carrier
//        POSTROUTING -m mark --mark <T> -p udp -j CONNMARK --save-mark
//        PREROUTING  -p udp             -j CONNMARK --restore-mark
//      ← THE return-path fix: the reply UDP gets the mark back so the kernel
//        delivers it to the wg socket instead of dropping it.
//   4. `sysctl net.ipv4.conf.all.src_valid_mark=1` — marked packets survive
//      reverse-path filtering (the rx≈92 symptom otherwise).
//   5. `ip rule add table main suppress_prefixlength 0` — specific main routes
//      (incl. the on-link endpoint route) win, so the envelope exits native.
//
// BUG-150/162 constraints preserved: SSH + panel are pinned to the native route
// via connmark; teardown is fully idempotent (no stranded rules/marks).
//
// ALSO regression-guards the SIGPIPE/pipefail class (same root as BUG-166): the
// teardown loop and has_ipv6() must NOT pipe into `grep -q` as a condition,
// because under `set -o pipefail` grep closing the pipe early makes the upstream
// command get SIGPIPE (141) and the condition evaluate FALSE — which was
// observed live to strand ip rule prio 9000.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const assert = require('assert');
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SCRIPT = path.join(__dirname, '..', 'panel', 'scripts', 'warp_egress.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

// Pull just the route_up() body so assertions are scoped to the install path.
function fnBody(name) {
  const re = new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  return m ? m[0] : '';
}
const routeUp   = fnBody('route_up');
const routeDown = fnBody('route_down');

console.log('\n[1] bash valid');
{
  const r = cp.spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  ok(r.status === 0, 'bash -n warp_egress.sh passes (' + (r.stderr || 'clean') + ')');
}

console.log('\n[2] BUG-169: constants for the wg-quick fwmark mechanism');
{
  ok(/WG_FWMARK="51820"/.test(src),  'WG_FWMARK="51820" (== route table) defined');
  ok(/RT_TABLE="51820"/.test(src),   'RT_TABLE="51820" defined');
  ok(/PRIO_SUPPRESS="9400"/.test(src),'PRIO_SUPPRESS="9400" (suppress_prefixlength rule) defined');
  ok(/PRIO_DEFAULT="9500"/.test(src),'PRIO_DEFAULT="9500" (not-fwmark default) defined');
  ok(/MARK_CONN="0x5152"/.test(src), 'MARK_CONN="0x5152" (SSH/panel connmark) defined');
}

console.log('\n[3] BUG-169: route_up installs the full add_default() return-path mechanism');
{
  ok(routeUp.length > 0, 'route_up() body located');
  // 1. WG marks its own envelope
  ok(/wg set "\$dev" fwmark "\$WG_FWMARK"/.test(routeUp),
     'route_up: `wg set <dev> fwmark <WG_FWMARK>` (envelope is marked)');
  // 2. not-fwmark default rule
  ok(/ip rule add prio "\$PRIO_DEFAULT" not fwmark "\$WG_FWMARK" lookup "\$RT_TABLE"/.test(routeUp),
     'route_up: `ip rule add ... not fwmark <WG_FWMARK> lookup <RT_TABLE>`');
  // 3. conntrack save (POSTROUTING) + restore (PREROUTING) on UDP carrier
  ok(/-t mangle -A POSTROUTING -m mark --mark "\$WG_FWMARK" -p udp -j CONNMARK --save-mark/.test(routeUp),
     'route_up: POSTROUTING save-mark of WG envelope (UDP)');
  ok(/-t mangle -A PREROUTING -p udp -j CONNMARK --restore-mark/.test(routeUp),
     'route_up: PREROUTING restore-mark on reply UDP (THE return-path fix)');
  // 4. src_valid_mark
  ok(/sysctl -q net\.ipv4\.conf\.all\.src_valid_mark=1/.test(routeUp),
     'route_up: src_valid_mark=1 (marked packets pass rp_filter)');
  // 5. suppress_prefixlength 0
  ok(/ip rule add prio "\$PRIO_SUPPRESS" table main suppress_prefixlength 0/.test(routeUp),
     'route_up: suppress_prefixlength 0 (specific main routes incl. endpoint win)');
}

console.log('\n[4] BUG-162 preserved: SSH/panel control plane stays on the native route');
{
  ok(/--dport "\$SSH_PORT" -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'route_up: SSH inbound connmarked to native route');
  ok(/--dport "\$PANEL_PORT" -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'route_up: panel inbound connmarked to native route');
  ok(/ip rule add prio "\$p" fwmark "\$MARK_CONN" lookup main/.test(routeUp),
     'route_up: connmarked replies routed to main (never tunneled)');
  ok(/Table = off/.test(src), 'still uses `Table = off` (BUG-162 preserved)');
}

console.log('\n[5] BUG-169: route_down idempotently removes every artifact');
{
  ok(routeDown.length > 0, 'route_down() body located');
  ok(/wg set "\$dev" fwmark 0/.test(routeDown),
     'route_down: clears WireGuard envelope fwmark (wg set fwmark 0)');
  ok(/-t mangle -D POSTROUTING -m mark --mark "\$WG_FWMARK" -p udp -j CONNMARK --save-mark/.test(routeDown),
     'route_down: removes POSTROUTING save-mark');
  ok(/-t mangle -D PREROUTING -p udp -j CONNMARK --restore-mark/.test(routeDown),
     'route_down: removes PREROUTING restore-mark');
  ok(/-t mangle -D OUTPUT -m connmark --mark "\$MARK_CONN" -j CONNMARK --restore-mark/.test(routeDown),
     'route_down: removes OUTPUT connmark restore');
  ok(/PRIO_SUPPRESS/.test(routeDown), 'route_down: deletes the suppress_prefixlength rule (9400)');
  ok(/PRIO_DEFAULT/.test(routeDown),  'route_down: deletes the not-fwmark default rule (9500)');
  ok(/ip route flush table "\$RT_TABLE"/.test(routeDown), 'route_down: flushes the WARP route table');
}

console.log('\n[6] BUG-169 regression: no SIGPIPE/pipefail `| grep -q` loop conditions');
{
  // The teardown rule loop must snapshot the table (pure-bash match), NOT pipe
  // `ip rule show | grep -q` as the while condition (that strands prio 9000).
  ok(!/while ip rule show [^\n]*\| *grep -q/.test(routeDown),
     'route_down: does NOT use `ip rule show | grep -q` as a loop condition');
  ok(/\[\[ \$'\\n'"\$rules" == \*\$'\\n'"\$\{p\}:"\* \]\]/.test(routeDown)
     || /\[\[ "\$rules" == \*/.test(routeDown),
     'route_down: uses a pure-bash substring match on a snapshot of ip rule show');
  // has_ipv6 must also not pipe into grep -q for its verdict (BUG-167 correctness).
  const hasV6 = fnBody('has_ipv6') || (src.match(/has_ipv6\(\)[\s\S]*?\n\}/) || [''])[0];
  ok(!/ip -6 addr show[^\n]*\| *grep -q/.test(src),
     'has_ipv6: does NOT pipe `ip -6 addr show | grep -q` for its verdict');
}

console.log('\n[7] BUG-169 LIVE: real route_up → route_down leaves the rule table clean');
{
  // Requires root + iproute2. Skip gracefully otherwise (CI without privileges).
  const probe = cp.spawnSync('bash', ['-c', 'command -v ip >/dev/null && [ "$(id -u)" = 0 ]']);
  if (probe.status !== 0) {
    console.log('  \u26a0 skipped (needs root + iproute2)');
  } else {
    // Write the harness to a temp file: source the script's function defs
    // (strip the CLI dispatch) so route_up/route_down run for real, then assert
    // the rule table is empty after teardown.
    const harness = [
      'set -o pipefail',
      'export WG_IFACE="wgbug169t"; export PANEL_PORT="3000"; export SSH_PORT="22"',
      'log(){ :; }; err(){ :; }; detect_ssh_port(){ echo 22; }',
      'local_subnet(){ echo ""; }; default_gw(){ echo ""; }',
      `eval "$(sed '/^ACTION=/,$d' '${SCRIPT}')"`,
      'for q in $(seq "$PRIO_EXCEPT_BASE" $((PRIO_EXCEPT_BASE+10))) "$PRIO_SUPPRESS" "$PRIO_DEFAULT"; do',
      '  r="$(ip rule show 2>/dev/null||true)"; n=0',
      '  while [[ $\'\\n\'"$r" == *$\'\\n\'"$q:"* ]]; do ip rule del prio "$q" 2>/dev/null||true; n=$((n+1)); [ $n -ge 30 ]&&break; r="$(ip rule show 2>/dev/null||true)"; done',
      'done',
      'ip link add wgbug169t type dummy 2>/dev/null||true; ip link set wgbug169t up 2>/dev/null||true',
      'route_up wgbug169t >/dev/null 2>&1',
      'AFTER_UP="$(ip rule show | grep -cE \'^(9[0-9]{3}):\' || true)"',
      'route_down >/dev/null 2>&1',
      'AFTER_DOWN="$(ip rule show | grep -cE \'^(9[0-9]{3}):\' || true)"',
      'ip link del wgbug169t 2>/dev/null||true',
      'echo "UP=$AFTER_UP DOWN=$AFTER_DOWN"',
    ].join('\n');
    const r = cp.spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/UP=(\d+) DOWN=(\d+)/);
    ok(!!m, 'live route_up/route_down executed (' + (r.stdout || r.stderr || '').trim() + ')');
    if (m) {
      ok(parseInt(m[1], 10) >= 4, 'route_up installed the policy rules (' + m[1] + ' rules)');
      ok(parseInt(m[2], 10) === 0, 'route_down removed ALL policy rules (idempotent, 0 left)');
    }
  }
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
