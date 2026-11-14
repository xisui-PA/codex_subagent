const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WorkerError, failure } = require('../.test-build/types');
const {
  boardMcpTools, boardToolNames, invokeBoard, isBoardTool, workerBoardToolNames, workerBoardTools,
} = require('../.test-build/task-board-tools');

const OWNER = 'owner-1';
const OTHER_WORKER = '0'.repeat(32);
const WORKER = 'f'.repeat(32);
const TEAM = 'a'.repeat(32);
const TASK = '1'.repeat(32);

const text = result => result.content[0].text;
const hex = n => n.toString(16).padStart(32, '0');
const signal = () => ({ throwIfAborted() {} });
const aborting = () => ({ throwIfAborted() { const error = new Error('aborted'); error.name = 'AbortError'; throw error; } });
const tick = () => new Promise(resolve => setImmediate(resolve));
/** Assert a call fails as invalid_arguments; the worker path throws, so check the failure code. */
async function rejectsInvalid(call) {
  let thrown;
  await call().then(() => undefined, error => { thrown = error; });
  assert.ok(thrown, 'the call must reject');
  assert.equal(failure(thrown).code, 'invalid_arguments');
  return thrown;
}

class FakePort {
  constructor() {
    this.calls = [];
    this.failure = undefined;
  }
  push(name, args) {
    this.calls.push({ name, args });
    return this.failure ? Promise.reject(this.failure) : Promise.resolve({ ok: name });
  }
  createTeam(actor, input) { return this.push('createTeam', [actor, input]); }
  getTeam(actor, id) { return this.push('getTeam', [actor, id]); }
  listTeams(actor) {
    this.calls.push({ name: 'listTeams', args: [actor] });
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.teams ?? []);
  }
  updateTeam(actor, input) { return this.push('updateTeam', [actor, input]); }
  createTask(actor, input) { return this.push('createTask', [actor, input]); }
  getTask(actor, id) { return this.push('getTask', [actor, id]); }
  listTasks(actor, teamId) {
    this.calls.push({ name: 'listTasks', args: [actor, teamId] });
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.tasks ?? []);
  }
  updateTask(actor, input, guard) { guard?.(); return this.push('updateTask', [actor, input]); }
}

/** A board that answers membership synchronously, so definitions can be filtered. */
class SyncTeamPort extends FakePort {
  constructor(teams) {
    super();
    this.teams = teams;
  }
  listTeams(actor) {
    if (this.teams instanceof Error) {
      throw this.teams;
    }
    this.calls.push({ name: 'listTeams', args: [actor] });
    return this.teams;
  }
}

/** A board whose update applies asynchronously, like the domain's mutation mutex. */
class QueuedPort extends FakePort {
  constructor() {
    super();
    this.pending = [];
  }
  updateTask(actor, input, guard) {
    return new Promise((resolve, reject) => {
      this.pending.push({ actor, input, guard, resolve, reject });
    });
  }
  flush() {
    const queued = this.pending.shift();
    try {
      queued.guard?.();
    } catch (error) {
      queued.reject(error);
      return;
    }
    this.calls.push({ name: 'updateTask', args: [queued.actor, queued.input] });
    queued.resolve({ ok: 'updateTask' });
  }
}

function fakeBase() {
  const base = {
    calls: [],
    definitions(permission) {
      base.calls.push(['definitions', permission]);
      return [{ name: 'read_file', description: 'Read a workspace file', inputSchema: { type: 'object' } }];
    },
    async execute(name, input, permission, sig, session, authorize) {
      base.calls.push(['execute', name, input, permission, session, authorize]);
      return '{"ok":true}';
    },
    forSession(session) {
      base.scopedTo = session.id;
      return {
        ...base,
        workspaceRoot: session.workspaceRoot,
        definitions: permission => base.definitions(permission),
        execute: (...args) => base.execute(...args),
      };
    },
    workspaceRoot: 'C:\\ws',
  };
  return base;
}

const coordinatorTools = [
  'subagent_team_create', 'subagent_team_get', 'subagent_team_list', 'subagent_team_update',
  'subagent_task_create', 'subagent_task_get', 'subagent_task_list', 'subagent_task_update',
];
const withBoard = names => [...names, ...workerBoardToolNames];

test('board descriptors require the coordinator identity and advertise read-only tools separately', () => {
  assert.deepEqual(boardMcpTools.map(tool => tool.name), coordinatorTools);
  assert.deepEqual([...boardToolNames].sort(), [...coordinatorTools].sort());
  assert.equal(isBoardTool('subagent_task_get'), true);
  assert.equal(isBoardTool('subagent_models'), false);
  assert.equal(isBoardTool('__proto__'), false, 'prototype keys are not board tools');
  assert.equal(isBoardTool('toString'), false);

  for (const tool of boardMcpTools) {
    const readOnly = tool.name.endsWith('_get') || tool.name.endsWith('_list');
    assert.ok(tool.description.length > 0, `${tool.name} has a description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.inputSchema.properties.ownerId, `${tool.name} declares ownerId`);
    assert.ok(tool.inputSchema.required.includes('ownerId'), `${tool.name} requires ownerId`);
    assert.ok(tool.inputSchema.properties.workspaceRoot, `${tool.name} accepts workspace routing`);
    assert.ok(!tool.inputSchema.required.includes('workspaceRoot'), 'workspaceRoot stays optional');
    assert.equal(tool.annotations.readOnlyHint, readOnly);
    assert.equal(tool.annotations.destructiveHint, false);
  }

  const byName = Object.fromEntries(boardMcpTools.map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName.subagent_team_create.inputSchema.properties).sort(), ['description', 'name', 'ownerId', 'requestId', 'workspaceRoot']);
  assert.deepEqual(Object.keys(byName.subagent_team_get.inputSchema.properties).sort(), ['id', 'ownerId', 'workspaceRoot']);
  assert.deepEqual(Object.keys(byName.subagent_team_list.inputSchema.properties).sort(), ['limit', 'offset', 'ownerId', 'workspaceRoot']);
  assert.deepEqual(Object.keys(byName.subagent_task_get.inputSchema.properties).sort(), ['id', 'ownerId', 'workspaceRoot']);
  assert.deepEqual(Object.keys(byName.subagent_task_list.inputSchema.properties).sort(), ['limit', 'offset', 'ownerId', 'teamId', 'workspaceRoot']);
  for (const name of ['subagent_team_update', 'subagent_task_update']) {
    const properties = byName[name].inputSchema.properties;
    assert.ok(properties.requestId, `${name} requires requestId`);
    assert.ok(properties.expectedRevision, `${name} requires expectedRevision`);
  }
});

test('a board call without a valid coordinator ownerId fails before reaching the domain', async () => {
  const port = new FakePort();
  for (const name of coordinatorTools) {
    const missing = await invokeBoard(port, name, {});
    assert.equal(missing.isError, true, `${name} rejects a missing ownerId`);
    assert.match(text(missing), /invalid_arguments/);
    assert.match(text(missing), /ownerId/);
  }
  for (const owner of ['', 'x'.repeat(201), 1, null]) {
    const invalid = await invokeBoard(port, 'subagent_team_list', { ownerId: owner });
    assert.equal(invalid.isError, true);
    assert.match(text(invalid), /invalid_arguments/);
  }
  assert.equal(port.calls.length, 0, 'no invalid call reaches the domain');
});

test('spoofed actors and unknown fields are denied by the strict coordinator schemas', async () => {
  const port = new FakePort();
  const spoofs = [
    { actor: { kind: 'coordinator', ownerId: OWNER } },
    { workerId: WORKER },
    { kind: 'coordinator' },
    { coordinatorOwnerId: OWNER },
    { ownerName: OWNER },
    { workspaceRoot: 'C:\\ws' },
  ];
  for (const extra of spoofs) {
    const result = await invokeBoard(port, 'subagent_team_list', { ownerId: OWNER, ...extra });
    assert.equal(result.isError, true, `${JSON.stringify(extra)} must be rejected`);
    assert.match(text(result), /invalid_arguments/);
  }
  assert.equal(port.calls.length, 0);
});

test('invokeBoard passes the trusted coordinator actor and strips ownerId before the domain', async () => {
  const port = new FakePort();
  const actor = { kind: 'coordinator', ownerId: OWNER };

  const created = await invokeBoard(port, 'subagent_team_create', { ownerId: OWNER, requestId: 'r1', name: 'Board team', description: '' });
  assert.equal(created.isError, undefined);
  assert.deepEqual(JSON.parse(text(created)), { ok: 'createTeam' });
  assert.deepEqual(port.calls[0].args, [actor, { requestId: 'r1', name: 'Board team', description: '' }]);
  assert.ok(!Object.hasOwn(port.calls[0].args[1], 'ownerId'), 'ownerId never reaches the domain input');

  await invokeBoard(port, 'subagent_team_get', { ownerId: OWNER, id: TEAM });
  assert.deepEqual(port.calls[1].args, [actor, TEAM]);

  await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER });
  assert.deepEqual(port.calls[2].args, [actor, undefined], 'an omitted teamId lists every task');

  await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER, teamId: TEAM });
  assert.deepEqual(port.calls[3].args, [actor, TEAM]);

  const update = { ownerId: OWNER, requestId: 'r2', taskId: TASK, expectedRevision: 4 };
  await invokeBoard(port, 'subagent_task_update', update);
  assert.deepEqual(port.calls[4].args, [actor, { requestId: 'r2', taskId: TASK, expectedRevision: 4 }]);
  assert.deepEqual(port.calls.map(call => call.name), ['createTeam', 'getTeam', 'listTasks', 'listTasks', 'updateTask']);
});

test('domain failures become structured tool errors and unknown names are refused', async () => {
  const port = new FakePort();
  port.failure = new WorkerError('revision_conflict', 'Revisions do not match.');
  const conflict = await invokeBoard(port, 'subagent_task_update', { ownerId: OWNER, requestId: 'r', taskId: TASK, expectedRevision: 1 });
  assert.equal(conflict.isError, true);
  assert.deepEqual(JSON.parse(text(conflict)).error, { code: 'revision_conflict', message: 'Revisions do not match.', retryable: false });

  port.failure = new Error('disk on fire');
  const internal = await invokeBoard(port, 'subagent_team_list', { ownerId: OWNER });
  assert.equal(JSON.parse(text(internal)).error.code, 'internal_error');

  const before = port.calls.length;
  const unknown = await invokeBoard(port, 'subagent_models', { ownerId: OWNER });
  assert.equal(unknown.isError, true);
  assert.equal(JSON.parse(text(unknown)).error.code, 'unknown_tool');
  assert.equal(port.calls.length, before, 'unknown names never reach the domain');
});

test('worker definitions disappear while the feature is disabled and forged calls fail closed', async () => {
  const port = new SyncTeamPort([{ id: TEAM, memberWorkerIds: [WORKER] }]);
  const base = fakeBase();
  let enabled = false;
  let changes = 0;
  const tools = workerBoardTools(port, { id: WORKER }, () => enabled, () => { changes += 1; }, base);

  assert.deepEqual(tools.definitions('read-only').map(tool => tool.name), ['read_file']);
  await assert.rejects(tools.execute('subagent_task_get', { id: TASK }, 'read-only', signal()), { code: 'feature_disabled' });
  assert.equal(changes, 0);
  assert.equal(port.calls.length, 0, 'disabled calls never reach the domain');

  enabled = true;
  assert.deepEqual(tools.definitions('read-only').map(tool => tool.name), withBoard(['read_file']));
});

test('worker definitions are team-scoped when the board answers synchronously', () => {
  const base = fakeBase();
  const member = workerBoardTools(new SyncTeamPort([{ id: TEAM, memberWorkerIds: [WORKER] }]), { id: WORKER }, () => true, () => {}, base);
  assert.deepEqual(member.definitions('workspace-write').map(tool => tool.name), withBoard(['read_file']));

  const outsider = workerBoardTools(new SyncTeamPort([{ id: TEAM, memberWorkerIds: [OTHER_WORKER] }]), { id: WORKER }, () => true, () => {}, base);
  assert.deepEqual(outsider.definitions('workspace-write').map(tool => tool.name), ['read_file']);

  for (const name of member.definitions('read-only').map(tool => tool.name)) {
    assert.ok(!coordinatorTools.filter(coordinator => !workerBoardToolNames.includes(coordinator)).includes(name), `${name} is worker-visible only`);
  }
  const byName = Object.fromEntries(member.definitions('read-only').slice(1).map(tool => [tool.name, tool]));
  const update = byName.subagent_task_update.inputSchema;
  for (const key of ['progress', 'blockers', 'candidates', 'state', 'requestId', 'taskId', 'expectedRevision']) {
    assert.ok(update.properties[key], `worker update schema exposes ${key}`);
  }
  for (const key of ['ownerId', 'actor', 'workerId', 'validations']) {
    assert.ok(!update.properties[key], `worker update schema hides ${key}`);
  }
});

test('standalone workers with no teams never receive board definitions', () => {
  const base = fakeBase();
  for (const teams of [[], undefined]) {
    const tools = workerBoardTools(new SyncTeamPort(teams), { id: WORKER }, () => true, () => {}, base);
    assert.deepEqual(tools.definitions('workspace-write').map(tool => tool.name), ['read_file'], `${JSON.stringify(teams)} hides board tools`);
  }
  const malformed = workerBoardTools(new SyncTeamPort([{ id: TEAM }]), { id: WORKER }, () => true, () => {}, base);
  assert.deepEqual(malformed.definitions('read-only').map(tool => tool.name), ['read_file'], 'teams without member lists grant nothing');
  const failed = workerBoardTools(new SyncTeamPort(new Error('board unreadable')), { id: WORKER }, () => true, () => {}, base);
  assert.deepEqual(failed.definitions('read-only').map(tool => tool.name), ['read_file'], 'a throwing membership read hides board tools');
});

test('an unresolved or rejected asynchronous membership read hides board tools until confirmed', async () => {
  const base = fakeBase();
  let resolveList;
  const pendingPort = new FakePort();
  pendingPort.listTeams = actor => new Promise(resolve => { resolveList = () => resolve([{ id: TEAM, memberWorkerIds: [WORKER] }]); pendingPort.calls.push({ name: 'listTeams', args: [actor] }); });
  const pending = workerBoardTools(pendingPort, { id: WORKER }, () => true, () => {}, base);
  assert.deepEqual(pending.definitions('read-only').map(tool => tool.name), ['read_file'], 'unconfirmed membership hides board tools');
  resolveList();
  await tick();
  assert.deepEqual(pending.definitions('read-only').map(tool => tool.name), withBoard(['read_file']), 'a confirmed membership exposes them next time');

  const rejectedPort = new FakePort();
  rejectedPort.listTeams = () => Promise.reject(new Error('board unreadable'));
  const rejected = workerBoardTools(rejectedPort, { id: WORKER }, () => true, () => {}, base);
  assert.deepEqual(rejected.definitions('read-only').map(tool => tool.name), ['read_file'], 'a rejected read stays hidden');
  await tick();
  assert.deepEqual(rejected.definitions('read-only').map(tool => tool.name), ['read_file'], 'a failed read never grants board tools');
});

test('removing the bound worker from every team revokes definitions', () => {
  const base = fakeBase();
  const port = new SyncTeamPort([{ id: TEAM, memberWorkerIds: [WORKER] }]);
  const tools = workerBoardTools(port, { id: WORKER }, () => true, () => {}, base);
  assert.deepEqual(tools.definitions('read-only').map(tool => tool.name), withBoard(['read_file']));

  port.teams = [{ id: TEAM, memberWorkerIds: [OTHER_WORKER] }];
  assert.deepEqual(tools.definitions('read-only').map(tool => tool.name), ['read_file'], 'a revoked membership hides board tools');
  port.teams = [];
  assert.deepEqual(tools.definitions('read-only').map(tool => tool.name), ['read_file']);
  port.teams = [{ id: TEAM, memberWorkerIds: [WORKER] }];
  assert.deepEqual(tools.definitions('read-only').map(tool => tool.name), withBoard(['read_file']), 're-adding membership restores them');
});

test('worker board updates carry the bound identity, return JSON and notify once', async () => {
  const port = new FakePort();
  const base = fakeBase();
  let changes = 0;
  const tools = workerBoardTools(port, { id: WORKER }, () => true, () => { changes += 1; }, base);
  const input = { requestId: 'r1', taskId: TASK, expectedRevision: 3, progress: 'half done', blockers: ['waiting'], candidates: [{ id: 'c1', version: 1, uri: 'file:///c1' }], state: 'submitted' };

  const result = await tools.execute('subagent_task_update', input, 'read-only', signal());
  assert.deepEqual(JSON.parse(result), { ok: 'updateTask' });
  assert.deepEqual(port.calls[0].args, [{ kind: 'worker', workerId: WORKER }, input]);
  assert.equal(changes, 1, 'a successful board write notifies the view');
  assert.equal(base.calls.filter(call => call[0] === 'execute').length, 0, 'board writes never touch file tools');
});

test('workers cannot spoof identity, use coordinator tools or send coordinator fields', async () => {
  const port = new FakePort();
  const tools = workerBoardTools(port, { id: WORKER }, () => true, () => {}, fakeBase());
  const valid = { requestId: 'r', taskId: TASK, expectedRevision: 1, progress: 'x' };
  const spoofs = [
    { ownerId: OWNER },
    { actor: { kind: 'worker', workerId: WORKER } },
    { workerId: WORKER },
    { kind: 'coordinator' },
    { teamId: TEAM },
    { validations: [] },
    { acceptanceCriteria: ['sneaky'] },
  ];
  for (const extra of spoofs) {
    await rejectsInvalid(() => tools.execute('subagent_task_update', { ...valid, ...extra }, 'read-only', signal()));
  }
  await rejectsInvalid(() => tools.execute('subagent_task_update', { ...valid, state: 'accepted' }, 'read-only', signal()));
  await rejectsInvalid(() => tools.execute('subagent_task_get', { id: TASK, ownerId: OWNER }, 'read-only', signal()));
  for (const name of ['subagent_team_create', 'subagent_team_update', 'subagent_task_create']) {
    await assert.rejects(tools.execute(name, { requestId: 'r' }, 'read-only', signal()), { code: 'permission_denied' });
  }
  assert.equal(port.calls.length, 0);
});

test('a queued board update rechecks the guard when the domain applies it', async () => {
  const port = new QueuedPort();
  let allow = true;
  let changes = 0;
  const tools = workerBoardTools(port, { id: WORKER }, () => allow, () => { changes += 1; }, fakeBase());
  const pending = tools.execute('subagent_task_update', { requestId: 'r', taskId: TASK, expectedRevision: 1, progress: 'queued' }, 'read-only', signal());
  await tick();
  assert.equal(port.pending.length, 1, 'the update waits for the domain mutation slot');
  allow = false;
  port.flush();
  await assert.rejects(pending, { code: 'feature_disabled' });
  assert.equal(port.calls.length, 0, 'a call revoked while queued never applies');
  assert.equal(changes, 0, 'no view notification for a revoked write');

  const policyPort = new QueuedPort();
  let checks = 0;
  let notify = 0;
  const guarded = workerBoardTools(policyPort, { id: WORKER }, () => true, () => { notify += 1; }, fakeBase());
  const authorize = () => { checks += 1; if (checks > 1) { throw new WorkerError('permission_denied', 'Model policy revoked while queued.'); } };
  const queued = guarded.execute('subagent_task_update', { requestId: 'r2', taskId: TASK, expectedRevision: 1, progress: 'queued' }, 'read-only', signal(), undefined, authorize);
  await tick();
  policyPort.flush();
  await assert.rejects(queued, { code: 'permission_denied' });
  assert.equal(checks, 2, 'the domain guard re-runs the authorize callback at application time');
  assert.equal(policyPort.calls.length, 0, 'the revocation blocked persistence');
  assert.equal(notify, 0);

  const okPort = new QueuedPort();
  let applied = 0;
  const live = workerBoardTools(okPort, { id: WORKER }, () => true, () => { applied += 1; }, fakeBase());
  const waiting = live.execute('subagent_task_update', { requestId: 'r3', taskId: TASK, expectedRevision: 1, progress: 'queued' }, 'read-only', signal());
  await tick();
  okPort.flush();
  assert.deepEqual(JSON.parse(await waiting), { ok: 'updateTask' }, 'a queued call applies once the guard passes');
  assert.equal(applied, 1);
});

test('worker board calls check cancellation, policy and the feature flag before any effect', async () => {
  const port = new FakePort();
  const base = fakeBase();
  let allow = true;
  let checks = 0;
  const tools = workerBoardTools(port, { id: WORKER }, () => allow, () => {}, base);
  const input = { requestId: 'r', taskId: TASK, expectedRevision: 1, progress: 'x' };

  await assert.rejects(tools.execute('subagent_task_update', input, 'read-only', aborting()), { name: 'AbortError' });
  await assert.rejects(tools.execute('subagent_task_update', input, 'read-only', signal(), undefined, () => {
    checks += 1;
    throw new WorkerError('permission_denied', 'Model policy revoked.');
  }), { code: 'permission_denied' });
  assert.equal(checks, 1);
  await assert.rejects(tools.execute('subagent_task_update', input, 'read-only', signal(), undefined, () => { allow = false; }), { code: 'feature_disabled' });
  assert.equal(port.calls.length, 0, 'no rejected call reached the domain');
});

test('authorize runs before and immediately before the board effect, so a mid-call revocation wins', async () => {
  const port = new FakePort();
  let checks = 0;
  let allow = true;
  const tools = workerBoardTools(port, { id: WORKER }, () => allow, () => {}, fakeBase());
  const authorize = () => {
    checks += 1;
    if (checks > 1) {
      allow = false;
      throw new WorkerError('permission_denied', 'Model policy revoked during the call.');
    }
  };
  await assert.rejects(
    tools.execute('subagent_task_update', { requestId: 'r', taskId: TASK, expectedRevision: 1, progress: 'x' }, 'read-only', signal(), undefined, authorize),
    { code: 'permission_denied' },
  );
  assert.equal(checks, 2, 'the second check runs after parsing and before the domain call');
  assert.equal(port.calls.length, 0, 'the revocation prevented the board mutation');

  const recovery = workerBoardTools(port, { id: WORKER }, () => true, () => {}, fakeBase());
  let calls = 0;
  await recovery.execute('subagent_task_update', { requestId: 'r2', taskId: TASK, expectedRevision: 1, progress: 'x' }, 'read-only', signal(), undefined, () => { calls += 1; });
  assert.equal(calls, 2, 'a stable policy runs both checks and still executes once');
  assert.equal(port.calls.length, 1);
});

test('base file tools, session scopes and the authorize callback are preserved', async () => {
  const port = new FakePort();
  const base = fakeBase();
  const tools = workerBoardTools(port, { id: WORKER }, () => true, () => {}, base);
  const authorize = () => {};
  const scope = { id: 'other-session', permission: 'read-only' };
  const result = await tools.execute('read_file', { path: 'a.txt' }, 'read-only', signal(), scope, authorize);
  assert.equal(result, '{"ok":true}');
  assert.deepEqual(base.calls[0].slice(0, 4), ['execute', 'read_file', { path: 'a.txt' }, 'read-only']);
  assert.equal(base.calls[0][4], scope, 'the caller session reaches the file tools untouched');
  assert.equal(base.calls[0][5], authorize, 'the engine authorize callback is forwarded');
  assert.equal(tools.workspaceRoot, 'C:\\ws');
  assert.equal(base.calls.some(call => call[0] === 'definitions'), false);
  assert.equal(tools.definitions('workspace-write')[0].name, 'read_file', 'base tools stay first');
  assert.ok(base.calls.some(call => call[0] === 'definitions' && call[1] === 'workspace-write'));

  const scoped = tools.forSession({ id: 'scoped-session', workspaceRoot: 'C:\\other', permission: 'read-only' });
  assert.equal(base.scopedTo, 'scoped-session', 'forSession scopes the base tools');
  assert.equal(scoped.workspaceRoot, 'C:\\other');
  await scoped.execute('subagent_task_get', { id: TASK }, 'read-only', signal());
  assert.deepEqual(port.calls.at(-1).args, [{ kind: 'worker', workerId: 'scoped-session' }, TASK], 'identity follows the scoped session');
});

test('a worker cannot impersonate through the execute session argument', async () => {
  const port = new FakePort();
  const tools = workerBoardTools(port, { id: WORKER }, () => true, () => {}, fakeBase());
  await tools.execute('subagent_team_get', { id: TEAM }, 'read-only', signal(), { id: OTHER_WORKER, permission: 'workspace-write' });
  assert.deepEqual(port.calls[0].args, [{ kind: 'worker', workerId: WORKER }, TEAM]);
});

test('coordinator task listing returns one bounded page with nextOffset', async () => {
  const port = new FakePort();
  port.tasks = [1, 2, 3, 4, 5].map(n => ({ id: `${n}`.repeat(32) }));
  const ids = result => JSON.parse(text(result)).tasks.map(task => task.id);
  const page = async args => JSON.parse(text(await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER, ...args })));

  const first = await page({ offset: 1, limit: 2 });
  assert.deepEqual(first.tasks.map(task => task.id), ['2'.repeat(32), '3'.repeat(32)]);
  assert.equal(first.nextOffset, 3, 'the adapter pages the full array after the await');

  const last = await page({ offset: 4, limit: 2 });
  assert.equal(last.tasks.length, 1);
  assert.equal(last.nextOffset, null, 'the final page reports no next offset');

  const defaults = await page({});
  assert.equal(defaults.tasks.length, 5, 'default page size covers a small board');
  assert.equal(defaults.nextOffset, null);

  const filtered = await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER, teamId: TEAM, limit: 3 });
  assert.equal(JSON.parse(text(filtered)).tasks.length, 3);
  assert.deepEqual(port.calls.at(-1).args, [{ kind: 'coordinator', ownerId: OWNER }, TEAM], 'team filtering and identity reach the domain unchanged');
  assert.equal(ids(filtered).length, 3);

  const descriptor = boardMcpTools.find(tool => tool.name === 'subagent_task_list');
  assert.equal(descriptor.annotations.readOnlyHint, true, 'paged listing stays read-only');
  assert.equal(descriptor.inputSchema.properties.limit.maximum, 20);
  assert.equal(descriptor.inputSchema.properties.limit.default, 20);
  assert.equal(descriptor.inputSchema.properties.offset.default, 0);
});

test('invalid pagination and malformed domain responses fail instead of silently truncating', async () => {
  const port = new FakePort();
  port.tasks = [{ id: TASK }];
  for (const args of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { offset: -1 }, { offset: 'first' }, { limit: '2' }]) {
    const result = await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(JSON.parse(text(result)).error.code, 'invalid_arguments');
  }
  assert.equal(port.calls.length, 0, 'a rejected page never reaches the domain');

  port.tasks = { tasks: [{ id: TASK }] };
  const malformed = await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER });
  assert.equal(malformed.isError, true);
  assert.equal(JSON.parse(text(malformed)).error.code, 'internal_error', 'a non-array list is reported, not guessed at');
});

test('worker task listing is paged and keeps the bound worker identity', async () => {
  const port = new FakePort();
  port.tasks = [1, 2, 3].map(n => ({ id: `${n}`.repeat(32) }));
  const tools = workerBoardTools(port, { id: WORKER }, () => true, () => {}, fakeBase());

  const first = JSON.parse(await tools.execute('subagent_task_list', { limit: 2 }, 'read-only', signal()));
  assert.deepEqual(first.tasks.map(task => task.id), ['1'.repeat(32), '2'.repeat(32)]);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(port.calls.at(-1).args, [{ kind: 'worker', workerId: WORKER }, undefined]);

  const filtered = JSON.parse(await tools.execute('subagent_task_list', { teamId: TEAM, offset: 2, limit: 2 }, 'read-only', signal()));
  assert.deepEqual(filtered.tasks.map(task => task.id), ['3'.repeat(32)]);
  assert.equal(filtered.nextOffset, null);
  assert.deepEqual(port.calls.at(-1).args, [{ kind: 'worker', workerId: WORKER }, TEAM], 'the bound identity is unchanged by paging');

  await rejectsInvalid(() => tools.execute('subagent_task_list', { limit: 50 }, 'read-only', signal()));
  await rejectsInvalid(() => tools.execute('subagent_task_list', { offset: -2 }, 'read-only', signal()));
  await rejectsInvalid(() => tools.execute('subagent_task_list', { ownerId: OWNER }, 'read-only', signal()));
});

test('a page budget bounds each response while walking every task exactly once', async () => {
  const port = new FakePort();
  // Items big enough that only a few fit inside the 3M-character page budget.
  const blob = '"\\' + String.fromCharCode(1) + 'x';
  const big = blob.repeat(60_000);
  port.tasks = Array.from({ length: 5 }, (_, index) => ({ id: hex(index + 1), teamId: hex(1), description: big }));
  const envelope = result => JSON.stringify({ content: [{ type: 'text', text: result.content[0].text }] }).length;

  const seen = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const result = await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER, offset, limit: 20 });
    assert.equal(result.isError, undefined);
    const page = JSON.parse(text(result));
    assert.ok(page.tasks.length <= 20);
    assert.ok(result.content[0].text.length <= 3_000_000, 'each inner page respects the 3M budget');
    assert.ok(envelope(result) < 8_000_000, `each doubly encoded page stays under 8M, was ${envelope(result)}`);
    seen.push(...page.tasks.map(entry => entry.id));
    pages += 1;
    if (page.nextOffset === null) { break; }
    assert.equal(page.nextOffset, offset + page.tasks.length, 'nextOffset advances by exactly what was returned');
    offset = page.nextOffset;
    assert.ok(pages < 10, 'walking must terminate');
  }
  assert.equal(pages, 2, 'the budget forced more than one page');
  assert.deepEqual(seen, port.tasks.map(entry => entry.id), 'every task id appears exactly once, in order');
  assert.equal(new Set(seen).size, seen.length, 'no duplicates');
});

test('an item that cannot fit the page budget fails loudly instead of being dropped', async () => {
  const port = new FakePort();
  port.tasks = [{ id: hex(1), description: 'x'.repeat(3_100_000) }];
  const result = await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER });
  assert.equal(result.isError, true, 'no placeholder success');
  assert.equal(JSON.parse(text(result)).error.code, 'response_too_large');
  assert.match(JSON.parse(text(result)).error.message, /subagent_task_get/);

  port.tasks = [{ id: hex(1), teamId: hex(1) }, { id: hex(2), description: 'x'.repeat(3_100_000) }];
  const first = JSON.parse(text(await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER, limit: 20 })));
  assert.deepEqual(first.tasks.map(entry => entry.id), [hex(1)], 'the small item is still returned');
  assert.equal(first.nextOffset, 1, 'the walk stops on the oversized item, not past it');
  const blocked = await invokeBoard(port, 'subagent_task_list', { ownerId: OWNER, offset: 1 });
  assert.equal(JSON.parse(text(blocked)).error.code, 'response_too_large');
});

test('team listing pages at full history bounds and every team id survives the walk', async () => {
  const port = new FakePort();
  const seed = '"\\' + String.fromCharCode(1) + String.fromCharCode(31);
  const nasty = length => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  const at = '2024-01-02T03:04:05.000Z';
  // Every team field at its declared bound, including the largest one: a
  // 100-entry history whose reasons and owner ids are worst-case text.
  port.teams = Array.from({ length: 64 }, (_, index) => ({
    id: hex(index + 1),
    name: nasty(120),
    description: nasty(2000),
    workspaceRoot: nasty(8000),
    coordinatorOwnerId: nasty(200),
    memberWorkerIds: Array.from({ length: 32 }, (_, member) => hex(5000 + member)),
    revision: index,
    createdAt: at,
    updatedAt: at,
    history: {
      entries: Array.from({ length: 100 }, (_, seq) => ({
        seq: seq + 1,
        actor: { kind: 'coordinator', ownerId: nasty(200) },
        from: 'ready',
        to: 'in_progress',
        revision: seq,
        reason: nasty(300),
        at,
      })),
      lastSequence: 140,
      trimmed: 40,
    },
  }));
  const envelope = result => JSON.stringify({ content: [{ type: 'text', text: result.content[0].text }] }).length;
  const seen = [];
  let offset = 0;
  let pages = 0;
  let firstPageSize = 0;
  for (;;) {
    const result = await invokeBoard(port, 'subagent_team_list', { ownerId: OWNER, offset, limit: 20 });
    assert.equal(result.isError, undefined);
    const page = JSON.parse(text(result));
    assert.ok(page.teams.length >= 1 && page.teams.length <= 20, 'a page holds 1..limit teams');
    assert.ok(result.content[0].text.length <= 3_000_000, 'each inner page respects the 3M budget');
    assert.ok(envelope(result) < 8_000_000, `a doubly encoded page must stay under 8M, was ${envelope(result)}`);
    if (offset === 0) { firstPageSize = page.teams.length; }
    seen.push(...page.teams.map(team => team.id));
    pages += 1;
    assert.ok(pages < 64, 'walking must terminate');
    if (page.nextOffset === null) { break; }
    assert.equal(page.nextOffset, offset + page.teams.length, 'nextOffset advances by exactly what was returned');
    offset = page.nextOffset;
  }
  assert.ok(pages > 1, 'full histories force more than one page');
  assert.ok(firstPageSize < 20, 'the first page holds fewer than limit teams');
  assert.deepEqual(seen, port.teams.map(team => team.id), 'all 64 team ids appear exactly once, in order');
  assert.equal(new Set(seen).size, 64, 'no duplicates');
});

test('worker team listing is paged, and membership filtering still reads the raw array', async () => {
  const port = new SyncTeamPort(Array.from({ length: 3 }, (_, index) => ({ id: hex(index + 1), memberWorkerIds: [WORKER] })));
  const tools = workerBoardTools(port, { id: WORKER }, () => true, () => {}, fakeBase());
  assert.ok(tools.definitions('read-only').some(tool => tool.name === 'subagent_team_list'), 'definitions used the raw synchronous array');

  const first = JSON.parse(await tools.execute('subagent_team_list', { limit: 2 }, 'read-only', signal()));
  assert.deepEqual(first.teams.map(team => team.id), [hex(1), hex(2)]);
  assert.equal(first.nextOffset, 2);
  const rest = JSON.parse(await tools.execute('subagent_team_list', { offset: 2, limit: 2 }, 'read-only', signal()));
  assert.deepEqual(rest.teams.map(team => team.id), [hex(3)]);
  assert.equal(rest.nextOffset, null);
  assert.deepEqual(port.calls.at(-1).args, [{ kind: 'worker', workerId: WORKER }], 'the bound identity is unchanged by paging');

  await rejectsInvalid(() => tools.execute('subagent_team_list', { limit: 21 }, 'read-only', signal()));
  await rejectsInvalid(() => tools.execute('subagent_team_list', { offset: -1 }, 'read-only', signal()));
  await rejectsInvalid(() => tools.execute('subagent_team_list', { ownerId: OWNER }, 'read-only', signal()));
});

test('only successful worker mutations notify, and reads never do', async () => {
  const port = new FakePort();
  let changes = 0;
  const tools = workerBoardTools(port, { id: WORKER }, () => true, () => { changes += 1; }, fakeBase());
  await tools.execute('subagent_task_get', { id: TASK }, 'read-only', signal());
  await tools.execute('subagent_task_list', {}, 'read-only', signal());
  assert.equal(changes, 0);

  port.failure = new WorkerError('revision_conflict', 'Stale revision.');
  await assert.rejects(tools.execute('subagent_task_update', { requestId: 'r', taskId: TASK, expectedRevision: 1, progress: 'x' }, 'read-only', signal()), { code: 'revision_conflict' });
  assert.equal(changes, 0, 'a failed write does not notify');

  port.failure = undefined;
  await tools.execute('subagent_task_update', { requestId: 'r2', taskId: TASK, expectedRevision: 2, progress: 'x' }, 'read-only', signal());
  assert.equal(changes, 1);
  assert.equal(port.calls.length, 4);
});
