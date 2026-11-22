// Focused exact-artifact integration tests for the REAL isolated views core.
//
// Every fixture is real disk state: snapshots come from captureProject, seals
// from the durable index, and composition from the pinned artifacts only. No
// live workspace fallback, no fake success: assertions read the stored bytes.
//
// NOTE: inspect() collections are ARRAYS; index records are looked up by id.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function loadBuildDir() {
  const dir = String(process.env.CODEX_TEST_BUILD || '.test-build').trim();
  return path.join(__dirname, '..', dir);
}
const buildDir = loadBuildDir();
const { IsolatedViews } = require(path.join(buildDir, 'isolated-views'));
const { captureProject } = require(path.join(buildDir, 'project-snapshot'));

const sha256 = value => crypto.createHash('sha256').update(Array.isArray(value) ? JSON.stringify(value) : value).digest('hex');
const id64 = label => sha256(`id64:${label}`);
const id32 = label => sha256(`id32:${label}`).slice(0, 32);
const bytesHash = text => crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
const TEAM = id32('team');
const OWNER = 'owner-a';
const DATE = '2026-11-13T00:00:00.000Z';

const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const gitOk = (root, ...args) => {
  const result = git(root, ...args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-artifacts-'));
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

let requestCounter = 0;
const nextRequest = label => `${label}-${(requestCounter += 1)}`;

async function createSnapshot(fx, label) {
  return fx.views.createSnapshot(
    { ownerId: OWNER, teamId: TEAM, requestId: nextRequest(label), selectionKey: 'default' },
    (id, recordCandidate) => captureProject(fx.root, fx.views.content, {
      snapshotId: id,
      namespace: fx.views.namespace,
      openDocuments: () => [],
      beforePublish: recordCandidate
    })
  );
}

function binderOf(label, snapshotId) {
  const workerId = id32(label);
  const workerCreatedAt = DATE;
  const identity = { ownerId: OWNER, workerId, workerCreatedAt };
  const input = requestId => ({ ownerId: OWNER, teamId: TEAM, snapshotId, workerId, workerCreatedAt, requestId });
  return { workerId, workerCreatedAt, identity, input };
}

async function bind(fx, binder, startup) {
  const record = await fx.views.bind(binder.input(nextRequest('bind')), async () => {}, undefined, startup);
  return { teamId: TEAM, snapshotId: record.snapshotId, overlayId: record.overlayId };
}

async function writeFile(fx, binder, binding, file, text) {
  const bytes = Buffer.from(text);
  await fx.views.edit(binding, binder.identity, async (_view, put) => ({
    [file]: { type: 'file', hash: await put(bytes), size: bytes.length, mode: 0o644 }
  }));
}

async function sealAt(fx, binder, binding, label, expectedRevision) {
  return fx.views.seal(binding, binder.identity, { requestId: nextRequest(label), expectedRevision });
}

const refOf = submission => ({ id: submission.id, version: submission.version, uri: submission.uri });

function scopeOf(attemptLabel) {
  return { ownerId: OWNER, teamId: TEAM, attemptId: id64(attemptLabel) };
}

async function blobPath(storeDir, hash) {
  const blobs = path.join(storeDir, 'content', 'blobs');
  for (const prefix of await fs.readdir(blobs)) {
    for (const suffix of await fs.readdir(path.join(blobs, prefix))) {
      if (`${prefix}${suffix}` === hash) {
        return path.join(blobs, prefix, suffix);
      }
    }
  }
  return undefined;
}

async function seedManifest(fx, seed) {
  return JSON.parse((await fx.views.content.read(seed.manifestHash)).toString('utf8'));
}

/** Real Git repository fixture: tracked bytes stay NATIVE until composed. */
async function gitFixture(t, label) {
  const fleet = await fs.mkdtemp(path.join(os.tmpdir(), `codex-artifacts-${label}-`));
  const root = path.join(fleet, 'root');
  const storeDir = path.join(fleet, 'store');
  await fs.mkdir(root);
  gitOk(root, 'init', '-q', '-b', 'main', '.');
  gitOk(root, 'config', 'user.email', 'test@example.com');
  gitOk(root, 'config', 'user.name', 'Test User');
  gitOk(root, 'config', 'core.autocrlf', 'false');
  const views = new IsolatedViews(storeDir, root);
  await views.open();
  t.after(async () => {
    await views.close();
    await fs.rm(fleet, { recursive: true, force: true });
  });
  return { base: fleet, root, storeDir, views };
}

/**
 * Delegating writer log: every payload the REAL store is asked to put during an
 * action is recorded by hash. It adds no public option and no test-only seam -
 * every read and write still goes through the real ContentStore.
 */
function recordWrites(views) {
  const writes = [];
  const real = views.content;
  views.content = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') {
        return value;
      }
      if (prop !== 'put') {
        return value.bind(target);
      }
      return async (bytes, guard) => {
        const hash = await value.call(target, bytes, guard);
        writes.push({ hash, size: bytes.length });
        return hash;
      };
    }
  });
  return writes;
}

/** Shared fixture: one captured base, one bound producer per text label. */
async function compositionFixture(t, texts) {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'shared.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(fx.root, 'keep.txt'), 'kept\n');
  const base = await createSnapshot(fx, 'base');
  const producers = [];
  for (const [index, text] of texts.entries()) {
    const binder = binderOf(`producer-${index}`, base.id);
    const binding = await bind(fx, binder);
    await writeFile(fx, binder, binding, `add-${index}.txt`, text);
    const submission = await sealAt(fx, binder, binding, 'seal', 1);
    producers.push({ binder, binding, submission });
  }
  return { fx, base, producers };
}

test('same exact base: composition pins, merges real entries and replays the same seed', async t => {
  const { fx, base, producers } = await compositionFixture(t, ['alpha\n', 'beta\n']);
  const scope = scopeOf('attempt-same');
  const refs = producers.map(entry => refOf(entry.submission));

  const retained = await fx.views.retainIntegrationArtifacts(scope, refs);
  assert.deepEqual(retained.map(entry => entry.id).sort(), refs.map(ref => ref.id).sort());

  const inspection = await fx.views.inspect(OWNER, TEAM);
  assert.equal(inspection.pins.filter(pin => pin.integration?.attemptId === scope.attemptId).length, 2);
  assert.equal(inspection.snapshots.filter(snapshot => snapshot.provenance).length, 0, 'retention creates no seed');

  const composition = await fx.views.composeIntegration(scope, refs);
  assert.equal(composition.baseSnapshotId, base.id, 'the composition names the exact captured base');
  assert.deepEqual(composition.conflicts, []);
  assert.equal(composition.snapshot.backing.kind, 'cas');
  assert.notEqual(composition.snapshot.id, base.id);
  assert.equal(composition.snapshot.provenance.kind, 'integration-seed');
  assert.equal(composition.snapshot.provenance.attemptId, scope.attemptId);
  assert.deepEqual(composition.snapshot.provenance.refs, refs);

  const manifest = await seedManifest(fx, composition.snapshot);
  assert.equal(manifest.fileCount, 4, 'shared.txt, keep.txt and two producer files');
  for (const [index, text] of ['alpha\n', 'beta\n'].entries()) {
    assert.equal(manifest.entries[`add-${index}.txt`].hash, bytesHash(text));
  }
  assert.equal(manifest.entries['shared.txt'].hash, bytesHash('one\ntwo\nthree\n'));
  assert.equal(manifest.editorPaths, undefined, 'a derived seed carries no editor provenance');
  // The seed bytes are really in this store's CAS.
  const stored = await fx.views.content.read(manifest.entries['add-1.txt'].hash);
  assert.deepEqual(stored, Buffer.from('beta\n'));

  // Exact replay: same attempt and same ordered set -> the SAME durable seed.
  const replay = await fx.views.composeIntegration(scope, refs);
  assert.equal(replay.snapshot.id, composition.snapshot.id);
  assert.equal(replay.snapshot.manifestHash, composition.snapshot.manifestHash);
  // Same attempt, different source set -> refused, never a second seed.
  await assert.rejects(fx.views.composeIntegration(scope, [refs[0]]), error => error.code === 'isolation_conflict');
  const afterReplay = await fx.views.inspect(OWNER, TEAM);
  assert.equal(afterReplay.snapshots.filter(snapshot => snapshot.provenance).length, 1);

  // Internal pins are protected by their deterministic id and their integration
  // metadata, never by a name prefix: a legacy public `integration:` name is
  // still accepted, pins the seed independently, replays exactly, and releases
  // independently while the attempt's own pin and seed remain.
  const internalPin = afterReplay.pins.find(pin => pin.integration?.role === 'seed');
  assert.ok(internalPin, 'the attempt owns a seed pin');
  const namedRequest = {
    ownerId: OWNER, teamId: TEAM, requestId: nextRequest('pin'), name: 'integration:mine',
    resource: { kind: 'snapshot', id: composition.snapshot.id }
  };
  const namedPin = await fx.views.pin(namedRequest);
  assert.notEqual(namedPin.id, internalPin.id, 'a public pin never claims the internal pin id');
  assert.equal(namedPin.integration, undefined, 'a public pin carries no integration identity');
  assert.equal((await fx.views.pin(namedRequest)).id, namedPin.id, 'the same public request replays its acknowledgment');
  assert.equal((await fx.views.inspect(OWNER, TEAM)).pins.some(pin => pin.id === internalPin.id), true,
    'the internal pin survives the public pin');
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('release'), kind: 'pin', id: namedPin.id });
  const independent = await fx.views.inspect(OWNER, TEAM);
  assert.equal(independent.pins.some(pin => pin.id === namedPin.id), false, 'the public named pin releases on its own');
  assert.equal(independent.pins.some(pin => pin.id === internalPin.id), true, 'the internal integration pin is untouched');
  assert.equal(independent.snapshots.some(entry => entry.id === composition.snapshot.id), true, 'the seed stays pinned');
  // The internal identities are still reachable only through the attempt.
  await assert.rejects(
    fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('release'), kind: 'pin', id: internalPin.id }),
    error => error.code === 'isolation_conflict'
  );
  await assert.rejects(
    fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('release'), kind: 'snapshot', id: composition.snapshot.id }),
    error => error.code === 'isolation_conflict'
  );
});

test('different base snapshots cannot be composed for one attempt', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'a.txt'), 'a\n');
  const first = await createSnapshot(fx, 'base-a');
  await fs.writeFile(path.join(fx.root, 'b.txt'), 'b\n');
  const second = await createSnapshot(fx, 'base-b');
  assert.notEqual(first.id, second.id);

  const refs = [];
  for (const [index, snapshot] of [first, second].entries()) {
    const binder = binderOf(`incompatible-${index}`, snapshot.id);
    const binding = await bind(fx, binder);
    await writeFile(fx, binder, binding, `own-${index}.txt`, `own ${index}\n`);
    refs.push(refOf(await sealAt(fx, binder, binding, 'seal', 1)));
  }
  const scope = scopeOf('attempt-incompatible');
  await fx.views.retainIntegrationArtifacts(scope, refs);
  await assert.rejects(fx.views.composeIntegration(scope, refs), error => error.code === 'isolation_conflict');
  assert.equal((await fx.views.inspect(OWNER, TEAM)).snapshots.filter(snapshot => snapshot.provenance).length, 0);
});

test('cleanup retains a manually released source while the attempt still pins it', async t => {
  const { fx, producers } = await compositionFixture(t, ['gamma\n']);
  const scope = scopeOf('attempt-gc');
  const refs = [refOf(producers[0].submission)];
  await fx.views.retainIntegrationArtifacts(scope, refs);
  const composition = await fx.views.composeIntegration(scope, refs);

  // A manual release marks the exact submission released but keeps its data
  // while the attempt's internal pin retains it.
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('release'), kind: 'submission', id: refs[0].id });
  const cleaned = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('cleanup') });
  assert.equal(cleaned.complete, true);
  const kept = await fx.views.inspect(OWNER, TEAM);
  assert.equal(kept.submissions.some(entry => entry.id === refs[0].id), true, 'a pinned source survives GC');
  assert.equal(kept.snapshots.some(entry => entry.id === composition.snapshot.id), true, 'the seed survives GC');
  // The retained bytes are still readable, not merely recorded.
  const bytes = await fx.views.withSubmission(OWNER, TEAM, refs[0].id, async view => view.read('add-0.txt'));
  assert.deepEqual(bytes.bytes, Buffer.from('gamma\n'));

  // Dropping the attempt pins leaves the MANUAL release in charge: the exact
  // released submission and the unreferenced seed are then collected.
  await fx.views.releaseIntegrationArtifacts(scope);
  const left = await fx.views.inspect(OWNER, TEAM);
  assert.equal(left.pins.some(pin => pin.integration?.attemptId === scope.attemptId), false);
  const afterRelease = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('cleanup') });
  assert.equal(afterRelease.complete, true);
  const final = await fx.views.inspect(OWNER, TEAM);
  assert.equal(final.submissions.some(entry => entry.id === refs[0].id), false, 'the manually released source is reclaimed');
  assert.equal(final.snapshots.some(entry => entry.id === composition.snapshot.id), false, 'the unreferenced seed is reclaimed');
  // Idempotent: a second release has nothing left to do.
  await fx.views.releaseIntegrationArtifacts(scope);
});

test('an un-released producer stays readable after its consumer attempt is released and collected', async t => {
  const { fx, base, producers } = await compositionFixture(t, ['zeta\n']);
  const scope = scopeOf('attempt-consumer-release');
  const refs = [refOf(producers[0].submission)];
  await fx.views.retainIntegrationArtifacts(scope, refs);
  const composition = await fx.views.composeIntegration(scope, refs);

  // The durable attempt decision drops its own pins only.
  await fx.views.releaseIntegrationArtifacts(scope);
  const collected = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('cleanup') });
  assert.equal(collected.complete, true);

  const after = await fx.views.inspect(OWNER, TEAM);
  const producer = after.submissions.find(entry => entry.id === refs[0].id);
  assert.ok(producer, 'the producer seal is not retracted by the consumer release');
  assert.equal(producer.released, false, 'no submission released flag is edited by the attempt release');
  assert.equal(after.pins.some(pin => pin.integration?.attemptId === scope.attemptId), false, 'only this attempt\'s pins are dropped');
  assert.equal(after.snapshots.some(entry => entry.id === composition.snapshot.id), false, 'the unreferenced seed falls to normal cleanup');
  assert.equal(after.snapshots.some(entry => entry.id === base.id), true, 'the producer base survives');
  // The producer view is untouched: its exact bytes still read back.
  const read = await fx.views.withSubmission(OWNER, TEAM, refs[0].id, async view => view.read('add-0.txt'));
  assert.deepEqual(read.bytes, Buffer.from('zeta\n'));

  // It also stays a live explicit artifact for a later attempt.
  const later = scopeOf('attempt-consumer-release-2');
  assert.equal((await fx.views.retainIntegrationArtifacts(later, refs))[0].id, refs[0].id);
  const recomposed = await fx.views.composeIntegration(later, refs);
  assert.equal((await seedManifest(fx, recomposed.snapshot)).entries['add-0.txt'].hash, bytesHash('zeta\n'));
});

test('a missing immutable blob fails composition and publishes no seed', async t => {
  const { fx, producers } = await compositionFixture(t, ['delta\n']);
  const scope = scopeOf('attempt-missing');
  const refs = [refOf(producers[0].submission)];
  await fx.views.retainIntegrationArtifacts(scope, refs);

  const blob = await blobPath(fx.storeDir, bytesHash('one\ntwo\nthree\n'));
  assert.equal(typeof blob, 'string', 'the shared base bytes are stored');
  await fs.rm(blob, { force: true });

  await assert.rejects(fx.views.composeIntegration(scope, refs), error => error.code === 'snapshot_content_missing'
    || error.code === 'isolation_unavailable' || error.code === 'not_found');
  assert.equal((await fx.views.inspect(OWNER, TEAM)).snapshots.filter(snapshot => snapshot.provenance).length, 0);
  // Retention itself needs the real revision, so a manifest failure also fails.
  const other = scopeOf('attempt-missing-manifest');
  const manifestBlob = await blobPath(fx.storeDir, (await fx.views.inspect(OWNER, TEAM)).snapshots
    .find(snapshot => snapshot.id === producers[0].submission.snapshotId).manifestHash);
  await fs.rm(manifestBlob, { force: true });
  await assert.rejects(fx.views.retainIntegrationArtifacts(other, refs));
});

test('a seeded worker binds to the derived seed and its candidate is proved by the attempt', async t => {
  const { fx, base, producers } = await compositionFixture(t, ['epsilon\n']);
  const scope = scopeOf('attempt-candidate');
  const refs = [refOf(producers[0].submission)];
  await fx.views.retainIntegrationArtifacts(scope, refs);
  const composition = await fx.views.composeIntegration(scope, refs);

  // A candidate worker binds the PRIVATE seed and sees exactly the merged bytes.
  const candidateBinder = binderOf('candidate-worker', composition.snapshot.id);
  const candidateBinding = await bind(fx, candidateBinder);
  const observed = await fx.views.withView(candidateBinding, candidateBinder.identity, async view => ({
    shared: (await view.read('shared.txt')).bytes.toString('utf8'),
    added: (await view.read('add-0.txt')).bytes.toString('utf8')
  }));
  assert.deepEqual(observed, { shared: 'one\ntwo\nthree\n', added: 'epsilon\n' });

  const candidate = await sealAt(fx, candidateBinder, candidateBinding, 'candidate-seal', 0);
  const candidateRef = refOf(candidate);
  // Not retained by this attempt yet: the candidate identity is unproven.
  await assert.rejects(
    fx.views.withIntegrationCandidate(scope, base.id, candidateRef, async () => 'unreachable'),
    error => error.code === 'isolation_conflict' || error.code === 'not_found'
  );

  await fx.views.retainIntegrationArtifacts(scope, [candidateRef]);
  const seen = await fx.views.withIntegrationCandidate(scope, base.id, candidateRef, async (baseManifest, viewState, submission) => ({
    baseEntry: baseManifest.entries['shared.txt'],
    candidate: viewState.tree.entries['shared.txt'],
    submission: submission.id
  }));
  assert.equal(seen.submission, candidate.id);
  assert.equal(seen.baseEntry.hash, bytesHash('one\ntwo\nthree\n'), 'the ORIGINAL base is offered');
  assert.deepEqual(seen.baseEntry, seen.candidate, 'the candidate did not modify the shared file');

  // A foreign accepted base is refused: the seed names the real one.
  await assert.rejects(
    fx.views.withIntegrationCandidate(scope, id64('other-base'), candidateRef, async () => 'unreachable'),
    error => error.code === 'isolation_conflict'
  );
});

test('manifest editorPaths must be sorted, unique exact captured files', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'a.txt'), 'a\n');
  await fs.writeFile(path.join(fx.root, 'b.txt'), 'b\n');
  const snapshot = await createSnapshot(fx, 'editor-paths');
  const manifest = JSON.parse((await fx.views.content.read(snapshot.manifestHash)).toString('utf8'));
  assert.ok(Array.isArray(manifest.editorPaths), 'capture records the (empty) editor override set');
  assert.deepEqual(fx.views.validateManifest({ ...manifest, editorPaths: ['a.txt'] }).manifest.editorPaths, ['a.txt']);
  assert.deepEqual(fx.views.validateManifest({ ...manifest, editorPaths: [] }).manifest.editorPaths, []);
  // Legacy manifests (no field at all) stay valid.
  const legacy = { ...manifest };
  delete legacy.editorPaths;
  assert.equal(fx.views.validateManifest(legacy).manifest.editorPaths, undefined);
  for (const bad of [['b.txt', 'a.txt'], ['a.txt', 'a.txt'], ['missing.txt'], ['a.txt', 'b.txt', 'a.txt']]) {
    assert.throws(() => fx.views.validateManifest({ ...manifest, editorPaths: bad }), error => error.code === 'isolation_invalid');
  }
});

test('native Git-backed tracked bytes reach the derived seed unchanged', async t => {
  const fleet = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-artifacts-git-'));
  const root = path.join(fleet, 'root');
  const storeDir = path.join(fleet, 'store');
  await fs.mkdir(root);
  gitOk(root, 'init', '-q', '-b', 'main', '.');
  gitOk(root, 'config', 'user.email', 'test@example.com');
  gitOk(root, 'config', 'user.name', 'Test User');
  gitOk(root, 'config', 'core.autocrlf', 'false');
  const views = new IsolatedViews(storeDir, root);
  await views.open();
  t.after(async () => {
    await views.close();
    await fs.rm(fleet, { recursive: true, force: true });
  });
  const fx = { base: fleet, root, storeDir, views };
  const raw = 'tracked raw\r\nsecond line\n';
  await fs.writeFile(path.join(root, 'raw.txt'), raw);
  await fs.writeFile(path.join(root, 'plain.txt'), 'plain\n');
  gitOk(root, 'add', 'raw.txt', 'plain.txt');
  gitOk(root, 'commit', '-q', '-m', 'one');

  const base = await createSnapshot(fx, 'git-base');
  assert.equal(base.backing.kind, 'git', 'the captured base is Git-backed');
  const rawHash = bytesHash(raw);
  assert.equal(Object.hasOwn(base.backing.blobs, rawHash), true, 'the native Git backing owns the tracked raw bytes');
  assert.equal(await views.content.has(rawHash), false, 'this store does not hold them yet');

  const binder = binderOf('git-producer', base.id);
  const binding = await bind(fx, binder);
  await writeFile(fx, binder, binding, 'add.txt', 'added\n');
  const ref = refOf(await sealAt(fx, binder, binding, 'seal', 1));
  const scope = scopeOf('attempt-git');
  await views.retainIntegrationArtifacts(scope, [ref]);
  const composition = await views.composeIntegration(scope, [ref]);

  const manifest = await seedManifest(fx, composition.snapshot);
  const baseManifest = JSON.parse((await views.content.read(base.manifestHash)).toString('utf8'));
  assert.equal(manifest.entries['raw.txt'].hash, rawHash, 'raw tracked bytes are hashed, never filtered or transcoded');
  assert.deepEqual(manifest.entries['raw.txt'], baseManifest.entries['raw.txt'], 'hash, size and mode are preserved exactly');
  // The seed can serve those bytes from its own CAS, so a worker needs no Git.
  assert.deepEqual(await views.content.read(rawHash), Buffer.from(raw));
  const seeded = binderOf('git-seeded', composition.snapshot.id);
  const seededBinding = await bind(fx, seeded);
  const served = await views.withView(seededBinding, seeded.identity, view => view.read('raw.txt'));
  assert.deepEqual(served.bytes, Buffer.from(raw), 'the seeded worker reads the unchanged tracked bytes');
});

test('a verifier refusal publishes no integration pin and sees only exact copies', async t => {
  const { fx, producers } = await compositionFixture(t, ['theta\n']);
  const scope = scopeOf('attempt-verifier');
  const refs = [refOf(producers[0].submission)];
  let offered;
  await assert.rejects(
    fx.views.retainIntegrationArtifacts(scope, refs, undefined, async submissions => {
      offered = submissions;
      throw Object.assign(new Error('wrong base or lane for this candidate'), { code: 'candidate_mismatch' });
    }),
    error => error.code === 'candidate_mismatch'
  );
  assert.deepEqual(offered.map(entry => entry.id), [refs[0].id], 'the verifier sees exactly the proven seals');
  assert.equal(offered[0].uri, refs[0].uri);
  // The verifier receives copies: mutating them can never edit store state.
  offered[0].uri = 'codex-subagent://submission/forged/0/1';
  const refused = await fx.views.inspect(OWNER, TEAM);
  assert.equal(refused.pins.some(pin => pin.integration?.attemptId === scope.attemptId), false, 'a refusal publishes no pin');
  assert.equal(refused.submissions.find(entry => entry.id === refs[0].id).uri, refs[0].uri, 'the stored seal is untouched');

  // The same exact request is retained once the verifier accepts it.
  const accepted = await fx.views.retainIntegrationArtifacts(scope, refs, undefined, async submissions => {
    assert.deepEqual(submissions.map(entry => entry.id), [refs[0].id]);
  });
  assert.deepEqual(accepted.map(entry => entry.id), [refs[0].id]);
  const published = await fx.views.inspect(OWNER, TEAM);
  assert.equal(published.pins.filter(pin => pin.integration?.attemptId === scope.attemptId
    && pin.integration.role === 'source').length, 1);
});

test('nested ancestry keeps the baseline and intermediate seeds while a descendant lives', async t => {
  const { fx, base, producers } = await compositionFixture(t, ['merged\n']);
  const outer = scopeOf('attempt-nested-outer');
  const outerRefs = [refOf(producers[0].submission)];
  await fx.views.retainIntegrationArtifacts(outer, outerRefs);
  const outerSeed = (await fx.views.composeIntegration(outer, outerRefs)).snapshot;

  // The outer sources are sealed over the ORDINARY capture: it is the root of
  // the lineage and is never listed as an ancestor.
  assert.deepEqual(await fx.views.integrationSourceAncestry(outer, outerRefs), { sourceSnapshotId: base.id, ancestors: [] });

  // A nested producer seals over the intermediate seed.
  const nestedBinder = binderOf('nested-producer', outerSeed.id);
  const nestedBinding = await bind(fx, nestedBinder);
  await writeFile(fx, nestedBinder, nestedBinding, 'nested.txt', 'nested\n');
  const nestedRef = refOf(await sealAt(fx, nestedBinder, nestedBinding, 'seal', 1));
  const inner = scopeOf('attempt-nested-inner');
  await fx.views.retainIntegrationArtifacts(inner, [nestedRef]);
  const ancestry = await fx.views.integrationSourceAncestry(inner, [nestedRef]);
  assert.equal(ancestry.sourceSnapshotId, outerSeed.id, 'the shared immediate base is the intermediate seed');
  assert.equal(ancestry.ancestors.length, 1);
  assert.equal(ancestry.ancestors[0].snapshotId, outerSeed.id);
  assert.deepEqual(ancestry.ancestors[0].provenance, outerSeed.provenance, 'exact native provenance is returned');
  assert.equal(ancestry.ancestors[0].provenance.baseSnapshotId, base.id);
  // Copies, never aliases: a caller cannot edit stored ancestry.
  ancestry.ancestors[0].provenance.refs[0].uri = 'forged';
  assert.deepEqual((await fx.views.integrationSourceAncestry(inner, [nestedRef])).ancestors[0].provenance, outerSeed.provenance);

  const innerSeed = (await fx.views.composeIntegration(inner, [nestedRef])).snapshot;
  assert.equal(innerSeed.provenance.baseSnapshotId, outerSeed.id, 'the nested seed names the intermediate seed');

  // A candidate sealed over the INNER seed is checked against the ORIGINAL
  // capture, never against a private intermediate composition.
  const candidateBinder = binderOf('nested-candidate', innerSeed.id);
  const candidateBinding = await bind(fx, candidateBinder);
  await writeFile(fx, candidateBinder, candidateBinding, 'nested.txt', 'nested fixed\n');
  const candidateRef = refOf(await sealAt(fx, candidateBinder, candidateBinding, 'candidate', 1));
  await fx.views.retainIntegrationArtifacts(inner, [candidateRef]);
  const seen = await fx.views.withIntegrationCandidate(inner, outerSeed.id, candidateRef, async (baseManifest, candidate, submission) => ({
    base: baseManifest,
    nestedBytes: candidate.tree.entries['nested.txt'].size,
    id: submission.id
  }));
  assert.equal(seen.id, candidateRef.id);
  assert.equal(seen.nestedBytes, Buffer.byteLength('nested fixed\n'));
  assert.equal(seen.base.entries['nested.txt'], undefined, 'the baseline is the oldest ordinary capture');
  assert.equal(seen.base.entries['add-0.txt'], undefined, 'no intermediate merged file reaches the baseline');
  assert.deepEqual(seen.base.editorPaths, [], 'editor origin still comes from the root capture');
  // The intermediate seed is NOT an acceptable publication base here.
  await assert.rejects(
    fx.views.withIntegrationCandidate(inner, base.id, candidateRef, async () => 'unreachable'),
    error => error.code === 'isolation_conflict'
  );

  // Releasing the outer attempt keeps its intermediate seed: a descendant's
  // stored ancestry still roots it, and its manifest bytes stay readable.
  await fx.views.releaseIntegrationArtifacts(outer);
  const kept = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('cleanup') });
  assert.equal(kept.complete, true);
  const live = await fx.views.inspect(OWNER, TEAM);
  assert.equal(live.snapshots.some(entry => entry.id === outerSeed.id), true, 'the intermediate seed is rooted by its descendant');
  assert.equal(live.snapshots.some(entry => entry.id === base.id), true, 'the captured baseline survives');
  const outerManifest = await seedManifest(fx, outerSeed);
  assert.equal(outerManifest.entries['add-0.txt'].hash, bytesHash('merged\n'));
  const shared = await fx.views.content.read(outerManifest.entries['shared.txt'].hash);
  assert.equal(shared.toString('utf8'), 'one\ntwo\nthree\n');

  // Dropping every explicit seal, the creation pin of the baseline and the
  // producer views makes the whole chain collectable.
  await fx.views.releaseIntegrationArtifacts(inner);
  for (const ref of [...outerRefs, nestedRef, candidateRef]) {
    await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('release'), kind: 'submission', id: ref.id });
  }
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('release'), kind: 'snapshot', id: base.id });
  const swept = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('cleanup') }, async () => ({ state: 'missing' }));
  assert.equal(swept.complete, true);
  const gone = await fx.views.inspect(OWNER, TEAM);
  assert.deepEqual(gone.snapshots, [], 'the unreferenced chain, including the baseline, is collectable');
  assert.deepEqual(gone.submissions, [], 'the released producer seals are collectable');
});

test('a legacy lineage hole fails closed and leaves unrelated cleanup possible', async t => {
  const { fx, base, producers } = await compositionFixture(t, ['hole\n']);
  const outer = scopeOf('attempt-hole-outer');
  const outerRefs = [refOf(producers[0].submission)];
  await fx.views.retainIntegrationArtifacts(outer, outerRefs);
  const outerSeed = (await fx.views.composeIntegration(outer, outerRefs)).snapshot;
  const nestedBinder = binderOf('hole-producer', outerSeed.id);
  const nestedBinding = await bind(fx, nestedBinder);
  await writeFile(fx, nestedBinder, nestedBinding, 'nested.txt', 'nested\n');
  const nestedRef = refOf(await sealAt(fx, nestedBinder, nestedBinding, 'seal', 1));
  const inner = scopeOf('attempt-hole-inner');
  await fx.views.retainIntegrationArtifacts(inner, [nestedRef]);
  const innerSeed = (await fx.views.composeIntegration(inner, [nestedRef])).snapshot;

  // An UNRELATED producer stays live: its chain must still be answered after
  // the hole appears, and that answer needs no live workspace lookup.
  const unrelatedBinder = binderOf('hole-unrelated', base.id);
  const unrelatedBinding = await bind(fx, unrelatedBinder);
  await writeFile(fx, unrelatedBinder, unrelatedBinding, 'other.txt', 'other\n');
  const unrelatedRef = refOf(await sealAt(fx, unrelatedBinder, unrelatedBinding, 'seal', 1));

  // LEGACY HOLE: a stored intermediate seed whose own parent record is gone.
  // The unrelated outer seal is released so its later collection is observable.
  await fx.views.releaseIntegrationArtifacts(outer);
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('release'), kind: 'submission', id: outerRefs[0].id });
  await fx.views.close();
  const indexPath = path.join(fx.storeDir, 'index.json');
  const document = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  document.snapshots[outerSeed.id].provenance.baseSnapshotId = id64('gone-base');
  await fs.writeFile(indexPath, JSON.stringify(document));
  const reopened = new IsolatedViews(fx.storeDir, fx.root);
  await reopened.open();
  t.after(async () => {
    await reopened.close();
  });

  // Lineage reasoning fails closed on the hole, with no live lookup ...
  await assert.rejects(
    reopened.integrationSourceAncestry(inner, [nestedRef]),
    error => error.code === 'isolation_corrupt' && /missing snapshot/.test(error.message)
  );
  // ... while an unrelated chain is still answered exactly.
  assert.deepEqual(await reopened.integrationSourceAncestry(inner, [unrelatedRef]), { sourceSnapshotId: base.id, ancestors: [] });

  // Cleanup never consults live files for the hole and never strands the
  // unrelated artifacts around it.
  const cleaned = await reopened.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('cleanup') });
  assert.equal(cleaned.complete, true, 'a legacy hole never blocks cleanup');
  const after = await reopened.inspect(OWNER, TEAM);
  assert.equal(after.submissions.some(entry => entry.id === outerRefs[0].id), false, 'the unrelated released seal is collectable');
  assert.equal(after.snapshots.some(entry => entry.id === outerSeed.id), true, 'the descendant base is retained');
  assert.equal(after.snapshots.some(entry => entry.id === innerSeed.id), true, 'the pinned descendant survives');
  await assert.rejects(
    reopened.integrationSourceAncestry(inner, [nestedRef]),
    error => error.code === 'isolation_corrupt'
  );
  // A composed base that is itself a derived seed proves its stored lineage
  // FIRST: a known legacy hole yields NO new derived seed for a fresh attempt
  // instead of an attempt that would only strand itself in applying.
  const holedFx = { ...fx, views: reopened };
  const holedBinder = binderOf('hole-compose-source', outerSeed.id);
  const holedBinding = await bind(holedFx, holedBinder);
  await writeFile(holedFx, holedBinder, holedBinding, 'holed.txt', 'holed\n');
  const holedRef = refOf(await sealAt(holedFx, holedBinder, holedBinding, 'seal', 1));
  const holedScope = scopeOf('attempt-hole-compose');
  await reopened.retainIntegrationArtifacts(holedScope, [holedRef]);
  await assert.rejects(
    reopened.composeIntegration(holedScope, [holedRef]),
    error => error.code === 'isolation_corrupt'
  );
  assert.equal((await reopened.inspect(OWNER, TEAM)).snapshots.some(entry => entry.provenance?.attemptId === holedScope.attemptId), false,
    'a holed lineage yields no derived seed');

  // A stored cycle between the two derived snapshots is refused as corrupt. A
  // corrupted link can fail as NONCANONICAL (a seed this store never composed)
  // before the cycle itself is reached, so either diagnosis is accepted: the
  // point is that no answer is ever fabricated.
  await reopened.close();
  const cyclic = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  cyclic.snapshots[outerSeed.id].provenance.baseSnapshotId = innerSeed.id;
  cyclic.snapshots[innerSeed.id].provenance.baseSnapshotId = outerSeed.id;
  await fs.writeFile(indexPath, JSON.stringify(cyclic));
  const circling = new IsolatedViews(fx.storeDir, fx.root);
  await circling.open();
  t.after(async () => {
    await circling.close();
  });
  await assert.rejects(
    circling.integrationSourceAncestry(inner, [nestedRef]),
    error => error.code === 'isolation_corrupt' && /cycle|canonical/.test(error.message)
  );

  // A FOREIGN legacy link is skipped by retention edges: unrelated cleanup still
  // completes and another owner record is never deleted by this scope.
  await circling.close();
  const foreignDocument = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const foreignId = id64('foreign-base');
  foreignDocument.snapshots[outerSeed.id].provenance.baseSnapshotId = base.id;
  foreignDocument.snapshots[innerSeed.id].provenance.baseSnapshotId = foreignId;
  foreignDocument.snapshots[foreignId] = {
    id: foreignId, teamId: TEAM, ownerId: 'owner-foreign', manifestHash: base.manifestHash,
    backing: { kind: 'cas' }, createdAt: DATE
  };
  await fs.writeFile(indexPath, JSON.stringify(foreignDocument));
  const foreign = new IsolatedViews(fx.storeDir, fx.root);
  await foreign.open();
  t.after(async () => {
    await foreign.close();
  });
  const foreignCleanup = await foreign.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: nextRequest('cleanup') });
  assert.equal(foreignCleanup.complete, true, 'a foreign legacy link never blocks cleanup');
  const foreignLeft = await foreign.inspect(OWNER, TEAM);
  assert.equal(foreignLeft.snapshots.some(entry => entry.id === innerSeed.id), true, 'the pinned descendant survives a foreign link');
  const rawIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.equal(Object.hasOwn(rawIndex.snapshots, foreignId), true, 'the foreign record is never deleted by this scope');
});

test('a replaced native blob is never materialized while surviving native and synthesized bytes are', async t => {
  const fx = await gitFixture(t, 'git-replace');
  const mergedBase = 'left\nmiddle\nright\n';
  const replacedBase = 'native replacement victim\n';
  const keptRaw = 'kept native\r\nsecond line\n';
  const deletedBase = 'native deletion victim\n';
  for (const [file, text] of [['merge.txt', mergedBase], ['replaced.txt', replacedBase],
    ['kept.txt', keptRaw], ['deleted.txt', deletedBase]]) {
    await fs.writeFile(path.join(fx.root, file), text);
  }
  gitOk(fx.root, 'add', '-A');
  gitOk(fx.root, 'commit', '-q', '-m', 'base');

  const base = await createSnapshot(fx, 'git-replace-base');
  assert.equal(base.backing.kind, 'git', 'the captured base is Git-backed');
  const mergedBaseHash = bytesHash(mergedBase);
  const replacedBaseHash = bytesHash(replacedBase);
  const keptHash = bytesHash(keptRaw);
  const deletedHash = bytesHash(deletedBase);
  for (const hash of [mergedBaseHash, replacedBaseHash, keptHash, deletedHash]) {
    assert.equal(Object.hasOwn(base.backing.blobs, hash), true, 'the native backing owns the tracked bytes');
    assert.equal(await fx.views.content.has(hash), false, 'this store does not hold them yet');
  }

  // One producer rewrites two different native lines (a REAL synthesized
  // merge), replaces another native file whole and deletes a third.
  const left = binderOf('git-replace-left', base.id);
  const leftBinding = await bind(fx, left);
  await writeFile(fx, left, leftBinding, 'merge.txt', 'LEFT\nmiddle\nright\n');
  await writeFile(fx, left, leftBinding, 'replaced.txt', 'producer bytes\n');
  const removed = await fx.views.edit(leftBinding, left.identity, async () => ({ 'deleted.txt': null }));
  const leftRef = refOf(await sealAt(fx, left, leftBinding, 'seal', removed.revision));
  // A second producer edits the OTHER line of the same native file.
  const right = binderOf('git-replace-right', base.id);
  const rightBinding = await bind(fx, right);
  await writeFile(fx, right, rightBinding, 'merge.txt', 'left\nmiddle\nRIGHT\n');
  const rightRef = refOf(await sealAt(fx, right, rightBinding, 'seal', 1));

  const scope = scopeOf('attempt-git-replace');
  const refs = [leftRef, rightRef];
  await fx.views.retainIntegrationArtifacts(scope, refs);
  const composition = await fx.views.composeIntegration(scope, refs);

  const manifest = await seedManifest(fx, composition.snapshot);
  const synthesizedHash = bytesHash('LEFT\nmiddle\nRIGHT\n');
  assert.equal(manifest.entries['merge.txt'].hash, synthesizedHash, 'the merged bytes are synthesized');
  assert.equal(manifest.entries['replaced.txt'].hash, bytesHash('producer bytes\n'));
  assert.equal(manifest.entries['kept.txt'].hash, keptHash, 'the surviving native bytes keep their full hash');
  assert.equal(manifest.entries['deleted.txt'], undefined, 'the deleted native file is gone');
  // EOL, size and mode of the surviving native entry are the captured ones.
  const baseManifest = JSON.parse((await fx.views.content.read(base.manifestHash)).toString('utf8'));
  assert.deepEqual(manifest.entries['kept.txt'], baseManifest.entries['kept.txt']);
  assert.equal(manifest.entries['kept.txt'].size, Buffer.byteLength(keptRaw));

  // The derived seed is COMPLETE in this store's CAS ...
  assert.deepEqual(await fx.views.content.read(synthesizedHash), Buffer.from('LEFT\nmiddle\nRIGHT\n'));
  assert.deepEqual(await fx.views.content.read(keptHash), Buffer.from(keptRaw));
  // ... and no native blob the final seed does not reference was materialized.
  for (const unused of [mergedBaseHash, replacedBaseHash, deletedHash]) {
    assert.equal(await fx.views.content.has(unused), false, 'an unused native blob is never copied');
    assert.equal(await blobPath(fx.storeDir, unused), undefined, 'and no CAS file exists for it');
  }
  // A seeded worker reads both kinds through the seed alone, never through Git.
  const seeded = binderOf('git-replace-seeded', composition.snapshot.id);
  const seededBinding = await bind(fx, seeded);
  const served = await fx.views.withView(seededBinding, seeded.identity, async view => ({
    merged: (await view.read('merge.txt')).bytes.toString('utf8'),
    kept: (await view.read('kept.txt')).bytes.toString('utf8')
  }));
  assert.deepEqual(served, { merged: 'LEFT\nmiddle\nRIGHT\n', kept: keptRaw });
});

test('composition writes each distinct payload hash once and never a replaced native blob', async t => {
  const fx = await gitFixture(t, 'git-once');
  const sharedRaw = 'same native bytes\r\nshared\n';
  const goneRaw = 'native bytes that disappear\n';
  await fs.writeFile(path.join(fx.root, 'dup-a.txt'), sharedRaw);
  await fs.writeFile(path.join(fx.root, 'dup-b.txt'), sharedRaw);
  await fs.writeFile(path.join(fx.root, 'gone.txt'), goneRaw);
  gitOk(fx.root, 'add', '-A');
  gitOk(fx.root, 'commit', '-q', '-m', 'base');

  const base = await createSnapshot(fx, 'git-once-base');
  assert.equal(base.backing.kind, 'git', 'the captured base is Git-backed');
  const sharedHash = bytesHash(sharedRaw);
  const goneHash = bytesHash(goneRaw);
  assert.equal(Object.hasOwn(base.backing.blobs, sharedHash), true, 'two paths share one native blob');
  assert.equal(await fx.views.content.has(sharedHash), false, 'this store does not hold it yet');

  const binder = binderOf('git-once-producer', base.id);
  const binding = await bind(fx, binder);
  await writeFile(fx, binder, binding, 'gone.txt', 'producer replacement\n');
  const ref = refOf(await sealAt(fx, binder, binding, 'seal', 1));
  const scope = scopeOf('attempt-git-once');
  await fx.views.retainIntegrationArtifacts(scope, [ref]);

  const writes = recordWrites(fx.views);
  const composition = await fx.views.composeIntegration(scope, [ref]);
  const count = hash => writes.filter(entry => entry.hash === hash).length;
  assert.equal(count(sharedHash), 1, 'one distinct native payload is copied once, even for two paths');
  assert.equal(count(goneHash), 0, 'a native payload the seed does not reference is never written');
  assert.equal(count(composition.snapshot.manifestHash), 1, 'the seed manifest is written once');
  assert.equal(writes.length, 2, 'the composition writes exactly the surviving payload and its manifest');

  const manifest = await seedManifest(fx, composition.snapshot);
  assert.equal(manifest.entries['dup-a.txt'].hash, sharedHash);
  assert.equal(manifest.entries['dup-b.txt'].hash, sharedHash);
  assert.deepEqual(await fx.views.content.read(sharedHash), Buffer.from(sharedRaw));
});

test('a conflicted derived base is composable only through its exact accepted resolution seal', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'shared.txt'), 'base line\n');
  const base = await createSnapshot(fx, 'conflict-base');
  const produce = async (label, content) => {
    const binder = binderOf(label, base.id);
    const binding = await bind(fx, binder);
    await writeFile(fx, binder, binding, 'shared.txt', content);
    return { binder, binding, ref: refOf(await sealAt(fx, binder, binding, 'seal', 1)) };
  };
  // Two producers rewrite the SAME line differently: a real merge conflict.
  const left = await produce('conflict-left', 'left line\n');
  const right = await produce('conflict-right', 'right line\n');
  const conflicted = scopeOf('attempt-conflict');
  const refs = [left.ref, right.ref];
  await fx.views.retainIntegrationArtifacts(conflicted, refs);
  // A conflict-free (ordinary) base still composes with NO verifier at all.
  const composition = await fx.views.composeIntegration(conflicted, refs);
  assert.equal(composition.conflicts.length, 1);
  assert.deepEqual(composition.conflicts[0].paths, ['shared.txt']);
  const seed = composition.snapshot;
  assert.equal(seed.provenance.conflicts.length, 1);
  // A conflict is never a merged result: the base entry is preserved.
  const seededManifest = await seedManifest(fx, seed);
  assert.equal(seededManifest.entries['shared.txt'].hash, bytesHash('base line\n'));

  // The conflicted seed is not ordinary work: ONLY its governed integration-lane
  // startup may bind it, and that identity comes from the host, never the request.
  const work = binderOf('conflict-work', seed.id);
  await assert.rejects(fx.views.bind(work.input(nextRequest('bind')), async () => {}),
    error => error.code === 'isolation_conflict');
  await assert.rejects(fx.views.bind(work.input(nextRequest('bind')), async () => {}, undefined,
    { teamId: TEAM, snapshotId: seed.id, lane: 'work' }), error => error.code === 'isolation_conflict');
  await assert.rejects(fx.views.bind(work.input(nextRequest('bind')), async () => {}, undefined,
    { teamId: TEAM, snapshotId: seed.id, lane: 'validation' }), error => error.code === 'isolation_conflict');
  // The startup identity must name exactly this team AND snapshot.
  await assert.rejects(fx.views.bind(work.input(nextRequest('bind')), async () => {}, undefined,
    { teamId: TEAM, snapshotId: base.id, lane: 'integration' }), error => error.code === 'isolation_conflict');
  // The narrow preflight answers the same rule before any board assignment,
  // scoped by owner AND team: another owner's snapshot is a plain no-op here
  // because the bind itself owns the owner/team scope check.
  await assert.rejects(fx.views.assertStartupBindable(OWNER, TEAM, seed.id, 'work'),
    error => error.code === 'isolation_conflict');
  await assert.rejects(fx.views.assertStartupBindable(OWNER, TEAM, seed.id, 'validation'),
    error => error.code === 'isolation_conflict');
  assert.equal(await fx.views.assertStartupBindable(OWNER, TEAM, seed.id, 'integration'), undefined);
  assert.equal(await fx.views.assertStartupBindable(OWNER, TEAM, base.id, 'work'), undefined, 'ordinary captures stay bindable by any lane');
  assert.equal(await fx.views.assertStartupBindable('owner-foreign', TEAM, seed.id, 'work'), undefined,
    'a foreign owner scope is never refused by the preflight');
  assert.equal(await fx.views.assertStartupBindable(OWNER, id32('other-team'), seed.id, 'work'), undefined,
    'and neither is a foreign team');
  // An ordinary snapshot still binds with NO startup identity at all.
  await bind(fx, binderOf('conflict-clean', base.id));

  // Its governed integration-lane startup resolves the conflict and seals it.
  const resolver = binderOf('conflict-resolver', seed.id);
  const resolverBinding = await bind(fx, resolver, { teamId: TEAM, snapshotId: seed.id, lane: 'integration' });
  await writeFile(fx, resolver, resolverBinding, 'shared.txt', 'resolved line\n');
  const resolution = refOf(await sealAt(fx, resolver, resolverBinding, 'resolution', 1));
  const publishing = scopeOf('attempt-conflict-resolution');
  await fx.views.retainIntegrationArtifacts(publishing, [resolution]);

  // FAIL CLOSED: this ancestry has unresolved conflict groups and no verifier.
  const writes = recordWrites(fx.views);
  await assert.rejects(fx.views.composeIntegration(publishing, [resolution]),
    error => error.code === 'isolation_conflict');
  // A verifier that cannot prove the resolution (an unaccepted or unrelated
  // seal) writes nothing either: the proof runs BEFORE any composed write.
  const offered = [];
  await assert.rejects(fx.views.composeIntegration(publishing, [resolution], undefined, async chain => {
    offered.push(chain);
    throw Object.assign(new Error('not the accepted resolution'), { code: 'ancestry_unresolved' });
  }), error => error.code === 'ancestry_unresolved');
  assert.equal(offered.length, 1);
  assert.equal(offered[0].length, 1, 'exactly the ONE conflicted hop is offered');
  assert.equal(offered[0][0].snapshotId, seed.id);
  assert.deepEqual(offered[0][0].provenance, seed.provenance, 'the exact stored provenance is offered');
  assert.deepEqual(offered[0][0].refs, [resolution], 'the hop carries this selection\'s exact refs');
  assert.deepEqual(writes, [], 'no composed payload byte was written before the proof');
  // Copies, never aliases: a verifier cannot edit stored provenance.
  offered[0][0].provenance.refs[0].uri = 'forged';
  const stored = (await fx.views.inspect(OWNER, TEAM)).snapshots.find(entry => entry.id === seed.id);
  assert.deepEqual(stored.provenance, seed.provenance);

  // With the ledger's exact proof the composition proceeds over that base.
  const resolved = await fx.views.composeIntegration(publishing, [resolution], undefined, async chain => {
    assert.equal(chain.length, 1);
    assert.equal(chain[0].snapshotId, seed.id);
    assert.deepEqual(chain[0].refs, [resolution]);
  });
  assert.equal(resolved.baseSnapshotId, seed.id, 'the resolved seal is consumed over the conflicted seed');
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.snapshot.provenance.refs, [resolution]);
  assert.equal(resolved.snapshot.provenance.baseSnapshotId, seed.id);
  const resolvedManifest = await seedManifest(fx, resolved.snapshot);
  assert.equal(resolvedManifest.entries['shared.txt'].hash, bytesHash('resolved line\n'));
  // The NEW derived seed is conflict-free, so its own consumers are ordinary.
  assert.deepEqual(resolved.snapshot.provenance.conflicts, []);
  const consumer = binderOf('conflict-consumer', resolved.snapshot.id);
  const consumerBinding = await bind(fx, consumer);
  const read = await fx.views.withView(consumerBinding, consumer.identity, view => view.read('shared.txt'));
  assert.equal(read.bytes.toString('utf8'), 'resolved line\n', 'the resolved bytes are the ones served');
});
