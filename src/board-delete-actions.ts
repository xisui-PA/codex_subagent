import path from 'node:path';
import { WorkerError } from './types';
import type { BoardWorkspaceStatus } from './task-board-summary';

/**
 * Manual HARD deletion of one task-board record.
 *
 * This is a UI action helper, not a board API: it never chooses a record on its
 * own, never supplies an actor, and never retries or reprepares after an
 * uncertain result. A fresh board status resolves the requested node to the
 * canonical host root and current ids, the read-only prepare route supplies the
 * exact current revision and epoch-qualified request id, and a modal
 * confirmation must succeed before the single strict delete call is made.
 */

export type BoardDeleteKind = 'task' | 'team';

/** Explicit tree-node metadata; never derived from a compound node id. */
export interface BoardDeleteTarget {
  workspaceRoot: string;
  teamId: string;
  taskId?: string;
}

export interface BoardDeleteRequest extends BoardDeleteTarget {
  kind: BoardDeleteKind;
}

/** One concise palette entry carrying root/team/task context and its target. */
export interface BoardDeleteChoice {
  label: string;
  description: string;
  detail: string;
  target: BoardDeleteTarget;
}

export interface BoardDeletePrepareInput {
  kind: BoardDeleteKind;
  teamId: string;
  taskId?: string;
  requestId: string;
}

export interface PreparedTaskDeletion {
  kind: 'task';
  teamId: string;
  taskId: string;
  title: string;
  revision: number;
  requestId: string;
}

export interface PreparedTeamDeletion {
  kind: 'team';
  teamId: string;
  name: string;
  revision: number;
  requestId: string;
}

export type PreparedBoardDeletion = PreparedTaskDeletion | PreparedTeamDeletion;

/** Narrow ports so the confirmation flow is testable without real dialogs. */
export interface BoardDeletePorts {
  boardStatus(): Promise<readonly BoardWorkspaceStatus[]>;
  prepare(workspaceRoot: string, input: BoardDeletePrepareInput): Promise<unknown>;
  invoke(workspaceRoot: string, command: 'ui_board_delete_task' | 'ui_board_delete_team', args: Record<string, unknown>): Promise<unknown>;
  confirm(message: string, detail: string): Promise<boolean>;
  pick(choices: readonly BoardDeleteChoice[]): Promise<BoardDeleteChoice | undefined>;
  info(message: string): void;
  refresh(): Promise<void>;
  seed(): string;
}

export interface BoardDeleteResult {
  status: 'deleted' | 'cancelled' | 'unavailable';
  kind?: BoardDeleteKind;
  id?: string;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const sameRoot = (left: string, right: string): boolean =>
  left === right || path.resolve(left) === path.resolve(right);
const stale = (what: string): WorkerError => new WorkerError('not_found',
  `That board ${what} is no longer on this workspace board. Refresh the Task Board and choose a current item.`);
const protocol = (): WorkerError => new WorkerError('invalid_response',
  'The board did not return a valid deletion preparation. Refresh the Task Board and try again; nothing was deleted.');

/** Resolve one explicit target against a fresh status; ids must match exactly. */
export function resolveBoardDeleteTarget(statuses: readonly BoardWorkspaceStatus[], request: BoardDeleteRequest): BoardDeleteRequest {
  if (!text(request.workspaceRoot) || !text(request.teamId) || !text(request.kind)
    || (request.kind === 'task' && !text(request.taskId))) {
    throw stale('record');
  }
  if (request.kind === 'team' && request.taskId !== undefined) {
    throw new WorkerError('invalid_arguments', 'A team deletion cannot name a task.');
  }
  const row = statuses.find(entry => entry.workspaceRoot === request.workspaceRoot)
    ?? statuses.find(entry => sameRoot(entry.workspaceRoot, request.workspaceRoot));
  if (!row) {
    throw stale('workspace');
  }
  const team = row.teams.find(entry => entry.id === request.teamId);
  if (!team) {
    throw stale('team');
  }
  if (request.kind === 'task') {
    const task = row.tasks.find(entry => entry.id === request.taskId);
    if (!task || task.teamId !== team.id) {
      throw stale('task');
    }
    return { kind: 'task', workspaceRoot: row.workspaceRoot, teamId: team.id, taskId: task.id };
  }
  return { kind: 'team', workspaceRoot: row.workspaceRoot, teamId: team.id };
}

/** Palette choices for one command: real teams, or real tasks with a live team. */
export function boardDeleteChoices(statuses: readonly BoardWorkspaceStatus[], kind: BoardDeleteKind): BoardDeleteChoice[] {
  const choices: BoardDeleteChoice[] = [];
  for (const row of statuses) {
    if (kind === 'team') {
      for (const team of row.teams) {
        choices.push({
          label: team.namePreview || team.id,
          description: `Team - rev ${team.revision} - ${row.tasks.filter(task => task.teamId === team.id).length} task(s)`,
          detail: `${row.workspaceRoot} - team ${team.id}`,
          target: { workspaceRoot: row.workspaceRoot, teamId: team.id }
        });
      }
      continue;
    }
    for (const task of row.tasks) {
      if (!row.teams.some(team => team.id === task.teamId)) {
        continue;
      }
      choices.push({
        label: task.titlePreview || task.id,
        description: `Task - ${task.state} - rev ${task.revision}`,
        detail: `${row.workspaceRoot} - team ${task.teamId} - task ${task.id}`,
        target: { workspaceRoot: row.workspaceRoot, teamId: task.teamId, taskId: task.id }
      });
    }
  }
  return choices;
}

const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);

function validatePrepared(value: unknown, request: BoardDeleteRequest): PreparedBoardDeletion {
  if (!value || typeof value !== 'object') {
    throw protocol();
  }
  const candidate = value as Record<string, unknown>;
  const revision = candidate.revision;
  const requestId = candidate.requestId;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || !text(requestId)) {
    throw protocol();
  }
  if (request.kind === 'task' && candidate.kind === 'task') {
    if (candidate.teamId !== request.teamId || candidate.taskId !== request.taskId || typeof candidate.title !== 'string') {
      throw protocol();
    }
    return {
      kind: 'task', teamId: request.teamId, taskId: request.taskId!,
      title: candidate.title, revision, requestId
    };
  }
  if (request.kind === 'team' && candidate.kind === 'team') {
    if (candidate.teamId !== request.teamId || typeof candidate.name !== 'string') {
      throw protocol();
    }
    return { kind: 'team', teamId: request.teamId, name: candidate.name, revision, requestId };
  }
  throw protocol();
}

function confirmation(prepared: PreparedBoardDeletion, workspaceRoot: string): { message: string; detail: string } {
  const where = `Workspace: ${workspaceRoot}\nTeam: ${prepared.teamId}`;
  if (prepared.kind === 'task') {
    return {
      message: `Delete task “${oneLine(prepared.title)}”?`,
      detail: `${where}\nTask: ${prepared.taskId}\n\nThis permanently removes the task board record. No worker is stopped or started, and worker history, artifacts, pins and runner/integration content are not deleted. Dependencies or active work block deletion.`
    };
  }
  return {
    message: `Delete team “${oneLine(prepared.name)}”?`,
    detail: `${where}\n\nThis permanently removes the team record and ends live membership authorization. Administer retained resources BEFORE deleting if you need them. Tasks are never deleted with the team, and existing tasks, active work or an unreleased integration attempt block deletion.`
  };
}

/**
 * Run one manual deletion. With a target (context menu) the node is resolved
 * against a fresh status; without one (palette) the caller's command kind picks
 * from real records. Cancellation never calls prepare's delete route or refresh.
 */
export async function manualBoardDelete(ports: BoardDeletePorts, options: { kind: BoardDeleteKind; target?: BoardDeleteTarget }): Promise<BoardDeleteResult> {
  const statuses = await ports.boardStatus();
  let request: BoardDeleteRequest;
  if (options.target) {
    request = resolveBoardDeleteTarget(statuses, { ...options.target, kind: options.kind });
  } else {
    const choices = boardDeleteChoices(statuses, options.kind);
    if (!choices.length) {
      ports.info(options.kind === 'task'
        ? 'No task board tasks are available. Enable codexSubagent.taskBoard.enabled and create a task first.'
        : 'No task board teams are available. Enable codexSubagent.taskBoard.enabled and create a team first.');
      return { status: 'unavailable', kind: options.kind };
    }
    const choice = await ports.pick(choices);
    if (!choice) {
      return { status: 'cancelled', kind: options.kind };
    }
    request = resolveBoardDeleteTarget(statuses, { ...choice.target, kind: options.kind });
  }

  const input: BoardDeletePrepareInput = request.kind === 'task'
    ? { kind: 'task', teamId: request.teamId, taskId: request.taskId!, requestId: ports.seed() }
    : { kind: 'team', teamId: request.teamId, requestId: ports.seed() };
  let prepared: PreparedBoardDeletion;
  try {
    prepared = validatePrepared(await ports.prepare(request.workspaceRoot, input), request);
  } catch (error) {
    // A read-only preparation can still reveal a changed board; refresh the
    // board view, but never reprepare automatically.
    await ports.refresh();
    throw error;
  }

  const prompt = confirmation(prepared, request.workspaceRoot);
  if (!await ports.confirm(prompt.message, prompt.detail)) {
    return { status: 'cancelled', kind: options.kind };
  }

  // Submit the host-returned epoch-qualified request id and exact revision; the
  // prepared object is never spread and no actor is ever supplied.
  const args = prepared.kind === 'task'
    ? { teamId: prepared.teamId, taskId: prepared.taskId, expectedRevision: prepared.revision, requestId: prepared.requestId }
    : { teamId: prepared.teamId, expectedRevision: prepared.revision, requestId: prepared.requestId };
  const command = prepared.kind === 'task' ? 'ui_board_delete_task' : 'ui_board_delete_team';
  let ack: unknown;
  try {
    ack = await ports.invoke(request.workspaceRoot, command, args);
  } catch (error) {
    // One explicit request only. A stale revision or busy worker/integration is
    // surfaced as-is; the user may retry manually with a new confirmation.
    await ports.refresh();
    throw error;
  }
  await ports.refresh();
  const expected = prepared.kind === 'task' ? 'task_deleted' : 'team_deleted';
  if (!ack || typeof ack !== 'object' || (ack as { kind?: unknown }).kind !== expected) {
    throw new WorkerError('invalid_response', 'The board did not acknowledge the deletion. Refresh the Task Board to verify the current records.');
  }
  return {
    status: 'deleted',
    kind: prepared.kind,
    id: prepared.kind === 'task' ? prepared.taskId : prepared.teamId
  };
}
