/**
 * Panel Naive + Mieru by RIXXX — Express backend  v1.0.0
 * Node.js 20 LTS + Express + better-sqlite3 + WebSocket + node-cron
 *
 * IMPORTANT: Mieru (mita) uses an internal protobuf config store at /etc/mita/.
 * JSON is NEVER written there directly. Instead, the panel:
 *   1. Builds a complete JSON state file at MITA_STATE_FILE
 *   2. Applies it via: mita apply config <file>
 *   3. Reloads without dropping connections: mita reload
 *   4. Full restart (port changes only): mita stop && mita start
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
const CADDYFILE       = '/etc/caddy-naive/Caddyfile';
// Panel-owned JSON applied via `mita apply config <file>` (NOT /etc/mita/ directly)
const MITA_STATE_FILE = '/var/lib/rixxx-panel/mita-state.json';
const CADDY_BIN       = '/usr/local/bin/caddy-naive';
const LOG_CADDY       = '/var/log/caddy-naive/access.log';
const LOG_PANEL       = '/var/log/panel-naive-mieru.log';

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
    dbPath: DB_PATH, caddyfile: CADDYFILE,
    mitaStateFile: MITA_STATE_FILE,
    trafficPattern: 'NOOP', mtu: 1350,
    language: 'ru', version: '1.0.0'
  };
}

// Resolved paths (prefer config values, fall back to constants)
const resolvedDb       = cfg.dbPath        || DB_PATH;
const resolvedMitaFile = cfg.mitaStateFile || MITA_STATE_FILE;
const resolvedCaddy    = cfg.caddyfile     || CADDYFILE;

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

// ── Caddyfile builder (full rebuild each call) ────────────────────────────────
function buildCaddyfile() {
  const allUsers = getAllUsers();
  const naiveUsers = allUsers.filter(u => {
    const p = JSON.parse(u.protocols || '["naive","mieru"]');
    return p.includes('naive');
  });

  // basic_auth entries: username bcrypt-hash  (caddy forward_proxy format)
  const authLines = naiveUsers.map(u => `      basic_auth ${u.username} ${u.passHash}`).join('\n');

  const content = `{
  order forward_proxy before file_server
  admin off
  log {
    output file /var/log/caddy-naive/access.log {
      roll_size 50mb
      roll_keep 5
    }
  }
}

:${cfg.naivePort}, ${cfg.domain}:${cfg.naivePort} {
  tls ${cfg.adminEmail || 'admin@example.com'}
  route {
    forward_proxy {
${authLines || '      # no users configured yet'}
      hide_ip
      hide_via
      probe_resistance
    }
    file_server {
      root /var/www/html
    }
  }
}
${cfg.exposePanel ? `\n${cfg.domain}:8080 {\n  reverse_proxy 127.0.0.1:3000\n}\n` : ''}`;

  const tmp = resolvedCaddy + '.new';
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, resolvedCaddy);          // atomic replace
}

// ── Mieru state JSON builder (FULL user list — mita apply replaces everything) ─
function buildMitaStateFile() {
  const allUsers = getAllUsers();
  const mieruUsers = allUsers.filter(u => {
    const p = JSON.parse(u.protocols || '["naive","mieru"]');
    return p.includes('mieru');
  });

  const portBindings = [];
  for (let p = cfg.mieruPortStart; p <= cfg.mieruPortEnd; p++) {
    portBindings.push({ port: p, protocol: 'TCP' });
    portBindings.push({ port: p, protocol: 'UDP' });
  }

  // Mieru server JSON schema:
  //   users[].name     = username
  //   users[].password = plain-text password array (mita hashes internally)
  // NOTE: we store the plain password in the 'password' column specifically for this
  const mieruCfg = {
    portBindings,
    users: mieruUsers.map(u => ({
      name: u.username,
      password: [u.password || '']   // plain text — mita hashes on apply
    })),
    loggingLevel: 'INFO',
    mtu: cfg.mtu || 1350,
    trafficConfig: { pattern: cfg.trafficPattern || 'NOOP' }
  };

  fs.mkdirSync(path.dirname(resolvedMitaFile), { recursive: true });
  const tmp = resolvedMitaFile + '.new';
  fs.writeFileSync(tmp, JSON.stringify(mieruCfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, resolvedMitaFile);       // atomic replace

  // Shred the old backup if present (security)
  shredFile(resolvedMitaFile + '.last');
  try { fs.copyFileSync(resolvedMitaFile, resolvedMitaFile + '.last'); } catch {}

  return resolvedMitaFile;
}

// ── Service helpers ───────────────────────────────────────────────────────────
function reloadCaddy() {
  // Reload without service restart (no connection drop)
  try {
    execSync(`${CADDY_BIN} reload --config ${resolvedCaddy} --adapter caddyfile --force 2>/dev/null`, { timeout: 10000 });
    return true;
  } catch {
    try { execSync('systemctl reload caddy-naive 2>/dev/null', { timeout: 10000 }); return true; }
    catch { return false; }
  }
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
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc:     ["'self'", 'data:'],
    }
  }
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

  const sha256 = s => require('crypto').createHash('sha256').update(s).digest('hex');
  const isAdmin =
    username === cfg.adminUser && (
      bcrypt.compareSync(password, cfg.adminPassHash) ||
      sha256(password) === cfg.adminPassHash
    );

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
   'trafficPattern','mtu','adminEmail','language'].forEach(k => {
    if (req.body[k] !== undefined) cfg[k] = req.body[k];
  });
  saveConfig();
  const { adminPassHash, ...safe } = cfg;
  res.json({ ok: true, cfg: safe });
});

app.post('/api/config/password', requireAuth, (req, res) => {
  const { current, newPass } = req.body;
  if (!current || !newPass) return res.status(400).json({ error: 'Missing fields' });
  const sha256 = s => require('crypto').createHash('sha256').update(s).digest('hex');
  const valid =
    bcrypt.compareSync(current, cfg.adminPassHash) ||
    sha256(current) === cfg.adminPassHash;
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
  cfg.adminPassHash = bcrypt.hashSync(newPass, 12);
  saveConfig();
  res.json({ ok: true });
});

// ── Users API ─────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, (req, res) => {
  // Never expose passHash or plain password
  const users = getAllUsers().map(({ passHash, password, ...u }) => u);
  res.json(users);
});

app.post('/api/users', requireAuth, (req, res) => {
  const { email, username, password, expiry, protocols, quotaMB } = req.body;
  if (!email || !username || !password)
    return res.status(400).json({ error: 'email, username and password are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (getUserByUsername(username))
    return res.status(409).json({ error: 'Username already exists' });

  const now  = new Date().toISOString();
  const user = {
    id:        uuidv4(),
    email, username,
    passHash:  bcrypt.hashSync(password, 12),  // for Caddy basic_auth
    password,                                   // plain text for mita apply config
    expiry:    expiry || null,
    protocols: JSON.stringify(protocols || ['naive', 'mieru']),
    quotaMB:   quotaMB || 0,
    usedMB:    0,
    createdAt: now, updatedAt: now, lastSeen: null
  };
  upsertUser(user);

  // Rebuild both configs atomically
  try { buildCaddyfile(); reloadCaddy(); }   catch (e) { console.error('[CADDY]', e.message); }
  try { applyMitaConfig(); }                 catch (e) { console.error('[MITA]',  e.message); }

  const { passHash, password: _p, ...safe } = user;
  res.status(201).json(safe);
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { email, username, password, expiry, protocols, quotaMB } = req.body;
  const updated = {
    ...user,
    email:     email     ?? user.email,
    username:  username  ?? user.username,
    expiry:    expiry    !== undefined ? expiry : user.expiry,
    protocols: protocols ? JSON.stringify(protocols) : user.protocols,
    quotaMB:   quotaMB   !== undefined ? quotaMB : user.quotaMB,
    updatedAt: new Date().toISOString()
  };
  if (password) {
    updated.passHash = bcrypt.hashSync(password, 12);
    updated.password = password;
  }
  upsertUser(updated);

  try { buildCaddyfile(); reloadCaddy(); }  catch {}
  try { applyMitaConfig(); }                catch {}

  const { passHash, password: _p, ...safe } = updated;
  res.json(safe);
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  deleteUser(req.params.id);
  try { buildCaddyfile(); reloadCaddy(); }  catch {}
  try { applyMitaConfig(); }                catch {}
  res.json({ ok: true });
});

// ── Server settings — Sprint 3 ────────────────────────────────────────────────

// Naive port: Caddy reload only (no service restart)
app.post('/api/settings/naive-port', requireAuth, (req, res) => {
  const p = parseInt(req.body.port, 10);
  if (!p || p < 1 || p > 65535)
    return res.status(400).json({ error: 'Invalid port (1–65535)' });
  cfg.naivePort = p; saveConfig();
  try {
    buildCaddyfile();
    const ok = reloadCaddy();
    // Notify: clients need new configs
    res.json({ ok, message: `NaiveProxy port changed to ${p}. Clients must download new configs.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mieru ports: UFW update + FULL restart (required for port range change)
app.post('/api/settings/mieru-ports', requireAuth, (req, res) => {
  const s = parseInt(req.body.portStart, 10);
  const e = parseInt(req.body.portEnd,   10);
  if (!s || !e || s < 1025 || e > 65535 || e < s)
    return res.status(400).json({ error: 'Invalid port range (1025–65535, end ≥ start)' });

  const oldS = cfg.mieruPortStart, oldE = cfg.mieruPortEnd;
  cfg.mieruPortStart = s; cfg.mieruPortEnd = e; saveConfig();

  // UFW: remove old rules, add new (ignore if UFW not active)
  try {
    execSync(`ufw delete allow ${oldS}:${oldE}/tcp 2>/dev/null || true`, { timeout: 5000 });
    execSync(`ufw delete allow ${oldS}:${oldE}/udp 2>/dev/null || true`, { timeout: 5000 });
    execSync(`ufw allow ${s}:${e}/tcp comment "Mieru TCP" 2>/dev/null || true`, { timeout: 5000 });
    execSync(`ufw allow ${s}:${e}/udp comment "Mieru UDP" 2>/dev/null || true`, { timeout: 5000 });
  } catch {}

  // Full restart required for port binding changes
  try {
    const ok = restartMieru();
    res.json({ ok, message: `Mieru ports changed to ${s}–${e}. Service restarted. Clients must download new configs.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Traffic pattern + MTU: mita reload (no restart needed)
app.post('/api/settings/traffic-pattern', requireAuth, (req, res) => {
  const validPatterns = ['NOOP', 'RANDOM_PADDING', 'RANDOM_PADDING_AGGRESSIVE', 'CUSTOM'];
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
    const ok = applyMitaConfig();   // apply + reload (no restart)
    res.json({ ok, pattern, mtu: cfg.mtu });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Client configs — Sprint 4 ─────────────────────────────────────────────────

// Naive link: naive+https://user:pass@domain:port
app.get('/api/users/:id/naive-link', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';
  const link = `naive+https://${user.username}:${encodeURIComponent(password)}@${cfg.domain}:${cfg.naivePort}`;
  res.json({ link, username: user.username });
});

// Mieru sing-box JSON
app.get('/api/users/:id/mieru-config', requireAuth, (req, res) => {
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

// Universal config: Naive + Mieru + urltest auto-fallback
app.get('/api/users/:id/universal-config', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';

  const universalCfg = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', address: 'tls://8.8.8.8',                    detour: 'select' },
        { tag: 'local',  address: 'https://223.5.5.5/dns-query',       detour: 'direct' }
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
        { protocol: 'dns',  outbound: 'dns-out' },
        { geoip: 'cn',      outbound: 'direct'  },
        { geosite: 'cn',    outbound: 'direct'  }
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

// ── Monitoring — Sprint 5 ─────────────────────────────────────────────────────
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const [cpu, mem, disk, osInfo] = await Promise.all([
      si.currentLoad(), si.mem(), si.fsSize(), si.osInfo()
    ]);
    const exec_ = cmd => { try { return execSync(cmd, { timeout: 3000 }).toString().trim(); } catch { return ''; } };

    res.json({
      services: {
        naive: { active: exec_('systemctl is-active caddy-naive') === 'active',
                 version: exec_(`${CADDY_BIN} version 2>/dev/null | head -1`) },
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
      panel:    { userCount: getAllUsers().length, version: cfg.version || '1.0.0' },
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

// Parse `mita describe users` output (format may change between mita versions)
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
    case 'caddy': cmd = `journalctl -u caddy-naive -n ${lines} --no-pager 2>/dev/null || tail -n ${lines} ${LOG_CADDY} 2>/dev/null`; break;
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
    try { return parseInt(execSync(`ss -tlnup sport = :${p} 2>/dev/null | grep -c :${p}`, { timeout: 3000 }).toString().trim(), 10) > 0; }
    catch { return false; }
  };

  let caddyValid = false, caddyErr = '';
  try { execSync(`${CADDY_BIN} validate --config ${resolvedCaddy} --adapter caddyfile 2>&1`, { timeout: 6000 }); caddyValid = true; }
  catch (e) { caddyErr = e.stdout?.toString() || e.message; }

  res.json({
    ports:           { naive: chkPort(cfg.naivePort), mieru: chkPort(cfg.mieruPortStart) },
    caddyConfigValid: caddyValid,
    caddyConfigError: caddyErr || null,
    mitaStatus:       exec_('mita status 2>/dev/null'),
    mitaConfig:       exec_('mita describe config 2>/dev/null'),
    timeSynced:       exec_('timedatectl status 2>/dev/null').includes('synchronized: yes'),
    mitaStateFile:    resolvedMitaFile
  });
});

// ── Service control ───────────────────────────────────────────────────────────
app.post('/api/service/:name/:action', requireAuth, (req, res) => {
  const { name, action } = req.params;
  if (!['caddy-naive','mita'].includes(name))    return res.status(400).json({ error: 'Unknown service' });
  if (!['start','stop','restart','reload'].includes(action)) return res.status(400).json({ error: 'Unknown action' });
  try {
    execSync(`systemctl ${action} ${name} 2>&1`, { timeout: 15000 });
    res.json({ ok: true, service: name, action });
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
    try { buildCaddyfile(); reloadCaddy(); }  catch {}
    try { applyMitaConfig(); }                catch {}
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
    `  Panel Naive + Mieru v${cfg.version || '1.0.0'} by RIXXX`,
    `  http://${HOST}:${PORT}/`,
    HOST === '127.0.0.1' ? `  ⚠  SSH-only: ssh -L 3000:127.0.0.1:3000 root@<server>` : '',
    ''
  ];
  lines.forEach(l => console.log(l));
});

module.exports = app;
