'use strict';

/**
 * Lifecycle regression for `benchmarks/parallel-workflow.cjs`.
 *
 * `runBenchmark` used to close a broker only after `broker.start()` had
 * resolved. A `start()` that rejects AFTER the private SessionStore
 * (`owner.lock`) and the bridge host were opened therefore left the lock, the
 * bridge registration and the broker's local root behind for the lifetime of
 * the process, and the report recorded nothing about it. The agreed behavior:
 * every constructed broker is closed on any exit, the ORIGINAL failure stays the
 * thrown error, and a close error is recorded in `cleanup.closeError` instead
 * of replacing it.
 *
 * Unlike `parallel-workflow-benchmark.test.cjs`, this file needs the REAL
 * compiled broker and fails loudly instead of skipping when that build is
 * missing. Set BENCH_TEST_BUILD (or CODEX_TEST_BUILD) to use another existing
 * compile, exactly as the benchmark itself does.
 *
 * The fault is injected only through a subclass whose `start()` awaits
 * `super.start()` and then throws - the late failure the review reproduced by
 * throwing from the final `discoverWorktrees(true)` - so no private method is
 * guessed. `broker.start()` runs before `npm pack`, so no npm install, build or
 * command runs here.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', 'benchmarks', 'parallel-workflow.cjs');
const { parseArguments, resolveBuild, runBenchmark } = require(script);

const build = resolveBuild();
const storage = require(path.join(build.directory, 'storage.js'));

/** One real attempt to open a private store directory from this process. */
async function tryOpenStore(directory) {
  const store = new storage.SessionStore(directory);
  try {
    await store.open();
  } catch (error) {
    return {
      opened: false,
      code: error && error.code ? error.code : null,
      message: String(error && error.message ? error.message : error).slice(0, 300)
    };
  }
  await store.close().catch(() => undefined);
  return { opened: true, code: null, message: null };
}

function registeredFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The real compiled broker, faulted only at the very end of start(): the store,
 * the bridge host and the local root are already registered when it throws.
 */
function lateStartFailureBroker(closeFailure) {
  const instances = [];
  class LateStartFailureBroker extends build.runtime.WorkerBroker {
    constructor(options) {
      super(options);
      this.probeCloseCalls = 0;
      instances.push(this);
    }
    async start() {
      await super.start();
      const error = new Error('injected late start failure (EPERM)');
      error.code = 'EPERM';
      throw error;
    }
    async close() {
      this.probeCloseCalls += 1;
      await super.close();
      if (closeFailure) {
        throw new Error('injected close failure');
      }
    }
  }
  return { LateStartFailureBroker, instances };
}

function benchmarkOptions() {
  return parseArguments(['--workers', '1', '--files', '10', '--baseline', 'none']);
}

/** Case-insensitive on Windows, exact elsewhere. */
function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The fixture base this test really created, derived from the options the
 * broker recorded: `storage` was `path.join(base, "storage")`, so the base is
 * its parent. Returns null when no broker was constructed, which still leaves
 * the report-free cleanup path working.
 */
function fixtureBaseOf(instances) {
  const storagePath = instances.length > 0 && instances[0].options ? instances[0].options.storage : null;
  if (typeof storagePath !== 'string' || storagePath === '') {
    return null;
  }
  return path.dirname(path.resolve(storagePath));
}

/** Run the benchmark once with the late start failure installed. */
async function runWithLateStartFailure(t, closeFailure) {
  const { LateStartFailureBroker, instances } = lateStartFailureBroker(closeFailure);
  const copiedBuild = { ...build, runtime: { ...build.runtime, WorkerBroker: LateStartFailureBroker } };
  assert.notEqual(build.runtime.WorkerBroker, LateStartFailureBroker, 'the compiled module original stays untouched');
  const state = { failure: null, report: null };

  // Registered BEFORE runBenchmark is awaited: if the product still skips
  // close(), this test must not leak a real store lock, bridge registration or
  // server process, and the fixture must not stay behind.
  t.after(async () => {
    // 1. Fallback broker cleanup FIRST: a broker the product left open still
    //    owns the store lock and must be closed before the fixture is deleted.
    for (const instance of instances) {
      if (instance.probeCloseCalls === 0) {
        await instance.close().catch(() => undefined);
      }
    }
    // 2. Then ONE derived recursive delete. The target is never taken from the
    //    report alone: it is the parent of the storage directory this test
    //    really handed to the broker, it must sit directly in the canonical OS
    //    temp directory, and its name must carry the benchmark fixture prefix.
    const fixtureBase = fixtureBaseOf(instances);
    if (fixtureBase === null) {
      return;
    }
    const tempRoot = await fsp.realpath(os.tmpdir());
    assert.ok(samePath(await fsp.realpath(path.dirname(fixtureBase)), tempRoot),
      'the recursive-delete target must live directly in the OS temp directory');
    assert.ok(path.basename(fixtureBase).startsWith('bench-parallel-'),
      'the recursive-delete target must be a benchmark fixture directory');
    const reported = state.report && state.report.cleanup ? state.report.cleanup.tmpDir : null;
    if (reported !== null && reported !== undefined) {
      assert.ok(samePath(reported, fixtureBase), 'report.cleanup.tmpDir must be the fixture base this test created');
    }
    await fsp.rm(fixtureBase, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  });

  try {
    await runBenchmark(benchmarkOptions(), copiedBuild, { runtime: { node: process.version }, limitations: [] });
  } catch (error) {
    state.failure = error;
    state.report = error && error.benchmarkReport ? error.benchmarkReport : null;
  }
  return { ...state, instances };
}

test('runBenchmark closes a broker whose start() failed late and releases its lock', { timeout: 20_000 }, async t => {
  const { failure, report, instances } = await runWithLateStartFailure(t, false);
  assert.ok(failure, 'runBenchmark must reject with the injected start failure');
  assert.match(String(failure.message), /injected late start failure/);
  assert.ok(report, 'the failure carries its report');
  assert.equal(instances.length, 1, 'exactly one real broker was constructed');
  const broker = instances[0];
  assert.equal(broker.probeCloseCalls, 1, 'runBenchmark itself closed the broker');
  assert.equal(broker.closed, true);
  assert.equal(broker.local.size, 0, 'no local root stays registered');
  assert.equal(typeof report.cleanup.brokerCloseMs, 'number');
  assert.equal(report.cleanup.closeError, null);
  assert.equal(report.status, 'running', 'runBenchmark still leaves the top-level status to main()');

  const base = report.cleanup.tmpDir;
  const storeDirectory = await build.workspaces.workspaceDirectory(path.join(base, 'storage'), report.project.fixtureRoot);
  assert.equal(fs.existsSync(path.join(storeDirectory, 'owner.lock')), false, 'the store owner lock was released');
  assert.deepEqual(registeredFiles(path.join(base, 'registry')), [], 'the bridge registration was withdrawn');
  assert.deepEqual(await tryOpenStore(storeDirectory), { opened: true, code: null, message: null },
    'the very store that failed startup can be opened again from this process');
});

test('runBenchmark keeps the start failure and reports a close error separately', { timeout: 20_000 }, async t => {
  const { failure, report, instances } = await runWithLateStartFailure(t, true);
  assert.ok(failure, 'runBenchmark must reject');
  assert.match(String(failure.message), /injected late start failure/, 'the original failure is retained');
  assert.ok(report);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].probeCloseCalls, 1, 'close was attempted exactly once');
  assert.equal(instances[0].closed, true);
  assert.equal(report.cleanup.closeError, 'injected close failure', 'the close error is reported explicitly');
  assert.equal(typeof report.cleanup.brokerCloseMs, 'number');
  assert.equal(report.status, 'failed');
});
