const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = fn => {
      const emitter = this;
      emitter.listeners.push(fn);
      return { dispose() { emitter.listeners = emitter.listeners.filter(l => l !== fn); } };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) { listener(value); }
  }
  dispose() {
    this.listeners = [];
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class ThemeIcon {
  constructor(id) { this.id = id; }
}
const vscode = {
  EventEmitter,
  TreeItem,
  ThemeIcon,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...rest); };
const { TaskBoardTree } = require('../.test-build/task-board-view');
const { summarizeBoard } = require('../.test-build/task-board-summary');
Module._load = originalLoad;

const WS = 'C:\\workspace\\codex_subagent';
const TEAM_A = 'a'.repeat(32);
const TEAM_B = 'b'.repeat(32);
const TASK_ONE = '1'.repeat(32);
const TASK_TWO = '2'.repeat(32);
const WORKER = 'f'.repeat(32);
const AT = '2024-01-02T03:04:05.000Z';
const TASK_ID = `board:${WS}/team:${TEAM_A}/task:${TASK_ONE}`;

const history = (entries = [], trimmed = 0, lastSequence = 0) => ({ entries, lastSequence, trimmed });

/** Full domain records; the tree only ever consumes their bounded summaries. */
function team(id, over = {}) {
  return {
    id,
    name: `Team ${id.slice(0, 2)}`,
    description: '',
    workspaceRoot: WS,
    coordinatorOwnerId: 'coordinator-owner',
    memberWorkerIds: [],
    revision: 0,
    createdAt: AT,
    updatedAt: AT,
    history: history(),
    ...over,
  };
}

function task(over = {}) {
  return {
    id: TASK_ONE,
    teamId: TEAM_A,
    title: 'Wire board view',
    description: '',
    acceptanceCriteria: [],
    dependencies: [],
    assigneeWorkerId: null,
    progress: '',
    blockers: [],
    state: 'ready',
    candidates: [],
    agreedContracts: [],
    validations: [],
    revision: 0,
    createdAt: AT,
    updatedAt: AT,
    history: history(),
    ...over,
  };
}

/** Project full records exactly as the host does before the view ever sees them. */
const board = (over = {}) => summarizeBoard({ workspaceRoot: WS, teams: [], tasks: [], ...over });
const ref = (id, version, label) => ({ id, version, uri: `file:///${id}-v${version}.bin`, ...(label ? { label } : {}) });

async function taskRow(over = {}) {
  const tree = new TaskBoardTree();
  tree.refresh([board({ teams: [team(TEAM_A)], tasks: [task(over)] })]);
  const [workspace] = await tree.getChildren();
  const [teamRow] = await tree.getChildren(workspace);
  const [row] = await tree.getChildren(teamRow);
  return { tree, node: row, item: tree.getTreeItem(row) };
}

const byLabel = nodes => Object.fromEntries(nodes.map(node => [node.label, node]));

test('root exposes each workspace, then teams, then tasks with canonical ids', async () => {
  const tree = new TaskBoardTree();
  tree.refresh([board({
    teams: [team(TEAM_A, { name: 'Alpha', revision: 4 })],
    tasks: [task(), task({ id: TASK_TWO, title: 'Second task' })],
  })]);
  const roots = await tree.getChildren();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].kind, 'workspace');
  assert.equal(roots[0].id, `board:${WS}`);
  assert.equal(roots[0].label, WS);
  assert.match(roots[0].description, /1 team\(s\)/);
  assert.match(roots[0].description, /2 task\(s\)/);
  const workspaceItem = tree.getTreeItem(roots[0]);
  assert.equal(workspaceItem.id, `board:${WS}`);
  assert.equal(workspaceItem.collapsibleState, 2, 'workspaces open like the workers tree');

  const teams = await tree.getChildren(roots[0]);
  assert.deepEqual(teams.map(node => node.kind), ['team']);
  assert.equal(teams[0].id, `board:${WS}/team:${TEAM_A}`);
  assert.equal(teams[0].label, 'Alpha');
  assert.match(tree.getTreeItem(teams[0]).description, /rev 4/);
  assert.equal(tree.getTreeItem(teams[0]).collapsibleState, 2, 'teams open too');

  const tasks = await tree.getChildren(teams[0]);
  assert.deepEqual(tasks.map(node => node.label), ['Wire board view', 'Second task']);
  assert.deepEqual(tasks.map(node => node.id), [TASK_ID, `board:${WS}/team:${TEAM_A}/task:${TASK_TWO}`]);
  assert.equal(tree.getTreeItem(tasks[0]).collapsibleState, 1, 'task details stay collapsed');

  const details = await tree.getChildren(tasks[0]);
  assert.deepEqual(details.map(node => node.label), ['No details recorded'], 'a bare task shows the empty-detail guidance');
  assert.deepEqual(await tree.getChildren(details[0]), [], 'a leaf has no children');
  assert.equal(tree.getTreeItem(details[0]).collapsibleState, 0);
});

test('task rows show state, revision and assignee, with ids that survive revision changes', async () => {
  const tree = new TaskBoardTree();
  tree.refresh([board({
    teams: [team(TEAM_A, { revision: 3 })],
    tasks: [task({ state: 'in_progress', revision: 7, assigneeWorkerId: WORKER })],
  })]);
  const [workspace] = await tree.getChildren();
  const [teamRow] = await tree.getChildren(workspace);
  const [row] = await tree.getChildren(teamRow);
  const item = tree.getTreeItem(row);
  assert.equal(item.id, TASK_ID);
  assert.match(item.description, /in_progress/);
  assert.match(item.description, /rev 7/);
  assert.match(item.description, new RegExp(`worker ${WORKER}`));
  assert.equal(item.iconPath.id, 'sync');
  assert.match(item.tooltip, /Wire board view/);
  assert.match(item.tooltip, /revision 7/);
  assert.match(item.tooltip, /Open the task record/, 'the tooltip points at the full record');
  assert.equal(item.contextValue, 'boardTask');
  assert.equal(item.command.command, 'codexSubagent.openBoardRecord');
  assert.deepEqual(item.command.arguments, [{ workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE }]);

  tree.refresh([board({
    teams: [team(TEAM_A, { revision: 9 })],
    tasks: [task({ state: 'in_progress', revision: 8, assigneeWorkerId: WORKER })],
  })]);
  const [nextWorkspace] = await tree.getChildren();
  const [nextTeam] = await tree.getChildren(nextWorkspace);
  const [next] = await tree.getChildren(nextTeam);
  assert.equal(next.id, item.id, 'the task id stays stable across revisions');
  assert.equal(tree.getTreeItem(nextTeam).id, `board:${WS}/team:${TEAM_A}`);
  assert.match(tree.getTreeItem(nextTeam).description, /rev 9/);

  assert.match((await taskRow({ assigneeWorkerId: null })).item.description, /unassigned/);
  const other = await taskRow({ assigneeWorkerId: WORKER, state: 'ready' });
  assert.match(other.item.description, new RegExp(`worker ${WORKER}`));
  assert.equal(other.item.iconPath.id, 'circle-outline');
});

test('submitted/validating await coordinator acceptance and accepted is never shown as integrated', async () => {
  const submitted = await taskRow({ state: 'submitted' });
  assert.match(submitted.item.description, /submitted/);
  assert.match(submitted.item.description, /awaiting coordinator acceptance/);
  assert.equal(submitted.item.iconPath.id, 'mail');

  const validating = await taskRow({ state: 'validating' });
  assert.match(validating.item.description, /validating/);
  assert.match(validating.item.description, /awaiting coordinator acceptance/);
  assert.equal(validating.item.iconPath.id, 'beaker');

  const accepted = await taskRow({ state: 'accepted' });
  assert.match(accepted.item.description, /accepted/);
  assert.match(accepted.item.description, /not integrated/);
  assert.match(accepted.item.description, /integration not implemented/);
  assert.doesNotMatch(accepted.item.description, /^accepted$/);
  assert.match(accepted.item.tooltip, /not integrated/);
  assert.equal(accepted.item.iconPath.id, 'pass');

  assert.equal((await taskRow({ state: 'failed' })).item.iconPath.id, 'error');
  assert.equal((await taskRow({ state: 'cancelled' })).item.iconPath.id, 'circle-slash');
});

test('task details expose criteria, dependency kinds, progress and blockers with shown totals', async () => {
  const { tree, node } = await taskRow({
    acceptanceCriteria: ['Costs stay bounded', 'No mutations from the UI', 'Third criterion'],
    dependencies: [{ taskId: TASK_TWO, kind: 'contract' }, { taskId: TASK_TWO, kind: 'artifact' }],
    progress: 'Halfway through the tree',
    blockers: ['Waiting on the host snapshot', 'Second blocker'],
  });
  const details = await tree.getChildren(node);
  assert.deepEqual(details.map(entry => entry.label), ['Acceptance criteria', 'Dependencies', 'Progress', 'Blockers', 'Some previews are shortened'], 'sampled lists mark the row as truncated');
  assert.equal(details[0].id, `${TASK_ID}/criteria`);
  assert.match(details[0].tooltip, /2 of 3 shown/, 'a shortened criteria list reports the true total');
  assert.match(details[0].tooltip, /Open the task record/);

  const criteria = await tree.getChildren(details[0]);
  assert.deepEqual(criteria.map(entry => entry.description), ['Costs stay bounded', 'No mutations from the UI'], 'only the first two criteria are sampled');
  assert.equal(criteria[0].id, `${TASK_ID}/criteria:0`);
  assert.match(tree.getTreeItem(criteria[0]).tooltip, /^Costs stay bounded/, 'the preview leads, then the record hint');

  const deps = await tree.getChildren(details[1]);
  assert.deepEqual(deps.map(entry => entry.description), ['contract', 'artifact']);
  assert.ok(deps.every(entry => entry.label === `Task ${TASK_TWO}`), 'dependency edges keep exact task ids');
  assert.match(deps[0].tooltip, /Dependency kind: contract/);
  assert.match(tree.getTreeItem(details[1]).tooltip, /All 2 dependency edge/);

  const progress = tree.getTreeItem(details[2]);
  assert.equal(progress.label, 'Progress');
  assert.equal(progress.description, 'Halfway through the tree');
  assert.match(progress.tooltip, /Halfway through the tree/);
  assert.match(progress.tooltip, /Preview; Open the task record/);

  const blockers = await tree.getChildren(details[3]);
  assert.equal(blockers[0].description, 'Waiting on the host snapshot');
  assert.match(blockers[0].tooltip, /Waiting on the host snapshot/);
  assert.match(tree.getTreeItem(details[3]).tooltip, /2 of 2 shown/);
});

test('candidate, contract and validation rows keep exact ids, versions and outcomes without URIs', async () => {
  const { tree, node } = await taskRow({
    candidates: [ref('candidate-a', 2, 'build two')],
    agreedContracts: [ref('contract-a', 1)],
    validations: [
      { artifactId: 'candidate-a', candidateVersion: 1, outcome: 'failed', at: AT },
      { artifactId: 'candidate-a', candidateVersion: 2, outcome: 'passed', note: 'all checks green', at: AT, resultRef: ref('report-1', 3) },
    ],
  });
  const sections = byLabel(await tree.getChildren(node));

  const candidates = await tree.getChildren(sections.Candidates);
  assert.equal(candidates[0].label, 'Candidate candidate-a');
  assert.equal(candidates[0].description, 'v2');
  assert.match(candidates[0].tooltip, /build two/);
  assert.equal(tree.getTreeItem(sections.Candidates).tooltip.includes('file:///'), false, 'reference URIs stay in the record');

  const contracts = await tree.getChildren(sections['Agreed contracts']);
  assert.equal(contracts[0].label, 'Contract contract-a');
  assert.equal(contracts[0].description, 'v1');

  const validations = await tree.getChildren(sections.Validations);
  assert.deepEqual(validations.map(entry => entry.description), ['candidate-a v1 failed', 'candidate-a v2 passed']);
  assert.match(validations[1].tooltip, /exact candidate version 2: passed/);
  assert.match(validations[1].tooltip, /all checks green/);
  assert.match(validations[1].tooltip, /result report-1 v3/, 'a result report reference is shown by id and version');
  assert.match(validations[1].tooltip, /at 2024-01-02T03:04:05\.000Z/);
  assert.equal(tree.getTreeItem(validations[1]).iconPath.id, 'pass');
  assert.equal(tree.getTreeItem(validations[0]).iconPath.id, 'error');
});

test('history rows report counts only and mark trimmed records', async () => {
  const entry = seq => ({ seq, actor: { kind: 'coordinator', ownerId: 'owner-1' }, revision: seq, reason: `step ${seq}`, at: AT });
  const { tree, node } = await taskRow({ history: { entries: [entry(1), entry(2)], lastSequence: 9, trimmed: 5 } });
  const historySection = (await tree.getChildren(node)).find(entryNode => entryNode.label === 'History');
  const rows = await tree.getChildren(historySection);
  assert.deepEqual(rows.map(row => [row.label, row.description]), [
    ['Entries retained', '2'],
    ['Trimmed entries', '5'],
    ['Last sequence', '9'],
  ]);
  assert.match(rows[0].tooltip, /2 transition entries are retained/);
  assert.match(rows[0].tooltip, /Open the task record/);
  assert.equal(rows[0].id, `${TASK_ID}/history:retained`);
  assert.match(tree.getTreeItem(historySection).tooltip, /counts only/, 'the section states that entries stay in the record');

  const plain = await taskRow();
  const plainDetails = await plain.tree.getChildren(plain.node);
  assert.deepEqual(plainDetails.map(entryNode => entryNode.label), ['No details recorded'], 'a task with no history shows the guidance row instead of a History section');
  assert.equal(plainDetails.some(entryNode => entryNode.label === 'Some previews are shortened'), false, 'a complete record is not marked truncated');
});

test('truncated summaries say so and keep the full-record command', async () => {
  const { tree, node, item } = await taskRow({
    description: 'd'.repeat(1000),
    candidates: Array.from({ length: 8 }, (_, index) => ref('artifact-a', index + 1)),
    history: { entries: Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, actor: { kind: 'coordinator', ownerId: 'owner-1' }, revision: index, reason: `step ${index + 1}`, at: AT })), lastSequence: 140, trimmed: 40 },
  });
  assert.match(item.tooltip, /Some previews are shortened/);
  assert.equal(item.command.command, 'codexSubagent.openBoardRecord');
  assert.deepEqual(item.command.arguments, [{ workspaceRoot: WS, teamId: TEAM_A, taskId: TASK_ONE }], 'the command still carries the exact ids');

  const details = await tree.getChildren(node);
  const marker = details.find(entry => entry.label === 'Some previews are shortened');
  assert.ok(marker, 'a truncated row explains itself');
  assert.match(marker.tooltip, /previews and counts only/);
  assert.match(marker.tooltip, /Open the task record/);
  const candidates = byLabel(details).Candidates;
  assert.match(tree.getTreeItem(candidates).description, /2/);
  assert.match(tree.getTreeItem(candidates).tooltip, /2 of 8 shown/);
  assert.deepEqual((await tree.getChildren(candidates)).map(entry => entry.description), ['v7', 'v8'], 'the newest versions are the ones previewed');
});

test('empty boards, empty teams and empty workspaces show guidance rows', async () => {
  const tree = new TaskBoardTree();
  const [emptyRoot] = await tree.getChildren();
  assert.equal(emptyRoot.kind, 'empty');
  assert.equal(emptyRoot.id, 'board:none');
  assert.match(emptyRoot.label, /No task board workspaces/);
  assert.match(emptyRoot.tooltip, /only displays snapshots/);
  assert.deepEqual(await tree.getChildren(emptyRoot), []);
  assert.equal(tree.getTreeItem(emptyRoot).collapsibleState, 0);

  tree.refresh([board({ teams: [], tasks: [] })]);
  const [workspace] = await tree.getChildren();
  const [workspaceGuidance] = await tree.getChildren(workspace);
  assert.equal(workspaceGuidance.kind, 'empty');
  assert.match(workspaceGuidance.label, /No teams or tasks/);
  assert.match(workspaceGuidance.tooltip, /coordinator/);

  tree.refresh([board({ teams: [team(TEAM_A)], tasks: [] })]);
  const [nextWorkspace] = await tree.getChildren();
  const [teamRow] = await tree.getChildren(nextWorkspace);
  const [teamGuidance] = await tree.getChildren(teamRow);
  assert.match(teamGuidance.label, /No tasks in this team/);
  assert.match(tree.getTreeItem(teamGuidance).tooltip, /coordinator/);
});

test('host errors stay inspectable and tasks without a team are never hidden', async () => {
  const message = 'task-board.json is invalid: unexpected token at line 3';
  const tree = new TaskBoardTree();
  tree.refresh([board({
    teams: [team(TEAM_A)],
    tasks: [task({ id: TASK_TWO, teamId: TEAM_B, title: 'Orphan task' })],
    error: message,
  })]);
  const [workspace] = await tree.getChildren();
  const children = await tree.getChildren(workspace);
  assert.deepEqual(children.map(child => child.kind), ['error', 'team', 'team']);
  const errorItem = tree.getTreeItem(children[0]);
  assert.equal(errorItem.id, `board:${WS}/error`);
  assert.equal(errorItem.tooltip, message, 'the error text stays inspectable in full');
  assert.match(errorItem.description, /task-board\.json is invalid/);
  assert.equal(errorItem.iconPath.id, 'warning');

  assert.match(children[2].label, /Tasks without a team/);
  const orphans = await tree.getChildren(children[2]);
  assert.deepEqual(orphans.map(node => node.id), [`board:${WS}/team:${TEAM_B}/task:${TASK_TWO}`]);
  assert.equal(orphans[0].label, 'Orphan task');
});

test('refresh adopts read-only summaries, ignores later caller mutations, and dispose stops notifications', async () => {
  const tasks = [task()];
  const tree = new TaskBoardTree();
  let fired = 0;
  tree.onDidChangeTreeData(() => { fired += 1; });
  tree.refresh([board({ tasks })]);
  assert.equal(fired, 1);
  tasks.push(task({ id: TASK_TWO, title: 'Late task' }));
  const [workspace] = await tree.getChildren();
  const [teamRow] = await tree.getChildren(workspace);
  assert.equal((await tree.getChildren(teamRow)).length, 1, 'later caller mutations are not adopted');

  tree.refresh([board(), board({ workspaceRoot: 'C:\\other' })]);
  assert.equal(fired, 2);
  assert.deepEqual((await tree.getChildren()).map(node => node.id), [`board:${WS}`, 'board:C:\\other']);

  tree.dispose();
  tree.refresh([board()]);
  assert.equal(fired, 2, 'a disposed tree stops notifying');
});

test('rows use literal text only and add no markup', async () => {
  const tree = new TaskBoardTree();
  tree.refresh([board({
    teams: [team(TEAM_A, { name: 'Alpha Team', description: 'Owner: coordinator' })],
    tasks: [task({ description: 'Plain description', state: 'accepted' })],
  })]);
  const rows = [];
  const walk = node => { rows.push(node); (node.children ?? []).forEach(walk); };
  (await tree.getChildren()).forEach(walk);
  assert.ok(rows.some(node => node.kind === 'task'));
  for (const node of rows) {
    for (const text of [node.label, node.description, node.tooltip].filter(value => typeof value === 'string')) {
      assert.ok(!/[<>]/.test(text), `row text stays literal: ${text}`);
    }
    const item = tree.getTreeItem(node);
    assert.equal(typeof item.label, 'string');
    assert.equal(typeof item.tooltip, 'string');
  }

  const markup = '<b>literal title</b>';
  const literal = await taskRow({ title: markup });
  assert.equal(literal.item.label, markup, 'markup-looking data stays literal and is not transformed');
});
