// Durable shared snapshots and private worker views.
//
// The host owns the root SessionStore lock. One business mutex serializes
// captures, coherent layered operations, immutable submissions and retention.
import { promises as fs, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ContentStore, isFileMode } from './snapshot-content';
import { LayeredTree } from './layered-tree';
import type { SnapshotEntry, SnapshotManifest } from './snapshot-content';
import type { SnapshotBacking, CapturedProject, PendingCapture, StoredSnapshot, OverlayRecord, OverlayRevision, SealedSubmission, ViewPin, ViewReceipt, IsolatedViewBinding, IntegrationArtifactRef, IntegrationComposition, IntegrationConflictHop, IntegrationScope, IntegrationSnapshotProvenance, IntegrationSourceAncestry, StartupBindIdentity } from './isolated-view-types';
import { mergeIntegrationTrees } from './integration-merge';
import { IsolatedIndex, validateIndex, parseStoredSnapshot, parseOverlayRecord, parseSealedSubmission, parseViewPin } from './isolated-index';
import type { ViewIndexData } from './isolated-index';
import type { IsolatedViewPort, IsolatedViewState, IsolatedViewIdentity } from './isolated-view-port';
import { loadRevisionTree, revisionState, MAX_OVERLAY_REVISIONS, parseOverlayRevision } from './overlay-revisions';
import { createProjectContentReader, readProjectContent, ensureProjectRetention, releaseProjectRetention } from './project-snapshot';
import { sweepViewContent } from './isolated-cas-cleanup';
import { epochRequest, completeArchiveDeletions, currentEpoch, MAX_RECEIPT_ARCHIVE_FILES, planArchivePublication, preflightArchivePublication, publishArchivePublication, selectPublicationReceipts, verifyArchive } from './receipt-retention';
import type { ReceiptArchive, ReceiptArchivePublication } from './receipt-retention';
import { digest, Mutex } from './storage';
import { WorkerError } from './types';

const sha256 = (value: string | string[]): string =>
  createHash('sha256').update(Array.isArray(value) ? JSON.stringify(value) : value).digest('hex');

const HEX64 = /^[a-f0-9]{64}$/;
const TEAM32 = /^[a-f0-9]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isIso = (value: string): boolean => ISO_RE.test(value) && Number.isFinite(Date.parse(value));
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && [null, Object.prototype].includes(Object.getPrototypeOf(value));

/** Internal integration pins: a reserved name prefix, per attempt and resource. */
const INTEGRATION_PIN_PREFIX = 'integration:';
/** One integration batch: the service itself bounds a begin to this many sources. */
const MAX_INTEGRATION_REFS = 16;
/**
 * Deepest stored derived-lineage one composition may carry. A chain longer than
 * this is corrupt (or hostile), never walked further.
 */
const MAX_INTEGRATION_ANCESTRY = 64;

const sha256Bytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const sameIntegrationRef = (a: IntegrationArtifactRef, b: IntegrationArtifactRef): boolean =>
  a.id === b.id && a.version === b.version && a.uri === b.uri;

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_FILES = 10_000;
const MAX_MANIFEST_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_TOTAL_BYTES = 512 * 1024 * 1024;
/**
 * The ONE combined pre-write bound for a composition's DISTINCT payload bytes:
 * every synthesized merge result plus every native Git blob the final seed still
 * references, each counted at most once per hash for the whole attempt. It is the
 * same 512 MiB the manifest tree may reference, so anything the derived seed can
 * name fits, while the rest of the 600 MiB `begin` reservation stays metadata
 * room for the 32 MiB manifest and the durable attempt/index records. Bytes are
 * charged BEFORE they are written, so a refused composition never crosses it.
 */
const MAX_COMPOSITION_PAYLOAD_BYTES = MAX_MANIFEST_TOTAL_BYTES;

function invalid(message: string): never {
  throw new WorkerError('isolation_invalid', message);
}
function conflict(message: string): never {
  throw new WorkerError('isolation_conflict', message);
}
/** Type-preserving strict string checks for untrusted input records. */
function requireString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    invalid(`${field} must be a ${minimum}..${maximum} character string.`);
  }
  return value;
}
function requireTeam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TEAM32.test(value)) {
    invalid(`${field} must be 32 lowercase hex characters.`);
  }
  return value;
}
function requireHex64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    invalid(`${field} must be 64 lowercase hex characters.`);
  }
  return value;
}
function requireIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isIso(value)) {
    invalid(`${field} must be an ISO timestamp (mandatory; worker IDs are reused).`);
  }
  return value;
}

export interface IsolatedViewsOptions {
  withStorageWrite?: <T>(action: () => Promise<T>) => Promise<T>;
  /** Live host guard (closing/feature flag/revocation); throws to abort. */
  guard?: () => void;
  /**
   * Live, trusted governance flag. `false` means this namespace is not governed,
   * so an epoch-prefixed request ID is an ordinary fresh identity while no owner
   * has rolled over. Absent keeps the governed rules; per-request input can
   * never change it.
   */
  governanceEnabled?: () => boolean;
  /** Reads verified immutable Git or CAS bytes; never a live workspace path. */
  readContent?: (backing: SnapshotBacking, content: ContentStore, contentHash: string, guard?: () => void) => Promise<Buffer>;
  /** Confirms a Git-backed snapshot's objects remain reachable; failure aborts. */
  ensureRetention?: (snapshotId: string, backing: SnapshotBacking, guard?: () => void) => Promise<void>;
  releaseRetention?: typeof releaseProjectRetention;
  /**
   * This namespace is a known live session marker: the view directory must
   * still exist with its index. A missing index or a deleted directory fails
   * closed as corrupt instead of silently starting a fresh store.
   */
  expectExisting?: boolean;
}

export interface CreateSnapshotInput {
  ownerId: string;
  teamId: string;
  requestId: string;
  selectionKey: string;
}

export interface BindInput {
  ownerId: string;
  teamId: string;
  snapshotId: string;
  workerId: string;
  workerCreatedAt: string;
  requestId: string;
}

export interface SnapshotInspection {
  revision: number;
  snapshots: StoredSnapshot[];
  overlays: OverlayRecord[];
  submissions: SealedSubmission[];
  pins: ViewPin[];
  pendingCaptures: { snapshotId: string; fingerprint: string }[];
}

export interface RetentionScope {
  ownerId: string;
  teamId: string;
  requestId: string;
}

/** Only a confirmed absent original Session file is "missing". */
export type WorkerViewPresence = { state: 'missing' } | { state: 'unknown' }
  | { state: 'present'; workerCreatedAt: string; binding?: IsolatedViewBinding };

export interface ViewCleanupResult {
  deletedSnapshots: string[];
  releasedOverlays: string[];
  recoveredBindings: number;
  deletedSubmissions: number;
  deletedBlobs: number;
  deletedBytes: number;
  preservedUnknown: number;
  diagnostics: string[];
  diagnosticCount: number;
  complete: boolean;
}

/**
 * One scoped governed-runner input reclamation: the inputs marked released for
 * the existing CAS cleanup, and how many eligible inputs were kept because a
 * reference or native pin still retains them.
 */
export interface RunnerInputReclamation {
  released: string[];
  preserved: number;
}

export class IsolatedViews implements IsolatedViewPort {
  readonly content: ContentStore;
  /** Stable namespace identity: SHA-256 of the resolved store directory. */
  readonly namespace: string;
  private readonly index: IsolatedIndex;
  private readonly externalGuard: () => void;
  private readonly ensureRetention: typeof ensureProjectRetention;
  private readonly readContent?: typeof readProjectContent;
  private readonly releaseRetention: typeof releaseProjectRetention;
  private readonly expectExisting: boolean;
  private readonly governanceEnabled?: () => boolean;
  private readonly withStorageWrite: <T>(action: () => Promise<T>) => Promise<T>;
  private readonly mutex = new Mutex();
  private opened = false;
  private failedOpen = false;
  private closing = false;

  constructor(readonly directory: string, root: string, options: IsolatedViewsOptions = {}) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.length > 8192) {
      throw new WorkerError('invalid_path', 'The views directory must be a nonempty path string.');
    }
    if (typeof root !== 'string' || root.length === 0 || root.length > 8192 || !path.isAbsolute(root)) {
      throw new WorkerError('invalid_path', 'The views root must be a native absolute path.');
    }
    if (options.expectExisting !== undefined && typeof options.expectExisting !== 'boolean') {
      invalid('The expectExisting option must be a boolean.');
    }
    this.withStorageWrite = options.withStorageWrite ?? (action => action());
    this.externalGuard = options.guard ?? (() => undefined);
    this.ensureRetention = options.ensureRetention ?? ensureProjectRetention;
    this.readContent = options.readContent;
    this.releaseRetention = options.releaseRetention ?? releaseProjectRetention;
    this.expectExisting = options.expectExisting === true;
    this.governanceEnabled = options.governanceEnabled;
    const resolvedDir = path.resolve(directory);
    const resolvedRoot = path.resolve(root);
    // The content store must sit OUTSIDE the canonical workspace root before
    // any write: nested stores let a capture select its own journal bytes.
    this.assertStoreOutsideRoot(resolvedDir, resolvedRoot);
    this.namespace = sha256(resolvedDir);
    this.content = new ContentStore(path.join(resolvedDir, 'content'), { guard: this.checkAlive });
    this.index = new IsolatedIndex(resolvedDir, resolvedRoot, { guard: this.checkAlive,
      // Only the live host says whether this namespace is ungoverned; the
      // request itself never can, and an unwired handle stays governed.
      requestIdPolicy: { ordinaryRequestIds: () => this.governanceEnabled?.() === false } });
  }

  /** Rejects a store that is inside the root, via path form or junction alias. */
  private assertStoreOutsideRoot(resolvedDir: string, resolvedRoot: string): void {
    if (!nativeStoreOutsideRoot(resolvedDir, resolvedRoot)) {
      throw new WorkerError('isolation_corrupt', 'The views store directory must be outside the workspace root.');
    }
  }

  private checkAlive = (): void => {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'The isolated views are stopping and draining.');
    }
    this.externalGuard();
  };

  /** Live guard plus the operation's queued re-authorization, when present. */
  private authorize(guard?: () => void): void {
    this.checkAlive();
    guard?.();
  }

  private assertReady(): ViewIndexData {
    this.checkAlive();
    if (!this.opened) {
      throw new WorkerError('unavailable', 'The isolated views are not open; call open() first.');
    }
    return this.index.read();
  }

  /** Strictly validates (or starts) the shared index; idempotent. */
  async open(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.failedOpen) {
        throw new WorkerError('isolation_corrupt', 'This view handle failed to open. Restore storage and construct a new handle; cached empty state cannot be reused.');
      }
      this.checkAlive();
      if (this.opened) {
        return;
      }
      try {
        this.assertStoreOutsideRoot(this.index.directory, this.index.root);
        const hadIndexFile = await pathExists(this.index.file);
        if (!hadIndexFile && this.expectExisting) {
        // A known live session marker whose index (or whole view dir) is gone
        // is corrupt; it must never silently start a fresh store.
          throw new WorkerError('isolation_corrupt', 'A known session view is missing its index file.');
        }
        await this.index.open();
        this.checkAlive();
        if (!hadIndexFile) {
        // Existing content or blobs without an index: a store whose index was
        // lost must fail closed; never adopt foreign bytes as a fresh start.
          if (await pathExists(this.content.directory)) {
            throw new WorkerError('isolation_corrupt', 'Content exists but the index is missing; refusing to start a fresh store over it.');
          }
          // A fresh start MUST durably publish its empty index before any CAS or
          // index write, so a later crash still leaves a complete store.
          await this.index.update(() => undefined);
        }
        for (const archive of this.index.read().receiptArchives ?? []) {
          await verifyArchive(this.directory, archive);
        }
        this.opened = true;
      } catch (error) {
        this.failedOpen = true;
        await this.index.close();
        throw error;
      }
    });
  }

  /** Immediately starts closing, then drains queued operations and the index. */
  async close(): Promise<void> {
    this.closing = true;
    await this.mutex.run(async () => {
      this.opened = false;
      await this.index.close();
    });
  }

  // -- createSnapshot --------------------------------------------------------

  async createSnapshot(
    input: CreateSnapshotInput,
    capture: (snapshotId: string, recordCandidate: (candidate: CapturedProject) => Promise<void>) => Promise<CapturedProject>,
    authorize?: () => void
  ): Promise<StoredSnapshot> {
    return this.mutex.run(() => this.withStorageWrite(async () => {
      this.authorize(authorize);
      if (!this.opened) {
        throw new WorkerError('unavailable', 'The isolated views are not open; call open() first.');
      }
      if (!isPlain(input)) {
        invalid('createSnapshot input must be an object.');
      }
      const expectedKeys = new Set(['ownerId', 'teamId', 'requestId', 'selectionKey']);
      if (Object.keys(input).some(key => !expectedKeys.has(key))) {
        invalid('createSnapshot input has unknown fields.');
      }
      const raw = input as Record<string, unknown>;
      const ownerId = requireString(raw.ownerId, 'ownerId', 1, 200);
      const teamId = requireTeam(raw.teamId, 'teamId');
      const requestId = requireString(raw.requestId, 'requestId', 1, 200);
      const selectionKey = requireString(raw.selectionKey, 'selectionKey', 1, 4096);

      // Stable identity: scoped by owner/request, never by the mutable team.
      const snapshotId = sha256(['create', this.namespace, ownerId, requestId]);
      this.index.request(ownerId, requestId, snapshotId);
      const receiptKey = sha256(['create', this.namespace, ownerId, requestId]);
      // Fingerprint covers every requested argument, never editor/workspace state.
      const fingerprint = sha256(['create', this.namespace, ownerId, teamId, requestId, selectionKey]);

      const data = this.assertReady();
      const receipt = data.receipts[receiptKey];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          conflict(`Request ${requestId} was already used with different arguments.`);
        }
        if (isPlain(receipt.result) && receipt.result.cancelledCapture === snapshotId) {
          throw new WorkerError('isolation_released', 'This capture request was explicitly discarded. Use a new requestId for a new snapshot.');
        }
        // Replay parses and validates the durable ACK against this request;
        // a corrupt result is isolation_corrupt, never a re-capture.
        return this.validateReceiptResult(
          receipt,
          parseStoredSnapshot,
          (value) => {
            this.validateBacking(value.backing, value.id);
            return value.id === snapshotId && value.teamId === teamId && value.ownerId === ownerId;
          }
        );
      }
      const pending = data.pendingCaptures[snapshotId];
      if (pending) {
        if (pending.receiptKey !== receiptKey || pending.fingerprint !== fingerprint
          || pending.snapshot.ownerId !== ownerId || pending.snapshot.teamId !== teamId) {
          conflict(`Snapshot ${snapshotId} is already pending a different request.`);
        }
        // Durable recovery: no re-capture, ever.
        return this.finalizeGitPending(pending, snapshotId, fingerprint, receiptKey, authorize);
      }
      if (data.snapshots[snapshotId]) {
        conflict(`Snapshot ${snapshotId} already exists.`);
      }

      // Manifest hash published by recordCandidate; the driver result must
      // agree with it, or the capture is inconsistent and fails.
      let candidateHash: string | undefined;
      let candidateBacking: SnapshotBacking | undefined;
      const recordCandidate = async (candidate: CapturedProject): Promise<void> => {
        this.authorize(authorize);
        const { manifest, capturedAt } = this.validateManifest(candidate.manifest);
        const backing = this.validateBacking(candidate.backing, snapshotId);
        const manifestText = JSON.stringify(manifest);
        if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) {
          throw new WorkerError('snapshot_capacity', 'The serialized manifest exceeds 32 MiB.');
        }
        const manifestHash = sha256(manifestText);
        if (candidateHash !== undefined) {
          if (candidateHash !== manifestHash || !candidateBacking || !sameBacking(candidateBacking, backing)) {
            conflict('The first capture candidate is immutable.');
          }
          return;
        }
        const stored: StoredSnapshot = {
          id: snapshotId, teamId, ownerId, manifestHash, backing, createdAt: capturedAt
        };
        this.preflightIndex(draft => this.applyFinalize(draft, stored, this.snapshotPin(stored), fingerprint, receiptKey));
        if (await this.content.put(Buffer.from(manifestText, 'utf8'), authorize) !== manifestHash) {
          throw new WorkerError('snapshot_content_missing', 'The stored manifest hash changed.');
        }
        this.authorize(authorize);
        candidateHash = manifestHash;
        candidateBacking = backing;
        if (backing.kind === 'git') {
          // The full manifest + backing journal is durable BEFORE this
          // callback resolves, so a crash after the Git ref effect is
          // recoverable without re-capture.
          this.preflightIndex(draft => {
            if (draft.pendingCaptures[snapshotId]) {
              conflict(`Snapshot ${snapshotId} already has a pending capture journal.`);
            }
            draft.pendingCaptures[snapshotId] = { snapshot: stored, receiptKey, fingerprint };
          });
          await this.index.update(draft => {
            if (draft.snapshots[snapshotId] || draft.receipts[receiptKey]) {
              throw new WorkerError('isolation_conflict', `Snapshot ${snapshotId} was committed while capturing.`);
            }
            if (draft.pendingCaptures[snapshotId]) {
              throw new WorkerError('isolation_conflict', `Snapshot ${snapshotId} already has a pending capture journal.`);
            }
            draft.pendingCaptures[snapshotId] = { snapshot: stored, receiptKey, fingerprint };
          }, authorize);
        }
      };

      let project: CapturedProject;
      try {
        project = await capture(snapshotId, recordCandidate);
      } catch (error) {
        this.authorize(authorize);
        throw error;
      }
      this.authorize(authorize);

      const { manifest, capturedAt } = this.validateManifest(project.manifest);
      const manifestText = JSON.stringify(manifest);
      const manifestHash = sha256(manifestText);
      const backing = this.validateBacking(project.backing, snapshotId);
      const journal = this.index.read().pendingCaptures[snapshotId];
      if (backing.kind === 'git') {
        // A Git capture that never invoked recordCandidate published no
        // durable journal and MUST fail, never pretend it is registered.
        if (!journal) {
          throw new WorkerError('isolation_unavailable', 'A Git capture must publish its journal through recordCandidate before the driver returns.');
        }
        // The driver return must match the FULL first candidate, not a CAS.
        if (journal.snapshot.id !== snapshotId || journal.snapshot.manifestHash !== manifestHash || !sameBacking(journal.snapshot.backing, backing)) {
          conflict('The driver result does not match the published capture journal.');
        }
        return this.finalizeGitPending(journal, snapshotId, fingerprint, receiptKey, authorize);
      }
      if (journal) {
        conflict('A CAS capture must not publish a pending journal.');
      }
      if (candidateHash !== undefined && (candidateHash !== manifestHash || !candidateBacking || !sameBacking(candidateBacking, backing))) {
        conflict('The driver result does not match the manifest stored during the capture.');
      }
      if (candidateHash === undefined) {
        // No recordCandidate ran for a CAS capture: store the manifest once;
        // finalizeSnapshot prefights the full final state before committing,
        // and the record must always resolve from CAS.
        const putHash = await this.content.put(Buffer.from(manifestText, 'utf8'), authorize);
        this.authorize(authorize);
        if (putHash !== manifestHash) {
          conflict('The stored manifest hash does not match the capture result.');
        }
      }
      if (this.index.read().snapshots[snapshotId]) {
        conflict(`Snapshot ${snapshotId} already exists.`);
      }
      const stored: StoredSnapshot = {
        id: snapshotId, teamId, ownerId, manifestHash, backing, createdAt: capturedAt
      };
      return this.finalizeSnapshot(stored, fingerprint, receiptKey, authorize);
    }));
  }

  /** Durable recovery/finalization of a journal: verify CAS, retention, commit. */
  private async finalizeGitPending(pending: PendingCapture, snapshotId: string, fingerprint: string, receiptKey: string, authorize?: () => void): Promise<StoredSnapshot> {
    const stored = pending.snapshot;
    if (stored.id !== snapshotId || pending.receiptKey !== receiptKey || pending.fingerprint !== fingerprint) {
      conflict(`Pending capture ${stored.id} does not match this request.`);
    }
    if (stored.backing.kind !== 'git') {
      conflict('Only a Git journal may be recovered without re-capture.');
    }
    // Validate the journaled backing against this namespace BEFORE any Git
    // ref/retention effect; the candidate is immutable from first publication.
    this.validateBacking(stored.backing, snapshotId);
    let manifest: SnapshotManifest;
    try {
      manifest = (await this.readManifest(stored.manifestHash)).manifest;
    } catch (error) {
      if (error instanceof WorkerError) {
        throw new WorkerError('isolation_corrupt', `Pending manifest ${stored.manifestHash} is unreadable; refusing to re-capture.`);
      }
      throw error;
    }
    if (sha256(JSON.stringify(manifest)) !== stored.manifestHash) {
      throw new WorkerError('isolation_corrupt', `Pending manifest ${stored.manifestHash} failed verification; refusing to re-capture.`);
    }
    const ensureRetention = this.requireHook(this.ensureRetention, 'Git content requires the ensureRetention hook.');
    this.preflightIndex(draft => this.applyFinalize(draft, stored, this.snapshotPin(stored), fingerprint, receiptKey));
    // The recovery guard carries the operation's re-authorization, not just
    // the host flag.
    await ensureRetention(stored.id, stored.backing, () => this.authorize(authorize));
    this.authorize(authorize);
    return this.finalizeSnapshot(stored, fingerprint, receiptKey, authorize);
  }

  /** Commits snapshot + internal pin + receipt in one atomic index update. */
  private async finalizeSnapshot(stored: StoredSnapshot, fingerprint: string, receiptKey: string, authorize?: () => void): Promise<StoredSnapshot> {
    const pin = this.snapshotPin(stored);
    this.preflightIndex(draft => this.applyFinalize(draft, stored, pin, fingerprint, receiptKey));
    // No guard between the committed rename and memory adoption: the index
    // update already authorized before rename; failing now would orphan it.
    const committed = await this.index.update((draft) => {
      this.applyFinalize(draft, stored, pin, fingerprint, receiptKey);
    }, authorize);
    return committed.snapshots[stored.id] as StoredSnapshot;
  }

  private applyFinalize(draft: ViewIndexData, stored: StoredSnapshot, pin: ViewPin, fingerprint: string, receiptKey: string): void {
    if (draft.snapshots[stored.id] || draft.receipts[receiptKey]) {
      throw new WorkerError('isolation_conflict', `Snapshot ${stored.id} already exists.`);
    }
    if (pinNameTaken(draft, pin.name)) {
      throw new WorkerError('isolation_conflict', `Pin name ${pin.name} is already used.`);
    }
    // A pending journal for this id (if any) is consumed by the commit.
    delete draft.pendingCaptures[stored.id];
    draft.snapshots[stored.id] = stored;
    draft.pins[pin.id] = pin;
    draft.receipts[receiptKey] = { fingerprint, result: structuredClone(stored) };
  }

  private snapshotPin(stored: StoredSnapshot): ViewPin {
    const name = `snapshot:${stored.id}`;
    return {
      id: sha256(['pin', this.namespace, stored.id]),
      ownerId: stored.ownerId,
      teamId: stored.teamId,
      name,
      resource: { kind: 'snapshot', id: stored.id }
    };
  }

  private requireHook<T extends (...args: never[]) => unknown>(hook: T | undefined, message: string): T {
    if (typeof hook !== 'function') {
      throw new WorkerError('isolation_unavailable', message);
    }
    return hook;
  }

  // -- bind ------------------------------------------------------------------

  /**
   * The ONE lane rule of a bind: a snapshot that carries its own unresolved merge
   * conflict groups may only be bound by the governed integration-lane startup of
   * exactly that team and snapshot. Everything else (an ordinary capture, a
   * conflict-free derived seed, or any legacy record without conflict groups) is
   * unaffected, and the identity is the host-supplied Session startup, never a
   * caller field.
   */
  private assertStartupLaneForConflicts(snapshot: StoredSnapshot, startup: StartupBindIdentity | undefined): void {
    const provenance = snapshot.provenance;
    if (provenance === undefined || provenance.kind !== 'integration-seed' || provenance.conflicts.length === 0) {
      return;
    }
    if (startup === undefined) {
      conflict('This snapshot is a derived integration seed with unresolved merge conflict groups; only its governed integration-lane startup may bind it.');
    }
    if (startup.lane !== 'work' && startup.lane !== 'validation' && startup.lane !== 'integration') {
      invalid('The internal startup lane must be work, validation or integration.');
    }
    if (startup.lane !== 'integration' || startup.teamId !== snapshot.teamId || startup.snapshotId !== snapshot.id) {
      conflict('This snapshot is a derived integration seed with unresolved merge conflict groups; only its governed integration-lane startup may bind it.');
    }
  }

  /**
   * Narrow startup PREFLIGHT of that same rule, answered BEFORE a governed
   * startup creates its worker and assigns a ready board task, so an invalid work
   * or validation bind can never strand an assignment. It reads the durable index
   * only and publishes nothing; an unknown snapshot, or a snapshot of ANOTHER
   * owner, is a no-op because the bind itself owns the owner/team scope check.
   */
  async assertStartupBindable(
    ownerId: string, teamId: string, snapshotId: string, lane: StartupBindIdentity['lane'], authorize?: () => void
  ): Promise<void> {
    return this.mutex.run(async () => {
      this.authorize(authorize);
      requireString(ownerId, 'ownerId', 1, 200);
      requireTeam(teamId, 'teamId');
      requireHex64(snapshotId, 'snapshotId');
      if (lane !== 'work' && lane !== 'validation' && lane !== 'integration') {
        invalid('The internal startup lane must be work, validation or integration.');
      }
      const snapshot = this.assertReady().snapshots[snapshotId];
      if (snapshot === undefined || snapshot.teamId !== teamId || snapshot.ownerId !== ownerId) {
        return;
      }
      this.assertStartupLaneForConflicts(snapshot, { teamId, snapshotId, lane });
    });
  }

  /**
   * Binds one worker instance to one snapshot. `startup` is the HOST-supplied
   * governed startup identity of this exact bind (real Session startup record,
   * never caller input); it is the only thing that may authorize a snapshot whose
   * OWN merge conflict groups are still unresolved. Every ordinary bind and every
   * exact ACK replay keeps its original semantics.
   */
  async bind(
    input: BindInput,
    persistMarker: (binding: IsolatedViewBinding) => Promise<void>,
    authorize?: () => void,
    startup?: StartupBindIdentity
  ): Promise<OverlayRecord> {
    return this.mutex.run(async () => {
      this.authorize(authorize);
      if (!this.opened) {
        throw new WorkerError('unavailable', 'The isolated views are not open; call open() first.');
      }
      if (!isPlain(input)) {
        invalid('bind input must be an object.');
      }
      const expectedKeys = new Set(['ownerId', 'teamId', 'snapshotId', 'workerId', 'workerCreatedAt', 'requestId']);
      if (Object.keys(input).some(key => !expectedKeys.has(key))) {
        invalid('bind input has unknown fields.');
      }
      const raw = input as Record<string, unknown>;
      const ownerId = requireString(raw.ownerId, 'ownerId', 1, 200);
      const teamId = requireTeam(raw.teamId, 'teamId');
      const snapshotId = requireHex64(raw.snapshotId, 'snapshotId');
      const workerId = requireTeam(raw.workerId, 'workerId');
      const workerCreatedAt = requireIso(raw.workerCreatedAt, 'workerCreatedAt');
      const requestId = requireString(raw.requestId, 'requestId', 1, 200);

      const overlayId = sha256(['overlay', this.namespace, workerId, workerCreatedAt, snapshotId]);
      const receiptKey = sha256(['bind', this.namespace, workerId, workerCreatedAt, requestId]);
      this.index.request(ownerId, requestId, receiptKey);
      const fingerprint = sha256(['bind', this.namespace, ownerId, teamId, snapshotId, workerId, workerCreatedAt, requestId]);
      const pin: ViewPin = {
        id: sha256(['pin', this.namespace, 'binding', overlayId]),
        ownerId, teamId,
        name: `binding:${overlayId}`,
        resource: { kind: 'snapshot', id: snapshotId },
        binding: { overlayId, workerId, workerCreatedAt, receiptKey, fingerprint }
      };
      const record: OverlayRecord = {
        teamId, snapshotId, overlayId, workerId, workerCreatedAt, ownerId,
        head: null, revision: 0, released: false
      };

      const data = this.assertReady();
      const receipt = data.receipts[receiptKey];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          conflict(`Request ${requestId} was already used with different arguments.`);
        }
        // Replay: parse and validate the durable ACK; zero effects, and no
        // active resource is required (receipts may outlive GC/releases).
        return this.validateReceiptResult(
          receipt,
          parseOverlayRecord,
          (value) => value.overlayId === overlayId && value.teamId === teamId && value.ownerId === ownerId
            && value.snapshotId === snapshotId && value.workerId === workerId
            && value.workerCreatedAt === workerCreatedAt
        );
      }
      const snapshot = data.snapshots[snapshotId];
      if (!snapshot) {
        throw new WorkerError('not_found', `No such snapshot: ${snapshotId}.`);
      }
      if (snapshot.teamId !== teamId || snapshot.ownerId !== ownerId) {
        conflict(`Snapshot ${snapshotId} belongs to a different owner or team.`);
      }
      // A derived seed whose OWN merge conflict groups are still unresolved is
      // not ordinary work: its bytes contain an unreviewed composition, so ONLY
      // its governed integration-lane startup may bind it. The identity is the
      // host-supplied real Session startup, compared exactly on team and snapshot,
      // so a request field can never widen this and an old work-lane seal cannot
      // launder the conflict. Exact ACK replays returned above are unchanged.
      this.assertStartupLaneForConflicts(snapshot, startup);
      const overlay = data.overlays[overlayId];
      if (overlay) {
        if (overlay.released) {
          conflict(`Overlay ${overlayId} was released and cannot be resurrected.`);
        }
        if (overlay.ownerId !== ownerId || overlay.teamId !== teamId || overlay.snapshotId !== snapshotId
          || overlay.workerId !== workerId || overlay.workerCreatedAt !== workerCreatedAt) {
          conflict(`Overlay ${overlayId} is bound to a different worker session.`);
        }
        // Already active with the exact binding: the ACK receipt was lost
        // with a crash after publication. Re-persist the Session marker
        // safely under stopped maintenance, then reserve the original ACK;
        // head and revision are never reset.
        this.preflightIndex(draft => {
          draft.receipts[receiptKey] = { fingerprint, result: structuredClone(overlay) };
        });
        await this.persistMarkerGuarded(persistMarker, { teamId, snapshotId, overlayId }, authorize);
        const committed = await this.index.update((draft) => {
          if (draft.receipts[receiptKey]) {
            throw new WorkerError('isolation_conflict', `Request ${requestId} already has a receipt.`);
          }
          const live = draft.overlays[overlayId];
          if (!live || live.released || live.ownerId !== ownerId || live.teamId !== teamId || live.snapshotId !== snapshotId
            || live.workerId !== workerId || live.workerCreatedAt !== workerCreatedAt) {
            throw new WorkerError('isolation_conflict', `Overlay ${overlayId} changed while acknowledging.`);
          }
          draft.receipts[receiptKey] = { fingerprint, result: structuredClone(live) };
        }, authorize);
        return committed.receipts[receiptKey].result as OverlayRecord;
      }
      // A worker instance's Session marker is PERMANENT: every overlay of
      // this (workerId, workerCreatedAt) pair, released or not, keeps its
      // base and blocks any new base or owner for this instance.
      for (const other of Object.values(data.overlays)) {
        if (other.overlayId !== overlayId && other.workerId === workerId && other.workerCreatedAt === workerCreatedAt) {
          conflict(`Worker ${workerId} already holds a session view on ${other.snapshotId} and cannot switch base or owner.`);
        }
      }

      // The intermediate pinned state (revision +1) and the final published
      // state (revision +2) are each fully validated BEFORE any Session
      // effect, so a capacity or graph failure can never spend a marker.
      const existingPin = data.pins[pin.id];
      let retryFinalization = false;
      if (existingPin) {
        const same = existingPin.name === pin.name && existingPin.ownerId === ownerId
          && existingPin.teamId === teamId && existingPin.resource.kind === pin.resource.kind
          && existingPin.resource.id === pin.resource.id;
        if (same) {
          // EXACT same internal binding pin: a previous attempt published the
          // pin but failed before overlay publication. The retry must safely
          // re-persist the marker and finalize, never treat the leftover pin
          // as a conflict and never overwrite it.
          if (existingPin.binding && JSON.stringify(existingPin.binding) !== JSON.stringify(pin.binding)) {
            conflict('Retry the original binding request before starting another.');
          }
          retryFinalization = existingPin.binding !== undefined;
        } else {
          conflict(`Internal pin ${pin.name} is claimed by a different binding.`);
        }
      }
      this.preflightIndex(draft => {
        if (!draft.pins[pin.id] && pinNameTaken(draft, pin.name)) {
          throw new WorkerError('isolation_conflict', `Internal pin ${pin.name} already exists.`);
        }
        draft.pins[pin.id] = pin;
      });
      this.preflightIndex(draft => {
        draft.pins[pin.id] = pin;
        this.applyBind(draft, record, pin, fingerprint, receiptKey);
      }, retryFinalization ? 1 : 2);

      if (!retryFinalization) {
        // Root the base NOW: a crash after the pin but before overlay
        // publication leaves a pin that keeps the base reachable.
        await this.index.update(draft => {
          if (draft.overlays[overlayId] || draft.receipts[receiptKey]) {
            throw new WorkerError('isolation_conflict', `Overlay ${overlayId} was committed while binding.`);
          }
          const current = draft.pins[pin.id];
          if (current && (current.name !== pin.name || current.ownerId !== pin.ownerId
            || current.teamId !== pin.teamId || current.resource.kind !== pin.resource.kind
            || current.resource.id !== pin.resource.id)) {
            throw new WorkerError('isolation_conflict', `Internal pin ${pin.name} was claimed by a different binding.`);
          }
          draft.pins[pin.id] = pin;
        }, authorize);
      }
      await this.persistMarkerGuarded(persistMarker, { teamId, snapshotId, overlayId }, authorize);

      const committed = await this.index.update((draft) => {
        this.applyBind(draft, record, pin, fingerprint, receiptKey);
      }, authorize);
      return committed.overlays[overlayId] as OverlayRecord;
    });
  }

  private async persistMarkerGuarded(persistMarker: (binding: IsolatedViewBinding) => Promise<void>, marker: IsolatedViewBinding, authorize?: () => void): Promise<void> {
    this.authorize(authorize);
    await persistMarker(marker);
    this.authorize(authorize);
  }

  private applyBind(draft: ViewIndexData, record: OverlayRecord, pin: ViewPin, fingerprint: string, receiptKey: string): void {
    if (draft.overlays[record.overlayId] || draft.receipts[receiptKey]) {
      throw new WorkerError('isolation_conflict', `Overlay ${record.overlayId} already exists.`);
    }
    const current = draft.pins[pin.id];
    // The EXACT internal binding pin must be present; never overwrite a
    // different pin.
    if (!current || current.name !== pin.name || current.ownerId !== pin.ownerId
      || current.teamId !== pin.teamId || current.resource.kind !== pin.resource.kind
      || current.resource.id !== pin.resource.id) {
      throw new WorkerError('isolation_conflict', 'The internal binding pin is missing or different; retry the same request.');
    }
    if (!draft.snapshots[record.snapshotId]) {
      throw new WorkerError('isolation_conflict', `Snapshot ${record.snapshotId} disappeared while binding.`);
    }
    draft.overlays[record.overlayId] = record;
    draft.receipts[receiptKey] = { fingerprint, result: structuredClone(record) };
    delete draft.pins[pin.id];
  }

  /**
   * Parses a durable receipt result with the strict record parser and
   * validates it against the expected request identity. A missing or corrupt
   * ACK is isolation_corrupt and is never re-executed or pretended.
   */
  private validateReceiptResult<T>(
    receipt: ViewReceipt,
    parser: (value: unknown) => T,
    matches: (value: T) => boolean
  ): T {
    if (receipt.fingerprint === undefined) {
      throw new WorkerError('isolation_corrupt', 'The stored receipt has no fingerprint.');
    }
    let parsed: T;
    let matchesRequest = false;
    try {
      parsed = parser(receipt.result);
      matchesRequest = matches(parsed);
    } catch {
      throw new WorkerError('isolation_corrupt', 'The stored receipt result is corrupt.');
    }
    if (!matchesRequest) {
      throw new WorkerError('isolation_corrupt', 'The stored receipt does not match this request.');
    }
    return parsed;
  }

  /** Holds one coherent revision for an entire read, listing or search. */
  async withView<T>(binding: IsolatedViewBinding, identity: IsolatedViewIdentity, action: (view: IsolatedViewState) => T | Promise<T>, authorize?: () => void): Promise<T> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      const data = this.assertReady();
      const record = this.boundOverlay(data, binding, identity);
      const view = await this.loadState(data, record, guard);
      const result = await action(view);
      guard();
      return result;
    });
  }

  async status(binding: IsolatedViewBinding, identity: IsolatedViewIdentity, authorize?: () => void): Promise<OverlayRecord> {
    return this.mutex.run(async () => {
      this.authorize(authorize);
      return structuredClone(this.boundOverlay(this.assertReady(), binding, identity));
    });
  }

  async edit(
    binding: IsolatedViewBinding, identity: IsolatedViewIdentity,
    planner: Parameters<IsolatedViewPort['edit']>[2], authorize?: () => void
  ): Promise<{ revision: number }> {
    return this.mutex.run(() => this.withStorageWrite(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      const data = this.assertReady();
      const record = this.boundOverlay(data, binding, identity);
      if (record.revision >= MAX_OVERLAY_REVISIONS) {
        throw new WorkerError('isolation_capacity', 'This overlay has reached its revision limit.');
      }
      const view = await this.loadState(data, record, guard);
      const changes = await planner(view, async bytes => {
        guard();
        if (bytes.length > MAX_MANIFEST_FILE_BYTES) {
          throw new WorkerError('isolation_capacity', 'A private file exceeds 32 MiB.');
        }
        return this.content.put(bytes, guard);
      });
      guard();
      const tree = new LayeredTree(this.index.root, view.tree.entries, [changes]);
      let files = 0;
      let bytes = 0;
      for (const entry of Object.values(tree.entries)) {
        if (entry.type === 'file') {
          files += 1;
          bytes += entry.size;
          if (entry.size > MAX_MANIFEST_FILE_BYTES) {
            throw new WorkerError('isolation_capacity', 'A private file exceeds 32 MiB.');
          }
        }
      }
      if (files > MAX_MANIFEST_FILES || bytes > MAX_MANIFEST_TOTAL_BYTES) {
        throw new WorkerError('isolation_capacity', 'The private view exceeds its file or byte limit.');
      }
      const effective = Object.fromEntries(Object.entries(changes).filter(([key, entry]) =>
        JSON.stringify(view.tree.entries[key] ?? null) !== JSON.stringify(entry)
      ));
      if (Object.keys(effective).length === 0) {
        return { revision: record.revision };
      }
      const revision: OverlayRevision = { schema: 1, overlayId: record.overlayId, parent: record.head, revision: record.revision + 1, changes: effective };
      const encoded = Buffer.from(JSON.stringify(revision), 'utf8');
      parseOverlayRevision(encoded);
      const head = await this.content.put(encoded, guard);
      guard();
      const committed = await this.index.update(draft => {
        const current = this.boundOverlay(draft, binding, identity);
        if (current.head !== record.head || current.revision !== record.revision) {
          conflict('The overlay revision changed before publication.');
        }
        current.head = head;
        current.revision = revision.revision;
      }, guard);
      return { revision: committed.overlays[record.overlayId].revision };
    }));
  }

  async seal(binding: IsolatedViewBinding, identity: IsolatedViewIdentity, input: { requestId: string; expectedRevision: number }, authorize?: () => void): Promise<SealedSubmission> {
    return this.mutex.run(() => this.sealLocked(binding, identity, input, authorize));
  }

  private async sealLocked(binding: IsolatedViewBinding, identity: IsolatedViewIdentity, input: { requestId: string; expectedRevision: number }, authorize?: () => void, runnerInput = false): Promise<SealedSubmission> {
    const guard = (): void => this.authorize(authorize);
    guard();
    requireString(input.requestId, 'requestId', 1, 200);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      invalid('expectedRevision must be a nonnegative safe integer.');
    }
    this.validateIdentity(binding, identity);
    const data = this.assertReady();
    const key = sha256(['seal', this.namespace, binding.overlayId, identity.ownerId, input.requestId]);
    this.index.request(identity.ownerId, input.requestId, key);
    const fingerprint = sha256(['seal', binding.overlayId, binding.snapshotId, binding.teamId, identity.ownerId, identity.workerId, identity.workerCreatedAt, String(input.expectedRevision)]);
    const receipt = data.receipts[key];
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        conflict('This seal requestId was already used with different arguments.');
      }
      return this.validateReceiptResult(receipt, parseSealedSubmission, value =>
        value.overlayId === binding.overlayId && value.snapshotId === binding.snapshotId && value.teamId === binding.teamId
          && value.ownerId === identity.ownerId && value.workerId === identity.workerId && value.workerCreatedAt === identity.workerCreatedAt
          && value.revision === input.expectedRevision
          && value.version === value.revision + 1 && value.uri === this.submissionUri(value.id, value.version)
      );
    }
    const record = this.boundOverlay(data, binding, identity);
    if (record.revision !== input.expectedRevision) {
      conflict('The overlay has changed; inspect its current revision before sealing.');
    }
    await this.loadState(data, record, guard);
    const id = sha256(['submission', this.namespace, binding.overlayId, identity.ownerId, input.requestId]);
    const submission: SealedSubmission = { ...record, id, version: record.revision + 1,
      uri: this.submissionUri(id, record.revision + 1), createdAt: new Date().toISOString(), released: false,
      // Additive marker: ONLY withSealedInput publishes it, and only on a newly
      // sealed input, so an abandoned governed setup is reclaimable metadata
      // while an explicit user seal is never eligible.
      ...(runnerInput ? { runnerInput: true as const } : {}) };
    const committed = await this.index.update(draft => {
      if (draft.submissions[id] || draft.receipts[key]) {
        conflict('This submission has already been published.');
      }
      draft.submissions[id] = submission;
      draft.receipts[key] = { fingerprint, result: submission };
    }, guard);
    return committed.submissions[id];
  }

  /** No release/cleanup can enter between sealing and the durable consumer. */
  async withSealedInput<T>(binding: IsolatedViewBinding, identity: IsolatedViewIdentity, input: { requestId: string; expectedRevision: number }, action: (view: IsolatedViewState, submission: SealedSubmission) => T | Promise<T>, authorize?: () => void): Promise<T> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      const submission = await this.sealLocked(binding, identity, input, guard, true);
      const data = this.assertReady();
      if (!data.submissions[submission.id] || data.submissions[submission.id].released) {
        throw new WorkerError('isolation_released', 'The exact sealed input was released; no command was started.');
      }
      const record = this.boundOverlay(data, binding, identity);
      if (record.revision !== submission.revision) {
        conflict('Private input changed before consumer publication.');
      }
      const state = await this.loadState(data, record, guard);
      const result = await action(state, submission);
      guard();
      return result;
    });
  }

  /** Reads the sealed head even after subsequent edits or overlay release. */
  async withSubmission<T>(ownerId: string, teamId: string, id: string, action: (view: IsolatedViewState, submission: SealedSubmission) => T | Promise<T>, authorize?: () => void): Promise<T> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      this.checkScope(ownerId, teamId);
      requireHex64(id, 'submissionId');
      const data = this.assertReady();
      const record = data.submissions[id];
      if (!record || record.ownerId !== ownerId || record.teamId !== teamId) {
        throw new WorkerError('not_found', 'No sealed submission exists in this scope.');
      }
      if (record.released && !Object.values(data.pins).some(pin => pin.resource.kind === 'submission' && pin.resource.id === id)) {
        throw new WorkerError('isolation_released', 'This submission was released and has no retaining reference.');
      }
      if (record.version !== record.revision + 1 || record.uri !== this.submissionUri(id, record.version)) {
        throw new WorkerError('isolation_corrupt', 'The sealed submission metadata is inconsistent.');
      }
      const view = await this.loadState(data, record, guard);
      const result = await action(view, structuredClone(record));
      guard();
      return result;
    });
  }

  private submissionUri(id: string, version: number): string {
    return `codex-subagent://submission/${this.namespace}/${id}/${version}`;
  }

  private checkScope(ownerId: string, teamId: string): void {
    requireString(ownerId, 'ownerId', 1, 200);
    requireTeam(teamId, 'teamId');
  }

  private validateIdentity(binding: IsolatedViewBinding, identity: IsolatedViewIdentity): void {
    this.checkScope(identity.ownerId, binding.teamId);
    requireHex64(binding.overlayId, 'overlayId');
    requireHex64(binding.snapshotId, 'snapshotId');
    requireTeam(identity.workerId, 'workerId');
    requireIso(identity.workerCreatedAt, 'workerCreatedAt');
  }

  private boundOverlay(data: ViewIndexData, binding: IsolatedViewBinding, identity: IsolatedViewIdentity): OverlayRecord {
    this.validateIdentity(binding, identity);
    const record = data.overlays[binding.overlayId];
    if (!record || record.ownerId !== identity.ownerId || record.teamId !== binding.teamId || record.snapshotId !== binding.snapshotId
      || record.workerId !== identity.workerId || record.workerCreatedAt !== identity.workerCreatedAt) {
      throw new WorkerError('isolation_unavailable', 'This worker instance has no matching private view.');
    }
    if (record.released) {
      throw new WorkerError('isolation_released', 'This worker view was released and cannot use live workspace tools.');
    }
    return record;
  }

  private async loadState(data: ViewIndexData, record: OverlayRecord | SealedSubmission, guard: () => void): Promise<IsolatedViewState> {
    guard();
    const snapshot = data.snapshots[record.snapshotId];
    if (!snapshot || snapshot.ownerId !== record.ownerId || snapshot.teamId !== record.teamId) {
      throw new WorkerError('isolation_corrupt', 'The private view is missing its shared snapshot.');
    }
    this.validateBacking(snapshot.backing, snapshot.id);
    await this.ensureRetention(snapshot.id, snapshot.backing, guard);
    const { manifest } = await this.readManifest(snapshot.manifestHash);
    guard();
    const { tree } = await loadRevisionTree(this.content, manifest, record.overlayId, record.head, record.revision, guard);
    const read = this.readContent
      ? (hash: string) => this.readContent!(snapshot.backing, this.content, hash, guard)
      : createProjectContentReader(snapshot.backing, this.content, guard);
    return revisionState(tree, record.revision, read, guard);
  }

  async pin(input: RetentionScope & { name: string; resource: ViewPin['resource'] }, authorize?: () => void): Promise<ViewPin> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      this.checkScope(input.ownerId, input.teamId);
      requireString(input.name, 'name', 1, 128);
      // Legacy public names keep their original reservation: only `binding:`
      // and `snapshot:` prefixes are internal. An `integration:` public name is
      // still allowed (and replays exactly as before); it can never reach an
      // internal integration pin, whose id is derived from the attempt and
      // which also carries protected integration metadata.
      if (/^(binding|snapshot):/.test(input.name)) {
        invalid('This pin name is reserved for internal retention.');
      }
      requireHex64(input.resource.id, 'resource.id');
      if (!['snapshot', 'submission'].includes(input.resource.kind)) {
        invalid('A pin must identify a snapshot or sealed submission.');
      }
      const data = this.assertReady();
      const { key, fingerprint, receipt } = this.retentionRequest(data, 'pin', input, [input.name, input.resource.kind, input.resource.id]);
      const id = sha256(['named-pin', this.namespace, input.ownerId, input.teamId, input.name]);
      if (receipt) {
        return this.validateReceiptResult(receipt, parseViewPin, value => value.id === id && value.ownerId === input.ownerId && value.teamId === input.teamId
          && value.name === input.name && value.resource.kind === input.resource.kind && value.resource.id === input.resource.id && !value.binding);
      }
      const resource = input.resource.kind === 'snapshot' ? data.snapshots[input.resource.id] : data.submissions[input.resource.id];
      if (!resource || resource.ownerId !== input.ownerId || resource.teamId !== input.teamId) {
        throw new WorkerError('not_found', 'The retained resource does not exist in this scope.');
      }
      if ('released' in resource && resource.released && !Object.values(data.pins).some(pin => pin.resource.kind === 'submission' && pin.resource.id === resource.id)) {
        throw new WorkerError('isolation_released', 'An unreferenced released submission cannot be pinned again.');
      }
      const existing = data.pins[id];
      if (existing && (existing.resource.kind !== input.resource.kind || existing.resource.id !== input.resource.id)) {
        conflict('This pin name already retains a different resource.');
      }
      const pin: ViewPin = { id, ownerId: input.ownerId, teamId: input.teamId, name: input.name, resource: { ...input.resource } };
      this.preflightIndex(draft => {
        draft.pins[id] = pin;
        draft.receipts[key] = { fingerprint, result: pin };
      });
      const snapshot = input.resource.kind === 'snapshot' ? data.snapshots[input.resource.id] : data.snapshots[(resource as SealedSubmission).snapshotId];
      if (!snapshot) {
        throw new WorkerError('isolation_corrupt', 'The retained resource has no snapshot.');
      }
      this.validateBacking(snapshot.backing, snapshot.id);
      await this.ensureRetention(snapshot.id, snapshot.backing, guard);
      await this.readManifest(snapshot.manifestHash);
      guard();
      const committed = await this.index.update(draft => {
        draft.pins[id] = pin;
        draft.receipts[key] = { fingerprint, result: pin };
      }, guard);
      return committed.pins[id];
    });
  }

  /** Releasing a snapshot drops its creation pin, not references held by others. */
  async release(input: RetentionScope & { kind: 'snapshot' | 'overlay' | 'submission' | 'pin' | 'pending'; id: string }, authorize?: () => void, resolveWorker?: (id: string) => Promise<WorkerViewPresence>, retained: ReadonlySet<string> | (() => ReadonlySet<string>) = new Set(), preserveConsumers = false): Promise<{ released: true; kind: string; id: string }> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      this.checkScope(input.ownerId, input.teamId);
      requireHex64(input.id, 'id');
      const data = this.assertReady();
      const { key, fingerprint, receipt } = this.retentionRequest(data, 'release', input, [input.kind, input.id]);
      const result = { released: true as const, kind: input.kind, id: input.id };
      // An exactly authorized stored acknowledgement replays BEFORE any live
      // reference is consulted: a release that already happened stays replayable
      // even after a native pin, board reference or evidence consumer was added
      // to that same artifact afterwards. The live guard and scope check above
      // are the whole authorization, and the receipt key/fingerprint bind this
      // acknowledgement to this owner, team, kind and id.
      if (receipt) {
        if (!isPlain(receipt.result) || Object.keys(receipt.result).length !== 3 || receipt.result.released !== true
          || receipt.result.kind !== input.kind || receipt.result.id !== input.id) {
          throw new WorkerError('isolation_corrupt', 'The release acknowledgment is invalid.');
        }
        return result;
      }
      // The FRESH path proves the exact resource exists in this owner/team scope
      // BEFORE the retained-reference gate, so a foreign or missing id is
      // not_found rather than artifact_retained.
      const resource = input.kind === 'snapshot' ? data.snapshots[input.id] : input.kind === 'overlay' ? data.overlays[input.id]
        : input.kind === 'submission' ? data.submissions[input.id] : input.kind === 'pin' ? data.pins[input.id]
          : input.kind === 'pending' ? data.pendingCaptures[input.id]?.snapshot : undefined;
      if (!resource || resource.ownerId !== input.ownerId || resource.teamId !== input.teamId) {
        throw new WorkerError('not_found', 'This resource does not exist in the requested scope.');
      }
      // Internal integration pins and derived seeds are released only by their
      // own durable attempt decision, never by a public retention call.
      if (input.kind === 'pin' && data.pins[input.id].integration !== undefined) {
        conflict('An internal integration pin is released only by its own durable attempt decision.');
      }
      if (input.kind === 'snapshot' && data.snapshots[input.id].provenance?.kind === 'integration-seed') {
        conflict('A derived integration seed snapshot is released only by its own durable attempt decision.');
      }
      const references = typeof retained === 'function' ? retained() : retained;
      if (input.kind === 'submission' && (references.has(data.submissions[input.id].uri) || (preserveConsumers && Object.values(data.pins).some(pin => pin.resource.kind === 'submission' && pin.resource.id === input.id)))) {
        throw new WorkerError('artifact_retained', 'This submission is required by a board reference or evidence consumer. Release that consumer explicitly first.');
      }
      if (input.kind === 'pin') {
        const pin = data.pins[input.id];
        if (pin.binding || pin.name.startsWith('binding:')) {
          if (!pin.binding || !resolveWorker) {
            conflict('The binding intent cannot be released without confirming its original worker claim. Retry the binding or reconcile it with cleanup.');
          }
          const presence = await resolveWorker(pin.binding.workerId);
          guard();
          if (presence.state === 'unknown' || (presence.state === 'present'
            && presence.workerCreatedAt === pin.binding.workerCreatedAt && presence.binding?.overlayId === pin.binding.overlayId)) {
            conflict('This binding intent may still be claimed by a permanent Session marker. Retry the binding or reconcile it with cleanup before releasing its overlay.');
          }
        }
      }
      const apply = (draft: ViewIndexData): void => {
        if (input.kind === 'snapshot') {
          const pin = this.snapshotPin(draft.snapshots[input.id]);
          delete draft.pins[pin.id];
        } else if (input.kind === 'overlay') {
          draft.overlays[input.id].released = true;
        } else if (input.kind === 'submission') {
          draft.submissions[input.id].released = true;
        } else if (input.kind === 'pin') {
          delete draft.pins[input.id];
        } else {
          const pending = draft.pendingCaptures[input.id];
          draft.receipts[pending.receiptKey] = { fingerprint: pending.fingerprint, result: { cancelledCapture: input.id } };
          delete draft.pendingCaptures[input.id];
        }
        draft.receipts[key] = { fingerprint, result };
      };
      this.preflightIndex(apply);
      if (input.kind === 'pending') {
        const pending = data.pendingCaptures[input.id];
        this.validateBacking(pending.snapshot.backing, pending.snapshot.id);
        await this.releaseRetention(pending.snapshot.backing, guard);
      }
      await this.index.update(apply, guard);
      return result;
    });
  }

  async cleanup(input: RetentionScope, resolveWorker?: (id: string) => Promise<WorkerViewPresence>, authorize?: () => void, retained: ReadonlySet<string> | (() => ReadonlySet<string>) = new Set()): Promise<ViewCleanupResult> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      this.checkScope(input.ownerId, input.teamId);
      let data = this.assertReady();
      const references = typeof retained === 'function' ? retained() : retained;
      const { key, fingerprint, receipt } = this.retentionRequest(data, 'cleanup', input, []);
      if (receipt) {
        const value = receipt.result as ViewCleanupResult;
        if (!isPlain(value) || !Array.isArray(value.deletedSnapshots) || !Array.isArray(value.releasedOverlays) || !Array.isArray(value.diagnostics)
          || !value.deletedSnapshots.every(id => typeof id === 'string' && HEX64.test(id))
          || !value.releasedOverlays.every(id => typeof id === 'string' && HEX64.test(id))
          || !value.diagnostics.every(message => typeof message === 'string' && message.length <= 500)
          || typeof value.complete !== 'boolean' || value.complete !== (value.diagnosticCount === 0 && value.preservedUnknown === 0)
          || !['recoveredBindings', 'deletedSubmissions', 'deletedBlobs', 'deletedBytes', 'preservedUnknown', 'diagnosticCount'].every(field =>
            Number.isSafeInteger(value[field]) && (value[field] as number) >= 0)) {
          throw new WorkerError('isolation_corrupt', 'The cleanup acknowledgment is invalid.');
        }
        return structuredClone(value);
      }
      // Reserve worst-case ACK capacity before irreversible deletion. Nothing
      // from this projection is published or returned as an acknowledgment.
      this.preflightIndex(draft => {
        draft.receipts[key] = { fingerprint, result: 'x'.repeat(40_000) };
      });
      const result: ViewCleanupResult = { deletedSnapshots: [], releasedOverlays: [], recoveredBindings: 0, deletedSubmissions: 0, deletedBlobs: 0, deletedBytes: 0,
        preservedUnknown: 0, diagnostics: [], diagnosticCount: 0, complete: true };
      const diagnose = (message: string): void => {
        result.diagnosticCount += 1;
        if (result.diagnostics.length < 20) {
          result.diagnostics.push(message.slice(0, 500));
        }
      };
      const scoped = (record: { ownerId: string; teamId: string }): boolean => record.ownerId === input.ownerId && record.teamId === input.teamId;
      if (resolveWorker) {
        for (const pin of Object.values(data.pins).filter(pin => scoped(pin) && pin.name.startsWith('binding:'))) {
          guard();
          if (!pin.binding) {
            diagnose(`Binding pin ${pin.id} has no recovery identity; retry its original binding before releasing it.`);
            continue;
          }
          const intent = pin.binding;
          if (intent.overlayId !== sha256(['overlay', this.namespace, intent.workerId, intent.workerCreatedAt, pin.resource.id])) {
            throw new WorkerError('isolation_corrupt', 'A binding intent has an inconsistent worker identity.');
          }
          const presence = await resolveWorker(intent.workerId);
          guard();
          if (presence.state === 'missing' || (presence.state === 'present' && (presence.workerCreatedAt !== intent.workerCreatedAt
            || (presence.binding !== undefined && presence.binding.overlayId !== intent.overlayId)))) {
            await this.index.update(draft => {
              delete draft.pins[pin.id];
            }, guard);
          } else if (presence.state === 'present' && presence.binding?.overlayId === intent.overlayId
            && presence.binding.snapshotId === pin.resource.id && presence.binding.teamId === pin.teamId) {
            const record: OverlayRecord = { teamId: pin.teamId, ownerId: pin.ownerId, snapshotId: pin.resource.id, overlayId: intent.overlayId,
              workerId: intent.workerId, workerCreatedAt: intent.workerCreatedAt, head: null, revision: 0, released: false };
            const current = this.index.read();
            if (!current.overlays[record.overlayId]) {
              this.preflightIndex(draft => this.applyBind(draft, record, pin, intent.fingerprint, intent.receiptKey));
              const snapshot = current.snapshots[record.snapshotId];
              this.validateBacking(snapshot.backing, snapshot.id);
              await this.ensureRetention(snapshot.id, snapshot.backing, guard);
              await this.index.update(draft => this.applyBind(draft, record, pin, intent.fingerprint, intent.receiptKey), guard);
              result.recoveredBindings += 1;
            } else {
              diagnose(`Binding ${record.overlayId} already has an overlay; its extra intent was preserved.`);
            }
          } else {
            diagnose(`Binding ${intent.overlayId} could not be reconciled with its original Session; retained.`);
          }
        }
        data = this.index.read();
        for (const overlay of Object.values(data.overlays).filter(scoped)) {
          const presence = await resolveWorker(overlay.workerId);
          guard();
          if (presence.state === 'missing' || (presence.state === 'present' && presence.workerCreatedAt !== overlay.workerCreatedAt)) {
            await this.index.update(draft => {
              delete draft.overlays[overlay.overlayId];
            }, guard);
            result.releasedOverlays.push(overlay.overlayId);
          } else if (!overlay.released && (presence.state === 'unknown' || !presence.binding || presence.binding.overlayId !== overlay.overlayId)) {
            diagnose(`Worker ${overlay.workerId} could not be confirmed; its overlay was retained.`);
          }
        }
      }
      data = this.index.read();
      const rooted = new Set<string>();
      const retentionFailures = new Set<string>();
      const pinnedSubmissions = new Set([...Object.values(data.pins).filter(pin => pin.resource.kind === 'submission').map(pin => pin.resource.id), ...Object.values(data.submissions).filter(s => references.has(s.uri)).map(s => s.id)]);
      const retired = Object.values(data.submissions).filter(record => scoped(record) && record.released && !pinnedSubmissions.has(record.id));
      if (retired.length) {
        await this.index.update(draft => {
          for (const record of retired) {
            delete draft.submissions[record.id];
          }
        }, guard);
        result.deletedSubmissions = retired.length;
        data = this.index.read();
      }
      for (const overlay of Object.values(data.overlays)) {
        if (!overlay.released) {
          rooted.add(overlay.snapshotId);
        }
      }
      for (const submission of Object.values(data.submissions)) {
        if (!submission.released || pinnedSubmissions.has(submission.id)) {
          rooted.add(submission.snapshotId);
        }
      }
      for (const pin of Object.values(data.pins)) {
        if (pin.resource.kind === 'snapshot') {
          rooted.add(pin.resource.id);
        }
      }
      // Durable ancestry edges are part of retention: a rooted derivation (a
      // live seed pin, an unreleased submission or overlay) also roots every
      // derived snapshot it was composed from, and the oldest ordinary capture
      // its lineage rests on. Only edges STORED ON REACHABLE snapshots are
      // followed, so an unrelated attempt's retired chain still falls to normal
      // cleanup.
      const ancestryQueue = [...rooted];
      while (ancestryQueue.length > 0) {
        const snapshot = data.snapshots[ancestryQueue.pop() as string];
        // Only an edge stored on a SAME-SCOPE reachable derivation is followed,
        // and only to a same-scope parent record. A legacy link that names a
        // missing or foreign snapshot is skipped, never resolved from live
        // files, so unrelated cleanup stays possible.
        const parent = snapshot === undefined || snapshot.ownerId !== input.ownerId || snapshot.teamId !== input.teamId
          ? undefined : snapshot.provenance?.baseSnapshotId;
        const record = parent === undefined ? undefined : data.snapshots[parent];
        if (parent === undefined || record === undefined || record.ownerId !== input.ownerId || record.teamId !== input.teamId
          || rooted.has(parent)) {
          continue;
        }
        rooted.add(parent);
        ancestryQueue.push(parent);
      }
      for (const snapshot of Object.values(data.snapshots).filter(snapshot => scoped(snapshot) && !rooted.has(snapshot.id))) {
        this.validateBacking(snapshot.backing, snapshot.id);
        try {
          // The metadata is durable deletion intent until this exact ref is
          // released. A crash repeats release before deleting the metadata.
          await this.releaseRetention(snapshot.backing, guard);
        } catch (error) {
          guard();
          retentionFailures.add(snapshot.id);
          diagnose(`Snapshot ${snapshot.id} retention could not be released: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        await this.index.update(draft => {
          delete draft.snapshots[snapshot.id];
        }, guard);
        result.deletedSnapshots.push(snapshot.id);
      }
      data = this.index.read();
      const marks = new Set<string>();
      const markSnapshot = async (snapshot: StoredSnapshot): Promise<SnapshotManifest> => {
        this.validateBacking(snapshot.backing, snapshot.id);
        if (snapshot.backing.kind === 'git' && !retentionFailures.has(snapshot.id)) {
          try {
            await this.ensureRetention(snapshot.id, snapshot.backing, guard);
          } catch (error) {
            guard();
            retentionFailures.add(snapshot.id);
            diagnose(`Snapshot ${snapshot.id} could not retain its immutable Git objects: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        marks.add(snapshot.manifestHash);
        const { manifest } = await this.readManifest(snapshot.manifestHash);
        guard();
        for (const entry of Object.values(manifest.entries)) {
          if (entry.type === 'file' && !(snapshot.backing.kind === 'git' && Object.hasOwn(snapshot.backing.blobs, entry.hash))) {
            marks.add(entry.hash);
          }
        }
        return manifest;
      };
      const manifests = new Map<string, SnapshotManifest>();
      for (const snapshot of Object.values(data.snapshots)) {
        manifests.set(snapshot.id, await markSnapshot(snapshot));
      }
      for (const pending of Object.values(data.pendingCaptures)) {
        await markSnapshot(pending.snapshot);
      }
      for (const record of [...Object.values(data.overlays).filter(record => !record.released),
        ...Object.values(data.submissions).filter(record => !record.released || pinnedSubmissions.has(record.id))]) {
        const manifest = manifests.get(record.snapshotId);
        if (!manifest) {
          throw new WorkerError('isolation_corrupt', 'A retained revision is missing its snapshot.');
        }
        const chain = await loadRevisionTree(this.content, manifest, record.overlayId, record.head, record.revision, guard);
        for (const hash of chain.marks) {
          marks.add(hash);
        }
      }
      const swept = await sweepViewContent(this.content.directory, marks, guard);
      Object.assign(result, swept);
      result.complete = result.diagnosticCount === 0 && result.preservedUnknown === 0;
      await this.index.update(draft => {
        draft.receipts[key] = { fingerprint, result };
      }, guard);
      return result;
    });
  }

  /**
   * Durably PROVES which sealed submissions are governed runner inputs, using
   * the exact attempt records that own them.
   *
   * A durable result is the only exact evidence that one specific sealed
   * submission was auto-sealed for one command, and collecting that result
   * DELETES the evidence. The proof is therefore published - the same additive
   * marker `withSealedInput` writes - BEFORE the result is removed, inside the
   * view mutex, so a crash or throw between that deletion and the sweep loses
   * nothing: the marker sweep reclaims the input on any later collection, with
   * no result ids and after a reopen.
   *
   * Only an exact id + URI match, in this owner/team scope, for a live
   * unreleased submission is marked. An unproven, unknown, foreign or already
   * released input is left exactly as it is, and an input that is already
   * marked is not rewritten. Returns how many inputs this call proved.
   */
  async proveRunnerInputs(
    scope: { ownerId: string; teamId: string },
    proofs: readonly { id: string; uri: string }[],
    authorize?: () => void
  ): Promise<number> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      this.checkScope(scope.ownerId, scope.teamId);
      if (proofs.length === 0) {
        return 0;
      }
      const data = this.assertReady();
      const targets = new Map<string, string>();
      for (const proof of proofs) {
        if (!isPlain(proof) || typeof proof.id !== 'string' || !HEX64.test(proof.id)
          || typeof proof.uri !== 'string' || proof.uri.length === 0) {
          continue;
        }
        const record = data.submissions[proof.id];
        if (record !== undefined && record.uri === proof.uri && !record.released
          && record.runnerInput !== true
          && record.ownerId === scope.ownerId && record.teamId === scope.teamId) {
          targets.set(record.id, record.uri);
        }
      }
      if (targets.size === 0) {
        return 0;
      }
      const committed = await this.index.update(draft => {
        for (const [id, uri] of targets) {
          const live = draft.submissions[id];
          if (live === undefined || live.released || live.uri !== uri || live.runnerInput === true
            || live.ownerId !== scope.ownerId || live.teamId !== scope.teamId) {
            throw new WorkerError('isolation_conflict', `Runner input ${id} changed while its proof was published.`);
          }
          live.runnerInput = true;
        }
      }, guard);
      let proved = 0;
      for (const id of targets.keys()) {
        const live = committed.submissions[id];
        if (live !== undefined && live.runnerInput !== undefined) {
          proved += 1;
        }
      }
      return proved;
    });
  }

  /**
   * Reclaims PROVEN governed runner inputs that no live consumer holds, in ONE
   * scoped index update and with NO per-input receipt (so a full receipt map can
   * never turn reclamation into a failure after a result was already deleted).
   *
   * Only an input carrying the additive marker - published by `withSealedInput`
   * for the seal it just made, or by `proveRunnerInputs` from a durable attempt
   * record before that record was collected - is eligible, which is why a marker
   * sweep can resume with no result ids and after a reopen. `references` is
   * resolved INSIDE the view mutex, i.e. after the caller's runner collection
   * committed, so a command that published its pending or final attempt while
   * this sweep was queued is still retained; the sweep itself also preserves
   * every native view pin. An unmarked input without proof, a board reference,
   * an evidence pin and a native pin are always preserved. Released here, the
   * inputs are removed by the existing reference-aware cleanup.
   */
  async reclaimInputs(
    scope: { ownerId: string; teamId: string },
    references: () => ReadonlySet<string>,
    authorize?: () => void
  ): Promise<RunnerInputReclamation> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      this.checkScope(scope.ownerId, scope.teamId);
      const data = this.assertReady();
      const retained = references();
      const pinned = new Set(Object.values(data.pins)
        .filter(pin => pin.resource.kind === 'submission')
        .map(pin => pin.resource.id));
      const eligible = Object.values(data.submissions).filter(record => !record.released
        && record.runnerInput === true
        && record.ownerId === scope.ownerId && record.teamId === scope.teamId);
      const targets = new Map<string, string>();
      for (const record of eligible) {
        if (!pinned.has(record.id) && !retained.has(record.uri)) {
          targets.set(record.id, record.uri);
        }
      }
      const preserved = eligible.length - targets.size;
      if (targets.size === 0) {
        return { released: [], preserved };
      }
      this.preflightIndex(draft => {
        for (const id of targets.keys()) {
          draft.submissions[id].released = true;
        }
      });
      const committed = await this.index.update(draft => {
        for (const [id, uri] of targets) {
          const live = draft.submissions[id];
          if (live === undefined || live.released || live.uri !== uri || live.runnerInput !== true
            || live.ownerId !== scope.ownerId || live.teamId !== scope.teamId) {
            throw new WorkerError('isolation_conflict', `Runner input ${id} changed before it could be reclaimed.`);
          }
          live.released = true;
        }
      }, guard);
      const released = [...targets.keys()].filter(id => committed.submissions[id]?.released);
      return { released, preserved };
    });
  }

  // -- private integration artifacts -----------------------------------------
  //
  // Integration composes a PRIVATE seed snapshot from exact sealed artifacts.
  // Everything below is durable-first: internal pins are published in ONE index
  // update before any consumer can observe them, the seed is committed together
  // with its own provenance and pin, and every replay is answered from those
  // durable records instead of a receipt that epoch GC could move.

  /** Strict identity of one durable integration attempt. */
  private integrationScope(scope: unknown): IntegrationScope {
    if (!isPlain(scope)) {
      invalid('The integration scope must be an object.');
    }
    const expected = new Set(['ownerId', 'teamId', 'attemptId']);
    if (Object.keys(scope).some(key => !expected.has(key))) {
      invalid('The integration scope has unknown fields.');
    }
    return {
      ownerId: requireString(scope.ownerId, 'ownerId', 1, 200),
      teamId: requireTeam(scope.teamId, 'teamId'),
      attemptId: requireHex64(scope.attemptId, 'attemptId')
    };
  }

  /**
   * Exact ordered refs. An EXACT repeat names the same artifact and is folded
   * (the merge could not accept a duplicate id); one id with another version or
   * URI is ambiguous and refused.
   */
  private integrationRefs(refs: unknown): IntegrationArtifactRef[] {
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_INTEGRATION_REFS) {
      invalid(`An integration batch must name 1..${MAX_INTEGRATION_REFS} exact artifact refs.`);
    }
    const wanted: IntegrationArtifactRef[] = [];
    const seen = new Map<string, IntegrationArtifactRef>();
    for (const raw of refs) {
      if (!isPlain(raw)) {
        invalid('Each integration artifact ref must be an object.');
      }
      const expected = new Set(['id', 'version', 'uri']);
      if (Object.keys(raw).some(key => !expected.has(key))) {
        invalid('An integration artifact ref has unknown fields.');
      }
      const version = raw.version;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
        invalid('ref.version must be a positive safe integer.');
      }
      const ref: IntegrationArtifactRef = {
        id: requireHex64(raw.id, 'ref.id'),
        version,
        uri: requireString(raw.uri, 'ref.uri', 1, 2048)
      };
      const prior = seen.get(ref.id);
      if (prior !== undefined) {
        if (!sameIntegrationRef(prior, ref)) {
          conflict(`Artifact ${ref.id} was requested with different versions or URIs.`);
        }
        continue;
      }
      seen.set(ref.id, ref);
      wanted.push(ref);
    }
    return wanted;
  }

  /** Deterministic internal pin: one exact resource per attempt and role. */
  private integrationPin(scope: IntegrationScope, role: 'source' | 'seed', resource: ViewPin['resource']): ViewPin {
    const id = sha256(['integration-pin', this.namespace, scope.ownerId, scope.teamId, scope.attemptId, role, resource.kind, resource.id]);
    return {
      id,
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      name: `${INTEGRATION_PIN_PREFIX}${id.slice(0, 40)}`,
      resource: { kind: resource.kind, id: resource.id },
      integration: { attemptId: scope.attemptId, role }
    };
  }

  /** The derived seed identity of this attempt, base and exact source set. */
  private integrationSeedId(scope: IntegrationScope, baseSnapshotId: string, refs: readonly IntegrationArtifactRef[]): string {
    return sha256(['integration-seed', this.namespace, scope.ownerId, scope.teamId, scope.attemptId, baseSnapshotId,
      ...refs.map(ref => `${ref.id}/${ref.version}/${ref.uri}`)]);
  }

  private retainingPin(data: ViewIndexData, kind: ViewPin['resource']['kind'], id: string): boolean {
    return Object.values(data.pins).some(pin => pin.resource.kind === kind && pin.resource.id === id);
  }

  /**
   * Proves one EXACT explicit seal in this scope: URI, version, worker and head
   * metadata must all name this submission, a governed runner auto-seal is
   * refused, and an unreferenced released record is unavailable.
   */
  private exactIntegrationSubmission(data: ViewIndexData, scope: IntegrationScope, ref: IntegrationArtifactRef): SealedSubmission {
    const submission = data.submissions[ref.id];
    if (!submission || submission.ownerId !== scope.ownerId || submission.teamId !== scope.teamId) {
      throw new WorkerError('not_found', `No sealed submission ${ref.id} exists in this scope.`);
    }
    if (submission.version !== ref.version || submission.uri !== ref.uri
      || submission.uri !== this.submissionUri(submission.id, submission.version)) {
      conflict('The artifact ref does not name this exact sealed submission version and URI.');
    }
    if (submission.version !== submission.revision + 1 || (submission.head === null) !== (submission.revision === 0)) {
      throw new WorkerError('isolation_corrupt', 'The sealed submission metadata is inconsistent.');
    }
    if (submission.runnerInput === true) {
      conflict('A governed runner auto-seal is not an explicit integration artifact.');
    }
    if (submission.released && !this.retainingPin(data, 'submission', submission.id)) {
      throw new WorkerError('isolation_released', 'This sealed artifact was released and has no retaining reference.');
    }
    return submission;
  }

  /** Re-reads a durable derived seed and proves its stored bytes still match. */
  private async replaySeed(seed: StoredSnapshot): Promise<SnapshotManifest> {
    this.validateBacking(seed.backing, seed.id);
    if (seed.backing.kind !== 'cas') {
      throw new WorkerError('isolation_corrupt', 'A derived integration seed must be committed to this store\'s CAS.');
    }
    if (!seed.provenance || seed.provenance.kind !== 'integration-seed') {
      throw new WorkerError('isolation_corrupt', 'A derived integration seed lost its provenance.');
    }
    const { manifest } = await this.readManifest(seed.manifestHash);
    if (sha256(JSON.stringify(manifest)) !== seed.manifestHash) {
      throw new WorkerError('isolation_corrupt', 'The derived integration seed manifest failed verification.');
    }
    return manifest;
  }

  /** Copies one native provenance so a caller can never alias the index. */
  private copyIntegrationProvenance(provenance: IntegrationSnapshotProvenance): IntegrationSnapshotProvenance {
    return {
      kind: 'integration-seed',
      attemptId: provenance.attemptId,
      baseSnapshotId: provenance.baseSnapshotId,
      refs: provenance.refs.map(ref => ({ id: ref.id, version: ref.version, uri: ref.uri })),
      conflicts: provenance.conflicts.map(group => ({ paths: [...group.paths], inputIds: [...group.inputIds], reason: group.reason }))
    };
  }

  /**
   * Walks the STORED lineage of one base snapshot down to its oldest ordinary
   * capture. Every step is an exact snapshot record of this owner and team read
   * from the index: a missing, foreign, inconsistent or cyclic parent is a
   * fail-closed hole, never resolved from a live workspace path and never
   * guessed. The oldest ordinary record (no integration provenance) is returned
   * as the root and is not listed among the ancestors.
   */
  private integrationLineage(
    data: ViewIndexData, scope: IntegrationScope, baseSnapshotId: string
  ): { oldest: StoredSnapshot; ancestors: { snapshotId: string; provenance: IntegrationSnapshotProvenance }[] } {
    const ancestors: { snapshotId: string; provenance: IntegrationSnapshotProvenance }[] = [];
    const visited = new Set<string>();
    let currentId = baseSnapshotId;
    for (;;) {
      if (visited.has(currentId)) {
        throw new WorkerError('isolation_corrupt', 'The stored integration lineage contains a cycle.');
      }
      visited.add(currentId);
      const snapshot = data.snapshots[currentId];
      if (snapshot === undefined) {
        throw new WorkerError('isolation_corrupt', `The stored integration lineage is missing snapshot ${currentId}; ancestry is never resolved from live files.`);
      }
      if (snapshot.ownerId !== scope.ownerId || snapshot.teamId !== scope.teamId) {
        throw new WorkerError('isolation_corrupt', `The stored integration lineage reaches foreign snapshot ${currentId}.`);
      }
      this.validateBacking(snapshot.backing, snapshot.id);
      const provenance = snapshot.provenance;
      if (provenance === undefined) {
        return { oldest: snapshot, ancestors };
      }
      if (provenance.kind !== 'integration-seed' || provenance.baseSnapshotId === snapshot.id) {
        throw new WorkerError('isolation_corrupt', `Snapshot ${snapshot.id} has inconsistent integration ancestry.`);
      }
      // A legacy link whose parent record is gone is reported as a MISSING
      // snapshot (the honest diagnosis) rather than explored further.
      if (data.snapshots[provenance.baseSnapshotId] === undefined) {
        throw new WorkerError('isolation_corrupt', `The stored integration lineage is missing snapshot ${provenance.baseSnapshotId}; ancestry is never resolved from live files.`);
      }
      // A derived record is durable IDENTITY, not a hint: it must be CAS-backed
      // and its id must be exactly what this store's seed formula yields for its
      // OWN attempt, base and exact refs. Any other link is noncanonical and
      // fails closed (it would name a seed this store never composed).
      if (snapshot.backing.kind !== 'cas'
        || this.integrationSeedId({ ownerId: scope.ownerId, teamId: scope.teamId, attemptId: provenance.attemptId },
          provenance.baseSnapshotId, provenance.refs) !== snapshot.id) {
        throw new WorkerError('isolation_corrupt', `Snapshot ${snapshot.id} is not this store's canonical derived seed record for its own attempt, base and refs.`);
      }
      if (ancestors.length >= MAX_INTEGRATION_ANCESTRY) {
        throw new WorkerError('isolation_capacity', `The stored integration lineage exceeds ${MAX_INTEGRATION_ANCESTRY} derived snapshots.`);
      }
      ancestors.push({ snapshotId: snapshot.id, provenance: this.copyIntegrationProvenance(provenance) });
      currentId = provenance.baseSnapshotId;
    }
  }

  /**
   * The CONFLICTED hops of one stored lineage, leaf-most first, each with the
   * exact refs that hop carried. `carried` is the begin's own selection, i.e. the
   * refs the immediate base is being consumed by here; a deeper hop was consumed
   * by its child seed's own stored provenance refs, so the same ledger proof
   * applies at every depth. A hop is only listed - and therefore only proved -
   * when its OWN conflict groups are unresolved; a conflict-free hop keeps the
   * ordinary clean ancestry.
   */
  private conflictHops(
    ancestors: readonly { snapshotId: string; provenance: IntegrationSnapshotProvenance }[],
    carried: readonly IntegrationArtifactRef[]
  ): IntegrationConflictHop[] {
    const hops: IntegrationConflictHop[] = [];
    for (let index = 0; index < ancestors.length; index += 1) {
      const ancestor = ancestors[index];
      if (ancestor.provenance.conflicts.length === 0) {
        continue;
      }
      const refs = index === 0 ? carried : ancestors[index - 1].provenance.refs;
      hops.push({
        snapshotId: ancestor.snapshotId,
        provenance: this.copyIntegrationProvenance(ancestor.provenance),
        refs: refs.map(ref => ({ id: ref.id, version: ref.version, uri: ref.uri }))
      });
    }
    return hops;
  }

  /**
   * Exact stored ancestry of this attempt's sealed sources, read under the same
   * view mutex as every other retention decision. Each ref must be the EXACT
   * seal of this owner and team, all of them must name ONE immediate base, and
   * that base's durable lineage is walked to its oldest ordinary capture. The
   * returned provenance records are exact native copies, so no caller can alias
   * or mutate store state.
   */
  async integrationSourceAncestry(scope: IntegrationScope, refs: readonly IntegrationArtifactRef[], authorize?: () => void): Promise<IntegrationSourceAncestry> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      const exact = this.integrationScope(scope);
      const wanted = this.integrationRefs(refs);
      const data = this.assertReady();
      let sourceSnapshotId: string | undefined;
      for (const ref of wanted) {
        guard();
        const submission = this.exactIntegrationSubmission(data, exact, ref);
        if (sourceSnapshotId !== undefined && sourceSnapshotId !== submission.snapshotId) {
          conflict('These artifacts were sealed over different base snapshots and share no stored ancestry.');
        }
        sourceSnapshotId = submission.snapshotId;
      }
      const base = sourceSnapshotId as string;
      const lineage = this.integrationLineage(data, exact, base);
      // The oldest ordinary capture is the baseline this lineage really rests
      // on, so it must still resolve from immutable storage before an ancestry
      // answer can be given for it. When the immediate base is itself a derived
      // seed, its own stored bytes must resolve too: a caller is never handed a
      // chain whose first link is already gone.
      await this.ensureRetention(lineage.oldest.id, lineage.oldest.backing, guard);
      await this.readManifest(lineage.oldest.manifestHash);
      guard();
      if (lineage.oldest.id !== base) {
        const immediate = data.snapshots[base];
        await this.ensureRetention(immediate.id, immediate.backing, guard);
        await this.readManifest(immediate.manifestHash);
        guard();
      }
      return { sourceSnapshotId: base, ancestors: lineage.ancestors };
    });
  }

  /**
   * Retains this attempt's exact artifacts in ONE atomic pin publication, after
   * proving every ref and that its exact sealed revision is actually available.
   */
  async retainIntegrationArtifacts(
    scope: IntegrationScope, refs: readonly IntegrationArtifactRef[], authorize?: () => void,
    verify?: (submissions: readonly SealedSubmission[]) => void | Promise<void>
  ): Promise<SealedSubmission[]> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      const exact = this.integrationScope(scope);
      const wanted = this.integrationRefs(refs);
      const data = this.assertReady();
      const proven: SealedSubmission[] = [];
      for (const ref of wanted) {
        guard();
        const submission = this.exactIntegrationSubmission(data, exact, ref);
        // Actual availability: the snapshot, its retention, the manifest and
        // the EXACT sealed revision chain all resolve from immutable storage.
        await this.loadState(data, submission, guard);
        guard();
        proven.push(structuredClone(submission));
      }
      // The caller's verifier runs AFTER every exact immutable seal is proven
      // and BEFORE any index pin changes, under this same view lock: a refusal
      // (wrong base, wrong lane) publishes no pin and leaves no partial set,
      // while an accepted set is published in the ONE update below.
      if (verify !== undefined) {
        if (typeof verify !== 'function') {
          invalid('The artifact verifier must be a function.');
        }
        await verify(proven.map(submission => structuredClone(submission)));
        guard();
      }
      const pins = proven.map(submission => this.integrationPin(exact, 'source', { kind: 'submission', id: submission.id }));
      const publish = (draft: ViewIndexData): void => {
        for (const pin of pins) {
          const current = draft.pins[pin.id];
          if (current !== undefined && (current.name !== pin.name || current.resource.kind !== pin.resource.kind
            || current.resource.id !== pin.resource.id || current.integration?.attemptId !== exact.attemptId
            || current.integration?.role !== 'source')) {
            throw new WorkerError('isolation_conflict', 'An internal integration pin is claimed by a different attempt.');
          }
          draft.pins[pin.id] = pin;
        }
      };
      this.preflightIndex(publish);
      await this.index.update(publish, guard);
      return proven;
    });
  }

  /**
   * Publishes this attempt's private derived seed under the same view/index lock
   * as the pins it reads. Inputs come from durable pins only, must share ONE
   * exact base snapshot, and are merged from their actual LayeredTree entries
   * and raw validated immutable bytes; the seed is a coherent CAS snapshot the
   * attempt keeps pinned, never a publication. Payload writes are bounded ONCE
   * (MAX_COMPOSITION_PAYLOAD_BYTES of distinct bytes) across the synthesized
   * merge results and the native Git blobs the final seed still references, so
   * the whole composition fits its reservation instead of growing per phase.
   *
   * A stored lineage that contains a seed with UNRESOLVED conflict groups may
   * only be composed (or replayed) when `verifyAncestry` - the ledger's own
   * resolution proof - accepts every such hop. The verifier is awaited under this
   * same mutex BEFORE any composed write and BEFORE a durable seed is replayed,
   * and an ancestry that needs it but has no verifier fails closed.
   */
  async composeIntegration(
    scope: IntegrationScope,
    refs: readonly IntegrationArtifactRef[],
    authorize?: () => void,
    verifyAncestry?: (chain: readonly IntegrationConflictHop[]) => void | Promise<void>
  ): Promise<IntegrationComposition> {
    return this.mutex.run(() => this.withStorageWrite(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      const exact = this.integrationScope(scope);
      const wanted = this.integrationRefs(refs);
      const data = this.assertReady();
      const inputs: { id: string; submission: SealedSubmission; snapshot: StoredSnapshot; state: IsolatedViewState }[] = [];
      let baseSnapshotId: string | undefined;
      for (const ref of wanted) {
        guard();
        const submission = this.exactIntegrationSubmission(data, exact, ref);
        const pin = this.integrationPin(exact, 'source', { kind: 'submission', id: submission.id });
        const pinned = data.pins[pin.id];
        if (pinned === undefined || pinned.resource.kind !== 'submission' || pinned.resource.id !== submission.id
          || pinned.integration?.attemptId !== exact.attemptId) {
          conflict('Retain these exact artifacts for this attempt before composing them.');
        }
        if (baseSnapshotId !== undefined && baseSnapshotId !== submission.snapshotId) {
          conflict('These artifacts were sealed over different base snapshots and cannot be composed.');
        }
        baseSnapshotId = submission.snapshotId;
        const snapshot = data.snapshots[submission.snapshotId];
        if (!snapshot || snapshot.ownerId !== exact.ownerId || snapshot.teamId !== exact.teamId) {
          throw new WorkerError('isolation_corrupt', 'The integration base snapshot is missing from this scope.');
        }
        const state = await this.loadState(data, submission, guard);
        guard();
        inputs.push({ id: submission.id, submission, snapshot, state });
      }
      const base = baseSnapshotId as string;
      const baseSnapshot = inputs[0].snapshot;
      const seedId = this.integrationSeedId(exact, base, wanted);
      // The stored lineage is read FIRST, before a durable seed is replayed or a
      // single composed byte is written, because a CONFLICTED hop is a decision
      // this service is not allowed to make on its own: the ledger must prove that
      // the hop was consumed by its exact accepted resolution.
      const lineage = baseSnapshot.provenance === undefined ? undefined : this.integrationLineage(data, exact, base);
      const hops = lineage === undefined ? [] : this.conflictHops(lineage.ancestors, wanted);
      if (hops.length > 0) {
        if (verifyAncestry === undefined) {
          conflict('This composition would consume a derived seed with unresolved merge conflict groups and no resolution verifier proved that ancestry; nothing was composed.');
        }
        // `conflictHops` already returns isolated copies of the stored
        // provenance and refs, so the verifier is handed exactly those.
        await verifyAncestry(hops);
        guard();
      }
      const existing = Object.values(data.snapshots).filter(snapshot => snapshot.ownerId === exact.ownerId
        && snapshot.teamId === exact.teamId && snapshot.provenance?.kind === 'integration-seed'
        && snapshot.provenance.attemptId === exact.attemptId);
      if (existing.length > 0) {
        // Safe replay or refusal from the seed's own durable provenance: no
        // receipt is consulted, so an epoch rollover cannot lose this decision.
        const seed = existing.length === 1 ? existing[0] : undefined;
        const provenance = seed?.provenance;
        if (!seed || !provenance || seed.id !== seedId || provenance.baseSnapshotId !== base
          || provenance.refs.length !== wanted.length || provenance.refs.some((ref, index) => !sameIntegrationRef(ref, wanted[index]))) {
          conflict('This attempt already composed a different exact source set.');
        }
        await this.replaySeed(seed);
        guard();
        return {
          snapshot: structuredClone(seed), baseSnapshotId: base,
          conflicts: provenance.conflicts.map(group => ({ paths: [...group.paths], inputIds: [...group.inputIds], reason: group.reason }))
        };
      }
      // A FRESH composition over a base that is itself a derived seed must prove
      // that stored lineage FIRST: a known legacy hole (or a foreign/corrupted
      // link) would otherwise yield a brand-new attempt that only strands itself
      // in `applying` when publication walks the same chain. Only the oldest
      // ordinary capture manifest is read from immutable storage -- never the
      // intermediate trees, which composition does not need. The replay path
      // above keeps its prove-only behavior for an in-flight attempt. A conflicted
      // hop was already offered to the ledger's verifier above.
      if (lineage !== undefined) {
        await this.ensureRetention(lineage.oldest.id, lineage.oldest.backing, guard);
        await this.readManifest(lineage.oldest.manifestHash);
        guard();
      }
      this.validateBacking(baseSnapshot.backing, baseSnapshot.id);
      await this.ensureRetention(baseSnapshot.id, baseSnapshot.backing, guard);
      const baseManifest = (await this.readManifest(baseSnapshot.manifestHash)).manifest;
      const baseEntries = new LayeredTree(this.index.root, baseManifest.entries).entries;
      // Every UNIQUE visible file hash of every pinned input (plus the base) is
      // verified from immutable storage exactly ONCE, one file at a time, and
      // only its verified LENGTH is remembered. Hash AND size must agree with
      // the recorded entry, and the body is dropped again immediately, so
      // composition never holds more than a single file in memory no matter how
      // many inputs or bytes the attempt names. No live workspace path is used.
      // Verification writes NOTHING: a native Git blob is copied into this
      // store's CAS only after the merge, and only when the FINAL seed still
      // references it, so bytes the merge replaced or deleted are never
      // materialized.
      const sources = new Map<string, { read: (hash: string) => Promise<Buffer>; size: number; copy: boolean }>();
      const readers = new Map<string, (hash: string) => Promise<Buffer>>();
      const readerFor = (snapshot: StoredSnapshot): ((hash: string) => Promise<Buffer>) => {
        const known = readers.get(snapshot.id);
        if (known !== undefined) {
          return known;
        }
        const created = this.readContent
          ? (hash: string) => this.readContent!(snapshot.backing, this.content, hash, guard)
          : createProjectContentReader(snapshot.backing, this.content, guard);
        readers.set(snapshot.id, created);
        return created;
      };
      const note = (snapshot: StoredSnapshot, hash: string, size: number): void => {
        // A hash recorded by a Git backing is NATIVE: it is readable only from
        // that repository until it is copied here. Whether it is copied at all
        // is decided AFTER the merge from the final seed, so a native blob the
        // merge replaced or deleted is never materialized. Any other hash is
        // already content-addressed in this store and is never copied again.
        const copy = snapshot.backing.kind === 'git' && Object.hasOwn(snapshot.backing.blobs, hash);
        const known = sources.get(hash);
        if (known === undefined) {
          sources.set(hash, { read: readerFor(snapshot), size, copy });
          return;
        }
        if (known.size !== size) {
          throw new WorkerError('isolation_corrupt', `The immutable bytes for ${hash} are recorded with two different sizes.`);
        }
        known.copy = known.copy || copy;
      };
      for (const entry of Object.values(baseEntries)) {
        if (entry.type === 'file') {
          note(baseSnapshot, entry.hash, entry.size);
        }
      }
      for (const input of inputs) {
        for (const entry of Object.values(input.state.tree.entries)) {
          if (entry.type === 'file') {
            note(input.snapshot, entry.hash, entry.size);
          }
        }
      }
      // Sequential and deduplicated by hash: every named hash is proved present,
      // immutable and hash/size exact BEFORE the merge, one failure aborts with
      // its own error, and each body is released before the next hash is read.
      // No payload is written by this pass.
      const verified = new Map<string, number>();
      for (const [hash, source] of sources) {
        guard();
        const content = await source.read(hash);
        guard();
        if (content.length !== source.size || sha256Bytes(content) !== hash) {
          throw new WorkerError('snapshot_content_missing', `The immutable bytes for ${hash} do not match their recorded hash and size.`);
        }
        verified.set(hash, source.size);
      }
      // ONE ledger for every payload byte this attempt writes. A hash is charged
      // at most once, whatever produced it, so repeated bytes (the same merge
      // result twice, or a native blob two inputs share) can never exhaust the
      // bound twice; charging always happens BEFORE the write.
      const charged = new Map<string, number>();
      const synthesized = new Set<string>();
      let chargedBytes = 0;
      const charge = (hash: string, size: number): void => {
        const known = charged.get(hash);
        if (known !== undefined) {
          if (known !== size) {
            throw new WorkerError('isolation_corrupt', `The composition payload for ${hash} is recorded with two different sizes.`);
          }
          return;
        }
        const next = chargedBytes + size;
        if (next > MAX_COMPOSITION_PAYLOAD_BYTES) {
          throw new WorkerError('snapshot_capacity',
            `This composition would write ${next} distinct payload bytes; the limit is ${MAX_COMPOSITION_PAYLOAD_BYTES}.`);
        }
        charged.set(hash, size);
        chargedBytes = next;
      };
      const readBase = async (key: string): Promise<{ bytes: Buffer }> => {
        guard();
        const entry = Object.prototype.hasOwnProperty.call(baseEntries, key) ? baseEntries[key] : undefined;
        if (entry === undefined || entry.type !== 'file') {
          throw new WorkerError('not_found', 'The shared base snapshot has no file at this path.');
        }
        if (verified.get(entry.hash) !== entry.size) {
          throw new WorkerError('isolation_corrupt', 'The merge asked for base bytes that were not verified.');
        }
        // Reread the verified bytes from immutable storage instead of retaining
        // them: only the paths several inputs changed are ever asked for.
        const content = await readerFor(baseSnapshot)(entry.hash);
        guard();
        if (content.length !== entry.size || sha256Bytes(content) !== entry.hash) {
          throw new WorkerError('snapshot_content_missing', `The immutable bytes for ${entry.hash} do not match their recorded hash and size.`);
        }
        return { bytes: content };
      };
      guard();
      const merged = await mergeIntegrationTrees(this.index.root, baseEntries, readBase,
        inputs.map(input => ({ id: input.id, entries: input.state.tree.entries, read: input.state.read })),
        async (putBytes: Buffer) => {
          guard();
          // A synthesized merge result is charged by its own hash BEFORE it is
          // written, so the bound is never crossed and identical results cost
          // once.
          const hash = sha256Bytes(putBytes);
          charge(hash, putBytes.length);
          if (await this.content.put(putBytes, guard) !== hash) {
            throw new WorkerError('snapshot_content_missing', 'The synthesized merged bytes changed their hash.');
          }
          synthesized.add(hash);
          guard();
          return hash;
        });
      const mergedEntries: Record<string, SnapshotEntry> = Object.create(null);
      for (const key of Object.getOwnPropertyNames(baseEntries)) {
        if (!Object.prototype.hasOwnProperty.call(merged.changes, key)) {
          mergedEntries[key] = baseEntries[key];
        }
      }
      for (const key of Object.keys(merged.changes)) {
        const change = merged.changes[key];
        if (change !== null) {
          mergedEntries[key] = change;
        }
      }
      const entries = new LayeredTree(this.index.root, mergedEntries).entries;
      let fileCount = 0;
      let totalBytes = 0;
      for (const entry of Object.values(entries)) {
        if (entry.type === 'file') {
          fileCount += 1;
          totalBytes += entry.size;
        }
      }
      // Deterministic identity of the composed content, independent of time:
      // the seed is the SAME bytes on every replay of this exact source set.
      const fingerprint = sha256(['integration-seed-fingerprint', this.namespace, exact.ownerId, exact.teamId, exact.attemptId, base,
        JSON.stringify(Object.keys(entries).sort().map(key => [key, entries[key]]))]);
      const candidate: SnapshotManifest = {
        schema: 1, root: this.index.root, capturedAt: baseManifest.capturedAt, fingerprint, fileCount, totalBytes,
        entries: { ...entries }
      };
      const { manifest, capturedAt } = this.validateManifest(candidate);
      const manifestText = JSON.stringify(manifest);
      if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) {
        throw new WorkerError('snapshot_capacity', 'The derived seed manifest exceeds 32 MiB.');
      }
      // The FINAL seed decides what is copied. Only native Git blobs it still
      // references are materialized - a native blob the merge replaced or
      // deleted never reaches this store - and their whole distinct remaining
      // total is preflighted TOGETHER with every synthesized write already
      // attempted, before a single further byte is written.
      const nativeCopies = new Map<string, { read: (hash: string) => Promise<Buffer>; size: number }>();
      let remainingBytes = 0;
      for (const entry of Object.values(entries)) {
        if (entry.type !== 'file' || synthesized.has(entry.hash) || nativeCopies.has(entry.hash)) {
          continue;
        }
        const source = sources.get(entry.hash);
        if (source === undefined) {
          throw new WorkerError('isolation_corrupt',
            `The derived seed references ${entry.hash}, which this composition never verified.`);
        }
        if (verified.get(entry.hash) !== entry.size || source.size !== entry.size) {
          throw new WorkerError('isolation_corrupt', 'The derived seed records a file size that was not verified.');
        }
        if (!source.copy) {
          // Already content-addressed in this store: never copied again.
          continue;
        }
        if (!charged.has(entry.hash)) {
          remainingBytes += source.size;
        }
        nativeCopies.set(entry.hash, source);
      }
      if (chargedBytes + remainingBytes > MAX_COMPOSITION_PAYLOAD_BYTES) {
        throw new WorkerError('snapshot_capacity',
          `This composition would write ${chargedBytes + remainingBytes} distinct payload bytes; the limit is ${MAX_COMPOSITION_PAYLOAD_BYTES}.`);
      }
      for (const [hash, source] of nativeCopies) {
        charge(hash, source.size);
        guard();
        // Fail-closed: the final native bytes are read AGAIN from their actual
        // immutable backing and must still match the recorded hash and size
        // before they are copied into this store's CAS.
        const content = await source.read(hash);
        guard();
        if (content.length !== source.size || sha256Bytes(content) !== hash) {
          throw new WorkerError('snapshot_content_missing', `The immutable bytes for ${hash} do not match their recorded hash and size.`);
        }
        if (await this.content.put(content, guard) !== hash) {
          throw new WorkerError('snapshot_content_missing', 'The copied immutable bytes changed their hash.');
        }
        guard();
      }
      const manifestHash = sha256(manifestText);
      if (await this.content.put(Buffer.from(manifestText, 'utf8'), guard) !== manifestHash) {
        throw new WorkerError('snapshot_content_missing', 'The stored seed manifest hash changed.');
      }
      guard();
      const conflicts = merged.conflicts.map(group => ({ paths: [...group.paths], inputIds: [...group.inputIds], reason: group.reason }));
      const seed: StoredSnapshot = {
        id: seedId, teamId: exact.teamId, ownerId: exact.ownerId, manifestHash, backing: { kind: 'cas' }, createdAt: capturedAt,
        provenance: {
          kind: 'integration-seed', attemptId: exact.attemptId, baseSnapshotId: base,
          refs: wanted.map(ref => ({ id: ref.id, version: ref.version, uri: ref.uri })), conflicts
        }
      };
      const seedPin = this.integrationPin(exact, 'seed', { kind: 'snapshot', id: seed.id });
      const publish = (draft: ViewIndexData): void => {
        if (draft.snapshots[seed.id] !== undefined) {
          throw new WorkerError('isolation_conflict', 'The derived seed snapshot was published while composing.');
        }
        const claimed = Object.values(draft.pins).find(pin => pin.integration?.attemptId === exact.attemptId
          && pin.integration.role === 'seed' && pin.resource.id !== seed.id);
        if (claimed !== undefined) {
          throw new WorkerError('isolation_conflict', 'This attempt already has a different derived seed snapshot.');
        }
        draft.snapshots[seed.id] = seed;
        draft.pins[seedPin.id] = seedPin;
      };
      this.preflightIndex(publish);
      const committed = await this.index.update(publish, guard);
      return { snapshot: structuredClone(committed.snapshots[seed.id]), baseSnapshotId: base, conflicts };
    }));
  }

  /**
   * Drops exactly this attempt's internal pins - nothing else. A producer or
   * candidate sealed submission is NEVER marked released here, and no private
   * view is touched, so an otherwise live explicit artifact stays readable
   * after this attempt is released and collected. The derived seed simply
   * becomes an ordinary unreferenced snapshot, which the existing
   * reference-aware cleanup collects only once nothing (an unreleased
   * submission or overlay) still roots it. Idempotent, and the ONLY path that
   * may release an integration pin: a public retention call refuses them.
   */
  async releaseIntegrationArtifacts(scope: IntegrationScope, authorize?: () => void): Promise<void> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      const exact = this.integrationScope(scope);
      const data = this.assertReady();
      const own = Object.values(data.pins)
        .filter(pin => pin.ownerId === exact.ownerId && pin.teamId === exact.teamId
          && pin.integration?.attemptId === exact.attemptId)
        .map(pin => pin.id);
      if (own.length === 0) {
        return;
      }
      const apply = (draft: ViewIndexData): void => {
        for (const id of own) {
          const pin = draft.pins[id];
          if (pin !== undefined && pin.integration?.attemptId === exact.attemptId) {
            delete draft.pins[id];
          }
        }
      };
      this.preflightIndex(apply);
      await this.index.update(apply, guard);
    });
  }

  /**
   * Offers the CAPTURED original base manifest and this attempt's sealed
   * candidate view under the view lock. Every identity is proved from durable
   * records: this attempt's exact internal pin, its derived seed and the
   * original base the seed was composed over.
   */
  async withIntegrationCandidate<T>(
    scope: IntegrationScope, baseSnapshotId: string, ref: IntegrationArtifactRef,
    action: (base: SnapshotManifest, candidate: IsolatedViewState, submission: SealedSubmission) => T | Promise<T>,
    authorize?: () => void
  ): Promise<T> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      if (typeof action !== 'function') {
        invalid('withIntegrationCandidate requires an action function.');
      }
      const exact = this.integrationScope(scope);
      const wanted = this.integrationRefs([ref])[0];
      const base = requireHex64(baseSnapshotId, 'baseSnapshotId');
      const data = this.assertReady();
      const submission = this.exactIntegrationSubmission(data, exact, wanted);
      const pin = this.integrationPin(exact, 'source', { kind: 'submission', id: submission.id });
      const pinned = data.pins[pin.id];
      if (pinned === undefined || pinned.resource.kind !== 'submission' || pinned.resource.id !== submission.id
        || pinned.integration?.attemptId !== exact.attemptId) {
        conflict('This candidate is not an exact artifact retained by this integration attempt.');
      }
      const seed = data.snapshots[submission.snapshotId];
      const provenance = seed?.provenance;
      // The candidate must be SEALED OVER this attempt's derived seed, and that
      // seed must name the original base the caller accepted. The candidate is
      // a new submission over the seed, so it is proved by the pin and snapshot
      // identity below, not by being one of the seed's source refs.
      if (!seed || !provenance || provenance.kind !== 'integration-seed' || provenance.attemptId !== exact.attemptId
        || provenance.baseSnapshotId !== base) {
        conflict('This candidate is not sealed over this attempt\'s derived seed for the accepted base.');
      }
      await this.replaySeed(seed);
      guard();
      // The candidate's exact immediate parent (this attempt's derived seed),
      // its attempt and the accepted base are proved above. Publication must
      // diff and check EDITOR ORIGIN against the oldest ordinary capture of
      // that stored lineage - the real workspace baseline - because an
      // intermediate derived seed is a private composition the workspace never
      // holds and it carries no editor provenance of its own. The chain is
      // stored data only: a missing, foreign or cyclic parent fails closed
      // instead of falling back to live files.
      const lineage = this.integrationLineage(data, exact, seed.id);
      const baseline = lineage.oldest;
      this.validateBacking(baseline.backing, baseline.id);
      await this.ensureRetention(baseline.id, baseline.backing, guard);
      const baseManifest = (await this.readManifest(baseline.manifestHash)).manifest;
      const candidate = await this.loadState(data, submission, guard);
      guard();
      const result = await action(baseManifest, candidate, structuredClone(submission));
      guard();
      return result;
    });
  }

  private retentionRequest(data: ViewIndexData, operation: string, scope: RetentionScope, args: string[]): { key: string; fingerprint: string; receipt?: ViewReceipt } {
    requireString(scope.requestId, 'requestId', 1, 200);
    const key = sha256([operation, this.namespace, scope.ownerId, scope.teamId, scope.requestId]);
    this.index.request(scope.ownerId, scope.requestId, key);
    const fingerprint = sha256([operation, scope.ownerId, scope.teamId, ...args]);
    const receipt = data.receipts[key];
    if (receipt && receipt.fingerprint !== fingerprint) {
      conflict('This requestId was already used with different arguments.');
    }
    if (receipt) {
      // Reaching here IS an authorization-checked exact replay: the caller
      // already re-ran its live guard and scope check, the key is derived from
      // this owner's own scope and the operation aliases one owned effect, and
      // the stored fingerprint matched. That proves which owner an ownerless
      // legacy acknowledgement belongs to, so the next update publishes it.
      this.index.adoptReceiptOwner(key, scope.ownerId);
    }
    return { key, fingerprint, receipt };
  }

  /**
   * The owner one durable receipt PROVES, or undefined when its payload alone
   * cannot prove it. Evidence is restricted to records this store wrote and
   * validated again here: a snapshot, overlay, sealed submission or pin
   * acknowledgement that carries its own ownerId, or an acknowledgement naming
   * one exact artifact id that this index still holds. A live record that
   * disagrees with its own acknowledgement proves nothing, so a mixed index can
   * never turn into a guess.
   */
  private provenReceiptOwner(data: ViewIndexData, result: unknown): string | undefined {
    const parsed = <T>(parse: (value: unknown) => T): T | undefined => {
      try {
        return parse(result);
      } catch {
        return undefined; // not this record shape
      }
    };
    // The acknowledgement may outlive its record; when it does not, both must agree.
    const agree = (live: { ownerId: string } | undefined, ownerId: string): string | undefined =>
      (live === undefined || live.ownerId === ownerId ? ownerId : undefined);
    const snapshot = parsed(parseStoredSnapshot);
    if (snapshot) {
      return agree(data.snapshots[snapshot.id], snapshot.ownerId);
    }
    const overlay = parsed(parseOverlayRecord);
    if (overlay) {
      return agree(data.overlays[overlay.overlayId], overlay.ownerId);
    }
    const submission = parsed(parseSealedSubmission);
    if (submission) {
      return agree(data.submissions[submission.id], submission.ownerId);
    }
    const pin = parsed(parseViewPin);
    if (pin) {
      return agree(data.pins[pin.id], pin.ownerId);
    }
    if (!isPlain(result)) {
      return undefined;
    }
    const keys = Object.keys(result);
    // A discarded capture names the exact snapshot identity it retired.
    if (keys.length === 1 && typeof result.cancelledCapture === 'string') {
      const id = result.cancelledCapture;
      return data.snapshots[id]?.ownerId ?? data.pendingCaptures[id]?.snapshot.ownerId;
    }
    // A release acknowledgement names one exact artifact of this index.
    if (keys.length === 3 && result.released === true && typeof result.kind === 'string' && typeof result.id === 'string') {
      const id = result.id;
      switch (result.kind) {
        case 'snapshot': return data.snapshots[id]?.ownerId;
        case 'overlay': return data.overlays[id]?.ownerId;
        case 'submission': return data.submissions[id]?.ownerId;
        case 'pin': return data.pins[id]?.ownerId;
        case 'pending': return data.pendingCaptures[id]?.snapshot.ownerId;
        default: return undefined;
      }
    }
    return undefined;
  }

  // -- inspect ---------------------------------------------------------------

  /** Archive records still reserved by a pending publication intent cannot be reused by another epoch. */
  private reservedArchiveRecords(pending: readonly ReceiptArchivePublication[]): number {
    return pending.reduce((total, intent) => total + intent.archives.length, 0);
  }

  /**
   * Completes one owner's durable publication intent: only its missing parts are
   * opened, its frozen receipt selection is archived, and its exact epoch
   * advance is committed. Parts opened before an interruption stay named by that
   * intent, so a bounded file is never orphaned; receipts accepted after the
   * intent stay live and replayable.
   */
  private async resumeArchivePublication(publication: ReceiptArchivePublication): Promise<{ archives: ReceiptArchive[]; retained: number }> {
    // A pending-intent retry is the same durable filesystem phase as a fresh
    // rollover, so it takes the same store write fence before any missing part
    // is opened, published or committed.
    return this.withStorageWrite(async () => {
      const data = this.assertReady();
      if (publication.namespace !== this.namespace || currentEpoch(data, publication.ownerId) !== publication.fromEpoch) {
        throw new WorkerError('isolation_corrupt', 'The pending receipt archive publication does not match this store or its durable receipt epoch; inspect it before rolling over.');
      }
      const selected = selectPublicationReceipts(publication, data.receipts);
      const others = (data.receiptArchivePublications ?? []).filter(intent => intent.namespace !== publication.namespace
        || intent.ownerId !== publication.ownerId || intent.fromEpoch !== publication.fromEpoch);
      const records = MAX_RECEIPT_ARCHIVE_FILES - (data.receiptArchives?.length ?? 0) - (data.receiptArchiveDeletes?.length ?? 0) - this.reservedArchiveRecords(others);
      const archives = await publishArchivePublication(this.directory, publication, selected, records);
      await this.index.update(draft => {
        if (currentEpoch(draft, publication.ownerId) !== publication.fromEpoch
          || !(draft.receiptArchivePublications ?? []).some(intent => intent.namespace === publication.namespace && intent.ownerId === publication.ownerId && intent.fromEpoch === publication.fromEpoch)) {
          throw new WorkerError('revision_conflict', 'The receipt archive publication intent changed before it could be completed.');
        }
        draft.legacyRequestKeys ??= Object.keys(draft.receipts);
        for (const key of Object.keys(selected)) {
          delete draft.receipts[key];
        }
        (draft.receiptEpochs ??= {})[digest(publication.ownerId)] = publication.toEpoch;
        (draft.receiptArchives ??= []).push(...archives);
        const left = (draft.receiptArchivePublications ?? []).filter(intent => intent.namespace !== publication.namespace
          || intent.ownerId !== publication.ownerId || intent.fromEpoch !== publication.fromEpoch);
        if (left.length) {
          draft.receiptArchivePublications = left;
        } else {
          delete draft.receiptArchivePublications;
        }
      });
      return { archives, retained: Object.keys(this.assertReady().receipts).length };
    });
  }

  /**
   * `enroll` is the lifecycle host's optional first-time durable registration. It
   * runs INSIDE this view mutex at the start of the durable phase - after the
   * epoch, pending-capture, binding-intent, replay and capacity checks - and
   * before the one whole filesystem write fence, so a refused rollover enrolls
   * nothing. It is handed the read-only archive preflight and runs it ONLY while
   * this store is not yet registered, so a physical archive refusal leaves no
   * registration and no aggregate row, while an already registered store pays no
   * second archive preparation. A direct domain caller that omits it keeps the
   * original behavior.
   */
  async rolloverReceipts(ownerId: string, expectedEpoch: number, enroll?: (check: () => Promise<void>) => Promise<void>): Promise<unknown> {
    return this.mutex.run(async () => {
      const data = this.assertReady();
      const epoch = currentEpoch(data, ownerId);
      const pending = data.receiptArchivePublications ?? [];
      // A pending intent belongs to its initiating owner and exact fromEpoch: no
      // other owner and no other epoch may publish under its authority.
      const own = pending.find(intent => intent.namespace === this.namespace && intent.ownerId === ownerId);
      if (own) {
        if (own.fromEpoch !== expectedEpoch || epoch !== expectedEpoch) {
          throw new WorkerError('revision_conflict', `This owner still has a pending receipt archive publication for epoch ${own.fromEpoch}. Retry the rollover with expectedEpoch ${own.fromEpoch} to finish it; no other epoch can be published first.`);
        }
        // Recovering a durable pending publication follows the same first
        // registration rule: this exact owner and epoch were accepted above, so it
        // enrolls before the store write fence resumes the publication. A store that
        // is not registered yet first revalidates its own frozen archive read-only.
        await enroll?.(() => {
          const frozen = selectPublicationReceipts(own, data.receipts);
          const others = pending.filter(intent => intent.namespace !== own.namespace
            || intent.ownerId !== own.ownerId || intent.fromEpoch !== own.fromEpoch);
          const records = MAX_RECEIPT_ARCHIVE_FILES - (data.receiptArchives?.length ?? 0) - (data.receiptArchiveDeletes?.length ?? 0) - this.reservedArchiveRecords(others);
          return preflightArchivePublication(this.directory, own, frozen, records);
        });
        const resumed = await this.resumeArchivePublication(own);
        return { epoch: own.toEpoch, prefix: 'e' + own.toEpoch + ':', archives: resumed.archives,
          archive: resumed.archives.length === 1 ? resumed.archives[0] : undefined,
          retainedUnscopedLegacyReceipts: resumed.retained, replay: true, resumed: true };
      }
      if (epoch === expectedEpoch + 1) {
        return { epoch, replay: true, retainedUnscopedLegacyReceipts: Object.keys(data.receipts).length };
      }
      if (epoch !== expectedEpoch || !Number.isSafeInteger(epoch + 1)) {
        throw new WorkerError('revision_conflict', 'View receipt epoch changed.');
      }
      if (Object.keys(data.pendingCaptures).length || Object.values(data.pins).some(p => p.binding)) {
        throw new WorkerError('worker_busy', 'Finish or reconcile pending captures and binding intents before rollover.');
      }
      // One epoch can need several deterministic parts, so the record and
      // directory caps are checked before any part is published. Records already
      // reserved by any owner's pending intent stay unavailable here.
      const archiveCapacity = MAX_RECEIPT_ARCHIVE_FILES - (data.receiptArchives?.length ?? 0) - (data.receiptArchiveDeletes?.length ?? 0) - this.reservedArchiveRecords(pending);
      if (archiveCapacity < 1) {
        throw new WorkerError('receipt_capacity', `Collect unreferenced receipt archives before rollover (${MAX_RECEIPT_ARCHIVE_FILES} retained, pending deletion or reserved by ${pending.length} pending publication(s)).`);
      }
      // Ownership is proven per receipt, never guessed: the durable ownership
      // map, an exact authorized replay whose fingerprint matched, or a
      // validated record/result identity this index still holds. A receipt
      // nothing proves is left live for its own owner, even when every current
      // artifact looks single-owner - a prior other-owner artifact may already
      // be gone, so the index shape is not evidence.
      const proven = new Map<string, string>();
      for (const [key, receipt] of Object.entries(data.receipts)) {
        const owner = this.index.receiptOwnerOf(key) ?? this.provenReceiptOwner(data, receipt.result);
        if (owner !== undefined) {
          proven.set(key, owner);
        }
      }
      const selected: typeof data.receipts = {};
      for (const [key, receipt] of Object.entries(data.receipts)) {
        if (proven.get(key) === ownerId) {
          selected[key] = receipt;
        }
      }
      const publication = planArchivePublication(this.namespace, ownerId, epoch, selected);
      if (publication.archives.length > archiveCapacity) {
        throw new WorkerError('receipt_capacity', `Receipt archive records are bounded to ${MAX_RECEIPT_ARCHIVE_FILES} and only ${archiveCapacity} remain, but this epoch needs ${publication.archives.length} parts. Collect unreferenced receipt archives before rollover.`);
      }
      // A physical archive refusal must not register this store, so the whole
      // read-only archive preflight is handed to the host: it runs under this mutex
      // and BEFORE any first registration, never for an already registered store.
      await enroll?.(() => preflightArchivePublication(this.directory, publication, selected, archiveCapacity));
      // Every bound is proven before the intent is durable and before any part
      // is opened, so a rejected rollover leaves no metadata and no file. The
      // durable filesystem phase - preflight, publication intent, every archive
      // part and the epoch commit - runs under ONE store write fence, and no
      // resource admission runs inside it: a reclaiming rollover never waits for
      // a permit, so it stays available when the lane is exhausted. The read-only
      // preflight above proved this directory usable while the store was still
      // unregistered; the fenced preflight revalidates it under this same single
      // fence before the intent becomes durable.
      const archives = await this.withStorageWrite(async () => {
        await preflightArchivePublication(this.directory, publication, selected, archiveCapacity);
        await this.index.update(draft => {
          draft.receiptArchivePublications = [...(draft.receiptArchivePublications ?? []), publication];
        });
        // Parts are opened only after the intent is durable. An interruption from
        // here on is recoverable by this owner's exact retry, never an orphan file.
        const published = await publishArchivePublication(this.directory, publication, selected, archiveCapacity);
        await this.index.update(draft => {
          draft.legacyRequestKeys ??= Object.keys(draft.receipts);
          for (const key of Object.keys(selected)) {
            delete draft.receipts[key];
          }
          (draft.receiptEpochs ??= {})[digest(ownerId)] = epoch + 1; (draft.receiptArchives ??= []).push(...published);
          const left = (draft.receiptArchivePublications ?? []).filter(intent => intent.namespace !== publication.namespace
            || intent.ownerId !== publication.ownerId || intent.fromEpoch !== publication.fromEpoch);
          if (left.length) {
            draft.receiptArchivePublications = left;
          } else {
            delete draft.receiptArchivePublications;
          }
        });
        return published;
      });
      return { epoch: epoch + 1, prefix: 'e' + (epoch + 1) + ':', archives, archive: archives.length === 1 ? archives[0] : undefined,
        retainedUnscopedLegacyReceipts: Object.keys(data.receipts).length - Object.keys(selected).length };
    });
  }

  async collectReceiptArchives(ownerId: string, retained: ReadonlySet<string>): Promise<number> {
    return this.mutex.run(async () => {
      const data = this.assertReady();
      const pending = data.receiptArchiveDeletes ?? [];
      // Only this owner's proven-unretained entries are completed. Another
      // owner's intent, and any identity still pinned or referenced here, stay
      // published for its own explicit retry after the reference is released.
      const others = pending.filter(archive => archive.ownerId !== ownerId);
      const retainedIntent = pending.filter(archive => archive.ownerId === ownerId && retained.has(archive.uri));
      const work = pending.filter(archive => archive.ownerId === ownerId && !retained.has(archive.uri));
      const removed = (data.receiptArchives ?? []).filter(archive => archive.ownerId === ownerId && !retained.has(archive.uri));
      for (const archive of removed) {
        if (!work.some(done => done.hash === archive.hash)) {
          work.push(archive);
        }
      }
      const intent = [...others, ...retainedIntent, ...work];
      if (intent.length > MAX_RECEIPT_ARCHIVE_FILES) {
        throw new WorkerError('receipt_capacity', 'Archive deletions for this store are already pending. Retry this collection to finish them before removing more archives.');
      }
      if (!removed.length && !work.length) {
        return 0;
      }
      await this.index.update(draft => {
        if (removed.length) {
          draft.receiptArchives = (draft.receiptArchives ?? []).filter(archive => !removed.some(r => r.hash === archive.hash));
        }
        // Durable deletion intent published with the reference removal: a crash
        // after this point leaves exact recoverable identities, never orphans.
        if (intent.length) {
          draft.receiptArchiveDeletes = intent;
        } else {
          delete draft.receiptArchiveDeletes;
        }
      });
      if (!work.length) {
        return 0;
      }
      const outcome = await completeArchiveDeletions(this.directory, work);
      const left = [...others, ...retainedIntent, ...outcome.remaining];
      await this.index.update(draft => {
        if (left.length) {
          draft.receiptArchiveDeletes = left;
        } else {
          delete draft.receiptArchiveDeletes;
        }
      });
      if (outcome.remaining.length) {
        throw new WorkerError('receipt_unavailable', `Receipt archive cleanup could not finish ${outcome.remaining.length} pending deletion(s) in ${this.directory}. The immutable intent was kept; retry this collection after restoring access. ${outcome.diagnostics.join(' ')}`, true);
      }
      return outcome.deleted.length;
    });
  }
  hasReceipt(key: string): boolean {
    return this.assertReady().receipts[key] !== undefined;
  }
  requestId(ownerId: string, key: string): string {
    return epochRequest(this.assertReady(), ownerId, key);
  }
  async inspect(ownerId: string, teamId: string): Promise<SnapshotInspection> {
    return this.mutex.run(async () => {
      this.checkAlive();
      if (!this.opened) {
        throw new WorkerError('unavailable', 'The isolated views are not open; call open() first.');
      }
      if (typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 200) {
        invalid('ownerId must be a 1..200 character string.');
      }
      if (typeof teamId !== 'string' || !TEAM32.test(teamId)) {
        invalid('teamId must be 32 lowercase hex characters.');
      }
      const data = this.index.read();
      const scoped = <T extends { ownerId: string; teamId: string }>(records: Record<string, T>): T[] =>
        Object.values(records).filter(record => record.ownerId === ownerId && record.teamId === teamId);
      return {
        revision: data.revision,
        snapshots: scoped(data.snapshots),
        overlays: scoped(data.overlays),
        submissions: scoped(data.submissions),
        pins: scoped(data.pins),
        pendingCaptures: Object.values(data.pendingCaptures)
          .filter(pending => pending.snapshot.ownerId === ownerId && pending.snapshot.teamId === teamId)
          .map(pending => ({
            snapshotId: pending.snapshot.id,
            fingerprint: pending.fingerprint
          }))
      };
    });
  }

  // -- internals -------------------------------------------------------------

  /**
   * Applies a mutator to a throwaway draft (a full clone, never shared) and
   * runs the pure validateIndex over the projected state: every cap, the
   * serialized byte limit, the graph, the root and a safe-integer revision.
   * `advance` models the revision increment(s) between now and the state.
   */
  private preflightIndex(mutator: (draft: ViewIndexData) => void, advance = 1): void {
    const draft = structuredClone(this.index.read());
    mutator(draft);
    if (!Number.isSafeInteger(draft.revision + advance) || draft.revision + advance > Number.MAX_SAFE_INTEGER) {
      throw new WorkerError('isolation_capacity', 'The index revision would overflow.');
    }
    draft.revision += advance;
    validateIndex(draft, this.index.root);
  }

  private async readManifest(manifestHash: string): Promise<{ manifest: SnapshotManifest; capturedAt: string }> {
    const bytes = await this.content.read(manifestHash);
    this.checkAlive();
    if (bytes.length > MAX_MANIFEST_BYTES) {
      throw new WorkerError('isolation_corrupt', 'The stored manifest exceeds 32 MiB.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new WorkerError('isolation_corrupt', 'The stored manifest is not valid JSON.');
    }
    return this.validateManifest(parsed);
  }

  /**
   * Strict manifest validation; returns the manifest record with its capturedAt.
   * Entry namespace structure is validated through a LayeredTree build (path
   * and case checks, parent directories, entry caps); the entries record is
   * NEVER normalized through Zod, so `__proto__` path names are preserved.
   */
  private validateManifest(raw: unknown): { manifest: SnapshotManifest; capturedAt: string } {
    if (!isPlain(raw)) {
      invalid('The capture manifest must be an object.');
    }
    const expected = new Set(['schema', 'root', 'capturedAt', 'fingerprint', 'fileCount', 'totalBytes', 'entries', 'editorPaths']);
    if (Object.keys(raw).some(key => !expected.has(key))) {
      invalid('The capture manifest has unknown fields.');
    }
    const manifest = raw as Record<string, unknown>;
    if (manifest.schema !== 1) {
      invalid('The capture manifest schema must be 1.');
    }
    if (typeof manifest.root !== 'string' || manifest.root.length === 0 || manifest.root.length > 8192 || !path.isAbsolute(manifest.root)) {
      invalid('The capture manifest root must be a native absolute path.');
    }
    if (manifest.root !== this.index.root) {
      invalid('The capture manifest belongs to a different workspace root.');
    }
    if (typeof manifest.capturedAt !== 'string' || !isIso(manifest.capturedAt)) {
      invalid('The capture manifest capturedAt must be an ISO timestamp.');
    }
    if (typeof manifest.fingerprint !== 'string' || !HEX64.test(manifest.fingerprint)) {
      invalid('The capture manifest fingerprint must be 64 lowercase hex characters.');
    }
    if (typeof manifest.fileCount !== 'number' || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0) {
      invalid('The capture manifest fileCount must be a non-negative integer.');
    }
    if (typeof manifest.totalBytes !== 'number' || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
      invalid('The capture manifest totalBytes must be a non-negative integer.');
    }
    if (!isPlain(manifest.entries)) {
      invalid('The capture manifest entries must be a record.');
    }
    let files = 0;
    let total = 0;
    const entries = manifest.entries as Record<string, unknown>;
    for (const [key, value] of Object.entries(entries)) {
      if (key.length === 0 || key.length > 4096 || key.includes('\\') || key.startsWith('/')) {
        invalid(`The manifest entry key ${JSON.stringify(key)} is not a relative POSIX path.`);
      }
      if (!isPlain(value)) {
        invalid(`The manifest entry ${JSON.stringify(key)} must be an object.`);
      }
      const entry = value as Record<string, unknown>;
      let fileEntrySize: number | undefined;
      switch (entry.type) {
        case 'file': {
          if (Object.keys(entry).some(k => !['type', 'hash', 'size', 'mode'].includes(k))) {
            invalid(`The manifest file entry ${JSON.stringify(key)} has unknown fields.`);
          }
          if (typeof entry.hash !== 'string' || !HEX64.test(entry.hash)) {
            invalid(`The manifest file entry ${JSON.stringify(key)} has a bad hash.`);
          }
          if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
            invalid(`The manifest file entry ${JSON.stringify(key)} has a bad size.`);
          }
          // Optional executable mode metadata (legacy manifests omit it and
          // read as 0o644); anything other than the two recorded modes is
          // corrupt rather than silently dropped.
          if (entry.mode !== undefined && !isFileMode(entry.mode)) {
            invalid(`The manifest file entry ${JSON.stringify(key)} has a bad mode.`);
          }
          fileEntrySize = entry.size;
          files += 1;
          total += fileEntrySize;
          break;
        }
        case 'directory':
          if (Object.keys(entry).some(k => k !== 'type')) {
            invalid(`The manifest directory entry ${JSON.stringify(key)} has unknown fields.`);
          }
          break;
        case 'unsupported':
        case 'excluded':
          if (Object.keys(entry).some(k => !['type', 'detail'].includes(k)) || typeof entry.detail !== 'string') {
            invalid(`The manifest entry ${JSON.stringify(key)} has a bad detail.`);
          }
          break;
        default:
          invalid(`The manifest entry ${JSON.stringify(key)} has an unknown type.`);
      }
      if (fileEntrySize !== undefined && fileEntrySize > MAX_MANIFEST_FILE_BYTES) {
        throw new WorkerError('snapshot_capacity', `Manifest file ${JSON.stringify(key)} exceeds 32 MiB.`);
      }
    }
    // Optional editor provenance: an explicit `[]` means every captured path
    // came from raw disk, while an ABSENT field stays the legacy "unknown". When
    // present it must be sorted, unique and name EXACT captured file keys.
    const editorPaths = (manifest as Record<string, unknown>).editorPaths;
    if (editorPaths !== undefined) {
      if (!Array.isArray(editorPaths) || editorPaths.length > MAX_MANIFEST_FILES
        || editorPaths.some(value => typeof value !== 'string' || value.length === 0 || value.length > 4096)) {
        invalid('The capture manifest editorPaths must be an array of relative POSIX paths.');
      }
      for (let index = 0; index < editorPaths.length; index += 1) {
        const key = editorPaths[index] as string;
        if (index > 0 && !((editorPaths[index - 1] as string) < key)) {
          invalid('The capture manifest editorPaths must be sorted and unique.');
        }
        const entry = Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
        if (!isPlain(entry) || entry.type !== 'file') {
          invalid(`The manifest editor path ${JSON.stringify(key)} is not an exact captured file.`);
        }
      }
    }
    if (files > MAX_MANIFEST_FILES) {
      throw new WorkerError('snapshot_capacity', `The manifest has ${files} files; the limit is ${MAX_MANIFEST_FILES}.`);
    }
    if (total > MAX_MANIFEST_TOTAL_BYTES) {
      throw new WorkerError('snapshot_capacity', `The manifest totals ${total} bytes; the limit is ${MAX_MANIFEST_TOTAL_BYTES}.`);
    }
    if (files !== manifest.fileCount || total !== manifest.totalBytes) {
      invalid('The manifest fileCount or totalBytes does not match its entries.');
    }
    // Entry namespace validation through the pure tree: path shape, case
    // collisions, parent directories and the total entry cap all fail closed.
    new LayeredTree(manifest.root as string, entries as Record<string, SnapshotEntry>);
    return { manifest: manifest as unknown as SnapshotManifest, capturedAt: manifest.capturedAt as string };
  }

  private validateBacking(raw: unknown, snapshotId: string): SnapshotBacking {
    if (!isPlain(raw)) {
      invalid('The capture backing must be an object.');
    }
    const backing = raw as Record<string, unknown>;
    if (backing.kind === 'cas') {
      if (Object.keys(backing).some(key => key !== 'kind')) {
        invalid('The CAS backing must carry only its kind.');
      }
      return { kind: 'cas' };
    }
    if (backing.kind === 'git') {
      // Unknown outer fields are rejected: the candidate journal is immutable.
      const known = new Set(['kind', 'commonDir', 'objectFormat', 'namespace', 'ref', 'tree', 'blobs']);
      if (Object.keys(backing).some(key => !known.has(key))) {
        invalid('The Git backing has unknown fields.');
      }
      const git = backing as Partial<Extract<SnapshotBacking, { kind: 'git' }>>;
      if (typeof git.commonDir !== 'string' || git.commonDir.length < 1 || git.commonDir.length > 8192 || !path.isAbsolute(git.commonDir)) {
        invalid('The Git backing commonDir must be a native absolute path.');
      }
      if (git.objectFormat !== 'sha1' && git.objectFormat !== 'sha256') {
        invalid('The Git backing objectFormat must be sha1 or sha256.');
      }
      if (typeof git.namespace !== 'string' || !HEX64.test(git.namespace)) {
        invalid('The Git backing namespace must be 64 lowercase hex characters.');
      }
      if (git.namespace !== this.namespace) {
        conflict(`The Git backing namespace does not match this store (${this.namespace}).`);
      }
      if (typeof git.ref !== 'string' || git.ref.length < 1 || git.ref.length > 1024) {
        invalid('The Git backing ref must be a 1..1024 character string.');
      }
      if (git.ref !== `refs/codex-subagent/${git.namespace}/${snapshotId}`) {
        invalid('The Git backing ref must be refs/codex-subagent/<namespace>/<snapshotId>.');
      }
      const oid = git.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
      if (typeof git.tree !== 'string' || !oid.test(git.tree)) {
        invalid('The Git backing tree must be a native OID of the object format.');
      }
      if (!isPlain(git.blobs)) {
        invalid('The Git backing blobs must be a record.');
      }
      const blobs: Record<string, string> = {};
      for (const [hash, oidValue] of Object.entries(git.blobs)) {
        if (!HEX64.test(hash) || typeof oidValue !== 'string' || !oid.test(oidValue)) {
          invalid('The Git backing blobs must map 64-hex hashes to native OIDs.');
        }
        blobs[hash] = oidValue;
      }
      return { kind: 'git', commonDir: git.commonDir, objectFormat: git.objectFormat, namespace: git.namespace, ref: git.ref, tree: git.tree, blobs };
    }
    invalid('The capture backing kind must be cas or git.');
  }
}

function pinNameTaken(data: ViewIndexData, name: string): boolean {
  return Object.values(data.pins).some(pin => pin.name === name);
}

function sameBacking(a: SnapshotBacking, b: SnapshotBacking): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'cas' || b.kind === 'cas') {
    return a.kind === 'cas' && b.kind === 'cas';
  }
  return a.commonDir === b.commonDir && a.objectFormat === b.objectFormat && a.namespace === b.namespace
    && a.ref === b.ref && a.tree === b.tree && JSON.stringify(Object.entries(a.blobs).sort()) === JSON.stringify(Object.entries(b.blobs).sort());
}

/**
 * Path-form check that the store sits outside the root, native and
 * case-aware. Missing components are fine: new domains need no filesystem
 * existence; once a real anchor exists, realpath closes junction aliases.
 */
function nativeStoreOutsideRoot(storeDir: string, rootDir: string): boolean {
  const within = (root: string, candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return !within(rootDir, storeDir) && !within(canonicalPath(rootDir), canonicalPath(storeDir));
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Canonicalize existing ancestors without requiring a removed workspace root. */
function canonicalPath(input: string): string {
  let at = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(at);
      return path.join(realpathSync(at), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(at);
      if (parent === at) {
        throw error;
      }
      missing.push(path.basename(at));
      at = parent;
    }
  }
}
