const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WorkerComposer } = require('../.test-build/composer');
const { fixture, finished, deferred, until } = require('./helpers.cjs');
function storage(initial) {
  let saved = initial;
  return { load: () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
}

test('accepted follow-up with lost acknowledgement retries the same key after reload exactly once', async t => {
  const { engine, requests } = await fixture(t);
  const worker = await engine.spawn({ requestId: 'initial', task: 'Initial', permission: 'read-only' }); await finished(engine, worker.id);
  const disk = storage(); let composer = new WorkerComposer(disk); let key;
  await composer.submit({ action: 'send', draft: '  Follow-up instructions  ' }, async operation => {
    key = operation.requestId;
    assert.equal(disk.load().pending.requestId, key, 'Persist before accepting work');
    await engine.send(worker.id, key, operation.message);
    throw new Error('Acknowledgement lost');
  });
  assert.equal(composer.state().draft, '  Follow-up instructions  ');
  assert.equal(composer.state().pending.requestId, key);
  composer = new WorkerComposer(disk);
  assert.equal(composer.state().busy, false);
  await composer.retry(async operation => {
    assert.equal(operation.requestId, key); assert.equal(operation.message, 'Follow-up instructions');
    await engine.send(worker.id, operation.requestId, operation.message);
  });
  await finished(engine, worker.id);
  assert.equal(engine.session(worker.id).turns.length, 2); assert.equal(requests.length, 2);
  assert.equal(composer.state().pending, undefined); assert.equal(composer.state().draft, '');
  assert.equal(disk.load().pending, undefined);
});

test('duplicate submissions share an in-flight request and a different message cannot replace its key', async () => {
  const composer = new WorkerComposer(storage()); const gate = deferred(); let count = 0;
  const input = { action: 'send', draft: 'Message' };
  const perform = async () => { count++; await gate.promise; };
  const first = composer.submit(input, perform); await until(() => count === 1);
  const key = composer.state().pending.requestId;
  const duplicate = composer.submit(input, perform);
  await assert.rejects(composer.submit({ action: 'send', draft: 'Different message' }, perform), { code: 'pending_message' });
  assert.equal(composer.state().pending.requestId, key);
  gate.resolve(); await Promise.all([first, duplicate]); assert.equal(count, 1);
});

test('editing the next draft does not change retry arguments or lose the new text on acknowledgement', async () => {
  const composer = new WorkerComposer(storage());
  await composer.submit({ action: 'resume', draft: 'Recover', model: 'original-model' }, async () => { throw new Error('Disconnected'); });
  const key = composer.state().pending.requestId;
  await composer.draft('Next message');
  await composer.retry(async operation => {
    assert.equal(operation.action, 'resume'); assert.equal(operation.requestId, key);
    assert.equal(operation.message, 'Recover'); assert.equal(operation.model, 'original-model');
  });
  assert.equal(composer.state().draft, 'Next message'); assert.equal(composer.state().pending, undefined);
});

test('storage failure prevents submission and retains the draft/key for a later retry', async () => {
  const disk = storage(); let unavailable = true; let count = 0;
  const composer = new WorkerComposer({ load: disk.load, save: async value => { if (unavailable) { throw new Error('Storage unavailable'); } await disk.save(value); } });
  await assert.rejects(composer.submit({ action: 'send', draft: 'Keep this draft' }, async () => { count++; }), /Storage unavailable/);
  const key = composer.state().pending.requestId;
  assert.equal(count, 0); assert.equal(composer.state().draft, 'Keep this draft');
  unavailable = false;
  await composer.retry(async operation => { assert.equal(operation.requestId, key); count++; });
  assert.equal(count, 1); assert.equal(composer.state().draft, '');
});

test('failure saving an acknowledgement retains the original key without resending automatically', async () => {
  const disk = storage(); let writes = 0; let count = 0;
  const composer = new WorkerComposer({ load: disk.load, save: async value => {
    if (++writes === 2) { throw new Error('Cannot save acknowledgement'); } await disk.save(value);
  } });
  await composer.submit({ action: 'send', draft: 'Message' }, async () => { count++; });
  const key = disk.load().pending.requestId;
  assert.equal(composer.state().pending.requestId, key); assert.equal(count, 1);
  await composer.retry(async operation => { assert.equal(operation.requestId, key); });
  assert.equal(count, 1); assert.equal(disk.load().pending, undefined);
});

test('clearing a retry preserves the draft and cannot clear an in-flight operation', async () => {
  const composer = new WorkerComposer(storage()); const gate = deferred(); let called = false;
  const running = composer.submit({ action: 'send', draft: 'Keep draft' }, async () => { called = true; await gate.promise; throw new Error('Failure'); });
  await until(() => called); await assert.rejects(composer.clearPending(), { code: 'worker_busy' });
  gate.resolve(); await running; await composer.clearPending();
  assert.equal(composer.state().draft, 'Keep draft'); assert.equal(composer.state().pending, undefined);
  await composer.retry(async () => { assert.fail('There is no pending operation to send'); });
});
