// Shared project capture and immutable content resolution.
//
// captureProject() unifies the two content backings of a shared snapshot:
//  - A genuinely non-Git root is captured by captureContent() as a full
//    bounded CAS capture; the backing is { kind: 'cas' }.
//  - A Git root is captured in selection mode (stage-0 tracked entries plus
//    the default or explicitly selected untracked files) on top of the same
//    captureContent() machinery: byte-identical stage-0 data reuses the
//    repository's NATIVE blob OID (verified with Git.matches over the raw
//    bytes, so CRLF-vs-LF differences always fall through to the CAS),
//    everything else is published to the shared CAS. The backing is
//    { kind: 'git', ... } with the hash -> OID map of the FINAL manifest
//    only, so content stored during earlier retried attempts is never
//    pinned or resolvable.
//
// There is never a live-read fallback: readProjectContent() resolves
// exclusively through the persisted backing. Classification is purely
// metadata-based: a .git entry at the root or any ancestor (or the
// bare-repository signature at the root) selects the Git path even when the
// git executable is absent; only a root with no Git metadata at all is
// CAS. Unsupported layouts (alternates, partial clone/promisor, sparse
// checkout/skip-worktree) fail with an explicit isolation_unsupported
// before capture and are re-checked at every selection boundary, where a
// newly toggled layout becomes inconsistent_capture. Tracked
// symlinks/gitlinks (120000/160000), unmerged stages and other modes are
// recorded as explicit unsupported entries and never read.
//
// Every captured ordinary file also records OPTIONAL executable mode metadata
// (`mode`: 0o755 or 0o644). The working-tree mode observed on disk is always
// authoritative on POSIX, so an unstaged `chmod` (or an editor override of a
// file) is captured exactly as the working tree holds it. Windows cannot
// represent POSIX execute bits on disk at all, so there a tracked stage-0
// entry's Git INDEX mode is used instead; untracked and non-Git files fall
// back to the observed disk mode. Bytes are always stored verbatim (no
// transcoding). Manifests written before this field existed omit `mode` and
// read as 0o644 (documented legacy default).

import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { GitSnapshotError, GitSnapshotObjects, fileModeFromGitMode, runGitProbe } from './git-snapshot-objects';
import type { CapturedProject, SnapshotBacking } from './isolated-view-types';
import { captureContent, type ContentStore, type FileMode, type OpenDocument } from './snapshot-content';
import { WorkerError } from './types';

const ID_RE = /^[0-9a-f]{64}$/;
type LstatInfo = Awaited<ReturnType<typeof lstat>>;

export interface CaptureProjectOptions {
  snapshotId: string;
  namespace: string;
  /** Explicit (possibly ignored) untracked selection; omit for the default non-ignored set. */
  selectedUntracked?: readonly string[];
  openDocuments?: () => OpenDocument[];
  guard?: () => void;
  /**
   * Durable-journal hook invoked with the FULL completed candidate before
   * the snapshot ref effect (Git) or before the result is returned (CAS);
   * rejection leaves the ref absent or unchanged.
   */
  beforePublish?: (candidate: CapturedProject) => Promise<void>;
  afterScan?: (attempt: number) => void | Promise<void>;
}

const sha256Hex = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const foldKey = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);

/**
 * Which mode source is faithful on `platform`: Windows cannot represent POSIX
 * execute bits on disk, so a tracked entry's Git index mode is used there;
 * every other platform captures the working-tree mode exactly as a physical
 * runner will see it, including an unstaged chmod.
 */
export const indexModeIsAuthoritative = (platform: NodeJS.Platform = process.platform): boolean => platform === 'win32';

function assertIds(snapshotId: string, namespace: string): void {
  if (!ID_RE.test(snapshotId)) {
    throw new WorkerError('invalid_capture_options', `snapshotId must be a 64-hex-char id, got ${JSON.stringify(snapshotId)}.`);
  }
  if (!ID_RE.test(namespace)) {
    throw new WorkerError('invalid_capture_options', `namespace must be a 64-hex-char store hash, got ${JSON.stringify(namespace)}.`);
  }
}

const unsupported = (detail: string): GitSnapshotError => new GitSnapshotError('isolation_unsupported', `Unsupported Git layout: ${detail}`);

/** lstat that reports only genuinely absent paths as null; every other error propagates. */
async function lstatOrNull(target: string): Promise<LstatInfo | null> {
  try {
    return await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

/** Bare-repository signature: HEAD regular file + objects directory + config regular file. */
async function isBareGitRoot(root: string): Promise<boolean> {
  const head = await lstatOrNull(path.join(root, 'HEAD'));
  if (head === null || !head.isFile()) {
    return false;
  }
  const objects = await lstatOrNull(path.join(root, 'objects'));
  const config = await lstatOrNull(path.join(root, 'config'));
  return objects !== null && objects.isDirectory() && config !== null && config.isFile();
}

/**
 * Classify the root purely from filesystem metadata (no git invocations):
 * a .git entry at the root or an ancestor (directory, metadata file, or
 * symlink) makes the root a Git candidate, as does the bare-repository
 * signature at the root (the helper will report its unsupported worktree).
 * Only a root with no Git metadata at all is non-Git, so an ordinary
 * non-Git capture works even when the git executable is absent. ENOENT and
 * ENOTDIR are the only walked outcomes; permission and other lstat errors
 * propagate, never a silent fallback.
 */
async function classifyRoot(root: string): Promise<'git' | 'nonGit'> {
  let cursor: string | null = root;
  while (cursor !== null) {
    if (await lstatOrNull(path.join(cursor, '.git')) !== null) {
      return 'git';
    }
    if (cursor === root && (await isBareGitRoot(root))) {
      return 'git';
    }
    const parent = path.dirname(cursor);
    cursor = parent === cursor ? null : parent;
  }
  return 'nonGit';
}

/**
 * Narrow capture-support probe: sanitized argv-only git (the same isolation
 * args and scrubbed environment as every helper invocation, so no
 * repository hook, filter, or ambient GIT_* redirection can take effect)
 * plus lstat/local metadata of the git and common dirs. Config reads and
 * the index flag listing run with the PER-WORKTREE view (GIT_DIR is the
 * per-worktree dir, cwd is the worktree root), not the common dir index.
 * Only ENOENT/ENOTDIR are ignored; permission errors propagate. Throws
 * isolation_unsupported on a layout that cannot be captured correctly.
 */
async function assertCaptureSupported(objects: GitSnapshotObjects): Promise<void> {
  for (const relative of ['objects', 'objects/info', 'objects/pack']) {
    const info = await lstatOrNull(path.join(objects.commonDir, relative));
    if (info !== null && !info.isDirectory()) {
      throw unsupported(`${relative} must be a plain directory, without symlinks or junctions`);
    }
  }
  const env = { GIT_DIR: objects.gitDir, GIT_WORK_TREE: objects.root };
  const configGet = async (name: string, boolean = false): Promise<string | undefined> => {
    try {
      return (await runGitProbe(objects.root, env, ['config', ...(boolean ? ['--bool'] : []), '--get', name])).toString('utf8').trim();
    } catch (error) {
      if (error instanceof GitSnapshotError && error.code === 'git_error' && error.exitCode === 1) {
        return undefined; // Absent value.
      }
      throw error;
    }
  };
  const sparse = await configGet('core.sparseCheckout', true);
  if (sparse !== undefined && ['true', 'on', 'yes', '1'].includes(sparse.toLowerCase())) {
    throw unsupported(`core.sparseCheckout=${sparse}`);
  }
  const partial = await configGet('extensions.partialClone');
  if (partial !== undefined && partial !== '') {
    throw unsupported(`extensions.partialClone=${partial}`);
  }
  let promisorRaw = '';
  try {
    promisorRaw = (await runGitProbe(objects.root, env, ['config', '--bool', '--get-regexp', '^remote\\..*\\.promisor$'])).toString('utf8');
  } catch (error) {
    if (error instanceof GitSnapshotError && error.code === 'git_error' && error.exitCode === 1) {
      promisorRaw = ''; // No promisor remotes configured.
    } else {
      throw error;
    }
  }
  for (const line of promisorRaw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '' && /^remote\..*\.promisor true$/i.test(trimmed)) {
      throw unsupported(`promisor remote configured: ${trimmed}`);
    }
  }
  // Skip-worktree flags: the first character of `ls-files -v` records; the
  // lowercase assume-unchanged flag (h) and other ordinary flags are fine.
  const flagsRaw = await runGitProbe(objects.root, env, ['ls-files', '-v', '-z']);
  for (const record of flagsRaw.toString('utf8').split('\0')) {
    const flag = record.charCodeAt(0);
    if (record !== '' && (flag === 0x53 || flag === 0x73)) {
      throw unsupported('a skip-worktree flag is set in the index');
    }
  }
  // Object alternates: our snapshot refs cannot protect the alternate owner
  // from gc, so ANY presence (including an empty file) is unsupported.
  if (await lstatOrNull(path.join(objects.commonDir, 'objects', 'info', 'alternates')) !== null) {
    throw unsupported('object alternates are configured');
  }
  let packNames: string[];
  try {
    packNames = await readdir(path.join(objects.commonDir, 'objects', 'pack'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      packNames = [];
    } else {
      throw error;
    }
  }
  for (const name of packNames) {
    if (name.endsWith('.promisor')) {
      throw unsupported('promisor pack files are present');
    }
  }
  // Sparse-checkout definition files, in the per-worktree and common dirs.
  for (const dir of new Set([objects.gitDir, objects.commonDir])) {
    if (await lstatOrNull(path.join(dir, 'info', 'sparse-checkout')) !== null) {
      throw unsupported('a sparse-checkout definition file is present');
    }
  }
}

interface IndexRecord {
  oid: string;
  /** Literal index mode (100644/100755) for a supported stage-0 entry. */
  mode: string;
  regular: boolean;
  unmerged: boolean;
}

export async function captureProject(root: string, content: ContentStore, options: CaptureProjectOptions): Promise<CapturedProject> {
  assertIds(options.snapshotId, options.namespace);
  const guard = options.guard;
  guard?.();
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
  } catch {
    throw new WorkerError('invalid_capture_root', `Capture root cannot be resolved: ${root}`);
  }
  const kind = await classifyRoot(resolvedRoot);
  guard?.();
  if (kind === 'nonGit') {
    // Full bounded CAS capture of every eligible entry.
    const manifest = await captureContent(resolvedRoot, content, {
      openDocuments: options.openDocuments,
      afterScan: options.afterScan,
      guard
    });
    guard?.();
    const candidate: CapturedProject = Object.freeze({ manifest, backing: Object.freeze({ kind: 'cas' as const }) });
    if (options.beforePublish !== undefined) {
      await options.beforePublish(candidate);
      guard?.();
    }
    return candidate;
  }
  return captureGitProject(resolvedRoot, content, options, guard);
}

async function captureGitProject(root: string, content: ContentStore, options: CaptureProjectOptions, guard: (() => void) | undefined): Promise<CapturedProject> {
  const objects = await GitSnapshotObjects.open(root, options.namespace);
  if (objects === undefined) {
    // classifyRoot proved metadata; open() refusing means git itself says
    // the root is not a repository: an inconsistent classification, not a
    // non-Git fallback. A root inside the repository but below its top
    // level already threw isolation_unsupported inside open().
    throw new WorkerError('isolation_unsupported', `Git metadata is present but git reports ${root} is not a repository`);
  }
  guard?.();
  await assertCaptureSupported(objects);
  guard?.();
  // The latest stable per-query index map (folded path -> record).
  // captureContent queries the selection four times and all four must
  // agree, so the last query is the one the captured content came from.
  let lastIndex: Map<string, IndexRecord> | undefined;
  const reusedByHash = new Map<string, string>();
  const selection = async () => {
    try {
      await assertCaptureSupported(objects);
    } catch (error) {
      // A layout toggled to unsupported between queries is capture churn:
      // report it as inconsistent instead of as a fresh unsupported layout.
      if (error instanceof GitSnapshotError && error.code === 'isolation_unsupported') {
        throw new WorkerError('inconsistent_capture', `Git layout became unsupported during capture: ${error.message}`, true);
      }
      throw error;
    }
    const gitSelection = await objects.selection(options.selectedUntracked);
    const index = new Map<string, IndexRecord>();
    const unsupportedMap: Record<string, string> = Object.create(null);
    const paths: string[] = [];
    const seen = new Map<string, string>();
    const addPath = (value: string): void => {
      const folded = foldKey(value);
      const previous = seen.get(folded);
      if (previous !== undefined && previous !== value) {
        throw new WorkerError('snapshot_case_conflict', `Git paths ${previous} and ${value} collide in this view.`);
      }
      if (!seen.has(folded)) {
        seen.set(folded, value);
        paths.push(value);
      }
    };
    for (const entry of gitSelection.tracked) {
      addPath(entry.path);
      const folded = foldKey(entry.path);
      const record = index.get(folded) ?? { oid: '', mode: '', regular: false, unmerged: false };
      if (entry.stage !== 0) {
        record.unmerged = true;
        unsupportedMap[entry.path] = `unmerged index entry (stage ${entry.stage})`;
      } else if (entry.mode === '120000') {
        unsupportedMap[entry.path] = 'tracked symlinks are not supported';
      } else if (entry.mode === '160000') {
        unsupportedMap[entry.path] = 'tracked gitlinks (submodules) are not supported';
      } else if (entry.mode !== '100644' && entry.mode !== '100755') {
        unsupportedMap[entry.path] = `unsupported index mode ${entry.mode}`;
      } else {
        record.oid = entry.oid;
        record.mode = entry.mode;
        record.regular = true;
      }
      index.set(folded, record);
    }
    for (const untracked of gitSelection.untracked) {
      addPath(untracked);
    }
    lastIndex = index;
    return { paths, unsupported: unsupportedMap, fingerprint: gitSelection.fingerprint };
  };
  const storeContent = async (key: string, bytes: Buffer, contentGuard?: () => void): Promise<string> => {
    const hash = sha256Hex(bytes);
    const record = lastIndex?.get(foldKey(key));
    if (record !== undefined && record.regular && !record.unmerged && objects.matches(record.oid, bytes)) {
      // Byte-identical stage-0 tracked data reuses the native blob OID;
      // the CAS SHA-256 hash is what is returned and stored.
      contentGuard?.();
      reusedByHash.set(hash, record.oid);
      return hash;
    }
    await content.put(bytes, contentGuard);
    contentGuard?.();
    return hash;
  };
  // Mode source. On POSIX the working-tree mode is authoritative and no mode
  // is supplied here, so the capture records exactly what is on disk (an
  // unstaged chmod included, with or without core.fileMode). Windows has no
  // POSIX execute bits, so a tracked stage-0 entry's Git index mode is the
  // only faithful source there; unsupported/unmerged records and untracked
  // paths return undefined and fall back to the observed disk mode.
  const fileMode = (key: string): FileMode | undefined => {
    if (!indexModeIsAuthoritative()) {
      return undefined;
    }
    const record = lastIndex?.get(foldKey(key));
    if (record === undefined || !record.regular || record.unmerged) {
      return undefined;
    }
    return fileModeFromGitMode(record.mode);
  };
  const manifest = await captureContent(root, content, {
    selection,
    openDocuments: options.openDocuments,
    afterScan: options.afterScan,
    guard,
    storeContent,
    fileMode
  });
  guard?.();
  // Only reuse hashes present in the FINAL manifest: content hashed during
  // earlier retried attempts is never pinned or exposed.
  const finalHashes = new Set<string>();
  for (const entry of Object.values(manifest.entries)) {
    if (entry.type === 'file') {
      finalHashes.add(entry.hash);
    }
  }
  const blobs: Record<string, string> = Object.create(null);
  for (const [hash, oid] of reusedByHash) {
    if (finalHashes.has(hash)) {
      blobs[hash] = oid;
    }
  }
  let backing: SnapshotBacking | undefined;
  // The retain callback receives the record the ref will hold (the RAW
  // native tree OID is already computed by the helper via mktree) BEFORE
  // the ref effect: the full-candidate hook runs here, so a journal
  // rejection leaves the ref absent or unchanged.
  const record = await objects.retain(options.snapshotId, Object.values(blobs), guard, async refRecord => {
    backing = Object.freeze({
      kind: 'git' as const,
      commonDir: objects.commonDir,
      objectFormat: objects.objectFormat,
      namespace: options.namespace,
      ref: refRecord.ref,
      tree: refRecord.tree,
      blobs: Object.freeze({ ...blobs })
    });
    if (options.beforePublish !== undefined) {
      await options.beforePublish(Object.freeze({ manifest, backing }));
      guard?.();
    }
  });
  guard?.();
  if (backing === undefined || backing.kind !== 'git' || record.ref !== backing.ref || record.tree !== backing.tree) {
    // The helper always invokes the callback before the ref effect; any
    // other outcome is an internal contradiction, not a fallback.
    throw new WorkerError('internal_error', 'snapshot ref publication did not produce the recorded backing');
  }
  return Object.freeze({ manifest, backing });
}

/**
 * Resolve one captured file's bytes through the persisted backing only:
 * Git-backed hashes mapped to a retained blob OID are read through
 * GitSnapshotObjects.reopen() (common dir, verified SHA-256), all other
 * hashes through the ContentStore. Missing or corrupt content is
 * snapshot_content_missing; there is never a live workspace fallback.
 */
export async function readProjectContent(backing: SnapshotBacking, content: ContentStore, hash: string, guard?: () => void): Promise<Buffer> {
  return createProjectContentReader(backing, content, guard)(hash);
}

/** One lazy Git discovery per coherent operation; payloads are never cached. */
export function createProjectContentReader(backing: SnapshotBacking, content: ContentStore, guard?: () => void): (hash: string) => Promise<Buffer> {
  let objects: Promise<GitSnapshotObjects> | undefined;
  return async hash => {
    guard?.();
    if (!ID_RE.test(hash)) {
      throw new WorkerError('snapshot_content_missing', 'A snapshot content hash must be a raw SHA-256 hash.');
    }
    if (backing.kind === 'git' && Object.hasOwn(backing.blobs, hash)) {
      objects ??= GitSnapshotObjects.reopen(backing.commonDir, backing.objectFormat, backing.namespace);
      const repository = await objects;
      guard?.();
      const bytes = await repository.read(backing.blobs[hash], hash);
      guard?.();
      return bytes;
    } else {
      const bytes = await content.read(hash);
      guard?.();
      return bytes;
    }
  };
}

/**
 * Re-pin the exact blobs of an existing Git snapshot (recovery after a
 * crash between the journal and the ref effect). CAS backings are guarded
 * no-ops. The helper's ref replay verifies the returned tree matches the
 * persisted backing BEFORE any ref effect; a different tree is
 * idempotency_conflict, never overwritten.
 */
export async function ensureProjectRetention(snapshotId: string, backing: SnapshotBacking, guard?: () => void): Promise<void> {
  guard?.();
  if (backing.kind === 'cas') {
    guard?.();
    return;
  }
  const expectedRef = `refs/codex-subagent/${backing.namespace}/${snapshotId}`;
  if (backing.ref !== expectedRef) {
    throw new WorkerError('idempotency_conflict', `backing ref ${backing.ref} is not this namespace's own ref ${expectedRef}`);
  }
  const objects = await GitSnapshotObjects.reopen(backing.commonDir, backing.objectFormat, backing.namespace);
  guard?.();
  const record = await objects.retain(snapshotId, Object.values(backing.blobs), guard, async refRecord => {
    // The callback runs before the ref effect: verify the exact persisted
    // tree BEFORE allowing publication.
    if (refRecord.ref !== backing.ref || refRecord.tree !== backing.tree) {
      throw new WorkerError('idempotency_conflict', `retention tree ${refRecord.tree} does not match the persisted backing tree ${backing.tree}`);
    }
  });
  guard?.();
  if (record.ref !== backing.ref || record.tree !== backing.tree) {
    throw new WorkerError('idempotency_conflict', `retention result ${record.ref}/${record.tree} does not match the persisted backing`);
  }
}

/** Release exactly this snapshot's own ref (exact ref + exact expected tree); CAS backings are guarded no-ops. */
export async function releaseProjectRetention(backing: SnapshotBacking, guard?: () => void): Promise<void> {
  guard?.();
  if (backing.kind === 'cas') {
    guard?.();
    return;
  }
  const objects = await GitSnapshotObjects.reopen(backing.commonDir, backing.objectFormat, backing.namespace);
  guard?.();
  await objects.release(backing.ref, backing.tree, guard);
  guard?.();
}
