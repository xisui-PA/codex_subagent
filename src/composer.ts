import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Mutex } from './storage';
import { failure, WorkerError } from './types';

const operationSchema = z.object({ requestId: z.string().uuid(), action: z.enum(['send', 'resume']), draft: z.string().max(200_000), message: z.string().max(200_000).optional(), model: z.string().max(500).optional() });
const savedSchema = z.object({ draft: z.string().max(200_000), pending: operationSchema.optional(), error: z.string().optional() });
export type ComposerOperation = z.infer<typeof operationSchema>;
export type SavedComposer = z.infer<typeof savedSchema>;
export interface ComposerState extends SavedComposer { busy: boolean }
export interface ComposerStorage { load(): unknown; save(state: SavedComposer): Promise<void> }

/** One instance per worker, shared by successive panels. Persist before RPC;
 * only a successful acknowledgement clears the original idempotency key. */
export class WorkerComposer {
  private saved: SavedComposer;
  private readonly mutex = new Mutex();
  private inFlight?: Promise<void>;
  private runtimeError?: string;
  private readonly listeners = new Set<(state: ComposerState) => void>();
  constructor(private readonly storage: ComposerStorage) {
    const loaded = savedSchema.safeParse(storage.load());
    this.saved = loaded.success ? loaded.data : { draft: '' };
  }
  state(): ComposerState {
    return structuredClone({ ...this.saved, error: this.runtimeError || this.saved.error, busy: !!this.inFlight });
  }
  subscribe(listener: (state: ComposerState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) {
      listener(this.state());
    }
  }
  private async commit(state: SavedComposer): Promise<void> {
    await this.storage.save(structuredClone(state)); this.saved = state; this.runtimeError = undefined;
  }
  async draft(text: string): Promise<void> {
    z.string().max(200_000).parse(text);
    await this.mutex.run(async () => {
      try {
        // Draft echoes can overwrite keystrokes typed while a save is pending.
        // The panel already has this text; publish only operation transitions.
        await this.commit({ ...this.saved, draft: text });
      } catch (error) {
        this.saved = { ...this.saved, draft: text };
        this.runtimeError = failure(error).message; this.changed(); throw error;
      }
    });
  }
  async submit(input: { action: 'send' | 'resume'; draft: string; model?: string }, perform: (operation: ComposerOperation) => Promise<void>): Promise<void> {
    const candidate = operationSchema.parse({ requestId: randomUUID(), ...input, message: input.draft.trim() || undefined });
    if (candidate.action === 'send' && !candidate.message) {
      throw new WorkerError('invalid_arguments', 'Enter a follow-up message.');
    }
    const { promise } = await this.mutex.run(async () => {
      const pending = this.saved.pending;
      if (pending && (pending.action !== candidate.action || pending.message !== candidate.message || pending.model !== candidate.model)) {
        throw new WorkerError('pending_message', 'Retry the pending request or clear its retry record before starting another operation.');
      }
      return this.begin(pending || candidate, perform);
    });
    await promise;
  }
  async retry(perform: (operation: ComposerOperation) => Promise<void>): Promise<void> {
    const registration = await this.mutex.run(async () => {
      if (!this.saved.pending) {
        this.changed(); return undefined;
      }
      return this.begin(this.saved.pending, perform);
    });
    await registration?.promise;
  }
  private async begin(operation: ComposerOperation, perform: (operation: ComposerOperation) => Promise<void>): Promise<{ promise: Promise<void> }> {
    if (this.inFlight) {
      return { promise: this.inFlight };
    }
    try {
      await this.commit({ draft: this.saved.pending ? this.saved.draft : operation.draft, pending: operation });
    } catch (error) {
      // No RPC was sent, but retain the draft/key in memory for a storage retry.
      this.saved = { draft: operation.draft, pending: operation };
      this.runtimeError = failure(error).message; this.changed(); throw error;
    }
    const promise = Promise.resolve().then(async () => {
      let error: string | undefined;
      try {
        await perform(operation);
      } catch (problem) {
        error = failure(problem).message;
      }
      await this.mutex.run(async () => {
        await this.commit(error ? { ...this.saved, error } : { draft: this.saved.draft === operation.draft ? '' : this.saved.draft });
      });
    }).catch(error => {
      // An acknowledgement that cannot be saved is still retryable with the
      // persisted key. Never pretend the operation was rejected by the host.
      this.runtimeError = failure(error).message;
    }).finally(() => {
      this.inFlight = undefined; this.changed();
    });
    this.inFlight = promise; this.changed(); return { promise };
  }
  async clearPending(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.inFlight) {
        throw new WorkerError('worker_busy', 'Wait for the pending request before clearing its retry record.');
      }
      await this.commit({ draft: this.saved.draft }); this.changed();
    });
  }
}
