import { z } from 'zod';
import { receiptArchiveDeletesSchema, receiptArchivePublicationsSchema, receiptArchiveSchema, receiptEpochsSchema } from './receipt-retention';

/** Bounded sizes for every board record; the board enforces these instead of evicting silently. */
export const limits = {
  teamName: 120, teamDescription: 2000, teamId: 32, workerId: 32, ownerId: 200, workspaceRoot: 8000,
  taskTitle: 160, taskDescription: 4000, criterion: 500, criteria: 20,
  dependency: 32, blocker: 500, blockers: 16, progress: 4000,
  requestId: 64, reason: 300, refId: 64, refUri: 2048, refLabel: 120,
  members: 32, teams: 64, tasks: 512, candidates: 8, contracts: 8,
  validations: 16, history: 100, requests: 1000
} as const;

/** Per-record history capacity shared by the durable schema and the trimming writer. */
export const historyCapacity = limits.history;

const id32 = z.string().regex(/^[a-f0-9]{32}$/, 'must be a 32-hex id');
const bounded = (max: number) => z.string().min(1).max(max);
const boundedList = <S extends z.ZodType>(item: S, max: number) => z.array(item).max(max);

/** Trusted actor identity, supplied by the host adapter and never accepted inside editable data. */
export const boardActor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('coordinator'), ownerId: z.string().min(1).max(limits.ownerId) }).strict(),
  z.object({ kind: z.literal('worker'), workerId: id32 }).strict()
]);
export type BoardActor = z.infer<typeof boardActor>;
export type CoordinatorActor = Extract<BoardActor, { kind: 'coordinator' }>;
export type WorkerActor = Extract<BoardActor, { kind: 'worker' }>;

export const requestId = z.string().min(1).max(limits.requestId);

/** Versioned content reference. Contract refs and candidate artifact refs share the shape. */
export const refSchema = z.object({
  id: z.string().min(1).max(limits.refId),
  version: z.number().int().positive(),
  uri: z.string().min(1).max(limits.refUri),
  label: bounded(limits.refLabel).optional()
}).strict();
export type Ref = z.infer<typeof refSchema>;
export type ContractRef = Ref;
export type ArtifactRef = Ref;

/** Validation verdict tied to an exact candidate artifact version. */
export const validationRefSchema = z.object({
  artifactId: z.string().min(1).max(limits.refId),
  candidateVersion: z.number().int().positive(),
  outcome: z.enum(['passed', 'failed']),
  note: bounded(500).optional(),
  resultRef: refSchema.optional(),
  at: z.string().datetime()
}).strict();
export type ValidationRef = z.infer<typeof validationRefSchema>;

export const taskStates = ['ready', 'in_progress', 'submitted', 'validating', 'accepted', 'failed', 'cancelled'] as const;
export const taskState = z.enum(taskStates);
export type TaskState = z.infer<typeof taskState>;
/** Active states occupy the assigned worker; the rest release it. integration/integrated are not implemented and cannot be entered. */
export const activeTaskStates: readonly TaskState[] = ['ready', 'in_progress', 'submitted', 'validating'];

export const dependencySchema = z.object({
  taskId: id32,
  kind: z.enum(['contract', 'artifact'])
}).strict();
export type Dependency = z.infer<typeof dependencySchema>;

export const historyEntrySchema = z.object({
  seq: z.number().int().positive(),
  actor: boardActor,
  from: taskState.optional(),
  to: taskState.optional(),
  revision: z.number().int().nonnegative(),
  reason: bounded(limits.reason),
  at: z.string().datetime()
}).strict();
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/** Bounded per-record transition history with monotonic sequence and trim metadata. */
export const historySchema = z.object({
  entries: boundedList(historyEntrySchema, historyCapacity),
  lastSequence: z.number().int().nonnegative(),
  trimmed: z.number().int().nonnegative()
}).strict();
export type History = z.infer<typeof historySchema>;
/** Per-record history capacity shared by the durable schema and the trimming writer. */

export const emptyHistory = (): History => ({ entries: [], lastSequence: 0, trimmed: 0 });

export const teamSchema = z.object({
  id: id32,
  name: bounded(limits.teamName),
  description: z.string().max(limits.teamDescription),
  workspaceRoot: z.string().min(1).max(limits.workspaceRoot),
  coordinatorOwnerId: z.string().min(1).max(limits.ownerId),
  memberWorkerIds: boundedList(id32, limits.members),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  history: historySchema
}).strict();
export type Team = z.infer<typeof teamSchema>;
export type TeamDraft = Omit<Team, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'history'>;

export const taskSchema = z.object({
  id: id32,
  teamId: id32,
  title: bounded(limits.taskTitle),
  description: z.string().max(limits.taskDescription),
  acceptanceCriteria: boundedList(bounded(limits.criterion), limits.criteria),
  dependencies: boundedList(dependencySchema, limits.dependency),
  assigneeWorkerId: id32.nullable(),
  progress: z.string().max(limits.progress),
  blockers: boundedList(bounded(limits.blocker), limits.blockers),
  state: taskState,
  candidates: boundedList(refSchema, limits.candidates),
  agreedContracts: boundedList(refSchema, limits.contracts),
  validations: boundedList(validationRefSchema, limits.validations),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  history: historySchema
}).strict();
export type BoardTask = z.infer<typeof taskSchema>;
export type TaskDraft = Omit<BoardTask, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'history'>;

/** One durable idempotency record: fingerprint + ORIGINAL result, committed atomically with the record mutation. */
export const requestRecordSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.unknown(),
  at: z.string().datetime()
}).strict();
export type RequestRecord = z.infer<typeof requestRecordSchema>;

export const boardDataSchema = z.object({
  schema: z.union([z.literal(1), z.literal(2)]),
  workspaceRoot: z.string().min(1).max(limits.workspaceRoot),
  teams: boundedList(teamSchema, limits.teams),
  tasks: boundedList(taskSchema, limits.tasks),
  receiptEpochs: receiptEpochsSchema.optional(),
  legacyRequestKeys: z.array(z.string().min(1).max(400)).max(limits.requests).optional(),
  receiptArchives: z.array(receiptArchiveSchema).max(64).optional(),
  /** Durable archive-deletion intent; completed by a retry or the next open. */
  receiptArchiveDeletes: receiptArchiveDeletesSchema.optional(),
  /** Durable archive-publication intents (one per owner); each is completed only by that owner's exact rollover retry. */
  receiptArchivePublications: receiptArchivePublicationsSchema.optional(),
  referenceHistory: z.array(z.strictObject({ taskId: id32, kind: z.enum(['candidate', 'contract', 'report']), ref: refSchema })).max(8192).optional(),
  /** Keyed by a digest of [actor.kind, actorId, requestId]. Bounded; a full map is a capacity error, never silent eviction. */
  requests: z.record(z.string().min(1).max(400), requestRecordSchema).refine(
    value => Object.keys(value).length <= limits.requests,
    { message: `too many recorded requests (limit ${limits.requests})` }
  )
}).strict();
export type BoardData = z.infer<typeof boardDataSchema>;

// --- Inputs: strict, never carry the trusted actor. Mutations require requestId; updates require expectedRevision. ---

export const teamCreateInput = z.object({
  requestId,
  name: bounded(limits.teamName),
  description: z.string().max(limits.teamDescription)
}).strict();
export type TeamCreateInput = z.infer<typeof teamCreateInput>;

export const teamUpdateInput = z.object({
  requestId,
  teamId: id32,
  expectedRevision: z.number().int().nonnegative(),
  name: bounded(limits.teamName).optional(),
  description: z.string().max(limits.teamDescription).optional(),
  addMembers: boundedList(id32, limits.members).optional(),
  removeMembers: boundedList(id32, limits.members).optional()
}).strict();
export type TeamUpdateInput = z.infer<typeof teamUpdateInput>;

export const taskCreateInput = z.object({
  requestId,
  teamId: id32,
  title: bounded(limits.taskTitle),
  description: z.string().max(limits.taskDescription),
  acceptanceCriteria: boundedList(bounded(limits.criterion), limits.criteria).optional(),
  dependencies: boundedList(dependencySchema, limits.dependency).optional(),
  assigneeWorkerId: id32.nullable().optional()
}).strict();
export type TaskCreateInput = z.infer<typeof taskCreateInput>;

/** Coordinator task mutations: identity, contracts, dependencies, verdicts, assignment and coordinator-side states only. */
export const coordinatorTaskUpdateInput = z.object({
  requestId,
  taskId: id32,
  expectedRevision: z.number().int().nonnegative(),
  title: bounded(limits.taskTitle).optional(),
  description: z.string().max(limits.taskDescription).optional(),
  acceptanceCriteria: boundedList(bounded(limits.criterion), limits.criteria).optional(),
  dependencies: boundedList(dependencySchema, limits.dependency).optional(),
  assigneeWorkerId: id32.nullable().optional(),
  agreedContracts: z.object({
    add: boundedList(refSchema, limits.contracts).optional(),
    remove: boundedList(z.object({ id: z.string().min(1).max(limits.refId), version: z.number().int().positive() }).strict(), limits.contracts).optional()
  }).strict().optional(),
  validations: boundedList(validationRefSchema, limits.validations).optional(),
  progress: z.string().max(limits.progress).optional(),
  blockers: boundedList(bounded(limits.blocker), limits.blockers).optional(),
  candidates: boundedList(refSchema, limits.candidates).optional(),
  state: z.enum(taskStates).optional(),
  reason: bounded(limits.reason).optional()
}).strict();
export type CoordinatorTaskUpdateInput = z.infer<typeof coordinatorTaskUpdateInput>;

/** Worker task mutations: own progress/blockers, own lifecycle subset and versioned candidate artifact refs. No contracts, no verdicts. */
export const workerTaskUpdateInput = z.object({
  requestId,
  taskId: id32,
  expectedRevision: z.number().int().nonnegative(),
  progress: z.string().max(limits.progress).optional(),
  blockers: boundedList(bounded(limits.blocker), limits.blockers).optional(),
  state: z.enum(['in_progress', 'submitted', 'failed']).optional(),
  candidates: boundedList(refSchema, limits.candidates).optional(),
  reason: bounded(limits.reason).optional()
}).strict();
export type WorkerTaskUpdateInput = z.infer<typeof workerTaskUpdateInput>;

export const boardGetInput = z.object({ id: id32 }).strict();
export type BoardGetInput = z.infer<typeof boardGetInput>;
export const boardListInput = z.object({ teamId: id32.optional() }).strict();
export type BoardListInput = z.infer<typeof boardListInput>;
