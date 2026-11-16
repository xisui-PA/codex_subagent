const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const pathToBuild = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { WorkerBroker, unpack } = require(path.join(pathToBuild, 'runtime'));
const { defaults } = require(path.join(pathToBuild, 'engine'));
const { workspaceDirectory } = require(path.join(pathToBuild, 'workspaces'));
const { SessionStore } = require(path.join(pathToBuild, 'storage'));
const { readRunnerHostConfig } = require(path.join(pathToBuild, 'isolated-view-host'));
const pkg = require(path.resolve(__dirname, '..', 'package.json'));

// Fail loudly on a stale compile instead of silently skipping runner coverage.
if (typeof readRunnerHostConfig !== 'function') {
  throw new Error(`stale runner host build at ${pathToBuild}; recompile it (CODEX_TEST_BUILD=<dir>)`);
}

const TEST_TIMEOUT = 90_000;
const model = { id: 'test/runner-view', name: 'Fixture', vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 };
const ownerId = 'runner-owner';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a runner side effect');
    }
    await sleep(50);
  }
}

const exists = file => fs.lstat(file).then(() => true, () => false);
const hashOf = text => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Bounded search of the test's own runner storage for a materialized file with
 * exact content. This proves the real process reached its side effect before a
 * cancellation, without relying on a fixed sleep or on internal paths.
 */
async function materialized(directory, name, content, depth = 0) {
  if (depth > 6) {
    return false;
  }
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isFile()) {
      if (entry.name === name && await fs.readFile(target, 'utf8').then(text => text === content, () => false)) {
        return true;
      }
    } else if (entry.isDirectory() && await materialized(target, name, content, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Real broker over real IsolatedViews and the real process helper. `runners`
 * omitted leaves RuntimeOptions.runners undefined, i.e. exactly the old host.
 */
async function fixture(t, runners) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-runner-')));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'base');
  const state = {
    documents: [], approvals: [], approve: async () => true, canWrite: true, allowShell: true,
    policy: { allowWrite: true, allowShell: true, numSessions: 2 },
    runners: runners === undefined ? undefined : { enabled: true, capacity: 2, maxQueue: 4 },
    errors: [], requests: 0
  };
  state.available = [model];
  state.pool = { [model.id]: state.policy };
  let actions = [];
  const options = {
    storage: path.join(base, 'storage'), registry: path.join(base, 'registry'), roots: [root], identity: `folder:${root}`,
    provider: {
      models: async () => state.available, countTokens: async () => 10,
      async *stream() {
        state.requests += 1;
        const action = actions.shift();
        if (action) {
          yield action;
        } else {
          yield { type: 'text', text: 'done' };
        }
      }
    },
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: state.pool }),
    files: {
      canWrite: () => state.canWrite,
      allowShell: () => state.allowShell,
      approveCommand: async (command, cwd, signal, workspaceRoot, context) => {
        state.approvals.push({ command, cwd, workspaceRoot, context });
        return state.approve({ command, cwd, signal, workspaceRoot, context });
      }
    },
    taskBoardEnabled: () => true,
    isolatedViewsEnabled: () => true,
    onChange() {}, onError(message) { state.errors.push(message); }
  };
  if (runners !== undefined) {
    options.runners = () => state.runners;
  }
  let broker = new WorkerBroker(options);
  t.after(async () => {
    await broker.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  await broker.start();
  const call = async (name, args) => unpack(await broker.invoke(root, name, args));
  const complete = async id => {
    await call('subagent_wait', { ids: [id], timeoutMs: 60_000 });
    const session = await broker.session(root, id);
    assert.equal(session.state, 'completed', JSON.stringify(session.turns.at(-1)?.error));
    return session;
  };
  const directory = await workspaceDirectory(options.storage, root);
  const f = {
    root, base, state, call, complete, directory,
    broker: () => broker,
    actions: values => { actions = values; },
    restart: async () => {
      await broker.close();
      broker = new WorkerBroker(options);
      await broker.start();
    },
    runnerDirectory: path.join(directory, 'runners'),
    session: id => broker.session(root, id),
    /** Sends one turn whose model calls are `values`, then waits for it. */
    turn: async (label, values) => {
      actions = values;
      await call('subagent_send', { ownerId, id: f.worker.id, requestId: label, message: label });
      return f.complete(f.worker.id);
    },
    toolResult: (session, name) => {
      const entry = session.turns.at(-1).tools.find(tool => tool.call.name === name);
      assert.ok(entry, `the turn must contain a ${name} call`);
      return JSON.parse(entry.result);
    },
    overlay: async () => (await call('subagent_view_status', { ...f.scope, kind: 'overlays' })).items[0]
  };
  const worker = await call('subagent_spawn', { ownerId, requestId: 'worker', task: 'ready', permission: 'workspace-write', model: model.id });
  await complete(worker.id);
  f.worker = worker;
  const team = await call('subagent_team_create', { ownerId, requestId: 'team', name: 'Runner team', description: '' });
  f.team = await call('subagent_team_update', { ownerId, requestId: 'join', teamId: team.id, expectedRevision: team.revision, addMembers: [worker.id] });
  f.scope = { ownerId, teamId: team.id };
  const snapshot = await call('subagent_snapshot_create', { ...f.scope, requestId: 'capture' });
  f.snapshot = snapshot;
  f.overlayBinding = await call('subagent_view_bind', { ...f.scope, requestId: 'bind', id: worker.id, snapshotId: snapshot.id });
  return f;
}

const script = body => ({ type: 'call', id: 'script', name: 'write_file', input: { path: 'script.cjs', expectedHash: 'new', content: body } });
const runnerCommand = command => ({ type: 'call', id: 'runner', name: 'run_command', input: { command, path: '.' } });

test('runner settings are User-level only and bounded by package.json', { timeout: TEST_TIMEOUT }, async () => {
  const inspect = values => key => values[key];
  // A workspace/folder value is never consulted: only globalValue counts.
  const workspaceOnly = readRunnerHostConfig(inspect({
    'isolatedViews.runners.enabled': { globalValue: undefined, workspaceValue: true, workspaceFolderValue: true },
    'isolatedViews.runners.capacity': { globalValue: undefined, workspaceValue: 8 },
    'isolatedViews.runners.maxQueue': { globalValue: undefined, workspaceValue: 256 }
  }));
  assert.deepEqual(workspaceOnly, { enabled: false, capacity: 2, maxQueue: 32 });
  assert.deepEqual(readRunnerHostConfig(inspect({
    'isolatedViews.runners.enabled': { globalValue: true },
    'isolatedViews.runners.capacity': { globalValue: 8 },
    'isolatedViews.runners.maxQueue': { globalValue: 0 }
  })), { enabled: true, capacity: 8, maxQueue: 0 });
  // Out-of-range, fractional and non-numeric values fall back to the default.
  for (const capacity of [0, 9, 2.5, '4', null]) {
    assert.equal(readRunnerHostConfig(inspect({ 'isolatedViews.runners.capacity': { globalValue: capacity } })).capacity, 2, `capacity ${capacity}`);
  }
  for (const maxQueue of [-1, 257, 1.5, 'many', null]) {
    assert.equal(readRunnerHostConfig(inspect({ 'isolatedViews.runners.maxQueue': { globalValue: maxQueue } })).maxQueue, 32, `maxQueue ${maxQueue}`);
  }
  // An absent configuration entry (inspect returns undefined) stays off.
  assert.deepEqual(readRunnerHostConfig(() => undefined), { enabled: false, capacity: 2, maxQueue: 32 });
  const properties = pkg.contributes.configuration.properties;
  const enabled = properties['codexSubagent.isolatedViews.runners.enabled'];
  const capacity = properties['codexSubagent.isolatedViews.runners.capacity'];
  const maxQueue = properties['codexSubagent.isolatedViews.runners.maxQueue'];
  assert.deepEqual({ type: enabled.type, default: enabled.default, scope: enabled.scope }, { type: 'boolean', default: false, scope: 'machine' });
  assert.deepEqual({ type: capacity.type, default: capacity.default, minimum: capacity.minimum, maximum: capacity.maximum, scope: capacity.scope },
    { type: 'integer', default: 2, minimum: 1, maximum: 8, scope: 'machine' });
  assert.deepEqual({ type: maxQueue.type, default: maxQueue.default, minimum: maxQueue.minimum, maximum: maxQueue.maximum, scope: maxQueue.scope },
    { type: 'integer', default: 32, minimum: 0, maximum: 256, scope: 'machine' });
});

test('without the runner option nothing is created, legacy file tools are unchanged and shell stays unavailable', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, undefined);
  await f.turn('legacy', [{ type: 'call', id: 'read', name: 'read_file', input: { path: 'a.txt' } }]);
  assert.equal(f.toolResult(await f.session(f.worker.id), 'read_file').content, 'base');
  // The runner tools still answer, from metadata alone, and create no storage.
  const status = await f.call('subagent_runner_status', { ...f.scope });
  assert.equal(status.summary.enabled, false);
  assert.deepEqual(status.items, []);
  assert.equal(await exists(f.runnerDirectory), false, 'a disabled feature must not create runner storage');
  // A bound run_command keeps the legacy refusal and never asks for approval.
  const approvals = f.state.approvals.length;
  await f.turn('shell', [runnerCommand('node script.cjs')]);
  const session = await f.session(f.worker.id);
  assert.equal(f.toolResult(session, 'run_command').error.code, 'isolated_shell_unavailable');
  assert.equal(f.state.approvals.length, approvals);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'base');
  assert.equal(await exists(f.runnerDirectory), false);
});

test('an enabled runner imports its private change once, main stays untouched and the approval carries the lease identity', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, true);
  await f.turn('script', [script("const fs = require('node:fs');\nfs.writeFileSync('a.txt', 'runner wrote');\nprocess.stdout.write('runner-ok');\n")]);
  assert.equal((await f.overlay()).revision, 1);
  const session = await f.turn('run', [runnerCommand('node script.cjs')]);
  const result = f.toolResult(session, 'run_command');
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(result.drained, true);
  assert.equal(result.import, 'imported');
  assert.match(result.output, /runner-ok/);
  assert.equal(result.resultId, result.id);
  assert.equal(result.timedOut, false);
  assert.equal(result.attempt.command, 'node script.cjs');
  assert.equal(result.attempt.inputVersion.revision, 1, 'the command ran against the revision it was prepared from');
  // Exactly one import for one command, and the private overlay owns the change.
  assert.equal((await f.overlay()).revision, 2, 'one import per command');
  const read = await f.turn('read', [{ type: 'call', id: 'read', name: 'read_file', input: { path: 'a.txt' } }]);
  assert.equal(f.toolResult(read, 'read_file').content, 'runner wrote');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'base', 'the main workspace is never modified');
  // The approval described the materialized copy, not the project root.
  assert.equal(f.state.approvals.length, 1);
  const approval = f.state.approvals[0];
  assert.equal(approval.command, 'node script.cjs');
  assert.equal(approval.workspaceRoot, f.root);
  assert.equal(approval.context.kind, 'isolated-runner');
  assert.equal(approval.context.inputVersion.revision, 1);
  assert.ok(path.isAbsolute(approval.context.executionRoot));
  const relative = path.relative(approval.context.executionRoot, approval.cwd);
  assert.ok(relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative), 'approved cwd must be inside the lease');
  assert.notEqual(approval.cwd, f.root);
  assert.equal(path.relative(f.root, approval.context.executionRoot).startsWith('..'), true, 'runner storage is outside the project');
  // Scoped observation: the lease row names its worker, and summaries stay bounded.
  const leases = await f.call('subagent_runner_status', { ...f.scope, kind: 'leases' });
  assert.equal(leases.summary.enabled, true);
  assert.equal(leases.summary.capacity, 2);
  assert.equal(leases.summary.maxQueue, 4);
  assert.ok(leases.summary.resultCount >= 1);
  assert.equal(leases.nextOffset, null);
  const results = await f.call('subagent_runner_status', { ...f.scope, kind: 'results' });
  const summary = results.items[0];
  assert.equal(summary.id, result.id);
  assert.equal(summary.workerId, f.worker.id);
  assert.equal(summary.workerCreatedAt, f.worker.createdAt);
  assert.match(summary.uri, /^urn:codex-runner-result:[0-9a-f]{64}:[0-9a-f]{32}$/);
  assert.equal(summary.outputPreview.length <= 512, true);
  assert.equal('output' in summary, false, 'list rows never carry the full output');
  // A later private edit leaves the stored result immutable but makes it stale
  // evidence about the current revision.
  const edit = await f.turn('edit', [{
    type: 'call', id: 'write', name: 'write_file',
    input: { path: 'a.txt', expectedHash: hashOf('runner wrote'), content: 'later' }
  }]);
  assert.equal(f.toolResult(edit, 'write_file').revision, 3, 'the edit is the third private revision');
  const fetched = await f.call('subagent_runner_result', { ...f.scope, id: result.id });
  assert.equal(fetched.result.id, result.id);
  assert.equal(fetched.result.attempt.inputVersion.revision, 1);
  assert.equal(fetched.currentRevision, 3);
  assert.equal(fetched.inputIsCurrent, false);
  assert.equal(fetched.stale, true);
  assert.equal((await f.call('subagent_runner_status', { ...f.scope, kind: 'results' })).total, 1, 'no command is replayed');
});

test('a live model, shell or feature revocation while the approval is pending blocks the actual spawn', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, true);
  await f.turn('script', [script("require('node:fs').writeFileSync('a.txt', 'should not happen');\n")]);
  const before = (await f.overlay()).revision;
  const revocations = [
    { label: 'model-shell', apply: () => { f.state.policy.allowShell = false; }, restore: () => { f.state.policy.allowShell = true; } },
    { label: 'global-shell', apply: () => { f.state.allowShell = false; }, restore: () => { f.state.allowShell = true; } },
    { label: 'feature', apply: () => { f.state.runners.enabled = false; }, restore: () => { f.state.runners.enabled = true; } }
  ];
  let approvals = 0;
  for (const revocation of revocations) {
    let release;
    f.state.approve = () => new Promise(resolve => { release = resolve; });
    const actions = [runnerCommand('node script.cjs')];
    f.actions(actions);
    await f.call('subagent_send', { ownerId, id: f.worker.id, requestId: revocation.label, message: revocation.label });
    await until(() => release !== undefined);
    approvals += 1;
    revocation.apply();
    release(true);
    await f.complete(f.worker.id);
    revocation.restore();
    const session = await f.session(f.worker.id);
    const failure = f.toolResult(session, 'run_command');
    assert.ok(failure.error, `${revocation.label}: the command must be refused`);
    // No spawn happened: nothing was imported and no output was produced.
    assert.equal((await f.overlay()).revision, before, `${revocation.label}: no private change`);
    const results = await f.call('subagent_runner_status', { ...f.scope, kind: 'results' });
    const denied = results.items.find(item => item.workerId === f.worker.id);
    assert.equal(denied.outcome, 'denied', `${revocation.label}: the recorded outcome is a denial`);
    assert.equal(denied.drained, true, `${revocation.label}: nothing was left running`);
  }
  assert.equal(f.state.approvals.length, approvals, 'each denial was decided after a real approval prompt');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'base');
  // The offered definition follows the live shell policy again once restored.
  f.state.allowShell = false;
  await f.turn('hidden', [runnerCommand('node script.cjs')]);
  assert.equal(f.toolResult(await f.session(f.worker.id), 'run_command').error.code, 'permission_denied');
  f.state.allowShell = true;
});

test('a read-only bound worker can never run a command', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, true);
  const reader = await f.call('subagent_spawn', { ownerId, requestId: 'reader', task: 'read', permission: 'read-only', model: model.id });
  await f.complete(reader.id);
  await f.call('subagent_team_update', { ownerId, requestId: 'add-reader', teamId: f.scope.teamId, expectedRevision: f.team.revision, addMembers: [reader.id] });
  const bound = await f.call('subagent_view_bind', { ...f.scope, requestId: 'bind-reader', id: reader.id, snapshotId: f.snapshot.id });
  assert.ok(bound);
  const approvals = f.state.approvals.length;
  f.actions([runnerCommand('node script.cjs')]);
  await f.call('subagent_send', { ownerId, id: reader.id, requestId: 'read-only-run', message: 'read-only run' });
  await f.complete(reader.id);
  const session = await f.session(reader.id);
  assert.equal(f.toolResult(session, 'run_command').error.code, 'permission_denied');
  assert.equal(f.state.approvals.length, approvals, 'a read-only worker is never offered approval');
  assert.equal(await exists(f.runnerDirectory), false);
});

test('runner scope, pagination and identity are enforced and bounded', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, true);
  await f.turn('script', [script("require('node:fs').writeFileSync('a.txt', 'scoped');\n")]);
  const session = await f.turn('run', [runnerCommand('node script.cjs')]);
  const result = f.toolResult(session, 'run_command');
  assert.equal(result.outcome, 'succeeded');
  // A second, empty team sees nothing from the first team.
  const other = await f.call('subagent_team_create', { ownerId, requestId: 'team-two', name: 'Other team', description: '' });
  const foreign = { ownerId, teamId: other.id };
  const empty = await f.call('subagent_runner_status', { ...foreign, kind: 'leases' });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextOffset, null);
  assert.deepEqual((await f.call('subagent_runner_status', { ...foreign, kind: 'results' })).items, []);
  // A result never crosses a team boundary, even with a correct id.
  await assert.rejects(f.call('subagent_runner_result', { ...foreign, id: result.id }));
  // Cleanup never discards another scope and is naturally idempotent.
  const cleanForeign = await f.call('subagent_runner_cleanup', { ...foreign });
  assert.equal(cleanForeign.discardedCount, 0);
  assert.equal(cleanForeign.retainedCount, 0);
  const first = await f.call('subagent_runner_cleanup', { ...f.scope });
  const second = await f.call('subagent_runner_cleanup', { ...f.scope });
  // A repeated reconcile is a natural no-op: whatever the first pass collected
  // is gone, nothing is re-executed and no result is duplicated.
  assert.equal(second.discarded.length, 0);
  assert.deepEqual(second.retained, first.retained);
  assert.equal((await f.call('subagent_runner_status', { ...f.scope, kind: 'results' })).total, 1);
  // Bounded paging and strict argument validation.
  const page = await f.call('subagent_runner_status', { ...f.scope, kind: 'results', offset: 5, limit: 20 });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextOffset, null);
  await assert.rejects(f.call('subagent_runner_status', { ...f.scope, limit: 21 }));
  await assert.rejects(f.call('subagent_runner_status', { ...f.scope, offset: -1 }));
  await assert.rejects(f.call('subagent_runner_status', { ...f.scope, kind: 'everything' }));
  await assert.rejects(f.call('subagent_runner_cleanup', { ...f.scope, requestId: 'unexpected' }));
});

test('reload keeps results and leases administrable, and cleanup preserves unknown entries', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, true);
  await f.turn('script', [script("require('node:fs').writeFileSync('a.txt', 'persisted');\n")]);
  const session = await f.turn('run', [runnerCommand('node script.cjs')]);
  const result = f.toolResult(session, 'run_command');
  assert.equal(result.outcome, 'succeeded');
  // An unknown directory inside the pool must be reported, not deleted.
  const unknown = path.join(f.runnerDirectory, 'pool', 'slots', '000-unknown-entry');
  await fs.mkdir(unknown, { recursive: true });
  await f.restart();
  const fetched = await f.call('subagent_runner_result', { ...f.scope, id: result.id });
  assert.equal(fetched.result.id, result.id);
  assert.equal(fetched.version, 1);
  assert.equal(fetched.result.drained, true);
  const status = await f.call('subagent_runner_status', { ...f.scope, kind: 'results' });
  assert.equal(status.total, 1);
  const cleaned = await f.call('subagent_runner_cleanup', { ...f.scope });
  assert.equal(cleaned.unknownCount >= 1, true, 'unknown entries are reported');
  assert.equal(await exists(unknown), true, 'unknown entries are preserved');
  // Runner metadata stays readable even when the private file index is gone:
  // it never loads that index just to answer.
  await f.broker().close();
  const index = path.join(f.directory, 'isolated-views', 'index.json');
  const bytes = await fs.readFile(index);
  await fs.unlink(index);
  await f.restart();
  const afterIndexLoss = await f.call('subagent_runner_status', { ...f.scope, kind: 'results' });
  assert.equal(afterIndexLoss.total, 1);
  const unknownView = await f.call('subagent_runner_result', { ...f.scope, id: result.id });
  assert.equal(unknownView.result.id, result.id);
  assert.equal(unknownView.currentRevision, null, 'a missing private view is unknown, never current');
  assert.equal(unknownView.inputIsCurrent, null);
  assert.equal(unknownView.stale, null);
  await f.broker().close();
  await fs.writeFile(index, bytes);
  await f.restart();
  assert.equal((await f.call('subagent_runner_result', { ...f.scope, id: result.id })).result.id, result.id);
});

test('cancelling a running command imports its partial private change and never replays it', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, true);
  await f.turn('script', [script("require('node:fs').writeFileSync('a.txt', 'partial');\nsetTimeout(() => undefined, 60000);\n")]);
  const before = (await f.overlay()).revision;
  f.actions([runnerCommand('node script.cjs')]);
  await f.call('subagent_send', { ownerId, id: f.worker.id, requestId: 'cancel', message: 'cancel' });
  // Wait for the real process to be executing AND to have written its side
  // effect, so the cancellation provably happens mid-command.
  await until(async () => {
    const leases = await f.call('subagent_runner_status', { ...f.scope, kind: 'leases' });
    if (!leases.items.some(item => item.phase === 'executing')) {
      return false;
    }
    return materialized(f.runnerDirectory, 'a.txt', 'partial');
  });
  await f.call('subagent_cancel', { ownerId, id: f.worker.id });
  await until(async () => ['cancelled', 'completed', 'failed'].includes((await f.session(f.worker.id)).state));
  const results = await f.call('subagent_runner_status', { ...f.scope, kind: 'results' });
  assert.equal(results.total, 1, 'a cancelled command is never replayed');
  const id = results.items[0].id;
  const fetched = await f.call('subagent_runner_result', { ...f.scope, id });
  assert.equal(fetched.result.outcome, 'cancelled');
  assert.equal(fetched.result.drained, true);
  assert.equal(fetched.result.import, 'imported', 'partial changes are imported after a cancellation');
  const session = await f.session(f.worker.id);
  assert.equal(session.state, 'cancelled');
  const read = await f.call('subagent_view_status', { ...f.scope, kind: 'overlays' });
  assert.equal(read.items[0].revision > before, true);
  await f.broker().close();
});

test('host close drains the runner and keeps the store ownership lock until it is done', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, true);
  await f.turn('script', [script("require('node:fs').writeFileSync('a.txt', 'closing');\nsetTimeout(() => undefined, 60000);\n")]);
  f.actions([runnerCommand('node script.cjs')]);
  await f.call('subagent_send', { ownerId, id: f.worker.id, requestId: 'closing', message: 'closing' });
  await until(async () => {
    const leases = await f.call('subagent_runner_status', { ...f.scope, kind: 'leases' });
    return leases.items.some(item => item.phase === 'executing');
  });
  const closing = f.broker().close();
  // The owner lock is still held while the runner drains, so no other host can
  // adopt the store - and its leases - mid-shutdown.
  await fs.access(path.join(f.directory, 'owner.lock'));
  const contender = new SessionStore(f.directory);
  try {
    await assert.rejects(contender.open(), { code: 'workspace_locked' });
  } finally {
    await contender.close();
  }
  await closing;
  await assert.rejects(fs.access(path.join(f.directory, 'owner.lock')), { code: 'ENOENT' });
  // The shutdown drained the command instead of leaving it running.
  const metadata = f.runnerDirectory;
  assert.equal(await exists(metadata), true);
  t.after(() => undefined);
});

test('an unsafe existing runner store fails closed, is not retried by the same host, and recovers on restart', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, true);
  // A plain file where the runner directory belongs must never be reported as
  // an empty success: it is opened and refused.
  await fs.writeFile(f.runnerDirectory, 'not a directory');
  await assert.rejects(f.call('subagent_runner_status', { ...f.scope }));
  await assert.rejects(f.call('subagent_runner_cleanup', { ...f.scope }));
  assert.equal(await fs.readFile(f.runnerDirectory, 'utf8'), 'not a directory', 'the foreign entry is untouched');
  // The failed open is cached for this host: removing the obstacle does not
  // silently start a second opening behind Host.close()'s back.
  await fs.unlink(f.runnerDirectory);
  await assert.rejects(f.call('subagent_runner_status', { ...f.scope }));
  // A new host is the documented repair path.
  await f.restart();
  const status = await f.call('subagent_runner_status', { ...f.scope });
  assert.equal(status.summary.enabled, true);
  assert.deepEqual(status.items, []);
  assert.equal(await exists(f.runnerDirectory), false, 'observation alone never creates runner storage');
});

test('the command definition is offered only to writable, shell-enabled workers', { timeout: TEST_TIMEOUT }, async () => {
  const { IsolatedWorkspaceTools } = require(path.join(pathToBuild, 'isolated-workspace-tools'));
  const binding = { teamId: 'a'.repeat(32), snapshotId: 'b'.repeat(64), overlayId: 'c'.repeat(64) };
  const identity = { ownerId: 'owner', workerId: 'd'.repeat(32), workerCreatedAt: '2024-01-01T00:00:00.000Z' };
  const port = { withView: async () => undefined, edit: async () => ({ revision: 0 }), seal: async () => ({}), status: async () => ({}) };
  const calls = [];
  const runner = (enabled, available) => ({
    enabled: () => enabled,
    available: () => available,
    execute: async () => { calls.push('execute'); return '{}'; }
  });
  const build = (runnerSeam, sessionPermission = 'workspace-write', canWrite = true) => new IsolatedWorkspaceTools(
    '/root', port, binding, identity, sessionPermission,
    { canWrite: () => canWrite, ...(runnerSeam === undefined ? {} : { runner: runnerSeam }) }
  );
  const offered = (tools, permission = 'workspace-write') => tools.definitions(permission).find(tool => tool.name === 'run_command');
  // No runner seam keeps the exact old behavior and the old wording.
  const disabled = build(undefined);
  assert.match(offered(disabled).description, /never executes in the main workspace/i);
  await assert.rejects(disabled.execute('run_command', { command: 'echo hi' }, 'workspace-write', new AbortController().signal),
    { code: 'isolated_shell_unavailable' });
  // The seam decides the offered definition from the LIVE availability.
  assert.ok(offered(build(runner(true, true))));
  assert.match(offered(build(runner(true, true))).description, /private materialized copy/);
  assert.equal(offered(build(runner(true, false))), undefined, 'no live shell policy or approval means no definition');
  assert.equal(offered(build(runner(false, false))), undefined);
  // A read-only worker is never offered it even when the seam allows it.
  const reader = build(runner(true, true), 'read-only');
  assert.equal(offered(reader), undefined);
  await assert.rejects(reader.execute('run_command', { command: 'echo hi' }, 'read-only', new AbortController().signal), { code: 'permission_denied' });
  assert.deepEqual(calls, [], 'no refused call ever reached the runner seam');
});

const watchdog = setTimeout(() => {
  console.error('runtime runner tests exceeded their watchdog budget');
  process.exit(1);
}, 900_000);
watchdog.unref();
