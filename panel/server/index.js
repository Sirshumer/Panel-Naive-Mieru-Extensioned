/**
 * Panel Naive + Mieru by RIXXX — Express backend  v1.2.6
 * Node.js 20 LTS + Express + better-sqlite3 + WebSocket + node-cron
 *
 * v1.2.3: Migrated from standalone naive binary to caddy-forwardproxy-naive.
 *   buildCaddyfile(cfg, users) — rebuilds /etc/caddy-naive/Caddyfile atomically
 *   reloadCaddy()              — systemctl reload caddy-naive (graceful, zero downtime)
 *   applyAllConfigs()          — rebuilds Caddyfile + applies Mita config in one call
 *   /api/services/rebuild-all  — endpoint used by update.sh --repair
 *
 * v1.2.5 hotfixes:
 *   Bug 44: buildCaddyfile() skips users without plaintext password (logs warning)
 *   Bug 50: reloadCaddy() uses only systemctl reload — pgrep fallback removed
 *   Bug 51: buildMitaStateFile() uses safe defaults for mieruPortStart/End
 *   Bug 52: /api/settings/naive-port verifies caddy-naive is active after restart
 *   Bug 53: saveConfig() performs atomic write via .new tmp file then rename
 *
 * Bug 5:  Sing-Box outbound uses `transport` field (not `protocol`)
 * Bug 7:  UFW single-port vs range helper (ufwMieruRule)
 * Bug 12: server_ports array in Mieru Sing-Box config
 * Bug 13: version synced via scripts/sync-version.sh
 */
'use strict';

const express        = require('express');
const session        = require('express-session');
const helmet         = require('helmet');
const morgan         = require('morgan');
const rateLimit      = require('express-rate-limit');
const bcrypt         = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cron           = require('node-cron');
const http           = require('http');
const { WebSocketServer } = require('ws');
const fs             = require('fs');
const path           = require('path');
const { execSync, execFileSync } = require('child_process');
const si             = require('systeminformation');
const crypto         = require('crypto');   // Bug 100: module-level require so generateSafePassword() has a real Node crypto (not Web-Crypto globalThis.crypto, which lacks randomInt)

// ── Paths ─────────────────────────────────────────────────────────────────────
const PANEL_CONFIG    = '/etc/rixxx-panel/config.json';
const DB_PATH         = '/var/lib/rixxx-panel/db.sqlite';
const MITA_STATE_FILE = '/var/lib/rixxx-panel/mita-state.json';
// Bug 143: canonical version source written by install.sh / update.sh from the
// repo's VERSION file. Read LIVE on each /api/status so the panel UI reflects
// the installed version immediately after `update.sh` — no manual edits, no
// process restart needed. Format: `panel_version=X.Y.Z`.
const VERSION_FILE    = '/etc/rixxx-panel/version';

// v1.2.3: Caddy-forwardproxy-naive paths (replaces standalone naive binary)
const CADDY_BIN         = '/usr/local/bin/caddy-naive';
const CADDY_CONFIG_DIR  = '/etc/caddy-naive';
const CADDY_FILE        = '/etc/caddy-naive/Caddyfile';
const FAKE_SITE_DIR     = '/var/www/fake-site';
const LOG_CADDY         = '/var/log/caddy-naive/access.log';
const LOG_PANEL         = '/var/log/panel-naive-mieru.log';

// Legacy path kept for migration detection only
const LEGACY_NAIVE_BIN = '/usr/local/bin/naive';

// ── Load system config ────────────────────────────────────────────────────────
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(PANEL_CONFIG, 'utf8'));
} catch {
  cfg = {
    domain: 'localhost', serverIp: '127.0.0.1',
    adminUser: 'admin',
    adminPassHash: bcrypt.hashSync('admin', 12),
    naivePort: 443, mieruPortStart: 2012, mieruPortEnd: 2022,
    panelPort: 3000, panelHost: '127.0.0.1', exposePanel: false,
    dbPath:        DB_PATH,
    caddyBin:      CADDY_BIN,
    caddyFile:     CADDY_FILE,
    caddyConfigDir: CADDY_CONFIG_DIR,
    fakeSiteDir:   FAKE_SITE_DIR,
    fakeSiteUrl:   'https://www.example.com',
    probeSecret:   '',
    probeMode:     'bare',   // Bug 81: 'off' | 'bare' | 'secret' (matches known-good ref)
    mitaStateFile: MITA_STATE_FILE,
    trafficPattern: 'NOOP', mtu: 1400, udpEnabled: false,
    // Cascade (relay): Naive uses Caddyfile upstream; Mieru uses Variant B
    // (redsocks+iptables+mieru-client) orchestrated by scripts/cascade_mieru.sh.
    cascadeEnabled: false, cascadeNaiveUpstream: '',
    cascadeMieru: { host: '', portStart: 2012, portEnd: 2022, user: '', pass: '', mtu: 1400 },
    cascadeMieruEgress: {},   // legacy (Variant A native egress) — kept for back-compat
    language: 'ru', version: '1.4.4'
  };
}

// Bug 143 (recurring): single source of truth for the displayed version.
// Precedence, read LIVE so the UI updates the moment update.sh runs:
//   1. /etc/rixxx-panel/version   (written by install.sh/update.sh from VERSION)
//   2. the VERSION file bundled next to the panel code (repo source of truth)
//   3. config.json's `version` field (synced by update.sh as a belt-and-braces)
//   4. hard fallback constant
// Returns a clean semver-ish string. Cheap (tiny file reads); fine per-request.
const VERSION_FALLBACK = '1.4.4';
function readPanelVersion() {
  // 1) /etc/rixxx-panel/version  → "panel_version=1.4.4"
  try {
    const raw = fs.readFileSync(VERSION_FILE, 'utf8');
    const m = raw.match(/panel_version\s*=\s*([^\s#]+)/);
    const v = (m ? m[1] : raw.split('\n')[0]).trim();
    if (v) return v;
  } catch {}
  // 2) bundled VERSION file (../../VERSION relative to server/index.js)
  for (const p of [path.join(__dirname, '..', '..', 'VERSION'),
                   path.join(__dirname, '..', 'VERSION')]) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch {}
  }
  // 3) config.json
  if (cfg && cfg.version) return String(cfg.version).trim();
  // 4) fallback
  return VERSION_FALLBACK;
}

// Resolved paths (prefer config values, fall back to constants)
const resolvedDb        = cfg.dbPath        || DB_PATH;
const resolvedMitaFile  = cfg.mitaStateFile || MITA_STATE_FILE;
const resolvedCaddyFile = cfg.caddyFile     || CADDY_FILE;
const resolvedCaddyBin  = cfg.caddyBin      || CADDY_BIN;
const resolvedCaddyCfgDir = cfg.caddyConfigDir || CADDY_CONFIG_DIR;
const resolvedFakeSiteDir = cfg.fakeSiteDir  || FAKE_SITE_DIR;

// ── SQLite (better-sqlite3) ───────────────────────────────────────────────────
let db = null;
try {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(resolvedDb), { recursive: true });
  db = new Database(resolvedDb);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id        TEXT PRIMARY KEY,
      email     TEXT UNIQUE,
      username  TEXT NOT NULL UNIQUE,
      passHash  TEXT NOT NULL,
      password  TEXT NOT NULL DEFAULT '',
      expiry    TEXT,
      protocols TEXT DEFAULT '["naive","mieru"]',
      quotaMB   INTEGER DEFAULT 0,
      usedMB    REAL    DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastSeen  TEXT
    );
    CREATE TABLE IF NOT EXISTS traffic_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL,
      uploadMB   REAL DEFAULT 0,
      downloadMB REAL DEFAULT 0,
      ts         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS panel_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Migrate: add password column if missing (upgrade from v1.0.x)
  try { db.exec(`ALTER TABLE users ADD COLUMN password TEXT NOT NULL DEFAULT ''`); } catch {}

  // Migrate: make `email` nullable so it can be optional (TLS cert is set at
  // install time via Caddy ACME, not per-user). Old schema had `email TEXT
  // NOT NULL UNIQUE`, which rejects empty/absent emails and collides on ''.
  // Rebuild the table only if the column is still NOT NULL.
  try {
    const cols = db.prepare(`PRAGMA table_info(users)`).all();
    const emailCol = cols.find(c => c.name === 'email');
    if (emailCol && emailCol.notnull === 1) {
      db.exec(`
        BEGIN TRANSACTION;
        ALTER TABLE users RENAME TO users_legacy;
        CREATE TABLE users (
          id        TEXT PRIMARY KEY,
          email     TEXT UNIQUE,
          username  TEXT NOT NULL UNIQUE,
          passHash  TEXT NOT NULL,
          password  TEXT NOT NULL DEFAULT '',
          expiry    TEXT,
          protocols TEXT DEFAULT '["naive","mieru"]',
          quotaMB   INTEGER DEFAULT 0,
          usedMB    REAL    DEFAULT 0,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          lastSeen  TEXT
        );
        INSERT INTO users
          (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen)
        SELECT
          id,
          CASE WHEN email='' THEN NULL ELSE email END,
          username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen
        FROM users_legacy;
        DROP TABLE users_legacy;
        COMMIT;
      `);
      console.log('[DB] migrated users.email -> nullable (email is now optional)');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('[DB] email-nullable migration skipped:', e.message);
  }

  // Bug 149 (CRITICAL): servers upgraded from v1.2 have `email TEXT UNIQUE`
  // (already nullable, so the rebuild above is skipped) but v1.2 *stored* an
  // empty string '' for users without an email. SQLite treats '' as a real,
  // distinct value for UNIQUE — so the SECOND empty-email row already collides,
  // and creating ANY new user fails with "UNIQUE constraint failed: users.email".
  // Normalise every legacy '' email to NULL unconditionally (NULLs are exempt
  // from UNIQUE in SQLite, so an unlimited number of users may have no email).
  try {
    const fixed = db.prepare(`UPDATE users SET email = NULL WHERE email = ''`).run();
    if (fixed.changes > 0)
      console.log(`[DB] Bug 149 fix: normalised ${fixed.changes} legacy empty-string email(s) -> NULL`);
  } catch (e) {
    console.error('[DB] empty-email normalisation failed:', e.message);
  }
} catch (err) {
  console.error('[DB] SQLite unavailable:', err.message, '— using in-memory store');
}

// In-memory fallback
const memUsers = new Map();

// ── User DB helpers ───────────────────────────────────────────────────────────
function getAllUsers() {
  if (db) return db.prepare('SELECT * FROM users ORDER BY createdAt DESC').all();
  return [...memUsers.values()];
}
function getUserByUsername(username) {
  if (db) return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return [...memUsers.values()].find(u => u.username === username);
}
function getUserById(id) {
  if (db) return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return memUsers.get(id);
}
// Bug 149: map a raw better-sqlite3 error to a safe, user-facing message +
// HTTP status. UNIQUE-constraint violations become friendly 409s; everything
// else stays a generic 500 with NO internal path/stacktrace leaked to the UI.
function describeDbError(e) {
  const msg = String(e && e.message || '');
  if (/UNIQUE constraint failed:\s*users\.email/i.test(msg))
    return { status: 409, error: 'Email already in use' };
  if (/UNIQUE constraint failed:\s*users\.username/i.test(msg))
    return { status: 409, error: 'Username already exists' };
  if (/UNIQUE constraint failed/i.test(msg))
    return { status: 409, error: 'A user with these details already exists' };
  return { status: 500, error: 'Could not save user (database error)' };
}

function upsertUser(u) {
  if (db) {
    // Bug 149: never persist an empty-string email — UNIQUE treats '' as a real
    // value and collides across email-less users. Always store NULL instead.
    const email = (u.email && String(u.email).trim()) ? String(u.email).trim() : null;
    db.prepare(`
      INSERT INTO users
        (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen)
      VALUES
        (@id,@email,@username,@passHash,@password,@expiry,@protocols,@quotaMB,@usedMB,@createdAt,@updatedAt,@lastSeen)
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, username=excluded.username,
        passHash=excluded.passHash, password=excluded.password,
        expiry=excluded.expiry, protocols=excluded.protocols,
        quotaMB=excluded.quotaMB, usedMB=excluded.usedMB,
        updatedAt=excluded.updatedAt, lastSeen=excluded.lastSeen
    `).run({ ...u, email, password: u.password || '' });
  } else {
    memUsers.set(u.id, u);
  }
}

// Bug 149 (race): create a user atomically. The old flow did
// `getUserByUsername()` then a separate INSERT, each request minting a fresh
// UUID. On a double-submit the first request created the user (201) while the
// second slipped past the pre-check, hit the UNIQUE(username) constraint, and
// returned a false "Username already exists" — even though the user already
// existed and the key worked (visible only after F5).
//
// Strategy: a single `INSERT ... ON CONFLICT(username) DO NOTHING`.
//   - changes===1 → we inserted the row  → { created:true }.
//   - changes===0 → the username already exists. The CALLER guarantees (via a
//     synchronous "did it exist before this request?" check + the in-flight
//     coalescing map) that this can only be a concurrent twin of THIS create,
//     so it's an idempotent success → { created:false, idempotent:true } with
//     the existing row. (We don't compare passHash because bcrypt salts differ
//     per call; a genuine pre-existing clash is rejected by the route before we
//     ever get here.)
function createUserAtomic(u) {
  const email = (u.email && String(u.email).trim()) ? String(u.email).trim() : null;
  if (db) {
    const info = db.prepare(`
      INSERT INTO users
        (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen)
      VALUES
        (@id,@email,@username,@passHash,@password,@expiry,@protocols,@quotaMB,@usedMB,@createdAt,@updatedAt,@lastSeen)
      ON CONFLICT(username) DO NOTHING
    `).run({ ...u, email, password: u.password || '' });

    if (info.changes === 1)
      return { created: true, user: getUserByUsername(u.username) };
    // No insert → a concurrent twin already created it → idempotent success.
    return { created: false, idempotent: true, user: getUserByUsername(u.username) };
  }
  // in-memory fallback
  const existing = [...memUsers.values()].find(x => x.username === u.username);
  if (existing) return { created: false, idempotent: true, user: existing };
  memUsers.set(u.id, { ...u, email });
  return { created: true, user: memUsers.get(u.id) };
}

// Bug 149 (race): coalesce concurrent create requests for the same username so a
// rapid double-submit can't even start two INSERTs. Maps username -> Promise of
// the in-flight create result.
const inflightCreates = new Map();

// Bug 149: cheap duplicate-email pre-check so we can return a clean 409 BEFORE
// hitting the UNIQUE constraint (and as a guard for email-less users → no row).
function getUserByEmail(email) {
  const e = (email && String(email).trim()) ? String(email).trim() : null;
  if (!e) return undefined;
  if (db) return db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  return [...memUsers.values()].find(u => u.email === e);
}
function deleteUser(id) {
  if (db) db.prepare('DELETE FROM users WHERE id = ?').run(id);
  else memUsers.delete(id);
}

// ── Persist config ────────────────────────────────────────────────────────────
// Bug 53: atomic write via .new temp file then rename — prevents partial reads
//         if the process is interrupted during the write.
function saveConfig() {
  try {
    const dir = path.dirname(PANEL_CONFIG);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = PANEL_CONFIG + '.new';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, PANEL_CONFIG);   // atomic replace
  } catch (e) { console.error('[CFG]', e.message); }
}

// ── buildCaddyfile() ─────────────────────────────────────────────────────────
// Rebuilds the Caddyfile from current cfg and user list.
//
// Bug 23 (P0): the old code emitted a bare "basic_auth" keyword with no
//   arguments (invalid in caddy-forwardproxy-naive → parse error) and used
//   the wrong spelling "basicauth" for per-user lines.  Both are now fixed
//   by delegating to caddyTemplate.js which is the single source of truth.
//
// Bug 26 (P1): delegate to caddyTemplate.js so install.sh, update.sh, and
//   this file all produce byte-for-byte identical Caddyfiles.
//
// Bug 28 (P1): removed redundant "tls <email>" inside the site block —
//   Caddy's automatic HTTPS handles TLS; the global email directive is enough.
//
// Bug 29 (P1): directive order inside forward_proxy is now enforced by the
//   template: basic_auth lines → hide_ip → hide_via → probe_resistance.
//
// Bug 30 (P1): "order forward_proxy first" now appears in the
//   global block via the template.
//
// Bug 34: placeholder emitted when naiveUsers is empty so the forward_proxy
//   block always has at least one credential (prevents unauthenticated access
//   and Caddy validation failure).
//
// Bug 38 (P2): log rotation uses roll_keep_for 720h (30 days) not roll_keep 5.
//
// Bug 21: no site-level log block — global block covers all traffic.
// ── normalizeUpstream() — Bug 92 ─────────────────────────────────────────────
// Caddy's forward_proxy `upstream` directive only accepts a clean https:// URL.
// Users paste the subscription-format key as-is (e.g. "naive+https://u:p@h:443"),
// which makes caddy validate fail with:
//   "forward_proxy: insecure schemes are only allowed to localhost upstreams".
// Strip a leading "naive+" (and any other "<scheme>+" wrapper) so we end up with
// a bare https:// URL. If the input has no scheme at all, assume https://.
function normalizeUpstream(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // Drop a leading "xxx+" wrapper such as "naive+https://..." → "https://..."
  s = s.replace(/^[a-z][a-z0-9.+-]*\+(?=https?:\/\/)/i, '');
  // If a non-https scheme slipped through (e.g. "http://"), upgrade to https.
  s = s.replace(/^http:\/\//i, 'https://');
  // No scheme at all → assume https.
  if (!/^https:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function buildCaddyfile(config, users) {
  // Filter to naive-protocol users only
  // Bug 44: skip users without a plaintext password — caddy-forwardproxy-naive
  //         hashes the password internally; we cannot feed it a bcrypt hash.
  //         Log a warning so operators know which users are missing.
  const naiveUsers = users.filter(u => {
    try { return JSON.parse(u.protocols || '["naive","mieru"]').includes('naive'); }
    catch { return true; }
  }).map(u => {
    const pass = (u.password || '').trim();
    if (!pass) {
      console.warn(`[CADDY] Bug 44: user '${u.username}' has no plaintext password — skipped from Caddyfile`);
      return null;
    }
    return { username: u.username, password: pass };
  }).filter(Boolean);

  // Read probe secret from config or from the file written by install.sh
  const probeSecret = (config.probeSecret || '').trim() ||
    (fs.existsSync(path.join(resolvedCaddyCfgDir, 'probe_secret'))
      ? fs.readFileSync(path.join(resolvedCaddyCfgDir, 'probe_secret'), 'utf8').trim()
      : '');

  // Bug 81: probe_resistance mode ('off' | 'bare' | 'secret').
  // Back-compat: derive from probeSecret when unset.
  let probeMode = (config.probeMode || '').trim().toLowerCase();
  if (!probeMode) probeMode = probeSecret ? 'secret' : 'bare';

  // Bug 26: delegate to the shared template module (single source of truth).
  // Falls back to an inline render if the template file is not yet deployed.
  const tplPath = path.join(__dirname, 'caddyTemplate.js');
  if (fs.existsSync(tplPath)) {
    const tpl = require(tplPath);
    return tpl.render({
      adminEmail:  config.adminEmail  || '',
      domain:      config.domain      || 'localhost',
      naivePort:   config.naivePort   || 443,
      fakeSiteDir: resolvedFakeSiteDir,
      // Bug 98: pass fakeSiteUrl so the template can reverse_proxy a real site.
      fakeSiteUrl: config.fakeSiteUrl || '',
      probeSecret,
      probeMode,
      logFile:     LOG_CADDY,
      // Bug 92: normalize (strip "naive+" etc.) before it reaches the template.
      upstream:    (config.cascadeEnabled && config.cascadeNaiveUpstream) ? normalizeUpstream(config.cascadeNaiveUpstream) : '',
      // v1.4.0: panel external-access subdomain block (TLS + basic_auth + webBasePath).
      exposePanel:        !!config.exposePanel,
      panelDomain:        config.panelDomain        || '',
      panelBasicAuthUser: config.panelBasicAuthUser || '',
      panelBasicAuthHash: config.panelBasicAuthHash || '',
      webBasePath:        config.webBasePath        || '',
      panelStubPage:      config.panelStubPage      || '/var/www/panel-stub/index.html',
      panelPort:          config.panelPort          || 3000,
    }, naiveUsers);
  }

  // ── Inline fallback (identical rules to caddyTemplate.js) ─────────────────
  // Used only when caddyTemplate.js is not yet on disk (e.g. very first boot
  // before install_panel() has run).  Kept in sync with the template manually.
  // (crypto is required at module level — Bug 100)
  let authLines;
  if (naiveUsers.length > 0) {
    // Bug 23: each credential line is "basic_auth <user> <pass>" — no bare keyword
    authLines = naiveUsers
      .map(u => `    basic_auth ${u.username} ${u.password}`)
      .join('\n');
  } else {
    // Bug 34: unreachable placeholder keeps the block non-empty
    const rnd = crypto.randomBytes(20).toString('hex');
    authLines = `    basic_auth _placeholder_${rnd.slice(0, 16)} _disabled_${rnd.slice(16)}`;
  }

  // Bug 29 + Bug 81: probe_resistance comes after hide_ip + hide_via.
  // 'off' → none; 'secret' → with token; 'bare' → keyword only.
  let probeLine;
  if (probeMode === 'off') {
    probeLine = '';
  } else if (probeMode === 'secret' && probeSecret) {
    probeLine = `\n    probe_resistance ${probeSecret}`;
  } else {
    probeLine = `\n    probe_resistance`;
  }

  // v1.2.6: cascade — upstream proxy support (inline fallback)
  // Bug 92: normalize the upstream so forward_proxy gets a clean https:// URL.
  const upstreamUrl = (config.cascadeEnabled && config.cascadeNaiveUpstream) ? normalizeUpstream(config.cascadeNaiveUpstream) : '';
  const upstreamLine = upstreamUrl ? `\n    upstream ${upstreamUrl}` : '';

  // Bug 98: masquerade — file_server (default) or reverse_proxy (real site).
  let masqueradeBlock;
  {
    const fu = String(config.fakeSiteUrl || '').trim();
    const isPlaceholder = /^https?:\/\/(www\.)?example\.com\/?$/i.test(fu);
    const m = (!isPlaceholder && fu) ? fu.match(/^(https?):\/\/([^\/\s]+)/i) : null;
    if (m) {
      const scheme = m[1].toLowerCase(), host = m[2];
      masqueradeBlock = scheme === 'https'
        ? `  reverse_proxy https://${host} {\n    header_up Host ${host}\n    transport http {\n      tls\n      tls_server_name ${host}\n    }\n  }`
        : `  reverse_proxy http://${host} {\n    header_up Host ${host}\n  }`;
    } else {
      masqueradeBlock = `  file_server {\n    root ${resolvedFakeSiteDir}\n  }`;
    }
  }

  // v1.4.0: panel external-access subdomain block (inline fallback — mirrors
  // caddyTemplate.renderPanelBlock). Emitted only when external access is on.
  let panelBlock = '';
  {
    const expose      = !!config.exposePanel;
    const panelDomain = String(config.panelDomain || '').trim();
    const baUser      = String(config.panelBasicAuthUser || '').trim();
    const baHash      = String(config.panelBasicAuthHash || '').trim();
    const stubFile    = String(config.panelStubPage || '/var/www/panel-stub/index.html').trim();
    let   webBasePath = String(config.webBasePath || '').trim().replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._~-]/g, '');
    const panelPort   = parseInt(config.panelPort, 10) || 3000;
    if (expose && panelDomain && webBasePath) {
      const stubDir = stubFile.replace(/\/[^/]*$/, '') || '/var/www/panel-stub';
      let ba = '';
      if (baUser && baHash) ba = `    basic_auth {\n      ${baUser} ${baHash}\n    }\n`;
      panelBlock =
`\n\n# ── v1.4.0: panel external access (TLS + basic_auth + webBasePath) ────────────\n${panelDomain} {\n  tls ${config.adminEmail || ''}\n\n  # BUG-140: normalize bare base path to trailing slash (relative-asset resolve)\n  redir /${webBasePath} /${webBasePath}/ 301\n\n  handle_path /${webBasePath}/* {\n${ba}    reverse_proxy 127.0.0.1:${panelPort}\n  }\n\n  # Root and any path outside the secret base path → static stub (not a redirect)\n  handle {\n    root * ${stubDir}\n    file_server\n  }\n}\n`;
    }
  }

  // Bug 28: no "tls <email>" inside site block
  // Bug 30: order directive in global block
  // Bug 38: roll_keep_for 720h
  return `{
  # Bug 30 / Bug 102 (CRITICAL): forward_proxy before ANY handler (file_server
  # OR reverse_proxy). "before file_server" let mirror-mode reverse_proxy hijack
  # authenticated CONNECT → all naive keys broke. "first" fixes both modes.
  order forward_proxy first
  # Bug 80: HTTP/1.1 + HTTP/2 only (disable HTTP/3 / QUIC)
  servers {
    protocols h1 h2
  }
  email ${config.adminEmail || ''}
  admin off
  log {
    # Bug 38: 30-day retention by age
    output file ${LOG_CADDY} {
      roll_size     50mb
      roll_keep_for 720h
    }
    format json
  }
}

# HTTP → HTTPS redirect (also needed for ACME HTTP-01 fallback)
:80 {
  redir https://{host}{uri} permanent
}

:${config.naivePort || 443}, ${config.domain || 'localhost'} {
  # Bug 83: match the known-good reference server exactly (":<port>, <domain>"
  # listener + explicit tls + no route{} wrapper).
  tls ${config.adminEmail || ''}

  forward_proxy {
    # Bug 23: no bare "basic_auth" token; each line IS the credential directive
    # Bug 29: order — credentials → hide_ip → hide_via → probe_resistance
${authLines}
    hide_ip
    hide_via${probeLine}${upstreamLine}
  }

${masqueradeBlock}
}
${panelBlock}`;
}

// ── writeCaddyfileAtomic() ────────────────────────────────────────────────────
// Bug 90: caddy-naive.service runs as User=caddy/Group=caddy. If the Caddyfile
// (and its parent dir) are root:root 640, the caddy user cannot read it and the
// service crash-loops with "permission denied" → "Start request repeated too
// quickly". Every write MUST leave the file as root:caddy 640 and the config dir
// as root:caddy 750 (the group needs the dir's execute/traverse bit to open the
// file inside it). chown is best-effort: it only works when the panel runs as
// root, which it does in production.
function fixCaddyPerms() {
  try {
    // Dir: root:caddy 750 so the caddy group can traverse + list.
    execSync(`chown root:caddy '${resolvedCaddyCfgDir}' 2>/dev/null || true`, { timeout: 5000 });
    execSync(`chmod 750 '${resolvedCaddyCfgDir}' 2>/dev/null || true`, { timeout: 5000 });
    // Caddyfile: root:caddy 640 so the caddy group can read it.
    if (fs.existsSync(resolvedCaddyFile)) {
      execSync(`chown root:caddy '${resolvedCaddyFile}' 2>/dev/null || true`, { timeout: 5000 });
      execSync(`chmod 640 '${resolvedCaddyFile}' 2>/dev/null || true`, { timeout: 5000 });
    }
    // probe_secret: root:caddy 640 so caddy can read it for probe_resistance.
    const probeFile = path.join(resolvedCaddyCfgDir, 'probe_secret');
    if (fs.existsSync(probeFile)) {
      execSync(`chown root:caddy '${probeFile}' 2>/dev/null || true`, { timeout: 5000 });
      execSync(`chmod 640 '${probeFile}' 2>/dev/null || true`, { timeout: 5000 });
    }
  } catch (e) {
    console.warn('[CADDY] fixCaddyPerms (non-fatal):', e.message);
  }
}

function writeCaddyfileAtomic(content) {
  fs.mkdirSync(resolvedCaddyCfgDir, { recursive: true });
  const tmp = resolvedCaddyFile + '.new';
  fs.writeFileSync(tmp, content, { mode: 0o640 });
  fs.renameSync(tmp, resolvedCaddyFile);   // atomic replace
  // Bug 90: hand ownership to root:caddy so the service can read it.
  fixCaddyPerms();
}

// Bug 91: last caddy apply error, surfaced to the UI when an apply fails.
let lastCaddyError = '';
function getLastCaddyError() { return lastCaddyError; }

// ── applyCaddyConfig() — Bug 91 ──────────────────────────────────────────────
// Previously the panel applied config via `systemctl reload` (kill -USR1). A
// graceful reload SILENTLY KEEPS the old in-memory config when the new config
// cannot be read (e.g. Bug 90 permission error): `validate` says Valid, status
// is active, logs say "Reloaded", a direct curl works — yet the running process
// never loaded the new upstream, so the client exits from the Entry node and the
// cascade is effectively NOT applied. The failure only surfaced on a full
// restart. Therefore we now ALWAYS do a full `systemctl restart` and then verify
// `systemctl is-active`; on failure we capture the real journal error so the UI
// can show it instead of a misleading "success".
function applyCaddyConfig() {
  lastCaddyError = '';
  try {
    // Clear any prior failure storm so the restart isn't blocked by
    // "Start request repeated too quickly".
    try { execSync('systemctl reset-failed caddy-naive 2>/dev/null || true', { timeout: 5000 }); } catch {}
    execSync('systemctl restart caddy-naive', { timeout: 20000 });
  } catch (e) {
    lastCaddyError = collectCaddyError(e);
    return { ok: false, error: lastCaddyError };
  }
  // Verify the service actually came up and stayed up.
  let active = '';
  try { active = execSync('systemctl is-active caddy-naive 2>/dev/null', { timeout: 5000 }).toString().trim(); }
  catch (e) { active = (e.stdout ? e.stdout.toString().trim() : '') || 'inactive'; }
  if (active !== 'active') {
    lastCaddyError = collectCaddyError(null) || `caddy-naive is ${active || 'inactive'}`;
    return { ok: false, error: lastCaddyError };
  }
  return { ok: true, error: '' };
}

// Pull the real reason a (re)start failed: prefer the most recent journal lines,
// fall back to the exception's stderr/stdout.
function collectCaddyError(err) {
  let msg = '';
  try {
    const j = execSync('journalctl -u caddy-naive -n 20 --no-pager 2>/dev/null', { timeout: 5000 }).toString();
    // Surface the lines that actually explain the failure.
    const hot = j.split('\n').filter(l =>
      /permission denied|error|insecure schemes|repeated too quickly|invalid|adapt|loading/i.test(l));
    msg = (hot.length ? hot.slice(-6) : j.trim().split('\n').slice(-6)).join('\n').trim();
  } catch {}
  if (!msg && err) {
    msg = ((err.stderr && err.stderr.toString()) || (err.stdout && err.stdout.toString()) || err.message || '').trim();
  }
  return msg;
}

// ── reloadCaddy() — Bug 91: now a FULL restart + verify (no more silent reload).
// Kept as a thin boolean wrapper so existing callers don't change behaviour.
function reloadCaddy() {
  const r = applyCaddyConfig();
  return r.ok;
}

// ── restartCaddy() — full restart (needed for port/domain changes) ───────────
function restartCaddy() {
  return applyCaddyConfig().ok;
}

// ── Bug 7: UFW single-port helper ────────────────────────────────────────────
function ufwMieruRule(action, start, end, proto, comment) {
  const commentPart = comment ? ` comment "${comment}"` : '';
  const cmd = (start === end)
    ? `ufw ${action} allow ${start}/${proto}${commentPart} 2>/dev/null || true`
    : `ufw ${action} allow ${start}:${end}/${proto}${commentPart} 2>/dev/null || true`;
  try { execSync(cmd, { timeout: 5000 }); } catch {}
}

// ── Mieru state JSON builder ──────────────────────────────────────────────────
// Bug 51: use safe defaults for mieruPortStart/End in case config values absent
function buildMitaStateFile() {
  const allUsers = getAllUsers();
  const mieruUsers = allUsers.filter(u => {
    try { return JSON.parse(u.protocols || '["naive","mieru"]').includes('mieru'); }
    catch { return true; }
  });

  // Bug 51: parseInt guards against undefined/NaN causing infinite loops
  const portStart = parseInt(cfg.mieruPortStart, 10) || 2000;
  const portEnd   = parseInt(cfg.mieruPortEnd,   10) || 2010;

  // TCP-only by default; UDP is opt-in via cfg.udpEnabled
  const portBindings = [];
  for (let p = portStart; p <= portEnd; p++) {
    portBindings.push({ port: p, protocol: 'TCP' });
    if (cfg.udpEnabled) portBindings.push({ port: p, protocol: 'UDP' });
  }

  const mieruCfg = {
    portBindings,
    users: mieruUsers.map(u => ({
      name:     u.username,
      password: u.password || ''   // plain string — mita hashes on apply
    })),
    loggingLevel: 'INFO',
    mtu: cfg.mtu || 1400
  };

  const pat = cfg.trafficPattern || 'NOOP';
  if (pat !== 'NOOP') {
    const patMap = {
      'RANDOM_PADDING':            { seed: true,  tcpFragment: false, nonce: false },
      'RANDOM_PADDING_AGGRESSIVE': { seed: true,  tcpFragment: true,  nonce: true  },
      'CUSTOM':                    { seed: true,  tcpFragment: true,  nonce: true  }
    };
    if (patMap[pat]) mieruCfg.trafficPattern = patMap[pat];
  }

  // v1.2.6 cascade (Mieru): Variant B is used instead of mita native egress.
  // The entry mita stays a plain server; the RU->EU relay is handled externally
  // by scripts/cascade_mieru.sh (mieru-client + redsocks + iptables). We
  // therefore intentionally do NOT inject `mieruCfg.egress` here.
  // Legacy Variant A native egress is only applied if an operator explicitly
  // sets cascadeMieruEgress.proxies AND no Variant B host is configured.
  if (cfg.cascadeEnabled
      && (!cfg.cascadeMieru || !cfg.cascadeMieru.host)
      && cfg.cascadeMieruEgress && Array.isArray(cfg.cascadeMieruEgress.proxies)
      && cfg.cascadeMieruEgress.proxies.length > 0) {
    mieruCfg.egress = {
      proxies: cfg.cascadeMieruEgress.proxies,
      rules: cfg.cascadeMieruEgress.rules || [{ ipRanges: ['*'], domainNames: ['*'], action: 'DIRECT' }]
    };
  }

  fs.mkdirSync(path.dirname(resolvedMitaFile), { recursive: true });
  const tmp = resolvedMitaFile + '.new';
  fs.writeFileSync(tmp, JSON.stringify(mieruCfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, resolvedMitaFile);

  shredFile(resolvedMitaFile + '.last');
  try { fs.copyFileSync(resolvedMitaFile, resolvedMitaFile + '.last'); } catch {}

  return resolvedMitaFile;
}

// Bug 96: clear systemd "failed" state for mita before any (re)start.
//   After the FIRST user is added, or after a manual `systemctl restart mita`
//   that hit Restart=on-failure exhaustion, the unit can be stuck in
//   `failed` / `auto-restart`. In that state `systemctl start/restart` is a
//   no-op or refuses to act, leaving the proxy down with "no user found" /
//   mita=failed. `reset-failed` clears the failure counter so the next
//   start actually takes effect.
function resetMitaFailed() {
  try { execSync('systemctl reset-failed mita 2>/dev/null || true', { timeout: 5000 }); } catch {}
}

// Bug 96: the mieru server persists its applied state to
//   ~/.config/mita/server.conf.pb (root's HOME, since mita.service runs as
//   root). A stale/corrupt server.conf.pb can make a freshly-(re)started mita
//   come up in a broken "no user found" state even though mita-state.json is
//   correct. `mita apply config` rebuilds it, so removing the stale copy
//   before a cold start forces a clean rebuild. We only do this on a COLD
//   start path (not on a live reload) to avoid disturbing a healthy server.
function clearMitaPersistedState() {
  for (const p of ['/root/.config/mita/server.conf.pb',
                   process.env.HOME ? path.join(process.env.HOME, '.config/mita/server.conf.pb') : null]) {
    if (!p) continue;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

function applyMitaConfig() {
  const file = buildMitaStateFile();
  try {
    // Bug 96: always clear a lingering failed state first so subsequent
    //   start/restart commands are honoured by systemd.
    resetMitaFailed();

    execSync(`mita apply config ${file} 2>/dev/null`, { timeout: 15000 });

    // Bug 75: a fresh mita install sits in state IDLE (the installer does NOT
    // start it while users[] is empty — Bug 4). `mita reload` only re-reads the
    // config of an already-RUNNING server; it will NOT lift IDLE -> RUNNING, so
    // the proxy never starts listening and mieru clients can't connect.
    // Therefore: detect status and `mita start` when IDLE, otherwise `reload`.
    let status = '';
    try { status = execSync('mita status 2>/dev/null', { timeout: 10000 }).toString(); }
    catch { status = ''; }

    if (/RUNNING/i.test(status)) {
      execSync('mita reload 2>/dev/null', { timeout: 15000 });
    } else {
      // IDLE / FAILED / unknown: start the service so it binds the configured
      // ports. Bug 96: clear stale persisted state then re-apply so the cold
      // start rebuilds server.conf.pb cleanly; reset-failed again right before
      // the systemctl fallback so it is not blocked by an exhausted restart
      // counter, and verify is-active afterwards.
      clearMitaPersistedState();
      try { execSync(`mita apply config ${file} 2>/dev/null`, { timeout: 15000 }); } catch {}
      let started = false;
      try { execSync('mita start 2>/dev/null', { timeout: 15000 }); started = true; }
      catch { started = false; }
      if (!started) {
        resetMitaFailed();
        try { execSync('systemctl restart mita 2>/dev/null || true', { timeout: 15000 }); } catch {}
      }
      // Verify; if still not active, force one clean restart via systemd.
      let active = '';
      try { active = execSync('systemctl is-active mita 2>/dev/null', { timeout: 5000 }).toString().trim(); }
      catch { active = ''; }
      if (active !== 'active') {
        resetMitaFailed();
        try { execSync('systemctl restart mita 2>/dev/null || true', { timeout: 15000 }); } catch {}
      }
    }

    shredFile(file + '.last');
    return true;
  } catch { return false; }
}

function restartMieru() {
  try {
    execSync('mita stop 2>/dev/null || true', { timeout: 10000 });
    // Bug 96: clear failed state + stale persisted config so the cold restart
    //   below comes up clean instead of getting stuck in "no user found".
    resetMitaFailed();
    clearMitaPersistedState();
    const file = buildMitaStateFile();
    execSync(`mita apply config ${file} 2>/dev/null`, { timeout: 10000 });
    try { execSync('mita start 2>/dev/null', { timeout: 15000 }); }
    catch {
      resetMitaFailed();
      execSync('systemctl restart mita 2>/dev/null || systemctl start mita 2>/dev/null || true', { timeout: 15000 });
    }
    shredFile(file + '.last');
    return true;
  } catch { return false; }
}

// ── Mieru cascade (Variant B) — scripts/cascade_mieru.sh orchestrator ─────────
const CASCADE_SCRIPT = path.join(__dirname, '../scripts/cascade_mieru.sh');

// Run cascade_mieru.sh {setup|teardown|status}. Returns { ok, output }.
// Uses execFileSync (no shell) so the exit credentials are passed as argv and
// never interpolated into a shell string.
function runCascadeMieru(action, opts = {}) {
  try {
    const args = [CASCADE_SCRIPT, action];
    if (action === 'setup') {
      args.push(
        '--exit-host',       String(opts.host || ''),
        '--exit-port-start', String(opts.portStart || ''),
        '--exit-port-end',   String(opts.portEnd || ''),
        '--exit-user',       String(opts.user || ''),
        '--exit-pass',       String(opts.pass || ''),
        // Bug 95: mtu MUST match the exit (mita) mtu. Operators normally keep the
        // panel default (1400) on both nodes; allow an override via cascadeMieru.mtu.
        '--exit-mtu',        String(opts.mtu || cfg.mtu || 1400),
        '--exit-mux',        String(opts.mux || 'MULTIPLEXING_LOW')
      );
    }
    const out = execFileSync('bash', args, { timeout: 120000 }).toString();
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : e.message) };
  }
}

function shredFile(fp) {
  if (!fp || !fs.existsSync(fp)) return;
  try { execSync(`shred -u "${fp}" 2>/dev/null`, { timeout: 5000 }); }
  catch { try { fs.unlinkSync(fp); } catch {} }
}

// ── naiveCascadeStatusText() — Bug 93 ────────────────────────────────────────
// The "Проверить статус" button used to only diagnose the Mieru cascade (Variant
// B), so a Naive-only cascade always showed "configured: 0 / inactive" — wildly
// misleading. This block diagnoses the Naive leg:
//   • whether an `upstream` line is present in the live Caddyfile
//   • `caddy-naive validate` result
//   • `systemctl is-active caddy-naive`
//   • egress IP measured THROUGH the naive upstream (curl -x https://u:p@exit:443)
// Credentials are redacted in the printed output.
function naiveCascadeStatusText() {
  const lines = [];
  lines.push('=== NAIVE CASCADE ===');

  const enabled = !!cfg.cascadeEnabled;
  const upstreamRaw = (cfg.cascadeNaiveUpstream || '').trim();
  const upstream = upstreamRaw ? normalizeUpstream(upstreamRaw) : '';
  const redact = (u) => u.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');

  lines.push(`cascadeEnabled : ${enabled}`);
  lines.push(`upstream (cfg) : ${upstream ? redact(upstream) : '(none)'}`);

  // 1) upstream present in the live Caddyfile?
  let inFile = false;
  try {
    if (fs.existsSync(resolvedCaddyFile)) {
      const c = fs.readFileSync(resolvedCaddyFile, 'utf8');
      inFile = /^\s*upstream\s+https:\/\//mi.test(c);
    }
  } catch {}
  lines.push(`upstream in Caddyfile : ${inFile ? 'yes' : 'no'}`);

  // 2) caddy-naive validate
  let validate = 'unknown';
  try {
    execSync(`${CADDY_BIN} validate --config '${resolvedCaddyFile}' --adapter caddyfile 2>&1`, { timeout: 15000 });
    validate = 'Valid';
  } catch (e) {
    const out = ((e.stdout && e.stdout.toString()) || (e.stderr && e.stderr.toString()) || e.message || '').trim();
    validate = 'INVALID: ' + out.split('\n').slice(-3).join(' ');
  }
  lines.push(`caddy validate : ${validate}`);

  // 3) systemctl is-active caddy-naive
  let active = 'unknown';
  try { active = execSync('systemctl is-active caddy-naive 2>/dev/null', { timeout: 5000 }).toString().trim(); }
  catch (e) { active = (e.stdout ? e.stdout.toString().trim() : '') || 'inactive'; }
  lines.push(`caddy-naive    : ${active}`);
  if (active !== 'active') {
    const err = collectCaddyError(null);
    if (err) lines.push('  ↳ ' + err.split('\n').join('\n  ↳ '));
  }

  // 4) egress IP through the naive upstream itself.
  if (enabled && upstream) {
    let egress = '';
    try {
      // -x routes through the exit's forward proxy; api.ipify.org returns the
      // public IP the request egressed from (= exit node IP when cascade works).
      egress = execSync(
        `curl -fsS --max-time 12 -x '${upstream}' https://api.ipify.org 2>/dev/null`,
        { timeout: 15000 }
      ).toString().trim();
    } catch (e) {
      egress = 'FAILED (' + ((e.stderr && e.stderr.toString().trim()) || e.message || 'no response') + ')';
    }
    lines.push(`egress via upstream : ${egress || '(empty)'}`);
  } else {
    lines.push('egress via upstream : (cascade not enabled / no upstream)');
  }

  return lines.join('\n');
}

// ── applyAllConfigs() — unified pipeline ─────────────────────────────────────
// Rebuilds Caddyfile, (re)starts Caddy, rebuilds mita state, applies mita config.
// Called after every user CRUD operation.
// Bug 89: creating a naive key used to "not work" until `update.sh --force`,
// because writeCaddyfileAtomic left the file root:root (Bug 90) and reloadCaddy
// silently failed/kept the old config (Bug 91). With the chown in
// writeCaddyfileAtomic and the full restart+verify in applyCaddyConfig, a new
// key now activates immediately. We also surface the real caddy error.
function applyAllConfigs() {
  let caddyOk = false, mitaOk = false, caddyError = '';
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);          // Bug 90: chown root:caddy inside
    const r = applyCaddyConfig();           // Bug 91: full restart + verify
    caddyOk = r.ok;
    if (!r.ok) {
      caddyError = r.error;
      console.error('[CADDY] apply failed:', r.error);
    }
  } catch (e) { caddyError = e.message; console.error('[CADDY]', e.message); }
  try { mitaOk = applyMitaConfig(); }
  catch (e) { console.error('[MITA]', e.message); }
  return { caddyOk, mitaOk, caddyError, servicesReloaded: caddyOk && mitaOk };
}

// ── Express app ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'",
                        'https://cdn.jsdelivr.net'],
      // Bug CSP: script-src-attr 'none' prevents inline event handlers
      scriptSrcAttr:   ["'none'"],
      styleSrc:        ["'self'", "'unsafe-inline'",
                        'https://fonts.googleapis.com',
                        'https://fonts.gstatic.com'],
      fontSrc:         ["'self'", 'https://fonts.gstatic.com'],
      connectSrc:      ["'self'", 'ws:', 'wss:', 'https://fonts.googleapis.com'],
      imgSrc:          ["'self'", 'data:', 'blob:'],
      mediaSrc:        ["'none'"],
      objectSrc:       ["'none'"],
      frameAncestors:  ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(morgan('combined', {
  stream: { write: m => { try { fs.appendFileSync(LOG_PANEL, m); } catch {} } }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Session
let sessionSecret;
const secretFile = path.join(path.dirname(resolvedDb), '.session_secret');
try { sessionSecret = fs.readFileSync(secretFile, 'utf8').trim(); }
catch {
  sessionSecret = require('crypto').randomBytes(64).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, sessionSecret, { mode: 0o600 });
  } catch {}
}

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  // v1.4.0: cookie Path is explicitly '/'. Externally the panel is served behind
  // Caddy's `handle_path /<webBasePath>/*`, which STRIPS the prefix before the
  // request reaches the panel — so the app always sees paths at the root and the
  // cookie scoped to '/' survives a webBasePath change (no forced re-login).
  cookie: { path: '/', secure: false, httpOnly: true, maxAge: 86400000, sameSite: 'lax' }
}));

// Rate limits
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,  message: { error: 'Too many attempts' } });
const apiLimiter   = rateLimit({ windowMs:      60 * 1000, max: 300, message: { error: 'Rate limit exceeded' } });
app.use('/api/', apiLimiter);

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/');
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Missing credentials' });

  const isAdmin =
    username === cfg.adminUser &&
    cfg.adminPassHash &&
    bcrypt.compareSync(password, cfg.adminPassHash);

  if (!isAdmin) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.authenticated = true;
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.username, authenticated: true });
});

// ── Config API ────────────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => {
  // v1.4.0: never leak the panel basic-auth bcrypt hash to the browser — expose
  // a boolean "set" flag instead so the UI can show whether a password exists.
  const { adminPassHash, panelBasicAuthHash, ...safe } = cfg;
  safe.panelBasicAuthSet = !!panelBasicAuthHash;
  // Bug 143 (recurring): the UI also reads `version` from here (loadConfig +
  // settings render). The in-memory cfg.version can lag behind after an update
  // until the process restarts, so always serve the LIVE version (same single
  // source as /api/status) — this is what makes the header reflect the new
  // VERSION immediately after update.sh, with no manual edits.
  safe.version = readPanelVersion();
  // Never expose secrets to the browser. Mask the cascade exit password and the
  // legacy native-egress proxy passwords; expose a boolean "set" flag instead.
  if (safe.cascadeMieru && typeof safe.cascadeMieru === 'object') {
    const { pass, ...cm } = safe.cascadeMieru;
    safe.cascadeMieru = { ...cm, pass: !!pass };   // pass becomes true/false
  }
  if (safe.cascadeMieruEgress && Array.isArray(safe.cascadeMieruEgress.proxies)) {
    safe.cascadeMieruEgress = {
      ...safe.cascadeMieruEgress,
      proxies: safe.cascadeMieruEgress.proxies.map(p => {
        if (p && p.socks5Authentication) {
          const { password, ...auth } = p.socks5Authentication;
          return { ...p, socks5Authentication: { ...auth, password: !!password } };
        }
        return p;
      })
    };
  }
  res.json(safe);
});

app.post('/api/config', requireAuth, (req, res) => {
  ['domain','naivePort','mieruPortStart','mieruPortEnd',
   'trafficPattern','mtu','udpEnabled','adminEmail','language',
   'probeSecret','fakeSiteUrl'].forEach(k => {
    if (req.body[k] !== undefined) cfg[k] = req.body[k];
  });
  saveConfig();
  const { adminPassHash, ...safe } = cfg;
  res.json({ ok: true, cfg: safe });
});

app.post('/api/config/password', requireAuth, (req, res) => {
  const { current, newPass } = req.body;
  if (!current || !newPass) return res.status(400).json({ error: 'Missing fields' });
  if (newPass.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const valid = cfg.adminPassHash && bcrypt.compareSync(current, cfg.adminPassHash);
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
  cfg.adminPassHash = bcrypt.hashSync(newPass, 12);
  saveConfig();
  res.json({ ok: true });
});

// ── v1.4.0: external panel access (domain + TLS + basic auth + webBasePath) ───
// All changes regenerate the Caddyfile (which now contains the panel subdomain
// block) and apply it ATOMICALLY (Bug 91): write → restart caddy-naive → verify
// is-active. On failure we roll back config + Caddyfile and report a clear error
// so the panel never stays in a broken state.

// Generate a random 16-hex webBasePath (does NOT persist — UI persists via save).
app.get('/api/panel/webbasepath/generate', requireAuth, (req, res) => {
  res.json({ webBasePath: crypto.randomBytes(8).toString('hex') });
});

// Hash a basic-auth password with `caddy hash-password` (bcrypt). Falls back to
// bcryptjs so the panel works even if the caddy binary lacks the subcommand.
function caddyHashPassword(plain) {
  try {
    const out = execFileSync(resolvedCaddyBin, ['hash-password'],
      { input: String(plain), timeout: 8000 }).toString().trim();
    if (out) return out;
  } catch (_) { /* fall through */ }
  return bcrypt.hashSync(String(plain), 12);
}

const WEBBASE_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

app.post('/api/panel/external-access', requireAuth, (req, res) => {
  const body = req.body || {};
  const enabled = !!body.enabled;

  // Snapshot current state for rollback.
  const prev = {
    exposePanel:        cfg.exposePanel,
    panelDomain:        cfg.panelDomain,
    panelBasicAuthUser: cfg.panelBasicAuthUser,
    panelBasicAuthHash: cfg.panelBasicAuthHash,
    webBasePath:        cfg.webBasePath,
  };
  const oldWebBasePath = String(cfg.webBasePath || '');

  if (enabled) {
    const domain = String(body.panelDomain || cfg.panelDomain || '').trim();
    if (!domain || !HOSTNAME_RE.test(domain))
      return res.status(400).json({ error: 'Valid panel subdomain required (e.g. panel.example.com)' });

    // webBasePath: explicit value (sanitized) or keep existing or generate.
    let wbp = String(body.webBasePath || cfg.webBasePath || '').trim().replace(/^\/+|\/+$/g, '');
    if (!wbp) wbp = crypto.randomBytes(8).toString('hex');
    if (!WEBBASE_RE.test(wbp))
      return res.status(400).json({ error: 'webBasePath must match [A-Za-z0-9._~-] (1–64 chars)' });

    const baUser = String(body.basicAuthUser || cfg.panelBasicAuthUser || 'admin').trim();
    if (!USERNAME_RE.test(baUser))
      return res.status(400).json({ error: 'basic-auth login must match [a-zA-Z0-9_.-] (max 64)' });

    // Password: only (re)hash when a new one is provided. Keep the old hash
    // otherwise. Require a hash to exist when first enabling.
    let baHash = cfg.panelBasicAuthHash || '';
    const newPass = body.basicAuthPass != null ? String(body.basicAuthPass) : '';
    if (newPass) {
      if (newPass.length < 6) return res.status(400).json({ error: 'basic-auth password too short (min 6)' });
      baHash = caddyHashPassword(newPass);
    }
    if (!baHash)
      return res.status(400).json({ error: 'A basic-auth password is required to enable external access' });

    cfg.exposePanel        = true;
    cfg.panelDomain        = domain;
    cfg.webBasePath        = wbp;
    cfg.panelBasicAuthUser = baUser;
    cfg.panelBasicAuthHash = baHash;
    cfg.panelHost          = '127.0.0.1';   // never bind externally
    cfg.panelPort          = cfg.panelPort || 3000;
    if (!cfg.panelStubPage) cfg.panelStubPage = '/var/www/panel-stub/index.html';
  } else {
    // Disable: keep panelDomain/webBasePath/hash so it can be re-enabled later.
    cfg.exposePanel = false;
    cfg.panelHost   = '127.0.0.1';
  }

  // Persist, regenerate Caddyfile, and apply atomically (Bug 91).
  const prevCaddy = (() => { try { return fs.readFileSync(resolvedCaddyFile, 'utf8'); } catch { return null; } })();
  saveConfig();
  try {
    writeCaddyfileAtomic(buildCaddyfile(cfg, getAllUsers()));
  } catch (e) {
    Object.assign(cfg, prev); saveConfig();
    return res.status(500).json({ error: 'Failed to write Caddyfile: ' + e.message });
  }
  const r = applyCaddyConfig();
  if (!r.ok) {
    // Roll back config + Caddyfile and re-apply the previous good state.
    Object.assign(cfg, prev); saveConfig();
    try {
      if (prevCaddy != null) writeCaddyfileAtomic(prevCaddy);
      else writeCaddyfileAtomic(buildCaddyfile(cfg, getAllUsers()));
    } catch (_) {}
    applyCaddyConfig();
    return res.status(500).json({ error: 'Caddy failed to apply the change — rolled back. ' + (r.error || '') });
  }

  // Build the response: new full URL + whether webBasePath changed.
  const result = { ok: true, exposePanel: cfg.exposePanel };
  if (cfg.exposePanel) {
    result.url = `https://${cfg.panelDomain}/${cfg.webBasePath}/`;
    result.panelDomain = cfg.panelDomain;
    result.webBasePath = cfg.webBasePath;
    result.basicAuthUser = cfg.panelBasicAuthUser;
    if (oldWebBasePath && oldWebBasePath !== cfg.webBasePath) {
      result.webBasePathChanged = true;
      result.warning = 'webBasePath changed — the old URL/tab now shows the stub. Open the new URL.';
    }
  }
  res.json(result);
});

// ── BUG-141: custom panel-stub HTML editor ────────────────────────────────────
// The panel-stub is the static page Caddy serves at the panel subdomain root and
// for any path outside webBasePath. It is a SEPARATE entity from the naive
// fake-site (probe-resistance). The operator can replace it with their own HTML.
function panelStubFile() {
  return String(cfg.panelStubPage || '/var/www/panel-stub/index.html').trim()
    || '/var/www/panel-stub/index.html';
}

app.get('/api/panel/stub', requireAuth, (req, res) => {
  const f = panelStubFile();
  let html = '';
  try { html = fs.readFileSync(f, 'utf8'); } catch (_) { html = ''; }
  res.json({ path: f, html });
});

app.post('/api/panel/stub', requireAuth, (req, res) => {
  const body = req.body || {};
  let html = body.html != null ? String(body.html) : '';
  // Strip a stray leading "Copy" token (clipboard artifact) and BOM.
  html = html.replace(/^\uFEFF/, '').replace(/^Copy(?=\s*<)/, '');
  if (!html.trim()) return res.status(400).json({ error: 'Stub HTML must not be empty' });
  if (html.length > 256 * 1024) return res.status(400).json({ error: 'Stub HTML too large (max 256 KiB)' });

  const f = panelStubFile();
  const dir = path.dirname(f);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = f + '.new';
    fs.writeFileSync(tmp, html, { mode: 0o644 });
    fs.renameSync(tmp, f);           // atomic replace — no half-written stub
    try { fs.chmodSync(f, 0o644); } catch (_) {}
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write stub file: ' + e.message });
  }
  // file_server serves the file directly; no Caddy restart needed.
  res.json({ ok: true, path: f, bytes: Buffer.byteLength(html) });
});

// ── Validation helpers ────────────────────────────────────────────────────────
const VALID_PROTOCOLS = ['naive', 'mieru'];
const USERNAME_RE     = /^[a-zA-Z0-9_.-]{1,64}$/;
const EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Bug 35: generate a password from a SAFE alphabet only ([a-zA-Z0-9]).
//   Special characters (and Cyrillic) in a password break NaiveProxy clients
//   such as Karing/NekoBox: the naive link encodes the password with
//   encodeURIComponent, but some clients do not URL-decode it back before
//   handing it to the proxy, so "@ : / # % +" etc. corrupt the credential.
//   A pure alphanumeric password is byte-identical whether parsed from the
//   link or from JSON, so it works everywhere with no encoding ambiguity.
//   Bug 100: previously used crypto.randomInt() — that was only added in Node
//   v14.10.0, and on the production box (older Node) the call threw
//   "TypeError: crypto.randomInt is not a function".  We now do unbiased
//   selection with crypto.randomBytes() + rejection sampling, which works on
//   every Node version that ships crypto (i.e. all of them).
const SAFE_PW_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generateSafePassword(len) {
  let n = parseInt(len, 10);
  if (isNaN(n) || n < 8)  n = 16;   // sensible default / floor
  if (n > 64)             n = 64;   // matches USERNAME_RE-style sanity cap

  const alphabetLen = SAFE_PW_ALPHABET.length;          // 62
  // Largest multiple of alphabetLen that fits in a byte; bytes >= this are
  // rejected so every character is equally likely (no modulo bias).
  const limit = 256 - (256 % alphabetLen);              // 248 for len 62
  let out = '';
  while (out.length < n) {
    // Over-allocate a bit to reduce the number of randomBytes() calls.
    const buf = crypto.randomBytes(n - out.length + 8);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i];
      if (b >= limit) continue;                         // reject to avoid bias
      out += SAFE_PW_ALPHABET[b % alphabetLen];
    }
  }
  return out;
}

/**
 * Bug 8: normalise quota — accept quotaMB or quotaGb (gb * 1024 → MB).
 * Bug 9: validate all user input fields.
 */
function validateUserInput({ email, username, password, protocols, quotaMB, quotaGb }, requirePassword) {
  if (!username || !USERNAME_RE.test(username))
    return { error: 'username required and must match [a-zA-Z0-9_.-] (max 64 chars)' };
  // Email is optional (TLS cert is configured at install time via Caddy ACME,
  // not per-user). If provided, it must still be a valid address.
  if (email !== undefined && email !== null && email !== '' && !EMAIL_RE.test(email))
    return { error: 'email is invalid' };
  if (requirePassword) {
    if (!password) return { error: 'password is required for new users' };
    if (password.length < 8) return { error: 'password must be at least 8 characters' };
  } else if (password !== undefined && password !== null && password !== '' && password.length < 8) {
    return { error: 'new password must be at least 8 characters' };
  }
  // Bug 8: accept quotaGb; convert to quotaMB
  let resolvedQuotaMB = 0;
  if (quotaMB !== undefined && quotaMB !== null) {
    resolvedQuotaMB = parseInt(quotaMB, 10);
    if (isNaN(resolvedQuotaMB) || resolvedQuotaMB < 0)
      return { error: 'quotaMB must be a non-negative integer' };
  } else if (quotaGb !== undefined && quotaGb !== null) {
    const gb = parseFloat(quotaGb);
    if (isNaN(gb) || gb < 0) return { error: 'quotaGb must be a non-negative number' };
    resolvedQuotaMB = Math.round(gb * 1024);
  }
  // Bug 9: protocols allowlist
  let resolvedProtocols = ['naive', 'mieru'];
  if (protocols !== undefined) {
    if (!Array.isArray(protocols))
      return { error: 'protocols must be an array' };
    const invalid = protocols.filter(p => !VALID_PROTOCOLS.includes(p));
    if (invalid.length)
      return { error: `unknown protocol(s): ${invalid.join(', ')}. Allowed: ${VALID_PROTOCOLS.join(', ')}` };
    if (!protocols.length)
      return { error: 'at least one protocol is required (naive, mieru)' };
    resolvedProtocols = protocols;
  }
  return { quotaMB: resolvedQuotaMB, protocols: resolvedProtocols };
}

/**
 * Bug 7: parse all TEXT JSON columns back to JS types when returning user rows.
 */
function parseUserRow(u) {
  return {
    ...u,
    protocols: typeof u.protocols === 'string'
      ? (() => { try { return JSON.parse(u.protocols); } catch { return []; } })()
      : (u.protocols || []),
  };
}

// ── Password generator (Bug 35) ───────────────────────────────────────────────
// Returns a fresh safe ([a-zA-Z0-9]) password for the "Random password" button
// in the key-issuance UI. Default length 16. The backend user-creation flow is
// untouched — the admin still submits whatever password they choose; this
// endpoint only suggests a safe one.
app.get('/api/password/generate', requireAuth, (req, res) => {
  const length = req.query.length || 16;
  res.json({ password: generateSafePassword(length) });
});

// ── Users API ─────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, (req, res) => {
  const users = getAllUsers().map(u => {
    const { passHash, password, ...rest } = u;
    return parseUserRow(rest);
  });
  res.json(users);
});

app.post('/api/users', requireAuth, async (req, res) => {
  const { email, username, password, expiry, protocols, quotaMB, quotaGb } = req.body;
  const validation = validateUserInput(
    { email, username, password, protocols, quotaMB, quotaGb }, true);
  if (validation.error)
    return res.status(400).json({ error: validation.error });

  // Bug 149: normalise email up-front and pre-check for a duplicate email so we
  // return a clean 409 instead of letting the UNIQUE constraint throw.
  const normEmail = (email && email.trim()) ? email.trim() : null;
  if (normEmail && getUserByEmail(normEmail))
    return res.status(409).json({ error: 'Email already in use' });

  if (expiry && isNaN(Date.parse(expiry)))
    return res.status(400).json({ error: 'expiry must be a valid ISO date string' });

  // Bug 149 (race): coalesce a rapid double-submit. This check MUST come before
  // the "already exists" gate below: under Node's microtask ordering the first
  // request's INSERT (behind an `await`) can complete before the second
  // request's handler even begins, so by the time a twin reaches the existence
  // gate the row is already there and it would wrongly 409. By consulting the
  // in-flight map FIRST, a twin awaits the SAME in-flight promise and receives
  // the winner's identical success result — no false "already exists", no
  // duplicate row. The in-flight entry survives until the winner fully resolves
  // (its `finally` deletes it), guaranteeing the twin finds it.
  if (inflightCreates.has(username)) {
    try {
      const r = await inflightCreates.get(username);
      return res.status(r.status).json(r.payload);
    } catch {
      return res.status(500).json({ error: 'Could not save user (database error)' });
    }
  }

  // Bug 149 (race): if THIS username already exists in the DB and there is NO
  // create in flight for it (checked above), it's a genuine clash with a
  // pre-existing user → real 409. (Snapshot taken synchronously, before any
  // await, so it reliably distinguishes a pre-existing row from one our own
  // concurrent twin is creating — the twin case was already coalesced above.)
  if (getUserByUsername(username))
    return res.status(409).json({ error: 'Username already exists' });

  const work = (async () => {
    // Yield once so a near-simultaneous twin request observes the in-flight
    // entry (set below) and coalesces onto this promise instead of racing.
    await Promise.resolve();
    const now  = new Date().toISOString();
    const user = {
      id:        uuidv4(),
      // Email is optional: store NULL (not '') so the UNIQUE constraint allows
      // multiple users without an email.
      email:     normEmail,
      username,
      passHash:  bcrypt.hashSync(password, 12),
      password,
      expiry:    expiry || null,
      protocols: JSON.stringify(validation.protocols),
      quotaMB:   validation.quotaMB,
      usedMB:    0,
      createdAt: now, updatedAt: now, lastSeen: null
    };

    // Atomic create: INSERT ... ON CONFLICT(username) DO NOTHING. Because we
    // verified the username did NOT exist before this request, a no-op insert
    // here can only mean a concurrent twin won the race → treat as success
    // (idempotent) and return that row. A genuine pre-existing clash was already
    // rejected above.
    let result;
    try {
      result = createUserAtomic(user);
    } catch (e) {
      const d = describeDbError(e);
      console.error('[USERS] create failed:', e.message);
      return { status: d.status, payload: { error: d.error } };
    }

    // Run the (heavier) service rebuild only when WE actually inserted the row.
    const svcStatus = result.created ? applyAllConfigs() : {};
    const row = result.user || user;
    const { passHash, password: _p, ...safe } = row;
    return { status: 201, payload: { ok: true, ...parseUserRow(safe), ...svcStatus } };
  })();

  inflightCreates.set(username, work);
  try {
    const r = await work;
    return res.status(r.status).json(r.payload);
  } catch (e) {
    console.error('[USERS] create failed:', e && e.message);
    return res.status(500).json({ error: 'Could not save user (database error)' });
  } finally {
    inflightCreates.delete(username);
  }
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { email, username, password, expiry, protocols, quotaMB, quotaGb } = req.body;
  const validation = validateUserInput(
    { email: email ?? user.email,
      username: username ?? user.username,
      password,
      protocols,
      quotaMB: quotaMB !== undefined ? quotaMB : undefined,
      quotaGb: quotaGb !== undefined ? quotaGb : undefined }, false);
  if (validation.error)
    return res.status(400).json({ error: validation.error });

  if (expiry !== undefined && expiry !== null && isNaN(Date.parse(expiry)))
    return res.status(400).json({ error: 'expiry must be a valid ISO date string' });

  const newEmail = email !== undefined
    ? ((email && email.trim()) ? email.trim() : null)
    : user.email;

  // Bug 149: if the email is changing to a non-empty value already used by a
  // DIFFERENT user, return a clean 409 rather than throwing a UNIQUE error.
  if (newEmail) {
    const clash = getUserByEmail(newEmail);
    if (clash && clash.id !== user.id)
      return res.status(409).json({ error: 'Email already in use' });
  }
  // Same guard for a username change.
  if (username && username !== user.username && getUserByUsername(username))
    return res.status(409).json({ error: 'Username already exists' });

  const updated = {
    ...user,
    email:     newEmail,
    username:  username  ?? user.username,
    expiry:    expiry    !== undefined ? (expiry || null) : user.expiry,
    protocols: protocols
      ? JSON.stringify(validation.protocols)
      : user.protocols,
    quotaMB:   (quotaMB !== undefined || quotaGb !== undefined)
      ? validation.quotaMB
      : user.quotaMB,
    updatedAt: new Date().toISOString()
  };
  if (password) {
    updated.passHash = bcrypt.hashSync(password, 12);
    updated.password = password;
  }
  try {
    upsertUser(updated);
  } catch (e) {
    const d = describeDbError(e);
    console.error('[USERS] update failed:', e.message);
    return res.status(d.status).json({ error: d.error });
  }

  const svcStatus = applyAllConfigs();

  const { passHash, password: _p, ...safe } = updated;
  res.json({ ok: true, ...parseUserRow(safe), ...svcStatus });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  deleteUser(req.params.id);
  const svcStatus = applyAllConfigs();
  res.json({ ok: true, ...svcStatus });
});

// ── Server settings ───────────────────────────────────────────────────────────

// Caddy port: rebuild Caddyfile + full restart (port binding change)
// Bug 52: verify caddy-naive is active after restart; return HTTP 500 if not
app.post('/api/settings/naive-port', requireAuth, (req, res) => {
  const p = parseInt(req.body.port, 10);
  if (!p || p < 1 || p > 65535)
    return res.status(400).json({ error: 'Invalid port (1–65535)' });
  cfg.naivePort = p; saveConfig();
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    restartCaddy();
    // Bug 52: confirm the service is actually running after restart
    let active = false;
    try { execSync('systemctl is-active caddy-naive', { timeout: 8000 }); active = true; } catch {}
    if (!active) {
      return res.status(500).json({
        ok: false,
        error: 'caddy-naive failed to start after port change — run: journalctl -u caddy-naive -n 30'
      });
    }
    res.json({ ok: true, message: `NaiveProxy port changed to ${p}. Clients must download new configs.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mieru ports: UFW update + full restart
app.post('/api/settings/mieru-ports', requireAuth, (req, res) => {
  const s = parseInt(req.body.portStart, 10);
  const e = parseInt(req.body.portEnd,   10);
  if (!s || !e || s < 1025 || e > 65535 || e < s)
    return res.status(400).json({ error: 'Invalid port range (1025–65535, end ≥ start)' });

  const oldS = cfg.mieruPortStart, oldE = cfg.mieruPortEnd;
  cfg.mieruPortStart = s; cfg.mieruPortEnd = e; saveConfig();

  try {
    // Bug 7: use single-port helper to avoid UFW crash when start===end
    ufwMieruRule('delete', oldS, oldE, 'tcp', '');
    ufwMieruRule('delete', oldS, oldE, 'udp', '');
    ufwMieruRule('',       s,    e,    'tcp', 'Mieru TCP');
    if (cfg.udpEnabled) ufwMieruRule('', s, e, 'udp', 'Mieru UDP');
  } catch {}

  try {
    const ok = restartMieru();
    res.json({ ok, message: `Mieru ports changed to ${s}–${e}. Service restarted. Clients must download new configs.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Traffic pattern + MTU: mita reload
app.post('/api/settings/traffic-pattern', requireAuth, (req, res) => {
  const validPatterns = ['NOOP', 'RANDOM_PADDING', 'RANDOM_PADDING_AGGRESSIVE'];
  const { pattern, mtu } = req.body;
  if (!validPatterns.includes(pattern))
    return res.status(400).json({ error: `Invalid pattern. Valid: ${validPatterns.join(', ')}` });
  if (mtu !== undefined) {
    const m = parseInt(mtu, 10);
    if (m < 1280 || m > 1400) return res.status(400).json({ error: 'MTU must be 1280–1400' });
    cfg.mtu = m;
  }
  cfg.trafficPattern = pattern; saveConfig();
  try {
    const ok = applyMitaConfig();
    res.json({ ok, pattern, mtu: cfg.mtu });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// UDP toggle: requires full Mieru restart (port bindings change)
app.post('/api/settings/udp-toggle', requireAuth, (req, res) => {
  const enable = req.body.enabled === true || req.body.enabled === 'true';
  cfg.udpEnabled = enable; saveConfig();
  try {
    const s = cfg.mieruPortStart, e = cfg.mieruPortEnd;
    // Bug 7: use single-port helper to avoid UFW crash when start===end
    if (enable) {
      ufwMieruRule('', s, e, 'udp', 'Mieru UDP');
    } else {
      ufwMieruRule('delete', s, e, 'udp', '');
    }
  } catch {}
  try {
    const ok = restartMieru();
    res.json({ ok, udpEnabled: enable,
      message: `UDP ${enable ? 'enabled' : 'disabled'}. Mieru restarted.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Language setting
app.post('/api/settings/language', requireAuth, (req, res) => {
  const { language } = req.body;
  if (!['ru', 'en'].includes(language))
    return res.status(400).json({ error: 'Supported languages: ru, en' });
  cfg.language = language;
  saveConfig();
  res.json({ ok: true, language });
});

// Probe secret update — rebuilds Caddyfile and reloads Caddy.
// Setting a secret also switches probeMode to 'secret'.
app.post('/api/settings/probe-secret', requireAuth, (req, res) => {
  const { probeSecret } = req.body;
  if (!probeSecret || probeSecret.length < 8)
    return res.status(400).json({ error: 'probe_secret must be at least 8 characters' });
  cfg.probeSecret = probeSecret;
  cfg.probeMode = 'secret';          // Bug 81: setting a secret implies secret mode
  saveConfig();
  // Persist to file for install.sh smoke tests
  try {
    fs.writeFileSync(path.join(resolvedCaddyCfgDir, 'probe_secret'), probeSecret, { mode: 0o600 });
  } catch {}
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    const ok = reloadCaddy();
    res.json({ ok, message: 'Probe secret updated. Caddy reloaded.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bug 81: probe_resistance mode toggle ('off' | 'bare' | 'secret').
//   'off'    → remove probe_resistance entirely
//   'bare'   → bare  probe_resistance  (no secret) — matches known-good ref server
//   'secret' → probe_resistance <secret>  (requires an existing/provided secret)
app.post('/api/settings/probe-mode', requireAuth, (req, res) => {
  const { probeMode, probeSecret } = req.body || {};
  const mode = String(probeMode || '').trim().toLowerCase();
  if (!['off', 'bare', 'secret'].includes(mode))
    return res.status(400).json({ error: "probeMode must be one of: off, bare, secret" });

  if (mode === 'secret') {
    // A secret is required — either provided now or already stored.
    const newSecret = (probeSecret || '').trim();
    if (newSecret) {
      if (newSecret.length < 8)
        return res.status(400).json({ error: 'probe_secret must be at least 8 characters' });
      cfg.probeSecret = newSecret;
      try {
        fs.writeFileSync(path.join(resolvedCaddyCfgDir, 'probe_secret'), newSecret, { mode: 0o600 });
      } catch {}
    } else if (!(cfg.probeSecret || '').trim()) {
      return res.status(400).json({ error: "secret mode requires a probe_secret (>= 8 chars)" });
    }
  }

  cfg.probeMode = mode;
  saveConfig();
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    const ok = reloadCaddy();
    res.json({ ok, probeMode: mode, message: `probe_resistance mode set to '${mode}'. Caddy reloaded.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bug 15: /api/services/rebuild-all — used by update.sh --repair
app.post('/api/services/rebuild-all', requireAuth, (req, res) => {
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    const caddyOk = reloadCaddy();
    const mitaOk  = applyMitaConfig();
    res.json({ ok: true, caddyOk, mitaOk,
      message: 'Caddyfile and mita-state.json rebuilt from database.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v1.2.6: Cascade settings (Variant B) ──────────────────────────────────────
// Naive cascade  → Caddyfile `upstream` (handled by buildCaddyfile).
// Mieru cascade  → Variant B (mieru-client + redsocks + iptables) orchestrated
//                  by scripts/cascade_mieru.sh. The entry mita stays plain.
app.get('/api/settings/cascade', requireAuth, (req, res) => {
  const m = cfg.cascadeMieru || {};
  res.json({
    cascadeEnabled: !!cfg.cascadeEnabled,
    cascadeNaiveUpstream: cfg.cascadeNaiveUpstream || '',
    cascadeMieru: {
      host:      m.host || '',
      portStart: m.portStart || 2012,
      portEnd:   m.portEnd   || 2022,
      user:      m.user || '',
      mtu:       m.mtu || 1400,
      // never return the stored exit password; UI shows a placeholder
      hasPass:   !!m.pass
    }
  });
});

// Live cascade status — Bug 93: diagnose BOTH legs (Naive + Mieru).
app.get('/api/settings/cascade/status', requireAuth, (req, res) => {
  let naiveOut = '';
  try { naiveOut = naiveCascadeStatusText(); }
  catch (e) { naiveOut = '=== NAIVE CASCADE ===\n(error: ' + e.message + ')'; }

  const m = runCascadeMieru('status');
  const mieruOut = '=== MIERU CASCADE (Variant B) ===\n' + (m.output || '(no output)');

  const output = naiveOut + '\n\n' + mieruOut;
  res.json({ ok: m.ok, output });
});

app.post('/api/settings/cascade', requireAuth, (req, res) => {
  const { cascadeEnabled, cascadeNaiveUpstream, cascadeMieru } = req.body;
  const enabled = !!cascadeEnabled;
  cfg.cascadeEnabled = enabled;
  if (cascadeNaiveUpstream !== undefined) {
    // Bug 92: normalize on store too (defense in depth) — strip "naive+" etc. so
    // the saved config and the generated Caddyfile both carry a clean https:// URL.
    const raw = String(cascadeNaiveUpstream || '').trim();
    cfg.cascadeNaiveUpstream = raw ? normalizeUpstream(raw) : '';
  }

  // Merge Mieru exit settings. A blank password means "keep existing".
  const prev = cfg.cascadeMieru || {};
  if (cascadeMieru !== undefined) {
    const m = cascadeMieru || {};
    cfg.cascadeMieru = {
      host:      String(m.host ?? prev.host ?? '').trim(),
      portStart: parseInt(m.portStart ?? prev.portStart ?? 2012, 10) || 2012,
      portEnd:   parseInt(m.portEnd   ?? prev.portEnd   ?? 2022, 10) || 2022,
      user:      String(m.user ?? prev.user ?? '').trim(),
      pass:      (m.pass !== undefined && String(m.pass).length > 0)
                   ? String(m.pass)
                   : (prev.pass || ''),
      // Bug 95: mtu must match the exit (mita). Default 1400, clamp 1280-1400.
      mtu:       (() => {
                   const v = parseInt(m.mtu ?? prev.mtu ?? cfg.mtu ?? 1400, 10) || 1400;
                   return (v < 1280 || v > 1400) ? 1400 : v;
                 })()
    };
  }
  saveConfig();

  try {
    // 1) Naive leg — rebuild Caddyfile (upstream applied when enabled).
    // Bug 90: writeCaddyfileAtomic chowns root:caddy.
    // Bug 91: applyCaddyConfig does a full restart + is-active verify and
    //         returns the real error (no more silent reload masking failures).
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    const caddyRes = applyCaddyConfig();
    const caddyOk = caddyRes.ok;

    // 2) Mieru leg — Variant B orchestration.
    let cascadeOk = true, cascadeOut = '';
    const m = cfg.cascadeMieru || {};
    const hasMieruExit = enabled && m.host && m.user && m.pass;
    if (hasMieruExit) {
      const r = runCascadeMieru('setup', {
        host: m.host, portStart: m.portStart, portEnd: m.portEnd,
        user: m.user, pass: m.pass, mtu: m.mtu
      });
      cascadeOk = r.ok; cascadeOut = r.output;
    } else {
      // Cascade disabled (or no Mieru exit configured) → ensure relay is down.
      const r = runCascadeMieru('teardown');
      cascadeOk = r.ok; cascadeOut = r.output;
    }

    // Entry mita stays a plain server in Variant B — just re-apply its config.
    const mitaOk = applyMitaConfig();

    res.json({
      ok: caddyOk && cascadeOk,
      caddyOk, mitaOk, cascadeOk,
      // Bug 91: surface the real caddy-naive error to the UI on failure.
      caddyError: caddyOk ? '' : (caddyRes.error || ''),
      cascadeOutput: cascadeOut,
      message: enabled
        ? (hasMieruExit
            ? 'Cascade enabled. Naive upstream + Mieru relay (Variant B) applied.'
            : 'Cascade enabled for Naive only (no Mieru exit configured).')
        : 'Cascade disabled. Relay torn down.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Client configs ────────────────────────────────────────────────────────────

// Naive link (used with caddy-forwardproxy)
app.get('/api/users/:id/config/naive', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';
  // naive+https:// link for caddy-forwardproxy-naive
  const link = `naive+https://${user.username}:${encodeURIComponent(password)}@${cfg.domain}:${cfg.naivePort}`;
  res.json({ link, username: user.username });
});

// Bug 5: transport field (not protocol); Bug 12: server_ports array
// P3 (selectable mieru port): validate a requested port against the configured
//   range. mita listens on the WHOLE range (portRange "start-end"), so any port
//   inside [start,end] is valid for the client to dial. Returns `start` when the
//   request is absent, non-numeric, or outside the range.
function pickMieruPort(requested, start, end) {
  const p = parseInt(requested, 10);
  if (Number.isInteger(p) && p >= start && p <= end) return p;
  return start;
}

app.get('/api/users/:id/config/mieru', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';

  // Build server_ports array (Bug 12)
  // Bug 70: mieruPortStart/End may be strings or undefined; parseInt prevents
  // an infinite for-loop when NaN comparisons silently return false
  const _portStart70a = parseInt(cfg.mieruPortStart, 10) || 2000;
  const _portEnd70a   = parseInt(cfg.mieruPortEnd,   10) || 2010;
  const serverPorts = [];
  for (let p = _portStart70a; p <= _portEnd70a; p++) {
    serverPorts.push(p);
  }
  // P3 (selectable port): allow the client to pick which port from the
  //   configured mieru range is written into server_port. Falls back to the
  //   range start when ?port= is absent or out of range.
  const mieruPort = pickMieruPort(req.query.port, _portStart70a, _portEnd70a);

  // Bug 74: align mieru outbound with the field-tested working client format
  // (Karing / sing-box mieru):
  //   - use `multiplexing: "MULTIPLEXING_HIGH"` (string enum), NOT
  //     `multiplex: { enabled: false }` (that object form is for other
  //     protocols' stream multiplexing and silently breaks the mieru parser);
  //   - use a single `server_port` (the working config does NOT send a
  //     `server_ports` array — sending both confuses the client);
  //   - prefer the raw server IP (mieru is IP-based, no SNI/TLS).
  const singboxCfg = {
    log: { level: 'info' },
    dns: {
      servers: [
        { tag: 'google', address: '8.8.8.8' },
        { tag: 'local',  address: '1.1.1.1', detour: 'direct' }
      ]
    },
    outbounds: [
      {
        type: 'mieru', tag: 'mieru-out',
        server: cfg.serverIp || cfg.domain,
        server_port: mieruPort,
        // Bug 5: transport field (TCP/UDP) — not protocol
        transport: 'TCP',
        username: user.username, password,
        // Bug 74: string enum, not an object
        multiplexing: 'MULTIPLEXING_HIGH'
      },
      { type: 'direct', tag: 'direct' }
    ],
    route: { final: 'mieru-out' }
  };
  // Keep the full port range available for clients/tooling that want it.
  void serverPorts;
  const filename = `mieru-${user.username}-${cfg.domain}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(singboxCfg);
});

app.get('/api/users/:id/config/universal', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';

  // Bug 70: parseInt guard prevents an infinite loop when values are strings/NaN
  const _portStart70b = parseInt(cfg.mieruPortStart, 10) || 2000;
  const _portEnd70b   = parseInt(cfg.mieruPortEnd,   10) || 2010;
  // P3 (selectable port): honour ?port= within the configured range.
  const mieruPortU = pickMieruPort(req.query.port, _portStart70b, _portEnd70b);

  const universalCfg = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', address: 'tls://8.8.8.8',               detour: 'select' },
        { tag: 'local',  address: 'https://223.5.5.5/dns-query',  detour: 'direct' }
      ],
      rules:  [{ outbound: 'any', server: 'local' }],
      final:  'remote'
    },
    outbounds: [
      {
        type: 'urltest', tag: 'select',
        outbounds: ['naive-out', 'mieru-out'],
        url: 'https://www.gstatic.com/generate_204',
        interval: '3m', tolerance: 50
      },
      {
        // Bug 87: NaiveProxy outbound MUST be type "naive", NOT "http".
        // A plain `type:http` is an ordinary HTTP-CONNECT proxy; it completes
        // TLS + CONNECT but lacks NaiveProxy's Cronet/Chromium traffic shaping
        // (HTTP/2 framing, padding, header order) that the caddy-forwardproxy
        // server expects — so the manual `naive+https://…` key worked while the
        // subscription's http outbound did not. Karing bundles the
        // with_naive_outbound build (libcronet), so type:naive works there.
        // `quic:false` matches the server's global `servers { protocols h1 h2 }`
        // (Bug 80 — HTTP/3 disabled); tls only carries server_name (the only
        // TLS field the naive outbound honours besides certificate/ech).
        type: 'naive', tag: 'naive-out',
        server: cfg.domain, server_port: cfg.naivePort,
        username: user.username, password,
        quic: false,
        tls: { enabled: true, server_name: cfg.domain }
      },
      {
        // Bug 74: working mieru format — string `multiplexing`, single port,
        // no `server_ports` array, no `multiplex` object.
        type: 'mieru', tag: 'mieru-out',
        server: cfg.serverIp || cfg.domain,
        server_port: mieruPortU,
        transport: 'TCP',
        username: user.username, password,
        multiplexing: 'MULTIPLEXING_HIGH'
      },
      { type: 'direct', tag: 'direct' },
      { type: 'dns',    tag: 'dns-out' }
    ],
    route: {
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { geoip: 'cn',     outbound: 'direct'  },
        { geosite: 'cn',   outbound: 'direct'  }
      ],
      final: 'select',
      auto_detect_interface: true
    }
  };
  const filename = `universal-${user.username}-${cfg.domain}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(universalCfg);
});

// Back-compat aliases
app.get('/api/users/:id/naive-link', requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/naive${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});
app.get('/api/users/:id/mieru-config', requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/mieru${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});
app.get('/api/users/:id/universal-config', requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/universal${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});

// ── Monitoring — /api/status ──────────────────────────────────────────────────
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const [cpu, mem, disk, osInfo] = await Promise.all([
      si.currentLoad(), si.mem(), si.fsSize(), si.osInfo()
    ]);
    const exec_ = cmd => { try { return execSync(cmd, { timeout: 3000 }).toString().trim(); } catch { return ''; } };

    // v1.2.3: check caddy-naive service (not legacy naive)
    const caddyActive  = exec_('systemctl is-active caddy-naive') === 'active';
    const caddyVersion = exec_(`${resolvedCaddyBin} version 2>/dev/null | head -1`) ||
                         exec_(`${resolvedCaddyBin} --version 2>/dev/null | head -1`);

    res.json({
      services: {
        naive: {   // kept as 'naive' key for front-end compatibility
          active:  caddyActive,
          version: caddyVersion
        },
        mieru: {
          active:  exec_('systemctl is-active mita') === 'active',
          version: exec_('mita version 2>/dev/null | head -1')
        },
        panel: { active: true }
      },
      system: {
        cpuPercent:  Math.round(cpu.currentLoad),
        ramUsedMB:   Math.round((mem.total - mem.available) / 1048576),
        ramTotalMB:  Math.round(mem.total / 1048576),
        diskUsedGB:  disk.length ? Math.round(disk[0].used / 1073741824) : 0,
        diskTotalGB: disk.length ? Math.round(disk[0].size / 1073741824) : 0,
        uptime: Math.floor(process.uptime()),
        os:   osInfo.distro + ' ' + osInfo.release,
        arch: osInfo.arch
      },
      panel:    { userCount: getAllUsers().length, version: readPanelVersion() },
      domain:   cfg.domain,
      serverIp: cfg.serverIp,
      language: cfg.language || 'ru'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User traffic stats
app.get('/api/stats/users', requireAuth, (req, res) => {
  const exec_ = cmd => { try { return execSync(cmd, { timeout: 8000 }).toString(); } catch { return ''; } };
  // Bug 78: the real mieru server command is `mita get users` (NOT the
  //   non-existent `mita describe users`, which always returned '' → traffic 0).
  //   Output is a table: User  LastActive  1DayDownload  1DayUpload  30DaysDownload  30DaysUpload
  const raw   = exec_('mita get users 2>/dev/null');
  const live  = parseMitaUsers(raw);
  // Bug 97: also account NaiveProxy traffic from the Caddy access log so
  //   naive-only users no longer show 0.0. Mieru + Naive figures are summed.
  const naive = parseCaddyTraffic(LOG_CADDY);
  const users = getAllUsers().map(u => {
    const s = live.find(x => x.username === u.username) || {};
    const n = naive[u.username] || {};
    const mieruUp   = s.uploadMB   || 0;
    const mieruDown = s.downloadMB || 0;
    const naiveUp   = n.uploadMB   || 0;
    const naiveDown = n.downloadMB || 0;
    const uploadMB   = mieruUp   + naiveUp;
    const downloadMB = mieruDown + naiveDown;
    // Combined used: prefer live mita "usedMB" when present, plus naive bytes;
    //   fall back to the stored cumulative value when neither source reports.
    const liveUsed = (s.usedMB != null ? s.usedMB : 0) + (n.usedMB || 0);
    const usedMB   = (s.usedMB != null || n.usedMB != null)
      ? liveUsed
      : (u.usedMB || 0);
    // Most recent activity across both protocols.
    const seenCandidates = [s.lastSeen, n.lastSeen, u.lastSeen].filter(Boolean);
    const lastSeen = seenCandidates.length
      ? seenCandidates.sort().slice(-1)[0]
      : null;
    return {
      username:   u.username,
      email:      u.email,
      expiry:     u.expiry,
      protocols:  JSON.parse(u.protocols || '[]'),
      quotaMB:    u.quotaMB,
      usedMB,
      uploadMB,
      downloadMB,
      naiveMB:    naiveUp + naiveDown,
      mieruMB:    mieruUp + mieruDown,
      lastSeen
    };
  });
  res.json(users);
});

// Bug 78: parse the `mita get users` table.
//   User  LastActive            1DayDownload  1DayUpload  30DaysDownload  30DaysUpload
//   abcd  2025-04-23T01:02:03Z  938.1MiB      12.9MiB     4.0GiB          31.8MiB
//   "used" = 30-day download + 30-day upload (best per-key cumulative metric mita exposes).
//   Sizes use binary IEC units (B / KiB / MiB / GiB / TiB) and may also appear as KB/MB/GB.
function parseMitaUsers(raw) {
  const users = [];
  if (!raw) return users;
  const sizeRe = /^([\d.]+)\s*([KMGT]?i?B)$/i;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // skip header / separator rows
    if (/^user\b/i.test(line) || /^[-=\s]+$/.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;
    const username = cols[0];
    const lastActive = cols[1];
    // last 4 columns are the size figures
    const sizeCols = cols.slice(-4);
    const vals = sizeCols.map(c => {
      const m = c.match(sizeRe);
      return m ? toMB(parseFloat(m[1]), m[2]) : null;
    });
    if (vals.some(v => v === null)) continue; // not a data row
    const [d1, u1, d30, u30] = vals;
    void d1; void u1;
    const downloadMB = d30;
    const uploadMB   = u30;
    users.push({
      username,
      uploadMB,
      downloadMB,
      usedMB:   uploadMB + downloadMB,
      lastSeen: /^\d{4}-\d{2}-\d{2}T/.test(lastActive) ? lastActive : null
    });
  }
  return users;
}
// Convert a size value to MB. Accepts both IEC (KiB/MiB/GiB/TiB) and
//   decimal-ish (KB/MB/GB/TB) unit spellings; bare "B" → bytes.
function toMB(v, unit) {
  switch ((unit || '').toUpperCase()) {
    case 'B':                return v / 1048576;
    case 'KB': case 'KIB':   return v / 1024;
    case 'GB': case 'GIB':   return v * 1024;
    case 'TB': case 'TIB':   return v * 1048576;
    default:                 return v; // MB / MiB
  }
}

// ── Bug 97: Naive (Caddy) per-user traffic accounting ────────────────────────
// Mieru traffic comes from `mita get users`, but NaiveProxy traffic was never
// accounted, so naive-only users always showed 0.0. caddy-forwardproxy-naive
// writes a JSON access log (the global `log { format json }` block). Each
// handled CONNECT request carries the authenticated basic_auth username under
// request.user_id and byte counters (bytes_read = client→server upload,
// size/bytes_written = server→client download). We sum per user over the
// current (un-rolled) log file. This is a best-effort "since last log roll"
// figure — the same character as mita's 30-day window — and is additive with
// the Mieru figure for users that have both protocols.
//
// Returns: { username: { uploadMB, downloadMB, usedMB, lastSeen } }
function parseCaddyTraffic(logPath) {
  const out = {};
  const file = logPath || LOG_CADDY;
  let raw;
  try {
    if (!fs.existsSync(file)) return out;
    // Cap how much we read so a large log never blocks the event loop /
    // exhausts memory. 32 MiB tail is plenty for a 50mb-rolled file.
    const stat = fs.statSync(file);
    const MAX = 32 * 1024 * 1024;
    if (stat.size > MAX) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(MAX);
      fs.readSync(fd, buf, 0, MAX, stat.size - MAX);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
      // Drop the first (likely partial) line.
      const nl = raw.indexOf('\n');
      if (nl >= 0) raw = raw.slice(nl + 1);
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch { return out; }

  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    const req = e.request || {};
    // user_id is the basic_auth username for authenticated forward_proxy reqs.
    const user = req.user_id || e.user_id || '';
    if (!user) continue;
    const up   = Number(e.bytes_read)    || 0;                     // client → server
    const down = Number(e.size != null ? e.size : e.bytes_written) || 0; // server → client
    const ts   = e.ts;
    if (!out[user]) out[user] = { uploadB: 0, downloadB: 0, lastTs: 0 };
    out[user].uploadB   += up;
    out[user].downloadB += down;
    if (typeof ts === 'number' && ts > out[user].lastTs) out[user].lastTs = ts;
  }

  const result = {};
  for (const [user, v] of Object.entries(out)) {
    const uploadMB   = v.uploadB   / 1048576;
    const downloadMB = v.downloadB / 1048576;
    result[user] = {
      uploadMB,
      downloadMB,
      usedMB:   uploadMB + downloadMB,
      // Caddy ts is float seconds since epoch.
      lastSeen: v.lastTs ? new Date(v.lastTs * 1000).toISOString() : null
    };
  }
  return result;
}

// ── Logs API ──────────────────────────────────────────────────────────────────
app.get('/api/logs/:service', requireAuth, (req, res) => {
  const { service } = req.params;
  const lines = Math.min(parseInt(req.query.lines || '100', 10), 1000);
  let cmd;
  switch (service) {
    // v1.2.3: caddy-naive logs (supports legacy 'naive' and 'caddy' aliases)
    case 'naive':
    case 'caddy':
      cmd = `journalctl -u caddy-naive -n ${lines} --no-pager 2>/dev/null || tail -n ${lines} ${LOG_CADDY} 2>/dev/null`;
      break;
    case 'mieru': cmd = `journalctl -u mita -n ${lines} --no-pager 2>/dev/null || mita describe log 2>/dev/null`; break;
    case 'panel': cmd = `tail -n ${lines} ${LOG_PANEL} 2>/dev/null`; break;
    default: return res.status(400).json({ error: 'Unknown service' });
  }
  try { res.json({ logs: execSync(cmd, { timeout: 6000 }).toString() }); }
  catch { res.json({ logs: '(no logs available)' }); }
});

// ── Diagnostics ───────────────────────────────────────────────────────────────
app.get('/api/diagnostics', requireAuth, async (_req, res) => {
  const exec_ = cmd => { try { return execSync(cmd, { timeout: 4000 }).toString().trim(); } catch { return ''; } };

  const chkPort = p => {
    try {
      return parseInt(
        execSync(`ss -tlnup sport = :${p} 2>/dev/null | grep -c :${p}`, { timeout: 3000 }).toString().trim(),
        10) > 0;
    } catch { return false; }
  };

  // v1.2.3: caddy-naive version check (replaces naive --version)
  let caddyVersionOk = false, caddyVersionStr = '';
  try {
    caddyVersionStr = execSync(`${resolvedCaddyBin} version 2>&1`, { timeout: 6000 }).toString().trim() ||
                     execSync(`${resolvedCaddyBin} --version 2>&1`, { timeout: 6000 }).toString().trim();
    caddyVersionOk  = caddyVersionStr.length > 0;
  } catch (e) { caddyVersionStr = e.message; }

  const mieruPortsListening = [];
  for (const p of [cfg.mieruPortStart, cfg.mieruPortEnd]) {
    if (p && chkPort(p)) mieruPortsListening.push(p);
  }

  res.json({
    ports: {
      naive:       chkPort(cfg.naivePort),
      mieru:       chkPort(cfg.mieruPortStart),
      mieruPorts:  mieruPortsListening
    },
    naiveVersionOk:    caddyVersionOk,
    naiveVersion:      caddyVersionStr,    // kept as 'naiveVersion' for front-end compat
    naiveConfigExists: fs.existsSync(resolvedCaddyFile),
    htpasswdExists:    false,              // htpasswd removed in v1.2.3 (users in Caddyfile)
    htpasswdUsers:     0,
    caddyfileExists:   fs.existsSync(resolvedCaddyFile),
    caddyfileUsers:    (() => {
      if (!fs.existsSync(resolvedCaddyFile)) return 0;
      const content = fs.readFileSync(resolvedCaddyFile, 'utf8');
      // Bug 23: directive is now "basic_auth" (underscore), not "basicauth"
      return (content.match(/^\s*basic_auth\s+\S+\s+\S+/gm) || []).length;
    })(),
    mitaStatus:   exec_('mita status 2>/dev/null'),
    mitaConfig:   exec_('mita describe config 2>/dev/null'),
    timeSynced:   exec_('timedatectl status 2>/dev/null').includes('synchronized: yes'),
    mitaStateFile: resolvedMitaFile,
    probeSecretSet: !!(cfg.probeSecret),
    probeMode: (cfg.probeMode || (cfg.probeSecret ? 'secret' : 'bare'))
  });
});

// ── Service control ───────────────────────────────────────────────────────────
app.post('/api/service/:name/:action', requireAuth, (req, res) => {
  const { name, action } = req.params;
  // Map legacy 'naive' name to 'caddy-naive'; keep 'mita' as-is
  const svcMap = { 'naive': 'caddy-naive', 'caddy-naive': 'caddy-naive', 'mita': 'mita' };
  const svcName = svcMap[name];
  if (!svcName)
    return res.status(400).json({ error: 'Unknown service (valid: naive/caddy-naive, mita)' });
  if (!['start','stop','restart','reload'].includes(action))
    return res.status(400).json({ error: 'Unknown action' });
  try {
    // Bug 96: before a manual start/restart, clear any lingering systemd
    //   "failed" state so the command is actually honoured (otherwise the
    //   unit can stay failed → "no user found" / mita=failed).
    if (['start','restart'].includes(action)) {
      try { execSync(`systemctl reset-failed ${svcName} 2>/dev/null || true`, { timeout: 5000 }); } catch {}
    }
    execSync(`systemctl ${action} ${svcName} 2>&1`, { timeout: 15000 });
    res.json({ ok: true, service: svcName, action });
  } catch (e) { res.status(500).json({ error: e.stdout?.toString() || e.message }); }
});

// ── WebSocket — real-time metrics ─────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const exec_ = cmd => { try { return execSync(cmd, { timeout: 2000 }).toString().trim(); } catch { return ''; } };
  let iv;
  const push = async () => {
    if (ws.readyState !== ws.OPEN) { clearInterval(iv); return; }
    try {
      const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
      ws.send(JSON.stringify({
        type:       'metrics',
        ts:         Date.now(),
        cpu:        Math.round(cpu.currentLoad),
        ramUsedMB:  Math.round((mem.total - mem.available) / 1048576),
        ramTotalMB: Math.round(mem.total / 1048576),
        // v1.2.3: check caddy-naive service
        naive:      exec_('systemctl is-active caddy-naive') === 'active',
        mieru:      exec_('systemctl is-active mita')        === 'active'
      }));
    } catch {}
  };
  iv = setInterval(push, 5000);
  push();
  ws.on('message', d => { try { const m = JSON.parse(d); if (m.type==='ping') ws.send(JSON.stringify({type:'pong'})); } catch {} });
  ws.on('close',  () => clearInterval(iv));
  ws.on('error',  () => clearInterval(iv));
});

// ── Expiry cron — every 5 min ─────────────────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  const now = new Date().toISOString();
  let changed = false;
  getAllUsers().forEach(u => {
    if (u.expiry && u.expiry < now) {
      console.log('[CRON] Removing expired user:', u.username);
      deleteUser(u.id); changed = true;
    }
  });
  if (changed) {
    try {
      const content = buildCaddyfile(cfg, getAllUsers());
      writeCaddyfileAtomic(content);
      reloadCaddy();
    } catch {}
    try { applyMitaConfig(); } catch {}
  }
});

// ── Traffic snapshot cron — every 60 s ───────────────────────────────────────
cron.schedule('* * * * *', () => {
  if (!db) return;
  try {
    // Bug 78: use `mita get users` (the real command); `mita describe users`
    //   does not exist and always produced empty output.
    let raw = '';
    try { raw = execSync('mita get users 2>/dev/null', { timeout: 5000 }).toString(); } catch {}
    const live = parseMitaUsers(raw);
    // Bug 97: also fold in NaiveProxy traffic from the Caddy access log so
    //   naive-only users are persisted with non-zero usage.
    const naive = parseCaddyTraffic(LOG_CADDY);

    // Build a combined per-username map.
    const combined = {};
    live.forEach(s => {
      combined[s.username] = {
        uploadMB:   s.uploadMB   || 0,
        downloadMB: s.downloadMB || 0,
        usedMB:     s.usedMB     || 0,
        lastSeen:   s.lastSeen   || null
      };
    });
    for (const [user, n] of Object.entries(naive)) {
      const c = combined[user] || { uploadMB: 0, downloadMB: 0, usedMB: 0, lastSeen: null };
      c.uploadMB   += n.uploadMB   || 0;
      c.downloadMB += n.downloadMB || 0;
      c.usedMB     += n.usedMB     || 0;
      if (n.lastSeen && (!c.lastSeen || n.lastSeen > c.lastSeen)) c.lastSeen = n.lastSeen;
      combined[user] = c;
    }

    const entries = Object.entries(combined);
    if (!entries.length) return;
    const ts   = new Date().toISOString();
    const ins  = db.prepare('INSERT INTO traffic_snapshots (username,uploadMB,downloadMB,ts) VALUES (?,?,?,?)');
    entries.forEach(([username, s]) => ins.run(username, s.uploadMB, s.downloadMB, ts));
    entries.forEach(([username, s]) => {
      const u = getUserByUsername(username);
      if (u) upsertUser({ ...u, usedMB: s.usedMB, lastSeen: s.lastSeen || ts, updatedAt: ts });
    });
  } catch {}
});

// ── SPA catch-all ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Global error handler (Bug 149) ───────────────────────────────────────────
// Last-resort safety net: any error thrown synchronously inside a route (e.g. a
// SqliteError from an unguarded DB call) must NOT reach the client as a raw
// Express HTML stacktrace exposing internal file paths like
// "/opt/panel-naive-mieru/server/index.js:206". Log the detail server-side and
// return a clean JSON error. UNIQUE violations are mapped to a friendly 409.
// (Express identifies error-handling middleware by its 4-arg signature.)
app.use((err, req, res, next) => {     // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  console.error('[ERR]', req && req.method, req && req.path, '-', err && err.message);
  const d = (err && /SqliteError|UNIQUE constraint/i.test(String(err.message || err.code || '')))
    ? describeDbError(err)
    : { status: 500, error: 'Internal server error' };
  res.status(d.status).json({ error: d.error });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const HOST = process.env.PANEL_HOST || cfg.panelHost || '127.0.0.1';
const PORT = parseInt(process.env.PANEL_PORT || String(cfg.panelPort || 3000), 10);

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    '  ██████╗  ██╗ ██╗  ██╗ ██╗  ██╗ ██╗  ██╗',
    '  ██╔══██╗ ██║ ╚██╗██╔╝ ╚██╗██╔╝ ╚██╗██╔╝',
    '  ██████╔╝ ██║  ╚███╔╝   ╚███╔╝   ╚███╔╝ ',
    '  ██╔══██╗ ██║  ██╔██╗   ██╔██╗   ██╔██╗ ',
    '  ██║  ██║ ██║ ██╔╝ ██╗ ██╔╝ ██╗ ██╔╝ ██╗',
    '  ╚═╝  ╚═╝ ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝',
    '',
    `  Panel Naive + Mieru v${readPanelVersion()} by RIXXX  (Caddy-forwardproxy-naive)`,
    `  http://${HOST}:${PORT}/`,
    HOST === '127.0.0.1' ? `  ⚠  SSH-only: ssh -L 3000:127.0.0.1:3000 root@<server>` : '',
    ''
  ];
  lines.forEach(l => console.log(l));
});

module.exports = app;
