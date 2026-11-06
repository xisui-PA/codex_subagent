const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseModelSettings, effectiveSettings } = require('../.test-build/model-settings');

const base = {
  maxTurns: 100, maxToolRounds: 40, turnTimeoutMs: 600_000,
  maxOutputChars: 200_000, maxHistoryBytes: 20_000_000, maxSessions: 200, retries: 2, autoCompact: true,
};

test('parseModelSettings accepts an empty pool and preserves entry priority order', () => {
  assert.deepEqual(parseModelSettings(undefined), {});
  assert.deepEqual(parseModelSettings({}), {});
  const parsed = parseModelSettings({ 'pool/b': { numSessions: 2 }, 'pool/a': { allowWrite: false } });
  assert.deepEqual(Object.keys(parsed), ['pool/b', 'pool/a']);
  assert.deepEqual(parsed['pool/b'], { numSessions: 2 });
  assert.deepEqual(parsed['pool/a'], { allowWrite: false });
});

test('parseModelSettings rejects malformed pools instead of silently degrading', () => {
  for (const raw of [null, [], 'pool/a', { 'pool/a': null }, { '': {} }, { 'pool/a': { nope: true } }, { 'pool/a': { numSessions: 0 } }, { 'pool/a': { numSessions: 9 } }, { 'pool/a': { numSessions: 1.5 } }]) {
    assert.throws(() => parseModelSettings(raw), { code: 'invalid_settings' }, `should reject ${JSON.stringify(raw)}`);
  }
});

test('parseModelSettings accepts nested per-model modelOptions and rejects non-object top-level values', () => {
  const parsed = parseModelSettings({ 'pool/a': { allowWrite: false, modelOptions: { temperature: 0, nested: { deep: [1, 'two', null] }, exotic: new Date(0) } } });
  assert.equal(parsed['pool/a'].modelOptions.temperature, 0);
  assert.deepEqual(parsed['pool/a'].modelOptions.nested, { deep: [1, 'two', null] });
  assert.ok(parsed['pool/a'].modelOptions.exotic instanceof Date, 'arbitrary provider-specific values are preserved');
  assert.deepEqual(parseModelSettings({ 'pool/a': { modelOptions: {} } }), { 'pool/a': { modelOptions: {} } });
  for (const bad of [null, [], 'x', 5, true]) {
    assert.throws(() => parseModelSettings({ 'pool/a': { modelOptions: bad } }), { code: 'invalid_settings' }, `should reject ${JSON.stringify(bad)}`);
  }
});

test('effectiveSettings overlays only present per-model tuning and inherits the rest', () => {
  const settings = { ...base, models: { 'pool/b': { numSessions: 3, maxToolRounds: 5 }, 'pool/a': {} } };
  const b = effectiveSettings(settings, 'pool/b');
  // numSessions is scheduler capacity enforced directly against the pool,
  // never a Settings overlay.
  assert.equal('maxConcurrent' in b, false);
  assert.equal(b.maxToolRounds, 5);
  assert.equal(b.turnTimeoutMs, base.turnTimeoutMs);
  assert.equal(b.autoCompact, base.autoCompact);
  const untouched = { ...base, models: { 'pool/missing': { allowWrite: false } } };
  assert.deepEqual(effectiveSettings(untouched, 'pool/other'), untouched);
  assert.deepEqual(effectiveSettings(settings, 'pool/a'), settings);
});
