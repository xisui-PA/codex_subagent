const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { exportTranscript } = require('../.test-build/exporter');
const { fixture, finished } = require('./helpers.cjs');

test('exports full archive turns and recoverable change contents', async t => {
  const { engine, store, root } = await fixture(t);
  const worker = await engine.spawn({ requestId: 'export', task: 'old task', permission: 'read-only' });
  let session = await finished(engine, worker.id);
  await store.recordChange(worker.id, { id: randomUUID(), kind: 'write', path: path.join(root, 'a.txt'), before: 'original', after: 'changed', state: 'applied', createdAt: new Date().toISOString() });
  session = store.get(worker.id);
  await engine.compact(worker.id, session.revision, 'Task done');
  const target = path.join(root, 'export.json');
  await exportTranscript(store.get(worker.id), store.directory, target);
  const exported = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(exported.archives[0].turns[0].input, 'old task');
  assert.equal(exported.changeSnapshots[0].before, 'original');
  assert.equal(exported.changeSnapshots[0].after, 'changed');
});

test('failed export preserves the previous artifact and refuses internal store targets', async t => {
  const { engine, store, root } = await fixture(t);
  const worker = await engine.spawn({ requestId: 'export', task: 'task', permission: 'read-only' });
  const session = await finished(engine, worker.id);
  const target = path.join(root, 'export.json'); await fs.writeFile(target, 'previous artifact');
  session.archives = [{ id: randomUUID(), firstMessage: 0, messageCount: 1, createdAt: new Date().toISOString() }];
  await assert.rejects(exportTranscript(session, store.directory, target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'previous artifact');
  assert.ok(!(await fs.readdir(root)).some(name => name.endsWith('.tmp')));
  await assert.rejects(exportTranscript(session, store.directory, path.join(store.directory, worker.id + '.json')), { code: 'protected_path' });
});
