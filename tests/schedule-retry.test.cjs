// Schedule-wait retry contract: an opaque, persisted wait generation plus an
// optimistic compare-and-set for both set and wake. See
// docs/resource-governance.md. Run with CODEX_TEST_BUILD pointing at a build
// that contains the changes; the shared .test-build belongs to its owner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { governedSchemas, scheduleWaitSchema, sameWait, waitDecision, waitRevision } = require(path.join(buildDir, 'worker-startup'));
const { WorkerBroker, unpack } = require(path.join(buildDir, 'runtime'));
const { defaults } = require(path.join(buildDir, 'engine'));
const { resourceDefaults } = require(path.join(buildDir, 'resource-governor'));

const model = { id: 'byok/qwen', name: 'Qwen', vendor: 'test', family: 'qwen', version: '1', maxInputTokens: 100_000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) { throw new Error('Condition timed out'); }
    await sleep(10);
  }
}
const zodRejection = error => error?.name === 'ZodError';
const conflict = promise => promise.then(() => undefined, error => error);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-retry-'));
  const root = path.join(dir, 'project');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'a.txt'), 'snapshot');
  const state = { config: { ...resourceDefaults, enabled: true }, errors: [], requests: [] };
  const provider = { models: async () => [model], countTokens: async () => 10,
    async *stream(selected, messages, tools) { state.requests.push({ selected, messages, tools }); yield { type: 'text', text: 'done' }; }
  };
  const options = { storage: path.join(dir, 'storage'), registry: path.join(dir, 'bridges'), roots: [root], identity: 'test', provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { numSessions: 4 } } }),
    taskBoardEnabled: () => true, isolatedViewsEnabled: () => true, resources: () => state.config,
    resourceDirectory: path.join(dir, 'resources'), runners: () => ({ enabled: true, capacity: 1, maxQueue: 8 }),
    files: { canWrite: () => true, allowShell: () => true, approveCommand: async () => true },
    onChange: () => {}, onError: message => { state.errors.push(message); }
  };
  let broker = new WorkerBroker(options);
  await broker.start();
  const f = { dir, root, state, options,
    get broker() { return broker; },
    get local() { return broker.local.get(root); },
    call: async (name, args = {}) => unpack(await broker.invoke(root, name, args)),
    reload: async () => { await broker.close(); broker = new WorkerBroker(options); await broker.start(); },
    stopped: async id => {
      await until(() => !['queued', 'running'].includes(broker.local.get(root).store.get(id).state) && !broker.local.get(root).engine.active.has(id));
      return broker.local.get(root).store.get(id);
    }
  };
  t.after(async () => { await broker.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const team = await f.call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  const snapshot = await f.call('subagent_snapshot_create', { ownerId: 'parent', teamId: team.id, requestId: 'snapshot' });
  /** Spawn one governed worker and let its first turn stop, so waits are the only moving part. */
  f.worker = async requestId => {
    const current = await f.call('subagent_team_get', { ownerId: 'parent', id: team.id });
    const task = await f.call('subagent_task_create', { ownerId: 'parent', requestId: 'task-' + requestId, teamId: current.id, title: requestId, description: '' });
    const worker = await f.call('subagent_isolated_spawn', { ownerId: 'parent', requestId, task: requestId, model: model.id, permission: 'workspace-write',
      setup: { teamId: current.id, taskId: task.id, snapshotId: snapshot.id, teamRevision: current.revision, taskRevision: task.revision, lane: 'work' } });
    await f.stopped(worker.id);
    return worker.id;
  };
  /** Set (wait) or wake (null) at an observed generation. */
  f.schedule = (id, expectedWaitRevision, wait) => f.call('subagent_schedule', { ownerId: 'parent', id, wait, expectedWaitRevision });
  return f;
}

test('wait keys stay opaque and the generation has one pure decision', () => {
  assert.equal(waitRevision({}), 0);
  assert.equal(waitRevision({ scheduleWaitRevision: 7 }), 7);
  assert.equal(sameWait(undefined, null), true, 'no wait and an explicit wake are the same state');
  assert.equal(sameWait({ kind: 'message', key: 'continue' }, { kind: 'message', key: 'continue' }), true);
  assert.equal(sameWait({ kind: 'message', key: 'e2:req' }, { kind: 'message', key: 'e2:REQ' }), false);
  assert.equal(sameWait({ kind: 'message', key: '{}' }, { kind: 'message', key: '{} ' }), false);
  assert.equal(sameWait({ kind: 'message', key: 'continue' }, null), false);
  assert.equal(scheduleWaitSchema.parse({ kind: 'message', key: 'e2:../../continue' }).key, 'e2:../../continue',
    'the key is stored literally: no epoch, path or JSON interpretation');

  const a = { kind: 'message', key: 'a' }, b = { kind: 'message', key: 'b' }, held = { scheduleWait: a, scheduleWaitRevision: 1 };
  assert.equal(waitDecision({}, 0, a), 'apply', 'the first set applies at generation 0');
  assert.equal(waitDecision(held, 0, a), 'replay', 'exact retry of 0->1 is a no-op');
  assert.equal(waitDecision(held, 1, a), 'replay', 'same value at the current generation is a no-op');
  assert.equal(waitDecision(held, 1, b), 'apply');
  assert.equal(waitDecision(held, 1, null), 'apply', 'a wake at the current generation applies');
  assert.equal(waitDecision({ scheduleWait: b, scheduleWaitRevision: 2 }, 1, a), 'conflict', 'a different value at an applied generation conflicts');
  assert.equal(waitDecision({ scheduleWait: undefined, scheduleWaitRevision: 2 }, 1, a), 'conflict', 'a stale set cannot resurrect a wait after a wake');
  assert.equal(waitDecision({ scheduleWait: a, scheduleWaitRevision: 3 }, 2, null), 'conflict', 'a retried wake cannot clear a newer wait');
  assert.equal(waitDecision(held, 5, a), 'conflict', 'a generation this host never issued conflicts');
});

test('expectedWaitRevision is required, safe-integer bounded and strict', () => {
  const id = 'a'.repeat(32);
  const schedule = governedSchemas.subagent_schedule;
  assert.equal(schedule.parse({ id, ownerId: 'parent', wait: null, expectedWaitRevision: 0 }).expectedWaitRevision, 0);
  assert.equal(schedule.parse({ id, ownerId: 'parent', wait: { kind: 'message', key: 'k' }, expectedWaitRevision: 3 }).expectedWaitRevision, 3);
  assert.throws(() => schedule.parse({ id, ownerId: 'parent', wait: null }), zodRejection, 'the observation is required for set and wake');
  assert.throws(() => schedule.parse({ id, ownerId: 'parent', wait: null, expectedWaitRevision: -1 }), zodRejection);
  assert.throws(() => schedule.parse({ id, ownerId: 'parent', wait: null, expectedWaitRevision: 1.5 }), zodRejection);
  assert.throws(() => schedule.parse({ id, ownerId: 'parent', wait: null, expectedWaitRevision: '1' }), zodRejection);
  assert.throws(() => schedule.parse({ id, ownerId: 'parent', wait: null, expectedWaitRevision: Number.MAX_SAFE_INTEGER + 1 }), zodRejection,
    'unsafe integers cannot be observed or echoed');
  assert.equal(schedule.parse({ id, ownerId: 'parent', wait: null, expectedWaitRevision: Number.MAX_SAFE_INTEGER }).expectedWaitRevision,
    Number.MAX_SAFE_INTEGER);
  assert.throws(() => schedule.parse({ id, ownerId: 'parent', wait: null, expectedWaitRevision: 0, unknownField: 1 }), zodRejection,
    'unknown fields stay rejected');
});

test('the generation is exposed for governed workers, durable across reload and hidden from legacy views', async t => {
  const f = await fixture(t);
  const id = await f.worker('generation-persists');
  const legacy = await f.call('subagent_spawn', { ownerId: 'legacy', requestId: 'legacy-shape', task: 'legacy', model: model.id });
  await f.stopped(legacy.id);

  const grown = await f.schedule(id, 0, { kind: 'message', key: 'e2:opaque' });
  assert.equal(grown.scheduleWaitRevision, 1);
  assert.deepEqual(grown.scheduleWait, { kind: 'message', key: 'e2:opaque' });
  assert.equal((await f.call('subagent_status', { id })).scheduleWaitRevision, 1);

  const legacyView = await f.call('subagent_status', { id: legacy.id });
  assert.equal(Object.hasOwn(legacyView, 'scheduleWaitRevision'), false, 'ordinary legacy responses keep their shape');
  assert.equal(legacyView.state, 'completed');
  assert.equal(legacyView.startup, undefined);

  await f.reload();
  const stored = f.local.store.get(id);
  assert.equal(stored.scheduleWaitRevision, 1, 'the generation is durable, not recomputed from the wait value');
  assert.deepEqual(stored.scheduleWait, { kind: 'message', key: 'e2:opaque' });
  assert.equal((await f.call('subagent_status', { id })).scheduleWaitRevision, 1);
});

test('a set or wake applies only at the observed wait generation', async t => {
  const f = await fixture(t);
  const id = await f.worker('generation-cas');
  const before = f.local.store.get(id);

  const first = await f.schedule(id, 0, { kind: 'message', key: 'a' });
  assert.equal(first.scheduleWaitRevision, 1);
  assert.deepEqual(first.scheduleWait, { kind: 'message', key: 'a' });
  assert.equal(f.local.store.get(id).revision, before.revision + 1, 'one applied mutation is one checkpoint');

  const replay = await f.schedule(id, 0, { kind: 'message', key: 'a' });
  assert.equal(replay.scheduleWaitRevision, 1, 'an exact retry of the applied mutation replays');
  assert.equal(f.local.store.get(id).revision, before.revision + 1, 'a replay writes nothing');

  const sameValue = await f.schedule(id, 1, { kind: 'message', key: 'a' });
  assert.equal(sameValue.scheduleWaitRevision, 1, 'the same wait at the current generation is a no-op');

  const newer = await f.schedule(id, 1, { kind: 'message', key: 'b' });
  assert.equal(newer.scheduleWaitRevision, 2);

  const resurrect = await conflict(f.schedule(id, 1, { kind: 'message', key: 'a' }));
  assert.equal(resurrect.code, 'revision_conflict');
  assert.equal(resurrect.retryable, true);
  assert.deepEqual(f.local.store.get(id).scheduleWait, { kind: 'message', key: 'b' }, 'the newer wait is not erased by a stale set');

  assert.equal((await conflict(f.schedule(id, 1, null))).code, 'revision_conflict', 'a stale wake cannot clear a newer wait');
  assert.deepEqual(f.local.store.get(id).scheduleWait, { kind: 'message', key: 'b' });

  assert.equal((await conflict(f.schedule(id, 4, { kind: 'message', key: 'b' }))).code, 'revision_conflict', 'a future generation conflicts');

  const wake = await f.schedule(id, 2, null);
  assert.equal(wake.scheduleWaitRevision, 3);
  assert.equal(wake.scheduleWait, undefined);
  const wakeReplay = await f.schedule(id, 3, null);
  assert.equal(wakeReplay.scheduleWaitRevision, 3, 'a retried wake replays without advancing the generation');
  assert.equal((await f.schedule(id, 2, null)).scheduleWaitRevision, 3, 'the exact wake retry is also a no-op');

  assert.equal((await conflict(f.schedule(id, 2, { kind: 'message', key: 'a' }))).code, 'revision_conflict', 'a stale set cannot resurrect an older wait');
  assert.equal(f.local.store.get(id).scheduleWait, undefined);

  const afterWake = await f.schedule(id, 3, { kind: 'message', key: 'a' });
  assert.equal(afterWake.scheduleWaitRevision, 4, 'the generation never resets across wakes');
  await f.reload();
  assert.equal((await conflict(f.schedule(id, 0, null))).code, 'revision_conflict', 'the durable generation still fences stale retries after reload');
  assert.deepEqual(f.local.store.get(id).scheduleWait, { kind: 'message', key: 'a' });
  assert.equal(f.state.requests.length, 1, 'scheduling never starts inference');
  assert.equal(f.local.store.get(id).turns.length, before.turns.length, 'history is preserved');
  assert.equal(f.local.store.get(id).messages.length, before.messages.length);
});

test('concurrent identical retries commit once and concurrent variants keep one winner', async t => {
  const f = await fixture(t);
  const id = await f.worker('generation-concurrent');
  const before = f.local.store.get(id).revision;
  const identical = await Promise.all(Array.from({ length: 6 }, () => f.schedule(id, 0, { kind: 'message', key: 'same' })));
  for (const result of identical) {
    assert.equal(result.scheduleWaitRevision, 1);
    assert.deepEqual(result.scheduleWait, { kind: 'message', key: 'same' });
  }
  assert.equal(f.local.store.get(id).revision, before + 1, 'six identical retries share one checkpoint');

  const variants = await Promise.all(Array.from({ length: 6 }, (_, index) => conflict(f.schedule(id, 1, { kind: 'message', key: 'v' + index }))));
  const applied = variants.filter(result => result === undefined);
  const refused = variants.filter(result => result !== undefined);
  assert.equal(applied.length, 1, 'exactly one variant applies at the observed generation');
  assert.equal(refused.length, 5);
  for (const refusal of refused) {
    assert.equal(refusal.code, 'revision_conflict');
  }
  const settled = f.local.store.get(id);
  assert.equal(settled.scheduleWaitRevision, 2);
  assert.ok(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'].includes(settled.scheduleWait.key), 'the committed wait is a real variant');
  assert.equal(f.state.requests.length, 1);
});

test('the last safe generation refuses to advance instead of losing precision', async t => {
  const f = await fixture(t);
  const id = await f.worker('generation-capacity');
  await f.local.store.change(id, draft => { draft.scheduleWaitRevision = Number.MAX_SAFE_INTEGER; });
  const exhausted = await conflict(f.schedule(id, Number.MAX_SAFE_INTEGER, { kind: 'message', key: 'overflow' }));
  assert.equal(exhausted.code, 'wait_revision_exhausted');
  assert.equal(exhausted.retryable, false);
  assert.equal(f.local.store.get(id).scheduleWaitRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(f.local.store.get(id).scheduleWait, undefined, 'no wait is written at the capacity limit');
});
