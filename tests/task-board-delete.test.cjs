const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const buildDir = path.join(__dirname, '..', String(process.env.CODEX_TEST_BUILD || '.test-build').trim());
const { TaskBoard } = require(path.join(buildDir, 'task-board'));
const { failure } = require(path.join(buildDir, 'types'));

const coordinator = ownerId => ({ kind: 'coordinator', ownerId });
const w = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(32, '0');
const REF = { id: 'artifact-a', version: 1, uri: 'file:///artifact-a.v1.txt', label: 'artifact' };
const AT = '2026-01-01T00:00:00.000Z';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-board-delete-'));
  const workspaceRoot = path.join(root, 'workspace');
  const boardDir = path.join(root, 'sessions');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(boardDir);
  const workers = new Map();
  const addWorker = (id, { ownerId = 'co-1', root: wsRoot = workspaceRoot } = {}) => {
    const session = { id, workspaceRoot: wsRoot, ownerId };
    workers.set(id, session);
    return session;
  };
  const open = async () => {
    const board = new TaskBoard(boardDir, workspaceRoot, id => workers.get(id));
    await board.open();
    return board;
  };
  const board = await open();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    board, root, workspaceRoot, boardDir, workers, addWorker, open,
    file: path.join(boardDir, 'task-board.json')
  };
}

const code = async (promise) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error.code ?? error.name;
  }
};

/** A task in the exact state and revision the caller needs, created from a fresh requestId. */
async function task(board, team, requestId, extra = {}) {
  return board.createTask(coordinator('co-1'), {
    requestId, teamId: team.id, title: extra.title ?? 'Task ' + requestId, description: '', ...extra
  });
}

/** A task driven to `accepted` through the ordinary coordinator flow. */
async function acceptedTask(board, team, requestId) {
  let current = await task(board, team, requestId);
  current = await board.updateTask(coordinator('co-1'), {
    requestId: `${requestId}-submit`, taskId: current.id, expectedRevision: current.revision,
    ...{ requestId: `${requestId}-progress` }, candidates: [REF], state: 'in_progress'
  });
  current = await board.updateTask(coordinator('co-1'), {
    requestId: `${requestId}-submit`, taskId: current.id, expectedRevision: current.revision,
    candidates: [REF], state: 'submitted'
  });
  current = await board.updateTask(coordinator('co-1'), {
    requestId: `${requestId}-validate`, taskId: current.id, expectedRevision: current.revision, state: 'validating'
  });
  current = await board.updateTask(coordinator('co-1'), {
    requestId: `${requestId}-verdict`, taskId: current.id, expectedRevision: current.revision,
    validations: [{ artifactId: REF.id, candidateVersion: REF.version, outcome: 'passed', at: AT }]
  });
  return board.updateTask(coordinator('co-1'), {
    requestId: `${requestId}-accept`, taskId: current.id, expectedRevision: current.revision, state: 'accepted'
  });
}

test('manual hard deletion removes the record in every idle state and acknowledges minimally', async t => {
  const fx = await fixture(t);
  const { board } = fx;
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'team', name: 'Alpha', description: '' });

  // ready
  const ready = await task(board, team, 'ready-task');
  const before = Object.keys(board.listTasks(co)).length;
  const ack = await board.deleteTask(co, { requestId: 'del-ready', teamId: team.id, taskId: ready.id, expectedRevision: ready.revision });
  // The acknowledgment is a MINIMAL strict record: no copied task, history or refs.
  assert.deepEqual(Object.keys(ack).sort(), ['coordinatorOwnerId', 'id', 'kind', 'revision', 'teamId']);
  assert.deepEqual(ack, { kind: 'task_deleted', id: ready.id, teamId: team.id, coordinatorOwnerId: 'co-1', revision: ready.revision });
  assert.equal(Object.keys(board.listTasks(co)).length, before - 1);
  assert.equal(await code(Promise.resolve().then(() => board.getTask(co, ready.id))), 'not_found');

  // in_progress (stale, no worker, no completion)
  const running = await task(board, team, 'running-task');
  const started = await board.updateTask(co, { requestId: 'start', taskId: running.id, expectedRevision: running.revision, state: 'in_progress' });
  assert.equal(started.state, 'in_progress');
  assert.deepEqual(await board.deleteTask(co, { requestId: 'del-running', teamId: team.id, taskId: running.id, expectedRevision: started.revision }),
    { kind: 'task_deleted', id: running.id, teamId: team.id, coordinatorOwnerId: 'co-1', revision: started.revision });

  // accepted (accepted is NOT a deletion prerequisite, and deletion adds no transition)
  const accepted = await acceptedTask(board, team, 'accepted-task');
  assert.equal(accepted.state, 'accepted');
  const requestsBefore = Object.keys(JSON.parse(await fs.readFile(fx.file, 'utf8')).requests).length;
  const acceptedAck = await board.deleteTask(co, { requestId: 'del-accepted', teamId: team.id, taskId: accepted.id, expectedRevision: accepted.revision });
  assert.equal(acceptedAck.kind, 'task_deleted');
  assert.deepEqual(board.listTasks(co), [], 'every task record is physically gone');
  const durable = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.deepEqual(durable.tasks, [], 'no tombstone, trash entry or hidden task copy is written');
  assert.equal(Object.keys(durable.requests).length, requestsBefore + 1, 'deletion records exactly one acknowledgment');
  const ackRecord = Object.values(durable.requests).at(-1).result;
  assert.deepEqual(Object.keys(ackRecord).sort(), ['coordinatorOwnerId', 'id', 'kind', 'revision', 'teamId']);
  assert.equal(durable.teams.length, 1, 'the team survives its tasks');
});

test('a remaining dependent blocks deletion with exact ids and titles; the provider deletes after the edge is removed', async t => {
  const fx = await fixture(t);
  const { board } = fx;
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'team', name: 'Dependent team', description: '' });
  const provider = await task(board, team, 'provider', { title: 'Provider contract' });
  const dependent = await board.createTask(co, {
    requestId: 'dependent', teamId: team.id, title: 'Dependent consumer', description: '',
    dependencies: [{ taskId: provider.id, kind: 'contract' }]
  });

  const error = await board.deleteTask(co, { requestId: 'del-blocked', teamId: team.id, taskId: provider.id, expectedRevision: provider.revision })
    .then(() => undefined, value => value);
  assert.equal(error.code, 'task_has_dependents');
  assert.match(error.message, new RegExp(dependent.id), 'the dependent id is reported');
  assert.match(error.message, /Dependent consumer/, 'the dependent title preview is reported');
  assert.equal(board.listTasks(co, team.id).length, 2, 'nothing was removed');

  const unlinked = await board.updateTask(co, {
    requestId: 'unlink', taskId: dependent.id, expectedRevision: dependent.revision, dependencies: []
  });
  assert.equal(unlinked.dependencies.length, 0);
  await board.deleteTask(co, { requestId: 'del-ok', teamId: team.id, taskId: provider.id, expectedRevision: provider.revision });
  assert.deepEqual(board.listTasks(co, team.id).map(task => task.id), [dependent.id]);
});

test('team deletion requires an empty team and reports every remaining task', async t => {
  const fx = await fixture(t);
  const { board } = fx;
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'team', name: 'Non-empty team', description: '' });
  const one = await task(board, team, 'one', { title: 'First task' });
  const two = await task(board, team, 'two', { title: 'Second task' });

  const blocked = await board.deleteTeam(co, { requestId: 'del-team-blocked', teamId: team.id, expectedRevision: team.revision })
    .then(() => undefined, value => value);
  assert.equal(blocked.code, 'team_has_tasks');
  assert.match(blocked.message, new RegExp(one.id));
  assert.match(blocked.message, new RegExp(two.id));
  assert.match(blocked.message, /First task/);

  await board.deleteTask(co, { requestId: 'del-one', teamId: team.id, taskId: one.id, expectedRevision: one.revision });
  await board.deleteTask(co, { requestId: 'del-two', teamId: team.id, taskId: two.id, expectedRevision: two.revision });
  const current = board.getTeam(co, team.id);
  const ack = await board.deleteTeam(co, { requestId: 'del-team', teamId: team.id, expectedRevision: current.revision });
  assert.deepEqual(ack, { kind: 'team_deleted', id: team.id, coordinatorOwnerId: 'co-1', revision: current.revision });
  assert.deepEqual(board.listTeams(co), []);
  assert.equal(await code(Promise.resolve().then(() => board.getTeam(co, team.id))), 'not_found');
});

test('deletion authorization is exact: revision, actor and strict arguments', async t => {
  const fx = await fixture(t);
  const { board } = fx;
  const co = coordinator('co-1');
  const other = coordinator('co-2');
  const team = await board.createTeam(co, { requestId: 'team', name: 'Guarded team', description: '' });
  const otherTeam = await board.createTeam(other, { requestId: 'team-2', name: 'Foreign team', description: '' });
  const target = await task(board, team, 'target');

  assert.equal(await code(board.deleteTask(co, { requestId: 'r1', teamId: team.id, taskId: target.id, expectedRevision: target.revision + 5 })), 'revision_conflict');
  assert.equal(await code(board.deleteTask(other, { requestId: 'r2', teamId: team.id, taskId: target.id, expectedRevision: target.revision })), 'forbidden');
  assert.equal(await code(board.deleteTeam(other, { requestId: 'r3', teamId: team.id, expectedRevision: team.revision })), 'forbidden');
  // The actor is never accepted inside editable data.
  assert.equal(await code(board.deleteTask(co, { requestId: 'r4', teamId: team.id, taskId: target.id, expectedRevision: target.revision, ownerId: 'co-1' })), 'ZodError');
  assert.equal(await code(board.deleteTeam(co, { requestId: 'r5', teamId: team.id, expectedRevision: team.revision, actor: co })), 'ZodError');
  // A task of another team is not reachable through this team id.
  assert.equal(await code(board.deleteTask(co, { requestId: 'r6', teamId: otherTeam.id, taskId: target.id, expectedRevision: target.revision })), 'forbidden');
  assert.equal(board.listTasks(co, team.id).length, 1);
  assert.equal(board.listTeams(co).length, 1);
});

test('an exact retry replays the acknowledgment after reload; changed arguments conflict', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const team = await fx.board.createTeam(co, { requestId: 'team', name: 'Retry team', description: '' });
  const target = await task(fx.board, team, 'retry-task');
  const input = { requestId: 'del-once', teamId: team.id, taskId: target.id, expectedRevision: target.revision };
  const first = await fx.board.deleteTask(co, input);

  // Same process, then a real reload from the durable board.
  assert.deepEqual(await fx.board.deleteTask(co, input), first);
  const reloaded = await fx.open();
  assert.deepEqual(await reloaded.deleteTask(co, input), first, 'the durable acknowledgment answers an exact retry');
  assert.deepEqual(reloaded.listTasks(co), [], 'the replay does not resurrect the record');
  const durable = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.equal(durable.tasks.length, 0);

  // Changed arguments under the same request id conflict instead of deleting again.
  assert.equal(await code(reloaded.deleteTask(co, { ...input, expectedRevision: target.revision + 1 })), 'request_reuse_conflict');
  // A fresh request id finds nothing to delete.
  assert.equal(await code(reloaded.deleteTask(co, { ...input, requestId: 'del-again' })), 'not_found');
});

test('a replayed old create never reinserts a deleted task', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const team = await fx.board.createTeam(co, { requestId: 'team', name: 'Replay team', description: '' });
  const create = { requestId: 'create-once', teamId: team.id, title: 'Replayable task', description: '' };
  const created = await fx.board.createTask(co, create);
  await fx.board.deleteTask(co, { requestId: 'delete-it', teamId: team.id, taskId: created.id, expectedRevision: created.revision });

  const reloaded = await fx.open();
  // The idempotency contract still answers the original call with its original
  // receipt, but that acknowledgment is HISTORY: no record is restored.
  const replay = await reloaded.createTask(co, create);
  assert.equal(replay.id, created.id);
  assert.deepEqual(reloaded.listTasks(co), []);
  assert.equal((await reloaded.snapshot()).tasks.length, 0);
  assert.equal(reloaded.listTasks(co, team.id).length, 0);
  assert.equal(await code(Promise.resolve().then(() => reloaded.getTask(co, created.id))), 'not_found');
  assert.deepEqual(JSON.parse(await fs.readFile(fx.file, 'utf8')).tasks, []);
});

test('receipt rollover survives a deleted team, keeps reference identity and retires old requests', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const team = await fx.board.createTeam(co, { requestId: 'team', name: 'Rollover team', description: '' });
  const target = await fx.board.createTask(co, {
    requestId: 'ref-task', teamId: team.id, title: 'Ref task', description: ''
  });
  const withRef = await fx.board.updateTask(co, {
    requestId: 'ref-candidate', taskId: target.id, expectedRevision: target.revision, candidates: [REF]
  });
  await fx.board.deleteTask(co, { requestId: 'del-ref', teamId: team.id, taskId: target.id, expectedRevision: withRef.revision });
  const emptyTeam = fx.board.getTeam(co, team.id);
  await fx.board.deleteTeam(co, { requestId: 'del-team', teamId: team.id, expectedRevision: emptyTeam.revision });

  const rolled = await fx.board.rolloverReceipts('co-1', 0);
  assert.equal(rolled.epoch, 1, 'rollover resolves the deleted team owner instead of failing not_found');

  const reloaded = await fx.open();
  assert.equal(reloaded.epoch('co-1'), 1);
  assert.deepEqual(reloaded.listTeams(co), []);
  assert.deepEqual(reloaded.listTasks(co), []);
  assert.deepEqual((await reloaded.snapshot()).tasks, []);
  // The archived ref identity is still reserved by the immutable reference history.
  const nextTeam = await reloaded.createTeam(co, { requestId: reloaded.requestId('co-1', 'new-team'), name: 'Next team', description: '' });
  const conflict = await reloaded.createTask(co, {
    requestId: reloaded.requestId('co-1', 'new-task'), teamId: nextTeam.id, title: 'Reuse', description: '',
    assigneeWorkerId: null
  }).then(() => undefined, value => value);
  // The deleted task's immutable ref identity is still retained by the archived
  // receipt set: reference history moves with the receipt, never with the record.
  const durable = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.ok((durable.referenceHistory ?? []).some(entry => entry.taskId === target.id
    && entry.kind === 'candidate' && entry.ref.id === REF.id && entry.ref.version === REF.version && entry.ref.uri === REF.uri),
  'the archived candidate identity of the deleted task is preserved');
  assert.ok(!durable.tasks.some(item => item.id === target.id), 'no task, team or tombstone record of the deleted team survives the rollover');
  // An old unprefixed request is retired by the epoch, never replayed as a fresh delete.
  assert.equal(await code(reloaded.deleteTask(co, { requestId: 'del-ref', teamId: team.id, taskId: target.id, expectedRevision: target.revision })), 'request_expired');
});

test('a trusted cancellation guard refuses before the rename and records nothing', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const team = await fx.board.createTeam(co, { requestId: 'team', name: 'Abort team', description: '' });
  const target = await task(fx.board, team, 'abort-task');
  const input = { requestId: 'del-aborted', teamId: team.id, taskId: target.id, expectedRevision: target.revision };

  // The guard is the caller's trusted abort check, re-applied immediately before
  // the durable rename (exactly like updateTask).
  const aborted = () => { throw Object.assign(new Error('aborted before rename'), { code: 'aborted' }); };
  assert.equal(await code(fx.board.deleteTask(co, input, aborted)), 'aborted');
  assert.equal(fx.board.listTasks(co, team.id).length, 1, 'an aborted delete removed nothing');
  assert.equal(fx.board.hasRequest('co-1', 'del-aborted'), false, 'an aborted delete recorded no request');

  // The same request id is still a fresh operation afterwards, and it commits.
  const ack = await fx.board.deleteTask(co, input);
  assert.equal(ack.kind, 'task_deleted');
  assert.deepEqual(fx.board.listTasks(co, team.id), []);

  // A team delete uses the same guard.
  const second = await fx.board.createTeam(co, { requestId: 'team-2', name: 'Abort team 2', description: '' });
  assert.equal(await code(fx.board.deleteTeam(co, { requestId: 'del-aborted-team', teamId: second.id, expectedRevision: second.revision }, aborted)), 'aborted');
  assert.equal(fx.board.listTeams(co).length, 2, 'an aborted team delete removed nothing');
  assert.equal((await fx.board.deleteTeam(co, { requestId: 'del-aborted-team', teamId: second.id, expectedRevision: second.revision })).kind, 'team_deleted');
});

test('the host-only lookup resolves an owner only from a live team or the exact acknowledgment', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const team = await fx.board.createTeam(co, { requestId: 'team', name: 'Lookup team', description: '' });
  const target = await task(fx.board, team, 'lookup-task');

  assert.deepEqual(fx.board.deletionContext({ kind: 'task', teamId: team.id, taskId: target.id, requestId: 'del-lookup' }), { ownerId: 'co-1', replay: false });
  // A create receipt under a live team never authorizes a delete as a replay.
  assert.deepEqual(fx.board.deletionContext({ kind: 'task', teamId: team.id, taskId: target.id, requestId: 'lookup-task' }), { ownerId: 'co-1', replay: false });
  await fx.board.deleteTask(co, { requestId: 'del-lookup', teamId: team.id, taskId: target.id, expectedRevision: target.revision });
  assert.deepEqual(fx.board.deletionContext({ kind: 'task', teamId: team.id, taskId: target.id, requestId: 'del-lookup' }), { ownerId: 'co-1', replay: true });
  // Wrong request id, wrong task, wrong team and a stale create id resolve to nothing.
  assert.deepEqual(fx.board.deletionContext({ kind: 'task', teamId: team.id, taskId: target.id, requestId: 'lookup-task' }), { ownerId: 'co-1', replay: false });
  // A recorded create id is never delete authority: the exact replay proof refuses it.
  assert.equal(await code(fx.board.deleteTask(co, { requestId: 'lookup-task', teamId: team.id, taskId: target.id, expectedRevision: target.revision })), 'forbidden');
  assert.deepEqual(fx.board.deletionContext({ kind: 'task', teamId: team.id, taskId: w(7), requestId: 'del-lookup' }), { ownerId: 'co-1', replay: false }, 'a live team answers for an unknown task; the delete itself then refuses not_found');
  assert.equal(fx.board.deletionContext({ kind: 'task', teamId: w(9), taskId: target.id, requestId: 'del-lookup' }), undefined);
  // A replay is not a license to delete a different record of the same team.
  const sibling = await task(fx.board, team, 'sibling');
  assert.equal(await code(fx.board.deleteTask(co, { requestId: 'del-lookup', teamId: team.id, taskId: sibling.id, expectedRevision: sibling.revision })), 'forbidden');
  // Foreign coordinator: the exact acknowledgment is bound to its owner.
  assert.equal(await code(fx.board.deleteTask(coordinator('co-2'), { requestId: 'del-lookup', teamId: team.id, taskId: target.id, expectedRevision: target.revision })), 'forbidden');
});

test('deletion leaves worker sessions, foreign roots and unrelated records untouched', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const worker = fx.addWorker(w(1));
  const team = await fx.board.createTeam(co, { requestId: 'team', name: 'Isolated team', description: '' });
  const joined = await fx.board.updateTeam(co, { requestId: 'join', teamId: team.id, expectedRevision: team.revision, addMembers: [worker.id] });
  const assigned = await fx.board.createTask(co, {
    requestId: 'assigned', teamId: team.id, title: 'Assigned task', description: '', assigneeWorkerId: worker.id
  });
  const other = await fx.board.createTeam(co, { requestId: 'team-b', name: 'Other team', description: '' });
  const untouched = await task(fx.board, other, 'untouched');

  const ack = await fx.board.deleteTask(co, { requestId: 'del-assigned', teamId: joined.id, taskId: assigned.id, expectedRevision: assigned.revision });
  assert.equal(ack.kind, 'task_deleted');
  assert.equal(fx.workers.get(worker.id), worker, 'worker sessions are never touched');
  assert.deepEqual(fx.board.listTasks(co, other.id).map(task => task.id), [untouched.id]);
  assert.equal(fx.board.getTeam(co, joined.id).memberWorkerIds.length, 1, 'team membership is unchanged');
  assert.equal(fx.board.getTeam(co, joined.id).revision, joined.revision, 'no team revision side effect');
});
