import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Mutex, atomicWrite } from './storage';
import { WorkerError } from './types';

// ---------------------------------------------------------------------------
// Bounded runner pool: durable slot leases for future physical runners.
//
// This module is ONLY the lease lifecycle. It never starts, signals, kills or
// materializes a process, never executes a command and never imports the
// process helper. A process identity is opaque, strictly-JSON data that a
// caller records before it effects anything.
//
// Location: the pool directory lives OUTSIDE the canonical project root (the
// host passes it, normally under the SessionStore directory); the existing
// host store lock stays the sole authority for "one host owns this workspace".
// The pool adds no second global lock. Its own mutex only serializes short
// journal critical sections and is never held while a caller waits for a grant
// or for close, and a safe completion wakes queued requests.
//
// Durability: one journal (pool.json) carries schema, root, revision, the
// sequence counter and every lease record (id, slot, owner, state, phase /
// process state, exact directory/source/temp paths, process identity, preserve
// flag, diagnostic). A reservation is persisted BEFORE its directories may
// exist, so a reopen can always tell "never started" from "may have run".
//
// Slots: capacity is a fixed, bounded 1..8 (default 2). At most one live lease
// owns a slot, and a quarantined lease keeps consuming its slot: a contaminated
// directory is never cleaned or reused and nothing is silently evicted.
// Lowering the capacity on reopen is supported: only released tombstones (and
// the empty slot directories they leave behind) may sit above the new capacity,
// while a live or quarantined record above it still fails closed.
// Requests beyond capacity wait in a FIFO queue bounded by maxQueue (0..256,
// default 32); overflow is an explicit pool_queue_full error.
//
// Release: a safe release (drained:true without preserve) verifies that the
// pool, its slots directory, the slot directory and the lease directory are all
// plain directories, that no entry is a symlink/junction, a special file or a
// hard link, and only then removes the whole lease directory (source, temp and
// every output inside them). The next lease always gets fresh directories.
// drained:false, preserve:true, an unverifiable removal or a persistence
// failure all leave the lease QUARANTINED: directories retained, slot still
// consumed, record durable, so nothing is reused silently.
//
// Reopen: a LIVE lease that provably never started (state still 'reserved' or
// 'leased', phase 'reserved' or 'prepared', no recorded process identity) is
// cleaned without any proof. Anything execution-started or uncertain is
// quarantined unless an injected conservative proof asserts a drain; an
// ambiguous or explicitly preserved quarantine is never auto-deleted. No command
// is replayed and no PID is ever signalled or killed by this module.
//
// Cleanup reconciles ONLY the caller's scope (ownerId + teamId), skips leases
// live in this process, and discards quarantined/execution-started directories
// only with an explicit proof callback; the default proves nothing. Unknown
// directories and unknown journals are preserved and reported, and a
// persistence failure never frees a slot that may still be active or uncertain.
// ---------------------------------------------------------------------------

/** Default fixed slot count and queue bound. */
export const RUNNER_POOL_DEFAULTS = { capacity: 2, maxQueue: 32 } as const;
/** Hard upper bound on leased slots. */
export const RUNNER_POOL_MAX_CAPACITY = 8;
/** Hard upper bound on queued acquires. */
export const RUNNER_POOL_MAX_QUEUE = 256;
/** Hard upper bound on durable lease records (live, quarantined, tombstones). */
export const RUNNER_POOL_MAX_LEASES = 1024;
/** Default bounded settle wait used by close(), in milliseconds. */
export const RUNNER_POOL_CLOSE_TIMEOUT_MS = 10_000;
/** Maximum accepted close settle wait, in milliseconds. */
export const RUNNER_POOL_MAX_CLOSE_TIMEOUT_MS = 60_000;

const JOURNAL_FILE = 'pool.json';
const SLOTS_DIRECTORY = 'slots';
const SOURCE_DIRECTORY = 'source';
const TEMP_DIRECTORY = 'temp';
const LEASE_ID_RE = /^[0-9a-f]{32}$/;
const TEAM_ID_RE = /^[0-9a-f]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_BYTES = 4096;
const MAX_PROCESS_DEPTH = 16;
const MAX_DIAGNOSTIC_LENGTH = 500;
const MAX_REMOVE_ENTRIES = 1_000_000;
const MAX_DIAGNOSTICS = 50;
/** Bounded retries for a withdrawal (aggregate cancel) that failed. */
const MAX_WITHDRAWAL_ATTEMPTS = 5;
/** Delay before retrying every outstanding withdrawal, in milliseconds. */
const WITHDRAWAL_RETRY_MS = 100;

/** A strictly-JSON value; process identity data is opaque but must round-trip. */
export type PoolJsonValue = null | string | number | boolean | PoolJsonValue[] | { [key: string]: PoolJsonValue };

/**
 * Opaque process identity recorded by the caller (pid, start token, container
 * id, ...). The pool validates it as strict JSON and never interprets it.
 */
export type RunnerProcessIdentity = { readonly [key: string]: PoolJsonValue };

/** Exact owner identity of a lease; all four fields are compared literally. */
export interface RunnerLeaseOwner {
  readonly ownerId: string;
  readonly teamId: string;
  readonly workerId: string;
  readonly workerCreatedAt: string;
}

/**
 * Durable execution state of one lease. A caller MUST checkpoint 'executing'
 * (with the process identity) BEFORE it effects a spawn, so a reopened pool can
 * tell "never started" from "may have run".
 */
export const RUNNER_LEASE_PHASES = ['reserved', 'prepared', 'executing', 'draining'] as const;
export type RunnerLeasePhase = (typeof RUNNER_LEASE_PHASES)[number];

/** Durable lease states. Only 'released' frees its slot. */
export const RUNNER_LEASE_STATES = ['reserved', 'leased', 'quarantined', 'released'] as const;
export type RunnerLeaseState = (typeof RUNNER_LEASE_STATES)[number];

/** One durable lease record; exactly what the journal stores. */
export interface RunnerLeaseRecord {
  readonly leaseId: string;
  readonly slot: number;
  /** Monotonic allocation order. */
  readonly sequence: number;
  readonly state: RunnerLeaseState;
  readonly phase: RunnerLeasePhase;
  readonly owner: RunnerLeaseOwner;
  /** Lease root; contains sourceDir and tempDir and every output under them. */
  readonly directory: string;
  readonly sourceDir: string;
  readonly tempDir: string;
  readonly process: RunnerProcessIdentity | null;
  /** Retain the directory even when processes are proven drained. */
  readonly preserve: boolean;
  readonly diagnostic?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Checkpoint request; persisted durably BEFORE the caller effects anything. */
export interface RunnerLeaseCheckpoint {
  readonly phase: RunnerLeasePhase;
  readonly process?: RunnerProcessIdentity;
}

/** Release request. `drained` states whether execution finished. */
export interface RunnerLeaseRelease {
  readonly drained: boolean;
  /** Retain the directory for inspection even when drained (quarantine). */
  readonly preserve?: boolean;
  /** Bounded operator-facing reason, persisted with the record. */
  readonly diagnostic?: string;
}

/** Outcome of one release; idempotent for the life of the lease object. */
export interface RunnerLeaseReleaseResult {
  readonly leaseId: string;
  readonly slot: number;
  readonly state: 'released' | 'quarantined';
  /** True only when the whole lease directory was verifiably deleted. */
  readonly deleted: boolean;
  readonly diagnostic?: string;
}

/** A granted, exclusive slot lease. */
export interface RunnerLease {
  readonly id: string;
  readonly slot: number;
  /** Lease root: contains sourceDir and tempDir. */
  readonly directory: string;
  /** Fresh, empty, plain source directory for this lease only. */
  readonly sourceDir: string;
  /** Fresh, empty, plain temp directory for this lease only. */
  readonly tempDir: string;
  readonly owner: RunnerLeaseOwner;
  /** Aborted when the pool closes or the caller's acquire signal aborts. */
  readonly signal: AbortSignal;
  readonly phase: RunnerLeasePhase;
  /** Durable checkpoint; must be persisted before the described effect. */
  checkpoint(input: RunnerLeaseCheckpoint): Promise<void>;
  /** Durable release: safe deletion, or quarantine. */
  release(input: RunnerLeaseRelease): Promise<RunnerLeaseReleaseResult>;
  /** Frozen copy of the durable record. */
  status(): RunnerLeaseRecord;
}

/** One slot as observed by status(). */
export interface RunnerPoolSlotStatus {
  readonly slot: number;
  readonly state: 'free' | 'active' | 'quarantined';
  readonly leaseId?: string;
  readonly owner?: RunnerLeaseOwner;
}

/** One queued acquire; position is 1-based FIFO. */
export interface RunnerPoolQueueEntry {
  readonly position: number;
  readonly owner: RunnerLeaseOwner;
}

/** Full observable pool state. */
export interface RunnerPoolStatus {
  readonly capacity: number;
  readonly maxQueue: number;
  readonly open: boolean;
  readonly closing: boolean;
  readonly closed: boolean;
  readonly slots: readonly RunnerPoolSlotStatus[];
  readonly queue: readonly RunnerPoolQueueEntry[];
  readonly leases: readonly RunnerLeaseRecord[];
  readonly unknownEntries: readonly string[];
  readonly diagnostics: readonly string[];
}

/** Owner-scoped observable state for one worker. */
export type RunnerOwnerState =
  | { readonly state: 'idle' }
  | { readonly state: 'queued'; readonly position: number }
  | { readonly state: 'leased'; readonly lease: RunnerLeaseRecord }
  | { readonly state: 'quarantined'; readonly lease: RunnerLeaseRecord };

/** Scope that cleanup may reconcile; other owners are never touched. */
export interface RunnerPoolScope {
  readonly ownerId: string;
  readonly teamId: string;
}

/**
 * Conservative drain proof. Returning true asserts that the process recorded on
 * this lease can no longer run and its directories may be deleted. The default
 * pool proves nothing.
 */
export type RunnerProcessProof = (record: RunnerLeaseRecord) => boolean | Promise<boolean>;

/** Result of one cleanup pass. */
export interface RunnerPoolCleanupResult {
  readonly discarded: readonly string[];
  readonly retained: readonly { readonly leaseId: string; readonly reason: string }[];
  readonly unknownEntries: readonly string[];
}

import type { RunnerAdmission } from './resource-governor';

export interface RunnerPoolOptions {
  admission?: RunnerAdmission;
  /** Fixed slot count, 1..8 (default 2). */
  capacity?: number;
  /** Bounded FIFO queue length, 0..256 (default 32). */
  maxQueue?: number;
  /** Canonical project root; the pool directory must sit outside it. */
  projectRoot?: string;
  /** Bounded settle wait for close (default 10s, 1..60000). */
  closeTimeoutMs?: number;
  /** Journal writer seam; defaults to the fsynced atomic write. */
  writeJournal?: (file: string, text: string) => Promise<void>;
  /** Conservative recovery proof; defaults to "cannot prove any drain". */
  proveDrained?: RunnerProcessProof;
}

interface PoolJournal {
  schema: 1;
  root: string;
  revision: number;
  nextSequence: number;
  leases: Record<string, RunnerLeaseRecord>;
}

interface PoolWaiter {
  readonly admissionId: string;
  readonly owner: RunnerLeaseOwner;
  readonly caller?: AbortSignal;
  readonly promise: Promise<RunnerLease>;
  readonly resolve: (lease: RunnerLease) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
  aborted: boolean;
  /** True when this request holds a promised (in-flight) slot claim. */
  claimed: boolean;
}

interface LiveLease {
  readonly id: string;
  readonly slot: number;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly markSettled: () => void;
  phase: RunnerLeasePhase;
  result?: RunnerLeaseReleaseResult;
}

interface LeaseGrant {
  readonly lease: PoolLease;
  readonly live: LiveLease;
}

/** A reopen/cleanup journal plan: records to drop and records to quarantine. */
interface ReconcilePlan {
  readonly drops: Set<string>;
  readonly quarantines: Map<string, RunnerLeaseRecord>;
}

type PlainDirectory = 'plain' | 'missing' | 'unsafe';

const nowIso = (): string => new Date().toISOString();
const phaseIndex = (phase: RunnerLeasePhase): number => RUNNER_LEASE_PHASES.indexOf(phase);

// Function declarations (not const arrows) so TypeScript narrows after them:
// a declared `never` return type terminates control flow at the guard.
function corrupt(message: string): never {
  throw new WorkerError('pool_corrupt', message);
}

function invalidPath(message: string): never {
  throw new WorkerError('invalid_path', message);
}

function invalidOwner(message: string): never {
  throw new WorkerError('invalid_pool_owner', message);
}

function invalidScope(message: string): never {
  throw new WorkerError('invalid_pool_scope', message);
}

function invalidProcess(message: string): never {
  throw new WorkerError('invalid_pool_process', message);
}

const frozenPlan = (): ReconcilePlan => ({ drops: new Set<string>(), quarantines: new Map<string, RunnerLeaseRecord>() });
const planIsEmpty = (plan: ReconcilePlan): boolean => plan.drops.size === 0 && plan.quarantines.size === 0;

function requireOwner(owner: RunnerLeaseOwner): RunnerLeaseOwner {
  if (typeof owner !== 'object' || owner === null || Array.isArray(owner)) {
    invalidOwner('A lease owner must be an object.');
  }
  const record = owner as unknown as Record<string, unknown>;
  const expected = ['ownerId', 'teamId', 'workerId', 'workerCreatedAt'];
  const keys = Object.keys(record);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) {
    invalidOwner('A lease owner must have exactly ownerId, teamId, workerId and workerCreatedAt.');
  }
  if (typeof record.ownerId !== 'string' || record.ownerId.length === 0 || record.ownerId.length > 200) {
    invalidOwner('ownerId must be a 1..200 character string.');
  }
  if (typeof record.teamId !== 'string' || !TEAM_ID_RE.test(record.teamId)) {
    invalidOwner('teamId must be 32 lowercase hex characters.');
  }
  if (typeof record.workerId !== 'string' || !TEAM_ID_RE.test(record.workerId)) {
    invalidOwner('workerId must be 32 lowercase hex characters.');
  }
  if (typeof record.workerCreatedAt !== 'string' || !ISO_RE.test(record.workerCreatedAt) || !Number.isFinite(Date.parse(record.workerCreatedAt))) {
    invalidOwner('workerCreatedAt must be an ISO timestamp.');
  }
  return Object.freeze({
    ownerId: record.ownerId, teamId: record.teamId, workerId: record.workerId, workerCreatedAt: record.workerCreatedAt
  });
}

function requireScope(scope: unknown): RunnerPoolScope {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    invalidScope('A cleanup scope must be an object.');
  }
  const record = scope as unknown as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !('ownerId' in record) || !('teamId' in record)) {
    invalidScope('A cleanup scope must have exactly ownerId and teamId.');
  }
  if (typeof record.ownerId !== 'string' || record.ownerId.length === 0 || record.ownerId.length > 200) {
    invalidScope('ownerId must be a 1..200 character string.');
  }
  if (typeof record.teamId !== 'string' || !TEAM_ID_RE.test(record.teamId)) {
    invalidScope('teamId must be 32 lowercase hex characters.');
  }
  return Object.freeze({ ownerId: record.ownerId, teamId: record.teamId });
}

/**
 * Validate and copy a cleanup scope with this pool's exact accepted shape.
 *
 * Exported so an owner-scoped caller (the execution service) can refuse a
 * malformed scope BEFORE it effects any release side effect, and can filter its
 * own bookkeeping by the same ownerId + teamId pair, instead of keeping a second
 * copy of these rules that could drift. Like cleanup() itself it is pure: it
 * validates, copies and freezes, and it never touches the journal or a lease.
 */
export function validateRunnerPoolScope(scope: unknown): RunnerPoolScope {
  return requireScope(scope);
}

const sameOwner = (a: RunnerLeaseOwner, b: RunnerLeaseOwner): boolean => a.ownerId === b.ownerId && a.teamId === b.teamId
  && a.workerId === b.workerId && a.workerCreatedAt === b.workerCreatedAt;

function requireDiagnostic(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > MAX_DIAGNOSTIC_LENGTH) {
    throw new WorkerError('invalid_pool_diagnostic', `A diagnostic must be a string of at most ${MAX_DIAGNOSTIC_LENGTH} characters.`);
  }
  return value;
}

/** True when `candidate` is strictly inside `root` (never equal, never '..'). */
function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Canonical pool-relative lease paths; the only accepted spelling. */
function leasePaths(root: string, slot: number, leaseId: string): { directory: string; sourceDir: string; tempDir: string } {
  const directory = path.join(root, SLOTS_DIRECTORY, String(slot), leaseId);
  return { directory, sourceDir: path.join(directory, SOURCE_DIRECTORY), tempDir: path.join(directory, TEMP_DIRECTORY) };
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    // ENOTDIR means an ancestor component is not a directory: the path cannot
    // exist, which is the same answer as ENOENT on every platform.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

/**
 * Own string data keys, or undefined when any own key is a symbol or any own
 * property is an accessor/non-enumerable (JSON.stringify would drop or run it).
 */
function plainOwnKeys(target: object, ignored: readonly string[]): string[] | undefined {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(target)) {
    if (typeof key !== 'string') {
      return undefined;
    }
    if (ignored.includes(key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
      return undefined;
    }
    keys.push(key);
  }
  return keys;
}

/** Strict JSON predicate for opaque process identity data. */
function isStrictProcessJson(value: unknown, depth: number, ancestors: Set<object>): value is PoolJsonValue {
  if (depth > MAX_PROCESS_DEPTH) {
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
    return false;
  }
  const target = value as object;
  if (ancestors.has(target)) {
    return false;
  }
  if (Array.isArray(target)) {
    const keys = plainOwnKeys(target, ['length']);
    if (keys === undefined || keys.length !== target.length) {
      return false;
    }
    for (const key of keys) {
      const index = Number(key);
      if (!Number.isInteger(index) || String(index) !== key || index < 0 || index >= target.length) {
        return false;
      }
    }
  } else {
    if (target instanceof Date || target instanceof Map || target instanceof Set || target instanceof RegExp) {
      return false;
    }
    const prototype = Object.getPrototypeOf(target);
    if (prototype !== null && prototype !== Object.prototype) {
      return false;
    }
    if (plainOwnKeys(target, []) === undefined) {
      return false;
    }
  }
  ancestors.add(target);
  const record = target as Record<string, unknown>;
  const ok = Object.keys(record).every(key => isStrictProcessJson(record[key], depth + 1, ancestors));
  ancestors.delete(target);
  return ok;
}

/** Validated, frozen, size-bounded copy of an opaque process identity. */
function requireProcessIdentity(value: unknown): RunnerProcessIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isStrictProcessJson(value, 0, new Set<object>())) {
    invalidProcess('A process identity must be a strict JSON object (no cycles, accessors, holes or non-finite numbers).');
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    invalidProcess('A process identity must be JSON-serializable.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PROCESS_BYTES) {
    invalidProcess(`A process identity must serialize to at most ${MAX_PROCESS_BYTES} bytes.`);
  }
  return Object.freeze(JSON.parse(text) as RunnerProcessIdentity);
}

/** Validated, frozen record copy for callers; never the live journal object. */
function freezeRecord(record: RunnerLeaseRecord): RunnerLeaseRecord {
  return Object.freeze({ ...structuredClone(record), owner: Object.freeze({ ...record.owner }) });
}

const emptyJournal = (root: string): PoolJournal => ({ schema: 1, root, revision: 0, nextSequence: 0, leases: {} });

/**
 * Strict validation of the persisted journal. Every path is re-derived from
 * root + slot + lease id, so a record can never point outside the pool or
 * through a traversal. Slots must be unique among occupying states, inside the
 * physical slot range and inside the configured capacity; anything else fails
 * closed as pool_corrupt. The one narrow exception is a historical 'released'
 * tombstone, which may keep a slot above a SHRUNK capacity (never above the
 * physical range) because it occupies nothing and reconciliation drops it
 * before any slot is handed out again.
 */
function validateJournal(raw: unknown, root: string, capacity: number): PoolJournal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    corrupt('The runner pool journal must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const expected = ['schema', 'root', 'revision', 'nextSequence', 'leases'];
  if (Object.keys(record).length !== expected.length || Object.keys(record).some(key => !expected.includes(key))) {
    corrupt('The runner pool journal has unknown or missing fields.');
  }
  if (record.schema !== 1) {
    corrupt('The runner pool journal schema must be 1.');
  }
  if (typeof record.root !== 'string' || record.root !== root) {
    corrupt('The runner pool journal belongs to a different directory.');
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
    corrupt('The runner pool journal revision must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(record.nextSequence) || (record.nextSequence as number) < 0) {
    corrupt('The runner pool sequence counter must be a non-negative safe integer.');
  }
  const leases = record.leases;
  if (typeof leases !== 'object' || leases === null || Array.isArray(leases)) {
    corrupt('The runner pool lease records must be an object.');
  }
  const entries = Object.entries(leases as Record<string, unknown>);
  if (entries.length > RUNNER_POOL_MAX_LEASES) {
    throw new WorkerError('pool_capacity', `The runner pool journal holds ${entries.length} lease records; the limit is ${RUNNER_POOL_MAX_LEASES}.`);
  }
  const validated = Object.create(null) as Record<string, RunnerLeaseRecord>;
  const occupied = new Map<number, string>();
  let highestSequence = -1;
  for (const [key, value] of entries) {
    if (!LEASE_ID_RE.test(key)) {
      corrupt(`The runner pool lease key ${JSON.stringify(key)} is not a 32-hex lease id.`);
    }
    const lease = validateLeaseRecord(value, key, root, capacity);
    if (lease.sequence > highestSequence) {
      highestSequence = lease.sequence;
    }
    if (lease.state !== 'released') {
      const previous = occupied.get(lease.slot);
      if (previous !== undefined) {
        corrupt(`Slot ${lease.slot} is claimed by both ${previous} and ${key}.`);
      }
      occupied.set(lease.slot, key);
    }
    validated[key] = lease;
  }
  if ((record.nextSequence as number) <= highestSequence) {
    corrupt('The runner pool sequence counter would reuse an existing sequence.');
  }
  return {
    schema: 1, root, revision: record.revision as number, nextSequence: record.nextSequence as number, leases: validated
  };
}

function validateLeaseRecord(value: unknown, key: string, root: string, capacity: number): RunnerLeaseRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    corrupt(`Lease ${key} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const required = ['leaseId', 'slot', 'sequence', 'state', 'phase', 'owner', 'directory', 'sourceDir', 'tempDir',
    'process', 'preserve', 'createdAt', 'updatedAt'];
  const fields = Object.keys(record);
  if (fields.some(field => field !== 'diagnostic' && !required.includes(field)) || required.some(field => !fields.includes(field))) {
    corrupt(`Lease ${key} has unknown or missing fields.`);
  }
  if (record.leaseId !== key) {
    corrupt(`Lease ${key} does not match its record id.`);
  }
  // The PHYSICAL slot range is the hard bound for every record: a slot can
  // never sit outside 0..RUNNER_POOL_MAX_CAPACITY-1, so no record path, slot
  // directory or status entry can ever escape the pool's own layout.
  if (!Number.isSafeInteger(record.slot) || (record.slot as number) < 0 || (record.slot as number) >= RUNNER_POOL_MAX_CAPACITY) {
    corrupt(`Lease ${key} has a slot outside the physical slot range 0..${RUNNER_POOL_MAX_CAPACITY - 1}.`);
  }
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) {
    corrupt(`Lease ${key} has an invalid sequence.`);
  }
  if (typeof record.state !== 'string' || !RUNNER_LEASE_STATES.includes(record.state as RunnerLeaseState)) {
    corrupt(`Lease ${key} has an unknown state.`);
  }
  // A slot inside the physical range must still fit the CONFIGURED capacity for
  // every occupying state: shrinking the capacity below a live or quarantined
  // slot fails closed. Only a historical 'released' tombstone may sit above the
  // new capacity, because a release already freed that slot, nothing occupies
  // it, and reconciliation drops the tombstone (with its empty directory) on
  // this same open; the occupied-slot scan above ignores it for the same reason.
  if (record.state !== 'released' && (record.slot as number) >= capacity) {
    corrupt(`Lease ${key} has a slot outside the configured capacity.`);
  }
  if (typeof record.phase !== 'string' || !RUNNER_LEASE_PHASES.includes(record.phase as RunnerLeasePhase)) {
    corrupt(`Lease ${key} has an unknown phase.`);
  }
  const owner = requireOwner(record.owner as RunnerLeaseOwner);
  const slot = record.slot as number;
  const paths = leasePaths(root, slot, key);
  if (record.directory !== paths.directory || record.sourceDir !== paths.sourceDir || record.tempDir !== paths.tempDir) {
    corrupt(`Lease ${key} does not carry this pool's exact directory paths.`);
  }
  const process = record.process === null ? null : requireProcessIdentity(record.process);
  if (typeof record.preserve !== 'boolean') {
    corrupt(`Lease ${key} must record a preserve flag.`);
  }
  let diagnostic: string | undefined;
  if (record.diagnostic !== undefined) {
    if (typeof record.diagnostic !== 'string' || record.diagnostic.length > MAX_DIAGNOSTIC_LENGTH) {
      corrupt(`Lease ${key} has an invalid diagnostic.`);
    }
    diagnostic = record.diagnostic;
  }
  for (const field of ['createdAt', 'updatedAt']) {
    const stamp = record[field];
    if (typeof stamp !== 'string' || !ISO_RE.test(stamp) || !Number.isFinite(Date.parse(stamp))) {
      corrupt(`Lease ${key} has an invalid ${field}.`);
    }
  }
  if (record.state === 'reserved' && (record.phase !== 'reserved' || process !== null)) {
    corrupt(`Reservation ${key} cannot record execution state.`);
  }
  const validated: RunnerLeaseRecord = {
    leaseId: key,
    slot,
    sequence: record.sequence as number,
    state: record.state as RunnerLeaseState,
    phase: record.phase as RunnerLeasePhase,
    owner,
    directory: paths.directory,
    sourceDir: paths.sourceDir,
    tempDir: paths.tempDir,
    process,
    preserve: record.preserve,
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string
  };
  return diagnostic === undefined ? validated : { ...validated, diagnostic };
}

/** Diagnostic text this module writes when reload quarantines for an unproven drain. */
const RECOVERY_QUARANTINE = 'recovered after restart; the process drain is unproven';

/**
 * True when a record carries no evidence that anything was ever started:
 * 'reserved' and 'prepared' are both pre-execution phases. The pool persists the
 * reservation BEFORE its directories may exist, and the only caller checkpoints
 * 'prepared' before it asks for approval and before the 'executing' checkpoint
 * that precedes a spawn -- a process identity is first recorded with 'executing'.
 */
const preExecution = (record: RunnerLeaseRecord): boolean => record.process === null
  && phaseIndex(record.phase) <= phaseIndex('prepared');

/**
 * A record that provably never started may be cleaned without any proof.
 *
 * Only a LIVE record qualifies: 'reserved' (the grant is still being prepared)
 * or 'leased' in a pre-execution phase. Those two states are this pool's own
 * bookkeeping, so the phase is structural evidence and never a claim.
 *
 * An already-quarantined record does NOT qualify, whatever its text says. A
 * quarantine is ambiguous: it may be the reload verdict, a caller's explicit
 * `drained: false` assertion, an unverifiable directory or a preserve retention,
 * and the diagnostic beside it is free-form text a caller controls. It is
 * therefore preserved and reported, and only an explicit cleanup with a proof
 * may discard it -- an ambiguous legacy record is never auto-deleted.
 *
 * An explicit preserve request always wins too: retained data may still be
 * awaiting inspection (a final persistence failure keeps it that way).
 */
const neverStarted = (record: RunnerLeaseRecord): boolean => !record.preserve
  && (record.state === 'reserved' || record.state === 'leased') && preExecution(record);

/** lstat verdict for one directory component of a removable path. */
async function plainDirectory(target: string): Promise<PlainDirectory> {
  const stat = await lstatOrNull(target);
  if (stat === null) {
    return 'missing';
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return 'unsafe';
  }
  return 'plain';
}

interface TreeVerdict {
  readonly safe: boolean;
  readonly reason?: string;
}

/**
 * Delete one lease tree WITHOUT ever following a link. Nested symlinks and
 * junctions are unlinked as LEAVES (their targets are never opened, traversed
 * or modified), hard-linked files are unlinked (removing one directory entry
 * never changes the other link's content), and plain files and directories are
 * removed bottom-up. Only the pool/slot/lease ANCESTOR directories must be
 * plain (checked by the caller), so an ordinary `npm install`/build output tree
 * (node_modules/.bin links, tens of thousands of entries) stays removable. The
 * entry budget is generous; exceeding it reports unsafe so the lease is
 * quarantined instead of being partially deleted.
 */
async function purgeTree(target: string, budget: { left: number }): Promise<TreeVerdict> {
  const stat = await lstatOrNull(target);
  if (stat === null) {
    return { safe: true };
  }
  if (stat.isSymbolicLink()) {
    try {
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return { safe: true };
  }
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(target)) {
      budget.left -= 1;
      if (budget.left < 0) {
        return { safe: false, reason: 'the lease directory has too many entries' };
      }
      const verdict = await purgeTree(path.join(target, name), budget);
      if (!verdict.safe) {
        return verdict;
      }
    }
    try {
      await fs.rmdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return { safe: false, reason: `the lease directory could not be removed (${code ?? 'error'})` };
      }
    }
    return { safe: true };
  }
  if (!stat.isFile()) {
    return { safe: false, reason: `a special file was found at ${path.basename(target)}` };
  }
  try {
    await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return { safe: true };
}

interface RemovalVerdict {
  readonly safe: boolean;
  readonly reason?: string;
}

/**
 * Verify and delete one lease directory. The pool root, its slots directory, the
 * slot directory and the lease directory must all be plain directories (never
 * symlinks or junctions) and the lease directory must sit strictly inside the
 * pool. NESTED links are then unlinked as leaves without traversal, so ordinary
 * dependency/build output (node_modules/.bin links, hard-linked artifacts) can
 * be discarded safely while outside targets stay untouched.
 */
async function removeLeaseDirectory(root: string, record: RunnerLeaseRecord): Promise<RemovalVerdict> {
  if (await lstatOrNull(record.directory) === null) {
    return { safe: true };
  }
  if (!isStrictlyInside(root, record.directory)) {
    return { safe: false, reason: 'the lease directory is outside the pool' };
  }
  const chain = [root, path.join(root, SLOTS_DIRECTORY), path.join(root, SLOTS_DIRECTORY, String(record.slot))];
  for (const component of chain) {
    if (await plainDirectory(component) !== 'plain') {
      return { safe: false, reason: `${path.basename(component)} is not a plain directory` };
    }
  }
  if (await plainDirectory(record.directory) !== 'plain') {
    return { safe: false, reason: 'the lease directory is not a plain directory' };
  }
  const tree = await purgeTree(record.directory, { left: MAX_REMOVE_ENTRIES });
  if (!tree.safe) {
    return tree;
  }
  if (await lstatOrNull(record.directory) !== null) {
    return { safe: false, reason: 'the lease directory could not be removed completely' };
  }
  return { safe: true };
}

/** Canonicalize existing ancestors without requiring a removed project root. */
async function canonicalPath(input: string): Promise<string> {
  let at = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(at), ...missing.reverse());
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

const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Native, case-aware check that the pool sits strictly outside the root. */
async function outsideProject(poolDirectory: string, projectRoot: string): Promise<boolean> {
  const pool = path.resolve(poolDirectory);
  const root = path.resolve(projectRoot);
  if (within(root, pool)) {
    return false;
  }
  const [canonicalRoot, canonicalPool] = await Promise.all([canonicalPath(root), canonicalPath(pool)]);
  return !within(canonicalRoot, canonicalPool) && !within(canonicalPool, canonicalRoot);
}

/** Combine the pool-level and caller-level abort signals into one lease signal. */
function combineSignals(caller: AbortSignal | undefined, controller: AbortController): () => void {
  if (caller === undefined) {
    return () => undefined;
  }
  if (caller.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  caller.addEventListener('abort', onAbort, { once: true });
  return () => caller.removeEventListener('abort', onAbort);
}

async function withTimeout<T>(work: Promise<T>, milliseconds: number, make: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(make()), milliseconds);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * A thrown value's message, without evaluating anything a caller controls.
 */
const describeFailure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Bounded, order-preserving id list for one batch diagnostic. */
function summarizeIds(ids: readonly string[]): string {
  const shown = ids.slice(0, 8).join(', ');
  return ids.length > 8 ? `${shown} and ${ids.length - 8} more` : shown;
}

/**
 * The error reported to a caller whose untouched reservation could NOT be
 * discarded. It keeps the cleanup failure's own code, so a storage problem is
 * never reported as a plain cancellation, and its message names both the
 * cancellation cause and the retained record: the caller proceeds knowing it
 * holds no lease, while the pool keeps an uncertain record that a later reload
 * or cleanup must reconcile. Nothing is freed on this path.
 */
function retainedReservationError(error: unknown, refusal: WorkerError): WorkerError {
  const detail = `${refusal.message} The untouched reservation could not be discarded`
    + ` (${describeFailure(error)}); its record is retained and its slot stays consumed.`;
  return error instanceof WorkerError
    ? new WorkerError(error.code, detail, error.retryable)
    : new WorkerError('pool_cleanup_failed', detail);
}

class PoolLease implements RunnerLease {
  private detach?: () => void;

  constructor(private readonly pool: RunnerPool, private readonly live: LiveLease,
    private readonly record: RunnerLeaseRecord, caller?: AbortSignal) {
    this.detach = combineSignals(caller, live.controller);
  }

  get id(): string {
    return this.live.id;
  }

  get slot(): number {
    return this.live.slot;
  }

  get directory(): string {
    return this.record.directory;
  }

  get sourceDir(): string {
    return this.record.sourceDir;
  }

  get tempDir(): string {
    return this.record.tempDir;
  }

  get owner(): RunnerLeaseOwner {
    return this.record.owner;
  }

  get signal(): AbortSignal {
    return this.live.controller.signal;
  }

  get phase(): RunnerLeasePhase {
    return this.live.phase;
  }

  checkpoint(input: RunnerLeaseCheckpoint): Promise<void> {
    return this.pool.checkpoint(this.live, input);
  }

  release(input: RunnerLeaseRelease): Promise<RunnerLeaseReleaseResult> {
    return this.pool.release(this.live, input).finally(() => {
      this.detach?.();
      this.detach = undefined;
    });
  }

  status(): RunnerLeaseRecord {
    return this.pool.leaseRecord(this.live.id) ?? freezeRecord(this.record);
  }
}

/**
 * Bounded durable runner-slot pool. Construction validates configuration only;
 * open() validates the durable journal and the on-disk layout. A store that
 * fails to open is permanently failed: a NEW handle must be used, so cached
 * empty state can never be published over unreadable data.
 */
export class RunnerPool {
  readonly directory: string;
  readonly journalFile: string;
  readonly capacity: number;
  readonly maxQueue: number;

  private readonly mutex = new Mutex();
  private readonly admission?: RunnerAdmission;
  private readonly admissionCancellations = new Set<Promise<void>>();
  private pumpTimer?: NodeJS.Timeout;
  private withdrawalTimer?: NodeJS.Timeout;
  /**
   * Admission ids whose withdrawal (aggregate cancel) failed, with the attempts
   * already spent. A retained waiting ticket is what can hold the aggregate
   * runner leadership, so the pool retries the withdrawal a bounded number of
   * times even after its caller is already settled.
   */
  private readonly withdrawals = new Map<string, number>();
  private readonly writeJournal: (file: string, text: string) => Promise<void>;
  private readonly proveDrained?: RunnerProcessProof;
  private readonly closeTimeoutMs: number;
  private readonly projectRoot?: string;
  private waiters: PoolWaiter[] = [];
  /** Slots promised to admitted requests whose reservation is still in flight. */
  private claims = 0;
  private readonly live = new Map<string, LiveLease>();
  private readonly diagnostics: string[] = [];
  private unknownEntries: string[] = [];
  private journal: PoolJournal;
  private opened = false;
  private failed = false;
  private closing = false;
  private closed = false;
  private closingPromise?: Promise<void>;

  constructor(directory: string, options: RunnerPoolOptions = {}) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.length > 8192 || !path.isAbsolute(directory)) {
      invalidPath('The runner pool directory must be a non-empty absolute path.');
    }
    const capacity = options.capacity ?? RUNNER_POOL_DEFAULTS.capacity;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > RUNNER_POOL_MAX_CAPACITY) {
      throw new WorkerError('invalid_pool_config', `capacity must be an integer between 1 and ${RUNNER_POOL_MAX_CAPACITY}, got ${String(capacity)}.`);
    }
    const maxQueue = options.maxQueue ?? RUNNER_POOL_DEFAULTS.maxQueue;
    if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > RUNNER_POOL_MAX_QUEUE) {
      throw new WorkerError('invalid_pool_config', `maxQueue must be an integer between 0 and ${RUNNER_POOL_MAX_QUEUE}, got ${String(maxQueue)}.`);
    }
    const closeTimeoutMs = options.closeTimeoutMs ?? RUNNER_POOL_CLOSE_TIMEOUT_MS;
    if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > RUNNER_POOL_MAX_CLOSE_TIMEOUT_MS) {
      throw new WorkerError('invalid_pool_config', `closeTimeoutMs must be an integer between 1 and ${RUNNER_POOL_MAX_CLOSE_TIMEOUT_MS}, got ${String(closeTimeoutMs)}.`);
    }
    if (options.projectRoot !== undefined && (typeof options.projectRoot !== 'string' || options.projectRoot.length === 0 || !path.isAbsolute(options.projectRoot))) {
      invalidPath('projectRoot must be an absolute path.');
    }
    if (options.writeJournal !== undefined && typeof options.writeJournal !== 'function') {
      throw new WorkerError('invalid_pool_config', 'writeJournal must be a function.');
    }
    if (options.proveDrained !== undefined && typeof options.proveDrained !== 'function') {
      throw new WorkerError('invalid_pool_config', 'proveDrained must be a function.');
    }
    this.admission = options.admission;
    this.directory = path.resolve(directory);
    this.journalFile = path.join(this.directory, JOURNAL_FILE);
    this.capacity = capacity;
    this.maxQueue = maxQueue;
    this.closeTimeoutMs = closeTimeoutMs;
    this.projectRoot = options.projectRoot === undefined ? undefined : path.resolve(options.projectRoot);
    this.writeJournal = options.writeJournal ?? ((file, text) => atomicWrite(file, text, 0o600));
    this.proveDrained = options.proveDrained;
    this.journal = emptyJournal(this.directory);
  }

  /**
   * Validate the durable journal and the on-disk layout, reconcile abandoned
   * leases and publish the reconciled journal. A corrupt journal fails closed;
   * this handle then refuses every later call and a NEW handle must be used.
   */
  async open(): Promise<void> {
    if (this.failed) {
      throw new WorkerError('pool_unavailable', 'This runner pool handle failed to open; construct a new handle.');
    }
    await this.mutex.run(async () => {
      if (this.closed) {
        throw new WorkerError('pool_closed', 'This runner pool is closed.');
      }
      if (this.opened) {
        return;
      }
      try {
        await this.openLocked();
        // Reopen recovery tells the aggregate layer whether this pool still has a
        // usable physical slot, so no waiting ticket reserves capacity for one.
        await this.admission?.reconcile(Object.values(this.journal.leases), true, undefined, this.freeSlot() !== undefined);
        this.opened = true;
      } catch (error) {
        this.failed = true;
        throw error;
      }
    });
  }

  /** Acquire an exclusive slot lease, or wait in the bounded FIFO queue. */
  async acquire(owner: RunnerLeaseOwner, signal?: AbortSignal): Promise<RunnerLease> {
    this.assertReady();
    const validated = requireOwner(owner);
    if (signal !== undefined && signal.aborted) {
      throw new WorkerError('pool_aborted', 'The acquire request was already aborted; no lease was allocated.');
    }
    // The bound applies to requests that must WAIT. A request that can be
    // granted immediately (an unclaimed free slot) is never refused, so
    // maxQueue 0 still grants up to the full capacity. A claim covers only the
    // window before its own reservation record is durable: it is transferred to
    // that record the moment the journal adopts it, so a slot is never counted
    // twice and concurrent same-tick acquires still cannot over-admit.
    const waiting = this.waiters.filter(waiter => !waiter.claimed && !waiter.settled).length;
    const claimable = this.availableSlots() > 0;
    if (!claimable && waiting >= this.maxQueue) {
      throw new WorkerError('pool_queue_full', `The runner pool queue is full (${this.maxQueue} waiting requests); no lease was allocated.`);
    }
    let resolveGrant: (lease: RunnerLease) => void = () => undefined;
    let rejectGrant: (error: Error) => void = () => undefined;
    const promise = new Promise<RunnerLease>((resolve, reject) => {
      resolveGrant = resolve;
      rejectGrant = reject;
    });
    const waiter: PoolWaiter = {
      admissionId: randomUUID().replace(/-/g, ''), owner: validated, caller: signal, promise, resolve: resolveGrant, reject: rejectGrant,
      settled: false, aborted: false, claimed: claimable
    };
    if (claimable) {
      this.claims += 1;
    }
    this.waiters.push(waiter);
    const onAbort = (): void => {
      waiter.aborted = true;
      if (waiter.settled) {
        return;
      }
      const index = this.waiters.indexOf(waiter);
      if (index < 0) {
        return; // A grant is in flight; the pump discards it and rejects this waiter.
      }
      this.waiters.splice(index, 1);
      waiter.settled = true;
      this.releaseClaim(waiter);
      void this.cancelAdmission(waiter.admissionId).then(() => rejectGrant(new WorkerError('pool_aborted', 'The acquire request was aborted while queued; no lease was allocated.')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.schedulePump();
    try {
      const lease = await promise;
      return lease;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Full status: slots, queue, durable leases, unknown entries, diagnostics. */
  status(): RunnerPoolStatus {
    // Read-only observation stays available while closing or closed, so a
    // caller can see the drain state and the leases that still hold slots.
    this.assertObservable();
    return Object.freeze({
      capacity: this.capacity,
      maxQueue: this.maxQueue,
      open: this.opened,
      closing: this.closing,
      closed: this.closed,
      slots: Object.freeze(this.slotsSnapshot()),
      queue: Object.freeze(this.waiters.map((waiter, index) => Object.freeze({ position: index + 1, owner: waiter.owner }))),
      leases: Object.freeze(Object.values(this.journal.leases).map(freezeRecord)),
      unknownEntries: Object.freeze([...this.unknownEntries]),
      diagnostics: Object.freeze([...this.diagnostics])
    });
  }

  /** Owner state: idle, queued with a 1-based position, leased or quarantined. */
  statusFor(owner: RunnerLeaseOwner): RunnerOwnerState {
    this.assertObservable();
    const validated = requireOwner(owner);
    const records = Object.values(this.journal.leases);
    const leased = records.find(record => sameOwner(record.owner, validated) && (record.state === 'leased' || record.state === 'reserved'));
    if (leased !== undefined) {
      return Object.freeze({ state: 'leased', lease: freezeRecord(leased) });
    }
    const quarantined = records.find(record => sameOwner(record.owner, validated) && record.state === 'quarantined');
    if (quarantined !== undefined) {
      return Object.freeze({ state: 'quarantined', lease: freezeRecord(quarantined) });
    }
    const index = this.waiters.findIndex(waiter => sameOwner(waiter.owner, validated));
    if (index >= 0) {
      return Object.freeze({ state: 'queued', position: index + 1 });
    }
    return Object.freeze({ state: 'idle' });
  }

  /**
   * Reconcile only this scope's abandoned/quarantined leases. A LIVE record that
   * provably never started is discarded without proof; anything
   * execution-started, already-quarantined or otherwise uncertain is discarded
   * ONLY when `proof` (or the injected conservative helper) asserts the process
   * is drained, and an explicit preserve retention needs that proof as well.
   * Leases live in this process, other owners' records and unknown directories
   * are never touched.
   */
  async cleanup(scope: RunnerPoolScope, proof?: RunnerProcessProof): Promise<RunnerPoolCleanupResult> {
    this.assertAdministrable();
    const validated = requireScope(scope);
    return this.mutex.run(async () => {
      const discarded: string[] = [];
      const retained: { leaseId: string; reason: string }[] = [];
      const plan = frozenPlan();
      for (const record of Object.values(this.journal.leases)) {
        if (record.owner.ownerId !== validated.ownerId || record.owner.teamId !== validated.teamId) {
          continue;
        }
        if (this.live.has(record.leaseId)) {
          retained.push({ leaseId: record.leaseId, reason: 'the lease is active in this process' });
          continue;
        }
        if (record.state === 'released') {
          if (await lstatOrNull(record.directory) === null) {
            plan.drops.add(record.leaseId);
            discarded.push(record.leaseId);
          } else {
            retained.push({ leaseId: record.leaseId, reason: 'a released lease still has a directory that needs proof to remove' });
          }
          continue;
        }
        if (!neverStarted(record) && !await this.prove(record, proof)) {
          retained.push({ leaseId: record.leaseId, reason: 'the process drain could not be proven' });
          continue;
        }
        const removal = await removeLeaseDirectory(this.directory, record);
        if (!removal.safe) {
          plan.quarantines.set(record.leaseId, this.quarantineRecord(record, removal.reason ?? 'the lease directory could not be verified'));
          retained.push({ leaseId: record.leaseId, reason: removal.reason ?? 'the lease directory could not be verified' });
          continue;
        }
        plan.drops.add(record.leaseId);
        discarded.push(record.leaseId);
      }
      if (!planIsEmpty(plan)) {
        await this.publish(draft => this.applyPlan(draft, plan));
      }
      if (plan.drops.size > 0) {
        this.schedulePump();
      }
      this.unknownEntries = await this.collectUnknown();
      return Object.freeze({
        discarded: Object.freeze([...discarded].sort()),
        retained: Object.freeze(retained.map(entry => Object.freeze(entry))),
        unknownEntries: Object.freeze([...this.unknownEntries])
      });
    });
  }

  /**
   * Reject queued acquires, abort every active lease signal, then await those
   * leases settling (each release publishes durably) before resolving, so the
   * caller may release the SessionStore lock only after the pool is quiet. A
   * lease that never settles fails the close with pool_drain_timeout instead of
   * returning early.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.closingPromise !== undefined) {
      return this.closingPromise;
    }
    this.closing = true;
    clearTimeout(this.pumpTimer);
    clearTimeout(this.withdrawalTimer);
    this.withdrawalTimer = undefined;
    const queued = this.waiters.splice(0, this.waiters.length);
    for (const waiter of queued) {
      waiter.settled = true;
      this.releaseClaim(waiter);
      waiter.reject(new WorkerError('pool_closed', 'The runner pool closed before this request was granted.'));
    }
    const attempt = (async () => {
      // Abort every active lease signal immediately: a caller waiting on the
      // signal must observe cancellation without waiting for a critical section.
      for (const liveLease of this.live.values()) {
        liveLease.controller.abort();
      }
      // One withdrawal covers the whole rejected queue: a batch admission runs it
      // as one exact scoped ledger transaction, and a legacy adapter starts its
      // cancellations together, so N tickets never serialize one deadline.
      await this.withdrawQueued(queued.map(waiter => waiter.admissionId));
      // Serialize with any grant already inside its critical section; such a
      // grant is discarded (no lease is handed out after closing).
      await this.mutex.run(async () => undefined);
      for (const liveLease of this.live.values()) {
        liveLease.controller.abort();
      }
      const pending = [...this.live.values()].map(liveLease => liveLease.settled);
      await withTimeout(Promise.all(pending), this.closeTimeoutMs,
        () => new WorkerError('pool_drain_timeout', 'The runner pool did not settle every active lease before closing.'));
      await Promise.all([...this.admissionCancellations]);
      this.closed = true;
      this.opened = false;
    })();
    // A close that could not drain a lease is an explicit error, never a silent
    // "closed". The caller keeps the SessionStore lock (never unlock on this
    // failure) and may call close() again once it has settled every lease.
    this.closingPromise = attempt.catch(error => {
      this.closingPromise = undefined;
      throw error;
    });
    return this.closingPromise;
  }

  // -- lease operations (invoked by PoolLease) --------------------------------

  /** Durable checkpoint; persisted before the effect it describes. */
  async checkpoint(live: LiveLease, input: RunnerLeaseCheckpoint): Promise<void> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new WorkerError('invalid_pool_checkpoint', 'A checkpoint must be an object with a phase.');
    }
    const fields = Object.keys(input as unknown as Record<string, unknown>);
    if (!fields.includes('phase') || fields.some(field => field !== 'phase' && field !== 'process')) {
      throw new WorkerError('invalid_pool_checkpoint', 'A checkpoint requires a phase and accepts only phase and process.');
    }
    const phase = (input as { phase?: unknown }).phase;
    if (typeof phase !== 'string' || !RUNNER_LEASE_PHASES.includes(phase as RunnerLeasePhase)) {
      throw new WorkerError('invalid_pool_checkpoint', `A checkpoint phase must be one of ${RUNNER_LEASE_PHASES.join(', ')}.`);
    }
    const process = input.process === undefined ? undefined : requireProcessIdentity(input.process);
    await this.mutex.run(async () => {
      if (this.closed) {
        throw new WorkerError('pool_closed', 'This runner pool is closed.');
      }
      if (live.result !== undefined) {
        throw new WorkerError('pool_lease_settled', `Lease ${live.id} is already ${live.result.state}.`);
      }
      const current = this.journal.leases[live.id];
      if (current === undefined) {
        throw new WorkerError('pool_unknown_lease', `Lease ${live.id} is not in this pool journal.`);
      }
      if (phaseIndex(phase as RunnerLeasePhase) < phaseIndex(current.phase)) {
        throw new WorkerError('invalid_pool_checkpoint', `Lease ${live.id} cannot move from ${current.phase} back to ${phase}.`);
      }
      const next: RunnerLeaseRecord = {
        ...current,
        phase: phase as RunnerLeasePhase,
        process: process ?? current.process,
        updatedAt: nowIso()
      };
      await this.publish(draft => {
        draft.leases[live.id] = next;
      });
      live.phase = next.phase;
    });
  }

  /** Idempotent release: safe deletion, or a retained quarantine. */
  async release(live: LiveLease, input: RunnerLeaseRelease): Promise<RunnerLeaseReleaseResult> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new WorkerError('invalid_pool_release', 'A release must be an object with a drained flag.');
    }
    const fields = Object.keys(input as unknown as Record<string, unknown>);
    if (fields.some(field => !['drained', 'preserve', 'diagnostic'].includes(field))) {
      throw new WorkerError('invalid_pool_release', 'A release accepts only drained, preserve and diagnostic.');
    }
    if (typeof input.drained !== 'boolean') {
      throw new WorkerError('invalid_pool_release', 'A release requires an explicit drained boolean.');
    }
    if (input.preserve !== undefined && typeof input.preserve !== 'boolean') {
      throw new WorkerError('invalid_pool_release', 'A release preserve flag must be a boolean.');
    }
    const diagnostic = requireDiagnostic(input.diagnostic);
    return this.mutex.run(async () => {
      if (live.result !== undefined) {
        return live.result;
      }
      const record = this.journal.leases[live.id];
      if (record === undefined) {
        throw new WorkerError('pool_unknown_lease', `Lease ${live.id} is not in this pool journal.`);
      }
      if (!input.drained || input.preserve === true) {
        const reason = input.drained ? 'quarantined by request' : 'released without a proven drain';
        // Only an explicit preserve request is retained for inspection; a
        // plain unproven-drain quarantine may later be discarded on proof.
        const quarantined = this.quarantineRecord(record, diagnostic ?? reason, input.preserve === true);
        await this.publish(draft => {
          draft.leases[live.id] = quarantined;
        });
        return this.finishLease(live, {
          leaseId: live.id, slot: live.slot, state: 'quarantined', deleted: false, diagnostic: quarantined.diagnostic
        });
      }
      const removal = await removeLeaseDirectory(this.directory, record);
      if (!removal.safe) {
        // Never clean or reuse an unverifiable directory: retain it durably.
        const quarantined = this.quarantineRecord(record, `${diagnostic ?? 'unsafe to delete'}: ${removal.reason ?? 'unverified directory'}`);
        await this.publish(draft => {
          draft.leases[live.id] = quarantined;
        });
        return this.finishLease(live, {
          leaseId: live.id, slot: live.slot, state: 'quarantined', deleted: false, diagnostic: quarantined.diagnostic
        });
      }
      const released: RunnerLeaseRecord = {
        ...record, state: 'released', preserve: false, updatedAt: nowIso(),
        ...(diagnostic === undefined ? {} : { diagnostic })
      };
      await this.publish(draft => {
        draft.leases[live.id] = released;
      });
      const finished = this.finishLease(live, {
        leaseId: live.id, slot: live.slot, state: 'released', deleted: true,
        ...(diagnostic === undefined ? {} : { diagnostic })
      });
      this.schedulePump();
      return finished;
    });
  }

  /**
   * Drop this scope's released tombstones. A tombstone is collected only when it
   * is provably finished: its directory is gone and no live lease in this
   * process still owns the id.
   *
   * The live check is the important half. A release publishes (and so adopts) its
   * 'released' revision BEFORE the aggregate reconcile of that very publish runs,
   * so a reconcile failure after adoption leaves a durable released record whose
   * lease is still live: its own release never reached finishLease. Dropping the
   * record here would turn the caller's exact release retry into
   * pool_unknown_lease and leave a live entry that close() can never drain.
   * Retaining it keeps both paths working: the retry re-publishes the same
   * 'released' state, settles the live entry and unblocks shutdown.
   *
   * The directory check mirrors cleanup(): a released record whose directory
   * still exists (or cannot be inspected) is retained instead of deleting a
   * record whose layout is no longer proven, so a directory is never orphaned as
   * an unknown entry that no record could ever reconcile.
   */
  async collectReleased(scope: RunnerPoolScope): Promise<number> {
    const validated = validateRunnerPoolScope(scope);
    return this.mutex.run(async () => {
      const collected: string[] = [];
      for (const record of Object.values(this.journal.leases)) {
        if (record.state !== 'released' || record.owner.ownerId !== validated.ownerId || record.owner.teamId !== validated.teamId) {
          continue;
        }
        if (this.live.has(record.leaseId) || await lstatOrNull(record.directory) !== null) {
          continue;
        }
        collected.push(record.leaseId);
      }
      if (collected.length === 0) {
        return 0;
      }
      await this.publish(draft => {
        for (const id of collected) {
          delete draft.leases[id];
        }
      });
      return collected.length;
    });
  }
  /** Frozen durable record for one lease id, when the journal still holds it. */
  leaseRecord(leaseId: string): RunnerLeaseRecord | undefined {
    const record = this.journal.leases[leaseId];
    return record === undefined ? undefined : freezeRecord(record);
  }

  // -- internals --------------------------------------------------------------

  private finishLease(live: LiveLease, result: RunnerLeaseReleaseResult): RunnerLeaseReleaseResult {
    live.result = Object.freeze(result);
    this.live.delete(live.id);
    live.markSettled();
    return live.result;
  }

  /**
   * Quarantine a record. `preserve` marks an EXPLICIT retain request (for
   * example an import failure awaiting inspection); such a record is never
   * auto-discarded on reopen. An ordinary quarantine (unproven drain, unsafe
   * directory) is not preserved, so a later reopen or cleanup that CAN prove the
   * drain may discard it.
   */
  private quarantineRecord(record: RunnerLeaseRecord, diagnostic: string, preserve = false): RunnerLeaseRecord {
    return {
      ...record,
      state: 'quarantined',
      preserve,
      diagnostic: diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH),
      updatedAt: nowIso()
    };
  }

  private async openLocked(): Promise<void> {
    if (this.projectRoot !== undefined && !await outsideProject(this.directory, this.projectRoot)) {
      invalidPath('The runner pool directory must be outside the project root.');
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await plainDirectory(this.directory) !== 'plain') {
      invalidPath('The runner pool directory must be a plain directory, not a symlink or junction.');
    }
    let text: string | undefined;
    const stat = await lstatOrNull(this.journalFile);
    if (stat !== null) {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        corrupt('The runner pool journal must be a regular file.');
      }
      if (stat.size > MAX_JOURNAL_BYTES) {
        throw new WorkerError('pool_capacity', `The runner pool journal exceeds ${MAX_JOURNAL_BYTES} bytes.`);
      }
      text = await fs.readFile(this.journalFile, 'utf8');
    }
    if (text === undefined) {
      // A missing journal over an existing slot tree is corrupt, never a fresh
      // start: adopting empty state could publish more live physical workspaces
      // than the configured capacity, and would orphan directories it cannot
      // see. Only a genuinely empty pool may start fresh, and its empty journal
      // is made durable BEFORE any later effect.
      const slotsPath = path.join(this.directory, SLOTS_DIRECTORY);
      const slotsStat = await lstatOrNull(slotsPath);
      if (slotsStat !== null) {
        if (slotsStat.isSymbolicLink() || !slotsStat.isDirectory()) {
          corrupt('The runner pool slots path is not a plain directory.');
        }
        if ((await fs.readdir(slotsPath)).length > 0) {
          corrupt('The runner pool journal is missing but slot directories exist; refusing to start a fresh pool over them.');
        }
      }
      this.journal = emptyJournal(this.directory);
      await this.publish(() => undefined);
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        corrupt('The runner pool journal is not valid JSON.');
      }
      this.journal = validateJournal(parsed, this.directory, this.capacity);
    }
    const plan = await this.reconcile();
    if (!planIsEmpty(plan)) {
      await this.publish(draft => this.applyPlan(draft, plan));
    }
    this.unknownEntries = await this.collectUnknown();
  }

  private applyPlan(draft: PoolJournal, plan: ReconcilePlan): void {
    for (const leaseId of plan.drops) {
      delete draft.leases[leaseId];
    }
    for (const [leaseId, record] of plan.quarantines) {
      draft.leases[leaseId] = record;
    }
  }

  /**
   * Reopen reconciliation. Reservations that provably never started are cleaned;
   * execution-started or uncertain records are quarantined unless the injected
   * proof asserts a drain. No command is replayed and no PID is ever signalled.
   */
  private async reconcile(): Promise<ReconcilePlan> {
    const plan = frozenPlan();
    for (const record of Object.values(this.journal.leases)) {
      if (record.state === 'released') {
        if (await lstatOrNull(record.directory) === null) {
          plan.drops.add(record.leaseId);
          this.diagnose(`Lease ${record.leaseId} was already released and cleaned; its tombstone was dropped.`);
        }
        continue;
      }
      // A PRESERVE quarantine is never auto-deleted on reopen, not even for a
      // provably never-started lease and not even when an injected proof says
      // the process is drained: retained data may still be awaiting inspection
      // (for example an import failure or a final persistence failure). Only an
      // explicit cleanup(scope, proof) may discard it.
      if (record.preserve) {
        this.diagnose(`Quarantined lease ${record.leaseId} was retained for inspection.`);
        continue;
      }
      if (neverStarted(record)) {
        const removal = await removeLeaseDirectory(this.directory, record);
        if (removal.safe) {
          plan.drops.add(record.leaseId);
          this.diagnose(`Abandoned lease ${record.leaseId} never started (phase ${record.phase}); it was cleaned.`);
        } else {
          plan.quarantines.set(record.leaseId, this.quarantineRecord(record, `abandoned lease: ${removal.reason ?? 'unverified directory'}`));
          this.diagnose(`Abandoned lease ${record.leaseId} was quarantined: ${removal.reason ?? 'unverified directory'}.`);
        }
        continue;
      }
      if (await this.prove(record)) {
        const removal = await removeLeaseDirectory(this.directory, record);
        if (removal.safe) {
          plan.drops.add(record.leaseId);
          this.diagnose(`Lease ${record.leaseId} was proven drained and its directory was removed.`);
        } else {
          plan.quarantines.set(record.leaseId, this.quarantineRecord(record, `drained but unverifiable: ${removal.reason ?? 'unverified directory'}`));
          this.diagnose(`Lease ${record.leaseId} was proven drained but its directory could not be verified.`);
        }
        continue;
      }
      // Keep an existing reason: it may record that the CALLER itself asserted a
      // possible start (a `drained: false` release), which must survive any
      // number of later restarts instead of decaying into the reload verdict.
      plan.quarantines.set(record.leaseId, this.quarantineRecord(record, record.diagnostic ?? RECOVERY_QUARANTINE));
      this.diagnose(`Lease ${record.leaseId} was quarantined after restart; its process drain is unproven.`);
    }
    return plan;
  }

  private async prove(record: RunnerLeaseRecord, proof?: RunnerProcessProof): Promise<boolean> {
    const helper = proof ?? this.proveDrained;
    if (helper === undefined) {
      return false;
    }
    try {
      return await Promise.resolve(helper(freezeRecord(record)));
    } catch {
      return false;
    }
  }

  /** Unknown pool entries are preserved and reported, never deleted. */
  private async collectUnknown(): Promise<string[]> {
    const unknown: string[] = [];
    const rootEntries = (await fs.readdir(this.directory).catch(() => [] as string[])).sort();
    const slotsPath = path.join(this.directory, SLOTS_DIRECTORY);
    const slotsStat = await lstatOrNull(slotsPath);
    for (const name of rootEntries) {
      if (name !== JOURNAL_FILE && name !== SLOTS_DIRECTORY) {
        unknown.push(name);
      }
    }
    if (slotsStat === null) {
      return unknown;
    }
    if (slotsStat.isSymbolicLink() || !slotsStat.isDirectory()) {
      unknown.push(SLOTS_DIRECTORY);
      return unknown;
    }
    const known = new Set<string>();
    for (const record of Object.values(this.journal.leases)) {
      if (record.state !== 'released') {
        known.add(path.join(slotsPath, String(record.slot), record.leaseId));
      }
    }
    for (const slotName of (await fs.readdir(slotsPath)).sort()) {
      const slotPath = path.join(slotsPath, slotName);
      const slotNumber = Number(slotName);
      if (!Number.isInteger(slotNumber) || String(slotNumber) !== slotName || slotNumber < 0 || slotNumber >= this.capacity) {
        unknown.push(path.join(SLOTS_DIRECTORY, slotName));
        continue;
      }
      const slotStat = await lstatOrNull(slotPath);
      if (slotStat === null || slotStat.isSymbolicLink() || !slotStat.isDirectory()) {
        unknown.push(path.join(SLOTS_DIRECTORY, slotName));
        continue;
      }
      for (const leaseName of (await fs.readdir(slotPath)).sort()) {
        const leasePath = path.join(slotPath, leaseName);
        if (!LEASE_ID_RE.test(leaseName) || !known.has(leasePath)) {
          unknown.push(path.join(SLOTS_DIRECTORY, slotName, leaseName));
        }
      }
    }
    return unknown;
  }

  private diagnose(message: string): void {
    if (this.diagnostics.length < MAX_DIAGNOSTICS) {
      this.diagnostics.push(message.slice(0, MAX_DIAGNOSTIC_LENGTH));
    }
  }

  private assertReady(): void {
    if (this.failed) {
      throw new WorkerError('pool_unavailable', 'This runner pool handle failed to open; construct a new handle.');
    }
    // Closed/closing wins over "not open": a closing pool must report that it
    // is closed, never that the caller forgot open().
    if (this.closed) {
      throw new WorkerError('pool_closed', 'This runner pool is closed.');
    }
    if (this.closing) {
      throw new WorkerError('pool_closed', 'The runner pool is closing.');
    }
    if (!this.opened) {
      throw new WorkerError('pool_unavailable', 'The runner pool is not open; call open() first.');
    }
  }

  /** Read-only observation: allowed while opening/closing/closed, never after a failed open. */
  private assertObservable(): void {
    if (this.failed) {
      throw new WorkerError('pool_unavailable', 'This runner pool handle failed to open; construct a new handle.');
    }
    if (!this.opened && !this.closed && !this.closing) {
      throw new WorkerError('pool_unavailable', 'The runner pool is not open; call open() first.');
    }
  }

  private assertAdministrable(): void {
    if (this.failed) {
      throw new WorkerError('pool_unavailable', 'This runner pool handle failed to open; construct a new handle.');
    }
    if (!this.opened) {
      throw new WorkerError('pool_unavailable', 'The runner pool is not open; call open() first.');
    }
    if (this.closed) {
      throw new WorkerError('pool_closed', 'This runner pool is closed.');
    }
  }

  private slotsSnapshot(): RunnerPoolSlotStatus[] {
    const occupying = new Map<number, RunnerLeaseRecord>();
    for (const record of Object.values(this.journal.leases)) {
      if (record.state !== 'released') {
        occupying.set(record.slot, record);
      }
    }
    const slots: RunnerPoolSlotStatus[] = [];
    for (let slot = 0; slot < this.capacity; slot += 1) {
      const record = occupying.get(slot);
      if (record === undefined) {
        slots.push(Object.freeze({ slot, state: 'free' }));
      } else {
        slots.push(Object.freeze({
          slot,
          state: record.state === 'quarantined' ? 'quarantined' : 'active',
          leaseId: record.leaseId,
          owner: record.owner
        }));
      }
    }
    return slots;
  }

  private freeSlot(): number | undefined {
    const used = new Set<number>();
    for (const record of Object.values(this.journal.leases)) {
      if (record.state !== 'released') {
        used.add(record.slot);
      }
    }
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (!used.has(slot)) {
        return slot;
      }
    }
    return undefined;
  }

  /**
   * Slots neither occupied by a durable lease nor promised to a request whose
   * reservation is still in flight. A claim is released exactly when its
   * reservation becomes durable (see reserveLocked), so a slot is never counted
   * both as a claim and as its own journal record.
   */
  private availableSlots(): number {
    let free = 0;
    const used = new Set<number>();
    for (const record of Object.values(this.journal.leases)) {
      if (record.state !== 'released') {
        used.add(record.slot);
      }
    }
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (!used.has(slot)) {
        free += 1;
      }
    }
    return free - this.claims;
  }

  /** Release a promised slot when an admitted request never becomes a lease. */
  private releaseClaim(waiter: PoolWaiter): void {
    if (waiter.claimed) {
      waiter.claimed = false;
      this.claims = Math.max(0, this.claims - 1);
    }
  }

  /**
   * Hand a still-promised slot over to its durable reservation. Called exactly
   * once, immediately after the reservation publish is adopted: the journal now
   * keeps that slot occupied, so keeping the claim as well would count one
   * promise twice and refuse a request while another slot is genuinely free.
   * Idempotent through releaseClaim, so every earlier and later failure path
   * stays safe.
   */
  private adoptClaim(waiter: PoolWaiter): void {
    this.releaseClaim(waiter);
  }

  /**
   * Promise a still-free slot to a promoted waiter. Called the instant a FIFO
   * waiter leaves the queue and BEFORE its first asynchronous reservation
   * publish: until that publish is adopted the slot still looks free in the
   * journal, so without this claim a concurrent acquire would be promised the
   * same slot, and the queue bound would be counted against a request that is
   * neither a `waiters` entry nor a durable record. The claim is idempotent, so
   * a waiter that was already claimed when it arrived is never counted twice.
   */
  private claimFor(waiter: PoolWaiter): void {
    if (!waiter.claimed) {
      // Admission can yield while a younger arrival promises the free slot.
      // The oldest eligible promotion inherits that promise; the younger
      // waiter occupies the queue entry this promotion just vacated.
      if (this.availableSlots() === 0) {
        const promised = this.waiters.find(candidate => candidate.claimed && !candidate.settled);
        if (promised) {
          this.releaseClaim(promised);
        }
      }
      waiter.claimed = true;
      this.claims += 1;
    }
  }

  /**
   * Settle one promoted waiter exactly once, with an error. An aborted request,
   * a draining pool or a failed promotion never leaves a pending promise, and
   * the promised slot is given back here on every one of those paths, so a
   * failure can neither strand a caller nor lose capacity.
   */
  private failWaiter(waiter: PoolWaiter, error: unknown): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    this.releaseClaim(waiter);
    waiter.reject(error instanceof Error ? error : new Error(String(error)));
  }

  /** Cleanup failure retains aggregate ownership, but cannot strand a caller. */
  private cancelAdmission(id: string): Promise<void> {
    const operation = this.cancelAdmissionNow(id);
    this.admissionCancellations.add(operation);
    void operation.then(() => this.admissionCancellations.delete(operation), () => this.admissionCancellations.delete(operation));
    return operation;
  }
  /**
   * Withdraw every ticket a close-time queue rejection orphaned.
   *
   * A batch-capable admission performs the whole withdrawal as ONE exact scoped
   * ledger transaction. An adapter that exposes only `cancel` starts every
   * withdrawal TOGETHER instead of awaiting them one after another, so N queued
   * tickets never multiply one bounded deadline into N serial deadlines.
   *
   * Either way the pool keeps local ownership of these tickets until their
   * effects settle: the withdrawal stays tracked in admissionCancellations and
   * close awaits it. The callers themselves were already rejected, so no waiter
   * is ever left pending on the ledger.
   */
  private async withdrawQueued(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const batch = this.admission?.cancelMany;
    if (batch === undefined) {
      // Legacy adapter: individual withdrawals, started together and joined once.
      await Promise.all(ids.map(id => this.cancelAdmission(id)));
      return;
    }
    const operation = this.withdrawMany(ids, batch);
    this.admissionCancellations.add(operation);
    void operation.then(() => this.admissionCancellations.delete(operation), () => this.admissionCancellations.delete(operation));
    await operation;
  }
  /**
   * One batch withdrawal. It never rejects and never falls back to per-ticket
   * cancellation: a failed transaction retains every affected ticket in the
   * ledger and is reported as one bounded batch diagnostic plus one diagnostic per
   * id, so an operator can reconcile each exact claim without guessing which ids
   * the failed call covered. No retry is scheduled here - the pool is already
   * draining, and the aggregate layer's bounded waiting-ticket window is the
   * independent second bound.
   */
  private async withdrawMany(ids: readonly string[], batch: NonNullable<RunnerAdmission['cancelMany']>): Promise<void> {
    try {
      await batch.call(this.admission, [...ids]);
      for (const id of ids) {
        this.withdrawals.delete(id);
      }
    } catch (error) {
      this.diagnose(`Aggregate claims ${summarizeIds(ids)} remain retained after one batch withdrawal of ${ids.length} queued tickets: ${describeFailure(error)}. Restore the ledger and reopen this exact pool to reconcile them; no command is replayed.`);
      for (const id of ids) {
        this.diagnose(`Aggregate claim ${id} remains retained: the batch withdrawal of ${ids.length} queued tickets failed.`);
      }
    }
  }
  private async cancelAdmissionNow(id: string): Promise<void> {
    try {
      await this.admission?.cancel(id);
      this.withdrawals.delete(id);
    } catch (error) {
      this.diagnose(`Aggregate claim ${id} remains retained: ${describeFailure(error)}. Restore the ledger and reopen this exact pool to reconcile it; no command is replayed.`);
      // Failure is not final while the aggregate ledger is merely unavailable:
      // retry the withdrawal a bounded number of times so a cancelled or closed
      // request does not leave a waiting ticket behind. The aggregate layer's
      // bounded ticket window is the independent second bound when every retry
      // fails, so head-of-line eligibility still cannot outlive it.
      if (this.admission !== undefined && !this.closing && !this.closed) {
        const attempts = (this.withdrawals.get(id) ?? 0) + 1;
        if (attempts < MAX_WITHDRAWAL_ATTEMPTS) {
          this.withdrawals.set(id, attempts);
          this.scheduleWithdrawalRetry();
        } else {
          this.withdrawals.delete(id);
        }
      }
    }
  }
  private scheduleWithdrawalRetry(): void {
    if (this.withdrawalTimer !== undefined || this.withdrawals.size === 0 || this.closing || this.closed) {
      return;
    }
    this.withdrawalTimer = setTimeout(() => {
      this.withdrawalTimer = undefined;
      for (const id of [...this.withdrawals.keys()]) {
        void this.cancelAdmission(id);
      }
    }, WITHDRAWAL_RETRY_MS);
    this.withdrawalTimer.unref();
  }

  private schedulePump(): void {
    void this.mutex.run(async () => {
      await this.pumpLocked();
    }).catch((error: unknown) => {
      // Every waiter is settled before pumpLocked can reject, so this is a pool
      // fault rather than a lost caller; record it instead of hiding it.
      this.diagnose(`The runner pool queue could not be pumped: ${describeFailure(error)}`);
    });
  }

  /**
   * Grant queued requests while slots are free. Runs inside the pool mutex but
   * never waits on a caller: every await is a bounded journal or directory
   * operation, and acquire never awaits its grant while holding that mutex.
   *
   * Every promoted request is settled on EVERY path - granted, cancelled,
   * closed, or a reservation that could not be discarded - so no caller is ever
   * left waiting on a promise this pool silently dropped. A failure is reported
   * to that one waiter and the loop keeps serving the rest of the queue.
   */
  private async pumpLocked(): Promise<void> {
    while (!this.closing && !this.closed && this.waiters.length > 0) {
      const slot = this.freeSlot();
      if (slot === undefined) {
        return;
      }
      let waiter: PoolWaiter | undefined;
      // One snapshot orders this pass, but every poll below awaits, and a close
      // batch or a caller abort can remove the WHOLE queue while an earlier poll
      // is gated. The pool state and the candidate's own liveness are therefore
      // re-checked before every NEW poll (and before the legacy no-admission
      // reservation): an id that was removed was already withdrawn and settled
      // exactly once, so it must never be offered to tryAcquire again or become a
      // fresh reservation. The poll that was ALREADY in flight keeps its own
      // settlement and withdrawal below, unchanged.
      for (const candidate of [...this.waiters]) {
        if (this.closing || this.closed) {
          return;
        }
        if (candidate.settled || candidate.aborted || !this.waiters.includes(candidate)) {
          continue;
        }
        // A throwing applicability check is settled in the SAME guarded path as a
        // throwing admission: this one request is refused (never left pending,
        // never wedged at the head of the queue) and the loop keeps serving the
        // rest of the queue instead of rejecting out of the pump.
        let eligible = true;
        try {
          eligible = this.admission === undefined || this.admission.applies?.(candidate.owner) !== false;
        } catch (error) {
          this.waiters = this.waiters.filter(w => w !== candidate); await this.cancelAdmission(candidate.admissionId); this.failWaiter(candidate, error); continue;
        }
        if (eligible && this.admission) {
          let granted: boolean;
          try {
            granted = await this.admission.tryAcquire(candidate.admissionId, candidate.owner, this.capacity);
          } catch (error) {
            this.waiters = this.waiters.filter(w => w !== candidate); await this.cancelAdmission(candidate.admissionId); this.failWaiter(candidate, error); continue;
          }
          if (candidate.aborted || !this.waiters.includes(candidate)) {
            await this.cancelAdmission(candidate.admissionId); continue;
          }
          if (!granted) {
            this.releaseClaim(candidate);
            if (this.waiters.filter(w => !w.claimed && !w.settled).length > this.maxQueue) {
              this.waiters = this.waiters.filter(w => w !== candidate); await this.cancelAdmission(candidate.admissionId);
              this.failWaiter(candidate, new WorkerError('pool_queue_full', 'Aggregate capacity requires waiting but this root queue is full.'));
            }
            continue;
          }
        }
        waiter = candidate; this.waiters = this.waiters.filter(w => w !== candidate); break;
      }
      if (!waiter) {
        if (!this.pumpTimer && this.waiters.length) {
          this.pumpTimer = setTimeout(() => {
            this.pumpTimer = undefined; this.schedulePump();
          }, 100); this.pumpTimer.unref();
        }
        return;
      }
      // A promoted request owns the promise of this slot BEFORE its first
      // asynchronous publish, exactly like an immediately grantable acquire.
      // Once that publish is adopted the claim is transferred to the durable
      // record (adoptClaim), so one slot is still counted exactly once.
      this.claimFor(waiter);
      if (waiter.aborted) {
        this.failWaiter(waiter, new WorkerError('pool_aborted', 'The acquire request was aborted while queued; no lease was allocated.'));
        continue;
      }
      await this.grantLocked(slot, waiter);
    }
  }

  /**
   * Reserve, then hand over or refuse, one promoted request.
   *
   * A refusal path may itself fail while it discards the untouched reservation:
   * a journal write or a directory removal can fail. That failure is never
   * swallowed and the waiter is never dropped. The durable record is retained
   * (a publish frees no slot before its own write succeeds, so the slot stays
   * consumed and the truth stays uncertain) and the caller is told, so it cannot
   * wait for a grant it will never receive. Nothing here weakens the drain,
   * path, scope or idempotency proofs: only settlement is made unconditional.
   */
  private async grantLocked(slot: number, waiter: PoolWaiter): Promise<void> {
    let grant: LeaseGrant;
    try {
      grant = await this.reserveLocked(slot, waiter.owner, waiter.caller, () => this.adoptClaim(waiter), waiter.admissionId);
    } catch (error) {
      if (!this.journal.leases[waiter.admissionId]) {
        await this.cancelAdmission(waiter.admissionId);
      }
      this.failWaiter(waiter, error);
      return;
    }
    if (!waiter.aborted && !this.closing && !this.closed) {
      waiter.settled = true;
      this.releaseClaim(waiter);
      waiter.resolve(grant.lease);
      return;
    }
    // Never hand out a lease the caller cancelled or that close is draining:
    // discard the untouched reservation (no process ever started).
    const refusal = this.closing || this.closed
      ? new WorkerError('pool_closed', 'The runner pool closed before this request was granted.')
      : new WorkerError('pool_aborted', 'The acquire request was aborted; no lease was allocated.');
    try {
      await this.discardReservation(grant.live.id);
    } catch (error) {
      this.diagnose(`Lease ${grant.live.id} could not be discarded after ${refusal.code}; its record is retained: ${describeFailure(error)}`);
      this.failWaiter(waiter, retainedReservationError(error, refusal));
      return;
    }
    this.failWaiter(waiter, refusal);
  }

  /**
   * Persist the reservation BEFORE any directory may exist, then create it.
   *
   * `onReserved` transfers the caller's slot claim to the durable reservation
   * and runs INSIDE the adopting publish, so the transfer is atomic with
   * adoption: the claim is held until the very instant the journal record
   * replaces it, and no interleaving can observe the slot as both, or as
   * neither. Afterwards the record keeps the slot unavailable.
   */
  private async reserveLocked(slot: number, owner: RunnerLeaseOwner, caller?: AbortSignal,
    onReserved?: () => void, leaseId = randomUUID().replace(/-/g, '')): Promise<LeaseGrant> {
    const paths = leasePaths(this.directory, slot, leaseId);
    const sequence = this.journal.nextSequence;
    const stamp = nowIso();
    const record: RunnerLeaseRecord = {
      leaseId,
      slot,
      sequence,
      state: 'reserved',
      phase: 'reserved',
      owner,
      directory: paths.directory,
      sourceDir: paths.sourceDir,
      tempDir: paths.tempDir,
      process: null,
      preserve: false,
      createdAt: stamp,
      updatedAt: stamp
    };
    await this.publish(draft => {
      draft.leases[leaseId] = record;
      draft.nextSequence = sequence + 1;
    }, onReserved);
    try {
      // Verify every ancestor FIRST and create missing ones one component at a
      // time: nothing is ever created through, or recursively past, an
      // unverified (possibly swapped/junction) pool component.
      await this.createLeaseDirectories(slot, paths);
    } catch (error) {
      const removal = await removeLeaseDirectory(this.directory, record);
      const quarantined = removal.safe ? undefined : this.quarantineRecord(record, `setup failed: ${removal.reason ?? 'unverified directory'}`);
      await this.publish(draft => {
        if (quarantined === undefined) {
          delete draft.leases[leaseId];
        } else {
          draft.leases[leaseId] = quarantined;
        }
      });
      throw new WorkerError('pool_setup_failed', `The lease directories could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The reservation is already durable, so a crash here is cleaned on reopen;
    // the slot is never handed out before this record is 'leased'.
    await this.publish(draft => {
      draft.leases[leaseId] = { ...record, state: 'leased', updatedAt: nowIso() };
    });
    const controller = new AbortController();
    let settle: () => void = () => undefined;
    const settled = new Promise<void>(resolve => {
      settle = resolve;
    });
    const live: LiveLease = { id: leaseId, slot, controller, settled, markSettled: settle, phase: 'reserved' };
    this.live.set(leaseId, live);
    return { lease: new PoolLease(this, live, this.journal.leases[leaseId], caller), live };
  }

  /**
   * Create the lease directories ONE component at a time, proving each parent
   * immediately before its child is created. Missing ancestors are created
   * non-recursively, so no step ever traverses an unverified component: a
   * `slots` or slot path that was swapped for a symlink/junction makes this
   * throw before anything is created outside the pool.
   */
  private async createLeaseDirectories(slot: number, paths: { directory: string; sourceDir: string; tempDir: string }): Promise<void> {
    await this.assertPlainAncestor(this.directory, 'the runner pool directory');
    const slotsPath = path.join(this.directory, SLOTS_DIRECTORY);
    await this.ensurePlainChild(this.directory, slotsPath, 'the runner pool slots directory');
    const slotPath = path.join(slotsPath, String(slot));
    await this.ensurePlainChild(slotsPath, slotPath, `runner pool slot ${slot}`);
    await this.ensurePlainChild(slotPath, paths.directory, 'the lease directory');
    // Re-prove the lease directory immediately before each descendant write.
    await this.ensurePlainChild(paths.directory, paths.sourceDir, 'the lease source directory');
    await this.ensurePlainChild(paths.directory, paths.tempDir, 'the lease temp directory');
  }

  /** A plain directory, never a symlink or junction; errors are setup failures. */
  private async assertPlainAncestor(target: string, label: string): Promise<void> {
    if (await plainDirectory(target) !== 'plain') {
      throw new Error(`${label} is not a plain directory`);
    }
  }

  /**
   * Prove `parent` is a plain directory, then create `child` non-recursively
   * only when it is absent, re-proving the parent immediately before the
   * create effect and the child immediately after it.
   */
  private async ensurePlainChild(parent: string, child: string, label: string): Promise<void> {
    if (!isStrictlyInside(this.directory, child)) {
      throw new Error(`${label} is outside the runner pool`);
    }
    await this.assertPlainAncestor(parent, `${label} parent`);
    const state = await plainDirectory(child);
    if (state === 'unsafe') {
      throw new Error(`${label} is not a plain directory`);
    }
    if (state === 'missing') {
      await this.assertPlainAncestor(parent, `${label} parent`);
      try {
        await fs.mkdir(child, { mode: 0o700 });
      } catch (error) {
        // A concurrent create is fine only when the result is a plain directory,
        // which the check below proves; anything else surfaces honestly.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
    if (await plainDirectory(child) !== 'plain') {
      throw new Error(`${label} is not a plain directory`);
    }
  }

  /** Drop a reservation that was never handed out (no process ever started). */
  private async discardReservation(leaseId: string): Promise<void> {
    const record = this.journal.leases[leaseId];
    if (record === undefined) {
      return;
    }
    const live = this.live.get(leaseId);
    if (live !== undefined) {
      this.live.delete(leaseId);
      live.controller.abort();
      live.markSettled();
    }
    const removal = await removeLeaseDirectory(this.directory, record);
    if (!removal.safe) {
      const quarantined = this.quarantineRecord(record, `cancelled lease: ${removal.reason ?? 'unverified directory'}`);
      await this.publish(draft => {
        draft.leases[leaseId] = quarantined;
      });
      return;
    }
    await this.publish(draft => {
      delete draft.leases[leaseId];
    });
  }

  /**
   * Validate, write and adopt one journal revision. A write failure changes no
   * in-memory state, so no slot is freed while its durable truth is unknown.
   *
   * `onAdopt` runs synchronously at the exact moment the new revision becomes
   * the in-memory truth, so a caller's bookkeeping can never lag behind (or run
   * ahead of) adoption: there is no `await` between the assignment and the hook.
   */
  private async publish(mutate: (draft: PoolJournal) => void, onAdopt?: () => void): Promise<void> {
    const draft: PoolJournal = {
      schema: 1,
      root: this.journal.root,
      revision: this.journal.revision,
      nextSequence: this.journal.nextSequence,
      leases: { ...this.journal.leases }
    };
    mutate(draft);
    draft.revision = this.journal.revision + 1;
    const text = JSON.stringify(draft);
    if (Buffer.byteLength(text, 'utf8') > MAX_JOURNAL_BYTES) {
      throw new WorkerError('pool_capacity', `The runner pool journal would exceed ${MAX_JOURNAL_BYTES} bytes.`);
    }
    const validated = validateJournal(JSON.parse(text), this.directory, this.capacity);
    // The journal's own parent must STILL be this exact plain pool directory:
    // a missing, renamed or junction-swapped parent could otherwise redirect
    // the atomic write (and its temp file) outside the pool.
    if (await plainDirectory(this.directory) !== 'plain') {
      throw new WorkerError('pool_corrupt', 'The runner pool directory is not a plain directory; refusing to write the journal.');
    }
    try {
      await this.writeJournal(this.journalFile, text);
    } catch (error) {
      throw new WorkerError('pool_storage', `The runner pool journal could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Adopt, then hand over atomically: no await separates these two statements.
    const releasedIds = Object.keys(this.journal.leases).filter(id => !validated.leases[id]);
    this.journal = validated;
    onAdopt?.();
    // Physical eligibility is reported from the ADOPTED journal on every
    // revision, so the aggregate layer never keeps a waiting ticket for a slot
    // this pool no longer has: the promotion below claims a slot before its own
    // record exists, and the adoption that records it also withdraws the
    // remaining tickets' eligibility for that same slot.
    await this.admission?.reconcile(Object.values(this.journal.leases), false, releasedIds, this.freeSlot() !== undefined);
  }
}
