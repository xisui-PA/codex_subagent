import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, Mutex } from './storage';
import { WorkerError } from './types';

const scope = { ownerId: z.string().min(1).max(200), teamId: z.string().regex(/^[a-f0-9]{32}$/) };
/**
 * `integrationAttemptId` marks a PROTECTED internal pin adopted by one exact
 * integration attempt. It is additive metadata, so an existing ledger (and its
 * namespace marker) stays valid, while a public pin or release can never find,
 * rename or remove an internal one: the public name lookup is filtered by it.
 */
const pinSchema = z.strictObject({ ...scope, name: z.string().min(1).max(128), uri: z.string().min(1).max(2048),
  integrationAttemptId: z.string().min(1).max(200).optional() });
const schema = z.strictObject({ schema: z.literal(1), pins: z.array(pinSchema).max(1024) });
type Data = z.infer<typeof schema>;
/** One exact resource an integration attempt protects by name. */
export interface IntegrationPin { ownerId: string; teamId: string; name: string; uri: string }
export interface IntegrationPinResult { adopted: string[]; replayed: string[]; pins: IntegrationPin[] }
const MAX_ATTEMPT_ID = 200;
/** Attempt IDs are immutable store keys: printable, bounded, never a path. */
function integrationAttemptId(value: unknown): string {
  const printable = typeof value === 'string'
    && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!printable || value.length === 0 || value.length > MAX_ATTEMPT_ID) {
    throw new WorkerError('retention_invalid', 'An integration attempt ID must be 1-200 printable characters.');
  }
  return value;
}
function integrationPin(value: unknown): IntegrationPin {
  if (typeof value !== 'object' || value === null) {
    throw new WorkerError('retention_invalid', 'An integration evidence pin must be an object.');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['ownerId', 'teamId', 'name', 'uri'].includes(key)) {
      throw new WorkerError('retention_invalid', `An integration evidence pin has an unknown field ${JSON.stringify(key)}.`);
    }
  }
  const parsed = pinSchema.omit({ integrationAttemptId: true }).safeParse(record);
  if (!parsed.success) {
    throw new WorkerError('retention_invalid', 'An integration evidence pin requires ownerId, teamId, name and uri.');
  }
  return { ownerId: parsed.data.ownerId, teamId: parsed.data.teamId, name: parsed.data.name, uri: parsed.data.uri };
}
/** Named pins for command evidence, archives and future consumer/integration refs. */
export class EvidenceRetention {
  private readonly mutex = new Mutex();
  private data?: Data;
  private readonly file: string;
  private readonly namespace: string;
  private readonly namespaceText = JSON.stringify({ schema: 1, kind: 'evidence-retention' });
  constructor(directory: string) {
    this.file = path.join(directory, 'evidence-retention.json');
    this.namespace = path.join(directory, 'evidence-retention.namespace.json');
  }
  async exists(): Promise<boolean> {
    for (const file of [this.file, this.namespace]) {
      if (await fs.lstat(file).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        } throw error;
      })) {
        return true;
      }
    }
    return false;
  }
  private async open(): Promise<Data> {
    if (!this.data) {
      const namespace = await fs.lstat(this.namespace).then(async stat => {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) {
          throw new WorkerError('retention_corrupt', `Restore the plain evidence namespace marker ${this.namespace}.`);
        }
        const text = await fs.readFile(this.namespace, 'utf8');
        if (text !== this.namespaceText) {
          throw new WorkerError('retention_corrupt', `Restore ${this.namespace}; its identity changed.`);
        }
        return text;
      }, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        } throw error;
      });
      let data: Data;
      try {
        const stat = await fs.lstat(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 ** 2) {
          throw new Error('Unsafe retention metadata');
        }
        data = schema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new WorkerError('retention_corrupt', `Restore ${this.file}: ${String(error)}`);
        }
        if (namespace !== undefined) {
          throw new WorkerError('retention_corrupt', `Restore missing ${this.file}; its established evidence namespace cannot be reset.`);
        }
        data = { schema: 1, pins: [] };
        // Bootstrap the empty ledger before its marker. A crash leaves either
        // no acknowledgement or a valid ledger that can safely gain its marker.
        await atomicWrite(this.file, JSON.stringify(data));
      }
      if (namespace === undefined) {
        await atomicWrite(this.namespace, this.namespaceText);
      }
      this.data = data;
    }
    return this.data;
  }
  /**
   * Apply one pin or release under the pin mutex.
   *
   * `admit` is the narrowly scoped NEW-pin gate: it is consulted before the
   * bootstrap write of a ledger that does not exist yet, and before a new pin is
   * appended to one that does. No ledger means no pin to replay, so the early
   * gate can never refuse a replay, and an exact replay or a release returns
   * before the second one - both must stay available after a feature opt-out.
   */
  async update(input: { ownerId: string; teamId: string; name: string; uri: string; action: 'pin' | 'release' }, guard: () => void, validate?: () => Promise<void>, publish?: (commit: () => Promise<void>) => Promise<void>, admit?: () => void): Promise<unknown> {
    return this.mutex.run(async () => {
      // A refused pin must not create a brand-new empty evidence namespace.
      const bootstrap = input.action === 'pin' && !await this.exists();
      if (bootstrap) {
        admit?.();
      }
      const data = await this.open(); guard();
      await validate?.(); guard();
      // Internal integration pins are invisible to the public vocabulary: a
      // public name can neither replay, adopt nor release a protected one.
      const existing = data.pins.find(p => p.integrationAttemptId === undefined
        && p.ownerId === input.ownerId && p.teamId === input.teamId && p.name === input.name);
      if (existing && existing.uri !== input.uri) {
        throw new WorkerError('retention_conflict', 'Release the existing exact pin before using this name for a different resource.');
      }
      if (input.action === 'pin' && existing) {
        return existing;
      }
      if (input.action === 'pin' && !bootstrap) {
        admit?.();
      }
      const draft = structuredClone(data);
      if (input.action === 'pin') {
        if (draft.pins.length >= 1024) {
          throw new WorkerError('retention_capacity', '1024 evidence pins are retained. Release completed consumers explicitly before adding another.');
        }
        draft.pins.push({ ownerId: input.ownerId, teamId: input.teamId, name: input.name, uri: input.uri });
      } else {
        draft.pins = draft.pins.filter(p => p.integrationAttemptId !== undefined
          || !(p.ownerId === input.ownerId && p.teamId === input.teamId && p.name === input.name));
      }
      const text = JSON.stringify(schema.parse(draft));
      if (Buffer.byteLength(text) > 4 * 1024 ** 2) {
        throw new WorkerError('retention_capacity', 'Evidence metadata exceeds its 4 MiB UTF-8 limit. Release completed consumers or shorten their names/URIs before adding another pin.');
      }
      const commit = async (): Promise<void> => {
        await atomicWrite(this.file, text, 0o600, guard); this.data = draft;
      };
      // Existing pins replay above. Admission for new pins is nonblocking so
      // this mutex never holds up the release needed to free a storage budget.
      if (input.action === 'pin' && publish) {
        await publish(commit);
      } else {
        await commit();
      }
      return { action: input.action, name: input.name, uri: input.uri };
    });
  }
  /** ONE durable ledger publication, optionally under the store write fence. */
  private async write(next: Data, guard: () => void, publish?: (commit: () => Promise<void>) => Promise<void>): Promise<void> {
    const text = JSON.stringify(schema.parse(next));
    if (Buffer.byteLength(text) > 4 * 1024 ** 2) {
      throw new WorkerError('retention_capacity', 'Evidence metadata exceeds its 4 MiB UTF-8 limit. Release completed consumers or shorten their names/URIs before adding another pin.');
    }
    const commit = async (): Promise<void> => {
      await atomicWrite(this.file, text, 0o600, guard); this.data = next;
    };
    // The injected publisher is the store's own write fence, so a caller never
    // holds a second storage lock of its own around this metadata write.
    if (publish) {
      await publish(commit);
    } else {
      await commit();
    }
  }
  /**
   * Adopt one integration attempt's COMPLETE evidence set atomically.
   *
   * `prepare` runs while the SAME mutex as withReferences is held, so no
   * collector can observe a partially validated or partially adopted set: it
   * must verify every exact resource (durable runner result ID/version/URI and
   * sealed submission identity) inside that lock before returning the exact
   * pins to protect. Those pins are adopted in ONE durable ledger write through
   * the injected storage-write publisher, so an interrupted write adopts
   * nothing and a replay of the same attempt+name+URI writes nothing at all.
   */
  async pinIntegration(attemptId: string, prepare: (guard: () => void) => Promise<readonly IntegrationPin[]>,
    guard: () => void, publish?: (commit: () => Promise<void>) => Promise<void>): Promise<IntegrationPinResult> {
    const id = integrationAttemptId(attemptId);
    return this.mutex.run(async () => {
      guard();
      const data = await this.open(); guard();
      // Validation of every exact result happens HERE, still inside the mutex.
      const requested = await prepare(guard); guard();
      if (!Array.isArray(requested)) {
        throw new WorkerError('retention_invalid', 'prepare() must return an array of evidence pins.');
      }
      if (requested.length > 1024) {
        throw new WorkerError('retention_capacity', '1024 evidence pins are retained. Release completed consumers explicitly before adding another.');
      }
      const pins = requested.map(integrationPin);
      const draft = structuredClone(data);
      const adopted: string[] = [];
      const replayed: string[] = [];
      for (const pin of pins) {
        const existing = draft.pins.find(p => p.integrationAttemptId === id && p.name === pin.name);
        if (existing !== undefined) {
          if (existing.uri !== pin.uri || existing.ownerId !== pin.ownerId || existing.teamId !== pin.teamId) {
            throw new WorkerError('retention_conflict', `Integration attempt ${id} already protects a different exact resource as ${JSON.stringify(pin.name)}.`);
          }
          replayed.push(pin.name);
          continue;
        }
        if (draft.pins.length >= 1024) {
          throw new WorkerError('retention_capacity', '1024 evidence pins are retained. Release completed consumers explicitly before adding another.');
        }
        draft.pins.push({ ...pin, integrationAttemptId: id });
        adopted.push(pin.name);
      }
      if (adopted.length > 0) {
        await this.write(draft, guard, publish);
      }
      return { adopted, replayed, pins };
    });
  }
  /** Removes exactly this attempt's protected pins; naturally idempotent. */
  async releaseIntegration(attemptId: string, guard: () => void,
    publish?: (commit: () => Promise<void>) => Promise<void>): Promise<{ released: number; names: string[] }> {
    const id = integrationAttemptId(attemptId);
    return this.mutex.run(async () => {
      guard();
      const data = await this.open(); guard();
      const names = data.pins.filter(p => p.integrationAttemptId === id).map(p => p.name);
      if (names.length === 0) {
        return { released: 0, names };
      }
      const draft = structuredClone(data);
      draft.pins = draft.pins.filter(p => p.integrationAttemptId !== id);
      await this.write(draft, guard, publish);
      return { released: names.length, names };
    });
  }
  /** Holds the pin mutex through deletion so consumers cannot race GC. */
  async withReferences<T>(action: (uris: Set<string>) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => action(new Set((await this.open()).pins.map(p => p.uri))));
  }
}
