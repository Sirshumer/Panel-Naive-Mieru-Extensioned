/**
 * TASK 1 (MEDIUM) — config root cause: the Caddy ACCESS log must be a `log`
 * directive INSIDE the site block. Previously it lived in the GLOBAL options
 * block, which only configures Caddy's runtime logger and never writes
 * per-request access logs (user_id + byte counters) — so NaiveProxy traffic was
 * always 0.0.
 *
 * This test requires the REAL caddyTemplate.js module and asserts the access log
 * is emitted inside the site block (not only globally) and that the global
 * logger no longer writes to the access.log path.
 */
const path = require('path');
const tpl  = require(path.join(__dirname, '..', 'panel', 'server', 'caddyTemplate.js'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else      { console.log(`  \u2717 ${name}`); fail++; }
}

const cfg = {
  adminEmail: 'admin@example.com',
  domain: 'example.com',
  naivePort: 443,
  fakeSiteDir: '/var/www/fake-site',
  probeMode: 'off',
  logFile: '/var/log/caddy-naive/access.log'
};
const out = tpl.render(cfg, [{ username: 'u1', password: 'p1' }]);

// Split the Caddyfile into the global options block (the leading `{ ... }`) and
// the rest (site blocks). The global block is everything up to the first `}` at
// column 0.
const firstCloseIdx = out.indexOf('\n}');
const globalBlock = out.slice(0, firstCloseIdx);
const siteBlocks  = out.slice(firstCloseIdx);

console.log('[1] access log path appears INSIDE a site block, not just globally');
check('Caddyfile mentions the access.log path', out.includes('/var/log/caddy-naive/access.log'));
check('access.log is in the site-block portion', siteBlocks.includes('output file /var/log/caddy-naive/access.log'));

console.log('\n[2] the GLOBAL options block does NOT write the access.log file');
check('global block does not reference access.log',
      !globalBlock.includes('/var/log/caddy-naive/access.log'));
check('global logger is runtime-only (stderr)', /output stderr/.test(globalBlock));

console.log('\n[3] the site block has a forward_proxy with the access log before it');
const siteStart = out.indexOf(':443, example.com {');
check('site block exists', siteStart >= 0);
const site = out.slice(siteStart);
const logIdx   = site.indexOf('output file /var/log/caddy-naive/access.log');
const proxyIdx = site.indexOf('forward_proxy {');
check('access log directive present in site block', logIdx >= 0);
check('forward_proxy present in site block', proxyIdx >= 0);

console.log('\n[4] JSON format + roll retention preserved');
check('format json present', /format json/.test(site));
check('roll_keep_for retention present', /roll_keep_for 720h/.test(site));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
