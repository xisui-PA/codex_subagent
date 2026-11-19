import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerEngine, ExecutionGovernance } from './engine';
import type { TaskBoard } from './task-board';
import { boardStorageReservation } from './task-board-tools';
import type { IsolatedViewHost } from './isolated-view-host';
import { ResourceGovernor, storageUsage, type ResourcePermit, type WaitingReason } from './resource-governor';
import { governedSchemas, waitDecision, waitRevision, type GovernedTool, type ScheduleWait } from './worker-startup';
import { digest, Mutex, type SessionStore } from './storage';
import { EvidenceRetention } from './evidence-retention';
import { view } from './api';
import { WorkerError, type Session, type Settings, type Provider, type Message, type Part, type Tool } from './types';

/** Explicit scheduling hook, reusable by future message delivery without a planner. */
export interface ScheduleWakeup { workerId: string; key: string; reason: 'message' | 'dependency' | 'policy' | 'resource' }

type IsolatedSpawn = ReturnType<typeof governedSchemas.subagent_isolated_spawn.parse>;
/** `heartbeats` counts explicit parent renewals applied to this preparation. */
interface Preparing { mutex: Mutex; controller: AbortController; ownerId: string; requestId: string; fingerprint: string; lane: IsolatedSpawn['setup']['lane']; users: number; expiresAt?: number; leaseSeconds: number; heartbeats: number }
/** One durable registration; `heartbeats` is the count observed when it was written. */
interface Registration { promise: Promise<{ expiresAt?: number; leaseSeconds: number }>; heartbeats: number }
/** Internal control flow: the requested wait is already stored at its observed generation. */
class WaitReplay extends Error {}
/**
 * A bounded metadata effect persists only a small record, never a file payload
 * or a runner workspace: private-view binding and one bounded tool result fit
 * the smallest service reserve. A work-lane request keeps the ordinary payload
 * reservation, because its bytes land in the same shared User budget.
 */
function metadataReservation(lane: IsolatedSpawn['setup']['lane']): number {
  return lane === 'work' ? 32 * 1024 ** 2 : boardStorageReservation(lane);
}
/** The only tool whose durable effect is one bounded tool result. */
const BOUNDED_RESULT_TOOL = 'read_file';
export class WorkerLifecycle implements ExecutionGovernance {
  private readonly closing = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private startupControls = 0;
  private workStartupControls = 0;
  private readonly evidence: EvidenceRetention;
  private readonly preparations = new Map<string, Preparing>();
  /** In-flight durable intent registrations; duplicates await the same record. */
  private readonly registrations = new Map<string, Registration>();
  private readonly maintaining = new Set<string>();
  private readonly controls = new Map<string, number>();
  private readonly inference = new Map<string, { workerId: string; modelId: string }>();
  private readonly admissions = new Map<string, { workerId: string; promise: Promise<void> }>();
  async drainAdmissions(workerId: string): Promise<void> {
    await Promise.all([...this.admissions.values()].filter(a => a.workerId === workerId).map(a => a.promise));
  }
  private retainedModels: { key: string; model: string }[] = [];
  private modelRefresh?: Promise<void>;
  private modelTimer?: NodeJS.Timeout;
  private schedulingBoard?: TaskBoard;
  constructor(private readonly root: string, private readonly store: SessionStore, private readonly engine: WorkerEngine,
    private readonly board: { open(): Promise<TaskBoard> }, private readonly isolation: IsolatedViewHost,
    private readonly resources: ResourceGovernor, private readonly provider: Provider,
    private readonly settings: () => Settings, private readonly guard: () => void,
    /**
     * Trusted live feature gate for a NEW evidence pin, deliberately NARROWER
     * than `guard`: a board-only pin (a manual URI) has always
     * been supported with private views disabled, so only the resource switch
     * may refuse a fresh pin. Defaults to the combined guard, which keeps every
     * direct caller that cannot offer the narrower check exactly as it was.
     */
    private readonly enabled: () => void = guard,
    /**
     * Reported only when THIS host really did governor accounting/acquisition or
     * joined durable enrollment for this exact store. The broker uses it to keep
     * shutdown and policy refresh for real participants, never for a dispatch
     * whose operation was still going to be refused.
     */
    private readonly participate?: () => void) {
    this.evidence = isolation.evidence;
  }

  /** The exact store this host owns is now a real participant in the aggregate. */
  private joined(): void {
    this.participate?.();
  }

  /** Synchronous admission fence; no mutex is held while a control waits. */
  beginControl(ownerId: string): () => void {
    this.assertNotMaintaining(ownerId);
    this.controls.set(ownerId, (this.controls.get(ownerId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      } released = true;
      const count = this.controls.get(ownerId)! - 1;
      if (count) {
        this.controls.set(ownerId, count);
      } else {
        this.controls.delete(ownerId);
      }
    };
  }
  private assertNotMaintaining(ownerId: string): void {
    if (this.maintaining.has(ownerId)) {
      throw new WorkerError('worker_busy', 'Owner receipt maintenance is in progress; retry this control after it completes.');
    }
  }

  authorize(session: Session, effect = false): void {
    if (session.ownerId) {
      this.assertNotMaintaining(session.ownerId);
    }
    const preparing = session.ownerId && session.startup ? this.preparations.get(digest([session.ownerId, session.startup.requestId])) : undefined;
    if (preparing) {
      this.checkPreparing(preparing);
    }
    this.guard();
    const current = this.store.get(session.id);
    // The last boundary before inference and workspace effects. A direct
    // send/resume or an unrelated reschedule reaches it without any startup
    // retry, so the durable ownership fence is consulted here as well.
    this.assertStartupOwned(current);
    if (current.startup?.phase !== 'started') {
      throw new WorkerError('startup_incomplete', 'Worker startup is incomplete.');
    }
    if (effect && this.schedulingReason(current)) {
      throw new WorkerError('schedule_changed', 'Scheduling eligibility changed before this effect; no effect was authorized. Resolve the dependency or message wait before continuing.', true);
    }
  }
  archive(session: Session, summary: string, signal?: AbortSignal, queue = true): Promise<Session> {
    return this.withStorage(32 * 1024 ** 2, () => this.store.archive(session.id, summary), signal, 'integration', queue);
  }
  activeForModel(modelId: string, excludeId?: string): number {
    return [...this.inference.values()].filter(token => token.modelId === modelId && token.workerId !== excludeId).length
      + this.retainedModels.filter(token => token.model === modelId && !this.inference.has(token.key)).length;
  }
  /** Keep foreign/retired-host ownership visible to the synchronous legacy scheduler. */
  async restoreModelReservations(established = false): Promise<void> {
    if (this.closing.signal.aborted) {
      return;
    }
    if (this.modelRefresh) {
      return this.modelRefresh;
    }
    clearTimeout(this.modelTimer);
    this.modelRefresh = (async () => {
      try {
        const retained = await this.resources.modelReservations(this.store.directory, established || this.retainedModels.length > 0);
        if (!this.closing.signal.aborted) {
          this.retainedModels = retained;
          this.engine.reschedule();
        }
      } finally {
        this.modelRefresh = undefined;
        if (!this.closing.signal.aborted && this.retainedModels.length) {
          this.modelTimer = setTimeout(() => {
            void this.restoreModelReservations().catch(error => this.engine.onError('resource-recovery', error));
          }, 100);
          this.modelTimer.unref();
        }
      }
    })();
    return this.modelRefresh;
  }
  private setupGuard(id: string, signal?: AbortSignal): void {
    signal?.throwIfAborted(); this.guard();
    const session = this.store.get(id);
    if (session.startup?.phase === 'cancelled') {
      throw new WorkerError('cancelled', 'Startup was cancelled; it cannot be restarted by retry.');
    }
    this.assertStartupOwned(session);
    if (session.parentPolicy === 'cancel-on-expiry' && (session.parentExpiresAt ?? 0) < Date.now()) {
      throw new WorkerError('parent_expired', 'Renew the startup parent lease explicitly before retrying.');
    }
  }
  /**
   * Durable ownership fence for one governed worker. A retry that finds an
   * existing checkpoint never passes create(), so the tombstone published by a
   * parent stop or expiry - which outlives a cancel phase checkpoint that
   * failed to commit - must be honored at every later boundary too: advancing an
   * incomplete phase, the scheduling handoff of an already started worker, a
   * direct send/resume and an unrelated engine reschedule all reach inference
   * only through waitReady/authorize.
   */
  private assertStartupOwned(session: Session): void {
    if (session.ownerId && session.startup) {
      this.store.assertStartupLive(session.ownerId, session.startup.requestId, this.root);
    }
  }
  /**
   * Runs under the SessionStore mutex and once more before the durable rename.
   * Only the observed wait generation may set or wake; an already-applied or
   * same-value request writes nothing, and anything superseded conflicts.
   */
  private assertWaitChange(id: string, expected: number, next: ScheduleWait | undefined): void {
    const current = this.store.get(id);
    const revision = waitRevision(current);
    const decision = waitDecision(current, expected, next);
    if (decision === 'conflict') {
      throw new WorkerError('revision_conflict', `Worker ${id} is at schedule wait revision ${revision}; expected ${expected}. Read the worker again before retrying: a newer wait is preserved, an older one is not restored, and a different wait at an applied generation is refused.`, true);
    }
    if (decision === 'replay') {
      throw new WaitReplay('The requested schedule wait is already stored at the observed generation.');
    }
    if (revision >= Number.MAX_SAFE_INTEGER) {
      throw new WorkerError('wait_revision_exhausted', `Worker ${id} already holds the last safe schedule wait revision ${revision}. The generation is never reset; replace the worker instead.`);
    }
  }
  async close(): Promise<void> {
    this.closing.abort(new WorkerError('host_stopping', 'Startup host is closing.', true));
    clearTimeout(this.modelTimer);
    await Promise.allSettled([...this.operations, ...(this.modelRefresh ? [this.modelRefresh] : [])]);
    // The last chance this host has to record a KNOWN drain: the governor's own
    // close retains every claim that is still charged as a quarantine, so an effect
    // that already finished must publish its drain here instead of surviving as an
    // uncertain charge. This is deliberately not the ONLY chance - the engine may
    // still drain turns after this lifecycle closes, and the governor's close
    // retries those too. A publication that still fails keeps its claim retained,
    // which is the fail-closed answer for an unpublished drain.
    await this.retryDrains();
  }
  async invoke(name: GovernedTool, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const lane = name === 'subagent_isolated_spawn' ? governedSchemas.subagent_isolated_spawn.parse(input).setup.lane : undefined;
    if (lane && (this.startupControls >= 64 || (lane === 'work' && this.workStartupControls >= 56))) {
      throw new WorkerError('resource_queue_full', 'Startup controls are full for this root/lane (64 total, at most 56 work). Wait or cancel queued setup; 8 controls remain reserved for validation/integration.');
    }
    if (lane) {
      this.startupControls++; if (lane === 'work') {
        this.workStartupControls++;
      }
    }
    const combined = AbortSignal.any([signal ?? new AbortController().signal, this.closing.signal, AbortSignal.timeout(360_000)]);
    const operation = this.invokeNow(name, input, combined);
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(operation);
      if (lane) {
        this.startupControls--; if (lane === 'work') {
          this.workStartupControls--;
        }
      }
    }
  }
  private async invokeNow(name: GovernedTool, input: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (['subagent_metadata_rollover', 'subagent_resource_collect', 'subagent_evidence_retention'].includes(name)) {
      return this.maintenance(name, input, signal);
    }
    if (name === 'subagent_resource_status') {
      const a = governedSchemas[name].parse(input); return this.resources.status(a.offset, a.limit);
    }
    if (name === 'subagent_schedule') {
      const a = governedSchemas[name].parse(input); this.engine.assertOwner(a.id, a.ownerId);
      if (!this.store.get(a.id).startup) {
        throw new WorkerError('invalid_arguments', 'Scheduling waits require a governed isolated worker.');
      }
      const next = a.wait ?? undefined;
      try {
        // The decision runs under the store mutex and again before the durable
        // rename, so a concurrent or superseded generation can never commit.
        return view(await this.store.change(a.id, s => {
          s.scheduleWait = next;
          s.scheduleWaitRevision = waitRevision(s) + 1;
        }, () => this.assertWaitChange(a.id, a.expectedWaitRevision, next)));
      } catch (error) {
        if (!(error instanceof WaitReplay)) {
          throw error;
        }
        return view(this.store.get(a.id));
      }
    }
    const a = governedSchemas.subagent_isolated_spawn.parse(input);
    const previous = this.store.findOperation(digest([a.ownerId, a.requestId]));
    if (previous?.startup?.phase === 'started') {
      const { setup, ...spawn } = a;
      const session = await this.engine.spawn({ ...spawn, workspaceRoot: this.root }, { ...setup, requestId: a.requestId, phase: 'created' });
      return view(await this.engine.startPrepared(session.id, () => this.setupGuard(session.id, signal)));
    }
    return this.prepare(a, signal, async (signal, preparing) => {
      this.guard(); signal?.throwIfAborted();
      const { setup, ...spawn } = a;
      const board = await this.board.open();
      if (!this.store.findOperation(digest([a.ownerId, a.requestId]))) {
        board.assertRequest(a.ownerId, a.requestId);
      }
      // create persists the permanent non-runnable gate; no harmless turn and
      // no provider stream or workspace tool is needed to obtain an identity.
      const create = () => this.engine.spawn({ ...spawn, workspaceRoot: this.root }, { ...setup, requestId: a.requestId, phase: 'created' as const }, { authorize: () => {
        signal.throwIfAborted(); this.checkPreparing(preparing);
      }, expiresAt: () => preparing.expiresAt, leaseSeconds: () => preparing.leaseSeconds });
      const session = this.store.findOperation(digest([a.ownerId, a.requestId])) ? await create() : await this.withStorage(2 * 1024 ** 2, create, signal, setup.lane);
      // The checkpoint now carries the same parent policy and deadline, so the
      // pending intent hands its identity off instead of gating it forever.
      await this.store.consumeStartupIntent(a.ownerId, a.requestId, this.root);
      if (session.startup?.phase === 'started') {
        return view(session);
      }
      const guard = () => this.setupGuard(session.id, signal);
      guard();
      const actor = { kind: 'coordinator', ownerId: a.ownerId } as const;
      if (this.store.get(session.id).startup!.phase === 'created') {
        await this.withStorage(boardStorageReservation(setup.lane), () => board.assignStartup(a.ownerId, {
          requestId: board.requestId(a.ownerId, `setup:${digest([a.ownerId, a.requestId]).slice(0, 40)}`), teamId: setup.teamId, taskId: setup.taskId,
          workerId: session.id, teamRevision: setup.teamRevision, taskRevision: setup.taskRevision
        }, guard), signal, setup.lane);
        await this.store.change(session.id, s => {
 s.startup!.phase = 'assigned';
        }, guard);
      }
      guard();
      const team = board?.getTeam(actor, setup.teamId); const task = board.getTask(actor, setup.taskId);
      if (!team.memberWorkerIds.includes(session.id) || task.assigneeWorkerId !== session.id || task.teamId !== team.id) {
        throw new WorkerError('assignment_conflict', 'Restore this startup worker membership and task assignment before retrying.');
      }
      if (this.store.get(session.id).startup!.phase === 'assigned') {
        // The private-view binding persists one bounded overlay/binding record,
        // so a service lane reserves metadata headroom rather than a payload size.
        const result = await this.withStorage(metadataReservation(setup.lane), async () => this.isolation.invoke('subagent_view_bind', {
          ownerId: a.ownerId, teamId: setup.teamId, id: session.id, snapshotId: setup.snapshotId,
          requestId: (await this.isolation.open()).requestId(a.ownerId, `setup:${digest([a.ownerId, a.requestId]).slice(0, 40)}`)
        }, this.engine, signal), signal, setup.lane);
        if (result.isError) {
          throw new WorkerError('startup_binding', result.content[0].text);
        }
        await this.store.change(session.id, s => {
 s.startup!.phase = 'bound';
        }, guard);
      }
      guard();
      await this.isolation.assertWorkerUsable(this.store.get(session.id), signal);
      await this.store.change(session.id, s => {
 s.startup!.phase = 'ready';
      }, guard);
      return view(await this.engine.startPrepared(session.id, guard));
    });
  }
  private checkPreparing(entry: Preparing): void {
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now() && !entry.controller.signal.aborted) {
      entry.controller.abort(new WorkerError('parent_expired', 'Parent lease expired during startup.'));
    }
    entry.controller.signal.throwIfAborted();
  }
  private async prepare(a: IsolatedSpawn, signal: AbortSignal, action: (signal: AbortSignal, preparing: Preparing) => Promise<unknown>): Promise<unknown> {
    this.assertNotMaintaining(a.ownerId);
    const key = digest([a.ownerId, a.requestId]); const fingerprint = digest(a);
    let entry = this.preparations.get(key);
    if (entry && entry.fingerprint !== fingerprint) {
      throw new WorkerError('idempotency_conflict', 'Startup request is already pending with different arguments.');
    }
    if (!entry) {
      if (this.preparations.size >= 32 || (a.setup.lane === 'work' && [...this.preparations.values()].filter(e => e.lane === 'work').length >= 28)) {
        throw new WorkerError('resource_queue_full', 'Pending setup is full for this root/lane (32 total, at most 28 work). Wait or cancel setup; 4 entries remain reserved for validation/integration.');
      }
      entry = { mutex: new Mutex(), controller: new AbortController(), ownerId: a.ownerId, requestId: a.requestId, fingerprint, lane: a.setup.lane, users: 0, expiresAt: a.parentPolicy === 'cancel-on-expiry' ? Date.now() + a.leaseSeconds * 1000 : undefined, leaseSeconds: a.leaseSeconds, heartbeats: 0 };
      // Reserve the entry synchronously, so a same-host duplicate joins this
      // one instead of registering a second intent for the same identity.
      this.preparations.set(key, entry);
    }
    const preparing = entry; preparing.users++;
    let registration: Registration | undefined;
    try {
      // The accepted identity, its exact argument fingerprint and the original
      // parent deadline are durable BEFORE the first capacity wait. An aborted
      // transport, a reload or a crash therefore cannot grant this request a
      // fresh lease, accept changed arguments, or let a legacy spawn take its
      // identity while it waits. Duplicates await the same registration, so
      // none of them can observe a lease that was never persisted. A request a
      // checkpoint already owns is never given a second intent.
      if (!this.store.findOperation(key)) {
        // The CURRENT request epoch is validated while only the synchronous
        // preparation reservation exists, never a persisted intent: an identity
        // from a retired namespace is refused before it can spend one of the 60
        // kept intent slots or hold metadata maintenance closed. The reservation
        // stays the per-owner fence across this await, and a checkpoint skips
        // the block entirely, so setup replay survives a namespace rollover.
        const board = await this.board.open();
        board.assertRequest(a.ownerId, a.requestId);
        let shared = this.registrations.get(key);
        if (!shared) {
          // The heartbeat count is sampled where the record is written, so a
          // renewal that lands in flight (or a shortening one) is never undone
          // by the stale reply this registration carries. The deadline and the
          // lease are written as ONE pair from the current preparation: an
          // explicit heartbeat may already have replaced both before this first
          // intent exists, and its lease must not revert to the request's.
          shared = { heartbeats: preparing.heartbeats, promise: this.store.beginStartupIntent({ ownerId: a.ownerId, requestId: a.requestId, workspaceRoot: this.root,
            fingerprint, policy: a.parentPolicy ?? 'keep', lane: a.setup.lane, leaseSeconds: preparing.leaseSeconds, expiresAt: preparing.expiresAt }) };
          this.registrations.set(key, shared);
        }
        registration = shared;
        const intent = await shared.promise;
        // A persisted record keeps its original deadline only while no explicit
        // heartbeat happened since it was written. A heartbeat is the latest
        // coordinator intent and owns both places, so it survives the
        // asynchronous reply - `heartbeats` ordering, never a maximum, because
        // an explicit renewal may shorten the lease as well as extend it.
        if (preparing.heartbeats === shared.heartbeats) {
          preparing.expiresAt = intent.expiresAt; preparing.leaseSeconds = intent.leaseSeconds;
        }
      }
      return await preparing.mutex.run(async () => {
        this.checkPreparing(preparing); return action(AbortSignal.any([signal, preparing.controller.signal]), preparing);
      });
    } catch (error) {
      if (preparing.controller.signal.aborted) {
        await this.store.retireStartup(preparing.ownerId, preparing.requestId, this.root);
        const session = this.store.findOperation(key);
        if (session && !['completed', 'cancelled'].includes(session.state)) {
          await this.engine.cancel(session.id);
        }
        await this.resources.account(this.store.directory, () => storageUsage(this.store.directory));
        this.joined();
      }
      throw error;
    } finally {
      if (registration && this.registrations.get(key) === registration) {
        this.registrations.delete(key);
      }
      if (--preparing.users === 0) {
        this.preparations.delete(key);
      }
    }
  }
  async parent(ownerId: string, action: 'heartbeat' | 'stop', leaseSeconds: number): Promise<void> {
    const entries = [...this.preparations.values()].filter(e => e.ownerId === ownerId);
    for (const entry of entries) {
      if (action === 'heartbeat') {
        // An explicit renewal is the newest coordinator intent for this
        // request: it is applied even while its durable record is still being
        // written, whether it lengthens or shortens the remaining lease, and
        // the in-flight registration may no longer overwrite it.
        entry.heartbeats++; entry.leaseSeconds = leaseSeconds; if (entry.expiresAt !== undefined) {
          entry.expiresAt = Date.now() + leaseSeconds * 1000;
        }
      } else {
        entry.controller.abort(new WorkerError('cancelled', 'Parent explicitly stopped startup.'));
      }
    }
    if (action === 'stop') {
      for (const entry of entries) {
        await this.store.retireStartup(entry.ownerId, entry.requestId, this.root);
      }
      // A request accepted by a previous host has no in-memory entry, but its
      // persisted intent still owns that identity until it is retired here.
      await this.store.retireStartupIntents(ownerId);
    } else {
      // Renew the persisted deadline too, so a retry after a reload continues
      // the original lease instead of starting a fresh one.
      await this.store.heartbeatStartupIntents(ownerId, leaseSeconds);
    }
  }
  async expirePreparing(): Promise<void> {
    for (const entry of this.preparations.values()) {
      if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
        entry.controller.abort(new WorkerError('parent_expired', 'Parent lease expired during startup.'));
        await this.store.retireStartup(entry.ownerId, entry.requestId, this.root);
      }
    }
    // Requests accepted before a reload have no in-memory entry; their persisted
    // deadline retires them, so a later retry can never start a fresh lease.
    await this.store.expireStartupIntents();
  }
  /**
   * One metadata maintenance operation.
   *
   * Parsing and team authorization are PREFLIGHT: they run before this store can
   * be enrolled, so an invalid request or an unauthorized team scope leaves a
   * fresh opted-out store with neither a local registration nor any aggregate
   * state, and its legacy writes stay independent of the global ledger.
   *
   * A valid, authorized request still reconciles its metadata on every outcome -
   * release, rollover, collection and a post-commit failure alike - but only for
   * a store that is REGISTERED: either it already was, or this validated
   * operation registered it itself through the explicit rollover registration or
   * the evidence pin's storage write fence. Accounting an unregistered store here
   * would enroll an opted-out store as a side effect of a refused request.
   * Reclamation itself never waits for a storage permit.
   */
  private async maintenance(name: GovernedTool, input: unknown, signal: AbortSignal): Promise<unknown> {
    const a = governedSchemas[name].parse(input) as { ownerId: string; teamId: string };
    const board = await this.board.open(); board.getTeam({ kind: 'coordinator', ownerId: a.ownerId }, a.teamId);
    try {
      return await this.maintenanceNow(name, input, a, board, signal);
    } finally {
      if (await this.resources.hasStore(this.store.directory)) {
        // A durable local registration is what makes this exact store a
        // participant, so its post-commit reconciliation and its host shutdown
        // are both kept even when the mutation itself failed after committing.
        this.joined();
        await this.resources.account(this.store.directory, () => storageUsage(this.store.directory));
      }
    }
  }
  private async maintenanceNow(name: GovernedTool, input: unknown, a: { ownerId: string; teamId: string },
    board: TaskBoard, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (name === 'subagent_evidence_retention') {
      const pin = governedSchemas.subagent_evidence_retention.parse(input);
      if (pin.action === 'pin' && pin.uri.startsWith('urn:codex-runner-result:')) {
        const id = pin.uri.split(':').at(-1)!;
        const response = await this.isolation.invoke('subagent_runner_result', { ownerId: a.ownerId, teamId: a.teamId, id }, this.engine, signal);
        const result = JSON.parse(response.content[0].text) as { result?: { uri: string } };
        if (response.isError || result.result?.uri !== pin.uri) {
          throw new WorkerError('retention_missing', 'Read and retain the exact existing result URI before consumption.');
        }
      }
      const assertPinScope = (): void => {
        signal.throwIfAborted(); board.getTeam({ kind: 'coordinator', ownerId: a.ownerId }, a.teamId);
      };
      return this.evidence.update(pin, assertPinScope, pin.action === 'pin' ? async () => {
        await this.isolation.assertEvidence(pin, this.engine, signal);
      } : undefined, commit => {
        // A NEW pin's storage admission is what would register this store and
        // charge it, so the trusted live resource switch is consulted HERE,
        // before the governor accounts a single byte: an opted-out store gains
        // neither a local registration nor an aggregate row from a refused pin.
        // Exact replay and release never reach this callback, so both keep
        // working after an opt-out without a tool-level gate.
        this.enabled();
        return this.withStorage(4 * 1024 ** 2, commit, signal, 'integration', false);
      }, () => {
        // The same gate runs inside the evidence mutex before a brand-new ledger
        // would be bootstrapped and before a new pin is appended to an existing
        // one, so a refused fresh pin leaves no evidence namespace either. The
        // pin's own authorization comes FIRST, exactly as it does before the
        // ledger write: a foreign team still fails `forbidden`, and only an
        // authorized NEW pin consults the live resource switch.
        assertPinScope();
        this.enabled();
      });
    }
    this.assertNotMaintaining(a.ownerId);
    // A persisted pre-creation request has no checkpoint and no in-memory
    // preparation after a reload, so it is fenced here by its own record:
    // rollover and collection must not compact identities it still holds.
    if (this.controls.has(a.ownerId) || [...this.preparations.values()].some(p => p.ownerId === a.ownerId) || this.store.hasPendingStartup(a.ownerId)
      || this.store.list().some(s => s.ownerId === a.ownerId && (['queued', 'running'].includes(s.state) || (s.startup && !['started', 'cancelled'].includes(s.startup.phase))))) {
      throw new WorkerError('worker_busy', 'Quiesce this owner workers and finish or cancel incomplete setup before metadata maintenance.');
    }
    this.maintaining.add(a.ownerId);
    try {
      const views = await this.isolation.open();
      if (name === 'subagent_metadata_rollover') {
        const rollover = governedSchemas.subagent_metadata_rollover.parse(input);
        // Explicit rollover can be the first governed mutation in an opted-out
        // store. Its first registration is handed to the DOMAIN instead of running
        // here: the domain still holds its own mutex, and it calls this only after
        // the epoch/expectedEpoch, pending-intent and archive-capacity checks pass.
        // A stale, foreign, replayed or otherwise preflight-rejected epoch
        // therefore enrolls nothing, and pending-publication recovery enrolls
        // through the same accepted check. The archive preflight arrives as `check`
        // and runs here ONLY while this store is not yet registered: a physical
        // archive refusal then leaves no local registration, no aggregate row and no
        // publication intent behind, while an already registered store skips that
        // second, expensive archive preparation and still gets the fenced preflight
        // that guards every publication. A store whose local registration already
        // exists is reported as a participant instead of being registered twice.
        const enroll = async (check: () => Promise<void>): Promise<void> => {
          // The request may have been aborted while the domain held its mutex;
          // never enroll (or start the write phase) for a cancelled request.
          signal.throwIfAborted();
          if (!await this.resources.hasStore(this.store.directory)) {
            // Read-only: this proves the whole archive preflight before a single byte
            // of this store is registered or charged.
            await check();
            signal.throwIfAborted();
            await this.resources.account(this.store.directory, () => storageUsage(this.store.directory));
          }
          this.joined();
        };
        return await (rollover.kind === 'board' ? board.rolloverReceipts(a.ownerId, rollover.expectedEpoch, enroll) : views.rolloverReceipts(a.ownerId, rollover.expectedEpoch, enroll));
      }
      const collect = governedSchemas.subagent_resource_collect.parse(input);
      const result = await this.evidence.withReferences(async pins => {
        const collected = await board.withReferences(async references => {
          const retained = new Set([...pins, ...references]);
          const results = await this.isolation.collectResources({ ownerId: a.ownerId, teamId: a.teamId }, collect.resultIds, retained);
          const viewArchives = collect.archives ? await views.collectReceiptArchives(a.ownerId, retained) : 0;
          return { results, viewArchives };
        });
        const boardArchives = collect.archives ? await board.collectReceiptArchives(a.ownerId, pins) : 0;
        return { ...collected, boardArchives };
      });
      const tombstones = await this.store.collectRetired(a.ownerId, board.epoch(a.ownerId));
      return { ...result, tombstones };
    } finally {
      this.maintaining.delete(a.ownerId);
    }
  }
  private async waiting(id: string, reason?: WaitingReason): Promise<void> {
    if (this.store.get(id).waitingReason === reason) {
      return;
    }
    await this.store.change(id, s => {
      s.waitingReason = reason; if (reason) {
        s.activity = `Waiting: ${reason}`;
      }
    });
    this.engine.onChange();
  }
  /** Synchronous checks are reusable at every pre-effect authorization boundary. */
  private schedulingReason(current: Session): 'dependency' | 'message' | undefined {
    const board = this.schedulingBoard;
    if (!board) {
      throw new WorkerError('resource_unavailable', 'Scheduling state has not been restored; no worker effect was authorized.');
    }
    const actor = { kind: 'coordinator', ownerId: current.ownerId! } as const;
    const task = board.getTask(actor, current.startup!.taskId); const team = board.getTeam(actor, current.startup!.teamId);
    if (task.assigneeWorkerId !== current.id || !team.memberWorkerIds.includes(current.id)) {
      throw new WorkerError('assignment_conflict', 'Worker assignment or membership was revoked.');
    }
    if (['accepted', 'cancelled', 'failed'].includes(task.state)) {
      throw new WorkerError('task_stopped', 'Task is terminal or failed. Make an explicit coordinator decision before continuing.');
    }
    return current.scheduleWait ? 'message' : task.readiness.ready ? undefined : 'dependency';
  }
  async waitReady(session: Session, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted(); this.guard();
      const current = this.store.get(session.id);
      // Fail before any admission or provider request, including from a
      // reschedule no retry initiated.
      this.assertStartupOwned(current);
      if (current.startup?.phase !== 'started' || !current.isolatedView || current.startup.snapshotId !== current.isolatedView.snapshotId || current.startup.teamId !== current.isolatedView.teamId) {
        throw new WorkerError('startup_incomplete', 'Complete isolated setup before execution.');
      }
      const policy = this.settings().models?.[current.model.id];
      if (!policy) {
        throw new WorkerError('model_unavailable', 'This model is no longer enabled. Explicitly resume with an enabled exact model.');
      }
      if (current.permission === 'workspace-write' && policy.allowWrite === false) {
        throw new WorkerError('permission_denied', 'The model no longer permits workspace writes.');
      }
      this.schedulingBoard = await this.board.open();
      const reason = this.schedulingReason(current);
      await this.waiting(current.id, reason);
      if (!reason) {
        return;
      }
      await delay(100, undefined, { signal });
    }
  }
  /** No resources held during dependency/message waits, runner waits or approval. */
  async *stream(session: Session, messages: Message[], tools: Tool[], signal: AbortSignal, maintenance = false): AsyncIterable<Part> {
    const key = `model:${this.resources.host}:${randomUUID()}`;
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
      resolve = done;
    });
    this.admissions.set(key, { workerId: session.id, promise });
    const admitted = (): void => {
      this.admissions.delete(key); resolve();
    };
    try {
      if (!maintenance) {
        await this.waitReady(session, signal);
      } else {
        this.authorize(session);
      }
      const localLimit = () => this.settings().models?.[session.model.id]?.numSessions ?? 1;
      const legacyActive = () => this.engine.legacyActiveForModel(session.model.id);
      const localCapacity = () => Math.max(1, localLimit() - legacyActive());
      let permit: import('./resource-governor').ResourcePermit;
      for (;;) {
        permit = await this.resources.acquire({ key, kind: 'model', root: this.root, scope: this.store.directory, lane: session.startup!.lane,
          model: session.model.id, get localCapacity() {
            return localCapacity();
          }, get localBlocked() {
            return legacyActive() >= localLimit();
          }, bytes: 2 * 1024 ** 2 }, signal,
        async reason => {
          this.guard(); await this.waiting(session.id, reason);
        });
        // A real model admission is participation, even before the next checkpoint.
        this.joined();
        // Mark this key before checking room, so a concurrent recovery sample
        // cannot count this same reservation twice. No await splits the handoff.
        this.inference.set(key, { workerId: session.id, modelId: session.model.id });
        try {
          if (this.engine.modelRoom(session)) {
            break;
          }
        } catch (error) {
          await this.finishInference(key, undefined, permit); throw error;
        }
        try {
          await this.resources.deferModel(key); this.inference.delete(key);
        } catch (error) {
          await permit.quarantine(); throw error;
        }
        this.engine.reschedule();
        try {
          await delay(100, undefined, { signal });
        } catch (error) {
          await this.resources.release(key); throw error;
        }
      }
      let iterator: AsyncIterator<Part> | undefined;
      try {
        if (!maintenance) {
          await this.isolation.assertWorkerUsable(this.store.get(session.id), signal);
        }
        const board = maintenance ? undefined : await this.board.open();
        this.authorize(session); signal.throwIfAborted();
        const policy = this.settings().models?.[session.model.id];
        if (!policy) {
          throw new WorkerError('model_unavailable', 'The selected model was disabled while queued.');
        }
        if (!maintenance && session.permission === 'workspace-write' && policy.allowWrite === false) {
          throw new WorkerError('permission_denied', 'Write permission was revoked while queued.');
        }
        this.guard(); signal.throwIfAborted();
        const task = board?.getTask({ kind: 'coordinator', ownerId: session.ownerId! }, session.startup!.taskId);
        const team = board?.getTeam({ kind: 'coordinator', ownerId: session.ownerId! }, session.startup!.teamId);
        if (!maintenance && (!task || !team || task.assigneeWorkerId !== session.id || !team.memberWorkerIds.includes(session.id) || ['accepted', 'cancelled', 'failed'].includes(task.state))) {
          throw new WorkerError('task_stopped', 'Assignment, membership or task lifecycle changed while awaiting admission.');
        }
        if (!maintenance && (this.store.get(session.id).scheduleWait || !task?.readiness.ready)) {
          throw new WorkerError('schedule_changed', 'Readiness changed during admission. Resume explicitly after resolving the wait.', true);
        }
        iterator = this.provider.stream(session.model, messages, tools, signal)[Symbol.asyncIterator]();
        admitted();
        for (;;) {
        // Deliberately await the real effect. An outer engine abort may detach
        // its consumer, but this permit remains owned until the provider drains.
          const next = await iterator.next();
          signal.throwIfAborted();
          if (next.done) {
            break;
          }
          yield next.value;
        }
      } finally {
        await this.finishInference(key, iterator, permit);
      }
    } finally {
      admitted();
    }
  }
  async execute<T>(session: Session, name: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    await this.waitReady(session, signal);
    // Runner admission is atomic with a local slot in RunnerPool. Holding a
    // runnable permit while awaiting that slot would create a resource cycle.
    if (name === 'run_command') {
      await this.waiting(session.id, 'runner_capacity');
      try {
        return await action();
      } finally {
        await this.waiting(session.id);
      }
    }
    for (;;) {
      await this.waitReady(session, signal);
      // Publish the KNOWN drain of an earlier finished effect FIRST: the single
      // sample below reclaims its row and clears its fence, so a completed effect
      // is never left charged by this retry either.
      await this.retryDrains();
      await this.resources.account(this.store.directory, () => storageUsage(this.store.directory));
      this.joined();
      // A bounded result tool appends one small tool result in a service lane;
      // a work-lane call keeps the full payload reserve.
      const bytes = name === BOUNDED_RESULT_TOOL ? metadataReservation(session.startup!.lane) : 32 * 1024 ** 2;
      const permit = await this.resources.acquire({ key: `tool:${this.resources.host}:${randomUUID()}`, kind: 'tool', root: this.root, lane: session.startup!.lane, bytes, store: this.store.directory }, signal, reason => this.waiting(session.id, reason));
      try {
        this.guard(); signal.throwIfAborted();
        if (!this.schedulingReason(this.store.get(session.id))) {
          return await action();
        }
        // Yield capacity before entering a dependency/message wait again.
      } finally {
        await this.finishStorage(permit);
      }
    }
  }
  /**
   * Settle a tool/storage permit after its effect.
   *
   * The action has already finished (successfully or not), so this permit is
   * DRAINED - never uncertain. Quarantining it here charged a completed effect
   * forever: only an exact release removes a claim, and the key is local to this
   * call. Recording the KNOWN drain instead keeps the exact registered store as
   * the only owner of the bytes: admission stays fenced while that store's sample
   * is unknown, and a healthy reconciliation of that same store reclaims it.
   *
   * `drain()` is ONE atomic transition, so a rejection means the ledger never
   * published it and the claim is still charged here as an ACTIVE effect. That
   * permit is therefore retained for retry instead of being dropped: nothing else
   * could ever settle it (a healthy sample can only reclaim a KNOWN drain, never
   * an active charge) and the governor's own close would keep the finished effect
   * as a permanent quarantine. The caller still sees the failure - the effect is
   * never repeated, but its ownership could not be recorded - and nothing is
   * released, quarantined or re-authorized meanwhile: the exact claim keeps its
   * own fencing until that same permit publishes its drain.
   *
   * The retention lives in the GOVERNOR, not here, because this lifecycle is
   * closed BEFORE the engine drains its in-flight turns: a finished effect can
   * reach this method after `close()` already returned, and only the governor's own
   * final close can still settle it.
   *
   * The drain and the sample below are ONE obligation, and the governor owns it
   * from before that sample runs: a successful publication followed by a failing -
   * or superseded - sample used to leave a durable global fence that nothing would
   * ever sample again, because nothing was retained and no timer was armed. Handing
   * the sample to `drain({ retain: true, resample })` registers the exact claim
   * first, so only this store's committing sample acknowledges it; if it does not,
   * the governor's existing bounded owner retry takes over. The effect is never
   * replayed and no new operation is needed.
   */
  private async finishStorage(permit: ResourcePermit): Promise<void> {
    // Fence the finished effect before resampling, so an older sample cannot
    // publish stale bytes while its reservation stops charging capacity.
    await permit.drain({ retain: true,
      resample: () => this.resources.account(this.store.directory, () => storageUsage(this.store.directory)) });
  }
  /**
   * Retry the governor's retained known drains of THIS exact store: the ordinary
   * reconciliation points of this host (`execute` and `withStorage`) call this
   * first, so the ONE `account()` right afterwards reclaims a published drained row
   * and clears its fence with the same measurement.
   *
   * An unpublished drain stays charged and can be retried by the current
   * governor, including during its final close. Once published, the drain's
   * store fence can be reconciled after reload. Report a failed retry so the
   * next operation can still attempt its own admission.
   */
  private async retryDrains(): Promise<void> {
    for (const failure of await this.resources.retryRetainedDrains(this.store.directory)) {
      this.engine.onError?.('resource-recovery', failure.error);
    }
  }
  private async finishInference(id: string, iterator: AsyncIterator<Part> | undefined, permit: import('./resource-governor').ResourcePermit): Promise<void> {
    try {
      await iterator?.return?.(); await permit.release(); this.inference.delete(id);
    } catch (error) {
      await permit.quarantine(); throw error;
    } finally {
      this.engine.reschedule();
    }
  }
  async withStorage<T>(bytes: number, action: () => Promise<T>, signal?: AbortSignal, lane: 'work' | 'validation' | 'integration' = 'work', queue = true): Promise<T> {
    // A retained known drain is published before this store is resampled, so the
    // one measurement below reclaims it instead of leaving its fence behind.
    await this.retryDrains();
    await this.resources.account(this.store.directory, () => storageUsage(this.store.directory));
    this.joined();
    const combined = AbortSignal.any([signal ?? new AbortController().signal, this.closing.signal]);
    const permit = await this.resources.acquire({ key: `storage:${this.resources.host}:${randomUUID()}`, kind: 'storage', root: this.root, bytes, lane, store: this.store.directory }, combined, undefined, queue);
    try {
      combined.throwIfAborted();
      return await action();
    } finally {
      await this.finishStorage(permit);
    }
  }
}
