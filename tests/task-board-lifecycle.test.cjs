// Lifecycle tests for the validation-acceptance gate in TaskBoard (no real workers;
// the coordinator drives an unassigned task through ready->...->accepted).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskBoard } = require('../.test-build/task-board');

const coordinator = { kind: 'coordinator', ownerId: 'co-1' };
const FIXED_AT = '2024-05-01T10:00:00.000Z';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-board-lifecycle-'));
  const workspaceRoot = path.join(root, 'workspace');
  const boardDir = path.join(root, 'sessions');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(boardDir);
  const board = new TaskBoard(boardDir, workspaceRoot, () => undefined);
  await board.open();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    board,
    boardDir,
    workspaceRoot,
    file: path.join(boardDir, 'task-board.json'),
    reopen: async () => {
      const next = new TaskBoard(boardDir, workspaceRoot, () => undefined);
      await next.open();
      return next;
    }
  };
}

async function driveToValidating(board, teamId, reqPrefix) {
  const task = await board.createTask(coordinator, {
    requestId: `${reqPrefix}-t0`, teamId, title: 'Build widget', description: 'make it', assigneeWorkerId: null
  });
  await board.updateTask(coordinator, { requestId: `${reqPrefix}-t1`, taskId: task.id, expectedRevision: 0, state: 'in_progress' });
  await board.updateTask(coordinator, {
    requestId: `${reqPrefix}-t2`, taskId: task.id, expectedRevision: 1, state: 'submitted',
    candidates: [{ id: 'a1', version: 1, uri: 'mem:a1/1' }]
  });
  await board.updateTask(coordinator, { requestId: `${reqPrefix}-t3`, taskId: task.id, expectedRevision: 2, state: 'validating' });
  return task;
}

test('distinct verdicts are kept in order; the latest verdict decides acceptability', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 'l-team', name: 'Alpha', description: '' });
  const task = await driveToValidating(board, team.id, 'l');

  // Append a passed verdict with a fixed at; it must be preserved verbatim.
  await board.updateTask(coordinator, {
    requestId: 'l-v1', taskId: task.id, expectedRevision: 3,
    validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'rep1', version: 1, uri: 'mem:rep1/1' } }]
  });
  const afterPass = board.getTask(coordinator, task.id);
  assert.deepEqual(afterPass.validations.map(v => v.outcome), ['passed']);
  assert.equal(afterPass.validations[0].at, FIXED_AT);

  // A failed verdict with a NEW report id/version for the same candidate must be recorded.
  await board.updateTask(coordinator, {
    requestId: 'l-v2', taskId: task.id, expectedRevision: 4,
    validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'failed', at: FIXED_AT, resultRef: { id: 'rep2', version: 1, uri: 'mem:rep2/1' } }]
  });
  assert.deepEqual(board.getTask(coordinator, task.id).validations.map(v => v.outcome), ['passed', 'failed']);

  // Acceptance MUST fail while the latest verdict is failed, and the revision must not move.
  await assert.rejects(
    board.updateTask(coordinator, { requestId: 'l-acc1', taskId: task.id, expectedRevision: 5, state: 'accepted' }),
    err => err.code === 'acceptance_invalid'
  );
  const stillValidating = board.getTask(coordinator, task.id);
  assert.equal(stillValidating.state, 'validating');
  assert.equal(stillValidating.revision, 5);

  // A new passed report (new id/version) is recorded; the task stays validating until explicitly accepted.
  await board.updateTask(coordinator, {
    requestId: 'l-v3', taskId: task.id, expectedRevision: 5,
    validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'rep3', version: 1, uri: 'mem:rep3/1' } }]
  });
  assert.equal(board.getTask(coordinator, task.id).state, 'validating');
  assert.equal(board.getTask(coordinator, task.id).validations.length, 3);

  // Explicit acceptance now works.
  const accepted = await board.updateTask(coordinator, { requestId: 'l-acc2', taskId: task.id, expectedRevision: 6, state: 'accepted' });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.revision, 7);
  // The three distinct verdicts are all preserved in order.
  assert.equal(board.getTask(coordinator, task.id).validations.length, 3);
});

test('validations require the exact candidate and keep reused resultRefs immutable', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 'r-team', name: 'Beta', description: '' });
  const task = await driveToValidating(board, team.id, 'r');

  // Exact candidateVersion missing is rejected.
  await assert.rejects(
    board.updateTask(coordinator, {
      requestId: 'r-missing', taskId: task.id, expectedRevision: 3,
      validations: [{ artifactId: 'a1', candidateVersion: 2, outcome: 'passed', at: FIXED_AT }]
    }),
    err => err.code === 'validation_invalid'
  );

  const base = { artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'rep1', version: 1, uri: 'mem:rep1/1', label: 'run-1' } };
  const first = await board.updateTask(coordinator, { requestId: 'r-v1', taskId: task.id, expectedRevision: 3, validations: [base] });
  assert.equal(first.revision, 4);
  assert.equal(board.getTask(coordinator, task.id).validations[0].at, FIXED_AT);

  // Reusing the SAME report id/version with a different uri is rejected.
  await assert.rejects(
    board.updateTask(coordinator, {
      requestId: 'r-uri', taskId: task.id, expectedRevision: 4,
      validations: [{ ...base, resultRef: { ...base.resultRef, uri: 'mem:other/1' } }]
    }),
    err => err.code === 'validation_invalid'
  );
  // Reusing it with the same uri but a different label is rejected too.
  await assert.rejects(
    board.updateTask(coordinator, {
      requestId: 'r-label', taskId: task.id, expectedRevision: 4,
      validations: [{ ...base, resultRef: { ...base.resultRef, label: 'run-2' } }]
    }),
    err => err.code === 'validation_invalid'
  );
  // A NEW report id/version is allowed.
  const next = await board.updateTask(coordinator, {
    requestId: 'r-v2', taskId: task.id, expectedRevision: 4,
    validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'failed', at: FIXED_AT, resultRef: { id: 'rep2', version: 1, uri: 'mem:rep2/1', label: 'run-1' } }]
  });
  assert.equal(next.revision, 5);
  assert.equal(board.getTask(coordinator, task.id).validations.length, 2);

  // Reload with a no-op resolver: the `at` metadata survived and a replayed requestId returns the ORIGINAL record.
  const reloaded = await fx.reopen();
  const view = reloaded.getTask(coordinator, task.id);
  assert.equal(view.state, 'validating');
  assert.deepEqual(view.validations.map(v => v.at), [FIXED_AT, FIXED_AT]);
  const replay = await reloaded.updateTask(coordinator, { requestId: 'r-v1', taskId: task.id, expectedRevision: 3, validations: [base] });
  assert.equal(replay.id, first.id);
  assert.equal(replay.revision, first.revision);
  assert.deepEqual(replay.validations, first.validations);
  assert.deepEqual(replay.history.entries.map(e => e.reason), first.history.entries.map(e => e.reason));
  assert.equal(reloaded.getTask(coordinator, task.id).revision, 5);
});

test('same-state progress update and exact candidate idempotency', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 's-team', name: 'Gamma', description: '' });
  const task = await board.createTask(coordinator, {
    requestId: 's-t0', teamId: team.id, title: 'Same state', description: 'd', assigneeWorkerId: null
  });
  assert.equal(task.state, 'ready');

  // Same-state (ready->ready) progress update with an explicit 300-char reason succeeds.
  const reason = 'x'.repeat(300);
  const sameState = await board.updateTask(coordinator, {
    requestId: 's-same', taskId: task.id, expectedRevision: 0, state: 'ready', progress: 'half done', reason
  });
  assert.equal(sameState.state, 'ready');
  assert.equal(sameState.revision, 1);
  assert.equal(sameState.progress, 'half done');
  assert.equal(sameState.history.entries[sameState.history.entries.length - 1].reason, reason);

  // Fill 8 unique v1 candidates in one update.
  const refs = Array.from({ length: 8 }, (_, i) => ({ id: `c${i + 1}`, version: 1, uri: `mem:c${i + 1}/1` }));
  await board.updateTask(coordinator, { requestId: 's-cands', taskId: task.id, expectedRevision: 1, candidates: refs });
  assert.equal(board.getTask(coordinator, task.id).candidates.length, 8);

  // Exact re-read of one existing ref (new requestId) is a no-op and succeeds.
  await board.updateTask(coordinator, { requestId: 's-reread', taskId: task.id, expectedRevision: 2, candidates: [refs[0]] });
  assert.equal(board.getTask(coordinator, task.id).candidates.length, 8);

  // Same id/version with a changed LABEL is a ref_conflict.
  await assert.rejects(
    board.updateTask(coordinator, {
      requestId: 's-label', taskId: task.id, expectedRevision: 3,
      candidates: [{ ...refs[0], label: 'mutated' }]
    }),
    err => err.code === 'ref_conflict'
  );
  assert.equal(board.getTask(coordinator, task.id).revision, 3);

  // A 9th unique candidate exceeds the candidates capacity.
  await assert.rejects(
    board.updateTask(coordinator, {
      requestId: 's-ninth', taskId: task.id, expectedRevision: 3,
      candidates: [{ id: 'c9', version: 1, uri: 'mem:c9/1' }]
    }),
    err => err.code === 'capacity_exceeded'
  );
});

test('mutating global guard rejects queued and replayed calls when the feature is disabled', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-board-guard-'));
  const workspaceRoot = path.join(root, 'workspace');
  const boardDir = path.join(root, 'sessions');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(boardDir);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const enabled = { value: true };
  const guard = () => {
    if (!enabled.value) {
      const e = new Error('The task board is disabled.');
      e.code = 'feature_disabled';
      throw e;
    }
  };
  const board = new TaskBoard(boardDir, workspaceRoot, () => undefined, guard);
  await board.open();

  const team = await board.createTeam(coordinator, { requestId: 'g-team', name: 'Delta', description: '' });
  const task = await board.createTask(coordinator, {
    requestId: 'g-t0', teamId: team.id, title: 'Guarded', description: 'd', assigneeWorkerId: null
  });
  const ok = await board.updateTask(coordinator, { requestId: 'g-upd', taskId: task.id, expectedRevision: 0, progress: 'ok' });
  assert.equal(ok.revision, 1);

  // Disabling the feature: a fresh mutation is rejected before it is even queued/recorded.
  enabled.value = false;
  await assert.rejects(
    board.updateTask(coordinator, { requestId: 'g-fresh', taskId: task.id, expectedRevision: 1, progress: 'x' }),
    err => err.code === 'feature_disabled'
  );
  // A replay of the SAME previously-successful receipt is also rejected, and the revision does not move.
  await assert.rejects(
    board.updateTask(coordinator, { requestId: 'g-upd', taskId: task.id, expectedRevision: 0, progress: 'ok' }),
    err => err.code === 'feature_disabled'
  );
  assert.equal(board.getTask(coordinator, task.id).revision, 1);
});

async function driveToAccepted(board, teamId, p) {
  const task = await board.createTask(coordinator, {
    requestId: `${p}-t0`, teamId, title: 'Accepted', description: 'd', assigneeWorkerId: null
  });
  await board.updateTask(coordinator, { requestId: `${p}-t1`, taskId: task.id, expectedRevision: 0, state: 'in_progress' });
  await board.updateTask(coordinator, {
    requestId: `${p}-t2`, taskId: task.id, expectedRevision: 1, state: 'submitted',
    candidates: [{ id: 'a1', version: 1, uri: 'mem:a1/1' }]
  });
  await board.updateTask(coordinator, { requestId: `${p}-t3`, taskId: task.id, expectedRevision: 2, state: 'validating' });
  await board.updateTask(coordinator, {
    requestId: `${p}-v`, taskId: task.id, expectedRevision: 3,
    validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'rep1', version: 1, uri: 'mem:rep1/1' } }]
  });
  await board.updateTask(coordinator, { requestId: `${p}-acc`, taskId: task.id, expectedRevision: 4, state: 'accepted' });
  return task;
}

test('a valid accepted board reloads cleanly and stays accepted', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 'd-team', name: 'Eps', description: '' });
  const task = await driveToAccepted(board, team.id, 'd');
  assert.equal(board.getTask(coordinator, task.id).state, 'accepted');
  const reloaded = await fx.reopen();
  const view = reloaded.getTask(coordinator, task.id);
  assert.equal(view.state, 'accepted');
  assert.equal(view.validations.length, 1);
});

test('tampered accepted verdict or malformed receipt rejects as board_malformed with bytes untouched', async t => {
  const mk = async (name) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), name));
    const ws = path.join(root, 'ws');
    const dir = path.join(root, 'sessions');
    await fs.mkdir(ws);
    await fs.mkdir(dir);
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    return { root, ws, dir, file: path.join(dir, 'task-board.json') };
  };

  // Copy 1: tamper the accepted verdict (flip to failed) -> acceptance invariant broken.
  const a = await mk('codex-tamper-verdict-');
  let board = new TaskBoard(a.dir, a.ws, () => undefined);
  await board.open();
  const team = await board.createTeam(coordinator, { requestId: 'd-team', name: 'Eps', description: '' });
  await driveToAccepted(board, team.id, 'd');
  const verdictBytes = await fs.readFile(a.file, 'utf8');
  const verdictData = JSON.parse(verdictBytes);
  verdictData.tasks[0].validations[0].outcome = 'failed';
  const verdictTampered = JSON.stringify(verdictData);
  await fs.writeFile(a.file, verdictTampered);
  await assert.rejects(
    new TaskBoard(a.dir, a.ws, () => undefined).open(),
    err => err.code === 'board_malformed'
  );
  assert.equal(await fs.readFile(a.file, 'utf8'), verdictTampered);

  // Copy 2: corrupt a stored receipt result -> must not parse as a team or task.
  const b = await mk('codex-tamper-receipt-');
  board = new TaskBoard(b.dir, b.ws, () => undefined);
  await board.open();
  const team2 = await board.createTeam(coordinator, { requestId: 'd-team', name: 'Eps', description: '' });
  await driveToAccepted(board, team2.id, 'd');
  const receiptBytes = await fs.readFile(b.file, 'utf8');
  const receiptData = JSON.parse(receiptBytes);
  receiptData.requests[Object.keys(receiptData.requests)[0]].result = { bogus: true };
  const receiptTampered = JSON.stringify(receiptData);
  await fs.writeFile(b.file, receiptTampered);
  await assert.rejects(
    new TaskBoard(b.dir, b.ws, () => undefined).open(),
    err => err.code === 'board_malformed'
  );
  assert.equal(await fs.readFile(b.file, 'utf8'), receiptTampered);
});

test('one update cannot store two reports with the same id/version but different URIs', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 'c-team', name: 'Zeta', description: '' });
  const task = await driveToValidating(board, team.id, 'c');
  const before = board.getTask(coordinator, task.id);
  await assert.rejects(
    board.updateTask(coordinator, {
      requestId: 'c-clash', taskId: task.id, expectedRevision: 3,
      validations: [
        { artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'rep1', version: 1, uri: 'mem:A/1' } },
        { artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'rep1', version: 1, uri: 'mem:B/1' } }
      ]
    }),
    err => err.code === 'validation_invalid'
  );
  const after = board.getTask(coordinator, task.id);
  assert.equal(after.state, 'validating');
  assert.equal(after.revision, before.revision);
  assert.equal(after.validations.length, 0);
});

test('same-state blocker reports do not trigger transition_blocked', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-blocker-'));
  const workspaceRoot = path.join(root, 'workspace');
  const boardDir = path.join(root, 'sessions');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(boardDir);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const workerId = 'a'.repeat(32);
  const resolver = (id) => id === workerId ? { id, workspaceRoot, ownerId: 'co-1' } : undefined;
  const board = new TaskBoard(boardDir, workspaceRoot, resolver);
  await board.open();
  const worker = { kind: 'worker', workerId };

  const team = await board.createTeam(coordinator, { requestId: 'b-team', name: 'Blk', description: '' });
  await board.updateTeam(coordinator, { requestId: 'b-add', teamId: team.id, expectedRevision: 0, addMembers: [workerId] });

  const task = await board.createTask(coordinator, {
    requestId: 'b-t0', teamId: team.id, title: 'Blocked', description: 'd', assigneeWorkerId: workerId
  });

  // ready -> in_progress (true start) succeeds with no blockers
  await board.updateTask(coordinator, { requestId: 'b-start', taskId: task.id, expectedRevision: 0, state: 'in_progress' });

  // in_progress same-state: report progress + blocker
  const r1 = await board.updateTask(coordinator, {
    requestId: 'b-same1', taskId: task.id, expectedRevision: 1,
    state: 'in_progress', progress: 'waiting', blockers: ['waiting on review']
  });
  assert.equal(r1.state, 'in_progress');
  assert.equal(r1.revision, 2);
  assert.equal(r1.progress, 'waiting');
  assert.deepEqual(r1.blockers, ['waiting on review']);

  // in_progress same-state: repeat blocker report (repeats while blocked)
  const r2 = await board.updateTask(coordinator, {
    requestId: 'b-same2', taskId: task.id, expectedRevision: 2,
    state: 'in_progress', progress: 'still waiting', blockers: ['waiting on review']
  });
  assert.equal(r2.state, 'in_progress');
  assert.equal(r2.revision, 3);

  // submitted same-state metadata reports blocker
  await board.updateTask(coordinator, {
    requestId: 'b-submit', taskId: task.id, expectedRevision: 3, state: 'submitted',
    blockers: [],
    candidates: [{ id: 'a1', version: 1, uri: 'mem:a1/1' }]
  });
  const r3 = await board.updateTask(coordinator, {
    requestId: 'b-same3', taskId: task.id, expectedRevision: 4,
    state: 'submitted', blockers: ['needs metadata fix']
  });
  assert.equal(r3.state, 'submitted');
  assert.equal(r3.revision, 5);
  assert.deepEqual(r3.blockers, ['needs metadata fix']);

  // acceptance is blocked while blockers remain
  await board.updateTask(coordinator, { requestId: 'b-val', taskId: task.id, expectedRevision: 5, state: 'validating', blockers: ['needs metadata fix'] });
  await assert.rejects(
    board.updateTask(coordinator, {
      requestId: 'b-acc', taskId: task.id, expectedRevision: 6, state: 'accepted',
      validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'r1', version: 1, uri: 'mem:r1/1' } }]
    }),
    err => err.code === 'acceptance_invalid'
  );
  assert.equal(board.getTask(coordinator, task.id).state, 'validating');

  // clear the blocker (same-state validating), then a TRUE validating->in_progress start succeeds
  await board.updateTask(coordinator, { requestId: 'b-clear', taskId: task.id, expectedRevision: 6, blockers: [] });
  await board.updateTask(coordinator, { requestId: 'b-back', taskId: task.id, expectedRevision: 7, state: 'in_progress' });
  const r4 = await board.updateTask(worker, {
    requestId: 'b-w-same', taskId: task.id, expectedRevision: 8,
    state: 'in_progress', progress: 'fixing', blockers: ['needs metadata fix']
  });
  assert.equal(r4.state, 'in_progress');
  assert.equal(r4.revision, 9);
  assert.deepEqual(r4.blockers, ['needs metadata fix']);
});

test('true start with blockers still rejects as transition_blocked', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 'tb-team', name: 'TB', description: '' });
  const task = await board.createTask(coordinator, {
    requestId: 'tb-t0', teamId: team.id, title: 'TB', description: 'd', assigneeWorkerId: null
  });

  // ready with blockers -> in_progress must reject
  await board.updateTask(coordinator, { requestId: 'tb-blk', taskId: task.id, expectedRevision: 0, blockers: ['external dep'] });
  await assert.rejects(
    board.updateTask(coordinator, { requestId: 'tb-start', taskId: task.id, expectedRevision: 1, state: 'in_progress' }),
    err => err.code === 'transition_blocked'
  );
  assert.equal(board.getTask(coordinator, task.id).state, 'ready');

  // the blocker update itself is a same-state (ready) mutation: revision 0 -> 1
  assert.equal(board.getTask(coordinator, task.id).revision, 1);
  // clear blockers, start succeeds
  await board.updateTask(coordinator, { requestId: 'tb-clear', taskId: task.id, expectedRevision: 1, blockers: [] });
  const started = await board.updateTask(coordinator, { requestId: 'tb-start2', taskId: task.id, expectedRevision: 2, state: 'in_progress' });
  assert.equal(started.state, 'in_progress');

  // in_progress with blockers -> submitted must reject
  await board.updateTask(coordinator, { requestId: 'tb-blk2', taskId: task.id, expectedRevision: 3, blockers: ['wip'] });
  await assert.rejects(
    board.updateTask(coordinator, {
      requestId: 'tb-sub', taskId: task.id, expectedRevision: 4, state: 'submitted',
      candidates: [{ id: 'a1', version: 1, uri: 'mem:a1/1' }]
    }),
    err => err.code === 'transition_blocked'
  );
  assert.equal(board.getTask(coordinator, task.id).state, 'in_progress');
});

/** Convenience: read the CURRENT revision so test flows never depend on manual revision counts. */
const mkUpdate = (board, taskId) => {

  return async (input, attemptId) => {
    const base = board.getTask(coordinator, taskId).revision;
    const promise = board.updateTask(coordinator, { ...input, taskId, expectedRevision: base });
    try {
      const result = await promise;

      return result;
    } catch (error) {
      await assert.rejects(promise, err => err.code === error.code);
      // failed mutations do not move the revision
      if (board.getTask(coordinator, taskId).revision !== base) {
        throw new Error(`revision moved after rejected ${attemptId}`);
      }
      throw error;
    }
  };
};

test('contract refs cannot be re-bound to a different uri/label after removal or replay', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 'cr-team', name: 'Crt', description: '' });
  const task = await board.createTask(coordinator, {
    requestId: 'cr-t0', teamId: team.id, title: 'Contracts', description: 'd', assigneeWorkerId: null
  });
  const upd = mkUpdate(board, task.id);

  const orig = { id: 'c1', version: 1, uri: 'mem:c1/1', label: 'L1' };
  await upd({ requestId: 'cr-add1', agreedContracts: { add: [orig] } }, 'add1');
  assert.deepEqual(board.getTask(coordinator, task.id).agreedContracts, [orig]);
  const bytesAfterAdd = await fs.readFile(fx.file, 'utf8');

  // (A1) Same-call remove+add of the SAME id/version with a different uri is rejected,
  // and leaves revision, durable bytes and receipts untouched.
  await assert.rejects(
    upd({ requestId: 'cr-clash', agreedContracts: { remove: [{ id: 'c1', version: 1 }], add: [{ id: 'c1', version: 1, uri: 'mem:c1/X' }] } }, 'clash'),
    err => err.code === 'ref_conflict'
  );
  assert.deepEqual(board.getTask(coordinator, task.id).agreedContracts, [orig]);
  assert.equal(await fs.readFile(fx.file, 'utf8'), bytesAfterAdd);


  // (A2) A PROPER removal succeeds; after a reload the same id/version still cannot be re-bound
  // to a different uri or label, while the ORIGINAL ref can be reactivated and a NEW version may
  // carry a new uri.
  await upd({ requestId: 'cr-remove', agreedContracts: { remove: [{ id: 'c1', version: 1 }] } }, 'remove');
  assert.deepEqual(board.getTask(coordinator, task.id).agreedContracts, []);
  const reloaded = await fx.reopen();
  const upd2 = mkUpdate(reloaded, task.id);
  await assert.rejects(
    upd2({ requestId: 'cr-rebind-uri', agreedContracts: { add: [{ id: 'c1', version: 1, uri: 'mem:c1/other' }] } }, 'rebind-uri'),
    err => err.code === 'ref_conflict'
  );
  await assert.rejects(
    upd2({ requestId: 'cr-rebind-label', agreedContracts: { add: [{ id: 'c1', version: 1, uri: 'mem:c1/1', label: 'L2' }] } }, 'rebind-label'),
    err => err.code === 'ref_conflict'
  );
  // (A2b) Replaying the ORIGINAL add receipt while the contract is STILL removed returns the
  // original result and reactivates nothing, leaving durable bytes untouched.
  const bytesAfterRemove = await fs.readFile(fx.file, 'utf8');
  const earlyReplay = await reloaded.updateTask(coordinator, { requestId: 'cr-add1', taskId: task.id, expectedRevision: 0, agreedContracts: { add: [orig] } });
  assert.deepEqual(earlyReplay.agreedContracts, [orig]);
  assert.deepEqual(reloaded.getTask(coordinator, task.id).agreedContracts, []);
  assert.equal(await fs.readFile(fx.file, 'utf8'), bytesAfterRemove);
  const reactivated = await upd2({ requestId: 'cr-orig', agreedContracts: { add: [orig] } }, 'orig');
  assert.deepEqual(reactivated.agreedContracts, [orig]);
  const newer = await upd2({ requestId: 'cr-v2', agreedContracts: { add: [{ id: 'c1', version: 2, uri: 'mem:c1/2' }] } }, 'v2');
  assert.equal(newer.agreedContracts.length, 2);
  assert.deepEqual(newer.agreedContracts.find(ref => ref.version === 2), { id: 'c1', version: 2, uri: 'mem:c1/2' });

  // (A3) Replaying the ORIGINAL add receipt does not overwrite the newer current version.

  const replay = await reloaded.updateTask(coordinator, { requestId: 'cr-add1', taskId: task.id, expectedRevision: 0, agreedContracts: { add: [orig] } });
  assert.deepEqual(replay.agreedContracts, [orig]);
  assert.deepEqual(reloaded.getTask(coordinator, task.id).agreedContracts, [orig, { id: 'c1', version: 2, uri: 'mem:c1/2' }]);
});

test('report refs recorded by validations keep their identity across rework and reload', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 'rr-team', name: 'Rpt', description: '' });
  const task = await driveToValidating(board, team.id, 'rr');
  const upd = mkUpdate(board, task.id);

  const report = { id: 'r1', version: 1, uri: 'mem:r1/1', label: 'A' };
  await upd({
    requestId: 'rr-v1',
    validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: report }]
  }, 'v1');
  assert.equal(board.getTask(coordinator, task.id).validations.length, 1);

  // Rework back to in_progress clears the verdicts (the report ref remains in durable history).
  await upd({ requestId: 'rr-back', state: 'in_progress' }, 'back');
  assert.equal(board.getTask(coordinator, task.id).validations.length, 0);

  // Re-submit while still holding candidate a1, then validate and RELOAD.
  await upd({ requestId: 'rr-sub2', state: 'submitted', candidates: [{ id: 'a1', version: 1, uri: 'mem:a1/1' }] }, 'sub2');
  await upd({ requestId: 'rr-val2', state: 'validating' }, 'val2');
  const reloaded = await fx.reopen();
  const upd2 = mkUpdate(reloaded, task.id);

  // Reusing r1/v1 with a changed uri or label is rejected atomically (no revision/bytes/receipt change).
  const bytesBefore = await fs.readFile(fx.file, 'utf8');
  await assert.rejects(
    upd2({
      requestId: 'rr-uri',
      validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'r1', version: 1, uri: 'mem:r1/other', label: 'A' } }]
    }, 'uri'),
    err => err.code === 'validation_invalid'
  );
  await assert.rejects(
    upd2({
      requestId: 'rr-label',
      validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'r1', version: 1, uri: 'mem:r1/1', label: 'B' } }]
    }, 'label'),
    err => err.code === 'validation_invalid'
  );
  assert.equal(await fs.readFile(fx.file, 'utf8'), bytesBefore);
  assert.equal(reloaded.getTask(coordinator, task.id).validations.length, 0);

  // The ORIGINAL uri+label is allowed again, and a NEW version of the SAME report may carry a new uri.
  const same = await upd2({
    requestId: 'rr-orig',
    validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: report }]
  }, 'orig');
  assert.deepEqual(same.validations.map(v => v.resultRef), [report]);
  const newer = await upd2({
    requestId: 'rr-new',
    validations: [{ artifactId: 'a1', candidateVersion: 1, outcome: 'passed', at: FIXED_AT, resultRef: { id: 'r1', version: 2, uri: 'mem:r1/2' } }]
  }, 'new');
  assert.equal(newer.validations.length, 2);
  assert.deepEqual(newer.validations[1].resultRef, { id: 'r1', version: 2, uri: 'mem:r1/2' });
});

test('a ref identity conflict between a historical receipt and the current record fails open() closed', async t => {
  const fx = await fixture(t);
  const board = fx.board;
  const team = await board.createTeam(coordinator, { requestId: 'tp-team', name: 'Tmp', description: '' });
  await driveToValidating(board, team.id, 'tp');
  const data = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  // Rebind the CURRENT candidate ref to a different uri; a historical receipt still holds the original uri.
  data.tasks[0].candidates[0].uri = 'mem:a1/tampered';
  const tampered = JSON.stringify(data);
  await fs.writeFile(fx.file, tampered);
  await assert.rejects(
    new TaskBoard(fx.boardDir, fx.workspaceRoot, () => undefined).open(),
    err => err.code === 'board_malformed'
  );
  assert.equal(await fs.readFile(fx.file, 'utf8'), tampered);
});

// END_LIFECYCLE_TESTS
