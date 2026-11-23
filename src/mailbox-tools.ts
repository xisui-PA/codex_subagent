import { z } from 'zod';
import type { ToolResult } from './api';
import type { BoardActor, CoordinatorActor, WorkerActor } from './task-board-types';
import { acknowledgeMailboxInput, listMailboxInput, sendMailboxInput } from './team-mailbox';
import { failure, Session, Tool, WorkerError, WorkspaceTools } from './types';

/**
 * Opt-in durable team mail: MCP descriptors and the coordinator/worker adapters.
 *
 * The mailbox domain (team-mailbox) owns persistence, ordering, message
 * identity and every authorization decision; this module only derives strict
 * tool schemas from the shared domain inputs, binds the trusted coordinator or
 * worker identity, and forwards calls to a structural port. It never mutates
 * board state, never dispatches or starts a worker, and never touches files.
 *
 * The task board is the only identity authority: the coordinator identity is
 * the validated ownerId of the MCP call, and the worker identity is the scoped
 * session the runtime bound the tool surface to. Neither is ever read from the
 * request payload, and no worker schema carries an ownerId, actor, workerId or
 * team-membership field, so a forged identity fails strict parsing.
 *
 * workspaceRoot is routing metadata for the MCP host: it is advertised in every
 * input schema and is stripped by the runtime before invokeMailbox, exactly like
 * the board tools. invokeMailbox rejects it, so a mis-routed call fails loudly
 * instead of writing another root's mailbox.
 */

/** Trusted coordinator identity carried by every mailbox MCP call; never message data. */
const ownerId = z.string().min(1).max(200).describe('Stable parent-conversation identifier used as the trusted coordinator identity. Pass the same value on every mailbox call; it is removed before the mailbox sees the request.');
const routing = { type: 'string', description: 'Optional absolute open-workspace or registered Git worktree root. Pass the returned worker workspaceRoot on subsequent controls; omit for the MCP working directory.' };
const id32 = z.string().regex(/^[a-f0-9]{32}$/);

/**
 * Coordinator schemas: the shared domain inputs plus a required ownerId, strict
 * throughout. They are derived from the domain inputs instead of restating the
 * message fields, so the adapter can never drift from the validated contract.
 */
const schemas = {
  subagent_mailbox_send: sendMailboxInput.extend({ ownerId }).strict(),
  subagent_mailbox_list: listMailboxInput.extend({ ownerId }).strict(),
  subagent_mailbox_ack: acknowledgeMailboxInput.extend({ ownerId }).strict()
};
export type MailboxToolName = keyof typeof schemas;
export const mailboxToolNames = Object.keys(schemas) as MailboxToolName[];

/**
 * One mailbox record is bounded control metadata, so a write reserves the
 * smallest service-store headroom rather than a worker payload budget. It is
 * always released by an exact receipt, and reads never reserve at all.
 */
export function mailboxStorageReservation(): number {
  return 4 * 1024 ** 2;
}

const descriptions: Record<MailboxToolName, string> = {
  subagent_mailbox_send: 'Send one durable message to a team member of a team you coordinate. The message is stored for that worker and delivered only when it is already running; nothing is started, resumed or scheduled. Reuse the same requestId and arguments after an interrupted call.',
  subagent_mailbox_list: 'List the durable messages of one team you coordinate, including delivery and acknowledgement metadata, sorted by the mailbox sequence. Returns one bounded page.',
  subagent_mailbox_ack: 'Acknowledge one durable message addressed to you in a team you coordinate. Acknowledging never edits, deletes or re-sends the message and never changes the board.'
};

/** Every mailbox tool is opt-in and record-only; the note keeps that explicit in the catalog. */
const note = ' Opt-in: requires the machine settings codexSubagent.taskBoard.enabled and codexSubagent.taskBoard.messaging.enabled in User Settings. Mailbox tools store and read durable messages only; they never start, resume, wake or stop a worker, never edit files and never change board records.';
/** Marks the opt-in boundary and the only accepted actor identity for one call. */
const trusted = 'The caller identity is the trusted ownerId of this MCP call; do not send actor, workerId or team-membership fields.';

export function isMailboxTool(name: string): name is MailboxToolName {
  return Object.hasOwn(schemas, name);
}

/** One MCP tool descriptor, shaped exactly like the legacy api.mcpTools entries. */
export const mailboxMcpTools = mailboxToolNames.map(name => {
  const json = z.toJSONSchema(schemas[name]);
  return {
    name,
    description: `${descriptions[name]} ${trusted}${note}`,
    inputSchema: { ...json, properties: { ...json.properties, workspaceRoot: routing } },
    annotations: { readOnlyHint: name === 'subagent_mailbox_list', destructiveHint: false, idempotentHint: true, openWorldHint: false }
  };
});
export type MailboxMcpTool = (typeof mailboxMcpTools)[number];

/**
 * Structural port the mailbox domain implements. Inputs stay unknown here
 * because the domain re-validates them strictly; returns may be synchronous or
 * promised, matching the core's sync list/pending reads and async writes.
 *
 * The optional guard is invoked by the domain inside its own mutation boundary,
 * immediately before the durable publication, so a call that waited behind
 * another write rechecks the live feature flag, the host state and cancellation
 * at application time instead of trusting the earlier precheck.
 */
export interface MailboxPort {
  send(actor: BoardActor, input: unknown, guard?: () => void): unknown | Promise<unknown>;
  list(actor: BoardActor, input: unknown): unknown | Promise<unknown>;
  acknowledge(actor: BoardActor, input: unknown, guard?: () => void): unknown | Promise<unknown>;
}

const record = (value: unknown): Record<string, unknown> => ({ ...(value as Record<string, unknown>) });

/** Parse a strict input; invalid input is invalid_arguments, exactly like the board tools. */
function strict(schema: z.ZodType, input: unknown): Record<string, unknown> {
  try {
    return record(schema.parse(input ?? {}));
  } catch (error) {
    throw error instanceof z.ZodError ? new WorkerError('invalid_arguments', z.prettifyError(error)) : error;
  }
}

/** One domain call with the already-trusted actor; ownerId never reaches the domain. */
function forward(port: MailboxPort, name: MailboxToolName, actor: BoardActor, args: Record<string, unknown>, guard?: () => void): Promise<unknown> {
  switch (name) {
    case 'subagent_mailbox_send': return Promise.resolve(port.send(actor, args, guard));
    case 'subagent_mailbox_list': return Promise.resolve(port.list(actor, args));
    case 'subagent_mailbox_ack': return Promise.resolve(port.acknowledge(actor, args, guard));
  }
  throw new WorkerError('unknown_tool', `Unknown mailbox tool: ${String(name)}`);
}

/**
 * Validate, extract the trusted coordinator identity and forward one MCP call.
 * The optional guard is the host's live commit guard, composed by the port.
 */
export async function invokeMailbox(port: MailboxPort, name: string, input: unknown, guard?: () => void): Promise<ToolResult> {
  try {
    if (!isMailboxTool(name)) {
      throw new WorkerError('unknown_tool', `Unknown mailbox tool: ${name}`);
    }
    const args = record(schemas[name].parse(input ?? {}));
    const actor: CoordinatorActor = { kind: 'coordinator', ownerId: String(args.ownerId) };
    delete args.ownerId;
    const result = await forward(port, name, actor, args, guard);
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
  } catch (error) {
    const problem = error instanceof z.ZodError ? { code: 'invalid_arguments', message: z.prettifyError(error), retryable: false } : failure(error);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: problem }) }] };
  }
}

/**
 * Worker-visible schemas: the shared send/list/ack inputs with every trusted
 * identity field removed and strictness restored. A payload that tries to name
 * an owner, actor or other worker is therefore invalid_arguments rather than an
 * impersonation; the domain still enforces live membership on every call.
 */
function withoutIdentity(schema: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> {
  const shape = { ...schema.shape };
  delete shape.ownerId;
  delete shape.actor;
  delete shape.workerId;
  return z.object(shape).strict();
}

const workerSchemas = {
  subagent_mailbox_send: withoutIdentity(sendMailboxInput),
  subagent_mailbox_list: withoutIdentity(listMailboxInput),
  subagent_mailbox_ack: withoutIdentity(acknowledgeMailboxInput)
};
type WorkerMailboxToolName = keyof typeof workerSchemas;
/** Governed, host-bound workers only: a strict reference to one message and its team. */
const waitInput = z.object({ teamId: id32, messageId: id32 }).strict();

const workerDescriptions: Record<WorkerMailboxToolName, string> = {
  subagent_mailbox_send: 'Send one durable message to a teammate of a team you belong to. Your identity is this worker session; the message is stored durably for that worker. A send has no direct scheduling effect: it never starts, resumes, wakes or delays any worker turn, and delivery happens only to a worker that is already running. Reuse the same requestId after an interrupted call.',
  subagent_mailbox_list: 'List durable messages of a team you belong to, including delivery and acknowledgement metadata, sorted by the mailbox sequence.',
  subagent_mailbox_ack: 'Acknowledge one durable message addressed to you in a team you belong to. This marks the message for you; it never edits or deletes it and never changes the board.'
};
const waitDescription = 'Wait for the reply to one question or interface proposal THIS worker sent, in this worker\'s own team and bound to the host that owns it. The call registers the wait and returns without blocking the scheduler or holding a runner, model or storage slot; only an authorized reply makes the worker eligible to continue, and it never starts, resumes or stops any worker.';

const workerTools: Tool[] = (Object.keys(workerSchemas) as WorkerMailboxToolName[]).map(name => ({ name, description: workerDescriptions[name], inputSchema: z.toJSONSchema(workerSchemas[name]) }));
const waitTool: Tool = { name: 'subagent_mailbox_wait', description: waitDescription, inputSchema: z.toJSONSchema(waitInput) };
const workerNames = new Set<string>([...Object.keys(workerSchemas), waitTool.name]);
const mailboxNames = new Set<string>(mailboxToolNames);

export interface MailboxWorkerOptions {
  /** Live gate: both taskBoard.enabled and taskBoard.messaging.enabled, read on every call. */
  enabled: () => boolean;
  /**
   * Worker-bound peer wait, supplied only by a host that owns this worker's
   * store. Absent means the governed wait tool is not advertised or callable.
   */
  wait?: (teamId: string, messageId: string, signal: AbortSignal) => Promise<unknown>;
  /**
   * Synchronous live team-membership check used for tool DEFINITIONS only: a
   * nonmember sees no mailbox tool. Absent means "no filter supplied by this
   * host"; a throwing check hides the tools. It never authorizes a call.
   */
  member?: () => boolean;
  /** Feature/UI refresh after a durable mailbox mutation. */
  onChange: () => void;
}

/**
 * Wrap workspace tools with worker-scoped mailbox tools. The session captured
 * here is the ONLY source of worker identity: the runtime resolves it through
 * forSession, and the execute session argument is never used to impersonate
 * another worker. base stays authoritative for files and board records, so file
 * permissions, the board adapters and the authorize callback are untouched.
 *
 * subagent_mailbox_wait is advertised only for a governed, host-bound worker
 * (a started startup record bound to this host plus a supplied wait hook), so a
 * legacy worker never sees a wait it cannot honor.
 */
export function workerMailboxTools(mailbox: MailboxPort, session: Pick<Session, 'id' | 'mode' | 'isolatedView'> & { startup?: Session['startup'] }, options: MailboxWorkerOptions, base: WorkspaceTools): WorkspaceTools {
  const workerId = session.id;
  const actor: WorkerActor = { kind: 'worker', workerId };
  /**
   * The ONE team a governed worker is bound to: the same authority
   * runtime.peerDelivery uses for automatic delivery and the host lifecycle uses
   * for a peer wait. A legacy/unbound member keeps access to its live teams; a
   * bound worker may only use the mailbox tools for its bound team, even when
   * the board still lists it as a member of another team. This is enforced
   * BEFORE forwarding and again in the domain's commit guard, so it never
   * depends on the model's arguments or on a later membership read.
   */
  const boundTeam = session.startup?.teamId ?? session.isolatedView?.teamId;
  const assertTeamScope = (teamId: unknown): void => {
    if (boundTeam && teamId !== boundTeam) {
      throw new WorkerError('forbidden', 'This worker is bound to one team, so a mailbox call may only reference that team.');
    }
  };
  // Same rule the host lifecycle applies to waitForPeer: a started governed
  // worker bound to this host's mailbox, with a wait hook.
  const bound = !!options.wait && session.startup?.phase === 'started' && session.mode === 'governed' && !!session.isolatedView;
  // Definitions only, and deliberately synchronous: a live nonmember never sees a
  // mailbox tool. Authorization of a real call stays the domain's own live check.
  const member = (): boolean => {
    try {
      return options.member?.() ?? true;
    } catch {
      return false;
    }
  };
  const definitions = (permission: Session['permission']): Tool[] => {
    const files = base.definitions(permission);
    return options.enabled() && member() ? [...files, ...(bound ? [...workerTools, waitTool] : workerTools)] : files;
  };
  const execute = async (name: string, input: Record<string, unknown>, permission: Session['permission'], signal: AbortSignal, current?: Session, authorize?: () => void): Promise<string> => {
    if (!workerNames.has(name)) {
      if (mailboxNames.has(name)) {
        throw new WorkerError('permission_denied', `${name} is coordinator-only; workers use the member-scoped mailbox tools.`);
      }
      return base.execute(name, input, permission, signal, current, authorize);
    }
    // Rechecked before parsing and forwarded to the domain as its commit guard,
    // so a queue wait cannot hide a revocation; no storage or runnable slot is
    // acquired here, because this call already runs inside the engine's effect.
    const check = (): void => {
      signal.throwIfAborted();
      authorize?.();
      if (!options.enabled()) {
        throw new WorkerError('feature_disabled', 'Team mail is disabled, so mailbox tools are unavailable.');
      }
    };
    check();
    if (name === waitTool.name) {
      if (!bound || !options.wait) {
        throw new WorkerError('permission_denied', 'subagent_mailbox_wait is available only to governed, host-bound workers.');
      }
      const args = strict(waitInput, input);
      assertTeamScope(args.teamId);
      return JSON.stringify(await options.wait(String(args.teamId), String(args.messageId), signal) ?? null);
    }
    if (!Object.hasOwn(workerSchemas, name)) {
      throw new WorkerError('permission_denied', `${name} is not a worker mailbox tool.`);
    }
    const tool = name as WorkerMailboxToolName;
    const args = strict(workerSchemas[tool], input);
    // Refused BEFORE forwarding and again inside the domain's commit guard: a
    // worker bound to one team can never send, list or acknowledge another.
    assertTeamScope(args.teamId);
    const result = await forward(mailbox, tool, actor, args, () => {
      check();
      assertTeamScope(args.teamId);
    });
    if (tool !== 'subagent_mailbox_list') {
      options.onChange();
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
    // scoped session; callers must not rebind identity by passing execute's
    // session argument.
    forSession: (scoped: Session) => workerMailboxTools(mailbox, scoped, options, base.forSession?.(scoped) ?? base)
  };
}
