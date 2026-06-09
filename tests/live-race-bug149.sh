#!/usr/bin/env bash
# Bug 149 (race): live true-overlap double-submit test against the REAL server.
# Boots the panel with a throwaway DB + config, logs in, then fires concurrent
# POST /api/users (Promise.all, true event-loop overlap) for the SAME payload.
#
# Acceptance covered:
#   A) double-submit WITH a unique email -> both 2xx, exactly 1 row, no false
#      "Email already in use" (the exact user-reported symptom).
#   B) double-submit WITHOUT email       -> both 2xx, exactly 1 row.
#   C) genuine duplicate email (other, pre-existing user) -> 409 (still rejected).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
mkdir -p "$TMP/db"
PORT="${PORT:-4021}"

# One clean throwaway config. Hash admin/admin with the SAME bcrypt module the
# server uses so login succeeds; point all writable paths at the temp dir.
ADMIN_HASH="$(cd "$ROOT/panel" && node -e "console.log(require('bcryptjs').hashSync('admin',12))")"
mkdir -p /etc/rixxx-panel
cat > /etc/rixxx-panel/config.json <<JSON
{
  "domain": "localhost", "serverIp": "127.0.0.1",
  "adminUser": "admin", "adminPassHash": "$ADMIN_HASH",
  "panelPort": $PORT, "panelHost": "127.0.0.1", "exposePanel": false,
  "dbPath": "$TMP/db/db.sqlite", "mitaStateFile": "$TMP/db/mita.json",
  "caddyBin": "/bin/true", "caddyFile": "$TMP/Caddyfile",
  "caddyConfigDir": "$TMP/caddy", "fakeSiteDir": "$TMP/fake",
  "language": "ru", "version": "1.4.5"
}
JSON

( cd "$ROOT/panel" && PANEL_PORT=$PORT PANEL_HOST=127.0.0.1 node server/index.js >"$TMP/server.log" 2>&1 ) &
SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null || true; rm -rf "$TMP"; rm -f /etc/rixxx-panel/config.json; }
trap cleanup EXIT

# Wait for the server (probe /api/me — does NOT consume the login limiter).
# curl returns the real HTTP code on success, or "000" on connection failure
# (no `|| echo` so the value isn't concatenated). 401 is the expected ready
# signal (unauthenticated GET /api/me), but any real HTTP code means "up".
READY=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me" 2>/dev/null) || true
  case "$code" in
    2*|3*|4*|5*) READY=1; break ;;
  esac
  sleep 0.25
done
if [ "$READY" != "1" ]; then echo "SERVER DID NOT START"; tail -20 "$TMP/server.log"; exit 4; fi

cd "$ROOT/panel" && PORT=$PORT node -e '
const http = require("http");
const PORT = parseInt(process.env.PORT, 10);
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
  const stamp = Date.now();
  let failed = false;

  // Scenario A: double-submit WITH a unique email (exact user symptom).
  const unameA = "racetwin_" + stamp, emailA = "twin_" + stamp + "@example.com";
  const payloadA = { username: unameA, email: emailA, password: "Passw0rd!xy", protocols: ["naive","mieru"], quotaGb: 0 };
  const [a1, a2] = await Promise.all([ req("/api/users","POST",payloadA,cookie), req("/api/users","POST",payloadA,cookie) ]);
  console.log("A resp1:", a1.status, a1.body.slice(0,70));
  console.log("A resp2:", a2.status, a2.body.slice(0,70));
  const rowsA = JSON.parse((await req("/api/users","GET",null,cookie)).body).filter(u => u.username === unameA).length;
  console.log("A rows:", rowsA);
  const aOk = (a1.status>=200&&a1.status<300)&&(a2.status>=200&&a2.status<300)&&rowsA===1;
  console.log("SCENARIO A (email double-submit):", aOk ? "PASS" : "FAIL"); if (!aOk) failed = true;

  // Scenario B: double-submit WITHOUT email (email optional).
  const unameB = "racenoemail_" + stamp;
  const payloadB = { username: unameB, password: "Passw0rd!xy", protocols: ["naive"], quotaGb: 0 };
  const [b1, b2] = await Promise.all([ req("/api/users","POST",payloadB,cookie), req("/api/users","POST",payloadB,cookie) ]);
  console.log("B resp1:", b1.status, "B resp2:", b2.status);
  const rowsB = JSON.parse((await req("/api/users","GET",null,cookie)).body).filter(u => u.username === unameB).length;
  console.log("B rows:", rowsB);
  const bOk = (b1.status>=200&&b1.status<300)&&(b2.status>=200&&b2.status<300)&&rowsB===1;
  console.log("SCENARIO B (no-email double-submit):", bOk ? "PASS" : "FAIL"); if (!bOk) failed = true;

  // Scenario C: GENUINE duplicate email (different, pre-existing user) -> 409.
  const r1c = await req("/api/users","POST",{ username:"owner_"+stamp, email:"dup_"+stamp+"@x.com", password:"Passw0rd!xy", protocols:["naive"], quotaGb:0 }, cookie);
  const r2c = await req("/api/users","POST",{ username:"other_"+stamp, email:"dup_"+stamp+"@x.com", password:"Passw0rd!xy", protocols:["naive"], quotaGb:0 }, cookie);
  console.log("C resp1:", r1c.status, "C resp2:", r2c.status, r2c.body.slice(0,50));
  const cOk = r1c.status===201 && r2c.status===409;
  console.log("SCENARIO C (real dup email -> 409):", cOk ? "PASS" : "FAIL"); if (!cOk) failed = true;

  // Scenario D: GENUINE duplicate username with a DIFFERENT password (a real
  // clash, NOT a double-submit) MUST still return 409 — the idempotent path
  // must not mask it.
  const unameD = "owner2_" + stamp;
  const r1d = await req("/api/users","POST",{ username:unameD, password:"FirstPass123", protocols:["naive"], quotaGb:0 }, cookie);
  const r2d = await req("/api/users","POST",{ username:unameD, password:"DifferentPass456", protocols:["naive"], quotaGb:0 }, cookie);
  console.log("D resp1:", r1d.status, "D resp2:", r2d.status, r2d.body.slice(0,50));
  const dOk = r1d.status===201 && r2d.status===409;
  console.log("SCENARIO D (real dup username, diff pass -> 409):", dOk ? "PASS" : "FAIL"); if (!dOk) failed = true;

  console.log("LIVE RACE TEST:", failed ? "FAIL" : "PASS");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("TEST ERROR", e && e.message); process.exit(3); });
'
RESULT=$?
echo "--- server.log tail ---"; tail -8 "$TMP/server.log" || true
exit $RESULT
