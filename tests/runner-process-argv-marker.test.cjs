// Hermetic regression for the portable (non-Linux POSIX) marker discovery path.
//
// The `ps -A -E -o pid=,lstart=,command=` listing renders a process's arguments
// and its environment into one block of text, so an exact
// `CODEX_RUNNER_PROCESS_MARKER=<token>` there may be an ordinary argument of an
// unrelated command. This suite proves that such a match can never reach real
// confirmation or a signal: any potential match makes the scan incomplete, the
// drain stays unproven, and the run is quarantined.
//
// Safety, deliberately strict:
//  - `process.kill` is replaced by a recording tripwire BEFORE the module under
//    test is loaded, and it is NEVER restored: the tripwire stays installed for
//    the whole life of this test process, so late work that runs after a test
//    timeout or after `test.after` still cannot reach a real signal. The suite
//    asserts that zero real signals were attempted (`finally` in every case and
//    again on process exit, so a failure cannot hide it);
//  - no fixture pid is ever signalled, not even with signal 0;
//  - the portable path is driven through the production seams
//    (`runnerContainmentSeams.portable` plus a recorded `control.signal`), so
//    the real scan/confirm classification runs on this host without spawning
//    `ps` and without a POSIX runtime;
//  - no real process tree is started by this file, so it needs no external
//    process-tree watchdog.
//
// Build selection: like the other process suites this one defaults to the
// repository test build (npm run build:test, .test-build/runner-process.js) and
// honours CODEX_TEST_BUILD / CODEX_RUNNER_PROCESS_BUILD, given either as a build
// directory or as the compiled file itself and resolved against the repository
// root. A dedicated compile that leaves the shared build alone is:
//   npx tsc src/runner-process.ts --outDir .test-build/fix3-process --rootDir src \
//     --target ES2022 --module commonjs --moduleResolution node --strict \
//     --skipLibCheck --esModuleInterop --noUnusedLocals --noUnusedParameters \
//     --noImplicitReturns --types node
//   CODEX_RUNNER_PROCESS_BUILD=.test-build/fix3-process node --test tests/runner-process-argv-marker.test.cjs

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

// --- tripwire installed BEFORE the module under test is loaded ---------------
const attemptedRealSignals = [];
process.kill = (pid, signal) => {
  attemptedRealSignals.push([pid, signal]);
  const error = new Error(`this suite must never signal a real process: kill(${pid}, ${signal})`);
  error.code = 'EPERM';
  throw error;
};
process.on('exit', () => {
  if (attemptedRealSignals.length > 0) {
    // A late attempt must still be visible even if a test timed out.
    console.error(`argv-marker suite attempted ${attemptedRealSignals.length} real signal(s):`, attemptedRealSignals);
    process.exitCode = 1;
  }
});

const override = (process.env.CODEX_TEST_BUILD ?? process.env.CODEX_RUNNER_PROCESS_BUILD ?? '').trim();
const buildPath = override.length === 0
  ? path.join(__dirname, '..', '.test-build', 'runner-process.js')
  : path.resolve(__dirname, '..', override.endsWith('.js') ? override : path.join(override, 'runner-process.js'));
const runnerProcess = require(buildPath);
const {
  drainMarkedDescendants,
  parsePotentialMarkedProcessList,
  portableScanResult,
  runnerContainmentSeams,
  RUNNER_DESCENDANT_MARKER_ENV
} = runnerProcess;

if (typeof drainMarkedDescendants !== 'function'
  || typeof portableScanResult !== 'function'
  || typeof parsePotentialMarkedProcessList !== 'function'
  || runnerContainmentSeams === undefined
  || RUNNER_DESCENDANT_MARKER_ENV === undefined) {
  throw new Error(`stale or incomplete runner-process build at ${buildPath}; recompile it (see this file's header)`);
}

const TEST_TIMEOUT = 60_000;
// Exactly the shape runPosix generates: 16 random bytes as lowercase hex.
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
// Odd ids: Windows pids are multiples of four, so even a hypothetical real signal
// on this host could not name a live process. Nothing here signals anything.
const OWNER_PID = 7403;
const VICTIM_PID = 7401;
const OWN_HOME = '/Users/review3';
const OWN_PROBE = `HOME=${OWN_HOME}`;
const LSTART = 'Fri Jun 21 10:00:0';

const ownRow = (pid, probe = OWN_PROBE) => `  ${pid} ${LSTART}2 2024 /usr/bin/node extension-host.js ${probe}`;
const ownerRow = `  ${OWNER_PID} ${LSTART}3 2024 /bin/sh -c "node late.cjs" ${RUNNER_DESCENDANT_MARKER_ENV}=${TOKEN}`;
// The marker is an ordinary ARGUMENT here; no environment entry carries it.
const victimRow = `  ${VICTIM_PID} ${LSTART}4 2024 /usr/bin/grep ${RUNNER_DESCENDANT_MARKER_ENV}=${TOKEN} /var/log/runner.log`;
const plainRow = `  7405 ${LSTART}5 2024 /usr/bin/tail -f runner.log`;

// The production capability probe reads HOME/PATH/USER/LOGNAME out of this
// process's own environment, so the suite pins HOME to the value its own `ps`
// row reports (HOME is the probe's first choice) and restores it afterwards.
const previousHome = process.env.HOME;
process.env.HOME = OWN_HOME;

const target = { envName: RUNNER_DESCENDANT_MARKER_ENV, marker: TOKEN };

// One drain run with the production scan/confirm and a recorded signal, over a
// table the suite controls. The portable seam is the only platform/table
// override, and both seams are always removed again.
async function drainWithPortableTable(table, recorded) {
  runnerContainmentSeams.portable = { platform: 'darwin', table: () => table() };
  runnerContainmentSeams.control = {
    signal: (pid, signal) => { recorded.signals.push([pid, signal]); }
  };
  try {
    return await drainMarkedDescendants(target);
  } finally {
    delete runnerContainmentSeams.portable;
    delete runnerContainmentSeams.control;
  }
}

test('portable: an argv-only marker match is quarantined and never signalled', { timeout: TEST_TIMEOUT }, async () => {
  const recorded = { signals: [] };
  const reads = { count: 0 };
  const table = () => {
    reads.count += 1;
    return [ownRow(process.pid), ownerRow, victimRow].join('\n');
  };
  const drain = await drainWithPortableTable(table, recorded);
  assert.equal(drain.drained, false, 'an ambiguous portable table can never be reported drained');
  assert.match(String(drain.diagnostic), /potential marker match/);
  assert.match(String(drain.diagnostic), /quarantined/);
  // The scan is refused on the first pass: nothing to confirm or signal.
  assert.equal(reads.count, 1, 'an incomplete scan must stop the sweep immediately');
  assert.deepEqual(recorded.signals, [], 'no process may be signalled from merged ps text');
  assert.deepEqual(attemptedRealSignals, [], 'no real signal may be attempted');
});

test('portable: the ambiguous scan never reaches confirmation either', { timeout: TEST_TIMEOUT }, async () => {
  const recorded = { signals: [], confirms: 0 };
  runnerContainmentSeams.portable = {
    platform: 'darwin',
    table: () => [ownRow(process.pid), victimRow].join('\n')
  };
  runnerContainmentSeams.control = {
    confirm: async () => {
      recorded.confirms += 1;
      return true;
    },
    signal: (pid, signal) => { recorded.signals.push([pid, signal]); }
  };
  try {
    const drain = await drainMarkedDescendants(target);
    assert.equal(drain.drained, false);
    assert.equal(recorded.confirms, 0, 'an unconfirmed portable candidate must never be confirmed');
    assert.deepEqual(recorded.signals, []);
    assert.deepEqual(attemptedRealSignals, []);
  } finally {
    delete runnerContainmentSeams.portable;
    delete runnerContainmentSeams.control;
  }
});

test('portable: the real portable confirmation never affirms a mixed-text match', { timeout: TEST_TIMEOUT }, async () => {
  // A scan that (wrongly) reports a candidate, with the REAL portable confirm
  // reading the same mixed table: confirmation must still refuse, so the pid is
  // never signalled and the run stays quarantined.
  const recorded = { signals: [] };
  runnerContainmentSeams.portable = {
    platform: 'darwin',
    table: () => [ownRow(process.pid), victimRow].join('\n')
  };
  runnerContainmentSeams.control = {
    scan: async () => ({ complete: true, processes: [{ pid: VICTIM_PID, startMarker: `${LSTART}4 2024` }] }),
    signal: (pid, signal) => { recorded.signals.push([pid, signal]); }
  };
  try {
    const started = Date.now();
    const drain = await drainMarkedDescendants(target);
    assert.ok(Date.now() - started < 15_000, 'the sweep must stay inside its bounded budget');
    assert.equal(drain.drained, false);
    assert.match(String(drain.diagnostic), /quarantined/);
    assert.deepEqual(recorded.signals, [], 'the real portable confirm must never affirm, so nothing is signalled');
    assert.deepEqual(attemptedRealSignals, []);
  } finally {
    delete runnerContainmentSeams.portable;
    delete runnerContainmentSeams.control;
  }
});

test('portable: an unproven ps table is incomplete even with no match', { timeout: TEST_TIMEOUT }, async () => {
  const recorded = { signals: [] };
  // The probe variable is absent from this process's own row: ps did not prove
  // it prints environments, so an empty match set means nothing.
  const unprobed = await drainWithPortableTable(() => [ownRow(process.pid, 'ARG=none'), plainRow].join('\n'), recorded);
  assert.equal(unprobed.drained, false);
  assert.match(String(unprobed.diagnostic), /did not report process environments/);
  assert.deepEqual(recorded.signals, []);

  // No table at all is also incomplete, never emptiness.
  const missing = await drainWithPortableTable(() => undefined, recorded);
  assert.equal(missing.drained, false);
  assert.match(String(missing.diagnostic), /ps could not list the process table/);
  assert.deepEqual(recorded.signals, []);
  assert.deepEqual(attemptedRealSignals, []);
});

test('portable: a probed table with no potential match still proves the tree empty', { timeout: TEST_TIMEOUT }, async () => {
  const recorded = { signals: [] };
  const reads = { count: 0 };
  const table = () => {
    reads.count += 1;
    return [ownRow(process.pid), plainRow].join('\n');
  };
  const drain = await drainWithPortableTable(table, recorded);
  assert.deepEqual(drain, { drained: true }, 'a probed, match-free table may establish emptiness');
  assert.ok(reads.count >= 2, 'emptiness needs two complete scans');
  assert.deepEqual(recorded.signals, []);
  assert.deepEqual(attemptedRealSignals, []);
});

test('portable: classifier and drain agree that mixed text is never ownership', { timeout: TEST_TIMEOUT }, async () => {
  // The exported production classifier and the drain use the same rule; this
  // pins the two together so a future parser change cannot widen the drain.
  const table = [ownRow(process.pid), ownerRow, victimRow, plainRow].join('\n');
  const classified = portableScanResult(table, target, process.pid, OWN_PROBE);
  assert.equal(classified.complete, false);
  assert.deepEqual(classified.processes, []);
  const parsed = parsePotentialMarkedProcessList(table, RUNNER_DESCENDANT_MARKER_ENV, TOKEN);
  assert.deepEqual(parsed.map(entry => entry.pid), [OWNER_PID, VICTIM_PID], 'both rows stay "potential" only');
  assert.deepEqual(attemptedRealSignals, []);
});

// Restore only the HOME value this suite pinned. The `process.kill` tripwire is
// deliberately NOT restored: this file has no legitimate real signal and spawns
// no process, so keeping it installed until the test process exits is what stops
// late work after a timeout from reaching a real kill.
test.after(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  assert.deepEqual(attemptedRealSignals, [], 'the suite must never attempt a real signal');
});
