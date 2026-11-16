import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

/**
 * Physical runner execution: one shell command with a durable process
 * identity, bounded output, and a bounded, proven drain of its containment
 * before a result is returned. This is shell OS access (outside the Codex
 * sandbox), not a sandbox of its own.
 *
 * POSIX containment is a detached process group plus an inherited marker. The
 * root shell leads its own group, so descendants that outlive the shell stay
 * reachable, and every process started with the provided environment inherits
 * {@link RUNNER_DESCENDANT_MARKER_ENV}, holding a random per-run token.
 * Cleanup sends SIGTERM to the group, sweeps every process that carries the
 * marker, escalates to SIGKILL after a grace period, and only reports
 * `drained: true` once a bounded, complete scan of the marker owners has been
 * empty twice in a row and `kill(-pgid, 0)` proves the group is absent.
 *
 * The marker sweep is what catches an ordinary `detached: true` / setsid()
 * child: such a descendant leaves the group, so group absence alone used to
 * report a drained tree while the escapee kept running and writing. Discovery
 * is `/proc/<pid>/environ` on Linux and a `ps -E` listing on other POSIX
 * platforms, where a capability probe first proves that `ps` really prints
 * environments. That listing renders a process's arguments and its environment
 * into one block of text, so a marker-shaped token there can only make a
 * process a POSSIBLE owner: any such match is reported as an incomplete scan
 * and the run is quarantined instead of being signalled from ambiguous text.
 * Every kill is preceded by a creation-marker recheck and a marker recheck, so
 * a recycled pid is never signalled. When discovery is unavailable, denied,
 * ambiguous, or incomplete the result is `drained: false` and the caller must
 * quarantine the run: an empty marker set is never assumed.
 *
 * This is containment, not a sandbox. A descendant that deliberately scrubs
 * its own environment before spawning, or that is re-parented through a
 * mechanism that also drops the marker, is outside these guarantees. Ordinary
 * detached children are handled; containing a hostile command needs a real
 * sandbox.
 *
 * Windows containment is a Job Object owned by a source-inlined PowerShell
 * supervisor (no runtime asset file). The supervisor creates the command
 * suspended, assigns it to a non-inheritable job with
 * KILL_ON_JOB_CLOSE and no silent breakaway, then resumes it. Only that
 * supervisor process holds the job handle, so losing this host closes the job
 * and kills every member; on completion, cancellation, timeout, or a failed
 * start the supervisor calls TerminateJobObject and queries
 * JobObjectBasicAccountingInformation until the active process count reaches
 * zero, and the result is only `drained: true` when that count is provably 0.
 *
 * `authorize` is invoked synchronously immediately before the real command
 * spawn, after any awaited setup, so a revoked grant can never start work.
 *
 * A journaled identity is untrusted input when it comes back for recovery: it
 * is structurally typed but persisted as opaque JSON. Recovery therefore
 * validates it strictly first (current-host platform, usable pid, matching
 * supervisor kind, this runner's own job namespace or canonical group id, and
 * the exact generated marker variable/token shape) and reports
 * `uncertain` / `drained: false` instead of acting when anything is wrong, so
 * a corrupt record can never steer cleanup at unrelated processes. A POSIX
 * group whose leader is already gone is never signalled by group id: only the
 * validated per-candidate marker sweep may stop those processes, and the run is
 * reclaimed only when that sweep is complete and the group is then empty.
 */

/** Maximum characters of combined stdout/stderr retained on a result. */
export const RUNNER_OUTPUT_LIMIT = 100_000;

/**
 * Bound on the awaited `onStarted` journal hook. The hook must settle (durably
 * record, or fail) within this budget; a hook that does not settle is
 * abandoned so cancellation, timeouts, and cleanup can never be blocked by a
 * stuck journal. A late write from an abandoned hook must therefore be
 * idempotent and keyed to this run, so it can never overwrite another lease.
 */
export const RUNNER_JOURNAL_LIMIT_MS = 5_000;

const POSIX_TERM_GRACE_MS = 1_500;
const POSIX_VERIFY_MS = 5_000;
/** Hard bound on draining marked descendants after the group kill. */
const POSIX_SWEEP_BUDGET_MS = 6_000;
/** Full discovery rescan interval; polled pids are re-verified in between. */
const POSIX_SCAN_INTERVAL_MS = 200;
const POSIX_SWEEP_POLL_MS = 40;
/** Bound on a single discovery pass, so a slow process table cannot hang. */
const POSIX_SCAN_BUDGET_MS = 2_000;
const POSIX_PS_OUTPUT_LIMIT = 4_000_000;
const POSIX_PS_ARGS = ['-A', '-E', '-o', 'pid=,lstart=,command='];

/** Bytes of randomness in a Windows job token, rendered as lowercase hex. */
const WIN32_JOB_TOKEN_BYTES = 12;
/** Prefix of the job object namespace this runner creates for one run. */
const WIN32_JOB_PREFIX = 'Local\\codex-runner-';
/** Bytes of randomness in a POSIX descendant marker, rendered as lowercase hex. */
const POSIX_MARKER_BYTES = 16;
const POSIX_MARKER_LENGTH = POSIX_MARKER_BYTES * 2;
/**
 * Exact generated shape of a POSIX descendant marker token. Validation uses
 * the same length the generator uses, so a short, long, upper-case, or common
 * environment value can never be accepted as a run marker.
 */
const POSIX_MARKER_TOKEN = new RegExp(`^[0-9a-f]{${POSIX_MARKER_LENGTH}}$`);
const WIN32_JOB_TOKEN = new RegExp(`^[0-9a-f]{${WIN32_JOB_TOKEN_BYTES * 2}}$`);
/** Canonical string form of a process / process group id. */
const CANONICAL_PROCESS_ID = /^[1-9][0-9]*$/;
/** Numeric platform creation marker (Linux start time, Windows creation time). */
const NUMERIC_CREATION_MARKER = /^[0-9]+$/;
const STREAM_CLOSE_MS = 2_000;
const SUPERVISOR_SETUP_MS = 30_000;
const SUPERVISOR_RESULT_MS = 20_000;
const SUPERVISOR_EXIT_MS = 5_000;
const RECOVERY_TIMEOUT_MS = 30_000;
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'];

/** Durable description of the containment that owns a runner process tree. */
export interface RunnerSupervisorIdentity {
  /** Containment adapter that owns the tree. */
  kind: 'posix-process-group' | 'windows-job-object';
  /** POSIX process group id, or the Windows job object name. */
  name: string;
}

/**
 * Durable journal identity for a started run. `startMarker` is the platform
 * process creation marker, which makes a recycled pid detectable; an empty
 * marker means the identity cannot be proven and must stay quarantined.
 * `descendants` is present for POSIX runs, whose detached descendants are only
 * recoverable through the inherited marker it describes.
 */
export interface RunnerProcessIdentity {
  platform: NodeJS.Platform;
  pid: number;
  startMarker: string;
  supervisor: RunnerSupervisorIdentity;
  descendants?: RunnerDescendantMarker;
}

/** Bounded outcome of one shell command execution. */
export interface RunnerProcessResult {
  identity: RunnerProcessIdentity | null;
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /**
   * True only when the whole descendant tree is provably gone. Callers must
   * quarantine anything reported with `drained: false`.
   */
  drained: boolean;
  diagnostic?: string;
}

/** Input accepted by {@link runRunnerProcess}. */
export interface RunnerProcessInput {
  command: string;
  cwd: string;
  /**
   * Exact environment for the command. A POSIX run adds one internal variable
   * ({@link RUNNER_DESCENDANT_MARKER_ENV}) so descendants that leave the
   * process group stay discoverable; nothing else is added, removed, or
   * rewritten.
   */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  /** Synchronous policy gate, called immediately before the command spawn. */
  authorize: () => void;
  /** Awaited journal hook that records the durable identity of the run. */
  onStarted?: (identity: RunnerProcessIdentity) => Promise<void>;
}

/** Conservative outcome of a recovery attempt for a journaled identity. */
export interface RunnerProcessRecovery {
  status: 'terminated' | 'absent' | 'uncertain';
  drained: boolean;
  diagnostic?: string;
}

/**
 * Internal marker injected into a POSIX run's environment. It is never added
 * to this process's own environment: it exists so a descendant that leaves the
 * process group (an ordinary `detached: true` / setsid() child) is still
 * discoverable, killable, and provably gone before a result is returned.
 */
export const RUNNER_DESCENDANT_MARKER_ENV = 'CODEX_RUNNER_PROCESS_MARKER';

/** Durable marker identity, journaled so recovery can sweep the same tree. */
export interface RunnerDescendantMarker {
  /** Environment variable name that carries the marker. */
  envName: string;
  /** Random per-run token expected as that variable's value. */
  marker: string;
}

/** One process proven to carry a run's marker, with its creation marker. */
export interface MarkedProcessCandidate {
  pid: number;
  /** Platform creation marker; a mismatch means the pid was recycled. */
  startMarker: string;
}

/**
 * One process whose text merely *mentions* a run's marker, with its creation
 * marker. This is a possibility, never an ownership proof.
 *
 * The only source that produces it is the portable `ps` listing, whose trailing
 * `command` column merges a process's arguments with its environment, so an
 * unrelated command that happens to carry `envName=marker` as an argument is
 * indistinguishable from a real owner. Potential candidates are reported as an
 * incomplete scan and are never signalled.
 */
export interface PotentialMarkedProcessCandidate {
  pid: number;
  /** Platform creation marker; a mismatch means the pid was recycled. */
  startMarker: string;
}

/** Bounded result of one descendant discovery pass. */
export interface RunnerDescendantScan {
  /** False when discovery was unavailable, denied, partial, or over budget. */
  complete: boolean;
  processes: MarkedProcessCandidate[];
  diagnostic?: string;
}

/**
 * Platform operations the marker drain needs. The default implementation is
 * `/proc` (Linux) or `ps -E` (other POSIX); it is injectable so the drain loop
 * can be proven to never signal an unconfirmed process and never report a
 * drained tree for an incomplete scan.
 */
export interface RunnerDescendantControl {
  scan(marker: RunnerDescendantMarker): Promise<RunnerDescendantScan>;
  confirm(marker: RunnerDescendantMarker, candidate: MarkedProcessCandidate): Promise<boolean>;
  signal(pid: number, signal: NodeJS.Signals): void;
}

/**
 * Test-only overrides. Production code never sets these; the suites use them to
 * drive failures, post-completion teardown tails and platform facts that a real
 * host cannot be made to produce on demand.
 */
export interface RunnerContainmentSeams {
  /** Overrides for descendant discovery, confirmation and signalling. */
  control?: Partial<RunnerDescendantControl>;
  /**
   * Overrides for the portable (non-Linux POSIX) `ps` discovery: the host
   * platform that selects it, and the raw `ps -A -E` table it classifies. They
   * let a suite prove that path on a host that cannot produce such a table,
   * without running `ps` and without signalling anything. Production leaves
   * both undefined, so the real host and the real `ps` are always used.
   */
  portable?: {
    platform?: NodeJS.Platform;
    table?: () => string | undefined;
  };
  /**
   * Extra milliseconds of teardown tail, inserted only once a run has finished
   * AND its owned tree is proven gone. It lets a suite prove that a deadline or
   * a cancellation arriving during that tail can never relabel a finished
   * command. Production leaves it undefined, so there is no tail at all.
   */
  postCompletionDelayMs?: number;
  /**
   * Observation of the awaited Windows supervisor close/flush: `timeout` means
   * the close event never arrived inside the stream budget.
   */
  onSupervisorCloseWait?: (settled: 'settled' | 'timeout') => void;
  /**
   * Overrides for the POSIX recovery probes, so the leader-gone branch (which
   * needs a group whose leader already exited) can be driven on any host.
   */
  recovery?: {
    platform?: NodeJS.Platform;
    startMarker?: (pid: number) => Promise<string>;
    groupAlive?: (pgid: number) => boolean;
  };
}

export const runnerContainmentSeams: RunnerContainmentSeams = {};

/** Outcome of one marker drain. */
export interface RunnerDescendantDrain {
  drained: boolean;
  diagnostic?: string;
}

interface RunnerRunState {
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

interface RunnerExit {
  code: number | null;
  signal: string | null;
  error?: Error;
}

interface RunnerOutcome {
  identity?: RunnerProcessIdentity | null;
  exitCode: number | null;
  signal: string | null;
  drained: boolean;
  diagnostic?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

const delay = (ms: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, ms);
});

function appendOutput(state: RunnerRunState, chunk: Buffer | string): void {
  state.output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (state.output.length > RUNNER_OUTPUT_LIMIT) {
    state.output = state.output.slice(-RUNNER_OUTPUT_LIMIT);
    state.truncated = true;
  }
}

function outcome(state: RunnerRunState, base: RunnerOutcome): RunnerProcessResult {
  const result: RunnerProcessResult = {
    identity: base.identity ?? null,
    exitCode: base.exitCode,
    signal: base.signal,
    output: state.output,
    truncated: state.truncated,
    timedOut: base.timedOut ?? state.timedOut,
    cancelled: base.cancelled ?? state.cancelled,
    drained: base.drained
  };
  if (base.diagnostic !== undefined) {
    result.diagnostic = base.diagnostic;
  }
  return result;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Terminal-state latch for one run. `complete()` is called only once the
 * command AND every process it started are proven finished; after that a
 * deadline or a cancellation may no longer change the reported outcome,
 * because nothing but stdio flush and teardown remain. It deliberately does
 * nothing on its own: the caller clears its deadline timer in `onComplete`.
 *
 * The proof is observed INDEPENDENTLY of the journal hook: both adapters start
 * the completion observation before awaiting the (bounded) journal, so a
 * finished command is latched as soon as its full-tree proof arrives even while
 * the hook is still pending. The journal outcome is still awaited before the
 * result is returned, so a failed or abandoned hook always terminates the run
 * and fails the result instead of being reported as an early success.
 */
function completionLatch(onComplete: () => void): { complete: () => void; isComplete: () => boolean } {
  let complete = false;
  return {
    complete: () => {
      if (!complete) {
        complete = true;
        onComplete();
      }
    },
    isComplete: () => complete
  };
}

/**
 * Test-only teardown tail. It runs strictly after the whole owned tree is
 * proven gone, so it can never mask a live process; production has no tail.
 */
async function postCompletionTail(): Promise<void> {
  const extra = runnerContainmentSeams.postCompletionDelayMs;
  if (typeof extra === 'number' && extra > 0) {
    await delay(extra);
  }
}

/**
 * Awaits the journal hook with a hard bound. Returns `undefined` when the hook
 * recorded the identity, otherwise a diagnostic: rejection (the run is then
 * terminated) or an abandoned hook that never settled (also terminated, and
 * callers must tolerate one late, idempotent journal write).
 */
async function awaitJournal(hook: Promise<void>): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const abandoned = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), RUNNER_JOURNAL_LIMIT_MS);
  });
  try {
    const settled = await Promise.race([
      hook.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })),
      abandoned
    ]);
    if (settled === undefined) {
      return `journal hook did not settle within ${RUNNER_JOURNAL_LIMIT_MS} ms, so the run was terminated; a late journal write must be idempotent`;
    }
    return settled.ok ? undefined : `journal failed, so the run was terminated: ${describe(settled.error)}`;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForExit(child: ChildProcess | undefined, ms: number): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  const exited = new Promise<boolean>(resolve => {
    child.once('exit', () => resolve(true));
  });
  if (await withTimeout(exited, ms) === true) {
    return true;
  }
  try {
    child.kill();
  } catch {
    // The supervisor is already gone.
  }
  return await withTimeout(exited, STREAM_CLOSE_MS) === true;
}

/**
 * Runs one shell command in a supervised, drainable process tree.
 * Never returns before the descendant tree is either proven gone
 * (`drained: true`) or explicitly reported as unproven (`drained: false`).
 */
export async function runRunnerProcess(input: RunnerProcessInput): Promise<RunnerProcessResult> {
  const state: RunnerRunState = { output: '', truncated: false, timedOut: false, cancelled: false };
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    return outcome(state, {
      exitCode: null, signal: null, drained: true,
      diagnostic: 'invalid timeoutMs: the command was never started'
    });
  }
  if (input.signal.aborted) {
    return outcome(state, {
      exitCode: null, signal: null, drained: true, cancelled: true,
      diagnostic: 'cancelled before spawn: the command was never started'
    });
  }
  if (process.platform === 'win32') {
    return runWindows(input, state);
  }
  return runPosix(input, state);
}

function posixGroupAlive(pgid: number): boolean {
  if (pgid <= 1 || pgid === process.pid) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists but not ours": treat as still alive and unproven.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalPosixGroup(pgid: number, signal: NodeJS.Signals): void {
  if (pgid <= 1 || pgid === process.pid) {
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}

async function waitForGroupExit(
  pgid: number,
  ms: number,
  groupAlive: (pgid: number) => boolean = posixGroupAlive
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!groupAlive(pgid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(25);
  }
}

async function terminatePosixGroup(pgid: number): Promise<boolean> {
  if (!posixGroupAlive(pgid)) {
    return true;
  }
  signalPosixGroup(pgid, 'SIGTERM');
  if (await waitForGroupExit(pgid, POSIX_TERM_GRACE_MS)) {
    return true;
  }
  signalPosixGroup(pgid, 'SIGKILL');
  return waitForGroupExit(pgid, POSIX_VERIFY_MS);
}

/**
 * True when a NUL-separated environment block contains exactly
 * `envName=marker`. Entries are compared whole, so a suffixed value, a
 * prefixed name, or text that merely mentions the token can never claim
 * ownership of a process.
 */
export function environHasMarker(environ: Buffer | string, envName: string, marker: string): boolean {
  const text = typeof environ === 'string' ? environ : environ.toString('utf8');
  return text.split('\0').includes(`${envName}=${marker}`);
}

/**
 * Parses `ps -A -E -o pid=,lstart=,command=` output for processes whose text
 * mentions exactly `envName=marker` after the creation fields.
 *
 * This does NOT prove environment ownership. The trailing `command` column
 * renders a process's arguments and its environment as one space-separated
 * block, so an exact `envName=marker` there may be an ordinary argument of an
 * unrelated command (a diagnostic grep for the assignment, `env NAME=value
 * cmd`, ...), and a real owner looks identical. The result is therefore only a
 * list of potential matches; {@link environHasMarker} over
 * `/proc/<pid>/environ` stays the only environment-only proof this module has.
 * The portable `lstart` field is still captured as the creation identity, so a
 * recycled pid stays detectable on platforms without a /proc creation marker.
 */
export function parsePotentialMarkedProcessList(
  output: string,
  envName: string,
  marker: string
): PotentialMarkedProcessCandidate[] {
  const expected = `${envName}=${marker}`;
  const found: PotentialMarkedProcessCandidate[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    // pid, five lstart fields (dow mon day hh:mm:ss year), then the merged
    // argument + environment text that this parse cannot attribute.
    if (fields.length < 8) {
      continue;
    }
    const pid = Number(fields[0]);
    if (!Number.isInteger(pid) || pid <= 1) {
      continue;
    }
    if (!fields.slice(6).includes(expected)) {
      continue;
    }
    found.push({ pid, startMarker: fields.slice(1, 6).join(' ') });
  }
  return found;
}

function containmentControl(): RunnerDescendantControl {
  const overrides = runnerContainmentSeams.control ?? {};
  return {
    scan: overrides.scan ?? scanMarkedDescendants,
    confirm: overrides.confirm ?? confirmMarkedDescendant,
    signal: overrides.signal ?? signalMarkedProcess
  };
}

/** Facts the POSIX recovery needs; the real host unless a suite overrides them. */
interface RecoveryProbes {
  platform: NodeJS.Platform;
  startMarker: (pid: number) => Promise<string>;
  groupAlive: (pgid: number) => boolean;
}

function recoveryProbes(): RecoveryProbes {
  const overrides = runnerContainmentSeams.recovery ?? {};
  return {
    platform: overrides.platform ?? process.platform,
    startMarker: overrides.startMarker ?? posixStartMarker,
    groupAlive: overrides.groupAlive ?? posixGroupAlive
  };
}

function signalMarkedProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Platform that selects the discovery strategy: the real host unless a suite
 * pins the portable path through {@link RunnerContainmentSeams.portable}.
 */
function discoveryPlatform(): NodeJS.Platform {
  return runnerContainmentSeams.portable?.platform ?? process.platform;
}

function scanMarkedDescendants(marker: RunnerDescendantMarker): Promise<RunnerDescendantScan> {
  const platform = discoveryPlatform();
  if (platform === 'win32') {
    return Promise.resolve({
      complete: false, processes: [],
      diagnostic: 'the inherited marker is only discoverable on POSIX; no Windows process was inspected'
    });
  }
  return platform === 'linux' ? scanLinuxMarkedDescendants(marker) : scanPortableMarkedDescendants(marker);
}

function confirmMarkedDescendant(marker: RunnerDescendantMarker, candidate: MarkedProcessCandidate): Promise<boolean> {
  const platform = discoveryPlatform();
  if (platform === 'win32') {
    return Promise.resolve(false);
  }
  return platform === 'linux'
    ? confirmLinuxMarkedDescendant(marker, candidate)
    : confirmPortableMarkedDescendant();
}

/** Linux discovery: `/proc/<pid>/environ` for every process of this user. */
async function scanLinuxMarkedDescendants(target: RunnerDescendantMarker): Promise<RunnerDescendantScan> {
  let entries: string[];
  try {
    entries = await fs.readdir('/proc');
  } catch (error) {
    return { complete: false, processes: [], diagnostic: `/proc is unreadable: ${describe(error)}` };
  }
  const deadline = Date.now() + POSIX_SCAN_BUDGET_MS;
  const processes: MarkedProcessCandidate[] = [];
  const unreadable: number[] = [];
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    if (pid <= 1 || pid === process.pid) {
      continue;
    }
    if (Date.now() > deadline) {
      return {
        complete: false, processes: [],
        diagnostic: `the process table exceeded the ${POSIX_SCAN_BUDGET_MS} ms scan budget`
      };
    }
    let environ: Buffer;
    try {
      environ = await fs.readFile(`/proc/${pid}/environ`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') {
        // The process exited while the table was being scanned.
        continue;
      }
      if (await isForeignProcess(pid)) {
        // Another user's process. Every run-owned descendant inherits this
        // user's identity, so this entry cannot belong to the run.
        continue;
      }
      if (unreadable.length < 5) {
        unreadable.push(pid);
      }
      continue;
    }
    if (!environHasMarker(environ, target.envName, target.marker)) {
      continue;
    }
    const startMarker = await posixStartMarker(pid);
    if (startMarker.length === 0) {
      return {
        complete: false, processes: [],
        diagnostic: `process ${pid} carries the run marker but its creation marker is unreadable`
      };
    }
    processes.push({ pid, startMarker });
  }
  if (unreadable.length > 0) {
    return {
      complete: false, processes: [],
      diagnostic: `the environment of this user's process ${unreadable.join(', ')} could not be read, so the scan is incomplete`
    };
  }
  return { complete: true, processes };
}

async function isForeignProcess(pid: number): Promise<boolean> {
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
  if (euid === undefined) {
    return false;
  }
  try {
    const stats = await fs.stat(`/proc/${pid}`);
    return stats.uid !== euid;
  } catch {
    return false;
  }
}

async function confirmLinuxMarkedDescendant(target: RunnerDescendantMarker, candidate: MarkedProcessCandidate): Promise<boolean> {
  const startMarker = await posixStartMarker(candidate.pid);
  if (startMarker.length === 0 || startMarker !== candidate.startMarker) {
    // Gone, or the pid now belongs to a different process.
    return false;
  }
  try {
    const environ = await fs.readFile(`/proc/${candidate.pid}/environ`);
    return environHasMarker(environ, target.envName, target.marker);
  } catch {
    return false;
  }
}

function runPs(args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    let child: ChildProcess;
    try {
      child = spawn('ps', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(undefined);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const stop = (): void => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(undefined);
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > POSIX_PS_OUTPUT_LIMIT) {
        stop();
      }
    });
    child.once('error', () => finish(undefined));
    child.once('close', () => finish(output));
  });
}

/**
 * A known variable of this process, formatted the way `ps -E` prints it. Used
 * as a capability probe: a `ps` that silently omits environments must be
 * reported as unavailable rather than as an empty (drained) result.
 */
function portableEnvironmentProbe(): string | undefined {
  for (const name of ['HOME', 'PATH', 'USER', 'LOGNAME']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length >= 4 && !/\s/.test(value)) {
      return `${name}=${value}`;
    }
  }
  return undefined;
}

/**
 * Reads the raw portable `ps -A -E -o pid=,lstart=,command=` table: the real
 * `ps` unless a suite supplies one through
 * {@link RunnerContainmentSeams.portable}. `undefined` means no table could be
 * read, which is never treated as emptiness.
 */
async function readPortableProcessTable(): Promise<string | undefined> {
  const override = runnerContainmentSeams.portable?.table;
  if (override !== undefined) {
    try {
      return override();
    } catch {
      return undefined;
    }
  }
  return runPs(POSIX_PS_ARGS, POSIX_SCAN_BUDGET_MS);
}

/**
 * Classifies one portable `ps` table. This is the whole portable discovery
 * decision, kept separate from reading the table so it can be proven on a host
 * that cannot produce one.
 *
 * `ps -E -o pid,lstart,command` merges a process's arguments with its
 * environment, so a marker-shaped token there cannot be attributed to the
 * environment: an unrelated command that merely carries `envName=marker` as an
 * argument is exactly as likely as a real owner. A match therefore only makes
 * the process a POSSIBLE owner, and this path never affirms ownership.
 *
 * Consequences, all deliberate:
 * - a probed table with any potential match (other than this process itself) is
 *   reported as INCOMPLETE, so the drain stays unproven and the run is
 *   quarantined instead of being signalled from ambiguous text;
 * - only a probed table with no potential match at all still establishes
 *   emptiness under the existing contract;
 * - a missing capability probe, a missing own-process row, or a missing table
 *   stays incomplete, because an unproven `ps` must never look like emptiness.
 */
export function portableScanResult(
  table: string,
  target: RunnerDescendantMarker,
  ownPid: number,
  probe: string | undefined
): RunnerDescendantScan {
  const own = table.split('\n').find(line => Number(line.trim().split(/\s+/)[0]) === ownPid);
  if (probe === undefined || own === undefined || !own.includes(probe)) {
    return {
      complete: false, processes: [],
      diagnostic: 'ps did not report process environments, so descendants cannot be enumerated'
    };
  }
  const potential = parsePotentialMarkedProcessList(table, target.envName, target.marker)
    .filter(entry => entry.pid !== ownPid);
  if (potential.length > 0) {
    const shown = potential.slice(0, 5).map(entry => entry.pid).join(', ');
    return {
      complete: false, processes: [],
      diagnostic: `ps reports a process's arguments and its environment as one block of text, so ${potential.length}`
        + ` potential marker match(es) (pid ${shown}) cannot be proven to carry the run marker in their environment;`
        + ' the run must be quarantined rather than signalled from that text'
    };
  }
  return { complete: true, processes: [] };
}

/** Other POSIX discovery: a `ps -E` listing gated by a capability probe. */
async function scanPortableMarkedDescendants(target: RunnerDescendantMarker): Promise<RunnerDescendantScan> {
  const output = await readPortableProcessTable();
  if (output === undefined) {
    return { complete: false, processes: [], diagnostic: 'ps could not list the process table' };
  }
  return portableScanResult(output, target, process.pid, portableEnvironmentProbe());
}

/**
 * Portable confirmation. The only portable evidence is the same merged
 * argument + environment text that produced the possibility, so re-reading it
 * can never turn a possibility into proof: this refuses unconditionally and
 * takes no evidence to weigh, because no environment-only source exists here.
 *
 * A portable candidate is therefore never signalled. Escaped descendants on a
 * non-Linux POSIX host need environment-specific proof (an equivalent of
 * `/proc/<pid>/environ`), which this adapter does not have, so they stay
 * quarantined instead of being killed from ambiguous text.
 */
async function confirmPortableMarkedDescendant(): Promise<boolean> {
  return false;
}

/**
 * Drains every process carrying a run's marker, including descendants that left
 * the process group. Only a complete scan is trusted, the owned set must be
 * empty on two consecutive complete scans, and a pid is re-verified right
 * before it is signalled, so a recycled id is never touched.
 */
export async function drainMarkedDescendants(marker: RunnerDescendantMarker): Promise<RunnerDescendantDrain> {
  // A marker that this runner could not have generated is never used as a
  // discovery key, so no unrelated process can be scanned, matched, or killed.
  const invalid = markerDiagnostic(marker);
  if (invalid !== undefined) {
    return {
      drained: false,
      diagnostic: `refusing to drain descendants: ${invalid}, so no process was inspected; the run must be quarantined`
    };
  }
  const control = containmentControl();
  const deadline = Date.now() + POSIX_SWEEP_BUDGET_MS;
  const escalateAt = Date.now() + POSIX_TERM_GRACE_MS;
  let known: MarkedProcessCandidate[] = [];
  let nextScan = 0;
  let emptyScans = 0;
  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      return {
        drained: false,
        diagnostic: `the run's detached descendants could not be proven gone within ${POSIX_SWEEP_BUDGET_MS} ms (${known.length} still reported); the run must be quarantined`
      };
    }
    const signal: NodeJS.Signals = now >= escalateAt ? 'SIGKILL' : 'SIGTERM';
    if (now >= nextScan) {
      const scan = await control.scan(marker);
      nextScan = Date.now() + POSIX_SCAN_INTERVAL_MS;
      if (!scan.complete) {
        return {
          drained: false,
          diagnostic: `descendant discovery is unavailable or incomplete (${scan.diagnostic ?? 'no detail'}), so the tree cannot be proven drained; the run must be quarantined`
        };
      }
      known = scan.processes;
      emptyScans = known.length === 0 ? emptyScans + 1 : 0;
      if (emptyScans >= 2) {
        return { drained: true };
      }
    }
    for (const candidate of known) {
      if (!(await control.confirm(marker, candidate))) {
        // Gone, or the pid now belongs to a process this run never owned.
        continue;
      }
      control.signal(candidate.pid, signal);
    }
    await delay(POSIX_SWEEP_POLL_MS);
  }
}

/**
 * Drains the whole POSIX tree: the process group first, then every marked
 * descendant, and only reports a drained tree when the group is absent and the
 * marker sweep proved complete emptiness.
 */
async function drainPosixTree(pgid: number, marker: RunnerDescendantMarker): Promise<RunnerDescendantDrain> {
  const groupGone = await terminatePosixGroup(pgid);
  const sweep = await drainMarkedDescendants(marker);
  if (!sweep.drained) {
    return { drained: false, diagnostic: sweep.diagnostic };
  }
  if (!groupGone && posixGroupAlive(pgid)) {
    return { drained: false, diagnostic: 'the process group survived SIGKILL, so the tree is unproven' };
  }
  return { drained: true };
}

/**
 * Extracts field 22 (`starttime`, clock ticks since boot) from a
 * `/proc/<pid>/stat` line. The comm field is parenthesised and may itself
 * contain spaces or parentheses, so parsing resumes after the last `)`.
 */
export function parseProcStartTime(stat: string): string {
  const end = stat.lastIndexOf(')');
  if (end < 0) {
    return '';
  }
  // After the comm field, index 0 is field 3 (state); starttime is field 22.
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  return fields[19] ?? '';
}

async function posixStartMarker(pid: number): Promise<string> {
  if (process.platform !== 'linux') {
    return '';
  }
  try {
    return parseProcStartTime(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return '';
  }
}

async function runPosix(input: RunnerProcessInput, state: RunnerRunState): Promise<RunnerProcessResult> {
  try {
    input.authorize();
  } catch (error) {
    return outcome(state, {
      exitCode: null, signal: null, drained: true,
      diagnostic: `authorize failed: the command was never started: ${describe(error)}`
    });
  }
  if (input.signal.aborted) {
    return outcome(state, {
      exitCode: null, signal: null, drained: true, cancelled: true,
      diagnostic: 'cancelled before spawn: the command was never started'
    });
  }
  const marker: RunnerDescendantMarker = {
    envName: RUNNER_DESCENDANT_MARKER_ENV,
    marker: randomBytes(POSIX_MARKER_BYTES).toString('hex')
  };
  let child: ChildProcess;
  try {
    child = spawn('/bin/sh', ['-c', input.command], {
      cwd: input.cwd,
      // The provided environment is otherwise passed through untouched: only
      // the internal containment marker is added, so a descendant that leaves
      // the process group is still discoverable and drainable.
      env: { ...input.env, [marker.envName]: marker.marker },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    return outcome(state, {
      exitCode: null, signal: null, drained: true,
      diagnostic: `spawn failed: the command was never started: ${describe(error)}`
    });
  }
  const exited = new Promise<RunnerExit>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error: Error) => resolve({ code: null, signal: null, error }));
  });
  const closed = new Promise<void>(resolve => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  child.stdout?.on('data', (chunk: Buffer) => appendOutput(state, chunk));
  child.stderr?.on('data', (chunk: Buffer) => appendOutput(state, chunk));
  const pid = child.pid;
  let termination: Promise<RunnerDescendantDrain> | undefined;
  const startTermination = (): Promise<RunnerDescendantDrain> => {
    if (!termination) {
      termination = typeof pid === 'number'
        ? drainPosixTree(pid, marker)
        : Promise.resolve({ drained: true });
    }
    return termination;
  };
  let timer: NodeJS.Timeout | undefined;
  // The deadline and cancellation stay live for as long as any owned process is
  // still running, and are latched shut by the proof that the whole tree is
  // gone. Freezing at the leader's exit instead would mislabel a run whose
  // background descendants are still draining, so this is the only place the
  // timer is cleared.
  const latch = completionLatch(() => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  });
  const onAbort = (): void => {
    if (latch.isComplete()) {
      return;
    }
    state.cancelled = true;
    void startTermination();
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    let identity: RunnerProcessIdentity | null = null;
    let journalError: string | undefined;
    if (typeof pid === 'number') {
      timer = setTimeout(() => {
        if (latch.isComplete()) {
          // The owned tree was already proven gone: only stdio flush is left.
          return;
        }
        state.timedOut = true;
        void startTermination();
      }, input.timeoutMs);
    }
    // The exit -> full-tree-drain pipeline runs CONCURRENTLY with the journal
    // hook: the shell can exit and its whole owned tree can be proven gone long
    // before a slow (but still bounded) journal settles, and only that proof
    // latches the deadline shut. Awaiting the journal first kept the deadline
    // armed against a command that had already finished, so a finished run could
    // be relabelled as a timeout by its own journal latency.
    // Even a clean shell exit drains here: background descendants stay in the
    // group, and a descendant that left the group with setsid() is found
    // through the inherited marker. The tree is only released once the group
    // is provably absent and the marker sweep proved an empty owned set twice.
    const pipeline = (async (): Promise<{ exit: RunnerExit; drain: RunnerDescendantDrain }> => {
      const exit = await exited;
      const drain = await startTermination();
      // The drain is what keeps the deadline and cancellation live while any
      // owned descendant still runs. Only its success proves the tree empty, so
      // only that latches the terminal state: from here on the remaining work is
      // stdout flush, which is not part of the command.
      if (drain.drained) {
        latch.complete();
      }
      return { exit, drain };
    })();
    // Joined below, after the journal outcome; this only closes the window in
    // which a failing pipeline would be momentarily unobserved.
    void pipeline.catch(() => undefined);
    if (typeof pid === 'number') {
      identity = {
        platform: process.platform,
        pid,
        startMarker: await posixStartMarker(pid),
        supervisor: { kind: 'posix-process-group', name: String(pid) },
        descendants: marker
      };
      if (input.onStarted) {
        journalError = await awaitJournal(input.onStarted(identity));
        if (journalError !== undefined) {
          void startTermination();
        }
      }
    }
    // Joined only after the journal outcome, so a failed or hung journal still
    // terminates the run and fails the result.
    const { exit, drain } = await pipeline;
    await postCompletionTail();
    await withTimeout(closed, STREAM_CLOSE_MS);
    child.stdout?.destroy();
    child.stderr?.destroy();
    const problems: string[] = [];
    if (journalError !== undefined) {
      problems.push(journalError);
    }
    if (drain.diagnostic !== undefined) {
      problems.push(drain.diagnostic);
    }
    if (exit.error) {
      problems.push(`spawn failed: ${describe(exit.error)}`);
    }
    const diagnostic = problems.length === 0 ? undefined : problems.join('; ');
    return outcome(state, { identity, exitCode: exit.code, signal: exit.signal, drained: drain.drained, diagnostic });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    input.signal.removeEventListener('abort', onAbort);
  }
}

const OUTPUT_DIAGNOSTIC_LIMIT = 1_000;

const powershellPath = (): string => {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
};

const windowsShell = (): string => process.env.ComSpec ?? 'cmd.exe';

/**
 * Encodes an environment block for the supervisor: `key\0value\0...` in UTF-8,
 * base64 encoded. Environment keys and values cannot contain NUL, so the
 * separator is unambiguous, and no control text has to be JSON-escaped twice.
 */
function encodeEnvironment(env: NodeJS.ProcessEnv): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.length === 0 || key.includes('\0') || key.includes('=') || value.includes('\0')) {
      continue;
    }
    parts.push(key, value);
  }
  return Buffer.from(parts.join('\0'), 'utf8').toString('base64');
}

type ChannelRead =
  | { kind: 'line'; line: string }
  | { kind: 'closed' }
  | { kind: 'timeout' };

/**
 * Newline-delimited JSON control channel to a Windows supervisor. This process
 * is the pipe server and the supervisor connects to it, so a lost host closes
 * the channel and the supervisor drains its job instead of orphaning children.
 */
class SupervisorChannel {
  private readonly server: net.Server;
  private socket: net.Socket | undefined;
  private readonly queued: string[] = [];
  private waiting: ((read: ChannelRead) => void)[] = [];
  private closed = false;

  constructor(private readonly pipePath: string) {
    this.server = net.createServer(socket => this.attach(socket));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.pipePath, () => {
        this.server.removeListener('error', onError);
        resolve();
      });
    });
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        this.push(buffer.slice(0, index).trim());
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => this.push(undefined));
    socket.on('error', () => undefined);
  }

  private push(line: string | undefined): void {
    if (line === undefined) {
      this.closed = true;
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(line === undefined ? { kind: 'closed' } : { kind: 'line', line });
      return;
    }
    if (line !== undefined) {
      this.queued.push(line);
    }
  }

  next(ms: number): Promise<ChannelRead> {
    const ready = this.queued.shift();
    if (ready !== undefined) {
      return Promise.resolve({ kind: 'line', line: ready });
    }
    if (this.closed) {
      return Promise.resolve({ kind: 'closed' });
    }
    return new Promise<ChannelRead>(resolve => {
      const settle = (read: ChannelRead): void => {
        clearTimeout(timer);
        resolve(read);
      };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter(entry => entry !== settle);
        resolve({ kind: 'timeout' });
      }, ms);
      this.waiting.push(settle);
    });
  }

  send(message: unknown): void {
    try {
      this.socket?.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Loss of control is reported through the next read.
    }
  }

  close(): void {
    this.push(undefined);
    try {
      this.socket?.destroy();
    } catch {
      // Already closed.
    }
    try {
      this.server.close();
    } catch {
      // Already closed.
    }
  }
}

interface SupervisorMessage {
  type: string;
  pid?: number;
  creationTime?: string;
  exitCode?: number | null;
  activeProcesses?: number;
  terminated?: boolean;
  code?: string;
  detail?: number;
}

/**
 * Outcome of the one final control read: the supervisor's `result`, or the
 * reason no usable result was ever reported (the tree is then unproven).
 */
type WindowsFinalRead =
  | { readonly kind: 'result'; readonly message: SupervisorMessage }
  | { readonly kind: 'lost'; readonly detail: string };

function parseSupervisorMessage(line: string): SupervisorMessage {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as SupervisorMessage;
    }
  } catch {
    // Reported as an invalid control message by the caller.
  }
  return { type: 'invalid' };
}

interface RecoveryVerdict {
  status?: string;
  detail?: string;
  activeProcesses?: number;
}

function parseRecoveryVerdict(line: string): RecoveryVerdict {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object') {
      return parsed as RecoveryVerdict;
    }
  } catch {
    // Treated as "no verdict" by the caller.
  }
  return {};
}

async function runWindows(input: RunnerProcessInput, state: RunnerRunState): Promise<RunnerProcessResult> {
  const token = randomBytes(WIN32_JOB_TOKEN_BYTES).toString('hex');
  const pipeName = `codex-runner-${token}-ctl`;
  const jobName = `${WIN32_JOB_PREFIX}${token}`;
  const channel = new SupervisorChannel(`\\\\.\\pipe\\${pipeName}`);
  let supervisor: ChildProcess | undefined;
  let diagnostics = '';
  const noteDiagnostic = (chunk: Buffer): void => {
    diagnostics = `${diagnostics}${chunk.toString('utf8')}`;
    if (diagnostics.length > OUTPUT_DIAGNOSTIC_LIMIT) {
      diagnostics = diagnostics.slice(-OUTPUT_DIAGNOSTIC_LIMIT);
    }
  };
  const stderrNote = (): string => (diagnostics.trim().length > 0 ? `: ${diagnostics.trim().slice(-OUTPUT_DIAGNOSTIC_LIMIT)}` : '');
  let timer: NodeJS.Timeout | undefined;
  let startSent = false;
  let terminating = false;
  // The deadline and cancellation stay live for as long as the job can still
  // hold a process, and are latched shut by the supervisor's proof that the job
  // is empty. A run that is merely being torn down is already finished.
  const latch = completionLatch(() => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  });
  const sendTerminate = (): void => {
    if (startSent && !terminating) {
      terminating = true;
      channel.send({ type: 'terminate' });
    }
  };
  const onAbort = (): void => {
    if (latch.isComplete()) {
      return;
    }
    state.cancelled = true;
    if (startSent) {
      sendTerminate();
    } else {
      // Closing before the start request makes the supervisor exit without
      // creating any process, so a cancelled run really runs nothing.
      channel.close();
    }
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  // Set only once a supervisor really exists. Its `close` event is what proves
  // the command's inherited stdio has been flushed to this process, and an
  // `error` event before that must settle the wait rather than leave a promise
  // nobody can resolve.
  let supervisorClosed: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopping) {
      stopping = (async () => {
        channel.close();
        await waitForExit(supervisor, SUPERVISOR_EXIT_MS);
        if (supervisorClosed !== undefined) {
          const settled = await withTimeout(supervisorClosed.then(() => true as const), STREAM_CLOSE_MS);
          runnerContainmentSeams.onSupervisorCloseWait?.(settled === true ? 'settled' : 'timeout');
        }
      })();
    }
    return stopping;
  };
  try {
    try {
      await channel.listen();
    } catch (error) {
      channel.close();
      return outcome(state, {
        exitCode: null, signal: null, drained: true,
        diagnostic: `windows supervisor control pipe failed: ${describe(error)}`
      });
    }
    try {
      supervisor = spawn(powershellPath(), POWERSHELL_ARGS, {
        env: { ...process.env, RUNNER_MODE: 'run', RUNNER_PIPE: pipeName, RUNNER_JOB: jobName },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      channel.close();
      return outcome(state, {
        exitCode: null, signal: null, drained: true,
        diagnostic: `windows supervisor failed to start: ${describe(error)}`
      });
    }
    supervisor.on('error', () => undefined);
    // Attach to the supervisor that really exists, immediately after the spawn:
    // its `close` event carries the flushed stdio of the command, and an early
    // `error` settles the wait instead of leaving it unresolved.
    const spawned = supervisor;
    supervisorClosed = new Promise<void>(resolve => {
      spawned.once('close', () => resolve());
      spawned.once('error', () => resolve());
    });
    // The command's own stdout/stderr are the supervisor's inherited handles,
    // so this copy is the runner output as well as supervisor diagnostics.
    supervisor.stdout?.on('data', (chunk: Buffer) => appendOutput(state, chunk));
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      appendOutput(state, chunk);
      noteDiagnostic(chunk);
    });
    supervisor.stdin?.end(WINDOWS_SUPERVISOR_SCRIPT);
    const supervisorGone = new Promise<ChannelRead>(resolve => {
      supervisor?.once('exit', () => resolve({ kind: 'closed' }));
    });
    const hello = await Promise.race([channel.next(SUPERVISOR_SETUP_MS), supervisorGone]);
    if (hello.kind !== 'line' || parseSupervisorMessage(hello.line).type !== 'ready') {
      await stop();
      return outcome(state, {
        exitCode: null, signal: null, drained: true,
        diagnostic: `windows supervisor did not become ready${stderrNote()}`
      });
    }
    try {
      input.authorize();
    } catch (error) {
      await stop();
      return outcome(state, {
        exitCode: null, signal: null, drained: true,
        diagnostic: `authorize failed: the command was never started: ${describe(error)}`
      });
    }
    if (input.signal.aborted) {
      await stop();
      return outcome(state, {
        exitCode: null, signal: null, drained: true, cancelled: true,
        diagnostic: 'cancelled before spawn: the command was never started'
      });
    }
    startSent = true;
    channel.send({ type: 'start', shell: windowsShell(), command: input.command, cwd: input.cwd, env: encodeEnvironment(input.env) });
    timer = setTimeout(() => {
      if (latch.isComplete()) {
        // The job was already proven empty: only stdio flush is left.
        return;
      }
      state.timedOut = true;
      sendTerminate();
    }, input.timeoutMs);
    const launched = await channel.next(SUPERVISOR_SETUP_MS);
    if (launched.kind !== 'line') {
      await stop();
      return outcome(state, {
        exitCode: null, signal: null, drained: false,
        diagnostic: 'windows supervisor was lost while starting the command; the tree is unproven'
      });
    }
    const startMessage = parseSupervisorMessage(launched.line);
    if (startMessage.type === 'error') {
      // The supervisor proves how many processes it left attached after its own
      // bounded cleanup. Only an explicitly empty job may be reported drained;
      // an unproven (or still-populated) job must be quarantined by the caller.
      const provenEmpty = startMessage.activeProcesses === 0;
      const detail = `windows supervisor could not start the command: ${startMessage.code ?? 'unknown'} (${startMessage.detail ?? 0})`;
      await stop();
      return outcome(state, {
        exitCode: null, signal: null, drained: provenEmpty,
        diagnostic: provenEmpty ? detail : `${detail}; the tree is unproven and must be quarantined`
      });
    }
    if (startMessage.type !== 'started' || typeof startMessage.pid !== 'number') {
      await stop();
      return outcome(state, {
        exitCode: null, signal: null, drained: false,
        diagnostic: `windows supervisor returned an unexpected start message: ${launched.line}`
      });
    }
    const identity: RunnerProcessIdentity = {
      platform: 'win32',
      pid: startMessage.pid,
      startMarker: startMessage.creationTime ?? '',
      supervisor: { kind: 'windows-job-object', name: jobName }
    };
    // The final control result carries the supervisor's proof that the job is
    // empty, and it is read CONCURRENTLY with the journal hook: a supervisor can
    // report an empty job long before a slow (but still bounded) journal
    // settles, and that proof is what latches the deadline and cancellation
    // shut. Reading it only after the hook kept the deadline armed against a
    // command that had already finished, so a finished run could be relabelled
    // as a timeout by its own journal latency.
    const readFinal = async (): Promise<WindowsFinalRead> => {
      const finished = await channel.next(input.timeoutMs + SUPERVISOR_RESULT_MS);
      if (finished.kind !== 'line') {
        return { kind: 'lost', detail: 'windows supervisor ended before reporting job drainage; the tree is unproven' };
      }
      const message = parseSupervisorMessage(finished.line);
      if (message.type !== 'result') {
        return { kind: 'lost', detail: `windows supervisor returned an unexpected result: ${finished.line}` };
      }
      if (message.activeProcesses === 0) {
        // The supervisor proves the job empty before it reports, so this is the
        // completion proof: latch the terminal state HERE, while the journal
        // hook may still be pending. A job that still holds processes is not
        // latched, because it is still running and its deadline and
        // cancellation must stay live.
        latch.complete();
      }
      return { kind: 'result', message };
    };
    const finalRead = readFinal();
    // The read is joined below, after the journal outcome. This handler only
    // closes the window in which a failing read would be momentarily unobserved.
    void finalRead.catch(() => undefined);
    let journalError: string | undefined;
    if (input.onStarted) {
      journalError = await awaitJournal(input.onStarted(identity));
      if (journalError !== undefined) {
        sendTerminate();
      }
    }
    // Joined only after the journal outcome, so a failed or hung journal still
    // terminates the run and fails the result, and the final control message is
    // never left unconsumed.
    const final = await finalRead;
    if (final.kind === 'lost') {
      await stop();
      return outcome(state, {
        identity, exitCode: null, signal: null, drained: false,
        diagnostic: journalError ?? final.detail
      });
    }
    const finalMessage = final.message;
    const drained = finalMessage.activeProcesses === 0;
    const diagnostic = journalError ?? (drained
      ? undefined
      : `windows job still holds ${finalMessage.activeProcesses ?? 'an unknown number of'} process(es) after cleanup`);
    // The command's output reaches us through the supervisor's own stdout, so
    // the final bytes can arrive after the control-channel result. Flush that
    // stream before composing the result, or a fast command loses its tail.
    await postCompletionTail();
    await stop();
    return outcome(state, {
      identity,
      exitCode: finalMessage.exitCode ?? null,
      // Windows has no POSIX-style exit signal; a terminated run reports null.
      signal: null,
      drained,
      diagnostic
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    input.signal.removeEventListener('abort', onAbort);
    await stop();
  }
}

/**
 * Rejects a descendant marker that this runner could not have generated. A
 * journaled marker reaches recovery as opaque JSON, so a corrupt or hostile
 * value such as `PATH=/usr/bin:/bin` must never be used as a discovery key: it
 * would match unrelated processes. Only the exact internal variable name and
 * the exact generated token shape are accepted.
 */
function markerDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return 'the descendant marker is not an object';
  }
  const record = value as { envName?: unknown; marker?: unknown };
  if (record.envName !== RUNNER_DESCENDANT_MARKER_ENV) {
    return `the descendant marker variable must be ${RUNNER_DESCENDANT_MARKER_ENV}`;
  }
  if (typeof record.marker !== 'string' || !POSIX_MARKER_TOKEN.test(record.marker)) {
    return `the descendant marker token is not this runner's generated ${POSIX_MARKER_LENGTH}-character random value`;
  }
  return undefined;
}

/**
 * Strict runtime validation of a journaled identity, applied before any
 * discovery, signalling, or supervisor spawn. The identity is structurally
 * typed but arrives from opaque persisted JSON, so it must be proven to belong
 * to this host, this runner's supervisor namespace, and this runner's own token
 * shape before cleanup is allowed to touch anything.
 */
function identityDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return 'the recorded identity is not an object';
  }
  const record = value as {
    platform?: unknown;
    pid?: unknown;
    startMarker?: unknown;
    supervisor?: unknown;
    descendants?: unknown;
  };
  const hostPlatform = recoveryProbes().platform;
  if (record.platform !== hostPlatform) {
    return `the recorded identity is for ${String(record.platform)} but this host is ${hostPlatform}`;
  }
  const pid = record.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return `the recorded pid is not a usable process id (${String(pid)})`;
  }
  if (typeof record.startMarker !== 'string') {
    return 'the recorded start marker is not a string';
  }
  const supervisor = record.supervisor;
  if (typeof supervisor !== 'object' || supervisor === null) {
    return 'the recorded supervisor is not an object';
  }
  const kind = (supervisor as { kind?: unknown }).kind;
  const name = (supervisor as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    return 'the recorded supervisor has no containment name';
  }
  if (hostPlatform === 'win32') {
    if (kind !== 'windows-job-object') {
      return `a win32 identity must use a windows-job-object supervisor, not ${String(kind)}`;
    }
    if (!name.startsWith(WIN32_JOB_PREFIX) || !WIN32_JOB_TOKEN.test(name.slice(WIN32_JOB_PREFIX.length))) {
      return `the recorded job object is not in this runner's own ${WIN32_JOB_PREFIX}<token> namespace`;
    }
    if (!NUMERIC_CREATION_MARKER.test(record.startMarker)) {
      return 'a win32 identity needs a non-empty numeric process creation marker';
    }
    return undefined;
  }
  if (kind !== 'posix-process-group') {
    return `a POSIX identity must use a posix-process-group supervisor, not ${String(kind)}`;
  }
  if (!CANONICAL_PROCESS_ID.test(name) || name !== String(pid)) {
    return `the recorded process group name is not the canonical group id (${name})`;
  }
  if (record.startMarker.length > 0 && !NUMERIC_CREATION_MARKER.test(record.startMarker)) {
    return 'a POSIX start marker must be empty or numeric';
  }
  if (record.descendants !== undefined) {
    const descendants = markerDiagnostic(record.descendants);
    if (descendants !== undefined) {
      return descendants;
    }
  }
  return undefined;
}

const invalidIdentity = (reason: string): RunnerProcessRecovery => ({
  status: 'uncertain', drained: false,
  diagnostic: `invalid recorded process identity: ${reason}; the run stays quarantined`
});

/**
 * Conservative recovery for a journaled identity. The record is strictly
 * validated first, then only a process whose identity is confirmed (matching
 * start marker, or a live job object recorded for that exact run) is killed;
 * unknown or recycled identities are reported as `uncertain` and deliberately
 * left quarantined.
 */
export async function recoverRunnerProcess(identity: RunnerProcessIdentity): Promise<RunnerProcessRecovery> {
  const invalid = identityDiagnostic(identity);
  if (invalid !== undefined) {
    return invalidIdentity(invalid);
  }
  if (identity.supervisor.kind === 'windows-job-object' && identity.platform === 'win32') {
    return recoverWindowsJob(identity);
  }
  if (identity.supervisor.kind === 'posix-process-group') {
    return recoverPosixGroup(identity);
  }
  return {
    status: 'uncertain', drained: false,
    diagnostic: 'no supported containment identity; the run stays quarantined'
  };
}

async function recoverWindowsJob(identity: RunnerProcessIdentity): Promise<RunnerProcessRecovery> {
  let child: ChildProcess;
  try {
    child = spawn(powershellPath(), POWERSHELL_ARGS, {
      env: {
        ...process.env,
        RUNNER_MODE: 'recover',
        RUNNER_JOB: identity.supervisor.name,
        RUNNER_PID: String(identity.pid),
        RUNNER_CREATION: identity.startMarker
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    return { status: 'uncertain', drained: false, diagnostic: `recovery supervisor failed to start: ${describe(error)}` };
  }
  let output = '';
  let failures = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`;
    if (output.length > OUTPUT_DIAGNOSTIC_LIMIT) {
      output = output.slice(-OUTPUT_DIAGNOSTIC_LIMIT);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    failures = `${failures}${chunk.toString('utf8')}`;
    if (failures.length > OUTPUT_DIAGNOSTIC_LIMIT) {
      failures = failures.slice(-OUTPUT_DIAGNOSTIC_LIMIT);
    }
  });
  child.stdin?.end(WINDOWS_SUPERVISOR_SCRIPT);
  let exitCode: number | null = null;
  const exited = new Promise<boolean>(resolve => {
    child.once('exit', (code: number | null) => {
      exitCode = code;
      resolve(true);
    });
    child.once('error', () => resolve(true));
  });
  if (await withTimeout(exited, RECOVERY_TIMEOUT_MS) !== true) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    return { status: 'uncertain', drained: false, diagnostic: 'recovery supervisor timed out; the run stays quarantined' };
  }
  const verdicts = output.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'));
  const last = verdicts.length > 0 ? parseRecoveryVerdict(verdicts[verdicts.length - 1]) : {};
  if (last.status === 'absent') {
    return { status: 'absent', drained: true };
  }
  if (last.status === 'terminated') {
    return { status: 'terminated', drained: last.activeProcesses === 0 };
  }
  const detail = last.status === undefined
    ? `recovery supervisor returned no verdict (exit ${exitCode ?? 'unknown'})`
    : `recovery supervisor reported ${last.status}${last.detail === undefined ? '' : ` (${last.detail})`}`;
  return {
    status: 'uncertain', drained: false,
    diagnostic: failures.trim().length > 0 ? `${detail}: ${failures.trim().slice(-OUTPUT_DIAGNOSTIC_LIMIT)}` : detail
  };
}

async function recoverPosixGroup(identity: RunnerProcessIdentity): Promise<RunnerProcessRecovery> {
  const probes = recoveryProbes();
  if (probes.platform !== 'linux') {
    return {
      status: 'uncertain', drained: false,
      diagnostic: 'process start markers are only verifiable on Linux; the run stays quarantined'
    };
  }
  const pgid = Number(identity.supervisor.name);
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    return { status: 'uncertain', drained: false, diagnostic: 'invalid process group identity; the run stays quarantined' };
  }
  if (identity.startMarker.length === 0) {
    return { status: 'uncertain', drained: false, diagnostic: 'no start marker, so the identity cannot be proven; the run stays quarantined' };
  }
  const current = await probes.startMarker(pgid);
  if (current.length === 0) {
    if (probes.groupAlive(pgid)) {
      // The recorded leader is gone while its group still holds members. The
      // group id alone is never signalled here: with no leader to identify, the
      // id is not proof of this run's ownership. Only the journaled marker is,
      // so the validated per-candidate sweep is what stops and proves them.
      return recoverLeaderGoneGroup(pgid, identity, probes.groupAlive);
    }
    // The group is gone, but a descendant that left it may still be running, so
    // the journaled marker is swept before anything is called drained.
    return recoverPosixDescendants(identity, 'absent');
  }
  if (current !== identity.startMarker) {
    return { status: 'uncertain', drained: false, diagnostic: 'the recorded pid now belongs to a different process; the run stays quarantined' };
  }
  if (!probes.groupAlive(pgid)) {
    return recoverPosixDescendants(identity, 'absent');
  }
  if (!(await terminatePosixGroup(pgid))) {
    return { status: 'uncertain', drained: false, diagnostic: 'the process group survived SIGKILL; the run stays quarantined' };
  }
  return recoverPosixDescendants(identity, 'terminated');
}

/**
 * Recovery for a recorded group whose leader cannot be identified while the
 * group still has members. Every member is a descendant the recorded run
 * started, but with the leader gone the id cannot be proven to be this run's
 * group, so `kill(-pgid, ...)` is never used. The journaled marker is the only
 * ownership proof: the sweep stops the processes that carry it, and the run is
 * reclaimed only when that proof is complete AND the group is then empty.
 */
async function recoverLeaderGoneGroup(
  pgid: number,
  identity: RunnerProcessIdentity,
  groupAlive: (pgid: number) => boolean
): Promise<RunnerProcessRecovery> {
  const marker = identity.descendants;
  if (marker === undefined) {
    return {
      status: 'uncertain', drained: false,
      diagnostic: 'a live group holds the recorded id but its leader cannot be identified, and the record carries no'
        + ' descendant marker, so owned processes cannot be enumerated; the run stays quarantined'
    };
  }
  const sweep = await drainMarkedDescendants(marker);
  if (!sweep.drained) {
    return {
      status: 'uncertain', drained: false,
      diagnostic: `${sweep.diagnostic ?? 'marked descendants could not be drained'}; the run stays quarantined`
    };
  }
  // The owned set is provably empty. A group that still reports a member is
  // then a process this run cannot account for, so it is not reclaimable.
  if (!(await waitForGroupExit(pgid, POSIX_TERM_GRACE_MS, groupAlive))) {
    return {
      status: 'uncertain', drained: false,
      diagnostic: 'every process carrying the run marker was drained, but the recorded group still holds a process that'
        + ' carries no run marker, so the group cannot be proven empty; the run stays quarantined'
    };
  }
  return { status: 'terminated', drained: true };
}

/**
 * Sweeps the journaled marker of a POSIX run during recovery. Without a marker
 * the detached descendants of the recorded run cannot be enumerated, so the
 * run is kept quarantined rather than being assumed drained.
 */
async function recoverPosixDescendants(
  identity: RunnerProcessIdentity,
  status: 'terminated' | 'absent'
): Promise<RunnerProcessRecovery> {
  const marker = identity.descendants;
  if (marker === undefined || marker.marker.length === 0) {
    return {
      status, drained: false,
      diagnostic: 'the recorded identity has no descendant marker, so detached descendants cannot be proven gone; the run stays quarantined'
    };
  }
  const sweep = await drainMarkedDescendants(marker);
  if (!sweep.drained) {
    return {
      status: 'uncertain', drained: false,
      diagnostic: `${sweep.diagnostic ?? 'marked descendants could not be drained'}; the run stays quarantined`
    };
  }
  return { status, drained: true };
}

/**
 * Source-inlined Windows supervisor. PowerShell compiles this with Add-Type
 * (no file is written to disk), then the supervisor creates the command
 * suspended, assigns it to a non-inheritable KILL_ON_JOB_CLOSE job without
 * breakaway, resumes it, and drains the job on completion, timeout, or a lost
 * control channel.
 */
const WINDOWS_SUPERVISOR_SOURCE = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RS
{
  const int JOBOBJ_ACCT = 1;
  const int JOBOBJ_EXT = 9;
  const uint LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const uint LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
  const uint CREATE_SUSPENDED = 0x4;
  const uint CREATE_NO_WINDOW = 0x8000000;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
  const uint STARTF_USESTDHANDLES = 0x100;
  const uint DUPLICATE_SAME_ACCESS = 0x2;
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_READ = 0x1;
  const uint FILE_SHARE_WRITE = 0x2;
  const uint OPEN_EXISTING = 0x3;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint JOB_OBJECT_TERMINATE = 0x8;
  const uint JOB_OBJECT_QUERY = 0x4;
  const int STD_OUTPUT_HANDLE = -11;
  const int STD_ERROR_HANDLE = -12;
  const int ERROR_FILE_NOT_FOUND = 2;
  const uint INFINITE = 0xFFFFFFFF;
  const int HANDLE_LIST = 0x20002;
  const int CLEANUP_MS = 5000;

  [StructLayout(LayoutKind.Sequential)]
  struct SA { public int length; public IntPtr descriptor; public bool inherit; }

  [StructLayout(LayoutKind.Sequential)]
  struct SI
  {
    public int cb;
    public IntPtr reserved;
    public IntPtr desktop;
    public IntPtr title;
    public int x;
    public int y;
    public int xSize;
    public int ySize;
    public int xChars;
    public int yChars;
    public int fill;
    public int flags;
    public short show;
    public short reserved2;
    public IntPtr reserved3;
    public IntPtr hIn;
    public IntPtr hOut;
    public IntPtr hErr;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct SIX { public SI info; public IntPtr attrs; }

  [StructLayout(LayoutKind.Sequential)]
  struct PI { public IntPtr process; public IntPtr thread; public int pid; public int tid; }

  [StructLayout(LayoutKind.Sequential)]
  struct BLI
  {
    public long perUser;
    public long perJob;
    public uint flags;
    public UIntPtr minWs;
    public UIntPtr maxWs;
    public uint activeLimit;
    public UIntPtr affinity;
    public uint priority;
    public uint scheduling;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IOC { public ulong r1; public ulong w1; public ulong o1; public ulong r2; public ulong w2; public ulong o2; }

  [StructLayout(LayoutKind.Sequential)]
  struct EXT { public BLI basic; public IOC io; public UIntPtr procMem; public UIntPtr jobMem; public UIntPtr peakProcMem; public UIntPtr peakJobMem; }

  [StructLayout(LayoutKind.Sequential)]
  struct ACCT { public long user; public long kernel; public long periodUser; public long periodKernel; public uint pageFaults; public uint total; public uint active; public uint terminated; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int length, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, ref SA attrs, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SIX si, out PI pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);

  static readonly object gate = new object();
  static readonly ManualResetEvent finished = new ManualResetEvent(false);
  static readonly List<byte> inbound = new List<byte>();
  static NamedPipeClientStream pipe;
  static IntPtr job = IntPtr.Zero;
  static IntPtr root = IntPtr.Zero;
  static bool reported;
  static int rootPid;
  static string[] inheritedNames = new string[0];

  public static void Run()
  {
    if (Environment.GetEnvironmentVariable("RUNNER_MODE") == "recover") { Recover(); return; }
    Execute();
  }

  static void Execute()
  {
    string pipeName = Environment.GetEnvironmentVariable("RUNNER_PIPE");
    string jobName = Environment.GetEnvironmentVariable("RUNNER_JOB");
    Environment.SetEnvironmentVariable("RUNNER_PIPE", null);
    Environment.SetEnvironmentVariable("RUNNER_JOB", null);
    Environment.SetEnvironmentVariable("RUNNER_MODE", null);
    try
    {
      pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
      pipe.Connect(20000);
    }
    catch (Exception failure)
    {
      Console.Error.WriteLine("runner-supervisor: control connect failed: " + failure.Message);
      Environment.Exit(2);
      return;
    }
    if (!SetupJob(jobName)) { Fail("job_setup_failed", Marshal.GetLastWin32Error(), 0); return; }
    Send("{\"type\":\"ready\"}");
    string line = ReadLine();
    if (line == null) { Fail("control_closed_before_start", 0, 0); return; }
    if (Str(line, "type") != "start") { Fail("unexpected_control_message", 0, 0); return; }
    string shell = Str(line, "shell");
    string command = Str(line, "command");
    string environment = Str(line, "env");
    string workingDirectory = Str(line, "cwd");
    int failureCode = 0;
    if (!Start(shell, command, environment, workingDirectory, out failureCode))
    {
      // Prove the tree is gone before reporting: wait for any suspended or
      // partially started root, terminate the job, and query its active count
      // again. The caller only treats activeProcesses == 0 as drained.
      Fail("spawn_failed", failureCode, CleanupAfterFailedStart());
      return;
    }
    Thread watcher = new Thread(Watch);
    watcher.IsBackground = true;
    watcher.Start();
    WaitForSingleObject(root, INFINITE);
    uint code = 1;
    GetExitCodeProcess(root, out code);
    Finish((int)code, false, null);
  }

  static void Watch()
  {
    while (true)
    {
      string line = ReadLine();
      if (line == null) { Finish(null, true, "control_closed"); return; }
      if (line.IndexOf("\"terminate\"") >= 0) { Finish(null, true, null); return; }
    }
  }

  static bool SetupJob(string name)
  {
    job = CreateJobObjectW(IntPtr.Zero, name);
    if (job == IntPtr.Zero) { return false; }
    EXT limits = new EXT();
    limits.basic.flags = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    int size = Marshal.SizeOf(typeof(EXT));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try
    {
      Marshal.StructureToPtr(limits, buffer, false);
      return SetInformationJobObject(job, JOBOBJ_EXT, buffer, size);
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  static void CaptureEnvironment()
  {
    ArrayList names = new ArrayList();
    foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) { names.Add((string)entry.Key); }
    inheritedNames = (string[])names.ToArray(typeof(string));
  }

  static void ApplyEnvironment(string encoded)
  {
    CaptureEnvironment();
    foreach (string name in inheritedNames) { try { Environment.SetEnvironmentVariable(name, null); } catch { } }
    if (encoded == null || encoded.Length == 0) { return; }
    string joined = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
    string[] parts = joined.Split('\u0000');
    for (int i = 0; i + 1 < parts.Length; i += 2) { try { Environment.SetEnvironmentVariable(parts[i], parts[i + 1]); } catch { } }
  }

  static bool Start(string shell, string command, string environment, string workingDirectory, out int failureCode)
  {
    failureCode = 0;
    IntPtr hIn = IntPtr.Zero;
    IntPtr hOut = IntPtr.Zero;
    IntPtr hErr = IntPtr.Zero;
    IntPtr attrs = IntPtr.Zero;
    IntPtr handles = IntPtr.Zero;
    PI pi = new PI();
    bool created = false;
    try
    {
      SA sa = new SA();
      sa.length = Marshal.SizeOf(typeof(SA));
      sa.inherit = true;
      hIn = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sa, OPEN_EXISTING, 0, IntPtr.Zero);
      if (hIn == new IntPtr(-1)) { failureCode = Marshal.GetLastWin32Error(); return false; }
      if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(), out hOut, 0, true, DUPLICATE_SAME_ACCESS)) { failureCode = Marshal.GetLastWin32Error(); return false; }
      if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(), out hErr, 0, true, DUPLICATE_SAME_ACCESS)) { failureCode = Marshal.GetLastWin32Error(); return false; }
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attrs = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref size)) { failureCode = Marshal.GetLastWin32Error(); return false; }
      handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
      Marshal.WriteIntPtr(handles, 0, hIn);
      Marshal.WriteIntPtr(handles, IntPtr.Size, hOut);
      Marshal.WriteIntPtr(handles, IntPtr.Size * 2, hErr);
      if (!UpdateProcThreadAttribute(attrs, 0, new IntPtr(HANDLE_LIST), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) { failureCode = Marshal.GetLastWin32Error(); return false; }
      SIX si = new SIX();
      si.info.cb = Marshal.SizeOf(typeof(SIX));
      si.info.flags = (int)STARTF_USESTDHANDLES;
      si.info.hIn = hIn;
      si.info.hOut = hOut;
      si.info.hErr = hErr;
      si.attrs = attrs;
      ApplyEnvironment(environment);
      StringBuilder line = new StringBuilder("\"" + shell + "\" /d /s /c \"" + command + "\"");
      created = CreateProcessW(null, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, workingDirectory, ref si, out pi);
      if (!created) { failureCode = Marshal.GetLastWin32Error(); return false; }
      root = pi.process;
      if (!AssignProcessToJobObject(job, root)) { failureCode = Marshal.GetLastWin32Error(); TerminateProcess(root, 1); return false; }
      if (ResumeThread(pi.thread) == 0xFFFFFFFF) { failureCode = Marshal.GetLastWin32Error(); TerminateJobObject(job, 1); return false; }
      CloseHandle(pi.thread);
      pi.thread = IntPtr.Zero;
      rootPid = pi.pid;
      Send("{\"type\":\"started\",\"pid\":" + rootPid + ",\"creationTime\":\"" + CreationTime(rootPid) + "\"}");
      return true;
    }
    finally
    {
      if (created && pi.thread != IntPtr.Zero) { CloseHandle(pi.thread); }
      if (hIn != IntPtr.Zero && hIn != new IntPtr(-1)) { CloseHandle(hIn); }
      if (hOut != IntPtr.Zero) { CloseHandle(hOut); }
      if (hErr != IntPtr.Zero) { CloseHandle(hErr); }
      if (attrs != IntPtr.Zero) { DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
      if (handles != IntPtr.Zero) { Marshal.FreeHGlobal(handles); }
    }
  }

  static void Fail(string code, int detail, int activeProcesses)
  {
    Send("{\"type\":\"error\",\"code\":\"" + code + "\",\"detail\":" + detail + ",\"activeProcesses\":" + activeProcesses + "}");
    ClosePipe();
    Environment.Exit(3);
  }

  // Bounded proof of an empty job after a failed start: wait for the suspended
  // or half-started root, terminate every remaining member, and report what is
  // still attached (-1 when the job handle itself is unusable, which is never
  // reported as drained by the caller).
  static int CleanupAfterFailedStart()
  {
    if (root != IntPtr.Zero) { WaitForSingleObject(root, 2000); }
    return Drain(job);
  }

  static void Finish(int? exitCode, bool terminated, string message)
  {
    bool winner = false;
    lock (gate)
    {
      if (!reported) { reported = true; winner = true; }
    }
    if (!winner) { finished.WaitOne(20000); return; }
    int active = Drain(job);
    string json = "{\"type\":\"result\",\"exitCode\":" + (exitCode.HasValue ? exitCode.Value.ToString() : "null")
      + ",\"activeProcesses\":" + active + ",\"terminated\":" + (terminated ? "true" : "false");
    if (message != null) { json += ",\"message\":\"" + message + "\""; }
    Send(json + "}");
    finished.Set();
    ClosePipe();
    Environment.Exit(active == 0 ? 0 : 4);
  }

  static int Drain(IntPtr target)
  {
    if (target == IntPtr.Zero) { return -1; }
    int active = ActiveCount(target);
    if (active == 0) { return 0; }
    TerminateJobObject(target, 1);
    DateTime until = DateTime.UtcNow.AddMilliseconds(CLEANUP_MS);
    while (DateTime.UtcNow < until)
    {
      active = ActiveCount(target);
      if (active == 0) { return 0; }
      Thread.Sleep(25);
    }
    return active;
  }

  static int ActiveCount(IntPtr target)
  {
    if (target == IntPtr.Zero) { return -1; }
    int size = Marshal.SizeOf(typeof(ACCT));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try
    {
      Marshal.StructureToPtr(new ACCT(), buffer, false);
      if (!QueryInformationJobObject(target, JOBOBJ_ACCT, buffer, size, IntPtr.Zero)) { return -1; }
      ACCT result = (ACCT)Marshal.PtrToStructure(buffer, typeof(ACCT));
      return (int)result.active;
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  static string CreationTime(int pid)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) { return ""; }
    try
    {
      long created;
      long exited;
      long kernel;
      long user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) { return ""; }
      return created.ToString();
    }
    finally { CloseHandle(handle); }
  }

  static void Recover()
  {
    string jobName = Environment.GetEnvironmentVariable("RUNNER_JOB");
    string pidText = Environment.GetEnvironmentVariable("RUNNER_PID");
    string recorded = Environment.GetEnvironmentVariable("RUNNER_CREATION");
    IntPtr target = OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY, false, jobName);
    if (target == IntPtr.Zero)
    {
      int openError = Marshal.GetLastWin32Error();
      if (openError == ERROR_FILE_NOT_FOUND) { Emit("{\"status\":\"absent\",\"detail\":\"job object closed\"}"); return; }
      Emit("{\"status\":\"uncertain\",\"detail\":\"open_job_failed_" + openError + "\"}");
      return;
    }
    try
    {
      int active = ActiveCount(target);
      if (active == 0) { Emit("{\"status\":\"absent\",\"detail\":\"job holds no processes\"}"); return; }
      if (active < 0) { Emit("{\"status\":\"uncertain\",\"detail\":\"job_query_failed\"}"); return; }
      int pid = 0;
      int.TryParse(pidText, out pid);
      string now = CreationTime(pid);
      if (recorded != null && recorded.Length > 0 && now.Length > 0 && now != recorded)
      {
        Emit("{\"status\":\"uncertain\",\"detail\":\"process_identity_recycled\"}");
        return;
      }
      int remaining = Drain(target);
      Emit("{\"status\":\"" + (remaining == 0 ? "terminated" : "uncertain") + "\",\"activeProcesses\":" + remaining + ",\"detail\":\"job_drain\"}");
    }
    finally { CloseHandle(target); }
  }

  static void Emit(string json)
  {
    Console.Out.WriteLine(json);
    Console.Out.Flush();
  }

  static void Send(string json)
  {
    byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
    lock (gate)
    {
      try { if (pipe != null) { pipe.Write(bytes, 0, bytes.Length); pipe.Flush(); } } catch { }
    }
  }

  static void ClosePipe()
  {
    lock (gate)
    {
      try { if (pipe != null) { pipe.Dispose(); } } catch { }
      pipe = null;
    }
  }

  static string ReadLine()
  {
    while (true)
    {
      for (int i = 0; i < inbound.Count; i++)
      {
        if (inbound[i] == 10)
        {
          string line = Encoding.UTF8.GetString(inbound.GetRange(0, i).ToArray());
          inbound.RemoveRange(0, i + 1);
          return line.TrimEnd('\r');
        }
      }
      if (inbound.Count > 262144) { inbound.Clear(); return null; }
      byte[] buffer = new byte[4096];
      int read;
      try { read = pipe.Read(buffer, 0, buffer.Length); } catch { return null; }
      if (read <= 0) { return null; }
      for (int i = 0; i < read; i++) { inbound.Add(buffer[i]); }
    }
  }

  static string Str(string json, string name)
  {
    int start = json.IndexOf("\"" + name + "\":");
    if (start < 0) { return null; }
    start = json.IndexOf('"', start + name.Length + 3);
    if (start < 0) { return null; }
    StringBuilder text = new StringBuilder();
    for (int i = start + 1; i < json.Length; i++)
    {
      char c = json[i];
      if (c == '"') { return text.ToString(); }
      if (c != '\\') { text.Append(c); continue; }
      i++;
      char escaped = json[i];
      if (escaped == 'u') { text.Append((char)Convert.ToInt32(json.Substring(i + 1, 4), 16)); i += 4; }
      else if (escaped == 'n') { text.Append('\n'); }
      else if (escaped == 'r') { text.Append('\r'); }
      else if (escaped == 't') { text.Append('\t'); }
      else if (escaped == 'b') { text.Append('\b'); }
      else if (escaped == 'f') { text.Append('\f'); }
      else { text.Append(escaped); }
    }
    return null;
  }
}
`;

const WINDOWS_SUPERVISOR_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  `$src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(WINDOWS_SUPERVISOR_SOURCE, 'utf8').toString('base64')}'))`,
  'try { Add-Type -TypeDefinition $src; [RS]::Run() } catch { [Console]::Error.WriteLine("runner-supervisor: " + $_.Exception.Message); exit 9 }'
].join('\n');
