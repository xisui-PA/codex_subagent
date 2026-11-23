import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite, digest, Mutex } from './storage';
import { WorkerError } from './types';
import { boardActor, limits as boardLimits } from './task-board-types';
import type { BoardActor, WorkerActor } from './task-board-types';

/**
 * Bounded mailbox limits. Bodies are capped by UTF-8 bytes, recipients and
 * acknowledgement batches are capped per call, reads are capped before they are
 * parsed, and the whole document has both an entry cap and a serialized byte
 * cap. The byte cap is enforced by the single commit path, so a send, a
 * delivery update and an acknowledgement can never publish a document over it.
 * At either cap the mailbox rejects the call with `capacity_exceeded` instead
 * of evicting retained records.
 *
 * Ordering and privacy: the durable ROOT sequence is internal. It decides the
 * cross-team delivery order of live mail and it is never returned. Each message
 * also carries its own team's 1-based ordinal (`teamSequence`), assigned in root
 * order, and that ordinal is the only `sequence` a client ever sees, so one
 * team's traffic can never move another team's cursor or reveal its gaps. A
 * bounded durable counter per team (at most the board's 64 teams) holds that
 * team's last ordinal and its pruned watermark; a counter is never evicted or
 * reset, so at the team bound a new team's first event is refused.
 *
 * Retention: a fixed seven-day horizon is persisted in the document
 * (`ttlMs`), so a later host keeps the original horizon instead of re-reading a
 * changed constant. A reply shares its target's `expiresAt`, so a returned
 * reply never outlives the question it answers. The idempotency tombstone
 * horizon is twice the retention horizon: an exact replay after expiry is
 * rejected with `request_expired` while its tombstone is retained; once the
 * tombstone ages out (after 14 days), the requestId may be reused as a new
 * event. That age is evaluated when the send is classified, exactly like
 * `pruneRequests`, so reuse does not wait for an unrelated write or a reload.
 * Changed replays are rejected while either the live message or its tombstone
 * is retained. The 1024-request cap refuses a new event instead of
 * dropping a tombstone, so an idempotency horizon is never shortened silently.
 */
export const mailboxLimits = {
  bodyBytes: 1024,
  recipients: 4,
  listDefault: 12,
  listMax: 20,
  ackIds: 12,
  messages: 200,
  requests: 1024,
  /** Same bounded team count as the board; a durable team counter is never evicted. */
  teams: boardLimits.teams,
  documentBytes: 1024 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  uri: 2048
};

/** Small fixed cap for the identity marker beside the mailbox document. */
const namespaceBytes = 4096;

const id32 = z.string().regex(/^[a-f0-9]{32}$/, 'must be a 32-hex id');
const id64 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a 64-hex id');
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const teamSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Exact sealed submission identity; no dereference and no mutable overlay alias. */
const sealedSubmissionPattern = /^codex-subagent:\/\/submission\/([a-f0-9]{64})\/([a-f0-9]{64})\/([1-9][0-9]*)$/;
export const sealedSubmissionRefSchema = z.object({
  id: id64,
  version: versionSchema,
  uri: z.string().min(1).max(mailboxLimits.uri)
}).strict().superRefine((ref, context) => {
  if (/overlay/i.test(ref.uri)) {
    context.addIssue({ code: 'custom', message: 'Mutable overlay URIs are not sealed submission references.' });
    return;
  }
  const match = sealedSubmissionPattern.exec(ref.uri);
  if (!match || match[2] !== ref.id || Number(match[3]) !== ref.version) {
    context.addIssue({
      code: 'custom',
      message: 'A sealed submission reference uses codex-subagent://submission/<64-hex namespace>/<id>/<version> and must match its id and version.'
    });
  }
});
export type SealedSubmissionRef = z.infer<typeof sealedSubmissionRefSchema>;

/** Exact runner-result identity reported as evidence; version is the fixed schema version. */
const runnerResultPattern = /^urn:codex-runner-result:([a-f0-9]{64}):([a-f0-9]{32})$/;
export const runnerEvidenceRefSchema = z.object({
  id: id32,
  version: z.literal(1),
  uri: z.string().min(1).max(mailboxLimits.uri)
}).strict().superRefine((ref, context) => {
  const match = runnerResultPattern.exec(ref.uri);
  if (!match || match[2] !== ref.id) {
    context.addIssue({
      code: 'custom',
      message: 'Runner evidence uses urn:codex-runner-result:<64-hex namespace>:<32-hex result id> with version 1.'
    });
  }
});
export type RunnerEvidenceRef = z.infer<typeof runnerEvidenceRefSchema>;

export const attemptRefSchema = z.object({
  id: id64,
  revision: sequenceSchema
}).strict();
export type AttemptRef = z.infer<typeof attemptRefSchema>;

export const mailboxKinds = [
  'question', 'reply', 'interface_proposal', 'interface_response', 'discovery',
  'blocker', 'artifact_ready', 'integration_feedback', 'escalation'
] as const;
export const mailboxKindSchema = z.enum(mailboxKinds);
export type MailboxKind = z.infer<typeof mailboxKindSchema>;

const bodySchema = z.string().min(1).refine(
  text => Buffer.byteLength(text, 'utf8') <= mailboxLimits.bodyBytes,
  { message: `body must be at most ${mailboxLimits.bodyBytes} UTF-8 bytes` }
);

const deliverySchema = z.object({
  recipient: boardActor,
  deliveredAt: timeSchema.optional(),
  acknowledgedAt: timeSchema.optional()
}).strict();
export type MailboxDelivery = z.infer<typeof deliverySchema>;

const storedMessageSchema = z.object({
  id: id32,
  /** Internal root order: never exposed; it decides durable cross-team delivery order. */
  sequence: sequenceSchema,
  /** Public order: this team's own 1-based ordinal, assigned in root order. */
  teamSequence: teamSequenceSchema,
  teamId: id32,
  taskId: id32,
  sender: boardActor,
  recipients: z.array(boardActor).min(1).max(mailboxLimits.recipients),
  kind: mailboxKindSchema,
  body: bodySchema,
  toCoordinator: z.literal(true).optional(),
  replyTo: id32.optional(),
  artifact: sealedSubmissionRefSchema.optional(),
  evidence: runnerEvidenceRefSchema.optional(),
  attempt: attemptRefSchema.optional(),
  persistedAt: timeSchema,
  expiresAt: timeSchema,
  deliveries: z.array(deliverySchema).min(1).max(mailboxLimits.recipients),
  requestKey: id64,
  fingerprint: id64
}).strict();
type StoredMailboxMessage = z.infer<typeof storedMessageSchema>;

/**
 * Bounded durable per-team cursor state. `last` is the highest ordinal ever
 * assigned to the team and `prunedThrough` the highest one known to have
 * expired or been pruned. A team counter is never evicted or reset: the team
 * bound refuses a new team's first event instead of dropping another cursor.
 */
const teamCounterSchema = z.object({
  last: teamSequenceSchema,
  prunedThrough: sequenceSchema
}).strict().refine(
  counter => counter.prunedThrough <= counter.last,
  { message: 'a team watermark is beyond its last sequence' }
);

const teamsSchema = z.record(id32, teamCounterSchema).refine(
  teams => Object.keys(teams).length <= mailboxLimits.teams,
  { message: `too many recorded teams (limit ${mailboxLimits.teams})` }
);

const requestRecordSchema = z.object({
  fingerprint: id64,
  messageId: id32,
  at: timeSchema
}).strict();

/**
 * The single current on-disk format. It keeps the retained root fields (the
 * root sequence and root watermark still order durable cross-team delivery) and
 * carries `teamSequence` on every record beside the bounded `teams` cursor map.
 * This is the only schema this build reads, writes or accepts: an older
 * schema-1 document is refused as `mailbox_malformed` and left untouched.
 */
const mailboxDocumentSchema = z.object({
  schema: z.literal(2),
  ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lastSequence: sequenceSchema,
  prunedThrough: sequenceSchema,
  teams: teamsSchema,
  messages: z.array(storedMessageSchema).max(mailboxLimits.messages),
  requests: z.record(id64, requestRecordSchema)
}).strict().refine(
  document => Object.keys(document.requests).length <= mailboxLimits.requests,
  { message: `too many recorded requests (limit ${mailboxLimits.requests})` }
);
type MailboxDocument = z.infer<typeof mailboxDocumentSchema>;

const requestIdSchema = z.string().min(1).max(64);

/**
 * INTERNAL refusal of a read-only attempt that would have to change durable
 * state. It never reaches a mailbox caller: the host answers it by re-running
the identical call through its governed write reservation. It is deliberately
 * not part of the public mailbox error vocabulary.
 */
export const mailboxWriteRequired = 'mailbox_write_required' as const;

/**
 * INTERNAL attempt mode. It is a positional argument of the domain method - no
 * MCP or worker input schema has such a field, so a caller cannot request it -
 * and it grants no authority: trusted identity, live membership, task routing,
 * reply rules, expiry and idempotency decisions are exactly the same. It only
 * decides whether a call that WOULD change durable state is refused before any
 * draft or durable write, which is what lets the host probe a call without a
 * write reservation. A read-only attempt never touches `this.data` or the file.
 */
export type MailboxAttemptMode = { readonly readOnly?: boolean };

/**
 * Strict send input. `taskId` is required context and must belong to `teamId`.
 * Worker recipients are 1-4 distinct ids; `toCoordinator: true` adds the board's
 * coordinator (an empty or omitted worker array is valid when it is the only
 * recipient, and workers plus the coordinator stay capped at four). Reply kinds
 * require `replyTo` and derive their single recipient. `artifact_ready` requires
 * `artifact`; `escalation` is addressed solely to the coordinator.
 */
export const sendMailboxInput = z.object({
  teamId: id32,
  taskId: id32,
  requestId: requestIdSchema,
  kind: mailboxKindSchema,
  body: bodySchema,
  recipients: z.array(id32).max(mailboxLimits.recipients).optional(),
  toCoordinator: z.literal(true).optional(),
  replyTo: id32.optional(),
  artifact: sealedSubmissionRefSchema.optional(),
  evidence: runnerEvidenceRefSchema.optional(),
  attempt: attemptRefSchema.optional()
}).strict().superRefine((input, context) => {
  const recipients = input.recipients ?? [];
  const total = recipients.length + (input.toCoordinator === true ? 1 : 0);
  if (new Set(recipients).size !== recipients.length) {
    context.addIssue({ code: 'custom', path: ['recipients'], message: 'recipients must be distinct worker ids.' });
  }
  if (total < 1 && !input.replyTo) {
    context.addIssue({ code: 'custom', path: ['recipients'], message: 'at least one recipient is required.' });
  }
  if (total > mailboxLimits.recipients) {
    context.addIssue({ code: 'custom', path: ['recipients'], message: `at most ${mailboxLimits.recipients} recipients (workers plus coordinator) are allowed.` });
  }
  const replyKind = input.kind === 'reply' || input.kind === 'interface_response';
  if (replyKind && !input.replyTo) {
    context.addIssue({ code: 'custom', path: ['replyTo'], message: `${input.kind} requires replyTo.` });
  }
  if (!replyKind && input.replyTo) {
    context.addIssue({ code: 'custom', path: ['replyTo'], message: 'replyTo is only valid for reply and interface_response.' });
  }
  if (input.replyTo && (recipients.length > 0 || input.toCoordinator === true)) {
    context.addIssue({ code: 'custom', path: ['replyTo'], message: 'A reply routes to the original sender; omit recipients and toCoordinator.' });
  }
  if (input.kind === 'artifact_ready' && !input.artifact) {
    context.addIssue({ code: 'custom', path: ['artifact'], message: 'artifact_ready requires an artifact reference.' });
  }
  if (input.kind === 'escalation' && (input.toCoordinator !== true || recipients.length > 0)) {
    context.addIssue({ code: 'custom', path: ['recipients'], message: 'escalation is addressed solely to the coordinator.' });
  }
});
export type SendMailboxInput = z.infer<typeof sendMailboxInput>;

/**
 * Strict read input. `after` is THIS team's exclusive lower sequence, and the
 * returned `nextCursor` continues ordinary pagination; both are team-local.
 */
export const listMailboxInput = z.object({
  teamId: id32,
  after: sequenceSchema.default(0),
  limit: z.number().int().min(1).max(mailboxLimits.listMax).default(mailboxLimits.listDefault),
  direction: z.enum(['inbox', 'outbox', 'all']).default('all')
}).strict();
export type ListMailboxInput = z.infer<typeof listMailboxInput>;

/** Strict acknowledgement input: receiver-only ids, at most twelve per call. */
export const acknowledgeMailboxInput = z.object({
  teamId: id32,
  ids: z.array(id32).min(1).max(mailboxLimits.ackIds)
}).strict().refine(
  input => new Set(input.ids).size === input.ids.length,
  { message: 'ids must be distinct.' }
);
export type AcknowledgeMailboxInput = z.infer<typeof acknowledgeMailboxInput>;

/**
 * Synchronous board read contract. Implementations must authorize the actor
 * against live board state (an unknown, deleted or revoked worker throws), which
 * is what makes `team(...)` a live-participant probe for other actors too.
 */
export type MailboxTeamView = {
  coordinatorOwnerId: string;
  memberWorkerIds: readonly string[];
};
export type MailboxTaskView = { teamId: string };
export type MailboxAccess = {
  team(actor: BoardActor, teamId: string): MailboxTeamView;
  task(actor: BoardActor, taskId: string): MailboxTaskView;
  /** Live feature/closing state; re-run before and at publication. */
  guard?(): void;
};

/**
 * Explicit payload marker carried by every returned message and page. The
 * mailbox retains only the bounded body and opaque identities: it never
 * dereferences artifact, evidence or attempt references, never stores their
 * payloads, and a reference may already be expired when it is read.
 */
export type MailboxRetention = {
  payload: 'unretained';
  refs: 'opaque-unretained';
  expiresAt: number;
  expired: boolean;
};
export type MailboxPageRetention = {
  payload: 'unretained';
  refs: 'opaque-unretained';
  ttlMs: number;
};

export type MailboxMessage = {
  id: string;
  /** This team's own durable ordinal: another team's traffic never moves it. */
  sequence: number;
  teamId: string;
  taskId: string;
  sender: BoardActor;
  recipients: BoardActor[];
  kind: MailboxKind;
  body: string;
  toCoordinator?: true;
  replyTo?: string;
  artifact?: SealedSubmissionRef;
  evidence?: RunnerEvidenceRef;
  attempt?: AttemptRef;
  persistedAt: number;
  expiresAt: number;
  deliveries: MailboxDelivery[];
  retention: MailboxRetention;
};

export type MailboxUnread = {
  addressed: number;
  undelivered: number;
  pendingAck: number;
  byKind: Partial<Record<MailboxKind, number>>;
};

export type MailboxPage = {
  teamId: string;
  direction: 'inbox' | 'outbox' | 'all';
  messages: MailboxMessage[];
  nextCursor: number;
  /** Highest team sequence that expired or was pruned; a lower cursor may have a gap. */
  prunedThrough: number;
  unread: MailboxUnread;
  retention: MailboxPageRetention;
};

export type MailboxAckResult = {
  teamId: string;
  acknowledged: string[];
  alreadyAcknowledged: string[];
  ignored: string[];
};

const actorId = (actor: BoardActor): string => actor.kind === 'coordinator' ? `coordinator:${actor.ownerId}` : `worker:${actor.workerId}`;
const sameActor = (a: BoardActor, b: BoardActor): boolean => actorId(a) === actorId(b);

/** Canonical form: object keys sorted recursively, so idempotency fingerprints ignore key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonical(source[key]);
    }
    return out;
  }
  return value;
}

const documentBytes = (document: MailboxDocument): number => Buffer.byteLength(JSON.stringify(document), 'utf8');

/**
 * Durable, file-per-root team mailbox. One JSON document holds every bounded
 * message, per-recipient delivery/acknowledgement metadata, the internal root
 * sequence, each team's own ordinal and cursor watermark, and the idempotency
 * records. All
 * mutations are serialized, validated and published with atomicWrite, so a
 * crash leaves either the previous or the next complete document: the mailbox
 * never resets or rewrites a malformed file. A single resolved directory owns
 * one mailbox document and one namespace record, and the document is always
 * published before the namespace record names it.
 */
export class TeamMailbox {
  private readonly file: string;
  private readonly namespaceFile: string;
  private readonly root: string;
  private readonly mutex = new Mutex();
  private data?: MailboxDocument;
  private opening?: Promise<void>;
  private closing = false;
  private ttlMs = mailboxLimits.ttlMs;

  constructor(readonly directory: string, private readonly access: MailboxAccess, private readonly clock: () => number = Date.now) {
    this.root = path.resolve(directory);
    this.file = path.join(this.root, 'mailbox.json');
    this.namespaceFile = path.join(this.root, 'mailbox.namespace.json');
  }

  async open(): Promise<void> {
    if (this.data) {
      return;
    }
    if (!this.opening) {
      this.opening = this.load();
    }
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  /** Mark the mailbox closing, drain in-flight mutations and drop the loaded document. */
  async close(): Promise<void> {
    this.closing = true;
    await this.mutex.run(async () => {
      this.data = undefined;
    });
  }

  private async load(): Promise<void> {
    this.closing = false;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const namespace = await this.readNamespace();
    const text = await this.readBounded(this.file, mailboxLimits.documentBytes, 'Mailbox document');
    if (text === undefined) {
      // A marker without a document is an established namespace that lost its
      // data; it must never silently become a fresh mailbox. A document without
      // a marker is legitimate: the document is published before the marker.
      if (namespace) {
        throw new WorkerError('mailbox_malformed', 'The mailbox document is missing beside durable namespace metadata. Restore it; expired cursors and request ids must not become fresh operations.');
      }
      this.ttlMs = mailboxLimits.ttlMs;
      this.data = this.emptyDocument();
      return;
    }
    let document: MailboxDocument;
    try {
      // The current strict schema is parsed directly. An older or unknown
      // version is refused right here, before any prune or write, so an existing
      // document is never migrated, rewritten or deleted on load.
      document = mailboxDocumentSchema.parse(JSON.parse(text));
      this.assertDocument(document);
    } catch (error) {
      throw new WorkerError('mailbox_malformed', `Mailbox ${this.file} is malformed and was left untouched: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.ttlMs = document.ttlMs;
    const next = structuredClone(document);
    this.prune(next, this.now());
    this.data = next;
  }

  private emptyDocument(): MailboxDocument {
    return { schema: 2, ttlMs: this.ttlMs, lastSequence: 0, prunedThrough: 0, teams: {}, messages: [], requests: {} };
  }

  /**
   * Bounded, plain-file read. The size is checked from lstat before any byte is
   * read and again from the decoded text, and a symlink or non-file fails closed
   * instead of being followed, so a malformed or oversized store is never
   * parsed and never rewritten.
   */
  private async readBounded(file: string, maxBytes: number, label: string): Promise<string | undefined> {
    let stats: Stats;
    try {
      stats = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw new WorkerError('mailbox_unreadable', `Cannot stat ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new WorkerError('mailbox_malformed', `${label} ${file} is not a plain file; the mailbox fails closed instead of following a link or reading a non-file.`);
    }
    if (stats.size > maxBytes) {
      throw new WorkerError('mailbox_malformed', `${label} ${file} is ${stats.size} bytes, above the ${maxBytes}-byte cap; the mailbox left it untouched.`);
    }
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      throw new WorkerError('mailbox_unreadable', `Cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new WorkerError('mailbox_malformed', `${label} ${file} grew above the ${maxBytes}-byte cap while it was read; the mailbox left it untouched.`);
    }
    return text;
  }

  private async readNamespace(): Promise<boolean> {
    const text = await this.readBounded(this.namespaceFile, namespaceBytes, 'Mailbox namespace');
    if (text === undefined) {
      return false;
    }
    this.parseNamespace(text);
    return true;
  }

  private parseNamespace(text: string): void {
    let parsed: { schema?: unknown; root?: unknown };
    try {
      parsed = JSON.parse(text) as { schema?: unknown; root?: unknown };
    } catch {
      throw new WorkerError('mailbox_malformed', 'The mailbox namespace record is not valid JSON.');
    }
    if (parsed.schema !== 1 || parsed.root !== this.root) {
      throw new WorkerError('mailbox_malformed', 'The mailbox namespace identity differs from this canonical root.');
    }
  }

  /** Fail closed on an existing marker that names another root, before any document is published. */
  private async assertNamespace(): Promise<void> {
    const existing = await this.readBounded(this.namespaceFile, namespaceBytes, 'Mailbox namespace');
    if (existing !== undefined) {
      this.parseNamespace(existing);
    }
  }

  private async ensureNamespace(): Promise<void> {
    const existing = await this.readBounded(this.namespaceFile, namespaceBytes, 'Mailbox namespace');
    if (existing !== undefined) {
      this.parseNamespace(existing);
      return;
    }
    await atomicWrite(this.namespaceFile, JSON.stringify({ schema: 1, root: this.root }));
  }

  private now(): number {
    return this.clock();
  }

  private requireOpen(): MailboxDocument {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'The mailbox is closing; new and queued calls are rejected.');
    }
    if (!this.data) {
      throw new WorkerError('store_closed', 'Team mailbox is not open; call open() first.');
    }
    return this.data;
  }

  /** Re-run the host's live feature/closing guard and the caller's guard. */
  private live(guard?: () => void): void {
    this.access.guard?.();
    guard?.();
  }

  private requireWritable(): void {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'The mailbox is closing; the pending publication was rejected.');
    }
    if (!this.data) {
      throw new WorkerError('store_closed', 'Team mailbox is not open.');
    }
  }

  private inputError(error: unknown): WorkerError {
    if (error instanceof WorkerError) {
      return error;
    }
    if (error instanceof z.ZodError) {
      return new WorkerError('invalid_arguments', z.prettifyError(error));
    }
    return new WorkerError('invalid_arguments', error instanceof Error ? error.message : String(error));
  }

  private parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
    try {
      return schema.parse(input);
    } catch (error) {
      throw this.inputError(error);
    }
  }

  private trustedActor(actor: BoardActor): BoardActor {
    try {
      return boardActor.parse(actor);
    } catch (error) {
      throw this.inputError(error);
    }
  }

  private requireWorker(actor: BoardActor): WorkerActor {
    const trusted = this.trustedActor(actor);
    if (trusted.kind !== 'worker') {
      throw new WorkerError('invalid_arguments', 'This mailbox operation requires a worker actor.');
    }
    return trusted;
  }

  /** Authorize the actor against the current board team and require its live role/membership. */
  private requireTeam(actor: BoardActor, teamId: string): MailboxTeamView {
    const team = this.access.team(actor, teamId);
    if (actor.kind === 'coordinator') {
      if (team.coordinatorOwnerId !== actor.ownerId) {
        throw new WorkerError('forbidden', `Team ${teamId} belongs to a different coordinator.`);
      }
    } else if (!team.memberWorkerIds.includes(actor.workerId)) {
      throw new WorkerError('forbidden', `Worker ${actor.workerId} is not a live member of team ${teamId}.`);
    }
    return team;
  }

  private requireTask(actor: BoardActor, taskId: string, teamId: string): void {
    const task = this.access.task(actor, taskId);
    if (task.teamId !== teamId) {
      throw new WorkerError('invalid_arguments', `Task ${taskId} does not belong to team ${teamId}; a mailbox message must stay in one team.`);
    }
  }

  /**
   * Live participant probe. The board view is read AS the participant, so a
   * deleted worker (whose session no longer authorizes a read) and a worker
   * revoked from the team both fail, even when `memberWorkerIds` is stale.
   */
  private participantLive(teamId: string, participant: BoardActor): boolean {
    let team: MailboxTeamView;
    try {
      team = this.access.team(participant, teamId);
    } catch {
      return false;
    }
    return participant.kind === 'coordinator'
      ? team.coordinatorOwnerId === participant.ownerId
      : team.memberWorkerIds.includes(participant.workerId);
  }

  /** Highest ordinal of `teamId` known to have expired; never another team's traffic. */
  private markExpired(document: MailboxDocument, teamId: string, now: number): number {
    let mark = document.teams[teamId]?.prunedThrough ?? 0;
    for (const message of document.messages) {
      if (message.teamId === teamId && message.expiresAt <= now) {
        mark = Math.max(mark, message.teamSequence);
      }
    }
    return mark;
  }

  /**
   * Drops expired messages (and any reply that somehow outlived its target) and
   * advances the durable cursor watermarks by the removed ordinals: the internal
   * root watermark and only the affected teams' own cursors. Request tombstones
   * outlive their message by one extra retention horizon, so an exact replay
   * just past expiry still fails closed instead of becoming a new event; the
   * request cap refuses a new event and never evicts a tombstone or a live
   * record. The same prune runs on open, on send and before delivery and
   * acknowledgement commits, so cursor and tombstone state is identical before
   * and after a subsequent write or a reload.
   */
  private prune(document: MailboxDocument, now: number): boolean {
    const removed = new Set<string>();
    const teams = new Map<string, number>();
    let watermark = document.prunedThrough;
    // The root sequence stays the internal durable order, and each removed
    // record advances only ITS OWN team's cursor watermark.
    const drop = (message: StoredMailboxMessage): void => {
      removed.add(message.id);
      watermark = Math.max(watermark, message.sequence);
      teams.set(message.teamId, Math.max(teams.get(message.teamId) ?? 0, message.teamSequence));
    };
    for (const message of document.messages) {
      if (message.expiresAt <= now) {
        drop(message);
      }
    }
    let cascaded = true;
    while (cascaded) {
      cascaded = false;
      for (const message of document.messages) {
        if (!removed.has(message.id) && message.replyTo && removed.has(message.replyTo)) {
          drop(message);
          cascaded = true;
        }
      }
    }
    if (removed.size > 0) {
      document.messages = document.messages.filter(message => !removed.has(message.id));
    }
    document.prunedThrough = Math.max(document.prunedThrough, watermark);
    for (const [teamId, teamSequence] of teams) {
      const counter = document.teams[teamId];
      if (counter) {
        counter.prunedThrough = Math.max(counter.prunedThrough, teamSequence);
      }
    }
    this.pruneRequests(document, now);
    return removed.size > 0;
  }

  /**
   * Ages out only request tombstones whose message is already gone and whose
   * double retention horizon has elapsed. Nothing else is removed here: the
   * request cap refuses a new event in `send` and in strict validation, so an
   * over-cap document never exists and no retained or live request is ever
   * evicted to make room for another one.
   */
  private pruneRequests(document: MailboxDocument, now: number): void {
    const retained = new Set(document.messages.map(message => message.id));
    for (const [key, record] of Object.entries(document.requests)) {
      if (!retained.has(record.messageId) && record.at + document.ttlMs * 2 <= now) {
        delete document.requests[key];
      }
    }
  }

  private assertDocument(document: MailboxDocument): void {
    const fail: (message: string) => never = message => {
      throw new WorkerError('mailbox_malformed', message);
    };
    if (document.prunedThrough > document.lastSequence) {
      fail('The expired-cursor watermark is beyond the last sequence.');
    }
    const byId = new Map<string, StoredMailboxMessage>();
    let previous = 0;
    for (const message of document.messages) {
      if (message.sequence <= previous) {
        fail(`Message ${message.id} is not in strictly ascending sequence order.`);
      }
      previous = message.sequence;
      if (message.sequence > document.lastSequence) {
        fail(`Message ${message.id} is beyond the last sequence.`);
      }
      if (byId.has(message.id)) {
        fail(`Duplicate message id ${message.id}.`);
      }
      byId.set(message.id, message);
      if (message.deliveries.length !== message.recipients.length) {
        fail(`Message ${message.id} has per-recipient metadata that does not match its recipients.`);
      }
      message.recipients.forEach((recipient, index) => {
        if (!sameActor(recipient, message.deliveries[index].recipient)) {
          fail(`Message ${message.id} has per-recipient metadata in a different order than its recipients.`);
        }
      });
      const coordinators = message.recipients.filter(recipient => recipient.kind === 'coordinator');
      if (coordinators.length > 1) {
        fail(`Message ${message.id} addresses more than one coordinator.`);
      }
      if ((coordinators.length === 1) !== (message.toCoordinator === true)) {
        fail(`Message ${message.id} does not record its coordinator recipient consistently.`);
      }
      if (message.kind === 'escalation' && (coordinators.length !== 1 || message.recipients.length !== 1)) {
        fail(`Escalation ${message.id} must be addressed solely to the coordinator.`);
      }
      if (message.kind === 'artifact_ready' && !message.artifact) {
        fail(`artifact_ready ${message.id} has no artifact reference.`);
      }
      const replyKind = message.kind === 'reply' || message.kind === 'interface_response';
      if (replyKind !== (message.replyTo !== undefined)) {
        fail(`Message ${message.id} records reply metadata for the wrong kind.`);
      }
    }
    // Per-team ordering is durable state, never something to repair: every team
    // ordinal must ascend in root order, stay inside its own counter, and the
    // bounded counter map must agree exactly with the retained records.
    const teamIds = Object.keys(document.teams);
    if (teamIds.length > mailboxLimits.teams) {
      fail(`The document records ${teamIds.length} teams, above the ${mailboxLimits.teams}-team bound.`);
    }
    // A per-team counter can only describe ordinals that were really assigned in
    // root order: each assigned ordinal pairs with one distinct root sequence, so
    // a team's last sequence and watermark are bounded by the internal root
    // counters. This build writes one root sequence per team ordinal and never
    // drops a team counter, so the counters must account for the WHOLE root
    // sequence: a short total can only come from an older rebased document.
    // Bounded subtraction keeps these checks safe at the maximum sequence value.
    let unassigned = document.lastSequence;
    for (const id of teamIds) {
      const counter = document.teams[id];
      if (counter.last > document.lastSequence) {
        fail(`Team ${id} has a last sequence beyond the root sequence.`);
      }
      if (counter.prunedThrough > document.prunedThrough) {
        fail(`Team ${id} has a watermark beyond the root watermark.`);
      }
      if (counter.last > unassigned) {
        fail('The recorded per-team sequences account for more ordinals than the root sequence ever assigned.');
      }
      unassigned -= counter.last;
    }
    if (unassigned !== 0) {
      fail('The per-team counters do not account for every root sequence; the document was not written by this build.');
    }
    const highest = new Map<string, number>();
    for (const message of document.messages) {
      const counter = document.teams[message.teamId];
      if (!counter) {
        fail(`Message ${message.id} has no durable counter for team ${message.teamId}.`);
      }
      const previousTeam = highest.get(message.teamId) ?? 0;
      if (message.teamSequence <= previousTeam) {
        fail(`Message ${message.id} is not in strictly ascending per-team sequence order.`);
      }
      if (message.teamSequence > counter.last) {
        fail(`Message ${message.id} is beyond its team's last sequence.`);
      }
      highest.set(message.teamId, message.teamSequence);
    }
    for (const id of teamIds) {
      const counter = document.teams[id];
      if (counter.last !== Math.max(counter.prunedThrough, highest.get(id) ?? 0)) {
        fail(`Team ${id} has a counter that does not match its retained records and watermark.`);
      }
    }
    const seenReplies = new Set<string>();
    for (const message of document.messages) {
      if (!message.replyTo) {
        continue;
      }
      const target = byId.get(message.replyTo);
      if (!target || target.sequence >= message.sequence) {
        fail(`Reply ${message.id} references a missing or later target.`);
      }
      if (target.teamId !== message.teamId || target.taskId !== message.taskId) {
        fail(`Reply ${message.id} does not stay in the target's team and task.`);
      }
      const expected = target.kind === 'question' ? 'reply' : target.kind === 'interface_proposal' ? 'interface_response' : undefined;
      if (!expected || message.kind !== expected) {
        fail(`Reply ${message.id} does not answer a question or interface proposal with the matching kind.`);
      }
      // Only an actor the target actually addressed may answer it, and the reply
      // routes to the target's sender: both directions are durable invariants.
      if (!target.recipients.some(recipient => sameActor(recipient, message.sender))) {
        fail(`Reply ${message.id} is not from an actor the target addressed.`);
      }
      if (message.recipients.length !== 1 || !sameActor(message.recipients[0], target.sender)) {
        fail(`Reply ${message.id} is not routed to the original sender.`);
      }
      if (message.expiresAt !== target.expiresAt) {
        fail(`Reply ${message.id} does not share its target's expiry.`);
      }
      const key = `${message.replyTo}:${actorId(message.sender)}`;
      if (seenReplies.has(key)) {
        fail(`Message ${message.replyTo} has more than one reply from ${actorId(message.sender)}.`);
      }
      seenReplies.add(key);
    }
    for (const message of document.messages) {
      if (message.replyTo) {
        if (message.expiresAt > message.persistedAt + document.ttlMs) {
          fail(`Reply ${message.id} outlives the mailbox retention horizon.`);
        }
      } else if (message.expiresAt !== message.persistedAt + document.ttlMs) {
        fail(`Message ${message.id} does not use the mailbox retention horizon.`);
      }
    }
    // Every retained record keeps its exact receipt, and every receipt keeps its
    // exact record: idempotency is never silently lost for a live message.
    for (const message of document.messages) {
      const record = document.requests[message.requestKey];
      if (!record || record.messageId !== message.id || record.fingerprint !== message.fingerprint) {
        fail(`Message ${message.id} has no exact request receipt; its idempotency record was lost.`);
      }
    }
    for (const [key, record] of Object.entries(document.requests)) {
      const message = byId.get(record.messageId);
      if (message && (message.requestKey !== key || message.fingerprint !== record.fingerprint)) {
        fail(`Request ${key} does not match the retained message it recorded.`);
      }
    }
  }

  private async commit(document: MailboxDocument, authorize?: () => void): Promise<void> {
    try {
      mailboxDocumentSchema.parse(document);
      this.assertDocument(document);
    } catch (error) {
      throw new WorkerError('mailbox_malformed', `Refusing to publish an invalid mailbox document: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.requireWritable();
    this.live();
    // The serialized cap applies to every commit path: a send, a delivery
    // update and an acknowledgement all publish through here.
    if (documentBytes(document) > mailboxLimits.documentBytes) {
      throw new WorkerError('capacity_exceeded', `The mailbox would exceed its ${mailboxLimits.documentBytes}-byte durable cap; wait for expiry or use a new mailbox root.`);
    }
    authorize?.();
    await this.assertNamespace();
    // The rename is the single publication point; the live guard and the exact
    // actor/recipient authorization are re-applied immediately before it so a
    // revoked member, a deleted peer or a closing feature cannot be published.
    //
    // The document is published BEFORE the namespace marker. The marker only
    // asserts that this root already held a document, so a refused or
    // interrupted first publication (guard at beforeRename, process crash)
    // can never leave a marker without data and make a fresh root permanently
    // mailbox_malformed. A document without a marker stays readable and is
    // named by its next commit.
    await atomicWrite(this.file, JSON.stringify(document), 0o600, () => {
      this.requireWritable();
      this.live();
      authorize?.();
    });
    this.data = document;
    await this.ensureNamespace();
  }

  private requestFingerprint(input: SendMailboxInput): string {
    return digest(['team-mailbox.send', canonical(input)]);
  }

  private requestKey(actor: BoardActor, requestId: string): string {
    return digest(['team-mailbox', actor.kind, actor.kind === 'coordinator' ? actor.ownerId : actor.workerId, requestId]);
  }

  private toPublic(message: StoredMailboxMessage, now: number): MailboxMessage {
    const out: MailboxMessage = {
      id: message.id,
      // The public sequence is the team's own ordinal; the internal root order
      // is never exposed, so another team's traffic can never move it.
      sequence: message.teamSequence,
      teamId: message.teamId,
      taskId: message.taskId,
      sender: structuredClone(message.sender),
      recipients: structuredClone(message.recipients),
      kind: message.kind,
      body: message.body,
      persistedAt: message.persistedAt,
      expiresAt: message.expiresAt,
      deliveries: structuredClone(message.deliveries),
      retention: {
        payload: 'unretained',
        refs: 'opaque-unretained',
        expiresAt: message.expiresAt,
        expired: message.expiresAt <= now
      }
    };
    if (message.toCoordinator === true) {
      out.toCoordinator = true;
    }
    if (message.replyTo) {
      out.replyTo = message.replyTo;
    }
    if (message.artifact) {
      out.artifact = structuredClone(message.artifact);
    }
    if (message.evidence) {
      out.evidence = structuredClone(message.evidence);
    }
    if (message.attempt) {
      out.attempt = structuredClone(message.attempt);
    }
    return out;
  }

  private authorizeParticipants(actor: BoardActor, teamId: string, taskId: string, recipients: readonly BoardActor[], guard?: () => void): void {
    this.live(guard);
    this.requireTeam(actor, teamId);
    this.requireTask(actor, taskId, teamId);
    for (const recipient of recipients) {
      if (!this.participantLive(teamId, recipient)) {
        throw new WorkerError('recipient_invalid', `Recipient ${actorId(recipient)} is not a live participant of team ${teamId}.`);
      }
    }
  }

  /**
   * One retained, unexpired message for an idempotent replay. A retained but
   * expired record and an already pruned record answer identically, so a retry
   * is consistent before and after a reload or a later write, and an expired
   * message is never returned as a success.
   */
  /** Refusal of a read-only attempt that would have to change durable state. */
  private writeRequired(): WorkerError {
    return new WorkerError(mailboxWriteRequired, 'This mailbox call would change durable state; it needs a governed write reservation.');
  }

  private replayOf(known: StoredMailboxMessage | undefined, conflict: boolean, now: number, guard?: () => void): MailboxMessage {
    if (conflict) {
      throw new WorkerError('request_reuse_conflict', 'This requestId was already used with different arguments; choose a new requestId.');
    }
    this.live(guard);
    if (!known || known.expiresAt <= now) {
      throw new WorkerError('request_expired', 'This requestId is past the mailbox retention horizon; choose a new requestId.');
    }
    return this.toPublic(known, now);
  }

  /**
   * Sends one durable message. The trusted sender and derived coordinator
   * recipient are persisted, never accepted from input. Idempotent replay of
   * the same actor/requestId with the same arguments returns the original
   * message; changed arguments fail closed while either the message or its
   * tombstone is retained, and an expired message is never returned. Once the
   * tombstone itself ages out, the same id is a new event even before a later
   * prune or reload rewrites the document.
   *
   * A read-only attempt (the host's admission probe) answers that exact replay
   * normally and refuses a NEW event with the internal `mailbox_write_required`
   * before any draft or durable write, so probing a call can neither mutate the
   * loaded document nor publish.
   */
  async send(actor: BoardActor, input: unknown, guard?: () => void, attempt?: MailboxAttemptMode): Promise<MailboxMessage> {
    const trusted = this.trustedActor(actor);
    const parsed = this.parseInput(sendMailboxInput, input);
    this.requireOpen();
    return this.mutex.run(async () => {
      const data = this.requireOpen();
      this.live(guard);
      const team = this.requireTeam(trusted, parsed.teamId);
      this.requireTask(trusted, parsed.taskId, parsed.teamId);
      const now = this.now();
      const key = this.requestKey(trusted, parsed.requestId);
      const fingerprint = this.requestFingerprint(parsed);
      const recorded = data.requests[key];
      // A request record classifies a replay ONLY while its own message is live
      // or while its tombstone is still inside the double retention horizon.
      // `pruneRequests` removes exactly the record whose message is gone and
      // whose age passed that horizon; this test is the same age boundary, so an
      // aged-out in-memory record answers like a pruned one: the same requestId
      // creates a NEW event without waiting for an unrelated write or a reload.
      // Inside the horizon the exact replay, changed-argument conflict and
      // expired-replay answers are unchanged.
      if (recorded) {
        const known = data.messages.find(message => message.id === recorded.messageId);
        if ((known && known.expiresAt > now) || recorded.at + data.ttlMs * 2 > now) {
          return this.replayOf(known, recorded.fingerprint !== fingerprint, now, guard);
        }
      }
      const known = data.messages.find(message => message.requestKey === key);
      // A retained live record without its receipt is still the same event; an
      // EXPIRED one is classified only through the tombstone age above, so it
      // cannot resurrect the refusal after that horizon passed.
      if (known && known.expiresAt > now) {
        return this.replayOf(known, known.fingerprint !== fingerprint, now, guard);
      }
      const target = parsed.replyTo ? data.messages.find(message => message.id === parsed.replyTo) : undefined;
      if (parsed.replyTo) {
        if (!target) {
          throw new WorkerError('not_found', `Reply target ${parsed.replyTo} is not retained in this mailbox.`);
        }
        if (target.expiresAt <= now) {
          throw new WorkerError('request_expired', 'The reply target has expired.');
        }
      }
      let recipients: BoardActor[];
      let toCoordinator: true | undefined;
      let expiresAt = now + data.ttlMs;
      if (target) {
        if (target.teamId !== parsed.teamId || target.taskId !== parsed.taskId) {
          throw new WorkerError('reply_invalid', 'A reply must stay in the original team and task.');
        }
        const expected = target.kind === 'question' ? 'reply' : target.kind === 'interface_proposal' ? 'interface_response' : undefined;
        if (!expected || parsed.kind !== expected) {
          throw new WorkerError('reply_invalid', 'A reply must answer a question (reply) or an interface proposal (interface_response).');
        }
        if (!target.recipients.some(recipient => sameActor(recipient, trusted))) {
          throw new WorkerError('forbidden', 'Only an actor addressed by the original message may reply.');
        }
        if (data.messages.some(message => message.replyTo === target.id && sameActor(message.sender, trusted))) {
          throw new WorkerError('reply_conflict', 'This actor already answered the original message.');
        }
        recipients = [structuredClone(target.sender)];
        toCoordinator = target.sender.kind === 'coordinator' ? true : undefined;
        // A reply shares its target's expiry, so it can never be returned with a
        // later expiresAt than the question it answers.
        expiresAt = target.expiresAt;
      } else {
        recipients = (parsed.recipients ?? []).map(workerId => ({ kind: 'worker' as const, workerId }));
        toCoordinator = parsed.toCoordinator === true ? true : undefined;
        if (parsed.toCoordinator === true) {
          recipients.push({ kind: 'coordinator', ownerId: team.coordinatorOwnerId });
        }
      }
      if (recipients.some(recipient => sameActor(recipient, trusted))) {
        throw new WorkerError('recipient_invalid', 'A sender cannot address itself.');
      }
      for (const recipient of recipients) {
        if (!this.participantLive(parsed.teamId, recipient)) {
          throw new WorkerError('recipient_invalid', `Recipient ${actorId(recipient)} is not a live participant of team ${parsed.teamId}.`);
        }
      }
      // Every decision above already ran exactly as for a real call, so an exact
      // replay returned and a conflicting, expired, forbidden or invalid call kept
      // its own domain error. Only a genuine NEW event is refused here, before the
      // draft exists, so a read-only attempt cannot change `this.data` or the file.
      if (attempt?.readOnly === true) {
        throw this.writeRequired();
      }
      // The REAL mutation prunes its own clone before appending: an aged-out
      // tombstone is removed from the published document there, while a
      // read-only attempt above never cloned, pruned or wrote anything.
      const draft = structuredClone(data);
      this.prune(draft, now);
      if (draft.messages.length >= mailboxLimits.messages) {
        throw new WorkerError('capacity_exceeded', `The mailbox already retains ${mailboxLimits.messages} live messages; wait for expiry or use a new mailbox root.`);
      }
      if (Object.keys(draft.requests).length >= mailboxLimits.requests) {
        throw new WorkerError('capacity_exceeded', `The mailbox already retains ${mailboxLimits.requests} request records; wait for their horizon to elapse.`);
      }
      const counter = draft.teams[parsed.teamId];
      if (!counter && Object.keys(draft.teams).length >= mailboxLimits.teams) {
        // Refused rather than evicting another team's durable cursor.
        throw new WorkerError('capacity_exceeded', `The mailbox already records ${mailboxLimits.teams} teams; its bounded team cursors are never evicted. Use an existing team or a new mailbox root.`);
      }
      const sequence = draft.lastSequence + 1;
      const teamSequence = (counter?.last ?? 0) + 1;
      const message: StoredMailboxMessage = {
        id: randomUUID().replace(/-/g, ''),
        sequence,
        teamSequence,
        teamId: parsed.teamId,
        taskId: parsed.taskId,
        sender: structuredClone(trusted),
        recipients: recipients.map(recipient => structuredClone(recipient)),
        kind: parsed.kind,
        body: parsed.body,
        persistedAt: now,
        expiresAt,
        deliveries: recipients.map(recipient => ({ recipient: structuredClone(recipient) })),
        requestKey: key,
        fingerprint
      };
      if (toCoordinator) {
        message.toCoordinator = true;
      }
      if (parsed.replyTo) {
        message.replyTo = parsed.replyTo;
      }
      if (parsed.artifact) {
        message.artifact = structuredClone(parsed.artifact);
      }
      if (parsed.evidence) {
        message.evidence = structuredClone(parsed.evidence);
      }
      if (parsed.attempt) {
        message.attempt = structuredClone(parsed.attempt);
      }
      draft.messages.push(message);
      draft.lastSequence = sequence;
      draft.teams[parsed.teamId] = counter
        ? { last: teamSequence, prunedThrough: counter.prunedThrough }
        : { last: teamSequence, prunedThrough: 0 };
      draft.requests[key] = { fingerprint, messageId: message.id, at: now };
      // The publication recheck keeps every existing participant guard and adds
      // the retention horizon: an event or reply that expires while it waits for
      // the durable write is refused instead of being published as live mail.
      const authorize = (): void => {
        this.authorizeParticipants(trusted, parsed.teamId, parsed.taskId, recipients, guard);
        if (expiresAt <= this.now()) {
          throw new WorkerError('request_expired', 'This event reached its retention horizon before it could be published; choose a new requestId.');
        }
      };
      await this.commit(draft, authorize);
      // A fresh clock after the rename: an event that expired while the write
      // completed is refused, never returned as an unexpired message. Its id and
      // receipt stay stored, so the exact retry answers request_expired before
      // and after a reload.
      const published = this.now();
      if (expiresAt <= published) {
        throw new WorkerError('request_expired', 'This event expired as it was published; its exact retry is refused and a new requestId is required.');
      }
      return this.toPublic(message, published);
    });
  }

  /**
   * Ordered, team-local page of retained messages. Coordinators inspect every
   * retained event of their team for disputes. Workers see their own
   * inbox/outbox only while they are live members, and an incoming message
   * additionally requires a still-live sender; a revoked multicast co-recipient
   * never hides a message from the recipients that remain live. The cursor, the
   * page sequences and the watermark belong to THIS team, so another team's
   * traffic never moves them, and the page always carries a bounded unread
   * summary for the caller's inbox.
   */
  list(actor: BoardActor, input: unknown): MailboxPage {
    const trusted = this.trustedActor(actor);
    const data = this.requireOpen();
    this.live();
    const parsed = this.parseInput(listMailboxInput, input);
    this.requireTeam(trusted, parsed.teamId);
    const now = this.now();
    // Only this team's own ordinals are read; another team's traffic and the
    // internal root counters never reach a public field.
    const watermark = this.markExpired(data, parsed.teamId, now);
    const inbox = (message: StoredMailboxMessage): boolean => message.recipients.some(recipient => sameActor(recipient, trusted));
    const outbox = (message: StoredMailboxMessage): boolean => sameActor(message.sender, trusted);
    const senderLive = (message: StoredMailboxMessage): boolean => this.participantLive(parsed.teamId, message.sender);
    const visible = data.messages.filter(message => {
      if (message.teamId !== parsed.teamId || message.expiresAt <= now) {
        return false;
      }
      if (trusted.kind === 'coordinator') {
        return parsed.direction === 'all' || (parsed.direction === 'inbox' ? inbox(message) : outbox(message));
      }
      const mine = parsed.direction === 'all'
        ? inbox(message) || outbox(message)
        : parsed.direction === 'inbox' ? inbox(message) : outbox(message);
      return mine && (outbox(message) || senderLive(message));
    });
    const candidates = visible
      .filter(message => message.teamSequence > parsed.after)
      .sort((a, b) => a.teamSequence - b.teamSequence);
    const selected = candidates.slice(0, parsed.limit);
    const last = selected.at(-1);
    const nextCursor = candidates.length > selected.length && last
      ? last.teamSequence
      : Math.max(parsed.after, data.teams[parsed.teamId]?.last ?? 0, watermark);
    const unread: MailboxUnread = { addressed: 0, undelivered: 0, pendingAck: 0, byKind: {} };
    for (const message of data.messages) {
      if (message.teamId !== parsed.teamId || message.expiresAt <= now || !inbox(message)) {
        continue;
      }
      if (trusted.kind === 'worker' && !senderLive(message)) {
        continue;
      }
      unread.addressed++;
      unread.byKind[message.kind] = (unread.byKind[message.kind] ?? 0) + 1;
      const delivery = message.deliveries.find(entry => sameActor(entry.recipient, trusted));
      if (!delivery?.deliveredAt) {
        unread.undelivered++;
      }
      if (!delivery?.acknowledgedAt) {
        unread.pendingAck++;
      }
    }
    return {
      teamId: parsed.teamId,
      direction: parsed.direction,
      messages: selected.map(message => this.toPublic(message, now)),
      nextCursor,
      prunedThrough: watermark,
      unread,
      retention: { payload: 'unretained', refs: 'opaque-unretained', ttlMs: data.ttlMs }
    };
  }

  /**
   * Oldest unexpired, undelivered and unacknowledged messages addressed to a
   * live worker from a still-live sender. Read-only: delivery metadata is only
   * advanced by `delivered`.
   *
   * `teamId` is one team or several. Every named team is authorized separately,
   * so a caller that is not a live member of one of them gets nothing, and the
   * result is ordered by the INTERNAL root sequence before any limit is applied
   * and only then mapped to public team ordinals. That root order is the durable
   * cross-team delivery order, so a busy first team can never starve an older
   * notice of a later team. A bound worker passes its single bound team; only
   * this internal adapter ever passes more than one.
   *
   * `limit` is an INTERNAL SCAN bound, not the public list page size: automatic
   * delivery asks for the whole 200-message retention bound, which may exceed
   * `listMax`, while the bound itself stays capped by `mailboxLimits.messages`.
   * Public list pages keep their own `listMax` of 20 unchanged.
   */
  pending(actor: WorkerActor, teamId: string | readonly string[], limit: number): MailboxMessage[] {
    const trusted = this.requireWorker(actor);
    const data = this.requireOpen();
    this.live();
    if (!Number.isInteger(limit) || limit < 0) {
      throw new WorkerError('invalid_arguments', 'limit must be a non-negative integer.');
    }
    // One team id or a bounded array of them. The RAW length is checked before
    // any copy, so this internal fan-out can never amplify a caller's input, and
    // a malformed or non-iterable value is invalid_arguments instead of a
    // TypeError escaping the store.
    const requested: readonly unknown[] | undefined = typeof teamId === 'string'
      ? [teamId]
      : Array.isArray(teamId) ? teamId : undefined;
    if (!requested) {
      throw new WorkerError('invalid_arguments', 'teamId must be a 32-hex id or an array of them.');
    }
    if (requested.length > mailboxLimits.teams) {
      throw new WorkerError('invalid_arguments', `teamId may name at most ${mailboxLimits.teams} teams.`);
    }
    const teams = new Set<string>();
    for (const id of requested) {
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
        throw new WorkerError('invalid_arguments', 'teamId must be a 32-hex id or an array of them.');
      }
      teams.add(id);
    }
    for (const id of teams) {
      this.requireTeam(trusted, id);
    }
    if (!teams.size) {
      return [];
    }
    const now = this.now();
    const bound = Math.min(limit, mailboxLimits.messages);
    return data.messages
      .filter(message => teams.has(message.teamId) && message.expiresAt > now)
      .filter(message => this.participantLive(message.teamId, message.sender))
      .filter(message => {
        const delivery = message.deliveries.find(entry => sameActor(entry.recipient, trusted));
        return !!delivery && !delivery.deliveredAt && !delivery.acknowledgedAt;
      })
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, bound)
      .map(message => this.toPublic(message, now));
  }

  /** Marks the caller's addressed messages delivered, without implying acknowledgement. */
  async delivered(actor: WorkerActor, teamId: string, ids: string[], guard?: () => void): Promise<void> {
    const trusted = this.requireWorker(actor);
    const batch = this.parseIds(ids);
    this.requireOpen();
    return this.mutex.run(async () => {
      const data = this.requireOpen();
      this.live(guard);
      this.requireTeam(trusted, teamId);
      const now = this.now();
      const draft = structuredClone(data);
      let changed = false;
      for (const message of draft.messages) {
        if (message.teamId !== teamId || message.expiresAt <= now || !batch.includes(message.id)) {
          continue;
        }
        if (!this.participantLive(teamId, message.sender)) {
          continue;
        }
        const delivery = message.deliveries.find(entry => sameActor(entry.recipient, trusted));
        if (delivery && !delivery.deliveredAt && !delivery.acknowledgedAt) {
          delivery.deliveredAt = now;
          changed = true;
        }
      }
      if (!changed) {
        return;
      }
      this.prune(draft, now);
      await this.commit(draft, () => {
        this.live(guard);
        this.requireTeam(trusted, teamId);
      });
    });
  }

  /**
   * Receiver-only acknowledgement of up to twelve ids. Acknowledgement does not
   * imply delivery: acknowledged messages keep their (possibly absent)
   * deliveredAt. Unknown, expired, expired-sender or unaddressed ids are
   * reported as ignored.
   *
   * A read-only attempt (the host's admission probe) answers exactly the calls
   * that change nothing - every id already acknowledged, unknown, expired or
   * unaddressed - and refuses a first real acknowledgement with the internal
   * `mailbox_write_required` before any durable write.
   */
  async acknowledge(actor: BoardActor, input: unknown, guard?: () => void, attempt?: MailboxAttemptMode): Promise<MailboxAckResult> {
    const trusted = this.trustedActor(actor);
    const parsed = this.parseInput(acknowledgeMailboxInput, input);
    this.requireOpen();
    return this.mutex.run(async () => {
      const data = this.requireOpen();
      this.live(guard);
      this.requireTeam(trusted, parsed.teamId);
      const now = this.now();
      const draft = structuredClone(data);
      const result: MailboxAckResult = { teamId: parsed.teamId, acknowledged: [], alreadyAcknowledged: [], ignored: [] };
      let changed = false;
      for (const id of parsed.ids) {
        const message = draft.messages.find(candidate => candidate.id === id && candidate.teamId === parsed.teamId);
        const liveSender = message !== undefined && (trusted.kind === 'coordinator' || this.participantLive(parsed.teamId, message.sender));
        const delivery = message && message.expiresAt > now && liveSender
          ? message.deliveries.find(entry => sameActor(entry.recipient, trusted))
          : undefined;
        if (!delivery) {
          result.ignored.push(id);
          continue;
        }
        if (delivery.acknowledgedAt) {
          result.alreadyAcknowledged.push(id);
          continue;
        }
        delivery.acknowledgedAt = now;
        result.acknowledged.push(id);
        changed = true;
      }
      if (!changed) {
        // Nothing would be published, so this is the answer a real call gives too.
        return result;
      }
      if (attempt?.readOnly === true) {
        throw this.writeRequired();
      }
      this.prune(draft, now);
      await this.commit(draft, () => {
        this.live(guard);
        this.requireTeam(trusted, parsed.teamId);
      });
      return result;
    });
  }

  /**
   * Reply eligibility for a worker's own retained question or interface
   * proposal: `unavailable` when the message is missing, expired, authored by
   * someone else, or every direct counterpart was revoked or deleted; `ready`
   * once a live counterpart answered; `waiting` while a live counterpart is
   * still eligible.
   */
  replyState(actor: WorkerActor, teamId: string, messageId: string): 'waiting' | 'ready' | 'unavailable' {
    const trusted = this.requireWorker(actor);
    const data = this.requireOpen();
    this.live();
    if (typeof teamId !== 'string' || !/^[a-f0-9]{32}$/.test(teamId) || typeof messageId !== 'string' || !/^[a-f0-9]{32}$/.test(messageId)) {
      throw new WorkerError('invalid_arguments', 'teamId and messageId must be 32-hex ids.');
    }
    try {
      this.requireTeam(trusted, teamId);
    } catch {
      return 'unavailable';
    }
    const now = this.now();
    const message = data.messages.find(candidate => candidate.id === messageId && candidate.teamId === teamId);
    if (!message || message.expiresAt <= now || !sameActor(message.sender, trusted)) {
      return 'unavailable';
    }
    const expected = message.kind === 'question' ? 'reply' : message.kind === 'interface_proposal' ? 'interface_response' : undefined;
    if (!expected) {
      return 'unavailable';
    }
    const counterparts = message.recipients.filter(recipient => !sameActor(recipient, trusted) && this.participantLive(teamId, recipient));
    if (counterparts.length === 0) {
      return 'unavailable';
    }
    const answered = data.messages.some(candidate => candidate.replyTo === message.id
      && candidate.teamId === teamId
      && candidate.kind === expected
      && candidate.expiresAt > now
      && counterparts.some(counterpart => sameActor(counterpart, candidate.sender)));
    return answered ? 'ready' : 'waiting';
  }

  private parseIds(ids: string[]): string[] {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > mailboxLimits.ackIds
      || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) {
      throw new WorkerError('invalid_arguments', `ids must be 1-${mailboxLimits.ackIds} 32-hex message ids.`);
    }
    return ids;
  }
}
