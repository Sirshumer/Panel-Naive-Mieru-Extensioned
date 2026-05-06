/**
 * Panel Naive + Mieru by RIXXX — Express backend
 * Endpoints: auth, users CRUD, server settings, client configs,
 *            monitoring (WebSocket), logs, diagnostics.
 */
'use strict';

const express       = require('express');
const session       = require('express-session');
const helmet        = require('helmet');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const bcrypt        = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cron          = require('node-cron');
const http          = require('http');
const { WebSocketServer } = require('ws');
const fs            = require('fs');
const path          = require('path');
const { execSync, exec, spawn } = require('child_process');
const si            = require('systeminformation');

// ── Config paths ──────────────────────────────────────────────────────────────
const PANEL_CONFIG  = '/etc/rixxx-panel/config.json';
const DB_PATH       = '/var/lib/rixxx-panel/db.sqlite';
const CADDYFILE     = '/etc/caddy-naive/Caddyfile';
const MITA_DIR      = '/etc/mita';
const CADDY_BIN     = '/usr/local/bin/caddy-naive';
const LOG_CADDY     = '/var/log/caddy-naive/access.log';
const LOG_PANEL     = '/var/log/panel-naive-mieru.log';

// ── Load system config ────────────────────────────────────────────────────────
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(PANEL_CONFIG, 'utf8'));
} catch {
  cfg = {
    domain: 'localhost', serverIp: '127.0.0.1', adminUser: 'admin',
    adminPassHash: bcrypt.hashSync('admin', 10),
    naivePort: 443, mieruPortStart: 2012, mieruPortEnd: 2022,
    panelPort: 3000, panelHost: '127.0.0.1', exposePanel: false,
    dbPath: DB_PATH, caddyfile: CADDYFILE, mitaConfigDir: MITA_DIR,
    trafficPattern: 'NOOP', mtu: 1350, version: '1.0.0'
  };
}

// ── SQLite DB ─────────────────────────────────────────────────────────────────
let db;
try {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(cfg.dbPath || DB_PATH), { recursive: true });
  db = new Database(cfg.dbPath || DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id        TEXT PRIMARY KEY,
      email     TEXT NOT NULL UNIQUE,
      username  TEXT NOT NULL UNIQUE,
      passHash  TEXT NOT NULL,
      expiry    TEXT,
      protocols TEXT DEFAULT '["naive","mieru"]',
      quotaMB   INTEGER DEFAULT 0,
      usedMB    REAL    DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastSeen  TEXT
    );
    CREATE TABLE IF NOT EXISTS traffic_snapshots (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT NOT NULL,
      uploadMB  REAL DEFAULT 0,
      downloadMB REAL DEFAULT 0,
      ts        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS panel_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
} catch (err) {
  console.error('[DB] SQLite not available:', err.message, '— using in-memory store');
  db = null;
}

// In-memory fallback when DB not available
const memUsers = new Map();

// ── Helper: read/write users ──────────────────────────────────────────────────
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
      INSERT INTO users (id,email,username,passHash,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen)
      VALUES (@id,@email,@username,@passHash,@expiry,@protocols,@quotaMB,@usedMB,@createdAt,@updatedAt,@lastSeen)
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, username=excluded.username, passHash=excluded.passHash,
        expiry=excluded.expiry, protocols=excluded.protocols, quotaMB=excluded.quotaMB,
        usedMB=excluded.usedMB, updatedAt=excluded.updatedAt, lastSeen=excluded.lastSeen
    `).run(u);
  } else {
    memUsers.set(u.id, u);
  }
}

function deleteUser(id) {
  if (db) db.prepare('DELETE FROM users WHERE id = ?').run(id);
  else memUsers.delete(id);
}

// ── Save system config ────────────────────────────────────────────────────────
function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(PANEL_CONFIG), { recursive: true });
    fs.writeFileSync(PANEL_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[CFG] Cannot save config:', err.message);
  }
}

// ── Caddyfile builder ─────────────────────────────────────────────────────────
function buildCaddyfile() {
  const users = getAllUsers();
  const naiveUsers = users.filter(u => {
    const protocols = JSON.parse(u.protocols || '["naive","mieru"]');
    return protocols.includes('naive');
  });

  const authEntries = naiveUsers.map(u => {
    const pass = u.passHash; // already bcrypt'd
    return `      basic_auth ${u.username} ${pass}`;
  }).join('\n');

  const caddyContent = `{
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
${authEntries || '      # no users yet'}
      hide_ip
      hide_via
      probe_resistance
    }
    file_server {
      root /var/www/html
    }
  }
}
${cfg.exposePanel ? `
${cfg.domain}:8080 {
  reverse_proxy 127.0.0.1:3000
}
` : ''}`;

  const tmp = CADDYFILE + '.new';
  fs.writeFileSync(tmp, caddyContent, { mode: 0o644 });
  fs.renameSync(tmp, CADDYFILE);
}

// ── Mieru server.json builder ─────────────────────────────────────────────────
function buildMiteruConfig() {
  const users = getAllUsers();
  const mieruUsers = users.filter(u => {
    const protocols = JSON.parse(u.protocols || '["naive","mieru"]');
    return protocols.includes('mieru');
  });

  const portBindings = [];
  for (let p = cfg.mieruPortStart; p <= cfg.mieruPortEnd; p++) {
    portBindings.push({ port: p, protocol: 'TCP' });
    portBindings.push({ port: p, protocol: 'UDP' });
  }

  const mieruCfg = {
    portBindings,
    users: mieruUsers.map(u => ({
      name: u.username,
      password: [u.passHash]
    })),
    loggingLevel: 'INFO',
    mtu: cfg.mtu || 1350,
    trafficConfig: {
      pattern: cfg.trafficPattern || 'NOOP'
    }
  };

  const filePath = path.join(cfg.mitaConfigDir || MITA_DIR, 'server.json');
  const tmp = filePath + '.new';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(mieruCfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return filePath;
}

// ── Reload services ───────────────────────────────────────────────────────────
function reloadCaddy() {
  try {
    execSync(`${CADDY_BIN} reload --config ${CADDYFILE} --adapter caddyfile --force 2>/dev/null`, { timeout: 10000 });
    return true;
  } catch {
    try { execSync('systemctl reload caddy-naive 2>/dev/null', { timeout: 10000 }); return true; }
    catch { return false; }
  }
}

function reloadMieru() {
  try {
    const cfgFile = path.join(cfg.mitaConfigDir || MITA_DIR, 'server.json');
    execSync(`mita apply config ${cfgFile} 2>/dev/null`, { timeout: 15000 });
    execSync('mita reload 2>/dev/null', { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function restartMieru() {
  try {
    execSync('mita stop 2>/dev/null || true', { timeout: 10000 });
    execSync('mita start 2>/dev/null || systemctl start mita 2>/dev/null', { timeout: 15000 });
    return true;
  } catch { return false; }
}

function shredFile(filePath) {
  try { execSync(`shred -u "${filePath}" 2>/dev/null || rm -f "${filePath}"`, { timeout: 5000 }); }
  catch { try { fs.unlinkSync(filePath); } catch {} }
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:'],
    }
  }
}));
app.use(morgan('combined', { stream: { write: m => fs.appendFileSync(LOG_PANEL, m) } }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Session
let sessionSecret;
const secretFile = path.join(path.dirname(cfg.dbPath || DB_PATH), '.session_secret');
try {
  sessionSecret = fs.readFileSync(secretFile, 'utf8').trim();
} catch {
  sessionSecret = require('crypto').randomBytes(64).toString('hex');
  try { fs.mkdirSync(path.dirname(secretFile), { recursive: true }); fs.writeFileSync(secretFile, sessionSecret, { mode: 0o600 }); }
  catch {}
}

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 86400000 }
}));

// Rate limiting
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts' } });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 200 });
app.use('/api/', apiLimiter);

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/');
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Missing credentials' });

  const isAdmin = username === cfg.adminUser &&
    (bcrypt.compareSync(password, cfg.adminPassHash) ||
     require('crypto').createHash('sha256').update(password).digest('hex') === cfg.adminPassHash);

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

// ── System config API ─────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => {
  const { adminPassHash, ...safe } = cfg;
  res.json(safe);
});

app.post('/api/config', requireAuth, (req, res) => {
  const allowed = ['domain','naivePort','mieruPortStart','mieruPortEnd',
                   'trafficPattern','mtu','adminEmail'];
  allowed.forEach(k => { if (req.body[k] !== undefined) cfg[k] = req.body[k]; });
  saveConfig();
  res.json({ ok: true, cfg: (({ adminPassHash, ...s }) => s)(cfg) });
});

app.post('/api/config/password', requireAuth, (req, res) => {
  const { current, newPass } = req.body;
  if (!current || !newPass) return res.status(400).json({ error: 'Missing fields' });

  const valid = bcrypt.compareSync(current, cfg.adminPassHash) ||
    require('crypto').createHash('sha256').update(current).digest('hex') === cfg.adminPassHash;
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

  cfg.adminPassHash = bcrypt.hashSync(newPass, 12);
  saveConfig();
  res.json({ ok: true });
});

// ── Users API (Sprint 2) ──────────────────────────────────────────────────────
app.get('/api/users', requireAuth, (req, res) => {
  const users = getAllUsers().map(({ passHash, ...u }) => u);
  res.json(users);
});

app.post('/api/users', requireAuth, (req, res) => {
  const { email, username, password, expiry, protocols, quotaMB } = req.body;
  if (!email || !username || !password)
    return res.status(400).json({ error: 'email, username and password are required' });

  if (getUserByUsername(username))
    return res.status(409).json({ error: 'Username already exists' });

  const now = new Date().toISOString();
  const user = {
    id: uuidv4(),
    email, username,
    passHash: bcrypt.hashSync(password, 12),
    expiry: expiry || null,
    protocols: JSON.stringify(protocols || ['naive', 'mieru']),
    quotaMB: quotaMB || 0,
    usedMB: 0,
    createdAt: now,
    updatedAt: now,
    lastSeen: null
  };

  upsertUser(user);

  // Rebuild configs
  try { buildCaddyfile(); reloadCaddy(); } catch (e) { console.error('[CADDY]', e.message); }
  try { buildMiteruConfig(); reloadMieru(); } catch (e) { console.error('[MITA]', e.message); }

  const { passHash, ...safe } = user;
  res.status(201).json(safe);
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { email, username, password, expiry, protocols, quotaMB } = req.body;
  const updated = {
    ...user,
    email:     email     || user.email,
    username:  username  || user.username,
    expiry:    expiry !== undefined ? expiry : user.expiry,
    protocols: protocols ? JSON.stringify(protocols) : user.protocols,
    quotaMB:   quotaMB   !== undefined ? quotaMB : user.quotaMB,
    updatedAt: new Date().toISOString()
  };
  if (password) updated.passHash = bcrypt.hashSync(password, 12);

  upsertUser(updated);

  try { buildCaddyfile(); reloadCaddy(); } catch {}
  try { buildMiteruConfig(); reloadMieru(); } catch {}

  const { passHash, ...safe } = updated;
  res.json(safe);
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  deleteUser(req.params.id);

  try { buildCaddyfile(); reloadCaddy(); } catch {}
  try { buildMiteruConfig(); reloadMieru(); } catch {}

  res.json({ ok: true });
});

// ── Server settings API (Sprint 3) ───────────────────────────────────────────
app.post('/api/settings/naive-port', requireAuth, (req, res) => {
  const { port } = req.body;
  const p = parseInt(port, 10);
  if (!p || p < 1 || p > 65535)
    return res.status(400).json({ error: 'Invalid port (1-65535)' });

  cfg.naivePort = p;
  saveConfig();

  try {
    buildCaddyfile();
    const ok = reloadCaddy();
    res.json({ ok, message: `NaiveProxy port changed to ${p}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/mieru-ports', requireAuth, (req, res) => {
  const { portStart, portEnd } = req.body;
  const s = parseInt(portStart, 10), e = parseInt(portEnd, 10);
  if (!s || !e || s < 1025 || e > 65535 || e < s)
    return res.status(400).json({ error: 'Invalid port range (1025-65535, end >= start)' });

  const oldStart = cfg.mieruPortStart, oldEnd = cfg.mieruPortEnd;
  cfg.mieruPortStart = s; cfg.mieruPortEnd = e;
  saveConfig();

  // UFW: remove old, add new
  try {
    execSync(`ufw delete allow ${oldStart}:${oldEnd}/tcp 2>/dev/null || true`, { timeout: 5000 });
    execSync(`ufw delete allow ${oldStart}:${oldEnd}/udp 2>/dev/null || true`, { timeout: 5000 });
    execSync(`ufw allow ${s}:${e}/tcp comment "Mieru TCP" 2>/dev/null || true`, { timeout: 5000 });
    execSync(`ufw allow ${s}:${e}/udp comment "Mieru UDP" 2>/dev/null || true`, { timeout: 5000 });
  } catch {}

  try {
    buildMiteruConfig();
    const ok = restartMieru();
    res.json({ ok, message: `Mieru ports changed to ${s}-${e}, service restarted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/traffic-pattern', requireAuth, (req, res) => {
  const { pattern, mtu } = req.body;
  const validPatterns = ['NOOP', 'RANDOM_PADDING', 'RANDOM_PADDING_AGGRESSIVE', 'CUSTOM'];
  if (!validPatterns.includes(pattern))
    return res.status(400).json({ error: 'Invalid pattern. Use: ' + validPatterns.join(', ') });

  if (mtu !== undefined) {
    const m = parseInt(mtu, 10);
    if (m < 1280 || m > 1400)
      return res.status(400).json({ error: 'MTU must be 1280-1400' });
    cfg.mtu = m;
  }

  cfg.trafficPattern = pattern;
  saveConfig();

  try {
    buildMiteruConfig();
    const ok = reloadMieru();
    res.json({ ok, pattern, mtu: cfg.mtu });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Client config downloads (Sprint 4) ────────────────────────────────────────

// Naive link: naive+https://username:password@domain:port
app.get('/api/users/:id/naive-link', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // We need the plain password — request it as query param for download
  const password = req.query.password || 'YOUR_PASSWORD';
  const link = `naive+https://${user.username}:${encodeURIComponent(password)}@${cfg.domain}:${cfg.naivePort}`;
  res.json({ link, username: user.username });
});

// Mieru sing-box JSON
app.get('/api/users/:id/mieru-config', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const password = req.query.password || 'YOUR_PASSWORD';
  const singboxConfig = {
    log: { level: 'info', timestamp: true },
    outbounds: [
      {
        type: 'mieru',
        tag: 'mieru-out',
        server: cfg.serverIp || cfg.domain,
        server_port: cfg.mieruPortStart,
        username: user.username,
        password,
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
  res.json(singboxConfig);
});

// Universal config: Naive + Mieru with urltest auto-fallback
app.get('/api/users/:id/universal-config', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const password = req.query.password || 'YOUR_PASSWORD';
  const universalConfig = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', address: 'tls://8.8.8.8', detour: 'select' },
        { tag: 'local',  address: 'https://223.5.5.5/dns-query', detour: 'direct' }
      ],
      rules: [{ outbound: 'any', server: 'local' }],
      final: 'remote'
    },
    outbounds: [
      {
        type: 'urltest',
        tag: 'select',
        outbounds: ['naive-out', 'mieru-out'],
        url: 'https://www.gstatic.com/generate_204',
        interval: '3m',
        tolerance: 50
      },
      {
        type: 'http',
        tag: 'naive-out',
        server: cfg.domain,
        server_port: cfg.naivePort,
        username: user.username,
        password,
        tls: { enabled: true, server_name: cfg.domain }
      },
      {
        type: 'mieru',
        tag: 'mieru-out',
        server: cfg.serverIp || cfg.domain,
        server_port: cfg.mieruPortStart,
        username: user.username,
        password,
        protocol: 'TCP',
        multiplex: { enabled: false }
      },
      { type: 'direct', tag: 'direct' },
      { type: 'dns',    tag: 'dns-out' }
    ],
    route: {
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { geoip: 'cn', outbound: 'direct' },
        { geosite: 'cn', outbound: 'direct' }
      ],
      final: 'select',
      auto_detect_interface: true
    }
  };

  const filename = `universal-${user.username}-${cfg.domain}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(universalConfig);
});

// ── Status / monitoring API (Sprint 5) ────────────────────────────────────────
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const [cpu, mem, disk, osInfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.osInfo()
    ]);

    const naiveActive  = execSafe('systemctl is-active caddy-naive') === 'active';
    const mieruActive  = execSafe('systemctl is-active mita')        === 'active';
    const panelActive  = execSafe('pm2 jlist 2>/dev/null | python3 -c "import sys,json; procs=json.load(sys.stdin); print(next((p[\'pm2_env\'][\'status\'] for p in procs if p[\'name\']==\'panel-naive-mieru\'), \'stopped\'))" 2>/dev/null') || 'unknown';

    const userCount = getAllUsers().length;
    const uptime    = Math.floor(process.uptime());

    res.json({
      services: {
        naive: { active: naiveActive, version: execSafe(`${CADDY_BIN} version 2>/dev/null | head -1`) },
        mieru: { active: mieruActive, version: execSafe('mita version 2>/dev/null | head -1') },
        panel: { active: true }
      },
      system: {
        cpuPercent:  Math.round(cpu.currentLoad),
        ramUsedMB:   Math.round((mem.total - mem.available) / 1048576),
        ramTotalMB:  Math.round(mem.total / 1048576),
        diskUsedGB:  disk.length ? Math.round(disk[0].used / 1073741824) : 0,
        diskTotalGB: disk.length ? Math.round(disk[0].size / 1073741824) : 0,
        uptime,
        os: osInfo.distro + ' ' + osInfo.release,
        arch: osInfo.arch
      },
      panel: { userCount, version: cfg.version || '1.0.0' },
      domain: cfg.domain,
      serverIp: cfg.serverIp
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mieru user stats from `mita describe users`
app.get('/api/stats/users', requireAuth, (req, res) => {
  try {
    const raw = execSync('mita describe users 2>/dev/null', { timeout: 10000 }).toString();
    const stats = parseMitaUsers(raw);

    // Merge with DB users
    const dbUsers = getAllUsers();
    const merged = dbUsers.map(u => {
      const s = stats.find(x => x.username === u.username) || {};
      return {
        username: u.username,
        email: u.email,
        expiry: u.expiry,
        protocols: JSON.parse(u.protocols || '[]'),
        quotaMB: u.quotaMB,
        usedMB: s.usedMB || u.usedMB || 0,
        uploadMB: s.uploadMB || 0,
        downloadMB: s.downloadMB || 0,
        lastSeen: u.lastSeen
      };
    });

    res.json(merged);
  } catch (err) {
    // Return DB data without live stats
    const users = getAllUsers().map(({ passHash, ...u }) => ({
      ...u,
      protocols: JSON.parse(u.protocols || '[]'),
      uploadMB: 0, downloadMB: 0
    }));
    res.json(users);
  }
});

// Parse mita describe users output
function parseMitaUsers(raw) {
  const users = [];
  const lines = raw.split('\n');
  let current = null;
  for (const line of lines) {
    const nameMatch = line.match(/username[:\s]+(\S+)/i);
    if (nameMatch) {
      if (current) users.push(current);
      current = { username: nameMatch[1], uploadMB: 0, downloadMB: 0, usedMB: 0 };
    }
    if (current) {
      const upMatch   = line.match(/upload[:\s]+([\d.]+)\s*(MB|GB|KB)/i);
      const downMatch = line.match(/download[:\s]+([\d.]+)\s*(MB|GB|KB)/i);
      if (upMatch)   current.uploadMB   = toMB(parseFloat(upMatch[1]), upMatch[2]);
      if (downMatch) current.downloadMB = toMB(parseFloat(downMatch[1]), downMatch[2]);
    }
  }
  if (current) users.push(current);
  users.forEach(u => { u.usedMB = u.uploadMB + u.downloadMB; });
  return users;
}

function toMB(val, unit) {
  switch (unit.toUpperCase()) {
    case 'KB': return val / 1024;
    case 'GB': return val * 1024;
    default:   return val;
  }
}

// ── Logs API ──────────────────────────────────────────────────────────────────
app.get('/api/logs/:service', requireAuth, (req, res) => {
  const { service } = req.params;
  const lines = parseInt(req.query.lines || '100', 10);
  let cmd;
  switch (service) {
    case 'caddy':  cmd = `journalctl -u caddy-naive -n ${lines} --no-pager 2>/dev/null || tail -n ${lines} ${LOG_CADDY} 2>/dev/null`; break;
    case 'mieru':  cmd = `journalctl -u mita -n ${lines} --no-pager 2>/dev/null || mita describe log 2>/dev/null`; break;
    case 'panel':  cmd = `tail -n ${lines} ${LOG_PANEL} 2>/dev/null`; break;
    default: return res.status(400).json({ error: 'Unknown service' });
  }
  try {
    const out = execSync(cmd, { timeout: 5000 }).toString();
    res.json({ logs: out });
  } catch {
    res.json({ logs: '(no logs available)' });
  }
});

// ── Diagnostics API ───────────────────────────────────────────────────────────
app.get('/api/diagnostics', requireAuth, async (req, res) => {
  const results = {};

  // Port checks
  results.ports = {
    naive: checkPort(cfg.naivePort),
    mieru: checkPort(cfg.mieruPortStart)
  };

  // Caddy config validate
  try {
    execSync(`${CADDY_BIN} validate --config ${CADDYFILE} --adapter caddyfile 2>&1`, { timeout: 5000 });
    results.caddyConfigValid = true;
  } catch (err) {
    results.caddyConfigValid = false;
    results.caddyConfigError = err.stdout?.toString() || err.message;
  }

  // Mita status
  results.mitaStatus = execSafe('mita status 2>/dev/null');

  // mita describe config
  try {
    const raw = execSync('mita describe config 2>/dev/null', { timeout: 5000 }).toString();
    results.mitaConfig = raw;
  } catch { results.mitaConfig = null; }

  res.json(results);
});

function checkPort(port) {
  try {
    const out = execSync(`ss -tlnup sport = :${port} 2>/dev/null | grep -c :${port}`, { timeout: 3000 }).toString().trim();
    return parseInt(out, 10) > 0;
  } catch { return false; }
}

// ── Service control API ───────────────────────────────────────────────────────
app.post('/api/service/:name/:action', requireAuth, (req, res) => {
  const { name, action } = req.params;
  const validServices = ['caddy-naive', 'mita'];
  const validActions  = ['start', 'stop', 'restart', 'reload'];

  if (!validServices.includes(name)) return res.status(400).json({ error: 'Unknown service' });
  if (!validActions.includes(action))  return res.status(400).json({ error: 'Unknown action' });

  try {
    execSync(`systemctl ${action} ${name} 2>&1`, { timeout: 15000 });
    res.json({ ok: true, service: name, action });
  } catch (err) {
    res.status(500).json({ error: err.stdout?.toString() || err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function execSafe(cmd) {
  try { return execSync(cmd, { timeout: 5000 }).toString().trim(); }
  catch { return ''; }
}

// ── WebSocket: real-time metrics (Sprint 5) ────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Simple session check via cookie header (basic)
  console.log('[WS] Client connected from', req.socket.remoteAddress);

  let interval;

  const sendMetrics = async () => {
    if (ws.readyState !== ws.OPEN) return clearInterval(interval);
    try {
      const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
      const naiveActive = execSafe('systemctl is-active caddy-naive') === 'active';
      const mieruActive = execSafe('systemctl is-active mita') === 'active';

      ws.send(JSON.stringify({
        type: 'metrics',
        ts: Date.now(),
        cpu: Math.round(cpu.currentLoad),
        ramUsedMB:  Math.round((mem.total - mem.available) / 1048576),
        ramTotalMB: Math.round(mem.total / 1048576),
        naive: naiveActive,
        mieru: mieruActive
      }));
    } catch {}
  };

  interval = setInterval(sendMetrics, 5000);
  sendMetrics();

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {}
  });

  ws.on('close',  () => clearInterval(interval));
  ws.on('error', () => clearInterval(interval));
});

// ── Expiry cron (every 5 min) — Sprint 2 ─────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  const now = new Date().toISOString();
  const users = getAllUsers();
  let changed = false;

  for (const user of users) {
    if (user.expiry && user.expiry < now) {
      console.log('[CRON] Removing expired user:', user.username);
      deleteUser(user.id);
      changed = true;
    }
  }

  if (changed) {
    try { buildCaddyfile(); reloadCaddy(); } catch {}
    try { buildMiteruConfig(); reloadMieru(); } catch {}
  }
});

// ── Traffic snapshot cron (every 60 s) ────────────────────────────────────────
cron.schedule('* * * * *', () => {
  if (!db) return;
  try {
    const raw = execSync('mita describe users 2>/dev/null', { timeout: 5000 }).toString();
    const stats = parseMitaUsers(raw);
    const ts = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO traffic_snapshots (username,uploadMB,downloadMB,ts) VALUES (?,?,?,?)'
    );
    stats.forEach(s => insert.run(s.username, s.uploadMB, s.downloadMB, ts));

    // Update usedMB on user record
    stats.forEach(s => {
      const user = getUserByUsername(s.username);
      if (user) {
        upsertUser({ ...user, usedMB: s.usedMB, lastSeen: ts, updatedAt: ts });
      }
    });
  } catch {}
});

// ── Catch-all: serve SPA ──────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Start server ──────────────────────────────────────────────────────────────
const HOST = process.env.PANEL_HOST || cfg.panelHost || '127.0.0.1';
const PORT = parseInt(process.env.PANEL_PORT || String(cfg.panelPort || 3000), 10);

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ██████╗  ██╗ ██╗  ██╗ ██╗  ██╗ ██╗  ██╗');
  console.log('  ██╔══██╗ ██║ ╚██╗██╔╝ ╚██╗██╔╝ ╚██╗██╔╝');
  console.log('  ██████╔╝ ██║  ╚███╔╝   ╚███╔╝   ╚███╔╝ ');
  console.log('  ██╔══██╗ ██║  ██╔██╗   ██╔██╗   ██╔██╗ ');
  console.log('  ██║  ██║ ██║ ██╔╝ ██╗ ██╔╝ ██╗ ██╔╝ ██╗');
  console.log('  ╚═╝  ╚═╝ ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝');
  console.log('');
  console.log(`  Panel Naive + Mieru v${cfg.version || '1.0.0'} by RIXXX`);
  console.log(`  Listening on http://${HOST}:${PORT}/`);
  if (HOST === '127.0.0.1') {
    console.log(`  ⚠  SSH-only mode — use: ssh -L 3000:127.0.0.1:3000 root@<server>`);
  }
  console.log('');
});

module.exports = app;
