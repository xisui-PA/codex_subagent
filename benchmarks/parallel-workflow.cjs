#!/usr/bin/env node
'use strict';

/**
 * Reproducible, representative parallel-workflow benchmark for this extension.
 *
 * The benchmark drives the PRODUCTION runtime end to end: a real WorkerBroker,
 * the durable task board, private isolated views (snapshot, per-worker overlays
 * and sealed submissions), the physical runner pool and immutable result store,
 * the resource governor and one coordinator integration attempt (begin,
 * candidate, validate, accept and, unless --skip-apply, apply). Only the model
 * is scripted: an in-memory provider returns the next queued tool call, so no
 * inference, account, API key or network access is involved.
 *
 * Each runner lease materializes the worker's exact private revision into a
 * fresh physical directory and runs a generated Node driver there. That driver
 * REALLY installs a local package archive with npm and rebuilds the many-file
 * project on every lease.
 *
 * The installed dependency is a real local `.tgz`: the fixture's
 * `local-fixture/` folder is packed ONCE with `npm pack --offline
 * --ignore-scripts` during fixture generation, the archive is written INSIDE
 * the fixture, and `package.json` depends on `file:./<archive>.tgz`. A folder
 * `file:` specifier is not used, because observed npm behaviour (12.2.2 on
 * Windows) installs a folder dependency as a `node_modules` junction even with
 * `--install-links` and a lockfile, so a symlink-free census would report zero
 * installed bytes for an install that never really copied anything. A tarball
 * install always yields a plain copied directory with real bytes.
 *
 * Packing is FIXTURE PREPARATION, not a reused installation: its cost is
 * reported separately (`project.packMs`, `project.dependency.sourceArchive`)
 * and no lease benefits from it. Every lease still installs afresh, and only
 * the manager download caches the runtime shares (NPM_CONFIG_CACHE) are reused;
 * a local archive downloads nothing at all. `--ignore-scripts` keeps ambient
 * lifecycle scripts out of both the pack and the install.
 *
 * Usage:
 *   npm run build:test
 *   node benchmarks/parallel-workflow.cjs > .artifacts/step7-benchmark.json
 *
 * Options are listed by --help. The emitted JSON is the benchmark result. It
 * contains no invented numbers: every metric is measured, or null with a reason
 * in `unavailable`.
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SCHEMA = 1;
const BENCHMARK = 'parallel-workflow';
const OWNER_ID = 'bench-owner';
const MODEL = {
  id: 'bench/scripted-model',
  name: 'Scripted fixture model',
  vendor: 'bench',
  family: 'scripted',
  version: '1',
  maxInputTokens: 100000
};
/**
 * Local, offline dependency, installed from a real package ARCHIVE inside the
 * fixture.
 *
 * The fixture's `local-fixture/` folder is packed ONCE with `npm pack` during
 * fixture generation, and every lease then installs that `.tgz` afresh. A
 * folder `file:` specifier is deliberately NOT used: observed npm behaviour
 * (12.2.2 on Windows) materializes a folder dependency as a `node_modules`
 * junction even with `--install-links` (and with a lockfile), so the install is
 * neither a copied tree nor measurable by a symlink-free census. A tarball
 * install always produces a plain copied directory on Windows and POSIX.
 *
 * The archive lives INSIDE the fixture, so it is captured by the snapshot and
 * materialized for every lease: isolation stays intact and no `../` path is
 * ever used.
 */
const DEPENDENCY_NAME = 'bench-local-fixture';
const DEPENDENCY_VERSION = '1.0.0';
/** Deterministic `npm pack` output name for the fixture's source folder. */
const DEPENDENCY_ARCHIVE_FILE = DEPENDENCY_NAME + '-' + DEPENDENCY_VERSION + '.tgz';
const DEPENDENCY_SOURCE_NAME = 'local-fixture';
const DEPENDENCY_SOURCE_ARGUMENT = './' + DEPENDENCY_SOURCE_NAME;
const DEPENDENCY_SPEC = 'file:./' + DEPENDENCY_ARCHIVE_FILE;
/** `npm pack` fixture preparation: offline, no lifecycle scripts, no registry. */
const PACK_FLAGS = ['--offline', '--ignore-scripts', '--loglevel=error'];
/** The same flags are used by every producer lease and the validation lease. */
const INSTALL_FLAGS = ['--no-audit', '--no-fund', '--no-package-lock', '--offline', '--ignore-scripts', '--loglevel=error'];
const INSTALL_COMMAND = 'node tools/install-and-build.cjs';
const VERIFY_COMMAND = 'node tools/verify.cjs';
/** Directory names the production private view treats as ephemeral output. */
const EPHEMERAL_NAMES = ['node_modules', 'build'];
const GROUPS = ['core', 'features', 'lib', 'util', 'runtime'];
const LIMITS = {
  files: { min: 10, max: 2000, fallback: 120 },
  fileBytes: { min: 64, max: 65536, fallback: 900 },
  workers: { min: 1, max: 8, fallback: 4 },
  capacity: { min: 1, max: 8, fallback: 2 },
  maxQueue: { min: 0, max: 256, fallback: 32 },
  timeoutMs: { min: 1000, max: 120000, fallback: 120000 },
  waitBudgetMs: { min: 30000, max: 1800000, fallback: 600000 },
  seed: { min: 1, max: 1000000, fallback: 1 }
};
/**
 * Real per-model session ceiling enforced by the settings schema
 * (`numSessions: z.number().int().min(1).max(8)` in src/model-settings.ts).
 * The benchmark reserves sessions for its workers within this ceiling; it never
 * raises it.
 */
const MODEL_SESSION_MAX = 8;
/**
 * Sessions this run reserves on the single fixture model for `workers`
 * producers plus their follow-up turns. It is one shared value used by the
 * engine settings and by the report, and it is CLAMPED to MODEL_SESSION_MAX, so
 * --workers 8 still requests 8 and never an out-of-schema 10.
 */
const sessionReservation = workers => Math.min(MODEL_SESSION_MAX, Math.max(4, workers + 2));
/** Applied to every scripted run_command; set from --timeout by the CLI. */
let commandTimeoutMs = LIMITS.timeoutMs.fallback;
/** Documented meaning of every derived (not directly observed) number. */
const DEFINITIONS = {
  snapshotCreateMs: 'wall time of one subagent_snapshot_create call',
  snapshotManifestJsonBytes: 'size of the immutable snapshot manifest JSON blob addressed by the returned manifestHash',
  viewIndexJsonBytes: 'size of <store>/isolated-views/index.json, the durable JSON index of snapshots, overlays and submissions',
  overlayGrowthBytes: 'bytes added under <store>/isolated-views while ONE worker edit applied; edit turns are driven one at a time, so the census delta is attributable to that worker',
  requestedAt: 'benchmark timestamp taken immediately before the run_command turn was queued on that worker',
  leaseCreatedAt: 'createdAt of the durable runner lease row read from subagent_runner_status',
  leaseWaitMs: 'derived upper bound, NOT pure queue wait: lease createdAt - requestedAt. It includes the scripted-model turn that had to run before the command could be queued, so it over-reports queueing rather than inventing it',
  attemptStartedAt: 'attempt.startedAt recorded by the durable runner result immediately before view materialization',
  setupToDriverMs: 'derived COMBINED lease setup wall time, not pure isolated-view materialization: driver process start - attempt.startedAt, which covers private view materialization plus the command-approval round trip plus process spawn',
  installMs: 'measured inside the lease by the generated driver around the real npm install of the in-fixture package archive, with --offline --ignore-scripts',
  dependencyInstalledBytes: 'bytes of the real copied dependency tree at node_modules/<name> after installing the archive; 0 bytes or a symlink means the dependency was not genuinely installed in that lease',
  packMs: 'FIXTURE PREPARATION, not a per-lease cost: wall time of the single npm pack --offline --ignore-scripts that turns the fixture dependency source folder into the in-fixture archive. It is excluded from endToEnd and no lease reuses it',
  sourceArchiveSha256: 'SHA-256 of the packed dependency archive captured by the snapshot and materialized for every lease',
  buildMs: 'measured inside the lease by the generated driver around the fresh bundle build',
  postProcessMs: 'derived: result completedAt - driver finish timestamp (import decision, durable result write, lease release)',
  runnerRoundMs: 'wall time from queueing the first parallel run_command turn to observing the last result',
  speedup: 'sequential baseline wall time / parallel wall time for the same unit count; both sides include edits, seals, installs and builds',
  effectiveConcurrentWorkRunners: 'CONFIGURED CEILING, not an observation: min(pool capacity - (pool capacity > 1 ? 1 : 0), governor runnerCapacity - serviceReserve). Actual observed concurrency can be lower because edits and seals run serially and work waits in the queue; --workers does not raise the ceiling'
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage: node benchmarks/parallel-workflow.cjs [options]',
    '',
    '  --files <n>         generated project source files (default 120)',
    '  --file-bytes <n>    approximate bytes per generated source file (default 900)',
    '  --workers <n>       parallel units / producer workers, 1-8 (default 4)',
    '  --capacity <n>      runner pool slot count, 1-8 (default 2, production bound)',
    '  --max-queue <n>     runner pool queue bound, 0-256 (default 32)',
    '  --baseline <mode>   sequential | none (default sequential)',
    '  --timeout <ms>      per-command runner timeout (default 120000)',
    '  --wait-budget <ms>  benchmark-side wait cap per round (default 600000)',
    '  --npm <command>     npm executable used inside each lease (default npm)',
    '  --seed <n>          deterministic content seed (default 1)',
    '  --skip-apply        stop after integration accept (no live publication)',
    '  --keep              keep the temporary fixture directory as evidence',
    '  --json-out <file>   also write the JSON result to this file',
    '  --help              show this text',
    '',
    'The JSON result is written to stdout; progress and diagnostics go to stderr.'
  ].join('\n');
}

function parseArguments(argv) {
  const options = {
    files: LIMITS.files.fallback,
    fileBytes: LIMITS.fileBytes.fallback,
    workers: LIMITS.workers.fallback,
    capacity: LIMITS.capacity.fallback,
    maxQueue: LIMITS.maxQueue.fallback,
    baseline: 'sequential',
    timeoutMs: LIMITS.timeoutMs.fallback,
    waitBudgetMs: LIMITS.waitBudgetMs.fallback,
    npm: 'npm',
    seed: LIMITS.seed.fallback,
    skipApply: false,
    keep: false,
    jsonOut: null,
    help: false,
    argv: argv.slice()
  };
  const numeric = {
    '--files': ['files', LIMITS.files],
    '--file-bytes': ['fileBytes', LIMITS.fileBytes],
    '--workers': ['workers', LIMITS.workers],
    '--capacity': ['capacity', LIMITS.capacity],
    '--max-queue': ['maxQueue', LIMITS.maxQueue],
    '--timeout': ['timeoutMs', LIMITS.timeoutMs],
    '--wait-budget': ['waitBudgetMs', LIMITS.waitBudgetMs],
    '--seed': ['seed', LIMITS.seed]
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? null : argument.slice(equals + 1);
    const value = () => {
      const chosen = inline === null ? argv[index + 1] : inline;
      if (inline === null) {
        index += 1;
      }
      if (chosen === undefined) {
        throw new Error('Missing value for ' + name + '.');
      }
      return chosen;
    };
    if (name === '--help' || name === '-h') {
      options.help = true;
      continue;
    }
    if (name === '--keep') {
      options.keep = true;
      continue;
    }
    if (name === '--skip-apply') {
      options.skipApply = true;
      continue;
    }
    if (name === '--npm') {
      options.npm = value();
      continue;
    }
    if (name === '--json-out') {
      options.jsonOut = path.resolve(value());
      continue;
    }
    if (name === '--baseline') {
      const mode = value();
      if (mode !== 'sequential' && mode !== 'none') {
        throw new Error('--baseline must be "sequential" or "none".');
      }
      options.baseline = mode;
      continue;
    }
    const entry = numeric[name];
    if (entry === undefined) {
      throw new Error('Unknown option ' + name + '. Use --help.');
    }
    const parsed = Number(value());
    if (!Number.isInteger(parsed) || parsed < entry[1].min || parsed > entry[1].max) {
      throw new Error(name + ' must be an integer between ' + entry[1].min + ' and ' + entry[1].max + '.');
    }
    options[entry[0]] = parsed;
  }
  if (options.workers > options.capacity && options.maxQueue === 0) {
    throw new Error('--max-queue 0 cannot admit ' + options.workers + ' workers onto ' + options.capacity + ' slots.');
  }
  commandTimeoutMs = options.timeoutMs;
  return options;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const round = (value, digits) => {
  const factor = 10 ** (digits === undefined ? 3 : digits);
  return Number.isFinite(value) ? Math.round(value * factor) / factor : null;
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
const pad = (value, width) => String(value).padStart(width, '0');
const messageOf = error => (error instanceof Error ? error.message : String(error));
const tail = (text, limit) => {
  const value = typeof text === 'string' ? text : '';
  return value.length <= limit ? value : value.slice(value.length - limit);
};

/**
 * ONE token of a cmd.exe command line.
 *
 * Windows runs `npm` through its `.cmd` shim, so its command interpreter is
 * required - and that interpreter parses a LINE before the target program's own
 * C runtime parses it again. A token is therefore quoted when it is EMPTY or
 * carries whitespace or a cmd.exe metacharacter, and the quoting follows the
 * documented C-runtime rules on top of that:
 *
 * - an empty argument becomes `""`, because an empty string would otherwise
 *   contribute no token at all and be dropped;
 * - a backslash run is doubled when it precedes an embedded quote and when it
 *   ends the token, so the closing quote is not escaped into a literal quote
 *   (`a b\` stays `a b\`, never `a b"`);
 * - an embedded quote is written as `\"` with its backslash run doubled.
 *
 * A token that needs none of this stays byte-identical to the value the caller
 * passed, which keeps every existing npm argument unchanged. `cmd.exe` still
 * performs its own expansion (`%NAME%`) and treats the quotes as its own
 * grouping characters; that shell behaviour is unchanged and not bypassed here.
 */
function windowsShellToken(value) {
  const text = String(value);
  if (text !== '' && !/[\s"&|<>^()]/.test(text)) {
    return text;
  }
  let token = '"';
  let backslashes = 0;
  for (const character of text) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      // 2n+1 backslashes then a quote: n literal backslashes plus a literal quote.
      token += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    token += '\\'.repeat(backslashes) + character;
    backslashes = 0;
  }
  // A trailing backslash run is doubled so the CLOSING quote stays a delimiter.
  return token + '\\'.repeat(backslashes * 2) + '"';
}

/**
 * The exact OS launch for one executable path plus its argv.
 *
 * POSIX keeps the launch DIRECT (no shell): the executable path is used
 * verbatim and every argument reaches the child with its exact boundary.
 * Windows needs cmd.exe because `npm` is a `.cmd` shim - the default `--npm` is
 * the bare name `npm`, which only the shell resolves through PATHEXT - so the
 * whole command line is assembled here from individually quoted tokens:
 * `C:\Program Files\nodejs\npm.cmd` is ONE token and is never split at its
 * space, no argument is interpolated unquoted, and no argument is dropped or
 * reordered. The returned `file`/`args`/`shell` are what `spawn` and
 * `execFileSync` consume directly; on Windows the command line is already in
 * `file` and `args` is empty, so Node never concatenates an argument array.
 */
function executableLaunch(command, args, platform) {
  const argv = Array.isArray(args) ? args.slice() : [];
  if ((platform || process.platform) !== 'win32') {
    return { file: String(command), args: argv, shell: false };
  }
  return {
    file: [String(command)].concat(argv).map(windowsShellToken).join(' '),
    args: [],
    shell: true
  };
}

/**
 * The launch helpers, embedded VERBATIM in the generated lease library, so the
 * driver and the generated code cannot drift apart at their shell boundary.
 */
const LAUNCH_SOURCE = [windowsShellToken, executableLaunch].map(fn => String(fn)).join('\n\n');

/**
 * The CONFIGURED ceiling on concurrently running WORK commands - never an
 * observed concurrency.
 *
 * `src/resource-governor.ts` enforces two work-lane ceilings and the smaller one
 * wins: the LOCAL ceiling is `poolCapacity - 1` whenever the pool has more than
 * one slot (a single-slot pool keeps its one slot), and the AGGREGATE ceiling is
 * `runnerCapacity - serviceReserve`, because that reserve belongs to the service
 * lanes. Observed concurrency can be lower still: edit and seal turns run
 * serially and further work waits in the bounded queue.
 */
function effectiveWorkRunnerCeiling(poolCapacity, governorConfig) {
  const { runnerCapacity = 4, serviceReserve = 1 } = governorConfig || {};
  const local = poolCapacity - (poolCapacity > 1 ? 1 : 0);
  return Math.max(1, Math.min(local, runnerCapacity - serviceReserve));
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function removeTree(target) {
  if (!target) {
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

/**
 * Byte/file census of one directory tree.
 *
 * ONLY an absent census ROOT (`ENOENT`) means "no tree yet" and yields zero
 * totals, because callers census directories that a later step still creates
 * (the private view store before the first snapshot, the runner store before
 * the first lease). Every other read failure - including a permission error on
 * the root itself - and every failure BELOW the root, including `stat` of a
 * listed file or a directory that disappears mid-walk, propagates. A partial
 * walk must fail the benchmark truthfully instead of reporting a smaller or
 * zero total as a measurement.
 */
async function census(directory) {
  if (!directory) {
    return null;
  }
  const totals = { bytes: 0, files: 0, directories: 0 };
  const stack = [''];
  while (stack.length > 0) {
    const relative = stack.pop();
    const absolute = relative === '' ? directory : path.join(directory, relative);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (relative === '' && error && error.code === 'ENOENT') {
        return totals;
      }
      throw error;
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : path.join(relative, entry.name);
      if (entry.isDirectory()) {
        totals.directories += 1;
        stack.push(child);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(path.join(directory, child));
      if (stat.isFile()) {
        totals.bytes += stat.size;
        totals.files += 1;
      }
    }
  }
  return totals;
}

const delta = (before, after) => ({
  bytes: before && after ? after.bytes - before.bytes : null,
  files: before && after ? after.files - before.files : null
});

/** Size of one content-addressed JSON blob of the private view store. */
async function contentBlobSize(viewsDirectory, hash) {
  if (!viewsDirectory || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    return null;
  }
  const canonical = path.join(viewsDirectory, 'content', 'blobs', hash.slice(0, 2), hash.slice(2));
  const stat = await fs.stat(canonical).catch(() => null);
  return stat && stat.isFile() ? stat.size : null;
}

/**
 * Resolve the private store directory through the runtime's own workspace
 * catalog, so every storage census reads the directory the broker really uses.
 */
async function resolveStoreDirectory(workspaces, storage, root) {
  const catalog = await Promise.resolve(workspaces.workspaceCatalog(storage)).then(value => (Array.isArray(value) ? value : []), () => []);
  const exact = catalog.find(entry => Array.isArray(entry.roots) && entry.roots.length === 1 && entry.roots[0] === root);
  if (exact && exact.directory) {
    return exact.directory;
  }
  const resolved = await Promise.resolve(workspaces.workspaceDirectory(storage, root)).then(value => value, () => null);
  if (catalog.length === 1 && catalog[0].directory) {
    return catalog[0].directory;
  }
  return resolved;
}

/**
 * The LAST coordinator plain-text turn in one prompt, or null.
 *
 * Routing must never search the whole transcript: a worker's own earlier tool
 * CALL input and tool RESULT text stay in history, so generated code that
 * happens to contain another worker's tag (for example a producer's
 * `[bench #1]` inside a baseline `write_file.content`) would hijack the next
 * turn. Only `text` parts count, `call`/`result` parts are never inspected, and
 * only the most recent coordinator turn is used.
 */
function coordinatorTag(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user' || !Array.isArray(message.parts) || message.parts.length === 0) {
      continue;
    }
    // Only `text` parts are coordinator prose. Tool CALL inputs arrive as a
    // `call` part and tool RESULT text as a `result` part, so both - the two
    // places historical code content actually lives - are excluded here even
    // when they share a message with coordinator text.
    const texts = message.parts
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text);
    if (texts.length > 0) {
      return texts.join('\n');
    }
  }
  return null;
}

/**
 * The ONE registered token the coordinator turn names. The longest match wins so
 * a shorter tag can never shadow a longer one, and two different longest matches
 * are an explicit routing error rather than an arbitrary pick.
 */
function routeToken(tag, tokens) {
  const candidates = [...tokens].filter(token => typeof token === 'string' && token.length > 0 && tag.includes(token));
  if (candidates.length === 0) {
    return { token: null, candidates };
  }
  const longest = candidates.reduce((best, token) => (token.length > best.length ? token : best), candidates[0]);
  return { token: longest, candidates };
}

function parseEmitted(output, prefix) {
  const lines = String(output === null || output === undefined ? '' : output).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.indexOf(prefix + ' ') !== 0) {
      continue;
    }
    try {
      return JSON.parse(line.slice(prefix.length + 1));
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generated project: sources, the offline dependency and the lease drivers
// ---------------------------------------------------------------------------

function filler(options, index, label) {
  const lines = [];
  let bytes = 0;
  let line = 0;
  while (bytes < options.fileBytes) {
    const text = '// ' + label + ' ' + pad(index, 4) + ' line ' + pad(line + 1, 3) + ' deterministic filler ' + 'x'.repeat(24);
    lines.push(text);
    bytes += text.length + 1;
    line += 1;
  }
  return lines;
}

function moduleSource(options, index, group) {
  return [
    "'use strict';",
    '',
    'const config = { index: ' + index + ", group: '" + group + "', seed: " + options.seed + ' };',
    ...filler(options, index, group),
    'function run(input) {',
    '  return { index: config.index, group: config.group, value: Number(input || 0) + config.index + config.seed };',
    '}',
    '',
    'module.exports = { config: config, run: run };',
    ''
  ].join('\n');
}

function indexSource(options) {
  return [
    "'use strict';",
    '',
    'const count = ' + options.files + ';',
    'const modules = [];',
    'for (let index = 1; index <= count; index += 1) {',
    '  modules.push(index);',
    '}',
    '',
    'module.exports = { count: modules.length, seed: ' + options.seed + ' };',
    ''
  ].join('\n');
}

function shardBase(index) {
  return [
    "'use strict';",
    '',
    'module.exports = { unit: ' + index + ", state: 'base', payload: [] };",
    ''
  ].join('\n');
}

function shardContribution(options, index) {
  const token = '[bench #' + index + ']';
  const payload = [];
  for (let line = 1; line <= 8; line += 1) {
    payload.push("'unit " + index + ' line ' + line + ' seed ' + options.seed + "'");
  }
  return [
    "'use strict';",
    '',
    'module.exports = {',
    '  unit: ' + index + ',',
    "  state: 'contributed',",
    "  token: '" + token + "',",
    '  payload: [' + payload.join(', ') + ']',
    '};',
    ''
  ].join('\n');
}

/**
 * Generated shared library for the code that runs INSIDE a lease. It contains
 * no backticks and no template literals so it can be embedded literally.
 */
function benchLibSource() {
  return [
    "'use strict';",
    '',
    '// Generated by benchmarks/parallel-workflow.cjs. Shared by the install/build',
    '// driver and the verification script that run inside a runner lease.',
    '',
    "const fs = require('node:fs/promises');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    "const { spawn } = require('node:child_process');",
    '',
    "const EPHEMERAL = new Set(['node_modules', 'build']);",
    'const OUTPUT_CAP = 200000;',
    'const INSTALL_FLAGS = ' + JSON.stringify(INSTALL_FLAGS) + ';',
    '',
    '// One shell boundary for every npm launch: these two helpers are embedded',
    '// VERBATIM from benchmarks/parallel-workflow.cjs, so the lease code and the',
    '// driver cannot disagree about quoting a Windows executable path with spaces.',
    LAUNCH_SOURCE,
    '',
    'function hashBytes(bytes) {',
    "  return crypto.createHash('sha256').update(bytes).digest('hex');",
    '}',
    '',
    'function isInside(parent, child) {',
    '  const relative = path.relative(path.resolve(parent), path.resolve(child));',
    "  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));",
    '}',
    '',
    'function tail(text, limit) {',
    '  return text.length <= limit ? text : text.slice(text.length - limit);',
    '}',
    '',
    'async function listFiles(root, skipNames) {',
    '  const out = [];',
    '  const stack = [];',
    "  stack.push('');",
    '  while (stack.length > 0) {',
    '    const relative = stack.pop();',
    "    const absolute = relative === '' ? root : path.join(root, relative);",
    '    let entries;',
    '    try {',
    '      entries = await fs.readdir(absolute, { withFileTypes: true });',
    '    } catch (error) {',
    '      // Only an ABSENT root means "nothing here yet": this helper also',
    '      // censuses node_modules and build before a lease creates them. Any',
    '      // other failure - and any failure BELOW the root - propagates, so a',
    '      // materialized/installed/built metric can never omit an unreadable',
    '      // subtree.',
    "      if (relative === '' && error && error.code === 'ENOENT') {",
    '        return out;',
    '      }',
    '      throw error;',
    '    }',
    '    for (const entry of entries) {',
    "      const child = relative === '' ? entry.name : relative + '/' + entry.name;",
    '      if (entry.isSymbolicLink()) {',
    '        continue;',
    '      }',
    '      if (entry.isDirectory()) {',
    '        if (skipNames && skipNames.has(entry.name)) {',
    '          continue;',
    '        }',
    '        stack.push(child);',
    '        continue;',
    '      }',
    '      if (!entry.isFile()) {',
    '        continue;',
    '      }',
    '      const stat = await fs.stat(path.join(root, child));',
    '      out.push({ path: child, bytes: stat.size });',
    '    }',
    '  }',
    '  out.sort(function (left, right) {',
    '    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;',
    '  });',
    '  return out;',
    '}',
    '',
    'async function census(root, skipNames) {',
    '  const files = await listFiles(root, skipNames);',
    '  let bytes = 0;',
    '  for (const file of files) {',
    '    bytes += file.bytes;',
    '  }',
    '  return { bytes: bytes, files: files.length };',
    '}',
    '',
    'function runCapture(command, args, cwd) {',
    '  return new Promise(function (resolve) {',
    '    const started = Date.now();',
    '    const launch = executableLaunch(command, args);',
    '    let child;',
    '    try {',
    '      child = spawn(launch.file, launch.args, { cwd: cwd, shell: launch.shell, windowsHide: true, env: process.env,'
      + " stdio: ['ignore', 'pipe', 'pipe'] });",
    '    } catch (error) {',
    "      resolve({ exitCode: null, signal: null, ms: Date.now() - started, stdout: '', stderr: '', spawnError: String(error && error.message ? error.message : error) });",
    '      return;',
    '    }',
    "    let stdout = '';",
    "    let stderr = '';",
    "    let settled = false;",
    '    const finish = function (value) {',
    '      if (settled) {',
    '        return;',
    '      }',
    '      settled = true;',
    '      resolve(value);',
    '    };',
    "    child.stdout.on('data', function (chunk) {",
    '      if (stdout.length < OUTPUT_CAP) {',
    '        stdout += String(chunk);',
    '      }',
    '    });',
    "    child.stderr.on('data', function (chunk) {",
    '      if (stderr.length < OUTPUT_CAP) {',
    '        stderr += String(chunk);',
    '      }',
    '    });',
    '    const timer = setTimeout(function () {',
    "      child.kill('SIGKILL');",
    '    }, 110000);',
    "    child.on('error', function (error) {",
    '      clearTimeout(timer);',
    '      finish({ exitCode: null, signal: null, ms: Date.now() - started, stdout: stdout, stderr: stderr, spawnError: String(error && error.message ? error.message : error) });',
    '    });',
    "    child.on('close', function (code, signal) {",
    '      clearTimeout(timer);',
    '      finish({ exitCode: code, signal: signal, ms: Date.now() - started, stdout: stdout, stderr: stderr, spawnError: null });',
    '    });',
    '  });',
    '}',
    '',
    'async function installPackages(projectRoot, npmCommand) {',
    "  const args = ['install'].concat(INSTALL_FLAGS);",
    '  const run = await runCapture(npmCommand, args, projectRoot);',
    '  return {',
    '    command: npmCommand,',
    '    args: args,',
    '    exitCode: run.exitCode,',
    '    signal: run.signal,',
    '    ms: run.ms,',
    '    spawnError: run.spawnError,',
    '    stdoutTail: tail(run.stdout, 1500),',
    '    stderrTail: tail(run.stderr, 4000)',
    '  };',
    '}',
    '',
    'async function projectPackage(projectRoot) {',
    "  const text = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');",
    '  return JSON.parse(text);',
    '}',
    '',
    'async function readDependency(projectRoot, name) {',
    "  const packageFile = path.join(projectRoot, 'node_modules', name, 'package.json');",
    "  const text = await fs.readFile(packageFile, 'utf8');",
    '  const manifest = JSON.parse(text);',
    "  const loaded = require(path.join(projectRoot, 'node_modules', name));",
    '  return {',
    '    name: manifest.name || name,',
    '    version: manifest.version || null,',
    "    banner: typeof loaded.banner === 'string' ? loaded.banner : null,",
    '    packageJsonBytes: Buffer.byteLength(text)',
    '  };',
    '}',
    '',
    'async function buildBundle(projectRoot, dependency) {',
    '  const all = await listFiles(projectRoot, EPHEMERAL);',
    '  const sources = all.filter(function (file) {',
    "    return file.path.indexOf('src/') === 0 || file.path.indexOf('shards/') === 0;",
    '  });',
    '  const entries = [];',
    '  for (const file of sources) {',
    '    const bytes = await fs.readFile(path.join(projectRoot, file.path));',
    '    entries.push({ path: file.path, bytes: bytes.length, sha256: hashBytes(bytes) });',
    '  }',
    "  const digest = hashBytes(Buffer.from(JSON.stringify(entries), 'utf8'));",
    '  const bundle = { banner: dependency.banner, digest: digest, files: entries };',
    "  const text = 'module.exports = ' + JSON.stringify(bundle, null, 2) + ';\\n';",
    "  await fs.mkdir(path.join(projectRoot, 'build'), { recursive: true });",
    "  await fs.writeFile(path.join(projectRoot, 'build', 'bundle.js'), text);",
    "  const output = await census(path.join(projectRoot, 'build'));",
    '  return {',
    '    files: entries.length,',
    '    hashes: entries.map(function (entry) { return entry.sha256; }),',
    '    digest: digest,',
    '    banner: dependency.banner,',
    '    bytes: output.bytes,',
    "    hash: hashBytes(Buffer.from(text, 'utf8'))",
    '  };',
    '}',
    '',
    'async function installAndBuild(projectRoot, npmCommand) {',
    '  const driverStartedAt = new Date().toISOString();',
    "  const nodeModulesPresentBefore = await fs.lstat(path.join(projectRoot, 'node_modules')).then(function () { return true; }, function () { return false; });",
    "  const buildPresentBefore = await fs.lstat(path.join(projectRoot, 'build')).then(function () { return true; }, function () { return false; });",
    '  const materialized = await census(projectRoot, EPHEMERAL);',
    '  const install = await installPackages(projectRoot, npmCommand);',
    "  const nodeModules = await census(path.join(projectRoot, 'node_modules'));",
    '  const manifest = await projectPackage(projectRoot);',
    '  const dependencies = Object.keys(manifest.dependencies || {});',
    '  const name = dependencies.length > 0 ? dependencies[0] : ' + JSON.stringify(DEPENDENCY_NAME) + ';',
    // Installing the local archive must have produced a REAL copied tree. A
    // symlinked dependency would be skipped by the census below and would
    // report zero installed bytes for a dependency that was never really
    // installed.
    '  const dependencyDirectory = path.join(projectRoot, "node_modules", name);',
    '  const dependencyLinked = await fs.lstat(dependencyDirectory).then(function (stat) { return stat.isSymbolicLink(); }, function () { return false; });',
    '  const dependencyTree = await census(dependencyDirectory);',
    '  let dependency = null;',
    '  let dependencyError = null;',
    '  try {',
    '    dependency = await readDependency(projectRoot, name);',
    '  } catch (error) {',
    '    dependencyError = String(error && error.message ? error.message : error);',
    '  }',
    '  const buildStarted = Date.now();',
    '  let build = null;',
    '  let buildError = null;',
    '  try {',
    '    build = await buildBundle(projectRoot, dependency);',
    '  } catch (error) {',
    '    buildError = String(error && error.message ? error.message : error);',
    '  }',
    '  const buildMs = Date.now() - buildStarted;',
    "  const cacheDir = process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || null;",
    '  const driverFinishedAt = new Date().toISOString();',
    '  const freshBefore = nodeModulesPresentBefore === false && buildPresentBefore === false;',
    // `dependencyLinked` must be false and the installed tree must carry real
    // bytes and files, so a symlinked (not really installed) dependency can
    // never be reported as a successful install.
    '  const dependencyReal = dependencyLinked === false && dependencyTree.bytes > 0 && dependencyTree.files > 0;',
    '  const ok = install.exitCode === 0 && freshBefore && dependency !== null && dependencyReal && build !== null;',
    '  return {',
    '    ok: ok,',
    '    driverStartedAt: driverStartedAt,',
    '    driverFinishedAt: driverFinishedAt,',
    '    freshBefore: freshBefore,',
    '    nodeModulesPresentBefore: nodeModulesPresentBefore,',
    '    buildPresentBefore: buildPresentBefore,',
    '    materialized: materialized,',
    '    install: install,',
    '    dependency: dependency,',
    '    dependencyError: dependencyError,',
    '    dependencyLinked: dependencyLinked,',
    '    dependencyReal: dependencyReal,',
    '    dependencyTree: dependencyTree,',
    '    nodeModules: nodeModules,',
    '    build: build === null ? null : {',
    '      ms: buildMs,',
    '      files: build.files,',
    '      bytes: build.bytes,',
    '      hash: build.hash,',
    '      digest: build.digest,',
    '      banner: build.banner',
    '    },',
    '    buildHashes: build === null ? [] : build.hashes,',
    '    buildError: buildError,',
    '    cache: {',
    '      dir: cacheDir,',
    '      shared: cacheDir === null ? null : !isInside(projectRoot, cacheDir)',
    '    }',
    '  };',
    '}',
    '',
    'function emit(prefix, value) {',
    "  process.stdout.write(prefix + ' ' + JSON.stringify(value) + '\\n');",
    '}',
    '',
    'module.exports = {',
    '  installAndBuild: installAndBuild,',
    '  emit: emit,',
    '  census: census,',
    '  listFiles: listFiles,',
    '  hashBytes: hashBytes,',
    '  runCapture: runCapture,',
    '  executableLaunch: executableLaunch',
    '};',
    ''
  ].join('\n');
}

function driverSource() {
  return [
    "'use strict';",
    '',
    '// Runs inside ONE materialized runner lease. It really installs the local',
    '// file: dependency with npm and builds the project from scratch, then reports',
    '// one bounded JSON line that the benchmark parses from the runner result.',
    '',
    "const { installAndBuild, emit } = require('./bench-lib.cjs');",
    '',
    'function argument(name) {',
    '  const index = process.argv.indexOf(name);',
    '  return index === -1 ? null : process.argv[index + 1] || null;',
    '}',
    '',
    'async function main() {',
    "  const npm = argument('--npm') || process.env.BENCH_NPM || 'npm';",
    '  const result = await installAndBuild(process.cwd(), npm);',
    '  const payload = Object.assign({}, result);',
    '  // The per-file hash list is only needed by the verification script inside',
    '  // its own process; never emit it, so the result line stays well bounded.',
    '  delete payload.buildHashes;',
    "  emit('BENCH_RESULT', payload);",
    '  if (!result.ok) {',
    '    process.exitCode = 1;',
    '  }',
    '}',
    '',
    'main().catch(function (error) {',
    "  emit('BENCH_RESULT', { ok: false, fatal: String(error && error.stack ? error.stack : error) });",
    '  process.exitCode = 1;',
    '});',
    ''
  ].join('\n');
}

function verifySource(expected) {
  return [
    "'use strict';",
    '',
    '// The agreed verification command. It installs the local dependency afresh and',
    '// rebuilds the bundle inside its own lease, then proves that EVERY producer',
    '// contribution is present with the exact expected bytes.',
    '',
    "const fs = require('node:fs/promises');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    "const { installAndBuild, emit } = require('./bench-lib.cjs');",
    '',
    'const expected = ' + JSON.stringify(expected, null, 2) + ';',
    '',
    'function argument(name) {',
    '  const index = process.argv.indexOf(name);',
    '  return index === -1 ? null : process.argv[index + 1] || null;',
    '}',
    '',
    'function hashBytes(bytes) {',
    "  return crypto.createHash('sha256').update(bytes).digest('hex');",
    '}',
    '',
    'async function main() {',
    '  const failures = [];',
    "  const npm = argument('--npm') || process.env.BENCH_NPM || 'npm';",
    '  const result = await installAndBuild(process.cwd(), npm);',
    '  if (!result.ok) {',
    "    failures.push('install/build failed: exitCode=' + String(result.install.exitCode) + ' freshBefore=' + String(result.freshBefore) + ' dependencyError=' + String(result.dependencyError) + ' buildError=' + String(result.buildError));",
    '  }',
    '  if (result.dependencyLinked !== false) {',
    "    failures.push('the declared dependency was installed as a symlink instead of a real copied tree');",
    '  }',
    '  if (result.dependencyTree === null || result.dependencyTree.bytes <= 0) {',
    "    failures.push('the installed dependency carries no measurable bytes');",
    '  }',
    '  for (const file of Object.keys(expected.shards)) {',
    '    const bytes = await fs.readFile(path.join(process.cwd(), file));',
    '    const actual = hashBytes(bytes);',
    '    if (actual !== expected.shards[file]) {',
    "      failures.push('contribution mismatch for ' + file);",
    '    }',
    '  }',
    '  const hashes = result.buildHashes || [];',
    '  for (const file of Object.keys(expected.shards)) {',
    '    if (hashes.indexOf(expected.shards[file]) === -1) {',
    "      failures.push('bundle is missing ' + file);",
    '    }',
    '  }',
    '  if (result.build === null || result.build.banner !== expected.banner) {',
    "    failures.push('installed dependency banner mismatch: ' + String(result.build === null ? null : result.build.banner));",
    '  }',
    '  const summary = {',
    '    ok: failures.length === 0,',
    '    failures: failures,',
    '    shards: Object.keys(expected.shards).length,',
    '    banner: result.build === null ? null : result.build.banner,',
    '    freshBefore: result.freshBefore,',
    '    installMs: result.install === null ? null : result.install.ms,',
    '    nodeModulesBytes: result.nodeModules === null ? null : result.nodeModules.bytes,',
    '    nodeModulesFiles: result.nodeModules === null ? null : result.nodeModules.files,',
    '    dependencyLinked: result.dependencyLinked,',
    '    dependencyBytes: result.dependencyTree === null ? null : result.dependencyTree.bytes,',
    '    dependencyFiles: result.dependencyTree === null ? null : result.dependencyTree.files,',
    '    installArgs: result.install === null ? null : result.install.args,',
    '    build: result.build === null ? null : { ms: result.build.ms, files: result.build.files, bytes: result.build.bytes, hash: result.build.hash },',
    '    driverStartedAt: result.driverStartedAt,',
    '    driverFinishedAt: result.driverFinishedAt,',
    '    cache: result.cache',
    '  };',
    "  emit('VERIFY_RESULT', summary);",
    '  if (!summary.ok) {',
    '    process.exitCode = 1;',
    '  }',
    '}',
    '',
    'main().catch(function (error) {',
    "  emit('VERIFY_RESULT', { ok: false, failures: [String(error && error.stack ? error.stack : error)] });",
    '  process.exitCode = 1;',
    '});',
    ''
  ].join('\n');
}

function dependencySources() {
  const index = [
    "'use strict';",
    '',
    "const meta = require('./package.json');",
    "const units = require('./data/units.json');",
    '',
    "const banner = meta.name + '@' + meta.version;",
    '',
    'function digest(entries) {',
    "  return banner + ':' + entries.length + ':' + entries.length;",
    '}',
    '',
    'module.exports = { banner: banner, units: units, digest: digest };',
    ''
  ].join('\n');
  const units = [];
  for (let index0 = 1; index0 <= 64; index0 += 1) {
    units.push({ unit: index0, label: 'fixture-unit-' + pad(index0, 3), weight: index0 * 3 });
  }
  return {
    manifest: {
      name: DEPENDENCY_NAME,
      version: DEPENDENCY_VERSION,
      private: true,
      description: 'Offline local fixture dependency for benchmarks/parallel-workflow.cjs',
      main: 'index.js',
      files: ['index.js', 'data/units.json']
    },
    index: index,
    units: JSON.stringify(units, null, 2) + '\n'
  };
}

const DEPENDENCY = dependencySources();

/** The contribution each producer applies, and the hash the oracle expects. */
function shardPlan(options) {
  const shards = [];
  for (let index = 1; index <= options.workers; index += 1) {
    const shardPath = 'shards/shard-' + pad(index, 2) + '.cjs';
    const base = shardBase(index);
    const contribution = shardContribution(options, index);
    shards.push({
      index,
      path: shardPath,
      base,
      contribution,
      baseHash: sha256(base),
      contributionHash: sha256(contribution)
    });
  }
  return shards;
}

function projectFiles(options, shards) {
  const files = [];
  files.push({
    path: 'package.json',
    content: JSON.stringify({
      name: 'bench-representative-project',
      version: '1.0.0',
      private: true,
      description: 'Generated many-file project for benchmarks/parallel-workflow.cjs',
      dependencies: { [DEPENDENCY_NAME]: DEPENDENCY_SPEC },
      scripts: { build: INSTALL_COMMAND }
    }, null, 2) + '\n'
  });
  files.push({
    path: 'README.md',
    content: [
      '# Generated benchmark project',
      '',
      'Synthetic, deterministic many-file Node project written by',
      '`benchmarks/parallel-workflow.cjs`. It exists only inside an OS temporary',
      'directory and is removed when the benchmark succeeds. `local-fixture` is',
      'packed once into `' + DEPENDENCY_ARCHIVE_FILE + '` inside this project, and',
      'that real local archive is what each runner lease installs with npm.',
      ''
    ].join('\n')
  });
  files.push({ path: 'local-fixture/package.json', content: JSON.stringify(DEPENDENCY.manifest, null, 2) + '\n' });
  files.push({ path: 'local-fixture/index.js', content: DEPENDENCY.index });
  files.push({ path: 'local-fixture/data/units.json', content: DEPENDENCY.units });
  files.push({ path: 'tools/bench-lib.cjs', content: benchLibSource() });
  files.push({ path: 'tools/install-and-build.cjs', content: driverSource() });
  const expected = {
    banner: DEPENDENCY_NAME + '@' + DEPENDENCY_VERSION,
    shards: Object.fromEntries(shards.map(shard => [shard.path, shard.contributionHash]))
  };
  files.push({ path: 'tools/verify.cjs', content: verifySource(expected) });
  files.push({ path: 'src/index.js', content: indexSource(options) });
  for (let index = 0; index < options.files; index += 1) {
    const group = GROUPS[index % GROUPS.length];
    files.push({
      path: 'src/' + group + '/module-' + pad(index + 1, 4) + '.js',
      content: moduleSource(options, index + 1, group)
    });
  }
  for (const shard of shards) {
    files.push({ path: shard.path, content: shard.base });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, expected };
}

async function writeProject(root, options) {
  const shards = shardPlan(options);
  const planned = projectFiles(options, shards);
  let bytes = 0;
  for (const file of planned.files) {
    const target = path.join(root, file.path.split('/').join(path.sep));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
    bytes += Buffer.byteLength(file.content);
  }
  const digest = sha256(JSON.stringify(planned.files.map(file => ({
    path: file.path,
    sha256: sha256(file.content),
    bytes: Buffer.byteLength(file.content)
  }))));
  return {
    files: planned.files.length,
    sourceFiles: options.files,
    bytes,
    digest,
    shards,
    expected: planned.expected,
    ephemeralDirectories: EPHEMERAL_NAMES.slice(),
    dependency: {
      name: DEPENDENCY_NAME,
      version: DEPENDENCY_VERSION,
      mode: 'local-archive',
      spec: DEPENDENCY_SPEC,
      archive: DEPENDENCY_ARCHIVE_FILE,
      packSource: DEPENDENCY_SOURCE_NAME,
      packFlags: PACK_FLAGS.slice(),
      installFlags: INSTALL_FLAGS.slice(),
      installCommand: INSTALL_COMMAND,
      verifyCommand: VERIFY_COMMAND,
      manifestBytes: Buffer.byteLength(JSON.stringify(DEPENDENCY.manifest)),
      unitsBytes: Buffer.byteLength(DEPENDENCY.units)
    }
  };
}

/**
 * One bounded synchronous spawn of a local tool, Windows-safe.
 *
 * The launch comes from `executableLaunch`, the same helper the generated lease
 * library embeds, so a Windows executable path with spaces reaches cmd.exe as
 * ONE quoted token instead of being split at the space, and POSIX keeps its
 * exact argv. It is a call wrapper around `execFileSync`, not a new launcher,
 * watchdog or polling framework, and it starts no background process.
 */
function runSyncCapture(command, args, cwd, timeoutMs) {
  const started = Date.now();
  try {
    const launch = executableLaunch(command, args);
    const stdout = execFileSync(launch.file, launch.args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd,
      shell: launch.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024
    });
    return { exitCode: 0, stdout: String(stdout), stderr: '', ms: Date.now() - started, error: null };
  } catch (error) {
    return {
      exitCode: error && typeof error.status === 'number' ? error.status : null,
      stdout: error && typeof error.stdout === 'string' ? error.stdout : '',
      stderr: error && typeof error.stderr === 'string' ? error.stderr : '',
      ms: Date.now() - started,
      error: messageOf(error)
    };
  }
}

/**
 * Pack the fixture's dependency source folder into a real local archive INSIDE
 * the fixture, once, before the snapshot is captured.
 *
 * The archive is ordinary fixture content: the snapshot captures its raw bytes
 * and every runner lease materializes it, so no path outside the fixture is
 * referenced and isolation is unchanged. The returned record carries the exact
 * hash, size and cost of this fixture preparation step.
 */
async function packDependency(root, options) {
  const args = ['pack', DEPENDENCY_SOURCE_ARGUMENT].concat(PACK_FLAGS);
  const run = runSyncCapture(options.npm, args, root, 60000);
  const target = path.join(root, DEPENDENCY_ARCHIVE_FILE);
  const stat = await fs.stat(target).catch(() => null);
  const bytes = stat && stat.isFile() ? await fs.readFile(target).catch(() => null) : null;
  const record = {
    command: options.npm,
    args,
    exitCode: run.exitCode,
    ms: run.ms,
    stdoutTail: tail(run.stdout, 800),
    stderrTail: tail(run.stderr, 2000),
    path: DEPENDENCY_ARCHIVE_FILE,
    source: DEPENDENCY_SOURCE_NAME,
    spec: DEPENDENCY_SPEC,
    bytes: bytes === null ? null : bytes.length,
    sha256: bytes === null ? null : sha256(bytes),
    gzipMagic: bytes === null || bytes.length < 2 ? null : bytes[0] === 0x1f && bytes[1] === 0x8b,
    error: run.error
  };
  if (run.exitCode !== 0 || bytes === null || record.gzipMagic !== true) {
    throw new Error('npm pack did not produce a usable local dependency archive: ' + JSON.stringify({
      exitCode: run.exitCode,
      present: bytes !== null,
      gzipMagic: record.gzipMagic,
      error: run.error,
      stderrTail: record.stderrTail
    }));
  }
  return record;
}

// ---------------------------------------------------------------------------
// Build resolution
// ---------------------------------------------------------------------------

function resolveBuild() {
  const repository = path.resolve(__dirname, '..');
  const configured = (process.env.BENCH_TEST_BUILD || process.env.CODEX_TEST_BUILD || '').trim();
  const directory = path.resolve(repository, configured === '' ? '.test-build' : configured);
  const required = ['runtime.js', 'engine.js', 'resource-governor.js', 'workspaces.js', 'integration-attempts.js'];
  const missing = required.filter(name => !fsSync.existsSync(path.join(directory, name)));
  if (missing.length > 0) {
    throw new Error('No usable compiled build at ' + directory + ' (missing ' + missing.join(', ')
      + '). Run "npm run build:test" first, or set BENCH_TEST_BUILD to an existing compile.');
  }
  const loaded = {
    runtime: require(path.join(directory, 'runtime.js')),
    engine: require(path.join(directory, 'engine.js')),
    governor: require(path.join(directory, 'resource-governor.js')),
    workspaces: require(path.join(directory, 'workspaces.js')),
    attempts: require(path.join(directory, 'integration-attempts.js'))
  };
  if (typeof loaded.runtime.WorkerBroker !== 'function' || typeof loaded.runtime.unpack !== 'function') {
    throw new Error('The compiled build at ' + directory + ' has no WorkerBroker/unpack; recompile it.');
  }
  if (!loaded.attempts.integrationActionSchema || typeof loaded.attempts.integrationActionSchema.parse !== 'function') {
    throw new Error('The compiled build at ' + directory + ' is stale (no integrationActionSchema); recompile it.');
  }
  return {
    directory,
    runtime: loaded.runtime,
    engine: loaded.engine,
    governor: loaded.governor,
    workspaces: loaded.workspaces,
    attempts: loaded.attempts
  };
}

// ---------------------------------------------------------------------------
// Broker flow helpers
// ---------------------------------------------------------------------------

/** Scripted model calls carry one tool call per turn and a safe, plain id. */
const callId = (prefix, label) => prefix + '-' + String(label).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

function sealAction(requestId, expectedRevision) {
  return { type: 'call', id: callId('seal', requestId), name: 'seal_submission', input: { requestId, expectedRevision } };
}

function runAction(command, label) {
  return { type: 'call', id: callId('run', label), name: 'run_command', input: { command, path: '.', timeoutMs: commandTimeoutMs } };
}

function toolResult(session, name) {
  const turns = Array.isArray(session && session.turns) ? session.turns : [];
  const last = turns.length > 0 ? turns[turns.length - 1] : null;
  const tools = Array.isArray(last && last.tools) ? last.tools : [];
  const entry = tools.find(tool => tool.call && tool.call.name === name);
  if (!entry) {
    throw new Error('The last turn of worker ' + String(session && session.id) + ' contains no ' + name + ' call.');
  }
  return JSON.parse(entry.result);
}

function failureOf(session) {
  const turns = Array.isArray(session && session.turns) ? session.turns : [];
  const last = turns.length > 0 ? turns[turns.length - 1] : null;
  const error = last && last.error ? last.error : null;
  return error === null ? 'no turn error recorded' : JSON.stringify(error).slice(0, 2000);
}

async function settle(ctx, ids, label) {
  const pending = new Set(ids);
  const sessions = new Map();
  const deadline = Date.now() + ctx.options.waitBudgetMs;
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for ' + label + ' workers: ' + [...pending].join(', '));
    }
    await ctx.call('subagent_wait', { ids: [...pending], timeoutMs: 60000 });
    for (const id of [...pending]) {
      const session = await ctx.broker.session(ctx.root, id);
      const state = session.state;
      if (state === 'running' || state === 'queued') {
        continue;
      }
      pending.delete(id);
      sessions.set(id, session);
      if (state !== 'completed') {
        throw new Error('Worker ' + id + ' ended ' + state + ': ' + failureOf(session));
      }
    }
  }
  return sessions;
}

async function createTask(ctx, requestId, title, description) {
  return ctx.call('subagent_task_create', {
    ownerId: OWNER_ID,
    requestId,
    teamId: ctx.teamId,
    title,
    description,
    acceptanceCriteria: [VERIFY_COMMAND + ' passes on the integrated result']
  });
}

async function spawnWorker(ctx, requestId, taskId, lane, snapshotId, prompt) {
  const team = await ctx.call('subagent_team_get', { ownerId: OWNER_ID, id: ctx.teamId });
  const task = await ctx.call('subagent_task_get', { ownerId: OWNER_ID, id: taskId });
  return ctx.call('subagent_isolated_spawn', {
    ownerId: OWNER_ID,
    requestId,
    task: prompt,
    model: MODEL.id,
    permission: 'workspace-write',
    leaseSeconds: 1800,
    setup: {
      teamId: ctx.teamId,
      taskId,
      snapshotId,
      teamRevision: team.revision,
      taskRevision: task.revision,
      lane
    }
  });
}

async function sendTurn(ctx, workerId, requestId, actions) {
  const token = ctx.tokens.get(workerId);
  if (!token) {
    throw new Error('No scripted-model token registered for worker ' + workerId + '.');
  }
  ctx.state.actions.set(token, actions);
  await ctx.call('subagent_send', { ownerId: OWNER_ID, id: workerId, requestId, message: requestId });
  return settle(ctx, [workerId], requestId);
}

async function submitTask(ctx, taskId, artifact, label) {
  const current = await ctx.call('subagent_task_get', { ownerId: OWNER_ID, id: taskId });
  const started = await ctx.call('subagent_task_update', {
    ownerId: OWNER_ID,
    requestId: label + '-start',
    taskId,
    expectedRevision: current.revision,
    state: 'in_progress'
  });
  return ctx.call('subagent_task_update', {
    ownerId: OWNER_ID,
    requestId: label + '-submit',
    taskId,
    expectedRevision: started.revision,
    candidates: [artifact],
    state: 'submitted'
  });
}

/** Queue-length samples with event timestamps, taken while a round runs. */
function startSampler(ctx, teamId) {
  const samples = [];
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || samples.length >= 400) {
      return;
    }
    busy = true;
    try {
      const status = await ctx.call('subagent_runner_status', { ownerId: OWNER_ID, teamId, kind: 'queue', limit: 20 });
      const summary = status && status.summary ? status.summary : {};
      samples.push({
        at: nowIso(),
        queueLength: typeof summary.queueLength === 'number' ? summary.queueLength : null,
        activeCount: typeof summary.activeCount === 'number' ? summary.activeCount : null,
        queueRows: Array.isArray(status && status.items) ? status.items.length : null
      });
    } catch (error) {
      samples.push({ at: nowIso(), error: messageOf(error) });
    } finally {
      busy = false;
    }
  }, 100);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return { samples, stop: () => clearInterval(timer) };
}

/** Per-command metrics: measured fields plus explicitly derived timings. */
function commandRecord(producer, result, requestedAt, leaseRow) {
  const attemptStarted = Date.parse(result.attempt.startedAt);
  const completed = Date.parse(result.completedAt);
  const observedAt = Date.now();
  const driver = parseEmitted(result.output, 'BENCH_RESULT');
  const leaseCreated = leaseRow ? Date.parse(leaseRow.createdAt) : null;
  const driverStart = driver && driver.driverStartedAt ? Date.parse(driver.driverStartedAt) : null;
  const driverEnd = driver && driver.driverFinishedAt ? Date.parse(driver.driverFinishedAt) : null;
  return {
    unit: producer.unit,
    workerId: producer.workerId,
    outcome: result.outcome,
    exitCode: result.exitCode,
    drained: result.drained,
    import: result.import,
    resultRef: { id: result.id, version: result.version, uri: result.uri },
    leaseId: result.attempt.leaseId,
    inputRevision: result.attempt.inputVersion ? result.attempt.inputVersion.revision : null,
    command: result.attempt.command,
    outputTail: tail(result.output, 800),
    timings: {
      requestedAt: new Date(requestedAt).toISOString(),
      leaseCreatedAt: leaseRow ? leaseRow.createdAt : null,
      attemptStartedAt: result.attempt.startedAt,
      driverStartedAt: driver ? driver.driverStartedAt : null,
      driverFinishedAt: driver ? driver.driverFinishedAt : null,
      completedAt: result.completedAt,
      observedAt: new Date(observedAt).toISOString(),
      leaseWaitMs: leaseCreated !== null ? leaseCreated - requestedAt : null,
      setupToDriverMs: driverStart !== null ? driverStart - attemptStarted : null,
      installMs: driver && driver.install ? driver.install.ms : null,
      buildMs: driver && driver.build ? driver.build.ms : null,
      postProcessMs: driverEnd !== null ? completed - driverEnd : null,
      runnerTotalMs: completed - attemptStarted,
      observedTotalMs: observedAt - requestedAt
    },
    fresh: driver ? {
      before: driver.freshBefore,
      nodeModulesAbsentBeforeInstall: driver.nodeModulesPresentBefore === false,
      buildAbsentBeforeBuild: driver.buildPresentBefore === false,
      materializedBytes: driver.materialized ? driver.materialized.bytes : null,
      materializedFiles: driver.materialized ? driver.materialized.files : null,
      nodeModulesBytes: driver.nodeModules ? driver.nodeModules.bytes : null,
      nodeModulesFiles: driver.nodeModules ? driver.nodeModules.files : null,
      // A real copied install, never a node_modules symlink to the fixture.
      dependencyLinked: typeof driver.dependencyLinked === 'boolean' ? driver.dependencyLinked : null,
      dependencyReal: typeof driver.dependencyReal === 'boolean' ? driver.dependencyReal : null,
      dependencyInstalledBytes: driver.dependencyTree ? driver.dependencyTree.bytes : null,
      dependencyInstalledFiles: driver.dependencyTree ? driver.dependencyTree.files : null,
      cacheShared: driver.cache ? driver.cache.shared : null,
      cacheDirPresent: driver.cache ? driver.cache.dir !== null : null
    } : null,
    install: driver && driver.install ? {
      exitCode: driver.install.exitCode,
      spawnError: driver.install.spawnError,
      args: driver.install.args,
      stderrTail: driver.install.stderrTail
    } : null,
    dependency: driver ? driver.dependency : null,
    dependencyError: driver ? driver.dependencyError : null,
    build: driver ? driver.build : null,
    buildError: driver ? driver.buildError : null,
    payloadPresent: driver !== null,
    payloadError: driver === null ? 'the driver result line was not found in the bounded command output' : null
  };
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

function initialUnavailable() {
  return [
    { metric: 'network.downloadBytes', reason: 'the dependency is a local package archive inside the fixture, so npm downloads no package bytes; only the shared manager cache directory is reused' },
    { metric: 'cpuTime', reason: 'the production runner records wall times only; no per-process CPU accounting is exposed' },
    { metric: 'snapshot.durationBreakdown', reason: 'subagent_snapshot_create reports a single wall time; capture scan and content phases are not separately exposed' },
    { metric: 'workspacePublicationCost', reason: 'apply publishes inside the temporary fixture; filesystem durability of the host volume is not benchmarked' }
  ];
}

async function runBenchmark(options, build, artifacts) {
  const report = {
    schema: SCHEMA,
    benchmark: BENCHMARK,
    generatedAt: nowIso(),
    status: 'running',
    invocation: { argv: options.argv, options: { ...options, argv: undefined } },
    runtime: artifacts.runtime,
    project: null,
    pool: null,
    snapshot: null,
    board: null,
    producersPhaseMs: null,
    workers: [],
    queue: null,
    parallel: null,
    freshnessProbe: null,
    integration: null,
    sequential: null,
    comparison: null,
    storage: null,
    endToEnd: null,
    cleanup: { brokerCloseMs: null, tmpDir: null, tmpRemoved: false, retainedTmpDir: null, closeError: null },
    unavailable: initialUnavailable(),
    limitations: artifacts.limitations,
    definitions: DEFINITIONS
  };
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bench-parallel-')));
  report.cleanup.tmpDir = base;
  const root = path.join(base, 'project');
  await fs.mkdir(root, { recursive: true });
  report.project = { fixtureRoot: root, ...(await writeProject(root, options)) };
  process.env.BENCH_NPM = options.npm;

  const state = {
    actions: new Map(),
    errors: [],
    approvals: [],
    requests: 0,
    routing: { routed: 0, finishedTurns: 0, tokens: new Set() }
  };
  const provider = {
    models: async () => [MODEL],
    countTokens: async () => 10,
    async *stream(_selected, messages) {
      state.requests += 1;
      const tag = coordinatorTag(messages);
      if (tag === null) {
        throw new Error('Scripted model routing failed: the prompt carries no coordinator plain-text turn.');
      }
      const { token, candidates } = routeToken(tag, state.actions.keys());
      if (token === null) {
        throw new Error('Scripted model routing failed: the last coordinator turn names no registered worker token: '
          + JSON.stringify(tag.slice(0, 200)));
      }
      if (candidates.length > 1) {
        throw new Error('Scripted model routing is ambiguous: the last coordinator turn matches '
          + JSON.stringify(candidates) + ' at the longest length.');
      }
      state.routing.tokens.add(token);
      const queue = state.actions.get(token);
      const action = Array.isArray(queue) && queue.length > 0 ? queue.shift() : undefined;
      if (action) {
        state.routing.routed += 1;
      } else {
        state.routing.finishedTurns += 1;
      }
      yield action || { type: 'text', text: 'done' };
    }
  };
  const sessions = sessionReservation(options.workers);
  const settings = () => ({
    ...build.engine.defaults,
    autoCompact: false,
    retries: 0,
    models: {
      [MODEL.id]: { allowWrite: true, allowShell: true, numSessions: sessions }
    }
  });
  const brokerOptions = {
    storage: path.join(base, 'storage'),
    registry: path.join(base, 'registry'),
    roots: [root],
    identity: 'folder:' + root,
    provider,
    settings,
    taskBoardEnabled: () => true,
    isolatedViewsEnabled: () => true,
    integrationEnabled: () => true,
    resourcesEnabled: () => true,
    resources: () => ({ ...build.governor.resourceDefaults, enabled: true }),
    resourceDirectory: path.join(base, 'resources'),
    runners: () => ({ enabled: true, capacity: options.capacity, maxQueue: options.maxQueue }),
    files: {
      canWrite: () => true,
      allowShell: () => true,
      approveCommand: async (command, cwd) => {
        const allowed = isInside(base, cwd);
        state.approvals.push({ command, cwd, allowed });
        return allowed;
      }
    },
    openDocuments: () => [],
    publicationDocuments: () => [],
    onChange: () => {},
    onError: message => { state.errors.push(String(message)); }
  };
  const broker = new build.runtime.WorkerBroker(brokerOptions);
  const ctx = {
    broker,
    root,
    base,
    state,
    options,
    call: async (name, args) => build.runtime.unpack(await broker.invoke(root, name, args)),
    tokens: new Map(),
    teamId: null,
    storeDirectory: null
  };
  const governorConfig = { ...build.governor.resourceDefaults, enabled: true };
  report.pool = {
    workers: options.workers,
    capacity: options.capacity,
    maxQueue: options.maxQueue,
    productionBounds: { capacity: [1, 8], maxQueue: [0, 256], numSessions: [1, MODEL_SESSION_MAX] },
    capsRaised: false,
    resources: governorConfig,
    model: {
      id: MODEL.id,
      numSessions: sessions,
      numSessionsRequested: Math.max(4, options.workers + 2),
      numSessionsCeiling: MODEL_SESSION_MAX,
      clamped: sessions !== Math.max(4, options.workers + 2),
      allowWrite: true,
      allowShell: true
    },
    // CONFIGURED CEILING on concurrently running WORK commands, not an observed
    // concurrency: observed throughput can be lower (serial edit/seal turns and
    // queueing). It is the smaller of the two governor ceilings that apply to a
    // work claim - the local one, which gives up one pool slot to the service
    // lanes only when capacity > 1, and the aggregate one, runnerCapacity minus
    // serviceReserve (src/resource-governor.ts). With the default pool capacity 2
    // and runnerCapacity 4 / serviceReserve 1 that is min(1, 3) = ONE work
    // runner, whatever --workers says: the remaining workers wait in the bounded
    // queue and their wait is what `queue`/`leaseWaitMs` report.
    effectiveConcurrentWorkRunners: effectiveWorkRunnerCeiling(options.capacity, governorConfig),
    effectiveReservationNote: 'per-model numSessions is clamped to the schema ceiling ' + MODEL_SESSION_MAX
      + '; aggregate runner admission is runnerCapacity ' + String(governorConfig.runnerCapacity)
      + ' minus serviceReserve ' + String(governorConfig.serviceReserve)
      + ', while this root queues against the explicit pool capacity ' + options.capacity + ' and maxQueue ' + options.maxQueue
      + '; effectiveConcurrentWorkRunners is the smaller of that aggregate work ceiling and this root\'s own work ceiling'
  };
  try {
    await broker.start();
    // Fixture preparation, BEFORE any snapshot is captured: pack the dependency
    // source folder into a real local archive inside the fixture. Its cost is
    // reported separately and is excluded from endToEnd, because no lease
    // benefits from it - every lease installs the archive afresh.
    const pack = await packDependency(root, options);
    report.project.packMs = pack.ms;
    report.project.packMeasured = true;
    // `files`/`bytes`/`digest` describe the GENERATED sources; the captured
    // project additionally contains the packed archive, so both scopes are
    // reported instead of silently mixing them.
    report.project.digestScope = 'generated source files written before the dependency archive was packed';
    report.project.capturedFiles = report.project.files + 1;
    report.project.capturedBytes = report.project.bytes + pack.bytes;
    report.project.dependency.sourceArchive = {
      path: pack.path,
      source: pack.source,
      spec: pack.spec,
      bytes: pack.bytes,
      sha256: pack.sha256,
      gzipMagic: pack.gzipMagic,
      packCommand: pack.command,
      packArgs: pack.args,
      packMs: pack.ms,
      capturedBySnapshot: true
    };
    const startedBroker = Date.now();
    ctx.storeDirectory = await resolveStoreDirectory(build.workspaces, brokerOptions.storage, root);
    const viewsDirectory = ctx.storeDirectory ? path.join(ctx.storeDirectory, 'isolated-views') : null;
    const runnersDirectory = ctx.storeDirectory ? path.join(ctx.storeDirectory, 'runners') : null;
    if (!viewsDirectory) {
      report.unavailable.push({ metric: 'storage', reason: 'workspaceDirectory() did not resolve the private store directory' });
    }

    // --- team and base snapshot ---------------------------------------------
    const team = await ctx.call('subagent_team_create', {
      ownerId: OWNER_ID,
      requestId: 'bench-team',
      name: 'Parallel workflow benchmark',
      description: 'Representative many-file install/build fan-out'
    });
    ctx.teamId = team.id;
    const indexFile = viewsDirectory ? path.join(viewsDirectory, 'index.json') : null;
    const indexBefore = indexFile ? await fs.stat(indexFile).catch(() => null) : null;
    const viewsBeforeSnapshot = await census(viewsDirectory);
    const snapshotStart = Date.now();
    const snapshot = await ctx.call('subagent_snapshot_create', { ownerId: OWNER_ID, teamId: team.id, requestId: 'bench-snapshot' });
    const snapshotMs = Date.now() - snapshotStart;
    const viewsAfterSnapshot = await census(viewsDirectory);
    const indexAfter = indexFile ? await fs.stat(indexFile).catch(() => null) : null;
    const manifestBytes = await contentBlobSize(viewsDirectory, snapshot.manifestHash);
    report.snapshot = {
      id: snapshot.id,
      manifestHash: snapshot.manifestHash,
      createdAt: snapshot.createdAt,
      createMs: snapshotMs,
      manifestJsonBytes: manifestBytes,
      viewIndexJsonBytesBefore: indexBefore ? indexBefore.size : null,
      viewIndexJsonBytesAfter: indexAfter ? indexAfter.size : null,
      storageAdded: delta(viewsBeforeSnapshot, viewsAfterSnapshot),
      capturedFiles: report.project.capturedFiles,
      capturedBytes: report.project.capturedBytes,
      generatedFiles: report.project.files,
      generatedBytes: report.project.bytes,
      projectDigest: report.project.digest,
      dependencyArchive: report.project.dependency.sourceArchive === undefined
        ? null
        : {
          path: report.project.dependency.sourceArchive.path,
          bytes: report.project.dependency.sourceArchive.bytes,
          sha256: report.project.dependency.sourceArchive.sha256
        }
    };
    if (manifestBytes === null) {
      report.unavailable.push({ metric: 'snapshot.manifestJsonBytes', reason: 'the manifest blob was not found under the private view content store' });
    }

    // --- board tasks ---------------------------------------------------------
    const tasks = [];
    for (let unit = 1; unit <= options.workers; unit += 1) {
      tasks.push(await createTask(ctx, 'bench-task-' + unit, 'unit-' + pad(unit, 2), 'Produce ' + report.project.shards[unit - 1].path));
    }
    const validationTask = await createTask(ctx, 'bench-task-validation', 'validation', 'Run the agreed verification on the composed seed');
    const baselineTask = options.baseline === 'sequential'
      ? await createTask(ctx, 'bench-task-baseline', 'sequential-baseline', 'Serial reference run of the same units')
      : null;
    report.board = {
      tasks: tasks.length + 1 + (baselineTask ? 1 : 0),
      producers: tasks.length,
      submitted: 0
    };

    // --- producers: edit (measured overlay growth) then seal -------------------
    const producers = [];
    const producerPhaseStart = Date.now();
    for (let position = 0; position < tasks.length; position += 1) {
      const unit = position + 1;
      const token = '[bench #' + unit + ']';
      const shard = report.project.shards[position];
      const viewsBeforeEdit = await census(viewsDirectory);
      const spawnStart = Date.now();
      state.actions.set(token, [{
        type: 'call',
        id: 'edit-' + unit,
        name: 'write_file',
        input: { path: shard.path, expectedHash: shard.baseHash, content: shard.contribution }
      }]);
      const worker = await spawnWorker(ctx, token + ' edit', tasks[position].id, 'work', snapshot.id, token + ' produce ' + shard.path);
      ctx.tokens.set(worker.id, token);
      const editedSessions = await settle(ctx, [worker.id], token);
      const spawnAndEditMs = Date.now() - spawnStart;
      const edit = toolResult(editedSessions.get(worker.id), 'write_file');
      const viewsAfterEdit = await census(viewsDirectory);
      const sealStart = Date.now();
      const sealedSessions = await sendTurn(ctx, worker.id, token + ' seal', [sealAction(token + ' seal', edit.revision)]);
      const sealMs = Date.now() - sealStart;
      const seal = toolResult(sealedSessions.get(worker.id), 'seal_submission');
      if (edit.revision !== 1 || seal.revision !== 1) {
        throw new Error('Unit ' + unit + ' did not produce revision 1: ' + JSON.stringify({ edit: edit.revision, seal: seal.revision }));
      }
      producers.push({
        unit,
        token,
        workerId: worker.id,
        taskId: tasks[position].id,
        shard,
        spawnAndEditMs,
        editRevision: edit.revision,
        overlayGrowth: delta(viewsBeforeEdit, viewsAfterEdit),
        sealMs,
        sealRevision: seal.revision,
        artifact: { id: seal.id, version: seal.version, uri: seal.uri }
      });
    }
    report.producersPhaseMs = Date.now() - producerPhaseStart;
    for (const producer of producers) {
      const submitted = await submitTask(ctx, producer.taskId, producer.artifact, producer.token);
      producer.submissionTask = { id: submitted.id, revision: submitted.revision, state: submitted.state };
      report.board.submitted += 1;
    }

    // --- the parallel runner round -------------------------------------------
    for (const producer of producers) {
      state.actions.set(producer.token, [runAction(INSTALL_COMMAND, producer.token + ' run')]);
    }
    const requestedAt = new Map();
    const sampler = startSampler(ctx, team.id);
    const roundStart = Date.now();
    const sends = producers.map(producer => {
      requestedAt.set(producer.token, Date.now());
      return ctx.call('subagent_send', {
        ownerId: OWNER_ID,
        id: producer.workerId,
        requestId: producer.token + ' run',
        message: producer.token + ' install and build'
      });
    });
    await Promise.all(sends);
    const roundSessions = await settle(ctx, producers.map(producer => producer.workerId), 'parallel runner round');
    sampler.stop();
    const roundMs = Date.now() - roundStart;
    const leaseStatus = await ctx.call('subagent_runner_status', { ownerId: OWNER_ID, teamId: team.id, kind: 'leases', limit: 20 })
      .catch(error => ({ items: [], error: messageOf(error) }));
    const leases = new Map((Array.isArray(leaseStatus.items) ? leaseStatus.items : []).map(row => [row.id, row]));
    const failures = [];
    for (const producer of producers) {
      const result = toolResult(roundSessions.get(producer.workerId), 'run_command');
      const record = commandRecord(producer, result, requestedAt.get(producer.token), leases.get(result.attempt.leaseId) || null);
      if (record.timings.leaseWaitMs === null) {
        report.unavailable.push({
          metric: 'workers[' + producer.unit + '].timings.leaseWaitMs',
          reason: 'the durable lease row was no longer readable when the round ended'
        });
      }
      producer.run = record;
      producer.evidence = { id: result.id, version: result.version, uri: result.uri };
      record.shard = producer.shard.path;
      record.spawnAndEditMs = producer.spawnAndEditMs;
      record.sealMs = producer.sealMs;
      record.sealRevision = producer.sealRevision;
      record.overlayGrowth = producer.overlayGrowth;
      report.workers.push(record);
      if (record.outcome !== 'succeeded') {
        failures.push('unit ' + producer.unit + ': ' + record.outcome + ' (exit ' + record.exitCode + ') ' + record.outputTail);
      } else if (record.import !== 'unchanged') {
        failures.push('unit ' + producer.unit + ': the lease imported changes (' + record.import + '), so it wrote outside the ephemeral output directories');
      } else if (record.fresh === null || record.fresh.before !== true) {
        failures.push('unit ' + producer.unit + ': the lease found preexisting node_modules/build output; installs must be fresh per lease');
      } else if (record.build === null || record.dependency === null) {
        failures.push('unit ' + producer.unit + ': no dependency/build evidence (' + JSON.stringify({ dependencyError: record.dependencyError, buildError: record.buildError }) + ')');
      } else if (record.fresh.dependencyLinked !== false || record.fresh.dependencyReal !== true) {
        failures.push('unit ' + producer.unit + ': the declared dependency was not installed as a real copied tree (linked='
          + String(record.fresh.dependencyLinked) + ')');
      } else if (!Number.isFinite(record.fresh.dependencyInstalledBytes) || record.fresh.dependencyInstalledBytes <= 0) {
        failures.push('unit ' + producer.unit + ': the installed dependency reports ' + String(record.fresh.dependencyInstalledBytes) + ' bytes');
      }
    }
    report.queue = {
      samplingIntervalMs: 100,
      samples: sampler.samples.length,
      maxQueueLength: sampler.samples.reduce((max, sample) => (typeof sample.queueLength === 'number' && (max === null || sample.queueLength > max) ? sample.queueLength : max), null),
      maxActiveCount: sampler.samples.reduce((max, sample) => (typeof sample.activeCount === 'number' && (max === null || sample.activeCount > max) ? sample.activeCount : max), null),
      first: sampler.samples.slice(0, 3),
      last: sampler.samples.slice(-3),
      leaseStatusError: leaseStatus.error || null
    };
    if (sampler.samples.length === 0) {
      report.unavailable.push({ metric: 'queue.samples', reason: 'the runner round finished before the first queue sample was taken' });
    }
    const parallelWallMs = Date.now() - producerPhaseStart;
    report.parallel = {
      units: producers.length,
      editPhaseMs: report.producersPhaseMs,
      runnerRoundMs: roundMs,
      wallMs: parallelWallMs,
      installs: report.workers.length,
      installMsTotal: round(report.workers.reduce((sum, worker) => sum + (worker.timings.installMs || 0), 0)),
      dependencyNodeModulesBytesTotal: report.workers.reduce((sum, worker) => sum + (worker.fresh && worker.fresh.nodeModulesBytes ? worker.fresh.nodeModulesBytes : 0), 0),
      dependencyInstalledBytesPerLease: report.workers.length > 0 && report.workers[0].fresh ? report.workers[0].fresh.dependencyInstalledBytes : null,
      dependencyInstalledBytesTotal: report.workers.reduce((sum, worker) => sum + (worker.fresh && worker.fresh.dependencyInstalledBytes ? worker.fresh.dependencyInstalledBytes : 0), 0),
      unitsPerSecond: round(producers.length / (parallelWallMs / 1000)),
      capacity: options.capacity,
      maxQueue: options.maxQueue
    };
    if (failures.length > 0) {
      throw new Error('The parallel runner round failed: ' + failures.join(' | '));
    }

    // --- freshness probe: a SECOND lease on the same worker -------------------
    const probeProducer = producers[0];
    const probeRequestedAt = Date.now();
    const probeSessions = await sendTurn(ctx, probeProducer.workerId, probeProducer.token + ' probe', [runAction(INSTALL_COMMAND, probeProducer.token + ' probe')]);
    const probeResult = toolResult(probeSessions.get(probeProducer.workerId), 'run_command');
    const probeLeaseStatus = await ctx.call('subagent_runner_status', { ownerId: OWNER_ID, teamId: team.id, kind: 'leases', limit: 20 })
      .catch(() => ({ items: [] }));
    const probeLeases = new Map((Array.isArray(probeLeaseStatus.items) ? probeLeaseStatus.items : []).map(row => [row.id, row]));
    report.freshnessProbe = {
      ...commandRecord(probeProducer, probeResult, probeRequestedAt, probeLeases.get(probeResult.attempt.leaseId) || null),
      purpose: 'a second lease of the same worker; it proves the install is repeated per lease instead of being reused'
    };
    if (report.freshnessProbe.outcome !== 'succeeded' || report.freshnessProbe.fresh === null
      || report.freshnessProbe.fresh.before !== true || report.freshnessProbe.fresh.dependencyReal !== true) {
      throw new Error('The freshness probe lease did not install from scratch: ' + JSON.stringify({ outcome: report.freshnessProbe.outcome, fresh: report.freshnessProbe.fresh }));
    }

    // --- integration ---------------------------------------------------------
    const integration = { effort: {}, validation: null, conflicts: null, applied: null };
    const sources = producers.map(producer => ({
      taskId: producer.submissionTask.id,
      taskRevision: producer.submissionTask.revision,
      artifact: producer.artifact,
      evidence: [producer.evidence]
    }));
    const beginStart = Date.now();
    const begin = await ctx.call('subagent_integration', {
      action: 'begin',
      ownerId: OWNER_ID,
      teamId: team.id,
      requestId: 'bench-begin',
      sources,
      validationCommands: [VERIFY_COMMAND]
    });
    integration.beginMs = Date.now() - beginStart;
    if (begin.status !== 'ready') {
      throw new Error('Integration begin was not ready: ' + JSON.stringify(begin.failure || begin));
    }
    integration.conflicts = Array.isArray(begin.conflictPaths) ? begin.conflictPaths.slice() : [];
    integration.derivedSnapshotId = begin.derivedSnapshotId;
    integration.baseSnapshotId = begin.baseSnapshotId;
    integration.sources = sources.length;
    if (integration.conflicts.length > 0) {
      throw new Error('The producers were expected to touch disjoint paths, but integration reported conflicts: ' + JSON.stringify(integration.conflicts));
    }

    const validationToken = '[bench validation]';
    state.actions.set(validationToken, [sealAction(validationToken + ' seal', 0)]);
    const validationSpawnStart = Date.now();
    const validationWorker = await spawnWorker(ctx, validationToken + ' seal', validationTask.id, 'validation', begin.derivedSnapshotId, validationToken + ' verify the composed seed');
    ctx.tokens.set(validationWorker.id, validationToken);
    const seedSealSessions = await settle(ctx, [validationWorker.id], 'validation seal');
    integration.validationSpawnAndSealMs = Date.now() - validationSpawnStart;
    const seedSeal = toolResult(seedSealSessions.get(validationWorker.id), 'seal_submission');
    if (seedSeal.revision !== 0) {
      throw new Error('The validation candidate is not the unchanged derived seed: revision ' + seedSeal.revision);
    }
    const candidateStart = Date.now();
    const seedCandidate = await ctx.call('subagent_integration', {
      action: 'candidate',
      ownerId: OWNER_ID,
      teamId: team.id,
      attemptId: begin.attemptId,
      expectedRevision: begin.revision,
      requestId: 'bench-candidate-seed',
      artifact: { id: seedSeal.id, version: seedSeal.version, uri: seedSeal.uri }
    });
    integration.candidateMs = Date.now() - candidateStart;
    const verifySessions = await sendTurn(ctx, validationWorker.id, validationToken + ' run', [runAction(VERIFY_COMMAND, validationToken + ' run')]);
    const verifyRun = toolResult(verifySessions.get(validationWorker.id), 'run_command');
    const verifyPayload = parseEmitted(verifyRun.output, 'VERIFY_RESULT');
    integration.validation = {
      workspaceRevision: seedSeal.revision,
      run: {
        outcome: verifyRun.outcome,
        exitCode: verifyRun.exitCode,
        import: verifyRun.import,
        startedAt: verifyRun.attempt.startedAt,
        completedAt: verifyRun.completedAt,
        totalMs: Date.parse(verifyRun.completedAt) - Date.parse(verifyRun.attempt.startedAt),
        resultRef: { id: verifyRun.id, version: verifyRun.version, uri: verifyRun.uri }
      },
      verify: verifyPayload,
      outputTail: tail(verifyRun.output, 1500)
    };
    if (verifyRun.outcome !== 'succeeded') {
      throw new Error('The agreed verification command failed on the composed seed: ' + JSON.stringify({ exitCode: verifyRun.exitCode, verify: verifyPayload, outputTail: tail(verifyRun.output, 1500) }));
    }
    if (verifyPayload === null || verifyPayload.ok !== true) {
      throw new Error('The verification payload did not report success: ' + JSON.stringify(verifyPayload));
    }
    const validateStart = Date.now();
    const validated = await ctx.call('subagent_integration', {
      action: 'validate',
      ownerId: OWNER_ID,
      teamId: team.id,
      attemptId: begin.attemptId,
      expectedRevision: seedCandidate.revision,
      requestId: 'bench-validate',
      evidence: [{ id: verifyRun.id, version: verifyRun.version, uri: verifyRun.uri }]
    });
    integration.validateMs = Date.now() - validateStart;
    if (validated.status !== 'validated') {
      throw new Error('Integration validate did not reach validated: ' + JSON.stringify(validated.status));
    }
    const acceptStart = Date.now();
    const accepted = await ctx.call('subagent_integration', {
      action: 'accept',
      ownerId: OWNER_ID,
      teamId: team.id,
      attemptId: begin.attemptId,
      expectedRevision: validated.revision,
      requestId: 'bench-accept'
    });
    integration.acceptMs = Date.now() - acceptStart;
    if (accepted.status !== 'accepted') {
      throw new Error('Integration accept did not reach accepted: ' + JSON.stringify(accepted.status));
    }
    if (options.skipApply) {
      integration.applyMs = null;
      report.unavailable.push({ metric: 'integration.applied', reason: '--skip-apply was passed, so no live publication was attempted' });
    } else {
      const applyStart = Date.now();
      const applied = await ctx.call('subagent_integration', {
        action: 'apply',
        ownerId: OWNER_ID,
        teamId: team.id,
        attemptId: begin.attemptId,
        expectedRevision: accepted.revision,
        requestId: 'bench-apply'
      });
      integration.applyMs = Date.now() - applyStart;
      if (applied.status !== 'applied' || !applied.apply || applied.apply.state !== 'applied') {
        throw new Error('Integration apply did not reach applied: ' + JSON.stringify({ status: applied.status, apply: applied.apply }));
      }
      const effects = [];
      for (const producer of producers) {
        const onDisk = await fs.readFile(path.join(root, producer.shard.path.split('/').join(path.sep)));
        const digest = sha256(onDisk);
        effects.push({ path: producer.shard.path, sha256: digest, matchesContribution: digest === producer.shard.contributionHash });
      }
      integration.applied = { paths: applied.apply.applied.slice(), conflicts: applied.apply.conflicts.slice(), effects };
      if (effects.some(effect => !effect.matchesContribution)) {
        throw new Error('The applied workspace does not carry every producer contribution: ' + JSON.stringify(effects));
      }
    }
    integration.effort = {
      begin: 1,
      candidate: 1,
      validate: 1,
      accept: 1,
      apply: integration.applyMs === null ? 0 : 1,
      integrationCalls: integration.applyMs === null ? 4 : 5,
      runnerLeases: report.workers.length + 2,
      runnerLeaseBreakdown: 'one per producer command, one freshness probe, one validation command'
    };
    report.integration = integration;

    // --- comparable sequential baseline --------------------------------------
    if (baselineTask) {
      const token = '[bench baseline]';
      const baselineStart = Date.now();
      const firstShard = report.project.shards[0];
      state.actions.set(token, [{
        type: 'call',
        id: 'baseline-edit-1',
        name: 'write_file',
        input: { path: firstShard.path, expectedHash: firstShard.baseHash, content: firstShard.contribution }
      }]);
      const baselineWorker = await spawnWorker(ctx, token + ' edit 1', baselineTask.id, 'work', snapshot.id, token + ' serial reference run');
      ctx.tokens.set(baselineWorker.id, token);
      let sessions = await settle(ctx, [baselineWorker.id], 'baseline edit 1');
      const spawnMs = Date.now() - baselineStart;
      const units = [];
      for (let unit = 1; unit <= options.workers; unit += 1) {
        const unitStart = Date.now();
        if (unit > 1) {
          const shard = report.project.shards[unit - 1];
          sessions = await sendTurn(ctx, baselineWorker.id, token + ' edit ' + unit, [{
            type: 'call',
            id: 'baseline-edit-' + unit,
            name: 'write_file',
            input: { path: shard.path, expectedHash: shard.baseHash, content: shard.contribution }
          }]);
        }
        const edit = toolResult(sessions.get(baselineWorker.id), 'write_file');
        const sealedSessions = await sendTurn(ctx, baselineWorker.id, token + ' seal ' + unit, [sealAction(token + ' seal ' + unit, edit.revision)]);
        const seal = toolResult(sealedSessions.get(baselineWorker.id), 'seal_submission');
        const commandStart = Date.now();
        const runSessions = await sendTurn(ctx, baselineWorker.id, token + ' run ' + unit, [runAction(INSTALL_COMMAND, token + ' run ' + unit)]);
        const run = toolResult(runSessions.get(baselineWorker.id), 'run_command');
        const commandWallMs = Date.now() - commandStart;
        const driver = parseEmitted(run.output, 'BENCH_RESULT');
        if (run.outcome !== 'succeeded') {
          throw new Error('Baseline unit ' + unit + ' failed: ' + JSON.stringify({ outcome: run.outcome, exitCode: run.exitCode, outputTail: tail(run.output, 800) }));
        }
        if (driver === null || driver.freshBefore !== true || driver.dependencyReal !== true) {
          throw new Error('Baseline unit ' + unit + ' did not install from scratch as a real copied dependency.');
        }
        units.push({
          unit,
          revision: edit.revision,
          sealRevision: seal.revision,
          commandWallMs,
          attemptStartedAt: run.attempt.startedAt,
          completedAt: run.completedAt,
          runnerTotalMs: Date.parse(run.completedAt) - Date.parse(run.attempt.startedAt),
          installMs: driver.install ? driver.install.ms : null,
          buildMs: driver.build ? driver.build.ms : null,
          freshBefore: driver.freshBefore,
          nodeModulesBytes: driver.nodeModules ? driver.nodeModules.bytes : null,
          dependencyLinked: driver.dependencyLinked,
          dependencyInstalledBytes: driver.dependencyTree ? driver.dependencyTree.bytes : null,
          unitWallMs: Date.now() - unitStart
        });
      }
      const baselineWallMs = Date.now() - baselineStart;
      report.sequential = {
        units: units.length,
        spawnMs,
        wallMs: baselineWallMs,
        unitsPerSecond: round(units.length / (baselineWallMs / 1000)),
        commandMsTotal: units.reduce((sum, unit) => sum + unit.commandWallMs, 0),
        installMsTotal: round(units.reduce((sum, unit) => sum + (unit.installMs || 0), 0)),
        perUnit: units
      };
      report.comparison = {
        parallelWallMs,
        sequentialWallMs: baselineWallMs,
        speedup: round(baselineWallMs / parallelWallMs),
        parallelUnitsPerSecond: report.parallel.unitsPerSecond,
        sequentialUnitsPerSecond: report.sequential.unitsPerSecond,
        parallelRunnerRoundMs: roundMs,
        sequentialCommandMsTotal: report.sequential.commandMsTotal,
        runnerSpeedup: round(report.sequential.commandMsTotal / roundMs),
        note: 'Both sides run the same ' + options.workers + ' units (edit, seal, real npm install and build per lease). Only the expensive runner round is concurrent on the parallel side; edit and seal turns are driven one at a time on both sides, so per-worker overlay growth stays attributable.'
      };
    } else {
      report.unavailable.push({ metric: 'sequential', reason: '--baseline none was passed, so no comparable baseline was measured' });
    }

    // --- final storage numbers ----------------------------------------------
    const viewStorage = await census(viewsDirectory);
    const runnerStorage = await census(runnersDirectory);
    const indexFinal = indexFile ? await fs.stat(indexFile).catch(() => null) : null;
    const runnerResults = await ctx.call('subagent_runner_status', { ownerId: OWNER_ID, teamId: team.id, kind: 'results', limit: 20 })
      .catch(() => null);
    report.storage = {
      viewStorageBytes: viewStorage ? viewStorage.bytes : null,
      viewStorageFiles: viewStorage ? viewStorage.files : null,
      viewIndexJsonBytes: indexFinal ? indexFinal.size : null,
      runnerStorageBytes: runnerStorage ? runnerStorage.bytes : null,
      runnerStorageFiles: runnerStorage ? runnerStorage.files : null,
      runnerResultCount: runnerResults && runnerResults.summary && typeof runnerResults.summary.resultCount === 'number'
        ? runnerResults.summary.resultCount
        : null,
      overlayGrowthBytesTotal: report.workers.reduce((sum, worker) => sum + (worker.overlayGrowth && worker.overlayGrowth.bytes !== null ? worker.overlayGrowth.bytes : 0), 0),
      dependencyNodeModulesBytesPerLease: report.workers.length > 0 && report.workers[0].fresh ? report.workers[0].fresh.nodeModulesBytes : null,
      dependencyInstalledBytesPerLease: report.workers.length > 0 && report.workers[0].fresh ? report.workers[0].fresh.dependencyInstalledBytes : null,
      dependencySymlinked: report.workers.length > 0 && report.workers[0].fresh ? report.workers[0].fresh.dependencyLinked : null,
      snapshotManifestJsonBytes: report.snapshot ? report.snapshot.manifestJsonBytes : null
    };
    report.board.errors = state.errors.slice(0, 20);
    report.board.approvals = state.approvals.length;
    report.board.rejectedApprovals = state.approvals.filter(entry => !entry.allowed).length;
    report.board.scriptedModelRequests = state.requests;
    // Routing proof: every prompt was answered from the queue of the worker its
    // own LAST coordinator plain-text turn named, and no historical tool
    // call/result content ever selected a queue.
    report.board.routing = {
      requests: state.requests,
      toolCallsRouted: state.routing.routed,
      turnsFinished: state.routing.finishedTurns,
      distinctTokens: [...state.routing.tokens].sort(),
      policy: 'the last coordinator plain-text turn selects exactly one registered worker token; a missing or ambiguous match fails the turn instead of running another worker\'s queue'
    };
    if (state.errors.length > 0) {
      report.unavailable.push({ metric: 'board.errors', reason: 'the broker reported host errors; see board.errors' });
    }
    report.endToEnd = {
      brokerStartToBeforeCloseMs: Date.now() - startedBroker,
      includes: 'fixture generation is excluded, including the one-time npm pack of the dependency archive (reported separately as project.packMs); the snapshot, per-worker edits and seals, the parallel install round, the freshness probe lease, the whole integration attempt and the sequential baseline are included'
    };
    report.status = 'ok';
  } catch (error) {
    if (error !== null && typeof error === 'object') {
      error.benchmarkReport = report;
    }
    throw error;
  } finally {
    // EVERY constructed broker is closed, including one whose start() rejected.
    // start() opens the private SessionStore (owner.lock), publishes the bridge
    // registration and registers the local root BEFORE its final discovery, so
    // closing only after a resolved start() would leak that lock, registration
    // and any governor reservation for the lifetime of the process. The catch
    // above still rethrows the original failure, so a close error is recorded
    // in cleanup and never replaces the failure evidence.
    const closeStart = Date.now();
    try {
      await broker.close();
      report.cleanup.brokerCloseMs = Date.now() - closeStart;
    } catch (error) {
      report.cleanup.closeError = messageOf(error);
      report.cleanup.brokerCloseMs = Date.now() - closeStart;
      report.status = 'failed';
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function limitations(options) {
  const entries = [
    'The model is scripted: this benchmark measures the workflow machinery (snapshots, overlays, runner leases, installs, integration), not model inference or token throughput.',
    'The generated project is synthetic and deterministic: a representative many-file Node project with a real local file: dependency, not a sample of any real repository.',
    'The dependency is installed from a real local package ARCHIVE that lives inside the fixture, so npm downloads no package bytes and no path outside the fixture is referenced. The archive is packed once during fixture generation (reported as project.packMs) and that preparation is excluded from endToEnd; every lease installs the archive afresh.',
    'A folder file: specifier is deliberately not used: npm 12.2.2 on Windows installs such a folder dependency as a node_modules junction even with --install-links, which is neither a copied install nor measurable. Tarball installs produce a plain copied directory on Windows and POSIX.',
    'Only the manager download cache directory is shared between leases; installed trees and build output are lease-local and never reused.',
    'Runner pool capacity, maxQueue and the resource-governor limits are configured explicitly within the production bounds. No production cap is raised and no code path is bypassed.',
    'Queue wait is derived from benchmark request timestamps and the durable lease createdAt; the scripted-model turn adds a small constant overhead that is included rather than removed.',
    'The producers touch disjoint paths, so this run measures conflict-free integration effort; it never injects merge conflicts.',
    'The parallel round runs before the sequential baseline, so the baseline can benefit from a warmer OS page cache. It never benefits from a reused node_modules tree: every lease proves the tree was absent before install.'
  ];
  if (options.skipApply) {
    entries.push('--skip-apply was passed, so live publication was not measured.');
  }
  return entries;
}

function runtimeProvenance(build, options) {
  // The SAME launch boundary as every other npm call, so the recorded version is
  // what the configured `--npm` really printed - including a Windows executable
  // path that contains spaces. A failure still degrades to `npmVersion: null`.
  const probe = runSyncCapture(options.npm, ['--version'], process.cwd(), 20000);
  const npmVersion = probe.exitCode === 0 && probe.stdout.trim() !== '' ? probe.stdout.trim() : null;
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: Array.isArray(cpus) ? cpus.length : null,
    totalMemoryBytes: os.totalmem(),
    npmCommand: options.npm,
    npmVersion,
    buildDirectory: build.directory,
    runnerCaches: ['npm', 'pip'],
    preparedAt: nowIso()
  };
}

function emitReport(report, options) {
  const text = JSON.stringify(report, null, 2) + '\n';
  process.stdout.write(text);
  if (options.jsonOut) {
    try {
      fsSync.mkdirSync(path.dirname(options.jsonOut), { recursive: true });
      fsSync.writeFileSync(options.jsonOut, text);
      process.stderr.write('Benchmark JSON also written to ' + options.jsonOut + '\n');
    } catch (error) {
      process.stderr.write('Could not write --json-out file: ' + messageOf(error) + '\n');
    }
  }
}

async function main() {
  const processStart = Date.now();
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(messageOf(error) + '\n\n' + usage() + '\n');
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  let build;
  try {
    build = resolveBuild();
  } catch (error) {
    process.stderr.write(messageOf(error) + '\n');
    process.exitCode = 2;
    return;
  }
  process.stderr.write('parallel-workflow: ' + options.workers + ' units, pool capacity ' + options.capacity
    + ', ' + options.files + ' generated files, build ' + build.directory + '\n');
  const artifacts = {
    runtime: runtimeProvenance(build, options),
    limitations: limitations(options)
  };
  let report;
  try {
    report = await runBenchmark(options, build, artifacts);
  } catch (error) {
    report = error && error.benchmarkReport ? error.benchmarkReport : null;
    if (report === null) {
      report = {
        schema: SCHEMA,
        benchmark: BENCHMARK,
        generatedAt: nowIso(),
        status: 'failed',
        invocation: { argv: options.argv, options: { ...options, argv: undefined } },
        runtime: artifacts.runtime,
        limitations: artifacts.limitations,
        definitions: DEFINITIONS,
        cleanup: {},
        unavailable: initialUnavailable()
      };
    }
    report.status = 'failed';
    report.error = {
      message: messageOf(error),
      stack: error instanceof Error ? String(error.stack || '').slice(0, 8000) : null
    };
  }
  const tmpDir = report.cleanup ? report.cleanup.tmpDir : null;
  report.cleanup = report.cleanup || {};
  if (report.status === 'ok' && report.cleanup.closeError === null && !options.keep && tmpDir) {
    try {
      await removeTree(tmpDir);
      report.cleanup.tmpRemoved = true;
      report.cleanup.retainedTmpDir = null;
    } catch (error) {
      report.status = 'failed';
      report.error = { message: 'Could not remove the temporary fixture directory: ' + messageOf(error), stack: null };
      report.cleanup.tmpRemoved = false;
      report.cleanup.retainedTmpDir = tmpDir;
    }
  } else {
    report.cleanup.tmpRemoved = false;
    report.cleanup.retainedTmpDir = tmpDir;
    if (report.status !== 'ok') {
      report.cleanup.retainedForEvidence = 'The temporary fixture directory is kept after a failure so the materialized project, private view store and runner records stay inspectable.';
    } else if (options.keep) {
      report.cleanup.retainedForEvidence = '--keep was passed, so the successful fixture directory was retained.';
    }
  }
  report.endToEnd = { ...(report.endToEnd || {}), processTotalMs: Date.now() - processStart };
  emitReport(report, options);
  if (report.status !== 'ok') {
    process.exitCode = 1;
  }
}

// The CLI runs only when this file is the entry point, so a focused test can
// import the pure ceiling helper, the launch boundary, the census and the
// benchmark entry points without starting a benchmark or resolving a build.
// The lifecycle regression imports runBenchmark itself and injects a broker
// subclass, so it needs no Module._compile or source slicing. Running the file
// directly keeps the exact previous behavior.
if (require.main === module) {
  main().catch(error => {
    process.stderr.write('parallel-workflow failed: ' + messageOf(error) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  effectiveWorkRunnerCeiling,
  executableLaunch,
  runSyncCapture,
  runtimeProvenance,
  benchLibSource,
  census,
  parseArguments,
  resolveBuild,
  runBenchmark
};
