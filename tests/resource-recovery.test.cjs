'use strict';
// Focused resource-recovery regressions for three review findings:
//   1. a cancelled runner whose ledger withdrawal throws must not stay the
//      oldest eligible queue leader forever (bounded ticket liveness + retried
//      withdrawal), and a throwing admission.applies must be settled;
//   2. WorkerLifecycle.finishStorage must not quarantine a permit whose action
//      already completed: the known drain is recorded against the exact store and
//      reclaimed by that store's next healthy reconciliation;
//   3. only an owning live poll may take a queued model/tool/storage ticket: an
//      older eligible contender of another host orders the queue virtually and is
//      never persisted here, and an abandoned ticket is withdrawn after its
//      bounded liveness window without expiring any real effect. Initial OS-user
//      ledger creation is resumable from its pending namespace marker, while a
//      missing or corrupt established ledger still fails closed.
// Runner handoff regressions and storage-drain regressions are deliberately kept
// in separate tests: runner/model waiting stays its own admission domain, so a
// drained storage row is never expected to change it. Real temp directories
// only, a deterministic clock wherever liveness matters, and no process is ever
// started.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const buildDir = path.join(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { ResourceGovernor, resourceDefaults, storageUsage, DRAINED_TICKET_RETENTION_MS, RUNNER_TICKET_WINDOW_MS, WAITING_TICKET_WINDOW_MS } = require(path.join(buildDir, 'resource-governor'));
const { RunnerPool } = require(path.join(buildDir, 'runner-pool'));
const { WorkerLifecycle } = require(path.join(buildDir, 'worker-lifecycle'));
const { WorkerBroker, unpack } = require(path.join(buildDir, 'runtime'));

const TEAM = 'a'.repeat(32);
const ISO = '2024-01-01T00:00:00.000Z';
const MIB = 1024 ** 2;
const hex32 = label => crypto.createHash('sha256').update(`resource-recovery:${label}`).digest('hex').slice(0, 32);
const owner = label => ({ ownerId: `owner-${label}`, teamId: TEAM, workerId: hex32(label), workerCreatedAt: ISO });
const id = label => label.repeat(32);
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const readLedger = async base => JSON.parse(await fs.readFile(path.join(base, 'resources', 'ledger.json'), 'utf8'));

/** Await one settlement under a hard bound; `timeout` means it is still pending. */
async function bounded(promise, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise.then(lease => ({ lease }), error => ({ error })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ timeout: true }), milliseconds);
        timer.unref();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw Error('condition did not settle');
    }
    await tick();
  }
}

// ---------------------------------------------------------------------------
// Finding 1a: the bounded, durable liveness window of a WAITING runner ticket.
// ---------------------------------------------------------------------------

test('an abandoned runner ticket cannot lead the aggregate queue forever', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-window-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let now = 1_000_000;
  const resources = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true, runnerCapacity: 2 }),
    path.join(base, 'resources'), () => now);
  t.after(() => resources.close().catch(() => undefined));
  const admissionFor = async (name, overrides = {}) => {
    const root = path.join(base, `project-${name}`);
    await fs.mkdir(root, { recursive: true });
    return { ...resources.runnerAdmission(path.join(base, `store-${name}`, 'pool'), root, () => 'validation'), ...overrides };
  };
  const filler = await admissionFor('filler');
  // This admission's withdrawal always fails: the ticket stays durable.
  const older = await admissionFor('older', { cancel: async () => { throw Error('aggregate ledger unavailable'); } });
  const younger = await admissionFor('younger');
  const claims = async () => (await resources.status()).claims.filter(claim => claim.kind === 'runner');
  const keyOf = async label => (await claims()).find(claim => claim.key.endsWith(id(label)))?.key;
  const stateOf = async label => (await claims()).find(claim => claim.key.endsWith(id(label)))?.state;

  try {
    assert.equal(await filler.tryAcquire(id('c'), owner('c'), 2), true);
    assert.equal(await filler.tryAcquire(id('d'), owner('d'), 2), true, 'the aggregate runner bound is full');
    assert.equal(await older.tryAcquire(id('a'), owner('a'), 1), false, 'the oldest ticket waits for aggregate capacity');
    await filler.cancel(id('c'));

    // FIFO among LIVE eligible tickets: a younger poll never overtakes the older one.
    assert.equal(await younger.tryAcquire(id('b'), owner('b'), 1), false);
    assert.equal(await stateOf('a'), 'waiting');
    assert.equal(await stateOf('b'), 'waiting');

    // The older request is cancelled and its ledger withdrawal FAILS, which is
    // exactly the reported leak: a durable ticket that no longer has a waiter.
    await assert.rejects(older.cancel(id('a')), /aggregate ledger unavailable/);
    assert.equal(await stateOf('a'), 'waiting', 'the failed withdrawal really left a durable ticket behind');

    // A ticket is not expired out of hand: while its window is fresh it still
    // owns the leadership, so the younger poll keeps waiting.
    assert.equal(await younger.tryAcquire(id('b'), owner('b'), 1), false);
    assert.equal(await stateOf('a'), 'waiting');

    // An uncertain effect is never expired, whatever the clock says.
    await resources.quarantine(await keyOf('d'));
    now += RUNNER_TICKET_WINDOW_MS + 1;

    assert.equal(await younger.tryAcquire(id('b'), owner('b'), 1), true,
      'past its window the abandoned ticket is withdrawn, so the live poller takes the handoff');
    const after = await claims();
    assert.equal(after.some(claim => claim.key.endsWith(id('a'))), false, 'the abandoned ticket is gone from the ledger');
    assert.equal(after.find(claim => claim.key.endsWith(id('b')))?.state, 'active');
    assert.equal(after.find(claim => claim.key.endsWith(id('d')))?.state, 'quarantine', 'an uncertain effect is never expired');
  } finally {
    await younger.cancel(id('b')).catch(() => undefined);
    await filler.cancel(id('d')).catch(() => undefined);
  }
  assert.deepEqual(await claims(), []);
});

// ---------------------------------------------------------------------------
// Finding 1b: pool-level withdrawal (retried) and the bounded window, with two
// real pools, one shared aggregate ledger and a deterministic clock.
// ---------------------------------------------------------------------------

async function handoff(base, resources, name) {
  const root = path.join(base, `project-${name}`);
  await fs.mkdir(root, { recursive: true });
  const scope = path.join(base, `store-${name}`, 'pool');
  return { root, scope, real: resources.runnerAdmission(scope, root, () => 'work') };
}

test('a failed withdrawal is retried, so a cancelled runner never keeps the leadership', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-retry-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const resources = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true, runnerCapacity: 2 }), path.join(base, 'resources'));
  t.after(() => resources.close().catch(() => undefined));
  const older = await handoff(base, resources, 'a');
  const younger = await handoff(base, resources, 'b');
  const filler = await handoff(base, resources, 'f');
  // The withdrawal fails exactly once, then the pool's own retry succeeds.
  let failures = 1;
  const olderAdmission = {
    ...older.real,
    cancel: async admissionId => {
      if (failures > 0) {
        failures -= 1;
        throw Error('aggregate ledger unavailable');
      }
      return older.real.cancel(admissionId);
    }
  };
  const poolA = new RunnerPool(older.scope, { projectRoot: older.root, capacity: 2, maxQueue: 2, closeTimeoutMs: 2000,
    admission: { ...olderAdmission, applies: candidate => candidate.ownerId !== 'legacy' } });
  const poolB = new RunnerPool(younger.scope, { projectRoot: younger.root, capacity: 1, maxQueue: 2, closeTimeoutMs: 2000,
    admission: younger.real });
  await poolA.open();
  await poolB.open();
  t.after(async () => {
    await poolA.close().catch(() => undefined);
    await poolB.close().catch(() => undefined);
  });
  const who = (label, ownerId = 'parent') => ({ ownerId, teamId: TEAM, workerId: hex32(`retry-${label}`), workerCreatedAt: ISO });
  const claims = async () => (await resources.status()).claims.filter(claim => claim.kind === 'runner');
  const legacy = await poolA.acquire(who('legacy', 'legacy'));
  // The aggregate work budget is filled FIRST, so A's governed request is
  // guaranteed to get a durable waiting ticket (its own free slot lets it poll).
  assert.equal(await filler.real.tryAcquire(id('f'), owner('f'), 2), true);
  const controller = new AbortController();
  const cancelled = poolA.acquire(who('cancel'), controller.signal).then(lease => ({ lease }), error => ({ error }));
  try {
    await until(async () => (await claims()).some(claim => claim.scope === older.scope && claim.state === 'waiting'));

    controller.abort();
    assert.equal((await cancelled).error?.code, 'pool_aborted');
    await filler.real.cancel(id('f'));

    // The withdrawal failed once and the pool retried it: the ticket is gone
    // WITHOUT waiting for the liveness window.
    await until(async () => !(await claims()).some(claim => claim.scope === older.scope && claim.state === 'waiting'), 5000);
    assert.equal((await claims()).some(claim => claim.scope === older.scope), false, 'the retried withdrawal removed the cancelled ticket');
    assert.ok(poolA.status().diagnostics.some(entry => /Aggregate claim .* remains retained/.test(entry)),
      'the failed withdrawal is still reported');

    // The other root can take the handoff immediately.
    const granted = await bounded(poolB.acquire(who('b')), 5000);
    assert.ok(granted.lease, JSON.stringify(granted.error ?? granted));
    await granted.lease.release({ drained: true });
  } finally {
    await legacy.release({ drained: true }).catch(() => undefined);
  }
});

test('a permanently failing withdrawal is bounded by the ticket liveness window', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-bound-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const clock = { now: 1_000_000 };
  const resources = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true, runnerCapacity: 2 }),
    path.join(base, 'resources'), () => clock.now);
  t.after(() => resources.close().catch(() => undefined));
  const older = await handoff(base, resources, 'a');
  const younger = await handoff(base, resources, 'b');
  const filler = await handoff(base, resources, 'f');
  const olderAdmission = { ...older.real, cancel: async () => { throw Error('aggregate ledger unavailable'); } };
  const poolA = new RunnerPool(older.scope, { projectRoot: older.root, capacity: 2, maxQueue: 2, closeTimeoutMs: 2000,
    admission: { ...olderAdmission, applies: candidate => candidate.ownerId !== 'legacy' } });
  const poolB = new RunnerPool(younger.scope, { projectRoot: younger.root, capacity: 1, maxQueue: 2, closeTimeoutMs: 2000,
    admission: younger.real });
  await poolA.open();
  await poolB.open();
  t.after(async () => {
    await poolA.close().catch(() => undefined);
    await poolB.close().catch(() => undefined);
  });
  const who = (label, ownerId = 'parent') => ({ ownerId, teamId: TEAM, workerId: hex32(`bound-${label}`), workerCreatedAt: ISO });
  const claims = async () => (await resources.status()).claims.filter(claim => claim.kind === 'runner');
  const legacy = await poolA.acquire(who('legacy', 'legacy'));
  assert.equal(await filler.real.tryAcquire(id('f'), owner('f'), 2), true);
  const controller = new AbortController();
  const cancelled = poolA.acquire(who('cancel'), controller.signal).then(lease => ({ lease }), error => ({ error }));
  let pendingB;
  try {
    await until(async () => (await claims()).some(claim => claim.scope === older.scope && claim.state === 'waiting'));
    controller.abort();
    assert.equal((await cancelled).error?.code, 'pool_aborted');
    await filler.real.cancel(id('f'));
    pendingB = poolB.acquire(who('b'));

    // Every retry fails: the orphaned ticket is durable and still LIVE, so the
    // other root is held back for now (the reported head-of-line symptom).
    const blocked = await bounded(pendingB, 600);
    assert.equal(blocked.timeout, true, 'a live ticket keeps the handoff while its window is open');
    assert.equal(poolB.status().queue.length, 1);
    assert.equal((await claims()).some(claim => claim.scope === older.scope && claim.state === 'waiting'), true);

    // The bound: past the window the ticket is withdrawn deterministically.
    clock.now += RUNNER_TICKET_WINDOW_MS + 1;
    const granted = await bounded(pendingB, 10000);
    assert.ok(granted.lease, JSON.stringify(granted.error ?? granted));
    assert.equal((await claims()).some(claim => claim.scope === older.scope), false);
    await granted.lease.release({ drained: true });
  } finally {
    await legacy.release({ drained: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Finding 2: a completed tool/storage action is DRAINED, never quarantined.
// ---------------------------------------------------------------------------

/** Minimal lifecycle: only store.directory, root and the governor are touched. */
async function storageFixture(t, name) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `resource-recovery-${name}-`));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  await fs.mkdir(root);
  await fs.mkdir(storeDir);
  await fs.writeFile(path.join(storeDir, 'state.bin'), Buffer.alloc(4096, 7));
  const config = () => ({ enabled: true, modelCapacity: 8, runnableCapacity: 16, runnerCapacity: 4, storageBytes: 64 * MIB, serviceReserve: 1 });
  const governor = new ResourceGovernor(config, path.join(base, 'resources'));
  const lifecycle = new WorkerLifecycle(root, { directory: storeDir }, {}, {}, { evidence: {} }, governor, {}, () => ({}), () => undefined);
  t.after(() => governor.close().catch(() => undefined));
  return { base, root, storeDir, config, governor, lifecycle };
}

test('a completed storage action is drained, fenced while unknown, and reclaimed by the exact store', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor, lifecycle } = await storageFixture(t, 'drain');
  const realAccount = governor.account.bind(governor);
  let calls = 0;
  // The lifecycle hands its drain and its post-drain sample to the governor as ONE
  // recovery obligation, so a failed sample leaves an owned obligation behind and
  // the governor arms its bounded owner retry. The captured timer never fires on
  // its own: the fenced state below is observed deterministically, and the reload
  // stays the isolation this test proves.
  captureRetryTimers(t, governor);
  // The FIRST account (before the effect) succeeds; the final one fails, which is
  // exactly the probe: the action completed, only its accounting did not.
  governor.account = async (directory, measure) => {
    calls += 1;
    if (calls === 1) {
      return realAccount(directory, measure);
    }
    return realAccount(directory, async () => { throw Error('injected measurement failure (final account)'); });
  };
  let ran = false;
  await assert.rejects(lifecycle.withStorage(32 * MIB, async () => {
    ran = true;
    return 'action-completed';
  }, undefined, 'work', false), /injected measurement failure \(final account\)/);
  governor.account = realAccount;
  assert.equal(ran, true, 'the action itself completed');
  // The order of the caller's final two steps may change (drain before or after
  // its final accounting); both are one pre-effect and one post-effect sample.
  assert.ok(calls >= 2);

  const ledger = await readLedger(base);
  assert.equal(ledger.claims.length, 1, 'exactly one claim is recorded');
  const [row] = ledger.claims;
  assert.equal(row.state, 'drained', 'a completed action is a KNOWN drain, never a permanent quarantine');
  assert.equal(row.bytes, 32 * MIB);
  assert.deepEqual(Object.keys(ledger.stores), [row.store], 'the drain names the exact registered store');

  // Accounting is unknown, so admission stays fenced, but the drained permit
  // reserves nothing: a prior grant cannot lean on stale storage data.
  assert.equal(ledger.stores[row.store].uncertain, true);
  const fenced = await governor.status();
  assert.equal(fenced.summary.reservedBytes, 0, 'a drained permit reserves no bytes');
  assert.equal(fenced.summary.quarantine, 0);
  await assert.rejects(governor.acquire({ key: 'work:32mib', kind: 'storage', root, bytes: 32 * MIB, lane: 'work', store: storeDir },
    undefined, undefined, false), error => error.code === 'resource_busy' && /storage|quarantine/.test(error.message));

  // A fresh governor (reload) plus a healthy sample of THAT store reclaims it.
  await governor.close();
  const reloaded = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => reloaded.close().catch(() => undefined));
  await reloaded.account(storeDir, () => storageUsage(storeDir));
  const reclaimed = await readLedger(base);
  assert.equal(reclaimed.claims.length, 0, 'the exact store healthy sample reclaimed the durable ownership');
  assert.equal(reclaimed.stores[row.store].uncertain ?? false, false);
  const grant = await reloaded.acquire({ key: 'work:32mib:after', kind: 'storage', root, bytes: 32 * MIB, lane: 'work', store: storeDir },
    undefined, undefined, false);
  await grant.release();
  assert.equal((await reloaded.status()).claims.length, 0);
});

test('a post-drain accounting failure settles the permit as drained, never as an uncertain charge', { timeout: 30000 }, async t => {
  const { base, root, storeDir, governor } = await storageFixture(t, 'post-drain');
  const key = 'storage:post-drain';
  const request = { key, kind: 'storage', root, bytes: 32 * MIB, lane: 'work', store: storeDir };
  await governor.account(storeDir, () => storageUsage(storeDir));
  const permit = await governor.acquire(request, undefined, undefined, false);
  // The caller (lifecycle finishStorage) drains first and then performs its final
  // accounting, which is the step that now fails.
  await permit.drain();
  await assert.rejects(governor.account(storeDir, async () => { throw Error('final account unavailable'); }), /final account unavailable/);

  // A completed action is never retained as an uncertain effect, and its bytes are
  // not double charged: the drained row reserves nothing.
  const ledger = await readLedger(base);
  assert.ok(!ledger.claims.some(claim => claim.state === 'active' || claim.state === 'quarantine'),
    'a completed effect is never quarantined');
  assert.ok(ledger.claims.every(claim => claim.state === 'drained'));
  assert.equal((await governor.status()).summary.reservedBytes, 0);

  // Its exact store is reconciled by a fresh sample, which also clears the row.
  await governor.account(storeDir, () => storageUsage(storeDir));
  const settled = await readLedger(base);
  assert.equal(settled.claims.length, 0, 'the fresh sample reclaimed the durable ownership');
  const store = settled.stores[Object.keys(settled.stores)[0]];
  assert.equal(store.uncertain ?? false, false);
  assert.equal(store.bytes, await storageUsage(storeDir), 'the store charge is the fresh sample, never a stale one');
  assert.equal((await governor.status()).summary.reservedBytes, 0);
  const grant = await governor.acquire({ ...request, key: 'storage:after-post-drain' }, undefined, undefined, false);
  await grant.release();
});

// ---------------------------------------------------------------------------
// Regression (2b): a KNOWN drain whose ledger publication fails BEFORE it commits
// must never lose its permit. `finishStorage` settles a finished effect, so that
// permit is the ONLY handle on its durable claim: dropping it left the claim
// charged as an ACTIVE effect that no healthy sample can reclaim (only a known
// drain or an exact release can), and shutdown then kept the completed effect as
// a permanent quarantine. The effect is never run again; only its accounting is
// retried, by the ordinary reconciliation points and by shutdown.
// ---------------------------------------------------------------------------

test('a pre-publication drain failure retains the exact permit through repeated errors and reconciliation', { timeout: 30000 }, async t => {
  const { base, root, storeDir, governor, lifecycle } = await storageFixture(t, 'drain-unpublished');
  const storage = require(path.join(buildDir, 'storage'));

  // Deterministic fault injection: the atomic publication of a ledger draft that
  // carries the KNOWN DRAIN of this permit is refused, so the drain transaction
  // fails BEFORE committing and its claim stays ACTIVE. Every other transaction -
  // this store's accounting samples, the admissions and the retries - commits.
  const realAtomicWrite = storage.atomicWrite;
  let armed = 0;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (armed > 0 && path.basename(file) === 'ledger.json' && typeof text === 'string' && text.includes('"state":"drained"')) {
      armed -= 1;
      throw Error('injected pre-publication drain failure');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  t.after(() => { storage.atomicWrite = realAtomicWrite; });

  let effects = 0;
  const run = () => lifecycle.withStorage(32 * MIB, async () => {
    effects += 1;
    await fs.writeFile(path.join(root, 'disposable.txt'), 'one harmless disposable effect');
    return 'action-completed';
  }, undefined, 'work', false);

  // The effect completes exactly once; only its drain publication fails.
  armed = 1;
  await assert.rejects(run(), /injected pre-publication drain failure/);
  assert.equal(armed, 0, 'the publication failure was really injected');
  assert.equal(effects, 1, 'the completed effect is never run again');

  // Fail-closed: the claim is still the ACTIVE charge of this host, nothing was
  // released, nothing was quarantined, and no fence was published either.
  let ledger = await readLedger(base);
  assert.equal(ledger.claims.length, 1, 'the exact claim is preserved');
  const [owned] = ledger.claims;
  assert.equal(owned.state, 'active', 'an unpublished drain keeps its conservative charge');
  assert.equal(owned.bytes, 32 * MIB);
  assert.equal(ledger.stores[Object.keys(ledger.stores)[0]].uncertain ?? false, false, 'no drain fence was published');

  // A REPEATED failure cannot lose it: this ordinary reconciliation retries the
  // same permit, fails again, and admission stays closed on the retained charge.
  armed = 1;
  await assert.rejects(run(), error => error.code === 'resource_busy' && /storage/.test(error.message),
    'the retained charge really keeps admission closed');
  assert.equal(armed, 0, 'the reconciliation retry was the injected failure');
  assert.equal(effects, 1, 'a refused reconciliation never re-runs the finished effect');
  ledger = await readLedger(base);
  assert.equal(ledger.claims.length, 1);
  assert.equal(ledger.claims[0].key, owned.key, 'the very same claim is still owned by the retained permit');
  assert.equal(ledger.claims[0].state, 'active');

  // The next ordinary reconciliation publishes that exact drain; the ONE sample
  // that follows it reclaims the row and clears its fence, so healthy admission
  // comes back without a leaked reservation or a blanket release.
  let published;
  const realAccount = governor.account.bind(governor);
  governor.account = async (directory, measure) => {
    published ??= await readLedger(base);
    return realAccount(directory, measure);
  };
  try {
    assert.equal(await run(), 'action-completed');
  } finally {
    governor.account = realAccount;
  }
  assert.equal(effects, 2, 'one effect per call, never one per retry');
  assert.equal(published.claims.length, 1, 'the retry published the drain of the SAME claim first');
  const [retried] = published.claims;
  assert.equal(retried.key, owned.key);
  assert.equal(retried.state, 'drained', 'a completed effect is a KNOWN drain, never a quarantine');
  assert.equal(retried.bytes, 32 * MIB);
  assert.equal(published.stores[retried.store].uncertain, true,
    'a published drain still fences its exact store until that sample runs');
  ledger = await readLedger(base);
  assert.deepEqual(ledger.claims, [], 'every known drain was reclaimed by a healthy sample of the exact store');
  assert.equal(ledger.stores[Object.keys(ledger.stores)[0]].uncertain ?? false, false);
  const readmitted = await governor.acquire({ key: 'storage:after-reconcile', kind: 'storage', root,
    bytes: 32 * MIB, lane: 'work', store: storeDir }, undefined, undefined, false);
  await readmitted.release();
  assert.deepEqual((await governor.status()).claims, []);
});

test('shutdown publishes a retained known drain instead of quarantining the completed effect', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor, lifecycle } = await storageFixture(t, 'drain-shutdown');
  const storage = require(path.join(buildDir, 'storage'));
  const realAtomicWrite = storage.atomicWrite;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (path.basename(file) === 'ledger.json' && typeof text === 'string' && text.includes('"state":"drained"')) {
      throw Error('injected pre-publication drain failure');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  let effects = 0;
  try {
    await assert.rejects(lifecycle.withStorage(32 * MIB, async () => {
      effects += 1;
      return 'action-completed';
    }, undefined, 'work', false), /injected pre-publication drain failure/);
  } finally {
    storage.atomicWrite = realAtomicWrite;
  }
  assert.equal(effects, 1, 'the effect is never run again');
  const failed = await readLedger(base);
  assert.equal(failed.claims.length, 1);
  assert.equal(failed.claims[0].state, 'active', 'the completed effect is still only charged, not settled');
  const key = failed.claims[0].key;

  // No ordinary reconciliation happened, so SHUTDOWN retries the retained permit -
  // before the governor's own close, which retains any remaining charge as an
  // uncertain effect for good.
  await lifecycle.close();
  await governor.close();
  const closed = await readLedger(base);
  assert.equal(closed.claims.length, 1);
  assert.equal(closed.claims[0].key, key, 'the SAME claim was settled, not a second one');
  assert.equal(closed.claims[0].state, 'drained', 'shutdown never quarantines a completed effect');
  assert.equal(closed.claims[0].bytes, 32 * MIB);
  assert.equal((await governor.status()).summary.quarantine, 0);

  // Reload: opening the exact registered store resamples the published fence,
  // reclaims the drained row, and normal storage admission works again.
  const reloaded = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => reloaded.close().catch(() => undefined));
  assert.equal(await reloaded.recoverStoreWrite(storeDir, () => storageUsage(storeDir)), true,
    'the published drain is reconciled by its exact store');
  const recovered = await readLedger(base);
  assert.deepEqual(recovered.claims, [], 'the exact store healthy sample reclaimed the drained row');
  assert.equal(recovered.stores[closed.claims[0].store].uncertain ?? false, false);
  const grant = await reloaded.acquire({ key: 'storage:after-shutdown', kind: 'storage', root,
    bytes: 32 * MIB, lane: 'work', store: storeDir }, undefined, undefined, false);
  await grant.release();
  assert.deepEqual((await reloaded.status()).claims, []);
});

test('an effect that finishes after its lifecycle closed is still settled by the governor close', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor, lifecycle } = await storageFixture(t, 'drain-after-close');
  const storage = require(path.join(buildDir, 'storage'));
  const realAtomicWrite = storage.atomicWrite;
  let armed = true;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (armed && path.basename(file) === 'ledger.json' && typeof text === 'string' && text.includes('"state":"drained"')) {
      throw Error('injected pre-publication drain failure');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  t.after(() => { storage.atomicWrite = realAtomicWrite; });

  let effects = 0;
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const running = lifecycle.withStorage(32 * MIB, async () => {
    effects += 1;
    entered();
    await gate;
    return 'action-completed';
  }, undefined, 'work', false);

  // The exact production order (runtime.ts close): this lifecycle is closed FIRST,
  // while the effect is still running, and only the engine drain and the global
  // governor close follow. A drain that fails after that point has no local owner
  // left, which is why the retry obligation lives in the governor.
  await started;
  await lifecycle.close();
  finish();
  await assert.rejects(running, /injected pre-publication drain failure/);
  assert.equal(effects, 1, 'the completed effect is never run again');
  const pending = await readLedger(base);
  assert.equal(pending.claims.length, 1);
  const key = pending.claims[0].key;
  assert.equal(pending.claims[0].state, 'active', 'the closed lifecycle can no longer publish it');

  // The governor owns the obligation, so ITS close settles the same claim instead
  // of retaining a finished effect as an uncertain charge.
  armed = false;
  await governor.close();
  const closed = await readLedger(base);
  assert.equal(closed.claims.length, 1);
  assert.equal(closed.claims[0].key, key, 'the SAME claim was settled, not a second one');
  assert.equal(closed.claims[0].state, 'drained');
  assert.equal(closed.claims[0].bytes, 32 * MIB);
  assert.equal((await governor.status()).summary.quarantine, 0);

  // Healthy reload semantics: the exact store's recovery reclaims the drain and
  // full-size storage admission works again.
  const reloaded = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => reloaded.close().catch(() => undefined));
  assert.equal(await reloaded.recoverStoreWrite(storeDir, () => storageUsage(storeDir)), true);
  const recovered = await readLedger(base);
  assert.deepEqual(recovered.claims, [], 'the exact store healthy sample reclaimed the drained row');
  const grant = await reloaded.acquire({ key: 'storage:after-close-order', kind: 'storage', root,
    bytes: 32 * MIB, lane: 'work', store: storeDir }, undefined, undefined, false);
  await grant.release();
  assert.deepEqual((await reloaded.status()).claims, []);
});

test('a persistent drain publication failure stays fail-closed and is quarantined', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor, lifecycle } = await storageFixture(t, 'drain-persistent');
  const storage = require(path.join(buildDir, 'storage'));
  const realAtomicWrite = storage.atomicWrite;
  // Every publication of this known drain fails: the store metadata is unreadable,
  // not transiently busy. No retry may ever turn this into an admission.
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (path.basename(file) === 'ledger.json' && typeof text === 'string' && text.includes('"state":"drained"')) {
      throw Error('injected persistent drain publication failure');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  t.after(() => { storage.atomicWrite = realAtomicWrite; });

  let effects = 0;
  const run = () => lifecycle.withStorage(32 * MIB, async () => {
    effects += 1;
    return 'action-completed';
  }, undefined, 'work', false);
  await assert.rejects(run(), /injected persistent drain publication failure/);
  assert.equal(effects, 1, 'the completed effect is never run again');

  // A reconciliation retry fails too, and the retained charge really fences
  // admission: this is fail-closed, not a silent release.
  await assert.rejects(run(), error => error.code === 'resource_busy' && /storage/.test(error.message));
  assert.equal(effects, 1);
  const retained = await readLedger(base);
  assert.equal(retained.claims.length, 1);
  assert.equal(retained.claims[0].state, 'active', 'a still-unpublished drain keeps its conservative charge');

  // Neither the local lifecycle's last retry nor the governor's own close can
  // publish it, so the finished effect ends exactly as a persistent failure must:
  // retained as an uncertain (quarantined) claim, never admitted from again.
  await lifecycle.close();
  await governor.close();
  const closed = await readLedger(base);
  assert.equal(closed.claims.length, 1);
  assert.equal(closed.claims[0].state, 'quarantine', 'persistent failure is retained, never dropped');
  assert.equal(closed.claims.some(claim => claim.state === 'drained'), false);
  assert.equal((await governor.status()).summary.quarantine, 1);
  assert.equal((await governor.status()).summary.reservedBytes, 32 * MIB);

  // The quarantine is durable and fail-closed: a healthy sample of the exact store
  // cannot reclaim an UNCERTAIN claim (only a known drain or an explicit release
  // can), so the bytes stay held across a reload and nothing was silently released.
  const reloaded = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => reloaded.close().catch(() => undefined));
  await reloaded.account(storeDir, () => storageUsage(storeDir));
  const durable = await readLedger(base);
  assert.equal(durable.claims.length, 1);
  assert.equal(durable.claims[0].state, 'quarantine', 'a persistent failure stays an uncertain effect');
  await assert.rejects(reloaded.acquire({ key: 'storage:after-persistent', kind: 'storage', root,
    bytes: 32 * MIB, lane: 'work', store: storeDir }, undefined, undefined, false),
  error => error.code === 'resource_busy' && /storage|quarantine/.test(error.message));
});

// ---------------------------------------------------------------------------
// Regression (2c): the OWNER of a finished effect reconciles it on its own.
// Reproduced stall (`.test-build/h-queued-drain-stall-probe.cjs`): two real
// 32 MiB work requests in a 64 MiB budget (work lane bound 56 MiB), the second
// already queued, the first effect finished, and ONE ledger write before its
// known drain commits fails. Nothing else happens - no new admission, no poll of
// the owner, no store reopen - and the queued waiter belongs to ANOTHER governor
// (a different host/root of the same aggregate), so a foreign poll can never
// publish the owner's drain. Only a coalesced, owner-driven publication and
// resample of the exact store can unblock that waiter.
// ---------------------------------------------------------------------------

/** Refuse exactly the ledger publications that already carry a KNOWN DRAIN. */
function drainFaults(t) {
  const storage = require(path.join(buildDir, 'storage'));
  const realAtomicWrite = storage.atomicWrite;
  const state = { armed: 0, injected: 0, gated: false, entered: () => undefined, gate: Promise.resolve() };
  const injected = (file, text) => path.basename(file) === 'ledger.json' && typeof text === 'string'
    && text.includes('"state":"drained"');
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (injected(file, text)) {
      if (state.armed > 0) {
        state.armed -= 1;
        state.injected += 1;
        throw Error('injected pre-publication drain failure');
      }
      if (state.gated) {
        state.gated = false;
        state.entered();
        await state.gate;
      }
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  t.after(() => { storage.atomicWrite = realAtomicWrite; });
  return state;
}

test('the owner publishes its retained drain and resamples the exact store, so a queued waiter of another governor is admitted with no other operation', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor } = await storageFixture(t, 'queued-drain');
  const faults = drainFaults(t);
  // The waiter runs on ANOTHER governor over the same OS-user ledger: its own poll
  // can observe a published fence and a healthy sample, but it must never publish
  // (or sample on behalf of) the other host's finished effect.
  const waiter = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => waiter.close().catch(() => undefined));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const runs = { 1: 0, 2: 0 };
  const request = (key, bytes) => ({ key, kind: 'storage', root, bytes, lane: 'work', store: storeDir });
  await governor.account(storeDir, () => storageUsage(storeDir));
  const owner = await governor.acquire(request('storage:owner', 32 * MIB), undefined, undefined, false);
  let effects = 0;
  // The effect of the first request really finishes while its permit is held.
  effects += 1;
  await fs.writeFile(path.join(root, 'owner-effect.txt'), 'one disposable effect');
  const queue = label => waiter.acquire(request(label, 32 * MIB), controller.signal, undefined, true)
    .then(permit => { runs[Number(label.slice(-1))] += 1; return { permit }; }, error => ({ error }));
  const pending = [];
  try {
    // Queue the tickets in order, so their sequence is deterministic.
    pending.push(queue('storage:waiter-1'));
    await until(async () => (await governor.status()).claims.filter(claim => claim.state === 'waiting').length === 1, 5000);
    pending.push(queue('storage:waiter-2'));
    await until(async () => (await governor.status()).claims.filter(claim => claim.state === 'waiting').length === 2, 5000);
    const ordered = (await governor.status()).claims.filter(claim => claim.state === 'waiting')
      .sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(ordered.map(claim => claim.key), ['storage:waiter-1', 'storage:waiter-2'],
      'both 32 MiB tickets are queued behind the finished effect, in sequence');
    assert.deepEqual([runs[1], runs[2]], [0, 0], 'neither queued effect may run yet');

    // The ONLY failure: the ledger write immediately before the known drain commits.
    faults.armed = 1;
    await assert.rejects(owner.drain({ retain: true }), /injected pre-publication drain failure/);
    assert.equal(faults.injected, 1, 'exactly one pre-commit publication really failed');
    const unpublished = await readLedger(base);
    assert.equal(unpublished.claims.filter(claim => claim.state === 'active').length, 1,
      'the finished effect is still charged by its own claim, fail-closed');
    assert.equal(unpublished.claims.some(claim => claim.state === 'drained'), false, 'no drain was published');
    assert.deepEqual(unpublished.claims.filter(claim => claim.state === 'waiting').map(claim => claim.sequence),
      ordered.map(claim => claim.sequence), 'the queued tickets keep their exact positions');

    // From here NOTHING is called on either governor: the waiters only poll their own
    // eligibility, and the owner alone must publish its drain and sample its store.
    const first = await bounded(pending[0], 10000);
    assert.ok(first.lease?.permit, JSON.stringify(first.lease ?? first));
    assert.deepEqual([runs[1], runs[2]], [1, 0], 'the oldest queued ticket progressed, the younger one did not');
    assert.equal(effects, 1, 'the finished effect is never run again');
    const admitted = await readLedger(base);
    const active = admitted.claims.filter(claim => claim.state === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].key, 'storage:waiter-1', 'the oldest queued ticket won, exactly as FIFO requires');
    assert.equal(active[0].sequence, ordered[0].sequence, 'the admitted ticket kept its own queue position');
    assert.deepEqual(admitted.claims.filter(claim => claim.state === 'waiting').map(claim => claim.key),
      ['storage:waiter-2'], 'the younger ticket is still queued');
    assert.equal(admitted.claims.some(claim => claim.key === 'storage:owner'), false,
      'the published drain was reclaimed by a healthy sample of its exact store');
    assert.equal(admitted.claims.some(claim => claim.state === 'drained'), false);
    assert.equal(Object.values(admitted.stores)[0].uncertain ?? false, false, 'the exact store is healthy again');

    // The younger ticket follows in order once the older one releases.
    await first.lease.permit.release();
    const second = await bounded(pending[1], 10000);
    assert.ok(second.lease?.permit, JSON.stringify(second.lease ?? second));
    assert.deepEqual([runs[1], runs[2]], [1, 1]);
    await second.lease.permit.release();
    assert.deepEqual((await governor.status()).claims, []);
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
    await owner.release().catch(() => undefined);
  }
});

test('a post-drain sample failure keeps the published fence and is recovered by the same owner retry, so the waiter still progresses', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor } = await storageFixture(t, 'queued-drain-sample');
  const faults = drainFaults(t);
  const waiter = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => waiter.close().catch(() => undefined));
  const controller = new AbortController();
  t.after(() => controller.abort());
  // The owner's OWN resample fails once - after its drain publication landed.
  const realAccount = governor.account.bind(governor);
  let failed = false;
  let failedLedger;
  governor.account = async (directory, measure) => {
    const published = await readLedger(base).then(ledger => ledger.claims.some(claim => claim.state === 'drained'), () => false);
    if (!failed && published) {
      let failure;
      try {
        await realAccount(directory, async () => { throw Error('injected post-drain sample failure'); });
      } catch (error) {
        failure = error;
      } finally {
        // Capture the state the failed sample left behind, and only then let the
        // test observe the failure.
        failedLedger = await readLedger(base);
        failed = true;
      }
      throw failure;
    }
    return realAccount(directory, measure);
  };
  t.after(() => { governor.account = realAccount; });
  const request = (key, bytes) => ({ key, kind: 'storage', root, bytes, lane: 'work', store: storeDir });
  await governor.account(storeDir, () => storageUsage(storeDir));
  const owner = await governor.acquire(request('storage:owner', 32 * MIB), undefined, undefined, false);
  let runs = 0;
  const pending = waiter.acquire(request('storage:waiter', 32 * MIB), controller.signal, undefined, true)
    .then(permit => { runs += 1; return { permit }; }, error => ({ error }));
  try {
    await until(async () => (await governor.status()).claims.some(claim => claim.state === 'waiting'), 5000);
    faults.armed = 1;
    await assert.rejects(owner.drain({ retain: true }), /injected pre-publication drain failure/);

    // The owner's retry published the drain, and its resample failed: the fence and
    // the drained row stay durable, so no waiter may be admitted from that store.
    await until(() => failed, 10000);
    const [drained] = failedLedger.claims.filter(claim => claim.state === 'drained');
    assert.ok(drained, 'the drain publication landed before the sample failed');
    assert.equal(drained.bytes, 32 * MIB);
    assert.equal(failedLedger.stores[drained.store].uncertain, true, 'the published fence is kept');
    assert.equal(failedLedger.stores[drained.store].accounting, 'quarantine');
    assert.equal(failedLedger.claims.filter(claim => claim.state === 'waiting').length, 1, 'the waiter is still queued');

    // The same owner retry samples again, and that ONE healthy sample reclaims it.
    const granted = await bounded(pending, 10000);
    assert.ok(granted.lease?.permit, JSON.stringify(granted.lease ?? granted));
    assert.equal(runs, 1, 'the queued effect runs exactly once');
    const recovered = await readLedger(base);
    assert.equal(recovered.claims.some(claim => claim.state === 'drained'), false, 'the healthy sample reclaimed it');
    assert.equal(recovered.stores[drained.store].uncertain ?? false, false, 'the fence is cleared');
    assert.equal(recovered.stores[drained.store].bytes, await storageUsage(storeDir), 'the charge is a fresh sample');
    await granted.lease.permit.release();
    assert.deepEqual((await governor.status()).claims, []);
  } finally {
    controller.abort();
    await Promise.allSettled([pending]);
    await owner.release().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Regression (12): the INITIAL drain publication of a real lifecycle action can
// SUCCEED while the sample that immediately follows it fails. Nothing was retained
// (the publication never failed) and no timer was armed, so the durable global
// fence of that exact store had NO driver at all: the effect was finished, no new
// operation came, and a live queued ticket of ANOTHER host stayed quarantined even
// after the one-shot fault cleared (`.test-build/r11-post-drain-no-driver-probe.cjs`).
// The drain and the foreground sample are now ONE obligation, registered BEFORE
// that sample, and only its committing exact-store/claim reconciliation
// acknowledges it.
// ---------------------------------------------------------------------------

test('a lifecycle drain whose only post-publication sample fails is still owned and recovered by the owner retry, so the queued ticket progresses', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor, lifecycle } = await storageFixture(t, 'post-drain-no-driver');
  const storage = require(path.join(buildDir, 'storage'));
  // Every ledger publication that carries a KNOWN DRAIN is counted, and a refused
  // one fails this test: the ONLY fault here is the sample after a SUCCESSFUL
  // publication.
  const realAtomicWrite = storage.atomicWrite;
  const publications = { drained: 0, failed: 0 };
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (path.basename(file) === 'ledger.json' && typeof text === 'string' && text.includes('"state":"drained"')) {
      publications.drained += 1;
      try {
        return await realAtomicWrite(file, text, mode, beforeRename);
      } catch (error) {
        publications.failed += 1;
        throw error;
      }
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  t.after(() => { storage.atomicWrite = realAtomicWrite; });
  // The governor's ONE coalesced retry, captured instead of waited for: no
  // background round runs on its own until this test drives it.
  const retries = captureRetryTimers(t, governor);
  // The waiter is a DIFFERENT host over the same OS-user ledger: it polls its own
  // eligibility and may never publish, drain or sample on behalf of this claim.
  const waiter = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => waiter.close().catch(() => undefined));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const request = key => ({ key, kind: 'storage', root, bytes: 32 * MIB, lane: 'work', store: storeDir });
  const effects = { owner: 0, waiter: 0 };
  const realDrain = governor.drain.bind(governor);
  const drains = [];
  governor.drain = async (key, store) => {
    // What this drain transition saw and published. A retry of an already KNOWN
    // drain must republish THAT row, never re-drain (replay) the claim.
    const before = (await readLedger(base)).claims.find(claim => claim.state === 'drained');
    const result = await realDrain(key, store);
    const after = (await readLedger(base)).claims.find(claim => claim.state === 'drained');
    drains.push({ key, before: before && { sequence: before.sequence, drainedAt: before.drainedAt, bytes: before.bytes },
      after: after && { sequence: after.sequence, drainedAt: after.drainedAt, bytes: after.bytes } });
    return result;
  };
  t.after(() => { governor.drain = realDrain; });
  await governor.account(storeDir, () => storageUsage(storeDir));
  // The ONLY injected fault: the exact-store sample of a SUCCESSFULLY published
  // drain. One-shot, so a healthy retry of that same obligation then succeeds.
  const realAccount = governor.account.bind(governor);
  let injected = 0;
  governor.account = async (directory, measure) => {
    const published = await readLedger(base).then(ledger => ledger.claims.some(claim => claim.state === 'drained'), () => false);
    if (!injected && published) {
      injected += 1;
      return realAccount(directory, async () => { throw Error('injected post-drain measurement failure'); });
    }
    return realAccount(directory, measure);
  };
  t.after(() => { governor.account = realAccount; });

  // The real lifecycle action holds its 32 MiB permit until the other host's
  // 32 MiB ticket is queued behind it.
  let entered, open;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { open = resolve; });
  const owner = lifecycle.withStorage(32 * MIB, async () => {
    effects.owner += 1;
    await fs.writeFile(path.join(root, 'owner-effect.txt'), 'one disposable effect');
    entered();
    await gate;
    return 'first-completed';
  }, undefined, 'work', false);
  let pending;
  try {
    await started;
    // The other host's ticket is queued only once the owner really holds its
    // 32 MiB permit, so the owner's own admission is never behind a younger ticket.
    pending = waiter.acquire(request('storage:waiter'), controller.signal, undefined, true)
      .then(permit => { effects.waiter += 1; return { permit }; }, error => ({ error }));
    await until(async () => (await governor.status()).claims.some(claim => claim.state === 'waiting'), 5000);
    const queued = (await governor.status()).claims.find(claim => claim.key === 'storage:waiter');
    assert.equal(queued.state, 'waiting');
    assert.equal(queued.waitingReason, 'storage', 'it waits for storage capacity behind the held 32 MiB permit');

    // finishStorage: the drain PUBLICATION SUCCEEDS, and only the sample after it fails.
    open();
    await assert.rejects(owner, /injected post-drain measurement failure/);
    assert.equal(injected, 1, 'the only injected fault was ONE post-drain sample');
    assert.equal(publications.failed, 0, 'NO drain publication was ever refused');

    const fenced = await readLedger(base);
    const [drained] = fenced.claims.filter(claim => claim.state === 'drained');
    assert.ok(drained, 'the KNOWN drain was published before the sample failed');
    assert.equal(drained.bytes, 32 * MIB);
    assert.equal(fenced.stores[drained.store].uncertain, true, 'the published fence survives the failed sample');
    assert.equal(fenced.stores[drained.store].accounting, 'quarantine');
    // THE REGRESSION: the published drain is still an owned obligation and the
    // bounded owner retry is armed, although nothing failed to publish. Before,
    // both were absent, so no owner-driven round could ever sample this fence again.
    assert.equal(governor.retainedDrains.size, 1, 'the published drain keeps its exact recovery obligation');
    assert.ok(governor.drainRetry, 'the bounded owner retry is armed');

    // The queued ticket of the other host keeps its own row and position while the
    // fence is unknown: it is polled, refused with the fence reason, never renumbered.
    const before = (await governor.status()).claims.find(claim => claim.key === 'storage:waiter');
    await until(async () => (await governor.status()).claims.find(claim => claim.key === 'storage:waiter')?.heartbeat > before.heartbeat, 5000);
    const live = (await governor.status()).claims.find(claim => claim.key === 'storage:waiter');
    assert.equal(live.state, 'waiting');
    assert.equal(live.waitingReason, 'quarantine', 'the published fence is reported as a quarantine');
    assert.equal(live.sequence, queued.sequence, 'the SAME queue ticket waits');
    assert.equal(effects.waiter, 0, 'nothing is admitted from a fenced store');

    // The owner's own bounded retry - no new operation and no help from the other
    // host - republishes nothing new and samples that exact store. Its committing
    // transaction settles the obligation and admits the queued ticket.
    const timer = await retries.next();
    timer.callback();
    const granted = await bounded(pending, 15000);
    assert.ok(granted.lease?.permit, JSON.stringify(granted.lease ?? granted.error ?? granted));
    assert.equal(effects.waiter, 1, 'the queued effect ran exactly once');
    assert.equal(effects.owner, 1, 'the finished owner effect is never replayed');
    assert.equal(governor.retainedDrains.size, 0, 'the committing exact-store sample settled the obligation');
    const recovered = await readLedger(base);
    assert.equal(recovered.stores[drained.store].uncertain ?? false, false, 'that sample cleared the fence');
    assert.equal(recovered.stores[drained.store].bytes, await storageUsage(storeDir), 'the charge is a fresh sample');
    const admitted = recovered.claims.find(claim => claim.key === 'storage:waiter');
    assert.equal(admitted.state, 'active', 'the queued ticket was admitted, not replaced');
    assert.equal(admitted.sequence, live.sequence, 'the SAME queue ticket progressed');
    assert.equal(recovered.claims.some(claim => claim.state === 'drained'), false, 'the drained row was reclaimed');
    assert.equal(publications.failed, 0, 'no retry refused a drain publication either');
    // Two drain transitions, both accepted: the initial one and the idempotent
    // republication of the retry - which never re-drained the same claim.
    assert.equal(drains.length, 2);
    assert.equal(drains[1].key, drains[0].key, 'the retry owned the same exact claim');
    assert.deepEqual(drains[1].before, drains[1].after, 'the retry republished the SAME known drain, never a replay');
    await granted.lease.permit.release();
    assert.deepEqual((await governor.status()).claims, []);
  } finally {
    open();
    controller.abort();
    await Promise.allSettled([pending]);
    await owner.catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Regression (12b): registering the foreground obligation is not enough on its
// own. When a coalesced timer was ALREADY armed for another retained claim - here
// an older sibling of the SAME store - its round snapshots every entry, so an
// unmarked foreground entry would be measured by a background scan that supersedes
// the caller's in-progress sample. The entry is therefore marked while its own
// callback runs, and a background round neither takes it as due nor measures its
// exact store; the callback's committing sample still acknowledges it.
// ---------------------------------------------------------------------------

test('an armed background round never samples a store whose owner is already measuring it, and the foreground commit settles both obligations', { timeout: 30000 }, async t => {
  const { base, root, storeDir, governor } = await storageFixture(t, 'foreground-marker');
  const faults = drainFaults(t);
  const retries = captureRetryTimers(t, governor);
  // Every real measurement of that exact store is recorded, so a background scan
  // started while the foreground callback is in flight is visible as a second one.
  const samples = [];
  const realAccount = governor.account.bind(governor);
  governor.account = async (directory, measure) => {
    if (path.resolve(directory) === path.resolve(storeDir)) {
      samples.push(measure);
    }
    return realAccount(directory, measure);
  };
  t.after(() => { governor.account = realAccount; });
  await realAccount(storeDir, () => storageUsage(storeDir));
  samples.length = 0;
  const request = (key, bytes) => ({ key, kind: 'storage', root, bytes, lane: 'work', store: storeDir });
  const older = await governor.acquire(request('storage:older', 16 * MIB), undefined, undefined, false);
  const measuring = await governor.acquire(request('storage:measuring', 16 * MIB), undefined, undefined, false);
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let foreground;
  try {
    // The older sibling's publication fails once: its obligation is retained and
    // the ONE coalesced timer is armed for it - BEFORE the foreground sample starts.
    faults.armed = 1;
    await assert.rejects(older.drain({ retain: true }), /injected pre-publication drain failure/);
    assert.equal(faults.injected, 1);
    assert.equal(governor.retainedDrains.size, 1);
    const timer = await retries.next();

    // The second claim publishes its own drain and hands its foreground sample to
    // the governor, exactly as `finishStorage` does. That sample is held in flight.
    foreground = measuring.drain({ retain: true, resample: async () => {
      entered();
      await gate;
      return governor.account(storeDir, () => storageUsage(storeDir));
    } });
    await started;
    assert.equal(governor.retainedDrains.size, 2, 'both obligations are owned at once');
    assert.equal(governor.retainedDrains.get('storage:measuring').foreground, true,
      'the entry whose own sample is running is marked as such');
    assert.equal(samples.length, 0, 'the foreground sample has not measured yet');

    // The already-armed round runs NOW, while that sample is in progress: it must
    // not measure this store, so it can neither supersede the sample nor settle an
    // entry on a measurement that is not the caller's.
    timer.callback();
    await governor.drainRound;
    assert.equal(samples.length, 0, 'no background scan raced the in-progress foreground sample');
    assert.equal(governor.retainedDrains.size, 2, 'both obligations survive the round');
    assert.equal(governor.retainedDrains.get('storage:measuring').foreground, true,
      'the marker is kept while its sample is still owed');
    const during = await readLedger(base);
    assert.equal(during.claims.filter(claim => claim.state === 'drained').length, 2,
      'both known drains are published and still unreclaimed');

    // Its own sample then succeeds: ONE commit reclaims both drained rows of this
    // exact store and acknowledges both obligations - the marker never hides an entry
    // from the acknowledgement itself.
    resume();
    await foreground;
    assert.equal(samples.length, 1, 'exactly one measurement settled both obligations');
    assert.equal(governor.retainedDrains.size, 0, 'the committing exact-store sample acknowledged both');
    const settled = await readLedger(base);
    assert.deepEqual(settled.claims, [], 'both drained rows were reclaimed by that one sample');
    assert.equal(Object.values(settled.stores)[0].uncertain ?? false, false);
    assert.deepEqual((await governor.status()).claims, []);
  } finally {
    resume();
    await foreground?.catch(() => undefined);
    await older.release().catch(() => undefined);
    await measuring.release().catch(() => undefined);
  }
});

test('a persistent drain publication failure is retried at the capped background rate and shutdown settles it as a quarantine', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor } = await storageFixture(t, 'queued-drain-persistent');
  const storage = require(path.join(buildDir, 'storage'));
  const realAtomicWrite = storage.atomicWrite;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (path.basename(file) === 'ledger.json' && typeof text === 'string' && text.includes('"state":"drained"')) {
      throw Error('injected persistent drain publication failure');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  t.after(() => { storage.atomicWrite = realAtomicWrite; });
  const waiter = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => waiter.close().catch(() => undefined));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const realDrain = governor.drain.bind(governor);
  let attempts = 0;
  governor.drain = async (key, store) => { attempts += 1; return realDrain(key, store); };
  t.after(() => { governor.drain = realDrain; });
  await governor.account(storeDir, () => storageUsage(storeDir));
  const owner = await governor.acquire({ key: 'storage:owner', kind: 'storage', root, bytes: 32 * MIB,
    lane: 'work', store: storeDir }, undefined, undefined, false);
  let runs = 0;
  const pending = waiter.acquire({ key: 'storage:waiter', kind: 'storage', root, bytes: 32 * MIB,
    lane: 'work', store: storeDir }, controller.signal, undefined, true)
    .then(permit => { runs += 1; return { permit }; }, error => ({ error }));
  await until(async () => (await governor.status()).claims.some(claim => claim.state === 'waiting'), 5000);
  await assert.rejects(owner.drain({ retain: true }), /injected persistent drain publication failure/);
  // The owner keeps retrying on its own, and a persistent failure never admits.
  await until(() => attempts >= 2, 10000);
  // What is bounded is the RATE, not a number of attempts: a persistent failure
  // keeps exactly ONE coalesced retry scheduled instead of exhausting a fixed
  // attempt budget and abandoning a store that still has live waiters.
  await until(() => governor.drainRetry !== undefined, 5000);
  const retained = await readLedger(base);
  assert.equal(retained.claims.filter(claim => claim.state === 'active').length, 1, 'the charge stays fail-closed');
  assert.equal(runs, 0, 'nothing is admitted from an unpublished drain');

  // Stop the FOREIGN waiter first, so only this governor's own activity can still
  // write, then shut it down.
  controller.abort();
  await Promise.allSettled([pending]);
  await governor.close();
  const closed = await readLedger(base);
  assert.equal(closed.claims.length, 1, 'the exact retained claim is the durable ownership');
  assert.equal(closed.claims[0].state, 'quarantine', 'a persistent failure is quarantined, never dropped');
  const settled = attempts;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(attempts, settled, 'no background publication runs after close');
  assert.deepEqual(await readLedger(base), closed, 'shutdown left the aggregate ledger settled');
  assert.deepEqual(await governor.retryRetainedDrains(), [], 'the closed governor owns no retry any more');
  assert.equal(runs, 0);

  // And the quarantine is durable: a healthy sample never reclaims an uncertain effect.
  const reloaded = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => reloaded.close().catch(() => undefined));
  await reloaded.account(storeDir, () => storageUsage(storeDir));
  const durable = await readLedger(base);
  assert.equal(durable.claims.length, 1);
  assert.equal(durable.claims[0].state, 'quarantine');
});

test('close settles a background publication that is already running before its final retry and quarantine', { timeout: 30000 }, async t => {
  const { base, root, storeDir, governor } = await storageFixture(t, 'queued-drain-close');
  const faults = drainFaults(t);
  let published;
  const publication = new Promise(resolve => { published = resolve; });
  let resume;
  faults.gate = new Promise(resolve => { resume = resolve; });
  // Only the SECOND drained publication (the owner's own background retry) is held,
  // and only once it is already inside its atomic write.
  faults.entered = () => { published(); setTimeout(resume, 100); };
  faults.gated = true;
  await governor.account(storeDir, () => storageUsage(storeDir));
  const owner = await governor.acquire({ key: 'storage:owner', kind: 'storage', root, bytes: 32 * MIB,
    lane: 'work', store: storeDir }, undefined, undefined, false);
  // The FIRST publication fails, the next one is held inside its atomic write.
  faults.armed = 1;
  await assert.rejects(owner.drain({ retain: true }), /injected pre-publication drain failure/);
  assert.equal(faults.injected, 1);
  await publication;

  // Shutdown starts while that publication is in flight. It must SETTLE it before its
  // own final retry/quarantine, so the drained claim is reclaimed by its sample and
  // no fence or row survives the close - and no write can land after it.
  await governor.close();
  const settled = await readLedger(base);
  assert.deepEqual(settled.claims, [], 'the running publication was settled, not left behind a quarantine');
  assert.equal(Object.values(settled.stores)[0].uncertain ?? false, false, 'no fence outlives the close');
  assert.equal(Object.values(settled.stores)[0].write, undefined);
});

test('two retained drains of ONE store are published first and sampled once, not once per claim', { timeout: 30000 }, async t => {
  const { base, root, storeDir, governor } = await storageFixture(t, 'queued-drain-coalesced');
  const faults = drainFaults(t);
  // Every sample of this exact store is recorded with the claim states the ledger
  // held when it STARTED, so a second concurrent sample of the same store is
  // visible as a second entry instead of hiding behind a superseded identity.
  const samples = [];
  const realAccount = governor.account.bind(governor);
  governor.account = async (directory, measure) => {
    if (path.resolve(directory) !== path.resolve(storeDir)) {
      return realAccount(directory, measure);
    }
    samples.push((await readLedger(base)).claims.map(claim => `${claim.key}:${claim.state}`).sort());
    return realAccount(directory, measure);
  };
  t.after(() => { governor.account = realAccount; });
  await realAccount(storeDir, () => storageUsage(storeDir));
  const request = key => ({ key, kind: 'storage', root, bytes: 16 * MIB, lane: 'work', store: storeDir });
  const first = await governor.acquire(request('storage:a'), undefined, undefined, false);
  const second = await governor.acquire(request('storage:b'), undefined, undefined, false);
  // Both effects finished; the ONLY failures are the ledger writes before the two
  // known-drain publications commit.
  faults.armed = 2;
  await assert.rejects(first.drain({ retain: true }), /injected pre-publication drain failure/);
  await assert.rejects(second.drain({ retain: true }), /injected pre-publication drain failure/);
  assert.equal(faults.injected, 2, 'both publications really failed before committing');
  const retained = await readLedger(base);
  assert.deepEqual(retained.claims.map(claim => claim.state), ['active', 'active'],
    'both finished effects keep their conservative charge, fail-closed');

  // Nothing is called from here: the owner's own round must publish BOTH drains and
  // then measure that store exactly ONCE - a sample per claim would supersede its
  // own sibling and walk the same tree twice.
  await until(() => samples.length >= 1, 10000);
  await until(async () => (await readLedger(base)).claims.length === 0, 10000);
  assert.equal(samples.length, 1, `exactly one measurement for the shared store: ${JSON.stringify(samples)}`);
  assert.deepEqual(samples[0], ['storage:a:drained', 'storage:b:drained'],
    'both drains were already published when the single sample started');
  const settled = await readLedger(base);
  assert.deepEqual(settled.claims, [], 'that one healthy sample reclaimed both drained rows');
  assert.equal(Object.values(settled.stores)[0].uncertain ?? false, false, 'and cleared the single fence');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(samples.length, 1, 'no further measurement was needed once both rows were settled');
  assert.deepEqual(await governor.retryRetainedDrains(), []);
});

test('a settled retained drain is never resurrected by a failing sample of its own round', { timeout: 30000 }, async t => {
  const { base, root, storeDir, governor } = await storageFixture(t, 'queued-drain-resurrect');
  const faults = drainFaults(t);
  let started; const sampling = new Promise(resolve => { started = resolve; });
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  const realAccount = governor.account.bind(governor);
  let gated = false;
  governor.account = async (directory, measure) => {
    if (gated || path.resolve(directory) !== path.resolve(storeDir)) {
      return realAccount(directory, measure);
    }
    gated = true;
    started();
    await gate;
    // The ONE sample of that round fails, after the exact quarantine below.
    return realAccount(directory, async () => { throw Error('injected post-drain sample failure'); });
  };
  t.after(() => { governor.account = realAccount; });
  await realAccount(storeDir, () => storageUsage(storeDir));
  const request = key => ({ key, kind: 'storage', root, bytes: 16 * MIB, lane: 'work', store: storeDir });
  const first = await governor.acquire(request('storage:a'), undefined, undefined, false);
  const second = await governor.acquire(request('storage:b'), undefined, undefined, false);
  try {
    faults.armed = 2;
    await assert.rejects(first.drain({ retain: true }), /injected pre-publication drain failure/);
    await assert.rejects(second.drain({ retain: true }), /injected pre-publication drain failure/);
    assert.equal(faults.injected, 2);
    // Both drains are published, and the round's single sample is in flight.
    await sampling;
    assert.deepEqual((await readLedger(base)).claims.map(claim => claim.state), ['drained', 'drained']);

    // An EXACT quarantine of one of them settles that obligation for good, and the
    // failing sample of the round that still holds the stale entry must not re-add it.
    await second.quarantine();
    resume();
    // The other claim is reclaimed by the next healthy sample of the same store.
    await until(async () => !(await readLedger(base)).claims.some(claim => claim.key === 'storage:a'), 10000);
    await new Promise(resolve => setTimeout(resolve, 400));
    const durable = await readLedger(base);
    assert.equal(durable.claims.length, 1);
    assert.equal(durable.claims[0].key, 'storage:b');
    assert.equal(durable.claims[0].state, 'quarantine',
      'an exactly quarantined claim is never re-published as a known drain');
    assert.deepEqual(await governor.retryRetainedDrains(), [],
      'the settled obligation is not retained again by the round that captured it');
  } finally {
    resume();
  }
});

// ---------------------------------------------------------------------------
// Regression (1): liveness is per ticket. A sibling's poll, or a reconcile
// report, must never refresh another ticket's window.
// ---------------------------------------------------------------------------

test('a known drain survives a failing sample, and reload resamples it without a write fence', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-reload-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  await fs.mkdir(root);
  await fs.mkdir(storeDir);
  await fs.writeFile(path.join(storeDir, 'state.bin'), Buffer.alloc(4096, 7));
  const config = () => ({ enabled: true, modelCapacity: 8, runnableCapacity: 16, runnerCapacity: 4, storageBytes: 64 * MIB, serviceReserve: 1 });
  const governor = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => governor.close().catch(() => undefined));
  const key = 'storage:drained';
  const request = { key, kind: 'storage', root, bytes: 32 * MIB, lane: 'work', store: storeDir };
  await governor.account(storeDir, () => storageUsage(storeDir));
  const permit = await governor.acquire(request, undefined, undefined, false);

  // The known drain lands, and the caller's post-drain sample then fails.
  await permit.drain();
  await assert.rejects(governor.account(storeDir, async () => { throw Error('measurement unavailable'); }), /measurement unavailable/);
  const fenced = await readLedger(base);
  const storeKey = fenced.claims.find(claim => claim.key === key)?.store;
  assert.equal(fenced.claims.find(claim => claim.key === key)?.state, 'drained');
  assert.equal(fenced.stores[storeKey].uncertain, true, 'the drain fence outlives a failed sample');
  assert.equal(fenced.stores[storeKey].write, undefined, 'a known drain leaves no checkpoint write marker');
  await assert.rejects(governor.acquire({ ...request, key: 'other' }, undefined, undefined, false), error => error.code === 'resource_busy');

  // Reload: opening the exact registered store resamples an uncertain sample even
  // though there is no write marker to recover, so the fence and row are cleared.
  await governor.close();
  const reloaded = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => reloaded.close().catch(() => undefined));
  assert.equal(await reloaded.recoverStoreWrite(storeDir, () => storageUsage(storeDir)), true,
    'a fenced store with no write marker is still reconciled on open');
  const recovered = await readLedger(base);
  assert.equal(recovered.stores[storeKey].uncertain ?? false, false);
  assert.equal(recovered.stores[storeKey].write, undefined);
  assert.equal(recovered.claims.some(claim => claim.key === key), false, 'the reload resample reclaimed the drained row');
  const grant = await reloaded.acquire(request, undefined, undefined, false);
  await grant.release();
  // A store that is neither written nor uncertain needs no reconciliation.
  assert.equal(await reloaded.recoverStoreWrite(storeDir, () => storageUsage(storeDir)), false);
});

test("a drain never discards another owner's live checkpoint sample", { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-overlap-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  await fs.mkdir(root);
  await fs.mkdir(storeDir);
  await fs.writeFile(path.join(storeDir, 'state.bin'), Buffer.alloc(4096, 7));
  const governor = new ResourceGovernor(() => ({ enabled: true, modelCapacity: 8, runnableCapacity: 16, runnerCapacity: 4, storageBytes: 64 * MIB, serviceReserve: 1 }),
    path.join(base, 'resources'));
  t.after(() => governor.close().catch(() => undefined));
  const key = 'storage:overlap';
  const request = { key, kind: 'storage', root, bytes: 32 * MIB, lane: 'work', store: storeDir };
  await governor.account(storeDir, () => storageUsage(storeDir));
  const permit = await governor.acquire(request, undefined, undefined, false);

  // One checkpoint writer owns this store and is INSIDE its post-action sample
  // when the permit is drained.
  let resume, measuring;
  const reached = new Promise(resolve => { measuring = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const checkpoint = governor.withStoreWrite(storeDir, async () => 'checkpoint-committed', async () => {
    measuring();
    await gate;
    return storageUsage(storeDir);
  });
  await reached;
  const inFlight = await readLedger(base);
  const store = inFlight.stores[Object.keys(inFlight.stores)[0]];
  assert.equal(store.write?.state, 'active', 'the writer holds an active sample');
  const sampledBefore = store.sampleId;

  const draining = permit.drain();
  // The drain waits outside the aggregate lock instead of rotating the sample the
  // writer is using, so that healthy checkpoint is never quarantined.
  const early = await bounded(draining, 400);
  assert.equal(early.timeout, true, 'the drain waits for the foreign live sample');
  assert.equal((await readLedger(base)).stores[Object.keys(inFlight.stores)[0]].sampleId, sampledBefore);

  resume();
  assert.equal(await checkpoint, 'checkpoint-committed', 'the checkpoint committed instead of quarantining');
  await draining;
  const after = await readLedger(base);
  const settled = after.stores[Object.keys(after.stores)[0]];
  assert.equal(settled.write, undefined, 'no checkpoint fence was left behind');
  assert.equal(after.claims.find(claim => claim.key === key)?.state, 'drained');
  assert.equal(settled.uncertain, true, 'the drain fence applies once the foreign sample is done');
});

test('a sibling poll never refreshes another ticket, so a cancelled runner cannot lead forever', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-sibling-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const clock = { now: 1_000 };
  const resources = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true, runnerCapacity: 2 }),
    path.join(base, 'resources'), () => clock.now);
  t.after(() => resources.close().catch(() => undefined));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  const scope = path.join(base, 'store', 'pool');
  const admission = resources.runnerAdmission(scope, root, () => 'work');
  // This request's withdrawal always fails, so its durable ticket stays behind.
  const failing = { ...admission, cancel: async () => { throw Error('aggregate ledger unavailable'); } };
  const claims = async () => (await resources.status()).claims.filter(claim => claim.kind === 'runner');
  const ticket = async label => (await claims()).find(claim => claim.key.endsWith(id(label)));

  // The single work slot is taken, so both tickets are created and stay waiting.
  assert.equal(await admission.tryAcquire(id('f'), owner('f'), 2), true);
  assert.equal(await admission.tryAcquire(id('a'), owner('a'), 2), false);
  assert.equal(await admission.tryAcquire(id('b'), owner('b'), 2), false);
  const created = (await ticket('a')).heartbeat;
  assert.equal(typeof created, 'number', 'a waiting ticket records its own liveness');
  await admission.cancel(id('f'));

  // A is the cancelled request; its ledger withdrawal fails.
  await assert.rejects(failing.cancel(id('a')), /aggregate ledger unavailable/);
  assert.equal((await ticket('a')).state, 'waiting', 'the failed withdrawal left a durable ticket');

  // B keeps polling its OWN ticket in the same pool, inside the window: A is
  // still live and eligible, so it keeps the handoff and its window stays put.
  for (let step = 0; step < 3; step += 1) {
    clock.now += 3000;
    assert.equal(await admission.tryAcquire(id('b'), owner('b'), 2), false, 'a live older ticket keeps the handoff');
    assert.equal((await ticket('a')).heartbeat, created, "a sibling's poll never refreshes this ticket's liveness");
  }
  // Past its own window the abandoned ticket is withdrawn, so B is admitted.
  clock.now += 3000;
  assert.equal(await admission.tryAcquire(id('b'), owner('b'), 2), true);
  assert.equal(await ticket('a'), undefined);
  assert.equal((await ticket('b')).state, 'active');
  await admission.cancel(id('b'));
  assert.deepEqual(await claims(), []);
});

// ---------------------------------------------------------------------------
// Regression (2): drain() is one atomic, fencing transition, and only a sample
// that STARTED after it can clear the fence and the known-drained row.
// ---------------------------------------------------------------------------

test('a known drain fences its exact store before accounting and only a post-drain sample clears it', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-fence-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  await fs.mkdir(root);
  await fs.mkdir(storeDir);
  await fs.writeFile(path.join(storeDir, 'state.bin'), Buffer.alloc(4096, 7));
  const governor = new ResourceGovernor(() => ({ enabled: true, modelCapacity: 8, runnableCapacity: 16, runnerCapacity: 4, storageBytes: 64 * MIB, serviceReserve: 1 }),
    path.join(base, 'resources'));
  t.after(() => governor.close().catch(() => undefined));
  const key = 'storage:probe';
  const request = { key, kind: 'storage', root, bytes: 32 * MIB, lane: 'work', store: storeDir };
  await governor.account(storeDir, () => storageUsage(storeDir));
  const permit = await governor.acquire(request, undefined, undefined, false);

  // An unavailable ledger keeps durable ownership: the drain itself did not happen.
  const realTransaction = governor.transaction.bind(governor);
  governor.transaction = async () => { throw Error('aggregate ledger unavailable'); };
  await assert.rejects(permit.drain(), /aggregate ledger unavailable/);
  governor.transaction = realTransaction;
  assert.equal((await readLedger(base)).claims.find(claim => claim.key === key)?.state, 'active',
    'the owner keeps its durable claim when the ledger is unavailable');

  // A sample STARTS before the drain and is delayed across it.
  let finish;
  const delayed = governor.account(storeDir, () => new Promise(resolve => { finish = resolve; }));
  await until(() => finish !== undefined);

  await permit.drain();
  const drained = await readLedger(base);
  const [row] = drained.claims;
  const storeKey = row.store;
  assert.equal(row.state, 'drained');
  assert.equal(drained.stores[storeKey].uncertain, true,
    'the exact store is fenced regardless of its previous healthy sample');
  assert.equal(drained.stores[storeKey].accounting, 'quarantine');

  // The pre-drain sample completes SUCCESSFULLY: it must change nothing.
  finish(4096);
  await delayed;
  const late = await readLedger(base);
  assert.equal(late.stores[storeKey].uncertain, true, 'a pre-drain sample can never clear the drain fence');
  assert.equal(late.stores[storeKey].accounting, 'quarantine');
  assert.equal(late.claims.find(claim => claim.key === key)?.state, 'drained');

  // A same-key request is never granted on a stale measurement, and neither is
  // another request that would spend this store's bytes.
  assert.deepEqual(await governor.tryAcquire(request), { granted: false, reason: 'quarantine' });
  await assert.rejects(governor.acquire({ ...request, key: 'other' }, undefined, undefined, false),
    error => error.code === 'resource_busy');

  // A sample that STARTED after the drain clears the fence and the row.
  await governor.account(storeDir, () => storageUsage(storeDir));
  const fresh = await readLedger(base);
  assert.equal(fresh.stores[storeKey].uncertain ?? false, false);
  assert.equal(fresh.claims.some(claim => claim.key === key), false, 'the post-drain sample reclaimed the drained row');
  assert.deepEqual(await governor.tryAcquire(request), { granted: true });
  await governor.release(key);
  assert.deepEqual((await governor.status()).claims, []);
});

test('a checkpoint can start immediately after the drain transaction without losing its sample', { timeout: 15000 }, async t => {
  const { root, storeDir, governor } = await storageFixture(t, 'atomic-drain');
  await governor.account(storeDir, () => storageUsage(storeDir));
  const permit = await governor.acquire({
    key: 'storage:atomic-drain', kind: 'storage', root, bytes: 32 * MIB, lane: 'work', store: storeDir
  }, undefined, undefined, false);
  let resume, measuring;
  const reached = new Promise(resolve => { measuring = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const transact = governor.transaction.bind(governor);
  let armed = true;
  let checkpoint;
  governor.transaction = async run => {
    const result = await transact(run);
    if (armed && result === true) {
      armed = false;
      checkpoint = governor.withStoreWrite(storeDir, async () => 'committed', async () => {
        measuring();
        await gate;
        return storageUsage(storeDir);
      });
      await reached;
    }
    return result;
  };
  try {
    await permit.drain();
    assert.ok(checkpoint, 'the checkpoint began before the drain caller continued');
    resume();
    assert.equal(await checkpoint, 'committed');
  } finally {
    resume();
    governor.transaction = transact;
    await checkpoint?.catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Regression (3): only an owning LIVE poll takes a queued model/tool/storage
// ticket. Older eligible contenders of another host order the queue virtually
// and are never persisted here, and an abandoned ticket is withdrawn after its
// bounded liveness window without expiring any real effect.
// ---------------------------------------------------------------------------

const modelConfig = { ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 4 };

/** One work-lane model request whose queue identity is its key. */
const modelRequest = key => ({ key, kind: 'model', root: `root-${key}`, scope: `root-${key}`, model: 'model-a', localCapacity: 1 });

test('a younger cross-host poll keeps FIFO order virtually and never persists the older grant', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-virtual-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const config = () => modelConfig;
  const a = new ResourceGovernor(config, directory), b = new ResourceGovernor(config, directory);
  t.after(() => a.close().catch(() => undefined));
  t.after(() => b.close().catch(() => undefined));
  const rows = async () => (await a.status()).claims;
  const stateOf = async key => (await rows()).find(claim => claim.key === key)?.state;

  // Host A holds the only work-model slot, so both later tickets are queued.
  assert.deepEqual(await a.tryAcquire(modelRequest('holder')), { granted: true });
  assert.deepEqual(await b.tryAcquire(modelRequest('older')), { granted: false, reason: 'model_capacity' });
  assert.deepEqual(await a.tryAcquire(modelRequest('younger')), { granted: false, reason: 'model_capacity' });
  await a.release('holder');

  // Host A polls first. Sequence order wins across hosts: the OLDER ticket keeps
  // the handoff, but A must not publish B's grant as an active claim of its own.
  assert.deepEqual(await a.tryAcquire(modelRequest('younger')), { granted: false, reason: 'model_capacity' });
  assert.equal(await stateOf('older'), 'waiting');
  assert.equal(await stateOf('younger'), 'waiting');
  assert.equal((await rows()).filter(claim => claim.state === 'active').length, 0,
    'no phantom active ownership was created for another caller');

  // B's own live poll takes the handoff, activating exactly its own ticket.
  assert.deepEqual(await b.tryAcquire(modelRequest('older')), { granted: true });
  assert.equal(await stateOf('older'), 'active');
  assert.equal(await stateOf('younger'), 'waiting');
  assert.equal((await rows()).filter(claim => claim.state === 'active').length, 1);

  await b.release('older');
  assert.deepEqual(await a.tryAcquire(modelRequest('younger')), { granted: true });
  await a.release('younger');
  assert.deepEqual(await rows(), []);
});

test('a same-host cancelled ticket whose withdrawal fails is never revived by a younger poll', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-same-host-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const clock = { now: 7_000_000 };
  const resources = new ResourceGovernor(() => modelConfig, path.join(base, 'resources'), () => clock.now);
  t.after(() => resources.close().catch(() => undefined));
  const rows = async () => (await resources.status()).claims;
  const ticket = async key => (await rows()).find(claim => claim.key === key);
  // One store, one local model slot: the older queued ticket must keep it.
  const queued = key => ({ key, kind: 'model', root: 'same-root', scope: 'same-store', model: 'model-a', localCapacity: 1 });

  assert.deepEqual(await resources.tryAcquire(queued('holder')), { granted: true });
  // The cancelled request queues FIRST through acquire(), so it is the older
  // ticket. Both tickets share this one governor, exactly like a real host.
  const controller = new AbortController();
  const cancelled = resources.acquire(queued('cancelled'), controller.signal)
    .then(permit => ({ permit }), error => ({ error }));
  await until(async () => (await ticket('cancelled'))?.state === 'waiting');
  assert.deepEqual(await resources.tryAcquire(queued('younger')), { granted: false, reason: 'model_capacity' });

  // Cancelling runs acquire()'s own withdrawal, which transiently FAILS: the
  // queued ticket stays durable although its waiter is gone.
  const release = resources.release.bind(resources);
  resources.release = async key => {
    if (key === 'cancelled') {
      throw Error('aggregate ledger unavailable');
    }
    return release(key);
  };
  controller.abort();
  const settled = await cancelled;
  assert.match(settled.error?.message ?? '', /aggregate ledger unavailable/);
  assert.equal((await ticket('cancelled')).state, 'waiting', 'the failed withdrawal left a durable queued ticket');
  const heartbeat = (await ticket('cancelled')).heartbeat;
  await release('holder');

  // The younger ticket now polls on the SAME governor. FIFO says the older
  // ticket still owns the handoff, and that poll may not persist the ghost as
  // active: only the polling ticket's own row may ever change.
  assert.deepEqual(await resources.tryAcquire(queued('younger')), { granted: false, reason: 'model_capacity' });
  const after = await rows();
  assert.equal(after.some(claim => claim.state === 'active'), false, 'no phantom active ownership was created');
  assert.equal(after.find(claim => claim.key === 'cancelled').state, 'waiting');
  assert.equal(after.find(claim => claim.key === 'cancelled').heartbeat, heartbeat, 'a sibling poll never refreshes it');
  assert.equal(after.find(claim => claim.key === 'younger').waitingReason, 'model_capacity',
    'status reports the same virtual-FIFO reason as admission');

  // Past the bounded window the abandoned ticket is reclaimed and the live
  // younger poller proceeds, activating only its own ticket.
  clock.now += WAITING_TICKET_WINDOW_MS + 1;
  assert.deepEqual(await resources.tryAcquire(queued('younger')), { granted: true });
  assert.equal((await ticket('younger')).state, 'active');
  assert.equal(await ticket('cancelled'), undefined, 'the abandoned ticket was reclaimed by its own window');
  const admitted = (await readLedger(base)).claims.find(claim => claim.key === 'younger');
  assert.equal('heartbeat' in admitted, false, 'an admitted effect carries no liveness stamp');
  await resources.release('younger');
  assert.deepEqual(await rows(), []);
});

// ---------------------------------------------------------------------------
// Regression (5): a quarantine labels a model/runner denial only when it belongs
// to the exact subset that reached the limit which BINDS. A quarantine in another
// store, or one outside the saturated aggregate/local set, never relabels a
// plain capacity wait, while a quarantine inside that set does. Either way the
// decision (granted/denied) and the liveness of every row are unchanged.
// ---------------------------------------------------------------------------

test('an unrelated quarantine never relabels a local model or runner denial', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-quarantine-scope-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const clock = { now: 9_000_000 };
  // Aggregate headroom everywhere: only the per-store local limit binds.
  const config = () => ({ ...resourceDefaults, enabled: true, modelCapacity: 8, runnableCapacity: 16, runnerCapacity: 8 });
  const governor = new ResourceGovernor(config, path.join(base, 'resources'), () => clock.now);
  t.after(() => governor.close().catch(() => undefined));
  const rows = async () => (await governor.status()).claims;
  const rowOf = async key => (await rows()).find(claim => claim.key === key);
  const modelRequest = (key, scope, model = 'model-a') => ({ key, kind: 'model', lane: 'work', root: `root-${scope}`, scope, model, localCapacity: 1, bytes: 0 });
  const runnerRequest = (key, scope) => ({ key, kind: 'runner', lane: 'work', root: `root-${scope}`, scope, localCapacity: 1, bytes: 0 });

  // Normal active work saturates the LOCAL model limit (one slot per store and
  // model) while the aggregate keeps headroom, and a model of another store is
  // quarantined: that quarantine explains nothing about this local wait.
  assert.deepEqual(await governor.tryAcquire(modelRequest('model-holder', 'store-a')), { granted: true });
  assert.deepEqual(await governor.tryAcquire(modelRequest('model-elsewhere', 'store-b')), { granted: true });
  await governor.quarantine('model-elsewhere');
  assert.equal((await rowOf('model-elsewhere')).state, 'quarantine');
  assert.deepEqual(await governor.tryAcquire(modelRequest('model-local', 'store-a')), { granted: false, reason: 'model_capacity' },
    'another store\u2019s quarantine never relabels a local model denial');
  assert.equal((await rowOf('model-local')).waitingReason, 'model_capacity', 'status projects the same scoped reason');
  assert.equal((await rowOf('model-local')).state, 'waiting', 'only the REASON is scoped: the request still waits');

  // A quarantine inside the saturated local set is what actually binds.
  await governor.quarantine('model-holder');
  assert.deepEqual(await governor.tryAcquire(modelRequest('model-local', 'store-a')), { granted: false, reason: 'quarantine' },
    'a quarantine in the saturated local set does change the reason');
  assert.equal((await rowOf('model-local')).waitingReason, 'quarantine');

  // The runner branch is scoped the same way: its local set is the store.
  assert.deepEqual(await governor.tryAcquire(runnerRequest('runner-holder', 'pool-a')), { granted: true });
  assert.deepEqual(await governor.tryAcquire(runnerRequest('runner-elsewhere', 'pool-b')), { granted: true });
  await governor.quarantine('runner-elsewhere');
  assert.deepEqual(await governor.tryAcquire(runnerRequest('runner-local', 'pool-a')), { granted: false, reason: 'runner_capacity' },
    'another pool\u2019s quarantine never relabels a local runner denial');
  await governor.quarantine('runner-holder');
  assert.deepEqual(await governor.tryAcquire(runnerRequest('runner-local', 'pool-a')), { granted: false, reason: 'quarantine' },
    'a quarantine in the saturated local runner set changes the reason');

  // Liveness is unchanged by the label: a quarantine is an EFFECT, never a
  // ticket, so it carries no heartbeat and survives the sweep that reclaims
  // stale waiting rows. The decisions themselves never flip.
  assert.equal('heartbeat' in (await rowOf('model-elsewhere')), false, 'a quarantine is not a ticket');
  clock.now += WAITING_TICKET_WINDOW_MS + 1;
  assert.deepEqual(await governor.tryAcquire(modelRequest('model-local', 'store-a')), { granted: false, reason: 'quarantine' },
    'the denial and its scoped reason are unchanged across a liveness sweep');
  assert.equal((await rowOf('model-holder')).state, 'quarantine', 'a quarantined effect is never expired');
  assert.equal((await rowOf('runner-holder')).state, 'quarantine', 'a quarantined effect is never expired');
  assert.deepEqual(await governor.tryAcquire(runnerRequest('runner-local', 'pool-a')), { granted: false, reason: 'quarantine' });
  assert.equal((await governor.status()).summary.quarantine, 4, 'no quarantine row was created or lost by the reason');
  assert.equal((await rows()).some(claim => claim.state === 'active'), false, 'no admission was granted by the reason');
});

test('a service-lane quarantine beside a full work reserve never relabels a capacity wait', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-service-quarantine-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const clock = { now: 11_000_000 };
  // model/runner capacity 2 with the default service reserve 1: ordinary WORK may
  // hold one of the two and the other is reserved for the service lanes, so a
  // service-lane quarantine that fills only the overall cap never explains a
  // work-ticket wait.
  const config = () => ({ ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 4, runnerCapacity: 2 });
  const governor = new ResourceGovernor(config, path.join(base, 'resources'), () => clock.now);
  t.after(() => governor.close().catch(() => undefined));
  const rows = async () => (await governor.status()).claims;
  const rowOf = async key => (await rows()).find(claim => claim.key === key);
  const model = (key, lane, scope, localCapacity = 1) => ({ key, kind: 'model', lane, root: `root-${scope}`, scope, model: 'model-a', localCapacity, bytes: 0 });
  const runner = (key, lane, scope) => ({ key, kind: 'runner', lane, root: `root-${scope}`, scope, localCapacity: 1, bytes: 0 });

  // Normal active work holds its reserved share of the model cap ...
  assert.deepEqual(await governor.tryAcquire(model('model-work', 'work', 'store-a')), { granted: true });
  // ... and a SERVICE-lane row occupies the rest as a quarantine. Removing that
  // quarantine alone would still not admit the work ticket: its reserve is full.
  assert.deepEqual(await governor.tryAcquire(model('model-service', 'validation', 'store-b')), { granted: true });
  await governor.quarantine('model-service');
  assert.deepEqual(await governor.tryAcquire(model('model-wait', 'work', 'store-c')), { granted: false, reason: 'model_capacity' },
    'a service-only quarantine never relabels a work-reserved model wait');

  // The runner family, same shape.
  assert.deepEqual(await governor.tryAcquire(runner('runner-work', 'work', 'pool-a')), { granted: true });
  assert.deepEqual(await governor.tryAcquire(runner('runner-service', 'validation', 'pool-b')), { granted: true });
  await governor.quarantine('runner-service');
  assert.deepEqual(await governor.tryAcquire(runner('runner-wait', 'work', 'pool-c')), { granted: false, reason: 'runner_capacity' },
    'a service-only quarantine never relabels a work-reserved runner wait');

  // A quarantine that merely fills the aggregate while an ORDINARY local holder
  // keeps the local cap full is not the binding cause either.
  assert.deepEqual(await governor.tryAcquire(model('model-local', 'validation', 'store-a')), { granted: false, reason: 'model_capacity' },
    'a quarantine is no explanation while a live local holder keeps the local cap full');

  // Liveness and decisions are unchanged: a quarantine is an effect, a ticket is
  // not, and nothing was admitted by the label.
  assert.equal((await rowOf('model-service')).state, 'quarantine');
  assert.equal('heartbeat' in (await rowOf('model-service')), false, 'a quarantine is not a ticket');
  assert.equal((await rowOf('model-wait')).state, 'waiting');
  clock.now += WAITING_TICKET_WINDOW_MS + 1;
  assert.deepEqual(await governor.tryAcquire(model('model-wait', 'work', 'store-c')), { granted: false, reason: 'model_capacity' },
    'the same decision and reason survive a liveness sweep');

  // A quarantine that really BINDS its family - nothing live is left once the
  // quarantined rows are filtered out - is still reported as such.
  await governor.quarantine('model-work');
  const legacyBlocked = { ...model('model-legacy-blocked', 'validation', 'store-d'), localBlocked: true };
  assert.deepEqual(await governor.tryAcquire(legacyBlocked), { granted: false, reason: 'model_capacity' },
    'quarantine cleanup cannot free a slot held by legacy work');
  await governor.release(legacyBlocked.key);
  assert.deepEqual(await governor.tryAcquire(model('model-wait', 'work', 'store-c')), { granted: false, reason: 'quarantine' },
    'a binding model quarantine still relabels the wait');
  await governor.quarantine('runner-work');
  assert.deepEqual(await governor.tryAcquire(runner('runner-wait', 'work', 'pool-c')), { granted: false, reason: 'quarantine' },
    'a binding runner quarantine still relabels the wait');

  for (const key of ['model-work', 'model-service', 'runner-work', 'runner-service', 'model-wait', 'runner-wait', 'model-local']) {
    await governor.release(key);
  }
});

// ---------------------------------------------------------------------------
// Regression (13): a storage BYTE refusal is a QUARANTINE when the healthy samples
// plus the live charges would fit once the quarantined reservations are released,
// and ordinary storage whenever the wait would remain without them. Eligibility is
// untouched, and the FIFO protection that keeps a younger same-lane reservation
// behind an older storage-blocked waiter spans the relabeled reason - while an
// unrelated model or runner quarantine still never acts as a storage blocker.
// ---------------------------------------------------------------------------

test('a storage wait explained by a quarantined reservation is a quarantine, and it still blocks younger same-lane bytes', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-storage-quarantine-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  await fs.mkdir(root); await fs.mkdir(storeDir);
  await fs.writeFile(path.join(storeDir, 'state.bin'), Buffer.alloc(4096, 7));
  // 64 MiB aggregate: the work lane may use 56 MiB, validation all 64 MiB.
  const config = () => ({ ...resourceDefaults, enabled: true, modelCapacity: 8, runnableCapacity: 16,
    runnerCapacity: 4, storageBytes: 64 * MIB, serviceReserve: 1 });
  const directory = path.join(base, 'resources');
  const owner = new ResourceGovernor(config, directory);
  const older = new ResourceGovernor(config, directory);
  const younger = new ResourceGovernor(config, directory);
  t.after(() => owner.close().catch(() => undefined));
  t.after(() => older.close().catch(() => undefined));
  t.after(() => younger.close().catch(() => undefined));
  const storage = (key, bytes) => ({ key, kind: 'storage', lane: 'work', root, bytes, store: storeDir });
  const rowOf = async key => (await younger.status()).claims.find(claim => claim.key === key);

  // A healthy retained sample of 8 MiB, ONE live 4 MiB charge, and a 32 MiB
  // reservation that is exactly the kind an explicit quarantine may release.
  await owner.account(storeDir, () => 8 * MIB);
  assert.equal((await owner.tryAcquire(storage('storage:live', 4 * MIB))).granted, true);
  assert.equal((await owner.tryAcquire(storage('storage:quarantined', 32 * MIB))).granted, true);
  await owner.quarantine('storage:quarantined');
  assert.equal((await younger.status()).summary.reservedBytes, 36 * MIB);

  // 8 + 4 + 32 + 24 > 56, but 8 + 4 + 24 <= 56: releasing that exact quarantine
  // really admits this request, so the wait names the actionable cause.
  assert.deepEqual(await older.tryAcquire(storage('storage:older', 24 * MIB)), { granted: false, reason: 'quarantine' });
  assert.equal((await rowOf('storage:older')).waitingReason, 'quarantine', 'status projects the same reason');

  // A YOUNGER same-lane reservation that fits on its own bytes must not overtake
  // that older waiter: a storage-blocked wait - relabeled or not - still holds the
  // head of the queue.
  assert.deepEqual(await younger.tryAcquire(storage('storage:younger', 8 * MIB)), { granted: false, reason: 'storage' },
    'a younger same-lane ticket never overtakes an older storage-blocked waiter');
  assert.equal((await rowOf('storage:younger')).waitingReason, 'storage');
  assert.ok((await rowOf('storage:older')).sequence < (await rowOf('storage:younger')).sequence);
  assert.equal((await rowOf('storage:younger')).state, 'waiting', 'only the reason changes: it still waits');
  assert.equal((await rowOf('storage:live')).state, 'active', 'nothing was admitted or released by the label');
  assert.equal((await rowOf('storage:quarantined')).state, 'quarantine');

  // CONTROL: live and retained bytes still bind. 8 + 4 + 48 = 60 > 56 even after
  // that quarantine is excluded, so the ordinary storage wait is kept.
  assert.deepEqual(await younger.tryAcquire(storage('storage:control', 48 * MIB)), { granted: false, reason: 'storage' },
    'ordinary storage is kept when the wait would remain without the quarantine');
  assert.equal((await rowOf('storage:control')).waitingReason, 'storage');
  await younger.release('storage:control');

  await younger.release('storage:younger');

  // An unrelated MODEL quarantine is not a storage blocker: its older ticket is
  // blocked by something releasing storage can never free, so it must not gate
  // younger bytes.
  await older.release('storage:older');
  assert.equal((await owner.tryAcquire({ key: 'model:quarantined', kind: 'model', lane: 'work', root,
    scope: 'model-store', model: 'model-a', localCapacity: 1, bytes: MIB })).granted, true);
  await owner.quarantine('model:quarantined');
  assert.deepEqual(await younger.tryAcquire({ key: 'model:older', kind: 'model', lane: 'work', root,
    scope: 'model-store', model: 'model-a', localCapacity: 1, bytes: MIB }), { granted: false, reason: 'quarantine' });
  assert.equal((await younger.tryAcquire(storage('storage:fits', 8 * MIB))).granted, true,
    'a model quarantine is not a storage blocker for younger bytes');

  await younger.release('storage:fits');
  await younger.release('model:older');
  await owner.release('storage:live');
  await owner.release('storage:quarantined');
  await owner.release('model:quarantined');
  assert.deepEqual((await younger.status()).claims, []);
});

test('an abandoned waiting model ticket is withdrawn after its window and never expires effects', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-model-liveness-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const clock = { now: 5_000_000 };
  const config = () => ({ ...modelConfig, runnerCapacity: 2 });
  const a = new ResourceGovernor(config, directory, () => clock.now);
  const b = new ResourceGovernor(config, directory, () => clock.now);
  t.after(() => a.close().catch(() => undefined));
  t.after(() => b.close().catch(() => undefined));
  const rows = async () => (await b.status()).claims;
  const ticket = async key => (await rows()).find(claim => claim.key === key);

  // An uncertain effect of the abandoned ticket's own host must outlive every
  // liveness sweep: it is an effect, not a queued ticket.
  assert.deepEqual(await a.tryAcquire({
    key: 'runner:effect', kind: 'runner', root: 'root-effect', scope: 'pool-effect', lane: 'validation', localCapacity: 1, bytes: 0
  }), { granted: true });
  await a.quarantine('runner:effect');

  assert.deepEqual(await a.tryAcquire(modelRequest('holder')), { granted: true });
  assert.deepEqual(await a.tryAcquire(modelRequest('orphan')), { granted: false, reason: 'model_capacity' });
  const heartbeat = (await ticket('orphan')).heartbeat;
  assert.equal(typeof heartbeat, 'number', 'a waiting model ticket records its own liveness');
  await a.release('holder');

  // The cancelled request's ledger withdrawal transiently fails: its ticket stays
  // durable, but nothing polls it again.
  const release = a.release.bind(a);
  a.release = async key => {
    if (key === 'orphan') {
      throw Error('aggregate ledger unavailable');
    }
    return release(key);
  };
  await assert.rejects(a.release('orphan'), /aggregate ledger unavailable/);
  assert.equal((await ticket('orphan')).state, 'waiting');

  // Host B's poll neither revives that foreign ticket as active nor refreshes it.
  assert.deepEqual(await b.tryAcquire(modelRequest('newcomer')), { granted: false, reason: 'model_capacity' });
  assert.equal((await ticket('orphan')).state, 'waiting', "another caller's poll never revives a foreign grant");
  assert.equal((await ticket('orphan')).heartbeat, heartbeat, "only a ticket's own poll refreshes its liveness");

  // Past its own bounded window the abandoned ticket is withdrawn, and the live
  // contender proceeds. Active, quarantined and drained rows are never expired.
  clock.now += WAITING_TICKET_WINDOW_MS + 1;
  assert.deepEqual(await b.tryAcquire(modelRequest('newcomer')), { granted: true });
  assert.equal(await ticket('orphan'), undefined, 'the abandoned ticket was reclaimed');
  assert.equal((await ticket('runner:effect')).state, 'quarantine', 'a real uncertain effect is never expired');
  assert.equal((await b.status()).summary.quarantine, 1);
  await b.release('newcomer');
});

// ---------------------------------------------------------------------------
// Regression (4): initial OS-user ledger creation is one durable two-phase
// publication (pending marker, canonical empty ledger, established marker), so an
// interruption between the marker and the empty ledger resumes instead of
// failing closed. A missing or corrupt ESTABLISHED ledger still fails closed.
// ---------------------------------------------------------------------------

test('an interrupted initial ledger publication resumes from the pending namespace marker', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-initial-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const namespaceFile = path.join(directory, 'namespace.json');
  const ledgerFile = path.join(directory, 'ledger.json');
  const pending = JSON.stringify({ schema: 1, kind: 'os-user-resources', state: 'pending' });
  const established = JSON.stringify({ schema: 1, kind: 'os-user-resources' });
  const config = () => ({ ...resourceDefaults, enabled: true });
  const storage = require(path.join(buildDir, 'storage'));

  // Deterministic fault injection: the marker is durable, the empty ledger
  // publication fails - exactly a crash between the two publication steps.
  const realAtomicWrite = storage.atomicWrite;
  let armed = true;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (armed && path.basename(file) === 'ledger.json') {
      armed = false;
      throw Error('injected crash between marker and empty ledger');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  const interrupted = new ResourceGovernor(config, directory);
  t.after(() => interrupted.close().catch(() => undefined));
  try {
    await assert.rejects(interrupted.refreshPolicy(), /injected crash between marker and empty ledger/);
  } finally {
    storage.atomicWrite = realAtomicWrite;
  }
  assert.equal(armed, false);
  assert.equal(await fs.readFile(namespaceFile, 'utf8'), pending, 'the pending namespace marker is durable and distinct');
  await assert.rejects(fs.readFile(ledgerFile, 'utf8'), error => error.code === 'ENOENT');
  // A crash inside the atomic write can only leave a temporary behind; it is not
  // ownership, so the strict empty-ledger rule still applies.
  const temporary = path.join(directory, `ledger.json.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, '{"schema":1,"sequence":9');

  // Reload resumes the interrupted initialization instead of failing closed.
  const resumed = new ResourceGovernor(config, directory);
  t.after(() => resumed.close().catch(() => undefined));
  assert.deepEqual(await resumed.tryAcquire({ key: 'first-tool', kind: 'tool', root: 'root-initial', bytes: 0 }), { granted: true });
  const claim = (await resumed.status()).claims.find(row => row.key === 'first-tool');
  assert.equal(claim.sequence, 1, 'the resumed initialization published the canonical empty ledger, not a reset of ownership');
  await resumed.release('first-tool');
  assert.equal(await fs.readFile(namespaceFile, 'utf8'), established, 'the completed initialization established the namespace');
  await fs.rm(temporary, { force: true });
  assert.equal((await readLedger(base)).claims.length, 0);

  // An established namespace still refuses a missing, or a corrupt, ledger.
  await fs.rm(ledgerFile);
  const missing = new ResourceGovernor(config, directory);
  t.after(() => missing.close().catch(() => undefined));
  await assert.rejects(missing.status(), error => error.code === 'resource_corrupt' && /Missing ledger/.test(error.message));
  await fs.writeFile(ledgerFile, '{"schema":1,"sequence":"not-a-number"}');
  const corrupt = new ResourceGovernor(config, directory);
  t.after(() => corrupt.close().catch(() => undefined));
  await assert.rejects(corrupt.status(), error => error.code === 'resource_corrupt' && /Restore the resource ledger/.test(error.message));

  // A pending marker recovers only a strictly empty ledger: an ownership-bearing
  // ledger beside it is corruption, never a reset.
  await fs.writeFile(ledgerFile, JSON.stringify({ schema: 1, sequence: 1, policies: {}, stores: {}, claims: [] }));
  await fs.writeFile(namespaceFile, pending);
  const tampered = new ResourceGovernor(config, directory);
  t.after(() => tampered.close().catch(() => undefined));
  await assert.rejects(tampered.status(), error => error.code === 'resource_corrupt' && /interrupted initial resource ledger/.test(error.message));
});

// ---------------------------------------------------------------------------
// Regression (5): durable ownership is acknowledged only AFTER every fallible
// handoff step. A grant callback that cancels its own caller, a withdrawal that
// fails once, and a closing host must never leave an ACTIVE row for a permit
// nobody received - while a handoff that is still in flight keeps charging
// capacity and an acknowledged effect is never expired or adopted.
// ---------------------------------------------------------------------------

const handoffConfig = { ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 4 };
const handoffRequest = key => ({ key, kind: 'model', root: 'handoff-root', scope: 'handoff-store',
  model: 'model-a', localCapacity: 1, bytes: 2 * MIB });

test('a handoff cancelled inside its own grant callback leaves no unacknowledged active claim', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-handoff-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const clock = { now: 2_000_000 };
  const directory = path.join(base, 'resources');
  const governor = new ResourceGovernor(() => handoffConfig, directory, () => clock.now);
  t.after(() => governor.close().catch(() => undefined));
  const key = 'model:handoff';
  const ledgerRows = async () => (await readLedger(base)).claims;
  const rowOf = async target => (await ledgerRows()).find(claim => claim.key === target);

  // The permit's own withdrawal fails exactly once, like a transient aggregate
  // ledger failure; every later withdrawal succeeds.
  const realRelease = governor.release.bind(governor);
  let failures = 1;
  governor.release = async target => {
    if (failures > 0) {
      failures -= 1;
      throw Error('aggregate ledger unavailable');
    }
    return realRelease(target);
  };

  const controller = new AbortController();
  const announced = [];
  const outcome = await governor.acquire(handoffRequest(key), controller.signal, async reason => {
    announced.push(reason);
    if (reason === undefined) {
      // The caller aborts INSIDE the grant callback, before any effect exists.
      controller.abort();
    }
  }).then(permit => ({ permit }), error => ({ error }));

  assert.equal(outcome.permit, undefined, 'no permit is handed off to an aborted caller');
  assert.match(outcome.error?.message ?? '', /aggregate ledger unavailable/, 'the failed withdrawal is still reported');
  assert.deepEqual(announced, [undefined], 'the callback only ever saw the grant announcement');

  // The failed withdrawal left a durable row, but it is PROVISIONAL: it owns the
  // queue position and charges capacity, and it is not an effect.
  const provisional = await rowOf(key);
  assert.equal(provisional?.state, 'provisional', 'an unacknowledged handoff is never active');
  assert.equal(typeof provisional.heartbeat, 'number', 'a provisional grant carries its own liveness');
  assert.equal((await governor.status()).summary.reservedBytes, 2 * MIB, 'a live provisional grant is charged');
  // Mixed-API collision: a direct tryAcquire on that EXACT key has no acknowledged
  // effect behind it, so it must not be handed the unacknowledged grant, and it
  // must not adopt or refresh it either.
  assert.deepEqual(await governor.tryAcquire(handoffRequest(key)), { granted: false, reason: 'quarantine' },
    'direct tryAcquire can never use a key an unacknowledged handoff owns');
  const untouched = await rowOf(key);
  assert.equal(untouched?.state, 'provisional', 'the denied poll neither activated nor withdrew the handoff');
  assert.equal(untouched.heartbeat, provisional.heartbeat, "another API's poll never refreshes the handoff's liveness");
  assert.equal((await governor.status()).summary.reservedBytes, 2 * MIB, 'the denied poll leaves the handoff charged');
  assert.deepEqual(await governor.tryAcquire(handoffRequest('model:blocked')), { granted: false, reason: 'model_capacity' },
    'a live provisional grant holds capacity exactly like an admitted effect');

  // Closing the owning host withdraws it: a handoff nobody acknowledged is not an
  // uncertain effect, so it can never become a permanent quarantine.
  await governor.close();
  assert.equal((await ledgerRows()).some(claim => claim.key === key), false,
    'an unacknowledged handoff is withdrawn on close, never quarantined');
  assert.equal((await ledgerRows()).some(claim => claim.state === 'quarantine'), false);

  // A reload starts clean, and a completed handoff is still an acknowledged effect
  // that its owner releases normally.
  const reloaded = new ResourceGovernor(() => handoffConfig, directory, () => clock.now);
  t.after(() => reloaded.close().catch(() => undefined));
  assert.deepEqual((await reloaded.status()).claims, []);
  const permit = await reloaded.acquire(handoffRequest('model:after-abort'));
  assert.equal((await rowOf('model:after-abort'))?.state, 'active',
    'a completed handoff is acknowledged as a real effect');
  await permit.release();
  assert.deepEqual(await ledgerRows(), []);
});

test('a provisional handoff expires as no effect and never expires an acknowledged claim', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-provisional-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const clock = { now: 3_000_000 };
  const directory = path.join(base, 'resources');
  const first = new ResourceGovernor(() => handoffConfig, directory, () => clock.now);
  const second = new ResourceGovernor(() => handoffConfig, directory, () => clock.now);
  t.after(() => first.close().catch(() => undefined));
  t.after(() => second.close().catch(() => undefined));
  const rows = async () => (await readLedger(base)).claims;
  const rowOf = async target => (await rows()).find(claim => claim.key === target);
  const key = 'model:lost';

  // The owning caller is cancelled inside its grant callback and its withdrawal
  // fails permanently: exactly the reported leak.
  first.release = async () => { throw Error('aggregate ledger unavailable'); };
  const controller = new AbortController();
  const outcome = await first.acquire(handoffRequest(key), controller.signal, async reason => {
    if (reason === undefined) {
      controller.abort();
    }
  }).then(permit => ({ permit }), error => ({ error }));
  assert.equal(outcome.permit, undefined);
  assert.equal((await rowOf(key))?.state, 'provisional', 'the durable row is provisional, not active');

  // While it is LIVE every other host treats it as admitted capacity, and no other
  // caller may adopt or revive it.
  assert.deepEqual(await second.tryAcquire(handoffRequest('model:younger')), { granted: false, reason: 'model_capacity' },
    'a live provisional handoff keeps the younger request waiting');
  assert.equal((await rowOf(key))?.state, 'provisional', 'another host never adopts a provisional grant');
  assert.equal((await rowOf('model:younger'))?.state, 'waiting', 'the younger request stays a waiting ticket');

  // Past its own window the unacknowledged handoff is withdrawn as NO effect.
  clock.now += WAITING_TICKET_WINDOW_MS + 1;
  assert.deepEqual(await second.tryAcquire(handoffRequest('model:younger')), { granted: true });
  assert.equal(await rowOf(key), undefined, 'the unacknowledged handoff was withdrawn, not quarantined');
  assert.equal((await rowOf('model:younger'))?.state, 'active');
  assert.equal('heartbeat' in (await rowOf('model:younger')), false, 'an admitted effect carries no liveness stamp');

  // A truly acknowledged effect is never expired, at any later clock.
  clock.now += WAITING_TICKET_WINDOW_MS * 2;
  assert.deepEqual(await second.tryAcquire(handoffRequest('model:next')), { granted: false, reason: 'model_capacity' });
  assert.equal((await rowOf('model:younger'))?.state, 'active', 'an active effect is never expired by ticket liveness');

  // Closing the adopter retains that real effect as an uncertain one, and only it.
  await second.close();
  const closed = await rows();
  assert.equal(closed.find(claim => claim.key === 'model:younger')?.state, 'quarantine');
  assert.equal(closed.some(claim => claim.key === key), false, 'no no-effect row became a quarantine');
  assert.equal(closed.some(claim => claim.key === 'model:next'), false, 'a queued ticket owns no effect and is withdrawn');
  assert.equal((await second.status()).summary.quarantine, 1);
});

// ---------------------------------------------------------------------------
// Regression (6): the durable ledger commit precedes the fallible lock cleanup,
// and the acknowledgement of a handoff is the transaction that turns a
// provisional row into owned capacity. A denied unlink AFTER that commit must
// keep the permit (and its consistent ownership), while a failure BEFORE it must
// reject the attempt without leaving an ACTIVE row nobody owns.
// ---------------------------------------------------------------------------

const ackConfig = { ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 4 };
const ackRequest = key => ({ key, kind: 'model', root: 'ack-root', scope: 'ack-store',
  model: 'model-a', localCapacity: 8, bytes: MIB });

test('a single post-commit unlock failure keeps the committed permit and its ownership', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-unlock-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const lock = path.join(directory, 'transaction.lock');
  const governor = new ResourceGovernor(() => ackConfig, directory);
  t.after(() => governor.close().catch(() => undefined));

  // Deterministic fault injection: exactly ONE refused unlink of THIS governor's
  // transaction lock, on its second removal - the acknowledgement transaction,
  // because the provisional grant before it removed the lock normally.
  const realRm = fs.rm;
  let lockRemovals = 0;
  let injected = 0;
  let ledgerDuringFailure;
  fs.rm = async (target, options) => {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(lock)) {
      lockRemovals += 1;
      if (lockRemovals === 2 && injected === 0) {
        injected += 1;
        ledgerDuringFailure = (await readLedger(base)).claims.map(claim => ({ key: claim.key, state: claim.state }));
        throw Object.assign(Error(`EPERM: operation not permitted, unlink '${lock}'`),
          { code: 'EPERM', errno: -4048, syscall: 'unlink', path: lock });
      }
    }
    return realRm(target, options);
  };
  const key = 'model:post-commit';
  const outcome = await governor.acquire(ackRequest(key), new AbortController().signal)
    .then(permit => ({ permit }), error => ({ error }));
  fs.rm = realRm;

  assert.equal(injected, 1, 'exactly one unlink was refused');
  assert.equal(outcome.error, undefined, 'a refused unlink after the commit never rejects the attempt');
  assert.ok(outcome.permit, 'the caller owns the committed permit');
  assert.deepEqual(ledgerDuringFailure, [{ key, state: 'active' }],
    'the unlink was refused AFTER the durable acknowledgement, never before it');
  assert.ok(lockRemovals >= 3, 'the transient denial was retried rather than ignored');
  await assert.rejects(fs.stat(lock), error => error.code === 'ENOENT', 'the lock is gone again');

  // Consistent ownership: the row is a real effect of this host, it is charged,
  // and only this permit can settle it.
  const rowOf = async () => (await readLedger(base)).claims.find(claim => claim.key === key);
  const mine = await rowOf();
  assert.equal(mine?.state, 'active');
  assert.equal('heartbeat' in mine, false, 'an acknowledged effect carries no liveness stamp');
  assert.equal((await governor.status()).summary.reservedBytes, MIB, 'the committed permit is charged');
  // deferModel only accepts an OWNED, ACTIVE model grant of this host.
  await governor.deferModel(key);
  assert.equal((await rowOf())?.state, 'waiting', 'the permit really is the owner of that claim');
  await outcome.permit.release();
  assert.deepEqual((await readLedger(base)).claims, [], 'release settles the claim exactly once');
  assert.equal((await governor.status()).summary.reservedBytes, 0);
  assert.equal(await governor.tryAcquire(ackRequest('model:after-unlock')).then(r => r.granted), true);
});

test('an acknowledgement that fails before its commit is rejected without an unowned active row', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-precommit-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const governor = new ResourceGovernor(() => ackConfig, directory);
  t.after(() => governor.close().catch(() => undefined));
  const storage = require(path.join(buildDir, 'storage'));

  // The provisional grant is durable; only the write that would publish the ACTIVE
  // ownership fails. That is a pre-commit failure, so the attempt is rejected.
  const realAtomicWrite = storage.atomicWrite;
  let armed = true;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (armed && path.basename(file) === 'ledger.json' && typeof text === 'string' && text.includes('"state":"active"')) {
      armed = false;
      throw Error('injected pre-commit ledger failure');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  const key = 'model:pre-commit';
  const outcome = await governor.acquire(ackRequest(key), new AbortController().signal)
    .then(permit => ({ permit }), error => ({ error }));
  storage.atomicWrite = realAtomicWrite;

  assert.equal(armed, false, 'the pre-commit failure was actually injected');
  assert.equal(outcome.permit, undefined, 'no permit is handed out for an effect that never committed');
  assert.match(outcome.error?.message ?? '', /injected pre-commit ledger failure/, 'the pre-commit failure is reported unchanged');
  assert.deepEqual((await readLedger(base)).claims, [],
    'the caller-owned rollback withdrew the provisional row: no row is left unowned');
  await assert.rejects(fs.stat(path.join(directory, 'transaction.lock')), error => error.code === 'ENOENT');

  // A retry after the rejected attempt admits and acknowledges normally.
  const permit = await governor.acquire(ackRequest(key));
  assert.equal((await readLedger(base)).claims.find(claim => claim.key === key)?.state, 'active');
  await permit.release();
  assert.deepEqual((await readLedger(base)).claims, []);
});

test('a published ledger commit is never undone by temporary-file cleanup', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-publish-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const governor = new ResourceGovernor(() => ackConfig, directory);
  t.after(() => governor.close().catch(() => undefined));

  const realRm = fs.rm;
  let temporaryRemovals = 0;
  // A resolved atomicWrite must not depend on removing its own temporary path:
  // after the rename that path is gone, so any cleanup failure there would report
  // a rejection for an effect the ledger already grants.
  fs.rm = async (target, options) => {
    if (typeof target === 'string' && path.basename(target).endsWith('.tmp')
      && path.resolve(path.dirname(target)) === path.resolve(directory)) {
      temporaryRemovals += 1;
      throw Object.assign(Error('EPERM: unlink of a published temporary'), { code: 'EPERM', path: target });
    }
    return realRm(target, options);
  };
  const key = 'model:published';
  const outcome = await governor.acquire(ackRequest(key), new AbortController().signal)
    .then(permit => ({ permit }), error => ({ error }));
  fs.rm = realRm;

  assert.equal(outcome.error, undefined, 'temporary cleanup never rejects a durable commit');
  assert.ok(outcome.permit, 'the caller owns the published permit');
  assert.equal(temporaryRemovals, 0, 'a published atomicWrite leaves no temporary path to remove');
  assert.equal((await readLedger(base)).claims.find(claim => claim.key === key)?.state, 'active');
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), [],
    'the rename consumed the temporary, so nothing is left behind');
  await outcome.permit.release();
  assert.deepEqual((await readLedger(base)).claims, []);
});

test('status inspection publishes no local policy and never changes the aggregate minima', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-status-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const wide = { ...resourceDefaults, enabled: true, modelCapacity: 8, runnableCapacity: 16 };
  const narrow = { ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 16 };
  const hostA = new ResourceGovernor(() => wide, directory);
  const hostB = new ResourceGovernor(() => narrow, directory);
  t.after(() => hostA.close().catch(() => undefined));
  t.after(() => hostB.close().catch(() => undefined));
  const ledger = async () => readLedger(base);
  const published = async () => Object.keys((await ledger()).policies).sort();
  // Validation lane: its admission leaves the work-lane service reserve out of this
  // comparison, so the aggregate minima alone decide the outcome.
  const request = key => ({ key, kind: 'model', lane: 'validation', root: 'status-root',
    scope: 'status-store', model: 'model-a', localCapacity: 8, bytes: MIB });

  // Host A participates; its own claim stays charged throughout.
  assert.equal((await hostA.tryAcquire(request('a-owned'))).granted, true);
  assert.deepEqual(await published(), [hostA.host]);
  assert.equal((await hostA.status()).policy.modelCapacity, 8);

  // A pure status call by an UNREGISTERED observer publishes nothing and inspects
  // the ACTUAL shared aggregate: it sees the shared cap it would be admitted
  // under, never its own unpublished narrower setting.
  const inspected = await hostB.status();
  assert.equal(inspected.policy.modelCapacity, 8, 'an unregistered observer sees the shared cap');
  assert.deepEqual(await published(), [hostA.host], 'status published no local policy');
  assert.equal((await ledger()).policies[hostA.host].config.modelCapacity, 8, 'the registered limits are unchanged');
  assert.equal((await hostA.status()).policy.modelCapacity, 8, "the registered aggregate is unchanged for the other host");

  // Host B really admits: now it participates and its narrower limit binds both.
  assert.equal((await hostB.tryAcquire(request('b-owned'))).granted, true);
  assert.deepEqual(await published(), [hostA.host, hostB.host].sort());
  assert.equal((await hostA.status()).policy.modelCapacity, 2);
  assert.equal((await hostB.status()).policy.modelCapacity, 2);
  const third = await hostA.tryAcquire(request('a-third'));
  assert.deepEqual(third, { granted: false, reason: 'model_capacity' }, 'the aggregate minima bound both hosts');

  // Once B is registered, a live ENABLED change is visible only after it
  // re-publishes: until then its own inspection reports the PUBLISHED cap, and
  // inspection still writes nothing.
  narrow.modelCapacity = 4;
  assert.equal((await hostB.status()).policy.modelCapacity, 2, 'a registered host sees its published cap until refreshPolicy');
  assert.equal((await ledger()).policies[hostB.host].config.modelCapacity, 2, 'inspection published nothing');
  assert.equal((await hostA.status()).policy.modelCapacity, 2, "another host's registered snapshot is untouched");
  // policy publishes before computing limits, so admission already applies the
  // live value; refreshPolicy makes that visible to everyone.
  await hostB.refreshPolicy();
  assert.equal((await ledger()).policies[hostB.host].config.modelCapacity, 4, 'refreshPolicy publishes the live settings');
  assert.equal((await hostB.status()).policy.modelCapacity, 4);
  assert.equal((await hostA.status()).policy.modelCapacity, 4, 'the live change widens the aggregate minima');

  // Disabling B is still only LOCAL until it is published: inspection reports it
  // and changes no registered profile.
  narrow.enabled = false;
  const disabled = await hostB.status();
  assert.equal(disabled.policy.enabled, false);
  assert.equal((await ledger()).policies[hostB.host].config.enabled, true, 'a pure status call never opts a host out');
  assert.equal((await hostA.status()).policy.modelCapacity, 4, 'the registered aggregate minima are untouched');
  // Outstanding ownership - both charges and the durable refused ticket - is
  // reported exactly as it is, by either host.
  const mid = (await hostA.status()).summary;
  assert.equal(mid.claims, 3, 'two admitted effects plus the refused ticket');
  assert.equal(mid.waiting, 1);
  assert.equal(mid.reservedBytes, 2 * MIB, 'outstanding charges survive inspection and a local opt-out');

  // The explicit refreshPolicy opt-out is published as an ABSENCE, so a disabled
  // profile stops narrowing the hosts that still participate.
  await hostB.refreshPolicy();
  assert.equal((await ledger()).policies[hostB.host], undefined, 'opting out is published as an absence, never a disabled profile');
  assert.deepEqual(await published(), [hostA.host]);
  assert.equal((await hostA.status()).policy.modelCapacity, 8, 'the disabled profile is out of the aggregate minima');
  // Widened again for real: the request the narrower limit refused now admits
  // under A's own bound, with every earlier charge preserved.
  assert.equal((await hostA.tryAcquire(request('a-third'))).granted, true);
  const after = (await hostA.status()).summary;
  assert.equal(after.claims, 3);
  assert.equal(after.waiting, 0);
  assert.equal(after.reservedBytes, 3 * MIB, 'the preserved charges are the three admitted effects');
});

// ---------------------------------------------------------------------------
// Regression (7): a status call projects a LATE page from ONE FIFO traversal,
// after its normal transaction - validation and the liveness sweep - has already
// released the shared lock, and every reported reason is exactly the reason that
// ticket's own admission poll returns. No wall-clock latency is asserted: the
// lock-free proof is an exclusive acquisition of the real lock file, which either
// succeeds or deterministically reports EEXIST.
// ---------------------------------------------------------------------------

const projectionConfig = { ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 4, runnerCapacity: 2, storageBytes: 64 * MIB };

test('status projects a late page from one lock-free FIFO traversal that matches admission', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-projection-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const fsSync = require('node:fs');
  const directory = path.join(base, 'resources');
  const lock = path.join(directory, 'transaction.lock');
  const clock = { now: 1_000_000 };
  const governor = new ResourceGovernor(() => projectionConfig, directory, () => clock.now);
  t.after(() => governor.close().catch(() => undefined));
  const tool = index => ({ key: `tool-${String(index).padStart(2, '0')}`, kind: 'tool', lane: 'validation', root: 'root', scope: 'tools', bytes: 0 });
  const storage = { key: 'storage-late', kind: 'storage', lane: 'validation', root: 'root', scope: 'store', bytes: 64 * MIB };
  const runner = { key: 'runner-late', kind: 'runner', lane: 'validation', root: 'root', scope: 'pool', localCapacity: 1, bytes: 0 };
  const blockedModel = { key: 'blocked-model', kind: 'model', lane: 'validation', root: 'root', scope: 'holder-store', model: 'model-a', localCapacity: 1, bytes: 0 };

  // The aggregate bounds are FULL: 1 model + 2 runners are effects, and the model
  // holder's 1 MiB is also what pushes the 64 MiB validation storage ticket over.
  assert.deepEqual(await governor.tryAcquire({ key: 'holder', kind: 'model', lane: 'validation', root: 'root', scope: 'holder-store', model: 'model-a', localCapacity: 8, bytes: MIB }), { granted: true });
  assert.deepEqual(await governor.tryAcquire({ key: 'runner-hold-1', kind: 'runner', lane: 'validation', root: 'root', scope: 'pool-hold-1', localCapacity: 1, bytes: 0 }), { granted: true });
  assert.deepEqual(await governor.tryAcquire({ key: 'runner-hold-2', kind: 'runner', lane: 'validation', root: 'root', scope: 'pool-hold-2', localCapacity: 1, bytes: 0 }), { granted: true });
  // Three temporary tool effects fill the runnable bound, so every tool ticket
  // below is created WAITING - an eligible ticket cannot be granted and still be a
  // ticket. They are released before the page is inspected.
  for (const index of [1, 2, 3]) {
    assert.deepEqual(await governor.tryAcquire({ key: `runnable-hold-${index}`, kind: 'tool', lane: 'validation', root: 'root', scope: 'tools', bytes: 0 }), { granted: true });
  }
  // A blocked OLDER ticket: it keeps waiting, and it must not obstruct younger
  // eligible tickets - the ladder decides each ticket independently.
  assert.deepEqual(await governor.tryAcquire(blockedModel), { granted: false, reason: 'model_capacity' });
  for (let index = 1; index <= 40; index += 1) {
    assert.deepEqual(await governor.tryAcquire(tool(index)), { granted: false, reason: 'runnable_capacity' }, `tool ${index}`);
  }
  assert.deepEqual(await governor.tryAcquire(storage), { granted: false, reason: 'storage' });
  assert.deepEqual(await governor.tryAcquire(runner), { granted: false, reason: 'runner_capacity' });
  // Only the model effect (1) plus three virtually charged eligible tools fill the
  // runnable bound now: tool-01..03 become the oldest eligible contenders and
  // tool-04 onwards must keep waiting.
  for (const index of [1, 2, 3]) {
    await governor.release(`runnable-hold-${index}`);
  }
  const total = (await governor.status()).summary.claims;
  assert.equal(total, 46, '3 effects plus 43 waiting tickets');

  // -------------------------------------------------------------------------
  // The measured call: exactly ONE transaction (the snapshot/validation/sweep),
  // and the whole page decided from ONE traversal that starts with the lock FREE.
  // -------------------------------------------------------------------------
  const realTransaction = governor.transaction.bind(governor);
  const project = governor.waitingDecisions.bind(governor);
  let transactions = 0;
  let projections = 0;
  let unlockedDuringProjection = false;
  governor.transaction = (...args) => { transactions += 1; return realTransaction(...args); };
  governor.waitingDecisions = (...args) => {
    projections += 1;
    // The same exclusive CREATE_NEW a real transaction uses. If the projection
    // still ran under the shared lock, this fails deterministically with EEXIST
    // instead of depending on how fast this machine happens to be.
    const handle = fsSync.openSync(lock, 'wx', 0o600);
    fsSync.closeSync(handle);
    fsSync.rmSync(lock, { force: true });
    unlockedDuringProjection = true;
    return project(...args);
  };
  let late;
  try {
    late = await governor.status(30, 20);
  } finally {
    governor.transaction = realTransaction;
    governor.waitingDecisions = project;
  }
  assert.equal(transactions, 1, 'status takes exactly one ledger transaction');
  assert.equal(projections, 1, 'the whole page is decided by ONE FIFO traversal');
  assert.equal(unlockedDuringProjection, true, 'the projection starts with the shared lock released');
  assert.equal(fsSync.existsSync(lock), false, 'the snapshot transaction left no lock behind');
  assert.equal(late.claims.length, 16, 'a late page of the 46 waiting/owned rows');

  // FIFO order decides each row exactly as its own poll would: every tool past the
  // runnable bound waits for it, the storage ticket waits for its lane budget, and
  // the runner ticket waits for the aggregate runner bound.
  const lateByKey = new Map(late.claims.map(claim => [claim.key, claim]));
  assert.equal(lateByKey.get('storage-late').waitingReason, 'storage');
  assert.equal(lateByKey.get('runner-late').waitingReason, 'runner_capacity');
  const lateTools = late.claims.filter(claim => claim.key.startsWith('tool-'));
  assert.ok(lateTools.length >= 10, 'the late page is mostly queue rows');
  for (const claim of lateTools) {
    assert.equal(claim.state, 'waiting');
    assert.equal(claim.waitingReason, 'runnable_capacity', `${claim.key} waits for the runnable bound`);
  }

  // The same page, and the same reasons, on an unmodified second inspection.
  const first = await governor.status(0, 10);
  const firstByKey = new Map(first.claims.map(claim => [claim.key, claim]));
  assert.equal(firstByKey.get('holder').state, 'active');
  assert.equal(firstByKey.get('holder').waitingReason, undefined, 'an effect is not a waiting decision');
  assert.equal(firstByKey.get('blocked-model').waitingReason, 'model_capacity');
  for (const index of [1, 2, 3]) {
    assert.equal(firstByKey.get(tool(index).key).waitingReason, undefined, 'the oldest eligible tools are grantable');
  }
  assert.equal(firstByKey.get('tool-04').waitingReason, 'runnable_capacity');
  assert.equal(first.summary.reservedBytes, MIB, 'only the model effect is reserved');
  assert.deepEqual((await governor.status(30, 20)).claims.map(claim => [claim.key, claim.waitingReason]),
    late.claims.map(claim => [claim.key, claim.waitingReason]), 'the projection is deterministic');

  // The reported reason IS the reason that ticket's own admission poll returns.
  assert.deepEqual(await governor.tryAcquire(tool(31)), { granted: false, reason: lateByKey.get('tool-31').waitingReason });
  assert.deepEqual(await governor.tryAcquire(storage), { granted: false, reason: 'storage' });
  assert.deepEqual(await governor.tryAcquire(runner), { granted: false, reason: 'runner_capacity' });
  assert.deepEqual(await governor.tryAcquire(blockedModel), { granted: false, reason: 'model_capacity' });
  // `undefined` really means "the oldest eligible contender": its own poll grants.
  assert.deepEqual(await governor.tryAcquire(tool(1)), { granted: true });
});

// ---------------------------------------------------------------------------
// Regression (8): an explicit trusted opt-out withdraws this host's registered
// policy BEFORE any unused limit is read, and preserves outstanding ownership -
// while an enabled refresh keeps validating its limits exactly as before.
// ---------------------------------------------------------------------------

test('an explicit trusted opt-out withdraws the policy before reading unused limits', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-trusted-off-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const state = { config: { ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 4 } };
  const governor = new ResourceGovernor(() => state.config, directory);
  t.after(() => governor.close().catch(() => undefined));
  const policies = async () => (await readLedger(base)).policies;
  const claim = async () => (await readLedger(base)).claims.find(row => row.key === 'owned');
  const request = { key: 'owned', kind: 'tool', lane: 'validation', root: 'root', bytes: MIB };

  assert.deepEqual(await governor.tryAcquire(request), { granted: true });
  await governor.refreshPolicy();
  assert.deepEqual(Object.keys(await policies()), [governor.host], 'the enabled host published its policy');

  // Disabled AND malformed: this host's remaining limits are no longer used, but
  // they are still validated while nothing proves the host opted out.
  state.config = { ...state.config, enabled: false, modelCapacity: 1, runnableCapacity: 1 };
  await assert.rejects(governor.refreshPolicy(), error => error.name === 'ZodError' || /Too small|Invalid input/.test(error.message),
    'the established path still validates every limit it would publish');
  assert.deepEqual(Object.keys(await policies()), [governor.host], 'a rejected refresh changed nothing');

  // The raw trusted opt-out is authoritative: the profile is withdrawn without
  // reading (or validating) those unused limits, and the effect it owns stays.
  await governor.refreshPolicy(() => false);
  assert.equal((await policies())[governor.host], undefined, 'opting out is published as an absence');
  assert.equal((await claim()).state, 'active', 'outstanding ownership is preserved');
  assert.equal((await claim()).bytes, MIB, 'the preserved charge is still durable');
  await governor.refreshPolicy(() => false);
  assert.deepEqual(Object.keys(await policies()), [], 'withdrawing again is a no-op, not an error');

  // An explicit trusted TRUE never bypasses validation: malformed limits are still
  // reported and publish nothing.
  await assert.rejects(governor.refreshPolicy(() => true), error => error.name === 'ZodError' || /Too small|Invalid input/.test(error.message));
  assert.deepEqual(Object.keys(await policies()), []);

  // A reader that cannot answer is a refusal, not an opt-out: the refresh aborts
  // before any write and leaves both the policy and the claim exactly as they are.
  let read = false;
  await assert.rejects(governor.refreshPolicy(() => { read = true; throw Error('settings unavailable'); }), /settings unavailable/);
  assert.equal(read, true, 'the governor really invoked the reader');
  assert.deepEqual(Object.keys(await policies()), [], 'a throwing reader publishes nothing');

  // Default callers keep the established path in both directions.
  state.config = { ...state.config, enabled: true, modelCapacity: 2, runnableCapacity: 4 };
  await governor.refreshPolicy();
  assert.deepEqual(Object.keys(await policies()), [governor.host], 'a valid enabled config publishes');
  assert.equal((await governor.status()).summary.reservedBytes, MIB, 'the preserved charge is still reported');
  state.config = { ...state.config, enabled: false };
  await governor.refreshPolicy();
  assert.deepEqual(Object.keys(await policies()), [], 'a valid disabled config withdraws');
  assert.equal((await claim()).state, 'active');
  await governor.release('owned');
});

// ---------------------------------------------------------------------------
// Regression (9): the broker's own settingsChanged path. A participating window
// that registered and then turned resources OFF with malformed limits keeps its
// aggregate profile out of the shared minima, reports no limit error for it, and
// still reports (and refuses) a malformed ENABLED configuration.
// ---------------------------------------------------------------------------

test('broker settingsChanged withdraws an explicit trusted opt-out with malformed limits', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-broker-off-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  const state = { trusted: true, errors: [], config: { ...resourceDefaults, enabled: true, modelCapacity: 4, runnableCapacity: 8 } };
  const directory = path.join(base, 'resources');
  const broker = new WorkerBroker({
    storage: path.join(base, 'storage'), registry: path.join(base, 'bridges'), roots: [root], identity: 'test',
    provider: {}, settings: () => ({ models: {} }), files: {},
    resources: () => state.config, resourcesEnabled: () => state.trusted, resourceDirectory: directory,
    onChange: () => undefined, onError: message => state.errors.push(message)
  });
  t.after(() => broker.close().catch(() => undefined));
  const governor = broker.resources;
  const policies = async () => (await readLedger(base)).policies;
  const claim = async () => (await readLedger(base)).claims.find(row => row.key === 'owned');

  // The window registered through a governed admission and published its profile;
  // the broker sets this flag on its first governed admission or revocation.
  assert.deepEqual(await governor.tryAcquire({ key: 'owned', kind: 'tool', lane: 'validation', root, bytes: MIB }), { granted: true });
  await governor.refreshPolicy();
  assert.deepEqual(Object.keys(await policies()), [governor.host]);
  broker.resourceUsed = true;

  // Resources are now OFF (`resourcesEnabled` is the raw trusted callback the
  // extension wires to the User setting) while the unused limits are malformed:
  // the profile must be withdrawn and no limit error reported for it.
  Object.defineProperty(state, 'trusted', { value: false, writable: true });
  state.config = { ...state.config, enabled: false, modelCapacity: 1, runnableCapacity: 1, storageBytes: 1 };
  const before = state.errors.length;
  broker.settingsChanged();
  await until(async () => (await policies())[governor.host] === undefined, 5000);
  assert.equal(state.errors.length, before, JSON.stringify(state.errors));
  assert.equal((await claim()).state, 'active', 'the broker-preserved effect is untouched by the opt-out');

  // Trusted again with the same malformed limits: validation is NOT bypassed, it
  // is reported, and nothing is published.
  state.trusted = true;
  broker.settingsChanged();
  await until(() => state.errors.length > before, 5000);
  assert.match(state.errors.at(-1), /Too small|Invalid input|modelCapacity|runnableCapacity|storageBytes/);
  assert.equal((await policies())[governor.host], undefined, 'a malformed enabled config publishes nothing');
  assert.equal((await claim()).state, 'active');

  // Deterministic stale-notification check. The notification is queued BEFORE it
  // can acquire the ledger, and the newer save lands while it waits: an enabled
  // host must never lose its cap because an older notification carried the flag
  // value from its own moment. The gate holds the refresh outside the transaction,
  // so nothing here depends on machine speed.
  state.trusted = false;
  state.config = { ...resourceDefaults, enabled: false, modelCapacity: 4, runnableCapacity: 8 };
  const realTransaction = governor.transaction.bind(governor);
  let queued, release;
  const entered = new Promise(resolve => { queued = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  governor.transaction = async run => { queued(); await gate; return realTransaction(run); };
  try {
    broker.settingsChanged();
    await entered;
    // The newer save: resources are enabled again, with valid limits.
    state.trusted = true;
    state.config = { ...resourceDefaults, enabled: true, modelCapacity: 4, runnableCapacity: 8 };
    release();
    await until(async () => (await policies())[governor.host] !== undefined, 5000);
    assert.equal((await policies())[governor.host].config.enabled, true,
      'the stale notification applied the CURRENT opt-in, not the value it was queued with');
    assert.equal((await claim()).state, 'active', 'the outstanding claim is untouched');
  } finally {
    release();
    governor.transaction = realTransaction;
  }

  // A trusted flag that cannot be read proves nothing: a window with a VALID
  // configuration keeps the profile it already published and reports the failure
  // instead of being guessed into a withdrawal. Closing it settles its refresh.
  const probeState = { errors: [], config: { ...resourceDefaults, enabled: true, modelCapacity: 4, runnableCapacity: 8 } };
  let trusted = true;
  const probe = new WorkerBroker({
    storage: path.join(base, 'probe-storage'), registry: path.join(base, 'probe-bridges'), roots: [root], identity: 'probe',
    provider: {}, settings: () => ({ models: {} }), files: {},
    resources: () => probeState.config, resourcesEnabled: () => { if (!trusted) { throw Error('settings unavailable'); } return trusted; },
    resourceDirectory: directory, onChange: () => undefined, onError: message => probeState.errors.push(message)
  });
  t.after(() => probe.close().catch(() => undefined));
  probe.resourceUsed = true;
  probe.settingsChanged();
  await until(async () => (await policies())[probe.resources.host] !== undefined, 5000);
  assert.deepEqual(probeState.errors, [], 'the readable opt-in published without an error');
  trusted = false;
  probe.settingsChanged();
  await until(() => probeState.errors.some(message => /settings unavailable/.test(message)), 5000);
  assert.match(probeState.errors[0], /settings unavailable/);
  assert.equal((await policies())[probe.resources.host].config.enabled, true,
    'an unreadable opt-in withdraws nothing and publishes nothing');
  assert.equal((await policies())[governor.host] === undefined, false, 'the other window keeps its own profile');
  await probe.close();
  assert.equal((await policies())[probe.resources.host], undefined, 'closing the probe withdrew only its own profile');
  assert.notEqual((await policies())[governor.host], undefined, 'the first window is unaffected');
});

// ---------------------------------------------------------------------------
// Regression (10): the exact 256-store capacity decision and the FIRST pending
// local publication are one exclusive aggregate transaction, decided in that
// order. A definitively refused new store therefore enrolls nothing at all - no
// marker, no row, no claim - while a marker that already exists (pending or
// established) is never removed by a refusal, and a failure AFTER the marker was
// published still keeps it as the recovery fence.
// ---------------------------------------------------------------------------

const STORE_BOUND = 256;

/** One established aggregate namespace whose ledger already holds `count` store rows. */
async function seedLedger(directory, count) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'namespace.json'), JSON.stringify({ schema: 1, kind: 'os-user-resources' }));
  const stores = {};
  for (let index = 0; index < count; index += 1) {
    stores[crypto.createHash('sha256').update(`seed-store-${index}`).digest('hex')] =
      { directory: path.join(path.dirname(directory), `absent-store-${index}`), bytes: 1 };
  }
  await fs.writeFile(path.join(directory, 'ledger.json'), JSON.stringify({ schema: 1, sequence: 0, policies: {}, stores, claims: [] }));
}

/** A plain, physical store directory with one small data file. */
async function storeAt(base, name) {
  const at = path.join(base, name);
  await fs.mkdir(at);
  await fs.writeFile(path.join(at, 'state.bin'), Buffer.alloc(1024, 3));
  return at;
}

/** The local registration state of one store, or its filesystem error code. */
const markerState = async at => fs.readFile(path.join(at, 'resource-store.json'), 'utf8')
  .then(text => JSON.parse(text).state, error => error.code);
const markerText = async at => fs.readFile(path.join(at, 'resource-store.json'), 'utf8')
  .then(text => text, error => error.code);

test('a refused 257th store publishes no local marker on either enrollment path', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-capacity-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  await seedLedger(directory, STORE_BOUND);
  const governor = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true }), directory);
  t.after(() => governor.close().catch(() => undefined));

  // `account` is the first-enrollment path of a rollover/checkpoint caller.
  const measured = await storeAt(base, 'measured');
  await assert.rejects(governor.account(measured, () => storageUsage(measured)),
    error => error.code === 'resource_capacity' && /256 stores are registered/.test(error.message));
  assert.equal(await markerState(measured), 'ENOENT', 'a refused first enrollment writes no pending marker');
  await assert.rejects(fs.lstat(path.join(measured, 'resource-store.json.namespace')),
    error => error.code === 'ENOENT', 'and no local namespace marker');
  let ledger = await readLedger(base);
  assert.equal(Object.keys(ledger.stores).length, STORE_BOUND, 'the refused store added no row');
  assert.equal(ledger.sequence, 0, 'the refused store did not even order itself');
  assert.deepEqual(ledger.claims, []);

  // `withStoreWrite` is the durable write path, and its action never runs.
  const written = await storeAt(base, 'written');
  let entered = false;
  await assert.rejects(governor.withStoreWrite(written, async () => {
    entered = true;
    return 'value';
  }, () => storageUsage(written)), error => error.code === 'resource_capacity' && /256 stores are registered/.test(error.message));
  assert.equal(entered, false, 'a refused enrollment never enters the caller action');
  assert.equal(await markerState(written), 'ENOENT', 'the write path writes no pending marker either');
  ledger = await readLedger(base);
  assert.equal(Object.keys(ledger.stores).length, STORE_BOUND);
  assert.deepEqual(ledger.claims, []);
  assert.equal(await governor.hasStore(written), false,
    'a refused store does not claim local participation, so legacy writes stay independent');
});

test('the 256th store still enrolls while the 257th leaves nothing behind', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-capacity-edge-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  await seedLedger(directory, STORE_BOUND - 1);
  const governor = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true }), directory);
  t.after(() => governor.close().catch(() => undefined));

  // Exactly one slot is left: the 256th store enrolls through the pending marker
  // and completes as registered.
  const last = await storeAt(base, 'last');
  await governor.account(last, () => storageUsage(last));
  assert.equal(await markerState(last), 'registered');
  assert.equal(await fs.readFile(path.join(last, 'resource-store.json.namespace'), 'utf8'),
    JSON.stringify({ schema: 1, kind: 'resource-store' }), 'the confirmed identity is complete');
  assert.equal(Object.keys((await readLedger(base)).stores).length, STORE_BOUND);

  // The bound is now exactly full: the next NEW store is refused and publishes
  // nothing, while the established store keeps enrolling normally.
  const overflow = await storeAt(base, 'overflow');
  await assert.rejects(governor.withStoreWrite(overflow, async () => 'never', () => 1),
    error => error.code === 'resource_capacity');
  assert.equal(await markerState(overflow), 'ENOENT');
  // A store that is already registered is an UPDATE: never refused by the bound,
  // and its marker is never rewritten as pending.
  assert.equal(await governor.withStoreWrite(last, async () => 'updated', () => storageUsage(last)), 'updated');
  assert.equal(await markerState(last), 'registered');
  assert.equal(Object.keys((await readLedger(base)).stores).length, STORE_BOUND, 'an update adds no store');
});

test('a refused enrollment never removes an existing pending or established marker', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-capacity-marker-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  await seedLedger(directory, STORE_BOUND);
  const governor = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true }), directory);
  t.after(() => governor.close().catch(() => undefined));
  const registration = (state, scope, physical) => JSON.stringify({
    schema: 1, kind: 'resource-store', directory, state, scope, physical
  });

  // An INTERRUPTED first enrollment: the pending marker survived a crash before
  // its ledger row, so it is ambiguous and must never be discarded.
  const pending = await storeAt(base, 'pending');
  const pendingText = registration('pending', pending, await fs.realpath(pending));
  await fs.writeFile(path.join(pending, 'resource-store.json'), pendingText);
  // An ESTABLISHED registration whose row is gone: equally untouchable.
  const established = await storeAt(base, 'established');
  const establishedText = registration('registered', established, await fs.realpath(established));
  await fs.writeFile(path.join(established, 'resource-store.json'), establishedText);

  await assert.rejects(governor.account(pending, () => storageUsage(pending)), error => error.code === 'resource_capacity');
  await assert.rejects(governor.withStoreWrite(pending, async () => 'never', () => 1), error => error.code === 'resource_capacity');
  assert.equal(await markerText(pending), pendingText, 'the ambiguous pending marker is preserved byte for byte');
  await assert.rejects(fs.lstat(path.join(pending, 'resource-store.json.namespace')), error => error.code === 'ENOENT',
    'a refused attempt never confirms an ambiguous marker');

  await assert.rejects(governor.account(established, () => storageUsage(established)), error => error.code === 'resource_capacity');
  await assert.rejects(governor.withStoreWrite(established, async () => 'never', () => 1), error => error.code === 'resource_capacity');
  assert.equal(await markerText(established), establishedText, 'the established marker is preserved byte for byte');
  const ledger = await readLedger(base);
  assert.equal(Object.keys(ledger.stores).length, STORE_BOUND, 'neither refused attempt added a store row');
  assert.deepEqual(ledger.claims, []);
  // The durable markers are exactly what keeps these stores fenced participants:
  // their legacy writes are still routed through enrollment, never around it.
  assert.equal(await governor.hasStore(pending), true);
  assert.equal(await governor.hasStore(established), true);
});

test('a concurrent first enrollment never downgrades a registration another attempt completed', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-capacity-concurrent-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const storage = require(path.join(buildDir, 'storage'));
  const a = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true }), directory);
  const b = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true }), directory);
  t.after(() => a.close().catch(() => undefined));
  t.after(() => b.close().catch(() => undefined));
  const at = await storeAt(base, 'store');

  // B captures "no local marker yet" BEFORE either host takes the aggregate
  // lock, then waits. That is exactly the interleaving in which its captured
  // state is stale by the time its own publication runs.
  const realRegister = b.registerStore.bind(b);
  let captured, resume;
  const capturedReady = new Promise(resolve => { captured = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  b.registerStore = async target => {
    const registered = await realRegister(target);
    captured();
    await gate;
    return registered;
  };
  const pendingB = b.account(at, () => storageUsage(at)).then(value => ({ value }), error => ({ error }));
  await capturedReady;
  assert.equal(await markerState(at), 'ENOENT', "B's capture really happened before any marker existed");

  // A completes the FIRST enrollment of that same store.
  await a.account(at, () => storageUsage(at));
  const established = await markerText(at);
  assert.equal(JSON.parse(established).state, 'registered');
  assert.equal(Object.keys((await readLedger(base)).stores).length, 1);

  // B resumes and its OWN ledger commit is refused: the stale capture must not
  // republish the identity - and must never downgrade A's completion.
  const realAtomicWrite = storage.atomicWrite;
  let injected = 0;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (path.basename(file) === 'ledger.json') {
      injected += 1;
      throw Error('injected ledger commit failure');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  try {
    resume();
    const outcome = await pendingB;
    assert.match(String(outcome.error?.message ?? outcome.value), /injected ledger commit failure/);
  } finally {
    storage.atomicWrite = realAtomicWrite;
    resume();
  }
  assert.equal(injected, 1, 'only the resumed attempt was refused');
  assert.equal(await markerText(at), established, "A's completed registration is preserved byte for byte");
  assert.equal(JSON.parse(await markerText(at)).state, 'registered', 'never downgraded to pending');
  assert.equal(await fs.readFile(path.join(at, 'resource-store.json.namespace'), 'utf8'),
    JSON.stringify({ schema: 1, kind: 'resource-store' }), "A's namespace identity survives");
  const ledger = await readLedger(base);
  assert.equal(Object.keys(ledger.stores).length, 1, 'the refused attempt added no store row');
  assert.deepEqual(ledger.claims, []);
  // The durable registered marker is still proof of participation on both hosts.
  assert.equal(await a.hasStore(at), true);
  assert.equal(await b.hasStore(at), true);
});

test('a failure after the pending marker is published keeps it as the recovery fence', { timeout: 20000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-capacity-fence-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources');
  const governor = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true }), directory);
  t.after(() => governor.close().catch(() => undefined));
  const storage = require(path.join(buildDir, 'storage'));
  const at = await storeAt(base, 'store');

  // Establish the aggregate first, so the injection below can only hit the
  // ledger commit of the attempt under test (`status` never creates one).
  await governor.refreshPolicy();
  const realAtomicWrite = storage.atomicWrite;
  let injected = 0;
  // The commit of THIS admission is the first ledger publication after this
  // store's pending marker exists; every earlier transaction (the warm-up and the
  // identity resolution) publishes while no marker is there yet.
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (path.basename(file) === 'ledger.json'
      && await fs.lstat(path.join(at, 'resource-store.json')).then(() => true, () => false)) {
      injected += 1;
      throw Error('injected ledger commit failure');
    }
    return realAtomicWrite(file, text, mode, beforeRename);
  };
  let ran = false;
  try {
    await assert.rejects(governor.withStoreWrite(at, async () => {
      ran = true;
      return 'never';
    }, () => 1), /injected ledger commit failure/);
  } finally {
    storage.atomicWrite = realAtomicWrite;
  }
  assert.equal(injected, 1, 'the commit really was the failing step');
  assert.equal(ran, false, 'no effect was entered before the commit');
  assert.equal(await markerState(at), 'pending', 'the published marker survives as the fence');
  assert.equal(Object.keys((await readLedger(base)).stores).length, 0, 'no ledger row was published');
  await assert.rejects(fs.lstat(path.join(at, 'resource-store.json.namespace')), error => error.code === 'ENOENT');
  assert.equal(await governor.hasStore(at), true, 'the fenced store still participates');

  // Retrying the same store resumes exactly that fence: the marker completes and
  // the row is published by ONE attempt.
  assert.equal(await governor.withStoreWrite(at, async () => 'committed', () => 1), 'committed');
  assert.equal(await markerState(at), 'registered');
  const ledger = await readLedger(base);
  assert.equal(Object.keys(ledger.stores).length, 1);
  assert.equal(ledger.stores[Object.keys(ledger.stores)[0]].write, undefined, 'the checkpoint fence cleared after its own sample');
});

test('an opted-out legacy scope survives a refused first enrollment', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-capacity-optout-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  const directory = path.join(base, 'resources');
  await seedLedger(directory, STORE_BOUND);
  const { defaults } = require(path.join(buildDir, 'engine'));
  const model = { id: 'probe-model', name: 'probe', maxTokens: 1000 };
  const errors = [];
  const provider = {
    models: async () => [model], countTokens: async () => 10,
    async *stream() { yield { type: 'text', text: 'done' }; }
  };
  const broker = new WorkerBroker({
    storage: path.join(base, 'storage'), registry: path.join(base, 'bridges'), roots: [root], identity: 'probe', provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { numSessions: 4 } } }),
    taskBoardEnabled: () => true, isolatedViewsEnabled: () => true,
    resources: () => ({ ...resourceDefaults, enabled: false }), resourceDirectory: directory,
    files: { canWrite: () => true, allowShell: () => true, approveCommand: async () => true },
    onChange: () => undefined, onError: message => errors.push(message)
  });
  t.after(() => broker.close().catch(() => undefined));
  await broker.start();
  const local = broker.local.get(root);
  const call = async (name, args = {}) => unpack(await broker.invoke(root, name, args));
  const storeDir = local.store.directory;

  try {
    const team = await call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
    assert.equal(await markerState(storeDir), 'ENOENT', 'an opted-out legacy store starts unregistered');

    // The 257th store is refused at its first enrollment, and it enrolls nothing.
    const refused = await call('subagent_metadata_rollover',
      { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 0 }).then(value => ({ value }), error => ({ error }));
    assert.equal(refused.error?.code, 'resource_capacity', JSON.stringify(refused));
    assert.equal(await markerState(storeDir), 'ENOENT', 'the refused enrollment left no pending marker');
    assert.equal(Object.keys((await readLedger(base)).stores).length, STORE_BOUND, 'and no store row');
    assert.equal(broker.resourceUsed, false, 'a refused enrollment does not make this window a participant');

    // The same scope keeps its original legacy behavior: the refused marker can
    // no longer route its durable write back into that rejection.
    const worker = await call('subagent_spawn', { requestId: 'legacy-1', task: 'legacy checkpoint', model: model.id });
    assert.ok(worker.id, JSON.stringify(worker));
    assert.equal(local.store.list().length, 1, 'the legacy checkpoint was written');
    assert.equal(await markerState(storeDir), 'ENOENT', 'the legacy write enrolled nothing either');
    assert.equal(Object.keys((await readLedger(base)).stores).length, STORE_BOUND);
    assert.deepEqual(errors, []);
  } finally {
    await broker.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Regression (11): a retained drain is OWNED until its exact store's sample
// commits and accounts for it, and the retry that keeps it progressing is
// RATE-capped - never attempt-capped.
//
// Two reproduced stalls:
//   `.test-build/r10-foreground-drain-probe.cjs` - after ONE failed drain
//     publication, a foreground `withStorage` retry published that drain and
//     dropped the retained entry, then its own sample failed: the scheduled pass
//     had nothing left to retry, so a live cross-host waiter stayed quarantined
//     and only a manual sample of the exact store advanced it.
//   `.test-build/h2-drain-budget-exhaustion-probe.cjs` - the old fixed 24-attempt
//     cutoff ended the owner's retries after ~39.5 s of publication failures, so
//     even with the fault cleared a live polling cross-host ticket could not
//     advance until an unrelated same-store operation happened to run.
// ---------------------------------------------------------------------------

/**
 * Capture the governor's ONE coalesced retry timer instead of waiting for its real
 * backoff: each scheduling call records the callback, the delay it asked for and
 * the fact that it was unref'd, so a test can drive an arbitrary number of rounds
 * deterministically and in milliseconds. Nothing else in the process is affected -
 * the global timer factory is swapped only inside the governor's own synchronous
 * scheduling call, and no captured callback ever fires on its own.
 */
function captureRetryTimers(t, governor) {
  const realSetTimeout = global.setTimeout;
  const queued = [];
  const realSchedule = governor.scheduleRetainedDrains.bind(governor);
  governor.scheduleRetainedDrains = () => {
    global.setTimeout = (callback, milliseconds, ...args) => {
      if (typeof milliseconds !== 'number' || milliseconds < 50) {
        return realSetTimeout(callback, milliseconds, ...args);
      }
      const timer = { delay: milliseconds, unrefs: 0, callback, unref() { timer.unrefs += 1; return timer; } };
      queued.push(timer);
      return timer;
    };
    try {
      return realSchedule();
    } finally {
      global.setTimeout = realSetTimeout;
    }
  };
  t.after(() => { governor.scheduleRetainedDrains = realSchedule; });
  return {
    /** The ONE pending retry this governor owns, once its scheduler left it. */
    async next() {
      await until(() => queued.length > 0, 5000);
      assert.equal(queued.length, 1, 'exactly ONE coalesced retry timer is pending');
      return queued.shift();
    }
  };
}

test('a foreground drain-only pass keeps the exact retry entry owned when its own sample fails', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor, lifecycle } = await storageFixture(t, 'drain-foreground-sample');
  const faults = drainFaults(t);
  // A waiter of ANOTHER host over the same ledger: its own poll observes the fence,
  // but it may never publish or sample on behalf of this governor's claim.
  const waiter = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => waiter.close().catch(() => undefined));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const retries = captureRetryTimers(t, governor);
  const request = (key, bytes) => ({ key, kind: 'storage', root, bytes, lane: 'work', store: storeDir });
  const runs = { owner: 0, waiter: 0, foreground: 0 };
  await governor.account(storeDir, () => storageUsage(storeDir));
  const owner = await governor.acquire(request('storage:owner', 32 * MIB), undefined, undefined, false);
  // The owner's effect really finished while it still holds its permit.
  runs.owner += 1;
  await fs.writeFile(path.join(root, 'owner-effect.txt'), 'one disposable effect');
  const pending = waiter.acquire(request('storage:waiter', 32 * MIB), controller.signal, undefined, true)
    .then(permit => { runs.waiter += 1; return { permit }; }, error => ({ error }));
  // Exactly ONE sample of the exact store fails: the FOREGROUND one.
  const realAccount = governor.account.bind(governor);
  let failed = 0;
  governor.account = async (directory, measure) => {
    if (!failed && path.resolve(directory) === path.resolve(storeDir)) {
      failed += 1;
      return realAccount(directory, async () => { throw Error('injected foreground measurement failure'); });
    }
    return realAccount(directory, measure);
  };
  t.after(() => { governor.account = realAccount; });
  try {
    await until(async () => (await governor.status()).claims.some(claim => claim.state === 'waiting'), 5000);
    faults.armed = 1;
    await assert.rejects(owner.drain({ retain: true }), /injected pre-publication drain failure/);
    assert.equal(governor.retainedDrains.size, 1, 'the failed publication retained its exact claim');

    // The foreground drain-only pass publishes that exact drain, and the sample it
    // owes right afterwards fails.
    await assert.rejects(lifecycle.withStorage(MIB, async () => { runs.foreground += 1; }),
      /injected foreground measurement failure/);
    assert.equal(failed, 1, 'the injected failure really was the foreground sample');
    assert.equal(runs.foreground, 0, 'the foreground action never ran');
    // The regression: the entry is STILL owned - the drain was only published, its
    // exact claim was never accounted for, so dropping it would strand the fence.
    assert.equal(governor.retainedDrains.size, 1,
      'a foreground drain-only pass never drops the entry its own sample still owes');
    const fenced = await readLedger(base);
    const [drained] = fenced.claims.filter(claim => claim.state === 'drained');
    assert.ok(drained, 'the foreground pass really published the KNOWN drain');
    assert.equal(drained.bytes, 32 * MIB);
    assert.equal(fenced.stores[drained.store].uncertain, true, 'the fence outlives the failed sample');
    assert.equal(runs.waiter, 0, 'nothing is admitted from a fenced store');

    // The owner's own next round - no new request and no foreign help - samples the
    // exact store, and THAT commit settles the entry and admits the live waiter.
    const timer = await retries.next();
    timer.callback();
    const granted = await bounded(pending, 15000);
    assert.ok(granted.lease?.permit, JSON.stringify(granted.lease ?? granted.error ?? granted));
    assert.equal(runs.waiter, 1, 'the queued effect ran exactly once');
    assert.equal(runs.owner, 1, 'the finished owner effect is never run again');
    assert.equal(governor.retainedDrains.size, 0, 'the committing sample settled the exact entry');
    const recovered = await readLedger(base);
    assert.equal(recovered.claims.some(claim => claim.state === 'drained'), false);
    assert.equal(recovered.stores[drained.store].uncertain ?? false, false, 'that sample cleared the fence');
    await granted.lease.permit.release();
    assert.deepEqual((await governor.status()).claims, []);
  } finally {
    controller.abort();
    await Promise.allSettled([pending]);
    await owner.release().catch(() => undefined);
  }
});

test('the capped retry rate keeps a retained drain progressing past 24 failed rounds for a live cross-host waiter', { timeout: 30000 }, async t => {
  const { base, root, storeDir, config, governor } = await storageFixture(t, 'queued-drain-rate');
  const faults = drainFaults(t);
  const waiter = new ResourceGovernor(config, path.join(base, 'resources'));
  t.after(() => waiter.close().catch(() => undefined));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const retries = captureRetryTimers(t, governor);
  const request = (key, bytes) => ({ key, kind: 'storage', root, bytes, lane: 'work', store: storeDir });
  await governor.account(storeDir, () => storageUsage(storeDir));
  const owner = await governor.acquire(request('storage:owner', 32 * MIB), undefined, undefined, false);
  // The owner's effect really finished while it still holds its permit.
  let ownerEffects = 1;
  let runs = 0;
  const pending = waiter.acquire(request('storage:waiter', 32 * MIB), controller.signal, undefined, true)
    .then(permit => { runs += 1; return { permit }; }, error => ({ error }));
  // More rounds than the 24 attempts the old fixed cutoff allowed.
  const failedRounds = 26;
  try {
    await until(async () => (await governor.status()).claims.some(claim => claim.state === 'waiting'), 5000);
    faults.armed = 1 + failedRounds;
    await assert.rejects(owner.drain({ retain: true }), /injected pre-publication drain failure/);
    const delays = [];
    for (let round = 0; round < failedRounds; round += 1) {
      const timer = await retries.next();
      delays.push(timer.delay);
      assert.ok(timer.unrefs >= 1, 'every retry timer is unref\u2019d, so it never keeps a host alive');
      timer.callback();
      await until(() => governor.drainRound === undefined, 10000);
    }
    assert.equal(faults.injected, 1 + failedRounds, 'every publication of these rounds really failed');
    assert.equal(faults.armed, 0, 'the injected fault is cleared once those rounds are spent');
    assert.ok(delays.length > 24, `the scheduler kept retrying past the old fixed cap: ${delays.length}`);
    assert.deepEqual(delays.slice(-3), [2000, 2000, 2000],
      `the retry backoff saturates at the existing 2 s cap: ${delays.join(',')}`);
    assert.equal(governor.retainedDrains.size, 1, 'the exact obligation is still owned after every failed round');

    // Fail-closed the whole time: the finished effect is still the ACTIVE charge,
    // no drain row was published, and no queued effect was admitted.
    const unpublished = await readLedger(base);
    assert.equal(unpublished.claims.filter(claim => claim.state === 'active').length, 1,
      'the finished effect keeps its conservative charge');
    assert.equal(unpublished.claims.some(claim => claim.state === 'drained'), false, 'nothing was published');
    assert.equal(runs, 0, 'no queued effect ran while the drain stayed unpublished');
    assert.equal(ownerEffects, 1, 'the finished effect was never re-run by any retry');

    // The cross-host ticket stays LIVE with no new owning request: its own poll keeps
    // refreshing its liveness while the owner keeps retrying at the capped rate.
    const before = (await governor.status()).claims.find(claim => claim.key === 'storage:waiter');
    await until(async () => (await governor.status()).claims.find(claim => claim.key === 'storage:waiter')?.heartbeat
      > before.heartbeat, 5000);
    const live = (await governor.status()).claims.find(claim => claim.key === 'storage:waiter');
    assert.equal(live.state, 'waiting');
    assert.equal(live.sequence, before.sequence, 'it kept its own queue position the whole time');

    // ONE more round of the SAME scheduler is enough now that the fault is gone: it
    // publishes the drain and its exact store's sample reclaims it, so the waiter
    // advances with no new admission, store reopen or operator action.
    const timer = await retries.next();
    assert.equal(timer.delay, 2000, 'a persistent failure is retried at the cap, never abandoned');
    timer.callback();
    const granted = await bounded(pending, 15000);
    assert.ok(granted.lease?.permit, JSON.stringify(granted.lease ?? granted.error ?? granted));
    assert.equal(runs, 1, 'the queued effect ran exactly once, after the fault cleared');
    assert.equal(ownerEffects, 1, 'the finished owner effect was never re-run');
    assert.equal(governor.retainedDrains.size, 0, 'the committing sample settled the exact entry');
    const admitted = await readLedger(base);
    assert.equal(admitted.claims.some(claim => claim.state === 'drained'), false);
    assert.equal(Object.values(admitted.stores)[0].uncertain ?? false, false, 'the exact store is healthy again');
    await granted.lease.permit.release();
    assert.deepEqual((await governor.status()).claims, []);
  } finally {
    controller.abort();
    await Promise.allSettled([pending]);
    await owner.release().catch(() => undefined);
  }
});

test('a healthy sample of one store never settles the retained drain of another whose row aged out', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-recovery-two-stores-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const storeA = path.join(base, 'store-a');
  const storeB = path.join(base, 'store-b');
  await fs.mkdir(root);
  await Promise.all([fs.mkdir(storeA), fs.mkdir(storeB)]);
  await fs.writeFile(path.join(storeA, 'state.bin'), Buffer.alloc(4096, 7));
  await fs.writeFile(path.join(storeB, 'state.bin'), Buffer.alloc(4096, 5));
  const clock = { now: 4_000_000 };
  const governor = new ResourceGovernor(() => ({ enabled: true, modelCapacity: 8, runnableCapacity: 16, runnerCapacity: 4,
    storageBytes: 64 * MIB, serviceReserve: 1 }), path.join(base, 'resources'), () => clock.now);
  t.after(() => governor.close().catch(() => undefined));
  const faults = drainFaults(t);
  const request = (key, store) => ({ key, kind: 'storage', root, bytes: 16 * MIB, lane: 'work', store });

  await governor.account(storeA, () => storageUsage(storeA));
  await governor.account(storeB, () => storageUsage(storeB));
  const permit = await governor.acquire(request('storage:a', storeA), undefined, undefined, false);
  // A's effect really finished; only its drain publication fails.
  faults.armed = 1;
  await assert.rejects(permit.drain({ retain: true }), /injected pre-publication drain failure/);
  assert.equal(governor.retainedDrains.size, 1);

  // A drain-only retry publishes A's KNOWN drain, and - because A's exact claim has
  // not been accounted for yet - keeps its retry obligation owned.
  assert.deepEqual(await governor.retryRetainedDrains(storeA), []);
  assert.equal(governor.retainedDrains.size, 1, 'publishing the drain alone settles nothing');
  const published = await readLedger(base);
  const drained = published.claims.find(claim => claim.key === 'storage:a');
  assert.equal(drained?.state, 'drained');
  assert.equal(published.stores[drained.store].uncertain, true, 'A stays fenced until its own sample');

  // A's drained row ages out on its own: the retention sweep retires it in ANY
  // transaction, without sampling A, so its fence and its retry are all that is left.
  clock.now += DRAINED_TICKET_RETENTION_MS + 1;
  assert.deepEqual((await governor.status()).claims, [], 'the aged drained row was retired by the sweep');

  // A healthy sample of ANOTHER store commits successfully, and that publication
  // must never settle A: A's claim row is gone for an unrelated reason and A's own
  // fence is still quarantined, so its retry is the only thing that can clear it.
  await governor.account(storeB, () => storageUsage(storeB));
  assert.equal(governor.retainedDrains.size, 1,
    "another store's committing sample never settles this exact store's obligation");
  const afterB = await readLedger(base);
  assert.equal(afterB.stores[drained.store].uncertain, true, "A's own fence is untouched by B's sample");
  assert.equal(afterB.stores[drained.store].accounting, 'quarantine');

  // B's sample did not resurrect or drop anything else, and A still cannot admit.
  await assert.rejects(governor.acquire(request('storage:a-retry', storeA), undefined, undefined, false),
    error => error.code === 'resource_busy' && /storage|quarantine/.test(error.message),
    'A stays fail-closed until its own exact store is sampled');

  // Sampling A itself is what accounts for A: its commit clears the fence and
  // settles exactly its own entry.
  await governor.account(storeA, () => storageUsage(storeA));
  assert.equal(governor.retainedDrains.size, 0, "A's committing sample settled its own entry");
  const afterA = await readLedger(base);
  assert.equal(afterA.stores[drained.store].uncertain ?? false, false, "A's exact sample cleared its fence");
  const readmitted = await governor.acquire(request('storage:a-after', storeA), undefined, undefined, false);
  await readmitted.release();
  assert.deepEqual((await governor.status()).claims, []);
});

// ---------------------------------------------------------------------------
// Regression (13): an ORDERLY shutdown of the host that OWNS the store.
//
// Confirmed finding (`.test-build/probe-close-fence.cjs` and
// `probe-close-fence-c.cjs`): after ONE temporary drain-publication (or
// post-publication sample) failure whose fault had already cleared, closing
// BEFORE the coalesced retry fired cancelled the timer, did a drain-only pass,
// dropped the owner - and left the durable GLOBAL store fence behind. Nothing was
// left that could sample it, so a live request of ANOTHER host stayed quarantined
// until the closed project was reopened, although the effect was known drained and
// the store's own I/O was healthy.
//
// `WorkerBroker.close()` now keeps each exact store exclusively owned until the
// aggregate shutdown has sampled it: one coalesced publication+sample pass over
// those exact stores only, before their owner locks are released, and no second
// drain-only pass that could publish a new unresolved fence after teardown.
// ---------------------------------------------------------------------------

/** A real broker over one root with resources enabled, plus the other host's dirs. */
async function brokerFixture(t, name) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `resource-recovery-${name}-`));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const otherRoot = path.join(base, 'other-project');
  const waiterStore = path.join(base, 'waiter-store');
  await fs.mkdir(root);
  await fs.mkdir(otherRoot);
  await fs.mkdir(waiterStore);
  await fs.writeFile(path.join(waiterStore, 'state.bin'), Buffer.alloc(2048, 3));
  // 64 MiB aggregate: the work lane is 56 MiB, so two 32 MiB effects cannot overlap.
  const config = () => ({ ...resourceDefaults, enabled: true, storageBytes: 64 * MIB });
  const directory = path.join(base, 'resources');
  const { defaults } = require(path.join(buildDir, 'engine'));
  const model = { id: 'probe-model', name: 'probe', maxTokens: 1000 };
  const errors = [];
  const provider = {
    models: async () => [model], countTokens: async () => 10,
    async *stream() { yield { type: 'text', text: 'done' }; }
  };
  const broker = new WorkerBroker({
    storage: path.join(base, 'storage'), registry: path.join(base, 'bridges'), roots: [root], identity: 'probe', provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { numSessions: 4 } } }),
    taskBoardEnabled: () => true, isolatedViewsEnabled: () => true,
    resources: config, resourceDirectory: directory,
    files: { canWrite: () => true, allowShell: () => true, approveCommand: async () => true },
    onChange: () => undefined, onError: message => errors.push(message)
  });
  t.after(() => broker.close().catch(() => undefined));
  await broker.start();
  const local = broker.local.get(root);
  assert.ok(local, 'the root owns its store');
  return { base, root, otherRoot, waiterStore, directory, config, broker, local, governor: broker.resources, errors };
}

test('an orderly broker close samples its exact owned store, so no drain fence survives and a live cross-host waiter is admitted', { timeout: 60000 }, async t => {
  const { base, root, otherRoot, waiterStore, directory, config, broker, local, governor, errors } = await brokerFixture(t, 'broker-close-owned');
  const { SessionStore } = require(path.join(buildDir, 'storage'));
  const faults = drainFaults(t);
  // The governor's ONE coalesced retry is captured and NEVER fired, so the shutdown
  // below really happens BEFORE the scheduled retry.
  const retries = captureRetryTimers(t, governor);
  const storeDir = local.store.directory;
  // The waiter is a DIFFERENT host over the same OS-user ledger, with its own root
  // and store: it only ever polls its own eligibility.
  const waiter = new ResourceGovernor(config, directory);
  t.after(() => waiter.close().catch(() => undefined));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const request = (key, store) => ({ key, kind: 'storage', root: store === storeDir ? root : otherRoot, bytes: 32 * MIB, lane: 'work', store });
  const runs = { owner: 0, waiter: 0 };

  // Control sample: this exact store is healthy before anything happens.
  await governor.account(storeDir, () => storageUsage(storeDir));
  let releaseAction; const gate = new Promise(resolve => { releaseAction = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const ownerRun = local.lifecycle.withStorage(32 * MIB, async () => {
    runs.owner += 1;
    await fs.writeFile(path.join(root, 'owner-effect.txt'), 'one disposable effect');
    entered();
    await gate;
    return 'action-completed';
  }, undefined, 'work', false).then(value => ({ value }), error => ({ error }));
  let pending;
  try {
    await started;
    assert.equal(runs.owner, 1, 'the owner effect is really in flight while it holds its 32 MiB permit');
    // The waiter is ALREADY LIVE and polling when the fault and the shutdown happen.
    pending = waiter.acquire(request('storage:waiter', waiterStore), controller.signal, undefined, true)
      .then(permit => { runs.waiter += 1; return { permit }; }, error => ({ error }));
    await until(async () => (await governor.status()).claims.some(claim => claim.key === 'storage:waiter' && claim.state === 'waiting'), 5000);
    assert.equal(runs.waiter, 0, 'the cross-host waiter is queued, not admitted');

    // The ONLY failure: the ledger publication immediately before the known drain
    // commits. It is one-shot, so it has already cleared when the host closes.
    faults.armed = 1;
    releaseAction();
    const failed = await ownerRun;
    assert.match(String(failed.error), /injected pre-publication drain failure/);
    assert.equal(faults.injected, 1, 'exactly ONE drain publication really failed');
    assert.equal(faults.armed, 0, 'the injected fault is already cleared');
    assert.equal(runs.owner, 1, 'the finished effect is never run again');
    let ledger = await readLedger(base);
    assert.equal(ledger.claims.filter(claim => claim.state === 'active').length, 1, 'fail-closed: the effect is still charged');
    assert.equal(ledger.claims.some(claim => claim.state === 'drained'), false, 'nothing was published yet');
    assert.equal(governor.retainedDrains.size, 1, 'the finished effect is retained as an owned obligation');
    const retry = await retries.next();
    assert.ok(retry.delay >= 50 && retry.unrefs >= 1, 'the pending retry is rate-shaped and unref\u2019d');
    assert.equal(governor.drainRetry, retry, 'the shutdown below really happens before this retry');

    // Every sample of that exact store during the shutdown is counted, and each one
    // proves the exclusive owner is still held: no other host could open the store.
    const samples = [];
    const realAccount = governor.account.bind(governor);
    governor.account = async (directory, measure) => {
      if (path.resolve(directory) === path.resolve(storeDir)) {
        const contender = new SessionStore(storeDir);
        try {
          samples.push(await contender.open().then(() => 'adopted', () => 'locked'));
        } finally {
          await contender.close().catch(() => undefined);
        }
      }
      return realAccount(directory, measure);
    };
    t.after(() => { governor.account = realAccount; });

    // THE REGRESSION: an orderly shutdown taken before the retry fires.
    await broker.close();
    assert.deepEqual(errors, []);
    ledger = await readLedger(base);
    const fenced = Object.values(ledger.stores).find(store => path.resolve(store.directory) === path.resolve(storeDir));
    assert.ok(fenced, 'the exact store is still registered');
    assert.equal(fenced.uncertain ?? false, false, 'the shutdown sample committed: NO fence survives the close');
    assert.equal(fenced.accounting, undefined);
    assert.equal(fenced.write, undefined);
    assert.equal(ledger.claims.some(claim => claim.state === 'drained'), false, 'the drained row was reclaimed, never left behind');
    assert.equal(ledger.claims.filter(claim => claim.host === governor.host).length, 0, 'no claim of the closed host survives');
    assert.equal(ledger.policies[governor.host], undefined, 'the closed host left the ledger');
    assert.deepEqual(samples, ['locked'],
      'ONE final sample of that exact store, taken while its exclusive owner was still held');
    assert.equal(governor.retainedDrains.size, 0, 'the committing sample settled the exact obligation');
    assert.equal(governor.drainRetry, undefined, 'no retry timer survives the close');
    assert.equal(governor.drainRound, undefined, 'no round survives the close');

    // No post-close replay: firing the pre-close retry callback samples nothing and
    // publishes nothing, because the obligation was settled and `closing` refuses.
    retry.callback();
    await new Promise(resolve => { setTimeout(resolve, 30).unref(); });
    assert.equal(samples.length, 1, 'the captured pre-close retry never sampled the exact store again');
    const quiet = await readLedger(base);
    assert.equal(quiet.claims.some(claim => claim.state === 'drained'), false);
    assert.equal(Object.values(quiet.stores).find(store => path.resolve(store.directory) === path.resolve(storeDir)).uncertain ?? false, false);
    assert.equal(quiet.claims.filter(claim => claim.host === governor.host).length, 0, 'no fence or claim was republished after teardown');

    // The already live waiter is admitted with NO reopen of the closed project and
    // no replay of the finished effect.
    const granted = await bounded(pending, 20000);
    assert.ok(granted.lease?.permit, JSON.stringify(granted.lease ?? granted.error ?? granted));
    assert.equal(runs.waiter, 1, 'the already live cross-host effect ran exactly once');
    assert.equal(runs.owner, 1, 'the finished owner effect was never replayed');
    await granted.lease.permit.release();
    assert.deepEqual((await waiter.status()).claims, []);
  } finally {
    releaseAction();
    controller.abort();
    await Promise.allSettled([pending]);
    await ownerRun.catch(() => undefined);
  }
});

test('a broker close whose exact store still cannot publish keeps a fail-closed quarantine and publishes no fence', { timeout: 60000 }, async t => {
  const { base, root, directory, config, broker, local, governor } = await brokerFixture(t, 'broker-close-persistent');
  const faults = drainFaults(t);
  const retries = captureRetryTimers(t, governor);
  const storeDir = local.store.directory;
  await governor.account(storeDir, () => storageUsage(storeDir));
  // The fault never clears: every publication of this KNOWN drain fails.
  faults.armed = 1_000_000;
  let effects = 0;
  await assert.rejects(local.lifecycle.withStorage(32 * MIB, async () => {
    effects += 1;
    return 'action-completed';
  }, undefined, 'work', false), /injected pre-publication drain failure/);
  assert.equal(effects, 1, 'the completed effect is never run again');
  assert.equal(governor.retainedDrains.size, 1, 'the failed publication retained its exact claim');
  const retry = await retries.next();
  assert.ok(faults.armed > 0, 'the fault is still there when the host closes');

  await broker.close();
  const ledger = await readLedger(base);
  assert.equal(ledger.claims.length, 1);
  assert.equal(ledger.claims[0].state, 'quarantine', 'an unpublished drain is kept as the deliberate fail-closed quarantine');
  assert.equal(ledger.claims[0].bytes, 32 * MIB, 'the unproven effect keeps charging its bytes');
  assert.equal(ledger.claims.some(claim => claim.state === 'drained'), false, 'no drain row was ever published');
  const fenced = Object.values(ledger.stores).find(store => path.resolve(store.directory) === path.resolve(storeDir));
  assert.equal(fenced.uncertain ?? false, false, 'an unpublished drain writes NO store fence');
  assert.equal(governor.retainedDrains.size, 0, 'the close settled the ownership durably instead of leaving a retry');
  assert.equal(governor.drainRetry, undefined, 'no retry timer survives the close');
  await assert.rejects(fs.access(path.join(storeDir, 'owner.lock')), { code: 'ENOENT' },
    'the store owner lock is released after the shutdown');
  retry.callback();
  await new Promise(resolve => { setTimeout(resolve, 30).unref(); });
  assert.equal((await readLedger(base)).claims.length, 1, 'the captured pre-close retry published nothing after teardown');

  // The quarantine is durable and fail-closed: a healthy sample of that exact store
  // cannot reclaim an UNCERTAIN effect, so an unrelated operation unlocks nothing.
  const reloaded = new ResourceGovernor(config, directory);
  t.after(() => reloaded.close().catch(() => undefined));
  faults.armed = 0;
  await reloaded.account(storeDir, () => storageUsage(storeDir));
  const after = await readLedger(base);
  assert.equal(after.claims.length, 1);
  assert.equal(after.claims[0].state, 'quarantine', 'a healthy sample of the store never releases an unproven effect');
  await assert.rejects(reloaded.acquire({ key: 'storage:after-persistent-close', kind: 'storage', root,
    bytes: 32 * MIB, lane: 'work', store: storeDir }, undefined, undefined, false),
  error => error.code === 'resource_busy' && /storage|quarantine/.test(error.message));
});

test('a failed aggregate shutdown still releases the store ownership kept for the final sample', { timeout: 60000 }, async t => {
  const { broker, local, governor } = await brokerFixture(t, 'broker-close-error');
  const storeDir = local.store.directory;
  // A real participation, so this window really owes the aggregate a shutdown.
  assert.equal(await local.lifecycle.withStorage(1 * MIB, async () => 'small', undefined, 'work', false), 'small');
  const realClose = governor.close.bind(governor);
  // The aggregate shutdown is told exactly which store this window still owns, and it
  // runs while that store is still exclusively held - the final sample depends on it.
  const passed = []; let lockedDuringAggregate;
  governor.close = async stores => {
    passed.push(...stores);
    lockedDuringAggregate = await fs.access(path.join(storeDir, 'owner.lock')).then(() => true, () => false);
    throw Error('injected aggregate shutdown failure');
  };
  t.after(async () => {
    governor.close = realClose;
    await realClose().catch(() => undefined);
  });
  // The shutdown error is reported unchanged, and it does not leak the store lock
  // that was kept for the final sample.
  await assert.rejects(broker.close(), /injected aggregate shutdown failure/);
  assert.deepEqual(passed, [storeDir], 'the aggregate shutdown is handed the exact owned store');
  assert.equal(lockedDuringAggregate, true, 'the aggregate shutdown runs while that exact store is still owned');
  assert.equal(broker.local.size, 0, 'the broker dropped every local it was closing');
  await assert.rejects(fs.access(path.join(storeDir, 'owner.lock')), { code: 'ENOENT' },
    'the owner lock is released even though the aggregate shutdown failed');
});

test('a per-local drain failure at broker close keeps that owner and its lock, and a retried close finishes the job', { timeout: 60000 }, async t => {
  const { base, root, broker, local, governor } = await brokerFixture(t, 'broker-close-local-drain');
  const { SessionStore } = require(path.join(buildDir, 'storage'));
  const storeDir = local.store.directory;
  // A real participation, so this window really owes the aggregate a shutdown.
  assert.equal(await local.lifecycle.withStorage(1 * MIB, async () => 'small', undefined, 'work', false), 'small');
  // ONE local effect drain fails: this root's isolation host refuses to close.
  const realIsolationClose = local.isolation.close.bind(local.isolation);
  let failures = 1;
  local.isolation.close = async () => {
    if (failures > 0) {
      failures -= 1;
      throw Error('injected per-local drain failure');
    }
    return realIsolationClose();
  };
  t.after(() => { local.isolation.close = realIsolationClose; });
  const realResourcesClose = governor.close.bind(governor);
  const aggregate = [];
  governor.close = async stores => { aggregate.push(...stores); return realResourcesClose(stores); };
  t.after(() => { governor.close = realResourcesClose; });

  await assert.rejects(broker.close(), /injected per-local drain failure/);
  // The regression: the handle is PRESERVED. Its store was never handed to the
  // aggregate shutdown and never released, so the root still owns it and the exact
  // same close can finish instead of leaking a lock nothing could release again.
  assert.equal(broker.local.size, 1, 'the local is kept for the retry');
  assert.equal(broker.local.get(root), local, 'the SAME owner handle is kept, not a copy');
  assert.deepEqual(aggregate, [], 'no aggregate shutdown or final sample runs before every local effect drained');
  assert.equal(await fs.access(path.join(storeDir, 'owner.lock')).then(() => true, () => false), true,
    'the exact store lock is still held by this window');
  const contender = new SessionStore(storeDir);
  try {
    await assert.rejects(contender.open(), { code: 'workspace_locked' },
      'the preserved owner still excludes another host');
  } finally {
    await contender.close().catch(() => undefined);
  }

  // The fault cleared: the retried close drains that same local, samples its exact
  // store once and only then releases its lock.
  await broker.close();
  assert.equal(broker.local.size, 0, 'the released local is dropped from the map');
  assert.deepEqual(aggregate, [storeDir], 'the aggregate shutdown got the exact owned store, exactly once');
  await assert.rejects(fs.access(path.join(storeDir, 'owner.lock')), { code: 'ENOENT' },
    'the retried close released the lock');
  const ledger = await readLedger(base);
  assert.equal(ledger.claims.filter(claim => claim.host === governor.host).length, 0, 'nothing of the closed host is left charged');
});

test('a failing store release keeps that owner handle instead of dropping it with its lock', { timeout: 60000 }, async t => {
  const { root, broker, local, governor } = await brokerFixture(t, 'broker-close-store-release');
  const storeDir = local.store.directory;
  assert.equal(await local.lifecycle.withStorage(1 * MIB, async () => 'small', undefined, 'work', false), 'small');
  const realStoreClose = local.store.close.bind(local.store);
  let failures = 1;
  local.store.close = async () => {
    if (failures > 0) {
      failures -= 1;
      throw Error('injected store release failure');
    }
    return realStoreClose();
  };
  t.after(() => { local.store.close = realStoreClose; });

  await assert.rejects(broker.close(), /injected store release failure/);
  // The aggregate shutdown DID run (every effect had drained), but the store lock
  // itself could not be dropped: the owner handle is kept so a retry can release it.
  assert.equal(broker.local.get(root), local, 'the unreleased owner is kept reachable');
  await fs.access(path.join(storeDir, 'owner.lock'));

  await broker.close();
  assert.equal(broker.local.size, 0, 'the local is dropped once its exact store was released');
  await assert.rejects(fs.access(path.join(storeDir, 'owner.lock')), { code: 'ENOENT' });
  assert.equal(governor.retainedDrains.size, 0);
});
