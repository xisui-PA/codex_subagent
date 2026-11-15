// Git object retention for immutable shared snapshots.
//
// GitSnapshotObjects pins git blob objects under host-managed refs so that
// content-addressed capture blobs stay reusable after host-side pruning. It
// never mutates the worktree, the index, or any user ref: reads go through
// `git cat-file`, trees are built with `git mktree`, and refs live exclusively
// under refs/codex-subagent/<namespace>/, where <namespace> is the SHA-256 of
// the owning store directory supplied by the caller.
//
// Subprocess policy: argv-only `git` invocations (no shell), bounded stdout
// and wall-clock limits, inherited environment plus explicit
// GIT_NO_LAZY_FETCH=1 and GIT_OPTIONAL_LOCKS=0. Meaningful git failures throw
// structured errors; only a genuinely non-Git root makes `open` resolve to
// undefined.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { WorkerError } from './types';

export interface GitTrackedEntry {
  readonly path: string;
  readonly oid: string;
  readonly mode: string;
  readonly stage: number;
}

export interface GitSelection {
  readonly tracked: readonly GitTrackedEntry[];
  readonly untracked: readonly string[];
  readonly head: string | null;
  readonly fingerprint: string;
}

export interface GitSnapshotRefRecord {
  readonly ref: string;
  readonly tree: string;
}

/**
 * Durable-journal hook invoked immediately before the snapshot ref effect:
 * the ref, the RAW native tree OID that the ref will hold, and the snapshot
 * id. On an absent ref it runs before the creation; on an existing ref it
 * runs before the guarded replay returns. Rejection leaves the ref absent or
 * unchanged.
 */
export type GitRetainBeforePublish = (record: GitSnapshotRefRecord & { snapshotId: string }) => Promise<void>;

export class GitSnapshotError extends WorkerError {
  constructor(readonly code: string, message: string, readonly exitCode: number | undefined = undefined) {
    super(code, message);
    this.name = 'GitSnapshotError';
  }
}

type GitEnv = Record<string, string>;
type Guard = () => void;

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const READ_LIMIT = 32 * 1024 * 1024;
const TRACKED_CAP = 100_000;
const UNTRACKED_CAP = 50_000;
const SELECTED_CAP = 10_000;
const NAMESPACE_RE = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/;
const REF_PREFIX = 'refs/codex-subagent/';

// Every git invocation is additionally guarded: no pager, hooks disabled via
// core.hooksPath=/dev/null (the official Git recommendation for isolation),
// and fsmonitor explicitly off (a boolean `false` is only interpreted that way
// from Git 2.36; older releases would treat it as a hook program path, so the
// 2.46 floor also ensures GIT_NO_LAZY_FETCH blocks the low-level fetch path).
const ISOLATION_ARGS = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

/** Require the hook/fsmonitor and low-level lazy-fetch guards (Git 2.46+). */
function assertGitIsolationSupported(stdout: Buffer): void {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout.toString('utf8').trim());
  if (match === null) {
    throw new GitSnapshotError('isolation_unsupported', 'git version probe could not be parsed');
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (major < 2 || (major === 2 && minor < 46)) {
    throw new GitSnapshotError('isolation_unsupported', `git >= 2.46 is required for hook/fsmonitor and lazy-fetch isolation, found ${major}.${minor}.${patch}`);
  }
}

function posix(value: string): string {
  return value.split(path.sep).join('/');
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const INHERITED_GIT_VARS = [
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH'
];

function scopedEnv(baseEnv: GitEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (INHERITED_GIT_VARS.includes(key.toUpperCase())) {
      continue;
    }
    env[key] = value;
  }
  // Defense in depth: no pager, no prompts, deterministic locale, no lazy
  // fetch, no replace refs, and no optional lock creation. baseEnv (the
  // scoped GIT_DIR/GIT_WORK_TREE) still wins over any ambient leftovers.
  return {
    ...env,
    ...baseEnv,
    LC_ALL: 'C',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0'
  };
}

async function runGit(cwd: string, baseEnv: GitEnv, args: readonly string[], input?: Buffer,
  transaction?: { verifyPrepared: () => Promise<void>; authorizeCommit?: Guard }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let closed = false;
    let failure: Error | undefined;
    let prepared = false;
    let committed = false;
    let verification: Promise<void> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // ISOLATION_ARGS are prepended before any `-C`/subcommand so that hooks,
    // fsmonitor, untracked cache and pager can never be activated by a
    // repository-configured value, even when baseEnv points inside it.
    const child = spawn('git', [...ISOLATION_ARGS, ...args], { env: scopedEnv(baseEnv), cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const fail = (error: Error): void => {
      failure ??= error;
      if (closed) {
        return;
      }
      if (transaction && child.stdin.writable && !child.stdin.writableEnded) {
        // Abort explicitly so a prepared Git process releases its locks.
        child.stdin.end('abort\n');
        killTimer ??= setTimeout(() => child.kill(), 1000);
      } else {
        child.kill();
      }
    };
    const timer = setTimeout(() => {
      fail(new GitSnapshotError('git_timeout', `git timed out after ${GIT_TIMEOUT_MS}ms: ${args.join(' ')}`));
    }, GIT_TIMEOUT_MS);
    const finish = (ok: boolean, value: Buffer | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (ok) {
        resolve(value as Buffer);
      } else {
        reject(value as Error);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) {
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > GIT_OUTPUT_LIMIT) {
        fail(new GitSnapshotError('git_output_too_large', 'git output exceeded the bounded size'));
        return;
      }
      if (transaction) {
        const lines = stdout.toString('utf8').split('\n');
        committed = lines.includes('commit: ok');
        if (!prepared && lines.includes('prepare: ok')) {
          prepared = true;
          verification = Promise.resolve().then(async () => {
            try {
              await transaction.verifyPrepared();
              if (!failure && !closed) {
                // The async verifier's return is another authorization
                // boundary: re-check synchronously before sending commit.
                transaction.authorizeCommit?.();
                child.stdin.end('commit\n');
              }
            } catch (error) {
              fail(error instanceof Error ? error : new GitSnapshotError('git_error', String(error)));
            }
          });
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (failure) {
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > GIT_OUTPUT_LIMIT) {
        fail(new GitSnapshotError('git_output_too_large', 'git stderr exceeded the bounded size'));
      }
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(new GitSnapshotError('git_exec_error', `failed to start git: ${error.message}`));
    });
    child.on('close', code => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      // Do not release the caller while a prepared transaction or its
      // verification is still draining. No callback may commit after close.
      void Promise.resolve(verification).then(() => {
        if (failure) {
          finish(false, failure);
        } else if (code !== 0) {
          finish(false, new GitSnapshotError('git_error', `git exited with code ${code}: ${stderr.toString('utf8').trim()}`, code ?? undefined));
        } else if (transaction && !committed) {
          finish(false, new GitSnapshotError('git_error', 'Git transaction ended without a commit acknowledgment.'));
        } else {
          finish(true, stdout);
        }
      }, error => finish(false, error instanceof Error ? error : new GitSnapshotError('git_error', String(error))));
    });
    child.stdin.on('error', () => { /* the close handler reports the real failure. */ });
    if (transaction) {
      child.stdin.write(input);
    } else {
      child.stdin.end(input);
    }
  });
}

/**
 * Sanitized argv-only git run for object-level metadata probes (config reads,
 * index flag listing, ref lookups). Applies the exact same isolation args
 * (hooks path, fsmonitor, untracked cache, no pager) and scrubbed environment
 * as every helper invocation, so no repository hook, filter, or ambient GIT_*
 * redirection can take effect.
 */
export function runGitProbe(cwd: string, baseEnv: Record<string, string>, args: readonly string[]): Promise<Buffer> {
  return runGit(cwd, baseEnv, args);
}

function isNonGitMessage(detail: string): boolean {
  const text = detail.toLowerCase();
  return text.includes('not a git repository') || text.includes('not a git repo') || text.includes('outside repository');
}

// selection-path validation helpers live below.
function validateSelectionPath(p: string): void {
  if (p.length === 0 || p.length > 4096) {
    throw new GitSnapshotError('git_selection_path', 'path length is out of bounds');
  }
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    // NUL, C0 controls, and DEL are never portable in file paths.
    if (c < 32 || c === 127 || [34, 42, 60, 62, 63, 124].includes(c)) {
      throw new GitSnapshotError('git_selection_path', `path is not portable: ${JSON.stringify(p)}`);
    }
  }
  if (p.includes('\\')) {
    throw new GitSnapshotError('git_selection_path', `path is not portable: ${JSON.stringify(p)}`);
  }
  const segments = p.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new GitSnapshotError('git_selection_path', `path segment escapes or is empty: ${JSON.stringify(p)}`);
    }
    if (segment === '.' || segment === '..') {
      throw new GitSnapshotError('git_selection_path', `path segment escapes or is empty: ${JSON.stringify(p)}`);
    }
    // Windows drive-letter prefix (e.g. C:foo in a relative name).
    if (segment.length >= 2 && segment.charCodeAt(1) === 58) {
      throw new GitSnapshotError('git_selection_path', `path is not portable: ${JSON.stringify(p)}`);
    }
    // Alternate data stream separator (name:stream).
    if (segment.includes(':')) {
      throw new GitSnapshotError('git_selection_path', `path is not portable: ${JSON.stringify(p)}`);
    }
    // Windows device names remain reserved when followed by an extension.
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      throw new GitSnapshotError('git_selection_path', `path is not portable: ${JSON.stringify(p)}`);
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new GitSnapshotError('git_selection_path', `path is not portable: ${JSON.stringify(p)}`);
    }
  }
}

/**
 * Walks the path components from `root` to `rel`, using lstat at every level
 * so symlinked directories or junctions are never followed and never accepted:
 * every parent component must be a plain directory and the final component a
 * regular file. No file bytes are read.
 */
async function assertPlainFile(root: string, rel: string): Promise<void> {
  const segments = rel.split('/');
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    cursor = path.join(cursor, segments[i]);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      throw new GitSnapshotError('git_selection_path', `parent component does not exist: ${JSON.stringify(rel)}`);
    }
    if (!info.isDirectory()) {
      throw new GitSnapshotError('git_selection_path', `parent component is not a plain directory: ${JSON.stringify(rel)}`);
    }
  }
  const target = path.join(cursor, segments[segments.length - 1]);
  let final;
  try {
    final = await lstat(target);
  } catch {
    throw new GitSnapshotError('git_selection_path', `selected path does not exist: ${JSON.stringify(rel)}`);
  }
  if (!final.isFile()) {
    throw new GitSnapshotError('git_selection_path', `selected path is not a regular file: ${JSON.stringify(rel)}`);
  }
}

export class GitSnapshotObjects {
  readonly gitDir: string;
  readonly commonDir: string;
  readonly root: string;
  readonly objectFormat: 'sha1' | 'sha256';

  private readonly namespace: string;
  /** Per-worktree view: only `selection` may use it (index, HEAD, untracked). */
  private readonly baseEnv: GitEnv;
  /** Common-dir view: every object/ref operation; no GIT_WORK_TREE. */
  private readonly objectEnv: GitEnv;
  /** True for reopen() views: no work tree exists (it may already be removed). */
  private readonly objectOnly: boolean;

  private constructor(gitDir: string, commonDir: string, root: string, objectFormat: 'sha1' | 'sha256', namespace: string, objectOnly: boolean = false) {
    this.gitDir = gitDir;
    this.commonDir = commonDir;
    this.root = root;
    this.objectFormat = objectFormat;
    this.namespace = namespace;
    this.objectOnly = objectOnly;
    // GIT_DIR targets the per-worktree dir so index operations act on the
    // requested worktree; object access still resolves through the common
    // dir that worktree git dirs carry in their `commondir` file. The
    // isolation variables (LC_ALL, GIT_NO_LAZY_FETCH, GIT_NO_REPLACE_OBJECTS,
    // GIT_OPTIONAL_LOCKS, GIT_TERMINAL_PROMPT) are applied uniformly by
    // scopedEnv to every invocation.
    this.baseEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: root };
    // Object and ref operations run in the COMMON dir with no work tree:
    // cat-file, mktree, for-each-ref and update-ref never need the working
    // tree, and this view stays valid after a linked worktree is pruned.
    this.objectEnv = { GIT_DIR: commonDir };
  }

  /**
   * Discovers the git dir of the repository containing `root` (worktree aware,
   * resolved through the common dir so both share one object store) plus its
   * object format. Resolves undefined only for a genuinely non-Git root;
   * missing executable, permission, or other git failures throw.
   */
  static async open(root: string, namespace: string): Promise<GitSnapshotObjects | undefined> {
    if (!NAMESPACE_RE.test(namespace)) {
      throw new GitSnapshotError('git_selection_path', 'namespace must be the 64-hex-char SHA-256 of the store directory');
    }
    // Metadata-only, repository-free probe: isolation flags are only trusted
    // from Git >= 2.46 (including the low-level lazy-fetch guard). Older or
    // unparsable versions get an explicit isolation_unsupported; there is no
    // unprotected fallback.
    assertGitIsolationSupported(await runGit(process.cwd(), {}, ['--version']));
    let normalizedRoot: string;
    try {
      // Native canonical absolute path; POSIX separators are only used for
      // root-relative file keys, never for the exposed metadata.
      normalizedRoot = await realpath(root);
    } catch {
      throw new GitSnapshotError('git_access', `root cannot be resolved: ${root}`);
    }
    const openEnv: GitEnv = { GIT_NO_LAZY_FETCH: '1' };
    const run = (args: readonly string[]) => runGit(normalizedRoot, openEnv, args);
    const single = async (args: readonly string[]): Promise<string> => (await run(args)).toString('utf8').trim();
    let canonicalRoot: string;
    let gitDir: string;
    let commonDir: string;
    let formatRaw: string;
    try {
      canonicalRoot = await single(['-C', normalizedRoot, 'rev-parse', '--show-toplevel']);
      // --git-dir is the per-worktree dir (common/worktrees/<name> for a
      // linked worktree); --git-common-dir is the shared object store. Both
      // are relative to the -C directory unless git reports them absolute.
      gitDir = await single(['-C', normalizedRoot, 'rev-parse', '--git-dir']);
      commonDir = await single(['-C', normalizedRoot, 'rev-parse', '--git-common-dir']);
      formatRaw = await single(['-C', normalizedRoot, 'rev-parse', '--show-object-format']);
    } catch (error) {
      if (error instanceof GitSnapshotError && error.code === 'git_error' && isNonGitMessage(error.message)) {
        return undefined;
      }
      throw error;
    }
    if (canonicalRoot === '' || gitDir === '' || commonDir === '') {
      throw new GitSnapshotError('git_error', 'git reported an empty canonical root or git dir');
    }
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(canonicalRoot);
    } catch {
      throw new GitSnapshotError('git_error', `git reported an unresolvable toplevel: ${canonicalRoot}`);
    }
    if (path.relative(resolvedRoot, normalizedRoot) !== '') {
      // The root is inside the repository but not its top level. This helper
      // deliberately refuses partial-worktree views until the capture store
      // defines their meaning.
      throw new GitSnapshotError('isolation_unsupported', `root ${root} is not the top level of the repository at ${resolvedRoot}`);
    }
    if (formatRaw !== 'sha1' && formatRaw !== 'sha256') {
      throw new GitSnapshotError('git_unsupported', `unsupported git object format: ${JSON.stringify(formatRaw)}`);
    }
    const resolvedGitDir = await realpath(path.resolve(normalizedRoot, gitDir));
    const resolvedCommonDir = await realpath(path.resolve(normalizedRoot, commonDir));
    return new GitSnapshotObjects(resolvedGitDir, resolvedCommonDir, normalizedRoot, formatRaw, namespace);
  }

  /**
   * Object-only view over a persisted common dir: validates the dir and its
   * reported object format WITHOUT needing any worktree (a linked worktree
   * may already be removed). `objectFormat` is the value persisted by the
   * original capture (the 40/64-hex lengths of every blob and tree OID in a
   * backing record depend on it and cannot be re-derived without a live repo);
   * it must be consistent with the repository's `--show-object-format`. The
   * same Git >= 2.46 isolation floor applies. Every read, retain, release,
   * and retained() call on the returned view goes through the common dir;
   * selection() requires a worktree and must not be used on this view.
   */
  static async reopen(commonDir: string, objectFormat: 'sha1' | 'sha256', namespace: string): Promise<GitSnapshotObjects> {
    if (!NAMESPACE_RE.test(namespace)) {
      throw new GitSnapshotError('git_selection_path', 'namespace must be the 64-hex-char SHA-256 of the store directory');
    }
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw new GitSnapshotError('git_selection_path', `objectFormat must be sha1 or sha256, got ${JSON.stringify(objectFormat)}`);
    }
    if (!path.isAbsolute(commonDir)) {
      throw new GitSnapshotError('git_selection_path', `commonDir must be an absolute path, got ${JSON.stringify(commonDir)}`);
    }
    // Object-only operations never touch a worktree, so the isolation flags
    // (hooks path, fsmonitor, lazy fetch) must be trusted from the version
    // probe exactly as in open(): no unprotected fallback.
    assertGitIsolationSupported(await runGit(process.cwd(), {}, ['--version']));
    let resolvedCommonDir: string;
    try {
      const stat = await lstat(commonDir);
      if (!stat.isDirectory()) {
        throw new Error('not a directory');
      }
      resolvedCommonDir = await realpath(commonDir);
    } catch {
      throw new GitSnapshotError('git_access', `common dir cannot be resolved: ${commonDir}`);
    }
    const objectEnv: GitEnv = { GIT_DIR: resolvedCommonDir };
    let formatRaw: string;
    try {
      formatRaw = (await runGit(resolvedCommonDir, objectEnv, ['rev-parse', '--show-object-format'])).toString('utf8').trim();
    } catch (error) {
      if (error instanceof GitSnapshotError && error.code === 'git_error' && isNonGitMessage(error.message)) {
        throw new GitSnapshotError('git_access', `common dir is not a git object store: ${commonDir}`);
      }
      throw error;
    }
    if (formatRaw !== objectFormat) {
      throw new GitSnapshotError('git_unsupported', `persisted objectFormat ${objectFormat} disagrees with the repository format ${JSON.stringify(formatRaw)}`);
    }
    return new GitSnapshotObjects(resolvedCommonDir, resolvedCommonDir, resolvedCommonDir, objectFormat, namespace, true);
  }

  /**
   * Reads the index, HEAD, and ignored-aware untracked list.
   * `selectedUntracked` names specific (possibly ignored) untracked paths the
   * caller wants included; entries are validated as root-relative POSIX paths
   * and deduped. Purely read-only: no index or worktree mutation.
   */
  async selection(selectedUntracked?: readonly string[]): Promise<GitSelection> {
    if (this.objectOnly) {
      // A reopened object store has no work tree (it may already be
      // removed): pretending the common dir is a work tree would read the
      // wrong index. Refuse explicitly instead.
      throw new GitSnapshotError('isolation_unsupported', 'selection requires a worktree; this object-only view has none');
    }
    const [stageRaw, untrackedRaw] = await Promise.all([
      runGit(this.root, this.baseEnv, ['ls-files', '--stage', '-z']),
      selectedUntracked === undefined
        ? runGit(this.root, this.baseEnv, ['ls-files', '--others', '--exclude-standard', '-z'])
        : Promise.resolve(Buffer.alloc(0))
    ]);
    const tracked: GitTrackedEntry[] = [];
    for (const record of splitNul(stageRaw, TRACKED_CAP, 'tracked entries')) {
      if (record.startsWith('"')) {
        throw new GitSnapshotError('git_selection_path', `quoted (non-portable) path in ls-files output`);
      }
      const firstTab = record.indexOf('\t');
      if (firstTab < 0) {
        throw new GitSnapshotError('git_selection_path', `malformed ls-files record: ${JSON.stringify(record)}`);
      }
      const [mode, oid, stage] = record.slice(0, firstTab).split(' ');
      const filePath = record.slice(firstTab + 1);
      if (!/^[0-7]{6}$/.test(mode) || !/^\d{1,2}$/.test(stage)) {
        throw new GitSnapshotError('git_selection_path', `malformed ls-files record: ${JSON.stringify(record)}`);
      }
      validateSelectionPath(filePath);
      tracked.push(Object.freeze({ path: filePath, oid, mode, stage: Number(stage) }));
    }
    // HEAD: every git failure propagates except a genuine unborn branch
    // (rev-parse exit 1 while HEAD is still a symbolic ref to a branch).
    let head: string | null;
    try {
      const raw = (await runGit(this.root, this.baseEnv, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toString('utf8').trim();
      if (!/^[0-9a-f]{40}$/.test(raw) && !/^[0-9a-f]{64}$/.test(raw)) {
        throw new GitSnapshotError('git_error', `unexpected HEAD object name: ${JSON.stringify(raw)}`);
      }
      head = raw;
    } catch (error) {
      const missing = error instanceof GitSnapshotError && error.code === 'git_error' && error.exitCode === 1;
      let unborn = false;
      if (missing) {
        try {
          const branch = (await runGit(this.root, this.baseEnv, ['symbolic-ref', 'HEAD'])).toString('utf8').trim();
          unborn = branch.startsWith('refs/heads/');
        } catch {
          unborn = false;
        }
      }
      if (!unborn) {
        throw error;
      }
      head = null;
    }
    const defaultUntracked = splitNul(untrackedRaw, UNTRACKED_CAP, 'untracked entries').map(record => {
      if (record.startsWith('"')) {
        throw new GitSnapshotError('git_selection_path', `quoted (non-portable) path in ls-files output`);
      }
      validateSelectionPath(record);
      return record;
    });
    const trackedPaths = new Set(tracked.map(entry => entry.path));
    let untracked: string[];
    if (selectedUntracked === undefined) {
      untracked = defaultUntracked;
    } else {
      if (selectedUntracked.length > SELECTED_CAP) {
        throw new GitSnapshotError('git_capacity', `selected untracked exceeds the ${SELECTED_CAP} cap`);
      }
      untracked = [];
      const seen = new Set<string>();
      for (const candidate of selectedUntracked) {
        const normalized = posix(path.normalize(candidate));
        validateSelectionPath(normalized);
        // Component-by-component lstat: no symlink/junction/special parent,
        // no non-file target; bytes are never read here.
        await assertPlainFile(this.root, normalized);
        if (seen.has(normalized) || trackedPaths.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        untracked.push(normalized);
      }
    }
    untracked = [...untracked].sort();
    // Canonical JSON over the index, HEAD, and the actual untracked selection.
    const fingerprint = sha256Hex(JSON.stringify({
      head,
      index: tracked.map(entry => [entry.mode, entry.oid, entry.stage, entry.path]),
      untracked
    }));
    return Object.freeze({
      tracked,
      untracked: Object.freeze(untracked),
      head,
      fingerprint
    });
  }

  /**
   * True iff `bytes` hash to `oid` under the repository's object algorithm,
   * computed over the raw bytes (no clean/smudge filters). Only byte-identical
   * tracked data is reusable.
   */
  matches(oid: string, bytes: Buffer): boolean {
    const expected = this.objectFormat === 'sha1' ? 40 : 64;
    if (!new RegExp(`^[0-9a-f]{${expected}}$`).test(oid)) {
      return false;
    }
    const digest = createHash(this.objectFormat).update(`blob ${bytes.length}\0`, 'utf8').update(bytes).digest('hex');
    return digest === oid;
  }

  /**
   * Reads a blob through `git cat-file` and verifies its raw SHA-256. Missing,
   * corrupt, oversized, or hash-mismatching objects reject with
   * snapshot_content_missing; there is never a workspace fallback.
   */
  async read(oid: string, expectedSha256: string): Promise<Buffer> {
    const expected = this.objectFormat === 'sha1' ? 40 : 64;
    if (!new RegExp(`^[0-9a-f]{${expected}}$`).test(oid) || !NAMESPACE_RE.test(expectedSha256)) {
      throw new GitSnapshotError('git_selection_path', 'invalid oid or expectedSha256');
    }
    let stdout: Buffer;
    try {
      stdout = await runGit(this.commonDir, this.objectEnv, ['cat-file', 'blob', oid]);
    } catch (error) {
      if (error instanceof GitSnapshotError && error.code === 'git_error') {
        throw new GitSnapshotError('snapshot_content_missing', `git blob missing or unreadable: ${oid}`);
      }
      throw error;
    }
    if (stdout.length > READ_LIMIT) {
      throw new GitSnapshotError('snapshot_capacity', `blob exceeds the ${READ_LIMIT} byte read limit`);
    }
    if (sha256Hex(stdout) !== expectedSha256) {
      throw new GitSnapshotError('snapshot_content_missing', `hash verification failed for blob ${oid}`);
    }
    return stdout;
  }

  private async verifyBlobs(oids: readonly string[]): Promise<void> {
    if (oids.length === 0) {
      return;
    }
    const expected = this.objectFormat === 'sha1' ? 40 : 64;
    for (const oid of oids) {
      if (!new RegExp(`^[0-9a-f]{${expected}}$`).test(oid)) {
        throw new GitSnapshotError('git_selection_path', `invalid blob oid: ${oid}`);
      }
    }
    const raw = await runGit(this.commonDir, this.objectEnv, ['cat-file', '--batch-check'], Buffer.from(`${oids.join('\n')}\n`, 'utf8'));
    const types = new Map<string, string>();
    for (const line of raw.toString('utf8').split('\n')) {
      const match = /^([0-9a-f]+) ([a-z]+) (\d+)$/.exec(line);
      if (match !== null) {
        types.set(match[1], match[2]);
      }
    }
    for (const oid of oids) {
      const type = types.get(oid);
      if (type === undefined) {
        throw new GitSnapshotError('git_selection_path', `blob object does not exist: ${oid}`);
      }
      if (type !== 'blob') {
        throw new GitSnapshotError('git_selection_path', `object is a ${type}, not a blob: ${oid}`);
      }
    }
  }

  /**
   * Pins the given unique blob Oids under refs/codex-subagent/<namespace>/
   * <snapshotId> as one synthetic tree entry per blob. An empty blob set pins
   * an empty tree. The record's `tree` field is the ACTUAL native tree OID
   * produced by `git mktree` (40 hex for sha1 repositories, 64 hex for
   * sha256) and matches `git rev-parse <ref>`. Replay of an existing direct
   * tree ref with the same tree OID is an idempotent guard-checked no-op;
   * any different tree or a symbolic ref at the same name rejects with
   * idempotency_conflict. Creation is atomic (empty old-value with
   * --no-deref); a concurrent creation is re-read by exact name - a same-tree
   * win replays, a different tree or symref conflicts, and a still-absent
   * ref rethrows the original git error without masking permission,
   * timeout, or other failures.
   *
   * The optional `beforePublish` durable-journal hook runs immediately before
   * the ref effect, with the record the ref will hold (ref, RAW native tree
   * OID, snapshotId): on the creation path it runs before the `update-ref`
   * effect (the tree object is already persisted by `mktree`), and on the
   * replay path it runs before the idempotent no-op return. The guard is
   * re-checked after the hook resolves. A rejecting hook never publishes or
   * moves the ref, and a later replay with a live hook still succeeds.
   */
  async retain(snapshotId: string, blobOids: readonly string[], guard?: Guard, beforePublish?: GitRetainBeforePublish): Promise<GitSnapshotRefRecord> {
    if (!SNAPSHOT_ID_RE.test(snapshotId)) {
      throw new GitSnapshotError('git_selection_path', 'snapshotId must be a 64-hex-char id');
    }
    if (blobOids.length > SELECTED_CAP) {
      throw new GitSnapshotError('git_capacity', `blob oid list exceeds the ${SELECTED_CAP} cap`);
    }
    const uniqueOids = [...new Set([...blobOids])].sort();
    await this.verifyBlobs(uniqueOids);
    guard?.();
    const treeOid = (await runGit(this.commonDir, this.objectEnv, ['mktree'], Buffer.from(uniqueOids.map(oid => `100644 blob ${oid}\t${oid}`).join('\n'), 'utf8'))).toString('utf8').trim();
    if (!this.isNativeOid(treeOid)) {
      throw new GitSnapshotError('git_error', `mktree did not return a native ${this.objectFormat} tree oid: ${JSON.stringify(treeOid)}`);
    }
    const ref = this.snapshotRefName(snapshotId);
    guard?.();
    const current = await this.lookupRefExact(ref);
    if (current !== undefined) {
      if (current.symbolic || current.oid !== treeOid) {
        // Symbolic (even resolving to the same tree) or a different tree:
        // replay only ever applies to the identical direct tree ref.
        throw new GitSnapshotError('idempotency_conflict', `ref ${ref} already points to a different tree`);
      }
      // Replay path: the durable record is journaled before the guarded
      // no-op return, with the ref, tree and snapshot id the record holds.
      if (beforePublish !== undefined) {
        guard?.();
        await beforePublish(Object.freeze({ snapshotId, ref, tree: treeOid }));
        guard?.();
      }
      guard?.();
      return Object.freeze({ ref, tree: treeOid });
    }
    // The tree object is already persisted by mktree; the durable journal
    // records the intent before the only remaining effect: the ref update.
    if (beforePublish !== undefined) {
      guard?.();
      await beforePublish(Object.freeze({ snapshotId, ref, tree: treeOid }));
      guard?.();
    }
    // Guard re-checked after the async lookup and immediately before the
    // creation effect.
    guard?.();
    try {
      await runGit(this.commonDir, this.objectEnv, ['update-ref', '--no-deref', ref, treeOid, '0'.repeat(this.objectFormat === 'sha1' ? 40 : 64)]);
    } catch (error) {
      // The update lost a race (or otherwise failed). Re-read the EXACT ref
      // to classify: same tree -> guarded replay, other tree -> conflict,
      // still absent -> preserve the original git error (permissions,
      // timeouts, etc. are never masked).
      const raced = await this.lookupRefExact(ref);
      if (raced !== undefined) {
        if (!raced.symbolic && raced.oid === treeOid) {
          guard?.();
          return Object.freeze({ ref, tree: treeOid });
        }
        throw new GitSnapshotError('idempotency_conflict', `ref ${ref} was created concurrently with a different tree`);
      }
      throw error;
    }
    guard?.();
    return Object.freeze({ ref, tree: treeOid });
  }

  /**
   * Deletes exactly this namespace's snapshot ref `ref` (an exact leaf under
   * refs/codex-subagent/<ns>/) when it is a DIRECT tree ref equal to
   * `expectedTree`, the RAW native tree OID (40 hex sha1 / 64 hex sha256)
   * reported by `retain`/`retained`. Both arguments are validated for format
   * before any lookup; malformed input is idempotency_conflict. A missing
   * well-formed ref is an idempotent no-op. A prepared `update-ref --stdin`
   * transaction locks the ref and checks its OID, then verifies its direct
   * kind under that lock before committing. Revocation aborts and drains
   * the transaction before returning, releasing its locks without deletion.
   * Symbolic snapshot refs are never followed or deleted, even when their
   * resolved target equals the expected tree. Unrelated git errors are
   * preserved.
   */
  async release(ref: string, expectedTree: string, guard?: Guard): Promise<void> {
    // Pre-lookup validation: the ref must be an exact snapshot leaf of this
    // namespace and expectedTree must be a native tree OID for the object
    // format. Malformed inputs are conflicts, never silent no-ops.
    if (!new RegExp(`^${REF_PREFIX}${this.namespace}/[0-9a-f]{64}$`).test(ref)) {
      throw new GitSnapshotError('idempotency_conflict', `ref ${ref} is not a snapshot ref of this namespace`);
    }
    if (!this.isNativeOid(expectedTree)) {
      throw new GitSnapshotError('idempotency_conflict', `expectedTree ${expectedTree} is not a native ${this.objectFormat} tree oid`);
    }
    guard?.();
    const current = await this.lookupRefExact(ref);
    if (current === undefined) {
      // A missing well-formed ref is an idempotent no-op.
      guard?.();
      return;
    }
    if (current.symbolic) {
      // Never delete (or follow) a symbolic snapshot ref, even when the
      // resolved OID matches: the target may be a foreign ref.
      throw new GitSnapshotError('idempotency_conflict', `ref ${ref} is a symbolic ref and will not be deleted`);
    }
    if (current.oid !== expectedTree) {
      throw new GitSnapshotError('idempotency_conflict', `ref ${ref} no longer matches expected tree`);
    }
    // Guard re-checked after the async lookup and immediately before the
    // deletion effect.
    guard?.();
    try {
      // Prepare locks the ref and verifies its old OID. Under that lock,
      // verify the kind too: a symref can resolve to the same expected OID.
      await runGit(this.commonDir, this.objectEnv, ['update-ref', '--no-deref', '--stdin'],
        Buffer.from(`start\ndelete ${ref} ${expectedTree}\nprepare\n`, 'utf8'), {
          verifyPrepared: async () => {
            guard?.();
            const locked = await this.lookupRefExact(ref);
            guard?.();
            if (!locked || locked.symbolic || locked.oid !== expectedTree) {
              throw new GitSnapshotError('idempotency_conflict', `ref ${ref} changed kind or value before locked verification`);
            }
          },
          authorizeCommit: guard
        });
    } catch (error) {
      if (error instanceof GitSnapshotError && error.code === 'git_error') {
        const raced = await this.lookupRefExact(ref);
        if (raced === undefined) {
          // Deleted concurrently - the desired state was reached.
          guard?.();
          return;
        }
        if (!raced.symbolic && raced.oid === expectedTree) {
          // Still ours but the update failed for a non-move reason; preserve.
          throw error;
        }
        throw new GitSnapshotError('idempotency_conflict', `ref ${ref} moved between lookup and deletion`);
      }
      throw error;
    }
    guard?.();
  }

  /** Lists this namespace's pinned snapshot refs (recovery after reopen). */
  async retained(): Promise<readonly GitSnapshotRefRecord[]> {
    // Contract: only exact namespace leaves refs/codex-subagent/<ns>/<64 hex>
    // that directly own a tree object are listed, each with the RAW native
    // tree OID; unrelated and non-leaf refs are ignored. A matching leaf that
    // is symbolic or not a tree fails closed with idempotency_conflict.
    const output = (await runGit(this.commonDir, this.objectEnv, ['for-each-ref', `--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)`, `${REF_PREFIX}${this.namespace}/`])).toString('utf8');
    const leafPrefix = `${REF_PREFIX}${this.namespace}/`;
    const records: GitSnapshotRefRecord[] = [];
    for (const line of output.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const [ref, oid, symref, type] = line.split('\0');
      if (ref === undefined || oid === undefined || type === undefined) {
        throw new GitSnapshotError('git_error', `malformed for-each-ref line: ${JSON.stringify(line)}`);
      }
      if (!ref.startsWith(leafPrefix)) {
        continue;
      }
      const leaf = ref.slice(leafPrefix.length);
      if (!SNAPSHOT_ID_RE.test(leaf)) {
        // Non-leaf or unrelated ref (e.g. a descendant) - ignore.
        continue;
      }
      if (symref !== undefined && symref !== '') {
        throw new GitSnapshotError('idempotency_conflict', `snapshot ref ${ref} is a symbolic ref, not a direct tree ref`);
      }
      if (type !== 'tree' || !this.isNativeOid(oid)) {
        throw new GitSnapshotError('idempotency_conflict', `snapshot ref ${ref} does not own a tree object`);
      }
      records.push(Object.freeze({ ref, tree: oid }));
    }
    records.sort((a, b) => (a.ref < b.ref ? -1 : 1));
    return Object.freeze(records);
  }

  private isNativeOid(oid: string): boolean {
    return this.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/.test(oid) : /^[0-9a-f]{64}$/.test(oid);
  }

  private snapshotRefName(snapshotId: string): string {
    return `${REF_PREFIX}${this.namespace}/${snapshotId}`;
  }

  /**
   * Reads one ref by EXACT full name. `for-each-ref <pattern>` filters by
   * prefix, so any matching line must equal the wanted name; a descendant is
   * never mistaken for the ref itself. A symbolic ref is returned flagged as
   * symbolic; its target is NEVER read, resolved, or followed. A dangling
   * symref may be missed by `for-each-ref`, so `symbolic-ref --quiet` is
   * checked as well (exit 1 = not symbolic; any other failure propagates).
   * Returns undefined only when the exact ref does not exist. A symbolic ref
   * is returned flagged; its target is never followed.
   */
  async lookupRefExact(ref: string): Promise<{ oid: string; symbolic: boolean } | undefined> {
    let symbolic = false;
    try {
      await runGit(this.commonDir, this.objectEnv, ['symbolic-ref', '--quiet', ref]);
      symbolic = true;
    } catch (error) {
      // Exit 1 is git's answer for "not a symbolic ref" (or absent).
      if (!(error instanceof GitSnapshotError && error.code === 'git_error' && error.exitCode === 1)) {
        throw error;
      }
    }
    const output = (await runGit(this.commonDir, this.objectEnv, ['for-each-ref', `--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)`, ref])).toString('utf8');
    for (const line of output.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const [name, oid, symref, type] = line.split('\0');
      if (name !== ref) {
        continue; // prefix match on a different ref (descendant); not ours.
      }
      if (symbolic || (symref !== undefined && symref !== '')) {
        // Never follow: the raw listed objectname is only returned so callers
        // can refuse; it is never used as a tree identity.
        return { oid: oid ?? '', symbolic: true };
      }
      if (type !== 'tree' || oid === undefined || !this.isNativeOid(oid)) {
        throw new GitSnapshotError('idempotency_conflict', `ref ${ref} does not own a native tree object`);
      }
      return { oid, symbolic: false };
    }
    // for-each-ref reported nothing, but symbolic-ref proves a (dangling)
    // symref occupies the exact name: refuse, never treat as absent.
    if (symbolic) {
      return { oid: '', symbolic: true };
    }
    return undefined;
  }

}

function splitNul(raw: Buffer, cap: number, operation: string): string[] {
  if (raw.length === 0) {
    return [];
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new GitSnapshotError('git_selection_path', `git output is not valid UTF-8: ${operation}`);
  }
  // A NUL-terminated listing ends in exactly one trailing sentinel NUL.
  let body = text;
  if (body.endsWith('\0')) {
    body = body.slice(0, -1);
  }
  const records = body === '' ? [] : body.split('\0');
  if (records.length > cap) {
    throw new GitSnapshotError('git_capacity', `${operation} exceeds the ${cap} entry cap`);
  }
  for (const record of records) {
    if (record.length === 0) {
      throw new GitSnapshotError('git_selection_path', `malformed (empty) record in ${operation}`);
    }
  }
  return records;
}
