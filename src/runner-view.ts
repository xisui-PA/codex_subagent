import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { LayeredTree, type Delta } from './layered-tree';
import type { IsolatedViewState } from './isolated-view-port';
import {
  EXCLUDED_DIRECTORY_NAMES, EXECUTABLE_FILE_MODE, PROTECTED_COMPONENT_NAMES,
  fileModeFromPermissions, fileModeOf, isFileMode, type FileMode, type SnapshotEntry
} from './snapshot-content';
import { WorkerError } from './types';

// ---------------------------------------------------------------------------
// Bounded runner-view helper: exact materialization and single-delta import.
//
// This module owns NO process, pool, host, tool or persistence concern. It has
// exactly two independent, reviewable outcomes:
//
//  materializeRunnerView(view, directory, guard)
//    Writes the COMPLETE supported namespace of one immutable
//    IsolatedViewState into an empty, real, plain directory, reading bytes
//    only through view.read (never the live project and never a fallback).
//    Directories are plain directories and files are created exclusively as
//    ordinary files with their raw bytes and recorded mode; nothing is ever
//    hard-linked, copied from the workspace or left out:
//      - `excluded` markers occupy no filesystem path (they were never part
//        of the view's visible namespace);
//      - `unsupported` entries fail setup explicitly, so no silently
//        incomplete command view can ever be published;
//      - the target directory and its existing ancestors must be plain
//        directories, and the target must be empty (no preexisting content).
//    The returned baseline identity is the durable proof of what was
//    materialized: the authoritative per-path hash/size/mode (including the
//    documented legacy "no mode" shape), the directory list, a stable content
//    fingerprint, and the physical identity (device/inode of the opened
//    handle) of every plain file it created. It is what a later import uses to
//    keep executable metadata stable where stat() cannot represent the execute
//    bit.
//
//  importRunnerView(view, directory, put, guard, baseline?)
//    Scans a drained command directory and plans ONE supported Delta for
//    changed, new, deleted and renamed files AND directories. Bytes, BOM,
//    CRLF and binary data are preserved verbatim because files are read as
//    raw buffers, never decoded. No overlay write happens here: the caller
//    invokes this inside port.edit so its exact-revision check and its own
//    publish step stay authoritative. Every stored change is verified
//    against the authoritative hash (put() must return exactly the SHA-256 of
//    the bytes it was handed) before it can enter the delta.
//    The delta is validated atomically as one merged revision through
//    LayeredTree before it is returned.
//
// Namespace rules:
//  - `.git`, `.codex` and `.vscode` are never imported and never traversed.
//  - The snapshot exclusion names (node_modules, dist, build, coverage,
//    vendor, case-insensitive) are EPHEMERAL OUTPUTS only when they name a
//    DIRECTORY: such a directory that the input view does not already expose
//    is ignored entirely (never descended) and never contaminates the delta.
//    A regular FILE with such a basename is ordinary source: it imports with
//    its bytes, line endings and mode like any other file, exactly as capture
//    and the private file tools treat it (they exclude those names for
//    directories only). Every supported file the input view already exposes
//    stays visible and importable even when it sits at a path whose name
//    matches an output pattern.
//  - Other dot-directories are ordinary source and are imported normally
//    (captureContent's dot-directory exclusion is NOT used here).
//  - `excluded`/`unsupported` markers are preserved: absence in the command
//    directory never tombstones them, so a marker only ever changes when the
//    command really produced supported content at that exact path. A
//    directory that still holds such a marker therefore stays in the
//    namespace instead of being tombstoned with its visible siblings.
//  - Symlinks, junctions and special files are never followed or traversed; a
//    supported source change that is one of them fails explicitly so the
//    caller can preserve (quarantine) the runner instead of importing a
//    partial namespace.
//
//  - Recorded modes survive an import without being guessed. The path match is
//    authoritative; a path with no view entry is resolved in strict order by
//    the baseline's exact materialization identity (dev/ino of the created
//    file), then by content-identical deleted files ONLY when every candidate
//    records the same mode, and otherwise as a genuinely new file (POSIX reads
//    the disk execute bit; elsewhere no mode is recorded, the documented 0o644
//    default). A 0o755/0o644 content ambiguity is never resolved by picking
//    one. A baseline without physical identity is accepted, with content
//    inference and path matches still available.
//
// Consistency and safety: every scan is repeated and only two byte-identical
// complete scans are published (bounded retries, then an explicit
// `runner_view_inconsistent`). Files are read with no-follow and non-blocking
// open flags where the platform supports them (a FIFO swapped in after the
// lstat cannot block the import), and the opened handle identity (device,
// inode, size, type) plus the post-read identity must match the pre-open
// lstat, so a swap can never smuggle outside content into the delta. Capacity
// is enforced against the existing capture caps (10k files, 20k entries,
// 32 MiB per file, 512 MiB total) and is never truncated.
// ---------------------------------------------------------------------------

/** Existing capture caps reused verbatim; violations are explicit, never truncated. */
export const RUNNER_VIEW_LIMITS = {
  maxFiles: 10_000,
  maxEntries: 20_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  /** Two complete matching scans are required per import attempt. */
  scanAttempts: 2
} as const;

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_PATH_LENGTH = 4_096;
const MAX_SEGMENT_LENGTH = 255;
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

// Function declarations (not arrow constants) so TypeScript terminates control
// flow after them and narrows the surrounding branches.
function invalidPath(message: string): never {
  throw new WorkerError('invalid_path', message);
}

function unsupported(message: string): never {
  throw new WorkerError('runner_view_unsupported', message);
}

function capacity(message: string): never {
  throw new WorkerError('runner_view_capacity', message);
}

function inconsistent(message: string): never {
  throw new WorkerError('runner_view_inconsistent', message);
}

function unsafeDirectory(message: string): never {
  throw new WorkerError('runner_view_directory_unsafe', message);
}

function staleBaseline(message: string): never {
  throw new WorkerError('runner_view_baseline_stale', message);
}

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const isProtectedName = (name: string): boolean => PROTECTED_COMPONENT_NAMES.has(name.toLowerCase());
const isOutputName = (name: string): boolean => EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase());
const hasControl = (value: string): boolean =>
  [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/**
 * Read flags for one command output file, matching the capture reader:
 * O_NOFOLLOW where the platform has it, plus O_NONBLOCK where available so a
 * FIFO/special file swapped in between the lstat and this open can never block
 * the import forever. The sum (not a bitwise or) keeps the repository's
 * no-bitwise rule while staying identical to `O_RDONLY | flag` because
 * O_RDONLY is zero.
 */
function readOpenFlags(): number {
  const optional = (name: string): number => {
    const value = (constants as unknown as Record<string, number | undefined>)[name];
    return typeof value === 'number' ? value : 0;
  };
  return constants.O_RDONLY + optional('O_NOFOLLOW') + optional('O_NONBLOCK');
}

/** One root-relative path component cannot be materialized portably. */
function segmentProblem(segment: string): string | null {
  if (segment.length === 0) {
    return 'it has an empty component';
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    return 'a component is longer than 255 characters';
  }
  if (hasControl(segment)) {
    return 'it contains a control character';
  }
  if (segment.includes(':')) {
    return 'it contains a colon';
  }
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code === 34 || code === 42 || code === 60 || code === 62 || code === 63 || code === 124) {
      return 'it contains a Windows-forbidden character';
    }
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return 'a component ends with a dot or a space';
  }
  if (RESERVED_NAMES.has(segment.split('.')[0].toLowerCase())) {
    return 'it is a reserved device name';
  }
  return null;
}

/** Validates one root-relative POSIX key for portability; returns it unchanged. */
function requirePortableKey(key: string, what: string): string {
  if (key.length > MAX_PATH_LENGTH) {
    unsupported(`${what} path is longer than ${MAX_PATH_LENGTH} characters.`);
  }
  if (key.includes('\\')) {
    unsupported(`${what} path contains a backslash: ${key}`);
  }
  for (const segment of key.split('/')) {
    const problem = segmentProblem(segment);
    if (problem !== null) {
      unsupported(`${what} path is not portable because ${problem}: ${key}`);
    }
  }
  return key;
}

/** A key this module may create, replace or delete: portable and unprotected. */
function requireMutableKey(key: string, what: string): string {
  requirePortableKey(key, what);
  if (key.split('/').some(isProtectedName)) {
    unsupported(`${what} path touches a protected configuration component: ${key}`);
  }
  return key;
}

/** Native path for a validated root-relative POSIX key. */
const toNative = (root: string, key: string): string => path.join(root, ...key.split('/'));

function requireAbsoluteDirectory(directory: string): string {
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > MAX_PATH_LENGTH || !path.isAbsolute(directory)) {
    invalidPath('The runner view directory must be a nonempty absolute path.');
  }
  return path.resolve(directory);
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Every existing ancestor of the target must be a plain directory, never a link. */
async function requirePlainAncestors(target: string): Promise<void> {
  for (let cursor = path.dirname(target); ; cursor = path.dirname(cursor)) {
    const stat = await lstatOrNull(cursor);
    if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) {
      unsafeDirectory(`The runner view directory has a non-plain ancestor: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/**
 * Immutable identity of one materialized file: the recorded content metadata
 * (authoritative, per path) plus the physical identity of the plain file this
 * module created (`dev`/`ino` of the opened handle). `mode` null means "no mode
 * recorded" (the documented 0o644 legacy default).
 *
 * The physical identity exists only so a later import can recognize the SAME
 * materialized file after a rename (and even after its bytes changed), which is
 * the only way to keep an executable mode stable on a platform whose stat()
 * cannot report the execute bit. It is optional, so a legacy baseline without
 * it is still accepted.
 */
export interface RunnerViewFileIdentity {
  readonly hash: string;
  readonly size: number;
  readonly mode: FileMode | null;
  readonly dev?: number;
  readonly ino?: number;
}

/**
 * Durable proof of one materialization: which path was filled, from which
 * revision, with which exact per-file identity. It carries the recorded mode
 * (or its documented absence) so a later import can keep executable metadata
 * stable on platforms whose stat() cannot report the execute bit, and the
 * physical identity of each created plain file so a rename is recognizable even
 * when the content changed afterwards.
 */
export interface RunnerViewBaselineIdentity {
  readonly directory: string;
  readonly revision: number;
  readonly platform: NodeJS.Platform;
  readonly files: number;
  readonly bytes: number;
  /** Prototype-less canonical path -> identity (file entries only). */
  readonly entries: Readonly<Record<string, RunnerViewFileIdentity>>;
  /** Sorted directory keys, parents before children. */
  readonly directoryEntries: readonly string[];
  /**
   * Stable digest of the content namespace (directory, revision, per-path
   * hash/size/mode, directories). The physical identity is deliberately
   * excluded: device/inode values are unique per materialization, so including
   * them would make two equivalent baselines incomparable.
   */
  readonly fingerprint: string;
}

interface PlannedFile {
  readonly hash: string;
  readonly size: number;
  readonly mode: FileMode | undefined;
}

interface ViewNamespacePlan {
  readonly directories: readonly string[];
  readonly files: Map<string, PlannedFile>;
  /** `excluded` markers: no filesystem path, never tombstoned. */
  readonly markers: readonly string[];
  /** `unsupported` entries: setup refuses them, import preserves them. */
  readonly unsupportedEntries: readonly string[];
  readonly bytes: number;
  readonly entryCount: number;
}

/** Validates and measures the complete supported namespace of one view. */
function planViewNamespace(tree: LayeredTree): ViewNamespacePlan {
  const keys = Object.keys(tree.entries).sort();
  const directories: string[] = [];
  const files = new Map<string, PlannedFile>();
  const markers: string[] = [];
  const unsupportedEntries: string[] = [];
  let bytes = 0;
  for (const key of keys) {
    requirePortableKey(key, 'Snapshot entry');
    const entry = tree.entries[key];
    if (entry === undefined) {
      inconsistent(`Snapshot entry ${key} disappeared while planning the runner view.`);
    }
    if (entry.type === 'excluded') {
      markers.push(key);
      continue;
    }
    if (entry.type === 'unsupported') {
      unsupportedEntries.push(key);
      continue;
    }
    requireMutableKey(key, 'Snapshot entry');
    if (entry.type === 'directory') {
      directories.push(key);
      continue;
    }
    if (!HASH_RE.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      inconsistent(`Snapshot entry ${key} has invalid content metadata.`);
    }
    if (entry.mode !== undefined && !isFileMode(entry.mode)) {
      inconsistent(`Snapshot entry ${key} records an invalid file mode.`);
    }
    if (entry.size > RUNNER_VIEW_LIMITS.maxFileBytes) {
      capacity(`Snapshot entry ${key} is ${entry.size} bytes; the per-file limit is ${RUNNER_VIEW_LIMITS.maxFileBytes}.`);
    }
    bytes += entry.size;
    if (bytes > RUNNER_VIEW_LIMITS.maxTotalBytes) {
      capacity(`The runner view exceeds the ${RUNNER_VIEW_LIMITS.maxTotalBytes} byte total limit.`);
    }
    files.set(key, { hash: entry.hash, size: entry.size, mode: entry.mode });
  }
  if (files.size > RUNNER_VIEW_LIMITS.maxFiles) {
    capacity(`The runner view has ${files.size} files; the limit is ${RUNNER_VIEW_LIMITS.maxFiles}.`);
  }
  if (keys.length > RUNNER_VIEW_LIMITS.maxEntries) {
    capacity(`The runner view has ${keys.length} entries; the limit is ${RUNNER_VIEW_LIMITS.maxEntries}.`);
  }
  return { directories, files, markers, unsupportedEntries, bytes, entryCount: keys.length };
}

/** Ensures a missing target is created and an existing one is empty and plain. */
async function prepareEmptyDirectory(target: string): Promise<void> {
  const stat = await lstatOrNull(target);
  if (stat === null) {
    try {
      await fs.mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
    unsafeDirectory(`The runner view directory is not a plain directory: ${target}`);
  } else {
    const existing = await fs.readdir(target);
    if (existing.length > 0) {
      throw new WorkerError('runner_view_directory_not_empty',
        `The runner view directory already holds ${existing.length} entries; an empty directory is required.`);
    }
  }
  const confirmed = await lstatOrNull(target);
  if (confirmed === null || confirmed.isSymbolicLink() || !confirmed.isDirectory()) {
    unsafeDirectory(`The runner view directory is not a plain directory: ${target}`);
  }
}

/** Best-effort removal of a failed materialization; the directory itself is kept. */
async function discardMaterialization(target: string): Promise<void> {
  try {
    for (const name of await fs.readdir(target)) {
      await fs.rm(path.join(target, name), { recursive: true, force: true });
    }
  } catch {
    // Best effort only: the caller quarantines a directory it cannot verify.
  }
}

/**
 * Freeze the baseline. `physical` holds the device/inode of every plain file
 * this module created, read from the opened handle after the bytes were written
 * (so it describes the file that actually exists, not a path guess).
 */
function freezeBaseline(
  target: string,
  revision: number,
  plan: ViewNamespacePlan,
  physical: ReadonlyMap<string, { readonly dev: number; readonly ino: number }>
): RunnerViewBaselineIdentity {
  const entries = Object.create(null) as Record<string, RunnerViewFileIdentity>;
  for (const [key, file] of plan.files) {
    const identity = physical.get(key);
    entries[key] = Object.freeze(identity === undefined
      ? { hash: file.hash, size: file.size, mode: file.mode ?? null }
      : { hash: file.hash, size: file.size, mode: file.mode ?? null, dev: identity.dev, ino: identity.ino });
  }
  const directoryEntries = Object.freeze([...plan.directories]);
  const fingerprint = sha256(JSON.stringify({
    directory: target,
    revision,
    entries: Object.keys(entries).sort().map(key => [key, entries[key].hash, entries[key].size, entries[key].mode]),
    directories: directoryEntries
  }));
  return Object.freeze({
    directory: target,
    revision,
    platform: process.platform,
    files: plan.files.size,
    bytes: plan.bytes,
    entries: Object.freeze(entries),
    directoryEntries,
    fingerprint
  });
}

/**
 * Materializes the complete supported namespace of one immutable view into an
 * empty plain directory. Bytes come only from view.read; the guard is checked
 * after every await and immediately before every write.
 */
export async function materializeRunnerView(
  view: IsolatedViewState,
  directory: string,
  guard: () => void
): Promise<RunnerViewBaselineIdentity> {
  guard();
  const target = requireAbsoluteDirectory(directory);
  const plan = planViewNamespace(view.tree);
  if (plan.unsupportedEntries.length > 0) {
    unsupported(`The view contains unsupported entry ${plan.unsupportedEntries[0]}; a complete command view cannot be materialized.`);
  }
  guard();
  await requirePlainAncestors(target);
  guard();
  await prepareEmptyDirectory(target);
  guard();
  const physical = new Map<string, { dev: number; ino: number }>();
  try {
    for (const key of plan.directories) {
      guard();
      await fs.mkdir(toNative(target, key));
      guard();
    }
    for (const [key, entry] of plan.files) {
      guard();
      const absolute = toNative(target, key);
      const read = await view.read(key);
      guard();
      if (createHash('sha256').update(read.bytes).digest('hex') !== entry.hash || read.bytes.length !== entry.size) {
        throw new WorkerError('snapshot_content_missing',
          `Immutable content for ${key} does not match its recorded hash and size; refusing an incomplete runner view.`);
      }
      guard();
      const mode = fileModeOf(entry);
      let handle;
      try {
        handle = await fs.open(absolute, 'wx', mode);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new WorkerError('runner_view_directory_not_empty',
            `The runner view directory gained an entry at ${key}; an empty directory is required.`);
        }
        throw error;
      }
      try {
        await handle.writeFile(read.bytes);
        // chmod after the write so a restrictive umask can never drop the
        // execute bit; raw bytes are never transcoded or re-normalized.
        await handle.chmod(mode);
        guard();
        // Physical identity of the plain file that was actually created, read
        // from the open handle (never inferred from the path), for later
        // rename recognition.
        const created = await handle.stat();
        if (!created.isFile()) {
          throw new WorkerError('runner_view_directory_unsafe',
            `The runner view entry ${key} is no longer an ordinary file.`);
        }
        physical.set(key, { dev: created.dev, ino: created.ino });
      } finally {
        await handle.close();
      }
      guard();
    }
  } catch (error) {
    await discardMaterialization(target);
    throw error;
  }
  guard();
  return freezeBaseline(target, view.revision, plan, physical);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** One ephemeral-output or protected-path diagnostic; never part of the delta. */
export interface RunnerViewIgnoredPath {
  readonly path: string;
  readonly reason: string;
}

/** One detected rename (files inside a reported directory rename are folded in). */
export interface RunnerViewRename {
  readonly kind: 'file' | 'directory';
  readonly from: string;
  readonly to: string;
}

/** Planned import: exactly one supported Delta plus reviewable diagnostics. */
export interface RunnerViewImportResult {
  /** One delta for the exact input revision; the caller persists it inside port.edit. */
  readonly changes: Delta;
  /** Every delta key, sorted. */
  readonly changedPaths: readonly string[];
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly renames: readonly RunnerViewRename[];
  /** Newly generated dependency/build output that was ignored entirely. */
  readonly ignoredOutputs: readonly RunnerViewIgnoredPath[];
  /** `.git`, `.codex` and `.vscode` output that was never traversed or imported. */
  readonly ignoredProtected: readonly string[];
  readonly unchanged: number;
  /** Total bytes handed to put() for this delta. */
  readonly bytes: number;
  /** Input view revision this delta applies to (the caller's exact-revision parent). */
  readonly revision: number;
}

interface ScannedFile {
  readonly hash: string;
  readonly size: number;
  readonly diskMode: FileMode;
  /** Physical identity of the scanned plain file (from the opened handle). */
  readonly dev: number;
  readonly ino: number;
}

interface ScannedTree {
  readonly files: Map<string, ScannedFile>;
  readonly directories: readonly string[];
  /** Raw bytes for files whose content must be stored (kept only by the accepted scan). */
  readonly kept: Map<string, Buffer>;
  readonly ignoredOutputs: readonly RunnerViewIgnoredPath[];
  readonly ignoredProtected: readonly string[];
  readonly signature: string;
}

type ViewFileEntry = Extract<SnapshotEntry, { type: 'file' }>;

const visibleInView = (tree: LayeredTree, key: string): boolean => {
  const resolved = tree.resolve(key);
  if (resolved === undefined) {
    return false;
  }
  const entry = tree.entries[resolved];
  return entry !== undefined && (entry.type === 'file' || entry.type === 'directory');
};

const fileEntryAt = (tree: LayeredTree, key: string): ViewFileEntry | undefined => {
  const resolved = tree.resolve(key);
  if (resolved === undefined) {
    return undefined;
  }
  const entry = tree.entries[resolved];
  return entry !== undefined && entry.type === 'file' ? entry : undefined;
};

const needsStoredBytes = (tree: LayeredTree, key: string, content: { hash: string }): boolean => {
  const entry = fileEntryAt(tree, key);
  return entry === undefined || entry.hash !== content.hash;
};

/**
 * Reads one command output file as raw bytes with no-follow and non-blocking
 * open flags. The pre-open lstat identity must match the opened handle, and the
 * post-read identity must match again, so a swapped file can never be imported
 * and a FIFO swapped in after the lstat cannot block the import.
 */
async function readStableFile(
  absolute: string, before: Stats, guard: () => void
): Promise<{ bytes: Buffer; hash: string; size: number; dev: number; ino: number }> {
  let handle;
  try {
    handle = await fs.open(absolute, readOpenFlags());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      unsupported(`Command output ${absolute} was replaced by a link while reading.`);
    }
    throw error;
  }
  try {
    guard();
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      inconsistent(`Command output ${absolute} changed while it was opened; the runner directory is not stable.`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (chunk.bytesRead === 0) {
        break;
      }
      offset += chunk.bytesRead;
    }
    guard();
    const after = await handle.stat();
    if (offset !== opened.size || after.size !== opened.size || after.ino !== opened.ino
      || after.dev !== opened.dev || after.mtimeMs !== opened.mtimeMs) {
      inconsistent(`Command output ${absolute} changed while it was read; the runner directory is not stable.`);
    }
    return { bytes, hash: sha256(bytes), size: bytes.length, dev: opened.dev, ino: opened.ino };
  } finally {
    await handle.close();
  }
}

/**
 * One complete scan of the command directory. Protected components are never
 * traversed, ephemeral-output DIRECTORIES are skipped (never descended), and
 * every other entry must be a plain directory or an ordinary file. A regular
 * file is always read, including one whose basename matches an output pattern:
 * capture and the private file tools exclude those names for directories only.
 */
async function scanRunnerDirectory(directory: string, tree: LayeredTree, guard: () => void, keep: boolean): Promise<ScannedTree> {
  const files = new Map<string, ScannedFile>();
  const directories: string[] = [];
  const kept = new Map<string, Buffer>();
  const ignoredOutputs: RunnerViewIgnoredPath[] = [];
  const ignoredProtected: string[] = [];
  let entryCount = 0;
  let totalBytes = 0;
  const pending: string[] = [''];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    guard();
    const base = current === '' ? directory : toNative(directory, current);
    const names = (await fs.readdir(base)).sort();
    guard();
    for (const name of names) {
      const key = current === '' ? name : `${current}/${name}`;
      entryCount += 1;
      if (entryCount > RUNNER_VIEW_LIMITS.maxEntries) {
        capacity(`The runner directory has more than ${RUNNER_VIEW_LIMITS.maxEntries} entries.`);
      }
      requirePortableKey(key, 'Command output');
      const absolute = path.join(base, name);
      const stat = await fs.lstat(absolute);
      guard();
      if (stat.isSymbolicLink()) {
        unsupported(`Command output ${key} is a link or junction; unsupported source changes must be resolved before import.`);
      }
      if (stat.isDirectory()) {
        if (isProtectedName(name)) {
          ignoredProtected.push(key);
          continue;
        }
        if (!visibleInView(tree, key) && isOutputName(name)) {
          ignoredOutputs.push({ path: key, reason: 'ephemeral-output-directory' });
          continue;
        }
        directories.push(key);
        pending.push(key);
        continue;
      }
      if (!stat.isFile()) {
        unsupported(`Command output ${key} is not an ordinary file; unsupported source changes must be resolved before import.`);
      }
      if (isProtectedName(name)) {
        ignoredProtected.push(key);
        continue;
      }
      // An ordinary file is ordinary source even when its basename matches an
      // output pattern: capture and the private file tools exclude those names
      // for directories only, so dropping it here would silently lose a
      // supported file the command really created (and still report success).
      if (stat.size > RUNNER_VIEW_LIMITS.maxFileBytes) {
        capacity(`Command output ${key} is ${stat.size} bytes; the per-file limit is ${RUNNER_VIEW_LIMITS.maxFileBytes}.`);
      }
      totalBytes += stat.size;
      if (totalBytes > RUNNER_VIEW_LIMITS.maxTotalBytes) {
        capacity(`Command output exceeds the ${RUNNER_VIEW_LIMITS.maxTotalBytes} byte total limit.`);
      }
      const content = await readStableFile(absolute, stat, guard);
      guard();
      files.set(key, {
        hash: content.hash, size: content.size, diskMode: fileModeFromPermissions(stat.mode), dev: content.dev, ino: content.ino
      });
      if (keep && needsStoredBytes(tree, key, content)) {
        kept.set(key, content.bytes);
      }
    }
  }
  if (files.size > RUNNER_VIEW_LIMITS.maxFiles) {
    capacity(`The runner directory has ${files.size} files; the limit is ${RUNNER_VIEW_LIMITS.maxFiles}.`);
  }
  const signature = sha256(JSON.stringify({
    files: [...files.entries()].sort(),
    directories: [...directories].sort(),
    ignoredOutputs: ignoredOutputs.map(output => [output.path, output.reason]).sort(),
    ignoredProtected: [...ignoredProtected].sort()
  }));
  return { files, directories, kept, ignoredOutputs, ignoredProtected, signature };
}

/** Two complete matching scans are required; a changing tree is never published. */
async function scanUntilStable(directory: string, tree: LayeredTree, guard: () => void): Promise<ScannedTree> {
  for (let attempt = 0; attempt < RUNNER_VIEW_LIMITS.scanAttempts; attempt += 1) {
    const hashesOnly = await scanRunnerDirectory(directory, tree, guard, false);
    guard();
    const withBytes = await scanRunnerDirectory(directory, tree, guard, true);
    guard();
    if (hashesOnly.signature === withBytes.signature) {
      return withBytes;
    }
  }
  inconsistent(`The runner directory changed across ${RUNNER_VIEW_LIMITS.scanAttempts * 2} complete scans; refusing to publish a partial change set.`);
}

/** Mode an imported file must record: POSIX execute bits win, Windows keeps the recorded mode. */
function importedFileMode(existing: { readonly mode?: FileMode }, diskMode: FileMode, posix: boolean): FileMode | undefined {
  if (!posix) {
    return existing.mode;
  }
  return diskMode === fileModeOf(existing) ? existing.mode : diskMode;
}

/** Physical identity key of one created plain file (device + inode). */
const physicalKey = (dev: number, ino: number): string => `${dev}:${ino}`;

/** Content identity key used only as a fallback when no physical identity matches. */
const contentSignature = (value: { readonly hash: string; readonly size: number }): string => `${value.hash}:${value.size}`;

/** The view's own case sensitivity, probed without any filesystem access. */
function inferCaseInsensitive(tree: LayeredTree): boolean {
  for (const key of Object.keys(tree.entries)) {
    if (key.toLowerCase() !== key) {
      return tree.resolve(key.toLowerCase()) === key;
    }
  }
  return process.platform === 'win32';
}

/**
 * A supplied baseline must still describe the exact same view and directory.
 * The per-path hash/size/mode stay authoritative; the optional physical
 * identity (dev/ino) is validated for shape only, so a legacy baseline without
 * it is still accepted.
 */
function requireMatchingBaseline(view: IsolatedViewState, plan: ViewNamespacePlan, target: string, baseline: RunnerViewBaselineIdentity): void {
  if (baseline.directory !== target) {
    staleBaseline('The runner view baseline was materialized into a different directory; re-materialize the runner view.');
  }
  if (baseline.revision !== view.revision) {
    staleBaseline(`The runner view baseline was materialized from revision ${String(baseline.revision)} but the view is revision ${String(view.revision)}; re-materialize the runner view.`);
  }
  if (Object.keys(baseline.entries).length !== plan.files.size || baseline.directoryEntries.length !== plan.directories.length) {
    staleBaseline('The runner view baseline describes a different namespace size; re-materialize the runner view.');
  }
  const directories = new Set(baseline.directoryEntries);
  for (const key of plan.directories) {
    if (!directories.has(key)) {
      staleBaseline(`Directory ${key} is not in the runner view baseline; re-materialize the runner view.`);
    }
  }
  for (const [key, file] of plan.files) {
    const identity = baseline.entries[key];
    if (identity === undefined || identity.hash !== file.hash || identity.size !== file.size || identity.mode !== (file.mode ?? null)) {
      staleBaseline(`File ${key} is not in the runner view baseline; re-materialize the runner view.`);
    }
    if (identity.dev !== undefined || identity.ino !== undefined) {
      if (!Number.isFinite(identity.dev) || !Number.isFinite(identity.ino)) {
        staleBaseline(`File ${key} has an invalid physical identity in the runner view baseline; re-materialize the runner view.`);
      }
    }
  }
}

/**
 * Every ancestor directory of the supplied keys. A directory that only still
 * holds a preserved marker (`excluded`/`unsupported`) must stay in the
 * namespace, because a marker can never be tombstoned and always needs a
 * parent directory.
 */
function ancestorDirectories(keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    for (let cut = key.lastIndexOf('/'); cut > 0; cut = key.lastIndexOf('/', cut - 1)) {
      out.add(key.slice(0, cut));
    }
  }
  return out;
}

/** Descendant file signature of one directory: sorted relative path, hash and size. */
function descendantSignature(prefix: string, files: Map<string, { hash: string; size: number }>): string {
  const head = `${prefix}/`;
  const out: [string, string, number][] = [];
  for (const [key, value] of files) {
    if (key.startsWith(head)) {
      out.push([key.slice(head.length), value.hash, value.size]);
    }
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(out);
}

/**
 * Reports directories whose whole content moved (identical relative paths and
 * content). Reporting only: the delta already expresses a directory rename as
 * tombstones plus directory and file entries.
 */
function detectDirectoryRenames(
  deletedDirectories: readonly string[],
  newDirectories: readonly string[],
  viewFiles: Map<string, { hash: string; size: number }>,
  scannedFiles: Map<string, { hash: string; size: number }>
): RunnerViewRename[] {
  const bySignature = new Map<string, { from: string[]; to: string[] }>();
  const note = (signature: string, kind: 'from' | 'to', key: string): void => {
    const bucket = bySignature.get(signature) ?? { from: [], to: [] };
    bucket[kind].push(key);
    bySignature.set(signature, bucket);
  };
  for (const key of [...deletedDirectories].sort()) {
    const signature = descendantSignature(key, viewFiles);
    if (signature !== '[]') {
      note(signature, 'from', key);
    }
  }
  for (const key of [...newDirectories].sort()) {
    const signature = descendantSignature(key, scannedFiles);
    if (signature !== '[]') {
      note(signature, 'to', key);
    }
  }
  const renames: RunnerViewRename[] = [];
  for (const bucket of bySignature.values()) {
    if (bucket.from.length === 1 && bucket.to.length === 1) {
      renames.push({ kind: 'directory', from: bucket.from[0], to: bucket.to[0] });
    }
  }
  return renames;
}

/**
 * Applies the planned delta to the input view and proves the merged revision is
 * exactly the intended namespace (same keys, kinds, hashes and sizes), so an
 * incomplete or self-contradictory delta can never be returned.
 */
function verifyMergedNamespace(
  root: string,
  view: IsolatedViewState,
  delta: Record<string, SnapshotEntry | null>,
  caseInsensitive: boolean,
  plan: ViewNamespacePlan,
  scan: ScannedTree
): void {
  for (const key of Object.keys(delta)) {
    requireMutableKey(key, 'Planned change');
  }
  let merged: LayeredTree;
  try {
    merged = new LayeredTree(root, view.tree.entries, [delta], { caseInsensitive });
  } catch (error) {
    if (error instanceof WorkerError) {
      inconsistent(`The planned changes would not form a valid view namespace: ${error.message}`);
    }
    throw error;
  }
  const expected = new Map<string, 'file' | 'directory' | 'marker'>();
  // Directories that only still hold a preserved marker survive the import.
  for (const key of ancestorDirectories([...plan.markers, ...plan.unsupportedEntries])) {
    expected.set(key, 'directory');
  }
  for (const key of [...plan.markers, ...plan.unsupportedEntries]) {
    expected.set(key, 'marker');
  }
  for (const key of scan.directories) {
    expected.set(key, 'directory');
  }
  for (const [key, file] of scan.files) {
    expected.set(key, 'file');
    const entry = merged.stat(key);
    if (entry === undefined || entry.type !== 'file' || entry.hash !== file.hash || entry.size !== file.size) {
      inconsistent(`The merged namespace does not carry the imported content of ${key}.`);
    }
  }
  const mergedKeys = Object.keys(merged.entries);
  if (mergedKeys.length !== expected.size) {
    inconsistent(`The merged namespace has ${mergedKeys.length} entries but ${expected.size} were expected.`);
  }
  for (const key of mergedKeys) {
    const kind = expected.get(key);
    const entry = merged.entries[key];
    if (kind === undefined) {
      inconsistent(`The merged namespace gained unexpected entry ${key}.`);
    }
    if (kind === 'directory' && entry.type !== 'directory') {
      inconsistent(`The merged namespace lost directory ${key}.`);
    }
    if (kind === 'file' && entry.type !== 'file') {
      inconsistent(`The merged namespace lost file ${key}.`);
    }
    if (kind === 'marker' && entry.type !== 'excluded' && entry.type !== 'unsupported') {
      inconsistent(`The merged namespace lost marker ${key}.`);
    }
  }
}

/**
 * Plans ONE supported Delta for a drained command directory. Nothing is
 * written here: put() stores changed bytes, and the merged result is
 * validated atomically through LayeredTree before it is returned.
 */
export async function importRunnerView(
  view: IsolatedViewState,
  directory: string,
  put: (bytes: Buffer) => Promise<string>,
  guard: () => void,
  baseline?: RunnerViewBaselineIdentity
): Promise<RunnerViewImportResult> {
  guard();
  if (typeof put !== 'function') {
    throw new WorkerError('invalid_view', 'A content put function is required to import runner changes.');
  }
  const target = requireAbsoluteDirectory(directory);
  const plan = planViewNamespace(view.tree);
  const caseInsensitive = inferCaseInsensitive(view.tree);
  guard();
  if (baseline !== undefined) {
    requireMatchingBaseline(view, plan, target, baseline);
  }
  const root = await lstatOrNull(target);
  if (root === null || root.isSymbolicLink() || !root.isDirectory()) {
    unsafeDirectory(`The runner directory is missing or not a plain directory: ${target}`);
  }
  guard();
  const scan = await scanUntilStable(target, view.tree, guard);
  const tree = view.tree;
  const entries = tree.entries;
  const posix = process.platform !== 'win32';

  const viewFileKeys = new Map<string, ViewFileEntry>();
  const viewFileSizes = new Map<string, { hash: string; size: number }>();
  for (const key of Object.keys(entries).sort()) {
    const entry = entries[key];
    if (entry.type === 'file') {
      viewFileKeys.set(key, entry);
      viewFileSizes.set(key, { hash: entry.hash, size: entry.size });
    }
  }

  const targetKeys = new Set<string>([...scan.files.keys(), ...scan.directories]);
  // A directory that still holds a preserved marker is never tombstoned: the
  // marker stays visible and always needs its parent directory.
  const preservedDirectories = ancestorDirectories([...plan.markers, ...plan.unsupportedEntries]);
  const deleted: string[] = [];
  for (const key of viewFileKeys.keys()) {
    if (!targetKeys.has(key)) {
      deleted.push(key);
    }
  }
  for (const key of plan.directories) {
    if (!targetKeys.has(key) && !preservedDirectories.has(key)) {
      deleted.push(key);
    }
  }
  deleted.sort();

  const delta = Object.create(null) as Record<string, SnapshotEntry | null>;
  const added: string[] = [];
  const modified: string[] = [];
  const renames: RunnerViewRename[] = [];
  for (const key of deleted) {
    requireMutableKey(key, 'Deleted entry');
    delta[key] = null;
  }

  // Exact materialization identity: `dev:ino` of the plain file this module
  // created. It identifies the SAME file after a rename, even when the command
  // also changed its bytes, which is what keeps a Windows execute mode stable.
  const baselineByPhysical = new Map<string, string>();
  if (baseline !== undefined) {
    for (const [key, identity] of Object.entries(baseline.entries)) {
      if (typeof identity.dev === 'number' && typeof identity.ino === 'number') {
        baselineByPhysical.set(physicalKey(identity.dev, identity.ino), key);
      }
    }
  }
  // Content-identical deleted files are only a fallback for paths with no
  // physical identity match, and only when their recorded mode is unambiguous.
  const contentCandidates = new Map<string, string[]>();
  for (const key of deleted) {
    const entry = viewFileKeys.get(key);
    if (entry === undefined) {
      continue;
    }
    const signature = contentSignature(entry);
    const bucket = contentCandidates.get(signature);
    if (bucket === undefined) {
      contentCandidates.set(signature, [key]);
    } else {
      bucket.push(key);
    }
  }
  /** Baseline paths already claimed by one imported file (never shared). */
  const claimed = new Set<string>();

  let unchanged = 0;
  let storedBytes = 0;
  for (const key of [...scan.files.keys()].sort()) {
    guard();
    const file = scan.files.get(key);
    if (file === undefined) {
      continue;
    }
    requireMutableKey(key, 'Command output');
    const resolved = tree.resolve(key);
    const resolvedEntry = resolved === undefined ? undefined : entries[resolved];
    const existing = resolvedEntry !== undefined && resolvedEntry.type === 'file' ? resolvedEntry : undefined;
    let mode: FileMode | undefined;
    let renamedFrom: string | undefined;
    if (existing !== undefined) {
      // Path match is authoritative: same path, same file.
      mode = importedFileMode(existing, file.diskMode, posix);
    } else {
      const ownerKey = baselineByPhysical.get(physicalKey(file.dev, file.ino));
      const identityEntry = ownerKey === undefined || claimed.has(ownerKey) ? undefined : viewFileKeys.get(ownerKey);
      if (ownerKey !== undefined && identityEntry !== undefined && !targetKeys.has(ownerKey)) {
        // Exact materialization identity: the SAME created file moved here.
        claimed.add(ownerKey);
        renamedFrom = ownerKey;
        mode = importedFileMode(identityEntry, file.diskMode, posix);
      } else {
        const candidates = (contentCandidates.get(contentSignature(file)) ?? []).filter(candidate => !claimed.has(candidate));
        const recorded = new Set(candidates.map(candidate => String(viewFileKeys.get(candidate)?.mode ?? 'absent')));
        const candidateEntry = candidates.length > 0 ? viewFileKeys.get(candidates[0]) : undefined;
        if (candidateEntry !== undefined && recorded.size === 1) {
          // Content-only inference: allowed ONLY when every candidate records
          // the same mode. A 0o755/0o644 mixture is never resolved by picking
          // one, so such a path stays a genuinely new file (0o644 default).
          mode = importedFileMode(candidateEntry, file.diskMode, posix);
          if (candidates.length === 1) {
            claimed.add(candidates[0]);
            renamedFrom = candidates[0];
          }
        } else {
          // Genuinely new path: POSIX execute bits are read from the disk,
          // otherwise no mode is recorded (the documented 0o644 default).
          mode = posix && file.diskMode === EXECUTABLE_FILE_MODE ? EXECUTABLE_FILE_MODE : undefined;
        }
      }
    }
    if (existing !== undefined && resolved === key && mode === existing.mode
      && existing.hash === file.hash && existing.size === file.size) {
      unchanged += 1;
      continue;
    }
    let hash = file.hash;
    const bytes = scan.kept.get(key);
    if (bytes !== undefined) {
      guard();
      const stored = await put(Buffer.from(bytes));
      guard();
      if (typeof stored !== 'string' || !HASH_RE.test(stored) || stored !== file.hash) {
        throw new WorkerError('snapshot_content_missing',
          `Stored content for ${key} does not match the imported bytes; refusing an unverifiable change.`);
      }
      hash = stored;
      storedBytes += bytes.length;
    } else if (existing === undefined || existing.hash !== file.hash) {
      inconsistent(`Verified bytes for ${key} are missing from the accepted scan; refusing an incomplete change.`);
    }
    delta[key] = mode === undefined
      ? { type: 'file', hash, size: file.size }
      : { type: 'file', hash, size: file.size, mode };
    if (existing === undefined) {
      added.push(key);
      if (renamedFrom !== undefined) {
        renames.push({ kind: 'file', from: renamedFrom, to: key });
      }
    } else {
      modified.push(key);
    }
  }

  for (const key of [...scan.directories].sort()) {
    guard();
    requireMutableKey(key, 'Command output');
    const resolved = tree.resolve(key);
    const entry = resolved === undefined ? undefined : entries[resolved];
    if (entry !== undefined && entry.type === 'directory' && resolved === key) {
      continue;
    }
    delta[key] = { type: 'directory' };
    if (entry === undefined) {
      added.push(key);
    } else {
      modified.push(key);
    }
  }

  const newDirectories = scan.directories.filter(key => tree.resolve(key) === undefined);
  // Rename reporting compares every view directory that vanished from the
  // command directory, including one that survives only because it still
  // holds a preserved marker.
  const deletedDirectories = plan.directories.filter(key => !targetKeys.has(key));
  const directoryRenames = detectDirectoryRenames(deletedDirectories, newDirectories, viewFileSizes, scan.files);
  if (directoryRenames.length > 0) {
    const covered = (key: string): boolean => directoryRenames.some(rename =>
      key === rename.from || key.startsWith(`${rename.from}/`) || key === rename.to || key.startsWith(`${rename.to}/`));
    const keptRenames = renames.filter(rename => !covered(rename.from) && !covered(rename.to));
    renames.length = 0;
    renames.push(...keptRenames, ...directoryRenames);
  }
  renames.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  verifyMergedNamespace(target, view, delta, caseInsensitive, plan, scan);
  guard();
  const changedPaths = Object.freeze(Object.keys(delta).sort());
  return Object.freeze({
    changes: Object.freeze(delta) as Delta,
    changedPaths,
    added: Object.freeze([...added].sort()),
    modified: Object.freeze([...modified].sort()),
    deleted: Object.freeze([...deleted]),
    renames: Object.freeze(renames),
    ignoredOutputs: Object.freeze([...scan.ignoredOutputs]),
    ignoredProtected: Object.freeze([...scan.ignoredProtected]),
    unchanged,
    bytes: storedBytes,
    revision: view.revision
  });
}
