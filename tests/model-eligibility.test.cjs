const assert = require('node:assert/strict');
const { test } = require('node:test');
const { eligibleModels } = require('../.test-build/model-settings');

const available = [
  { id: 'model/c', name: 'C' },
  { id: 'model/a', name: 'A' },
  { id: 'model/b', name: 'B' }
];
const pool = {
  'model/b': { allowWrite: true, numSessions: 2 },
  'model/a': { allowWrite: false },
  'model/missing': {}
};

test('eligible models follow exact configured pool order and drop unconfigured or unavailable IDs', () => {
  const readOnly = eligibleModels({ permission: 'read-only', available, pool });
  assert.deepEqual(readOnly.models.map(model => model.id), ['model/b', 'model/a']);
  assert.equal(readOnly.preferred, 'model/b');
  assert.equal(readOnly.guidance, undefined);
  assert.deepEqual(readOnly.models[0].policy, { allowWrite: true, numSessions: 2 });

  // Legacy empty pool keeps the enabled order; nothing configured is required.
  assert.deepEqual(eligibleModels({ permission: 'workspace-write', available, pool: {} }).models.map(model => model.id), ['model/c', 'model/a', 'model/b']);
  assert.deepEqual(eligibleModels({ permission: 'read-only', available }).models.map(model => model.id), ['model/c', 'model/a', 'model/b']);
});

test('workspace-write sessions exclude allowWrite:false entries but read-only keeps them', () => {
  const write = eligibleModels({ permission: 'workspace-write', available, pool });
  assert.deepEqual(write.models.map(model => model.id), ['model/b']);
  assert.equal(write.guidance, undefined);

  const restricted = eligibleModels({ permission: 'workspace-write', available, pool: { 'model/a': { allowWrite: false } } });
  assert.deepEqual(restricted.models, []);
  assert.equal(restricted.preferred, undefined);
  assert.match(restricted.guidance, /allowWrite/);
  assert.match(restricted.guidance, /read-only/);
});

test('a removed previous model falls back to the first eligible model instead of reusing the old ID', () => {
  const removed = eligibleModels({ permission: 'read-only', available, pool, previous: 'model/gone' });
  assert.equal(removed.preferred, 'model/b');
  assert.ok(!removed.models.some(model => model.id === 'model/gone'));

  const stillEligible = eligibleModels({ permission: 'read-only', available, pool, previous: 'model/a' });
  assert.equal(stillEligible.preferred, 'model/a');

  // The fallback is consistent with permission filtering: A cannot run writes.
  assert.equal(eligibleModels({ permission: 'workspace-write', available, pool, previous: 'model/a' }).preferred, 'model/b');
});

test('empty eligibility always returns actionable guidance', () => {
  const disabled = eligibleModels({ permission: 'read-only', available, pool: { 'model/x': {}, 'model/y': {} } });
  assert.deepEqual(disabled.models, []);
  assert.match(disabled.guidance, /enabled VS Code model/);
  assert.match(disabled.guidance, /model\/x, model\/y/);

  const noModels = eligibleModels({ permission: 'read-only', available: [], pool: {} });
  assert.match(noModels.guidance, /Enable Model/);

  const legacyEmpty = eligibleModels({ permission: 'workspace-write', available: [], pool: { 'model/b': {} } });
  assert.match(legacyEmpty.guidance, /Enable Model/);
});
