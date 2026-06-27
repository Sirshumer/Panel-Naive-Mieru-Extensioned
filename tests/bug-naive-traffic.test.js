/**
 * TASK 1 (MEDIUM): NaiveProxy traffic accounting was always 0.0 — only Mieru
 * was counted.
 *
 * Two root causes were fixed:
 *   (A) Caddyfile config: the `log` directive lived in the GLOBAL options block,
 *       which only configures Caddy's *runtime* logger — it never writes HTTP
 *       access logs, so access.log contained no per-request user_id / byte
 *       counters for parseCaddyTraffic() to sum. The access `log` directive is
 *       now emitted INSIDE the site block (verified in caddyTemplate.test.js).
 *   (B) Rotation: parseCaddyTraffic() only read the single current log file, so
 *       every Caddy roll silently reset Naive usage to 0. It now also folds in
 *       the rolled siblings (`access-<ts>.log`).
 *
 * This test exercises the parser logic (a faithful copy of index.js
 * foldCaddyLogFile + parseCaddyTraffic) against real temp files, including a
 * rolled sibling, so it runs without a live server.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else      { console.log(`  \u2717 ${name}`); fail++; }
}

// ── parser under test (mirrors index.js foldCaddyLogFile + parseCaddyTraffic) ──
function foldCaddyLogFile(file, out) {
  let raw;
  try {
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (stat.size === 0) return;
    const MAX = 32 * 1024 * 1024;
    if (stat.size > MAX) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(MAX);
      fs.readSync(fd, buf, 0, MAX, stat.size - MAX);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
      const nl = raw.indexOf('\n');
      if (nl >= 0) raw = raw.slice(nl + 1);
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch { return; }

  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    const req = e.request || {};
    const user = req.user_id || e.user_id || '';
    if (!user) continue;
    const up   = Number(e.bytes_read) || 0;
    const down = Number(e.size != null ? e.size : e.bytes_written) || 0;
    const ts   = e.ts;
    if (!out[user]) out[user] = { uploadB: 0, downloadB: 0, lastTs: 0 };
    out[user].uploadB   += up;
    out[user].downloadB += down;
    if (typeof ts === 'number' && ts > out[user].lastTs) out[user].lastTs = ts;
  }
}

function parseCaddyTraffic(file) {
  const out = {};
  foldCaddyLogFile(file, out);
  try {
    const dir  = path.dirname(file);
    const base = path.basename(file).replace(/\.log$/i, '');
    const rollRe = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-.*\\.log$', 'i');
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (name === path.basename(file)) continue;
        if (!rollRe.test(name)) continue;
        foldCaddyLogFile(path.join(dir, name), out);
      }
    }
  } catch { /* best-effort */ }

  const result = {};
  for (const [user, v] of Object.entries(out)) {
    const uploadMB   = v.uploadB   / 1048576;
    const downloadMB = v.downloadB / 1048576;
    result[user] = {
      uploadMB, downloadMB,
      usedMB:   uploadMB + downloadMB,
      lastSeen: v.lastTs ? new Date(v.lastTs * 1000).toISOString() : null
    };
  }
  return result;
}

// A realistic caddy-forwardproxy JSON access line for an authenticated CONNECT.
function caddyLine({ user, bytesRead, size, ts }) {
  return JSON.stringify({
    level: 'info', ts, logger: 'http.log.access',
    msg: 'handled request',
    request: {
      remote_ip: '203.0.113.7', proto: 'HTTP/2.0', method: 'CONNECT',
      host: 'example.com:443', user_id: user
    },
    bytes_read: bytesRead, size, status: 200, duration: 1.5
  });
}

// ── temp dir + fixtures ──────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddytraffic-'));
const live = path.join(dir, 'access.log');

const MB = 1048576;

console.log('[1] authenticated CONNECT lines are attributed to the right user_id');
fs.writeFileSync(live, [
  caddyLine({ user: 'alice', bytesRead: 1 * MB, size: 3 * MB, ts: 1700000000.0 }),
  caddyLine({ user: 'alice', bytesRead: 1 * MB, size: 1 * MB, ts: 1700000100.0 }),
  caddyLine({ user: 'bob',   bytesRead: 2 * MB, size: 0,      ts: 1700000050.0 }),
  ''  // trailing newline
].join('\n'));
let r = parseCaddyTraffic(live);
check('alice present', !!r.alice);
check('bob present',   !!r.bob);
check('alice upload = 2 MB',   Math.abs(r.alice.uploadMB   - 2) < 1e-6);
check('alice download = 4 MB', Math.abs(r.alice.downloadMB - 4) < 1e-6);
check('alice used = 6 MB',     Math.abs(r.alice.usedMB     - 6) < 1e-6);
check('bob upload = 2 MB',     Math.abs(r.bob.uploadMB     - 2) < 1e-6);
check('alice lastSeen is the later ts', r.alice.lastSeen === new Date(1700000100 * 1000).toISOString());

console.log('\n[2] lines without user_id (no auth / not a proxy req) are ignored');
fs.writeFileSync(live, [
  JSON.stringify({ level: 'info', msg: 'handled request', request: { method: 'GET' }, bytes_read: 999 * MB, size: 999 * MB }),
  caddyLine({ user: 'carol', bytesRead: 5 * MB, size: 5 * MB, ts: 1700000200.0 }),
  ''
].join('\n'));
r = parseCaddyTraffic(live);
check('no anonymous bucket', Object.keys(r).every(k => k === 'carol'));
check('carol counted = 10 MB', Math.abs(r.carol.usedMB - 10) < 1e-6);

console.log('\n[3] `size` is preferred for download, falls back to bytes_written');
fs.writeFileSync(live, [
  JSON.stringify({ ts: 1700000300.0, request: { user_id: 'dave' }, bytes_read: 1 * MB, bytes_written: 7 * MB }),
  ''
].join('\n'));
r = parseCaddyTraffic(live);
check('dave download from bytes_written = 7 MB', Math.abs(r.dave.downloadMB - 7) < 1e-6);

console.log('\n[4] rotation: usage survives a Caddy log roll (rolled sibling is summed)');
// Caddy rolls the live log to e.g. access-2025-06-22T01-02-03.000.log
const rolled = path.join(dir, 'access-2025-06-22T01-02-03.000.log');
fs.writeFileSync(rolled, [
  caddyLine({ user: 'erin', bytesRead: 10 * MB, size: 20 * MB, ts: 1699990000.0 }),
  ''
].join('\n'));
fs.writeFileSync(live, [
  caddyLine({ user: 'erin', bytesRead: 5 * MB, size: 5 * MB, ts: 1700001000.0 }),
  ''
].join('\n'));
r = parseCaddyTraffic(live);
check('erin upload = 15 MB (5 live + 10 rolled)',   Math.abs(r.erin.uploadMB   - 15) < 1e-6);
check('erin download = 25 MB (5 live + 20 rolled)', Math.abs(r.erin.downloadMB - 25) < 1e-6);
check('erin used = 40 MB across rotation',          Math.abs(r.erin.usedMB     - 40) < 1e-6);
check('erin lastSeen is the live (newer) ts',       r.erin.lastSeen === new Date(1700001000 * 1000).toISOString());

console.log('\n[5] unrelated files in the dir are NOT counted as rolled logs');
fs.writeFileSync(path.join(dir, 'access.log.gz'), 'binary-gzip-not-parsed');
fs.writeFileSync(path.join(dir, 'other-service.log'), caddyLine({ user: 'mallory', bytesRead: 99 * MB, size: 99 * MB, ts: 1700002000.0 }));
r = parseCaddyTraffic(live);
check('mallory (other-service.log) not counted', !r.mallory);
check('erin still 40 MB (gz + foreign log ignored)', Math.abs(r.erin.usedMB - 40) < 1e-6);

console.log('\n[6] empty / missing log → empty result, no throw');
const missing = path.join(dir, 'does-not-exist.log');
r = parseCaddyTraffic(missing);
check('missing file → {}', Object.keys(r).length === 0);

// cleanup
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
