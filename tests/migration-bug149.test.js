#!/usr/bin/env node
/* ==============================================================================
 * tests/migration-bug149.test.js — Regression test for BUG-149
 *
 * BUG-149: servers upgraded from v1.2 (where users without an email were stored
 * with email='' under a UNIQUE column) could not create ANY new user — the
 * second empty-email row collided on the UNIQUE constraint, surfacing as a raw
 *   SqliteError: UNIQUE constraint failed: users.email
 * dumped straight into the "add user" modal.
 *
 * This test simulates a real v1.2 database (email TEXT UNIQUE, nullable, with
 * existing '' rows), applies the same startup migration steps used by
 * panel/server/index.js, and asserts that:
 *   1. legacy users survive the migration,
 *   2. legacy '' emails are normalised to NULL,
 *   3. a brand-new user (with and without an email) can be created,
 *   4. a duplicate non-empty email is rejected cleanly (mapped to a 409),
 *   5. multiple email-less users coexist (NULL is exempt from UNIQUE).
 *
 * Run:  node tests/migration-bug149.test.js
 * Exit: 0 = pass, 1 = fail
 * ============================================================================ */
'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Resolve better-sqlite3 from the panel's node_modules.
const Database = require(path.join(__dirname, '..', 'panel', 'node_modules', 'better-sqlite3'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log('  \u2713', msg); pass++; }
  else      { console.error('  \u2717', msg); fail++; }
}

// ── describeDbError: mirrors the helper in panel/server/index.js ─────────────
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

// ── Build a realistic v1.2 database ──────────────────────────────────────────
const DB = path.join(os.tmpdir(), `bug149-${Date.now()}.db`);
function cleanup() { ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(DB + s); } catch {} }); }
cleanup();

console.log('BUG-149 migration regression test');
console.log('  using temp DB:', DB);

const v12 = new Database(DB);
// v1.2 schema: NOTE email is nullable-UNIQUE (notnull=0), exactly the variant
// where the OLD migration (gated on notnull===1) is skipped.
v12.exec(`
  CREATE TABLE users (
    id        TEXT PRIMARY KEY,
    email     TEXT UNIQUE,
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
`);
const now = new Date().toISOString();
const ins12 = v12.prepare(
  `INSERT INTO users (id,email,username,passHash,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`
);
// One real legacy user with an email, plus one email-less legacy user (email='').
ins12.run('legacy-1', 'real@example.com', 'legacy_with_email', 'h', now, now);
ins12.run('legacy-2', '',                 'legacy_no_email',   'h', now, now);
v12.close();

// ── Apply the v1.4.x startup migration (mirrors panel/server/index.js) ───────
const db = new Database(DB);
db.pragma('journal_mode = WAL');

// 1) add password column (upgrade from v1.0.x/v1.2)
try { db.exec(`ALTER TABLE users ADD COLUMN password TEXT NOT NULL DEFAULT ''`); } catch {}

// 2) conditional rebuild only if email is still NOT NULL (skipped for v1.2)
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  const emailCol = cols.find(c => c.name === 'email');
  if (emailCol && emailCol.notnull === 1) {
    // (rebuild path — not exercised by this v1.2 variant)
    db.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE users RENAME TO users_legacy;
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT NOT NULL UNIQUE,
        passHash TEXT NOT NULL, password TEXT NOT NULL DEFAULT '', expiry TEXT,
        protocols TEXT DEFAULT '["naive","mieru"]', quotaMB INTEGER DEFAULT 0,
        usedMB REAL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastSeen TEXT);
      INSERT INTO users (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen)
        SELECT id, CASE WHEN email='' THEN NULL ELSE email END,
               username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen
        FROM users_legacy;
      DROP TABLE users_legacy;
      COMMIT;
    `);
  }
} catch (e) { try { db.exec('ROLLBACK'); } catch {} }

// 3) Bug 149 fix: unconditional '' -> NULL normalisation
const fixed = db.prepare(`UPDATE users SET email = NULL WHERE email = ''`).run();

// ── upsertUser + duplicate pre-check, mirroring index.js ─────────────────────
function getUserByEmail(email) {
  const e = (email && String(email).trim()) ? String(email).trim() : null;
  if (!e) return undefined;
  return db.prepare('SELECT * FROM users WHERE email = ?').get(e);
}
function getUserByUsername(u) { return db.prepare('SELECT * FROM users WHERE username = ?').get(u); }
function upsertUser(u) {
  const email = (u.email && String(u.email).trim()) ? String(u.email).trim() : null;
  db.prepare(`
    INSERT INTO users (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen)
    VALUES (@id,@email,@username,@passHash,@password,@expiry,@protocols,@quotaMB,@usedMB,@createdAt,@updatedAt,@lastSeen)
    ON CONFLICT(id) DO UPDATE SET email=excluded.email, username=excluded.username
  `).run({ ...u, email, password: u.password || '' });
}
// Mirrors the route: pre-check duplicate, map errors to {status,error}.
function createUser({ email, username }) {
  if (getUserByUsername(username)) return { status: 409, error: 'Username already exists' };
  const normEmail = (email && email.trim()) ? email.trim() : null;
  if (normEmail && getUserByEmail(normEmail)) return { status: 409, error: 'Email already in use' };
  const u = { id: 'new-' + username, email: normEmail, username, passHash: 'h', password: '',
              expiry: null, protocols: '[]', quotaMB: 0, usedMB: 0,
              createdAt: now, updatedAt: now, lastSeen: null };
  try { upsertUser(u); return { status: 201, ok: true }; }
  catch (e) { return describeDbError(e); }
}

// ── Assertions ───────────────────────────────────────────────────────────────
console.log('\n[1] legacy data survives + empty emails normalised');
ok(fixed.changes === 1, `normalised exactly 1 legacy empty email -> NULL (got ${fixed.changes})`);
const all = db.prepare('SELECT id,email,username FROM users ORDER BY username').all();
ok(all.length === 2, `both legacy users present (got ${all.length})`);
ok(getUserByUsername('legacy_with_email').email === 'real@example.com', 'real email preserved');
ok(getUserByUsername('legacy_no_email').email === null, 'legacy empty email is now NULL');

console.log('\n[2] creating a NEW user without email works (the core bug)');
const r1 = createUser({ email: '', username: 'brand_new_1' });
ok(r1.status === 201, `new email-less user created (got ${r1.status} ${r1.error || ''})`);
const r2 = createUser({ email: '   ', username: 'brand_new_2' });
ok(r2.status === 201, `second email-less user created — NULL exempt from UNIQUE (got ${r2.status} ${r2.error || ''})`);
const r3 = createUser({ email: undefined, username: 'brand_new_3' });
ok(r3.status === 201, `third email-less user created (got ${r3.status} ${r3.error || ''})`);

console.log('\n[3] creating a NEW user WITH a unique email works');
const r4 = createUser({ email: 'fresh@example.com', username: 'with_email' });
ok(r4.status === 201, `user with unique email created (got ${r4.status} ${r4.error || ''})`);

console.log('\n[4] duplicate email -> clean 409, no raw stacktrace');
const r5 = createUser({ email: 'fresh@example.com', username: 'dup_email_user' });
ok(r5.status === 409, `duplicate email rejected with 409 (got ${r5.status})`);
ok(r5.error === 'Email already in use', `friendly message returned (got "${r5.error}")`);
ok(!/index\.js|SqliteError|\/opt\//.test(String(r5.error)), 'no internal path / SqliteError leaked');

console.log('\n[5] final integrity');
const emails = db.prepare(`SELECT email FROM users WHERE email IS NOT NULL`).all().map(r => r.email);
ok(new Set(emails).size === emails.length, 'all non-null emails remain unique');
ok(db.prepare(`SELECT COUNT(*) c FROM users WHERE email=''`).get().c === 0, "no '' emails remain anywhere");

db.close();
cleanup();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
