import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, Mutex } from './storage';
import { WorkerError } from './types';

const scope = { ownerId: z.string().min(1).max(200), teamId: z.string().regex(/^[a-f0-9]{32}$/) };
const schema = z.strictObject({ schema: z.literal(1), pins: z.array(z.strictObject({ ...scope, name: z.string().min(1).max(128), uri: z.string().min(1).max(2048) })).max(1024) });
type Data = z.infer<typeof schema>;
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
      const existing = data.pins.find(p => p.ownerId === input.ownerId && p.teamId === input.teamId && p.name === input.name);
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
        draft.pins = draft.pins.filter(p => !(p.ownerId === input.ownerId && p.teamId === input.teamId && p.name === input.name));
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
  /** Holds the pin mutex through deletion so consumers cannot race GC. */
  async withReferences<T>(action: (uris: Set<string>) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => action(new Set((await this.open()).pins.map(p => p.uri))));
  }
}
