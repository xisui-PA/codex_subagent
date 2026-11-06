const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

async function main() {
  let executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe') : '/usr/share/code/code');
  if (!process.env.VSCODE_EXECUTABLE && process.platform === 'darwin' && !await fs.access(executable).then(() => true, () => false)) { executable = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'; }
  await fs.access(executable).catch(() => { throw new Error('Set VSCODE_EXECUTABLE to an installed VS Code executable. No editor download is performed.'); });
  const repository = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  const extensionId = (manifest.publisher + '.' + manifest.name).toLowerCase();
  // macOS Unix sockets have a 103-character path limit; its default TMPDIR is long.
  const temporary = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cw-host-'));
  try {
    for (const scenario of ['workspace', 'empty', 'locked']) {
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
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`VS Code host test timed out (${scenario}).\n${output.slice(-12000)}`)); }, 90_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); if (code === 0 && output.includes(`HOST_TEST_PASS:${scenario}`)) { process.stdout.write(`VS Code extension host: ${scenario} passed\n`); resolve(); } else { reject(new Error(`Host scenario ${scenario} failed (${code}).\n${output.slice(-16000)}`)); } });
      });
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
