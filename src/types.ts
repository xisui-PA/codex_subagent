import type { WorkerStartup, ScheduleWait } from './worker-startup';
import type { WaitingReason } from './resource-governor';
import type { IsolatedViewBinding } from './isolated-view-types';

export type Part =
  | { type: 'text'; text: string }
  | { type: 'call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'result'; id: string; text: string };

/**
 * Host-only reference to one peer mailbox notice checkpointed WITH a user
 * message. It is durable deduplication metadata (never inferred from message
 * text) and is stripped before any provider request, so a replayed prompt still
 * carries exactly the untrusted block the worker was shown.
 */
export interface PeerNoticeRef { id: string; teamId: string }
export interface Message { role: 'user' | 'assistant'; parts: Part[]; peerNotices?: PeerNoticeRef[] }
export interface Model {
  id: string; name: string; vendor: string; family: string; version: string; maxInputTokens: number;
}
export interface Tool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface Provider {
  models(): Promise<Model[]>;
  stream(model: Model, messages: Message[], tools: Tool[], signal: AbortSignal): AsyncIterable<Part>;
  countTokens(model: Model, message: Message): Promise<number>;
}
export type State = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Failure { code: string; message: string; retryable: boolean }
export interface ToolExecution {
  call: Extract<Part, { type: 'call' }>; state: 'started' | 'completed' | 'uncertain'; result?: string;
}
export interface Turn {
  id: string; input: string; state: State; started: boolean; attempts: number;
  output: string; error?: Failure; tools: ToolExecution[]; createdAt: string; updatedAt: string;
  attemptsLog?: { attempt: number; output: string; error?: Failure; endedAt: string }[];
  archived?: boolean;
}
/**
 * The ONE current Session format is schema 3 with an explicit, required mode
 * and no default. "standalone" is an ordinary spawn, "isolated" is a
 * permanently bound private worker, and "governed" additionally carries its
 * create-bind-start setup. There is no old-version reader: a record with
 * schema 1, schema 2, a missing mode or an unknown mode is malformed and is
 * never inferred, upgraded or silently mapped onto a mode.
 */
export type SessionMode = 'standalone' | 'isolated' | 'governed';
export interface Session {
  schema: 3; mode: SessionMode; id: string; title: string; model: Model; instructions: string;
  permission: 'read-only' | 'workspace-write'; state: State; messages: Message[]; turns: Turn[];
  operations: Record<string, { fingerprint: string; turnId: string }>;
  summary?: { text: string; through: number }; revision: number; createdAt: string; updatedAt: string;
  ownerId?: string; ownerLabel?: string; parentPolicy?: 'keep' | 'cancel-on-expiry'; parentExpiresAt?: number; parentLeaseSeconds?: number;
  workspaceRoot?: string; activity?: string;
  maintenanceError?: Failure;
  maintenance?: { kind: 'revert' | 'isolation' | 'compact'; previousState: State };
  /** Permanent: unavailable private storage must never fall back to live files. */
  isolatedView?: IsolatedViewBinding;
  startup?: WorkerStartup;
  scheduleWait?: ScheduleWait;
  /** Opaque schedule-wait generation; absent means 0. */
  scheduleWaitRevision?: number;
  waitingReason?: WaitingReason;
  storeDirectory?: string;
  messageBase?: number; archives?: { id: string; firstMessage: number; messageCount: number; createdAt: string }[];
  changes?: FileChange[];
}
export interface FileChange { id: string; path: string; target?: string; kind: 'write' | 'delete' | 'rename'; state: 'pending' | 'applied' | 'reverted'; createdAt: string }
export interface ChangeContent extends FileChange { before: string | null; after: string | null }
export type SessionHeader = Pick<Session, 'id' | 'title' | 'model' | 'permission' | 'state' | 'revision' | 'createdAt' | 'updatedAt' | 'ownerId' | 'ownerLabel' | 'workspaceRoot' | 'activity' | 'parentPolicy' | 'parentExpiresAt' | 'isolatedView' | 'startup' | 'waitingReason'> & { lastTurnId?: string; lastAttempt?: number };
export interface ModelPolicy {
  allowWrite?: boolean; allowShell?: boolean; numSessions?: number; maxToolRounds?: number;
  turnTimeoutSeconds?: number; autoCompact?: boolean;
  /** Provider-specific request options for this exact model; no credentials. */
  modelOptions?: Record<string, unknown>;
}
export interface Settings {
  maxTurns: number; maxToolRounds: number; turnTimeoutMs: number;
  maxOutputChars: number; maxHistoryBytes: number; maxSessions: number; retries: number;
  autoCompact?: boolean; models?: Record<string, ModelPolicy>;
}
export interface WorkspaceTools {
  definitions(permission: Session['permission']): Tool[];
  // authorize is re-evaluated immediately before a side effect so a policy
  // change during a tool call cannot be bypassed by stale definitions.
  execute(name: string, input: Record<string, unknown>, permission: Session['permission'], signal: AbortSignal, session?: Session, authorize?: () => void): Promise<string>;
  forSession?(session: Session): WorkspaceTools;
  workspaceRoot?: string;
}
export class WorkerError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}
export function failure(error: unknown): Failure {
  if (error instanceof WorkerError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'ZodError') {
    return { code: 'invalid_arguments', message, retryable: false };
  }
  return { code: 'internal_error', message, retryable: false };
}
