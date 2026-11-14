import { z } from 'zod';
import type { ToolResult } from './api';
import type { BoardActor, CoordinatorActor, WorkerActor } from './task-board-types';
import { boardGetInput, boardListInput, coordinatorTaskUpdateInput, taskCreateInput, teamCreateInput, teamUpdateInput, workerTaskUpdateInput } from './task-board-types';
import { failure, Session, Tool, WorkerError, WorkspaceTools } from './types';

/**
 * MCP descriptors and tool adapters for the persistent task board. The board
 * domain owns schema validation, persistence and live membership/assignment
 * checks; this module only derives strict tool schemas from the shared domain
 * inputs, binds the trusted coordinator or worker identity, and forwards calls
 * to a structural port. It never mutates board state itself.
 *
 * workspaceRoot is routing metadata for the MCP host: it is advertised in every
 * input schema and must be stripped by the host before invokeBoard, exactly like
 * api.invoke receives workspaceRoot as a separate argument. invokeBoard rejects
 * it, so a mis-routed call fails loudly instead of editing the wrong board.
 */

/** Trusted coordinator identity carried by every board MCP call; never board data. */
const ownerId = z.string().min(1).max(200).describe('Stable parent-conversation identifier used as the trusted coordinator identity. Pass the same value on every board call; it is removed before the board sees the request.');
const routing = { type: 'string', description: 'Optional absolute open-workspace or registered Git worktree root. Pass the returned worker workspaceRoot on subsequent controls; omit for the MCP working directory.' };

/**
 * Both listings page at the adapter: the domain returns the full array and this
 * page bounds one response well inside the bridge limit. Teams carry 100-entry
 * histories, so a full 64-team board is not small enough to return unpaged.
 */
const paging = {
  offset: z.number().int().min(0).default(0).describe('Zero-based index of the first record to return.'),
  limit: z.number().int().min(1).max(20).default(20).describe('Maximum records in this response (1-20). Follow nextOffset until it is null.')
};
const teamListPage = z.object({ ...paging }).strict();
const taskListPage = boardListInput.extend(paging).strict();

/** Coordinator schemas: shared domain inputs plus a required ownerId, strict throughout. */
const schemas = {
  subagent_team_create: teamCreateInput.extend({ ownerId }).strict(),
  subagent_team_get: boardGetInput.extend({ ownerId }).strict(),
  subagent_team_list: teamListPage.extend({ ownerId }).strict(),
  subagent_team_update: teamUpdateInput.extend({ ownerId }).strict(),
  subagent_task_create: taskCreateInput.extend({ ownerId }).strict(),
  subagent_task_get: boardGetInput.extend({ ownerId }).strict(),
  subagent_task_list: taskListPage.extend({ ownerId }).strict(),
  subagent_task_update: coordinatorTaskUpdateInput.extend({ ownerId }).strict()
};
export type BoardToolName = keyof typeof schemas;
export const boardToolNames = Object.keys(schemas) as BoardToolName[];

const descriptions: Record<BoardToolName, string> = {
  subagent_team_create: 'Create a team on the persistent task board. Reuse the same requestId and arguments when retrying an ambiguous call.',
  subagent_team_get: 'Read one team, including its revision, coordinator and members.',
  subagent_team_list: 'List the teams on this workspace folder’s board. Returns one page: teams plus nextOffset, which is null at the end. A page may hold fewer than limit items so one response stays bounded; follow nextOffset to read every team.',
  subagent_team_update: 'Update a team name, description or membership. expectedRevision must match the current revision; reuse the same requestId when retrying.',
  subagent_task_create: 'Create a task in a team with acceptance criteria, dependencies and an optional assignee. Creating a task never starts a worker; reuse the same requestId when retrying.',
  subagent_task_get: 'Read one task, including state, assignees, dependencies, candidates, contracts and validations.',
  subagent_task_list: 'List tasks on this workspace folder’s board, optionally filtered by teamId. Returns one page: tasks plus nextOffset, which is null at the end. A page may hold fewer than limit items so one response stays bounded; follow nextOffset to read every task.',
  subagent_task_update: 'Update a task as the coordinator: title, description, criteria, dependencies, assignment, agreed contracts, state or validations. expectedRevision must match the current revision.'
};

/** Every board tool is opt-in and record-only; the note keeps that explicit in the tool catalog. */
const note = ' Opt-in: requires the machine setting codexSubagent.taskBoard.enabled. Board tools read and update durable board records only; they never dispatch workers, start inference, edit files or automatically accept work. Acceptance is always an explicit coordinator decision.';

export function isBoardTool(name: string): name is BoardToolName {
  return Object.hasOwn(schemas, name);
}

/** One MCP tool descriptor, shaped exactly like the legacy api.mcpTools entries. */
export const boardMcpTools = boardToolNames.map(name => {
  const json = z.toJSONSchema(schemas[name]);
  const readOnly = name.endsWith('_get') || name.endsWith('_list');
  return {
    name,
    description: `${descriptions[name]}${note}`,
    inputSchema: { ...json, properties: { ...json.properties, workspaceRoot: routing } },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  };
});
export type BoardMcpTool = (typeof boardMcpTools)[number];

/**
 * Structural port the board domain implements. Inputs stay unknown here because
 * the domain re-validates them strictly; returns may be synchronous or promised
 * so the same interface accepts an in-memory or a file-backed board.
 *
 * listTeams stays a synchronous array so worker definitions can filter board
 * tools for non-members; listTasks returns the whole array for the team. The
 * adapter applies the request's page after the await, so the domain never pages.
 *
 * updateTask receives an optional authorize guard. The domain MUST invoke it
 * inside its own mutation mutex immediately before persisting, so a call that
 * waited behind another write rechecks model policy, the feature flag and
 * cancellation at application time instead of trusting the earlier precheck.
 */
export interface BoardPort {
  createTeam(actor: BoardActor, input: unknown): unknown | Promise<unknown>;
  getTeam(actor: BoardActor, id: string): unknown | Promise<unknown>;
  listTeams(actor: BoardActor): unknown | Promise<unknown>;
  updateTeam(actor: BoardActor, input: unknown): unknown | Promise<unknown>;
  createTask(actor: BoardActor, input: unknown): unknown | Promise<unknown>;
  getTask(actor: BoardActor, id: string): unknown | Promise<unknown>;
  listTasks(actor: BoardActor, teamId?: string): unknown | Promise<unknown>;
  updateTask(actor: BoardActor, input: unknown, authorize?: () => void): unknown | Promise<unknown>;
}

const record = (value: unknown): Record<string, unknown> => ({ ...(value as Record<string, unknown>) });
const teamIdOf = (args: Record<string, unknown>): string | undefined => typeof args.teamId === 'string' ? args.teamId : undefined;
const numberOf = (value: unknown, fallback: number): number => typeof value === 'number' ? value : fallback;

/**
 * Serialized inner-response budget for one page. The bridge wraps this JSON in a
 * second JSON string, so this cap keeps a page well inside the transport limit
 * even when every field is full of characters that escape.
 */
export const pageBudget = 3_000_000;

/** One bounded page of a domain array; nextOffset is null at the end. */
interface Page { items: unknown[]; nextOffset: number | null }

/**
 * Slice one page of a full domain array by the requested offset/limit and by the
 * serialized budget. When the budget runs out the page carries fewer items and
 * nextOffset advances by exactly what was returned, so walking pages returns
 * every record once, in order, with no drops or duplicates. A record that cannot
 * fit even alone fails loudly instead of being replaced or silently skipped.
 */
function boundPage(all: unknown[], args: Record<string, unknown>, key: 'tasks' | 'teams', getTool: string, noun: string): Page {
  const offset = numberOf(args.offset, 0);
  const limit = numberOf(args.limit, 20);
  if (offset >= all.length) {
    return { items: [], nextOffset: null };
  }
  const items: unknown[] = [];
  let size = JSON.stringify({ [key]: [], nextOffset: null }).length;
  for (const candidate of all.slice(offset, offset + limit)) {
    const projected = size + JSON.stringify(candidate).length + 1;
    if (projected > pageBudget) {
      break;
    }
    items.push(candidate);
    size = projected;
  }
  if (!items.length) {
    throw new WorkerError('response_too_large', `${noun} at offset ${offset} exceeds the ${pageBudget}-character page budget. Read it with ${getTool} instead of listing it.`);
  }
  const next = offset + items.length;
  return { items, nextOffset: next < all.length ? next : null };
}

async function teamPage(board: BoardPort, actor: BoardActor, args: Record<string, unknown>): Promise<{ teams: unknown[]; nextOffset: number | null }> {
  const all = await Promise.resolve(board.listTeams(actor));
  if (!Array.isArray(all)) {
    throw new WorkerError('internal_error', 'The task board did not return a team list.');
  }
  const page = boundPage(all, args, 'teams', 'subagent_team_get', 'Team');
  return { teams: page.items, nextOffset: page.nextOffset };
}

async function taskPage(board: BoardPort, actor: BoardActor, args: Record<string, unknown>): Promise<{ tasks: unknown[]; nextOffset: number | null }> {
  const all = await Promise.resolve(board.listTasks(actor, teamIdOf(args)));
  if (!Array.isArray(all)) {
    throw new WorkerError('internal_error', 'The task board did not return a task list.');
  }
  const page = boundPage(all, args, 'tasks', 'subagent_task_get', 'Task');
  return { tasks: page.items, nextOffset: page.nextOffset };
}

/**
 * Parse a strict worker tool input. Invalid inputs surface as
 * invalid_arguments, matching FileTools, whose ZodError results in the same
 * code; the domain still re-validates and owns every authorization decision.
 */
function strict(schema: z.ZodType, input: unknown): Record<string, unknown> {
  try {
    return record(schema.parse(input ?? {}));
  } catch (error) {
    throw error instanceof z.ZodError ? new WorkerError('invalid_arguments', z.prettifyError(error)) : error;
  }
}

/** Parsed coordinator input without ownerId; the actor is the only source of identity. */
function coordinatorCall(board: BoardPort, name: BoardToolName, actor: CoordinatorActor, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'subagent_team_create': return Promise.resolve(board.createTeam(actor, args));
    case 'subagent_team_get': return Promise.resolve(board.getTeam(actor, String(args.id)));
    case 'subagent_team_list': return teamPage(board, actor, args);
    case 'subagent_team_update': return Promise.resolve(board.updateTeam(actor, args));
    case 'subagent_task_create': return Promise.resolve(board.createTask(actor, args));
    case 'subagent_task_get': return Promise.resolve(board.getTask(actor, String(args.id)));
    case 'subagent_task_list': return taskPage(board, actor, args);
    case 'subagent_task_update': return Promise.resolve(board.updateTask(actor, args));
  }
  throw new WorkerError('unknown_tool', `Unknown board tool: ${String(name)}`);
}

/** Validate, extract the trusted actor and forward one coordinator board call. */
export async function invokeBoard(board: BoardPort, name: string, input: unknown): Promise<ToolResult> {
  try {
    if (!isBoardTool(name)) {
      throw new WorkerError('unknown_tool', `Unknown board tool: ${name}`);
    }
    const args = record(schemas[name].parse(input ?? {}));
    const actor: CoordinatorActor = { kind: 'coordinator', ownerId: String(args.ownerId) };
    delete args.ownerId;
    const result = await coordinatorCall(board, name, actor, args);
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
  } catch (error) {
    const problem = error instanceof z.ZodError ? { code: 'invalid_arguments', message: z.prettifyError(error), retryable: false } : failure(error);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: problem }) }] };
  }
}

/**
 * Worker-visible board schemas: reads plus an update limited to the worker's own
 * progress, blockers, candidate artifact refs and lifecycle subset. No ownerId,
 * actor or workerId field exists, so a spoofed identity fails strict parsing.
 */
const workerSchemas = {
  subagent_team_get: boardGetInput,
  subagent_team_list: teamListPage,
  subagent_task_get: boardGetInput,
  subagent_task_list: taskListPage,
  subagent_task_update: workerTaskUpdateInput
};
export type WorkerBoardToolName = keyof typeof workerSchemas;
export const workerBoardToolNames = Object.keys(workerSchemas) as WorkerBoardToolName[];
const workerDescriptions: Record<WorkerBoardToolName, string> = {
  subagent_team_get: 'Read one team you belong to, including its revision and members.',
  subagent_team_list: 'List the teams you belong to. Returns one page: teams plus nextOffset, which is null at the end. A page may hold fewer than limit items; follow nextOffset to read every team.',
  subagent_task_get: 'Read one task by id.',
  subagent_task_list: 'List tasks, optionally filtered by teamId. Returns one page: tasks plus nextOffset, which is null at the end. A page may hold fewer than limit items so one response stays bounded; follow nextOffset to read every task.',
  subagent_task_update: 'Report your own progress, blockers, candidate artifact refs or lifecycle state (in_progress, submitted, failed). Requires requestId and expectedRevision; reuse the same requestId on retry. This updates board metadata only: it grants no file access and does not accept the task.'
};
const workerTools: Tool[] = workerBoardToolNames.map(name => ({ name, description: workerDescriptions[name], inputSchema: z.toJSONSchema(workerSchemas[name]) }));
const workerNames = new Set<string>(workerBoardToolNames);
const boardNames = new Set<string>(boardToolNames);

/** Route a worker call; only the mutating update gets the guard, for the domain's own mutex. */
function workerCall(board: BoardPort, name: WorkerBoardToolName, actor: WorkerActor, args: Record<string, unknown>, guard?: () => void): Promise<unknown> {
  switch (name) {
    case 'subagent_team_get': return Promise.resolve(board.getTeam(actor, String(args.id)));
    case 'subagent_team_list': return teamPage(board, actor, args);
    case 'subagent_task_get': return Promise.resolve(board.getTask(actor, String(args.id)));
    case 'subagent_task_list': return taskPage(board, actor, args);
    case 'subagent_task_update': return Promise.resolve(board.updateTask(actor, args, guard));
  }
  throw new WorkerError('unknown_tool', `Unknown board tool: ${String(name)}`);
}

/**
 * Wrap workspace tools with worker-scoped board tools. The session bound here is
 * the ONLY source of worker identity: the engine resolves it via forSession and
 * the execute session argument is never used to impersonate another worker.
 * base stays authoritative for files, so file permissions and the authorize
 * callback are untouched; board metadata updates are not filesystem grants.
 * The domain enforces live team membership and task assignment on every call,
 * so definition filtering below is advisory only.
 */
export function workerBoardTools(board: BoardPort, session: Pick<Session, 'id'>, enabled: () => boolean, onChange: () => void, base: WorkspaceTools): WorkspaceTools {
  const workerId = session.id;
  const actor: WorkerActor = { kind: 'worker', workerId };
  let cached: boolean | undefined;
  const member = (teams: unknown): boolean => {
    if (!Array.isArray(teams)) {
      return false;
    }
    const listed = teams.filter(team => Array.isArray((team as { memberWorkerIds?: unknown } | null)?.memberWorkerIds));
    return listed.some(team => (team as { memberWorkerIds: unknown[] }).memberWorkerIds.includes(workerId));
  };
  function remember(teams: unknown): void {
    cached = member(teams);
  }
  function forget(): void {
    cached = false;
  }
  // Definitions are synchronous: only a synchronous team list can hide board
  // tools from non-members. An asynchronous answer primes the cache for a later
  // call; an unresolved or failed read hides board tools instead of guessing.
  // This reads the raw domain array, never the paged tool surface.
  const canSee = (): boolean => {
    try {
      const teams = board.listTeams(actor);
      if (Array.isArray(teams)) {
        return member(teams);
      }
      void Promise.resolve(teams).then(remember, forget);
      return cached ?? false;
    } catch {
      return false;
    }
  };
  const definitions = (permission: Session['permission']): Tool[] => {
    const files = base.definitions(permission);
    return enabled() && canSee() ? [...files, ...workerTools] : files;
  };
  const execute = async (name: string, input: Record<string, unknown>, permission: Session['permission'], signal: AbortSignal, current?: Session, authorize?: () => void): Promise<string> => {
    if (!boardNames.has(name)) {
      return base.execute(name, input, permission, signal, current, authorize);
    }
    // Rechecked before parsing and again by the domain inside its mutex right
    // before persistence, so a queue wait cannot hide a revocation.
    const check = (): void => {
      signal.throwIfAborted();
      authorize?.();
      if (!enabled()) {
        throw new WorkerError('feature_disabled', 'The task board is disabled, so board tools are unavailable.');
      }
    };
    check();
    if (!workerNames.has(name)) {
      throw new WorkerError('permission_denied', `${name} changes board records and is coordinator-only; workers may read board records and update their own task progress.`);
    }
    const tool = name as WorkerBoardToolName;
    const args = strict(workerSchemas[tool], input);
    const result = await workerCall(board, tool, actor, args, check);
    if (tool === 'subagent_task_update') {
      onChange();
    }
    return JSON.stringify(result ?? null);
  };
  return {
    get workspaceRoot() {
      return base.workspaceRoot;
    },
    definitions,
    execute,
    // Scoping must run through the wrapper so the bound identity follows the
    // scoped session; callers should not rebind identity by passing execute's
    // session argument.
    forSession: (scoped: Session) => workerBoardTools(board, scoped, enabled, onChange, base.forSession?.(scoped) ?? base)
  };
}
