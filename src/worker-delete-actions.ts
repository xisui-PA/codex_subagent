/**
 * Manual HARD deletion of saved workers from the Workers tree.
 *
 * This module is a UI action helper, not a worker API: the caller supplies a
 * finite snapshot of exact workspaceRoot/id targets. The helper asks for one
 * confirmation, then re-fetches every target and calls the existing
 * subagent_delete operation with the freshly observed, unchanged identity. It
 * never stops, cancels, resumes or starts a worker, never deletes board
 * records, never retries an uncertain result, and never turns a group row into
 * an inferred set of workers.
 */

/** One exact saved-worker target; the id is a worker id, never a combined row id. */
export interface WorkerDeleteTarget {
  /** Canonical workspace root exactly as the worker list reported it. */
  workspaceRoot: string;
  id: string;
  /** Owner at selection time; the confirmed identity never broadens later. */
  ownerId?: string;
  ownerLabel?: string;
  title?: string;
  state?: string;
}

/**
 * One explicit parent group: an exact workspace root and owner. An absent
 * ownerId means the ownerless group, so the literal owner id 'ungrouped'
 * remains a different group.
 */
export interface WorkerDeleteScope {
  workspaceRoot: string;
  ownerId?: string;
  /** Display label from explicit tree metadata; never used to match workers. */
  label?: string;
}

/** Authoritative worker state read immediately before one deletion. */
export interface WorkerDeleteSession {
  id: string;
  state: string;
  workspaceRoot?: string;
  ownerId?: string;
  ownerLabel?: string;
  title?: string;
  startup?: { phase?: string };
}

/** The subset of a list header used to build a fresh target snapshot. */
export interface WorkerDeleteSessionHeader {
  id: string;
  state: string;
  workspaceRoot?: string;
  ownerId?: string;
  ownerLabel?: string;
  title?: string;
}

/** Narrow ports so the confirmation flow is testable without real dialogs. */
export interface WorkerDeletePorts {
  /** Re-read one worker through its exact root; reports not_found when gone. */
  session(workspaceRoot: string, id: string): Promise<WorkerDeleteSession>;
  /** The existing subagent_delete operation, with the authoritative owner. */
  remove(workspaceRoot: string, id: string, ownerId: string | undefined): Promise<void>;
  confirm(message: string, detail: string): Promise<boolean>;
  info(message: string): void;
  /** One final refresh after a confirmed batch, never one refresh per worker. */
  refresh(): Promise<void>;
}

/**
 * `busy`: queued, running, starting up or rejected by the backend's own guard.
 * `identity_changed`: the re-read worker is no longer the exact confirmed
 * root/id/owner, so the snapshot never broadens onto another worker or group.
 */
export type WorkerDeleteSkipReason = 'busy' | 'identity_changed';

export interface WorkerDeleteSummary {
  status: 'deleted' | 'partial' | 'none' | 'cancelled' | 'unavailable';
  /** Number of distinct confirmed targets. */
  confirmed: number;
  deleted: WorkerDeleteTarget[];
  skipped: { target: WorkerDeleteTarget; reason: WorkerDeleteSkipReason }[];
  /** Targets that were already absent before or during deletion. */
  absent: WorkerDeleteTarget[];
  failed: { target: WorkerDeleteTarget; code?: string; message: string }[];
  refreshed: boolean;
}

export interface WorkerDeleteChoice {
  label: string;
  description: string;
  detail: string;
  target: WorkerDeleteTarget;
}

export interface WorkerDeleteGroupChoice {
  label: string;
  description: string;
  detail: string;
  scope: WorkerDeleteScope;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** Empty owner ids are ownerless; a real owner id is compared literally. */
const owner = (value: unknown): string | undefined => text(value) ? value : undefined;
const sameOwner = (left: string | undefined, right: string | undefined): boolean => owner(left) === owner(right);

/**
 * Tree-row identity for one parent group. JSON keeps an ownerless group
 * distinct from a real owner whose exact id is 'ungrouped', and cannot be
 * produced by two different (root, owner) pairs.
 */
export function workerGroupKey(workspaceRoot: string, ownerId?: string): string {
  return JSON.stringify([workspaceRoot, ownerId === undefined ? null : ownerId]);
}

function targetFromSession(value: unknown): WorkerDeleteTarget | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const session = value as Record<string, unknown>;
  if (!text(session.workspaceRoot) || !text(session.id)) {
    return undefined;
  }
  if (session.ownerId !== undefined && typeof session.ownerId !== 'string') {
    return undefined;
  }
  const ownerId = owner(session.ownerId);
  return {
    workspaceRoot: session.workspaceRoot,
    id: session.id,
    ...(ownerId ? { ownerId } : {}),
    ...(typeof session.ownerLabel === 'string' && session.ownerLabel ? { ownerLabel: session.ownerLabel } : {}),
    ...(typeof session.title === 'string' && session.title ? { title: session.title } : {}),
    ...(typeof session.state === 'string' ? { state: session.state } : {})
  };
}

/** Only an explicit worker tree node is a deletion target; group rows never expand. */
export function workerDeleteTargetFromNode(node: unknown): WorkerDeleteTarget | undefined {
  if (!node || typeof node !== 'object' || (node as { kind?: unknown }).kind !== 'worker') {
    return undefined;
  }
  return targetFromSession((node as { session?: unknown }).session);
}

/**
 * Apply the standard tree-command arguments conservatively: the clicked node
 * decides. A clicked worker is widened to the selected workers only when it is
 * itself part of that selection; a clicked worker outside it targets only that
 * worker. A clicked group or malformed node targets nothing at all and never
 * falls back to unrelated selected workers. Without a clicked node, explicit
 * selected workers are supported.
 */
export function workerDeleteTargetsFromArgs(clicked: unknown, selected?: unknown): WorkerDeleteTarget[] {
  const picked = Array.isArray(selected) && selected.length
    ? dedupeWorkerTargets(selected.map(workerDeleteTargetFromNode).filter((target): target is WorkerDeleteTarget => !!target))
    : [];
  if (clicked === undefined || clicked === null) {
    return picked;
  }
  const target = workerDeleteTargetFromNode(clicked);
  if (!target) {
    return [];
  }
  const inside = picked.some(entry => entry.workspaceRoot === target.workspaceRoot && entry.id === target.id);
  return inside ? picked : [target];
}

/** Exact root+id identity deduplication; the same id under another root stays distinct. */
export function dedupeWorkerTargets(targets: readonly WorkerDeleteTarget[]): WorkerDeleteTarget[] {
  const seen = new Set<string>();
  const result: WorkerDeleteTarget[] = [];
  for (const target of targets) {
    if (!text(target.workspaceRoot) || !text(target.id)) {
      continue;
    }
    const key = JSON.stringify([target.workspaceRoot, target.id]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ ...target });
  }
  return result;
}

/** Build an exact snapshot from worker list headers, dropping rows without a root. */
export function workerDeleteTargetsFromSessions(sessions: readonly WorkerDeleteSessionHeader[]): WorkerDeleteTarget[] {
  return dedupeWorkerTargets(sessions.map(session => targetFromSession(session)).filter((target): target is WorkerDeleteTarget => !!target));
}

/**
 * Read one parent group from explicit node metadata. A malformed node returns
 * undefined; neither the compound row id nor the display label is ever parsed.
 */
export function workerDeleteScopeFromNode(node: unknown): WorkerDeleteScope | undefined {
  if (!node || typeof node !== 'object' || (node as { kind?: unknown }).kind !== 'group') {
    return undefined;
  }
  const value = node as Record<string, unknown>;
  if (!text(value.workspaceRoot)) {
    return undefined;
  }
  if (value.ownerId !== undefined && typeof value.ownerId !== 'string') {
    return undefined;
  }
  if (value.ownerLabel !== undefined && typeof value.ownerLabel !== 'string') {
    return undefined;
  }
  const ownerId = owner(value.ownerId);
  return {
    workspaceRoot: value.workspaceRoot,
    ...(ownerId ? { ownerId } : {}),
    ...(text(value.ownerLabel) ? { label: value.ownerLabel } : {})
  };
}

/**
 * The exact workers of one parent group: equal workspace root and equal owner
 * identity (undefined versus a literal id included). Labels never decide.
 */
export function groupWorkerTargets(workers: readonly WorkerDeleteTarget[], scope: WorkerDeleteScope): WorkerDeleteTarget[] {
  if (!text(scope.workspaceRoot)) {
    return [];
  }
  return dedupeWorkerTargets(workers.filter(worker => worker.workspaceRoot === scope.workspaceRoot && sameOwner(worker.ownerId, scope.ownerId)));
}

/** Parent-group choices for the palette fallback; one per exact root+owner. */
export function workerGroupChoices(workers: readonly WorkerDeleteTarget[]): WorkerDeleteGroupChoice[] {
  const groups = new Map<string, WorkerDeleteGroupChoice & { count: number }>();
  for (const worker of workers) {
    if (!text(worker.workspaceRoot)) {
      continue;
    }
    const ownerId = owner(worker.ownerId);
    const key = workerGroupKey(worker.workspaceRoot, ownerId);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const label = worker.ownerLabel || ownerId || 'Ungrouped';
    groups.set(key, {
      label,
      description: '',
      detail: `${worker.workspaceRoot} - owner ${ownerId ?? '(none)'}`,
      scope: { workspaceRoot: worker.workspaceRoot, ...(ownerId ? { ownerId } : {}), label },
      count: 1
    });
  }
  return [...groups.values()].map(group => ({
    label: group.label,
    description: `${group.count} saved worker(s)`,
    detail: group.detail,
    scope: group.scope
  }));
}

/** Searchable palette choices carrying owner, workspace and state context. */
export function workerDeleteChoices(workers: readonly WorkerDeleteTarget[]): WorkerDeleteChoice[] {
  return dedupeWorkerTargets(workers).map(target => {
    const ownerId = owner(target.ownerId);
    return {
      label: target.title || target.id,
      description: `${target.state || 'saved'} - ${target.ownerLabel || ownerId || 'Ungrouped'}`,
      detail: `${target.workspaceRoot} - owner ${ownerId ?? '(none)'} - worker ${target.id}`,
      target
    };
  });
}

const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
/** Bounded per-item previews; a long batch is summarized by count instead. */
const PREVIEW_LIMIT = 5;

function preview(target: WorkerDeleteTarget): string {
  return `- ${target.title ? `${oneLine(target.title)} ` : ''}(worker ${target.id}) in ${target.workspaceRoot}`;
}

/**
 * One modal prompt naming the exact count, the group/root scope when known and
 * bounded per-worker previews, so a single-worker or same-title batch still
 * shows which exact identities are about to be removed.
 */
export function workerDeleteConfirmation(targets: readonly WorkerDeleteTarget[], scope?: WorkerDeleteScope): { message: string; detail: string } {
  const count = targets.length;
  const roots = [...new Set(targets.map(target => target.workspaceRoot))];
  const lines = [`Workspace${roots.length === 1 ? '' : 's'}: ${roots.join(', ')}`];
  if (scope) {
    lines.push(`Group: ${oneLine(scope.label || scope.ownerId || 'Ungrouped')} (owner ${scope.ownerId ?? '(none)'}) in ${scope.workspaceRoot}`);
  }
  for (const target of targets.slice(0, PREVIEW_LIMIT)) {
    lines.push(preview(target));
  }
  if (count > PREVIEW_LIMIT) {
    lines.push(`- and ${count - PREVIEW_LIMIT} more`);
  }
  lines.push('', 'Worker histories and archives, change snapshots and operation keys are permanently removed. Running or queued workers are skipped; other saved workers are deleted one at a time. No files, board records or saved workspaces are changed.');
  return {
    message: `Permanently delete ${count} saved worker${count === 1 ? '' : 's'}?`,
    detail: lines.join('\n')
  };
}

function problem(error: unknown): { code?: string; message: string } {
  const value = error as { code?: unknown; message?: unknown } | null | undefined;
  return {
    ...(typeof value?.code === 'string' ? { code: value.code } : {}),
    message: typeof value?.message === 'string' && value.message ? value.message : String(error)
  };
}

function busyState(session: WorkerDeleteSession): boolean {
  if (['queued', 'running'].includes(session.state)) {
    return true;
  }
  // Governed startup that has not started (or was cancelled) is still busy.
  return !!session.startup && session.startup.phase !== 'started' && session.startup.phase !== 'cancelled';
}

/**
 * The re-read worker must still be the exact confirmed identity. A different
 * id, a different reported root or a different owner is never deleted and never
 * broadens a confirmed group.
 */
function identityMismatch(target: WorkerDeleteTarget, current: WorkerDeleteSession): boolean {
  if (current.id !== target.id || !sameOwner(current.ownerId, target.ownerId)) {
    return true;
  }
  return text(current.workspaceRoot) && current.workspaceRoot !== target.workspaceRoot;
}

/** Concise final totals for the information message; failure details go to the log. */
export function workerDeleteReport(summary: WorkerDeleteSummary, scope?: WorkerDeleteScope): string {
  const total = summary.confirmed;
  const parts = [scope
    ? `In ${oneLine(scope.label || scope.ownerId || 'Ungrouped')} (${scope.workspaceRoot}): deleted ${summary.deleted.length} of ${total} saved worker${total === 1 ? '' : 's'}`
    : `Deleted ${summary.deleted.length} of ${total} selected saved worker${total === 1 ? '' : 's'}`];
  if (summary.skipped.length) {
    const busy = summary.skipped.filter(entry => entry.reason === 'busy').length;
    const changed = summary.skipped.length - busy;
    const changedText = scope ? 'no longer in this group' : 'identity changed';
    const reasons = [busy ? `${busy} busy` : '', changed ? `${changed} ${changedText}` : ''].filter(Boolean);
    parts.push(`${summary.skipped.length} skipped (${reasons.join(', ')})`);
  }
  if (summary.absent.length) {
    parts.push(`${summary.absent.length} already missing`);
  }
  if (summary.failed.length) {
    parts.push(`${summary.failed.length} failed: ${oneLine(summary.failed[0].message)}`);
  }
  return `${parts.join('. ')}.`;
}

/**
 * Run one manual deletion over a confirmed, finite target snapshot.
 *
 * Cancellation performs no reads, deletes or refresh. Each remaining target is
 * re-fetched for its authoritative state and identity: an unchanged idle worker
 * is deleted once, a busy worker or one whose id/root/owner changed is skipped,
 * a missing worker counts as absent, and any other error is recorded for that
 * item while later targets continue. No error counts as a successful deletion
 * and no operation is retried. A confirmed batch refreshes the trees exactly
 * once, even when every target was skipped or every lookup failed.
 */
export async function manualWorkerDelete(ports: WorkerDeletePorts, options: {
  targets: readonly WorkerDeleteTarget[];
  scope?: WorkerDeleteScope;
  unavailableMessage?: string;
}): Promise<WorkerDeleteSummary> {
  const targets = dedupeWorkerTargets(options.targets);
  const summary: WorkerDeleteSummary = {
    status: 'none', confirmed: targets.length, deleted: [], skipped: [], absent: [], failed: [], refreshed: false
  };
  if (!targets.length) {
    summary.status = 'unavailable';
    if (options.unavailableMessage) {
      ports.info(options.unavailableMessage);
    }
    return summary;
  }

  const prompt = workerDeleteConfirmation(targets, options.scope);
  if (!await ports.confirm(prompt.message, prompt.detail)) {
    summary.status = 'cancelled';
    return summary;
  }

  for (const target of targets) {
    let current: WorkerDeleteSession;
    try {
      current = await ports.session(target.workspaceRoot, target.id);
    } catch (error) {
      const issue = problem(error);
      if (issue.code === 'not_found') {
        summary.absent.push(target);
      } else {
        summary.failed.push({ target, ...issue });
      }
      continue;
    }
    // The confirmed snapshot is the only authority: a re-read worker with a
    // different identity is skipped unread and never deleted or broadened.
    if (identityMismatch(target, current)) {
      summary.skipped.push({ target, reason: 'identity_changed' });
      continue;
    }
    if (busyState(current)) {
      summary.skipped.push({ target, reason: 'busy' });
      continue;
    }
    // A deletion is attempted exactly once. The backend keeps its own
    // active/queued guard for dependencies, startup and draining work.
    try {
      await ports.remove(target.workspaceRoot, current.id, owner(current.ownerId));
      summary.deleted.push(target);
    } catch (error) {
      const issue = problem(error);
      if (issue.code === 'worker_busy') {
        summary.skipped.push({ target, reason: 'busy' });
      } else if (issue.code === 'not_found') {
        summary.absent.push(target);
      } else {
        summary.failed.push({ target, ...issue });
      }
    }
  }

  await ports.refresh();
  summary.refreshed = true;
  summary.status = summary.failed.length ? (summary.deleted.length ? 'partial' : 'none')
    : summary.deleted.length ? 'deleted' : 'none';
  ports.info(workerDeleteReport(summary, options.scope));
  return summary;
}
