const assert = require('node:assert/strict');
const { test } = require('node:test');
const { waitLimitFor } = require('../.test-build/engine');
const { invoke } = require('../.test-build/api');
const { deferred, until, fixture, finished } = require('./helpers.cjs');
const spawn = (engine, requestId, model, extra = {}) => engine.spawn({ requestId, task: 'Investigate', permission: 'read-only', model, ...extra });

test('waitLimitFor applies the one-tenth rule with the 60s floor', () => {
  assert.equal(waitLimitFor(600_000), 60_000);
  assert.equal(waitLimitFor(1_800_000), 180_000);
  assert.equal(waitLimitFor(3_600_000), 360_000);
  assert.equal(waitLimitFor(10_000), 60_000);
  assert.equal(waitLimitFor(123_456), 60_000);
});

test('API default wait omits the timeout and reports the derived batch limit', async t => {
  const { engine } = await fixture(t, { settings: { models: { 'byok/qwen': { numSessions: 1, turnTimeoutSeconds: 1800 } } } });
  const worker = await spawn(engine, 'one', undefined);
  const real = engine.wait.bind(engine);
  const calls = [];
  engine.wait = async (ids, timeoutMs) => {
    calls.push({ ids: [...ids], timeoutMs });
    return ids.map(id => engine.session(id));
  };
  t.after(() => { engine.wait = real; });
  const wait = async args => {
    const result = await invoke(engine, 'subagent_wait', args);
    assert.equal(result.isError, undefined);
    return JSON.parse(result.content[0].text);
  };
  const limit = engine.waitLimit([worker.id]);
  assert.equal(limit, 180_000);
  assert.deepEqual((await wait({ ids: [worker.id] })).waitLimitMs, 180_000);
  assert.deepEqual(calls, [{ ids: [worker.id], timeoutMs: undefined }]);
  assert.deepEqual((await wait({ ids: [worker.id], timeoutMs: 0 })).waitLimitMs, 180_000);
  assert.equal(calls.at(-1).timeoutMs, 0);
  assert.equal((await wait({ ids: [worker.id], timeoutMs: 5_000 })).waitLimitMs, 180_000);
  assert.equal(calls.at(-1).timeoutMs, 5_000);
});

test('API wait rejects timeouts above the derived limit and invalid schemas', async t => {
  const { engine } = await fixture(t, { settings: { models: { 'byok/qwen': { numSessions: 1, turnTimeoutSeconds: 600 } } } });
  const worker = await spawn(engine, 'one');
  const real = engine.wait.bind(engine);
  engine.wait = async ids => ids.map(id => engine.session(id));
  t.after(() => { engine.wait = real; });
  const error = async args => {
    const result = await invoke(engine, 'subagent_wait', args);
    assert.equal(result.isError, true);
    return JSON.parse(result.content[0].text).error;
  };
  // Model 600s: derived limit 60000; the 360000 schema max is still rejected.
  assert.equal((await error({ ids: [worker.id], timeoutMs: 60_001 })).code, 'invalid_arguments');
  assert.equal((await error({ ids: [worker.id], timeoutMs: 360_000 })).code, 'invalid_arguments');
  assert.equal((await error({ ids: [worker.id], timeoutMs: 360_001 })).code, 'invalid_arguments');
  assert.equal((await error({ ids: [worker.id], timeoutMs: 500.5 })).code, 'invalid_arguments');
});

test('mixed batch uses the largest derived limit across requested workers', async t => {
  const { engine } = await fixture(t, { settings: { models: { 'byok/qwen': { numSessions: 1, turnTimeoutSeconds: 600 }, other: { numSessions: 1, turnTimeoutSeconds: 3600 } } } });
  const fast = await spawn(engine, 'fast', undefined);
  const slow = await spawn(engine, 'slow', 'other');
  assert.equal(engine.waitLimit([fast.id, slow.id]), 360_000);
  assert.equal(engine.waitLimit([slow.id, fast.id]), 360_000);
  assert.equal(engine.waitLimit([fast.id]), 60_000);
});

test('unknown worker IDs fail the wait', async t => {
  const { engine } = await fixture(t);
  const unknown = '0'.repeat(32);
  assert.equal((await invoke(engine, 'subagent_wait', { ids: [unknown] })).isError, true);
  const error = JSON.parse((await invoke(engine, 'subagent_wait', { ids: [unknown] })).content[0].text).error;
  assert.equal(error.code, 'not_found');
});

test('engine.wait resolves the derived default deadline on worker completion', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { engine, requests } = await fixture(t, { settings: { models: { 'byok/qwen': { numSessions: 1, turnTimeoutSeconds: 600 } } }, async *stream() { await gate.promise; yield { type: 'text', text: 'done' }; } });
  const worker = await spawn(engine, 'one');
  await until(() => requests.length === 1);
  const started = Date.now();
  const waiting = engine.wait([worker.id]);
  gate.resolve();
  const sessions = await waiting;
  assert.ok(Date.now() - started < 5_000, `default wait should resolve on completion, took ${Date.now() - started}ms`);
  assert.equal(sessions[0].state, 'completed');
  assert.equal((await finished(engine, worker.id)).state, 'completed');
});

test('engine.wait cancellation resolves the pending default wait', async t => {
  const hang = deferred();
  t.after(() => hang.resolve());
  const { engine } = await fixture(t, { settings: { models: { 'byok/qwen': { numSessions: 1, turnTimeoutSeconds: 600 } } }, async *stream() { await hang.promise; yield { type: 'text', text: 'late' }; } });
  const worker = await spawn(engine, 'one');
  const controller = new AbortController();
  const waiting = engine.wait([worker.id], undefined, controller.signal);
  await until(() => engine.active.has(worker.id));
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});
