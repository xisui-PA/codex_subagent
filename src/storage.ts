import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ChangeContent, Message, Session, SessionHeader, Turn, WorkerError } from './types';

const callSchema = z.object({ type: z.literal('call'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) });
const partSchema = z.discriminatedUnion('type', [callSchema, z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('result'), id: z.string(), text: z.string() })]);
const stateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
const failureSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() });
const sessionSchema = z.object({
  schema: z.literal(1), id: z.string().regex(/^[a-f0-9]{32}$/), title: z.string(), instructions: z.string(),
  model: z.object({ id: z.string(), name: z.string(), vendor: z.string(), family: z.string(), version: z.string(), maxInputTokens: z.number().positive() }),
  permission: z.enum(['read-only', 'workspace-write']), state: stateSchema,
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), parts: z.array(partSchema) })),
  turns: z.array(z.object({ id: z.string(), input: z.string(), state: stateSchema, started: z.boolean(), attempts: z.number().int().nonnegative(), output: z.string(), archived: z.boolean().optional(), error: failureSchema.optional(), attemptsLog: z.array(z.object({ attempt: z.number().int(), output: z.string(), error: failureSchema.optional(), endedAt: z.string() })).optional(), tools: z.array(z.object({ call: callSchema, state: z.enum(['started', 'completed', 'uncertain']), result: z.string().optional() })), createdAt: z.string(), updatedAt: z.string() })).min(1),
  operations: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({ fingerprint: z.string(), turnId: z.string() })),
  summary: z.object({ text: z.string(), through: z.number().int().nonnegative() }).optional(), revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string()
  , ownerId: z.string().optional(), ownerLabel: z.string().optional(), parentPolicy: z.enum(['keep', 'cancel-on-expiry']).optional(), parentExpiresAt: z.number().optional(), parentLeaseSeconds: z.number().optional(), maintenanceError: failureSchema.optional(), workspaceRoot: z.string().optional(), activity: z.string().optional(),
  messageBase: z.number().int().nonnegative().optional(), archives: z.array(z.object({ id: z.string().uuid(), firstMessage: z.number().int().nonnegative(), messageCount: z.number().int().nonnegative(), createdAt: z.string() })).optional(),
  maintenance: z.object({ kind: z.literal('revert'), previousState: stateSchema }).optional(),
  changes: z.array(z.object({ id: z.string().uuid(), path: z.string(), target: z.string().optional(), kind: z.enum(['write', 'delete', 'rename']), state: z.enum(['pending', 'applied', 'reverted']), createdAt: z.string() })).optional()
});

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function atomicWrite(file: string, text: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(text, 'utf8'); await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
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
    await fs.rm(temporary, { force: true });
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
  private readonly sessions = new Map<string, Session>();
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
    this.sessions.clear(); this.diagnostics.length = 0;
    try {
      for (const file of await fs.readdir(this.directory)) {
        if (!/^[a-f0-9]{32}\.json$/.test(file)) {
          continue;
        }
        try {
          const s = sessionSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8')));
          if (`${s.id}.json` !== file || (s.summary?.through || 0) > s.messages.length) {
            throw new Error('Unrecognized session format');
          }
          this.sessions.set(s.id, s);
          if (s.state === 'running' || s.state === 'queued') {
            await this.change(s.id, draft => {
              if (draft.maintenance?.kind === 'revert') {
                draft.state = draft.maintenance.previousState;
                draft.activity = 'Revert interrupted; inspect saved changes';
                draft.maintenanceError = { code: 'edit_interrupted', message: 'A Revert was interrupted by host restart. Inspect its pending change snapshot and current file contents before repeating it.', retryable: true };
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
        } catch (error) {
          this.sessions.delete(file.slice(0, -5));
          const quarantine = path.join(this.directory, 'quarantine', file);
          await fs.mkdir(path.dirname(quarantine), { recursive: true, mode: 0o700 });
          await fs.copyFile(path.join(this.directory, file), quarantine, 1).catch(() => undefined);
          this.diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
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
      if (this.sessions.has(session.id)) {
        throw new WorkerError('conflict', 'Worker already exists.');
      }
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
    });
  }
  async change(id: string, update: (draft: Session) => void): Promise<Session> {
    return this.mutex.run(async () => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Session store is not owned by this host.');
      }
      const draft = this.get(id);
      update(draft);
      draft.revision++;
      draft.updatedAt = new Date().toISOString();
      await atomicWrite(path.join(this.directory, `${id}.json`), JSON.stringify(draft));
      this.sessions.set(id, draft);
      return structuredClone(draft);
    });
  }
  async remove(id: string): Promise<void> {
    await this.mutex.run(async () => {
      if (!this.lock) {
        throw new WorkerError('store_closed', 'Session store is not owned by this host.');
      }
      this.get(id);
      await fs.rm(path.join(this.directory, `${id}.json`));
      await fs.rm(path.join(this.directory, 'archives', id), { recursive: true, force: true });
      await fs.rm(path.join(this.directory, 'changes', id), { recursive: true, force: true });
      this.sessions.delete(id);
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
      return structuredClone(s);
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
    await atomicWrite(path.join(this.directory, 'changes', id, `${change.id}.json`), JSON.stringify(change));
    await this.change(id, s => {
      const { before: _before, after: _after, ...metadata } = change; void _before; void _after; (s.changes ||= []).push(metadata);
    });
  }
  async finishChange(id: string, change: ChangeContent): Promise<void> {
    // Commit the actual editor after-image before publishing applied metadata.
    await atomicWrite(path.join(this.directory, 'changes', id, `${change.id}.json`), JSON.stringify(change));
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
  return { id: s.id, title: s.title, model: { ...s.model }, permission: s.permission, state: s.state, revision: s.revision, createdAt: s.createdAt, updatedAt: s.updatedAt, ownerId: s.ownerId, ownerLabel: s.ownerLabel, workspaceRoot: s.workspaceRoot, activity: s.activity, parentPolicy: s.parentPolicy, parentExpiresAt: s.parentExpiresAt, lastTurnId: turn?.id, lastAttempt: turn?.attempts };
}
