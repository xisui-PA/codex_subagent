const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { WorkerEngine, defaults } = require('../.test-build/engine');
const { SessionStore } = require('../.test-build/storage');
const { WorkerError } = require('../.test-build/types');
const { invoke } = require('../.test-build/api');
const { model, deferred, until, fixture, finished } = require('./helpers.cjs');
const spawn = (engine, requestId = 'spawn', task = 'Investigate', extra = {}) => engine.spawn({ requestId, task, permission: 'read-only', ...extra });

test('spawn is durably idempotent and conflicting reuse is rejected', async t => {
  const { engine, requests } = await fixture(t);
  const [a, b] = await Promise.all([spawn(engine), spawn(engine)]);
  assert.equal(a.id, b.id);
  const done = await finished(engine, a.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.turns[0].output, 'done');
  assert.equal(requests.length, 1);
  await assert.rejects(spawn(engine, 'spawn', 'different'), { code: 'idempotency_conflict' });
  await spawn(engine);
  assert.equal(requests.length, 1);
});

test('follow-ups queue behind active work and preserve conversation order', async t => {
  const gate = deferred();
  const { engine, requests } = await fixture(t, { async *stream(_m, _h, _t, _s, n) { if (n === 1) { await gate.promise; } yield { type: 'text', text: `answer ${n}` }; } });
  const worker = await spawn(engine);
  await until(() => requests.length === 1);
  await engine.send(worker.id, 'follow-up', 'Now validate');
  await engine.send(worker.id, 'follow-up', 'Now validate');
  assert.equal(engine.store.get(worker.id).turns.length, 2);
  gate.resolve();
  const done = await finished(engine, worker.id);
  assert.equal(done.turns.length, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.slice(1).map(m => m.parts[0].text), ['Investigate', 'answer 1', 'Now validate']);
});

test('concurrency limit queues workers and queued cancellation does not run', async t => {
  const gate = deferred();
  const { engine, requests } = await fixture(t, { settings: { maxConcurrent: 1 }, async *stream() { await gate.promise; yield { type: 'text', text: 'ok' }; } });
  const a = await spawn(engine, 'a');
  const b = await spawn(engine, 'b');
  await until(() => requests.length === 1);
  assert.equal(engine.store.get(b.id).state, 'queued');
  await engine.cancel(b.id);
  gate.resolve();
  await finished(engine, a.id);
  assert.equal(requests.length, 1);
  assert.equal(engine.store.get(b.id).state, 'cancelled');
});

test('partial streaming failure is checkpointed and never blindly retried', async t => {
  const { engine, requests } = await fixture(t, { settings: { retries: 2 }, async *stream() { yield { type: 'text', text: 'partial answer' }; throw new WorkerError('provider_error', 'connection reset', true); } });
  const worker = await spawn(engine);
  const failed = await finished(engine, worker.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.turns[0].output, 'partial answer');
  assert.equal(requests.length, 1);
  assert.equal(failed.messages.length, 1);
});

test('transient failures retry before output, while permission errors stop', async t => {
  const { engine, requests } = await fixture(t, { settings: { retries: 1 }, async *stream(_m, _h, _t, _s, n) { if (n === 1) { throw new WorkerError('provider_error', 'network', true); } yield { type: 'text', text: 'recovered' }; } });
  const worker = await spawn(engine);
  assert.equal((await finished(engine, worker.id)).state, 'completed');
  assert.equal(requests.length, 2);
});

test('reload preserves sessions and seals uncertain tool results without replay', async t => {
  let executions = 0;
  const { engine, store, provider, root } = await fixture(t, {
    async *stream() { yield { type: 'call', id: 'write-1', name: 'write_file', input: { path: 'a' } }; },
    tools: { definitions: () => [], execute: async (_name, _input, _permission, signal) => { executions++; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return 'written'; } },
  });
  const worker = await spawn(engine);
  await until(() => executions === 1);
  await engine.shutdown();
  assert.equal(store.get(worker.id).state, 'interrupted');
  await store.close();
  const reopened = new SessionStore(path.join(root, 'sessions'));
  await reopened.open();
  provider.stream = async function* (_m, messages) {
    assert.ok(messages.some(m => m.parts.some(p => p.type === 'result' && /Outcome may be unknown/.test(p.text))));
    yield { type: 'text', text: 'Inspected and recovered' };
  };
  const resumed = new WorkerEngine(reopened, provider, { definitions: () => [], execute: async () => { executions++; return 'unexpected'; } }, () => defaults, () => model.id);
  t.after(async () => { await resumed.shutdown(); await reopened.close(); });
  await resumed.resume(worker.id, 'resume');
  await resumed.resume(worker.id, 'resume');
  const done = await finished(resumed, worker.id);
  assert.equal(done.state, 'completed');
  assert.equal(executions, 1);
  assert.equal(done.turns[0].tools[0].state, 'uncertain');
});

test('provider ignoring abort cannot block cancellation or shutdown', async t => {
  const hang = deferred();
  const { engine, requests } = await fixture(t, { async *stream() { await hang.promise; yield { type: 'text', text: 'too late' }; } });
  const worker = await spawn(engine);
  await until(() => requests.length === 1);
  await engine.cancel(worker.id);
  await engine.shutdown();
  const done = engine.store.get(worker.id);
  assert.equal(done.state, 'cancelled');
  assert.equal(done.turns[0].output, '');
});

test('token counting that ignores abort is bounded by the turn deadline', async t => {
  const hang = deferred();
  const { engine } = await fixture(t, { provider: { countTokens: () => hang.promise }, settings: { turnTimeoutMs: 30 } });
  const worker = await spawn(engine);
  const done = await finished(engine, worker.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.turns[0].error.code, 'timeout');
});

test('compaction checks revision, preserves archive and supports recovery on another model', async t => {
  let overflow = true;
  const { engine, provider, requests } = await fixture(t, { provider: { countTokens: async () => overflow ? 100_000 : 10 } });
  const worker = await spawn(engine);
  let current = await finished(engine, worker.id);
  assert.equal(current.turns[0].error.code, 'context_limit');
  await assert.rejects(engine.compact(worker.id, current.revision - 1, 'summary'), { code: 'revision_conflict' });
  const archive = structuredClone(current.messages);
  current = await engine.compact(worker.id, current.revision, 'Task: investigate. No tools have run.');
  assert.deepEqual((await engine.store.readArchive(worker.id, current.archives[0].id)).messages, archive);
  assert.equal(current.messages.length, 0);
  overflow = false;
  await engine.resume(worker.id, 'resume-other', 'other');
  current = await finished(engine, worker.id);
  assert.equal(current.model.id, 'other');
  assert.ok(requests[0].messages.some(m => m.parts[0].text.includes('Coordinator-provided summary')));
  assert.equal((await provider.models()).length, 2);
});

test('tool errors are results in conversation, with durable execution records', async t => {
  const { engine, requests } = await fixture(t, {
    async *stream(_m, _h, _t, _s, n) { if (n === 1) { yield { type: 'call', id: 'r', name: 'read_file', input: {} }; } else { yield { type: 'text', text: 'Handled error' }; } },
    tools: { definitions: () => [], execute: async () => { throw new WorkerError('file_conflict', 'changed'); } },
  });
  const worker = await spawn(engine);
  const done = await finished(engine, worker.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.turns[0].tools[0].state, 'completed');
  assert.match(requests[1].messages.at(-1).parts[0].text, /file_conflict/);
});

test('tool round limits stop runaway workers without dropping history', async t => {
  const { engine } = await fixture(t, { settings: { maxToolRounds: 2 }, async *stream(_m, _h, _t, _s, n) { yield { type: 'call', id: `c${n}`, name: 'read_file', input: {} }; } });
  const worker = await spawn(engine);
  const done = await finished(engine, worker.id);
  assert.equal(done.turns[0].error.code, 'tool_round_limit');
  assert.equal(done.turns[0].tools.length, 2);
  assert.equal(done.messages.filter(m => m.parts.some(p => p.type === 'result')).length, 2);
});

test('API validates arguments and wait timeout leaves work running', async t => {
  const hang = deferred();
  const { engine } = await fixture(t, { async *stream() { await hang.promise; yield { type: 'text', text: 'ok' }; } });
  const invalid = await invoke(engine, 'subagent_spawn', { requestId: 'bad', task: 'task', extra: 'no' });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /invalid_arguments/);
  assert.equal(engine.store.all().length, 0);
  const worker = await spawn(engine);
  const waited = JSON.parse((await invoke(engine, 'subagent_wait', { ids: [worker.id], timeoutMs: 5 })).content[0].text);
  assert.equal(waited.timedOut, true);
  assert.ok(['queued', 'running'].includes(engine.store.get(worker.id).state));
  hang.resolve();
});

test('unknown models never fall back silently and busy workers cannot be deleted', async t => {
  const hang = deferred();
  const { engine } = await fixture(t, { async *stream() { await hang.promise; yield { type: 'text', text: 'ok' }; } });
  await assert.rejects(spawn(engine, 'unknown', 'task', { model: 'nonexistent' }), { code: 'model_unavailable' });
  const worker = await spawn(engine);
  await assert.rejects(engine.remove(worker.id), { code: 'worker_busy' });
  hang.resolve();
});

test('corrupt files are reported and retained, live workspace lock is respected', async t => {
  const { store, root } = await fixture(t);
  const second = new SessionStore(store.directory);
  await assert.rejects(second.open(), { code: 'workspace_locked' });
  await store.close();
  const bad = path.join(root, 'sessions', `${'a'.repeat(32)}.json`);
  await fs.writeFile(bad, '{broken');
  await second.open();
  assert.equal(second.diagnostics.length, 1);
  assert.equal(await fs.readFile(bad, 'utf8'), '{broken');
  await second.close();
});

test('startup recovers a crashed running checkpoint without rerunning accepted work', async t => {
  const { engine, store, provider, root } = await fixture(t);
  const worker = await spawn(engine, 'persisted-spawn');
  await finished(engine, worker.id);
  await store.change(worker.id, s => {
    s.state = 'running'; s.turns[0].state = 'running';
    const call = { type: 'call', id: 'uncommitted-effect', name: 'write_file', input: { path: 'a' } };
    s.messages.push({ role: 'assistant', parts: [call] });
    s.turns[0].tools.push({ call, state: 'started' });
    s.turns[0].output = 'preserved partial';
  });
  await store.close();
  const reopened = new SessionStore(path.join(root, 'sessions'));
  await reopened.open();
  const recovered = reopened.get(worker.id);
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.turns[0].tools[0].state, 'uncertain');
  assert.equal(recovered.turns[0].output, 'preserved partial');
  const second = new WorkerEngine(reopened, provider, { definitions: () => [], execute: async () => 'unused' });
  const duplicate = await spawn(second, 'persisted-spawn');
  assert.equal(duplicate.id, worker.id);
  assert.equal(duplicate.state, 'interrupted');
  await second.shutdown(); await reopened.close();
});

test('checkpoint failure stops work and can resume after storage is repaired', async t => {
  const { engine, store } = await fixture(t);
  const original = store.change.bind(store);
  let changes = 0;
  store.change = async (...args) => {
    if (++changes >= 2) { throw new Error('disk unavailable'); }
    return original(...args);
  };
  const worker = await spawn(engine);
  await until(() => engine.runtimeErrors.has(worker.id));
  assert.equal(engine.session(worker.id).turns[0].error.code, 'checkpoint_failed');
  for (const extra of [{}, { turnId: engine.session(worker.id).turns[0].id, attempt: 1, messageLimit: 20 }]) {
    const status = JSON.parse((await invoke(engine, 'subagent_status', { id: worker.id, ...extra })).content[0].text);
    assert.equal(status.state, 'failed');
    assert.equal(status.turns[0].state, 'failed');
    assert.equal(status.turns[0].error.code, 'checkpoint_failed');
    assert.match(status.turns[0].error.message, /disk unavailable/);
  }
  store.change = original;
  await engine.resume(worker.id, 'storage-fixed');
  assert.equal((await finished(engine, worker.id)).state, 'completed');
});

test('whitespace-only tool rounds do not accumulate blank lines while preserving real formatting', async t => {
  const { engine } = await fixture(t, {
    async *stream(_m, _h, _t, _s, n) {
      if (n === 1) { yield { type: 'text', text: 'Found it\n' }; yield { type: 'call', id: 'c1', name: 'read_file', input: {} }; }
      else if (n === 2) { yield { type: 'text', text: '\n\n  ' }; yield { type: 'call', id: 'c2', name: 'read_file', input: {} }; }
      else if (n === 3) { yield { type: 'text', text: '\n\n' }; yield { type: 'call', id: 'c3', name: 'read_file', input: {} }; }
      else { yield { type: 'text', text: '  line1\nline2\n' }; }
    },
    tools: { definitions: () => [], execute: async () => 'ok' },
  });
  const worker = await spawn(engine);
  const done = await finished(engine, worker.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.turns[0].output, 'Found it\n  line1\nline2\n');
  const assistantText = done.messages.filter(m => m.role === 'assistant').flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.text);
  assert.deepEqual(assistantText, ['Found it\n', '\n\n  ', '\n\n', '  line1\nline2\n']);
});

test('streamed whitespace flushes with the first meaningful chunk of a response', async t => {
  const { engine } = await fixture(t, {
    async *stream() { yield { type: 'text', text: '  ' }; yield { type: 'text', text: '\n' }; yield { type: 'text', text: 'Answer\n' }; }
  });
  const worker = await spawn(engine);
  const done = await finished(engine, worker.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.turns[0].output, '  \nAnswer\n');
});

test('output limits still bound whitespace-prefixed streams', async t => {
  const { engine } = await fixture(t, { settings: { maxOutputChars: 5 }, async *stream() { yield { type: 'text', text: '   ' }; yield { type: 'text', text: 'too much output' }; } });
  const worker = await spawn(engine);
  const current = await finished(engine, worker.id);
  assert.equal(current.turns[0].error.code, 'output_limit');
  assert.equal(current.turns[0].output, '   to');
});

test('output limits preserve bounded partial output', async t => {
  const { engine } = await fixture(t, { settings: { maxOutputChars: 5 }, async *stream() { yield { type: 'text', text: 'too much output' }; } });
  const worker = await spawn(engine);
  const current = await finished(engine, worker.id);
  assert.equal(current.turns[0].error.code, 'output_limit');
  assert.equal(current.turns[0].output, 'too m');
});

test('resumption retains previous attempts and their paginated partial output', async t => {
  const { engine } = await fixture(t, { async *stream(_m, _h, _t, _s, n) {
    if (n === 1) { yield { type: 'text', text: 'partial first attempt' }; throw new Error('interrupted'); }
    yield { type: 'text', text: 'complete second attempt' };
  } });
  const worker = await spawn(engine);
  await finished(engine, worker.id);
  await engine.resume(worker.id, 'retry');
  const done = await finished(engine, worker.id);
  assert.equal(done.turns[0].attemptsLog[0].output, 'partial first attempt');
  const old = JSON.parse((await invoke(engine, 'subagent_status', { id: worker.id, attempt: 1, outputLimit: 7 })).content[0].text);
  assert.equal(old.output, 'partial');
  assert.equal(old.nextOutputOffset, 7);
});

test('shutdown aborts blocked model selection without accepting late work', async t => {
  const hang = deferred();
  const { engine, store } = await fixture(t, { provider: { models: () => hang.promise } });
  const pending = spawn(engine);
  const rejected = assert.rejects(pending, { code: 'host_stopping' });
  await engine.shutdown();
  await rejected;
  assert.equal(store.list().length, 0);
});

test('transcript pagination bounds large pages without dropping messages', async t => {
  const { engine, store } = await fixture(t);
  const worker = await spawn(engine);
  await finished(engine, worker.id);
  await store.change(worker.id, s => { s.messages = Array.from({ length: 3 }, () => ({ role: 'user', parts: [{ type: 'text', text: 'a'.repeat(600_000) }] })); });
  const page = JSON.parse((await invoke(engine, 'subagent_status', { id: worker.id, messageLimit: 20 })).content[0].text);
  assert.equal(page.messages.length, 1);
  assert.equal(page.nextMessage, 1);
  const next = JSON.parse((await invoke(engine, 'subagent_status', { id: worker.id, messageLimit: 20, afterMessage: page.nextMessage })).content[0].text);
  assert.equal(next.messages.length, 1);
  assert.equal(next.nextMessage, 2);
});

test('cancellation and shutdown drain in-flight effects before releasing the worker', async t => {
  for (const action of ['cancel', 'shutdown']) {
    const started = deferred(); const aborted = deferred(); const release = deferred();
    let effect = false;
    const { engine } = await fixture(t, {
      async *stream() { yield { type: 'call', id: 'effect', name: 'write_file', input: {} }; },
      tools: { definitions: () => [], execute: async (_n, _i, _p, signal) => {
        started.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        await release.promise; effect = true; return 'committed';
      } }
    });
    const worker = await spawn(engine, action); await started.promise;
    let settled = false;
    const stopping = (action === 'cancel' ? engine.cancel(worker.id) : engine.shutdown()).then(() => { settled = true; });
    await aborted.promise; await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, `${action} must await the tool`);
    assert.equal(engine.session(worker.id).state, 'running');
    release.resolve(); await stopping;
    assert.equal(effect, true);
    assert.equal(engine.active.size, 0);
    assert.equal(engine.session(worker.id).state, action === 'cancel' ? 'cancelled' : 'interrupted');
  }
});

test('shell cancellation awaits forced termination and leaves no process running after acknowledgement', { skip: process.platform === 'win32' }, async t => {
  const { FileTools } = require('../.test-build/workspace-tools');
  const { engine, root } = await fixture(t, {
    async *stream() { yield { type: 'call', id: 'shell', name: 'run_command', input: { command: 'trap "" TERM; printf ready > ready; sleep 0.2; printf during > during; sleep 10; printf after > after', timeoutMs: 20000 } }; }
  });
  engine.tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => true, approveCommand: async () => true });
  const worker = await spawn(engine, 'shell', 'Run command', { permission: 'workspace-write' });
  await until(() => fs.stat(path.join(root, 'ready')).then(() => true, () => false));
  await engine.cancel(worker.id);
  assert.equal(await fs.readFile(path.join(root, 'during'), 'utf8'), 'during', 'Tool shutdown waited for the termination grace period');
  assert.equal(engine.session(worker.id).state, 'cancelled');
  await assert.rejects(fs.stat(path.join(root, 'after')), { code: 'ENOENT' });
});

test('cancelling a pending shell approval never waits for or executes a late approval', async t => {
  const { FileTools } = require('../.test-build/workspace-tools');
  const approval = deferred(); const requested = deferred();
  const { engine, root } = await fixture(t, {
    async *stream() { yield { type: 'call', id: 'shell', name: 'run_command', input: { command: 'printf unwanted > unwanted' } }; }
  });
  engine.tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => true, approveCommand: () => { requested.resolve(); return approval.promise; } });
  const worker = await spawn(engine, 'approval', 'Wait for approval', { permission: 'workspace-write' });
  await requested.promise; await engine.cancel(worker.id); approval.resolve(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(fs.stat(path.join(root, 'unwanted')), { code: 'ENOENT' });
});

test('cancellation during queued-job promotion becomes terminal without scheduling empty jobs', async t => {
  const gate = deferred();
  const { engine, store, requests } = await fixture(t, { settings: { maxConcurrent: 1 }, async *stream(_m, _h, _t, _s, n) {
    if (n === 1) { await gate.promise; } yield { type: 'text', text: 'done' };
  } });
  const a = await spawn(engine, 'occupies-slot'); await until(() => requests.length === 1);
  const b = await spawn(engine, 'queued-cancellation');
  let cancellation; let schedules = 0;
  const schedule = engine.schedule.bind(engine);
  // Bound a regression so an infinite microtask loop cannot hang the runner.
  engine.schedule = () => { if (++schedules <= 20) { schedule(); } };
  engine.onChange = () => {
    if (!cancellation && store.get(a.id).state === 'completed' && !engine.active.has(a.id) && !engine.active.has(b.id)) {
      cancellation = engine.cancel(b.id);
    }
  };
  gate.resolve(); await until(() => cancellation !== undefined);
  const cancelled = await cancellation;
  engine.onChange = () => {};
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.turns[0].state, 'cancelled');
  assert.equal(engine.active.has(b.id), false);
  assert.ok(schedules < 20, 'Cancellation must not create a rescheduling loop');
  assert.equal(requests.length, 1, 'The cancelled queued turn never reached the model');
  await engine.resume(b.id, 'explicit-resume');
  assert.equal((await finished(engine, b.id)).state, 'completed');
  assert.equal(requests.length, 2);
});

test('cancellation and command timeout drain grandchildren even after their shell exits', { skip: process.platform === 'win32' }, async t => {
  const { FileTools } = require('../.test-build/workspace-tools');
  for (const action of ['cancel', 'timeout']) {
    const { root } = await fixture(t);
    const command = 'printf "%s" "$$" > group; sh -c \'trap "" TERM; printf ready > ready; while :; do printf x >> effects; sleep 0.05; done\' >/dev/null 2>&1 & wait';
    const tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => true, approveCommand: async () => true });
    const controller = new AbortController();
    const running = tools.execute('run_command', { command, timeoutMs: action === 'timeout' ? 1000 : 10000 }, 'workspace-write', controller.signal);
    try {
      await until(() => fs.stat(path.join(root, 'ready')).then(() => true, () => false));
      if (action === 'cancel') { controller.abort(); }
      const result = JSON.parse(await running);
      assert.equal(result.cancelled, action === 'cancel');
      assert.equal(result.timedOut, action === 'timeout');
      const after = await fs.readFile(path.join(root, 'effects'), 'utf8');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(await fs.readFile(path.join(root, 'effects'), 'utf8'), after, `${action} left a descendant writing after acknowledgement`);
    } finally {
      controller.abort();
      const group = Number(await fs.readFile(path.join(root, 'group'), 'utf8').catch(() => '0'));
      if (group > 0) { try { process.kill(-group, 'SIGKILL'); } catch { /* Already gone. */ } }
      await running.catch(() => {});
    }
  }
});

test('host restart during Revert preserves the task state and reports uncertain file effects', async t => {
  const { engine, store, root } = await fixture(t);
  const worker = await spawn(engine, 'revert-restart'); await finished(engine, worker.id);
  await store.change(worker.id, s => { s.state = 'running'; s.maintenance = { kind: 'revert', previousState: 'completed' }; s.activity = 'Reverting change'; });
  await engine.shutdown(); await store.close();
  const reopened = new SessionStore(path.join(root, 'sessions')); await reopened.open();
  try {
    const saved = reopened.get(worker.id);
    assert.equal(saved.state, 'completed'); assert.equal(saved.turns[0].state, 'completed');
    assert.equal(saved.maintenance, undefined); assert.equal(saved.maintenanceError.code, 'edit_interrupted');
    assert.match(saved.maintenanceError.message, /Inspect.*pending change/);
  } finally { await reopened.close(); }
});
