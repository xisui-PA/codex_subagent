const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkerBroker, unpack } = require('../.test-build/runtime');
const { defaults } = require('../.test-build/engine');
const { failure } = require('../.test-build/types');
const { workspaceDirectory } = require('../.test-build/workspaces');
const { model, until } = require('./helpers.cjs');

/**
 * Host-runtime task board wiring.
 *  - RuntimeOptions.taskBoardEnabled gates every board surface and defaults off.
 *  - The 8 board operations go through broker.invoke(root, name, {ownerId, ...});
 *    listings answer { teams|tasks, nextOffset } pages.
 *  - subagent_health reports taskBoard: { enabled, error? }; broker.boardStatus()
 *    returns per-root summary rows and ui_board_snapshot is its internal view.
 * Worker board tools exist only for team members and never accept work.
 */

const OWNER = 'board-owner';
const OTHER_OWNER = 'intruder-owner';
const TEAM_FALLBACK = 'a'.repeat(32);
const TASK_FALLBACK = '1'.repeat(32);
const BOARD_PREFIX = /^subagent_(team|task)_/;
const ARTIFACT = { id: 'artifact-a', version: 1, uri: 'file:///artifact-a.v1.txt' };

const entity = (value, key) => value && typeof value === 'object' && value[key] && typeof value[key] === 'object' ? value[key] : value;
const taskOf = value => entity(value, 'task');
const teamOf = value => entity(value, 'team');
const listOf = (value, key) => Array.isArray(value) ? value : value?.[key] ?? [];
const statuses = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
const safe = text => { try { return JSON.parse(text); } catch { return undefined; } };
const pick = value => {
  const task = taskOf(value);
  if (task && typeof task === 'object' && typeof task.id === 'string' && typeof task.revision === 'number') {
    return task;
  }
  const [first] = listOf(value, 'tasks');
  return first;
};

async function fixture(t, stream) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-board-')));
  const root = path.join(temporary, 'repo');
  await fs.mkdir(root);
  const requests = [];
  const provider = {
    models: async () => [model],
    countTokens: async () => 10,
    async *stream(selected, messages, tools, signal) {
      requests.push({ model: selected, messages, tools });
      yield* stream(selected, messages, tools, signal);
    },
  };
  const options = {
    storage: path.join(temporary, 'storage'), registry: path.join(temporary, 'registry'), roots: [root], identity: `folder:${root}`,
    provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { allowWrite: true, numSessions: 2 } } }),
    files: { canWrite: () => true, allowShell: () => false }, onChange() {}, onError() {},
  };
  const brokers = [];
  const create = async extra => {
    const broker = new WorkerBroker({ ...options, ...extra });
    brokers.push(broker);
    await broker.start();
    return broker;
  };
  t.after(async () => {
    for (const broker of brokers.reverse()) { await broker.close(); }
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { root, temporary, options, create, requests };
}

const idle = async function* () { yield { type: 'text', text: 'idle' }; };
const done = async (broker, root, id) => {
  await until(async () => !['queued', 'running'].includes((await broker.session(root, id)).state));
  return broker.session(root, id);
};
const call = async (broker, root, name, args) => unpack(await broker.invoke(root, name, args));
const errorOf = async (broker, root, name, args) => {
  try {
    await call(broker, root, name, args);
    return undefined;
  } catch (error) {
    return failure(error);
  }
};
const hasBoardTools = request => request.tools.some(tool => BOARD_PREFIX.test(tool.name));
const boardToolNames = request => request.tools.map(tool => tool.name).filter(name => BOARD_PREFIX.test(name)).sort();
/** Compare records or bare ids: call sites pass ids while status rows are records. */
const idOf = entry => typeof entry === 'string' ? entry : entry?.id;
const sameIds = (values, expected) => assert.deepEqual(values.map(idOf).sort(), expected.map(idOf).sort());

/** Every board operation with minimal, otherwise valid arguments; ids need not exist. */
const probes = ownerId => [
  ['subagent_team_create', { ownerId, requestId: 'probe-team', name: 'Probe', description: 'probe' }],
  ['subagent_team_get', { ownerId, id: TEAM_FALLBACK }],
  ['subagent_team_list', { ownerId }],
  ['subagent_team_update', { ownerId, requestId: 'probe-team-update', teamId: TEAM_FALLBACK, expectedRevision: 0 }],
  ['subagent_task_create', { ownerId, requestId: 'probe-task', teamId: TEAM_FALLBACK, title: 'Probe', description: 'probe' }],
  ['subagent_task_get', { ownerId, id: TASK_FALLBACK }],
  ['subagent_task_list', { ownerId }],
  ['subagent_task_update', { ownerId, requestId: 'probe-task-update', taskId: TASK_FALLBACK, expectedRevision: 0 }],
];

async function findBoardFiles(directory) {
  const found = [];
  const walk = async at => {
    const entries = await fs.readdir(at, { withFileTypes: true });
    for (const entry of entries) {
      const next = path.join(at, entry.name);
      if (entry.isDirectory()) { await walk(next); } else if (entry.name === 'task-board.json') { found.push(next); }
    }
  };
  if (await fs.stat(directory).then(stat => stat.isDirectory(), () => false)) { await walk(directory); }
  return found;
}

/** Team, optional members, and one assigned task; records require non-empty descriptions. */
async function seed(broker, root, members = []) {
  const team = teamOf(await call(broker, root, 'subagent_team_create', { ownerId: OWNER, requestId: 'seed-team', name: 'Seeded team', description: 'Shared work' }));
  const joined = members.length
    ? teamOf(await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: 'seed-members', teamId: team.id, expectedRevision: team.revision, addMembers: members }))
    : team;
  const assignee = members.length ? members[0] : undefined;
  const task = taskOf(await call(broker, root, 'subagent_task_create', {
    ownerId: OWNER, requestId: 'seed-task', teamId: team.id, title: 'Seeded task', description: 'Seeded work item',
    acceptanceCriteria: ['Records stay consistent'], ...(assignee ? { assigneeWorkerId: assignee } : {}),
  }));
  return { team: joined, task };
}

test('the board is off by default: every board call is refused and no board state is created', async t => {
  const { root, options, create, requests } = await fixture(t, idle);
  const broker = await create();
  for (const [name, args] of probes(OWNER)) {
    const error = await errorOf(broker, root, name, args);
    assert.equal(error?.code, 'feature_disabled', `${name} must be refused while the board is disabled`);
  }
  assert.deepEqual(await broker.boardStatus(), [], 'the UI collects no rows while disabled');
  assert.deepEqual(await findBoardFiles(options.storage), [], 'a disabled board writes no board file');

  const health = unpack(await broker.invoke(root, 'subagent_health', {}));
  assert.equal(health.ready, true);
  assert.equal(health.taskBoard.enabled, false);
  assert.equal(health.taskBoard.error, undefined);
  assert.ok(health.capabilities.includes('read_file'), 'existing capabilities stay intact');

  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'solo', task: 'standalone work', ownerId: OWNER }));
  assert.equal((await done(broker, root, worker.id)).state, 'completed');
  assert.equal(hasBoardTools(requests[0]), false, 'a standalone worker receives no board tools');
});

test('a closed broker refuses board work instead of reopening a store', async t => {
  const { root, create } = await fixture(t, idle);
  const broker = await create({ taskBoardEnabled: () => true });
  await broker.close();
  const stopped = await errorOf(broker, root, 'subagent_team_list', { ownerId: OWNER });
  assert.equal(stopped?.code, 'host_stopping');
  assert.deepEqual(await broker.boardStatus(), [], 'a stopped host reports no board rows');
});

test('enabled: coordinator records a team and task; reads are paged summaries', async t => {
  const { root, create, requests } = await fixture(t, idle);
  const broker = await create({ taskBoardEnabled: () => true });
  const member = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'become a member', ownerId: OWNER }));
  await done(broker, root, member.id);

  const team = teamOf(await call(broker, root, 'subagent_team_create', { ownerId: OWNER, requestId: 'team-1', name: 'Board team', description: 'Shared work' }));
  assert.match(team.id, /^[a-f0-9]{32}$/);
  const joined = teamOf(await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: 'team-2', teamId: team.id, expectedRevision: team.revision, addMembers: [member.id] }));
  assert.deepEqual(joined.memberWorkerIds, [member.id]);

  const task = taskOf(await call(broker, root, 'subagent_task_create', { ownerId: OWNER, requestId: 'task-1', teamId: team.id, title: 'Design the seam', description: 'Seam work', acceptanceCriteria: ['Contract written'], assigneeWorkerId: member.id }));
  assert.equal(task.state, 'ready');
  assert.equal(task.assigneeWorkerId, member.id, 'assignment is recorded as metadata');

  const teamsPage = await call(broker, root, 'subagent_team_list', { ownerId: OWNER });
  assert.deepEqual(listOf(teamsPage, 'teams').map(entry => entry.id), [team.id]);
  assert.equal(teamsPage.nextOffset, null, 'team listing is paged too');
  const tasksPage = await call(broker, root, 'subagent_task_list', { ownerId: OWNER, teamId: team.id, limit: 1 });
  assert.deepEqual(listOf(tasksPage, 'tasks').map(entry => entry.id), [task.id]);
  assert.equal(tasksPage.nextOffset, null);
  assert.equal(taskOf(await call(broker, root, 'subagent_task_get', { ownerId: OWNER, id: task.id })).id, task.id);

  const health = unpack(await broker.invoke(root, 'subagent_health', {}));
  assert.equal(health.taskBoard.enabled, true);

  const canonical = await fs.realpath(root);
  const [status] = await broker.boardStatus();
  assert.equal(status.workspaceRoot, canonical, 'board status is keyed by the canonical root');
  sameIds(status.teams, [team.id]);
  sameIds(status.tasks, [task.id]);
  assert.equal(status.error, undefined);
  assert.equal(typeof status.tasks[0].titlePreview, 'string', 'the UI carries summaries, not raw records');
  assert.equal('entries' in status.tasks[0].history, false, 'transition entries never reach the UI payload');

  const snapshot = await call(broker, root, 'ui_board_snapshot', {});
  assert.deepEqual(statuses(snapshot).flatMap(row => row.tasks).map(entry => entry.id), [task.id]);
  const strict = await errorOf(broker, root, 'ui_board_snapshot', { extra: true });
  assert.equal(strict?.code, 'invalid_arguments', 'the internal snapshot takes no arguments');
  assert.equal(hasBoardTools(requests[0]), false, 'no board tools before membership exists');
});

test('a corrupt board fails closed for board calls without breaking standalone workers', async t => {
  const { root, options, create, requests } = await fixture(t, idle);
  const directory = await workspaceDirectory(options.storage, root);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'task-board.json');
  const corrupt = '{"schema":1,"workspaceRoot":"elsewhere","teams":[],"tasks":[],"requests":{}}';
  await fs.writeFile(file, corrupt);

  const broker = await create({ taskBoardEnabled: () => true });
  const health = unpack(await broker.invoke(root, 'subagent_health', {}));
  assert.equal(health.ready, true, 'the host stays healthy');
  assert.equal(health.taskBoard.enabled, true);
  assert.match(health.taskBoard.error, /board_malformed/, 'the failure is reported honestly');

  assert.equal((await errorOf(broker, root, 'subagent_team_list', { ownerId: OWNER }))?.code, 'board_malformed', 'board reads stay closed');
  assert.equal((await errorOf(broker, root, 'subagent_team_create', { ownerId: OWNER, requestId: 'x', name: 'Nope', description: 'nope' }))?.code, 'board_malformed');
  const [row] = await broker.boardStatus();
  assert.equal(row.workspaceRoot, await fs.realpath(root));
  assert.match(row.error, /board_malformed/, 'the UI gets an error row instead of a false empty board');
  assert.equal(await fs.readFile(file, 'utf8'), corrupt, 'a malformed board is never rewritten or repaired');

  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'resilient', task: 'work without a board', ownerId: OWNER }));
  assert.equal((await done(broker, root, worker.id)).state, 'completed', 'standalone workers keep working');
  assert.equal(hasBoardTools(requests[0]), false, 'no board tools when the board is unusable');
});

test('two hosts share one board: forwarded reads, one CAS winner, cycles refused, receipts replay', async t => {
  const { root, create } = await fixture(t, idle);
  const first = await create({ taskBoardEnabled: () => true });
  const { team, task } = await seed(first, root);
  const second = await create({ taskBoardEnabled: () => true });

  const forwarded = await call(second, root, 'subagent_task_list', { ownerId: OWNER, teamId: team.id });
  assert.deepEqual(listOf(forwarded, 'tasks').map(entry => entry.id), [task.id], 'the non-owner forwards to the exact owner');
  const [forwardedStatus] = await second.boardStatus();
  sameIds(forwardedStatus.tasks, [task.id]);

  const outcomes = (await Promise.allSettled([
    first.invoke(root, 'subagent_task_update', { ownerId: OWNER, requestId: 'race-a', taskId: task.id, expectedRevision: task.revision, progress: 'window A' }),
    second.invoke(root, 'subagent_task_update', { ownerId: OWNER, requestId: 'race-b', taskId: task.id, expectedRevision: task.revision, progress: 'window B' }),
  ])).map(result => result.status === 'fulfilled' ? result.value : result.reason);
  const winners = outcomes.filter(result => result && result.isError !== true);
  const losers = outcomes.filter(result => !result || result.isError === true)
    .map(result => result?.content ? JSON.parse(result.content[0].text).error.code : failure(result).code);
  assert.equal(winners.length, 1, 'exactly one stale-revision write wins');
  assert.equal(losers.length, 1);
  assert.match(losers[0], /conflict/);
  assert.equal(taskOf(await call(second, root, 'subagent_task_get', { ownerId: OWNER, id: task.id })).revision, task.revision + 1);

  const left = taskOf(await call(first, root, 'subagent_task_create', { ownerId: OWNER, requestId: 'chain-left', teamId: team.id, title: 'Left', description: 'Left side' }));
  const right = taskOf(await call(first, root, 'subagent_task_create', { ownerId: OWNER, requestId: 'chain-right', teamId: team.id, title: 'Right', description: 'Right side' }));
  taskOf(await call(first, root, 'subagent_task_update', { ownerId: OWNER, requestId: 'edge-1', taskId: left.id, expectedRevision: left.revision, dependencies: [{ taskId: right.id, kind: 'artifact' }] }));
  const cycle = await errorOf(first, root, 'subagent_task_update', { ownerId: OWNER, requestId: 'edge-2', taskId: right.id, expectedRevision: right.revision, dependencies: [{ taskId: left.id, kind: 'contract' }] });
  assert.equal(cycle?.code, 'dependency_cycle', 'a dependency cycle is refused');
  assert.deepEqual(taskOf(await call(first, root, 'subagent_task_get', { ownerId: OWNER, id: right.id })).dependencies, [], 'the refused edge was never stored');

  const createArgs = { ownerId: OWNER, requestId: 'receipt', teamId: team.id, title: 'Once', description: 'Only once' };
  const original = taskOf(await call(first, root, 'subagent_task_create', createArgs));
  await first.close();
  await second.close();
  const reopened = await create({ taskBoardEnabled: () => true });
  assert.equal(taskOf(await call(reopened, root, 'subagent_task_create', createArgs)).id, original.id, 'a durable receipt replays the original result after reload');
  assert.equal((await errorOf(reopened, root, 'subagent_task_get', { ownerId: OTHER_OWNER, id: original.id }))?.code, 'forbidden', 'another coordinator cannot read these records');
});

test('a member worker reports progress and submits; acceptance stays an explicit coordinator step', async t => {
  let phase = 'idle';
  let taskId;
  let revision;
  let step = 0;
  const stream = async function* (_selected, messages) {
    if (phase === 'idle') {
      yield { type: 'text', text: 'idle bootstrap' };
      return;
    }
    const last = messages.at(-1).parts[0];
    if (last.type === 'result') {
      const current = pick(safe(last.text));
      if (current) { taskId = current.id ?? taskId; revision = current.revision; }
      step += 1;
    }
    if (revision === undefined) {
      yield { type: 'call', id: 'read', name: 'subagent_task_get', input: { id: taskId } };
      return;
    }
    if (step <= 1) {
      yield { type: 'call', id: 'start', name: 'subagent_task_update', input: { requestId: 'worker-start', taskId, expectedRevision: revision, state: 'in_progress', progress: 'reading the board' } };
      return;
    }
    if (step === 2) {
      yield { type: 'call', id: 'submit', name: 'subagent_task_update', input: { requestId: 'worker-submit', taskId, expectedRevision: revision, state: 'submitted', progress: 'ready for review', candidates: [ARTIFACT] } };
      return;
    }
    yield { type: 'text', text: 'worker finished' };
  };
  const { root, create, requests } = await fixture(t, stream);
  const broker = await create({ taskBoardEnabled: () => true });
  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'implementer', task: 'wait for a task', ownerId: OWNER }));
  assert.equal((await done(broker, root, worker.id)).state, 'completed');
  assert.equal(hasBoardTools(requests[0]), false, 'no board tools before membership');

  const { task } = await seed(broker, root, [worker.id]);
  assert.equal(task.assigneeWorkerId, worker.id, 'the seeded task is explicitly assigned to the bootstrap worker');
  assert.equal(task.state, 'ready');
  taskId = task.id;
  phase = 'work';
  unpack(await broker.invoke(root, 'subagent_send', { id: worker.id, requestId: 'work', message: 'pick up your task', ownerId: OWNER }));
  const finished = await done(broker, root, worker.id);
  assert.equal(finished.state, 'completed');
  const offered = boardToolNames(requests.at(-1));
  assert.deepEqual(offered, ['subagent_task_get', 'subagent_task_list', 'subagent_task_update', 'subagent_team_get', 'subagent_team_list'], 'a member receives exactly the private board tools');
  assert.deepEqual(finished.turns.at(-1).tools.map(tool => tool.call.id), ['read', 'start', 'submit'], 'the worker ran get, start and submit exactly once');
  for (const tool of finished.turns.at(-1).tools) {
    assert.equal(tool.state, 'completed');
    assert.equal(safe(tool.result)?.error, undefined, `${tool.call.name} must succeed`);
  }

  const submitted = taskOf(await call(broker, root, 'subagent_task_get', { ownerId: OWNER, id: task.id }));
  assert.equal(submitted.state, 'submitted', 'finishing does not accept the task');
  assert.equal(submitted.validations.length, 0, 'a worker cannot record verdicts');
  assert.deepEqual(submitted.candidates.map(ref => [ref.id, ref.version]), [[ARTIFACT.id, ARTIFACT.version]]);

  const early = await errorOf(broker, root, 'subagent_task_update', { ownerId: OWNER, requestId: 'accept-early', taskId: task.id, expectedRevision: submitted.revision, state: 'accepted' });
  assert.match(early?.code ?? '', /transition_invalid|acceptance_invalid/, 'acceptance is refused straight from submitted');
  assert.equal(taskOf(await call(broker, root, 'subagent_task_get', { ownerId: OWNER, id: task.id })).state, 'submitted');

  const validating = taskOf(await call(broker, root, 'subagent_task_update', { ownerId: OWNER, requestId: 'validating', taskId: task.id, expectedRevision: submitted.revision, state: 'validating' }));
  assert.equal(validating.state, 'validating');
  const noVerdict = await errorOf(broker, root, 'subagent_task_update', { ownerId: OWNER, requestId: 'accept-noverdict', taskId: task.id, expectedRevision: validating.revision, state: 'accepted' });
  assert.equal(noVerdict?.code, 'acceptance_invalid', 'acceptance needs a passed verdict for the latest candidate');

  const validated = taskOf(await call(broker, root, 'subagent_task_update', {
    ownerId: OWNER, requestId: 'verdict', taskId: task.id, expectedRevision: validating.revision,
    validations: [{ artifactId: ARTIFACT.id, candidateVersion: ARTIFACT.version, outcome: 'passed', note: 'checked', at: new Date().toISOString() }],
  }));
  assert.equal(validated.state, 'validating', 'recording a verdict does not accept');
  const accepted = taskOf(await call(broker, root, 'subagent_task_update', { ownerId: OWNER, requestId: 'accept', taskId: task.id, expectedRevision: validated.revision, state: 'accepted' }));
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.integrated, undefined, 'accepted never implies integrated');
});

test('the feature flag is read live and refused board calls never notify the view', async t => {
  let enabled = true;
  let changes = 0;
  const { root, create } = await fixture(t, idle);
  const broker = await create({ taskBoardEnabled: () => enabled, onChange: () => { changes += 1; } });
  const { task } = await seed(broker, root);
  const afterCreate = changes;
  assert.ok(afterCreate > 0, 'successful mutations notify the view');

  taskOf(await call(broker, root, 'subagent_task_update', { ownerId: OWNER, requestId: 'tick', taskId: task.id, expectedRevision: task.revision, progress: 'working' }));
  assert.equal(changes, afterCreate + 1, 'each successful update notifies once');

  enabled = false;
  assert.deepEqual(await broker.boardStatus(), [], 'the UI stops collecting rows');
  assert.equal((await errorOf(broker, root, 'subagent_task_get', { ownerId: OWNER, id: task.id }))?.code, 'feature_disabled', 'reads are refused immediately');
  assert.equal((await errorOf(broker, root, 'subagent_task_update', { ownerId: OWNER, requestId: 'late', taskId: task.id, expectedRevision: task.revision + 1, progress: 'late' }))?.code, 'feature_disabled');
  assert.equal(changes, afterCreate + 1, 'refused calls never notify');

  enabled = true;
  const reread = taskOf(await call(broker, root, 'subagent_task_get', { ownerId: OWNER, id: task.id }));
  assert.equal(reread.progress, 'working', 're-enabling works without a restart when the board is healthy');
});
