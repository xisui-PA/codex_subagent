import { LayeredTree, type Delta } from './layered-tree';
import { fileModeOf, type FileMode, type SnapshotEntry } from './snapshot-content';
import { WorkerError } from './types';

// ---------------------------------------------------------------------------
// IntegrationMerge: a pure, deterministic merge of independent integration
// trees over one shared base snapshot.
//
// Every input is the FULL LayeredTree namespace of one producer (its
// `entries`, i.e. the base plus that producer's changes); `base` is the actual
// common ancestor. The merge answers one question: which Delta applied on top
// of `base` contains every producer change that can be applied without
// ambiguity?
//
// Rules:
//  - Inputs are merged in the caller's given order; every emitted key and
//    every conflict is sorted by path, so the result is deterministic.
//  - Distinct paths combine. Identical edits from several inputs combine into
//    one change. A path only one input changed keeps that change even when
//    the other inputs left it untouched.
//  - Text files (valid UTF-8, no NUL) whose content changed in several inputs
//    are merged line-by-line against the shared base with a bounded, pure LCS
//    diff. Non-overlapping hunks combine; overlapping or ambiguous hunks
//    conflict. Untouched lines are copied verbatim from the base and every
//    side must round-trip through UTF-8 unchanged, so raw bytes are never
//    transcoded or re-normalized.
//  - Binary content, executable-bit disagreement, delete/modify, add/add,
//    file/directory, case collisions, unsupported/excluded entries and
//    divergent exact-content renames are conservative conflicts.
//  - Renames are modelled as delete+add. Exact-content matching detects when a
//    producer moved a base file, including an overwrite-rename that writes
//    exactly the deleted file's bytes over an existing base regular file: such
//    a destination only counts once its own content changed, so untouched,
//    duplicate-hash and mode-only paths are never inferred as moves. A
//    destination that itself conflicts (add/add, case collision,
//    file/directory collision, missing parent) keeps the source file and
//    reports both paths. A rejected destination that replaced a base directory
//    also rolls back the deletes that only cleared that directory, and a
//    refused move never leaves its own bytes at the destination: an existing
//    base destination is recomputed from the remaining independent inputs
//    alone, so a failed rename never deletes data, never overwrites the old
//    destination and unrelated changes survive.
//  - Content read failures are never masked as merge seeds: a missing,
//    corrupt or unauthorized blob propagates the reader's original exception,
//    and a reader that resolves without a Buffer fails with
//    `merge_read_invalid`.
//  - A conflicting path is NOT part of `changes`; the base entry is preserved
//    there, so applying `changes` is always safe. Disjoint, unambiguous edits
//    stay in `changes` even when another path conflicts (the deterministic
//    provisional merged tree). No conflict markers are written and no producer
//    view is modified: this module only returns a Delta.
// ---------------------------------------------------------------------------

/** Read the raw bytes of one canonical root-relative path. */
export type IntegrationRead = (path: string) => Promise<{ bytes: Buffer }>;

/** One integration participant: identity, full tree and content reader. */
export interface IntegrationMergeInput {
  /** Stable caller-supplied identity; input order is the merge order. */
  id: string;
  /** Full LayeredTree namespace (base plus this input's changes). */
  entries: Readonly<Record<string, SnapshotEntry>>;
  /** Raw bytes for a file key of `entries`. */
  read(path: string): Promise<{ bytes: Buffer }>;
}

/** One path-level conflict; the base entry is preserved at every path. */
export interface IntegrationConflict {
  /** Every path implicated by the conflict, sorted. */
  paths: string[];
  /** Inputs whose changes collide, in caller order. */
  inputIds: string[];
  /** Stable machine-readable reason (for example `delete/modify`). */
  reason: string;
}

export interface IntegrationMergeResult {
  /** Delta on top of base; conflicting paths are absent, so base is kept. */
  changes: Delta;
  conflicts: IntegrationConflict[];
}

/** Maximum distinct paths considered by one merge (mirrors LayeredTree). */
const MAX_PATHS = 20_000;
/** Maximum bytes of one textual side before the merge refuses to diff it. */
const MAX_TEXT_BYTES = 1024 * 1024;
/** Maximum lines of one textual side. */
const MAX_TEXT_LINES = 20_000;
/** Maximum LCS table cells for the bounded quadratic diff. */
const MAX_LCS_CELLS = 1_000_000;
/** Maximum cleanup rounds after structural collisions are found. */
const MAX_CLEANUP_ROUNDS = 8;

type FileEntry = Extract<SnapshotEntry, { type: 'file' }>;
type Change = { readonly kind: 'delete' } | { readonly kind: 'entry'; readonly entry: SnapshotEntry };
type FileChange = { readonly kind: 'entry'; readonly entry: FileEntry };

const DELETE: Change = { kind: 'delete' };

interface Contribution {
  readonly id: string;
  readonly change: Change;
  readonly read: IntegrationRead;
}

interface DecisionConflict {
  readonly kind: 'conflict';
  readonly inputIds: string[];
  readonly reason: string;
}

type Decision = { readonly kind: 'change'; readonly change: Change } | DecisionConflict;

interface MergeContext {
  readonly readBase: IntegrationRead;
  readonly put: (bytes: Buffer) => Promise<string>;
}

/** Simple code-unit ordering, identical on every platform. */
const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isFileEntry = (entry: SnapshotEntry): entry is FileEntry => entry.type === 'file';

function own(
  entries: Readonly<Record<string, SnapshotEntry>>,
  key: string
): SnapshotEntry | undefined {
  return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
}

/** Entry identity: kind plus content hash, size and effective executable bit. */
function sameEntry(a: SnapshotEntry, b: SnapshotEntry): boolean {
  switch (a.type) {
    case 'file':
      return b.type === 'file'
        && a.hash === b.hash
        && a.size === b.size
        && fileModeOf(a) === fileModeOf(b);
    case 'directory':
      return b.type === 'directory';
    case 'unsupported':
    case 'excluded':
      return b.type === a.type && a.detail === b.detail;
  }
}

const sameChange = (a: Change, b: Change): boolean => a.kind === 'delete' || b.kind === 'delete'
  ? a.kind === b.kind
  : sameEntry(a.entry, b.entry);

/** Group identical edits so several inputs making the same edit combine. */
function groupChanges(contributions: readonly Contribution[]): { change: Change; ids: string[] }[] {
  const groups: { change: Change; ids: string[] }[] = [];
  for (const contribution of contributions) {
    const existing = groups.find(group => sameChange(group.change, contribution.change));
    if (existing === undefined) {
      groups.push({ change: contribution.change, ids: [contribution.id] });
    } else {
      existing.ids.push(contribution.id);
    }
  }
  return groups;
}

interface ModeMerge {
  readonly mode: FileMode;
  /** Keep the persisted `mode` field when any side carried one. */
  readonly explicit: boolean;
}

/**
 * Merge executable-bit metadata. A mode only conflicts when two inputs changed
 * it to different values (or added one file with two different modes); inputs
 * that did not touch the mode never fight the input that did.
 */
function mergeModes(base: SnapshotEntry | undefined, files: readonly FileEntry[]): ModeMerge | undefined {
  const baseMode = base !== undefined && isFileEntry(base) ? fileModeOf(base) : undefined;
  const differing = new Set<FileMode>();
  for (const entry of files) {
    const mode = fileModeOf(entry);
    if (baseMode === undefined || mode !== baseMode) {
      differing.add(mode);
    }
  }
  if (differing.size > 1) {
    return undefined;
  }
  const mode = differing.size === 1 ? [...differing][0] : baseMode;
  if (mode === undefined) {
    return undefined;
  }
  const explicit = files.some(entry => entry.mode !== undefined)
    || (base !== undefined && isFileEntry(base) && base.mode !== undefined);
  return { mode, explicit };
}

function fileChange(hash: string, size: number, mode: ModeMerge): FileChange {
  const entry: FileEntry = mode.explicit
    ? { type: 'file', hash, size, mode: mode.mode }
    : { type: 'file', hash, size };
  return { kind: 'entry', entry: Object.freeze(entry) };
}

// -- bounded line diff -------------------------------------------------------

interface Hunk {
  /** First base line replaced (also the insertion point for pure inserts). */
  readonly start: number;
  /** One past the last base line replaced. */
  readonly end: number;
  /** Replacement lines, terminators included. */
  readonly lines: readonly string[];
}

/** Split text into lines that keep their own `\n` terminator (CR stays). */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/**
 * Bounded LCS diff. Returns hunks mapping base lines to variant lines, or
 * undefined when the table would exceed MAX_LCS_CELLS (the merge then refuses
 * to guess and reports a conflict). Ties prefer deletions, so the walk is
 * deterministic.
 */
function diffHunks(base: readonly string[], variant: readonly string[]): Hunk[] | undefined {
  const rows = base.length;
  const columns = variant.length;
  if (rows * columns > MAX_LCS_CELLS) {
    return undefined;
  }
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] = base[row] === variant[column]
        ? table[(row + 1) * width + column + 1] + 1
        : Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let start = -1;
  let end = -1;
  let lines: string[] = [];
  const flush = (): void => {
    if (start !== -1) {
      hunks.push({ start, end, lines });
      start = -1;
      end = -1;
      lines = [];
    }
  };
  let row = 0;
  let column = 0;
  while (row < rows || column < columns) {
    if (row < rows && column < columns && base[row] === variant[column]) {
      flush();
      row += 1;
      column += 1;
      continue;
    }
    if (start === -1) {
      start = row;
    }
    if (column < columns && (row >= rows || table[row * width + column + 1] > table[(row + 1) * width + column])) {
      lines.push(variant[column]);
      column += 1;
      end = row;
    } else {
      row += 1;
      end = row;
    }
  }
  flush();
  return hunks;
}

const sameHunk = (a: Hunk, b: Hunk): boolean => a.start === b.start && a.end === b.end
  && a.lines.length === b.lines.length
  && a.lines.every((line, index) => line === b.lines[index]);

/**
 * Two hunks conflict unless they touch disjoint base lines. Insertion points
 * strictly inside the other hunk are ambiguous; insertions on a boundary are
 * ordered (insertion first when it shares the start, last when it shares the
 * end) and therefore safe.
 */
function overlaps(a: Hunk, b: Hunk): boolean {
  const aInsert = a.start === a.end;
  const bInsert = b.start === b.end;
  if (aInsert && bInsert) {
    return a.start === b.start;
  }
  if (aInsert) {
    return b.start <= a.start && a.start < b.end;
  }
  if (bInsert) {
    return a.start <= b.start && b.start < a.end;
  }
  return a.start < b.end && b.start < a.end;
}

function applyHunks(base: readonly string[], hunks: readonly Hunk[]): string[] {
  const order = (hunk: Hunk): number => (hunk.start === hunk.end ? 0 : 1);
  const sorted = [...hunks].sort((a, b) => a.start - b.start || order(a) - order(b));
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of sorted) {
    for (let index = cursor; index < hunk.start; index += 1) {
      out.push(base[index]);
    }
    for (const line of hunk.lines) {
      out.push(line);
    }
    cursor = hunk.end;
  }
  for (let index = cursor; index < base.length; index += 1) {
    out.push(base[index]);
  }
  return out;
}

/**
 * Exact UTF-8 text or undefined. Round-tripping proves the bytes are valid,
 * unchanged UTF-8; a NUL byte marks binary content.
 */
function utf8Text(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
}

/**
 * Read one side's bytes. Read failures (missing blob, corrupt content,
 * authorization) are NEVER converted into a merge seed: the original exception
 * propagates so the caller sees the real cause. A reader that resolves without
 * a Buffer is a programming error and fails closed instead of being treated as
 * absent content.
 */
async function readBytes(reader: IntegrationRead, key: string): Promise<Buffer> {
  const result = await reader(key);
  const bytes: unknown = result?.bytes;
  if (!Buffer.isBuffer(bytes)) {
    throw new WorkerError('merge_read_invalid', `content reader returned no bytes for ${key}`);
  }
  return bytes;
}

type TextMerge =
  | { readonly kind: 'bytes'; readonly bytes: Buffer }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'conflict'; readonly reason: string; readonly inputIds: string[] };

/**
 * Line-level N-way merge of file content against the shared base. Every side
 * must be valid UTF-8 text within the byte/line bounds; all non-identical hunks
 * must be disjoint. Returns the merged bytes, `unchanged` when the result is
 * the base content, or a conservative conflict. Read failures are not merged
 * around: they propagate to the caller (see readBytes).
 */
async function mergeText(
  key: string,
  modifiers: readonly { id: string; entry: FileEntry; read: IntegrationRead }[],
  context: MergeContext
): Promise<TextMerge> {
  const ids = modifiers.map(modifier => modifier.id);
  const baseBytes = await readBytes(context.readBase, key);
  if (baseBytes.length > MAX_TEXT_BYTES) {
    return { kind: 'conflict', reason: 'text merge too large', inputIds: ids };
  }
  const baseText = utf8Text(baseBytes);
  if (baseText === undefined) {
    return { kind: 'conflict', reason: 'binary content', inputIds: ids };
  }
  const baseLines = splitLines(baseText);
  if (baseLines.length > MAX_TEXT_LINES) {
    return { kind: 'conflict', reason: 'text merge too large', inputIds: ids };
  }
  const hunks: { hunk: Hunk; id: string }[] = [];
  for (const modifier of modifiers) {
    const bytes = await readBytes(modifier.read, key);
    if (bytes.length > MAX_TEXT_BYTES) {
      return { kind: 'conflict', reason: 'text merge too large', inputIds: ids };
    }
    const text = utf8Text(bytes);
    if (text === undefined) {
      return { kind: 'conflict', reason: 'binary content', inputIds: [modifier.id] };
    }
    if (bytes.equals(baseBytes)) {
      continue;
    }
    const lines = splitLines(text);
    if (lines.length > MAX_TEXT_LINES) {
      return { kind: 'conflict', reason: 'text merge too large', inputIds: ids };
    }
    const diff = diffHunks(baseLines, lines);
    if (diff === undefined) {
      return { kind: 'conflict', reason: 'text merge too large', inputIds: ids };
    }
    for (const hunk of diff) {
      hunks.push({ hunk, id: modifier.id });
    }
  }
  // Identical hunks from different inputs are the same edit; keep one.
  const unique: { hunk: Hunk; id: string }[] = [];
  for (const candidate of hunks) {
    if (!unique.some(entry => sameHunk(entry.hunk, candidate.hunk))) {
      unique.push(candidate);
    }
  }
  for (let left = 0; left < unique.length; left += 1) {
    for (let right = left + 1; right < unique.length; right += 1) {
      if (unique[left].id !== unique[right].id && overlaps(unique[left].hunk, unique[right].hunk)) {
        return { kind: 'conflict', reason: 'textual overlap', inputIds: [unique[left].id, unique[right].id] };
      }
    }
  }
  const merged = Buffer.from(applyHunks(baseLines, unique.map(entry => entry.hunk)).join(''), 'utf8');
  return merged.equals(baseBytes) ? { kind: 'unchanged' } : { kind: 'bytes', bytes: merged };
}

// -- per-path merge ----------------------------------------------------------

async function mergeFilePath(
  key: string,
  baseEntry: SnapshotEntry | undefined,
  files: readonly { id: string; entry: FileEntry; read: IntegrationRead }[],
  context: MergeContext
): Promise<Decision> {
  const ids = files.map(file => file.id);
  const mode = mergeModes(baseEntry, files.map(file => file.entry));
  if (mode === undefined) {
    return { kind: 'conflict', inputIds: ids, reason: 'mode conflict' };
  }
  if (baseEntry === undefined) {
    const hashes = new Set(files.map(file => file.entry.hash));
    const sizes = new Set(files.map(file => file.entry.size));
    if (hashes.size > 1 || sizes.size > 1) {
      return { kind: 'conflict', inputIds: ids, reason: 'add/add' };
    }
    const first = files[0].entry;
    return { kind: 'change', change: fileChange(first.hash, first.size, mode) };
  }
  if (!isFileEntry(baseEntry)) {
    return { kind: 'conflict', inputIds: ids, reason: 'file/directory collision' };
  }
  const contentChanged = files.filter(file => file.entry.hash !== baseEntry.hash);
  if (contentChanged.length === 0) {
    return { kind: 'change', change: fileChange(baseEntry.hash, baseEntry.size, mode) };
  }
  const hashes = new Set(contentChanged.map(file => file.entry.hash));
  if (hashes.size === 1) {
    const first = contentChanged[0].entry;
    return { kind: 'change', change: fileChange(first.hash, first.size, mode) };
  }
  const merged = await mergeText(key, contentChanged, context);
  switch (merged.kind) {
    case 'conflict':
      return { kind: 'conflict', inputIds: merged.inputIds, reason: merged.reason };
    case 'unchanged':
      return { kind: 'change', change: fileChange(baseEntry.hash, baseEntry.size, mode) };
    case 'bytes': {
      const hash = await context.put(merged.bytes);
      return { kind: 'change', change: fileChange(hash, merged.bytes.length, mode) };
    }
  }
}

/** Merge the contributions for one path; base entry retained on conflict. */
async function mergePath(
  key: string,
  baseEntry: SnapshotEntry | undefined,
  contributions: readonly Contribution[],
  context: MergeContext
): Promise<Decision> {
  const ids = contributions.map(contribution => contribution.id);
  const baseSpecial = baseEntry !== undefined
    && (baseEntry.type === 'unsupported' || baseEntry.type === 'excluded');
  const touchesSpecial = contributions.some(contribution => contribution.change.kind === 'entry'
    && (contribution.change.entry.type === 'unsupported' || contribution.change.entry.type === 'excluded'));
  if (baseSpecial || touchesSpecial) {
    const allDeletes = contributions.every(contribution => contribution.change.kind === 'delete');
    if (!allDeletes) {
      return { kind: 'conflict', inputIds: ids, reason: 'unsupported entry' };
    }
  }
  const groups = groupChanges(contributions);
  if (groups.length === 1) {
    return { kind: 'change', change: groups[0].change };
  }
  const hasDelete = groups.some(group => group.change.kind === 'delete');
  if (hasDelete) {
    return { kind: 'conflict', inputIds: ids, reason: 'delete/modify' };
  }
  const entries: SnapshotEntry[] = [];
  for (const group of groups) {
    if (group.change.kind !== 'entry') {
      return { kind: 'conflict', inputIds: ids, reason: 'delete/modify' };
    }
    entries.push(group.change.entry);
  }
  const types = new Set(entries.map(entry => entry.type));
  if (types.size > 1) {
    return {
      kind: 'conflict',
      inputIds: ids,
      reason: types.has('directory') ? 'file/directory collision' : 'unsupported entry'
    };
  }
  if (entries[0].type !== 'file') {
    return { kind: 'conflict', inputIds: ids, reason: 'unsupported entry' };
  }
  if (baseEntry !== undefined && baseEntry.type !== 'file') {
    return {
      kind: 'conflict',
      inputIds: ids,
      reason: baseEntry.type === 'directory' ? 'file/directory collision' : 'unsupported entry'
    };
  }
  const files = contributions.map(contribution => {
    const entry = contribution.change.kind === 'entry' ? contribution.change.entry : undefined;
    return { id: contribution.id, entry, read: contribution.read };
  });
  if (files.some(file => file.entry === undefined || !isFileEntry(file.entry))) {
    return { kind: 'conflict', inputIds: ids, reason: 'unsupported entry' };
  }
  const resolved = files.map(file => ({ id: file.id, entry: file.entry as FileEntry, read: file.read }));
  return mergeFilePath(key, baseEntry, resolved, context);
}

// -- renames ----------------------------------------------------------------

interface RenameRecord {
  readonly id: string;
  readonly destinations: readonly string[];
}

/**
 * Detect exact-content renames per input (a deleted base file whose bytes are
 * written at another path). Content-hash matching is conservative: an edited
 * "rename" stays a plain delete plus add, which merges independently.
 *
 * A destination is a candidate when the path did not exist, when it replaced a
 * non-file entry with a file, or when it is a base regular file this input
 * rewrote with exactly the deleted file's bytes (the overwrite-rename). The
 * last case additionally requires a changed content hash, so an untouched
 * duplicate of the moved bytes and a mode-only edit are never inferred as a
 * move.
 */
function collectRenames(
  baseEntries: Readonly<Record<string, SnapshotEntry>>,
  trees: readonly { input: IntegrationMergeInput; entries: Readonly<Record<string, SnapshotEntry>> }[]
): Map<string, RenameRecord[]> {
  const renames = new Map<string, RenameRecord[]>();
  for (const tree of trees) {
    const addedByHash = new Map<string, string[]>();
    for (const key of Object.getOwnPropertyNames(tree.entries)) {
      const entry = tree.entries[key];
      if (!isFileEntry(entry)) {
        continue;
      }
      const baseEntry = own(baseEntries, key);
      // Kept base content (including a mode-only edit) is not a move
      // destination, however many deleted base files share that hash.
      if (baseEntry !== undefined && isFileEntry(baseEntry) && baseEntry.hash === entry.hash) {
        continue;
      }
      const bucket = addedByHash.get(entry.hash);
      if (bucket === undefined) {
        addedByHash.set(entry.hash, [key]);
      } else {
        bucket.push(key);
      }
    }
    for (const key of Object.getOwnPropertyNames(baseEntries)) {
      const baseEntry = baseEntries[key];
      if (!isFileEntry(baseEntry) || own(tree.entries, key) !== undefined) {
        continue;
      }
      const destinations = addedByHash.get(baseEntry.hash);
      if (destinations === undefined || destinations.length === 0) {
        continue;
      }
      const records = renames.get(key) ?? [];
      records.push({ id: tree.input.id, destinations: [...destinations].sort(comparePaths) });
      renames.set(key, records);
    }
  }
  return renames;
}

// -- structural coherence ----------------------------------------------------

interface StructuralProblem {
  readonly paths: string[];
  readonly culprits: string[];
  readonly reason: string;
}

/**
 * Final namespace checks that a per-path merge cannot see: case-insensitive
 * path collisions (the merged namespace must stay portable), entries whose
 * parent is missing or not a directory, and directory tombstones that still
 * have surviving descendants (those silently keep the directory).
 */
function structuralProblems(
  baseEntries: Readonly<Record<string, SnapshotEntry>>,
  changes: Map<string, Change>
): StructuralProblem[] {
  const final = new Map<string, SnapshotEntry>();
  for (const key of Object.getOwnPropertyNames(baseEntries)) {
    final.set(key, baseEntries[key]);
  }
  for (const [key, change] of changes) {
    if (change.kind === 'delete') {
      final.delete(key);
    } else {
      final.set(key, change.entry);
    }
  }
  for (const [key, change] of [...changes]) {
    if (change.kind !== 'delete') {
      continue;
    }
    const baseEntry = own(baseEntries, key);
    if (baseEntry?.type !== 'directory') {
      continue;
    }
    const prefix = `${key}/`;
    if ([...final.keys()].some(candidate => candidate.startsWith(prefix))) {
      changes.delete(key);
      final.set(key, baseEntry);
    }
  }
  const problems: StructuralProblem[] = [];
  const lower = new Map<string, string[]>();
  for (const key of final.keys()) {
    const bucket = lower.get(key.toLowerCase());
    if (bucket === undefined) {
      lower.set(key.toLowerCase(), [key]);
    } else {
      bucket.push(key);
    }
  }
  for (const group of lower.values()) {
    if (group.length < 2) {
      continue;
    }
    const culprits = group.filter(key => changes.has(key));
    if (culprits.length > 0) {
      problems.push({ paths: [...group].sort(comparePaths), culprits, reason: 'case collision' });
    }
  }
  for (const [key, change] of changes) {
    if (change.kind !== 'entry') {
      continue;
    }
    let parent = key;
    for (;;) {
      const index = parent.lastIndexOf('/');
      if (index === -1) {
        break;
      }
      parent = parent.slice(0, index);
      const entry = final.get(parent);
      if (entry === undefined) {
        problems.push({
          paths: [parent, key].sort(comparePaths),
          culprits: [key],
          reason: 'missing parent directory'
        });
        break;
      }
      if (entry.type !== 'directory') {
        const culprits = changes.get(parent)?.kind === 'entry' ? [parent, key] : [key];
        problems.push({
          paths: [parent, key].sort(comparePaths),
          culprits,
          reason: 'file/directory collision'
        });
        break;
      }
    }
  }
  return problems;
}

/**
 * Once a rename destination is dropped, remove any parent directory this merge
 * itself added solely for that destination, so a conflicted rename does not
 * leave empty directories behind. Directories in the base, or with any
 * surviving descendant, are kept.
 */
function pruneOrphanParents(
  baseEntries: Readonly<Record<string, SnapshotEntry>>,
  pending: Map<string, Change>,
  dropped: readonly string[]
): void {
  const final = new Set<string>(Object.getOwnPropertyNames(baseEntries));
  for (const [key, change] of pending) {
    if (change.kind === 'delete') {
      final.delete(key);
    } else {
      final.add(key);
    }
  }
  for (const path of dropped) {
    let parent = path;
    for (;;) {
      const index = parent.lastIndexOf('/');
      if (index === -1) {
        break;
      }
      parent = parent.slice(0, index);
      if (own(baseEntries, parent) !== undefined) {
        break;
      }
      const change = pending.get(parent);
      if (change === undefined || change.kind !== 'entry' || change.entry.type !== 'directory') {
        break;
      }
      const prefix = `${parent}/`;
      if ([...final].some(candidate => candidate !== parent && candidate.startsWith(prefix))) {
        break;
      }
      pending.delete(parent);
      final.delete(parent);
    }
  }
}

interface RenameTarget {
  readonly sources: string[];
  readonly inputIds: string[];
}

/** Index every detected rename by destination, to trace rejected destinations. */
function indexRenameTargets(renames: ReadonlyMap<string, readonly RenameRecord[]>): Map<string, RenameTarget> {
  const targets = new Map<string, RenameTarget>();
  for (const [source, records] of renames) {
    for (const record of records) {
      for (const destination of record.destinations) {
        const target = targets.get(destination) ?? { sources: [], inputIds: [] };
        if (!target.sources.includes(source)) {
          target.sources.push(source);
        }
        if (!target.inputIds.includes(record.id)) {
          target.inputIds.push(record.id);
        }
        targets.set(destination, target);
      }
    }
  }
  return targets;
}

/**
 * A rename is only clean when BOTH halves apply. When a detected rename's
 * destination did not survive the merge (add/add, case collision,
 * file/directory collision, missing parent or any other rejection), keep the
 * source file by dropping its tombstone and make the destination's conflict
 * name the source too, so callers see both related paths and why the delete
 * disappeared. A rejected destination that replaced a base directory also
 * strands the deletes that only cleared that directory: those are rolled back
 * and reported as well, unless another input independently wanted them.
 * Independent paths are never touched.
 */
function preserveRenameSources(
  baseEntries: Readonly<Record<string, SnapshotEntry>>,
  targets: ReadonlyMap<string, RenameTarget>,
  pending: Map<string, Change>,
  keyIds: ReadonlyMap<string, readonly string[]>,
  conflicts: IntegrationConflict[]
): boolean {
  let dropped = false;
  for (const destination of [...targets.keys()].sort(comparePaths)) {
    if (pending.has(destination)) {
      continue;
    }
    const target = targets.get(destination);
    if (target === undefined) {
      continue;
    }
    const related = [destination, ...target.sources];
    for (const source of target.sources) {
      if (pending.get(source)?.kind === 'delete') {
        pending.delete(source);
        dropped = true;
      }
    }
    // A refused file/directory replacement: the rename inputs deleted the base
    // directory's children only to make room for the refused file. Restore
    // those tombstones so the directory survives intact; a delete another
    // input also contributed is a genuine change and is kept.
    if (own(baseEntries, destination)?.type === 'directory') {
      const prefix = `${destination}/`;
      for (const key of [...pending.keys()].sort(comparePaths)) {
        if (!key.startsWith(prefix) || pending.get(key)?.kind !== 'delete') {
          continue;
        }
        const contributors = keyIds.get(key) ?? [];
        if (contributors.length === 0 || !contributors.every(id => target.inputIds.includes(id))) {
          continue;
        }
        pending.delete(key);
        related.push(key);
        dropped = true;
      }
    }
    const owners = conflicts.filter(conflict => conflict.paths.includes(destination));
    if (owners.length === 0) {
      conflicts.push({
        paths: [...new Set(related)].sort(comparePaths),
        inputIds: [...target.inputIds],
        reason: 'rename destination conflict'
      });
      continue;
    }
    for (const conflict of owners) {
      conflict.paths = [...new Set([...conflict.paths, ...related])].sort(comparePaths);
      for (const id of target.inputIds) {
        if (!conflict.inputIds.includes(id)) {
          conflict.inputIds.push(id);
        }
      }
    }
  }
  return dropped;
}

/**
 * Merge independent integration trees over one shared base.
 *
 * @param root absolute workspace root used to validate every namespace.
 * @param base the shared base snapshot entries.
 * @param readBase reader for base file bytes (the textual merge ancestor).
 * @param inputs participants in caller-defined deterministic order.
 * @param put content-addressed writer for merged bytes.
 */
export async function mergeIntegrationTrees(
  root: string,
  base: Readonly<Record<string, SnapshotEntry>>,
  readBase: IntegrationRead,
  inputs: readonly IntegrationMergeInput[],
  put: (bytes: Buffer) => Promise<string>
): Promise<IntegrationMergeResult> {
  const baseEntries = new LayeredTree(root, base).entries;
  const seen = new Set<string>();
  const trees: { input: IntegrationMergeInput; entries: Readonly<Record<string, SnapshotEntry>> }[] = [];
  for (const input of inputs) {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new WorkerError('invalid_input', 'integration input id must be a non-empty string');
    }
    if (seen.has(input.id)) {
      throw new WorkerError('invalid_input', `duplicate integration input id: ${input.id}`);
    }
    seen.add(input.id);
    let entries: Readonly<Record<string, SnapshotEntry>>;
    try {
      entries = new LayeredTree(root, input.entries).entries;
    } catch (error) {
      if (error instanceof WorkerError) {
        throw new WorkerError(error.code, `input ${input.id}: ${error.message}`);
      }
      throw error;
    }
    trees.push({ input, entries });
  }
  const context: MergeContext = { readBase, put };

  const keySet = new Set<string>(Object.getOwnPropertyNames(baseEntries));
  for (const tree of trees) {
    for (const key of Object.getOwnPropertyNames(tree.entries)) {
      keySet.add(key);
    }
  }
  if (keySet.size > MAX_PATHS) {
    throw new WorkerError('merge_capacity', `merge exceeds ${MAX_PATHS} distinct paths`);
  }
  const ordered = [...keySet].sort(comparePaths);
  const renames = collectRenames(baseEntries, trees);
  const renameTargets = indexRenameTargets(renames);

  const pending = new Map<string, Change>();
  const keyIds = new Map<string, string[]>();
  const droppedSources = new Set<string>();
  // Destination -> the input ids whose move to that destination was refused. A
  // refused move must not keep any of its own bytes at the destination, so its
  // contributions are recomputed away from the remaining independent ones.
  const droppedDestinations = new Map<string, Set<string>>();
  const dropDestination = (destination: string, inputIds: readonly string[]): void => {
    const bucket = droppedDestinations.get(destination) ?? new Set<string>();
    for (const id of inputIds) {
      bucket.add(id);
    }
    droppedDestinations.set(destination, bucket);
  };
  const conflicts: IntegrationConflict[] = [];
  const conflictKeys = new Set<string>();
  const addConflict = (paths: readonly string[], inputIds: readonly string[], reason: string): void => {
    const uniquePaths = [...new Set(paths)].sort(comparePaths);
    const uniqueIds = [...new Set(inputIds)];
    const identity = `${reason}\u0000${uniquePaths.join('\u0000')}`;
    if (conflictKeys.has(identity)) {
      return;
    }
    conflictKeys.add(identity);
    conflicts.push({ paths: uniquePaths, inputIds: uniqueIds, reason });
  };

  // One contribution per input that changed this path, in caller order. Shared
  // by the main pass and by the refused-destination recomputation, so both
  // build exactly the same per-input views.
  const contributionCache = new Map<string, Contribution[]>();
  const collectContributions = (key: string): Contribution[] => {
    const cached = contributionCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const baseEntry = own(baseEntries, key);
    const collected: Contribution[] = [];
    for (const tree of trees) {
      const read: IntegrationRead = path => tree.input.read(path);
      const entry = own(tree.entries, key);
      if (entry === undefined) {
        if (baseEntry !== undefined) {
          collected.push({ id: tree.input.id, change: DELETE, read });
        }
      } else if (baseEntry === undefined || !sameEntry(baseEntry, entry)) {
        collected.push({ id: tree.input.id, change: { kind: 'entry', entry }, read });
      }
    }
    contributionCache.set(key, collected);
    return collected;
  };

  for (const key of ordered) {
    const baseEntry = own(baseEntries, key);
    const keyContributions = collectContributions(key);
    if (keyContributions.length === 0) {
      continue;
    }
    keyIds.set(key, keyContributions.map(contribution => contribution.id));
    const decision = await mergePath(key, baseEntry, keyContributions, context);
    if (decision.kind === 'change') {
      pending.set(key, decision.change);
      continue;
    }
    const records = renames.get(key) ?? [];
    const destinations: string[] = [];
    for (const record of records) {
      destinations.push(...record.destinations);
      for (const destination of record.destinations) {
        dropDestination(destination, [record.id]);
      }
    }
    addConflict(
      destinations.length > 0 ? [key, ...destinations] : [key],
      decision.inputIds,
      decision.reason
    );
  }

  // Divergent exact-content renames: two inputs moved the same base file to
  // different paths. Without this check both destinations would be added and
  // the source deleted "cleanly", silently duplicating one file.
  for (const [source, records] of renames) {
    if (records.length < 2) {
      continue;
    }
    const signatures = new Set(records.map(record => record.destinations.join('\u0000')));
    if (signatures.size < 2) {
      continue;
    }
    const destinations: string[] = [];
    for (const record of records) {
      destinations.push(...record.destinations);
    }
    addConflict([source, ...destinations], records.map(record => record.id), 'divergent rename');
    droppedSources.add(source);
    for (const record of records) {
      for (const destination of record.destinations) {
        dropDestination(destination, [record.id]);
      }
    }
  }
  for (const source of droppedSources) {
    pending.delete(source);
  }
  for (const [destination, refusedIds] of droppedDestinations) {
    // A destination that never reached `pending` is already conflicted, so its
    // base entry is preserved untouched.
    if (!pending.has(destination)) {
      continue;
    }
    // Recompute the destination from the inputs whose move was NOT refused, so
    // a refused overwrite-rename leaves none of its own bytes behind. With no
    // independent contribution left the base entry simply survives.
    const remaining = collectContributions(destination)
      .filter(contribution => !refusedIds.has(contribution.id));
    if (remaining.length === 0) {
      pending.delete(destination);
      continue;
    }
    const decision = await mergePath(destination, own(baseEntries, destination), remaining, context);
    if (decision.kind === 'change') {
      pending.set(destination, decision.change);
      continue;
    }
    pending.delete(destination);
    addConflict([destination], decision.inputIds, decision.reason);
  }
  const idsFor = (paths: readonly string[]): string[] => {
    const ids: string[] = [];
    for (const tree of trees) {
      if (paths.some(path => (keyIds.get(path) ?? []).includes(tree.input.id))) {
        ids.push(tree.input.id);
      }
    }
    return ids.length > 0 ? ids : trees.map(tree => tree.input.id);
  };
  for (let round = 0; round < MAX_CLEANUP_ROUNDS; round += 1) {
    let progressed = false;
    for (const problem of structuralProblems(baseEntries, pending)) {
      addConflict(problem.paths, idsFor(problem.paths), problem.reason);
      for (const culprit of problem.culprits) {
        if (pending.delete(culprit)) {
          progressed = true;
        }
      }
    }
    // A rejected rename destination (add/add, case or structural collision)
    // must not delete its source, nor the children it only cleared away.
    if (preserveRenameSources(baseEntries, renameTargets, pending, keyIds, conflicts)) {
      progressed = true;
    }
    if (!progressed) {
      break;
    }
  }
  pruneOrphanParents(baseEntries, pending, [...droppedDestinations.keys(), ...renameTargets.keys()]);
  if (structuralProblems(baseEntries, pending).length > 0) {
    throw new WorkerError('merge_incoherent', 'merged namespace is not coherent after conflict cleanup');
  }

  const collected: Record<string, SnapshotEntry | null> = Object.create(null);
  for (const key of [...pending.keys()].sort(comparePaths)) {
    const change = pending.get(key);
    if (change !== undefined) {
      collected[key] = change.kind === 'delete' ? null : change.entry;
    }
  }
  const changes = { ...collected };
  new LayeredTree(root, baseEntries, [changes]);

  // `preserveRenameSources` extends an existing conflict in place, so two
  // owners can end up describing the same paths. Collapse them into one entry
  // (union of input ids, first-seen order) before sorting.
  const deduped: IntegrationConflict[] = [];
  const byIdentity = new Map<string, IntegrationConflict>();
  for (const conflict of conflicts) {
    const identity = `${conflict.reason}\u0000${conflict.paths.join('\u0000')}`;
    const existing = byIdentity.get(identity);
    if (existing === undefined) {
      byIdentity.set(identity, conflict);
      deduped.push(conflict);
      continue;
    }
    for (const id of conflict.inputIds) {
      if (!existing.inputIds.includes(id)) {
        existing.inputIds.push(id);
      }
    }
  }
  deduped.sort((left, right) => comparePaths(left.paths.join('\u0000'), right.paths.join('\u0000'))
    || comparePaths(left.reason, right.reason)
    || comparePaths(left.inputIds.join('\u0000'), right.inputIds.join('\u0000')));
  return { changes, conflicts: deduped };
}
