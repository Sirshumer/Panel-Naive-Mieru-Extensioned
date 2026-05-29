'use strict';
/**
 * caddyTemplate.js — canonical Caddyfile renderer  v1.2.6
 *
 * Single source of truth used by:
 *   • panel/server/index.js   → buildCaddyfile()
 *   • update.sh               → node -e "require('./caddyTemplate').render(cfg, users)"
 *   • install.sh              → node -e "require('./caddyTemplate').render(cfg, [])"
 *
 * Bug 23: forward_proxy uses  basic_auth  (with underscore) as the *block* directive;
 *         individual credential lines use the same  basic_auth  directive:
 *             basic_auth  <username>  <password>
 *         The standalone  "basic_auth"  token with no arguments is NOT valid in
 *         caddy-forwardproxy-naive — it causes the parse error:
 *             "wrong argument count or unexpected line ending after 'basic_auth'"
 *         We therefore emit ONLY the per-user lines; the block keyword is omitted.
 *
 * Bug 28: TLS is managed by the global  email  directive + Caddy's automatic HTTPS.
 *         A redundant  tls <email>  inside the site block is removed.
 *
 * Bug 29: Directive order inside forward_proxy:
 *             basic_auth  <user>  <pass>   (one line per user, or placeholder)
 *             hide_ip
 *             hide_via
 *             probe_resistance  <secret>   (only when secret is set)
 *
 * Bug 30: Global  order  directive ensures forwardproxy is evaluated before file_server.
 *
 * Bug 34: Placeholder logic — emit ONE placeholder line only when naiveUsers is empty;
 *         as soon as the first real user exists, placeholder is dropped.
 *
 * Bug 38: Log rotation uses  roll_keep_for  720h  (30 days) instead of a fixed count.
 *
 * Bug 21: No duplicate site-level log block; global log block covers all traffic.
 */

const crypto = require('crypto');

/**
 * render(cfg, naiveUsers) → string
 *
 * @param {object} cfg
 *   .adminEmail   {string}  ACME email (used in global block)
 *   .domain       {string}  VPN domain
 *   .naivePort    {number}  HTTPS port (default 443)
 *   .fakeSiteDir  {string}  path to fake-site root
 *   .probeSecret  {string}  probe_resistance token (used only when probeMode='secret')
 *   .probeMode    {string}  'off' | 'bare' | 'secret' (optional; derived from
 *                           probeSecret when unset — non-empty→'secret', empty→'bare')
 *   .logFile      {string}  caddy access log path (optional)
 *   .upstream     {string}  upstream proxy URL, e.g. https://user:pass@exit.example.com:443 (optional)
 * @param {Array<{username:string, password:string}>} naiveUsers
 *   Users with naive protocol enabled.  password must be the PLAINTEXT
 *   password (caddy-forwardproxy-naive hashes it internally).
 * @returns {string}  Full Caddyfile content ready to write.
 */
function render(cfg, naiveUsers) {
  const email      = (cfg.adminEmail  || '').trim();
  const domain     = (cfg.domain      || 'localhost').trim();
  const port       = cfg.naivePort   || 443;
  const fakeSite   = (cfg.fakeSiteDir || '/var/www/fake-site').trim();
  const probeSecret = (cfg.probeSecret || '').trim();
  const logFile    = (cfg.logFile     || '/var/log/caddy-naive/access.log').trim();

  // ── Bug 23 + 34: basic_auth credential lines ──────────────────────────────
  // caddy-forwardproxy-naive forward_proxy block accepts:
  //   basic_auth  <username>  <password>
  // The bare  "basic_auth"  keyword with no args is invalid.
  // When there are no real users we emit a single unreachable placeholder so
  // the forward_proxy block is never left without credentials (which would
  // allow unauthenticated access).  The placeholder is replaced on the next
  // rebuild after the first real user is created.
  let authLines;
  if (naiveUsers && naiveUsers.length > 0) {
    authLines = naiveUsers
      .map(u => `    basic_auth ${u.username} ${u.password}`)
      .join('\n');
  } else {
    // Bug 34: unique random placeholder; no real client can match it.
    const rnd = crypto.randomBytes(20).toString('hex');
    authLines = `    basic_auth _placeholder_${rnd.slice(0, 16)} _disabled_${rnd.slice(16)}`;
  }

  // ── Bug 29 + Bug 81: probe_resistance line ───────────────────────────────
  // Three modes (cfg.probeMode):
  //   'off'    → no probe_resistance line at all
  //   'bare'   → bare  probe_resistance  (no secret) — matches the known-good
  //              reference server; the masquerade site is served on the main
  //              domain, no special secret domain is required.
  //   'secret' → probe_resistance <secret>  (requires a secret domain to reach
  //              the masquerade content).
  // Back-compat: if probeMode is unset, derive it from probeSecret
  //   (non-empty → 'secret', empty → 'bare').
  let probeMode = (cfg.probeMode || '').trim().toLowerCase();
  if (!probeMode) probeMode = probeSecret ? 'secret' : 'bare';

  let probeLine;
  if (probeMode === 'off') {
    probeLine = '';
  } else if (probeMode === 'secret' && probeSecret) {
    probeLine = `\n    probe_resistance ${probeSecret}`;
  } else {
    // 'bare' (or 'secret' with no secret available) → bare keyword
    probeLine = `\n    probe_resistance`;
  }

  // ── v1.2.6: cascade — upstream proxy support ──────────────────────────────
  const upstreamUrl = (cfg.upstream || '').trim();
  const upstreamLine = upstreamUrl
    ? `\n    upstream ${upstreamUrl}`
    : '';

  // ── Bug 28: no redundant  tls <email>  inside the site block  ────────────
  // Caddy's automatic HTTPS handles TLS for domains that resolve to this
  // server's IP.  The global  email  directive supplies the ACME account.

  // Bug 63: use consistent 2-space indentation throughout to silence caddy fmt
  return `{
  # Bug 30: evaluate forwardproxy handler before file_server
  order forward_proxy before file_server
  # Bug 80: restrict to HTTP/1.1 + HTTP/2 only (disable HTTP/3 / QUIC).
  # NaiveProxy tunnels over HTTP/2 CONNECT; HTTP/3 can break some clients.
  servers {
    protocols h1 h2
  }
  email ${email}
  admin off
  log {
    # Bug 38: 30-day retention by age instead of a fixed file count
    output file ${logFile} {
      roll_size 50mb
      roll_keep_for 720h
    }
    format json
  }
}

# HTTP → HTTPS redirect (also needed for ACME HTTP-01 fallback)
:80 {
  redir https://{host}{uri} permanent
}

:${port}, ${domain} {
  # Bug 83: match the known-good reference server exactly:
  #   - listen on ":${port}, ${domain}" (catch-all :${port} + the domain) so the
  #     CONNECT request matches this site regardless of how the client sets SNI/Host
  #   - explicit "tls <email>" inside the block (not relying on the global email)
  #   - no route{} wrapper — forward_proxy/file_server directly in the site block
  #     (ordering comes from the global "order forward_proxy before file_server")
  tls ${email}

  forward_proxy {
    # Bug 23: no bare "basic_auth" token; each line IS the credential directive
    # Bug 29: order — credentials → hide_ip → hide_via → probe_resistance
${authLines}
    hide_ip
    hide_via${probeLine}${upstreamLine}
  }

  file_server {
    root ${fakeSite}
  }
}
`;
}

module.exports = { render };
