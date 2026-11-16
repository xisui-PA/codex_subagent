const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Compile this module separately so a concurrent worker's build output is not
// shared: npx tsc src/runner-process.ts --outDir .test-runner-process --rootDir src
// Override with CODEX_RUNNER_PROCESS_BUILD to point at another build directory.
// Compiled output defaults to the repository test build (npm run build:test),
// exactly like the other suites. An isolated compile can be selected with
// CODEX_TEST_BUILD or CODEX_RUNNER_PROCESS_BUILD, given either as a build
// directory (…\.test-runner-process) or as the compiled file itself:
// npx tsc -p tsconfig.json --outDir <dir> --sourceMap false
// Every override form is resolved against the REPOSITORY ROOT (never the
// current working directory), because a bare relative specifier would otherwise
// be treated as a package name and fail to load. A relative build directory, a
// relative compiled file and an absolute path (either form) all work from any
// cwd; an absolute override resolves to itself unchanged.
const override = (process.env.CODEX_TEST_BUILD ?? process.env.CODEX_RUNNER_PROCESS_BUILD ?? '').trim();
const buildPath = override.length === 0
  ? path.join(__dirname, '..', '.test-build', 'runner-process.js')
  : path.resolve(__dirname, '..', override.endsWith('.js') ? override : path.join(override, 'runner-process.js'));
const runnerProcess = require(buildPath);
const {
  runRunnerProcess,
  recoverRunnerProcess,
  drainMarkedDescendants,
  environHasMarker,
  parsePotentialMarkedProcessList,
  portableScanResult,
  parseProcStartTime,
  runnerContainmentSeams,
  RUNNER_DESCENDANT_MARKER_ENV,
  RUNNER_JOURNAL_LIMIT_MS,
  RUNNER_OUTPUT_LIMIT
} = runnerProcess;
// Fail loudly instead of silently testing a stale compile: a build that predates
// the bounded journal hook or the marker drain would hang or silently skip the
// descendant guarantees rather than report a mismatch.
if (typeof runnerProcess.runRunnerProcess !== 'function'
  || typeof runnerProcess.recoverRunnerProcess !== 'function'
  || typeof runnerProcess.drainMarkedDescendants !== 'function'
  || typeof runnerProcess.environHasMarker !== 'function'
  || typeof runnerProcess.parsePotentialMarkedProcessList !== 'function'
  || typeof runnerProcess.portableScanResult !== 'function'
  || typeof runnerProcess.parseProcStartTime !== 'function'
  || runnerProcess.runnerContainmentSeams === undefined
  || runnerProcess.RUNNER_DESCENDANT_MARKER_ENV === undefined
  || runnerProcess.RUNNER_JOURNAL_LIMIT_MS === undefined
  || runnerProcess.RUNNER_OUTPUT_LIMIT === undefined) {
  throw new Error(`stale or incomplete runner-process build at ${buildPath}; recompile it (npm run build:test)`);
}

// Every case gets a bound so a regression can never wedge a developer command.
const TEST_TIMEOUT = 90_000;

const win = process.platform === 'win32';
const skipPosix = win ? 'POSIX process-group adapter is not exercised on Windows' : false;
const skipWindows = win ? false : 'the Windows Job Object adapter requires Windows';
const skipPosixMarkers = skipPosix || (process.platform !== 'linux' ? 'process start markers require /proc (Linux)' : false);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a child side effect');
    }
    await sleep(25);
  }
}

const exists = async file => fs.stat(file).then(() => true, () => false);

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-process-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

const write = (dir, name, text) => fs.writeFile(path.join(dir, name), text);

// A child that keeps living until it is killed, writing `end.txt` only if it
// survives `SLEEPY_MS`.
const SLEEPY_MS = 2000;
const sleepy = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('started.txt', String(process.pid));",
  `setTimeout(() => { fs.writeFileSync('end.txt', 'survived'); process.exit(0); }, ${SLEEPY_MS});`,
  ''
].join('\n');

const normal = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('out.txt', 'ok');",
  "process.stdout.write('line-one\\n');",
  "process.stderr.write('line-two\\n');",
  'process.exit(3);',
  ''
].join('\n');

const late = [
  "const fs = require('node:fs');",
  "setTimeout(() => { fs.writeFileSync('late.txt', 'late'); process.exit(0); }, 1200);",
  ''
].join('\n');

// Spawns a grandchild that outlives the shell it was started from.
const background = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "fs.writeFileSync('started.txt', 'yes');",
  "spawn(process.execPath, ['late.cjs'], { stdio: 'ignore', detached: process.argv[2] === 'detached' }).unref();",
  ''
].join('\n');

// Spawns a genuinely detached grandchild (its own session and process group)
// that writes long after the shell it was started from has exited. Process
// group absence alone cannot prove this tree drained: the inherited marker has
// to catch it.
const escapee = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const child = spawn(process.execPath, ['late.cjs'], { stdio: 'ignore', detached: true });",
  "fs.writeFileSync('escapee.pid', String(child.pid));",
  'child.unref();',
  ''
].join('\n');

// Replaces the descendant control for one case and restores the default after.
function setContainmentSeams(t, control) {
  t.after(() => { delete runnerContainmentSeams.control; });
  runnerContainmentSeams.control = control;
}

// Injects a teardown tail that only ever runs AFTER the whole owned tree is
// proven gone, so a case can prove the terminal state cannot change any more.
function setPostCompletionDelay(t, ms) {
  t.after(() => { delete runnerContainmentSeams.postCompletionDelayMs; });
  runnerContainmentSeams.postCompletionDelayMs = ms;
}

// Records whether the awaited supervisor close/flush settled or timed out.
function observeSupervisorCloseWait(t) {
  const seen = [];
  t.after(() => { delete runnerContainmentSeams.onSupervisorCloseWait; });
  runnerContainmentSeams.onSupervisorCloseWait = settled => { seen.push(settled); };
  return seen;
}

// Drives the POSIX recovery probes, so the leader-gone branch (which needs a
// group whose leader already exited) is testable on any host.
function setRecoverySeams(t, recovery) {
  t.after(() => { delete runnerContainmentSeams.recovery; });
  runnerContainmentSeams.recovery = recovery;
}

// A journaled POSIX identity whose recorded leader is already gone while the
// group id still reports alive. `descendants` is the only ownership proof.
function leaderGoneIdentity(descendants) {
  const pid = process.pid === 4242 ? 4243 : 4242;
  return {
    platform: 'linux',
    pid,
    startMarker: '123456',
    supervisor: { kind: 'posix-process-group', name: String(pid) },
    ...(descendants === undefined ? {} : { descendants })
  };
}

// Markers driven through the exported drain must have the exact shape this
// module generates, because anything else is rejected before discovery. The
// pure parsers above may still be fed arbitrary fixture strings.
const generatedMarker = () => randomBytes(16).toString('hex');
const markerFor = marker => ({ envName: RUNNER_DESCENDANT_MARKER_ENV, marker });

test('normal completion keeps real side effects, exit code and bounded output', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'normal.cjs', normal);
  let authorized = 0;
  const started = [];
  const result = await runRunnerProcess({
    command: 'node normal.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => { authorized += 1; },
    onStarted: async identity => { started.push(identity); }
  });
  assert.equal(await fs.readFile(path.join(dir, 'out.txt'), 'utf8'), 'ok');
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.drained, true);
  assert.match(result.output, /line-one/);
  assert.match(result.output, /line-two/);
  assert.ok(result.output.length <= RUNNER_OUTPUT_LIMIT);
  assert.equal(authorized, 1, 'authorize must run exactly once');
  assert.equal(started.length, 1, 'the journal hook must receive one durable identity');
  assert.ok(result.identity);
  assert.equal(result.identity.pid, started[0].pid);
  assert.equal(result.identity.platform, process.platform);
  assert.equal(result.identity.supervisor.kind, win ? 'windows-job-object' : 'posix-process-group');
  assert.deepEqual(result.identity.supervisor, started[0].supervisor);
});

test('a shell that exits early still has its background child drained', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'late.cjs', late);
  await write(dir, 'background.cjs', background);
  const result = await runRunnerProcess({
    command: win ? 'node background.cjs detached' : 'node background.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.drained, true);
  assert.equal(await exists(path.join(dir, 'started.txt')), true);
  await sleep(1800);
  assert.equal(await exists(path.join(dir, 'late.txt')), false, 'a detached background child must be drained, not left writing');
});

test('a timed out command is drained and its delayed write never happens', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 700,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.drained, true);
  assert.equal(result.exitCode, null);
  assert.ok(result.identity);
  assert.equal(await exists(path.join(dir, 'started.txt')), true);
  await sleep(SLEEPY_MS + 300);
  assert.equal(await exists(path.join(dir, 'end.txt')), false, 'the timed out process must not survive');
});

test('cancellation after start is drained and reports cancelled', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  const controller = new AbortController();
  const pending = runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 30000,
    signal: controller.signal,
    authorize: () => undefined
  });
  await until(() => exists(path.join(dir, 'started.txt')));
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.drained, true);
  await sleep(SLEEPY_MS + 300);
  assert.equal(await exists(path.join(dir, 'end.txt')), false, 'the cancelled process must not survive');
});

test('a denied authorize runs nothing at all', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  let authorized = 0;
  let journaled = 0;
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => { authorized += 1; throw new Error('policy denied'); },
    onStarted: async () => { journaled += 1; }
  });
  assert.equal(authorized, 1);
  assert.equal(journaled, 0);
  assert.match(String(result.diagnostic), /authorize/);
  assert.equal(result.identity, null);
  assert.equal(result.exitCode, null);
  assert.equal(result.drained, true);
  assert.equal(await exists(path.join(dir, 'started.txt')), false, 'a denied command must not run');
});

test('an already aborted signal never authorizes or spawns', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  let authorized = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: controller.signal,
    authorize: () => { authorized += 1; }
  });
  assert.equal(authorized, 0);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.drained, true);
  assert.match(String(result.diagnostic), /before spawn/);
  assert.equal(await exists(path.join(dir, 'started.txt')), false);
});

test('an unusable working directory fails without hanging or starting work', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  const missing = path.join(dir, 'missing-directory');
  const started = Date.now();
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: missing,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.identity, null);
  assert.equal(result.exitCode, null);
  assert.equal(result.drained, true);
  assert.equal(result.timedOut, false);
  assert.equal(typeof result.diagnostic, 'string');
  assert.ok(result.diagnostic.length > 0);
  assert.ok(Date.now() - started < 15000, 'a setup failure must not hang');
});

test('a failing journal hook terminates the started run', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 30000,
    signal: new AbortController().signal,
    authorize: () => undefined,
    onStarted: async () => { throw new Error('journal offline'); }
  });
  assert.match(String(result.diagnostic), /journal/);
  assert.equal(result.drained, true);
  assert.ok(result.identity, 'the identity is still reported for the caller');
  await sleep(SLEEPY_MS + 300);
  assert.equal(await exists(path.join(dir, 'end.txt')), false, 'the unjournaled run must be terminated');
});

test('a journal hook that never settles is abandoned and the run is terminated', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  const controller = new AbortController();
  const started = Date.now();
  const pending = runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 60000,
    signal: controller.signal,
    authorize: () => undefined,
    // A stuck journal must never block cancellation or cleanup.
    onStarted: () => new Promise(() => undefined)
  });
  await until(() => exists(path.join(dir, 'started.txt')));
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.drained, true);
  assert.match(String(result.diagnostic), /journal hook did not settle/);
  assert.ok(Date.now() - started < RUNNER_JOURNAL_LIMIT_MS + 15000, 'a stuck journal hook must be bounded');
  await sleep(SLEEPY_MS + 300);
  assert.equal(await exists(path.join(dir, 'end.txt')), false, 'the abandoned run must be terminated');
});

test('a cwd that is not a directory fails without starting work', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  const file = path.join(dir, 'not-a-directory.txt');
  await write(dir, 'not-a-directory.txt', 'x');
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: file,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.exitCode, null);
  assert.equal(result.identity, null);
  assert.equal(result.drained, true, 'a start that never reached a live child is provably empty');
  assert.equal(typeof result.diagnostic, 'string');
  assert.equal(await exists(path.join(dir, 'started.txt')), false);
});

test('output is bounded and flagged as truncated', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'big.cjs', "process.stdout.write('x'.repeat(250000));\n");
  const result = await runRunnerProcess({
    command: 'node big.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= RUNNER_OUTPUT_LIMIT);
  assert.ok(result.output.length > 90000);
  assert.equal(result.drained, true);
});

test('the child environment is exactly the provided environment', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'env.cjs', "process.stdout.write(String(process.env.RUNNER_TEST_MARK) + '|' + String(process.env.RUNNER_TEST_LEAK));\n");
  const base = { ...process.env };
  process.env.RUNNER_TEST_LEAK = 'leaked';
  try {
    const result = await runRunnerProcess({
      command: 'node env.cjs',
      cwd: dir,
      env: { ...base, RUNNER_TEST_MARK: 'hello world' },
      timeoutMs: 20000,
      signal: new AbortController().signal,
      authorize: () => undefined
    });
    assert.match(result.output, /hello world\|undefined/);
    assert.equal(result.drained, true);
  } finally {
    delete process.env.RUNNER_TEST_LEAK;
  }
});

test('posix: shell-exits-early background job is drained by the process group', { skip: skipPosix, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  const result = await runRunnerProcess({
    command: '(sleep 2; echo late > late.txt) &',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.drained, true);
  assert.ok(result.identity);
  assert.equal(result.identity.supervisor.kind, 'posix-process-group');
  assert.equal(result.identity.supervisor.name, String(result.identity.pid));
  assert.throws(() => process.kill(-result.identity.pid, 0), /ESRCH/, 'the group must be gone after the result');
  await sleep(2600);
  assert.equal(await exists(path.join(dir, 'late.txt')), false);
});

test('posix: recovery refuses a recycled marker and terminates a confirmed group', { skip: skipPosixMarkers, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  const seen = [];
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 30000,
    signal: new AbortController().signal,
    authorize: () => undefined,
    onStarted: async identity => {
      seen.push(identity);
      const recycled = await recoverRunnerProcess({ ...identity, startMarker: '0' });
      assert.equal(recycled.status, 'uncertain');
      assert.equal(recycled.drained, false);
      const recovered = await recoverRunnerProcess(identity);
      assert.equal(recovered.status, 'terminated');
      assert.equal(recovered.drained, true);
      // An identity journaled before descendant tracking carries no marker, so
      // its detached descendants cannot be enumerated: keep it quarantined
      // instead of assuming the group proof covers escapees.
      const legacy = await recoverRunnerProcess({ ...identity, descendants: undefined });
      assert.equal(legacy.drained, false);
      assert.match(String(legacy.diagnostic), /quarantine/);
    }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].startMarker.length > 0, true, 'Linux must record a start marker');
  assert.equal(result.drained, true);
});

test('windows: identity is a named job object with a creation marker', { skip: skipWindows, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'normal.cjs', normal);
  const result = await runRunnerProcess({
    command: 'node normal.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.drained, true);
  assert.ok(result.identity);
  assert.equal(result.identity.supervisor.kind, 'windows-job-object');
  assert.match(result.identity.supervisor.name, /^Local\\codex-runner-[0-9a-f]+$/);
  assert.match(result.identity.startMarker, /^\d+$/, 'a Windows creation marker must be recorded');
  const absent = await recoverRunnerProcess(result.identity);
  assert.equal(absent.status, 'absent', 'a drained job object holds no processes');
  assert.equal(absent.drained, true);
});

test('windows: job recovery refuses a recycled marker and then terminates the confirmed job', { skip: skipWindows, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  const seen = [];
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 40000,
    signal: new AbortController().signal,
    authorize: () => undefined,
    onStarted: async identity => {
      seen.push(identity);
      const recycled = await recoverRunnerProcess({ ...identity, startMarker: '134392000000000000' });
      assert.equal(recycled.status, 'uncertain');
      assert.equal(recycled.drained, false);
      const confirmed = await recoverRunnerProcess(identity);
      assert.equal(confirmed.status, 'terminated', 'an unproven identity must not have killed the live job');
      assert.equal(confirmed.drained, true);
    }
  });
  assert.equal(seen.length, 1);
  assert.equal(result.drained, true);
  await sleep(SLEEPY_MS + 300);
  assert.equal(await exists(path.join(dir, 'end.txt')), false, 'the recovered job must be terminated');
});

test('marker ownership is matched as a whole environment entry', { timeout: TEST_TIMEOUT }, async () => {
  const token = 'c1a2b3d4e5f6a7b8';
  const exact = Buffer.from(['PATH=/usr/bin', `${RUNNER_DESCENDANT_MARKER_ENV}=${token}`, 'LANG=C'].join('\0') + '\0', 'utf8');
  assert.equal(environHasMarker(exact, RUNNER_DESCENDANT_MARKER_ENV, token), true);
  assert.equal(environHasMarker('', RUNNER_DESCENDANT_MARKER_ENV, token), false);
  assert.equal(environHasMarker(Buffer.alloc(0), RUNNER_DESCENDANT_MARKER_ENV, token), false);
  // A different run's token, a prefixed name, a suffixed value, and text that
  // only mentions the marker must never claim ownership of a process.
  assert.equal(environHasMarker(exact, RUNNER_DESCENDANT_MARKER_ENV, 'c1a2b3d4e5f6a7b9'), false);
  assert.equal(
    environHasMarker(Buffer.from(`X${RUNNER_DESCENDANT_MARKER_ENV}=${token}\0`, 'utf8'), RUNNER_DESCENDANT_MARKER_ENV, token),
    false
  );
  assert.equal(
    environHasMarker(Buffer.from(`${RUNNER_DESCENDANT_MARKER_ENV}=${token}-extra\0`, 'utf8'), RUNNER_DESCENDANT_MARKER_ENV, token),
    false
  );
  assert.equal(
    environHasMarker(Buffer.from(`note ${RUNNER_DESCENDANT_MARKER_ENV}=${token}\0`, 'utf8'), RUNNER_DESCENDANT_MARKER_ENV, token),
    false
  );
});

test('portable ps text can only ever yield potential matches, never owners', { timeout: TEST_TIMEOUT }, async () => {
  const token = 'feedfacecafe';
  const home = 'HOME=/Users/review';
  const ownPid = 4241;
  const rows = [
    '     1 Wed Jan  1 00:00:00 2025 /sbin/init',
    `  ${ownPid} Wed Jan  1 00:00:00 2025 /usr/bin/node extension-host.js ${home}`,
    `  4242 Wed Jan  1 00:00:01 2025 /bin/sh -c "node child.cjs" ${RUNNER_DESCENDANT_MARKER_ENV}=${token}`,
    // An unrelated command that carries the exact assignment as an ARGUMENT;
    // its own environment does not contain the marker at all.
    `  4243 Wed Jan  1 00:00:02 2025 /usr/bin/grep ${RUNNER_DESCENDANT_MARKER_ENV}=${token} /var/log/runner.log`,
    `  4244 Wed Jan  1 00:00:03 2025 /usr/bin/lookalike ${RUNNER_DESCENDANT_MARKER_ENV}=${token}extra`,
    `  4245 Wed Jan  1 00:00:04 2025 /usr/bin/lookalike X${RUNNER_DESCENDANT_MARKER_ENV}=${token}`,
    '  4246 Wed Jan  1 00:00:04 2025 /usr/bin/node plain'
  ];
  const table = rows.join('\n');
  const target = { envName: RUNNER_DESCENDANT_MARKER_ENV, marker: token };

  // The parser keeps the creation identity, and reports BOTH the real owner and
  // the argv-only lookalike: merged ps text cannot tell them apart.
  assert.deepEqual(
    parsePotentialMarkedProcessList(table, RUNNER_DESCENDANT_MARKER_ENV, token),
    [
      { pid: 4242, startMarker: 'Wed Jan 1 00:00:01 2025' },
      { pid: 4243, startMarker: 'Wed Jan 1 00:00:02 2025' }
    ]
  );
  // A different run's token never matches, and bounded malformed fixtures are
  // ignored instead of throwing or claiming processes. Prefix/suffix controls
  // (4244, 4245) never match either.
  assert.deepEqual(parsePotentialMarkedProcessList(table, RUNNER_DESCENDANT_MARKER_ENV, 'feedfacecaff'), []);
  assert.deepEqual(parsePotentialMarkedProcessList('', RUNNER_DESCENDANT_MARKER_ENV, token), []);
  assert.deepEqual(parsePotentialMarkedProcessList('garbage\n\n   x y z\n', RUNNER_DESCENDANT_MARKER_ENV, token), []);

  // Environment-only proof is the rule the /proc path applies, and it rejects
  // the argv-only process outright: so the ps path must not claim it.
  const victimEnviron = Buffer.from(['PWD=/tmp', 'LANG=C'].join('\0') + '\0', 'utf8');
  assert.equal(environHasMarker(victimEnviron, RUNNER_DESCENDANT_MARKER_ENV, token), false);

  // Hence any potential match makes portable discovery INCOMPLETE, and no
  // candidate is handed to a signalling loop.
  const blocked = portableScanResult(table, target, ownPid, home);
  assert.equal(blocked.complete, false);
  assert.deepEqual(blocked.processes, [], 'a potential match is never returned as a candidate');
  assert.match(String(blocked.diagnostic), /quarantined/);
  assert.match(String(blocked.diagnostic), /2 potential marker match/);
  // ... including a table where only the true owner is present: mixed text
  // cannot prove that row either.
  const ownerOnly = portableScanResult([rows[0], rows[1], rows[2]].join('\n'), target, ownPid, home);
  assert.equal(ownerOnly.complete, false);
  assert.match(String(ownerOnly.diagnostic), /1 potential marker match/);
  // The argv-only row alone is equally unproven.
  const victimOnly = portableScanResult([rows[0], rows[1], rows[3]].join('\n'), target, ownPid, home);
  assert.equal(victimOnly.complete, false);
  assert.match(String(victimOnly.diagnostic), /1 potential marker match/);
  // A ps that did not prove it prints environments, or a missing table, stays
  // incomplete instead of looking like emptiness.
  const unprobed = portableScanResult(table, target, ownPid, undefined);
  assert.equal(unprobed.complete, false);
  assert.match(String(unprobed.diagnostic), /did not report process environments/);
  const noOwnRow = portableScanResult([rows[0], rows[2]].join('\n'), target, ownPid, home);
  assert.equal(noOwnRow.complete, false);
  assert.match(String(noOwnRow.diagnostic), /did not report process environments/);
  // Only a probed table with no potential match at all may still establish
  // emptiness, which is the pre-existing contract.
  assert.deepEqual(portableScanResult([rows[0], rows[1], rows[6]].join('\n'), target, ownPid, home), {
    complete: true, processes: []
  });
  // A table that does not even list this process cannot be probed at all.
  const selfMissing = portableScanResult(rows[0], target, ownPid, home);
  assert.equal(selfMissing.complete, false);
  assert.deepEqual(selfMissing.processes, []);
  assert.match(String(selfMissing.diagnostic), /did not report process environments/);
  // This process's own row never counts as a descendant, even when it mentions
  // the token itself.
  const ownOnly = `  ${ownPid} Wed Jan  1 00:00:00 2025 /usr/bin/node host.js ${home} ${RUNNER_DESCENDANT_MARKER_ENV}=${token}`;
  assert.deepEqual(portableScanResult(ownOnly, target, ownPid, home), { complete: true, processes: [] });
});

test('proc stat fixtures yield the creation marker of the right process', { timeout: TEST_TIMEOUT }, async () => {
  // Fields after `comm`: state plus sixteen fields, then starttime at index 19.
  const after = ['S', '0', '1001', '1001', '0', '-1', '4194560', '100', '0', '0', '0', '1', '2', '0', '0', '20', '0', '1', '0', '424242'];
  assert.equal(parseProcStartTime(`1001 (node) ${after.join(' ')} 98765 1234`), '424242');
  // A comm containing spaces and parentheses must not shift the field index.
  assert.equal(parseProcStartTime(`1001 (node (weird) name) ${after.join(' ')}`), '424242');
  // Bounded malformed fixtures: no comm, truncated stat, empty input.
  assert.equal(parseProcStartTime('1001 node without parens 1 2 3'), '');
  assert.equal(parseProcStartTime('1001 (node) S 1 2'), '');
  assert.equal(parseProcStartTime(''), '');
});

// The next four cases drive the marker drain through its injected control, so
// the same guarantees can be proven on any host. They are not POSIX execution
// proofs: the real /proc and ps discovery paths run only in the POSIX cases.
test('descendant drain seam: an incomplete scan is never reported drained', { timeout: TEST_TIMEOUT }, async t => {
  const signals = [];
  setContainmentSeams(t, {
    scan: async () => ({ complete: false, processes: [], diagnostic: 'injected: process table denied' }),
    confirm: async () => true,
    signal: (pid, signal) => signals.push([pid, signal])
  });
  const started = Date.now();
  const drain = await drainMarkedDescendants(markerFor(generatedMarker()));
  assert.equal(drain.drained, false);
  assert.match(String(drain.diagnostic), /injected: process table denied/);
  assert.match(String(drain.diagnostic), /quarantine/);
  assert.deepEqual(signals, [], 'an incomplete scan must not signal anything');
  assert.ok(Date.now() - started < 5000, 'an unavailable scan must not burn the whole budget');
});

test('descendant drain seam: a pid that fails confirmation is never signalled', { timeout: TEST_TIMEOUT }, async t => {
  const signals = [];
  let scans = 0;
  setContainmentSeams(t, {
    scan: async () => {
      scans += 1;
      // The first pass reports a pid the run never owned (a recycled id); the
      // later passes report the owned set as empty.
      return scans === 1
        ? { complete: true, processes: [{ pid: 987654, startMarker: '1' }] }
        : { complete: true, processes: [] };
    },
    confirm: async () => false,
    signal: (pid, signal) => signals.push([pid, signal])
  });
  const drain = await drainMarkedDescendants(markerFor(generatedMarker()));
  assert.equal(drain.drained, true);
  assert.deepEqual(signals, [], 'an unconfirmed pid must never be signalled');
});

test('descendant drain seam: a confirmed escapee is terminated, then killed', { timeout: TEST_TIMEOUT }, async t => {
  const signals = [];
  setContainmentSeams(t, {
    scan: async () => (signals.some(([, signal]) => signal === 'SIGKILL')
      ? { complete: true, processes: [] }
      : { complete: true, processes: [{ pid: 4321, startMarker: '77' }] }),
    confirm: async () => true,
    signal: (pid, signal) => signals.push([pid, signal])
  });
  const started = Date.now();
  const drain = await drainMarkedDescendants(markerFor(generatedMarker()));
  assert.equal(drain.drained, true);
  assert.deepEqual(signals[0], [4321, 'SIGTERM']);
  assert.deepEqual(signals[signals.length - 1], [4321, 'SIGKILL']);
  assert.ok(Date.now() - started >= 1000, 'escalation must wait for the grace period');
});

test('descendant drain seam: a survivor that never dies is quarantined', { timeout: TEST_TIMEOUT }, async t => {
  setContainmentSeams(t, {
    scan: async () => ({ complete: true, processes: [{ pid: 1234, startMarker: '1' }] }),
    confirm: async () => true,
    signal: () => undefined
  });
  const started = Date.now();
  const drain = await drainMarkedDescendants(markerFor(generatedMarker()));
  const elapsed = Date.now() - started;
  assert.equal(drain.drained, false);
  assert.match(String(drain.diagnostic), /quarantine/);
  assert.ok(elapsed >= 5000, `the drain must use its bounded budget (${elapsed} ms)`);
  assert.ok(elapsed < 20000, `the drain must stay bounded (${elapsed} ms)`);
});

test('posix: a detached escapee outside the group is drained before the result', { skip: skipPosix, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'late.cjs', late);
  await write(dir, 'escapee.cjs', escapee);
  assert.equal(process.env[RUNNER_DESCENDANT_MARKER_ENV], undefined, 'the runner must not leak the marker into its own environment');
  const started = [];
  const result = await runRunnerProcess({
    command: 'node escapee.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined,
    onStarted: async identity => { started.push(identity); }
  });
  assert.equal(result.drained, true);
  assert.ok(result.identity);
  assert.ok(result.identity.descendants, 'a durable marker is journaled for recovery');
  assert.equal(result.identity.descendants.envName, RUNNER_DESCENDANT_MARKER_ENV);
  assert.match(result.identity.descendants.marker, /^[0-9a-f]{32}$/);
  assert.deepEqual(started[0].descendants, result.identity.descendants);
  const pid = Number(await fs.readFile(path.join(dir, 'escapee.pid'), 'utf8'));
  assert.ok(pid > 1, 'the escapee pid must be recorded by the case');
  await sleep(1800);
  assert.equal(await exists(path.join(dir, 'late.txt')), false, 'the detached escapee must not write after the result');
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the detached escapee must be gone');
});

test('posix: cancellation also drains a detached escapee', { skip: skipPosix, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'late.cjs', late);
  await write(dir, 'escapee.cjs', escapee);
  const controller = new AbortController();
  const pending = runRunnerProcess({
    command: 'node escapee.cjs; sleep 20',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 40000,
    signal: controller.signal,
    authorize: () => undefined
  });
  await until(() => exists(path.join(dir, 'escapee.pid')));
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.drained, true);
  const pid = Number(await fs.readFile(path.join(dir, 'escapee.pid'), 'utf8'));
  await sleep(1800);
  assert.equal(await exists(path.join(dir, 'late.txt')), false, 'a cancelled run must not leave a detached writer');
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the detached escapee must be gone');
});

test('posix: an incomplete descendant discovery quarantines the run', { skip: skipPosix, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'normal.cjs', normal);
  setContainmentSeams(t, {
    scan: async () => ({ complete: false, processes: [], diagnostic: 'injected: process table denied' })
  });
  const result = await runRunnerProcess({
    command: 'node normal.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.drained, false, 'an unprovable drain must never be reported as drained');
  assert.match(String(result.diagnostic), /injected: process table denied/);
  assert.match(String(result.diagnostic), /quarantine/);
});

test('identity guards: a malformed record is quarantined without any OS action', { timeout: TEST_TIMEOUT }, async t => {
  const calls = [];
  setContainmentSeams(t, {
    scan: async () => { calls.push('scan'); return { complete: true, processes: [] }; },
    confirm: async () => { calls.push('confirm'); return true; },
    signal: () => { calls.push('signal'); }
  });
  const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
  const validJobName = 'Local\\codex-runner-0123456789abcdef01234567';
  // Every case is invalid on any host, so none of them may reach discovery,
  // signalling, or a supervisor spawn, and none may throw.
  const malformed = [
    null,
    undefined,
    'identity',
    42,
    {},
    { platform: 'sunos', pid: 4242, startMarker: '1', supervisor: { kind: 'posix-process-group', name: '4242' } },
    { platform: otherPlatform, pid: 4242, startMarker: '1', supervisor: { kind: otherPlatform === 'win32' ? 'windows-job-object' : 'posix-process-group', name: otherPlatform === 'win32' ? validJobName : '4242' } },
    { platform: process.platform, pid: 1, startMarker: '1', supervisor: { kind: 'posix-process-group', name: '1' } },
    { platform: process.platform, pid: 0, startMarker: '1', supervisor: { kind: 'posix-process-group', name: '0' } },
    { platform: process.platform, pid: -7, startMarker: '1', supervisor: { kind: 'posix-process-group', name: '-7' } },
    { platform: process.platform, pid: process.pid, startMarker: '1', supervisor: { kind: 'posix-process-group', name: String(process.pid) } },
    { platform: process.platform, pid: '4242', startMarker: '1', supervisor: { kind: 'posix-process-group', name: '4242' } },
    { platform: process.platform, pid: 42.5, startMarker: '1', supervisor: { kind: 'posix-process-group', name: '42.5' } },
    { platform: process.platform, pid: Number.MAX_SAFE_INTEGER + 2, startMarker: '1', supervisor: { kind: 'posix-process-group', name: '9007199254740993' } },
    { platform: process.platform, pid: 4242, startMarker: 12345, supervisor: { kind: 'posix-process-group', name: '4242' } },
    { platform: process.platform, pid: 4242, startMarker: '1', supervisor: null },
    { platform: process.platform, pid: 4242, startMarker: '1', supervisor: { kind: 'posix-process-group', name: '' } },
    { platform: process.platform, pid: 4242, startMarker: '1', supervisor: { kind: 'posix-process-group', name: 'not-the-pid' } },
    { platform: process.platform, pid: 4242, startMarker: '1', supervisor: { kind: 'posix-process-group', name: '04242' } },
    { platform: process.platform, pid: 4242, startMarker: '1', supervisor: { kind: 'unknown-adapter', name: 'x' } },
    { platform: process.platform, pid: 4242, startMarker: '1 2', supervisor: { kind: 'posix-process-group', name: '4242' } }
  ];
  for (const identity of malformed) {
    const recovery = await recoverRunnerProcess(identity);
    assert.equal(recovery.status, 'uncertain', `must quarantine ${JSON.stringify(identity)}`);
    assert.equal(recovery.drained, false, `must not report drained for ${JSON.stringify(identity)}`);
    assert.equal(typeof recovery.diagnostic, 'string');
    assert.match(String(recovery.diagnostic), /quarantine/, `diagnostic must explain quarantine for ${JSON.stringify(identity)}`);
  }
  assert.deepEqual(calls, [], 'a malformed identity must never trigger discovery or a signal');
});

test('identity guards: only this runner\'s own supervisor namespace is accepted', { timeout: TEST_TIMEOUT }, async t => {
  const calls = [];
  setContainmentSeams(t, {
    scan: async () => { calls.push('scan'); return { complete: true, processes: [] }; },
    confirm: async () => { calls.push('confirm'); return true; },
    signal: () => { calls.push('signal'); }
  });
  // Arbitrary or look-alike job object names, and a job name without a usable
  // creation marker, must be rejected before the recovery supervisor spawns.
  const jobNames = [
    'Local\\codex-runner-zzzzzzzzzzzzzzzzzzzzzzzz',
    'Local\\codex-runner-0123456789abcdef',
    'Local\\codex-runner-0123456789ABCDEF01234567',
    'Local\\codex-runner-0123456789abcdef0123456',
    'Local\\codex-runner-0123456789abcdef012345678',
    'Local\\codex-runner-',
    'Global\\codex-runner-0123456789abcdef01234567',
    'codex-runner-0123456789abcdef01234567',
    'Local\\codex-runner-0123456789abcdef01234567\\\\extra',
    'Local\\Codex-Runner-0123456789abcdef01234567'
  ];
  for (const name of jobNames) {
    const started = Date.now();
    const recovery = await recoverRunnerProcess({
      platform: process.platform,
      pid: 4242,
      startMarker: '134392000000000000',
      supervisor: { kind: 'windows-job-object', name }
    });
    assert.equal(recovery.status, 'uncertain', `must reject job name ${name}`);
    assert.equal(recovery.drained, false);
    assert.match(String(recovery.diagnostic), /quarantine/);
    assert.ok(Date.now() - started < 5000, `a rejected job name must not start a supervisor (${name})`);
    if (win) {
      assert.match(String(recovery.diagnostic), /job object/, `the reason must name the job namespace (${name})`);
    }
  }
  // A correctly shaped job name still needs a non-empty numeric creation marker.
  const noMarker = await recoverRunnerProcess({
    platform: process.platform,
    pid: 4242,
    startMarker: '',
    supervisor: { kind: 'windows-job-object', name: 'Local\\codex-runner-0123456789abcdef01234567' }
  });
  assert.equal(noMarker.status, 'uncertain');
  assert.equal(noMarker.drained, false);
  const textMarker = await recoverRunnerProcess({
    platform: process.platform,
    pid: 4242,
    startMarker: 'created-later',
    supervisor: { kind: 'windows-job-object', name: 'Local\\codex-runner-0123456789abcdef01234567' }
  });
  assert.equal(textMarker.status, 'uncertain');
  assert.equal(textMarker.drained, false);
  if (win) {
    assert.match(String(noMarker.diagnostic), /creation marker/);
    assert.match(String(textMarker.diagnostic), /creation marker/);
  }
  assert.deepEqual(calls, [], 'no rejected identity may trigger discovery or a signal');
});

test('drain guards: a marker outside this runner\'s namespace never drives discovery', { timeout: TEST_TIMEOUT }, async t => {
  const calls = [];
  setContainmentSeams(t, {
    scan: async () => { calls.push('scan'); return { complete: true, processes: [] }; },
    confirm: async () => { calls.push('confirm'); return true; },
    signal: () => { calls.push('signal'); }
  });
  const token = generatedMarker();
  const upper = 'C1A2B3D4E5F60718293A4B5C6D7E8F90';
  // Reserved/common environment values, wrong tokens, and near misses must be
  // refused before any scan, so unrelated processes can never be matched.
  const badMarkers = [
    { envName: 'PATH', marker: '/usr/bin:/bin' },
    { envName: 'PATH', marker: token },
    { envName: 'HOME', marker: token },
    { envName: RUNNER_DESCENDANT_MARKER_ENV.toLowerCase(), marker: token },
    { envName: `${RUNNER_DESCENDANT_MARKER_ENV}X`, marker: token },
    markerFor(''),
    markerFor('injected'),
    markerFor(process.env.PATH ?? '/usr/bin'),
    markerFor(upper),
    markerFor(token.slice(0, 31)),
    markerFor(`${token}0`),
    markerFor(`${token}-suffix`),
    {},
    null,
    'marker'
  ];
  const started = Date.now();
  for (const marker of badMarkers) {
    const drain = await drainMarkedDescendants(marker);
    assert.equal(drain.drained, false, `must refuse ${JSON.stringify(marker)}`);
    assert.match(String(drain.diagnostic), /no process was inspected/);
    assert.match(String(drain.diagnostic), /quarantine/);
  }
  assert.deepEqual(calls, [], 'a rejected marker must never trigger discovery or a signal');
  assert.ok(Date.now() - started < 5000, 'marker rejection must be immediate');
});

test('identity guards: a journaled POSIX marker outside the namespace is rejected first', { skip: skipPosix, timeout: TEST_TIMEOUT }, async t => {
  const calls = [];
  setContainmentSeams(t, {
    scan: async () => { calls.push('scan'); return { complete: true, processes: [] }; },
    confirm: async () => { calls.push('confirm'); return true; },
    signal: () => { calls.push('signal'); }
  });
  const base = {
    platform: process.platform,
    pid: 999_999,
    startMarker: '123456',
    supervisor: { kind: 'posix-process-group', name: '999999' }
  };
  for (const descendants of [
    { envName: 'PATH', marker: '/usr/bin:/bin' },
    { envName: RUNNER_DESCENDANT_MARKER_ENV, marker: 'injected' },
    { envName: RUNNER_DESCENDANT_MARKER_ENV, marker: 'C1A2B3D4E5F60718293A4B5C6D7E8F90' },
    { envName: RUNNER_DESCENDANT_MARKER_ENV },
    { marker: generatedMarker() },
    'marker'
  ]) {
    const recovery = await recoverRunnerProcess({ ...base, descendants });
    assert.equal(recovery.status, 'uncertain', `must reject ${JSON.stringify(descendants)}`);
    assert.equal(recovery.drained, false);
    assert.match(String(recovery.diagnostic), /quarantine/);
  }
  assert.deepEqual(calls, [], 'a rejected marker must be caught before discovery starts');
  // A legacy identity without a marker stays quarantined rather than drained.
  const legacy = await recoverRunnerProcess({ ...base, descendants: undefined });
  assert.equal(legacy.drained, false);
  assert.match(String(legacy.diagnostic), /quarantine/);
  assert.deepEqual(calls, [], 'a marker-less identity must not start a marker discovery pass either');
});

// ---------------------------------------------------------------------------
// Terminal-state and recovery regressions.
//
// A run's timeout/cancelled flags are only allowed to change while the command
// or a process it started is still alive. Once the tree is proven gone, only
// stdio flush and teardown remain, and a deadline or abort arriving there must
// not relabel a command that already finished.
// ---------------------------------------------------------------------------

const quick = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('quick.txt', 'quick');",
  "process.stdout.write('quick');",
  'process.exit(0);',
  ''
].join('\n');

test('a command that finished before its deadline is not relabelled by its own teardown', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'quick.cjs', quick);
  // The tail is longer than the whole deadline, but it starts only after the
  // command and every process it started are proven gone.
  setPostCompletionDelay(t, 2500);
  const result = await runRunnerProcess({
    command: 'node quick.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 1500,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.drained, true);
  assert.equal(result.timedOut, false, 'a command that finished before its deadline is not a timeout');
  assert.equal(result.cancelled, false);
  assert.equal(result.output.trim(), 'quick');
  assert.equal(await fs.readFile(path.join(dir, 'quick.txt'), 'utf8'), 'quick');
});

test('an abort during teardown cannot relabel an already finished command', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'quick.cjs', quick);
  setPostCompletionDelay(t, 2000);
  const controller = new AbortController();
  const pending = runRunnerProcess({
    command: 'node quick.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 30000,
    signal: controller.signal,
    authorize: () => undefined
  });
  await until(() => exists(path.join(dir, 'quick.txt')));
  // The command is finished here; the abort lands in the teardown tail.
  await sleep(600);
  controller.abort();
  const result = await pending;
  assert.equal(result.exitCode, 0, 'the command really completed');
  assert.equal(result.drained, true);
  assert.equal(result.cancelled, false, 'a finished command is not cancelled by its own teardown');
  assert.equal(result.timedOut, false);
  assert.equal(result.output.trim(), 'quick');
});

// A command that records the instant it really finished, so a case can prove
// the tree was gone before its deadline instead of assuming a startup time.
const timedQuick = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('quick.txt', 'quick');",
  "fs.writeFileSync('done.txt', String(Date.now()));",
  "process.stdout.write('quick');",
  'process.exit(0);',
  ''
].join('\n');

// A journal hook that stays pending for longer than the whole deadline but
// still settles well inside RUNNER_JOURNAL_LIMIT_MS. Both adapters must observe
// the completion proof while it is pending: the proof is what latches the
// deadline shut, and the journal outcome is still awaited before the result.
const SLOW_JOURNAL_MS = 3500;

test('a slow journal hook cannot relabel a command whose tree was already proven gone', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'quick.cjs', timedQuick);
  const invokedAt = Date.now();
  let journalSettledAt = 0;
  const result = await runRunnerProcess({
    command: 'node quick.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 2000,
    signal: new AbortController().signal,
    authorize: () => undefined,
    onStarted: async () => {
      await sleep(SLOW_JOURNAL_MS);
      journalSettledAt = Date.now();
    }
  });
  const elapsed = Date.now() - invokedAt;
  const doneAt = Number(await fs.readFile(path.join(dir, 'done.txt'), 'utf8'));
  // The premise of the case: the command really finished inside its deadline,
  // while the journal hook was still pending.
  assert.ok(Number.isFinite(doneAt) && doneAt > invokedAt, 'the command must record its own completion instant');
  assert.ok(doneAt - invokedAt < 2000, `the command must finish inside its 2000 ms deadline (${doneAt - invokedAt} ms)`);
  assert.ok(journalSettledAt > doneAt, 'the journal hook must still be pending when the command finishes');
  assert.equal(result.exitCode, 0);
  assert.equal(result.drained, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.timedOut, false, 'a command whose full tree was proven gone before its deadline is not a timeout');
  assert.equal(result.output.trim(), 'quick');
  assert.equal(await fs.readFile(path.join(dir, 'quick.txt'), 'utf8'), 'quick');
  // The journal outcome is still awaited before the result is returned: a
  // pending hook costs latency, never a wrong verdict and never a skipped join.
  assert.ok(elapsed >= SLOW_JOURNAL_MS, `the journal hook must still be awaited (${elapsed} ms)`);
});

test('a cancellation after the job proof cannot relabel a finished command while the journal is pending', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'quick.cjs', timedQuick);
  const controller = new AbortController();
  let journalSettledAt = 0;
  const pending = runRunnerProcess({
    command: 'node quick.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: controller.signal,
    authorize: () => undefined,
    onStarted: async () => {
      await sleep(SLOW_JOURNAL_MS);
      journalSettledAt = Date.now();
    }
  });
  // The command publishes its own completion first; the extra margin lets the
  // supervisor's empty-job proof and the marker/group drain finish, so the abort
  // below provably lands AFTER the tree was proven gone but while the journal
  // hook is still pending.
  await until(() => exists(path.join(dir, 'done.txt')));
  await sleep(900);
  assert.equal(journalSettledAt, 0, 'the abort must land while the journal hook is still pending');
  controller.abort();
  const result = await pending;
  assert.equal(result.exitCode, 0, 'the command really completed');
  assert.equal(result.drained, true);
  assert.equal(result.cancelled, false, 'a run whose tree was already proven gone is not cancelled by a later abort');
  assert.equal(result.timedOut, false);
  assert.equal(result.output.trim(), 'quick');
});

test('a live command still times out while the journal hook is pending', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'sleepy.cjs', sleepy);
  let journalCalls = 0;
  const result = await runRunnerProcess({
    command: 'node sleepy.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 900,
    signal: new AbortController().signal,
    authorize: () => undefined,
    onStarted: async () => {
      journalCalls += 1;
      await sleep(SLOW_JOURNAL_MS);
    }
  });
  assert.equal(journalCalls, 1);
  assert.equal(result.timedOut, true, 'a still-running owned tree keeps the deadline live even while the journal is pending');
  assert.equal(result.cancelled, false);
  assert.equal(result.drained, true);
  assert.equal(result.exitCode, null);
  await sleep(SLEEPY_MS + 300);
  assert.equal(await exists(path.join(dir, 'end.txt')), false, 'the timed out tree must not survive the journal wait');
});

test('a journal failure after the job proof still fails the result and never reports a clean success', { timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'quick.cjs', timedQuick);
  let rejected = false;
  const result = await runRunnerProcess({
    command: 'node quick.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined,
    onStarted: async () => {
      // The tree is proven gone first; the journal fails afterwards.
      await sleep(600);
      rejected = true;
      throw new Error('journal write failed');
    }
  });
  assert.equal(rejected, true);
  assert.match(String(result.diagnostic), /journal/);
  assert.equal(result.drained, true);
  assert.equal(result.exitCode, 0, 'the command itself really finished');
  await sleep(SLEEPY_MS + 300);
  assert.equal(await exists(path.join(dir, 'end.txt')), false, 'an unjournaled run must still leave nothing behind');
});

// A descendant that ignores SIGTERM keeps the owned tree alive through the
// whole grace period, so the deadline is the only thing that can still fire.
// It publishes readiness only AFTER its handler is installed, so the leader can
// wait for proof instead of racing the interpreter's startup.
const stubborn = [
  "process.on('SIGTERM', () => {});",
  "require('node:fs').writeFileSync('ready.txt', 'ready');",
  "setTimeout(() => process.exit(0), 60000);",
  ''
].join('\n');

// The leader must not exit before the child is armed. The runner drains the
// group with an immediate SIGTERM as soon as the leader exits, which used to
// kill the child before Node installed its handler: the tree then vanished,
// the deadline never fired, and the case silently stopped testing the deadline.
// Two independent defences, both race free:
//   * `trap '' TERM` makes the child immune from birth, because an ignored
//     disposition is inherited across fork/exec (pure POSIX, no startup timing);
//   * the bounded readiness handshake waits for ready.txt, so the leader exits
//     only once the child has really installed its handler.
// The handshake is bounded twice over: 20 iterations here, and the runner's own
// containment (deadline, SIGTERM grace, marker sweep) kills the group regardless.
const stubbornLeader = [
  "trap '' TERM",
  'node stubborn.cjs >/dev/null 2>&1 &',
  'i=0',
  'while [ ! -f ready.txt ] && [ "$i" -lt 20 ]; do',
  '  i=$((i + 1))',
  '  if sleep 0.02 2>/dev/null; then :; else sleep 1; fi',
  'done',
  'exit 0',
  ''
].join('\n');

test('posix: a deadline stays live while an owned descendant is still running', { skip: skipPosix, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  await write(dir, 'stubborn.cjs', stubborn);
  // The leader exits only after the child is armed; the child then ignores the
  // group SIGTERM for the whole grace period, so the deadline is what must fire.
  const result = await runRunnerProcess({
    command: stubbornLeader,
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 1000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.equal(await exists(path.join(dir, 'ready.txt')), true,
    'the child must publish readiness before the leader exits, or this case never tests the deadline');
  assert.equal(result.drained, true);
  assert.equal(result.timedOut, true, 'a still-running owned descendant keeps the deadline live');
});

test('windows: the supervisor close/flush wait settles instead of timing out', { skip: skipWindows, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  // Output written in one burst just before exit: only a real stdio flush keeps
  // the tail, and only the supervisor's own close event can prove that flush.
  await write(dir, 'burst.cjs',
    "process.stdout.write('HEAD');process.stdout.write('x'.repeat(120000));process.stdout.write('TAIL');\n");
  const waits = observeSupervisorCloseWait(t);
  const result = await runRunnerProcess({
    command: 'node burst.cjs',
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 20000,
    signal: new AbortController().signal,
    authorize: () => undefined
  });
  assert.deepEqual(waits, ['settled'], 'the close listener must be attached to the spawned supervisor');
  assert.equal(result.drained, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.endsWith('TAIL'), true, 'the flushed tail must be present in the bounded output');
});

// Real POSIX proof: a group whose leader already exited is reclaimed only
// through the marker sweep, which is the one ownership proof left.
test('posix: a real leader-less group is reclaimed by the marker sweep', { skip: skipPosixMarkers, timeout: TEST_TIMEOUT }, async t => {
  const dir = await workspace(t);
  const marker = generatedMarker();
  const markerEnv = { ...process.env, [RUNNER_DESCENDANT_MARKER_ENV]: marker };
  const childFile = path.join(dir, 'child.pid');
  const leader = spawn('/bin/sh', ['-c', `sleep 60 & echo $! > '${childFile}'; exit 0`], {
    detached: true, stdio: 'ignore', env: markerEnv
  });
  t.after(() => { try { process.kill(leader.pid, 'SIGKILL'); } catch { /* gone */ } });
  await until(() => exists(childFile));
  const childPid = Number(await fs.readFile(childFile, 'utf8'));
  t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } });
  // The leader has exited; its group id survives through `sleep` alone.
  await until(() => {
    try { process.kill(leader.pid, 0); return false; } catch { return true; }
  });
  await until(() => {
    try { process.kill(-leader.pid, 0); return true; } catch { return false; }
  });
  const recovery = await recoverRunnerProcess({
    platform: 'linux',
    pid: leader.pid,
    startMarker: '1',
    supervisor: { kind: 'posix-process-group', name: String(leader.pid) },
    descendants: markerFor(marker)
  });
  assert.equal(recovery.drained, true, `the owned descendant must be drained: ${String(recovery.diagnostic)}`);
  await until(() => {
    try { process.kill(childPid, 0); return false; } catch { return true; }
  });
});

// The same branch through injected probes, so it is proven on every host.
test('posix recovery: a leader-less live group is reclaimed only by a complete sweep', { timeout: TEST_TIMEOUT }, async t => {
  const identity = leaderGoneIdentity(markerFor(generatedMarker()));
  const calls = [];
  const signals = [];
  let groupAlive = true;
  let scans = 0;
  setRecoverySeams(t, {
    platform: 'linux',
    startMarker: async () => '',
    groupAlive: () => groupAlive
  });
  setContainmentSeams(t, {
    scan: async () => {
      calls.push('scan');
      scans += 1;
      if (scans >= 2) {
        // The owned set is empty, so the group disappears with it.
        groupAlive = false;
        return { complete: true, processes: [] };
      }
      return { complete: true, processes: [{ pid: identity.pid, startMarker: '7' }] };
    },
    confirm: async () => true,
    signal: (pid, signal) => { calls.push('signal'); signals.push([pid, signal]); }
  });
  const recovery = await recoverRunnerProcess(identity);
  assert.equal(recovery.drained, true, `the owned tree was drained: ${String(recovery.diagnostic)}`);
  assert.equal(recovery.status, 'terminated');
  assert.ok(calls.includes('scan'), 'the marker sweep must be what proves the leader-less group');
  assert.ok(signals.length > 0, 'the confirmed owned process must be signalled');
  for (const [pid] of signals) {
    assert.equal(pid, identity.pid, 'only a marker-confirmed pid is signalled, never a bare group id');
    assert.ok(pid > 1);
  }
});

test('posix recovery: a leader-less group without a marker stays quarantined', { timeout: TEST_TIMEOUT }, async t => {
  const identity = leaderGoneIdentity(undefined);
  const calls = [];
  setRecoverySeams(t, { platform: 'linux', startMarker: async () => '', groupAlive: () => true });
  setContainmentSeams(t, {
    scan: async () => { calls.push('scan'); return { complete: true, processes: [] }; },
    confirm: async () => { calls.push('confirm'); return true; },
    signal: () => { calls.push('signal'); }
  });
  const recovery = await recoverRunnerProcess(identity);
  assert.equal(recovery.status, 'uncertain');
  assert.equal(recovery.drained, false, 'a legacy record cannot prove the group is empty');
  assert.match(String(recovery.diagnostic), /quarantine/);
  assert.deepEqual(calls, [], 'no discovery or signal may run without a marker');
});

test('posix recovery: a leader-less group with an incomplete sweep stays quarantined', { timeout: TEST_TIMEOUT }, async t => {
  const identity = leaderGoneIdentity(markerFor(generatedMarker()));
  setRecoverySeams(t, { platform: 'linux', startMarker: async () => '', groupAlive: () => true });
  setContainmentSeams(t, {
    scan: async () => ({ complete: false, processes: [], diagnostic: 'injected: process table denied' }),
    confirm: async () => true,
    signal: () => undefined
  });
  const recovery = await recoverRunnerProcess(identity);
  assert.equal(recovery.status, 'uncertain');
  assert.equal(recovery.drained, false);
  assert.match(String(recovery.diagnostic), /injected: process table denied/);
  assert.match(String(recovery.diagnostic), /quarantine/);
});

test('posix recovery: a drained owned set with an unaccounted member stays quarantined', { timeout: TEST_TIMEOUT }, async t => {
  const identity = leaderGoneIdentity(markerFor(generatedMarker()));
  setRecoverySeams(t, { platform: 'linux', startMarker: async () => '', groupAlive: () => true });
  setContainmentSeams(t, {
    scan: async () => ({ complete: true, processes: [] }),
    confirm: async () => true,
    signal: () => undefined
  });
  const recovery = await recoverRunnerProcess(identity);
  assert.equal(recovery.status, 'uncertain');
  assert.equal(recovery.drained, false, 'a group member with no marker is not reclaimable');
  assert.match(String(recovery.diagnostic), /carries no run marker/);
  assert.match(String(recovery.diagnostic), /quarantine/);
});

// Last-resort watchdog: node:test per-test timeouts fire first, but a future
// regression must never leave a developer command hanging forever.
const watchdog = setTimeout(() => {
  console.error('runner-process tests exceeded their watchdog budget');
  process.exit(1);
}, 600_000);
watchdog.unref();
