import { z } from 'zod';
import type { ToolResult } from './api';
import { integrationActionSchema } from './integration-attempts';

const id = z.string().regex(/^[a-f0-9]{64}$/);
const workerId = z.string().regex(/^[a-f0-9]{32}$/);
const scope = { ownerId: z.string().min(1).max(200), teamId: workerId };
const requestId = z.string().min(1).max(200);
const paging = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(20) };

export const isolatedViewSchemas = {
  subagent_snapshot_create: z.strictObject({ ...scope, requestId, selectedUntracked: z.array(z.string().min(1).max(4096)).max(10_000).optional() }),
  subagent_view_bind: z.strictObject({ ...scope, requestId, id: workerId, snapshotId: id }),
  subagent_view_status: z.strictObject({ ...scope, kind: z.enum(['snapshots', 'overlays', 'submissions', 'pins', 'pendingCaptures']).default('overlays'), ...paging }),
  subagent_view_seal: z.strictObject({ ...scope, requestId, id: workerId, expectedRevision: z.number().int().min(0).max(1024) }),
  subagent_submission_read: z.strictObject({ ...scope, submissionId: id, operation: z.enum(['read_file', 'list_files', 'search_files']), input: z.record(z.string(), z.unknown()) }),
  subagent_view_pin: z.strictObject({ ...scope, requestId, name: z.string().min(1).max(128), resource: z.strictObject({ kind: z.enum(['snapshot', 'submission']), id }) }),
  subagent_view_release: z.strictObject({ ...scope, requestId, kind: z.enum(['snapshot', 'overlay', 'submission', 'pin', 'pending']), id }),
  subagent_view_cleanup: z.strictObject({ ...scope, requestId }),
  // Runner observation and reconciliation are scoped reads plus an explicitly
  // destructive, naturally idempotent reconcile: no requestId, and no command is
  // ever executed, replayed or validated by them.
  subagent_runner_status: z.strictObject({ ...scope, kind: z.enum(['leases', 'queue', 'results']).default('leases'), ...paging }),
  subagent_runner_result: z.strictObject({ ...scope, id: workerId }),
  subagent_runner_cleanup: z.strictObject({ ...scope }),
  // Coordinator-only integration: ONE strict discriminated action union. Every
  // stage is an explicit decision, so the schema is never relaxed by this list.
  subagent_integration: integrationActionSchema
};

export type IsolatedViewToolName = keyof typeof isolatedViewSchemas;
export const isIsolatedViewTool = (name: string): name is IsolatedViewToolName => Object.hasOwn(isolatedViewSchemas, name);
/** The one integration action router (never an offline/saved fallback). */
export const isIntegrationTool = (name: string): name is 'subagent_integration' => name === 'subagent_integration';
/**
 * Resource reservation hint for one integration action. It is a BUDGET decision,
 * never a validation: `begin` composes a derived snapshot under ONE 512 MiB bound
 * for DISTINCT payload bytes (synthesized merge results plus the native Git blobs
 * the final seed still references), on top of one immutable attempt record, while
 * status, acceptance metadata and the explicit release only write bounded
 * metadata. The 600 MiB reservation therefore leaves metadata room for the 32 MiB
 * seed manifest and the durable records instead of being consumed by payload.
 * Status, the read-only details page and release never queue behind a permit, so
 * an exhausted budget can always be inspected, paged and released.
 */
export function integrationReservation(input: unknown): { bytes: number; reclaim: boolean } {
  const action = input !== null && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  return {
    bytes: action === 'begin' ? 600 * 1024 ** 2 : 32 * 1024 ** 2,
    reclaim: action === 'status' || action === 'release' || action === 'details'
  };
}
export const isSlowViewTool = (name: string): boolean =>
  ['subagent_snapshot_create', 'subagent_view_cleanup', 'subagent_submission_read', 'subagent_runner_cleanup', 'subagent_integration'].includes(name);
export const isOfflineViewTool = (name: string): boolean => isIsolatedViewTool(name)
  && !['subagent_snapshot_create', 'subagent_view_bind', 'subagent_view_seal', 'subagent_integration'].includes(name);
/** Runner metadata and reconciliation never need the private file index. */
export const isRunnerViewTool = (name: string): boolean =>
  ['subagent_runner_status', 'subagent_runner_result', 'subagent_runner_cleanup'].includes(name);

const descriptions: Record<IsolatedViewToolName, string> = {
  subagent_snapshot_create: 'Capture one immutable shared project snapshot, including eligible unsaved content in the owning VS Code window. Git tracks all eligible index paths plus the chosen untracked set; omitted selection uses nonignored untracked files. Reuse requestId on retry.',
  subagent_view_bind: 'Bind an already stopped, owned team worker to a shared snapshot before resuming it. This permanent binding routes subsequent file tools through its private overlay; earlier legacy turns remain legacy. Does not start inference.',
  subagent_view_status: 'Page scoped shared snapshots, private overlays, immutable submissions, retention pins or pending captures. A submission is an artifact, not acceptance, validation or integration.',
  subagent_view_seal: 'Seal the exact expected private revision into an immutable submission. Later edits leave it unchanged. Reuse requestId for the original acknowledgment.',
  subagent_submission_read: 'Read, list or search an exact sealed submission through its immutable layered view. input uses the corresponding worker file-tool arguments. No live workspace files are consulted.',
  subagent_view_pin: 'Retain an exact snapshot or submission for a named consumer before using it. Task-board references and validation metadata do not retain content automatically.',
  subagent_view_release: 'Release a snapshot creation pin, overlay, submission, named pin, or pending capture. Other references remain valid. A released worker binding cannot fall back to legacy file tools.',
  subagent_view_cleanup: 'Reconcile worker bindings and collect unreferenced scoped snapshots and private content. Unknown Sessions, foreign references and unknown storage files are preserved and reported. Never runs Git gc.',
  subagent_runner_status: 'Page the bounded physical-runner state of this owner and team: leases, queue positions, or immutable result summaries. Global counts are included; other owners, raw leases and full command output are never returned. Observation never starts, kills or replays a command.',
  subagent_runner_result: 'Read one immutable runner command result for this owner and team. currentRevision/inputIsCurrent are derived live from the private view when it is available; the stored result itself is never rewritten. A command that ran against an earlier revision is not validation of the current one.',
  subagent_runner_cleanup: 'Reconcile this owner and team only: discard leases whose processes are provably gone, collect released runner directories, and retain anything unknown or unproven. Naturally idempotent and never executes, replays or approves a command.',
  subagent_integration: 'Compose exact sealed submissions in a private view through explicit coordinator actions. Begin retains sources and records requirements, candidate selects a sealed service-lane revision, validate records exact runner evidence, and accept records the coordinator decision by acknowledging the exact conflict paths it approves, either as their full list or as the compact conflictPathsDigest status reports. Apply uses a durable workspace journal. Use status to inspect the decision or retry an in-flight apply with identical arguments. A view too large for one reply is replaced by an explicit truncated summary with the exact attemptId, status, revision, conflictPathsDigest, contentDigest, exact counts and the omitted field names; its summary.details object is a ready-to-send details call for the complete status view, whose exact text pages you concatenate from offset 0 following nextOffset until null. Every continuation page (offset > 0) REQUIRES that exact expectedContentDigest, and limit is at most 65536. A revision change fails with revision_conflict and a content change at the same revision fails with content_changed; discard the pages and restart at offset 0 in either case. Status, details and release never wait for a storage permit. Release drops the attempt pins.'
};
const note = ' Opt-in: requires User Settings codexSubagent.taskBoard.enabled and codexSubagent.isolatedViews.enabled. Isolated shell execution additionally requires codexSubagent.isolatedViews.runners.enabled and explicit per-command approval.';
/**
 * Integration has its OWN note, so the legacy shared note stays byte-identical
 * and no existing tool description changes. It names every live prerequisite,
 * including the resources opt-in.
 */
const integrationNote = ' Opt-in: requires User Settings codexSubagent.taskBoard.enabled, codexSubagent.isolatedViews.enabled, codexSubagent.resources.enabled and codexSubagent.isolatedViews.integration.enabled. Apply additionally requires live workspace write access and an owning-window document enumeration.';
/** The workspaceRoot scope field, injected into every branch of a tool schema. */
const workspaceRootProperty = { type: 'string', description: 'Original canonical workspace root; retain this root on subsequent calls.' };
function withWorkspaceRoot(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.properties !== null && typeof schema.properties === 'object') {
    return { ...schema, properties: { ...(schema.properties as Record<string, unknown>), workspaceRoot: workspaceRootProperty } };
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      // A strict discriminated union: each alternative carries the scope field,
      // because a top-level property beside `oneOf` would not be advertised. The
      // ROOT stays an object with that discriminator, which is what the MCP
      // ToolSchema requires of every advertised inputSchema.
      const root: Record<string, unknown> = {
        ...schema,
        type: 'object',
        [key]: branches.map(branch => (branch !== null && typeof branch === 'object'
          ? withWorkspaceRoot(branch as Record<string, unknown>)
          : branch))
      };
      return root;
    }
  }
  return schema;
}
export const isolatedViewMcpTools = (Object.keys(isolatedViewSchemas) as IsolatedViewToolName[]).map(name => {
  const schema = z.toJSONSchema(isolatedViewSchemas[name]) as Record<string, unknown>;
  return { name, description: descriptions[name] + (name === 'subagent_integration' ? integrationNote : note),
    inputSchema: withWorkspaceRoot(schema),
    annotations: {
      readOnlyHint: ['subagent_view_status', 'subagent_submission_read', 'subagent_runner_status', 'subagent_runner_result'].includes(name),
      destructiveHint: ['subagent_view_cleanup', 'subagent_view_release', 'subagent_runner_cleanup', 'subagent_integration'].includes(name),
      idempotentHint: true,
      openWorldHint: false
    } };
});

export const viewResponse = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
