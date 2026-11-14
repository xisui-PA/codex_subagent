import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Session } from './types';
import { WorkerError } from './types';
import { atomicWrite, digest, Mutex } from './storage';
import {
  activeTaskStates,
  boardActor,
  boardDataSchema,
  emptyHistory,
  limits,
  coordinatorTaskUpdateInput,
  workerTaskUpdateInput,
  taskCreateInput,
  taskSchema,
  teamCreateInput,
  teamSchema,
  teamUpdateInput
} from './task-board-types';
import type {
  BoardActor,
  BoardData,
  BoardTask,
  CoordinatorTaskUpdateInput,
  Ref,
  History,
  TaskState,
  Team,
  TeamCreateInput,
  TeamUpdateInput
} from './task-board-types';

/** Resolves a worker id to its persistent session; undefined means the worker does not exist in this workspace. */
export type WorkerResolver = (id: string) => Session | undefined;

/** One unmet dependency with the reason a derived readiness view reports it. */
export type UnmetDependency = { taskId: string; kind: 'contract' | 'artifact'; reason: string };

/** Derived read-only view for MCP reads; readiness is computed, never persisted, and mutations return the base task. */
export type TaskView = BoardTask & {
  readiness: { ready: boolean; unmetDependencies: UnmetDependency[]; blockers: string[] }
};

/** Trusted internal snapshot for the host UI: full board, cloned records, no actor, no mutation. */
export type BoardSnapshot = { workspaceRoot: string; teams: Team[]; tasks: TaskView[] };

/** Explicit lifecycle transition table; accepted/cancelled are terminal. */
const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  ready: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['submitted', 'failed', 'cancelled'],
  submitted: ['validating', 'in_progress', 'failed', 'cancelled'],
  validating: ['accepted', 'in_progress', 'failed', 'cancelled'],
  failed: ['ready', 'cancelled'],
  accepted: [],
  cancelled: []
};

/** Subset of transitions a worker may perform on its own task. */
const WORKER_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  ready: ['in_progress', 'failed'],
  in_progress: ['submitted', 'failed'],
  submitted: ['failed'],
  validating: ['failed'],
  failed: [],
  accepted: [],
  cancelled: []
};

const isTerminalState = (s: TaskState): boolean => s === 'accepted' || s === 'cancelled';

function requireCoordinator(actor: BoardActor): string {
  if (actor.kind !== 'coordinator') {
    throw new WorkerError('forbidden', 'Only the owning coordinator can manage teams.');
  }
  return actor.ownerId;
}

/** Canonical form: object keys sorted recursively, so the fingerprint is independent of key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonical(source[key]);
    }
    return out;
  }
  return value;
}

export class TaskBoard {
  private readonly file: string;
  private readonly root: string;
  private readonly mutex = new Mutex();
  private data?: BoardData;
  private closing = false;

  constructor(readonly directory: string, workspaceRoot: string, private readonly worker: WorkerResolver, private readonly mutationGuard?: () => void) {
    this.root = path.resolve(workspaceRoot);
    this.file = path.join(directory, 'task-board.json');
  }

  async open(): Promise<void> {
    if (this.data) {
      return;
    }
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = { schema: 1, workspaceRoot: this.root, teams: [], tasks: [], requests: {} };
        return;
      }
      throw new WorkerError('board_unreadable', `Cannot read task board ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let data: BoardData;
    try {
      data = boardDataSchema.parse(JSON.parse(text));
      if (data.workspaceRoot !== this.root) {
        throw new WorkerError('board_malformed', 'The durable task board belongs to a different workspace root.');
      }
      try {
        this.validateGraph(data);
      } catch (error) {
        if (error instanceof WorkerError) {
          throw new WorkerError('board_malformed', `Task board ${this.file} is malformed and was left untouched: ${error.message}`);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof WorkerError) {
        throw error;
      }
      throw new WorkerError('board_malformed', `Task board ${this.file} is malformed and was left untouched: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.data = data;
  }

  /** Mark the board closing and drain queued/in-flight mutations before the host releases the owner lock. */
  async close(): Promise<void> {
    this.closing = true;
    await this.mutex.run(() => Promise.resolve());
  }

  private requireOpen(): BoardData {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'The task board is closing; new and queued calls are rejected.');
    }
    if (!this.data) {
      throw new WorkerError('store_closed', 'Task board is not open; call open() first.');
    }
    return this.data;
  }

  /**
   * Reusable graph invariants for mutations (via commit) and durable open (mapped to board_malformed there).
   * Dangling worker refs stay inspectable: no live-worker checks, never auto-repaired.
   */
  private validateGraph(data: BoardData): void {
    const teamIds = new Set<string>();
    for (const team of data.teams) {
      if (teamIds.has(team.id)) {
        throw new WorkerError('board_malformed', `Duplicate team id ${team.id}.`);
      }
      teamIds.add(team.id);
      if (team.workspaceRoot !== data.workspaceRoot) {
        throw new WorkerError('board_malformed', `Team ${team.id} does not match the board workspace root.`);
      }
      const members = new Set<string>();
      for (const member of team.memberWorkerIds) {
        if (members.has(member)) {
          throw new WorkerError('board_malformed', `Team ${team.id} lists worker ${member} twice.`);
        }
        members.add(member);
      }
    }
    const taskIds = new Set<string>();
    for (const task of data.tasks) {
      if (taskIds.has(task.id)) {
        throw new WorkerError('board_malformed', `Duplicate task id ${task.id}.`);
      }
      taskIds.add(task.id);
      if (!teamIds.has(task.teamId)) {
        throw new WorkerError('dependency_invalid', `Task ${task.id} references unknown team ${task.teamId}.`);
      }
    }
    const activeByWorker = new Map<string, BoardTask>();
    for (const task of data.tasks) {
      if (!task.assigneeWorkerId) {
        continue;
      }
      if (!activeTaskStates.includes(task.state)) {
        continue;
      }
      const team = data.teams.find(candidate => candidate.id === task.teamId);
      if (!team?.memberWorkerIds.includes(task.assigneeWorkerId)) {
        throw new WorkerError('member_invalid', `Task ${task.id} is actively assigned to non-member worker ${task.assigneeWorkerId}.`);
      }
      const previous = activeByWorker.get(task.assigneeWorkerId);
      if (previous) {
        throw new WorkerError('assignment_conflict', `Worker ${task.assigneeWorkerId} holds active assignments on tasks ${previous.id} and ${task.id}.`);
      }
      activeByWorker.set(task.assigneeWorkerId, task);
    }
    for (const task of data.tasks) {
      const seen = new Set<string>();
      for (const dependency of task.dependencies) {
        if (dependency.taskId === task.id) {
          throw new WorkerError('dependency_invalid', `Task ${task.id} depends on itself.`);
        }
        const depKey = `${dependency.taskId}:${dependency.kind}`;
        if (seen.has(depKey)) {
          throw new WorkerError('dependency_invalid', `Task ${task.id} lists dependency ${dependency.taskId} (kind ${dependency.kind}) twice.`);
        }
        seen.add(depKey);
        const target = data.tasks.find(candidate => candidate.id === dependency.taskId);
        if (!target) {
          throw new WorkerError('dependency_invalid', `Task ${task.id} depends on missing task ${dependency.taskId}.`);
        }
        if (target.teamId !== task.teamId) {
          throw new WorkerError('dependency_invalid', `Task ${task.id} has a cross-team dependency on ${dependency.taskId}.`);
        }
      }
    }
    this.assertAcyclic(data);
    this.validateTaskRecords(data);
  }

  /** DFS over all dependency edges (contract and artifact) so cycles fail closed. */
  private assertAcyclic(data: BoardData): void {
    const state = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    const visit = (id: string): void => {
      const mark = state.get(id) ?? 0;
      if (mark === 2) {
        return;
      }
      if (mark === 1) {
        throw new WorkerError('dependency_cycle', `Tasks form a dependency cycle: ${[...stack, id].join(' -> ')}.`);
      }
      state.set(id, 1);
      stack.push(id);
      const task = data.tasks.find(candidate => candidate.id === id);
      for (const dependency of task?.dependencies ?? []) {
        visit(dependency.taskId);
      }
      stack.pop();
      state.set(id, 2);
    };
    for (const task of data.tasks) {
      visit(task.id);
    }
  }

  /**
   * Durable semantic invariants for every task and every recorded receipt.
   * Reuses assertValidation/assertAcceptable so the exact-candidate, reused-report
   * and latest-passed gates apply to stored state without live-worker checks.
   * Receipts are historical: each must safeParse a team or task record, but they
   * are never re-validated against the current graph or revision state.
   */
  private validateTaskRecords(data: BoardData): void {
    this.assertReferenceHistory(data);
    for (const task of data.tasks) {
      for (const list of [task.candidates, task.agreedContracts]) {
        const seen = new Set<string>();
        for (const ref of list) {
          const key = JSON.stringify([ref.id, ref.version]);
          if (seen.has(key)) {
            throw new WorkerError('board_malformed', `Task ${task.id} has duplicate ref ${ref.id} v${ref.version}.`);
          }
          seen.add(key);
        }
      }
      for (const v of task.validations) {
        this.assertValidation(data, task, v.candidateVersion, v.artifactId, v.resultRef);
      }
      if (task.state === 'accepted') {
        this.assertAcceptable(data, { ...task, state: 'validating' });
      }
    }
    for (const record of Object.values(data.requests)) {
      if (!teamSchema.safeParse(record.result).success && !taskSchema.safeParse(record.result).success) {
        throw new WorkerError('board_malformed', `Recorded receipt ${record.fingerprint} does not hold a team or task record.`);
      }
    }
  }

  /**
   * Reference-identity invariant: a ref (id+version) may carry only ONE exact uri+label per
   * task and namespace (candidates / agreedContracts / report refs), checked across the current
   * task records AND every historical task receipt (the immutable request history). Rebinding
   * the same id/version to a different uri/label after removal or rework fails closed. Receipts
   * and current arrays are only read, never mutated; historical snapshots are not re-validated
   * against the current graph/revision state.
   */
  private assertReferenceHistory(data: BoardData): void {
    type RefLike = { id: string; version: number; uri: string; label?: string };
    const seen = new Map<string, RefLike>();
    const visit = (taskId: string, namespace: string, code: 'ref_conflict' | 'validation_invalid', ref: RefLike): void => {
      const key = JSON.stringify([taskId, namespace, ref.id, ref.version]);
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, { id: ref.id, version: ref.version, uri: ref.uri, label: ref.label });
        return;
      }
      if (prev.uri !== ref.uri || (prev.label ?? '') !== (ref.label ?? '')) {
        throw new WorkerError(code, `Task ${taskId} ${namespace} ${ref.id} v${ref.version} was re-recorded with a different uri/label than its durable history.`);
      }
    };
    const scanTask = (taskId: string, task: { candidates: RefLike[]; agreedContracts: RefLike[]; validations: { resultRef?: RefLike }[] }): void => {
      for (const ref of task.candidates) {
        visit(taskId, 'candidate', 'ref_conflict', ref);
      }
      for (const ref of task.agreedContracts) {
        visit(taskId, 'contract', 'ref_conflict', ref);
      }
      for (const v of task.validations) {
        if (v.resultRef) {
          visit(taskId, 'report', 'validation_invalid', v.resultRef);
        }
      }
    };
    for (const record of Object.values(data.requests)) {
      const parsed = taskSchema.safeParse(record.result);
      if (!parsed.success) {
        continue; // team receipts keep the existing receipt-shape validation only
      }
      scanTask(parsed.data.id, parsed.data);
    }
    for (const task of data.tasks) {
      scanTask(task.id, task);
    }
  }

  private findTeam(data: BoardData, id: string): Team {
    const team = data.teams.find(candidate => candidate.id === id);
    if (!team) {
      throw new WorkerError('not_found', `Team ${id} was not found on this board.`);
    }
    return team;
  }

  private findTask(data: BoardData, id: string): BoardTask {
    const task = data.tasks.find(candidate => candidate.id === id);
    if (!task) {
      throw new WorkerError('not_found', `Task ${id} was not found on this board.`);
    }
    return task;
  }

  private authorizeRead(actor: BoardActor, team: Team): void {
    if (actor.kind === 'coordinator') {
      if (actor.ownerId !== team.coordinatorOwnerId) {
        throw new WorkerError('forbidden', `Team ${team.id} belongs to a different coordinator.`);
      }
      return;
    }
    const session = this.worker(actor.workerId);
    if (!session) {
      throw new WorkerError('not_found', `Worker ${actor.workerId} was not found in this workspace.`);
    }
    if (!team.memberWorkerIds.includes(actor.workerId)) {
      throw new WorkerError('forbidden', `Worker ${actor.workerId} is not a member of team ${team.id}.`);
    }
    if (path.resolve(session.workspaceRoot ?? '') !== this.root) {
      throw new WorkerError('forbidden', `Worker ${actor.workerId} does not share this board's workspace root.`);
    }
    if (session.ownerId !== team.coordinatorOwnerId) {
      throw new WorkerError('forbidden', `Worker ${actor.workerId} is owned by a different coordinator.`);
    }
  }

  private requireEligibleMember(team: Team, workerId: string): void {
    const session = this.worker(workerId);
    if (!session) {
      throw new WorkerError('not_found', `Worker ${workerId} was not found in this workspace.`);
    }
    if (path.resolve(session.workspaceRoot ?? '') !== this.root) {
      throw new WorkerError('member_invalid', `Worker ${workerId} does not share this board's workspace root.`);
    }
    if (session.ownerId !== team.coordinatorOwnerId) {
      throw new WorkerError('member_invalid', `Worker ${workerId} belongs to a different coordinator.`);
    }
  }

  /** Active assignment of a worker board-wide, or within one team when scoped. */
  private busyTask(data: BoardData, workerId: string, teamId?: string): BoardTask | undefined {
    return data.tasks.find(task => task.assigneeWorkerId === workerId && activeTaskStates.includes(task.state)
      && (teamId === undefined || task.teamId === teamId));
  }

  private pushHistory(history: History, actor: BoardActor, entry: { revision: number; reason: string; from?: TaskState; to?: TaskState }): void {
    history.lastSequence++;
    history.entries.push({
      seq: history.lastSequence,
      actor,
      from: entry.from,
      to: entry.to,
      revision: entry.revision,
      reason: entry.reason,
      at: new Date().toISOString()
    });
    while (history.entries.length > limits.history) {
      history.entries.shift();
      history.trimmed++;
    }
  }

  /** Validate the full durable shape and graph, atomically write, and publish in memory only after disk success. */
  private async commit(draft: BoardData): Promise<void> {
    boardDataSchema.parse(draft);
    this.validateGraph(draft);
    this.mutationGuard?.();
    await atomicWrite(this.file, JSON.stringify(draft));
    this.data = draft;
  }

  /**
   * Serialized mutation with durable idempotency. The dedupe key is a digest of the trusted actor and requestId,
   * the fingerprint covers mutation name, resource and the canonically sorted parsed input. Matching replays re-run
   * current authorization and return the ORIGINAL result; changed arguments under the same key fail.
   */
  private async mutate<R>(
    actor: BoardActor,
    name: string,
    resource: string,
    input: { requestId: string },
    authorize: (data: BoardData) => void,
    run: (draft: BoardData) => R,
    resultSchema: z.ZodType<R>,
    guard?: () => void
  ): Promise<R> {
    this.requireOpen();
    return this.mutex.run(async () => {
      const data = this.requireOpen();
      this.mutationGuard?.();
      const actorId = actor.kind === 'coordinator' ? actor.ownerId : actor.workerId;
      const key = digest([actor.kind, actorId, input.requestId]);
      const fingerprint = digest([name, resource, canonical(input)]);
      const recorded = data.requests[key];
      if (recorded) {
        authorize(data);
        if (recorded.fingerprint !== fingerprint) {
          throw new WorkerError('request_reuse_conflict', 'This requestId was already used with different arguments; choose a new requestId.');
        }
        guard?.();
        return resultSchema.parse(recorded.result);
      }
      if (Object.keys(data.requests).length >= limits.requests) {
        throw new WorkerError('capacity_exceeded', `The board already holds ${limits.requests} recorded requests; no more mutations can be accepted.`);
      }
      authorize(data);
      const draft = structuredClone(data);
      const result = run(draft);
      guard?.();
      draft.requests[key] = { fingerprint, result: structuredClone(result), at: new Date().toISOString() };
      await this.commit(draft);
      return structuredClone(result);
    });
  }

  async createTeam(actor: BoardActor, input: TeamCreateInput): Promise<Team> {
    const trusted = boardActor.parse(actor);
    const parsed = teamCreateInput.parse(input);
    const owner = requireCoordinator(trusted);
    return this.mutate(trusted, 'createTeam', 'board', parsed,
      () => {
        requireCoordinator(trusted);
      },
      data => {
        if (data.teams.length >= limits.teams) {
          throw new WorkerError('capacity_exceeded', `The board already holds ${limits.teams} teams.`);
        }
        const now = new Date().toISOString();
        const team: Team = {
          id: randomUUID().replace(/-/g, ''),
          name: parsed.name,
          description: parsed.description,
          workspaceRoot: this.root,
          coordinatorOwnerId: owner,
          memberWorkerIds: [],
          revision: 0,
          createdAt: now,
          updatedAt: now,
          history: emptyHistory()
        };
        this.pushHistory(team.history, trusted, { revision: 0, reason: 'created' });
        data.teams.push(team);
        return team;
      },
      teamSchema);
  }

  async updateTeam(actor: BoardActor, input: TeamUpdateInput): Promise<Team> {
    const trusted = boardActor.parse(actor);
    const parsed = teamUpdateInput.parse(input);
    const owner = requireCoordinator(trusted);
    const authorize = (data: BoardData): void => {
      if (this.findTeam(data, parsed.teamId).coordinatorOwnerId !== owner) {
        throw new WorkerError('forbidden', `Team ${parsed.teamId} belongs to a different coordinator.`);
      }
    };
    return this.mutate(trusted, 'updateTeam', `team:${parsed.teamId}`, parsed,
      authorize,
      data => {
        authorize(data);
        const team = this.findTeam(data, parsed.teamId);
        if (team.revision !== parsed.expectedRevision) {
          throw new WorkerError('revision_conflict', `Team ${team.id} is at revision ${team.revision}; expected ${parsed.expectedRevision}.`);
        }
        const add = parsed.addMembers ?? [];
        const remove = parsed.removeMembers ?? [];
        if (new Set(add).size !== add.length || new Set(remove).size !== remove.length) {
          throw new WorkerError('invalid_arguments', 'Member lists contain duplicates.');
        }
        for (const workerId of add) {
          if (team.memberWorkerIds.includes(workerId)) {
            throw new WorkerError('conflict', `Worker ${workerId} is already a member of team ${team.id}.`);
          }
          this.requireEligibleMember(team, workerId);
        }
        for (const workerId of remove) {
          if (!team.memberWorkerIds.includes(workerId)) {
            throw new WorkerError('not_found', `Worker ${workerId} is not a member of team ${team.id}.`);
          }
          const busy = this.busyTask(data, workerId, team.id);
          if (busy) {
            throw new WorkerError('member_busy', `Worker ${workerId} still holds an active assignment on task ${busy.id} in team ${team.id}.`);
          }
        }
        if (team.memberWorkerIds.length + add.length - remove.length > limits.members) {
          throw new WorkerError('capacity_exceeded', `A team can hold at most ${limits.members} members.`);
        }
        team.memberWorkerIds = [...team.memberWorkerIds.filter(id => !remove.includes(id)), ...add];
        if (parsed.name !== undefined) {
          team.name = parsed.name;
        }
        if (parsed.description !== undefined) {
          team.description = parsed.description;
        }
        team.revision++;
        team.updatedAt = new Date().toISOString();
        const parts: string[] = [];
        if (parsed.name !== undefined) {
          parts.push('name');
        }
        if (parsed.description !== undefined) {
          parts.push('description');
        }
        if (add.length) {
          parts.push(`+${add.length} members`);
        }
        if (remove.length) {
          parts.push(`-${remove.length} members`);
        }
        this.pushHistory(team.history, trusted, { revision: team.revision, reason: parts.length ? parts.join(', ') : 'no-op update' });
        return team;
      },
      teamSchema);
  }

  /** A worker owns a task only when it is the explicit current assignee; unassigned tasks are not editable by members. */
  private workerOwnsTask(task: BoardTask, _team: Team, workerId: string): boolean {
    return task.assigneeWorkerId === workerId;
  }

  /** Current live authorization a worker must still satisfy on every update, including idempotent replays. */
  private authorizeWorkerTask(_data: BoardData, team: Team, task: BoardTask, workerId: string): void {
    if (!team.memberWorkerIds.includes(workerId)) {
      throw new WorkerError('forbidden', `Worker ${workerId} is not a member of team ${team.id}.`);
    }
    this.requireEligibleMember(team, workerId);
    if (!this.workerOwnsTask(task, team, workerId)) {
      throw new WorkerError('forbidden', `Worker ${workerId} does not currently hold task ${task.id}.`);
    }
  }

  /** Explicit transition table; the worker's subset is a strict subset of the coordinator's. */
  private assertTransition(task: BoardTask, to: TaskState, actor: BoardActor): void {
    if (task.state === to && !isTerminalState(task.state)) {
      return;
    }
    if (!TASK_TRANSITIONS[task.state].includes(to)) {
      throw new WorkerError('transition_invalid', `Cannot move task ${task.id} from ${task.state} to ${to}.`);
    }
    if (actor.kind === 'worker') {
      if (!WORKER_TRANSITIONS[task.state].includes(to)) {
        throw new WorkerError('transition_invalid', `Workers cannot move a task from ${task.state} to ${to}.`);
      }
      if (to !== 'failed' && task.assigneeWorkerId !== actor.workerId) {
        throw new WorkerError('transition_invalid', `Worker ${actor.workerId} is not the assignee of task ${task.id}.`);
      }
    }
  }

  /** A verdict must reference an existing exact artifactId+candidateVersion; resultRef metadata is immutable when reused. */
  private assertValidation(_data: BoardData, task: BoardTask, candidateVersion: number, artifactId: string, resultRef?: Ref): void {
    if (!task.candidates.some(ref => ref.id === artifactId && ref.version === candidateVersion)) {
      throw new WorkerError('validation_invalid', `Task ${task.id} has no candidate artifact ${artifactId} v${candidateVersion}.`);
    }
    const existing = resultRef ? task.validations.find(ref => ref.resultRef?.id === resultRef.id && ref.resultRef?.version === resultRef.version) : undefined;
    if (existing?.resultRef && resultRef && (
      existing.resultRef.uri !== resultRef.uri
      || existing.resultRef.label !== resultRef.label
    )) {
      throw new WorkerError('validation_invalid', `The resultRef of validation ${artifactId} v${candidateVersion} is immutable.`);
    }
  }

  /** Acceptance gate: validating, candidates present, readiness clean, and a PASSED verdict for the LATEST version of every artifact. */
  private assertAcceptable(data: BoardData, task: BoardTask): void {
    if (task.state !== 'validating') {
      throw new WorkerError('transition_invalid', `Task ${task.id} can only be accepted from validating.`);
    }
    if (task.candidates.length === 0) {
      throw new WorkerError('acceptance_invalid', `Task ${task.id} has no submitted candidates to accept.`);
    }
    const view = this.toTaskView(data, task);
    if (!view.readiness.ready) {
      const reasons = [
        ...view.readiness.unmetDependencies.map(dep => `${dep.kind}:${dep.taskId} (${dep.reason})`),
        ...view.readiness.blockers.map(blocker => `blocker: ${blocker}`)
      ];
      throw new WorkerError('acceptance_invalid', `Task ${task.id} is not ready for acceptance: ${reasons.join('; ')}.`);
    }
    const latest = new Map<string, number>();
    for (const candidate of task.candidates) {
      latest.set(candidate.id, Math.max(latest.get(candidate.id) ?? 0, candidate.version));
    }
    for (const [artifactId, version] of latest) {
      if ([...task.validations].reverse().find(ref => ref.artifactId === artifactId && ref.candidateVersion === version)?.outcome !== 'passed') {
        throw new WorkerError('acceptance_invalid', `Task ${task.id} has no passed verdict for the latest candidate ${artifactId} v${version}; stale or failed verdicts do not count.`);
      }
    }
  }

  /** Immutable, versioned ref list updates: same id/version must be an exact no-op; versions advance per id. */
  private applyRefList(task: BoardTask, label: 'candidates' | 'agreedContracts', refs: Ref[]): void {
    if (refs.length === 0) {
      return;
    }
    if (refs.length > limits.contracts) {
      throw new WorkerError('capacity_exceeded', `A task can hold at most ${limits.contracts} ${label}.`);
    }
    const existing = task[label];
    const incoming = refs.map(ref => ({ ...ref }));
    if (existing.length + new Set(incoming.filter(ref => !existing.some(x => x.id === ref.id && x.version === ref.version)).map(ref => JSON.stringify([ref.id, ref.version]))).size > (label === 'candidates' ? limits.candidates : limits.contracts)) {
      throw new WorkerError('capacity_exceeded', `A task can hold at most ${label === 'candidates' ? limits.candidates : limits.contracts} ${label}.`);
    }
    for (const ref of incoming) {
      const match = existing.find(candidate => candidate.id === ref.id && candidate.version === ref.version);
      if (match) {
        if (match.uri !== ref.uri || match.label !== ref.label) {
          throw new WorkerError('ref_conflict', `${label[0].toUpperCase()}${label.slice(1)} ${ref.id} v${ref.version} already has a different uri.`);
        }
        continue;
      }
      const sameId = existing.filter(candidate => candidate.id === ref.id);
      if (sameId.length > 0 && ref.version <= Math.max(...sameId.map(candidate => candidate.version))) {
        throw new WorkerError('ref_conflict', `New ${label} ${ref.id} versions must advance beyond v${Math.max(...sameId.map(candidate => candidate.version))}.`);
      }
      existing.push(ref);
    }
  }

  /** Contract agreement is independent of producer state; removal never invalidates an active consumer's dependency. */
  private applyContracts(data: BoardData, task: BoardTask, changes: { add?: Ref[]; remove?: { id: string; version: number }[] }): void {
    const add = changes.add ?? [];
    const remove = changes.remove ?? [];
    if (add.length > limits.contracts) {
      throw new WorkerError('capacity_exceeded', `A task can hold at most ${limits.contracts} agreed contracts.`);
    }
    for (const key of remove) {
      if (!task.agreedContracts.some(ref => ref.id === key.id && ref.version === key.version)) {
        throw new WorkerError('not_found', `Task ${task.id} has no agreed contract ${key.id} v${key.version}.`);
      }
    }
    const removeKeys = new Set(remove.map(key => `${key.id}:${key.version}`));
    const keep = task.agreedContracts.filter(ref => !removeKeys.has(`${ref.id}:${ref.version}`));
    for (const key of remove) {
      for (const consumer of data.tasks) {
        const depends = consumer.dependencies.some(dep => dep.taskId === task.id && dep.kind === 'contract');
        const active = !['ready', 'failed', 'cancelled'].includes(consumer.state);
        if (depends && active) {
          throw new WorkerError('contract_in_use', `Contract ${key.id} v${key.version} is still used by active task ${consumer.id}; it cannot be removed.`);
        }
      }
    }
    task.agreedContracts = keep;
    this.applyRefList(task, 'agreedContracts', add);
  }

  /** Starting (ready->in_progress) and submitting (in_progress->submitted) are gated on the derived readiness, blockers included. */
  private assertStartTransition(data: BoardData, task: BoardTask, to: TaskState): void {
    // Same-state updates are not a start/submit action, so the readiness gate must not run
    // against just-applied blockers/candidates; true starts and submissions are still gated.
    if (task.state === to && !isTerminalState(task.state)) {
      return;
    }
    if (to !== 'in_progress' && to !== 'submitted') {
      return;
    }
    const view = this.toTaskView(data, task);
    if (!view.readiness.ready) {
      const reasons = [
        ...view.readiness.unmetDependencies.map(dep => `${dep.kind}:${dep.taskId} (${dep.reason})`),
        ...view.readiness.blockers.map(blocker => `blocker: ${blocker}`)
      ];
      throw new WorkerError('transition_blocked', `Task ${task.id} is not ready to ${to === 'submitted' ? 'submit' : 'start'}: ${reasons.join('; ')}.`);
    }
    if (to === 'submitted' && task.candidates.length === 0) {
      throw new WorkerError('transition_blocked', `Task ${task.id} has no candidate artifacts to submit.`);
    }
  }

  async updateTask(actor: BoardActor, input: unknown, authorize?: () => void): Promise<BoardTask> {
    const trusted = boardActor.parse(actor);
    const isCoordinator = trusted.kind === 'coordinator';
    const parsed: CoordinatorTaskUpdateInput = isCoordinator
      ? coordinatorTaskUpdateInput.parse(input)
      : workerTaskUpdateInput.parse(input);
    const owner = trusted.kind === 'coordinator' ? trusted.ownerId : trusted.workerId;
    return this.mutate(trusted, 'updateTask', `task:${parsed.taskId}`, parsed,
      data => {
        const team = this.findTeam(data, this.findTask(data, parsed.taskId).teamId);
        if (isCoordinator) {
          if (team.coordinatorOwnerId !== owner) {
            throw new WorkerError('forbidden', `Team ${team.id} belongs to a different coordinator.`);
          }
        } else {
          this.authorizeWorkerTask(data, team, this.findTask(data, parsed.taskId), owner);
        }
        authorize?.();
      },
      data => {
        const team = this.findTeam(data, this.findTask(data, parsed.taskId).teamId);
        const task = this.findTask(data, parsed.taskId);
        if (task.revision !== parsed.expectedRevision) {
          throw new WorkerError('revision_conflict', `Task ${task.id} is at revision ${task.revision}; expected ${parsed.expectedRevision}.`);
        }
        const prev = task.state;
        const prevAssignee = task.assigneeWorkerId;
        if (task.state === 'accepted') {
          throw new WorkerError('terminal', `Task ${task.id} is accepted and immutable.`);
        }
        if (task.state === 'cancelled') {
          throw new WorkerError('terminal', `Task ${task.id} is cancelled and immutable.`);
        }
        if (parsed.progress !== undefined) {
          task.progress = parsed.progress;
        }
        if (parsed.blockers !== undefined) {
          task.blockers = parsed.blockers;
        }
        const canEditStructure = task.state === 'ready' || task.state === 'failed';
        const canEditText = task.state === 'ready' || task.state === 'in_progress' || task.state === 'submitted' || task.state === 'validating' || task.state === 'failed';
        if (parsed.acceptanceCriteria !== undefined) {
          if (!canEditStructure) {
            throw new WorkerError('transition_invalid', `Task ${task.id} acceptance criteria can only change while ready or failed.`);
          }
          task.acceptanceCriteria = parsed.acceptanceCriteria;
        }
        if (parsed.dependencies !== undefined) {
          if (!canEditStructure) {
            throw new WorkerError('transition_invalid', `Task ${task.id} dependencies can only change while ready or failed.`);
          }
          task.dependencies = parsed.dependencies;
        }
        if (parsed.assigneeWorkerId !== undefined) {
          if (task.assigneeWorkerId === parsed.assigneeWorkerId) {
            // exact no-op
          } else {
            if (!canEditStructure) {
              throw new WorkerError('transition_invalid', `Task ${task.id} assignment can only change while ready or failed.`);
            }
            if (parsed.assigneeWorkerId !== null) {
              this.requireEligibleMember(team, parsed.assigneeWorkerId);
              if (!team.memberWorkerIds.includes(parsed.assigneeWorkerId)) {
                throw new WorkerError('member_invalid', `Worker ${parsed.assigneeWorkerId} is not a member of team ${team.id}.`);
              }
              if (this.busyTask(data, parsed.assigneeWorkerId)) {
                throw new WorkerError('assignment_conflict', `Worker ${parsed.assigneeWorkerId} still holds an active assignment.`);
              }
            }
            task.assigneeWorkerId = parsed.assigneeWorkerId;
          }
        }
        if (!canEditText) {
          throw new WorkerError('transition_invalid', `Task ${task.id} title and description can only change while non-terminal.`);
        }
        if (parsed.title !== undefined) {
          task.title = parsed.title;
        }
        if (parsed.description !== undefined) {
          task.description = parsed.description;
        }
        if (parsed.candidates !== undefined) {
          const to = parsed.state;
          const candidateStateOk = task.state === 'ready' || task.state === 'in_progress'
            || (task.state === 'submitted' && to === 'submitted');
          if (isCoordinator) {
            if (task.state === 'validating') {
              throw new WorkerError('transition_invalid', `Candidates can no longer change while ${task.state}.`);
            }
          } else if (!candidateStateOk) {
            throw new WorkerError('transition_invalid', `Worker candidates can only be set while ready/in_progress or on the submission update.`);
          }
          this.applyRefList(task, 'candidates', parsed.candidates);
        }
        if (isCoordinator && parsed.agreedContracts) {
          this.applyContracts(data, task, parsed.agreedContracts);
        }
        if (parsed.validations !== undefined) {
          if (!isCoordinator) {
            throw new WorkerError('forbidden', 'Only the coordinator records validation verdicts.');
          }
          if (task.state !== 'validating') {
            throw new WorkerError('validation_invalid', `Validations can only be recorded while the task is validating.`);
          }
          const additions = parsed.validations.map(v => structuredClone(v));
          const capacity = limits.validations - task.validations.length;
          const dedup = new Map(additions.map(v => [digest(v), v]));
          for (const v of dedup.values()) {
            this.assertValidation(data, task, v.candidateVersion, v.artifactId, v.resultRef);
          }
          const fresh = [...dedup.values()].filter(v => !task.validations.some(x => digest(x) === digest(v)));
          if (fresh.length > capacity) {
            throw new WorkerError('capacity_exceeded', `A task can hold at most ${limits.validations} validations.`);
          }
          for (const v of fresh) {
            task.validations.push(v);
          }
        }
        let to: TaskState | undefined;
        if (parsed.state !== undefined) {
          to = parsed.state;
          this.assertTransition(task, to, trusted);
          this.assertStartTransition(data, task, to);
          if (to === 'accepted') {
            this.assertAcceptable(data, task);
          }
          if (to === 'validating' && task.candidates.length === 0) {
            throw new WorkerError('transition_invalid', `Task ${task.id} needs at least one submitted candidate before validating.`);
          }
          if (to === 'in_progress' && prev !== 'ready') {
            task.validations = [];
          }
          if (to === 'ready') {
            task.validations = [];
          }
          task.state = to;
          if (activeTaskStates.includes(task.state) && task.assigneeWorkerId) {
            this.requireEligibleMember(team, task.assigneeWorkerId);
          }
        }
        const parts: string[] = [];
        if (to !== undefined && to !== prev) {
          const label = prev === 'ready' && to === 'in_progress' ? 'started'
            : prev === 'in_progress' && to === 'submitted' ? 'submitted'
              : prev === 'submitted' && to === 'validating' ? 'validating'
                : prev === 'validating' && to === 'accepted' ? 'accepted'
                  : `${prev}->${to}`;
          parts.push(label);
        }
        if (parsed.title !== undefined) {
          parts.push('title');
        }
        if (parsed.description !== undefined) {
          parts.push('description');
        }
        if (parsed.acceptanceCriteria !== undefined) {
          parts.push('criteria');
        }
        if (parsed.dependencies !== undefined) {
          parts.push('dependencies');
        }
        if (parsed.assigneeWorkerId !== undefined && parsed.assigneeWorkerId !== prevAssignee) {
          parts.push('assignment');
        }
        if (parsed.candidates !== undefined) {
          parts.push('candidates');
        }
        if (isCoordinator && parsed.agreedContracts) {
          parts.push('contracts');
        }
        if (parsed.validations !== undefined) {
          parts.push('validations');
        }
        if (parsed.progress !== undefined) {
          parts.push('progress');
        }
        if (parsed.blockers !== undefined) {
          parts.push('blockers');
        }
        const reason = parsed.reason ?? (parts.length ? parts.join(', ') : 'no-op update');
        task.revision++;
        task.updatedAt = new Date().toISOString();
        this.pushHistory(task.history, trusted, {
          revision: task.revision,
          reason,
          from: to !== undefined ? prev : undefined,
          to: to !== undefined ? to : undefined
        });
        return task;
      },
      taskSchema,
      authorize);
  }

  async createTask(actor: BoardActor, input: unknown): Promise<BoardTask> {
    const trusted = boardActor.parse(actor);
    const parsed = taskCreateInput.parse(input);
    const owner = requireCoordinator(trusted);
    return this.mutate(trusted, 'createTask', `team:${parsed.teamId}`, parsed,
      data => {
        const team = this.findTeam(data, parsed.teamId);
        if (team.coordinatorOwnerId !== owner) {
          throw new WorkerError('forbidden', `Team ${parsed.teamId} belongs to a different coordinator.`);
        }
      },
      data => {
        if (data.tasks.length >= limits.tasks) {
          throw new WorkerError('capacity_exceeded', `The board already holds ${limits.tasks} tasks.`);
        }
        const team = this.findTeam(data, parsed.teamId);
        const assignee = parsed.assigneeWorkerId ?? null;
        if (assignee) {
          this.requireEligibleMember(team, assignee);
          if (!team.memberWorkerIds.includes(assignee)) {
            throw new WorkerError('member_invalid', `Worker ${assignee} is not a member of team ${team.id}.`);
          }
          const busy = this.busyTask(data, assignee);
          if (busy) {
            throw new WorkerError('assignment_conflict', `Worker ${assignee} still holds active assignment on task ${busy.id}.`);
          }
        }
        const now = new Date().toISOString();
        const task: BoardTask = {
          id: randomUUID().replace(/-/g, ''),
          teamId: team.id,
          title: parsed.title,
          description: parsed.description,
          acceptanceCriteria: parsed.acceptanceCriteria ?? [],
          dependencies: parsed.dependencies ?? [],
          assigneeWorkerId: assignee,
          progress: '',
          blockers: [],
          state: 'ready',
          candidates: [],
          agreedContracts: [],
          validations: [],
          revision: 0,
          createdAt: now,
          updatedAt: now,
          history: emptyHistory()
        };
        this.pushHistory(task.history, trusted, { revision: 0, reason: 'created' });
        data.tasks.push(task);
        return task;
      },
      taskSchema);
  }

  /** Derived readiness: contract deps need agreed contracts on the producer; artifact deps need acceptance plus candidates. */
  private toTaskView(data: BoardData, task: BoardTask): TaskView {
    const unmet: UnmetDependency[] = [];
    for (const dependency of task.dependencies) {
      const producer = data.tasks.find(candidate => candidate.id === dependency.taskId);
      if (!producer) {
        unmet.push({ taskId: dependency.taskId, kind: dependency.kind, reason: 'missing task' });
        continue;
      }
      if (dependency.kind === 'contract') {
        if (producer.agreedContracts.length === 0) {
          unmet.push({ taskId: dependency.taskId, kind: dependency.kind, reason: 'producer has no agreed contracts' });
        }
      } else if (producer.state !== 'accepted' || producer.candidates.length === 0) {
        unmet.push({ taskId: dependency.taskId, kind: dependency.kind, reason: 'producer is not accepted with candidate artifacts' });
      }
    }
    const blockers = [...task.blockers];
    return {
      ...structuredClone(task),
      readiness: { ready: unmet.length === 0 && blockers.length === 0, unmetDependencies: unmet, blockers }
    };
  }

  getTeam(actor: BoardActor, id: string): Team {
    const trusted = boardActor.parse(actor);
    if (typeof id !== 'string' || !id) {
      throw new WorkerError('invalid_arguments', 'Team id is required.');
    }
    const team = this.findTeam(this.requireOpen(), id);
    this.authorizeRead(trusted, team);
    return structuredClone(team);
  }

  getTask(actor: BoardActor, id: string): TaskView {
    const trusted = boardActor.parse(actor);
    if (typeof id !== 'string' || !id) {
      throw new WorkerError('invalid_arguments', 'Task id is required.');
    }
    const data = this.requireOpen();
    const task = this.findTask(data, id);
    this.authorizeRead(trusted, this.findTeam(data, task.teamId));
    return this.toTaskView(data, task);
  }

  listTeams(actor: BoardActor): Team[] {
    const trusted = boardActor.parse(actor);
    const data = this.requireOpen();
    return data.teams.filter(team => {
      try {
        this.authorizeRead(trusted, team);
        return true;
      } catch {
        return false;
      }
    }).map(team => structuredClone(team));
  }

  listTasks(actor: BoardActor, teamId?: string): TaskView[] {
    const trusted = boardActor.parse(actor);
    const data = this.requireOpen();
    if (teamId !== undefined && (typeof teamId !== 'string' || !teamId)) {
      throw new WorkerError('invalid_arguments', 'Team id filter must be a non-empty string.');
    }
    return data.tasks
      .filter(task => teamId === undefined || task.teamId === teamId)
      .filter(task => {
        try {
          this.authorizeRead(trusted, this.findTeam(data, task.teamId));
          return true;
        } catch {
          return false;
        }
      })
      .map(task => this.toTaskView(data, task));
  }

  /** Trusted internal read for the host UI; no actor, no MCP mutation path, cloned records. */
  snapshot(): BoardSnapshot {
    const data = this.requireOpen();
    return {
      workspaceRoot: data.workspaceRoot,
      teams: data.teams.map(team => structuredClone(team)),
      tasks: data.tasks.map(task => this.toTaskView(data, task))
    };
  }
}
