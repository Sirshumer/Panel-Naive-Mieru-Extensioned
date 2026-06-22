// ─────────────────────────────────────────────────────────────────────────────
// BUG-164 (HIGH): WARP tunnel was ONE-WAY — handshake OK but `received` ≈ 0 B,
//   so everything routed into the WARP table black-holed (panel/SSH looked dead,
//   `curl ipify` on the server hung). Root causes & fixes verified here:
//     1. MTU = 1280 must be set in the generated wg conf (default 1420/1500 drops
//        the encapsulated reply packets → no return traffic).
//     2. wgcf registration must be ROBUST: an account that is generated but not
//        actually registered with Cloudflare produces the same symptom. We assert
//        the account-validity gate exists and re-registers on a bad/empty account.
//     3. A post-up HEALTHCHECK with AUTO-ROLLBACK: after bring-up we probe the
//        egress IP THROUGH the warp interface; if it fails we retry alternate
//        Cloudflare endpoint ports and, if still unhealthy, tear everything down
//        so the box never sits in a black-hole (panel/SSH access preserved).
//     4. Autostart is enabled ONLY after the healthcheck passes (a bad tunnel is
//        never persisted into the boot path).
//
// These tests are structural (no root / live WireGuard needed): we drive
//   build_wg_conf in isolation and assert the script's source-level guarantees.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const cp     = require('child_process');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SCRIPT = path.join(__dirname, '..', 'panel', 'scripts', 'warp_egress.sh');
const APPJS  = path.join(__dirname, '..', 'panel', 'public', 'app.js');

console.log('\n[1] script exists and is valid bash');
ok(fs.existsSync(SCRIPT), 'warp_egress.sh present');
{
  const r = cp.spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  ok(r.status === 0, 'bash -n warp_egress.sh passes (' + (r.stderr || 'clean') + ')');
}

console.log('\n[2] generated conf carries the MTU=1280 fix (the #1 one-way cause)');
{
  const tmp     = fs.mkdtempSync(path.join(os.tmpdir(), 'warp164-'));
  const profile = path.join(tmp, 'wgcf-profile.conf');
  const outConf = path.join(tmp, 'warp.conf');
  fs.writeFileSync(profile, [
    '[Interface]',
    'PrivateKey = aGVsbG93b3JsZHByaXZhdGVrZXkxMjM0NTY3ODkwYWJjZGU=',
    'Address = 172.16.0.2/32',
    'Address = 2606:4700:110:899e::8652/128',
    'DNS = 1.1.1.1',
    '[Peer]',
    'PublicKey = bm90YXJlYWxwdWJsaWNrZXkxMjM0NTY3ODkwYWJjZGVmZ2g=',
    'AllowedIPs = 0.0.0.0/0',
    'Endpoint = 162.159.192.1:2408',
    '',
  ].join('\n'));

  const harness = `
    set -o pipefail
    export WARP_SSH_PORT='2222'
    eval "$(sed '/^ACTION=/,$d' '${SCRIPT}')"
    WGCF_PROFILE='${profile}'
    WG_CONF='${outConf}'
    WG_IFACE='warp'
    WARP_SELF='/opt/warp_egress.sh'
    host_has_ipv6() { return 1; }
    build_wg_conf
    cat '${outConf}'
  `;
  const r = cp.spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  const conf = r.stdout || '';
  if (r.status !== 0) console.log('    (harness stderr: ' + (r.stderr || '').trim() + ')');

  ok(/^\s*MTU\s*=\s*1280\s*$/m.test(conf), 'conf sets `MTU = 1280`');
  ok(/^\s*Table\s*=\s*off\s*$/m.test(conf), 'still uses `Table = off` (BUG-162 preserved)');
  ok(/^\s*Address\s*=\s*172\.16\.0\.2\/32\s*$/m.test(conf), 'IPv4 Address kept');
  ok(/Endpoint\s*=\s*162\.159\.192\.1:2408/.test(conf), 'peer endpoint preserved');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('\n[3] WARP_MTU constant + endpoint port fallback + health timeout');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/WARP_MTU="?\$\{WARP_MTU:-1280\}"?/.test(src), 'WARP_MTU defaults to 1280 (env-overridable)');
  ok(/WARP_ENDPOINT_PORTS=.*2408.*500.*1701.*4500/.test(src), 'endpoint port fallback list (2408/500/1701/4500)');
  ok(/WARP_HEALTH_TIMEOUT="?\$\{WARP_HEALTH_TIMEOUT:-5\}"?/.test(src), 'health timeout defaults to 5s');
  ok(/set_endpoint_port\s*\(\)/.test(src), 'set_endpoint_port() rewrites the peer port for fallback');
}

console.log('\n[4] post-up healthcheck probes egress THROUGH the warp interface');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/warp_healthcheck\s*\(\)/.test(src), 'warp_healthcheck() defined');
  ok(/curl\s+-s\s+--interface\s+"\$dev"/.test(src), 'healthcheck binds curl to the warp interface');
  ok(/api\.ipify\.org/.test(src), 'healthcheck fetches a public egress IP');
  ok(/wg show "\$dev" transfer/.test(src), 'healthcheck inspects wg transfer counters (rx)');
}

console.log('\n[5] AUTO-ROLLBACK on an unhealthy tunnel (no black-hole left behind)');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // warp_up must call warp_down and die when no port produced a healthy tunnel.
  ok(/for\s+port\s+in\s+\$WARP_ENDPOINT_PORTS/.test(src), 'warp_up iterates the endpoint port list');
  const upStart = src.indexOf('warp_up() {');
  const upBody  = src.slice(upStart, upStart + 2500);
  ok(/warp_down/.test(upBody), 'warp_up rolls back (warp_down) on total failure');
  ok(/one-way|unreachable|rolled back/.test(upBody), 'rollback error message explains the cause');
  ok(/access preserved|server access/.test(upBody), 'message reassures server access is preserved');
}

console.log('\n[6] autostart enabled ONLY after a healthy tunnel');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const upStart  = src.indexOf('warp_up() {');
  // Bound the body at the NEXT function definition so growth (BUG-168 classify)
  //   never truncates the window before the guarded enable.
  const after    = src.indexOf('\nwarp_iface_down_soft()', upStart);
  const upBody    = src.slice(upStart, after > upStart ? after : upStart + 4000);
  const enableIdx = upBody.indexOf('systemctl enable "wg-quick@');
  // The enable must appear AFTER the rollback/ok check, inside the persist branch.
  ok(enableIdx > -1, 'warp_up still has a guarded enable');
  ok(/WARP_PERSIST/.test(upBody) && upBody.indexOf('WARP_PERSIST') < enableIdx, 'enable is gated by WARP_PERSIST');
  // disable happens unconditionally before the loop (never persist before verify)
  ok(/systemctl disable "wg-quick@\$\{WG_IFACE\}"/.test(upBody), 'warp_up disables autostart before verifying');
}

console.log('\n[7] wgcf registration is robust (re-register on invalid account)');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/account_is_valid\s*\(\)/.test(src), 'account_is_valid() gate defined');
  ok(/device_id/.test(src) && /private_key/.test(src), 'validity gate checks device_id + private_key');
  // v1.5.4 (BUG-166): ensure_profile registers when the account is NOT valid.
  ok(/if\s+account_is_valid[\s\S]{0,400}else[\s\S]{0,200}wgcf_register/.test(src)
     || /if\s+!\s+wgcf_register/.test(src), 'ensure_profile (re)registers when account invalid');
  ok(/registration with Cloudflare failed|no valid account/.test(src), 'hard-fail if registration did not produce a valid account');
}

console.log('\n[8] do_status surfaces rx/tx + mtu (one-way tunnel is observable)');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/rxBytes/.test(src) && /txBytes/.test(src), 'status reports rx/tx bytes');
  ok(/mtu\s+:/.test(src) || /mtu\s*:/.test(src), 'status reports mtu');
  ok(/healthcheck\)\s*warp_healthcheck/.test(src), 'CLI exposes a `healthcheck` action');
}

console.log('\n[9] UI: misleading server-wide Naive banner removed (BUG-165)');
{
  const app = fs.readFileSync(APPJS, 'utf8');
  ok(!/function\s+renderNaiveServerBanner/.test(app), 'renderNaiveServerBanner() removed');
  ok(!/renderNaiveServerBanner\s*\(/.test(app), 'no call to renderNaiveServerBanner');
  ok(/removeNaiveServerBanner/.test(app), 'removeNaiveServerBanner() cleans stale DOM');
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
