import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IsolatedViews, WorkerViewPresence } from './isolated-views';
import type { SnapshotInspection } from './isolated-views';
import { IsolatedWorkspaceTools, executeViewRead } from './isolated-workspace-tools';
import { isolatedViewSchemas, IsolatedViewToolName, isSlowViewTool, viewResponse } from './isolated-view-tools';
import type { IsolatedViewBinding } from './isolated-view-types';
import type { IsolatedViewIdentity, IsolatedViewPort } from './isolated-view-port';
import type { OpenDocument } from './snapshot-content';
import type { TaskBoard } from './task-board';
import { captureProject } from './project-snapshot';
import { RunnerExecution } from './runner-execution';
import type { RunnerCommandResult } from './runner-results';
import type { RunnerPoolCleanupResult, RunnerPoolStatus } from './runner-pool';
import { EvidenceRetention } from './evidence-retention';
import { digest, SessionStore } from './storage';
import { Session, Settings, WorkerError, WorkspaceTools } from './types';
import type { RunnerAdmission } from './resource-governor';
import type { WorkerEngine } from './engine';
import type { ToolResult } from './api';
import { fileToolSchemas } from './workspace-tools';
import type { CommandApprovalContext } from './workspace-tools';

interface IsolationBoard {
  open(): Promise<TaskBoard>;
  assertTeam(ownerId: string, teamId: string, workerId?: string): void;
}
const sealSchema = z.strictObject({ requestId: z.string().min(1).max(200), expectedRevision: z.number().int().min(0).max(1024) });
const sameBinding = (a: IsolatedViewBinding, b: IsolatedViewBinding): boolean => a.overlayId === b.overlayId && a.snapshotId === b.snapshotId && a.teamId === b.teamId;

/**
 * Live physical-runner configuration. `enabled` is read on every decision point
 * (offered definition, pre-spawn policy, pre-approval, actual spawn); capacity
 * and queue length are read once, when the runner manager for this canonical
 * root is opened, because they describe a fixed set of slots that a restart -
 * not a live edit - changes.
 */
export interface RunnerHostConfig {
  readonly enabled: boolean;
  readonly capacity: number;
  readonly maxQueue: number;
}

const RUNNER_DEFAULTS: RunnerHostConfig = { enabled: false, capacity: 2, maxQueue: 32 };
/** Accepted slot bounds; the same numbers package.json advertises. */
export const RUNNER_CAPACITY_RANGE = { min: 1, max: 8, fallback: 2 } as const;
export const RUNNER_QUEUE_RANGE = { min: 0, max: 256, fallback: 32 } as const;
const PREVIEW_CHARS = 512;

const preview = (value: string | undefined): string | undefined =>
  (value === undefined ? undefined : value.length <= PREVIEW_CHARS ? value : value.slice(0, PREVIEW_CHARS));

const boundedInteger = (value: unknown, range: { min: number; max: number; fallback: number }): number =>
  (typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max ? value : range.fallback);

/**
 * Reads the runner settings from a `WorkspaceConfiguration.inspect` surface.
 * Only the User-level `globalValue` counts: a workspace or folder value can
 * never enable execution or widen the resource bounds of a checkout, and an
 * out-of-range value falls back to the documented default.
 */
export function readRunnerHostConfig(inspect: (key: string) => unknown): RunnerHostConfig {
  const globalValue = (key: string): unknown => {
    const entry = inspect(key);
    return entry !== null && typeof entry === 'object' ? (entry as { globalValue?: unknown }).globalValue : undefined;
  };
  return {
    enabled: globalValue('isolatedViews.runners.enabled') === true,
    capacity: boundedInteger(globalValue('isolatedViews.runners.capacity'), RUNNER_CAPACITY_RANGE),
    maxQueue: boundedInteger(globalValue('isolatedViews.runners.maxQueue'), RUNNER_QUEUE_RANGE)
  };
}

/** Bounded, owner-scoped projection of one runner lease; never a raw record. */
interface RunnerLeaseRow {
  readonly id: string;
  readonly slot: number;
  readonly state: string;
  readonly phase: string;
  readonly retained: boolean;
  readonly hasProcessIdentity: boolean;
  readonly owner: { readonly workerId: string; readonly workerCreatedAt: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly diagnostic?: string;
}

type RunnerStatusArgs = { ownerId: string; teamId: string; kind: 'leases' | 'queue' | 'results'; offset: number; limit: number };

/** Lazy lifecycle handle, always drained before its SessionStore owner unlocks. */
export class IsolatedViewHost {
  readonly evidence: EvidenceRetention;
  private views?: IsolatedViews;
  private opening?: Promise<IsolatedViews>;
  private runners?: RunnerExecution;
  private openingRunners?: Promise<RunnerExecution>;
  private closing = false;
  private drained?: Promise<void>;
  constructor(
    private readonly root: string,
    private readonly store: SessionStore,
    private readonly board: IsolationBoard,
    private readonly options: {
      governanceEnabled?: () => boolean;
      withStorageWrite?: <T>(action: () => Promise<T>) => Promise<T>;
      admission?: RunnerAdmission;
      onRunnerPhase?: (workerId: string, reason?: 'approval' | 'runner_capacity') => Promise<void>;
      enabled: () => boolean;
      guard: () => void;
      canWrite: () => boolean;
      settings: () => Settings;
      openDocuments?: () => OpenDocument[];
      /** Live physical-runner configuration; absent keeps runner execution off. */
      runners?: () => RunnerHostConfig;
      /** Global shell switch, read live; absent means new runners may not run. */
      allowShell?: () => boolean;
      /** Existing five-argument approval callback; the adapter adds runner context. */
      approveCommand?: (command: string, cwd: string, signal: AbortSignal, workspaceRoot: string, context?: CommandApprovalContext) => Promise<boolean>;
    }
  ) {
    this.evidence = new EvidenceRetention(store.directory);
  }

  private commitGuard = (): void => {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'Private view storage is closing.', true);
    }
    if (!this.options.enabled()) {
      throw new WorkerError('feature_disabled', 'Private views require User Settings codexSubagent.taskBoard.enabled and codexSubagent.isolatedViews.enabled. Marked workers cannot fall back to live files.');
    }
    this.options.guard();
  };

  async open(): Promise<IsolatedViews> {
    this.commitGuard();
    this.opening ??= (async () => {
      const views = new IsolatedViews(path.join(this.store.directory, 'isolated-views'), this.root, {
        withStorageWrite: this.options.withStorageWrite,
        // Live, trusted and re-read per request - exactly the same source as the
        // governed-runner branch below - so an ungoverned namespace may use its
        // own epoch-looking request IDs. A request argument can never widen this.
        governanceEnabled: this.options.governanceEnabled,
        guard: this.commitGuard, expectExisting: this.store.list().some(session => session.isolatedView !== undefined)
      });
      try {
        await views.open();
        await this.verifySessionClaims(views);
        this.views = views;
        return views;
      } catch (error) {
        await views.close();
        throw error;
      }
    })();
    return this.opening;
  }

  /** A valid-but-incomplete restored index must not turn live claims into GC orphans. */
  private async verifySessionClaims(views: IsolatedViews): Promise<void> {
    const scopes = new Map<string, SnapshotInspection>();
    for (const session of this.store.list()) {
      const marker = session.isolatedView;
      if (!marker) {
        continue;
      }
      this.commitGuard();
      const fail = (): never => {
        throw new WorkerError('isolation_corrupt', 'A permanent Session binding is missing or inconsistent in the private index. Restore its metadata before using this namespace.');
      };
      if (!session.ownerId || session.workspaceRoot !== this.root
        || marker.overlayId !== digest(['overlay', views.namespace, session.id, session.createdAt, marker.snapshotId])) {
        fail();
      }
      const key = digest([session.ownerId, marker.teamId]);
      let scope = scopes.get(key);
      if (!scope) {
        scope = await views.inspect(session.ownerId!, marker.teamId);
        scopes.set(key, scope);
      }
      this.commitGuard();
      const overlay = scope.overlays.find(record => record.overlayId === marker.overlayId);
      if (overlay) {
        if (overlay.snapshotId !== marker.snapshotId || overlay.workerId !== session.id || overlay.workerCreatedAt !== session.createdAt) {
          fail();
        }
        // Released tombstones deliberately outlive collected base content.
        continue;
      }
      const intent = scope.pins.some(pin => pin.name === `binding:${marker.overlayId}`
        && pin.resource.kind === 'snapshot' && pin.resource.id === marker.snapshotId
        && (!pin.binding || (pin.binding.workerId === session.id && pin.binding.workerCreatedAt === session.createdAt && pin.binding.overlayId === marker.overlayId)));
      if (!intent) {
        fail();
      }
    }
  }

  close(): Promise<void> {
    this.closing = true;
    if (this.drained) {
      return this.drained;
    }
    // Order matters. The physical runner manager is drained FIRST: an in-flight
    // open (including a failed one) is awaited, then close() aborts queued and
    // running commands, waits for their durable result write and lease release,
    // and only then is private view storage closed. A rejection here propagates,
    // so the caller keeps the SessionStore owner lock instead of unlocking under
    // work that may still be running.
    const pending = (async () => {
      const runners = this.openingRunners
        ? await this.openingRunners.then(manager => manager, () => undefined)
        : this.runners;
      await runners?.close();
      const views = this.opening ? await this.opening.catch(() => undefined) : this.views;
      await views?.close();
    })();
    this.drained = pending.catch((error: unknown) => {
      this.drained = undefined;
      throw error;
    });
    return this.drained;
  }

  // -- physical runners --------------------------------------------------------

  /** Live configuration; an absent callback means runners stay off. */
  private runnerConfig(): RunnerHostConfig {
    return this.options.runners?.() ?? RUNNER_DEFAULTS;
  }

  private runnerEnabled(): boolean {
    return this.options.runners !== undefined && this.runnerConfig().enabled;
  }

  private shellAllowed(): boolean {
    return this.options.allowShell?.() === true;
  }

  /** Enabled, shell-capable and with an approval surface to ask. */
  private runnerAvailable(): boolean {
    return this.runnerEnabled() && this.shellAllowed() && this.options.approveCommand !== undefined;
  }

  /** Host lifetime only: the execution flag never hides existing metadata. */
  private runnerLifetimeGuard = (): void => {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'The runner manager is stopping; no command was started.', true);
    }
  };

  /** Runner storage sits beside the session store, never inside the project. */
  private get runnerDirectory(): string {
    return path.join(this.store.directory, 'runners');
  }

  /**
   * Absent only when nothing exists (ENOENT). Any existing entry - including a
   * file, link or junction that the manager must refuse - is reported as present
   * so the manager opens and fails closed; other filesystem errors surface
   * instead of being disguised as successful emptiness.
   */
  private async runnerDirectoryPresent(): Promise<boolean> {
    try {
      await fs.lstat(this.runnerDirectory);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Single-flight open of this root's manager. Construction reads capacity and
   * queue length once, so only a restart changes them. A failed initializer is
   * cached too: every awaiter - including Host.close() - stays on the same
   * settled promise instead of racing a fresh opening, and the partially opened
   * manager is drained before the failure is reported.
   */
  private async openRunners(): Promise<RunnerExecution> {
    this.runnerLifetimeGuard();
    if (!this.openingRunners) {
      const config = this.runnerConfig();
      const manager = new RunnerExecution(this.runnerDirectory, this.root, {
        capacity: config.capacity,
        withStorageWrite: this.options.withStorageWrite,
        admission: this.options.admission,
        retainInputs: owner => !!this.store.get(owner.workerId).startup,
        inputRequestId: (owner, key) => this.views!.requestId(owner.ownerId, key),
        maxQueue: config.maxQueue,
        guard: this.runnerLifetimeGuard,
        // Always callable: without an approval surface it simply declines, so
        // observation and reconciliation never depend on one. Execution is
        // gated separately, where a missing surface is a hard error.
        approveCommand: async (request, signal) => {
          const owner = manager.status().pool?.leases.find(l => l.directory === request.executionRoot)?.owner;
          if (owner) {
            await this.options.onRunnerPhase?.(owner.workerId, 'approval');
          }
          const approve = this.options.approveCommand;
          try {
            return approve === undefined
              ? false
              : await approve(request.command, request.cwd, signal, request.logicalRoot, {
                kind: 'isolated-runner', executionRoot: request.executionRoot, inputVersion: request.inputVersion
              });
          } finally {
            if (owner) {
              await this.options.onRunnerPhase?.(owner.workerId);
            }
          }
        }
      });
      this.openingRunners = (async () => {
        try {
          await manager.open();
        } catch (error) {
          await manager.close().catch(() => undefined);
          throw error;
        }
        this.runners = manager;
        return manager;
      })();
    }
    return this.openingRunners;
  }

  /** Existing manager, a cached failed open, or existing state worth opening. */
  private async runnerStore(): Promise<RunnerExecution | undefined> {
    if (this.runners) {
      return this.runners;
    }
    if (this.openingRunners) {
      return this.openingRunners;
    }
    return await this.runnerDirectoryPresent() ? this.openRunners() : undefined;
  }

  /** A current Session identity and live membership check, suitable for preRename. */
  private workerGuard(original: Session, authorize?: () => void, signal?: AbortSignal, checkModel = true): () => void {
    return () => {
      signal?.throwIfAborted();
      this.commitGuard();
      authorize?.();
      const current = this.store.get(original.id);
      if (current.createdAt !== original.createdAt || current.ownerId !== original.ownerId || current.workspaceRoot !== this.root
        || (current.schema !== 2 && current.schema !== 3) || !current.isolatedView || !original.isolatedView || !sameBinding(current.isolatedView, original.isolatedView)) {
        throw new WorkerError('isolation_unavailable', 'This worker instance no longer has its original private binding.');
      }
      if (checkModel) {
        this.assertWorkerPolicy(current);
      }
      this.board.assertTeam(current.ownerId!, current.isolatedView.teamId, current.id);
    };
  }

  private assertWorkerPolicy(session: Session): void {
    const pool = this.options.settings().models;
    const policy = pool && Object.hasOwn(pool, session.model.id) ? pool[session.model.id] : undefined;
    if (!policy) {
      throw new WorkerError('model_unavailable', 'This worker model is no longer enabled. Its private edits remain retained.');
    }
    if (session.permission === 'workspace-write' && policy.allowWrite === false) {
      throw new WorkerError('permission_denied', 'This model no longer permits worker writes.');
    }
  }

  /** The constructor identity is trusted; editable tool arguments cannot replace it. */
  scoped(session: Session): WorkspaceTools {
    if (!session.isolatedView || (session.schema !== 2 && session.schema !== 3) || !session.ownerId) {
      throw new WorkerError('isolation_unavailable', 'A private worker requires its permanent binding and owner identity.');
    }
    const identity: IsolatedViewIdentity = { ownerId: session.ownerId, workerId: session.id, workerCreatedAt: session.createdAt };
    const binding = { ...session.isolatedView };
    const port: IsolatedViewPort = {
      withView: async (...args) => (await this.open()).withView(...args),
      edit: async (...args) => (await this.open()).edit(...args),
      seal: async (...args) => (await this.open()).seal(...args),
      withSealedInput: async (...args) => (await this.open()).withSealedInput(...args),
      status: async (...args) => (await this.open()).status(...args)
    };
    const guard = this.workerGuard(session);
    const runner = {
      enabled: () => this.runnerEnabled(),
      available: () => this.runnerAvailable(),
      execute: (input: unknown, signal: AbortSignal, authorize?: () => void): Promise<string> =>
        this.runBoundCommand(session, binding, identity, port, input, signal, authorize)
    };
    const files = new IsolatedWorkspaceTools(this.root, port, binding, identity, session.permission, { canWrite: this.options.canWrite, guard, runner });
    return {
      workspaceRoot: this.root,
      definitions: permission => {
        guard();
        return [...files.definitions(permission), { name: 'seal_submission', description: 'Seal an exact expected private revision as an immutable submission. Later edits leave it unchanged. This does not validate, accept or integrate work.', inputSchema: z.toJSONSchema(sealSchema) }];
      },
      execute: async (name, input, permission, signal, _session, authorize) => {
        if (name === 'seal_submission') {
          const operationGuard = this.workerGuard(session, authorize, signal);
          operationGuard();
          const result = await port.seal(binding, identity, sealSchema.parse(input), operationGuard);
          return JSON.stringify(result);
        }
        return files.execute(name, input, permission, signal, undefined, authorize);
      }
    };
  }

  /**
   * The live policy chain for one bound command. It is deliberately built
   * WITHOUT the command's abort signal: the runner rechecks it after an approval
   * and again at the actual spawn, and a cancelled command must be able to
   * recheck policy (for instance to import partial changes) rather than be
   * reported as a denial.
   */
  private runnerAuthorize(session: Session, engineAuthorize?: () => void): () => void {
    return () => {
      if (!this.runnerEnabled()) {
        throw new WorkerError('feature_disabled', 'Physical runner execution is disabled; enable codexSubagent.isolatedViews.runners.enabled in User Settings.');
      }
      // Host lifetime, parent feature flags, the engine's live model check, the
      // CURRENT Session identity and permanent binding, and team membership.
      this.workerGuard(session, engineAuthorize)();
      const current = this.store.get(session.id);
      if (current.permission !== 'workspace-write' || session.permission !== 'workspace-write' || !this.options.canWrite()) {
        throw new WorkerError('permission_denied', 'Shell execution requires a workspace-write worker.');
      }
      if (!this.shellAllowed()) {
        throw new WorkerError('permission_denied', 'Shell commands are disabled by the global model policy.');
      }
      if (this.options.approveCommand === undefined) {
        throw new WorkerError('permission_denied', 'Shell execution requires a command approval surface.');
      }
      const policy = this.options.settings().models?.[current.model.id];
      if (policy?.allowShell === false) {
        throw new WorkerError('permission_denied', `Model '${current.model.id}' no longer allows shell commands.`);
      }
    };
  }

  /** Runs one approved command through the physical runner for this worker. */
  private async runBoundCommand(
    session: Session,
    binding: IsolatedViewBinding,
    identity: IsolatedViewIdentity,
    port: IsolatedViewPort,
    input: unknown,
    signal: AbortSignal,
    engineAuthorize?: () => void
  ): Promise<string> {
    const args = fileToolSchemas.run_command.parse(input);
    const authorize = this.runnerAuthorize(session, engineAuthorize);
    authorize();
    const manager = await this.openRunners();
    // The open is an await: recheck the live policy before the command is
    // queued, and let the runner itself recheck again after approval.
    authorize();
    const result = await manager.execute(binding, identity, port, { command: args.command, path: args.path, timeoutMs: args.timeoutMs }, signal, authorize);
    if (result.outcome === 'denied') {
      throw new WorkerError('command_denied', `${result.diagnostic ?? 'The command was not approved.'} Runner result ${result.id} is recorded.`);
    }
    // The complete immutable record (command, setup identity, URN, versions,
    // exit/output fields) is returned as stored; the two convenience booleans
    // are derived here only because they are the tool-call vocabulary.
    return JSON.stringify({ ...result, resultId: result.id, timedOut: result.outcome === 'timed_out', cancelled: result.outcome === 'cancelled' });
  }

  // -- runner observation and reconciliation -----------------------------------

  private runnerSummary(manager: RunnerExecution | undefined, enabled: boolean): Record<string, unknown> {
    const config = this.runnerConfig();
    let status: ReturnType<RunnerExecution['status']> | undefined;
    let error: string | undefined;
    if (manager) {
      try {
        status = manager.status();
      } catch (problem) {
        error = problem instanceof Error ? problem.message : String(problem);
      }
    }
    const pool = status?.pool ?? null;
    return {
      enabled,
      open: status?.open === true,
      capacity: pool?.capacity ?? config.capacity,
      maxQueue: pool?.maxQueue ?? config.maxQueue,
      activeCount: pool === null ? 0 : pool.slots.filter(slot => slot.state === 'active').length,
      quarantinedCount: pool === null ? 0 : pool.slots.filter(slot => slot.state === 'quarantined').length,
      queueLength: pool?.queue.length ?? 0,
      resultCount: status?.results?.results ?? 0,
      pendingCount: status?.results?.pending ?? 0,
      ...(error === undefined ? {} : { error })
    };
  }

  private page<T>(rows: readonly T[], offset: number, limit: number): { items: T[]; nextOffset: number | null } {
    const items = rows.slice(offset, offset + limit);
    const end = offset + items.length;
    return { items, nextOffset: end < rows.length ? end : null };
  }

  /**
   * Owner+team scoped, bounded runner state. Never returns another owner's
   * identity, a raw lease journal or a full command output, and reading it never
   * starts, kills or replays anything.
   */
  private async runnerStatus(args: RunnerStatusArgs): Promise<unknown> {
    // Never creates storage that does not exist: an unused feature leaves no trace.
    const manager = await this.runnerStore();
    const scope = { ownerId: args.ownerId, teamId: args.teamId };
    this.board.assertTeam(scope.ownerId, scope.teamId);
    const summary = this.runnerSummary(manager, this.runnerEnabled());
    let pool: RunnerPoolStatus | null = null;
    if (manager) {
      try {
        pool = manager.status().pool;
      } catch {
        pool = null;
      }
    }
    if (args.kind === 'results') {
      if (!manager) {
        return { kind: args.kind, summary, items: [], total: 0, nextOffset: null };
      }
      const results = manager.results.list(scope, args.offset, args.limit);
      return {
        kind: args.kind,
        summary,
        items: results.results.map(result => ({
          id: result.id,
          uri: result.uri,
          workerId: result.attempt.owner.workerId,
          workerCreatedAt: result.attempt.owner.workerCreatedAt,
          outcome: result.outcome,
          import: result.import,
          version: result.version,
          exitCode: result.exitCode,
          signal: result.signal,
          truncated: result.truncated,
          drained: result.drained,
          startedAt: result.attempt.startedAt,
          completedAt: result.completedAt,
          inputVersion: result.attempt.inputVersion,
          afterVersion: result.afterVersion,
          outputPreview: preview(result.output),
          diagnosticPreview: preview(result.diagnostic)
        })),
        total: results.total,
        nextOffset: results.nextOffset
      };
    }
    const owned = pool === null ? [] : pool.leases
      .filter(record => record.owner.ownerId === scope.ownerId && record.owner.teamId === scope.teamId)
      .sort((a, b) => a.sequence - b.sequence);
    const rows: (RunnerLeaseRow | { position: number; workerId: string; workerCreatedAt: string })[] = args.kind === 'queue'
      ? (pool === null ? [] : pool.queue
        .filter(entry => entry.owner.ownerId === scope.ownerId && entry.owner.teamId === scope.teamId)
        .map(entry => ({ position: entry.position, workerId: entry.owner.workerId, workerCreatedAt: entry.owner.workerCreatedAt })))
      : owned.map(record => ({
        id: record.leaseId,
        slot: record.slot,
        state: record.state,
        phase: record.phase,
        retained: record.preserve,
        hasProcessIdentity: record.process !== null,
        owner: { workerId: record.owner.workerId, workerCreatedAt: record.owner.workerCreatedAt },
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.diagnostic === undefined ? {} : { diagnostic: preview(record.diagnostic) })
      }));
    return { kind: args.kind, summary, ...this.page(rows, args.offset, args.limit) };
  }

  /**
   * One immutable result plus a clearly SEPARATE freshness reading. The stored
   * record is returned untouched; `currentRevision`/`inputIsCurrent` are null
   * whenever the live private view is not available (it is never opened just for
   * this read), so a released, missing or corrupt overlay is never reported as
   * current and no success is ever claimed from a stale command.
   */
  private async runnerResult(args: { ownerId: string; teamId: string; id: string }): Promise<unknown> {
    const manager = await this.runnerStore();
    this.board.assertTeam(args.ownerId, args.teamId);
    if (!manager) {
      throw new WorkerError('runner_results_not_found', 'No runner result store exists for this workspace yet.');
    }
    const result = manager.results.get(args.id, { ownerId: args.ownerId, teamId: args.teamId });
    const derived = await this.runnerRevision(result);
    return {
      result,
      version: result.version,
      currentRevision: derived.revision,
      inputIsCurrent: derived.current,
      stale: derived.current === null ? null : !derived.current
    };
  }

  private async runnerRevision(result: RunnerCommandResult): Promise<{ revision: number | null; current: boolean | null }> {
    if (!this.views) {
      // The private index is deliberately not loaded for a runner read.
      return { revision: null, current: null };
    }
    const owner = result.attempt.owner;
    const binding = { teamId: owner.teamId, snapshotId: result.attempt.inputVersion.snapshotId, overlayId: result.attempt.inputVersion.overlayId };
    const identity = { ownerId: owner.ownerId, workerId: owner.workerId, workerCreatedAt: owner.workerCreatedAt };
    try {
      const overlay = await this.views.status(binding, identity, this.runnerLifetimeGuard);
      if (overlay.released || overlay.overlayId !== binding.overlayId || overlay.snapshotId !== binding.snapshotId) {
        return { revision: null, current: null };
      }
      return { revision: overlay.revision, current: overlay.revision === result.attempt.inputVersion.revision };
    } catch {
      return { revision: null, current: null };
    }
  }

  /**
   * Explicit, scoped, naturally idempotent reconciliation. No requestId is
   * needed and no command is ever executed or replayed; the pool retains every
   * unknown or unprovable identity. This is the only runner tool that may discard
   * runner directories and drain processes this run still owns.
   */
  private async runnerCleanup(args: { ownerId: string; teamId: string }): Promise<unknown> {
    const manager = await this.runnerStore();
    // Re-assert membership after the awaited open, immediately before acting.
    this.board.assertTeam(args.ownerId, args.teamId);
    if (!manager) {
      return {
        complete: true, opened: false, discarded: [], discardedCount: 0,
        retained: [], retainedCount: 0, unknownEntries: [], unknownCount: 0
      };
    }
    const result: RunnerPoolCleanupResult = await manager.cleanup({ ownerId: args.ownerId, teamId: args.teamId });
    return {
      complete: true,
      opened: true,
      discarded: result.discarded.slice(0, 20),
      discardedCount: result.discarded.length,
      retained: result.retained.slice(0, 20).map(entry => ({ leaseId: entry.leaseId, reason: preview(entry.reason) })),
      retainedCount: result.retained.length,
      unknownEntries: result.unknownEntries.slice(0, 20),
      unknownCount: result.unknownEntries.length
    };
  }

  async invoke(name: IsolatedViewToolName, input: unknown, engine: WorkerEngine, signal?: AbortSignal): Promise<ToolResult> {
    this.commitGuard();
    const args = isolatedViewSchemas[name].parse(input);
    await this.board.open();
    const operationSignal = isSlowViewTool(name) ? AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(360_000)]) : signal;
    const guard = (): void => {
      operationSignal?.throwIfAborted();
      this.commitGuard();
      this.board.assertTeam(args.ownerId, args.teamId);
    };
    guard();
    // Runner observation and reconciliation are answered from the runner store
    // alone. They branch BEFORE private view storage is opened, so existing
    // metadata, results and cleanup stay available when the private file index
    // is missing, unloaded or corrupt, and they never load it just to read.
    if (name === 'subagent_runner_status') {
      const a = isolatedViewSchemas.subagent_runner_status.parse(input);
      this.board.assertTeam(a.ownerId, a.teamId);
      return viewResponse(await this.runnerStatus(a));
    }
    if (name === 'subagent_runner_result') {
      const a = isolatedViewSchemas.subagent_runner_result.parse(input);
      this.board.assertTeam(a.ownerId, a.teamId);
      return viewResponse(await this.runnerResult(a));
    }
    if (name === 'subagent_runner_cleanup') {
      const a = isolatedViewSchemas.subagent_runner_cleanup.parse(input);
      this.board.assertTeam(a.ownerId, a.teamId);
      return viewResponse(await this.runnerCleanup(a));
    }
    const views = await this.open();
    if (name === 'subagent_snapshot_create') {
      const a = isolatedViewSchemas.subagent_snapshot_create.parse(input);
      const selectionKey = digest(a.selectedUntracked === undefined ? { mode: 'default' } : { mode: 'selected', paths: [...new Set(a.selectedUntracked)].sort() });
      const snapshot = await views.createSnapshot({ ownerId: a.ownerId, teamId: a.teamId, requestId: a.requestId, selectionKey }, (snapshotId, beforePublish) =>
        captureProject(this.root, views.content, { snapshotId, namespace: views.namespace, selectedUntracked: a.selectedUntracked, openDocuments: this.options.openDocuments, beforePublish, guard }), guard);
      return viewResponse({ id: snapshot.id, teamId: snapshot.teamId, createdAt: snapshot.createdAt, manifestHash: snapshot.manifestHash });
    }
    if (name === 'subagent_view_bind') {
      const a = isolatedViewSchemas.subagent_view_bind.parse(input);
      engine.assertOwner(a.id, a.ownerId);
      const result = await engine.edit(a.id, async (session, maintenanceSignal) => {
        const bindingGuard = (): void => {
          guard();
          maintenanceSignal.throwIfAborted();
          const current = this.store.get(a.id);
          if (current.createdAt !== session.createdAt || current.ownerId !== a.ownerId || current.workspaceRoot !== this.root) {
            throw new WorkerError('owner_mismatch', 'The worker instance changed while binding.');
          }
          this.assertWorkerPolicy(current);
          this.board.assertTeam(a.ownerId, a.teamId, a.id);
        };
        bindingGuard();
        return views.bind({ ownerId: a.ownerId, teamId: a.teamId, snapshotId: a.snapshotId, workerId: a.id, workerCreatedAt: session.createdAt, requestId: a.requestId }, async marker => {
          await this.store.change(a.id, draft => {
            if (draft.isolatedView && !sameBinding(draft.isolatedView, marker)) {
              throw new WorkerError('isolation_conflict', 'This worker already has a permanent binding to another snapshot.');
            }
            if (draft.startup && (draft.startup.snapshotId !== marker.snapshotId || draft.startup.teamId !== marker.teamId)) {
              throw new WorkerError('isolation_conflict', 'Governed setup cannot bind a different team or snapshot.');
            }
            draft.schema = draft.startup ? 3 : 2;
            draft.isolatedView = { ...marker };
          }, bindingGuard);
        }, bindingGuard);
      }, { kind: 'isolation', activity: 'Binding private view' });
      return viewResponse(result);
    }
    if (name === 'subagent_view_seal') {
      const a = isolatedViewSchemas.subagent_view_seal.parse(input);
      engine.assertOwner(a.id, a.ownerId);
      const session = this.store.get(a.id);
      if (!session.isolatedView || session.isolatedView.teamId !== a.teamId) {
        throw new WorkerError('isolation_unavailable', 'The worker has no private view in this team.');
      }
      const workerGuard = this.workerGuard(session, guard, operationSignal);
      return viewResponse(await views.seal(session.isolatedView, { ownerId: a.ownerId, workerId: a.id, workerCreatedAt: session.createdAt }, a, workerGuard));
    }
    if (name === 'subagent_view_status') {
      const a = isolatedViewSchemas.subagent_view_status.parse(input);
      const status = await views.inspect(a.ownerId, a.teamId);
      guard();
      const rows = status[a.kind];
      const end = a.offset + a.limit;
      return viewResponse({ revision: status.revision, kind: a.kind, items: rows.slice(a.offset, end).map(record => {
        if ('manifestHash' in record) {
          const { id, teamId, ownerId, manifestHash, createdAt } = record;
          return { id, teamId, ownerId, manifestHash, createdAt };
        }
        return record;
      }), nextOffset: end < rows.length ? end : null });
    }
    if (name === 'subagent_submission_read') {
      const a = isolatedViewSchemas.subagent_submission_read.parse(input);
      const result = await views.withSubmission(a.ownerId, a.teamId, a.submissionId, view => executeViewRead(a.operation, a.input, view, guard), guard);
      return { content: [{ type: 'text', text: result }] };
    }
    if (name === 'subagent_view_pin') {
      return viewResponse(await views.pin(isolatedViewSchemas.subagent_view_pin.parse(input), guard));
    }
    if (name === 'subagent_view_release') {
      return viewResponse(await this.withReferences(retained => views.release(isolatedViewSchemas.subagent_view_release.parse(input), guard, id => this.presence(id), retained)));
    }
    return viewResponse(await this.withReferences(retained => views.cleanup(isolatedViewSchemas.subagent_view_cleanup.parse(input), id => this.presence(id), guard, retained)));
  }

  async hasReceipt(name: string, input: unknown): Promise<boolean> {
    if (!input || typeof input !== 'object') {
      return false;
    }
    const a = input as Record<string, unknown>;
    if (typeof a.ownerId !== 'string' || typeof a.requestId !== 'string') {
      return false;
    }
    if (!this.views && !await fs.lstat(path.join(this.store.directory, 'isolated-views', 'index.json')).then(() => true, () => false)) {
      return false;
    }
    const views = await this.open(); let key: string | undefined;
    if (name === 'subagent_snapshot_create') {
      key = digest(['create', views.namespace, a.ownerId, a.requestId]);
    } else if (name === 'subagent_view_pin') {
      key = digest(['pin', views.namespace, a.ownerId, a.teamId, a.requestId]);
    } else if (typeof a.id === 'string') {
      let session: Session;
      try {
        session = this.store.get(a.id);
      } catch {
        return false;
      }
      if (name === 'subagent_view_bind') {
        key = digest(['bind', views.namespace, session.id, session.createdAt, a.requestId]);
      } else if (name === 'subagent_view_seal' && session.isolatedView) {
        key = digest(['seal', views.namespace, session.isolatedView.overlayId, a.ownerId, a.requestId]);
      }
    }
    return key !== undefined && views.hasReceipt(key);
  }
  async assertEvidence(input: { ownerId: string; teamId: string; uri: string }, engine: WorkerEngine, signal?: AbortSignal): Promise<void> {
    if (input.uri.startsWith('urn:codex-runner-result:')) {
      const manager = await this.runnerStore();
      const id = input.uri.split(':').at(-1)!;
      if (!manager || manager.results.get(id, { ownerId: input.ownerId, teamId: input.teamId }).uri !== input.uri) {
        throw new WorkerError('retention_missing', 'Result is unavailable in this scope.');
      }
    } else if (input.uri.startsWith('codex-subagent://submission/')) {
      const views = await this.open(); const parts = input.uri.split('/');
      const id = parts.at(-2)!;
      await views.withSubmission(input.ownerId, input.teamId, id, (_view, submission) => {
        if (submission.uri !== input.uri) {
          throw new WorkerError('retention_missing', 'Submission URI/version differs.');
        }
      });
    }
    void engine; signal?.throwIfAborted();
  }
  private async withReferences<T>(action: (uris: () => ReadonlySet<string>) => Promise<T>): Promise<T> {
    const governed = await this.store.hasGovernedHistory() || await this.evidence.exists() || this.options.governanceEnabled?.() === true;
    if (!governed) {
      return action(() => new Set());
    }
    return this.evidence.withReferences(pins => this.board.open().then(board => board.withReferences(async references => {
      const retained = new Set([...pins, ...references]);
      const manager = await this.runnerStore();
      // Resolve runner edges only after the view mutex is acquired. A command
      // can publish its pending record while this cleanup waits for that mutex.
      return action(() => {
        const current = this.runners ?? manager;
        return current ? current.results.inputReferences(retained) : retained;
      });
    })));
  }
  async collectResources(scope: { ownerId: string; teamId: string }, ids: readonly string[], retained: ReadonlySet<string>): Promise<unknown> {
    this.commitGuard(); await this.board.open(); this.board.assertTeam(scope.ownerId, scope.teamId);
    const manager = await this.runnerStore();
    if (!manager) {
      return { removed: [], retained: [], leases: 0 };
    }
    const activeWorkers = new Set(this.store.list().filter(s => ['queued', 'running'].includes(s.state)).map(s => digest([s.id, s.createdAt])));
    const board = await this.board.open();
    for (const task of board.snapshot().tasks) {
      if (task.assigneeWorkerId && ['ready', 'in_progress', 'submitted', 'validating'].includes(task.state)) {
        activeWorkers.add(task.assigneeWorkerId);
      }
    }
    // PROOF BEFORE DELETION. A durable result is the only exact evidence that a
    // specific sealed submission was auto-sealed for one command, and this
    // collection deletes that evidence. Each authorized, still-existing exact
    // result id therefore proves its input first, durably and inside the view
    // mutex, so the marker sweep below can resume with no ids - and after a
    // crash, a throw or a reopen - even though the result is already gone. Only
    // runner_results_not_found is skipped: a scope denial or any other failure
    // still propagates before anything is deleted.
    const views = await this.open();
    const proofs: { id: string; uri: string }[] = [];
    for (const id of new Set(ids)) {
      let result: RunnerCommandResult;
      try {
        result = manager.results.get(id, scope);
      } catch (error) {
        if (error instanceof WorkerError && error.code === 'runner_results_not_found') {
          continue;
        }
        throw error;
      }
      const artifact = result.attempt.inputArtifact;
      if (artifact !== undefined) {
        proofs.push({ id: artifact.id, uri: artifact.uri });
      }
    }
    await views.proveRunnerInputs(scope, proofs, this.commitGuard);
    const outcome = await manager.collect(scope, ids, retained, activeWorkers) as { removed: RunnerCommandResult[] };
    // ONE marker sweep now handles the lifecycle leak, and it runs even with no
    // result id at all: an abandoned governed setup can seal its exact input and
    // fail before any attempt record owns it, and a collected result's input is
    // proven above. Fresh references are resolved INSIDE the view mutex, after
    // this collection committed, from the caller-held board/evidence references
    // plus every durable pending/final attempt (adopted at their write commit
    // point), and the sweep preserves native view pins itself. It commits one
    // index update with no receipt, so a full receipt map cannot fail
    // reclamation after a result was deleted.
    const reclaimed = await views.reclaimInputs(scope, () => manager.results.inputReferences(retained), this.commitGuard);
    return { ...outcome, reclaimed, removed: outcome.removed.map(result => ({ id: result.id, uri: result.uri, inputArtifact: result.attempt.inputArtifact })) };
  }
  async assertWorkerUsable(session: Session, signal?: AbortSignal): Promise<void> {
    this.commitGuard();
    await this.board.open();
    // Control operations use the engine's exact model selection/recovery
    // policy. Checking the old model here would prevent explicit migration
    // from a revoked model before the engine can select its enabled target.
    const guard = this.workerGuard(session, undefined, signal, false);
    guard();
    const identity = { ownerId: session.ownerId!, workerId: session.id, workerCreatedAt: session.createdAt };
    await (await this.open()).status(session.isolatedView!, identity, guard);
  }

  private async presence(id: string): Promise<WorkerViewPresence> {
    try {
      const session = this.store.get(id);
      return { state: 'present', workerCreatedAt: session.createdAt, binding: session.isolatedView };
    } catch (error) {
      if (!(error instanceof WorkerError) || error.code !== 'not_found') {
        throw error;
      }
    }
    try {
      // Unloaded/quarantined/corrupt existing files are UNKNOWN, not deleted.
      await fs.lstat(path.join(this.store.directory, `${id}.json`));
      return { state: 'unknown' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: 'missing' };
      }
      return { state: 'unknown' };
    }
  }
}
