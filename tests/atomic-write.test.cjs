'use strict';
// Bounded publication-rename retry for storage.atomicWrite: five attempts in
// total (the initial rename plus four retries) separated by 1, 2, 4 and 8
// seconds, retrying only transient EPERM/EACCES/EBUSY contention.
// The Windows-style denial is injected by replacing fs.promises.rename inside
// this process: no live ledger or OS-level lock is touched, and every non-failing
// attempt performs the real rename, so the tests observe actual file effects.
// Backoff is stubbed rather than slept: each requested delay is recorded and its
// callback is queued as a microtask, so awaiting the real atomicWrite settlement
// never depends on how long fsync, removal or any other file-system call takes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const buildDir = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { atomicWrite, atomicWriteRenameRetryBudgetMs } = require(path.join(buildDir, 'storage'));

const schedule = [1_000, 2_000, 4_000, 8_000];
const ioError = (code, detail = '') => Object.assign(new Error(`${code}: injected duplicate${detail ? ` (${detail})` : ''}`), { code });

/** Record every requested backoff and run its callback immediately, in order, without a timer. */
function recordDelays(t, onDelay) {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    onDelay?.(delay, delays.length);
    queueMicrotask(callback);
    return 0;
  });
  return delays;
}

/** Replace the publication rename only; a non-failing attempt still performs the real rename. */
function renameFaults(t, decide) {
  const real = fsp.rename;
  const calls = [];
  fsp.rename = async (from, to) => {
    const index = calls.length;
    calls.push({ from, to });
    const error = decide(index);
    if (error) { throw error; }
    return real.call(fsp, from, to);
  };
  t.after(() => { fsp.rename = real; });
  return calls;
}

/** Count the temporary file's write/sync/close so retries provably reuse one write. */
function openProbe(t) {
  const real = fsp.open;
  const opened = [];
  fsp.open = async (target, flags, mode) => {
    const handle = await real.call(fsp, target, flags, mode);
    if (flags !== 'wx') { return handle; }
    const probe = { path: target, writes: 0, syncs: 0, closes: 0 };
    opened.push(probe);
    return {
      writeFile: (...args) => { probe.writes += 1; return handle.writeFile(...args); },
      sync: () => { probe.syncs += 1; return handle.sync(); },
      close: () => { probe.closes += 1; return handle.close(); }
    };
  };
  t.after(() => { fsp.open = real; });
  return opened;
}

async function fixture(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-write-retry-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'sessions', 'session.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'previous');
  const temporaries = async () => (await fsp.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'));
  return { base, file, temporaries };
}

test('the exported publication budget is the whole rename schedule', () => {
  assert.equal(atomicWriteRenameRetryBudgetMs, schedule.reduce((total, wait) => total + wait, 0), 'the budget is derived from the same 1, 2, 4 and 8 s delays');
  assert.equal(atomicWriteRenameRetryBudgetMs, 15_000);
});

test('a transiently held target is republished on the fifth attempt after 1, 2, 4 and 8 seconds', { timeout: 15000 }, async t => {
  const { file, temporaries } = await fixture(t);
  const codes = ['EPERM', 'EACCES', 'EBUSY', 'EPERM'];
  const opened = openProbe(t);
  const calls = renameFaults(t, index => (index < codes.length ? ioError(codes[index]) : undefined));
  const delays = recordDelays(t);
  let hooks = 0;

  await atomicWrite(file, 'payload', 0o600, () => { hooks += 1; });

  assert.deepEqual(delays, schedule, 'exactly four backoffs: 1, 2, 4 and 8 seconds, with no fifth delay');
  assert.equal(calls.length, 5, 'five attempts in total: the initial rename plus four retries');
  assert.equal(hooks, 5, 'authorization is re-checked immediately before every attempted rename');
  assert.equal(new Set(calls.map(call => call.from)).size, 1, 'every attempt publishes the same temporary path');
  assert.equal(new Set(calls.map(call => call.to)).size, 1, 'every attempt publishes to the same target');
  assert.deepEqual(opened.map(probe => [probe.writes, probe.syncs, probe.closes]), [[1, 1, 1]], 'content is written and synced once');
  assert.equal(opened[0].path, calls[0].from, 'the retried rename publishes exactly that temporary file');
  assert.equal(await fsp.readFile(file, 'utf8'), 'payload');
  await assert.rejects(fsp.stat(calls[0].from), error => error.code === 'ENOENT');
  assert.deepEqual(await temporaries(), [], 'the successful rename consumed the temporary path');
});

test('exhaustion preserves the old target, removes the temporary and rethrows the last error', { timeout: 15000 }, async t => {
  const { file, temporaries } = await fixture(t);
  const failures = Array.from({ length: 5 }, (_unused, index) => ioError('EPERM', `attempt ${index}`));
  const calls = renameFaults(t, index => failures[index]);
  const delays = recordDelays(t);
  let hooks = 0;

  const error = await atomicWrite(file, 'payload', 0o600, () => { hooks += 1; }).then(() => undefined, reason => reason);

  assert.equal(error, failures[4], 'the final error is rethrown unchanged after five attempts');
  assert.deepEqual(delays, schedule, 'the last failure surfaces without a fifth backoff');
  assert.equal(calls.length, 5, 'exhaustion stops after five attempts');
  assert.equal(hooks, 5, 'authorization ran before every attempted rename');
  assert.equal(await fsp.readFile(file, 'utf8'), 'previous', 'the old target survives an unpublished write');
  assert.deepEqual(await temporaries(), [], 'normal failure cleanup still removes the temporary path');
});

test('a nonretryable rename failure fails immediately without a backoff', { timeout: 15000 }, async t => {
  const { file, temporaries, base } = await fixture(t);
  const failure = ioError('ENOSPC');
  const calls = renameFaults(t, () => failure);
  const delays = recordDelays(t);
  let hooks = 0;

  const error = await atomicWrite(file, 'payload', 0o600, () => { hooks += 1; }).then(() => undefined, reason => reason);

  assert.equal(error, failure, 'a nonretryable code is not retried and is not wrapped');
  assert.deepEqual(delays, [], 'no backoff is scheduled for a nonretryable failure');
  assert.equal(calls.length, 1, 'exactly one rename attempt');
  assert.equal(hooks, 1);
  assert.equal(await fsp.readFile(file, 'utf8'), 'previous');
  assert.deepEqual(await temporaries(), []);
  assert.deepEqual(await fsp.readdir(base), ['sessions'], 'nothing else was left in the fixture');
});

test('authorization revoked during a backoff prevents the retry and cleans the temporary', { timeout: 15000 }, async t => {
  const { file, temporaries } = await fixture(t);
  // The authorization failure itself carries a retryable code: if the hook were
  // inside the rename catch it would be retried, so one recorded delay and one
  // rename attempt prove it is thrown outside the retry.
  const revoked = ioError('EPERM', 'cancelled while waiting to publish');
  const calls = renameFaults(t, index => (index === 0 ? ioError('EBUSY') : undefined));
  let authorization = true;
  const delays = recordDelays(t, () => { authorization = false; });
  let hooks = 0;

  const error = await atomicWrite(file, 'payload', 0o600, () => {
    hooks += 1;
    if (!authorization) { throw revoked; }
  }).then(() => undefined, reason => reason);

  assert.equal(error, revoked, 'the revocation fails the write instead of being retried as a rename error');
  assert.deepEqual(delays, [1_000], 'no further backoff is scheduled after the authorization is withdrawn');
  assert.equal(calls.length, 1, 'no rename runs once authorization is revoked');
  assert.equal(hooks, 2, 'the hook ran again immediately before the retried rename');
  assert.equal(await fsp.readFile(file, 'utf8'), 'previous', 'nothing was published');
  assert.deepEqual(await temporaries(), [], 'the temporary path is removed');
});

test('a successful publication never depends on temporary cleanup', { timeout: 15000 }, async t => {
  const { file, temporaries } = await fixture(t);
  const realRm = fsp.rm;
  let removals = 0;
  // After the rename the temporary path is gone; any cleanup attempt there would
  // report a failure for an effect that is already durable.
  fsp.rm = async (target, options) => {
    if (typeof target === 'string' && target.endsWith('.tmp')) {
      removals += 1;
      throw ioError('EPERM', 'cleanup of a published temporary');
    }
    return realRm.call(fsp, target, options);
  };
  t.after(() => { fsp.rm = realRm; });
  const delays = recordDelays(t);

  await atomicWrite(file, 'payload', 0o600, () => {});

  assert.deepEqual(delays, [], 'a first-attempt publication schedules no backoff');
  assert.equal(removals, 0, 'a published atomicWrite leaves no temporary path to remove');
  assert.equal(await fsp.readFile(file, 'utf8'), 'payload');
  assert.deepEqual(await temporaries(), [], 'the rename consumed the temporary');
});
