import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, digest, SessionStore } from './storage';
import { failure, WorkerError } from './types';

const run = promisify(execFile);
export function contains(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export async function registeredWorktrees(roots: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    try {
      const { stdout } = await run('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], { timeout: 3000, maxBuffer: 1_000_000 });
      for (const entry of stdout.split('\0').filter(s => s.startsWith('worktree '))) {
        const real = await fs.realpath(entry.slice(9)).catch(() => undefined);
        if (real) {
          found.add(real);
        }
      }
    } catch { /* Non-Git root, unavailable Git, or a removed worktree. */ }
  }
  return [...found].sort((a, b) => b.length - a.length);
}
/** Only registered Git worktrees qualify; arbitrary sibling folders do not. */
export async function worktreeRoot(cwd: string, roots: string[]): Promise<string | undefined> {
  return (await registeredWorktrees(roots)).find(root => contains(root, cwd));
}
export interface SavedWorkspace { identity: string; roots: string[]; directory: string; layout?: 'root' }
export async function workspaceCatalog(storage: string): Promise<SavedWorkspace[]> {
  const directory = path.join(storage, 'workspaces');
  const found: SavedWorkspace[] = [];
  for (const entry of await fs.readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9]{32}$/.test(entry)) {
      continue;
    }
    const at = path.join(directory, entry);
    const meta = await fs.readFile(path.join(at, 'workspace.json'), 'utf8').then(s => JSON.parse(s) as SavedWorkspace).catch(() => undefined);
    if (typeof meta?.identity === 'string' && Array.isArray(meta.roots) && meta.roots.length && meta.roots.every(r => typeof r === 'string' && path.isAbsolute(r))) {
      found.push({ ...meta, directory: at });
    }
  }
  return found;
}
/** Store identity follows a canonical folder, independent of window/workspace URI. */
export async function workspaceDirectory(storage: string, root: string): Promise<string> {
  const directory = path.join(storage, 'workspaces');
  const matching = (await workspaceCatalog(storage)).filter(e => e.roots.length === 1 && e.roots[0] === root);
  matching.sort((a, b) => Number(b.layout === 'root') - Number(a.layout === 'root') || a.directory.localeCompare(b.directory));
  if (matching.length) {
    return matching[0].directory;
  }
  const legacy = path.join(directory, digest([root]).slice(0, 32));
  if (await fs.stat(legacy).catch(() => undefined) && !await fs.stat(path.join(legacy, 'workspace.json')).catch(() => undefined)) {
    return legacy;
  }
  return path.join(directory, digest(['root', root]).slice(0, 32));
}
export async function rootMetadata(directory: string, root: string): Promise<void> {
  await atomicWrite(path.join(directory, 'workspace.json'), JSON.stringify({ layout: 'root', identity: `folder:${root}`, roots: [root] }));
}
/** Serialize only local migration/index writes. Never hold this lock during RPC. */
async function withIndex<T>(storage: string, action: () => Promise<T>): Promise<T> {
  const guard = new SessionStore(path.join(storage, 'workspace-index'));
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await guard.open(); break;
    } catch (error) {
      if (failure(error).code !== 'workspace_locked' || Date.now() >= deadline) {
        throw error;
      }
      await delay(25);
    }
  }
  try {
    return await action();
  } finally {
    await guard.close();
  }
}
async function recordRoots(storage: string, key: string, additions: string[]): Promise<string[]> {
  const file = path.join(storage, 'workspace-index', `${digest(key)}.roots`);
  const old: unknown = await fs.readFile(file, 'utf8').then(s => JSON.parse(s) as unknown).catch(() => []);
  const known = [...new Set([...rootsFrom(old), ...additions])];
  await atomicWrite(file, JSON.stringify(known)); return known;
}
export async function rememberWorkspaceRoots(storage: string, identity: string, roots: string[]): Promise<string[]> {
  return withIndex(storage, () => recordRoots(storage, identity, roots));
}
export async function prepareWorkspaces(storage: string, identity: string, roots: string[]): Promise<string[]> {
  const relevant = new Set([...roots, ...await registeredWorktrees(roots)]);
  return withIndex(storage, async () => {
    const legacy = path.join(storage, 'workspaces', digest([...roots].sort()).slice(0, 32));
    if (await fs.stat(legacy).catch(() => undefined) && !await fs.stat(path.join(legacy, 'workspace.json')).catch(() => undefined)) {
      await atomicWrite(path.join(legacy, 'workspace.json'), JSON.stringify({ identity, roots }));
    }
    for (const entry of await workspaceCatalog(storage)) {
      if (entry.layout === 'root' || (entry.identity !== identity && !entry.roots.some(r => relevant.has(r)))) {
        continue;
      }
      // Earlier versions grouped all folders in one store. Move each worker,
      // including immutable archives/snapshots, before removing its old copy.
      const source = new SessionStore(entry.directory);
      try {
        await source.open();
      } catch (error) {
        if (failure(error).code === 'workspace_locked') {
          throw new WorkerError('migration_busy', 'Reload other Codex Subagent windows to finish upgrading saved worker stores, then retry the worker host.', true);
        }
        throw error;
      }
      try {
        await recordRoots(storage, entry.identity, entry.roots);
        const primary = entry.roots[0];
        for (const header of source.list()) {
          if (!header.workspaceRoot) {
            await source.change(header.id, s => {
              s.workspaceRoot = primary;
            });
          }
          const session = source.get(header.id);
          if (session.workspaceRoot === primary) {
            continue;
          }
          const target = new SessionStore(await workspaceDirectory(storage, session.workspaceRoot!));
          await target.open();
          try {
            await target.importSession(entry.directory, session);
            await rootMetadata(target.directory, session.workspaceRoot!);
            await source.remove(session.id);
          } finally {
            await target.close();
          }
        }
        await rootMetadata(entry.directory, primary);
      } finally {
        await source.close();
      }
    }
    return recordRoots(storage, identity, roots);
  });
}
function rootsFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string' && path.isAbsolute(r)) : [];
}
