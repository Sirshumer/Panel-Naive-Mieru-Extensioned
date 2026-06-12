/**
 * BUG-155 (HIGH): a polluted panelBasicAuthHash (apt/needrestart stdout captured
 * by an old installer) must NEVER reach the Caddyfile. These tests assert that
 * renderPanelBlock() sieves the hash down to a single valid bcrypt token (or
 * emits no basic_auth line at all when none is present), so the generated
 * Caddyfile always validates and caddy-naive never enters a failed-loop.
 */
const path = require('path');
const tpl  = require(path.join(__dirname, '..', 'panel', 'server', 'caddyTemplate.js'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else      { console.log(`  \u2717 ${name}`); fail++; }
}
// Count actual `basic_auth` DIRECTIVE lines (ignore the header comment which
// contains the words "basic_auth" in prose).
function baDirectives(block) {
  return (block.split('\n').filter(l => /^\s*basic_auth\b/.test(l))).length;
}
function hasBaDirective(block) { return baDirectives(block) > 0; }

// A genuine bcrypt hash has a 53-char body (total length 60).
const CLEAN = '$2a$12$.VJ5i4YcgO816PmEG4Gju.NPxD80CLKCHgFJD94F0yGbSWgcW6w02';

const baseCfg = {
  exposePanel: true,
  panelDomain: 'panel.example.com',
  adminEmail: 'a@b.com',
  panelBasicAuthUser: 'admin',
  webBasePath: 'secret123',
  panelPort: 3000,
  panelStubPage: '/var/www/panel-stub/index.html',
};

console.log('\n[1] polluted hash (the exact field dump) → single clean basic_auth line');
{
  const polluted = [
    'Selecting previously unselected package libapr1t64...',
    '(Reading database ... 45%',
    '(Reading database ... 100%',
    'Unpacking apache2-utils ...',
    'Setting up apache2-utils ...',
    'Running kernel seems to be up-to-date.',
    'No services need to be restarted.',
    CLEAN,
  ].join('\n');
  const block = tpl.renderPanelBlock({ ...baseCfg, panelBasicAuthHash: polluted });
  check('basic_auth directive appears exactly once', baDirectives(block) === 1);
  check('clean bcrypt hash is present', block.includes(CLEAN));
  check('no apt/needrestart garbage leaked', !/Unpacking|Selecting|Reading database|kernel|services need/.test(block));
  // The basic_auth block must be exactly: basic_auth { \n  admin <hash> \n }
  check('basic_auth block is well-formed (user + single-line hash)',
        /basic_auth \{\s*\n\s*admin \$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}\s*\n\s*\}/.test(block));
}

console.log('\n[2] clean hash passes through unchanged');
{
  const block = tpl.renderPanelBlock({ ...baseCfg, panelBasicAuthHash: CLEAN });
  check('clean hash emitted verbatim', block.includes(`admin ${CLEAN}`));
  check('exactly one basic_auth directive', baDirectives(block) === 1);
}

console.log('\n[3] hash with no valid bcrypt → NO basic_auth line (valid Caddyfile, no auth)');
{
  const junk = 'Unpacking apache2-utils ...\nSetting up apache2-utils ...';
  const block = tpl.renderPanelBlock({ ...baseCfg, panelBasicAuthHash: junk });
  check('no basic_auth directive emitted', !hasBaDirective(block));
  check('no garbage leaked', !/Unpacking|Setting up/.test(block));
  check('panel block still rendered (reverse_proxy present)', /reverse_proxy 127\.0\.0\.1:3000/.test(block));
}

console.log('\n[4] empty hash → no basic_auth line');
{
  const block = tpl.renderPanelBlock({ ...baseCfg, panelBasicAuthHash: '' });
  check('no basic_auth directive', !hasBaDirective(block));
}

console.log('\n[5] $2a and $2b variants are accepted');
{
  const a = '$2a$12$.VJ5i4YcgO816PmEG4Gju.NPxD80CLKCHgFJD94F0yGbSWgcW6w02';
  const b = '$2b$10$.VJ5i4YcgO816PmEG4Gju.NPxD80CLKCHgFJD94F0yGbSWgcW6w02';
  check('$2a accepted', tpl.renderPanelBlock({ ...baseCfg, panelBasicAuthHash: a }).includes(`admin ${a}`));
  check('$2b accepted', tpl.renderPanelBlock({ ...baseCfg, panelBasicAuthHash: b }).includes(`admin ${b}`));
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
