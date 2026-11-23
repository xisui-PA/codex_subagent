const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Loader: STEP5_TEST_BUILD names a dedicated compile, otherwise the repository
// .test-build that npm test produces on a clean checkout.
const BUILD = path.resolve(__dirname, '..', process.env.STEP5_TEST_BUILD?.trim() || '.test-build');
const { IntegrationAttempts, integrationActionSchema } = require(path.join(BUILD, 'integration-attempts'));
const { WorkerError } = require(path.join(BUILD, 'types'));
// The transport regression drives the REAL BridgeHost/forward path, so every
// request is measured exactly as the relay builds it (1,000,000-byte cap).
const { BridgeHost, forward } = require(path.join(BUILD, 'bridge'));

const OWNER = 'coordinator-1';
const ROOT = 'C:\\workspace\\project';
const TEAM = '1'.repeat(32);
const TASK_A = 'a0'.repeat(16);
const TASK_B = 'b0'.repeat(16);
const TASK_C = 'c0'.repeat(16);
const BASE = 'ba'.repeat(32);
const OTHER_BASE = 'bb'.repeat(32);
const WORKER_A = 'aa'.repeat(16);
const WORKER_B = 'ab'.repeat(16);
const WORKER_V = 'ac'.repeat(16);
const WORKER_I = 'ad'.repeat(16);
const CREATED = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-02T00:00:00.000Z';
const SEED_A = 'da'.repeat(32);
const SEED_B = 'db'.repeat(32);
const ART_A = { id: 'a1'.repeat(32), version: 1, uri: 'submission://artifact-a/1' };
const ART_A2 = { id: 'a2'.repeat(32), version: 2, uri: 'submission://artifact-a/2' };
const ART_B = { id: 'b1'.repeat(32), version: 1, uri: 'submission://artifact-b/1' };
const ART_C = { id: 'c1'.repeat(32), version: 1, uri: 'submission://candidate-c/1' };
const ART_C2 = { id: 'c2'.repeat(32), version: 2, uri: 'submission://candidate-c/2' };
const EV_A = { id: 'e1'.repeat(16), version: 1, uri: 'runner://result-a/1' };
const EV_B = { id: 'e2'.repeat(16), version: 1, uri: 'runner://result-b/1' };
const EV_V = { id: 'e3'.repeat(16), version: 1, uri: 'runner://result-v/1' };

const refKey = ref => `${ref.id}:${ref.version}:${ref.uri}`;

// ---------------------------------------------------------------------------
// Reloaded lineage proof.
//
// The real reproduction: an OLD store durably wrote a ready attempt after a work
// worker sealed over a CONFLICTED consumer seed. A reloaded broker could then
// validate/accept that record with resolvedPaths=[] and apply it, because the
// ancestry proof was only reachable from a fresh begin (compose). These fixtures
// keep an unresolved conflicted seed (S), a clean seed composed over it (W) and
// an attempt composed over W (T), so a DEEPER conflict is re-proved from the
// source ancestry port on reload.
// ---------------------------------------------------------------------------

const ART_C3 = { id: 'c3'.repeat(32), version: 3, uri: 'submission://candidate-c/3' };
const ART_C4 = { id: 'c4'.repeat(32), version: 4, uri: 'submission://candidate-c/4' };
const ART_C5 = { id: 'c5'.repeat(32), version: 5, uri: 'submission://candidate-c/5' };
const WORKER_J = 'ae'.repeat(16);
const WORKER_K = 'af'.repeat(16);

async function lineageHarness(t, options = {}) {
  const control = { ancestry: { sourceSnapshotId: SEED_B, ancestors: [] } };
  const h = await harness(t, {
    tasks: [
      task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, state: 'accepted', revision: 3 }),
      task(TASK_B, {
        candidates: [ART_B],
        assigneeWorkerId: WORKER_B,
        state: 'accepted',
        revision: 4,
        dependencies: [{ taskId: TASK_A, kind: 'artifact' }]
      }),
      task(TASK_C, {
        candidates: [ART_C2, ART_C3],
        assigneeWorkerId: WORKER_I,
        state: 'accepted',
        revision: 5,
        title: 'Resolution outputs'
      })
    ],
    sessions: [
      session(WORKER_A),
      session(WORKER_B),
      session(WORKER_V, { lane: 'validation' }),
      session(WORKER_I, { lane: 'integration', snapshotId: SEED_C }),
      session(WORKER_J, { lane: 'integration', snapshotId: SEED_A }),
      session(WORKER_K, { lane: 'integration', snapshotId: SEED_B })
    ],
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A, snapshotId: BASE } },
      { ref: ART_B, options: { workerId: WORKER_B, snapshotId: BASE } },
      { ref: ART_C2, options: { workerId: WORKER_I, snapshotId: SEED_C, revision: 2 } },
      { ref: ART_C3, options: { workerId: WORKER_I, snapshotId: SEED_B, revision: 2 } },
      { ref: ART_C4, options: { workerId: WORKER_J, snapshotId: SEED_A, revision: 2 } },
      { ref: ART_C5, options: { workerId: WORKER_K, snapshotId: SEED_B, revision: 2 } }
    ],
    publishFailures: options.publishFailures ?? 0,
    publishStates: options.publishStates ?? [],
    conflictChain: () => [],
    ancestry: () => control.ancestry,
    composition: refs => {
      if (refs.length === 2) {
        return { snapshot: { id: SEED_C }, baseSnapshotId: BASE, conflicts: [CONFLICT] };
      }
      if (refs[0].id === ART_C2.id) {
        return { snapshot: { id: SEED_B }, baseSnapshotId: SEED_C, conflicts: [] };
      }
      return { snapshot: { id: SEED_A }, baseSnapshotId: SEED_B, conflicts: [] };
    }
  });
  return { h, control, service: h.open() };
}

/** The conflicted seed (S) sits BELOW the immediate base (W's clean seed). */
const reloadChain = (seedId, cleanId) => ({
  sourceSnapshotId: SEED_B,
  ancestors: [
    {
      snapshotId: SEED_B,
      provenance: {
        kind: 'integration-seed', attemptId: cleanId, baseSnapshotId: SEED_C,
        refs: [{ ...ART_C2 }], conflicts: []
      }
    },
    {
      snapshotId: SEED_C,
      provenance: {
        kind: 'integration-seed', attemptId: seedId, baseSnapshotId: BASE,
        refs: [{ ...ART_A }, { ...ART_B }], conflicts: [CONFLICT]
      }
    }
  ]
});

async function lineageAttempts(service) {
  const seed = await begin(service, {
    requestId: 'begin-seed',
    sources: [
      { taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] },
      { taskId: TASK_B, taskRevision: 4, artifact: ART_B, evidence: [EV_B] }
    ]
  });
  const clean = await begin(service, {
    requestId: 'begin-clean',
    sources: [{ taskId: TASK_C, taskRevision: 5, artifact: ART_C2, evidence: [EV_V] }]
  });
  return { seed, clean };
}

const downstreamArgs = requestId => beginArgs({
  requestId,
  sources: [{ taskId: TASK_C, taskRevision: 5, artifact: ART_C3, evidence: [EV_V] }]
});

async function advanceDownstream(service, attempt, to) {
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: attempt.attemptId };
  let current = attempt;
  if (to === 'ready') {
    return current;
  }
  current = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: current.revision, requestId: 'cand-1', artifact: ART_C4
  }, authorize);
  if (to === 'candidate') {
    return current;
  }
  current = await service.invoke({
    ...controls, action: 'validate', expectedRevision: current.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  if (to === 'validated') {
    return current;
  }
  return service.invoke({
    ...controls, action: 'accept', expectedRevision: current.revision, requestId: 'accept-1'
  }, authorize);
}

/** Re-open a store whose ledger was written BEFORE the ancestry marker existed. */
async function withoutAncestryProof(h, service, mutate) {
  await service.close();
  const file = path.join(h.directory, 'integration-attempts.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const attempt of ledger.attempts) {
    delete attempt.ancestryVerified;
    if (mutate) {
      mutate(attempt);
    }
  }
  await fs.writeFile(file, JSON.stringify(ledger));
  return h.open();
}

const lineageStatus = (service, attemptId) => service.invoke(statusArgs({ attemptId }), authorize);

test('a reloaded unproved attempt cannot become candidate, validated, accepted or published', async t => {
  const { h, control, service } = await lineageHarness(t);
  const { seed, clean } = await lineageAttempts(service);
  assert.equal(seed.status, 'ready');
  assert.equal(seed.derivedSnapshotId, SEED_C);
  assert.equal(seed.conflicts.length, 1);
  assert.equal(clean.status, 'ready');
  assert.equal(clean.baseSnapshotId, SEED_C);

  const states = {};
  for (const to of ['ready', 'candidate', 'validated', 'accepted']) {
    states[to] = await advanceDownstream(service, await begin(service, downstreamArgs(`begin-${to}`)), to);
  }
  assert.equal(states.ready.status, 'ready');
  assert.equal(states.candidate.status, 'candidate');
  assert.equal(states.validated.status, 'validated');
  assert.equal(states.accepted.status, 'accepted');
  assert.equal(states.accepted.ancestryVerified, true, 'a fresh verified composition records the proof');
  assert.equal(states.ready.ancestryVerified, true);

  const reopened = await withoutAncestryProof(h, service);
  control.ancestry = reloadChain(seed.attemptId, clean.attemptId);
  const retains = h.state.retains.length;
  const evidence = h.state.evidence.length;
  const composes = h.state.composes.length;
  const publishes = h.state.publishes.length;
  const refusesAncestry = promise => assert.rejects(promise,
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');

  await refusesAncestry(reopened.invoke({
    ownerId: OWNER, teamId: TEAM, attemptId: states.ready.attemptId, action: 'candidate',
    expectedRevision: states.ready.revision, requestId: 'cand-legacy', artifact: ART_C4
  }, authorize));
  await refusesAncestry(reopened.invoke({
    ownerId: OWNER, teamId: TEAM, attemptId: states.candidate.attemptId, action: 'validate',
    expectedRevision: states.candidate.revision, requestId: 'val-legacy', evidence: [EV_V]
  }, authorize));
  await refusesAncestry(reopened.invoke({
    ownerId: OWNER, teamId: TEAM, attemptId: states.validated.attemptId, action: 'accept',
    expectedRevision: states.validated.revision, requestId: 'accept-legacy', resolvedPaths: []
  }, authorize));

  // Nothing was retained, pinned, composed or published, and no revision moved.
  assert.equal(h.state.retains.length, retains);
  assert.equal(h.state.evidence.length, evidence);
  assert.equal(h.state.composes.length, composes);
  assert.equal(h.state.publishes.length, publishes);
  for (const [state, before] of Object.entries(states)) {
    const current = await lineageStatus(reopened, before.attemptId);
    assert.equal(current.status, state);
    assert.equal(current.revision, before.revision);
    assert.equal(current.ancestryVerified, false);
  }
  // The reload proof asked for THIS attempt's exact retained source refs.
  assert.deepEqual(h.state.ancestry.at(-1).refs, [ART_C3]);
  assert.equal(h.state.ancestry.at(-1).scope.attemptId, states.validated.attemptId);
  assert.equal(h.state.ancestry.length, 3, 'one source scan per refused decision, never a compose');
});

test('a legacy accepted attempt is refused a fresh publication before any apply record or publisher', async t => {
  const { h, control, service } = await lineageHarness(t);
  const { seed, clean } = await lineageAttempts(service);
  const accepted = await advanceDownstream(service, await begin(service, downstreamArgs('begin-apply')), 'accepted');
  const reopened = await withoutAncestryProof(h, service);
  control.ancestry = reloadChain(seed.attemptId, clean.attemptId);
  await assert.rejects(reopened.invoke({
    ownerId: OWNER, teamId: TEAM, attemptId: accepted.attemptId, action: 'apply',
    expectedRevision: accepted.revision, requestId: 'apply-legacy'
  }, authorize), error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  assert.equal(h.state.publishes.length, 0);
  const durable = await lineageStatus(reopened, accepted.attemptId);
  assert.equal(durable.status, 'accepted');
  assert.equal(durable.apply, null, 'no applying intent was written');
  assert.equal(durable.revision, accepted.revision);
  assert.equal(durable.ancestryVerified, false);
  assert.equal(h.state.ancestry.length, 1, 'exactly one reload scan and no publisher call');
});

test('an old applying record keeps proof-only recovery and release with an unresolved lineage', async t => {
  const pending = {
    state: 'conflict',
    applied: [],
    conflicts: [{ path: '.', reason: 'recovery pending: retry with a new request once storage is available.' }]
  };
  const { h, control, service } = await lineageHarness(t, { publishFailures: 1, publishStates: [pending] });
  const { seed, clean } = await lineageAttempts(service);
  const accepted = await advanceDownstream(service, await begin(service, downstreamArgs('begin-applying')), 'accepted');
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: accepted.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  await assert.rejects(service.invoke(applyArgs, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');
  const applying = await lineageStatus(service, accepted.attemptId);
  assert.equal(applying.status, 'applying');
  assert.equal(applying.apply.state, 'applying');

  // The older build's ledger: no ancestry marker, but its journal WAS established
  // before the reload, so the real journal proof must be retained.
  const reopened = await withoutAncestryProof(h, service, attempt => {
    if (attempt.id === accepted.attemptId) {
      attempt.publicationJournalEstablished = true;
    }
  });
  control.ancestry = reloadChain(seed.attemptId, clean.attemptId);
  const resumed = await reopened.invoke(applyArgs, authorize);
  assert.equal(resumed.replayed, false);
  assert.equal(resumed.status, 'accepted');
  assert.equal(resumed.apply.state, 'conflict');
  assert.deepEqual(resumed.apply.conflicts, pending.conflicts);
  assert.equal(resumed.ancestryVerified, false);
  assert.equal(h.state.publishes.length, 2);
  assert.equal(h.state.publishes[1].recoveryOnly, true, 'no fresh journal and no pending effect may start');
  assert.equal(h.state.publishes[1].requireJournal, true, 'the real journal proof is kept');

  // The receipt only OBSERVES now, and the pending publication no longer blocks
  // an explicit release.
  const replay = await reopened.invoke(applyArgs, authorize);
  assert.equal(replay.replayed, true);
  assert.equal(h.state.publishes.length, 2);
  const released = await reopened.invoke({
    ...controls, action: 'release', expectedRevision: resumed.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(h.state.releases, 1);
});

test('a clean legacy record still advances once its exact sources are re-proved', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const service = h.open();
  const baseControls = { ownerId: OWNER, teamId: TEAM };
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const reopened = await withoutAncestryProof(h, service);
  const attemptControls = { ...baseControls, attemptId: begun.attemptId };
  const applied = await reopened.invoke({
    ...attemptControls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.ancestryVerified, true, 'the reload proof is durable');
  assert.equal(h.state.publishes.length, 1);
  assert.deepEqual(h.state.ancestry.map(entry => entry.refs), [[ART_A]]);

  // A NEW attempt is proved by its verified composition and never scans again.
  const second = await begin(reopened, { requestId: 'begin-2' });
  assert.equal(second.ancestryVerified, true);
  const secondAccepted = await applyReady(reopened, second);
  const secondApplied = await reopened.invoke({
    ...attemptControls, attemptId: second.attemptId, action: 'apply',
    expectedRevision: secondAccepted.revision, requestId: 'apply-1'
  }, authorize);
  assert.equal(secondApplied.status, 'applied');
  assert.equal(h.state.ancestry.length, 1, 'a fresh verified composition does not re-read provenance');
});

test('an exact accepted resolved lineage stays provable on reload after pin release', async t => {
  const { h, control, service } = await lineageHarness(t);
  const { seed, clean } = await lineageAttempts(service);
  const seedControls = { ownerId: OWNER, teamId: TEAM, attemptId: seed.attemptId };
  const seedCand = await service.invoke({
    ...seedControls, action: 'candidate', expectedRevision: seed.revision, requestId: 'cand-1', artifact: ART_C2
  }, authorize);
  const seedVal = await service.invoke({
    ...seedControls, action: 'validate', expectedRevision: seedCand.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  const seedAccepted = await service.invoke({
    ...seedControls, action: 'accept', expectedRevision: seedVal.revision, requestId: 'accept-1',
    resolvedPaths: ['add.cjs']
  }, authorize);
  assert.deepEqual(seedAccepted.acceptance.resolvedPaths, ['add.cjs']);

  const cleanControls = { ownerId: OWNER, teamId: TEAM, attemptId: clean.attemptId };
  const cleanCand = await service.invoke({
    ...cleanControls, action: 'candidate', expectedRevision: clean.revision, requestId: 'cand-1', artifact: ART_C5
  }, authorize);
  const cleanVal = await service.invoke({
    ...cleanControls, action: 'validate', expectedRevision: cleanCand.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  const cleanAccepted = await service.invoke({
    ...cleanControls, action: 'accept', expectedRevision: cleanVal.revision, requestId: 'accept-1'
  }, authorize);

  // Release changes RETENTION only: the accepted resolution survives for the
  // already-composed downstream seed, so reload may still prove it.
  const released = await service.invoke({
    ...seedControls, action: 'release', expectedRevision: seedAccepted.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.deepEqual(released.acceptance.resolvedPaths, ['add.cjs']);
  assert.deepEqual(released.candidate.artifact, ART_C2);

  const reopened = await withoutAncestryProof(h, service);
  // W's base IS the conflicted seed, consumed through its exact accepted seal.
  control.ancestry = {
    sourceSnapshotId: SEED_C,
    ancestors: [{
      snapshotId: SEED_C,
      provenance: {
        kind: 'integration-seed', attemptId: seed.attemptId, baseSnapshotId: BASE,
        refs: [{ ...ART_A }, { ...ART_B }], conflicts: [CONFLICT]
      }
    }]
  };
  const applied = await reopened.invoke({
    ...cleanControls, action: 'apply', expectedRevision: cleanAccepted.revision, requestId: 'apply-1'
  }, authorize);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.ancestryVerified, true);
  assert.equal(h.state.publishes.length, 1);
  assert.equal(h.state.publishes[0].baseSnapshotId, SEED_C);
});

function session(id, options = {}) {
  return {
    id,
    createdAt: options.createdAt ?? CREATED,
    ownerId: options.ownerId ?? OWNER,
    workspaceRoot: options.workspaceRoot ?? ROOT,
    state: 'completed',
    isolatedView: options.isolatedView === null ? undefined : {
      teamId: options.teamId ?? TEAM,
      snapshotId: options.snapshotId ?? BASE,
      overlayId: 'ff'.repeat(32)
    },
    startup: {
      teamId: TEAM,
      taskId: TASK_A,
      snapshotId: BASE,
      teamRevision: 1,
      taskRevision: 3,
      lane: options.lane ?? 'work',
      phase: 'ready',
      requestId: `setup-${id}`
    }
  };
}

function task(id, options = {}) {
  return {
    id,
    teamId: TEAM,
    title: options.title ?? `Task ${id.slice(0, 4)}`,
    description: options.description ?? '',
    acceptanceCriteria: options.acceptanceCriteria ?? ['criterion'],
    dependencies: options.dependencies ?? [],
    assigneeWorkerId: options.assigneeWorkerId ?? null,
    progress: '',
    blockers: [],
    state: options.state ?? 'submitted',
    candidates: options.candidates ?? [],
    agreedContracts: options.agreedContracts ?? [],
    validations: options.validations ?? [],
    revision: options.revision ?? 3,
    createdAt: CREATED,
    updatedAt: CREATED
  };
}

function sealedSubmission(ref, options = {}) {
  return {
    teamId: options.teamId ?? TEAM,
    snapshotId: options.snapshotId ?? BASE,
    overlayId: 'ee'.repeat(32),
    id: ref.id,
    version: ref.version,
    uri: ref.uri,
    workerId: options.workerId ?? WORKER_A,
    workerCreatedAt: options.workerCreatedAt ?? options.createdAt ?? CREATED,
    ownerId: options.ownerId ?? OWNER,
    head: null,
    revision: options.revision ?? 0,
    released: false,
    createdAt: CREATED
  };
}

async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-attempts-'));
  const directory = path.join(root, 'store');
  await fs.mkdir(directory);
  const tasks = new Map();
  for (const entry of options.tasks ?? [task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A })]) {
    tasks.set(entry.id, entry);
  }
  const sessions = new Map();
  for (const entry of options.sessions ?? [
    session(WORKER_A),
    session(WORKER_B, { teamId: TEAM }),
    session(WORKER_V, { lane: 'validation' }),
    session(WORKER_I, { lane: 'integration' })
  ]) {
    sessions.set(entry.id, entry);
  }
  const team = {
    id: TEAM,
    name: 'Team',
    description: '',
    workspaceRoot: ROOT,
    coordinatorOwnerId: OWNER,
    memberWorkerIds: [...sessions.keys()],
    revision: 1,
    createdAt: CREATED,
    updatedAt: CREATED,
    history: { entries: [], lastSequence: 0, trimmed: 0 }
  };
  const board = {
    getTeam(actor, id) {
      if (actor.kind !== 'coordinator' || actor.ownerId !== OWNER) {
        throw new WorkerError('forbidden', 'bad actor');
      }
      if (id !== TEAM) {
        throw new WorkerError('team_missing', 'missing team');
      }
      return structuredClone(team);
    },
    getTask(actor, id) {
      if (actor.kind !== 'coordinator' || actor.ownerId !== OWNER) {
        throw new WorkerError('forbidden', 'bad actor');
      }
      const found = tasks.get(id);
      if (!found) {
        throw new WorkerError('task_missing', `missing task ${id}`);
      }
      return structuredClone(found);
    }
  };
  const sealedByArtifact = new Map();
  if (options.sealed) {
    for (const entry of options.sealed) {
      sealedByArtifact.set(refKey(entry.ref), entry.options);
    }
  }
  const state = {
    retains: [],
    evidence: [],
    releases: 0,
    compositions: 0,
    composes: [],
    ancestry: [],
    verifies: 0,
    publishes: [],
    evidenceFailure: options.evidenceFailure ?? false,
    publishFailures: options.publishFailures ?? 0,
    denyAfterEvidenceFailure: options.denyAfterEvidenceFailure ?? false,
    deny: false,
    authorization: 0
  };
  const publishStates = [...(options.publishStates ?? [])];
  const ports = {
    board: async () => board,
    session: id => sessions.get(id),
    // The real port proves every immutable seal, then runs the caller's verifier
    // under the same view lock, and only THEN writes the pins. Mirroring that
    // order here is what makes a rejected candidate absent from `state.retains`.
    retainArtifacts: async (scope, refs, authorize, verify) => {
      authorize();
      const submissions = refs.map(ref => {
        const config = sealedByArtifact.get(refKey(ref));
        if (!config) {
          throw new WorkerError('sealed_missing', `No sealed submission is configured for ${refKey(ref)}.`);
        }
        return sealedSubmission(ref, config);
      });
      if (verify !== undefined) {
        state.verifies += 1;
        await verify(submissions);
      }
      state.retains.push({ scope, refs: refs.map(ref => ({ ...ref })) });
      return submissions;
    },
    sourceAncestry: async (scope, refs, authorize) => {
      authorize();
      state.ancestry.push({ scope, refs: refs.map(ref => ({ ...ref })) });
      if (typeof options.ancestry === 'function') {
        return options.ancestry(refs, state.ancestry.length);
      }
      return options.ancestry ?? { sourceSnapshotId: BASE, ancestors: [] };
    },
    compose: async (scope, refs, authorize, verify) => {
      authorize();
      state.compositions += 1;
      // Mirror the REAL port: the ledger's ancestry proof runs under this same
      // lock, BEFORE any composed write, and a refusal never composes.
      const chain = typeof options.conflictChain === 'function'
        ? options.conflictChain(refs, state.compositions)
        : (options.conflictChain ?? []);
      if (verify !== undefined) {
        state.composes.push({ scope, refs: refs.map(ref => ({ ...ref })), chain });
        await verify(chain);
      }
      if (typeof options.composition === 'function') {
        return options.composition(refs, state.compositions, scope);
      }
      return options.composition ?? {
        snapshot: { id: BASE, teamId: TEAM, ownerId: OWNER, manifestHash: 'ff'.repeat(32), backing: { kind: 'cas' }, createdAt: CREATED },
        baseSnapshotId: BASE,
        conflicts: []
      };
    },
    pinEvidence: async (scope, items, authorize) => {
      authorize();
      if (state.evidenceFailure) {
        if (state.denyAfterEvidenceFailure) {
          state.deny = true;
        }
        throw new WorkerError('evidence_failed', 'This runner result is failed or not drained and cannot be pinned as evidence.');
      }
      state.evidence.push(items.map(item => ({ ...item, ref: { ...item.ref } })));
    },
    releasePins: async (scope, authorize) => {
      authorize();
      state.releases += 1;
    },
    publish: async (scope, baseSnapshotId, ref, authorize, options) => {
      authorize();
      state.publishes.push({
        scope,
        baseSnapshotId,
        ref: { ...ref },
        recoveryOnly: options?.recoveryOnly === true,
        requireJournal: options?.requireJournal
      });
      if (state.publishFailures > 0) {
        state.publishFailures -= 1;
        throw new WorkerError('publish_failed', 'The publication journal is unavailable.');
      }
      if (publishStates.length) {
        return publishStates.shift();
      }
      return { state: 'applied', applied: ['src/out.txt'], conflicts: [] };
    },
    withStorageWrite: async action => action()
  };
  const guardedAuthorize = () => {
    if (state.deny) {
      throw new WorkerError('denied', 'Authorization was revoked before the durable write.');
    }
    state.authorization += 1;
  };
  const services = [];
  // The optional third argument is the host ROUTING identity of the store; every
  // existing caller opens a rootless store, exactly like a direct ledger harness.
  const open = workspaceRoot => {
    const service = new IntegrationAttempts(directory, ports, workspaceRoot);
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) {
      await service.close().catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, directory, board, team, tasks, sessions, sealedByArtifact, state, ports, open, authorize: guardedAuthorize };
}

const authorize = () => undefined;

function beginArgs(overrides = {}) {
  return {
    action: 'begin',
    ownerId: OWNER,
    teamId: TEAM,
    requestId: 'begin-1',
    sources: [{ taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] }],
    validationCommands: ['npm test'],
    ...overrides
  };
}

async function begin(service, overrides = {}) {
  return service.invoke(beginArgs(overrides), authorize);
}

function statusArgs(overrides = {}) {
  return { action: 'status', ownerId: OWNER, teamId: TEAM, ...overrides };
}

test('strict wire schema rejects unknown fields, empty evidence and unbounded selections', () => {
  assert.doesNotThrow(() => integrationActionSchema.parse(beginArgs()));
  assert.throws(() => integrationActionSchema.parse({ ...beginArgs(), extra: true }));
  assert.throws(() => integrationActionSchema.parse(beginArgs({ sources: [] })));
  assert.throws(() => integrationActionSchema.parse(beginArgs({
    sources: [{ taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [] }]
  })));
  assert.throws(() => integrationActionSchema.parse(beginArgs({ validationCommands: [] })));
  assert.throws(() => integrationActionSchema.parse(beginArgs({ validationCommands: undefined })));
  assert.doesNotThrow(() => integrationActionSchema.parse(
    beginArgs({ validationCommands: undefined, consumer: { taskId: TASK_C, taskRevision: 5 } })
  ));
  assert.throws(() => integrationActionSchema.parse(beginArgs({ validationCommands: new Array(9).fill('npm test') })));
  assert.throws(() => integrationActionSchema.parse(beginArgs({ sources: new Array(17).fill(beginArgs().sources[0]) })));
  assert.throws(() => integrationActionSchema.parse({
    action: 'release', ownerId: OWNER, teamId: TEAM, attemptId: 'a'.repeat(64),
    expectedRevision: 1, requestId: 'r', abandon: false, releaseRetention: true
  }));
  assert.throws(() => integrationActionSchema.parse({ action: 'publish', ownerId: OWNER, teamId: TEAM }));
  assert.throws(() => integrationActionSchema.parse({
    action: 'status', ownerId: OWNER, teamId: TEAM, attemptId: 'a'.repeat(32)
  }));
});

test('begin rejects a forged artifact URI and never infers it from the board candidate', async t => {
  const h = await harness(t, { sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }] });
  const service = h.open();
  await assert.rejects(
    begin(service, { sources: [{ taskId: TASK_A, taskRevision: 3, artifact: { ...ART_A, uri: 'submission://forged' }, evidence: [EV_A] }] }),
    error => error instanceof WorkerError && error.code === 'candidate_mismatch'
  );
  assert.equal(h.state.retains.length, 0);
  assert.equal(h.state.compositions, 0);
  await assert.rejects(
    service.invoke(statusArgs({ beginRequestId: 'begin-1' }), authorize),
    error => error instanceof WorkerError && error.code === 'attempt_missing'
  );

  const ack = await begin(service);
  assert.equal(ack.action, 'begin');
  assert.equal(ack.status, 'ready');
  assert.equal(ack.replayed, false);
  assert.equal(ack.baseSnapshotId, BASE);
  assert.equal(ack.derivedSnapshotId, BASE);
  assert.deepEqual(ack.conflicts, []);
  assert.deepEqual(ack.conflictPaths, []);
  assert.deepEqual(ack.requirements.sources[0].artifact, ART_A);
  assert.deepEqual(ack.requirements.sources[0].evidence, [EV_A]);
  assert.equal(ack.requirements.sources[0].title, 'Task a0a0');
  assert.deepEqual(ack.requirements.sources[0].acceptanceCriteria, ['criterion']);
  assert.equal(h.state.retains.length, 1);
  assert.equal(h.state.compositions, 1);

  const replay = await begin(service);
  assert.equal(replay.replayed, true);
  assert.equal(replay.attemptId, ack.attemptId);
  assert.equal(h.state.retains.length, 1);
  assert.equal(h.state.compositions, 1);

  await assert.rejects(begin(service, { validationCommands: ['npm run lint'] }),
    error => error instanceof WorkerError && error.code === 'request_conflict');
});

test('artifact dependencies require the exact explicit producer source', async t => {
  const consumer = task(TASK_C, {
    revision: 5,
    state: 'in_progress',
    dependencies: [{ taskId: TASK_A, kind: 'artifact' }]
  });
  const h = await harness(t, {
    tasks: [
      task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, state: 'accepted' }),
      task(TASK_B, { candidates: [ART_B], assigneeWorkerId: WORKER_B, state: 'accepted' }),
      consumer
    ],
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }, { ref: ART_B, options: { workerId: WORKER_B } }]
  });
  const service = h.open();
  await assert.rejects(begin(service, {
    sources: [{ taskId: TASK_B, taskRevision: 3, artifact: ART_B, evidence: [EV_B] }],
    consumer: { taskId: TASK_C, taskRevision: 5 }
  }), error => error instanceof WorkerError && error.code === 'dependency_unselected');
  assert.equal(h.state.retains.length, 0);

  const ack = await begin(service, {
    sources: [{ taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] }],
    consumer: { taskId: TASK_C, taskRevision: 5 }
  });
  // A consumer begin over an artifact edge is a private seed too: it is never
  // publishable here, so it may only consume settled producers.
  assert.equal(ack.dependencyOnly, true);
  assert.equal(ack.seedOnly, true);
  assert.equal(ack.canPublish, false);
  assert.equal(ack.requirements.consumer.taskId, TASK_C);
  assert.deepEqual(ack.dependencies, [{ taskId: TASK_A, kind: 'artifact' }]);
});

test('a normal downstream consumer with an artifact edge is seed-only and needs accepted producers', async t => {
  const consumer = task(TASK_C, {
    revision: 7,
    state: 'ready',
    title: 'Downstream view',
    description: 'Render the accepted artifact behind the existing flag.',
    acceptanceCriteria: ['render the accepted artifact'],
    dependencies: [{ taskId: TASK_A, kind: 'artifact' }]
  });
  const producer = task(TASK_A, {
    candidates: [ART_A],
    assigneeWorkerId: WORKER_A,
    state: 'accepted',
    title: 'Producer artifact',
    description: 'Publish the merged index writer.'
  });
  const h = await harness(t, {
    tasks: [producer, consumer],
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }]
  });
  const service = h.open();
  const sources = [{ taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] }];
  const seed = overrides => beginArgs({
    sources,
    consumer: { taskId: TASK_C, taskRevision: 7 },
    validationCommands: undefined,
    ...overrides
  });

  // The producer must be settled: an in-flight submission stays an ordinary batch.
  h.tasks.set(TASK_A, { ...producer, state: 'submitted' });
  await assert.rejects(service.invoke(seed(), authorize),
    error => error instanceof WorkerError && error.code === 'state_invalid');
  assert.equal(h.state.retains.length, 0);
  assert.equal(h.state.compositions, 0);
  h.tasks.set(TASK_A, producer);

  // The exact artifact is still mandatory: a wrong URI is never inferred.
  await assert.rejects(service.invoke(seed({
    sources: [{ taskId: TASK_A, taskRevision: 3, artifact: { ...ART_A, uri: 'submission://implicit' }, evidence: [EV_A] }]
  }), authorize), error => error instanceof WorkerError && error.code === 'candidate_mismatch');
  assert.equal(h.state.retains.length, 0);

  const ack = await service.invoke(seed(), authorize);
  assert.equal(ack.status, 'ready');
  assert.equal(ack.seedOnly, true);
  assert.equal(ack.dependencyOnly, true);
  assert.deepEqual(ack.validationCommands, []);
  assert.equal(ack.requirements.consumer.taskId, TASK_C);
  assert.equal(ack.requirements.consumer.title, 'Downstream view');
  assert.equal(ack.requirements.consumer.description, 'Render the accepted artifact behind the existing flag.');
  assert.deepEqual(ack.requirements.consumer.acceptanceCriteria, ['render the accepted artifact']);
  assert.deepEqual(ack.requirements.sources[0].artifact, ART_A);
  assert.deepEqual(ack.requirements.sources[0].evidence, [EV_A]);
  assert.equal(ack.requirements.sources[0].state, 'accepted');
  assert.equal(ack.requirements.sources[0].title, 'Producer artifact');
  assert.equal(ack.requirements.sources[0].description, 'Publish the merged index writer.');
  assert.equal(ack.canPublish, false);

  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: ack.attemptId };
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: ack.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'dependency_only');
  await assert.rejects(service.invoke({
    ...controls, action: 'apply', expectedRevision: ack.revision, requestId: 'apply-1'
  }, authorize), error => error instanceof WorkerError && error.code === 'dependency_only');

  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: ack.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(h.state.releases, 1);
});

test('contract edges require an exact pinned agreed version and a dependency-only seed cannot publish', async t => {
  const agreed = { ...ART_A, label: 'agreed-a' };
  const consumer = task(TASK_C, {
    revision: 5,
    state: 'in_progress',
    dependencies: [{ taskId: TASK_A, kind: 'contract' }]
  });
  const producer = task(TASK_A, {
    candidates: [ART_A],
    assigneeWorkerId: WORKER_A,
    agreedContracts: [agreed],
    state: 'accepted'
  });
  const h = await harness(t, {
    tasks: [producer, consumer],
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }]
  });
  const service = h.open();
  const sources = [{ taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] }];
  await assert.rejects(begin(service, { sources, consumer: { taskId: TASK_C, taskRevision: 5 } }),
    error => error instanceof WorkerError && error.code === 'contract_unselected');
  await assert.rejects(begin(service, {
    sources,
    consumer: { taskId: TASK_C, taskRevision: 5 },
    contracts: [{ taskId: TASK_A, taskRevision: 3, ref: { ...ART_A, version: 2 } }]
  }), error => error instanceof WorkerError && error.code === 'contract_mismatch');
  await assert.rejects(begin(service, {
    sources,
    consumer: { taskId: TASK_C, taskRevision: 5 },
    contracts: [{ taskId: TASK_A, taskRevision: 2, ref: agreed }]
  }), error => error instanceof WorkerError && error.code === 'revision_conflict');

  const ack = await begin(service, {
    sources,
    consumer: { taskId: TASK_C, taskRevision: 5 },
    contracts: [{ taskId: TASK_A, taskRevision: 3, ref: agreed }]
  });
  assert.equal(ack.dependencyOnly, true);
  assert.equal(ack.seedOnly, true);
  assert.deepEqual(ack.contracts, [{ taskId: TASK_A, taskRevision: 3, ref: agreed }]);
  await assert.rejects(service.invoke({
    action: 'candidate', ownerId: OWNER, teamId: TEAM, attemptId: ack.attemptId,
    expectedRevision: ack.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'dependency_only');
  await assert.rejects(service.invoke({
    action: 'apply', ownerId: OWNER, teamId: TEAM, attemptId: ack.attemptId,
    expectedRevision: ack.revision, requestId: 'apply-1'
  }, authorize), error => error instanceof WorkerError && error.code === 'dependency_only');
  const released = await service.invoke({
    action: 'release', ownerId: OWNER, teamId: TEAM, attemptId: ack.attemptId,
    expectedRevision: ack.revision, requestId: 'release-1', abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(h.state.releases, 1);
});

test('failed evidence stays visible by beginRequestId, can recover, or be released explicitly', async t => {
  const h = await harness(t, {
    evidenceFailure: true,
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }]
  });
  const service = h.open();
  await assert.rejects(begin(service),
    error => error instanceof WorkerError && error.code === 'evidence_failed');
  let status = await service.invoke(statusArgs({ beginRequestId: 'begin-1' }), authorize);
  assert.equal(status.status, 'failed');
  assert.equal(status.failure.code, 'evidence_failed');
  assert.equal(status.pinState, 'artifacts');
  assert.equal(status.evidencePinned, false);

  h.state.evidenceFailure = false;
  const recovered = await begin(service);
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.pinState, 'evidence');
  assert.equal(recovered.replayed, true);
  assert.equal(h.state.compositions, 1);

  const released = await service.invoke({
    action: 'release', ownerId: OWNER, teamId: TEAM, attemptId: recovered.attemptId,
    expectedRevision: recovered.revision, requestId: 'release-1', abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(released.pinState, 'none');
  assert.equal(h.state.releases, 1);
  await assert.rejects(begin(service),
    error => error instanceof WorkerError && error.code === 'attempt_released');
});

test('candidate/validate/accept/apply are exact-revision, replayable, and explicit', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } },
      { ref: ART_C2, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const service = h.open();
  const begun = await begin(service);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };

  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: 0, requestId: 'cand-1', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'revision_conflict');

  const proposed = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize);
  assert.equal(proposed.status, 'candidate');
  assert.equal(proposed.candidate.lane, 'validation');
  assert.deepEqual(proposed.candidate.artifact, ART_C);
  const retainsAfterCandidate = h.state.retains.length;

  const replayed = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize);
  assert.equal(replayed.replayed, true);
  assert.equal(h.state.retains.length, retainsAfterCandidate);

  const replaced = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: proposed.revision, requestId: 'cand-2', artifact: ART_C2
  }, authorize);
  assert.equal(replaced.status, 'candidate');
  assert.deepEqual(replaced.validations, []);

  await assert.rejects(service.invoke({
    ...controls, action: 'validate', expectedRevision: replaced.revision, requestId: 'val-1', evidence: [EV_V, EV_A]
  }, authorize), error => error instanceof WorkerError && error.code === 'validation_evidence_mismatch');

  const validated = await service.invoke({
    ...controls, action: 'validate', expectedRevision: replaced.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  assert.equal(validated.status, 'validated');
  assert.equal(validated.validations.length, 1);
  assert.equal(validated.validations[0].command, 'npm test');
  assert.equal(h.state.evidence.length, 2);
  const candidateCheck = h.state.evidence[1][0];
  assert.equal(candidateCheck.command, 'npm test');
  assert.equal(candidateCheck.submission.id, ART_C2.id);

  await assert.rejects(service.invoke({
    ...controls, action: 'accept', expectedRevision: validated.revision, requestId: 'accept-1', resolvedPaths: ['src/x']
  }, authorize), error => error instanceof WorkerError && error.code === 'conflict_paths_mismatch');

  const accepted = await service.invoke({
    ...controls, action: 'accept', expectedRevision: validated.revision, requestId: 'accept-1', resolvedPaths: []
  }, authorize);
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.acceptance.resolvedPaths, []);
  assert.deepEqual(accepted.requirements.sources[0].acceptanceCriteria, ['criterion']);

  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: accepted.revision, requestId: 'cand-3', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'state_invalid');

  const applied = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.apply.state, 'applied');
  assert.equal(h.state.publishes.length, 1);
  assert.equal(h.state.publishes[0].baseSnapshotId, BASE);

  const applyReplay = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  assert.equal(applyReplay.replayed, true);
  assert.equal(h.state.publishes.length, 1);

  await assert.rejects(service.invoke({
    ...controls, action: 'apply', expectedRevision: applied.revision, requestId: 'apply-1'
  }, authorize), error => error instanceof WorkerError && error.code === 'request_conflict');

  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: applied.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'released');
  assert.equal(h.state.releases, 1);
  const final = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(final.status, 'released');
  assert.equal(final.pinState, 'none');
});

test('candidate must be a current governed service-lane member of the same root', async t => {
  const h = await harness(t, {
    sessions: [
      session(WORKER_A),
      session(WORKER_V, { lane: 'validation' }),
      session(WORKER_I, { lane: 'integration' })
    ],
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_A, lane: 'work' } },
      { ref: ART_C2, options: { workerId: WORKER_V, createdAt: LATER, revision: 0 } }
    ]
  });
  const service = h.open();
  const begun = await begin(service);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const retains = h.state.retains.length;

  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'work-lane', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'service_lane_required');
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'stale-identity', artifact: ART_C2
  }, authorize), error => error instanceof WorkerError && error.code === 'worker_mismatch');
  // The provenance/snapshot/lane proof runs inside retention, before any pin is
  // written, so a rejected candidate never enters the retained set at all.
  assert.equal(h.state.retains.length, retains);
  assert.equal(h.state.verifies, 2);

  h.sealedByArtifact.set(refKey(ART_C), { workerId: WORKER_V, revision: 0 });
  h.sessions.get(WORKER_V).workspaceRoot = 'C:\\workspace\\other';
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'wrong-root', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'worker_mismatch');

  h.sessions.get(WORKER_V).workspaceRoot = ROOT;
  h.team.memberWorkerIds = h.team.memberWorkerIds.filter(id => id !== WORKER_V);
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'non-member', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'member_invalid');

  h.team.memberWorkerIds.push(WORKER_V);
  h.sealedByArtifact.set(refKey(ART_C), { workerId: WORKER_V, revision: 1 });
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'revision-one', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'candidate_mismatch');

  h.sealedByArtifact.set(refKey(ART_C), { workerId: WORKER_V, revision: 0, snapshotId: OTHER_BASE });
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'wrong-seed', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'candidate_mismatch');
  // Every one of those refusals left the attempt store untouched: no pin, no
  // receipt and no candidate record exists for a seal that was never verified.
  assert.equal(h.state.retains.length, retains);
  assert.equal(h.state.verifies, 6);
  const untouched = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(untouched.status, 'ready');
  assert.equal(untouched.candidate, null);
  assert.equal(untouched.revision, begun.revision);
});

test('conflict attempts require an integration-lane revision and exact acknowledged paths', async t => {
  const conflicts = [{ paths: ['src/a.ts'], inputIds: [TASK_A, TASK_B], reason: 'overlap' }];
  const h = await harness(t, {
    composition: { snapshot: { id: BASE }, baseSnapshotId: BASE, conflicts },
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } },
      { ref: ART_C2, options: { workerId: WORKER_I, revision: 2 } }
    ],
    publishStates: [{ state: 'conflict', applied: [], conflicts: [{ path: 'src/a.ts', reason: 'base changed' }] }]
  });
  const service = h.open();
  const begun = await begin(service);
  assert.deepEqual(begun.conflicts, conflicts);
  assert.deepEqual(begun.conflictPaths, ['src/a.ts']);
  assert.equal(begun.seedOnly, false);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };

  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'validation-lane', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'candidate_mismatch');

  const proposed = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'cand-1', artifact: ART_C2
  }, authorize);
  assert.equal(proposed.candidate.lane, 'integration');
  const validated = await service.invoke({
    ...controls, action: 'validate', expectedRevision: proposed.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  await assert.rejects(service.invoke({
    ...controls, action: 'accept', expectedRevision: validated.revision, requestId: 'accept-1', resolvedPaths: []
  }, authorize), error => error instanceof WorkerError && error.code === 'conflict_paths_mismatch');
  await assert.rejects(service.invoke({
    ...controls, action: 'accept', expectedRevision: validated.revision, requestId: 'accept-1',
    resolvedPaths: ['src/a.ts', 'src/a.ts']
  }, authorize), error => error instanceof WorkerError && error.code === 'conflict_paths_mismatch');

  const accepted = await service.invoke({
    ...controls, action: 'accept', expectedRevision: validated.revision, requestId: 'accept-1',
    resolvedPaths: ['src/a.ts']
  }, authorize);
  assert.deepEqual(accepted.acceptance.resolvedPaths, ['src/a.ts']);
  const applied = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  assert.equal(applied.status, 'accepted');
  assert.equal(applied.apply.state, 'conflict');
  assert.deepEqual(applied.apply.conflicts, [{ path: 'src/a.ts', reason: 'base changed' }]);
  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: applied.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
});

const applyReady = async (service, begun) => {
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  let current = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize);
  current = await service.invoke({
    ...controls, action: 'validate', expectedRevision: current.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  return service.invoke({
    ...controls, action: 'accept', expectedRevision: current.revision, requestId: 'accept-1'
  }, authorize);
};

// ---------------------------------------------------------------------------
// Inherited-base fixtures.
//
// A is integrated first, so its derived seed (SEED_A) is a durable attempt of
// this store. B declares A's artifact edge and its sealed submission was taken
// over SEED_A, so B's immutable base already embeds A: a later begin may select
// B ALONE and inherit A from that base instead of consuming A again.
// ---------------------------------------------------------------------------

const downstreamSource = (overrides = {}) => ({
  taskId: TASK_B, taskRevision: 4, artifact: ART_B, evidence: [EV_B], ...overrides
});

async function inheritedHarness(t) {
  const control = { ancestry: { sourceSnapshotId: SEED_A, ancestors: [] }, compositionBase: SEED_A };
  const h = await harness(t, {
    tasks: [
      task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, state: 'accepted', revision: 3 }),
      task(TASK_B, {
        candidates: [ART_B],
        assigneeWorkerId: WORKER_B,
        state: 'accepted',
        revision: 4,
        title: 'Downstream output',
        dependencies: [{ taskId: TASK_A, kind: 'artifact' }]
      })
    ],
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A, snapshotId: BASE } },
      { ref: ART_B, options: { workerId: WORKER_B, snapshotId: SEED_A, revision: 2 } },
      { ref: ART_A2, options: { workerId: WORKER_A, snapshotId: BASE, revision: 1 } }
    ],
    ancestry: () => control.ancestry,
    composition: refs => refs.length === 1 && refs[0].id === ART_A.id
      ? { snapshot: { id: SEED_A }, baseSnapshotId: BASE, conflicts: [] }
      : { snapshot: { id: SEED_B }, baseSnapshotId: control.compositionBase, conflicts: [] }
  });
  const service = h.open();
  const older = await begin(service, {
    requestId: 'begin-a',
    sources: [{ taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] }]
  });
  const witness = (overrides = {}) => ({
    snapshotId: overrides.snapshotId ?? SEED_A,
    provenance: {
      kind: 'integration-seed',
      attemptId: overrides.attemptId ?? older.attemptId,
      baseSnapshotId: overrides.baseSnapshotId ?? BASE,
      refs: overrides.refs ?? [{ ...ART_A }],
      conflicts: overrides.conflicts ?? []
    }
  });
  control.ancestry = { sourceSnapshotId: SEED_A, ancestors: [witness()] };
  return { h, control, service, older, witness };
}

test('a durable journal interruption is terminal, proof-only and releasable', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishStates: [{ state: 'interrupted', applied: [], conflicts: [] }]
  });
  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  const interrupted = await service.invoke(applyArgs, authorize);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.apply.state, 'interrupted');
  assert.equal(interrupted.replayed, false);
  assert.equal(h.state.publishes.length, 1);

  // The journal result is proof: an exact replay returns it and never rewrites.
  const replay = await service.invoke(applyArgs, authorize);
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 'interrupted');
  assert.equal(h.state.publishes.length, 1);

  await assert.rejects(service.invoke({
    ...controls, action: 'apply', expectedRevision: interrupted.revision, requestId: 'apply-2'
  }, authorize), error => error instanceof WorkerError && error.code === 'attempt_interrupted');
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: interrupted.revision, requestId: 'cand-2', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'attempt_interrupted');

  await service.close();
  service = h.open();
  const reopened = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(reopened.status, 'interrupted');
  assert.equal(reopened.apply.state, 'interrupted');
  const replayAfterReopen = await service.invoke(applyArgs, authorize);
  assert.equal(replayAfterReopen.replayed, true);
  assert.equal(h.state.publishes.length, 1);

  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: reopened.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(released.pinState, 'none');
  assert.equal(h.state.releases, 1);
  await service.close();
  service = h.open();
  const closed = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(closed.status, 'abandoned');
  assert.equal(h.state.releases, 1);
});

test('an in-flight publication refuses release and resumes only on the exact apply replay', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishFailures: 1
  });
  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  await assert.rejects(service.invoke(applyArgs, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');
  assert.equal(h.state.publishes.length, 1);

  await service.close();
  service = h.open();
  const reopened = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(reopened.status, 'applying');
  assert.equal(reopened.apply.state, 'applying');
  assert.equal(reopened.failure.code, 'publish_failed');
  await assert.rejects(service.invoke({
    ...controls, action: 'release', expectedRevision: reopened.revision, requestId: 'release-early',
    abandon: true, releaseRetention: true
  }, authorize), error => error instanceof WorkerError && error.code === 'application_in_flight');

  const resumed = await service.invoke(applyArgs, authorize);
  assert.equal(resumed.status, 'applied');
  assert.equal(h.state.publishes.length, 2);
  assert.equal(h.state.publishes[1].baseSnapshotId, BASE);

  await service.close();
  service = h.open();
  const durable = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(durable.status, 'applied');
  assert.equal(h.state.publishes.length, 2);
  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: durable.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'released');
  assert.equal(h.state.releases, 1);
});

test('retained seal identity and producer binding are rechecked against the persisted expectation', async t => {
  const h = await harness(t, {
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A, workerCreatedAt: LATER } }]
  });
  const service = h.open();
  await assert.rejects(begin(service),
    error => error instanceof WorkerError && error.code === 'producer_mismatch');
  const failed = await service.invoke(statusArgs({ beginRequestId: 'begin-1' }), authorize);
  assert.equal(failed.status, 'failed');

  const h2 = await harness(t, {
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }]
  });
  h2.sessions.get(WORKER_A).workspaceRoot = 'C:\\workspace\\other';
  const service2 = h2.open();
  await assert.rejects(begin(service2),
    error => error instanceof WorkerError && error.code === 'producer_unverified');
  assert.equal(h2.state.retains.length, 0);
});

test('a corrupt or missing ledger beside its namespace marker fails closed', async t => {
  const h = await harness(t, { sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }] });
  const first = h.open();
  const begun = await begin(first);
  assert.ok(begun.attemptId);
  await first.close();
  await fs.rm(path.join(h.directory, 'integration-attempts.json'));
  const second = h.open();
  await assert.rejects(
    second.invoke(statusArgs({ attemptId: begun.attemptId }), authorize),
    error => error instanceof WorkerError && error.code === 'integration_corrupt'
  );
});

test('a revoked authorization never rewrites the durable begin intent', async t => {
  const h = await harness(t, {
    evidenceFailure: true,
    denyAfterEvidenceFailure: true,
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }]
  });
  const service = h.open();
  await assert.rejects(service.invoke(beginArgs(), h.authorize),
    error => error instanceof WorkerError && error.code === 'evidence_failed');

  // The failure record could not be written without authorization, so the
  // previous durable intent is still what an exact retry recovers from.
  const status = await service.invoke(statusArgs({ beginRequestId: 'begin-1' }), authorize);
  assert.equal(status.status, 'intent');
  assert.equal(status.pinState, 'artifacts');
  assert.equal(status.evidencePinned, false);
  assert.equal(status.failure, null);

  h.state.deny = false;
  h.state.evidenceFailure = false;
  const recovered = await service.invoke(beginArgs(), authorize);
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.pinState, 'evidence');
  assert.equal(h.state.compositions, 1);
});

test('rework is refused at its cap before pinning while decisions stay reserved', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } },
      { ref: ART_C2, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const service = h.open();
  const begun = await begin(service);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  // Every port call is scoped by the exact attempt, owner and team.
  assert.deepEqual(h.state.retains[0].scope, { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId });

  let current = begun;
  for (let index = 0; index < 13; index += 1) {
    current = await service.invoke({
      ...controls, action: 'candidate', expectedRevision: current.revision,
      requestId: `cand-${index}`, artifact: index % 2 === 0 ? ART_C : ART_C2
    }, authorize);
  }
  const candidateRevision = current.revision;
  const retainsAtCap = h.state.retains.length;

  // The next rework is refused by the preflight, so it retains nothing at all.
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: current.revision, requestId: 'cand-13', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'capacity_exceeded');
  assert.equal(h.state.retains.length, retainsAtCap);

  // No receipt was evicted: an old requestId still conflicts on new arguments.
  await assert.rejects(service.invoke({
    ...controls, action: 'candidate', expectedRevision: current.revision, requestId: 'cand-0', artifact: ART_C2
  }, authorize), error => error instanceof WorkerError && error.code === 'request_conflict');
  assert.equal(h.state.retains.length, retainsAtCap);

  // Validation is a rework receipt too: refused before pinning any evidence.
  const evidenceAtCap = h.state.evidence.length;
  await assert.rejects(service.invoke({
    ...controls, action: 'validate', expectedRevision: candidateRevision, requestId: 'val-1', evidence: [EV_V]
  }, authorize), error => error instanceof WorkerError && error.code === 'capacity_exceeded');
  assert.equal(h.state.evidence.length, evidenceAtCap);

  // A fresh attempt is the supported retry, and its reserved slots stay usable.
  await service.close();
  const second = h.open();
  const fresh = await second.invoke(beginArgs({ requestId: 'begin-2' }), authorize);
  const freshControls = { ownerId: OWNER, teamId: TEAM, attemptId: fresh.attemptId };
  let step = fresh;
  for (let index = 0; index < 10; index += 1) {
    step = await second.invoke({
      ...freshControls, action: 'candidate', expectedRevision: step.revision,
      requestId: `c2-${index}`, artifact: index % 2 === 0 ? ART_C : ART_C2
    }, authorize);
  }
  const freshCandidateRevision = step.revision;
  step = await second.invoke({
    ...freshControls, action: 'validate', expectedRevision: freshCandidateRevision, requestId: 'val-2', evidence: [EV_V]
  }, authorize);
  const freshValidatedRevision = step.revision;
  step = await second.invoke({
    ...freshControls, action: 'accept', expectedRevision: freshValidatedRevision, requestId: 'accept-2'
  }, authorize);
  const freshAcceptedRevision = step.revision;
  step = await second.invoke({
    ...freshControls, action: 'apply', expectedRevision: freshAcceptedRevision, requestId: 'apply-2'
  }, authorize);
  assert.equal(step.status, 'applied');
  assert.deepEqual(h.state.evidence.at(-1)[0].submission.snapshotId, BASE);
  assert.deepEqual(h.state.publishes[0].scope, { ownerId: OWNER, teamId: TEAM, attemptId: fresh.attemptId });

  // Decision receipts replay exactly and the capped attempt is untouched.
  const applyReplay = await second.invoke({
    ...freshControls, action: 'apply', expectedRevision: freshAcceptedRevision, requestId: 'apply-2'
  }, authorize);
  assert.equal(applyReplay.replayed, true);
  assert.equal(h.state.publishes.length, 1);
  const validateReplay = await second.invoke({
    ...freshControls, action: 'validate', expectedRevision: freshCandidateRevision, requestId: 'val-2', evidence: [EV_V]
  }, authorize);
  assert.equal(validateReplay.replayed, true);

  const released = await second.invoke({
    ...freshControls, action: 'release', expectedRevision: step.revision, requestId: 'release-2',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'released');
  const releaseReplay = await second.invoke({
    ...freshControls, action: 'release', expectedRevision: step.revision, requestId: 'release-2',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(releaseReplay.replayed, true);
  assert.equal(h.state.releases, 1);

  const capped = await second.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(capped.status, 'candidate');
  assert.equal(capped.revision, candidateRevision);
});

test('a wide applied path and an oversized conflict report still persist a bounded terminal state', async t => {
  // The publication port reports canonical workspace paths up to 4096 chars and
  // may report far more conflicts, with longer reasons, than the coordinator
  // request shape allows. Its exact supported result must still be durable,
  // otherwise the applying intent written before the effect is stranded.
  const longPath = `src/${'a'.repeat(3000)}/applied.ts`;
  const longReason = `stale content: ${'b'.repeat(900)}`;
  const conflicts = Array.from({ length: 300 }, (_, index) => ({
    path: `src/conflict-${index}.ts`,
    reason: index === 0 ? longReason : `base changed ${index}`
  }));
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishStates: [{ state: 'conflict', applied: [longPath], conflicts }]
  });
  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };

  const applied = await service.invoke(applyArgs, authorize);
  assert.equal(applied.status, 'accepted');
  assert.equal(applied.apply.state, 'conflict');
  // Exact paths keep their full supported width.
  assert.deepEqual(applied.apply.applied, [longPath]);
  assert.equal(applied.apply.appliedCount, 1);
  // The preview is bounded, and its exact totals and truncation are explicit.
  assert.equal(applied.apply.truncated, true);
  assert.equal(applied.apply.conflictCount, conflicts.length);
  assert.ok(applied.apply.conflicts.length > 0);
  assert.ok(applied.apply.conflicts.length < conflicts.length);
  assert.equal(applied.apply.conflicts[0].path, 'src/conflict-0.ts');
  assert.equal(applied.apply.conflicts[0].reason.length, 500);
  assert.ok(longReason.startsWith(applied.apply.conflicts[0].reason));
  assert.equal(h.state.publishes.length, 1);

  // The bounded terminal state is durable, and the exact replay reads it back
  // without calling the publication port again.
  await service.close();
  service = h.open();
  const durable = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(durable.status, 'accepted');
  assert.equal(durable.apply.state, 'conflict');
  assert.deepEqual(durable.apply.applied, [longPath]);
  assert.equal(durable.apply.conflictCount, conflicts.length);
  assert.equal(durable.apply.truncated, true);
  const replay = await service.invoke(applyArgs, authorize);
  assert.equal(replay.replayed, true);
  assert.equal(replay.apply.conflictCount, conflicts.length);
  assert.equal(h.state.publishes.length, 1);
});

test('an in-flight publication keeps its reserved report room against unrelated saves', async t => {
  // The ledger byte bound must also keep room for the bounded terminal report of
  // a durable publication and for an explicit release. A save for a DIFFERENT
  // attempt may never spend that room, or the publication could not be recovered.
  const LIMIT = 8 * 1024 * 1024;
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishFailures: 1
  });
  let service = h.open();
  const inFlight = await begin(service);
  const accepted = await applyReady(service, inFlight);
  await assert.rejects(service.invoke({
    action: 'apply', ownerId: OWNER, teamId: TEAM, attemptId: inFlight.attemptId,
    expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize), error => error instanceof WorkerError && error.code === 'publish_failed');
  const second = await begin(service, { requestId: 'begin-2' });
  await service.close();

  // Fill the applying attempt with a still-valid diagnostic list so the ledger
  // text itself fits while its reserved report room no longer does.
  const file = path.join(h.directory, 'integration-attempts.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(ledger.attempts.length, 2);
  const target = LIMIT - 20 * 1024;
  const count = Math.floor((target - Buffer.byteLength(JSON.stringify(ledger), 'utf8')) / 2051);
  ledger.attempts.find(entry => entry.id === inFlight.attemptId).conflicts = [{
    paths: Array.from({ length: count }, (_, index) => `${String(index).padStart(10, '0')}${'x'.repeat(2038)}`),
    inputIds: [],
    reason: 'overlap'
  }];
  const unrelated = ledger.attempts.find(entry => entry.id === second.attemptId);
  unrelated.status = 'validated';
  unrelated.validations = [{ command: 'npm test', result: EV_V, at: CREATED }];
  await fs.writeFile(file, JSON.stringify(ledger));
  const text = await fs.readFile(file, 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') < LIMIT);
  assert.ok(Buffer.byteLength(text, 'utf8') > LIMIT - 64 * 1024);

  // The unrelated accept fits under the text bound, but not beside the reserved
  // report room, so it is refused before anything durable is written.
  service = h.open();
  await assert.rejects(service.invoke({
    action: 'accept', ownerId: OWNER, teamId: TEAM, attemptId: second.attemptId,
    expectedRevision: second.revision, requestId: 'accept-2b'
  }, authorize), error => error instanceof WorkerError && error.code === 'capacity_exceeded');
  assert.equal(await fs.readFile(file, 'utf8'), text);
  assert.equal(h.state.publishes.length, 1);
  const status = await service.invoke(statusArgs({ attemptId: second.attemptId }), authorize);
  assert.equal(status.status, 'validated');
});

test('a conflict retry at the receipt cap is refused but release still drops the pins', async t => {
  const conflicts = [{ paths: ['src/a.ts'], inputIds: [TASK_A], reason: 'overlap' }];
  const h = await harness(t, {
    composition: { snapshot: { id: BASE }, baseSnapshotId: BASE, conflicts },
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C2, options: { workerId: WORKER_I, revision: 2 } }
    ],
    publishStates: [{ state: 'conflict', applied: [], conflicts: [{ path: 'src/a.ts', reason: 'base changed' }] }]
  });
  const service = h.open();
  const begun = await begin(service);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  let current = begun;
  // 13 rework receipts (12 candidates + validation): a conflict attempt needs the
  // integration-lane revision.
  for (let index = 0; index < 12; index += 1) {
    current = await service.invoke({
      ...controls, action: 'candidate', expectedRevision: current.revision, requestId: `cand-${index}`, artifact: ART_C2
    }, authorize);
  }
  current = await service.invoke({
    ...controls, action: 'validate', expectedRevision: current.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  current = await service.invoke({
    ...controls, action: 'accept', expectedRevision: current.revision, requestId: 'accept-1',
    resolvedPaths: ['src/a.ts']
  }, authorize);
  const acceptedRevision = current.revision;
  current = await service.invoke({
    ...controls, action: 'apply', expectedRevision: acceptedRevision, requestId: 'apply-1'
  }, authorize);
  assert.equal(current.apply.state, 'conflict');

  // The retry would take the slot reserved for release, so it is refused first.
  const publishes = h.state.publishes.length;
  await assert.rejects(service.invoke({
    ...controls, action: 'apply', expectedRevision: current.revision, requestId: 'apply-2'
  }, authorize), error => error instanceof WorkerError && error.code === 'capacity_exceeded');
  assert.equal(h.state.publishes.length, publishes);

  // Release still fits in its reserved slot, so no pins are stranded.
  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: current.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(released.pinState, 'none');
  assert.equal(h.state.releases, 1);
  const replay = await service.invoke({
    ...controls, action: 'release', expectedRevision: current.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(replay.replayed, true);
  assert.equal(h.state.releases, 1);
});

test('an omitted artifact dependency already embedded in the verified base is inherited exactly', async t => {
  const { h, service, older } = await inheritedHarness(t);
  // A's board revision advanced long after the older acceptance: the witness
  // records the CURRENT revision and the OLD requirement as its evidence source.
  h.tasks.set(TASK_A, task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, state: 'accepted', revision: 9 }));
  const ack = await service.invoke(beginArgs({ requestId: 'begin-b', sources: [downstreamSource()] }), authorize);

  assert.equal(ack.status, 'ready');
  assert.equal(ack.replayed, false);
  assert.equal(ack.seedOnly, false);
  // A ready attempt is not yet accepted, so it is never publishable directly.
  assert.equal(ack.canPublish, false);
  assert.equal(ack.sourceSnapshotId, SEED_A);
  assert.equal(ack.baseSnapshotId, SEED_A);
  assert.equal(ack.derivedSnapshotId, SEED_B);
  assert.deepEqual(ack.dependencies, [{ taskId: TASK_A, kind: 'artifact' }]);
  assert.equal(ack.inherited.length, 1);
  const inherited = ack.inherited[0];
  assert.equal(inherited.taskId, TASK_A);
  assert.equal(inherited.taskRevision, 9);
  assert.equal(inherited.attemptId, older.attemptId);
  assert.equal(inherited.snapshotId, SEED_A);
  assert.deepEqual(inherited.artifact, ART_A);
  // The retained older requirement is the evidence source of the witness.
  assert.equal(inherited.requirement.taskRevision, 3);
  assert.deepEqual(inherited.requirement.artifact, ART_A);
  assert.deepEqual(inherited.requirement.evidence, [EV_A]);
  assert.equal(inherited.requirement.producer.workerId, WORKER_A);

  // The proof is scoped exactly like every other port call of this attempt.
  assert.equal(h.state.ancestry.length, 1);
  assert.deepEqual(h.state.ancestry[0].scope, { ownerId: OWNER, teamId: TEAM, attemptId: ack.attemptId });
  assert.deepEqual(h.state.ancestry[0].refs, [ART_B]);

  // A itself is never requested again: only B's exact seal is retained, pinned
  // and composed here, and no old producer blob is reopened from live files.
  const retained = h.state.retains.filter(entry => entry.scope.attemptId === ack.attemptId);
  assert.deepEqual(retained.flatMap(entry => entry.refs), [ART_B]);
  assert.deepEqual(h.state.evidence.at(-1).map(item => item.ref), [EV_B]);
  assert.deepEqual(h.state.evidence.at(-1).map(item => item.submission.id), [ART_B.id]);
  assert.equal(h.state.compositions, 2);

  // A replay keeps the frozen witness even though A's board moved to a newer
  // artifact: nothing is re-proved and no newer candidate is implied.
  h.tasks.set(TASK_A, task(TASK_A, { candidates: [ART_A2], assigneeWorkerId: WORKER_A, state: 'accepted', revision: 11 }));
  const replay = await service.invoke(beginArgs({ requestId: 'begin-b', sources: [downstreamSource()] }), authorize);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.inherited, [inherited]);
  assert.deepEqual(replay.requirements.sources[0].artifact, ART_B);
  assert.equal(h.state.ancestry.length, 1);
  assert.equal(h.state.retains.length, 2);
  assert.equal(h.state.compositions, 2);
});

test('a forged, mismatched or unwitnessed omitted artifact edge is refused', async t => {
  const { h, control, service, witness } = await inheritedHarness(t);
  const downstream = requestId => beginArgs({ requestId, sources: [downstreamSource()] });
  const refuses = async (requestId, code = 'dependency_unselected') => {
    await assert.rejects(service.invoke(downstream(requestId), authorize),
      error => error instanceof WorkerError && error.code === code);
  };
  const retains = h.state.retains.length;

  control.ancestry = { sourceSnapshotId: SEED_A, ancestors: [] };
  await refuses('edge-unwitnessed');
  control.ancestry = { sourceSnapshotId: SEED_A, ancestors: [witness({ attemptId: 'ff'.repeat(32) })] };
  await refuses('edge-unknown-attempt');
  control.ancestry = { sourceSnapshotId: SEED_A, ancestors: [witness({ refs: [{ ...ART_A, version: 2 }] })] };
  await refuses('edge-other-refs');
  control.ancestry = { sourceSnapshotId: SEED_A, ancestors: [witness({ snapshotId: SEED_B })] };
  await refuses('edge-other-seed');
  control.ancestry = { sourceSnapshotId: SEED_A, ancestors: [witness({ baseSnapshotId: OTHER_BASE })] };
  await refuses('edge-other-base');
  control.ancestry = {
    sourceSnapshotId: SEED_A,
    ancestors: [witness({ conflicts: [{ paths: ['src/a.ts'], inputIds: [TASK_A], reason: 'overlap' }] })]
  };
  await refuses('edge-conflicted-ancestor');
  control.ancestry = { sourceSnapshotId: 'not-a-hash', ancestors: [witness()] };
  await refuses('edge-malformed-answer', 'ancestry_invalid');

  control.ancestry = { sourceSnapshotId: SEED_A, ancestors: [witness()] };
  h.tasks.set(TASK_A, task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, state: 'submitted' }));
  await refuses('edge-not-accepted');
  h.tasks.set(TASK_A, task(TASK_A, { candidates: [ART_A2], assigneeWorkerId: WORKER_A, state: 'accepted', revision: 12 }));
  await refuses('edge-newer-artifact-only');

  // Every refusal happened in planning: nothing was retained, pinned, composed
  // or durably begun, so no attempt exists to release.
  assert.equal(h.state.retains.length, retains);
  assert.equal(h.state.evidence.length, 1);
  assert.equal(h.state.compositions, 1);
  await assert.rejects(service.invoke(statusArgs({ beginRequestId: 'edge-unwitnessed' }), authorize),
    error => error instanceof WorkerError && error.code === 'attempt_missing');
});

test('the immutable source snapshot behind an inherited witness is rechecked on retain and compose', async t => {
  const { h, control, service } = await inheritedHarness(t);
  // The first downstream attempt fails AFTER its inheritance was proved and its
  // exact source sealed, so the durable intent itself can be retried.
  h.state.evidenceFailure = true;
  await assert.rejects(service.invoke(beginArgs({ requestId: 'begin-b', sources: [downstreamSource()] }), authorize),
    error => error instanceof WorkerError && error.code === 'evidence_failed');
  const intent = await service.invoke(statusArgs({ beginRequestId: 'begin-b' }), authorize);
  assert.equal(intent.status, 'failed');
  assert.equal(intent.sourceSnapshotId, SEED_A);
  assert.equal(intent.inherited.length, 1);
  assert.equal(h.state.compositions, 1);

  // A seal that is no longer over that exact source snapshot can never compose.
  const retains = h.state.retains.length;
  h.sealedByArtifact.set(refKey(ART_B), { workerId: WORKER_B, snapshotId: BASE, revision: 2 });
  h.state.evidenceFailure = false;
  await assert.rejects(service.invoke(beginArgs({ requestId: 'begin-b', sources: [downstreamSource()] }), authorize),
    error => error instanceof WorkerError && error.code === 'sealed_mismatch');
  assert.equal(h.state.retains.length, retains + 1);
  assert.equal(h.state.compositions, 1);

  // Composition must build on that same immutable snapshot as well.
  h.sealedByArtifact.set(refKey(ART_B), { workerId: WORKER_B, snapshotId: SEED_A, revision: 2 });
  control.compositionBase = OTHER_BASE;
  await assert.rejects(service.invoke(beginArgs({ requestId: 'begin-b', sources: [downstreamSource()] }), authorize),
    error => error instanceof WorkerError && error.code === 'composition_conflict');
  assert.equal(h.state.compositions, 2);

  control.compositionBase = SEED_A;
  const recovered = await service.invoke(beginArgs({ requestId: 'begin-b', sources: [downstreamSource()] }), authorize);
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.sourceSnapshotId, SEED_A);
  assert.equal(recovered.baseSnapshotId, SEED_A);
  assert.equal(recovered.derivedSnapshotId, SEED_B);
  assert.deepEqual(recovered.inherited, intent.inherited);
  assert.equal(h.state.compositions, 3);
});

test('an old apply replay never re-enters a newer in-flight publication', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const calls = [];
  h.ports.publish = async (scope, baseSnapshotId, ref, portAuthorize) => {
    portAuthorize();
    calls.push({ baseSnapshotId, ref: { ...ref } });
    if (calls.length === 1) {
      return { state: 'conflict', applied: [], conflicts: [{ path: 'src/a.ts', reason: 'base changed' }] };
    }
    if (calls.length === 2) {
      throw new WorkerError('publish_failed', 'The publication journal is unavailable.');
    }
    return { state: 'applied', applied: ['src/replay.txt'], conflicts: [] };
  };
  const service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const applyA = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  const appliedA = await service.invoke(applyA, authorize);
  assert.equal(appliedA.status, 'accepted');
  assert.equal(appliedA.apply.state, 'conflict');

  // A NEW decision is admitted after A's recoverable conflict and fails after
  // its own durable applying intent exists.
  const applyB = { ...controls, action: 'apply', expectedRevision: appliedA.revision, requestId: 'apply-2' };
  await assert.rejects(service.invoke(applyB, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');
  const inFlight = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(inFlight.status, 'applying');
  assert.equal(inFlight.apply.requestId, 'apply-2');

  // A's exact receipt only OBSERVES the current durable state: it may never
  // publish under the newer in-flight decision.
  const oldReplay = await service.invoke(applyA, authorize);
  assert.equal(calls.length, 2);
  assert.equal(oldReplay.replayed, true);
  assert.equal(oldReplay.status, 'applying');
  assert.equal(oldReplay.apply.state, 'applying');
  assert.equal(oldReplay.apply.requestId, 'apply-2');
  assert.deepEqual(calls.map(call => call.ref), [ART_C, ART_C]);

  // Only the applied request of the CURRENT intent may re-enter the journal.
  const resumed = await service.invoke(applyB, authorize);
  assert.equal(calls.length, 3);
  assert.equal(resumed.status, 'applied');
  assert.equal(resumed.apply.requestId, 'apply-2');
  assert.deepEqual(resumed.apply.applied, ['src/replay.txt']);

  // A's receipt still observes the current durable state, never a stale one.
  const settledReplay = await service.invoke(applyA, authorize);
  assert.equal(calls.length, 3);
  assert.equal(settledReplay.replayed, true);
  assert.equal(settledReplay.status, 'applied');
  assert.equal(settledReplay.apply.requestId, 'apply-2');

  await service.close();
  const reopened = h.open();
  const durable = await reopened.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(durable.status, 'applied');
  assert.equal(durable.apply.requestId, 'apply-2');
});

test('a candidate is refused for ledger capacity before it pins anything', async t => {
  const LIMIT = 8 * 1024 * 1024;
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  let service = h.open();
  const begun = await begin(service);
  const filler = await begin(service, { requestId: 'begin-2' });
  await service.close();

  // A valid but enormous diagnostic list on an UNRELATED attempt leaves no room
  // for one more decision anywhere in this store.
  const file = path.join(h.directory, 'integration-attempts.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  const target = LIMIT - 256;
  const count = Math.floor((target - Buffer.byteLength(JSON.stringify(ledger), 'utf8')) / 2051);
  const paths = Array.from({ length: count }, (_, index) => `${String(index).padStart(10, '0')}${'x'.repeat(2038)}`);
  ledger.attempts.find(entry => entry.id === filler.attemptId).conflicts = [
    { paths: paths.slice(0, 2000), inputIds: [], reason: 'overlap' },
    { paths: paths.slice(2000), inputIds: [], reason: 'overlap' }
  ].filter(group => group.paths.length > 0);
  const text = JSON.stringify(ledger);
  assert.ok(Buffer.byteLength(text, 'utf8') < LIMIT);
  await fs.writeFile(file, text);

  service = h.open();
  const retains = h.state.retains.length;
  const verifies = h.state.verifies;
  await assert.rejects(service.invoke({
    action: 'candidate', ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId,
    expectedRevision: begun.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'capacity_exceeded');
  // The REAL completed record is measured inside the under-lock verifier, so the
  // port ran that verifier and then committed no pin at all, and the ledger was
  // never rewritten.
  assert.equal(h.state.verifies, verifies + 1);
  assert.equal(h.state.retains.length, retains);
  assert.equal(await fs.readFile(file, 'utf8'), text);
  const status = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(status.status, 'ready');
  assert.equal(status.candidate, null);
  assert.equal(status.revision, begun.revision);
});

test('a candidate is refused when the retention port never runs the verifier', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  // A port that ignores the callback cannot prove provenance before pinning, so
  // the decision is refused instead of being recorded unverified.
  const original = h.ports.retainArtifacts;
  h.ports.retainArtifacts = async (scope, refs, portAuthorize) => original(scope, refs, portAuthorize);
  const service = h.open();
  const begun = await begin(service);
  await assert.rejects(service.invoke({
    action: 'candidate', ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId,
    expectedRevision: begun.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'retention_contract');
  const status = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(status.status, 'ready');
  assert.equal(status.candidate, null);
});

// ---------------------------------------------------------------------------
// Publication journal latch and storage-pressure recovery.
//
// The ledger owns the durable `publicationJournalEstablished` latch. It reaches
// the publication port as the awaited `onJournalReady` callback, so it is
// written BEFORE any workspace effect, kept across conflict retries and reopens,
// and a missing journal then becomes terminal instead of a fresh plan over the
// user's files. A storage_exhausted admission denial may resolve only the exact
// CURRENT applying receipt, and only in proof-only mode.
// ---------------------------------------------------------------------------

/** Wraps the harness publish port so the fifth `options` argument is observed. */
function observePublish(h) {
  const underlying = h.ports.publish;
  const seen = [];
  const ledgerOf = async () => JSON.parse(
    await fs.readFile(path.join(h.directory, 'integration-attempts.json'), 'utf8')
  ).attempts[0].publicationJournalEstablished ?? null;
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    const record = {
      requireJournal: options.requireJournal,
      recoveryOnly: options.recoveryOnly,
      checkpoint: await ledgerOf()
    };
    seen.push(record);
    check();
    await options.onJournalReady();
    record.latched = await ledgerOf();
    return underlying(scope, baseSnapshotId, ref, check);
  };
  return seen;
}

test('the journal latch is durable before any effect and survives conflict retries and reopens', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishStates: [
      { state: 'conflict', applied: [], conflicts: [{ path: 'src/out.txt', reason: 'open editor' }] },
      { state: 'applied', applied: ['src/out.txt'], conflicts: [] }
    ]
  });
  const seen = observePublish(h);
  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const first = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  assert.equal(first.status, 'accepted');
  assert.equal(first.apply.state, 'conflict');
  assert.equal(first.publicationJournalEstablished, true);
  // The first checkpoint is explicitly false, and the port's awaited latch makes
  // the record durably true before it may perform any effect.
  assert.deepEqual(seen, [{ requireJournal: false, recoveryOnly: false, checkpoint: false, latched: true }]);

  // The conflict retry KEEPS the latch, so the journal is required from then on.
  const retried = await service.invoke({
    ...controls, action: 'apply', expectedRevision: first.revision, requestId: 'apply-2'
  }, authorize);
  assert.equal(retried.status, 'applied');
  assert.deepEqual(seen.map(entry => [entry.requireJournal, entry.recoveryOnly]), [[false, false], [true, false]]);
  assert.equal(seen[1].checkpoint, true, 'the latch is never downgraded');
  assert.equal(seen[1].latched, true);

  // ...and reopening the store keeps it too.
  await service.close();
  service = h.open();
  const reopened = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(reopened.status, 'applied');
  assert.equal(reopened.publicationJournalEstablished, true);
  await service.close();
});

test('a storage_exhausted fallback resolves only the exact current applying receipt', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const seen = [];
  const underlying = h.ports.publish;
  let failNext = true;
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    seen.push({ requireJournal: options.requireJournal, recoveryOnly: options.recoveryOnly });
    check();
    if (failNext) {
      failNext = false;
      // The journal is durably established, and the store then goes away.
      await options.onJournalReady();
      throw new WorkerError('publish_failed', 'The publication store went away after its journal.');
    }
    return underlying(scope, baseSnapshotId, ref, check);
  };
  const service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  await assert.rejects(service.invoke(applyArgs, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');
  const applying = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(applying.status, 'applying');
  assert.equal(applying.publicationJournalEstablished, true);

  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const applyReceipts = async () => JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
    .attempts[0].requests.filter(entry => entry.action === 'apply').length;
  const held = await applyReceipts();
  const durable = await fs.readFile(ledgerPath, 'utf8');
  const storage = new WorkerError('storage_exhausted', 'The storage governor denied admission to this action.');
  const refused = [
    ['a stale request id', { ...applyArgs, requestId: 'apply-0' }],
    ['a newer expected revision', { ...applyArgs, expectedRevision: applying.revision }],
    ['a release', {
      ...controls, action: 'release', expectedRevision: applying.revision, requestId: 'release-1',
      abandon: true, releaseRetention: true
    }],
    ['a status read', statusArgs({ attemptId: begun.attemptId })]
  ];
  for (const [label, args] of refused) {
    await assert.rejects(service.invoke(args, authorize, storage), error => error === storage, label);
  }
  const other = new WorkerError('denied', 'A different admission failure.');
  await assert.rejects(service.invoke(applyArgs, authorize, other), error => error === other);
  assert.equal(seen.length, 1, 'a refused fallback attempts no publication');
  assert.equal(h.state.releases, 0, 'a refused fallback releases nothing');
  assert.equal(await applyReceipts(), held, 'a refused fallback writes no receipt');
  assert.equal(await fs.readFile(ledgerPath, 'utf8'), durable, 'a refused fallback writes nothing at all');

  // Only the exact CURRENT applying receipt re-enters its journal, in proof-only
  // mode and with the established journal required.
  const recovered = await service.invoke(applyArgs, authorize, storage);
  assert.equal(recovered.status, 'applied');
  assert.deepEqual(seen, [
    { requireJournal: false, recoveryOnly: false },
    { requireJournal: true, recoveryOnly: true }
  ]);
  assert.equal(await applyReceipts(), held, 'the fallback replays the recorded receipt');
  assert.equal(recovered.apply.state, 'applied');
  await service.close();
});

test('storage recovery of an attempt that never established a journal stays retryable', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishFailures: 1,
    publishStates: [{
      state: 'conflict',
      applied: [],
      conflicts: [{ path: '.', reason: 'recovery pending: retry with a new request once storage is available.' }]
    }]
  });
  const seen = [];
  const underlying = h.ports.publish;
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    seen.push({ requireJournal: options.requireJournal, recoveryOnly: options.recoveryOnly });
    check();
    return underlying(scope, baseSnapshotId, ref, check);
  };
  const service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  await assert.rejects(service.invoke(applyArgs, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');
  const applying = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(applying.publicationJournalEstablished, false, 'a first checkpoint is explicitly false');

  const storage = new WorkerError('storage_exhausted', 'The storage governor denied admission to this action.');
  const recovered = await service.invoke(applyArgs, authorize, storage);
  // Nothing was ever established, so a missing journal may still be replanned:
  // the recovery reports a retryable conflict and the attempt is accepted again.
  assert.equal(recovered.status, 'accepted');
  assert.equal(recovered.apply.state, 'conflict');
  assert.equal(recovered.publicationJournalEstablished, false);
  assert.deepEqual(seen, [
    { requireJournal: false, recoveryOnly: false },
    { requireJournal: false, recoveryOnly: true }
  ]);
  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: recovered.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned', 'release stays available');
  await service.close();
});

test('a legacy record without the latch requires its journal and initializes a reported conflict', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishFailures: 1
  });
  const seen = observePublish(h);
  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  await assert.rejects(service.invoke(applyArgs, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');
  await service.close();
  assert.deepEqual(seen.map(entry => [entry.requireJournal, entry.checkpoint]), [[false, false]]);

  // A ledger written by an OLDER build carries no latch field at all.
  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const legacy = async mutate => {
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    for (const attempt of ledger.attempts) {
      delete attempt.publicationJournalEstablished;
      if (mutate) {
        mutate(attempt);
      }
    }
    await fs.writeFile(ledgerPath, JSON.stringify(ledger));
  };

  await legacy();
  service = h.open();
  const legacyApplying = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(legacyApplying.status, 'applying');
  assert.equal(legacyApplying.publicationJournalEstablished, null, 'an absent latch is uncertain, never false');
  const resumed = await service.invoke(applyArgs, authorize);
  assert.equal(resumed.status, 'applied');
  assert.deepEqual(seen.at(-1), { requireJournal: true, recoveryOnly: false, checkpoint: null, latched: true });

  // A legacy accepted conflict that reports applied work proves a journal
  // existed, so the new checkpoint is initialized to true before the port runs.
  await legacy(attempt => {
    attempt.status = 'accepted';
    attempt.revision += 1;
    attempt.apply = {
      state: 'conflict',
      requestId: 'apply-1',
      applied: ['src/out.txt'],
      conflicts: [{ path: 'src/out.txt', reason: 'open editor' }],
      at: new Date().toISOString()
    };
  });
  await service.close();
  service = h.open();
  const legacyConflict = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(legacyConflict.status, 'accepted');
  assert.equal(legacyConflict.publicationJournalEstablished, null);
  const retried = await service.invoke({
    ...controls, action: 'apply', expectedRevision: legacyConflict.revision, requestId: 'apply-2'
  }, authorize);
  assert.equal(retried.status, 'applied');
  assert.equal(retried.publicationJournalEstablished, true, 'recorded applied paths prove a journal existed');
  assert.equal(seen.at(-1).requireJournal, true);
  assert.equal(seen.at(-1).checkpoint, true, 'the initialized latch is durable on the new checkpoint');
  await service.close();
});

test('a lost journal after a partial apply is terminal through the durable ledger latch', async t => {
  // End-to-end: the ledger drives the REAL publication module through the same
  // option contract the host worker implements (identity, changes, journal path
  // and the ledger's own requireJournal/onJournalReady/recoveryOnly).
  const crypto = require('node:crypto');
  const fsSync = require('node:fs');
  const { publishIntegration } = require(path.join(BUILD, 'integration-publication'));
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const entryOf = bytes => ({ type: 'file', hash: hash(bytes), size: bytes.length, mode: 0o644 });
  const exists = target => fs.lstat(target).then(() => true, () => false);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-latch-workspace-'));
  const store = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-latch-journal-'));
  const journalPath = path.join(store, 'publication.json');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(store, { recursive: true, force: true });
  });
  const baseA = Buffer.from('latch a base\n');
  const baseB = Buffer.from('latch b base\n');
  const nextA = Buffer.from('latch a next\n');
  const nextB = Buffer.from('latch b next\n');
  const targetA = path.join(root, 'a.txt');
  const targetB = path.join(root, 'b.txt');
  await fs.writeFile(targetA, baseA);
  await fs.writeFile(targetB, baseB);
  const changes = [
    { path: 'a.txt', before: entryOf(baseA), after: entryOf(nextA) },
    { path: 'b.txt', before: entryOf(baseB), after: entryOf(nextB) }
  ];
  const contents = { 'a.txt': nextA, 'b.txt': nextB };
  // The editor opens b.txt only once a.txt is already applied, so the run stops
  // with a durable journal and b.txt still pending.
  let armed = true;
  const openDocuments = () => {
    if (!armed) {
      return [];
    }
    let aNow;
    let bNow;
    try {
      aNow = fsSync.readFileSync(targetA);
      bNow = fsSync.readFileSync(targetB);
    } catch {
      return [];
    }
    return aNow.equals(nextA) && bNow.equals(baseB)
      ? [{ path: targetB, text: 'opened after preflight', version: 1 }]
      : [];
  };

  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    check();
    return publishIntegration({
      root,
      journalPath,
      identity: `integration-attempt:${scope.attemptId}`,
      changes,
      read: async key => Buffer.from(contents[key]),
      openDocuments,
      authorize: check,
      ...options
    });
  };
  const service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const first = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  armed = false;
  assert.equal(first.status, 'accepted');
  assert.equal(first.apply.state, 'conflict');
  assert.deepEqual(first.apply.applied, ['a.txt']);
  assert.equal(first.publicationJournalEstablished, true, 'the journal is durable before the effect');
  assert.deepEqual(await fs.readFile(targetA), nextA, 'a.txt really was applied');
  assert.deepEqual(await fs.readFile(targetB), baseB, 'b.txt was never started');

  // The user restores a.txt to exactly the bytes the plan captured as `before`,
  // and the journal is then lost.
  await fs.writeFile(targetA, baseA);
  const restored = await fs.stat(targetA);
  await fs.rm(journalPath);

  // The established latch makes the missing journal terminal: no workspace
  // write, no replacement journal, and only release may follow.
  const terminal = await service.invoke({
    ...controls, action: 'apply', expectedRevision: first.revision, requestId: 'apply-2'
  }, authorize);
  assert.equal(terminal.status, 'interrupted');
  assert.equal(terminal.apply.state, 'interrupted');
  assert.match(terminal.apply.conflicts[0].reason, /journal missing/);
  assert.deepEqual(await fs.readFile(targetA), baseA, 'the restored user bytes survive');
  assert.equal((await fs.stat(targetA)).mtimeMs, restored.mtimeMs, 'no effect touched the restored file');
  assert.deepEqual(await fs.readFile(targetB), baseB, 'the pending file is untouched');
  assert.equal(await exists(journalPath), false, 'no replacement journal is written');

  await assert.rejects(service.invoke({
    ...controls, action: 'apply', expectedRevision: terminal.revision, requestId: 'apply-3'
  }, authorize), error => error instanceof WorkerError && error.code === 'attempt_interrupted');
  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: terminal.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned', 'release stays available');
  assert.equal(h.state.releases, 1);
  await service.close();
});

// ---------------------------------------------------------------------------
// Publication journal revision floor and the narrow legacy migration.
//
// The ledger also owns the durable `publicationJournalRevision` floor: the port
// reports the revision of each durable per-file intent through the awaited
// `onJournalIntent` checkpoint, and the floor is persisted BEFORE that file's
// first workspace effect, never lowered, never bumped into the attempt revision
// and handed back as `minimumJournalRevision` on every later call. A legacy
// record with no latch may plan a fresh journal again ONLY from a completed,
// trustworthy zero-effect result - the reported open-editor preflight conflict.
// ---------------------------------------------------------------------------

/** Wraps the publish port to observe the ledger's own per-file intent checkpoint. */
function observeJournalIntents(h) {
  const underlying = h.ports.publish;
  const seen = [];
  const read = async id => JSON.parse(
    await fs.readFile(path.join(h.directory, 'integration-attempts.json'), 'utf8')
  ).attempts.find(entry => entry.id === id);
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    const record = {
      requireJournal: options.requireJournal,
      recoveryOnly: options.recoveryOnly,
      floor: options.minimumJournalRevision ?? null,
      checkpoint: (await read(scope.attemptId)).publicationJournalRevision ?? null
    };
    seen.push(record);
    check();
    await options.onJournalReady();
    const ready = await read(scope.attemptId);
    record.latched = ready.publicationJournalEstablished ?? null;
    record.revisionBeforeIntents = ready.revision;
    // Two durable per-file intents, each reported BEFORE that file's effect.
    await options.onJournalIntent(4);
    const first = await read(scope.attemptId);
    record.firstFloor = first.publicationJournalRevision ?? null;
    record.revisionAfterIntent = first.revision;
    await options.onJournalIntent(6);
    record.secondFloor = (await read(scope.attemptId)).publicationJournalRevision ?? null;
    // A lower report never lowers the floor.
    await options.onJournalIntent(5);
    record.loweredFloor = (await read(scope.attemptId)).publicationJournalRevision ?? null;
    return underlying(scope, baseSnapshotId, ref, check);
  };
  return seen;
}

test('the journal revision floor is durable before each effect, monotonic and kept across retries', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishStates: [
      {
        state: 'conflict',
        applied: [],
        conflicts: [{ path: 'src/out.txt', reason: 'open editor: src/out.txt is open in an editor; close or save it before publication.' }]
      },
      { state: 'applied', applied: ['src/out.txt'], conflicts: [] }
    ]
  });
  const seen = observeJournalIntents(h);
  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const first = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  assert.equal(first.status, 'accepted');
  assert.equal(first.apply.state, 'conflict');
  assert.equal(first.publicationJournalEstablished, true);
  // Nothing is known yet on the first decision, the checkpoint itself is durable
  // before the port may perform an effect, and the internal checkpoint never
  // bumps the external attempt revision.
  assert.deepEqual(seen[0], {
    requireJournal: false,
    recoveryOnly: false,
    floor: null,
    checkpoint: null,
    latched: true,
    revisionBeforeIntents: accepted.revision + 1,
    firstFloor: 4,
    revisionAfterIntent: accepted.revision + 1,
    secondFloor: 6,
    loweredFloor: 6
  });
  // Only the terminal record bumps the revision, and it keeps the floor.
  assert.equal(first.publicationJournalRevision, 6);
  assert.equal(first.revision, accepted.revision + 2);

  // The next decision hands the persisted floor back as its minimum revision.
  const retried = await service.invoke({
    ...controls, action: 'apply', expectedRevision: first.revision, requestId: 'apply-2'
  }, authorize);
  assert.equal(retried.status, 'applied');
  assert.equal(seen[1].requireJournal, true);
  assert.equal(seen[1].floor, 6);
  assert.equal(seen[1].checkpoint, 6);
  assert.equal(seen[1].secondFloor, 6);
  assert.equal(retried.publicationJournalRevision, 6);

  // ...and reopening the store keeps the floor.
  await service.close();
  service = h.open();
  const reopened = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(reopened.status, 'applied');
  assert.equal(reopened.publicationJournalEstablished, true);
  assert.equal(reopened.publicationJournalRevision, 6);
  await service.close();
});

test('a per-file intent checkpoint stays writable near the ledger cap and keeps the report room', async t => {
  const LIMIT = 8 * 1024 * 1024;
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishFailures: 1
  });
  let service = h.open();
  const inFlight = await begin(service);
  const accepted = await applyReady(service, inFlight);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: inFlight.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  await assert.rejects(service.invoke(applyArgs, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');
  const unrelated = await begin(service, { requestId: 'begin-2' });
  await service.close();

  // Fill the ledger with a still-valid diagnostic list so it sits just under its
  // byte bound while the room for an in-flight report and a release is reserved.
  const file = path.join(h.directory, 'integration-attempts.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  const target = LIMIT - 20 * 1024;
  const count = Math.floor((target - Buffer.byteLength(JSON.stringify(ledger), 'utf8')) / 2051);
  ledger.attempts.find(entry => entry.id === inFlight.attemptId).conflicts = [{
    paths: Array.from({ length: count }, (_, index) => `${String(index).padStart(10, '0')}${'x'.repeat(2038)}`),
    inputIds: [],
    reason: 'overlap'
  }];
  await fs.writeFile(file, JSON.stringify(ledger));
  // The exact room the ledger reserves for an in-flight publication: its bounded
  // terminal report, the remaining growth of the revision floor field and one
  // explicit release per attempt.
  const reserveTarget = LIMIT - (32 * 1024 + 1024 + Buffer.byteLength(`,"publicationJournalRevision":${Number.MAX_SAFE_INTEGER}`, 'utf8') + 2 * 1024);
  const applying = ledger.attempts.find(entry => entry.id === inFlight.attemptId);
  // Trim the filler down to the exact point the ledger's own reservation allows.
  while (Buffer.byteLength(JSON.stringify(ledger), 'utf8') > reserveTarget) {
    applying.conflicts[0].paths.pop();
  }
  const room = reserveTarget - Buffer.byteLength(JSON.stringify(ledger), 'utf8');
  if (room > 4) {
    // One more path costs exactly its own length plus the comma and quotes.
    applying.conflicts[0].paths.push('p'.repeat(room - 3));
  }
  await fs.writeFile(file, JSON.stringify(ledger));
  const filled = await fs.readFile(file, 'utf8');
  // The ledger sits within a few bytes of the point where its own reservation
  // still holds, so only the reserved floor growth can pay for the checkpoint.
  const remaining = reserveTarget - Buffer.byteLength(filled, 'utf8');
  assert.ok(remaining >= 0 && remaining <= 4, `the ledger sits at its reserved boundary (${remaining} bytes left)`);
  assert.ok(Buffer.byteLength(filled, 'utf8') < LIMIT);
  assert.ok(Buffer.byteLength(filled, 'utf8') > LIMIT - 64 * 1024);

  const checkpoints = [];
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    const record = { floor: options.minimumJournalRevision ?? null };
    checkpoints.push(record);
    check();
    await options.onJournalReady();
    const read = async () => JSON.parse(await fs.readFile(file, 'utf8'))
      .attempts.find(entry => entry.id === inFlight.attemptId);
    record.beforeIntent = (await read()).publicationJournalRevision ?? null;
    // The widest journal revision a journal may carry: its whole field has to fit
    // in the room this reservation keeps, even at the ledger cap.
    await options.onJournalIntent(Number.MAX_SAFE_INTEGER);
    const widened = await read();
    record.afterIntent = widened.publicationJournalRevision ?? null;
    record.revisionAfterIntent = widened.revision;
    return {
      state: 'conflict',
      applied: [],
      conflicts: [{ path: 'src/out.txt', reason: 'open editor: src/out.txt is still open.' }]
    };
  };

  service = h.open();
  // An unrelated save is refused before the checkpoint: the report room is held.
  await assert.rejects(service.invoke({
    action: 'candidate', ownerId: OWNER, teamId: TEAM, attemptId: unrelated.attemptId,
    expectedRevision: unrelated.revision, requestId: 'cand-2', artifact: ART_C
  }, authorize), error => error instanceof WorkerError && error.code === 'capacity_exceeded');

  const resolved = await service.invoke(applyArgs, authorize);
  // This attempt's injected conflict list sits deliberately near the ledger cap, so
  // its complete view exceeds the tool's reply budget: the exact apply
  // acknowledgment is the bounded summary, whose controls and exact counts carry
  // the same durable stage, journal revision and recorded report shape.
  assert.equal(resolved.truncated, true);
  assert.equal(resolved.controls.applyState, 'conflict');
  assert.equal(resolved.controls.publicationJournalRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(resolved.summary.counts.applyApplied, 0);
  assert.equal(resolved.summary.counts.applyConflicts, 1);
  assert.equal(resolved.summary.counts.conflictGroups, 1);
  assert.equal(resolved.summary.counts.conflictPaths, resolved.summary.counts.conflictGroupPaths);
  assert.deepEqual(checkpoints, [{
    floor: null,
    beforeIntent: null,
    afterIntent: Number.MAX_SAFE_INTEGER,
    revisionAfterIntent: accepted.revision + 1
  }]);
  // The checkpoint spent only its own reserved growth: the bounded terminal
  // report was still saved and the ledger stayed inside its bound.
  assert.equal(resolved.status, 'accepted');
  assert.ok(Buffer.byteLength(await fs.readFile(file, 'utf8'), 'utf8') < LIMIT);

  // Release still fits in the room that was kept for it.
  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: resolved.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(h.state.releases, 1);
  await service.close();
});

test('a legacy pre-latch editor preflight conflict with no journal retries fresh once the editor is closed', async t => {
  const crypto = require('node:crypto');
  const { publishIntegration } = require(path.join(BUILD, 'integration-publication'));
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const entryOf = bytes => ({ type: 'file', hash: hash(bytes), size: bytes.length, mode: 0o644 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-prelatch-workspace-'));
  const store = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-prelatch-journal-'));
  const journalPath = path.join(store, 'publication.json');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(store, { recursive: true, force: true });
  });
  const base = Buffer.from('pre-latch base\r\nwith CRLF\r\n');
  const next = Buffer.from('pre-latch next\r\nwith CRLF\r\n');
  const target = path.join(root, 'notes.txt');
  await fs.writeFile(target, base);
  const changes = [{ path: 'notes.txt', before: entryOf(base), after: entryOf(next) }];
  let editorOpen = true;

  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const seen = [];
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    seen.push({ requireJournal: options.requireJournal, floor: options.minimumJournalRevision ?? null });
    check();
    return publishIntegration({
      root,
      journalPath,
      identity: `integration-attempt:${scope.attemptId}`,
      changes,
      read: async () => Buffer.from(next),
      // Document text is never read: only the open location is reported.
      openDocuments: () => (editorOpen ? [{ path: target, text: '', version: 1 }] : []),
      authorize: check,
      ...options
    });
  };

  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const first = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  // The real port refuses at its read-only preflight, before its first journal
  // revision: no journal exists and no effect was started.
  assert.equal(first.status, 'accepted');
  assert.equal(first.apply.state, 'conflict');
  assert.deepEqual(first.apply.applied, []);
  assert.equal(first.apply.conflicts.length, 1);
  assert.match(first.apply.conflicts[0].reason, /^open editor: /);
  await assert.rejects(fs.stat(journalPath), error => error.code === 'ENOENT');
  assert.deepEqual(await fs.readFile(target), base, 'the preflight conflict changed nothing');
  await service.close();

  // A ledger written by an OLDER build carries no latch field at all: the reported
  // editor preflight conflict is the ONLY history of this attempt.
  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  const record = ledger.attempts.find(entry => entry.id === begun.attemptId);
  delete record.publicationJournalEstablished;
  assert.equal(record.publicationJournalRevision, undefined);
  assert.equal(record.requests.filter(entry => entry.action === 'apply').length, 1);
  assert.equal(record.failure, undefined);
  await fs.writeFile(ledgerPath, JSON.stringify(ledger));

  service = h.open();
  const legacy = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(legacy.publicationJournalEstablished, null, 'an absent latch is still reported as unknown');

  // The editor is closed: the zero-effect result is trustworthy, so this legacy
  // record may plan a FRESH journal instead of being stranded on a missing one.
  editorOpen = false;
  const retried = await service.invoke({
    ...controls, action: 'apply', expectedRevision: legacy.revision, requestId: 'apply-2'
  }, authorize);
  assert.equal(seen.at(-1).requireJournal, false, 'a proven zero-effect legacy result may replan');
  assert.equal(seen.at(-1).floor, null);
  assert.equal(retried.status, 'applied');
  assert.deepEqual(retried.apply.applied, ['notes.txt']);
  assert.equal(retried.publicationJournalEstablished, true);
  assert.deepEqual(await fs.readFile(target), next, 'the closed-editor retry published the approved bytes');
  await fs.stat(journalPath);
  await service.close();
});

test('an uncertain legacy zero-count result is never treated as safe', async t => {
  const editorReason = 'open editor: C:\\workspace\\project\\src\\out.txt is open in an editor; close or save it before publication.';
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishStates: [
      { state: 'conflict', applied: [], conflicts: [{ path: 'src/out.txt', reason: editorReason }] },
      { state: 'applied', applied: ['src/out.txt'], conflicts: [] }
    ]
  });
  const seen = observePublish(h);
  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  await service.close();

  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const baseline = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  const baselineRecord = baseline.attempts.find(entry => entry.id === begun.attemptId);
  assert.equal(baselineRecord.apply.state, 'conflict');
  assert.equal(baselineRecord.apply.applied.length, 0);

  const cases = [
    ['the unchanged editor preflight conflict', () => undefined, false],
    ['an arbitrary zero-count journal error', attempt => {
      attempt.apply.conflicts = [{
        path: '.',
        reason: 'journal conflict: the publication journal is not valid JSON; inspect it before publishing again.'
      }];
    }, true],
    ['a truncated preview', attempt => {
      attempt.apply.truncated = true;
    }, true],
    ['an applied count without applied paths', attempt => {
      attempt.apply.appliedCount = 1;
    }, true],
    ['a second apply receipt', attempt => {
      attempt.requests.push({ action: 'apply', requestId: 'apply-0', fingerprint: 'ab'.repeat(32) });
    }, true],
    ['an ambiguous failure record', attempt => {
      attempt.failure = { code: 'publish_failed', message: 'The publication journal is unavailable.', at: CREATED };
    }, true],
    ['a mixed editor and journal conflict list', attempt => {
      attempt.apply.conflicts = [
        { path: 'src/out.txt', reason: editorReason },
        { path: 'src/other.txt', reason: 'journal conflict: the plan is incomplete.' }
      ];
    }, true]
  ];

  let legacyRevision = 0;
  for (const [label, mutate, requiresJournal] of cases) {
    const ledger = JSON.parse(JSON.stringify(baseline));
    const record = ledger.attempts.find(entry => entry.id === begun.attemptId);
    delete record.publicationJournalEstablished;
    mutate(record);
    await fs.writeFile(ledgerPath, JSON.stringify(ledger));
    legacyRevision = record.revision;
    service = h.open();
    const resolved = await service.invoke({
      ...controls, action: 'apply', expectedRevision: legacyRevision, requestId: `apply-${label.replace(/\W+/g, '-')}`
    }, authorize);
    assert.equal(seen.at(-1).requireJournal, requiresJournal, `${label}: journal requirement`);
    if (requiresJournal && label !== 'an applied count without applied paths') {
      assert.equal(seen.at(-1).checkpoint, null, `${label}: the latch stays absent`);
    }
    if (label === 'an applied count without applied paths') {
      // A reported applied count is itself proof that a journal existed, so this
      // one is initialized to `true` - and still requires its journal.
      assert.equal(seen.at(-1).checkpoint, true, `${label}: a reported count proves a journal`);
    }
    assert.ok(['accepted', 'applied'].includes(resolved.status), label);
    await service.close();
  }
});

test('a restored prior journal after a partial apply is stale and preserves the user bytes', async t => {
  const crypto = require('node:crypto');
  const fsSync = require('node:fs');
  const { publishIntegration } = require(path.join(BUILD, 'integration-publication'));
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const entryOf = bytes => ({ type: 'file', hash: hash(bytes), size: bytes.length, mode: 0o644 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-restored-workspace-'));
  const store = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-restored-journal-'));
  const journalPath = path.join(store, 'publication.json');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(store, { recursive: true, force: true });
  });
  const baseA = Buffer.from('restored a base\r\n');
  const baseB = Buffer.from('restored b base\r\n');
  const nextA = Buffer.from('restored a next\r\n');
  const nextB = Buffer.from('restored b next\r\n');
  const targetA = path.join(root, 'a.txt');
  const targetB = path.join(root, 'b.txt');
  await fs.writeFile(targetA, baseA);
  await fs.writeFile(targetB, baseB);
  const changes = [
    { path: 'a.txt', before: entryOf(baseA), after: entryOf(nextA) },
    { path: 'b.txt', before: entryOf(baseB), after: entryOf(nextB) }
  ];
  const contents = { 'a.txt': nextA, 'b.txt': nextB };
  // The editor opens b.txt only once a.txt is already applied, so the run stops
  // with a durable journal, a.txt applied and b.txt still pending.
  let armed = true;
  const openDocuments = () => {
    if (!armed) {
      return [];
    }
    let aNow;
    let bNow;
    try {
      aNow = fsSync.readFileSync(targetA);
      bNow = fsSync.readFileSync(targetB);
    } catch {
      return [];
    }
    return aNow.equals(nextA) && bNow.equals(baseB)
      ? [{ path: targetB, text: 'opened after preflight', version: 1 }]
      : [];
  };

  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const seen = [];
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    seen.push({ requireJournal: options.requireJournal, floor: options.minimumJournalRevision ?? null });
    check();
    return publishIntegration({
      root,
      journalPath,
      identity: `integration-attempt:${scope.attemptId}`,
      changes,
      read: async key => Buffer.from(contents[key]),
      openDocuments,
      authorize: check,
      ...options
    });
  };
  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const attempt = async () => JSON.parse(await fs.readFile(ledgerPath, 'utf8')).attempts[0];

  let service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const first = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1'
  }, authorize);
  armed = false;
  assert.equal(first.apply.state, 'conflict');
  assert.deepEqual(first.apply.applied, ['a.txt']);
  assert.equal(first.publicationJournalEstablished, true);
  // The floor was recorded for the durable per-file intent of a.txt BEFORE its
  // effect, so a journal older than it is provably stale.
  const floor = first.publicationJournalRevision;
  assert.equal(typeof floor, 'number', 'the ledger persists the revision of every durable per-file intent');
  assert.ok(floor >= 1);

  // The user restores a.txt to the bytes the plan captured as `before`, and an
  // OLDER copy of the journal is restored beside it: it still claims that a.txt
  // is pending, so replaying it would overwrite the user's restored bytes.
  await fs.writeFile(targetA, baseA);
  const restored = await fs.stat(targetA);
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const priorJournal = {
    ...journal,
    revision: 1,
    entries: journal.entries.map(entry => ({ ...entry, state: 'pending' }))
  };
  assert.ok(priorJournal.revision < floor, 'the restored journal is older than the durable floor');
  const priorText = JSON.stringify(priorJournal);
  await fs.writeFile(journalPath, priorText);

  const stale = await service.invoke({
    ...controls, action: 'apply', expectedRevision: first.revision, requestId: 'apply-2'
  }, authorize);
  // The floor travels to the port, which must fail closed on the stale journal.
  assert.equal(seen.at(-1).floor, floor);
  assert.notEqual(stale.apply.state, 'applied', 'a stale journal is never replayed');
  assert.equal(stale.status, 'interrupted');
  assert.deepEqual(await fs.readFile(targetA), baseA, 'the restored user bytes survive');
  assert.equal((await fs.stat(targetA)).mtimeMs, restored.mtimeMs, 'no effect touched the restored file');
  assert.deepEqual(await fs.readFile(targetB), baseB, 'the pending file is untouched');
  assert.equal(await fs.readFile(journalPath, 'utf8'), priorText, 'the stale journal is not rewritten');
  assert.equal(stale.publicationJournalRevision, floor, 'the floor is kept through the terminal outcome');

  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: stale.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(released.publicationJournalRevision, floor, 'release keeps the floor');
  assert.equal(h.state.releases, 1);
  await service.close();
  service = h.open();
  assert.equal((await attempt()).publicationJournalRevision, floor);
  await service.close();
});

test('a denied proof-only fallback never bootstraps an uninitialized namespace', async t => {
  // A never-opened store has no ledger and no namespace marker. The normal
  // loader bootstraps both, so the fallback must be admitted READ-ONLY and
  // refused when the namespace does not exist yet.
  const h = await harness(t, { sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }] });
  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const markerPath = path.join(h.directory, 'integration-attempts.namespace.json');
  const exists = target => fs.lstat(target).then(() => true, () => false);
  assert.deepEqual(await fs.readdir(h.directory), [], 'the never-opened store starts empty');
  // Constructing a service touches nothing; only invoke() opens the store.
  const service = h.open();

  const storage = new WorkerError('storage_exhausted', 'The storage governor denied admission to this action.');
  const applyArgs = {
    action: 'apply', ownerId: OWNER, teamId: TEAM, attemptId: 'ab'.repeat(32),
    expectedRevision: 1, requestId: 'apply-1'
  };
  const untouched = async label => {
    assert.deepEqual(await fs.readdir(h.directory), [], `${label}: the store directory stays empty`);
    assert.equal(await exists(ledgerPath), false, `${label}: no ledger is created`);
    assert.equal(await exists(markerPath), false, `${label}: no namespace marker is created`);
  };
  await untouched('before the fallback');

  // A recovery request that is not the exact shape is refused before loading.
  const other = new WorkerError('denied', 'A different admission failure.');
  await assert.rejects(service.invoke(applyArgs, authorize, other), error => error === other);
  await assert.rejects(service.invoke(statusArgs({ attemptId: 'ab'.repeat(32) }), authorize, storage),
    error => error === storage);
  await untouched('a non-apply or non-storage recovery request');
  assert.equal(h.state.publishes.length, 0, 'a refused fallback attempts no publication');

  // The exact shape is refused too: an uninitialized namespace may not be read
  // as "no attempts" and may not be created by a denied call.
  await assert.rejects(service.invoke(applyArgs, authorize, storage), error => error === storage);
  await untouched('the exact recovery shape on an uninitialized store');
  // ...and repeating it neither bootstraps nor caches anything.
  await assert.rejects(service.invoke(applyArgs, authorize, storage), error => error === storage);
  await untouched('a repeated denied fallback');

  // The refusal is NOT cached: a later normally-admitted call opens (and here
  // bootstraps) the store exactly as an untouched instance would.
  const begun = await begin(service);
  assert.equal(begun.status, 'ready');
  assert.equal(begun.replayed, false);
  assert.equal(await exists(ledgerPath), true, 'the normal loader bootstraps the ledger');
  assert.equal(await exists(markerPath), true, 'the normal loader bootstraps the marker');
  const durable = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  assert.equal(durable.attempts.length, 1);
  assert.equal(durable.attempts[0].id, begun.attemptId);
  await service.close();
});

test('a proof-only fallback never recreates a ledger or marker through the loader', async t => {
  const h = await harness(t, { sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }] });
  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const markerPath = path.join(h.directory, 'integration-attempts.namespace.json');
  const exists = target => fs.lstat(target).then(() => true, () => false);
  let service = h.open();
  const begun = await begin(service);
  await service.close();
  const marker = await fs.readFile(markerPath, 'utf8');
  assert.equal(await exists(ledgerPath), true, 'the store is initialized');

  // The ledger disappears while the marker - the established namespace - stays.
  await fs.rm(ledgerPath);
  const before = await fs.readdir(h.directory);
  service = h.open();

  // The loader's single marker read observes the marker as present, so a DENIED,
  // proof-only call fails closed on the missing ledger instead of recreating it.
  const storage = new WorkerError('storage_exhausted', 'The storage governor denied admission to this action.');
  const applyArgs = {
    action: 'apply', ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId,
    expectedRevision: 1, requestId: 'apply-1'
  };
  await assert.rejects(service.invoke(applyArgs, authorize, storage),
    error => error instanceof WorkerError && error.code === 'integration_corrupt');
  assert.deepEqual(await fs.readdir(h.directory), before, 'no ledger and no marker is written');
  assert.equal(await fs.readFile(markerPath, 'utf8'), marker, 'the marker is untouched');

  // A later normally-admitted call fails closed identically, still writing nothing.
  await assert.rejects(service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize),
    error => error instanceof WorkerError && error.code === 'integration_corrupt');
  assert.deepEqual(await fs.readdir(h.directory), before);
  assert.equal(await fs.readFile(markerPath, 'utf8'), marker);
  await service.close();
});

// ---------------------------------------------------------------------------
// Conflicted-lineage fixtures.
//
// Attempt A composes a seed whose merge conflict groups are unresolved. Its
// integration-lane worker resolves the conflict over that exact seed, the
// attempt accepts it with the exact conflict paths, and only THAT seal may
// consume the conflicted seed downstream.
// ---------------------------------------------------------------------------

test('details never initializes an empty ledger or publishes a namespace marker', async t => {
  const h = await harness(t, { sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }] });
  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const markerPath = path.join(h.directory, 'integration-attempts.namespace.json');
  const exists = target => fs.lstat(target).then(() => true, () => false);
  assert.deepEqual(await fs.readdir(h.directory), [], 'the never-opened store starts empty');
  // Constructing a service touches nothing; only invoke() opens the store.
  const service = h.open();
  const detailsArgs = {
    action: 'details', ownerId: OWNER, teamId: TEAM, attemptId: 'ab'.repeat(32), expectedRevision: 0
  };
  const untouched = async label => {
    assert.deepEqual(await fs.readdir(h.directory), [], `${label}: the store directory stays empty`);
    assert.equal(await exists(ledgerPath), false, `${label}: no ledger is created`);
    assert.equal(await exists(markerPath), false, `${label}: no namespace marker is published`);
  };
  // A MISSING attempt is refused without establishing anything.
  await assert.rejects(service.invoke(detailsArgs, authorize),
    error => error instanceof WorkerError && error.code === 'attempt_missing');
  await untouched('a details read of a missing attempt');
  // ...and repeating it neither bootstraps nor caches an empty store.
  await assert.rejects(service.invoke({ ...detailsArgs, expectedRevision: 3 }, authorize),
    error => error instanceof WorkerError && error.code === 'attempt_missing');
  await untouched('a repeated details read');

  // The legacy write bootstrap and every normal mutation are unchanged: a later
  // begin still initializes the ledger and its marker on the same instance.
  const begun = await begin(service);
  assert.equal(begun.status, 'ready');
  assert.equal(await exists(ledgerPath), true, 'the normal loader bootstraps the ledger');
  assert.equal(await exists(markerPath), true, 'the normal loader bootstraps the marker');
  // ...and the SAME read now pages the durable record whole.
  const page = await service.invoke({
    ...detailsArgs, attemptId: begun.attemptId, expectedRevision: begun.revision
  }, authorize);
  assert.equal(page.action, 'details');
  assert.equal(page.payload, 'status');
  assert.equal(page.attemptId, begun.attemptId);
  assert.equal(page.status, 'ready');
  assert.equal(page.nextOffset, null);
  assert.equal(page.text, JSON.stringify(await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize)));
  await service.close();
});

test('a details read of a valid unmarked ledger publishes no marker and caches nothing', async t => {
  const h = await harness(t, { sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }] });
  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const markerPath = path.join(h.directory, 'integration-attempts.namespace.json');
  const exists = target => fs.lstat(target).then(() => true, () => false);
  const writer = h.open();
  const begun = await begin(writer);
  await writer.close();
  const ledgerBefore = await fs.readFile(ledgerPath, 'utf8');
  // The empty ledger is published before its marker, so a crash can leave a valid
  // ledger whose namespace marker never became durable.
  await fs.rm(markerPath);
  const reader = h.open();
  const pageArgs = {
    action: 'details', ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId,
    expectedRevision: begun.revision
  };
  const page = await reader.invoke(pageArgs, authorize);
  assert.equal(page.action, 'details');
  assert.equal(page.payload, 'status');
  assert.equal(page.nextOffset, null);
  // The read published no marker and rewrote no ledger.
  assert.equal(await exists(markerPath), false, 'a read publishes no namespace marker');
  assert.equal(await fs.readFile(ledgerPath, 'utf8'), ledgerBefore, 'a read rewrites no ledger');
  // A page DENIED after its load holds no snapshot either: the failure path drops
  // it in the same place, so the store is still unestablished afterwards.
  h.state.deny = true;
  await assert.rejects(reader.invoke(pageArgs, h.authorize),
    error => error instanceof WorkerError && error.code === 'denied');
  h.state.deny = false;
  assert.equal(await exists(markerPath), false, 'a denied page publishes no marker');
  assert.equal(await fs.readFile(ledgerPath, 'utf8'), ledgerBefore, 'a denied page rewrites no ledger');
  const retried = await reader.invoke(pageArgs, h.authorize);
  assert.equal(retried.action, 'details');
  assert.equal(retried.text, page.text, 'the next authorized page re-reads the same durable record');
  // The transient read is NOT cached as a fully opened store: a later normal write
  // still publishes the marker and records its own decision durably.
  const second = await begin(reader, { requestId: 'begin-2' });
  assert.equal(second.status, 'ready');
  assert.equal(await exists(markerPath), true, 'the normal writer publishes the marker');
  assert.equal(await fs.readFile(markerPath, 'utf8'), '{"schema":1,"kind":"integration-attempts"}');
  const durable = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  assert.deepEqual(durable.attempts.map(entry => entry.id), [begun.attemptId, second.attemptId]);
  // The page really was the durable status text, and nothing mutated it.
  const status = await reader.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(status.revision, begun.revision);
  assert.equal(page.text, JSON.stringify(status));
  await reader.close();
});

const CONFLICT = { paths: ['add.cjs'], inputIds: [TASK_A, TASK_B], reason: 'overlap' };
const SEED_C = 'dc'.repeat(32);
const RESOLUTION = ART_C2;
const resolveSource = { taskId: TASK_C, taskRevision: 5, artifact: ART_C2, evidence: [EV_V] };

async function conflictedHarness(t) {
  const control = { chain: [] };
  const seeds = new Map();
  const h = await harness(t, {
    tasks: [
      task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, state: 'accepted', revision: 3 }),
      task(TASK_B, {
        candidates: [ART_B], assigneeWorkerId: WORKER_B, state: 'accepted', revision: 4,
        title: 'Downstream consumer',
        dependencies: [{ taskId: TASK_A, kind: 'artifact' }]
      }),
      task(TASK_C, {
        candidates: [ART_C2], assigneeWorkerId: WORKER_I, state: 'accepted', revision: 5,
        title: 'Resolution'
      })
    ],
    sessions: [
      session(WORKER_A),
      session(WORKER_B),
      session(WORKER_V, { lane: 'validation' }),
      // The resolver is an INTEGRATION-lane worker bound to the conflicted seed.
      session(WORKER_I, { lane: 'integration', snapshotId: SEED_A })
    ],
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A, snapshotId: BASE } },
      { ref: ART_B, options: { workerId: WORKER_B, snapshotId: BASE } },
      { ref: ART_C2, options: { workerId: WORKER_I, snapshotId: SEED_A, revision: 2 } }
    ],
    conflictChain: () => control.chain,
    ancestry: () => control.ancestry ?? { sourceSnapshotId: BASE, ancestors: [] },
    composition: (refs, count, scope) => {
      if (refs.length === 2) {
        // One conflicted seed per two-source attempt: SEED_A, then SEED_C.
        if (!seeds.has(scope.attemptId)) {
          seeds.set(scope.attemptId, seeds.size === 0 ? SEED_A : SEED_C);
        }
        return { snapshot: { id: seeds.get(scope.attemptId) }, baseSnapshotId: BASE, conflicts: [CONFLICT] };
      }
      return { snapshot: { id: SEED_B }, baseSnapshotId: SEED_A, conflicts: [] };
    }
  });
  return { h, control, service: h.open() };
}

test('a conflicted ancestor is consumed only through its exact accepted resolution seal', async t => {
  const { h, control, service } = await conflictedHarness(t);
  const twoSources = [
    { taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] },
    { taskId: TASK_B, taskRevision: 4, artifact: ART_B, evidence: [EV_B] }
  ];

  // --- attempt A composes the conflicted seed, its worker resolves it --------
  const older = await begin(service, { requestId: 'begin-a', sources: twoSources });
  assert.equal(older.status, 'ready');
  assert.equal(older.baseSnapshotId, BASE);
  assert.equal(older.derivedSnapshotId, SEED_A);
  assert.deepEqual(older.conflicts, [CONFLICT]);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: older.attemptId };
  const proposed = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: older.revision, requestId: 'cand-res', artifact: ART_C2
  }, authorize);
  assert.equal(proposed.candidate.lane, 'integration');
  assert.equal(proposed.candidate.submission.snapshotId, SEED_A);
  const validated = await service.invoke({
    ...controls, action: 'validate', expectedRevision: proposed.revision, requestId: 'val-res', evidence: [EV_V]
  }, authorize);
  const accepted = await service.invoke({
    ...controls, action: 'accept', expectedRevision: validated.revision, requestId: 'accept-res',
    resolvedPaths: ['add.cjs']
  }, authorize);
  assert.deepEqual(accepted.acceptance.resolvedPaths, ['add.cjs']);
  // The physical ancestry of the resolver seal: its immediate base is the
  // conflicted seed itself, with that attempt's exact durable provenance.
  control.ancestry = {
    sourceSnapshotId: SEED_A,
    ancestors: [{
      snapshotId: SEED_A,
      provenance: {
        kind: 'integration-seed',
        attemptId: older.attemptId,
        baseSnapshotId: BASE,
        refs: [{ ...ART_A }, { ...ART_B }],
        conflicts: [CONFLICT]
      }
    }]
  };

  const hop = (overrides = {}) => ({
    snapshotId: overrides.snapshotId ?? SEED_A,
    provenance: {
      kind: 'integration-seed',
      attemptId: overrides.attemptId ?? older.attemptId,
      baseSnapshotId: overrides.baseSnapshotId ?? BASE,
      refs: overrides.refs ?? [{ ...ART_A }, { ...ART_B }],
      conflicts: overrides.conflicts ?? [CONFLICT]
    },
    refs: overrides.carried ?? [{ ...ART_C2 }]
  });

  // --- the downstream consumer inherits A with that exact resolution ---------
  control.chain = [hop()];
  const downstream = await service.invoke(beginArgs({
    requestId: 'begin-downstream',
    sources: [resolveSource],
    consumer: { taskId: TASK_B, taskRevision: 4 }
  }), authorize);
  assert.equal(downstream.status, 'ready', JSON.stringify(downstream.failure));
  assert.equal(downstream.sourceSnapshotId, SEED_A);
  assert.equal(downstream.baseSnapshotId, SEED_A);
  assert.equal(downstream.derivedSnapshotId, SEED_B);
  // The composition port ran the ledger's proof over exactly this conflicted hop
  // BEFORE it composed, and the hop carried this begin's sole selected ref.
  assert.deepEqual(h.state.composes.at(-1).chain, [hop()]);
  assert.deepEqual(h.state.composes.at(-1).refs, [ART_C2]);
  // The omitted edge records the EXACT resolution artifact it inherited.
  assert.equal(downstream.inherited.length, 1);
  assert.equal(downstream.inherited[0].taskId, TASK_A);
  assert.equal(downstream.inherited[0].attemptId, older.attemptId);
  assert.equal(downstream.inherited[0].snapshotId, SEED_A);
  assert.deepEqual(downstream.inherited[0].resolution, RESOLUTION);
  assert.deepEqual(downstream.inherited[0].requirement.artifact, ART_A);

  // --- nothing else may consume that seed ------------------------------------
  // A second conflicted seed exists, but its attempt was never accepted: the
  // proof is required even when NO board edge was omitted at all.
  control.chain = [];
  const unaccepted = await begin(service, { requestId: 'begin-a2', sources: twoSources });
  assert.equal(unaccepted.derivedSnapshotId, SEED_C);
  assert.deepEqual(unaccepted.conflicts, [CONFLICT]);
  assert.equal(unaccepted.status, 'ready');
  const plain = requestId => service.invoke(beginArgs({
    requestId, sources: [resolveSource], validationCommands: ['npm test']
  }), authorize);
  control.chain = [hop({ snapshotId: SEED_C, attemptId: unaccepted.attemptId })];
  await assert.rejects(plain('plain-unaccepted'),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  // An integration-lane seal that is NOT the accepted candidate proves nothing.
  control.chain = [hop({ carried: [{ ...ART_C2, version: 3 }] })];
  await assert.rejects(plain('plain-alternative'),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  // A batch that merely CONTAINS the resolution is not a resolution decision.
  control.chain = [hop({ carried: [{ ...ART_C2 }, { ...ART_A }] })];
  await assert.rejects(plain('plain-batch'),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  // The seed's own conflict paths, base and ORDERED source refs are all exact.
  control.chain = [hop({ conflicts: [{ paths: ['other.cjs'], inputIds: [TASK_A], reason: 'overlap' }] })];
  await assert.rejects(plain('plain-other-paths'),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  control.chain = [hop({ baseSnapshotId: OTHER_BASE })];
  await assert.rejects(plain('plain-other-base'),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  control.chain = [hop({ refs: [{ ...ART_B }, { ...ART_A }] })];
  await assert.rejects(plain('plain-other-refs'),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  // The check is not a blanket refusal: the SAME base with the real proof
  // composes normally, and a clean (conflict-free) base never needs it.
  control.chain = [hop()];
  const proved = await plain('plain-proved');
  assert.equal(proved.status, 'ready', JSON.stringify(proved.failure));
  assert.equal(proved.baseSnapshotId, SEED_A);

  // --- release changes RETENTION only: the accepted resolution survives -------
  // Releasing the resolving attempt keeps its exact candidate, validations and
  // acceptance, so the already-positive downstream consumption stays provable
  // (it is HISTORICAL ancestry, not a live pin).
  const released = await service.invoke({
    ...controls, action: 'release', expectedRevision: accepted.revision, requestId: 'release-res',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.deepEqual(released.acceptance.resolvedPaths, ['add.cjs'], 'release preserves the acceptance');
  assert.deepEqual(released.candidate.artifact, RESOLUTION, 'and the exact candidate');
  control.chain = [hop()];
  const afterRelease = await plain('plain-after-release');
  assert.equal(afterRelease.status, 'ready', JSON.stringify(afterRelease.failure));
  assert.equal(afterRelease.baseSnapshotId, SEED_A);
  // The omitted EDGE proof still witnesses that same exact resolution.
  const witnessed = await service.invoke(beginArgs({
    requestId: 'edge-after-release', sources: [resolveSource],
    consumer: { taskId: TASK_B, taskRevision: 4 }
  }), authorize);
  assert.equal(witnessed.status, 'ready', JSON.stringify(witnessed.failure));
  assert.equal(witnessed.inherited.length, 1);
  assert.equal(witnessed.inherited[0].attemptId, older.attemptId);
  assert.deepEqual(witnessed.inherited[0].resolution, RESOLUTION);
  // Unaccepted alternatives are still refused after the release.
  control.chain = [hop({ carried: [{ ...ART_C2, version: 3 }] })];
  await assert.rejects(plain('plain-after-release-alternative'),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  control.chain = [hop({ snapshotId: SEED_C, attemptId: unaccepted.attemptId })];
  control.ancestry = {
    sourceSnapshotId: SEED_C,
    ancestors: [{
      snapshotId: SEED_C,
      provenance: {
        kind: 'integration-seed',
        attemptId: unaccepted.attemptId,
        baseSnapshotId: BASE,
        refs: [{ ...ART_A }, { ...ART_B }],
        conflicts: [CONFLICT]
      }
    }]
  };
  await assert.rejects(plain('plain-after-release-unaccepted'),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');

  // --- the omitted EDGE proof is that same exact proof -----------------------
  control.chain = [hop({ snapshotId: SEED_C, attemptId: unaccepted.attemptId })];
  control.ancestry = {
    sourceSnapshotId: SEED_C,
    ancestors: [{
      snapshotId: SEED_C,
      provenance: {
        kind: 'integration-seed',
        attemptId: unaccepted.attemptId,
        baseSnapshotId: BASE,
        refs: [{ ...ART_A }, { ...ART_B }],
        conflicts: [CONFLICT]
      }
    }]
  };
  const retains = h.state.retains.length;
  await assert.rejects(service.invoke(beginArgs({
    requestId: 'edge-unaccepted', sources: [resolveSource], consumer: { taskId: TASK_B, taskRevision: 4 }
  }), authorize), error => error instanceof WorkerError && error.code === 'dependency_unselected');
  assert.equal(h.state.retains.length, retains, 'a refused witness retains nothing');

  // --- the durable ACCEPTANCE is part of the proof ---------------------------
  await service.close();
  const ledgerPath = path.join(h.directory, 'integration-attempts.json');
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  const entry = ledger.attempts.find(attempt => attempt.id === older.attemptId);
  delete entry.acceptance;
  entry.status = 'validated';
  await fs.writeFile(ledgerPath, JSON.stringify(ledger));
  const reopened = h.open();
  control.chain = [hop()];
  await assert.rejects(reopened.invoke(beginArgs({
    requestId: 'plain-no-acceptance', sources: [resolveSource], validationCommands: ['npm test']
  }), authorize), error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
});

test('an old applying replay proves clean lineage without growing its record footprint', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ],
    publishFailures: 1
  });
  const service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  await assert.rejects(service.invoke(applyArgs, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');

  // The older build's ledger: a current applying record with no ancestry marker.
  const reopened = await withoutAncestryProof(h, service);
  const file = path.join(h.directory, 'integration-attempts.json');
  const record = async () => JSON.parse(await fs.readFile(file, 'utf8'))
    .attempts.find(entry => entry.id === begun.attemptId);
  // The checkpoint fields are the ones a journal legitimately advances; every
  // OTHER field must stay identical, so no marker is ever added on this path.
  const footprint = value => {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.publicationJournalEstablished;
    delete copy.publicationJournalRevision;
    delete copy.updatedAt;
    return JSON.stringify(copy);
  };
  const before = await record();
  assert.equal('ancestryVerified' in before, false);

  // A real port writes its journal, then raises BOTH ledger checkpoints before
  // its first effect. Each of those writes must fit the applying footprint.
  const checkpoints = [];
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    check();
    await options.onJournalReady();
    checkpoints.push(await record());
    await options.onJournalIntent(1);
    checkpoints.push(await record());
    return { state: 'applied', applied: ['src/out.txt'], conflicts: [] };
  };
  const resumed = await reopened.invoke(applyArgs, authorize);
  assert.equal(resumed.replayed, false);
  assert.equal(resumed.status, 'applied');
  assert.equal(resumed.ancestryVerified, false, 'an applying replay never records the marker');
  assert.equal(resumed.publicationJournalEstablished, true);
  assert.equal(checkpoints.length, 2);
  for (const snapshot of checkpoints) {
    assert.equal(footprint(snapshot), footprint(before), 'each before-effect checkpoint keeps the applying footprint');
    assert.equal('ancestryVerified' in snapshot, false);
  }
  const durable = await record();
  assert.equal(durable.status, 'applied');
  assert.equal('ancestryVerified' in durable, false);
  assert.equal(h.state.publishes.length, 1);
});

test('a reload proof requires a connected chain that begins at the exact base', async t => {
  const { h, control, service } = await lineageHarness(t);
  const { seed, clean } = await lineageAttempts(service);
  const ready = await begin(service, downstreamArgs('begin-chain'));
  assert.equal(ready.status, 'ready');
  const reopened = await withoutAncestryProof(h, service);
  const propose = requestId => reopened.invoke({
    ownerId: OWNER, teamId: TEAM, attemptId: ready.attemptId, action: 'candidate',
    expectedRevision: ready.revision, requestId, artifact: ART_C4
  }, authorize);
  const mismatch = promise => assert.rejects(promise,
    error => error instanceof WorkerError && error.code === 'ancestry_mismatch');

  // A chain that does not BEGIN at this attempt's stored base proves nothing.
  const chain = reloadChain(seed.attemptId, clean.attemptId);
  control.ancestry = { sourceSnapshotId: chain.sourceSnapshotId, ancestors: chain.ancestors.slice(1) };
  await mismatch(propose('chain-starts-elsewhere'));
  // Adjacent links must follow each record's own baseSnapshotId.
  const broken = reloadChain(seed.attemptId, clean.attemptId);
  broken.ancestors[1] = { ...broken.ancestors[1], snapshotId: OTHER_BASE };
  control.ancestry = broken;
  await mismatch(propose('chain-broken-link'));
  // A clean capture answer keeps its empty chain valid and advances the decision.
  control.ancestry = { sourceSnapshotId: SEED_B, ancestors: [] };
  const proposed = await propose('chain-clean');
  assert.equal(proposed.status, 'candidate');
  assert.equal(proposed.ancestryVerified, true);
});

// ---------------------------------------------------------------------------
// Compact acceptance over the REAL bridge.
//
// A real divergent-rename merge legally produces hundreds of long conflict paths
// (review-artifacts/repro-accept-request-cap.cjs: 602 paths up to 1810 chars,
// a 1,088,148-byte accept body that BridgeHost refuses before its handler runs).
// Every attempt view now reports `conflictPathsDigest`, so a coordinator can
// acknowledge that exact union in a small request. The durable acceptance keeps
// the verified DIGEST only: the exact union is already that record's immutable
// conflict groups, and a second copy of it is what made a legal wide union fail
// the ledger byte bound. Views and pages still expose the full derived union.
// ---------------------------------------------------------------------------

/** The documented preimage: domain separator, exact attempt id, sorted unique paths. */
const DIGEST_DOMAIN = 'codex-subagent/integration-conflict-paths/v1';
const expectedDigest = (attemptId, paths) => createHash('sha256')
  .update(JSON.stringify([DIGEST_DOMAIN, attemptId, [...new Set(paths)].sort()]))
  .digest('hex');

const LONG_SEGMENT = 'p'.repeat(199);
const LONG_PARENT = new Array(9).fill(LONG_SEGMENT).join('/');
const LONG_PATHS = Array.from({ length: 600 }, (_, index) => `${LONG_PARENT}/f${String(index).padStart(5, '0')}.txt`);
const LARGE_CONFLICT = {
  paths: ['moved-by-b.txt', 'source.txt', ...LONG_PATHS],
  inputIds: [TASK_A, TASK_B],
  reason: 'divergent rename'
};
const SMALL_CONFLICT = { paths: ['src/a.ts'], inputIds: [TASK_A, TASK_B], reason: 'overlap' };
const conflictSources = [
  { taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] },
  { taskId: TASK_B, taskRevision: 4, artifact: ART_B, evidence: [EV_B] }
];
const attemptControls = attemptId => ({ ownerId: OWNER, teamId: TEAM, attemptId });

/**
 * One conflicted attempt with a 602-path union (first composed seed) plus one
 * small conflicted attempt (second seed), served through a REAL BridgeHost and
 * the REAL forward() relay, so every request is measured as the relay builds it.
 */
async function bridgeConflictHarness(t, options = {}) {
  // One composed seed per attempt, in call order. The default pair is the
  // documented 602-path regression plus its small control; a caller can supply a
  // larger legal union (the measured 3002-path case) instead.
  const compositions = options.conflicts ?? [
    { id: SEED_A, conflict: LARGE_CONFLICT },
    { id: SEED_C, conflict: SMALL_CONFLICT }
  ];
  const seeds = new Map();
  let composed = 0;
  const h = await harness(t, {
    tasks: [
      task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, state: 'accepted' }),
      task(TASK_B, { candidates: [ART_B], assigneeWorkerId: WORKER_B, state: 'accepted', revision: 4 })
    ],
    sessions: [
      session(WORKER_A),
      session(WORKER_B),
      // One integration-lane resolver per derived seed, exactly as the lane rule needs.
      session(WORKER_I, { lane: 'integration', snapshotId: SEED_A }),
      session(WORKER_J, { lane: 'integration', snapshotId: SEED_C })
    ],
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A, snapshotId: BASE } },
      { ref: ART_B, options: { workerId: WORKER_B, snapshotId: BASE } },
      { ref: ART_C2, options: { workerId: WORKER_I, snapshotId: SEED_A, revision: 2 } },
      { ref: ART_C4, options: { workerId: WORKER_J, snapshotId: SEED_C, revision: 2 } }
    ],
    composition: (refs, count, scope) => {
      if (!seeds.has(scope.attemptId)) {
        seeds.set(scope.attemptId, compositions[Math.min(composed, compositions.length - 1)]);
        composed += 1;
      }
      const seed = seeds.get(scope.attemptId);
      return { snapshot: { id: seed.id }, baseSnapshotId: BASE, conflicts: [seed.conflict] };
    }
  });
  const registry = path.join(h.root, 'bridges');
  // One live service backs the bridge handler; a reopen replaces it so the very
  // same bridge path proves the durable record, not a cached view.
  const current = { service: h.open() };
  const host = new BridgeHost();
  await host.start(registry, [h.root], async (name, received) => ({
    content: [{ type: 'text', text: JSON.stringify(await current.service.invoke(received, authorize)) }]
  }));
  t.after(() => host.close());
  /** One real forward() call plus the EXACT body bytes the relay would send. */
  const send = async args => {
    const body = JSON.stringify({ name: 'subagent_integration', args, cwd: h.root });
    const result = await forward(registry, h.root, 'subagent_integration', args);
    const parsed = JSON.parse(result.content[0].text);
    // The EXACT body the relayed reply carried: the tool text escaped inside its
    // content envelope, which is what the bridge's 10,000,000-character cap counts.
    return {
      bodyBytes: Buffer.byteLength(body),
      replyChars: JSON.stringify(result).length,
      isError: result.isError === true,
      value: parsed
    };
  };
  return { h, registry, host, current, send };
}

test('a large conflict union is accepted over the real bridge by its exact digest', async t => {
  const { h, current, send } = await bridgeConflictHarness(t);

  // --- candidate/validate the 602-path conflicted attempt --------------------
  const begun = await send(beginArgs({ requestId: 'begin-large', sources: conflictSources }));
  assert.equal(begun.isError, false, JSON.stringify(begun.value));
  assert.equal(begun.value.status, 'ready');
  assert.equal(begun.value.conflictPaths.length, 602);
  assert.equal(Math.max(...begun.value.conflictPaths.map(value => value.length)), 1810);
  const attempt = attemptControls(begun.value.attemptId);
  const candidate = await send({
    ...attempt, action: 'candidate', expectedRevision: begun.value.revision,
    requestId: 'cand-large', artifact: ART_C2
  });
  assert.equal(candidate.value.candidate.lane, 'integration');
  const validated = await send({
    ...attempt, action: 'validate', expectedRevision: candidate.value.revision,
    requestId: 'val-large', evidence: [EV_V]
  });
  assert.equal(validated.value.status, 'validated');

  // The view reports the documented deterministic digest of the exact union, and
  // it is stable across reads of the same durable state.
  const union = validated.value.conflictPaths;
  const digest = validated.value.conflictPathsDigest;
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, expectedDigest(validated.value.attemptId, union));
  const beforeDecisions = await send(statusArgs({ attemptId: attempt.attemptId }));
  assert.equal(beforeDecisions.value.conflictPathsDigest, digest);
  const revision = validated.value.revision;

  // --- refusals change nothing ----------------------------------------------
  const wrong = await send({
    ...attempt, action: 'accept', expectedRevision: revision,
    requestId: 'accept-wrong-digest', resolvedPathsDigest: '0'.repeat(64)
  });
  assert.equal(wrong.isError, true);
  assert.equal(wrong.value.error.code, 'conflict_paths_mismatch');
  const mixed = await send({
    ...attempt, action: 'accept', expectedRevision: revision,
    requestId: 'accept-mixed', resolvedPaths: [union[0]], resolvedPathsDigest: digest
  });
  assert.equal(mixed.value.error.code, 'invalid_arguments');
  const stale = await send({
    ...attempt, action: 'accept', expectedRevision: revision - 1,
    requestId: 'accept-stale', resolvedPathsDigest: digest
  });
  assert.equal(stale.value.error.code, 'revision_conflict');
  const untouched = await send(statusArgs({ attemptId: attempt.attemptId }));
  assert.equal(untouched.value.status, 'validated');
  assert.equal(untouched.value.revision, revision);
  assert.equal(untouched.value.acceptance, null);

  // --- the compact acknowledgment fits the bridge cap ------------------------
  const acceptArgs = {
    ...attempt, action: 'accept', expectedRevision: revision,
    requestId: 'accept-large-digest', resolvedPathsDigest: digest
  };
  // The SAME decision as a full LEGACY list would still exceed the 1,000,000-byte
  // cap. The measured object is a complete list action - the digest is removed,
  // not merely shadowed - and it is schema-valid before its size is compared.
  const largeListArgs = { ...acceptArgs, requestId: 'accept-large-list', resolvedPaths: union };
  delete largeListArgs.resolvedPathsDigest;
  assert.equal(Object.hasOwn(largeListArgs, 'resolvedPathsDigest'), false);
  const parsedLargeList = integrationActionSchema.parse(largeListArgs);
  assert.equal(parsedLargeList.action, 'accept');
  assert.equal(parsedLargeList.resolvedPaths.length, union.length);
  assert.deepEqual(parsedLargeList.resolvedPaths.slice().sort(), union);
  const listBodyBytes = Buffer.byteLength(JSON.stringify({
    name: 'subagent_integration', args: parsedLargeList, cwd: h.root
  }));
  const approved = await send(acceptArgs);
  assert.equal(approved.isError, false, JSON.stringify(approved.value.error));
  assert.equal(approved.value.status, 'accepted');
  assert.equal(approved.bodyBytes < 1024, true, `the digest request is ${approved.bodyBytes} bytes`);
  assert.equal(listBodyBytes > 1_000_000, true, `the exact list form is ${listBodyBytes} bytes and cannot be sent`);
  // The FULL exact union is readable, in canonical order, from the digest alone.
  assert.deepEqual(approved.value.acceptance.resolvedPaths, union);

  // An exact replay returns the recorded view; changed arguments under the same
  // request id are a conflict instead of a second decision.
  const replay = await send(acceptArgs);
  assert.equal(replay.value.replayed, true);
  assert.equal(replay.value.revision, approved.value.revision);
  assert.deepEqual(replay.value.acceptance, approved.value.acceptance);
  const changed = await send({ ...acceptArgs, resolvedPathsDigest: expectedDigest(attempt.attemptId, ['src/a.ts']) });
  assert.equal(changed.value.error.code, 'request_conflict');

  // --- the full union survives a store reopen --------------------------------
  await current.service.close();
  current.service = h.open();
  const reopened = await send(statusArgs({ attemptId: attempt.attemptId }));
  assert.equal(reopened.value.status, 'accepted');
  assert.equal(reopened.value.conflictPathsDigest, digest);
  assert.deepEqual(reopened.value.acceptance.resolvedPaths, union);
  const ledger = JSON.parse(await fs.readFile(path.join(h.directory, 'integration-attempts.json'), 'utf8'));
  const record = ledger.attempts.find(entry => entry.id === attempt.attemptId);
  assert.equal(record.acceptance.requestId, 'accept-large-digest');
  // The COMPACT durable shape: the verified digest only, never a second copy of
  // the union the very same record already stores as immutable conflict groups.
  assert.equal(Object.hasOwn(record.acceptance, 'resolvedPaths'), false, 'no path list is written for a digest approval');
  assert.deepEqual(record.acceptance, {
    resolvedPathsDigest: digest, requestId: 'accept-large-digest', at: record.acceptance.at
  });
  // Ancestry proofs and release/recovery read exact derived paths and the stored
  // groups, so a 602-path union is still proved in full.
  assert.deepEqual(record.conflicts, [LARGE_CONFLICT]);
  // The ORIGINAL digest request still replays over the reopened store: same
  // recorded accepted revision and the same derived approval.
  const reopenedReplay = await send(acceptArgs);
  assert.equal(reopenedReplay.value.replayed, true);
  assert.equal(reopenedReplay.value.status, 'accepted');
  assert.equal(reopenedReplay.value.revision, reopened.value.revision);
  assert.equal(reopenedReplay.value.revision, approved.value.revision, 'the accepted revision is unchanged');
  assert.deepEqual(reopenedReplay.value.acceptance, approved.value.acceptance);
  assert.deepEqual(reopenedReplay.value.acceptance.resolvedPaths, union);

  // --- the legacy list approval is unchanged ---------------------------------
  const small = await send(beginArgs({ requestId: 'begin-small', sources: conflictSources }));
  assert.equal(small.value.conflictPaths.length, 1);
  const smallAttempt = attemptControls(small.value.attemptId);
  const smallCandidate = await send({
    ...smallAttempt, action: 'candidate', expectedRevision: small.value.revision,
    requestId: 'cand-small', artifact: ART_C4
  });
  const smallValidated = await send({
    ...smallAttempt, action: 'validate', expectedRevision: smallCandidate.value.revision,
    requestId: 'val-small', evidence: [EV_V]
  });
  const listArgs = {
    ...smallAttempt, action: 'accept', expectedRevision: smallValidated.value.revision,
    requestId: 'accept-small-list', resolvedPaths: ['src/a.ts']
  };
  const listed = await send(listArgs);
  assert.equal(listed.isError, false, JSON.stringify(listed.value.error));
  assert.deepEqual(listed.value.acceptance.resolvedPaths, ['src/a.ts']);
  const listReplay = await send(listArgs);
  assert.equal(listReplay.value.replayed, true, 'an exact list replay keeps its original receipt');
  assert.equal(listReplay.value.revision, listed.value.revision);
  // A second acceptance of an already accepted attempt is refused by state,
  // whatever acknowledgment form it uses.
  const digestArgs = {
    ...smallAttempt, action: 'accept', expectedRevision: listed.value.revision,
    requestId: 'accept-small-digest', resolvedPathsDigest: listed.value.conflictPathsDigest
  };
  const refused = await send(digestArgs);
  assert.equal(refused.value.error.code, 'state_invalid');
  assert.equal(listReplay.value.acceptance.requestId, 'accept-small-list');
  assert.equal(h.state.publishes.length, 0, 'acceptance never publishes');
});

test('a clean attempt keeps its legacy empty-list acceptance and receipt', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const service = h.open();
  const begun = await begin(service);
  const controls = attemptControls(begun.attemptId);
  const proposed = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize);
  const validated = await service.invoke({
    ...controls, action: 'validate', expectedRevision: proposed.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  // No resolvedPaths at all: the existing default [] keeps its exact decision.
  const acceptArgs = { ...controls, action: 'accept', expectedRevision: validated.revision, requestId: 'accept-1' };
  const accepted = await service.invoke(acceptArgs, authorize);
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.acceptance.resolvedPaths, []);
  assert.equal(accepted.conflictPathsDigest, expectedDigest(accepted.attemptId, []));
  const replay = await service.invoke(acceptArgs, authorize);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, accepted.revision);
  assert.deepEqual(replay.acceptance, accepted.acceptance);
  // The recorded receipt stays bound to the list form: the same request id with
  // the digest is different arguments, never a second decision.
  await assert.rejects(service.invoke({
    ...acceptArgs, expectedRevision: accepted.revision, resolvedPathsDigest: accepted.conflictPathsDigest
  }, authorize), error => error instanceof WorkerError && error.code === 'request_conflict');
  // A digest of the empty union is accepted on a fresh clean attempt instead.
  const second = await begin(service, { requestId: 'begin-2' });
  const secondControls = attemptControls(second.attemptId);
  const secondCandidate = await service.invoke({
    ...secondControls, action: 'candidate', expectedRevision: second.revision, requestId: 'cand-1', artifact: ART_C
  }, authorize);
  const secondValidated = await service.invoke({
    ...secondControls, action: 'validate', expectedRevision: secondCandidate.revision, requestId: 'val-1', evidence: [EV_V]
  }, authorize);
  const secondAccepted = await service.invoke({
    ...secondControls, action: 'accept', expectedRevision: secondValidated.revision,
    requestId: 'accept-digest', resolvedPathsDigest: secondValidated.conflictPathsDigest
  }, authorize);
  assert.equal(secondAccepted.status, 'accepted');
  assert.deepEqual(secondAccepted.acceptance.resolvedPaths, []);
});

/** One conflicted union whose digest approval is the ONLY durable proof. */
const PROOF_CONFLICT = { paths: ['src/moved.ts', 'src/shared.ts'], inputIds: [TASK_A, TASK_B], reason: 'divergent rename' };
const PROOF_SOURCES = [
  { taskId: TASK_A, taskRevision: 3, artifact: ART_A, evidence: [EV_A] },
  { taskId: TASK_B, taskRevision: 4, artifact: ART_B, evidence: [EV_B] }
];

test('one digest approval serves lineage and fresh apply across reload and fails closed when stale', async t => {
  const control = { chain: [] };
  const h = await harness(t, {
    tasks: [
      task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, state: 'accepted' }),
      task(TASK_B, { candidates: [ART_B], assigneeWorkerId: WORKER_B, state: 'accepted', revision: 4 })
    ],
    sessions: [
      session(WORKER_A),
      session(WORKER_B),
      // The resolver is an INTEGRATION-lane worker bound to the conflicted seed.
      session(WORKER_I, { lane: 'integration', snapshotId: SEED_A })
    ],
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A, snapshotId: BASE } },
      { ref: ART_B, options: { workerId: WORKER_B, snapshotId: BASE } },
      { ref: ART_C2, options: { workerId: WORKER_I, snapshotId: SEED_A, revision: 2 } }
    ],
    conflictChain: () => control.chain,
    composition: { snapshot: { id: SEED_A }, baseSnapshotId: BASE, conflicts: [PROOF_CONFLICT] }
  });
  let service = h.open();
  const begun = await begin(service, { requestId: 'begin-proof', sources: PROOF_SOURCES });
  assert.deepEqual(begun.conflicts, [PROOF_CONFLICT]);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const proposed = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'cand-proof', artifact: ART_C2
  }, authorize);
  assert.equal(proposed.candidate.lane, 'integration');
  const validated = await service.invoke({
    ...controls, action: 'validate', expectedRevision: proposed.revision, requestId: 'val-proof', evidence: [EV_V]
  }, authorize);
  const digest = validated.conflictPathsDigest;
  assert.equal(digest, expectedDigest(begun.attemptId, PROOF_CONFLICT.paths));
  const accepted = await service.invoke({
    ...controls, action: 'accept', expectedRevision: validated.revision,
    requestId: 'accept-proof', resolvedPathsDigest: digest
  }, authorize);
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.acceptance.resolvedPaths, ['src/moved.ts', 'src/shared.ts']);
  const ledgerFile = path.join(h.directory, 'integration-attempts.json');
  const record = JSON.parse(await fs.readFile(ledgerFile, 'utf8')).attempts
    .find(entry => entry.id === begun.attemptId);
  assert.equal(Object.hasOwn(record.acceptance, 'resolvedPaths'), false);
  assert.equal(record.acceptance.resolvedPathsDigest, digest);

  // --- reload: the SAME acceptance proves a conflicted lineage --------------
  await service.close();
  service = h.open();
  control.chain = [{
    snapshotId: SEED_A,
    provenance: {
      kind: 'integration-seed', attemptId: begun.attemptId, baseSnapshotId: BASE,
      refs: [ART_A, ART_B], conflicts: [PROOF_CONFLICT]
    },
    refs: [ART_C2]
  }];
  const downstream = await begin(service, { requestId: 'begin-downstream' });
  assert.equal(downstream.status, 'ready');
  assert.equal(downstream.ancestryVerified, true);
  const composed = h.state.composes[h.state.composes.length - 1];
  assert.equal(composed.chain.length, 1);
  assert.deepEqual(composed.chain[0].refs, [ART_C2]);
  assert.equal(composed.chain[0].provenance.attemptId, begun.attemptId);

  // --- a digest that no longer proves the union is never an approval --------
  const clean = await fs.readFile(ledgerFile, 'utf8');
  const tampered = JSON.parse(clean);
  const stale = tampered.attempts.find(entry => entry.id === begun.attemptId);
  stale.acceptance = {
    resolvedPathsDigest: 'f'.repeat(64), requestId: stale.acceptance.requestId, at: stale.acceptance.at
  };
  await fs.writeFile(ledgerFile, JSON.stringify(tampered));
  await service.close();
  service = h.open();
  // The record stays readable, but no path is invented from an unproved digest.
  const readable = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(readable.status, 'accepted');
  assert.equal(readable.conflictPathsDigest, digest);
  assert.equal(readable.acceptance.resolvedPaths, null);
  assert.equal(readable.canPublish, false, 'a corrupt approval is never offered as publishable');
  // The lineage proof fails closed instead of accepting the digest as a resolution.
  await assert.rejects(begin(service, { requestId: 'begin-downstream-2' }),
    error => error instanceof WorkerError && error.code === 'ancestry_unresolved');
  // ...and so does a fresh publication decision, before any intent or effect.
  await assert.rejects(service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-proof'
  }, authorize), error => error instanceof WorkerError && error.code === 'integration_corrupt');
  assert.equal(h.state.publishes.length, 0, 'no publication was started');

  // --- restoring the proof makes the SAME record decidable again -----------
  await service.close();
  await fs.writeFile(ledgerFile, clean);
  service = h.open();
  const applied = await service.invoke({
    ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-proof'
  }, authorize);
  assert.equal(applied.status, 'applied');
  assert.equal(h.state.publishes.length, 1);
  assert.deepEqual(applied.acceptance.resolvedPaths, ['src/moved.ts', 'src/shared.ts']);
  await service.close();
});

test('a bad stored compact acceptance keeps an applying replay proof-only', async t => {
  const pending = [{ path: '.', reason: 'recovery pending: retry with a new request once storage is available.' }];
  const h = await harness(t, {
    composition: { snapshot: { id: BASE }, baseSnapshotId: BASE, conflicts: [PROOF_CONFLICT] },
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C2, options: { workerId: WORKER_I, revision: 2 } }
    ],
    publishFailures: 1,
    publishStates: [{ state: 'conflict', applied: [], conflicts: pending }]
  });
  const service = h.open();
  const begun = await begin(service);
  assert.deepEqual(begun.conflicts, [PROOF_CONFLICT]);
  const controls = attemptControls(begun.attemptId);
  let current = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'cand-bad', artifact: ART_C2
  }, authorize);
  current = await service.invoke({
    ...controls, action: 'validate', expectedRevision: current.revision, requestId: 'val-bad', evidence: [EV_V]
  }, authorize);
  const accepted = await service.invoke({
    ...controls, action: 'accept', expectedRevision: current.revision,
    requestId: 'accept-bad', resolvedPathsDigest: current.conflictPathsDigest
  }, authorize);
  assert.equal(accepted.status, 'accepted');
  const applyArgs = { ...controls, action: 'apply', expectedRevision: accepted.revision, requestId: 'apply-1' };
  // One failed publication leaves a durable in-flight intent to replay.
  await assert.rejects(service.invoke(applyArgs, authorize),
    error => error instanceof WorkerError && error.code === 'publish_failed');
  const applying = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(applying.status, 'applying');
  assert.equal(applying.ancestryVerified, true, 'the lineage IS proved, so only the acceptance can force proof-only');

  // The stored compact acceptance no longer proves this attempt's conflict union,
  // and the journal latch of an old build stays established.
  const ledgerFile = path.join(h.directory, 'integration-attempts.json');
  const tampered = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const record = tampered.attempts.find(entry => entry.id === begun.attemptId);
  assert.equal(Object.hasOwn(record.acceptance, 'resolvedPaths'), false);
  record.acceptance = {
    resolvedPathsDigest: 'f'.repeat(64),
    requestId: record.acceptance.requestId,
    at: record.acceptance.at
  };
  record.publicationJournalEstablished = true;
  await service.close();
  await fs.writeFile(ledgerFile, JSON.stringify(tampered));
  const reopened = h.open();
  const read = await reopened.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(read.status, 'applying');
  assert.equal(read.acceptance.requestId, 'accept-bad');
  assert.equal(read.acceptance.resolvedPaths, null, 'no path list is invented from a stale digest');
  assert.equal(read.canPublish, false);
  const scans = h.state.ancestry.length;

  // The exact replay may resolve ONLY the journal work that already started: a
  // corrupt compact acceptance can never authorize a new or pending write, and
  // the already proved lineage is never spent on one.
  const resumed = await reopened.invoke(applyArgs, authorize);
  assert.equal(resumed.replayed, false);
  assert.equal(h.state.publishes.length, 2);
  assert.equal(h.state.publishes[1].recoveryOnly, true, 'the replay was proof-only, not a fresh decision');
  assert.equal(h.state.publishes[1].requireJournal, true, 'the established journal latch is kept');
  assert.deepEqual(h.state.publishes[1].scope, controls, 'the exact scope is kept');
  assert.equal(h.state.ancestry.length, scans, 'no fresh lineage scan was needed');
  assert.equal(resumed.status, 'accepted');
  assert.equal(resumed.apply.state, 'conflict');
  assert.deepEqual(resumed.apply.conflicts, pending, 'the pending journal work is exposed, not lost');

  // The pending work is never stranded: an explicit release still drops the pins.
  const released = await reopened.invoke({
    ...controls, action: 'release', expectedRevision: resumed.revision, requestId: 'release-1',
    abandon: true, releaseRetention: true
  }, authorize);
  assert.equal(released.status, 'abandoned');
  assert.equal(h.state.releases, 1);
  await reopened.close();
});

test('a legal multi-group union above 4096 paths is approved by its digest and derived exactly', async t => {
  const groups = [
    {
      paths: Array.from({ length: 1700 }, (_, index) => `src/one/f${String(index).padStart(5, '0')}.ts`),
      inputIds: [TASK_A, TASK_B], reason: 'overlap one'
    },
    {
      paths: Array.from({ length: 1700 }, (_, index) => `src/two/f${String(index).padStart(5, '0')}.ts`),
      inputIds: [TASK_A, TASK_B], reason: 'overlap two'
    },
    {
      paths: Array.from({ length: 700 }, (_, index) => `src/three/f${String(index).padStart(5, '0')}.ts`),
      inputIds: [TASK_A, TASK_B], reason: 'overlap three'
    }
  ];
  const union = [...new Set(groups.flatMap(group => group.paths))].sort();
  assert.equal(union.length, 4100);
  const h = await harness(t, {
    composition: { snapshot: { id: BASE }, baseSnapshotId: BASE, conflicts: groups },
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C2, options: { workerId: WORKER_I, revision: 2 } }
    ]
  });
  const service = h.open();
  const begun = await begin(service);
  assert.equal(begun.conflicts.length, 3);
  const controls = { ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId };
  const proposed = await service.invoke({
    ...controls, action: 'candidate', expectedRevision: begun.revision, requestId: 'cand-multi', artifact: ART_C2
  }, authorize);
  const validated = await service.invoke({
    ...controls, action: 'validate', expectedRevision: proposed.revision, requestId: 'val-multi', evidence: [EV_V]
  }, authorize);
  assert.equal(validated.status, 'validated');
  const digest = validated.conflictPathsDigest;
  assert.equal(digest, expectedDigest(begun.attemptId, union));
  // The previous FULL-LIST form is refused by the wire schema above 4096 paths.
  assert.throws(() => integrationActionSchema.parse({
    ...controls, action: 'accept', expectedRevision: validated.revision,
    requestId: 'accept-multi-list', resolvedPaths: union
  }));
  // The same decision, acknowledged by its exact digest, is accepted.
  const accepted = await service.invoke({
    ...controls, action: 'accept', expectedRevision: validated.revision,
    requestId: 'accept-multi-digest', resolvedPathsDigest: digest
  }, authorize);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.acceptance.requestId, 'accept-multi-digest');
  assert.deepEqual(accepted.acceptance.resolvedPaths, union, 'the full exact union is derived for readers');

  // The durable record is compact, and every path is still provable from it.
  const ledgerFile = path.join(h.directory, 'integration-attempts.json');
  const stored = JSON.parse(await fs.readFile(ledgerFile, 'utf8')).attempts
    .find(entry => entry.id === begun.attemptId);
  assert.equal(Object.hasOwn(stored.acceptance, 'resolvedPaths'), false);
  assert.equal(stored.acceptance.resolvedPathsDigest, digest);
  assert.deepEqual(stored.conflicts, groups);
  assert.equal(stored.acceptance.resolvedPathsDigest, expectedDigest(stored.id, stored.conflicts.flatMap(group => group.paths)));

  // --- reload: the exact derived paths, page for page -----------------------
  await service.close();
  const reopened = h.open();
  const status = await reopened.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(status.truncated, undefined);
  assert.equal(status.status, 'accepted');
  assert.equal(status.revision, accepted.revision);
  assert.deepEqual(status.conflictPaths, union);
  assert.deepEqual(status.acceptance.resolvedPaths, union);
  const whole = await collectDetails(serviceRead(reopened), {
    attemptId: begun.attemptId, expectedRevision: status.revision
  }, 8192);
  assert.equal(whole.text, JSON.stringify(status));
  assert.deepEqual(JSON.parse(whole.text).acceptance.resolvedPaths, union);

  // --- safe release keeps the approval and only drops retention ------------
  const released = await reopened.invoke({
    ...controls, action: 'release', expectedRevision: status.revision,
    requestId: 'release-multi', abandon: true, releaseRetention: true
  }, authorize);
  // Nothing was published, so the explicit abandon is the terminal verdict.
  assert.equal(released.status, 'abandoned');
  assert.equal(released.pinState, 'none');
  assert.deepEqual(released.acceptance.resolvedPaths, union);
  assert.equal(h.state.releases, 1);
  assert.equal(h.state.publishes.length, 0, 'no publication was ever started');
  await reopened.close();
});
// ---------------------------------------------------------------------------
// Bounded replies: a complete view above the tool's reply budget becomes an
// explicit truncated summary, and the read-only `details` action pages the
// COMPLETE status-form view text back. The measured reproduction is one legal
// divergent-rename merge with 3002 paths of 1810 characters: its ledger stays
// legal while the view of it is about 10.9 M characters, above the bridge's
// 10,000,000-character response cap, so the effect used to be unobservable.
// ---------------------------------------------------------------------------

/** The real relay refuses a response body above this many characters. */
const BRIDGE_RESPONSE_CAP = 10_000_000;
/**
 * A bounded summary is built from bounded scalar fields only, so even the widest
 * legal durable record must produce a small reply. This is a measured ceiling.
 */
const SUMMARY_CEILING_CHARS = 64 * 1024;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

const HUGE_PATHS = Array.from({ length: 3000 }, (_, index) => `${LONG_PARENT}/f${String(index).padStart(5, '0')}.txt`);
const HUGE_CONFLICT = {
  paths: ['moved-by-b.txt', 'source.txt', ...HUGE_PATHS],
  inputIds: [TASK_A, TASK_B],
  reason: 'divergent rename'
};
const LIFECYCLE_PATHS = Array.from({ length: 1000 }, (_, index) => `${LONG_PARENT}/g${String(index).padStart(5, '0')}.txt`);
const LIFECYCLE_CONFLICT = {
  paths: ['moved-by-b.txt', 'source.txt', ...LIFECYCLE_PATHS],
  inputIds: [TASK_A, TASK_B],
  reason: 'divergent rename'
};

/** Exact character count of one reply built the way the tool adapter builds it. */
const replyCharsOf = value => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }] }).length;
const isHighCodeUnit = code => code >= 0xd800 && code <= 0xdbff;
const isLowCodeUnit = code => code >= 0xdc00 && code <= 0xdfff;

/** A service-level `read` measuring replies exactly like the real relay does. */
const serviceRead = service => async args => {
  const value = await service.invoke(args, authorize);
  return { isError: false, replyChars: replyCharsOf(value), value };
};

/**
 * Follows `nextOffset` from offset 0 and returns the reassembled text. Every page
 * is checked for bounded size, exact offsets, deterministic revision/total and a
 * code point boundary, so no page silently splits a surrogate pair.
 */
async function collectDetails(read, controls, limit = 65536) {
  const pages = [];
  let offset = 0;
  let total;
  // A caller may hand the content guard the assembly must use; otherwise the first
  // page reports one and every later page is checked against it.
  let content = controls.contentDigest;
  if (content !== undefined) {
    assert.match(content, /^[a-f0-9]{64}$/);
  }
  for (let guard = 0; guard < 100_000; guard += 1) {
    const reply = await read({
      action: 'details', ownerId: OWNER, teamId: TEAM, attemptId: controls.attemptId,
      expectedRevision: controls.expectedRevision, offset, limit,
      ...(content === undefined ? {} : { expectedContentDigest: content })
    });
    const page = reply.value;
    assert.equal(reply.isError, false, JSON.stringify(page));
    assert.equal(page.action, 'details');
    assert.equal(page.attemptId, controls.attemptId);
    assert.equal(page.encoding, 'utf16-code-unit');
    assert.equal(page.payload, 'status');
    assert.equal(page.offset, offset);
    assert.equal(page.limit, limit);
    assert.equal(page.revision, controls.expectedRevision);
    // ONE content identity for the whole assembly, reported by every page.
    assert.match(page.contentDigest, /^[a-f0-9]{64}$/);
    assert.equal(page.guard.value, page.contentDigest);
    assert.equal(page.guard.kind, 'integration-view-content-digest');
    assert.equal(page.guard.algorithm, 'sha256');
    assert.equal(page.guard.covers, 'complete-status-view-json-text');
    assert.equal(page.guard.attemptId, controls.attemptId);
    assert.equal(page.guard.revision, controls.expectedRevision);
    assert.equal(page.guard.chars, page.total);
    if (content === undefined) {
      content = page.contentDigest;
    }
    assert.equal(page.contentDigest, content, 'every page names the same document');
    assert.ok(reply.replyChars < BRIDGE_RESPONSE_CAP, `a page reply is ${reply.replyChars} characters`);
    assert.ok(page.text.length <= limit + 1, `a page carries ${page.text.length} code units for limit ${limit}`);
    if (total === undefined) {
      total = page.total;
    }
    assert.equal(page.total, total, 'total is stable across pages');
    assert.equal(page.text.length, (page.nextOffset === null ? total : page.nextOffset) - offset);
    if (offset > 0) {
      assert.equal(isLowCodeUnit(page.text.charCodeAt(0)), false, `page at ${offset} starts on a code point boundary`);
    }
    if (page.nextOffset === null) {
      assert.equal(offset + page.text.length, total);
      pages.push(page.text);
      return { text: pages.join(''), total, revision: page.revision, pages: pages.length, contentDigest: content };
    }
    assert.ok(page.nextOffset > offset, `page at ${offset} advances to ${page.nextOffset}`);
    assert.equal(isHighCodeUnit(page.text.charCodeAt(page.text.length - 1)), false, `page at ${offset} ends on a code point boundary`);
    pages.push(page.text);
    offset = page.nextOffset;
  }
  throw new Error('details paging did not terminate');
}

/**
 * `summary.details` must be DIRECTLY EXECUTABLE: exactly the schema-valid
 * arguments (no format metadata), a revision and content guard that the service
 * accepts, and sizes that describe the canonical status document `details`
 * actually reads rather than the action-specific reply that produced the summary.
 */
function assertExecutableDetails(summary) {
  const parsed = integrationActionSchema.parse(summary.details);
  assert.deepEqual(parsed, summary.details, 'summary.details is exactly the schema-valid call');
  assert.equal(parsed.action, 'details');
  assert.equal(parsed.offset, 0);
  assert.equal(parsed.limit, 16384);
  assert.match(parsed.expectedContentDigest, /^[a-f0-9]{64}$/);
  assert.equal(parsed.expectedContentDigest, summary.guard.value);
  assert.equal(summary.guard.kind, 'integration-view-content-digest');
  assert.equal(summary.guard.revision, parsed.expectedRevision);
  assert.equal(summary.guard.attemptId, parsed.attemptId);
  // Every paging size describes that SAME canonical document.
  assert.equal(summary.guard.chars, summary.fullViewChars);
  assert.equal(summary.guard.chars, summary.detailsFormat.total);
  assert.equal(summary.detailsFormat.contentDigest, summary.guard.value);
  assert.equal(summary.detailsFormat.payload, 'status');
  assert.equal(summary.detailsFormat.encoding, 'utf16-code-unit');
  assert.equal(summary.detailsFormat.maxLimit, 65536);
  // Format metadata is separate: nothing outside the strict schema leaks in.
  for (const forbidden of ['maxLimit', 'payload', 'encoding', 'total', 'semantics', 'detailsFormat', 'guard', 'chars']) {
    assert.equal(Object.hasOwn(summary.details, forbidden), false, `summary.details has no ${forbidden}`);
  }
  return parsed;
}

/**
 * Sends the advertised `summary.details` object AS-IS (page 0, untouched), then
 * follows its own `nextOffset`, replacing only the documented offset/limit. It
 * asserts one content identity for the whole assembly and that the result is the
 * canonical STATUS-form document.
 */
async function pageFromSummary(send, summary) {
  const call = assertExecutableDetails(summary);
  const pages = [];
  let offset = 0;
  let total;
  for (let step = 0; step < 100_000; step += 1) {
    const reply = await send(step === 0 ? call : { ...call, offset, limit: 65536 });
    assert.equal(reply.isError, false, JSON.stringify(reply.value));
    const page = reply.value;
    assert.equal(page.action, 'details');
    assert.equal(page.attemptId, call.attemptId);
    assert.equal(page.revision, call.expectedRevision);
    assert.equal(page.offset, offset);
    assert.equal(page.payload, 'status');
    assert.equal(page.encoding, 'utf16-code-unit');
    assert.equal(page.contentDigest, call.expectedContentDigest, 'the advertised guard is the served guard');
    if (total === undefined) {
      assert.equal(page.limit, call.limit, 'page 0 used the advertised limit');
      total = page.total;
      assert.equal(total, summary.fullViewChars, 'the advertised total is the served total');
      assert.equal(total, summary.guard.chars);
    }
    assert.equal(page.total, total);
    pages.push(page.text);
    if (page.nextOffset === null) {
      const text = pages.join('');
      assert.equal(text.length, total);
      const view = JSON.parse(text);
      assert.equal(view.action, 'status', 'the payload is the canonical status view');
      assert.equal(view.replayed, false);
      return { text, view, total, pages: pages.length, contentDigest: page.contentDigest };
    }
    assert.ok(page.nextOffset > offset, 'progress');
    offset = page.nextOffset;
  }
  throw new Error('summary details paging did not terminate');
}

test('a 3002-path attempt is acknowledged by a bounded summary and paged whole by details', async t => {
  const { h, current, send } = await bridgeConflictHarness(t, {
    conflicts: [{ id: SEED_A, conflict: HUGE_CONFLICT }, { id: SEED_C, conflict: SMALL_CONFLICT }]
  });
  const union = [...new Set(HUGE_CONFLICT.paths)].sort();
  assert.equal(union.length, 3002);
  const begin = beginArgs({ requestId: 'begin-huge', sources: conflictSources });

  // --- begin: the durable effect is acknowledged by a reply that ARRIVES -----
  const begun = await send(begin);
  assert.equal(begun.isError, false, JSON.stringify(begun.value));
  assert.equal(begun.value.truncated, true);
  assert.equal(begun.value.status, 'ready');
  assert.equal(begun.value.summary.kind, 'bounded-integration-summary');
  assert.equal(begun.value.summary.counts.conflictGroups, 1);
  assert.equal(begun.value.summary.counts.conflictPaths, 3002);
  assert.equal(begun.value.summary.counts.conflictGroupPaths, 3002);
  assert.equal(begun.value.summary.counts.acceptanceResolvedPaths, null);
  assert.equal(begun.value.summary.omitted.includes('conflictPaths'), true);
  assert.equal(begun.value.summary.omitted.includes('acceptance.resolvedPaths'), true);
  const digest = begun.value.conflictPathsDigest;
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, expectedDigest(begun.value.attemptId, union));
  assert.ok(begun.replyChars < BRIDGE_RESPONSE_CAP, `the begin reply is ${begun.replyChars} characters`);
  assert.ok(begun.replyChars <= SUMMARY_CEILING_CHARS, `the begin summary is ${begun.replyChars} characters`);
  // No partial preview may look like a complete set.
  for (const key of ['requirements', 'conflicts', 'conflictPaths', 'inherited', 'acceptance', 'apply', 'validations']) {
    assert.equal(Object.hasOwn(begun.value, key), false, `the summary omits ${key}`);
  }
  const revision = begun.value.revision;
  // The summary alone carries everything the next call needs.
  assert.equal(begun.value.controls.expectedRevision, revision);
  assert.equal(begun.value.controls.status, 'ready');
  assert.equal(begun.value.summary.details.action, 'details');
  assert.equal(begun.value.summary.details.attemptId, begun.value.attemptId);
  assert.equal(begun.value.summary.details.expectedRevision, revision);
  assert.equal(begun.value.summary.details.offset, 0);
  assert.equal(begun.value.summary.details.limit, 16384);
  // The begin summary is directly executable and describes the STATUS document,
  // not the begin reply that produced it.
  assertExecutableDetails(begun.value.summary);
  assert.equal(begun.value.contentDigest, begun.value.summary.guard.value);
  assert.equal(begun.value.summary.reason.includes(`${begun.value.summary.actionReplyChars} characters`), true);
  assert.equal(begun.value.summary.actionViewChars > 0, true);

  // --- status by BOTH keys and the exact begin replay -----------------------
  const byId = await send(statusArgs({ attemptId: begun.value.attemptId }));
  const byBegin = await send(statusArgs({ beginRequestId: 'begin-huge' }));
  const beginReplay = await send(begin);
  for (const reply of [byId, byBegin, beginReplay]) {
    assert.equal(reply.isError, false, JSON.stringify(reply.value));
    assert.equal(reply.value.truncated, true);
    assert.equal(reply.value.attemptId, begun.value.attemptId);
    assert.equal(reply.value.revision, revision);
    assert.equal(reply.value.conflictPathsDigest, digest);
    assert.ok(reply.replyChars < BRIDGE_RESPONSE_CAP, `a reply is ${reply.replyChars} characters`);
    assert.ok(reply.replyChars <= SUMMARY_CEILING_CHARS);
  }
  assert.equal(beginReplay.value.replayed, true);
  assert.equal(byId.value.replayed, false);

  // --- every summary advertises the SAME canonical document ---------------
  // begin, replayed begin and status by both keys are different replies over ONE
  // unchanged durable state, so their paging guards must be identical.
  for (const reply of [begun, byId, byBegin, beginReplay]) {
    assertExecutableDetails(reply.value.summary);
    assert.equal(reply.value.summary.guard.value, begun.value.summary.guard.value);
    assert.equal(reply.value.summary.fullViewChars, begun.value.summary.fullViewChars);
    assert.equal(reply.value.summary.detailsFormat.total, begun.value.summary.detailsFormat.total);
    assert.equal(reply.value.contentDigest, begun.value.summary.guard.value);
  }

  // --- details pages the COMPLETE view, groups and digest -------------------
  // Page 0 IS the summary's own `details` object, sent verbatim over the bridge.
  const firstPage = await send(begun.value.summary.details);
  assert.equal(firstPage.isError, false, JSON.stringify(firstPage.value));
  assert.equal(firstPage.value.offset, 0);
  assert.equal(firstPage.value.limit, 16384, 'the documented default page size');
  assert.equal(firstPage.value.text.length, 16384);
  assert.equal(firstPage.value.total, byId.value.summary.fullViewChars);
  assert.equal(firstPage.value.contentDigest, begun.value.summary.guard.value);
  assert.equal(firstPage.value.status, 'ready');

  const whole = await pageFromSummary(send, byId.value.summary);
  assert.equal(whole.text.startsWith(firstPage.value.text), true, 'the summary-driven assembly starts with that page');
  assert.equal(whole.total, byId.value.summary.fullViewChars);
  assert.ok(whole.pages > 1);
  const view = JSON.parse(whole.text);
  assert.equal(view.action, 'status');
  assert.equal(view.replayed, false);
  assert.equal(view.attemptId, begun.value.attemptId);
  assert.equal(view.status, 'ready');
  assert.equal(view.revision, revision);
  assert.equal(view.truncated, undefined, 'the paged payload is the complete view');
  assert.equal(view.conflictPathsDigest, digest);
  assert.deepEqual(view.conflictPaths, union);
  assert.deepEqual(view.conflicts, [HUGE_CONFLICT]);
  assert.equal(view.acceptance, null);
  assert.equal(view.conflictPaths.length, 3002);
  // The paged text is exactly the view JSON, so it round-trips without loss.
  assert.equal(JSON.stringify(view), whole.text);

  // --- the durable record and its pins are untouched until release ---------
  const ledgerFile = path.join(h.directory, 'integration-attempts.json');
  const ledgerBefore = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const stored = ledgerBefore.attempts.find(entry => entry.id === begun.value.attemptId);
  assert.deepEqual(stored.conflicts, [HUGE_CONFLICT]);
  assert.equal(stored.status, 'ready');
  assert.equal(stored.revision, revision);
  assert.equal(stored.pinState, 'evidence');
  assert.equal(h.state.evidence.length, 1);
  assert.equal(h.state.releases, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(ledgerBefore), 'utf8') < MAX_LEDGER_BYTES);

  // --- a reopened store serves the SAME durable revision -------------------
  await current.service.close();
  current.service = h.open();
  const reopened = await send(statusArgs({ attemptId: begun.value.attemptId }));
  assert.equal(reopened.value.truncated, true);
  assert.equal(reopened.value.revision, revision);
  assert.equal(reopened.value.conflictPathsDigest, digest);
  assert.equal(reopened.value.summary.fullViewChars, whole.total);
  // A reopen does not change the durable document, so the executable summary.details
  // of the reopened reply still names the very same content.
  assertExecutableDetails(reopened.value.summary);
  assert.equal(reopened.value.summary.guard.value, begun.value.summary.guard.value);
  const reopenedPage = await send({
    action: 'details', ownerId: OWNER, teamId: TEAM, attemptId: begun.value.attemptId,
    expectedRevision: revision, offset: whole.total - 100, limit: 65536,
    expectedContentDigest: whole.contentDigest
  });
  assert.equal(reopenedPage.isError, false, JSON.stringify(reopenedPage.value));
  assert.equal(reopenedPage.value.nextOffset, null);
  assert.equal(whole.text.endsWith(reopenedPage.value.text), true, 'the reopened store pages the same durable text');

  // --- a wired workspace root is a ROUTING field of summary.details only ---
  // The optional constructor root names the store this reply came from. It is
  // absent from a rootless harness, absent from the raw status view (so the
  // content digest is unchanged) and stripped before the ledger parses the call.
  current.service = h.open(ROOT);
  const routed = await send(statusArgs({ attemptId: begun.value.attemptId }));
  assert.equal(routed.value.truncated, true);
  assert.equal(routed.value.summary.details.workspaceRoot, ROOT);
  assert.equal(reopened.value.summary.details.workspaceRoot, undefined);
  assert.equal(routed.value.summary.guard.value, reopened.value.summary.guard.value);
  assert.equal(routed.value.summary.fullViewChars, reopened.value.summary.fullViewChars);
  assert.equal(routed.value.summary.detailsFormat.total, reopened.value.summary.detailsFormat.total);
  assert.equal(routed.value.contentDigest, reopened.value.contentDigest);
  const { workspaceRoot: routedRoot, ...routedCall } = routed.value.summary.details;
  assert.equal(routedRoot, ROOT);
  assert.deepEqual(integrationActionSchema.parse(routedCall), routedCall);
  current.service = h.open();


  // --- release is acknowledged, observable and drops retention once --------
  const releaseArgs = {
    action: 'release', ownerId: OWNER, teamId: TEAM, attemptId: begun.value.attemptId,
    expectedRevision: revision, requestId: 'release-huge', abandon: true, releaseRetention: true
  };
  const released = await send(releaseArgs);
  assert.equal(released.isError, false, JSON.stringify(released.value));
  assert.equal(released.value.truncated, true);
  assert.equal(released.value.status, 'abandoned');
  // Release records `releasing` durably, drops the pins, then records the
  // terminal status: two durable revisions for ONE deliverable acknowledgment.
  assert.equal(released.value.revision, revision + 2);
  assert.equal(released.value.summary.counts.conflictPaths, 3002);
  assert.ok(released.replyChars < BRIDGE_RESPONSE_CAP);
  assert.equal(h.state.releases, 1, 'the release port dropped the pins exactly once');
  const releaseReplay = await send(releaseArgs);
  assert.equal(releaseReplay.isError, false, JSON.stringify(releaseReplay.value));
  assert.equal(releaseReplay.value.replayed, true);
  assert.equal(releaseReplay.value.status, 'abandoned');
  assert.equal(releaseReplay.value.revision, released.value.revision, 'the replay repeats no effect');
  assert.equal(h.state.releases, 1, 'the exact release replay never drops pins twice');

  const statusAfter = await send(statusArgs({ attemptId: begun.value.attemptId }));
  assert.equal(statusAfter.value.truncated, true);
  assert.equal(statusAfter.value.status, 'abandoned');
  assert.equal(statusAfter.value.revision, released.value.revision);
  assert.equal(statusAfter.value.controls.pinState, 'none');
  // The release acknowledgment and the post-release status describe ONE canonical
  // document at the post-release revision, so their guards agree and both page.
  assertExecutableDetails(released.value.summary);
  assert.equal(released.value.summary.guard.value, statusAfter.value.summary.guard.value);
  assert.equal(released.value.summary.detailsFormat.total, statusAfter.value.summary.detailsFormat.total);
  const releasedPage = await pageFromSummary(send, released.value.summary);
  assert.equal(releasedPage.view.action, 'status');
  assert.equal(releasedPage.view.replayed, false);
  assert.equal(releasedPage.view.status, 'abandoned');

  // Release changed RETENTION only: every original path stays durable.
  const ledgerAfter = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const after = ledgerAfter.attempts.find(entry => entry.id === begun.value.attemptId);
  assert.deepEqual(after.conflicts, [HUGE_CONFLICT]);
  assert.equal(after.status, 'abandoned');
  assert.equal(after.revision, released.value.revision);
  assert.equal(after.pinState, 'none');
  assert.equal(after.requests.filter(entry => entry.action === 'release').length, 1);

  // --- a stale revision and another owner/team never receive a page --------
  const stale = await send({
    action: 'details', ownerId: OWNER, teamId: TEAM, attemptId: begun.value.attemptId,
    expectedRevision: revision
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.value.error.code, 'revision_conflict');
  const otherOwner = await send({
    action: 'details', ownerId: 'a-different-coordinator', teamId: TEAM,
    attemptId: begun.value.attemptId, expectedRevision: released.value.revision
  });
  assert.equal(otherOwner.value.error.code, 'attempt_missing');
  const otherTeam = await send({
    action: 'details', ownerId: OWNER, teamId: '2'.repeat(32),
    attemptId: begun.value.attemptId, expectedRevision: released.value.revision
  });
  assert.equal(otherTeam.value.error.code, 'attempt_missing');
});

test('a 3002-path union is approved by its digest and stays under the metadata byte bound', async t => {
  const { h, current, send } = await bridgeConflictHarness(t, {
    conflicts: [{ id: SEED_A, conflict: HUGE_CONFLICT }, { id: SEED_C, conflict: SMALL_CONFLICT }]
  });
  const union = [...new Set(HUGE_CONFLICT.paths)].sort();
  assert.equal(union.length, 3002);
  assert.equal(Math.max(...union.map(value => value.length)), 1810);
  const begun = await send(beginArgs({ requestId: 'begin-bound', sources: conflictSources }));
  assert.equal(begun.value.status, 'ready');
  const attempt = attemptControls(begun.value.attemptId);
  const candidate = await send({
    ...attempt, action: 'candidate', expectedRevision: begun.value.revision,
    requestId: 'cand-bound', artifact: ART_C2
  });
  assert.equal(candidate.isError, false, JSON.stringify(candidate.value));
  const validated = await send({
    ...attempt, action: 'validate', expectedRevision: candidate.value.revision,
    requestId: 'val-bound', evidence: [EV_V]
  });
  const digest = validated.value.conflictPathsDigest;
  assert.equal(digest, expectedDigest(attempt.attemptId, union));

  // The previous approval re-copied this whole 5.4 M-byte union into the
  // acceptance record, so a legal record was refused by the byte bound. The
  // digest acknowledgment keeps the SAME decision inside the same bound.
  const approved = await send({
    ...attempt, action: 'accept', expectedRevision: validated.value.revision,
    requestId: 'accept-bound', resolvedPathsDigest: digest
  });
  assert.equal(approved.isError, false, JSON.stringify(approved.value.error));
  assert.equal(approved.value.status, 'accepted');
  assert.equal(approved.value.truncated, true);
  assert.equal(approved.value.summary.counts.conflictPaths, 3002);
  assert.equal(approved.value.summary.counts.acceptanceResolvedPaths, 3002);
  const ledgerFile = path.join(h.directory, 'integration-attempts.json');
  const ledgerText = await fs.readFile(ledgerFile, 'utf8');
  const ledgerBytes = Buffer.byteLength(ledgerText, 'utf8');
  assert.ok(ledgerBytes < MAX_LEDGER_BYTES, `the approved ledger is ${ledgerBytes} bytes`);
  const stored = JSON.parse(ledgerText).attempts.find(entry => entry.id === attempt.attemptId);
  assert.equal(Object.hasOwn(stored.acceptance, 'resolvedPaths'), false, 'no second copy of the union is written');
  assert.equal(stored.acceptance.resolvedPathsDigest, digest);
  assert.deepEqual(stored.conflicts, [HUGE_CONFLICT]);
  // The PREVIOUS shape copied that same union into the acceptance record again, so
  // a legal record was refused by the byte bound instead of being approved.
  const unionBytes = union.reduce((total, value) => total + Buffer.byteLength(value, 'utf8') + 3, 0);
  assert.ok(unionBytes >= 4 * 1024 * 1024, `the duplicated union is ${unionBytes} bytes`);
  assert.ok(ledgerBytes + unionBytes >= MAX_LEDGER_BYTES, 'the old full-list acceptance could not fit the byte bound');

  // --- reload: the SAME record proves the exact union from its digest only --
  await current.service.close();
  current.service = h.open();
  const reopened = await send(statusArgs({ attemptId: attempt.attemptId }));
  assert.equal(reopened.isError, false, JSON.stringify(reopened.value));
  assert.equal(reopened.value.truncated, true);
  assert.equal(reopened.value.status, 'accepted');
  assert.equal(reopened.value.conflictPathsDigest, digest);
  assert.equal(reopened.value.summary.counts.acceptanceResolvedPaths, 3002);
  assert.equal(reopened.value.controls.acceptanceRequestId, 'accept-bound');
  // The derived array really closes the acceptance object inside the view text.
  const tail = await send({
    action: 'details', ownerId: OWNER, teamId: TEAM, attemptId: attempt.attemptId,
    expectedRevision: reopened.value.revision,
    expectedContentDigest: reopened.value.summary.guard.value,
    offset: reopened.value.summary.fullViewChars - 800, limit: 65536
  });
  assert.equal(tail.isError, false, JSON.stringify(tail.value));
  assert.equal(tail.value.nextOffset, null);
  assert.equal(tail.value.text.includes('],"requestId":"accept-bound"'), true);

  // --- a corrupt compact acceptance is not advertised as publishable --------
  // The bounded summary is the ONLY reply this oversized record can return, so it
  // must not offer a decision the next call would refuse.
  const approvedText = await fs.readFile(ledgerFile, 'utf8');
  const tampered = JSON.parse(approvedText);
  const tamperedRecord = tampered.attempts.find(entry => entry.id === begun.value.attemptId);
  tamperedRecord.acceptance = {
    resolvedPathsDigest: 'f'.repeat(64),
    requestId: tamperedRecord.acceptance.requestId,
    at: tamperedRecord.acceptance.at
  };
  await current.service.close();
  await fs.writeFile(ledgerFile, JSON.stringify(tampered));
  current.service = h.open();
  const unproved = await send(statusArgs({ attemptId: begun.value.attemptId }));
  assert.equal(unproved.isError, false, JSON.stringify(unproved.value));
  assert.equal(unproved.value.truncated, true);
  assert.equal(unproved.value.status, 'accepted', 'the durable record stays readable');
  assert.equal(unproved.value.conflictPathsDigest, digest);
  assert.equal(unproved.value.controls.acceptanceRequestId, 'accept-bound');
  assert.equal(unproved.value.controls.canPublish, false, 'a corrupt proof is not publishable');
  assert.equal(unproved.value.summary.counts.acceptanceResolvedPaths, null);
  // Restore the approved record: the release below rests on its exact digest.
  await current.service.close();
  await fs.writeFile(ledgerFile, approvedText);
  current.service = h.open();

  // --- safe release is still deliverable and drops retention once ----------
  const released = await send({
    ...attempt, action: 'release', expectedRevision: reopened.value.revision,
    requestId: 'release-bound', abandon: true, releaseRetention: true
  });
  assert.equal(released.isError, false, JSON.stringify(released.value));
  assert.equal(released.value.status, 'abandoned');
  assert.equal(h.state.releases, 1);
  assert.equal(h.state.publishes.length, 0, 'acceptance never published');
});

test('every lifecycle acknowledgment of an oversized accepted view is deliverable', async t => {
  const { h, send } = await bridgeConflictHarness(t, {
    conflicts: [{ id: SEED_A, conflict: LIFECYCLE_CONFLICT }]
  });
  const union = [...new Set(LIFECYCLE_CONFLICT.paths)].sort();
  assert.equal(union.length, 1002);

  const begun = await send(beginArgs({ requestId: 'begin-lifecycle', sources: conflictSources }));
  assert.equal(begun.isError, false, JSON.stringify(begun.value));
  // A view that still fits the budget is unchanged: the exact union arrives whole.
  assert.equal(begun.value.truncated, undefined);
  assert.equal(begun.value.status, 'ready');
  assert.deepEqual(begun.value.conflictPaths, union);
  const attempt = attemptControls(begun.value.attemptId);

  const candidate = await send({
    ...attempt, action: 'candidate', expectedRevision: begun.value.revision,
    requestId: 'cand-lifecycle', artifact: ART_C2
  });
  assert.equal(candidate.value.truncated, undefined);
  assert.equal(candidate.value.candidate.lane, 'integration');
  const validated = await send({
    ...attempt, action: 'validate', expectedRevision: candidate.value.revision,
    requestId: 'val-lifecycle', evidence: [EV_V]
  });
  assert.equal(validated.value.truncated, undefined);
  assert.equal(validated.value.status, 'validated');
  const digest = validated.value.conflictPathsDigest;
  assert.equal(digest, expectedDigest(attempt.attemptId, union));

  // --- accept: the durable decision is acknowledged by an arriving reply ----
  const acceptArgs = {
    ...attempt, action: 'accept', expectedRevision: validated.value.revision,
    requestId: 'accept-lifecycle', resolvedPathsDigest: digest
  };
  const accepted = await send(acceptArgs);
  assert.equal(accepted.isError, false, JSON.stringify(accepted.value));
  assert.equal(accepted.value.truncated, true);
  assert.equal(accepted.value.status, 'accepted');
  assert.equal(accepted.value.revision, validated.value.revision + 1);
  assert.equal(accepted.value.conflictPathsDigest, digest);
  assert.equal(accepted.value.summary.counts.conflictPaths, 1002);
  assert.equal(accepted.value.summary.counts.acceptanceResolvedPaths, 1002);
  assert.equal(accepted.value.controls.acceptanceRequestId, 'accept-lifecycle');
  assert.equal(Object.hasOwn(accepted.value, 'acceptance'), false, 'no partial approval preview');
  assert.ok(accepted.replyChars < BRIDGE_RESPONSE_CAP, `the accept reply is ${accepted.replyChars} characters`);
  assert.ok(accepted.replyChars <= SUMMARY_CEILING_CHARS);
  const acceptedReplay = await send(acceptArgs);
  assert.equal(acceptedReplay.value.replayed, true);
  assert.equal(acceptedReplay.value.revision, accepted.value.revision);
  assert.equal(acceptedReplay.value.truncated, true);

  // The complete accepted view pages back with the FULL durable approval, driven
  // by each advertised summary.details object, sent verbatim.
  for (const reply of [accepted, acceptedReplay]) {
    const paged = await pageFromSummary(send, reply.value.summary);
    assert.equal(paged.contentDigest, accepted.value.summary.guard.value);
    assert.equal(paged.text, JSON.stringify(paged.view));
  }
  const acceptedView = JSON.parse((await pageFromSummary(send, accepted.value.summary)).text);
  assert.equal(acceptedView.status, 'accepted');
  assert.equal(acceptedView.revision, accepted.value.revision);
  assert.deepEqual(acceptedView.conflictPaths, union);
  assert.deepEqual(acceptedView.conflicts, [LIFECYCLE_CONFLICT]);
  assert.deepEqual(acceptedView.acceptance.resolvedPaths, union);
  assert.equal(acceptedView.acceptance.requestId, 'accept-lifecycle');
  assert.equal(acceptedView.conflictPathsDigest, digest);

  // --- apply: the publication result is acknowledged, never lost -----------
  const applyArgs = {
    ...attempt, action: 'apply', expectedRevision: accepted.value.revision, requestId: 'apply-lifecycle'
  };
  const applied = await send(applyArgs);
  assert.equal(applied.isError, false, JSON.stringify(applied.value));
  assert.equal(applied.value.truncated, true);
  assert.equal(applied.value.status, 'applied');
  // The durable applying intent and the recorded result are two revisions.
  assert.equal(applied.value.revision, accepted.value.revision + 2);
  assert.equal(applied.value.controls.applyState, 'applied');
  assert.equal(applied.value.controls.applyRequestId, 'apply-lifecycle');
  assert.equal(applied.value.summary.counts.applyApplied, 1);
  assert.equal(h.state.publishes.length, 1);
  const appliedReplay = await send(applyArgs);
  assert.equal(appliedReplay.value.replayed, true);
  assert.equal(appliedReplay.value.status, 'applied');
  assert.equal(appliedReplay.value.revision, applied.value.revision);
  assert.equal(h.state.publishes.length, 1, 'an exact apply replay repeats no publication');

  // Both the applied summary and its exact replay are directly executable.
  for (const reply of [applied, appliedReplay]) {
    const paged = await pageFromSummary(send, reply.value.summary);
    assert.equal(paged.contentDigest, applied.value.summary.guard.value);
    assert.equal(paged.view.action, 'status');
    assert.equal(paged.view.replayed, false);
  }
  const appliedView = (await pageFromSummary(send, applied.value.summary)).view;
  assert.deepEqual(appliedView.acceptance.resolvedPaths, union);
  assert.deepEqual(appliedView.apply.applied, ['src/out.txt']);
  assert.equal(appliedView.status, 'applied');

  // --- release: observable with the exact revision, retention dropped once -
  const releaseArgs = {
    ...attempt, action: 'release', expectedRevision: applied.value.revision,
    requestId: 'release-lifecycle', abandon: true, releaseRetention: true
  };
  const released = await send(releaseArgs);
  assert.equal(released.isError, false, JSON.stringify(released.value));
  assert.equal(released.value.truncated, true);
  assert.equal(released.value.status, 'released');
  assert.equal(released.value.revision, applied.value.revision + 2);
  assert.equal(h.state.releases, 1);
  const releaseReplay = await send(releaseArgs);
  assert.equal(releaseReplay.value.replayed, true);
  assert.equal(releaseReplay.value.status, 'released');
  assert.equal(releaseReplay.value.revision, released.value.revision);
  assert.equal(h.state.releases, 1);

  // The abandoned record keeps the approval and the report, and stays readable.
  // release AND its exact replay advertise the same canonical status document.
  for (const reply of [released, releaseReplay]) {
    const paged = await pageFromSummary(send, reply.value.summary);
    assert.equal(paged.contentDigest, released.value.summary.guard.value);
    assert.equal(paged.total, released.value.summary.fullViewChars);
  }
  const releasedView = (await pageFromSummary(send, released.value.summary)).view;
  assert.equal(releasedView.status, 'released');
  assert.equal(releasedView.pinState, 'none');
  assert.deepEqual(releasedView.conflicts, [LIFECYCLE_CONFLICT]);
  assert.deepEqual(releasedView.acceptance.resolvedPaths, union);
  assert.deepEqual(releasedView.apply.applied, ['src/out.txt']);
});

test('a requirements and inherited overflow is bounded too and pages back whole', async t => {
  const h = await harness(t, {
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }]
  });
  let service = h.open();
  const begun = await begin(service);
  await service.close();

  // A legal durable record whose size comes from ordinary view fields - 16
  // maximal source requirements plus 256 inherited witnesses - not from conflicts.
  const file = path.join(h.directory, 'integration-attempts.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  const record = ledger.attempts.find(entry => entry.id === begun.attemptId);
  const requirement = index => {
    const descriptionPrefix = `${index}:`;
    return {
      taskId: (index + 1).toString(16).padStart(32, '0'),
      taskRevision: index,
      title: `Requirement ${index}`,
      description: descriptionPrefix + 'x'.repeat(4000 - descriptionPrefix.length),
      state: 'accepted',
      acceptanceCriteria: Array.from({ length: 20 }, (_, item) => {
        const criterionPrefix = `${index}-${item}:`;
        return criterionPrefix + 'y'.repeat(500 - criterionPrefix.length);
      }),
      artifact: { id: 'a'.repeat(64), version: 1, uri: 'submission://artifact-a/1' },
      evidence: Array.from({ length: 16 }, (_, item) => ({
        id: (item + 1).toString(16).padStart(32, '0'), version: 1, uri: 'runner://result-a/1'
      })),
      producer: { workerId: WORKER_A, workerCreatedAt: CREATED }
    };
  };
  record.requirements.sources = Array.from({ length: 16 }, (_, index) => requirement(index));
  record.inherited = Array.from({ length: 256 }, (_, index) => ({
    taskId: (index + 1000).toString(16).padStart(32, '0'),
    taskRevision: index,
    attemptId: (index + 1).toString(16).padStart(64, '0'),
    snapshotId: 'c'.repeat(64),
    artifact: { id: 'b'.repeat(64), version: 1, uri: 'submission://artifact-b/1' },
    requirement: requirement(index + 2000)
  }));
  const text = JSON.stringify(ledger);
  assert.ok(Buffer.byteLength(text, 'utf8') < MAX_LEDGER_BYTES);
  await fs.writeFile(file, text);
  service = h.open();

  const status = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(status.truncated, true);
  assert.equal(status.status, 'ready');
  assert.equal(status.summary.counts.sources, 16);
  assert.equal(status.summary.counts.inherited, 256);
  assert.equal(status.summary.counts.conflictGroups, 0);
  assert.equal(status.summary.counts.conflictPaths, 0);
  assert.equal(status.summary.counts.contracts, 0);
  assert.equal(status.summary.omitted.includes('requirements'), true);
  assert.equal(status.summary.omitted.includes('inherited'), true);
  assert.equal(Object.hasOwn(status, 'requirements'), false);
  assert.equal(Object.hasOwn(status, 'inherited'), false);
  // The worst case of the fallback is bounded by its own scalar fields.
  assert.ok(replyCharsOf(status) <= SUMMARY_CEILING_CHARS, `the summary is ${replyCharsOf(status)} characters`);
  assert.equal(status.conflictPathsDigest, expectedDigest(begun.attemptId, []));

  // The same paging reassembles this complete view exactly - driven by the
  // advertised summary.details object itself.
  assertExecutableDetails(status.summary);
  const whole = await pageFromSummary(serviceRead(service), status.summary);
  assert.equal(whole.total, status.summary.fullViewChars);
  assert.equal(whole.contentDigest, status.summary.guard.value);
  const view = JSON.parse(whole.text);
  assert.equal(view.truncated, undefined);
  assert.deepEqual(view.requirements, record.requirements);
  assert.deepEqual(view.inherited, record.inherited);
  assert.equal(view.requirements.sources.length, 16);
  assert.equal(view.inherited.length, 256);
  assert.equal(view.conflictPathsDigest, status.conflictPathsDigest);

  // Reading it never mutates the record, records a receipt or moves a revision.
  assert.equal(await fs.readFile(file, 'utf8'), text);
  const after = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(after.revision, status.revision);
  assert.equal(after.summary.fullViewChars, status.summary.fullViewChars);
});

test('details paging is lossless for quotes, control, unicode and surrogate boundaries', async t => {
  const NASTY = 'quote " backslash \\ slash / newline\n tab\t ctrl\u0001 ctrl\u001f emoji 😀🎉 musical 𝄞 end';
  const h = await harness(t, {
    tasks: [task(TASK_A, { candidates: [ART_A], assigneeWorkerId: WORKER_A, description: NASTY })],
    sealed: [{ ref: ART_A, options: { workerId: WORKER_A } }]
  });
  const service = h.open();
  const ledgerFile = path.join(h.directory, 'integration-attempts.json');
  const begun = await begin(service);
  const ledgerText = await fs.readFile(ledgerFile, 'utf8');
  // A small legacy attempt keeps its ordinary complete response.
  assert.equal(begun.truncated, undefined);
  assert.deepEqual(begun.conflictPaths, []);
  const status = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(status.truncated, undefined);
  assert.equal(status.requirements.sources[0].description, NASTY);
  const text = JSON.stringify(status);
  assert.ok(text.includes('😀🎉'), 'the view text keeps its literal unicode');
  assert.ok(text.includes('\\"'), 'the view text keeps its quoted strings');
  const details = {
    action: 'details', ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId,
    expectedRevision: status.revision
  };
  // The offset-0 page reports the content guard every continuation repeats.
  const head = await service.invoke(details, authorize);
  assert.match(head.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(head.guard.value, head.contentDigest);
  assert.equal(head.guard.chars, head.total);
  const continuation = { ...details, expectedContentDigest: head.contentDigest };

  // Tiny pages over the exact text, reassembled without loss.
  for (const limit of [1, 3, 7, 65536]) {
    const whole = await collectDetails(serviceRead(service), {
      attemptId: begun.attemptId, expectedRevision: status.revision
    }, limit);
    assert.equal(whole.text, text, `limit ${limit} reassembles the exact view text`);
    assert.deepEqual(JSON.parse(whole.text), status);
    assert.equal(whole.total, text.length);
    if (limit < text.length) {
      assert.ok(whole.pages > 1);
    }
  }
  // A page may exceed `limit` by ONE code unit to keep a surrogate pair whole.
  const pairOffset = text.indexOf('😀');
  const paired = await service.invoke({ ...continuation, limit: 1, offset: pairOffset }, authorize);
  // The page reports the SAME guard it required, so a client can verify it.
  assert.equal(paired.contentDigest, head.contentDigest);
  assert.equal(paired.text, '😀');
  assert.equal(paired.nextOffset, pairOffset + 2);
  const midPair = pairOffset + 1;
  await assert.rejects(service.invoke({ ...continuation, offset: midPair }, authorize),
    error => error instanceof WorkerError && error.code === 'invalid_arguments');
  // A continuation without the content guard, or with another document's guard,
  // is refused before any page is returned.
  await assert.rejects(service.invoke({ ...details, offset: pairOffset }, authorize),
    error => error instanceof WorkerError && error.code === 'invalid_arguments');
  await assert.rejects(service.invoke({ ...details, expectedContentDigest: 'f'.repeat(64) }, authorize),
    error => error instanceof WorkerError && error.code === 'content_changed');
  // Paging with the reported guard reproduces the exact document.
  const guarded = await collectDetails(serviceRead(service), {
    attemptId: begun.attemptId, expectedRevision: status.revision
  }, 64);
  assert.equal(guarded.text, text);
  assert.equal(guarded.contentDigest, head.contentDigest);
  // The documented default and the strict bounds.
  const defaults = await service.invoke(details, authorize);
  assert.equal(defaults.limit, 16384);
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.nextOffset, null);
  assert.equal(defaults.text, text);
  const maxPage = await service.invoke({ ...details, limit: 65536 }, authorize);
  assert.equal(maxPage.limit, 65536);
  assert.equal(maxPage.contentDigest, head.contentDigest, 'the guard is stable for one document');
  assert.equal(defaults.contentDigest, head.contentDigest);
  for (const invalid of [
    { ...details, limit: 0 },
    { ...details, limit: 65537 },
    { ...continuation, offset: -1 },
    { ...continuation, offset: text.length + 1 },
    { ...details, expectedRevision: undefined },
    { ...details, expectedRevision: status.revision - 1 }
  ]) {
    await assert.rejects(service.invoke(invalid, authorize), error => error instanceof WorkerError
      && (error.code === 'invalid_arguments' || error.code === 'revision_conflict'));
  }
  // A details read never carries a request receipt, and it authorizes the same
  // owner and team only.
  assert.throws(() => integrationActionSchema.parse({ ...details, requestId: 'details-1' }));
  assert.throws(() => integrationActionSchema.parse({ ...details, limit: 65537 }));
  await assert.rejects(service.invoke({ ...details, ownerId: 'another-owner' }, authorize),
    error => error instanceof WorkerError && error.code === 'attempt_missing');
  await assert.rejects(service.invoke({ ...details, teamId: '3'.repeat(32) }, authorize),
    error => error instanceof WorkerError && error.code === 'attempt_missing');
  assert.equal(await fs.readFile(ledgerFile, 'utf8'), ledgerText, 'no details read rewrote the ledger');
  const unchanged = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  assert.equal(unchanged.revision, status.revision);
  assert.deepEqual(unchanged.updatedAt, status.updatedAt);
});
test('details paging fences a view content change at the SAME attempt revision', async t => {
  const h = await harness(t, {
    sealed: [
      { ref: ART_A, options: { workerId: WORKER_A } },
      { ref: ART_C, options: { workerId: WORKER_V, revision: 0 } }
    ]
  });
  const service = h.open();
  const begun = await begin(service);
  const accepted = await applyReady(service, begun);
  const ledgerFile = path.join(h.directory, 'integration-attempts.json');
  const applyArgs = {
    ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId, action: 'apply',
    expectedRevision: accepted.revision, requestId: 'apply-1'
  };

  // Two FAILED exact apply retries. The first records a failure; the second also
  // raises the durable journal revision floor through `onJournalIntent`. Neither
  // bumps `attempt.revision` (publish()'s catch and journalIntent() persist at the
  // CURRENT revision), and both change the serialized status view.
  const steps = [
    { message: 'journal unavailable: first attempt', floor: null },
    { message: 'journal unavailable: second attempt', floor: 7 }
  ];
  h.ports.publish = async (scope, baseSnapshotId, ref, check, options) => {
    const step = steps.shift();
    check();
    if (step.floor !== null) {
      await options.onJournalIntent(step.floor);
    }
    throw new WorkerError('publish_failed', step.message);
  };
  const publishFailed = promise => assert.rejects(promise,
    error => error instanceof WorkerError && error.code === 'publish_failed');

  await publishFailed(service.invoke(applyArgs, authorize));
  const first = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  const firstText = JSON.stringify(first);
  assert.equal(first.status, 'applying');
  assert.equal(first.failure.message, 'journal unavailable: first attempt');
  assert.equal(first.publicationJournalRevision, null);

  const limit = 200;
  const read = (offset, extra = {}) => service.invoke({
    ownerId: OWNER, teamId: TEAM, attemptId: begun.attemptId, action: 'details',
    expectedRevision: first.revision, limit, offset, ...extra
  }, authorize);
  // The cursor a client would hold after a first page of the FIRST document.
  const oldHead = await read(0);
  assert.notEqual(oldHead.nextOffset, null, 'the first document needs more than one page');
  const oldCursor = oldHead.nextOffset;

  // The exact retry fails again, now at the SAME revision with a NEW document.
  await publishFailed(service.invoke(applyArgs, authorize));
  const second = await service.invoke(statusArgs({ attemptId: begun.attemptId }), authorize);
  const secondText = JSON.stringify(second);
  assert.equal(second.revision, first.revision, 'a failed publication retry does not bump the revision');
  assert.equal(second.status, 'applying');
  assert.equal(second.failure.message, 'journal unavailable: second attempt');
  assert.equal(second.publicationJournalRevision, 7, 'the journal checkpoint is durable');
  assert.equal(second.publicationJournalEstablished, true);
  assert.notEqual(secondText, firstText, 'the same revision now serializes a different document');

  // The dangerous case: the first page is byte-identical, and only the tail moved.
  const newHead = await read(0);
  assert.equal(newHead.text, oldHead.text, 'the leading page is unchanged');
  assert.notEqual(newHead.contentDigest, oldHead.contentDigest, 'the content guard moved');

  // An old cursor can never be continued against the new document.
  await assert.rejects(read(oldCursor, { expectedContentDigest: oldHead.contentDigest }),
    error => error instanceof WorkerError && error.code === 'content_changed');
  await assert.rejects(read(oldCursor),
    error => error instanceof WorkerError && error.code === 'invalid_arguments');
  // A guard from another document is refused even at offset 0.
  await assert.rejects(read(0, { expectedContentDigest: oldHead.contentDigest }),
    error => error instanceof WorkerError && error.code === 'content_changed');
  await assert.rejects(read(0, { expectedContentDigest: 'a'.repeat(64) }),
    error => error instanceof WorkerError && error.code === 'content_changed');

  // The revision is still unchanged and the refusals wrote nothing.
  const ledger = await fs.readFile(ledgerFile, 'utf8');
  const record = JSON.parse(ledger).attempts.find(entry => entry.id === begun.attemptId);
  assert.equal(record.revision, first.revision);
  assert.equal(record.requests.filter(entry => entry.action === 'apply').length, 1);

  // With the NEW guard the new document assembles exactly, page for page.
  const whole = await collectDetails(serviceRead(service), {
    attemptId: begun.attemptId, expectedRevision: second.revision
  }, limit);
  assert.equal(whole.text, secondText);
  assert.equal(whole.contentDigest, newHead.contentDigest);
  assert.equal(whole.pages > 1, true);
  // Every page of that assembly named the same document.
  const secondPage = await read(newHead.nextOffset, { expectedContentDigest: newHead.contentDigest });
  assert.equal(secondPage.offset, newHead.nextOffset);
  assert.equal(secondPage.contentDigest, newHead.contentDigest);
  assert.equal(secondPage.text, secondText.slice(secondPage.offset, secondPage.nextOffset));
  // The mixed document the old cursor would have produced never existed.
  assert.notEqual(oldHead.text + secondPage.text, firstText);
  assert.notEqual(oldHead.text + secondPage.text, secondText);
  assert.equal(await fs.readFile(ledgerFile, 'utf8'), ledger, 'paging never rewrote the ledger');
});
