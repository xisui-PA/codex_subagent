export type Part =
  | { type: 'text'; text: string }
  | { type: 'call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'result'; id: string; text: string };

export interface Message { role: 'user' | 'assistant'; parts: Part[] }
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
export interface Session {
  schema: 1; id: string; title: string; model: Model; instructions: string;
  permission: 'read-only' | 'workspace-write'; state: State; messages: Message[]; turns: Turn[];
  operations: Record<string, { fingerprint: string; turnId: string }>;
  summary?: { text: string; through: number }; revision: number; createdAt: string; updatedAt: string;
  ownerId?: string; ownerLabel?: string; parentPolicy?: 'keep' | 'cancel-on-expiry'; parentExpiresAt?: number; parentLeaseSeconds?: number;
  workspaceRoot?: string; activity?: string;
  maintenanceError?: Failure;
  maintenance?: { kind: 'revert'; previousState: State };
  storeDirectory?: string;
  messageBase?: number; archives?: { id: string; firstMessage: number; messageCount: number; createdAt: string }[];
  changes?: FileChange[];
}
export interface FileChange { id: string; path: string; target?: string; kind: 'write' | 'delete' | 'rename'; state: 'pending' | 'applied' | 'reverted'; createdAt: string }
export interface ChangeContent extends FileChange { before: string | null; after: string | null }
export type SessionHeader = Pick<Session, 'id' | 'title' | 'model' | 'permission' | 'state' | 'revision' | 'createdAt' | 'updatedAt' | 'ownerId' | 'ownerLabel' | 'workspaceRoot' | 'activity' | 'parentPolicy' | 'parentExpiresAt'> & { lastTurnId?: string; lastAttempt?: number };
export interface Settings {
  maxConcurrent: number; maxTurns: number; maxToolRounds: number; turnTimeoutMs: number;
  maxOutputChars: number; maxHistoryBytes: number; maxSessions: number; retries: number;
  autoCompact?: boolean;
}
export interface WorkspaceTools {
  definitions(permission: Session['permission']): Tool[];
  execute(name: string, input: Record<string, unknown>, permission: Session['permission'], signal: AbortSignal, session?: Session): Promise<string>;
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
