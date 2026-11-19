// Durable, single-file index for shared snapshots and private overlays.
// The host caller owns the root SessionStore lock; this class adds no locks of
// its own besides serializing its own update writes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { WorkerError } from './types';
import { assertRequestEpoch, receiptArchiveDeletesSchema, receiptArchivePublicationsSchema, receiptArchiveSchema, receiptEpochsSchema } from './receipt-retention';
import type { ReceiptMetadata, RequestIdPolicy } from './receipt-retention';
import { Mutex, atomicWrite } from './storage';
import type { SealedSubmission, OverlayRecord, PendingCapture, StoredSnapshot, ViewPin, ViewReceipt } from './isolated-view-types';

/** The single atomic document published at <directory>/index.json. */
export interface ViewIndexData extends ReceiptMetadata {
  receiptOwners?: Record<string, string>;
  schema: 1;
  root: string;
  revision: number;
  snapshots: Record<string, StoredSnapshot>;
  overlays: Record<string, OverlayRecord>;
  submissions: Record<string, SealedSubmission>;
  pins: Record<string, ViewPin>;
  receipts: Record<string, ViewReceipt>;
  pendingCaptures: Record<string, PendingCapture>;
}

const id64 = z.string().regex(/^[a-f0-9]{64}$/);
const teamId = z.string().regex(/^[a-f0-9]{32}$/);
const ownerId = z.string().min(1).max(200);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const isoDate = z.string().refine(v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v)));
const head = id64.nullable();

// Git backing: tree and blob OIDs must match the object format (40/64 hex).
const gitBacking = z.strictObject({
  kind: z.literal('git'),
  commonDir: z.string().min(1).max(8192).refine(v => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(v)),
  objectFormat: z.enum(['sha1', 'sha256']),
  namespace: id64,
  ref: z.string().min(1).max(1024),
  tree: z.string().regex(/^[a-f0-9]{40,64}$/),
  blobs: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string().regex(/^[a-f0-9]{40,64}$/))
});
const snapshotSchema = z.strictObject({
  id: id64,
  teamId,
  ownerId,
  manifestHash: id64,
  backing: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('cas') }), gitBacking]),
  createdAt: isoDate
}).refine(s => {
  const b = s.backing;
  if (b.kind !== 'git') {
    return true;
  }
  const oid = b.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  return oid.test(b.tree)
    && b.ref === `refs/codex-subagent/${b.namespace}/${s.id}`
    && Object.keys(b.blobs).length <= 10000
    && Object.values(b.blobs).every(v => oid.test(v));
});

const overlaySchema = z.strictObject({
  teamId, snapshotId: id64, overlayId: id64, workerId: teamId, workerCreatedAt: isoDate,
  ownerId, head, revision, released: z.boolean()
}).refine(value => (value.head === null) === (value.revision === 0));
const submissionSchema = z.strictObject({
  id: id64, teamId, snapshotId: id64, overlayId: id64,
  version: z.number().int().positive(), uri: z.string().min(1).max(2048),
  workerId: teamId, workerCreatedAt: isoDate, ownerId, head, revision, released: z.boolean(), createdAt: isoDate,
  /** Additive governed-runner marker; records without it stay untouched. */
  runnerInput: z.literal(true).optional()
}).refine(value => (value.head === null) === (value.revision === 0));
const pinSchema = z.strictObject({
  id: id64, ownerId, teamId, name: z.string().min(1).max(128),
  resource: z.strictObject({ kind: z.enum(['snapshot', 'submission']), id: id64 }),
  binding: z.strictObject({ overlayId: id64, workerId: teamId, workerCreatedAt: isoDate, receiptKey: id64, fingerprint: id64 }).optional()
});
// result must keep the raw JSON value exactly (including an own __proto__ key);
// the global strict-JSON predicate already proved it is JSON, so only
// requiredness is enforced here. z.json()/z.record() would drop __proto__.
const receiptSchema = z.strictObject({
  fingerprint: id64,
  result: z.custom<JsonValue>(value => value !== undefined, 'Receipt result is required.')
});
const pendingSchema = z.strictObject({ snapshot: snapshotSchema, receiptKey: id64, fingerprint: id64 });

const dataSchema = z.strictObject({
  schema: z.literal(1),
  root: z.string().min(1),
  revision,
  snapshots: z.record(id64, snapshotSchema),
  overlays: z.record(id64, overlaySchema),
  submissions: z.record(id64, submissionSchema),
  pins: z.record(id64, pinSchema),
  receipts: z.record(id64, receiptSchema),
  legacyRequestKeys: z.array(id64).max(4096).optional(),
  receiptEpochs: receiptEpochsSchema.optional(), receiptArchives: z.array(receiptArchiveSchema).max(64).optional(),
  /** Durable archive-deletion intent; completed by a retry or the next open. */
  receiptArchiveDeletes: receiptArchiveDeletesSchema.optional(),
  /** Durable archive-publication intents (one per owner); each is completed only by that owner's exact rollover retry. */
  receiptArchivePublications: receiptArchivePublicationsSchema.optional(),
  receiptOwners: z.record(id64, ownerId).optional(),
  pendingCaptures: z.record(id64, pendingSchema)
});

export const indexLimits = {
  snapshots: 64,
  overlays: 256,
  submissions: 1024,
  pins: 1024,
  receipts: 4096,
  pendingCaptures: 64,
  bytes: 32 * 1024 * 1024
};

type IndexLimits = typeof indexLimits;

function corrupt(message: string): never {
  throw new WorkerError('isolation_corrupt', message);
}

function capacity(message: string): never {
  throw new WorkerError('isolation_capacity', message);
}

/** Recursive JSON value shape; receipt.result is stored as one of these. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

/** Above this nesting the document is rejected before any stack-heavy work. */
export const MAX_INDEX_JSON_DEPTH = 128;

/**
 * Own-property keys of a container, or null if any own key is a symbol or any
 * own property is a non-enumerable or accessor (get/set) descriptor. Accessor
 * and non-enumerable properties would be silently discarded or executed by
 * JSON.stringify, so they are rejected rather than normalized. This inspects
 * descriptors (Reflect.ownKeys), which Object.keys/Object.values skip.
 */
/**
 * Own string data-property keys of a container, or null if any own key is a
 * symbol or any own property is a non-enumerable or accessor (get/set)
 * descriptor. Accessor and non-enumerable properties would be silently
 * discarded or executed by JSON.stringify, so they are rejected. `ignored`
 * names are skipped (arrays' built-in non-enumerable `length`).
 */
function ownStringDataKeys(obj: object, ignored: string[] = []): string[] | null {
  const keys = Reflect.ownKeys(obj);
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') {
      return null; // symbol key
    }
    if (ignored.includes(key)) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
      return null; // accessor or non-enumerable own property
    }
    result.push(key);
  }
  return result;
}

/**
 * Strict global JSON predicate: only values JSON.stringify would round-trip
 * verbatim. Runs BEFORE Zod so cycles/BigInt/Map/etc. surface as WorkerError.
 * Dense arrays only; plain or null-prototype objects only; every own key
 * (including __proto__, and never symbol/accessor/non-enumerable keys) is a
 * string data property and is checked recursively. Non-cyclic shared
 * references are allowed because ancestors are removed on return.
 */
function isStrictJsonValue(value: unknown, depth: number, ancestors: Set<object>): boolean {
  if (depth > MAX_INDEX_JSON_DEPTH) {
    return false;
  }
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean' || value === null) {
    return true;
  }
  if (kind === 'number') {
    return Number.isFinite(value as number);
  }
  if (kind !== 'object') {
    return false; // undefined, function, symbol, bigint
  }
  const obj = value as object;
  if (ancestors.has(obj)) {
    return false; // cycle
  }
  let keys: string[] | null;
  if (Array.isArray(obj)) {
    const array = obj as unknown[];
    keys = ownStringDataKeys(array, ['length']);
    if (keys === null || keys.length !== array.length) {
      return false; // symbol/accessor key, or a hole/extra property (dense only)
    }
    for (const key of keys) {
      const index = Number(key);
      if (!Number.isInteger(index) || String(index) !== key || index < 0 || index >= array.length) {
        return false; // non-index (extra) property on the array
      }
    }
  } else {
    if (obj instanceof Date || obj instanceof Map || obj instanceof Set || obj instanceof RegExp) {
      return false;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      return false;
    }
    keys = ownStringDataKeys(obj);
    if (keys === null) {
      return false;
    }
  }
  ancestors.add(obj);
  const record = obj as Record<string, unknown>;
  const ok = keys.every(key => isStrictJsonValue(record[key], depth + 1, ancestors));
  ancestors.delete(obj);
  return ok;
}

/** True if the JSON-normalized forms agree; used to detect Zod key loss. */
function jsonNormalizesEqual(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}

/**
 * Strict-JSON check, then lossless schema parse. If the parser would discard
 * any own key (e.g. a record/JSON map dropping __proto__), fail as corrupt
 * instead of silently normalizing. Normalization is comparison-only.
 */
function lossless<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  if (!isStrictJsonValue(raw, 0, new Set<object>())) {
    corrupt('Index value is not strictly JSON (bad type, holes, or cycle).');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    corrupt('Index document failed strict schema validation.');
  }
  if (!jsonNormalizesEqual(raw, parsed.data)) {
    corrupt('Parser would discard index metadata.');
  }
  return parsed.data;
}

function emptyIndex(root: string): ViewIndexData {
  return { schema: 1, root, revision: 0, snapshots: {}, overlays: {}, submissions: {}, pins: {}, receipts: {}, pendingCaptures: {} };
}

/**
 * Pure, side-effect-free validation: strict lossless JSON, strict shape,
 * cross-record graph checks, per-collection caps, and serialized byte cap.
 * Exported for upcoming Core preflight; used by open()/update() as well.
 */
export function validateIndex(raw: unknown, root: string, limits: IndexLimits = indexLimits): ViewIndexData {
  const data = lossless(dataSchema, raw) as unknown as ViewIndexData;
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > limits.bytes) {
    capacity('The serialized index exceeds the byte limit.');
  }
  if (data.root !== root) {
    corrupt('Index document belongs to a different workspace root.');
  }
  const collections: [Record<string, unknown>, number, string][] = [
    [data.snapshots, limits.snapshots, 'snapshots'],
    [data.overlays, limits.overlays, 'overlays'],
    [data.submissions, limits.submissions, 'submissions'],
    [data.pins, limits.pins, 'pins'],
    [data.receipts, limits.receipts, 'receipts'],
    [data.pendingCaptures, limits.pendingCaptures, 'pending captures']
  ];
  for (const [record, limit, label] of collections) {
    if (Object.keys(record).length > limit) {
      capacity(`Index holds too many ${label}; the limit is ${limit}.`);
    }
  }
  for (const [key, snapshot] of Object.entries(data.snapshots)) {
    if (key !== snapshot.id) {
      corrupt(`Snapshot key ${key} does not match its record id.`);
    }
  }
  for (const [key, overlay] of Object.entries(data.overlays)) {
    if (key !== overlay.overlayId) {
      corrupt(`Overlay key ${key} does not match its record id.`);
    }
    if (!overlay.released) {
      const snapshot = data.snapshots[overlay.snapshotId];
      // Released tombstones may reference already-collected data.
      if (!snapshot) {
        corrupt(`Active overlay ${key} references a missing snapshot.`);
      }
      if (snapshot.teamId !== overlay.teamId || snapshot.ownerId !== overlay.ownerId) {
        corrupt(`Active overlay ${key} scope does not match its snapshot.`);
      }
    }
  }
  for (const [key, submission] of Object.entries(data.submissions)) {
    if (key !== submission.id) {
      corrupt(`Submission key ${key} does not match its record id.`);
    }
    const overlay = data.overlays[submission.overlayId];
    // A sealed submission may outlive its overlay record; when present, it must agree.
    if (overlay && (overlay.teamId !== submission.teamId || overlay.ownerId !== submission.ownerId
      || overlay.snapshotId !== submission.snapshotId || overlay.workerId !== submission.workerId
      || overlay.workerCreatedAt !== submission.workerCreatedAt)) {
      corrupt(`Submission ${key} does not match its overlay record.`);
    }
    if (!submission.released) {
      const snapshot = data.snapshots[submission.snapshotId];
      if (!snapshot || snapshot.teamId !== submission.teamId || snapshot.ownerId !== submission.ownerId) {
        corrupt(`Active submission ${key} references a missing or foreign snapshot.`);
      }
    }
  }
  for (const [key, pin] of Object.entries(data.pins)) {
    if (key !== pin.id) {
      corrupt(`Pin key ${key} does not match its record id.`);
    }
    if (pin.binding && (pin.resource.kind !== 'snapshot' || pin.name !== `binding:${pin.binding.overlayId}`)) {
      corrupt(`Pin ${key} has a malformed binding intent.`);
    }
    const target = pin.resource.kind === 'snapshot' ? data.snapshots[pin.resource.id] : data.submissions[pin.resource.id];
    if (!target) {
      corrupt(`Pin ${key} references a missing resource.`);
    }
    if (target.teamId !== pin.teamId || target.ownerId !== pin.ownerId) {
      corrupt(`Pin ${key} scope does not match its resource.`);
    }
    if (pin.resource.kind === 'submission') {
      const submission = data.submissions[pin.resource.id];
      const snapshot = data.snapshots[submission.snapshotId];
      if (!snapshot || snapshot.teamId !== pin.teamId || snapshot.ownerId !== pin.ownerId) {
        corrupt(`Pinned submission ${key} references a missing or foreign snapshot.`);
      }
    }
  }
  for (const [key, pending] of Object.entries(data.pendingCaptures)) {
    if (key !== pending.snapshot.id) {
      corrupt(`Pending capture key ${key} does not match its snapshot id.`);
    }
    if (pending.snapshot.backing.kind !== 'git') {
      corrupt(`Pending capture ${key} requires git backing for recovery.`);
    }
    if (data.snapshots[pending.snapshot.id]) {
      corrupt(`Pending capture ${key} snapshot is already active.`);
    }
  }
  return data;
}

/** Pure strict parse of a single stored snapshot record (typed). */
export function parseStoredSnapshot(value: unknown): StoredSnapshot {
  return lossless(snapshotSchema, value) as unknown as StoredSnapshot;
}

/** Pure strict parse of a single private overlay record (typed). */
export function parseOverlayRecord(value: unknown): OverlayRecord {
  return lossless(overlaySchema, value) as unknown as OverlayRecord;
}

/** Pure strict parse of a single sealed submission record (typed). */
export function parseSealedSubmission(value: unknown): SealedSubmission {
  return lossless(submissionSchema, value) as unknown as SealedSubmission;
}

export function parseViewPin(value: unknown): ViewPin {
  return lossless(pinSchema, value) as unknown as ViewPin;
}

export class IsolatedIndex {
  private receiptOwner?: string;
  /**
   * Receipts an exact authorized replay proved in this handle, and whose
   * operation-specific fingerprint and authorization already passed. It is
   * ephemeral: a claim is published only with the next authorized index update
   * and pruned once its receipt is gone.
   */
  private readonly adopted = new Map<string, string>();
  request(ownerId: string, requestId: string, key: string): void {
    const data = this.assertReady();
    assertRequestEpoch(data, ownerId, requestId, key, data.receipts[key] !== undefined, this.policy);
    this.receiptOwner = ownerId;
  }
  /**
   * Records ownership proof for one ownerless legacy receipt. The caller must
   * have already re-run the operation's own authorization and matched its exact
   * fingerprint, so a key (derived from that owner's own scope) can only ever
   * name that owner's receipt. A receipt that is gone, already attributed or
   * absent records nothing.
   */
  adoptReceiptOwner(key: string, ownerId: string): void {
    const data = this.assertReady();
    if (data.receipts[key] !== undefined && data.receiptOwners?.[key] === undefined) {
      this.adopted.set(key, ownerId);
    }
  }
  /**
   * Proven owner of one receipt key: the durable ownership map, or a live claim
   * an exact authorized replay proved. Never a guess, and never a stale claim
   * whose receipt left the index.
   */
  receiptOwnerOf(key: string): string | undefined {
    const data = this.assertReady();
    const durable = data.receiptOwners?.[key];
    if (durable !== undefined || data.receipts[key] === undefined) {
      return durable;
    }
    return this.adopted.get(key);
  }
  private data?: ViewIndexData;
  private opened = false;
  private closing = false;
  private readonly guard: () => void = () => undefined;
  private readonly limits: IndexLimits;
  private readonly policy?: RequestIdPolicy;
  private readonly mutex = new Mutex();
  readonly file: string;

  constructor(readonly directory: string, readonly root: string, options: { guard?: () => void; limits?: Partial<IndexLimits>; requestIdPolicy?: RequestIdPolicy } = {}) {
    if (typeof root !== 'string' || root.length > 8192 || !path.isAbsolute(root)) {
      throw new WorkerError('invalid_path', 'The index root must be an absolute path.');
    }
    this.guard = options.guard ?? (() => undefined);
    this.policy = options.requestIdPolicy;
    this.limits = { ...indexLimits };
    for (const key of Object.keys(indexLimits) as (keyof IndexLimits)[]) {
      const value = options.limits?.[key];
      if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > indexLimits[key])) {
        throw new WorkerError('invalid_limits', `Index limit ${key} must be a positive integer no greater than ${indexLimits[key]}.`);
      }
      if (value !== undefined) {
        this.limits[key] = value;
      }
    }
    this.file = path.join(directory, 'index.json');
  }

  private assertReady(): ViewIndexData {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'The session is stopping and the index is draining.');
    }
    if (!this.opened) {
      throw new WorkerError('unavailable', 'The index is not open; call open() first.');
    }
    this.guard();
    return this.data as ViewIndexData;
  }

  /** Validates the existing index strictly; a missing file starts empty in memory only. */
  async open(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.closing) {
        throw new WorkerError('host_stopping', 'The session is stopping and the index is draining.');
      }
      if (this.opened) {
        return;
      }
      let raw: string | undefined;
      try {
        const stat = await fs.lstat(this.file);
        if (!stat.isFile()) {
          corrupt('The index must be a regular file.');
        }
        if (stat.size > this.limits.bytes) {
          capacity('The existing index exceeds the byte limit.');
        }
        raw = await fs.readFile(this.file, 'utf8');
      } catch (error) {
        if (error instanceof WorkerError) {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          corrupt(`Cannot read index ${this.file}.`);
        }
      }
      if (this.closing) {
        throw new WorkerError('host_stopping', 'The index closed while opening.');
      }
      this.guard();
      if (raw === undefined) {
        this.data = emptyIndex(this.root);
      } else {
        if (Buffer.byteLength(raw, 'utf8') > this.limits.bytes) {
          capacity('The existing index exceeds the byte limit.');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          corrupt('Index file is not valid JSON.');
        }
        this.data = validateIndex(parsed, this.root, this.limits);
      }
      this.opened = true;
    });
  }

  read(): ViewIndexData {
    return structuredClone(this.assertReady());
  }

  /** Synchronous mutator over a draft; publishes an fsynced atomic write, then adopts it. */
  async update(mutator: (draft: ViewIndexData) => void, authorize?: () => void): Promise<ViewIndexData> {
    return this.mutex.run(async () => {
      const current = this.assertReady();
      authorize?.();
      const draft = structuredClone(current);
      const result = mutator(draft) as unknown;
      for (const key of Object.keys(draft.receipts)) {
        if (!current.receipts[key] && this.receiptOwner) {
          (draft.receiptOwners ??= {})[key] = this.receiptOwner;
        }
      }
      // Ownership proven by an exact authorized replay becomes durable here, so
      // a reload keeps what this handle already proved and a scoped rollover can
      // reclaim that receipt without guessing. A claim whose receipt is gone is
      // dropped instead of outliving the identity it described.
      for (const [key, owner] of this.adopted) {
        if (draft.receipts[key] === undefined) {
          this.adopted.delete(key);
        } else if (draft.receiptOwners?.[key] === undefined) {
          (draft.receiptOwners ??= {})[key] = owner;
        }
      }
      for (const key of Object.keys(draft.receiptOwners ?? {})) {
        if (!draft.receipts[key]) {
          delete draft.receiptOwners![key];
        }
      }
      // A thenable (including a rejected promise) is an async mutator: it is
      // declined without publication and must not become an unhandled rejection.
      if (result instanceof Promise || (result !== null && ['object', 'function'].includes(typeof result) && typeof (result as { then?: unknown }).then === 'function')) {
        void Promise.resolve(result).catch(() => undefined);
        throw new WorkerError('invalid_update', 'Index mutators must be synchronous.');
      }
      draft.revision = current.revision + 1;
      validateIndex(draft, this.root, this.limits);
      const text = JSON.stringify(draft);
      if (Buffer.byteLength(text, 'utf8') > this.limits.bytes) {
        capacity('The serialized index exceeds the byte limit.');
      }
      // Re-check immediately before the rename so revocation never publishes.
      await atomicWrite(this.file, text, 0o600, () => {
        this.assertReady(); authorize?.();
      });
      // No guard between rename and adoption; memory must match the committed bytes.
      this.data = validateIndex(JSON.parse(text), this.root, this.limits);
      return structuredClone(this.data);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    // Drain queued updates before reports the index is closed; no effects after.
    await this.mutex.run(async () => {
      this.opened = false;
    });
  }
}
