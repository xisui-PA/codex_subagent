import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TaskBoard } from './task-board';
import type { BoardTask, Ref, Team } from './task-board-types';
import { refSchema } from './task-board-types';
import type { Session } from './types';
import { WorkerError } from './types';
import { atomicWrite, digest, Mutex } from './storage';
import type {
  IntegrationArtifactRef,
  IntegrationComposition,
  IntegrationConflictHop,
  IntegrationScope,
  IntegrationSourceAncestry,
  SealedSubmission
} from './isolated-view-types';
import type { IntegrationPublicationOptions } from './integration-publication';

// ---------------------------------------------------------------------------
// Coordinator-only durable integration attempts.
//
// An attempt is a durable, owner/team-scoped record of one explicit integration
// decision. It pins exact sealed inputs, immutable validation commands, explicit
// dependency/contract selections and an immutable requirements snapshot before
// any consumer side effect. Stages are distinguished here, never by migrating
// board state: existing manual board verdicts stay metadata.
//
// The sequence is:
//   begin    -> private seed snapshot composed from exact source artifacts
//   candidate-> one sealed service-lane submission over that exact seed
//   validate -> one scoped runner result per immutable command
//   accept   -> explicit decision, including every conflict path
//   apply    -> separate publication decision with a durable in-flight intent
//   release  -> explicit abandon and retention release
//
// One publication is additionally guarded by a durable "journal established"
// latch. It is persisted - through the awaited `onJournalReady` callback the
// publication port receives - only after a valid journal is durable and BEFORE
// any workspace effect. `false` therefore proves that nothing can have started,
// so a missing journal may still be replanned, while `true` makes a missing
// journal terminal. The latch is never downgraded: it survives conflict retries
// and reopens, and a record that carries no latch at all is a legacy record and
// is UNCERTAIN, so its journal is required too - with ONE narrow exception: the
// port's open-editor PREFLIGHT conflict (no applied path and no applied count,
// the complete non-truncated editor-only conflict list, one single apply receipt
// and no ambiguous failure or checkpoint) is a completed, trustworthy
// zero-effect result, so such a legacy record may plan a fresh journal again once
// the editor was closed. Applying, partial, interrupted, truncated, corrupt or
// otherwise ambiguous legacy history always keeps requiring the existing
// journal, and an arbitrary zero-count journal error is never treated as safe.
//
// The journal REVISION is tracked too. The port reports the revision of each
// durable per-file intent through the awaited `onJournalIntent` checkpoint, and
// this ledger persists it as a monotonic `publicationJournalRevision` floor
// before that file's first workspace effect. Every later call hands that floor
// back as `minimumJournalRevision`, so a journal older than a revision this
// attempt was already proved to have reached is stale and fails closed at the
// publication port instead of being replayed over the user's files. The floor is
// kept through retries, reopens, interruptions and release, and its worst-case
// growth is part of the room reserved for a terminal report and an explicit
// release.
//
// A proof-only storage-pressure fallback resolves durable state and nothing
// else: it is admitted only for the exact current applying receipt, and only
// when the durable namespace marker already exists. The denial travels INTO the
// loader's single marker read, so a denied call never bootstraps an
// uninitialized store and no separate probe can drift away from that read.
//
// A reply is bounded too, because the transport refuses any response above
// 10,000,000 characters. Every action acknowledges through ONE response path:
// the complete view while its fully serialized ToolResult - the view JSON text
// inside the tool adapter's content envelope - fits MAX_RESPONSE_CHARS, and a
// deterministic bounded summary otherwise. The summary names the attempt and its
// revision, the exact conflictPathsDigest, exact counts, the next decision's
// preconditions and an explicit truncation marker, and it points at the read-only
// `details` action, which pages the COMPLETE status-form view text back. Neither
// form truncates durable data: the record keeps every requirement, contract,
// conflict, evidence, acceptance and publication byte, so an already stored
// oversized attempt is inspectable, decidable and releasable again.
//
// Every mutation carries a requestId. An exact duplicate replays the recorded
// acknowledgment; the same requestId with different arguments fails. No board
// record is ever written here, so manual acceptance/integration verdicts are
// untouched and this module can never accept work implicitly.
// ---------------------------------------------------------------------------

/** Maximum durable attempts kept for one owner/team store. */
const MAX_ATTEMPTS = 64;
/** Hard serialized metadata bound; validates on read and before every write. */
const MAX_DATA_BYTES = 8 * 1024 * 1024;
/**
 * Retained per-attempt request receipts. Nothing is evicted: a recorded request
 * id keeps its original fingerprint for the life of the attempt, so a reused old
 * candidate/validate id can never be replayed as a fresh decision.
 */
const MAX_REQUESTS = 16;
/** Slots always reserved for the exactly-once lifecycle decisions. */
const LIFECYCLE_REQUESTS = 3;
/** Rework receipts (candidate/validate) that may precede those decisions. */
const MAX_REWORK_REQUESTS = MAX_REQUESTS - LIFECYCLE_REQUESTS;
/**
 * The very last receipt slot belongs to release, so a full ledger (for example
 * after a conflict retry at the rework cap) can always drop its pins instead of
 * stranding them. Every other action refuses before its effects when taking the
 * final slot.
 */
const MAX_NON_RELEASE_REQUESTS = MAX_REQUESTS - 1;
const MAX_SOURCES = 16;
const MAX_EVIDENCE = 16;
const MAX_COMMANDS = 8;
const MAX_CONTRACTS = 8;
const MAX_CONFLICTS = 256;
const MAX_PATHS = 4096;
const MAX_DEPENDENCIES = 256;
const MAX_PATH = 2048;
const MAX_REASON = 500;
const MAX_COMMAND = 4000;
const MAX_OWNER = 200;
const MAX_REQUEST = 64;
const MAX_TEAM = 32;
const MAX_TITLE = 160;
/** Matches the board's task description cap so the snapshot stays faithful. */
const MAX_DESCRIPTION = 4000;
const MAX_CRITERION = 500;
const MAX_CRITERIA = 20;
/**
 * Path width the publication port may legitimately report. It is wider than the
 * coordinator request cap because the port reports canonical workspace-relative
 * paths, and the terminal report of an already-started publication must fit.
 */
const MAX_RESULT_PATH = 4096;
/**
 * Most items one publication result may report in either list. The publication
 * plan can name a conflict for every key of the union of two 20,000-entry trees,
 * plus a case-alias diagnostic per changed alias, so the result shape is never
 * the place to reject an already-started publication.
 */
const MAX_RESULT_ITEMS = 100_000;
/**
 * Durable terminal report preview. The full per-file recovery evidence lives in
 * the publication journal, so the ledger keeps a bounded prefix of the exact
 * result plus its exact totals; short results are kept whole, as before.
 */
const MAX_APPLY_PATHS = 256;
const MAX_APPLY_CONFLICTS = 64;
/** Serialized byte budget for one bounded terminal report (paths and reasons). */
const MAX_APPLY_BYTES = 32 * 1024;
/**
 * Serialized bytes the terminal save may add beyond the preview arrays: the
 * report scalars, the apply receipt and the revision change.
 */
const MAX_APPLY_META_BYTES = 1024;
/**
 * Serialized bytes any explicit release must still fit, including a 64-character
 * requestId escaped into JSON. It is reserved for every attempt without a
 * recorded release, so a durable publication can always be abandoned and its
 * pins dropped.
 */
const RELEASE_BYTES = 1024;
/**
 * Character budget for ONE fully serialized `subagent_integration` ToolResult:
 * the view JSON text PLUS the tool adapter's content envelope, both escaped
 * inside the bridge body. The bridge refuses any response above 10,000,000
 * characters, so this budget stays well below that cap and an ordinary reply
 * that fits it is returned byte for byte unchanged. It is measured from the
 * largest reply an existing regression still expects whole - the accepted view
 * of a 602-path conflict union at about 3.28 M characters - so that view stays
 * exactly what it was.
 */
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
/**
 * Bounded `details` page of the COMPLETE view text. `limit` is a soft bound in
 * UTF-16 code units: a page never splits a surrogate pair, so it may carry ONE
 * extra code unit. Even the longest page, re-escaped once into its reply, stays
 * far inside MAX_RESPONSE_CHARS.
 */
const DEFAULT_DETAILS_LIMIT = 16 * 1024;
const MAX_DETAILS_LIMIT = 64 * 1024;
/** Absolute `details` offset bound, so one page request is always finite. */
const MAX_DETAILS_OFFSET = 64 * 1024 * 1024;
/**
 * Index unit of `details`: `offset`, `nextOffset` and `total` all count UTF-16
 * code units of the exact view text, exactly like JavaScript string indices, so
 * consecutive pages concatenate back to that text without loss.
 */
const DETAILS_ENCODING = 'utf16-code-unit';
/**
 * Domain separator for the paging CONTENT identity. A durable revision alone
 * does not fence the serialized view: the publication journal latch/revision-
 * floor checkpoints and a failed publication retry persist a new
 * `publicationJournalEstablished`, `publicationJournalRevision`, `failure` or
 * `updatedAt` at the SAME revision, so two reads of one attempt revision can
 * serialize different JSON documents. A multi-page read must therefore name the
 * exact document it assembles, not only the revision it came from.
 */
const VIEW_CONTENT_DIGEST_DOMAIN = 'codex-subagent/integration-view-content/v1';
/** Deterministic identity of the EXACT serialized status-form view text. */
const viewContentDigest = (attemptId: string, text: string): string =>
  digest([VIEW_CONTENT_DIGEST_DOMAIN, attemptId, text]);
/** The bounded guard descriptor every page and summary reports. */
const viewContentGuard = (attemptId: string, revision: number, text: string): {
  kind: 'integration-view-content-digest';
  algorithm: 'sha256';
  covers: 'complete-status-view-json-text';
  attemptId: string;
  revision: number;
  chars: number;
  value: string;
} => ({
  kind: 'integration-view-content-digest',
  algorithm: 'sha256',
  covers: 'complete-status-view-json-text',
  attemptId,
  revision,
  chars: text.length,
  value: viewContentDigest(attemptId, text)
});
/**
 * The optional `publicationJournalRevision` floor at its widest persisted value:
 * 16 digits, the widest safe integer a publication journal revision may carry.
 * The whole field is reserved while a publication is still in flight, so a
 * per-file intent checkpoint can always widen it and the room kept for the
 * bounded terminal report and an explicit release is never spent on that growth.
 */
const MAX_JOURNAL_FLOOR_BYTES = Buffer.byteLength(`,"publicationJournalRevision":${Number.MAX_SAFE_INTEGER}`, 'utf8');
/** JSON bytes the persisted floor occupies right now; an absent field is free. */
const journalFloorBytes = (value: number | undefined): number =>
  value === undefined ? 0 : Buffer.byteLength(`,"publicationJournalRevision":${value}`, 'utf8');
/**
 * The exact prefix of EVERY open-editor refusal the publication port reports, at
 * preflight and at an effect boundary alike. Only such a reason can describe the
 * zero-effect preflight conflict a legacy record may plan a fresh journal from.
 */
const EDITOR_CONFLICT_PREFIX = 'open editor: ';

const NAMESPACE_TEXT = '{"schema":1,"kind":"integration-attempts"}';

/** The one coordinator action union, strict at every level. */
const id32 = z.string().regex(/^[a-f0-9]{32}$/, 'Expected a 32-hex id.');
const id64 = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a 64-hex id.');
const isoDate = z.string().datetime();
const ownerId = z.string().min(1).max(MAX_OWNER);
const teamId = id32.max(MAX_TEAM);
const requestId = z.string().min(1).max(MAX_REQUEST);
const uri = z.string().min(1).max(MAX_PATH);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const artifactSchema = z.strictObject({
  id: id64,
  version: z.number().int().positive(),
  uri
});
const evidenceRefSchema = z.strictObject({
  id: id32,
  version: z.number().int().positive(),
  uri
});
const sourceSchema = z.strictObject({
  taskId: id32,
  taskRevision: revision,
  artifact: artifactSchema,
  evidence: z.array(evidenceRefSchema).min(1).max(MAX_EVIDENCE)
});
const contractSelectionSchema = z.strictObject({
  taskId: id32,
  taskRevision: revision,
  ref: refSchema
});
const consumerSchema = z.strictObject({ taskId: id32, taskRevision: revision });

/**
 * Ordinary integration pins 1-8 immutable commands up front because they are the
 * only accepted proof for its candidate. A consumer begin is a dependency seed
 * that is never validated or published here, so it may omit them: its mandatory
 * per-source evidence remains the proof of what it consumed.
 */
const beginAction = z.strictObject({
  action: z.literal('begin'),
  ownerId,
  teamId,
  requestId,
  sources: z.array(sourceSchema).min(1).max(MAX_SOURCES),
  validationCommands: z.array(z.string().min(1).max(MAX_COMMAND)).max(MAX_COMMANDS).optional(),
  consumer: consumerSchema.optional(),
  contracts: z.array(contractSelectionSchema).max(MAX_CONTRACTS).optional()
}).superRefine((value, context) => {
  if (value.consumer !== undefined || (value.validationCommands?.length ?? 0) > 0) {
    return;
  }
  context.addIssue({
    code: 'custom',
    path: ['validationCommands'],
    message: 'Ordinary integration requires 1-8 immutable validation commands; only a consumer (dependency seed) begin may omit or empty them.'
  });
});
const statusAction = z.strictObject({
  action: z.literal('status'),
  ownerId,
  teamId,
  attemptId: id64.optional(),
  beginRequestId: requestId.optional()
});
/**
 * Read-only page of ONE attempt's COMPLETE status-form view text, for a reply the
 * bounded summary replaces. It mutates nothing, records no receipt and creates
 * no durable field: it re-reads the same durable record status reports and
 * returns the exact JSON text that status view serializes to, sliced at `offset`
 * for at most `limit` UTF-16 code units. `expectedRevision` is REQUIRED, so the
 * pages of two durable revisions can never be mixed. A revision is not enough
 * on its own - journal checkpoints and failed publication retries change the
 * serialized text at one revision - so a continuation page (`offset > 0`) also
 * requires `expectedContentDigest`, the exact content guard the first page
 * reported, and any change is refused before a page is returned.
 */
const detailsAction = z.strictObject({
  action: z.literal('details'),
  ownerId,
  teamId,
  attemptId: id64,
  expectedRevision: revision,
  /**
   * Content identity of the exact document being assembled. Required for every
   * continuation (`offset > 0`); an offset-0 read may omit it and then reports
   * the current value. A stale value fails with `content_changed` before any
   * page is returned, so pages of two documents are never concatenated.
   */
  expectedContentDigest: id64.optional(),
  offset: z.number().int().nonnegative().max(MAX_DETAILS_OFFSET).default(0),
  limit: z.number().int().min(1).max(MAX_DETAILS_LIMIT).default(DEFAULT_DETAILS_LIMIT)
});
const controls = {
  ownerId,
  teamId,
  attemptId: id64,
  expectedRevision: revision,
  requestId
};
const candidateAction = z.strictObject({
  action: z.literal('candidate'),
  ...controls,
  artifact: artifactSchema
});
const validateAction = z.strictObject({
  action: z.literal('validate'),
  ...controls,
  evidence: z.array(evidenceRefSchema).min(1).max(MAX_COMMANDS)
});
/**
 * Acceptance acknowledges the attempt's EXACT conflict path union in one of two
 * forms: the full `resolvedPaths` list, or the compact `resolvedPathsDigest` the
 * attempt view reports. Both decide the same thing and they are never combined.
 * A digest approval persists ONLY that verified digest: the exact union is
 * already this attempt's immutable conflict groups, so a second durable copy of
 * it proves nothing new and can push a legal wide union over the byte bound.
 */
const acceptAction = z.strictObject({
  action: z.literal('accept'),
  ...controls,
  resolvedPaths: z.array(z.string().min(1).max(MAX_PATH)).max(MAX_PATHS).default([]),
  resolvedPathsDigest: id64.optional()
});
const applyAction = z.strictObject({ action: z.literal('apply'), ...controls });
const releaseAction = z.strictObject({
  action: z.literal('release'),
  ...controls,
  abandon: z.literal(true),
  releaseRetention: z.literal(true)
});

export const integrationActionSchema = z.discriminatedUnion('action', [
  beginAction, statusAction, detailsAction, candidateAction, validateAction, acceptAction, applyAction, releaseAction
]);
export type IntegrationAction = z.infer<typeof integrationActionSchema>;

/**
 * One evidence item handed to the supplied pin port. `runner` refs are
 * structurally an artifact ref but carry the runner result id shape instead of
 * a 64-hex content id; the port owns that runtime check.
 */
export interface EvidenceCheck {
  ref: IntegrationArtifactRef;
  submission: SealedSubmission;
  command?: string;
}

/**
 * Host-supplied effects. Every method is owner/team scoped through
 * IntegrationScope, re-checks authorization at its own side effect, and is
 * idempotent for exact refs. The port, not this service, proves that a runner
 * result is succeeded, drained, import-free and (when given) for the exact
 * command.
 */
export interface IntegrationAttemptPorts {
  board(): Promise<TaskBoard>;
  session(id: string): Session | undefined;
  /**
   * Retain these exact artifacts and pin them before returning. When `verify` is
   * supplied the port MUST run it under the same view lock that publishes the
   * pins, AFTER its immutable seal proof and BEFORE any pin write, so a rejected
   * candidate can never leave a pin behind. The port still returns the exact
   * submissions it proved and pinned.
   */
  retainArtifacts(scope: IntegrationScope, refs: readonly IntegrationArtifactRef[], authorize: () => void, verify?: (submissions: readonly SealedSubmission[]) => void | Promise<void>): Promise<SealedSubmission[]>;
  /**
   * Compose this attempt's private derived seed. `verifyAncestry` is the ledger's
   * own resolution proof, and the port MUST run it under the same view lock,
   * BEFORE any composed write and BEFORE a durable seed is replayed, handing it
   * every CONFLICTED hop of the stored lineage together with the exact refs that
   * hop carried. The port fails closed when such an ancestry exists and no
   * verifier was supplied.
   */
  compose(scope: IntegrationScope, refs: readonly IntegrationArtifactRef[], authorize: () => void,
    verifyAncestry?: (chain: readonly IntegrationConflictHop[]) => void | Promise<void>): Promise<IntegrationComposition>;
  /**
   * Physical ancestry of these exact sealed sources: the ONE immutable snapshot
   * they are all sealed over plus the derived integration seeds below it,
   * leaf-to-root, with the root ordinary capture excluded. The port proves every
   * link against immutable storage in this exact scope; it never reads a live
   * workspace file and never returns an ancestor it cannot physically verify.
   */
  sourceAncestry(scope: IntegrationScope, refs: readonly IntegrationArtifactRef[], authorize: () => void): Promise<IntegrationSourceAncestry>;
  pinEvidence(scope: IntegrationScope, items: readonly EvidenceCheck[], authorize: () => void): Promise<void>;
  releasePins(scope: IntegrationScope, authorize: () => void): Promise<void>;
  /**
   * Publish the accepted candidate. `options` is the caller's recovery contract:
   * `requireJournal` (the latch below says a journal was established, so a
   * missing one is terminal), `onJournalReady` (awaited once a valid journal is
   * durable and BEFORE any workspace effect, which is where that latch is
   * persisted) and `recoveryOnly` (resolve durable state only; never start a
   * fresh journal or a new or pending workspace effect).
   */
  publish(scope: IntegrationScope, baseSnapshotId: string, ref: IntegrationArtifactRef, authorize: () => void, options: IntegrationPublicationOptions): Promise<{ state: 'applied' | 'conflict' | 'interrupted'; applied: string[]; conflicts: { path: string; reason: string }[] }>;
  withStorageWrite<T>(action: () => Promise<T>): Promise<T>;
}

// -- durable record schema ---------------------------------------------------

const producerSchema = z.strictObject({ workerId: id32, workerCreatedAt: isoDate });
const sealedSchema = z.strictObject({
  teamId,
  snapshotId: id64,
  overlayId: id64,
  id: id64,
  version: z.number().int().positive(),
  uri,
  workerId: id32,
  workerCreatedAt: isoDate,
  ownerId,
  head: z.string().max(200).nullable(),
  revision: z.number().int().nonnegative(),
  released: z.boolean(),
  createdAt: isoDate
});
const requirementSchema = z.strictObject({
  taskId: id32,
  taskRevision: revision,
  title: z.string().min(1).max(MAX_TITLE),
  /** Exact board description; the worker brief carries the agreed requirements. */
  description: z.string().max(MAX_DESCRIPTION),
  state: z.string().min(1).max(32),
  acceptanceCriteria: z.array(z.string().min(1).max(MAX_CRITERION)).max(MAX_CRITERIA),
  artifact: artifactSchema,
  evidence: z.array(evidenceRefSchema).min(1).max(MAX_EVIDENCE),
  producer: producerSchema
});
const consumerRequirementSchema = z.strictObject({
  taskId: id32,
  taskRevision: revision,
  title: z.string().min(1).max(MAX_TITLE),
  description: z.string().max(MAX_DESCRIPTION),
  state: z.string().min(1).max(32),
  acceptanceCriteria: z.array(z.string().min(1).max(MAX_CRITERION)).max(MAX_CRITERIA)
});
/**
 * One omitted artifact edge this begin proved already embedded in the immutable
 * source base. It records the dependency task at its CURRENT board revision, the
 * exact older durable attempt and derived seed that physically carried the
 * artifact, and that attempt's own retained requirement as the evidence source.
 * Nothing here is inferred: every field is the witnessed exact identity.
 */
const inheritedWitnessSchema = z.strictObject({
  taskId: id32,
  taskRevision: revision,
  attemptId: id64,
  snapshotId: id64,
  artifact: artifactSchema,
  requirement: requirementSchema,
  /**
   * Additive exact resolution artifact: the seal that resolved this ancestor's
   * unresolved conflict groups, proved against the durable accepted attempt that
   * composed it. Absent for every conflict-free ancestor, so existing durable
   * records stay valid and nothing is inferred.
   */
  resolution: artifactSchema.optional()
});
const contractCaptureSchema = z.strictObject({
  taskId: id32,
  taskRevision: revision,
  ref: refSchema
});
const pathSchema = z.string().min(1).max(MAX_PATH);
/** The recorded publication report keeps the port's full supported path width. */
const resultPathSchema = z.string().min(1).max(MAX_RESULT_PATH);
/** One merge conflict group: every implicated path plus the inputs that collided. */
const conflictGroupSchema = z.strictObject({
  paths: z.array(pathSchema).min(1).max(MAX_PATHS),
  inputIds: z.array(z.string().min(1).max(MAX_PATH)).max(MAX_SOURCES),
  reason: z.string().min(1).max(MAX_REASON)
});
/** One path-level publication conflict reported by the publication port. */
const applyConflictSchema = z.strictObject({ path: resultPathSchema, reason: z.string().min(1).max(MAX_REASON) });
const dependencySchema = z.strictObject({ taskId: id32, kind: z.enum(['contract', 'artifact']) });
/** Bound on the physically verified ancestor chain one begin may consult. */
const MAX_ANCESTORS = 64;
/**
 * The ancestry port answer, validated before it is trusted: one immediate source
 * snapshot and the derived seeds below it, leaf-to-root, each with the readable
 * provenance a durable attempt can be matched against.
 */
const ancestrySchema = z.strictObject({
  sourceSnapshotId: id64,
  ancestors: z.array(z.strictObject({
    snapshotId: id64,
    provenance: z.strictObject({
      kind: z.literal('integration-seed'),
      attemptId: id64,
      baseSnapshotId: id64,
      refs: z.array(artifactSchema).max(MAX_SOURCES),
      conflicts: z.array(conflictGroupSchema).max(MAX_CONFLICTS)
    })
  })).max(MAX_ANCESTORS)
});
/**
 * One CONFLICTED ancestry hop the composition port proves before it composes
 * anything: the derived seed with unresolved own conflict groups, its exact
 * stored provenance and the exact refs that hop carried. It is validated before a
 * single durable decision rests on it.
 */
const conflictHopSchema = z.strictObject({
  snapshotId: id64,
  provenance: z.strictObject({
    kind: z.literal('integration-seed'),
    attemptId: id64,
    baseSnapshotId: id64,
    refs: z.array(artifactSchema).min(1).max(MAX_SOURCES),
    conflicts: z.array(conflictGroupSchema).min(1).max(MAX_CONFLICTS)
  }),
  refs: z.array(artifactSchema).max(MAX_SOURCES)
});
const requestRecordSchema = z.strictObject({
  action: z.enum(['candidate', 'validate', 'accept', 'apply', 'release']),
  requestId,
  fingerprint: id64
});
const submissionRecordSchema = z.strictObject({ taskId: id32, submission: sealedSchema });
const candidateRecordSchema = z.strictObject({
  artifact: artifactSchema,
  submission: sealedSchema,
  lane: z.enum(['integration', 'validation']),
  requestId,
  at: isoDate
});
const validationRecordSchema = z.strictObject({ command: z.string().min(1).max(MAX_COMMAND), result: evidenceRefSchema, at: isoDate });
/**
 * One durable acceptance. A legacy record stores the full exact path union; a
 * digest approval stores ONLY the digest it verified, because its exact paths are
 * already this attempt's immutable `conflicts` groups and a second durable copy of
 * that union doubles the record's largest field for no new proof.
 */
const listedAcceptanceSchema = z.strictObject({ resolvedPaths: z.array(pathSchema).max(MAX_PATHS), requestId, at: isoDate });
const digestAcceptanceSchema = z.strictObject({ resolvedPathsDigest: id64, requestId, at: isoDate });
const acceptanceRecordSchema = z.union([listedAcceptanceSchema, digestAcceptanceSchema]);
const applyRecordSchema = z.strictObject({
  state: z.enum(['applying', 'applied', 'conflict', 'interrupted']),
  requestId,
  applied: z.array(resultPathSchema).max(MAX_PATHS),
  /**
   * Exact totals and truncation of a bounded preview. Both stay absent while the
   * recorded report is the complete result, so existing ledgers remain valid.
   */
  appliedCount: z.number().int().nonnegative().optional(),
  conflictCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  conflicts: z.array(applyConflictSchema).max(MAX_CONFLICTS),
  at: isoDate
});

const attemptSchema = z.strictObject({
  schema: z.literal(1),
  id: id64,
  ownerId,
  teamId,
  beginRequestId: requestId,
  fingerprint: id64,
  revision,
  status: z.enum(['intent', 'failed', 'ready', 'candidate', 'validated', 'accepted', 'applying', 'applied', 'interrupted', 'releasing', 'released', 'abandoned']),
  createdAt: isoDate,
  updatedAt: isoDate,
  dependencyOnly: z.boolean(),
  seedOnly: z.boolean(),
  requirements: z.strictObject({
    sources: z.array(requirementSchema).min(1).max(MAX_SOURCES),
    consumer: consumerRequirementSchema.optional()
  }),
  dependencies: z.array(dependencySchema).max(MAX_DEPENDENCIES),
  /** Empty only for a consumer seed, which can never be validated or published. */
  validationCommands: z.array(z.string().min(1).max(MAX_COMMAND)).max(MAX_COMMANDS),
  contracts: z.array(contractCaptureSchema).max(MAX_CONTRACTS),
  conflicts: z.array(conflictGroupSchema).max(MAX_CONFLICTS),
  /** Derived private seed the candidate must be sealed over; never published directly. */
  derivedSnapshotId: id64.optional(),
  /**
   * IMMEDIATE base the seed was composed over: the base every explicitly selected
   * source was sealed on, and the only base composition and this module's own
   * ancestry proof are held to. The publication host resolves the lineage and
   * publishes against its verified oldest captured ancestor, so this id is never
   * assumed to be that ordinary capture.
   */
  baseSnapshotId: id64.optional(),
  /**
   * Additive proof of omitted artifact edges this begin inherited instead of
   * consuming again, plus the immutable immediate source snapshot it was proved
   * against. Absent for every attempt that selected all of its dependencies. The
   * cap follows the board's dependency cap: these are witnessed EDGES, not
   * explicitly selected sources.
   */
  inherited: z.array(inheritedWitnessSchema).max(MAX_DEPENDENCIES).optional(),
  sourceSnapshotId: id64.optional(),
  /**
   * Additive durable proof that this attempt's immutable base lineage was
   * verified against this store's exact accepted resolutions. It is set by
   * every successful verified composition, and by a later reload re-proof, so
   * an old ledger stays readable and a new record never repeats the scan.
   * Absent means UNPROVED: the record predates this proof (or its composition
   * never completed), so no candidate, validation, acceptance or fresh
   * publication may be created until the exact retained sources and conflict
   * hops are re-proved from the source ancestry port.
   */
  ancestryVerified: z.boolean().optional(),
  pinState: z.enum(['none', 'artifacts', 'evidence']),
  evidencePinned: z.boolean(),
  producerSubmissions: z.array(submissionRecordSchema).max(MAX_SOURCES),
  candidate: candidateRecordSchema.optional(),
  validations: z.array(validationRecordSchema).max(MAX_COMMANDS),
  acceptance: acceptanceRecordSchema.optional(),
  apply: applyRecordSchema.optional(),
  /**
   * Durable latch written BEFORE any workspace effect was allowed to start: a
   * journal was durably written (or loaded) for this attempt. `false` proves no
   * effect can have started, so a missing journal may still be replanned; `true`
   * requires the journal and makes a missing one terminal. An absent field is a
   * legacy record and is UNCERTAIN, so its journal is required too.
   */
  publicationJournalEstablished: z.boolean().optional(),
  /**
   * Highest publication journal revision this attempt is proved to have reached:
   * the monotonic floor persisted by the awaited `onJournalIntent` per-file
   * intent checkpoint. It is never lowered and never removed, so a journal older
   * than a revision this ledger already observed is stale and must fail closed at
   * the publication port. Absent for every record that never reached a per-file
   * intent, so previously written ledgers stay valid.
   */
  publicationJournalRevision: revision.optional(),
  requests: z.array(requestRecordSchema).max(MAX_REQUESTS),
  failure: z.strictObject({ code: z.string().min(1).max(100), message: z.string().min(1).max(2000), at: isoDate }).optional()
});
const dataSchema = z.strictObject({ schema: z.literal(1), attempts: z.array(attemptSchema).max(MAX_ATTEMPTS) });

type Attempt = z.infer<typeof attemptSchema>;
type Data = z.infer<typeof dataSchema>;
type ConflictGroup = z.infer<typeof conflictGroupSchema>;
type SourceRequirement = Attempt['requirements']['sources'][number];
type InheritedWitness = z.infer<typeof inheritedWitnessSchema>;
type Ancestry = z.infer<typeof ancestrySchema>;

const canonical = (value: unknown): unknown => {
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
};

/** Stable error for malformed wire input, matching the board tool adapters. */
function parseAction(input: unknown): IntegrationAction {
  try {
    return integrationActionSchema.parse(input ?? {});
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new WorkerError('invalid_arguments', z.prettifyError(error));
    }
    throw error;
  }
}

/**
 * The composition port returns the stored derived seed snapshot, the immediate
 * base it was composed over and its merge conflict groups. The seed id is what a
 * candidate worker binds to and seals over; the base id is the immediate base a
 * publication decision names, which the publication host resolves to its
 * verified oldest captured ancestor before any workspace effect.
 */
function compositionSeed(composition: IntegrationComposition): {
  derivedSnapshotId: string;
  baseSnapshotId: string;
  conflicts: ConflictGroup[];
} {
  const derived = (composition.snapshot as { id?: unknown }).id;
  if (typeof derived !== 'string' || !/^[a-f0-9]{64}$/.test(derived)) {
    throw new WorkerError('composition_invalid', 'The composition port did not return a 64-hex derived seed snapshot id.');
  }
  const base = composition.baseSnapshotId;
  if (typeof base !== 'string' || !/^[a-f0-9]{64}$/.test(base)) {
    throw new WorkerError('composition_invalid', 'The composition port did not return the original 64-hex base snapshot id.');
  }
  let conflicts: ConflictGroup[];
  try {
    conflicts = z.array(conflictGroupSchema).max(MAX_CONFLICTS).parse([...composition.conflicts]);
  } catch {
    throw new WorkerError('composition_invalid', 'The composition port returned malformed conflict groups.');
  }
  return { derivedSnapshotId: derived, baseSnapshotId: base, conflicts };
}

/** Exact, deduplicated and sorted union of every conflict path. */
function conflictPaths(conflicts: readonly ConflictGroup[]): string[] {
  return sortedUnique(conflicts.flatMap(group => group.paths));
}

/**
 * Domain separator for the compact acceptance acknowledgment. The digest is
 * public response data, so its exact preimage is part of the contract: this
 * separator, the exact attempt id and the canonical (sorted, unique) conflict
 * path array, hashed with the existing digest helper.
 */
const CONFLICT_PATHS_DIGEST_DOMAIN = 'codex-subagent/integration-conflict-paths/v1';

/**
 * Deterministic digest of exactly ONE attempt's conflict path union. It names
 * nothing else - not the owner, team, revision or candidate - so a coordinator
 * acknowledges the exact set the view reported, and a changed set never matches.
 */
function conflictPathsDigest(attemptId: string, conflicts: readonly ConflictGroup[]): string {
  return digest([CONFLICT_PATHS_DIGEST_DOMAIN, attemptId, conflictPaths(conflicts)]);
}

/**
 * The exact conflict paths ONE durable acceptance proves, or null when a
 * digest-shaped record no longer reproduces this attempt's own sort-unique
 * conflict union (a corrupt record, never an approval). A legacy list record is
 * its own proof; a digest approval derives the SAME immutable union that digest
 * was verified against, so the full exact list stays readable without a second
 * durable copy of it.
 */
function storedAcceptancePaths(attempt: Attempt): string[] | null {
  const acceptance = attempt.acceptance;
  if (acceptance === undefined) {
    return null;
  }
  if ('resolvedPaths' in acceptance) {
    return acceptance.resolvedPaths;
  }
  return acceptance.resolvedPathsDigest === conflictPathsDigest(attempt.id, attempt.conflicts)
    ? conflictPaths(attempt.conflicts)
    : null;
}

/**
 * The exact paths an acceptance PROVES. Lineage proofs and fresh publication
 * decisions both rest on it, so a digest that no longer reproduces this attempt's
 * conflict union fails closed instead of being read as an approval.
 */
function acceptancePaths(attempt: Attempt): string[] {
  const paths = storedAcceptancePaths(attempt);
  if (paths === null) {
    throw new WorkerError('integration_corrupt', `The durable acceptance of integration attempt ${attempt.id} no longer proves its exact conflict path union, so it is not an approval; nothing was decided. Restore that record or begin a new attempt.`);
  }
  return paths;
}

/**
 * Whether a FRESH publication may start: an accepted, non-seed attempt whose
 * durable acceptance still proves its exact conflict union. A corrupt or absent
 * proof is advertised exactly as it is - not publishable - in every view, so an
 * acknowledgment never offers a decision the next call would refuse.
 */
function canPublish(attempt: Attempt): boolean {
  return !attempt.seedOnly && attempt.status === 'accepted' && storedAcceptancePaths(attempt) !== null;
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
const samePaths = (left: readonly string[], right: readonly string[]): boolean => {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
};
const sameRef = (a: { id: string; version: number; uri: string }, b: { id: string; version: number; uri: string }): boolean =>
  a.id === b.id && a.version === b.version && a.uri === b.uri;

/**
 * One publication result, exactly as the port reported it. Applied paths keep
 * their strict supported width. A diagnostic conflict path or reason is only
 * shape-checked here and bounded in the durable preview, because the plan may
 * echo long paths and reasons after the publication has already started.
 */
type PublishResult = Awaited<ReturnType<IntegrationAttemptPorts['publish']>>;
const publishResultSchema = z.strictObject({
  state: z.enum(['applied', 'conflict', 'interrupted']),
  applied: z.array(z.string().min(1).max(MAX_RESULT_PATH)).max(MAX_RESULT_ITEMS),
  conflicts: z.array(z.strictObject({
    path: z.string().min(1),
    reason: z.string().min(1)
  })).max(MAX_RESULT_ITEMS)
});

/**
 * Fail closed: a malformed publication result is never written into the ledger.
 * The durable applying intent stays authoritative, so the exact replay can still
 * prove the journal state instead of inventing an outcome from bad state.
 */
function parsePublishResult(value: unknown): PublishResult {
  const parsed = publishResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkerError('publish_invalid', `The publication port returned a malformed result and no report was recorded: ${z.prettifyError(parsed.error).slice(0, 1500)}`);
  }
  return parsed.data;
}

/** The bounded part of one terminal report plus the exact totals it was cut from. */
type ApplyReport = {
  applied: string[];
  conflicts: { path: string; reason: string }[];
  appliedCount?: number;
  conflictCount?: number;
  truncated?: boolean;
};

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
/**
 * Exact character count the bridge relays for one ToolResult whose single
 * content item carries `text` - the envelope viewResponse builds - so the
 * response budget is measured on the FULLY serialized reply, never on raw
 * metadata.
 */
const responseChars = (text: string): number =>
  JSON.stringify({ content: [{ type: 'text', text }] }).length;
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Bound one terminal report to what the ledger always holds: short results stay
 * exactly as reported, wide paths keep their full supported width, and long
 * reasons, long item lists or large reports become a prefix whose exact totals
 * and truncation stay explicit. Per-file recovery evidence belongs to the
 * publication journal, never to this preview.
 */
function boundedApplyReport(result: PublishResult): ApplyReport {
  const applied: string[] = [];
  const conflicts: ApplyReport['conflicts'] = [];
  let truncated = false;
  let bytes = 2; // The empty array literal.
  for (const appliedPath of result.applied) {
    const size = jsonBytes(appliedPath) + (applied.length > 0 ? 1 : 0);
    if (applied.length >= MAX_APPLY_PATHS || bytes + size > MAX_APPLY_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    applied.push(appliedPath);
  }
  for (const conflict of result.conflicts) {
    // A diagnostic path or reason may echo far more than the ledger keeps; the
    // preview stores its bounded prefix and records the exact totals below.
    const conflictPath = conflict.path.slice(0, MAX_RESULT_PATH);
    const conflictReason = conflict.reason.slice(0, MAX_REASON);
    if (conflictPath !== conflict.path) {
      truncated = true;
    }
    if (conflictReason !== conflict.reason) {
      truncated = true;
    }
    const size = jsonBytes({ path: conflictPath, reason: conflictReason }) + (conflicts.length > 0 ? 1 : 0);
    if (conflicts.length >= MAX_APPLY_CONFLICTS || bytes + size > MAX_APPLY_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    conflicts.push({ path: conflictPath, reason: conflictReason });
  }
  if (applied.length !== result.applied.length || conflicts.length !== result.conflicts.length) {
    truncated = true;
  }
  return truncated
    ? { applied, conflicts, appliedCount: result.applied.length, conflictCount: result.conflicts.length, truncated: true }
    : { applied, conflicts };
}

/**
 * Bytes the projected ledger must keep free for effects that are already durable
 * or still possible: the bounded terminal report of every still-applying
 * publication and one explicit release for every attempt that has not recorded
 * one. Every durable mutation measures this on its own projection, so an
 * unrelated begin, candidate, validate or release save can never spend room an
 * in-flight publication still needs.
 */
function reservedBytes(data: Data): number {
  let bytes = 0;
  for (const entry of data.attempts) {
    if (entry.apply?.state === 'applying' || entry.status === 'applying') {
      bytes += MAX_APPLY_BYTES + MAX_APPLY_META_BYTES;
      // The floor may still widen to its widest value before this publication
      // records its terminal report. That remaining growth is reserved here and
      // is spent only by the checkpoint that applies it, so the reservation
      // shrinks by exactly the bytes a checkpoint already wrote and a checkpoint
      // stays writable near the ledger cap without eating the report's room.
      bytes += MAX_JOURNAL_FLOOR_BYTES - journalFloorBytes(entry.publicationJournalRevision);
    }
    if (!entry.requests.some(request => request.action === 'release')) {
      bytes += RELEASE_BYTES;
    }
  }
  return bytes;
}

/**
 * The narrow legacy migration: a record written before the latch existed may
 * plan a FRESH journal again only when its completed publication result proves
 * that no journal and no workspace effect can exist. That is exactly the
 * open-editor preflight conflict the publication port reports before its first
 * durable journal revision: no applied path and no applied count, the COMPLETE
 * (non-truncated) conflict list, every reason an open-editor refusal, one single
 * apply receipt for this result and no ambiguous failure or in-flight
 * checkpoint.
 *
 * Everything else keeps requiring its existing journal: a legacy record that is
 * applying, partial, interrupted, truncated, corrupt or otherwise uncertain may
 * already have started an effect, and an arbitrary zero-count journal error is
 * never treated as safe.
 */
function legacyZeroEffect(attempt: Attempt): boolean {
  const apply = attempt.apply;
  if (apply === undefined || apply.state !== 'conflict' || attempt.status !== 'accepted' || attempt.failure !== undefined) {
    return false;
  }
  if (apply.applied.length > 0 || (apply.appliedCount ?? 0) > 0) {
    return false;
  }
  if (apply.truncated === true || apply.conflicts.length === 0) {
    return false;
  }
  if ((apply.conflictCount ?? apply.conflicts.length) !== apply.conflicts.length) {
    return false;
  }
  if (!apply.conflicts.every(conflict => conflict.reason.startsWith(EDITOR_CONFLICT_PREFIX))) {
    return false;
  }
  const applies = attempt.requests.filter(request => request.action === 'apply');
  return applies.length === 1 && applies[0].requestId === apply.requestId;
}

/** One service instance per root/owner host; all state is serialized and durable. */
export class IntegrationAttempts {
  /**
   * Proves a STORED attempt's immutable base lineage before any NEW decision,
   * when its durable record predates (or never reached) a successful verified
   * composition. Only begin reaches the compose port, so a reloaded record that
   * was written by an older store - or whose composition never completed - could
   * otherwise reach a candidate, validation, acceptance or publication without
   * ever proving its conflicted ancestry.
   *
   * The exact selected sources must still be the exact retained seals of this
   * scope, the port's immediate source snapshot must BE this attempt's stored
   * base, and every conflicted hop of that base's lineage must be consumed by
   * its exact accepted resolution seal - the same proof the compose port runs.
   *
   * A successful scan is recorded on the caller's draft as `ancestryVerified`,
   * so the decision that follows persists it and no later call repeats this
   * read. Nothing here pins, composes or writes: an unproved record simply
   * cannot enter a candidate, validation, acceptance or fresh publication, and
   * a failed scan leaves the durable record untouched. `record` may be `false`
   * for the ONE caller that must not grow its record's footprint: an
   * already-applying publication holds a durable reservation, so a new field's
   * bytes at a before-effect journal checkpoint could make that checkpoint
   * unwritable. Such a caller proves on a COPY and leaves its own record
   * byte-identical.
   */
  private async requireAncestryProof(attempt: Attempt, authorize: () => void, record = true): Promise<void> {
    if (attempt.ancestryVerified === true) {
      return;
    }
    if (attempt.derivedSnapshotId === undefined || attempt.baseSnapshotId === undefined) {
      throw new WorkerError('ancestry_unproved', 'This stored attempt has no exact retained derived seed and base, so its lineage cannot be re-proved. Release it and begin a new attempt.');
    }
    const sources = attempt.requirements.sources;
    const refs = sources.map(source => ({ ...source.artifact }));
    // The proof is only as good as the seals it rechecks: exactly one retained
    // submission per selected source, in this scope, of exactly that artifact.
    if (attempt.producerSubmissions.length !== sources.length
      || attempt.producerSubmissions.some((record, index) => record.taskId !== sources[index].taskId
        || !sameRef(record.submission, sources[index].artifact)
        || record.submission.ownerId !== attempt.ownerId
        || record.submission.teamId !== attempt.teamId)) {
      throw new WorkerError('ancestry_unproved', 'This stored attempt has no exact retained seal for every selected source, so its lineage cannot be re-proved. Release it and begin a new attempt.');
    }
    if (attempt.sourceSnapshotId !== undefined
      && attempt.producerSubmissions.some(record => record.submission.snapshotId !== attempt.sourceSnapshotId)) {
      throw new WorkerError('ancestry_mismatch', 'The retained sources are not all sealed over the immutable source snapshot this attempt recorded; nothing was decided.');
    }
    let ancestry: IntegrationSourceAncestry;
    try {
      ancestry = await this.ports.sourceAncestry(this.scope(attempt), refs, authorize);
    } catch (error) {
      if (error instanceof WorkerError) {
        throw error;
      }
      throw new WorkerError('ancestry_unavailable', `The source ancestry port could not prove the lineage of these exact retained sources: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = ancestrySchema.safeParse(ancestry);
    if (!parsed.success) {
      throw new WorkerError('ancestry_invalid', `The source ancestry port returned a malformed chain, so this attempt stays unproved: ${z.prettifyError(parsed.error).slice(0, 1500)}`);
    }
    // The port's ONE immediate source snapshot must be the exact base this
    // attempt composed over; a drift between the durable record and the physical
    // lineage proves nothing and no decision may rest on it.
    if (parsed.data.sourceSnapshotId !== attempt.baseSnapshotId) {
      throw new WorkerError('ancestry_mismatch', `The source ancestry port proved base ${parsed.data.sourceSnapshotId}, not this attempt's stored base ${attempt.baseSnapshotId}; nothing was decided.`);
    }
    // A NONEMPTY answer is one physically connected lineage: it must begin at
    // exactly this attempt's base, and every adjacent link must follow the
    // previous record's own base. An empty chain (a clean capture) is valid.
    parsed.data.ancestors.forEach((ancestor, index) => {
      const expected = index === 0
        ? parsed.data.sourceSnapshotId
        : parsed.data.ancestors[index - 1].provenance.baseSnapshotId;
      if (ancestor.snapshotId !== expected) {
        throw new WorkerError('ancestry_mismatch', index === 0
          ? `The reported ancestry begins at snapshot ${ancestor.snapshotId}, not this attempt's base ${parsed.data.sourceSnapshotId}; nothing was decided.`
          : `Snapshot ${parsed.data.ancestors[index - 1].snapshotId} records base ${expected}, but the reported chain continues at ${ancestor.snapshotId}; nothing was decided.`);
      }
    });
    const chain: IntegrationConflictHop[] = [];
    parsed.data.ancestors.forEach((ancestor, index) => {
      if (ancestor.provenance.conflicts.length === 0) {
        return;
      }
      // The exact refs each conflicted hop CARRIED: this attempt's own exact
      // selection for the immediate base, its child seed's stored refs deeper.
      const carried = index === 0 ? refs : parsed.data.ancestors[index - 1].provenance.refs;
      chain.push({ snapshotId: ancestor.snapshotId, provenance: ancestor.provenance, refs: carried.map(ref => ({ ...ref })) });
    });
    this.verifyResolvedAncestry(this.scope(attempt), chain);
    // Durable marker only: the caller's own decision persists it with its save,
    // unless it proved on a COPY to keep an applying footprint byte-identical.
    if (record) {
      attempt.ancestryVerified = true;
    }
  }

  private readonly file: string;
  private readonly namespaceFile: string;
  private readonly mutex = new Mutex();
  private readonly withStorageWrite: <T>(action: () => Promise<T>) => Promise<T>;
  private data?: Data;
  /**
   * ONE details read of a valid ledger whose namespace marker is not durable yet.
   * It is served from this transient snapshot, so the read publishes no marker and
   * never caches the record as fully opened for a later mutation.
   */
  private transient?: Data;
  private opening?: Promise<void>;
  private closing = false;

  /**
   * `workspaceRoot` is the optional host ROUTING identity of this store, wired by
   * the host when one process owns several roots. It is used for exactly one
   * field - `summary.details.workspaceRoot` - so it never enters the raw status
   * view, that view's content digest or the strict details arguments the ledger
   * parses. A direct ledger harness without a root is unchanged.
   */
  constructor(readonly directory: string, private readonly ports: IntegrationAttemptPorts, private readonly workspaceRoot?: string) {
    this.file = path.join(directory, 'integration-attempts.json');
    this.namespaceFile = path.join(directory, 'integration-attempts.namespace.json');
    this.withStorageWrite = ports.withStorageWrite;
  }

  /** Reject new and queued mutations and drain the in-flight one. */
  async close(): Promise<void> {
    this.closing = true;
    await this.mutex.run(() => Promise.resolve());
  }

  /**
   * `recoveryError` is passed by the host ONLY after admission was denied
   * (`storage_exhausted`) before this action entered. It permits exactly one
   * thing - the exact CURRENT applying receipt resolving its own journal in
   * proof-only mode - and every other call rethrows that original error before
   * any publication intent or receipt is written.
   */
  async invoke(args: IntegrationAction, authorize: () => void, recoveryError?: WorkerError): Promise<unknown> {
    const action = parseAction(args);
    return this.mutex.run(async () => {
      if (this.closing) {
        throw new WorkerError('integration_closed', 'Integration attempts are closing; new and queued calls are rejected.');
      }
      authorize();
      if (recoveryError !== undefined) {
        // Shape only, before the store is read at all.
        this.requireRecoveryShape(action, recoveryError);
      }
      // The denial travels INTO the loader, so the proof-only decision and the
      // marker it rests on come from ONE read that no second probe can drift from.
      // A read-only `details` page never ESTABLISHES a store: it may not create an
      // empty ledger and may not publish a namespace marker.
      await this.open(recoveryError, action.action !== 'details');
      try {
        authorize();
        if (recoveryError !== undefined) {
          return this.recover(action, authorize, recoveryError);
        }
        switch (action.action) {
          case 'begin': return this.begin(action, authorize);
          case 'status': return this.status(action);
          case 'details': return this.details(action);
          case 'candidate': return this.candidate(action, authorize);
          case 'validate': return this.validate(action, authorize);
          case 'accept': return this.accept(action, authorize);
          case 'apply': return this.apply(action, authorize);
          case 'release': return this.release(action, authorize);
        }
      } finally {
        if (action.action === 'details') {
          // A read-only page holds its unmarked-ledger snapshot for exactly ONE
          // reply: a failed authorization or a view error after the load drops it
          // too, so an unestablished ledger is never held indefinitely and never
          // becomes the open store a later mutation writes through.
          this.transient = undefined;
        }
      }
    });
  }

  // -- storage --------------------------------------------------------------

  /**
   * Opens the store once per instance. A `recoveryError` marks a DENIED,
   * proof-only call: it travels into the loader, whose single marker read decides
   * the original denial, and such a rejection is never cached, so a later
   * normally-admitted call can still load - or bootstrap - this store.
   */
  private async open(recoveryError?: WorkerError, bootstrap = true): Promise<void> {
    if (this.data) {
      return;
    }
    if (this.opening === undefined) {
      const opening = this.load(recoveryError, bootstrap);
      this.opening = opening;
      if (recoveryError !== undefined || !bootstrap) {
        // A DENIED proof-only load and a read that may not establish the store are
        // never cached: only a normal load leaves the store open, so a later
        // mutation still reloads, bootstraps or publishes the marker.
        const forget = (): void => {
          if (this.opening === opening) {
            this.opening = undefined;
          }
        };
        opening.then(
          () => {
            if (this.data === undefined) {
              forget();
            }
          },
          forget
        );
      }
      // The LOCAL promise is awaited, so clearing the cache can never swallow
      // the rejection this call must observe.
      await opening;
      return;
    }
    await this.opening;
  }

  /**
   * Fail closed: an established namespace marker with missing/corrupt data is
   * never reset. The empty ledger is published before its marker, so a crash can
   * only leave an unmarked valid ledger that safely gains its marker.
   *
   * This is the ONE marker read of a load, and a proof-only load (`recoveryError`)
   * creates neither file: an absent marker IS that original admission denial, and
   * a marker observed present means a missing ledger fails closed below instead of
   * being recreated. Bootstrap therefore stays exclusive to a normally-admitted
   * load of an uninitialized store.
   *
   * `bootstrap` is false for the read-only `details` page, which must never
   * initialize an empty ledger and must never publish a namespace marker: an
   * uninitialized store simply has no such attempt, and a VALID unmarked ledger is
   * served once from a transient snapshot that is not cached as the open store.
   */
  private async load(recoveryError?: WorkerError, bootstrap = true): Promise<void> {
    const marker = await this.readMarker();
    if (!marker && recoveryError !== undefined) {
      // DENIED admission plus no durable namespace: there is nothing to resolve
      // and nothing may be initialized, so the original denial stands.
      throw recoveryError;
    }
    let text: string;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DATA_BYTES) {
        throw new WorkerError('integration_corrupt', `Restore the plain integration attempt ledger ${this.file}; its identity is unsafe.`);
      }
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error instanceof WorkerError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new WorkerError('integration_corrupt', `Restore ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (marker) {
        throw new WorkerError('integration_corrupt', `Restore missing ${this.file}; its established namespace cannot be reset.`);
      }
      if (!bootstrap) {
        // A read-only page of an uninitialized store: nothing durable can hold
        // this attempt, and neither an empty ledger nor a marker may be created to
        // answer a read.
        throw new WorkerError('attempt_missing', 'No integration attempt with that id exists for this coordinator and team.');
      }
      const empty: Data = { schema: 1, attempts: [] };
      await this.withStorageWrite(() => atomicWrite(this.file, JSON.stringify(empty)));
      await this.withStorageWrite(() => atomicWrite(this.namespaceFile, NAMESPACE_TEXT));
      this.data = empty;
      return;
    }
    let parsed: Data;
    try {
      parsed = dataSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new WorkerError('integration_corrupt', `Restore ${this.file}; it is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!marker) {
      if (!bootstrap) {
        // A VALID ledger whose namespace marker never became durable: serve this
        // ONE read from the record as it is, publish nothing and cache nothing, so
        // the store stays unestablished for every later mutation - a normal load
        // publishes the marker exactly as this read would have.
        this.transient = parsed;
        return;
      }
      await this.withStorageWrite(() => atomicWrite(this.namespaceFile, NAMESPACE_TEXT));
    }
    this.transient = undefined;
    this.data = parsed;
  }

  private async readMarker(): Promise<boolean> {
    try {
      const stat = await fs.lstat(this.namespaceFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) {
        throw new WorkerError('integration_corrupt', `Restore the plain integration namespace marker ${this.namespaceFile}.`);
      }
      if (await fs.readFile(this.namespaceFile, 'utf8') !== NAMESPACE_TEXT) {
        throw new WorkerError('integration_corrupt', `Restore ${this.namespaceFile}; its identity changed.`);
      }
      return true;
    } catch (error) {
      if (error instanceof WorkerError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw new WorkerError('integration_corrupt', `Cannot inspect ${this.namespaceFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private requireData(): Data {
    const data = this.data ?? this.transient;
    if (!data) {
      throw new WorkerError('integration_closed', 'Integration attempts are not open.');
    }
    return data;
  }

  private async save(attempt: Attempt, authorize: () => void): Promise<void> {
    authorize();
    const { text, parsed } = this.project(attempt);
    await this.withStorageWrite(async () => {
      authorize();
      await atomicWrite(this.file, text, 0o600, authorize);
    });
    this.data = parsed;
  }

  /**
   * Capacity-only preflight of the exact record a decision WOULD write. It is
   * deliberately not a durable mutation: a caller refuses before its port pins
   * anything, so a record that cannot fit never leaks pins.
   */
  private preflight(attempt: Attempt): void {
    this.project(attempt);
  }

  /**
   * The exact ledger text one mutation of `attempt` would produce, refused when
   * it breaks any durable bound: the attempt cap, the metadata schema, the byte
   * bound, and the room an in-flight report and an explicit release still need.
   */
  private project(attempt: Attempt): { text: string; parsed: Data } {
    const data = this.requireData();
    const index = data.attempts.findIndex(entry => entry.id === attempt.id);
    if (index === -1 && data.attempts.length >= MAX_ATTEMPTS) {
      throw new WorkerError('capacity_exceeded', `At most ${MAX_ATTEMPTS} integration attempts are retained in this store. Release frees an attempt of its pins and evidence but keeps its durable record, so only archiving this store reclaims the lifetime cap.`);
    }
    const attempts = [...data.attempts];
    if (index === -1) {
      attempts.push(attempt);
    } else {
      attempts[index] = attempt;
    }
    let parsed: Data;
    try {
      parsed = dataSchema.parse({ schema: 1, attempts });
    } catch (error) {
      throw new WorkerError('capacity_exceeded', `Integration attempt metadata exceeds its schema bounds: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = JSON.stringify(parsed);
    const size = Buffer.byteLength(text, 'utf8');
    if (size > MAX_DATA_BYTES) {
      throw new WorkerError('capacity_exceeded', `Integration attempt metadata exceeds ${MAX_DATA_BYTES} bytes. Release completed attempts to drop their pins, then archive this store: releasing keeps their durable records.`);
    }
    // One measurement of this projection decides both limits: the ledger bytes
    // themselves and the room a still-applying publication needs for its bounded
    // terminal report plus an explicit release. No durable mutation can spend it.
    const reserved = reservedBytes(parsed);
    if (size + reserved > MAX_DATA_BYTES) {
      throw new WorkerError('capacity_exceeded', `This integration mutation would leave less than the ${reserved} bytes an in-flight publication report and an explicit release need within ${MAX_DATA_BYTES} bytes; nothing was written. Release finished attempts and archive this store.`);
    }
    return { text, parsed };
  }

  /**
   * The awaited `onJournalIntent` checkpoint handed to the publication port: it
   * persists the journal revision of one durable per-file intent as a MONOTONIC
   * `publicationJournalRevision` floor BEFORE that file's first workspace effect.
   * The floor is never lowered, never removed and never bumps the attempt's own
   * revision, so it survives conflict retries, reopens, interruptions and
   * release, and a later journal older than it is provably stale.
   *
   * The write re-checks authorization and is capacity-projected exactly like
   * every other durable save, so a checkpoint that cannot be recorded refuses
   * instead of letting the port touch the workspace without a durable floor.
   */
  private journalIntent(draft: Attempt, authorize: () => void): (revision: number) => Promise<void> {
    return async (reported: number) => {
      // A malformed report is never guessed: the floor is the ONLY proof that a
      // later journal revision is stale, so an unusable number fails closed.
      if (typeof reported !== 'number' || !Number.isSafeInteger(reported) || reported < 0) {
        throw new WorkerError('publish_invalid', `The publication port reported an unusable journal revision (${String(reported)}); the floor stays unchanged and nothing was written.`);
      }
      const current = draft.publicationJournalRevision;
      if (current !== undefined && current >= reported) {
        return;
      }
      const checkpointed = structuredClone(draft);
      checkpointed.publicationJournalRevision = reported;
      // A durable per-file intent IS a durable journal, exactly like the
      // `onJournalReady` checkpoint: the latch is raised here too so a port that
      // reports an intent can never leave a false latch behind. The latch itself
      // is never downgraded.
      checkpointed.publicationJournalEstablished = true;
      checkpointed.updatedAt = new Date().toISOString();
      await this.save(checkpointed, authorize);
      draft.publicationJournalRevision = reported;
      draft.publicationJournalEstablished = true;
      draft.updatedAt = checkpointed.updatedAt;
    };
  }

  private scope(attempt: Attempt): IntegrationScope {
    return { ownerId: attempt.ownerId, teamId: attempt.teamId, attemptId: attempt.id };
  }

  // -- request replay -------------------------------------------------------

  /** True when this exact request was already recorded; different arguments fail. */
  private replayed(attempt: Attempt, action: string, id: string, fingerprint: string): boolean {
    const recorded = attempt.requests.find(entry => entry.action === action && entry.requestId === id);
    if (!recorded) {
      return false;
    }
    if (recorded.fingerprint !== fingerprint) {
      throw new WorkerError('request_conflict', `Request ${id} was already used for different ${action} arguments. Use a new requestId for a different decision.`);
    }
    return true;
  }

  /**
   * Append one durable receipt and never evict another. A reused request id keeps
   * its original fingerprint, so an old candidate/validate id presented with a
   * newer expectedRevision conflicts instead of applying as a fresh decision.
   * Rework is capped with slots reserved for accept/apply/release.
   */
  private recordRequest(draft: Attempt, action: Attempt['requests'][number]['action'], id: string, fingerprint: string): void {
    this.assertRequestCapacity(draft, action, id);
    draft.requests = [
      ...draft.requests.filter(entry => !(entry.action === action && entry.requestId === id)),
      { action, requestId: id, fingerprint }
    ];
  }

  /**
   * Preflight capacity BEFORE any side effect, so a refused request can never
   * leave pins or evidence behind for a receipt it is not allowed to record.
   */
  private assertRequestCapacity(attempt: Attempt, action: Attempt['requests'][number]['action'], id: string): void {
    if (attempt.requests.some(entry => entry.action === action && entry.requestId === id)) {
      return;
    }
    const held = attempt.requests.length;
    if (action === 'release') {
      // The reserved final slot is exactly what release consumes.
      if (held >= MAX_REQUESTS) {
        throw new WorkerError('capacity_exceeded', `This attempt already holds ${MAX_REQUESTS} receipts and its reserved release slot is gone; no pins were dropped. Begin a new attempt and release it.`);
      }
      return;
    }
    if (held >= MAX_NON_RELEASE_REQUESTS) {
      throw new WorkerError('capacity_exceeded', `This attempt already holds ${held} receipts; the final slot is reserved for release so its pins can always be dropped. Release it and begin a new attempt.`);
    }
    const rework = action === 'candidate' || action === 'validate';
    if (!rework) {
      return;
    }
    if (attempt.requests.filter(entry => entry.action === 'candidate' || entry.action === 'validate').length >= MAX_REWORK_REQUESTS) {
      throw new WorkerError('capacity_exceeded', `This attempt already holds its ${MAX_REWORK_REQUESTS} rework receipts; ${LIFECYCLE_REQUESTS} slots stay reserved for accept, apply and release. Continue with the current candidate, or release and begin a new attempt.`);
    }
  }

  private findAttempt(id: string, owner: string, team: string): Attempt {
    const found = this.requireData().attempts.find(entry => entry.id === id && entry.ownerId === owner && entry.teamId === team);
    if (!found) {
      throw new WorkerError('attempt_missing', 'No integration attempt with that id exists for this coordinator and team.');
    }
    return found;
  }

  private findBegin(request: string, owner: string, team: string): Attempt {
    const found = this.requireData().attempts.find(entry => entry.beginRequestId === request && entry.ownerId === owner && entry.teamId === team);
    if (!found) {
      throw new WorkerError('attempt_missing', 'No integration attempt with that begin requestId exists for this coordinator and team.');
    }
    return found;
  }

  private requireRevision(attempt: Attempt, expected: number): void {
    if (attempt.revision !== expected) {
      throw new WorkerError('revision_conflict', `Integration attempt ${attempt.id} is at revision ${attempt.revision}, not ${expected}. Re-read its status before deciding.`);
    }
  }

  private requireMutable(attempt: Attempt): void {
    if (attempt.apply?.state === 'applying' || attempt.status === 'applying') {
      throw new WorkerError('application_in_flight', 'A publication decision is durable and unresolved. Retry the exact apply request with its original requestId; do not replace or release it.');
    }
    if (attempt.status === 'released' || attempt.status === 'abandoned' || attempt.status === 'releasing') {
      throw new WorkerError('attempt_released', 'This integration attempt was explicitly released; it cannot be reused.');
    }
    if (attempt.status === 'interrupted') {
      throw new WorkerError('attempt_interrupted', 'This publication was durably interrupted and is proof-only; it can only be released. Begin a new attempt to publish again.');
    }
  }

  // -- view -----------------------------------------------------------------

  /**
   * The COMPLETE, unchanged view of one attempt: every durable field, the full
   * conflict groups, the exact sorted conflict path union and its digest. It is
   * the payload `details` pages reassemble and the input the response budget
   * measures.
   */
  private fullView(attempt: Attempt, action: string, replayed: boolean): Record<string, unknown> {
    // One exact union per view: the full sorted list and its deterministic digest
    // are derived from the same stored conflict groups.
    const paths = conflictPaths(attempt.conflicts);
    return {
      action,
      replayed,
      attemptId: attempt.id,
      beginRequestId: attempt.beginRequestId,
      ownerId: attempt.ownerId,
      teamId: attempt.teamId,
      status: attempt.status,
      revision: attempt.revision,
      dependencyOnly: attempt.dependencyOnly,
      seedOnly: attempt.seedOnly,
      requirements: attempt.requirements,
      contracts: attempt.contracts,
      dependencies: attempt.dependencies,
      validationCommands: attempt.validationCommands,
      conflicts: attempt.conflicts,
      conflictPaths: paths,
      /**
       * Compact, deterministic acknowledgment for `accept`: send this exact value
       * as `resolvedPathsDigest` instead of the full path list. It is derived from
       * this attempt id and its exact conflict paths, so re-read it from this view
       * whenever the conflict groups or the candidate change.
       */
      conflictPathsDigest: conflictPathsDigest(attempt.id, attempt.conflicts),
      derivedSnapshotId: attempt.derivedSnapshotId ?? null,
      baseSnapshotId: attempt.baseSnapshotId ?? null,
      /** Omitted artifact edges proved already embedded in this base. */
      inherited: attempt.inherited ?? [],
      sourceSnapshotId: attempt.sourceSnapshotId ?? null,
      /** Durable proof that this record's conflicted lineage was verified. */
      ancestryVerified: attempt.ancestryVerified === true,
      pinState: attempt.pinState,
      evidencePinned: attempt.evidencePinned,
      candidate: attempt.candidate ? {
        artifact: attempt.candidate.artifact,
        lane: attempt.candidate.lane,
        submission: {
          id: attempt.candidate.submission.id,
          version: attempt.candidate.submission.version,
          uri: attempt.candidate.submission.uri,
          snapshotId: attempt.candidate.submission.snapshotId,
          revision: attempt.candidate.submission.revision,
          workerId: attempt.candidate.submission.workerId,
          workerCreatedAt: attempt.candidate.submission.workerCreatedAt
        }
      } : null,
      validations: attempt.validations,
      /**
       * The exact durable acceptance. A digest approval persists only its verified
       * digest, and its full path union is derived HERE from the SAME immutable
       * conflict groups that digest names, so `acceptance.resolvedPaths` keeps its
       * exact meaning for every existing caller. A digest that no longer
       * reproduces that union is not an approval: `resolvedPaths` is null instead
       * of an invented list.
       */
      acceptance: attempt.acceptance === undefined
        ? null
        : ('resolvedPaths' in attempt.acceptance
          ? attempt.acceptance
          : {
            resolvedPaths: storedAcceptancePaths(attempt),
            requestId: attempt.acceptance.requestId,
            at: attempt.acceptance.at
          }),
      apply: attempt.apply ?? null,
      publicationJournalEstablished: attempt.publicationJournalEstablished ?? null,
      publicationJournalRevision: attempt.publicationJournalRevision ?? null,
      failure: attempt.failure ?? null,
      canPublish: canPublish(attempt),
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt
    };
  }

  /**
   * The single response path of every action. An ordinary reply stays exactly the
   * complete view while its FULLY serialized ToolResult fits MAX_RESPONSE_CHARS,
   * and an oversized one becomes the deterministic bounded summary instead, so no
   * lifecycle effect is ever acknowledged by a reply the transport would refuse.
   * Both forms are derived from the same durable record; nothing durable is
   * truncated, and `details` still exposes every byte of the complete view.
   */
  private view(attempt: Attempt, action: string, replayed: boolean): Record<string, unknown> {
    const complete = this.fullView(attempt, action, replayed);
    const text = JSON.stringify(complete);
    return responseChars(text) <= MAX_RESPONSE_CHARS
      ? complete
      : this.boundedView(attempt, action, replayed, complete, text);
  }

  /**
   * The bounded fallback: a fixed-shape summary that names the attempt exactly -
   * attemptId, beginRequestId, owner, team, status, revision, the exact
   * conflictPathsDigest, exact counts and the fields the next decision needs - and
   * carries NO partial path, approval, evidence or publication preview, so an
   * incomplete approval set can never look complete. `truncated` and
   * `summary.omitted` state explicitly what is missing, and `summary.details` is
   * the exact read that returns all of it. Its size depends only on bounded
   * scalar fields, never on the number of conflict paths, sources or inherited
   * witnesses, so no legal durable record can outgrow it.
   */
  private boundedView(
    attempt: Attempt,
    action: string,
    replayed: boolean,
    complete: Record<string, unknown>,
    text: string
  ): Record<string, unknown> {
    const acceptance = attempt.acceptance;
    const apply = attempt.apply;
    // `text` is this ACTION's complete reply, used only to decide and report why
    // the fallback was needed. The paging identity is the canonical document
    // `details` actually reads - the complete STATUS-form view - so a summary of a
    // begin/apply/release reply (or of a replay) never advertises a guard that
    // `details` would reject.
    const statusText = JSON.stringify(this.fullView(attempt, 'status', false));
    const contentDigest = viewContentDigest(attempt.id, statusText);
    return {
      action,
      replayed,
      attemptId: attempt.id,
      beginRequestId: attempt.beginRequestId,
      ownerId: attempt.ownerId,
      teamId: attempt.teamId,
      status: attempt.status,
      revision: attempt.revision,
      dependencyOnly: attempt.dependencyOnly,
      seedOnly: attempt.seedOnly,
      /** Explicit: this reply is a summary, never the complete view. */
      truncated: true,
      summary: {
        kind: 'bounded-integration-summary',
        reason: `The complete ${action} reply would relay ${responseChars(text)} characters (view text ${text.length} characters), above this tool's ${MAX_RESPONSE_CHARS}-character reply budget and near the transport's 10,000,000-character limit. No durable data was truncated: read the complete status view with the details action below.`,
        /** Exact size of this ACTION's complete reply as the relay would count it. */
        actionReplyChars: responseChars(text),
        actionViewChars: text.length,
        /**
         * Size of the canonical document `details` reads: the complete STATUS-form
         * view, NOT this action's own reply.
         */
        fullViewChars: statusText.length,
        fullViewBytes: Buffer.byteLength(statusText, 'utf8'),
        /** Content identity of the exact text `details` pages back. */
        guard: viewContentGuard(attempt.id, attempt.revision, statusText),
        /**
         * Every field this summary omits. The counts below are exact; no partial
         * list is previewed, so nothing here can be mistaken for a complete
         * approval, conflict, evidence or publication set.
         */
        omitted: [
          'requirements', 'contracts', 'dependencies', 'validationCommands', 'conflicts',
          'conflictPaths', 'inherited', 'candidate.submission', 'validations',
          'acceptance.resolvedPaths', 'apply.applied', 'apply.conflicts'
        ],
        counts: {
          sources: attempt.requirements.sources.length,
          consumerRequirements: attempt.requirements.consumer === undefined ? 0 : 1,
          inherited: attempt.inherited === undefined ? 0 : attempt.inherited.length,
          dependencies: attempt.dependencies.length,
          contracts: attempt.contracts.length,
          validationCommands: attempt.validationCommands.length,
          conflictGroups: attempt.conflicts.length,
          conflictGroupPaths: attempt.conflicts.reduce((total, group) => total + group.paths.length, 0),
          conflictPaths: conflictPaths(attempt.conflicts).length,
          validations: attempt.validations.length,
          acceptanceResolvedPaths: storedAcceptancePaths(attempt)?.length ?? null,
          applyApplied: apply === undefined ? null : apply.applied.length,
          applyAppliedCount: apply === undefined ? null : (apply.appliedCount ?? apply.applied.length),
          applyConflicts: apply === undefined ? null : apply.conflicts.length,
          applyConflictCount: apply === undefined ? null : (apply.conflictCount ?? apply.conflicts.length),
          applyTruncated: apply !== undefined && apply.truncated === true,
          requests: attempt.requests.length
        },
        /**
         * A DIRECTLY EXECUTABLE `details` call: exactly the schema-valid arguments,
         * with no extra metadata, so it can be sent as-is once the host routing
         * layer consumed `workspaceRoot` (Paging format lives in `detailsFormat`
         * beside it).
         */
        details: {
          action: 'details',
          ownerId: attempt.ownerId,
          teamId: attempt.teamId,
          attemptId: attempt.id,
          expectedRevision: attempt.revision,
          /** Required again on every continuation page (`offset > 0`). */
          expectedContentDigest: contentDigest,
          offset: 0,
          limit: DEFAULT_DETAILS_LIMIT,
          /**
           * Host ROUTING identity of the store this reply came from, present only
           * when this service was wired with a workspace root. It is not part of
           * the details schema and never part of the status view or its digest, so
           * the host removes it before the ledger parses the call.
           */
          ...(this.workspaceRoot === undefined ? {} : { workspaceRoot: this.workspaceRoot })
        },
        /** Paging format of that read; never part of its arguments. */
        detailsFormat: {
          /** The payload is the complete STATUS-form view, never this summary. */
          payload: 'status',
          encoding: DETAILS_ENCODING,
          maxLimit: MAX_DETAILS_LIMIT,
          total: statusText.length,
          contentDigest,
          semantics: 'Follow nextOffset from offset 0, sending this details object and replacing offset/limit, until nextOffset is null; the returned text pages concatenate to the exact complete status view JSON. Send contentDigest as expectedContentDigest on every continuation page.'
        }
      },
      conflictPathsDigest: complete.conflictPathsDigest,
      /** The guard a continuation page must send; equal to `summary.guard.value`. */
      contentDigest,
      /** Preconditions and identities the next decision needs, all bounded. */
      controls: {
        ownerId: attempt.ownerId,
        teamId: attempt.teamId,
        attemptId: attempt.id,
        expectedRevision: attempt.revision,
        status: attempt.status,
        canPublish: canPublish(attempt),
        seedOnly: attempt.seedOnly,
        dependencyOnly: attempt.dependencyOnly,
        pinState: attempt.pinState,
        evidencePinned: attempt.evidencePinned,
        derivedSnapshotId: attempt.derivedSnapshotId ?? null,
        baseSnapshotId: attempt.baseSnapshotId ?? null,
        sourceSnapshotId: attempt.sourceSnapshotId ?? null,
        ancestryVerified: attempt.ancestryVerified === true,
        candidate: attempt.candidate === undefined ? null : {
          artifact: attempt.candidate.artifact,
          lane: attempt.candidate.lane,
          snapshotId: attempt.candidate.submission.snapshotId,
          revision: attempt.candidate.submission.revision
        },
        acceptanceRequestId: acceptance === undefined ? null : acceptance.requestId,
        applyState: apply === undefined ? null : apply.state,
        applyRequestId: apply === undefined ? null : apply.requestId,
        publicationJournalEstablished: attempt.publicationJournalEstablished ?? null,
        publicationJournalRevision: attempt.publicationJournalRevision ?? null,
        failureCode: attempt.failure === undefined ? null : attempt.failure.code,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt
      }
    };
  }

  // -- status ---------------------------------------------------------------

  private status(action: z.infer<typeof statusAction>): unknown {
    if ((action.attemptId === undefined) === (action.beginRequestId === undefined)) {
      throw new WorkerError('invalid_arguments', 'Provide exactly one of attemptId or beginRequestId.');
    }
    const attempt = action.attemptId
      ? this.findAttempt(action.attemptId, action.ownerId, action.teamId)
      : this.findBegin(action.beginRequestId!, action.ownerId, action.teamId);
    return this.view(attempt, 'status', false);
  }

  // -- details --------------------------------------------------------------

  /**
   * One bounded page of the COMPLETE status-form view text. The read authorizes
   * exactly the owner and team of the attempt (findAttempt scopes both), requires
   * the exact durable revision, and mutates nothing: no receipt, no revision and
   * no durable field is written. `text` is a slice of the exact JSON the complete
   * status view serializes to, so its pages concatenate back to that JSON with no
   * loss, including quoted, escaped-control and non-ASCII strings and one huge
   * conflict group.
   */
  private details(action: z.infer<typeof detailsAction>): unknown {
    const attempt = this.findAttempt(action.attemptId, action.ownerId, action.teamId);
    // A page is only meaningful for ONE durable revision: mixing the pages of two
    // revisions would reassemble a view text that never existed.
    this.requireRevision(attempt, action.expectedRevision);
    // The payload is the COMPLETE status-form view: no summary, no truncation.
    const text = JSON.stringify(this.fullView(attempt, 'status', false));
    const total = text.length;
    const guard = viewContentGuard(attempt.id, attempt.revision, text);
    // A revision does not fence the CONTENT: a journal latch/floor checkpoint or a
    // failed publication retry is persisted at the same revision and changes
    // `failure`, `updatedAt`, `publicationJournalEstablished` or
    // `publicationJournalRevision`, i.e. the serialized text. A continuation page
    // must therefore name the exact document it continues.
    if (action.offset > 0 && action.expectedContentDigest === undefined) {
      throw new WorkerError('invalid_arguments', `A continuation page (offset ${action.offset} > 0) must send expectedContentDigest = ${guard.value}, the content guard the first page reported. Restart at offset 0 if the view changed.`);
    }
    if (action.expectedContentDigest !== undefined && action.expectedContentDigest !== guard.value) {
      throw new WorkerError('content_changed', `This attempt's complete view at revision ${attempt.revision} is content ${guard.value}, not the requested ${action.expectedContentDigest}. Journal checkpoints and failed publication retries change the view without moving its revision, so an earlier page cursor is stale: discard the pages and restart at offset 0.`);
    }
    if (action.offset > total) {
      throw new WorkerError('invalid_arguments', `offset ${action.offset} is past the end of this attempt's ${total}-character view. Restart at offset 0 and follow nextOffset.`);
    }
    if (action.offset > 0 && action.offset < total
      && isHighSurrogate(text.charCodeAt(action.offset - 1)) && isLowSurrogate(text.charCodeAt(action.offset))) {
      // Every page boundary falls on a code point boundary: an offset that would
      // split a surrogate pair is refused instead of returning half of one.
      throw new WorkerError('invalid_arguments', `offset ${action.offset} splits a Unicode surrogate pair. Restart at offset 0 and follow the nextOffset each page returns.`);
    }
    let end = Math.min(action.offset + action.limit, total);
    if (end < total && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      // Include the low surrogate instead of splitting it: a page is at most ONE
      // code unit longer than `limit`, and every page still advances.
      end += 1;
    }
    return {
      action: 'details',
      attemptId: attempt.id,
      ownerId: attempt.ownerId,
      teamId: attempt.teamId,
      status: attempt.status,
      revision: attempt.revision,
      /** The complete STATUS-form view text, with no summary or truncation. */
      payload: 'status',
      encoding: DETAILS_ENCODING,
      semantics: 'offset and nextOffset count UTF-16 code units of the exact complete status view text; text is that text sliced at [offset, nextOffset). Concatenate every page from offset 0 until nextOffset is null to reproduce the view text exactly, then JSON.parse it. Send this page\'s contentDigest as expectedContentDigest on the next page; a revision change fails with revision_conflict and a content change at the same revision fails with content_changed, so restart at offset 0 in both cases.',
      /**
       * Identity of the EXACT document these pages assemble. It is stable for one
       * durable content and changes whenever the serialized view does, even at an
       * unchanged revision, so a cursor can never straddle two documents.
       */
      contentDigest: guard.value,
      guard,
      offset: action.offset,
      limit: action.limit,
      nextOffset: end < total ? end : null,
      total,
      text: text.slice(action.offset, end)
    };
  }

  // -- begin ----------------------------------------------------------------

  private async begin(action: z.infer<typeof beginAction>, authorize: () => void): Promise<unknown> {
    const fingerprint = digest(canonical(action));
    const existing = this.requireData().attempts.find(entry =>
      entry.beginRequestId === action.requestId && entry.ownerId === action.ownerId && entry.teamId === action.teamId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new WorkerError('request_conflict', `Begin request ${action.requestId} was already used for different integration arguments. Use a new requestId for a different selection.`);
      }
      if (existing.status === 'released' || existing.status === 'abandoned' || existing.status === 'releasing') {
        throw new WorkerError('attempt_released', 'This integration attempt was explicitly released; the original begin request cannot be resumed.');
      }
      if (existing.status === 'intent' || existing.status === 'failed') {
        return this.runBeginFailureSafe(existing, authorize);
      }
      return this.view(existing, 'begin', true);
    }
    if (this.requireData().attempts.length >= MAX_ATTEMPTS) {
      throw new WorkerError('capacity_exceeded', `At most ${MAX_ATTEMPTS} integration attempts are retained in this store. Release frees an attempt of its pins and evidence but keeps its durable record, so only archiving this store reclaims the lifetime cap.`);
    }
    const draft = await this.planBegin(action, fingerprint, authorize);
    await this.save(draft, authorize);
    return this.runBeginFailureSafe(draft, authorize);
  }

  /** A failed begin stays visible by exact beginRequestId so it can be released. */
  private async runBeginFailureSafe(attempt: Attempt, authorize: () => void): Promise<unknown> {
    try {
      const completed = await this.beginEffects(structuredClone(attempt), authorize);
      return this.view(completed, 'begin', attempt.status !== 'intent');
    } catch (error) {
      const durable = this.requireData().attempts.find(entry => entry.id === attempt.id) ?? attempt;
      const failed = structuredClone(durable);
      failed.status = 'failed';
      failed.revision += 1;
      failed.updatedAt = new Date().toISOString();
      failed.failure = {
        code: error instanceof WorkerError ? error.code : 'internal_error',
        message: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        at: failed.updatedAt
      };
      try {
        // Re-check authorization: a revoked call must not rewrite even the failure
        // record, so the previous durable intent stays authoritative.
        await this.save(failed, authorize);
      } catch {
        // The effect failure is the caller's answer; a failed metadata write keeps
        // the previous durable intent, which an exact retry can safely recover.
      }
      throw error;
    }
  }

  /**
   * Read the board synchronously (the board port is already open) and persist
   * the complete immutable selection. Nothing here infers a producer, contract or
   * evidence item: every explicit link must be present in the request. The ONE
   * exception is an omitted artifact edge that the exact source base ALREADY
   * embeds, which is proved from physical lineage and a durable older attempt of
   * this store instead of being requested again.
   */
  private async planBegin(action: z.infer<typeof beginAction>, fingerprint: string, authorize: () => void): Promise<Attempt> {
    const board = await this.ports.board();
    // The attempt id is decided before any proof, so the ancestry port is scoped
    // exactly like every other port call of this attempt.
    const attemptId = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const actor = { kind: 'coordinator' as const, ownerId: action.ownerId };
    let team: Team;
    try {
      team = board.getTeam(actor, action.teamId);
    } catch (error) {
      if (error instanceof WorkerError) {
        throw error;
      }
      throw new WorkerError('team_missing', `Cannot read team ${action.teamId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (team.coordinatorOwnerId !== action.ownerId) {
      throw new WorkerError('forbidden', `Team ${action.teamId} belongs to a different coordinator.`);
    }
    const tasks = new Map<string, BoardTask>();
    const readTask = (id: string): BoardTask => {
      const cached = tasks.get(id);
      if (cached) {
        return cached;
      }
      const task = board.getTask(actor, id);
      if (task.teamId !== action.teamId) {
        throw new WorkerError('scope_mismatch', `Task ${id} belongs to a different team.`);
      }
      tasks.set(id, task);
      return task;
    };
    const consumerTask = action.consumer ? readTask(action.consumer.taskId) : undefined;
    if (consumerTask && action.consumer && consumerTask.revision !== action.consumer.taskRevision) {
      throw new WorkerError('revision_conflict', `Consumer task ${consumerTask.id} is at revision ${consumerTask.revision}, not ${action.consumer!.taskRevision}.`);
    }
    // ANY explicit consumer begin is a private dependency seed: it is composed
    // for downstream use and can only be released here, never published. Its
    // producers must already be accepted, because the seed claims their exact
    // agreed artifacts as settled inputs rather than in-flight submissions.
    const dependencyOnly = consumerTask !== undefined;
    const seedOnly = dependencyOnly;
    const selectedIds = new Set<string>();
    const requirements: SourceRequirement[] = [];
    const dependencies = new Map<string, 'contract' | 'artifact'>();
    for (const dependency of consumerTask?.dependencies ?? []) {
      dependencies.set(`${dependency.taskId}:${dependency.kind}`, dependency.kind);
    }
    for (const source of action.sources) {
      if (selectedIds.has(source.taskId)) {
        throw new WorkerError('dependency_unselected', `Task ${source.taskId} is selected more than once; select one exact artifact per producer.`);
      }
      selectedIds.add(source.taskId);
      const task = readTask(source.taskId);
      if (task.revision !== source.taskRevision) {
        throw new WorkerError('revision_conflict', `Task ${task.id} is at revision ${task.revision}, not ${source.taskRevision}.`);
      }
      const allowed = seedOnly ? task.state === 'accepted'
        : task.state === 'submitted' || task.state === 'validating' || task.state === 'accepted';
      if (!allowed) {
        throw new WorkerError('state_invalid', seedOnly
          ? `Task ${task.id} is ${task.state}; every producer of a consumer seed must already be accepted.`
          : `Task ${task.id} is ${task.state}; a source must be submitted, validating or accepted.`);
      }
      if (!task.candidates.some(candidate => sameRef(candidate, source.artifact))) {
        throw new WorkerError('candidate_mismatch', `Task ${task.id} has no current candidate with the exact id, version and URI of the selected artifact.`);
      }
      const producer = this.producerOf(task, team, action.ownerId);
      requirements.push({
        taskId: task.id,
        taskRevision: task.revision,
        title: task.title,
        description: task.description,
        state: task.state,
        acceptanceCriteria: [...task.acceptanceCriteria],
        artifact: { id: source.artifact.id, version: source.artifact.version, uri: source.artifact.uri },
        evidence: source.evidence.map(ref => ({ id: ref.id, version: ref.version, uri: ref.uri })),
        producer
      });
      for (const dependency of task.dependencies) {
        if (!dependencies.has(`${dependency.taskId}:${dependency.kind}`)) {
          dependencies.set(`${dependency.taskId}:${dependency.kind}`, dependency.kind);
        }
      }
    }
    // Immutable for the attempt: ordinary integration needs them, a seed may not.
    const validationCommands = action.validationCommands ?? [];
    if (!seedOnly && validationCommands.length === 0) {
      throw new WorkerError('invalid_arguments', 'Ordinary integration requires 1-8 immutable validation commands; only a consumer (dependency seed) begin may omit them.');
    }
    if (new Set(validationCommands).size !== validationCommands.length) {
      throw new WorkerError('invalid_arguments', 'Validation commands must be distinct so each has exactly one scoped runner result.');
    }
    // An artifact edge normally names an EXPLICITLY selected producer, because
    // only an explicit selection retains, pins and consumes that producer's exact
    // seal. The single exception is a dependency this begin's own immutable source
    // base already embeds: a downstream output re-enters integration alone and the
    // already-incorporated producer is proved from physical lineage plus a durable
    // older attempt of this store, never requested from live files again.
    const omitted = [...dependencies.entries()]
      .filter(([, kind]) => kind === 'artifact')
      .map(([key]) => key.slice(0, 32))
      .filter(producerId => !selectedIds.has(producerId))
      .sort();
    const contracts = this.checkContracts(action.contracts ?? [], dependencies, tasks, readTask);
    const inherited = await this.inheritOmitted(omitted, requirements.map(source => source.artifact), action, attemptId, readTask, authorize);
    return {
      schema: 1,
      // The private view store addresses snapshots, overlays and attempts by
      // 64-hex ids, so an attempt id uses the same identity width.
      id: attemptId,
      ownerId: action.ownerId,
      teamId: action.teamId,
      beginRequestId: action.requestId,
      fingerprint,
      revision: 0,
      status: 'intent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dependencyOnly,
      seedOnly,
      requirements: {
        sources: requirements,
        ...(consumerTask && action.consumer ? {
          consumer: {
            taskId: consumerTask.id,
            taskRevision: consumerTask.revision,
            title: consumerTask.title,
            description: consumerTask.description,
            state: consumerTask.state,
            acceptanceCriteria: [...consumerTask.acceptanceCriteria]
          }
        } : {})
      },
      dependencies: [...dependencies.entries()].map(([key, kind]) => ({ taskId: key.slice(0, 32), kind })),
      validationCommands: [...validationCommands],
      contracts,
      conflicts: [],
      ...(inherited === undefined ? {} : { inherited: inherited.witnesses, sourceSnapshotId: inherited.sourceSnapshotId }),
      pinState: 'none',
      evidencePinned: false,
      producerSubmissions: [],
      validations: [],
      requests: []
    };
  }

  /**
   * The recorded producer expectation is the task's current assignee plus that
   * exact session creation identity. A seal from a replacement worker with a
   * reused id can therefore never satisfy it.
   */
  private producerOf(task: BoardTask, team: { workspaceRoot: string }, owner: string): { workerId: string; workerCreatedAt: string } {
    if (!task.assigneeWorkerId) {
      throw new WorkerError('producer_unverified', `Task ${task.id} has no assignee, so its sealed producer identity cannot be recorded.`);
    }
    const session = this.ports.session(task.assigneeWorkerId);
    if (!session) {
      throw new WorkerError('producer_unverified', `The assigned worker ${task.assigneeWorkerId} for task ${task.id} does not exist.`);
    }
    if (session.ownerId !== owner) {
      throw new WorkerError('producer_unverified', `Worker ${session.id} belongs to a different coordinator.`);
    }
    if (session.workspaceRoot !== team.workspaceRoot) {
      throw new WorkerError('producer_unverified', `Worker ${session.id} is bound to a different workspace root.`);
    }
    const binding = session.isolatedView;
    if (!binding || binding.teamId !== task.teamId) {
      throw new WorkerError('producer_unverified', `Worker ${session.id} is not permanently bound to team ${task.teamId}.`);
    }
    return { workerId: session.id, workerCreatedAt: session.createdAt };
  }

  /**
   * Prove every OMITTED artifact edge is already physically embedded in the
   * immutable base the explicitly selected sources are sealed over. The port
   * returns the immediate source snapshot plus the derived seeds below it; each
   * candidate ancestor must match a DURABLE older attempt of this exact owner and
   * team by attempt, seed, base, ordered refs and retained seals. The dependency
   * task must still be accepted with that exact witnessed artifact, whose current
   * board revision may legitimately have advanced since the older acceptance.
   *
   * Nothing is requested again: no live file is read, no old producer blob is
   * reopened and no newer artifact of the dependency is ever implied to be
   * inherited. An edge that cannot be witnessed keeps the existing
   * dependency_unselected semantics.
   */
  private async inheritOmitted(
    omitted: readonly string[],
    refs: readonly IntegrationArtifactRef[],
    action: { ownerId: string; teamId: string },
    attemptId: string,
    readTask: (id: string) => BoardTask,
    authorize: () => void
  ): Promise<{ witnesses: InheritedWitness[]; sourceSnapshotId: string } | undefined> {
    if (omitted.length === 0) {
      return undefined;
    }
    let ancestry: IntegrationSourceAncestry;
    try {
      ancestry = await this.ports.sourceAncestry({ ownerId: action.ownerId, teamId: action.teamId, attemptId }, refs, authorize);
    } catch (error) {
      if (error instanceof WorkerError) {
        throw error;
      }
      throw new WorkerError('ancestry_unavailable', `The source ancestry port could not prove the immutable base of these exact sources: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = ancestrySchema.safeParse(ancestry);
    if (!parsed.success) {
      throw new WorkerError('ancestry_invalid', `The source ancestry port returned a malformed chain, so no omitted dependency can be proved: ${z.prettifyError(parsed.error).slice(0, 1500)}`);
    }
    const witnesses: InheritedWitness[] = [];
    for (const taskId of omitted) {
      const witness = this.inheritedWitness(taskId, parsed.data, refs, action, readTask);
      if (!witness) {
        throw new WorkerError('dependency_unselected', `Task ${taskId} is an artifact dependency that is neither selected as a source nor proved already incorporated in the verified base of the selected sources. Select its exact artifact explicitly, or integrate it into that base first.`);
      }
      witnesses.push(witness);
    }
    return { witnesses, sourceSnapshotId: parsed.data.sourceSnapshotId };
  }

  /**
   * Match one omitted dependency against the physically verified ancestor chain.
   * The newest (leaf-most) ancestor that is itself a completed integration
   * attempt of this store wins; an older attempt can never be rewritten, so its
   * retained requirement is a stable evidence source.
   *
   * A conflict-FREE ancestor keeps its original proof. A conflicted one is only
   * accepted through the SAME exact path-and-candidate proof the composition
   * port uses: the sole ref that hop carried (this begin's own selection for the
   * immediate base, or the child seed's stored refs for a deeper one) must BE
   * that attempt's accepted resolution seal, sealed over exactly that seed, with
   * exactly the seed's conflict paths resolved. The exact resolution artifact is
   * recorded on the witness, so later consumption can name it explicitly.
   */
  private inheritedWitness(
    taskId: string,
    ancestry: Ancestry,
    carried: readonly IntegrationArtifactRef[],
    action: { ownerId: string; teamId: string },
    readTask: (id: string) => BoardTask
  ): InheritedWitness | undefined {
    const attempts = this.requireData().attempts;
    for (const [index, ancestor] of ancestry.ancestors.entries()) {
      const provenance = ancestor.provenance;
      // The exact refs this hop CARRIED: this begin's own selection consumes the
      // immediate base, while a deeper hop was consumed by its child seed's
      // stored provenance refs. That is the tie the resolution proof needs.
      const hop = index === 0 ? carried : ancestry.ancestors[index - 1].provenance.refs;
      const older = attempts.find(entry => entry.id === provenance.attemptId
        && entry.ownerId === action.ownerId && entry.teamId === action.teamId);
      if (!older || older.derivedSnapshotId === undefined || older.baseSnapshotId === undefined) {
        continue;
      }
      // Exact durable identity of the seed the chain names and the base it was
      // composed over. An attempt that never composed cannot witness inherited
      // consumption, and an ancestor that itself had conflicts must ALSO prove
      // its accepted resolution below.
      if (older.derivedSnapshotId !== ancestor.snapshotId || older.baseSnapshotId !== provenance.baseSnapshotId) {
        continue;
      }
      let resolution: IntegrationArtifactRef | undefined;
      if (older.conflicts.length > 0 || provenance.conflicts.length > 0) {
        // A conflicted ancestor is consumed only through its own accepted
        // resolution seal. A legacy work-lane seal, an integration-lane seal
        // that was never accepted, or a batch that merely contains the right
        // artifact proves nothing and keeps the existing answer.
        resolution = this.resolvedSeal(older, ancestor.snapshotId, provenance, hop);
        if (resolution === undefined) {
          continue;
        }
      }
      if (older.status === 'intent' || older.status === 'failed') {
        continue;
      }
      const sources = older.requirements.sources;
      if (provenance.refs.length !== sources.length
        || provenance.refs.some((ref, index) => !sameRef(ref, sources[index].artifact))) {
        continue;
      }
      // Its retained seals are the proof that the older attempt really consumed
      // exactly these artifacts in this scope; a bare record proves nothing.
      if (older.producerSubmissions.length !== sources.length
        || older.producerSubmissions.some((record, index) => record.taskId !== sources[index].taskId
          || !sameRef(record.submission, sources[index].artifact)
          || record.submission.ownerId !== action.ownerId || record.submission.teamId !== action.teamId)) {
        continue;
      }
      const requirement = sources.find(source => source.taskId === taskId);
      if (!requirement) {
        continue;
      }
      let task: BoardTask;
      try {
        task = readTask(taskId);
      } catch (error) {
        if (error instanceof WorkerError && error.code === 'task_missing') {
          continue;
        }
        throw error;
      }
      // The dependency task must still be accepted with the EXACT artifact the
      // older requirement consumed; a newer candidate is never inherited.
      if (task.state !== 'accepted' || !task.candidates.some(candidate => sameRef(candidate, requirement.artifact))) {
        continue;
      }
      return {
        taskId,
        taskRevision: task.revision,
        attemptId: older.id,
        snapshotId: ancestor.snapshotId,
        artifact: { ...requirement.artifact },
        requirement: structuredClone(requirement),
        ...(resolution === undefined ? {} : { resolution: { ...resolution } })
      };
    }
    return undefined;
  }

  /**
   * The ONE durable proof that a CONFLICTED derived seed was consumed by its own
   * resolution: exactly ONE carried ref, and it must BE the accepted candidate of
   * the attempt that composed the seed - an integration-lane seal of a CHANGED
   * view over exactly that seed, whose acceptance resolved exactly that seed's
   * conflict paths. `provenance` is the seed's own stored provenance, so the base,
   * the ordered source refs and the conflict groups are all durable ones.
   *
   * Returns the exact resolution artifact, or undefined when the proof does not
   * hold; callers either refuse or fail closed. No live workspace is consulted and
   * no board identity is ever inferred.
   */
  private resolvedSeal(
    older: Attempt,
    snapshotId: string,
    provenance: { baseSnapshotId: string; refs: readonly { id: string; version: number; uri: string }[]; conflicts: readonly ConflictGroup[] },
    carried: readonly IntegrationArtifactRef[]
  ): IntegrationArtifactRef | undefined {
    // A conflicted base consumed by a whole batch is never a resolution
    // decision, whatever the batch happens to contain.
    if (carried.length !== 1) {
      return undefined;
    }
    const candidate = older.candidate;
    const acceptance = older.acceptance;
    if (candidate === undefined || acceptance === undefined || older.seedOnly) {
      return undefined;
    }
    // Only a durable decision at or past acceptance proves a resolution: an
    // intent, a failed begin, a record that never recorded an acceptance, or a
    // malformed one proves nothing. Release changes RETENTION only - it keeps the
    // exact candidate, validations and acceptance - so a releasing, released or
    // abandoned record that still carries its durable acceptance remains valid
    // HISTORICAL ancestry for a downstream seed already composed from it.
    if (!['accepted', 'applying', 'applied', 'interrupted', 'releasing', 'released', 'abandoned'].includes(older.status)) {
      return undefined;
    }
    // The resolution is an INTEGRATION-lane seal of a CHANGED view over the seed.
    if (candidate.lane !== 'integration' || candidate.submission.revision === 0) {
      return undefined;
    }
    // Exact stored identity: the seed this attempt composed, the base it was
    // composed over, its ordered source refs and its own conflict groups.
    if (older.derivedSnapshotId !== snapshotId || older.baseSnapshotId !== provenance.baseSnapshotId) {
      return undefined;
    }
    if (!samePaths(conflictPaths(older.conflicts), conflictPaths(provenance.conflicts))) {
      return undefined;
    }
    const sources = older.requirements.sources;
    if (provenance.refs.length !== sources.length
      || provenance.refs.some((ref, index) => !sameRef(ref, sources[index].artifact))) {
      return undefined;
    }
    // Acceptance must have resolved EVERY conflict path of the seed, once. A
    // digest approval proves it through the digest it verified, which must still
    // reproduce this record's own conflict union; anything else proves nothing.
    const resolved = storedAcceptancePaths(older);
    if (resolved === null || !samePaths(resolved, conflictPaths(provenance.conflicts))) {
      return undefined;
    }
    // The candidate must be that exact artifact, sealed over exactly this seed.
    if (!sameRef(candidate.submission, candidate.artifact) || candidate.submission.snapshotId !== snapshotId) {
      return undefined;
    }
    if (!sameRef(carried[0], candidate.artifact)) {
      return undefined;
    }
    return { id: candidate.artifact.id, version: candidate.artifact.version, uri: candidate.artifact.uri };
  }

  /**
   * The compose-port ancestry verifier: EVERY conflicted hop of the stored
   * lineage must be consumed by exactly its own accepted resolution seal. The port
   * runs it under the view mutex, before any composed write and before a durable
   * seed is replayed, and it runs even when this begin omitted no board edge - so
   * an old work-lane seal or an integration-lane seal that was never accepted can
   * never launder unresolved conflicts into a downstream seed.
   */
  private verifyResolvedAncestry(scope: IntegrationScope, chain: readonly IntegrationConflictHop[]): void {
    const parsed = z.array(conflictHopSchema).max(MAX_ANCESTORS).safeParse(chain);
    if (!parsed.success) {
      throw new WorkerError('ancestry_invalid', `The composition port reported a malformed conflicted ancestry, so nothing was composed: ${z.prettifyError(parsed.error).slice(0, 1500)}`);
    }
    const attempts = this.requireData().attempts;
    for (const hop of parsed.data) {
      const older = attempts.find(entry => entry.id === hop.provenance.attemptId
        && entry.ownerId === scope.ownerId && entry.teamId === scope.teamId);
      if (older === undefined || this.resolvedSeal(older, hop.snapshotId, hop.provenance, hop.refs) === undefined) {
        throw new WorkerError('ancestry_unresolved', `Snapshot ${hop.snapshotId} carries unresolved merge conflict groups and this coordinator holds no durable accepted resolution of exactly that seed, its base, its ordered sources and its conflict paths. Select that exact accepted resolution seal alone, or integrate that base first; nothing was composed.`);
      }
    }
  }

  /**
   * Contract selections must exactly cover the selected tasks' and consumer's
   * contract edges. Each pinned ref is re-read from the producer at the exact
   * revision and must still be one of its agreed contracts.
   */
  private checkContracts(
    selections: readonly { taskId: string; taskRevision: number; ref: Ref }[],
    dependencies: ReadonlyMap<string, 'contract' | 'artifact'>,
    tasks: Map<string, BoardTask>,
    readTask: (id: string) => BoardTask
  ): { taskId: string; taskRevision: number; ref: Ref }[] {
    const required = new Set<string>();
    for (const [key, kind] of dependencies) {
      if (kind === 'contract') {
        required.add(key.slice(0, 32));
      }
    }
    const seen = new Set<string>();
    const captures: { taskId: string; taskRevision: number; ref: Ref }[] = [];
    for (const selection of selections) {
      if (!required.has(selection.taskId)) {
        throw new WorkerError('contract_unselected', `Contract selection for task ${selection.taskId} has no matching contract dependency.`);
      }
      if (seen.has(selection.taskId)) {
        throw new WorkerError('contract_unselected', `Task ${selection.taskId} has more than one contract selection.`);
      }
      seen.add(selection.taskId);
      const producer = tasks.get(selection.taskId) ?? readTask(selection.taskId);
      if (producer.revision !== selection.taskRevision) {
        throw new WorkerError('revision_conflict', `Contract producer ${producer.id} is at revision ${producer.revision}, not ${selection.taskRevision}.`);
      }
      const agreed = producer.agreedContracts.find(ref => sameRef(ref, selection.ref));
      if (!agreed) {
        throw new WorkerError('contract_mismatch', `Task ${producer.id} has no agreed contract with the exact selected id, version and URI.`);
      }
      captures.push({ taskId: producer.id, taskRevision: producer.revision, ref: agreed });
    }
    for (const producerId of required) {
      if (!seen.has(producerId)) {
        throw new WorkerError('contract_unselected', `Contract dependency on task ${producerId} requires an explicit exact contract selection.`);
      }
    }
    return captures;
  }

  /**
   * Run the durable effects for one intent. All selections come from the stored
   * record, so a retry never re-derives them. Source pins are committed before
   * evidence pins, and both before composition.
   */
  private async beginEffects(draft: Attempt, authorize: () => void): Promise<Attempt> {
    const sources = draft.requirements.sources;
    const refs = sources.map(source => source.artifact);
    const scope = this.scope(draft);
    authorize();
    const sealed = await this.ports.retainArtifacts(scope, refs, authorize);
    if (sealed.length !== sources.length) {
      throw new WorkerError('sealed_mismatch', 'The retention port did not return exactly one sealed submission per selected source.');
    }
    const submissions: { taskId: string; submission: SealedSubmission }[] = [];
    sealed.forEach((submission, index) => {
      const source = sources[index];
      if (!sameRef(submission, source.artifact)) {
        throw new WorkerError('sealed_mismatch', `The retained seal for task ${source.taskId} is not the exact selected artifact.`);
      }
      if (submission.ownerId !== draft.ownerId || submission.teamId !== draft.teamId) {
        throw new WorkerError('scope_mismatch', `The retained seal for task ${source.taskId} belongs to a different coordinator or team.`);
      }
      if (submission.workerId !== source.producer.workerId || submission.workerCreatedAt !== source.producer.workerCreatedAt) {
        throw new WorkerError('producer_mismatch', `The retained seal for task ${source.taskId} was not created by the recorded assignee identity.`);
      }
      submissions.push({ taskId: source.taskId, submission });
    });
    if (draft.sourceSnapshotId !== undefined && sealed.some(submission => submission.snapshotId !== draft.sourceSnapshotId)) {
      // The inherited proof is only as good as the immutable snapshot the exact
      // sources are sealed over; a drifted seal is refused before composition.
      throw new WorkerError('sealed_mismatch', 'The retained sources are not all sealed over the immutable source snapshot the ancestry proof verified.');
    }
    draft.producerSubmissions = submissions.map(entry => ({ taskId: entry.taskId, submission: entry.submission }));
    draft.pinState = 'artifacts';
    draft.updatedAt = new Date().toISOString();
    await this.save(draft, authorize);

    const checks: EvidenceCheck[] = [];
    for (const entry of submissions) {
      const source = sources.find(item => item.taskId === entry.taskId)!;
      for (const evidence of source.evidence) {
        checks.push({ ref: evidence, submission: entry.submission });
      }
    }
    authorize();
    await this.ports.pinEvidence(scope, checks, authorize);
    draft.evidencePinned = true;
    draft.pinState = 'evidence';
    draft.updatedAt = new Date().toISOString();
    await this.save(draft, authorize);

    authorize();
    const composition = await this.ports.compose(scope, refs, authorize, chain => this.verifyResolvedAncestry(scope, chain));
    const seed = compositionSeed(composition);
    if (draft.sourceSnapshotId !== undefined && seed.baseSnapshotId !== draft.sourceSnapshotId) {
      // Composition must build on exactly the immutable source snapshot the
      // inherited proof was made against, never on an unrelated base.
      throw new WorkerError('composition_conflict', 'The composed base is not the immutable source snapshot the ancestry proof verified.');
    }
    if (draft.derivedSnapshotId !== undefined
      && (draft.derivedSnapshotId !== seed.derivedSnapshotId || draft.baseSnapshotId !== seed.baseSnapshotId)) {
      throw new WorkerError('composition_conflict', 'Recovered composition produced a different seed or base snapshot than the persisted intent.');
    }
    if (draft.derivedSnapshotId !== undefined && JSON.stringify(draft.conflicts) !== JSON.stringify(seed.conflicts)) {
      throw new WorkerError('composition_conflict', 'Recovered composition produced different conflict groups than the persisted seed.');
    }
    draft.derivedSnapshotId = seed.derivedSnapshotId;
    draft.baseSnapshotId = seed.baseSnapshotId;
    draft.conflicts = seed.conflicts;
    // The composition port ran this ledger's ancestry proof over the conflicted
    // hops of this exact base BEFORE it composed, so the durable record can mark
    // the lineage as proved: a later candidate, validation, acceptance or
    // publication never repeats the scan, and an OLD record without this marker
    // stays unproved until it is re-proved on reload.
    draft.ancestryVerified = true;
    draft.status = 'ready';
    draft.revision += 1;
    draft.updatedAt = new Date().toISOString();
    await this.save(draft, authorize);
    return draft;
  }

  // -- candidate ------------------------------------------------------------

  private async candidate(action: z.infer<typeof candidateAction>, authorize: () => void): Promise<unknown> {
    const fingerprint = digest(canonical(action));
    const attempt = this.findAttempt(action.attemptId, action.ownerId, action.teamId);
    if (this.replayed(attempt, 'candidate', action.requestId, fingerprint)) {
      return this.view(attempt, 'candidate', true);
    }
    this.requireMutable(attempt);
    this.requireRevision(attempt, action.expectedRevision);
    if (attempt.seedOnly) {
      throw new WorkerError('dependency_only', 'A consumer (dependency seed) begin creates a private seed only; it can be released but never gets a candidate or a publication.');
    }
    if (!['ready', 'candidate', 'validated'].includes(attempt.status)) {
      throw new WorkerError('state_invalid', `A candidate can only be proposed before acceptance; this attempt is ${attempt.status}.`);
    }
    this.assertRequestCapacity(attempt, 'candidate', action.requestId);
    const draft = structuredClone(attempt);
    const scope = this.scope(draft);
    // A legacy record may never become a candidate on an unproved lineage: the
    // exact retained sources and conflict hops are re-proved FIRST, so a reload
    // cannot launder an unresolved conflicted seed into a new candidate (or pin).
    await this.requireAncestryProof(draft, authorize);
    // Provenance, snapshot and service-lane checks run INSIDE the retention: the
    // port proves the immutable seal, then runs this callback under its own view
    // lock, and only writes the pin when it returns normally. The callback also
    // builds the EXACT record this decision persists and checks its capacity
    // there, so a rejected or unrepresentable candidate is never pinned at all.
    let completed: Attempt | undefined;
    const verify = async (submissions: readonly SealedSubmission[]): Promise<void> => {
      completed = await this.completedCandidate(draft, action, fingerprint, submissions);
    };
    authorize();
    await this.ports.retainArtifacts(scope, [action.artifact], authorize, verify);
    if (completed === undefined) {
      throw new WorkerError('retention_contract', 'The retention port must run the supplied verifier under its view lock before it writes any pin; this candidate was never verified.');
    }
    // The completed record was already projected by the callback, so only its
    // durable write remains.
    await this.save(completed, authorize);
    return this.view(completed, 'candidate', false);
  }

  /**
   * The exact candidate decision this attempt would persist for one verified
   * seal: the provenance/snapshot/lane proof, the completed record (old verdicts
   * cleared, revision and receipt advanced) and its capacity projection. It runs
   * inside the retention callback, before the port commits any pin.
   */
  private async completedCandidate(
    draft: Attempt,
    action: z.infer<typeof candidateAction>,
    fingerprint: string,
    submissions: readonly SealedSubmission[]
  ): Promise<Attempt> {
    const lane = await this.verifyCandidate(draft, action.artifact, submissions);
    const submission = submissions[0];
    const completed = structuredClone(draft);
    const at = new Date().toISOString();
    completed.candidate = {
      artifact: { id: submission.id, version: submission.version, uri: submission.uri },
      submission,
      lane,
      requestId: action.requestId,
      at
    };
    // Replacing a candidate invalidates every old verdict; criteria are never touched.
    completed.validations = [];
    completed.acceptance = undefined;
    completed.status = 'candidate';
    completed.revision += 1;
    completed.updatedAt = at;
    this.recordRequest(completed, 'candidate', action.requestId, fingerprint);
    // The REAL record is measured here, not estimated: a candidate that cannot
    // fit refuses exactly as its durable write would, so the port never pins a
    // decision this store is unable to record.
    this.preflight(completed);
    return completed;
  }

  /**
   * The exact candidate provenance this service will accept, checked where the
   * port can still refuse to pin: the retained seal must be this exact artifact
   * in this scope, sealed over this attempt's own derived seed, proposed by a
   * current governed service-lane worker of this team and workspace root, and in
   * the lane this attempt's derived seed requires.
   */
  private async verifyCandidate(
    draft: Attempt,
    artifact: IntegrationArtifactRef,
    submissions: readonly SealedSubmission[]
  ): Promise<'integration' | 'validation'> {
    if (submissions.length !== 1) {
      throw new WorkerError('sealed_mismatch', 'The retention port did not return exactly one sealed submission for the candidate.');
    }
    const submission = submissions[0];
    if (!sameRef(submission, artifact)) {
      throw new WorkerError('sealed_mismatch', 'The retained candidate is not the exact selected sealed artifact.');
    }
    if (submission.ownerId !== draft.ownerId || submission.teamId !== draft.teamId) {
      throw new WorkerError('scope_mismatch', 'The candidate seal belongs to a different coordinator or team.');
    }
    if (submission.snapshotId !== draft.derivedSnapshotId) {
      throw new WorkerError('candidate_mismatch', 'The candidate seal is not based on this attempt’s exact derived seed snapshot.');
    }
    const lane = await this.candidateLane(draft, submission);
    if (lane === 'validation' && draft.conflicts.length > 0) {
      throw new WorkerError('candidate_mismatch', 'A validation-lane candidate is only allowed when the derived seed has no conflicts.');
    }
    if (lane === 'validation' && submission.revision !== 0) {
      throw new WorkerError('candidate_mismatch', 'A validation-lane candidate must be the unchanged derived snapshot at revision 0.');
    }
    if (draft.conflicts.length > 0 && (lane !== 'integration' || submission.revision === 0)) {
      throw new WorkerError('candidate_mismatch', 'A conflict attempt requires an integration-lane candidate at revision > 0 that resolves the derived conflicts.');
    }
    return lane;
  }

  /** The candidate must be a current governed service-lane worker of this team. */
  private async candidateLane(attempt: Attempt, submission: SealedSubmission): Promise<'integration' | 'validation'> {
    const board = await this.ports.board();
    const team = board.getTeam({ kind: 'coordinator', ownerId: attempt.ownerId }, attempt.teamId);
    if (!team.memberWorkerIds.includes(submission.workerId)) {
      throw new WorkerError('member_invalid', 'The candidate seal worker is not a current member of this team.');
    }
    const session = this.ports.session(submission.workerId);
    if (!session || session.createdAt !== submission.workerCreatedAt) {
      throw new WorkerError('worker_mismatch', 'The candidate seal has no exact current session creation identity.');
    }
    if (session.ownerId !== attempt.ownerId) {
      throw new WorkerError('owner_mismatch', 'The candidate seal worker belongs to a different coordinator.');
    }
    if (session.workspaceRoot !== team.workspaceRoot) {
      throw new WorkerError('worker_mismatch', 'The candidate seal worker is bound to a different workspace root.');
    }
    const binding = session.isolatedView;
    if (!binding || binding.teamId !== attempt.teamId || binding.snapshotId !== submission.snapshotId) {
      throw new WorkerError('worker_mismatch', 'The candidate seal worker is not permanently bound to this team and derived snapshot.');
    }
    const lane = session.startup?.lane;
    if (lane !== 'integration' && lane !== 'validation') {
      throw new WorkerError('service_lane_required', 'Only a governed validation- or integration-lane worker may propose an integration candidate.');
    }
    return lane;
  }

  // -- validate -------------------------------------------------------------

  private async validate(action: z.infer<typeof validateAction>, authorize: () => void): Promise<unknown> {
    const fingerprint = digest(canonical(action));
    const attempt = this.findAttempt(action.attemptId, action.ownerId, action.teamId);
    if (this.replayed(attempt, 'validate', action.requestId, fingerprint)) {
      return this.view(attempt, 'validate', true);
    }
    this.requireMutable(attempt);
    this.requireRevision(attempt, action.expectedRevision);
    if (attempt.status !== 'candidate' || !attempt.candidate) {
      throw new WorkerError('state_invalid', `Validation requires a candidate; this attempt is ${attempt.status}.`);
    }
    if (attempt.candidate.submission.revision === 0 && attempt.candidate.lane === 'validation' && action.evidence.length === 0) {
      throw new WorkerError('validation_evidence_mismatch', 'Validation requires one scoped runner result per immutable command.');
    }
    if (action.evidence.length !== attempt.validationCommands.length) {
      throw new WorkerError('validation_evidence_mismatch', `Provide exactly one runner result for each of the ${attempt.validationCommands.length} immutable validation commands.`);
    }
    if (new Set(action.evidence.map(ref => `${ref.id}:${ref.version}`)).size !== action.evidence.length) {
      throw new WorkerError('validation_evidence_mismatch', 'Each validation command needs a distinct runner result.');
    }
    this.assertRequestCapacity(attempt, 'validate', action.requestId);
    const draft = structuredClone(attempt);
    const scope = this.scope(draft);
    // No evidence is pinned for a candidate whose stored lineage is unproved.
    await this.requireAncestryProof(draft, authorize);
    const checks: EvidenceCheck[] = action.evidence.map((ref, index) => ({
      ref,
      submission: draft.candidate!.submission,
      command: draft.validationCommands[index]
    }));
    authorize();
    await this.ports.pinEvidence(scope, checks, authorize);
    draft.validations = action.evidence.map((result, index) => ({
      command: draft.validationCommands[index],
      result: { id: result.id, version: result.version, uri: result.uri },
      at: new Date().toISOString()
    }));
    draft.status = 'validated';
    draft.revision += 1;
    draft.updatedAt = new Date().toISOString();
    this.recordRequest(draft, 'validate', action.requestId, fingerprint);
    await this.save(draft, authorize);
    return this.view(draft, 'validate', false);
  }

  // -- accept ---------------------------------------------------------------

  private async accept(action: z.infer<typeof acceptAction>, authorize: () => void): Promise<unknown> {
    const fingerprint = digest(canonical(action));
    const attempt = this.findAttempt(action.attemptId, action.ownerId, action.teamId);
    if (this.replayed(attempt, 'accept', action.requestId, fingerprint)) {
      return this.view(attempt, 'accept', true);
    }
    this.requireMutable(attempt);
    this.requireRevision(attempt, action.expectedRevision);
    if (attempt.status !== 'validated' || attempt.validations.length !== attempt.validationCommands.length) {
      throw new WorkerError('state_invalid', `Acceptance requires a validated candidate; this attempt is ${attempt.status}.`);
    }
    // One decision, two acknowledgments of the SAME exact union: the full list or
    // the compact digest the view reports. A nonempty list mixed with a digest is
    // ambiguous, so it is refused with no capacity change and no effect.
    if (action.resolvedPathsDigest !== undefined && action.resolvedPaths.length > 0) {
      throw new WorkerError('invalid_arguments', 'Acknowledge the conflict paths with either the exact resolvedPaths list or its resolvedPathsDigest, never both.');
    }
    if (action.resolvedPathsDigest !== undefined) {
      const expected = conflictPathsDigest(attempt.id, attempt.conflicts);
      if (action.resolvedPathsDigest !== expected) {
        throw new WorkerError('conflict_paths_mismatch', `resolvedPathsDigest does not match this attempt's exact conflict path union (${expected}). Re-read status and send the conflictPathsDigest it reports.`);
      }
    } else if (new Set(action.resolvedPaths).size !== action.resolvedPaths.length || !samePaths(action.resolvedPaths, conflictPaths(attempt.conflicts))) {
      throw new WorkerError('conflict_paths_mismatch', attempt.conflicts.length
        ? 'resolvedPaths must name every conflict path of this attempt exactly, once.'
        : 'This attempt has no conflicts, so resolvedPaths must be empty.');
    }
    this.assertRequestCapacity(attempt, 'accept', action.requestId);
    const draft = structuredClone(attempt);
    // Acceptance is metadata-only, but it is still a durable decision: an
    // unproved legacy lineage is refused before any acceptance is recorded.
    await this.requireAncestryProof(draft, authorize);
    draft.acceptance = action.resolvedPathsDigest === undefined
      // A legacy full-list approval keeps its exact, canonically ordered union.
      ? { resolvedPaths: sortedUnique(action.resolvedPaths), requestId: action.requestId, at: new Date().toISOString() }
      // A digest approval persists ONLY the digest it verified. Every reader -
      // this view, the ancestry proofs and a fresh publication decision - derives
      // the exact union from the same immutable conflict groups, so no path list
      // is written twice.
      : { resolvedPathsDigest: action.resolvedPathsDigest, requestId: action.requestId, at: new Date().toISOString() };
    draft.status = 'accepted';
    draft.revision += 1;
    draft.updatedAt = new Date().toISOString();
    this.recordRequest(draft, 'accept', action.requestId, fingerprint);
    // Accept is metadata-only; the durable write below is the explicit decision.
    return this.save(draft, authorize).then(() => this.view(draft, 'accept', false));
  }

  // -- apply ----------------------------------------------------------------

  private async apply(action: z.infer<typeof applyAction>, authorize: () => void): Promise<unknown> {
    const fingerprint = digest(canonical(action));
    const attempt = this.findAttempt(action.attemptId, action.ownerId, action.teamId);
    const replay = this.replayed(attempt, 'apply', action.requestId, fingerprint);
    if (attempt.status === 'released' || attempt.status === 'abandoned' || attempt.status === 'releasing') {
      throw new WorkerError('attempt_released', 'This integration attempt was explicitly released; it cannot be published.');
    }
    if (attempt.seedOnly) {
      throw new WorkerError('dependency_only', 'A consumer (dependency seed) begin creates a private seed only and cannot publish.');
    }
    if (attempt.status === 'interrupted') {
      if (replay) {
        // A durable journal result is proof, not an invitation: the exact replay
        // returns it and never touches the workspace again.
        return this.view(attempt, 'apply', true);
      }
      throw new WorkerError('attempt_interrupted', 'This attempt’s publication was durably interrupted; it cannot publish again. Release it and begin a new attempt.');
    }
    if (replay) {
      // Only the receipt of the CURRENT durable applying decision may re-enter
      // the journal: the host proves each file's state and never repeats an
      // effect. An older exact replay only OBSERVES the current state, so a
      // superseded decision can never be attributed to, or published by, the
      // record a newer in-flight one owns.
      if (attempt.status === 'applying' && attempt.apply?.requestId === action.requestId) {
        // save() reserves the report and release room for every durable write.
        // Prove ancestry without recording a marker. The existing applying
        // record already reserves its report and release, and a marker could
        // exceed that reservation at a before-effect journal checkpoint.
        const draft = structuredClone(attempt);
        // A stored compact acceptance that no longer reproduces this attempt's
        // conflict union is NOT an approval, so this replay may only resolve the
        // journal work that already started: proof-only, with no fresh journal and
        // no new or pending workspace effect. The required-journal latch, the
        // revision floor and an explicit release are untouched, so a pending
        // publication is still exposed as a retryable conflict and never stranded.
        const proofOnly = storedAcceptancePaths(attempt) === null;
        const unproved = ['ancestry_unproved', 'ancestry_mismatch', 'ancestry_unavailable', 'ancestry_invalid', 'ancestry_unresolved'];
        try {
          if (!proofOnly) {
            await this.requireAncestryProof(draft, authorize, false);
          }
        } catch (error) {
          if (!(error instanceof WorkerError) || !unproved.includes(error.code)) {
            throw error;
          }
          // Recovery stays available for an OLD applying record whose lineage
          // this store cannot prove: only the journal work that already started
          // may be reconciled - by proof only, with no fresh journal and no new
          // or pending workspace effect. The real journal proof (required latch,
          // revision floor) is kept, and pending work is exposed as a retryable
          // conflict so an explicit release is never stranded.
          return this.publish(draft, action, authorize, true);
        }
        return this.publish(draft, action, authorize, proofOnly);
      }
      return this.view(attempt, 'apply', true);
    }
    this.requireMutable(attempt);
    this.requireRevision(attempt, action.expectedRevision);
    if (attempt.status !== 'accepted' || !attempt.acceptance || !attempt.candidate) {
      throw new WorkerError('state_invalid', `Apply requires an accepted attempt; this is ${attempt.status}.`);
    }
    // A fresh publication rests on the SAME acceptance proof lineage reads: a
    // digest-shaped acceptance whose digest no longer reproduces this attempt's
    // conflict union fails closed here, before any publication intent exists.
    acceptancePaths(attempt);
    if (attempt.apply?.state === 'applying') {
      throw new WorkerError('application_in_flight', 'Retry the exact original apply request; a different decision cannot supersede an in-flight publication.');
    }
    this.assertRequestCapacity(attempt, 'apply', action.requestId);
    const draft = structuredClone(attempt);
    // A FRESH publication decision may never start on an unproved lineage. The
    // proof is recorded on this same applying draft, so its marker costs exactly
    // what the capacity projection measures (reservedBytes still covers the
    // bounded report) and a journal checkpoint never grows the record.
    await this.requireAncestryProof(draft, authorize);
    this.captureJournalLatch(draft, attempt);
    draft.apply = { state: 'applying', requestId: action.requestId, applied: [], conflicts: [], at: new Date().toISOString() };
    draft.status = 'applying';
    draft.revision += 1;
    draft.updatedAt = new Date().toISOString();
    this.recordRequest(draft, 'apply', action.requestId, fingerprint);
    // save() refuses an intent that would leave no room for its own bounded
    // terminal report and an explicit release, so this publication can never be
    // stranded by a rejected final checkpoint.
    // Durable publication intent BEFORE any workspace effect.
    await this.save(draft, authorize);
    return this.publish(draft, action, authorize);
  }

  /**
   * One publication call. `recoveryOnly` is the storage-pressure fallback: the
   * port resolves durable journal state and this method records exactly that
   * result, but no new or pending workspace effect and no fresh journal can
   * start. The latch is handed over as the awaited `onJournalReady` callback, so
   * it is durable before the port's first workspace effect.
   */
  private async publish(draft: Attempt, action: z.infer<typeof applyAction>, authorize: () => void, recoveryOnly = false): Promise<unknown> {
    const candidate = draft.candidate;
    const baseSnapshotId = draft.baseSnapshotId;
    if (!candidate || !baseSnapshotId) {
      throw new WorkerError('state_invalid', 'A publication needs the accepted candidate and its derived seed snapshot.');
    }
    const scope = this.scope(draft);
    // Only an explicit `false` proves that no journal and no effect can exist for
    // this attempt; `true` and an unknown legacy state both require the journal.
    const options: IntegrationPublicationOptions = {
      requireJournal: draft.publicationJournalEstablished !== false,
      onJournalReady: this.journalReady(draft, authorize),
      // The floor this attempt is already proved to have reached, plus the
      // checkpoint that raises it after each durable per-file intent and before
      // that file's first workspace effect.
      minimumJournalRevision: draft.publicationJournalRevision,
      onJournalIntent: this.journalIntent(draft, authorize),
      recoveryOnly
    };
    authorize();
    let result: PublishResult;
    try {
      result = parsePublishResult(await this.ports.publish(scope, baseSnapshotId, candidate.artifact, authorize, options));
    } catch (error) {
      const failed = structuredClone(draft);
      failed.updatedAt = new Date().toISOString();
      failed.failure = {
        code: error instanceof WorkerError ? error.code : 'publish_failed',
        message: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        at: failed.updatedAt
      };
      try {
        await this.save(failed, authorize);
      } catch {
        // Keep the durable applying intent; the exact replay can recover.
      }
      throw error;
    }
    const completed = structuredClone(draft);
    completed.apply = {
      state: result.state,
      requestId: action.requestId,
      ...boundedApplyReport(result),
      // applied and conflicts are the exact result, or a bounded preview that
      // also records its exact totals and truncation.
      at: new Date().toISOString()
    };
    if (result.state === 'applied') {
      completed.status = 'applied';
    } else if (result.state === 'interrupted') {
      // The journal recorded that an effect may have started. That proof is
      // terminal and never repeated: the result is exposed, an exact replay
      // returns it, and only an explicit abandon/release may follow.
      completed.status = 'interrupted';
    } else {
      completed.status = 'accepted';
    }
    completed.revision += 1;
    completed.updatedAt = new Date().toISOString();
    this.recordRequest(completed, 'apply', action.requestId, digest(canonical(action)));
    await this.save(completed, authorize);
    return this.view(completed, 'apply', false);
  }

  /**
   * Initializes the durable journal latch of a NEW apply checkpoint. The latch is
   * never downgraded: once a journal was established it stays required across
   * conflict retries and reopens. A first publication is explicitly `false`
   * because nothing has been written yet, so a fresh plan is still safe. A legacy
   * terminal conflict that reports applied paths (or their exact count) proves a
   * journal existed and is initialized to `true`; a legacy record whose ONE
   * completed publication result is the port's open-editor preflight conflict
   * proves the opposite - no journal and no effect ever existed - and is
   * initialized to `false` so a closed-editor retry may plan again. Every other
   * legacy record keeps the field absent, which the port reads as "journal
   * required".
   */
  private captureJournalLatch(draft: Attempt, previous: Attempt): void {
    if (previous.publicationJournalEstablished !== undefined) {
      draft.publicationJournalEstablished = previous.publicationJournalEstablished;
      return;
    }
    const legacy = previous.apply;
    if (legacy?.state === 'conflict' && (legacy.applied.length > 0 || (legacy.appliedCount ?? 0) > 0)) {
      draft.publicationJournalEstablished = true;
      return;
    }
    if (legacyZeroEffect(previous)) {
      // A trustworthy zero-effect result: the publication port refused every
      // change at its read-only preflight, before its first journal revision.
      draft.publicationJournalEstablished = false;
      return;
    }
    if (previous.apply === undefined) {
      // First publication decision of this attempt: no journal and no effect.
      draft.publicationJournalEstablished = false;
    }
  }

  /**
   * The awaited `onJournalReady` callback handed to the publication port: it
   * persists the latch as soon as a valid journal exists, i.e. BEFORE any
   * workspace effect can start. It is idempotent and re-checks authorization
   * through save(), so a revoked call keeps the previous durable record and the
   * publication aborts without an effect.
   */
  private journalReady(draft: Attempt, authorize: () => void): () => Promise<void> {
    return async () => {
      if (draft.publicationJournalEstablished === true) {
        return;
      }
      const latched = structuredClone(draft);
      latched.publicationJournalEstablished = true;
      latched.updatedAt = new Date().toISOString();
      await this.save(latched, authorize);
      draft.publicationJournalEstablished = true;
    };
  }

  /**
   * Shape admission of a storage-pressure fallback, evaluated BEFORE the store is
   * read: only an apply under a real `storage_exhausted` denial is considered at
   * all, so every other recovery request is refused before anything is loaded.
   * The marker itself is decided inside the loader's single read, where an absent
   * marker becomes this exact original denial and nothing can bootstrap the store.
   */
  private requireRecoveryShape(action: IntegrationAction, error: WorkerError): void {
    if (!(error instanceof WorkerError) || error.code !== 'storage_exhausted' || action.action !== 'apply') {
      throw error;
    }
  }

  /**
   * Storage-pressure recovery, entered only under the attempts mutex. A real
   * `storage_exhausted` admission denial permits exactly one thing: the exact
   * CURRENT applying receipt of this attempt re-enters its journal in proof-only
   * mode. Every other call - a different requestId, a stale fingerprint, a
   * released or terminal attempt, another action - rethrows that original error
   * BEFORE any publication intent, receipt or workspace effect.
   */
  private async recover(action: IntegrationAction, authorize: () => void, error: WorkerError): Promise<unknown> {
    if (!(error instanceof WorkerError) || error.code !== 'storage_exhausted' || action.action !== 'apply') {
      throw error;
    }
    const attempt = this.requireData().attempts.find(entry =>
      entry.id === action.attemptId && entry.ownerId === action.ownerId && entry.teamId === action.teamId);
    const fingerprint = digest(canonical(action));
    if (attempt === undefined
      || attempt.status !== 'applying'
      || attempt.apply?.state !== 'applying'
      || attempt.apply.requestId !== action.requestId
      || !attempt.requests.some(entry => entry.action === 'apply'
        && entry.requestId === action.requestId && entry.fingerprint === fingerprint)) {
      throw error;
    }
    return this.publish(structuredClone(attempt), action, authorize, true);
  }

  // -- release --------------------------------------------------------------

  private async release(action: z.infer<typeof releaseAction>, authorize: () => void): Promise<unknown> {
    const fingerprint = digest(canonical(action));
    const attempt = this.findAttempt(action.attemptId, action.ownerId, action.teamId);
    const replay = this.replayed(attempt, 'release', action.requestId, fingerprint);
    if (replay && attempt.status !== 'releasing') {
      return this.view(attempt, 'release', true);
    }
    if (attempt.apply?.state === 'applying' || attempt.status === 'applying') {
      throw new WorkerError('application_in_flight', 'An unresolved publication keeps its pins. Retry the exact apply request first; release is refused.');
    }
    if (attempt.status === 'released' || attempt.status === 'abandoned') {
      return this.view(attempt, 'release', replay);
    }
    if (!replay) {
      this.requireRevision(attempt, action.expectedRevision);
    }
    this.assertRequestCapacity(attempt, 'release', action.requestId);
    const draft = structuredClone(attempt);
    if (draft.status !== 'releasing') {
      draft.status = 'releasing';
      draft.revision += 1;
      draft.updatedAt = new Date().toISOString();
      this.recordRequest(draft, 'release', action.requestId, fingerprint);
      // The release/abandon decision is durable before any pin is dropped.
      await this.save(draft, authorize);
    }
    const scope = this.scope(draft);
    authorize();
    await this.ports.releasePins(scope, authorize);
    draft.pinState = 'none';
    draft.evidencePinned = false;
    draft.status = draft.apply?.state === 'applied' ? 'released' : 'abandoned';
    draft.revision += 1;
    draft.updatedAt = new Date().toISOString();
    await this.save(draft, authorize);
    return this.view(draft, 'release', false);
  }
}
