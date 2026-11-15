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
import { digest, SessionStore } from './storage';
import { Session, Settings, WorkerError, WorkspaceTools } from './types';
import type { WorkerEngine } from './engine';
import type { ToolResult } from './api';

interface IsolationBoard {
  open(): Promise<TaskBoard>;
  assertTeam(ownerId: string, teamId: string, workerId?: string): void;
}
const sealSchema = z.strictObject({ requestId: z.string().min(1).max(200), expectedRevision: z.number().int().min(0).max(1024) });
const sameBinding = (a: IsolatedViewBinding, b: IsolatedViewBinding): boolean => a.overlayId === b.overlayId && a.snapshotId === b.snapshotId && a.teamId === b.teamId;

/** Lazy lifecycle handle, always drained before its SessionStore owner unlocks. */
export class IsolatedViewHost {
  private views?: IsolatedViews;
  private opening?: Promise<IsolatedViews>;
  private closing = false;
  private drained?: Promise<void>;
  constructor(
    private readonly root: string,
    private readonly store: SessionStore,
    private readonly board: IsolationBoard,
    private readonly options: {
      enabled: () => boolean;
      guard: () => void;
      canWrite: () => boolean;
      settings: () => Settings;
      openDocuments?: () => OpenDocument[];
    }
  ) {}

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
    this.drained ??= (async () => {
      const views = this.opening ? await this.opening.catch(() => undefined) : this.views;
      await views?.close();
    })();
    return this.drained;
  }

  /** A current Session identity and live membership check, suitable for preRename. */
  private workerGuard(original: Session, authorize?: () => void, signal?: AbortSignal, checkModel = true): () => void {
    return () => {
      signal?.throwIfAborted();
      this.commitGuard();
      authorize?.();
      const current = this.store.get(original.id);
      if (current.createdAt !== original.createdAt || current.ownerId !== original.ownerId || current.workspaceRoot !== this.root
        || current.schema !== 2 || !current.isolatedView || !original.isolatedView || !sameBinding(current.isolatedView, original.isolatedView)) {
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
    if (!session.isolatedView || session.schema !== 2 || !session.ownerId) {
      throw new WorkerError('isolation_unavailable', 'A private worker requires its permanent binding and owner identity.');
    }
    const identity: IsolatedViewIdentity = { ownerId: session.ownerId, workerId: session.id, workerCreatedAt: session.createdAt };
    const binding = { ...session.isolatedView };
    const port: IsolatedViewPort = {
      withView: async (...args) => (await this.open()).withView(...args),
      edit: async (...args) => (await this.open()).edit(...args),
      seal: async (...args) => (await this.open()).seal(...args),
      status: async (...args) => (await this.open()).status(...args)
    };
    const guard = this.workerGuard(session);
    const files = new IsolatedWorkspaceTools(this.root, port, binding, identity, session.permission, { canWrite: this.options.canWrite, guard });
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
            draft.schema = 2;
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
      return viewResponse(await views.release(isolatedViewSchemas.subagent_view_release.parse(input), guard, id => this.presence(id)));
    }
    return viewResponse(await views.cleanup(isolatedViewSchemas.subagent_view_cleanup.parse(input), id => this.presence(id), guard));
  }
}
