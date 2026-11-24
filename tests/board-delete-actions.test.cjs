const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { boardDeleteChoices, manualBoardDelete, resolveBoardDeleteTarget } = require('../.test-build/board-delete-actions');
const { WorkerError } = require('../.test-build/types');

const WS = 'C:\\workspace\\codex_subagent';
const TEAM_A = 'a'.repeat(32);
const TEAM_B = 'b'.repeat(32);
const TASK_ONE = '1'.repeat(32);
const TASK_TWO = '2'.repeat(32);

const team = (id = TEAM_A, name = 'Alpha', revision = 3) => ({
  id, namePreview: name, workspaceRoot: WS, coordinatorOwnerId: 'owner-1', memberWorkerIds: [], revision
});
const task = (over = {}) => ({
  id: TASK_ONE, teamId: TEAM_A, titlePreview: 'Wire board view', state: 'ready', revision: 2, ...over
});
const status = (over = {}) => ({
  workspaceRoot: WS, teams: [team()], tasks: [task()], ...over
});

function fixture(overrides = {}) {
  const calls = { boardStatus: 0, prepare: [], invoke: [], confirm: [], pick: [], info: [], refresh: 0 };
  const ports = {
    boardStatus: async () => { calls.boardStatus += 1; return overrides.status ?? [status()]; },
    prepare: async (root, input) => {
      calls.prepare.push({ root, input });
      return overrides.prepared ?? { kind: 'task', teamId: TEAM_A, taskId: TASK_ONE, title: 'Wire board view', revision: 2, requestId: 'epoch-1-request' };
    },
    invoke: async (root, name, args) => {
      calls.invoke.push({ root, name, args });
      if (overrides.invoke) {
        return overrides.invoke(root, name, args);
      }
      return { kind: name === 'ui_board_delete_task' ? 'task_deleted' : 'team_deleted' };
    },
    confirm: async (message, detail) => { calls.confirm.push({ message, detail }); return overrides.confirm ?? true; },
    pick: async choices => { calls.pick.push(choices); return overrides.pick ? overrides.pick(choices) : undefined; },
    info: message => { calls.info.push(message); },
    refresh: async () => { calls.refresh += 1; },
    seed: () => overrides.seed ?? 'seed-1'
  };
  return { calls, ports };
}

test('a context-menu task uses the canonical root, host-returned request id and one strict delete', async () => {
  const f = fixture();
  const result = await manualBoardDelete(f.ports, {
    kind: 'task',
    target: { workspaceRoot: WS + path.sep, teamId: TEAM_A, taskId: TASK_ONE }
  });

  assert.deepEqual(result, { status: 'deleted', kind: 'task', id: TASK_ONE });
  assert.equal(f.calls.boardStatus, 1, 'the requested node is resolved against one fresh status');
  assert.deepEqual(f.calls.prepare, [{
    root: WS,
    input: { kind: 'task', teamId: TEAM_A, taskId: TASK_ONE, requestId: 'seed-1' }
  }]);
  assert.equal(f.calls.confirm.length, 1);
  assert.match(f.calls.confirm[0].message, /Wire board view/);
  for (const text of [WS, TEAM_A, TASK_ONE]) {
    assert.ok(f.calls.confirm[0].detail.includes(text), `confirmation identifies ${text}`);
  }
  assert.equal(f.calls.invoke.length, 1, 'exactly one delete request follows the confirmation');
  assert.deepEqual(f.calls.invoke[0], {
    root: WS,
    name: 'ui_board_delete_task',
    args: { teamId: TEAM_A, taskId: TASK_ONE, expectedRevision: 2, requestId: 'epoch-1-request' }
  });
  assert.deepEqual(Object.keys(f.calls.invoke[0].args).sort(), ['expectedRevision', 'requestId', 'taskId', 'teamId']);
  assert.equal(f.calls.refresh, 1, 'only the board is refreshed after success');
});

test('a team deletion confirms membership consequences and sends no task id or prepared fields', async () => {
  const f = fixture({
    prepared: { kind: 'team', teamId: TEAM_A, name: 'Alpha team', revision: 5, requestId: 'epoch-team-request' }
  });
  const result = await manualBoardDelete(f.ports, {
    kind: 'team',
    target: { workspaceRoot: WS, teamId: TEAM_A }
  });

  assert.deepEqual(result, { status: 'deleted', kind: 'team', id: TEAM_A });
  assert.deepEqual(f.calls.prepare, [{
    root: WS,
    input: { kind: 'team', teamId: TEAM_A, requestId: 'seed-1' }
  }]);
  assert.match(f.calls.confirm[0].message, /Alpha team/);
  assert.match(f.calls.confirm[0].detail, /membership/);
  assert.match(f.calls.confirm[0].detail, /retained resources/);
  assert.deepEqual(f.calls.invoke, [{
    root: WS,
    name: 'ui_board_delete_team',
    args: { teamId: TEAM_A, expectedRevision: 5, requestId: 'epoch-team-request' }
  }]);
  assert.equal(f.calls.refresh, 1);
});

test('cancelling the modal confirmation performs no delete and no refresh', async () => {
  const f = fixture({ confirm: false });
  const result = await manualBoardDelete(f.ports, {
    kind: 'task',
    target: { workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE }
  });

  assert.deepEqual(result, { status: 'cancelled', kind: 'task' });
  assert.equal(f.calls.prepare.length, 1, 'the read-only preparation may have run');
  assert.equal(f.calls.invoke.length, 0, 'cancellation never mutates the board');
  assert.equal(f.calls.refresh, 0, 'cancellation changes nothing to refresh');
});

test('palette selection offers real tasks with root, team and task context, then deletes the picked record', async () => {
  const orphan = task({ id: TASK_TWO, teamId: TEAM_B, titlePreview: 'Orphan task' });
  const f = fixture({
    status: [status({ tasks: [task(), orphan] })],
    pick: choices => choices.find(choice => choice.target.taskId === TASK_ONE)
  });
  const result = await manualBoardDelete(f.ports, { kind: 'task' });

  assert.deepEqual(result, { status: 'deleted', kind: 'task', id: TASK_ONE });
  assert.equal(f.calls.pick.length, 1);
  assert.deepEqual(f.calls.pick[0].map(choice => choice.target), [{ workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE }]);
  assert.match(f.calls.pick[0][0].detail, /team a{32}/);
  assert.match(f.calls.pick[0][0].detail, /task 1{32}/);
  assert.equal(f.calls.invoke.length, 1, 'the picked palette record is deleted only after confirmation');
});

test('a cancelled palette pick and an empty palette never prepare or mutate', async () => {
  const cancelled = fixture();
  assert.deepEqual(await manualBoardDelete(cancelled.ports, { kind: 'task' }), { status: 'cancelled', kind: 'task' });
  assert.equal(cancelled.calls.pick.length, 1);
  assert.equal(cancelled.calls.prepare.length, 0);
  assert.equal(cancelled.calls.invoke.length, 0);
  assert.equal(cancelled.calls.refresh, 0);

  const empty = fixture({ status: [status({ teams: [], tasks: [] })] });
  assert.deepEqual(await manualBoardDelete(empty.ports, { kind: 'team' }), { status: 'unavailable', kind: 'team' });
  assert.equal(empty.calls.pick.length, 0);
  assert.equal(empty.calls.info.length, 1);
  assert.match(empty.calls.info[0], /No task board teams/);
  assert.equal(empty.calls.prepare.length, 0);
  assert.equal(empty.calls.invoke.length, 0);
});

test('a record changed after confirmation surfaces the backend error once and only refreshes', async () => {
  const f = fixture({
    invoke: async () => { throw new WorkerError('revision_conflict', 'The task changed; choose it again.'); }
  });
  await assert.rejects(
    manualBoardDelete(f.ports, { kind: 'task', target: { workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE } }),
    error => error.code === 'revision_conflict' && /changed/.test(error.message)
  );
  assert.equal(f.calls.prepare.length, 1, 'a changed record is never reprepared automatically');
  assert.equal(f.calls.invoke.length, 1, 'no second delete is attempted');
  assert.equal(f.calls.refresh, 1, 'the board is refreshed after the error');
  assert.deepEqual(f.calls.invoke[0].args, {
    teamId: TEAM_A, taskId: TASK_ONE, expectedRevision: 2, requestId: 'epoch-1-request'
  });
});

test('a mismatched prepare response is refused without a delete', async () => {
  const f = fixture({
    prepared: { kind: 'task', teamId: TEAM_A, taskId: TASK_TWO, title: 'Other', revision: 2, requestId: 'epoch-1-request' }
  });
  await assert.rejects(
    manualBoardDelete(f.ports, { kind: 'task', target: { workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE } }),
    { code: 'invalid_response' }
  );
  assert.equal(f.calls.prepare.length, 1);
  assert.equal(f.calls.invoke.length, 0);
  assert.equal(f.calls.refresh, 1);
});

test('foreign, missing, stale and mismatched targets never prepare or delete', async () => {
  const cases = [
    ['foreign workspace', [status()], { workspaceRoot: 'C:\\other', teamId: TEAM_A, taskId: TASK_ONE }, 'not_found'],
    ['missing team', [status()], { workspaceRoot: WS, teamId: TEAM_B, taskId: TASK_ONE }, 'not_found'],
    ['missing task', [status()], { workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_TWO }, 'not_found'],
    ['task under another team', [status({ teams: [team(TEAM_A), team(TEAM_B, 'Beta')] })],
      { workspaceRoot: WS, teamId: TEAM_B, taskId: TASK_ONE }, 'not_found'],
    ['team target naming a task', [status()], { workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE }, 'invalid_arguments']
  ];
  for (const [name, statuses, target, code] of cases) {
    const f = fixture({ status: statuses });
    await assert.rejects(manualBoardDelete(f.ports, { kind: name === 'team target naming a task' ? 'team' : 'task', target }), error => {
      assert.equal(error.code, code, name);
      return true;
    });
    assert.equal(f.calls.prepare.length, 0, `${name} is rejected before prepare`);
    assert.equal(f.calls.invoke.length, 0, `${name} deletes nothing`);
    assert.equal(f.calls.refresh, 0, `${name} changes nothing to refresh`);
  }
});

test('choices keep every lifecycle state; labels never decide deletability', () => {
  const statuses = [status({ tasks: [task({ state: 'in_progress' }), task({ id: TASK_TWO, state: 'accepted' })] })];
  assert.deepEqual(boardDeleteChoices(statuses, 'task').map(choice => choice.target.taskId), [TASK_ONE, TASK_TWO]);
});

test('choices include only real teams and tasks and resolve exact targets', () => {
  const orphan = task({ id: TASK_TWO, teamId: TEAM_B, titlePreview: 'Orphan task' });
  const statuses = [status({ teams: [team(TEAM_A, 'Alpha')], tasks: [task(), orphan] })];
  assert.deepEqual(boardDeleteChoices(statuses, 'team').map(choice => choice.target), [
    { workspaceRoot: WS, teamId: TEAM_A }
  ]);
  assert.deepEqual(boardDeleteChoices(statuses, 'task').map(choice => choice.target), [
    { workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE }
  ]);
  assert.deepEqual(resolveBoardDeleteTarget(statuses, {
    kind: 'task', workspaceRoot: WS + path.sep, teamId: TEAM_A, taskId: TASK_ONE
  }), { kind: 'task', workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE });
});
