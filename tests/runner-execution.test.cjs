// Focused runner-execution orchestration tests.
//
// Every case uses REAL temp directories, REAL fixture scripts materialized into
// the lease source directory and (except where a case deliberately injects a
// process result) the REAL reviewed process helper. The view port is an
// in-memory double because the host's isolated-views store is out of scope for
// this module; it mirrors the reviewed port contract: withView holds one
// coherent revision, edit plans one delta and publishes at most one revision.
//
// Loader: this module's dedicated build first, then CODEX_TEST_BUILD, then the
// shared .test-build used by npm test:
//   npx tsc -p tsconfig.json --outDir .test-runner-execution --sourceMap false

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dedicated = process.env.CODEX_RUNNER_EXECUTION_BUILD?.trim();
const shared = process.env.CODEX_TEST_BUILD?.trim();
const buildDir = path.resolve(__dirname, '..', dedicated || shared || '.test-build');
const runnerExecution = require(path.join(buildDir, 'runner-execution'));
const { LayeredTree } = require(path.join(buildDir, 'layered-tree'));
const { WorkerError } = require(path.join(buildDir, 'types'));

// Fail loudly against a stale compile instead of silently testing old code.
if (typeof runnerExecution.RunnerExecution !== 'function'
  || runnerExecution.RUNNER_EXECUTION_MATERIALIZER === undefined
  || runnerExecution.RUNNER_EXECUTION_DEFAULTS === undefined
  || !Array.isArray(runnerExecution.RUNNER_EXECUTION_CACHES)) {
  throw new Error(`stale or incomplete runner-execution build at ${buildDir}; recompile it`);
}
const { RunnerExecution, RUNNER_EXECUTION_MATERIALIZER, RUNNER_EXECUTION_CACHES } = runnerExecution;

const WINDOWS = process.platform === 'win32';
const TEST_TIMEOUT = 90_000;
const TEAM = 'a'.repeat(32);
const ISO = '2024-01-01T00:00:00.000Z';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async target => fs.lstat(target).then(() => true, () => false);

const hex32 = label => crypto.createHash('sha256').update(`runner-execution:${label}`).digest('hex').slice(0, 32);
const binding = { teamId: TEAM, snapshotId: 'a'.repeat(64), overlayId: 'b'.repeat(64) };
const identity = { ownerId: 'owner-execution', workerId: hex32('worker'), workerCreatedAt: ISO };
const scope = { ownerId: identity.ownerId, teamId: TEAM };

async function until(predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a runner side effect');
    }
    await sleep(25);
  }
}

const activeLease = execution => execution.pool.status().leases.find(record => record.state === 'leased');

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-execution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => undefined));
  return root;
}

// ---------------------------------------------------------------------------
// Fixture view port
// ---------------------------------------------------------------------------

function addFile(blobs, bytes, mode) {
  const buffer = Buffer.from(bytes);
  const hash = sha256(buffer);
  blobs.set(hash, buffer);
  return mode === undefined ? { type: 'file', hash, size: buffer.length } : { type: 'file', hash, size: buffer.length, mode };
}

function makePort(logicalRoot, options) {
  const blobs = options.blobs;
  const base = { ...options.entries };
  let deltas = [...(options.deltas ?? [])];
  let revision = options.revision ?? 1;
  const reads = [];
  const edits = [];
  const count = { withView: 0, edit: 0 };

  const makeView = () => {
    const tree = new LayeredTree(logicalRoot, base, deltas, { caseInsensitive: WINDOWS });
    return {
      tree,
      revision,
      async read(input) {
        reads.push(input);
        const key = tree.resolve(input);
        const entry = key === undefined ? undefined : tree.stat(key);
        if (!entry || entry.type !== 'file') {
          throw new WorkerError('not_found', `absent from the private view: ${input}`);
        }
        const bytes = blobs.get(entry.hash);
        if (bytes === undefined) {
          throw new WorkerError('snapshot_content_missing', `missing blob for ${entry.hash}`);
        }
        return { path: key, bytes: Buffer.from(bytes), hash: entry.hash };
      }
    };
  };

  return {
    blobs,
    reads,
    edits,
    count,
    revision: () => revision,
    baseEntries: () => structuredClone(base),
    entries: () => makeView().tree.entries,
    stat: key => makeView().tree.stat(key),
    /** Another writer publishes one private revision while a command runs. */
    advance(changes) {
      deltas = [...deltas, changes];
      revision += 1;
    },
    async withView(_binding, _identity, action, authorize) {
      authorize?.();
      count.withView += 1;
      return action(makeView());
    },
    async edit(_binding, _identity, planner, authorize) {
      authorize?.();
      count.edit += 1;
      const view = makeView();
      const changes = await planner(view, async bytes => {
        const hash = sha256(bytes);
        blobs.set(hash, Buffer.from(bytes));
        return hash;
      });
      const effective = Object.fromEntries(Object.entries(changes).filter(([key, entry]) =>
        JSON.stringify(view.tree.entries[key] ?? null) !== JSON.stringify(entry)));
      if (Object.keys(effective).length === 0) {
        return { revision: view.revision };
      }
      edits.push({ revision: view.revision, changes: effective });
      deltas = [...deltas, effective];
      revision = view.revision + 1;
      return { revision };
    }
  };
}

// ---------------------------------------------------------------------------
// Fixture scripts (real files inside the view, never shell-escaped strings)
// ---------------------------------------------------------------------------

const SCRIPTS = {
  // Reports the bytes it actually sees, plus where it was told to write temp and
  // cache data. `tools/` is skipped so its own hash is not part of the report.
  'tools/report.cjs': [
    "const fs = require('node:fs');",
    "const crypto = require('node:crypto');",
    "const path = require('node:path');",
    'const walk = (base, prefix) => fs.readdirSync(base, { withFileTypes: true }).flatMap(entry => {',
    '  const key = prefix === "" ? entry.name : prefix + "/" + entry.name;',
    '  return entry.isDirectory() ? walk(path.join(base, entry.name), key) : [key];',
    '});',
    'const hashes = {};',
    'for (const key of walk(process.cwd(), "").sort()) {',
    '  if (key.startsWith("tools/")) { continue; }',
    '  hashes[key] = crypto.createHash("sha256").update(fs.readFileSync(key)).digest("hex");',
    '}',
    'process.stdout.write(JSON.stringify({',
    '  cwd: process.cwd(), hashes,',
    '  tmp: process.env.TMP, temp: process.env.TEMP, tmpdir: process.env.TMPDIR,',
    '  npmCache: process.env.NPM_CONFIG_CACHE, pipCache: process.env.PIP_CACHE_DIR,',
    '  node: process.version',
    '}));',
    ''
  ].join('\n'),
  // Reports every environment name this service owns (with any case variant)
  // plus unrelated variables, so a test can prove that only the lease-local temp
  // and the managed download caches survive.
  'tools/env.cjs': [
    'const managed = [];',
    'for (const key of Object.keys(process.env)) {',
    '  if (/^(tmp|temp|tmpdir|npm_config_cache|pip_cache_dir)$/i.test(key)) { managed.push([key, process.env[key]]); }',
    '}',
    'managed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));',
    'process.stdout.write(JSON.stringify({',
    '  managed, keep: process.env.CODEX_KEEP ?? null, custom: process.env.CODEX_CUSTOM ?? null,',
    '  path: process.env.PATH ?? process.env.Path ?? null',
    '}));',
    ''
  ].join('\n'),
  // A real formatter/codegen step: rewrite, create and delete private sources.
  // Paths are resolved against the project root, so the command may also run
  // from a subdirectory and still change the whole private tree.
  'tools/format.cjs': [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const root = path.resolve(__dirname, '..');",
    "fs.writeFileSync(path.join(root, 'src', 'app.ts'), '\\ufeffexport const a = 2;\\r\\n');",
    "fs.writeFileSync(path.join(root, 'src', 'generated.ts'), 'export const generated = true;\\n');",
    "fs.rmSync(path.join(root, 'src', 'legacy.ts'));",
    "process.stdout.write('formatted\\n');",
    ''
  ].join('\n'),
  'tools/write-exit.cjs': [
    "const fs = require('node:fs');",
    "fs.writeFileSync('src/out.txt', 'exit-7\\n');",
    'process.exit(7);',
    ''
  ].join('\n'),
  // Writes a private source change and announces itself in the lease temp
  // directory, so a test can cancel exactly after the write happened.
  'tools/write-wait.cjs': [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.writeFileSync('src/partial.txt', 'partial\\n');",
    "fs.writeFileSync(path.join(process.env.TMP, 'started.txt'), 'yes');",
    'setTimeout(() => { process.exit(0); }, 60000);',
    ''
  ].join('\n')
};

async function fixtureView(logicalRoot, extra = {}) {
  const blobs = new Map();
  const entries = {
    src: { type: 'directory' },
    'src/app.ts': addFile(blobs, '\ufeffexport const a = 1;\r\n'),
    'src/legacy.ts': addFile(blobs, 'export const legacy = true;\r\n'),
    'README.md': addFile(blobs, '# demo\r\n'),
    assets: { type: 'directory' },
    'assets/logo.bin': addFile(blobs, Buffer.from([0, 1, 2, 255, 13, 10, 239, 187, 191])),
    tools: { type: 'directory' },
    ...Object.fromEntries(Object.entries(SCRIPTS).map(([key, text]) => [key, addFile(blobs, text)])),
    ...(extra.entries ?? {})
  };
  const overlay = extra.overlay ?? {
    'src/app.ts': addFile(blobs, '\ufeffexport const a = 9;\r\n'),
    'src/added.txt': addFile(blobs, '\ufeffnew\r\nline')
  };
  const port = makePort(logicalRoot, {
    blobs,
    entries,
    deltas: [overlay],
    revision: extra.revision ?? 3
  });
  return { port, blobs };
}

// ---------------------------------------------------------------------------
// Execution harness
// ---------------------------------------------------------------------------

async function makeExecution(t, options = {}) {
  const root = await tempRoot(t);
  const project = path.join(root, 'project');
  const executionRoot = path.join(root, 'store', 'execution');
  await fs.mkdir(project, { recursive: true });
  const approvals = [];
  const execution = new RunnerExecution(executionRoot, project, {
    capacity: options.capacity ?? 2,
    maxQueue: options.maxQueue ?? 4,
    closeTimeoutMs: options.closeTimeoutMs ?? 20_000,
    approveCommand: options.approveCommand ?? (async request => {
      approvals.push(request);
      return true;
    }),
    ...(options.guard === undefined ? {} : { guard: options.guard }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner })
  });
  await execution.open();
  t.after(async () => {
    await execution.close().catch(() => undefined);
  });
  return { root, project, executionRoot, execution, approvals, view: await fixtureView(project) };
}

const command = script => `node ${script}`;

test('configuration is bounded, open is lazy and single-flight, and a failed handle stays closed', { timeout: TEST_TIMEOUT }, async t => {
  const root = await tempRoot(t);
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  const executionRoot = path.join(root, 'store', 'execution');
  const defaults = new RunnerExecution(executionRoot, project, { approveCommand: async () => true });
  assert.equal(defaults.pool.capacity, 2);
  assert.equal(defaults.pool.maxQueue, 32);
  assert.equal(RUNNER_EXECUTION_MATERIALIZER, 'runner-view/1');
  assert.deepEqual([...RUNNER_EXECUTION_CACHES], ['npm', 'pip']);

  // Invalid configuration is refused before any directory exists.
  assert.throws(() => new RunnerExecution('relative', project, { approveCommand: async () => true }), { code: 'invalid_path' });
  assert.throws(() => new RunnerExecution(executionRoot, 'relative', { approveCommand: async () => true }), { code: 'invalid_path' });
  assert.throws(() => new RunnerExecution(executionRoot, project, {}), { code: 'invalid_runner_execution_config' });
  assert.throws(() => new RunnerExecution(path.join(project, 'inside'), project, { approveCommand: async () => true }), { code: 'invalid_path' });
  assert.throws(() => new RunnerExecution(path.join(root, 'store'), project, { approveCommand: async () => true, guard: 1 }), { code: 'invalid_runner_execution_config' });

  // Nothing is written or executed before open().
  const view = await fixtureView(project);
  assert.throws(() => defaults.execute(binding, identity, view.port, { command: command('tools/report.cjs') }, new AbortController().signal),
    { code: 'runner_execution_unavailable' });
  assert.equal(await exists(executionRoot), false);

  // Single-flight open: the second call resolves through the same attempt.
  await Promise.all([defaults.open(), defaults.open()]);
  assert.equal(defaults.status().open, true);
  assert.equal(defaults.status().pool.slots.length, 2);
  for (const kind of RUNNER_EXECUTION_CACHES) {
    const target = path.join(executionRoot, 'manager-cache', kind);
    assert.equal((await fs.stat(target)).isDirectory(), true, `${kind} cache must exist`);
    assert.equal((await fs.stat(target)).isSymbolicLink(), false);
  }
  // The caches live outside the canonical project root.
  assert.equal(path.relative(project, executionRoot).startsWith('..'), true);
  await defaults.close();
  assert.equal(defaults.status().closed, true);
  assert.throws(() => defaults.execute(binding, identity, view.port, { command: command('tools/report.cjs') }, new AbortController().signal),
    { code: 'runner_execution_closed' });

  // A path occupied by a regular file fails closed and refuses every later call.
  const blockedRoot = path.join(root, 'blocked', 'execution');
  await fs.mkdir(path.dirname(blockedRoot), { recursive: true });
  await fs.writeFile(blockedRoot, 'not a directory');
  const blocked = new RunnerExecution(blockedRoot, project, { approveCommand: async () => true });
  await assert.rejects(blocked.open(), { code: 'invalid_path' });
  await assert.rejects(blocked.open(), { code: 'runner_execution_unavailable' });
  assert.throws(() => blocked.status(), { code: 'runner_execution_unavailable' });
  assert.throws(() => blocked.execute(binding, identity, view.port, { command: command('tools/report.cjs') }, new AbortController().signal),
    { code: 'runner_execution_unavailable' });
});

test('a command sees exactly the materialized snapshot+overlay and records its setup', { timeout: TEST_TIMEOUT }, async t => {
  const { project, executionRoot, execution, approvals, view } = await makeExecution(t);
  const result = await execution.execute(binding, identity, view.port,
    { command: command('tools/report.cjs'), timeoutMs: 30_000 }, new AbortController().signal);

  // The command ran in a private materialization, never in the live project.
  assert.equal(approvals.length, 1);
  const request = approvals[0];
  assert.equal(request.logicalRoot, path.resolve(project));
  assert.match(request.cwd, /source$/);
  assert.equal(path.relative(project, request.cwd).startsWith('..'), true);
  assert.equal(request.executionRoot, path.dirname(request.cwd));
  assert.equal(request.inputVersion.revision, 3);
  assert.equal(request.inputVersion.snapshotId, binding.snapshotId);
  assert.equal(request.inputVersion.overlayId, binding.overlayId);

  assert.equal(result.schema, 1);
  assert.equal(result.version, 1);
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.drained, true);
  assert.equal(result.truncated, false);
  assert.equal(result.import, 'unchanged');
  assert.deepEqual(result.afterVersion, result.attempt.inputVersion);
  assert.equal(result.attempt.id, result.attempt.leaseId);
  assert.equal(result.attempt.logicalRoot, path.resolve(project));
  assert.equal(result.attempt.executionDirectory, request.cwd);
  assert.equal(result.attempt.command, command('tools/report.cjs'));
  assert.equal(result.attempt.owner.ownerId, identity.ownerId);
  assert.equal(result.attempt.owner.teamId, TEAM);

  // Setup identity: digests only, two DOWNLOAD caches, no raw environment dump.
  const setup = result.attempt.setup;
  assert.match(setup.identityHash, /^[a-f0-9]{64}$/);
  assert.match(setup.environmentHash, /^[a-f0-9]{64}$/);
  assert.equal(setup.platform, process.platform);
  assert.equal(setup.arch, process.arch);
  assert.equal(setup.nodeVersion, process.version);
  assert.equal(setup.caches.length, 2);
  for (const kind of RUNNER_EXECUTION_CACHES) {
    assert.ok(setup.caches.includes(`${kind}:${path.join(executionRoot, 'manager-cache', kind)}`), `cache identity for ${kind}`);
  }
  if (!WINDOWS) {
    assert.equal(setup.shell, '/bin/sh');
  }

  // The report shows the merged private content, BOM/binary bytes included.
  const report = JSON.parse(result.output);
  assert.equal(report.cwd, request.cwd);
  const expected = {};
  for (const [key, entry] of Object.entries(view.port.entries())) {
    if (entry.type === 'file' && !key.startsWith('tools/')) {
      expected[key] = entry.hash;
    }
  }
  assert.deepEqual(report.hashes, expected);
  assert.equal(report.hashes['src/app.ts'], sha256(Buffer.from('\ufeffexport const a = 9;\r\n')));
  assert.equal(report.hashes['assets/logo.bin'], sha256(Buffer.from([0, 1, 2, 255, 13, 10, 239, 187, 191])));
  assert.equal(report.hashes['src/added.txt'], sha256(Buffer.from('\ufeffnew\r\nline')));

  // Temp data is lease-local and the shared caches are the checked manager ones.
  assert.equal(report.tmp, report.temp);
  assert.equal(report.tmp, report.tmpdir);
  assert.equal(path.relative(project, report.tmp).startsWith('..'), true);
  assert.equal(report.npmCache, path.join(executionRoot, 'manager-cache', 'npm'));
  assert.equal(report.pipCache, path.join(executionRoot, 'manager-cache', 'pip'));

  // Nothing was imported and nothing is left behind; the live project is empty.
  assert.equal(view.port.revision(), 3);
  assert.equal(view.port.edits.length, 0);
  assert.deepEqual(await fs.readdir(project), []);
  assert.equal(await exists(request.executionRoot), false);
  assert.deepEqual(execution.pool.status().slots.map(slot => slot.state), ['free', 'free']);
});

test('a formatter publishes exactly one private revision and leaves the snapshot untouched', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t);
  const before = JSON.stringify(view.port.baseEntries());
  const result = await execution.execute(binding, identity, view.port,
    { command: command('../tools/format.cjs'), path: 'src' }, new AbortController().signal);

  assert.equal(result.outcome, 'succeeded', JSON.stringify({
    diagnostic: result.diagnostic, import: result.import, exitCode: result.exitCode, output: result.output
  }));
  assert.equal(result.import, 'imported');
  assert.equal(result.afterVersion.revision, 4);
  assert.equal(result.afterVersion.snapshotId, binding.snapshotId);
  assert.equal(result.afterVersion.overlayId, binding.overlayId);
  assert.equal(result.attempt.executionDirectory.endsWith(`${path.sep}src`), true);

  // Exactly one delta, published once.
  assert.equal(view.port.edits.length, 1);
  assert.equal(view.port.revision(), 4);
  assert.deepEqual(Object.keys(view.port.edits[0].changes).sort(), ['src/app.ts', 'src/generated.ts', 'src/legacy.ts']);
  assert.equal(view.port.edits[0].changes['src/legacy.ts'], null);
  assert.deepEqual(view.port.stat('src/generated.ts'), {
    type: 'file', hash: sha256(Buffer.from('export const generated = true;\n')),
    size: Buffer.byteLength('export const generated = true;\n')
  });
  assert.equal(view.port.stat('src/app.ts').hash, sha256(Buffer.from('\ufeffexport const a = 2;\r\n')));
  assert.equal(view.port.stat('src/legacy.ts'), undefined);
  // Untouched files keep their identity, and the base snapshot never changed.
  assert.equal(view.port.stat('assets/logo.bin').hash, sha256(Buffer.from([0, 1, 2, 255, 13, 10, 239, 187, 191])));
  assert.equal(JSON.stringify(view.port.baseEntries()), before);
  // The command's own output is preserved on the result.
  assert.match(result.output, /formatted/);
});

test('a nonzero exit still imports its changes and is recorded as failed', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t);
  const result = await execution.execute(binding, identity, view.port,
    { command: command('tools/write-exit.cjs') }, new AbortController().signal);

  assert.equal(result.outcome, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.drained, true);
  assert.equal(result.import, 'imported');
  assert.equal(result.afterVersion.revision, 4);
  assert.deepEqual(view.port.stat('src/out.txt'), {
    type: 'file', hash: sha256(Buffer.from('exit-7\n')), size: 7
  });
  assert.equal(view.port.revision(), 4);
  // The lease directory is gone: an accounted-for import does not need preserving.
  const record = execution.pool.status().leases.find(entry => entry.leaseId === result.id);
  assert.equal(record.state, 'released');
  assert.equal(await exists(record.directory), false);
});

test('a cancelled command is drained and its partial changes are imported', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t, { capacity: 1 });
  const controller = new AbortController();
  const pending = execution.execute(binding, identity, view.port,
    { command: command('tools/write-wait.cjs'), timeoutMs: 60_000 }, controller.signal);

  const lease = await until(() => activeLease(execution));
  await until(() => exists(path.join(lease.tempDir, 'started.txt')));
  controller.abort();
  const result = await pending;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.drained, true);
  assert.equal(result.import, 'imported');
  assert.equal(result.afterVersion.revision, 4);
  assert.equal(view.port.stat('src/partial.txt').hash, sha256(Buffer.from('partial\n')));
  // The command's abort signal is NOT allowed to block the import, but the
  // lease is released safely because the import was complete.
  assert.equal(execution.pool.status().slots[0].state, 'free');
  assert.equal(await exists(lease.directory), false);
});

test('a queued command cancelled before approval never approves or runs', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, approvals, view } = await makeExecution(t, { capacity: 1, maxQueue: 2 });
  const first = new AbortController();
  const running = execution.execute(binding, identity, view.port,
    { command: command('tools/write-wait.cjs'), timeoutMs: 60_000 }, first.signal);
  const lease = await until(() => activeLease(execution));
  await until(() => exists(path.join(lease.tempDir, 'started.txt')));
  assert.equal(approvals.length, 1);

  const queuedController = new AbortController();
  const queued = execution.execute(binding, identity, view.port,
    { command: command('tools/format.cjs'), timeoutMs: 60_000 }, queuedController.signal);
  await sleep(120);
  assert.equal(execution.pool.status().queue.length, 1);
  queuedController.abort();
  await assert.rejects(queued, { code: 'pool_aborted' });
  assert.equal(approvals.length, 1, 'a queued command must never reach approval');
  assert.equal(view.port.count.withView, 1, 'a queued command must never materialize a view');
  assert.equal(view.port.revision(), 3);

  first.abort();
  const result = await running;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(execution.pool.status().slots[0].state, 'free');
});

test('authorization revoked while approval is pending blocks the actual spawn', { timeout: TEST_TIMEOUT }, async t => {
  let revoked = false;
  let releaseApproval;
  const approvalSeen = [];
  const { execution, view } = await makeExecution(t, {
    guard: () => {
      if (revoked) {
        throw new Error('feature disabled');
      }
    },
    approveCommand: request => {
      approvalSeen.push(request);
      return new Promise(resolve => {
        releaseApproval = resolve;
      });
    }
  });
  const pending = execution.execute(binding, identity, view.port,
    { command: command('tools/write-exit.cjs') }, new AbortController().signal);
  await until(() => approvalSeen.length === 1);
  // The command cannot run while the approval is open, and the grant is revoked
  // before the prompt answers: the live recheck must refuse the spawn.
  assert.equal(await exists(path.join(approvalSeen[0].executionRoot, 'source', 'src', 'out.txt')), false);
  revoked = true;
  releaseApproval(true);
  const result = await pending;

  assert.equal(result.outcome, 'denied');
  assert.equal(result.import, 'not_started');
  assert.equal(result.afterVersion, null);
  assert.equal(result.exitCode, null);
  assert.equal(result.output, '');
  assert.equal(result.drained, true);
  assert.match(result.diagnostic, /feature disabled/);
  assert.equal(view.port.revision(), 3);
  assert.equal(view.port.edits.length, 0);
  assert.equal(execution.pool.status().slots[0].state, 'free');
});

test('a private revision published while the command ran is never overwritten', { timeout: TEST_TIMEOUT }, async t => {
  const { runRunnerProcess } = require(path.join(buildDir, 'runner-process'));
  let port;
  const { execution, view } = await makeExecution(t, {
    capacity: 1,
    processRunner: async input => {
      const result = await runRunnerProcess(input);
      // Another writer publishes one newer private revision while the command
      // finishes, so the recorded input revision is stale.
      port.advance({ 'external.txt': addFile(view.blobs, 'external\n') });
      return result;
    }
  });
  port = view.port;
  const result = await execution.execute(binding, identity, port,
    { command: command('tools/format.cjs') }, new AbortController().signal);

  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.import, 'uncertain');
  assert.equal(result.afterVersion, null);
  assert.match(result.diagnostic, /not imported/);
  // The newer private revision survived untouched: no delta was published.
  assert.equal(port.revision(), 4);
  assert.equal(port.edits.length, 0);
  assert.equal(port.stat('external.txt').hash, sha256(Buffer.from('external\n')));
  assert.equal(port.stat('src/generated.ts'), undefined);
  assert.equal(port.stat('src/app.ts').hash, sha256(Buffer.from('\ufeffexport const a = 9;\r\n')));
  // The materialized directory is quarantined and its slot stays consumed.
  const lease = execution.pool.status().leases.find(entry => entry.leaseId === result.id);
  assert.equal(lease.state, 'quarantined');
  assert.equal(lease.preserve, true);
  assert.equal(await exists(lease.directory), true);
  assert.equal(execution.pool.status().slots[0].state, 'quarantined');
});

test('an unsupported view entry fails setup durably and never starts a process', { timeout: TEST_TIMEOUT }, async t => {
  let started = 0;
  const { execution, view } = await makeExecution(t, {
    processRunner: async () => {
      started += 1;
      throw new Error('a process must never start for a failed setup');
    }
  });
  const port = makePort(path.resolve(execution.logicalRoot), {
    blobs: view.blobs,
    entries: {
      'src': { type: 'directory' },
      'src/app.ts': addFile(view.blobs, 'ok\n'),
      'bin': { type: 'directory' },
      'bin/ghost.dll': { type: 'unsupported', detail: 'symlink' }
    }
  });
  const result = await execution.execute(binding, identity, port,
    { command: command('tools/report.cjs') }, new AbortController().signal);

  assert.equal(result.outcome, 'setup_failed');
  assert.equal(result.import, 'not_started');
  assert.equal(result.afterVersion, null);
  assert.equal(result.drained, true);
  assert.match(result.diagnostic, /unsupported/i);
  assert.equal(started, 0);
  assert.equal(port.count.edit, 0);
  assert.equal(execution.pool.status().slots[0].state, 'free');
});

test('an unproven drain quarantines the lease and blocks reuse', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t, {
    capacity: 1,
    maxQueue: 1,
    processRunner: async () => ({
      identity: {
        platform: process.platform,
        pid: 4242,
        startMarker: 'marker',
        supervisor: { kind: WINDOWS ? 'windows-job-object' : 'posix-process-group', name: '4242' }
      },
      exitCode: 0,
      signal: null,
      output: 'wrote something',
      truncated: false,
      timedOut: false,
      cancelled: false,
      drained: false,
      diagnostic: 'the tree is unproven'
    })
  });
  const result = await execution.execute(binding, identity, view.port,
    { command: command('tools/write-exit.cjs') }, new AbortController().signal);

  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.drained, false);
  assert.equal(result.import, 'uncertain');
  assert.equal(result.afterVersion, null);
  assert.equal(view.port.edits.length, 0, 'an undrained directory is never imported');
  const lease = execution.pool.status().leases.find(entry => entry.leaseId === result.id);
  assert.equal(lease.state, 'quarantined');
  assert.equal(await exists(lease.directory), true);

  // The quarantined slot still consumes capacity, so reuse is blocked.
  const blocked = new AbortController();
  const second = execution.execute(binding, identity, view.port,
    { command: command('tools/report.cjs') }, blocked.signal);
  await sleep(120);
  assert.equal(execution.pool.status().queue.length, 1);
  blocked.abort();
  await assert.rejects(second, { code: 'pool_aborted' });
  assert.equal(execution.pool.status().slots[0].state, 'quarantined');
});

test('close aborts, drains and waits for the active command before closing the store', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t, { capacity: 1 });
  const pending = execution.execute(binding, identity, view.port,
    { command: command('tools/write-wait.cjs'), timeoutMs: 60_000 }, new AbortController().signal);
  const lease = await until(() => activeLease(execution));
  await until(() => exists(path.join(lease.tempDir, 'started.txt')));

  const order = [];
  const settled = pending.then(result => {
    order.push('command');
    return result;
  }, error => {
    order.push('command-failed');
    throw error;
  });
  const closing = execution.close().then(() => order.push('close'));
  const result = await settled;
  await closing;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.drained, true);
  assert.deepEqual(order, ['command', 'close'], 'close must wait for the command to settle');
  assert.equal(execution.status().closed, true);
  assert.equal(execution.status().open, false);
  assert.equal(execution.results.status().closed, true);
  assert.equal(execution.pool.status().slots[0].state, 'free');
  assert.throws(() => execution.execute(binding, identity, view.port,
    { command: command('tools/report.cjs') }, new AbortController().signal), { code: 'runner_execution_closed' });
});

test('successive leases keep outputs and temp private while the download cache path is reused', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t, { capacity: 1 });

  const runs = [];
  for (let index = 0; index < 2; index += 1) {
    const pending = execution.execute(binding, identity, view.port,
      { command: command('tools/report.cjs') }, new AbortController().signal);
    const record = await until(() => activeLease(execution));
    runs.push({ record, result: await pending });
  }

  const [first, second] = runs;
  assert.notEqual(first.record.tempDir, second.record.tempDir);
  assert.notEqual(first.record.directory, second.record.directory);
  // Both leases are gone, so no output or temp data can leak into a later run.
  assert.equal(await exists(first.record.directory), false);
  assert.equal(await exists(second.record.directory), false);
  const firstReport = JSON.parse(first.result.output);
  const secondReport = JSON.parse(second.result.output);
  assert.deepEqual(firstReport.hashes, secondReport.hashes);
  assert.equal(Object.keys(secondReport.hashes).some(key => key.startsWith('src/out')), false);
  assert.notEqual(firstReport.tmp, secondReport.tmp);
  assert.equal(firstReport.npmCache, secondReport.npmCache);
  assert.equal(firstReport.pipCache, secondReport.pipCache);
});

test('cleanup refuses to discard a lease whose process identity cannot be proven', { timeout: TEST_TIMEOUT }, async t => {
  const { execution } = await makeExecution(t, { capacity: 1 });
  const lease = await execution.pool.acquire({
    ownerId: identity.ownerId, teamId: TEAM, workerId: identity.workerId, workerCreatedAt: identity.workerCreatedAt
  });
  // A partial identity is valid journal JSON but is NOT a provable containment
  // identity, so cleanup must preserve the directory.
  await lease.checkpoint({ phase: 'executing', process: { platform: process.platform, pid: 999_999 } });
  await lease.release({ drained: false, diagnostic: 'left by a crashed host' });

  const cleaned = await execution.cleanup(scope);
  assert.deepEqual(cleaned.discarded, []);
  assert.equal(cleaned.retained.length, 1);
  assert.equal(cleaned.retained[0].leaseId, lease.id);
  assert.match(cleaned.retained[0].reason, /drain could not be proven/);
  assert.equal(await exists(lease.directory), true);
  assert.equal(execution.pool.status().slots[0].state, 'quarantined');
  // An unrelated scope is never touched.
  assert.deepEqual(await execution.cleanup({ ownerId: 'someone-else', teamId: TEAM }), {
    discarded: [], retained: [], unknownEntries: []
  });
  // The quarantined lease still consumes the only slot, so nothing is reused.
  const blocked = new AbortController();
  const queued = execution.execute(binding, identity, {
    withView: async () => assert.fail('a queued command must never materialize a view'),
    edit: async () => assert.fail('a queued command must never import')
  }, { command: command('tools/report.cjs') }, blocked.signal);
  await sleep(120);
  assert.equal(execution.pool.status().queue.length, 1);
  blocked.abort();
  await assert.rejects(queued, { code: 'pool_aborted' });
});

test('a logical absolute path resolves inside the materialization and escapes are refused', { timeout: TEST_TIMEOUT }, async t => {
  const { project, execution, approvals, view } = await makeExecution(t, {
    approveCommand: async request => {
      approvals.push(request);
      return false;
    }
  });

  // An absolute LOGICAL project path is accepted and mapped into the lease.
  const denied = await execution.execute(binding, identity, view.port,
    { command: command('tools/report.cjs'), path: path.join(project, 'src') }, new AbortController().signal);
  assert.equal(denied.outcome, 'denied');
  assert.equal(approvals.length, 1);
  const request = approvals[0];
  assert.equal(path.basename(request.cwd), 'src');
  assert.equal(request.cwd.startsWith(`${request.executionRoot}${path.sep}`), true);
  assert.equal(path.relative(project, request.cwd).startsWith('..'), true, 'the command never runs in the live project');
  assert.equal(request.inputVersion.revision, 3);

  // Escaping and non-directory logical paths are refused before any attempt is
  // recorded, so nothing reaches the results store.
  await assert.rejects(execution.execute(binding, identity, view.port,
    { command: command('tools/report.cjs'), path: '../outside' }, new AbortController().signal), { code: 'invalid_path' });
  await assert.rejects(execution.execute(binding, identity, view.port,
    { command: command('tools/report.cjs'), path: path.join(path.dirname(project), 'elsewhere') }, new AbortController().signal),
  { code: 'invalid_path' });
  await assert.rejects(execution.execute(binding, identity, view.port,
    { command: command('tools/report.cjs'), path: 'README.md' }, new AbortController().signal), { code: 'invalid_path' });
  await assert.rejects(execution.execute(binding, identity, view.port,
    { command: command('tools/report.cjs'), path: 'missing' }, new AbortController().signal), { code: 'invalid_path' });
  assert.equal(execution.results.status().results, 1, 'only the denied attempt was recorded');
  assert.equal(execution.results.status().pending, 0);
});

test('a timed out command is drained and its partial changes are imported', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t, { capacity: 1 });
  const result = await execution.execute(binding, identity, view.port,
    { command: command('tools/write-wait.cjs'), timeoutMs: 3_000 }, new AbortController().signal);

  assert.equal(result.outcome, 'timed_out');
  assert.equal(result.drained, true);
  assert.equal(result.exitCode, null);
  // Whatever the command managed to write before the timeout is imported.
  assert.ok(['imported', 'unchanged'].includes(result.import));
  if (result.import === 'imported') {
    assert.equal(result.afterVersion.revision, 4);
    assert.equal(view.port.stat('src/partial.txt').hash, sha256(Buffer.from('partial\n')));
  } else {
    assert.equal(result.afterVersion.revision, 3);
  }
  assert.equal(execution.pool.status().slots[0].state, 'free');
});

// ---------------------------------------------------------------------------
// Lifecycle, environment and persistence-window regressions
// ---------------------------------------------------------------------------

const recursiveListing = async (root, base = '') => {
  const entries = [];
  let names;
  try {
    names = (await fs.readdir(base === '' ? root : path.join(root, base))).sort();
  } catch {
    return entries;
  }
  for (const name of names) {
    const relative = base === '' ? name : `${base}/${name}`;
    const stat = await fs.lstat(path.join(root, relative));
    entries.push(`${relative}:${stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other'}`);
    if (stat.isDirectory()) {
      entries.push(...await recursiveListing(root, relative));
    }
  }
  return entries;
};

test('close waits for an in-flight open and writes nothing after it returns', { timeout: TEST_TIMEOUT }, async t => {
  const root = await tempRoot(t);
  const project = path.join(root, 'project');
  const executionRoot = path.join(root, 'store', 'execution');
  await fs.mkdir(project, { recursive: true });
  const execution = new RunnerExecution(executionRoot, project, { approveCommand: async () => true });

  // The open proceeds normally to its first write, then stalls just before a
  // later one, so close() definitely arrives WHILE the open is still working.
  const openOnce = execution.openOnce.bind(execution);
  const ensureDirectory = execution.ensureDirectory.bind(execution);
  const open = { wroteAt: 0, calls: 0 };
  execution.openOnce = async () => {
    await sleep(50);
    return openOnce();
  };
  execution.ensureDirectory = async (...args) => {
    open.calls += 1;
    const stalled = open.calls > 1;
    if (stalled) {
      await sleep(400);
    }
    const result = await ensureDirectory(...args);
    open.wroteAt = Date.now();
    return result;
  };
  t.after(() => execution.close().catch(() => undefined));

  const opening = execution.open();
  await until(() => open.calls >= 2);
  const closing = execution.close();
  // New work is refused immediately, and open() must not start after close.
  assert.throws(() => execution.execute(binding, identity, {
    withView: async () => assert.fail('a closed handle must never materialize a view'),
    edit: async () => assert.fail('a closed handle must never import')
  }, { command: command('tools/report.cjs') }, new AbortController().signal), { code: 'runner_execution_closed' });
  await assert.rejects(execution.open(), { code: 'runner_execution_closed' });

  const settled = await Promise.allSettled([opening, closing]);
  const closedAt = Date.now();
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[0].reason.code, 'runner_execution_closed');
  assert.equal(settled[1].status, 'fulfilled');
  // The open really did reach a write, and close() could not resolve before it.
  assert.ok(open.wroteAt > 0, 'the delayed open must reach its first write');
  assert.ok(closedAt >= open.wroteAt, 'close must not resolve while the open is still writing');
  assert.equal(execution.status().closed, true);
  assert.equal(execution.status().open, false);
  assert.equal(execution.results.status().closed, true);

  // No filesystem write may happen after close returned: the tree is frozen.
  const frozen = await recursiveListing(executionRoot);
  await sleep(300);
  assert.deepEqual(await recursiveListing(executionRoot), frozen);
  // The stalled open stopped exactly where close caught it: only the manager
  // cache root exists, with no pool journal, no lease slot and no results store.
  assert.deepEqual(frozen, ['manager-cache:dir']);
  assert.deepEqual(await fs.readdir(project), []);
});

test('close awaits a slow source import instead of failing the pool drain', { timeout: TEST_TIMEOUT }, async t => {
  const rejections = [];
  const onUnhandled = reason => rejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  // A pool close timeout far shorter than the import: the previous ordering
  // awaited the pool drain while the import was still running, so the drain
  // rejection fired with nothing to handle it.
  const { execution, view } = await makeExecution(t, { capacity: 1, closeTimeoutMs: 150 });
  const originalEdit = view.port.edit.bind(view.port);
  let importStarted;
  const started = new Promise(resolve => {
    importStarted = resolve;
  });
  view.port.edit = async (...args) => {
    importStarted();
    await sleep(900);
    return originalEdit(...args);
  };

  const pending = execution.execute(binding, identity, view.port,
    { command: command('tools/format.cjs') }, new AbortController().signal);
  await started;
  const closing = execution.close();
  const result = await pending;
  await closing;
  await sleep(100);

  // The command still published its one private revision and closed cleanly.
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.import, 'imported');
  assert.equal(result.afterVersion.revision, 4);
  assert.equal(view.port.revision(), 4);
  assert.equal(execution.status().closed, true);
  assert.equal(execution.pool.status().slots[0].state, 'free');
  assert.deepEqual(rejections, []);
});

test('repeated executions do not leak abort listeners on a shared caller signal', { timeout: TEST_TIMEOUT }, async t => {
  const { getEventListeners } = require('node:events');
  const warnings = [];
  const onWarning = warning => {
    if (warning.name === 'MaxListenersExceededWarning') {
      warnings.push(warning);
    }
  };
  process.on('warning', onWarning);
  t.after(() => process.removeListener('warning', onWarning));

  const { execution } = await makeExecution(t, {
    capacity: 2,
    processRunner: async input => {
      // A cheap, injected process result: this test is about listener growth,
      // not containment.
      input.authorize();
      const processIdentity = {
        platform: process.platform,
        pid: 4242,
        startMarker: 'marker',
        supervisor: { kind: WINDOWS ? 'windows-job-object' : 'posix-process-group', name: '4242' }
      };
      await input.onStarted?.(processIdentity);
      return {
        identity: processIdentity,
        exitCode: 0,
        signal: null,
        output: '',
        truncated: false,
        timedOut: false,
        cancelled: false,
        drained: true
      };
    }
  });
  const { port } = await fixtureView(execution.logicalRoot);
  const shared = new AbortController();
  for (let index = 0; index < 40; index += 1) {
    const result = await execution.execute(binding, identity, port, { command: 'noop' }, shared.signal);
    assert.equal(result.outcome, 'succeeded', `iteration ${index}: ${String(result.diagnostic)}`);
  }
  assert.equal(getEventListeners(shared.signal, 'abort').length, 0, 'no listener may survive a settled command');
  assert.deepEqual(warnings, [], 'a shared signal must not trip MaxListenersExceededWarning');
  // The shared signal still works for a later command.
  shared.abort();
  assert.throws(() => execution.execute(binding, identity, port, { command: 'noop' }, shared.signal),
    { code: 'runner_execution_cancelled' });
});

test('every case variant of a managed environment name is replaced, other variables survive', { timeout: TEST_TIMEOUT }, async t => {
  const live = {
    npm_config_cache: '/live/npm',
    pip_cache_dir: '/live/pip',
    tmp: '/live/tmp',
    Temp: '/live/temp',
    TmpDir: '/live/tmpdir',
    NPM_CONFIG_CACHE: '/live/npm-upper',
    CODEX_KEEP: 'kept',
    CODEX_CUSTOM: 'custom',
    PATH: process.env.PATH ?? process.env.Path ?? ''
  };
  const { executionRoot, execution, view } = await makeExecution(t, { environment: () => ({ ...live }) });
  const result = await execution.execute(binding, identity, view.port,
    { command: command('tools/env.cjs') }, new AbortController().signal);

  assert.equal(result.outcome, 'succeeded');
  const report = JSON.parse(result.output);
  // Exactly the five canonical names exist, each with the lease value; no
  // inherited case variant survives to redirect temp or a download cache.
  assert.deepEqual(report.managed.map(([key]) => key.toUpperCase()).sort(),
    ['NPM_CONFIG_CACHE', 'PIP_CACHE_DIR', 'TEMP', 'TMP', 'TMPDIR']);
  assert.equal(report.managed.length, 5);
  for (const [name, value] of report.managed) {
    assert.equal(value.startsWith('/live'), false, `${name} must not keep an inherited value`);
  }
  const env = Object.fromEntries(report.managed);
  assert.equal(env.TMP, env.TEMP);
  assert.equal(env.TMP, env.TMPDIR);
  assert.equal(path.relative(execution.logicalRoot, env.TMP).startsWith('..'), true);
  assert.equal(env.NPM_CONFIG_CACHE, path.join(executionRoot, 'manager-cache', 'npm'));
  assert.equal(env.PIP_CACHE_DIR, path.join(executionRoot, 'manager-cache', 'pip'));
  // Unrelated variables are preserved exactly.
  assert.equal(report.keep, 'kept');
  assert.equal(report.custom, 'custom');
  assert.equal(report.path, live.PATH);
  // The recorded hash covers the actual environment, never a raw value dump.
  assert.match(result.attempt.setup.environmentHash, /^[a-f0-9]{64}$/);
});

test('a linked store path resolving into the project is refused before any write', { timeout: TEST_TIMEOUT }, async t => {
  const root = await tempRoot(t);
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'main.txt'), 'live content');
  const alias = path.join(root, 'alias');
  try {
    await fs.symlink(project, alias, WINDOWS ? 'junction' : 'dir');
  } catch {
    // A platform that cannot create the link cannot express this alias.
    return;
  }
  const execution = new RunnerExecution(path.join(alias, 'store', 'execution'), project,
    { approveCommand: async () => true });
  await assert.rejects(execution.open(), { code: 'invalid_path' });
  // The canonical check runs BEFORE the directory create, so the main project
  // was never written through the alias.
  assert.deepEqual(await fs.readdir(project), ['main.txt']);
  assert.equal(await fs.readFile(path.join(project, 'main.txt'), 'utf8'), 'live content');
});

test('a failed final persistence quarantines the run and reloads it as uncertain without replay', { timeout: TEST_TIMEOUT }, async t => {
  const { runRunnerProcess } = require(path.join(buildDir, 'runner-process'));
  const counters = { commands: 0 };
  const { project, executionRoot, execution, view } = await makeExecution(t, {
    capacity: 1,
    processRunner: async input => {
      counters.commands += 1;
      return runRunnerProcess(input);
    }
  });

  // The command and its import succeed; only the final record write fails.
  const finish = execution.results.finish;
  execution.results.finish = async () => {
    throw new WorkerError('runner_results_storage', 'the results disk is full');
  };
  await assert.rejects(execution.execute(binding, identity, view.port,
    { command: command('tools/format.cjs') }, new AbortController().signal),
  { code: 'runner_results_storage' });

  // The private revision really advanced, but no result claims it.
  assert.equal(view.port.revision(), 4);
  assert.equal(counters.commands, 1);
  assert.equal(execution.results.status().results, 0);
  assert.equal(execution.results.status().pending, 1);
  const quarantined = execution.pool.status().leases.find(entry => entry.state === 'quarantined');
  assert.ok(quarantined, 'the runner directory must be quarantined, not discarded');
  assert.equal(quarantined.preserve, true);
  assert.match(quarantined.diagnostic, /could not be persisted/);
  assert.equal(await exists(quarantined.directory), true);

  // A reload recovers the pending attempt as uncertain: no replay, no fake
  // after-version, and the preserved directory is never auto-discarded.
  execution.results.finish = finish;
  await execution.close();
  const reloaded = new RunnerExecution(executionRoot, project, {
    approveCommand: async () => {
      throw new Error('a reloaded handle must never approve a command');
    }
  });
  t.after(() => reloaded.close().catch(() => undefined));
  await reloaded.open();

  assert.equal(reloaded.results.status().results, 1);
  assert.equal(reloaded.results.status().pending, 0);
  const page = reloaded.results.list(scope);
  assert.equal(page.total, 1);
  const recovered = page.results[0];
  assert.equal(recovered.id, quarantined.leaseId);
  assert.equal(recovered.outcome, 'uncertain');
  assert.equal(recovered.import, 'uncertain');
  assert.equal(recovered.afterVersion, null);
  assert.equal(recovered.drained, false);
  assert.equal(recovered.attempt.inputVersion.revision, 3);
  assert.match(recovered.diagnostic, /not replayed/);
  assert.equal(counters.commands, 1, 'the command must never be replayed');
  const retained = reloaded.pool.status().leases.find(entry => entry.leaseId === quarantined.leaseId);
  assert.equal(retained.state, 'quarantined');
  assert.equal(retained.preserve, true);
  assert.equal(await exists(quarantined.directory), true);
});

// ---------------------------------------------------------------------------
// Retained failed-release regressions (storage error recovery).
//
// A release is published through the pool journal. When that write fails after
// the final result is already durable, the lease must NOT be dropped: it stays
// owned by this handle (live record, slot consumed) until cleanup() or close()
// can settle it once storage is healthy again. Every case below injects the
// journal failure through the pool's writeJournal seam and DENIES approval, so
// no child process is ever created and no signal can be sent.
// ---------------------------------------------------------------------------

/**
 * Race `promise` against a deadline so a wedged lifecycle can never hang the suite.
 *
 * These deadlines are FAIL-FAST GUARDS, not expected durations: on the fixed code
 * each guarded call settles in milliseconds, while the pre-fix behaviour it rules
 * out (an orphan live lease whose release can never be published) never settles at
 * all. The fixtures also use a 100 ms pool close timeout, so the recovery path has
 * to settle the retained release BEFORE the drain — it cannot pass merely because
 * a long drain window happens to absorb a late publish.
 */
function bounded(promise, milliseconds, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`unbounded wait: ${label}`)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Fail EVERY pool journal write while armed. The reservation publishes must
 * still succeed, so the fault is armed at the exact moment the final result
 * became durable; it keeps failing until heal(), which is what a store that is
 * still unhealthy does.
 */
function journalFault(pool) {
  const original = pool.writeJournal;
  const state = {
    armed: false,
    injected: 0,
    arm() { state.armed = true; },
    /** Restore the real writer: storage is healthy again from here on. */
    heal() { pool.writeJournal = original; }
  };
  pool.writeJournal = async (file, text) => {
    if (state.armed) {
      state.injected += 1;
      throw new Error('injected journal write failure');
    }
    return original(file, text);
  };
  return state;
}

const readJournal = async execution => JSON.parse(await fs.readFile(execution.pool.journalFile, 'utf8'));

test('a release that cannot be published is retained and cleanup settles it once storage recovers', { timeout: TEST_TIMEOUT }, async t => {
  // A 100 ms pool close timeout keeps every drain gate in this fixture tight: the
  // recovery path must settle the retained release BEFORE the drain, so a wedged
  // close can never be mistaken for ordinary slowness.
  const { execution, view } = await makeExecution(t, {
    capacity: 1, maxQueue: 2, closeTimeoutMs: 100, approveCommand: async () => false
  });
  const fault = journalFault(execution.pool);
  const finish = execution.results.finish.bind(execution.results);
  execution.results.finish = async (...args) => {
    const record = await finish(...args);
    fault.arm();
    return record;
  };

  const failure = await bounded(execution.execute(binding, identity, view.port,
    { command: command('tools/format.cjs') }, new AbortController().signal).then(() => null, error => error),
  30_000, 'execute');
  assert.ok(failure, 'a release that cannot be published must reject the command');
  assert.equal(failure.code, 'pool_storage');
  assert.equal(fault.injected, 2, 'the release and its compensating release both failed');

  // The final result is durable and the lease is still OWNED, never an orphan.
  assert.equal(execution.results.status().results, 1);
  assert.equal(execution.results.status().pending, 0);
  const owned = execution.pool.status().leases.find(entry => entry.state === 'leased');
  assert.ok(owned, 'the unreleased lease must stay in the pool so it can still be settled');
  assert.equal(execution.pool.status().slots[0].state, 'active');
  assert.equal((await readJournal(execution)).leases[owned.leaseId].state, 'leased');
  assert.equal(execution.results.get(owned.leaseId, scope).outcome, 'denied');

  // A second command cannot silently reuse the retained slot: it waits in the
  // bounded queue and leaves only when it is cancelled.
  const queued = new AbortController();
  const cancelled = bounded(execution.execute(binding, identity, view.port,
    { command: 'noop-queued' }, queued.signal).then(() => null, error => error), 20_000, 'second-queued');
  await until(() => execution.pool.status().queue.length === 1);
  assert.equal(execution.pool.status().queue[0].position, 1);
  queued.abort();
  assert.equal((await cancelled).code, 'pool_aborted');

  // While the write still fails, cleanup reports the storage error and frees
  // nothing: no slot, no record, no directory is reported as cleaned up.
  const blocked = await bounded(execution.cleanup(scope).then(() => null, error => error), 20_000, 'cleanup-blocked');
  assert.ok(blocked, 'cleanup must not report success while the release is unpublished');
  assert.equal(blocked.code, 'pool_storage');
  assert.equal(execution.pool.status().slots[0].state, 'active');
  assert.equal(execution.pool.status().leases.length, 1);

  // Storage recovers: the SAME handle settles the retained release.
  fault.heal();
  const cleaned = await bounded(execution.cleanup(scope), 20_000, 'cleanup-recovered');
  assert.deepEqual([...cleaned.discarded], [owned.leaseId]);
  assert.deepEqual([...cleaned.retained], []);
  assert.equal(execution.pool.status().slots[0].state, 'free');
  assert.deepEqual([...execution.pool.status().leases], []);
  assert.equal(execution.pool.status().queue.length, 0);
  // The immutable result survives the recovery untouched.
  assert.equal(execution.results.get(owned.leaseId, scope).outcome, 'denied');

  // Retrying is idempotent: nothing is settled twice or reported twice.
  const again = await bounded(execution.cleanup(scope), 20_000, 'cleanup-idempotent');
  assert.deepEqual([...again.discarded], []);
  assert.deepEqual([...again.retained], []);

  // The recovered slot is really usable again: no capacity is stranded.
  const second = await bounded(execution.execute(binding, identity, view.port,
    { command: 'noop-again' }, new AbortController().signal), 30_000, 'second');
  assert.equal(second.outcome, 'denied');
  assert.equal(execution.results.status().results, 2);
  assert.equal(execution.pool.status().slots[0].state, 'free');
  assert.equal(execution.pool.status().queue.length, 0);
});

test('close reports a failed release and succeeds on a retry once storage recovers', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t, {
    capacity: 1, maxQueue: 2, closeTimeoutMs: 100, approveCommand: async () => false
  });
  const fault = journalFault(execution.pool);
  const finish = execution.results.finish.bind(execution.results);
  execution.results.finish = async (...args) => {
    const record = await finish(...args);
    fault.arm();
    return record;
  };

  const failure = await bounded(execution.execute(binding, identity, view.port,
    { command: 'noop-close' }, new AbortController().signal).then(() => null, error => error),
  20_000, 'execute');
  assert.equal(failure.code, 'pool_storage');

  // A close while the release is still unpublished fails with the STORAGE error
  // (not a drain timeout) and leaves the results store — and the owner lock —
  // open, so the caller may retry instead of being wedged forever. The fixture's
  // pool close timeout is 100 ms: reaching it at all would be a harness failure,
  // so this assertion no longer depends on a slow-always-safe wall-clock margin.
  const started = Date.now();
  const blocked = await bounded(execution.close().then(() => null, error => error), 15_000, 'close-blocked');
  assert.ok(blocked, 'close must fail while a retained release cannot be published');
  assert.equal(blocked.code, 'pool_storage');
  assert.ok(Date.now() - started < 5_000, 'close must not sit on the pool drain timeout');
  assert.equal(execution.status().closing, true);
  assert.equal(execution.status().closed, false);
  assert.equal(execution.results.status().closed, false);
  assert.equal(execution.pool.status().closed, false);
  assert.equal(execution.pool.status().slots[0].state, 'active');

  // Once storage is healthy the SAME handle closes: the retained release settles
  // and the pool drains, so no live lease is stranded. Concurrent close() calls
  // share one attempt instead of settling anything twice.
  fault.heal();
  await bounded(Promise.all([execution.close(), execution.close()]), 15_000, 'close-recovered');
  assert.equal(execution.status().closed, true);
  assert.equal(execution.status().open, false);
  assert.equal(execution.pool.status().closed, true);
  assert.equal(execution.results.status().closed, true);
  assert.equal(execution.pool.status().slots[0].state, 'free');
  assert.deepEqual(execution.pool.status().leases.map(entry => entry.state), ['released']);
  await bounded(execution.close(), 10_000, 'close-idempotent');
});

test('a failed final result whose quarantine release also fails is retained and preserved exactly', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t, {
    capacity: 1, maxQueue: 2, closeTimeoutMs: 150, approveCommand: async () => false
  });
  const fault = journalFault(execution.pool);
  execution.results.finish = async () => {
    fault.arm();
    throw new WorkerError('runner_results_storage', 'the results disk is full');
  };

  const failure = await bounded(execution.execute(binding, identity, view.port,
    { command: 'noop-pending' }, new AbortController().signal).then(() => null, error => error),
  30_000, 'execute');
  assert.equal(failure.code, 'runner_results_storage', 'the original failure must not be masked');
  assert.equal(fault.injected, 2);

  // The attempt is still pending and its reservation is still owned.
  assert.equal(execution.results.status().results, 0);
  assert.equal(execution.results.status().pending, 1);
  const owned = execution.pool.status().leases.find(entry => entry.state === 'leased');
  assert.ok(owned, 'the unsettled lease must stay owned');

  // Storage recovers: the retry keeps the ORIGINAL safety intent. The release is
  // published as a preserved quarantine and cleanup still refuses to discard it
  // (no drain proof), so the uncertain directory survives untouched.
  fault.heal();
  const cleaned = await bounded(execution.cleanup(scope), 20_000, 'cleanup-recovered');
  assert.deepEqual([...cleaned.discarded], []);
  assert.deepEqual(cleaned.retained.map(entry => entry.leaseId), [owned.leaseId]);
  const quarantined = execution.pool.status().leases.find(entry => entry.leaseId === owned.leaseId);
  assert.equal(quarantined.state, 'quarantined');
  assert.equal(quarantined.preserve, true, 'a failed final result must keep its directory');
  assert.match(quarantined.diagnostic, /could not be persisted/);
  assert.equal(await exists(quarantined.directory), true);
  assert.equal(execution.pool.status().slots[0].state, 'quarantined');
  assert.equal(execution.results.status().pending, 1);

  // A settled quarantine no longer blocks close, and the retained data survives.
  await bounded(execution.close(), 15_000, 'close');
  assert.equal(execution.status().closed, true);
  assert.equal(execution.results.status().closed, true);
  assert.equal(await exists(quarantined.directory), true);
  assert.equal(execution.results.status().pending, 1);
});

test('scoped cleanup validates the scope before retrying, and never settles another owner', { timeout: TEST_TIMEOUT }, async t => {
  const { execution, view } = await makeExecution(t, {
    capacity: 1, maxQueue: 2, closeTimeoutMs: 100, approveCommand: async () => false
  });
  const fault = journalFault(execution.pool);
  const finish = execution.results.finish.bind(execution.results);
  execution.results.finish = async (...args) => {
    const record = await finish(...args);
    fault.arm();
    return record;
  };

  // Approval is denied, so no process is ever created; only the release write fails.
  const failure = await bounded(execution.execute(binding, identity, view.port,
    { command: 'noop-scope' }, new AbortController().signal).then(() => null, error => error),
  20_000, 'execute');
  assert.equal(failure.code, 'pool_storage');
  assert.equal(fault.injected, 2);
  const owned = execution.pool.status().leases.find(entry => entry.state === 'leased');
  assert.ok(owned, 'the unsettled lease must stay owned');
  // The write counter is the probe: every retry attempt increments it, so an
  // unchanged count proves a rejection never reached the journal writer.
  const attemptsAfterFailure = fault.injected;

  // A malformed scope is refused by the pool's own validator BEFORE any release
  // side effect: no write attempt, no lease change, same error code as cleanup().
  const malformed = [
    { ownerId: identity.ownerId },
    { ownerId: '', teamId: TEAM },
    { ownerId: identity.ownerId, teamId: 'not-hex' },
    { ownerId: identity.ownerId, teamId: TEAM, extra: 1 }
  ];
  for (const candidate of malformed) {
    const rejected = await bounded(execution.cleanup(candidate).then(() => null, error => error),
      10_000, 'cleanup-malformed');
    assert.ok(rejected, `${JSON.stringify(candidate)} must be refused`);
    assert.equal(rejected.code, 'invalid_pool_scope');
  }
  assert.equal(fault.injected, attemptsAfterFailure, 'a malformed scope must never attempt a release write');
  assert.equal(execution.pool.status().leases[0].state, 'leased');

  // Another owner's and another team's cleanup are ordinary scoped no-ops: they
  // neither retry this lease nor surface its storage error, and they report
  // nothing about it.
  const foreign = [
    { ownerId: 'owner-someone-else', teamId: TEAM },
    { ownerId: identity.ownerId, teamId: 'e'.repeat(32) }
  ];
  for (const candidate of foreign) {
    const result = await bounded(execution.cleanup(candidate), 10_000, 'cleanup-foreign');
    assert.deepEqual([...result.discarded], []);
    assert.deepEqual([...result.retained], []);
  }
  assert.equal(fault.injected, attemptsAfterFailure, 'a foreign scope must never attempt a release write');
  assert.equal(execution.pool.status().leases[0].state, 'leased');
  assert.equal(execution.pool.status().slots[0].state, 'active');

  // The owning scope DOES retry while storage is still failing: exactly one extra
  // attempt, the real storage error, and the lease stays retained and owned.
  const blocked = await bounded(execution.cleanup(scope).then(() => null, error => error), 10_000, 'cleanup-owning-blocked');
  assert.ok(blocked, 'the owning scope must report the unpublished release');
  assert.equal(blocked.code, 'pool_storage');
  assert.equal(fault.injected, attemptsAfterFailure + 1, 'the owning scope retries exactly once per call');
  assert.equal(execution.pool.status().leases[0].state, 'leased');

  // Storage recovers: the same owning scope settles the very same lease.
  fault.heal();
  const cleaned = await bounded(execution.cleanup(scope), 10_000, 'cleanup-owning-recovered');
  assert.deepEqual([...cleaned.discarded], [owned.leaseId]);
  assert.deepEqual([...cleaned.retained], []);
  assert.equal(execution.pool.status().slots[0].state, 'free');
  assert.deepEqual([...execution.pool.status().leases], []);
  assert.equal(execution.results.get(owned.leaseId, scope).outcome, 'denied');
});
