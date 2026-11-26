'use strict';
// Regression for review finding P2: one transaction holds the aggregate lock
// while atomicWrite retries a transiently denied publication rename with the real
// 1/2/4 s backoff. A contender therefore has to wait out ONE live holder's whole
// publication budget, and an earlier successful peer action must not be left
// write-fenced, uncertain or quarantined by that contention.
//
// The two main cases use the real rename schedule (~7 s each) against a PRIVATE
// mkdtemp namespace and private store directories: no live ledger is read or
// written. The remaining cases are deterministic: the derived budget is compared
// directly, and an unavailable lock is exercised with only the 25 ms poll delay
// replaced by an immediate resolution (a controlled test clock, not real sleeps).
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const buildDir = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { atomicWriteRenameRetryBudgetMs } = require(path.join(buildDir, 'storage'));
const { ResourceGovernor, resourceDefaults, transactionLockWaitMs } = require(path.join(buildDir, 'resource-governor'));

const config = () => ({ ...resourceDefaults, enabled: true });
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, code: error?.code, message: error?.message }));

async function fixture(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'resource-lock-retry-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const ledgerDirectory = path.join(base, 'resources-v1');
  const storeA = path.join(base, 'storeA');
  const storeB = path.join(base, 'storeB');
  await fsp.mkdir(storeA, { recursive: true });
  await fsp.mkdir(storeB, { recursive: true });
  return { base, ledgerDirectory, storeA, storeB, a: new ResourceGovernor(config, ledgerDirectory), b: new ResourceGovernor(config, ledgerDirectory) };
}

/** Deny exactly `count` ledger publication renames; every other rename stays real. */
function ledgerRenameFaults(t, count, onFirstFault) {
  const real = fsp.rename;
  let injected = 0;
  fsp.rename = async (from, to) => {
    if (injected < count && String(to).endsWith(path.sep + 'ledger.json')) {
      injected += 1;
      if (injected === 1) { onFirstFault?.(); }
      throw Object.assign(new Error('EPERM: injected rename denial (ledger)'), { code: 'EPERM' });
    }
    return real.call(fsp, from, to);
  };
  t.after(() => { fsp.rename = real; });
  return () => injected;
}

test('the transaction lock wait is the derived five-publication budget plus its margin', () => {
  assert.equal(atomicWriteRenameRetryBudgetMs, 15_000, 'the shared budget is the 1+2+4+8 s rename schedule, derived not restated');
  assert.equal(transactionLockWaitMs, 5 * atomicWriteRenameRetryBudgetMs + 5_000,
    'one transaction can publish five times (pending marker, empty ledger, established marker, registerStore marker, final ledger)');
  assert.equal(transactionLockWaitMs, 80_000, 'a contender behind one valid holder waits the audited bound');
});

test('a contender acquires the lock after the holder publishes through its whole 1/2/4 s retry', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  await f.a.withStoreWrite(f.storeA, async () => undefined, async () => 0);
  assert.equal(await f.a.hasState(), true, 'the private namespace starts established');

  let contender;
  const injected = ledgerRenameFaults(t, 3, () => { contender = settle(f.b.account(f.storeB, async () => 0)); });

  const started = Date.now();
  const holder = await settle(f.a.account(f.storeA, async () => 0));
  const holderElapsed = Date.now() - started;
  const peer = await contender;

  assert.equal(injected(), 3, 'the holder published on its fourth rename attempt');
  assert.equal(holder.ok, true, 'the holder publishes after the real backoff');
  assert.ok(holderElapsed >= 6_500, `the holder kept the lock through 1s+2s+4s (observed ${holderElapsed}ms)`);
  assert.ok(holderElapsed < 15_000, 'the real publication retry stays bounded');
  assert.equal(peer.ok, true, 'the contender waits out the live holder instead of failing after 5 s');
  assert.equal(await f.a.hasState(), true, 'the shared namespace is still established and readable');
  assert.equal((await fsp.readdir(f.ledgerDirectory)).includes('transaction.lock'), false, 'the released lock is gone');
});

test('a peer publication retry leaves no earlier successful action fenced, uncertain or quarantined', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  await f.a.withStoreWrite(f.storeA, async () => undefined, async () => 0);
  let peer;
  let releaseAction;
  const firstFault = new Promise(resolve => { releaseAction = resolve; });
  let arm = false;
  let injected = 0;
  const real = fsp.rename;
  // Armed only from inside A's action, so A's own write fence cannot be faulted.
  fsp.rename = async (from, to) => {
    if (arm && injected < 3 && String(to).endsWith(path.sep + 'ledger.json')) {
      injected += 1;
      if (injected === 1) { releaseAction(); }
      throw Object.assign(new Error('EPERM: injected rename denial (ledger)'), { code: 'EPERM' });
    }
    return real.call(fsp, from, to);
  };
  t.after(() => { fsp.rename = real; });

  let actionRan = false;
  const started = Date.now();
  const outcome = await settle(f.a.withStoreWrite(f.storeA, async () => {
    // A's write fence is already durable; the checkpoint effect succeeds here.
    actionRan = true;
    arm = true;
    peer = settle(f.b.account(f.storeB, async () => 0));
    await firstFault;
  }, async () => 0));
  const elapsed = Date.now() - started;
  const peerOutcome = await peer;

  assert.equal(actionRan, true, 'the checkpoint effect ran once, under a durable write fence');
  assert.equal(peerOutcome.ok, true, 'the peer publishes once its own backoff finishes');
  assert.equal(outcome.ok, true, 'the earlier action reports success instead of a lock error');
  assert.ok(elapsed >= 6_500, `the post-action accounting waited for the peer's 1s+2s+4s retry (observed ${elapsed}ms)`);

  const status = await f.a.status();
  const rows = Object.values(status.stores ?? {});
  assert.equal(rows.length, 2, 'both private test stores were registered');
  const fenced = rows.filter(store => store.write !== undefined || store.uncertain === true || store.accounting === 'quarantine');
  assert.deepEqual(fenced, [], 'neither store stays write-fenced, uncertain or quarantined after peer contention');
});

test('a genuinely unavailable lock still fails closed within the derived bound without being removed', { timeout: 25000 }, async t => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'resource-lock-held-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const owner = JSON.stringify({ pid: 1, host: 'holder' });
  const lock = path.join(base, 'transaction.lock');
  await fsp.writeFile(lock, owner);
  // Controlled test clock: the bounded 25 ms poll resolves immediately, so the
  // exact derived allowance is exercised in milliseconds instead of 80 real
  // seconds. No production test-only hook is involved.
  const timers = require('node:timers/promises');
  const realSetTimeout = timers.setTimeout;
  const requested = [];
  timers.setTimeout = async (wait, value) => { requested.push(wait); return value; };
  t.after(() => { timers.setTimeout = realSetTimeout; });

  const governor = new ResourceGovernor(config, base);
  assert.equal(await governor.hasState(), true, 'the held lock is the only aggregate state');
  const started = Date.now();
  const error = await governor.status().then(() => undefined, reason => reason);
  const elapsed = Date.now() - started;

  assert.equal(error?.code, 'resource_locked', 'an unowned lock fails closed as resource_locked');
  assert.equal(error?.retryable, true);
  assert.match(error.message, /still held after 80s/, 'the error names the bounded wait');
  assert.doesNotMatch(error.message, /stale/i, 'legitimate contention is not described as proven stale state');
  assert.ok(elapsed < 10_000, `the wait is finite without real sleeps (observed ${elapsed}ms)`);
  assert.equal(requested.length, Math.ceil(transactionLockWaitMs / 25), 'the loop polls at 25 ms for exactly the derived allowance');
  assert.deepEqual([...new Set(requested)], [25], 'every poll used the unchanged 25 ms interval');
  assert.equal(await fsp.readFile(lock, 'utf8'), owner, 'the live lock is never stolen, replaced or removed');
  assert.deepEqual(await fsp.readdir(base), ['transaction.lock'], 'a failed acquisition created no ledger');
});
