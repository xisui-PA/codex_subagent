import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { IsolatedViewBinding } from './isolated-view-types';
import type { IsolatedViewIdentity, IsolatedViewPort } from './isolated-view-port';
import type { Delta, LayeredTree } from './layered-tree';
import {
  RunnerPool, validateRunnerPoolScope, type RunnerLease, type RunnerLeaseOwner, type RunnerLeaseRecord,
  type RunnerLeaseRelease, type RunnerPoolCleanupResult, type RunnerPoolScope, type RunnerPoolStatus,
  type RunnerProcessIdentity as PoolProcessIdentity
} from './runner-pool';
import {
  recoverRunnerProcess, runRunnerProcess, type RunnerProcessIdentity, type RunnerProcessInput, type RunnerProcessResult
} from './runner-process';
import {
  RunnerResults, type RunnerCommandAttempt, type RunnerCommandFinish, type RunnerCommandResult, type RunnerImportStatus,
  type RunnerInputVersion, type RunnerResultOutcome, type RunnerResultsStatus, type RunnerSetup
} from './runner-results';
import { importRunnerView, materializeRunnerView, type RunnerViewBaselineIdentity } from './runner-view';
import { Mutex, digest } from './storage';
import { WorkerError } from './types';

// ---------------------------------------------------------------------------
// Runner execution service: the orchestration layer between the already
// reviewed pool, view, process and results modules.
//
// It owns exactly one outcome: "run one approved command against a private view
// and record what happened, durably". It adds no policy of its own. Every
// per-model, per-write, per-shell and per-feature decision belongs to the
// caller's live `authorize`/`guard` hooks, which are re-invoked at every
// decision point and are always allowed to throw.
//
// Order of one execution (each step is deliberate and ordered):
//
//  1. Recheck the guards and the caller's permission/authorize hooks, then
//     acquire a FIFO lease from the pool WITHOUT holding any view mutex, so a
//     queued command can never block a read.
//  2. Build the command environment: TMP/TEMP/TMPDIR point at the lease temp
//     directory, and only the npm and pip DOWNLOAD caches are shared (under
//     checked plain manager cache directories). Every case variant of those
//     names is replaced, so nothing inherited can redirect temp or cache data.
//     Installed dependencies and build output stay lease-local: the command runs
//     inside the materialized source directory, so nothing live is copied,
//     linked or reused.
//  3. Inside ONE coherent `port.withView`: record the exact input version
//     (snapshot, overlay, revision), resolve the logical working directory
//     against the view tree, durably `results.start` the attempt BEFORE
//     anything is materialized (so a failed setup is still recorded), and
//     materialize the complete supported view through the reviewed helper.
//     The shared view mutex is released before approval or any shell work.
//  4. Checkpoint `prepared`, ask the caller to approve the exact command +
//     logical root + actual cwd + execution root + input revision (bound to the
//     lease signal), recheck authorization LIVE after the await, checkpoint
//     `executing`, then run the command. The process helper's `authorize` hook
//     is the last gate immediately before the real spawn, and its `onStarted`
//     hook journals the process identity on the SAME lease.
//  5. Import the source changes through `port.edit` after the process is
//     PROVEN drained, even for a nonzero exit, timeout or cancellation. The
//     fresh view must still be at the attempt's exact input revision, or the
//     import is refused so newer private changes are never overwritten. The
//     import guard deliberately ignores the command's abort signal (a
//     cancelled command still contributes its partial changes) but still
//     rechecks live authorization.
//  6. Persist one immutable final result (version 1, input before and after,
//     never a validation claim about the after revision) BEFORE the lease is
//     cleared, then release the lease. A final persistence failure quarantines
//     the directory and throws; the durable pending attempt becomes an
//     'uncertain' result on reload and is NEVER replayed.
//  7. A release whose own durable write fails is RETAINED (with the exact intent
//     it must honour) instead of dropped: the pool keeps the live record and slot
//     owned, and one bounded retry from cleanup() or close() settles it once
//     storage is healthy again. While the write still fails those calls reject
//     with the storage error, so no slot is silently stranded and no undrained or
//     uncertain directory is ever freed by a placeholder success.
//
// Durable state lives entirely outside the canonical project root: the pool,
// the results store and the manager caches are sibling subdirectories of one
// execution root, so a status read, a reopen or a cleanup never touches the
// project. open() proves that (through canonical existing ancestors) BEFORE it
// creates anything, so an aliased store path cannot be written even once.
//
// Lifecycle: open() is lazy and single-flight; close() aborts every command,
// waits for an in-flight open() and for every command's durable result write and
// lease release, then drains the pool and only then closes the results store, so
// the host may release the SessionStore lock afterwards. No command is replayed.
//
// Safety posture: this is physical shell execution (outside the Codex sandbox),
// not a sandbox. Containment and drain guarantees are the process helper's;
// this module only refuses to import or to claim success unless that helper
// reported `drained: true`.
// ---------------------------------------------------------------------------

/** Bounded defaults; the pool validates capacity and queue again itself. */
export const RUNNER_EXECUTION_DEFAULTS = { capacity: 2, maxQueue: 32, timeoutMs: 120_000 } as const;
/** Hard upper bound for one command timeout (matches the results schema). */
export const RUNNER_EXECUTION_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Maximum accepted command characters (matches the results schema). */
export const RUNNER_EXECUTION_MAX_COMMAND_CHARS = 4_000;
/** Materializer identity recorded in every durable attempt. */
export const RUNNER_EXECUTION_MATERIALIZER = 'runner-view/1';
/** Shared DOWNLOAD caches only; installed trees stay lease-local. */
export const RUNNER_EXECUTION_CACHES = ['npm', 'pip'] as const;

const POOL_DIRECTORY = 'pool';
const RESULTS_DIRECTORY = 'results';
const CACHE_DIRECTORY = 'manager-cache';
const CACHE_ENV: Readonly<Record<(typeof RUNNER_EXECUTION_CACHES)[number], string>> = Object.freeze({
  npm: 'NPM_CONFIG_CACHE',
  pip: 'PIP_CACHE_DIR'
});
const TEAM_ID_RE = /^[0-9a-f]{32}$/;
const HASH64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_PATH_LENGTH = 8_192;
const MAX_DIAGNOSTIC_LENGTH = 1_000;
const MAX_POOL_DIAGNOSTIC_LENGTH = 500;
const PROCESS_PLATFORMS: readonly NodeJS.Platform[] = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'];
const SUPERVISOR_KINDS = ['posix-process-group', 'windows-job-object'] as const;
const EMPTY_DELTA: Delta = Object.freeze({});

/**
 * Environment names this module sets itself. Names are case-insensitive on
 * Windows and the package managers also read lower-case variants, so every case
 * variant inherited from the caller is dropped before ours is written; otherwise
 * an inherited `npm_config_cache`/`pip_cache_dir`/`tmp` would silently bypass the
 * lease-local temp directory and the managed download cache.
 */
const MANAGED_ENV_NAMES: readonly string[] = Object.freeze(['TMP', 'TEMP', 'TMPDIR', ...Object.values(CACHE_ENV)]);

const isManagedEnvName = (key: string): boolean => MANAGED_ENV_NAMES.includes(key.toUpperCase());

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function invalidConfig(message: string): never {
  throw new WorkerError('invalid_runner_execution_config', message);
}

function invalidInput(message: string): never {
  throw new WorkerError('invalid_runner_execution_input', message);
}

function invalidPath(message: string): never {
  throw new WorkerError('invalid_path', message);
}

/** Bounded diagnostic text; the results schema and the pool cap differ. */
function short(text: string, limit = MAX_DIAGNOSTIC_LENGTH): string {
  const trimmed = text.trim();
  return (trimmed.length === 0 ? 'unknown failure' : trimmed).slice(0, limit);
}

function combine(...parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.trim().length > 0);
  return kept.length === 0 ? undefined : short(kept.join('; '));
}

/**
 * Combine two release intents for the SAME lease into one conservative intent.
 *
 * A retained intent is the safety contract a later retry must honour, so it may
 * never be weakened by a second attempt: `drained` stays true only when every
 * attempt proved it, and an explicit `preserve` survives any number of retries.
 * That makes it impossible to turn an "unknown outcome, keep the directory"
 * release into a "delete the directory" release.
 */
function mergeRelease(previous: RunnerLeaseRelease | undefined, next: RunnerLeaseRelease): RunnerLeaseRelease {
  if (previous === undefined) {
    return Object.freeze({ ...next });
  }
  const diagnostic = combine(previous.diagnostic, next.diagnostic);
  return Object.freeze({
    drained: previous.drained && next.drained,
    preserve: previous.preserve === true || next.preserve === true,
    ...(diagnostic === undefined ? {} : { diagnostic: short(diagnostic, MAX_POOL_DIAGNOSTIC_LENGTH) })
  });
}

/** True when `candidate` is strictly inside `root` (never equal, never '..'). */
function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

/** Canonicalize existing ancestors without requiring the path to exist yet. */
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

/** A combined signal plus the disposer that releases its listeners. */
interface CombinedSignal {
  readonly signal: AbortSignal;
  /** Removes every listener this combination added; idempotent. */
  dispose(): void;
}

/**
 * Combines the caller's signal with this execution's own cancellation source.
 * Every listener this adds is removed again by `dispose()` once the command has
 * settled, so one long-lived caller signal (a turn signal shared by many
 * commands) never accumulates a listener per execution. Relying on `once` alone
 * would still leave one listener attached after each SUCCESSFUL command, which
 * eventually trips MaxListenersExceededWarning.
 */
function combineSignals(signals: readonly AbortSignal[]): CombinedSignal {
  const controller = new AbortController();
  const attached: { readonly signal: AbortSignal; readonly onAbort: () => void }[] = [];
  let disposed = false;
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    attached.push({ signal, onAbort });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const entry of attached) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
    }
  };
}

/** The exact approval the host must grant before any shell work exists. */
export interface RunnerApprovalRequest {
  readonly command: string;
  /** Actual materialized working directory (never the live project root). */
  readonly cwd: string;
  readonly logicalRoot: string;
  /**
   * Physical lease root that contains the materialized `source` directory and
   * the lease-local `temp` directory (the command's TMP/TEMP/TMPDIR). It is the
   * runner's own accounting boundary, NOT an OS sandbox: the command's real
   * write access is whatever this host process was granted.
   */
  readonly executionRoot: string;
  readonly inputVersion: RunnerInputVersion;
}

/** Approval hook; `signal` aborts when the command is cancelled or closing. */
export type RunnerApproval = (request: RunnerApprovalRequest, signal: AbortSignal) => Promise<boolean>;

/** Input accepted by {@link RunnerExecution.execute}. */
export interface RunnerExecutionInput {
  readonly command: string;
  /** Logical path (relative to the logical root, or an absolute logical path). */
  readonly path?: string;
  readonly timeoutMs?: number;
}

/** Observable execution state; sub-statuses stay null before open(). */
export interface RunnerExecutionStatus {
  readonly directory: string;
  readonly logicalRoot: string;
  readonly open: boolean;
  readonly closing: boolean;
  readonly closed: boolean;
  readonly active: number;
  readonly pool: RunnerPoolStatus | null;
  readonly results: RunnerResultsStatus | null;
}

/** Construction options; the hooks are the host's only policy surface. */
export interface RunnerExecutionOptions {
  readonly capacity?: number;
  readonly maxQueue?: number;
  readonly closeTimeoutMs?: number;
  /** Feature/global kill switch rechecked at every decision point. */
  readonly guard?: () => void;
  readonly approveCommand: RunnerApproval;
  /**
   * Base environment. Inherited verbatim except the names this module owns
   * (TMP/TEMP/TMPDIR and the managed download caches), whose case variants are
   * replaced so nothing inherited can redirect temp or cache data.
   */
  readonly environment?: () => NodeJS.ProcessEnv;
  readonly processRunner?: (input: RunnerProcessInput) => Promise<RunnerProcessResult>;
}

interface NormalizedInput {
  readonly command: string;
  readonly logicalPath: string | undefined;
  readonly timeoutMs: number;
}

interface ExecutionTask {
  readonly binding: IsolatedViewBinding;
  readonly identity: IsolatedViewIdentity;
  readonly port: IsolatedViewPort;
  readonly command: string;
  readonly logicalPath: string | undefined;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly authorize: (() => void) | undefined;
}

interface PreparedView {
  readonly version: RunnerInputVersion;
  readonly actualCwd: string;
  readonly baseline: RunnerViewBaselineIdentity;
}

/** Either the coherent view that was materialized, or its durable failure. */
type PrepareResult = { readonly ok: true; readonly view: PreparedView } | { readonly ok: false; readonly result: RunnerCommandResult };

interface StageOutcome {
  readonly finish: RunnerCommandFinish;
  readonly drained: boolean;
  readonly preserve: boolean;
}

/**
 * A lease whose durable release could not be published, together with the exact
 * release intent that must survive the failure. Retaining it is what keeps the
 * pool's live record (and therefore its slot) owned: nothing is freed, reused or
 * silently forgotten while storage is failing, and one bounded retry can settle
 * it once storage is healthy again.
 */
interface RetainedRelease {
  readonly lease: RunnerLease;
  readonly input: RunnerLeaseRelease;
}

interface ImportOutcome {
  readonly status: RunnerImportStatus;
  readonly afterVersion: RunnerInputVersion | null;
  readonly diagnostic?: string;
}

interface AttemptState {
  /** True as soon as a durable pending attempt exists for this lease. */
  recorded: boolean;
}

/** Live guard flags: which hook refused, so the outcome can name it. */
interface GuardState {
  policy: boolean;
}

/** Validated owner identity derived from the binding and the worker identity. */
function requireOwner(binding: IsolatedViewBinding, identity: IsolatedViewIdentity): RunnerLeaseOwner {
  if (typeof binding !== 'object' || binding === null) {
    invalidInput('A runner binding must be an object.');
  }
  if (typeof identity !== 'object' || identity === null) {
    invalidInput('A worker identity must be an object.');
  }
  const record = binding as unknown as Record<string, unknown>;
  const worker = identity as unknown as Record<string, unknown>;
  if (typeof record.teamId !== 'string' || !TEAM_ID_RE.test(record.teamId)) {
    invalidInput('binding.teamId must be 32 lowercase hex characters.');
  }
  if (typeof record.snapshotId !== 'string' || !HASH64_RE.test(record.snapshotId)) {
    invalidInput('binding.snapshotId must be 64 lowercase hex characters.');
  }
  if (typeof record.overlayId !== 'string' || !HASH64_RE.test(record.overlayId)) {
    invalidInput('binding.overlayId must be 64 lowercase hex characters.');
  }
  if (typeof worker.ownerId !== 'string' || worker.ownerId.length === 0 || worker.ownerId.length > 200) {
    invalidInput('identity.ownerId must be a 1..200 character string.');
  }
  if (typeof worker.workerId !== 'string' || !TEAM_ID_RE.test(worker.workerId)) {
    invalidInput('identity.workerId must be 32 lowercase hex characters.');
  }
  if (typeof worker.workerCreatedAt !== 'string' || !ISO_RE.test(worker.workerCreatedAt)
    || !Number.isFinite(Date.parse(worker.workerCreatedAt))) {
    invalidInput('identity.workerCreatedAt must be an ISO timestamp.');
  }
  return Object.freeze({
    ownerId: worker.ownerId,
    teamId: record.teamId,
    workerId: worker.workerId,
    workerCreatedAt: worker.workerCreatedAt
  });
}

function requireInput(input: unknown): NormalizedInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalidInput('Runner input must be an object with a command.');
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some(key => !['command', 'path', 'timeoutMs'].includes(key))) {
    invalidInput('Runner input accepts only command, path and timeoutMs.');
  }
  const command = record.command;
  if (typeof command !== 'string' || command.trim().length === 0 || command.length > RUNNER_EXECUTION_MAX_COMMAND_CHARS) {
    invalidInput(`A runner command must be a non-empty string of at most ${RUNNER_EXECUTION_MAX_COMMAND_CHARS} characters.`);
  }
  const logicalPath = record.path;
  if (logicalPath !== undefined && (typeof logicalPath !== 'string' || logicalPath.length === 0 || logicalPath.length > MAX_PATH_LENGTH)) {
    invalidInput('A runner path must be a non-empty string when supplied.');
  }
  const timeoutMs = record.timeoutMs ?? RUNNER_EXECUTION_DEFAULTS.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNNER_EXECUTION_MAX_TIMEOUT_MS) {
    invalidInput(`timeoutMs must be an integer between 1 and ${RUNNER_EXECUTION_MAX_TIMEOUT_MS}.`);
  }
  return Object.freeze({ command, logicalPath: logicalPath as string | undefined, timeoutMs });
}

/**
 * Strict, bounded parse of a journaled process identity. Anything that does not
 * match the process helper's exact containment shape is treated as unprovable,
 * so cleanup can never kill or discard based on a partial identity.
 */
function recordedIdentity(value: unknown): RunnerProcessIdentity | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allowed = ['platform', 'pid', 'startMarker', 'supervisor', 'descendants'];
  if (Object.keys(record).some(key => !allowed.includes(key))) {
    return undefined;
  }
  if (typeof record.platform !== 'string' || !PROCESS_PLATFORMS.includes(record.platform as NodeJS.Platform)) {
    return undefined;
  }
  const pid = record.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (typeof record.startMarker !== 'string' || record.startMarker.length > 200) {
    return undefined;
  }
  const supervisor = record.supervisor;
  if (typeof supervisor !== 'object' || supervisor === null || Array.isArray(supervisor)) {
    return undefined;
  }
  const containment = supervisor as Record<string, unknown>;
  if (Object.keys(containment).length !== 2 || Object.keys(containment).some(key => key !== 'kind' && key !== 'name')) {
    return undefined;
  }
  if (typeof containment.kind !== 'string' || !SUPERVISOR_KINDS.includes(containment.kind as (typeof SUPERVISOR_KINDS)[number])) {
    return undefined;
  }
  if (typeof containment.name !== 'string' || containment.name.length === 0 || containment.name.length > 300) {
    return undefined;
  }
  let descendants: { envName: string; marker: string } | undefined;
  if (record.descendants !== undefined) {
    const marker = record.descendants;
    if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) {
      return undefined;
    }
    const fields = marker as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || Object.keys(fields).some(key => key !== 'envName' && key !== 'marker')) {
      return undefined;
    }
    if (typeof fields.envName !== 'string' || fields.envName.length === 0 || fields.envName.length > 200
      || typeof fields.marker !== 'string' || fields.marker.length === 0 || fields.marker.length > 200) {
      return undefined;
    }
    descendants = { envName: fields.envName, marker: fields.marker };
  }
  return {
    platform: record.platform as NodeJS.Platform,
    pid,
    startMarker: record.startMarker,
    supervisor: { kind: containment.kind as (typeof SUPERVISOR_KINDS)[number], name: containment.name },
    ...(descendants === undefined ? {} : { descendants })
  };
}

/**
 * Orchestrates the reviewed pool, view, process and results modules for one
 * bounded command. Construction validates configuration only; open() is lazy,
 * single-flight and fails closed.
 */
export class RunnerExecution {
  readonly directory: string;
  readonly logicalRoot: string;
  readonly pool: RunnerPool;
  readonly results: RunnerResults;

  private readonly options: RunnerExecutionOptions;
  private readonly cacheRoot: string;
  private readonly active = new Set<Promise<RunnerCommandResult>>();
  private readonly controllers = new Set<AbortController>();
  /**
   * Leases whose durable release could not be published, keyed by lease id and
   * holding the conservative intent a retry must honour. Only cleanup() and
   * close() retry them, i.e. only after the owning command has settled, and one
   * failed release keeps its slot owned instead of stranding an orphan live
   * lease that no caller could ever settle again.
   */
  private readonly retained = new Map<string, RetainedRelease>();
  /** Serializes every retained-release retry; never held during a command. */
  private readonly retryMutex = new Mutex();
  private opened = false;
  private failed = false;
  private closing = false;
  private closed = false;
  private openPromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(directory: string, logicalRoot: string, options: RunnerExecutionOptions) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.length > MAX_PATH_LENGTH || !path.isAbsolute(directory)) {
      invalidPath('The runner execution directory must be a non-empty absolute path.');
    }
    if (typeof logicalRoot !== 'string' || logicalRoot.length === 0 || logicalRoot.length > MAX_PATH_LENGTH || !path.isAbsolute(logicalRoot)) {
      invalidPath('The logical project root must be a non-empty absolute path.');
    }
    if (typeof options !== 'object' || options === null) {
      invalidConfig('Runner execution options are required.');
    }
    if (typeof options.approveCommand !== 'function') {
      invalidConfig('approveCommand is required: every command must be approved.');
    }
    if (options.guard !== undefined && typeof options.guard !== 'function') {
      invalidConfig('guard must be a function when supplied.');
    }
    if (options.environment !== undefined && typeof options.environment !== 'function') {
      invalidConfig('environment must be a function when supplied.');
    }
    if (options.processRunner !== undefined && typeof options.processRunner !== 'function') {
      invalidConfig('processRunner must be a function when supplied.');
    }
    this.directory = path.resolve(directory);
    this.logicalRoot = path.resolve(logicalRoot);
    if (within(this.logicalRoot, this.directory) || within(this.directory, this.logicalRoot)) {
      invalidPath('The runner execution directory must sit outside the logical project root.');
    }
    this.options = options;
    this.cacheRoot = path.join(this.directory, CACHE_DIRECTORY);
    this.pool = new RunnerPool(path.join(this.directory, POOL_DIRECTORY), {
      projectRoot: this.logicalRoot,
      capacity: options.capacity ?? RUNNER_EXECUTION_DEFAULTS.capacity,
      maxQueue: options.maxQueue ?? RUNNER_EXECUTION_DEFAULTS.maxQueue,
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs })
    });
    this.results = new RunnerResults(path.join(this.directory, RESULTS_DIRECTORY), this.logicalRoot);
  }

  /** Validate the layout and open the pool and results store exactly once. */
  open(): Promise<void> {
    if (this.failed) {
      return Promise.reject(new WorkerError('runner_execution_unavailable',
        'This runner execution handle failed to open; construct a new handle.'));
    }
    if (this.closed || this.closing) {
      return Promise.reject(new WorkerError('runner_execution_closed',
        'This runner execution handle is closing or closed; construct a new handle.'));
    }
    if (this.openPromise === undefined) {
      this.openPromise = this.openOnce().catch((error: unknown) => {
        // An open interrupted by an orderly close is not a broken handle: the
        // closed handle must stay observable, so only a real failure poisons it.
        if (!this.closing && !this.closed) {
          this.failed = true;
        }
        throw error;
      });
    }
    return this.openPromise;
  }

  /**
   * Run one command. Every failure that is durable is RETURNED as an immutable
   * result; only precondition, pool and persistence failures throw. A command
   * is never replayed and a rejection before the attempt is recorded leaves no
   * trace in the results store.
   */
  execute(
    binding: IsolatedViewBinding,
    identity: IsolatedViewIdentity,
    port: IsolatedViewPort,
    input: RunnerExecutionInput,
    signal: AbortSignal,
    authorize?: () => void
  ): Promise<RunnerCommandResult> {
    this.assertReady();
    if (typeof port !== 'object' || port === null || typeof port.withView !== 'function' || typeof port.edit !== 'function') {
      invalidInput('A runner execution requires an isolated view port with withView and edit.');
    }
    if (typeof signal !== 'object' || signal === null || typeof signal.aborted !== 'boolean') {
      invalidInput('A runner execution requires an abort signal.');
    }
    if (authorize !== undefined && typeof authorize !== 'function') {
      invalidInput('authorize must be a function when supplied.');
    }
    requireOwner(binding, identity);
    const normalized = requireInput(input);
    // Recheck the guards and the caller's permission BEFORE anything is
    // allocated, so a revoked grant never even queues.
    this.live(authorize);
    if (signal.aborted) {
      throw new WorkerError('runner_execution_cancelled', 'The command was cancelled before it was scheduled.');
    }
    const controller = new AbortController();
    const combined = combineSignals([signal, controller.signal]);
    const task: ExecutionTask = {
      binding,
      identity,
      port,
      command: normalized.command,
      logicalPath: normalized.logicalPath,
      timeoutMs: normalized.timeoutMs,
      signal: combined.signal,
      authorize
    };
    const promise = this.run(task);
    // Registration is synchronous: a close() issued in the same tick already
    // knows about this command and aborts it.
    this.active.add(promise);
    this.controllers.add(controller);
    const settle = (): void => {
      this.active.delete(promise);
      this.controllers.delete(controller);
      // Remove this command's listeners from the caller's signal, so a shared
      // long-lived turn signal never grows one listener per command.
      combined.dispose();
    };
    void promise.then(settle, settle);
    return promise;
  }

  /** Pool, results and count observation; nothing is ever executed here. */
  status(): RunnerExecutionStatus {
    if (this.failed) {
      throw new WorkerError('runner_execution_unavailable', 'This runner execution handle failed to open; construct a new handle.');
    }
    const observant = this.opened || this.closing || this.closed;
    return Object.freeze({
      directory: this.directory,
      logicalRoot: this.logicalRoot,
      open: this.opened,
      closing: this.closing,
      closed: this.closed,
      active: this.active.size,
      pool: observant ? this.pool.status() : null,
      results: this.opened || this.closed ? this.results.status() : null
    });
  }

  /**
   * Reconcile only this scope's abandoned leases. Nothing executes here and a
   * quarantine is only discarded when the recorded strict process identity is
   * confirmed drained by the process helper; an unknown or partial identity is
   * preserved.
   *
   * A release that failed for THIS scope is retried first, so a recovered store
   * can settle the lease it retained and this scope's reconciliation can then see
   * its durable record. The scope is validated and copied BEFORE that retry: a
   * malformed scope has no release side effect at all, and another owner's or
   * team's retained release is never retried, never reports its storage error
   * here and is never settled by this call — "only this scope" stays true. While
   * the write still fails the retry rejects, so the lease stays retained and owns
   * its slot: nothing is reported as cleaned up and nothing undrained or
   * uncertain is ever freed.
   */
  async cleanup(scope: RunnerPoolScope): Promise<RunnerPoolCleanupResult> {
    this.assertReady();
    // Same validator, error codes and copied shape the pool's own cleanup uses.
    const validated = validateRunnerPoolScope(scope);
    await this.reconcileRetained(validated);
    return this.pool.cleanup(validated, record => this.proveDrained(record));
  }

  /**
   * Reject new commands, abort every queued and running one, then wait for an
   * in-flight open() and for every registered command (including its result
   * write and lease release) before draining the pool and closing the results
   * store. A command that never settles fails the close instead of unlocking the
   * store early.
   *
   * A lease whose release could not be published is retained and retried here.
   * While that write still fails, close() rejects with the real storage error and
   * leaves the store open, so the caller keeps the owner lock and may call
   * close() again once storage recovers; a permanent drain timeout is impossible.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closing = true;
    const attempt = (async () => {
      // Abort FIRST: lease signals reject queued acquires and terminate running
      // commands, so the settle wait below can never sit behind new work.
      this.abortAll();
      // A close() that raced a still-running open() must let that open settle
      // BEFORE any store closes. Otherwise openOnce() would keep creating
      // directories and publishing journals after close() returned, i.e. after
      // the caller released the store lock.
      if (this.openPromise !== undefined) {
        await this.openPromise.then(() => undefined, () => undefined);
        this.abortAll();
      }
      // Every registered command settles only after its own durable result write
      // and lease release, and each job promise is handled here. This wait is
      // deliberately NOT bounded by the pool close timeout: a legitimate slow
      // import must still finish, and the pool drain below is what bounds leases.
      const pending = [...this.active];
      await Promise.all(pending.map(job => job.then(() => undefined, () => undefined)));
      // Every command has settled, so no live work can be released here. A
      // release that failed earlier is retried exactly once — with NO scope, so
      // every lease this handle still owns is settled and the drain below cannot
      // be blocked by a retention no scoped cleanup was asked to touch. When the
      // store is healthy again the lease settles and the drain succeeds, and while
      // it still fails the real storage error propagates instead of a drain
      // timeout. The handle stays closing and close() may be retried.
      await this.reconcileRetained();
      // Only now drain the pool: every lease was released above, so a pool
      // close timeout here is a real leak rather than a command still working.
      await this.pool.close();
      await this.results.close();
      this.closed = true;
      this.opened = false;
    })();
    this.closePromise = attempt.catch((error: unknown) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  /** Abort every queued and running command; safe to call repeatedly. */
  private abortAll(): void {
    for (const controller of this.controllers) {
      controller.abort();
    }
  }

  // -- internals --------------------------------------------------------------

  private async openOnce(): Promise<void> {
    this.assertOpening();
    // The outside-root proof comes FIRST and uses canonical EXISTING ancestors,
    // so a store path that is really an alias (junction/symlink) into the
    // project fails before a single directory is created inside the main tree.
    await this.proveOutsideProject();
    this.assertOpening();
    await this.ensureDirectory(this.directory);
    this.assertOpening();
    // Re-prove against the now-existing directory: its realpath is exact here.
    await this.proveOutsideProject();
    await this.ensureDirectory(this.cacheRoot, this.directory);
    for (const kind of RUNNER_EXECUTION_CACHES) {
      this.assertOpening();
      await this.ensureDirectory(this.cachePath(kind), this.cacheRoot);
    }
    this.assertOpening();
    // No drain proof is injected: a read, a reopen or a status call can never
    // signal or kill a process. Only an explicit cleanup may prove a drain.
    await this.pool.open();
    this.assertOpening();
    await this.results.open();
    this.assertOpening();
    this.opened = true;
  }

  /** Refuse to keep opening after a close() started. */
  private assertOpening(): void {
    if (this.closed || this.closing) {
      throw new WorkerError('runner_execution_closed', 'This runner execution handle closed while opening.');
    }
  }

  /** Canonical proof that the execution tree sits outside the project root. */
  private async proveOutsideProject(): Promise<void> {
    const [canonicalRoot, canonicalExecution] = await Promise.all([
      canonicalPath(this.logicalRoot), canonicalPath(this.directory)
    ]);
    if (within(canonicalRoot, canonicalExecution) || within(canonicalExecution, canonicalRoot)) {
      invalidPath('The runner execution directory must sit outside the logical project root.');
    }
  }

  /** A plain directory, never a symlink or junction. */
  private async assertPlainDirectory(target: string, label: string): Promise<void> {
    const stat = await lstatOrNull(target);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkerError('runner_execution_directory_unsafe', `${label} is not a plain directory: ${target}`);
    }
  }

  /**
   * Create one plain directory, re-proving `parent` immediately before the
   * create so nothing is ever made through a swapped component.
   */
  private async ensureDirectory(target: string, parent?: string): Promise<void> {
    if (parent !== undefined) {
      await this.assertPlainDirectory(parent, 'The runner execution parent directory');
    }
    const stat = await lstatOrNull(target);
    if (stat === null) {
      if (parent !== undefined) {
        await this.assertPlainDirectory(parent, 'The runner execution parent directory');
      }
      try {
        await fs.mkdir(target, { mode: 0o700 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          await fs.mkdir(target, { recursive: true, mode: 0o700 });
        } else if (code !== 'EEXIST') {
          throw new WorkerError('runner_execution_storage',
            `The runner execution directory could not be created: ${describe(error)}`);
        }
      }
    }
    const confirmed = await lstatOrNull(target);
    if (confirmed === null || confirmed.isSymbolicLink() || !confirmed.isDirectory()) {
      invalidPath(`The runner execution path is not a plain directory: ${target}`);
    }
  }

  private cachePath(kind: (typeof RUNNER_EXECUTION_CACHES)[number]): string {
    return path.join(this.cacheRoot, kind);
  }

  private assertReady(): void {
    if (this.failed) {
      throw new WorkerError('runner_execution_unavailable', 'This runner execution handle failed to open; construct a new handle.');
    }
    if (this.closed || this.closing) {
      throw new WorkerError('runner_execution_closed', 'This runner execution handle is closed or closing.');
    }
    if (!this.opened) {
      throw new WorkerError('runner_execution_unavailable', 'The runner execution is not open; call open() first.');
    }
  }

  /** Live policy gates: the host guard first, then the caller's authorize. */
  private live(authorize: (() => void) | undefined): void {
    this.options.guard?.();
    authorize?.();
  }

  private ownerOf(task: ExecutionTask): RunnerLeaseOwner {
    return Object.freeze({
      ownerId: task.identity.ownerId,
      teamId: task.binding.teamId,
      workerId: task.identity.workerId,
      workerCreatedAt: task.identity.workerCreatedAt
    });
  }

  private async run(task: ExecutionTask): Promise<RunnerCommandResult> {
    const lease = await this.pool.acquire(this.ownerOf(task), task.signal);
    const state: AttemptState = { recorded: false };
    try {
      const env = await this.environmentFor(lease);
      const setup = this.setupIdentity(env);
      const prepared = await this.prepare(lease, task, setup, state);
      if (!prepared.ok) {
        // The durable setup failure was recorded and the lease released.
        return prepared.result;
      }
      const stage = await this.runStage(lease, task, prepared.view, env);
      return await this.persist(lease, stage);
    } catch (error) {
      await this.abandon(lease, state.recorded, error);
      throw error;
    }
  }

  /** Base environment: inherited, except our temp and DOWNLOAD cache paths. */
  private async environmentFor(lease: RunnerLease): Promise<NodeJS.ProcessEnv> {
    const configured = this.options.environment?.() ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(configured)) {
      // Every case variant of a managed name is dropped BEFORE ours is set, so
      // an inherited `npm_config_cache` or `tmp` cannot bypass the lease. All
      // unrelated variables are preserved exactly as configured.
      if (typeof value === 'string' && !isManagedEnvName(key)) {
        env[key] = value;
      }
    }
    env.TMP = lease.tempDir;
    env.TEMP = lease.tempDir;
    env.TMPDIR = lease.tempDir;
    for (const kind of RUNNER_EXECUTION_CACHES) {
      await this.assertCache(kind);
      env[CACHE_ENV[kind]] = this.cachePath(kind);
    }
    return env;
  }

  /**
   * Proven plain manager cache directory. The execution root, the manager cache
   * root and the leaf are re-proved around the create, so a parent that was
   * swapped for a junction after open() can never redirect this write (or the
   * leaf) outside the runner's own tree.
   */
  private async assertCache(kind: (typeof RUNNER_EXECUTION_CACHES)[number]): Promise<void> {
    const target = this.cachePath(kind);
    if (!isStrictlyInside(this.directory, target) || !isStrictlyInside(this.cacheRoot, target)) {
      invalidPath(`The ${kind} download cache is outside the runner execution directory.`);
    }
    await this.assertPlainDirectory(this.directory, 'The runner execution directory');
    await this.assertPlainDirectory(this.cacheRoot, 'The runner manager cache root');
    if (await lstatOrNull(target) === null) {
      await this.assertPlainDirectory(this.cacheRoot, 'The runner manager cache root');
      try {
        await fs.mkdir(target, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
    const stat = await lstatOrNull(target);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkerError('runner_execution_cache_unsafe',
        `The ${kind} download cache is not a plain directory: ${target}`);
    }
  }

  /** Durable setup identity: no raw environment value, only its digest. */
  private setupIdentity(env: NodeJS.ProcessEnv): RunnerSetup {
    const caches = RUNNER_EXECUTION_CACHES.map(kind => Object.freeze(`${kind}:${this.cachePath(kind)}`));
    const environmentHash = digest(Object.keys(env).sort().map(key => [key, env[key] ?? '']));
    const shell = this.shellName();
    const identityHash = digest([
      'runner-execution-setup', RUNNER_EXECUTION_MATERIALIZER, process.platform, process.arch,
      process.version, shell, environmentHash, caches
    ]);
    return Object.freeze({
      identityHash,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      shell: shell.slice(0, 500),
      environmentHash,
      caches: Object.freeze(caches)
    });
  }

  private shellName(): string {
    if (process.platform === 'win32') {
      const configured = process.env.ComSpec;
      return typeof configured === 'string' && configured.length > 0 ? configured : 'cmd.exe';
    }
    return '/bin/sh';
  }

  /**
   * One coherent view: record the exact input version, durably start the
   * attempt BEFORE materializing (so a failed setup is still recorded), and
   * materialize the complete supported view. Returns undefined when the setup
   * failure was recorded, in which case the lease is already released.
   */
  private async prepare(
    lease: RunnerLease,
    task: ExecutionTask,
    setup: RunnerSetup,
    state: AttemptState
  ): Promise<PrepareResult> {
    const flags: GuardState = { policy: false };
    const guard = (): void => this.commandGuard(task, flags);
    try {
      const view = await task.port.withView(task.binding, task.identity, async current => {
        guard();
        const version = Object.freeze({
          snapshotId: task.binding.snapshotId,
          overlayId: task.binding.overlayId,
          revision: current.revision
        });
        const key = resolveLogicalKey(this.logicalRoot, task.logicalPath);
        const actualCwd = this.actualCwdFor(lease, current.tree, key);
        if (!state.recorded) {
          const attempt: RunnerCommandAttempt = {
            id: lease.id,
            owner: this.ownerOf(task),
            leaseId: lease.id,
            logicalRoot: this.logicalRoot,
            executionDirectory: actualCwd,
            command: task.command,
            timeoutMs: task.timeoutMs,
            inputVersion: version,
            setup,
            startedAt: new Date().toISOString()
          };
          await this.results.start(attempt);
          state.recorded = true;
        }
        const baseline = await materializeRunnerView(current, lease.sourceDir, guard);
        return { version, actualCwd, baseline };
      }, guard);
      return { ok: true, view };
    } catch (error) {
      if (!state.recorded) {
        throw error;
      }
      const outcome: RunnerResultOutcome = task.signal.aborted ? 'cancelled' : flags.policy ? 'denied' : 'setup_failed';
      const result = await this.recordFailure(lease, outcome, short(`the command setup failed: ${describe(error)}`));
      return { ok: false, result };
    }
  }

  private commandGuard(task: ExecutionTask, flags: GuardState): void {
    if (task.signal.aborted) {
      throw new WorkerError('runner_execution_cancelled', 'The command was cancelled.');
    }
    try {
      this.live(task.authorize);
    } catch (error) {
      flags.policy = true;
      throw error;
    }
  }

  /** Resolve the logical working directory inside the materialized root. */
  private actualCwdFor(lease: RunnerLease, tree: LayeredTree, key: string): string {
    if (key === '') {
      return lease.sourceDir;
    }
    const resolved = tree.resolve(key);
    const entry = resolved === undefined ? undefined : tree.entries[resolved];
    if (resolved === undefined || entry === undefined) {
      invalidPath(`The runner path ${key} is not visible in this private view.`);
    }
    if (entry.type !== 'directory') {
      invalidPath(`The runner path ${key} is not a directory in this private view.`);
    }
    return path.join(lease.sourceDir, ...resolved.split('/'));
  }

  /** Approval, live recheck, executing checkpoint, then the real command. */
  private async runStage(
    lease: RunnerLease,
    task: ExecutionTask,
    prepared: PreparedView,
    env: NodeJS.ProcessEnv
  ): Promise<StageOutcome> {
    await lease.checkpoint({ phase: 'prepared' });
    if (task.signal.aborted) {
      return this.idleStage('cancelled', 'The command was cancelled before approval.');
    }
    try {
      this.live(task.authorize);
    } catch (error) {
      return this.idleStage('denied', describe(error));
    }
    const approval = await this.askApproval(task, lease, prepared);
    if (task.signal.aborted) {
      return this.idleStage('cancelled', 'The command was cancelled while approval was pending.');
    }
    if (!approval.approved) {
      return this.idleStage('denied', approval.diagnostic ?? 'The command was not approved.');
    }
    // The approval is an await: authorization is rechecked LIVE afterwards, so
    // a grant revoked while the prompt was open can never start work.
    try {
      this.live(task.authorize);
    } catch (error) {
      return this.idleStage('denied', describe(error));
    }
    if (task.signal.aborted) {
      return this.idleStage('cancelled', 'The command was cancelled after approval.');
    }
    await lease.checkpoint({ phase: 'executing' });
    const run = await this.runCommand(lease, task, prepared, env);
    return this.composeStage(task, prepared, run.result, run.policyRejected);
  }

  private async askApproval(
    task: ExecutionTask,
    lease: RunnerLease,
    prepared: PreparedView
  ): Promise<{ approved: boolean; diagnostic?: string }> {
    const request: RunnerApprovalRequest = Object.freeze({
      command: task.command,
      cwd: prepared.actualCwd,
      logicalRoot: this.logicalRoot,
      executionRoot: lease.directory,
      inputVersion: prepared.version
    });
    try {
      const decision = await this.awaitApproval(request, lease.signal);
      return decision ? { approved: true } : { approved: false, diagnostic: 'The command was not approved.' };
    } catch (error) {
      return { approved: false, diagnostic: `The approval hook failed: ${describe(error)}` };
    }
  }

  /** Awaits approval, but a cancelled command stops waiting immediately. */
  private awaitApproval(request: RunnerApprovalRequest, signal: AbortSignal): Promise<boolean> {
    const pending = this.options.approveCommand(request, signal);
    if (signal.aborted) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => finish(false);
      const finish = (value: boolean): void => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(value => finish(value), (error: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  /**
   * The only place a command is started. The helper's `authorize` hook runs
   * immediately before the real spawn, and `onStarted` journals the durable
   * process identity on this exact lease (a late write can only touch this
   * lease, never another one).
   */
  private runCommand(
    lease: RunnerLease,
    task: ExecutionTask,
    prepared: PreparedView,
    env: NodeJS.ProcessEnv
  ): Promise<{ result: RunnerProcessResult; policyRejected: boolean }> {
    const runner = this.options.processRunner ?? runRunnerProcess;
    const flags: GuardState = { policy: false };
    return runner({
      command: task.command,
      cwd: prepared.actualCwd,
      env,
      timeoutMs: task.timeoutMs,
      signal: lease.signal,
      authorize: () => {
        try {
          this.live(task.authorize);
        } catch (error) {
          flags.policy = true;
          throw error;
        }
      },
      onStarted: async identity => {
        await lease.checkpoint({ phase: 'executing', process: identity as unknown as PoolProcessIdentity });
      }
    }).then(result => ({ result, policyRejected: flags.policy }));
  }

  /** Import the command's source changes and derive the final outcome. */
  private async composeStage(
    task: ExecutionTask,
    prepared: PreparedView,
    result: RunnerProcessResult,
    policyRejected: boolean
  ): Promise<StageOutcome> {
    const drained = result.drained;
    if (policyRejected && result.identity === null) {
      // The helper refused to spawn because authorization was revoked: the
      // command never ran, so this is a denial, not a failure.
      return this.idleStage('denied', result.diagnostic ?? 'Authorization was revoked before the command started.');
    }
    let imported: ImportOutcome = { status: 'not_started', afterVersion: null };
    let preserve = false;
    if (!drained) {
      imported = {
        status: 'uncertain',
        afterVersion: null,
        diagnostic: 'The process tree could not be proven drained, so the directory was quarantined and nothing was imported.'
      };
      preserve = true;
    } else {
      imported = await this.importChanges(task, prepared);
      if (imported.status === 'failed' || imported.status === 'uncertain') {
        preserve = true;
      }
    }
    const outcome = this.outcomeOf(result, imported, drained);
    const diagnostic = combine(result.diagnostic, imported.diagnostic);
    if (result.identity !== null && result.diagnostic !== undefined) {
      // An identity that was journaled late or whose run reported a problem may
      // still have side effects: keep the directory for inspection.
      preserve = true;
    }
    return {
      finish: {
        outcome,
        import: imported.status,
        afterVersion: imported.afterVersion,
        exitCode: result.exitCode,
        signal: result.signal,
        output: result.output,
        truncated: result.truncated,
        drained,
        ...(diagnostic === undefined ? {} : { diagnostic })
      },
      drained,
      preserve
    };
  }

  /** Success is claimed only for a clean, drained command with a completed import. */
  private outcomeOf(result: RunnerProcessResult, imported: ImportOutcome, drained: boolean): RunnerResultOutcome {
    if (!drained) {
      return 'uncertain';
    }
    if (result.cancelled) {
      return 'cancelled';
    }
    if (result.timedOut) {
      return 'timed_out';
    }
    if (imported.status === 'uncertain') {
      return 'uncertain';
    }
    if (imported.status === 'failed') {
      return 'failed';
    }
    if (result.diagnostic !== undefined && result.diagnostic.length > 0) {
      return 'failed';
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      return 'failed';
    }
    return imported.status === 'imported' || imported.status === 'unchanged' ? 'succeeded' : 'failed';
  }

  /**
   * Plan and publish ONE delta for the drained command directory through
   * `port.edit`. The command's abort signal is deliberately ignored here (a
   * cancelled command still contributes its partial changes), but live
   * authorization, the feature flag and the exact input revision are all
   * rechecked, so neither a revoked grant nor a newer private revision can be
   * overwritten.
   */
  private async importChanges(task: ExecutionTask, prepared: PreparedView): Promise<ImportOutcome> {
    const importGuard = (): void => this.live(task.authorize);
    try {
      const published = await task.port.edit(task.binding, task.identity, async (view, put) => {
        importGuard();
        if (view.revision !== prepared.version.revision) {
          throw new WorkerError('runner_execution_stale_input',
            `The private view advanced from revision ${String(prepared.version.revision)} to ${String(view.revision)}`
            + ' while the command ran; its output was not imported.');
        }
        const imported = await importRunnerView(view, prepared.baseline.directory, put, importGuard, prepared.baseline);
        return imported.changedPaths.length === 0 ? EMPTY_DELTA : imported.changes;
      }, importGuard);
      const after = Object.freeze({
        snapshotId: prepared.version.snapshotId,
        overlayId: prepared.version.overlayId,
        revision: published.revision
      });
      if (published.revision === prepared.version.revision) {
        return { status: 'unchanged', afterVersion: after };
      }
      if (published.revision === prepared.version.revision + 1) {
        return { status: 'imported', afterVersion: after };
      }
      return {
        status: 'uncertain',
        afterVersion: null,
        diagnostic: `The private view published revision ${String(published.revision)}, which is neither the input revision`
        + ' nor its single successor; the command output was preserved and not recorded as imported.'
      };
    } catch (error) {
      const stale = error instanceof WorkerError && error.code === 'runner_execution_stale_input';
      return {
        status: stale ? 'uncertain' : 'failed',
        afterVersion: null,
        diagnostic: short(`the command output could not be imported: ${describe(error)}`)
      };
    }
  }

  /** A durable result for a command that never ran or was refused. */
  private idleStage(outcome: 'denied' | 'cancelled', diagnostic: string): StageOutcome {
    return {
      finish: {
        outcome,
        import: 'not_started',
        afterVersion: null,
        exitCode: null,
        signal: null,
        output: '',
        truncated: false,
        drained: true,
        diagnostic: short(diagnostic)
      },
      drained: true,
      preserve: false
    };
  }

  /** Record and persist a setup/denied/cancelled failure, then release. */
  private async recordFailure(lease: RunnerLease, outcome: RunnerResultOutcome, diagnostic: string): Promise<RunnerCommandResult> {
    const stage: StageOutcome = {
      finish: {
        outcome,
        import: 'not_started',
        afterVersion: null,
        exitCode: null,
        signal: null,
        output: '',
        truncated: false,
        drained: true,
        diagnostic: short(diagnostic)
      },
      drained: true,
      preserve: false
    };
    return this.persist(lease, stage);
  }

  /** Persist the final result BEFORE releasing, then release the lease. */
  private async persist(lease: RunnerLease, stage: StageOutcome): Promise<RunnerCommandResult> {
    let result: RunnerCommandResult;
    try {
      result = await this.results.finish(lease.id, stage.finish);
    } catch (error) {
      // The final record is missing, so the durable pending attempt becomes
      // 'uncertain' on reload. Retain the directory and never replay.
      await this.releaseOrRetain(lease, {
        drained: stage.drained,
        preserve: true,
        diagnostic: short(`the final result could not be persisted: ${describe(error)}`, MAX_POOL_DIAGNOSTIC_LENGTH)
      }).catch(() => undefined);
      throw error;
    }
    const diagnostic = stage.finish.diagnostic;
    // The durable final record exists, so a release that cannot be published is
    // NOT a lost lease: it stays retained with this exact intent (and its slot)
    // and cleanup()/close() settle it once storage recovers.
    await this.releaseOrRetain(lease, {
      drained: stage.drained,
      ...(stage.preserve ? { preserve: true } : {}),
      ...(diagnostic === undefined ? {} : { diagnostic: short(diagnostic, MAX_POOL_DIAGNOSTIC_LENGTH) })
    });
    return result;
  }

  /**
   * Release after an unexpected failure. A recorded attempt (or a maybe-started
   * command) is quarantined; a failure before anything was recorded simply
   * discards the untouched lease.
   *
   * This runs when something OTHER than the release failed. When the lease
   * already carries a retained intent, the release itself is what failed and the
   * command's own outcome (and its exact drain proof) is authoritative: a generic
   * "did not complete" quarantine would silently weaken a proven drain into a
   * permanent preservation, so that intent is retried instead of replaced.
   */
  private async abandon(lease: RunnerLease, recorded: boolean, error: unknown): Promise<void> {
    const retained = this.retained.get(lease.id);
    if (retained !== undefined) {
      await this.releaseOrRetain(lease, retained.input).catch(() => undefined);
      return;
    }
    const diagnostic = short(`the command did not complete: ${describe(error)}`, MAX_POOL_DIAGNOSTIC_LENGTH);
    await this.releaseOrRetain(lease, recorded
      ? { drained: false, preserve: true, diagnostic }
      : { drained: true, diagnostic }).catch(() => undefined);
  }

  /**
   * Publish one release, or retain it when the durable write fails.
   *
   * A retained lease keeps its live pool record and slot, so a failed release is
   * never an orphan nobody can settle: the exact intent is retried by
   * reconcileRetained() from cleanup() and close(). Success clears any earlier
   * retention for the same lease (the pool's release is idempotent).
   */
  private async releaseOrRetain(lease: RunnerLease, input: RunnerLeaseRelease): Promise<void> {
    try {
      await lease.release(input);
      this.retained.delete(lease.id);
    } catch (error) {
      const previous = this.retained.get(lease.id);
      let intent: RunnerLeaseRelease = input;
      if (previous === undefined) {
        // Name the real cause once, so the durable record and the pool journal
        // explain a slot that stays busy while storage is failing.
        const cause = combine(input.diagnostic,
          short(`the lease release could not be persisted: ${describe(error)}`, MAX_POOL_DIAGNOSTIC_LENGTH));
        if (cause !== undefined) {
          intent = { ...input, diagnostic: cause };
        }
      }
      this.retained.set(lease.id, Object.freeze({ lease, input: mergeRelease(previous?.input, intent) }));
      throw error;
    }
  }

  /**
   * Retry retained failed releases, serially and at most ONCE per entry per call:
   * no retry loop, and the map is bounded by the pool's slot capacity because a
   * retained lease keeps consuming its slot.
   *
   * A `scope` restricts the retry to leases that lease itself owns for that
   * ownerId + teamId, so scoped cleanup can never settle — or surface a storage
   * error from — another owner's retention. close() passes no scope and retries
   * everything, because closing the handle must settle every lease it still owns.
   *
   * Only cleanup() and close() call this, after the owning command has settled, so
   * active work is never released. A settled lease is removed from the map; ANY
   * still-failing or unexpected release error (including missing durable metadata)
   * keeps the retained intent and is rethrown, so the caller reports the real
   * failure and never a placeholder success.
   */
  private async reconcileRetained(scope?: RunnerPoolScope): Promise<void> {
    const targets = [...this.retained].filter(([, entry]) => scope === undefined
      || (entry.lease.owner.ownerId === scope.ownerId && entry.lease.owner.teamId === scope.teamId));
    if (targets.length === 0) {
      return;
    }
    await this.retryMutex.run(async () => {
      let failure: unknown;
      for (const [id, entry] of targets) {
        try {
          await entry.lease.release(entry.input);
          this.retained.delete(id);
        } catch (error) {
          // No special cases: an error while settling is never proof that a live
          // slot or an unproven process may be forgotten, so the entry is kept and
          // the failure propagates until a later retry really settles it.
          failure = failure ?? error;
        }
      }
      if (failure !== undefined) {
        throw failure instanceof Error ? failure
          : new WorkerError('runner_execution_release_unsettled', `A retained lease release could not be settled: ${String(failure)}`);
      }
    });
  }

  /** Explicit cleanup proof: only a strict recorded identity may be recovered. */
  private async proveDrained(record: RunnerLeaseRecord): Promise<boolean> {
    const identity = recordedIdentity(record.process);
    if (identity === undefined) {
      return false;
    }
    try {
      const recovery = await recoverRunnerProcess(identity);
      return recovery.drained;
    } catch {
      return false;
    }
  }
}

/**
 * Normalize a logical path to a portable root-relative key. An absolute path is
 * accepted only when it sits inside the logical root, so a host can pass either
 * a logical path or an absolute project path; the live project is never used.
 */
function resolveLogicalKey(logicalRoot: string, requested: string | undefined): string {
  if (requested === undefined) {
    return '';
  }
  if (requested.includes('\0')) {
    invalidPath('A runner path cannot contain a NUL character.');
  }
  let relative = requested;
  if (path.isAbsolute(requested)) {
    const fromRoot = path.relative(logicalRoot, requested);
    if (fromRoot === '') {
      relative = '';
    } else if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      invalidPath(`The runner path ${requested} is outside the logical project root.`);
    } else {
      relative = fromRoot;
    }
  }
  const segments: string[] = [];
  for (const segment of relative.split(/[\\/]/u)) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      invalidPath('A runner path cannot traverse above the logical project root.');
    }
    segments.push(segment);
  }
  return segments.join('/');
}
