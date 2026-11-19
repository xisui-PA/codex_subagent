import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite, digest } from './storage';
import { WorkerError } from './types';

export const receiptArchiveSchema = z.strictObject({ ownerId: z.string().min(1).max(200), epoch: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/), uri: z.string().max(2048) });
export type ReceiptArchive = z.infer<typeof receiptArchiveSchema>;
export const receiptEpochsSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.number().int().nonnegative()).refine(v => Object.keys(v).length <= 256);
/** One archive directory holds at most 64 files; each part stays at most 32 MiB uncompressed. */
export const MAX_RECEIPT_ARCHIVE_FILES = 64;
export const MAX_RECEIPT_ARCHIVE_BYTES = 32 * 1024 ** 2;
/** Per-part header room, reserved so every planned part is strictly inside the byte cap. */
const RECEIPT_PART_RESERVE = 4096;
/** A frozen publication selection is bounded like the largest store receipt map. */
export const MAX_RECEIPT_PUBLICATION_KEYS = 4096;
/**
 * Durable, bounded publication intent. It names one owner's exact epoch
 * advance, the content-addressed parts that epoch needs and the exact receipt
 * keys that produced them. Callers persist it BEFORE opening any new part, so
 * an interruption after a part is written still leaves identities that the
 * next rollover can find, verify and reclaim instead of an orphan file.
 */
export const receiptArchivePublicationSchema = z.strictObject({
  namespace: z.string().min(1).max(400),
  ownerId: z.string().min(1).max(200),
  fromEpoch: z.number().int().nonnegative(),
  toEpoch: z.number().int().positive(),
  archives: z.array(receiptArchiveSchema).min(1).max(MAX_RECEIPT_ARCHIVE_FILES),
  receiptKeys: z.array(z.string().min(1).max(400)).max(MAX_RECEIPT_PUBLICATION_KEYS)
}).refine(pending => pending.toEpoch === pending.fromEpoch + 1
  && pending.archives.every(archive => archive.ownerId === pending.ownerId && archive.epoch === pending.fromEpoch)
  && new Set(pending.archives.map(archive => archive.hash)).size === pending.archives.length
  && new Set(pending.receiptKeys).size === pending.receiptKeys.length, {
  message: 'a receipt archive publication intent must name one epoch advance, its owner and unique identities'
});
export type ReceiptArchivePublication = z.infer<typeof receiptArchivePublicationSchema>;
/** One store keeps at most this many pending intents, one per owner and namespace. */
export const MAX_RECEIPT_PUBLICATION_INTENTS = 8;
export const receiptArchivePublicationsSchema = z.array(receiptArchivePublicationSchema).max(MAX_RECEIPT_PUBLICATION_INTENTS)
  .refine(intents => new Set(intents.map(intent => `${intent.namespace}\u0000${intent.ownerId}`)).size === intents.length, {
    message: 'each owner may hold at most one pending receipt archive publication'
  });

/**
 * Durable, bounded deletion intent. Callers publish these entries beside their
 * own metadata BEFORE unlinking, so an interrupted collection is completed by a
 * later explicit scoped collection instead of leaking files that the 64-file
 * directory cap could never reclaim. One entry per removed archive record keeps
 * it bounded.
 */
export const receiptArchiveDeletesSchema = z.array(receiptArchiveSchema).max(MAX_RECEIPT_ARCHIVE_FILES);
export interface ReceiptMetadata { receiptEpochs?: Record<string, number>; receiptArchives?: ReceiptArchive[]; receiptArchiveDeletes?: ReceiptArchive[]; receiptArchivePublications?: ReceiptArchivePublication[]; legacyRequestKeys?: string[] }

/**
 * Trusted, live request-ID policy. It is supplied by host configuration - a
 * live settings read - and never by per-request input, so a caller cannot
 * widen its own request namespace. An absent callback keeps the governed rules,
 * which is also the safe default for any handle that was not wired.
 */
export interface RequestIdPolicy {
  /**
   * True while this namespace is NOT governed (resource governance is off), so
   * an epoch-prefixed request ID is an ordinary fresh identity. Read live at
   * every request; whatever it returns can only relax an INITIAL namespace.
   */
  ordinaryRequestIds?: () => boolean;
}

/**
 * True once any owner's receipt epoch advanced or any archive intent exists.
 * An initial namespace that never rolled over cannot later derive an
 * epoch-prefixed identity, so pre-using one there stays harmless: the FIRST
 * rollover freezes the entire live receipt map in legacyRequestKeys (one
 * bounded snapshot, never a growing log), and every later receipt is created in
 * a prefixed epoch or by an owner who never rolled over, whose unprefixed
 * identities can never collide with `e<epoch>:` IDs. From that first rollover
 * on, epoch-prefixed IDs are reserved again, so no pre-used identity becomes a
 * fresh operation.
 */
export function namespaceRolledOver(data: ReceiptMetadata): boolean {
  return (data.receiptArchives?.length ?? 0) > 0
    || (data.receiptArchiveDeletes?.length ?? 0) > 0
    || (data.receiptArchivePublications?.length ?? 0) > 0
    || Object.values(data.receiptEpochs ?? {}).some(epoch => epoch > 0);
}

export function currentEpoch(data: ReceiptMetadata, ownerId: string): number {
  return data.receiptEpochs?.[digest(ownerId)] ?? 0;
}
/** After explicit expiry, an old request never becomes a new operation. */
export function assertRequestEpoch(data: ReceiptMetadata, ownerId: string, requestId: string, key?: string, recorded = false, policy?: RequestIdPolicy): void {
  const epoch = currentEpoch(data, ownerId);
  // An initial legacy receipt may already have used a future-looking ID.
  // Keep its bounded identity after archival so that rollover cannot reuse it.
  if (!recorded && key !== undefined && data.legacyRequestKeys?.includes(key)) {
    throw new WorkerError('request_expired', 'This legacy receipt identity was retired; it cannot become a fresh operation in a later request epoch.');
  }
  // A receipt that is still recorded in the live map keeps its exact replay
  // across an epoch advance: it is the same operation, never a new one.
  // Archived identities are absent from the live map, so they stay rejected.
  if (recorded) {
    return;
  }
  if (epoch === 0 && /^e[0-9]+:/.test(requestId)) {
    // An ordinary (ungoverned) workflow may name a fresh request "e1:" while
    // this namespace has never rolled over: no owner advanced, so no prefix can
    // later denote a new namespace and no pre-used identity can be replayed
    // under it. A governed initial namespace keeps them reserved.
    if (policy?.ordinaryRequestIds?.() === true && !namespaceRolledOver(data)) {
      return;
    }
    throw new WorkerError('invalid_arguments', 'Epoch-prefixed request IDs are reserved for rollover. Use an unprefixed ID in the initial namespace.');
  }
  if (epoch > 0 && !requestId.startsWith(`e${epoch}:`)) {
    throw new WorkerError('request_expired', `This request namespace is retired. Current request IDs must begin e${epoch}:. Inspect the original result/history; do not retry an uncertain effect as a fresh request.`);
  }
}

export function epochRequest(data: ReceiptMetadata, ownerId: string, key: string): string {
  const epoch = currentEpoch(data, ownerId); return epoch ? `e${epoch}:${key}` : key;
}

interface ReceiptPartIdentity { index: number; count: number }
/**
 * The single-part document is byte-identical to the pre-partition format, and
 * a multi-part document only adds its bounded part identity. Receipts keep the
 * caller's source key order, never a re-sorted one, so identities are stable.
 */
function archiveText(namespace: string, ownerId: string, epoch: number, receipts: Record<string, unknown>, part?: ReceiptPartIdentity): string {
  const document = { schema: 1, namespace, ownerId, epoch, receipts };
  return JSON.stringify(part ? { ...document, part } : document);
}
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const partBudget = MAX_RECEIPT_ARCHIVE_BYTES - RECEIPT_PART_RESERVE;

function oversizeReceipt(bytes: number): never {
  throw new WorkerError('receipt_capacity', `A single receipt needs ${bytes} bytes, exceeding the bounded ${MAX_RECEIPT_ARCHIVE_BYTES}-byte archive part. Retain this namespace and start a fresh explicitly named store; no requests were expired.`);
}

/**
 * Plans the bounded archive parts for one epoch. A payload that fits in one part
 * keeps the legacy single-document shape in the caller's own key order, so
 * preexisting archive hashes, URIs and readers stay valid. Only a payload above
 * the byte cap is partitioned, and then in sorted key order so a retry of the
 * same epoch reproduces the same parts, hashes and URIs.
 */
export function planReceiptArchiveParts(namespace: string, ownerId: string, epoch: number, receipts: Record<string, unknown>): string[] {
  const legacy = archiveText(namespace, ownerId, epoch, receipts);
  if (Buffer.byteLength(legacy, 'utf8') <= MAX_RECEIPT_ARCHIVE_BYTES) {
    return [legacy];
  }
  const overhead = Buffer.byteLength(archiveText(namespace, ownerId, epoch, {}), 'utf8');
  const groups: Record<string, unknown>[] = [];
  let group: Record<string, unknown> = {}; let count = 0; let used = overhead;
  for (const key of Object.keys(receipts).sort()) {
    const value = receipts[key];
    const size = Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (count > 0 && used + 1 + size > partBudget) {
      groups.push(group); group = {}; count = 0; used = overhead;
    }
    if (count === 0 && used + size > partBudget) {
      oversizeReceipt(overhead + size);
    }
    group[key] = value; count += 1; used += (count > 1 ? 1 : 0) + size;
  }
  groups.push(group);
  return groups.map((entries, index) => {
    const text = archiveText(namespace, ownerId, epoch, entries, { index: index + 1, count: groups.length });
    if (Buffer.byteLength(text, 'utf8') > MAX_RECEIPT_ARCHIVE_BYTES) {
      oversizeReceipt(Buffer.byteLength(text, 'utf8'));
    }
    return text;
  });
}

interface ArchivePart { bytes: Buffer; hash: string }

/** Compresses the planned parts once, so plan and write share one byte identity. */
function archiveParts(namespace: string, ownerId: string, epoch: number, receipts: Record<string, unknown>): ArchivePart[] {
  return planReceiptArchiveParts(namespace, ownerId, epoch, receipts).map(text => {
    const bytes = gzipSync(Buffer.from(text, 'utf8'));
    return { bytes, hash: sha256(bytes) };
  });
}

/** Archive records keep the preexisting URI shape, so old readers and pins stay valid. */
function archiveDescriptors(namespace: string, ownerId: string, epoch: number, parts: readonly ArchivePart[]): ReceiptArchive[] {
  return parts.map(part => ({ ownerId, epoch, hash: part.hash, uri: `codex-subagent://receipts/${namespace}/${part.hash}/1` }));
}

/**
 * Plans one rollover as a bounded, durable publication intent: the exact
 * content-addressed parts plus the exact receipt keys that produced them.
 * Nothing is written here, so the caller can persist the intent first and only
 * then open new files.
 */
export function planArchivePublication(namespace: string, ownerId: string, fromEpoch: number, receipts: Record<string, unknown>): ReceiptArchivePublication {
  if (!Number.isSafeInteger(fromEpoch + 1)) {
    throw new WorkerError('receipt_capacity', 'The receipt epoch cannot advance safely; no requests were expired and no archive part was published.');
  }
  const parts = archiveParts(namespace, ownerId, fromEpoch, receipts);
  if (parts.length > MAX_RECEIPT_ARCHIVE_FILES) {
    throw new WorkerError('receipt_capacity', `This epoch needs ${parts.length} archive parts, above the bounded ${MAX_RECEIPT_ARCHIVE_FILES} records. Collect unreferenced expired archives before rollover; no requests were expired and no archive part was published.`);
  }
  return { namespace, ownerId, fromEpoch, toEpoch: fromEpoch + 1, archives: archiveDescriptors(namespace, ownerId, fromEpoch, parts), receiptKeys: Object.keys(receipts) };
}

/**
 * Rebuilds the frozen receipt selection in the intent's own recorded key order,
 * so the archive identity stays byte-identical even when further receipts were
 * accepted after the intent. A frozen receipt that is gone fails closed instead
 * of silently shrinking the archive.
 */
export function selectPublicationReceipts<T>(pending: ReceiptArchivePublication, current: Record<string, T>): Record<string, T> {
  const selected: Record<string, T> = {};
  for (const key of pending.receiptKeys) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      throw new WorkerError('receipt_corrupt', 'A receipt named by the frozen archive publication intent is missing; restore it before retrying the rollover.');
    }
    selected[key] = current[key];
  }
  return selected;
}

/** A missing file is undefined; anything but a bounded plain file is corrupt. */
async function readArchiveBytes(file: string): Promise<Buffer | undefined> {
  const stat = await fs.lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    } throw error;
  });
  if (!stat) {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_ARCHIVE_BYTES) {
    throw new WorkerError('receipt_corrupt', 'Receipt archive must be a bounded plain file.');
  }
  return fs.readFile(file);
}

const ARCHIVE_DIRECTORY_REFUSAL = 'The receipt archive path must be a plain directory beneath this store; no archive part was published, no request was expired and no registration was needed to report it.';

/**
 * Read-only scan of the archive directory beneath one retention root. The root
 * and the archive directory itself are each verified as plain, non-symlinked
 * directories BEFORE the scan: Windows reports ENOENT for a children scan when
 * the parent is a regular file, and following a linked layout would step outside
 * this store. A structural refusal is diagnosed here instead of surfacing later
 * as a raw ENOTDIR. A missing directory is simply empty, and nothing is created,
 * read or unlinked.
 */
async function readArchiveDirectory(directory: string): Promise<string[]> {
  const parent = await fs.lstat(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    } throw error;
  });
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) {
    throw new WorkerError('receipt_corrupt', ARCHIVE_DIRECTORY_REFUSAL);
  }
  const folder = path.join(directory, 'receipt-archives');
  const stat = await fs.lstat(folder).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    } throw error;
  });
  if (!stat) {
    return [];
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkerError('receipt_corrupt', ARCHIVE_DIRECTORY_REFUSAL);
  }
  return fs.readdir(folder);
}

/**
 * Archives one epoch as deterministic bounded parts. `records` is the caller's
 * remaining metadata-record capacity (its own recorded archive list) and is
 * checked separately from the physical directory cap, so neither bound can
 * double count the other. An existing part that already matches its
 * content-addressed name is reused, which makes a retried rollover idempotent.
 * Every limit is checked before the first new part is published, and unknown
 * files in the directory are never touched.
 */
export async function archiveReceipts(directory: string, namespace: string, ownerId: string, epoch: number, receipts: Record<string, unknown>, records: number = MAX_RECEIPT_ARCHIVE_FILES): Promise<ReceiptArchive[]> {
  const folder = path.join(directory, 'receipt-archives');
  const parts = archiveParts(namespace, ownerId, epoch, receipts);
  if (parts.length > records) {
    throw new WorkerError('receipt_capacity', `Receipt archive records are bounded to ${MAX_RECEIPT_ARCHIVE_FILES} and only ${records} remain, but this epoch needs ${parts.length} parts. Collect unreferenced expired archives before rollover; no requests were expired and no archive part was published.`);
  }
  const existing = await fs.readdir(folder).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [] as string[];
    } throw error;
  });
  const additions: ArchivePart[] = [];
  for (const part of parts) {
    const file = `${part.hash}.json.gz`;
    const saved = existing.includes(file) ? await readArchiveBytes(path.join(folder, file)) : undefined;
    if (saved && !saved.equals(part.bytes)) {
      throw new WorkerError('receipt_corrupt', 'The immutable receipt archive differs from its recorded identity.');
    }
    if (!saved && !additions.some(added => added.hash === part.hash)) {
      additions.push(part);
    }
  }
  if (existing.length + additions.length > MAX_RECEIPT_ARCHIVE_FILES) {
    throw new WorkerError('receipt_capacity', `The receipt archive directory is bounded to ${MAX_RECEIPT_ARCHIVE_FILES} files, and this epoch needs ${additions.length} more beside ${existing.length} present. Collect unreferenced expired archives or finish an interrupted collection; no requests were expired and no archive part was published.`);
  }
  if (!additions.length) {
    return archiveDescriptors(namespace, ownerId, epoch, parts);
  }
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  for (const part of additions) {
    await atomicWrite(path.join(folder, `${part.hash}.json.gz`), part.bytes);
  }
  return archiveDescriptors(namespace, ownerId, epoch, parts);
}

interface PreparedArchivePublication { intent: ReceiptArchivePublication; additions: ArchivePart[] }

/**
 * Checks a durable publication intent against the current receipts and the
 * archive directory. The intent must reproduce its recorded identities byte for
 * byte, every already-present part must match, and both caps are applied with
 * the parts this intent owns counted as directory files. Nothing is written.
 */
async function prepareArchivePublication(directory: string, pending: ReceiptArchivePublication, receipts: Record<string, unknown>, records: number): Promise<PreparedArchivePublication> {
  const intent = receiptArchivePublicationSchema.parse(pending);
  const parts = archiveParts(intent.namespace, intent.ownerId, intent.fromEpoch, receipts);
  if (JSON.stringify(archiveDescriptors(intent.namespace, intent.ownerId, intent.fromEpoch, parts)) !== JSON.stringify(intent.archives)) {
    throw new WorkerError('receipt_corrupt', 'The frozen receipt archive publication no longer reproduces its recorded identities; restore the original receipts before retrying the rollover.');
  }
  if (parts.length > records) {
    throw new WorkerError('receipt_capacity', `Receipt archive records are bounded to ${MAX_RECEIPT_ARCHIVE_FILES} and only ${records} remain, but this epoch needs ${parts.length} parts. Collect unreferenced expired archives before rollover; no requests were expired and no archive part was published.`);
  }
  const folder = path.join(directory, 'receipt-archives');
  const existing = await readArchiveDirectory(directory);
  const additions: ArchivePart[] = [];
  for (const part of parts) {
    const file = `${part.hash}.json.gz`;
    const saved = existing.includes(file) ? await readArchiveBytes(path.join(folder, file)) : undefined;
    if (saved && !saved.equals(part.bytes)) {
      throw new WorkerError('receipt_corrupt', 'The immutable receipt archive differs from its recorded identity.');
    }
    if (!saved && !additions.some(added => added.hash === part.hash)) {
      additions.push(part);
    }
  }
  if (existing.length + additions.length > MAX_RECEIPT_ARCHIVE_FILES) {
    throw new WorkerError('receipt_capacity', `The receipt archive directory is bounded to ${MAX_RECEIPT_ARCHIVE_FILES} files, and this epoch needs ${additions.length} more beside ${existing.length} present. Collect unreferenced expired archives or finish an interrupted collection; no requests were expired and no archive part was published.`);
  }
  return { intent, additions };
}

/**
 * Runs every bound before the publication intent becomes durable, so a rejected
 * rollover leaves no metadata, no epoch change and no file behind. It is fully
 * read-only: it reproduces the planned parts, requires the intent to name exactly
 * their identities, compares every part already present byte for byte, and
 * applies the record and directory caps with this intent's own parts counted.
 * That makes it the check a host runs BEFORE a store's first registration - a
 * physical archive refusal (an unreadable or structurally wrong directory, a
 * replaced or tampered part, a full directory) is reported while the store is
 * still unregistered - and it is repeated under the single store write fence
 * immediately before the intent and parts are mutated.
 */
export async function preflightArchivePublication(directory: string, pending: ReceiptArchivePublication, receipts: Record<string, unknown>, records: number = MAX_RECEIPT_ARCHIVE_FILES): Promise<void> {
  await prepareArchivePublication(directory, pending, receipts, records);
}

/**
 * Publishes exactly the parts named by a durable intent. Parts already present
 * must match their content-addressed identity, and only the missing ones are
 * opened, so an interrupted publication converges on an exact retry. Unknown
 * files are never touched.
 */
export async function publishArchivePublication(directory: string, pending: ReceiptArchivePublication, receipts: Record<string, unknown>, records: number = MAX_RECEIPT_ARCHIVE_FILES): Promise<ReceiptArchive[]> {
  const prepared = await prepareArchivePublication(directory, pending, receipts, records);
  if (prepared.additions.length) {
    const folder = path.join(directory, 'receipt-archives');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    for (const part of prepared.additions) {
      await atomicWrite(path.join(folder, `${part.hash}.json.gz`), part.bytes);
    }
  }
  return prepared.intent.archives.map(archive => ({ ...archive }));
}

export async function verifyArchive(directory: string, archive: ReceiptArchive): Promise<void> {
  const bytes = await readArchiveBytes(path.join(directory, 'receipt-archives', `${archive.hash}.json.gz`));
  if (!bytes) {
    throw new WorkerError('receipt_corrupt', 'The retained receipt archive is missing; restore it before administering this store.');
  }
  verifyArchiveBytes(bytes, archive);
}

function verifyArchiveBytes(bytes: Buffer, archive: ReceiptArchive): void {
  if (sha256(bytes) !== archive.hash) {
    throw new WorkerError('receipt_corrupt', 'Receipt archive hash changed.');
  }
  const raw = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_RECEIPT_ARCHIVE_BYTES }).toString('utf8')) as { ownerId: string; epoch: number; part?: { index?: unknown; count?: unknown } };
  if (raw.ownerId !== archive.ownerId || raw.epoch !== archive.epoch) {
    throw new WorkerError('receipt_corrupt', 'Receipt archive scope changed.');
  }
  if (raw.part !== undefined) {
    const { index, count } = raw.part;
    if (!Number.isInteger(index) || !Number.isInteger(count) || (count as number) < 2 || (count as number) > MAX_RECEIPT_ARCHIVE_FILES
      || (index as number) < 1 || (index as number) > (count as number)) {
      throw new WorkerError('receipt_corrupt', 'Receipt archive part identity changed.');
    }
  }
}

/**
 * Completes a durable deletion intent. Callers pass only the entries they have
 * already proven unreferenced for their exact scope, so retained, pinned and
 * unknown files are preserved by construction. Each entry is verified against
 * its recorded identity before the exact `<hash>.json.gz` file is unlinked, and
 * a missing file counts as already deleted, so retries and restarts converge.
 * A changed identity fails closed, and an I/O failure is reported back as a
 * still-remaining entry so the caller keeps its intent for another attempt.
 */
export async function completeArchiveDeletions(directory: string, pending: readonly ReceiptArchive[]): Promise<{ deleted: ReceiptArchive[]; remaining: ReceiptArchive[]; diagnostics: string[] }> {
  const deleted: ReceiptArchive[] = []; const remaining: ReceiptArchive[] = []; const diagnostics: string[] = [];
  for (const archive of pending) {
    const file = path.join(directory, 'receipt-archives', `${archive.hash}.json.gz`);
    try {
      const bytes = await readArchiveBytes(file);
      if (bytes) {
        verifyArchiveBytes(bytes, archive);
        await fs.unlink(file);
      }
      deleted.push(archive);
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'receipt_corrupt') {
        throw error;
      }
      remaining.push(archive);
      if (diagnostics.length < 4) {
        diagnostics.push(`Receipt archive ${archive.hash} could not be deleted yet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { deleted, remaining, diagnostics };
}
