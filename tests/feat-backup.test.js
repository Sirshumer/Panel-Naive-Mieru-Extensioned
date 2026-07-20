// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 — FEATURE: Backup (export) / Restore (import).
//
// Disaster recovery: download a single JSON with ALL users (incl. plaintext
// passwords + bcrypt hashes → regenerates the SAME working keys) and the full
// panel config, then restore it on a fresh server. If the new box keeps the
// same domain (DNS points to it), existing client keys keep working untouched.
//
// This test follows the suite's convention (no server boot, no DB): it does
//   (a) structural source checks on panel/server/index.js — endpoints present,
//       auth-gated, format tags, larger JSON body limit, non-destructive path;
//   (b) a standalone simulation of the two logic paths most likely to regress:
//       the export shape and the domain-mode merge on import.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SERVER = path.join(__dirname, '..', 'panel', 'server', 'index.js');
const src = fs.readFileSync(SERVER, 'utf8');

// ── (a) Structural checks ────────────────────────────────────────────────────
ok(/app\.get\(\s*['"]\/api\/backup\/export['"]\s*,\s*requireAuth/.test(src),
   'GET /api/backup/export is registered and auth-gated');
ok(/app\.post\(\s*['"]\/api\/backup\/import['"]\s*,\s*requireAuth/.test(src),
   'POST /api/backup/import is registered and auth-gated');
ok(/const BACKUP_FORMAT\s*=\s*'rixxx-panel-backup'/.test(src),
   'backup format tag is "rixxx-panel-backup"');
ok(/const BACKUP_SCHEMA\s*=\s*1/.test(src),
   'backup schema version is 1');

// Import must reject a wrong format tag / bad schema / missing sections BEFORE
// mutating anything.
const importBody = src.slice(src.indexOf("'/api/backup/import'"));
ok(/bad format tag/.test(importBody),   'import validates the format tag');
ok(/Unsupported backup schema/.test(importBody), 'import validates the schema version');
ok(/missing its config section/.test(importBody), 'import requires a config section');
ok(/missing its users list/.test(importBody),     'import requires a users list');
ok(/malformed user record/.test(importBody),       'import validates each user record');

// Import must go through the SAME rebuild path as normal add/delete.
ok(/applyAllConfigs\(\)/.test(importBody),
   'import rebuilds real configs via applyAllConfigs() (same path as add/delete)');
ok(/upsertUser\(/.test(importBody),
   'import restores users via upsertUser (idempotent, non-destructive)');

// Export must carry the plaintext password (needed to regenerate keys) and the
// bcrypt passHash, plus the full config.
const exportBody = src.slice(src.indexOf("'/api/backup/export'"),
                             src.indexOf("'/api/backup/import'"));
ok(/password:\s*u\.password/.test(exportBody), 'export includes plaintext password (key regen)');
ok(/passHash:\s*u\.passHash/.test(exportBody), 'export includes bcrypt passHash');
ok(/config:\s*cfg/.test(exportBody),           'export includes the full config');
ok(/Content-Disposition/.test(exportBody),     'export sends a file download header');

// Body limit lifted so large backups import.
ok(/express\.json\(\{\s*limit:\s*'25mb'\s*\}\)/.test(src),
   'JSON body limit raised to 25mb for large backup imports');

// ── (b) Logic simulation: export shape ───────────────────────────────────────
function makeExport(cfg, users) {
  return {
    format: 'rixxx-panel-backup',
    schema: 1,
    version: '1.6.0',
    exportedAt: new Date().toISOString(),
    config: cfg,
    users: users.map(u => ({
      id: u.id, email: u.email || null, username: u.username,
      passHash: u.passHash, password: u.password || '',
      expiry: u.expiry || null, protocols: u.protocols || '["naive","mieru"]',
      quotaMB: u.quotaMB || 0, usedMB: u.usedMB || 0,
      createdAt: u.createdAt, updatedAt: u.updatedAt, lastSeen: u.lastSeen || null
    }))
  };
}

const cfgOld = {
  domain: 'old.example.com', serverIp: '10.0.0.1',
  naivePort: 443, mieruPortStart: 2012, mieruPortEnd: 2022,
  adminUser: 'admin', adminPassHash: '$2a$hash', language: 'ru'
};
const usersOld = [
  { id: 'u1', username: 'alice', passHash: '$2a$a', password: 'secretA',
    protocols: '["naive","mieru"]', createdAt: 't0', updatedAt: 't0' },
  { id: 'u2', username: 'bob', passHash: '$2a$b', password: 'secretB',
    protocols: '["mieru"]', createdAt: 't0', updatedAt: 't0' }
];
const backup = makeExport(cfgOld, usersOld);
ok(backup.format === 'rixxx-panel-backup' && backup.schema === 1, 'export shape is tagged');
ok(backup.users.length === 2, 'export carries all users');
ok(backup.users[0].password === 'secretA', 'export preserves plaintext password');
ok(backup.config.domain === 'old.example.com', 'export carries the domain');

// round-trip: JSON serialise/parse must be lossless
const rt = JSON.parse(JSON.stringify(backup));
ok(rt.users[1].protocols === '["mieru"]', 'protocols survive JSON round-trip');

// ── (b) Logic simulation: domain-mode merge on import ────────────────────────
// Mirrors the server's merge: mode 'backup' keeps backup network identity;
// mode 'current' keeps the live server's network identity.
function importMerge(liveCfg, incomingCfg, domainMode) {
  const NETWORK_KEYS = ['domain', 'serverIp', 'naivePort', 'mieruPortStart', 'mieruPortEnd'];
  const PATH_KEYS = ['dbPath', 'caddyBin', 'caddyFile', 'caddyConfigDir', 'fakeSiteDir', 'mitaStateFile'];
  const incoming = { ...incomingCfg };
  if (domainMode === 'current') {
    for (const k of NETWORK_KEYS) if (liveCfg[k] !== undefined) incoming[k] = liveCfg[k];
  }
  incoming.version = liveCfg.version || incoming.version;
  for (const k of PATH_KEYS) if (liveCfg[k] !== undefined) incoming[k] = liveCfg[k];
  return incoming;
}

const liveCfg = {
  domain: 'new-server.example.com', serverIp: '20.0.0.9',
  naivePort: 8443, mieruPortStart: 3000, mieruPortEnd: 3010,
  version: '1.6.0', dbPath: '/var/lib/rixxx-panel/db.sqlite'
};

// mode 'backup' → the RESTORED domain is the backup's (clients unaffected)
const mBackup = importMerge(liveCfg, cfgOld, 'backup');
ok(mBackup.domain === 'old.example.com', "domainMode 'backup' keeps backup domain");
ok(mBackup.naivePort === 443,            "domainMode 'backup' keeps backup naivePort");
ok(mBackup.adminUser === 'admin',        "domainMode 'backup' still restores admin creds");
ok(mBackup.dbPath === '/var/lib/rixxx-panel/db.sqlite',
   "local path (dbPath) is always taken from the live server, never the backup");

// mode 'current' → keep THIS server's domain/ports (new DNS)
const mCurrent = importMerge(liveCfg, cfgOld, 'current');
ok(mCurrent.domain === 'new-server.example.com', "domainMode 'current' keeps live domain");
ok(mCurrent.naivePort === 8443,                  "domainMode 'current' keeps live naivePort");
ok(mCurrent.mieruPortStart === 3000,             "domainMode 'current' keeps live mieru ports");
ok(mCurrent.adminUser === 'admin',               "domainMode 'current' still restores admin creds");
ok(mCurrent.language === 'ru',                    "domainMode 'current' restores non-network settings");

// version is never downgraded by a backup
ok(mBackup.version === '1.6.0' && mCurrent.version === '1.6.0',
   'live version tag is preserved (backup never downgrades it)');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
