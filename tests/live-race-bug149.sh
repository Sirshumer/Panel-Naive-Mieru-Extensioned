#!/usr/bin/env bash
# Bug 149 (race): live true-overlap double-submit test.
# Boots the REAL panel server with a throwaway DB + config, logs in, then fires
# two POST /api/users for the same username via Promise.all (true event-loop
# overlap). Acceptance: both requests return 2xx, and exactly ONE row exists.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
DBDIR="$TMP/db"
mkdir -p "$DBDIR"
PORT=3997

# Throwaway config: hardcoded /etc/rixxx-panel/config.json, dbPath → temp.
# admin/admin (matches server default hash), point DB at the temp dir.
mkdir -p /etc/rixxx-panel
cat > /etc/rixxx-panel/config.json <<JSON
{
  "domain": "localhost", "serverIp": "127.0.0.1",
  "adminUser": "admin",
  "adminPassHash": "$(node -e "console.log(require('$ROOT/panel/node_modules/bcryptjs' ).hashSync ? require('$ROOT/panel/node_modules/bcryptjs').hashSync('admin',12) : '')" 2>/dev/null || echo '')",
  "naivePort": 443, "mieruPortStart": 2012, "mieruPortEnd": 2022,
  "panelPort": $PORT, "panelHost": "127.0.0.1", "exposePanel": false,
  "dbPath": "$DBDIR/db.sqlite",
  "mitaStateFile": "$DBDIR/mita-state.json",
  "caddyBin": "/bin/true", "caddyFile": "$TMP/Caddyfile",
  "caddyConfigDir": "$TMP/caddy", "fakeSiteDir": "$TMP/fake",
  "language": "ru", "version": "1.4.4"
}
JSON

# The server uses bcrypt (better-sqlite3 build) for the admin hash; the default
# config hashes 'admin'. To avoid bcrypt-module mismatch, delete the config so
# the server falls back to its built-in default (admin/admin) but still uses our
# temp DB via PANEL env? dbPath only comes from config. So instead, generate the
# admin hash with the SAME bcrypt the server uses.
ADMIN_HASH="$(cd "$ROOT/panel" && node -e "console.log(require('bcryptjs').hashSync('admin',12))")"
cat > /etc/rixxx-panel/config.json <<JSON
{
  "domain": "localhost", "serverIp": "127.0.0.1",
  "adminUser": "admin",
  "adminPassHash": "$ADMIN_HASH",
  "naivePort": 443, "mieruPortStart": 2012, "mieruPortEnd": 2022,
  "panelPort": $PORT, "panelHost": "127.0.0.1", "exposePanel": false,
  "dbPath": "$DBDIR/db.sqlite",
  "mitaStateFile": "$DBDIR/mita-state.json",
  "caddyBin": "/bin/true", "caddyFile": "$TMP/Caddyfile",
  "caddyConfigDir": "$TMP/caddy", "fakeSiteDir": "$TMP/fake",
  "language": "ru", "version": "1.4.4"
}
JSON

# Boot server
( cd "$ROOT/panel" && PANEL_PORT=$PORT PANEL_HOST=127.0.0.1 node server/index.js >"$TMP/server.log" 2>&1 ) &
SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

# Wait for server (probe a GET endpoint that does NOT consume the login limiter)
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me" 2>/dev/null || echo 000)
  # 401 (unauthorized) means the server is up and routing; anything non-000 works
  if [ "$code" != "000" ]; then break; fi
  sleep 0.25
done

# Run the concurrent test via node http with a shared cookie jar.
cd "$ROOT/panel" && node -e '
const http = require("http");
const PORT = '"$PORT"';
function req(path, method, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    if (cookie) headers["Cookie"] = cookie;
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, res => {
      let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b, setCookie: res.headers["set-cookie"] }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const login = await req("/api/login", "POST", { username: "admin", password: "admin" });
  if (login.status !== 200) { console.error("LOGIN FAILED", login.status, login.body); process.exit(2); }
  const cookie = (login.setCookie || []).map(c => c.split(";")[0]).join("; ");
  const uname = "racetwin_" + Date.now();
  const payload = { username: uname, password: "Passw0rd!xy", protocols: ["naive","mieru"], quotaGb: 0 };
  // TRUE overlap: fire both without awaiting between them.
  const [r1, r2] = await Promise.all([
    req("/api/users", "POST", payload, cookie),
    req("/api/users", "POST", payload, cookie),
  ]);
  console.log("resp1:", r1.status, r1.body.slice(0,80));
  console.log("resp2:", r2.status, r2.body.slice(0,80));
  // Count rows for this username
  const list = await req("/api/users", "GET", null, cookie);
  const users = JSON.parse(list.body);
  const rows = users.filter(u => u.username === uname).length;
  console.log("racetest rows:", rows);
  const both2xx = (r1.status >= 200 && r1.status < 300) && (r2.status >= 200 && r2.status < 300);
  if (both2xx && rows === 1) { console.log("LIVE RACE TEST: PASS"); process.exit(0); }
  console.log("LIVE RACE TEST: FAIL (both2xx=" + both2xx + ", rows=" + rows + ")");
  process.exit(1);
})().catch(e => { console.error("TEST ERROR", e); process.exit(3); });
'
RESULT=$?
echo "--- server.log tail ---"
tail -20 "$TMP/server.log" || true
exit $RESULT
