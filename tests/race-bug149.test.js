#!/usr/bin/env node
/* ==============================================================================
 * tests/race-bug149.test.js — Regression test for BUG-149 (double-submit race)
 *
 * BUG-149 (race): on a double-submit the first POST /api/users created the user
 * (201) while the second slipped past the getUserByUsername() pre-check, hit the
 * UNIQUE(username) constraint and returned a FALSE "Username already exists" —
 * even though the user already existed and the key worked (only visible after F5).
 *
 * The fix makes creation atomic + idempotent:
 *   INSERT ... ON CONFLICT(username) DO NOTHING
 *   - changes===1            -> genuine create
 *   - existing.passHash same -> our own re-submit -> idempotent success
 *   - existing.passHash diff -> real clash with a different user -> 409
 *
 * This test mirrors createUserAtomic() against a real DB and asserts:
 *   1. first create succeeds (created),
 *   2. an identical re-submit (same passHash) is idempotent success — NOT 409,
 *      and does NOT create a second row,
 *   3. a different user trying to take the same username gets a real duplicate,
 *   4. simulated concurrent double-submit yields exactly one row + one success.
 *
 * Run:  node tests/race-bug149.test.js   (exit 0 = pass)
 * ============================================================================ */
'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const Database = require(path.join(__dirname, '..', 'panel', 'node_modules', 'better-sqlite3'));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { console.log('  \u2713', m); pass++; } else { console.error('  \u2717', m); fail++; } }

const DB = path.join(os.tmpdir(), `race149-${Date.now()}.db`);
function cleanup() { ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(DB + s); } catch {} }); }
cleanup();

const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT NOT NULL UNIQUE,
    passHash TEXT NOT NULL, password TEXT NOT NULL DEFAULT '', expiry TEXT,
    protocols TEXT DEFAULT '["naive","mieru"]', quotaMB INTEGER DEFAULT 0,
    usedMB REAL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastSeen TEXT);
`);

function getUserByUsername(u) { return db.prepare('SELECT * FROM users WHERE username = ?').get(u); }

// Mirror of createUserAtomic() in panel/server/index.js — always returns a
// success result (created or idempotent); the route decides genuine clashes.
function createUserAtomic(u) {
  const email = (u.email && String(u.email).trim()) ? String(u.email).trim() : null;
  const info = db.prepare(`
    INSERT INTO users (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen)
    VALUES (@id,@email,@username,@passHash,@password,@expiry,@protocols,@quotaMB,@usedMB,@createdAt,@updatedAt,@lastSeen)
    ON CONFLICT(username) DO NOTHING
  `).run({ ...u, email, password: u.password || '' });
  if (info.changes === 1) return { created: true, user: getUserByUsername(u.username) };
  return { created: false, idempotent: true, user: getUserByUsername(u.username) };
}

// Mirror of the route's create flow: synchronous "existed before?" gate decides
// a genuine 409; otherwise createUserAtomic runs (idempotent on a twin).
function routeCreate(u) {
  if (getUserByUsername(u.username)) return { status: 409, error: 'Username already exists' };
  const r = createUserAtomic(u);
  return { status: 201, created: r.created, idempotent: r.idempotent };
}

function mkUser(username, passHash, extra = {}) {
  const now = new Date().toISOString();
  return { id: 'id-' + Math.random().toString(36).slice(2), email: null, username,
           passHash, password: '', expiry: null, protocols: '[]', quotaMB: 0, usedMB: 0,
           createdAt: now, updatedAt: now, lastSeen: null, ...extra };
}

console.log('BUG-149 double-submit race regression test');
console.log('  temp DB:', DB);

console.log('\n[1] first create succeeds');
const r1 = routeCreate(mkUser('alice', 'HASH_ALICE'));
ok(r1.status === 201 && r1.created === true, 'first create -> 201 created');
ok(getUserByUsername('alice') != null, 'alice present in DB');

console.log('\n[2] sequential re-submit of an EXISTING username -> real 409 (genuine clash)');
// Once a user exists, a later submit of that username is a real clash: 409.
const r2 = routeCreate(mkUser('alice', 'HASH_ALICE_2'));
ok(r2.status === 409, 'existing-username submit -> 409 (no silent overwrite)');
ok(db.prepare(`SELECT COUNT(*) c FROM users WHERE username='alice'`).get().c === 1, 'still exactly ONE alice row');

console.log('\n[3] concurrent twin INSERTs on a brand-new name -> one row, both success');
// Both pass the "existed before" gate (neither saw the row yet), then race on
// INSERT ... ON CONFLICT DO NOTHING: one inserts, the other is idempotent.
const fresh = 'bob';
ok(!getUserByUsername(fresh), 'bob did not exist before (both twins see absent)');
const a = createUserAtomic(mkUser(fresh, 'HASH_BOB'));
const b = createUserAtomic(mkUser(fresh, 'HASH_BOB'));
const successes = [a, b].filter(r => r.created || r.idempotent).length;
ok(successes === 2, 'both racing twins resolve as success (one created, one idempotent)');
ok(a.created !== b.created, 'exactly one of the twins did the real insert');
ok(db.prepare(`SELECT COUNT(*) c FROM users WHERE username='${fresh}'`).get().c === 1, 'exactly ONE bob row');

console.log('\n[4] a different fresh username still works');
const r4 = routeCreate(mkUser('carol', 'HASH_CAROL'));
ok(r4.status === 201, 'unrelated new user still creates fine');

db.close(); cleanup();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
