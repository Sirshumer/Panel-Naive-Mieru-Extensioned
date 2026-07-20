// ─────────────────────────────────────────────────────────────────────────────
// v1.5.8 — BUG-172 (CRITICAL): Mieru cascade (Variant B: redsocks + iptables +
// mieru-client) silently dies after 2-5 days of uptime. `mita` and `redsocks`
// still show `active (running)`, the panel is up, but every client times out.
//
// Field diagnosis (user report):
//   • `curl -x socks5h://127.0.0.1:1080 https://api.ipify.org`  → OK (mieru fine)
//   • `sudo -u mita curl https://api.ipify.org`                  → hangs / timeout
//   • strace of the live redsocks pid → ZERO syscalls (event-loop dead-locked;
//     process alive, :12345 bound, but no socket events serviced).
//
// ROOT CAUSE: redsocks' libevent event-loop wedges under long uptime / connection
// micro-storms. The data-plane (iptables → redsocks → mieru) is dead even though
// the unit is "healthy".
//
// WHY THE OLD WATCHDOG MISSED IT: it probed `curl --socks5 127.0.0.1:1080`, which
// talks to mieru-client DIRECTLY and bypasses BOTH iptables AND redsocks. mieru
// was fine, so the probe passed and nothing was ever restarted.
//
// THE FIX (write_watchdog): probe the WHOLE chain AS the mita user (so the
// `OUTPUT -m owner --uid-owner <mita> -j REDSOCKS` rule forces it through
// iptables → redsocks → mieru), then heal the ACTUAL culprit:
//   • chain fails but raw SOCKS5 still works → redsocks deadlock → restart redsocks
//   • chain AND SOCKS5 fail                   → mieru down → restart mieru + redsocks
// Plus a nightly (04:00) preventive redsocks recycle.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SCRIPT = path.join(__dirname, '..', 'panel', 'scripts', 'cascade_mieru.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

// Pull out the here-doc the watchdog writes to $WATCHDOG_BIN, and the cron block.
function heredoc(tag) {
  const re = new RegExp('<<\\s*.?' + tag + '.?\\n([\\s\\S]*?)\\n' + tag + '\\b', 'm');
  const m = src.match(re);
  return m ? m[1] : '';
}
const wd   = heredoc('WDEOF');    // generated /usr/local/bin/mieru-watchdog.sh
const cron = heredoc('CRONEOF');  // generated /etc/cron.d/mieru-cascade-watchdog

console.log('\n[1] script is valid bash (outer + generated watchdog)');
{
  const r = cp.spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  ok(r.status === 0, 'bash -n cascade_mieru.sh passes (' + (r.stderr || 'clean') + ')');
  ok(wd.length > 0, 'watchdog here-doc (WDEOF) located');
  const tmp = path.join(require('os').tmpdir(), 'wd172-' + process.pid + '.sh');
  fs.writeFileSync(tmp, wd);
  const r2 = cp.spawnSync('bash', ['-n', tmp], { encoding: 'utf8' });
  try { fs.unlinkSync(tmp); } catch (e) {}
  ok(r2.status === 0, 'generated watchdog script is valid bash (' + (r2.stderr || 'clean') + ')');
}

console.log('\n[2] BUG-172: watchdog probes the FULL chain as the mita user');
{
  ok(/sudo -u mita curl\b/.test(wd),
     'watchdog probes AS the mita user (traffic traverses iptables \u2192 redsocks \u2192 mieru)');
  ok(/chain_ok\b/.test(wd),
     'has a chain_ok() end-to-end probe');
  // The end-to-end probe is what decides success (exit 0), NOT the raw socks probe.
  ok(/chain_ok && exit 0/.test(wd),
     'a healthy FULL chain (not the raw SOCKS5) is the success condition');
}

console.log('\n[3] BUG-172: the old direct-SOCKS5-only success path is GONE');
{
  // The bug was: `curl --socks5 127.0.0.1:1080 … && exit 0` — passing on the raw
  // tunnel alone. SOCKS5 may still be probed, but only to DISCRIMINATE the
  // culprit, never as the sole success gate.
  ok(!/--socks5 127\.0\.0\.1:1080[^\n]*\n\s*exit 0/.test(wd) &&
     !/if curl -s --socks5 127\.0\.0\.1:1080[^\n]*then\s*\n\s*exit 0/.test(wd),
     'watchdog no longer treats a bare SOCKS5 probe as "cascade healthy"');
}

console.log('\n[4] BUG-172: self-heal targets the ACTUAL culprit');
{
  // redsocks deadlock: chain down but SOCKS5 up → restart redsocks.
  ok(/socks_ok/.test(wd) && /systemctl restart redsocks/.test(wd),
     'restarts redsocks when the chain is down but mieru SOCKS5 still answers (deadlock)');
  // mieru down: chain + SOCKS5 both down → restart mieru then redsocks.
  ok(/systemctl restart mieru/.test(wd),
     'restarts mieru when the tunnel itself is down');
  // ordering: after restarting mieru, redsocks must be restarted so it re-dials.
  ok(/systemctl restart mieru[\s\S]*systemctl restart redsocks/.test(wd),
     'restarts redsocks AFTER mieru so it re-dials the fresh SOCKS5 listener');
  // only after 3 consecutive failures (no flapping on a transient blip)
  ok(/for i in 1 2 3/.test(wd),
     'acts only after 3 consecutive end-to-end failures (anti-flap)');
}

console.log('\n[5] BUG-172: observability + preventive recycle');
{
  ok(/cascade-watchdog\.log/.test(wd),
     'watchdog logs its healing actions to /var/log/cascade-watchdog.log');
  ok(/\*\/5 \* \* \* \* root/.test(cron),
     'cron runs the full-chain watchdog every 5 minutes');
  ok(/0 4 \* \* \* root systemctl restart redsocks/.test(cron),
     'nightly (04:00) preventive redsocks recycle to pre-empt event-loop wedges');
}

console.log('\n[6] BUG-172 LIVE: drive the generated watchdog with mocked commands');
{
  // We cannot install redsocks/mieru/mita here, so we render the watchdog to a
  // temp dir and shim `sudo`, `curl`, `systemctl`, `date` in front of PATH to
  // simulate the three real-world states and assert the healing decision.
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd172live-'));
  const wdFile = path.join(dir, 'mieru-watchdog.sh');
  fs.writeFileSync(wdFile, wd); fs.chmodSync(wdFile, 0o755);

  // scenario knobs are read from env by the shims:
  //   CHAIN=ok|fail  SOCKS=ok|fail   → the shims exit 0/1 accordingly
  function shim(name, body) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/usr/bin/env bash\n' + body + '\n');
    fs.chmodSync(p, 0o755);
  }
  // sudo -u mita curl …  → success iff CHAIN=ok
  shim('sudo', 'exec 1>/dev/null 2>&1; [ "$CHAIN" = ok ] && exit 0 || exit 1');
  // curl --socks5 …      → success iff SOCKS=ok ; (the mita path goes via sudo)
  shim('curl', '[ "$SOCKS" = ok ] && exit 0 || exit 1');
  shim('systemctl', 'echo "systemctl $*" >> "$ACTLOG"');
  shim('sleep', 'exit 0');           // don't actually wait through the retries
  shim('date', 'echo 2026-01-01 00:00:00');

  function run(chain, socks) {
    const actlog = path.join(dir, `act-${chain}-${socks}.log`);
    fs.writeFileSync(actlog, '');
    const r = cp.spawnSync('bash', [wdFile], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + ':' + process.env.PATH,
             CHAIN: chain, SOCKS: socks, ACTLOG: actlog, LOG: path.join(dir, 'ignore.log') },
    });
    return { code: r.status, acts: fs.readFileSync(actlog, 'utf8') };
  }

  // Note: the generated script hard-codes LOG=/var/log/... which we can't write
  // to as non-root; the `echo >> "$LOG"` simply fails harmlessly (2>/dev/null in
  // cron). To keep the live test root-agnostic we only assert on systemctl acts.
  const healthy = run('ok', 'ok');
  ok(healthy.code === 0 && healthy.acts.trim() === '',
     'healthy chain → exit 0, NOTHING restarted');

  const deadlock = run('fail', 'ok');
  ok(/restart redsocks/.test(deadlock.acts) && !/restart mieru/.test(deadlock.acts),
     'chain DOWN + SOCKS5 up (redsocks deadlock) → restart redsocks ONLY');

  const mieruDown = run('fail', 'fail');
  ok(/restart mieru/.test(mieruDown.acts) && /restart redsocks/.test(mieruDown.acts),
     'chain + SOCKS5 DOWN (mieru down) → restart mieru AND redsocks');
  ok(mieruDown.acts.indexOf('restart mieru') < mieruDown.acts.indexOf('restart redsocks'),
     'mieru is restarted BEFORE redsocks');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
