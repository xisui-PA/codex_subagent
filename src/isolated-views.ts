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
import type { SnapshotBacking, CapturedProject, PendingCapture, StoredSnapshot, OverlayRecord, OverlayRevision, SealedSubmission, ViewPin, ViewReceipt, IsolatedViewBinding } from './isolated-view-types';
import { IsolatedIndex, validateIndex, parseStoredSnapshot, parseOverlayRecord, parseSealedSubmission, parseViewPin } from './isolated-index';
import type { ViewIndexData } from './isolated-index';
import type { IsolatedViewPort, IsolatedViewState, IsolatedViewIdentity } from './isolated-view-port';
import { loadRevisionTree, revisionState, MAX_OVERLAY_REVISIONS, parseOverlayRevision } from './overlay-revisions';
import { createProjectContentReader, readProjectContent, ensureProjectRetention, releaseProjectRetention } from './project-snapshot';
import { sweepViewContent } from './isolated-cas-cleanup';
import { Mutex } from './storage';
import { WorkerError } from './types';

const sha256 = (value: string | string[]): string =>
  createHash('sha256').update(Array.isArray(value) ? JSON.stringify(value) : value).digest('hex');

const HEX64 = /^[a-f0-9]{64}$/;
const TEAM32 = /^[a-f0-9]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isIso = (value: string): boolean => ISO_RE.test(value) && Number.isFinite(Date.parse(value));
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && [null, Object.prototype].includes(Object.getPrototypeOf(value));

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_FILES = 10_000;
const MAX_MANIFEST_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_TOTAL_BYTES = 512 * 1024 * 1024;

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
  /** Live host guard (closing/feature flag/revocation); throws to abort. */
  guard?: () => void;
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
  private readonly mutex = new Mutex();
  private opened = false;
  private failedOpen = false;
  private closing = false;

  constructor(directory: string, root: string, options: IsolatedViewsOptions = {}) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.length > 8192) {
      throw new WorkerError('invalid_path', 'The views directory must be a nonempty path string.');
    }
    if (typeof root !== 'string' || root.length === 0 || root.length > 8192 || !path.isAbsolute(root)) {
      throw new WorkerError('invalid_path', 'The views root must be a native absolute path.');
    }
    if (options.expectExisting !== undefined && typeof options.expectExisting !== 'boolean') {
      invalid('The expectExisting option must be a boolean.');
    }
    this.externalGuard = options.guard ?? (() => undefined);
    this.ensureRetention = options.ensureRetention ?? ensureProjectRetention;
    this.readContent = options.readContent;
    this.releaseRetention = options.releaseRetention ?? releaseProjectRetention;
    this.expectExisting = options.expectExisting === true;
    const resolvedDir = path.resolve(directory);
    const resolvedRoot = path.resolve(root);
    // The content store must sit OUTSIDE the canonical workspace root before
    // any write: nested stores let a capture select its own journal bytes.
    this.assertStoreOutsideRoot(resolvedDir, resolvedRoot);
    this.namespace = sha256(resolvedDir);
    this.content = new ContentStore(path.join(resolvedDir, 'content'), { guard: this.checkAlive });
    this.index = new IsolatedIndex(resolvedDir, resolvedRoot, { guard: this.checkAlive });
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
    return this.mutex.run(async () => {
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
    });
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

  async bind(
    input: BindInput,
    persistMarker: (binding: IsolatedViewBinding) => Promise<void>,
    authorize?: () => void
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
    return this.mutex.run(async () => {
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
    });
  }

  async seal(binding: IsolatedViewBinding, identity: IsolatedViewIdentity, input: { requestId: string; expectedRevision: number }, authorize?: () => void): Promise<SealedSubmission> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      requireString(input.requestId, 'requestId', 1, 200);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        invalid('expectedRevision must be a nonnegative safe integer.');
      }
      this.validateIdentity(binding, identity);
      const data = this.assertReady();
      const key = sha256(['seal', this.namespace, binding.overlayId, identity.ownerId, input.requestId]);
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
        uri: this.submissionUri(id, record.revision + 1), createdAt: new Date().toISOString(), released: false };
      const committed = await this.index.update(draft => {
        if (draft.submissions[id] || draft.receipts[key]) {
          conflict('This submission has already been published.');
        }
        draft.submissions[id] = submission;
        draft.receipts[key] = { fingerprint, result: submission };
      }, guard);
      return committed.submissions[id];
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
  async release(input: RetentionScope & { kind: 'snapshot' | 'overlay' | 'submission' | 'pin' | 'pending'; id: string }, authorize?: () => void, resolveWorker?: (id: string) => Promise<WorkerViewPresence>): Promise<{ released: true; kind: string; id: string }> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      this.checkScope(input.ownerId, input.teamId);
      requireHex64(input.id, 'id');
      const data = this.assertReady();
      const { key, fingerprint, receipt } = this.retentionRequest(data, 'release', input, [input.kind, input.id]);
      const result = { released: true as const, kind: input.kind, id: input.id };
      if (receipt) {
        if (!isPlain(receipt.result) || Object.keys(receipt.result).length !== 3 || receipt.result.released !== true
          || receipt.result.kind !== input.kind || receipt.result.id !== input.id) {
          throw new WorkerError('isolation_corrupt', 'The release acknowledgment is invalid.');
        }
        return result;
      }
      const resource = input.kind === 'snapshot' ? data.snapshots[input.id] : input.kind === 'overlay' ? data.overlays[input.id]
        : input.kind === 'submission' ? data.submissions[input.id] : input.kind === 'pin' ? data.pins[input.id]
          : input.kind === 'pending' ? data.pendingCaptures[input.id]?.snapshot : undefined;
      if (!resource || resource.ownerId !== input.ownerId || resource.teamId !== input.teamId) {
        throw new WorkerError('not_found', 'This resource does not exist in the requested scope.');
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

  async cleanup(input: RetentionScope, resolveWorker?: (id: string) => Promise<WorkerViewPresence>, authorize?: () => void): Promise<ViewCleanupResult> {
    return this.mutex.run(async () => {
      const guard = (): void => this.authorize(authorize);
      guard();
      this.checkScope(input.ownerId, input.teamId);
      let data = this.assertReady();
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
      const pinnedSubmissions = new Set(Object.values(data.pins).filter(pin => pin.resource.kind === 'submission').map(pin => pin.resource.id));
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

  private retentionRequest(data: ViewIndexData, operation: string, scope: RetentionScope, args: string[]): { key: string; fingerprint: string; receipt?: ViewReceipt } {
    requireString(scope.requestId, 'requestId', 1, 200);
    const key = sha256([operation, this.namespace, scope.ownerId, scope.teamId, scope.requestId]);
    const fingerprint = sha256([operation, scope.ownerId, scope.teamId, ...args]);
    const receipt = data.receipts[key];
    if (receipt && receipt.fingerprint !== fingerprint) {
      conflict('This requestId was already used with different arguments.');
    }
    return { key, fingerprint, receipt };
  }

  // -- inspect ---------------------------------------------------------------

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
    const expected = new Set(['schema', 'root', 'capturedAt', 'fingerprint', 'fileCount', 'totalBytes', 'entries']);
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
