import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { atomicWrite } from './storage';
import { WorkerError } from './types';

const begin = '# BEGIN codex-subagent managed MCP';
const end = '# END codex-subagent managed MCP';
export function configuration(existing: string, executable: string, relay: string, registry: string, remove = false): string {
  parse(existing);
  const start = existing.indexOf(begin);
  const finish = existing.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start) || (start >= 0 && existing.indexOf(begin, start + begin.length) >= 0)) {
    throw new WorkerError('config_conflict', 'Managed MCP markers are damaged. Repair them before registering.');
  }
  const blockStart = start > 0 && existing[start - 1] === '\n' && (start === 1 || existing[start - 2] === '\n') ? start - 1 : start;
  let base = start < 0 ? existing : existing.slice(0, blockStart) + existing.slice(finish + end.length).replace(/^\r?\n/, '');
  const parsed = parse(base) as { mcp_servers?: Record<string, unknown> };
  if (parsed.mcp_servers?.codex_subagent) {
    throw new WorkerError('config_conflict', 'An unmanaged mcp_servers.codex_subagent entry already exists. Rename or remove it first.');
  }
  if (remove) {
    return base;
  }
  // JSON basic strings are valid TOML basic strings for these paths.
  const quote = (text: string): string => JSON.stringify(text);
  base += `${base.endsWith('\n') || !base ? '' : '\n'}\n${begin}\n[mcp_servers.codex_subagent]\ncommand = ${quote(executable)}\nargs = [${quote(relay)}, "--registry", ${quote(registry)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nstartup_timeout_sec = 10\ntool_timeout_sec = 45\n${end}\n`;
  parse(base);
  return base;
}
export async function register(file: string, executable: string, relay: string, registry: string, remove = false): Promise<void> {
  // Preserve dotfiles symlinks and lock the actual target, including when two
  // windows refer to it through different paths.
  try {
    file = await fs.realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    if ((await fs.lstat(file).catch(() => undefined))?.isSymbolicLink()) {
      throw new WorkerError('config_conflict', 'Codex config is a broken symlink. Repair its target before setup.');
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Serialize registration across windows; never clobber a concurrent setup command.
  const lock = `${file}.codex-subagent.lock`;
  const handle = await fs.open(lock, 'wx', 0o600).catch(() => {
    throw new WorkerError('config_locked', `Config registration is locked: ${lock}. If a setup command crashed, remove this lock and try again.`);
  });
  try {
    const existing = await fs.readFile(file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      } throw error;
    });
    const updated = configuration(existing, executable, relay, registry, remove);
    if (updated === existing) {
      return;
    }
    if (existing) {
      await atomicWrite(`${file}.codex-subagent.bak`, existing);
    }
    // Detect edits from other tools made while we prepared the update.
    const current = await fs.readFile(file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      } throw error;
    });
    if (current !== existing) {
      throw new WorkerError('config_conflict', 'Codex config changed during setup. Run the command again.');
    }
    await atomicWrite(file, updated);
  } finally {
    await handle.close(); await fs.rm(lock, { force: true });
  }
}

export async function prepareRuntime(storage: string, bundledRelay: string): Promise<string> {
  const relay = path.join(storage, 'runtime', 'relay.js');
  const content = await fs.readFile(bundledRelay, 'utf8');
  if (await fs.readFile(relay, 'utf8').catch(() => '') !== content) {
    await atomicWrite(relay, content);
  }
  return relay;
}
export async function repairRegistration(file: string, executable: string, relay: string, registry: string): Promise<boolean> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (!text.includes(begin)) {
    return false;
  }
  await register(file, executable, relay, registry);
  return true;
}
