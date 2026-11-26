'use strict';

/**
 * Focused regression for `benchmarks/parallel-workflow.cjs`.
 *
 * `pool.effectiveConcurrentWorkRunners` is the CONFIGURED ceiling on
 * concurrently running work commands, so it must obey BOTH governor limits
 * documented in `src/resource-governor.ts`: the local one
 * (`capacity - (capacity > 1 ? 1 : 0)`) and the aggregate one
 * (`runnerCapacity - serviceReserve`). Only the smaller wins, and a single local
 * slot keeps its one slot. The script must also stay importable and keep its
 * `--help` path free of build resolution or benchmark startup.
 *
 * Nothing here runs a benchmark, installs a package or needs a compiled build.
 *
 * The `--npm` launch boundary is covered by REAL child processes: a probe
 * executable whose own path contains a space (a `.cmd` shim on Windows, an
 * executable shell script on POSIX) prints the argv it actually received, so a
 * quoting regression changes observed bytes instead of a source string.
 */

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.resolve(__dirname, '..', 'benchmarks', 'parallel-workflow.cjs');
const missingBuild = path.join(os.tmpdir(), 'bench-missing-test-build');
const { effectiveWorkRunnerCeiling, executableLaunch, runSyncCapture, runtimeProvenance, benchLibSource, census } = require(script);
const fs = require('node:fs');
const fsp = require('node:fs/promises');

/** Governor defaults: 4 aggregate runner slots with 1 reserved for service. */
const defaults = { runnerCapacity: 4, serviceReserve: 1 };

/**
 * A REAL executable inside a directory whose path contains a space. It prints
 * the argv it actually received, so quoting is observed rather than assumed:
 * on Windows a `.cmd` shim (the same reason the real npm needs a shell, because
 * a `.cmd` is not a spawnable image) and on POSIX an executable shell script.
 */
async function spacedProbe(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench spaced probe '));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined));
  const reporter = path.join(directory, 'echo-argv.cjs');
  await fsp.writeFile(reporter, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
  if (process.platform === 'win32') {
    const file = path.join(directory, 'npm probe.cmd');
    await fsp.writeFile(file, '@echo off\r\n"' + process.execPath + '" "' + reporter + '" %*\r\n', 'utf8');
    return file;
  }
  const file = path.join(directory, 'npm probe');
  await fsp.writeFile(file, '#!/bin/sh\nexec "' + process.execPath + '" "' + reporter + '" "$@"\n', 'utf8');
  await fsp.chmod(file, 0o755);
  return file;
}

/** The generated lease library, written from benchLibSource() and required. */
async function generatedLibrary(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-generated-lib-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined));
  const file = path.join(directory, 'bench-lib.cjs');
  await fsp.writeFile(file, benchLibSource(), 'utf8');
  return { directory, generated: require(file) };
}

test('runSyncCapture runs an executable path with spaces and keeps its argv', { timeout: 60_000 }, async t => {
  const probe = await spacedProbe(t);
  assert.ok(probe.includes(' '), 'the executable path really contains a space');
  const result = runSyncCapture(probe, ['pack', 'a b', '--loglevel=error'], os.tmpdir(), 30_000);
  assert.equal(result.exitCode, 0, result.stderr || result.error);
  assert.deepEqual(JSON.parse(result.stdout), ['pack', 'a b', '--loglevel=error'],
    'the executable ran and every argument kept its exact boundary');
});

test('the generated lease library captures a spaced executable path identically', { timeout: 60_000 }, async t => {
  const probe = await spacedProbe(t);
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-generated-lib-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined));
  const file = path.join(directory, 'bench-lib.cjs');
  await fsp.writeFile(file, benchLibSource(), 'utf8');
  const generated = require(file);
  assert.equal(typeof generated.runCapture, 'function');
  assert.equal(typeof generated.executableLaunch, 'function');

  // The generated helper is embedded from the driver, so both must take the SAME
  // decision on every platform instead of drifting apart.
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(generated.executableLaunch(probe, ['install', 'x y'], platform),
      executableLaunch(probe, ['install', 'x y'], platform), 'launch parity on ' + platform);
  }
  const posix = generated.executableLaunch(probe, ['a b'], 'linux');
  assert.equal(posix.shell, false, 'POSIX never goes through a shell');
  assert.deepEqual(posix.args, ['a b'], 'POSIX keeps the argument array intact');
  const windows = generated.executableLaunch(probe, ['a b'], 'win32');
  assert.equal(windows.shell, true, 'a Windows shim needs the command interpreter');
  assert.deepEqual(windows.args, [], 'Windows passes one command line, never an unquoted array');
  assert.ok(windows.file.startsWith('"' + probe + '"'), 'the whole executable path is ONE quoted token');
  assert.ok(windows.file.endsWith('"a b"'), 'an argument with a space is quoted, never split');

  // ...and a real child process through the GENERATED capture path.
  const run = await generated.runCapture(probe, ['install', 'x y'], directory);
  assert.equal(run.exitCode, 0, run.stderr || run.spawnError);
  assert.deepEqual(JSON.parse(run.stdout), ['install', 'x y']);
});

test('runtimeProvenance records the configured executable path with spaces', { timeout: 60_000 }, async t => {
  const probe = await spacedProbe(t);
  const provenance = runtimeProvenance({ directory: 'unused-by-this-probe' }, { npm: probe });
  assert.equal(provenance.npmCommand, probe, 'the configured path is reported verbatim');
  assert.equal(provenance.npmVersion, JSON.stringify(['--version']),
    'the reported version comes from the configured executable, not from a bare npm on PATH');
  assert.equal(provenance.platform, process.platform);
});

const nativeNpmCmd = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'npm.cmd') : null;
const nativeNpmAvailable = nativeNpmCmd !== null && fs.existsSync(nativeNpmCmd);

test('the native Windows npm.cmd absolute path runs where Node is installed',
  { timeout: 120_000, skip: nativeNpmAvailable ? false : 'no npm.cmd next to the running node.exe' }, () => {
    // The reported repro: the standard Windows Node install directory contains a
    // space, so this vendor path used to be split at 'C:\Program'.
    assert.ok(path.isAbsolute(nativeNpmCmd));
    const result = runSyncCapture(nativeNpmCmd, ['--version'], process.cwd(), 90_000);
    assert.equal(result.exitCode, 0, result.stderr || result.error);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/, 'the configured npm really printed its version');
    assert.equal(runtimeProvenance({ directory: 'unused-by-this-probe' }, { npm: nativeNpmCmd }).npmVersion,
      result.stdout.trim(), 'provenance reports exactly what that path printed');
  });

/**
 * Tokens that used to be mangled at the Windows launch boundary: an EMPTY
 * argument used to vanish, and a backslash left before the closing quote used to
 * be turned into a literal quote. Each case is checked against a REAL child
 * process in both shapes that exist: the executable itself (`process.execPath`,
 * a real .exe that parses its own command line) and a shim executable whose
 * `%*` re-expands the raw argument text, driven through the GENERATED capture.
 */
const WINDOWS_SEP = String.fromCharCode(92); // no escaped paths in this file
const ARGV_CASES = ['', 'plain', 'a b', 'a b' + WINDOWS_SEP, 'a"b', 'x&y', ['C:', 'Program Files', 'dir', ''].join(WINDOWS_SEP)];
const EXE_ARGV_REPORT = 'process.stdout.write(JSON.stringify(process.argv.slice(1)));';

test('empty and trailing-backslash argv survive the .exe and the generated shim', { timeout: 120_000 }, async t => {
  const shim = await spacedProbe(t);
  const { directory, generated } = await generatedLibrary(t);
  for (const argument of ARGV_CASES) {
    // 1. A real .exe. `node -e <report> -- <arg>` consumes the `--`, so
    //    argv.slice(1) is exactly the argument list this launch produced.
    const exe = runSyncCapture(process.execPath, ['-e', EXE_ARGV_REPORT, '--', argument], directory, 30_000);
    assert.equal(exe.exitCode, 0, JSON.stringify({ argument, stderr: exe.stderr.slice(-400) }));
    assert.deepEqual(JSON.parse(exe.stdout), [argument], 'the .exe received ' + JSON.stringify(argument));

    // 2. The GENERATED capture path through the shim, so the embedded helper -
    //    not the driver copy - is what builds this command line.
    const viaShim = await generated.runCapture(shim, [argument], directory);
    assert.equal(viaShim.exitCode, 0, JSON.stringify({ argument, stderr: viaShim.stderr.slice(-400) }));
    assert.deepEqual(JSON.parse(viaShim.stdout), [argument], 'the shim received ' + JSON.stringify(argument));
  }
});

test('the real npm argument lists keep their exact Windows launch line', () => {
  // These are the benchmark's own constants (PACK_FLAGS, INSTALL_FLAGS and the
  // provenance probe), so the corrected quoting must not rewrite any of them.
  const npmCmd = ['C:', 'Program Files', 'nodejs', 'npm.cmd'].join(WINDOWS_SEP);
  const cases = [
    [['--version'], '"' + npmCmd + '" --version'],
    [['pack', './local-fixture', '--offline', '--ignore-scripts', '--loglevel=error'],
      '"' + npmCmd + '" pack ./local-fixture --offline --ignore-scripts --loglevel=error'],
    [['install', '--no-audit', '--no-fund', '--no-package-lock', '--offline', '--ignore-scripts', '--loglevel=error'],
      '"' + npmCmd + '" install --no-audit --no-fund --no-package-lock --offline --ignore-scripts --loglevel=error']
  ];
  for (const [args, expected] of cases) {
    assert.equal(executableLaunch(npmCmd, args, 'win32').file, expected);
  }
  // The bare default still resolves through the shell, and POSIX is untouched.
  assert.equal(executableLaunch('npm', ['--version'], 'win32').file, 'npm --version');
  assert.deepEqual(executableLaunch(npmCmd, ['--version'], 'linux'),
    { file: npmCmd, args: ['--version'], shell: false });
});

test('the default governor configuration yields one ceiling per pool capacity', () => {
  const ceilings = [];
  for (let capacity = 1; capacity <= 8; capacity += 1) {
    ceilings.push(effectiveWorkRunnerCeiling(capacity, defaults));
  }
  assert.deepEqual(ceilings, [1, 1, 2, 3, 3, 3, 3, 3]);
});

test('the ceiling follows the smaller of the local and aggregate work limits', () => {
  // The local ceiling wins while the aggregate budget is wider.
  assert.equal(effectiveWorkRunnerCeiling(4, { runnerCapacity: 8, serviceReserve: 1 }), 3);
  // A lower aggregate budget wins over a wide local pool.
  assert.equal(effectiveWorkRunnerCeiling(8, { runnerCapacity: 2, serviceReserve: 1 }), 1);
  // Both ceilings agree at the default 4/1 configuration.
  assert.equal(effectiveWorkRunnerCeiling(4, defaults), 3);
  // The one-slot exception: capacity 1 keeps its only local slot.
  assert.equal(effectiveWorkRunnerCeiling(1, { runnerCapacity: 8, serviceReserve: 1 }), 1);
  // The reserve never drives the ceiling to zero.
  assert.equal(effectiveWorkRunnerCeiling(2, { runnerCapacity: 2, serviceReserve: 1 }), 1);
});

test('importing the script does not start a benchmark', () => {
  const probe = spawnSync(process.execPath, ['-e', 'require(process.argv[1]); process.stdout.write("loaded");', script], {
    encoding: 'utf8',
    // A missing build makes any accidental startup fail immediately and loudly.
    env: { ...process.env, BENCH_TEST_BUILD: missingBuild },
    timeout: 10_000
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, 'loaded');
  assert.equal(probe.stderr, '');
});

test('--help prints usage and exits without a compiled build', () => {
  const help = spawnSync(process.execPath, [script, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, BENCH_TEST_BUILD: missingBuild },
    timeout: 10_000
  });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /^Usage: node benchmarks\/parallel-workflow\.cjs \[options\]/);
  assert.match(help.stdout, /--capacity <n>/);
  assert.match(help.stdout, /--workers <n>/);
});
/**
 * Census regressions: `census()` may treat ONLY an absent root as zero and must
 * propagate every other read failure. A swallowed readdir error used to turn a
 * failed walk into a smaller (or zero) measurement, and a swallowed stat error
 * silently dropped a listed file's bytes.
 */
const uniq = value => path.resolve(value).toLowerCase();
const at = target => value => uniq(String(value)) === uniq(target);

async function censusFixture(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-census-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => undefined));
  const root = path.join(base, 'tree');
  const empty = path.join(base, 'empty');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.mkdir(path.join(root, 'sub2', 'deep'), { recursive: true });
  await fsp.mkdir(empty, { recursive: true });
  await fsp.writeFile(path.join(root, 'a.txt'), 'aaaaa'); // 5 bytes
  await fsp.writeFile(path.join(root, 'sub', 'b.txt'), 'bbb'); // 3 bytes
  await fsp.writeFile(path.join(root, 'sub2', 'deep', 'c.txt'), 'ccccccc'); // 7 bytes
  return { base, root, empty };
}

/** Run one action with a single temporarily faulted `fs.promises` call. */
async function withFsFault(fault, action) {
  const realReaddir = fsp.readdir;
  const realStat = fsp.stat;
  const injected = { readdir: 0, stat: 0 };
  // `fault.code` lets one case inject ENOENT, which must be handled like any
  // other failure everywhere except at the census root.
  const deny = target => {
    const code = fault.code || 'EPERM';
    const error = new Error(code + ': simulated read failure, ' + String(target));
    error.code = code;
    return error;
  };
  if (fault.readdir) {
    fsp.readdir = async (target, options) => {
      if (fault.readdir(String(target))) {
        injected.readdir += 1;
        throw deny(target);
      }
      return realReaddir.call(fsp, target, options);
    };
  }
  if (fault.stat) {
    fsp.stat = async (target, options) => {
      if (fault.stat(String(target))) {
        injected.stat += 1;
        throw deny(target);
      }
      return realStat.call(fsp, target, options);
    };
  }
  try {
    return { value: await action(), error: null, injected };
  } catch (error) {
    return { value: null, error, injected };
  } finally {
    fsp.readdir = realReaddir;
    fsp.stat = realStat;
  }
}

/** The GENERATED lease library, written from benchLibSource() and required. */
async function generatedCensus(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-census-lib-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined));
  const file = path.join(directory, 'bench-lib.cjs');
  await fsp.writeFile(file, benchLibSource(), 'utf8');
  return require(file);
}

test('census allows only an absent root and propagates root, nested and stat failures', { timeout: 20_000 }, async t => {
  const { base, root, empty } = await censusFixture(t);
  assert.deepEqual(await census(root), { bytes: 15, files: 3, directories: 3 });
  assert.deepEqual(await census(empty), { bytes: 0, files: 0, directories: 0 });
  // Pre-snapshot/runner setup censuses directories a later step still creates.
  assert.deepEqual(await census(path.join(base, 'absent')), { bytes: 0, files: 0, directories: 0 });
  assert.equal(await census(null), null, 'an absent directory argument stays null');

  const rootFault = await withFsFault({ readdir: at(root) }, () => census(root));
  assert.equal(rootFault.value, null, 'a failed root walk must not return totals');
  assert.equal(rootFault.error && rootFault.error.code, 'EPERM', 'root EPERM propagates instead of reading as zero');
  assert.equal(rootFault.injected.readdir, 1);

  const subFault = await withFsFault({ readdir: at(path.join(root, 'sub2')) }, () => census(root));
  assert.equal(subFault.value, null);
  assert.equal(subFault.error && subFault.error.code, 'EPERM', 'an unreadable nested directory propagates');

  const statFault = await withFsFault({ stat: at(path.join(root, 'sub', 'b.txt')) }, () => census(root));
  assert.equal(statFault.value, null);
  assert.equal(statFault.error && statFault.error.code, 'EPERM', 'a failing stat of a listed file propagates');

  // The exception is ROOT ONLY: the same ENOENT below the root means a
  // vanished directory or file, not an absent tree, so it must propagate too.
  const rootEnoent = await withFsFault({ readdir: at(root), code: 'ENOENT' }, () => census(root));
  assert.equal(rootEnoent.error, null, 'a root ENOENT is the allowed absent tree');
  assert.deepEqual(rootEnoent.value, { bytes: 0, files: 0, directories: 0 });
  const nestedEnoent = await withFsFault({ readdir: at(path.join(root, 'sub2')), code: 'ENOENT' }, () => census(root));
  assert.equal(nestedEnoent.value, null, 'a nested ENOENT must not read as an empty tree');
  assert.equal(nestedEnoent.error && nestedEnoent.error.code, 'ENOENT');
  const statEnoent = await withFsFault({ stat: at(path.join(root, 'sub', 'b.txt')), code: 'ENOENT' }, () => census(root));
  assert.equal(statEnoent.value, null, 'a listed file that disappears must not be dropped');
  assert.equal(statEnoent.error && statEnoent.error.code, 'ENOENT');
});

test('the generated lease census keeps its exclusions and propagates read failures', { timeout: 20_000 }, async t => {
  const { base, root } = await censusFixture(t);
  const generated = await generatedCensus(t);
  await fsp.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fsp.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), '0123456789');

  assert.deepEqual(await generated.census(root), { bytes: 25, files: 4 });
  assert.deepEqual(await generated.census(root, new Set(['node_modules'])), { bytes: 15, files: 3 },
    'the ephemeral exclusion is unchanged');
  assert.deepEqual(await generated.census(path.join(base, 'absent')), { bytes: 0, files: 0 });

  // ONLY the inability of this host to create a symlink is tolerated. The
  // census assertion runs OUTSIDE that catch, so a real wrong count can never
  // be reported as "not exercised", and any unexpected creation error is
  // rethrown.
  let symlinkCreated = false;
  try {
    await fsp.symlink(path.join(root, 'a.txt'), path.join(root, 'link.txt'));
    symlinkCreated = true;
  } catch (error) {
    if (!error || !['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      throw error;
    }
    t.diagnostic('symlink exclusion not exercised on this host: creating a symlink failed with ' + error.code);
  }
  if (symlinkCreated) {
    // The deliberate symlink exclusion is unchanged: the link is not counted.
    assert.deepEqual(await generated.census(root), { bytes: 25, files: 4 }, 'a symlinked file stays excluded');
  }

  const rootFault = await withFsFault({ readdir: at(root) }, () => generated.census(root));
  assert.equal(rootFault.value, null);
  assert.equal(rootFault.error && rootFault.error.code, 'EPERM', 'generated root EPERM propagates');
  const nestedFault = await withFsFault({ readdir: at(path.join(root, 'sub2')) }, () => generated.census(root));
  assert.equal(nestedFault.value, null);
  assert.equal(nestedFault.error && nestedFault.error.code, 'EPERM', 'generated nested EPERM propagates');
  const statFault = await withFsFault({ stat: at(path.join(root, 'sub', 'b.txt')) }, () => generated.census(root));
  assert.equal(statFault.value, null);
  assert.equal(statFault.error && statFault.error.code, 'EPERM', 'generated stat EPERM propagates');
  // Root-only again: a nested ENOENT or a vanished listed file propagates.
  const rootEnoent = await withFsFault({ readdir: at(root), code: 'ENOENT' }, () => generated.census(root));
  assert.equal(rootEnoent.error, null, 'a root ENOENT is the allowed absent tree');
  assert.deepEqual(rootEnoent.value, { bytes: 0, files: 0 });
  const nestedEnoent = await withFsFault({ readdir: at(path.join(root, 'sub2')), code: 'ENOENT' }, () => generated.census(root));
  assert.equal(nestedEnoent.value, null, 'a generated nested ENOENT is not an empty tree');
  assert.equal(nestedEnoent.error && nestedEnoent.error.code, 'ENOENT');
  const statEnoent = await withFsFault({ stat: at(path.join(root, 'sub', 'b.txt')), code: 'ENOENT' }, () => generated.census(root));
  assert.equal(statEnoent.value, null, 'a generated stat ENOENT is not a dropped file');
  assert.equal(statEnoent.error && statEnoent.error.code, 'ENOENT');
});
