import { z } from 'zod';
import type { ToolResult } from './api';

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
  subagent_view_cleanup: z.strictObject({ ...scope, requestId })
};

export type IsolatedViewToolName = keyof typeof isolatedViewSchemas;
export const isIsolatedViewTool = (name: string): name is IsolatedViewToolName => Object.hasOwn(isolatedViewSchemas, name);
export const isSlowViewTool = (name: string): boolean => ['subagent_snapshot_create', 'subagent_view_cleanup', 'subagent_submission_read'].includes(name);
export const isOfflineViewTool = (name: string): boolean => isIsolatedViewTool(name) && !['subagent_snapshot_create', 'subagent_view_bind', 'subagent_view_seal'].includes(name);

const descriptions: Record<IsolatedViewToolName, string> = {
  subagent_snapshot_create: 'Capture one immutable shared project snapshot, including eligible unsaved content in the owning VS Code window. Git tracks all eligible index paths plus the chosen untracked set; omitted selection uses nonignored untracked files. Reuse requestId on retry.',
  subagent_view_bind: 'Bind an already stopped, owned team worker to a shared snapshot before resuming it. This permanent binding routes subsequent file tools through its private overlay; earlier legacy turns remain legacy. Does not start inference.',
  subagent_view_status: 'Page scoped shared snapshots, private overlays, immutable submissions, retention pins or pending captures. A submission is an artifact, not acceptance, validation or integration.',
  subagent_view_seal: 'Seal the exact expected private revision into an immutable submission. Later edits leave it unchanged. Reuse requestId for the original acknowledgment.',
  subagent_submission_read: 'Read, list or search an exact sealed submission through its immutable layered view. input uses the corresponding worker file-tool arguments. No live workspace files are consulted.',
  subagent_view_pin: 'Retain an exact snapshot or submission for a named consumer before using it. Task-board references and validation metadata do not retain content automatically.',
  subagent_view_release: 'Release a snapshot creation pin, overlay, submission, named pin, or pending capture. Other references remain valid. A released worker binding cannot fall back to legacy file tools.',
  subagent_view_cleanup: 'Reconcile worker bindings and collect unreferenced scoped snapshots and private content. Unknown Sessions, foreign references and unknown storage files are preserved and reported. Never runs Git gc.'
};
const note = ' Opt-in: requires User Settings codexSubagent.taskBoard.enabled and codexSubagent.isolatedViews.enabled. Isolated shell execution is unavailable until physical runners exist.';
export const isolatedViewMcpTools = (Object.keys(isolatedViewSchemas) as IsolatedViewToolName[]).map(name => {
  const schema = z.toJSONSchema(isolatedViewSchemas[name]);
  return { name, description: descriptions[name] + note,
    inputSchema: { ...schema, properties: { ...schema.properties, workspaceRoot: { type: 'string', description: 'Original canonical workspace root; retain this root on subsequent calls.' } } },
    annotations: { readOnlyHint: name === 'subagent_view_status' || name === 'subagent_submission_read', destructiveHint: name === 'subagent_view_cleanup' || name === 'subagent_view_release', idempotentHint: true, openWorldHint: false } };
});

export const viewResponse = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
