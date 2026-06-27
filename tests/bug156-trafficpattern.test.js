/**
 * BUG-156 (HIGH): the mita-state.json generator wrote trafficPattern.seed as a
 * BOOLEAN (`seed: true`). In the mita proto `seed` is an int32, so
 * `mita apply config` failed with
 *   proto: invalid value for int32 type: true
 * → empty server config → mita IDLE → Mieru port closed.
 *
 * These tests pin the proto-correct schema produced for each UI preset and
 * exercise the structural validator that now refuses a bad config before it
 * ever reaches mita. We replicate the pure builder/validator logic here (the
 * production copies in index.js / update.sh are byte-for-byte the same shape)
 * so the test runs without a live server or the `mita` binary.
 */
const crypto = require('crypto');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else      { console.log(`  \u2717 ${name}`); fail++; }
}

// ── builder (mirrors index.js buildTrafficPattern) ───────────────────────────
function buildTrafficPattern(pat, cfg) {
  let seed = parseInt(cfg.trafficPatternSeed, 10);
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0x7fffffff) {
    seed = (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff) || 1;
  }
  switch (pat) {
    case 'RANDOM_PADDING':
      return { seed, unlockAll: false,
               tcpFragment: { enable: false, maxSleepMs: 0 },
               nonce: { type: 'NONCE_TYPE_PRINTABLE', applyToAllUDPPacket: false, minLen: 4, maxLen: 8 } };
    case 'RANDOM_PADDING_AGGRESSIVE':
      return { seed, unlockAll: true,
               tcpFragment: { enable: true, maxSleepMs: 10 },
               nonce: { type: 'NONCE_TYPE_PRINTABLE', applyToAllUDPPacket: true, minLen: 6, maxLen: 12 } };
    case 'CUSTOM':
      if (cfg.trafficPatternCustom && typeof cfg.trafficPatternCustom === 'object') {
        const c = { ...cfg.trafficPatternCustom };
        c.seed = Number.isInteger(parseInt(c.seed, 10)) ? parseInt(c.seed, 10) : seed;
        return c;
      }
      return { seed, unlockAll: true };
    default: return null;
  }
}

// ── validator (mirrors index.js validateMitaState layer 1) ───────────────────
function validateMitaState(obj) {
  const tp = obj.trafficPattern;
  if (tp && typeof tp === 'object') {
    if ('seed' in tp && !Number.isInteger(tp.seed))
      return { ok: false, error: 'seed must be int32' };
    if ('unlockAll' in tp && typeof tp.unlockAll !== 'boolean')
      return { ok: false, error: 'unlockAll must be bool' };
    if ('tcpFragment' in tp) {
      const f = tp.tcpFragment;
      if (typeof f !== 'object' || f === null) return { ok: false, error: 'tcpFragment must be object' };
      if ('enable' in f && typeof f.enable !== 'boolean') return { ok: false, error: 'tcpFragment.enable must be bool' };
      if ('maxSleepMs' in f && !Number.isInteger(f.maxSleepMs)) return { ok: false, error: 'maxSleepMs must be int' };
    }
    if ('nonce' in tp && (typeof tp.nonce !== 'object' || tp.nonce === null))
      return { ok: false, error: 'nonce must be object' };
  }
  return { ok: true, error: '' };
}

const isInt32 = v => Number.isInteger(v) && v >= 0 && v <= 0x7fffffff;

console.log('\n[1] RANDOM_PADDING → seed is int32, not boolean');
{
  const tp = buildTrafficPattern('RANDOM_PADDING', {});
  check('seed is an integer', isInt32(tp.seed));
  check('seed is NOT a boolean', typeof tp.seed !== 'boolean');
  check('unlockAll is a boolean', typeof tp.unlockAll === 'boolean');
  check('tcpFragment is an object', typeof tp.tcpFragment === 'object');
  check('nonce is an object with a type', tp.nonce && typeof tp.nonce.type === 'string');
  check('validateMitaState accepts it', validateMitaState({ trafficPattern: tp }).ok);
}

console.log('\n[2] RANDOM_PADDING_AGGRESSIVE → proto-correct, fragment enabled');
{
  const tp = buildTrafficPattern('RANDOM_PADDING_AGGRESSIVE', {});
  check('seed is int32', isInt32(tp.seed));
  check('unlockAll true', tp.unlockAll === true);
  check('tcpFragment.enable true', tp.tcpFragment.enable === true);
  check('tcpFragment.maxSleepMs is int', Number.isInteger(tp.tcpFragment.maxSleepMs));
  check('validates', validateMitaState({ trafficPattern: tp }).ok);
}

console.log('\n[3] NOOP / unknown → no trafficPattern object');
{
  check('NOOP returns null', buildTrafficPattern('NOOP', {}) === null);
  check('unknown returns null', buildTrafficPattern('WAT', {}) === null);
}

console.log('\n[4] stable seed: a persisted numeric seed is reused verbatim');
{
  const tp = buildTrafficPattern('RANDOM_PADDING', { trafficPatternSeed: 123456 });
  check('persisted seed reused', tp.seed === 123456);
  const tp2 = buildTrafficPattern('RANDOM_PADDING_AGGRESSIVE', { trafficPatternSeed: '987' });
  check('string seed coerced to int', tp2.seed === 987);
}

console.log('\n[5] the OLD bug shape is REJECTED by the validator');
{
  const bad = { trafficPattern: { seed: true, tcpFragment: false, nonce: false } };
  const r = validateMitaState(bad);
  check('seed:true rejected', !r.ok && /seed/.test(r.error));
  const bad2 = { trafficPattern: { seed: 5, tcpFragment: false } };
  check('tcpFragment:false (bool) rejected', !validateMitaState(bad2).ok);
}

console.log('\n[6] CUSTOM coerces a boolean seed to int32');
{
  const tp = buildTrafficPattern('CUSTOM', { trafficPatternCustom: { seed: true, unlockAll: true } });
  check('custom seed coerced away from boolean', typeof tp.seed !== 'boolean' && isInt32(tp.seed));
  check('custom validates', validateMitaState({ trafficPattern: tp }).ok);
}

console.log('\n[7] full generated mita-state validates (with users)');
{
  const tp = buildTrafficPattern('RANDOM_PADDING', {});
  const state = {
    portBindings: [{ port: 2012, protocol: 'TCP' }],
    users: [{ name: 'u1', password: 'p1' }],
    loggingLevel: 'INFO', mtu: 1400,
    trafficPattern: tp
  };
  // round-trip through JSON like the real file write/read
  const roundTripped = JSON.parse(JSON.stringify(state));
  check('seed survives JSON round-trip as number', typeof roundTripped.trafficPattern.seed === 'number');
  check('validates after round-trip', validateMitaState(roundTripped).ok);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
