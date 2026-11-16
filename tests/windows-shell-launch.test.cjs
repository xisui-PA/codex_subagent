'use strict';
// Regression: the Windows legacy shell transport (run_command) must hand an
// approved command to cmd.exe UNCHANGED.
//
// Root cause of the reported GUI dialog: the spawn used
//   spawn(ComSpec, ['/d', '/s', '/c', command], { ... })
// with neither `windowsVerbatimArguments` nor an outer-quoted command, so Node
// applied its C-runtime argument escaping and prefixed the command's own quotes
// with backslashes. cmd.exe does not use CRT parsing, so `start "" /b app`
// arrived as `start \"\" /b app`: `start` then saw a program named `\` and
// Windows reported it could not be found (and could pop a GUI error dialog).
//
// Node's own convention (child_process normalizeSpawnArguments) is a single
// quoted `/d /s /c` argument plus windowsVerbatimArguments for cmd.exe; that is
// what shellLaunchSpec emits. Every spawn below is MOCKED: no shell, no
// START, no ShellExecute and no window is ever created by the contract tests.
// Only the last test runs real, harmless cmd builtins (echo/node) through the
// public FileTools API, with windowsHide so no console window appears.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');

// This suite may point at a dedicated compile; the default is the shared build
// the rest of the unit suite uses.
const buildDir = path.join(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { FileTools, shellLaunchSpec } = require(path.join(buildDir, 'workspace-tools'));
if (typeof FileTools !== 'function' || typeof shellLaunchSpec !== 'function') {
  throw new Error(`stale or incomplete workspace-tools build at ${buildDir}`);
}

const WINDOWS = process.platform === 'win32';
const TEST_TIMEOUT = 60_000;
const signal = () => new AbortController().signal;

/** Bounded wait so a missing mock event can never hang the suite. */
function bounded(promise, milliseconds, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`unbounded wait: ${label}`)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-shell-launch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => undefined));
  return root;
}

function makeTools(root, overrides = {}) {
  return FileTools.create([root], {
    canWrite: () => true,
    allowShell: () => true,
    approveCommand: async () => true,
    ...overrides
  });
}

/**
 * Replace child_process.spawn for the duration of one call. The replacement
 * NEVER starts a process, so a mocked test cannot fall through to a real
 * launcher (no shell, no START, no window). The real function is restored in a
 * finally, and every child is driven explicitly so the production promise
 * settles from realistic stdout/close events.
 */
async function withMockedSpawn(t, run) {
  const realSpawn = childProcess.spawn;
  const calls = [];
  const children = [];
  childProcess.spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = undefined;                 // no OS process exists
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    calls.push({ file, args, options });
    children.push(child);
    return child;
  };
  try {
    return await run({ calls, children });
  } finally {
    childProcess.spawn = realSpawn;
    assert.equal(childProcess.spawn, realSpawn, 'the real spawn must always be restored');
  }
}

/** Drive one fake child to completion with output, then 'close'. */
function settleFake(child, output = 'probe-output\r\n', code = 0) {
  child.stdout.write(output);
  child.stdout.end();
  child.stderr.end();
  process.nextTick(() => child.emit('close', code, null));
}

// FileTools actually dispatches on process.platform, so this contract test is
// meaningful only where the Windows branch really runs: elsewhere the platform
// dispatch would launch /bin/sh and the cmd.exe assertions would be wrong.
test('the Windows launch is ONE quoted /d /s /c argument, verbatim and hidden',
  { timeout: TEST_TIMEOUT, skip: WINDOWS ? false : 'Windows cmd.exe transport only' }, async t => {
  const root = await tempRoot(t);
  const tools = await makeTools(root);
  const command = 'start "" /b node tools\\slow.cjs --flag "a b"';

  const { calls } = await withMockedSpawn(t, async recorded => {
    const pending = tools.execute('run_command', { command }, 'workspace-write', signal());
    // The launch happens after resolve/stat/approval await points, so poll for
    // it instead of assuming one tick, and stay bounded.
    const deadline = Date.now() + 10_000;
    while (recorded.children.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(recorded.children.length, 1, 'exactly one launch for one approved command');
    settleFake(recorded.children[0]);
    const result = JSON.parse(await bounded(pending, 10_000, 'mocked run_command'));
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /probe-output/);
    return recorded;
  });

  const [call] = calls;
  assert.equal(call.file, process.env.ComSpec || 'cmd.exe', 'the configured ComSpec stays authoritative');
  assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(call.args.length, 4, 'the whole command is a single argument');

  // The committed regression: the formerly-bad command must reach cmd with its
  // own quotes intact and NO backslash inserted in front of them.
  assert.equal(call.args[3], `"${command}"`);
  assert.equal(call.args[3].slice(1, -1), command, 'the approved command is never rewritten');
  assert.ok(!call.args[3].includes('\\"'), 'Node must not CRT-escape the quotes of a cmd.exe command');
  assert.match(call.args[3], /start "" \/b node/, 'start keeps its empty title argument');

  // Node's documented CMD convention, plus a hidden console.
  assert.equal(call.options.windowsVerbatimArguments, true);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, false);
  assert.equal(call.options.cwd, await fs.realpath(root));
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('shellLaunchSpec keeps the POSIX launch and a non-CMD ComSpec unchanged', async () => {
  const command = 'echo "a b" | cat > out.txt';

  // POSIX: same /bin/sh detach, no Windows-only options at all.
  const posix = shellLaunchSpec(command, 'linux');
  assert.equal(posix.file, '/bin/sh');
  assert.deepEqual(posix.args, ['-c', command]);
  assert.deepEqual(posix.options, { detached: true });

  // cmd.exe by path and by upper-case name: quoted + verbatim + hidden.
  for (const comspec of ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\CMD.EXE', 'cmd.exe']) {
    const spec = shellLaunchSpec(command, 'win32', comspec);
    assert.equal(spec.file, comspec);
    assert.deepEqual(spec.args, ['/d', '/s', '/c', `"${command}"`]);
    assert.equal(spec.options.windowsVerbatimArguments, true);
    assert.equal(spec.options.windowsHide, true);
    assert.equal(spec.options.detached, false);
  }

  // A non-CMD ComSpec keeps the previous unquoted form (cmd switches are
  // cmd-specific) but still never creates a console window.
  const foreign = shellLaunchSpec(command, 'win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.deepEqual(foreign.args, ['/d', '/s', '/c', command]);
  assert.equal(foreign.options.windowsVerbatimArguments, undefined);
  assert.equal(foreign.options.windowsHide, true);

  // An empty ComSpec falls back to cmd.exe, exactly like the previous code.
  assert.equal(shellLaunchSpec(command, 'win32', '').file, 'cmd.exe');
});

test('no launch happens without approval, without the shell flag, or after revocation', { timeout: TEST_TIMEOUT }, async t => {
  const root = await tempRoot(t);

  await withMockedSpawn(t, async recorded => {
    const denied = await makeTools(root, { approveCommand: async () => false });
    await assert.rejects(denied.execute('run_command', { command: 'echo hi' }, 'workspace-write', signal()),
      { code: 'command_denied' });

    const noShell = await makeTools(root, { allowShell: () => false });
    await assert.rejects(noShell.execute('run_command', { command: 'echo hi' }, 'workspace-write', signal()),
      { code: 'permission_denied' });

    // Approval is granted, then the live policy is revoked while the dialog was
    // conceptually open: confirmShell() must still block the launch.
    const revoked = new Error('model_unavailable');
    const live = await makeTools(root);
    await assert.rejects(live.execute('run_command', { command: 'echo hi' }, 'workspace-write', signal(), undefined,
      () => { throw revoked; }), /model_unavailable/);

    // read-only permission is refused before approval, too.
    await assert.rejects(live.execute('run_command', { command: 'echo hi' }, 'read-only', signal()),
      { code: 'permission_denied' });

    assert.deepEqual(recorded.calls, [], 'no shell may be started on any refusal path');
    assert.deepEqual(recorded.children, []);
  });
});

// A real, harmless cmd probe through the public API: this is the end-to-end
// proof that quoted commands now arrive unchanged (echo is a cmd builtin; node
// is already running this suite). Nothing here uses START or a GUI launcher.
test('real cmd.exe receives quotes, spaced paths, empty args and metacharacters unchanged', { timeout: TEST_TIMEOUT, skip: WINDOWS ? false : 'Windows cmd.exe transport only' }, async t => {
  const root = await tempRoot(t);
  const spaced = path.join(root, 'with space');
  await fs.mkdir(spaced);
  const probeSource = 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n';
  await fs.writeFile(path.join(spaced, 'probe.cjs'), probeSource, 'utf8');
  const tools = await makeTools(root);
  const run = async (command, options = {}) => {
    const result = JSON.parse(await bounded(tools.execute('run_command', { command, ...options }, 'workspace-write', signal()),
      30_000, command));
    assert.equal(result.exitCode, 0, `${command}: ${result.output}`);
    return result;
  };

  // 1. A QUOTED absolute executable path, a QUOTED absolute script path, quoted
  //    arguments and an empty argument all survive exactly, run from an approved
  //    cwd that itself contains a space. A command that starts with a quoted
  //    program path is the case a naive quote/escape rewrite breaks first.
  const quotedProbe = `"${process.execPath}" "${path.join(spaced, 'probe.cjs')}" "spaced arg" ""`;
  assert.ok(quotedProbe.startsWith(`"${process.execPath}"`), 'the command begins with a quoted executable path');
  const argvProbe = await run(quotedProbe, { path: 'with space' });
  const report = JSON.parse(argvProbe.output);
  assert.deepEqual(report.argv, ['spaced arg', ''], 'quotes and the empty argument arrive unchanged');
  assert.equal(path.basename(report.cwd), 'with space', 'the approved cwd with a space is used verbatim');

  // 2. Nested quotes in an inline node program (the case that previously
  //    collected stray backslashes).
  const nested = await run('node -e "process.stdout.write(\'nested-ok\')"');
  assert.equal(nested.output.trim(), 'nested-ok');

  // 3. A quoted echo plus redirection: the file must contain the quotes and no
  //    backslash, which is precisely what the broken transport corrupted.
  await run('echo "a b" > quoted.txt');
  assert.equal(await fs.readFile(path.join(root, 'quoted.txt'), 'utf8').then(text => text.trim()), '"a b"');

  // 4. Pipes and redirection are preserved metacharacters, not escaped.
  await run('echo piped | findstr piped > piped.txt');
  assert.match(await fs.readFile(path.join(root, 'piped.txt'), 'utf8'), /piped/);

  // 5. Percent expansion still happens in cmd (the command is not sanitized).
  await run('echo %ComSpec% > comspec.txt');
  assert.match((await fs.readFile(path.join(root, 'comspec.txt'), 'utf8')).toLowerCase(), /cmd/);
});
