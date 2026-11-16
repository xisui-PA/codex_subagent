import { createHash } from 'node:crypto';
import { ContentStore, SnapshotManifest, isFileMode } from './snapshot-content';
import { LayeredTree, Delta } from './layered-tree';
import type { OverlayRevision } from './isolated-view-types';
import type { IsolatedViewState } from './isolated-view-port';
import { WorkerError } from './types';

export const MAX_OVERLAY_REVISIONS = 1024;
const HEX = /^[a-f0-9]{64}$/;
const protectedNames = new Set(['.git', '.codex', '.vscode']);
const corrupt = (message: string): never => {
  throw new WorkerError('isolation_corrupt', message);
};

/** Manual validation preserves ordinary path keys such as __proto__. */
export function parseOverlayRevision(bytes: Buffer): OverlayRevision {
  if (bytes.length > 32 * 1024 * 1024) {
    corrupt('Overlay revision exceeds its metadata limit.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    corrupt('Overlay revision is not valid UTF-8 JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    corrupt('Overlay revision must be an object.');
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some(key => !['schema', 'overlayId', 'parent', 'revision', 'changes'].includes(key))
    || record.schema !== 1 || typeof record.overlayId !== 'string' || !HEX.test(record.overlayId)
    || !(record.parent === null || (typeof record.parent === 'string' && HEX.test(record.parent)))
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1 || (record.revision as number) > MAX_OVERLAY_REVISIONS
    || !record.changes || typeof record.changes !== 'object' || Array.isArray(record.changes)) {
    corrupt('Malformed overlay revision metadata.');
  }
  for (const [key, value] of Object.entries(record.changes as Record<string, unknown>)) {
    if (key.split('/').some(part => protectedNames.has(part.toLowerCase()))) {
      corrupt('Overlay revisions cannot change protected configuration paths.');
    }
    if (value !== null && (!value || typeof value !== 'object' || !['file', 'directory'].includes((value as { type: string }).type))) {
      corrupt('Overlay changes support only ordinary files, directories and tombstones.');
    }
    // Optional executable mode metadata belongs to ordinary FILE changes only:
    // absent is the documented 0o644 default for legacy revisions, and any
    // other value (or a mode on a directory/tombstone) fails closed here
    // instead of surviving into a materialized tree.
    if (value !== null && typeof value === 'object') {
      const change = value as { type?: unknown; mode?: unknown };
      if ('mode' in change) {
        if (change.type !== 'file' || !isFileMode(change.mode)) {
          corrupt('Overlay changes carry an invalid file mode.');
        }
      }
    }
  }
  return record as unknown as OverlayRevision;
}

/** Loads one immutable head; no workspace paths or mutable fallback are used. */
export async function loadRevisionTree(
  content: ContentStore, manifest: SnapshotManifest, overlayId: string,
  head: string | null, revision: number, guard: () => void
): Promise<{ tree: LayeredTree; marks: Set<string> }> {
  guard();
  if (!HEX.test(overlayId) || !Number.isSafeInteger(revision) || revision < 0 || revision > MAX_OVERLAY_REVISIONS
    || (head === null) !== (revision === 0) || (head !== null && !HEX.test(head))) {
    corrupt('Overlay head and revision disagree.');
  }
  const marks = new Set<string>();
  const visited = new Set<string>();
  const deltas: Delta[] = [];
  let next = head;
  let expected = revision;
  while (next !== null) {
    guard();
    if (visited.has(next) || expected < 1) {
      corrupt('Overlay revision chain contains a cycle or excess parent.');
    }
    marks.add(next);
    visited.add(next);
    const record = parseOverlayRevision(await content.read(next));
    guard();
    if (record.overlayId !== overlayId || record.revision !== expected) {
      corrupt('Overlay revision chain belongs to another view or skips a revision.');
    }
    for (const entry of Object.values(record.changes)) {
      if (entry?.type === 'file') {
        marks.add(entry.hash);
      }
    }
    deltas.push(record.changes);
    next = record.parent;
    expected -= 1;
  }
  if (expected !== 0) {
    corrupt('Overlay revision chain is incomplete.');
  }
  const tree = new LayeredTree(manifest.root, manifest.entries, deltas.reverse());
  guard();
  return { tree, marks };
}

/** The reader receives content hashes only after resolving a visible file. */
export function revisionState(
  tree: LayeredTree, revision: number,
  readContent: (hash: string) => Promise<Buffer>, guard: () => void
): IsolatedViewState {
  return Object.freeze({
    tree, revision,
    read: async (input: string) => {
      guard();
      const key = tree.resolve(input);
      if (key === undefined) {
        throw new WorkerError('not_found', 'File is absent from this immutable revision.');
      }
      const entry = tree.stat(key);
      if (!entry || entry.type !== 'file') {
        throw new WorkerError('unsupported_path', 'Only ordinary captured files can be read.');
      }
      const bytes = Buffer.from(await readContent(entry.hash));
      guard();
      if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.hash) {
        throw new WorkerError('snapshot_content_missing', 'Stored content does not match the captured file.');
      }
      return { path: key, bytes, hash: entry.hash };
    }
  });
}
