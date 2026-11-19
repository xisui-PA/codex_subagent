import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{32}$/);
export const setupSchema = z.strictObject({
  teamId: id, taskId: id, snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  teamRevision: z.number().int().nonnegative(), taskRevision: z.number().int().nonnegative(),
  lane: z.enum(['work', 'validation', 'integration']).default('work')
});
export const startupSchema = setupSchema.extend({
  phase: z.enum(['created', 'assigned', 'bound', 'ready', 'started', 'cancelled']),
  requestId: z.string().min(1).max(200)
}).strict();
export type WorkerStartup = z.infer<typeof startupSchema>;
/** Future message delivery supplies an explicit wake; no peer transport here. */
export const scheduleWaitSchema = z.strictObject({ kind: z.literal('message'), key: z.string().min(1).max(200) });
export type ScheduleWait = z.infer<typeof scheduleWaitSchema>;
/** Opaque schedule-wait generation; a worker with no recorded generation is at 0. */
export function waitRevision(waiting: { scheduleWaitRevision?: number }): number {
  return waiting.scheduleWaitRevision ?? 0;
}
/** Literal equality of opaque waits; keys are compared, never parsed or interpreted. */
export function sameWait(a: ScheduleWait | undefined, b: ScheduleWait | null | undefined): boolean {
  return (a?.kind ?? null) === (b?.kind ?? null) && (a?.key ?? null) === (b?.key ?? null);
}
/**
 * Pure compare-and-set decision for one observed wait generation. `apply` mutates
 * and advances the generation; `replay` proves the request was already applied
 * (or is a no-op at the observed generation) and must write nothing; `conflict`
 * refuses a superseded generation or a different wait at that generation.
 */
export function waitDecision(waiting: { scheduleWait?: ScheduleWait; scheduleWaitRevision?: number }, expected: number,
  next: ScheduleWait | undefined): 'apply' | 'replay' | 'conflict' {
  const current = waitRevision(waiting);
  if (sameWait(waiting.scheduleWait, next) && (expected === current || expected === current - 1)) {
    return 'replay';
  }
  return expected === current ? 'apply' : 'conflict';
}
export const waitingReasons = ['dependency', 'model_capacity', 'runnable_capacity', 'runner_capacity', 'approval', 'storage', 'quarantine', 'message'] as const;
export const governedSchemas = {
  subagent_isolated_spawn: z.strictObject({
    requestId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200),
    ownerLabel: z.string().max(200).optional(), task: z.string().min(1).max(200_000),
    model: z.string().min(1).max(500).optional(), title: z.string().max(200).optional(),
    instructions: z.string().max(30_000).optional(), permission: z.enum(['read-only', 'workspace-write']).default('read-only'),
    parentPolicy: z.enum(['keep', 'cancel-on-expiry']).default('keep'), leaseSeconds: z.number().int().min(30).max(3600).default(120),
    setup: setupSchema
  }),
  subagent_resource_status: z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }),
  subagent_metadata_rollover: z.strictObject({ ownerId: z.string().min(1).max(200), teamId: id, kind: z.enum(['board', 'views']), expectedEpoch: z.number().int().nonnegative() }),
  subagent_resource_collect: z.strictObject({ ownerId: z.string().min(1).max(200), teamId: id, resultIds: z.array(id).max(20).default([]), archives: z.boolean().default(false) }),
  subagent_evidence_retention: z.strictObject({ ownerId: z.string().min(1).max(200), teamId: id, action: z.enum(['pin', 'release']), name: z.string().min(1).max(128), uri: z.string().min(1).max(2048) }),
  subagent_schedule: z.strictObject({
    id, ownerId: z.string().min(1).max(200), wait: scheduleWaitSchema.nullable(),
    expectedWaitRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
};
export type GovernedTool = keyof typeof governedSchemas;
export function isGovernedTool(name: string): name is GovernedTool {
  return Object.hasOwn(governedSchemas, name);
}
const descriptions: Record<GovernedTool, string> = {
  subagent_isolated_spawn: 'Opt-in create-bind-start. Persists a non-runnable worker, establishes team membership and task assignment, then binds a private snapshot before the first inference or tool. Retry the SAME request and arguments after interrupted setup. Requires resources.enabled, taskBoard.enabled and isolatedViews.enabled in User Settings. lane explicitly reserves validation/integration capacity; this does not validate, accept or integrate anything.',
  subagent_resource_status: 'Inspect the OS-user aggregate resource ledger across roots, stores and extension hosts. Reports reservations and quarantine. No effects are replayed.',
  subagent_metadata_rollover: 'Explicitly expire one owner request epoch, compress its receipts and preserve immutable identities. Quiesce setup first. Old request IDs fail request_expired; new IDs use the returned eN: prefix. expectedEpoch makes retries safe.',
  subagent_resource_collect: 'Collect explicitly named unreferenced final command results, scoped released lease history and optionally expired receipt archives. Active work, pins, board references and uncertainty are retained. Cleanup never runs a command.',
  subagent_evidence_retention: 'Pin or release an exact immutable evidence URI for a named consumer, integration operation or retained validation report. Pin before consumption or publishing a reference. Names cannot be rebound without releasing the exact prior URI.',
  subagent_schedule: 'Set or clear an explicit coordinator message wait at the next execution boundary of a governed worker. No peer messaging, planning, automatic delivery or effect interruption. Null wakes the worker. Pass expectedWaitRevision, the scheduleWaitRevision this worker returned: the set or wake applies only at that generation, an identical request that was already applied is a no-op, and a superseded generation or a different wait at it fails revision_conflict with nothing changed. Read the worker again before retrying a conflict.'
};
export const governedMcpTools = Object.entries(governedSchemas).map(([name, schema]) => {
  const json = z.toJSONSchema(schema);
  return { name, description: descriptions[name as GovernedTool],
    inputSchema: { ...json, properties: { ...json.properties, workspaceRoot: { type: 'string' } } },
    annotations: { readOnlyHint: name === 'subagent_resource_status', destructiveHint: name === 'subagent_resource_collect' || name === 'subagent_metadata_rollover', idempotentHint: true, openWorldHint: name === 'subagent_isolated_spawn' } };
});
