const assert = require('node:assert/strict');
const { test } = require('node:test');
const { summarizeBoard, summaryLimits } = require('../.test-build/task-board-summary');

/**
 * summarizeBoard is the only path from full board records to what the tree and
 * the internal UI snapshot may carry. These tests keep that projection honest:
 * bounded previews, exact ids and edges, no URIs, no transition entries, and an
 * envelope that stays inside the bridge limit at the declared capacity even when
 * every free-form field is full of characters that escape when serialized.
 */

const WS = 'C:\\workspace\\codex_subagent';
const AT = '2024-01-02T03:04:05.000Z';
const hex = (n, size = 32) => n.toString(16).padStart(size, '0');

/** Worst-case text: quotes and backslashes (escaped) plus raw control characters. */
const seed = '"\\' + String.fromCharCode(1) + String.fromCharCode(31);
const nasty = length => {
  let text = '';
  while (text.length < length) { text += seed; }
  return text.slice(0, length);
};

/** The bridge transmits a ToolResult whose text is a JSON string, so it is serialized twice. */
const envelopeSize = status => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(status) }] }).length;
const BRIDGE_LIMIT = 10_000_000;

const team = (n, over = {}) => ({
  id: hex(n),
  name: `Team ${n}`,
  description: '',
  workspaceRoot: WS,
  coordinatorOwnerId: 'coordinator-owner',
  memberWorkerIds: [],
  revision: n,
  createdAt: AT,
  updatedAt: AT,
  history: { entries: [], lastSequence: 0, trimmed: 0 },
  ...over
});

const historyEntry = seq => ({ seq, actor: { kind: 'coordinator', ownerId: 'owner-1' }, revision: seq, reason: `step ${seq}`, at: AT });

const task = (n, over = {}) => ({
  id: hex(n, 32),
  teamId: hex(1),
  title: `Task ${n}`,
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
  history: { entries: [], lastSequence: 0, trimmed: 0 },
  ...over
});

const ref = n => ({ id: `candidate-${n}`.padEnd(64, 'x'), version: n, uri: `file:///${'u'.repeat(2040)}`, label: 'l'.repeat(120) });

/** One record at every declared maximum, using worst-case text everywhere. */
function maximalTask(n, teamId) {
  return task(n, {
    teamId,
    title: nasty(160),
    description: nasty(4000),
    progress: nasty(4000),
    acceptanceCriteria: Array.from({ length: 20 }, () => nasty(500)),
    dependencies: Array.from({ length: 32 }, (_, index) => ({ taskId: hex(index + 1), kind: index % 2 ? 'contract' : 'artifact' })),
    blockers: Array.from({ length: 16 }, () => nasty(500)),
    candidates: Array.from({ length: 8 }, (_, index) => ref(index + 1)),
    agreedContracts: Array.from({ length: 8 }, (_, index) => ref(index + 20)),
    validations: Array.from({ length: 16 }, (_, index) => ({ artifactId: 'a'.repeat(64), candidateVersion: index + 1, outcome: index % 2 ? 'failed' : 'passed', note: nasty(500), at: AT })),
    history: { entries: Array.from({ length: 100 }, (_, seq) => ({ ...historyEntry(seq + 1), reason: nasty(300) })), lastSequence: 100, trimmed: 40 },
    assigneeWorkerId: hex(5000),
    state: 'submitted',
    revision: 7
  });
}

function maximalTeam(n) {
  return team(n, {
    name: nasty(120),
    description: nasty(2000),
    memberWorkerIds: Array.from({ length: 32 }, (_, member) => hex(5000 + member))
  });
}

test('a summary keeps exact ids and edges while clipping every preview', () => {
  const source = maximalTask(7, hex(1));
  const status = summarizeBoard({ workspaceRoot: WS, teams: [team(1)], tasks: [source] });
  const summary = status.tasks[0];

  assert.equal(summary.id, source.id, 'the task id stays exact');
  assert.equal(summary.teamId, source.teamId, 'the team id stays exact');
  assert.equal(summary.state, 'submitted');
  assert.equal(summary.assigneeWorkerId, hex(5000), 'the assignment id stays exact');
  assert.equal(summary.revision, 7);

  assert.equal(summary.titlePreview.length, summaryLimits.title);
  assert.ok(summary.titlePreview.endsWith('...'), 'clipped previews are marked');
  assert.equal(summary.descriptionPreview.length, summaryLimits.description);
  assert.equal(summary.progressPreview.length, summaryLimits.progress);

  assert.equal(summary.acceptanceCriteria.length, summaryLimits.criteria);
  assert.equal(summary.criteriaCount, 20, 'the real criteria total is reported');
  assert.ok(summary.acceptanceCriteria.every(text => text.length === summaryLimits.criteriaPreview));
  assert.equal(summary.blockers.length, summaryLimits.blockers);
  assert.equal(summary.blockersCount, 16);

  assert.equal(summary.dependencies.length, 32, 'dependency edges are never truncated');
  assert.deepEqual(summary.dependencies[0], { taskId: hex(1), kind: 'artifact' });
  assert.deepEqual(summary.dependencies[1], { taskId: hex(2), kind: 'contract' });

  assert.equal(summary.candidates.length, summaryLimits.refs);
  assert.equal(summary.candidatesCount, 8);
  assert.deepEqual(summary.candidates.map(ref => ref.version), [7, 8], 'the newest candidate versions are kept, not the first page');
  assert.equal(summary.candidates[1].id, 'candidate-8'.padEnd(64, 'x'), 'reference ids stay exact');
  assert.equal(summary.candidates[0].labelPreview.length, summaryLimits.labelPreview);
  assert.deepEqual(Object.keys(summary.candidates[0]).sort(), ['id', 'labelPreview', 'version']);
  assert.equal(summary.agreedContracts.length, summaryLimits.refs);
  assert.equal(summary.contractsCount, 8);

  assert.equal(summary.validations.length, summaryLimits.validations);
  assert.equal(summary.validationsCount, 16);
  assert.deepEqual(summary.validations.map(v => [v.candidateVersion, v.outcome]), [[15, 'passed'], [16, 'failed']], 'the newest verdicts are kept');
  assert.equal(summary.validations[1].outcome, 'failed');
  assert.equal(summary.validations[0].notePreview.length, summaryLimits.notePreview);
  assert.deepEqual(Object.keys(summary.validations[0]).sort(), ['artifactId', 'at', 'candidateVersion', 'notePreview', 'outcome']);

  assert.deepEqual(summary.history, { retained: 100, lastSequence: 100, trimmed: 40 });
  assert.equal('entries' in summary.history, false, 'transition entries stay in the full record');
  assert.equal(summary.truncated, true, 'truncation is explicit UI metadata');
  assert.equal(JSON.stringify(status).includes('file:///'), false, 'no reference URI reaches a summary');
});

test('a complete record marks itself untruncated and drops empty previews', () => {
  const status = summarizeBoard({ workspaceRoot: WS, teams: [team(1)], tasks: [task(3, { state: 'accepted', revision: 2, assigneeWorkerId: hex(9) })] });
  const summary = status.tasks[0];
  assert.equal(summary.truncated, false);
  assert.equal('descriptionPreview' in summary, false);
  assert.equal('progressPreview' in summary, false);
  assert.equal(summary.criteriaCount, 0);
  assert.equal(summary.validationsCount, 0);
  assert.equal(status.teams[0].namePreview, 'Team 1');
});

test('the doubly encoded envelope stays under the bridge limit at the declared capacity', t => {
  const teams = Array.from({ length: 64 }, (_, index) => maximalTeam(index + 1));
  const tasks = Array.from({ length: 512 }, (_, index) => maximalTask(index + 1, teams[index % teams.length].id));
  const snapshot = { workspaceRoot: WS, teams, tasks };
  const before = JSON.stringify(snapshot);

  const status = summarizeBoard(snapshot);
  const inner = JSON.stringify(status);
  const envelope = envelopeSize(status);

  assert.equal(JSON.stringify(snapshot), before, 'summarizeBoard never mutates the host records');
  assert.equal(status.teams.length, 64);
  assert.equal(status.tasks.length, 512);
  assert.deepEqual(status.tasks.map(entry => entry.id), tasks.map(entry => entry.id), 'every task keeps its exact id in order');
  t.diagnostic(`adversarial 512-task/64-team envelope: ${envelope} chars (inner ${inner.length}), limit 8000000`);
  assert.ok(envelope < 8_000_000, `doubly encoded summary envelope must stay under 8M, was ${envelope}`);
  assert.ok(envelope < BRIDGE_LIMIT, 'and inside the bridge limit');
  assert.ok(inner.length < envelope, 'the envelope carries the escaped inner JSON');
  assert.equal(inner.includes('file:///'), false, 'no URI survives projection');
  assert.equal(inner.includes('"entries"'), false, 'no transition entries survive projection');
  assert.equal(inner.includes('\\u0001') || inner.includes('\\u001f'), true, 'the fixture really does contain control characters');
  assert.equal(status.tasks.every(entry => entry.truncated), true);
  assert.equal(status.tasks[0].candidatesCount, 8);
  assert.equal(status.tasks[0].validationsCount, 16);
  assert.equal(status.tasks[0].dependencies.length, 32);
});

test('projecting a snapshot copies mutable arrays and leaves the source usable', () => {
  const source = task(3, { candidates: [ref(1)] });
  const teamSource = team(1, { memberWorkerIds: [hex(9)] });
  const status = summarizeBoard({ workspaceRoot: WS, teams: [teamSource], tasks: [source] });

  status.teams[0].memberWorkerIds.push(hex(10));
  status.tasks[0].candidates[0].id = 'mutated';
  status.tasks[0].dependencies.push({ taskId: hex(4), kind: 'artifact' });

  assert.deepEqual(teamSource.memberWorkerIds, [hex(9)], 'team membership arrays are copied');
  assert.equal(source.candidates[0].id, 'candidate-1'.padEnd(64, 'x'), 'reference objects are copied');
  assert.deepEqual(source.dependencies, [], 'dependency arrays are copied');
});

test('an empty board and a host error survive projection, and result refs are never invented', () => {
  const empty = summarizeBoard({ workspaceRoot: WS, teams: [], tasks: [] });
  assert.deepEqual(empty, { workspaceRoot: WS, teams: [], tasks: [], error: undefined });

  const failed = summarizeBoard({ workspaceRoot: WS, teams: [], tasks: [], error: 'task-board.json is invalid' });
  assert.equal(failed.error, 'task-board.json is invalid');

  const withoutRef = summarizeBoard({ workspaceRoot: WS, teams: [], tasks: [task(1, { validations: [{ artifactId: 'a', candidateVersion: 1, outcome: 'failed', at: AT }] })] });
  assert.deepEqual(Object.keys(withoutRef.tasks[0].validations[0]).sort(), ['artifactId', 'at', 'candidateVersion', 'outcome']);
  assert.equal(withoutRef.tasks[0].validations[0].notePreview, undefined);

  const resultRef = { id: 'result-1', version: 3, uri: 'file:///reports/result-1.txt' };
  const withRef = task(2, { validations: [{ artifactId: 'a', candidateVersion: 1, outcome: 'passed', at: AT, resultRef }] });
  const copied = summarizeBoard({ workspaceRoot: WS, teams: [], tasks: [withRef] });
  assert.deepEqual(copied.tasks[0].validations[0].resultRef, { id: 'result-1', version: 3 }, 'the result ref keeps its exact id and version');
  assert.equal(JSON.stringify(copied).includes('reports/result-1'), false, 'the result ref URI stays in the full record');
});

test('eight artifact versions show the newest candidate and verdict with honest totals', () => {
  const candidate = n => ({ id: 'artifact-a', version: n, uri: `file:///artifact-a.v${n}.txt`, label: `build ${n}` });
  const source = task(4, {
    state: 'validating',
    revision: 12,
    candidates: Array.from({ length: 8 }, (_, index) => candidate(index + 1)),
    validations: Array.from({ length: 8 }, (_, index) => ({
      artifactId: 'artifact-a', candidateVersion: index + 1,
      outcome: index === 7 ? 'passed' : 'failed',
      note: index === 7 ? 'latest build checked' : `build ${index + 1} rejected`,
      at: AT,
    })),
  });
  const projected = summarizeBoard({ workspaceRoot: WS, teams: [team(1)], tasks: [source] }).tasks[0];
  assert.equal(projected.id, source.id, 'the task id stays exact for the open-record command');
  assert.equal(projected.candidatesCount, 8, 'the candidate total is reported');
  assert.equal(projected.validationsCount, 8, 'the verdict total is reported');
  assert.deepEqual(projected.candidates.map(ref => ref.version), [7, 8], 'the newest candidate versions are shown');
  assert.deepEqual(projected.validations.map(entry => [entry.candidateVersion, entry.outcome]), [[7, 'failed'], [8, 'passed']], 'the newest verdicts are shown');
  assert.equal(projected.validations[1].notePreview, 'latest build checked');
  assert.equal(projected.truncated, true, 'shortened lists are flagged for the UI');
  assert.equal(JSON.stringify(projected).includes('file:///'), false, 'no URI reaches the summary');
});
