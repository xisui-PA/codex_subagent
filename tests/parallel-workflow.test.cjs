// Deterministic regression for ONE complete parallel governed workflow.
//
// Real WorkerBroker, real task board, real private views, real resource
// governor and the real physical runner. Only the model is scripted: the
// in-memory provider returns the tool call registered for the exact tag the
// coordinator sent as the turn message, so concurrent turns never race for a
// shared queue and no inference, network or live checkout is involved. The tag
// is resolved as the newest user message made purely of text whose trimmed text
// is EXACTLY a tag this fixture registered, so the engine's own peer-mailbox
// delivery block (appended after the turn input) and tool results are never
// mistaken for a scripted turn.
//
// The scenario is one coherent flow (no duplicated fixture code):
//   1. TWO governed producers - A (add) and P (multiply) - are created, bound
//      and started through subagent_isolated_spawn on ONE shared base snapshot,
//      each with its own task, so each is bound before its first provider/tool
//      call (asserted from its first catalog and its revision-0 read);
//   2. the peers agree their seam over the durable mailbox
//      (interface_proposal -> interface_response), and only then does the
//      coordinator record the agreed interface as explicit agreedContracts refs;
//   3. BOTH producers make private edits, seal, and each one's bytes stay
//      invisible to the peer and to the live workspace;
//   4. each producer's sealed revision is proved by its own real, narrow,
//      passing physical-runner command (never a manufactured result);
//   5. the board accepts each producer by its own exact verdict for the exact
//      artifact version;
//   6. the artifact-dependent consumer B is started DIRECTLY on the exact
//      composed consumer derivedSnapshotId through isolated_spawn (no legacy
//      bootstrap, no rebinding of an already bound worker);
//   7. one bounded runner pool (capacity 1) queues the second command, never
//      exceeds capacity, and records exact input/after version evidence, while
//      stale evidence for an earlier revision is refused;
//   8. one publishing integration composes the selected B output over A+P,
//      runs the combined candidate for real, then explicitly
//      candidate/validate/accept/apply;
//   9. an unrelated intervening user edit is preserved, a later user edit of an
//      applied path survives an exact apply replay, a cancelled command is never
//      replayed across a reload, and a legacy standalone worker keeps its exact
//      legacy catalog.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const build = path.resolve(__dirname, '..', process.env.PARALLEL_TEST_BUILD?.trim()
  || process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { WorkerBroker, unpack } = require(path.join(build, 'runtime'));
const { defaults } = require(path.join(build, 'engine'));
const { resourceDefaults } = require(path.join(build, 'resource-governor'));
// Fail loudly on a stale compile instead of silently skipping the flow.
try {
  const { integrationActionSchema } = require(path.join(build, 'integration-attempts'));
  if (typeof integrationActionSchema?.parse !== 'function') {
    throw new Error('integration schema is missing from this build');
  }
} catch (error) {
  throw new Error(`stale build at ${build}; recompile it (PARALLEL_TEST_BUILD=<dir>): ${error instanceof Error ? error.message : String(error)}`);
}

const execute = promisify(execFile);
const model = { id: 'test/parallel-workflow', name: 'Fixture', vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 };
const ownerId = 'parallel-owner';
const TEST_TIMEOUT = 300_000;
const AGREED = 'node verify.cjs';
const CHECK_ADD = 'node check-add.cjs';
const CHECK_MULTIPLY = 'node check-multiply.cjs';
const SLOW = 'node slow.cjs';

// Each producer changes exactly one module. The narrow checks pass ONLY on that
// producer's own revision, and the agreed oracle passes ONLY on the fully
// composed state, so no single producer can satisfy it by itself.
const ADD_BASE = 'module.exports = value => value + 1;\n';
const ADD_CHANGED = 'module.exports = value => value + 2;\n';
const MULTIPLY_BASE = 'module.exports = value => value * 2;\n';
const MULTIPLY_CHANGED = 'module.exports = value => value * 3;\n';
// Created by the consumer at its own revision 1: the oracle really observes it.
const RELEASE = 'module.exports = { version: 1 };\n';
const NOTES_BASE = 'notes: nothing yet\n';
const NOTES_USER = 'notes: edited by the user while both workers were running\n';
const ADD_USER = 'module.exports = value => value + 7;\n';
const CHECK_ADD_SCRIPT = [
  "const add = require('./add.cjs');",
  'const value = add(3);',
  'if (value !== 5) {',
  "  process.stdout.write('add(3) is ' + value);",
  '  process.exit(1);',
  '}',
  "process.stdout.write('add(3)=5');",
  ''
].join('\n');
const CHECK_MULTIPLY_SCRIPT = [
  "const multiply = require('./multiply.cjs');",
  'const value = multiply(4);',
  'if (value !== 12) {',
  "  process.stdout.write('multiply(4) is ' + value);",
  '  process.exit(1);',
  '}',
  "process.stdout.write('multiply(4)=12');",
  ''
].join('\n');
const VERIFY = [
  "const add = require('./add.cjs');",
  "const multiply = require('./multiply.cjs');",
  "const release = require('./release.cjs');",
  'const combined = multiply(add(3));',
  'if (combined !== 15 || release.version !== 1) {',
  "  process.stdout.write('combined ' + combined + ' release ' + release.version);",
  '  process.exit(1);',
  '}',
  "process.stdout.write('combined ' + combined);",
  ''
].join('\n');
// Deterministic replacement for a fixed end-of-command delay: the script
// announces its OWN physical start by writing a marker into its materialized
// copy, then WAITS for a gate file that the fixture drops into that same copy
// only after it has OBSERVED the pool state it wants, consumes and deletes that
// gate, and only then exits. The hold is therefore released by an observed
// event, never by a timer race, and the gate is gone before the import, so the
// only imported change is still the marker (revision 1 -> 2). The wait is
// bounded, so a never-released gate fails the command instead of hanging it.
const SLOW_GATE = '.runner-gate';
const SLOW_WAIT_MS = 60_000;
const SLOW_SCRIPT = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('slow.txt', 'started');",
  `const deadline = Date.now() + ${SLOW_WAIT_MS};`,
  `while (!fs.existsSync('${SLOW_GATE}') && Date.now() < deadline) {`,
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
  '}',
  `if (!fs.existsSync('${SLOW_GATE}')) {`,
  "  process.stdout.write('gate-timeout');",
  '  process.exit(1);',
  '}',
  `fs.unlinkSync('${SLOW_GATE}');`,
  "process.stdout.write('slow-done');",
  ''
].join('\n');
const INTERFACE = { id: 'interface.add-multiply', version: 1, uri: 'urn:codex-interface:add-multiply:1' };

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
async function until(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}

/**
 * The scripted action tag of one provider request. The engine appends its OWN
 * labelled peer-mailbox delivery block as a trailing user message after the
 * coordinator turn input, so the newest user message is not reliably the
 * coordinator's turn. Only a message made purely of TEXT parts whose trimmed
 * text is EXACTLY one of the tags this fixture registered can be a scripted
 * turn; peer-delivery blocks (never registered), tool-result messages and any
 * other content are ignored, and no raw token is ever scanned out of content.
 */
const resolveTag = (messages, tags) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user' || !Array.isArray(message.parts)) {
      continue;
    }
    if (message.parts.some(part => part.type !== 'text')) {
      continue;
    }
    const text = message.parts.map(part => part.text).join('').trim();
    if (text && tags.has(text)) {
      return text;
    }
  }
  return undefined;
};

/**
 * One temporary non-Git fixture: real board, real private views, real resource
 * governor, real physical runner (capacity 1 so the bounded pool really queues)
 * and real approval surface. The only scripted seam is the model.
 *
 * `fault` is a test-only hook: it receives the allocated fixture context and
 * returns extra broker options, so the cleanup-on-rejected-startup path can be
 * exercised without weakening the real flow (which passes no hook at all).
 */
async function startFlow(t, captured, fault = null) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-flow-')));
  const root = path.join(base, 'repo');
  const brokers = [];
  const state = {
    config: { ...resourceDefaults, enabled: true },
    scripts: new Map(), tags: new Set(), catalogs: [], approvals: [], errors: [],
    cleanup: { brokersClosed: 0, baseRemoved: false }
  };
  let watchdog = null;
  let cleaned = false;
  /**
   * The fixture's only cleanup path, registered IMMEDIATELY after the directory
   * is allocated: the fixture mkdir/writes and the very first broker.start()
   * can each reject (a missing root, an unwritable store, an unavailable bridge),
   * so the hook must exist before any of them, and a rejected start closes every
   * broker constructed so far and removes the directory instead of leaking
   * both. It is idempotent, so the registered hook and an explicit call cannot
   * close a broker twice or double-count it.
   */
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (watchdog !== null) {
      clearTimeout(watchdog);
    }
    for (const created of brokers.reverse()) {
      const closed = await created.close().then(() => true, () => false);
      if (closed) {
        state.cleanup.brokersClosed += 1;
      }
    }
    await fs.rm(base, { recursive: true, force: true });
    state.cleanup.baseRemoved = true;
  };
  t.after(cleanup);
  await fs.mkdir(root);
  for (const [name, text] of Object.entries(captured)) {
    await fs.writeFile(path.join(root, name), text);
  }
  const options = {
    storage: path.join(base, 'storage'), registry: path.join(base, 'bridges'), roots: [root], identity: `folder:${root}`,
    provider: {
      models: async () => [model], countTokens: async () => 10,
      async *stream(_selected, messages, tools) {
        const tag = resolveTag(messages, state.tags);
        if (tag === undefined) {
          // No registered scripted turn (for example an unknown bootstrap or a
          // request whose only user text is the engine's peer-delivery block):
          // answer plainly and consume nothing.
          yield { type: 'text', text: 'done' };
          return;
        }
        // The exact catalog of THIS provider request, so a test can prove what a
        // worker was offered at that boundary instead of guessing.
        state.catalogs.push({ tag, tools: (Array.isArray(tools) ? tools : []).map(tool => tool.name) });
        const script = state.scripts.get(tag);
        if (script === undefined) {
          yield { type: 'text', text: 'done' };
          return;
        }
        state.scripts.delete(tag);
        yield { ...script.part };
      }
    },
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { allowWrite: true, allowShell: true, numSessions: 8 } } }),
    taskBoardEnabled: () => true, isolatedViewsEnabled: () => true, integrationEnabled: () => true, messagingEnabled: () => true,
    resourcesEnabled: () => true, resources: () => state.config, resourceDirectory: path.join(base, 'resources'),
    runners: () => ({ enabled: true, capacity: 1, maxQueue: 4 }),
    files: {
      canWrite: () => true, allowShell: () => true,
      // The real approval surface: only a command whose cwd stays inside this
      // temporary fixture is ever approved, never a repo or system directory.
      approveCommand: async (command, cwd) => {
        const allowed = inside(base, cwd);
        state.approvals.push({ command, cwd, allowed });
        return allowed;
      }
    },
    openDocuments: () => [], publicationDocuments: () => [],
    onChange: () => {}, onError: message => state.errors.push(message)
  };
  const open = async () => {
    const created = new WorkerBroker(options);
    brokers.push(created);
    await created.start();
    return created;
  };
  if (fault !== null) {
    Object.assign(options, fault({ base, root, state, brokers, cleanup }));
  }
  let broker;
  try {
    broker = await open();
  } catch (error) {
    // The registered hook alone would only run later; cleaning up here makes the
    // rejected startup deterministic: the partial broker is closed and the
    // directory removed before the error propagates to the test.
    await cleanup().catch(() => undefined);
    throw error;
  }
  watchdog = setTimeout(() => {
    console.error('parallel workflow test exceeded its watchdog budget');
    process.exit(1);
  }, 900_000);
  watchdog.unref();
  const invoke = current => async (name, args) => unpack(await current.invoke(root, name, args));
  return {
    base, root, captured, state, options,
    call: invoke(broker),
    broker: () => broker,
    /** Tool names offered in the FIRST provider request tagged `tag`. */
    tools: tag => state.catalogs.find(entry => entry.tag === tag)?.tools,
    /** Close and reopen the SAME store: nothing may be replayed by a reload. */
    reload: async () => {
      await broker.close();
      broker = await open();
      return invoke(broker);
    }
  };
}

/**
 * Finding 2 regression: the fixture registers cleanup immediately after it
 * allocates the directory, and a rejected startup ALSO cleans up before the
 * error propagates, so a rejection can never leave a partial broker or a fixture
 * directory behind. The fault is the REAL rejection path of
 * `WorkerBroker.start()` - a configured root that does not exist fails its first
 * `fs.realpath`, before any store write - so the real workflow is neither
 * stubbed nor weakened (it passes no fault hook at all).
 */
test('a rejected broker startup closes the partial broker and removes the fixture', { timeout: TEST_TIMEOUT }, async t => {
  let context = null;
  const failure = await startFlow(t, { 'add.cjs': ADD_BASE }, seen => {
    context = seen;
    return { roots: [path.join(seen.base, 'missing-repo')] };
  }).then(() => null, error => error);
  assert.ok(failure instanceof Error, 'the injected startup really rejected');
  assert.equal(failure.code, 'ENOENT', `unexpected failure: ${failure && failure.stack}`);
  assert.ok(context !== null, 'the fixture published its context before the first start');
  assert.equal(context.brokers.length, 1, 'exactly one broker was constructed before the rejection');

  // Nothing below calls cleanup: these effects must follow from the rejection
  // itself, which is exactly what the finding required.
  assert.equal(context.brokers[0].closed, true, 'the partial broker was closed');
  assert.equal(context.state.cleanup.brokersClosed, 1, 'exactly one broker close was performed');
  assert.equal(context.state.cleanup.baseRemoved, true, 'the fixture directory was removed');
  await assert.rejects(fs.access(context.base), { code: 'ENOENT' }, 'nothing of the fixture is left on disk');

  // Idempotent, so the after-hook that also runs this cannot re-close a broker.
  await context.cleanup();
  assert.equal(context.state.cleanup.brokersClosed, 1, 'a second cleanup must not re-close a broker');
});

test('two governed producers agree an interface, a consumer composes their seed and the tested combination is published exactly once', { timeout: TEST_TIMEOUT }, async t => {
  const fixture = await startFlow(t, {
    'add.cjs': ADD_BASE, 'multiply.cjs': MULTIPLY_BASE, 'verify.cjs': VERIFY,
    'check-add.cjs': CHECK_ADD_SCRIPT, 'check-multiply.cjs': CHECK_MULTIPLY_SCRIPT,
    'notes.txt': NOTES_BASE, 'slow.cjs': SLOW_SCRIPT
  });
  const { root, state } = fixture;
  let call = fixture.call;

  /**
   * Register the single scripted action for the next turn tagged `tag`. The tag
   * is also recorded in the durable known-tag Set, which is what makes routing
   * stable AFTER this action is consumed.
   */
  const script = (tag, part, options = {}) => {
    state.tags.add(tag);
    state.scripts.set(tag, { part, ...options });
  };
  const send = async (id, tag) => call('subagent_send', { ownerId, id, requestId: tag, message: tag });
  // OMIT timeoutMs: the production wait derives max(60s, effective turn
  // timeout / 10) and REJECTS a larger explicit value, so asking for more is an
  // invalid call, not a longer wait. One wait may also elapse while the worker
  // is still queued or running, so the state is re-read and waited again.
  const settled = async (id, allowed) => {
    for (let round = 0; round < 40; round += 1) {
      if (allowed.includes((await fixture.broker().session(root, id)).state)) {
        return;
      }
      await call('subagent_wait', { ids: [id] });
    }
    throw new Error(`worker ${id} never reached ${allowed.join('/')}`);
  };
  const stopped = async id => {
    await settled(id, ['completed', 'failed', 'cancelled', 'interrupted']);
    const session = await fixture.broker().session(root, id);
    assert.equal(session.state, 'completed', `worker ${id} did not stop: ${JSON.stringify(session.turns.at(-1)?.error)}`);
    return session;
  };
  const turn = async (id, tag, part) => { script(tag, part); await send(id, tag); return stopped(id); };
  /**
   * Parse one tool result and FAIL with the product's own bounded error
   * diagnostic when the call was refused, so a future invalid call reports its
   * error code instead of an `undefined` field of the expected success shape.
   */
  const toolResult = (session, name) => {
    const entry = session.turns.at(-1).tools.find(tool => tool.call.name === name);
    assert.ok(entry, `the last turn must contain a ${name} call`);
    const parsed = JSON.parse(entry.result);
    if (parsed !== null && typeof parsed === 'object' && parsed.error !== undefined) {
      assert.fail(`${name} was refused instead of answering: ${JSON.stringify(parsed.error).slice(0, 2000)}`);
    }
    return parsed;
  };
  const runCommand = command => ({ type: 'call', id: 'run', name: 'run_command', input: { command, path: '.' } });
  /**
   * The approved SLOW requests. The fixture approval POLICY is the only place
   * that sees a runner's real execution directory, so the gate is resolved from
   * its own recorded `cwd` (the materialized private copy) - never from a path
   * guessed here and never from the live project root.
   */
  const slowApprovals = () => state.approvals.filter(entry => entry.command === SLOW && entry.allowed);
  /**
   * Waits until the SLOW script is PHYSICALLY running: a new approval was
   * recorded for it and that approval's own copy holds the marker the process
   * itself wrote, so a later step cannot race a not-yet-started command.
   */
  const slowStarted = async (since, label) => {
    let directory;
    await until(async () => {
      const approvals = slowApprovals();
      const last = approvals.at(-1);
      if (last === undefined || approvals.length <= since) {
        return false;
      }
      const marker = await fs.readFile(path.join(last.cwd, 'slow.txt'), 'utf8').catch(() => undefined);
      if (marker !== 'started') {
        return false;
      }
      directory = last.cwd;
      return true;
    }, 90_000, label);
    return directory;
  };
  /** Drops the gate inside ONE runner's own copy; nothing outside it is touched. */
  const releaseGate = directory => fs.writeFile(path.join(directory, SLOW_GATE), 'go');
  const seal = (requestId, expectedRevision) => ({ type: 'call', id: 'seal', name: 'seal_submission', input: { requestId, expectedRevision } });
  const readFile = path0 => ({ type: 'call', id: 'read', name: 'read_file', input: { path: path0 } });
  const writeFile = (path0, expectedHash, content) => ({ type: 'call', id: 'edit', name: 'write_file', input: { path: path0, expectedHash, content } });

  // --- team, shared snapshot, three tasks, contract recorded LAST ----------
  const team = await call('subagent_team_create', { ownerId, requestId: 'team', name: 'Parallel workflow', description: 'Two governed producers plus a dependent consumer' });
  const baseSnapshot = await call('subagent_snapshot_create', { ownerId, teamId: team.id, requestId: 'base-snapshot' });
  assert.match(baseSnapshot.id, /^[a-f0-9]{64}$/);
  const createTask = (requestId, title, dependencies = []) => call('subagent_task_create', {
    ownerId, requestId, teamId: team.id, title, description: `Task ${title}`,
    acceptanceCriteria: [`${AGREED} passes on the combined result`], dependencies
  });
  const taskA = await createTask('task-add', 'add');
  const taskP = await createTask('task-multiply', 'multiply');
  const taskB = await createTask('task-consumer', 'consumer', [
    { taskId: taskA.id, kind: 'artifact' },
    { taskId: taskA.id, kind: 'contract' },
    { taskId: taskP.id, kind: 'artifact' },
    { taskId: taskP.id, kind: 'contract' }
  ]);
  assert.equal(taskB.dependencies.length, 4);
  const unrelated = await createTask('task-unrelated', 'unrelated');
  assert.equal(unrelated.state, 'ready');
  const scope = () => ({ ownerId, teamId: team.id });

  /** Governed create-bind-start with the exact current team/task revisions. */
  const spawnGoverned = async (requestId, taskId, lane, snapshotId, prompt, first) => {
    if (first !== undefined) {
      script(prompt, first);
    }
    const currentTeam = await call('subagent_team_get', { ownerId, id: team.id });
    const currentTask = await call('subagent_task_get', { ownerId, id: taskId });
    return call('subagent_isolated_spawn', {
      ownerId, requestId, task: prompt, model: model.id, permission: 'workspace-write',
      setup: { teamId: team.id, taskId, snapshotId, teamRevision: currentTeam.revision, taskRevision: currentTask.revision, lane }
    });
  };
  /** The board's own two-step submission, so readiness is really checked. */
  const submit = async (taskId, artifact, label) => {
    const current = await call('subagent_task_get', { ownerId, id: taskId });
    const started = await call('subagent_task_update', { ownerId, requestId: `${label}-start`, taskId, expectedRevision: current.revision, state: 'in_progress' });
    assert.equal(started.state, 'in_progress');
    const submitted = await call('subagent_task_update', {
      ownerId, requestId: `${label}-submit`, taskId, expectedRevision: started.revision, candidates: [artifact], state: 'submitted'
    });
    assert.deepEqual(submitted.candidates, [artifact]);
    return submitted;
  };
  /** validating -> exact passed verdict -> accepted, each its own decision. */
  const accept = async (taskId, artifact, evidence, label) => {
    const submitted = await submit(taskId, artifact, label);
    const validating = await call('subagent_task_update', { ownerId, requestId: `${label}-validating`, taskId, expectedRevision: submitted.revision, state: 'validating' });
    assert.equal(validating.state, 'validating');
    const verdict = await call('subagent_task_update', {
      ownerId, requestId: `${label}-verdict`, taskId, expectedRevision: validating.revision, state: 'validating',
      validations: [{ artifactId: artifact.id, candidateVersion: artifact.version, outcome: 'passed', resultRef: evidence, at: new Date().toISOString() }]
    });
    const accepted = await call('subagent_task_update', { ownerId, requestId: `${label}-accept`, taskId, expectedRevision: verdict.revision, state: 'accepted' });
    assert.equal(accepted.state, 'accepted');
    assert.deepEqual(accepted.candidates, [artifact], 'the exact verdict settles the exact artifact version');
    return accepted;
  };

  // ------------------------------------------------------------------------
  // 1. TWO governed producers, both bound to the SAME base snapshot BEFORE
  //    their first provider/tool call, each on its own task.
  // ------------------------------------------------------------------------
  const peerWorker = await spawnGoverned('worker-multiply', taskP.id, 'work', baseSnapshot.id, 'p-first-look', readFile('multiply.cjs'));
  assert.match(peerWorker.id, /^[a-f0-9]{32}$/);
  const firstP = await stopped(peerWorker.id);
  assert.equal(firstP.mode, 'governed');
  assert.ok(['bound', 'ready', 'started'].includes(firstP.startup?.phase), `governed startup recorded: ${String(firstP.startup?.phase)}`);
  assert.equal(firstP.isolatedView?.snapshotId, baseSnapshot.id, 'peer bound to the shared snapshot before any tool');
  const peerTools = fixture.tools('p-first-look');
  assert.ok(peerTools.includes('seal_submission'), 'the peer is offered the seal tool from its first turn');
  assert.ok(peerTools.includes('subagent_mailbox_send'), 'the peer mailbox is live in the same first catalog');
  assert.ok(peerTools.includes('run_command'), 'the live runner seam is offered to a writable worker');
  const peerFirstLook = toolResult(firstP, 'read_file');
  assert.equal(peerFirstLook.content, MULTIPLY_BASE, 'the peer reads the base bytes at revision 0: no implementation yet');
  assert.equal(peerFirstLook.revision, 0);

  const producerA = await spawnGoverned('worker-add', taskA.id, 'work', baseSnapshot.id, 'a-proposal', {
    type: 'call', id: 'proposal', name: 'subagent_mailbox_send',
    input: {
      teamId: team.id, taskId: taskA.id, requestId: 'a-proposal-send', kind: 'interface_proposal',
      body: 'Proposed seam: add.cjs first, multiply.cjs consumes it, release.cjs carries the version.',
      recipients: [peerWorker.id]
    }
  });
  const firstA = await stopped(producerA.id);
  assert.equal(firstA.mode, 'governed');
  assert.equal(firstA.isolatedView?.snapshotId, baseSnapshot.id, 'producer A is bound to the same shared snapshot before any tool');
  const firstATools = fixture.tools('a-proposal');
  assert.ok(firstATools.includes('seal_submission'));
  assert.ok(firstATools.includes('subagent_mailbox_send'));
  assert.ok(firstATools.includes('run_command'));
  const proposal = toolResult(firstA, 'subagent_mailbox_send');
  assert.equal(proposal.kind, 'interface_proposal');
  assert.deepEqual(proposal.sender, { kind: 'worker', workerId: producerA.id });
  assert.deepEqual(proposal.recipients, [{ kind: 'worker', workerId: peerWorker.id }]);
  assert.deepEqual(proposal.body, 'Proposed seam: add.cjs first, multiply.cjs consumes it, release.cjs carries the version.');
  // The proposal's own team/task are the routing the reply must reuse.
  assert.equal(proposal.teamId, team.id);
  assert.equal(proposal.taskId, taskA.id, 'the proposal is routed on the PRODUCER task A');

  // --- the response, from the peer's own turn, over the durable mailbox ----
  const peerInbox = toolResult(await turn(peerWorker.id, 'p-inbox', { type: 'call', id: 'list', name: 'subagent_mailbox_list', input: { teamId: team.id } }), 'subagent_mailbox_list');
  const seenProposal = peerInbox.messages.find(message => message.id === proposal.id);
  assert.ok(seenProposal, 'the peer really reads the proposal from the durable mailbox');
  assert.equal(seenProposal.kind, 'interface_proposal');
  const response = toolResult(await turn(peerWorker.id, 'p-reply', {
    type: 'call', id: 'reply', name: 'subagent_mailbox_send',
    // A reply stays in the TARGET's exact team and task - the producer task the
    // proposal was routed on - not the replying worker's own task.
    input: { teamId: proposal.teamId, taskId: proposal.taskId, requestId: 'p-reply-send', kind: 'interface_response', body: 'Agreed: multiply consumes add, release carries version 1.', replyTo: proposal.id }
  }), 'subagent_mailbox_send');
  assert.equal(response.kind, 'interface_response');
  assert.equal(response.replyTo, proposal.id);
  assert.equal(response.teamId, proposal.teamId, 'the reply echoes the proposal team');
  assert.equal(response.taskId, proposal.taskId, 'the reply echoes the proposal task');
  assert.deepEqual(response.sender, { kind: 'worker', workerId: peerWorker.id });
  // A reads the agreement itself before implementing.
  // A's own INBOX only: the default list direction is 'all', which would also
  // return A's own proposal from its outbox.
  const aInbox = toolResult(await turn(producerA.id, 'a-inbox', { type: 'call', id: 'list', name: 'subagent_mailbox_list', input: { teamId: team.id, direction: 'inbox' } }), 'subagent_mailbox_list');
  assert.deepEqual(aInbox.messages.map(message => message.kind), ['interface_response']);
  assert.equal(aInbox.messages[0].replyTo, proposal.id, 'the response answers exactly that proposal');

  // ------------------------------------------------------------------------
  // 2. Only NOW does the coordinator record the agreed interface, before any
  //    dependent implementation, on BOTH producers.
  // ------------------------------------------------------------------------
  const currentA = await call('subagent_task_get', { ownerId, id: taskA.id });
  const contractedA = await call('subagent_task_update', {
    ownerId, requestId: 'agree-a', taskId: taskA.id, expectedRevision: currentA.revision, agreedContracts: { add: [INTERFACE] }
  });
  assert.deepEqual(contractedA.agreedContracts, [INTERFACE], 'the agreed interface is a durable coordinator record on A');
  const currentP = await call('subagent_task_get', { ownerId, id: taskP.id });
  const contractedP = await call('subagent_task_update', {
    ownerId, requestId: 'agree-p', taskId: taskP.id, expectedRevision: currentP.revision, agreedContracts: { add: [INTERFACE] }
  });
  assert.deepEqual(contractedP.agreedContracts, [INTERFACE], 'and the same agreed interface on P');
  const agreedRef = contractedA.agreedContracts[0];

  // ------------------------------------------------------------------------
  // 3. BOTH producers implement privately; neither edit is visible to the
  //    peer or to the live workspace.
  // ------------------------------------------------------------------------
  const editA = toolResult(await turn(producerA.id, 'a-edit', writeFile('add.cjs', hash(ADD_BASE), ADD_CHANGED)), 'write_file');
  assert.equal(editA.revision, 1);
  const editP = toolResult(await turn(peerWorker.id, 'p-edit', writeFile('multiply.cjs', hash(MULTIPLY_BASE), MULTIPLY_CHANGED)), 'write_file');
  assert.equal(editP.revision, 1);
  assert.equal(await fs.readFile(path.join(root, 'add.cjs'), 'utf8'), ADD_BASE, 'the live workspace never sees A private edit');
  assert.equal(await fs.readFile(path.join(root, 'multiply.cjs'), 'utf8'), MULTIPLY_BASE, 'the live workspace never sees P private edit');
  const crossLook = toolResult(await turn(producerA.id, 'a-look-peer', readFile('multiply.cjs')), 'read_file');
  assert.equal(crossLook.content, MULTIPLY_BASE, 'A cannot see the peer private edit');
  assert.equal(crossLook.revision, 1, 'A is on its own revision');
  const crossLookP = toolResult(await turn(peerWorker.id, 'p-look-peer', readFile('add.cjs')), 'read_file');
  assert.equal(crossLookP.content, ADD_BASE, 'P cannot see the producer private edit');
  assert.equal(crossLookP.revision, 1);

  // ------------------------------------------------------------------------
  // 4. Each producer seals, then proves its own revision with its OWN real,
  //    narrow, passing physical-runner command.
  // ------------------------------------------------------------------------
  const sealA = toolResult(await turn(producerA.id, 'a-seal', seal('a-seal', 1)), 'seal_submission');
  assert.equal(sealA.revision, 1);
  assert.equal(sealA.snapshotId, baseSnapshot.id);
  const sealP = toolResult(await turn(peerWorker.id, 'p-seal', seal('p-seal', 1)), 'seal_submission');
  assert.equal(sealP.revision, 1);
  assert.equal(sealP.snapshotId, baseSnapshot.id);
  assert.notEqual(sealA.overlayId, sealP.overlayId, 'each producer owns a distinct private overlay on the one shared snapshot');
  const artifactA = { id: sealA.id, version: sealA.version, uri: sealA.uri };
  const artifactP = { id: sealP.id, version: sealP.version, uri: sealP.uri };
  assert.ok(await call('subagent_view_pin', { ownerId, teamId: team.id, requestId: 'pin-add', name: 'producer-add', resource: { kind: 'submission', id: sealA.id } }));
  assert.ok(await call('subagent_view_pin', { ownerId, teamId: team.id, requestId: 'pin-multiply', name: 'producer-multiply', resource: { kind: 'submission', id: sealP.id } }));

  // The coordinator inspection returns the same view read the worker sees (the
  // broker's unpack already parsed it), not a content envelope to parse again.
  const sealARead = await call('subagent_submission_read', {
    ownerId, teamId: team.id, submissionId: sealA.id, operation: 'read_file', input: { path: 'add.cjs' }
  });
  assert.equal(sealARead.content, ADD_CHANGED, 'the sealed producer bytes are A private edit');
  assert.equal(sealARead.hash, hash(ADD_CHANGED));
  const sealPRead = await call('subagent_submission_read', {
    ownerId, teamId: team.id, submissionId: sealP.id, operation: 'read_file', input: { path: 'multiply.cjs' }
  });
  assert.equal(sealPRead.content, MULTIPLY_CHANGED);

  const runA = toolResult(await turn(producerA.id, 'a-run', runCommand(CHECK_ADD)), 'run_command');
  assert.equal(runA.outcome, 'succeeded', JSON.stringify(runA));
  assert.equal(runA.exitCode, 0);
  assert.equal(runA.drained, true);
  assert.equal(runA.import, 'unchanged');
  assert.equal(runA.attempt.inputVersion.revision, 1, 'the proof names the exact sealed input revision');
  assert.equal(runA.attempt.inputVersion.snapshotId, baseSnapshot.id);
  assert.match(runA.output, /add\(3\)=5/);
  const runP = toolResult(await turn(peerWorker.id, 'p-run', runCommand(CHECK_MULTIPLY)), 'run_command');
  assert.equal(runP.outcome, 'succeeded', JSON.stringify(runP));
  assert.equal(runP.drained, true);
  assert.equal(runP.import, 'unchanged');
  assert.equal(runP.attempt.inputVersion.revision, 1);
  assert.match(runP.output, /multiply\(4\)=12/);
  const evidenceA = { id: runA.id, version: runA.version, uri: runA.uri };
  const evidenceP = { id: runP.id, version: runP.version, uri: runP.uri };
  // Real evidence for each producer, each naming only its own revision.
  const fetchedA = await call('subagent_runner_result', { ...scope(), id: runA.id });
  assert.equal(fetchedA.inputIsCurrent, true, 'A evidence is current for the revision it proved');
  assert.equal(fetchedA.result.attempt.inputVersion.overlayId, sealA.overlayId);
  const fetchedP = await call('subagent_runner_result', { ...scope(), id: runP.id });
  assert.equal(fetchedP.inputIsCurrent, true);
  assert.equal(fetchedP.result.attempt.inputVersion.overlayId, sealP.overlayId);

  // ------------------------------------------------------------------------
  // 5. The board settles EACH producer separately, by its own verdict.
  // ------------------------------------------------------------------------
  const acceptedA = await accept(taskA.id, artifactA, evidenceA, 'accept-add');
  const acceptedP = await accept(taskP.id, artifactP, evidenceP, 'accept-multiply');

  // ------------------------------------------------------------------------
  // 6. Consumer B starts DIRECTLY on the exact composed consumer seed.
  // ------------------------------------------------------------------------
  const consumerTask = await call('subagent_task_get', { ownerId, id: taskB.id });
  const seed = await call('subagent_integration', {
    action: 'begin', ownerId, teamId: team.id, requestId: 'consumer-seed',
    sources: [
      { taskId: taskA.id, taskRevision: acceptedA.revision, artifact: artifactA, evidence: [evidenceA] },
      { taskId: taskP.id, taskRevision: acceptedP.revision, artifact: artifactP, evidence: [evidenceP] }
    ],
    contracts: [
      { taskId: taskA.id, taskRevision: acceptedA.revision, ref: agreedRef },
      { taskId: taskP.id, taskRevision: acceptedP.revision, ref: agreedRef }
    ],
    consumer: { taskId: taskB.id, taskRevision: consumerTask.revision }
  });
  assert.equal(seed.status, 'ready', JSON.stringify(seed.failure));
  assert.equal(seed.seedOnly, true, 'a consumer begin is a private dependency seed');
  assert.equal(seed.canPublish, false);
  assert.equal(seed.baseSnapshotId, baseSnapshot.id);
  assert.match(seed.derivedSnapshotId, /^[a-f0-9]{64}$/);
  assert.notEqual(seed.derivedSnapshotId, baseSnapshot.id);
  assert.deepEqual(seed.requirements.sources.map(source => source.state), ['accepted', 'accepted']);
  assert.deepEqual(seed.requirements.sources.map(source => source.artifact), [artifactA, artifactP]);
  assert.deepEqual(seed.requirements.sources.map(source => source.evidence), [[evidenceA], [evidenceP]]);

  const consumer = await spawnGoverned('worker-consumer', taskB.id, 'work', seed.derivedSnapshotId, 'b-read-add', readFile('add.cjs'));
  const consumerFirst = await stopped(consumer.id);
  assert.equal(consumerFirst.mode, 'governed');
  assert.equal(consumerFirst.isolatedView?.snapshotId, seed.derivedSnapshotId, 'the consumer is started on the exact composed seed, not rebound');
  assert.equal(consumerFirst.startup?.snapshotId, seed.derivedSnapshotId);
  const bLookAdd = toolResult(consumerFirst, 'read_file');
  assert.equal(bLookAdd.content, ADD_CHANGED, 'the consumer proves A exact accepted bytes at revision 0');
  assert.equal(bLookAdd.hash, hash(ADD_CHANGED));
  assert.equal(bLookAdd.revision, 0);
  const bLookMultiply = toolResult(await turn(consumer.id, 'b-read-multiply', readFile('multiply.cjs')), 'read_file');
  assert.equal(bLookMultiply.content, MULTIPLY_CHANGED, 'and the peer exact accepted bytes');
  assert.equal(bLookMultiply.revision, 0);
  const bEdit = toolResult(await turn(consumer.id, 'b-edit', writeFile('release.cjs', 'new', RELEASE)), 'write_file');
  assert.equal(bEdit.path, 'release.cjs');
  assert.equal(bEdit.revision, 1);
  const sealB = toolResult(await turn(consumer.id, 'b-seal', seal('b-seal', 1)), 'seal_submission');
  assert.equal(sealB.revision, 1);
  assert.equal(sealB.snapshotId, seed.derivedSnapshotId);
  const runB = toolResult(await turn(consumer.id, 'b-run', runCommand(AGREED)), 'run_command');
  assert.equal(runB.outcome, 'succeeded', JSON.stringify(runB));
  assert.equal(runB.drained, true);
  assert.equal(runB.import, 'unchanged');
  assert.equal(runB.attempt.inputVersion.revision, 1);
  assert.equal(runB.attempt.inputVersion.snapshotId, seed.derivedSnapshotId);
  assert.match(runB.output, /combined 15/, 'the consumer revision satisfies the fully composed oracle');
  const artifactB = { id: sealB.id, version: sealB.version, uri: sealB.uri };
  const evidenceB = { id: runB.id, version: runB.version, uri: runB.uri };

  // The coordinator sees the whole durable exchange, in order.
  const mailbox = await call('subagent_mailbox_list', { ownerId, teamId: team.id });
  assert.deepEqual(mailbox.messages.map(message => message.kind), ['interface_proposal', 'interface_response']);
  assert.deepEqual(mailbox.messages.map(message => message.sender.workerId), [producerA.id, peerWorker.id]);
  assert.equal(mailbox.messages[1].replyTo, mailbox.messages[0].id);
  assert.equal(mailbox.messages[1].body, 'Agreed: multiply consumes add, release carries version 1.');

  const submittedB = await submit(taskB.id, artifactB, 'submit-consumer');

  // ------------------------------------------------------------------------
  // 7. ONE publishing integration of the selected B output over A+P.
  // ------------------------------------------------------------------------
  const publishing = await call('subagent_integration', {
    action: 'begin', ownerId, teamId: team.id, requestId: 'publish-combined',
    sources: [{ taskId: taskB.id, taskRevision: submittedB.revision, artifact: artifactB, evidence: [evidenceB] }],
    contracts: [
      { taskId: taskA.id, taskRevision: acceptedA.revision, ref: agreedRef },
      { taskId: taskP.id, taskRevision: acceptedP.revision, ref: agreedRef }
    ],
    validationCommands: [AGREED]
  });
  assert.equal(publishing.status, 'ready', JSON.stringify(publishing.failure));
  assert.equal(publishing.seedOnly, false);
  assert.deepEqual(publishing.requirements.sources.map(source => source.taskId), [taskB.id], 'the selected output is B');
  assert.deepEqual(publishing.requirements.sources.map(source => source.evidence), [[evidenceB]]);
  for (const [producer, kind] of [[taskA.id, 'contract'], [taskP.id, 'contract'], [taskA.id, 'artifact'], [taskP.id, 'artifact']]) {
    assert.ok(publishing.dependencies.some(dependency => dependency.taskId === producer && dependency.kind === kind),
      `the ${kind} edge on ${producer} stays recorded: ${JSON.stringify(publishing.dependencies)}`);
  }
  assert.equal(publishing.baseSnapshotId, seed.derivedSnapshotId, "B immediate base is the composed A+P seed");
  assert.notEqual(publishing.derivedSnapshotId, seed.derivedSnapshotId);
  assert.notEqual(publishing.derivedSnapshotId, baseSnapshot.id);
  assert.deepEqual(publishing.conflictPaths, [], 'the three producer paths are disjoint');
  for (const [name, text] of Object.entries(fixture.captured)) {
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), text, `nothing publishes before apply (${name})`);
  }

  // --- the combined candidate is really run --------------------------------
  const validationTask = await createTask('task-validation', 'validation');
  const validationWorker = await spawnGoverned('worker-validation', validationTask.id, 'validation', publishing.derivedSnapshotId, 'validation-seed', seal('seed-seal', 0));
  const validationSession = await stopped(validationWorker.id);
  const seedSeal = toolResult(validationSession, 'seal_submission');
  assert.equal(seedSeal.revision, 0, 'a validation candidate is the unchanged composed seed');
  assert.equal(seedSeal.snapshotId, publishing.derivedSnapshotId);
  const seedRun = toolResult(await turn(validationWorker.id, 'validation-run', runCommand(AGREED)), 'run_command');
  assert.equal(seedRun.outcome, 'succeeded', JSON.stringify(seedRun));
  assert.equal(seedRun.exitCode, 0);
  assert.equal(seedRun.drained, true);
  assert.equal(seedRun.import, 'unchanged');
  assert.equal(seedRun.attempt.inputVersion.revision, 0);
  assert.match(seedRun.output, /combined 15/);

  const candidate = await call('subagent_integration', {
    action: 'candidate', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: publishing.revision, requestId: 'candidate-combined',
    artifact: { id: seedSeal.id, version: seedSeal.version, uri: seedSeal.uri }
  });
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.candidate.lane, 'validation');
  assert.equal(candidate.candidate.submission.revision, 0);
  assert.equal(candidate.candidate.submission.snapshotId, publishing.derivedSnapshotId);
  assert.deepEqual(candidate.validations, []);

  // A producer result for a different revision is refused and records nothing.
  await assert.rejects(call('subagent_integration', {
    action: 'validate', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: candidate.revision, requestId: 'validate-stale', evidence: [evidenceA]
  }), error => error.code === 'evidence_invalid');
  const refused = await call('subagent_integration', { action: 'status', ownerId, teamId: team.id, attemptId: publishing.attemptId });
  assert.equal(refused.status, 'candidate', 'a refused validate records no verdict');
  assert.equal(refused.revision, candidate.revision);
  assert.deepEqual(refused.validations, []);

  const validated = await call('subagent_integration', {
    action: 'validate', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: refused.revision, requestId: 'validate-combined',
    evidence: [{ id: seedRun.id, version: seedRun.version, uri: seedRun.uri }]
  });
  assert.equal(validated.status, 'validated');
  assert.deepEqual(validated.validations.map(entry => entry.command), [AGREED]);
  assert.deepEqual(validated.validations.map(entry => entry.result.id), [seedRun.id]);

  const accepted = await call('subagent_integration', {
    action: 'accept', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: validated.revision, requestId: 'accept-combined'
  });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.acceptance.resolvedPaths, []);
  assert.equal(accepted.canPublish, true);

  // --- an unrelated intervening user edit is preserved ---------------------
  await fs.writeFile(path.join(root, 'notes.txt'), NOTES_USER);

  const applied = await call('subagent_integration', {
    action: 'apply', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: accepted.revision, requestId: 'apply-combined'
  });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.apply));
  assert.equal(applied.apply.state, 'applied');
  assert.deepEqual([...applied.apply.applied].sort(), ['add.cjs', 'multiply.cjs', 'release.cjs']);
  assert.deepEqual(applied.apply.conflicts, []);
  assert.equal(await fs.readFile(path.join(root, 'add.cjs'), 'utf8'), ADD_CHANGED);
  assert.equal(await fs.readFile(path.join(root, 'multiply.cjs'), 'utf8'), MULTIPLY_CHANGED);
  assert.equal(await fs.readFile(path.join(root, 'release.cjs'), 'utf8'), RELEASE, 'the consumer new file is published');
  assert.equal(await fs.readFile(path.join(root, 'verify.cjs'), 'utf8'), VERIFY, 'the agreed oracle is never rewritten');
  assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), NOTES_USER, 'an unrelated intervening user edit survives');
  const disk = await execute(process.execPath, ['verify.cjs'], { cwd: root, windowsHide: true });
  assert.match(disk.stdout, /combined 15/, 'the REAL agreed command passes on the published root');

  // A later user edit of an applied path survives an exact apply replay.
  await fs.writeFile(path.join(root, 'add.cjs'), ADD_USER);
  const replay = await call('subagent_integration', {
    action: 'apply', ownerId, teamId: team.id, attemptId: publishing.attemptId,
    expectedRevision: accepted.revision, requestId: 'apply-combined'
  });
  assert.equal(replay.replayed, true);
  assert.equal(await fs.readFile(path.join(root, 'add.cjs'), 'utf8'), ADD_USER, 'an applied path is never rewritten');

  // ------------------------------------------------------------------------
  // 8. Bounded pool (capacity 1): the second command queues, capacity holds.
  //    Both producers above are ACCEPTED, and the product stops a governed
  //    worker whose task is terminal, so this pool phase uses its own two
  //    governed workers on fresh non-terminal tasks, each bound to the same
  //    shared base snapshot and each on its own private revision 1.
  // ------------------------------------------------------------------------
  const taskPoolSlow = await createTask('task-pool-slow', 'pool-slow');
  const taskPoolQueued = await createTask('task-pool-queued', 'pool-queued');
  const poolSlowWorker = await spawnGoverned('worker-pool-slow', taskPoolSlow.id, 'work', baseSnapshot.id, 'pool-slow-edit', writeFile('add.cjs', hash(ADD_BASE), ADD_CHANGED));
  const poolSlowFirst = await stopped(poolSlowWorker.id);
  assert.equal(poolSlowFirst.mode, 'governed');
  assert.equal(poolSlowFirst.isolatedView?.snapshotId, baseSnapshot.id, 'the pool worker is bound to the shared snapshot');
  assert.equal(toolResult(poolSlowFirst, 'write_file').revision, 1);
  const poolQueuedWorker = await spawnGoverned('worker-pool-queued', taskPoolQueued.id, 'work', baseSnapshot.id, 'pool-queued-edit', writeFile('multiply.cjs', hash(MULTIPLY_BASE), MULTIPLY_CHANGED));
  const poolQueuedFirst = await stopped(poolQueuedWorker.id);
  assert.equal(poolQueuedFirst.isolatedView?.snapshotId, baseSnapshot.id);
  assert.equal(toolResult(poolQueuedFirst, 'write_file').revision, 1);
  const poolSlowOverlay = poolSlowFirst.isolatedView.overlayId;
  const poolQueuedOverlay = poolQueuedFirst.isolatedView.overlayId;
  assert.notEqual(poolSlowOverlay, poolQueuedOverlay, 'each pool worker owns its own private overlay');
  // One real success on this worker's own revision 1, BEFORE its importing run,
  // so that later revision provably makes the stored result stale.
  const poolEvidenceRun = toolResult(await turn(poolSlowWorker.id, 'pool-slow-evidence', runCommand(CHECK_ADD)), 'run_command');
  assert.equal(poolEvidenceRun.outcome, 'succeeded', JSON.stringify(poolEvidenceRun));
  assert.equal(poolEvidenceRun.import, 'unchanged');
  assert.equal(poolEvidenceRun.attempt.inputVersion.revision, 1);
  // A settled lease keeps its high-water phase for the journal, and only the
  // 'released' state frees its slot, so liveness is read from the STATE.
  const liveLeases = items => items.filter(item => item.state !== 'released');
  script('pool-slow', runCommand(SLOW));
  const slowApprovalBase = slowApprovals().length;
  await send(poolSlowWorker.id, 'pool-slow');
  // Hold the FIRST command physically BEFORE the second is even queued: the
  // marker its own process wrote into its own copy proves it really started, so
  // there is no send-order race and no fixed overlap window to guess.
  const slowDirectory = await slowStarted(slowApprovalBase, 'the first bounded command to be physically running');
  script('pool-queued', runCommand(CHECK_MULTIPLY));
  await send(poolQueuedWorker.id, 'pool-queued');
  let overlap;
  let lastSeen;
  try {
    // Which of the two bounded commands holds the single slot is a real race
    // between two workers, so the OBSERVED state is the property: exactly one
    // command holds the slot while exactly the other one waits behind it.
    await until(async () => {
      const queue = await call('subagent_runner_status', { ...scope(), kind: 'queue' });
      const leases = await call('subagent_runner_status', { ...scope(), kind: 'leases' });
      lastSeen = { queue, leases };
      const running = leases.items.filter(item => item.state !== 'released' && item.phase === 'executing');
      if (running.length !== 1 || queue.items.length !== 1) {
        return false;
      }
      if (running[0].owner.workerId === queue.items[0].workerId) {
        return false;
      }
      overlap = { queue, leases, running };
      return true;
    }, 60_000, 'one bounded command to hold the single slot while the other queues');
  } catch (error) {
    // Diagnostic only: keep the same failing assertion, but report what the two
    // workers and the pool were really doing instead of a bare timeout.
    const rows = session => (session.turns.at(-1)?.tools ?? []).map(tool => `${tool.call.name}:${String(tool.state)}`);
    const a = await fixture.broker().session(root, poolSlowWorker.id);
    const p = await fixture.broker().session(root, poolQueuedWorker.id);
    assert.fail(`${String(error?.message ?? error)} | queueSummary=${JSON.stringify(lastSeen?.queue?.summary)} queueItems=${JSON.stringify(lastSeen?.queue?.items)} leases=${JSON.stringify(lastSeen?.leases?.items?.map(item => [item.owner?.workerId, item.state, item.phase]))} ${
      JSON.stringify(lastSeen?.queue?.summary?.error ?? null)} | A=${a.state} ${JSON.stringify(rows(a))} ${JSON.stringify(a.turns.at(-1)?.error ?? null)} | P=${p.state} ${JSON.stringify(rows(p))} ${JSON.stringify(p.turns.at(-1)?.error ?? null)}`);
  }
  let gateReleased = false;
  try {
    assert.equal(overlap.queue.summary.capacity, 1);
    assert.equal(overlap.queue.summary.maxQueue, 4);
    assert.ok(overlap.queue.summary.activeCount <= overlap.queue.summary.capacity, 'capacity is never exceeded');
    assert.equal(overlap.queue.summary.queueLength, 1, 'exactly one command waits for the single slot');
    assert.equal(overlap.queue.items[0].position, 1, 'the queue is FIFO from position 1');
    assert.ok([poolSlowWorker.id, poolQueuedWorker.id].includes(overlap.queue.items[0].workerId),
      'the queued command is one of the two bounded commands');
    assert.equal(liveLeases(overlap.leases.items).length, 1, 'exactly one command holds the single slot');
    assert.equal(overlap.running[0].owner.workerId !== overlap.queue.items[0].workerId, true,
      'the queued command is the one that is NOT holding the slot');
    // ONLY NOW, with one command provably holding the single slot and the other
    // provably queued behind it, release the gate inside that runner's own copy.
    await releaseGate(slowDirectory);
    gateReleased = true;
  } finally {
    // A failure above must never leave the held command waiting to its own bound:
    // its gate is released so the pool drains and the real failure is reported.
    if (!gateReleased) {
      await releaseGate(slowDirectory).catch(() => undefined);
    }
  }
  const slowSession = await stopped(poolSlowWorker.id);
  const queuedSession = await stopped(poolQueuedWorker.id);
  const pooled = toolResult(slowSession, 'run_command');
  assert.equal(pooled.outcome, 'succeeded', JSON.stringify(pooled));
  assert.equal(pooled.drained, true);
  assert.equal(pooled.import, 'imported', 'the materialized marker is imported into the private overlay');
  assert.match(pooled.output, /slow-done/, 'the held command really consumed the released gate');
  assert.doesNotMatch(pooled.output, /gate-timeout/, 'the gate was released by the observed pool state');
  assert.equal(pooled.attempt.inputVersion.revision, 1);
  assert.equal(pooled.attempt.inputVersion.overlayId, poolSlowOverlay);
  assert.equal(pooled.afterVersion?.revision, 2, 'the imported command names its exact after version');
  const queued = toolResult(queuedSession, 'run_command');
  assert.equal(queued.outcome, 'succeeded', JSON.stringify(queued));
  assert.equal(queued.import, 'unchanged');
  assert.equal(queued.attempt.inputVersion.revision, 1);
  assert.equal(queued.attempt.inputVersion.overlayId, poolQueuedOverlay, 'the queued command ran on its own owner overlay');
  // The gate lived only inside the runner's materialized copy and was consumed
  // by the process itself, so the private overlay holds the marker and no gate.
  const pooledListing = toolResult(await turn(poolSlowWorker.id, 'pool-slow-listing',
    { type: 'call', id: 'list', name: 'list_files', input: { path: '.' } }), 'list_files');
  const pooledNames = pooledListing.entries.map(entry => entry.name);
  assert.ok(pooledNames.includes('slow.txt'), `the marker is the imported change: ${JSON.stringify(pooledNames)}`);
  assert.equal(pooledNames.includes(SLOW_GATE), false, 'the gate file is consumed inside the runner copy and never imported');
  assert.equal(pooledListing.revision, 2, 'the listing reads the imported revision');
  const drainedQueue = await call('subagent_runner_status', { ...scope(), kind: 'queue' });
  assert.deepEqual(drainedQueue.items, []);
  assert.equal(drainedQueue.summary.activeCount, 0);

  // The pool worker's later private revision 2 makes its earlier revision-1
  // success stale while the stored result itself stays immutable.
  const stale = await call('subagent_runner_result', { ...scope(), id: poolEvidenceRun.id });
  assert.equal(stale.result.id, poolEvidenceRun.id);
  assert.equal(stale.result.attempt.inputVersion.revision, 1);
  assert.equal(stale.currentRevision, 2);
  assert.equal(stale.inputIsCurrent, false);
  assert.equal(stale.stale, true);

  // ------------------------------------------------------------------------
  // 9. Cancellation: uncertain work is never replayed, before or after reload.
  // ------------------------------------------------------------------------
  script('cancel-run', runCommand(SLOW));
  const cancelApprovalBase = slowApprovals().length;
  await send(poolQueuedWorker.id, 'cancel-run');
  // The same gated script with the gate NEVER released: the cancellation must
  // land on a real running process. The marker that process wrote into its own
  // copy plus the journal's executing lease prove it is really running, and the
  // script's bounded wait means a lost cancellation fails instead of hanging.
  await slowStarted(cancelApprovalBase, 'the cancellable command to be physically running');
  await until(async () => {
    const leases = await call('subagent_runner_status', { ...scope(), kind: 'leases' });
    return leases.items.some(item => item.state !== 'released' && item.phase === 'executing');
  }, 60_000, 'the cancellable command to hold an executing lease');
  await call('subagent_cancel', { ownerId, id: poolQueuedWorker.id });
  await until(async () => ['cancelled', 'completed', 'failed'].includes((await fixture.broker().session(root, poolQueuedWorker.id)).state),
    60_000, 'the cancelled worker to stop');
  const cancelledSession = await fixture.broker().session(root, poolQueuedWorker.id);
  assert.equal(cancelledSession.state, 'cancelled');
  const interrupted = cancelledSession.turns.at(-1).tools.find(tool => tool.call.name === 'run_command');
  assert.ok(interrupted, 'the cancelled turn keeps its started tool record');
  assert.ok(['started', 'uncertain'].includes(interrupted.state), 'an interrupted tool call never records a completion');
  // The stopped session is not the durable proof: the command must have reached
  // its FINAL, drained result record before that result is read or the store is
  // reloaded, otherwise the assertion (or the reload) races the drain.
  let cancelledRow;
  await until(async () => {
    const page = await call('subagent_runner_status', { ...scope(), kind: 'results' });
    cancelledRow = page.items.find(item => item.outcome === 'cancelled');
    return cancelledRow !== undefined && cancelledRow.drained === true;
  }, 60_000, 'the cancelled command to drain and record its final result');
  const beforeReload = await call('subagent_runner_status', { ...scope(), kind: 'results' });
  const cancelledRows = beforeReload.items.filter(item => item.outcome === 'cancelled');
  assert.equal(cancelledRows.length, 1, 'the cancellation is one recorded result');
  assert.equal(cancelledRows[0].id, cancelledRow.id, 'the drained result is the one recorded');
  const cancelledResult = await call('subagent_runner_result', { ...scope(), id: cancelledRow.id });
  assert.equal(cancelledResult.result.drained, true, 'the cancelled command was drained');
  assert.equal(cancelledResult.result.outcome, 'cancelled');
  assert.equal(cancelledResult.result.id, cancelledRow.id);
  const totalBeforeReload = beforeReload.total;
  // Nothing may still be draining or queued in this scope before the reload.
  let idle;
  await until(async () => {
    idle = { queue: await call('subagent_runner_status', { ...scope(), kind: 'queue' }), leases: await call('subagent_runner_status', { ...scope(), kind: 'leases' }) };
    return idle.queue.items.length === 0 && liveLeases(idle.leases.items).length === 0;
  }, 60_000, 'the pool to settle after the cancelled command drained');
  assert.equal(idle.queue.summary.activeCount, 0);

  call = await fixture.reload();
  const afterReload = await call('subagent_runner_status', { ...scope(), kind: 'results' });
  assert.equal(afterReload.total, totalBeforeReload, 'a reload never replays uncertain work');
  assert.equal(afterReload.items.filter(item => item.outcome === 'cancelled').length, 1);
  const reloadedLeases = await call('subagent_runner_status', { ...scope(), kind: 'leases' });
  assert.equal(liveLeases(reloadedLeases.items).length, 0, 'no lease is left live after a reload');
  assert.equal((await fixture.broker().session(root, poolQueuedWorker.id)).state, 'cancelled', 'the interrupted worker stays cancelled');

  // ------------------------------------------------------------------------
  // 10. Legacy is unaffected: a standalone non-member keeps the legacy catalog.
  // ------------------------------------------------------------------------
  script('legacy-read', readFile('add.cjs'));
  const legacyWorker = await call('subagent_spawn', { ownerId, requestId: 'legacy-worker', task: 'legacy-read', permission: 'workspace-write', model: model.id });
  const legacySession = await stopped(legacyWorker.id);
  const legacyTools = fixture.tools('legacy-read') || [];
  assert.ok(legacyTools.includes('read_file'));
  assert.equal(legacyTools.includes('seal_submission'), false, 'a legacy worker is never offered governed view tools');
  assert.equal(legacyTools.includes('subagent_mailbox_send'), false, 'a non-member legacy worker is never offered mailbox tools');
  assert.equal(legacySession.mode, 'standalone');
  assert.equal(legacySession.isolatedView, undefined);
  assert.equal(toolResult(legacySession, 'read_file').content, ADD_USER, 'legacy reads the live workspace exactly as before');

  // ------------------------------------------------------------------------
  // Final board and approval audit.
  // ------------------------------------------------------------------------
  assert.equal((await call('subagent_task_get', { ownerId, id: taskA.id })).state, 'accepted');
  assert.equal((await call('subagent_task_get', { ownerId, id: taskP.id })).state, 'accepted');
  assert.equal((await call('subagent_task_get', { ownerId, id: taskB.id })).state, 'submitted', 'integration never rewrites the board');
  assert.equal((await call('subagent_task_get', { ownerId, id: unrelated.id })).state, 'ready');
  assert.deepEqual(state.approvals.filter(entry => !entry.allowed), [], 'no command ran outside the fixture');
  assert.deepEqual([...new Set(state.approvals.map(entry => entry.command))].sort(), [AGREED, CHECK_ADD, CHECK_MULTIPLY, SLOW].sort());
  // Host-level diagnostics: the whole run must be completely clean. This is the
  // unfiltered list, not a keyword subset, so no unexpected diagnostic of any
  // kind can pass unnoticed. A cancellation is a RESULT here, never an error.
  assert.deepEqual(state.errors, [],
    `unexpected host diagnostics: ${JSON.stringify(state.errors)}`);
});
