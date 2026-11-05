import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { invoke, ToolResult } from './api';
import { BridgeHost, forward } from './bridge';
import { WorkerEngine } from './engine';
import { Mutex, sessionHeader, SessionStore } from './storage';
import { failure, Provider, Session, SessionHeader, Settings, WorkerError } from './types';
import { FileToolOptions, FileTools } from './workspace-tools';
import { contains, prepareWorkspaces, registeredWorktrees, rememberWorkspaceRoots, rootMetadata, worktreeRoot, workspaceCatalog, workspaceDirectory } from './workspaces';

export interface RuntimeOptions {
  storage: string; registry: string; roots: string[]; identity: string; provider: Provider;
  settings: () => Settings; defaultModel: () => string; files: FileToolOptions;
  onChange: () => void; onError: (message: string) => void;
}
interface Local { root: string; roots: string[]; store: SessionStore; engine: WorkerEngine; files: FileTools; host: BridgeHost }
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const changeIdentifier = z.string().uuid();
export function unpack<T>(result: ToolResult): T {
  const value = JSON.parse(result.content[0].text) as T & { error?: { code: string; message: string; retryable?: boolean } };
  if (result.isError || value.error) {
    throw new WorkerError(value.error?.code || 'remote_error', value.error?.message || 'Worker host returned an error.', value.error?.retryable);
  }
  return value;
}
export class WorkerBroker {
  private readonly local = new Map<string, Local>();
  private readonly scopes = new Set<string>();
  private readonly mutex = new Mutex();
  private closed = false;
  private lastDiscovery = 0;
  private savedRoots: string[] = [];
  private readonly leaseTimer: NodeJS.Timeout;
  constructor(readonly options: RuntimeOptions) {
    this.leaseTimer = setInterval(() => {
      for (const runtime of this.local.values()) {
        void runtime.engine.expireParents().catch(error => options.onError(failure(error).message));
      }
    }, 5000);
    this.leaseTimer.unref();
  }
  async start(): Promise<void> {
    this.options.roots = await Promise.all(this.options.roots.map(r => fs.realpath(r)));
    if (!this.options.roots.length) {
      return;
    }
    this.savedRoots = await prepareWorkspaces(this.options.storage, this.options.identity, this.options.roots);
    for (const root of this.options.roots) {
      const deadline = Date.now() + 5000;
      while (!await this.ensure(root)) {
        // The owner may still be publishing its bridge. Probe outside all locks.
        try {
          unpack(await forward(this.options.registry, root, 'subagent_health', {}, undefined, root)); break;
        } catch (error) {
          if (this.closed || Date.now() >= deadline || !['host_unavailable', 'bridge_unavailable', 'host_stopping'].includes(failure(error).code)) {
            throw error;
          }
          await delay(50);
        }
      }
    }
    await this.discoverWorktrees(true);
  }
  private async discoverWorktrees(force = false): Promise<void> {
    for (const root of [...this.scopes]) {
      if (!await fs.stat(root).then(s => s.isDirectory(), error => {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) {
          return false;
        } throw error;
      })) {
        await this.retire(root);
      }
    }
    if (!force && Date.now() - this.lastDiscovery < 5000) {
      return;
    }
    this.lastDiscovery = Date.now();
    const registered = await registeredWorktrees(this.options.roots);
    for (const root of [...this.scopes]) {
      if (!this.options.roots.includes(root) && !registered.includes(root)) {
        await this.retire(root);
      }
    }
    for (const entry of await this.catalog()) {
      const root = entry.roots?.[0];
      if (root && !this.scopes.has(root) && registered.includes(root)) {
        await this.ensure(root);
      }
    }
  }
  async catalog(): Promise<{ identity: string; roots: string[]; directory: string }[]> {
    return workspaceCatalog(this.options.storage);
  }
  private async ensure(root: string): Promise<Local | undefined> {
    if (!this.closed && this.local.has(root)) {
      return this.local.get(root);
    }
    return this.mutex.run(async () => {
      if (this.closed) {
        throw new WorkerError('host_stopping', 'Workspace host is restarting. Retry after it reconnects.', true);
      }
      if (this.local.has(root)) {
        return this.local.get(root);
      }
      if (!this.savedRoots.includes(root)) {
        this.savedRoots = await rememberWorkspaceRoots(this.options.storage, this.options.identity, [root]);
      }
      this.scopes.add(root);
      const directory = await workspaceDirectory(this.options.storage, root);
      const store = new SessionStore(directory);
      try {
        await store.open();
      } catch (error) {
        if (failure(error).code !== 'workspace_locked') {
          throw error;
        }
        // Another window is the writer. Forward the eventual operation outside
        // this mutex; a health RPC here deadlocks mutually discovering windows.
        return undefined;
      }
      try {
        await rootMetadata(directory, root);
        for (const s of store.list()) {
          if (!s.workspaceRoot) {
            await store.change(s.id, draft => {
              draft.workspaceRoot = root;
            });
          }
        }
      } catch (error) {
        await store.close(); throw error;
      }
      const roots = [root];
      const files = await FileTools.create(roots, {
        ...this.options.files,
        recordChange: (session, change) => store.recordChange(session.id, change),
        finishChange: (session, change) => store.finishChange(session.id, change)
      }).catch(async error => {
        await store.close(); throw error;
      });
      const engine = new WorkerEngine(store, this.options.provider, files, this.options.settings, this.options.defaultModel);
      engine.onChange = this.options.onChange;
      engine.onError = (id, error) => this.options.onError(`${id}: ${failure(error).message}`);
      const host = new BridgeHost();
      const local: Local = { root, roots, store, engine, files, host };
      this.local.set(root, local);
      try {
        await host.start(this.options.registry, roots, (name, args, signal, cwd) => this.invoke(cwd || root, name, args, signal));
      } catch (error) {
        this.local.delete(root); await engine.shutdown(); await store.close(); throw error;
      }
      return local;
    });
  }
  private async route(cwd: string): Promise<{ root: string; workspaceRoot: string; local?: Local }> {
    const real = await fs.realpath(cwd);
    const main = this.options.roots[0];
    const root = this.options.roots.filter(r => contains(r, real)).sort((a, b) => b.length - a.length)[0];
    let tree: string | undefined;
    if (!root) {
      tree = await worktreeRoot(real, this.options.roots);
    } else if (real !== root || root !== main) {
      // Nested .worktrees/feature checkouts must win over their containing root.
      for (let at = real; contains(root, at); at = path.dirname(at)) {
        if ((await fs.stat(path.join(at, '.git')).catch(() => undefined))?.isFile()) {
          tree = await worktreeRoot(real, this.options.roots); break;
        }
        if (at === root) {
          break;
        }
      }
    }
    if (tree && tree !== main) {
      return { root: tree, workspaceRoot: tree, local: await this.ensure(tree) };
    }
    if (this.savedRoots.includes(real) && !this.options.roots.includes(real)) {
      // Removing a nested folder must not redirect its workers to the enclosing
      // folder's independent store. History controls use savedInvoke instead.
      throw new WorkerError('workspace_changed', 'This worker’s original folder is not open. Restore it to continue work; saved history remains available.');
    }
    if (root) {
      return { root, workspaceRoot: root, local: await this.ensure(root) };
    }
    throw new WorkerError('outside_workspace', 'This path is neither an open workspace root nor a registered Git worktree.');
  }
  async invoke(cwd: string, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (this.closed) {
      throw new WorkerError('host_stopping', 'Workspace host is stopping. Retry after another window takes ownership.', true);
    }
    if (args && typeof args === 'object' && 'workspaceRoot' in args) {
      cwd = z.string().min(1).max(8000).parse(args.workspaceRoot);
      const { workspaceRoot: _scope, ...rest } = args as Record<string, unknown>; void _scope; args = rest;
    }
    let route: Awaited<ReturnType<WorkerBroker['route']>>;
    try {
      route = await this.route(cwd);
    } catch (error) {
      // Persisted history is still administrable after a folder is removed.
      // File-affecting operations never use this fallback.
      if (args && typeof args === 'object' && 'id' in args && ['ui_session', 'ui_change', 'subagent_status', 'subagent_cancel', 'subagent_delete', 'subagent_compact', 'subagent_discard_queued'].includes(name)) {
        return this.savedInvoke(cwd, name, args, signal);
      } else if (name === 'subagent_resume' || name === 'subagent_send') {
        throw new WorkerError('workspace_changed', 'Restore this worker’s original workspace root before continuing; its history remains available in the Workers panel.');
      } else {
        throw error;
      }
    }
    if (!route.local) {
      return this.ownerInvoke(route.root, cwd, name, args, signal);
    }
    const { engine, store, files } = route.local;
    const respond = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    try {
      if (name === 'ui_parent_scope') {
        return invoke(engine, 'subagent_parent', args, signal);
      }
      if (name === 'subagent_parent') {
        const result = await invoke(engine, name, args, signal);
        if (result.isError) {
          return result;
        }
        await this.discoverWorktrees(true);
        // Parent IDs are global conversation identifiers. The cwd's owner may
        // have fewer open folders than the window that initiated the request.
        const known = (await this.catalog()).flatMap(entry => entry.roots);
        for (const scope of new Set([...this.scopes, ...this.savedRoots, ...known])) {
          if (!this.scopes.has(scope)) {
            // A removed folder may now be active in another window. Reach that
            // owner, without opening an offline store just to renew/stop it.
            try {
              const response = await forward(this.options.registry, scope, 'ui_parent_scope', args, signal, scope);
              if (response.isError) {
                return response;
              }
            } catch (error) {
              if (failure(error).code !== 'host_unavailable' && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) {
                throw error;
              }
            }
            continue;
          }
          const other = await this.route(scope);
          if (other.local?.engine === engine) {
            continue;
          }
          const response = other.local ? await invoke(other.local.engine, name, args, signal) : await this.ownerInvoke(other.root, scope, 'ui_parent_scope', args, signal);
          if (response.isError) {
            return response;
          }
        }
        return result;
      }
      if (name === 'ui_session') {
        const a = z.object({ id: identifier }).strict().parse(args); return respond({ ...engine.session(a.id), storeDirectory: store.directory });
      }
      if (name === 'ui_change') {
        const a = z.object({ id: identifier, changeId: changeIdentifier }).strict().parse(args); return respond(await store.readChange(a.id, a.changeId));
      }
      if (name === 'ui_revert') {
        const a = z.object({ id: identifier, changeId: changeIdentifier }).strict().parse(args);
        return respond(await engine.edit(a.id, async (s, signal) => {
          const c = await store.readChange(a.id, a.changeId);
          const hash = (text: string): string => digestText(text);
          const scoped = files.forSession(s);
          if (c.kind === 'rename') {
            await scoped.execute('rename_file', { path: c.target!, target: c.path, expectedHash: hash(c.after!) }, s.permission, signal, s);
          } else if (c.before === null) {
            await scoped.execute('delete_file', { path: c.path, expectedHash: hash(c.after!) }, s.permission, signal, s);
          } else {
            await scoped.execute('write_file', { path: c.path, content: c.before, expectedHash: c.after === null ? 'new' : hash(c.after) }, s.permission, signal, s);
          }
          await store.change(a.id, draft => {
            const change = draft.changes?.find(c => c.id === a.changeId); if (change) {
              change.state = 'reverted';
            }
          });
          return { reverted: true };
        }));
      }
      if (name === 'subagent_health') {
        return respond({ ready: true, root: route.root, workspaceRoots: route.local.roots, models: await engine.models(), capabilities: files.definitions('workspace-write').map(t => t.name), diagnostics: store.diagnostics, sessionsDirectory: store.directory });
      }
      return invoke(engine, name, args, signal, route.workspaceRoot);
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: failure(error) }) }] };
    }
  }
  async list(): Promise<SessionHeader[]> {
    await this.discoverWorktrees();
    const result: SessionHeader[] = [];
    for (const root of [...this.scopes]) {
      let offset: number | null = 0;
      while (offset !== null) {
        try {
          const response: { workers: SessionHeader[]; nextOffset: number | null } = unpack(await this.invoke(root, 'subagent_list', { limit: 100, offset }));
          result.push(...response.workers); offset = response.nextOffset;
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '') && !['outside_workspace', 'workspace_changed'].includes(failure(error).code)) {
            throw error;
          }
          await this.retire(root); break;
        }
      }
    }
    for (const root of this.savedRoots.filter(r => !this.scopes.has(r))) {
      const directory = await workspaceDirectory(this.options.storage, root);
      result.push(...(await SessionStore.saved(directory)).map(sessionHeader));
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async session(root: string, id: string): Promise<Session> {
    return unpack(await this.invoke(root, 'ui_session', { id }));
  }
  private async ownerInvoke(root: string, cwd: string, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    try {
      return await forward(this.options.registry, cwd, name, args, signal, root);
    } catch (error) {
      if (failure(error).code !== 'host_unavailable') {
        throw error;
      }
      throw new WorkerError('host_reconnecting', 'The worker store is owned by a host that is starting or stopping. Retry shortly with the SAME requestId; another checkout cannot serve as its owner.', true);
    }
  }
  private async savedInvoke(root: string, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (!this.savedRoots.includes(root)) {
      throw new WorkerError('workspace_changed', 'Restore the worker’s original workspace root before continuing.');
    }
    if (this.local.has(root)) {
      await this.retire(root);
    }
    // Prefer an active owner. History-only administration must not retain its
    // lock or advertise a host that could prevent another window opening root.
    try {
      return await forward(this.options.registry, root, name, args, signal, root);
    } catch (error) {
      if (failure(error).code !== 'host_unavailable' && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) {
        throw error;
      }
    }
    return this.mutex.run(async () => {
      if (this.closed) {
        throw new WorkerError('host_stopping', 'Workspace host is restarting.', true);
      }
      const store = new SessionStore(await workspaceDirectory(this.options.storage, root));
      await store.open();
      const engine = new WorkerEngine(store, this.options.provider, await FileTools.create([], this.options.files), this.options.settings, this.options.defaultModel);
      try {
        if (name === 'ui_session' || name === 'ui_change') {
          const a = z.object({ id: identifier, changeId: changeIdentifier.optional() }).strict().parse(args);
          const value = name === 'ui_session' ? { ...engine.session(a.id), storeDirectory: store.directory } : await store.readChange(a.id, changeIdentifier.parse(a.changeId));
          return { content: [{ type: 'text', text: JSON.stringify(value) }] };
        }
        if (name === 'subagent_compact' && !(args as { summary?: string }).summary) {
          throw new WorkerError('workspace_changed', 'Restore this folder before generating a history summary. Saved history can still be read, exported, or deleted.');
        }
        return await invoke(engine, name, args, signal);
      } finally {
        await engine.shutdown(); await store.close();
      }
    });
  }
  private async retire(root: string): Promise<void> {
    await this.mutex.run(async () => {
      const local = this.local.get(root);
      if (local) {
        // Scope validation no longer permits this root. Withdraw its bridge so
        // history requests cannot forward back to the same retiring owner.
        await local.host.close();
        await local.engine.shutdown(); await local.store.close();
        this.local.delete(root);
      }
      this.scopes.delete(root);
    });
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.leaseTimer);
    await this.mutex.run(async () => undefined);
    for (const local of this.local.values()) {
      // Keep the exact owner discoverable while effects drain. Incoming requests
      // receive host_stopping instead of falling back to an unrelated checkout.
      await local.engine.shutdown(); await local.host.close(); await local.store.close();
    }
    this.local.clear();
  }
}

import { createHash } from 'node:crypto';
function digestText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
