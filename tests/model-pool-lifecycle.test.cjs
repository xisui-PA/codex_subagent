const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, deferred, until, finished } = require('./helpers.cjs');
const { defaults } = require('../.test-build/engine');
const { parseModelSettings } = require('../.test-build/model-settings');
const { WorkerError } = require('../.test-build/types');

const fake = id => ({ id, name: id, vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 });
const writeTool = { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } };
const writing = {
  definitions: () => [writeTool],
  execute: async () => 'written'
};
const poolSettings = (pool, extra = {}) => () => ({
  ...defaults, autoCompact: false, retries: 0, ...extra, models: parseModelSettings(pool)
});
const operationEntries = session => Object.values(session.operations);
const textParts = (message, text) => message.parts.some(part => part.type === 'text' && part.text === text);

test('completed worker with a removed pool model requires an explicit target and migrates without replaying work', async t => {
  const oldModel = fake('mig/old');
  const newModel = fake('mig/new');
  const pool = { 'mig/old': { allowWrite: true } };
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [oldModel, newModel] }
  });

  const worker = await engine.spawn({ requestId: 'migrate', task: 'Original task text', permission: 'read-only' });
  assert.equal((await finished(engine, worker.id)).state, 'completed');
  const before = engine.store.get(worker.id);
  assert.equal(before.model.id, 'mig/old');
  assert.equal(requests.length, 1);

  // Simulate the policy edit that blocked the completed worker.
  delete pool['mig/old'];
  pool['mig/new'] = { allowWrite: true };

  await assert.rejects(engine.resume(worker.id, 'no-target'), error => error.code === 'not_resumable' && /completed/.test(error.message));
  await assert.rejects(engine.resume(worker.id, 'ghost-target', 'ghost/model'), { code: 'model_unavailable' });
  assert.equal(engine.store.get(worker.id).model.id, 'mig/old');

  // No message: model migration only, no inference, no history change.
  const migrated = await engine.resume(worker.id, 'switch-only', 'mig/new');
  assert.equal(migrated.model.id, 'mig/new');
  assert.equal(migrated.state, 'completed');
  assert.deepEqual(migrated.turns.map(turn => turn.id), before.turns.map(turn => turn.id));
  assert.deepEqual(migrated.messages, before.messages);
  assert.equal(migrated.turns[0].state, 'completed');
  assert.equal(migrated.turns[0].output, 'done');
  assert.equal(requests.length, 1);
  assert.equal(operationEntries(migrated).length, operationEntries(before).length + 1);
  for (const operation of operationEntries(migrated)) {
    assert.equal(operation.turnId, before.turns.at(-1).id);
  }

  // Idempotent retry returns the migration record without another change.
  const retried = await engine.resume(worker.id, 'switch-only', 'mig/new');
  assert.equal(retried.model.id, 'mig/new');
  assert.equal(retried.state, 'completed');
  assert.equal(operationEntries(retried).length, operationEntries(migrated).length);
  assert.equal(requests.length, 1);

  // A message starts exactly one fresh follow-up turn on the target model.
  const followUp = await engine.resume(worker.id, 'follow-up', 'mig/new', 'Append the second line');
  assert.ok(['queued', 'running', 'completed'].includes(followUp.state));
  const done = await finished(engine, worker.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.turns.length, 2);
  assert.equal(done.turns[0].id, before.turns[0].id);
  assert.equal(done.turns[0].state, 'completed');
  assert.equal(done.turns[0].output, 'done');
  assert.equal(done.turns[1].input, 'Append the second line');
  assert.equal(done.turns[1].state, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].model.id, 'mig/new');
  assert.equal(operationEntries(done).length, operationEntries(migrated).length + 1);
  assert.ok(operationEntries(done).some(operation => operation.turnId === done.turns[1].id));
  // The completed task was never replayed into the conversation.
  assert.equal(done.messages.filter(message => textParts(message, 'Original task text')).length, 1);
  assert.equal(done.messages.filter(message => textParts(message, 'Append the second line')).length, 1);

  // Replaying the same requestId after completion changes nothing.
  const replay = await engine.resume(worker.id, 'follow-up', 'mig/new', 'Append the second line');
  assert.equal(replay.turns.length, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(operationEntries(replay).map(entry => entry.fingerprint), operationEntries(done).map(entry => entry.fingerprint));
});

test('recovery follow-up respects the normal turn limit', async t => {
  const oldModel = fake('lim/old');
  const newModel = fake('lim/new');
  const pool = { 'lim/old': { allowWrite: true } };
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool, { maxTurns: 1 }),
    tools: writing,
    provider: { models: async () => [oldModel, newModel] }
  });

  const worker = await engine.spawn({ requestId: 'limit', task: 'Limited task', permission: 'read-only' });
  assert.equal((await finished(engine, worker.id)).state, 'completed');
  delete pool['lim/old'];
  pool['lim/new'] = { allowWrite: true };
  const before = engine.store.get(worker.id);
  await assert.rejects(engine.resume(worker.id, 'too-many', 'lim/new', 'One more turn'), { code: 'turn_limit' });
  const unchanged = engine.store.get(worker.id);
  assert.equal(unchanged.turns.length, before.turns.length);
  assert.equal(unchanged.state, 'completed');
  assert.equal(unchanged.revision, before.revision);
  assert.equal(requests.length, 1);
});

test('failed workers keep the original resume path without an explicit model', async t => {
  const model = fake('lim/old');
  const pool = { 'lim/old': { allowWrite: true } };
  let fail = true;
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [model] },
    async *stream() {
      if (fail) {
        fail = false;
        throw new WorkerError('provider_error', 'provider failed');
      }
      yield { type: 'text', text: 'recovered' };
    }
  });

  const worker = await engine.spawn({ requestId: 'failed', task: 'Fail once', permission: 'read-only' });
  assert.equal((await finished(engine, worker.id)).state, 'failed');
  const resumed = await engine.resume(worker.id, 'resume-failed');
  assert.ok(['queued', 'running', 'completed'].includes(resumed.state));
  const recovered = await finished(engine, worker.id);
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.turns[0].output, 'recovered');
  assert.equal(requests.length, 2);
});

test('malformed model settings are reported and reschedule drains queued work after repair', async t => {
  const model = fake('cfg/m');
  const gate = deferred();
  t.after(() => gate.resolve());
  const pool = { 'cfg/m': { allowWrite: true, numSessions: 1 } };
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [model] },
    async *stream() {
      await gate.promise;
      yield { type: 'text', text: 'done' };
    }
  });
  const errors = [];
  const previous = engine.onError;
  engine.onError = (id, error) => errors.push([id, error]);
  t.after(() => { engine.onError = previous; });

  const first = await engine.spawn({ requestId: 'cfg-1', task: 'First', permission: 'read-only' });
  await until(() => requests.length === 1);
  const second = await engine.spawn({ requestId: 'cfg-2', task: 'Second', permission: 'read-only' });
  assert.equal(engine.store.get(second.id).state, 'queued');

  // Strict settings throw from schedule; reschedule must swallow that into onError.
  pool['cfg/m'] = { bogus: true };
  assert.doesNotThrow(() => engine.reschedule());
  await until(() => errors.length === 1);
  assert.equal(errors[0][0], 'settings');
  assert.equal(errors[0][1].code, 'invalid_settings');
  assert.equal(engine.store.get(second.id).state, 'queued');
  // Reported once until the settings are valid again.
  engine.reschedule();
  assert.equal(errors.length, 1);

  // Repairing the pool alone does not bypass the busy slot.
  pool['cfg/m'] = { allowWrite: true, numSessions: 1 };
  engine.reschedule();
  assert.equal(engine.store.get(second.id).state, 'queued');
  assert.equal(requests.length, 1);

  // Capacity increase re-evaluates the queued job without any new spawn.
  pool['cfg/m'] = { allowWrite: true, numSessions: 2 };
  engine.reschedule();
  await until(() => requests.length === 2);
  assert.equal(engine.store.get(second.id).state, 'running');

  gate.resolve();
  assert.equal((await finished(engine, first.id)).state, 'completed');
  assert.equal((await finished(engine, second.id)).state, 'completed');
  assert.equal(engine.store.list().length, 2);
});

test('capacity increase alone re-evaluates queued jobs through reschedule', async t => {
  const model = fake('cap/m');
  const gate = deferred();
  t.after(() => gate.resolve());
  const pool = { 'cap/m': { allowWrite: true, numSessions: 1 } };
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [model] },
    async *stream() {
      await gate.promise;
      yield { type: 'text', text: 'done' };
    }
  });

  const first = await engine.spawn({ requestId: 'cap-1', task: 'First', permission: 'read-only' });
  await until(() => requests.length === 1);
  const second = await engine.spawn({ requestId: 'cap-2', task: 'Second', permission: 'read-only' });
  assert.equal(engine.store.get(second.id).state, 'queued');

  pool['cap/m'] = { allowWrite: true, numSessions: 2 };
  engine.reschedule();
  await until(() => requests.length === 2);

  gate.resolve();
  assert.equal((await finished(engine, first.id)).state, 'completed');
  assert.equal((await finished(engine, second.id)).state, 'completed');
  assert.equal(requests.length, 2);
});

test('automatic compaction rejects a model removed from a nonempty pool before mutating state', async t => {
  const model = fake('cmp/m');
  const pool = { 'cmp/m': { allowWrite: true } };
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [model] }
  });

  const worker = await engine.spawn({ requestId: 'compact', task: 'Compact me', permission: 'read-only' });
  assert.equal((await finished(engine, worker.id)).state, 'completed');
  const before = engine.store.get(worker.id);
  const streams = requests.length;
  delete pool['cmp/m'];
  pool['cmp/other'] = { allowWrite: true };

  const error = await engine.compact(worker.id, before.revision).catch(problem => problem);
  assert.equal(error.code, 'model_unavailable');
  assert.match(error.message, /manual summary/);
  const after = engine.store.get(worker.id);
  assert.equal(after.state, 'completed');
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.activity, before.activity);
  assert.equal(after.summary, undefined);
  assert.equal(requests.length, streams);

  // A supplied summary needs no provider and remains available for recovery.
  const archived = await engine.compact(worker.id, before.revision, 'Manual faithful summary');
  assert.equal(archived.summary.text, 'Manual faithful summary');
  assert.equal(archived.state, 'completed');
  assert.equal(archived.archives.length, 1);
  assert.equal(requests.length, streams);
});

test('automatic compaction of a writer does not require allowWrite and retains slot checks', async t => {
  const model = fake('cmp/w');
  const policy = { allowWrite: true, numSessions: 1 };
  const pool = { 'cmp/w': policy };
  const gate = deferred();
  t.after(() => gate.resolve());
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [model] },
    async *stream(selected, messages) {
      if (messages.some(message => message.parts.some(part => part.type === 'text' && part.text.includes('Produce a concise continuation summary')))) {
        yield { type: 'text', text: 'summary text' };
        return;
      }
      if (messages.some(message => textParts(message, 'Busy writer'))) {
        await gate.promise;
      }
      yield { type: 'text', text: 'done' };
    }
  });

  const idle = await engine.spawn({ requestId: 'compact-idle', task: 'Idle writer', permission: 'workspace-write' });
  assert.equal((await finished(engine, idle.id)).state, 'completed');

  // Revoking allowWrite must not block a summarizer that receives no tools.
  policy.allowWrite = false;
  const busy = await engine.spawn({ requestId: 'compact-busy', task: 'Busy writer', permission: 'read-only' });
  await until(() => requests.length === 2);
  assert.equal(engine.store.get(busy.id).state, 'running');

  const blocked = await engine.compact(idle.id, engine.store.get(idle.id).revision).catch(problem => problem);
  assert.equal(blocked.code, 'worker_busy');
  assert.match(blocked.message, /All worker slots are busy/);

  gate.resolve();
  assert.equal((await finished(engine, busy.id)).state, 'completed');

  await engine.compact(idle.id, engine.store.get(idle.id).revision);
  await until(() => {
    const current = engine.store.get(idle.id);
    return current.summary?.text === 'summary text' && current.state === 'completed';
  });
  assert.ok(requests.some(request => request.tools.length === 0 && request.model.id === 'cmp/w'));
  const compacted = engine.store.get(idle.id);
  assert.equal(compacted.maintenanceError, undefined);
  assert.equal(compacted.archives.length, 1);
});

test('tool authorization callback is forwarded and re-evaluates the live pool policy', async t => {
  const model = fake('au/m');
  const policy = { allowWrite: true };
  const pool = { 'au/m': policy };
  let authorize;
  let authorizeError;
  const { engine } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: {
      definitions: () => [writeTool],
      execute: async (name, input, permission, signal, session, check) => {
        authorize = check;
        policy.allowWrite = false;
        try {
          check();
        } catch (error) {
          authorizeError = error;
        }
        return 'written';
      }
    },
    provider: { models: async () => [model] },
    async *stream(selected, messages) {
      if (!messages.some(message => message.parts.some(part => part.type === 'result'))) {
        yield { type: 'call', id: 'c1', name: 'write_file', input: { path: 'out.txt', content: 'x', expectedHash: 'new' } };
      } else {
        yield { type: 'text', text: 'done' };
      }
    }
  });

  const worker = await engine.spawn({ requestId: 'authorize', task: 'Write out.txt', permission: 'workspace-write' });
  assert.equal((await finished(engine, worker.id)).state, 'completed');
  assert.equal(typeof authorize, 'function');
  assert.equal(authorizeError?.code, 'permission_denied');
  assert.match(authorizeError.message, /no longer allows workspace-write/);
  assert.equal(engine.store.get(worker.id).turns[0].tools[0].result, 'written');
});

test('idle stranded queue after a malformed save drains on reschedule with no unrelated spawn', async t => {
  const model = fake('str/m');
  const gate = deferred();
  t.after(() => gate.resolve());
  const pool = { 'str/m': { allowWrite: true, numSessions: 1 } };
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [model] },
    async *stream(selected, messages) {
      const sawResult = messages.some(message => message.parts.some(part => part.type === 'result'));
      if (!sawResult) {
        if (messages.some(message => textParts(message, 'Active task'))) {
          await gate.promise;
        }
        yield { type: 'call', id: 'c1', name: 'write_file', input: { path: 'out.txt', content: 'x', expectedHash: 'new' } };
        return;
      }
      yield { type: 'text', text: 'done' };
    }
  });
  const errors = [];
  const previous = engine.onError;
  engine.onError = (id, error) => errors.push([id, error]);
  t.after(() => { engine.onError = previous; });

  // Exactly one gated active worker and one queued behind it at capacity 1.
  const active = await engine.spawn({ requestId: 'str-active', task: 'Active task', permission: 'read-only' });
  await until(() => requests.length === 1);
  const queued = await engine.spawn({ requestId: 'str-queued', task: 'Queued task', permission: 'read-only' });
  assert.equal(engine.store.get(queued.id).state, 'queued');
  assert.equal(engine.active.size, 1);

  // The user saves a malformed pool, then the active turn is released.
  pool['str/m'] = { bogus: true };
  gate.resolve();

  // The active worker drains into a failure (its next settings read is strict)
  // and the queued worker is left stranded with nothing active.
  assert.equal((await finished(engine, active.id)).state, 'failed');
  assert.equal(engine.store.get(active.id).turns[0].error?.code, 'invalid_settings');
  await until(() => engine.active.size === 0);
  assert.equal(engine.store.get(queued.id).state, 'queued');
  assert.equal(requests.length, 1);
  await until(() => errors.length === 1);
  assert.equal(errors[0][0], 'settings');
  assert.equal(errors[0][1].code, 'invalid_settings');

  // Further reschedules during the invalid period report once and schedule nothing.
  assert.doesNotThrow(() => engine.reschedule());
  assert.equal(errors.length, 1);
  assert.equal(engine.active.size, 0);
  assert.equal(engine.store.get(queued.id).state, 'queued');
  assert.equal(requests.length, 1);

  // Repairing the pool alone leaves the idle queue stranded until the event fires.
  pool['str/m'] = { allowWrite: true, numSessions: 1 };
  assert.equal(engine.store.get(queued.id).state, 'queued');
  assert.equal(engine.active.size, 0);

  // The config-change handler the UI wires is what resumes queued work.
  engine.reschedule();
  await until(() => requests.length === 2);
  assert.equal(engine.store.get(queued.id).state, 'running');

  const done = await finished(engine, queued.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.turns[0].output, 'done');
  assert.equal(requests.length, 3);
  // Only the two original workers exist; nothing else was spawned or sent.
  assert.equal(engine.store.list().length, 2);
  assert.deepEqual(engine.store.list().map(header => header.id).sort(), [active.id, queued.id].sort());
  assert.equal(done.turns.length, 1);
  assert.equal(errors.length, 1);
});

test('completed workspace-write worker blocked by revoked allowWrite migrates to a writable replacement', async t => {
  const oldModel = fake('wr/old');
  const frozen = fake('wr/frozen');
  const fresh = fake('wr/fresh');
  const pool = { 'wr/old': { allowWrite: true }, 'wr/frozen': { allowWrite: false } };
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [oldModel, frozen, fresh] }
  });

  const worker = await engine.spawn({ requestId: 'writer', task: 'Wrote a report', permission: 'workspace-write' });
  assert.equal((await finished(engine, worker.id)).state, 'completed');
  const before = engine.store.get(worker.id);
  assert.equal(before.model.id, 'wr/old');
  assert.equal(requests.length, 1);

  // The user revokes allowWrite for the completed worker's model.
  pool['wr/old'].allowWrite = false;
  await assert.rejects(engine.send(worker.id, 'blocked-send', 'More work'), { code: 'permission_denied' });
  assert.equal(engine.store.get(worker.id).turns.length, before.turns.length);
  assert.equal(engine.store.get(worker.id).model.id, 'wr/old');
  assert.equal(requests.length, 1);

  // A read-only replacement is not valid recovery for a workspace-write worker.
  await assert.rejects(engine.resume(worker.id, 'frozen-target', 'wr/frozen'), { code: 'permission_denied' });
  await assert.rejects(engine.resume(worker.id, 'old-target', 'wr/old'), { code: 'permission_denied' });
  assert.equal(engine.store.get(worker.id).model.id, 'wr/old');
  assert.equal(engine.store.get(worker.id).revision, before.revision);

  // A valid writable replacement migrates the completed worker in place.
  pool['wr/fresh'] = { allowWrite: true };
  const migrated = await engine.resume(worker.id, 'writer-switch', 'wr/fresh');
  assert.equal(migrated.model.id, 'wr/fresh');
  assert.equal(migrated.state, 'completed');
  assert.equal(migrated.permission, 'workspace-write');
  assert.deepEqual(migrated.turns.map(turn => turn.id), before.turns.map(turn => turn.id));
  assert.deepEqual(migrated.messages, before.messages);
  assert.equal(migrated.turns[0].output, 'done');
  assert.equal(requests.length, 1);
});

test('compaction settings failure at the running checkpoint restores the completed worker', async t => {
  const model = fake('cmp/race');
  const pool = { 'cmp/race': { allowWrite: true } };
  const summaryPrompt = 'Produce a concise continuation summary';
  const { engine, requests } = await fixture(t, {
    settingsFn: poolSettings(pool),
    tools: writing,
    provider: { models: async () => [model] },
    async *stream(selected, messages) {
      if (messages.some(message => message.parts.some(part => part.type === 'text' && part.text.includes(summaryPrompt)))) {
        yield { type: 'text', text: 'summary text' };
        return;
      }
      yield { type: 'text', text: 'done' };
    }
  });
  const errors = [];
  const previous = engine.onError;
  engine.onError = (id, error) => errors.push([id, error]);
  t.after(() => { engine.onError = previous; });

  const worker = await engine.spawn({ requestId: 'compact-race', task: 'Compaction race task', permission: 'read-only' });
  assert.equal((await finished(engine, worker.id)).state, 'completed');
  const before = engine.store.get(worker.id);
  assert.deepEqual(before.turns.map(turn => turn.state), ['completed']);
  const streams = requests.length;

  // Block compaction exactly at its durable running checkpoint, then publish a
  // malformed pool while the checkpoint awaits: the strict settings callback is
  // next read for the deadline timer, inside the background callback.
  const gate = deferred();
  const reached = deferred();
  let gated = false;
  const realChange = engine.store.change.bind(engine.store);
  engine.store.change = async (id, update) => {
    const changed = await realChange(id, update);
    if (!gated && changed.state === 'running' && changed.activity === 'Summarizing history') {
      gated = true; reached.resolve();
      await gate.promise;
    }
    return changed;
  };
  t.after(() => { gate.resolve(); engine.store.change = realChange; });

  const compaction = engine.compact(worker.id, before.revision);
  try {
    await reached.promise;
    assert.equal(engine.store.get(worker.id).state, 'running');
    pool['cmp/race'] = { turnTimeoutSeconds: 'not-a-number' };
  } finally {
    gate.resolve();
  }
  await compaction;
  engine.store.change = realChange;
  await until(() => engine.active.size === 0);

  const durable = engine.store.get(worker.id);
  const reported = engine.session(worker.id);
  assert.equal(durable.state, 'completed');
  assert.equal(reported.state, 'completed');
  assert.equal(durable.activity, 'Compaction stopped; history retained');
  assert.equal(durable.maintenanceError?.code, 'invalid_settings');
  assert.match(durable.maintenanceError.message, /turnTimeoutSeconds/);
  assert.equal(engine.runtimeErrors.size, 0);
  assert.deepEqual(errors.map(([id]) => id), ['settings']);
  assert.deepEqual(durable.turns.map(turn => turn.id), before.turns.map(turn => turn.id));
  assert.deepEqual(durable.turns.map(turn => turn.state), before.turns.map(turn => turn.state));
  assert.deepEqual(durable.messages, before.messages);
  assert.equal(durable.turns[0].output, 'done');
  assert.equal(durable.summary, undefined);
  assert.equal(durable.archives, undefined);
  // The summarizer never ran and nothing was archived.
  assert.equal(requests.length, streams);

  // Repairing the pool continues the same conversation: one fresh turn, no replay.
  pool['cmp/race'] = { allowWrite: true };
  const sent = await engine.send(worker.id, 'compact-race-follow-up', 'Continue the report');
  assert.ok(['queued', 'running', 'completed'].includes(sent.state));
  const done = await finished(engine, worker.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.turns.length, 2);
  assert.equal(done.turns[0].id, before.turns[0].id);
  assert.equal(done.turns[0].output, 'done');
  assert.equal(done.turns[1].input, 'Continue the report');
  assert.equal(done.turns[1].state, 'completed');
  assert.equal(requests.length, streams + 1);
  assert.equal(done.messages.filter(message => textParts(message, 'Compaction race task')).length, 1);
  assert.equal(done.messages.filter(message => textParts(message, 'Continue the report')).length, 1);
  assert.equal(done.summary, undefined);
  assert.equal(done.archives, undefined);
  assert.equal(engine.runtimeErrors.size, 0);
});
