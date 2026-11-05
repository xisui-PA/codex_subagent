import { z } from 'zod';
import { WorkerEngine } from './engine';
import { failure, Session, WorkerError } from './types';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const requestId = z.string().min(1).max(200).describe('Unique idempotency key. Reuse exactly the same key and arguments after a connection failure; use a new key for a new operation.');
const ownerId = z.string().min(1).max(200).optional().describe('Stable parent-conversation identifier; use a unique value for each Codex conversation and pass it on subsequent controls.');
const schemas = {
  subagent_models: z.object({}).strict(),
  subagent_spawn: z.object({ requestId, ownerId, ownerLabel: z.string().max(200).optional(), parentPolicy: z.enum(['keep', 'cancel-on-expiry']).default('keep'), leaseSeconds: z.number().int().min(30).max(3600).default(120), task: z.string().min(1).max(200_000), model: z.string().min(1).max(500).optional(), title: z.string().max(200).optional(), instructions: z.string().max(30_000).optional(), permission: z.enum(['read-only', 'workspace-write']).default('read-only') }).strict(),
  subagent_send: z.object({ id, ownerId, requestId, message: z.string().min(1).max(200_000) }).strict(),
  subagent_status: z.object({ id, turnId: z.string().optional(), attempt: z.number().int().min(1).optional(), afterMessage: z.number().int().min(0).default(0), messageLimit: z.number().int().min(0).max(20).default(0), outputOffset: z.number().int().min(0).default(0), outputLimit: z.number().int().min(1).max(50_000).default(12_000) }).strict(),
  subagent_wait: z.object({ ids: z.array(id).min(1).max(20), timeoutMs: z.number().int().min(0).max(25_000).default(20_000) }).strict(),
  subagent_list: z.object({ ownerId, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  subagent_cancel: z.object({ id, ownerId }).strict(),
  subagent_resume: z.object({ id, ownerId, requestId, model: z.string().min(1).max(500).optional(), message: z.string().min(1).max(200_000).optional() }).strict(),
  subagent_compact: z.object({ id, ownerId, revision: z.number().int().min(0), summary: z.string().min(1).max(100_000).optional() }).strict(),
  subagent_delete: z.object({ id, ownerId }).strict(),
  subagent_discard_queued: z.object({ id, ownerId }).strict(),
  subagent_parent: z.object({ ownerId: z.string().min(1).max(200), action: z.enum(['heartbeat', 'stop']), leaseSeconds: z.number().int().min(30).max(3600).default(120) }).strict(),
  subagent_health: z.object({}).strict()
};
const descriptions: Record<keyof typeof schemas, string> = {
  subagent_models: 'List models exposed by VS Code and enabled for this extension. Use exact IDs. Empty list: run Codex Subagent: Enable Model in VS Code. Credentials stay in VS Code.',
  subagent_spawn: 'Delegate an independent task to a persistent BYOK worker. Returns immediately with worker ID; use wait/status for results. Explicitly supply all relevant context and workspace paths; parent context/tools/sandbox are not inherited. Default read-only. Reuse requestId after transport errors.',
  subagent_send: 'Queue a follow-up on the same persistent worker conversation. Messages sent during a turn execute after it. Cancel then resume to stop a running turn; this tool does not interrupt it.',
  subagent_status: 'Inspect worker state, all turn summaries, partial output and optionally paginated full history. Use afterMessage/messageLimit to read history before compaction. Output pagination applies to the latest turn.',
  subagent_wait: 'Wait up to 25 seconds until any requested worker stops. Timeout does not cancel workers. Repeat wait if all remain queued/running; inspect status for incremental output.',
  subagent_list: 'List persistent workers in this workspace folder, including those recovered after VS Code reload. Use workspaceRoot to select another open folder or registered worktree.',
  subagent_cancel: 'Cancel current generation and suspend queued turns. Already executed tool side effects remain. Worker history is preserved; resume explicitly to continue.',
  subagent_resume: 'Continue failed/cancelled/interrupted work from its durable conversation. Seals missing tool results as uncertain instead of replaying effects. Use a new requestId; optionally explicitly select another enabled model. Reuse this key on transport retry.',
  subagent_compact: 'Compact a stopped conversation, preserving full immutable archives. Omit summary to start cancellable background summarization; wait for it to stop before resuming. Or provide a faithful manual summary for immediate compaction. Pass current revision.',
  subagent_delete: 'Permanently delete a stopped worker transcript. Cancel and wait for any running work to settle first. Never delete a worker whose results are still needed.',
  subagent_discard_queued: 'Discard messages that have not started, preserving their records. Does not interrupt the running turn. Useful before resuming with a new direction.',
  subagent_parent: 'Heartbeat an ownerId lease or explicitly stop all of that parent’s running/queued workers. For cancel-on-expiry workers send periodic heartbeats. Native Codex stop events are unavailable to this MCP server.',
  subagent_health: 'Check worker host health, model availability and actual workspace capabilities before delegation.'
};
export const mcpTools = Object.entries(schemas).map(([name, schema]) => {
  const json = z.toJSONSchema(schema);
  return {
    name, description: descriptions[name as keyof typeof schemas],
    inputSchema: { ...json, properties: { ...json.properties, workspaceRoot: { type: 'string', description: 'Optional absolute open-workspace or registered Git worktree root. Pass the returned worker workspaceRoot on subsequent controls; omit for the MCP working directory.' } } },
    annotations: { readOnlyHint: ['subagent_models', 'subagent_status', 'subagent_wait', 'subagent_list', 'subagent_health'].includes(name), destructiveHint: name === 'subagent_delete', idempotentHint: name !== 'subagent_compact', openWorldHint: ['subagent_spawn', 'subagent_resume', 'subagent_send', 'subagent_compact'].includes(name) }
  };
});
export const mcpInstructions = 'Use subagent_health and subagent_models before delegation. To target a registered Git worktree explicitly supply workspaceRoot; retain the returned root on subsequent controls and group wait IDs by that root. Choose a unique ownerId for this parent conversation and retain it with worker IDs/requestIds; pass it on every mutating control. Spawn is asynchronous. Poll subagent_wait in <=25s increments and inspect status. For work that should stop when unattended use parentPolicy cancel-on-expiry and renew with subagent_parent heartbeat; explicitly call subagent_parent stop when cancelling a parent task. MCP disconnects alone do not prove a parent stopped. Native stop events are unavailable. Retry ambiguous mutations with the SAME requestId and arguments. Reloaded work is interrupted and resumes explicitly. Context/history rollover is automatic and archival messages remain available through status pagination. Workers have explicit context and private workspace tools; parent tools, approvals and sandbox are not inherited. Check completed results before reporting success.';

export function view(session: Session, offset = 0, limit = 12_000, turnId?: string, attempt?: number): Record<string, unknown> {
  const turn = turnId ? session.turns.find(t => t.id === turnId) : session.turns.find(t => t.state === 'running') || [...session.turns].reverse().find(t => t.started) || session.turns.at(-1);
  if (turnId && !turn) {
    throw new WorkerError('not_found', 'Turn not found.');
  }
  const previous = attempt && attempt !== turn?.attempts ? turn?.attemptsLog?.find(a => a.attempt === attempt) : undefined;
  if (attempt && !previous && attempt !== turn?.attempts) {
    throw new WorkerError('not_found', 'Attempt not found.');
  }
  const output = previous?.output ?? turn?.output ?? '';
  return {
    id: session.id, title: session.title, state: session.state, model: session.model.id, permission: session.permission, ownerId: session.ownerId, ownerLabel: session.ownerLabel, workspaceRoot: session.workspaceRoot, activity: session.activity,
    revision: session.revision, createdAt: session.createdAt, updatedAt: session.updatedAt, maintenanceError: session.maintenanceError,
    turns: session.turns.map(t => ({ id: t.id, state: t.state, attempts: t.attempts, error: t.error, outputCharacters: t.output.length, previousAttempts: t.attemptsLog?.map(a => ({ attempt: a.attempt, error: a.error, outputCharacters: a.output.length })), toolCount: t.tools.length, tools: t.tools.slice(-20).map(tool => ({ id: tool.call.id, name: tool.call.name, state: tool.state })) })),
    outputTurnId: turn?.id, outputAttempt: attempt || turn?.attempts,
    output: output.slice(offset, offset + limit), outputOffset: offset, nextOutputOffset: offset + limit < output.length ? offset + limit : null,
    messageCount: (session.messageBase || 0) + session.messages.length, compactedThrough: (session.messageBase || 0) + (session.summary?.through || 0), archives: session.archives || [], changes: session.changes || []
  };
}
export interface ToolResult { [key: string]: unknown; content: { type: 'text'; text: string }[]; isError?: boolean }
export async function invoke(engine: WorkerEngine, name: string, input: unknown, signal?: AbortSignal, workspaceRoot?: string): Promise<ToolResult> {
  try {
    let result: unknown;
    switch (name) {
      case 'subagent_models': schemas.subagent_models.parse(input); result = { models: await engine.models() }; break;
      case 'subagent_spawn': result = view(await engine.spawn({ ...schemas.subagent_spawn.parse(input), workspaceRoot })); break;
      case 'subagent_send': { const a = schemas.subagent_send.parse(input); engine.assertOwner(a.id, a.ownerId); result = view(await engine.send(a.id, a.requestId, a.message)); break; }
      case 'subagent_resume': { const a = schemas.subagent_resume.parse(input); engine.assertOwner(a.id, a.ownerId); result = view(await engine.resume(a.id, a.requestId, a.model, a.message)); break; }
      case 'subagent_cancel': { const a = schemas.subagent_cancel.parse(input); engine.assertOwner(a.id, a.ownerId); result = view(await engine.cancel(a.id)); break; }
      case 'subagent_status': {
        const a = schemas.subagent_status.parse(input);
        const s = engine.session(a.id);
        const outputTurn = a.turnId || s.turns.find(t => t.state === 'running')?.id || [...s.turns].reverse().find(t => t.started)?.id;
        const current = s.turns.find(t => t.id === outputTurn);
        // The live view can include a failure that could not be checkpointed.
        // Fetch only missing/archived output; never replace that view with an
        // older persisted copy of the same current turn.
        if (outputTurn && (!current || current.archived || (a.attempt && a.attempt !== current.attempts && !current.attemptsLog?.some(log => log.attempt === a.attempt)))) {
          const old = await engine.store.turn(a.id, outputTurn, a.attempt);
          if (old) {
            const at = s.turns.findIndex(t => t.id === outputTurn); if (at < 0) {
              s.turns.push(old);
            } else {
              s.turns[at] = old;
            }
          }
        }
        result = { ...view(s, a.outputOffset, a.outputLimit, a.turnId, a.attempt), ...(a.messageLimit ? { ...await engine.store.history(a.id, a.afterMessage, a.messageLimit), summary: s.summary } : {}) };
        break;
      }
      case 'subagent_wait': {
        const a = schemas.subagent_wait.parse(input);
        const sessions = await engine.wait(a.ids, a.timeoutMs, signal);
        result = { workers: sessions.map(s => view(s)), timedOut: sessions.every(s => s.state === 'queued' || s.state === 'running') };
        break;
      }
      case 'subagent_list': { const a = schemas.subagent_list.parse(input); const all = engine.list().filter(s => !a.ownerId || s.ownerId === a.ownerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); result = { workers: all.slice(a.offset, a.offset + a.limit), nextOffset: a.offset + a.limit < all.length ? a.offset + a.limit : null }; break; }
      case 'subagent_compact': { const a = schemas.subagent_compact.parse(input); engine.assertOwner(a.id, a.ownerId); result = view(await engine.compact(a.id, a.revision, a.summary)); break; }
      case 'subagent_delete': { const a = schemas.subagent_delete.parse(input); engine.assertOwner(a.id, a.ownerId); await engine.remove(a.id); result = { deleted: a.id }; break; }
      case 'subagent_discard_queued': { const a = schemas.subagent_discard_queued.parse(input); engine.assertOwner(a.id, a.ownerId); result = view(await engine.discardQueued(a.id)); break; }
      case 'subagent_parent': { const a = schemas.subagent_parent.parse(input); if (a.action === 'stop') {
        await engine.stopParent(a.ownerId);
      } else {
        await engine.heartbeat(a.ownerId, a.leaseSeconds);
      } result = { ownerId: a.ownerId, action: a.action }; break; }
      case 'subagent_health': schemas.subagent_health.parse(input); result = { ready: true, models: await engine.models() }; break;
      default: throw new WorkerError('unknown_tool', `Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    const problem = error instanceof z.ZodError ? { code: 'invalid_arguments', message: z.prettifyError(error), retryable: false } : failure(error);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: problem }) }] };
  }
}
