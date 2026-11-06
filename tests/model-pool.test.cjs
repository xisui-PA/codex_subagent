const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, deferred, until, finished } = require('./helpers.cjs');

const fake = id => ({ id, name: id, vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 });
const A = fake('pool/a');
const B = fake('pool/b');
const C = fake('pool/c');
const models = {
  'pool/a': { allowWrite: false, numSessions: 1 },
  'pool/b': { allowWrite: true, numSessions: 1 },
  'pool/c': { allowWrite: true, numSessions: 2 },
};
const tools = {
  definitions: () => [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } }],
  execute: async () => 'written',
};
const spawn = (engine, requestId) => engine.spawn({ requestId, task: `Write ${requestId}`, permission: 'workspace-write' });

test('automatic pool allocation respects per-model sessions beyond the legacy global cap', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { engine, requests } = await fixture(t, {
    settings: { models },
    tools,
    provider: { models: async () => [A, B, C] },
    async *stream() { await gate.promise; yield { type: 'text', text: 'done' }; },
  });

  const writers = await Promise.all([spawn(engine, 'w1'), spawn(engine, 'w2'), spawn(engine, 'w3')]);
  assert.deepEqual(writers.map(s => s.model.id), ['pool/b', 'pool/c', 'pool/c']);

  // Legacy defaults cap concurrency at 2; the per-model pool must allow 1/1/2.
  await until(() => requests.length === 3);
  assert.equal(requests.filter(r => r.model.id === 'pool/b').length, 1);
  assert.equal(requests.filter(r => r.model.id === 'pool/c').length, 2);

  const fourth = await spawn(engine, 'w4');
  assert.equal(fourth.model.id, 'pool/b');
  assert.equal(engine.store.get(fourth.id).state, 'queued');
  assert.equal(requests.length, 3);

  gate.resolve();
  for (const worker of [...writers, fourth]) {
    assert.equal((await finished(engine, worker.id)).state, 'completed');
  }
  assert.equal(requests.length, 4);
});

test('explicit pool models pin exactly and enforce pool permissions/availability', async t => {
  const { engine } = await fixture(t, {
    settings: { models },
    tools,
    provider: { models: async () => [A, B, C] },
  });

  const reader = await engine.spawn({ requestId: 'reader-a', task: 'Read only', permission: 'read-only', model: 'pool/a' });
  assert.equal(reader.model.id, 'pool/a');
  assert.equal((await finished(engine, reader.id)).state, 'completed');

  await assert.rejects(
    engine.spawn({ requestId: 'writer-a', task: 'Write anyway', permission: 'workspace-write', model: 'pool/a' }),
    { code: 'permission_denied' }
  );
  await assert.rejects(
    engine.spawn({ requestId: 'unconfigured', task: 'Not in pool', permission: 'workspace-write', model: 'pool/d' }),
    { code: 'model_unavailable' }
  );
  await assert.rejects(
    engine.spawn({ requestId: 'unknown', task: 'Not exposed', permission: 'workspace-write', model: 'pool/zz' }),
    { code: 'model_unavailable' }
  );
  assert.equal(engine.store.list().length, 1);
});

test('idempotent spawn retries keep the same worker and allocated model', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { engine, requests } = await fixture(t, {
    settings: { models },
    tools,
    provider: { models: async () => [A, B, C] },
    async *stream() { await gate.promise; yield { type: 'text', text: 'done' }; },
  });

  const spawnOnce = () => engine.spawn({ requestId: 'stable', task: 'Write stably', permission: 'workspace-write' });
  const first = await spawnOnce();
  const retry = await spawnOnce();
  assert.equal(retry.id, first.id);
  assert.equal(retry.model.id, first.model.id);
  assert.equal(first.model.id, 'pool/b');
  await until(() => requests.length === 1);

  gate.resolve();
  assert.equal((await finished(engine, first.id)).state, 'completed');
  assert.equal(requests.length, 1);
});

test('configured but provider-unavailable models are skipped by allocation and rejected explicitly', async t => {
  const { engine } = await fixture(t, {
    settings: { models: { 'ghost/m': { allowWrite: true }, 'pool/b': { allowWrite: true, numSessions: 1 } } },
    tools,
    provider: { models: async () => [B] },
  });

  await assert.rejects(
    engine.spawn({ requestId: 'ghost', task: 'Use ghost', permission: 'workspace-write', model: 'ghost/m' }),
    { code: 'model_unavailable' }
  );
  const auto = await spawn(engine, 'auto-1');
  assert.equal(auto.model.id, 'pool/b');
  assert.equal((await finished(engine, auto.id)).state, 'completed');
});

test('allowShell:false hides run_command and blocks unsolicited calls', async t => {
  const sh = fake('sh/only');
  let executed = 0;
  const { engine, requests } = await fixture(t, {
    settings: { models: { 'sh/only': { allowShell: false } } },
    tools: {
      definitions: () => [
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
        { name: 'run_command', description: 'Run a command', inputSchema: { type: 'object' } }
      ],
      execute: async () => { executed++; return 'ok'; }
    },
    provider: { models: async () => [sh] },
    async *stream(selected, messages) {
      const sawResult = messages.some(m => m.parts.some(p => p.type === 'result'));
      if (!sawResult) {
        yield { type: 'call', id: 'c1', name: 'run_command', input: { command: 'echo hi' } };
      } else {
        yield { type: 'text', text: 'done' };
      }
    }
  });

  const worker = await engine.spawn({ requestId: 'sh', task: 'Try shell', permission: 'read-only' });
  assert.equal((await finished(engine, worker.id)).state, 'completed');
  assert.equal(executed, 0);
  assert.ok(requests.length >= 1);
  for (const request of requests) {
    assert.ok(!request.tools.some(tool => tool.name === 'run_command'));
    assert.ok(request.tools.some(tool => tool.name === 'read_file'));
  }
  const toolEntry = engine.store.get(worker.id).turns[0].tools[0];
  assert.equal(toolEntry.state, 'completed');
  assert.match(toolEntry.result, /"permission_denied"/);
});

test('per-model maxToolRounds enforces distinct limits', async t => {
  const rb = fake('round/b');
  const rc = fake('round/c');
  const rounds = {};
  const executed = [];
  const { engine } = await fixture(t, {
    settings: {
      models: {
        'round/b': { allowWrite: true, maxToolRounds: 1 },
        'round/c': { allowWrite: true, maxToolRounds: 3 }
      }
    },
    tools: {
      definitions: () => [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } }],
      execute: async name => { executed.push(name); return 'ok'; }
    },
    provider: { models: async () => [rb, rc] },
    async *stream(selected) {
      rounds[selected.id] = (rounds[selected.id] || 0) + 1;
      if (selected.id === 'round/c' && rounds[selected.id] >= 3) {
        yield { type: 'text', text: 'done' };
        return;
      }
      yield { type: 'call', id: `c${rounds[selected.id]}`, name: 'write_file', input: { path: `f${rounds[selected.id]}`, content: 'x', expectedHash: 'new' } };
    }
  });

  const wB = await engine.spawn({ requestId: 'rounds-b', task: 'Loop', permission: 'workspace-write', model: 'round/b' });
  const wC = await engine.spawn({ requestId: 'rounds-c', task: 'Loop', permission: 'workspace-write', model: 'round/c' });
  const b = await finished(engine, wB.id);
  const c = await finished(engine, wC.id);
  assert.equal(b.state, 'failed');
  assert.equal(b.turns[0].error?.code, 'tool_round_limit');
  assert.equal(c.state, 'completed');
  assert.equal(executed.length, 3);
  assert.equal(executed.every(name => name === 'write_file'), true);
  assert.equal(b.turns[0].tools.length, 1);
  assert.equal(c.turns[0].tools.length, 2);
});

test('busy model does not block a free model and cancelling releases the slot', async t => {
  const gateB = deferred();
  t.after(() => gateB.resolve());
  const { engine, requests } = await fixture(t, {
    settings: { models },
    tools,
    provider: { models: async () => [A, B, C] },
    async *stream(selected) {
      if (selected.id === 'pool/b') {
        await gateB.promise;
      }
      yield { type: 'text', text: 'done' };
    }
  });

  const w1 = await spawn(engine, 'b1');
  assert.equal(w1.model.id, 'pool/b');
  await until(() => requests.length === 1);

  // A queued explicit B worker must not run while B's slot is held...
  const wq = await engine.spawn({ requestId: 'b-queued', task: 'Queued on B', permission: 'workspace-write', model: 'pool/b' });
  assert.equal(wq.model.id, 'pool/b');
  assert.equal(engine.store.get(wq.id).state, 'queued');
  assert.equal(requests.length, 1);

  // ...and must not head-block allocation to the free model C.
  const w2 = await spawn(engine, 'c1');
  assert.equal(w2.model.id, 'pool/c');
  assert.equal((await finished(engine, w2.id)).state, 'completed');
  assert.equal(requests.length, 2);

  assert.equal((await engine.cancel(w1.id)).state, 'cancelled');
  gateB.resolve();

  // The queued B worker gets the released slot...
  assert.equal((await finished(engine, wq.id)).state, 'completed');
  assert.equal(requests.filter(r => r.model.id === 'pool/b').length, 2);

  // ...and a fresh spawn reuses B again after it drains.
  const w3 = await spawn(engine, 'b2');
  assert.equal(w3.model.id, 'pool/b');
  assert.equal((await finished(engine, w3.id)).state, 'completed');
  assert.equal(requests.filter(r => r.model.id === 'pool/b').length, 3);
});

test('revoking allowWrite mid-session blocks the next emitted tool call per-call', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const rm = fake('rev/m');
  const policy = { allowWrite: true };
  let executed = 0;
  const { engine } = await fixture(t, {
    settings: { models: { 'rev/m': policy } },
    tools: {
      definitions: () => [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } }],
      execute: async () => { executed++; return 'written'; }
    },
    provider: { models: async () => [rm] },
    async *stream(selected, messages) {
      const sawResult = messages.some(m => m.parts.some(p => p.type === 'result'));
      if (!sawResult) {
        await gate.promise;
        yield { type: 'call', id: 'c1', name: 'write_file', input: { path: 'out.txt', content: 'x', expectedHash: 'new' } };
      } else {
        yield { type: 'text', text: 'done' };
      }
    }
  });

  const worker = await engine.spawn({ requestId: 'rev', task: 'Write out.txt', permission: 'workspace-write' });
  await until(() => engine.store.get(worker.id).state === 'running');

  // Revoke write access while the model's call is still in flight.
  policy.allowWrite = false;
  gate.resolve();

  assert.equal((await finished(engine, worker.id)).state, 'completed');
  assert.equal(executed, 0);
  const toolEntry = engine.store.get(worker.id).turns[0].tools[0];
  assert.equal(toolEntry.state, 'completed');
  assert.match(toolEntry.result, /"permission_denied"/);
  assert.match(toolEntry.result, /no longer allows workspace-write/);
});

test('malformed model settings saved mid-session stop scheduling without unhandled rejection', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  let rejected = false;
  const onRejection = () => { rejected = true; };
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));

  const { parseModelSettings } = require('../.test-build/model-settings');
  const { defaults } = require('../.test-build/engine');
  const pool = { 'pool/b': { allowWrite: true, numSessions: 1 } };
  // A strict settings callback mirrors the extension: a malformed saved pool throws.
  const { engine, requests } = await fixture(t, {
    settingsFn: () => ({ ...defaults, autoCompact: false, retries: 0, models: parseModelSettings(pool) }),
    tools,
    provider: { models: async () => [B] },
    async *stream(selected, messages) {
      await gate.promise;
      const sawResult = messages.some(m => m.parts.some(p => p.type === 'result'));
      if (!sawResult) {
        yield { type: 'call', id: 'c1', name: 'write_file', input: { path: 'out.txt', content: 'x', expectedHash: 'new' } };
      } else {
        yield { type: 'text', text: 'done' };
      }
    }
  });

  const errors = [];
  const previousOnError = engine.onError;
  engine.onError = (id, error) => { errors.push([id, error]); };
  t.after(() => { engine.onError = previousOnError; });

  const worker = await spawn(engine, 'cfg-1');
  assert.equal(worker.model.id, 'pool/b');
  await until(() => requests.length === 1);

  // Save a malformed pool while the gated worker is still running.
  pool['pool/b'] = { bogus: true };
  gate.resolve();

  // The strict settings read after the tool call fails the worker with the
  // real code, and the scheduled re-entry reports the config error instead of
  // rejecting the detached job promise.
  assert.equal((await finished(engine, worker.id)).state, 'failed');
  assert.equal(engine.store.get(worker.id).turns[0].error?.code, 'invalid_settings');
  assert.equal(engine.runtimeErrors.has(worker.id), false);
  await until(() => errors.some(([id]) => id === 'settings'));
  const reported = errors.find(([id]) => id === 'settings');
  assert.equal(reported[1].code, 'invalid_settings');

  // Restore the valid pool: scheduling works again and a fresh spawn completes.
  pool['pool/b'] = { allowWrite: true, numSessions: 1 };
  const next = await spawn(engine, 'cfg-2');
  assert.equal(next.model.id, 'pool/b');
  assert.equal((await finished(engine, next.id)).state, 'completed');
  // Worker 1: one streamed round (its tool call ran, then the round-2 settings
  // read failed). Worker 2: one call round + one final text round.
  assert.equal(requests.length, 3);
  assert.equal(rejected, false);
});
