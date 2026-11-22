// End-to-end acceptance flow for ONE governed coordinator integration attempt.
//
// A real WorkerBroker drives the real task board, the real private views, the
// real resource governor and the real physical runner. Only the model is
// scripted: an in-memory provider returns the next queued tool call, so no
// inference, network, Git repository or live checkout is involved. The
// workspace is a temporary, non-Git fixture that is removed afterwards.
//
// The scenario is deliberately a true integration (not a rename):
//   add.cjs      base: input + 1        producer A: input + 2
//   multiply.cjs base: input * 2        producer B: input * 2.5
//   verify.cjs   asserts multiply(add(3)) <= 10 (never edited by anyone)
// Each producer passes the agreed command alone (10 <= 10), but the composed
// seed reaches 12.5 and really fails `node verify.cjs`. A validation-lane
// worker therefore produces a failing runner result that `validate` must
// reject; only a service-lane integration worker that privately repairs the
// incompatible multiply behavior over the SAME derived seed - keeping the
// agreed verification script and its assertion byte-identical - can be
// validated, accepted and applied.
//
// Run with STEP5_TEST_BUILD (or CODEX_TEST_BUILD) pointing at a private build
// directory; the shared .test-build belongs to another owner. The focused build
// for this file is .test-step5-flow.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const build = path.resolve(__dirname, '..', process.env.STEP5_TEST_BUILD?.trim()
  || process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { WorkerBroker, unpack } = require(path.join(build, 'runtime'));
const { defaults } = require(path.join(build, 'engine'));
const { resourceDefaults } = require(path.join(build, 'resource-governor'));
let integrationActionSchema;
try {
  ({ integrationActionSchema } = require(path.join(build, 'integration-attempts')));
} catch (error) {
  throw new Error(`stale integration build at ${build}: ${error instanceof Error ? error.message : String(error)}`);
}
// Fail loudly on a stale compile instead of silently skipping the flow.
if (typeof integrationActionSchema?.parse !== 'function') {
  throw new Error(`stale integration build at ${build}; recompile it (STEP5_TEST_BUILD=<dir>)`);
}

const execute = promisify(execFile);
const model = { id: 'test/integration-flow', name: 'Fixture', vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 };
const ownerId = 'flow-owner';
const TEST_TIMEOUT = 180_000;
const AGREED = 'node verify.cjs';

// The two producers each keep the agreed command green on their own...
const ADD_BASE = 'module.exports = value => value + 1;\n';
const ADD_CHANGED = 'module.exports = value => value + 2;\n';
const MULTIPLY_BASE = 'module.exports = value => value * 2;\n';
const MULTIPLY_CHANGED = 'module.exports = value => value * 2.5;\n';
// The integration lane repairs the incompatible behavior, not the oracle: the
// agreed script and its assertion are left exactly as the base captured them.
const MULTIPLY_FIXED = 'module.exports = value => Math.min(value * 2.5, 10);\n';
// A later behavior-preserving edit on the SAME overlay: only a comment is
// appended, so the artifact bytes change while the behavior does not.
const MULTIPLY_FIXED_NOTE = `${MULTIPLY_FIXED}// behavior-preserving note\n`;
const verify = () => [
  "const add = require('./add.cjs');",
  "const multiply = require('./multiply.cjs');",
  'const combined = multiply(add(3));',
  'if (!(combined <= 10)) {',
  "  process.stdout.write('combined ' + combined + ' exceeds 10\\n');",
  '  process.exit(1);',
  '}',
  "process.stdout.write('combined ' + combined);",
  ''
].join('\n');
const VERIFY_BASE = verify();
const USER_EDIT = 'module.exports = value => value + 99;\n';

// -- downstream round trip ----------------------------------------------------
// A is accepted on its own board decision. B then consumes A's exact artifact
// as a real dependency seed: B is bound to the derived A seed, proves it sees
// A's bytes, and adds its own disjoint edit. B's publishing integration selects
// ONLY B, so it must round-trip the whole A+B result onto the captured baseline.
const MULTIPLY_CONSUMER = 'module.exports = value => value + value;\n';
// 10 only when A's edit is present: the captured add base yields 8, so the
// composed seed really proves that A was incorporated, not just B.
const downstreamVerify = () => [
  "const add = require('./add.cjs');",
  "const multiply = require('./multiply.cjs');",
  'const combined = multiply(add(3));',
  'if (combined !== 10) {',
  "  process.stdout.write('combined ' + combined + ' is not 10');",
  '  process.exit(1);',
  '}',
  "process.stdout.write('combined ' + combined);",
  ''
].join('\n');
const DOWNSTREAM_VERIFY = downstreamVerify();

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * One temporary non-Git fixture driven by the real broker: the real task board,
 * the real private views, the real resource governor, the real physical runner
 * and the real publication path. Only the model is scripted, so every recorded
 * effect is the production one and no live checkout is ever touched.
 */
async function startFlow(t, captured) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'step5-flow-')));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  for (const [name, text] of Object.entries(captured)) {
    await fs.writeFile(path.join(root, name), text);
  }
  const state = {
    // Real governor and real runner; the board, views and integration are live opt-ins.
    config: { ...resourceDefaults, enabled: true },
    models: { [model.id]: { allowWrite: true, allowShell: true, numSessions: 4 } },
    actions: [], requests: [], approvals: [], errors: []
  };
  const options = {
    storage: path.join(base, 'storage'), registry: path.join(base, 'bridges'), roots: [root], identity: `folder:${root}`,
    provider: {
      models: async () => [model], countTokens: async () => 10,
      async *stream(selected, messages, tools) {
        state.requests.push({ selected, messages, tools });
        yield state.actions.shift() ?? { type: 'text', text: 'done' };
      }
    },
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: state.models }),
    taskBoardEnabled: () => true, isolatedViewsEnabled: () => true, integrationEnabled: () => true,
    resourcesEnabled: () => true, resources: () => state.config, resourceDirectory: path.join(base, 'resources'),
    runners: () => ({ enabled: true, capacity: 1, maxQueue: 8 }),
    files: {
      canWrite: () => true, allowShell: () => true,
      // A real approval prompt: it only ever approves a command whose cwd stays
      // inside this temporary fixture, never a repo or system directory.
      approveCommand: async (command, cwd) => {
        const allowed = inside(base, cwd);
        state.approvals.push({ command, cwd, allowed });
        return allowed;
      }
    },
    openDocuments: () => [], publicationDocuments: () => [],
    onChange: () => {}, onError: message => { state.errors.push(message); }
  };
  const broker = new WorkerBroker(options);
  const watchdog = setTimeout(() => {
    console.error('integration flow exceeded its watchdog budget');
    process.exit(1);
  }, 300_000);
  watchdog.unref();
  t.after(async () => {
    clearTimeout(watchdog);
    await broker.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  await broker.start();
  const call = async (name, args) => unpack(await broker.invoke(root, name, args));
  return { base, root, captured, state, broker, call };
}

/**
 * The governed actions both flows share: private edit, real physical-runner
 * proof, seal, governed spawn and the two board transitions of a submission.
 * Every assertion stays at its call site; only the invocations are shared.
 */
function flowActions({ broker, root, call, state, captured }, teamId) {
  const stopped = async id => {
    await call('subagent_wait', { ids: [id], timeoutMs: 60_000 });
    const session = await broker.session(root, id);
    assert.equal(session.state, 'completed', `worker ${id} did not stop: ${JSON.stringify(session.turns.at(-1)?.error)}`);
    return session;
  };
  const toolResult = (session, name) => {
    const entry = session.turns.at(-1).tools.find(tool => tool.call.name === name);
    assert.ok(entry, `the last turn must contain a ${name} call`);
    return JSON.parse(entry.result);
  };
  const turn = async (id, requestId, action) => {
    state.actions.push(action);
    await call('subagent_send', { ownerId, id, requestId, message: requestId });
    return stopped(id);
  };
  const runCommand = () => ({ type: 'call', id: 'run', name: 'run_command', input: { command: AGREED, path: '.' } });
  const seal = (requestId, expectedRevision) => ({
    type: 'call', id: 'seal', name: 'seal_submission', input: { requestId, expectedRevision }
  });
  /** Normal governed create-bind-start with the exact current team/task revisions. */
  const spawn = async (requestId, taskId, lane, snapshotId, prompt) => {
    const currentTeam = await call('subagent_team_get', { ownerId, id: teamId });
    const currentTask = await call('subagent_task_get', { ownerId, id: taskId });
    return call('subagent_isolated_spawn', {
      ownerId, requestId, task: prompt, model: model.id, permission: 'workspace-write',
      setup: {
        teamId, taskId, snapshotId,
        teamRevision: currentTeam.revision, taskRevision: currentTask.revision, lane
      }
    });
  };
  const submit = async (taskId, artifact, label) => {
    const current = await call('subagent_task_get', { ownerId, id: taskId });
    const started = await call('subagent_task_update', {
      ownerId, requestId: `${label}-start`, taskId, expectedRevision: current.revision, state: 'in_progress'
    });
    assert.equal(started.state, 'in_progress');
    const submitted = await call('subagent_task_update', {
      ownerId, requestId: `${label}-submit`, taskId, expectedRevision: started.revision,
      candidates: [artifact], state: 'submitted'
    });
    assert.equal(submitted.state, 'submitted');
    assert.deepEqual(submitted.candidates, [artifact]);
    return submitted;
  };
  // --- private edit, real passing runner result and the sealed ref it proves --
  const produce = async (requestId, taskId, file, content, snapshotId) => {
    state.actions.push({ type: 'call', id: 'edit', name: 'write_file', input: { path: file, expectedHash: hash(captured[file]), content } });
    const worker = await spawn(requestId, taskId, 'work', snapshotId, `Change ${file}`);
    const edited = await stopped(worker.id);
    assert.equal(toolResult(edited, 'write_file').revision, 1);
    const sealed = toolResult(await turn(worker.id, `${requestId}-seal`, seal(`${requestId}-seal`, 1)), 'seal_submission');
    assert.equal(sealed.revision, 1);
    assert.equal(sealed.snapshotId, snapshotId);
    const run = toolResult(await turn(worker.id, `${requestId}-run`, runCommand()), 'run_command');
    // The artifact is proved by this exact passing physical-runner result.
    assert.equal(run.outcome, 'succeeded', JSON.stringify(run));
    assert.equal(run.exitCode, 0);
    assert.equal(run.import, 'unchanged', 'the agreed command changes no file, so its input revision is proven unchanged');
    assert.equal(run.attempt.inputVersion.revision, 1);
    return {
      worker,
      artifact: { id: sealed.id, version: sealed.version, uri: sealed.uri },
      evidence: { id: run.id, version: run.version, uri: run.uri }
    };
  };
  return { stopped, toolResult, turn, runCommand, seal, spawn, submit, produce };
}

test('two selected task artifacts are integrated, validated, accepted and applied only when the composed seed really passes', { timeout: TEST_TIMEOUT }, async t => {
  const captured = { 'add.cjs': ADD_BASE, 'multiply.cjs': MULTIPLY_BASE, 'verify.cjs': VERIFY_BASE };
  const fixture = await startFlow(t, captured);
  const { root, state, call } = fixture;

  // The base snapshot is captured BEFORE any producer starts, so it is the real
  // original base of every selected artifact.
  const team = await call('subagent_team_create', { ownerId, requestId: 'team', name: 'Integration flow', description: '' });
  const baseSnapshot = await call('subagent_snapshot_create', { ownerId, teamId: team.id, requestId: 'base-snapshot' });
  assert.match(baseSnapshot.id, /^[a-f0-9]{64}$/);
  const createTask = (requestId, title) => call('subagent_task_create', {
    ownerId, requestId, teamId: team.id, title, description: `Task ${title}`,
    acceptanceCriteria: [`${AGREED} passes on the integrated result`]
  });
  const taskA = await createTask('task-add', 'add');
  const taskB = await createTask('task-multiply', 'multiply');
  // An eligible unrelated task must stay untouched and ready throughout.
  const unrelated = await createTask('task-unrelated', 'unrelated');
  assert.equal(unrelated.state, 'ready');

  const { stopped, toolResult, turn, runCommand, seal, spawn, submit, produce } = flowActions(fixture, team.id);

  const producerA = await produce('work-add', taskA.id, 'add.cjs', ADD_CHANGED, baseSnapshot.id);
  const submittedA = await submit(taskA.id, producerA.artifact, 'add');
  const producerB = await produce('work-multiply', taskB.id, 'multiply.cjs', MULTIPLY_CHANGED, baseSnapshot.id);
  const submittedB = await submit(taskB.id, producerB.artifact, 'multiply');

  // --- begin: the exact explicit selection of BOTH submitted artifacts -------
  const begin = await call('subagent_integration', {
    action: 'begin', ownerId, teamId: team.id, requestId: 'begin',
    sources: [
      { taskId: submittedA.id, taskRevision: submittedA.revision, artifact: producerA.artifact, evidence: [producerA.evidence] },
      { taskId: submittedB.id, taskRevision: submittedB.revision, artifact: producerB.artifact, evidence: [producerB.evidence] }
    ],
    validationCommands: [AGREED]
  });
  assert.equal(begin.status, 'ready', JSON.stringify(begin.failure));
  assert.equal(begin.revision, 1);
  assert.deepEqual(begin.requirements.sources.map(source => source.taskId), [submittedA.id, submittedB.id]);
  assert.deepEqual(begin.requirements.sources.map(source => source.state), ['submitted', 'submitted']);
  assert.deepEqual(begin.requirements.sources.map(source => source.artifact), [producerA.artifact, producerB.artifact]);
  assert.deepEqual(begin.requirements.sources.map(source => source.evidence), [[producerA.evidence], [producerB.evidence]]);
  assert.deepEqual(begin.validationCommands, [AGREED]);
  assert.deepEqual(begin.conflictPaths, [], 'the two producers touch disjoint paths');
  // The derived seed is a NEW snapshot of its own, over the captured original.
  assert.equal(begin.baseSnapshotId, baseSnapshot.id);
  assert.match(begin.derivedSnapshotId, /^[a-f0-9]{64}$/);
  assert.notEqual(begin.derivedSnapshotId, begin.baseSnapshotId);

  // --- validation lane at exact seed revision 0: the composed seed FAILS -----
  const validationTask = await createTask('task-validation', 'validation');
  state.actions.push(seal('seed-seal', 0));
  const validationWorker = await spawn('validation-worker', validationTask.id, 'validation', begin.derivedSnapshotId, `Run ${AGREED} on the derived seed`);
  const validationSession = await stopped(validationWorker.id);
  const seedSeal = toolResult(validationSession, 'seal_submission');
  assert.equal(seedSeal.revision, 0, 'a validation-lane candidate is the unchanged derived seed');
  assert.equal(seedSeal.snapshotId, begin.derivedSnapshotId);
  const seedRun = toolResult(await turn(validationWorker.id, 'seed-run', runCommand()), 'run_command');
  assert.equal(seedRun.outcome, 'failed', 'the clean composed seed really fails the agreed command');
  assert.equal(seedRun.exitCode, 1);
  assert.match(seedRun.output, /12\.5/, 'the merged value is the incompatible one');
  assert.equal(seedRun.import, 'unchanged');

  const seedCandidate = await call('subagent_integration', {
    action: 'candidate', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: begin.revision, requestId: 'candidate-seed',
    artifact: { id: seedSeal.id, version: seedSeal.version, uri: seedSeal.uri }
  });
  assert.equal(seedCandidate.status, 'candidate');
  assert.equal(seedCandidate.candidate.lane, 'validation');
  assert.equal(seedCandidate.candidate.submission.revision, 0);
  assert.equal(seedCandidate.candidate.submission.snapshotId, begin.derivedSnapshotId);

  // A failing runner result is NOT validation evidence and cannot be accepted.
  await assert.rejects(call('subagent_integration', {
    action: 'validate', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: seedCandidate.revision, requestId: 'validate-seed',
    evidence: [{ id: seedRun.id, version: seedRun.version, uri: seedRun.uri }]
  }), error => error.code === 'evidence_invalid');
  const afterRefusal = await call('subagent_integration', { action: 'status', ownerId, teamId: team.id, attemptId: begin.attemptId });
  assert.equal(afterRefusal.status, 'candidate', 'a refused validate records nothing');
  assert.equal(afterRefusal.revision, seedCandidate.revision);
  assert.deepEqual(afterRefusal.validations, []);
  await assert.rejects(call('subagent_integration', {
    action: 'accept', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: afterRefusal.revision, requestId: 'accept-seed'
  }), error => error.code === 'state_invalid');

  // --- integration lane: repair the behavior over the SAME derived seed ------
  const integrationTask = await createTask('task-integration', 'integration');
  state.actions.push({
    type: 'call', id: 'fix', name: 'write_file',
    // Revision 1 of the seed already carries producer B's multiplier.
    input: { path: 'multiply.cjs', expectedHash: hash(MULTIPLY_CHANGED), content: MULTIPLY_FIXED }
  });
  const integrationWorker = await spawn('integration-worker', integrationTask.id, 'integration', begin.derivedSnapshotId, 'Reconcile the two changes');
  const integrationSession = await stopped(integrationWorker.id);
  const fixed = toolResult(integrationSession, 'write_file');
  assert.equal(fixed.revision, 1);
  assert.equal(fixed.path, 'multiply.cjs');
  const fixSeal = toolResult(await turn(integrationWorker.id, 'fix-seal', seal('fix-seal', 1)), 'seal_submission');
  assert.equal(fixSeal.revision, 1, 'the fix is sealed at revision 1 of the same seed');
  assert.equal(fixSeal.snapshotId, begin.derivedSnapshotId);
  const fixRun = toolResult(await turn(integrationWorker.id, 'fix-run', runCommand()), 'run_command');
  assert.equal(fixRun.outcome, 'succeeded', JSON.stringify(fixRun));
  assert.equal(fixRun.exitCode, 0);
  assert.equal(fixRun.import, 'unchanged');
  assert.match(fixRun.output, /combined 10/, 'the repaired behavior satisfies the untouched assertion');
  assert.equal(fixRun.attempt.inputVersion.revision, 1);

  const fixCandidate = await call('subagent_integration', {
    action: 'candidate', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: afterRefusal.revision, requestId: 'candidate-fix',
    artifact: { id: fixSeal.id, version: fixSeal.version, uri: fixSeal.uri }
  });
  assert.equal(fixCandidate.status, 'candidate');
  assert.equal(fixCandidate.candidate.lane, 'integration');
  assert.equal(fixCandidate.candidate.submission.revision, 1);
  // Replacing the candidate discards the earlier (failing) evidence entirely.
  assert.deepEqual(fixCandidate.validations, [], 'prior evidence is stale');
  assert.equal(fixCandidate.acceptance, null);

  const validated = await call('subagent_integration', {
    action: 'validate', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: fixCandidate.revision, requestId: 'validate-fix',
    evidence: [{ id: fixRun.id, version: fixRun.version, uri: fixRun.uri }]
  });
  assert.equal(validated.status, 'validated');
  assert.deepEqual(validated.validations.map(entry => entry.command), [AGREED]);
  assert.deepEqual(validated.validations.map(entry => entry.result.id), [fixRun.id]);
  assert.equal(validated.validations.some(entry => entry.result.id === seedRun.id), false);

  // --- a later behavior-preserving edit makes revision 1 stale ---------------
  // The integration worker appends a comment to the SAME overlay file: the
  // behavior is unchanged, but the artifact is revision 2 now, so the earlier
  // revision-1 result no longer describes the sealed input.
  const noted = toolResult(await turn(integrationWorker.id, 'fix-note', {
    type: 'call', id: 'note', name: 'write_file',
    input: { path: 'multiply.cjs', expectedHash: hash(MULTIPLY_FIXED), content: MULTIPLY_FIXED_NOTE }
  }), 'write_file');
  assert.equal(noted.revision, 2);
  const noteSeal = toolResult(await turn(integrationWorker.id, 'fix-seal-2', seal('fix-seal-2', 2)), 'seal_submission');
  assert.equal(noteSeal.revision, 2, 'revision 2 is sealed on the same derived seed');
  assert.equal(noteSeal.snapshotId, begin.derivedSnapshotId);
  assert.equal(noteSeal.overlayId, fixSeal.overlayId, 'the same overlay, one revision later');
  assert.notEqual(noteSeal.id, fixSeal.id, 'the later seal is a distinct immutable artifact');

  const noteCandidate = await call('subagent_integration', {
    action: 'candidate', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: validated.revision, requestId: 'candidate-fix-2',
    artifact: { id: noteSeal.id, version: noteSeal.version, uri: noteSeal.uri }
  });
  assert.equal(noteCandidate.status, 'candidate');
  assert.equal(noteCandidate.candidate.submission.revision, 2);
  assert.deepEqual(noteCandidate.validations, [], 'the revision-1 verdict is discarded with its candidate');

  // The revision-1 SUCCESS is refused for the revision-2 candidate: it ran
  // against a different sealed revision, so it is no longer this input's proof.
  await assert.rejects(call('subagent_integration', {
    action: 'validate', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: noteCandidate.revision, requestId: 'validate-stale',
    evidence: [{ id: fixRun.id, version: fixRun.version, uri: fixRun.uri }]
  }), error => error.code === 'evidence_invalid');
  // A ref that reuses the exact durable URI but names a different result id is
  // refused before any durable write, and without running another command.
  await assert.rejects(call('subagent_integration', {
    action: 'validate', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: noteCandidate.revision, requestId: 'validate-mismatched-id',
    evidence: [{ id: hash('not-a-runner-result').slice(0, 32), version: fixRun.version, uri: fixRun.uri }]
  }), error => error.code === 'retention_missing');
  const afterStale = await call('subagent_integration', { action: 'status', ownerId, teamId: team.id, attemptId: begin.attemptId });
  assert.equal(afterStale.status, 'candidate', 'neither refusal records a verdict');
  assert.equal(afterStale.revision, noteCandidate.revision);
  assert.deepEqual(afterStale.validations, []);
  assert.equal(state.approvals.length, 4, 'a refused validate never runs a command');

  // Rerunning the same agreed command is the only new proof for revision 2.
  const noteRun = toolResult(await turn(integrationWorker.id, 'fix-run-2', runCommand()), 'run_command');
  assert.equal(noteRun.outcome, 'succeeded', JSON.stringify(noteRun));
  assert.equal(noteRun.exitCode, 0);
  assert.equal(noteRun.import, 'unchanged');
  assert.equal(noteRun.attempt.inputVersion.revision, 2);
  assert.notEqual(noteRun.id, fixRun.id);
  assert.match(noteRun.output, /combined 10/, 'the commented artifact still satisfies the untouched assertion');

  // Retention runs explicitly and WITHOUT result ids after the final passing
  // runner stopped, so the normal released-lease collection really happens
  // before validation: the stopped runs' lease tombstones are dropped, while
  // the exact durable result evidence is untouched and still exists.
  const collected = await call('subagent_resource_collect', { ownerId, teamId: team.id });
  assert.ok(collected.results.leases > 0, `released leases were not collected: ${JSON.stringify(collected)}`);
  assert.deepEqual(collected.results.removed, [], 'collection without result ids removes no runner result');
  // The result's own immutable execution directory names its lease source in
  // the exact canonical `<pool>/slots/<slot>/<leaseId>/source` shape, anchored
  // to the configured pool directory rather than to any lease record, so the
  // earlier stopped lease cannot invalidate this evidence.
  const poolDirectory = path.dirname(path.dirname(path.dirname(path.dirname(noteRun.attempt.executionDirectory))));
  assert.equal(path.basename(poolDirectory), 'pool');
  const sourceParts = path.relative(poolDirectory, noteRun.attempt.executionDirectory).split(path.sep);
  assert.equal(sourceParts.length, 4, `unexpected lease source depth: ${JSON.stringify(sourceParts)}`);
  assert.equal(sourceParts[0], 'slots');
  assert.match(sourceParts[1], /^(?:0|[1-7])$/, 'the slot directory must be a canonical physical slot');
  assert.equal(sourceParts[2], noteRun.attempt.leaseId);
  assert.equal(sourceParts[3], 'source');
  // The exact durable result the validation will name is still on disk after
  // its lease row was collected.
  const runnerRoot = path.dirname(poolDirectory);
  const recordDirectory = path.join(runnerRoot, 'results', 'results');
  const resultFiles = await fs.readdir(recordDirectory).catch(() => []);
  assert.ok(resultFiles.includes(`${noteRun.id}.json`),
    `durable result missing under ${recordDirectory}: ${JSON.stringify(resultFiles)}`);
  const durableResult = JSON.parse(await fs.readFile(
    path.join(recordDirectory, `${noteRun.id}.json`), 'utf8'
  ));
  assert.equal(durableResult.id, noteRun.id);
  assert.equal(durableResult.uri, noteRun.uri);
  assert.equal(durableResult.version, noteRun.version);
  assert.equal(durableResult.attempt.leaseId, noteRun.attempt.leaseId);

  const validatedRev2 = await call('subagent_integration', {
    action: 'validate', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: afterStale.revision, requestId: 'validate-fix-2',
    evidence: [{ id: noteRun.id, version: noteRun.version, uri: noteRun.uri }]
  });
  assert.equal(validatedRev2.status, 'validated');
  assert.deepEqual(validatedRev2.validations.map(entry => entry.result.id), [noteRun.id]);
  assert.equal(validatedRev2.validations.some(entry => entry.result.id === fixRun.id), false, 'the superseded result is never recorded');

  // --- accept is metadata only: the workspace is untouched -------------------
  const accepted = await call('subagent_integration', {
    action: 'accept', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: validatedRev2.revision, requestId: 'accept-fix-2'
  });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.acceptance.resolvedPaths, [], 'a conflict-free attempt resolves no paths');
  assert.equal(accepted.canPublish, true);
  for (const [name, text] of Object.entries(captured)) {
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), text, `acceptance must not write ${name}`);
  }

  // --- apply: the only disk effect, into the temporary fixture root ----------
  const applied = await call('subagent_integration', {
    action: 'apply', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: accepted.revision, requestId: 'apply'
  });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.apply));
  assert.equal(applied.apply.state, 'applied');
  assert.deepEqual(applied.apply.applied, ['add.cjs', 'multiply.cjs']);
  assert.deepEqual(applied.apply.conflicts, []);
  // The successful nonempty apply must have persisted the optional publication
  // journal floor through the live host wiring: an omitted publisher callback
  // would leave this null instead of a positive safe integer.
  assert.ok(Number.isSafeInteger(applied.publicationJournalRevision) && applied.publicationJournalRevision > 0,
    `the apply must persist a positive journal revision: ${JSON.stringify(applied.publicationJournalRevision)}`);
  assert.equal(await fs.readFile(path.join(root, 'add.cjs'), 'utf8'), ADD_CHANGED);
  assert.equal(await fs.readFile(path.join(root, 'multiply.cjs'), 'utf8'), MULTIPLY_FIXED_NOTE);
  // The agreed verification script and its assertion are byte-identical: the
  // oracle was never renegotiated, only the incompatible behavior was repaired.
  assert.equal(await fs.readFile(path.join(root, 'verify.cjs'), 'utf8'), VERIFY_BASE);
  const disk = await execute(process.execPath, ['verify.cjs'], { cwd: root, windowsHide: true });
  assert.match(disk.stdout, /combined 10/, 'the REAL agreed command passes on the published root');

  // An exact apply replay proves each file and repeats no effect, so a later
  // user edit of an already applied path survives.
  await fs.writeFile(path.join(root, 'add.cjs'), USER_EDIT);
  const replay = await call('subagent_integration', {
    action: 'apply', ownerId, teamId: team.id, attemptId: begin.attemptId,
    expectedRevision: accepted.revision, requestId: 'apply'
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 'applied');
  assert.deepEqual(replay.apply.applied, applied.apply.applied);
  assert.equal(await fs.readFile(path.join(root, 'add.cjs'), 'utf8'), USER_EDIT, 'an applied path is never rewritten');

  // Nothing else on the board moved, and every command was approved only inside
  // this fixture by the real approval surface.
  assert.equal((await call('subagent_task_get', { ownerId, id: unrelated.id })).state, 'ready');
  for (const taskId of [taskA.id, taskB.id]) {
    assert.equal((await call('subagent_task_get', { ownerId, id: taskId })).state, 'submitted', 'integration never rewrites the board');
  }
  assert.equal(state.approvals.length, 5, 'two producer runs, the seed run, the revision-1 run and the revision-2 rerun');
  assert.deepEqual(state.approvals.map(entry => entry.command), [AGREED, AGREED, AGREED, AGREED, AGREED]);
  assert.deepEqual(state.approvals.filter(entry => !entry.allowed), []);
});

// ---------------------------------------------------------------------------
// Real broker regression for the reviewed downstream round-trip failure.
//
// A is produced on an ordinary capture and settled only by the board's own
// separate validating -> accepted decisions. B declares a real artifact
// dependency on A and is bound to the derived A seed of a consumer begin (a
// private dependency seed selecting only A with its exact evidence), so B sees
// A's exact bytes and adds its own disjoint, compatible edit.
//
// B is then submitted and ONE publishing integration selects only B. B's
// immediate base is the derived A seed, so A is already incorporated: the
// attempt must compose the whole A+B result, validate it with a normal
// validation-lane worker, accept it, and apply BOTH producers' bytes against
// the original captured baseline while that live workspace stays untouched.
test('a downstream consumer artifact round-trips its accepted producer onto the captured baseline', { timeout: TEST_TIMEOUT }, async t => {
  const captured = { 'add.cjs': ADD_BASE, 'multiply.cjs': MULTIPLY_BASE, 'verify.cjs': DOWNSTREAM_VERIFY };
  const fixture = await startFlow(t, captured);
  const { root, state, call } = fixture;

  const team = await call('subagent_team_create', { ownerId, requestId: 'downstream-team', name: 'Downstream flow', description: '' });
  const baseSnapshot = await call('subagent_snapshot_create', { ownerId, teamId: team.id, requestId: 'downstream-base' });
  assert.match(baseSnapshot.id, /^[a-f0-9]{64}$/);
  const { stopped, toolResult, turn, runCommand, seal, spawn, submit, produce } = flowActions(fixture, team.id);

  const taskA = await call('subagent_task_create', {
    ownerId, requestId: 'downstream-task-add', teamId: team.id, title: 'add',
    description: 'Accept the ordinary capture', acceptanceCriteria: [`${AGREED} passes on the integrated result`]
  });
  // B's dependency on A is a real artifact edge on the board.
  const taskB = await call('subagent_task_create', {
    ownerId, requestId: 'downstream-task-multiply', teamId: team.id, title: 'multiply',
    description: 'Consume the accepted add artifact', acceptanceCriteria: [`${AGREED} passes on the integrated result`],
    dependencies: [{ taskId: taskA.id, kind: 'artifact' }]
  });
  assert.deepEqual(taskB.dependencies, [{ taskId: taskA.id, kind: 'artifact' }]);
  assert.equal(taskB.state, 'ready');

  // --- A: ordinary capture, private edit and the exact passing proof ---------
  const producerA = await produce('downstream-add', taskA.id, 'add.cjs', ADD_CHANGED, baseSnapshot.id);
  const submittedA = await submit(taskA.id, producerA.artifact, 'downstream-add');

  // A is settled by the board's OWN separate decisions, never by the ledger.
  const validatingA = await call('subagent_task_update', {
    ownerId, requestId: 'downstream-add-validating', taskId: taskA.id,
    expectedRevision: submittedA.revision, state: 'validating'
  });
  assert.equal(validatingA.state, 'validating');
  const verdictA = await call('subagent_task_update', {
    ownerId, requestId: 'downstream-add-verdict', taskId: taskA.id,
    expectedRevision: validatingA.revision, state: 'validating',
    validations: [{
      artifactId: producerA.artifact.id, candidateVersion: producerA.artifact.version,
      outcome: 'passed', resultRef: producerA.evidence, at: new Date().toISOString()
    }]
  });
  assert.equal(verdictA.state, 'validating');
  const acceptedA = await call('subagent_task_update', {
    ownerId, requestId: 'downstream-add-accept', taskId: taskA.id,
    expectedRevision: verdictA.revision, state: 'accepted'
  });
  assert.equal(acceptedA.state, 'accepted');
  assert.deepEqual(acceptedA.candidates, [producerA.artifact]);

  // --- consumer seed: ONLY A, with its exact artifact and evidence -----------
  const currentB = await call('subagent_task_get', { ownerId, id: taskB.id });
  const seed = await call('subagent_integration', {
    action: 'begin', ownerId, teamId: team.id, requestId: 'downstream-seed',
    sources: [{ taskId: taskA.id, taskRevision: acceptedA.revision, artifact: producerA.artifact, evidence: [producerA.evidence] }],
    consumer: { taskId: currentB.id, taskRevision: currentB.revision }
  });
  assert.equal(seed.status, 'ready', JSON.stringify(seed.failure));
  // A consumer begin is a private dependency seed: never validated or applied.
  assert.equal(seed.dependencyOnly, true);
  assert.equal(seed.seedOnly, true);
  assert.equal(seed.canPublish, false);
  assert.deepEqual(seed.requirements.sources.map(source => source.taskId), [taskA.id]);
  assert.deepEqual(seed.requirements.sources.map(source => source.state), ['accepted']);
  assert.deepEqual(seed.requirements.sources.map(source => source.evidence), [[producerA.evidence]]);
  assert.deepEqual(seed.dependencies, [{ taskId: taskA.id, kind: 'artifact' }]);
  assert.equal(seed.baseSnapshotId, baseSnapshot.id);
  assert.match(seed.derivedSnapshotId, /^[a-f0-9]{64}$/);
  assert.notEqual(seed.derivedSnapshotId, baseSnapshot.id, 'the A seed is a new snapshot of the capture');

  // --- B is bound to the derived A seed in the governed work lane ------------
  state.actions.push({ type: 'call', id: 'read-add', name: 'read_file', input: { path: 'add.cjs' } });
  const workerB = await spawn('downstream-multiply', taskB.id, 'work', seed.derivedSnapshotId, 'Change multiply.cjs behind the accepted add');
  const firstLook = await stopped(workerB.id);
  const seen = toolResult(firstLook, 'read_file');
  // B really sees A's exact accepted bytes, not the captured add base.
  assert.equal(seen.path, 'add.cjs');
  assert.equal(seen.hash, hash(ADD_CHANGED));
  assert.equal(seen.content, ADD_CHANGED);
  assert.equal(seen.revision, 0);

  // B's own edit is disjoint: the expected hash proves multiply.cjs was still
  // the captured base, so A and B never touched the same path.
  const edited = toolResult(await turn(workerB.id, 'downstream-b-edit', {
    type: 'call', id: 'edit', name: 'write_file',
    input: { path: 'multiply.cjs', expectedHash: hash(MULTIPLY_BASE), content: MULTIPLY_CONSUMER }
  }), 'write_file');
  assert.equal(edited.path, 'multiply.cjs');
  assert.equal(edited.revision, 1);

  const sealB = toolResult(await turn(workerB.id, 'downstream-b-seal', seal('downstream-b-seal', 1)), 'seal_submission');
  assert.equal(sealB.revision, 1);
  // The artifact is sealed over A's derived seed, so its immediate base is A.
  assert.equal(sealB.snapshotId, seed.derivedSnapshotId);
  assert.notEqual(sealB.id, producerA.artifact.id);

  const runB = toolResult(await turn(workerB.id, 'downstream-b-run', runCommand()), 'run_command');
  // B's own exact successful runner evidence, on its own sealed revision.
  assert.equal(runB.outcome, 'succeeded', JSON.stringify(runB));
  assert.equal(runB.exitCode, 0);
  assert.equal(runB.import, 'unchanged');
  assert.equal(runB.attempt.inputVersion.revision, 1);
  assert.equal(runB.attempt.inputVersion.snapshotId, seed.derivedSnapshotId);
  assert.match(runB.output, /combined 10/);

  const artifactB = { id: sealB.id, version: sealB.version, uri: sealB.uri };
  const evidenceB = { id: runB.id, version: runB.version, uri: runB.uri };
  const submittedB = await submit(taskB.id, artifactB, 'downstream-multiply');

  // Nothing reaches the live workspace yet: A is board-accepted only and B is a
  // private consumer of A's seed.
  for (const [name, text] of Object.entries(captured)) {
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), text, `the live workspace must still hold the captured ${name}`);
  }

  // --- publishing integration: ONLY B, whose immediate base is A's seed ------
  const publishing = await call('subagent_integration', {
    action: 'begin', ownerId, teamId: team.id, requestId: 'downstream-publish',
    sources: [{ taskId: taskB.id, taskRevision: submittedB.revision, artifact: artifactB, evidence: [evidenceB] }],
    validationCommands: [AGREED]
  });
  assert.equal(publishing.status, 'ready', JSON.stringify(publishing.failure));
  assert.equal(publishing.seedOnly, false);
  assert.equal(publishing.revision, 1);
  assert.deepEqual(publishing.requirements.sources.map(source => source.taskId), [taskB.id], 'only B is selected');
  // A stays a recorded artifact dependency of B without being selected again:
  // its bytes are already incorporated by B's immediate base.
  assert.ok(publishing.dependencies.some(dependency => dependency.taskId === taskA.id && dependency.kind === 'artifact'),
    `A must stay a recorded artifact dependency: ${JSON.stringify(publishing.dependencies)}`);
  assert.equal(publishing.baseSnapshotId, seed.derivedSnapshotId, "B's immediate base is the derived A seed");
  assert.notEqual(publishing.baseSnapshotId, baseSnapshot.id);
  assert.match(publishing.derivedSnapshotId, /^[a-f0-9]{64}$/);
  assert.notEqual(publishing.derivedSnapshotId, seed.derivedSnapshotId);
  assert.notEqual(publishing.derivedSnapshotId, baseSnapshot.id);
  assert.deepEqual(publishing.conflictPaths, [], 'the two disjoint artifacts do not conflict');

  // --- normal validation lane over the composed seed -------------------------
  const validationTask = await call('subagent_task_create', {
    ownerId, requestId: 'downstream-task-validation', teamId: team.id, title: 'validation',
    description: 'Run the agreed command on the composed seed', acceptanceCriteria: [`${AGREED} passes`]
  });
  state.actions.push(seal('downstream-seed-seal', 0));
  const validationWorker = await spawn('downstream-validation', validationTask.id, 'validation', publishing.derivedSnapshotId, `Run ${AGREED} on the composed seed`);
  const validationSession = await stopped(validationWorker.id);
  const composedSeal = toolResult(validationSession, 'seal_submission');
  assert.equal(composedSeal.revision, 0, 'a validation-lane candidate is the unchanged composed seed');
  assert.equal(composedSeal.snapshotId, publishing.derivedSnapshotId);
  const composedRun = toolResult(await turn(validationWorker.id, 'downstream-seed-run', runCommand()), 'run_command');
  assert.equal(composedRun.outcome, 'succeeded', JSON.stringify(composedRun));
  assert.equal(composedRun.exitCode, 0);
  assert.equal(composedRun.import, 'unchanged');
  // Only A's composed bytes reach 10; the captured add base would report 8.
  assert.match(composedRun.output, /combined 10/);

  const candidate = await call('subagent_integration', {
    action: 'candidate', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: publishing.revision, requestId: 'downstream-candidate',
    artifact: { id: composedSeal.id, version: composedSeal.version, uri: composedSeal.uri }
  });
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.candidate.lane, 'validation');
  assert.equal(candidate.candidate.submission.revision, 0);
  assert.equal(candidate.candidate.submission.snapshotId, publishing.derivedSnapshotId);

  const validated = await call('subagent_integration', {
    action: 'validate', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: candidate.revision, requestId: 'downstream-validate',
    evidence: [{ id: composedRun.id, version: composedRun.version, uri: composedRun.uri }]
  });
  assert.equal(validated.status, 'validated');
  assert.deepEqual(validated.validations.map(entry => entry.command), [AGREED]);
  assert.deepEqual(validated.validations.map(entry => entry.result.id), [composedRun.id]);

  const accepted = await call('subagent_integration', {
    action: 'accept', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: validated.revision, requestId: 'downstream-accept'
  });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.acceptance.resolvedPaths, []);
  assert.equal(accepted.canPublish, true);

  // Accept is metadata only: the live baseline is still exactly the capture.
  for (const [name, text] of Object.entries(captured)) {
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), text, `acceptance must not write ${name}`);
  }

  // --- apply: the whole A+B result, against the captured baseline ------------
  const applied = await call('subagent_integration', {
    action: 'apply', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: accepted.revision, requestId: 'downstream-apply'
  });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.apply));
  assert.equal(applied.apply.state, 'applied');
  assert.deepEqual(applied.apply.applied, ['add.cjs', 'multiply.cjs']);
  assert.deepEqual(applied.apply.conflicts, []);
  // A's bytes are applied even though A was never selected in this attempt.
  assert.equal(await fs.readFile(path.join(root, 'add.cjs'), 'utf8'), ADD_CHANGED);
  assert.equal(await fs.readFile(path.join(root, 'multiply.cjs'), 'utf8'), MULTIPLY_CONSUMER);
  assert.equal(await fs.readFile(path.join(root, 'verify.cjs'), 'utf8'), DOWNSTREAM_VERIFY);
  const disk = await execute(process.execPath, ['verify.cjs'], { cwd: root, windowsHide: true });
  assert.match(disk.stdout, /combined 10/, 'the REAL agreed command passes on the published root');

  // Integration never rewrites the board: A stays accepted, B stays submitted.
  assert.equal((await call('subagent_task_get', { ownerId, id: taskA.id })).state, 'accepted');
  assert.equal((await call('subagent_task_get', { ownerId, id: taskB.id })).state, 'submitted');
  // A's producer run, B's consumer run and the composed-seed validation only.
  assert.deepEqual(state.approvals.map(entry => entry.command), [AGREED, AGREED, AGREED]);
  assert.deepEqual(state.approvals.filter(entry => !entry.allowed), []);
});

// ---------------------------------------------------------------------------
// Real broker regression for the two downstream conflict findings.
//
// Two producers edit the SAME captured file (add.cjs) differently and each one
// passes the agreed command alone. Integrating both therefore produces a REAL
// merge conflict, and that conflicted seed is not ordinary work: a work-lane
// startup cannot bind it, and nothing may compose over it except its own
// accepted integration-lane resolution seal. The resolution is then settled in
// TWO separate durable places - the ledger accepts it with the exact conflict
// paths, and the resolver's own board task is accepted separately with its own
// runner evidence - and only then does a downstream consumer, whose only board
// edge is the ORIGINAL artifact edge to the producer, compose the resolved seal
// alone and see the resolved bytes.
// ---------------------------------------------------------------------------
const CONFLICT_ADD_BASE = 'module.exports = value => value + 1;\n';
const CONFLICT_ADD_A = 'module.exports = value => value + 2;\n';
const CONFLICT_ADD_B = 'module.exports = value => value * 3;\n';
const CONFLICT_ADD_RESOLVED = 'module.exports = value => value + 5;\n';
const conflictVerify = () => [
  "const add = require('./add.cjs');",
  'const result = add(3);',
  'if (!(result >= 4 && result <= 9)) {',
  "  process.stdout.write('result ' + result + ' is outside the agreed range\\n');",
  '  process.exit(1);',
  '}',
  "process.stdout.write('result ' + result);",
  ''
].join('\n');

test('a conflicted seed is consumed only by its exact accepted resolution seal', { timeout: TEST_TIMEOUT }, async t => {
  const captured = { 'add.cjs': CONFLICT_ADD_BASE, 'verify.cjs': conflictVerify() };
  const fixture = await startFlow(t, captured);
  const { root, state, call } = fixture;

  const team = await call('subagent_team_create', { ownerId, requestId: 'r5-team', name: 'Conflict flow', description: '' });
  const actions = flowActions(fixture, team.id);
  const baseSnapshot = await call('subagent_snapshot_create', { ownerId, teamId: team.id, requestId: 'r5-base' });
  assert.match(baseSnapshot.id, /^[a-f0-9]{64}$/);
  const createTask = (requestId, title, dependencies = []) => call('subagent_task_create', {
    ownerId, requestId, teamId: team.id, title, description: `Task ${title}`,
    acceptanceCriteria: [`${AGREED} passes on the integrated result`], dependencies
  });
  const taskA = await createTask('r5-task-add', 'add');
  const taskB = await createTask('r5-task-multiply', 'multiply');

  // --- two producers, each individually green on the SAME captured file -----
  const producerA = await actions.produce('r5-produce-add', taskA.id, 'add.cjs', CONFLICT_ADD_A, baseSnapshot.id);
  const submittedA = await actions.submit(taskA.id, producerA.artifact, 'r5-add');
  // A is settled by the board's OWN separate decisions (the consumer edge below
  // depends on it), never by the ledger.
  const validatingA = await call('subagent_task_update', {
    ownerId, requestId: 'r5-add-validating', taskId: taskA.id,
    expectedRevision: submittedA.revision, state: 'validating'
  });
  const verdictA = await call('subagent_task_update', {
    ownerId, requestId: 'r5-add-verdict', taskId: taskA.id,
    expectedRevision: validatingA.revision, state: 'validating',
    validations: [{
      artifactId: producerA.artifact.id, candidateVersion: producerA.artifact.version,
      outcome: 'passed', resultRef: producerA.evidence, at: new Date().toISOString()
    }]
  });
  const acceptedA = await call('subagent_task_update', {
    ownerId, requestId: 'r5-add-accept', taskId: taskA.id,
    expectedRevision: verdictA.revision, state: 'accepted'
  });
  assert.equal(acceptedA.state, 'accepted');
  const producerB = await actions.produce('r5-produce-multiply', taskB.id, 'add.cjs', CONFLICT_ADD_B, baseSnapshot.id);
  const submittedB = await actions.submit(taskB.id, producerB.artifact, 'r5-multiply');

  // --- begin: a REAL conflict on the one path both producers rewrote --------
  const conflicted = await call('subagent_integration', {
    action: 'begin', ownerId, teamId: team.id, requestId: 'r5-conflicted',
    sources: [
      { taskId: taskA.id, taskRevision: acceptedA.revision, artifact: producerA.artifact, evidence: [producerA.evidence] },
      { taskId: taskB.id, taskRevision: submittedB.revision, artifact: producerB.artifact, evidence: [producerB.evidence] }
    ],
    validationCommands: [AGREED]
  });
  assert.equal(conflicted.status, 'ready', JSON.stringify(conflicted.failure));
  assert.deepEqual(conflicted.conflictPaths, ['add.cjs'], JSON.stringify(conflicted.conflicts));
  assert.equal(conflicted.baseSnapshotId, baseSnapshot.id);
  const conflictedSeed = conflicted.derivedSnapshotId;
  assert.match(conflictedSeed, /^[a-f0-9]{64}$/);
  assert.notEqual(conflictedSeed, baseSnapshot.id);

  // --- a WORK-lane startup may not bind the conflicted seed ----------------
  // The refusal happens in the narrow startup preflight, BEFORE the worker is
  // created and BEFORE the ready task is assigned, so nothing is stranded.
  const spare = await createTask('r5-task-spare', 'spare');
  const beforeRefusal = await call('subagent_task_get', { ownerId, id: spare.id });
  assert.equal(beforeRefusal.state, 'ready');
  const currentTeam = await call('subagent_team_get', { ownerId, id: team.id });
  await assert.rejects(call('subagent_isolated_spawn', {
    ownerId, requestId: 'r5-work-lane-conflict', task: 'Edit the conflicted seed', model: model.id,
    permission: 'workspace-write',
    setup: {
      teamId: team.id, taskId: spare.id, snapshotId: conflictedSeed,
      teamRevision: currentTeam.revision, taskRevision: beforeRefusal.revision, lane: 'work'
    }
  }), error => error.code === 'isolation_conflict');
  const afterRefusal = await call('subagent_task_get', { ownerId, id: spare.id });
  assert.equal(afterRefusal.state, 'ready', 'the refused startup leaves the ready task ready');
  assert.equal(afterRefusal.revision, beforeRefusal.revision, 'and never bumps its assignment revision');
  assert.ok(!afterRefusal.assigneeWorkerId, 'no worker was assigned');

  // The refusal spent NO durable pre-creation intent. The defect left a kept
  // pending-startups record without any deadline behind, which held every
  // metadata maintenance of this owner closed as worker_busy; nothing of the
  // kind may remain now.
  const local = fixture.broker.local.get(root);
  const intentsFile = path.join(local.store.directory, 'pending-startups.json');
  const intents = await fs.readFile(intentsFile, 'utf8').then(text => JSON.parse(text).requests, error => {
    if (error.code === 'ENOENT') { return []; }
    throw error;
  });
  assert.deepEqual(intents.filter(entry => entry.requestId === 'r5-work-lane-conflict'), [], 'the refused startup wrote no pending intent');
  assert.equal(local.store.hasPendingStartup(ownerId), false, 'no pending startup record holds this owner');
  // Metadata maintenance for this owner/team is reachable immediately: the
  // explicit collection re-runs the same quiescence fence a stranded intent used
  // to fail, and it changes no request epoch, so the fixture requests below keep
  // their exact identities.
  const collected = await call('subagent_resource_collect', { ownerId, teamId: team.id });
  assert.deepEqual(collected.results.removed, [], 'nothing is collected while the producer results stay referenced');
  assert.equal(collected.tombstones, 0);
  // A FRESH refusal never accepted that identity, so it writes neither a pending
  // row nor a retirement id; only an earlier accepted record is tombstoned.
  const { digest } = require(path.join(build, 'storage'));
  const refusedIdentity = digest([digest([ownerId, 'r5-work-lane-conflict']), root]).slice(0, 32);
  assert.equal(await fs.lstat(path.join(local.store.directory, 'retired-workers', `${refusedIdentity}.json`)).then(() => true, () => false), false,
    'the fresh refusal writes no retirement id');

  // --- the governed integration-lane resolution ----------------------------
  const resolverTask = await createTask('r5-task-resolve', 'resolve');
  state.actions.push({
    type: 'call', id: 'resolve', name: 'write_file',
    input: { path: 'add.cjs', expectedHash: hash(CONFLICT_ADD_BASE), content: CONFLICT_ADD_RESOLVED }
  });
  const resolverWorker = await actions.spawn('r5-resolver', resolverTask.id, 'integration', conflictedSeed, 'Resolve the conflicting add.cjs');
  const resolverSession = await actions.stopped(resolverWorker.id);
  const resolvedEdit = actions.toolResult(resolverSession, 'write_file');
  assert.equal(resolvedEdit.revision, 1, 'the resolution is an EDIT of the conflicted seed');
  const resolutionSeal = actions.toolResult(await actions.turn(resolverWorker.id, 'r5-resolve-seal', actions.seal('r5-resolve-seal', 1)), 'seal_submission');
  assert.equal(resolutionSeal.revision, 1);
  assert.equal(resolutionSeal.snapshotId, conflictedSeed);
  const resolutionRun = actions.toolResult(await actions.turn(resolverWorker.id, 'r5-resolve-run', actions.runCommand()), 'run_command');
  assert.equal(resolutionRun.outcome, 'succeeded', JSON.stringify(resolutionRun));
  assert.equal(resolutionRun.exitCode, 0);
  assert.equal(resolutionRun.import, 'unchanged');
  assert.match(resolutionRun.output, /result 8/, 'the resolved bytes satisfy the untouched assertion');
  const resolution = { id: resolutionSeal.id, version: resolutionSeal.version, uri: resolutionSeal.uri };
  const resolutionEvidence = { id: resolutionRun.id, version: resolutionRun.version, uri: resolutionRun.uri };

  const controls = { ownerId, teamId: team.id, attemptId: conflicted.attemptId };
  const proposed = await call('subagent_integration', {
    ...controls, action: 'candidate', expectedRevision: conflicted.revision,
    requestId: 'r5-candidate', artifact: resolution
  });
  assert.equal(proposed.candidate.lane, 'integration');
  assert.equal(proposed.candidate.submission.revision, 1);
  const validated = await call('subagent_integration', {
    ...controls, action: 'validate', expectedRevision: proposed.revision,
    requestId: 'r5-validate', evidence: [resolutionEvidence]
  });
  assert.equal(validated.status, 'validated');

  // The resolver's OWN board task carries the exact resolution artifact.
  const submittedResolver = await actions.submit(resolverTask.id, resolution, 'r5-resolve');
  assert.deepEqual(submittedResolver.candidates, [resolution]);

  // --- a seal that is not yet ACCEPTED cannot consume the conflicted seed ---
  // No board edge is omitted here at all: the refusal is the provenance proof,
  // never a downstream dependency heuristic.
  await assert.rejects(call('subagent_integration', {
    action: 'begin', ownerId, teamId: team.id, requestId: 'r5-unaccepted-seal',
    sources: [{ taskId: resolverTask.id, taskRevision: submittedResolver.revision, artifact: resolution, evidence: [resolutionEvidence] }],
    validationCommands: [AGREED]
  }), error => error.code === 'ancestry_unresolved');

  // --- accept the resolution with the EXACT conflict path, then the task ----
  const accepted = await call('subagent_integration', {
    ...controls, action: 'accept', expectedRevision: validated.revision,
    requestId: 'r5-accept', resolvedPaths: ['add.cjs']
  });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.acceptance.resolvedPaths, ['add.cjs']);
  const validatingResolver = await call('subagent_task_update', {
    ownerId, requestId: 'r5-resolve-validating', taskId: resolverTask.id,
    expectedRevision: submittedResolver.revision, state: 'validating'
  });
  const verdictResolver = await call('subagent_task_update', {
    ownerId, requestId: 'r5-resolve-verdict', taskId: resolverTask.id,
    expectedRevision: validatingResolver.revision, state: 'validating',
    validations: [{
      artifactId: resolution.id, candidateVersion: resolution.version,
      outcome: 'passed', resultRef: resolutionEvidence, at: new Date().toISOString()
    }]
  });
  const acceptedResolver = await call('subagent_task_update', {
    ownerId, requestId: 'r5-resolve-accept', taskId: resolverTask.id,
    expectedRevision: verdictResolver.revision, state: 'accepted'
  });
  assert.equal(acceptedResolver.state, 'accepted');

  // --- the downstream consumer keeps ONLY its original artifact edge --------
  const consumerTask = await createTask('r5-task-consumer', 'consumer', [{ taskId: taskA.id, kind: 'artifact' }]);
  assert.deepEqual(consumerTask.dependencies, [{ taskId: taskA.id, kind: 'artifact' }]);
  assert.equal(consumerTask.state, 'ready');
  const seed = await call('subagent_integration', {
    action: 'begin', ownerId, teamId: team.id, requestId: 'r5-consumer-seed',
    sources: [{
      taskId: resolverTask.id, taskRevision: acceptedResolver.revision,
      artifact: resolution, evidence: [resolutionEvidence]
    }],
    consumer: { taskId: consumerTask.id, taskRevision: consumerTask.revision }
  });
  assert.equal(seed.status, 'ready', JSON.stringify(seed.failure));
  assert.equal(seed.seedOnly, true);
  assert.equal(seed.sourceSnapshotId, conflictedSeed, 'the resolved seal is consumed over the conflicted seed');
  assert.equal(seed.baseSnapshotId, conflictedSeed);
  assert.deepEqual(seed.conflictPaths, [], 'the resolved composition has no conflict left');
  // The omitted edge is the ORIGINAL producer dependency, and the witness records
  // the exact resolution artifact that carried it onto the new base.
  assert.equal(seed.inherited.length, 1);
  assert.equal(seed.inherited[0].taskId, taskA.id);
  assert.equal(seed.inherited[0].attemptId, conflicted.attemptId);
  assert.equal(seed.inherited[0].snapshotId, conflictedSeed);
  assert.deepEqual(seed.inherited[0].artifact, producerA.artifact);
  assert.deepEqual(seed.inherited[0].resolution, resolution);

  // --- a plain work-lane consumer sees the RESOLVED bytes -------------------
  state.actions.push({ type: 'call', id: 'read', name: 'read_file', input: { path: 'add.cjs' } });
  const consumerWorker = await actions.spawn('r5-consumer-worker', consumerTask.id, 'work', seed.derivedSnapshotId, 'Inspect the resolved add.cjs');
  const consumerSession = await actions.stopped(consumerWorker.id);
  const seen = actions.toolResult(consumerSession, 'read_file');
  assert.equal(seen.path, 'add.cjs');
  assert.equal(seen.content, CONFLICT_ADD_RESOLVED, 'the consumer sees the resolved bytes, not the base and not one producer side');
  assert.equal(seen.hash, hash(CONFLICT_ADD_RESOLVED));
  assert.equal(seen.revision, 0, 'the new derived seed is the consumer revision 0');

  // Nothing was published: the live workspace still holds exactly the capture.
  for (const [name, text] of Object.entries(captured)) {
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), text, `nothing may write ${name}`);
  }
  // Integration never rewrites the board.
  assert.equal((await call('subagent_task_get', { ownerId, id: taskA.id })).state, 'accepted');
  assert.equal((await call('subagent_task_get', { ownerId, id: taskB.id })).state, 'submitted');
  assert.equal((await call('subagent_task_get', { ownerId, id: resolverTask.id })).state, 'accepted');
  assert.equal((await call('subagent_task_get', { ownerId, id: consumerTask.id })).state, 'ready');
  // Two producer runs and the resolver run, every one approved inside the fixture.
  assert.deepEqual(state.approvals.map(entry => entry.command), [AGREED, AGREED, AGREED]);
  assert.deepEqual(state.approvals.filter(entry => !entry.allowed), []);
});
