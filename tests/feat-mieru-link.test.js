// ─────────────────────────────────────────────────────────────────────────────
// v1.5.9 — FEATURE: Mieru share-link export (mierus://) for routers.
//
// Feature request: export a user's Mieru config not only as a sing-box JSON file
// but also as a single copy-paste share link, for Keenetic / OpenWRT routers,
// in the canonical form:
//
//   mierus://user:pass@host?profile=default&port=443&protocol=TCP
//
// This is the plain-text share form consumed by real mieru router clients and by
// reference tooling like hoaxisr/awg-manager (parseMieruSimple / encodeMieru).
//
// This test validates the PURE link builder (buildMierusLink) extracted from
// panel/server/index.js — no server boot, no DB — matching the rest of the suite.
// It guards the round-trip rules that matter for router parsers:
//   • scheme is exactly `mierus`
//   • userinfo carries BOTH username and password
//   • `profile` is present (=default)
//   • EACH port is paired with its OWN `protocol` (awg-manager issue #516)
//   • multiplexing level is carried through
//   • userinfo + query values are percent-encoded (odd passwords stay valid)
//   • the whole thing parses back with the WHATWG URL parser
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SERVER = path.join(__dirname, '..', 'panel', 'server', 'index.js');
const src = fs.readFileSync(SERVER, 'utf8');

// ── Extract the buildMierusLink function definition and eval it in isolation ──
// (Pure string builder, no external references beyond encodeURIComponent.)
const m = src.match(/function buildMierusLink\s*\([\s\S]*?\n\}/);
ok(!!m, 'buildMierusLink() function is present in server source');

let buildMierusLink;
if (m) {
  // eslint-disable-next-line no-eval
  buildMierusLink = eval('(' + m[0].replace(/^function buildMierusLink/, 'function') + ')');
  ok(typeof buildMierusLink === 'function', 'buildMierusLink extracted as a callable function');
}

// ── Basic single-port link ───────────────────────────────────────────────────
const link1 = buildMierusLink({
  username: 'alice', password: 's3cret', host: '203.0.113.7',
  ports: [443], transport: 'TCP', multiplexing: 'MULTIPLEXING_HIGH'
});
console.log('  → ' + link1);

ok(link1.startsWith('mierus://'), 'scheme is mierus://');
ok(link1.includes('alice:s3cret@'), 'userinfo carries username:password');
ok(link1.includes('@203.0.113.7?'), 'host is the raw server IP');

const u1 = new URL(link1);
ok(u1.protocol === 'mierus:', 'URL parser: protocol == mierus:');
ok(u1.username === 'alice', 'URL parser: username == alice');
ok(u1.password === 's3cret', 'URL parser: password == s3cret');
ok(u1.hostname === '203.0.113.7', 'URL parser: hostname == server IP');
ok(u1.searchParams.get('profile') === 'default', 'profile == default');
ok(u1.searchParams.get('port') === '443', 'port == 443');
ok(u1.searchParams.get('protocol') === 'TCP', 'protocol == TCP');
ok(u1.searchParams.get('multiplexing') === 'MULTIPLEXING_HIGH', 'multiplexing carried through');

// profile must come FIRST (before ports) — matches the reference encoder order.
ok(/\?profile=default&/.test(link1), 'profile is the first query param');

// ── Multi-port (range) link — every port paired with its own protocol ────────
const link2 = buildMierusLink({
  username: 'bob', password: 'pw', host: '198.51.100.9',
  ports: [2000, 2001, 2002], transport: 'TCP', multiplexing: 'MULTIPLEXING_HIGH'
});
console.log('  → ' + link2);

const u2 = new URL(link2);
const ports2 = u2.searchParams.getAll('port');
const protos2 = u2.searchParams.getAll('protocol');
ok(ports2.length === 3, 'range link has 3 port params');
ok(protos2.length === 3, 'range link has 3 protocol params (one per port)');
ok(ports2.join(',') === '2000,2001,2002', 'ports preserved in order');
ok(protos2.every(p => p === 'TCP'), 'every port paired with TCP protocol');
// Interleave check: the raw query must be port=..&protocol=..&port=..&protocol=..
ok(/port=2000&protocol=TCP&port=2001&protocol=TCP&port=2002&protocol=TCP/.test(link2),
   'port/protocol are interleaved (paired), not grouped');

// ── Percent-encoding: passwords with @ : / & ? must not break the link ───────
const link3 = buildMierusLink({
  username: 'user@corp', password: 'p@ss:w/rd&?', host: '192.0.2.5',
  ports: [443], transport: 'TCP'
});
console.log('  → ' + link3);
ok(!/[ ]/.test(link3), 'no raw spaces in link');
const u3 = new URL(link3);
ok(u3.username === encodeURIComponent('user@corp') || decodeURIComponent(u3.username) === 'user@corp',
   'special username round-trips');
ok(decodeURIComponent(u3.password) === 'p@ss:w/rd&?', 'special password round-trips exactly');
ok(u3.searchParams.getAll('port').length === 1, 'still exactly one port after encoding');

// ── multiplexing omitted when falsy ──────────────────────────────────────────
const link4 = buildMierusLink({
  username: 'x', password: 'y', host: '192.0.2.1', ports: [443], transport: 'TCP'
});
ok(!/multiplexing=/.test(link4), 'multiplexing omitted when not provided');

// ── transport defaults to TCP when omitted ───────────────────────────────────
const link5 = buildMierusLink({
  username: 'x', password: 'y', host: '192.0.2.1', ports: [443]
});
ok(new URL(link5).searchParams.get('protocol') === 'TCP', 'transport defaults to TCP');

// ── Endpoint wiring sanity (source-level): route registered, returns {link} ──
ok(/app\.get\(\s*['"]\/api\/users\/:id\/config\/mieru-link['"]/.test(src),
   'GET /api/users/:id/config/mieru-link route is registered');
ok(/requireAuth/.test(src.slice(src.indexOf('config/mieru-link'))),
   'mieru-link endpoint is behind requireAuth');
ok(/res\.json\(\{\s*link,\s*username/.test(src.slice(src.indexOf('config/mieru-link'))),
   'endpoint responds with { link, username }');
// Non-breaking guarantee: the JSON download endpoint must still exist untouched.
ok(/app\.get\(\s*['"]\/api\/users\/:id\/config\/mieru['"]/.test(src),
   'existing Mieru JSON endpoint is still present (non-breaking)');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
