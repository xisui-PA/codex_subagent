const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

// Per-scenario host budget. The `workspace` scenario now also drives the real
// governed parallel workflow: real unsaved-buffer capture, FOUR governed
// workers (two producers on the shared base, one consumer on the composed seed,
// one validation worker) and FOUR real physical-runner commands (check-add,
// check-multiply, the consumer revision and the composed candidate) in a
// capacity-1 pool, plus one publication. `empty` and `locked` are unchanged.
const SCENARIO_TIMEOUT_MS = { workspace: 240_000, empty: 90_000, locked: 90_000 };

/**
 * The scenarios this launcher knows, in canonical order. `CODEX_TEST_SCENARIOS`
 * selects a subset by exact comma-separated names so ONE scenario can be
 * validated inside a bounded command budget instead of always launching all
 * three windows. ONLY an unset value keeps the full set; an explicitly
 * empty value, a duplicate or an unknown name fails before any editor starts.
 */
const KNOWN_SCENARIOS = ['workspace', 'empty', 'locked'];
function selectScenarios(value) {
  if (value === undefined) {
    return [...KNOWN_SCENARIOS];
  }
  const names = value.split(',').map(name => name.trim()).filter(name => name.length > 0);
  if (names.length === 0) {
    throw new Error(`CODEX_TEST_SCENARIOS is set but names no scenario; leave it unset for all, or list: ${KNOWN_SCENARIOS.join(', ')}.`);
  }
  const unknown = names.filter(name => !KNOWN_SCENARIOS.includes(name));
  if (unknown.length) {
    throw new Error(`CODEX_TEST_SCENARIOS names unknown scenario(s) ${unknown.join(', ')}; known scenarios are: ${KNOWN_SCENARIOS.join(', ')}.`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`CODEX_TEST_SCENARIOS repeats a scenario; name each of ${KNOWN_SCENARIOS.join(', ')} at most once.`);
  }
  return KNOWN_SCENARIOS.filter(name => names.includes(name));
}

async function main() {
  // Resolve the selection BEFORE touching the editor, so an invalid selector
  // fails immediately and no window is launched.
  const scenarios = selectScenarios(process.env.CODEX_TEST_SCENARIOS);
  let executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe') : '/usr/share/code/code');
  if (!process.env.VSCODE_EXECUTABLE && process.platform === 'darwin' && !await fs.access(executable).then(() => true, () => false)) { executable = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'; }
  await fs.access(executable).catch(() => { throw new Error('Set VSCODE_EXECUTABLE to an installed VS Code executable. No editor download is performed.'); });
  const repository = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  const extensionId = (manifest.publisher + '.' + manifest.name).toLowerCase();
  // macOS Unix sockets have a 103-character path limit; its default TMPDIR is long.
  const temporary = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cw-host-'));
  try {
    for (const scenario of scenarios) {
      const profile = path.join(temporary, scenario); const workspace = path.join(profile, 'project');
      await fs.mkdir(workspace, { recursive: true });
      if (scenario === 'locked') {
        const real = await fs.realpath(workspace);
        const hash = createHash('sha256').update(JSON.stringify(['root', real])).digest('hex').slice(0, 32);
        const store = path.join(profile, 'user-data', 'User', 'globalStorage', extensionId, 'workspaces', hash);
        await fs.mkdir(store, { recursive: true });
        await fs.writeFile(path.join(store, 'owner.lock'), JSON.stringify({ pid: process.pid, nonce: 'test-owner' }));
      }
      const env = { ...process.env, CODEX_HOME: path.join(profile, 'codex'), CODEX_TEST_SCENARIO: scenario, CODEX_TEST_REPOSITORY: repository, CODEX_TEST_WORKSPACE: workspace };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = ['--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions', '--no-sandbox', `--user-data-dir=${path.join(profile, 'user-data')}`, `--extensions-dir=${path.join(profile, 'extensions')}`, `--extensionDevelopmentPath=${repository}`, `--extensionTestsPath=${path.join(__dirname, 'host', 'index.cjs')}`];
      if (scenario !== 'empty') { args.push(workspace); }
      await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; let timedOut = false; let grace;
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
        // A timeout STOPS the owned host and the failure is reported only once it
        // has exited (or its bounded drain went unobserved): a killed host is
        // never reported as a pass, and no owned child is left behind silently.
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          grace = setTimeout(() => reject(new Error(`VS Code host test timed out (${scenario}) and its owned host did not exit.\n${output.slice(-12000)}`)), 20_000);
        }, SCENARIO_TIMEOUT_MS[scenario] ?? 90_000);
        child.on('error', error => { clearTimeout(timer); clearTimeout(grace); reject(error); });
        child.on('exit', (code, signal) => {
          clearTimeout(timer); clearTimeout(grace);
          if (!timedOut && code === 0 && output.includes(`HOST_TEST_PASS:${scenario}`)) { process.stdout.write(`VS Code extension host: ${scenario} passed\n`); resolve(); return; }
          reject(new Error(timedOut
            ? `VS Code host test timed out (${scenario}); the owned host exited (code ${code}, signal ${signal}).\n${output.slice(-12000)}`
            : `Host scenario ${scenario} failed (${code}).\n${output.slice(-16000)}`));
        });
      });
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 }).catch(error => console.error('Could not remove the temporary host directory: ' + error.message)); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
