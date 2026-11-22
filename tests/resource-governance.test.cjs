const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ResourceGovernor, resourceDefaults, readResourceConfig } = require('../.test-build/resource-governor');
const { WorkerBroker, unpack } = require('../.test-build/runtime');
const { defaults } = require('../.test-build/engine');
const { model, until, deferred } = require('./helpers.cjs');

async function fixture(t, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'governance-'));
  const root = path.join(dir, 'project'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'a.txt'), 'snapshot');
  const state = { config: { ...resourceDefaults, enabled: true, ...opts.config }, requests: [], models: { [model.id]: { numSessions: 4 } }, ...opts.state };
  const provider = { models: async () => [model], countTokens: async () => 10,
    async *stream(selected, messages, tools, signal) {
      state.requests.push({ selected, messages, tools });
      if (opts.stream) { yield* opts.stream(selected, messages, tools, signal, state.requests.length); }
      else { yield { type: 'text', text: 'done' }; }
    }
  };
  const options = { storage: path.join(dir, 'storage'), registry: path.join(dir, 'bridges'), roots: [root], identity: 'test', provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: state.models }),
    taskBoardEnabled: () => true, isolatedViewsEnabled: () => true, resources: () => state.config,
    resourceDirectory: path.join(dir, 'resources'), runners: () => ({ enabled: true, capacity: 1, maxQueue: 8 }),
    files: { canWrite: () => true, allowShell: () => true, approveCommand: async () => true },
    onChange: () => {}, onError: message => { state.errors ??= []; state.errors.push(message); }
  };
  let broker = new WorkerBroker(options); await broker.start();
  const f = { dir, root, state, options, get broker() { return broker; }, get local() { return broker.local.get(root); },
    call: async (name, args = {}) => unpack(await broker.invoke(root, name, args)),
    reload: async () => { await broker.close(); broker = new WorkerBroker(options); await broker.start(); },
    stopped: async id => { await until(() => !['queued','running'].includes(broker.local.get(root).store.get(id).state) && !broker.local.get(root).engine.active.has(id), 8000); return broker.session(root, id); }
  };
  t.after(async () => { await broker.close(); await fs.rm(dir, { recursive: true, force: true }); });
  f.team = await f.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  f.snapshot = await f.call('subagent_snapshot_create', { ownerId: 'parent', teamId: f.team.id, requestId: 'snapshot' });
  f.spawn = async (requestId, extra = {}) => {
    const team = await f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id });
    const task = await f.call('subagent_task_create', { ownerId: 'parent', requestId: 'task-' + requestId, teamId: team.id, title: requestId, description: '', ...extra.task });
    const input = { ownerId: 'parent', requestId, task: requestId, model: model.id, permission: 'workspace-write',
      setup: { teamId: team.id, taskId: task.id, snapshotId: f.snapshot.id, teamRevision: team.revision, taskRevision: task.revision, lane: extra.lane ?? 'work' }, ...extra.spawn };
    return { input, worker: await f.call('subagent_isolated_spawn', input), task };
  };
  return f;
}

test('legacy runner materialization fences aggregate storage but approval yields it', async t => {
  const { storageUsage } = require('../.test-build/resource-governor');
  const f = await fixture(t, { stream: async function* (_m, _messages, _tools, _signal, n) {
    if (n === 2) yield { type: 'call', id: 'command', name: 'run_command', input: { command: 'node --version' } };
    else yield { type: 'text', text: 'done' };
  } });
  await fs.writeFile(path.join(f.root, 'payload.txt'), 'p'.repeat(10 * 1024 ** 2));
  const snapshot = await f.call('subagent_snapshot_create', { ownerId: 'parent', teamId: f.team.id, requestId: 'payload-snapshot' });
  const worker = await f.call('subagent_spawn', { ownerId: 'parent', requestId: 'legacy-runner', task: 'warm', model: model.id, permission: 'workspace-write' }); await f.stopped(worker.id);
  await f.call('subagent_team_update', { ownerId: 'parent', requestId: 'legacy-member', teamId: f.team.id, expectedRevision: f.team.revision, addMembers: [worker.id] });
  await f.call('subagent_view_bind', { ownerId: 'parent', requestId: 'legacy-binding', teamId: f.team.id, id: worker.id, snapshotId: snapshot.id });
  f.state.config.storageBytes = 64 * 1024 ** 2;
  const gate = deferred(), approval = deferred(), approvalGate = deferred(); let entered = false;
  f.local.isolation.options.approveCommand = async () => { approval.resolve(); await approvalGate.promise; return false; };
  const directory = f.local.store.directory, open = fs.open, other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(path.join(directory, 'runners')) && args[0].endsWith(path.sep + 'payload.txt') && args[1] === 'wx') {
      const write = handle.writeFile.bind(handle); handle.writeFile = async (...values) => { const result = await write(...values); entered = true; await gate.promise; return result; };
    }
    return handle;
  };
  try {
    await f.call('subagent_send', { ownerId: 'parent', id: worker.id, requestId: 'legacy-command', message: 'execute' }); await until(() => entered, 8000);
    const admission = await other.tryAcquire({ key: 'materialization-race', kind: 'storage', root: 'another-root', lane: 'integration', bytes: 52 * 1024 ** 2 });
    assert.equal(admission.granted, false); assert.equal(admission.reason, 'storage');
    assert.ok(await storageUsage(directory) + 52 * 1024 ** 2 > f.state.config.storageBytes);
    await other.release('materialization-race'); gate.resolve(); await approval.promise;
    assert.equal(Object.values((await other.status()).stores)[0].write, undefined);
    assert.equal((await other.tryAcquire({ key: 'approval-progress', kind: 'storage', root: 'another-root', lane: 'integration', bytes: 1024 ** 2 })).granted, true);
    await other.release('approval-progress'); approvalGate.resolve(); await f.stopped(worker.id);
    const status = await other.status(); assert.equal(Object.values(status.stores)[0].bytes, await storageUsage(directory));
    assert.equal(status.claims.some(c => c.kind === 'runner'), false, 'legacy runners keep their original aggregate opt-in scope');
  } finally { gate.resolve(); approvalGate.resolve(); fs.open = open; await f.stopped(worker.id); await other.release('materialization-race'); await other.release('approval-progress'); await other.close(); }
});

test('registered host payload writes fence storage across opt-out and legacy maintenance', async t => {
  for (const mode of ['snapshot', 'overlay', 'change', 'finish-change', 'result']) {
    await t.test(mode, async t => {
      const { storageUsage } = require('../.test-build/resource-governor');
      const f = await fixture(t), directory = f.local.store.directory, payload = mode === 'result' ? '界'.repeat(80000) : 'x'.repeat(200000);
      const worker = await f.call('subagent_spawn', { ownerId: 'parent', requestId: 'legacy-payload', task: 'warm', model: model.id, permission: 'workspace-write' }); await f.stopped(worker.id);
      await f.call('subagent_team_update', { ownerId: 'parent', requestId: 'legacy-payload-member', teamId: f.team.id, expectedRevision: f.team.revision, addMembers: [worker.id] });
      await f.call('subagent_view_bind', { ownerId: 'parent', requestId: 'legacy-payload-binding', teamId: f.team.id, id: worker.id, snapshotId: f.snapshot.id });
      f.state.config.enabled = false; f.state.config.storageBytes = 64 * 1024 ** 2;
      const change = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', path: path.join(f.root, 'change.txt'), kind: 'write', state: 'pending', createdAt: new Date().toISOString(), before: null, after: mode === 'finish-change' ? 'small' : payload };
      if (mode === 'finish-change') { await f.local.store.recordChange(worker.id, change); change.after = payload; }
      let results, attempt;
      if (mode === 'result') {
        const { RunnerResults } = require('../.test-build/runner-results');
        results = new RunnerResults(path.join(directory, 'test-results'), f.root, { withStorageWrite: action => f.local.store.withStorageWrite(action) }); await results.open();
        const inputVersion = { snapshotId: 'a'.repeat(64), overlayId: 'b'.repeat(64), revision: 0 };
        attempt = { id: 'c'.repeat(32), owner: { ownerId: 'parent', teamId: f.team.id, workerId: worker.id, workerCreatedAt: worker.createdAt }, leaseId: 'c'.repeat(32), logicalRoot: f.root, executionDirectory: path.join(f.root, 'work'), command: 'node --version', timeoutMs: 5000, inputVersion,
          setup: { identityHash: 'd'.repeat(64), platform: 'win32', arch: 'x64', nodeVersion: 'v22.0.0', shell: 'cmd.exe', environmentHash: 'e'.repeat(64), caches: [] }, startedAt: new Date().toISOString() };
        await results.start(attempt);
      }
      await fs.writeFile(path.join(directory, 'ballast'), Buffer.alloc(32 * 1024 ** 2 - 100000 - await storageUsage(directory)));
      await f.broker.resources.account(directory, () => storageUsage(directory));
      if (mode === 'snapshot') { await fs.writeFile(path.join(f.root, 'payload.txt'), payload); }
      const gate = deferred(), open = fs.open, other = new ResourceGovernor(() => ({ ...f.state.config, enabled: true }), f.options.resourceDirectory); let entered = false, operation;
      fs.open = async (...args) => {
        const handle = await open(...args);
        if (typeof args[0] === 'string' && args[0].startsWith(directory + path.sep) && args[1] === 'wx') {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...values) => { const result = await write(...values); if (Buffer.byteLength(values[0]) >= 200000) { entered = true; await gate.promise; } return result; };
        }
        return handle;
      };
      try {
        if (mode === 'snapshot') { operation = f.call('subagent_snapshot_create', { ownerId: 'parent', teamId: f.team.id, requestId: 'opt-out-payload' }); }
        if (mode === 'overlay') { operation = f.local.isolation.scoped(f.local.store.get(worker.id)).execute('write_file', { path: 'private.txt', content: payload, expectedHash: 'new' }, 'workspace-write', new AbortController().signal); }
        if (mode === 'change') { operation = f.local.store.recordChange(worker.id, change); }
        if (mode === 'finish-change') { operation = f.local.store.finishChange(worker.id, change); }
        if (mode === 'result') { operation = results.finish(attempt.id, { outcome: 'succeeded', afterVersion: { ...attempt.inputVersion, revision: 1 }, import: 'imported', exitCode: 0, drained: true, output: payload }); }
        operation.catch(() => {}); await until(() => entered, 8000);
        const reply = await other.tryAcquire({ key: 'payload-race', kind: 'storage', root: 'other-root', lane: 'integration', bytes: 32 * 1024 ** 2 });
        assert.equal(reply.granted, false); assert.equal(reply.reason, 'storage');
        assert.equal(Object.values((await other.status()).stores)[0].write.state, 'active');
        assert.ok(await storageUsage(directory) + 32 * 1024 ** 2 > f.state.config.storageBytes);
        gate.resolve(); await operation;
        const retained = Object.values((await other.status()).stores)[0]; assert.equal(retained.write, undefined); assert.ok(retained.bytes >= await storageUsage(directory));
      } finally { gate.resolve(); fs.open = open; await operation?.catch(() => {}); await results?.close(); await other.release('payload-race'); await other.close(); }
    });
  }
});

test('runner cancellation and shutdown wait for aggregate admission cleanup', async t => {
  const { RunnerPool } = require('../.test-build/runner-pool');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-cancel-drain-')), root = path.join(dir, 'project'); await fs.mkdir(root);
  const entered = deferred(), gate = deferred(), controller = new AbortController(); let settled = false, closed = false;
  const pool = new RunnerPool(path.join(dir, 'pool'), { projectRoot: root, capacity: 2, maxQueue: 1, admission: { applies: () => true, tryAcquire: async () => false, cancel: async () => { entered.resolve(); await gate.promise; }, reconcile: async () => {} } }); await pool.open();
  t.after(async () => { gate.resolve(); await pool.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const pending = pool.acquire({ ownerId: 'parent', teamId: 'a'.repeat(32), workerId: 'b'.repeat(32), workerCreatedAt: new Date().toISOString() }, controller.signal).then(() => { settled = true; throw Error('unexpected runner grant'); }, error => { settled = true; return error; });
  await until(() => pool.waiters.length === 1 && !pool.waiters[0].claimed);
  controller.abort(); await entered.promise;
  const closing = pool.close().then(() => { closed = true; });
  try { await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(settled, false); assert.equal(closed, false); }
  finally { gate.resolve(); }
  assert.equal((await pending).code, 'pool_aborted'); await closing;
  assert.equal(pool.status().closed, true);
});

test('physical store aliases preserve retained model ownership and one storage charge', async t => {
  if (process.platform !== 'win32') { t.skip('Windows case/junction aliases'); return; }
  for (const mode of ['case', 'junction']) {
    await t.test(mode, async t => {
      const entered = deferred(), gate = deferred();
      const f = await fixture(t, { state: { models: { [model.id]: { numSessions: 1 } } }, stream: async function* (_m, _messages, _tools, _signal, n) { if (n === 1) { entered.resolve(); await gate.promise; } yield { type: 'text', text: 'done' }; } });
      let alias = f.options.storage.toUpperCase();
      if (mode === 'junction') {
        alias = path.join(f.dir, 'storage-alias');
        try { await fs.symlink(f.options.storage, alias, 'junction'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('junction creation unavailable'); return; } throw error; }
      }
      await f.spawn('alias-owner'); await entered.promise;
      const original = f.local.store.directory, oldLifecycle = f.local.lifecycle;
      await f.broker.close();
      const broker = new WorkerBroker({ ...f.options, storage: alias });
      try {
        await broker.start();
        assert.equal((await broker.resources.modelReservations(broker.local.get(f.root).store.directory)).length, 1);
        const legacy = unpack(await broker.invoke(f.root, 'subagent_spawn', { ownerId: 'legacy', requestId: 'aliased-legacy', task: 'legacy', model: model.id }));
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(f.state.requests.length, 1); assert.equal(broker.local.get(f.root).engine.active.has(legacy.id), false);
        const stores = Object.values((await broker.resources.status()).stores);
        assert.equal(stores.length, 1); assert.equal(stores[0].directory, original);
        gate.resolve(); await until(() => oldLifecycle.inference.size === 0);
        await until(() => broker.local.get(f.root).store.get(legacy.id).state === 'completed' && !broker.local.get(f.root).engine.active.has(legacy.id), 8000);
        assert.equal(f.state.requests.length, 2);
      } finally { gate.resolve(); await broker.close(); await until(() => oldLifecycle.inference.size === 0); }
    });
  }
});

test('aliased storage resolves checkpoint quarantine and runner admission in the original scope', async t => {
  if (process.platform !== 'win32') { t.skip('Windows path alias'); return; }
  const f = await fixture(t), original = f.local.store.directory, { storageUsage } = require('../.test-build/resource-governor');
  await f.local.store.mutex.run(() => f.broker.resources.withStoreWrite(original, async () => undefined, async () => { throw Error('interrupted owned measurement'); }, () => {}));
  await f.broker.close();
  const broker = new WorkerBroker({ ...f.options, storage: f.options.storage.toUpperCase() });
  const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
  try {
    await broker.start();
    const local = broker.local.get(f.root), stores = Object.values((await other.status()).stores);
    assert.equal(stores.length, 1); assert.equal(stores[0].write, undefined); assert.equal(stores[0].directory, original);
    assert.equal(stores[0].bytes, await storageUsage(local.store.directory));
    const owner = { ownerId: 'parent', teamId: f.team.id, workerId: 'f'.repeat(32), workerCreatedAt: new Date().toISOString() };
    const a = broker.resources.runnerAdmission(path.join(original, 'runners', 'pool'), f.root, () => 'work');
    const b = other.runnerAdmission(path.join(local.store.directory, 'runners', 'pool'), f.root, () => 'work');
    try {
      assert.equal(await a.tryAcquire('a'.repeat(32), owner, 2), true);
      assert.equal(await b.tryAcquire('b'.repeat(32), owner, 2), false, 'aliases cannot create another local work slot');
      assert.equal(await other.hasScope(path.join(local.store.directory, 'runners', 'pool')), true);
      await a.reconcile([{ leaseId: 'a'.repeat(32), state: 'released' }]);
      assert.equal(await b.tryAcquire('b'.repeat(32), owner, 2), true);
    } finally { await a.cancel('a'.repeat(32)); await b.cancel('b'.repeat(32)); }
  } finally { await broker.close(); await other.close(); }
});

test('legacy alias model scopes upgrade without freeing retained ownership or changing keys', async t => {
  if (process.platform !== 'win32') { t.skip('Windows path alias'); return; }
  const f = await fixture(t), g = f.broker.resources, directory = f.local.store.directory;
  const request = key => ({ key, kind: 'model', root: f.root, scope: directory, model: model.id, localCapacity: 1 });
  try {
    assert.equal((await g.tryAcquire(request('old-alias'))).granted, true);
    await g.transaction(data => { data.claims.find(c => c.key === 'old-alias').scope = directory.toUpperCase(); });
    assert.deepEqual(await g.modelReservations(directory), [{ key: 'old-alias', model: model.id }]);
    assert.equal((await g.tryAcquire(request('new-alias'))).granted, false);
    assert.equal((await g.status()).claims.find(c => c.key === 'old-alias').scope, directory);
  } finally { await g.release('old-alias'); await g.release('new-alias'); }
});

test('copying local registration into another physical store fails instead of sharing its budget', async t => {
  const f = await fixture(t), directory = f.local.store.directory, clone = path.join(f.dir, 'copied-store'); await fs.mkdir(clone);
  for (const name of ['resource-store.json', 'resource-store.json.namespace']) { await fs.copyFile(path.join(directory, name), path.join(clone, name)); }
  await assert.rejects(f.broker.resources.account(clone, async () => 1), e => e.code === 'resource_corrupt' && /physical store/.test(e.message));
  await assert.rejects(f.broker.resources.tryAcquire({ key: 'copied-scope', kind: 'model', root: f.root, scope: clone, model: model.id }), e => e.code === 'resource_corrupt');
  assert.equal(Object.values((await f.broker.resources.status()).stores).length, 1);
});


test('unused opted-out legacy stores ignore corrupt and locked aggregate ledgers across reload', async t => {
  for (const fault of ['corrupt', 'locked']) {
    await t.test(fault, async t => {
      const f = await fixture(t), root = path.join(f.dir, 'legacy-project'); await fs.mkdir(root);
      const ledger = path.join(f.options.resourceDirectory, 'ledger.json'), saved = await fs.readFile(ledger), lock = path.join(f.options.resourceDirectory, 'transaction.lock');
      const options = { ...f.options, roots: [root], storage: path.join(f.dir, 'legacy-storage'), registry: path.join(f.dir, 'legacy-registry'), resources: () => ({ ...resourceDefaults, enabled: false }), taskBoardEnabled: () => false, isolatedViewsEnabled: () => false };
      let broker = new WorkerBroker(options), aggregateReads = 0;
      const forbidAggregate = () => { broker.resources.hasState = async () => { aggregateReads++; throw Error('unused legacy store consulted the aggregate namespace'); }; };
      forbidAggregate();
      if (fault === 'corrupt') { await fs.writeFile(ledger, '{}'); } else { await fs.writeFile(lock, 'foreign locked host', { flag: 'wx' }); }
      const call = async (name, args) => unpack(await broker.invoke(root, name, args));
      const stopped = async id => until(() => !['queued', 'running'].includes(broker.local.get(root).store.get(id).state) && !broker.local.get(root).engine.active.has(id));
      try {
        await broker.start();
        const input = { ownerId: 'legacy', requestId: 'legacy', task: 'legacy', model: model.id }, worker = await call('subagent_spawn', input); await stopped(worker.id);
        const directory = broker.local.get(root).store.directory;
        await broker.local.get(root).store.change(worker.id, s => { s.state = 'queued'; s.turns[0].state = 'queued'; });
        await broker.close(); broker = new WorkerBroker(options); forbidAggregate(); await broker.start();
        assert.equal((await broker.session(root, worker.id)).state, 'interrupted');
        await call('subagent_resume', { ownerId: 'legacy', id: worker.id, requestId: 'resume' }); await stopped(worker.id);
        const before = await broker.session(root, worker.id);
        await call('subagent_compact', { ownerId: 'legacy', id: worker.id, revision: before.revision, summary: 'legacy history' });
        await call('subagent_delete', { ownerId: 'legacy', id: worker.id });
        const fresh = await call('subagent_spawn', input); await stopped(fresh.id); assert.equal(fresh.id, worker.id);
        await assert.rejects(fs.lstat(path.join(directory, 'resource-store.json')), e => e.code === 'ENOENT');
        assert.equal(aggregateReads, 0);
      } finally { if (fault === 'locked') { await fs.unlink(lock); } await fs.writeFile(ledger, saved); await broker.close(); }
    });
  }
});

test('local store registration survives opt-out and fails closed on missing ownership metadata', async t => {
  for (const fault of ['ledger', 'registration', 'namespace']) {
    await t.test(fault, async t => {
      const f = await fixture(t), directory = f.local.store.directory, savedLedger = await fs.readFile(path.join(f.options.resourceDirectory, 'ledger.json'));
      const marker = path.join(directory, 'resource-store.json'), text = await fs.readFile(marker, 'utf8');
      assert.equal(JSON.parse(text).state, 'registered');
      f.state.config.enabled = false;
      if (fault === 'ledger') { await fs.writeFile(path.join(f.options.resourceDirectory, 'ledger.json'), '{}'); }
      if (fault === 'registration') { await fs.unlink(marker); }
      if (fault === 'namespace') { await fs.writeFile(marker + '.namespace', '{}'); }
      try { await assert.rejects(f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'registered-opt-out', task: 'legacy', model: model.id }), e => e.code === 'resource_corrupt'); }
      finally {
        if (fault === 'ledger') {
          // No ledger effects ran in the rejected call: restore the exact owned document.
          await fs.writeFile(path.join(f.options.resourceDirectory, 'ledger.json'), savedLedger);
        }
      }
    });
  }
});

test('pending local registration recovers interruption before and after global publication', async t => {
  for (const phase of ['global-record', 'local-confirmation']) {
    await t.test(phase, async t => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-registration-')), store = path.join(dir, 'store'); await fs.mkdir(store);
      const governor = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true }), path.join(dir, 'resources'));
      t.after(async () => { await governor.close(); await fs.rm(dir, { recursive: true, force: true }); });
      const rename = fs.rename; let fail = true;
      // A NEW store publishes its local PENDING marker inside its own admitting
      // transaction, so a definitive refusal never enrolls it. Both faults
      // therefore land AFTER that durable fence exists: the aggregate record that
      // would confirm it is what gets interrupted, never pre-admission publication.
      const marker = path.join(store, 'resource-store.json'), ledger = path.join(dir, 'resources', 'ledger.json');
      const marked = () => fs.lstat(marker).then(() => true, error => {
        if (error.code === 'ENOENT') {
          return false;
        } throw error;
      });
      if (phase === 'global-record') {
        // Interrupt the aggregate publication that FOLLOWS the pending marker; the
        // initial empty-ledger bootstrap has no local marker yet and is ignored.
        fs.rename = async (...args) => { if (fail && args[1] === ledger && await marked()) { fail = false; throw Error('interrupted registration'); } return rename(...args); };
      } else {
        fs.rename = async (...args) => { if (args[1] === marker && fail && JSON.parse(await fs.readFile(args[0], 'utf8')).state === 'registered') { fail = false; throw Error('interrupted registration'); } return rename(...args); };
      }
      try { await assert.rejects(governor.account(store, async () => 100), /interrupted registration/); }
      finally { fs.rename = rename; }
      assert.equal(JSON.parse(await fs.readFile(path.join(store, 'resource-store.json'), 'utf8')).state, 'pending');
      await governor.account(store, async () => 200);
      assert.equal(JSON.parse(await fs.readFile(path.join(store, 'resource-store.json'), 'utf8')).state, 'registered');
      assert.equal(Object.values((await governor.status()).stores)[0].bytes, 200);
      assert.equal(await governor.hasStore(store), true);
    });
  }
});

test('operational recovery failures preserve valid checkpoints and permit a clean retry', async t => {
  for (const fault of ['ledger-read', 'checkpoint-write', 'accounting']) {
    await t.test(fault, async t => {
      const f = await fixture(t), { worker } = await f.spawn('recovery-' + fault); await f.stopped(worker.id);
      await f.local.store.change(worker.id, s => { s.state = 'queued'; s.turns[0].state = 'queued'; });
      const directory = f.local.store.directory, checkpoint = path.join(directory, worker.id + '.json'); await f.broker.close();
      const reopened = new WorkerBroker(f.options), readFile = fs.readFile, rename = fs.rename, account = reopened.resources.account.bind(reopened.resources);
      let fail = true;
      if (fault === 'ledger-read') { fs.readFile = async (...args) => { if (args[0] === path.join(f.options.resourceDirectory, 'ledger.json') && fail) { fail = false; throw Object.assign(Error('transient ledger read'), { code: 'EACCES' }); } return readFile(...args); }; }
      if (fault === 'checkpoint-write') { fs.rename = async (...args) => { if (args[1] === checkpoint && fail) { fail = false; throw Object.assign(Error('transient checkpoint write'), { code: 'EIO' }); } return rename(...args); }; }
      if (fault === 'accounting') { reopened.resources.account = async (...args) => { if (fail) { fail = false; throw Error('transient checkpoint accounting'); } return account(...args); }; }
      try { await assert.rejects(reopened.start(), /transient/); }
      finally { fs.readFile = readFile; fs.rename = rename; reopened.resources.account = account; await reopened.close(); }
      await fs.lstat(checkpoint);
      assert.deepEqual(await fs.readdir(path.join(directory, 'quarantine')).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []);
      const retry = new WorkerBroker(f.options);
      try { await retry.start(); assert.equal((await retry.session(f.root, worker.id)).state, 'interrupted'); assert.equal(f.state.requests.length, 1); }
      finally { await retry.close(); }
    });
  }
});


test('reload and offline opening fence recovery checkpoint bytes before publication', async t => {
  for (const mode of ['reload', 'offline']) {
    await t.test(mode, async t => {
      const f = await fixture(t), worker = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'opening-checkpoint', task: 'legacy', model: model.id }); await f.stopped(worker.id);
      await f.local.store.change(worker.id, s => { s.state = 'queued'; s.turns[0].state = 'queued'; });
      const file = path.join(f.local.store.directory, worker.id + '.json'), entered = deferred(), gate = deferred(), original = fs.rename;
      const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
      fs.rename = async (...args) => { if (args[1] === file) { entered.resolve(); await gate.promise; } return original(...args); };
      if (mode === 'offline') { f.options.roots = []; }
      const opening = mode === 'reload' ? f.reload() : f.broker.session(f.root, worker.id);
      try {
        await entered.promise;
        assert.deepEqual(await other.tryAcquire({ key: 'opening-checkpoint', kind: 'storage', root: 'another-root', bytes: 1 }), { granted: false, reason: 'storage' });
        gate.resolve(); fs.rename = original; await opening;
        assert.equal((await f.broker.session(f.root, worker.id)).state, 'interrupted');
        assert.equal(f.state.requests.length, 1);
        assert.equal((await other.tryAcquire({ key: 'opening-checkpoint', kind: 'storage', root: 'another-root', bytes: 1 })).granted, true);
      } finally { gate.resolve(); fs.rename = original; await opening; await other.release('opening-checkpoint'); await other.close(); }
    });
  }
});

test('opening checkpoint recovery cannot bootstrap a missing established resource ledger', async t => {
  const f = await fixture(t), { worker } = await f.spawn('missing-opening-ledger'); await f.stopped(worker.id);
  await f.local.store.change(worker.id, s => { s.state = 'queued'; s.turns[0].state = 'queued'; });
  await f.broker.close();
  assert.equal(f.options.resourceDirectory, path.join(f.dir, 'resources'));
  await fs.rm(f.options.resourceDirectory, { recursive: true, force: true });
  await assert.rejects(f.reload(), e => e.code === 'resource_corrupt');
  await assert.rejects(fs.lstat(f.options.resourceDirectory), e => e.code === 'ENOENT');
  assert.equal(f.state.requests.length, 1);
});

test('cancel and expiry drain detached model admission cleanup before reporting a stopped worker', async t => {
  for (const mode of ['cancel', 'expiry']) {
    await t.test(mode, async t => {
      const f = await fixture(t), { worker } = await f.spawn('drain-' + mode, { spawn: { parentPolicy: 'cancel-on-expiry', leaseSeconds: 30 } }); await f.stopped(worker.id);
      f.state.models[model.id].numSessions = 1;
      const providerGate = deferred(), providerEntered = deferred();
      f.options.provider.stream = async function* () { providerEntered.resolve(); await providerGate.promise; yield { type: 'text', text: 'done' }; };
      const legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'hold-' + mode, task: 'hold', model: model.id }); await providerEntered.promise;
      await f.call('subagent_send', { ownerId: 'parent', id: worker.id, requestId: 'queued-turn', message: 'queued' });
      await until(() => f.local.store.get(worker.id).waitingReason === 'model_capacity');
      const resources = f.broker.resources, release = resources.release.bind(resources), entered = deferred(), gate = deferred(); let finished = false, stopping;
      resources.release = async key => { if (key.startsWith('model:')) { entered.resolve(); await gate.promise; } return release(key); };
      try {
        if (mode === 'expiry') { await f.local.store.change(worker.id, s => { s.parentExpiresAt = 1; }); }
        stopping = (mode === 'cancel' ? f.call('subagent_cancel', { ownerId: 'parent', id: worker.id }) : f.local.engine.expireParents()).then(value => { finished = true; return value; });
        await entered.promise; await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(finished, false, 'the control must retain the worker until its queue ticket is removed');
        assert.equal(f.local.engine.active.has(worker.id), true);
        gate.resolve(); await stopping; await f.stopped(worker.id);
        assert.equal((await f.call('subagent_resource_status')).claims.some(c => c.kind === 'model'), false);
        providerGate.resolve(); await f.stopped(legacy.id);
      } finally { gate.resolve(); providerGate.resolve(); resources.release = release; await stopping; }
    });
  }
});


test('retained command inputs survive deleting the last governed worker and opting out', { timeout: 45000 }, async t => {
  for (const mode of ['local', 'reload', 'offline', 'compacted-identities']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { stream: async function* (_m, messages) {
        if (!messages.some(m => m.role === 'assistant')) { yield { type: 'call', id: 'command', name: 'run_command', input: { command: 'node -e "process.stdout.write(\'ok\')"' } }; }
        else { yield { type: 'text', text: 'done' }; }
      } });
      const { worker } = await f.spawn('retained-input'), completed = await f.stopped(worker.id);
      const result = JSON.parse(completed.turns[0].tools[0].result), scope = { ownerId: 'parent', teamId: f.team.id }, directory = f.local.store.directory;
      assert.equal(result.outcome, 'succeeded');
      await assert.rejects(fs.lstat(path.join(directory, 'evidence-retention.json')), e => e.code === 'ENOENT');
      await f.call('subagent_delete', { ownerId: 'parent', id: worker.id });
      if (mode === 'compacted-identities') {
        await f.call('subagent_metadata_rollover', { ...scope, kind: 'board', expectedEpoch: 0 });
        assert.equal(await f.local.store.collectRetired('parent', 1), 1);
        await fs.rmdir(path.join(directory, 'retired-workers'));
      }
      f.state.config.enabled = false;
      if (mode === 'reload' || mode === 'compacted-identities') { await f.reload(); }
      if (mode === 'offline') { f.options.roots = []; }
      await assert.rejects(f.call('subagent_view_release', { ...scope, requestId: 'release-retained-input', kind: 'submission', id: result.attempt.inputArtifact.id }), e => e.code === 'artifact_retained');
      const cleanup = await f.call('subagent_view_cleanup', { ...scope, requestId: 'cleanup-retained-input' });
      assert.equal(cleanup.deletedSubmissions, 0);
      assert.equal((await f.call('subagent_submission_read', { ...scope, submissionId: result.attempt.inputArtifact.id, operation: 'read_file', input: { path: 'a.txt' } })).content, 'snapshot');
      assert.equal((await f.call('subagent_runner_result', { ...scope, id: result.id })).result.attempt.inputArtifact.id, result.attempt.inputArtifact.id);
      assert.equal(f.state.requests.length, 2, 'retention/reload never replays a command or provider request');
    });
  }
});

test('unreserved legacy checkpoint measurements fence cross-root admission and reject older samples', async t => {
  for (const enabled of [true, false]) {
    await t.test(String(enabled), async t => {
      const f = await fixture(t), { storageUsage } = require('../.test-build/resource-governor'), directory = f.local.store.directory;
      const initial = await storageUsage(directory); f.state.config.storageBytes = 64 * 1024 ** 2;
      await fs.writeFile(path.join(directory, 'retained.bin'), Buffer.alloc(32 * 1024 ** 2 - initial - 100000));
      await f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id });
      f.state.config.enabled = enabled;
      const other = new ResourceGovernor(() => ({ ...f.state.config, enabled: true }), f.options.resourceDirectory);
      const oldGate = deferred(), oldEntered = deferred(), writeGate = deferred(), writeEntered = deferred();
      const resources = f.broker.resources, original = resources.account.bind(resources);
      let growing, reading, reads = 0;
      const old = other.account(directory, async () => { const bytes = await storageUsage(directory); oldEntered.resolve(); await oldGate.promise; return bytes; });
      try {
        await oldEntered.promise;
        resources.account = (directory, measure) => original(directory, async () => { writeEntered.resolve(); await writeGate.promise; return measure(); });
        growing = f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'legacy-measurement', task: 'x'.repeat(200000), model: model.id });
        await writeEntered.promise; oldGate.resolve(); await old;
        const status = await other.status(), store = Object.values(status.stores).find(s => s.directory === directory);
        assert.equal(store.write.state, 'active');
        assert.ok((await storageUsage(directory)) + 32 * 1024 ** 2 > f.state.config.storageBytes);
        assert.deepEqual(await other.tryAcquire({ key: 'racing-root', kind: 'storage', root: 'another-root', lane: 'integration', bytes: 32 * 1024 ** 2 }), { granted: false, reason: 'storage' });
        reading = other.account(directory, async () => { reads++; return storageUsage(directory); });
        await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(reads, 0, 'foreign samples cannot erase a live write fence');
        writeGate.resolve(); resources.account = original;
        const worker = await growing; await f.stopped(worker.id); await reading;
        const after = Object.values((await other.status()).stores).find(s => s.directory === directory);
        assert.equal(after.write, undefined); assert.equal(after.bytes, await storageUsage(directory));
        await assert.rejects(other.tryAcquire({ key: 'racing-root', kind: 'storage', root: 'another-root', lane: 'integration', bytes: 32 * 1024 ** 2 }), e => e.code === 'storage_exhausted');
      } finally {
        oldGate.resolve(); writeGate.resolve(); resources.account = original;
        await Promise.allSettled([old, growing, reading]); await other.release('racing-root'); await other.close();
      }
    });
  }
});

test('checkpoint fencing precedes the first filesystem write and clears only after reconciliation', async t => {
  const f = await fixture(t), { digest } = require('../.test-build/storage'), gate = deferred(), entered = deferred(), original = fs.open;
  const id = digest([digest(['legacy', 'before-write']), f.root]).slice(0, 32), file = path.join(f.local.store.directory, id + '.json');
  const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
  fs.open = async (...args) => { if (args[0] === file && args[1] === 'wx') { entered.resolve(); await gate.promise; } return original(...args); };
  const creating = f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'before-write', task: 'legacy', model: model.id });
  try {
    await entered.promise; await assert.rejects(fs.lstat(file), e => e.code === 'ENOENT');
    assert.deepEqual(await other.tryAcquire({ key: 'before-write', kind: 'storage', root: 'another-root', bytes: 1 }), { granted: false, reason: 'storage' });
    gate.resolve(); fs.open = original;
    const worker = await creating; await f.stopped(worker.id);
    assert.equal((await other.tryAcquire({ key: 'before-write', kind: 'storage', root: 'another-root', bytes: 1 })).granted, true);
  } finally { gate.resolve(); fs.open = original; await creating; await other.release('before-write'); await other.close(); }
});

test('failed checkpoint measurement retains a write quarantine and reload rescans without replay', async t => {
  const f = await fixture(t), resources = f.broker.resources, original = resources.account.bind(resources), { storageUsage } = require('../.test-build/resource-governor');
  resources.account = directory => original(directory, async () => { throw Error('checkpoint scan interrupted'); });
  const worker = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'failed-fence', task: 'legacy', model: model.id });
  assert.equal((await f.stopped(worker.id)).state, 'completed');
  const directory = f.local.store.directory;
  let status = await resources.status(); assert.equal(Object.values(status.stores).find(s => s.directory === directory).write.state, 'quarantine');
  resources.account = original;
  await assert.rejects(resources.account(directory, () => storageUsage(directory)), e => e.code === 'storage_quarantine');
  await assert.rejects(resources.recoverStoreWrite(directory, async () => { throw Error('repair scan failed'); }), /repair scan failed/);
  assert.equal((await resources.tryAcquire({ key: 'quarantined-write', kind: 'storage', root: 'another-root', bytes: 1 })).reason, 'quarantine');
  await resources.release('quarantined-write');
  await f.reload();
  status = await f.broker.resources.status();
  const recovered = Object.values(status.stores).find(s => s.directory === directory);
  assert.equal(recovered.write, undefined); assert.equal(recovered.uncertain, false); assert.equal(recovered.bytes, await storageUsage(directory));
  assert.equal(f.state.requests.length, 1, 'reload repairs accounting and does not replay inference');
});


test('retired governed identities reject legacy spawn before and after collection, reload and opt-out', async t => {
  const f = await fixture(t), { worker, input } = await f.spawn('retired-identity'); await f.stopped(worker.id);
  const legacy = { ...input }; delete legacy.setup;
  await f.call('subagent_delete', { ownerId: 'parent', id: worker.id });
  await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === 'request_expired');
  await f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 0 });
  assert.equal((await f.call('subagent_resource_collect', { ownerId: 'parent', teamId: f.team.id })).tombstones, 1);
  const directory = f.local.store.directory;
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'retired-worker-identities.json'), 'utf8')).ids, [worker.id]);
  await assert.rejects(fs.lstat(path.join(directory, 'retired-workers', worker.id + '.json')), e => e.code === 'ENOENT');
  await f.reload(); f.state.config.enabled = false;
  f.options.taskBoardEnabled = () => false; f.options.isolatedViewsEnabled = () => false;
  await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === 'request_expired');
  assert.equal(f.state.requests.length, 1); assert.equal(f.local.store.list().length, 0);
  const fresh = { ...legacy, requestId: 'ordinary-legacy' };
  const first = await f.call('subagent_spawn', fresh); await f.stopped(first.id);
  await f.call('subagent_delete', { ownerId: 'parent', id: first.id });
  const replay = await f.call('subagent_spawn', fresh); await f.stopped(replay.id);
  assert.equal(replay.id, first.id, 'unrelated legacy delete/recreate semantics stay unchanged');
  assert.ok(f.state.requests.at(-1).tools.some(tool => tool.name === 'write_file'));
});

test('pre-creation parent cancellation reserves its identity against legacy spawn', async t => {
  const f = await fixture(t), input = await prepared(f, 'cancelled-identity'), pause = pauseCreation(f);
  const starting = f.call('subagent_isolated_spawn', input), rejected = assert.rejects(starting, e => e.code === 'cancelled');
  await pause.entered.promise; await f.call('subagent_parent', { ownerId: 'parent', action: 'stop' }); await rejected; pause.gate.resolve();
  const legacy = { ...input }; delete legacy.setup;
  await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === 'request_expired');
  assert.equal(f.state.requests.length, 0); assert.equal(f.local.store.list().length, 0);
});

test('interrupted tombstone collection publishes its identity fence before deleting request payloads', async t => {
  const f = await fixture(t), { worker, input } = await f.spawn('interrupted-identity'); await f.stopped(worker.id);
  const legacy = { ...input }; delete legacy.setup;
  await f.call('subagent_delete', { ownerId: 'parent', id: worker.id });
  await f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 0 });
  const unlink = fs.unlink, tombstone = path.join(f.local.store.directory, 'retired-workers', worker.id + '.json');
  fs.unlink = async file => { if (file === tombstone) { throw Object.assign(Error('interrupted collection'), { code: 'EIO' }); } return unlink(file); };
  try { await assert.rejects(f.call('subagent_resource_collect', { ownerId: 'parent', teamId: f.team.id }), /interrupted collection/); }
  finally { fs.unlink = unlink; }
  await fs.lstat(tombstone);
  await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === 'request_expired');
  await f.reload();
  assert.equal((await f.call('subagent_resource_collect', { ownerId: 'parent', teamId: f.team.id })).tombstones, 1);
  await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === 'request_expired');
  assert.equal(f.state.requests.length, 1);
});

test('compacted worker identity metadata fails closed, recovers an interrupted marker and enforces its immutable cap', async t => {
  for (const mode of ['missing', 'corrupt', 'marker', 'capacity']) {
    await t.test(mode, async t => {
      const f = await fixture(t), { worker, input } = await f.spawn('identity-' + mode); await f.stopped(worker.id);
      await f.call('subagent_delete', { ownerId: 'parent', id: worker.id });
      await f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 0 });
      await f.call('subagent_resource_collect', { ownerId: 'parent', teamId: f.team.id });
      const file = path.join(f.local.store.directory, 'retired-worker-identities.json');
      const legacy = { ...input }; delete legacy.setup;
      if (mode === 'missing') { await fs.unlink(file); }
      if (mode === 'corrupt') { await fs.writeFile(file, '{}'); }
      if (mode === 'marker') { await fs.unlink(file + '.namespace'); }
      if (mode === 'capacity') {
        const ids = Array.from({ length: 4095 }, (_, n) => n.toString(16).padStart(32, '0')); ids.push(worker.id);
        await fs.writeFile(file, JSON.stringify({ schema: 1, ids }));
        const task = await f.call('subagent_task_create', { ownerId: 'parent', requestId: 'e1:capacity-task', teamId: f.team.id, title: 'capacity', description: '' });
        const team = await f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id });
        const fresh = { ...input, requestId: 'e1:no-identity-capacity', setup: { ...input.setup, taskId: task.id, taskRevision: task.revision, teamRevision: team.revision } };
        await assert.rejects(f.call('subagent_isolated_spawn', fresh), e => e.code === 'receipt_capacity' && /migration/.test(e.message));
      }
      await f.reload();
      await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === (mode === 'missing' || mode === 'corrupt' ? 'retention_corrupt' : 'request_expired'));
      if (mode === 'marker') { await fs.lstat(file + '.namespace'); }
      assert.equal(f.state.requests.length, 1);
    });
  }
});

test('legacy checkpoints refresh registered storage across hosts, opt-out and reload without acquiring execution slots', async t => {
  const f = await fixture(t), directory = f.local.store.directory;
  const { storageUsage } = require('../.test-build/resource-governor');
  const initial = await storageUsage(directory); f.state.config.storageBytes = 64 * 1024 ** 2;
  await fs.writeFile(path.join(directory, 'retained.bin'), Buffer.alloc(32 * 1024 ** 2 - initial - 100000));
  await f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id });
  const other = new ResourceGovernor(() => ({ ...f.state.config, enabled: true }), f.options.resourceDirectory);
  const charge = async () => Object.values((await other.status()).stores).find(s => s.directory === directory).bytes;
  const exact = async () => assert.equal(await charge(), await storageUsage(directory));
  try {
    const legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'growing', task: 'x'.repeat(200000), model: model.id }); await f.stopped(legacy.id);
    await exact();
    await assert.rejects(other.tryAcquire({ key: 'cross-root-storage', kind: 'storage', root: 'another-root', lane: 'integration', bytes: 32 * 1024 ** 2 }), e => e.code === 'storage_exhausted');
    f.state.config.enabled = false; await f.reload();
    await f.call('subagent_send', { ownerId: 'legacy', id: legacy.id, requestId: 'follow-up', message: 'y'.repeat(100000) }); await f.stopped(legacy.id);
    await exact();
    const before = await f.broker.session(f.root, legacy.id);
    await f.call('subagent_compact', { ownerId: 'legacy', id: legacy.id, revision: before.revision, summary: 'legacy summary' });
    await exact();
    await f.call('subagent_delete', { ownerId: 'legacy', id: legacy.id }); await exact();
    assert.equal((await other.status()).claims.length, 0);
  } finally { await other.release('cross-root-storage'); await other.close(); }
});

test('legacy accounting failures preserve execution while storage admission stays quarantined', async t => {
  const f = await fixture(t), resources = f.broker.resources, original = resources.account.bind(resources);
  resources.account = directory => original(directory, async () => { throw Error('unreadable legacy storage'); });
  try {
    const worker = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'accounting-failure', task: 'legacy', model: model.id });
    assert.equal((await f.stopped(worker.id)).state, 'completed');
    assert.ok(f.state.errors.some(message => /Legacy storage accounting.*unreadable legacy storage/.test(message)));
    assert.equal((await resources.tryAcquire({ key: 'blocked-by-accounting', kind: 'storage', root: 'another-root', bytes: 1 })).reason, 'quarantine');
  } finally { resources.account = original; await resources.recoverStoreWrite(f.local.store.directory, () => require('../.test-build/resource-governor').storageUsage(f.local.store.directory)); await resources.release('blocked-by-accounting'); }
});

test('offline snapshot cleanup refreshes shared storage and restores admission even after opt-out', async t => {
  for (const enabled of [true, false]) {
    await t.test(String(enabled), async t => {
      const f = await fixture(t), { storageUsage } = require('../.test-build/resource-governor');
      await fs.writeFile(path.join(f.root, 'payload.txt'), 'p'.repeat(10 * 1024 ** 2));
      const snapshot = await f.call('subagent_snapshot_create', { ownerId: 'parent', teamId: f.team.id, requestId: 'large-snapshot' });
      const directory = f.local.store.directory, other = new ResourceGovernor(() => ({ ...f.state.config, enabled: true }), f.options.resourceDirectory);
      f.state.config.storageBytes = 64 * 1024 ** 2;
      const request = { key: 'after-cleanup', kind: 'storage', root: 'another-root', bytes: 50 * 1024 ** 2 };
      try {
        await assert.rejects(other.tryAcquire(request), e => e.code === 'storage_exhausted');
        f.state.config.enabled = enabled; f.options.roots = [];
        const scope = { ownerId: 'parent', teamId: f.team.id };
        await f.call('subagent_view_release', { ...scope, requestId: 'offline-release', kind: 'snapshot', id: snapshot.id });
        const cleanup = await f.call('subagent_view_cleanup', { ...scope, requestId: 'offline-cleanup' });
        assert.ok(cleanup.deletedBytes >= 10 * 1024 ** 2); assert.equal(f.local, undefined);
        const charged = Object.values((await other.status()).stores).find(s => s.directory === directory).bytes, actual = await storageUsage(directory);
        assert.ok(charged >= actual && charged < actual + 1024, 'only the former owner lock may remain conservatively charged');
        assert.equal((await other.tryAcquire(request)).granted, true);
      } finally { await other.release(request.key); await other.close(); }
    });
  }
});

test('offline view pin admission is nonblocking, leaves no receipt on denial and replays without another reservation', async t => {
  const f = await fixture(t); f.state.config.storageBytes = 64 * 1024 ** 2;
  const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
  const scope = { ownerId: 'parent', teamId: f.team.id }, pin = { ...scope, requestId: 'offline-consumer', name: 'consumer', resource: { kind: 'snapshot', id: f.snapshot.id } };
  try {
    assert.equal((await other.tryAcquire({ key: 'busy-storage', kind: 'storage', root: 'another-root', lane: 'integration', bytes: 32 * 1024 ** 2 })).granted, true);
    f.options.roots = [];
    await assert.rejects(f.call('subagent_view_pin', pin), e => e.code === 'resource_busy' && /storage/.test(e.message));
    assert.equal((await other.status()).claims.length, 1);
    assert.equal((await f.call('subagent_view_status', { ...scope, kind: 'pins' })).items.length, 1);
    await other.release('busy-storage');
    const result = await f.call('subagent_view_pin', pin);
    assert.equal((await other.tryAcquire({ key: 'busy-storage', kind: 'storage', root: 'another-root', lane: 'integration', bytes: 32 * 1024 ** 2 })).granted, true);
    assert.deepEqual(await f.call('subagent_view_pin', pin), result);
    await f.call('subagent_view_release', { ...scope, requestId: 'release-consumer', kind: 'pin', id: result.id });
    assert.equal((await f.call('subagent_view_status', { ...scope, kind: 'pins' })).items.length, 1);
  } finally { await other.release('busy-storage'); await other.close(); }
});


test('explicit coordinator service lanes create validation work and record acceptance under production storage pressure', { timeout: 20000 }, async t => {
  for (const lane of ['validation', 'integration']) {
    await t.test(lane, async t => {
      // Every worker's first turn asks for one bounded private read, so the
      // service lane proves a real read_file effect inside its small reserve.
      const f = await fixture(t, { stream: async function* (_m, _h, _t, _s, n) {
        if (n === 2) { yield { type: 'call', id: 'read', name: 'read_file', input: { path: 'a.txt' } }; }
        else { yield { type: 'text', text: 'done' }; }
      } }), { worker, task } = await f.spawn('producer'); await f.stopped(worker.id);
      let current = await f.call('subagent_task_get', { ownerId: 'parent', id: task.id });
      for (const state of ['in_progress', 'submitted', 'validating']) {
        current = await f.call('subagent_task_update', { ownerId: 'parent', requestId: 'advance-' + state, taskId: task.id, expectedRevision: current.revision, state,
          ...(state === 'submitted' ? { candidates: [{ id: 'candidate', version: 1, uri: 'manual:exact-input' }] } : {}) });
      }
      const dependent = await f.spawn('dependent', { task: { dependencies: [{ taskId: task.id, kind: 'artifact' }] } });
      await until(() => f.local.store.get(dependent.worker.id).waitingReason === 'dependency');
      const { storageUsage } = require('../.test-build/resource-governor'), directory = f.local.store.directory;
      // Retain about 55 MiB of the 64 MiB User budget: the work lane keeps no
      // payload headroom while the service reserve still holds several MiB.
      const retained = 52 * 1024 ** 2, existing = await storageUsage(directory);
      await fs.writeFile(path.join(directory, 'retained.bin'), Buffer.alloc(retained - existing));
      assert.ok(await storageUsage(directory) >= retained && await storageUsage(directory) < retained + 1024 ** 2);
      f.state.config.storageBytes = 64 * 1024 ** 2;
      const create = { ownerId: 'parent', requestId: 'validation-task', teamId: f.team.id, title: 'validate exact input', description: '' };
      await assert.rejects(f.call('subagent_task_create', create), e => e.code === 'storage_exhausted');
      const validationTask = await f.call('subagent_task_create', { ...create, lane });
      assert.equal(validationTask.lane, undefined); assert.equal(f.state.requests.length, 1, 'board admission cannot dispatch a worker');
      const team = await f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id });
      const validation = await f.call('subagent_isolated_spawn', { ownerId: 'parent', requestId: 'validator', task: 'validate', model: model.id,
        setup: { lane, teamId: team.id, teamRevision: team.revision, taskId: validationTask.id, taskRevision: validationTask.revision, snapshotId: f.snapshot.id } });
      const validated = await f.stopped(validation.id); assert.equal(f.state.requests.length, 3);
      // The service reserve paid for a real bounded private read, not a payload.
      const read = JSON.parse(validated.turns[0].tools[0].result);
      assert.equal(read.error, undefined); assert.equal(read.content, 'snapshot', 'validation reads its private snapshot inside the service reserve');
      const control = { ownerId: 'parent', id: validation.id };
      await f.call('subagent_send', { ...control, requestId: 'validator-followup', message: 'Follow up on the private read.' });
      assert.equal((await f.stopped(validation.id)).state, 'completed');
      await f.call('subagent_resume', { ...control, requestId: 'validator-resume', model: model.id, message: 'Recover and continue validation.' });
      assert.equal((await f.stopped(validation.id)).state, 'completed');
      assert.equal(f.state.requests.length, 5, 'both service controls dispatch inside the storage reserve');
      const verdict = { ownerId: 'parent', requestId: 'accept-producer', taskId: task.id, expectedRevision: current.revision, state: 'accepted',
        validations: [{ artifactId: 'candidate', candidateVersion: 1, outcome: 'passed', at: new Date().toISOString() }] };
      await assert.rejects(f.call('subagent_task_update', verdict), e => e.code === 'storage_exhausted');
      const accepted = await f.call('subagent_task_update', { ...verdict, lane });
      assert.equal(accepted.state, 'accepted'); await f.stopped(dependent.worker.id); assert.equal(f.state.requests.length, 6);
      assert.deepEqual(await f.call('subagent_task_update', { ...verdict, lane: 'work' }), accepted, 'admission hints do not change receipt identity');
      assert.equal((await f.call('subagent_task_create', { ...create, lane: 'work' })).id, validationTask.id);
      const serviceTeam = await f.call('subagent_team_create', { ownerId: 'parent', requestId: 'service-team', name: 'service', description: '', lane });
      assert.equal((await f.call('subagent_team_update', { ownerId: 'parent', requestId: 'service-team-update', teamId: serviceTeam.id, expectedRevision: serviceTeam.revision, description: 'integration control', lane })).revision, serviceTeam.revision + 1);
      // Retain into the last few MiB below the aggregate ceiling: this
      // overwrites the ballast file, keeping the retained bytes inside the
      // ceiling while the small service reservation no longer fits, so the same
      // mutation must fail instead of queueing.
      await fs.writeFile(path.join(directory, 'retained.bin'), Buffer.alloc(62 * 1024 ** 2));
      const over = await storageUsage(directory);
      assert.ok(over <= f.state.config.storageBytes, 'retained bytes stay inside the aggregate ceiling');
      assert.ok(over + 4 * 1024 ** 2 > f.state.config.storageBytes, 'no service reservation fits any more');
      await assert.rejects(f.call('subagent_task_create', { ...create, requestId: 'beyond-global-budget', lane }), e => e.code === 'storage_exhausted');
      assert.equal((await f.call('subagent_resource_status')).claims.length, 0);
    });
  }
});

test('board admission hints preserve opt-out behavior and reject invalid lanes before resource acquisition', async t => {
  const f = await fixture(t), original = f.broker.resources.acquire.bind(f.broker.resources); let admissions = 0;
  f.broker.resources.acquire = (...args) => { admissions++; return original(...args); };
  const create = { ownerId: 'parent', requestId: 'hint', teamId: f.team.id, title: 'metadata', description: '' };
  await assert.rejects(f.call('subagent_task_create', { ...create, lane: 'unlimited' }), e => e.code === 'invalid_arguments');
  assert.equal(admissions, 0);
  f.state.config.enabled = false;
  const task = await f.call('subagent_task_create', { ...create, lane: 'integration' }); assert.equal(task.lane, undefined);
  assert.equal(admissions, 0);
  f.options.taskBoardEnabled = () => false;
  await assert.rejects(f.call('subagent_task_create', { ...create, requestId: 'disabled', lane: 'validation' }), e => e.code === 'feature_disabled');
  assert.equal(admissions, 0);
});

test('queued coordinator service admission cancels without creating a board receipt and can retry', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.local.store.directory, 'retained.bin'), Buffer.alloc(26 * 1024 ** 2));
  f.state.config.storageBytes = 64 * 1024 ** 2;
  const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory), controller = new AbortController();
  const request = { ownerId: 'parent', requestId: 'queued-service-create', teamId: f.team.id, title: 'validation', description: '', lane: 'validation' };
  try {
    await f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id });
    // The service board mutation reserves only 4 MiB now, so the competing
    // occupier must leave exactly that little headroom below the ceiling.
    const { storageUsage } = require('../.test-build/resource-governor');
    await f.broker.resources.account(f.local.store.directory, () => storageUsage(f.local.store.directory));
    const tracked = Object.values((await other.status()).stores).find(s => s.directory === f.local.store.directory).bytes;
    const occupier = f.state.config.storageBytes - tracked - 2 * 1024 ** 2;
    assert.ok(tracked + occupier <= f.state.config.storageBytes, 'the occupier itself fits');
    assert.ok(tracked + occupier + 4 * 1024 ** 2 > f.state.config.storageBytes, 'a service reservation no longer fits');
    assert.equal((await other.tryAcquire({ key: 'occupy-service-storage', kind: 'storage', root: 'other-root', lane: 'integration', bytes: occupier })).granted, true);
    const creating = f.broker.invoke(f.root, 'subagent_task_create', request, controller.signal).then(unpack).then(value => ({ value }), error => ({ error }));
    await until(async () => (await other.status()).claims.some(c => c.state === 'waiting' && c.lane === 'validation'));
    controller.abort(); assert.ok((await creating).error);
    assert.equal((await f.local.board.open()).hasRequest('parent', request.requestId), false);
    assert.equal((await other.status()).claims.length, 1);
    await other.release('occupy-service-storage');
    const task = await f.call('subagent_task_create', request); assert.equal(task.title, request.title);
    assert.equal((await f.call('subagent_task_list', { ownerId: 'parent', teamId: f.team.id })).tasks.length, 1);
  } finally { controller.abort(); await other.release('occupy-service-storage'); await other.close(); }
});

test('storage FIFO wait reasons agree across admission, status and waiter callbacks', async t => {
  for (const lane of ['work', 'validation']) {
    await t.test(lane, async t => {
      const f = await fixture(t); f.state.config.storageBytes = 64 * 1024 ** 2;
      const first = f.broker.resources, second = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory), controller = new AbortController();
      const request = (key, mib) => ({ key, kind: 'storage', root: key, lane, bytes: mib * 1024 ** 2 });
      const seen = []; let waiting;
      try {
        assert.equal((await first.tryAcquire(request('held-space', 30))).granted, true);
        assert.equal((await first.tryAcquire(request('older-space', 40))).reason, 'storage');
        assert.deepEqual(await second.tryAcquire(request('younger-space', 1)), { granted: false, reason: 'storage' });
        const row = (await second.status()).claims.find(c => c.key === 'younger-space'); assert.equal(row.waitingReason, 'storage');
        waiting = second.acquire(request('younger-space', 1), controller.signal, async reason => { seen.push(reason); }).then(permit => ({ permit }), error => ({ error }));
        await until(() => seen.length > 0); assert.equal(seen[0], 'storage');
        assert.ok((await second.status()).claims.filter(c => c.state === 'waiting').every(c => c.waitingReason === 'storage'));
        await first.release('held-space'); assert.equal((await first.tryAcquire(request('older-space', 40))).granted, true);
        const admitted = await waiting; assert.ok(admitted.permit); assert.equal(seen.at(-1), undefined); await admitted.permit.release();
      } finally { controller.abort(); await waiting; await first.release('held-space'); await first.release('older-space'); await second.release('younger-space'); await second.close(); }
    });
  }
});


test('evidence writes enforce the existing UTF-8 byte cap before publishing an unreadable ledger', async t => {
  const f = await fixture(t), cap = 4 * 1024 ** 2, uri = '界'.repeat(2048);
  const template = { ownerId: 'parent', teamId: f.team.id, name: 'pin-0000', uri };
  const count = Math.floor((cap - 50) / (Buffer.byteLength(JSON.stringify(template)) + 1));
  const pins = Array.from({ length: count }, (_, i) => ({ ...template, name: 'pin-' + String(i).padStart(4, '0') }));
  const original = JSON.stringify({ schema: 1, pins }), file = path.join(f.local.store.directory, 'evidence-retention.json');
  assert.ok(count < 1024 && Buffer.byteLength(original) < cap);
  await fs.writeFile(file, original);
  const pin = { ownerId: 'parent', teamId: f.team.id, action: 'pin', name: 'overflow', uri };
  await assert.rejects(f.call('subagent_evidence_retention', pin), e => e.code === 'retention_capacity');
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await f.call('subagent_evidence_retention', { ...pin, action: 'release', name: pins[0].name });
  await f.call('subagent_evidence_retention', pin);
  assert.ok((await fs.stat(file)).size <= cap);
  assert.equal((await f.call('subagent_resource_status')).summary.retainedBytes, await require('../.test-build/resource-governor').storageUsage(f.local.store.directory));
});


test('cancellation during an unused model-grant handoff removes the deferred ticket', { timeout: 10000 }, async t => {
  const f = await fixture(t), { worker } = await f.spawn('late-cancel'); await f.stopped(worker.id);
  f.state.models[model.id].numSessions = 1;
  const gate = deferred(), entered = deferred(); let legacy, cancelling, once = true;
  f.options.provider.stream = async function* () { entered.resolve(); await gate.promise; yield { type: 'text', text: 'done' }; };
  const acquire = f.broker.resources.acquire.bind(f.broker.resources), defer = f.broker.resources.deferModel.bind(f.broker.resources);
  f.broker.resources.acquire = async (input, ...args) => {
    const permit = await acquire(input, ...args);
    if (input.kind === 'model' && once) {
      once = false; legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'late-legacy', task: 'hold', model: model.id }); await entered.promise;
    }
    return permit;
  };
  f.broker.resources.deferModel = async key => {
    await defer(key); const job = f.local.engine.active.get(worker.id);
    cancelling = f.call('subagent_cancel', { ownerId: 'parent', id: worker.id });
    await until(() => job.controller.signal.aborted);
  };
  try {
    await f.call('subagent_send', { ownerId: 'parent', id: worker.id, requestId: 'late-followup', message: 'must not infer' });
    await until(() => !!cancelling); await cancelling; await f.stopped(worker.id);
    // The engine detaches an aborted provider iterator; its real queue cleanup
    // still owns the ticket until that iterator drains.
    await until(async () => !(await f.call('subagent_resource_status')).claims.some(c => c.kind === 'model'));
    assert.equal((await f.call('subagent_resource_status')).claims.some(c => c.kind === 'model'), false);
    gate.resolve(); await f.stopped(legacy.id);
  } finally { gate.resolve(); await cancelling; }
});


test('model capacity waiters keep FIFO order across local governed and legacy occupancy', { timeout: 20000 }, async t => {
  for (const mode of ['governed', 'legacy']) {
    await t.test(mode, async t => {
      const f = await fixture(t), gates = { A: deferred(), B: deferred(), C: deferred() }, order = [];
      const a = mode === 'governed' ? (await f.spawn('fifo-a')).worker : undefined;
      if (a) await f.stopped(a.id);
      const b = (await f.spawn('fifo-b')).worker; await f.stopped(b.id);
      const c = (await f.spawn('fifo-c')).worker; await f.stopped(c.id);
      f.state.models[model.id].numSessions = 1;
      f.options.provider.stream = async function* (_m, messages) {
        const tag = messages.at(-1).parts[0].text; order.push(tag); await gates[tag].promise;
        yield { type: 'text', text: 'done' };
      };
      let active;
      try {
        if (a) {
          await f.call('subagent_send', { ownerId: 'parent', id: a.id, requestId: 'fifo-a-followup', message: 'A' }); active = a;
        } else {
          active = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'fifo-legacy', task: 'A', model: model.id });
        }
        await until(() => order.includes('A'));
        await f.call('subagent_send', { ownerId: 'parent', id: b.id, requestId: 'fifo-b-followup', message: 'B' });
        await until(() => f.local.store.get(b.id).waitingReason === 'model_capacity');
        const older = (await f.call('subagent_resource_status')).claims.find(c => c.kind === 'model' && c.state === 'waiting');
        assert.ok(older, 'a local model wait must already own a queue ticket');
        await f.call('subagent_send', { ownerId: 'parent', id: c.id, requestId: 'fifo-c-followup', message: 'C' });
        await until(() => f.local.store.get(c.id).waitingReason === 'model_capacity');
        const pending = (await f.call('subagent_resource_status')).claims.filter(c => c.kind === 'model' && c.state === 'waiting');
        assert.equal(pending.length, 2); assert.equal(Math.min(...pending.map(c => c.sequence)), older.sequence);
        const attempt = f.broker.resources.attempt.bind(f.broker.resources); let release = true;
        f.broker.resources.attempt = async (input, handoff) => {
          const result = await attempt(input, handoff);
          if (input.key === older.key && !result.granted && release) {
            release = false; gates.A.resolve(); await f.stopped(active.id);
          }
          return result;
        };
        await until(() => order.length >= 2); assert.deepEqual(order, ['A', 'B']);
        gates.B.resolve(); await f.stopped(b.id); await until(() => order.includes('C'));
        gates.C.resolve(); await f.stopped(c.id); assert.deepEqual(order, ['A', 'B', 'C']);
      } finally { Object.values(gates).forEach(gate => gate.resolve()); }
    });
  }
});

test('unused model grants retain their ticket when local admission changes and cannot demote foreign effects', async t => {
  const f = await fixture(t), g = f.broker.resources;
  const request = key => ({ key, kind: 'model', root: f.root, scope: f.local.store.directory, model: model.id, localCapacity: 1 });
  const foreign = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
  try {
    assert.equal((await g.tryAcquire(request('older-model'))).granted, true);
    const sequence = (await g.status()).claims.find(c => c.key === 'older-model').sequence;
    await assert.rejects(foreign.deferModel('older-model'), e => e.code === 'resource_conflict');
    await g.deferModel('older-model');
    assert.equal((await g.tryAcquire({ ...request('younger-model'), localBlocked: true })).granted, false);
    const blocked = (await g.status()).claims.filter(c => c.kind === 'model');
    assert.ok(blocked.every(c => c.state === 'waiting'));
    assert.equal(blocked.find(c => c.key === 'older-model').sequence, sequence);
    assert.equal((await g.tryAcquire(request('younger-model'))).granted, false);
    const oldest = (await g.status()).claims.find(c => c.key === 'older-model');
    assert.equal(oldest.state, 'waiting'); assert.equal(oldest.sequence, sequence);
    assert.equal((await g.tryAcquire(request('older-model'))).granted, true, 'the older ticket activates on its own poll');
    await g.release('older-model'); assert.equal((await g.tryAcquire(request('younger-model'))).granted, true);
  } finally { await g.release('older-model'); await g.release('younger-model'); await foreign.close(); }
});

test('cancel and parent expiry remove local-capacity tickets without starting inference', async t => {
  for (const mode of ['cancel', 'expiry', 'feature']) {
    await t.test(mode, async t => {
      const gate = deferred(), entered = deferred(), f = await fixture(t);
      const { worker } = await f.spawn('queued-' + mode, { spawn: { parentPolicy: 'cancel-on-expiry', leaseSeconds: 30 } }); await f.stopped(worker.id);
      f.state.models[model.id].numSessions = 1;
      f.options.provider.stream = async function* () { entered.resolve(); await gate.promise; yield { type: 'text', text: 'done' }; };
      try {
        const legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'legacy-' + mode, task: 'hold', model: model.id }); await entered.promise;
        await f.call('subagent_send', { ownerId: 'parent', id: worker.id, requestId: 'queued-followup', message: 'queued' });
        await until(() => f.local.store.get(worker.id).waitingReason === 'model_capacity');
        assert.equal((await f.call('subagent_resource_status')).claims.filter(c => c.kind === 'model').length, 1);
        if (mode === 'cancel') await f.call('subagent_cancel', { ownerId: 'parent', id: worker.id });
        else if (mode === 'expiry') { await f.local.store.change(worker.id, s => { s.parentExpiresAt = 1; }); await f.local.engine.expireParents(); }
        else { f.options.isolatedViewsEnabled = () => false; }
        await f.stopped(worker.id);
        assert.equal((await f.call('subagent_resource_status')).claims.some(c => c.kind === 'model'), false);
        gate.resolve(); await f.stopped(legacy.id);
      } finally { gate.resolve(); }
    });
  }
});

test('full production runner queues keep the reserved service slot reachable without increasing queue bounds', async t => {
  const { RunnerPool } = require('../.test-build/runner-pool');
  for (const maxQueue of [0, 1]) {
    await t.test('maxQueue=' + maxQueue, async t => {
      const f = await fixture(t), g = f.broker.resources, directory = path.join(f.dir, 'queue-pool');
      const admission = g.runnerAdmission(directory, f.root, owner => owner.ownerId);
      const pool = new RunnerPool(directory, { capacity: 2, maxQueue, admission }); await pool.open();
      const owner = (key, lane = 'work') => ({ ownerId: lane, teamId: f.team.id, workerId: key.repeat(32), workerCreatedAt: new Date(0).toISOString() });
      const controller = new AbortController(); let work, service, queued;
      try {
        work = await pool.acquire(owner('1'));
        queued = pool.acquire(owner('2'), controller.signal).then(lease => ({ lease }), error => ({ error }));
        if (maxQueue) await until(() => pool.waiters.length === 1 && !pool.waiters[0].claimed);
        else assert.equal((await queued).error.code, 'pool_queue_full');
        for (const lane of ['validation', 'integration']) {
          service = await pool.acquire(owner('3', lane));
          assert.equal(pool.status().slots.filter(s => s.state === 'active').length, 2);
          assert.ok(pool.status().queue.length <= maxQueue);
          if (maxQueue) {
            await assert.rejects(pool.acquire(owner('4')), e => e.code === 'pool_queue_full');
          }
          await service.release({ drained: true }); service = undefined;
        }
      } finally {
        controller.abort(); const outcome = await queued;
        await outcome?.lease?.release({ drained: true }); await service?.release({ drained: true }); await work?.release({ drained: true }); await pool.close();
      }
      assert.equal((await g.status()).claims.some(c => c.kind === 'runner'), false);
    });
  }
});

test('evidence pins and empty rollover archives refresh retained storage before another root can spend it', async t => {
  const f = await fixture(t); f.state.config.storageBytes = 64 * 1024 ** 2;
  const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory), scope = { ownerId: 'parent', teamId: f.team.id };
  const charged = async () => (await f.call('subagent_resource_status')).summary.retainedBytes;
  const actual = () => require('../.test-build/resource-governor').storageUsage(f.local.store.directory);
  const rename = fs.rename;
  const probe = { key: 'rollover-fence', kind: 'storage', root: 'other-root', lane: 'integration', bytes: 1 };
  let fencedArchives = 0;
  fs.rename = async (from, to) => {
    if (path.basename(path.dirname(to)) === 'receipt-archives' && to.endsWith('.json.gz')) {
      assert.deepEqual(await other.tryAcquire(probe), { granted: false, reason: 'storage' });
      fencedArchives++;
      await other.release(probe.key);
    }
    return rename(from, to);
  };
  try {
    const before = await charged();
    await f.call('subagent_evidence_retention', { ...scope, action: 'pin', name: 'large-pin', uri: 'manual:' + 'x'.repeat(1800) });
    assert.ok(await charged() > before); assert.equal(await charged(), await actual());
    await assert.rejects(other.tryAcquire({ key: 'overspend', kind: 'storage', root: 'other-root', lane: 'integration', bytes: f.state.config.storageBytes - before }), e => e.code === 'storage_exhausted');
    for (const kind of ['board', 'views']) {
      await f.call('subagent_metadata_rollover', { ...scope, kind, expectedEpoch: 0 });
      const beforeEmpty = await charged();
      await f.call('subagent_metadata_rollover', { ...scope, kind, expectedEpoch: 1 });
      assert.ok(await charged() > beforeEmpty); assert.equal(await charged(), await actual());
    }
    assert.equal(fencedArchives, 4, 'both board and view rollovers fence each archive publication');
  } finally {
    fs.rename = rename;
    await other.release(probe.key); await other.release('overspend'); await other.close();
  }
});

test('pin replay and release remain available at storage exhaustion while new pins fail without waiting', async t => {
  const f = await fixture(t), scope = { ownerId: 'parent', teamId: f.team.id }, pin = { ...scope, action: 'pin', name: 'keep', uri: 'manual:evidence' };
  await f.call('subagent_evidence_retention', pin); f.state.config.storageBytes = 64 * 1024 ** 2;
  const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
  try {
    const bytes = (await f.call('subagent_resource_status')).summary.retainedBytes;
    assert.equal((await other.tryAcquire({ key: 'full-store', kind: 'storage', root: 'other-root', lane: 'integration', bytes: f.state.config.storageBytes - bytes })).granted, true);
    assert.equal((await f.call('subagent_evidence_retention', pin)).uri, pin.uri);
    await assert.rejects(f.call('subagent_evidence_retention', { ...pin, name: 'new' }), e => ['resource_busy', 'storage_exhausted'].includes(e.code));
    await f.call('subagent_evidence_retention', { ...pin, action: 'release' });
    assert.deepEqual([...await f.local.isolation.evidence.withReferences(async refs => refs)], []);
    await f.call('subagent_metadata_rollover', { ...scope, kind: 'board', expectedEpoch: 0 });
    const status = await f.call('subagent_resource_status');
    assert.equal(status.claims.length, 1); assert.equal(status.claims[0].key, 'full-store');
    assert.equal(status.summary.retainedBytes, await require('../.test-build/resource-governor').storageUsage(f.local.store.directory));
  } finally { await other.release('full-store'); await other.close(); }
});

test('retention failures after durable mutation reconcile storage and replay without repeating effects', async t => {
  for (const mode of ['pin', 'rollover']) {
    await t.test(mode, async t => {
      const f = await fixture(t), scope = { ownerId: 'parent', teamId: f.team.id };
      const target = mode === 'pin' ? f.local.isolation.evidence : await f.local.board.open();
      const method = mode === 'pin' ? 'update' : 'rolloverReceipts', original = target[method].bind(target); let fail = true;
      target[method] = async (...args) => { const result = await original(...args); if (fail) { fail = false; throw Error('lost retention acknowledgement'); } return result; };
      const name = mode === 'pin' ? 'subagent_evidence_retention' : 'subagent_metadata_rollover';
      const args = mode === 'pin' ? { ...scope, action: 'pin', name: 'saved', uri: 'manual:saved' } : { ...scope, kind: 'board', expectedEpoch: 0 };
      await assert.rejects(f.call(name, args), /lost retention acknowledgement/);
      const bytes = (await f.call('subagent_resource_status')).summary.retainedBytes;
      assert.equal(bytes, await require('../.test-build/resource-governor').storageUsage(f.local.store.directory));
      await f.call(name, args);
      assert.equal((await f.call('subagent_resource_status')).summary.retainedBytes, bytes);
    });
  }
});


test('restored model ownership does not double count the currently admitted request', async t => {
  const f = await fixture(t, { state: { models: { [model.id]: { numSessions: 2 } } } });
  const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
  try {
    assert.equal((await other.tryAcquire({ key: 'retained-model', kind: 'model', root: f.root, scope: f.local.store.directory, model: model.id, localCapacity: 2 })).granted, true);
    await f.local.lifecycle.restoreModelReservations();
    const acquire = f.broker.resources.acquire.bind(f.broker.resources);
    f.broker.resources.acquire = async (input, ...args) => {
      const permit = await acquire(input, ...args);
      if (input.kind === 'model') f.local.lifecycle.retainedModels = await f.broker.resources.modelReservations(f.local.store.directory);
      return permit;
    };
    const { worker } = await f.spawn('deduplicated-reservation');
    assert.equal((await f.stopped(worker.id)).state, 'completed'); assert.equal(f.state.requests.length, 1);
  } finally { await other.release('retained-model'); await other.close(); }
});

test('a dependency added during tool admission releases execution capacity before waiting', async t => {
  const entered = deferred(), gate = deferred(); let pause = true;
  const f = await fixture(t, { stream: async function* (_m, _h, _t, _s, n) {
    if (n === 1) yield { type: 'call', id: 'write', name: 'write_file', input: { path: 'after-dependency.txt', content: 'ready', expectedHash: 'new' } };
    else yield { type: 'text', text: 'done' };
  } });
  const producer = await f.call('subagent_task_create', { ownerId: 'parent', requestId: 'producer', teamId: f.team.id, title: 'producer', description: '' });
  const acquire = f.broker.resources.acquire.bind(f.broker.resources);
  f.broker.resources.acquire = async (input, ...args) => { if (pause && input.kind === 'tool') { pause = false; entered.resolve(); await gate.promise; } return acquire(input, ...args); };
  try {
    const { worker, task } = await f.spawn('late-dependency'); await entered.promise;
    const waiting = await f.call('subagent_task_update', { ownerId: 'parent', taskId: task.id, requestId: 'add-dependency', expectedRevision: task.revision + 1, dependencies: [{ taskId: producer.id, kind: 'artifact' }] });
    gate.resolve(); await until(() => f.local.store.get(worker.id).waitingReason === 'dependency');
    assert.equal((await f.call('subagent_resource_status')).claims.some(c => ['tool', 'model', 'runner'].includes(c.kind)), false);
    await f.call('subagent_task_update', { ownerId: 'parent', taskId: task.id, requestId: 'remove-dependency', expectedRevision: waiting.revision, dependencies: [] });
    const stopped = await f.stopped(worker.id); assert.equal(stopped.state, 'completed');
    assert.equal(JSON.parse(stopped.turns[0].tools[0].result).error, undefined);
  } finally { gate.resolve(); }
});

test('a fresh host administering removed-folder history unregisters its resource policy on close', async t => {
  const f = await fixture(t), { worker } = await f.spawn('saved-host'); await f.stopped(worker.id);
  await f.broker.close();
  const otherRoot = path.join(f.dir, 'other-root'); await fs.mkdir(otherRoot); f.state.models = {};
  const saved = new WorkerBroker({ ...f.options, roots: [otherRoot] });
  try {
    await saved.start(); const before = await saved.session(f.root, worker.id);
    unpack(await saved.invoke(f.root, 'subagent_compact', { ownerId: 'parent', id: worker.id, revision: before.revision, summary: 'saved host summary' }));
    assert.equal((await saved.session(f.root, worker.id)).summary.text, 'saved host summary');
    assert.equal(f.state.requests.length, 1);
  } finally { await saved.close(); }
  const ledger = JSON.parse(await fs.readFile(path.join(f.options.resourceDirectory, 'ledger.json'), 'utf8'));
  assert.equal(ledger.policies[saved.resources.host], undefined); assert.equal(ledger.claims.length, 0);
});


test('retained inference blocks legacy admission after reload, root retirement and deleted-worker recovery', async t => {
  for (const mode of ['reload', 'retire', 'deleted-disabled']) {
    await t.test(mode, async t => {
      const gate = deferred(); let concurrent = 0, maximum = 0;
      const f = await fixture(t, { state: { models: { [model.id]: { numSessions: 1 } } }, stream: async function* (_m, _h, _t, _s, n) {
        concurrent++; maximum = Math.max(maximum, concurrent);
        try { if (n === 1) await gate.promise; yield { type: 'text', text: 'done' }; } finally { concurrent--; }
      } });
      try {
        const { worker } = await f.spawn('retained-' + mode); await until(() => concurrent === 1);
        await f.call('subagent_cancel', { ownerId: 'parent', id: worker.id }); await f.stopped(worker.id);
        if (mode === 'deleted-disabled') {
          await f.call('subagent_delete', { ownerId: 'parent', id: worker.id }); f.state.config.enabled = false;
        }
        if (mode === 'retire') {
          f.options.roots = []; await f.broker.session(f.root, worker.id); f.options.roots = [f.root];
        } else { await f.reload(); }
        const legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'after-' + mode, task: 'done', model: model.id });
        assert.equal(f.local.engine.active.has(legacy.id), false);
        assert.equal(f.local.lifecycle.activeForModel(model.id), 1);
        assert.equal(f.state.requests.length, 1);
        assert.deepEqual(await f.broker.resources.modelReservations(path.join(f.dir, 'unrelated-store')), []);
        if (mode === 'reload') {
          const ledger = path.join(f.options.resourceDirectory, 'ledger.json'), bytes = await fs.readFile(ledger);
          await fs.writeFile(ledger, 'corrupt');
          try {
            await until(() => f.state.errors?.some(e => e.includes('resource-recovery')), 3000);
            assert.equal(f.local.lifecycle.activeForModel(model.id), 1);
            assert.equal(f.local.engine.active.has(legacy.id), false);
          } finally { await fs.writeFile(ledger, bytes); }
          const hasState = f.broker.resources.hasState.bind(f.broker.resources);
          f.broker.resources.hasState = async () => false;
          try {
            await until(() => f.state.errors.some(e => e.includes('namespace is missing')), 3000);
            assert.equal(f.local.lifecycle.activeForModel(model.id), 1);
            assert.equal(f.local.engine.active.has(legacy.id), false);
          } finally { f.broker.resources.hasState = hasState; }
        }
        gate.resolve(); await f.stopped(legacy.id);
        assert.equal(maximum, 1); assert.equal(f.state.requests.length, 2);
        await until(() => f.local.lifecycle.activeForModel(model.id) === 0);
      } finally { gate.resolve(); await until(() => concurrent === 0); }
    });
  }
});

test('task revocation during tool admission prevents the queued write', async t => {
  for (const mode of ['assignment', 'terminal', 'commit']) {
    await t.test(mode, async t => {
      const entered = deferred(), gate = deferred();
      const f = await fixture(t, { stream: async function* (_m, _h, _t, _s, n) {
        if (n === 1) yield { type: 'call', id: 'write', name: 'write_file', input: { path: 'blocked.txt', content: 'must not be written', expectedHash: 'new' } };
        else yield { type: 'text', text: 'done' };
      } });
      const acquire = f.broker.resources.acquire.bind(f.broker.resources);
      f.broker.resources.acquire = async (request, ...args) => { if (mode !== 'commit' && request.kind === 'tool') { entered.resolve(); await gate.promise; } return acquire(request, ...args); };
      if (mode === 'commit') {
        const views = await f.local.isolation.open(), edit = views.edit.bind(views);
        views.edit = async (...args) => { entered.resolve(); await gate.promise; return edit(...args); };
      }
      try {
        const { worker, task } = await f.spawn('revoked-' + mode); await entered.promise;
        await f.call('subagent_task_update', { ownerId: 'parent', taskId: task.id, requestId: 'revoke', expectedRevision: task.revision + 1, ...(mode === 'terminal' ? { state: 'cancelled' } : { assigneeWorkerId: null }) });
        gate.resolve(); const stopped = await f.stopped(worker.id);
        assert.equal(stopped.state, 'failed'); assert.equal(f.state.requests.length, 1);
        assert.equal((await (await f.local.isolation.open()).status(stopped.isolatedView, { ownerId: 'parent', workerId: worker.id, workerCreatedAt: worker.createdAt })).revision, 0);
        const result = JSON.parse(stopped.turns[0].tools[0].result);
        assert.equal(result.error.code, mode === 'terminal' ? 'task_stopped' : 'assignment_conflict');
        assert.equal((await f.call('subagent_resource_status')).claims.some(c => c.kind === 'tool'), false);
      } finally { gate.resolve(); }
    });
  }
});

test('a message wait added during tool admission yields its permit until an explicit wake', async t => {
  const entered = deferred(), gate = deferred(); let pause = true;
  const f = await fixture(t, { config: { runnableCapacity: 2 }, stream: async function* (_m, _h, _t, _s, n) {
    if (n === 1) yield { type: 'call', id: 'write', name: 'write_file', input: { path: 'after-wake.txt', content: 'awake', expectedHash: 'new' } };
    else yield { type: 'text', text: 'done' };
  } });
  const acquire = f.broker.resources.acquire.bind(f.broker.resources);
  f.broker.resources.acquire = async (request, ...args) => { if (pause && request.kind === 'tool') { pause = false; entered.resolve(); await gate.promise; } return acquire(request, ...args); };
  try {
    const { worker } = await f.spawn('wait-at-admission'); await entered.promise;
    const waiting = await f.call('subagent_schedule', { ownerId: 'parent', id: worker.id, wait: { kind: 'message', key: 'continue' }, expectedWaitRevision: 0 });
    assert.equal(waiting.scheduleWaitRevision, 1);
    gate.resolve(); await until(() => f.local.store.get(worker.id).waitingReason === 'message');
    assert.equal((await f.call('subagent_resource_status')).claims.some(c => ['tool', 'model', 'runner'].includes(c.kind)), false);
    assert.equal((await (await f.local.isolation.open()).status(worker.isolatedView, { ownerId: 'parent', workerId: worker.id, workerCreatedAt: worker.createdAt })).revision, 0);
    const validation = await f.spawn('validation-during-wait', { lane: 'validation' }); await f.stopped(validation.worker.id);
    await f.call('subagent_schedule', { ownerId: 'parent', id: worker.id, wait: null, expectedWaitRevision: waiting.scheduleWaitRevision });
    const stopped = await f.stopped(worker.id); assert.equal(stopped.state, 'completed');
    assert.equal(JSON.parse(stopped.turns[0].tools[0].result).error, undefined);
  } finally { gate.resolve(); }
});

test('runner approval rechecks task eligibility before command execution', { timeout: 15000 }, async t => {
  const entered = deferred(), gate = deferred(); let executed = false;
  const f = await fixture(t, { stream: async function* (_m, _h, _t, _s, n) {
    if (n === 1) yield { type: 'call', id: 'command', name: 'run_command', input: { command: 'node -e "process.stdout.write(\'must-not-run\')"' } };
    else yield { type: 'text', text: 'done' };
  } });
  f.local.isolation.options.approveCommand = async () => { entered.resolve(); await gate.promise; return true; };
  try {
    const { worker, task } = await f.spawn('revoke-at-approval'); await entered.promise;
    const manager = f.local.isolation.runners, run = manager.runCommand.bind(manager);
    manager.runCommand = (...args) => { executed = true; return run(...args); };
    await f.call('subagent_task_update', { ownerId: 'parent', taskId: task.id, requestId: 'cancel-during-approval', expectedRevision: task.revision + 1, state: 'cancelled' });
    gate.resolve(); const stopped = await f.stopped(worker.id), result = JSON.parse(stopped.turns[0].tools[0].result);
    assert.equal(executed, false); assert.equal(result.error.code, 'command_denied');
    const retained = manager.results.list({ ownerId: 'parent', teamId: f.team.id }).results;
    assert.equal(retained.length, 1); assert.equal(retained[0].outcome, 'denied');
    assert.equal((await f.call('subagent_resource_status')).claims.some(c => c.kind === 'runner'), false);
  } finally { gate.resolve(); }
});

test('removed-folder governed histories compact manually without inference and retain storage accounting', async t => {
  const f = await fixture(t), { worker } = await f.spawn('offline-history'); await f.stopped(worker.id);
  const directory = f.local.store.directory;
  f.options.roots = []; f.state.models = {};
  const before = await f.broker.session(f.root, worker.id);
  await f.call('subagent_compact', { ownerId: 'parent', id: worker.id, revision: before.revision, summary: 'offline manual summary' });
  const after = await f.broker.session(f.root, worker.id);
  assert.equal(after.schema, 3); assert.equal(after.state, 'completed'); assert.equal(after.summary.text, 'offline manual summary');
  assert.equal(after.archives.length, 1); assert.equal(f.state.requests.length, 1); assert.equal(f.local, undefined);
  const status = await f.broker.resources.status();
  const charged = Object.values(status.stores).find(s => s.directory === directory).bytes;
  const retained = await require('../.test-build/resource-governor').storageUsage(directory);
  assert.ok(charged >= retained && charged < retained + 1024, 'closed-store accounting may conservatively include its former owner lock');
  assert.equal(status.claims.length, 0);
});

test('offline history maintenance reports capacity promptly, releases its queue entry and permits retry', async t => {
  const f = await fixture(t), { worker } = await f.spawn('offline-budget'); await f.stopped(worker.id);
  f.state.config.storageBytes = 64 * 1024 ** 2;
  const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
  try {
    assert.equal((await other.tryAcquire({ key: 'foreign-storage', kind: 'storage', root: 'other', lane: 'integration', bytes: 40 * 1024 ** 2 })).granted, true);
    f.options.roots = [];
    const before = await f.broker.session(f.root, worker.id);
    await assert.rejects(f.call('subagent_compact', { ownerId: 'parent', id: worker.id, revision: before.revision, summary: 'bounded offline summary' }), e => e.code === 'resource_busy' && e.message.includes('storage'));
    const unchanged = await f.broker.session(f.root, worker.id);
    assert.equal(unchanged.archives?.length ?? 0, 0); assert.equal(unchanged.state, 'completed'); assert.equal(unchanged.maintenance, undefined);
    assert.equal((await other.status()).claims.length, 1);
    await other.release('foreign-storage');
    await f.call('subagent_compact', { ownerId: 'parent', id: worker.id, revision: unchanged.revision, summary: 'bounded offline summary' });
    assert.equal((await f.broker.session(f.root, worker.id)).archives.length, 1);
  } finally { await other.release('foreign-storage'); await other.close(); }
});


test('local model admission includes governed validation before a legacy worker can claim the same slot', async t => {
  const isolationGate = deferred(), entered = deferred(), governedGate = deferred(), legacyGate = deferred();
  const governedEntered = deferred(), legacyEntered = deferred(); let concurrent = 0, maximum = 0;
  const f = await fixture(t, { stream: async function* (_model, _messages, tools) {
    concurrent++; maximum = Math.max(maximum, concurrent);
    try {
      if (tools.some(tool => tool.name === 'seal_submission')) { governedEntered.resolve(); await governedGate.promise; }
      else { legacyEntered.resolve(); await legacyGate.promise; }
      yield { type: 'text', text: 'done' };
    } finally { concurrent--; }
  } });
  f.state.models[model.id].numSessions = 1;
  const original = f.local.isolation.assertWorkerUsable.bind(f.local.isolation); let pause = true;
  f.local.isolation.assertWorkerUsable = async (session, ...args) => {
    if (pause && session.startup?.phase === 'started') { pause = false; entered.resolve(); await isolationGate.promise; }
    return original(session, ...args);
  };
  try {
    const governed = await f.spawn('governed-admission'); await entered.promise;
    const legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'legacy-admission', task: 'legacy', model: model.id });
    assert.equal(f.local.engine.active.has(legacy.id), false, 'legacy work must queue behind the reserved validation handoff');
    isolationGate.resolve(); await governedEntered.promise;
    assert.equal(f.state.requests.length, 1); governedGate.resolve(); await f.stopped(governed.worker.id);
    await legacyEntered.promise; legacyGate.resolve(); await f.stopped(legacy.id);
    assert.equal(maximum, 1);
  } finally { isolationGate.resolve(); governedGate.resolve(); legacyGate.resolve(); }
});

test('a delayed read sample cannot erase a newer snapshot charge or admit another root beyond the budget', async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred();
  const governor = f.broker.resources, original = governor.account.bind(governor); let pause = true, reading, other;
  governor.account = (directory, measure) => original(directory, async () => {
    const bytes = await measure();
    if (pause) { pause = false; entered.resolve(); await gate.promise; }
    return bytes;
  });
  try {
    reading = f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id }); await entered.promise;
    await fs.writeFile(path.join(f.root, 'large.txt'), Buffer.alloc(5 * 1024 ** 2, 97));
    await f.call('subagent_snapshot_create', { ownerId: 'parent', teamId: f.team.id, requestId: 'accounted-capture' });
    const charged = () => f.call('subagent_resource_status').then(s => Object.values(s.stores).find(s => s.directory === f.local.store.directory).bytes);
    const newer = await charged(); assert.ok(newer >= 5 * 1024 ** 2);
    gate.resolve(); await reading; assert.equal(await charged(), newer);
    assert.equal(await charged(), await require('../.test-build/resource-governor').storageUsage(f.local.store.directory));
    f.state.config = { ...f.state.config, storageBytes: 64 * 1024 ** 2 };
    other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
    await assert.rejects(other.tryAcquire({ key: 'other-root', kind: 'storage', root: 'other-root', bytes: 54 * 1024 ** 2 }), e => e.code === 'storage_exhausted');
  } finally { gate.resolve(); await Promise.allSettled([reading]); governor.account = original; await other?.close(); }
});

test('shared storage sampling rejects older values and older failures across governor instances', async t => {
  for (const mode of ['value', 'failure']) {
    await t.test(mode, async t => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-samples-'));
      const config = () => ({ ...resourceDefaults, enabled: true });
      const a = new ResourceGovernor(config, dir), b = new ResourceGovernor(config, dir), gate = deferred(), entered = deferred();
      t.after(async () => { await a.close(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); });
      await a.account('store', async () => 100);
      const old = a.account('store', async () => { entered.resolve(); await gate.promise; if (mode === 'failure') { throw Error('old scan failed'); } return 10; });
      const observed = old.then(() => undefined, e => e);
      try {
        await entered.promise; await b.account('store', async () => 200);
        gate.resolve(); const error = await observed;
        assert.equal(error?.message, mode === 'failure' ? 'old scan failed' : undefined);
        const store = Object.values((await b.status()).stores)[0]; assert.equal(store.bytes, 200); assert.equal(store.uncertain, false);
        assert.equal((await b.tryAcquire({ key: 'fresh', kind: 'storage', root: 'root', bytes: 1 })).granted, true);
        await b.release('fresh');
      } finally { gate.resolve(); await observed; }
    });
  }
});

test('unknown storage blocks admission and failed measurements stay quarantined until a fresh reconciliation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-recovery-'));
  const config = () => ({ ...resourceDefaults, enabled: true });
  const a = new ResourceGovernor(config, dir), b = new ResourceGovernor(config, dir), gate = deferred(), entered = deferred();
  t.after(async () => { await a.close(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const measuring = a.account('store', async () => { entered.resolve(); await gate.promise; throw Error('unreadable store'); });
  const failed = assert.rejects(measuring, /unreadable store/);
  const request = { key: 'waiting', kind: 'storage', root: 'other-root', bytes: 1 };
  try {
    await entered.promise; assert.equal((await b.tryAcquire(request)).reason, 'storage');
    gate.resolve(); await failed; assert.equal((await b.tryAcquire(request)).reason, 'quarantine');
    await b.account('store', async () => 200);
    assert.equal((await b.tryAcquire(request)).granted, true); await b.release('waiting');
  } finally { gate.resolve(); await failed; }
});

test('rollover rejects pre-creation preparations without blocking another owner', async t => {
  const f = await fixture(t), input = await prepared(f, 'pre-creation-rollover'), pause = pauseCreation(f);
  const starting = f.call('subagent_isolated_spawn', input);
  try {
    await pause.entered.promise; assert.equal(f.local.store.list().length, 0);
    for (const kind of ['board', 'views']) {
      await assert.rejects(f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind, expectedEpoch: 0 }), e => e.code === 'worker_busy');
    }
    const other = await f.call('subagent_team_create', { ownerId: 'other', requestId: 'other', name: 'other', description: '' });
    assert.equal((await f.call('subagent_metadata_rollover', { ownerId: 'other', teamId: other.id, kind: 'board', expectedEpoch: 0 })).epoch, 1);
    pause.gate.resolve(); const worker = await starting; await f.stopped(worker.id);
    assert.equal(f.state.requests.length, 1);
    assert.equal((await f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 0 })).epoch, 1);
  } finally { pause.gate.resolve(); await Promise.allSettled([starting]); }
});

test('rollover fences new owner work until its durable write completes and releases the fence after errors', async t => {
  const f = await fixture(t), input = await prepared(f, 'during-rollover');
  const legacy = await f.call('subagent_spawn', { ownerId: 'parent', requestId: 'existing', task: 'existing', model: model.id }); await f.stopped(legacy.id);
  const board = await f.local.board.open(), original = board.rolloverReceipts.bind(board), gate = deferred(), entered = deferred();
  board.rolloverReceipts = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const rolling = f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 0 });
  try {
    await entered.promise;
    await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'worker_busy');
    await assert.rejects(f.call('subagent_send', { ownerId: 'parent', id: legacy.id, requestId: 'follow-up', message: 'later' }), e => e.code === 'worker_busy');
    await assert.rejects(f.call('subagent_spawn', { ownerId: 'parent', requestId: 'during', task: 'later' }), e => e.code === 'worker_busy');
    const independent = await f.call('subagent_spawn', { ownerId: 'other', requestId: 'independent', task: 'done', model: model.id }); await f.stopped(independent.id);
    gate.resolve(); await rolling;
    assert.equal(f.local.store.list().filter(s => s.ownerId === 'parent').length, 1);
    board.rolloverReceipts = async () => { throw Error('rollover failed'); };
    await assert.rejects(f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 1 }), /rollover failed/);
    await f.call('subagent_send', { ownerId: 'parent', id: legacy.id, requestId: 'follow-up', message: 'later' }); await f.stopped(legacy.id);
    assert.equal(f.local.lifecycle.maintaining.size, 0);
  } finally { gate.resolve(); await Promise.allSettled([rolling]); board.rolloverReceipts = original; }
});

test('accepted worker controls fence rollover even before their next queued state is persisted', async t => {
  const f = await fixture(t), { worker } = await f.spawn('control-fence'); await f.stopped(worker.id);
  const original = f.local.engine.send.bind(f.local.engine), entered = deferred(), gate = deferred();
  f.local.engine.send = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const sending = f.call('subagent_send', { ownerId: 'parent', id: worker.id, requestId: 'follow-up', message: 'later' });
  try {
    await entered.promise; assert.equal(f.local.store.get(worker.id).state, 'completed');
    await assert.rejects(f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 0 }), e => e.code === 'worker_busy');
    gate.resolve(); await sending; await f.stopped(worker.id);
    assert.equal(f.local.lifecycle.controls.size, 0);
  } finally { gate.resolve(); await Promise.allSettled([sending]); }
});

test('runner input publication and queued release share an atomic retention boundary', { timeout: 20000 }, async t => {
  const f = await fixture(t, { stream: async function* (_m, _messages, _tools, _signal, n) {
    if (n === 1) { yield { type: 'call', id: 'command', name: 'run_command', input: { command: 'node -e "process.stdout.write(\'ok\')"' } }; }
    else { yield { type: 'text', text: 'done' }; }
  } });
  const views = await f.local.isolation.open(), update = views.index.update.bind(views.index), release = views.release.bind(views);
  const gate = deferred(), published = deferred(), releasing = deferred(); let once = true, collecting;
  views.index.update = async (...args) => {
    const data = await update(...args);
    if (once && Object.keys(data.submissions).length) { once = false; published.resolve(Object.values(data.submissions)[0]); await gate.promise; }
    return data;
  };
  views.release = (...args) => { releasing.resolve(); return release(...args); };
  try {
    const { worker } = await f.spawn('atomic-runner-input'), artifact = await published.promise;
    const scope = { ownerId: 'parent', teamId: f.team.id };
    collecting = f.call('subagent_view_release', { ...scope, requestId: 'retire-during-setup', kind: 'submission', id: artifact.id });
    const refused = assert.rejects(collecting, e => e.code === 'artifact_retained');
    await releasing.promise; gate.resolve(); await refused;
    const done = await f.stopped(worker.id), result = JSON.parse(done.turns[0].tools[0].result);
    assert.equal(result.outcome, 'succeeded'); assert.equal(result.attempt.inputArtifact.id, artifact.id);
    await f.call('subagent_view_cleanup', { ...scope, requestId: 'cleanup-after-input-publication' });
    assert.equal((await f.call('subagent_submission_read', { ...scope, submissionId: artifact.id, operation: 'read_file', input: { path: 'a.txt' } })).content, 'snapshot');
  } finally { gate.resolve(); await Promise.allSettled([collecting]); views.index.update = update; views.release = release; }
});

test('initial request namespaces reserve future epoch prefixes before any side effect', async t => {
  const f = await fixture(t), scope = { ownerId: 'parent', teamId: f.team.id };
  for (const requestId of ['e0:original', 'e1:original', 'e01:original', 'e999:original']) {
    await assert.rejects(f.call('subagent_team_create', { ownerId: 'parent', requestId, name: 'future', description: '' }), e => e.code === 'invalid_arguments');
    await assert.rejects(f.call('subagent_snapshot_create', { ...scope, requestId }), e => e.code === 'invalid_arguments');
  }
  assert.equal((await f.call('subagent_team_list', { ownerId: 'parent' })).teams.length, 1);
  await f.call('subagent_metadata_rollover', { ...scope, kind: 'board', expectedEpoch: 0 });
  const input = { ownerId: 'parent', requestId: 'e1:original', name: 'new epoch', description: '' };
  const first = await f.call('subagent_team_create', input);
  assert.equal((await f.call('subagent_team_create', input)).id, first.id);
  await f.call('subagent_metadata_rollover', { ...scope, kind: 'views', expectedEpoch: 0 });
  const snapshot = await f.call('subagent_snapshot_create', { ...scope, requestId: 'e1:original' });
  assert.equal((await f.call('subagent_snapshot_create', { ...scope, requestId: 'e1:original' })).id, snapshot.id);
  await assert.rejects(f.call('subagent_snapshot_create', { ...scope, requestId: 'snapshot' }), e => e.code === 'request_expired');
});

test('pre-upgrade future-looking receipt IDs replay intact but cannot become fresh after expiry or archive GC', async t => {
  const f = await fixture(t), scope = { ownerId: 'parent', teamId: f.team.id };
  const rules = require('../.test-build/receipt-retention'), original = rules.assertRequestEpoch;
  const teamInput = { ownerId: 'parent', requestId: 'e1:pre-upgrade', name: 'legacy', description: '' };
  const snapshotInput = { ...scope, requestId: 'e1:pre-upgrade' };
  let team, snapshot;
  // Simulate records acknowledged by the earlier unrestricted epoch-zero host.
  rules.assertRequestEpoch = () => {};
  try {
    team = await f.call('subagent_team_create', teamInput);
    snapshot = await f.call('subagent_snapshot_create', snapshotInput);
  } finally { rules.assertRequestEpoch = original; }
  assert.equal((await f.call('subagent_team_create', teamInput)).id, team.id);
  assert.equal((await f.call('subagent_snapshot_create', snapshotInput)).id, snapshot.id);
  await f.call('subagent_metadata_rollover', { ...scope, kind: 'board', expectedEpoch: 0 });
  await f.call('subagent_metadata_rollover', { ...scope, kind: 'views', expectedEpoch: 0 });
  await f.call('subagent_resource_collect', { ...scope, archives: true }); await f.reload();
  await assert.rejects(f.call('subagent_team_create', teamInput), e => e.code === 'request_expired');
  await assert.rejects(f.call('subagent_snapshot_create', snapshotInput), e => e.code === 'request_expired');
  const fresh = await f.call('subagent_team_create', { ...teamInput, requestId: 'e1:fresh' });
  assert.notEqual(fresh.id, team.id);
});

test('the final startup checkpoint retries its scheduling handoff once, while reload still requires explicit resume', async t => {
  for (const mode of ['transport', 'checkpoint', 'reload']) {
    await t.test(mode, async t => {
      const f = await fixture(t), input = await prepared(f, 'handoff');
      const original = f.local.store.onCheckpoint, controller = new AbortController(); let injected = false;
      f.local.store.onCheckpoint = async session => {
        await original(session);
        if (session.startup?.phase === 'started' && !injected) {
          injected = true;
          if (mode === 'checkpoint') { throw Error('interrupted scheduling handoff'); }
          controller.abort(Error('interrupted scheduling handoff'));
        }
      };
      const first = await f.broker.invoke(f.root, 'subagent_isolated_spawn', input, controller.signal);
      assert.equal(first.isError, true); assert.equal(f.state.requests.length, 0);
      const queued = f.local.store.all()[0];
      assert.equal(queued.state, 'queued'); assert.equal(queued.startup.phase, 'started'); assert.equal(f.local.engine.active.has(queued.id), false);
      f.local.store.onCheckpoint = original;
      await assert.rejects(f.call('subagent_isolated_spawn', { ...input, task: 'changed' }), e => e.code === 'idempotency_conflict');
      if (mode === 'reload') {
        await f.reload();
        assert.equal((await f.call('subagent_isolated_spawn', input)).state, 'interrupted');
        assert.equal(f.state.requests.length, 0);
        await f.call('subagent_resume', { ownerId: 'parent', id: queued.id, requestId: 'resume-handoff' });
      } else {
        const [a, b] = await Promise.all([f.call('subagent_isolated_spawn', input), f.call('subagent_isolated_spawn', input)]);
        assert.equal(a.id, b.id);
      }
      await f.stopped(queued.id); assert.equal(f.state.requests.length, 1);
      assert.equal((await f.call('subagent_task_get', { ownerId: 'parent', id: input.setup.taskId })).revision, 1);
    });
  }
});

test('manual compaction yields the engine mutex and its storage wait drains on cancel, expiry or shutdown', async t => {
  for (const mode of ['cancel', 'parent-stop', 'expiry', 'shutdown']) {
    await t.test(mode, async t => {
      const f = await fixture(t);
      const { worker } = await f.spawn('manual-history', { spawn: { parentPolicy: 'cancel-on-expiry', leaseSeconds: 30 } });
      await f.stopped(worker.id); const local = f.local;
      f.state.config = { ...f.state.config, storageBytes: 64 * 1024 ** 2 };
      const other = new ResourceGovernor(() => f.state.config, f.options.resourceDirectory);
      let compaction, control;
      try {
        assert.equal((await other.tryAcquire({ key: 'foreign-storage', kind: 'storage', root: 'other-root', lane: 'integration', bytes: 40 * 1024 ** 2 })).granted, true);
        const before = local.store.get(worker.id);
        compaction = f.call('subagent_compact', { ownerId: 'parent', id: worker.id, revision: before.revision, summary: 'manual summary' });
        const stopped = compaction.then(value => ({ value }), error => ({ error }));
        await until(async () => (await other.status()).claims.some(c => c.state === 'waiting'), 3000);
        // An independent accepted control must progress while compaction awaits storage.
        const legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'independent-control', task: 'done', model: model.id });
        await f.stopped(legacy.id);
        let finished = false;
        if (mode === 'shutdown') { control = f.broker.close(); }
        else if (mode === 'parent-stop') { control = f.call('subagent_parent', { ownerId: 'parent', action: 'stop' }); }
        else if (mode === 'expiry') {
          await local.store.change(worker.id, s => { s.parentExpiresAt = 1; }); control = local.engine.expireParents();
        } else { control = f.call('subagent_cancel', { ownerId: 'parent', id: worker.id }); }
        const completedControl = control.then(() => { finished = true; });
        await until(() => finished, 3000); await completedControl;
        const outcome = await stopped;
        assert.ok(outcome.error, JSON.stringify({ outcome, claims: (await other.status()).claims }));
        assert.ok(['cancelled', 'host_stopping'].includes(outcome.error.code));
        assert.equal(local.store.get(worker.id).state, 'completed');
        assert.equal(local.store.get(worker.id).maintenance, undefined);
        assert.equal(local.store.get(worker.id).archives?.length ?? 0, 0);
        assert.equal((await other.status()).claims.filter(c => c.state === 'waiting').length, 0);
      } finally {
        await other.release('foreign-storage'); await Promise.allSettled([compaction, control]); await other.close();
      }
      if (mode !== 'shutdown') {
        const before = local.store.get(worker.id);
        const archived = await f.call('subagent_compact', { ownerId: 'parent', id: worker.id, revision: before.revision, summary: 'completed manual summary' });
        assert.equal(archived.state, 'completed'); assert.equal(local.store.get(worker.id).archives.length, 1);
      }
    });
  }
});

test('manual compaction setup checkpoint failure preserves the prior worker state for a safe retry', async t => {
  const f = await fixture(t), { worker } = await f.spawn('manual-checkpoint'); await f.stopped(worker.id);
  const original = f.local.store.onCheckpoint; let fail = true;
  f.local.store.onCheckpoint = async session => {
    await original(session);
    if (fail && session.maintenance?.kind === 'compact') { fail = false; throw Error('lost manual compaction checkpoint'); }
  };
  const before = f.local.store.get(worker.id);
  await assert.rejects(f.call('subagent_compact', { ownerId: 'parent', id: worker.id, revision: before.revision, summary: 'retry this summary' }), /lost manual compaction checkpoint/);
  const restored = f.local.store.get(worker.id);
  assert.equal(restored.state, 'completed'); assert.equal(restored.maintenance, undefined); assert.equal(f.local.engine.active.has(worker.id), false);
  assert.equal(restored.archives?.length ?? 0, 0);
  f.local.store.onCheckpoint = original;
  await f.call('subagent_compact', { ownerId: 'parent', id: worker.id, revision: restored.revision, summary: 'retry this summary' });
  assert.equal(f.local.store.get(worker.id).state, 'completed'); assert.equal(f.local.store.get(worker.id).archives.length, 1);
});

test('reload restores interrupted manual compaction without replaying inference or archive effects', async t => {
  const f = await fixture(t), { worker, input } = await f.spawn('manual-reload'); await f.stopped(worker.id);
  await f.local.store.change(worker.id, s => {
    s.state = 'running'; s.maintenance = { kind: 'compact', previousState: 'cancelled' };
  });
  await f.reload();
  const restored = f.local.store.get(worker.id);
  assert.equal(restored.state, 'cancelled'); assert.equal(restored.maintenance, undefined);
  assert.equal(restored.maintenanceError.code, 'compaction_interrupted'); assert.equal(restored.archives?.length ?? 0, 0);
  assert.equal((await f.call('subagent_isolated_spawn', input)).state, 'cancelled'); assert.equal(f.state.requests.length, 1);
  const archived = await f.call('subagent_compact', { ownerId: 'parent', id: worker.id, revision: restored.revision, summary: 'explicit recovered summary' });
  assert.equal(archived.state, 'cancelled'); assert.equal(f.local.store.get(worker.id).archives.length, 1);
});

test('evidence pin namespaces migrate intact and missing established metadata fails closed', async t => {
  const { EvidenceRetention } = require('../.test-build/evidence-retention');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-namespace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'evidence-retention.json'), marker = path.join(dir, 'evidence-retention.namespace.json');
  const data = JSON.stringify({ schema: 1, pins: [{ ownerId: 'parent', teamId: 'a'.repeat(32), name: 'consumer', uri: 'urn:evidence' }] }, null, 2);
  await fs.writeFile(file, data);
  const evidence = new EvidenceRetention(dir);
  await evidence.withReferences(async refs => assert.ok(refs.has('urn:evidence')));
  assert.equal(await fs.readFile(file, 'utf8'), data, 'migration must not rewrite existing pins');
  const identity = await fs.readFile(marker);
  await fs.unlink(file);
  const reloaded = new EvidenceRetention(dir); assert.equal(await reloaded.exists(), true);
  await assert.rejects(reloaded.withReferences(async () => assert.fail('GC must not proceed')), e => e.code === 'retention_corrupt');
  await fs.writeFile(file, data);
  await reloaded.withReferences(async refs => assert.ok(refs.has('urn:evidence')));
  await fs.writeFile(marker, '{}');
  await assert.rejects(new EvidenceRetention(dir).withReferences(async () => {}), e => e.code === 'retention_corrupt');
  await fs.writeFile(marker, identity);
});

test('exclusive ledger admission retries Windows lock turnover but never admits beyond capacity', async t => {
  for (const code of ['EPERM', 'EACCES', 'EIO']) {
    await t.test(code, async t => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-lock-turnover-'));
      const governor = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true, modelCapacity: 2 }), dir);
      t.after(async () => { await governor.close(); await fs.rm(dir, { recursive: true, force: true }); });
      const request = key => ({ key, kind: 'model', root: key, model: model.id, localCapacity: 4 });
      await governor.tryAcquire(request('held'));
      const original = fs.open; let calls = 0, injected = false;
      fs.open = async (file, flags, ...args) => {
        if (file === path.join(dir, 'transaction.lock') && flags === 'wx') {
          calls++;
          if (!injected) { injected = true; throw Object.assign(Error('lock turnover'), { code }); }
        }
        return original(file, flags, ...args);
      };
      try {
        if (process.platform === 'win32' && code !== 'EIO') {
          assert.equal((await governor.tryAcquire(request('queued'))).granted, false); assert.ok(calls >= 2);
        } else {
          await assert.rejects(governor.tryAcquire(request('queued')), e => e.code === code); assert.equal(calls, 1);
        }
      } finally { fs.open = original; }
      assert.equal((await governor.tryAcquire(request('queued'))).granted, false);
      assert.equal((await governor.status()).claims.filter(c => c.state === 'active').length, 1);
      await governor.release('held'); await governor.release('queued');
    });
  }
});

test('resource configuration is User-only and bounded', () => {
  assert.deepEqual(readResourceConfig(() => ({ workspaceValue: true, workspaceFolderValue: 128 })), resourceDefaults);
  assert.equal(readResourceConfig(key => ({ globalValue: key === 'resources.enabled' ? true : undefined })).enabled, true);
  assert.throws(() => readResourceConfig(key => ({ globalValue: key === 'resources.modelCapacity' ? 0 : undefined })));
  const pkg = require('../package.json').contributes.configuration.properties;
  for (const key of Object.keys(resourceDefaults)) { assert.equal(pkg['codexSubagent.resources.' + key].scope, 'machine'); }
});

test('releasing an absent evidence pin is idempotent and preserves other consumers', async t => {
  const { EvidenceRetention } = require('../.test-build/evidence-retention');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-release-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const evidence = new EvidenceRetention(dir), scope = { ownerId: 'parent', teamId: 'a'.repeat(32), uri: 'urn:example:retained' };
  await evidence.update({ ...scope, name: 'active', action: 'pin' }, () => {});
  await evidence.update({ ...scope, name: 'absent', action: 'release' }, () => {});
  await evidence.update({ ...scope, name: 'absent', action: 'release' }, () => {});
  await evidence.withReferences(uris => assert.deepEqual([...uris], [scope.uri]));
});

test('first inference and first tool have membership, assignment and private files; duplicate spawn starts once', async t => {
  let f;
  f = await fixture(t, { stream: async function* (_model, _messages, tools, _signal, n) {
    const worker = f.local.store.all().find(s => s.startup);
    assert.equal(worker.startup.phase, 'started'); assert.equal(worker.schema, 3);
    const board = await f.local.board.open();
    assert.ok(board.getTeam({ kind: 'coordinator', ownerId: 'parent' }, f.team.id).memberWorkerIds.includes(worker.id));
    assert.equal(board.getTask({ kind: 'coordinator', ownerId: 'parent' }, worker.startup.taskId).assigneeWorkerId, worker.id);
    assert.ok(tools.some(t => t.name === 'read_file'));
    if (n === 1) { yield { type: 'call', id: 'read', name: 'read_file', input: { path: 'a.txt' } }; }
    else { yield { type: 'text', text: 'done' }; }
  } });
  await fs.writeFile(path.join(f.root, 'a.txt'), 'live changed');
  const { worker, input } = await f.spawn('first'); const done = await f.stopped(worker.id);
  assert.equal(JSON.parse(done.turns[0].tools[0].result).content, 'snapshot');
  assert.equal((await f.call('subagent_isolated_spawn', input)).id, worker.id);
  assert.equal(f.state.requests.length, 2);
  await assert.rejects(f.call('subagent_isolated_spawn', { ...input, task: 'different' }), e => e.code === 'idempotency_conflict');
});

test('interrupted setup reloads without inference and retries the same assignment and binding', async t => {
  const f = await fixture(t); const local = f.local;
  const original = local.isolation.invoke.bind(local.isolation);
  let fail = true;
  local.isolation.invoke = async (...args) => { if (args[0] === 'subagent_view_bind' && fail) { fail = false; throw Error('interrupted binding'); } return original(...args); };
  let input;
  // Capture the exact request that failed after the board transaction committed.
  const team = f.team, task = await f.call('subagent_task_create', { ownerId: 'parent', requestId: 'task', teamId: team.id, title: 'task', description: '' });
  input = { ownerId: 'parent', requestId: 'interrupted', task: 'task', model: model.id, setup: { teamId: team.id, taskId: task.id, snapshotId: f.snapshot.id, teamRevision: team.revision, taskRevision: task.revision, lane: 'work' } };
  await assert.rejects(f.call('subagent_isolated_spawn', input), /interrupted binding/);
  const before = local.store.all()[0]; assert.equal(before.startup.phase, 'assigned'); assert.equal(f.state.requests.length, 0);
  await assert.rejects(f.call('subagent_resume', { ownerId: 'parent', id: before.id, requestId: 'wrong-resume' }), e => e.code === 'startup_incomplete');
  await assert.rejects(f.call('subagent_send', { ownerId: 'parent', id: before.id, requestId: 'wrong-send', message: 'go' }), e => e.code === 'startup_incomplete');
  await f.reload(); assert.equal(f.state.requests.length, 0);
  const started = await f.call('subagent_isolated_spawn', input); await f.stopped(started.id);
  assert.equal(started.id, before.id);
  const updated = await f.call('subagent_task_get', { ownerId: 'parent', id: task.id }); assert.equal(updated.revision, 1);
  assert.equal((await f.call('subagent_team_get', { ownerId: 'parent', id: team.id })).memberWorkerIds.length, 1);
});

test('dependency waits hold no capacity, cancellation and parent expiry stop queued work', async t => {
  const f = await fixture(t);
  const producer = await f.call('subagent_task_create', { ownerId: 'parent', requestId: 'producer', teamId: f.team.id, title: 'producer', description: '' });
  const { worker } = await f.spawn('waiter', { task: { dependencies: [{ taskId: producer.id, kind: 'artifact' }] } });
  await until(() => f.local.store.get(worker.id).waitingReason === 'dependency');
  assert.equal(f.state.requests.length, 0);
  assert.equal((await f.call('subagent_resource_status')).claims.filter(c => c.state !== 'waiting').length, 0);
  await f.call('subagent_cancel', { ownerId: 'parent', id: worker.id });
  const next = await f.spawn('expiry', { task: { dependencies: [{ taskId: producer.id, kind: 'artifact' }] }, spawn: { parentPolicy: 'cancel-on-expiry' } });
  await f.local.store.change(next.worker.id, s => { s.parentExpiresAt = 1; }); await f.local.engine.expireParents();
  assert.equal((await f.broker.session(f.root, next.worker.id)).state, 'cancelled'); assert.equal(f.state.requests.length, 0);
});

test('aggregate fair queue spans roots and hosts, service reserve progresses at full work capacity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-'));
  const config = { ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 2, runnerCapacity: 2 };
  const a = new ResourceGovernor(() => config, dir), b = new ResourceGovernor(() => config, dir);
  t.after(async () => { await a.close(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = (key, root = 'a', lane = 'work') => ({ key, kind: 'model', root, lane, model: model.id, localCapacity: 8 });
  assert.equal((await a.tryAcquire(request('one'))).granted, true);
  assert.equal((await b.tryAcquire(request('two', 'other-root'))).reason, 'model_capacity');
  assert.equal((await a.tryAcquire(request('three', 'third-root'))).granted, false);
  assert.equal((await b.tryAcquire(request('validate', 'other-root', 'validation'))).granted, true);
  await a.release('one'); await b.release('validate');
  assert.equal((await a.tryAcquire(request('three', 'third-root'))).granted, false, 'older eligible request wins');
  assert.equal((await b.tryAcquire(request('two', 'other-root'))).granted, true);
  await b.release('two'); assert.equal((await a.tryAcquire(request('three', 'third-root'))).granted, true);
  await a.release('three');
});

test('full production queue metadata preserves service admission across roots', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'full-queue-'));
  const governor = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true, modelCapacity: 2 }), dir);
  t.after(async () => { await governor.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = (key, lane = 'work') => ({ key, kind: 'model', lane, root: key, model: model.id, localCapacity: 8 });
  assert.equal((await governor.tryAcquire(request('active'))).granted, true);
  // Populate an otherwise identical blocked queue at its hard work limit.
  await governor.transaction(data => {
    const active = data.claims[0];
    for (let i = 0; i < 479; i++) data.claims.push({ ...active, key: 'waiting-' + i, root: 'waiting-' + i, sequence: ++data.sequence, state: 'waiting' });
  });
  await assert.rejects(governor.tryAcquire(request('overflow')), e => e.code === 'resource_capacity');
  assert.equal((await governor.tryAcquire(request('validation', 'validation'))).granted, true);
  assert.equal((await governor.status()).summary.claims, 481);
  await governor.release('active'); await governor.release('validation');
});

test('full production startup metadata leaves preparation and control headroom for service decisions', async t => {
  const f = await fixture(t), lifecycle = f.local.lifecycle;
  const base = { ownerId: 'parent', requestId: 'pending', task: 'pending', setup: { teamId: f.team.id, taskId: 'a'.repeat(32), snapshotId: f.snapshot.id, teamRevision: 0, taskRevision: 0, lane: 'work' } };
  let gate = deferred();
  const preparations = Array.from({ length: 28 }, (_, i) => lifecycle.prepare({ ...base, requestId: 'preparation-' + i }, new AbortController().signal, () => gate.promise));
  try {
    await assert.rejects(lifecycle.prepare({ ...base, requestId: 'overflow' }, new AbortController().signal, () => gate.promise), e => e.code === 'resource_queue_full');
    assert.equal(await lifecycle.prepare({ ...base, requestId: 'validate', setup: { ...base.setup, lane: 'validation' } }, new AbortController().signal, async () => 'admitted'), 'admitted');
  } finally { gate.resolve(); await Promise.all(preparations); }
  assert.equal(lifecycle.preparations.size, 0);
  gate = deferred();
  const original = lifecycle.invokeNow; lifecycle.invokeNow = async () => gate.promise;
  const controls = Array.from({ length: 56 }, () => lifecycle.invoke('subagent_isolated_spawn', base));
  try {
    await assert.rejects(lifecycle.invoke('subagent_isolated_spawn', base), e => e.code === 'resource_queue_full');
    controls.push(lifecycle.invoke('subagent_isolated_spawn', { ...base, setup: { ...base.setup, lane: 'integration' } }));
    assert.equal(lifecycle.startupControls, 57);
  } finally { gate.resolve(); await Promise.all(controls); lifecycle.invokeNow = original; }
  assert.equal(lifecycle.startupControls, 0); assert.equal(lifecycle.workStartupControls, 0);
});

test('numSessions retains the owning-store scope while an aggregate ceiling spans stores of the same root', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-scope-'));
  const config = { ...resourceDefaults, enabled: true, modelCapacity: 3 };
  const a = new ResourceGovernor(() => config, dir), b = new ResourceGovernor(() => config, dir);
  t.after(async () => { await a.close(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = (key, scope) => ({ key, scope, kind: 'model', root: 'same-root', model: model.id, localCapacity: 1 });
  assert.equal((await a.tryAcquire(request('first', 'store-a'))).granted, true);
  assert.equal((await a.tryAcquire(request('same-store', 'store-a'))).granted, false);
  assert.equal((await b.tryAcquire(request('second', 'store-b'))).granted, true);
  assert.equal((await b.tryAcquire(request('aggregate', 'store-c'))).granted, false);
  await a.release('first'); await b.release('second');
});

test('receipt rollover expires old retries, keeps immutable refs and supports repeated bounded collection', async t => {
  const f = await fixture(t); const { worker } = await f.spawn('done'); await f.stopped(worker.id);
  const scope = { ownerId: 'parent', teamId: f.team.id };
  const first = await f.call('subagent_metadata_rollover', { ...scope, kind: 'board', expectedEpoch: 0 }); assert.equal(first.epoch, 1);
  assert.equal((await f.call('subagent_metadata_rollover', { ...scope, kind: 'board', expectedEpoch: 0 })).replay, true);
  await assert.rejects(f.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' }), e => e.code === 'request_expired');
  await f.call('subagent_team_create', { ownerId: 'parent', requestId: 'e1:new', name: 'new', description: '' });
  await f.call('subagent_metadata_rollover', { ...scope, kind: 'views', expectedEpoch: 0 });
  await assert.rejects(f.call('subagent_snapshot_create', { ...scope, requestId: 'snapshot' }), e => e.code === 'request_expired');
  const collected = await f.call('subagent_resource_collect', { ...scope, archives: true });
  assert.equal(collected.boardArchives, 1); assert.equal(collected.viewArchives, 1);
  await f.reload();
  await assert.rejects(f.call('subagent_snapshot_create', { ...scope, requestId: 'snapshot' }), e => e.code === 'request_expired');
  await f.call('subagent_snapshot_create', { ...scope, requestId: 'e1:fresh' });
});

test('live policy removal while queued prevents any provider request', async t => {
  const hold = deferred();
  const f = await fixture(t, { config: { modelCapacity: 2, runnableCapacity: 2 }, stream: async function* (_m,_h,_t,signal) { await Promise.race([hold.promise, new Promise(r => signal.addEventListener('abort',r,{once:true}))]); yield { type:'text',text:'done' }; } });
  const one = await f.spawn('one'); await until(() => f.state.requests.length === 1);
  const two = await f.spawn('two'); await until(() => f.local.store.get(two.worker.id).waitingReason === 'model_capacity');
  f.state.models = {}; hold.resolve(); await f.stopped(one.worker.id); const done = await f.stopped(two.worker.id);
  assert.equal(done.state, 'failed'); assert.equal(f.state.requests.length, 1);
});

async function prepared(f, requestId, lane = 'work') {
  const team = await f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id });
  const task = await f.call('subagent_task_create', { ownerId: 'parent', requestId: 'task-' + requestId, teamId: team.id, title: requestId, description: '' });
  return { ownerId: 'parent', requestId, task: requestId, model: model.id, permission: 'workspace-write',
    setup: { teamId: team.id, taskId: task.id, snapshotId: f.snapshot.id, teamRevision: team.revision, taskRevision: task.revision, lane } };
}

test('a lost assignment checkpoint and concurrent duplicate requests establish exactly one assignment', async t => {
  const f = await fixture(t), input = await prepared(f, 'checkpoint');
  const original = f.local.store.change.bind(f.local.store); let fail = true;
  f.local.store.change = (id, change, guard) => original(id, draft => {
    change(draft);
    if (draft.startup?.phase === 'assigned' && fail) { fail = false; throw Error('lost setup checkpoint'); }
  }, guard);
  await assert.rejects(f.call('subagent_isolated_spawn', input), /lost setup checkpoint/);
  assert.equal(f.local.store.all()[0].startup.phase, 'created'); assert.equal(f.state.requests.length, 0);
  const [a,b] = await Promise.all([f.call('subagent_isolated_spawn', input), f.call('subagent_isolated_spawn', input)]);
  assert.equal(a.id, b.id); await f.stopped(a.id); assert.equal(f.state.requests.length, 1);
  assert.equal((await f.call('subagent_task_get', { ownerId:'parent', id:input.setup.taskId })).revision, 1);
});

test('a crash between permanent marker and view acknowledgement is recoverable without a live turn', async t => {
  const f = await fixture(t), input = await prepared(f, 'marker');
  const views = await f.local.isolation.open(), original = views.index.update.bind(views.index); let fail = true;
  views.index.update = (mutate, guard) => original(draft => { const old = Object.keys(draft.overlays).length; mutate(draft); if (Object.keys(draft.overlays).length > old && fail) { fail = false; throw Error('lost view acknowledgement'); } }, guard);
  await assert.rejects(f.call('subagent_isolated_spawn', input), /lost view acknowledgement/);
  const before = f.local.store.all()[0]; assert.equal(before.schema, 3); assert.equal(before.startup.phase, 'assigned'); assert.equal(f.state.requests.length, 0);
  await f.reload(); const started = await f.call('subagent_isolated_spawn', input); await f.stopped(started.id);
  assert.deepEqual(started.isolatedView, before.isolatedView); assert.equal(f.state.requests.length, 1);
});

test('cancelled incomplete setup cannot be restarted by a duplicate request', async t => {
  const f = await fixture(t), input = await prepared(f, 'cancel-setup');
  const original = f.local.isolation.invoke.bind(f.local.isolation), gate = deferred(), entered = deferred();
  f.local.isolation.invoke = async (...args) => { if(args[0] === 'subagent_view_bind') { entered.resolve(); await gate.promise; } return original(...args); };
  const starting = f.call('subagent_isolated_spawn', input); const rejected = assert.rejects(starting);
  await entered.promise; const worker = f.local.store.all()[0];
  await f.call('subagent_cancel', { ownerId:'parent', id:worker.id }); gate.resolve(); await rejected;
  await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'cancelled');
  assert.equal(f.state.requests.length, 0);
});

test('shutdown drains accepted setup before giving up the root lock', async t => {
  const f = await fixture(t), input = await prepared(f, 'close-setup');
  const original = f.local.isolation.invoke.bind(f.local.isolation), gate = deferred(), entered = deferred();
  f.local.isolation.invoke = async (...args) => { if(args[0] === 'subagent_view_bind') { entered.resolve(); await gate.promise; } return original(...args); };
  const starting = f.call('subagent_isolated_spawn', input), rejected = assert.rejects(starting);
  await entered.promise; let closed = false; const closing = f.broker.close().then(() => { closed = true; });
  await new Promise(r=>setTimeout(r,30)); assert.equal(closed, false); gate.resolve(); await rejected; await closing;
  assert.equal(f.state.requests.length, 0);
});

test('undrained inference remains charged through cancellation and reload, then releases only on actual drain', async t => {
  const gate = deferred();
  const f = await fixture(t, { stream: async function* (_m,_h,_t,_s,n) { if(n===1) { await gate.promise; yield { type:'call',id:'late',name:'write_file',input:{path:'late.txt',content:'unsafe',expectedHash:'new'} }; } else { yield {type:'text',text:'done'}; } } });
  const { worker } = await f.spawn('ignores-abort'); await until(()=>f.state.requests.length===1);
  await f.call('subagent_cancel', { ownerId:'parent', id:worker.id });
  assert.equal((await f.call('subagent_resource_status')).claims.filter(c=>c.kind==='model').length,1);
  await f.reload();
  assert.equal((await f.call('subagent_resource_status')).claims.find(c=>c.kind==='model').state,'quarantine');
  gate.resolve(); await until(async ()=>(await f.call('subagent_resource_status')).claims.every(c=>c.kind!=='model'));
  assert.equal(await fs.stat(path.join(f.root,'late.txt')).then(()=>true,()=>false),false);
});

test('runner aggregate admission reserves local validation capacity, retains quarantine and recovers without replay', async t => {
  const { RunnerPool } = require('../.test-build/runner-pool');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'aggregate-runners-'));
  const config = { ...resourceDefaults, enabled:true, runnerCapacity:3 };
  const resources = new ResourceGovernor(()=>config,path.join(dir,'resources'));
  const owner = (id,lane='work')=>({ownerId:lane,teamId:'a'.repeat(32),workerId:id.repeat(32),workerCreatedAt:new Date(0).toISOString()});
  const admission=resources.runnerAdmission(path.join(dir,'pool'), 'root', o=>o.ownerId);
  const options={capacity:2,maxQueue:8,admission}; let pool = new RunnerPool(path.join(dir,'pool'),options); await pool.open();
  t.after(async()=>{await pool.close();await resources.close();await fs.rm(dir,{recursive:true,force:true});});
  const a=await pool.acquire(owner('1')); const cancel=new AbortController(); const waiting=pool.acquire(owner('2'),cancel.signal); const cancelled=assert.rejects(waiting,e=>e.code==='pool_aborted');
  await until(()=>pool.status().queue.length===1);
  const validation=await pool.acquire(owner('3','validation'));
  assert.equal(pool.status().slots.filter(s=>s.state==='active').length,2);
  cancel.abort(); await cancelled;
  await validation.release({drained:true}); await a.release({drained:false});
  assert.equal((await resources.status()).claims.find(c=>c.kind==='runner').state,'quarantine');
  await pool.cleanup({ownerId:'work',teamId:'a'.repeat(32)},()=>true);
  assert.equal((await resources.status()).claims.filter(c=>c.kind==='runner').length,0);
  const again=await pool.acquire(owner('4'));await again.release({drained:false});
  await pool.close(); pool=new RunnerPool(path.join(dir,'pool'),{...options,proveDrained:()=>true});await pool.open();
  assert.equal((await resources.status()).claims.filter(c=>c.kind==='runner').length,0);
});

test('policy reductions do not evict owners, another host cannot widen limits, and storage waits are fair', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'resource-policy-')); let config={...resourceDefaults,enabled:true,modelCapacity:4,storageBytes:64*1024**2};
  const a=new ResourceGovernor(()=>config,dir), b=new ResourceGovernor(()=>({...config,modelCapacity:128}),dir);
  t.after(async()=>{await a.close();await b.close();await fs.rm(dir,{recursive:true,force:true});});
  const modelRequest=key=>({key,kind:'model',root:key,model:'m',localCapacity:10});
  await a.tryAcquire(modelRequest('first'));await a.tryAcquire(modelRequest('second'));config={...config,modelCapacity:2};
  await a.refreshPolicy(); // A policy change is published without another admission on its host.
  assert.equal((await b.tryAcquire(modelRequest('fourth'))).granted,false);assert.equal((await a.tryAcquire(modelRequest('third'))).granted,false);
  assert.equal((await b.status()).policy.modelCapacity,2);
  await a.release('first');await a.release('second');await a.release('third');await b.release('fourth');
  const storage=(key,mb,lane='work')=>({key,kind:'storage',root:key,bytes:mb*1024**2,lane});
  await a.tryAcquire(storage('held',32));assert.equal((await a.tryAcquire(storage('large',32))).reason,'storage');
  assert.equal((await b.tryAcquire(storage('small',1))).granted,false,'small work cannot starve an older storage waiter');
  assert.equal((await b.tryAcquire(storage('service',1,'integration'))).granted,true);
  await a.release('held');assert.equal((await a.tryAcquire(storage('large',32))).granted,true);
  await a.account('retained',async()=>64*1024**2);
  await assert.rejects(a.tryAcquire(storage('exhausted',1)),e=>e.code==='storage_exhausted'&&/Collect/.test(e.message));
});

test('immutable reference identities survive receipt expiry and archive collection', async t => {
  const f=await fixture(t), actor={ownerId:'parent'};
  let task=await f.call('subagent_task_create',{...actor,requestId:'refs',teamId:f.team.id,title:'refs',description:''});
  task=await f.call('subagent_task_update',{...actor,requestId:'agree',taskId:task.id,expectedRevision:task.revision,agreedContracts:{add:[{id:'contract',version:1,uri:'urn:original'}]}});
  task=await f.call('subagent_task_update',{...actor,requestId:'revoke',taskId:task.id,expectedRevision:task.revision,agreedContracts:{remove:[{id:'contract',version:1}]}});
  await f.call('subagent_metadata_rollover',{...actor,teamId:f.team.id,kind:'board',expectedEpoch:0});
  await f.call('subagent_resource_collect',{...actor,teamId:f.team.id,archives:true});await f.reload();
  await assert.rejects(f.call('subagent_task_update',{...actor,requestId:'e1:rewrite',taskId:task.id,expectedRevision:task.revision,agreedContracts:{add:[{id:'contract',version:1,uri:'urn:rewritten'}]}}),e=>e.code==='ref_conflict');
});

test('deleted governed requests are tombstoned, and expiry permits bounded tombstone collection without replay', async t => {
  const f=await fixture(t), {worker,input}=await f.spawn('retired');await f.stopped(worker.id);
  await f.call('subagent_delete',{ownerId:'parent',id:worker.id});
  await assert.rejects(f.call('subagent_isolated_spawn',input),e=>e.code==='request_expired');
  await f.call('subagent_metadata_rollover',{ownerId:'parent',teamId:f.team.id,kind:'board',expectedEpoch:0});
  const gc=await f.call('subagent_resource_collect',{ownerId:'parent',teamId:f.team.id});assert.equal(gc.tombstones,1);
  await assert.rejects(f.call('subagent_isolated_spawn',input),e=>e.code==='request_expired');assert.equal(f.state.requests.length,1);
});

test('at full production capacity validation and integration commands progress while approvals and another command wait', {timeout:30000}, async t => {
  const approval=deferred();
  const f=await fixture(t,{config:{modelCapacity:2,runnableCapacity:2,runnerCapacity:3},stream:async function* (_m,messages) {
    if(!messages.some(m=>m.role==='assistant')) { yield {type:'call',id:'command',name:'run_command',input:{command:'node -e "process.stdout.write(\'ok\')"',path:'.'}}; }
    else {yield {type:'text',text:'done'};}
  }});
  f.state.models[model.id].numSessions=1;
  f.options.runners=()=>({enabled:true,capacity:2,maxQueue:8});
  f.options.files.approveCommand=async (_c,_cwd,_s,_r,context)=>{
    const session=f.local.store.all().find(s=>s.isolatedView?.overlayId===context.inputVersion.overlayId);
    return session.startup.lane==='work' ? approval.promise : true;
  };
  f.local.isolation.options.runners=f.options.runners;
  f.local.isolation.options.approveCommand=f.options.files.approveCommand;
  const one=await f.spawn('production-one');await until(()=>f.local.store.get(one.worker.id).waitingReason==='approval');
  const pending=[...f.local.isolation.runners.results.pending.values()][0].attempt;
  await assert.rejects(f.call('subagent_view_release',{ownerId:'parent',teamId:f.team.id,requestId:'release-pending-command-input',kind:'submission',id:pending.inputArtifact.id}),e=>e.code==='artifact_retained');
  const two=await f.spawn('production-two');await until(()=>f.local.store.get(two.worker.id).waitingReason==='runner_capacity');
  const validation=await f.spawn('validation',{lane:'validation'});const validated=await f.stopped(validation.worker.id);
  const result=JSON.parse(validated.turns[0].tools[0].result);assert.equal(result.outcome,'succeeded');assert.equal(result.attempt.inputArtifact.revision,0);
  const integration=await f.spawn('integration',{lane:'integration'});assert.equal((await f.stopped(integration.worker.id)).state,'completed');
  assert.equal(f.local.store.get(one.worker.id).waitingReason,'approval');
  const ledger=await f.call('subagent_resource_status');assert.equal(ledger.claims.filter(c=>c.kind==='runner'&&c.state==='active').length,1);
  await f.call('subagent_cancel',{ownerId:'parent',id:one.worker.id});await f.call('subagent_cancel',{ownerId:'parent',id:two.worker.id});approval.resolve(false);
});

test('command evidence pins, active tasks and board references override explicit result collection', {timeout:20000}, async t => {
  const f=await fixture(t,{stream:async function* (_m,messages) { if(!messages.some(m=>m.role==='assistant')) {yield {type:'call',id:'command',name:'run_command',input:{command:'node -e "require(\'fs\').writeFileSync(\'a.txt\',\'runner import\')"'}};}else{yield {type:'text',text:'done'};} }});
  const {worker,task}=await f.spawn('result');const completed=await f.stopped(worker.id);const result=JSON.parse(completed.turns[0].tools[0].result);
  const scope={ownerId:'parent',teamId:f.team.id};
  await until(()=>!f.local.engine.active.has(worker.id));
  const charged=Object.values((await f.call('subagent_resource_status')).stores).find(s=>s.directory===f.local.store.directory);
  assert.equal(charged.bytes,await require('../.test-build/resource-governor').storageUsage(f.local.store.directory));
  assert.equal(result.attempt.inputArtifact.revision,0);assert.equal(result.afterVersion.revision,1);
  await assert.rejects(f.call('subagent_view_release',{...scope,requestId:'release-uncollected-command-input',kind:'submission',id:result.attempt.inputArtifact.id}),e=>e.code==='artifact_retained');
  assert.equal((await f.call('subagent_submission_read',{...scope,submissionId:result.attempt.inputArtifact.id,operation:'read_file',input:{path:'a.txt'}})).content,'snapshot');
  assert.equal((await f.call('subagent_task_get',{ownerId:'parent',id:task.id})).validations.length,0);
  let gc=await f.call('subagent_resource_collect',{...scope,resultIds:[result.id]});assert.match(gc.results.retained[0].reason,/active worker/);assert.ok(gc.results.leases>0);
  const current=await f.call('subagent_task_get',{ownerId:'parent',id:task.id});
  await f.call('subagent_task_update',{ownerId:'parent',requestId:'cancel-result-task',taskId:task.id,expectedRevision:current.revision,state:'cancelled'});
  await f.call('subagent_evidence_retention',{...scope,action:'pin',name:'consumer',uri:result.uri});
  const pinFile = path.join(f.local.store.directory, 'evidence-retention.json'), savedPins = await fs.readFile(pinFile);
  await f.broker.close(); await fs.unlink(pinFile); await f.reload();
  await assert.rejects(f.call('subagent_resource_collect',{...scope,resultIds:[result.id]}), e => e.code === 'retention_corrupt');
  assert.equal((await f.call('subagent_runner_result',{...scope,id:result.id})).result.id, result.id);
  await fs.writeFile(pinFile, savedPins);
  assert.match((await f.call('subagent_resource_collect',{...scope,resultIds:[result.id]})).results.retained[0].reason,/reference/);
  await assert.rejects(f.call('subagent_view_release',{...scope,requestId:'release-pinned-result-input',kind:'submission',id:result.attempt.inputArtifact.id}),e=>e.code==='artifact_retained');
  gc=await f.call('subagent_resource_collect',{...scope,resultIds:[result.id]});assert.match(gc.results.retained[0].reason,/reference/);
  await f.call('subagent_evidence_retention',{...scope,action:'release',name:'consumer',uri:result.uri});
  const contractTask=await f.call('subagent_task_create',{ownerId:'parent',requestId:'evidence-contract-task',teamId:f.team.id,title:'consumer',description:''});
  const contract=await f.call('subagent_task_update',{ownerId:'parent',requestId:'evidence-contract',taskId:contractTask.id,expectedRevision:contractTask.revision,agreedContracts:{add:[{id:result.id,version:1,uri:result.uri}]}});
  await assert.rejects(f.call('subagent_view_release',{...scope,requestId:'release-board-result-input',kind:'submission',id:result.attempt.inputArtifact.id}),e=>e.code==='artifact_retained');
  gc=await f.call('subagent_resource_collect',{...scope,resultIds:[result.id]});assert.match(gc.results.retained[0].reason,/reference/);
  await f.call('subagent_task_update',{ownerId:'parent',requestId:'evidence-revoke',taskId:contractTask.id,expectedRevision:contract.revision,agreedContracts:{remove:[{id:result.id,version:1}]}});
  await f.call('subagent_metadata_rollover',{...scope,kind:'board',expectedEpoch:0});
  await f.call('subagent_view_pin',{...scope,requestId:'pin-input-consumer',name:'input-consumer',resource:{kind:'submission',id:result.attempt.inputArtifact.id}});
  gc=await f.call('subagent_resource_collect',{...scope,resultIds:[result.id]});assert.equal(gc.results.removed.length,1);
  assert.equal((await f.call('subagent_submission_read',{...scope,submissionId:result.attempt.inputArtifact.id,operation:'read_file',input:{path:'a.txt'}})).content,'snapshot');
  await assert.rejects(f.call('subagent_runner_result',{...scope,id:result.id}),e=>e.code==='runner_results_not_found');
});


test('full board and view receipt maps roll over without raising caps or changing immutable artifact IDs', async t => {
  const { digest }=require('../.test-build/storage');
  const { limits }=require('../.test-build/task-board-types');
  const { indexLimits }=require('../.test-build/isolated-index');
  const f=await fixture(t), board=await f.local.board.open(), views=await f.local.isolation.open();
  for(let i=Object.keys(board.data.requests).length;i<limits.requests;i++) {
    board.data.requests[digest(['board',i])]={fingerprint:digest(i),result:board.data.teams[0],at:new Date(0).toISOString()};
  }
  await assert.rejects(f.call('subagent_team_create',{ownerId:'parent',requestId:'overflow',name:'overflow',description:''}),e=>e.code==='capacity_exceeded');
  await f.call('subagent_metadata_rollover',{ownerId:'parent',teamId:f.team.id,kind:'board',expectedEpoch:0});
  assert.equal(Object.keys(board.data.requests).length,0);assert.equal(limits.requests,1000);
  assert.equal(board.data.schema,2,'older hosts must reject boards carrying request expiry');
  await views.index.update(draft=>{
    for(let i=Object.keys(draft.receipts).length;i<indexLimits.receipts;i++) {const key=digest(['view',i]);draft.receipts[key]={fingerprint:digest(i),result:{}};(draft.receiptOwners??={})[key]='parent';}
  });
  await f.call('subagent_metadata_rollover',{ownerId:'parent',teamId:f.team.id,kind:'views',expectedEpoch:0});
  assert.equal(Object.keys(views.index.read().receipts).length,0);assert.equal(indexLimits.receipts,4096);
  const retained=await views.inspect('parent',f.team.id);assert.equal(retained.snapshots[0].id,f.snapshot.id);
  await f.reload();await assert.rejects(f.call('subagent_snapshot_create',{ownerId:'parent',teamId:f.team.id,requestId:'snapshot'}),e=>e.code==='request_expired');
});

test('request epochs are owner scoped and do not expire another team coordinator receipts', async t => {
  const f=await fixture(t);const other={ownerId:'other',requestId:'other-team',name:'other',description:''};
  const team=await f.call('subagent_team_create',other);
  const snapshot=await f.call('subagent_snapshot_create',{ownerId:'other',teamId:team.id,requestId:'other-snapshot'});
  await f.call('subagent_metadata_rollover',{ownerId:'parent',teamId:f.team.id,kind:'board',expectedEpoch:0});
  await f.call('subagent_metadata_rollover',{ownerId:'parent',teamId:f.team.id,kind:'views',expectedEpoch:0});
  assert.equal((await f.call('subagent_team_create',other)).id,team.id);
  assert.equal((await f.call('subagent_snapshot_create',{ownerId:'other',teamId:team.id,requestId:'other-snapshot'})).id,snapshot.id);
  await assert.rejects(f.call('subagent_metadata_rollover',{ownerId:'parent',teamId:team.id,kind:'views',expectedEpoch:0}),e=>e.code==='forbidden');
});

test('separate extension host processes contend on one OS-user ledger', async t => {
  const {execFile}=require('node:child_process');const {promisify}=require('node:util');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'governance-process-'));
  const config={...resourceDefaults,enabled:true,modelCapacity:2};const governor=new ResourceGovernor(()=>config,dir);
  t.after(async()=>{await governor.close();await fs.rm(dir,{recursive:true,force:true});});
  await governor.tryAcquire({key:'held',kind:'model',root:'root',model:'m',localCapacity:8});
  const script='const {ResourceGovernor}=require(process.argv[1]);(async()=>{const g=new ResourceGovernor(()=>JSON.parse(process.argv[3]),process.argv[2]);const r=await g.tryAcquire({key:process.argv[4],kind:"model",root:process.argv[4],model:"m",localCapacity:8});process.stdout.write(JSON.stringify(r));await g.close();})().catch(e=>{console.error(e);process.exitCode=1;});';
  const results=await Promise.all(['second-store','third-worktree'].map(key=>promisify(execFile)(process.execPath,['-e',script,path.resolve('.test-build/resource-governor.js'),dir,JSON.stringify(config),key])));
  for(const result of results){assert.equal(JSON.parse(result.stdout).reason,'model_capacity');}
  assert.equal((await governor.status()).claims.length,1);await governor.release('held');
});

test('missing aggregate and board metadata fails closed beside immutable namespace markers', async t => {
  const f=await fixture(t);const ledger=path.join(f.options.resourceDirectory,'ledger.json'),saved=await fs.readFile(ledger);
  await fs.unlink(ledger);await assert.rejects(f.call('subagent_resource_status'),e=>e.code==='resource_corrupt');await fs.writeFile(ledger,saved);
  const file=path.join(f.local.store.directory,'task-board.json'),board=await fs.readFile(file);await f.broker.close();await fs.unlink(file);
  const broker=new WorkerBroker(f.options);await broker.start();
  const result=await broker.invoke(f.root,'subagent_team_list',{ownerId:'parent'});assert.equal(result.isError,true);assert.match(result.content[0].text,/board_malformed/);
  await broker.close();await fs.writeFile(file,board);
});

test('explicit message waits release capacity and a coordinator wake resumes only requested work', async t => {
  const f=await fixture(t), gate=deferred(), original=f.local.lifecycle.waitReady.bind(f.local.lifecycle);let first=true;
  f.local.lifecycle.waitReady=async(...args)=>{if(first){first=false;await gate.promise;}return original(...args);};
  const {worker}=await f.spawn('message');
  const waiting=await f.call('subagent_schedule',{ownerId:'parent',id:worker.id,wait:{kind:'message',key:'review-ready'},expectedWaitRevision:0});gate.resolve();
  assert.equal(waiting.scheduleWaitRevision,1);
  await until(()=>f.local.store.get(worker.id).waitingReason==='message');assert.equal(f.state.requests.length,0);
  assert.equal((await f.call('subagent_resource_status')).claims.length,0);
  await f.call('subagent_schedule',{ownerId:'parent',id:worker.id,wait:null,expectedWaitRevision:waiting.scheduleWaitRevision});await f.stopped(worker.id);assert.equal(f.state.requests.length,1);
});


test('an occupied service reservation does not starve older production work and runnable capacity is separate', async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'governance-lanes-')), config={...resourceDefaults,enabled:true,modelCapacity:2,runnableCapacity:2};
  const g=new ResourceGovernor(()=>config,dir);t.after(async()=>{await g.close();await fs.rm(dir,{recursive:true,force:true});});
  const req=(key,kind='model',lane='work')=>({key,kind,lane,root:key,model:'m',localCapacity:8});
  await g.tryAcquire(req('service','model','validation'));
  assert.equal((await g.tryAcquire(req('production'))).granted,true,'service occupancy already supplies the reserve');
  assert.equal((await g.tryAcquire(req('younger-service','model','integration'))).granted,false);
  await g.release('production');await g.release('service');await g.release('younger-service');
  await g.tryAcquire(req('tool','tool'));
  assert.equal((await g.tryAcquire(req('model-after-tool'))).reason,'runnable_capacity');
  await g.release('model-after-tool');await g.release('tool');
});

test('disabled governed startup creates no resource namespace and legacy spawn still runs', async t=>{
  const f=await fixture(t);const resourceDirectory=path.join(f.dir,'disabled-resource');
  const broker=new WorkerBroker({...f.options,storage:path.join(f.dir,'disabled-store'),registry:path.join(f.dir,'disabled-registry'),resourceDirectory,resources:()=>({...resourceDefaults,enabled:false})});
  await broker.start();
  try {
    const result=await broker.invoke(f.root,'subagent_isolated_spawn',{});assert.equal(result.isError,true);assert.match(result.content[0].text,/feature_disabled/);
    const worker=unpack(await broker.invoke(f.root,'subagent_spawn',{ownerId:'legacy',requestId:'legacy',task:'legacy',model:model.id}));
    await until(()=>broker.local.get(f.root).store.get(worker.id).state==='completed');
  }finally{await broker.close();}
  assert.equal(await fs.stat(resourceDirectory).then(()=>true,()=>false),false);
});


test('receipt replays need no new storage allowance and fresh capture still obeys the budget',async t=>{
  const f=await fixture(t);f.state.config={...f.state.config,storageBytes:64*1024**2};
  assert.equal((await f.call('subagent_snapshot_create',{ownerId:'parent',teamId:f.team.id,requestId:'snapshot'})).id,f.snapshot.id);
  assert.equal((await f.call('subagent_team_create',{ownerId:'parent',requestId:'team',name:'team',description:''})).id,f.team.id);
  await assert.rejects(f.call('subagent_snapshot_create',{ownerId:'parent',teamId:f.team.id,requestId:'new-capture'}),e=>e.code==='storage_exhausted');
  assert.equal((await (await f.local.isolation.open()).inspect('parent',f.team.id)).snapshots.length,1);
});

test('governed history compaction remains available after task cancellation and write-policy revocation',async t=>{
  const f=await fixture(t),{worker,task}=await f.spawn('history');await f.stopped(worker.id);
  const current=await f.call('subagent_task_get',{ownerId:'parent',id:task.id});await f.call('subagent_task_update',{ownerId:'parent',requestId:'stop-history',taskId:task.id,expectedRevision:current.revision,state:'cancelled'});
  f.state.models[model.id]={numSessions:4,allowWrite:false};
  const before=await f.broker.session(f.root,worker.id);
  await f.call('subagent_compact',{ownerId:'parent',id:worker.id,revision:before.revision});
  const compacted=await f.stopped(worker.id);assert.equal(compacted.maintenanceError,undefined);assert.equal(compacted.archives.length,1);
  assert.equal(f.state.requests.length,2);assert.equal(compacted.schema,3);
});


function pauseCreation(f){
  const original=f.local.lifecycle.withStorage.bind(f.local.lifecycle),entered=deferred(),gate=deferred();let first=true;
  f.local.lifecycle.withStorage=async(bytes,action,signal,lane)=>{
    if(first&&bytes===2*1024**2&&lane==='work'){first=false;entered.resolve();await Promise.race([gate.promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);}
    return original(bytes,action,signal,lane);
  };
  return {entered,gate};
}

test('parent stop retires a pending request before worker creation and transport retry cannot start it',async t=>{
  const f=await fixture(t),input=await prepared(f,'parent-before-create'),pause=pauseCreation(f);
  const starting=f.call('subagent_isolated_spawn',input),rejected=assert.rejects(starting,e=>e.code==='cancelled');await pause.entered.promise;
  await f.call('subagent_parent',{ownerId:'parent',action:'stop'});await rejected;
  assert.equal(f.local.store.list().length,0);assert.equal(f.state.requests.length,0);
  pause.gate.resolve();await assert.rejects(f.call('subagent_isolated_spawn',input),e=>e.code==='request_expired');
});

test('heartbeats renew pre-creation setup leases and expiry leaves a durable retired request',async t=>{
  const f=await fixture(t),input={...await prepared(f,'lease-before-create'),parentPolicy:'cancel-on-expiry',leaseSeconds:30},pause=pauseCreation(f);
  const starting=f.call('subagent_isolated_spawn',input),rejected=assert.rejects(starting,e=>e.code==='parent_expired');await pause.entered.promise;
  await f.call('subagent_parent',{ownerId:'parent',action:'heartbeat',leaseSeconds:180});
  const entry=[...f.local.lifecycle.preparations.values()][0];assert.ok(entry.expiresAt>Date.now()+170000);entry.expiresAt=1;
  await f.local.lifecycle.expirePreparing();await rejected;assert.equal(f.local.store.list().length,0);
  pause.gate.resolve();await assert.rejects(f.call('subagent_isolated_spawn',input),e=>e.code==='request_expired');assert.equal(f.state.requests.length,0);
});

test('a startup retired before its cancel checkpoint fences every retry without inference or view effects', async t => {
  for (const mode of ['same-host', 'reload']) {
    await t.test(mode, async t => {
      const f = await fixture(t), input = await prepared(f, 'retire-checkpoint'), local = f.local;
      const original = local.isolation.invoke.bind(local.isolation), cancel = local.engine.cancel.bind(local.engine);
      const gate = deferred(), entered = deferred();
      let binds = 0, starting, rejected;
      // Release the blocked binding and restore the injection even if an
      // assertion or control call below fails, so this test cannot stall a seat.
      try {
        local.isolation.invoke = async (...args) => {
          if (args[0] === 'subagent_view_bind') { binds++; entered.resolve(); await gate.promise; }
          return original(...args);
        };
        // The stop is durable while its cancel phase checkpoint never commits.
        local.engine.cancel = async () => { throw Error('lost cancellation checkpoint'); };
        starting = f.call('subagent_isolated_spawn', input); rejected = assert.rejects(starting, /lost cancellation checkpoint/);
        await entered.promise;
        const worker = local.store.all()[0];
        // The stop publishes the tombstone, then fails its own cancel phase.
        await assert.rejects(f.call('subagent_parent', { ownerId: 'parent', action: 'stop' }), e => e.message === 'lost cancellation checkpoint');
        gate.resolve(); await rejected;
        const stranded = local.store.get(worker.id);
        assert.equal(stranded.startup.phase, 'assigned'); assert.equal(stranded.state, 'interrupted', 'no cancel phase was recorded');
        assert.equal(f.state.requests.length, 0);
        await fs.lstat(path.join(local.store.directory, 'retired-workers', worker.id + '.json'));
        let replayBinds = 0;
        if (mode === 'reload') {
          await f.reload();
          const isolation = f.local.isolation, invoke = isolation.invoke.bind(isolation);
          isolation.invoke = async (...args) => { if (args[0] === 'subagent_view_bind') { replayBinds++; } return invoke(...args); };
        }
        await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'request_expired');
        assert.equal(binds, 1, 'only the interrupted attempt reached the view tool');
        assert.equal(replayBinds, 0, 'the retry performs no view effect');
        assert.equal(f.state.requests.length, 0, 'the retry performs no inference');
        assert.equal(f.local.store.get(worker.id).startup.phase, 'assigned', 'the retry advances no incomplete phase');
      } finally {
        gate.resolve(); local.isolation.invoke = original; local.engine.cancel = cancel;
        await Promise.allSettled([starting, rejected]);
      }
    });
  }
});

test('a tombstoned started worker cannot hand off, resume or be rescheduled into inference', async t => {
  const f = await fixture(t), input = await prepared(f, 'handoff-retired');
  const original = f.local.store.onCheckpoint, controller = new AbortController(); let injected = false;
  f.local.store.onCheckpoint = async session => {
    await original(session);
    if (session.startup?.phase === 'started' && !injected) { injected = true; controller.abort(Error('transport lost after the start checkpoint')); }
  };
  const first = await f.broker.invoke(f.root, 'subagent_isolated_spawn', input, controller.signal);
  assert.equal(first.isError, true); f.local.store.onCheckpoint = original;
  const queued = f.local.store.all()[0];
  assert.equal(queued.startup.phase, 'started'); assert.equal(queued.state, 'queued');
  assert.equal(f.local.engine.active.has(queued.id), false); assert.equal(f.state.requests.length, 0);
  // The owner stop lands between the durable start decision and its handoff.
  await f.local.store.retireStartup(queued.ownerId, queued.startup.requestId, queued.workspaceRoot);
  await fs.lstat(path.join(f.local.store.directory, 'retired-workers', queued.id + '.json'));
  // The retry, the handoff, a direct resume and an unrelated reschedule all
  // reach inference through the execution authorizer: none of them may start it.
  await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'request_expired');
  const started = f.local.store.get(queued.id);
  assert.equal(started.startup.phase, 'started', 'the start decision is untouched');
  assert.throws(() => f.local.lifecycle.authorize(started), e => e.code === 'request_expired');
  await assert.rejects(f.local.lifecycle.waitReady(started, new AbortController().signal), e => e.code === 'request_expired');
  assert.equal(f.state.requests.length, 0, 'a tombstoned start performs no inference');
  // Ordinary legacy spawn stays independent of a governed tombstone.
  const legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'ordinary-legacy-after-fence', task: 'legacy', model: model.id });
  assert.equal((await f.stopped(legacy.id)).state, 'completed');
  assert.equal(f.state.requests.length, 1);
});

test('a production startup waiting for storage does not hold a root mutex needed by validation',async t=>{
  const f=await fixture(t),work=await prepared(f,'waiting-production'),pause=pauseCreation(f);
  const starting=f.call('subagent_isolated_spawn',work),rejected=assert.rejects(starting,e=>e.code==='revision_conflict');await pause.entered.promise;
  const validation=await f.spawn('independent-validation',{lane:'validation'});await f.stopped(validation.worker.id);assert.equal(f.state.requests.length,1);
  pause.gate.resolve();await rejected;assert.equal(f.state.requests.length,1);
});

function intentPath(f) { return path.join(f.local.store.directory, 'pending-startups.json'); }
async function readIntents(f) {
  const text = await fs.readFile(intentPath(f), 'utf8').catch(error => { if (error.code === 'ENOENT') { return undefined; } throw error; });
  return text === undefined ? [] : JSON.parse(text).requests;
}
async function expirePersistedIntent(f) {
  const requests = await readIntents(f);
  assert.equal(requests.length, 1);
  requests[0].expiresAt = Date.now() - 1000;
  await fs.writeFile(intentPath(f), JSON.stringify({ schema: 1, requests }));
  return requests[0];
}
function intentIdentity(ownerId, requestId, root) {
  const { digest } = require('../.test-build/storage');
  return digest([digest([ownerId, requestId]), root]).slice(0, 32);
}
async function abortPausedSpawn(f, input, pause) {
  const controller = new AbortController();
  const starting = f.broker.invoke(f.root, 'subagent_isolated_spawn', input, controller.signal);
  try {
    await pause.entered.promise; controller.abort();
    assert.equal((await starting).isError, true, 'the transport abort ends the pre-creation admission');
  } finally { pause.gate.resolve(); }
}

test('an aborted pre-creation admission keeps its accepted lease across reload instead of a fresh one', async t => {
  const f = await fixture(t), input = { ...await prepared(f, 'lease-across-reload'), parentPolicy: 'cancel-on-expiry', leaseSeconds: 30 };
  const pause = pauseCreation(f);
  await abortPausedSpawn(f, input, pause);
  // Only an intent exists: the request was accepted, never created.
  const [accepted] = await readIntents(f);
  assert.equal((await readIntents(f)).length, 1);
  assert.equal(accepted.ownerId, 'parent'); assert.equal(accepted.requestId, input.requestId);
  assert.equal(accepted.policy, 'cancel-on-expiry'); assert.equal(accepted.leaseSeconds, 30);
  assert.ok(accepted.expiresAt > Date.now() + 20_000, 'the original deadline was persisted before the wait');
  assert.ok((await fs.stat(intentPath(f))).size < 64 * 1024, 'pending metadata stays bounded');
  assert.equal(f.local.store.list().length, 0);
  assert.equal(f.state.requests.length, 0);
  await f.reload();
  // The retry resumes the SAME lease and hands the identity to its checkpoint.
  const replay = pauseCreation(f), retried = f.call('subagent_isolated_spawn', input);
  try {
    await replay.entered.promise;
    const preparing = [...f.local.lifecycle.preparations.values()][0];
    assert.equal(preparing.expiresAt, accepted.expiresAt, 'a reload must not grant a fresh lease');
    assert.equal(preparing.leaseSeconds, 30);
    replay.gate.resolve();
    const worker = await retried, settled = await f.stopped(worker.id);
    assert.equal(settled.state, 'completed');
    assert.equal(settled.parentExpiresAt, accepted.expiresAt);
    assert.equal(f.state.requests.length, 1);
    assert.deepEqual(await readIntents(f), [], 'the checkpoint adopted the intent');
  } finally { replay.gate.resolve(); await retried.catch(() => {}); }
});

test('a persisted pre-creation deadline expires across reload and fences retries and legacy spawns', async t => {
  for (const mode of ['retry', 'sweep']) {
    await t.test(mode, async t => {
      const f = await fixture(t), input = { ...await prepared(f, 'expired-' + mode), parentPolicy: 'cancel-on-expiry', leaseSeconds: 30 };
      const pause = pauseCreation(f);
      await abortPausedSpawn(f, input, pause);
      // The host is down while the request is only an accepted intent, and its
      // original 30 s deadline passes without a heartbeat.
      const accepted = await expirePersistedIntent(f);
      await f.reload();
      // Stop the host lease timer so only this test decides when expiry runs.
      clearInterval(f.broker.leaseTimer);
      if (mode === 'sweep') { await f.local.lifecycle.expirePreparing(); }
      await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === (mode === 'sweep' ? 'request_expired' : 'parent_expired'));
      assert.equal(f.state.requests.length, 0, 'an expired request never runs inference');
      assert.equal(f.local.store.list().length, 0);
      await fs.lstat(path.join(f.local.store.directory, 'retired-workers', intentIdentity('parent', input.requestId, f.root) + '.json'));
      assert.deepEqual(await readIntents(f), [], 'the expired intent leaves the bounded set');
      const legacy = { ...input }; delete legacy.setup;
      await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === 'request_expired');
      assert.equal(f.state.requests.length, 0);
      assert.ok(accepted.expiresAt < Date.now());
      await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'request_expired');
    });
  }
});

test('heartbeat and stop reach pre-creation intents persisted by a previous host', async t => {
  for (const action of ['heartbeat', 'stop']) {
    await t.test(action, async t => {
      const f = await fixture(t), input = { ...await prepared(f, action + '-across-reload'), parentPolicy: 'cancel-on-expiry', leaseSeconds: 30 };
      const pause = pauseCreation(f);
      await abortPausedSpawn(f, input, pause);
      await f.reload(); clearInterval(f.broker.leaseTimer);
      assert.equal((await readIntents(f)).length, 1, 'no in-memory preparation exists after the reload');
      await f.call('subagent_parent', { ownerId: 'parent', action, leaseSeconds: 180 });
      if (action === 'heartbeat') {
        const [renewed] = await readIntents(f);
        assert.equal(renewed.leaseSeconds, 180);
        assert.ok(renewed.expiresAt > Date.now() + 170_000, 'the explicit heartbeat renews the persisted lease');
        const worker = await f.call('subagent_isolated_spawn', input), settled = await f.stopped(worker.id);
        assert.equal(settled.state, 'completed');
        assert.ok(settled.parentExpiresAt > Date.now() + 170_000);
        assert.equal(settled.parentLeaseSeconds, 180);
        assert.equal(f.state.requests.length, 1);
        assert.deepEqual(await readIntents(f), []);
      } else {
        assert.deepEqual(await readIntents(f), [], 'the stop retires the persisted request');
        await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'request_expired');
        const legacy = { ...input }; delete legacy.setup;
        await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === 'request_expired');
        assert.equal(f.state.requests.length, 0);
      }
    });
  }
});

test('a changed pre-creation retry conflicts with the persisted identity instead of starting new work', async t => {
  const f = await fixture(t), input = await prepared(f, 'changed-args');
  await abortPausedSpawn(f, input, pauseCreation(f));
  await f.reload();
  const [accepted] = await readIntents(f);
  assert.equal(accepted.policy, 'keep');
  assert.equal(accepted.expiresAt, undefined);
  await assert.rejects(f.call('subagent_isolated_spawn', { ...input, task: 'a different task' }), e => e.code === 'idempotency_conflict');
  assert.equal(f.state.requests.length, 0);
  assert.equal((await readIntents(f)).length, 1, 'changed arguments never replace the accepted intent');
  const worker = await f.call('subagent_isolated_spawn', input);
  assert.equal((await f.stopped(worker.id)).state, 'completed');
  assert.equal(f.state.requests.length, 1);
  assert.deepEqual(await readIntents(f), []);
});

test('a pending governed intent keeps a same-host legacy spawn off its identity', async t => {
  const f = await fixture(t), input = await prepared(f, 'pending-identity'), pause = pauseCreation(f);
  const starting = f.call('subagent_isolated_spawn', input);
  try {
    await pause.entered.promise;
    assert.equal(f.local.store.list().length, 0);
    const legacy = { ...input }; delete legacy.setup;
    await assert.rejects(f.call('subagent_spawn', legacy), e => e.code === 'request_expired');
    assert.equal(f.local.store.list().length, 0, 'a legacy spawn cannot take the pending identity');
    assert.equal(f.state.requests.length, 0);
    // Unrelated legacy work keeps its ordinary semantics.
    const unrelated = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'unrelated-legacy', task: 'legacy', model: model.id });
    assert.equal((await f.stopped(unrelated.id)).state, 'completed');
    assert.equal(f.state.requests.length, 1);
    pause.gate.resolve();
    const worker = await starting;
    assert.equal((await f.stopped(worker.id)).state, 'completed');
    assert.equal(f.state.requests.length, 2);
    assert.equal((await f.local.store.all()).filter(session => session.id === worker.id).length, 1);
  } finally { pause.gate.resolve(); await starting.catch(() => {}); }
});

test('the durable intent ledger reserves service entries and never ages out a kept request', async t => {
  const f = await fixture(t), now = Date.now();
  const parked = (n, lane) => ({ ownerId: 'parent', requestId: 'parked-' + n, workspaceRoot: f.root, fingerprint: 'b'.repeat(64),
    policy: 'keep', lane, leaseSeconds: 120, at: now - 60 * 60_000 });
  await fs.writeFile(intentPath(f), JSON.stringify({ schema: 1, requests: Array.from({ length: 60 }, (_, n) => parked(n, 'work')) }));
  await f.reload(); clearInterval(f.broker.leaseTimer);
  assert.equal((await readIntents(f)).length, 60);
  // An hour-old kept request is never reclaimed by age: only a parent stop or
  // its own checkpoint frees the identity, so pressure cannot abandon work.
  await assert.rejects(f.call('subagent_isolated_spawn', await prepared(f, 'reserve-work')), e => e.code === 'resource_queue_full');
  // Rollover must not compact an identity a persisted request still holds.
  await assert.rejects(f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 0 }), e => e.code === 'worker_busy');
  assert.equal((await readIntents(f)).length, 60);
  // Four of the 64 durable entries stay reachable for service lanes.
  const service = await f.call('subagent_isolated_spawn', await prepared(f, 'reserve-service', 'validation'));
  assert.equal((await f.stopped(service.id)).state, 'completed');
  assert.equal(f.state.requests.length, 1);
  assert.equal((await readIntents(f)).length, 60, 'the service request consumed only its own intent');
  // Normal parent stop is the explicit way to free a kept request.
  await f.call('subagent_parent', { ownerId: 'parent', action: 'stop' });
  assert.deepEqual(await readIntents(f), []);
  const freed = await f.call('subagent_isolated_spawn', await prepared(f, 'reserve-after-stop'));
  assert.equal((await f.stopped(freed.id)).state, 'completed');
  assert.equal(f.state.requests.length, 2);
});

/** Publishes the intent, then holds the store mutex across the reply. */
function pauseIntentPublish(f) {
  const store = f.local.store, original = store.publishStartupIntents.bind(store);
  const entered = deferred(), gate = deferred(); let first = true;
  store.publishStartupIntents = async draft => {
    await original(draft);
    if (first && draft.size) { first = false; entered.resolve(); await gate.promise; }
  };
  return { entered, gate, restore: () => { delete store.publishStartupIntents; } };
}

test('a heartbeat interleaved with the in-flight intent publish keeps the newest lease', async t => {
  for (const mode of ['extend', 'shorten', 'duplicate']) {
    await t.test(mode, async t => {
      const leaseSeconds = mode === 'shorten' ? 600 : 30, heartbeat = mode === 'shorten' ? 30 : 180;
      const f = await fixture(t), input = { ...await prepared(f, 'inflight-' + mode), parentPolicy: 'cancel-on-expiry', leaseSeconds };
      const publish = pauseIntentPublish(f), pause = pauseCreation(f), started = [];
      try {
        // The durable registration is written, but its reply is still in flight.
        started.push(f.call('subagent_isolated_spawn', input));
        if (mode === 'duplicate') { started.push(f.call('subagent_isolated_spawn', input)); }
        await publish.entered.promise;
        const [accepted] = await readIntents(f);
        assert.equal(accepted.leaseSeconds, leaseSeconds);
        assert.ok(accepted.expiresAt > Date.now() + leaseSeconds * 1000 - 5000, 'the original deadline is durable before the heartbeat');
        assert.equal(f.local.store.list().length, 0, 'no checkpoint exists yet');
        // An explicit renewal lands while that record is still being written.
        const renewed = f.call('subagent_parent', { ownerId: 'parent', action: 'heartbeat', leaseSeconds: heartbeat });
        const entry = [...f.local.lifecycle.preparations.values()][0];
        await until(() => entry.heartbeats === 1);
        const expected = Date.now() + heartbeat * 1000;
        assert.equal(entry.leaseSeconds, heartbeat, 'the explicit renewal owns the in-memory lease');
        if (mode === 'shorten') {
          assert.ok(entry.expiresAt < expected + 2000, 'the in-memory deadline is the renewed one');
          assert.ok(entry.expiresAt < accepted.expiresAt - 60_000, 'an explicit short renewal is never widened to the older deadline');
        } else {
          assert.ok(entry.expiresAt > expected - 5000, 'the in-memory deadline is extended');
        }
        const renewedExpiry = entry.expiresAt;
        publish.gate.resolve(); await renewed;
        await pause.entered.promise;
        // The reply carrying the pre-heartbeat deadline must not restore it,
        // and the durable record follows the same newest value.
        assert.equal(entry.expiresAt, renewedExpiry, 'the in-flight registration reply does not undo the heartbeat');
        assert.equal(entry.leaseSeconds, heartbeat);
        const [durable] = await readIntents(f);
        assert.equal(durable.leaseSeconds, heartbeat);
        assert.ok(durable.expiresAt > renewedExpiry - 5000 && durable.expiresAt < renewedExpiry + 5000, 'the durable record holds the renewed deadline');
        pause.gate.resolve();
        const workers = await Promise.all(started);
        assert.equal(new Set(workers.map(worker => worker.id)).size, 1, 'concurrent callers share one identity');
        const settled = await f.stopped(workers[0].id);
        assert.equal(settled.state, 'completed');
        assert.equal(settled.parentLeaseSeconds, heartbeat);
        assert.equal(settled.parentExpiresAt, renewedExpiry, 'the checkpoint adopts the renewed lease');
        assert.equal(f.state.requests.length, 1);
        assert.deepEqual(await readIntents(f), [], 'the checkpoint consumed the intent');
      } finally {
        publish.gate.resolve(); pause.gate.resolve(); publish.restore();
        await Promise.allSettled(started);
      }
    });
  }
});

test('previous-epoch startup IDs are rejected before a durable intent and never block capacity or maintenance', async t => {
  const f = await fixture(t);
  // Three distinct stale identities: two unprefixed ones from the initial
  // namespace and one bound to an epoch that never became current.
  const stale = await prepared(f, 'epoch-old');
  const second = await prepared(f, 'epoch-old-two');
  const future = { ...await prepared(f, 'epoch-future'), requestId: 'e2:epoch-future' };
  assert.equal((await f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 0 })).epoch, 1);
  for (const input of [stale, second, future]) {
    await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'request_expired');
    assert.equal(f.local.store.list().length, 0, 'a rejected identity creates no checkpoint');
    assert.deepEqual(await readIntents(f), [], 'a rejected identity spends no durable intent slot');
  }
  assert.equal(f.state.requests.length, 0);
  await f.reload();
  // Refusing the same identity again after a reload writes nothing durable and
  // therefore cannot hold metadata maintenance closed.
  await assert.rejects(f.call('subagent_isolated_spawn', stale), e => e.code === 'request_expired');
  assert.deepEqual(await readIntents(f), []);
  const fresh = async suffix => {
    const team = await f.call('subagent_team_get', { ownerId: 'parent', id: f.team.id });
    const task = await f.call('subagent_task_create', { ownerId: 'parent', requestId: suffix + ':task', teamId: team.id, title: suffix, description: '' });
    const worker = await f.call('subagent_isolated_spawn', { ownerId: 'parent', requestId: suffix + ':worker', task: suffix, model: model.id, permission: 'workspace-write',
      setup: { teamId: team.id, taskId: task.id, snapshotId: f.snapshot.id, teamRevision: team.revision, taskRevision: task.revision, lane: 'work' } });
    assert.equal((await f.stopped(worker.id)).state, 'completed');
    assert.deepEqual(await readIntents(f), [], 'a current-epoch request consumes only its own intent');
    return worker;
  };
  await fresh('e1');
  // Maintenance is not blocked by refused identities: the epoch advances and
  // fresh capacity is still available in the new namespace.
  assert.equal((await f.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: f.team.id, kind: 'board', expectedEpoch: 1 })).epoch, 2);
  await fresh('e2');
  assert.equal(f.state.requests.length, 2);
});

test('a refused startup retires the exact stranded intent of an earlier attempt through the retirement fence', async t => {
  const f = await fixture(t), input = await prepared(f, 'stranded-refusal');
  const { WorkerError } = require('../.test-build/types');
  const spawn = f.local.engine.spawn.bind(f.local.engine), preflight = f.local.isolation.preflightStartupBind.bind(f.local.isolation);
  // An earlier attempt wrote the durable intent and then failed before any
  // checkpoint existed - exactly the state the reviewed defect left behind for a
  // work-lane startup its own bind preflight refused.
  f.local.engine.spawn = async () => { throw Error('lost create'); };
  await assert.rejects(f.call('subagent_isolated_spawn', input), /lost create/);
  f.local.engine.spawn = spawn;
  const [stranded] = await readIntents(f);
  assert.equal(stranded.requestId, input.requestId);
  assert.equal(stranded.ownerId, 'parent');
  assert.equal(stranded.policy, 'keep');
  assert.equal(stranded.expiresAt, undefined, 'a kept intent carries no deadline that could ever age it out');
  assert.equal(f.local.store.list().length, 0, 'no checkpoint owns the identity yet');
  // The narrow bind rule refuses this snapshot with the preflight's own error.
  f.local.isolation.preflightStartupBind = async () => {
    throw new WorkerError('isolation_conflict', 'This snapshot is a derived integration seed with unresolved merge conflict groups; only its governed integration-lane startup may bind it.');
  };
  try {
    // Changed arguments keep the ordinary idempotency answer and never retire
    // the accepted record.
    await assert.rejects(f.call('subagent_isolated_spawn', { ...input, task: input.task + ' changed' }), e => e.code === 'idempotency_conflict');
    assert.equal((await readIntents(f)).length, 1, 'changed arguments never retire the accepted intent');
    // The exact retry is refused by the same rule and retires ONLY that record,
    // through the ordinary retirement fence: the identity this host already
    // accepted is never recycled for a different later request.
    await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'isolation_conflict');
    assert.deepEqual(await readIntents(f), [], 'the exact retry leaves no pending intent behind');
    const tombstone = path.join(f.local.store.directory, 'retired-workers', intentIdentity('parent', input.requestId, f.root) + '.json');
    assert.equal((await fs.readFile(tombstone, 'utf8')).includes(input.requestId), true, 'the retired identity keeps its normal tombstone');
    assert.equal(f.local.store.list().length, 0);
    assert.equal(f.state.requests.length, 0);
  } finally { f.local.isolation.preflightStartupBind = preflight; }
  // That identity is retired now, so neither an exact retry nor changed
  // arguments may reuse it.
  await assert.rejects(f.call('subagent_isolated_spawn', input), e => e.code === 'request_expired');
  await assert.rejects(f.call('subagent_isolated_spawn', { ...input, task: input.task + ' changed' }), e => e.code === 'request_expired');
  assert.deepEqual(await readIntents(f), [], 'a retired identity spends no pending slot');
  assert.equal(f.state.requests.length, 0);
  // The refusal never held its owner's metadata maintenance closed...
  const collected = await f.call('subagent_resource_collect', { ownerId: 'parent', teamId: f.team.id });
  assert.deepEqual(collected.results.removed, []);
  // ...and a NEW request starts normally.
  const fresh = await f.call('subagent_isolated_spawn', await prepared(f, 'stranded-fresh'));
  assert.equal((await f.stopped(fresh.id)).state, 'completed');
  assert.deepEqual(await readIntents(f), [], 'the checkpoint consumed the fresh intent');
  assert.equal(f.state.requests.length, 1);
});

test('a heartbeat before the first durable intent renews its lease pair and the checkpoint', async t => {
  const leaseSeconds = 120, heartbeat = 300;
  const f = await fixture(t), input = { ...await prepared(f, 'early-heartbeat'), parentPolicy: 'cancel-on-expiry', leaseSeconds };
  const lifecycle = f.local.lifecycle, board = lifecycle.board, original = board.open;
  const opened = deferred(), release = deferred(), pause = pauseCreation(f);
  let first = true, starting;
  // The epoch check opens the board BEFORE the first intent exists, so a
  // heartbeat here has no persisted record to renew yet.
  board.open = async () => {
    if (first) { first = false; opened.resolve(); await release.promise; }
    return original.call(board);
  };
  try {
    starting = f.call('subagent_isolated_spawn', input);
    await opened.promise;
    assert.deepEqual(await readIntents(f), [], 'the heartbeat lands before any durable intent exists');
    assert.equal(f.local.store.list().length, 0);
    await f.call('subagent_parent', { ownerId: 'parent', action: 'heartbeat', leaseSeconds: heartbeat });
    const entry = [...lifecycle.preparations.values()][0];
    assert.equal(entry.leaseSeconds, heartbeat, 'the in-memory lease is the renewal');
    const renewed = entry.expiresAt;
    assert.ok(renewed > Date.now() + heartbeat * 1000 - 5000);
    assert.ok(renewed > Date.now() + leaseSeconds * 1000, 'a renewal, not the original lease');
    release.resolve();
    // The intent is published before create(); hold the create admission so the
    // durable pair can be read exactly as it was written.
    await pause.entered.promise;
    const [durable] = await readIntents(f);
    assert.equal(durable.leaseSeconds, heartbeat, 'the first intent carries the renewed lease');
    assert.equal(durable.expiresAt, renewed, 'the first intent carries the renewed deadline, as one pair');
    assert.equal(durable.policy, 'cancel-on-expiry');
    pause.gate.resolve();
    const worker = await starting, settled = await f.stopped(worker.id);
    assert.equal(settled.state, 'completed');
    assert.equal(settled.parentLeaseSeconds, heartbeat, 'the checkpoint keeps the renewed lease');
    assert.equal(settled.parentExpiresAt, renewed, 'the checkpoint keeps the renewed deadline');
    assert.equal(f.state.requests.length, 1);
    assert.deepEqual(await readIntents(f), [], 'the checkpoint consumed the intent');
  } finally {
    release.resolve(); pause.gate.resolve(); board.open = original;
    await Promise.allSettled([starting]);
  }
});

/** A host whose store never opted in: no local registration and no aggregate state. */
async function optedOut(t, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opted-out-maintenance-'));
  const root = path.join(dir, 'project'); await fs.mkdir(root);
  const state = { requests: [], models: { [model.id]: { numSessions: 4 } } };
  const provider = { models: async () => [model], countTokens: async () => 10,
    async *stream() {
      state.requests.push(1); yield { type: 'text', text: 'done' };
    } };
  const resourceDirectory = path.join(dir, 'resources'), config = { ...resourceDefaults, enabled: false };
  if (opts.corruptLedger) {
    // An unrelated host's aggregate namespace whose ledger cannot be parsed:
    // touching it from this opted-out store must fail closed, so a regression
    // that silently enrolls this window is visible instead of harmless.
    await fs.mkdir(resourceDirectory, { recursive: true });
    await fs.writeFile(path.join(resourceDirectory, 'namespace.json'), JSON.stringify({ schema: 1, kind: 'os-user-resources' }));
    await fs.writeFile(path.join(resourceDirectory, 'ledger.json'), '{"schema":1');
  }
  const options = { storage: path.join(dir, 'storage'), registry: path.join(dir, 'bridges'), roots: [root], identity: 'test', provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: state.models }),
    taskBoardEnabled: () => true, isolatedViewsEnabled: () => true,
    resources: () => config, resourceDirectory,
    files: { canWrite: () => true, allowShell: () => true, approveCommand: async () => true }, onChange: () => {},
    onError: message => { state.errors ??= []; state.errors.push(message); } };
  const broker = new WorkerBroker(options); await broker.start();
  t.after(async () => { await broker.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const local = broker.local.get(root), directory = local.store.directory;
  return { dir, root, state, config, broker, local, directory, resourceDirectory,
    call: async (name, args = {}) => unpack(await broker.invoke(root, name, args)),
    registered: () => fs.lstat(path.join(directory, 'resource-store.json')).then(() => true, () => false),
    aggregate: () => fs.lstat(path.join(resourceDirectory, 'ledger.json')).then(() => true, () => false),
    charged: async () => Object.values((await broker.resources.status()).stores).find(entry => entry.directory === directory)?.bytes
  };
}

test('refused metadata maintenance leaves a fresh opted-out store unregistered and legacy work independent', async t => {
  const host = await optedOut(t);
  assert.equal(await host.registered(), false, 'the fixture store starts opted out');
  assert.equal(await host.aggregate(), false);
  const other = await host.call('subagent_team_create', { ownerId: 'other', requestId: 'other-team', name: 'other', description: '' });
  const resources = host.broker.resources, hasState = resources.hasState.bind(resources);
  let aggregateReads = 0;
  // Every aggregate write asks this namespace for state first: fail loudly so an
  // accidental enrollment of an opted-out store cannot pass silently.
  resources.hasState = async () => {
    aggregateReads++; throw Error('aggregate namespace consulted');
  };
  try {
    // Invalid request shapes are refused during parsing, before any effect.
    await assert.rejects(host.call('subagent_metadata_rollover', { ownerId: 'parent', kind: 'board', expectedEpoch: 0 }), e => e.code === 'invalid_arguments');
    await assert.rejects(host.call('subagent_evidence_retention', { ownerId: 'parent', teamId: other.id, action: 'keep', name: 'pin', uri: 'manual:evidence' }), e => e.code === 'invalid_arguments');
    // A valid shape aimed at another coordinator's team fails authorization.
    await assert.rejects(host.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: other.id, kind: 'board', expectedEpoch: 0 }), e => e.code === 'forbidden');
    await assert.rejects(host.call('subagent_resource_collect', { ownerId: 'parent', teamId: other.id }), e => e.code === 'forbidden');
  } finally { resources.hasState = hasState; }
  assert.equal(aggregateReads, 0, 'preflight never consults the aggregate namespace');
  assert.equal(await host.registered(), false, 'a refused request creates no local registration');
  assert.equal(await host.aggregate(), false, 'a refused request creates no aggregate state');
  // Legacy work keeps its ordinary semantics and stays independent of the ledger.
  const worker = await host.call('subagent_spawn', { ownerId: 'legacy', requestId: 'legacy', task: 'legacy', model: model.id });
  await until(() => host.local.store.get(worker.id).state === 'completed', 8000);
  assert.equal(host.state.requests.length, 1);
  assert.equal(await host.registered(), false);
  assert.equal(await host.aggregate(), false);
});

test('valid rollover and evidence pin still register an opted-out store and reconcile after a post-commit failure', async t => {
  const { storageUsage } = require('../.test-build/resource-governor');
  const first = await optedOut(t);
  const team = await first.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  assert.equal(await first.registered(), false);
  assert.equal((await first.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 0 })).epoch, 1);
  assert.equal(await first.registered(), true, 'a validated rollover keeps its intentional first registration before its write fence');
  assert.equal(await first.charged(), await storageUsage(first.directory));
  // A failure AFTER the durable rollover still reconciles the store it registered.
  const board = await first.local.board.open(), rollover = board.rolloverReceipts.bind(board);
  board.rolloverReceipts = async (...args) => {
    await rollover(...args); throw Error('lost rollover acknowledgement');
  };
  try { await assert.rejects(first.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 1 }), /lost rollover acknowledgement/); }
  finally { board.rolloverReceipts = rollover; }
  assert.equal(await first.charged(), await storageUsage(first.directory), 'final accounting still runs after a post-commit failure');
  // The evidence pin's own storage admission performs the first registration: the
  // team was created while the store was opted out, so nothing is registered yet.
  const second = await optedOut(t);
  const pinTeam = await second.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  assert.equal(await second.registered(), false);
  second.config.enabled = true;
  await second.call('subagent_evidence_retention', { ownerId: 'parent', teamId: pinTeam.id, action: 'pin', name: 'consumer', uri: 'manual:evidence' });
  assert.equal(await second.registered(), true, 'pin admission registers its store rather than depending on the ledger');
  assert.equal(await second.charged(), await storageUsage(second.directory));
});

test('optoutpin: a fresh evidence pin refused by live opt-out enrolls nothing and creates no evidence namespace', async t => {
  const host = await optedOut(t);
  const team = await host.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  assert.equal(await host.registered(), false, 'the fixture store starts opted out');
  assert.equal(await host.aggregate(), false);
  // The request is valid and authorized; only the trusted live opt-out refuses it.
  await assert.rejects(host.call('subagent_evidence_retention', { ownerId: 'parent', teamId: team.id, action: 'pin', name: 'consumer', uri: 'manual:evidence' }),
    e => e.code === 'feature_disabled');
  assert.equal(await host.registered(), false, 'a refused fresh pin creates no local registration');
  assert.equal(await host.aggregate(), false, 'a refused fresh pin creates no aggregate ledger');
  // Its first write would bootstrap a brand-new ledger, so the refusal happens
  // before that too: an unused store keeps no evidence namespace at all.
  for (const file of ['evidence-retention.json', 'evidence-retention.namespace.json']) {
    await assert.rejects(fs.lstat(path.join(host.directory, file)), e => e.code === 'ENOENT');
  }
  assert.equal(host.broker.resourceUsed, false, 'a refused pin is not participation');
  assert.equal(await host.broker.close().then(() => 'resolved', e => e.code), 'resolved', 'shutdown settles without the aggregate');
  assert.equal(await host.aggregate(), false, 'shutdown writes no aggregate state');
  assert.equal(await host.registered(), false);
});

test('optoutreplay: established exact evidence replay and release keep working after an opt-out', async t => {
  const host = await optedOut(t);
  const team = await host.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  const pin = { ownerId: 'parent', teamId: team.id, action: 'pin', name: 'consumer', uri: 'manual:evidence' };
  // One enabled pin establishes the store and its evidence ledger.
  host.config.enabled = true;
  assert.deepEqual(await host.call('subagent_evidence_retention', pin), { action: pin.action, name: pin.name, uri: pin.uri });
  assert.equal(await host.registered(), true, 'pin admission registers its store');
  const file = path.join(host.directory, 'evidence-retention.json'), written = await fs.readFile(file, 'utf8');
  host.config.enabled = false;
  // An exact replay still returns the stored exact pin and commits nothing new.
  assert.deepEqual(await host.call('subagent_evidence_retention', pin), { ownerId: pin.ownerId, teamId: pin.teamId, name: pin.name, uri: pin.uri });
  assert.equal(await fs.readFile(file, 'utf8'), written, 'an exact replay writes no second pin');
  assert.deepEqual([...await host.local.isolation.evidence.withReferences(async refs => refs)], [pin.uri], 'the exact pin is still retained');
  // Rebinding the name stays refused by the established conflict check.
  await assert.rejects(host.call('subagent_evidence_retention', { ...pin, uri: 'manual:other' }), e => e.code === 'retention_conflict');
  // A NEW pin is a fresh admission: refused while opted out, with no pin written.
  await assert.rejects(host.call('subagent_evidence_retention', { ...pin, name: 'second' }), e => e.code === 'feature_disabled');
  assert.equal(await fs.readFile(file, 'utf8'), written, 'a refused new pin changes no established pin');
  // Release is reclaiming this consumer's own reference, not new admission.
  assert.deepEqual(await host.call('subagent_evidence_retention', { ...pin, action: 'release' }), { action: 'release', name: pin.name, uri: pin.uri });
  assert.deepEqual([...await host.local.isolation.evidence.withReferences(async refs => refs)], [], 'the release removed the exact pin after the opt-out');
  assert.equal(await host.registered(), true, 'the established store stays a registered participant');
});

test('optoutview: a board-only manual pin still works with private views disabled', async t => {
  const host = await optedOut(t);
  const team = await host.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  // Private views are a separate feature: a manual evidence URI never needed one,
  // so the fresh-pin boundary consults the resource switch only.
  host.broker.options.isolatedViewsEnabled = () => false;
  host.config.enabled = true;
  const pin = { ownerId: 'parent', teamId: team.id, action: 'pin', name: 'consumer', uri: 'manual:evidence' };
  assert.deepEqual(await host.call('subagent_evidence_retention', pin), { action: 'pin', name: 'consumer', uri: pin.uri });
  assert.equal(await host.registered(), true, 'the board-only pin registers its store');
  assert.deepEqual([...await host.local.isolation.evidence.withReferences(async refs => refs)], [pin.uri]);
  // Release stays available at the same boundary.
  assert.deepEqual(await host.call('subagent_evidence_retention', { ...pin, action: 'release' }), { action: 'release', name: 'consumer', uri: pin.uri });
  assert.deepEqual([...await host.local.isolation.evidence.withReferences(async refs => refs)], []);
});

test('optoutledger: refused maintenance never makes shutdown touch an unrelated corrupt ledger', async t => {
  const host = await optedOut(t, { corruptLedger: true });
  const team = await host.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  const other = await host.call('subagent_team_create', { ownerId: 'other', requestId: 'other-team', name: 'other', description: '' });
  assert.equal(await host.registered(), false, 'the fixture store starts opted out');
  assert.equal(await host.aggregate(), true, 'the unrelated aggregate namespace already exists');
  const ledger = path.join(host.resourceDirectory, 'ledger.json');
  const ledgerBytes = () => fs.readFile(ledger, 'utf8').then(text => text, error => error.code);
  const savedLedger = await ledgerBytes(), savedEntries = (await fs.readdir(host.resourceDirectory)).sort();
  // Every aggregate write opens a ledger transaction first, so an accidental
  // enrollment cannot pass silently: it fails on this unreadable ledger.
  const governor = host.broker.resources, transaction = governor.transaction.bind(governor);
  let aggregateTransactions = 0;
  governor.transaction = async run => {
    aggregateTransactions++; return transaction(run);
  };
  try {
    // Inspection really reads the aggregate, so it reports the corrupt ledger -
    // but a status read is not participation either.
    await assert.rejects(host.call('subagent_resource_status'), e => e.code === 'resource_corrupt');
    aggregateTransactions = 0;
    // Malformed shapes are refused while parsing and foreign scopes by
    // authorization: none of them acquires any ownership of this store.
    await assert.rejects(host.call('subagent_resource_collect', { ownerId: 'parent' }), e => e.code === 'invalid_arguments');
    await assert.rejects(host.call('subagent_metadata_rollover', { ownerId: 'parent', kind: 'board', expectedEpoch: 0 }), e => e.code === 'invalid_arguments');
    await assert.rejects(host.call('subagent_resource_collect', { ownerId: 'parent', teamId: other.id }), e => e.code === 'forbidden');
    await assert.rejects(host.call('subagent_evidence_retention', { ownerId: 'parent', teamId: other.id, action: 'pin', name: 'pin', uri: 'manual:pin' }), e => e.code === 'forbidden');
    // Authorized, but stale: refused by the domain epoch check before its durable
    // phase, so it cannot enroll this store either.
    await assert.rejects(host.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 1 }), e => e.code === 'revision_conflict');
    assert.equal(host.broker.resourceUsed, false, 'a refused request is not participation');
    assert.equal(aggregateTransactions, 0, 'no refused request opens an aggregate transaction');
    host.broker.settingsChanged();
    assert.deepEqual(host.state.errors ?? [], [], 'a non-participant publishes no policy and reports no ledger error');
    assert.equal(aggregateTransactions, 0);
    assert.equal(await host.registered(), false, 'no refused request creates a local registration');
    assert.equal(await host.broker.close().then(() => 'resolved', e => e.code), 'resolved', 'shutdown settles without the aggregate');
    assert.equal(aggregateTransactions, 0, 'closing a non-participant writes nothing to the aggregate');
    assert.equal(await ledgerBytes(), savedLedger, 'the unrelated corrupt ledger is untouched');
    assert.deepEqual((await fs.readdir(host.resourceDirectory)).sort(), savedEntries, 'shutdown leaves no aggregate metadata behind');
    assert.equal(await host.registered(), false);
  } finally { governor.transaction = transaction; }
});

test('optoutrollover: stale rollover enrolls nothing and a valid retry commits under one fence', async t => {
  const { storageUsage } = require('../.test-build/resource-governor');
  const host = await optedOut(t);
  const team = await host.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  const board = await host.local.board.open(), views = await host.local.isolation.open();
  assert.equal(await host.registered(), false, 'the fixture store starts opted out');
  assert.equal(await host.aggregate(), false);
  assert.equal(board.epoch('parent'), 0);
  assert.equal(views.requestId('parent', 'probe'), 'probe');
  // Authorized, but stale: the domain refuses before its durable phase, so the
  // request can no longer enroll an opted-out store as a side effect.
  for (const kind of ['board', 'views']) {
    await assert.rejects(host.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind, expectedEpoch: 1 }), e => e.code === 'revision_conflict');
    assert.equal(await host.registered(), false, kind + ' refusal creates no local registration');
    assert.equal(await host.aggregate(), false, kind + ' refusal creates no aggregate state');
    assert.equal(host.broker.resourceUsed, false, kind + ' refusal is not participation');
  }
  assert.equal(board.epoch('parent'), 0, 'the refused rollover advanced no epoch');
  assert.equal(views.requestId('parent', 'probe'), 'probe');
  // The valid retry registers at the start of the durable phase and commits the
  // whole phase under exactly ONE store write fence.
  const store = host.local.store, write = store.withStorageWrite.bind(store);
  let fences = 0;
  store.withStorageWrite = async action => {
    fences++; return write(action);
  };
  let replayed, viewRoll;
  try {
    assert.equal((await host.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 0 })).epoch, 1);
    assert.equal(fences, 1, 'the whole board durable phase runs under one store write fence');
    assert.equal(await host.registered(), true, 'the validated retry keeps its intentional first registration');
    assert.equal(await host.aggregate(), true);
    assert.equal(await host.charged(), await storageUsage(host.directory), 'registered-store reconciliation still runs after the commit');
    fences = 0;
    replayed = await host.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 0 });
    assert.equal(fences, 0, 'an exact replay writes nothing');
    viewRoll = await host.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'views', expectedEpoch: 0 });
    assert.equal(fences, 1, 'the whole view durable phase runs under one store write fence');
  } finally { store.withStorageWrite = write; }
  assert.equal(replayed.replay, true);
  assert.equal(viewRoll.epoch, 1);
  assert.equal(board.epoch('parent'), 1);
  assert.equal(views.requestId('parent', 'probe'), 'e1:probe');
  // A failure AFTER the committed view rollover still reconciles the store it
  // registered, and the exact retry replays instead of publishing twice.
  const rollover = views.rolloverReceipts.bind(views); let lose = true;
  views.rolloverReceipts = async (...args) => {
    const result = await rollover(...args); if (lose) {
      lose = false; throw Error('lost view rollover acknowledgement');
    }
    return result;
  };
  try { await assert.rejects(host.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'views', expectedEpoch: 1 }), /lost view rollover acknowledgement/); }
  finally { views.rolloverReceipts = rollover; }
  assert.equal(await host.charged(), await storageUsage(host.directory), 'a post-commit failure still reconciles the registered store');
  const resumed = await host.call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'views', expectedEpoch: 1 });
  assert.equal(resumed.epoch, 2);
  assert.equal(resumed.replay, true);
  assert.equal(views.requestId('parent', 'probe'), 'e2:probe');
});
