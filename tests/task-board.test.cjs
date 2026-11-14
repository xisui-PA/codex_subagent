const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskBoard } = require('../.test-build/task-board');
const { limits } = require('../.test-build/task-board-types');
const storage = require('../.test-build/storage');

const coordinator = ownerId => ({ kind: 'coordinator', ownerId });
const workerActor = workerId => ({ kind: 'worker', workerId });
const w = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(32, '0'); // 32-hex worker ids

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-board-test-'));
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
  const board = new TaskBoard(boardDir, workspaceRoot, id => workers.get(id));
  await board.open();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    board, root, workspaceRoot, boardDir, workers, addWorker,
    file: path.join(boardDir, 'task-board.json'),
    open: async () => {
      const next = new TaskBoard(boardDir, workspaceRoot, id => workers.get(id));
      await next.open();
      return next;
    }
  };
}

test('team create/get/list/update with coordinator and member boundaries', async t => {
  const fx = await fixture(t);
  const { board, addWorker, workspaceRoot, root } = fx;
  const w1 = addWorker(w(1));
  const w2 = addWorker(w(2));
  const foreign = addWorker(w(3), { ownerId: 'co-2' });
  const otherRoot = addWorker(w(4), { root: path.join(root, 'other-ws') });
  const co = coordinator('co-1');
  const otherCo = coordinator('co-2');

  const team = await board.createTeam(co, { requestId: 'r-create', name: 'Alpha', description: 'first team' });
  assert.ok(team.id && team.id.length === 32);
  assert.equal(team.revision, 0);
  assert.equal(team.workspaceRoot, path.resolve(workspaceRoot));
  assert.equal(team.coordinatorOwnerId, 'co-1');
  assert.deepEqual(team.memberWorkerIds, []);
  assert.equal(team.history.entries.length, 1);
  assert.equal(team.history.entries[0].reason, 'created');
  assert.deepEqual(team.history.entries[0].actor, co);

  const listed = await board.listTeams(co);
  assert.deepEqual(listed.map(x => x.id), [team.id]);
  const viewed = await board.getTeam(co, team.id);
  assert.equal(viewed.name, 'Alpha');

  const updated = await board.updateTeam(co, {
    requestId: 'r-members', teamId: team.id, expectedRevision: 0, addMembers: [w1.id, w2.id]
  });
  assert.equal(updated.revision, 1);
  assert.deepEqual(updated.memberWorkerIds, [w1.id, w2.id]);

  // Defensive clone: mutating a returned record must not corrupt the board.
  updated.name = 'mutated'; updated.memberWorkerIds.push('x');
  assert.equal((await board.getTeam(co, team.id)).name, 'Alpha');

  // Member workers may read their own team; nobody else can.
  assert.equal((await board.getTeam(workerActor(w1.id), team.id)).id, team.id);
  assert.deepEqual((await board.listTeams(workerActor(w1.id))).map(x => x.id), [team.id]);
  assert.throws(() => board.getTeam(workerActor(foreign.id), team.id), { code: 'forbidden' });
  assert.deepEqual(await board.listTeams(workerActor(foreign.id)), []);
  await assert.rejects(board.createTeam(workerActor(w1.id), { requestId: 'r-w', name: 'No', description: '' }), { code: 'forbidden' });
  await assert.rejects(board.updateTeam(workerActor(w1.id), { requestId: 'r-w2', teamId: team.id, expectedRevision: 1, name: 'X' }), { code: 'forbidden' });
  assert.throws(() => board.getTeam(otherCo, team.id), { code: 'forbidden' });
  assert.throws(() => board.getTeam(co, '0'.repeat(32)), { code: 'not_found' });
  assert.deepEqual(await board.listTeams(workerActor('f'.repeat(32))), []);

  // Membership requires an existing worker with the same root AND coordinator.
  await assert.rejects(board.updateTeam(co, { requestId: 'r-own', teamId: team.id, expectedRevision: 1, addMembers: [foreign.id] }), { code: 'member_invalid' });
  await assert.rejects(board.updateTeam(co, { requestId: 'r-root', teamId: team.id, expectedRevision: 1, addMembers: [otherRoot.id] }), { code: 'member_invalid' });
  await assert.rejects(board.updateTeam(co, { requestId: 'r-miss', teamId: team.id, expectedRevision: 1, addMembers: [w(6)] }), { code: 'not_found' });

  const renamed = await board.updateTeam(co, {
    requestId: 'r-rename', teamId: team.id, expectedRevision: 1, name: 'Alpha 2', description: 'updated', removeMembers: [w2.id]
  });
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.name, 'Alpha 2');
  assert.deepEqual(renamed.memberWorkerIds, [w1.id]);
});

test('concurrent stale team revisions: exactly one succeeds', async t => {
  const { board } = await fixture(t);
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'c1', name: 'Beta', description: '' });
  const a = board.updateTeam(co, { requestId: 'u-a', teamId: team.id, expectedRevision: 0, name: 'A' });
  const b = board.updateTeam(co, { requestId: 'u-b', teamId: team.id, expectedRevision: 0, name: 'B' });
  const results = await Promise.allSettled([a, b]);
  const ok = results.filter(r => r.status === 'fulfilled');
  const failed = results.filter(r => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'revision_conflict');
  const final = await board.getTeam(co, team.id);
  assert.equal(final.revision, 1);
  assert.equal(final.name, ok[0].value.name);
  // The losing requestId is free to be retried with fresh expectations.
  const loser = results[0].status === 'rejected' ? 'u-a' : 'u-b';
  const retry = await board.updateTeam(co, { requestId: loser, teamId: team.id, expectedRevision: 1, name: 'C' });
  assert.equal(retry.revision, 2);
});

test('durable idempotency: identical retries replay the original result, changed args fail', async t => {
  const { board, open } = await fixture(t);
  const co = coordinator('co-1');
  const input = { requestId: 'create-1', name: 'Gamma', description: 'desc' };
  const created = await board.createTeam(co, input);
  // Retry with different key order is the same canonical input.
  const reordered = { name: input.name, description: input.description, requestId: input.requestId };
  const replayed = await board.createTeam(co, reordered);
  assert.deepEqual(replayed, created);
  assert.equal(replayed.id, created.id);
  assert.deepEqual((await board.listTeams(co)).map(x => x.id), [created.id]);

  // Same key, changed arguments: conflict, and the record stays as originally committed.
  await assert.rejects(
    board.createTeam(co, { requestId: 'create-1', name: 'Different', description: 'desc' }),
    { code: 'request_reuse_conflict' }
  );
  assert.equal((await board.getTeam(co, created.id)).name, 'Gamma');

  // Two sequential updates, then reload: replaying an earlier request returns the ORIGINAL
  // result even though later revisions exist.
  const step1 = await board.updateTeam(co, { requestId: 'step-1', teamId: created.id, expectedRevision: 0, name: 'Gamma 1' });
  const step2 = await board.updateTeam(co, { requestId: 'step-2', teamId: created.id, expectedRevision: 1, description: 'd2' });
  assert.equal(step1.revision, 1);
  assert.equal(step2.revision, 2);
  const reloaded = await open();
  const replayStep1 = await reloaded.updateTeam(co, { requestId: 'step-1', teamId: created.id, expectedRevision: 0, name: 'Gamma 1' });
  const replayStep2 = await reloaded.updateTeam(co, { requestId: 'step-2', teamId: created.id, expectedRevision: 1, description: 'd2' });
  assert.equal(replayStep1.name, 'Gamma 1');
  assert.equal(replayStep1.history.lastSequence, 2);
  assert.equal(replayStep2.name, 'Gamma 1');
  assert.equal(replayStep2.description, 'd2');
  assert.equal(replayStep2.history.lastSequence, 3);
  assert.equal(replayStep1.revision, 1);
  assert.equal(replayStep2.revision, 2);
  assert.equal((await reloaded.getTeam(co, created.id)).revision, 2);
  // A stale retry under an already-used key with different arguments is a conflict, not an update.
  await assert.rejects(reloaded.updateTeam(co, { requestId: 'step-1', teamId: created.id, expectedRevision: 9, name: 'late' }), { code: 'request_reuse_conflict' });
});

test('durable state survives reload without a second lock', async t => {
  const { board, open, addWorker } = await fixture(t);
  const co = coordinator('co-1');
  const member = addWorker(w(1));
  const team = await board.createTeam(co, { requestId: 'c1', name: 'Delta', description: 'persist' });
  await board.updateTeam(co, { requestId: 'c2', teamId: team.id, expectedRevision: 0, addMembers: [member.id] });
  const reloaded = await open();
  const same = await reloaded.getTeam(co, team.id);
  assert.equal(same.revision, 1);
  assert.deepEqual(same.memberWorkerIds, [member.id]);
  assert.equal(same.name, 'Delta');
  // Idempotent replay of the member update after reload adds no duplicate member.
  const replay = await reloaded.updateTeam(co, { requestId: 'c2', teamId: team.id, expectedRevision: 0, addMembers: [member.id] });
  assert.deepEqual(replay.memberWorkerIds, [member.id]);
  assert.equal((await reloaded.getTeam(co, team.id)).revision, 1);
});

test('corrupt or foreign-root board data fails closed without modification', async t => {
  const { board, file, open, workspaceRoot } = await fixture(t);
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'c1', name: 'Eps', description: '' });
  const pristine = await fs.readFile(file, 'utf8');

  const garbage = '{ not valid json';
  await fs.writeFile(file, garbage, { mode: 0o600 });
  await assert.rejects(open(), { code: 'board_malformed' });
  assert.equal(await fs.readFile(file, 'utf8'), garbage);

  const foreign = JSON.parse(pristine);
  foreign.workspaceRoot = path.join(workspaceRoot, 'elsewhere');
  await fs.writeFile(file, JSON.stringify(foreign), { mode: 0o600 });
  await assert.rejects(open(), { code: 'board_malformed' });
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(foreign));

  const broken = JSON.parse(pristine);
  broken.teams.push(structuredClone(team)); // duplicate id
  await fs.writeFile(file, JSON.stringify(broken), { mode: 0o600 });
  await assert.rejects(open(), { code: 'board_malformed' });

  await fs.writeFile(file, pristine, { mode: 0o600 });
  const ok = await open();
  assert.equal((await ok.listTeams(co)).length, 1);
});

test('failed disk write leaves prior memory and disk state intact', async t => {
  const { board, file } = await fixture(t);
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'c1', name: 'Zeta', description: '' });
  const before = await fs.readFile(file, 'utf8');
  const realAtomicWrite = storage.atomicWrite;
  let failNext = true;
  t.after(() => { storage.atomicWrite = realAtomicWrite; });
  storage.atomicWrite = async (...args) => {
    if (failNext) {
      failNext = false;
      throw new Error('simulated disk failure');
    }
    return realAtomicWrite(...args);
  };
  const failure = assert.rejects(board.updateTeam(co, { requestId: 'fail', teamId: team.id, expectedRevision: 0, name: 'gone' }));
  assert.equal((await board.getTeam(co, team.id)).revision, 0);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await failure;
  // The failed requestId was never committed and can be used again.
  const retry = await board.updateTeam(co, { requestId: 'fail', teamId: team.id, expectedRevision: 0, name: 'ok' });
  assert.equal(retry.revision, 1);
  assert.equal(retry.name, 'ok');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).teams[0].revision, 1);
});

test('team history is bounded with monotonic sequence and trim metadata', async t => {
  const original = limits.history;
  limits.history = 5;
  t.after(() => { limits.history = original; });
  const { board } = await fixture(t);
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'c1', name: 'Hist', description: '' });
  let revision = 0;
  for (let i = 0; i < 8; i++) {
    const next = await board.updateTeam(co, { requestId: `u-${i}`, teamId: team.id, expectedRevision: revision, name: `Hist ${i}` });
    revision = next.revision;
  }
  assert.equal(revision, 8);
  const final = await board.getTeam(co, team.id);
  assert.equal(final.history.entries.length, 5);
  assert.equal(final.history.lastSequence, 9);
  assert.equal(final.history.trimmed, 4);
  const seqs = final.history.entries.map(e => e.seq);
  assert.deepEqual(seqs, [5, 6, 7, 8, 9]);
  assert.ok(final.history.entries.every(e => e.reason === 'name'));
  assert.equal(final.history.entries.at(-1).reason, 'name');
});

test('board and request storage are bounded with explicit capacity errors', async t => {
  const originalRequests = limits.requests;
  const originalTeams = limits.teams;
  limits.requests = 4;
  limits.teams = 1;
  t.after(() => { limits.requests = originalRequests; limits.teams = originalTeams; });
  const { board } = await fixture(t);
  const co = coordinator('co-1');
  await board.createTeam(co, { requestId: 'c1', name: 'One', description: '' });
  await assert.rejects(board.createTeam(co, { requestId: 'c2', name: 'Two', description: '' }), { code: 'capacity_exceeded' });
  // At the team cap the board is still fully readable.
  const team = (await board.listTeams(co))[0];
  await board.updateTeam(co, { requestId: 'u1', teamId: team.id, expectedRevision: 0, name: 'A' });
  await board.updateTeam(co, { requestId: 'u2', teamId: team.id, expectedRevision: 1, name: 'B' });
  await board.updateTeam(co, { requestId: 'u3', teamId: team.id, expectedRevision: 2, name: 'C' });
  await assert.rejects(board.updateTeam(co, { requestId: 'u4', teamId: team.id, expectedRevision: 3, name: 'D' }), { code: 'capacity_exceeded' });
  // Replay keys are never evicted: earlier requests still replay at full capacity.
  const replay = await board.createTeam(co, { requestId: 'c1', name: 'One', description: '' });
  assert.equal(replay.name, 'One');
  assert.equal((await board.listTeams(co)).length, 1);
});

test('task create/read/list/snapshot with defensive clones and boundaries', async t => {
  const fx = await fixture(t);
  const { board, addWorker } = fx;
  const co = coordinator('co-1');
  const member = addWorker(w(1));
  const otherRoot = addWorker(w(2), { root: '/nope' });
  const team = await board.createTeam(co, { requestId: 'c1', name: 'T', description: '' });
  await board.updateTeam(co, { requestId: 'c2', teamId: team.id, expectedRevision: 0, addMembers: [member.id] });

  const task = await board.createTask(co, { requestId: 't1', teamId: team.id, title: 'Do it', description: '' });
  assert.ok(task.id && task.id.length === 32);
  assert.equal(task.state, 'ready');
  assert.equal(task.revision, 0);
  assert.equal(task.progress, '');
  assert.deepEqual(task.blockers, []);
  assert.deepEqual(task.candidates, []);
  assert.deepEqual(task.agreedContracts, []);
  assert.deepEqual(task.validations, []);
  assert.deepEqual(task.acceptanceCriteria, []);
  assert.deepEqual(task.dependencies, []);
  assert.equal(task.assigneeWorkerId, null);
  assert.equal(task.history.entries.length, 1);
  assert.equal(task.history.entries[0].reason, 'created');

  const view = board.getTask(co, task.id);
  assert.equal(view.id, task.id);
  assert.equal(view.readiness.ready, true);
  assert.deepEqual(view.readiness.unmetDependencies, []);
  assert.deepEqual(view.readiness.blockers, []);
  assert.equal('readiness' in task, false); // mutation result is the base task (no derived readiness)

  view.readiness.blockers.push('x');
  assert.equal(board.getTask(co, task.id).readiness.ready, true);

  assert.deepEqual(board.listTasks(co).map(x => x.id), [task.id]);
  assert.deepEqual(board.listTasks(co, team.id).map(x => x.id), [task.id]);
  assert.throws(() => board.getTask(co, '0'.repeat(32)), { code: 'not_found' });
  assert.throws(() => board.getTask(co, ''), { code: 'invalid_arguments' });

  // Worker member reads; outsider and foreign root cannot.
  assert.equal(board.getTask(workerActor(member.id), task.id).id, task.id);
  assert.throws(() => board.getTask(workerActor(otherRoot.id), task.id), { code: 'forbidden' });
  assert.deepEqual(board.listTasks(workerActor(otherRoot.id)), []);
  await assert.rejects(board.createTask(workerActor(member.id), { requestId: 'wt', teamId: team.id, title: 'No', description: '' }), { code: 'forbidden' });

  // Snapshot is trusted, cloned, and carries derived readiness.
  const snap = board.snapshot();
  assert.equal(snap.workspaceRoot, path.resolve(fx.workspaceRoot));
  assert.equal(snap.teams.length, 1);
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.tasks[0].readiness.ready, true);
  snap.tasks[0].title = 'mutated';
  assert.equal(board.getTask(co, task.id).title, 'Do it');
});

test('concurrent active assignment: exactly one wins across teams', async t => {
  const fx = await fixture(t);
  const { board, addWorker } = fx;
  const co = coordinator('co-1');
  const member = addWorker(w(1));
  const teamA = await board.createTeam(co, { requestId: 'a', name: 'A', description: '' });
  const teamB = await board.createTeam(co, { requestId: 'b', name: 'B', description: '' });
  await board.updateTeam(co, { requestId: 'am', teamId: teamA.id, expectedRevision: 0, addMembers: [member.id] });
  await board.updateTeam(co, { requestId: 'bm', teamId: teamB.id, expectedRevision: 0, addMembers: [member.id] });
  const a = board.createTask(co, { requestId: 'ta', teamId: teamA.id, title: 'A1', description: '', assigneeWorkerId: member.id });
  const b = board.createTask(co, { requestId: 'tb', teamId: teamB.id, title: 'B1', description: '', assigneeWorkerId: member.id });
  const results = await Promise.allSettled([a, b]);
  const ok = results.filter(r => r.status === 'fulfilled');
  const failed = results.filter(r => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'assignment_conflict');
  const active = board.listTasks(co).filter(x => x.assigneeWorkerId === member.id && x.state === 'ready');
  assert.equal(active.length, 1);
  assert.equal(active[0].id, ok[0].value.id);
  // Non-member assignee is rejected before any write.
  await assert.rejects(board.createTask(co, { requestId: 'tc', teamId: teamA.id, title: 'C', description: '', assigneeWorkerId: w(9) }), { code: 'not_found' });
});

test('duplicate task create replays the original receipt after reload', async t => {
  const fx = await fixture(t);
  const { board, open, addWorker } = fx;
  const co = coordinator('co-1');
  const member = addWorker(w(1));
  const team = await board.createTeam(co, { requestId: 'c1', name: 'T', description: '' });
  await board.updateTeam(co, { requestId: 'c2', teamId: team.id, expectedRevision: 0, addMembers: [member.id] });
  const input = { requestId: 't1', teamId: team.id, title: 'Work', description: '', assigneeWorkerId: member.id };
  const created = await board.createTask(co, input);
  const reordered = { teamId: input.teamId, assigneeWorkerId: input.assigneeWorkerId, description: input.description, title: input.title, requestId: input.requestId };
  const replayed = await board.createTask(co, reordered);
  assert.deepEqual(replayed, created);
  const reloaded = await open();
  const again = await reloaded.createTask(co, input);
  assert.equal(again.id, created.id);
  assert.deepEqual(reloaded.listTasks(co).map(x => x.id), [created.id]);
  assert.equal(reloaded.snapshot().tasks.length, 1);
  // No duplicate assignment: still exactly one task assigned to the worker.
  assert.equal(reloaded.listTasks(co).filter(x => x.assigneeWorkerId === member.id).length, 1);
});

test('invalid and cross-team dependencies are rejected on create', async t => {
  const fx = await fixture(t);
  const { board } = fx;
  const co = coordinator('co-1');
  const teamA = await board.createTeam(co, { requestId: 'a', name: 'A', description: '' });
  const teamB = await board.createTeam(co, { requestId: 'b', name: 'B', description: '' });
  const t1 = await board.createTask(co, { requestId: 't1', teamId: teamA.id, title: 'One', description: '' });
  await board.createTask(co, { requestId: 't2', teamId: teamA.id, title: 'Two', description: '', dependencies: [{ taskId: t1.id, kind: 'contract' }] });
  // Missing dependency.
  await assert.rejects(board.createTask(co, { requestId: 'd1', teamId: teamA.id, title: 'D1', description: '', dependencies: [{ taskId: '0'.repeat(32), kind: 'contract' }] }), { code: 'dependency_invalid' });
  // Duplicate dependency on the same target.
  const d3 = await board.createTask(co, { requestId: 'd3', teamId: teamA.id, title: 'D3', description: '' });
  await assert.rejects(board.createTask(co, { requestId: 'd4', teamId: teamA.id, title: 'D4', description: '', dependencies: [{ taskId: d3.id, kind: 'contract' }, { taskId: d3.id, kind: 'contract' }] }), { code: 'dependency_invalid' });
  // Both kinds to the same producer are distinct keys and therefore allowed.
  const d6 = await board.createTask(co, { requestId: 'd6', teamId: teamA.id, title: 'D6', description: '', dependencies: [{ taskId: d3.id, kind: 'contract' }, { taskId: d3.id, kind: 'artifact' }] });
  assert.equal(d6.dependencies.length, 2);
  // Cross-team dependency.
  const tB = await board.createTask(co, { requestId: 'tB', teamId: teamB.id, title: 'B1', description: '' });
  await assert.rejects(board.createTask(co, { requestId: 'd5', teamId: teamA.id, title: 'D5', description: '', dependencies: [{ taskId: tB.id, kind: 'contract' }] }), { code: 'dependency_invalid' });
});

test('durable dependency cycle fails closed on open', async t => {
  const fx = await fixture(t);
  const { board, file, open } = fx;
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'c1', name: 'T', description: '' });
  const base = JSON.parse(await fs.readFile(file, 'utf8'));
  const mk = (id, deps) => ({
    id, teamId: team.id, title: id, description: '', acceptanceCriteria: [], dependencies: deps,
    assigneeWorkerId: null, progress: '', blockers: [], state: 'ready', candidates: [], agreedContracts: [],
    validations: [], revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    history: { entries: [], lastSequence: 0, trimmed: 0 }
  });
  base.tasks.push(mk('a'.repeat(32), [{ taskId: 'b'.repeat(32), kind: 'contract' }]));
  base.tasks.push(mk('b'.repeat(32), [{ taskId: 'a'.repeat(32), kind: 'artifact' }]));
  await fs.writeFile(file, JSON.stringify(base), { mode: 0o600 });
  await assert.rejects(open(), { code: 'board_malformed' });
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(base));
});

test('readiness: contract vs artifact dependencies', async t => {
  const fx = await fixture(t);
  const { board, file, open } = fx;
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'c1', name: 'T', description: '' });
  const producerContract = await board.createTask(co, { requestId: 'pc', teamId: team.id, title: 'PC', description: '' });
  const producerArtifact = await board.createTask(co, { requestId: 'pa', teamId: team.id, title: 'PA', description: '' });
  const consumer = await board.createTask(co, {
    requestId: 'consumer', teamId: team.id, title: 'C', description: '',
    dependencies: [
      { taskId: producerContract.id, kind: 'contract' },
      { taskId: producerArtifact.id, kind: 'artifact' }
    ]
  });
  let view = board.getTask(co, consumer.id);
  assert.equal(view.readiness.ready, false);
  assert.equal(view.readiness.unmetDependencies.length, 2);
  assert.deepEqual(view.readiness.unmetDependencies.find(d => d.taskId === producerContract.id), { taskId: producerContract.id, kind: 'contract', reason: 'producer has no agreed contracts' });
  assert.equal(view.readiness.unmetDependencies.find(d => d.taskId === producerArtifact.id).reason, 'producer is not accepted with candidate artifacts');

  // Seed a valid durable state, then read a FRESH board (the initial instance keeps its checkpoint in memory).
  // Producer contract agreed; artifact producer accepted with a candidate AND a passed validation.
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.tasks.find(x => x.id === producerContract.id).agreedContracts = [{ id: 'c1', version: 1, uri: 'file://contract' }];
  const pa = data.tasks.find(x => x.id === producerArtifact.id);
  pa.state = 'accepted';
  pa.candidates = [{ id: 'art1', version: 1, uri: 'file://artifact' }];
  pa.validations = [{ artifactId: 'art1', candidateVersion: 1, outcome: 'passed', at: new Date().toISOString() }];
  await fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
  view = (await open()).getTask(co, consumer.id);
  assert.equal(view.readiness.ready, true);
  assert.deepEqual(view.readiness.unmetDependencies, []);

  // An explicit blocker on the consumer makes it not ready even with all deps met.
  const blocked = JSON.parse(await fs.readFile(file, 'utf8'));
  blocked.tasks.find(x => x.id === consumer.id).blockers = ['waiting on review'];
  await fs.writeFile(file, JSON.stringify(blocked), { mode: 0o600 });
  view = (await open()).getTask(co, consumer.id);
  assert.equal(view.readiness.ready, false);
  assert.deepEqual(view.readiness.blockers, ['waiting on review']);
});

test('restarting a failed task rechecks the live assignee', async t => {
  const fx = await fixture(t);
  const { board, open } = fx;
  const co = coordinator('co-1');
  const member = fx.addWorker(w(1));
  const team = await board.createTeam(co, { requestId: 'c1', name: 'T', description: '' });
  await board.updateTeam(co, { requestId: 'c2', teamId: team.id, expectedRevision: 0, addMembers: [member.id] });
  const unassigned = await board.createTask(co, { requestId: 't-un', teamId: team.id, title: 'Un', description: '' });
  await assert.rejects(
    board.updateTask(workerActor(member.id), { requestId: 'w-un', taskId: unassigned.id, expectedRevision: 0, state: 'in_progress' }),
    { code: 'forbidden' }
  );
  const task = await board.createTask(co, { requestId: 't1', teamId: team.id, title: 'Owned', description: '', assigneeWorkerId: member.id });
  await board.updateTask(workerActor(member.id), { requestId: 'w-start', taskId: task.id, expectedRevision: 0, state: 'in_progress' });
  await board.updateTask(workerActor(member.id), { requestId: 'w-fail', taskId: task.id, expectedRevision: 1, state: 'failed' });
  assert.equal(board.getTask(co, task.id).state, 'failed');
  // Drop the worker from the live session registry so the next live check cannot find it.
  fx.workers.delete(member.id);
  await assert.rejects(
    board.updateTask(co, { requestId: 'c-ready', taskId: task.id, expectedRevision: 2, state: 'ready' }),
    { code: 'not_found' }
  );
  // The assignee is still recorded; re-eligibility is rechecked before any write.
  assert.equal(board.getTask(co, task.id).state, 'failed');
  assert.equal(board.getTask(co, task.id).revision, 2);
  assert.equal(board.getTask(co, task.id).assigneeWorkerId, member.id);
  // The coordinator clears the assignee, then the failed->ready reset re-checks the (now absent) worker.
  await board.updateTask(co, { requestId: 'c-clear', taskId: task.id, expectedRevision: 2, assigneeWorkerId: null, state: 'ready' });
  assert.equal(board.getTask(co, task.id).state, 'ready');
  // Reload keeps the historical 'failed' entry and still opens cleanly.
  const reloaded = await open();
  const view = reloaded.getTask(co, task.id);
  assert.equal(view.state, 'ready');
  assert.ok(view.history.entries.some(entry => entry.reason.includes('failed')));
});

test('contract consumers start once agreed; removal stays blocked while a consumer is active', async t => {
  const fx = await fixture(t);
  const { board } = fx;
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'c1', name: 'T', description: '' });
  const producer = await board.createTask(co, { requestId: 'p1', teamId: team.id, title: 'Producer', description: '' });
  const consumer = await board.createTask(co, {
    requestId: 'k1', teamId: team.id, title: 'Consumer', description: '',
    dependencies: [{ taskId: producer.id, kind: 'contract' }]
  });
  // Start denied before the producer has agreed a contract.
  await assert.rejects(
    board.updateTask(co, { requestId: 'k-start0', taskId: consumer.id, expectedRevision: 0, state: 'in_progress' }),
    { code: 'transition_blocked' }
  );
  await board.updateTask(co, {
    requestId: 'p-agree', taskId: producer.id, expectedRevision: 0,
    agreedContracts: { add: [{ id: 'c1', version: 1, uri: 'mem:c1/1' }] }
  });
  // Start succeeds WHILE the producer is still ready (implementation, not acceptance, gates the start).
  const started = await board.updateTask(co, { requestId: 'k-start1', taskId: consumer.id, expectedRevision: 0, state: 'in_progress' });
  assert.equal(started.state, 'in_progress');
  assert.equal(board.getTask(co, producer.id).state, 'ready');
  // Removing the agreed contract is blocked while the consumer is in_progress; nothing changes.
  const before = board.getTask(co, producer.id);
  const bytesBefore = await fs.readFile(fx.file, 'utf8');
  await assert.rejects(
    board.updateTask(co, {
      requestId: 'p-remove', taskId: producer.id, expectedRevision: 1,
      agreedContracts: { remove: [{ id: 'c1', version: 1 }] }
    }),
    { code: 'contract_in_use' }
  );
  assert.equal(board.getTask(co, producer.id).revision, before.revision);
  assert.equal(board.getTask(co, producer.id).agreedContracts.length, 1);
  assert.equal(await fs.readFile(fx.file, 'utf8'), bytesBefore);
  // An artifact consumer on the same producer stays blocked: readiness needs acceptance, not agreement.
  const artifactConsumer = await board.createTask(co, {
    requestId: 'a1', teamId: team.id, title: 'Artifact consumer', description: '',
    dependencies: [{ taskId: producer.id, kind: 'artifact' }]
  });
  await assert.rejects(
    board.updateTask(co, { requestId: 'a-start', taskId: artifactConsumer.id, expectedRevision: 0, state: 'in_progress' }),
    { code: 'transition_blocked' }
  );
});

test('close drains in-flight mutations then rejects new and queued calls', async t => {
  const fx = await fixture(t);
  const { board } = fx;
  const co = coordinator('co-1');
  const team = await board.createTeam(co, { requestId: 'c1', name: 'T', description: '' });
  const realAtomicWrite = storage.atomicWrite;
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const enteredSignal = new Promise(resolve => { entered = resolve; });
  t.after(() => { if (release) release(); storage.atomicWrite = realAtomicWrite; });
  storage.atomicWrite = async (...args) => {
    entered();
    await gate;
    return realAtomicWrite(...args);
  };
  const inFlight = board.updateTeam(co, { requestId: 'u1', teamId: team.id, expectedRevision: 0, name: 'Draining' });
  await enteredSignal;
  // A REAL queued mutation (already enqueued behind the in-flight write) must reject host_stopping.
  const queued = board.updateTeam(co, { requestId: 'u2', teamId: team.id, expectedRevision: 1, name: 'Queued' });
  const queuedReject = assert.rejects(queued, { code: 'host_stopping' });
  // Now close; it must not resolve until the in-flight write drains.
  const closing = board.close();
  // A fresh mutation and fresh reads reject immediately via the outer check, not by queueing.
  const fresh = board.updateTeam(co, { requestId: 'u3', teamId: team.id, expectedRevision: 1, name: 'Fresh' });
  const freshReject = assert.rejects(fresh, { code: 'host_stopping' });
  assert.throws(() => board.getTeam(co, team.id), { code: 'host_stopping' });
  assert.throws(() => board.getTask(co, '0'.repeat(32)), { code: 'host_stopping' });
  assert.throws(() => board.snapshot(), { code: 'host_stopping' });
  // Drain the in-flight write; it must complete and persist.
  release();
  const drained = await inFlight;
  assert.equal(drained.name, 'Draining');
  await queuedReject;
  await freshReject;
  await closing;
  assert.equal((JSON.parse(await fs.readFile(fx.file, 'utf8')).teams[0]).name, 'Draining');
  assert.throws(() => board.getTeam(co, team.id), { code: 'host_stopping' });
});
