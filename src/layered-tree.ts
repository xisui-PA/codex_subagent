import type { SnapshotEntry } from './snapshot-content';
import { isFileMode, type FileMode } from './snapshot-content';
import { WorkerError } from './types';

// ---------------------------------------------------------------------------
// LayeredTree: a pure, immutable, layered view over a snapshot namespace.
//
// It merges a persisted base capture with zero or more change deltas and
// answers read (resolve/stat/list) and mutation-planner (write/mkdir/delete/
// rename) queries WITHOUT touching the live filesystem. Planners return a
// Delta; the caller persists it and then constructs a new LayeredTree.
// ---------------------------------------------------------------------------

/**
 * A change set: canonical key -> replacement entry, or `null` to tombstone.
 * Keys are case-sensitive strings, so a case-only rename delta can carry the
 * old key (tombstone) and the new-case key (replacement) at once.
 */
export type Delta = Readonly<Record<string, SnapshotEntry | null>>;

export interface LayeredTreeOptions {
  /** Match path case like Windows. Defaults to the host platform. */
  caseInsensitive?: boolean;
}

/** One direct child of a directory, preserving its entry kind. */
export interface ListedEntry {
  name: string;
  entry: SnapshotEntry;
}

const MAX_ENTRIES = 20_000;
const MAX_PATH_LENGTH = 4_096;
const HASH_RE = /^[0-9a-f]{64}$/;
const hasControl = (value: string): boolean => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const PROTECTED = new Set(['.git', '.codex', '.vscode']);
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

function fail(code: string, message: string): never {
  throw new WorkerError(code, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

/**
 * File entry with optional mode metadata. `mode` is emitted only when it is
 * known (explicitly requested or preserved from an existing entry); an omitted
 * mode means DEFAULT_FILE_MODE (0o644), the documented legacy default, so
 * entries that never carried a mode keep their exact persisted shape.
 */
function fileEntry(hash: string, size: number, mode: FileMode | undefined): SnapshotEntry {
  return mode === undefined ? { type: 'file', hash, size } : { type: 'file', hash, size, mode };
}

/**
 * Validate one persisted entry and return a frozen copy, so later mutation of
 * the caller's object cannot change the tree. An ordinary '__proto__' own key
 * is cloned like any other key, never treated as a prototype write.
 */
function freezeEntry(key: string, raw: unknown): SnapshotEntry {
  if (!isPlainRecord(raw)) {
    fail('isolation_corrupt', `malformed entry for ${key}`);
  }
  const fields = raw.type === 'file' ? ['type', 'hash', 'size', 'mode']
    : raw.type === 'directory' ? ['type'] : ['type', 'detail'];
  if (Object.keys(raw).some(field => !fields.includes(field))) {
    fail('isolation_corrupt', `unknown entry field for ${key}`);
  }
  switch (raw.type) {
    case 'file': {
      const { hash, size, mode } = raw;
      if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
        fail('isolation_corrupt', `bad hash for ${key}`);
      }
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        fail('isolation_corrupt', `bad size for ${key}`);
      }
      if (mode !== undefined && !isFileMode(mode)) {
        fail('isolation_corrupt', `bad mode for ${key}`);
      }
      return Object.freeze(fileEntry(hash, size, mode)) as SnapshotEntry;
    }
    case 'directory':
      return Object.freeze({ type: 'directory' } as SnapshotEntry);
    case 'unsupported':
    case 'excluded':
      if (typeof raw.detail !== 'string') {
        fail('isolation_corrupt', `bad detail for ${key}`);
      }
      return Object.freeze({ type: raw.type, detail: raw.detail } as SnapshotEntry);
    default:
      fail('isolation_corrupt', `unknown entry type for ${key}`);
  }
}

function componentProblem(seg: string): string | null {
  if (seg.length === 0) {
    return 'empty path component';
  }
  if (seg.length > 255) {
    return 'path component too long';
  }
  if (hasControl(seg)) {
    return 'path contains a control character';
  }
  if (seg.includes(':')) {
    return 'path contains a colon (ADS or drive)';
  }
  // Windows-forbidden characters by code, avoiding a regex escape.
  for (let i = 0; i < seg.length; i += 1) {
    const code = seg.charCodeAt(i);
    if (code === 34 || code === 42 || code === 60 || code === 62 || code === 63 || code === 124) {
      return 'path contains a Windows-forbidden character';
    }
  }
  if (seg.endsWith('.') || seg.endsWith(' ')) {
    return 'path component ends in dot or space';
  }
  if (RESERVED.has(seg.split('.')[0].toLowerCase())) {
    return `reserved device name: ${seg}`;
  }
  return null;
}

export class LayeredTree {
  private readonly map: Record<string, SnapshotEntry>;
  private readonly lower: Map<string, string> | undefined;
  private readonly root: string;
  private readonly caseInsensitive: boolean;

  constructor(
    root: string,
    base: Readonly<Record<string, SnapshotEntry>>,
    deltas?: readonly Delta[],
    options: LayeredTreeOptions = {}
  ) {
    this.root = this.validateRoot(root);
    this.caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';

    // Merge base then deltas (tombstone null then replacement) into a frozen
    // copy; the caller's records are never mutated. Each revision is validated
    // independently so malformed base or delta records fail closed even when
    // a later delta overwrites the offending key.
    const lowerLookup = this.caseInsensitive
      ? new Map<string, string>()
      : undefined;
    const merged = this.materializeRecord(base) as Record<string, SnapshotEntry>;
    if (Object.values(merged).some(entry => entry === null)) {
      fail('isolation_corrupt', 'base entries cannot be tombstones');
    }
    for (const key of Object.getOwnPropertyNames(merged)) {
      lowerLookup?.set(key.toLowerCase(), key);
    }
    const lookup = (key: string): string | undefined => {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        return key;
      }
      return lowerLookup?.get(key.toLowerCase());
    };
    this.validateRevision(merged);
    for (const delta of deltas ?? []) {
      const changes = Object.entries(this.materializeRecord(delta));
      // Deltas are sets: JSON key ordering cannot alter a case-only rename.
      for (const [key, value] of [...changes.filter(([, value]) => value === null), ...changes.filter(([, value]) => value !== null)]) {
        if (value === null) {
          const victim = lookup(key);
          if (victim !== undefined) {
            delete merged[victim];
            lowerLookup?.delete(victim.toLowerCase());
          }
        } else {
          const replaced = lookup(key);
          if (replaced !== undefined && replaced !== key) {
            fail('isolation_corrupt', `case collision: ${replaced} and ${key}`);
          }
          merged[key] = value;
          lowerLookup?.set(key.toLowerCase(), key);
        }
      }
      this.validateRevision(merged);
    }

    this.map = Object.freeze(merged);
    if (this.caseInsensitive) {
      this.lower = new Map<string, string>();
      for (const key of Object.getOwnPropertyNames(merged)) {
        this.lower.set(key.toLowerCase(), key);
      }
    } else {
      this.lower = undefined;
    }
  }

  /** Read-only merged namespace for adapters. */
  get entries(): Readonly<Record<string, SnapshotEntry>> {
    return this.map;
  }

  get size(): number {
    return Object.getOwnPropertyNames(this.map).length;
  }

  /** Canonical existing key for an input path, or `undefined` when absent. `'.'` is the root. */
  resolve(input: string): string | undefined {
    const key = this.normalize(input, false);
    if (key === '.') {
      return '.';
    }
    return this.findExisting(key);
  }

  /** Entry for an input path, or `undefined` when absent (including the root). */
  stat(input: string): SnapshotEntry | undefined {
    const key = this.resolve(input);
    if (key === undefined || key === '.') {
      return undefined;
    }
    return this.map[key];
  }

  /** Sorted one-level listing of a directory, preserving entry kinds. */
  list(input: string): ListedEntry[] {
    const key = this.resolve(input);
    if (key === undefined) {
      fail('not_found', `no such path: ${input}`);
    }
    if (key !== '.' && this.map[key].type !== 'directory') {
      fail('not_a_directory', `not a directory: ${key}`);
    }
    const prefix = key === '.' ? '' : `${key}/`;
    const out: ListedEntry[] = [];
    for (const name of Object.getOwnPropertyNames(this.map)) {
      if (name.startsWith(prefix)) {
        const rest = name.slice(prefix.length);
        if (!rest.includes('/')) {
          out.push({ name: rest, entry: this.map[name] });
        }
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * Plan a file write (create or overwrite). Parent must be an existing
   * directory. `mode` defaults to the existing entry's recorded mode on an
   * overwrite; a new file (or a legacy entry without a mode) keeps the
   * optional field absent, which readers resolve to DEFAULT_FILE_MODE
   * (0o644). An explicit mode is validated and persisted.
   */
  write(input: string, hash: string, size: number, expectedHash: string | 'new', mode?: FileMode): Delta {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      fail('invalid_path', 'hash must be 64 lowercase hex characters');
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      fail('invalid_path', 'size must be a non-negative integer');
    }
    if (mode !== undefined && !isFileMode(mode)) {
      fail('invalid_path', 'mode must be 0o644 or 0o755');
    }
    const rawKey = this.normalize(input, true);
    if (rawKey === '.') {
      fail('invalid_path', 'the root cannot be a file');
    }
    this.checkParentDir(rawKey);
    const key = this.canonicalizeParent(rawKey);
    const existingKey = this.findExisting(key);
    const existing = existingKey === undefined ? undefined : this.map[existingKey];
    if (existingKey !== undefined && existing !== undefined) {
      if (existing.type !== 'file') {
        fail('readonly_path', `cannot overwrite ${existingKey} as a file`);
      }
      if (expectedHash === 'new') {
        fail('path_conflict', `${existingKey} already exists`);
      }
      if (expectedHash !== existing.hash) {
        fail('stale_hash', `stale hash for ${existingKey}`);
      }
      return { [existingKey]: fileEntry(hash, size, mode ?? existing.mode) };
    }
    if (expectedHash !== 'new') {
      fail('stale_hash', `no such entry: ${key}`);
    }
    return { [key]: fileEntry(hash, size, mode) };
  }

  /** Plan directory creation; idempotent when the directory already exists. */
  mkdir(input: string): Delta {
    const key = this.normalize(input, true);
    if (key === '.') {
      fail('invalid_path', 'the root already exists');
    }
    this.checkParentDir(key);
    const canon = this.canonicalizeParent(key);
    const entry: SnapshotEntry = { type: 'directory' };
    const existingKey = this.findExisting(canon);
    if (existingKey !== undefined) {
      const existing = this.map[existingKey];
      if (existing.type !== 'directory') {
        fail('path_conflict', `cannot create directory: ${existingKey} is a ${existing.type}`);
      }
      return { [existingKey]: entry };
    }
    return { [canon]: entry };
  }

  /** Plan deletion of a file. Directories are not deletable (legacy parity). */
  delete(input: string, expectedHash: string): Delta {
    const key = this.normalize(input, true);
    if (key === '.') {
      fail('invalid_path', 'the root cannot be deleted');
    }
    const existingKey = this.findExisting(key);
    if (existingKey === undefined) {
      fail('not_found', `no such entry: ${key}`);
    }
    const existing = this.map[existingKey];
    if (existing.type !== 'file') {
      fail('unsupported', `cannot delete ${existingKey}: only files are supported`);
    }
    if (expectedHash !== existing.hash) {
      fail('stale_hash', `stale hash for ${existingKey}`);
    }
    return { [existingKey]: null };
  }

  /** Plan rename of a file. A case-only rename succeeds; existing destinations are refused. */
  rename(input: string, target: string, expectedHash: string): Delta {
    const src = this.normalize(input, true);
    const tgt = this.normalize(target, true);
    if (src === '.') {
      fail('invalid_path', 'cannot rename the root');
    }
    if (tgt === '.') {
      fail('invalid_path', 'cannot rename into the root');
    }
    const srcKey = this.findExisting(src);
    if (srcKey === undefined) {
      fail('not_found', `no such entry: ${src}`);
    }
    const existing = this.map[srcKey];
    if (existing.type !== 'file') {
      fail('unsupported', `cannot rename ${srcKey}: only files are supported`);
    }
    if (expectedHash !== existing.hash) {
      fail('stale_hash', `stale hash for ${srcKey}`);
    }
    this.checkParentDir(tgt);
    const canonTgt = this.canonicalizeParent(tgt);
    const tgtExisting = this.findExisting(canonTgt);
    // A rename preserves the file's recorded mode verbatim; a legacy entry
    // without a mode stays without one (documented 0o644 default).
    const entry = fileEntry(existing.hash, existing.size, existing.mode);
    if (tgtExisting !== undefined) {
      if (tgtExisting === srcKey) {
        // Self rename (no-op) or case-only rename: tombstone old key, then
        // emit the replacement under the (possibly new-case) target key.
        if (canonTgt === srcKey) {
          return { [srcKey]: entry };
        }
        return { [srcKey]: null, [canonTgt]: entry };
      }
      fail('path_conflict', `rename destination already exists: ${tgtExisting}`);
    }
    return { [srcKey]: null, [canonTgt]: entry };
  }

  // -- internals ------------------------------------------------------------

  private findExisting(key: string): string | undefined {
    if (Object.prototype.hasOwnProperty.call(this.map, key)) {
      return key;
    }
    return this.lower?.get(key.toLowerCase());
  }

  private parentOf(key: string): string {
    const idx = key.lastIndexOf('/');
    return idx === -1 ? '.' : key.slice(0, idx);
  }

  private checkParentDir(key: string): void {
    const parent = this.parentOf(key);
    if (parent === '.') {
      return;
    }
    const parentKey = this.findExisting(parent);
    if (parentKey === undefined) {
      fail('not_found', `no such parent directory: ${parent}`);
    }
    if (this.map[parentKey].type !== 'directory') {
      fail('not_a_directory', `parent is not a directory: ${parentKey}`);
    }
  }

  /**
   * Rewrite each EXISTING parent component of a new key to its canonical
   * case (`SRC/new` -> `src/new`), preserving the requested leaf case so a
   * case-only rename keeps its new leaf spelling. The parent directory chain
   * is guaranteed to exist by the preceding checkParentDir call.
   */
  private canonicalizeParent(key: string): string {
    const parts = key.split('/');
    const out: string[] = [];
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      const existing = this.findExisting(prefix);
      if (existing === undefined) {
        break;
      }
      const tail = existing.split('/').pop();
      out.push(tail === undefined ? key : tail);
      if (i === parts.length - 1) {
        break;
      }
    }
    return [...out, parts[parts.length - 1]].join('/');
  }

  /**
   * Normalize an input path to a relative POSIX key ('.' is the root). Root
   * alias matching is case-insensitive (drive letter included) when the tree
   * is case-insensitive; absolute and drive-relative inputs outside the root
   * are refused.
   */
  private normalize(input: string, protectedCheck: boolean): string {
    if (typeof input !== 'string') {
      fail('invalid_path', 'path must be a string');
    }
    if (input.length > MAX_PATH_LENGTH) {
      fail('invalid_path', 'path exceeds maximum length');
    }
    const normRoot = this.root;
    const rootPrefix = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
    const norm = input.replace(/\\/g, '/');
    let rel = '';
    const outside = (): never => fail('invalid_path', 'absolute path outside the root');
    if (this.caseInsensitive) {
      const lower = norm.toLowerCase();
      const lowerRoot = normRoot.toLowerCase();
      if (lower === lowerRoot || lower === rootPrefix.toLowerCase()) {
        rel = '';
      } else if (lower.startsWith(rootPrefix.toLowerCase())) {
        rel = norm.slice(rootPrefix.length);
      } else if (lower.startsWith('/') || /^[a-z]:/i.test(norm)) {
        outside();
      } else {
        rel = norm;
      }
    } else if (norm === normRoot || norm === rootPrefix) {
      rel = '';
    } else if (norm.startsWith(rootPrefix)) {
      rel = norm.slice(rootPrefix.length);
    } else if (norm.startsWith('/') || /^[a-z]:/i.test(norm)) {
      outside();
    } else {
      rel = norm;
    }
    const stack: string[] = [];
    for (const raw of rel.split('/')) {
      if (raw === '' || raw === '.') {
        continue;
      }
      if (raw === '..') {
        if (stack.length === 0) {
          fail('invalid_path', 'path escapes the root');
        }
        stack.pop();
        continue;
      }
      const problem = componentProblem(raw);
      if (problem !== null) {
        fail('invalid_path', problem);
      }
      if (protectedCheck && PROTECTED.has(raw.toLowerCase())) {
        fail('protected_path', `protected path: ${raw}`);
      }
      stack.push(raw);
    }
    return stack.length === 0 ? '.' : stack.join('/');
  }

  /** Clone + freeze a persisted record (base or delta); strict plain records only. */
  private materializeRecord(raw: Readonly<Record<string, SnapshotEntry | null>>): Record<string, SnapshotEntry | null> {
    if (!isPlainRecord(raw)) {
      fail('isolation_corrupt', 'delta must be a plain record');
    }
    const out = Object.create(null) as Record<string, SnapshotEntry | null>;
    for (const key of Object.getOwnPropertyNames(raw)) {
      this.validateEntryKey(key);
      const value = raw[key];
      if (value === null) {
        out[key] = null;
      } else {
        out[key] = freezeEntry(key, value);
      }
    }
    return out;
  }

  /** Validate one fully merged namespace revision (shape already frozen). */
  private validateRevision(merged: Record<string, SnapshotEntry>): void {
    const keys = Object.getOwnPropertyNames(merged);
    if (keys.length > MAX_ENTRIES) {
      fail('isolation_corrupt', 'merged namespace exceeds maximum entry count');
    }
    if (this.caseInsensitive) {
      const lowerFull = new Map<string, string>();
      for (const key of keys) {
        const lf = key.toLowerCase();
        const other = lowerFull.get(lf);
        if (other !== undefined) {
          fail('isolation_corrupt', `case collision: ${other} and ${key}`);
        }
        lowerFull.set(lf, key);
      }
    }
    for (const key of keys) {
      if (key === '.') {
        fail('isolation_corrupt', 'root is not a valid entry');
      }
      this.validateEntryKey(key);
    }
    // Parent-directory validation walks every chain to the root, which also
    // proves no file has children (a child's parent would be that file).
    for (const key of keys) {
      let parent = key;
      for (;;) {
        const idx = parent.lastIndexOf('/');
        if (idx === -1) {
          break;
        }
        parent = parent.slice(0, idx);
        const parentEntry = merged[parent];
        if (parentEntry === undefined) {
          fail('isolation_corrupt', `missing parent directory: ${parent}`);
        }
        if (parentEntry.type !== 'directory') {
          fail('isolation_corrupt', `parent is not a directory: ${parent}`);
        }
      }
    }
  }

  private validateEntryKey(key: string): void {
    if (key.length > MAX_PATH_LENGTH) {
      fail('isolation_corrupt', `entry path exceeds maximum length: ${key}`);
    }
    if (key.includes('\\')) {
      fail('isolation_corrupt', `entry path contains a backslash: ${key}`);
    }
    for (const seg of key.split('/')) {
      const problem = componentProblem(seg);
      if (problem !== null) {
        fail('isolation_corrupt', `entry ${key}: ${problem}`);
      }
    }
  }

  /** Root must be a non-empty absolute path (native or POSIX); no FS access. */
  private validateRoot(root: string): string {
    if (typeof root !== 'string' || root.length === 0 || root.length > MAX_PATH_LENGTH) {
      fail('isolation_corrupt', 'root must be an absolute path string');
    }
    const slashRoot = root.replace(/\\/g, '/');
    const isDrive = /^[A-Za-z]:\//.test(slashRoot);
    if (!slashRoot.startsWith('/') && !isDrive) {
      fail('isolation_corrupt', 'root must be an absolute path');
    }
    const tail = slashRoot.slice(isDrive ? 3 : slashRoot.startsWith('//') ? 2 : 1).replace(/\/+$/, '');
    if (tail && tail.split('/').some(seg => componentProblem(seg) !== null)) {
      fail('isolation_corrupt', 'root path contains a forbidden component');
    }
    return slashRoot === '/' || /^[A-Za-z]:\/$/.test(slashRoot) ? slashRoot : slashRoot.replace(/\/+$/, '');
  }
}
