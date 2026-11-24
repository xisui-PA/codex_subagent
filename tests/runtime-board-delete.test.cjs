// Focused backend contract for the UI-only manual HARD board deletion routes.
//
// These are INTERNAL host routes (`ui_board_delete_task` / `ui_board_delete_team`):
// no MCP tool, no worker catalog entry and no capability advertises them. Every
// test drives the real broker, the real board, the real resource governor and
// the real engine; only the model is scripted, so recorded behavior is the
// production one.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const build = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { WorkerBroker, unpack } = require(path.join(build, 'runtime'));
const { defaults, WorkerEngine } = require(path.join(build, 'engine'));
const { resourceDefaults } = require(path.join(build, 'resource-governor'));
const { workspaceDirectory } = require(path.join(build, 'workspaces'));
const { SessionStore } = require(path.join(build, 'storage'));
const { failure } = require(path.join(build, 'types'));
const { boardToolNames, isBoardTool, workerBoardToolNames } = require(path.join(build, 'task-board-tools'));

const model = { id: 'test/delete-route', name: 'Fixture', vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 };
const OWNER = 'delete-owner';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) { throw new Error('Condition timed out'); }
    await sleep(10);
  }
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delete-route-')));
  const root = path.join(base, 'repo');
  const other = path.join(base, 'other');
  await fs.mkdir(root);
  await fs.mkdir(other);
  await fs.writeFile(path.join(root, 'a.txt'), 'base');
  const state = {
    board: options.board ?? true,
    views: options.views ?? false,
    integration: options.integration ?? false,
    resources: options.resources ?? true,
    gate: undefined,
    actions: [],
    allowShell: options.allowShell ?? false,
    approved: true,
    approvals: [],
    approvalGate: undefined,
    approvalEntered: undefined,
    requests: [],
    errors: []
  };
  const provider = {
    models: async () => [model],
    countTokens: async () => 10,
    async *stream(selected, messages, tools) {
      state.requests.push({ selected, messages, tools });
      if (state.gate) {
        await state.gate.promise;
      }
      const action = state.actions.shift();
      yield action ?? { type: 'text', text: 'done' };
    }
  };
  const config = {
    storage: path.join(base, 'storage'), registry: path.join(base, 'bridges'), roots: [root, other], identity: `folder:${root}`,
    provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { allowWrite: true, allowShell: true, numSessions: 4 } } }),
    taskBoardEnabled: () => state.board,
    isolatedViewsEnabled: () => state.views,
    integrationEnabled: () => state.integration,
    resources: () => ({ ...resourceDefaults, enabled: state.resources }),
    resourceDirectory: path.join(base, 'resources'),
    files: {
      canWrite: () => true,
      allowShell: () => state.allowShell,
      approveCommand: async command => {
        state.approvals.push(command);
        state.approvalEntered?.resolve();
        if (state.approvalGate) {
          await state.approvalGate.promise;
        }
        return state.approved;
      }
    },
    ...(options.runners === undefined ? {} : { runners: () => ({ capacity: 2, maxQueue: 4, ...options.runners }) }),
    onChange() {},
    onError: message => state.errors.push(message)
  };
  let broker = new WorkerBroker(config);
  await broker.start();
  const call = async (name, args, at = root) => unpack(await broker.invoke(at, name, args));
  const rejected = async (name, args, at = root) => {
    try {
      await call(name, args, at);
      return undefined;
    } catch (error) {
      return failure(error);
    }
  };
  t.after(async () => {
    // A failed assertion must never leave a provider/approval gate held: close
    // would wait forever. Release every gate, deny any pending approval so no
    // command can start, then close with a bounded wait.
    state.approved = false;
    try { state.gate?.resolve(); } catch { /* already resolved */ }
    try { state.approvalGate?.resolve(); } catch { /* already resolved */ }
    await Promise.race([broker.close().catch(() => undefined), sleep(15_000)]);
    await fs.rm(base, { recursive: true, force: true });
  });
  return {
    base, root, other, state, config,
    get broker() { return broker; },
    get local() { return broker.local.get(root); },
    call, rejected,
    restart: async () => {
      await broker.close();
      broker = new WorkerBroker(config);
      await broker.start();
    },
    directory: await workspaceDirectory(config.storage, root),
    stopped: async id => {
      await until(() => !['queued', 'running'].includes(broker.local.get(root).store.get(id).state) && !broker.local.get(root).engine.active.has(id));
      return broker.local.get(root).store.get(id);
    }
  };
}

/** One team plus one task, created through the ordinary coordinator MCP tools. */
async function seed(f, taskOptions = {}) {
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'seed-team', name: 'Board team', description: '' });
  const task = await f.call('subagent_task_create', {
    ownerId: OWNER, requestId: 'seed-task', teamId: team.id, title: taskOptions.title ?? 'Seeded task', description: '',
    ...(taskOptions.assigneeWorkerId ? { assigneeWorkerId: taskOptions.assigneeWorkerId } : {})
  });
  return { team, task };
}

const deleteTask = (teamId, taskId, revision, requestId = 'delete-task') =>
  ({ requestId, teamId, taskId, expectedRevision: revision });
const deleteTeam = (teamId, revision, requestId = 'delete-team') =>
  ({ requestId, teamId, expectedRevision: revision });

test('the delete routes are internal only and refuse while the board is disabled', async t => {
  const f = await fixture(t, { board: false });
  for (const [name, args] of [
    ['ui_board_delete_task', deleteTask('a'.repeat(32), '1'.repeat(32), 0)],
    ['ui_board_delete_team', deleteTeam('a'.repeat(32), 0)]
  ]) {
    const error = await f.rejected(name, args);
    assert.equal(error?.code, 'feature_disabled', `${name} must be gated by the board opt-in`);
  }
  // Nothing was created: a disabled board never opens its store.
  await assert.rejects(fs.access(path.join(f.directory, 'task-board.json')), { code: 'ENOENT' });

  // Neither route is a board tool, a worker tool or a reported capability.
  for (const name of ['ui_board_delete_task', 'ui_board_delete_team']) {
    assert.equal(isBoardTool(name), false);
    assert.equal(boardToolNames.includes(name), false);
    assert.equal(workerBoardToolNames.includes(name), false);
  }
  const health = await f.call('subagent_health', {});
  assert.equal(health.capabilities.some(name => name.startsWith('ui_board_delete')), false);
});

test('a UI-supplied actor, an unknown field or a missing revision is rejected without touching the board', async t => {
  const f = await fixture(t);
  const { team, task } = await seed(f);
  const good = deleteTask(team.id, task.id, task.revision);

  for (const args of [
    { ...good, ownerId: OWNER },
    { ...good, actor: { kind: 'coordinator', ownerId: OWNER } },
    { ...good, workerId: 'f'.repeat(32) }
  ]) {
    assert.equal((await f.rejected('ui_board_delete_task', args))?.code, 'invalid_arguments');
  }
  const { expectedRevision, ...missing } = good;
  assert.equal((await f.rejected('ui_board_delete_task', missing))?.code, 'invalid_arguments');
  assert.equal((await f.rejected('ui_board_delete_team', { ...deleteTeam(team.id, team.revision), ownerId: OWNER }))?.code, 'invalid_arguments');

  // The record is untouched by every refused attempt.
  assert.equal((await f.call('subagent_task_get', { ownerId: OWNER, id: task.id })).revision, task.revision);
  // And the exact, actor-free payload only deletes what the persisted board names.
  const ack = await f.call('ui_board_delete_task', good);
  assert.deepEqual(ack, { kind: 'task_deleted', id: task.id, teamId: team.id, coordinatorOwnerId: OWNER, revision: task.revision });
});

test('records of another root and unknown ids are not found; an alien path is refused', async t => {
  const f = await fixture(t);
  const { team, task } = await seed(f);

  assert.equal((await f.rejected('ui_board_delete_task', deleteTask(team.id, task.id, task.revision), f.other))?.code, 'not_found');
  assert.equal((await f.rejected('ui_board_delete_task', deleteTask('b'.repeat(32), task.id, task.revision)))?.code, 'not_found');
  assert.equal((await f.rejected('ui_board_delete_task', deleteTask(team.id, '3'.repeat(32), task.revision)))?.code, 'not_found');
  const outsideRoot = path.join(f.base, 'outside');
  await fs.mkdir(outsideRoot);
  const outside = await f.rejected('ui_board_delete_task', deleteTask(team.id, task.id, task.revision), outsideRoot);
  assert.equal(outside?.code, 'outside_workspace');
  assert.equal((await f.call('subagent_task_list', { ownerId: OWNER })).tasks.length, 1, 'nothing was removed');
});

test('an ordinary active worker blocks its assigned task; the stale in_progress task deletes once idle', async t => {
  const f = await fixture(t);
  const worker = await f.call('subagent_spawn', { ownerId: OWNER, requestId: 'worker', task: 'idle', model: model.id });
  await f.stopped(worker.id);
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Busy team', description: '' });
  const joined = await f.call('subagent_team_update', { ownerId: OWNER, requestId: 'join', teamId: team.id, expectedRevision: team.revision, addMembers: [worker.id] });
  let task = await f.call('subagent_task_create', {
    ownerId: OWNER, requestId: 'task', teamId: joined.id, title: 'Busy task', description: '', assigneeWorkerId: worker.id
  });
  // A stale in_progress task with no completion, exactly as a crashed worker leaves it.
  task = await f.call('subagent_task_update', { ownerId: OWNER, requestId: 'start', taskId: task.id, expectedRevision: task.revision, state: 'in_progress' });
  assert.equal(task.state, 'in_progress');

  // Live work: an ordinary (unbound) worker whose CURRENT assignment is this task.
  f.state.gate = deferred();
  const running = f.call('subagent_send', { ownerId: OWNER, id: worker.id, requestId: 'busy', message: 'work' });
  await until(() => f.local.store.get(worker.id).state === 'running');
  const busy = await f.rejected('ui_board_delete_task', deleteTask(team.id, task.id, task.revision));
  assert.equal(busy?.code, 'worker_busy');
  assert.match(busy.message, new RegExp(worker.id), 'the blocking worker id is reported');
  assert.match(busy.message, /no worker is stopped automatically/);

  // Cancellation is NOT required and never performed here: the engine keeps a
  // draining job registered until its tools settle, and the fence reads that
  // live job state. The deterministic draining proof lives in the engine-level
  // fence test below, where no control holds the engine mutex.
  f.state.gate.resolve();
  await running.catch(() => undefined);
  await f.stopped(worker.id);
  f.state.gate = undefined;

  // Idle now: the stale in_progress record deletes with no lifecycle transition.
  const ack = await f.call('ui_board_delete_task', deleteTask(team.id, task.id, task.revision));
  assert.equal(ack.kind, 'task_deleted');
  assert.deepEqual((await f.call('subagent_task_list', { ownerId: OWNER })).tasks, []);
  assert.equal((await f.rejected('subagent_task_get', { ownerId: OWNER, id: task.id }))?.code, 'not_found');
  // The worker and its transcript are untouched.
  const kept = await f.call('subagent_status', { id: worker.id });
  assert.equal(kept.id, worker.id);
  assert.ok(kept.turns.length >= 1);

  // The now-empty team deletes too.
  const current = await f.call('subagent_team_get', { ownerId: OWNER, id: team.id });
  assert.equal((await f.call('ui_board_delete_team', deleteTeam(team.id, current.revision))).kind, 'team_deleted');
  assert.equal((await f.rejected('subagent_team_get', { ownerId: OWNER, id: team.id }))?.code, 'not_found');
});

test('a held deletion fence is honored by schedule, start, resume and maintenance, and stops nothing unrelated', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delete-fence-')));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  const requests = [];
  const provider = {
    models: async () => [model],
    countTokens: async () => 10,
    async *stream(selected, messages) { requests.push({ selected, messages }); yield { type: 'text', text: 'done' }; }
  };
  const store = new SessionStore(path.join(base, 'store'));
  await store.open();
  const engine = new WorkerEngine(store, provider, { workspaceRoot: root, definitions: () => [], execute: async () => 'ok' },
    () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { numSessions: 4 } } }));
  t.after(async () => {
    await engine.shutdown();
    await store.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const spawn = requestId => engine.spawn({ requestId, task: requestId, permission: 'read-only', model: model.id });
  const settle = async id => {
    await until(() => !['queued', 'running'].includes(store.get(id).state) && !engine.active.has(id));
    return store.get(id);
  };
  const related = await spawn('related');
  const unrelated = await spawn('unrelated');
  await settle(related.id);
  await settle(unrelated.id);

  // A session that is ALREADY runnable makes the fence refuse: a delete never
  // stops live work implicitly.
  const requeue = id => store.change(id, s => {
    s.turns.push({ ...structuredClone(s.turns[0]), id: 'turn-' + Math.random().toString(16).slice(2, 10), state: 'queued', started: false, attempts: 0, output: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    s.state = 'queued';
  });
  await requeue(related.id);
  await assert.rejects(engine.withDeletionFence({ teamId: 'a'.repeat(32), workerIds: [related.id] }, async () => 'never'),
    { code: 'worker_busy' }, 'a queued matching session blocks the delete');
  // The refusal releases the fence, so that turn is handed back to the normal
  // scheduler instead of staying queued: wait for it to finish normally.
  await settle(related.id);
  await requeue(unrelated.id);
  const before = requests.length;

  // The deletion I/O is paused here; the fence is registered and the engine
  // mutex is held. A control that committed a queued session just before this
  // fence is simulated by requeueing under the held fence.
  const pause = deferred();
  const entered = deferred();
  const deletion = engine.withDeletionFence({ teamId: 'a'.repeat(32), workerIds: [related.id] }, async () => {
    entered.resolve();
    await requeue(related.id);
    await pause.promise;
    return 'deleted';
  });
  await entered.promise;

  // Nothing matching may start, and no control may enter the same worker.
  await assert.rejects(engine.send(related.id, 'r-send', 'x'), { code: 'board_deleting' });
  await assert.rejects(engine.resume(related.id, 'r-resume', model.id), { code: 'board_deleting' });
  await assert.rejects(engine.startPrepared(related.id), { code: 'board_deleting' });
  await assert.rejects(engine.compact(related.id, store.get(related.id).revision), { code: 'board_deleting' });
  // schedule() is NOT mutex protected, so this is the real proof: the fenced
  // session stays queued while the unrelated one starts normally.
  engine.reschedule();
  await until(() => requests.length > before);
  await sleep(50);
  assert.equal(requests.length, before + 1, 'only the unrelated session started');
  assert.equal(store.get(related.id).state, 'queued', 'the fenced session never started');

  pause.resolve();
  assert.equal(await deletion, 'deleted');
  // Released: fence release itself restores normal scheduling, with NO explicit
  // reschedule call here, proving the fence was the only thing holding it back.
  await until(() => requests.length > before + 1);
  await settle(related.id);
});

test('a non-governed BOUND worker on the current assignment blocks its task while live', async t => {
  // Board + views with resources OFF: the supported shape where a worker is
  // permanently bound (isolatedView set) with NO startup record at all. Its
  // binding is its only team identity, so a startup-only scope misses it.
  const f = await fixture(t, { views: true, resources: false });
  const worker = await f.call('subagent_spawn', { ownerId: OWNER, requestId: 'w', task: 'idle', model: model.id });
  await f.stopped(worker.id);
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Bound team', description: '' });
  const joined = await f.call('subagent_team_update', { ownerId: OWNER, requestId: 'join', teamId: team.id, expectedRevision: team.revision, addMembers: [worker.id] });
  const task = await f.call('subagent_task_create', {
    ownerId: OWNER, requestId: 'task', teamId: joined.id, title: 'Bound task', description: '', assigneeWorkerId: worker.id
  });
  const snapshot = await f.call('subagent_snapshot_create', { ownerId: OWNER, teamId: joined.id, requestId: 'snap' });
  await f.call('subagent_view_bind', { ownerId: OWNER, teamId: joined.id, requestId: 'bind', id: worker.id, snapshotId: snapshot.id });
  const bound = f.local.store.get(worker.id);
  assert.equal(bound.mode, 'isolated');
  assert.equal(bound.startup, undefined, 'this worker has NO startup record: only its binding identifies it');

  f.state.gate = deferred();
  const running = f.call('subagent_send', { ownerId: OWNER, id: worker.id, requestId: 'work', message: 'go' });
  await until(() => f.local.store.get(worker.id).state === 'running');
  const busy = await f.rejected('ui_board_delete_task', deleteTask(joined.id, task.id, task.revision));
  assert.equal(busy?.code, 'worker_busy', 'a bound worker executing the current assignment must block deletion');
  assert.match(busy.message, new RegExp(worker.id));

  f.state.gate.resolve();
  await running.catch(() => undefined);
  await f.stopped(worker.id);
  f.state.gate = undefined;
  assert.equal((await f.call('ui_board_delete_task', deleteTask(joined.id, task.id, task.revision))).kind, 'task_deleted');
});

test('a committed send racing a deletion is refused and rescheduled by the fence release', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delete-wakeup-')));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  const requests = [];
  const provider = {
    models: async () => [model],
    countTokens: async () => 10,
    async *stream() { requests.push(Date.now()); yield { type: 'text', text: 'done' }; }
  };
  const store = new SessionStore(path.join(base, 'store'));
  await store.open();
  const engine = new WorkerEngine(store, provider, { workspaceRoot: root, definitions: () => [], execute: async () => 'ok' },
    () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { numSessions: 4 } } }));
  t.after(async () => {
    await engine.shutdown();
    await store.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const worker = await engine.spawn({ requestId: 'w', task: 'w', permission: 'read-only', model: model.id });
  for (let i = 0; i < 500 && store.get(worker.id).state !== 'completed'; i++) { await sleep(10); }
  assert.equal(store.get(worker.id).state, 'completed');
  const before = requests.length;

  // Pause the send's own durable turn write, so the deletion registers its fence
  // while that control has already entered the engine mutex.
  const entered = deferred();
  const writeGate = deferred();
  const original = store.change.bind(store);
  let paused = false;
  store.change = async (...args) => {
    if (!paused) {
      paused = true;
      entered.resolve();
      await writeGate.promise;
    }
    return original(...args);
  };
  const sending = engine.send(worker.id, 'r-send', 'follow-up');
  await entered.promise;
  const deletion = engine.withDeletionFence({ teamId: 'a'.repeat(32), workerIds: [worker.id] }, async () => 'never');
  // The fence is registered; now the send commits and its own schedule() is skipped.
  writeGate.resolve();
  await sending;
  const refused = await deletion.then(() => undefined, error => error);
  store.change = original;
  assert.equal(refused?.code, 'worker_busy', 'the just-committed turn is live work');

  // No explicit reschedule here: the fence release must hand the turn back.
  await until(() => requests.length > before);
  for (let i = 0; i < 500 && engine.active.has(worker.id); i++) { await sleep(10); }
  assert.equal(store.get(worker.id).state, 'completed');
});

test('a governed provider held after cancellation blocks deletion until its effect drains', async t => {
  const f = await fixture(t, { views: true, resources: true });
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Governed team', description: '' });
  const snapshot = await f.call('subagent_snapshot_create', { ownerId: OWNER, teamId: team.id, requestId: 'snap' });
  const task = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'task', teamId: team.id, title: 'Governed task', description: '' });
  f.state.gate = deferred();
  const worker = await f.call('subagent_isolated_spawn', {
    ownerId: OWNER, requestId: 'spawn', task: 'governed work', model: model.id, permission: 'workspace-write',
    setup: { teamId: team.id, taskId: task.id, snapshotId: snapshot.id, teamRevision: team.revision, taskRevision: task.revision, lane: 'work' }
  });
  await until(() => f.local.store.get(worker.id).state === 'running');
  await until(() => f.local.lifecycle.inference.size > 0);
  // The governed setup assigned the task, so its revision advanced.
  const started = await f.call('subagent_task_get', { ownerId: OWNER, id: task.id });

  // Cancel WITHOUT resolving the provider: the aborted outer job cannot drain a
  // provider that is still held, so the lifecycle keeps the inference token.
  const cancelling = f.call('subagent_cancel', { ownerId: OWNER, id: worker.id });
  await until(() => /Stopping/.test(f.local.store.get(worker.id).activity ?? ''));
  assert.ok(f.local.lifecycle.inference.size > 0, 'the governed inference token is still held');
  const blocked = await f.rejected('ui_board_delete_task', deleteTask(team.id, task.id, started.revision));
  assert.equal(blocked?.code, 'worker_busy');
  assert.match(blocked.message, /governed work or an admission/);

  f.state.gate.resolve();
  await cancelling;
  await f.stopped(worker.id);
  await until(() => f.local.lifecycle.inference.size === 0);
  f.state.gate = undefined;
  assert.equal((await f.call('ui_board_delete_task', deleteTask(team.id, task.id, started.revision))).kind, 'task_deleted');
});

test('a stopped pre-creation setup blocks deletion and never binds or starts', async t => {
  const f = await fixture(t, { views: true, resources: true });
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Setup team', description: '' });
  const snapshot = await f.call('subagent_snapshot_create', { ownerId: OWNER, teamId: team.id, requestId: 'snap' });
  const task = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'task', teamId: team.id, title: 'Setup task', description: '' });
  const failed = await f.rejected('subagent_isolated_spawn', {
    ownerId: OWNER, requestId: 'spawn', task: 'stale setup', model: model.id, permission: 'workspace-write',
    setup: { teamId: team.id, taskId: task.id, snapshotId: snapshot.id, teamRevision: team.revision, taskRevision: task.revision + 5, lane: 'work' }
  });
  assert.ok(failed, 'the stale setup is refused');
  const stopped = f.local.store.list().find(session => session.startup !== undefined);
  assert.ok(stopped, 'a stopped setup record is left for inspection');
  assert.ok(['created', 'assigned', 'bound', 'ready'].includes(stopped.startup.phase));
  assert.equal(stopped.isolatedView, undefined, 'nothing was bound');

  const blocked = await f.rejected('ui_board_delete_task', deleteTask(team.id, task.id, task.revision));
  assert.equal(blocked?.code, 'worker_busy');
  assert.match(blocked.message, /startup/);

  // Cancelling that stopped setup frees the record; it never starts anything.
  await f.call('subagent_cancel', { ownerId: OWNER, id: stopped.id });
  assert.equal(f.local.store.get(stopped.id).startup.phase, 'cancelled');
  assert.equal((await f.call('ui_board_delete_task', deleteTask(team.id, task.id, task.revision))).kind, 'task_deleted');
});

test('a live worker bound to a ready attempt seed blocks that source task, and blocks nothing once idle', async t => {
  // Integration is a live opt-in over board+views+resources, so this fixture
  // enables resources while the associated worker itself stays non-governed.
  const f = await fixture(t, { views: true, resources: true, integration: true });
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Attempt team', description: '' });
  const source = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'source', teamId: team.id, title: 'Source task', description: '' });
  const validation = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'validation', teamId: team.id, title: 'Validation task', description: '' });
  const worker = await f.call('subagent_spawn', { ownerId: OWNER, requestId: 'w', task: 'idle', model: model.id });
  await f.stopped(worker.id);
  const joined = await f.call('subagent_team_update', { ownerId: OWNER, requestId: 'join', teamId: team.id, expectedRevision: team.revision, addMembers: [worker.id] });
  // TWO distinct captures: the ordinary base (shared starting point) and the
  // attempt's own derived seed the worker is really bound to.
  const base = await f.call('subagent_snapshot_create', { ownerId: OWNER, teamId: joined.id, requestId: 'snap-base' });
  const snapshot = await f.call('subagent_snapshot_create', { ownerId: OWNER, teamId: joined.id, requestId: 'snap-seed' });
  assert.notEqual(base.id, snapshot.id, 'the derived seed must not be the shared base capture');
  await f.call('subagent_view_bind', { ownerId: OWNER, teamId: joined.id, requestId: 'bind', id: worker.id, snapshotId: snapshot.id });
  // Its OWN task is the validation task, NOT the selected source task.
  await f.call('subagent_task_update', { ownerId: OWNER, requestId: 'assign', taskId: validation.id, expectedRevision: validation.revision, assigneeWorkerId: worker.id });

  // A real durable attempt ledger: one READY attempt selecting the source task and
  // sealed over this worker's bound seed. No runner lease exists yet.
  const integration = path.join(f.directory, 'integration');
  await fs.mkdir(integration, { recursive: true });
  await fs.writeFile(path.join(integration, 'integration-attempts.namespace.json'), '{"schema":1,"kind":"integration-attempts"}');
  const ledger = JSON.stringify({ schema: 1, attempts: [{
    schema: 1, id: 'ab'.repeat(32), ownerId: OWNER, teamId: team.id, beginRequestId: 'begin-1',
    fingerprint: 'cd'.repeat(32), revision: 2, status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    dependencyOnly: false, seedOnly: false,
    requirements: { sources: [{
      taskId: source.id, taskRevision: source.revision, title: 'Source task', description: '',
      state: 'ready', acceptanceCriteria: ['sealed'], artifact: { id: 'a1'.repeat(32), version: 1, uri: 'submission://a1/1' },
      evidence: [{ id: 'e1'.repeat(16), version: 1, uri: 'urn:codex-runner-result:r1' }],
      producer: { workerId: worker.id, workerCreatedAt: f.local.store.get(worker.id).createdAt }
    }] },
    dependencies: [], validationCommands: ['node verify.cjs'], contracts: [], conflicts: [],
    derivedSnapshotId: snapshot.id, baseSnapshotId: base.id,
    pinState: 'none', evidencePinned: false, producerSubmissions: [], validations: [], requests: []
  }] });
  await fs.writeFile(path.join(integration, 'integration-attempts.json'), ledger);

  f.state.gate = deferred();
  const running = f.call('subagent_send', { ownerId: OWNER, id: worker.id, requestId: 'go', message: 'validate' });
  await until(() => f.local.store.get(worker.id).state === 'running');
  const blocked = await f.rejected('ui_board_delete_task', deleteTask(team.id, source.id, source.revision));
  assert.equal(blocked?.code, 'worker_busy', 'the attempt-associated live worker blocks its SOURCE task');
  assert.match(blocked.message, new RegExp(worker.id));

  f.state.gate.resolve();
  await running.catch(() => undefined);
  await f.stopped(worker.id);
  f.state.gate = undefined;
  // Idle: the ready historical attempt alone never blocks its source task.
  assert.equal((await f.call('ui_board_delete_task', deleteTask(team.id, source.id, source.revision))).kind, 'task_deleted');
  assert.equal(await fs.readFile(path.join(integration, 'integration-attempts.json'), 'utf8'), ledger, 'the attempt ledger was never rewritten');
});

test('seed attribution: sharing the original base never blocks, the exact derived seed always does', async t => {
  const f = await fixture(t, { views: true, resources: true, integration: true });
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Seed team', description: '' });
  const base = await f.call('subagent_snapshot_create', { ownerId: OWNER, teamId: team.id, requestId: 'base' });
  const derived = await f.call('subagent_snapshot_create', { ownerId: OWNER, teamId: team.id, requestId: 'derived' });
  assert.notEqual(base.id, derived.id);
  const sharedSource = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'shared-source', teamId: team.id, title: 'Shared base source', description: '' });
  const seedSource = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'seed-source', teamId: team.id, title: 'Derived seed source', description: '' });
  const validation = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'validation', teamId: team.id, title: 'Validation task', description: '' });

  // W_base is bound to the ORDINARY base capture only: shared, never evidence.
  const baseWorker = await f.call('subagent_spawn', { ownerId: OWNER, requestId: 'w-base', task: 'idle', model: model.id });
  await f.stopped(baseWorker.id);
  let current = await f.call('subagent_team_get', { ownerId: OWNER, id: team.id });
  current = await f.call('subagent_team_update', { ownerId: OWNER, requestId: 'join-base', teamId: team.id, expectedRevision: current.revision, addMembers: [baseWorker.id] });
  await f.call('subagent_view_bind', { ownerId: OWNER, teamId: team.id, requestId: 'bind-base', id: baseWorker.id, snapshotId: base.id });

  // W_seed is a GOVERNED validation worker whose OWN task is `validation`, bound
  // to the attempt-specific derived seed. Its startup task is never the source.
  const baseRev = f.local.store.get(baseWorker.id).createdAt;
  assert.ok(baseRev);
  const seedWorker = await f.call('subagent_isolated_spawn', {
    ownerId: OWNER, requestId: 'w-seed', task: 'validate', model: model.id, permission: 'workspace-write',
    setup: { teamId: team.id, taskId: validation.id, snapshotId: derived.id, teamRevision: current.revision, taskRevision: validation.revision, lane: 'validation' }
  });
  await f.stopped(seedWorker.id);
  const bound = f.local.store.get(seedWorker.id);
  assert.equal(bound.startup.taskId, validation.id);
  assert.equal(bound.isolatedView.snapshotId, derived.id);

  // Two READY attempts: one composed over the shared base (no-conflict seed ==
  // base), one over its own derived seed.
  const attempt = (id, task, seedId) => ({
    schema: 1, id, ownerId: OWNER, teamId: team.id, beginRequestId: 'begin-' + id.slice(0, 4),
    fingerprint: 'cd'.repeat(32), revision: 2, status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    dependencyOnly: false, seedOnly: false,
    requirements: { sources: [{
      taskId: task.id, taskRevision: task.revision, title: task.title, description: '',
      state: 'ready', acceptanceCriteria: ['sealed'], artifact: { id: 'a1'.repeat(32), version: 1, uri: 'submission://a1/1' },
      evidence: [{ id: 'e1'.repeat(16), version: 1, uri: 'urn:codex-runner-result:r1' }],
      producer: { workerId: baseWorker.id, workerCreatedAt: f.local.store.get(baseWorker.id).createdAt }
    }] },
    dependencies: [], validationCommands: ['node verify.cjs'], contracts: [], conflicts: [],
    derivedSnapshotId: seedId, baseSnapshotId: base.id,
    pinState: 'none', evidencePinned: false, producerSubmissions: [], validations: [], requests: []
  });
  const integration = path.join(f.directory, 'integration');
  await fs.mkdir(integration, { recursive: true });
  await fs.writeFile(path.join(integration, 'integration-attempts.namespace.json'), '{"schema":1,"kind":"integration-attempts"}');
  const ledger = JSON.stringify({ schema: 1, attempts: [
    attempt('aa'.repeat(32), sharedSource, base.id),
    attempt('bb'.repeat(32), seedSource, derived.id)
  ] });
  await fs.writeFile(path.join(integration, 'integration-attempts.json'), ledger);

  // CONTROL 1: the base-bound worker is ACTIVE, yet the shared base is no
  // evidence - deleting the other task succeeds.
  f.state.gate = deferred();
  const baseRunning = f.call('subagent_send', { ownerId: OWNER, id: baseWorker.id, requestId: 'base-work', message: 'work' });
  await until(() => f.local.store.get(baseWorker.id).state === 'running');
  assert.equal((await f.call('ui_board_delete_task', deleteTask(team.id, sharedSource.id, sharedSource.revision, 'delete-shared'))).kind, 'task_deleted');
  f.state.gate.resolve();
  await baseRunning.catch(() => undefined);
  await f.stopped(baseWorker.id);
  f.state.gate = undefined;

  // CONTROL 2: the governed worker is QUEUED with a durable wait and NO engine
  // job at all, so neither a model admission nor an inference token exists yet.
  // The exact derived seed is still real evidence, so the source cannot be
  // deleted during that pre-token phase.
  await f.call('subagent_schedule', { ownerId: OWNER, id: seedWorker.id, wait: { kind: 'message', key: 'hold' }, expectedWaitRevision: 0 });
  await f.local.store.change(seedWorker.id, s => {
    for (const entry of s.turns) { if (entry.state !== 'completed') { entry.state = 'queued'; } }
    s.state = 'queued';
  });
  assert.equal(f.local.engine.active.has(seedWorker.id), false, 'no engine job exists yet');
  assert.equal(f.local.lifecycle.inference.size, 0, 'no model token exists yet');
  assert.equal(f.local.lifecycle.admissions.size, 0, 'no admission exists yet');
  const seedDelete = () => deleteTask(team.id, seedSource.id, seedSource.revision, 'delete-seed');
  const blocked = await f.rejected('ui_board_delete_task', seedDelete());
  assert.equal(blocked?.code, 'worker_busy', 'the governed worker on the exact derived seed blocks the source task');
  assert.match(blocked.message, new RegExp(seedWorker.id));

  // And it keeps blocking while that worker is actively running the turn.
  f.state.gate = deferred();
  const seedTurn = f.call('subagent_send', { ownerId: OWNER, id: seedWorker.id, requestId: 'seed-work', message: 'validate' });
  await f.call('subagent_schedule', { ownerId: OWNER, id: seedWorker.id, wait: null, expectedWaitRevision: 1 });
  await until(() => f.local.store.get(seedWorker.id).state === 'running');
  const blockedWhileRunning = await f.rejected('ui_board_delete_task', seedDelete());
  assert.equal(blockedWhileRunning?.code, 'worker_busy');
  assert.match(blockedWhileRunning.message, new RegExp(seedWorker.id));

  // Release the turn: the ready attempt alone never blocks afterwards.
  f.state.gate.resolve();
  await seedTurn.catch(() => undefined);
  await f.stopped(seedWorker.id);
  f.state.gate = undefined;
  // The refused attempts recorded nothing, so the SAME request id still commits.
  assert.equal((await f.call('ui_board_delete_task', seedDelete())).kind, 'task_deleted');
  assert.equal(await fs.readFile(path.join(integration, 'integration-attempts.json'), 'utf8'), ledger, 'the ledger was never rewritten');
});

test('a deletion fence refuses a begin that turns integration on before the durable delete', async t => {
  const f = await fixture(t, { views: true, resources: true, integration: false });
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Fence team', description: '' });
  const source = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'source', teamId: team.id, title: 'Fence source', description: '' });
  const integration = path.join(f.directory, 'integration');
  await assert.rejects(fs.access(integration), { code: 'ENOENT' }, 'integration never ran in this workspace');

  // Pause the deletion inside its own durable action; the host fence is held.
  const board = await f.local.board.open();
  const entered = deferred();
  const pause = deferred();
  const original = board.deleteTask.bind(board);
  board.deleteTask = async (...args) => {
    entered.resolve();
    await pause.promise;
    return original(...args);
  };
  const deleting = f.call('ui_board_delete_task', deleteTask(team.id, source.id, source.revision));
  await entered.promise;

  // Integration is enabled mid-deletion: a begin must be refused by the fence and
  // must create nothing at all.
  f.state.integration = true;
  const begin = {
    action: 'begin', ownerId: OWNER, teamId: team.id, requestId: 'begin-late',
    sources: [{ taskId: source.id, taskRevision: source.revision, artifact: { id: 'a1'.repeat(32), version: 1, uri: 'submission://a1/1' },
      evidence: [{ id: 'e1'.repeat(16), version: 1, uri: 'urn:codex-runner-result:r1' }] }],
    validationCommands: ['node verify.cjs']
  };
  const refused = await f.rejected('subagent_integration', begin);
  assert.equal(refused?.code, 'board_deleting');
  await assert.rejects(fs.access(integration), { code: 'ENOENT' }, 'the refused begin created no namespace, attempt or pin');

  pause.resolve();
  assert.equal((await deleting).kind, 'task_deleted');
  board.deleteTask = original;

  // Fence released: the same begin is no longer refused by the deletion fence.
  const after = await f.rejected('subagent_integration', begin);
  assert.notEqual(after?.code, 'board_deleting');
  assert.ok(after, 'the begin now reaches ordinary integration validation and fails there');
});

test('an ALREADY-entered integration action is never aborted by a deletion; the deletion is refused', async t => {
  const f = await fixture(t, { views: true, resources: true, integration: true });
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'In-flight team', description: '' });
  const task = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'task', teamId: team.id, title: 'In-flight task', description: '' });

  // A real durable ledger with one READY attempt, so `status` is a genuine,
  // side-effect-free integration action that succeeds.
  const attemptId = 'ab'.repeat(32);
  const integration = path.join(f.directory, 'integration');
  await fs.mkdir(integration, { recursive: true });
  await fs.writeFile(path.join(integration, 'integration-attempts.namespace.json'), '{"schema":1,"kind":"integration-attempts"}');
  await fs.writeFile(path.join(integration, 'integration-attempts.json'), JSON.stringify({ schema: 1, attempts: [{
    schema: 1, id: attemptId, ownerId: OWNER, teamId: team.id, beginRequestId: 'begin-1',
    fingerprint: 'cd'.repeat(32), revision: 2, status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    dependencyOnly: false, seedOnly: false,
    requirements: { sources: [{
      taskId: task.id, taskRevision: task.revision, title: 'In-flight task', description: '',
      state: 'ready', acceptanceCriteria: ['sealed'], artifact: { id: 'a1'.repeat(32), version: 1, uri: 'submission://a1/1' },
      evidence: [{ id: 'e1'.repeat(16), version: 1, uri: 'urn:codex-runner-result:r1' }],
      producer: { workerId: 'af'.repeat(16), workerCreatedAt: '2026-01-01T00:00:00.000Z' }
    }] },
    dependencies: [], validationCommands: ['node verify.cjs'], contracts: [], conflicts: [],
    derivedSnapshotId: 'da'.repeat(32), baseSnapshotId: 'db'.repeat(32),
    pinState: 'none', evidencePinned: false, producerSubmissions: [], validations: [], requests: []
  }] }));

  // Hold this action AFTER it has entered the host (its live entry is registered)
  // and BEFORE the ledger is touched: exactly the window a deletion must respect.
  const service = await f.local.isolation.openIntegration(() => undefined);
  const entered = deferred();
  const held = deferred();
  const original = service.invoke.bind(service);
  let guardAfterDeletionRefusal;
  service.invoke = async (args, authorize, recoveryError) => {
    entered.resolve();
    await held.promise;
    // The already-entered action's LIVE guard must still pass, long after the
    // deletion refused. A fence installed by that deletion would throw here.
    guardAfterDeletionRefusal = (() => { try { authorize(); return undefined; } catch (error) { return error; } })();
    return original(args, authorize, recoveryError);
  };

  const action = f.call('subagent_integration', { action: 'status', ownerId: OWNER, teamId: team.id, attemptId });
  await entered.promise;

  // The deletion must not abort it: it refuses with integration_busy and leaves
  // the board exactly as it was.
  const refused = await f.rejected('ui_board_delete_task', deleteTask(team.id, task.id, task.revision));
  assert.equal(refused?.code, 'integration_busy');
  assert.match(refused.message, /not started/);
  assert.match(refused.message, /no integration work is stopped automatically/);
  assert.equal((await f.call('subagent_task_get', { ownerId: OWNER, id: task.id })).revision, task.revision, 'the board is unchanged');

  // Release: the action finishes normally and its live guard never saw a fence.
  held.resolve();
  const view = await action;
  service.invoke = original;
  assert.equal(guardAfterDeletionRefusal, undefined, 'the entered action\'s authorize guard still passes after the deletion refused');
  assert.equal(view.id ?? view.attemptId ?? attemptId, attemptId);

  // Contrast: while a deletion holds its fence, a NEW action is still refused.
  const deleting = await f.local.board.open();
  const deleteGate = deferred();
  const deleteEntered = deferred();
  const deleteTaskOriginal = deleting.deleteTask.bind(deleting);
  deleting.deleteTask = async (...args) => {
    deleteEntered.resolve();
    await deleteGate.promise;
    return deleteTaskOriginal(...args);
  };
  try {
    const pending = f.call('ui_board_delete_task', deleteTask(team.id, task.id, task.revision, 'delete-after'));
    await deleteEntered.promise;
    const newAction = await f.rejected('subagent_integration', { action: 'status', ownerId: OWNER, teamId: team.id, attemptId });
    assert.equal(newAction?.code, 'board_deleting', 'a new entry still refuses while the deletion holds its fence');
    deleteGate.resolve();
    assert.equal((await pending).kind, 'task_deleted');
  } finally {
    try { deleteGate.resolve(); } catch { /* already released */ }
    deleting.deleteTask = deleteTaskOriginal;
  }
});

test('a live runner lease blocks task and team deletion until the approval settles', async t => {
  const f = await fixture(t, { views: true, resources: true, allowShell: true, runners: { enabled: true } });
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Runner team', description: '' });
  // workspace-write is required for run_command to reach the runner at all.
  const worker = await f.call('subagent_spawn', { ownerId: OWNER, requestId: 'w', task: 'idle', model: model.id, permission: 'workspace-write' });
  await f.stopped(worker.id);
  const joined = await f.call('subagent_team_update', { ownerId: OWNER, requestId: 'join', teamId: team.id, expectedRevision: team.revision, addMembers: [worker.id] });
  const snapshot = await f.call('subagent_snapshot_create', { ownerId: OWNER, teamId: joined.id, requestId: 'snap' });
  await f.call('subagent_view_bind', { ownerId: OWNER, teamId: joined.id, requestId: 'bind', id: worker.id, snapshotId: snapshot.id });
  // The deleted task is UNASSIGNED, so only the runner lease can refuse it.
  const task = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'task', teamId: joined.id, title: 'Runner task', description: '' });

  f.state.approvalGate = deferred();
  f.state.approvalEntered = deferred();
  f.state.actions = [{ type: 'call', id: 'run', name: 'run_command', input: { command: 'node script.cjs', path: '.' } }];
  const turn = f.call('subagent_send', { ownerId: OWNER, id: worker.id, requestId: 'run', message: 'run it' });
  // Bounded, observable proof that the approval prompt really is held.
  await until(() => f.state.approvals.length === 1, 20_000);
  const leases = () => f.local.isolation.runners.status().pool.leases.filter(lease => lease.owner.teamId === joined.id && lease.state !== 'released');
  await until(() => leases().length === 1);
  const leased = leases()[0];
  assert.ok(leased.leaseId);

  const blockedTask = await f.rejected('ui_board_delete_task', deleteTask(joined.id, task.id, task.revision));
  assert.equal(blockedTask?.code, 'runner_busy');
  assert.match(blockedTask.message, new RegExp(leased.leaseId));
  assert.equal((await f.call('subagent_task_get', { ownerId: OWNER, id: task.id })).revision, task.revision, 'the board is unchanged');

  // Deny the approval: the command records a denial, releases its lease and the
  // turn ends without running any process.
  f.state.approved = false;
  f.state.approvalGate.resolve();
  await turn;
  await f.stopped(worker.id);
  await until(() => leases().length === 0);
  assert.equal(f.state.approvals.length, 1, 'no command was started; the approval was denied');

  assert.equal((await f.call('ui_board_delete_task', deleteTask(joined.id, task.id, task.revision))).kind, 'task_deleted');
  const current = await f.call('subagent_team_get', { ownerId: OWNER, id: joined.id });
  assert.equal((await f.call('ui_board_delete_team', deleteTeam(joined.id, current.revision))).kind, 'team_deleted');
});

test('preparation derives the owner, revision and epoch-correct request id without writing', async t => {
  const f = await fixture(t);
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Prepare team', description: '' });
  const task = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'task', teamId: team.id, title: 'Prepare task', description: '' });
  const before = await fs.readFile(path.join(f.directory, 'task-board.json'), 'utf8');

  const prepared = await f.call('ui_board_delete_prepare', { kind: 'task', teamId: team.id, taskId: task.id, requestId: 'ui-seed' });
  assert.deepEqual(prepared, { kind: 'task', teamId: team.id, taskId: task.id, title: 'Prepare task', revision: task.revision, requestId: 'ui-seed' });
  // Strict: no actor, no extra field, no mismatched kind.
  assert.equal((await f.rejected('ui_board_delete_prepare', { kind: 'task', teamId: team.id, taskId: task.id, requestId: 'ui-seed', ownerId: OWNER }))?.code, 'invalid_arguments');
  assert.equal((await f.rejected('ui_board_delete_prepare', { kind: 'team', teamId: team.id, taskId: task.id, requestId: 'ui-seed' }))?.code, 'invalid_arguments');
  assert.equal((await f.rejected('ui_board_delete_prepare', { kind: 'task', teamId: team.id, requestId: 'ui-seed' }))?.code, 'invalid_arguments');
  assert.equal(await fs.readFile(path.join(f.directory, 'task-board.json'), 'utf8'), before, 'preparation wrote nothing');

  // The UI submits the returned input unchanged.
  assert.equal((await f.call('ui_board_delete_task', { teamId: prepared.teamId, taskId: prepared.taskId, expectedRevision: prepared.revision, requestId: prepared.requestId })).kind, 'task_deleted');

  // After an owner rollover the SAME seed prepares an epoch-prefixed id, and the
  // unprefixed form is refused rather than reinterpreted as a fresh delete.
  const board = await f.local.board.open();
  await board.rolloverReceipts(OWNER, 0);
  const next = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'e1:task-2', teamId: team.id, title: 'After rollover', description: '' });
  const afterPrepare = await f.call('ui_board_delete_prepare', { kind: 'task', teamId: team.id, taskId: next.id, requestId: 'ui-seed-2' });
  assert.equal(afterPrepare.requestId, 'e1:ui-seed-2');
  assert.equal(afterPrepare.revision, next.revision);
  assert.equal((await f.rejected('ui_board_delete_task', { requestId: 'ui-seed-2', teamId: team.id, taskId: next.id, expectedRevision: next.revision }))?.code, 'request_expired');
  assert.equal((await f.call('ui_board_delete_task', { teamId: afterPrepare.teamId, taskId: afterPrepare.taskId, expectedRevision: afterPrepare.revision, requestId: afterPrepare.requestId })).kind, 'task_deleted');

  // A revision changed between preparation and confirmation is refused, and the
  // mutated record survives.
  const late = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'e1:task-3', teamId: team.id, title: 'Stale prepare', description: '' });
  const stale = await f.call('ui_board_delete_prepare', { kind: 'task', teamId: team.id, taskId: late.id, requestId: 'ui-seed-3' });
  await f.call('subagent_task_update', { ownerId: OWNER, requestId: 'e1:retitle', taskId: late.id, expectedRevision: late.revision, title: 'Retitled' });
  assert.equal((await f.rejected('ui_board_delete_task', { teamId: stale.teamId, taskId: stale.taskId, expectedRevision: stale.revision, requestId: stale.requestId }))?.code, 'revision_conflict');
  assert.equal((await f.call('subagent_task_get', { ownerId: OWNER, id: late.id })).title, 'Retitled');
});

test('a restart drops every deleted record, and replaying an old create never restores it', async t => {
  const f = await fixture(t);
  const { team, task } = await seed(f);
  assert.equal((await f.call('ui_board_delete_task', deleteTask(team.id, task.id, task.revision))).kind, 'task_deleted');

  await f.restart();
  assert.equal((await f.rejected('subagent_task_get', { ownerId: OWNER, id: task.id }))?.code, 'not_found');
  assert.deepEqual((await f.call('subagent_task_list', { ownerId: OWNER })).tasks, []);
  const snapshot = await f.call('ui_board_snapshot', {});
  assert.deepEqual(snapshot.tasks, [], 'the host snapshot has no hidden task row');
  assert.equal(snapshot.teams.length, 1);

  // An exact retry of the OLD create answers its original receipt, and that
  // history restores nothing: no hidden record, no resurrection.
  const replay = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'seed-task', teamId: team.id, title: 'Seeded task', description: '' });
  assert.equal(replay.id, task.id);
  assert.deepEqual((await f.call('subagent_task_list', { ownerId: OWNER })).tasks, []);
  assert.deepEqual((await f.call('ui_board_snapshot', {})).tasks, []);
  assert.equal((await f.rejected('subagent_task_get', { ownerId: OWNER, id: task.id }))?.code, 'not_found');

  // The team goes the same way, and the idempotent delete retry still answers.
  const current = await f.call('subagent_team_get', { ownerId: OWNER, id: team.id });
  const input = deleteTeam(team.id, current.revision);
  const ack = await f.call('ui_board_delete_team', input);
  await f.restart();
  assert.deepEqual(await f.call('ui_board_delete_team', input), ack, 'the durable acknowledgment answers an exact retry after a restart');
  assert.equal((await f.rejected('subagent_team_get', { ownerId: OWNER, id: team.id }))?.code, 'not_found');
  assert.deepEqual((await f.call('subagent_team_list', { ownerId: OWNER })).teams, []);
  assert.deepEqual((await f.call('ui_board_snapshot', {})).teams, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'task-board.json'), 'utf8')).teams, []);
});

test('a board-only workspace deletes with no view storage; a stray integration namespace refuses instead', async t => {
  const f = await fixture(t);
  const { team, task } = await seed(f);
  assert.equal((await f.call('ui_board_delete_task', deleteTask(team.id, task.id, task.revision))).kind, 'task_deleted');

  // A present integration namespace while integration is disabled cannot be
  // proven safe, so the team delete fails closed without creating or deleting
  // anything integration-owned.
  const integration = path.join(f.directory, 'integration');
  await fs.mkdir(integration, { recursive: true });
  const blocked = await f.rejected('ui_board_delete_team', deleteTeam(team.id, team.revision));
  assert.equal(blocked?.code, 'feature_disabled');
  assert.match(blocked.message, /no attempt or pin is released automatically/);
  assert.deepEqual(await fs.readdir(integration), [], 'no attempt ledger was bootstrapped by the inspection');
  assert.equal((await f.call('subagent_team_get', { ownerId: OWNER, id: team.id })).id, team.id);

  await fs.rmdir(integration);
  assert.equal((await f.call('ui_board_delete_team', deleteTeam(team.id, team.revision))).kind, 'team_deleted');
  // No runner or view namespace is bootstrapped by a deletion inspection either.
  await assert.rejects(fs.access(path.join(f.directory, 'runners')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.directory, 'isolated-views')), { code: 'ENOENT' });
});

test('a corrupt integration ledger refuses the delete and preserves the board record', async t => {
  const f = await fixture(t, { views: true, integration: true });
  const { team, task } = await seed(f);
  assert.equal((await f.call('ui_board_delete_task', deleteTask(team.id, task.id, task.revision))).kind, 'task_deleted');
  const integration = path.join(f.directory, 'integration');
  await fs.mkdir(integration, { recursive: true });
  await fs.writeFile(path.join(integration, 'integration-attempts.namespace.json'), '{"schema":1,"kind":"integration-attempts"}');
  const corrupt = '{"schema":1,"attempts":[{"broken":true}]}';
  await fs.writeFile(path.join(integration, 'integration-attempts.json'), corrupt);

  const blocked = await f.rejected('ui_board_delete_team', deleteTeam(team.id, team.revision));
  assert.equal(blocked?.code, 'integration_corrupt');
  assert.equal((await f.call('subagent_team_get', { ownerId: OWNER, id: team.id })).id, team.id, 'the record is preserved');
  assert.equal(await fs.readFile(path.join(integration, 'integration-attempts.json'), 'utf8'), corrupt,
    'the unreadable ledger was neither rewritten nor removed');
});

test('a dependent task blocks deletion through the route with its id and title preview', async t => {
  const f = await fixture(t);
  const team = await f.call('subagent_team_create', { ownerId: OWNER, requestId: 'team', name: 'Deps', description: '' });
  const provider = await f.call('subagent_task_create', { ownerId: OWNER, requestId: 'provider', teamId: team.id, title: 'Provider', description: '' });
  const dependent = await f.call('subagent_task_create', {
    ownerId: OWNER, requestId: 'dependent', teamId: team.id, title: 'Dependent consumer', description: '',
    dependencies: [{ taskId: provider.id, kind: 'artifact' }]
  });
  const blocked = await f.rejected('ui_board_delete_task', deleteTask(team.id, provider.id, provider.revision));
  assert.equal(blocked?.code, 'task_has_dependents');
  assert.match(blocked.message, new RegExp(dependent.id));
  assert.match(blocked.message, /Dependent consumer/);
  const teamBlocked = await f.rejected('ui_board_delete_team', deleteTeam(team.id, team.revision));
  assert.equal(teamBlocked?.code, 'team_has_tasks');
  assert.match(teamBlocked.message, new RegExp(provider.id));
});
