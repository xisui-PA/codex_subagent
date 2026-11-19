// Focused lifecycle tests for GOVERNED RUNNER INPUT retention.
//
// The problem under test: an auto-sealed runner input could permanently occupy
// submission metadata. A governed setup can seal its exact input and then fail
// BEFORE any RunnerResults.start record owns it (an invalid working directory,
// for example), and a result collection can delete the only record that
// referenced its input before that input is released. Either way the submission
// was unreferenced yet not released, so it rooted its snapshot forever.
//
// Every case observes real disk/index state: a real IsolatedViews store, a real
// RunnerResults store, a real RunnerExecution (setup only, nothing is spawned)
// and, in the last two cases, the real IsolatedViewHost.collectResources call.
//
// Build (focused output only):
//   npx tsc -p tsconfig.json --outDir .test-build --sourceMap false
// Run:
//   node --test tests/runner-input-retention.test.cjs
// A private CODEX_TEST_BUILD may point at another compile; the default is the
// standard shared .test-build so npm test / CI never needs a cycle directory.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const buildDir = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { IsolatedViews } = require(path.join(buildDir, 'isolated-views'));
const { captureProject } = require(path.join(buildDir, 'project-snapshot'));
const { RunnerExecution } = require(path.join(buildDir, 'runner-execution'));
const { RunnerResults } = require(path.join(buildDir, 'runner-results'));
const { IsolatedViewHost } = require(path.join(buildDir, 'isolated-view-host'));

// Fail loudly against a stale compile instead of silently testing old code.
if (typeof IsolatedViews.prototype.reclaimInputs !== 'function'
  || typeof IsolatedViews.prototype.proveRunnerInputs !== 'function') {
  throw new Error(`stale isolated-views build at ${buildDir}; recompile it`);
}

const sha256 = value => crypto.createHash('sha256').update(Array.isArray(value) ? JSON.stringify(value) : value).digest('hex');
const id64 = label => sha256(`id64:${label}`);
const id32 = label => sha256(`id32:${label}`).slice(0, 32);
const TEAM = id32('team');
const OWNER = 'owner-runner-inputs';
const DATE = '2026-11-13T00:00:00.000Z';
const scope = { ownerId: OWNER, teamId: TEAM };
/** Mirrors the view index receipt cap; a full map must still be reclaimable. */
const MAX_VIEW_RECEIPTS = 4096;

const exists = target => fs.lstat(target).then(() => true, () => false);

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-inputs-'));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  await fs.mkdir(root);
  const views = new IsolatedViews(storeDir, root);
  await views.open();
  t.after(async () => {
    await views.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, storeDir, views };
}

/** One snapshot, one bound worker and its exact binding identity. */
async function boundWorker(fx, views, label = 'governed-worker') {
  await fs.writeFile(path.join(fx.root, 'base.txt'), 'base\n');
  const snapshot = await views.createSnapshot(
    { ownerId: OWNER, teamId: TEAM, requestId: `create:${label}`, selectionKey: 'default' },
    (snapshotId, beforePublish) => captureProject(fx.root, views.content, {
      snapshotId, namespace: views.namespace, beforePublish
    })
  );
  const workerId = id32(label);
  const identity = { ownerId: OWNER, workerId, workerCreatedAt: DATE };
  const record = await views.bind(
    { ownerId: OWNER, teamId: TEAM, snapshotId: snapshot.id, workerId, workerCreatedAt: DATE, requestId: `bind:${label}` },
    async () => undefined
  );
  return {
    snapshot,
    identity,
    workerId,
    binding: { teamId: TEAM, snapshotId: snapshot.id, overlayId: record.overlayId }
  };
}

/** A governed input sealed, then abandoned before any attempt record exists. */
async function abandonedInput(views, worker, requestId) {
  const before = new Set((await views.inspect(OWNER, TEAM)).submissions.map(entry => entry.id));
  await assert.rejects(
    views.withSealedInput(worker.binding, worker.identity, { requestId, expectedRevision: 0 }, () => {
      throw new Error('the command setup failed before any attempt record existed');
    }),
    /the command setup failed/
  );
  const added = (await views.inspect(OWNER, TEAM)).submissions.filter(entry => !before.has(entry.id));
  assert.equal(added.length, 1, 'the abandoned setup sealed exactly one input');
  return added[0];
}

const submissionsOf = async views => (await views.inspect(OWNER, TEAM)).submissions;

/** A durable final result owned by the given exact sealed input. */
function attemptFor(worker, root, artifact, label) {
  return {
    id: id32(label),
    owner: { ownerId: OWNER, teamId: TEAM, workerId: worker.workerId, workerCreatedAt: DATE },
    leaseId: id32(label),
    logicalRoot: root,
    executionDirectory: path.join(root, 'src'),
    command: 'node tools/report.cjs',
    timeoutMs: 30_000,
    inputArtifact: { id: artifact.id, version: artifact.version, uri: artifact.uri, revision: artifact.revision },
    inputVersion: { snapshotId: worker.snapshot.id, overlayId: worker.binding.overlayId, revision: artifact.revision },
    setup: {
      identityHash: id64(`${label}:setup`), platform: process.platform, arch: process.arch, nodeVersion: process.version,
      shell: 'cmd.exe', environmentHash: id64(`${label}:environment`), caches: []
    },
    startedAt: DATE
  };
}

test('an abandoned governed seal is reclaimable metadata, and only the marked input is ever reclaimed', async t => {
  const fx = await fixture(t);
  let views = fx.views;
  const worker = await boundWorker(fx, views);

  // 1) ABANDONED PRE-RESULT SETUP: the exact input is sealed, then the setup
  // throws before anything durably owns the input.
  const sealInput = { requestId: 'runner:lease-1', expectedRevision: 0 };
  await assert.rejects(
    views.withSealedInput(worker.binding, worker.identity, sealInput, () => {
      throw new Error('setup failed before the attempt record');
    }),
    /setup failed before the attempt record/
  );
  let submissions = await submissionsOf(views);
  assert.equal(submissions.length, 1, 'exactly one seal was published');
  const leaked = submissions[0];
  assert.equal(leaked.runnerInput, true, 'the auto-seal carries the additive marker');
  assert.equal(leaked.released, false, 'the abandoned seal is unreferenced, not released');

  // 2) STABLE SEAL IDENTITY: retrying the SAME request replays that exact seal.
  const replayId = await views.withSealedInput(worker.binding, worker.identity, sealInput, (_view, submission) => submission.id);
  assert.equal(replayId, leaked.id);
  submissions = await submissionsOf(views);
  assert.equal(submissions.length, 1, 'a retry never publishes a second submission');
  assert.equal(submissions[0].version, leaked.version);
  assert.equal(submissions[0].uri, leaked.uri);

  // 3) A NORMAL USER SEAL is never eligible: it has no marker and no candidate.
  const userSealed = await views.seal(worker.binding, worker.identity, { requestId: 'user-seal', expectedRevision: 0 });
  assert.equal(userSealed.runnerInput, undefined);

  // 4) RELOAD: the marker is durable and a fresh handle still sees it.
  await views.close();
  views = new IsolatedViews(fx.storeDir, fx.root);
  t.after(async () => { await views.close(); });
  await views.open();
  submissions = await submissionsOf(views);
  assert.equal(submissions.find(entry => entry.id === leaked.id).runnerInput, true, 'the marker survived close/reopen');

  // 5) RETAINED REFERENCES: a board/evidence reference preserves the input.
  let reclaimed = await views.reclaimInputs(scope, () => new Set([leaked.uri]));
  assert.deepEqual(reclaimed.released, []);
  assert.equal(reclaimed.preserved, 1);
  assert.equal((await submissionsOf(views)).find(entry => entry.id === leaked.id).released, false);
  assert.equal(await views.withSubmission(OWNER, TEAM, leaked.id, (_view, submission) => submission.id), leaked.id);

  // 6) EXPLICIT NATIVE VIEW PIN: also preserves it, and the evidence stays readable.
  const pin = await views.pin({
    ownerId: OWNER, teamId: TEAM, requestId: 'pin-runner-input', name: 'runner-input-evidence',
    resource: { kind: 'submission', id: leaked.id }
  });
  reclaimed = await views.reclaimInputs(scope, () => new Set());
  assert.deepEqual(reclaimed.released, []);
  assert.equal(reclaimed.preserved, 1, 'the pinned input is preserved');
  assert.equal(await views.withSubmission(OWNER, TEAM, leaked.id, (_view, submission) => submission.id), leaked.id,
    'a recovered sweep leaves retained evidence readable');

  // 7) Once the exact pin is released, the next sweep reclaims ONLY the marked input.
  await views.release({ ownerId: OWNER, teamId: TEAM, requestId: 'unpin-runner-input', kind: 'pin', id: pin.id });
  reclaimed = await views.reclaimInputs(scope, () => new Set());
  assert.deepEqual(reclaimed.released, [leaked.id]);
  assert.equal(reclaimed.preserved, 0);
  submissions = await submissionsOf(views);
  assert.equal(submissions.find(entry => entry.id === leaked.id).released, true);
  assert.equal(submissions.find(entry => entry.id === userSealed.id).released, false, 'no user submission is reclaimed');

  // 7b) A retry AFTER reclamation fails closed: the released acknowledgment can
  // never recreate the input or publish a new consumer.
  await assert.rejects(
    views.withSealedInput(worker.binding, worker.identity, sealInput, () => 'unreachable'),
    error => error.code === 'isolation_released'
  );

  // 8) A repeated sweep is a no-op: the reclamation commits no per-input receipt.
  const again = await views.reclaimInputs(scope, () => new Set());
  assert.deepEqual(again.released, []);
  assert.equal(again.preserved, 0);

  // 9) EXISTING CAS CLEANUP removes the released metadata and keeps the user seal.
  const cleanup = await views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: 'reclaim-cleanup' });
  assert.equal(cleanup.deletedSubmissions, 1);
  assert.deepEqual((await submissionsOf(views)).map(entry => entry.id), [userSealed.id]);
  assert.equal(await exists(path.join(fx.root, 'base.txt')), true, 'the live workspace was never touched');
});

test('a governed setup failure publishes no attempt, and a fresh reference set retains pending/final owners', async t => {
  const fx = await fixture(t);
  const worker = await boundWorker(fx, fx.views);
  const executionRoot = path.join(fx.base, 'runners');
  const execution = new RunnerExecution(executionRoot, fx.root, {
    capacity: 1,
    maxQueue: 1,
    closeTimeoutMs: 20_000,
    approveCommand: async () => { throw new Error('no approval may be requested'); },
    retainInputs: () => true,
    inputRequestId: (owner, key) => fx.views.requestId(owner.ownerId, key)
  });
  await execution.open();
  t.after(async () => { await execution.close().catch(() => undefined); });

  // 1) The real governed path seals BEFORE the attempt record, so an invalid
  // working directory leaks the exact seal while leaving no result behind.
  await assert.rejects(
    execution.execute(worker.binding, worker.identity, fx.views, { command: 'node -v', path: 'not-a-directory' }, new AbortController().signal),
    error => error.code === 'invalid_path'
  );
  assert.equal(execution.results.status().results, 0, 'setup failed before any attempt record');
  assert.equal(execution.results.status().pending, 0);
  assert.ok(execution.pool.status().leases.every(lease => lease.state === 'released'));
  const leaked = (await submissionsOf(fx.views))[0];
  assert.equal(leaked.runnerInput, true);
  assert.equal(leaked.released, false);

  // 2) Two further auto-sealed inputs, one owned by a durable final result and
  // one owned by a durable pending attempt.
  const owned = await abandonedInput(fx.views, worker, 'runner:final');
  const pendingOwned = await abandonedInput(fx.views, worker, 'runner:pending');
  const finalAttempt = attemptFor(worker, fx.root, owned, 'attempt-final');
  const pendingAttempt = attemptFor(worker, fx.root, pendingOwned, 'attempt-pending');
  await execution.results.start(finalAttempt);
  await execution.results.finish(finalAttempt.id, {
    outcome: 'succeeded', import: 'unchanged', afterVersion: finalAttempt.inputVersion, drained: true, exitCode: 0
  });
  await execution.results.start(pendingAttempt);

  // 3) FINAL/PENDING OWNERSHIP: a fresh reference set retains both owned inputs
  // and only the abandoned, unreferenced one is reclaimed.
  const references = () => new Set(execution.results.inputReferences(new Set()));
  assert.equal(references().has(owned.uri), true);
  assert.equal(references().has(pendingOwned.uri), true);
  let reclaimed = await fx.views.reclaimInputs(scope, references);
  assert.deepEqual(reclaimed.released, [leaked.id]);
  assert.equal(reclaimed.preserved, 2);

  // 4) RETRY AFTER THE RESULT IS ALREADY GONE: collect the final result, then a
  // fresh sweep reclaims its now-unreferenced input.
  const collected = await execution.collect(scope, [finalAttempt.id], new Set(), new Set());
  assert.equal(collected.removed.length, 1, 'the unreferenced final result was collected');
  assert.equal(references().has(owned.uri), false);
  reclaimed = await fx.views.reclaimInputs(scope, references);
  assert.deepEqual(reclaimed.released, [owned.id]);
  assert.equal(reclaimed.preserved, 1, 'the pending attempt still owns its input');
  const state = await submissionsOf(fx.views);
  assert.equal(state.find(entry => entry.id === leaked.id).released, true);
  assert.equal(state.find(entry => entry.id === owned.id).released, true);
  assert.equal(state.find(entry => entry.id === pendingOwned.id).released, false);
  assert.equal(await fx.views.withSubmission(OWNER, TEAM, pendingOwned.id, (_view, submission) => submission.id), pendingOwned.id);
  await assert.rejects(
    fx.views.withSubmission(OWNER, TEAM, owned.id, () => 'unreachable'),
    error => error.code === 'isolation_released'
  );

  // 5) The existing cleanup removes both reclaimed submissions and keeps the
  // one a durable pending attempt still owns.
  const cleanup = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: 'retention-cleanup' });
  assert.equal(cleanup.deletedSubmissions, 2);
  assert.deepEqual((await submissionsOf(fx.views)).map(entry => entry.id), [pendingOwned.id]);
});

test('collectResources sweeps auto-sealed inputs even with no result ids', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-collect-'));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  await fs.mkdir(root);
  const host = makeHost(root, storeDir);
  t.after(async () => {
    await host.close().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true });
  });
  const views = await host.open();
  const fx = { root };
  const worker = await boundWorker(fx, views, 'host-worker');

  // One abandoned input with no result at all, one abandoned input that a
  // durable final result references.
  const leaked = await abandonedInput(views, worker, 'runner:abandoned');
  const collectedInput = await abandonedInput(views, worker, 'runner:collected');

  // The runner store exists (a governed setup opened it before it failed); its
  // results store keeps the durable final record that owns the second input.
  const runnerDir = path.join(storeDir, 'runners');
  await fs.mkdir(runnerDir, { recursive: true });
  const seeder = new RunnerResults(path.join(runnerDir, 'results'), root);
  await seeder.open();
  const attempt = attemptFor(worker, root, collectedInput, 'host-attempt');
  await seeder.start(attempt);
  await seeder.finish(attempt.id, {
    outcome: 'succeeded', import: 'unchanged', afterVersion: attempt.inputVersion, drained: true, exitCode: 0
  });
  await seeder.close();

  // NO RESULT IDS: the explicit sweep still reclaims the abandoned input and
  // preserves the one the durable result still owns.
  const outcome = await host.collectResources(scope, [], new Set());
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.reclaimed.released, [leaked.id]);
  assert.equal(outcome.reclaimed.preserved, 1);
  let submissions = await submissionsOf(views);
  assert.equal(submissions.find(entry => entry.id === leaked.id).released, true);
  assert.equal(submissions.find(entry => entry.id === collectedInput.id).released, false);

  // A LATER RETRY with the result id: the result is collected and the fresh
  // reference set no longer names its input, so that input is reclaimed too.
  const removed = await host.collectResources(scope, [attempt.id], new Set());
  assert.equal(removed.removed.length, 1);
  assert.deepEqual(removed.reclaimed.released, [collectedInput.id]);
  assert.equal(removed.reclaimed.preserved, 0);
  submissions = await submissionsOf(views);
  assert.equal(submissions.find(entry => entry.id === collectedInput.id).released, true);

  const cleanup = await views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: 'host-cleanup' });
  assert.equal(cleanup.deletedSubmissions, 2);
  assert.deepEqual(await submissionsOf(views), []);
});

test('explicit reclamation works with a FULL receipt map and keeps unmarked unknown inputs', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-receipts-'));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  const viewsDir = path.join(storeDir, 'isolated-views');
  const indexFile = path.join(viewsDir, 'index.json');
  await fs.mkdir(root);
  let host;
  t.after(async () => {
    await host?.close().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true });
  });

  // A first handle publishes the real records: one abandoned auto-seal, one
  // unmarked user seal that a result references, and one unmarked user seal no
  // result references (an unknown input that must be preserved).
  const seed = new IsolatedViews(viewsDir, root);
  await seed.open();
  const worker = await boundWorker({ root }, seed, 'cap-worker');
  const leaked = await abandonedInput(seed, worker, 'runner:abandoned');
  const candidate = await seed.seal(worker.binding, worker.identity, { requestId: 'user-candidate', expectedRevision: 0 });
  const unknown = await seed.seal(worker.binding, worker.identity, { requestId: 'user-unknown', expectedRevision: 0 });
  assert.equal(candidate.runnerInput, undefined, 'a user seal is never marked');
  assert.equal(unknown.runnerInput, undefined);
  await seed.close();

  // Re-open the runner store's durable result that owns the unmarked candidate.
  const runnerDir = path.join(storeDir, 'runners');
  await fs.mkdir(runnerDir, { recursive: true });
  const seeder = new RunnerResults(path.join(runnerDir, 'results'), root);
  await seeder.open();
  const attempt = attemptFor(worker, root, candidate, 'cap-attempt');
  await seeder.start(attempt);
  await seeder.finish(attempt.id, {
    outcome: 'succeeded', import: 'unchanged', afterVersion: attempt.inputVersion, drained: true, exitCode: 0
  });
  await seeder.close();

  // Fill the view receipt map to its documented cap, exactly as an owner with a
  // long history of request IDs would have it.
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  let filler = 0;
  while (Object.keys(index.receipts).length < MAX_VIEW_RECEIPTS) {
    index.receipts[id64(`filler:${filler}`)] = { fingerprint: id64(`filler-fingerprint:${filler}`), result: null };
    filler += 1;
  }
  assert.equal(Object.keys(index.receipts).length, MAX_VIEW_RECEIPTS);
  await fs.writeFile(indexFile, JSON.stringify(index), 'utf8');

  // The real host path: collecting the older result must not fail on a receipt
  // write after the result was already deleted.
  host = makeHost(root, storeDir);
  const views = await host.open();
  const outcome = await host.collectResources(scope, [attempt.id], new Set());
  assert.equal(outcome.removed.length, 1, 'the older result was collected');
  assert.deepEqual([...outcome.reclaimed.released].sort(), [leaked.id, candidate.id].sort(),
    'one scoped reclaim covered both the marked auto-seal and the input proven by the collected result');
  assert.equal(outcome.reclaimed.preserved, 0, 'no eligible input was still retained');
  const state = await submissionsOf(views);
  assert.equal(state.find(entry => entry.id === leaked.id).released, true);
  assert.equal(state.find(entry => entry.id === candidate.id).released, true);
  assert.equal(state.find(entry => entry.id === unknown.id).released, false, 'no unknown input is reclaimed');

  // The receipt map is still full and reclamation stays a no-op, not a failure.
  const again = await host.collectResources(scope, [], new Set());
  assert.deepEqual(again.reclaimed.released, []);
  assert.equal(again.reclaimed.preserved, 0);
  const stillUnknown = await submissionsOf(views);
  assert.equal(stillUnknown.find(entry => entry.id === unknown.id).released, false);
  const final = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.equal(Object.keys(final.receipts).length, MAX_VIEW_RECEIPTS, 'reclamation wrote no receipt');
});

test('an older input is proven before its result is deleted, so a crash before the sweep still reclaims it', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-proof-'));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  const viewsDir = path.join(storeDir, 'isolated-views');
  const indexFile = path.join(viewsDir, 'index.json');
  await fs.mkdir(root);
  let host;
  t.after(async () => {
    await host?.close().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true });
  });

  // An OLDER unmarked user seal: only its result record proves it was a runner
  // input, and that record is deleted by the collection under test.
  const seed = new IsolatedViews(viewsDir, root);
  await seed.open();
  const worker = await boundWorker({ root }, seed, 'proof-worker');
  const older = await seed.seal(worker.binding, worker.identity, { requestId: 'user-older', expectedRevision: 0 });
  const bystander = await seed.seal(worker.binding, worker.identity, { requestId: 'user-bystander', expectedRevision: 0 });
  assert.equal(older.runnerInput, undefined, 'the older input starts unmarked');
  await seed.close();

  const runnerDir = path.join(storeDir, 'runners');
  await fs.mkdir(runnerDir, { recursive: true });
  const seeder = new RunnerResults(path.join(runnerDir, 'results'), root);
  await seeder.open();
  const attempt = attemptFor(worker, root, older, 'proof-attempt');
  await seeder.start(attempt);
  await seeder.finish(attempt.id, {
    outcome: 'succeeded', import: 'unchanged', afterVersion: attempt.inputVersion, drained: true, exitCode: 0
  });
  // A result owned by another owner names the same input shape; a scope denial
  // must still propagate BEFORE anything is deleted.
  const foreign = { ...attemptFor(worker, root, bystander, 'foreign-attempt'),
    owner: { ownerId: 'someone-else', teamId: TEAM, workerId: worker.workerId, workerCreatedAt: DATE } };
  await seeder.start(foreign);
  await seeder.finish(foreign.id, {
    outcome: 'succeeded', import: 'unchanged', afterVersion: foreign.inputVersion, drained: true, exitCode: 0
  });
  await seeder.close();
  // Records live one level below the results store root this manager opens.
  const resultFile = id => path.join(runnerDir, 'results', 'results', `${id}.json`);

  host = makeHost(root, storeDir);
  const views = await host.open();

  // 1) SCOPE CHECK PRESERVED: a foreign result id is refused, unlinking nothing.
  await assert.rejects(
    host.collectResources(scope, [foreign.id], new Set()),
    error => error.code === 'runner_results_denied'
  );
  assert.equal(await exists(resultFile(foreign.id)), true, 'the foreign result was not deleted');
  assert.equal((await submissionsOf(views)).find(entry => entry.id === bystander.id).runnerInput, undefined,
    'a denied query proves nothing');

  // 2) INJECTION: the collection deletes the result, then the sweep fails before
  // it runs - exactly the crash window the reviewer described.
  const original = views.reclaimInputs.bind(views);
  let injected = 0;
  views.reclaimInputs = async (...args) => {
    if (injected === 0) {
      injected += 1;
      throw new Error('injected failure after the result was deleted');
    }
    return original(...args);
  };
  await assert.rejects(
    host.collectResources(scope, [attempt.id], new Set()),
    /injected failure after the result was deleted/
  );
  assert.equal(injected, 1);
  assert.equal(await exists(resultFile(attempt.id)), false, 'the result was already deleted');
  // The proof is DURABLE, published before that deletion, and nothing released.
  const proved = JSON.parse(await fs.readFile(indexFile, 'utf8')).submissions[older.id];
  assert.equal(proved.runnerInput, true, 'the exact input was durably proven a runner input');
  assert.equal(proved.released, false, 'nothing was released by the failed sweep');
  assert.equal((await views.inspect(OWNER, TEAM)).submissions.find(entry => entry.id === bystander.id).runnerInput,
    undefined, 'an input no result proved is never marked');

  // 3) REOPEN AND RETRY with NO result ids (and one id that no longer exists):
  // the marker alone lets the sweep finish the reclamation.
  await host.close();
  host = makeHost(root, storeDir);
  const reopened = await host.open();
  const retried = await host.collectResources(scope, [id32('never-existed')], new Set());
  assert.deepEqual(retried.removed, []);
  assert.deepEqual(retried.reclaimed.released, [older.id]);
  assert.equal(retried.reclaimed.preserved, 0);
  const state = await submissionsOf(reopened);
  assert.equal(state.find(entry => entry.id === older.id).released, true);
  assert.equal(state.find(entry => entry.id === bystander.id).released, false, 'the unproven input is preserved');

  const cleanup = await reopened.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: 'proof-cleanup' });
  assert.equal(cleanup.deletedSubmissions, 1);
  assert.deepEqual((await submissionsOf(reopened)).map(entry => entry.id), [bystander.id]);
});

function makeHost(root, storeDir) {
  const board = {
    assertTeam: () => undefined,
    open: async () => ({ snapshot: () => ({ tasks: [] }) })
  };
  const store = { directory: storeDir, list: () => [], get: () => ({}) };
  return new IsolatedViewHost(root, store, board, {
    enabled: () => true,
    guard: () => undefined,
    canWrite: () => true,
    settings: () => ({ models: {} }),
    runners: () => ({ enabled: true, capacity: 1, maxQueue: 1 })
  });
}
