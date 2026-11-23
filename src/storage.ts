import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { startupSchema, scheduleWaitSchema } from './worker-startup';
import { waitingReasons } from './worker-startup';
import { ChangeContent, Message, Session, SessionHeader, Turn, WorkerError } from './types';

const callSchema = z.object({ type: z.literal('call'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) });
const partSchema = z.discriminatedUnion('type', [callSchema, z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('result'), id: z.string(), text: z.string() })]);
const stateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
const failureSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() });
/** Current session modes are explicit, required and never defaulted. */
const sessionModes = ['standalone', 'isolated', 'governed'] as const;
const sessionSchema = z.object({
  schema: z.literal(3), mode: z.enum(sessionModes), id: z.string().regex(/^[a-f0-9]{32}$/), title: z.string(), instructions: z.string(),
  model: z.object({ id: z.string(), name: z.string(), vendor: z.string(), family: z.string(), version: z.string(), maxInputTokens: z.number().positive() }),
  permission: z.enum(['read-only', 'workspace-write']), state: stateSchema,
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), parts: z.array(partSchema), peerNotices: z.array(z.object({ id: z.string().min(1).max(256), teamId: z.string().min(1).max(256) })).max(64).optional() })),
  turns: z.array(z.object({ id: z.string(), input: z.string(), state: stateSchema, started: z.boolean(), attempts: z.number().int().nonnegative(), output: z.string(), archived: z.boolean().optional(), error: failureSchema.optional(), attemptsLog: z.array(z.object({ attempt: z.number().int(), output: z.string(), error: failureSchema.optional(), endedAt: z.string() })).optional(), tools: z.array(z.object({ call: callSchema, state: z.enum(['started', 'completed', 'uncertain']), result: z.string().optional() })), createdAt: z.string(), updatedAt: z.string() })).min(1),
  operations: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({ fingerprint: z.string(), turnId: z.string() })),
  summary: z.object({ text: z.string(), through: z.number().int().nonnegative() }).optional(), revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string()
  , ownerId: z.string().optional(), ownerLabel: z.string().optional(), parentPolicy: z.enum(['keep', 'cancel-on-expiry']).optional(), parentExpiresAt: z.number().optional(), parentLeaseSeconds: z.number().optional(), maintenanceError: failureSchema.optional(), workspaceRoot: z.string().optional(), activity: z.string().optional(),
  messageBase: z.number().int().nonnegative().optional(), archives: z.array(z.object({ id: z.string().uuid(), firstMessage: z.number().int().nonnegative(), messageCount: z.number().int().nonnegative(), createdAt: z.string() })).optional(),
  maintenance: z.object({ kind: z.enum(['revert', 'isolation', 'compact']), previousState: stateSchema }).optional(),
  isolatedView: z.strictObject({ teamId: z.string().regex(/^[a-f0-9]{32}$/), snapshotId: z.string().regex(/^[a-f0-9]{64}$/), overlayId: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  startup: startupSchema.optional(), scheduleWait: scheduleWaitSchema.optional(), scheduleWaitRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), waitingReason: z.enum(waitingReasons).optional(),
  changes: z.array(z.object({ id: z.string().uuid(), path: z.string(), target: z.string().optional(), kind: z.enum(['write', 'delete', 'rename']), state: z.enum(['pending', 'applied', 'reverted']), createdAt: z.string() })).optional()
}).refine(session => {
  // The explicit mode - never the fields that happen to be present - decides
  // which invariant must hold, so no record is inferred or silently upgraded.
  if (session.mode === 'standalone') {
    return session.isolatedView === undefined && session.startup === undefined;
  }
  const scope = !!session.ownerId && session.ownerId.length <= 200 && !!session.workspaceRoot && path.isAbsolute(session.workspaceRoot);
  if (session.mode === 'isolated') {
    return scope && session.isolatedView !== undefined && session.startup === undefined;
  }
  if (!scope || !session.startup) {
    return false;
  }
  if (session.isolatedView && (session.isolatedView.snapshotId !== session.startup.snapshotId || session.isolatedView.teamId !== session.startup.teamId)) {
    return false;
  }
  return ['created', 'assigned', 'cancelled'].includes(session.startup.phase) || session.isolatedView !== undefined;
}, 'Session format 3 requires an explicit mode: standalone forbids a private binding and startup, isolated requires its permanent view plus a bounded owner and absolute root, and governed requires governed setup with owner/root and a matching view before readiness. Older formats are unsupported.');
/**
 * Bounded intent for one accepted governed request whose worker checkpoint does
 * not exist yet. It is the only durable record of that request's identity, its
 * exact argument fingerprint and its original parent lease, so an aborted
 * transport, a host reload or a crash cannot hand the same request a fresh
 * lease, accept changed arguments for it, or let a legacy spawn take its
 * identity while its first capacity wait is still pending.
 */
const startupIntentSchema = z.strictObject({
  ownerId: z.string().min(1).max(200), requestId: z.string().min(1).max(200), workspaceRoot: z.string().min(1).max(1024),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), policy: z.enum(['keep', 'cancel-on-expiry']),
  lane: z.enum(['work', 'validation', 'integration']), leaseSeconds: z.number().int().min(1).max(86_400),
  expiresAt: z.number().nonnegative().optional(), at: z.number().int().nonnegative()
}).refine(intent => intent.policy === 'keep' ? intent.expiresAt === undefined : intent.expiresAt !== undefined,
  'A pending cancel-on-expiry startup records its effective deadline; a kept startup records none.');
export type StartupIntent = z.infer<typeof startupIntentSchema>;
const startupIntentsSchema = z.strictObject({ schema: z.literal(1), requests: z.array(startupIntentSchema).max(64) });
/**
 * Bounded metadata: at most 64 small records, never a payload, and a capped file
 * whose write bound equals its read bound. Four entries stay reachable for
 * coordinator service lanes, and a kept intent has no deadline: only a parent
 * stop or the request's own checkpoint frees it, so age never abandons work.
 */
const startupIntentLimits = { requests: 64, work: 60, bytes: 128 * 1024 };

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function atomicWrite(file: string, text: string | Uint8Array, mode = 0o600, beforeRename?: () => void): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  // The rename is the single publication point, so a resolved atomicWrite is an
  // unambiguous commit: afterwards the temporary path no longer exists and
  // cleanup has nothing left to fail on. Callers that treat resolution as
  // durability depend on exactly that.
  let published = false;
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(text, 'utf8'); await handle.sync();
    } finally {
      await handle.close();
    }
    beforeRename?.();
    await fs.rename(temporary, file);
    published = true;
    // Flush the rename too. Some platforms do not support directory fsync.
    try {
      const directory = await fs.open(path.dirname(file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch { /* The atomic rename still protects readers on Windows. */ }
  } finally {
    if (!published) {
      await fs.rm(temporary, { force: true });
    }
  }
}

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class SessionStore {
  /** Owner hook: publish retained-byte accounting after durable checkpoint adoption. */
  onCheckpoint?: (session: Session) => Promise<void>;
  /** Runs under the exclusive store owner and mutation mutex, before any checkpoint bytes change. */
  onWrite?: <T>(session: Session | undefined, action: () => Promise<T>) => Promise<T>;
  private write<T>(session: Session | undefined, action: () => Promise<T>): Promise<T> {
    return this.onWrite ? this.onWrite(session, action) : action();
  }
  /** Innermost filesystem phase only; never hold this mutex across approval or pool admission. */
  async withStorageWrite<T>(action: () => Promise<T>): Promise<T> {
    return this.mutex.run(() => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Storage mutation requires the exclusive store owner.');
      }
      return this.write(undefined, action);
    });
  }
  /** Durable opt-in history survives deleting workers and collecting request payloads. */
  async hasGovernedHistory(): Promise<boolean> {
    if (this.list().some(session => !!session.startup)) {
      return true;
    }
    for (const name of ['retired-workers', 'retired-worker-identities.json', 'retired-worker-identities.json.namespace']) {
      if (await fs.lstat(path.join(this.directory, name)).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        } throw error;
      })) {
        return true;
      }
    }
    return false;
  }
  private readonly sessions = new Map<string, Session>();
  /** Durable governed-request fence mirror, published under the same mutex as every retirement. */
  private readonly retiredStartups = new Set<string>();
  private retiredFenceError?: WorkerError;
  /**
   * Accepted pre-creation requests, mirrored from disk under the same mutex as
   * every retirement. Bounded, so this metadata never becomes a transcript.
   */
  private readonly startupIntents = new Map<string, StartupIntent>();
  private startupIntentError?: WorkerError;
  private readonly mutex = new Mutex();
  private lock?: string;
  readonly diagnostics: string[] = [];
  constructor(readonly directory: string) {}

  /** Read-only browsing of a removed folder; atomic checkpoints need no lock. */
  static async saved(directory: string): Promise<Session[]> {
    const sessions: Session[] = [];
    for (const file of await fs.readdir(directory).catch(() => [])) {
      if (/^[a-f0-9]{32}\.json$/.test(file)) {
        const session = await fs.readFile(path.join(directory, file), 'utf8').then(s => sessionSchema.parse(JSON.parse(s))).catch(() => undefined);
        if (session && `${session.id}.json` === file) {
          sessions.push(session);
        }
      }
    }
    return sessions;
  }

  async importSession(source: string, session: Session): Promise<void> {
    const existing = this.sessions.get(session.id);
    if (existing && digest(existing) !== digest(session)) {
      throw new WorkerError('migration_conflict', `Conflicting worker ${session.id}; both stored copies have been preserved.`);
    }
    for (const kind of ['archives', 'changes']) {
      const from = path.join(source, kind, session.id);
      for (const file of await fs.readdir(from).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        } throw error;
      })) {
        const text = await fs.readFile(path.join(from, file), 'utf8');
        const to = path.join(this.directory, kind, session.id, file);
        const copied = await fs.readFile(to, 'utf8').catch(() => undefined);
        if (copied !== undefined && copied !== text) {
          throw new WorkerError('migration_conflict', `Conflicting snapshot ${file}; both copies have been preserved.`);
        }
        if (copied === undefined) {
          await atomicWrite(to, text);
        }
      }
    }
    if (!existing) {
      await this.create(session);
      // Flush the checkpoint's directory entry before its source can be deleted.
      await atomicWrite(path.join(this.directory, `${session.id}.json`), JSON.stringify(session));
    }
  }

  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockFile = path.join(this.directory, 'owner.lock');
    const claim = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    try {
      await fs.writeFile(lockFile, claim, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      // Reclamation must itself be exclusive: two windows that saw a dead PID
      // must not each remove the other's newly acquired owner lock.
      const recoveryFile = `${lockFile}.recovery`;
      const recovery = await fs.open(recoveryFile, 'wx', 0o600).catch(() => {
        throw new WorkerError('workspace_locked', `Workspace recovery is locked: ${recoveryFile}. If all worker windows are closed after a crash, remove this recovery file.`);
      });
      try {
        let owner: { pid: number };
        try {
          owner = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { pid: number };
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
            throw new Error('Invalid lock PID');
          }
        } catch {
          throw new WorkerError('workspace_locked', `Cannot read workspace lock ${lockFile}. Close other extension hosts before removing it.`);
        }
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (alive) {
          throw new WorkerError('workspace_locked', 'Another VS Code window owns these worker sessions. Use that window or close it first.');
        }
        await fs.rm(lockFile);
        await fs.writeFile(lockFile, claim, { flag: 'wx', mode: 0o600 });
      } finally {
        await recovery.close(); await fs.rm(recoveryFile, { force: true });
      }
    }
    this.lock = claim;
    await this.loadStartupFence();
    await this.loadStartupIntents();
    this.sessions.clear(); this.diagnostics.length = 0;
    try {
      for (const file of await fs.readdir(this.directory)) {
        if (!/^[a-f0-9]{32}\.json$/.test(file)) {
          continue;
        }
        let s: Session;
        try {
          s = sessionSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8')));
          if (`${s.id}.json` !== file || (s.summary?.through || 0) > s.messages.length) {
            throw new WorkerError('session_malformed', 'Unrecognized session format');
          }
        } catch (error) {
          if (!(error instanceof SyntaxError || error instanceof z.ZodError || error instanceof WorkerError && error.code === 'session_malformed')) {
            throw error;
          }
          const quarantine = path.join(this.directory, 'quarantine', file);
          await fs.mkdir(path.dirname(quarantine), { recursive: true, mode: 0o700 });
          await fs.copyFile(path.join(this.directory, file), quarantine, 1).catch(() => undefined);
          this.diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        this.sessions.set(s.id, s);
        if (s.state === 'running' || s.state === 'queued') {
          await this.change(s.id, draft => {
            if (draft.maintenance) {
              if (draft.maintenance.kind === 'compact') {
                draft.state = draft.maintenance.previousState; draft.maintenance = undefined;
                draft.activity = 'Manual compaction interrupted; inspect retained history';
                draft.maintenanceError = { code: 'compaction_interrupted', message: 'Manual compaction was interrupted. Inspect the retained history/archive before explicitly compacting again; no effects were replayed.', retryable: true };
                return;
              }
              const isolated = draft.maintenance.kind === 'isolation';
              draft.state = draft.maintenance.previousState;
              draft.activity = isolated ? 'Private view binding interrupted; inspect and retry' : 'Revert interrupted; inspect saved changes';
              draft.maintenanceError = { code: 'edit_interrupted', message: isolated
                ? 'Private view maintenance was interrupted. Inspect the saved binding and retry the same request; marked workers cannot use live workspace files.'
                : 'A Revert was interrupted by host restart. Inspect its pending change snapshot and current file contents before repeating it.', retryable: true };
              draft.maintenance = undefined;
              return;
            }
            draft.state = draft.turns.every(t => t.state === 'completed') ? 'completed' : 'interrupted';
            draft.activity = draft.state === 'completed' ? 'History compaction interrupted; original task complete' : 'Interrupted by host restart';
            if (draft.state === 'completed') {
              draft.maintenanceError = { code: 'host_restarted', message: 'History compaction was interrupted. The original task and history are preserved.', retryable: true };
            }
            for (const turn of draft.turns) {
              if (turn.state === 'running' || turn.state === 'queued') {
                turn.state = 'interrupted';
                turn.error = { code: 'host_restarted', message: 'VS Code restarted. Call subagent_resume to continue from the checkpoint.', retryable: true };
              }
              for (const tool of turn.tools) {
                if (tool.state === 'started') {
                  tool.state = 'uncertain';
                }
              }
            }
          });
        }
      }
      // A checkpoint that already owns one of these identities finished the
      // request, so its leftover intent no longer gates anything. Drop it in
      // memory here; the next publication writes the truth and a reload would
      // prune it again. No I/O runs during open().
      for (const [id] of this.startupIntents) {
        if (this.sessions.has(id)) {
          this.startupIntents.delete(id);
        }
      }
    } catch (error) {
      await this.close(); throw error;
    }
  }

  all(): Session[] {
    return [...this.sessions.values()].map(s => structuredClone(s));
  }
  list(): SessionHeader[] {
    return [...this.sessions.values()].map(sessionHeader);
  }
  findOperation(key: string): Session | undefined {
    const session = [...this.sessions.values()].find(s => s.operations[key]);
    return session ? structuredClone(session) : undefined;
  }
  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new WorkerError('not_found', `Worker ${id} was not found in this workspace.`);
    }
    return structuredClone(session);
  }
  async create(session: Session): Promise<void> {
    await this.mutex.run(async () => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Session store is not owned by this host.');
      }
      const retiredIdentities = await this.retiredIdentities();
      // Fail closed for every create when the bounded pre-creation metadata
      // cannot be read: a lost identity record must never be replaced silently.
      if (this.startupIntentError) {
        throw this.startupIntentError;
      }
      if (retiredIdentities.has(session.id) || await fs.lstat(path.join(this.directory, 'retired-workers', session.id + '.json')).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        } throw error;
      })) {
        throw new WorkerError('request_expired', 'This governed worker request was retired. Its effects must not be repeated as a fresh spawn.');
      }
      if (session.startup) {
        await this.assertRetirementCapacity(session.id, retiredIdentities);
      }
      if (this.sessions.has(session.id)) {
        throw new WorkerError('conflict', 'Worker already exists.');
      }
      if (!session.startup && this.startupIntents.has(session.id)) {
        // A legacy create must never adopt an identity that a governed request
        // already accepted: the pending intent owns that lease and its retry.
        throw new WorkerError('request_expired', 'A governed startup request holds this identity until its worker is created or its lease is retired. Finish, retire or expire that request; a legacy spawn cannot take its identity.');
      }
      return this.write(session, async () => {
        const handle = await fs.open(path.join(this.directory, `${session.id}.json`), 'wx', 0o600).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new WorkerError('session_unreadable', 'This worker ID already has a transcript on disk. It has been preserved; inspect Diagnostics/quarantine or use a new requestId.');
          }
          throw error;
        });
        try {
          await handle.writeFile(JSON.stringify(session)); await handle.sync();
        } finally {
          await handle.close();
        }
        this.sessions.set(session.id, structuredClone(session));
        await this.onCheckpoint?.(session);
      });
    });
  }
  async change(id: string, update: (draft: Session) => void, authorize?: () => void): Promise<Session> {
    return this.mutex.run(async () => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Session store is not owned by this host.');
      }
      authorize?.();
      const draft = this.get(id);
      update(draft);
      draft.revision++;
      draft.updatedAt = new Date().toISOString();
      return this.write(draft, async () => {
        await atomicWrite(path.join(this.directory, `${id}.json`), JSON.stringify(draft), 0o600, authorize);
        this.sessions.set(id, draft);
        await this.onCheckpoint?.(draft);
        return structuredClone(draft);
      });
    });
  }
  /** Compacted identities remain reserved across APIs after request payload expiry. */
  private async retiredIdentities(): Promise<Set<string>> {
    const file = path.join(this.directory, 'retired-worker-identities.json');
    const marker = file + '.namespace';
    const markerText = JSON.stringify({ schema: 1, kind: 'retired-worker-identities' });
    const read = async (at: string, limit: number): Promise<string | undefined> => {
      const stat = await fs.lstat(at).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        } throw error;
      });
      if (!stat) {
        return undefined;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
        throw new WorkerError('retention_corrupt', 'Restore the bounded plain retired-worker identity metadata at ' + at);
      }
      return fs.readFile(at, 'utf8');
    };
    const namespace = await read(marker, 256);
    if (namespace !== undefined && namespace !== markerText) {
      throw new WorkerError('retention_corrupt', 'Retired-worker identity namespace changed; restore its original metadata.');
    }
    const text = await read(file, 256 * 1024);
    if (text === undefined) {
      if (namespace !== undefined) {
        throw new WorkerError('retention_corrupt', 'Restore missing retired-worker-identities.json; retired worker identities cannot be reset.');
      }
      return new Set();
    }
    let ids: string[];
    try {
      ids = z.strictObject({ schema: z.literal(1), ids: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(4096) }).parse(JSON.parse(text)).ids;
    } catch (error) {
      throw new WorkerError('retention_corrupt', 'Restore retired-worker-identities.json: ' + String(error));
    }
    if (namespace === undefined) {
      await atomicWrite(marker, markerText);
    }
    return new Set(ids);
  }
  private async assertRetirementCapacity(id: string, identities?: Set<string>): Promise<void> {
    const retained = new Set(identities ?? await this.retiredIdentities());
    const names = await fs.readdir(path.join(this.directory, 'retired-workers')).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      } throw error;
    });
    let unknown = 0;
    for (const name of names) {
      if (/^[a-f0-9]{32}\.json$/.test(name)) {
        retained.add(name.slice(0, -5));
      } else {
        unknown++;
      }
    }
    if (!retained.has(id) && retained.size + unknown >= 4096) {
      throw new WorkerError('receipt_capacity', '4096 immutable retired-worker identities are retained. Export this namespace for an operator-managed migration before creating or retiring more governed workers; rollover cannot permit identity reuse. Inspect unknown retirement files before migration.');
    }
  }
  /** One identity for a governed request: its deterministic session id, tombstone name and fence key. */
  private startupIdentity(ownerId: string, requestId: string, workspaceRoot: string): string {
    return digest([digest([ownerId, requestId]), workspaceRoot]).slice(0, 32);
  }
  /**
   * Durable ownership fence for a governed startup request. create() enforces it
   * for a new worker, but a retry that finds an unfinished checkpoint never
   * creates one, so it must consult the same fence before it advances any
   * incomplete phase or performs its first effect: the tombstone published by a
   * parent stop or expiry outlives a cancel phase checkpoint that failed to
   * commit. Synchronous by design, so callers keep it in the store mutation
   * authorize slot, which runs under the mutex and again before the durable
   * rename.
   */
  assertStartupLive(ownerId: string, requestId: string, workspaceRoot: string): void {
    if (this.retiredFenceError) {
      throw this.retiredFenceError;
    }
    if (this.retiredStartups.has(this.startupIdentity(ownerId, requestId, workspaceRoot))) {
      throw new WorkerError('request_expired', 'This governed worker request was retired, so its unfinished startup checkpoint cannot be advanced or repeated. Use a new requestId for new work.');
    }
  }
  /**
   * Loads the fence create() reads from disk, so a retry can evaluate it without
   * awaiting. Retirement metadata that cannot be read stays fail-closed when the
   * fence is consulted instead of blocking every reload of the store.
   */
  private async loadStartupFence(): Promise<void> {
    this.retiredStartups.clear(); this.retiredFenceError = undefined;
    try {
      const directory = path.join(this.directory, 'retired-workers');
      const names = await fs.readdir(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        } throw error;
      });
      for (const name of names) {
        if (/^[a-f0-9]{32}\.json$/.test(name)) {
          this.retiredStartups.add(name.slice(0, -5));
        }
      }
      for (const id of await this.retiredIdentities()) {
        this.retiredStartups.add(id);
      }
    } catch (error) {
      this.retiredFenceError = error instanceof WorkerError ? error : new WorkerError('retention_corrupt', `Retired worker identities cannot be read: ${String(error)}`);
    }
  }
  private async retireStartupLocked(ownerId: string, requestId: string, workspaceRoot: string): Promise<void> {
    if (!this.lock) {
      throw new WorkerError('store_closed', 'Session store is closed.');
    }
    const id = this.startupIdentity(ownerId, requestId, workspaceRoot);
    const directory = path.join(this.directory, 'retired-workers'); const file = path.join(directory, id + '.json');
    const text = JSON.stringify({ schema: 1, ownerId, requestId });
    const existing = await fs.readFile(file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      } throw error;
    });
    if (existing !== undefined) {
      if (existing !== text) {
        throw new WorkerError('retention_corrupt', 'Startup tombstone identity changed.');
      }
      // Adopt the durable record this host did not publish itself, so the
      // in-memory fence covers every tombstone already on disk.
      this.retiredStartups.add(id);
      return;
    }
    await this.assertRetirementCapacity(id);
    await atomicWrite(file, text);
    // Publish the bytes first: the in-memory fence can only ever be stricter.
    this.retiredStartups.add(id);
  }
  /**
   * Reserves one durable intent for an accepted governed request before its
   * first capacity wait. The reply carries the original effective deadline, so
   * a retry that finds this record continues the same lease instead of starting
   * a fresh one, and a retry with changed arguments is refused for the same
   * identity. An identity a checkpoint already owns hands off instead.
   */
  async beginStartupIntent(request: Omit<StartupIntent, 'at'>): Promise<{ expiresAt?: number; leaseSeconds: number }> {
    return this.mutex.run(async () => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Session store is not owned by this host.');
      }
      if (this.startupIntentError) {
        throw this.startupIntentError;
      }
      const id = this.startupIdentity(request.ownerId, request.requestId, request.workspaceRoot);
      const checkpoint = this.sessions.get(id);
      if (checkpoint) {
        // create() already committed this request, so the checkpoint owns the
        // lease. A leftover intent hands off here instead of gating new work.
        await this.dropStartupIntent(id);
        return { expiresAt: checkpoint.parentPolicy === 'cancel-on-expiry' ? checkpoint.parentExpiresAt : undefined,
          leaseSeconds: checkpoint.parentLeaseSeconds ?? request.leaseSeconds };
      }
      this.assertStartupLive(request.ownerId, request.requestId, request.workspaceRoot);
      const existing = this.startupIntents.get(id);
      if (existing) {
        if (existing.fingerprint !== request.fingerprint) {
          throw new WorkerError('idempotency_conflict', 'This governed startup request is already pending with different arguments. Retry it exactly as accepted, or use a new requestId for new work.');
        }
        if (existing.policy === 'cancel-on-expiry' && (existing.expiresAt ?? 0) < Date.now()) {
          // The original lease ended before any checkpoint existed. Retire the
          // identity so neither a retry nor a legacy spawn can adopt it.
          await this.retireStartupIntentsLocked(existing);
          throw new WorkerError('parent_expired', 'The original parent lease of this startup request expired before its worker was created. It was not repeated with a fresh lease; use a new requestId for new work.');
        }
        return { expiresAt: existing.expiresAt, leaseSeconds: existing.leaseSeconds };
      }
      if (this.overStartupIntentCapacity(this.startupIntents, request.lane)) {
        await this.reclaimStartupIntentsLocked();
        if (this.overStartupIntentCapacity(this.startupIntents, request.lane)) {
          throw new WorkerError('resource_queue_full', 'Pending governed startup intents are full for this root/lane ('
            + startupIntentLimits.requests + ' total, at most ' + startupIntentLimits.work + ' work). Finish, stop or expire retained requests; '
            + (startupIntentLimits.requests - startupIntentLimits.work) + ' entries stay reachable for validation/integration.');
        }
      }
      const draft = new Map(this.startupIntents);
      const record: StartupIntent = { ...request, at: Date.now() };
      draft.set(id, record);
      await this.publishStartupIntents(draft);
      return { expiresAt: record.expiresAt, leaseSeconds: record.leaseSeconds };
    });
  }
  /** Work lanes keep the last four durable entries reachable for service lanes. */
  private overStartupIntentCapacity(intents: Map<string, StartupIntent>, lane: StartupIntent['lane']): boolean {
    if (intents.size >= startupIntentLimits.requests) {
      return true;
    }
    return lane === 'work' && [...intents.values()].filter(intent => intent.lane === 'work').length >= startupIntentLimits.work;
  }
  /** Any persisted request of this owner that no checkpoint has consumed yet. */
  hasPendingStartup(ownerId: string): boolean {
    for (const intent of this.startupIntents.values()) {
      if (intent.ownerId === ownerId) {
        return true;
      }
    }
    return false;
  }
  /** Drops one intent once its checkpoint adopted the same policy and deadline. */
  async consumeStartupIntent(ownerId: string, requestId: string, workspaceRoot: string): Promise<void> {
    await this.mutex.run(async () => {
      if (!this.lock) {
        return;
      }
      await this.dropStartupIntent(this.startupIdentity(ownerId, requestId, workspaceRoot));
    });
  }
  /**
   * Retires ONE stranded pre-creation intent that no attempt can ever consume,
   * using the same bounded publication path as a consumed record.
   *
   * An earlier build wrote the intent before its own bind preflight refused, so
   * a kept record without a deadline outlived the refusal and gated metadata
   * maintenance for its owner. The retry that is refused for the exact same
   * accepted request may retire it, and ONLY that record: identity, argument
   * fingerprint, lane, policy and the written lease pair must all match, so
   * changed arguments still answer `changed` (the caller keeps its idempotency
   * error) and a renewed or shortened lease stays owned by its parent. A record
   * that matched this way already owns a durable request identity, so it is
   * retired through the ordinary tombstone fence: recycling that identity for a
   * different later request would break the restart contract. A refusal with no
   * such record still writes neither a pending slot nor a retirement id.
   */
  async retireStrandedStartupIntent(request: Omit<StartupIntent, 'at'>): Promise<'absent' | 'retired' | 'changed'> {
    return this.mutex.run(async () => {
      if (!this.lock) {
        return 'absent';
      }
      if (this.startupIntentError) {
        throw this.startupIntentError;
      }
      const id = this.startupIdentity(request.ownerId, request.requestId, request.workspaceRoot);
      const existing = this.startupIntents.get(id);
      if (existing === undefined || this.sessions.has(id)) {
        // No record, or a checkpoint already owns this identity.
        return 'absent';
      }
      if (existing.ownerId !== request.ownerId || existing.requestId !== request.requestId || existing.workspaceRoot !== request.workspaceRoot) {
        return 'absent';
      }
      if (existing.fingerprint !== request.fingerprint) {
        return 'changed';
      }
      if (existing.policy !== request.policy || existing.lane !== request.lane
        || existing.leaseSeconds !== request.leaseSeconds || existing.expiresAt !== request.expiresAt) {
        // A different policy, lane or lease is a different durable decision and
        // is never retired from here; an expired cancel-on-expiry record keeps
        // its own reclaim rule.
        return 'absent';
      }
      await this.retireStartupIntentsLocked(existing);
      return 'retired';
    });
  }
  /**
   * Renews every persisted pre-creation deadline of one parent, including
   * requests that a previous host accepted. A heartbeat is explicit coordinator
   * intent, so it renews even a record whose deadline already passed; starting
   * any effect stays fenced by beginStartupIntent and create().
   */
  async heartbeatStartupIntents(ownerId: string, leaseSeconds: number): Promise<void> {
    await this.mutex.run(async () => {
      if (!this.lock) {
        return;
      }
      if (this.startupIntentError) {
        throw this.startupIntentError;
      }
      const expiresAt = Date.now() + leaseSeconds * 1000;
      const draft = new Map(this.startupIntents);
      let changed = false;
      for (const [id, intent] of draft) {
        if (intent.ownerId === ownerId && intent.policy === 'cancel-on-expiry') {
          draft.set(id, { ...intent, leaseSeconds, expiresAt }); changed = true;
        }
      }
      if (changed) {
        await this.publishStartupIntents(draft);
      }
    });
  }
  /** Parent stop: retire every persisted request of this owner, reloaded or not. */
  async retireStartupIntents(ownerId: string): Promise<number> {
    return this.mutex.run(async () => {
      if (!this.lock) {
        return 0;
      }
      if (this.startupIntentError) {
        throw this.startupIntentError;
      }
      return this.sweepStartupIntentsLocked(intent => intent.ownerId === ownerId);
    });
  }
  /** Expiry sweep: a reloaded request never regains a lease it did not renew. */
  async expireStartupIntents(): Promise<number> {
    return this.mutex.run(async () => {
      if (!this.lock) {
        return 0;
      }
      if (this.startupIntentError) {
        throw this.startupIntentError;
      }
      return this.reclaimStartupIntentsLocked();
    });
  }
  /**
   * Capacity pressure and the routine expiry sweep share one rule: only an
   * expired cancel-on-expiry deadline proves a request abandoned. A kept intent
   * has no deadline and an explicitly renewed lease stays safe, so normal parent
   * stop or the request's own checkpoint frees them.
   */
  private async reclaimStartupIntentsLocked(): Promise<number> {
    const now = Date.now();
    return this.sweepStartupIntentsLocked(intent => intent.policy === 'cancel-on-expiry' && (intent.expiresAt ?? 0) < now);
  }
  /**
   * Mutex-only: retire or hand off every selected intent. A record whose identity
   * already owns a checkpoint is stale - create() committed it before the intent
   * handoff - so it hands off instead of tombstoning live work.
   */
  private async sweepStartupIntentsLocked(select: (intent: StartupIntent) => boolean): Promise<number> {
    const draft = new Map(this.startupIntents);
    let swept = 0;
    for (const [id, intent] of [...draft]) {
      if (!select(intent)) {
        continue;
      }
      if (!this.sessions.has(id)) {
        await this.retireStartupLocked(intent.ownerId, intent.requestId, intent.workspaceRoot);
      }
      draft.delete(id); swept++;
    }
    if (swept) {
      await this.publishStartupIntents(draft);
    }
    return swept;
  }
  /** Mutex-only: retire one persisted request through the existing tombstone fence. */
  private async retireStartupIntentsLocked(intent: StartupIntent): Promise<void> {
    await this.retireStartupLocked(intent.ownerId, intent.requestId, intent.workspaceRoot);
    await this.dropStartupIntent(this.startupIdentity(intent.ownerId, intent.requestId, intent.workspaceRoot));
  }
  /** Mutex-only: drop one intent through the same bounded publication path. */
  private async dropStartupIntent(id: string): Promise<void> {
    if (!this.startupIntents.has(id)) {
      return;
    }
    const draft = new Map(this.startupIntents);
    draft.delete(id);
    await this.publishStartupIntents(draft);
  }
  /**
   * Mutex-only: publish one bounded draft under the store write hook, then adopt
   * it. A failed durable action leaves the mirror untouched, so memory and disk
   * cannot disagree, and a write obeys the same byte bound as the read.
   */
  private async publishStartupIntents(draft: Map<string, StartupIntent>): Promise<void> {
    const file = path.join(this.directory, 'pending-startups.json');
    const text = draft.size ? JSON.stringify({ schema: 1, requests: [...draft.values()] }) : undefined;
    if (text !== undefined && Buffer.byteLength(text, 'utf8') > startupIntentLimits.bytes) {
      throw new WorkerError('receipt_capacity', 'Pending governed startup metadata would exceed its bounded '
        + startupIntentLimits.bytes + ' bytes. Stop or expire retained requests before accepting more.');
    }
    await this.write(undefined, async () => {
      if (text === undefined) {
        await fs.rm(file, { force: true });
      } else {
        await atomicWrite(file, text);
      }
      this.startupIntents.clear();
      for (const [id, intent] of draft) {
        this.startupIntents.set(id, intent);
      }
    });
  }
  /**
   * Loads the bounded intents of a previous host. A record already fenced by a
   * retirement tombstone is dropped from the mirror, while a record that cannot
   * be read keeps every later create fail-closed.
   */
  private async loadStartupIntents(): Promise<void> {
    this.startupIntents.clear(); this.startupIntentError = undefined;
    const file = path.join(this.directory, 'pending-startups.json');
    try {
      const stat = await fs.lstat(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        } throw error;
      });
      if (!stat) {
        return;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > startupIntentLimits.bytes) {
        throw new WorkerError('retention_corrupt', 'Restore bounded plain pending-startup metadata at ' + file);
      }
      for (const request of startupIntentsSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))).requests) {
        const id = this.startupIdentity(request.ownerId, request.requestId, request.workspaceRoot);
        if (this.retiredStartups.has(id)) {
          continue;
        }
        this.startupIntents.set(id, request);
      }
    } catch (error) {
      this.startupIntents.clear();
      this.startupIntentError = error instanceof WorkerError ? error : new WorkerError('retention_corrupt', `Pending startup metadata cannot be read: ${String(error)}`);
    }
  }
  async retireStartup(ownerId: string, requestId: string, workspaceRoot: string): Promise<void> {
    await this.mutex.run(async () => {
      await this.retireStartupLocked(ownerId, requestId, workspaceRoot);
      // A retired request can never be handed off, so its bounded pre-creation
      // intent leaves the mirror once the tombstone is durable.
      await this.dropStartupIntent(this.startupIdentity(ownerId, requestId, workspaceRoot));
    });
  }
  async collectRetired(ownerId: string, epoch: number): Promise<number> {
    return this.mutex.run(async () => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Session store is closed.');
      }
      if (!epoch) {
        return 0;
      }
      const directory = path.join(this.directory, 'retired-workers');
      const names = await fs.readdir(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        } throw error;
      });
      const identities = await this.retiredIdentities();
      const expired: string[] = [];
      for (const name of names) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) {
          continue;
        }
        const file = path.join(directory, name); const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) {
          continue;
        }
        const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { schema: number; ownerId: string; requestId: string };
        if (raw.schema === 1 && raw.ownerId === ownerId && typeof raw.requestId === 'string' && !raw.requestId.startsWith('e' + epoch + ':')
          && !this.startupIntents.has(name.slice(0, -5))) {
          identities.add(name.slice(0, -5)); expired.push(file);
        }
      }
      if (identities.size > 4096) {
        throw new WorkerError('receipt_capacity', 'Retired-worker immutable identity capacity is exhausted. Preserve these tombstones and export this namespace for an operator-managed migration.');
      }
      if (expired.length) {
        // Publish the identity fence before removing any request payload. A
        // retry after interruption safely sees both forms or the compact form.
        const file = path.join(this.directory, 'retired-worker-identities.json');
        await atomicWrite(file, JSON.stringify({ schema: 1, ids: [...identities].sort() }));
        await atomicWrite(file + '.namespace', JSON.stringify({ schema: 1, kind: 'retired-worker-identities' }));
        for (const file of expired) {
          await fs.unlink(file);
        }
      }
      return expired.length;
    });
  }
  async remove(id: string): Promise<void> {
    await this.mutex.run(async () => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Session store is not owned by this host.');
      }
      const retired = this.get(id);
      return this.write(retired, async () => {
        if (retired.startup) {
          const directory = path.join(this.directory, 'retired-workers');
          await this.assertRetirementCapacity(id);
          await atomicWrite(path.join(directory, id + '.json'), JSON.stringify({ schema: 1, ownerId: retired.ownerId, requestId: retired.startup.requestId }));
          this.retiredStartups.add(id);
        }
        await fs.rm(path.join(this.directory, `${id}.json`));
        await fs.rm(path.join(this.directory, 'archives', id), { recursive: true, force: true });
        await fs.rm(path.join(this.directory, 'changes', id), { recursive: true, force: true });
        this.sessions.delete(id);
        await this.onCheckpoint?.(retired);
      });
    });
  }
  async archive(id: string, summary: string): Promise<Session> {
    // Write the immutable archive first. A crash before the session pointer commit
    // leaves an orphan copy, never a missing or truncated transcript.
    return this.mutex.run(async () => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Store is closed.');
      }
      const s = this.get(id);
      return this.write(s, async () => {
        const archiveId = randomUUID();
        await atomicWrite(path.join(this.directory, 'archives', id, `${archiveId}.json`), JSON.stringify(s));
        (s.archives ||= []).push({ id: archiveId, firstMessage: s.messageBase || 0, messageCount: s.messages.length, createdAt: new Date().toISOString() });
        s.messageBase = (s.messageBase || 0) + s.messages.length;
        s.messages = [];
        s.summary = { text: summary, through: 0 };
        s.turns = s.turns.filter(t => t.state !== 'completed');
        // Keep a minimal completed marker when compacting an idle conversation.
        if (!s.turns.length) {
          const last = this.get(id).turns.at(-1)!; s.turns = [{ ...last, archived: true, output: last.output.slice(-4000), tools: [], attemptsLog: [] }];
        }
        for (const t of s.turns) {
          t.tools = t.tools.filter(tool => tool.state !== 'completed'); t.attemptsLog = [];
        }
        s.revision++; s.updatedAt = new Date().toISOString();
        await atomicWrite(path.join(this.directory, `${id}.json`), JSON.stringify(s));
        this.sessions.set(id, s);
        await this.onCheckpoint?.(s);
        return structuredClone(s);
      });
    });
  }
  async history(id: string, offset: number, limit: number): Promise<{ messages: Message[]; nextMessage: number | null }> {
    const s = this.get(id);
    const result: Message[] = [];
    let cursor = offset;
    let bytes = 0;
    const add = (messages: Message[], base: number): boolean => {
      for (let i = Math.max(0, cursor - base); i < messages.length; i++) {
        const size = Buffer.byteLength(JSON.stringify(messages[i]));
        if (result.length && (result.length >= limit || bytes + size > 1_000_000)) {
          return false;
        }
        result.push(messages[i]); bytes += size; cursor = base + i + 1;
      }
      return true;
    };
    for (const archive of s.archives || []) {
      if (cursor >= archive.firstMessage + archive.messageCount) {
        continue;
      }
      const old = await this.readArchive(id, archive.id);
      if (!add(old.messages, archive.firstMessage)) {
        return { messages: result, nextMessage: cursor };
      }
    }
    add(s.messages, s.messageBase || 0);
    return { messages: result, nextMessage: cursor < (s.messageBase || 0) + s.messages.length ? cursor : null };
  }
  async readArchive(id: string, archiveId: string): Promise<Session> {
    if (!this.get(id).archives?.some(a => a.id === archiveId)) {
      throw new WorkerError('not_found', 'Archive not found.');
    }
    return sessionSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, 'archives', id, `${archiveId}.json`), 'utf8')));
  }
  async turn(id: string, turnId: string, attempt?: number): Promise<Turn | undefined> {
    const s = this.get(id);
    const active = s.turns.find(t => t.id === turnId);
    if (active && !active.archived && (!attempt || attempt === active.attempts || active.attemptsLog?.some(a => a.attempt === attempt))) {
      return active;
    }
    for (const a of [...(s.archives || [])].reverse()) {
      const found = (await this.readArchive(id, a.id)).turns.find(t => t.id === turnId);
      if (found && !found.archived && (!attempt || found.attempts === attempt || found.attemptsLog?.some(a => a.attempt === attempt))) {
        return found;
      }
    }
    return undefined;
  }
  async recordChange(id: string, change: ChangeContent): Promise<void> {
    await this.withStorageWrite(() => atomicWrite(path.join(this.directory, 'changes', id, `${change.id}.json`), JSON.stringify(change)));
    await this.change(id, s => {
      const { before: _before, after: _after, ...metadata } = change; void _before; void _after; (s.changes ||= []).push(metadata);
    });
  }
  async finishChange(id: string, change: ChangeContent): Promise<void> {
    // Commit the actual editor after-image before publishing applied metadata.
    await this.withStorageWrite(() => atomicWrite(path.join(this.directory, 'changes', id, `${change.id}.json`), JSON.stringify(change)));
    await this.change(id, s => {
      const record = s.changes?.find(c => c.id === change.id);
      if (record) {
        record.state = 'applied';
      }
    });
  }
  async readChange(id: string, changeId: string): Promise<ChangeContent> {
    if (!this.get(id).changes?.some(c => c.id === changeId)) {
      throw new WorkerError('not_found', 'Change not found.');
    }
    return JSON.parse(await fs.readFile(path.join(this.directory, 'changes', id, `${changeId}.json`), 'utf8')) as ChangeContent;
  }
  async close(): Promise<void> {
    await this.mutex.run(async () => {
      const file = path.join(this.directory, 'owner.lock');
      if (this.lock && await fs.readFile(file, 'utf8').catch(() => '') === this.lock) {
        await fs.rm(file, { force: true });
      }
      this.lock = undefined;
    });
  }
}

export function sessionHeader(s: Session): SessionHeader {
  const turn = [...s.turns].reverse().find(t => t.started) || s.turns.at(-1);
  return { id: s.id, title: s.title, model: { ...s.model }, permission: s.permission, state: s.state, revision: s.revision, createdAt: s.createdAt, updatedAt: s.updatedAt, ownerId: s.ownerId, ownerLabel: s.ownerLabel, workspaceRoot: s.workspaceRoot, activity: s.activity, parentPolicy: s.parentPolicy, parentExpiresAt: s.parentExpiresAt, startup: s.startup, waitingReason: s.waitingReason, isolatedView: s.isolatedView ? { ...s.isolatedView } : undefined, lastTurnId: turn?.id, lastAttempt: turn?.attempts };
}
