const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const build = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { WorkerBroker, unpack } = require(path.join(build, 'runtime'));
const { defaults } = require(path.join(build, 'engine'));
const { workspaceDirectory } = require(path.join(build, 'workspaces'));
const { SessionStore } = require(path.join(build, 'storage'));

const model = { id: 'test/private-view', name: 'Fixture', vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 };
const ownerId = 'view-owner';

async function fixture(t, enabled = true) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-private-view-')));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'base');
  const state = { enabled, documents: [], documentCalls: 0, approvals: 0, requests: 0,
    policy: { allowWrite: true, allowShell: true, numSessions: 2 } };
  state.available = [model];
  state.pool = { [model.id]: state.policy };
  let actions = [];
  const options = {
    storage: path.join(base, 'storage'), registry: path.join(base, 'registry'), roots: [root], identity: `folder:${root}`,
    provider: { models: async () => state.available, countTokens: async () => 10,
      async *stream(_selected, messages) {
        state.requests += 1;
        const action = actions.shift();
        if (action) { yield typeof action === 'function' ? action(messages) : action; }
        else { yield { type: 'text', text: 'done' }; }
      } },
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: state.pool }),
    files: { canWrite: () => true, allowShell: () => true, approveCommand: async () => { state.approvals += 1; return false; } },
    taskBoardEnabled: () => true, isolatedViewsEnabled: enabled === null ? undefined : () => state.enabled,
    openDocuments: () => { state.documentCalls += 1; return state.documents; },
    onChange() {}, onError() {}
  };
  let broker = new WorkerBroker(options);
  t.after(async () => {
    await broker.close();
    assert.match(path.basename(base), /^runtime-private-view-/);
    await fs.rm(base, { recursive: true, force: true });
  });
  await broker.start();
  const call = async (name, args) => unpack(await broker.invoke(root, name, args));
  const complete = async id => {
    await call('subagent_wait', { ids: [id], timeoutMs: 5000 });
    const session = await broker.session(root, id);
    assert.equal(session.state, 'completed', JSON.stringify(session.turns.at(-1)?.error));
    return session;
  };
  const worker = await call('subagent_spawn', { ownerId, requestId: 'worker', task: 'ready', permission: 'workspace-write', model: model.id });
  await complete(worker.id);
  const team = await call('subagent_team_create', { ownerId, requestId: 'team', name: 'Private team', description: '' });
  const joined = await call('subagent_team_update', { ownerId, requestId: 'join', teamId: team.id, expectedRevision: team.revision, addMembers: [worker.id] });
  const scope = { ownerId, teamId: team.id };
  const capture = requestId => call('subagent_snapshot_create', { ...scope, requestId });
  const bind = snapshotId => call('subagent_view_bind', { ...scope, requestId: 'bind', id: worker.id, snapshotId });
  return { root, base, state, call, capture, bind, worker, team: joined, scope, complete,
    broker: () => broker, actions: values => { actions = values; },
    restart: async () => { await broker.close(); broker = new WorkerBroker(options); await broker.start(); },
    directory: await workspaceDirectory(options.storage, root) };
}

test('private views default off; disabled calls do not open storage or change legacy routing', async t => {
  const f = await fixture(t, null);
  await assert.rejects(f.capture('disabled'), { code: 'feature_disabled' });
  await assert.rejects(fs.access(path.join(f.directory, 'isolated-views')), { code: 'ENOENT' });
  f.actions([{ type: 'call', id: 'legacy-read', name: 'read_file', input: { path: 'a.txt' } }]);
  await fs.writeFile(path.join(f.root, 'a.txt'), 'legacy current');
  await f.call('subagent_send', { ownerId, id: f.worker.id, requestId: 'legacy', message: 'read' });
  const session = await f.complete(f.worker.id);
  assert.equal(session.schema, 1);
  assert.equal(session.isolatedView, undefined);
  assert.equal(JSON.parse(session.turns.at(-1).tools[0].result).content, 'legacy current');
});

test('real bound worker uses captured unsaved content, edits and seals privately, and cannot execute shell', async t => {
  const f = await fixture(t);
  f.state.documents = [{ path: path.join(f.root, 'a.txt'), text: 'unsaved at capture', version: 1 }];
  const snapshot = await f.capture('capture');
  assert.ok(f.state.documentCalls >= 4, 'the owning-window enumeration must be queried at every capture boundary');
  const overlay = await f.bind(snapshot.id);
  const bound = await f.broker().session(f.root, f.worker.id);
  assert.equal(bound.schema, 2);
  assert.equal(bound.isolatedView.overlayId, overlay.overlayId);
  f.state.documents[0].text = 'new unsaved text';
  f.state.documents[0].version = 2;
  await fs.writeFile(path.join(f.root, 'a.txt'), 'live after capture');
  f.actions([
    { type: 'call', id: 'read', name: 'read_file', input: { path: 'a.txt' } },
    messages => {
      const read = JSON.parse(messages.flatMap(message => message.parts).filter(part => part.type === 'result').at(-1).text);
      assert.equal(read.content, 'unsaved at capture');
      return { type: 'call', id: 'write', name: 'write_file', input: { path: 'a.txt', expectedHash: read.hash, content: 'private content' } };
    },
    { type: 'call', id: 'seal', name: 'seal_submission', input: { requestId: 'worker-seal', expectedRevision: 1 } },
    { type: 'call', id: 'shell', name: 'run_command', input: { command: 'echo should-never-run', path: '.' } }
  ]);
  await f.call('subagent_send', { ownerId, id: f.worker.id, requestId: 'edit', message: 'edit and seal' });
  const session = await f.complete(f.worker.id);
  assert.match(session.turns.at(-1).tools.find(tool => tool.call.name === 'run_command').result, /isolated_shell_unavailable/);
  assert.equal(f.state.approvals, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'live after capture');
  const submissions = await f.call('subagent_view_status', { ...f.scope, kind: 'submissions' });
  assert.equal(submissions.items.length, 1);
  const submissionId = submissions.items[0].id;
  assert.equal((await f.call('subagent_submission_read', { ...f.scope, submissionId, operation: 'read_file', input: { path: 'a.txt' } })).content, 'private content');
  const search = await f.call('subagent_submission_read', { ...f.scope, submissionId, operation: 'search_files', input: { query: 'private' } });
  assert.equal(search.results[0].path, 'a.txt');
  await assert.rejects(f.call('subagent_submission_read', { ...f.scope, ownerId: 'intruder', submissionId, operation: 'read_file', input: { path: 'a.txt' } }));
});

test('reload and feature/model revocation fail closed; missing index is never reset for a marked worker', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  await f.bind(snapshot.id);
  await f.restart();
  const before = await f.broker().session(f.root, f.worker.id);
  const requests = f.state.requests;
  const send = requestId => f.call('subagent_send', { ownerId, id: f.worker.id, requestId, message: 'must not infer' });
  f.state.enabled = false;
  await assert.rejects(send('disabled'), { code: 'feature_disabled' });
  f.state.enabled = true;
  f.state.policy.allowWrite = false;
  await assert.rejects(send('revoked'), { code: 'permission_denied' });
  f.state.policy.allowWrite = true;
  assert.equal(f.state.requests, requests);
  assert.equal((await f.broker().session(f.root, f.worker.id)).turns.length, before.turns.length);
  await f.broker().close();
  const index = path.join(f.directory, 'isolated-views', 'index.json');
  const bytes = await fs.readFile(index);
  await fs.unlink(index);
  await f.restart();
  await assert.rejects(send('missing-index'), { code: 'isolation_corrupt' });
  await assert.rejects(fs.access(index), { code: 'ENOENT' });
  assert.equal((await f.broker().session(f.root, f.worker.id)).schema, 2);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'base');
  await f.broker().close();
  await fs.writeFile(index, bytes);
  await f.restart();
  await send('restored');
  await f.complete(f.worker.id);
});

test('membership revoked before Session marker rename blocks binding; exact retry recovers its intent', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  const open = fs.open;
  const target = path.join(f.directory, `${f.worker.id}.json`);
  let checkpoints = 0;
  let removed;
  fs.open = async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (!String(file).startsWith(`${target}.`) || !String(file).endsWith('.tmp') || ++checkpoints !== 2) {
      return handle;
    }
    return { writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), sync: async () => {
      await handle.sync();
      removed = await f.call('subagent_team_update', { ownerId, requestId: 'remove', teamId: f.team.id, expectedRevision: f.team.revision, removeMembers: [f.worker.id] });
    } };
  };
  try {
    await assert.rejects(f.bind(snapshot.id), { code: 'permission_denied' });
  } finally {
    fs.open = open;
  }
  assert.ok(removed);
  const session = await f.broker().session(f.root, f.worker.id);
  assert.equal(session.schema, 1);
  assert.equal(session.isolatedView, undefined);
  const pins = await f.call('subagent_view_status', { ...f.scope, kind: 'pins' });
  assert.ok(pins.items.some(pin => pin.binding?.workerId === f.worker.id));
  await f.call('subagent_team_update', { ownerId, requestId: 'rejoin', teamId: f.team.id, expectedRevision: removed.revision, addMembers: [f.worker.id] });
  const bound = await f.bind(snapshot.id);
  assert.equal((await f.broker().session(f.root, f.worker.id)).isolatedView.overlayId, bound.overlayId);
  assert.equal((await f.call('subagent_view_status', { ...f.scope, kind: 'pins' })).items.some(pin => pin.binding), false);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'base');
});

test('sealed reads, pins and cleanup remain administrable after the original root is removed', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  const overlay = await f.bind(snapshot.id);
  const seal = await f.call('subagent_view_seal', { ...f.scope, requestId: 'seal', id: f.worker.id, expectedRevision: 0 });
  f.broker().options.roots = [];
  assert.equal(path.relative(f.base, f.root), 'repo');
  await fs.rm(f.root, { recursive: true, force: true });
  const read = () => f.call('subagent_submission_read', { ...f.scope, submissionId: seal.id, operation: 'read_file', input: { path: 'a.txt' } });
  assert.equal((await read()).content, 'base');
  const pin = await f.call('subagent_view_pin', { ...f.scope, requestId: 'pin', name: 'review', resource: { kind: 'submission', id: seal.id } });
  await f.call('subagent_view_release', { ...f.scope, requestId: 'release-seal', kind: 'submission', id: seal.id });
  await f.call('subagent_view_release', { ...f.scope, requestId: 'release-view', kind: 'overlay', id: overlay.overlayId });
  await f.call('subagent_view_release', { ...f.scope, requestId: 'release-base', kind: 'snapshot', id: snapshot.id });
  await f.call('subagent_view_cleanup', { ...f.scope, requestId: 'retained-cleanup' });
  assert.equal((await read()).content, 'base');
  await f.call('subagent_view_release', { ...f.scope, requestId: 'unpin', kind: 'pin', id: pin.id });
  const cleanup = await f.call('subagent_view_cleanup', { ...f.scope, requestId: 'collect' });
  assert.ok(cleanup.deletedSnapshots.includes(snapshot.id));
  assert.ok(cleanup.deletedBlobs > 0);
  await assert.rejects(read(), { code: 'not_found' });
  await assert.rejects(f.capture('not-offline'), { code: 'workspace_changed' });
});

test('cleanup retains an unreadable original Session and releases only after confirmed file deletion', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  await f.bind(snapshot.id);
  await f.call('subagent_view_release', { ...f.scope, requestId: 'release-base', kind: 'snapshot', id: snapshot.id });
  await f.broker().close();
  const sessionFile = path.join(f.directory, `${f.worker.id}.json`);
  await fs.writeFile(sessionFile, '{unreadable original Session');
  await f.restart();
  const unknown = await f.call('subagent_view_cleanup', { ...f.scope, requestId: 'unknown-session' });
  assert.equal(unknown.complete, false);
  assert.ok(unknown.diagnosticCount > 0);
  assert.deepEqual(unknown.deletedSnapshots, []);
  assert.deepEqual(unknown.releasedOverlays, []);
  assert.equal(await fs.readFile(sessionFile, 'utf8'), '{unreadable original Session');
  assert.equal(await fs.readFile(path.join(f.directory, 'quarantine', `${f.worker.id}.json`), 'utf8'), '{unreadable original Session');
  assert.equal((await f.call('subagent_view_status', { ...f.scope, kind: 'snapshots' })).items[0].id, snapshot.id);
  await f.broker().close();
  await fs.unlink(sessionFile);
  await f.restart();
  const deleted = await f.call('subagent_view_cleanup', { ...f.scope, requestId: 'confirmed-missing' });
  assert.deepEqual(deleted.deletedSnapshots, [snapshot.id]);
  assert.equal(deleted.releasedOverlays.length, 1);
  assert.ok(deleted.deletedBlobs > 0);
});

test('shutdown drains a paused private write before releasing the workspace owner lock', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  const overlay = await f.bind(snapshot.id);
  const payload = 'private write cancelled during shutdown';
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const blob = path.join(f.directory, 'isolated-views', 'content', 'blobs', digest.slice(0, 2), digest.slice(2));
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const open = fs.open;
  fs.open = async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (!String(file).startsWith(`${blob}.`) || !String(file).endsWith('.tmp')) { return handle; }
    return { writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), sync: async () => {
      await handle.sync();
      enter();
      await released;
    } };
  };
  let closing, workerDone;
  try {
    f.actions([
      { type: 'call', id: 'read-before-close', name: 'read_file', input: { path: 'a.txt' } },
      messages => ({ type: 'call', id: 'paused-private-write', name: 'write_file', input: { path: 'a.txt', content: payload,
        expectedHash: JSON.parse(messages.flatMap(message => message.parts).filter(part => part.type === 'result').at(-1).text).hash } })
    ]);
    await f.call('subagent_send', { ownerId, id: f.worker.id, requestId: 'paused-write', message: 'write' });
    workerDone = f.complete(f.worker.id);
    await Promise.race([entered, workerDone.then(() => { throw Error('Worker completed without reaching the private write gate.'); })]);
    closing = f.broker().close();
    await fs.access(path.join(f.directory, 'owner.lock'));
    const contender = new SessionStore(f.directory);
    try {
      await assert.rejects(contender.open(), { code: 'workspace_locked' });
    } finally {
      await contender.close();
    }
  } finally {
    release();
    await Promise.allSettled([closing, workerDone]);
    fs.open = open;
  }
  await closing;
  await assert.rejects(fs.access(path.join(f.directory, 'owner.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.access(blob), { code: 'ENOENT' });
  const index = JSON.parse(await fs.readFile(path.join(f.directory, 'isolated-views', 'index.json'), 'utf8'));
  assert.equal(index.overlays[overlay.overlayId].revision, 0);
  assert.equal(index.overlays[overlay.overlayId].head, null);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'base');
  await f.restart();
  assert.equal((await f.broker().session(f.root, f.worker.id)).schema, 2);
});

test('an incomplete restored index cannot sweep content claimed by a permanent Session marker', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  await f.bind(snapshot.id);
  await f.call('subagent_view_release', { ...f.scope, requestId: 'release-creation-pin', kind: 'snapshot', id: snapshot.id });
  await f.broker().close();
  const index = path.join(f.directory, 'isolated-views', 'index.json');
  const data = JSON.parse(await fs.readFile(index, 'utf8'));
  data.overlays = {};
  const restored = JSON.stringify(data);
  await fs.writeFile(index, restored);
  await f.restart();
  await assert.rejects(f.call('subagent_view_cleanup', { ...f.scope, requestId: 'must-retain-unknown-claim' }), { code: 'isolation_corrupt' });
  assert.equal(await fs.readFile(index, 'utf8'), restored);
  const hash = crypto.createHash('sha256').update('base').digest('hex');
  const blob = path.join(f.directory, 'isolated-views', 'content', 'blobs', hash.slice(0, 2), hash.slice(2));
  assert.equal(await fs.readFile(blob, 'utf8'), 'base');
  assert.equal((await f.broker().session(f.root, f.worker.id)).schema, 2);
});

test('explicit model migration preserves a permanent view while enforcing exact target policies', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  const overlay = await f.bind(snapshot.id);
  const replacement = { ...model, id: 'test/private-replacement' };
  f.state.available.push(replacement);
  f.state.pool = { [replacement.id]: { allowWrite: true, allowShell: false } };
  const requests = f.state.requests;
  await f.call('subagent_resume', { ownerId, id: f.worker.id, requestId: 'migrate', model: replacement.id });
  const migrated = await f.broker().session(f.root, f.worker.id);
  assert.equal(migrated.model.id, replacement.id);
  assert.equal(migrated.state, 'completed');
  assert.equal(migrated.schema, 2);
  assert.equal(migrated.isolatedView.overlayId, overlay.overlayId);
  assert.equal(f.state.requests, requests, 'completed model migration must not start inference');
  await assert.rejects(f.call('subagent_resume', { ownerId, id: f.worker.id, requestId: 'bad-model', model: 'not-configured' }), { code: 'model_unavailable' });
  f.state.pool[replacement.id].allowWrite = false;
  await assert.rejects(f.call('subagent_resume', { ownerId, id: f.worker.id, requestId: 'bad-permission', model: replacement.id }), { code: 'permission_denied' });
  f.state.pool[replacement.id].allowWrite = true;
  await fs.writeFile(path.join(f.root, 'a.txt'), 'live after model migration');
  f.actions([{ type: 'call', id: 'migrated-private-read', name: 'read_file', input: { path: 'a.txt' } }]);
  await f.call('subagent_send', { ownerId, id: f.worker.id, requestId: 'after-migration', message: 'read captured bytes' });
  const complete = await f.complete(f.worker.id);
  assert.equal(JSON.parse(complete.turns.at(-1).tools[0].result).content, 'base');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'live after model migration');
});

test('pin release cannot orphan a persisted Session marker after interrupted overlay publication', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  const open = fs.open;
  let commits = 0;
  fs.open = async function(target, ...args) {
    const handle = await open.call(this, target, ...args);
    if (String(target).startsWith(path.join(f.directory, 'isolated-views', 'index.json.')) && String(target).endsWith('.tmp')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (++commits === 2) { throw Error('overlay publication interrupted'); }
        return sync();
      };
    }
    return handle;
  };
  try {
    await assert.rejects(f.bind(snapshot.id), /overlay publication interrupted/);
  } finally {
    fs.open = open;
  }
  assert.equal(commits, 2);
  await f.restart();
  const pins = await f.call('subagent_view_status', { ...f.scope, kind: 'pins' });
  const intent = pins.items.find(pin => pin.binding);
  assert.ok(intent, 'reload must retain the durable binding intent');
  await assert.rejects(f.call('subagent_view_release', { ...f.scope, requestId: 'must-not-orphan', kind: 'pin', id: intent.id }), { code: 'isolation_conflict' });
  await f.call('subagent_view_release', { ...f.scope, requestId: 'drop-creation-pin', kind: 'snapshot', id: snapshot.id });
  const recovered = await f.call('subagent_view_cleanup', { ...f.scope, requestId: 'recover' });
  assert.equal(recovered.recoveredBindings, 1);
  assert.deepEqual(recovered.deletedSnapshots, []);
  await f.restart();
  const session = await f.broker().session(f.root, f.worker.id);
  assert.equal(session.schema, 2);
  assert.equal(session.isolatedView.overlayId, intent.binding.overlayId);
  const status = await f.call('subagent_view_status', { ...f.scope });
  assert.equal(status.items[0].overlayId, intent.binding.overlayId);
  assert.equal(status.items[0].revision, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'base');
});
