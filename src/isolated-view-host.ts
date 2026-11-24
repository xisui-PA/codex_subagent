import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IsolatedViews, WorkerViewPresence } from './isolated-views';
import type { SnapshotInspection } from './isolated-views';
import { IsolatedWorkspaceTools, executeViewRead } from './isolated-workspace-tools';
import { isolatedViewSchemas, IsolatedViewToolName, isSlowViewTool, viewResponse } from './isolated-view-tools';
import type { IntegrationArtifactRef, IntegrationScope, IsolatedViewBinding, SealedSubmission } from './isolated-view-types';
import type { IsolatedViewIdentity, IsolatedViewPort, IsolatedViewState } from './isolated-view-port';
import { fileModeOf } from './snapshot-content';
import type { OpenDocument, SnapshotEntry, SnapshotManifest } from './snapshot-content';
import { IntegrationAttempts } from './integration-attempts';
import type { EvidenceCheck, IntegrationAction, IntegrationAttemptRef } from './integration-attempts';
import { publishIntegration, type IntegrationPublicationOptions } from './integration-publication';
import type { PublicationChange, PublicationEntry } from './integration-publication';
import type { TaskBoard } from './task-board';
import { captureProject } from './project-snapshot';
import { RunnerExecution } from './runner-execution';
import type { RunnerCommandResult } from './runner-results';
import { RUNNER_POOL_MAX_CAPACITY, type RunnerPoolCleanupResult, type RunnerPoolStatus } from './runner-pool';
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

/** Plan publication from the CAPTURED original base and the private candidate. */
interface PublicationPlan {
  changes: PublicationChange[];
  conflicts: { path: string; reason: string }[];
}

/** Component names publication may never write, exactly as the adapter's rules. */
const PUBLICATION_PROTECTED: ReadonlySet<string> = new Set(['.git', '.codex', '.vscode']);
const INTEGRATION_RESULT_PREFIX = 'urn:codex-runner-result:';

const ownEntry = (entries: Readonly<Record<string, SnapshotEntry>>, key: string): SnapshotEntry | undefined =>
  (Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined);

/** Raw effective identity of one entry: file bytes/mode, or its exact kind. */
function sameRawEntry(before: SnapshotEntry | undefined, after: SnapshotEntry | undefined): boolean {
  if (before === undefined || after === undefined) {
    return before === after;
  }
  if (before.type === 'file' && after.type === 'file') {
    return before.hash === after.hash && before.size === after.size && fileModeOf(before) === fileModeOf(after);
  }
  if (before.type === 'file' || after.type === 'file') {
    return false;
  }
  return before.type === after.type && (before.type === 'directory' || (after.type !== 'directory' && before.detail === after.detail));
}

const publicationEntry = (entry: SnapshotEntry | undefined): PublicationEntry =>
  (entry === undefined || entry.type !== 'file' ? null : { type: 'file', hash: entry.hash, size: entry.size, mode: fileModeOf(entry) });

/**
 * The captured base records which paths it took from an EDITOR BUFFER. An absent
 * field is UNKNOWN provenance (manifests written before the field, or a derived
 * seed): raw-disk changes cannot then be proven, so they are refused instead of
 * overwriting bytes the user never saved. `[]` means every captured path is raw
 * disk.
 */
function capturedEditorPaths(manifest: SnapshotManifest): ReadonlySet<string> | undefined {
  const value = (manifest as unknown as { editorPaths?: unknown }).editorPaths;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    return undefined;
  }
  return new Set(value);
}

/**
 * Compare the CAPTURED original base with the private candidate, as RAW
 * effective file entries. Only a regular file can be created, replaced or
 * deleted: directories, unsupported/excluded entries, protected configuration
 * directories, case-only aliases and editor-derived provenance are explicit
 * conflicts, so an ambiguous integration is never published.
 */
export function publicationPlan(base: SnapshotManifest, candidate: IsolatedViewState): PublicationPlan {
  const baseEntries = base.entries;
  const candidateEntries = candidate.tree.entries;
  const editorPaths = capturedEditorPaths(base);
  const keys = [...new Set([...Object.getOwnPropertyNames(baseEntries), ...Object.getOwnPropertyNames(candidateEntries)])].sort();
  const conflicts: { path: string; reason: string }[] = [];
  const pending: PublicationChange[] = [];
  const changed: string[] = [];
  for (const key of keys) {
    const before = ownEntry(baseEntries, key);
    const after = ownEntry(candidateEntries, key);
    if (sameRawEntry(before, after)) {
      continue;
    }
    changed.push(key);
    if ((before !== undefined && before.type !== 'file') || (after !== undefined && after.type !== 'file')) {
      const kinds = [before?.type ?? 'absent', after?.type ?? 'absent'].join(' -> ');
      conflicts.push({ path: key, reason: `unsupported change: only regular files can be published (${kinds}).` });
      continue;
    }
    if (key.split('/').some(segment => PUBLICATION_PROTECTED.has(segment.toLowerCase()))) {
      conflicts.push({ path: key, reason: 'protected path: configuration directories are never published.' });
      continue;
    }
    if (editorPaths === undefined) {
      conflicts.push({ path: key, reason: 'unknown provenance: the captured base records no editor-override set, so raw-disk bytes cannot be proven for this change.' });
      continue;
    }
    if (editorPaths.has(key)) {
      conflicts.push({ path: key, reason: 'editor override: this change was captured from an unsaved buffer, not from raw disk.' });
      continue;
    }
    pending.push({ path: key, before: publicationEntry(before), after: publicationEntry(after) });
  }
  // A case-only alias pair in the FINAL namespace cannot be published portably.
  // It is checked against the resolved namespace, so adding `a.txt` beside an
  // unchanged captured `A.txt` conflicts instead of silently shadowing it.
  const finalKeys = new Set<string>(Object.getOwnPropertyNames(baseEntries));
  for (const key of Object.getOwnPropertyNames(candidateEntries)) {
    finalKeys.add(key);
  }
  const changedSet = new Set(changed);
  const folded = new Map<string, string[]>();
  for (const key of finalKeys) {
    const lower = key.toLowerCase();
    folded.set(lower, [...(folded.get(lower) ?? []), key]);
  }
  for (const group of folded.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const key of group) {
      if (changedSet.has(key)) {
        conflicts.push({ path: key, reason: `case-only alias: ${group.join(', ')} differ only by case and cannot be published portably.` });
      }
    }
  }
  const aliased = new Set(conflicts.map(conflict => conflict.path));
  return {
    changes: pending.filter(change => !aliased.has(change.path)),
    conflicts
  };
}

/** Owner+team key of one integration deletion fence; NUL cannot appear in an id. */
const integrationFenceKey = (ownerId: string, teamId: string): string => `${ownerId}\u0000${teamId}`;

/** Bounded, printable internal pin name; the attempt key namespace keeps it exact. */
const integrationPinName = (index: number, ref: IntegrationArtifactRef): string =>
  `integration/${index}/${ref.id}/${ref.version}`;

/** Lazy lifecycle handle, always drained before its SessionStore owner unlocks. */
export class IsolatedViewHost {
  readonly evidence: EvidenceRetention;
  private views?: IsolatedViews;
  private opening?: Promise<IsolatedViews>;
  private runners?: RunnerExecution;
  private openingRunners?: Promise<RunnerExecution>;
  private integration?: IntegrationAttempts;
  private openingIntegration?: Promise<IntegrationAttempts>;
  /** Synchronous per-owner/team deletion fences; see reserveIntegrationScope. */
  private readonly integrationDeleteFences = new Map<string, number>();
  /**
   * Synchronously counted integration ACTIONS that have entered and not yet
   * drained, per owner/team. It is registered before the first await of
   * `integrate`, so a manual deletion can never observe a scope as idle while an
   * action is still on its way in.
   */
  private readonly integrationInflight = new Map<string, number>();
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
      /** Live integration opt-in; absent keeps every coordinator integration action off. */
      integrationEnabled?: () => boolean;
      /**
       * Every open file-backed and associated untitled buffer in the owning
       * window. Publication refuses to write while a touched path may be open in
       * an editor, so an ABSENT enumeration fails apply closed instead of
       * silently editing a buffer the user cannot see.
       */
      publicationDocuments?: () => OpenDocument[];
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
      // Order matters, and it starts with integration: its service writes the
      // durable attempt ledger through this store and answers from the runner and
      // view stores, so invoke()'s own mutex and close() must drain BEFORE either
      // of them is closed and before the caller unlocks the store owner. A
      // rejection propagates so that lock is retained instead of being released
      // under work that may still run.
      const sessions = this.openingIntegration
        ? await this.openingIntegration.then(service => service, () => undefined)
        : this.integration;
      await sessions?.close();
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
        || (current.mode !== 'isolated' && current.mode !== 'governed') || !current.isolatedView || !original.isolatedView || !sameBinding(current.isolatedView, original.isolatedView)) {
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
    if (!session.isolatedView || (session.mode !== 'isolated' && session.mode !== 'governed') || !session.ownerId) {
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

  async invoke(name: IsolatedViewToolName, input: unknown, engine: WorkerEngine, signal?: AbortSignal, recoveryError?: WorkerError): Promise<ToolResult> {
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
    if (name === 'subagent_integration') {
      // Coordinator integration is answered by its own durable service, never by
      // a saved/offline store and never by a public pin name. The service mutex
      // already serializes actions and its close() drains them, and the invoke
      // guard (operation abort + live host/flag/team checks) is carried into
      // EVERY port side effect.
      const a = isolatedViewSchemas.subagent_integration.parse(input) as IntegrationAction;
      this.board.assertTeam(a.ownerId, a.teamId);
      return viewResponse(await this.integrate(a, guard, recoveryError));
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
        // The internal startup lane comes from the REAL Session's durable startup
        // record of this exact worker, never from the request, and it is only
        // passed while that startup names exactly this team and snapshot. A
        // conflicted derived seed is therefore bindable only by its governed
        // integration-lane startup; every ordinary bind is unaffected.
        const startup = this.store.get(a.id).startup;
        const startupIdentity = startup === undefined ? undefined : {
          lane: startup.lane,
          teamId: startup.teamId,
          snapshotId: startup.snapshotId
        };
        return views.bind({ ownerId: a.ownerId, teamId: a.teamId, snapshotId: a.snapshotId, workerId: a.id, workerCreatedAt: session.createdAt, requestId: a.requestId }, async marker => {
          await this.store.change(a.id, draft => {
            if (draft.isolatedView && !sameBinding(draft.isolatedView, marker)) {
              throw new WorkerError('isolation_conflict', 'This worker already has a permanent binding to another snapshot.');
            }
            if (draft.startup && (draft.startup.snapshotId !== marker.snapshotId || draft.startup.teamId !== marker.teamId)) {
              throw new WorkerError('isolation_conflict', 'Governed setup cannot bind a different team or snapshot.');
            }
            // Binding promotes the ONE current record in place: a governed
            // setup stays governed, an ordinary standalone worker becomes
            // isolated, and the schema literal never changes.
            draft.mode = draft.startup ? 'governed' : 'isolated';
            draft.isolatedView = { ...marker };
          }, bindingGuard);
        }, bindingGuard, startupIdentity);
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
  /**
   * Narrow governed-startup PREFLIGHT of the ONE bind-time lane rule, answered
   * BEFORE a fresh worker is created and before the ready board task is assigned.
   * It publishes nothing and creates nothing, so a work- or validation-lane
   * startup aimed at a derived seed with unresolved conflict groups is refused
   * without stranding an assignment; the bind itself re-proves the same rule under
   * the view mutex from the real Session startup.
   */
  async preflightStartupBind(
    ownerId: string, teamId: string, snapshotId: string, lane: 'work' | 'validation' | 'integration', signal?: AbortSignal
  ): Promise<void> {
    this.commitGuard();
    signal?.throwIfAborted();
    const views = await this.open();
    signal?.throwIfAborted();
    await views.assertStartupBindable(ownerId, teamId, snapshotId, lane, () => {
      signal?.throwIfAborted();
      this.commitGuard();
    });
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

  // -- coordinator integration -------------------------------------------------

  /** Live opt-in; absent keeps every integration action off. Read per decision. */
  private integrationEnabled(): boolean {
    return this.options.integrationEnabled?.() === true;
  }

  private get integrationDirectory(): string {
    return path.join(this.store.directory, 'integration');
  }

  /** Evidence metadata goes through the store write fence, never a nested lock. */
  private withStorage<T>(action: () => Promise<T>): Promise<T> {
    return this.options.withStorageWrite ? this.options.withStorageWrite(action) : action();
  }

  /**
   * Inspect this team's durable integration attempts for a manual deletion.
   *
   * A missing integration namespace is empty, so a workspace that never
   * integrated deletes normally. A present but unreadable ledger, or a present
   * ledger while integration is disabled, fails closed: the deletion cannot be
   * proven safe and nothing is guessed or bootstrapped.
   */
  /**
   * Synchronous deletion fence for one owner/team's integration scope.
   *
   * It is registered BEFORE the first await of the deletion, so the
   * feature-off/missing-namespace fast path is fenced exactly like the open
   * service: turning integration on in the middle of the deletion cannot let a
   * new `begin` compose from the record that is about to disappear.
   *
   * It also REFUSES (without installing a fence) while an integration action for
   * this scope has already entered. That action may already hold the service
   * mutex and be composing or applying, and a manual delete must never abort it:
   * because no fence is installed in that case, the running action's own live
   * authorization keeps passing and it drains normally. No queue and no polling:
   * a new entry that sees a held fence is simply refused.
   */
  reserveIntegrationScope(ownerId: string, teamId: string): () => void {
    const key = integrationFenceKey(ownerId, teamId);
    if (this.integrationDeleteFences.has(key)) {
      throw new WorkerError('board_deleting', 'Another deletion for this team is still being applied; retry after it finishes.', true);
    }
    if (this.integrationInflight.has(key)) {
      throw new WorkerError('integration_busy', 'An integration action for this team is still running, so the deletion was not started. Wait for it to finish (or use subagent_integration release), then retry; no integration work is stopped automatically.');
    }
    this.integrationDeleteFences.set(key, 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.integrationDeleteFences.delete(key);
    };
  }

  /**
   * Synchronously registers one entered integration action and returns its
   * idempotent release. Callers must invoke it before their first await and
   * release only after the action has really drained.
   */
  private enterIntegration(ownerId: string, teamId: string): () => void {
    const key = integrationFenceKey(ownerId, teamId);
    this.integrationInflight.set(key, (this.integrationInflight.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const left = (this.integrationInflight.get(key) ?? 1) - 1;
      if (left > 0) {
        this.integrationInflight.set(key, left);
      } else {
        this.integrationInflight.delete(key);
      }
    };
  }

  /** Refuse new integration work for a team whose record deletion is in flight. */
  private assertNoIntegrationFence(ownerId: string, teamId: string): void {
    if (this.integrationDeleteFences.has(integrationFenceKey(ownerId, teamId))) {
      throw new WorkerError('board_deleting', 'This team is being deleted; no integration attempt was begun or continued. Retry after the deletion finishes.', true);
    }
  }

  async withIntegrationScope<T>(
    ownerId: string, teamId: string,
    action: (attempts: readonly IntegrationAttemptRef[]) => T | Promise<T>
  ): Promise<T> {
    // Host lifetime only: a board-only workspace (private views off) must still
    // be able to delete, so this never consults the views feature flag. The
    // integration opt-in is consulted separately below.
    this.runnerLifetimeGuard();
    // Registered synchronously, before ANY await, and held across the whole
    // inspection + deletion commit.
    const release = this.reserveIntegrationScope(ownerId, teamId);
    try {
      if (this.integration) {
        return await this.integration.inspectScope(ownerId, teamId, action);
      }
      if (this.openingIntegration) {
        return await (await this.openingIntegration).inspectScope(ownerId, teamId, action);
      }
      if (!this.integrationEnabled()) {
        if (await this.integrationDirectoryPresent()) {
          throw new WorkerError('feature_disabled', 'Integration attempts exist for this workspace, so this deletion cannot be proven safe while integration is disabled. Enable codexSubagent.isolatedViews.integration.enabled, release this team\'s attempt with subagent_integration release, then retry; no attempt or pin is released automatically.');
        }
        return await action([]);
      }
      const service = await this.openIntegration(() => {
        this.runnerLifetimeGuard();
        if (!this.integrationEnabled()) {
          throw new WorkerError('feature_disabled', 'Integration was disabled before this deletion was inspected.');
        }
      });
      return await service.inspectScope(ownerId, teamId, action);
    } finally {
      release();
    }
  }

  /** Absent only when nothing exists (ENOENT); any other inspection error fails closed. */
  private async integrationDirectoryPresent(): Promise<boolean> {
    try {
      await fs.lstat(this.integrationDirectory);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Refuse a deletion while this team still holds an unreleased runner lease.
   *
   * Runner leases are team-scoped and carry no task attribution, so a live lease
   * may belong to a validation worker whose result serves the task being
   * deleted. The only safe answer is to let it finish (or collect its result)
   * first: nothing is stopped automatically. A missing runner namespace is
   * empty; a present but unreadable one fails closed through `runnerStore()`.
   */
  async assertTeamRunnersIdle(teamId: string): Promise<void> {
    // Host lifetime only, exactly like runner metadata observation: the runner
    // EXECUTION flag never hides existing leases, so a disabled runner feature
    // with durable leases still refuses instead of deleting over live work.
    this.runnerLifetimeGuard();
    const runners = await this.runnerStore();
    if (!runners) {
      return;
    }
    const busy = (runners.status().pool?.leases ?? [])
      .filter(lease => lease.owner.teamId === teamId && lease.state !== 'released');
    if (busy.length) {
      throw new WorkerError('runner_busy', `Team ${teamId} still has ${busy.length} live or draining runner lease(s): ${busy.slice(0, 8).map(lease => `${lease.leaseId} (${lease.state})`).join(', ')}. Wait for them to finish or collect their results before deleting; no command is stopped automatically.`);
    }
  }

  /**
   * Live authorization for one integration action. `guard` is the invoke-level
   * check (operation abort + host/feature/team), so a revoked or aborted call is
   * refused at EVERY port side effect, not only when it entered. `apply`
   * additionally requires write access AND an owning-window document enumeration
   * BEFORE the durable applying intent exists: a publication that cannot be
   * guarded must never become an unresolved in-flight attempt that only release
   * could clear.
   */
  private integrationAuthorize(args: IntegrationAction, guard?: () => void): () => void {
    return () => {
      guard?.();
      this.commitGuard();
      // NO deletion-fence check here: an action that already entered owns its
      // lifetime and must drain. A deletion cannot install a fence in this scope
      // while the action is in flight (see reserveIntegrationScope), so the
      // evidence this guard proves is still valid for the record it started on.
      if (!this.integrationEnabled()) {
        throw new WorkerError('feature_disabled', 'Integration requires User Settings codexSubagent.taskBoard.enabled, codexSubagent.isolatedViews.enabled, codexSubagent.resources.enabled and codexSubagent.isolatedViews.integration.enabled.');
      }
      this.board.assertTeam(args.ownerId, args.teamId);
      if (args.action === 'apply') {
        if (!this.options.canWrite()) {
          throw new WorkerError('permission_denied', 'Publishing an accepted candidate requires live workspace write access; nothing was written.');
        }
        if (this.options.publicationDocuments === undefined) {
          throw new WorkerError('feature_disabled', 'Publishing requires the owning window document enumeration so open editors are never overwritten; nothing was written.');
        }
      }
    };
  }

  /**
   * One integration action. IntegrationAttempts.invoke already serializes every
   * action under its own mutex and close() drains them, so the host adds no
   * second queue. Every port re-runs this exact live guard at its own effect.
   * `recoveryError` is the broker's OPTIONAL internal admission denial for one
   * apply whose action never entered; it is threaded unchanged so the ledger can
   * prove an exact current receipt and otherwise throw that original denial back.
   * It is never derived from caller input.
   */
  private async integrate(args: IntegrationAction, guard?: () => void, recoveryError?: WorkerError): Promise<unknown> {
    // Two SYNCHRONOUS steps, adjacent and before any await: refuse a scope whose
    // deletion fence is held, then register this action's live entry. Because
    // both sides of the handshake are synchronous, a deletion either sees this
    // action (and refuses integration_busy without installing a fence) or this
    // action sees the fence (and is refused board_deleting). An action that is
    // already entered can therefore never be aborted by a later deletion, and a
    // just-entered action can never slip behind an inspection.
    this.assertNoIntegrationFence(args.ownerId, args.teamId);
    const release = this.enterIntegration(args.ownerId, args.teamId);
    try {
      const authorize = this.integrationAuthorize(args, guard);
      authorize();
      const attempts = await this.openIntegration(authorize);
      authorize();
      return await attempts.invoke(args, authorize, recoveryError);
    } finally {
      release();
    }
  }

  /**
   * Single-flight construction of this root's integration service. Its ports are
   * bound to the LIVE call (through the per-call authorize) rather than captured
   * when the service was built, so a revocation is seen at every side effect.
   */
  private async openIntegration(authorize: () => void): Promise<IntegrationAttempts> {
    if (this.integration) {
      return this.integration;
    }
    if (!this.openingIntegration) {
      this.openingIntegration = (async () => {
        this.commitGuard();
        if (!this.integrationEnabled()) {
          throw new WorkerError('feature_disabled', 'Integration requires codexSubagent.taskBoard.enabled, codexSubagent.isolatedViews.enabled, codexSubagent.resources.enabled and codexSubagent.isolatedViews.integration.enabled in User Settings.');
        }
        // Deliberately lazy: the durable ledger is answered WITHOUT opening
        // private view storage, so status and release stay reachable when the
        // index is missing, and each action that really needs a view capability
        // opens it at its own boundary before any effect.
        authorize();
        const service = new IntegrationAttempts(this.integrationDirectory, {
          board: () => this.board.open(),
          session: (id: string) => {
            try {
              return this.store.get(id);
            } catch (error) {
              if (error instanceof WorkerError && error.code === 'not_found') {
                return undefined;
              }
              throw error;
            }
          },
          // await this.open() on EVERY call: a fresh host, or a view store that
          // was closed and reopened, must open it here instead of reading an
          // absent cached handle.
          retainArtifacts: async (scope: IntegrationScope, refs: readonly IntegrationArtifactRef[], check: () => void,
            verify?: (submissions: readonly SealedSubmission[]) => void | Promise<void>) =>
            (await this.open()).retainIntegrationArtifacts(scope, refs, check, verify),
          // Durable ancestry of this attempt's exact sealed sources: the ONE
          // immediate base they were composed over plus every derived snapshot
          // its stored lineage rests on, read under the view mutex.
          sourceAncestry: async (scope: IntegrationScope, refs: readonly IntegrationArtifactRef[], check: () => void) =>
            (await this.open()).integrationSourceAncestry(scope, refs, check),
          compose: async (scope, refs, check, verify) => (await this.open()).composeIntegration(scope, refs, check, verify),
          pinEvidence: (scope, items, check) => this.pinIntegrationEvidence(scope, items, check),
          releasePins: (scope, check) => this.releaseIntegrationPins(scope, check),
          publish: (scope, baseSnapshotId, ref, check, options) => this.publishIntegrationCandidate(scope, baseSnapshotId, ref, check, options),
          withStorageWrite: action => this.withStorage(action)
        },
        // The trusted root this host was constructed for. The ledger puts it in
        // its bounded-summary `details` template so that following that object
        // from a client whose CWD is another open folder still routes to THIS
        // canonical root instead of answering attempt_missing.
        this.root);
        this.integration = service;
        return service;
      })().catch((error: unknown) => {
        this.openingIntegration = undefined;
        throw error;
      });
    }
    return this.openingIntegration;
  }

  /**
   * Pin this attempt's evidence in ONE durable adoption, after proving every
   * exact resource inside the evidence mutex the runner GC already uses. A
   * partial, failed or replayed set therefore never looks protected. The set is
   * bounded by the ledger's own 1024-pin cap, not by the request shape.
   */
  private async pinIntegrationEvidence(scope: IntegrationScope, items: readonly EvidenceCheck[], authorize: () => void): Promise<void> {
    authorize();
    await this.evidence.pinIntegration(scope.attemptId, async guard => {
      const requested: { ownerId: string; teamId: string; name: string; uri: string }[] = [];
      for (let index = 0; index < items.length; index += 1) {
        guard();
        authorize();
        const item = items[index];
        if (typeof item.ref?.uri !== 'string' || typeof item.ref?.id !== 'string' || !Number.isInteger(item.ref?.version)) {
          throw new WorkerError('retention_invalid', 'Every integration evidence item requires an exact id, version and URI.');
        }
        await this.verifyIntegrationEvidence(scope, item, authorize);
        requested.push({ ownerId: scope.ownerId, teamId: scope.teamId, name: integrationPinName(index, item.ref), uri: item.ref.uri });
      }
      return requested;
    }, authorize, action => this.withStorage(action));
    authorize();
  }

  /**
   * Prove one exact evidence item. Only a DURABLE runner result is evidence: a
   * board verdict, a sealed submission URI or any other URI is refused, because
   * none of them proves that one immutable command ran, drained, left its input
   * revision untouched and was produced by the exact worker instance that sealed
   * the artifact.
   */
  private async verifyIntegrationEvidence(scope: IntegrationScope, item: EvidenceCheck, authorize: () => void): Promise<void> {
    const submission = item.submission;
    if (submission === null || typeof submission !== 'object') {
      throw new WorkerError('retention_invalid', 'Evidence must be bound to an exact sealed submission.');
    }
    if (submission.ownerId !== scope.ownerId || submission.teamId !== scope.teamId) {
      throw new WorkerError('retention_missing', 'Evidence is bound to a submission of another coordinator or team.');
    }
    const ref = item.ref;
    if (!ref.uri.startsWith(INTEGRATION_RESULT_PREFIX)) {
      throw new WorkerError('retention_missing', 'Validation evidence must be an existing durable runner result; a board verdict, sealed submission URI or bare URI is not evidence.');
    }
    const manager = await this.runnerStore();
    if (!manager) {
      throw new WorkerError('retention_missing', 'No runner result store exists for this workspace, so this result evidence is unavailable.');
    }
    const id = ref.uri.slice(INTEGRATION_RESULT_PREFIX.length).split(':').at(-1)!;
    // A ref whose id differs is refused even when the URI happens to match.
    if (ref.id !== id) {
      throw new WorkerError('retention_missing', 'The result evidence id differs from the exact durable result named by its URI.');
    }
    const result = manager.results.get(id, { ownerId: scope.ownerId, teamId: scope.teamId });
    if (result.id !== ref.id || result.uri !== ref.uri || result.version !== ref.version) {
      throw new WorkerError('retention_missing', 'The result evidence URI, id or version differs from the exact durable result.');
    }
    if (result.outcome !== 'succeeded' || result.exitCode !== 0 || result.signal !== null || !result.drained) {
      throw new WorkerError('evidence_invalid', `Result ${result.id} is ${result.outcome} (exit ${String(result.exitCode)}, signal ${String(result.signal)}, drained ${result.drained}); only a clean, drained success is validation evidence.`);
    }
    if (result.import !== 'unchanged') {
      throw new WorkerError('evidence_invalid', `Result ${result.id} reported import '${result.import}' instead of 'unchanged'; a command that changed or may have changed its input is not validation evidence.`);
    }
    const input = result.attempt.inputVersion;
    const after = result.afterVersion;
    if (!after || after.snapshotId !== input.snapshotId || after.overlayId !== input.overlayId || after.revision !== input.revision) {
      throw new WorkerError('evidence_invalid', `Result ${result.id} does not prove its input revision was left unchanged.`);
    }
    if (input.snapshotId !== submission.snapshotId || input.overlayId !== submission.overlayId || input.revision !== submission.revision) {
      throw new WorkerError('evidence_invalid', `Result ${result.id} ran against a different snapshot, overlay or revision than the sealed input.`);
    }
    const owner = result.attempt.owner;
    if (owner.ownerId !== scope.ownerId || owner.teamId !== scope.teamId) {
      throw new WorkerError('retention_missing', `Result ${result.id} belongs to another coordinator or team.`);
    }
    if (owner.workerId !== submission.workerId || owner.workerCreatedAt !== submission.workerCreatedAt) {
      throw new WorkerError('evidence_invalid', `Result ${result.id} was produced by a different worker instance than the sealed input.`);
    }
    if (item.command !== undefined) {
      if (result.attempt.command !== item.command) {
        throw new WorkerError('evidence_invalid', `Result ${result.id} recorded a different command than this immutable validation step.`);
      }
      // An explicit validation must come from the attempt's own EXACT source
      // directory: `<pool>/slots/<slot>/<leaseId>/source`. The immutable result
      // already records that execution directory and the configured pool
      // directory is its anchor, so the exact canonical shape is proved here
      // WITHOUT the lease record: a finished lease is released and its tombstone
      // is collected by normal retention, independently of this retained result.
      // A temp or output directory of the same lease fails the shape, and a
      // non-canonical slot spelling (for example '01') is refused too.
      let expected: string | undefined;
      try {
        const root = path.resolve(manager.pool.directory);
        const actual = path.resolve(result.attempt.executionDirectory);
        const parts = path.relative(root, actual).split(path.sep);
        const slot = parts.length === 4 && parts[0] === 'slots' && parts[3] === 'source' ? Number(parts[1]) : NaN;
        if (Number.isSafeInteger(slot) && slot >= 0 && slot < RUNNER_POOL_MAX_CAPACITY
          && String(slot) === parts[1] && parts[2] === result.attempt.leaseId) {
          expected = path.join(root, 'slots', String(slot), result.attempt.leaseId, 'source');
        }
        if (expected !== actual) {
          expected = undefined;
        }
      } catch {
        expected = undefined;
      }
      if (expected === undefined) {
        throw new WorkerError('evidence_invalid', `Result ${result.id} was not produced from its lease's exact source directory.`);
      }
    }
    authorize();
  }

  /** Release exactly this attempt's protected pins and its private view inputs. */
  private async releaseIntegrationPins(scope: IntegrationScope, authorize: () => void): Promise<void> {
    authorize();
    await this.evidence.releaseIntegration(scope.attemptId, authorize, action => this.withStorage(action));
    authorize();
    await (await this.open()).releaseIntegrationArtifacts(scope, authorize);
  }

  /**
   * Creates this attempt's durable publication journal path, which MUST live
   * outside the workspace and inside a plain directory this store owns. Every
   * component is created with `mkdir` and then lstat'ed: a pre-existing file,
   * link or junction in place of the directory is refused instead of followed.
   */
  private async publicationJournal(attemptId: string, authorize: () => void): Promise<string> {
    const base = this.integrationDirectory;
    const directory = path.join(base, 'publications');
    for (const target of [base, directory]) {
      authorize();
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      authorize();
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new WorkerError('integration_conflict', `The integration publication directory ${target} is not a plain owned directory; nothing was published.`);
      }
    }
    return path.join(directory, `${attemptId}.json`);
  }

  /**
   * Publication of ONE accepted candidate. Provenance is checked against the
   * CAPTURED original base, the candidate is read through its private reader, and
   * the durable journal is keyed by the immutable attempt identity the service
   * proves. Unknown provenance and every other ambiguous change therefore return
   * a conflict BEFORE any durable write, so the attempt stays releasable.
   *
   * `options` is the ledger's publication contract for THIS attempt, forwarded
   * unchanged: a recovery apply requires the existing journal and may only
   * reconcile it through the proof-only path, never create a new one.
   */
  private async publishIntegrationCandidate(
    scope: IntegrationScope, baseSnapshotId: string, ref: IntegrationArtifactRef, authorize: () => void,
    options: IntegrationPublicationOptions
  ): Promise<{ state: 'applied' | 'conflict' | 'interrupted'; applied: string[]; conflicts: { path: string; reason: string }[] }> {
    authorize();
    const documents = this.options.publicationDocuments;
    if (documents === undefined) {
      throw new WorkerError('feature_disabled', 'Publishing requires the owning window document enumeration; nothing was written.');
    }
    if (!this.options.canWrite()) {
      throw new WorkerError('permission_denied', 'Publishing requires live workspace write access; nothing was written.');
    }
    const rootStat = await fs.lstat(this.root).catch(() => undefined);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new WorkerError('workspace_changed', 'The workspace root is no longer the same plain directory; nothing was published.');
    }
    const journalPath = await this.publicationJournal(scope.attemptId, authorize);
    return (await this.open()).withIntegrationCandidate(scope, baseSnapshotId, ref, async (base, candidate, submission) => {
      authorize();
      if (submission.id !== ref.id || submission.version !== ref.version || submission.uri !== ref.uri) {
        throw new WorkerError('integration_conflict', 'The private candidate is not the exact accepted sealed artifact.');
      }
      const plan = publicationPlan(base, candidate);
      if (plan.conflicts.length > 0) {
        // Inherently unsupported provenance or entry kinds: no journal, no write.
        return { state: 'conflict' as const, applied: [], conflicts: plan.conflicts };
      }
      authorize();
      return publishIntegration({
        root: this.root,
        journalPath,
        identity: digest(['integration-publication', scope.attemptId, submission.id, submission.version, submission.uri, baseSnapshotId]),
        changes: plan.changes,
        read: async key => (await candidate.read(key)).bytes,
        // An absent or malformed enumeration is a hard refusal: an editor buffer
        // that cannot be enumerated must never be treated as "no open editors".
        openDocuments: () => {
          const value = documents();
          if (!Array.isArray(value)) {
            throw new WorkerError('invalid_publication', 'The owning window document enumeration returned an invalid value; publication is refused.');
          }
          return value;
        },
        authorize,
        // The ledger decides the publication contract, and it is forwarded
        // UNCHANGED: the required journal, the latch checkpoint, proof-only
        // recovery, and the additive journal-revision floor with the per-file
        // intent checkpoint that maintains it. A recovery apply therefore still
        // finds its existing journal and may only reconcile it.
        ...options
      });
    }, authorize);
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
