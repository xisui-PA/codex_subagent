import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { Mutex, atomicWrite, digest } from './storage';
import { WorkerError } from './types';

// ---------------------------------------------------------------------------
// Durable, versioned command outcome records for the future runner execution
// service.
//
// This module is storage and authorization ONLY. It never starts, signals or
// kills a process, never executes or replays a command, never imports a view
// and never derives a task-board verdict. A caller durably records a pending
// attempt BEFORE it effects a spawn, then records one immutable final result.
//
// Layout (all plain files below a verified plain store root):
//
//   <directory>/namespace.json          namespace identity and revision
//   <directory>/pending/<leaseId>.json  durable attempt, removed after final
//   <directory>/results/<leaseId>.json  immutable final result
//
// Every record is strict JSON and is validated by a strict Zod schema on read.
// A result carries the unchanged attempt (including the input version) and the
// optional afterVersion describing what an import produced. The input command
// therefore never implies that a later revision was validated by the command.
//
// Recovery: a pending attempt with no final result becomes an immutable
// 'uncertain' result on the next open (no replay, no fabricated success). If a
// crash happened after the final write but before the pending removal, the
// original final result is preserved and the leftover pending file is dropped.
//
// Capacity is explicit and checked before any write: at most 1024 logical
// records (results + pending), at most 128 MiB of managed JSON, and at most
// 1 MiB for one result. Nothing is evicted automatically and unknown entries
// are preserved and reported.
// ---------------------------------------------------------------------------

/** Schema and record versions written into every durable document. */
export const RUNNER_RESULTS_SCHEMA = 1;
export const RUNNER_RESULTS_VERSION = 1;

/** Default logical record cap (results + pending). */
export const RUNNER_RESULTS_MAX_RECORDS = 1024;
/** Default serialized cap over every managed file (namespace, pending, results). */
export const RUNNER_RESULTS_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** Hard cap for one result or pending document. */
export const RUNNER_RESULTS_MAX_RESULT_BYTES = 1024 * 1024;
/** Maximum accepted command characters. */
export const RUNNER_RESULTS_MAX_COMMAND_CHARS = 4000;
/** Maximum accepted command output characters. */
export const RUNNER_RESULTS_MAX_OUTPUT_CHARS = 100_000;
/** Maximum input/after revision index accepted by the schema. */
export const RUNNER_RESULTS_MAX_REVISION = 1024;
/** Default and maximum page size for list(). */
export const RUNNER_RESULTS_PAGE_SIZE = 20;

const NAMESPACE_FILE = 'namespace.json';
const PENDING_DIRECTORY = 'pending';
const RESULTS_DIRECTORY = 'results';
/**
 * Exact shape of the uncommitted temp file `storage.atomicWrite` creates beside
 * the namespace: `<target>.<randomUUID()>.tmp`. Only this literal spelling with a
 * canonical lowercase UUID counts; a generic `*.tmp`, a similar prefix, an upper
 * case or a truncated UUID is NOT one of our temps.
 */
const NAMESPACE_TEMP_RE = /^namespace\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const MAX_NAMESPACE_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 8192;
const MAX_DIAGNOSTIC_LENGTH = 1000;
const MAX_STORE_DIAGNOSTICS = 50;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RECOVERY_DIAGNOSTIC = 'The host restarted before this command recorded a final result. Its outcome is uncertain; the command was not replayed.';

const ID32_RE = /^[0-9a-f]{32}$/;
const ID64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Exact owner identity copied from the lease that ran the command. */
export interface RunnerResultOwner {
  readonly ownerId: string;
  readonly teamId: string;
  readonly workerId: string;
  readonly workerCreatedAt: string;
}

/** Snapshot/overlay revision the attempt was prepared against. */
export interface RunnerInputVersion {
  readonly snapshotId: string;
  readonly overlayId: string;
  readonly revision: number;
}

/** Stable setup identity recorded before execution; no secret values. */
export interface RunnerSetup {
  readonly identityHash: string;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly shell: string;
  readonly environmentHash: string;
  readonly caches: readonly string[];
}

/** One durable attempt. `id` is the leaseId-shaped attempt identity. */
export interface RunnerCommandAttempt {
  readonly id: string;
  readonly owner: RunnerResultOwner;
  readonly leaseId: string;
  readonly logicalRoot: string;
  readonly executionDirectory: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly inputVersion: RunnerInputVersion;
  readonly setup: RunnerSetup;
  readonly startedAt: string;
}

/** Final outcome vocabulary; only 'succeeded' carries success semantics. */
export const RUNNER_RESULT_OUTCOMES = ['succeeded', 'failed', 'cancelled', 'timed_out', 'setup_failed', 'denied', 'uncertain'] as const;
export type RunnerResultOutcome = (typeof RUNNER_RESULT_OUTCOMES)[number];

/** What the caller's later import step achieved. */
export const RUNNER_IMPORT_STATUSES = ['not_started', 'unchanged', 'imported', 'failed', 'uncertain'] as const;
export type RunnerImportStatus = (typeof RUNNER_IMPORT_STATUSES)[number];

/** Immutable final command result; written once and never overwritten. */
export interface RunnerCommandResult {
  readonly schema: 1;
  readonly version: 1;
  readonly id: string;
  /** Deterministic URN: namespace (store + logical root) and record id. */
  readonly uri: string;
  readonly namespace: string;
  readonly attempt: RunnerCommandAttempt;
  readonly outcome: RunnerResultOutcome;
  readonly afterVersion: RunnerInputVersion | null;
  readonly import: RunnerImportStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly drained: boolean;
  readonly diagnostic?: string;
  readonly completedAt: string;
}

/** Caller-supplied final details; everything but outcome/import/drained is optional. */
export interface RunnerCommandFinish {
  readonly outcome: RunnerResultOutcome;
  readonly afterVersion?: RunnerInputVersion | null;
  readonly import: RunnerImportStatus;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly drained: boolean;
  readonly diagnostic?: string;
  /** Defaults to the current time; an explicit value must stay identical on replay. */
  readonly completedAt?: string;
}

/** Result of start(): a fresh acknowledgment or an exact replay. */
export interface RunnerAttemptStart {
  readonly id: string;
  readonly state: 'pending' | 'finished';
  readonly replayed: boolean;
  readonly attempt: RunnerCommandAttempt;
  readonly result: RunnerCommandResult | null;
}

/** Trusted caller scope; only ownerId + teamId are compared. */
export interface RunnerResultScope {
  readonly ownerId: string;
  readonly teamId: string;
}

/** One bounded page of final results, newest first. */
export interface RunnerResultsPage {
  readonly results: readonly RunnerCommandResult[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly nextOffset: number | null;
}

/** Observable store state; unknown entries are reported but never removed. */
export interface RunnerResultsStatus {
  readonly directory: string;
  readonly logicalRoot: string;
  readonly namespace: string;
  readonly open: boolean;
  readonly closed: boolean;
  readonly results: number;
  readonly pending: number;
  readonly totalBytes: number;
  readonly maxRecords: number;
  readonly maxTotalBytes: number;
  readonly maxResultBytes: number;
  readonly unknownEntries: readonly string[];
  readonly diagnostics: readonly string[];
}

/** Injectable caps for focused tests; production defaults are bounded. */
export interface RunnerResultsOptions {
  readonly maxRecords?: number;
  readonly maxTotalBytes?: number;
  readonly maxResultBytes?: number;
}

const id32 = z.string().regex(ID32_RE);
const id64 = z.string().regex(ID64_RE);
const isoDate = z.string().refine(value => ISO_RE.test(value) && Number.isFinite(Date.parse(value)), 'Expected an ISO UTC timestamp.');
const absolutePath = z.string().min(1).max(MAX_PATH_LENGTH).refine(value => path.isAbsolute(value), 'Expected an absolute path.');

const ownerSchema = z.strictObject({
  ownerId: z.string().min(1).max(200),
  teamId: id32,
  workerId: id32,
  workerCreatedAt: isoDate
});

const inputVersionSchema = z.strictObject({
  snapshotId: id64,
  overlayId: id64,
  revision: z.number().int().min(0).max(RUNNER_RESULTS_MAX_REVISION)
});

const setupSchema = z.strictObject({
  identityHash: id64,
  platform: z.string().min(1).max(100),
  arch: z.string().min(1).max(100),
  nodeVersion: z.string().min(1).max(100),
  shell: z.string().min(1).max(500),
  environmentHash: id64,
  caches: z.array(z.string().min(1).max(500)).max(64)
});

const attemptSchema = z.strictObject({
  id: id32,
  owner: ownerSchema,
  leaseId: id32,
  logicalRoot: absolutePath,
  executionDirectory: absolutePath,
  command: z.string().min(1).max(RUNNER_RESULTS_MAX_COMMAND_CHARS),
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS),
  inputVersion: inputVersionSchema,
  setup: setupSchema,
  startedAt: isoDate
});

const outcomeSchema = z.enum(RUNNER_RESULT_OUTCOMES);
const importSchema = z.enum(RUNNER_IMPORT_STATUSES);

const resultSchema = z.strictObject({
  schema: z.literal(RUNNER_RESULTS_SCHEMA),
  version: z.literal(RUNNER_RESULTS_VERSION),
  id: id32,
  uri: z.string().min(1).max(512),
  namespace: id64,
  attempt: attemptSchema,
  outcome: outcomeSchema,
  afterVersion: inputVersionSchema.nullable(),
  import: importSchema,
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
  signal: z.string().min(1).max(64).nullable(),
  output: z.string().max(RUNNER_RESULTS_MAX_OUTPUT_CHARS),
  truncated: z.boolean(),
  drained: z.boolean(),
  diagnostic: z.string().min(1).max(MAX_DIAGNOSTIC_LENGTH).optional(),
  completedAt: isoDate
});

const pendingFileSchema = z.strictObject({
  schema: z.literal(RUNNER_RESULTS_SCHEMA),
  version: z.literal(RUNNER_RESULTS_VERSION),
  namespace: id64,
  attempt: attemptSchema
});

const namespaceSchema = z.strictObject({
  schema: z.literal(RUNNER_RESULTS_SCHEMA),
  version: z.literal(RUNNER_RESULTS_VERSION),
  namespace: id64,
  directory: absolutePath,
  logicalRoot: absolutePath,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});

const scopeSchema = z.strictObject({
  ownerId: z.string().min(1).max(200),
  teamId: id32
});

const finishSchema = z.strictObject({
  outcome: outcomeSchema,
  afterVersion: inputVersionSchema.nullable().optional(),
  import: importSchema,
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable().optional(),
  signal: z.string().min(1).max(64).nullable().optional(),
  output: z.string().max(RUNNER_RESULTS_MAX_OUTPUT_CHARS).optional(),
  truncated: z.boolean().optional(),
  drained: z.boolean(),
  diagnostic: z.string().min(1).max(MAX_DIAGNOSTIC_LENGTH).optional(),
  completedAt: isoDate.optional()
});

interface NormalizedFinish {
  readonly outcome: RunnerResultOutcome;
  readonly afterVersion: RunnerInputVersion | null;
  readonly import: RunnerImportStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly drained: boolean;
  readonly diagnostic?: string;
  readonly completedAt?: string;
}

interface PendingEntry {
  readonly attempt: RunnerCommandAttempt;
  readonly bytes: number;
}

type PlainDirectory = 'plain' | 'missing' | 'unsafe';

const nowIso = (): string => new Date().toISOString();
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

function corrupt(message: string): never {
  throw new WorkerError('runner_results_corrupt', message);
}

function capacity(message: string): never {
  throw new WorkerError('runner_results_capacity', message);
}

function invalidPath(message: string): never {
  throw new WorkerError('invalid_path', message);
}

function invalidAttempt(message: string): never {
  throw new WorkerError('invalid_runner_attempt', message);
}

function invalidFinish(message: string): never {
  throw new WorkerError('invalid_runner_finish', message);
}

function invalidScope(message: string): never {
  throw new WorkerError('invalid_runner_scope', message);
}

function invalidId(message: string): never {
  throw new WorkerError('invalid_runner_id', message);
}

function storage(message: string): never {
  throw new WorkerError('runner_results_storage', message);
}

function describeIssues(label: string, error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) {
    return `${label} failed schema validation.`;
  }
  const where = first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  return `${label} failed schema validation${where}: ${first.message}`;
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

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

function freezeOwner(owner: RunnerResultOwner): RunnerResultOwner {
  return Object.freeze({ ownerId: owner.ownerId, teamId: owner.teamId, workerId: owner.workerId, workerCreatedAt: owner.workerCreatedAt });
}

function freezeVersion(version: RunnerInputVersion): RunnerInputVersion {
  return Object.freeze({ snapshotId: version.snapshotId, overlayId: version.overlayId, revision: version.revision });
}

function freezeSetup(setup: RunnerSetup): RunnerSetup {
  return Object.freeze({
    identityHash: setup.identityHash,
    platform: setup.platform,
    arch: setup.arch,
    nodeVersion: setup.nodeVersion,
    shell: setup.shell,
    environmentHash: setup.environmentHash,
    caches: Object.freeze([...setup.caches])
  });
}

function freezeAttempt(attempt: RunnerCommandAttempt): RunnerCommandAttempt {
  return Object.freeze({
    id: attempt.id,
    owner: freezeOwner(attempt.owner),
    leaseId: attempt.leaseId,
    logicalRoot: attempt.logicalRoot,
    executionDirectory: attempt.executionDirectory,
    command: attempt.command,
    timeoutMs: attempt.timeoutMs,
    inputVersion: freezeVersion(attempt.inputVersion),
    setup: freezeSetup(attempt.setup),
    startedAt: attempt.startedAt
  });
}

function parseAttempt(value: unknown): RunnerCommandAttempt {
  const parsed = attemptSchema.safeParse(value);
  if (!parsed.success) {
    invalidAttempt(describeIssues('Attempt', parsed.error));
  }
  return freezeAttempt(parsed.data);
}

function parseFinish(value: unknown): NormalizedFinish {
  const parsed = finishSchema.safeParse(value);
  if (!parsed.success) {
    invalidFinish(describeIssues('Final details', parsed.error));
  }
  const data = parsed.data;
  return Object.freeze({
    outcome: data.outcome,
    afterVersion: data.afterVersion === undefined || data.afterVersion === null ? null : freezeVersion(data.afterVersion),
    import: data.import,
    exitCode: data.exitCode ?? null,
    signal: data.signal ?? null,
    output: data.output ?? '',
    truncated: data.truncated ?? false,
    drained: data.drained,
    ...(data.diagnostic === undefined ? {} : { diagnostic: data.diagnostic }),
    ...(data.completedAt === undefined ? {} : { completedAt: data.completedAt })
  });
}

function sameVersion(a: RunnerInputVersion, b: RunnerInputVersion): boolean {
  return a.snapshotId === b.snapshotId && a.overlayId === b.overlayId && a.revision === b.revision;
}

/**
 * Semantic invariants of a final result. Success is never inferred: it must be
 * claimed explicitly AND carry exit code 0, a drained command and a completed
 * supported import.
 *
 * afterVersion is the delta the caller's import produced; it never re-describes
 * the command's input. An imported result must advance the SAME snapshot and
 * overlay by exactly one revision (one atomic delta), an unchanged result must
 * repeat its input version explicitly, and every non-imported status keeps a
 * null after version. A foreign binding, a stale revision or a skipped revision
 * is refused rather than reinterpreted.
 */
function resultIssue(result: RunnerCommandResult): string | undefined {
  if (result.outcome === 'succeeded') {
    if (result.exitCode !== 0) {
      return 'A succeeded outcome requires exit code 0.';
    }
    if (!result.drained) {
      return 'A succeeded outcome requires a drained command.';
    }
    if (result.signal !== null) {
      return 'A succeeded outcome cannot record a terminating signal.';
    }
    if (result.import !== 'unchanged' && result.import !== 'imported') {
      return 'A succeeded outcome requires a completed supported import.';
    }
  }
  const input = result.attempt.inputVersion;
  if ((result.outcome === 'denied' || result.outcome === 'setup_failed')
    && (result.import !== 'not_started' || result.afterVersion !== null)) {
    return 'A denied or failed-setup outcome cannot import changes.';
  }
  if (result.import === 'imported') {
    if (result.afterVersion === null) {
      return 'An imported result requires an after version.';
    }
    if (result.afterVersion.snapshotId !== input.snapshotId || result.afterVersion.overlayId !== input.overlayId) {
      return 'An imported result must keep the attempt snapshot and overlay binding.';
    }
    if (result.afterVersion.revision <= input.revision) {
      return 'An imported result must advance the input revision.';
    }
    if (result.afterVersion.revision !== input.revision + 1) {
      return 'An imported result must advance the input revision by exactly one atomic delta.';
    }
    return undefined;
  }
  if (result.import === 'unchanged') {
    if (result.afterVersion === null) {
      return 'An unchanged import must record its unchanged after version explicitly.';
    }
    if (!sameVersion(result.afterVersion, input)) {
      return 'An unchanged import must keep the exact attempt input version.';
    }
    return undefined;
  }
  if (result.afterVersion !== null) {
    return `An import marked ${result.import} cannot record an after version.`;
  }
  return undefined;
}

function freezeResult(result: RunnerCommandResult): RunnerCommandResult {
  const base: RunnerCommandResult = {
    schema: RUNNER_RESULTS_SCHEMA,
    version: RUNNER_RESULTS_VERSION,
    id: result.id,
    uri: result.uri,
    namespace: result.namespace,
    attempt: freezeAttempt(result.attempt),
    outcome: result.outcome,
    afterVersion: result.afterVersion === null ? null : freezeVersion(result.afterVersion),
    import: result.import,
    exitCode: result.exitCode,
    signal: result.signal,
    output: result.output,
    truncated: result.truncated,
    drained: result.drained,
    completedAt: result.completedAt
  };
  return Object.freeze(result.diagnostic === undefined ? base : { ...base, diagnostic: result.diagnostic });
}

function buildResult(attempt: RunnerCommandAttempt, namespace: string, finish: NormalizedFinish, completedAt: string): RunnerCommandResult {
  const result = freezeResult({
    schema: RUNNER_RESULTS_SCHEMA,
    version: RUNNER_RESULTS_VERSION,
    id: attempt.id,
    uri: runnerResultUri(namespace, attempt.id),
    namespace,
    attempt,
    outcome: finish.outcome,
    afterVersion: finish.afterVersion,
    import: finish.import,
    exitCode: finish.exitCode,
    signal: finish.signal,
    output: finish.output,
    truncated: finish.truncated,
    drained: finish.drained,
    ...(finish.diagnostic === undefined ? {} : { diagnostic: finish.diagnostic }),
    completedAt
  });
  const issue = resultIssue(result);
  if (issue !== undefined) {
    invalidFinish(issue);
  }
  return result;
}

function parseResultRecord(raw: unknown, expectedId: string, namespace: string, logicalRoot: string): RunnerCommandResult {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) {
    corrupt(`${describeIssues(`Result ${expectedId}`, parsed.error)}`);
  }
  if (parsed.data.id !== expectedId) {
    corrupt(`Result ${expectedId} does not match its record id.`);
  }
  if (parsed.data.attempt.id !== expectedId) {
    corrupt(`Result ${expectedId} carries a different attempt id.`);
  }
  if (parsed.data.namespace !== namespace) {
    corrupt(`Result ${expectedId} belongs to a different results namespace.`);
  }
  if (parsed.data.uri !== runnerResultUri(namespace, expectedId)) {
    corrupt(`Result ${expectedId} does not carry this store's deterministic URI.`);
  }
  if (path.resolve(parsed.data.attempt.logicalRoot) !== logicalRoot) {
    corrupt(`Result ${expectedId} belongs to a different logical project root.`);
  }
  const result = freezeResult(parsed.data);
  const issue = resultIssue(result);
  if (issue !== undefined) {
    corrupt(`Result ${expectedId} is inconsistent: ${issue}`);
  }
  return result;
}

function parsePendingRecord(raw: unknown, expectedId: string, namespace: string, logicalRoot: string): RunnerCommandAttempt {
  const parsed = pendingFileSchema.safeParse(raw);
  if (!parsed.success) {
    corrupt(describeIssues(`Pending attempt ${expectedId}`, parsed.error));
  }
  if (parsed.data.attempt.id !== expectedId) {
    corrupt(`Pending attempt ${expectedId} does not match its record id.`);
  }
  if (parsed.data.namespace !== namespace) {
    corrupt(`Pending attempt ${expectedId} belongs to a different results namespace.`);
  }
  const attempt = freezeAttempt(parsed.data.attempt);
  if (path.resolve(attempt.logicalRoot) !== logicalRoot) {
    corrupt(`Pending attempt ${expectedId} belongs to a different logical project root.`);
  }
  return attempt;
}

function parseNamespaceRecord(raw: unknown, directory: string, logicalRoot: string, namespace: string): void {
  const parsed = namespaceSchema.safeParse(raw);
  if (!parsed.success) {
    corrupt(describeIssues('Results namespace metadata', parsed.error));
  }
  if (parsed.data.namespace !== namespace
    || path.resolve(parsed.data.directory) !== directory
    || path.resolve(parsed.data.logicalRoot) !== logicalRoot) {
    corrupt('The results namespace metadata belongs to a different store or logical project root.');
  }
}

function parseScope(value: unknown): RunnerResultScope {
  const parsed = scopeSchema.safeParse(value);
  if (!parsed.success) {
    invalidScope(describeIssues('Scope', parsed.error));
  }
  return Object.freeze({ ownerId: parsed.data.ownerId, teamId: parsed.data.teamId });
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !ID32_RE.test(value)) {
    invalidId('A runner result id must be 32 lowercase hex characters.');
  }
  return value;
}

function pageNumber(value: unknown, label: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WorkerError('invalid_runner_page', `${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

/**
 * Deterministic namespace: SHA-256 over an unambiguous JSON tuple of a domain
 * tag, the resolved store path and the resolved logical project root. A length
 * prefix is impossible to forge because JSON escapes and quotes each string,
 * so two different (directory, root) pairs can never alias by concatenation.
 * Reopening the same pair always yields the same namespace.
 */
export function runnerResultsNamespace(directory: string, logicalProjectRoot: string): string {
  return digest(['runner-results', path.resolve(directory), path.resolve(logicalProjectRoot)]);
}

/** Deterministic, stable URN for one immutable command result. */
export function runnerResultUri(namespace: string, id: string): string {
  return `urn:codex-runner-result:${namespace}:${id}`;
}

/**
 * Bounded durable store of pending attempts and immutable final results.
 * Construction validates configuration; open() validates the namespace and
 * every managed record. A handle that fails to open is permanently unusable.
 */
export class RunnerResults {
  readonly directory: string;
  readonly logicalRoot: string;
  readonly namespace: string;
  readonly maxRecords: number;
  readonly maxTotalBytes: number;
  readonly maxResultBytes: number;

  private readonly mutex = new Mutex();
  private readonly namespaceFile: string;
  private readonly results = new Map<string, RunnerCommandResult>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly diagnostics: string[] = [];
  private unknownEntries: string[] = [];
  private totalBytes = 0;
  private opened = false;
  private failed = false;
  private closed = false;

  constructor(directory: string, logicalProjectRoot: string, options: RunnerResultsOptions = {}) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.length > MAX_PATH_LENGTH || !path.isAbsolute(directory)) {
      invalidPath('The runner results directory must be a non-empty absolute path.');
    }
    if (typeof logicalProjectRoot !== 'string' || logicalProjectRoot.length === 0 || logicalProjectRoot.length > MAX_PATH_LENGTH
      || !path.isAbsolute(logicalProjectRoot)) {
      invalidPath('The logical project root must be a non-empty absolute path.');
    }
    const maxRecords = options.maxRecords ?? RUNNER_RESULTS_MAX_RECORDS;
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > RUNNER_RESULTS_MAX_RECORDS) {
      throw new WorkerError('invalid_runner_results_config', `maxRecords must be an integer between 1 and ${RUNNER_RESULTS_MAX_RECORDS}.`);
    }
    const maxTotalBytes = options.maxTotalBytes ?? RUNNER_RESULTS_MAX_TOTAL_BYTES;
    if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1024 || maxTotalBytes > RUNNER_RESULTS_MAX_TOTAL_BYTES) {
      throw new WorkerError('invalid_runner_results_config', `maxTotalBytes must be an integer between 1024 and ${RUNNER_RESULTS_MAX_TOTAL_BYTES} bytes.`);
    }
    const maxResultBytes = options.maxResultBytes ?? RUNNER_RESULTS_MAX_RESULT_BYTES;
    if (!Number.isInteger(maxResultBytes) || maxResultBytes < 128 || maxResultBytes > RUNNER_RESULTS_MAX_RESULT_BYTES
      || maxResultBytes > maxTotalBytes) {
      throw new WorkerError('invalid_runner_results_config',
        `maxResultBytes must be an integer between 128 and ${RUNNER_RESULTS_MAX_RESULT_BYTES} bytes, and at most maxTotalBytes.`);
    }
    this.directory = path.resolve(directory);
    this.logicalRoot = path.resolve(logicalProjectRoot);
    this.namespace = runnerResultsNamespace(this.directory, this.logicalRoot);
    this.maxRecords = maxRecords;
    this.maxTotalBytes = maxTotalBytes;
    this.maxResultBytes = maxResultBytes;
    this.namespaceFile = path.join(this.directory, NAMESPACE_FILE);
  }

  /**
   * Validate the namespace, managed directories and every record, then recover
   * pending attempts (uncertain final result, no replay) or drop a leftover
   * pending file whose final result is already durable. Corrupt or foreign
   * state fails closed and permanently fails this handle.
   */
  async open(): Promise<void> {
    if (this.failed) {
      throw new WorkerError('runner_results_unavailable', 'This runner results handle failed to open; construct a new handle.');
    }
    await this.mutex.run(async () => {
      if (this.closed) {
        throw new WorkerError('runner_results_closed', 'This runner results store is closed.');
      }
      if (this.opened) {
        return;
      }
      try {
        await this.openLocked();
        this.opened = true;
      } catch (error) {
        this.failed = true;
        throw error;
      }
    });
  }

  /**
   * Durably record a pending attempt BEFORE the caller may execute anything.
   * The same id with the exact same attempt replays its acknowledgment (or its
   * final state); different arguments conflict. Nothing is ever executed.
   */
  async start(input: RunnerCommandAttempt): Promise<RunnerAttemptStart> {
    this.assertReady();
    const attempt = parseAttempt(input);
    if (path.resolve(attempt.logicalRoot) !== this.logicalRoot) {
      invalidAttempt('The attempt logicalRoot must match this store\'s logical project root.');
    }
    return this.mutex.run(async () => {
      // Re-check inside the serialized mutation: a close() queued between the
      // caller check above and this run must never let a pending or final
      // record be written after the store was closed.
      this.assertReady();
      const existing = this.results.get(attempt.id);
      if (existing !== undefined) {
        if (JSON.stringify(existing.attempt) !== JSON.stringify(attempt)) {
          throw new WorkerError('runner_results_conflict', `Result ${attempt.id} already records a different attempt.`);
        }
        await this.cleanupPending(attempt.id);
        return this.startSnapshot(existing.attempt, 'finished', true, existing);
      }
      const pending = this.pending.get(attempt.id);
      if (pending !== undefined) {
        if (JSON.stringify(pending.attempt) !== JSON.stringify(attempt)) {
          throw new WorkerError('runner_results_conflict', `Attempt ${attempt.id} is already pending with different arguments.`);
        }
        return this.startSnapshot(pending.attempt, 'pending', true, null);
      }
      if (await lstatOrNull(this.recordPath(PENDING_DIRECTORY, attempt.id)) !== null
        || await lstatOrNull(this.recordPath(RESULTS_DIRECTORY, attempt.id)) !== null) {
        throw new WorkerError('runner_results_conflict', `Attempt ${attempt.id} already has a durable record on disk; refusing to overwrite it.`);
      }
      const text = JSON.stringify({ schema: RUNNER_RESULTS_SCHEMA, version: RUNNER_RESULTS_VERSION, namespace: this.namespace, attempt });
      const bytes = byteLength(text);
      this.assertStartCapacity(bytes);
      await this.writeManaged(PENDING_DIRECTORY, attempt.id, text);
      this.pending.set(attempt.id, { attempt, bytes });
      this.totalBytes += bytes;
      return this.startSnapshot(attempt, 'pending', false, null);
    });
  }

  /**
   * Write one immutable final result. The first call is authoritative; an exact
   * repeat is idempotent and any conflicting final data fails without an
   * overwrite. The pending file is removed only AFTER the final is durable.
   */
  async finish(id: string, details: RunnerCommandFinish): Promise<RunnerCommandResult> {
    this.assertReady();
    const recordId = requireId(id);
    const finish = parseFinish(details);
    return this.mutex.run(async () => {
      // Same serialized re-check as start(): a close() queued first wins and no
      // final record or pending removal may happen after the store is closed.
      this.assertReady();
      const existing = this.results.get(recordId);
      if (existing !== undefined) {
        const candidate = buildResult(existing.attempt, this.namespace, finish, finish.completedAt ?? existing.completedAt);
        if (JSON.stringify(candidate) !== JSON.stringify(existing)) {
          throw new WorkerError('runner_results_conflict', `Result ${recordId} is immutable and already records different final data.`);
        }
        await this.cleanupPending(recordId);
        return existing;
      }
      const pending = this.pending.get(recordId);
      if (pending === undefined) {
        throw new WorkerError('runner_results_not_found', `Attempt ${recordId} was not started in this results store.`);
      }
      if (await lstatOrNull(this.recordPath(RESULTS_DIRECTORY, recordId)) !== null) {
        throw new WorkerError('runner_results_conflict', `Result ${recordId} already exists on disk; refusing to overwrite it.`);
      }
      const result = buildResult(pending.attempt, this.namespace, finish, finish.completedAt ?? nowIso());
      const text = JSON.stringify(result);
      const bytes = byteLength(text);
      this.assertFinishCapacity(bytes, pending.bytes);
      await this.writeManaged(RESULTS_DIRECTORY, recordId, text);
      this.results.set(recordId, result);
      this.totalBytes += bytes;
      await this.cleanupPending(recordId);
      return result;
    });
  }

  /** Authorized read of one immutable final result. */
  get(id: string, scope: RunnerResultScope): RunnerCommandResult {
    this.assertReady();
    const recordId = requireId(id);
    const validated = parseScope(scope);
    const result = this.results.get(recordId);
    if (result === undefined) {
      throw new WorkerError('runner_results_not_found', `Result ${recordId} was not found in this results store.`);
    }
    this.authorize(result, validated);
    return result;
  }

  /** Authorized page of final results, newest completed first, then id. */
  list(scope: RunnerResultScope, offset?: number, limit?: number): RunnerResultsPage {
    this.assertReady();
    const validated = parseScope(scope);
    const from = pageNumber(offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const size = pageNumber(limit, 'limit', RUNNER_RESULTS_PAGE_SIZE, 1, RUNNER_RESULTS_PAGE_SIZE);
    const authorized = [...this.results.values()]
      .filter(result => result.attempt.owner.ownerId === validated.ownerId && result.attempt.owner.teamId === validated.teamId)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.id.localeCompare(b.id));
    const results = authorized.slice(from, from + size);
    const nextOffset = from + results.length < authorized.length ? from + results.length : null;
    return Object.freeze({
      results: Object.freeze(results),
      offset: from,
      limit: size,
      total: authorized.length,
      nextOffset
    });
  }

  /** Counts, caps and unknown entries; read-only and never evicts anything. */
  status(): RunnerResultsStatus {
    if (this.failed) {
      throw new WorkerError('runner_results_unavailable', 'This runner results handle failed to open; construct a new handle.');
    }
    if (!this.opened && !this.closed) {
      throw new WorkerError('runner_results_unavailable', 'The runner results store is not open; call open() first.');
    }
    return Object.freeze({
      directory: this.directory,
      logicalRoot: this.logicalRoot,
      namespace: this.namespace,
      open: this.opened,
      closed: this.closed,
      results: this.results.size,
      pending: this.pending.size,
      totalBytes: this.totalBytes,
      maxRecords: this.maxRecords,
      maxTotalBytes: this.maxTotalBytes,
      maxResultBytes: this.maxResultBytes,
      unknownEntries: Object.freeze([...this.unknownEntries]),
      diagnostics: Object.freeze([...this.diagnostics])
    });
  }

  /** Stop accepting work. Durable records are untouched and no eviction occurs. */
  async close(): Promise<void> {
    await this.mutex.run(async () => {
      this.closed = true;
      this.opened = false;
    });
  }

  // -- internals --------------------------------------------------------------

  private async openLocked(): Promise<void> {
    await this.ensureRoot();
    const entries = (await fs.readdir(this.directory)).sort();
    const namespaceStat = await lstatOrNull(this.namespaceFile);
    if (namespaceStat === null) {
      // The atomic RENAME of namespace.json is the commit point. A hard crash
      // before it leaves exactly one kind of residue behind: this module's own
      // `<namespace.json>.<uuid>.tmp` file, from the very write that never
      // committed. Those bytes are uncommitted output, never metadata, so the
      // store may still start fresh -- but ONLY when every root entry is such a
      // temp, and only a plain regular file at the exact generated name counts.
      // Every other entry (managed records, arbitrary unknown files, a malformed
      // or linked temp name, or a directory posing as a temp) stays corruption.
      // The temps are never read, adopted, deleted or overwritten; they are
      // preserved and reported as unknown entries.
      for (const entry of entries) {
        if (!await this.isUncommittedNamespaceTemp(entry)) {
          corrupt('The results namespace metadata is missing beside existing managed or unknown entries; refusing to reset over them.');
        }
      }
      if (entries.length > 0) {
        this.diagnose(`The namespace rename never committed; ${entries.length} uncommitted namespace temp file(s) were preserved and reported.`);
      }
      await this.publishNamespace();
    } else {
      await this.readNamespace(namespaceStat);
    }
    await this.ensureManagedDirectory(PENDING_DIRECTORY);
    await this.ensureManagedDirectory(RESULTS_DIRECTORY);
    const loaded = await this.loadRecords();
    this.totalBytes = loaded.totalBytes;
    this.assertLoadedCapacity();
    await this.recoverPending();
    this.unknownEntries = await this.scanUnknown();
  }

  private async ensureRoot(): Promise<void> {
    try {
      await fs.mkdir(this.directory, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        try {
          await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        } catch (nested) {
          storage(`The runner results directory could not be created: ${nested instanceof Error ? nested.message : String(nested)}`);
        }
      } else if (code !== 'EEXIST') {
        storage(`The runner results directory could not be created: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (await plainDirectory(this.directory) !== 'plain') {
      invalidPath('The runner results directory must be a plain directory, not a symlink, junction or file.');
    }
  }

  /**
   * True only for a root entry that is EXACTLY one of this module's own
   * uncommitted namespace temps: the literal name `atomicWrite` derives from
   * `namespace.json` (canonical lowercase UUID, `.tmp` suffix) AND a plain
   * regular file on disk, never a symlink, junction, directory or special file
   * posing as one. The contents are never read: an uncommitted temp is not
   * metadata and is never adopted or trusted.
   */
  private async isUncommittedNamespaceTemp(name: string): Promise<boolean> {
    if (!NAMESPACE_TEMP_RE.test(name)) {
      return false;
    }
    const stat = await lstatOrNull(path.join(this.directory, name));
    return stat !== null && !stat.isSymbolicLink() && stat.isFile();
  }

  private async publishNamespace(): Promise<void> {
    const text = JSON.stringify({
      schema: RUNNER_RESULTS_SCHEMA,
      version: RUNNER_RESULTS_VERSION,
      namespace: this.namespace,
      directory: this.directory,
      logicalRoot: this.logicalRoot,
      revision: 0
    });
    const bytes = byteLength(text);
    if (bytes > this.maxTotalBytes) {
      capacity(`The results namespace metadata would exceed the total results byte limit of ${this.maxTotalBytes}.`);
    }
    await this.assertPlainRoot('before the namespace write');
    try {
      await atomicWrite(this.namespaceFile, text, 0o600);
    } catch (error) {
      storage(`The results namespace could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.totalBytes += bytes;
  }

  private async readNamespace(stat: Awaited<ReturnType<typeof fs.lstat>>): Promise<void> {
    if (stat.isSymbolicLink() || !stat.isFile()) {
      corrupt('The results namespace metadata must be a regular file, not a link or directory.');
    }
    if (stat.size > MAX_NAMESPACE_BYTES) {
      corrupt(`The results namespace metadata exceeds ${MAX_NAMESPACE_BYTES} bytes.`);
    }
    let text: string;
    try {
      text = await fs.readFile(this.namespaceFile, 'utf8');
    } catch (error) {
      storage(`The results namespace could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const bytes = byteLength(text);
    if (bytes > MAX_NAMESPACE_BYTES) {
      corrupt(`The results namespace metadata exceeds ${MAX_NAMESPACE_BYTES} bytes.`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      corrupt('The results namespace metadata is not valid JSON.');
    }
    parseNamespaceRecord(raw, this.directory, this.logicalRoot, this.namespace);
    this.totalBytes += bytes;
  }

  private async ensureManagedDirectory(name: string): Promise<void> {
    await this.assertPlainRoot(`before creating ${name}`);
    const target = path.join(this.directory, name);
    if (!isStrictlyInside(this.directory, target)) {
      invalidPath(`The ${name} directory is outside the results store.`);
    }
    const state = await plainDirectory(target);
    if (state === 'unsafe') {
      corrupt(`The ${name} path is not a plain directory.`);
    }
    if (state === 'missing') {
      try {
        await fs.mkdir(target, { mode: 0o700 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          storage(`The ${name} directory could not be created: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (await plainDirectory(target) !== 'plain') {
      corrupt(`The ${name} path is not a plain directory.`);
    }
  }

  private async loadRecords(): Promise<{ totalBytes: number }> {
    let total = this.totalBytes;
    const resultsDirectory = path.join(this.directory, RESULTS_DIRECTORY);
    for (const name of (await fs.readdir(resultsDirectory)).sort()) {
      const match = /^([0-9a-f]{32})\.json$/.exec(name);
      if (match === null) {
        continue;
      }
      const id = match[1];
      const text = await this.readManagedText(RESULTS_DIRECTORY, id, this.maxResultBytes, 'capacity');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        corrupt(`Result ${id} is not valid JSON.`);
      }
      const result = parseResultRecord(raw, id, this.namespace, this.logicalRoot);
      this.results.set(id, result);
      total += byteLength(text);
    }
    const pendingDirectory = path.join(this.directory, PENDING_DIRECTORY);
    for (const name of (await fs.readdir(pendingDirectory)).sort()) {
      const match = /^([0-9a-f]{32})\.json$/.exec(name);
      if (match === null) {
        continue;
      }
      const id = match[1];
      const text = await this.readManagedText(PENDING_DIRECTORY, id, this.maxResultBytes, 'capacity');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        corrupt(`Pending attempt ${id} is not valid JSON.`);
      }
      const attempt = parsePendingRecord(raw, id, this.namespace, this.logicalRoot);
      this.pending.set(id, { attempt, bytes: byteLength(text) });
      total += byteLength(text);
    }
    return { totalBytes: total };
  }

  private async readManagedText(kind: string, id: string, limit: number, overLimit: 'capacity' | 'corrupt'): Promise<string> {
    await this.assertPlainRoot(`before reading ${kind}`);
    const directory = path.join(this.directory, kind);
    if (await plainDirectory(directory) !== 'plain') {
      corrupt(`The ${kind} directory is not a plain directory.`);
    }
    const file = path.join(directory, `${id}.json`);
    if (!isStrictlyInside(this.directory, file)) {
      corrupt(`A ${kind} record path escapes the results store.`);
    }
    const stat = await lstatOrNull(file);
    if (stat === null) {
      corrupt(`A volatile ${kind} record disappeared while opening.`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      corrupt(`A ${kind} record must be a regular file, not a link or directory.`);
    }
    if (stat.size > limit) {
      if (overLimit === 'capacity') {
        capacity(`A ${kind} record exceeds ${limit} bytes.`);
      }
      corrupt(`A ${kind} record exceeds ${limit} bytes.`);
    }
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      storage(`A ${kind} record could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (byteLength(text) > limit) {
      if (overLimit === 'capacity') {
        capacity(`A ${kind} record exceeds ${limit} bytes.`);
      }
      corrupt(`A ${kind} record exceeds ${limit} bytes.`);
    }
    return text;
  }

  /**
   * Distinct attempt count across the two live maps. One attempt id can appear
   * in BOTH maps, and that is normal, expected state: a crash between the final
   * write and the pending removal (or a best-effort unlink that failed) leaves
   * the durable final AND its leftover pending behind. That is ONE attempt, so
   * counting map entries would double count it and could refuse to open a store
   * that really is within its cap. Only distinct ids consume record slots, so
   * this is the number every record cap compares against.
   */
  private attemptCount(): number {
    let records = this.results.size;
    for (const id of this.pending.keys()) {
      if (!this.results.has(id)) {
        records += 1;
      }
    }
    return records;
  }

  /**
   * Loaded caps, checked BEFORE any recovery so an over-cap store is refused
   * instead of mutated. The count is the number of DISTINCT attempts, which
   * recovery cannot change: it either drops the leftover pending of an id that
   * already has a final, or turns a pending into a result for that same id.
   */
  private assertLoadedCapacity(): void {
    const records = this.attemptCount();
    if (records > this.maxRecords) {
      capacity(`The results store holds ${records} records; the limit is ${this.maxRecords}.`);
    }
    if (this.totalBytes > this.maxTotalBytes) {
      capacity(`The results store holds ${this.totalBytes} bytes; the limit is ${this.maxTotalBytes}.`);
    }
  }

  /**
   * Pending recovery. A durable final result always wins and its leftover
   * pending file is dropped. A pending attempt with no final becomes an
   * immutable uncertain result, written before the pending file is removed.
   */
  private async recoverPending(): Promise<void> {
    for (const id of [...this.pending.keys()].sort()) {
      const entry = this.pending.get(id);
      if (entry === undefined) {
        continue;
      }
      const existing = this.results.get(id);
      if (existing !== undefined) {
        if (await this.cleanupPending(id)) {
          this.diagnose(`Pending attempt ${id} was dropped because its final result was already durable.`);
        }
        continue;
      }
      const finish: NormalizedFinish = Object.freeze({
        outcome: 'uncertain',
        afterVersion: null,
        import: 'uncertain',
        exitCode: null,
        signal: null,
        output: '',
        truncated: false,
        drained: false,
        diagnostic: RECOVERY_DIAGNOSTIC
      });
      const result = buildResult(entry.attempt, this.namespace, finish, nowIso());
      const text = JSON.stringify(result);
      const bytes = byteLength(text);
      if (bytes > this.maxResultBytes) {
        capacity(`Recovered result ${id} would exceed ${this.maxResultBytes} bytes.`);
      }
      if (this.totalBytes - entry.bytes + bytes > this.maxTotalBytes) {
        capacity(`Recovered result ${id} would exceed the total results byte limit.`);
      }
      await this.writeManaged(RESULTS_DIRECTORY, id, text);
      this.results.set(id, result);
      this.totalBytes += bytes;
      if (await this.cleanupPending(id)) {
        this.diagnose(`Pending attempt ${id} was recovered as uncertain after restart; it was not replayed.`);
      }
    }
  }

  private async writeManaged(kind: string, id: string, text: string): Promise<void> {
    await this.assertPlainRoot(`before writing ${kind}`);
    const directory = path.join(this.directory, kind);
    if (await plainDirectory(directory) !== 'plain') {
      corrupt(`The ${kind} directory is not a plain directory.`);
    }
    const file = path.join(directory, `${id}.json`);
    if (!isStrictlyInside(this.directory, file)) {
      invalidPath(`A ${kind} record path escapes the results store.`);
    }
    try {
      await atomicWrite(file, text, 0o600);
    } catch (error) {
      storage(`A ${kind} record could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private recordPath(kind: string, id: string): string {
    return path.join(this.directory, kind, `${id}.json`);
  }

  /** Remove a pending file only after proving its parent chain; best effort. */
  private async cleanupPending(id: string): Promise<boolean> {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return false;
    }
    try {
      await this.assertPlainRoot('before removing a pending attempt');
      const directory = path.join(this.directory, PENDING_DIRECTORY);
      if (await plainDirectory(directory) !== 'plain') {
        corrupt('The pending directory is not a plain directory.');
      }
      const file = this.recordPath(PENDING_DIRECTORY, id);
      if (!isStrictlyInside(this.directory, file)) {
        corrupt('A pending record path escapes the results store.');
      }
      const stat = await lstatOrNull(file);
      if (stat !== null) {
        if (stat.isSymbolicLink() || !stat.isFile()) {
          corrupt('A pending record must be a regular file.');
        }
        try {
          await fs.unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }
      this.pending.delete(id);
      this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
      return true;
    } catch (error) {
      this.diagnose(`Pending attempt ${id} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async scanUnknown(): Promise<string[]> {
    const unknown: string[] = [];
    for (const name of (await fs.readdir(this.directory)).sort()) {
      if (name !== NAMESPACE_FILE && name !== PENDING_DIRECTORY && name !== RESULTS_DIRECTORY) {
        unknown.push(name);
      }
    }
    for (const kind of [PENDING_DIRECTORY, RESULTS_DIRECTORY]) {
      const directory = path.join(this.directory, kind);
      const stat = await lstatOrNull(directory);
      if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
        continue;
      }
      for (const name of (await fs.readdir(directory)).sort()) {
        if (!/^[0-9a-f]{32}\.json$/.test(name)) {
          unknown.push(path.join(kind, name));
        }
      }
    }
    return unknown;
  }

  private async assertPlainRoot(label: string): Promise<void> {
    if (await plainDirectory(this.directory) !== 'plain') {
      corrupt(`The results store root is not a plain directory ${label}.`);
    }
  }

  private assertStartCapacity(pendingBytes: number): void {
    // Same distinct-id count as the loaded check: a leftover pending whose id
    // already has a final is not a second attempt, but a NEW distinct id is
    // still refused once the store is at its limit.
    const records = this.attemptCount();
    if (records + 1 > this.maxRecords) {
      capacity(`The results store already holds ${records} records; the limit is ${this.maxRecords}.`);
    }
    if (pendingBytes > this.maxResultBytes) {
      capacity(`A pending attempt would exceed ${this.maxResultBytes} bytes.`);
    }
    if (this.totalBytes + pendingBytes > this.maxTotalBytes) {
      capacity(`A pending attempt would exceed the total results byte limit of ${this.maxTotalBytes}.`);
    }
  }

  private assertFinishCapacity(resultBytes: number, pendingBytes: number): void {
    if (resultBytes > this.maxResultBytes) {
      capacity(`A final result would exceed ${this.maxResultBytes} bytes.`);
    }
    const finalBytes = this.totalBytes - pendingBytes + resultBytes;
    if (finalBytes > this.maxTotalBytes || this.totalBytes + resultBytes > this.maxTotalBytes) {
      capacity(`A final result would exceed the total results byte limit of ${this.maxTotalBytes}.`);
    }
    if (this.results.size + 1 > this.maxRecords) {
      capacity(`The results store would exceed ${this.maxRecords} final records.`);
    }
  }

  private startSnapshot(attempt: RunnerCommandAttempt, state: 'pending' | 'finished', replayed: boolean,
    result: RunnerCommandResult | null): RunnerAttemptStart {
    return Object.freeze({ id: attempt.id, state, replayed, attempt, result });
  }

  private authorize(result: RunnerCommandResult, scope: RunnerResultScope): void {
    if (result.attempt.owner.ownerId !== scope.ownerId || result.attempt.owner.teamId !== scope.teamId) {
      throw new WorkerError('runner_results_denied', `Result ${result.id} is not visible to this scope.`);
    }
  }

  private diagnose(message: string): void {
    if (this.diagnostics.length < MAX_STORE_DIAGNOSTICS) {
      this.diagnostics.push(message.slice(0, MAX_DIAGNOSTIC_LENGTH));
    }
  }

  private assertReady(): void {
    if (this.failed) {
      throw new WorkerError('runner_results_unavailable', 'This runner results handle failed to open; construct a new handle.');
    }
    if (this.closed) {
      throw new WorkerError('runner_results_closed', 'This runner results store is closed.');
    }
    if (!this.opened) {
      throw new WorkerError('runner_results_unavailable', 'The runner results store is not open; call open() first.');
    }
  }
}
