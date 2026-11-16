import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { invoke, ToolResult } from './api';
import { BridgeHost, forward } from './bridge';
import { WorkerEngine } from './engine';
import { TaskBoard } from './task-board';
import type { BoardActor } from './task-board-types';
import { invokeBoard, isBoardTool, workerBoardTools } from './task-board-tools';
import type { BoardPort } from './task-board-tools';
import { summarizeBoard } from './task-board-summary';
import type { BoardWorkspaceStatus } from './task-board-summary';
import { Mutex, sessionHeader, SessionStore } from './storage';
import { failure, Provider, Session, SessionHeader, Settings, WorkerError, WorkspaceTools } from './types';
import { FileToolOptions, FileTools } from './workspace-tools';
import { IsolatedViewHost } from './isolated-view-host';
import type { RunnerHostConfig } from './isolated-view-host';
import { isIsolatedViewTool, isOfflineViewTool } from './isolated-view-tools';
import type { OpenDocument } from './snapshot-content';
import { contains, prepareWorkspaces, registeredWorktrees, rememberWorkspaceRoots, rootMetadata, worktreeRoot, workspaceCatalog, workspaceDirectory } from './workspaces';

export interface RuntimeOptions {
  storage: string; registry: string; roots: string[]; identity: string; provider: Provider;
  settings: () => Settings; files: FileToolOptions;
  onChange: () => void; onError: (message: string) => void;
  /** Opt-in task board gate; absent or false keeps every board surface off. Read on every call. */
  taskBoardEnabled?: () => boolean;
  isolatedViewsEnabled?: () => boolean;
  /**
   * Live physical-runner configuration for isolated workers. Absent keeps runner
   * execution off exactly as before: no runner storage is created and bound
   * commands stay unavailable. The enabled flag is read on every decision point;
   * capacity/maxQueue are applied when the runner manager is opened.
   */
  runners?: () => RunnerHostConfig;
  /** Fresh owning-window dirty document enumeration, queried at each capture boundary. */
  openDocuments?: () => OpenDocument[];
}
interface Local { root: string; roots: string[]; store: SessionStore; engine: WorkerEngine; files: FileTools; host: BridgeHost; board: BoardHost; isolation: IsolatedViewHost }
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const changeIdentifier = z.string().uuid();
export function unpack<T>(result: ToolResult): T {
  const value = JSON.parse(result.content[0].text) as T & { error?: { code: string; message: string; retryable?: boolean } };
  if (result.isError || value.error) {
    throw new WorkerError(value.error?.code || 'remote_error', value.error?.message || 'Worker host returned an error.', value.error?.retryable);
  }
  return value;
}
/**
 * Lazy, single-flight board handle for one canonical root. The board lives in
 * the root's own store directory under the same owner lock as the sessions, so
 * it is opened on demand, cached once (concurrent callers share one promise),
 * and closed before the store releases ownership. A malformed board is reported
 * and cached: board calls and the UI keep failing closed while standalone
 * workers keep running from the session store. Recovering a broken board needs
 * an explicit host restart; nothing here repairs or resets board data.
 *
 * It is also the BoardPort the adapters call. Worker membership filtering reads
 * the loaded board synchronously or through the pending open; every call is
 * gated by the live feature flag and by this host closing (not just the broker).
 */
class BoardHost implements BoardPort {
  private board?: TaskBoard;
  private opening?: Promise<TaskBoard>;
  private failure?: string;
  /** Set the instant close() starts, so no new open/read/write can begin retirement. */
  private closing = false;
  private drained?: Promise<void>;

  constructor(
    private readonly directory: string,
    private readonly root: string,
    private readonly worker: (id: string) => Session | undefined,
    private readonly enabled: () => boolean,
    private readonly guard: () => void
  ) {}

  /** Host-stopping / feature-off gate shared by open, reads and the commit guard. */
  private assertUsable(): void {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'The board is closing; the call was not applied.', true);
    }
    if (!this.enabled()) {
      throw new WorkerError('feature_disabled', 'The task board is disabled; enable codexSubagent.taskBoard.enabled in User Settings.');
    }
  }

  /**
   * Guard handed to the board's commit: this host closing is as fatal as the
   * broker stopping, because the root owner lock is released once close drains.
   */
  private commitGuard(): void {
    this.assertUsable();
    this.guard();
  }

  get error(): string | undefined {
    return this.failure;
  }

  async open(): Promise<TaskBoard> {
    this.assertUsable();
    if (!this.opening) {
      const board = new TaskBoard(this.directory, this.root, this.worker, () => this.commitGuard());
      this.opening = board.open().then(() => {
        this.board = board;
        return board;
      }, error => {
        this.failure = `${failure(error).code}: ${failure(error).message}`;
        throw error;
      });
    }
    return this.opening;
  }

  /**
   * Idempotent retirement: refuse new work immediately, then drain the SAME
   * pending open and close that board before the root owner lock is released.
   */
  close(): Promise<void> {
    this.closing = true;
    this.drained ??= (async () => {
      const pending = this.opening;
      const board = pending ? await pending.catch(() => undefined) : this.board;
      this.opening = undefined;
      this.board = undefined;
      await board?.close();
    })();
    return this.drained;
  }

  /**
   * Worker tool filtering needs membership synchronously. Once the board is open
   * this is a raw synchronous read of the real array; before that it resolves
   * through the single-flight open, so an unopened board is never reported as
   * empty. A disabled, failed or closing host rejects instead of answering [].
   */
  listTeams(actor: BoardActor): unknown {
    this.assertUsable();
    if (this.board) {
      return this.board.listTeams(actor);
    }
    return this.open().then(board => board.listTeams(actor));
  }

  async getTeam(actor: BoardActor, id: string): Promise<unknown> {
    return (await this.open()).getTeam(actor, id);
  }

  /** Synchronous live authorization used immediately before private publication. */
  assertTeam(ownerId: string, teamId: string, workerId?: string): void {
    this.assertUsable();
    if (!this.board) {
      throw new WorkerError('unavailable', 'The task board has not loaded.');
    }
    const team = this.board.getTeam({ kind: 'coordinator', ownerId }, teamId);
    if (workerId && !team.memberWorkerIds.includes(workerId)) {
      throw new WorkerError('permission_denied', 'This worker is no longer a member of the private view team.');
    }
  }

  async createTeam(actor: BoardActor, input: unknown): Promise<unknown> {
    return (await this.open()).createTeam(actor, input as Parameters<TaskBoard['createTeam']>[1]);
  }

  async updateTeam(actor: BoardActor, input: unknown): Promise<unknown> {
    return (await this.open()).updateTeam(actor, input as Parameters<TaskBoard['updateTeam']>[1]);
  }

  async createTask(actor: BoardActor, input: unknown): Promise<unknown> {
    return (await this.open()).createTask(actor, input);
  }

  async getTask(actor: BoardActor, id: string): Promise<unknown> {
    return (await this.open()).getTask(actor, id);
  }

  async listTasks(actor: BoardActor, teamId?: string): Promise<unknown> {
    return (await this.open()).listTasks(actor, teamId);
  }

  async updateTask(actor: BoardActor, input: unknown, authorize?: () => void): Promise<unknown> {
    return (await this.open()).updateTask(actor, input, authorize);
  }
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
  /**
   * Live settings changed in this window. Ask every locally owned engine to
   * re-evaluate queued work against the new pool (repaired malformed config,
   * raised numSessions). Ownership, running jobs and draining tools are left
   * untouched; windows that do not own a store simply have nothing to do.
   */
  settingsChanged(): void {
    if (this.closed) {
      return;
    }
    for (const runtime of this.local.values()) {
      try {
        runtime.engine.reschedule();
      } catch (error) {
        this.options.onError(failure(error).message);
      }
    }
  }
  async catalog(): Promise<{ identity: string; roots: string[]; directory: string }[]> {
    return workspaceCatalog(this.options.storage);
  }
  /**
   * Structured tool failure for gates that run before the tool try/catch, so a
   * direct broker/invoke caller sees the same shape as the MCP bridge.
   */
  private boardFailure(code: string, message: string, retryable = false): ToolResult {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: failure(new WorkerError(code, message, retryable)) }) }] };
  }

  /** Live board gate: settings can flip at any time, so this is read on every call. */
  private boardEnabled(): boolean {
    return this.options.taskBoardEnabled?.() === true;
  }

  /**
   * Guard handed to the board itself and re-checked inside its commit, so a
   * queued or replayed write cannot apply after the feature was disabled or the
   * host began stopping.
   */
  private boardGuard(): void {
    if (this.closed) {
      throw new WorkerError('host_stopping', 'The host is stopping; the board write was not applied.', true);
    }
    if (!this.boardEnabled()) {
      throw new WorkerError('feature_disabled', 'The task board was disabled before this write applied.');
    }
  }

  /** Worker ids resolve through the same store; only a missing session means "no worker". */
  private workerResolver(store: SessionStore): (id: string) => Session | undefined {
    return (id: string) => {
      try {
        return store.get(id);
      } catch (error) {
        if (failure(error).code === 'not_found') {
          return undefined;
        }
        throw error;
      }
    };
  }

  /**
   * Private tools for one worker: file tools stay exactly as the engine built
   * them, so write/shell policy and the authorize callback are unchanged, and
   * the board adds only session-bound, membership-checked metadata tools.
   */
  private viewsEnabled(): boolean {
    return this.boardEnabled() && this.options.isolatedViewsEnabled?.() === true;
  }

  private isolationHost(root: string, store: SessionStore, board: BoardHost): IsolatedViewHost {
    return new IsolatedViewHost(root, store, board, { enabled: () => this.viewsEnabled(), guard: () => {
      if (this.closed) {
        throw new WorkerError('host_stopping', 'The private view host is stopping.', true);
      }
    }, canWrite: this.options.files.canWrite, settings: this.options.settings, openDocuments: this.options.openDocuments,
    // Physical runners are an additional opt-in over the same parent flags;
    // without the callback this host behaves exactly as before. The global
    // shell switch and the approval surface are forwarded, not copied, so a
    // live revocation is seen by every runner decision point.
    runners: this.options.runners,
    allowShell: this.options.files.allowShell,
    approveCommand: this.options.files.approveCommand });
  }

  private workerTools(files: FileTools, board: BoardHost, isolation: IsolatedViewHost): WorkspaceTools {
    const scoped = (session: Session): WorkspaceTools => session.schema === 2 || session.isolatedView ? isolation.scoped(session) : files.forSession(session);
    return {
      get workspaceRoot() {
        return files.workspaceRoot;
      },
      definitions: permission => files.definitions(permission),
      execute: (name, input, permission, signal, session, authorize) => (session ? scoped(session) : files).execute(name, input, permission, signal, session, authorize),
      forSession: session => workerBoardTools(board, session, () => this.boardEnabled(), this.options.onChange, scoped(session))
    };
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
      const board = new BoardHost(directory, root, this.workerResolver(store), () => this.boardEnabled(), () => this.boardGuard());
      // An enabled board loads before any worker turn runs. Board trouble is
      // reported and cached but never blocks the standalone worker host.
      if (this.boardEnabled()) {
        await board.open().catch(error => this.options.onError(`board ${root}: ${failure(error).message}`));
      }
      const isolation = this.isolationHost(root, store, board);
      const engine = new WorkerEngine(store, this.options.provider, this.workerTools(files, board, isolation), this.options.settings);
      engine.onChange = this.options.onChange;
      engine.onError = (id, error) => this.options.onError(`${id}: ${failure(error).message}`);
      const host = new BridgeHost();
      const local: Local = { root, roots, store, engine, files, host, board, isolation };
      this.local.set(root, local);
      try {
        await host.start(this.options.registry, roots, (name, args, signal, cwd) => this.invoke(cwd || root, name, args, signal));
      } catch (error) {
        this.local.delete(root);
        const closing = Promise.all([board.close(), isolation.close()]);
        await engine.shutdown(); await closing; await store.close(); throw error;
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
    if (isBoardTool(name) && !this.boardEnabled()) {
      // Structured failure before routing: a disabled board never opens a store or a bridge.
      return this.boardFailure('feature_disabled', 'The task board is disabled; enable codexSubagent.taskBoard.enabled in User Settings.');
    }
    if (isIsolatedViewTool(name) && !this.viewsEnabled()) {
      return this.boardFailure('feature_disabled', 'Private views require User Settings codexSubagent.taskBoard.enabled and codexSubagent.isolatedViews.enabled.');
    }
    if (args && typeof args === 'object' && 'workspaceRoot' in args) {
      cwd = z.string().min(1).max(8000).parse(args.workspaceRoot);
      const { workspaceRoot: _scope, ...rest } = args as Record<string, unknown>; void _scope; args = rest;
    }
    let route: Awaited<ReturnType<WorkerBroker['route']>>;
    try {
      route = await this.route(cwd);
    } catch (error) {
      if (isOfflineViewTool(name)) {
        return this.savedInvoke(cwd, name, args, signal);
      }
      if (isIsolatedViewTool(name)) {
        throw new WorkerError('workspace_changed', 'Restore the original open workspace root before capturing, binding or sealing a worker view. Saved submissions and retention remain administrable.');
      }
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
      if (isIsolatedViewTool(name)) {
        const result = await route.local.isolation.invoke(name, args, engine, signal);
        this.options.onChange();
        return result;
      }
      if (['subagent_resume', 'subagent_send'].includes(name) && args && typeof args === 'object' && 'id' in args) {
        const session = engine.session(identifier.parse(args.id));
        if (session.schema === 2 || session.isolatedView) {
          engine.assertOwner(session.id, 'ownerId' in args ? z.string().optional().parse(args.ownerId) : undefined);
          await route.local.isolation.assertWorkerUsable(session, signal);
        }
      }
      if (isBoardTool(name)) {
        // Board tools are record-only metadata: they never touch worker sessions,
        // dispatch inference or automatically accept work; explicit acceptance stays
        // a coordinator call. The flag is checked here (so even bad
        // ids answer feature_disabled) and again inside the board's own commit
        // guard, and the domain still checks live membership and assignment.
        if (!this.boardEnabled()) {
          throw new WorkerError('feature_disabled', 'The task board is disabled; enable codexSubagent.taskBoard.enabled in User Settings.');
        }
        const result = await invokeBoard(await route.local.board.open(), name, args);
        if (!result.isError && /_create$|_update$/.test(name)) {
          this.options.onChange();
        }
        return result;
      }
      if (name === 'ui_board_snapshot') {
        // Trusted read-only UI view: bounded summaries only, never the raw board.
        z.object({}).strict().parse(args ?? {});
        if (!this.boardEnabled()) {
          throw new WorkerError('feature_disabled', 'The task board is disabled; enable codexSubagent.taskBoard.enabled in User Settings.');
        }
        return respond(summarizeBoard((await route.local.board.open()).snapshot()));
      }
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
          // Explicit trusted user-revert view: model write policy must not block
          // undoing a recorded worker change, while every other check (hashes,
          // protected paths, symlinks, dirty buffers, snapshots, undo, drains)
          // and the shared write mutex remain exactly as for worker writes.
          const scoped = files.forUserRevert(s);
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
        return respond({ ready: true, root: route.root, workspaceRoots: route.local.roots, models: await engine.models(), capabilities: files.definitions('workspace-write').map(t => t.name), diagnostics: store.diagnostics, sessionsDirectory: store.directory, taskBoard: { enabled: this.boardEnabled(), ...(route.local.board.error ? { error: route.local.board.error } : {}) } });
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
      const engine = new WorkerEngine(store, this.options.provider, await FileTools.create([], this.options.files), this.options.settings);
      const board = new BoardHost(store.directory, root, this.workerResolver(store), () => this.boardEnabled(), () => this.boardGuard());
      const isolation = this.isolationHost(root, store, board);
      try {
        if (isOfflineViewTool(name) && isIsolatedViewTool(name)) {
          return await isolation.invoke(name, args, engine, signal);
        }
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
        const closing = Promise.all([isolation.close(), board.close()]);
        await engine.shutdown(); await closing; await store.close();
      }
    });
  }
  /**
   * Bounded board summaries for the Task Board view: one row per live canonical
   * root, read through that root's exact owner. A failing board contributes an
   * error row so other roots and legacy workers keep refreshing. Removed roots
   * are never opened offline and saved history is left untouched.
   */
  async boardStatus(): Promise<BoardWorkspaceStatus[]> {
    if (this.closed || !this.boardEnabled()) {
      return [];
    }
    await this.discoverWorktrees();
    const statuses: BoardWorkspaceStatus[] = [];
    for (const root of [...this.scopes]) {
      try {
        statuses.push(unpack<BoardWorkspaceStatus>(await this.invoke(root, 'ui_board_snapshot', {})));
      } catch (error) {
        const problem = failure(error);
        statuses.push({ workspaceRoot: root, teams: [], tasks: [], error: `${problem.code}: ${problem.message}` });
      }
    }
    return statuses;
  }
  private async retire(root: string): Promise<void> {
    await this.mutex.run(async () => {
      const local = this.local.get(root);
      if (local) {
        // Scope validation no longer permits this root. Withdraw its bridge so
        // history requests cannot forward back to the same retiring owner.
        await local.host.close();
        const closing = Promise.all([local.board.close(), local.isolation.close()]);
        await local.engine.shutdown(); await closing;
        await local.store.close();
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
      const closing = Promise.all([local.board.close(), local.isolation.close()]);
      await local.engine.shutdown(); await local.host.close(); await closing; await local.store.close();
    }
    this.local.clear();
  }
}

import { createHash } from 'node:crypto';
function digestText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
