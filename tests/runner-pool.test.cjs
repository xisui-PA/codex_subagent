// Focused runner-pool lease-lifecycle tests: bounded capacity and queue, FIFO,
// cancellation, exclusivity, contamination, quarantine, recovery, cleanup and
// safe path handling. Real temp directories only; the pool always lives in a
// sibling directory OUTSIDE the project root, and nothing here executes a
// process.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const buildDir = path.join(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { RunnerPool } = require(path.join(buildDir, 'runner-pool'));
const { atomicWrite, digest } = require(path.join(buildDir, 'storage'));
const { ResourceGovernor, resourceDefaults } = require(path.join(buildDir, 'resource-governor'));
const { WorkerBroker } = require(path.join(buildDir, 'runtime'));

const TEAM = 'a'.repeat(32);
const ISO = '2024-01-01T00:00:00.000Z';
const hex32 = label => crypto.createHash('sha256').update(`runner-pool:${label}`).digest('hex').slice(0, 32);
const owner = label => ({ ownerId: `owner-${label}`, teamId: TEAM, workerId: hex32(label), workerCreatedAt: ISO });
const scopeOf = label => ({ ownerId: `owner-${label}`, teamId: TEAM });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const exists = async target => fs.lstat(target).then(() => true, () => false);

/** Project root plus a sibling store: the pool is never inside the project. */
async function makePool(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-'));
  const project = path.join(base, 'project');
  const poolDirectory = path.join(base, 'store', 'runners');
  await fs.mkdir(project, { recursive: true });
  const pool = new RunnerPool(poolDirectory, { projectRoot: project, closeTimeoutMs: 500, ...options });
  await pool.open();
  t.after(async () => {
    await pool.close().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, project, poolDirectory, pool };
}

async function admissionDeadline(promise, milliseconds = 1000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('admission did not settle')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Poll a predicate; the pool pumps on a 100 ms timer, so never busy-wait forever. */
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

test('admission cleanup failures never strand rejected or refused runner requests', async t => {
  for (const mode of ['admission', 'reservation', 'overflow']) {
    await t.test(mode, async t => {
      const admission = { tryAcquire: async () => { if (mode === 'admission') { throw Error('ledger unavailable'); } return mode !== 'overflow'; },
        cancel: async () => { throw Error('ledger cleanup unavailable'); }, reconcile: async () => {} };
      const { pool } = await makePool(t, { capacity: 1, maxQueue: mode === 'overflow' ? 0 : 2, admission,
        writeJournal: async (file, text) => { if (mode === 'reservation' && Object.keys(JSON.parse(text).leases).length) { throw Error('reservation journal unavailable'); } await atomicWrite(file, text); } });
      const controller = new AbortController();
      await assert.rejects(admissionDeadline(pool.acquire(owner('fault'), controller.signal)), mode === 'overflow' ? e => e.code === 'pool_queue_full' : /unavailable/);
      controller.abort(); await pool.close();
      assert.equal(pool.status().closed, true); assert.equal(pool.status().queue.length, 0); assert.equal(pool.status().leases.length, 0);
      assert.ok(pool.status().diagnostics.some(d => /Aggregate claim .* remains retained/.test(d)));
    });
  }
});

test('closing still aborts and drains active leases when queued admission cleanup fails', async t => {
  let finishCleanup; const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const { pool } = await makePool(t, { capacity: 1, admission: { tryAcquire: async () => true, cancel: async () => { await cleanup; throw Error('ledger unavailable'); }, reconcile: async () => {} } });
  const lease = await pool.acquire(owner('active'));
  const queued = assert.rejects(pool.acquire(owner('queued')), e => e.code === 'pool_closed');
  const closing = pool.close(); await queued;
  try {
    for (let i = 0; i < 100 && !lease.signal.aborted; i++) { await tick(); }
    assert.equal(lease.signal.aborted, true, 'active effects must stop before ledger cleanup finishes');
  } finally { finishCleanup(); await lease.release({ drained: true }); await closing; }
  assert.equal(pool.status().closed, true);
});

test('close withdraws its whole queued set with one batch admission call', { timeout: 15000 }, async t => {
  const batches = [], singles = [];
  let releaseBatch; const batchGate = new Promise(resolve => { releaseBatch = resolve; });
  const admission = {
    tryAcquire: async (id, candidate) => candidate.ownerId.endsWith('-held'),
    cancel: async id => { singles.push(id); },
    cancelMany: async ids => { batches.push([...ids]); await batchGate; },
    reconcile: async () => {}
  };
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 3, admission });
  const held = await pool.acquire(owner('batch-held'));
  const queued = ['batch-b', 'batch-c', 'batch-d'].map(label => pool.acquire(owner(label)).then(lease => ({ lease }), error => ({ error })));
  try {
    await until(() => pool.status().queue.length === 3);
    const tickets = pool.waiters.map(waiter => waiter.admissionId);
    let settled = false;
    const closing = pool.close().then(() => { settled = true; });
    for (const outcome of queued) {
      assert.equal((await outcome).error?.code, 'pool_closed', 'a closing pool still rejects every queued caller promptly');
    }
    assert.deepEqual(batches, [tickets], 'one batch covers exactly the queued tickets, in FIFO order');
    assert.deepEqual(singles, [], 'a batch-capable admission is never withdrawn ticket by ticket');
    assert.equal(pool.leaseRecord(held.id).state, 'leased', 'close never releases an active lease on its own');
    assert.equal(await exists(held.directory), true);
    await held.release({ drained: true });
    await tick();
    assert.equal(settled, false, 'close keeps local ownership of the batch until its effect settles');
    releaseBatch();
    await closing;
    assert.equal(pool.status().closed, true);
    assert.equal(pool.status().queue.length, 0);
  } finally { releaseBatch(); }
});

test('a cancel-only adapter starts every close-time withdrawal together instead of serially', { timeout: 15000 }, async t => {
  const entered = [];
  let releaseCancels; const gate = new Promise(resolve => { releaseCancels = resolve; });
  const admission = { tryAcquire: async (id, candidate) => candidate.ownerId.endsWith('-held'), cancel: async id => { entered.push(id); await gate; }, reconcile: async () => {} };
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 2, admission });
  const held = await pool.acquire(owner('legacy-held'));
  const queued = ['legacy-b', 'legacy-c'].map(label => pool.acquire(owner(label)).then(lease => ({ lease }), error => ({ error })));
  try {
    await until(() => pool.status().queue.length === 2);
    const closing = pool.close();
    for (const outcome of queued) {
      assert.equal((await outcome).error?.code, 'pool_closed');
    }
    // Two tickets, ONE shared deadline: both withdrawals must be in flight at the
    // same time. A serial loop keeps this false until the gate opens.
    await until(() => entered.length === 2, 1000);
    assert.notEqual(entered[0], entered[1], 'each queued ticket is withdrawn exactly once');
    await held.release({ drained: true });
    releaseCancels();
    await closing;
    assert.equal(pool.status().closed, true);
  } finally { releaseCancels(); }
});

test('a failed batch withdrawal is diagnosed per ticket and still settles close', { timeout: 15000 }, async t => {
  const batches = [], singles = [];
  const admission = {
    tryAcquire: async (id, candidate) => candidate.ownerId.endsWith('-held'),
    cancel: async id => { singles.push(id); },
    cancelMany: async ids => { batches.push([...ids]); throw Error('ledger unavailable'); },
    reconcile: async () => {}
  };
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 2, admission });
  const held = await pool.acquire(owner('fail-held'));
  const queued = ['fail-b', 'fail-c'].map(label => pool.acquire(owner(label)).then(lease => ({ lease }), error => ({ error })));
  await until(() => pool.status().queue.length === 2);
  const tickets = pool.waiters.map(waiter => waiter.admissionId);
  const closing = pool.close();
  for (const outcome of queued) {
    assert.equal((await outcome).error?.code, 'pool_closed');
  }
  await held.release({ drained: true });
  await closing;
  const status = pool.status();
  assert.equal(status.closed, true);
  assert.deepEqual(status.queue, []);
  assert.deepEqual(batches, [tickets], 'the failed batch still covered the whole queue exactly once');
  assert.deepEqual(singles, [], 'a failed batch is never retried as serial single withdrawals');
  assert.ok(status.diagnostics.some(d => /Aggregate claims .* remain retained after one batch withdrawal of 2 queued tickets/.test(d) && d.includes('ledger unavailable')),
    'one clear batch diagnostic names the failed transaction');
  for (const id of tickets) {
    assert.ok(status.diagnostics.some(d => d.includes(`Aggregate claim ${id} remains retained`)), `ticket ${id} is reported on its own`);
  }
});

test('a close that empties the queue never re-polls the ticket whose poll was gated', { timeout: 20000 }, async t => {
  const polls = [], singles = [], batches = [];
  let enterFirst, openFirst;
  const firstEntered = new Promise(resolve => { enterFirst = resolve; });
  const firstGate = new Promise(resolve => { openFirst = resolve; });
  const admission = {
    tryAcquire: async (id, candidate) => {
      if (candidate.ownerId.endsWith('-held')) {
        return true;
      }
      polls.push(id);
      if (polls.length === 1) {
        enterFirst(); await firstGate; return false;
      }
      return false;
    },
    cancel: async id => { singles.push(id); },
    cancelMany: async ids => { batches.push([...ids]); },
    reconcile: async () => {}
  };
  const { pool } = await makePool(t, { capacity: 2, maxQueue: 4, closeTimeoutMs: 3000, admission });
  let held, closing;
  try {
    held = await pool.acquire(owner('race-held'));
    const queued = ['r1', 'r2', 'r3', 'r4'].map(label => pool.acquire(owner(label)).then(lease => ({ lease }), error => ({ error })));
    await firstEntered;
    const tickets = pool.waiters.map(waiter => waiter.admissionId);
    assert.equal(tickets.length, 4, 'all four requests are queued in one synchronous batch');
    assert.deepEqual(polls, [tickets[0]], 'the pump is gated inside the FIRST poll');
    closing = pool.close();
    for (const outcome of queued) {
      assert.equal((await outcome).error?.code, 'pool_closed', 'close rejects every queued caller');
    }
    assert.equal(pool.waiters.length, 0, 'close spliced the whole queue');
    assert.deepEqual(batches, [tickets], 'one batch withdrawal covers exactly the removed tickets');
    assert.deepEqual(singles, [], 'a close-time removal is never withdrawn ticket by ticket');
    // Opening the gate lets the IN-FLIGHT poll finish exactly once. The pump then
    // has to stop: the other three ids are gone, so no further poll may run and
    // nothing but that one poll may keep the mutex (and so close) waiting.
    openFirst();
    assert.equal((await admissionDeadline(held.release({ drained: true }), 2000)).state, 'released',
      'a fresh mutex-serialized release settles as soon as the in-flight poll returns');
    await admissionDeadline(closing, 2000);
    assert.deepEqual(polls, [tickets[0]], 'a removed ticket is never offered to tryAcquire again');
    assert.deepEqual(singles, [tickets[0]], 'only the in-flight poll completes its own withdrawal');
    const status = pool.status();
    assert.equal(status.closed, true);
    assert.deepEqual(status.queue, []);
    assert.equal(status.leases.some(record => tickets.includes(record.leaseId)), false, 'no stale lease is materialized');
  } finally {
    openFirst();
    await closing?.catch(() => undefined);
    await held?.release({ drained: true }).catch(() => undefined);
  }
});

test('caller aborts that empty the queue never re-poll a cancelled ticket', { timeout: 20000 }, async t => {
  const polls = [], singles = [];
  let enterFirst, openFirst;
  const firstEntered = new Promise(resolve => { enterFirst = resolve; });
  const firstGate = new Promise(resolve => { openFirst = resolve; });
  const admission = {
    tryAcquire: async (id, candidate) => {
      if (candidate.ownerId.endsWith('-held')) {
        return true;
      }
      polls.push(id);
      if (polls.length === 1) {
        enterFirst(); await firstGate; return false;
      }
      return false;
    },
    cancel: async id => { singles.push(id); },
    reconcile: async () => {}
  };
  const { pool } = await makePool(t, { capacity: 2, maxQueue: 4, closeTimeoutMs: 3000, admission });
  let held;
  try {
    held = await pool.acquire(owner('abort-held'));
    const controllers = [1, 2, 3, 4].map(() => new AbortController());
    const queued = controllers.map((controller, index) => pool.acquire(owner(`b${index + 1}`), controller.signal)
      .then(lease => ({ lease }), error => ({ error })));
    await firstEntered;
    const tickets = pool.waiters.map(waiter => waiter.admissionId);
    assert.equal(tickets.length, 4);
    assert.deepEqual(polls, [tickets[0]], 'the pump is gated inside the FIRST poll');
    for (const controller of controllers) {
      controller.abort();
    }
    for (const outcome of queued) {
      assert.equal((await outcome).error?.code, 'pool_aborted', 'every aborted caller is rejected');
    }
    assert.equal(pool.waiters.length, 0, 'the aborts removed every waiter');
    assert.deepEqual([...new Set(singles)].sort(), [...tickets].sort(), 'each aborted ticket was withdrawn');

    // The in-flight poll still completes its own withdrawal, but the aborted ids
    // behind it are gone: they must never be withdrawn again from a stale poll,
    // and must never reach tryAcquire.
    openFirst();
    await admissionDeadline(held.release({ drained: true }), 2000);
    await tick(); await tick();
    assert.deepEqual(polls, [tickets[0]], 'an aborted, already-withdrawn ticket is never offered to tryAcquire again');
    assert.deepEqual(singles.filter(id => id !== tickets[0]).sort(), tickets.slice(1).sort(),
      'a removed ticket is withdrawn exactly once, never again by a stale poll');
    assert.deepEqual([...new Set(singles)].sort(), [...tickets].sort(), 'no ticket was lost from the withdrawal');
    assert.equal(pool.status().leases.some(record => tickets.includes(record.leaseId)), false, 'no stale lease is materialized');
  } finally {
    openFirst();
    await held?.release({ drained: true }).catch(() => undefined);
  }
});

test('a promotion inherits a younger slot promise without hiding a queued waiter from maxQueue', { timeout: 10000 }, async t => {
  let enter, resume; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  let pause = true;
  const admission = { tryAcquire: async (_id, candidate) => { if (candidate.ownerId === 'owner-older' && pause) { pause = false; enter(); await gate; } return true; }, cancel: async () => {}, reconcile: async () => {} };
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 1, admission });
  const controller = new AbortController(); let active, promoted, arrival;
  try {
    active = await pool.acquire(owner('active'));
    const older = pool.acquire(owner('older'), controller.signal).then(lease => ({ lease }), error => ({ error }));
    await active.release({ drained: true }); await entered;
    const younger = pool.acquire(owner('younger'), controller.signal).then(lease => ({ lease }), error => ({ error }));
    resume(); promoted = (await older).lease; assert.ok(promoted);
    assert.equal(pool.status().queue.length, 1);
    const extra = new AbortController(), refused = pool.acquire(owner('overflow'), extra.signal).then(lease => ({ lease }), error => ({ error }));
    await tick(); extra.abort(); const result = await refused; assert.equal(result.error?.code, 'pool_queue_full');
    await promoted.release({ drained: true }); arrival = (await younger).lease; assert.ok(arrival);
    await arrival.release({ drained: true });
  } finally { resume(); controller.abort(); await arrival?.release({ drained: true }); await promoted?.release({ drained: true }); await active?.release({ drained: true }); }
});


test('configuration is bounded and validated; defaults are 2 slots and a 32 queue', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-config-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const poolDirectory = path.join(base, 'runners');
  const defaults = new RunnerPool(poolDirectory);
  assert.equal(defaults.capacity, 2);
  assert.equal(defaults.maxQueue, 32);
  for (const bad of [{ capacity: 0 }, { capacity: 9 }, { capacity: 1.5 }, { maxQueue: -1 }, { maxQueue: 257 }, { maxQueue: 1.5 }, { closeTimeoutMs: 0 }, { closeTimeoutMs: 60001 }]) {
    assert.throws(() => new RunnerPool(poolDirectory, bad), { code: 'invalid_pool_config' }, JSON.stringify(bad));
  }
  assert.throws(() => new RunnerPool('relative/runners'), { code: 'invalid_path' });
  // The pool must sit outside the project root, by path form or canonical alias.
  const inside = new RunnerPool(path.join(base, 'project', 'runners'), { projectRoot: path.join(base, 'project') });
  await fs.mkdir(path.join(base, 'project'), { recursive: true });
  await assert.rejects(inside.open(), { code: 'invalid_path' });
  // Owner identity is validated before any allocation.
  const pool = new RunnerPool(poolDirectory, { capacity: 1 });
  await pool.open();
  await assert.rejects(pool.acquire({ ...owner('a'), teamId: 'nope' }), { code: 'invalid_pool_owner' });
  await assert.rejects(pool.acquire({ ...owner('a'), extra: true }), { code: 'invalid_pool_owner' });
  await pool.close();
});

test('acquire grants an exclusive lease with fresh plain directories and an idempotent release', async t => {
  const { pool } = await makePool(t, { capacity: 2 });
  t.after(() => pool.close());
  const lease = await pool.acquire(owner('a'));
  assert.equal(lease.slot, 0);
  assert.match(lease.id, /^[0-9a-f]{32}$/);
  assert.equal(lease.phase, 'reserved');
  assert.equal(lease.signal.aborted, false);
  assert.equal((await fs.stat(lease.directory)).isDirectory(), true);
  assert.equal((await fs.stat(lease.sourceDir)).isDirectory(), true);
  assert.equal((await fs.stat(lease.tempDir)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(lease.sourceDir), []);
  assert.deepEqual(await fs.readdir(lease.tempDir), []);
  assert.equal((await fs.stat(lease.sourceDir)).isSymbolicLink(), false);

  // A checkpoint is durable: it is on disk before the caller effects anything.
  await lease.checkpoint({ phase: 'prepared' });
  await lease.checkpoint({ phase: 'executing', process: { pid: 4242, token: 'run-1' } });
  assert.equal(lease.phase, 'executing');
  const durable = JSON.parse(await fs.readFile(pool.journalFile, 'utf8'));
  assert.equal(durable.leases[lease.id].phase, 'executing');
  assert.deepEqual(durable.leases[lease.id].process, { pid: 4242, token: 'run-1' });
  assert.equal(durable.leases[lease.id].owner.workerId, owner('a').workerId);
  // Phase order is monotonic and process identity is validated JSON.
  await assert.rejects(lease.checkpoint({ phase: 'reserved' }), { code: 'invalid_pool_checkpoint' });
  await assert.rejects(lease.checkpoint({ phase: 'executing', process: { at: new Date() } }), { code: 'invalid_pool_process' });

  const released = await lease.release({ drained: true });
  assert.equal(released.state, 'released');
  assert.equal(released.deleted, true);
  assert.equal(await exists(lease.directory), false);
  assert.equal(pool.status().slots[0].state, 'free');
  // Idempotent: the second release reports the same outcome and frees nothing twice.
  assert.deepEqual(await lease.release({ drained: true }), released);
  await assert.rejects(lease.checkpoint({ phase: 'executing' }), { code: 'pool_lease_settled' });
});

test('capacity, FIFO order, queue positions and a released slot waking the next request', async t => {
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 4 });
  t.after(() => pool.close());
  const first = await pool.acquire(owner('a'));
  const secondPending = pool.acquire(owner('b'));
  const thirdPending = pool.acquire(owner('c'));
  await tick();
  assert.deepEqual(pool.status().queue.map(entry => entry.position), [1, 2]);
  assert.equal(pool.status().queue[0].owner.workerId, owner('b').workerId);
  assert.equal(pool.statusFor(owner('a')).state, 'leased');
  assert.deepEqual(pool.statusFor(owner('b')), { state: 'queued', position: 1 });
  assert.deepEqual(pool.statusFor(owner('c')), { state: 'queued', position: 2 });
  assert.deepEqual(pool.statusFor(owner('d')), { state: 'idle' });
  // Reading status and releasing never wait behind a queued acquire.
  await first.release({ drained: true });
  const second = await secondPending;
  assert.equal(second.slot, 0);
  assert.equal(pool.statusFor(owner('c')).position, 1, 'the remaining waiter moved up');
  assert.equal(second.id === first.id, false, 'a later lease is a distinct id');
  await second.release({ drained: true });
  const third = await thirdPending;
  assert.equal(third.slot, 0);
  await third.release({ drained: true });
  assert.equal(pool.status().slots[0].state, 'free');
});

test('queue overflow is explicit and never evicts waiting requests', async t => {
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 1 });
  t.after(() => pool.close());
  const held = await pool.acquire(owner('a'));
  const queued = pool.acquire(owner('b'));
  await tick();
  await assert.rejects(pool.acquire(owner('c')), { code: 'pool_queue_full' });
  assert.equal(pool.status().queue.length, 1, 'the existing waiter was not evicted');
  await held.release({ drained: true });
  const granted = await queued;
  await granted.release({ drained: true });
  // maxQueue 0 means no waiting at all.
  const { pool: strict } = await makePool(t, { capacity: 1, maxQueue: 0 });
  t.after(() => strict.close());
  const only = await strict.acquire(owner('x'));
  await assert.rejects(strict.acquire(owner('y')), { code: 'pool_queue_full' });
  await only.release({ drained: true });
});

test('abort while queued removes the request promptly; a pre-aborted acquire allocates nothing', async t => {
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 4 });
  t.after(() => pool.close());
  const held = await pool.acquire(owner('a'));
  const controller = new AbortController();
  const cancelled = pool.acquire(owner('b'), controller.signal);
  const survivor = pool.acquire(owner('c'));
  await tick();
  assert.equal(pool.status().queue.length, 2);
  controller.abort();
  await assert.rejects(cancelled, { code: 'pool_aborted' });
  assert.equal(pool.status().queue.length, 1);
  assert.deepEqual(pool.statusFor(owner('b')), { state: 'idle' });
  assert.deepEqual(pool.statusFor(owner('c')), { state: 'queued', position: 1 });
  // A pre-aborted signal writes nothing at all.
  const before = await fs.readFile(pool.journalFile, 'utf8');
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(pool.acquire(owner('d'), pre.signal), { code: 'pool_aborted' });
  assert.equal(await fs.readFile(pool.journalFile, 'utf8'), before);
  assert.equal(pool.status().queue.length, 1);
  await held.release({ drained: true });
  const granted = await survivor;
  assert.equal(granted.slot, 0);
  await granted.release({ drained: true });
});

test('a caller abort reaches the granted lease signal; close aborts active leases', async t => {
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 2 });
  const held = await pool.acquire(owner('a'));
  const controller = new AbortController();
  const pending = pool.acquire(owner('b'), controller.signal);
  await tick();
  await held.release({ drained: true });
  const lease = await pending;
  assert.equal(lease.signal.aborted, false);
  controller.abort();
  assert.equal(lease.signal.aborted, true, 'cancelling the request cancels the running lease signal');
  await lease.release({ drained: true });
  await pool.close();

  // Close aborts every active lease signal and waits for the settle.
  const { pool: closingPool } = await makePool(t, { capacity: 1 });
  const active = await closingPool.acquire(owner('x'));
  const queued = closingPool.acquire(owner('y'));
  const closing = closingPool.close();
  await assert.rejects(queued, { code: 'pool_closed' });
  assert.equal(active.signal.aborted, true);
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, 'close must not resolve before the active lease settles');
  await active.release({ drained: false, diagnostic: 'host closing' });
  await closing;
  assert.equal(settled, true);
  await assert.rejects(closingPool.acquire(owner('z')), { code: 'pool_closed' });
});

test('close drains a lease released by the caller during close, and bounds a stuck lease', async t => {
  const { pool } = await makePool(t, { capacity: 1 });
  const lease = await pool.acquire(owner('a'));
  const closing = pool.close();
  await tick();
  await lease.release({ drained: true });
  await closing;
  assert.equal(await exists(lease.directory), false);

  // A lease that never settles fails the close instead of unlocking early.
  const { pool: stuck } = await makePool(t, { capacity: 1, closeTimeoutMs: 25 });
  const held = await stuck.acquire(owner('b'));
  await assert.rejects(stuck.close(), { code: 'pool_drain_timeout' });
  // The slot is still held; the caller may now release it durably.
  assert.equal(stuck.leaseRecord(held.id).state, 'leased');
  await held.release({ drained: true });
});

test('leases are exclusive, and a fresh lease never inherits dot files, outputs or temp data', async t => {
  const { pool } = await makePool(t, { capacity: 2, maxQueue: 1 });
  t.after(() => pool.close());
  const first = await pool.acquire(owner('a'));
  const second = await pool.acquire(owner('b'));
  assert.notEqual(first.slot, second.slot);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.sourceDir, second.sourceDir);
  assert.notEqual(first.tempDir, second.tempDir);

  await fs.writeFile(path.join(first.sourceDir, '.env'), 'SECRET=1');
  await fs.mkdir(path.join(first.sourceDir, 'out'), { recursive: true });
  await fs.writeFile(path.join(first.sourceDir, 'out', 'artifact.bin'), 'binary');
  await fs.writeFile(path.join(first.tempDir, 'cache.tmp'), 'tmp');
  await fs.mkdir(path.join(first.tempDir, 'nested'), { recursive: true });
  const released = await first.release({ drained: true });
  assert.equal(released.deleted, true);

  const secondRound = await pool.acquire(owner('c'));
  assert.equal(secondRound.slot, first.slot, 'the freed slot is reused');
  assert.notEqual(secondRound.directory, first.directory, 'but its directory is fresh');
  assert.deepEqual(await fs.readdir(secondRound.sourceDir), []);
  assert.deepEqual(await fs.readdir(secondRound.tempDir), []);
  assert.equal(await exists(path.join(secondRound.sourceDir, '.env')), false);
  assert.equal(await exists(path.join(secondRound.tempDir, 'cache.tmp')), false);
  await secondRound.release({ drained: true });
  await second.release({ drained: true });
});

test('release without a proven drain quarantines: slot retained, cleanup needs proof', async t => {
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 2 });
  t.after(() => pool.close());
  const lease = await pool.acquire(owner('a'));
  await fs.writeFile(path.join(lease.sourceDir, 'kept.txt'), 'evidence');
  const quarantined = await lease.release({ drained: false, diagnostic: 'process still running' });
  assert.equal(quarantined.state, 'quarantined');
  assert.equal(quarantined.deleted, false);
  assert.equal(await exists(path.join(lease.sourceDir, 'kept.txt')), true, 'quarantined data is retained');
  assert.equal(pool.status().slots[0].state, 'quarantined');
  assert.equal(pool.statusFor(owner('a')).state, 'quarantined');
  assert.equal(pool.leaseRecord(lease.id).diagnostic, 'process still running');

  // The quarantined slot stays consumed: the next request waits, never evicts.
  const pending = pool.acquire(owner('b'));
  await tick();
  assert.equal(pool.statusFor(owner('b')).state, 'queued');

  const refused = await pool.cleanup(scopeOf('a'), () => false);
  assert.deepEqual(refused.discarded, []);
  assert.equal(refused.retained.length, 1);
  assert.match(refused.retained[0].reason, /proven/);
  assert.equal(await exists(path.join(lease.sourceDir, 'kept.txt')), true);

  // Another owner's cleanup can never discard it.
  const foreign = await pool.cleanup({ ownerId: 'other-owner', teamId: TEAM }, () => true);
  assert.deepEqual(foreign.discarded, []);
  assert.equal(await exists(lease.directory), true);

  const proven = await pool.cleanup(scopeOf('a'), () => true);
  assert.deepEqual(proven.discarded, [lease.id]);
  assert.equal(await exists(lease.directory), false);
  const next = await pending;
  assert.equal(next.slot, 0);
  await next.release({ drained: true });
  // Cleanup is idempotent.
  const again = await pool.cleanup(scopeOf('a'), () => true);
  assert.deepEqual(again.discarded, []);
});

test('preserve retains a drained lease for inspection', async t => {
  const { pool } = await makePool(t, { capacity: 1 });
  t.after(() => pool.close());
  const lease = await pool.acquire(owner('a'));
  await fs.writeFile(path.join(lease.sourceDir, 'import-failed.txt'), 'payload');
  const result = await lease.release({ drained: true, preserve: true, diagnostic: 'source import failed' });
  assert.equal(result.state, 'quarantined');
  assert.equal(result.deleted, false);
  assert.equal(await exists(path.join(lease.sourceDir, 'import-failed.txt')), true);
  assert.equal(pool.leaseRecord(lease.id).preserve, true);
  assert.equal(pool.status().slots[0].state, 'quarantined');
  const discarded = await pool.cleanup(scopeOf('a'), () => true);
  assert.deepEqual(discarded.discarded, [lease.id]);
});

test('a failed lease setup leaks no slot and no record', async t => {
  const { pool, poolDirectory } = await makePool(t, { capacity: 1 });
  t.after(() => pool.close());
  // Block slot creation by replacing the slots directory with a plain file.
  await fs.mkdir(poolDirectory, { recursive: true });
  await fs.writeFile(path.join(poolDirectory, 'slots'), 'not a directory');
  await assert.rejects(pool.acquire(owner('a')), { code: 'pool_setup_failed' });
  const status = pool.status();
  assert.deepEqual(status.leases, []);
  assert.equal(status.slots[0].state, 'free');
  assert.equal(status.queue.length, 0);
});

test('a journal persistence failure never frees or leaks a slot', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-storage-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const poolDirectory = path.join(base, 'runners');
  let failures = 0;
  const pool = new RunnerPool(poolDirectory, {
    capacity: 1,
    maxQueue: 1,
    writeJournal: async (file, text) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('simulated disk full');
      }
      await atomicWrite(file, text, 0o600);
    }
  });
  await pool.open();
  t.after(() => pool.close());

  // A failing reservation publish allocates nothing.
  failures = 1;
  await assert.rejects(pool.acquire(owner('a')), { code: 'pool_storage' });
  assert.deepEqual(pool.status().leases, []);
  assert.equal(pool.status().slots[0].state, 'free');

  const lease = await pool.acquire(owner('b'));
  failures = 1;
  await assert.rejects(lease.release({ drained: true }), { code: 'pool_storage' });
  const status = pool.status();
  assert.equal(status.slots[0].state, 'active', 'the uncertain slot stays occupied');
  assert.equal(status.leases.length, 1);
  assert.equal(status.leases[0].state, 'leased');
  // A queued acquire must not steal the uncertain slot.
  const pending = pool.acquire(owner('c'));
  await tick();
  assert.equal(pool.statusFor(owner('c')).state, 'queued');
  // Retrying the same release is safe and then frees the slot durably.
  const retried = await lease.release({ drained: true });
  assert.equal(retried.state, 'released');
  const next = await pending;
  assert.equal(next.slot, 0);
  await next.release({ drained: true });
});

test('reopen quarantines an execution-started lease and cleans a never-started reservation', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-recovery-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const poolDirectory = path.join(base, 'runners');
  const crashed = new RunnerPool(poolDirectory, { capacity: 2 });
  await crashed.open();
  const executing = await crashed.acquire(owner('a'));
  await executing.checkpoint({ phase: 'executing', process: { pid: 4242, token: 'abc' } });
  const reservation = await crashed.acquire(owner('b'));
  // Simulate a host crash: neither lease is released and the handle is abandoned.

  const reopened = new RunnerPool(poolDirectory, { capacity: 2 });
  await reopened.open();
  const recovered = reopened.leaseRecord(executing.id);
  assert.equal(recovered.state, 'quarantined');
  assert.equal(recovered.phase, 'executing');
  assert.deepEqual(recovered.process, { pid: 4242, token: 'abc' });
  assert.equal(reopened.status().slots[recovered.slot].state, 'quarantined');
  assert.ok(reopened.status().diagnostics.some(entry => entry.includes('unproven')), 'the quarantine is reported');
  // Nothing is replayed or signalled: the directories are untouched.
  assert.equal((await fs.stat(executing.sourceDir)).isDirectory(), true);

  // A reservation that provably never started is cleaned without any proof.
  assert.equal(reopened.leaseRecord(reservation.id), undefined, 'the never-started reservation was cleaned');
  assert.equal(await exists(reservation.directory), false);
  assert.deepEqual((await reopened.cleanup(scopeOf('b'), () => false)).discarded, []);

  // Cleanup of the uncertain lease is refused without proof, then allowed.
  const refused = await reopened.cleanup(scopeOf('a'), () => false);
  assert.deepEqual(refused.discarded, []);
  assert.match(refused.retained[0].reason, /proven/);
  const proven = await reopened.cleanup(scopeOf('a'), () => true);
  assert.deepEqual(proven.discarded, [executing.id]);
  assert.equal(await exists(executing.directory), false);
  await reopened.close();
});

test('an injected conservative proof helper reconciles a drained lease on reopen', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-proof-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const poolDirectory = path.join(base, 'runners');
  const first = new RunnerPool(poolDirectory, { capacity: 1 });
  await first.open();
  const lease = await first.acquire(owner('a'));
  await lease.checkpoint({ phase: 'executing', process: { pid: 9999 } });

  const unproven = new RunnerPool(poolDirectory, { capacity: 1 });
  await unproven.open();
  assert.equal(unproven.leaseRecord(lease.id).state, 'quarantined', 'the default helper proves nothing');

  const proving = new RunnerPool(poolDirectory, { capacity: 1, proveDrained: record => record.process?.pid === 9999 });
  await proving.open();
  assert.equal(proving.leaseRecord(lease.id), undefined, 'a proven drain is cleaned on reopen');
  assert.equal(await exists(lease.directory), false);
  const next = await proving.acquire(owner('b'));
  assert.equal(next.slot, lease.slot);
  await next.release({ drained: true });
  await proving.close();
});

test('safe release unlinks nested links and hardlinked output without touching outside content', async t => {
  const { base, pool } = await makePool(t, { capacity: 1 });
  const lease = await pool.acquire(owner('a'));
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep me');
  // Ordinary dependency/build output: a nested link (node_modules/.bin style),
  // a nested directory, and a hard-linked artifact.
  const binDirectory = path.join(lease.tempDir, 'node_modules', '.bin');
  await fs.mkdir(binDirectory, { recursive: true });
  let linked = true;
  try {
    await fs.symlink(outside, path.join(binDirectory, 'tool'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linked = false;
  }
  const artifact = path.join(lease.sourceDir, 'artifact.bin');
  await fs.writeFile(artifact, 'artifact bytes');
  const hardlinked = await fs.link(artifact, path.join(outside, 'artifact-link.bin')).then(() => true, () => false);

  const result = await lease.release({ drained: true });
  assert.equal(result.state, 'released');
  assert.equal(result.deleted, true);
  assert.equal(await exists(lease.directory), false);
  assert.equal(pool.status().slots[0].state, 'free');
  // A nested link is unlinked as a leaf: its target is never traversed.
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep me');
  if (linked) {
    assert.equal(await exists(path.join(outside, 'keep.txt')), true);
  } else {
    t.diagnostic('symlink/junction creation is unavailable; the nested-link case was not exercised');
  }
  if (hardlinked) {
    assert.equal(await fs.readFile(path.join(outside, 'artifact-link.bin'), 'utf8'), 'artifact bytes', 'the other hard link keeps its content');
  }
  // The freed slot is reusable with fresh directories.
  const next = await pool.acquire(owner('b'));
  assert.equal(next.slot, lease.slot);
  assert.notEqual(next.directory, lease.directory);
  assert.deepEqual(await fs.readdir(next.sourceDir), []);
  await next.release({ drained: true });
});

test('a lease directory replaced by a junction is quarantined, never traversed', async t => {
  const { base, pool } = await makePool(t, { capacity: 1 });
  const lease = await pool.acquire(owner('a'));
  const outside = path.join(base, 'outside-ancestor');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep me');
  // Replace the LEASE directory itself (an ancestor of the tree) with a link.
  await fs.rm(lease.directory, { recursive: true });
  let linked = true;
  try {
    await fs.symlink(outside, lease.directory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linked = false;
  }
  if (!linked) {
    t.diagnostic('symlink/junction creation is unavailable; the ancestor-link case was not exercised');
    await lease.release({ drained: true });
    return;
  }
  const result = await lease.release({ drained: true });
  assert.equal(result.state, 'quarantined');
  assert.equal(result.deleted, false);
  assert.match(result.diagnostic, /not a plain directory|symbolic link/);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep me', 'the link target was never followed or deleted');
  assert.equal(pool.status().slots[0].state, 'quarantined');
});

test('corrupt journals fail closed, the failed handle refuses reuse and a fresh handle recovers', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-corrupt-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const poolDirectory = path.join(base, 'runners');
  await fs.mkdir(poolDirectory, { recursive: true });
  const journalFile = path.join(poolDirectory, 'pool.json');
  await fs.writeFile(journalFile, 'this is not json');

  const broken = new RunnerPool(poolDirectory);
  await assert.rejects(broken.open(), { code: 'pool_corrupt' });
  await assert.rejects(broken.open(), { code: 'pool_unavailable' }, 'a handle that failed to open stays failed');
  assert.throws(() => broken.status(), { code: 'pool_unavailable' });

  // A record carrying a path outside the pool is corrupt, never honoured.
  const elsewhere = path.join(base, 'elsewhere');
  const leaseId = 'c'.repeat(32);
  const record = {
    leaseId,
    slot: 0,
    sequence: 0,
    state: 'leased',
    phase: 'reserved',
    owner: owner('a'),
    directory: elsewhere,
    sourceDir: path.join(elsewhere, 'source'),
    tempDir: path.join(elsewhere, 'temp'),
    process: null,
    preserve: false,
    createdAt: ISO,
    updatedAt: ISO
  };
  await fs.writeFile(journalFile, JSON.stringify({ schema: 1, root: poolDirectory, revision: 1, nextSequence: 1, leases: { [leaseId]: record } }));
  const corrupted = new RunnerPool(poolDirectory);
  await assert.rejects(corrupted.open(), { code: 'pool_corrupt' });

  await fs.rm(journalFile);
  const fresh = new RunnerPool(poolDirectory);
  await fresh.open();
  assert.deepEqual(fresh.status().leases, []);
  assert.equal(fresh.status().slots.every(slot => slot.state === 'free'), true);
  await fresh.close();
});

test('unknown directories and journals are preserved and reported', async t => {
  const { pool, poolDirectory } = await makePool(t, { capacity: 1 });
  t.after(() => pool.close());
  await fs.mkdir(path.join(poolDirectory, 'strange'), { recursive: true });
  await fs.writeFile(path.join(poolDirectory, 'strange', 'note.txt'), 'keep');
  await fs.mkdir(path.join(poolDirectory, 'slots', '0', 'not-a-lease'), { recursive: true });
  await fs.mkdir(path.join(poolDirectory, 'slots', '7'), { recursive: true });

  const reopened = new RunnerPool(poolDirectory, { capacity: 1 });
  await reopened.open();
  t.after(() => reopened.close());
  const unknown = reopened.status().unknownEntries;
  assert.ok(unknown.includes('strange'), `unknown root entry reported: ${unknown.join(', ')}`);
  assert.ok(unknown.some(entry => entry.includes('not-a-lease')), 'unknown lease directory reported');
  assert.ok(unknown.some(entry => entry.endsWith(path.join('slots', '7'))), 'unknown slot directory reported');
  const cleaned = await reopened.cleanup({ ownerId: 'someone', teamId: TEAM }, () => true);
  assert.ok(cleaned.unknownEntries.length >= 3);
  // Cleanup never deletes unknown state.
  assert.equal(await fs.readFile(path.join(poolDirectory, 'strange', 'note.txt'), 'utf8'), 'keep');
  assert.equal(await exists(path.join(poolDirectory, 'slots', '0', 'not-a-lease')), true);
  assert.equal(await exists(path.join(poolDirectory, 'slots', '7')), true);
});

test('a missing journal beside existing slot directories fails closed', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-nojournal-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const poolDirectory = path.join(base, 'runners');
  const leaseDirectory = path.join(poolDirectory, 'slots', '0', 'a'.repeat(32));
  await fs.mkdir(path.join(leaseDirectory, 'source'), { recursive: true });
  await fs.writeFile(path.join(leaseDirectory, 'source', 'live.txt'), 'live workspace');

  // Without the journal these directories are unknowable, so the pool refuses
  // to adopt empty state that could outnumber its capacity or orphan content.
  const blind = new RunnerPool(poolDirectory, { capacity: 2 });
  await assert.rejects(blind.open(), { code: 'pool_corrupt' });
  await assert.rejects(blind.open(), { code: 'pool_unavailable' }, 'the failed handle stays failed');
  assert.equal(await fs.readFile(path.join(leaseDirectory, 'source', 'live.txt'), 'utf8'), 'live workspace');
  assert.equal(await exists(path.join(poolDirectory, 'pool.json')), false, 'no journal was fabricated over the directories');

  // A genuinely empty pool does start fresh, and its empty journal is durable
  // before the returned handle can effect anything.
  const empty = path.join(base, 'empty-runners');
  const fresh = new RunnerPool(empty, { capacity: 2 });
  await fresh.open();
  const journal = JSON.parse(await fs.readFile(path.join(empty, 'pool.json'), 'utf8'));
  assert.deepEqual(journal.leases, {});
  assert.equal(journal.root, empty);
  await fresh.close();
});

test('maxQueue 0 grants up to capacity and rejects only a real waiting request', async t => {
  const { pool } = await makePool(t, { capacity: 2, maxQueue: 0 });
  // Several same-tick acquires: the first two are immediately grantable and the
  // third must be rejected, even though no reservation has been published yet.
  const first = pool.acquire(owner('a'));
  const second = pool.acquire(owner('b'));
  const rejected = pool.acquire(owner('c'));
  await assert.rejects(rejected, { code: 'pool_queue_full' });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.slot, b.slot].sort(), [0, 1]);
  assert.notEqual(a.directory, b.directory);
  // Both slots are busy: the next request waits, and maxQueue 0 refuses it.
  await assert.rejects(pool.acquire(owner('d')), { code: 'pool_queue_full' });
  await a.release({ drained: true });
  await b.release({ drained: true });
  assert.equal(pool.status().queue.length, 0);

  // Same-tick race on a single slot: one grant, one refusal, no over-claim.
  const { pool: single } = await makePool(t, { capacity: 1, maxQueue: 0 });
  const outcomes = await Promise.allSettled([single.acquire(owner('x')), single.acquire(owner('y'))]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'pool_queue_full');
  const held = outcomes.find(outcome => outcome.status === 'fulfilled').value;
  await held.release({ drained: true });
  const afterRelease = await single.acquire(owner('z'));
  assert.equal(afterRelease.slot, held.slot);
  await afterRelease.release({ drained: true });
});

test('a preserve quarantine is retained across reopen even when a proof helper exists', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-preserve-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const poolDirectory = path.join(base, 'runners');
  const first = new RunnerPool(poolDirectory, { capacity: 1 });
  await first.open();
  const lease = await first.acquire(owner('a'));
  await fs.writeFile(path.join(lease.sourceDir, 'import-failed.txt'), 'payload');
  await lease.release({ drained: true, preserve: true, diagnostic: 'source import failed' });

  // Reopen with a helper that claims every drain is proven: retention wins.
  const reopened = new RunnerPool(poolDirectory, { capacity: 1, proveDrained: () => true });
  await reopened.open();
  const retained = reopened.leaseRecord(lease.id);
  assert.equal(retained.state, 'quarantined');
  assert.equal(retained.preserve, true);
  assert.equal(await fs.readFile(path.join(lease.sourceDir, 'import-failed.txt'), 'utf8'), 'payload');
  assert.equal(reopened.status().slots[0].state, 'quarantined');

  // Only an explicit cleanup with proof discards it.
  const refused = await reopened.cleanup(scopeOf('a'), () => false);
  assert.deepEqual(refused.discarded, []);
  const discarded = await reopened.cleanup(scopeOf('a'), () => true);
  assert.deepEqual(discarded.discarded, [lease.id]);
  assert.equal(await exists(lease.directory), false);
  await reopened.close();
});

test('a close that cannot drain reports an explicit error and can be retried', async t => {
  const { pool } = await makePool(t, { capacity: 1, closeTimeoutMs: 25 });
  const lease = await pool.acquire(owner('a'));
  await assert.rejects(pool.close(), { code: 'pool_drain_timeout' });
  // The pool is neither closed nor unlocked: it still refuses new work.
  assert.equal(pool.status().closing, true);
  assert.equal(pool.status().closed, false);
  const stillHeld = pool.status().slots[0];
  assert.equal(stillHeld.state, 'active');
  // After the caller settles the lease, a retried close completes.
  await lease.release({ drained: true });
  await pool.close();
  assert.equal(pool.status().closed, true);
});

/** Replace `target` with a junction/symlink to `outside`; undefined when unsupported. */
async function replaceWithLink(target, outside) {
  await fs.rm(target, { recursive: true, force: true });
  try {
    await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

test('a slot directory swapped for a junction receives no lease directories outside', async t => {
  const { base, pool, poolDirectory } = await makePool(t, { capacity: 1 });
  const outside = path.join(base, 'outside-slot');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'marker.txt'), 'external marker');
  // The numbered slot directory becomes a link to an outside directory.
  await fs.mkdir(path.join(poolDirectory, 'slots'), { recursive: true });
  if (!await replaceWithLink(path.join(poolDirectory, 'slots', '0'), outside)) {
    t.diagnostic('symlink/junction creation is unavailable; the swapped-slot case was not exercised');
    return;
  }
  await assert.rejects(pool.acquire(owner('a')), { code: 'pool_setup_failed' });
  // Nothing was created through the alias, and the external marker survives.
  assert.deepEqual((await fs.readdir(outside)).sort(), ['marker.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'marker.txt'), 'utf8'), 'external marker');
  assert.equal(await exists(path.join(outside, 'source')), false);
  assert.equal(await exists(path.join(outside, 'temp')), false);
  // The never-started reservation was dropped, so no slot is consumed.
  assert.deepEqual(pool.status().leases, []);
  assert.equal(pool.status().slots[0].state, 'free');
});

test('a slots directory swapped for a junction is never created through', async t => {
  const { base, pool, poolDirectory } = await makePool(t, { capacity: 1 });
  const outside = path.join(base, 'outside-slots');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'marker.txt'), 'external marker');
  if (!await replaceWithLink(path.join(poolDirectory, 'slots'), outside)) {
    t.diagnostic('symlink/junction creation is unavailable; the swapped-slots case was not exercised');
    return;
  }
  await assert.rejects(pool.acquire(owner('a')), { code: 'pool_setup_failed' });
  assert.deepEqual((await fs.readdir(outside)).sort(), ['marker.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'marker.txt'), 'utf8'), 'external marker');
  assert.equal(await exists(path.join(outside, '0')), false, 'no slot directory appeared outside');
  assert.deepEqual(pool.status().leases, []);
});

test('a swapped pool directory cannot receive the journal write', async t => {
  const { base, pool } = await makePool(t, { capacity: 1 });
  const moved = path.join(base, 'moved-pool');
  const outside = path.join(base, 'outside-root');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'marker.txt'), 'external marker');
  await fs.rename(pool.directory, moved);
  if (!await replaceWithLink(pool.directory, outside)) {
    t.diagnostic('symlink/junction creation is unavailable; the swapped-root case was not exercised');
    return;
  }
  // The journal publish proves its own parent before writing anything.
  await assert.rejects(pool.acquire(owner('a')), { code: 'pool_corrupt' });
  assert.deepEqual((await fs.readdir(outside)).sort(), ['marker.txt']);
  assert.equal(await exists(path.join(outside, 'pool.json')), false, 'no journal appeared outside the pool');
});

// ---------------------------------------------------------------------------
// Lifecycle regressions: provably-never-started recovery (reserved AND
// prepared), a capacity shrink below released tombstones, and the slot claim
// transferred to the durable reservation instead of being counted twice.
// ---------------------------------------------------------------------------

/**
 * Journal seam that blocks the FIRST publish whose text contains `needle`, so a
 * test can observe the pool between two durable revisions. `failAfterGate`
 * throws instead of writing, simulating a storage failure at that exact point.
 *
 * The gate ALWAYS opens: explicitly via `open()`, and automatically after
 * `autoOpenMs` so a failed assertion inside the gated window can never leave the
 * pool mutex held (which would turn a test failure into a hung `pool.close()`).
 * Every test that opens a gate registers that release BEFORE it starts gated
 * work, so the cleanup path never depends on the assertion succeeding.
 *
 * `reached` is BOUNDED: if the gate is never reached, the watchdog both opens
 * the gate and REJECTS `reached`, so `await reached` fails the test with a clear
 * fixture error instead of hanging the whole run. (A gate that is never reached
 * means the scenario is unreachable - for example waiting for a promotion that
 * `maxQueue: 0` correctly refused - and must be reported, never waited on.)
 */
function gatedJournal(needle, options = {}) {
  let releaseGate;
  let signalReached;
  let failReached;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const reached = new Promise((resolve, reject) => {
    signalReached = resolve;
    failReached = reject;
  });
  // Awaited by the test: never let the watchdog's rejection go unhandled.
  void reached.catch(() => undefined);
  let armed = false;
  let opened = false;
  const open = () => {
    if (!opened) {
      opened = true;
      releaseGate();
    }
  };
  const watchdog = setTimeout(() => {
    open();
    failReached(new Error('the journal gate was never reached: this scenario is unreachable as written'));
  }, options.autoOpenMs ?? 5000);
  watchdog.unref();
  const writeJournal = async (file, text) => {
    if (!armed && text.includes(needle)) {
      armed = true;
      signalReached();
      await gate;
      if (options.failAfterGate === true) {
        throw new Error('simulated disk full');
      }
    }
    await atomicWrite(file, text, 0o600);
  };
  return { writeJournal, open, reached };
}

/** A base directory with a sibling project root and a pool directory outside it. */
async function makeStore(t, tag) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `runner-pool-${tag}-`));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  await fs.mkdir(project, { recursive: true });
  return { base, project, poolDirectory: path.join(base, 'store', 'runners') };
}

/** A canonical journal record for a hand-written fixture journal. */
function recordFor(poolDirectory, leaseId, slot, overrides = {}) {
  const directory = path.join(poolDirectory, 'slots', String(slot), leaseId);
  return {
    leaseId,
    slot,
    sequence: 0,
    state: 'leased',
    phase: 'reserved',
    owner: owner('legacy'),
    directory,
    sourceDir: path.join(directory, 'source'),
    tempDir: path.join(directory, 'temp'),
    process: null,
    preserve: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  };
}

/** Write one journal revision directly, to reproduce a state an older rule left. */
async function seedJournal(poolDirectory, leases) {
  await fs.mkdir(poolDirectory, { recursive: true });
  await fs.writeFile(path.join(poolDirectory, 'pool.json'), JSON.stringify({
    schema: 1, root: poolDirectory, revision: 1, nextSequence: 1, leases
  }), 'utf8');
}

test('a prepared lease that provably never started is cleaned on reload without proof', async t => {
  const { poolDirectory } = await makeStore(t, 'prepared-reload');
  const crashed = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 0 });
  await crashed.open();
  const lease = await crashed.acquire(owner('a'));
  await fs.writeFile(path.join(lease.sourceDir, 'materialized.txt'), 'materialized view');
  // Exactly the state of a materialized command waiting for approval: 'prepared'
  // is checkpointed before the approval prompt and before any spawn.
  await lease.checkpoint({ phase: 'prepared' });
  const held = crashed.leaseRecord(lease.id);
  assert.equal(held.phase, 'prepared');
  assert.equal(held.process, null);
  // Simulate a host crash: the handle is abandoned without release or close.

  const reopened = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 0 });
  await reopened.open();
  assert.equal(reopened.leaseRecord(lease.id), undefined, 'the never-started lease is dropped, not quarantined');
  assert.equal(await exists(lease.directory), false);
  assert.equal(reopened.status().slots[0].state, 'free');
  assert.ok(reopened.status().diagnostics.some(entry => /never started/.test(entry)), 'the cleanup is reported');
  // The single slot is usable again instead of being lost for the whole session.
  const next = await reopened.acquire(owner('b'));
  assert.equal(next.slot, 0);
  await next.release({ drained: true });
  await reopened.close();
});

test('an ambiguous legacy pre-execution quarantine is preserved and reported, never auto-deleted', async t => {
  const seed = async (fixture, diagnostic) => {
    const record = recordFor(fixture.poolDirectory, 'c'.repeat(32), 0, {
      state: 'quarantined',
      phase: 'prepared',
      preserve: false,
      diagnostic
    });
    await fs.mkdir(record.sourceDir, { recursive: true });
    await fs.writeFile(path.join(record.sourceDir, 'materialized.txt'), 'materialized view');
    await seedJournal(fixture.poolDirectory, { [record.leaseId]: record });
    return record;
  };

  // (1) A quarantine is ambiguous whatever it says: the diagnostic is free-form
  // text, so even one claiming "never started" is not a proof. The record is
  // retained and reported, and only an explicit proof may discard it. This is
  // the honest counterpart of the auto-clean path: a LIVE record is provable,
  // an already-quarantined one is not.
  const legacyFixture = await makeStore(t, 'preexec-legacy');
  const legacyRecord = await seed(legacyFixture, 'never started; no process was ever created');
  const legacy = new RunnerPool(legacyFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await legacy.open();
  const kept = legacy.leaseRecord(legacyRecord.leaseId);
  assert.equal(kept.state, 'quarantined', 'an ambiguous quarantine is not auto-deleted');
  assert.equal(kept.diagnostic, 'never started; no process was ever created', 'the reason text is preserved as data');
  assert.equal(legacy.status().slots[0].state, 'quarantined');
  assert.equal(await fs.readFile(path.join(legacyRecord.sourceDir, 'materialized.txt'), 'utf8'), 'materialized view');
  assert.ok(legacy.status().diagnostics.some(entry => entry.includes(legacyRecord.leaseId)), 'the retention is reported');
  const unproven = await legacy.cleanup(scopeOf('legacy'));
  assert.deepEqual(unproven.discarded, []);
  assert.equal(unproven.retained.length, 1);
  assert.match(unproven.retained[0].reason, /proven/);
  assert.equal(await exists(path.join(legacyRecord.sourceDir, 'materialized.txt')), true);
  // An explicit, unconditional operator proof remains the only escape hatch.
  const proven = await legacy.cleanup(scopeOf('legacy'), () => true);
  assert.deepEqual(proven.discarded, [legacyRecord.leaseId]);
  assert.equal(await exists(legacyRecord.directory), false);
  assert.equal(legacy.status().slots[0].state, 'free');
  await legacy.close();

  // (2) The reload verdict text itself is equally untrusted.
  const verdictFixture = await makeStore(t, 'preexec-verdict');
  const verdictRecord = await seed(verdictFixture, 'recovered after restart; the process drain is unproven');
  const verdict = new RunnerPool(verdictFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await verdict.open();
  assert.equal(verdict.leaseRecord(verdictRecord.leaseId).state, 'quarantined');
  assert.deepEqual((await verdict.cleanup(scopeOf('legacy'))).discarded, []);
  await verdict.close();

  // (3) A leftover whose directory cannot be verified keeps needing a proof even
  // when a proof is offered: recovery never widens deletion.
  const unsafeFixture = await makeStore(t, 'preexec-unsafe');
  const unsafeRecord = recordFor(unsafeFixture.poolDirectory, 'f'.repeat(32), 0, {
    state: 'quarantined',
    phase: 'prepared',
    diagnostic: 'recovered after restart; the process drain is unproven'
  });
  const outside = path.join(unsafeFixture.base, 'outside-preexec');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep me');
  await fs.mkdir(path.dirname(unsafeRecord.directory), { recursive: true });
  if (!await replaceWithLink(unsafeRecord.directory, outside)) {
    t.diagnostic('symlink/junction creation is unavailable; the unverifiable-directory case was not exercised');
  } else {
    await seedJournal(unsafeFixture.poolDirectory, { [unsafeRecord.leaseId]: unsafeRecord });
    const guarded = new RunnerPool(unsafeFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
    await guarded.open();
    const guardedRecord = guarded.leaseRecord(unsafeRecord.leaseId);
    assert.equal(guardedRecord.state, 'quarantined', 'an unverifiable directory keeps the lease quarantined');
    assert.equal(guardedRecord.preserve, false);
    const diagnosis = await guarded.cleanup(scopeOf('legacy'));
    assert.deepEqual(diagnosis.discarded, [], 'no proof, no deletion');
    assert.match(diagnosis.retained[0].reason, /proven/);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep me',
      'the link target was never traversed or deleted');
    await guarded.close();
  }
});

test('a preserve retention and an unproven drain are never re-read as never started', async t => {
  // (1) Worst case for an over-eager rule: a recovery-shaped quarantine that is
  // explicitly preserved. Only an explicit proof may discard it.
  const preserveFixture = await makeStore(t, 'preserve-preexec');
  const preserveRecord = recordFor(preserveFixture.poolDirectory, 'd'.repeat(32), 0, {
    state: 'quarantined',
    phase: 'prepared',
    preserve: true,
    diagnostic: 'recovered after restart; the process drain is unproven'
  });
  await fs.mkdir(preserveRecord.sourceDir, { recursive: true });
  await fs.writeFile(path.join(preserveRecord.sourceDir, 'import-failed.txt'), 'payload');
  await seedJournal(preserveFixture.poolDirectory, { [preserveRecord.leaseId]: preserveRecord });
  const preserving = new RunnerPool(preserveFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await preserving.open();
  const retained = preserving.leaseRecord(preserveRecord.leaseId);
  assert.equal(retained.preserve, true, 'the preserved record survives reload');
  assert.equal(await fs.readFile(path.join(preserveRecord.sourceDir, 'import-failed.txt'), 'utf8'), 'payload');
  assert.equal(preserving.status().slots[0].state, 'quarantined');
  const unproven = await preserving.cleanup(scopeOf('legacy'));
  assert.deepEqual(unproven.discarded, [], 'a preserve retention needs an explicit proof');
  assert.match(unproven.retained[0].reason, /proven/);
  const proven = await preserving.cleanup(scopeOf('legacy'), () => true);
  assert.deepEqual(proven.discarded, [preserveRecord.leaseId]);
  await preserving.close();

  // (2) 'executing' with no recorded identity has no proof of no-start.
  const uncertainFixture = await makeStore(t, 'uncertain-executing');
  const crashed = new RunnerPool(uncertainFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await crashed.open();
  const lease = await crashed.acquire(owner('u'));
  await fs.writeFile(path.join(lease.sourceDir, 'side-effect.txt'), 'may have run');
  await lease.checkpoint({ phase: 'executing' });
  const reopened = new RunnerPool(uncertainFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await reopened.open();
  const recovered = reopened.leaseRecord(lease.id);
  assert.equal(recovered.state, 'quarantined');
  assert.equal(recovered.phase, 'executing');
  assert.equal(recovered.process, null);
  const refused = await reopened.cleanup(scopeOf('u'));
  assert.deepEqual(refused.discarded, []);
  assert.match(refused.retained[0].reason, /proven/);
  assert.equal(await exists(path.join(lease.sourceDir, 'side-effect.txt')), true, 'possible effects are retained');
  const provenUncertain = await reopened.cleanup(scopeOf('u'), () => true);
  assert.deepEqual(provenUncertain.discarded, [lease.id]);
  await reopened.close();

  // (3) A caller that released with drained:false asserted a possible start.
  const assertedFixture = await makeStore(t, 'asserted-start');
  const asserted = new RunnerPool(assertedFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await asserted.open();
  const running = await asserted.acquire(owner('x'));
  await fs.writeFile(path.join(running.sourceDir, 'evidence.txt'), 'evidence');
  await running.release({ drained: false, diagnostic: 'process still running' });
  const assertedReopened = new RunnerPool(assertedFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await assertedReopened.open();
  const stillQuarantined = assertedReopened.leaseRecord(running.id);
  assert.equal(stillQuarantined.state, 'quarantined', 'the unproven drain is not reinterpreted');
  assert.equal(stillQuarantined.diagnostic, 'process still running', 'the caller reason survives reload');
  const notProven = await assertedReopened.cleanup(scopeOf('x'));
  assert.deepEqual(notProven.discarded, []);
  await assertedReopened.close();
  // The assertion must not decay after a second restart either.
  const twice = new RunnerPool(assertedFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await twice.open();
  assert.equal(twice.leaseRecord(running.id).diagnostic, 'process still running');
  assert.equal(await exists(path.join(running.sourceDir, 'evidence.txt')), true);
  const stillNotProven = await twice.cleanup(scopeOf('x'));
  assert.deepEqual(stillNotProven.discarded, []);
  await twice.close();
});

test('a capacity shrink below released tombstones reopens and reconciles them', async t => {
  const { poolDirectory } = await makeStore(t, 'shrink');
  const wide = new RunnerPool(poolDirectory, { capacity: 2 });
  await wide.open();
  const first = await wide.acquire(owner('a'));
  const second = await wide.acquire(owner('b'));
  assert.deepEqual([first.slot, second.slot], [0, 1]);
  assert.equal((await first.release({ drained: true })).deleted, true);
  assert.equal((await second.release({ drained: true })).deleted, true);
  const before = JSON.parse(await fs.readFile(path.join(poolDirectory, 'pool.json'), 'utf8'));
  assert.deepEqual(Object.values(before.leases).map(record => record.state), ['released', 'released']);
  await wide.close();

  // Documented reconfiguration: the capacity is applied when the pool reopens.
  const narrowed = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 0 });
  await narrowed.open();
  assert.deepEqual(narrowed.status().leases, [], 'both released tombstones were reconciled away');
  assert.deepEqual(narrowed.status().slots.map(slot => slot.state), ['free']);
  assert.deepEqual(narrowed.status().unknownEntries, [path.join('slots', '1')],
    'the emptied slot directory is only reported, never deleted with content');
  assert.equal(await exists(path.join(poolDirectory, 'slots', '1')), true);
  const reused = await narrowed.acquire(owner('c'));
  assert.equal(reused.slot, 0, 'the shrunk pool hands out its remaining slot');
  await reused.release({ drained: true });
  await narrowed.close();
});

test('a released tombstone above the shrunken capacity is retained unless empty, and occupied state fails closed', async t => {
  // (1) A released record whose directory still holds content is retained.
  const retainedFixture = await makeStore(t, 'shrink-retained');
  const retainedId = 'c'.repeat(32);
  const retainedRecord = recordFor(retainedFixture.poolDirectory, retainedId, 5, { state: 'released' });
  await fs.mkdir(retainedRecord.sourceDir, { recursive: true });
  await fs.writeFile(path.join(retainedRecord.sourceDir, 'kept.txt'), 'kept');
  await seedJournal(retainedFixture.poolDirectory, { [retainedId]: retainedRecord });
  const retaining = new RunnerPool(retainedFixture.poolDirectory, { capacity: 1, maxQueue: 0 });
  await retaining.open();
  assert.equal(retaining.leaseRecord(retainedId).state, 'released');
  assert.equal(await fs.readFile(path.join(retainedRecord.sourceDir, 'kept.txt'), 'utf8'), 'kept',
    'unlabeled content above the new capacity is never discarded');
  assert.ok(retaining.status().unknownEntries.includes(path.join('slots', '5')), 'the slot directory is reported');
  const cleanup = await retaining.cleanup(scopeOf('legacy'));
  assert.deepEqual(cleanup.discarded, []);
  assert.match(cleanup.retained[0].reason, /needs proof/);
  assert.equal(await exists(retainedRecord.sourceDir), true);
  await retaining.close();

  // (2) A live lease above the new capacity still fails closed.
  const liveFixture = await makeStore(t, 'shrink-live');
  const liveId = 'd'.repeat(32);
  const liveRecord = recordFor(liveFixture.poolDirectory, liveId, 1);
  await fs.mkdir(liveRecord.sourceDir, { recursive: true });
  await seedJournal(liveFixture.poolDirectory, { [liveId]: liveRecord });
  const narrowedLive = new RunnerPool(liveFixture.poolDirectory, { capacity: 1 });
  await assert.rejects(narrowedLive.open(), { code: 'pool_corrupt' });
  assert.equal(await exists(liveRecord.sourceDir), true, 'nothing is discarded by a refused open');

  // (3) A quarantined lease above the new capacity also fails closed.
  const quarantinedFixture = await makeStore(t, 'shrink-quarantined');
  const quarantinedId = 'e'.repeat(32);
  const quarantinedRecord = recordFor(quarantinedFixture.poolDirectory, quarantinedId, 3, { state: 'quarantined' });
  await fs.mkdir(quarantinedRecord.sourceDir, { recursive: true });
  await seedJournal(quarantinedFixture.poolDirectory, { [quarantinedId]: quarantinedRecord });
  const narrowedQuarantined = new RunnerPool(quarantinedFixture.poolDirectory, { capacity: 1 });
  await assert.rejects(narrowedQuarantined.open(), { code: 'pool_corrupt' });

  // (4) The release exception never exceeds the PHYSICAL slot range.
  const physicalFixture = await makeStore(t, 'shrink-physical');
  const physicalId = 'f'.repeat(32);
  await seedJournal(physicalFixture.poolDirectory, { [physicalId]: recordFor(physicalFixture.poolDirectory, physicalId, 8, { state: 'released' }) });
  const tooFar = new RunnerPool(physicalFixture.poolDirectory, { capacity: 8 });
  await assert.rejects(tooFar.open(), { code: 'pool_corrupt' });
});

test('maxQueue 0 grants a second slot while the first reservation is still publishing', { timeout: 20000 }, async t => {
  const { poolDirectory } = await makeStore(t, 'claim-transfer');
  // Gate the publish AFTER the reservation is durable and adopted, which is
  // exactly the window where one slot is free and the first grant is unfinished.
  const gate = gatedJournal('"state":"leased"');
  const pool = new RunnerPool(poolDirectory, { capacity: 2, maxQueue: 0, closeTimeoutMs: 500, writeJournal: gate.writeJournal });
  await pool.open();
  // Cleanup is registered BEFORE any gated work and always unblocks first, so a
  // failing assertion can never strand the pool mutex and hang close().
  t.after(async () => {
    gate.open();
    await pool.close().catch(() => undefined);
  });

  const first = pool.acquire(owner('a'));
  // Keep a failing assertion from turning the abandoned grant into an
  // unhandled rejection: the settlement path is drained by t.after().
  void first.catch(() => undefined);
  await gate.reached;  // The first reservation is durable and adopted: slot 1 is genuinely free.
  assert.deepEqual(pool.status().slots.map(slot => slot.state).sort(), ['active', 'free']);
  let secondOutcome;
  const second = pool.acquire(owner('b'));
  void second.then(lease => { secondOutcome = { slot: lease.slot }; }, error => { secondOutcome = { code: error.code }; });
  await tick();
  assert.equal(secondOutcome, undefined, 'the free slot is neither refused nor granted twice');
  gate.open();
  const [alpha, beta] = await Promise.all([first, second]);
  assert.deepEqual([alpha.slot, beta.slot], [0, 1], 'each slot is used exactly once');
  assert.deepEqual(pool.status().queue, []);
  // Both slots are now occupied: maxQueue 0 refuses a real waiting request.
  await assert.rejects(pool.acquire(owner('c')), { code: 'pool_queue_full' });
  await alpha.release({ drained: true });
  await beta.release({ drained: true });
});

test('a cancelled in-flight acquire frees its claim and leaves no record', { timeout: 20000 }, async t => {
  const { poolDirectory } = await makeStore(t, 'claim-cancel');
  const gate = gatedJournal('"state":"reserved"');
  const pool = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 0, closeTimeoutMs: 500, writeJournal: gate.writeJournal });
  await pool.open();
  t.after(async () => {
    gate.open();
    await pool.close().catch(() => undefined);
  });
  const controller = new AbortController();
  const pending = pool.acquire(owner('a'), controller.signal);
  // Drain the rejection even if an assertion below throws before the await.
  void pending.catch(() => undefined);
  await gate.reached;
  controller.abort();
  gate.open();
  await assert.rejects(pending, { code: 'pool_aborted' });
  await tick();
  assert.equal(pool.status().slots[0].state, 'free');
  assert.deepEqual(pool.status().leases, []);
  const next = await pool.acquire(owner('b'));
  assert.equal(next.slot, 0);
  await next.release({ drained: true });
});

test('a write failure after the reservation is adopted keeps the slot reserved and never over-admits', { timeout: 20000 }, async t => {
  const { poolDirectory } = await makeStore(t, 'claim-writefail');
  const gate = gatedJournal('"state":"leased"', { failAfterGate: true });
  const pool = new RunnerPool(poolDirectory, { capacity: 2, maxQueue: 0, closeTimeoutMs: 500, writeJournal: gate.writeJournal });
  await pool.open();
  t.after(async () => {
    gate.open();
    await pool.close().catch(() => undefined);
  });

  const doomed = pool.acquire(owner('a'));
  const doomedOutcome = doomed.then(() => ({ granted: true }), error => ({ code: error.code }));
  await gate.reached;
  gate.open();
  assert.deepEqual(await doomedOutcome, { code: 'pool_storage' });
  // The durable reservation still owns slot 0, so it is never handed out again.
  const status = pool.status();
  assert.equal(status.slots[0].state, 'active');
  assert.equal(status.leases[0].state, 'reserved');
  const other = await pool.acquire(owner('b'));
  assert.equal(other.slot, 1, 'the uncertain reservation slot is not reused');
  await assert.rejects(pool.acquire(owner('c')), { code: 'pool_queue_full' });
  await other.release({ drained: true });
  await pool.close();

  // A reload proves the abandoned reservation never started and frees the slot.
  const recovered = new RunnerPool(poolDirectory, { capacity: 2, maxQueue: 0 });
  await recovered.open();
  assert.deepEqual(recovered.status().leases, [], 'the abandoned reservation is cleaned on reload');
  const after = await recovered.acquire(owner('d'));
  assert.equal(after.slot, 0);
  await after.release({ drained: true });
  await recovered.close();
});

// ---------------------------------------------------------------------------
// FIFO promotion settlement: a request promoted out of the queue owns its slot
// promise BEFORE its reservation is adopted, and every promoted request is
// settled on every path - including a reservation that cannot be discarded.
// ---------------------------------------------------------------------------

/**
 * Await one settlement under a hard bound. A `timeout` outcome is the failure
 * this suite is looking for: it means the acquire was left pending forever.
 */
async function boundedSettlement(promise, milliseconds = 5000) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([
      promise.then(
        lease => ({ status: 'resolved', slot: lease.slot }),
        error => ({ status: 'rejected', code: error.code, message: error.message })
      ),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Journal seam for the promotion window, keyed to ONE worker's record so the
 * setup traffic of the outer lease can never trigger it.
 *
 * - `gateOnState` gates the FIRST publish in which that record has the given
 *   state, BEFORE the write happens, so the test observes the window where the
 *   reservation exists in memory but not yet on disk.
 * - `failOnDiscard` then fails the FIRST later publish whose draft no longer
 *   contains that lease, which is exactly discardReservation()'s delete.
 * - The gate ALWAYS opens: explicitly via `open()`, and after `autoOpenMs`, so a
 *   failed assertion can never strand the pool mutex and hang `close()`.
 * - `reached` is BOUNDED exactly like `gatedJournal`: an unreachable promotion
 *   rejects with a fixture error instead of hanging the run, and `waitReached`
 *   adds a per-call bound for tests that want a tighter one.
 */
function promotionJournal(workerId, options = {}) {
  const gateOnState = options.gateOnState ?? 'reserved';
  let leaseId;
  let leaseDirectory;
  let gateConsumed = false;
  let discardFailed = false;
  let opened = false;
  let releaseGate;
  const gate = new Promise(resolve => {
    releaseGate = resolve;
  });
  let signalReached;
  let failReached;
  const reached = new Promise((resolve, reject) => {
    signalReached = resolve;
    failReached = reject;
  });
  // Awaited by the tests: never let the watchdog's rejection go unhandled.
  void reached.catch(() => undefined);
  const autoOpenMs = options.autoOpenMs ?? 5000;
  const open = () => {
    if (!opened) {
      opened = true;
      releaseGate();
    }
  };
  const watchdog = setTimeout(() => {
    open();
    failReached(new Error('the promotion gate was never reached: this scenario is unreachable as written'));
  }, autoOpenMs);
  watchdog.unref();
  /** Bound one wait explicitly; rejects rather than waiting forever. */
  const waitReached = async (milliseconds = 4000) => {
    let timer;
    const bound = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `the promotion gate was not reached within ${milliseconds} ms: this scenario is unreachable as written`
      )), milliseconds);
      timer.unref();
    });
    try {
      await Promise.race([reached, bound]);
    } finally {
      clearTimeout(timer);
    }
  };
  const writeJournal = async (file, text) => {
    const journal = JSON.parse(text);
    const ids = Object.keys(journal.leases);
    if (leaseId !== undefined && !ids.includes(leaseId) && options.failOnDiscard === true && !discardFailed) {
      discardFailed = true;
      throw new Error('simulated disk full while discarding the reservation');
    }
    const mine = ids.find(id => journal.leases[id].owner.workerId === workerId);
    if (!gateConsumed && mine !== undefined && journal.leases[mine].state === gateOnState) {
      gateConsumed = true;
      leaseId = mine;
      leaseDirectory = journal.leases[mine].directory;
      signalReached();
      await gate;
    } else if (mine !== undefined) {
      leaseId = mine;
      leaseDirectory = journal.leases[mine].directory;
    }
    await atomicWrite(file, text, 0o600);
  };
  return {
    writeJournal,
    open,
    waitReached,
    reached,
    leaseId: () => leaseId,
    leaseDirectory: () => leaseDirectory,
    discardFailed: () => discardFailed
  };
}

test('a promoted FIFO request claims its slot before adoption, so the queue bound still holds', { timeout: 20000 }, async t => {
  const { poolDirectory } = await makeStore(t, 'promotion-claim');
  const seam = promotionJournal(owner('b').workerId);
  const pool = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 1, closeTimeoutMs: 500, writeJournal: seam.writeJournal });
  await pool.open();
  t.after(async () => {
    seam.open();
    await pool.close().catch(() => undefined);
  });

  const held = await pool.acquire(owner('a'));
  const pendingB = pool.acquire(owner('b'));
  void pendingB.catch(() => undefined);
  await tick();
  assert.equal(pool.status().queue.length, 1, 'B waits while A holds the only slot');

  // Releasing A promotes B; the seam holds B's reservation publish pre-adoption.
  const released = held.release({ drained: true });
  void released.catch(() => undefined);
  await seam.waitReached();
  const durable = JSON.parse(await fs.readFile(path.join(poolDirectory, 'pool.json'), 'utf8'));
  assert.equal(Object.values(durable.leases).some(record => record.owner.workerId === owner('b').workerId), false,
    'the promotion window is real: B is not durable yet');
  assert.deepEqual(pool.status().slots.map(slot => slot.state), ['free'], 'and the journal slot still looks free');
  assert.deepEqual(pool.status().queue, [], 'B is neither queued nor durable, so only a claim can hold its slot');

  // One request may still wait (maxQueue 1); the next one must be refused.
  const pendingC = pool.acquire(owner('c'));
  void pendingC.catch(() => undefined);
  await tick();
  assert.deepEqual(pool.status().queue.map(entry => entry.owner.ownerId), ['owner-c']);
  const refusedD = await boundedSettlement(pool.acquire(owner('d')));
  assert.equal(refusedD.status, 'rejected');
  assert.equal(refusedD.code, 'pool_queue_full');
  assert.equal(pool.status().queue.length, 1, 'the bound was not exceeded by the in-flight promotion');

  seam.open();
  const leaseB = await pendingB;
  assert.equal(leaseB.slot, 0);
  assert.equal(pool.status().queue.length, 1, 'C still waits exactly once');
  await leaseB.release({ drained: true });
  const leaseC = await pendingC;
  assert.equal(leaseC.slot, 0);
  await leaseC.release({ drained: true });
  assert.deepEqual(pool.status().queue, []);
  assert.deepEqual(pool.status().slots.map(slot => slot.state), ['free']);

  // The bound also holds for maxQueue 0 during a promotion. With maxQueue 0 NO
  // request may wait at all, so the only legal setup is an IMMEDIATE request
  // that is grantable (no lease is held) and therefore promoted at once - never
  // a "held X, then acquire Y" fixture, which is correctly refused up front and
  // would leave nothing to wait for.
  const strictStore = await makeStore(t, 'promotion-claim-strict');
  const strictSeam = promotionJournal(owner('y').workerId);
  const strict = new RunnerPool(strictStore.poolDirectory, { capacity: 1, maxQueue: 0, closeTimeoutMs: 500, writeJournal: strictSeam.writeJournal });
  await strict.open();
  t.after(async () => {
    strictSeam.open();
    await strict.close().catch(() => undefined);
  });
  const pendingY = strict.acquire(owner('y'));
  void pendingY.catch(() => undefined);
  await strictSeam.waitReached();
  assert.equal(pendingY.status, undefined, 'Y is an immediate request that is pending its publish');
  assert.deepEqual(strict.status().queue, [], 'maxQueue 0 never holds a waiting request');
  const refusedZ = await boundedSettlement(strict.acquire(owner('z')));
  assert.equal(refusedZ.status, 'rejected');
  assert.equal(refusedZ.code, 'pool_queue_full', 'the promotion in flight is not a free slot');
  assert.deepEqual(strict.status().queue, [], 'the refusal did not create a waiting request either');
  strictSeam.open();
  const leaseY = await pendingY;
  assert.equal(leaseY.slot, 0, 'and Y is still granted exactly once');
  await leaseY.release({ drained: true });
  assert.deepEqual(strict.status().slots.map(slot => slot.state), ['free']);
});

test('a cancelled promotion whose reservation cannot be discarded rejects promptly and keeps its slot', { timeout: 20000 }, async t => {
  const { poolDirectory } = await makeStore(t, 'discard-failure');
  const seam = promotionJournal(owner('b').workerId, { gateOnState: 'leased', failOnDiscard: true });
  const pool = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 1, closeTimeoutMs: 500, writeJournal: seam.writeJournal });
  await pool.open();
  t.after(async () => {
    seam.open();
    await pool.close().catch(() => undefined);
  });

  const held = await pool.acquire(owner('a'));
  const controller = new AbortController();
  const pendingB = pool.acquire(owner('b'), controller.signal);
  void pendingB.catch(() => undefined);
  await tick();
  assert.equal(pool.status().queue.length, 1);

  // Promote B, cancel it at the adopted 'leased' publish, then let the seam fail
  // the delete publish that discardReservation() performs.
  const released = held.release({ drained: true });
  void released.catch(() => undefined);
  await seam.waitReached();
  controller.abort();
  const startedAt = Date.now();
  seam.open();
  const outcome = await boundedSettlement(pendingB);
  const elapsed = Date.now() - startedAt;
  t.diagnostic(`cancelled acquire settled in ${elapsed} ms`);
  assert.equal(outcome.status, 'rejected', 'the acquire must not be left pending');
  assert.equal(outcome.code, 'pool_storage', 'the cleanup failure keeps its own code');
  assert.match(outcome.message, /could not be discarded/);
  assert.match(outcome.message, /aborted/);
  assert.ok(elapsed < 2000, `settlement must be prompt, took ${elapsed} ms`);
  assert.equal(seam.discardFailed(), true, 'the injected delete failure really happened');

  // Uncertain durable truth is retained: the record stays and keeps its slot.
  const status = pool.status();
  assert.equal(status.slots[0].state, 'active');
  assert.deepEqual(status.queue, []);
  const durable = Object.values(JSON.parse(await fs.readFile(path.join(poolDirectory, 'pool.json'), 'utf8')).leases)
    .filter(record => record.state !== 'released');
  assert.equal(durable.length, 1, 'only the retained reservation is still occupying a slot');
  assert.equal(durable[0].state, 'leased');
  assert.equal(durable[0].process, null, 'no process was ever recorded for a pre-execution grant');
  assert.equal(durable[0].phase, 'reserved');
  assert.ok(status.diagnostics.some(entry => entry.includes('could not be discarded')), 'the retention is reported');
  assert.equal(pool.status().slots[0].leaseId, durable[0].leaseId);

  // The retained slot is never handed out again while it is uncertain.
  const later = pool.acquire(owner('c'));
  void later.catch(() => undefined);
  await tick();
  assert.deepEqual(pool.statusFor(owner('c')), { state: 'queued', position: 1 });

  // close() is honest: nothing can be running (no process identity), the record
  // is retained, and the closing pool still refuses new work.
  const closing = pool.close();
  await assert.rejects(later, { code: 'pool_closed' });
  await closing;
  assert.equal(pool.status().closed, true);

  // A reload proves the retained reservation never started, so capacity returns.
  const reopened = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 0 });
  await reopened.open();
  t.after(() => reopened.close().catch(() => undefined));
  assert.deepEqual(reopened.status().leases, [], 'the never-started reservation is reconciled on reload');
  assert.equal(reopened.status().slots[0].state, 'free');
  const next = await reopened.acquire(owner('d'));
  assert.equal(next.slot, 0);
  await next.release({ drained: true });
  await reopened.close();
});

test('a close during a promotion whose reservation cannot be discarded rejects the request and still completes', { timeout: 20000 }, async t => {
  const { poolDirectory } = await makeStore(t, 'close-discard-failure');
  const seam = promotionJournal(owner('b').workerId, { gateOnState: 'leased', failOnDiscard: true });
  const pool = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 1, closeTimeoutMs: 500, writeJournal: seam.writeJournal });
  await pool.open();
  t.after(async () => {
    seam.open();
    await pool.close().catch(() => undefined);
  });

  const held = await pool.acquire(owner('a'));
  const pendingB = pool.acquire(owner('b'));
  void pendingB.catch(() => undefined);
  await tick();
  const released = held.release({ drained: true });
  void released.catch(() => undefined);
  await seam.waitReached();

  // close() starts while B's promotion is in flight; its delete publish fails.
  const closing = pool.close();
  seam.open();
  const outcome = await boundedSettlement(pendingB);
  assert.equal(outcome.status, 'rejected', 'close must never leave the promoted request pending');
  assert.equal(outcome.code, 'pool_storage');
  assert.match(outcome.message, /closed before this request was granted/);
  assert.match(outcome.message, /could not be discarded/);
  await closing;
  assert.equal(pool.status().closed, true);
  // The retained record is still consumed, and it provably never started.
  const status = pool.status();
  assert.equal(status.slots[0].state, 'active');
  const retained = Object.values(JSON.parse(await fs.readFile(path.join(poolDirectory, 'pool.json'), 'utf8')).leases)
    .filter(record => record.state !== 'released');
  assert.equal(retained.length, 1);
  assert.equal(retained[0].process, null);
  assert.equal(retained[0].phase, 'reserved');
  // Closing twice stays idempotent, and a reload reconciles the record away.
  await pool.close();
  const reopened = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 0 });
  await reopened.open();
  t.after(() => reopened.close().catch(() => undefined));
  assert.deepEqual(reopened.status().leases, []);
  assert.equal(reopened.status().slots[0].state, 'free');
  await reopened.close();
});

test('a promotion whose lease directory became unverifiable is quarantined, not deleted through', { timeout: 20000 }, async t => {
  const { base, poolDirectory } = await makeStore(t, 'discard-unverifiable');
  const seam = promotionJournal(owner('b').workerId, { gateOnState: 'leased' });
  const pool = new RunnerPool(poolDirectory, { capacity: 1, maxQueue: 1, closeTimeoutMs: 500, writeJournal: seam.writeJournal });
  await pool.open();
  t.after(async () => {
    seam.open();
    await pool.close().catch(() => undefined);
  });

  const held = await pool.acquire(owner('a'));
  const controller = new AbortController();
  const pendingB = pool.acquire(owner('b'), controller.signal);
  void pendingB.catch(() => undefined);
  await tick();
  const released = held.release({ drained: true });
  void released.catch(() => undefined);
  await seam.waitReached();

  // Swap the promoted lease directory for a junction: the discard's own
  // filesystem proof refuses to delete it, which is the shared removal path.
  const outside = path.join(base, 'outside-discard');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep me');
  const leaseDirectory = seam.leaseDirectory();
  assert.ok(leaseDirectory.startsWith(poolDirectory), 'the captured directory belongs to this pool');
  const linked = fs.rm(leaseDirectory, { recursive: true, force: true })
    .then(() => fs.symlink(outside, leaseDirectory, process.platform === 'win32' ? 'junction' : 'dir'))
    .then(() => true, () => false);
  controller.abort();
  const isLinked = await linked;
  seam.open();
  const outcome = await boundedSettlement(pendingB);
  assert.equal(outcome.status, 'rejected');
  if (!isLinked) {
    t.diagnostic('symlink/junction creation is unavailable; the unverifiable-directory case was not exercised');
  } else {
    assert.equal(outcome.code, 'pool_aborted', 'an unverifiable directory is quarantined, not an error');
    assert.equal(pool.status().slots[0].state, 'quarantined');
    assert.equal(await exists(leaseDirectory), true, 'the unverifiable directory is retained');
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep me', 'the link target was never touched');
  }
});

test('a release whose aggregate reconcile fails after adoption still settles and drains', { timeout: 20000 }, async t => {
  let injected = false;
  const admission = { tryAcquire: async () => true, cancel: async () => {}, reconcile: async records => {
    if (!injected && records.some(record => record.state === 'released')) {
      injected = true;
      throw Error('simulated aggregate reconcile failure');
    }
  } };
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 0, admission });
  const lease = await pool.acquire(owner('adopted'));
  // The drained release verifiably removes the directory and ADOPTS its
  // 'released' revision, and only then does the aggregate reconcile of that same
  // publish throw. The record is durable and released, but the live lease never
  // reached finishLease.
  await assert.rejects(lease.release({ drained: true }), /simulated aggregate reconcile failure/);
  assert.equal(pool.leaseRecord(lease.id).state, 'released');
  assert.equal(pool.status().slots[0].state, 'free');
  assert.equal(await exists(lease.directory), false);
  // Collecting that tombstone must keep the record, because a live lease in this
  // process still owns it; dropping it would turn the exact retry into
  // pool_unknown_lease and leave a live entry close() could never drain.
  assert.equal(await pool.collectReleased(scopeOf('adopted')), 0);
  assert.equal(pool.leaseRecord(lease.id).state, 'released');
  const retried = await lease.release({ drained: true });
  assert.equal(retried.state, 'released');
  assert.equal(retried.deleted, true);
  // The retry settled the lease, so collection is allowed and shutdown drains.
  assert.equal(await pool.collectReleased(scopeOf('adopted')), 1);
  assert.deepEqual(pool.status().leases, []);
  await pool.close();
  assert.equal(pool.status().closed, true);
});

test('collecting released tombstones keeps a record whose directory is still present', { timeout: 20000 }, async t => {
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 0 });
  const lease = await pool.acquire(owner('tombstone'));
  await lease.release({ drained: true });
  // A directory that reappears under a released lease is unproven layout: the
  // record is retained (cleanup reports it, collection refuses it) instead of
  // orphaning the directory as an unknown entry no record could reconcile.
  await fs.mkdir(path.join(lease.directory, 'temp'), { recursive: true });
  const cleanup = await pool.cleanup(scopeOf('tombstone'));
  assert.equal(pool.leaseRecord(lease.id).state, 'released');
  assert.ok(cleanup.retained.some(entry => entry.leaseId === lease.id));
  assert.ok(pool.status().unknownEntries.some(entry => entry.endsWith(lease.id)));
  assert.equal(await pool.collectReleased(scopeOf('tombstone')), 0);
  assert.equal(pool.leaseRecord(lease.id).state, 'released');
  await fs.rm(lease.directory, { recursive: true, force: true });
  assert.equal(await pool.collectReleased(scopeOf('tombstone')), 1);
  assert.deepEqual(pool.status().leases, []);
});

test('cross-root legacy occupancy never reserves aggregate capacity for a blocked runner', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-roots-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  // Two slots overall with the fixed one-slot service reserve, so a work ticket
  // waits as soon as one work ticket is active.
  const config = { ...resourceDefaults, enabled: true, runnerCapacity: 2 };
  const resources = new ResourceGovernor(() => config, path.join(base, 'resources'));
  t.after(() => resources.close().catch(() => undefined));
  const rootA = path.join(base, 'root-a'), rootB = path.join(base, 'root-b');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  const scopeA = path.join(base, 'store-a', 'pool'), scopeB = path.join(base, 'store-b', 'pool');
  // Same shape the broker builds: a legacy (non-governed) owner opts out of
  // governed admission and keeps its original per-pool behavior.
  const admissionFor = (scope, root) => {
    const admission = resources.runnerAdmission(scope, root, candidate => candidate.ownerId);
    return { ...admission, applies: candidate => candidate.ownerId !== 'legacy' };
  };
  const poolA = new RunnerPool(scopeA, { projectRoot: rootA, capacity: 2, maxQueue: 4, closeTimeoutMs: 2000, admission: admissionFor(scopeA, rootA) });
  const poolB = new RunnerPool(scopeB, { projectRoot: rootB, capacity: 1, maxQueue: 4, closeTimeoutMs: 2000, admission: admissionFor(scopeB, rootB) });
  await poolA.open();
  await poolB.open();
  t.after(async () => { await poolA.close().catch(() => undefined); await poolB.close().catch(() => undefined); });
  const who = (lane, id) => ({ ownerId: lane, teamId: TEAM, workerId: hex32(`roots-${id}`), workerCreatedAt: ISO });
  const runnerClaims = async () => (await resources.status()).claims.filter(claim => claim.kind === 'runner');

  const held = await poolA.acquire(who('work', 'a1'));
  const waiting = poolB.acquire(who('work', 'b1')).then(lease => ({ lease }), error => ({ error }));
  // B's governed ticket is queued in the aggregate (the one work slot is taken).
  await until(async () => (await runnerClaims()).some(claim => claim.scope === scopeB && claim.state === 'waiting'));
  // Legacy occupancy fills B's only physical slot WITHOUT an aggregate claim.
  const legacy = await poolB.acquire(who('legacy', 'b-legacy'));
  assert.deepEqual(poolB.status().slots.map(slot => slot.state), ['active']);
  await held.release({ drained: true });

  // A's next poll must not hand aggregate capacity to B's now physically blocked
  // ticket: only B's own pool can prove a usable slot.
  const next = await admissionDeadline(poolA.acquire(who('work', 'a2')), 10000);
  assert.ok(next);
  const afterPromotion = await runnerClaims();
  assert.equal(afterPromotion.find(claim => claim.scope === scopeB).state, 'waiting', 'a blocked ticket holds no aggregate capacity');
  assert.equal(afterPromotion.find(claim => claim.scope === scopeA).state, 'active');
  // ...and it must not block eligible work in another root either.
  await next.release({ drained: true });
  const third = await admissionDeadline(poolA.acquire(who('work', 'a3')), 10000);
  assert.equal(poolA.status().slots.filter(slot => slot.state === 'active').length, 1, 'the other root keeps handing out its own physical slot');
  await third.release({ drained: true });
  // The queued ticket runs as soon as its own pool has a usable physical slot,
  // and only then: oldest-eligible FIFO inside that pool is unchanged.
  await legacy.release({ drained: true });
  const granted = await admissionDeadline(waiting, 10000);
  assert.ok(granted.lease, JSON.stringify(granted.error));
  await granted.lease.release({ drained: true });
  assert.deepEqual(await runnerClaims(), []);
  assert.equal(poolA.status().slots.filter(slot => slot.state === 'free').length, 2);
  assert.equal(poolB.status().slots.filter(slot => slot.state === 'free').length, 1);
});

test('an unused opted-out legacy runner scope never touches the shared ledger while retained claims still reconcile', { timeout: 60000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-optout-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  const config = { ...resourceDefaults, enabled: false };
  const errors = [];
  const broker = new WorkerBroker({
    storage: path.join(base, 'storage'), registry: path.join(base, 'bridges'), roots: [root], identity: 'test',
    provider: { models: async () => [], countTokens: async () => 0, stream: async function* () { yield { type: 'text', text: 'idle' }; } },
    settings: () => ({ maxTurns: 1, maxToolRounds: 1, turnTimeoutMs: 1000, maxOutputChars: 1000, maxHistoryBytes: 100000, maxSessions: 4, retries: 0 }),
    taskBoardEnabled: () => false, isolatedViewsEnabled: () => true,
    resources: () => config, resourceDirectory: path.join(base, 'resources'),
    runners: () => ({ enabled: true, capacity: 1, maxQueue: 4 }),
    files: { canWrite: () => true, allowShell: () => true, approveCommand: async () => true },
    onChange: () => {}, onError: message => errors.push(message)
  });
  await broker.start();
  t.after(() => broker.close().catch(() => undefined));
  const local = broker.local.get(root);
  const model = { id: 'byok/qwen', name: 'Qwen', vendor: 'test', family: 'qwen', version: '1', maxInputTokens: 1000 };
  // A current standalone (non-governed) session: it never opted into
  // governed runners.
  const create = async label => {
    const id = hex32(`opt-out-${label}`);
    await local.store.create({ schema: 3, mode: 'standalone', id, title: label, model, instructions: '', permission: 'workspace-write', state: 'completed',
      messages: [], turns: [{ id: `turn-${label}`, input: label, state: 'completed', started: true, attempts: 1, output: 'done', tools: [], createdAt: ISO, updatedAt: ISO }],
      operations: {}, revision: 1, createdAt: ISO, updatedAt: ISO, ownerId: 'parent' });
    return id;
  };
  const manager = await local.isolation.openRunners();
  const leaseOf = async label => manager.pool.acquire({ ownerId: 'parent', teamId: TEAM, workerId: await create(label), workerCreatedAt: ISO });

  // A status call or another root participating flips the broker-wide flag; it
  // must not make this unused opted-out scope write the shared ledger.
  broker.resourceUsed = true;
  const first = await leaseOf('one');
  assert.equal((await first.release({ drained: true })).state, 'released');
  assert.equal(await broker.resources.hasState(), false,
    'an unused opted-out legacy runner scope never creates or reads the aggregate namespace');
  assert.deepEqual(errors, []);

  // A claim retained from an earlier governed run is still reconciled after
  // opt-out: participation is the local registration plus this exact scope, not
  // the broker-wide flag.
  config.enabled = true;
  const scope = path.join(local.store.directory, 'runners', 'pool');
  await broker.resources.account(local.store.directory, async () => 0);
  const stable = await broker.resources.runnerScope(scope);
  const retained = `runner:${digest(stable)}:${first.id}`;
  const seeded = await broker.resources.tryAcquire({ key: retained, kind: 'runner', root, scope: stable, lane: 'work', localCapacity: 1, bytes: 1024 ** 3 });
  assert.equal(seeded.granted, true);
  config.enabled = false;
  const second = await leaseOf('two');
  assert.equal((await second.release({ drained: true })).state, 'released');
  assert.deepEqual((await broker.resources.status()).claims.filter(claim => claim.kind === 'runner'), [],
    'the retained claim of a released lease is reconciled after opt-out');
  assert.deepEqual(errors, []);
});

test('a runner handoff respects older storage tickets before they claim capacity', async t => {
  const { base, project } = await makePool(t);
  const gib = 1024 ** 3;
  const resources = new ResourceGovernor(() => ({ ...resourceDefaults, enabled: true, storageBytes: 2 * gib }), path.join(base, 'resources'));
  t.after(() => resources.close());
  const hold = { key: 'hold', kind: 'storage', lane: 'validation', root: project, bytes: 1.5 * gib };
  const older = { ...hold, key: 'older', bytes: 1.25 * gib };
  const runner = { key: 'runner', kind: 'runner', lane: 'validation', root: project, bytes: gib };
  assert.equal((await resources.tryAcquire(hold)).granted, true);
  assert.equal((await resources.tryAcquire(older)).granted, false);
  assert.equal((await resources.tryAcquire(runner)).granted, false);
  await resources.release(hold.key);
  assert.deepEqual(await resources.tryAcquire(runner), { granted: false, reason: 'storage' });
  const status = await resources.status();
  assert.equal(status.claims.find(claim => claim.key === older.key).state, 'waiting');
  assert.equal(status.summary.reservedBytes, 0);
  assert.equal((await resources.tryAcquire(older)).granted, true);
  assert.equal((await resources.status()).summary.reservedBytes, older.bytes);
  assert.deepEqual(await resources.tryAcquire(runner), { granted: false, reason: 'storage' });
  await resources.release(older.key);
  assert.equal((await resources.tryAcquire(runner)).granted, true);
  await resources.release(runner.key);
});

test('a younger cross-root contender cannot overtake an older physically eligible runner', { timeout: 30000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-overtake-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = { ...resourceDefaults, enabled: true, runnerCapacity: 2 };
  const resources = new ResourceGovernor(() => config, path.join(base, 'resources'));
  t.after(() => resources.close().catch(() => undefined));
  const admissionFor = async name => {
    const root = path.join(base, 'project-' + name);
    await fs.mkdir(root, { recursive: true });
    return resources.runnerAdmission(path.join(base, 'store-' + name, 'pool'), root, () => 'validation');
  };
  const older = await admissionFor('older'), younger = await admissionFor('younger'), filler = await admissionFor('filler');
  const who = id => ({ ownerId: 'parent', teamId: TEAM, workerId: hex32('overtake-' + id), workerCreatedAt: ISO });
  const id = label => label.repeat(32);
  const ledger = async () => (await resources.status()).claims.filter(claim => claim.kind === 'runner');
  const stateOf = async label => (await ledger()).find(claim => claim.key.endsWith(id(label)))?.state;
  try {
    // A third root fills the aggregate runner bound, so the OLDER ticket below
    // must be created while there is no aggregate room for it.
    assert.equal(await filler.tryAcquire(id('c'), who('c1'), 2), true);
    assert.equal(await filler.tryAcquire(id('d'), who('c2'), 2), true);
    assert.equal(await older.tryAcquire(id('a'), who('a1'), 1), false, 'the older ticket waits for aggregate capacity');
    // Free exactly one aggregate slot: the older ticket is now physically and
    // aggregately eligible, but its own pool has not polled yet.
    await filler.cancel(id('c'));
    // The YOUNGER root polls first. Sequence order wins, not polling order, and
    // the younger poll must not mark the older ticket active either.
    assert.equal(await younger.tryAcquire(id('b'), who('b1'), 1), false, 'a younger poll never overtakes an older eligible runner');
    assert.equal(await stateOf('a'), 'waiting');
    assert.equal(await stateOf('b'), 'waiting');
    assert.equal((await ledger()).filter(claim => claim.state === 'active').length, 1, 'no phantom runner ownership was created');
    // The older ticket's own poll takes the handoff, activating exactly itself.
    assert.equal(await older.tryAcquire(id('a'), who('a1'), 1), true);
    assert.equal(await stateOf('a'), 'active');
    assert.equal(await stateOf('b'), 'waiting', 'one handoff activates exactly one ticket');
    assert.equal((await ledger()).filter(claim => claim.state === 'active').length, 2);
  } finally {
    for (const [admission, label] of [[older, 'a'], [younger, 'b'], [filler, 'c'], [filler, 'd']]) {
      await admission.cancel(id(label)).catch(() => undefined);
    }
  }
  assert.deepEqual(await ledger(), []);
});

test('one local handoff grants a single claim and never blocks other roots on a physically full pool', { timeout: 40000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-pool-handoff-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root, { recursive: true });
  const config = { ...resourceDefaults, enabled: true, runnerCapacity: 2 };
  const resources = new ResourceGovernor(() => config, path.join(base, 'resources'));
  t.after(() => resources.close().catch(() => undefined));
  const scope = path.join(base, 'store', 'pool');
  const other = resources.runnerAdmission(path.join(base, 'other-store', 'pool'), path.join(base, 'other-project'), () => 'validation');
  const admission = resources.runnerAdmission(scope, root, () => 'validation');
  // The broker's shape: a legacy (non-governed) owner keeps its original
  // per-pool behavior and holds no aggregate runner claim.
  const pool = new RunnerPool(scope, {
    projectRoot: root, capacity: 3, maxQueue: 4, closeTimeoutMs: 2000,
    admission: { ...admission, applies: candidate => candidate.ownerId !== 'legacy' }
  });
  await pool.open();
  t.after(() => pool.close().catch(() => undefined));
  const who = (lane, label) => ({ ownerId: lane, teamId: TEAM, workerId: hex32('handoff-' + label), workerCreatedAt: ISO });
  const id = label => label.repeat(32);
  const held = promise => promise.then(lease => ({ lease }), error => ({ error }));
  const local = async state => (await resources.status()).claims
    .filter(claim => claim.kind === 'runner' && claim.scope === scope && claim.state === state);
  const legacy = [];
  try {
    legacy.push(await pool.acquire(who('legacy', 'l1')));
    legacy.push(await pool.acquire(who('legacy', 'l2')));
    // Fill the aggregate bound from another root: both governed tickets still get
    // a waiting claim (one physical slot is free) without reserving any.
    assert.equal(await other.tryAcquire(id('p'), who('parent', 'p1'), 2), true);
    assert.equal(await other.tryAcquire(id('q'), who('parent', 'p2'), 2), true);
    const first = held(pool.acquire(who('work', 'w1')));
    const second = held(pool.acquire(who('work', 'w2')));
    await until(async () => (await local('waiting')).length === 2);
    // Occupy the last physical slot, then free exactly one aggregate slot, so a
    // single physical slot and a single aggregate slot remain for two tickets.
    legacy.push(await pool.acquire(who('legacy', 'l3')));
    await other.cancel(id('q'));
    await legacy[0].release({ drained: true });
    const one = await admissionDeadline(first, 10000);
    assert.ok(one.lease, JSON.stringify(one.error));
    assert.equal((await local('active')).length, 1, 'one local handoff grants exactly one runner claim');
    assert.equal((await local('waiting')).length, 1);
    assert.equal(pool.status().queue.length, 1);
    // The waiting ticket is physically blocked by its own pool (three legacy
    // slots were full), so it must not take the next handoff from another root.
    await other.cancel(id('p'));
    const service = resources.runnerAdmission(path.join(base, 'service-store', 'pool'), path.join(base, 'service-project'), () => 'validation');
    assert.equal(await service.tryAcquire(id('s'), who('parent', 's1'), 1), true, 'a physically blocked ticket holds no handoff');
    assert.equal((await local('active')).length, 1);
    assert.equal((await local('waiting')).length, 1, 'the blocked ticket waits instead of holding aggregate capacity');
    await service.cancel(id('s'));
    // Freed physical capacity promotes it through its own pool, in order.
    await one.lease.release({ drained: true });
    const two = await admissionDeadline(second, 15000);
    assert.ok(two.lease, JSON.stringify(two.error));
    await two.lease.release({ drained: true });
    assert.deepEqual(await local('active'), []);
  } finally {
    for (const lease of legacy) {
      await lease.release({ drained: true }).catch(() => undefined);
    }
    for (const label of ['p', 'q']) {
      await other.cancel(id(label)).catch(() => undefined);
    }
  }
});

test('a throwing admission applicability check settles that request instead of wedging the queue', async t => {
  const admission = {
    applies: candidate => {
      if (candidate.ownerId === 'owner-poison') {
        throw Error('applicability unavailable');
      }
      return true;
    },
    tryAcquire: async () => true,
    cancel: async () => {},
    reconcile: async () => {}
  };
  const { pool } = await makePool(t, { capacity: 1, maxQueue: 2, admission });
  const poison = pool.acquire(owner('poison')).then(lease => ({ lease }), error => ({ error }));
  // The refusal must be a settled rejection carrying its own cause, never a
  // pending promise and never a request left at the head of the queue.
  const settled = await admissionDeadline(poison);
  assert.equal(settled.lease, undefined);
  assert.match(settled.error?.message ?? '', /applicability unavailable/);
  const survivor = await admissionDeadline(pool.acquire(owner('survivor')));
  assert.ok(survivor, 'the queue kept serving the next request');
  assert.deepEqual(pool.status().queue, []);
  await survivor.release({ drained: true });
  assert.equal(pool.status().slots[0].state, 'free');
});
