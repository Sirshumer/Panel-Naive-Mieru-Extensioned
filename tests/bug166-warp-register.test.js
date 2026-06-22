// ─────────────────────────────────────────────────────────────────────────────
// v1.5.4 — three WARP follow-ups confirmed on a real server:
//
//   BUG-166 (HIGH): `wgcf register` succeeded ("Successfully created Cloudflare
//     Warp account", Device active: true) but the panel still reported
//     "[warp][ERROR] wgcf register failed". Root cause: the script runs under
//     `set -o pipefail`, and `yes | wgcf register` made `yes` receive SIGPIPE
//     (exit 141) the moment wgcf closed stdin — even on a SUCCESSFUL register.
//     pipefail then propagated 141 as the pipeline status → false failure. Fix:
//     drop the `yes` pipe (we pass --accept-tos), use an explicit --config path,
//     and judge success by the ACCOUNT FILE, not the exit code. account_is_valid
//     reads the real wgcf-account.toml fields (device_id/private_key/access_token,
//     single- or double-quoted).
//
//   BUG-167: on IPv6-less hosts the wgcf profile ships
//     `Address = <v4>/32, <v6>/128` (comma-separated) + `AllowedIPs = 0.0.0.0/0,
//     ::/0`. The generated warp.conf must contain ONLY the IPv4 Address line and
//     NO ::/0, otherwise wg-quick fails with "IPv6 is disabled on this device".
//
//   BUG-168 (UX): on a provider that blocks WARP, the auto-rollback already keeps
//     the box safe; we must classify the outcome (WARP_RESULT=ok|blocked_return|
//     no_handshake) so the panel shows a friendly yellow explanation, not a red
//     panel error.
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
const SERVER = path.join(__dirname, '..', 'panel', 'server', 'index.js');
const APPJS  = path.join(__dirname, '..', 'panel', 'public', 'app.js');
const CSS    = path.join(__dirname, '..', 'panel', 'public', 'style.css');

// Source the script's function defs (strip the trailing case dispatch).
function sourcedHarness(body) {
  return `set -o pipefail
    eval "$(sed '/^ACTION=/,$d' '${SCRIPT}')"
    ${body}`;
}

console.log('\n[1] bash valid');
{
  const r = cp.spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  ok(r.status === 0, 'bash -n warp_egress.sh passes (' + (r.stderr || 'clean') + ')');
}

console.log('\n[2] BUG-166: account_is_valid reads the real wgcf-account.toml');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warp166-'));
  const acc = path.join(tmp, 'wgcf-account.toml');
  const run = (body) => cp.spawnSync('bash', ['-c', sourcedHarness(`WGCF_ACCOUNT='${acc}'\n${body}`)], { encoding: 'utf8' });

  // real single-quoted format
  fs.writeFileSync(acc, "access_token = '1e5d-tok'\ndevice_id = 'd3ad-id'\nprivate_key = 'cHJpdmtleQ=='\nlicense_key = 'lic'\n");
  ok(run(`account_is_valid '${acc}' && echo OK`).stdout.includes('OK'), 'valid (single-quoted) account accepted');

  // double-quoted
  fs.writeFileSync(acc, 'access_token = "t"\ndevice_id = "d"\nprivate_key = "p"\n');
  ok(run(`account_is_valid '${acc}' && echo OK`).stdout.includes('OK'), 'valid (double-quoted) account accepted');

  // missing access_token → invalid
  fs.writeFileSync(acc, "device_id = 'd'\nprivate_key = 'p'\n");
  ok(!run(`account_is_valid '${acc}' && echo OK`).stdout.includes('OK'), 'account missing access_token rejected');

  // empty value → invalid
  fs.writeFileSync(acc, "access_token = ''\ndevice_id = 'd'\nprivate_key = 'p'\n");
  ok(!run(`account_is_valid '${acc}' && echo OK`).stdout.includes('OK'), 'account with empty value rejected');

  // empty file → invalid
  fs.writeFileSync(acc, '');
  ok(!run(`account_is_valid '${acc}' && echo OK`).stdout.includes('OK'), 'empty account file rejected');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('\n[3] BUG-166: register no longer uses the `yes |` pipe + judges by file');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // Only inspect EXECUTABLE lines (strip comments) — the fix is documented in
  //   comments, so a naive whole-file grep would false-positive on those.
  const codeOnly = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  ok(!/yes\s*\|\s*wgcf\s+register/.test(codeOnly), 'no `yes | wgcf register` in code (the SIGPIPE/pipefail trap is gone)');
  ok(/wgcf_register\s*\(\)/.test(src), 'wgcf_register() helper defined');
  ok(/--accept-tos/.test(src), 'register passes --accept-tos (no interactive prompt)');
  ok(/--config\s+"\$WGCF_ACCOUNT"/.test(src), 'register/generate use an explicit --config path');
  // ensure_profile must NOT `|| die` directly on the register pipeline exit code
  ok(/account_is_valid\b/.test(src) && /wgcf_register/.test(src), 'success judged by account_is_valid, not exit code');
  // Confirm a SIGPIPE-style 141 from a yes-pipe would NOT be how we detect failure
  ok(/if\s+!\s+wgcf_register/.test(src), 'ensure_profile fails only when the account file is invalid');
}

console.log('\n[4] BUG-166 live: a register that exits 141 (SIGPIPE) but writes a good file → success');
{
  // Simulate the exact failure: a wgcf stub that prints success, writes a valid
  // account file, then exits 141 (as `yes` would under pipefail). With the fix,
  // ensure_profile must treat this as SUCCESS because the file is valid.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warp166b-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  // stub wgcf: writes account/profile via --config / --profile, then exits 141
  fs.writeFileSync(path.join(bin, 'wgcf'), `#!/usr/bin/env bash
cfg=""; prof=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) cfg="$2"; shift 2;;
    --profile) prof="$2"; shift 2;;
    register) shift;;
    generate) shift;;
    *) shift;;
  esac
done
if [ -n "$cfg" ] && [ ! -s "$cfg" ]; then
  printf "access_token = 'tok'\\ndevice_id = 'dev'\\nprivate_key = 'cHJpdg=='\\n" > "$cfg"
  echo "Successfully created Cloudflare Warp account"
fi
if [ -n "$prof" ]; then
  printf '[Interface]\\nPrivateKey = cHJpdg==\\nAddress = 172.16.0.2/32, 2606:4700::1/128\\n[Peer]\\nPublicKey = cHViaw==\\nAllowedIPs = 0.0.0.0/0, ::/0\\nEndpoint = 162.159.192.1:2408\\n' > "$prof"
fi
exit 141
`);
  fs.chmodSync(path.join(bin, 'wgcf'), 0o755);

  const wgcfDir = path.join(tmp, 'warp');
  const harness = sourcedHarness(`
    export PATH='${bin}':"$PATH"
    WGCF_DIR='${wgcfDir}'
    WGCF_ACCOUNT='${wgcfDir}/wgcf-account.toml'
    WGCF_PROFILE='${wgcfDir}/wgcf-profile.conf'
    ensure_profile && echo ENSURE_OK || echo ENSURE_FAIL
  `);
  const r = cp.spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  ok(/ENSURE_OK/.test(r.stdout || ''), 'register exits 141 but valid file → ensure_profile SUCCEEDS (BUG-166 fixed)');
  ok(fs.existsSync(path.join(wgcfDir, 'wgcf-profile.conf')), 'profile generated despite the SIGPIPE-style exit');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('\n[5] BUG-167: generated conf is IPv4-only (no IPv6 Address line, no ::/0)');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warp167-'));
  const prof = path.join(tmp, 'wgcf-profile.conf');
  const out  = path.join(tmp, 'warp.conf');
  // EXACT wgcf 2.2.x format: comma-separated v4,v6 on the Address line.
  fs.writeFileSync(prof, [
    '[Interface]',
    'PrivateKey = cHJpdmF0ZWtleTEyMzQ1Njc4OTBhYmNkZWZnaGlqaw==',
    'Address = 172.16.0.2/32, 2606:4700:110:899e:8652:1234:5678:9abc/128',
    'DNS = 1.1.1.1, 2606:4700:4700::1111',
    '[Peer]',
    'PublicKey = cHVibGlja2V5MTIzNDU2Nzg5MGFiY2RlZmdoaWprbA==',
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'Endpoint = 162.159.192.1:2408',
    '',
  ].join('\n'));
  const harness = sourcedHarness(`
    WGCF_PROFILE='${prof}'; WG_CONF='${out}'; WG_IFACE='warp'; WARP_SELF='/opt/x.sh'
    host_has_ipv6() { return 1; }
    build_wg_conf >/dev/null 2>&1
    cat '${out}'
  `);
  const conf = cp.spawnSync('bash', ['-c', harness], { encoding: 'utf8' }).stdout || '';
  ok(/^\s*Address\s*=\s*172\.16\.0\.2\/32\s*$/m.test(conf), 'IPv4 Address line kept');
  ok(!/^\s*Address\s*=.*:/m.test(conf), 'NO IPv6 Address line in the generated conf');
  ok(!/::\/0/.test(conf), 'NO ::/0 anywhere in the generated conf');
  ok(/^\s*AllowedIPs\s*=\s*0\.0\.0\.0\/0\s*$/m.test(conf), 'AllowedIPs is IPv4-only 0.0.0.0/0');
  ok(/^\s*MTU\s*=\s*1280\s*$/m.test(conf), 'MTU=1280 retained (BUG-164)');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('\n[6] BUG-168: script emits a structured WARP_RESULT classification');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/WARP_RESULT=ok/.test(src), 'success path prints WARP_RESULT=ok + egressIP');
  ok(/WARP_RESULT=blocked_return/.test(src), 'handshake-but-no-return prints WARP_RESULT=blocked_return');
  ok(/WARP_RESULT=no_handshake/.test(src), 'no-handshake prints WARP_RESULT=no_handshake');
  ok(/any_handshake/.test(src), 'tracks whether any handshake succeeded across ports');
  ok(/best_rx/.test(src) && /best_tx/.test(src), 'tracks best rx/tx for the message');
  // rollback still happens before classification
  ok(src.indexOf('warp_down') < src.indexOf('WARP_RESULT=blocked_return'), 'auto-rollback (warp_down) runs before the classified failure line');
}

console.log('\n[7] BUG-168: server classifies the outcome into {severity, message}');
{
  const src = fs.readFileSync(SERVER, 'utf8');
  ok(/function parseWarpResult/.test(src), 'parseWarpResult() defined');
  ok(/blocked_return/.test(src) && /no_handshake/.test(src), 'server handles both block classifications');
  ok(/severity:\s*'warning'/.test(src), 'provider block is a WARNING (not a red error)');
  ok(/severity:\s*'success'/.test(src), 'verified tunnel is a success');
  ok(/rolledBack/.test(src), 'server marks rolledBack so the toggle reflects reality');
  ok(/блокирует входящий трафик Cloudflare WARP/.test(src), 'friendly provider-block message present');
  ok(/доступ к серверу сохранён/.test(src), 'message reassures access is preserved');
  ok(/смените хостера|каскад/.test(src), 'message tells the operator what to do (change host / cascade)');

  // Live: run parseWarpResult on representative outputs (build it via Function
  //   so it is callable in this block scope under 'use strict').
  const m = src.match(/function parseWarpResult\([\s\S]*?\n}\n/);
  const parseWarpResult = new Function(m[0] + '\nreturn parseWarpResult;')();
  const a = parseWarpResult('x\nWARP_RESULT=ok egressIP=104.28.197.7 port=2408');
  ok(a.code === 'ok' && a.egressIP === '104.28.197.7', 'parses ok + egressIP');
  const b = parseWarpResult('WARP_RESULT=blocked_return handshake=ok rx=92 tx=446693376 ports=2408 500');
  ok(b.code === 'blocked_return' && b.rx === 92 && b.tx === 446693376, 'parses blocked_return + rx/tx');
  const c = parseWarpResult('WARP_RESULT=no_handshake handshake=none rx=0 tx=0 ports=2408');
  ok(c.code === 'no_handshake', 'parses no_handshake');
  ok(parseWarpResult('nothing').code === 'unknown', 'unknown when no result line');
}

console.log('\n[8] BUG-168: UI renders severity (yellow warning) + reflects rollback');
{
  const app = fs.readFileSync(APPJS, 'utf8');
  const css = fs.readFileSync(CSS, 'utf8');
  ok(/res\.warpResult/.test(app), 'applyWarp reads res.warpResult');
  ok(/severity/.test(app), 'applyWarp uses the severity field');
  ok(/res\.rolledBack/.test(app), 'applyWarp unchecks the toggle on rollback');
  ok(/'warning'|'warn'/.test(app) && /showMsg/.test(app), 'warning severity drives showMsg');
  ok(/\.msg-inline\.warn/.test(css), 'CSS has a yellow .msg-inline.warn style');
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
