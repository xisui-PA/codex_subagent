const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkerBroker, unpack } = require('../.test-build/runtime');
const { defaults } = require('../.test-build/engine');
const { model, deferred, until } = require('./helpers.cjs');

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-settings-')));
  const root = path.join(temporary, 'repo'); await fs.mkdir(root);
  const gate = deferred();
  t.after(() => gate.resolve());
  const requests = [];
  const errors = [];
  // Mutable strict settings mirror the extension callback: a malformed pool
  // throws instead of silently degrading to legacy behavior.
  let malformed = false;
  const settings = () => {
    if (malformed) {
      throw new Error('codexSubagent.models is invalid: model/x: expected boolean.');
    }
    return { ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { allowWrite: true, numSessions: capacity } } };
  };
  let capacity = 1;
  const options = {
    storage: path.join(temporary, 'storage'), registry: path.join(temporary, 'registry'), roots: [root], identity: `folder:${root}`,
    provider: {
      models: async () => [model], countTokens: async () => 10,
      async *stream(selected, messages) { requests.push({ model: selected, messages }); await gate.promise; yield { type: 'text', text: 'done' }; }
    },
    settings,
    files: { canWrite: () => true, allowShell: () => false },
    onChange() {}, onError(message) { errors.push(message); }
  };
  const broker = new WorkerBroker(options);
  await broker.start();
  t.after(async () => { await broker.close(); await fs.rm(temporary, { recursive: true, force: true }); });
  return {
    broker, root, requests, errors, release: () => gate.resolve(),
    setCapacity: value => { capacity = value; },
    setMalformed: value => { malformed = value; }
  };
}
async function done(broker, root, id) {
  await until(async () => !['queued', 'running'].includes((await broker.session(root, id)).state));
  return broker.session(root, id);
}

test('broker.settingsChanged releases queued work immediately after live capacity increase', async t => {
  const { broker, root, requests, release, setCapacity } = await fixture(t);
  const first = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'live-1', task: 'One' }));
  const second = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'live-2', task: 'Two' }));
  await until(() => requests.length === 1);
  assert.equal((await broker.session(root, second.id)).state, 'queued');

  // Raising numSessions must not require a restart, cancel, or ownership change.
  setCapacity(2);
  broker.settingsChanged();
  await until(() => requests.length === 2);
  release();

  assert.equal((await done(broker, root, first.id)).state, 'completed');
  assert.equal((await done(broker, root, second.id)).state, 'completed');
});

test('broker.settingsChanged survives malformed settings and reschedules after repair', async t => {
  const { broker, root, requests, errors, release, setCapacity, setMalformed } = await fixture(t);
  const first = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'repair-1', task: 'One' }));
  const second = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'repair-2', task: 'Two' }));
  await until(() => requests.length === 1);
  assert.equal((await broker.session(root, second.id)).state, 'queued');

  // A malformed save must not throw from the UI notification path...
  setMalformed(true);
  assert.doesNotThrow(() => broker.settingsChanged());
  await until(() => errors.some(message => /invalid/.test(message)));

  // ...and repairing the settings must release the worker that was stranded.
  setMalformed(false);
  setCapacity(2);
  broker.settingsChanged();
  await until(() => requests.length === 2);
  release();

  assert.equal((await done(broker, root, first.id)).state, 'completed');
  assert.equal((await done(broker, root, second.id)).state, 'completed');
});
