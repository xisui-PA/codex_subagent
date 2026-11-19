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
  /** Durable stopped-worker binding intent, published before its Session marker. */
  binding?: {
    overlayId: string;
    workerId: string;
    workerCreatedAt: string;
    receiptKey: string;
    fingerprint: string;
  };
}
