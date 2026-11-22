import type { SnapshotEntry, SnapshotManifest } from './snapshot-content';

/** Immutable content locations; Git hashes identify raw, unfiltered bytes. */
export type SnapshotBacking =
  | { kind: 'cas' }
  | {
    kind: 'git';
    commonDir: string;
    objectFormat: 'sha1' | 'sha256';
    namespace: string;
    ref: string;
    tree: string;
    /** Raw SHA-256 content hash -> native Git blob OID. Other hashes use CAS. */
    blobs: Readonly<Record<string, string>>;
  };

/** Persist this intent before creating its Git ref; cleanup compares tree OIDs. */
export interface SnapshotRefIntent {
  snapshotId: string;
  commonDir: string;
  objectFormat: 'sha1' | 'sha256';
  namespace: string;
  ref: string;
  tree: string;
}

export interface CapturedProject {
  manifest: SnapshotManifest;
  backing: SnapshotBacking;
}

export interface StoredSnapshot {
  id: string;
  teamId: string;
  ownerId: string;
  /** SHA-256 of the immutable manifest JSON in the shared CAS. */
  manifestHash: string;
  backing: SnapshotBacking;
  createdAt: string;
  /**
   * Additive provenance of a PRIVATE derived integration seed: the original
   * base it was composed over, the exact ordered source refs and the merge
   * conflict groups. Ordinary captures never carry it, so capture semantics
   * and legacy records stay unchanged.
   */
  provenance?: IntegrationSnapshotProvenance;
}

/** Complete captured candidate, durable before its Git ref is published. */
export interface PendingCapture {
  snapshot: StoredSnapshot;
  receiptKey: string;
  fingerprint: string;
}

/** An acknowledgment is replayed independently of later resource release. */
export interface ViewReceipt {
  fingerprint: string;
  result: unknown;
}

/** A permanent session marker: unavailable bindings must never use live tools. */
export interface IsolatedViewBinding {
  teamId: string;
  snapshotId: string;
  overlayId: string;
}

export interface OverlayRecord extends IsolatedViewBinding {
  workerId: string;
  /** Stable session creation identity; worker IDs may be reused after deletion. */
  workerCreatedAt: string;
  ownerId: string;
  /** Null means the unchanged snapshot, revision zero. */
  head: string | null;
  revision: number;
  released: boolean;
}

/** Immutable delta JSON, addressed by its SHA-256 in the shared CAS. */
export interface OverlayRevision {
  schema: 1;
  overlayId: string;
  parent: string | null;
  revision: number;
  changes: Readonly<Record<string, SnapshotEntry | null>>;
}

/** An exact revision, independent of all subsequent edits to the overlay. */
export interface SealedSubmission extends IsolatedViewBinding {
  id: string;
  version: number;
  uri: string;
  workerId: string;
  workerCreatedAt: string;
  ownerId: string;
  head: string | null;
  revision: number;
  released: boolean;
  createdAt: string;
  /**
   * Set ONLY when the governed runner auto-sealed this exact input for one
   * attempt (withSealedInput), never for an explicit user seal. It is additive:
   * references are still what retain content, but an unreferenced auto-sealed
   * input is reclaimable metadata instead of a permanent submission.
   */
  runnerInput?: true;
}

/** Named consumers retain exact snapshots or sealed submissions. */
export interface ViewPin {
  id: string;
  ownerId: string;
  teamId: string;
  name: string;
  resource: { kind: 'snapshot' | 'submission'; id: string };
  /**
   * Additive private integration identity: the durable attempt this pin serves
   * and its role. A pin carrying it is reserved for that attempt's own durable
   * service decisions and can never be created or released publicly.
   */
  integration?: { attemptId: string; role: 'source' | 'seed' };
  /** Durable stopped-worker binding intent, published before its Session marker. */
  binding?: {
    overlayId: string;
    workerId: string;
    workerCreatedAt: string;
    receiptKey: string;
    fingerprint: string;
  };
}

export interface IntegrationArtifactRef {
  id: string;
  version: number;
  uri: string;
}

export interface IntegrationScope {
  ownerId: string;
  teamId: string;
  attemptId: string;
}

export interface IntegrationComposition {
  snapshot: StoredSnapshot;
  baseSnapshotId: string;
  conflicts: { paths: string[]; inputIds: string[]; reason: string }[];
}

/**
 * Durable provenance of one derived integration seed. It is the seed's own
 * composition receipt: the attempt, the exact original base and the exact
 * ordered source refs are checked on every replay, so a different argument set
 * for the same attempt is refused without any receipt that epoch GC can move.
 */
export interface IntegrationSnapshotProvenance {
  kind: 'integration-seed';
  attemptId: string;
  baseSnapshotId: string;
  refs: IntegrationArtifactRef[];
  conflicts: { paths: string[]; inputIds: string[]; reason: string }[];
}

/**
 * Internal governed startup identity of ONE bind. The host fills it from the
 * real Session's durable startup record, never from the request: a caller field
 * could be forged, a session startup cannot. It is the only thing that may
 * authorize binding a snapshot whose OWN conflict groups are unresolved.
 */
export interface StartupBindIdentity {
  teamId: string;
  snapshotId: string;
  lane: 'work' | 'validation' | 'integration';
}

/**
 * One CONFLICTED hop of a composition lineage: a derived seed whose own merge
 * conflict groups are still unresolved, the exact provenance stored on it, and
 * the exact artifact refs that hop carried - the begin's own selection for the
 * immediate base, or the child seed's stored `provenance.refs` for a deeper
 * parent. The store itself never decides which ref is a resolution; it hands the
 * chain to the ledger's verifier under its own mutex and fails closed without one.
 */
export interface IntegrationConflictHop {
  snapshotId: string;
  provenance: IntegrationSnapshotProvenance;
  refs: IntegrationArtifactRef[];
}

/**
 * Exact durable ancestry of one integration source set, read from the store
 * index only. `sourceSnapshotId` is the ONE immediate base every sealed source
 * was composed over; `ancestors` lists the derived snapshots that base was
 * itself composed from, in leaf-to-root order, each with an exact COPY of its
 * native provenance. The oldest ordinary capture (a stored manifest with no
 * integration provenance) is the root of that lineage and is never listed.
 */
export interface IntegrationSourceAncestry {
  sourceSnapshotId: string;
  ancestors: { snapshotId: string; provenance: IntegrationSnapshotProvenance }[];
}
