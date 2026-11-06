const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { deferred, sleep } = require('./helpers.cjs');
const { SessionStore } = require('../.test-build/storage');
const { WorkerEngine, defaults } = require('../.test-build/engine');
const { FileTools } = require('../.test-build/workspace-tools');

// Regressions for the pending-operation revocation window. WorkerEngine.toolsFor
// rechecks pool policy on entry, but FileTools.execute can wait indefinitely for
// an approval dialog, the write mutex, or a recordChange checkpoint. The engine
// now hands execute a callback that rechecks the latest pool membership and the
// model's allowWrite/allowShell, and FileTools must invoke it after those waits
// and immediately before each side effect.
const model = { id: 'byok/fake', name: 'Fake', vendor: 'byok', family: 'fake', version: '1', maxInputTokens: 100_000 };
const policy = () => ({ numSessions: 2, allowWrite: true, allowShell: true });
const signal = () => new AbortController().signal;
const exists = file => fs.stat(file).then(() => true, () => false);
// Attaching handlers at creation keeps a late rejection from becoming an
// unhandled rejection when an assertion fails first.
const settle = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-policy-effects-'));
  const store = new SessionStore(path.join(root, 'sessions'));
  await store.open();
  const state = {
    settings: { ...defaults, autoCompact: false, retries: 0, models: { [model.id]: policy() } },
    canWrite: true,
    allowShell: true
  };
  const approvalRequested = deferred();
  const approval = deferred();
  const recordStarted = deferred();
  const recordRelease = deferred();
  let records = 0;
  const files = await FileTools.create([root], {
    canWrite: () => state.canWrite,
    allowShell: () => state.allowShell,
    approveCommand: async () => { approvalRequested.resolve(); return approval.promise; },
    recordChange: async () => {
      // Only the first write parks here; later writes must never reach the
      // durable checkpoint once the policy has been revoked.
      if (++records === 1 && options.deferFirstRecord !== false) {
        recordStarted.resolve();
        await recordRelease.promise;
      }
    }
  });
  const provider = { models: async () => [model], countTokens: async () => 1, async *stream() { yield { type: 'text', text: 'unused' }; } };
  const engine = new WorkerEngine(store, provider, files, () => state.settings, () => model.id);
  t.after(async () => {
    // Release every gate first so a failing assertion cannot strand a wait.
    approval.resolve(false);
    recordRelease.resolve();
    await sleep(50);
    await engine.shutdown().catch(() => undefined);
    await store.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, engine, files, state, approvalRequested, approval, recordStarted, recordRelease, records: () => records };
}

const shell = (env, session) => env.engine.toolsFor(session).execute(
  'run_command', { command: 'printf approved > marker.txt', path: '.' }, 'workspace-write', signal(), session);

test('per-model allowShell revoked while the approval dialog is open stops the command', async t => {
  const env = await fixture(t);
  const session = { id: 'shell', model, permission: 'workspace-write' };
  const tools = env.engine.toolsFor(session);
  assert.ok(tools.definitions('workspace-write').some(tool => tool.name === 'run_command'));
  const pending = settle(shell(env, session));
  await env.approvalRequested.promise;
  env.state.settings.models[model.id] = { ...policy(), allowShell: false };
  assert.ok(!tools.definitions('workspace-write').some(tool => tool.name === 'run_command'), 'the revoked tool must be withdrawn');
  env.approval.resolve(true); // the operator grants approval after revoking
  const result = await pending;
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'permission_denied');
  assert.equal(await exists(path.join(env.root, 'marker.txt')), false, 'the revoked command must never spawn');
});

test('removing the model entry while the approval dialog is open stops the command', async t => {
  const env = await fixture(t);
  const session = { id: 'shell-removed', model, permission: 'workspace-write' };
  const pending = settle(shell(env, session));
  await env.approvalRequested.promise;
  env.state.settings.models['byok/other'] = { numSessions: 1 }; // the pool itself stays configured
  delete env.state.settings.models[model.id];
  env.approval.resolve(true);
  const result = await pending;
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'model_unavailable');
  assert.equal(await exists(path.join(env.root, 'marker.txt')), false, 'no command may run for a removed model');
});

test('global allowShell revoked while the approval dialog is open stops the command', async t => {
  const env = await fixture(t);
  const session = { id: 'shell-global', model, permission: 'workspace-write' };
  const pending = settle(shell(env, session));
  await env.approvalRequested.promise;
  env.state.allowShell = false;
  env.approval.resolve(true);
  const result = await pending;
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'permission_denied');
  assert.equal(await exists(path.join(env.root, 'marker.txt')), false, 'the global switch must still block the spawn');
});

test('allowWrite revoked while a write is parked and one is queued leaves both untouched', async t => {
  const env = await fixture(t);
  const session = { id: 'writes', model, permission: 'workspace-write' };
  const tools = env.engine.toolsFor(session);
  const parked = settle(tools.execute('write_file', { path: 'a.txt', content: 'a', expectedHash: 'new' }, 'workspace-write', signal(), session));
  await env.recordStarted.promise; // the first write holds the mutex inside recordChange
  const queued = settle(tools.execute('write_file', { path: 'b.txt', content: 'b', expectedHash: 'new' }, 'workspace-write', signal(), session));
  await sleep(50); // the second write is parked on the mutex
  env.state.settings.models[model.id] = { ...policy(), allowWrite: false };
  assert.ok(!tools.definitions('workspace-write').some(tool => tool.name === 'write_file'), 'write tools must be withdrawn');
  env.recordRelease.resolve();
  const results = await Promise.all([parked, queued]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.deepEqual(results.map(result => result.error.code), ['permission_denied', 'permission_denied']);
  assert.equal(await exists(path.join(env.root, 'a.txt')), false, 'the parked write must not apply after the revocation');
  assert.equal(await exists(path.join(env.root, 'b.txt')), false, 'the queued write must not start');
  assert.equal(env.records(), 1, 'the queued write must be rejected before it records a change');
});

test('global write switch revoked while a write is queued leaves the file untouched', async t => {
  const env = await fixture(t);
  const session = { id: 'writes-global', model, permission: 'workspace-write' };
  const tools = env.engine.toolsFor(session);
  const parked = settle(tools.execute('write_file', { path: 'a.txt', content: 'a', expectedHash: 'new' }, 'workspace-write', signal(), session));
  await env.recordStarted.promise;
  const queued = settle(tools.execute('write_file', { path: 'b.txt', content: 'b', expectedHash: 'new' }, 'workspace-write', signal(), session));
  await sleep(50);
  env.state.canWrite = false;
  env.recordRelease.resolve();
  const results = await Promise.all([parked, queued]);
  assert.deepEqual(results.map(result => result.error.code), ['permission_denied', 'permission_denied']);
  assert.equal(await exists(path.join(env.root, 'a.txt')), false);
  assert.equal(await exists(path.join(env.root, 'b.txt')), false);
});

// Model write policy gates inference and worker tool calls, never the user's
// own undo of a recorded change. runtime.ts routes ui_revert through the
// explicit FileTools.forUserRevert view; nothing else may obtain it.
test('user-driven revert still applies after the model write policy is revoked', async t => {
  const env = await fixture(t, { deferFirstRecord: false });
  const session = { id: 'revert', model, permission: 'workspace-write' };
  // Withdraw both the model write policy and the aggregate worker switch.
  env.state.settings.models[model.id] = { ...policy(), allowWrite: false };
  env.state.canWrite = false;
  const tools = env.engine.toolsFor(session);
  assert.ok(!tools.definitions('workspace-write').some(t => t.name === 'write_file'), 'worker write tools must be withdrawn');
  // engine.toolsFor(...).execute rejects synchronously on the revoked policy.
  const denied = await settle(Promise.resolve().then(() => tools.execute('write_file', { path: 'blocked.txt', content: 'x', expectedHash: 'new' }, 'workspace-write', signal(), session)));
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.error.code, 'permission_denied');
  assert.equal(await exists(path.join(env.root, 'blocked.txt')), false, 'the revoked worker must not write');
  // The user's undo of the recorded change still works through the explicit view.
  const result = await settle(env.files.forUserRevert(session).execute('write_file', { path: 'restored.txt', content: 'before', expectedHash: 'new' }, 'workspace-write', signal(), session));
  assert.equal(result.status, 'fulfilled', result.error && result.error.stack);
  assert.equal(await fs.readFile(path.join(env.root, 'restored.txt'), 'utf8'), 'before');
  // The privileged view never grants shell.
  const shellDenied = await settle(env.files.forUserRevert(session).execute('run_command', { command: 'printf x > shell.txt', path: '.' }, 'workspace-write', signal(), session));
  assert.equal(shellDenied.status, 'rejected');
  assert.equal(shellDenied.error.code, 'permission_denied');
  assert.equal(await exists(path.join(env.root, 'shell.txt')), false, 'revert must never spawn a command');
});

test('the privileged revert view shares the worker write mutex and keeps hash preconditions', async t => {
  // Fresh fixture with the default deferred checkpoint: an actual worker write
  // parks inside its durable recordChange before the mutation is committed.
  const env = await fixture(t);
  const session = { id: 'revert-mutex', model, permission: 'workspace-write' };
  const file = path.join(env.root, 'shared.txt');
  const { createHash } = require('node:crypto');
  await fs.writeFile(file, 'initial');
  const initialHash = createHash('sha256').update('initial').digest('hex');
  const parked = settle(env.files.execute('write_file', { path: 'shared.txt', content: 'worker replacement', expectedHash: initialHash }, 'workspace-write', signal(), session));
  await env.recordStarted.promise; // parked before the mutation, holding the write mutex
  const reverting = settle(env.files.forUserRevert(session).execute('write_file', { path: 'shared.txt', content: 'initial', expectedHash: initialHash }, 'workspace-write', signal(), session));
  await sleep(50);
  assert.equal(await fs.readFile(file, 'utf8'), 'initial', 'the queued revert must wait behind the parked write');
  env.recordRelease.resolve();
  const results = await Promise.all([parked, reverting]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected', 'the revert must not clobber the worker write it waited behind');
  assert.equal(results[1].error.code, 'file_conflict', 'revocation isolation must not weaken stale-hash protection');
  assert.equal(await fs.readFile(file, 'utf8'), 'worker replacement');
});
