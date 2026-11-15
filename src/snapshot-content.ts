import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WorkerError } from './types';

// ---------------------------------------------------------------------------
// Shared immutable content store and non-Git capture foundation.
//
// Snapshots are immutable, fail-closed content references: every captured byte
// lives in the ContentStore content-addressed store (CAS) under its SHA-256
// hash. Reads verify the hash and NEVER fall back to the live workspace; a
// missing or corrupted blob is a `snapshot_content_missing` error. put() also
// verifies an existing blob before treating the hash as reusable, so a
// corrupted blob can never be published as part of a capture. Identical bytes
// are stored once and shared by every later snapshot.
//
// captureContent() captures a non-Git root without full copies:
//  - Selection: the regular file tree, excluding dot-prefixed DIRECTORIES
//    (.git, .codex, .vscode, ...) and the case-insensitive dependency/build
//    directories in EXCLUDED_DIRECTORY_NAMES, plus the store directory when it
//    is inside the root. Dot-named regular files (.gitignore, ...) are normal
//    content. Excluded and unsupported entries are recorded in the manifest,
//    which bounds ALL entries (files, directories, unsupported, excluded)
//    with maxEntries.
//  - Symlinks/junctions and other special files are never traversed or
//    followed; they are recorded as `unsupported`. Every component of every
//    visited or read path is validated before and after the operation:
//    symlinks/special components are rejected, and each component's
//    dev/ino/type identity must be stable, so a swapped junction parent can
//    never be traversed into outside content. Directory listings additionally
//    recheck the whole component chain (including the root dev/ino) before
//    and after readdir, so a swapped junction is never listed or descended.
//  - openDocuments() is a synchronous injected enumeration of editor text
//    (absolute path, text, optional version). Records are cloned on every
//    enumeration; a fresh enumeration is taken before AND after EVERY full
//    scan and all eligible signatures must agree. Included editor text
//    overrides disk bytes ONCE for that capture; unsaved file-backed new
//    documents are included with virtual directory entries for missing
//    parents; on case-insensitive platforms an editor path that is a case
//    alias of an already-captured file resolves to the captured canonical
//    key. The path-safe component check runs BEFORE exclusion; documents
//    whose final component is an existing directory, whose parent is a file
//    or unsupported component, or whose key conflicts with a captured
//    directory or a virtual file parent are ignored consistently. Documents
//    with non-absolute paths are ignored explicitly.
//  - Consistency: two complete scans (enumeration + reads + document
//    fingerprints) must agree; otherwise the capture retries up to
//    maxAttempts (default 3, hard cap MAX_CAPTURE_ATTEMPTS) and then fails
//    with `inconsistent_capture`.
//  - Capacity: explicit per-file, per-capture file-count, byte and entry caps
//    (maxFiles, maxFileBytes, maxTotalBytes, maxEntries, maxAttempts) are
//    enforced while reading; callers may tighten but never exceed
//    DEFAULT_CAPTURE_LIMITS; violations throw `snapshot_capacity` and are
//    never truncated.
//  - A `guard?: () => void` live flag is checked after awaits and immediately
//    before blob publication (rename), on both the capture and store; the
//    capture guard is carried into every blob put and the final manifest
//    return, so a revoked guard can never leave a partially published capture
//    behind as success.
//  - Manifest keys are canonical POSIX root-relative paths in a
//    prototype-less object; case-colliding paths fail with
//    `snapshot_case_conflict`.
// ---------------------------------------------------------------------------

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

/** Explicit capture capacity caps; callers may tighten, never exceed validation. */
export interface CaptureLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  /** Maximum attempts to obtain two matching complete scans (hard cap 3). */
  maxAttempts: number;
}

/** Hard upper bound on capture attempts; the public contract is capped here. */
export const MAX_CAPTURE_ATTEMPTS = 3;

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxFiles: 10_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
  maxAttempts: MAX_CAPTURE_ATTEMPTS
};

/** Non-hidden directory names never traversed (dependency and build output), matched case-insensitively. */
export const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);

/** Hard-excluded component names (case-insensitive); excluded in selection mode too, including as a leaf file name. */
export const PROTECTED_COMPONENT_NAMES: ReadonlySet<string> = new Set(['.git', '.codex', '.vscode']);

const isProtectedComponent = (name: string): boolean => PROTECTED_COMPONENT_NAMES.has(name.toLowerCase());

function validateLimits(limits: CaptureLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new WorkerError('invalid_capture_limits', `Limit ${name} must be a positive integer, got ${String(value)}.`);
    }
    const maximum = DEFAULT_CAPTURE_LIMITS[name as keyof CaptureLimits];
    if (value > maximum) {
      throw new WorkerError('invalid_capture_limits', `Limit ${name} is ${value}; the maximum is ${maximum}.`);
    }
  }
}

/** One open editor document as reported by the host enumeration callback. */
export interface OpenDocument {
  /** Absolute path of the document. */
  path: string;
  /** Current unsaved document text. */
  text: string;
  /** Per-document version; detection also hashes the text. */
  version?: string | number;
}

export type SnapshotEntry =
  | { type: 'file'; hash: string; size: number }
  | { type: 'directory' }
  | { type: 'unsupported'; detail: string }
  | { type: 'excluded'; detail: string };

/** Immutable capture result; bytes are only reachable through the ContentStore. */
export interface SnapshotManifest {
  schema: 1;
  root: string;
  capturedAt: string;
  /** Stable identity of the captured selection, including editor overrides. */
  fingerprint: string;
  fileCount: number;
  totalBytes: number;
  /** Canonical POSIX root-relative path -> entry (prototype-less object). */
  entries: Record<string, SnapshotEntry>;
}

/**
 * Opt-in coherent selection of root-relative POSIX paths (files, plus their
 * parent directories) that a capture should include. The hook is queried
 * before and after every full scan; the four results (canonical paths,
 * unsupported map and fingerprint) must agree for the capture to succeed.
 */
export interface CaptureSelection {
  /** Root-relative POSIX file paths (no escape/dot components/backslash/NUL, <=4096 chars each). */
  readonly paths: readonly string[];
  /** Stable identity of the selection, compared across the four query points. */
  readonly fingerprint: string;
  /** Selected paths that are supported-unreadable (e.g. Git symlinks/gitlinks); keys must be selected paths. */
  readonly unsupported?: Readonly<Record<string, string>>;
}

export interface CaptureOptions {
  /** Opt-in selection hook; when present, only selected paths (plus editor docs) are captured. */
  selection?: () => Promise<CaptureSelection>;
  /** Synchronous enumeration of open editor documents (unsaved text included). */
  openDocuments?: () => OpenDocument[];
  /** Deterministic hook after the first scan of each attempt (tests inject churn here). */
  afterScan?: (attempt: number) => void | Promise<void>;
  /** Hook before every visited path is stat'ed (deterministic test swaps). */
  beforeVisit?: (absolutePath: string) => void | Promise<void>;
  /** Hook before every file's bytes are read (deterministic test swaps). */
  beforeRead?: (absolutePath: string) => void | Promise<void>;
  /** Hook immediately before a directory is listed (deterministic test swaps). */
  beforeList?: (absolutePath: string) => void | Promise<void>;
  limits?: Partial<CaptureLimits>;
  /** Maximum attempts to obtain two matching complete scans (default 3, hard cap 3). */
  maxAttempts?: number;
  /** Live host guard (closing/feature flag/abort); throws to abort. */
  guard?: () => void;
  /**
     * Pluggable content storage: buildManifest calls this instead of
   * store.put(bytes, guard) for every captured file. The returned hash
   * must be the EXACT SHA-256 of `bytes`; anything else fails closed with
   * `snapshot_content_missing`. Bytes come from the captured scan only, so a
   * live filesystem fallback is impossible.
   */
  storeContent?: (key: string, bytes: Buffer, guard?: () => void) => Promise<string>;
}

async function atomicWriteBytes(file: string, bytes: Buffer, beforeRename?: () => void): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    beforeRename?.();
    await fs.rename(temporary, file);
    try {
      const directory = await fs.open(path.dirname(file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch { /* The atomic rename already protects readers. */ }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Content-addressed immutable byte store. put() dedupes identical content,
 * verifying an existing blob before reusing its hash; read() verifies the
 * SHA-256 of returned bytes and fails closed. put() combines the constructor
 * guard with an optional per-operation authorize callback and checks both
 * after awaits and immediately before the blob rename (publication) and
 * before returning success for an existing blob.
 */
export class ContentStore {
  readonly directory: string;
  private readonly blobRoot: string;
  private readonly guard?: () => void;

  constructor(baseDirectory: string, options: { guard?: () => void } = {}) {
    this.directory = path.resolve(baseDirectory);
    this.blobRoot = path.join(this.directory, 'blobs');
    this.guard = options.guard;
  }

  private blobPath(hash: string): string {
    return path.join(this.blobRoot, hash.slice(0, 2), hash.slice(2));
  }

  private checkGuards(authorize?: () => void): void {
    this.guard?.();
    authorize?.();
  }

  async has(hash: string): Promise<boolean> {
    if (!HASH_PATTERN.test(hash)) {
      return false;
    }
    try {
      const stat = await fs.stat(this.blobPath(hash));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Store bytes once; returns the SHA-256 hash regardless of prior presence.
   * The optional authorize callback (e.g. a capture guard) is combined with
   * the store guard and enforced across the whole operation, including
   * immediately before the publishing rename and before an existing blob is
   * reported as successfully published.
   */
  async put(bytes: Buffer, authorize?: () => void): Promise<string> {
    this.checkGuards(authorize);
    const content = Buffer.from(bytes);
    const hash = sha256(content);
    const file = this.blobPath(hash);
    if (await this.has(hash)) {
      // An existing blob must be readable and correct before a capture may
      // point at it; corrupt content fails closed instead of publishing an
      // unreadable capture.
      const existing = await fs.readFile(file);
      this.checkGuards(authorize);
      if (sha256(existing) !== hash) {
        throw new WorkerError('snapshot_content_missing', `Existing blob ${hash} is corrupt; refusing to publish a capture over unreadable content.`);
      }
      this.checkGuards(authorize);
      return hash;
    }
    await atomicWriteBytes(file, content, () => this.checkGuards(authorize));
    return hash;
  }

  /** Read verified bytes; missing or corrupted content is snapshot_content_missing, never a live fallback. */
  async read(hash: string): Promise<Buffer> {
    if (!HASH_PATTERN.test(hash)) {
      throw new WorkerError('snapshot_content_missing', `Invalid content hash: ${hash}`);
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.blobPath(hash));
    } catch {
      throw new WorkerError('snapshot_content_missing', `Snapshot content is missing for ${hash}; refusing to fall back to the live workspace.`);
    }
    if (sha256(bytes) !== hash) {
      throw new WorkerError('snapshot_content_missing', `Snapshot content for ${hash} failed hash verification; refusing to fall back to the live workspace.`);
    }
    return bytes;
  }
}

/**
 * Resolve an editor document's root-relative key against already-captured
 * file keys. On case-insensitive platforms a pure case alias of an existing
 * key maps to that canonical key instead of creating a colliding duplicate.
 */
export function resolveDocumentKey(existingKeys: Iterable<string>, relative: string, caseInsensitive: boolean): string {
  if (!caseInsensitive) {
    return relative;
  }
  const folded = relative.toLowerCase();
  for (const key of existingKeys) {
    if (key.toLowerCase() === folded) {
      return key;
    }
  }
  return relative;
}

class CaptureChanged extends Error {}

const selectionKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;

/** Validated, canonicalized selection; the same object is passed to both scans of one attempt. */
interface SelectionContext {
  files: Set<string>;
  prefixes: Set<string>;
  unsupported: Map<string, string>;
  /** Case-folded membership keys (win32); exact-case keys elsewhere. */
  foldedFiles: Set<string>;
  foldedPrefixes: Set<string>;
  foldedUnsupported: Set<string>;
}

/**
 * Validate and canonicalize a CaptureSelection. Paths must be nonempty
 * relative POSIX paths with no dot components, backslashes, NUL or escapes;
 * the selection count is capped by maxEntries (never truncated); unsupported
 * keys must be selected paths. Every valid selected path is retained,
 * including paths under protected component names: the scan itself excludes
 * only EXISTING protected entries before any stat, so a selected path like
 * `src/.git/config` neither fabricates an excluded prefix nor is read.
 */
function normalizeSelection(selection: CaptureSelection, maxEntries: number): SelectionContext {
  const caseInsensitive = process.platform === 'win32';
  const seen = new Set<string>();
  const retained: string[] = [];
  for (const raw of selection.paths) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
      throw new WorkerError('invalid_capture_selection', `Selection path must be a nonempty string of at most 4096 chars, got ${JSON.stringify(raw)}.`);
    }
    if (raw.includes('\\') || raw.includes('\0') || raw.startsWith('/')) {
      throw new WorkerError('invalid_capture_selection', `Selection path is not a relative POSIX path: ${JSON.stringify(raw)}.`);
    }
    const segments = raw.split('/');
    if (segments.some(part => part === '' || part === '.' || part === '..')) {
      throw new WorkerError('invalid_capture_selection', `Selection path has an escape or dot component: ${JSON.stringify(raw)}.`);
    }
    const key = caseInsensitive ? raw.toLowerCase() : raw;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    retained.push(raw);
  }
  if (seen.size > maxEntries) {
    throw new WorkerError('invalid_capture_selection', `Selection has ${seen.size} paths; the maxEntries cap is ${maxEntries} (the selection is never truncated).`);
  }
  const prefixes = new Set<string>();
  for (const file of retained) {
    let cut = file.lastIndexOf('/');
    while (cut >= 0) {
      prefixes.add(file.slice(0, cut));
      cut = file.lastIndexOf('/', cut - 1);
    }
  }
  const unsupported = new Map<string, string>(Object.entries(selection.unsupported ?? {}));
  for (const key of unsupported.keys()) {
    if (!seen.has(caseInsensitive ? key.toLowerCase() : key)) {
      throw new WorkerError('invalid_capture_selection', `Unsupported key is not a selected path: ${JSON.stringify(key)}.`);
    }
  }
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  return {
    files: new Set(retained),
    prefixes,
    unsupported,
    foldedFiles: new Set(retained.map(fold)),
    foldedPrefixes: new Set([...prefixes].map(fold)),
    foldedUnsupported: new Set([...unsupported.keys()].map(fold))
  };
}

/**
 * Clone-safe validation of one raw selection query: a fresh plain object with
 * its OWN paths array, unsupported entries and fingerprint is built, so a
 * provider that returns the same object mutated across query points can
 * never change the captured baseline. The guard is checked after the await.
 */
export function cloneSelectionQuery(raw: unknown, guard?: () => void): CaptureSelection {
  guard?.();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WorkerError('invalid_capture_selection', 'selection hook must return an object with paths and fingerprint.');
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.paths) || typeof record.fingerprint !== 'string') {
    throw new WorkerError('invalid_capture_selection', 'selection hook must return { paths: string[], fingerprint: string, unsupported? }.');
  }
  const rawUnsupported = record.unsupported;
  let unsupportedClone: Record<string, string> | undefined;
  if (rawUnsupported !== undefined) {
    if (typeof rawUnsupported !== 'object' || rawUnsupported === null || Array.isArray(rawUnsupported)) {
      throw new WorkerError('invalid_capture_selection', 'selection unsupported must be a path -> detail record.');
    }
    unsupportedClone = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(rawUnsupported as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new WorkerError('invalid_capture_selection', `Unsupported detail for ${JSON.stringify(key)} must be a string.`);
      }
      unsupportedClone[key] = value;
    }
  }
  const clone: CaptureSelection = {
    paths: [...record.paths], fingerprint: record.fingerprint,
    ...(unsupportedClone !== undefined ? { unsupported: unsupportedClone } : {})
  };
  guard?.();
  return clone;
}

/** Canonical (case-folded, deduped, sorted) view of a selection query for comparison. */
function selectionCanonical(selection: CaptureSelection): string {
  const folded = selectionKey;
  const paths = [...new Set([...selection.paths].map(value => {
    if (typeof value !== 'string') {
      throw new WorkerError('invalid_capture_selection', `Selection path must be a string, got ${JSON.stringify(value)}.`);
    }
    return folded(value);
  }))].sort();
  const unsupported = [...new Map(Object.entries(selection.unsupported ?? {}).map(([key, value]) => [folded(key), value])).entries()].sort();
  return JSON.stringify({ fingerprint: selection.fingerprint, paths, unsupported });
}

/** Stable, clone-safe equality of two selection queries across capture boundaries. */
function selectionAgrees(a: CaptureSelection, b: CaptureSelection): boolean {
  return selectionCanonical(a) === selectionCanonical(b);
}

const documentVersion = (document: OpenDocument): string => `${document.version ?? ''}:${sha256(document.text)}`;
const documentsSignature = (documents: ReadonlyMap<string, string>): string => sha256(JSON.stringify([...documents.entries()].sort()));
const plannedSignature = (documents: ReadonlyMap<string, OpenDocument>): string =>
  documentsSignature(new Map([...documents].map(([key, document]) => [key, documentVersion(document)])));

/** Shared eligibility for editor overrides and their consistency boundaries. */
async function editorDocumentKey(root: string, storeDirectory: string, absolute: string, selection: SelectionContext | null): Promise<string | undefined> {
  if (!path.isAbsolute(absolute)) {
    return undefined;
  }
  const relative = path.relative(root, path.resolve(absolute));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  const key = relative.split(path.sep).join('/');
  const storeRelative = path.relative(root, storeDirectory).split(path.sep).join('/');
  if (key === storeRelative || key.startsWith(`${storeRelative}/`)) {
    return undefined;
  }
  const segments = key.split('/');
  if (segments.some(isProtectedComponent)) {
    return undefined;
  }
  let cursor = root;
  for (let i = 0; i < segments.length; i += 1) {
    const prefix = segments.slice(0, i + 1).join('/');
    if (selection?.foldedUnsupported.has(selectionKey(prefix))) {
      return undefined;
    }
    cursor = path.join(cursor, segments[i]);
    const stat = await fs.lstat(cursor).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    const last = i === segments.length - 1;
    if (stat?.isSymbolicLink() || (stat && !stat.isFile() && !stat.isDirectory())
      || (stat?.isFile() && !last) || (stat?.isDirectory() && last)) {
      return undefined;
    }
    // Dot-named regular files remain eligible; missing dot names follow the
    // same exclusion rule as the scan's existing editor override behavior.
    if (!stat?.isFile() && (EXCLUDED_DIRECTORY_NAMES.has(segments[i].toLowerCase())
      || (selection === null && segments[i].startsWith('.')))) {
      return undefined;
    }
  }
  return key;
}

interface EditorNamespace {
  files: ReadonlySet<string>;
  directories: ReadonlySet<string>;
}

/** Apply exactly the same namespace decisions to overrides and fresh queries. */
async function planEditorDocuments(root: string, storeDirectory: string, documents: OpenDocument[], selection: SelectionContext | null,
  namespace: EditorNamespace, guard?: () => void): Promise<Map<string, OpenDocument>> {
  const files = new Map([...namespace.files].map(key => [selectionKey(key), key]));
  const directories = new Map([...namespace.directories].map(key => [selectionKey(key), key]));
  const accepted = new Map<string, OpenDocument>();
  guard?.();
  for (const document of documents) {
    const relative = await editorDocumentKey(root, storeDirectory, document.path, selection);
    guard?.();
    if (relative === undefined) {
      continue;
    }
    let key = files.get(selectionKey(relative)) ?? relative;
    const parts = key.split('/');
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const parent = directories.get(selectionKey(parts.slice(0, i).join('/')));
      if (parent !== undefined) {
        key = `${parent}/${parts.slice(i).join('/')}`;
        break;
      }
    }
    const segments = key.split('/');
    if (segments.some((_, i) => i < segments.length - 1 && files.has(selectionKey(segments.slice(0, i + 1).join('/'))))
      || directories.has(selectionKey(key))) {
      continue;
    }
    files.set(selectionKey(key), key);
    for (let i = 1; i < segments.length; i += 1) {
      const parent = segments.slice(0, i).join('/');
      directories.set(selectionKey(parent), parent);
    }
    accepted.set(key, document);
  }
  return accepted;
}

interface ScanResult {
  files: Map<string, Buffer>;
  directories: Set<string>;
  unsupported: Map<string, string>;
  excluded: Map<string, string>;
  /** Captured disk namespace before any editor override or virtual parent. */
  editorNamespace: EditorNamespace;
  /** Canonical path -> `${version}:${sha256(text)}` for included editor documents. */
  documents: Map<string, string>;
  /**
   * Canonical path -> sorted per-file identity/stat signature (component-chain
   * dev/ino records, size, mtimeMs, ctimeMs, root identity). Folded into the
   * fingerprint, so a same-byte rewrite or touch between the two scans is
   * retryable churn, not a silent false match.
   */
  signatures: Map<string, string>;
  totalBytes: number;
}

const fingerprintOf = (scan: ScanResult): string => {
  const canonical = {
    files: [...scan.files.entries()].sort().map(([key, bytes]) => [key, sha256(bytes)]),
    signatures: [...scan.signatures.entries()].sort(),
    directories: [...scan.directories].filter(key => key !== '.').sort(),
    unsupported: [...scan.unsupported.entries()].sort(),
    excluded: [...scan.excluded.entries()].sort(),
    documents: [...scan.documents.entries()].sort()
  };
  return sha256(JSON.stringify(canonical));
};

type LstatResult = Awaited<ReturnType<typeof fs.lstat>>;

interface ScanHooks {
  beforeVisit?: (absolutePath: string) => void | Promise<void>;
  beforeRead?: (absolutePath: string) => void | Promise<void>;
  beforeList?: (absolutePath: string) => void | Promise<void>;
  guard?: () => void;
}

/** Root identity (dev/ino/type) folded into every component-chain signature. */
async function rootIdentity(root: string): Promise<string> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CaptureChanged(`Capture root is not a regular directory: ${root}`);
  }
  return `${stat.dev}:${stat.ino}:root`;
}

async function scanWorkspace(root: string, store: ContentStore, limits: CaptureLimits, documents: OpenDocument[], hooks: ScanHooks, selection: SelectionContext | null = null): Promise<ScanResult> {
  const scan: ScanResult = { files: new Map(), directories: new Set(['.']), unsupported: new Map(), excluded: new Map(),
    editorNamespace: { files: new Set(), directories: new Set() }, documents: new Map(), signatures: new Map(), totalBytes: 0 };
  let entryCount = 0;
  const addEntry = (): void => {
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      throw new WorkerError('snapshot_capacity', `Capture has ${entryCount} entries; maxEntries is ${limits.maxEntries}.`);
    }
  };
  // Root identity signature recorded BEFORE anything else: replacing the
  // entire tree, or the root dev/ino changing, is churn even when the file
  // set is byte-identical.
  scan.signatures.set('.', `${await rootIdentity(root)}|root`);
  const addFileBytes = (bytes: Buffer, relative: string): void => {
    if (bytes.length > limits.maxFileBytes) {
      throw new WorkerError('snapshot_capacity', `File ${relative} is ${bytes.length} bytes; maxFileBytes is ${limits.maxFileBytes}.`);
    }
    scan.totalBytes += bytes.length;
    if (scan.totalBytes > limits.maxTotalBytes) {
      throw new WorkerError('snapshot_capacity', `Capture is ${scan.totalBytes} bytes total; maxTotalBytes is ${limits.maxTotalBytes}.`);
    }
    if (scan.files.size >= limits.maxFiles) {
      throw new WorkerError('snapshot_capacity', `Capture has ${scan.files.size} files; maxFiles is ${limits.maxFiles}.`);
    }
  };

  const toRel = (absolute: string): string | undefined => {
    const relative = path.relative(root, path.resolve(absolute));
    if (relative === '') {
      return '.';
    }
    // Only a true parent reference escapes the root; names such as '..notes' are legal.
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    return relative.split(path.sep).join('/');
  };

  const storeRel = toRel(store.directory);
  if (storeRel === '.') {
    throw new WorkerError('invalid_capture_root', 'The content store directory cannot be the capture root.');
  }

  const isExcludedDirectory = (name: string): boolean => name.startsWith('.') || EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase());

  // lstat that reports a vanished path as null instead of throwing, so the
  // callers keep a single deterministic flow.
  const lstatOrNull = async (cursor: string): Promise<LstatResult | null> => {
    try {
      return await fs.lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  };

  const guarded = async <T>(operation: () => Promise<T>, context: string): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      // A path vanishing or changing type mid-scan is churn to retry, not a store fault.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') {
        throw new CaptureChanged(`Path ${context} changed type or disappeared during scan`);
      }
      throw error;
    }
  };

  // One component record: symlinks and special files are rejected outright,
  // otherwise the identity (dev, ino) and type must be stable across checks.
  const componentRecord = async (cursor: string): Promise<string | undefined> => {
    const stat = await lstatOrNull(cursor);
    if (stat === null) {
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      throw new CaptureChanged(`Unsupported symlink component: ${cursor}`);
    }
    if (stat.isDirectory()) {
      return `${stat.dev}:${stat.ino}:dir`;
    }
    if (stat.isFile()) {
      return `${stat.dev}:${stat.ino}:file`;
    }
    throw new CaptureChanged(`Unsupported special-file component: ${cursor}`);
  };

  const componentParts = (absolute: string): string[] => path.relative(root, path.resolve(absolute)).split(path.sep).filter(part => part !== '' && part !== '.');

  // Component-chain signature anchored on the root dev/ino identity, so a
  // swapped or relinked root fails the same stability check.
  const chainSignature = async (absolute: string, allowMissingSuffix: boolean): Promise<string> => {
    const parts = componentParts(absolute);
    const marks: string[] = [await rootIdentity(root)];
    let cursor = root;
    for (let i = 0; i < parts.length; i += 1) {
      cursor = path.join(cursor, parts[i]);
      const record = await componentRecord(cursor);
      const last = i === parts.length - 1;
      if (record === undefined) {
        if (!allowMissingSuffix) {
          throw new CaptureChanged(`Path disappeared during scan: ${cursor}`);
        }
        marks.push('missing');
        continue;
      }
      if (!last && record.endsWith(':file')) {
        throw new CaptureChanged(`A directory component is a file: ${cursor}`);
      }
      marks.push(record);
    }
    return marks.join('|');
  };

  const visit = async (absolute: string): Promise<void> => {
    await hooks.beforeVisit?.(absolute);
    const relative = toRel(absolute);
    if (relative === undefined) {
      throw new CaptureChanged(`Path escaped capture root: ${absolute}`);
    }
    // Case-folded lookup (win32); the actual on-disk case is preserved in
    // scan.unsupported so the manifest keeps real names.
    const forcedUnsupported = (rel: string): string | undefined => {
      if (selection === null) {
        return undefined;
      }
      const folded = selectionKey(rel);
      if (selection.foldedUnsupported.has(folded)) {
        for (const [key, detail] of selection.unsupported) {
          if (selectionKey(key) === folded) {
            return detail;
          }
        }
      }
      return undefined;
    };
    if (selection !== null && relative !== '.' && forcedUnsupported(relative) !== undefined) {
      // Forced unsupported (e.g. a Git symlink/gitlink entry): record it and
      // never read bytes or descend; editor docs on/below it cannot override.
      scan.unsupported.set(relative, forcedUnsupported(relative) ?? 'unsupported');
      addEntry();
      return;
    }
    if (relative !== '.' && isProtectedComponent(path.basename(absolute))) {
      // Hard-excluded leaf (a regular file named .git/CON/etc.): recorded
      // before any stat, so a Windows-reserved name (con.txt) is never opened
      // or probed.
      scan.excluded.set(relative, 'excluded-protected-component');
      addEntry();
      return;
    }
    const stat = await guarded(() => fs.lstat(absolute), absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      if (relative !== '.') {
        scan.unsupported.set(relative, stat.isSymbolicLink() ? 'symlink' : 'special-file');
        addEntry();
      }
      return;
    }
    if (stat.isDirectory()) {
      const name = path.basename(absolute);
      // Selection mode permits hidden directories such as .github; the
      // protected components and dependency/build directories stay excluded.
      const excludedName = selection === null
        ? isExcludedDirectory(name)
        : isProtectedComponent(name) || EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase());
      if (absolute !== root && (excludedName || (storeRel !== undefined && relative === storeRel))) {
        if (relative !== '.') {
          scan.excluded.set(relative, `excluded-directory:${name}`);
          addEntry();
        }
        return;
      }
      if (!scan.directories.has(relative)) {
        scan.directories.add(relative);
        addEntry();
      }
      // Validate the whole component chain (root dev/ino included) before the
      // listing, list, then validate again: a directory swapped to a
      // junction between checks is refused and retried, never listed or
      // descended, so no outside entry can ever be enumerated or captured.
      const beforeListSignature = await chainSignature(absolute, false);
      await hooks.beforeList?.(absolute);
      const afterHookSignature = await chainSignature(absolute, false);
      if (beforeListSignature !== afterHookSignature) {
        throw new CaptureChanged(`Directory ${absolute} changed before its listing`);
      }
      const children = await guarded(() => fs.readdir(absolute, { withFileTypes: true }), absolute);
      const afterListSignature = await chainSignature(absolute, false);
      if (beforeListSignature !== afterListSignature) {
        throw new CaptureChanged(`Directory ${absolute} changed during its listing`);
      }
      for (const child of children) {
        if (selection !== null) {
          // Only selected file keys and their parent prefixes are visited;
          // unselected children are never stat'ed or read, and a tracked
          // deletion is simply absent (its parent prefix is still listed).
          // Membership is case-folded on win32; real case is preserved.
          const childRel = relative === '.' ? child.name : `${relative}/${child.name}`;
          const childFolded = selectionKey(childRel);
          const supported = forcedUnsupported(childRel) !== undefined || childRel === '.';
          if (!supported && !selection.foldedFiles.has(childFolded) && !selection.foldedPrefixes.has(childFolded)) {
            continue;
          }
        }
        await visit(path.join(absolute, child.name));
      }
      // The children may have changed during traversal; the directory itself
      // must still be the same stable component.
      if (await chainSignature(absolute, false) !== beforeListSignature) {
        throw new CaptureChanged(`Directory ${absolute} changed during traversal`);
      }
      return;
    }
    // Regular file: validate the whole component chain before and after the
    // read, with stable dev/ino identity, so a swapped junction parent can
    // never feed outside content into the capture.
    await hooks.beforeRead?.(absolute);
    const beforeSignature = await chainSignature(absolute, false);
    const beforeStat = await guarded(() => fs.lstat(absolute), absolute);
    if (!beforeStat.isFile() || beforeStat.dev !== stat.dev || beforeStat.ino !== stat.ino) {
      throw new CaptureChanged(`File ${relative} changed before opening`);
    }
    if (beforeStat.size > limits.maxFileBytes) {
      throw new WorkerError('snapshot_capacity', `File ${relative} exceeds maxFileBytes ${limits.maxFileBytes}.`);
    }
    const sameFile = (current: LstatResult): boolean => current.isFile() && current.dev === beforeStat.dev && current.ino === beforeStat.ino
      && current.size === beforeStat.size && current.mtimeMs === beforeStat.mtimeMs && current.ctimeMs === beforeStat.ctimeMs;
    hooks.guard?.();
    // O_NOFOLLOW protects the leaf where supported; handle identity also
    // detects parent-junction redirection. O_NONBLOCK avoids waiting on a
    // FIFO substituted between lstat and open on platforms that support it.
    const flags = constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0) + (constants.O_NONBLOCK ?? 0);
    const handle = await guarded(() => fs.open(absolute, flags), absolute);
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!sameFile(opened) || await chainSignature(absolute, false) !== beforeSignature) {
        throw new CaptureChanged(`File ${relative} changed while opening`);
      }
      hooks.guard?.();
      // Read the verified handle, never resolve the mutable path again.
      bytes = await guarded(() => handle.readFile(), absolute);
      hooks.guard?.();
      if (!sameFile(await handle.stat())) {
        throw new CaptureChanged(`File ${relative} changed during its handle read`);
      }
    } finally {
      await handle.close();
    }
    addFileBytes(bytes, relative);
    const afterStat = await guarded(() => fs.lstat(absolute), absolute);
    const afterSignature = await chainSignature(absolute, false);
    if (
      beforeSignature !== afterSignature ||
      bytes.length !== beforeStat.size ||
      !sameFile(afterStat)
    ) {
      throw new CaptureChanged(`File ${relative} changed during its read`);
    }
    // Per-file identity/stat signature (root+component-chain dev/ino plus
    // size/mtime/ctime) folded into the fingerprint, so a same-byte rewrite
    // or touch between the two scans is retryable churn, not a false match.
    scan.signatures.set(relative, `${beforeSignature}|${beforeStat.size}:${beforeStat.mtimeMs}:${beforeStat.ctimeMs}`);
    scan.files.set(relative, bytes);
    addEntry();
  };

  await visit(root);

  scan.editorNamespace = { files: new Set(scan.files.keys()), directories: new Set(scan.directories) };
  const planned = await planEditorDocuments(root, store.directory, documents, selection, scan.editorNamespace, hooks.guard);
  // Editor documents override disk bytes once; they are part of this capture only.
  for (const [relative, document] of planned) {
    const segments = relative.split('/');
    const bytes = Buffer.from(document.text, 'utf8');
    if (bytes.length > limits.maxFileBytes) {
      throw new WorkerError('snapshot_capacity', `Editor document ${relative} exceeds maxFileBytes ${limits.maxFileBytes}.`);
    }
    const previous = scan.files.get(relative);
    if (previous === undefined) {
      addFileBytes(bytes, relative);
      addEntry();
    } else if (bytes.length !== previous.length) {
      // Override of already-captured disk bytes: adjust the running total.
      scan.totalBytes += bytes.length - previous.length;
      if (scan.totalBytes > limits.maxTotalBytes) {
        throw new WorkerError('snapshot_capacity', `Capture is ${scan.totalBytes} bytes total; maxTotalBytes is ${limits.maxTotalBytes}.`);
      }
    }
    // Add every relative parent directory as a directory entry: this covers
    // both missing (virtual) parents and on-disk parents that were not
    // otherwise captured (selection mode), so an included editor file never
    // leaves a dangling parent in the manifest.
    for (let i = 1; i < segments.length; i += 1) {
      const dirRel = segments.slice(0, i).join('/');
      if (dirRel !== '.' && !scan.directories.has(dirRel)) {
        scan.directories.add(dirRel);
        addEntry();
      }
    }
    scan.files.set(relative, bytes);
    scan.documents.set(relative, documentVersion(document));
  }
  return scan;
}

async function buildManifest(root: string, store: ContentStore, scan: ScanResult, fingerprint: string, guard: (() => void) | undefined, storeContent?: (key: string, bytes: Buffer, guard?: () => void) => Promise<string>): Promise<SnapshotManifest> {
  guard?.();
  const keys = new Set<string>([...scan.files.keys(), ...scan.directories, ...scan.unsupported.keys(), ...scan.excluded.keys()]);
  const byFolded = new Map<string, string[]>();
  for (const key of keys) {
    const folded = key.toLowerCase();
    const group = byFolded.get(folded);
    if (group) {
      group.push(key);
    } else {
      byFolded.set(folded, [key]);
    }
  }
  for (const group of byFolded.values()) {
    if (new Set(group).size > 1) {
      throw new WorkerError('snapshot_case_conflict', `Paths that collide in case: ${[...new Set(group)].sort().join(', ')}`);
    }
  }
  // Prototype-less dictionary: a literal "__proto__" filename is a normal key.
  const entries: Record<string, SnapshotEntry> = Object.create(null);
  for (const [key, detail] of scan.unsupported) {
    entries[key] = { type: 'unsupported', detail };
  }
  for (const [key, detail] of scan.excluded) {
    entries[key] = { type: 'excluded', detail };
  }
  for (const key of scan.directories) {
    if (key !== '.') {
      entries[key] = { type: 'directory' };
    }
  }
  for (const [key, bytes] of scan.files) {
    // The capture guard is checked before and after the storage await and
    // immediately before publication: revocation aborts, never a partial
    // success. A pluggable storeContent returns the hash of `bytes` verbatim;
    // the returned hash must be the EXACT SHA-256 or the capture fails
    // closed — no live fallback, no re-derivation.
    guard?.();
    const expectedHash = sha256(bytes);
    let hash: string;
    if (storeContent) {
      hash = await storeContent(key, bytes, guard);
    } else {
      hash = await store.put(bytes, guard);
    }
    guard?.();
    if (hash !== expectedHash) {
      throw new WorkerError('snapshot_content_missing', `storeContent returned hash ${JSON.stringify(hash)} which is not the exact SHA-256 of the captured bytes for ${key}; refusing to publish a capture over unverifiable content.`);
    }
    entries[key] = { type: 'file', hash, size: bytes.length };
  }
  const manifest: SnapshotManifest = {
    schema: 1,
    root,
    capturedAt: new Date().toISOString(),
    fingerprint,
    fileCount: scan.files.size,
    totalBytes: scan.totalBytes,
    entries
  };
  for (const entry of Object.values(manifest.entries)) {
    Object.freeze(entry);
  }
  Object.freeze(manifest.entries);
  Object.freeze(manifest);
  guard?.();
  return manifest;
}

/**
 * Capture an immutable non-Git snapshot of `root` into `store`.
 * Fails with `inconsistent_capture` when two matching complete scans cannot be
 * obtained within maxAttempts; capacity, case-conflict and guard errors are
 * not retried. The options guard is enforced until the manifest is returned,
 * including across every blob publication in buildManifest.
 */
export async function captureContent(root: string, store: ContentStore, options: CaptureOptions = {}): Promise<SnapshotManifest> {
  const limits: CaptureLimits = { ...DEFAULT_CAPTURE_LIMITS, ...options.limits };
  validateLimits(limits);
  const maxAttempts = options.maxAttempts ?? limits.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_CAPTURE_ATTEMPTS) {
    throw new WorkerError('invalid_capture_limits', `maxAttempts must be an integer between 1 and ${MAX_CAPTURE_ATTEMPTS}, got ${String(maxAttempts)}.`);
  }
  const guard = options.guard;
  const resolved = path.resolve(root);
  const rootStat = await fs.lstat(resolved);
  if (!rootStat.isDirectory()) {
    throw new WorkerError('invalid_capture_root', `Capture root is not a directory: ${root}`);
  }
  guard?.();
  const realRoot = await fs.realpath(resolved);
  guard?.();
  const hooks: ScanHooks = { beforeVisit: options.beforeVisit, beforeRead: options.beforeRead, beforeList: options.beforeList, guard };
  const enumerate = (): OpenDocument[] => {
    const raw = options.openDocuments ? options.openDocuments() : [];
    // Clone synchronously before any path checks or namespace planning await.
    return raw.map(document => ({ path: document.path, text: document.text, version: document.version === undefined ? undefined : String(document.version) }));
  };
  let lastChange = 'the workspace changed during capture';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      guard?.();
      // Selection boundary 1/4: the raw query is cloned and validated
      // immediately after the await (the provider may return a mutable object
      // reused across query points), then re-queried before and after each
      // full scan; any change is retryable.
      let selectionContext: SelectionContext | null = null;
      let selectionFirst: CaptureSelection | null = null;
      if (options.selection) {
        selectionFirst = cloneSelectionQuery(await options.selection(), guard);
        selectionContext = normalizeSelection(selectionFirst, limits.maxEntries);
      }
      const before = enumerate();
      const scan = await scanWorkspace(realRoot, store, limits, before, hooks, selectionContext);
      guard?.();
      if (selectionFirst !== null && options.selection) {
        // Selection boundary 2/4.
        if (!selectionAgrees(selectionFirst, cloneSelectionQuery(await options.selection(), guard))) {
          throw new CaptureChanged('selection changed after the first scan');
        }
      }
      const after = await planEditorDocuments(realRoot, store.directory, enumerate(), selectionContext, scan.editorNamespace, guard);
      if (documentsSignature(scan.documents) !== plannedSignature(after)) {
        throw new CaptureChanged('editor documents changed during the first scan');
      }
      const fingerprint = fingerprintOf(scan);
      await options.afterScan?.(attempt);
      guard?.();
      // A fresh enumeration, not the stale pre-scan records: editor changes
      // in afterScan or during verification must be detected too.
      if (selectionFirst !== null && options.selection) {
        // Selection boundary 3/4.
        if (!selectionAgrees(selectionFirst, cloneSelectionQuery(await options.selection(), guard))) {
          throw new CaptureChanged('selection changed before verification');
        }
      }
      const beforeVerify = enumerate();
      const plannedBeforeVerify = await planEditorDocuments(realRoot, store.directory, beforeVerify, selectionContext, scan.editorNamespace, guard);
      if (plannedSignature(plannedBeforeVerify) !== plannedSignature(after)) {
        throw new CaptureChanged('editor documents changed before verification');
      }
      const verify = await scanWorkspace(realRoot, store, limits, beforeVerify, hooks, selectionContext);
      guard?.();
      if (selectionFirst !== null && options.selection) {
        // Selection boundary 4/4.
        if (!selectionAgrees(selectionFirst, cloneSelectionQuery(await options.selection(), guard))) {
          throw new CaptureChanged('selection changed after verification');
        }
      }
      const afterVerify = await planEditorDocuments(realRoot, store.directory, enumerate(), selectionContext, verify.editorNamespace, guard);
      if (plannedSignature(afterVerify) !== documentsSignature(verify.documents)) {
        throw new CaptureChanged('editor documents changed during verification');
      }
      if (fingerprintOf(verify) !== fingerprint) {
        throw new CaptureChanged('workspace changed between the two scans');
      }
      return await buildManifest(realRoot, store, scan, fingerprint, guard, options.storeContent);
    } catch (error) {
      if (error instanceof CaptureChanged) {
        lastChange = error.message;
        continue;
      }
      throw error;
    }
  }
  throw new WorkerError('inconsistent_capture', `Capture abandoned after ${maxAttempts} attempts: ${lastChange}.`, true);
}
