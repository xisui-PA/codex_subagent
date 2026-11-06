const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { WorkerBroker, unpack } = require('../.test-build/runtime');
const { forward } = require('../.test-build/bridge');
const { defaults } = require('../.test-build/engine');
const { model, until } = require('./helpers.cjs');
const { poolAllows } = require('../.test-build/model-settings');
const git = promisify(execFile);

async function fixture(t, stream) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-runtime-')));
  const root = path.join(temporary, 'repo'); await fs.mkdir(root);
  const options = {
    storage: path.join(temporary, 'storage'), registry: path.join(temporary, 'registry'), roots: [root], identity: `folder:${root}`,
    provider: { models: async () => [model], countTokens: async () => 10, stream: stream || (async function* () { yield { type: 'text', text: 'done' }; }) },
    settings: () => ({ ...defaults, autoCompact: false, models: { [model.id]: { allowWrite: true, numSessions: 2 } } }),
    files: { canWrite: () => true, allowShell: () => false }, onChange() {}, onError() {}
  };
  const brokers = [];
  const create = async extra => { const broker = new WorkerBroker({ ...options, ...extra }); brokers.push(broker); await broker.start(); return broker; };
  t.after(async () => { for (const broker of brokers.reverse()) { await broker.close(); } await fs.rm(temporary, { recursive: true, force: true }); });
  return { root, options, temporary, create };
}
async function done(broker, root, id) {
  await until(async () => !['queued', 'running'].includes((await broker.session(root, id)).state));
  return broker.session(root, id);
}

test('two windows share one owner and the surviving window takes over after closure', async t => {
  const { root, create, options } = await fixture(t);
  const first = await create(); const second = await create();
  assert.equal((await fs.readdir(options.registry)).length, 1);
  const worker = unpack(await second.invoke(root, 'subagent_spawn', { requestId: 'shared', task: 'task' }));
  assert.equal((await done(first, root, worker.id)).state, 'completed');
  assert.equal((await second.list()).length, 1);
  await first.close();
  assert.equal((await second.session(root, worker.id)).state, 'completed');
  assert.equal((await fs.readdir(options.registry)).length, 1);
});

test('newly created registered worktrees route to isolated workers without a new window', async t => {
  const { root, create, options, temporary } = await fixture(t);
  await git('git', ['init', '-b', 'main', root]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const broker = await create();
  const worktree = path.join(temporary, 'worktree');
  await git('git', ['-C', root, 'worktree', 'add', '-b', 'worker', worktree]);
  const spawned = unpack(await forward(options.registry, worktree, 'subagent_spawn', { requestId: 'tree', task: 'Work in this checkout' }));
  const worker = await done(broker, worktree, spawned.id);
  assert.equal(worker.workspaceRoot, worktree);
  assert.equal((await broker.list()).length, 1);
  assert.equal((await fs.readdir(options.registry)).length, 2);
  const main = unpack(await broker.invoke(root, 'subagent_list', {}));
  assert.equal(main.workers.length, 0);
});

test('folder additions/reordering preserve sessions and pin relative paths to their original root', async t => {
  let count = 0;
  const { root, create, temporary } = await fixture(t, async function* (_model, messages) {
    const last = messages.at(-1).parts[0];
    if (last.type === 'result') { yield { type: 'text', text: JSON.parse(last.text).content }; }
    else { yield { type: 'call', id: `read-${count++}`, name: 'read_file', input: { path: 'marker.txt' } }; }
  });
  const other = path.join(temporary, 'other'); await fs.mkdir(other);
  await fs.writeFile(path.join(root, 'marker.txt'), 'original-root'); await fs.writeFile(path.join(other, 'marker.txt'), 'second-root');
  const first = await create({ identity: 'stable-workspace' });
  const worker = unpack(await first.invoke(root, 'subagent_spawn', { requestId: 'old', task: 'read marker' }));
  await done(first, root, worker.id); await first.close();
  const changed = await create({ roots: [other, root], identity: 'workspace:untitled:after-host-restart' });
  assert.equal((await changed.list()).length, 1);
  unpack(await changed.invoke(other, 'subagent_send', { workspaceRoot: worker.workspaceRoot, id: worker.id, requestId: 'follow', message: 'read again' }));
  assert.equal((await done(changed, root, worker.id)).turns.at(-1).output, 'original-root');
  const newer = unpack(await changed.invoke(other, 'subagent_spawn', { requestId: 'new', task: 'read marker' }));
  assert.equal((await done(changed, other, newer.id)).turns.at(-1).output, 'second-root');
});

test('change snapshots can be reviewed/reverted and refuse stale-file overwrites', async t => {
  const { root, create } = await fixture(t, async function* (_model, messages) {
    if (messages.at(-1).parts[0].type === 'result') { yield { type: 'text', text: 'created' }; }
    else { yield { type: 'call', id: 'write', name: 'write_file', input: { path: 'new.txt', content: 'worker content', expectedHash: 'new' } }; }
  });
  const broker = await create();
  const created = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'edit', task: 'create', permission: 'workspace-write' }));
  const s = await done(broker, root, created.id);
  assert.equal(s.changes[0].state, 'applied');
  const snapshot = unpack(await broker.invoke(root, 'ui_change', { id: s.id, changeId: s.changes[0].id }));
  assert.equal(snapshot.after, 'worker content');
  await fs.writeFile(path.join(root, 'new.txt'), 'user edited');
  assert.ok((await broker.invoke(root, 'ui_revert', { id: s.id, changeId: s.changes[0].id })).isError);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'user edited');
  await fs.writeFile(path.join(root, 'new.txt'), 'worker content');
  assert.ok(unpack(await broker.invoke(root, 'ui_revert', { id: s.id, changeId: s.changes[0].id })).reverted);
  await assert.rejects(fs.stat(path.join(root, 'new.txt')), { code: 'ENOENT' });
});

// Model write policy gates worker inference/tools, never the user's Revert of a
// recorded change. These exercise WorkerBroker.ui_revert with the same
// pool-driven canWrite/allowShell callbacks src/extension.ts wires today.
test('user Revert survives allowWrite revocation while worker writes stay denied', async t => {
  const { randomUUID } = require('node:crypto');
  const models = { [model.id]: { allowWrite: true, numSessions: 2 } };
  const { root, create } = await fixture(t);
  const broker = await create({
    settings: () => ({ ...defaults, autoCompact: false, models }),
    files: { canWrite: () => poolAllows(models, 'allowWrite'), allowShell: () => poolAllows(models, 'allowShell') },
  });
  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'snapshot', task: 'Task', permission: 'workspace-write' }));
  await done(broker, root, worker.id);
  const file = path.join(root, 'revoked.txt');
  await fs.writeFile(file, 'worker edit');
  const change = { id: randomUUID(), path: file, kind: 'write', before: 'original', after: 'worker edit', state: 'applied', createdAt: new Date().toISOString() };
  await broker.local.get(root).store.recordChange(worker.id, change);
  assert.ok((await broker.invoke(root, 'subagent_health', {})).content[0].text.includes('write_file'), 'writable model exposes worker write tools');

  // The user restricts the only writable model in codexSubagent.models.
  models[model.id] = { ...models[model.id], allowWrite: false };
  assert.ok(!(await broker.invoke(root, 'subagent_health', {})).content[0].text.includes('write_file'), 'worker write tools must be withdrawn');
  assert.ok((await broker.invoke(root, 'subagent_spawn', { requestId: 'later-write', task: 'more edits', permission: 'workspace-write' })).isError, 'no workspace-write worker without a writable model');
  // The privileged revert still enforces the recorded after-image hash.
  await fs.writeFile(file, 'user edited elsewhere');
  assert.ok((await broker.invoke(root, 'ui_revert', { id: worker.id, changeId: change.id })).isError, 'revocation must not bypass stale-hash protection');
  assert.equal(await fs.readFile(file, 'utf8'), 'user edited elsewhere');
  await fs.writeFile(file, 'worker edit');
  assert.equal(unpack(await broker.invoke(root, 'ui_revert', { id: worker.id, changeId: change.id })).reverted, true, 'user undo must still work');
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
});

test('user Revert survives the last model leaving the pool and invalid model settings', async t => {
  const { randomUUID } = require('node:crypto');
  let models = { [model.id]: { allowWrite: true, numSessions: 2 } };
  let settingsBroken = false;
  // Mirrors src/extension.ts: strict pool parse for engine settings, aggregate
  // poolAllows for the FileTools switches, malformed settings => no access.
  const { parseModelSettings } = require('../.test-build/model-settings');
  const brokerFiles = {
    canWrite: () => { try { return poolAllows(parseModelSettings(models), 'allowWrite'); } catch { return false; } },
    allowShell: () => { try { return poolAllows(parseModelSettings(models), 'allowShell'); } catch { return false; } },
  };
  const { root, create } = await fixture(t);
  const broker = await create({
    settings: () => ({ ...defaults, autoCompact: false, models: parseModelSettings(settingsBroken ? 'invalid' : models) }),
    files: brokerFiles,
  });
  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'snapshot', task: 'Task', permission: 'workspace-write' }));
  await done(broker, root, worker.id);
  const file = path.join(root, 'undo.txt');

  // The last enabled model is removed: nothing is enabled for ANY permission.
  models = {};
  assert.ok((await broker.invoke(root, 'subagent_spawn', { requestId: 'no-pool', task: 'read', permission: 'read-only' })).isError, 'no worker may run with an empty pool');
  assert.ok(!(await broker.invoke(root, 'subagent_health', {})).content[0].text.includes('write_file'), 'worker write tools must be withdrawn');
  await fs.writeFile(file, 'worker edit');
  const change = { id: randomUUID(), path: file, kind: 'write', before: 'original', after: 'worker edit', state: 'applied', createdAt: new Date().toISOString() };
  await broker.local.get(root).store.recordChange(worker.id, change);
  assert.equal(unpack(await broker.invoke(root, 'ui_revert', { id: worker.id, changeId: change.id })).reverted, true, 'user undo must work with an empty pool');
  assert.equal(await fs.readFile(file, 'utf8'), 'original');

  // Malformed user models setting: the aggregate switch reports no access and
  // the engine settings callback throws; the recorded change is still revertible.
  await fs.writeFile(file, 'second worker edit');
  settingsBroken = true;
  const second = { id: randomUUID(), path: file, kind: 'delete', before: 'second worker edit', after: null, state: 'applied', createdAt: new Date().toISOString() };
  await broker.local.get(root).store.recordChange(worker.id, second);
  await fs.unlink(file);
  assert.equal(unpack(await broker.invoke(root, 'ui_revert', { id: worker.id, changeId: second.id })).reverted, true, 'user undo must work with malformed settings');
  assert.equal(await fs.readFile(file, 'utf8'), 'second worker edit', 'reverting a recorded delete restores the file');
});

test('explicit and nested worktree roots are honored from a main-checkout MCP client', async t => {
  const { root, create, options, temporary } = await fixture(t);
  await git('git', ['init', '-b', 'main', root]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const broker = await create();
  const nested = path.join(root, '.worktrees', 'feature');
  await git('git', ['-C', root, 'worktree', 'add', '-b', 'nested', nested]);
  const direct = unpack(await forward(options.registry, nested, 'subagent_spawn', { requestId: 'nested-cwd', task: 'Task' }));
  assert.equal((await done(broker, nested, direct.id)).workspaceRoot, nested);
  const scoped = unpack(await forward(options.registry, root, 'subagent_spawn', { workspaceRoot: nested, requestId: 'explicit-scope', task: 'Task' }));
  assert.equal(scoped.workspaceRoot, nested);
  const unrelated = path.join(temporary, 'unrelated'); await fs.mkdir(unrelated);
  const rejected = await forward(options.registry, root, 'subagent_spawn', { workspaceRoot: unrelated, requestId: 'bad-scope', task: 'Task' });
  assert.equal(JSON.parse(rejected.content[0].text).error.code, 'outside_workspace');
});

test('parent leases and explicit stop reach a worktree owned by another window', async t => {
  const { root, create, options, temporary } = await fixture(t, async function* () { await new Promise(() => {}); yield { type: 'text', text: 'never' }; });
  await git('git', ['init', '-b', 'main', root]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const other = path.join(temporary, 'other-tree'); await git('git', ['-C', root, 'worktree', 'add', '-b', 'other', other]);
  const treeWindow = await create({ roots: [other], identity: `folder:${other}` });
  const mainWindow = await create();
  const args = { ownerId: 'parent', parentPolicy: 'cancel-on-expiry', leaseSeconds: 30, task: 'Task' };
  const a = unpack(await forward(options.registry, root, 'subagent_spawn', { ...args, requestId: 'main' }));
  const b = unpack(await forward(options.registry, root, 'subagent_spawn', { ...args, workspaceRoot: other, requestId: 'tree' }));
  unpack(await mainWindow.invoke(root, 'subagent_parent', { ownerId: 'parent', action: 'heartbeat', leaseSeconds: 60 }));
  assert.equal((await treeWindow.session(other, b.id)).parentLeaseSeconds, 60);
  unpack(await mainWindow.invoke(root, 'subagent_parent', { ownerId: 'parent', action: 'stop' }));
  assert.equal((await mainWindow.session(root, a.id)).state, 'cancelled');
  assert.equal((await treeWindow.session(other, b.id)).state, 'cancelled');
});

test('removed roots keep readable/deletable history without permitting redirected work', async t => {
  const { root, temporary, create } = await fixture(t);
  const other = path.join(temporary, 'remaining'); await fs.mkdir(other);
  const first = await create({ roots: [root, other], identity: 'removable-root-workspace' });
  const worker = unpack(await first.invoke(root, 'subagent_spawn', { requestId: 'old-root', task: 'Task' }));
  await done(first, root, worker.id); await first.close();
  const changed = await create({ roots: [other], identity: 'removable-root-workspace' });
  const saved = await changed.session(root, worker.id);
  assert.equal(saved.workspaceRoot, root); assert.ok(saved.storeDirectory);
  await assert.rejects(changed.invoke(root, 'subagent_resume', { id: worker.id, requestId: 'resume' }), { code: 'workspace_changed' });
  const deleted = unpack(await changed.invoke(root, 'subagent_delete', { id: worker.id }));
  assert.equal(deleted.deleted, worker.id); assert.equal((await changed.list()).length, 0);
});

test('simultaneous worktree discovery never probes another window under an ownership mutex', async t => {
  const { root, temporary, create, options } = await fixture(t);
  await git('git', ['init', '-b', 'main', root]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const other = path.join(temporary, 'tree'); await git('git', ['-C', root, 'worktree', 'add', '-b', 'other', other]);
  // Pre-create both saved stores so each discovery sees the other one.
  const seed = await create({ roots: [root, other] }); await seed.close();
  const a = new WorkerBroker({ ...options }); const b = new WorkerBroker({ ...options, roots: [other], identity: `folder:${other}` });
  t.after(async () => { await a.close(); await b.close(); });
  const { deferred } = require('./helpers.cjs'); const gate = deferred(); let count = 0;
  for (const broker of [a, b]) {
    const discover = broker.discoverWorktrees.bind(broker);
    broker.discoverWorktrees = async force => { if (++count === 2) { gate.resolve(); } await gate.promise; return discover(force); };
  }
  let complete = false;
  const started = Promise.all([a.start(), b.start()]).then(() => { complete = true; });
  await until(() => complete, 3000); await started;
  assert.equal(unpack(await forward(options.registry, root, 'subagent_health', {})).ready, true);
  assert.equal(unpack(await forward(options.registry, other, 'subagent_health', {})).ready, true);
});

test('overlapping single/multi-folder windows share each root regardless of opening order', async t => {
  for (const multiFirst of [true, false]) {
    const { root, temporary, create, options } = await fixture(t);
    const other = path.join(temporary, 'other'); await fs.mkdir(other);
    const multiOptions = { roots: [root, other], identity: 'workspace:multi' };
    const singleOptions = { roots: [other], identity: `folder:${other}` };
    const first = await create(multiFirst ? multiOptions : singleOptions);
    const second = await create(multiFirst ? singleOptions : multiOptions);
    const multi = multiFirst ? first : second; const single = multiFirst ? second : first;
    assert.equal((await fs.readdir(options.registry)).length, 2);
    const worker = unpack(await forward(options.registry, root, 'subagent_spawn', { workspaceRoot: other, requestId: 'overlap', task: 'Task' }));
    await done(single, other, worker.id);
    assert.equal((await multi.session(other, worker.id)).id, worker.id);
    assert.equal((await multi.list()).length, 1); assert.equal((await single.list()).length, 1);
    await first.close();
    assert.equal(unpack(await second.invoke(other, 'subagent_status', { id: worker.id })).state, 'completed');
  }
});

test('single-folder to multi-folder conversion and workspace Save As keep the same store', async t => {
  const { root, temporary, create } = await fixture(t);
  const other = path.join(temporary, 'other'); await fs.mkdir(other);
  const first = await create();
  const worker = unpack(await first.invoke(root, 'subagent_spawn', { requestId: 'continuity', task: 'Task' }));
  const before = await done(first, root, worker.id); await first.close();
  const multi = await create({ roots: [root, other], identity: 'workspace:untitled:Untitled-1' });
  assert.equal((await multi.session(root, worker.id)).storeDirectory, before.storeDirectory);
  await multi.close();
  const saved = await create({ roots: [other, root], identity: 'workspace:file:///saved.code-workspace' });
  assert.equal((await saved.session(root, worker.id)).storeDirectory, before.storeDirectory);
  unpack(await saved.invoke(root, 'subagent_send', { id: worker.id, requestId: 'continued', message: 'Continue' }));
  assert.equal((await done(saved, root, worker.id)).turns.length, 2);
});

test('concurrent multi-folder windows with opposite folder order publish only one owner per root', async t => {
  const { root, temporary, create, options } = await fixture(t);
  const other = path.join(temporary, 'other'); await fs.mkdir(other);
  const [a, b] = await Promise.all([
    create({ roots: [root, other], identity: 'workspace:first' }),
    create({ roots: [other, root], identity: 'workspace:second' })
  ]);
  assert.equal((await fs.readdir(options.registry)).length, 2);
  const one = unpack(await forward(options.registry, root, 'subagent_spawn', { requestId: 'one', task: 'A' }));
  const two = unpack(await forward(options.registry, other, 'subagent_spawn', { requestId: 'two', task: 'B' }));
  await done(a, root, one.id); await done(b, other, two.id);
  assert.equal((await a.list()).length, 2); assert.equal((await b.list()).length, 2);
});

test('parent controls reach an unrelated folder when the cwd owner has a smaller workspace', async t => {
  const { root, temporary, create, options } = await fixture(t, async function* () { await new Promise(() => {}); yield { type: 'text', text: 'never' }; });
  const other = path.join(temporary, 'unrelated'); await fs.mkdir(other);
  const single = await create();
  const multi = await create({ roots: [root, other], identity: 'workspace:multi' });
  const worker = unpack(await forward(options.registry, root, 'subagent_spawn', { workspaceRoot: other, requestId: 'parent', ownerId: 'cross-folder', parentPolicy: 'cancel-on-expiry', task: 'Task' }));
  unpack(await forward(options.registry, root, 'subagent_parent', { ownerId: 'cross-folder', action: 'heartbeat', leaseSeconds: 60 }));
  assert.equal((await multi.session(other, worker.id)).parentLeaseSeconds, 60);
  unpack(await forward(options.registry, root, 'subagent_parent', { ownerId: 'cross-folder', action: 'stop' }));
  assert.equal((await multi.session(other, worker.id)).state, 'cancelled');
  assert.equal((await single.list()).length, 0);
});

test('an unowned worktree routes deterministically when several checkout owners can discover it', async t => {
  const { root, temporary, create, options } = await fixture(t);
  await git('git', ['init', '-b', 'main', root]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const existing = path.join(temporary, 'existing'); await git('git', ['-C', root, 'worktree', 'add', '-b', 'existing', existing]);
  const broker = await create({ roots: [root, existing] });
  const added = path.join(temporary, 'added'); await git('git', ['-C', root, 'worktree', 'add', '-b', 'added', added]);
  const [a, b] = await Promise.all([
    forward(options.registry, added, 'subagent_spawn', { requestId: 'new-tree', task: 'Task' }),
    forward(options.registry, added, 'subagent_spawn', { requestId: 'new-tree', task: 'Task' })
  ]);
  assert.equal(unpack(a).id, unpack(b).id);
  assert.equal((await done(broker, added, unpack(a).id)).workspaceRoot, added);
  assert.equal((await fs.readdir(options.registry)).length, 3);
});

test('removed nested folders retain their own history and never redirect controls to the parent store', async t => {
  const { root, temporary, create, options } = await fixture(t);
  const inner = path.join(root, 'package'); await fs.mkdir(inner);
  const identity = 'workspace:nested-folders';
  const first = await create({ roots: [root, inner], identity });
  const worker = unpack(await first.invoke(inner, 'subagent_spawn', { requestId: 'nested-history', task: 'Task' }));
  const saved = await done(first, inner, worker.id);
  await first.close();
  const changed = await create({ roots: [root], identity });
  assert.ok((await changed.list()).some(s => s.id === worker.id));
  assert.equal((await changed.session(inner, worker.id)).storeDirectory, saved.storeDirectory);
  const status = unpack(await forward(options.registry, root, 'subagent_status', { workspaceRoot: inner, id: worker.id, messageLimit: 20 }));
  assert.equal(status.state, 'completed'); assert.equal(status.messages.length, 2);
  const { exportTranscript } = require('../.test-build/exporter');
  const target = path.join(temporary, 'history.json');
  await exportTranscript(await changed.session(inner, worker.id), saved.storeDirectory, target);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).session.id, worker.id);
  for (const name of ['subagent_send', 'subagent_resume']) {
    await assert.rejects(changed.invoke(inner, name, { id: worker.id, requestId: name, message: 'Continue' }), { code: 'workspace_changed' });
  }
  await changed.close();
  const restored = await create({ roots: [inner, root], identity });
  unpack(await restored.invoke(inner, 'subagent_send', { id: worker.id, requestId: 'restored-followup', message: 'Continue' }));
  assert.equal((await done(restored, inner, worker.id)).turns.length, 2);
  await restored.close();
  const removedAgain = await create({ roots: [root], identity });
  unpack(await removedAgain.invoke(inner, 'subagent_delete', { id: worker.id }));
  assert.equal((await removedAgain.list()).length, 0);
});

test('owner shutdown keeps a discoverable stopping host until effects drain, then permits takeover', async t => {
  const { deferred } = require('./helpers.cjs');
  const release = deferred(); t.after(() => release.resolve());
  const started = deferred(); const aborting = deferred();
  const { root, temporary, create, options } = await fixture(t, async function* () { yield { type: 'call', id: 'hold', name: 'hold', input: {} }; });
  await git('git', ['init', '-b', 'main', root]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const tree = path.join(temporary, 'tree'); await git('git', ['-C', root, 'worktree', 'add', '-b', 'tree', tree]);
  const main = await create(); const owner = await create({ roots: [tree], identity: `folder:${tree}` });
  owner.local.get(tree).engine.tools = { definitions: () => [], execute: async (_n, _i, _p, signal) => {
    signal.addEventListener('abort', () => aborting.resolve(), { once: true }); started.resolve(); await release.promise; return 'settled';
  } };
  const worker = unpack(await owner.invoke(tree, 'subagent_spawn', { requestId: 'draining', task: 'Task' }));
  await started.promise;
  const closing = owner.close(); await aborting.promise;
  assert.equal((await fs.readdir(options.registry)).length, 2);
  const waiting = await forward(options.registry, tree, 'subagent_status', { id: worker.id });
  assert.equal(JSON.parse(waiting.content[0].text).error.code, 'host_stopping');
  assert.equal(JSON.parse(waiting.content[0].text).error.retryable, true);
  release.resolve(); await closing;
  assert.equal(unpack(await forward(options.registry, tree, 'subagent_health', {})).ready, true);
  assert.equal((await main.session(tree, worker.id)).state, 'interrupted');
});

test('a missing locked-store owner never forwards through the same checkout recursively', async t => {
  const { deferred } = require('./helpers.cjs');
  const { WorkerError } = require('../.test-build/types');
  const release = deferred(); t.after(() => release.resolve());
  const started = deferred(); const aborting = deferred();
  const { root, temporary, create, options } = await fixture(t, async function* () { yield { type: 'call', id: 'hold', name: 'hold', input: {} }; });
  await git('git', ['init', '-b', 'main', root]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const tree = path.join(temporary, 'tree'); await git('git', ['-C', root, 'worktree', 'add', '-b', 'tree', tree]);
  const main = await create(); const owner = await create({ roots: [tree], identity: `folder:${tree}` });
  const local = owner.local.get(tree);
  local.engine.tools = { definitions: () => [], execute: async (_n, _i, _p, signal) => {
    signal.addEventListener('abort', () => aborting.resolve(), { once: true }); started.resolve(); await release.promise; return 'settled';
  } };
  const worker = unpack(await owner.invoke(tree, 'subagent_spawn', { requestId: 'withdrawn', task: 'Task' })); await started.promise;
  // Simulate an owner whose descriptor disappeared while its lock is still held.
  await local.host.close(); const closing = owner.close(); await aborting.promise;
  let calls = 0; const invoke = main.invoke.bind(main);
  main.invoke = async (cwd, ...rest) => {
    if (cwd === tree && ++calls > 3) { throw new WorkerError('test_guard', 'Recursive forwarding'); }
    return invoke(cwd, ...rest);
  };
  const response = await forward(options.registry, tree, 'subagent_health', {});
  const error = JSON.parse(response.content[0].text).error;
  assert.equal(error.code, 'host_reconnecting'); assert.equal(error.retryable, true);
  assert.equal(calls, 1);
  release.resolve(); await closing;
  const health = unpack(await forward(options.registry, tree, 'subagent_health', {}));
  assert.equal(health.ready, true); assert.equal(health.root, tree);
  assert.equal((await main.session(tree, worker.id)).state, 'interrupted');
});

test('Revert is tracked, blocks conflicting controls and drains before another owner takes over', async t => {
  const { deferred, sleep } = require('./helpers.cjs');
  const { randomUUID } = require('node:crypto');
  const release = deferred(); t.after(() => release.resolve()); const applying = deferred();
  const { root, create } = await fixture(t);
  const first = await create({ files: { canWrite: () => true, allowShell: () => false, applyChange: async change => {
    applying.resolve(); await release.promise; await fs.writeFile(change.path, change.after);
  } } });
  const worker = unpack(await first.invoke(root, 'subagent_spawn', { requestId: 'revert', task: 'Task', permission: 'workspace-write' }));
  await done(first, root, worker.id);
  const file = path.join(root, 'file.txt'); await fs.writeFile(file, 'worker edit');
  const change = { id: randomUUID(), path: file, kind: 'write', before: 'original', after: 'worker edit', state: 'applied', createdAt: new Date().toISOString() };
  await first.local.get(root).store.recordChange(worker.id, change);
  const reverting = first.invoke(root, 'ui_revert', { id: worker.id, changeId: change.id }); await applying.promise;
  const active = await first.session(root, worker.id);
  assert.equal(active.state, 'running'); assert.equal(active.maintenance.kind, 'revert');
  for (const [name, args] of [['subagent_send', { requestId: 'blocked', message: 'New task' }], ['subagent_delete', {}], ['ui_revert', { changeId: change.id }]]) {
    const response = await first.invoke(root, name, { id: worker.id, ...args });
    assert.equal(JSON.parse(response.content[0].text).error.code, 'worker_busy');
  }
  const unrelated = unpack(await first.invoke(root, 'subagent_spawn', { requestId: 'unrelated-edit', task: 'Other task' }));
  assert.equal((await done(first, root, unrelated.id)).state, 'completed');
  let closed = false; const closing = first.close().then(() => { closed = true; });
  await sleep(30); assert.equal(closed, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'worker edit');
  release.resolve(); assert.equal(unpack(await reverting).reverted, true); await closing;
  const next = await create();
  const saved = await next.session(root, worker.id);
  assert.equal(saved.state, 'completed'); assert.equal(saved.maintenance, undefined);
  assert.equal(saved.changes.find(c => c.id === change.id).state, 'reverted');
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  await sleep(50); assert.equal(await fs.readFile(file, 'utf8'), 'original');
});

test('removed worktrees keep readable history across restart and can be restored or deleted', async t => {
  const { root, temporary, create } = await fixture(t);
  await git('git', ['init', '-b', 'main', root]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const tree = path.join(temporary, 'tree');
  const first = await create(); await git('git', ['-C', root, 'worktree', 'add', '-b', 'saved', tree]);
  const a = unpack(await first.invoke(root, 'subagent_spawn', { requestId: 'main-history', task: 'Main' }));
  const b = unpack(await first.invoke(tree, 'subagent_spawn', { requestId: 'tree-history', task: 'Worktree' }));
  await done(first, root, a.id); await done(first, tree, b.id);
  await git('git', ['-C', root, 'worktree', 'remove', tree]);
  assert.equal((await first.list()).length, 2);
  assert.equal((await first.session(tree, b.id)).state, 'completed');
  await first.close();
  const next = await create(); assert.equal((await next.list()).length, 2);
  const archived = await next.session(tree, b.id);
  const { exportTranscript } = require('../.test-build/exporter');
  const target = path.join(temporary, 'saved-tree.json'); await exportTranscript(archived, archived.storeDirectory, target);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).session.id, b.id);
  await assert.rejects(next.invoke(tree, 'subagent_send', { id: b.id, requestId: 'missing', message: 'Continue' }), { code: 'workspace_changed' });
  await git('git', ['-C', root, 'worktree', 'add', tree, 'saved']);
  unpack(await next.invoke(tree, 'subagent_send', { id: b.id, requestId: 'restored-tree', message: 'Continue' }));
  assert.equal((await done(next, tree, b.id)).turns.length, 2);
  await git('git', ['-C', root, 'worktree', 'remove', tree]);
  assert.equal((await next.list()).length, 2);
  unpack(await next.invoke(tree, 'subagent_delete', { id: b.id }));
  assert.equal((await next.list()).length, 1);
});
