const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { digest } = require('../.test-build/storage');
const { register, prepareRuntime, repairRegistration } = require('../.test-build/registration');
const { FileTools } = require('../.test-build/workspace-tools');
const { invoke } = require('../.test-build/api');
const { fixture, finished, model, deferred, until } = require('./helpers.cjs');

test('corrupt transcript is quarantined and retry cannot overwrite its reserved ID', async t => {
  const { engine, store } = await fixture(t);
  const requestId = 'corrupt-retry';
  const file = path.join(store.directory, digest(requestId).slice(0, 32) + '.json');
  await fs.writeFile(file, '{original corrupt content');
  await store.close(); await store.open();
  assert.ok(store.diagnostics.length);
  await assert.rejects(engine.spawn({ requestId, task: 'retry', permission: 'read-only' }), { code: 'session_unreadable' });
  assert.equal(await fs.readFile(file, 'utf8'), '{original corrupt content');
  assert.equal(await fs.readFile(path.join(store.directory, 'quarantine', path.basename(file)), 'utf8'), '{original corrupt content');
});

test('registration preserves symlinks and stable relay refreshes after upgrades', async t => {
  const { root } = await fixture(t);
  const target = path.join(root, 'dotfiles.toml');
  const file = path.join(root, 'config.toml');
  await fs.writeFile(target, '# preserve\nmodel="original"\n'); await fs.symlink(target, file);
  const bundle = path.join(root, 'bundle.js'); await fs.writeFile(bundle, 'version one');
  const stable = await prepareRuntime(path.join(root, 'global'), bundle);
  await register(file, 'node', stable, '/registry');
  assert.ok((await fs.lstat(file)).isSymbolicLink());
  assert.match(await fs.readFile(target, 'utf8'), /mcp_servers.codex_subagent/);
  await fs.writeFile(bundle, 'version two');
  assert.equal(await prepareRuntime(path.join(root, 'global'), bundle), stable);
  assert.equal(await fs.readFile(stable, 'utf8'), 'version two');
  assert.ok(await repairRegistration(file, 'node-new', stable, '/registry'));
  assert.match(await fs.readFile(target, 'utf8'), /node-new/);
  await register(file, '', '', '', true);
  assert.ok((await fs.lstat(file)).isSymbolicLink());
});

test('workspace-write spawn fails up front when write tools are unavailable', async t => {
  const { engine } = await fixture(t);
  await assert.rejects(engine.spawn({ requestId: 'write', task: 'edit', permission: 'workspace-write' }), { code: 'permission_denied' });
  assert.equal(engine.list().length, 0);
});

test('owners have independent request keys and controls reject a different owner', async t => {
  const { engine } = await fixture(t);
  const a = await engine.spawn({ requestId: 'one', ownerId: 'parent-a', task: 'A', permission: 'read-only' });
  const b = await engine.spawn({ requestId: 'one', ownerId: 'parent-b', task: 'B', permission: 'read-only' });
  assert.notEqual(a.id, b.id);
  const rejected = await invoke(engine, 'subagent_cancel', { id: a.id, ownerId: 'parent-b' });
  assert.ok(rejected.isError); assert.match(rejected.content[0].text, /owner_mismatch/);
  const list = JSON.parse((await invoke(engine, 'subagent_list', { ownerId: 'parent-a' })).content[0].text);
  assert.equal(list.workers.length, 1);
});

test('expired parent leases cancel work without deleting its records', async t => {
  const { engine, store } = await fixture(t, { async *stream() { await new Promise(() => {}); yield { type: 'text', text: 'unused' }; } });
  const s = await engine.spawn({ requestId: 'lease', ownerId: 'parent', parentPolicy: 'cancel-on-expiry', task: 'A', permission: 'read-only' });
  await store.change(s.id, d => { d.parentExpiresAt = Date.now() - 1; });
  await engine.expireParents();
  assert.equal(engine.session(s.id).state, 'cancelled'); assert.equal(store.list().length, 1);
});

test('automatic context rollover preserves the task and readable immutable history', async t => {
  const { engine, store } = await fixture(t, {
    settings: { autoCompact: true },
    provider: { models: async () => [{ ...model, maxInputTokens: 2048 }], countTokens: async (_m, message) => Math.ceil(JSON.stringify(message).length / 4) },
    async *stream(_model, messages) {
      yield { type: 'text', text: messages[0].parts[0].text.startsWith('Produce a concise continuation summary') ? 'Task: inspect long input. No effects. Continue remaining work.' : 'finished task' };
    }
  });
  const task = 'long task '.repeat(1000);
  const s = await engine.spawn({ requestId: 'long', task, permission: 'read-only' });
  const done = await finished(engine, s.id);
  assert.equal(done.state, 'completed'); assert.ok(done.archives.length >= 1);
  assert.equal((await store.history(s.id, 0, 20)).messages[0].parts[0].text, task);
  assert.ok(done.summary.text.includes('No effects')); assert.ok(JSON.stringify(done.messages).length < task.length);
});

test('multiple archive rollovers page all messages after reload without duplication', async t => {
  const { engine, store } = await fixture(t);
  const s = await engine.spawn({ requestId: 'archive', task: 'first', permission: 'read-only' });
  const first = await finished(engine, s.id);
  await engine.compact(s.id, first.revision, 'first task done');
  await engine.send(s.id, 'next', 'second');
  const second = await finished(engine, s.id); await engine.compact(s.id, second.revision, 'both done');
  await store.close(); await store.open();
  assert.deepEqual((await store.history(s.id, 0, 20)).messages.map(m => m.parts[0].text), ['first', 'done', 'second', 'done']);
  assert.equal((await store.turn(s.id, first.turns[0].id)).input, 'first');
});

test('patch/rename/delete use hash preconditions and capture recoverable snapshots', async t => {
  const { root } = await fixture(t); const changes = [];
  const tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => false, recordChange: async (_s, c) => changes.push({ ...c }) });
  const signal = new AbortController().signal; const s = { id: 'example' };
  await tools.execute('write_file', { path: 'a.txt', content: 'hello world', expectedHash: 'new' }, 'workspace-write', signal, s);
  const read = JSON.parse(await tools.execute('read_file', { path: 'a.txt' }, 'read-only', signal));
  const patched = JSON.parse(await tools.execute('patch_file', { path: 'a.txt', oldText: 'world', newText: 'friend', expectedHash: read.hash }, 'workspace-write', signal, s));
  await tools.execute('rename_file', { path: 'a.txt', target: 'b.txt', expectedHash: patched.hash }, 'workspace-write', signal, s);
  await tools.execute('delete_file', { path: 'b.txt', expectedHash: patched.hash }, 'workspace-write', signal, s);
  await assert.rejects(fs.stat(path.join(root, 'b.txt')), { code: 'ENOENT' });
  assert.deepEqual(changes.map(c => c.kind), ['write', 'write', 'rename', 'delete']); assert.equal(changes.at(-1).before, 'hello friend');
});

test('unsaved editor content is readable and patchable without saving other changes', async t => {
  const { root } = await fixture(t); await fs.writeFile(path.join(root, 'a.txt'), 'disk');
  let open = 'unsaved editor';
  const tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => false, readOpenText: () => open, applyChange: async c => { open = c.after; } });
  const signal = new AbortController().signal;
  const read = JSON.parse(await tools.execute('read_file', { path: 'a.txt' }, 'read-only', signal)); assert.equal(read.content, 'unsaved editor');
  await tools.execute('patch_file', { path: 'a.txt', oldText: 'editor', newText: 'document', expectedHash: read.hash }, 'workspace-write', signal);
  assert.equal(open, 'unsaved document'); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'disk');
});

test('automatic manual compaction is cancellable and does not block other workers', async t => {
  const { engine, provider } = await fixture(t);
  const s = await engine.spawn({ requestId: 'maintenance', task: 'first', permission: 'read-only' });
  const before = await finished(engine, s.id);
  const summarizing = deferred();
  provider.stream = async function* (_model, messages) {
    if (messages[0].parts[0].text.startsWith('Produce a concise continuation summary')) { summarizing.resolve(); await new Promise(() => {}); }
    yield { type: 'text', text: 'other task done' };
  };
  const pending = await engine.compact(s.id, before.revision);
  assert.equal(pending.state, 'running'); await summarizing.promise;
  const other = await engine.spawn({ requestId: 'unrelated', task: 'second', permission: 'read-only' });
  assert.equal((await finished(engine, other.id)).state, 'completed');
  const cancelled = await engine.cancel(s.id);
  assert.equal(cancelled.state, 'completed');
  assert.equal(cancelled.maintenanceError.code, 'cancelled');
  assert.equal(cancelled.messages.length, before.messages.length);
});

test('discarding follow-ups as a turn completes cannot restart discarded tasks', async t => {
  const gate = deferred(); const completing = deferred(); const release = deferred();
  const { engine, store, requests } = await fixture(t, { async *stream() { await gate.promise; yield { type: 'text', text: 'done' }; } });
  const original = store.change.bind(store); let paused = false;
  store.change = async (...args) => {
    const s = await original(...args);
    if (!paused && s.state === 'queued' && s.turns[0].state === 'completed') { paused = true; completing.resolve(); await release.promise; }
    return s;
  };
  const s = await engine.spawn({ requestId: 'discard-race', task: 'first', permission: 'read-only' });
  await until(() => requests.length === 1);
  await engine.send(s.id, 'follow', 'discard this'); gate.resolve(); await completing.promise;
  assert.equal((await engine.discardQueued(s.id)).state, 'completed'); release.resolve();
  await finished(engine, s.id);
  assert.equal(requests.length, 1);
  assert.match(store.get(s.id).turns[1].output, /Discarded/);
});

test('lease-based workers require ownership and resumption renews an expired lease', async t => {
  const { engine, store } = await fixture(t);
  await assert.rejects(engine.spawn({ requestId: 'no-owner', task: 'A', parentPolicy: 'cancel-on-expiry', permission: 'read-only' }), { code: 'invalid_arguments' });
  const s = await engine.spawn({ requestId: 'leased', ownerId: 'parent', parentPolicy: 'cancel-on-expiry', leaseSeconds: 30, task: 'A', permission: 'read-only' });
  await finished(engine, s.id);
  await store.change(s.id, d => { d.state = 'cancelled'; d.turns[0].state = 'cancelled'; d.parentExpiresAt = 1; });
  await engine.resume(s.id, 'resume');
  assert.ok(engine.session(s.id).parentExpiresAt >= Date.now() + 29_000);
});
