'use strict';
// Regression for review finding P2 (review 12): a provisional grant's OWN
// publication backoff (1+2+4+8 s = 15 s) used to outlive the 10 s ticket liveness
// window. The heartbeat is stamped BEFORE the rename that makes the row durable,
// so such a grant was already 15 s old at its first publication, the
// acknowledgement transaction's own sweep withdrew it, and `acquire` re-admitted
// and re-published the same key forever without ever returning a permit.
//
// These cases use a controlled clock (the governor ctor's `now`) together with a
// recorded global setTimeout that advances that clock and resolves via
// queueMicrotask, exactly like tests/atomic-write.test.cjs. Only the publication
// rename of one exact PRIVATE ledger is faulted; every other rename stays real, so
// the assertions read real files. No live user ledger, no wall-clock backoff and
// no fake-timer poll loop is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const buildDir = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { atomicWriteRenameRetryBudgetMs } = require(path.join(buildDir, 'storage'));
const {
  ResourceGovernor, resourceDefaults, transactionLockWaitMs, WAITING_TICKET_WINDOW_MS
} = require(path.join(buildDir, 'resource-governor'));

const MIB = 1024 * 1024;
const RENAME_SCHEDULE = [1_000, 2_000, 4_000, 8_000]; // unchanged five attempts / four delays
const POLL_MS = 25; // unchanged transaction lock poll interval
const config = { ...resourceDefaults, enabled: true, modelCapacity: 2, runnableCapacity: 2, runnerCapacity: 2 };

/** Record every requested timeout delay and advance a fake clock instead of waiting. */
function controlledClock(t, start = 1_700_000_000_000, onDelay) {
  const clock = { now: start };
  const requested = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    requested.push(delay);
    clock.now += delay;
    onDelay?.(delay, requested.length);
    queueMicrotask(callback);
    return 0;
  });
  return { clock, requested };
}

async function ledger(directory) {
  return JSON.parse(await fsp.readFile(path.join(directory, 'ledger.json'), 'utf8'));
}

async function rowOf(directory, key) {
  return (await ledger(directory)).claims.find(claim => claim.key === key);
}

/**
 * Deny exactly the first four rename attempts of every ledger publication whose
 * OWN row is provisional, then let the fifth attempt really publish it. That is
 * the shipped allowance used in full, so the row is durable only after its whole
 * 1+2+4+8 s budget and the heartbeat recorded before it is that old.
 *
 * The returned switch must be disarmed before any OTHER caller's transaction runs:
 * a peer's ledger publication also contains this still-pending provisional row,
 * and only the handoff's own publication is the one being regressed.
 */
function provisionalRenameFaults(t, key, clock, publications, onFault) {
  const real = fsp.rename;
  const attempts = new Map();
  const armed = { value: true };
  t.after(() => { fsp.rename = real; });
  fsp.rename = async (from, to) => {
    if (armed.value && String(to).endsWith(path.sep + 'ledger.json')) {
      let row;
      try {
        row = JSON.parse(await fsp.readFile(String(from), 'utf8')).claims?.find(claim => claim.key === key);
      } catch {
        row = undefined;
      }
      if (row?.state === 'provisional') {
        const attempt = (attempts.get(String(from)) ?? 0) + 1;
        attempts.set(String(from), attempt);
        if (attempt <= RENAME_SCHEDULE.length) {
          onFault?.(attempt);
          throw Object.assign(new Error('EPERM: injected provisional-grant rename denial'), { code: 'EPERM' });
        }
        publications.push({ sequence: row.sequence, heartbeat: row.heartbeat,
          ageAtPublication: clock.now - row.heartbeat, faultsBeforeSuccess: attempt - 1 });
      }
    }
    return real.call(fsp, from, to);
  };
  return armed;
}

test('a grant published after its whole 15 s rename backoff is acknowledged on its first grant, not re-admitted', { timeout: 20000 }, async t => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'resource-ticket-first-grant-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources-v1');
  const { clock, requested } = controlledClock(t);
  const governor = new ResourceGovernor(() => config, directory, () => clock.now);
  t.after(() => governor.close().catch(() => undefined));
  const key = 'model:first-grant';
  const request = { key, kind: 'model', root: base, scope: 'scope-a', model: 'model-a', localCapacity: 1, bytes: 2 * MIB };
  const publications = [];
  provisionalRenameFaults(t, key, clock, publications);

  const controller = new AbortController();
  const grants = [];
  const outcome = await governor.acquire(request, controller.signal, async reason => {
    if (reason !== undefined) {
      return;
    }
    grants.push(await rowOf(directory, key));
    if (grants.length > 1) {
      // A second grant announcement here is the reported regrant loop; stop it so
      // the assertions below report that instead of a test timeout.
      controller.abort();
    }
  }).then(permit => ({ permit }), error => ({ error }));

  assert.equal(outcome.error, undefined, 'the handoff is acknowledged, never aborted or re-admitted');
  assert.ok(outcome.permit, 'one active permit is returned');
  assert.equal(grants.length, 1, 'the grant callback ran exactly once: no regrant loop');
  assert.equal(grants[0]?.state, 'provisional', 'the announcement is made from the durable provisional row');
  assert.equal(publications.length, 1, 'the provisional grant was published once, not once per loop');
  assert.equal(publications[0].faultsBeforeSuccess, RENAME_SCHEDULE.length,
    'the publication succeeded on the fifth attempt after the four injected denials');
  assert.equal(publications[0].ageAtPublication, atomicWriteRenameRetryBudgetMs,
    'the heartbeat was stamped before its own fully spent publication budget, not after the rename');
  assert.ok(publications[0].ageAtPublication > 10_000,
    'the old 10 s window would already have called this live handoff expired');
  assert.deepEqual(requested, RENAME_SCHEDULE, 'the unchanged 1/2/4/8 s backoff is the only wait involved');

  const row = await rowOf(directory, key);
  assert.equal(row?.state, 'active', 'the acknowledged handoff is a real effect');
  assert.equal('heartbeat' in row, false, 'an admitted effect carries no liveness stamp');
  assert.equal(row.sequence, publications[0].sequence, 'the handoff kept its own queue identity');
  const charged = await governor.status();
  assert.equal(charged.summary.reservedBytes, 2 * MIB, 'the active permit is charged');
  assert.equal(charged.summary.waiting, 0, 'no ticket is left behind');

  await outcome.permit.release();
  assert.deepEqual((await ledger(directory)).claims, [], 'release settles the claim exactly once');
  assert.equal((await governor.status()).summary.reservedBytes, 0, 'the private ledger is clean again');
});

test('a 15 s handoff publication plus a following 80 s lock wait acknowledges without losing handoff or waiting identity', { timeout: 20000 }, async t => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'resource-ticket-lock-wait-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources-v1');
  const { clock } = controlledClock(t);
  const owner = new ResourceGovernor(() => config, directory, () => clock.now);
  const peer = new ResourceGovernor(() => config, directory, () => clock.now);
  t.after(() => owner.close().catch(() => undefined));
  t.after(() => peer.close().catch(() => undefined));
  const key = 'model:owner';
  const waitingKey = 'model:waiter';
  const scope = 'scope-shared';
  const request = target => ({ key: target, kind: 'model', root: base, scope, model: 'model-a',
    localCapacity: 1, bytes: 2 * MIB });
  const publications = [];
  const armed = provisionalRenameFaults(t, key, clock, publications);

  // The peer holds the aggregate lock through the owner's acknowledgement. The
  // bounded 25 ms poll is resolved immediately against the fake clock, so the whole
  // derived allowance is exercised without an 80 s wall wait, and the lock is
  // released during the LAST allowed poll: a shorter allowance would fail closed.
  const timers = require('node:timers/promises');
  const realDelay = timers.setTimeout;
  const polls = [];
  const lock = path.join(directory, 'transaction.lock');
  t.after(() => { timers.setTimeout = realDelay; });
  timers.setTimeout = async (wait, value) => {
    polls.push(wait);
    clock.now += wait;
    if (polls.length === Math.ceil(transactionLockWaitMs / POLL_MS)) {
      await fsp.rm(lock, { force: true });
    }
    return value;
  };

  let handoffSequence;
  let waitingSequence;
  const outcome = await owner.acquire(request(key), new AbortController().signal, async reason => {
    if (reason !== undefined) {
      return;
    }
    // Only the handoff's own publication is faulted; anything after this point is
    // another caller's transaction on the shared ledger.
    armed.value = false;
    handoffSequence = (await rowOf(directory, key))?.sequence;
    // A live waiting ticket of ANOTHER host already exists while this handoff is
    // pending: the shared local bound keeps it queued, not admitted.
    assert.deepEqual(await peer.tryAcquire(request(waitingKey)), { granted: false, reason: 'model_capacity' });
    waitingSequence = (await rowOf(directory, waitingKey))?.sequence;
    await fsp.writeFile(lock, JSON.stringify({ pid: process.pid, host: 'contending-peer' }));
  }).then(permit => ({ permit }), error => ({ error }));

  assert.equal(outcome.error, undefined, `the acknowledgement completes after the peer releases the lock (${outcome.error?.code ?? 'ok'})`);
  assert.ok(outcome.permit, 'one active permit is returned');
  assert.equal(publications.length, 1, 'the provisional grant was published once');
  assert.equal(publications[0].ageAtPublication, atomicWriteRenameRetryBudgetMs,
    'its heartbeat predates the publication that made it durable');
  assert.equal(polls.length, Math.ceil(transactionLockWaitMs / POLL_MS),
    'the acknowledgement really waited the whole derived lock allowance');
  assert.deepEqual([...new Set(polls)], [POLL_MS], 'every poll used the unchanged 25 ms interval');
  assert.equal(clock.now - publications[0].heartbeat, atomicWriteRenameRetryBudgetMs + transactionLockWaitMs,
    'the live handoff was already publication budget + lock wait old when its acknowledgement committed');
  assert.ok(WAITING_TICKET_WINDOW_MS > atomicWriteRenameRetryBudgetMs + transactionLockWaitMs,
    'the derived window covers both unavoidable waits plus its own callback/poll/I/O margin');

  const acknowledged = await rowOf(directory, key);
  assert.equal(acknowledged?.state, 'active', 'the handoff became a real effect instead of being swept');
  assert.equal('heartbeat' in acknowledged, false, 'an admitted effect carries no liveness stamp');
  assert.equal(acknowledged.sequence, handoffSequence, 'the handoff kept its own queue identity');
  const queued = await rowOf(directory, waitingKey);
  assert.equal(queued?.state, 'waiting', 'the peer lock wait never expired the live waiting ticket');
  assert.equal(queued.sequence, waitingSequence, 'the live waiting ticket kept its queue position');
  assert.equal((await owner.status()).summary.reservedBytes, 2 * MIB, 'only the active permit is charged');

  await outcome.permit.release();
  assert.deepEqual(await peer.tryAcquire(request(waitingKey)), { granted: true },
    'the waiting ticket is admitted after release, without re-admission');
  const admitted = await rowOf(directory, waitingKey);
  assert.equal(admitted.state, 'active');
  assert.equal(admitted.sequence, waitingSequence, 'the original queue identity became the admitted effect');
  await peer.release(waitingKey);
  assert.deepEqual((await ledger(directory)).claims, [], 'both private claims are settled');
});

test('a cancellation during the handoff publication leaves no permit and withdraws its own no-effect row', { timeout: 20000 }, async t => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'resource-ticket-cancel-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'resources-v1');
  const controller = new AbortController();
  const { clock, requested } = controlledClock(t);
  const governor = new ResourceGovernor(() => config, directory, () => clock.now);
  t.after(() => governor.close().catch(() => undefined));
  const key = 'model:cancelled';
  const publications = [];
  // Cancel from inside the second injected denial: the provisional publication is
  // still retrying, so the grant is not durable yet when the caller goes away.
  provisionalRenameFaults(t, key, clock, publications, attempt => {
    if (attempt === 2) {
      controller.abort();
    }
  });

  const announcements = [];
  const outcome = await governor.acquire({ key, kind: 'model', root: base, scope: 'scope-cancel',
    model: 'model-a', localCapacity: 1, bytes: 2 * MIB }, controller.signal, async reason => {
    if (reason === undefined) {
      announcements.push(clock.now);
    }
  }).then(permit => ({ permit }), error => ({ error }));

  assert.equal(outcome.permit, undefined, 'a cancelled handoff never yields a permit');
  assert.equal(outcome.error?.name, 'AbortError', 'the cancellation is reported unchanged');
  assert.equal(announcements.length, 1, 'the announcement still happened before the cancellation check');
  assert.equal(publications.length, 1, 'the provisional publication still completed after the cancellation');
  assert.deepEqual(requested, RENAME_SCHEDULE, 'the publication retried its unchanged schedule');
  assert.deepEqual((await ledger(directory)).claims, [],
    'the caller-owned withdrawal removed its own no-effect row: nothing is left active or provisional');
  assert.equal((await governor.status()).summary.reservedBytes, 0, 'nothing stays charged');
});
