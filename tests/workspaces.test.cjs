const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture, finished, model } = require('./helpers.cjs');
const { defaults } = require('../.test-build/engine');
const { SessionStore, digest } = require('../.test-build/storage');
const { WorkerBroker, unpack } = require('../.test-build/runtime');
const { workspaceDirectory, rootMetadata, prepareWorkspaces } = require('../.test-build/workspaces');

async function legacy(t) {
  const { root: temporary, engine, store } = await fixture(t);
  const root = await fs.realpath(temporary);
  const other = path.join(root, 'other'); await fs.mkdir(other);
  const a = await engine.spawn({ requestId: 'old-a', task: 'A', permission: 'read-only', workspaceRoot: root });
  const b = await engine.spawn({ requestId: 'old-b', task: 'B', permission: 'read-only', workspaceRoot: other });
  await finished(engine, a.id); const done = await finished(engine, b.id);
  await engine.compact(b.id, done.revision, 'Summary B');
  const change = { id: randomUUID(), path: path.join(other, 'file.txt'), kind: 'write', before: null, after: 'saved', state: 'applied', createdAt: new Date().toISOString() };
  await store.recordChange(b.id, change);
  await engine.shutdown(); await store.close();
  const storage = path.join(root, 'storage'), identity = 'workspace:legacy';
  const directory = path.join(storage, 'workspaces', digest(identity).slice(0, 32));
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.rename(store.directory, directory);
  await fs.writeFile(path.join(directory, 'workspace.json'), JSON.stringify({ identity, roots: [root, other] }));
  const options = { storage, registry: path.join(storage, 'bridges'), roots: [root, other], identity,
    provider: { models: async () => [model], countTokens: async () => 10, async *stream() { yield { type: 'text', text: 'new answer' }; } },
    settings: () => ({ ...defaults, models: { [model.id]: {} } }), files: { canWrite: () => false, allowShell: () => false }, onChange() {}, onError() {} };
  return { root, other, a, b, change, storage, identity, directory, options };
}

test('legacy grouped stores migrate checkpoints, operation keys, archives and snapshots without changing IDs', async t => {
  const f = await legacy(t);
  const broker = new WorkerBroker(f.options); t.after(() => broker.close()); await broker.start();
  assert.equal((await broker.list()).length, 2);
  const a = await broker.session(f.root, f.a.id), b = await broker.session(f.other, f.b.id);
  assert.notEqual(a.storeDirectory, b.storeDirectory);
  assert.equal(b.summary.text, 'Summary B');
  const history = unpack(await broker.invoke(f.other, 'subagent_status', { id: b.id, messageLimit: 20 }));
  assert.equal(history.messages.length, 2); assert.equal(history.messages[0].parts[0].text, 'B');
  assert.deepEqual(unpack(await broker.invoke(f.other, 'ui_change', { id: b.id, changeId: f.change.id })), f.change);
  assert.equal(unpack(await broker.invoke(f.other, 'subagent_spawn', { requestId: 'old-b', task: 'B' })).id, b.id);
  await assert.rejects(fs.stat(path.join(f.directory, `${b.id}.json`)), { code: 'ENOENT' });
  await broker.close();
  const again = new WorkerBroker({ ...f.options, roots: [f.other], identity: 'folder:' + f.other }); t.after(() => again.close()); await again.start();
  assert.equal((await again.list()).length, 1);
  assert.equal((await again.session(f.other, b.id)).storeDirectory, b.storeDirectory);
});

test('migration recovers after a target checkpoint was copied before the source was removed', async t => {
  const f = await legacy(t);
  const original = (await SessionStore.saved(f.directory)).find(s => s.id === f.b.id);
  const target = new SessionStore(await workspaceDirectory(f.storage, f.other)); await target.open();
  await target.importSession(f.directory, original); await rootMetadata(target.directory, f.other); await target.close();
  const broker = new WorkerBroker(f.options); t.after(() => broker.close()); await broker.start();
  assert.equal((await broker.list()).length, 2);
  assert.equal((await broker.session(f.other, f.b.id)).summary.text, 'Summary B');
  await assert.rejects(fs.stat(path.join(f.directory, `${f.b.id}.json`)), { code: 'ENOENT' });
});

test('a migration conflict preserves the source checkpoint and snapshot', async t => {
  const f = await legacy(t);
  const target = await workspaceDirectory(f.storage, f.other);
  const snapshot = path.join(target, 'changes', f.b.id, `${f.change.id}.json`);
  await fs.mkdir(path.dirname(snapshot), { recursive: true }); await fs.writeFile(snapshot, 'conflicting content');
  await assert.rejects(prepareWorkspaces(f.storage, f.identity, [f.root, f.other]), { code: 'migration_conflict' });
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, `${f.b.id}.json`), 'utf8')).id, f.b.id);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'changes', f.b.id, `${f.change.id}.json`), 'utf8')).after, 'saved');
  assert.equal(await fs.readFile(snapshot, 'utf8'), 'conflicting content');
});
