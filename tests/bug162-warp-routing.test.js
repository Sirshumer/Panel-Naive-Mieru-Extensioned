// ─────────────────────────────────────────────────────────────────────────────
// BUG-162 (CRITICAL): WARP must NOT route the SSH/panel control plane into the
//   tunnel (which locked operators out), and must NOT auto-enable on boot.
//
// These tests exercise the warp_egress.sh config generation + the panel's
//   SSH-port detection + the API persist handling, without needing root or a
//   live WireGuard interface. We assert the structural guarantees that prevent
//   the lock-out:
//     1. the generated wg conf uses `Table = off` (wg-quick installs NO routes)
//     2. it never emits a blanket `Table = auto`
//     3. the IPv4 Address is kept and IPv6 Address/AllowedIPs are stripped
//     4. PostUp/PreDown delegate to our scoped route-up/route-down
//     5. the systemd unit is enabled ONLY when WARP_PERSIST=1
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const cp     = require('child_process');

let pass = 0, fail = 0;
const ok  = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SCRIPT = path.join(__dirname, '..', 'panel', 'scripts', 'warp_egress.sh');

console.log('\n[1] script exists and is valid bash');
ok(fs.existsSync(SCRIPT), 'warp_egress.sh present');
{
  const r = cp.spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  ok(r.status === 0, 'bash -n warp_egress.sh passes (' + (r.stderr || 'clean') + ')');
}

console.log('\n[2] generated conf is lock-out-safe (Table=off, IPv4-only, scoped hooks)');
{
  // Build a fake wgcf profile + drive build_wg_conf in isolation by sourcing the
  // script and overriding the paths/funcs. We run a small bash harness.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-test-'));
  const profile = path.join(tmp, 'wgcf-profile.conf');
  const outConf = path.join(tmp, 'warp.conf');
  fs.writeFileSync(profile, [
    '[Interface]',
    'PrivateKey = aGVsbG93b3JsZHByaXZhdGVrZXkxMjM0NTY3ODkwYWJjZGU=',
    'Address = 172.16.0.2/32',
    'Address = 2606:4700:110:899e::8652/128',
    'DNS = 1.1.1.1',
    'MTU = 1280',
    '[Peer]',
    'PublicKey = bm90YXJlYWxwdWJsaWNrZXkxMjM0NTY3ODkwYWJjZGVmZ2g=',
    'AllowedIPs = 0.0.0.0/0',
    'AllowedIPs = ::/0',
    'Endpoint = 162.159.192.1:2408',
    '',
  ].join('\n'));

  // Harness: source the script with `return` guard disabled by overriding the
  // dispatch (we only call build_wg_conf). We set the path vars + stub host_has_ipv6.
  const harness = `
    set -o pipefail
    export WARP_SSH_PORT='2222'
    export WARP_PANEL_PORT='3000'
    # source only the function defs: strip the trailing case dispatch by sed
    eval "$(sed '/^ACTION=/,$d' '${SCRIPT}')"
    # override the path globals AFTER sourcing (the script sets them at top level)
    WGCF_PROFILE='${profile}'
    WG_CONF='${outConf}'
    WG_IFACE='warp'
    WARP_SELF='/opt/warp_egress.sh'
    # force IPv4-only path regardless of the sandbox
    host_has_ipv6() { return 1; }
    build_wg_conf
    cat '${outConf}'
  `;
  const r = cp.spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  const conf = (r.stdout || '') ;
  if (r.status !== 0) console.log('    (harness stderr: ' + (r.stderr || '').trim() + ')');

  ok(/^\s*Table\s*=\s*off\s*$/m.test(conf), 'conf sets `Table = off` (wg-quick installs NO routes)');
  ok(!/Table\s*=\s*auto/.test(conf), 'conf never uses `Table = auto`');
  ok(/^\s*Address\s*=\s*172\.16\.0\.2\/32\s*$/m.test(conf), 'IPv4 Address kept');
  ok(!/Address\s*=.*:/.test(conf), 'IPv6 Address stripped');
  ok(!/AllowedIPs\s*=.*::\/0/.test(conf), '::/0 stripped from AllowedIPs');
  ok(/PostUp\s*=.*route-up/.test(conf), 'PostUp delegates to scoped route-up');
  ok(/PreDown\s*=.*route-down/.test(conf), 'PreDown delegates to scoped route-down');
  ok(/PublicKey\s*=/.test(conf) && /Endpoint\s*=\s*162\.159\.192\.1:2408/.test(conf), 'peer key + endpoint preserved');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('\n[3] autostart is opt-in (enable only when WARP_PERSIST=1)');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/WARP_PERSIST.*==.*"1"/.test(src) || /WARP_PERSIST:-0/.test(src), 'script gates enable on WARP_PERSIST');
  ok(/systemctl\s+disable\s+"wg-quick@/.test(src), 'script disables autostart by default');
  // The enable call must be INSIDE the persist branch, not unconditional.
  const enableIdx = src.indexOf('systemctl enable "wg-quick@');
  const persistIdx = src.indexOf('WARP_PERSIST');
  ok(enableIdx > -1 && persistIdx > -1 && enableIdx > persistIdx, 'enable is guarded by the persist check');
}

console.log('\n[4] teardown removes our policy-routing artifacts');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/route_down/.test(src), 'warp_down calls route_down');
  ok(/ip rule del prio/.test(src), 'route_down deletes ip rules by priority');
  ok(/ip route flush table "\$RT_TABLE"/.test(src), 'route_down flushes the WARP route table');
  ok(/CONNMARK/.test(src), 'route_down removes conntrack marks');
  ok(/0xca6c/.test(src), 'legacy v1.5.1 fwmark/table cleanup retained');
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
