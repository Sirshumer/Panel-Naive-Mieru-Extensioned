/**
 * Panel Naive + Mieru by RIXXX — Express backend  v1.2.0
 * Node.js 20 LTS + Express + better-sqlite3 + WebSocket + node-cron
 *
 * IMPORTANT: Mieru (mita) uses an internal protobuf config store at /etc/mita/.
 * JSON is NEVER written there directly. Instead, the panel:
 *   1. Builds a complete JSON state file at MITA_STATE_FILE
 *   2. Applies it via: mita apply config <file>
 *   3. Reloads without dropping connections: mita reload
 *   4. Full restart (port changes only): mita stop && mita start
 *
 * Blocker 7: NaiveProxy now uses a standalone 'naive' binary with config.json
 *   + htpasswd file for multi-user auth. No Caddyfile is generated.
 *   buildNaiveConfig() — rewrites /etc/naive/config.json atomically
 *   buildHtpasswd()    — rewrites /etc/naive/htpasswd (bcrypt, one user per line)
 *   After any user CRUD: buildHtpasswd() → reloadNaive() (or restartNaive())
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
const { execSync }   = require('child_process');
const si             = require('systeminformation');

// ── Paths ─────────────────────────────────────────────────────────────────────
const PANEL_CONFIG    = '/etc/rixxx-panel/config.json';
const DB_PATH         = '/var/lib/rixxx-panel/db.sqlite';
// Panel-owned JSON applied via `mita apply config <file>` (NOT /etc/mita/ directly)
const MITA_STATE_FILE = '/var/lib/rixxx-panel/mita-state.json';

// Blocker 7: naive binary paths (replaces caddy-naive / Caddyfile)
const NAIVE_BIN         = '/usr/local/bin/naive';
const NAIVE_CONFIG_DIR  = '/etc/naive';
const NAIVE_CONFIG_FILE = '/etc/naive/config.json';
const NAIVE_HTPASSWD    = '/etc/naive/htpasswd';
const LOG_NAIVE         = '/var/log/naive/access.log';
const LOG_PANEL         = '/var/log/panel-naive-mieru.log';

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
    naiveConfig:   NAIVE_CONFIG_FILE,
    naiveHtpasswd: NAIVE_HTPASSWD,
    naiveBin:      NAIVE_BIN,
    mitaStateFile: MITA_STATE_FILE,
    trafficPattern: 'NOOP', mtu: 1400, udpEnabled: false,
    language: 'ru', version: '1.2.0'
  };
}

// Resolved paths (prefer config values, fall back to constants)
const resolvedDb        = cfg.dbPath        || DB_PATH;
const resolvedMitaFile  = cfg.mitaStateFile || MITA_STATE_FILE;
const resolvedNaiveCfg  = cfg.naiveConfig   || NAIVE_CONFIG_FILE;
const resolvedHtpasswd  = cfg.naiveHtpasswd || NAIVE_HTPASSWD;
const resolvedNaiveBin  = cfg.naiveBin      || NAIVE_BIN;

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
      email     TEXT NOT NULL UNIQUE,
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
  // Migrate: add password column if missing (upgrade from v1.0.0)
  try { db.exec(`ALTER TABLE users ADD COLUMN password TEXT NOT NULL DEFAULT ''`); } catch {}
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
function upsertUser(u) {
  if (db) {
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
    `).run({ ...u, password: u.password || '' });
  } else {
    memUsers.set(u.id, u);
  }
}
function deleteUser(id) {
  if (db) db.prepare('DELETE FROM users WHERE id = ?').run(id);
  else memUsers.delete(id);
}

// ── Persist config ────────────────────────────────────────────────────────────
function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(PANEL_CONFIG), { recursive: true });
    fs.writeFileSync(PANEL_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (e) { console.error('[CFG]', e.message); }
}

// ── Blocker 7: buildHtpasswd() ────────────────────────────────────────────────
// Writes /etc/naive/htpasswd with bcrypt-hashed lines (username:$2y$12$…)
// Naive reads this file on reload/restart.
function buildHtpasswd(users) {
  const naiveUsers = users.filter(u => {
    try { return JSON.parse(u.protocols || '["naive","mieru"]').includes('naive'); }
    catch { return true; }
  });
  const lines = naiveUsers.map(u => `${u.username}:${u.passHash}`).join('\n');
  fs.mkdirSync(path.dirname(resolvedHtpasswd), { recursive: true });
  const tmp = resolvedHtpasswd + '.new';
  fs.writeFileSync(tmp, lines + (lines ? '\n' : ''), { mode: 0o640 });
  fs.renameSync(tmp, resolvedHtpasswd);   // atomic replace
}

// ── Blocker 7: buildNaiveConfig() ────────────────────────────────────────────
// Writes /etc/naive/config.json atomically.
// Schema: { listen, name, auth (htpasswd path), padding, log, cert?, key? }
function buildNaiveConfig() {
  fs.mkdirSync(NAIVE_CONFIG_DIR, { recursive: true });
  const naiveCfg = {
    listen:  `https://:${cfg.naivePort}`,
    name:    cfg.domain || 'localhost',
    auth:    resolvedHtpasswd,
    padding: true,
    log:     LOG_NAIVE
  };
  // Include TLS cert/key paths when present (Certbot)
  if (cfg.certPath && fs.existsSync(cfg.certPath)) {
    naiveCfg.cert = cfg.certPath;
    naiveCfg.key  = cfg.keyPath;
  }
  const tmp = resolvedNaiveCfg + '.new';
  fs.mkdirSync(path.dirname(resolvedNaiveCfg), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(naiveCfg, null, 2), { mode: 0o640 });
  fs.renameSync(tmp, resolvedNaiveCfg);   // atomic replace
}

// ── Bug 3 fix: UFW single-port helper ───────────────────────────────────────
// UFW rejects "N:N/proto" when start===end; use a single-port rule instead.
function ufwMieruRule(action, start, end, proto, comment) {
  if (start === end) {
    execSync(`ufw ${action} allow ${start}/${proto}${comment ? ` comment "${comment}"` : ''} 2>/dev/null || true`, { timeout: 5000 });
  } else {
    execSync(`ufw ${action} allow ${start}:${end}/${proto}${comment ? ` comment "${comment}"` : ''} 2>/dev/null || true`, { timeout: 5000 });
  }
}

// ── Blocker 7: Service helpers — naive ───────────────────────────────────────
// Reload naive (SIGHUP for hot-reload without dropping connections)
function reloadNaive() {
  try {
    execSync('systemctl reload naive 2>/dev/null || kill -HUP $(pgrep -x naive 2>/dev/null) 2>/dev/null || true',
             { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// Full naive restart (needed for port/TLS changes)
function restartNaive() {
  try {
    execSync('systemctl restart naive 2>/dev/null', { timeout: 15000 });
    return true;
  } catch { return false; }
}

// ── Mieru state JSON builder ──────────────────────────────────────────────────
function buildMitaStateFile() {
  const allUsers = getAllUsers();
  const mieruUsers = allUsers.filter(u => {
    try { return JSON.parse(u.protocols || '["naive","mieru"]').includes('mieru'); }
    catch { return true; }
  });

  // TCP-only by default; UDP is opt-in via cfg.udpEnabled
  const portBindings = [];
  for (let p = cfg.mieruPortStart; p <= cfg.mieruPortEnd; p++) {
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

  // Only add trafficPattern when not NOOP (omitting = NOOP default)
  const pat = cfg.trafficPattern || 'NOOP';
  if (pat !== 'NOOP') {
    const patMap = {
      'RANDOM_PADDING':            { seed: true,  tcpFragment: false, nonce: false },
      'RANDOM_PADDING_AGGRESSIVE': { seed: true,  tcpFragment: true,  nonce: true  },
      'CUSTOM':                    { seed: true,  tcpFragment: true,  nonce: true  }
    };
    if (patMap[pat]) mieruCfg.trafficPattern = patMap[pat];
  }

  fs.mkdirSync(path.dirname(resolvedMitaFile), { recursive: true });
  const tmp = resolvedMitaFile + '.new';
  fs.writeFileSync(tmp, JSON.stringify(mieruCfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, resolvedMitaFile);       // atomic replace

  shredFile(resolvedMitaFile + '.last');
  try { fs.copyFileSync(resolvedMitaFile, resolvedMitaFile + '.last'); } catch {}

  return resolvedMitaFile;
}

// Apply config (no connection drop) — used for user add/update/delete
function applyMitaConfig() {
  const file = buildMitaStateFile();
  try {
    execSync(`mita apply config ${file} 2>/dev/null`, { timeout: 15000 });
    execSync('mita reload 2>/dev/null', { timeout: 15000 });
    shredFile(file + '.last');
    return true;
  } catch {
    return false;
  }
}

// Full restart — required ONLY when port range changes
function restartMieru() {
  try {
    execSync('mita stop 2>/dev/null || true', { timeout: 10000 });
    const file = buildMitaStateFile();
    execSync(`mita apply config ${file} 2>/dev/null`, { timeout: 10000 });
    execSync('mita start 2>/dev/null || systemctl start mita 2>/dev/null', { timeout: 15000 });
    shredFile(file + '.last');
    return true;
  } catch { return false; }
}

function shredFile(fp) {
  if (!fp || !fs.existsSync(fp)) return;
  try { execSync(`shred -u "${fp}" 2>/dev/null`, { timeout: 5000 }); }
  catch { try { fs.unlinkSync(fp); } catch {} }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'",
                   'https://fonts.googleapis.com',
                   'https://cdn.jsdelivr.net'],
      styleSrc:   ["'self'", "'unsafe-inline'",
                   'https://fonts.googleapis.com',
                   'https://fonts.gstatic.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://fonts.googleapis.com'],
      imgSrc:     ["'self'", 'data:', 'blob:'],
      mediaSrc:   ["'none'"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"]
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
  cookie: { secure: false, httpOnly: true, maxAge: 86400000 }
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

  // Bcrypt-only — no SHA-256 fallback
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
  const { adminPassHash, ...safe } = cfg;
  res.json(safe);
});

app.post('/api/config', requireAuth, (req, res) => {
  ['domain','naivePort','mieruPortStart','mieruPortEnd',
   'trafficPattern','mtu','udpEnabled','adminEmail','language'].forEach(k => {
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

// ── Validation helpers ───────────────────────────────────────────────────────
const VALID_PROTOCOLS = ['naive', 'mieru'];
const USERNAME_RE     = /^[a-zA-Z0-9_.-]{1,64}$/;
const EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Bug 8: normalise quota — accept quotaMB or quotaGb (gb * 1024 → MB).
 * Bug 9: validate all user input fields.
 * Returns { error } string on failure, or { quotaMB, protocols } on success.
 */
function validateUserInput({ email, username, password, protocols, quotaMB, quotaGb }, requirePassword) {
  if (!username || !USERNAME_RE.test(username))
    return { error: 'username required and must match [a-zA-Z0-9_.-] (max 64 chars)' };
  if (!email || !EMAIL_RE.test(email))
    return { error: 'valid email is required' };
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
 * Bug 6: helper that rebuilds services and returns reloaded status.
 */
function parseUserRow(u) {
  return {
    ...u,
    protocols: typeof u.protocols === 'string'
      ? (() => { try { return JSON.parse(u.protocols); } catch { return []; } })()
      : (u.protocols || []),
  };
}

function rebuildServices() {
  let naiveOk = false, mitaOk = false;
  try { buildHtpasswd(getAllUsers()); naiveOk = reloadNaive(); }
  catch (e) { console.error('[NAIVE]', e.message); }
  try { mitaOk = applyMitaConfig(); }
  catch (e) { console.error('[MITA]', e.message); }
  return { naiveOk, mitaOk, servicesReloaded: naiveOk && mitaOk };
}

// ── Users API ─────────────────────────────────────────────────────────────────
// Bug 7: parse protocols (TEXT → Array) in GET /api/users
app.get('/api/users', requireAuth, (req, res) => {
  const users = getAllUsers().map(u => {
    const { passHash, password, ...rest } = u;
    return parseUserRow(rest);
  });
  res.json(users);
});

app.post('/api/users', requireAuth, (req, res) => {
  // Bug 9: full validation; Bug 8: quotaGb support
  const { email, username, password, expiry, protocols, quotaMB, quotaGb } = req.body;
  const validation = validateUserInput(
    { email, username, password, protocols, quotaMB, quotaGb }, true);
  if (validation.error)
    return res.status(400).json({ error: validation.error });

  if (getUserByUsername(username))
    return res.status(409).json({ error: 'Username already exists' });

  // Validate expiry if provided
  if (expiry && isNaN(Date.parse(expiry)))
    return res.status(400).json({ error: 'expiry must be a valid ISO date string' });

  const now  = new Date().toISOString();
  const user = {
    id:        uuidv4(),
    email, username,
    passHash:  bcrypt.hashSync(password, 12),  // for naive htpasswd
    password,                                   // plain text for mita apply config
    expiry:    expiry || null,
    protocols: JSON.stringify(validation.protocols),
    quotaMB:   validation.quotaMB,
    usedMB:    0,
    createdAt: now, updatedAt: now, lastSeen: null
  };
  upsertUser(user);

  // Bug 6: rebuild htpasswd + reload naive; rebuild mita state; report status
  const svcStatus = rebuildServices();

  const { passHash, password: _p, ...safe } = user;
  // Bug 7: return protocols as array
  res.status(201).json({ ...parseUserRow(safe), ...svcStatus });
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { email, username, password, expiry, protocols, quotaMB, quotaGb } = req.body;
  // Bug 9: validate; Bug 8: quotaGb support
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

  const updated = {
    ...user,
    email:     email     ?? user.email,
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
  upsertUser(updated);

  // Bug 6: rebuild services and report status
  const svcStatus = rebuildServices();

  const { passHash, password: _p, ...safe } = updated;
  // Bug 7: return protocols as array
  res.json({ ...parseUserRow(safe), ...svcStatus });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  deleteUser(req.params.id);
  // Bug 6: rebuild services and report status
  const svcStatus = rebuildServices();
  res.json({ ok: true, ...svcStatus });
});

// ── Server settings — Sprint 3 ────────────────────────────────────────────────

// Naive port: rebuild config + full restart (port binding change)
app.post('/api/settings/naive-port', requireAuth, (req, res) => {
  const p = parseInt(req.body.port, 10);
  if (!p || p < 1 || p > 65535)
    return res.status(400).json({ error: 'Invalid port (1–65535)' });
  cfg.naivePort = p; saveConfig();
  try {
    buildNaiveConfig();
    const ok = restartNaive();
    res.json({ ok, message: `NaiveProxy port changed to ${p}. Clients must download new configs.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mieru ports: UFW update + FULL restart
app.post('/api/settings/mieru-ports', requireAuth, (req, res) => {
  const s = parseInt(req.body.portStart, 10);
  const e = parseInt(req.body.portEnd,   10);
  if (!s || !e || s < 1025 || e > 65535 || e < s)
    return res.status(400).json({ error: 'Invalid port range (1025–65535, end ≥ start)' });

  const oldS = cfg.mieruPortStart, oldE = cfg.mieruPortEnd;
  cfg.mieruPortStart = s; cfg.mieruPortEnd = e; saveConfig();

  try {
    // Bug 3 fix: use single-port helper to avoid UFW crash when start===end
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
    // Bug 3 fix: use single-port helper to avoid UFW crash when start===end
    if (enable) {
      ufwMieruRule('', s, e, 'udp', 'Mieru UDP');
    } else {
      ufwMieruRule('delete', s, e, 'udp', '');
    }
  } catch {}
  try {
    const ok = restartMieru();
    res.json({ ok, udpEnabled: enable,
      message: `UDP ${enable ? 'enabled' : 'disabled'}. Mieru restarted. Clients must download new configs.` });
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

// ── Client configs — Sprint 4 ─────────────────────────────────────────────────

// Sprint 4 canonical routes
app.get('/api/users/:id/config/naive', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';
  const link = `naive+https://${user.username}:${encodeURIComponent(password)}@${cfg.domain}:${cfg.naivePort}`;
  res.json({ link, username: user.username });
});

app.get('/api/users/:id/config/mieru', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';
  const singboxCfg = {
    log: { level: 'info', timestamp: true },
    outbounds: [
      {
        type: 'mieru', tag: 'mieru-out',
        server: cfg.serverIp || cfg.domain,
        server_port: cfg.mieruPortStart,
        username: user.username, password,
        protocol: 'TCP',
        multiplex: { enabled: false }
      },
      { type: 'direct', tag: 'direct' },
      { type: 'dns',    tag: 'dns-out' }
    ],
    route: {
      rules: [{ protocol: 'dns', outbound: 'dns-out' }],
      final: 'mieru-out'
    }
  };
  const filename = `mieru-${user.username}-${cfg.domain}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(singboxCfg);
});

app.get('/api/users/:id/config/universal', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';
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
        type: 'http', tag: 'naive-out',
        server: cfg.domain, server_port: cfg.naivePort,
        username: user.username, password,
        tls: { enabled: true, server_name: cfg.domain }
      },
      {
        type: 'mieru', tag: 'mieru-out',
        server: cfg.serverIp || cfg.domain,
        server_port: cfg.mieruPortStart,
        username: user.username, password,
        protocol: 'TCP',
        multiplex: { enabled: false }
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
app.get('/api/users/:id/naive-link',       requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/naive${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});
app.get('/api/users/:id/mieru-config',     requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/mieru${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});
app.get('/api/users/:id/universal-config', requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/universal${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});

// ── Monitoring — Sprint 5 ─────────────────────────────────────────────────────
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const [cpu, mem, disk, osInfo] = await Promise.all([
      si.currentLoad(), si.mem(), si.fsSize(), si.osInfo()
    ]);
    const exec_ = cmd => { try { return execSync(cmd, { timeout: 3000 }).toString().trim(); } catch { return ''; } };

    res.json({
      services: {
        // Blocker 7: naive service (not caddy-naive)
        naive: { active: exec_('systemctl is-active naive') === 'active',
                 version: exec_(`${resolvedNaiveBin} --version 2>/dev/null | head -1`) },
        mieru: { active: exec_('systemctl is-active mita') === 'active',
                 version: exec_('mita version 2>/dev/null | head -1') },
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
      panel:    { userCount: getAllUsers().length, version: cfg.version || '1.2.0' },
      domain:   cfg.domain,
      serverIp: cfg.serverIp,
      language: cfg.language || 'ru'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User traffic stats (merged DB + live mita describe users)
app.get('/api/stats/users', requireAuth, (req, res) => {
  const exec_ = cmd => { try { return execSync(cmd, { timeout: 8000 }).toString(); } catch { return ''; } };
  const raw   = exec_('mita describe users 2>/dev/null');
  const live  = parseMitaUsers(raw);
  const users = getAllUsers().map(u => {
    const s = live.find(x => x.username === u.username) || {};
    return {
      username:   u.username,
      email:      u.email,
      expiry:     u.expiry,
      protocols:  JSON.parse(u.protocols || '[]'),
      quotaMB:    u.quotaMB,
      usedMB:     s.usedMB    || u.usedMB || 0,
      uploadMB:   s.uploadMB  || 0,
      downloadMB: s.downloadMB || 0,
      lastSeen:   u.lastSeen
    };
  });
  res.json(users);
});

// Parse `mita describe users` output
function parseMitaUsers(raw) {
  const users = [];
  if (!raw) return users;
  const lines = raw.split('\n');
  let cur = null;
  for (const line of lines) {
    const nameM = line.match(/username[:\s]+(\S+)/i) || line.match(/^user[:\s]+(\S+)/i);
    if (nameM) { if (cur) users.push(cur); cur = { username: nameM[1], uploadMB: 0, downloadMB: 0, usedMB: 0 }; }
    if (cur) {
      const upM   = line.match(/upload[:\s]+([\d.]+)\s*(MB|GB|KB)/i);
      const downM = line.match(/download[:\s]+([\d.]+)\s*(MB|GB|KB)/i);
      if (upM)   cur.uploadMB   = toMB(parseFloat(upM[1]),   upM[2]);
      if (downM) cur.downloadMB = toMB(parseFloat(downM[1]), downM[2]);
    }
  }
  if (cur) users.push(cur);
  users.forEach(u => { u.usedMB = u.uploadMB + u.downloadMB; });
  return users;
}
function toMB(v, u) {
  switch ((u || '').toUpperCase()) {
    case 'KB': return v / 1024;
    case 'GB': return v * 1024;
    default:   return v;
  }
}

// ── Logs API ──────────────────────────────────────────────────────────────────
app.get('/api/logs/:service', requireAuth, (req, res) => {
  const { service } = req.params;
  const lines = Math.min(parseInt(req.query.lines || '100', 10), 1000);
  let cmd;
  switch (service) {
    // Blocker 7: naive logs (not caddy-naive)
    case 'caddy':
    case 'naive': cmd = `journalctl -u naive -n ${lines} --no-pager 2>/dev/null || tail -n ${lines} ${LOG_NAIVE} 2>/dev/null`; break;
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

  // Blocker 8: port-listen check helper
  const chkPort = p => {
    try {
      return parseInt(
        execSync(`ss -tlnup sport = :${p} 2>/dev/null | grep -c :${p}`, { timeout: 3000 }).toString().trim(),
        10) > 0;
    } catch { return false; }
  };

  // Blocker 5: naive --version instead of caddy validate
  let naiveVersionOk = false, naiveVersionStr = '';
  try {
    naiveVersionStr = execSync(`${resolvedNaiveBin} --version 2>&1`, { timeout: 6000 }).toString().trim();
    naiveVersionOk  = naiveVersionStr.length > 0;
  } catch (e) { naiveVersionStr = e.message; }

  // Blocker 8: check all Mieru ports in range (sample first and last)
  const mieruPortsListening = [];
  for (const p of [cfg.mieruPortStart, cfg.mieruPortEnd]) {
    if (p && chkPort(p)) mieruPortsListening.push(p);
  }

  res.json({
    ports: {
      naive:       chkPort(cfg.naivePort),
      mieru:       chkPort(cfg.mieruPortStart),
      // Blocker 8: extended Mieru port check
      mieruPorts:  mieruPortsListening
    },
    // Blocker 5: naive --version replaces caddy validate
    naiveVersionOk,
    naiveVersion:      naiveVersionStr,
    naiveConfigExists: fs.existsSync(resolvedNaiveCfg),
    htpasswdExists:    fs.existsSync(resolvedHtpasswd),
    htpasswdUsers:     fs.existsSync(resolvedHtpasswd)
      ? fs.readFileSync(resolvedHtpasswd, 'utf8').split('\n').filter(l => l.trim()).length
      : 0,
    mitaStatus:   exec_('mita status 2>/dev/null'),
    mitaConfig:   exec_('mita describe config 2>/dev/null'),
    timeSynced:   exec_('timedatectl status 2>/dev/null').includes('synchronized: yes'),
    mitaStateFile: resolvedMitaFile
  });
});

// ── Service control ───────────────────────────────────────────────────────────
app.post('/api/service/:name/:action', requireAuth, (req, res) => {
  const { name, action } = req.params;
  // Accept both 'naive' (new) and 'caddy-naive' (legacy alias) for back-compat
  const svcName = name === 'caddy-naive' ? 'naive' : name;
  if (!['naive','mita'].includes(svcName))
    return res.status(400).json({ error: 'Unknown service (valid: naive, mita)' });
  if (!['start','stop','restart','reload'].includes(action))
    return res.status(400).json({ error: 'Unknown action' });
  try {
    execSync(`systemctl ${action} ${svcName} 2>&1`, { timeout: 15000 });
    res.json({ ok: true, service: svcName, action });
  } catch (e) { res.status(500).json({ error: e.stdout?.toString() || e.message }); }
});

// ── WebSocket — real-time metrics (5 s interval) ──────────────────────────────
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
        // Blocker 7: check 'naive' service (not caddy-naive)
        naive:      exec_('systemctl is-active naive') === 'active',
        mieru:      exec_('systemctl is-active mita')  === 'active'
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
    // Blocker 7: rebuild htpasswd + reload naive instead of Caddyfile
    try { buildHtpasswd(getAllUsers()); reloadNaive(); } catch {}
    try { applyMitaConfig(); }                          catch {}
  }
});

// ── Traffic snapshot cron — every 60 s ───────────────────────────────────────
cron.schedule('* * * * *', () => {
  if (!db) return;
  try {
    const raw  = execSync('mita describe users 2>/dev/null', { timeout: 5000 }).toString();
    const live = parseMitaUsers(raw);
    if (!live.length) return;
    const ts   = new Date().toISOString();
    const ins  = db.prepare('INSERT INTO traffic_snapshots (username,uploadMB,downloadMB,ts) VALUES (?,?,?,?)');
    live.forEach(s => ins.run(s.username, s.uploadMB, s.downloadMB, ts));
    live.forEach(s => {
      const u = getUserByUsername(s.username);
      if (u) upsertUser({ ...u, usedMB: s.usedMB, lastSeen: ts, updatedAt: ts });
    });
  } catch {}
});

// ── SPA catch-all ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

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
    `  Panel Naive + Mieru v${cfg.version || '1.2.0'} by RIXXX`,
    `  http://${HOST}:${PORT}/`,
    HOST === '127.0.0.1' ? `  ⚠  SSH-only: ssh -L 3000:127.0.0.1:3000 root@<server>` : '',
    ''
  ];
  lines.forEach(l => console.log(l));
});

module.exports = app;
