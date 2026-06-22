// ─────────────────────────────────────────────────────────────────────────────
// v1.5.6 — BUG-170 (HIGH): WARP up, egress = Cloudflare, DNS fine, tunnel
// bidirectional — but clients connect and heavy sites/video do NOT load
// ("connected, nothing loads"). Proven on server 192187:
//   ping -M do -s 1400 -I warp 1.1.1.1 → "message too long, mtu=1280", 100% loss
//   ping -M do -s 1200 -I warp 1.1.1.1 → 0% loss
//   ping -M do -s 1000 -I warp 1.1.1.1 → 0% loss
// Packets > MTU 1280 are dropped (DF set, fragmentation forbidden). A real client
// is DOUBLE-encapsulated (client → Naive/Mieru → WARP), so the effective MTU is
// even lower; with PMTUD unreliable across the proxy/ICMP-filtered path the
// sender never shrinks its segments → large TCP flows stall.
//
// THE FIX (warp_egress.sh route_up, removed in route_down): clamp TCP MSS on
// everything that egresses via the warp interface, on BOTH paths:
//   • FORWARD -o warp : forwarded client egress
//   • OUTPUT  -o warp : caddy-naive / mita are LOCAL processes → OUTPUT, not FORWARD
// We pin a deterministic hard MSS (--set-mss 1240 = 1280 - 20 IPv4 - 20 TCP) AND
// add --clamp-mss-to-pmtu as a belt-and-suspenders lower bound. Match SYN/SYN-ACK
// only (where MSS is negotiated).
//
// teardown must remove these rules symmetrically (BUG-150 idempotency).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SCRIPT = path.join(__dirname, '..', 'panel', 'scripts', 'warp_egress.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

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

console.log('\n[2] BUG-170: WARP_MSS constant (= MTU 1280 - 40)');
{
  ok(/WARP_MSS="\$\{WARP_MSS:-1240\}"/.test(src), 'WARP_MSS defaults to 1240 (1280 - 20 IPv4 - 20 TCP)');
  ok(/WARP_MTU="\$\{WARP_MTU:-1280\}"/.test(src), 'WARP_MTU still 1280 (BUG-164 preserved)');
}

console.log('\n[3] BUG-170: route_up clamps MSS on BOTH FORWARD and OUTPUT for -o <warp>');
{
  ok(routeUp.length > 0, 'route_up() body located');
  // iterate FORWARD + OUTPUT
  ok(/for chain in FORWARD OUTPUT/.test(routeUp),
     'route_up: clamps on BOTH FORWARD (forwarded egress) and OUTPUT (local caddy/mita)');
  // hard set-mss
  ok(/-A "\$chain" -o "\$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "\$WARP_MSS"/.test(routeUp),
     'route_up: hard --set-mss WARP_MSS on SYN (deterministic, survives broken PMTUD)');
  // clamp-to-pmtu lower bound
  ok(/-A "\$chain" -o "\$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu/.test(routeUp),
     'route_up: --clamp-mss-to-pmtu belt-and-suspenders lower bound');
  // idempotent (-C before -A)
  ok(/-C "\$chain" -o "\$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "\$WARP_MSS"/.test(routeUp),
     'route_up: -C check before -A (idempotent, no duplicate MSS rules)');
  // SYN-only (not every packet)
  ok(/--tcp-flags SYN,RST SYN/.test(routeUp),
     'route_up: matches SYN/SYN-ACK only (where MSS is negotiated)');
}

console.log('\n[4] BUG-170: route_down removes the MSS clamping from both chains');
{
  ok(routeDown.length > 0, 'route_down() body located');
  ok(/for c in FORWARD OUTPUT/.test(routeDown),
     'route_down: iterates BOTH FORWARD and OUTPUT');
  ok(/-D "\$c" -o "\$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "\$WARP_MSS"/.test(routeDown),
     'route_down: deletes the --set-mss rule');
  ok(/-D "\$c" -o "\$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu/.test(routeDown),
     'route_down: deletes the --clamp-mss-to-pmtu rule');
  ok(/for m in 1 2 3 4/.test(routeDown),
     'route_down: loops the delete (purges duplicates from a partial prior run)');
}

console.log('\n[5] BUG-170: do_status surfaces the MSS (operator visibility)');
{
  ok(/echo "mss          : \$\{WARP_MSS\}"/.test(src), 'do_status prints the mss line');
}

console.log('\n[6] BUG-170 LIVE: MSS install/teardown logic is idempotent & clean');
{
  // The sandbox kernel often lacks xt_TCPMSS, so we validate the INSTALL/TEARDOWN
  // LOGIC (chain iteration, -o <dev> match, -C idempotency, -D removal loop) using
  // an ACCEPT target proxy. Requires root + an iptables that can do -C/-A/-D.
  const IPT = ['iptables-legacy', 'iptables'].find(b =>
    cp.spawnSync('sh', ['-c', `command -v ${b} >/dev/null`]).status === 0);
  const isRoot = cp.spawnSync('sh', ['-c', '[ "$(id -u)" = 0 ]']).status === 0;
  const usable = IPT && isRoot &&
    cp.spawnSync(IPT, ['-t', 'mangle', '-L', 'FORWARD', '-n'], { stdio: 'ignore' }).status === 0;
  if (!usable) {
    console.log('  \u26a0 skipped (needs root + a working iptables mangle table)');
  } else {
    const harness = [
      'set -o pipefail',
      `IPT="${IPT}"; dev="warpmsstest"`,
      'ip link add "$dev" type dummy 2>/dev/null||true; ip link set "$dev" up 2>/dev/null||true',
      // pre-clean
      'for c in FORWARD OUTPUT; do for m in 1 2 3 4; do $IPT -t mangle -D "$c" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j ACCEPT 2>/dev/null||true; done; done',
      // install (mirrors route_up logic with ACCEPT proxy), twice → idempotency
      'install(){ for c in FORWARD OUTPUT; do $IPT -t mangle -C "$c" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j ACCEPT 2>/dev/null || $IPT -t mangle -A "$c" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j ACCEPT 2>/dev/null||true; done; }',
      'install; install',
      'F1=$($IPT -t mangle -S FORWARD | grep -c warpmsstest); O1=$($IPT -t mangle -S OUTPUT | grep -c warpmsstest)',
      // teardown (mirrors route_down loop)
      'for c in FORWARD OUTPUT; do for m in 1 2 3 4; do $IPT -t mangle -D "$c" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j ACCEPT 2>/dev/null||true; done; done',
      'F2=$($IPT -t mangle -S FORWARD | grep -c warpmsstest); O2=$($IPT -t mangle -S OUTPUT | grep -c warpmsstest)',
      'ip link del "$dev" 2>/dev/null||true',
      'echo "UPF=$F1 UPO=$O1 DOWNF=$F2 DOWNO=$O2"',
    ].join('\n');
    const r = cp.spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/UPF=(\d+) UPO=(\d+) DOWNF=(\d+) DOWNO=(\d+)/);
    ok(!!m, 'live MSS logic executed (' + (r.stdout || r.stderr || '').trim() + ')');
    if (m) {
      ok(m[1] === '1' && m[2] === '1', 'install is idempotent (1 rule per chain after install x2)');
      ok(m[3] === '0' && m[4] === '0', 'teardown removes the rules from BOTH chains (0 left)');
    }
  }
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
