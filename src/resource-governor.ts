import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { atomicWrite, digest } from './storage';
import { WorkerError } from './types';
import type { RunnerLeaseOwner, RunnerLeaseRecord } from './runner-pool';

import { waitingReasons } from './worker-startup';
export { waitingReasons } from './worker-startup';
export type WaitingReason = typeof waitingReasons[number];
/**
 * Bounded liveness window for a WAITING ticket, in milliseconds. Only a ticket
 * whose owning caller polled it within this window is live; a ticket that
 * outlived it is withdrawn, so a cancelled request whose ledger withdrawal
 * failed, a crashed host or a closed consumer can never keep head-of-line
 * eligibility forever. Active, quarantined and drained claims - real or
 * uncertain effects - are never expired by it.
 *
 * The same bound governs a PROVISIONAL handoff: a grant whose caller has not yet
 * acknowledged it after its own callbacks and cancellation check. It charges
 * capacity exactly like an admitted effect while it is live, but a handoff nobody
 * ever acknowledged never became an effect, so past the window it is withdrawn as
 * no-effect instead of being quarantined.
 */
export const WAITING_TICKET_WINDOW_MS = 10_000;
/** Runner tickets share the same bound; kept as its own name for their callers. */
export const RUNNER_TICKET_WINDOW_MS = WAITING_TICKET_WINDOW_MS;
/** Bounded retention of a known-drained reservation awaiting store reconciliation. */
export const DRAINED_TICKET_RETENTION_MS = 86_400_000;
/**
 * Coalesced background reconciliation of a finished effect whose ledger
 * publication - or whose exact store's reclaiming sample - has not committed yet:
 * the delay of the FIRST retry of a retained drain, the cap of its exponential
 * backoff, and the backoff step at which that cap is reached.
 *
 * A retained drain charges a completed effect, so until its known drain is
 * published AND the exact store's healthy sample accounted for it, no waiter can
 * be admitted from that store - and nothing else is guaranteed to happen: a queued
 * ticket of ANOTHER host or root only polls its own eligibility, a new admission
 * may never come, and a store reopen may never occur. The owner of the claim
 * therefore drives the retry itself for as long as the obligation exists.
 *
 * What is bounded is the RATE, never the number of attempts: ONE unref'd timer per
 * governor (never one per claim), a delay that saturates at the cap, and backoff
 * metadata that saturates with it. A persistent failure therefore stays a durable,
 * fail-closed charge that still counts on every real operation and on `close`,
 * instead of becoming a timer per claim, a zero-delay busy loop, unbounded
 * background metadata - or, worse, a store whose only remaining waiter polls a
 * fence that nothing will ever sample again.
 */
const DRAIN_RETRY_BASE_MS = 50;
const DRAIN_RETRY_MAX_MS = 2_000;
/** Backoff step at which `BASE * 2 ** step` reaches the cap; the metadata saturates here. */
const DRAIN_RETRY_SATURATED_ATTEMPTS = Math.ceil(Math.log2(DRAIN_RETRY_MAX_MS / DRAIN_RETRY_BASE_MS));
export type WorkLane = 'work' | 'validation' | 'integration';
export const resourceDefaults = { enabled: false, modelCapacity: 8, runnableCapacity: 16, runnerCapacity: 4, storageBytes: 8 * 1024 ** 3, serviceReserve: 1 as const };
export const resourceConfigSchema = z.strictObject({
  enabled: z.boolean(), modelCapacity: z.number().int().min(2).max(128),
  runnableCapacity: z.number().int().min(2).max(256), runnerCapacity: z.number().int().min(2).max(64),
  storageBytes: z.number().int().min(64 * 1024 ** 2).max(1024 ** 4), serviceReserve: z.literal(1)
});
export type ResourceConfig = z.infer<typeof resourceConfigSchema>;
/** Only trusted User configuration is considered, including resource limits. */
export function readResourceConfig(inspect: (key: string) => unknown): ResourceConfig {
  const values: Record<string, unknown> = { ...resourceDefaults };
  for (const key of Object.keys(resourceDefaults)) {
    const entry = inspect(`resources.${key}`) as { globalValue?: unknown } | undefined;
    if (entry?.globalValue !== undefined) {
      values[key] = entry.globalValue;
    }
  }
  return resourceConfigSchema.parse(values);
}

const lane = z.enum(['work', 'validation', 'integration']);
const claimSchema = z.strictObject({
  key: z.string().max(512), host: z.string().uuid(), pid: z.number().int().positive(),
  kind: z.enum(['model', 'tool', 'runner', 'storage']), lane,
  root: z.string().max(8192), scope: z.string().max(8192), model: z.string().max(500),
  localCapacity: z.number().int().positive(), localBlocked: z.boolean().optional(), bytes: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  // 'provisional' is a durable grant whose caller has not acknowledged it yet: it
  // already owns its queue position and charges capacity, but it is not an effect
  // and cannot become one without the explicit acknowledgement transaction. It is
  // additive, so a ledger written before it existed still parses.
  state: z.enum(['waiting', 'provisional', 'active', 'quarantine', 'drained']),
  // Liveness of a WAITING ticket or of a PROVISIONAL handoff (epoch ms of its own
  // last poll/acknowledgement) and the exact registered store of a DRAINED
  // reservation. Both are optional so a ledger written before they existed still
  // parses; a legacy ticket is given exactly one window to be polled before it is
  // withdrawn, and a missing store simply has nothing to reconcile. The heartbeat
  // is never set on an active or uncertain effect, so liveness can never expire
  // one.
  heartbeat: z.number().int().nonnegative().optional(), store: z.string().max(512).optional(),
  drainedAt: z.number().int().nonnegative().optional()
});
type Claim = z.infer<typeof claimSchema>;
const ledgerSchema = z.strictObject({
  schema: z.literal(1), sequence: z.number().int().nonnegative(),
  policies: z.record(z.string().uuid(), z.strictObject({ pid: z.number().int().positive(), config: resourceConfigSchema })),
  stores: z.record(z.string(), z.strictObject({ directory: z.string(), bytes: z.number().int().nonnegative(),
    sampleId: z.string().uuid().optional(), accounting: z.enum(['measuring', 'quarantine']).optional(),
    uncertain: z.boolean().optional(), diagnostic: z.string().max(500).optional(),
    write: z.strictObject({ id: z.string().uuid(), host: z.string().uuid(), pid: z.number().int().positive(), state: z.enum(['active', 'quarantine']) }).optional() })),
  claims: z.array(claimSchema).max(512)
});
type Ledger = z.infer<typeof ledgerSchema>;
/**
 * Everything the queue rules read: the rows and the store samples. A full ledger
 * satisfies it, and so does the immutable snapshot a status call projects from.
 */
type LedgerView = Pick<Ledger, 'claims' | 'stores'>;
export interface ResourceRequest {
  key: string; kind: Claim['kind']; lane?: WorkLane; root: string; scope?: string;
  model?: string; localCapacity?: number; localBlocked?: boolean; bytes?: number;
  /** Exact registered store that owns these bytes (storage/tool permits). */
  store?: string;
}
/**
 * A granted permit. `release` frees a drained permit, `quarantine` retains one
 * whose effect is uncertain, and `drain` records a KNOWN drain: the effect has
 * already finished, so the permit must never become a permanent quarantine even
 * when the accounting or release step failed. A drained permit reserves nothing,
 * keeps admission fenced through its exact store's uncertain sample, and is
 * reclaimed by that store's next healthy reconciliation.
 *
 * `drain({ retain: true })` is for the caller whose effect has ALREADY finished
 * and whose own host may close before that publication lands: the governor keeps
 * this exact claim as a retry obligation with a bounded rate (see
 * `retryRetainedDrains`), so a failed publication is never the loss of the only
 * handle on a completed effect.
 *
 * `drain({ retain: true, resample })` additionally hands the caller's OWN
 * foreground reconciliation of that exact store to the same step. The governor
 * registers the recovery obligation for this claim BEFORE `resample` runs, so the
 * caller's sample is the only thing that settles it: the committing sample - and
 * only that, identity-checked against this exact store and claim - acknowledges
 * it. If the sample then fails or is superseded, the obligation is still owned and
 * the governor arms its bounded coalesced retry in a `finally` (see
 * `scheduleRetainedDrains`), so a drain published successfully followed by a
 * failing sample can never leave a durable global fence that nothing will sample
 * again. The effect is never replayed and no background scan is armed while the
 * caller's own sample is still in progress.
 */
export interface ResourcePermit {
  release(): Promise<void>; quarantine(): Promise<void>;
  drain(options?: { retain?: boolean; resample?: () => Promise<void> }): Promise<void>;
}
export interface RunnerAdmission {
  applies?(owner: RunnerLeaseOwner): boolean;
  tryAcquire(id: string, owner: RunnerLeaseOwner, localCapacity?: number): Promise<boolean>;
  cancel(id: string): Promise<void>;
  /**
   * Withdraw several EXACT runner claims of this host in ONE scoped ledger
   * transaction - the batch form of `cancel`, for a pool that is shutting down or
   * discarding many queued requests at once. The removal rule is identical: only
   * a key this host owns is touched, and an id that owns no row is simply absent
   * from the result. Optional, so a caller that only has `cancel` keeps cancelling
   * one request at a time; when it is present, a batch costs one lock, one read
   * and one commit instead of one per id.
   */
  cancelMany?(ids: readonly string[]): Promise<void>;
  /**
   * `physicalAvailable` is the owning pool's own verdict, sent after every
   * journal adoption and on recovery: does that pool still have a usable
   * physical slot for a waiting ticket? `undefined` leaves eligibility alone.
   */
  reconcile(records: readonly RunnerLeaseRecord[], recovery?: boolean, releasedIds?: readonly string[], physicalAvailable?: boolean): Promise<void>;
}

/**
 * One pending retry obligation: the exact retained claim key, the exact registered
 * store its finished effect used, and how many background rounds this governor
 * already backed off on it - saturated at the retry rate's cap, so the metadata
 * never grows without bound. Treated as an immutable value while a round holds it:
 * a helper only ever removes or replaces the entry it captured, identified by
 * object identity, so a concurrent release/quarantine/re-retention is never
 * overwritten and a settled obligation is never resurrected.
 *
 * `foreground` marks the ONE case in which this governor must NOT sample on its
 * own: the owner's own foreground `resample` callback of that exact store is in
 * progress and is itself the expected acknowledgement. The entry stays owned - a
 * commit that accounts for its claim settles it, and a failed or superseded
 * sample leaves it owed - but it is excluded from background eligibility (both
 * from scheduling and from the round's due set, and its exact store from a
 * background measurement) so no background scan can supersede the caller's
 * in-progress sample. The marker is cleared in that callback's own `finally`,
 * which is also where the bounded retry is (re)armed while anything is still owed.
 */
interface RetainedDrain { store?: string; attempts: number; foreground?: boolean }

/**
 * One OS-user ledger, independent of extension storage, roots, worktrees and
 * extension hosts. Transactions are short; no lease, RPC, approval or effect is
 * awaited under the file lock. A stale/corrupt lock fails closed with a path.
 */
export class ResourceGovernor {
  readonly host = randomUUID();
  private resolvedDirectory?: string;
  get directory(): string {
    try {
      return this.resolvedDirectory ??= path.join(os.userInfo().homedir, '.codex-subagent', 'resources-v1');
    } catch {
      throw new WorkerError('resource_unavailable', 'Cannot determine the OS account profile for aggregate resource ownership. Restore the host account profile before enabling governed work.');
    }
  }
  private closing = false;
  private readonly writer = new AsyncLocalStorage<{ key: string; id: string }>();
  /**
   * Verified KNOWN drains of finished effects whose ledger publication did not
   * commit, by the exact claim key that still owns them.
   *
   * This is the whole pending retry state, and it is bounded by durable ownership:
   * an entry exists only for a claim this ledger charged on this host (at most
   * 512), it is created only by a `drain({ retain: true })` of an effect the caller
   * already finished - including the resample form, whose obligation is registered
   * BEFORE the caller's own foreground sample so that a successfully published
   * drain is never left without a driver when that sample fails - and only a drain
   * its exact store's committing sample
   * ACCOUNTED FOR, an exact `release`, an exact `quarantine` or `close` removes it.
   * It is never a queue of
   * OPERATIONS: the effect behind every entry has already finished and is never
   * re-authorized or run again - only its accounting is retried. Owning it HERE,
   * rather than in the host lifecycle that ran the effect, is what covers the
   * shutdown order in which a lifecycle closes before the engine drains its turns:
   * the last owner of this retry is the governor's own close.
   *
   * `attempts` counts only the BACKGROUND rounds this governor backed off on for
   * the entry, and it saturates at the retry rate's cap: it spaces the ONE
   * coalesced timer, it is never a budget that ends the obligation. It is metadata
   * of the durable ownership itself - at most one per claim this ledger charged -
   * and it never gates an ordinary operation, an exact release/quarantine or
   * `close`.
   */
  private readonly retainedDrains = new Map<string, RetainedDrain>();
  /**
   * The ONE pending background retry of those retained drains and the single round
   * that may be in flight. Both belong to the GOVERNOR, never to a claim: there is
   * one timer for every retained entry of this host, and a round is only scheduled
   * while an entry is still owned. `close` clears the timer and settles the
   * in-flight round BEFORE its final retry/quarantine, so no background write can
   * land after shutdown and no retry ever outlives the ownership it reconciles.
   */
  private drainRetry?: NodeJS.Timeout;
  private drainRound?: Promise<void>;
  constructor(private readonly config: () => ResourceConfig,
    directory?: string, private readonly now: () => number = Date.now) {
    this.resolvedDirectory = directory === undefined ? undefined : path.resolve(directory);
  }
  /**
   * ONE exclusive aggregate transaction.
   *
   * `commit` is an optional PRE-COMMIT hook: it runs inside this transaction,
   * after the decision and its validation and immediately BEFORE the ledger that
   * publishes it. A caller's local first publication therefore belongs to the
   * same exclusive decision: a definitive refusal above never reaches it, and a
   * failure of the commit below still leaves it behind as the recovery fence.
   */
  private async transaction<T>(run: (data: Ledger) => T, commit?: (result: T) => Promise<void> | void): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, 'transaction.lock');
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let attempt = 0; !handle; attempt++) {
      try {
        handle = await fs.open(lock, 'wx', 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows can deny CREATE_NEW while the previous lock is being deleted.
        // Retry only this exclusive acquisition, with the same bounded deadline;
        // real access failures still fail closed without replacing the lock.
        const turnover = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
        if (code !== 'EEXIST' && !turnover) {
          throw error;
        }
        if (attempt >= 200) {
          throw new WorkerError('resource_locked', `Resource transaction lock is unavailable (${code}): ${lock}. Restore account access if denied. For a stale lock, first confirm all worker hosts stopped, then remove only this lock; keep ledger.json.`, true);
        }
        await delay(25);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: this.host }));
      const file = path.join(this.directory, 'ledger.json');
      const namespaceFile = path.join(this.directory, 'namespace.json');
      const namespace = await fs.readFile(namespaceFile, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        } throw error;
      });
      // Initial creation is one durable two-phase publication: a distinct
      // PENDING marker first, then the canonical empty ledger, and only then the
      // established marker. An interruption between the marker and the empty
      // ledger is therefore resumable, and the resumed transaction accepts that
      // ledger only while it is still strictly empty, so no durable ownership can
      // be reset. An established marker never tolerates a missing or corrupt
      // ledger, and any other marker text fails closed.
      const establishedNamespace = JSON.stringify({ schema: 1, kind: 'os-user-resources' });
      const pendingNamespace = JSON.stringify({ schema: 1, kind: 'os-user-resources', state: 'pending' });
      if (namespace !== undefined && namespace !== establishedNamespace && namespace !== pendingNamespace) {
        throw new WorkerError('resource_corrupt', 'Restore the aggregate resource namespace metadata.');
      }
      const pending = namespace === pendingNamespace;
      let data: Ledger;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2) {
          throw new Error('Invalid resource ledger file');
        }
        if (namespace === undefined) {
          throw new WorkerError('resource_corrupt', 'Aggregate resource namespace is missing beside its ledger; refusing reset.');
        }
        data = ledgerSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
        if (pending && (data.sequence !== 0 || data.claims.length !== 0
          || Object.keys(data.policies).length !== 0 || Object.keys(data.stores).length !== 0)) {
          throw new WorkerError('resource_corrupt', 'An interrupted initial resource ledger already carries ownership; restore its established namespace marker instead of resetting it.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new WorkerError('resource_corrupt', `Restore the resource ledger at ${file}: ${String(error)}`);
        }
        // Only a crash of THIS initialization can leave a pending marker without
        // its ledger: an atomic-write temporary or the marker itself is not
        // metadata a reset could discard.
        const leftover = (name: string): boolean => name === 'transaction.lock' || (pending
          && (name === 'namespace.json' || /^(?:ledger|namespace)\.json\..+\.tmp$/.test(name)));
        const entries = await fs.readdir(this.directory);
        if (entries.some(name => !leftover(name))) {
          throw new WorkerError('resource_corrupt', `Missing ledger beside existing resource metadata at ${file}; refusing reset.`);
        }
        data = { schema: 1, sequence: 0, policies: {}, stores: {}, claims: [] };
      }
      if (namespace !== establishedNamespace) {
        if (namespace === undefined) {
          await atomicWrite(namespaceFile, pendingNamespace);
        }
        await atomicWrite(file, JSON.stringify(data)); await atomicWrite(namespaceFile, establishedNamespace);
      }
      // A dead process cannot renew a queue entry. Active effects remain charged
      // until a root owner proves drain; PID reuse errs toward retaining them.
      const dead = new Set<string>();
      for (const [host, policy] of Object.entries(data.policies)) {
        try {
          process.kill(policy.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            dead.add(host);
          }
        }
      }
      data.claims = data.claims.filter(c => c.state !== 'waiting' || !dead.has(c.host));
      data.claims = data.claims.filter(claim => {
        // A known drain is already decided: a dead process cannot make it
        // uncertain again, and the exact store's healthy sample reclaims it.
        if (claim.state === 'drained') {
          return true;
        }
        try {
          process.kill(claim.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // A PROVISIONAL handoff whose owner died was never acknowledged, so no
            // effect can have started from it: it is withdrawn as no-effect rather
            // than retained as an uncertain effect for a permit nobody holds. Only
            // real ownership is quarantined against a dead process.
            if (claim.state === 'provisional') {
              return false;
            }
            claim.state = 'quarantine';
          }
        }
        return true;
      });
      for (const store of Object.values(data.stores)) {
        if (store.write) {
          try {
            process.kill(store.write.pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              store.write.state = 'quarantine';
            }
          }
        }
      }
      for (const host of dead) {
        if (!data.claims.some(c => c.host === host)) {
          delete data.policies[host];
        }
      }
      data.claims = data.claims.filter(c => c.state !== 'waiting' || data.policies[c.host] !== undefined);
      // Withdraw every non-live WAITING ticket, and every non-live PROVISIONAL
      // handoff, before any decision reads the ledger: both are live only while
      // the caller that owns them kept polling them inside the bounded window. A
      // failed withdrawal, a crashed host or a closed consumer therefore cannot
      // keep head-of-line eligibility forever, while active, quarantined and
      // drained rows - real or uncertain effects - are never expired. A
      // provisional row that is still live keeps charging capacity exactly like an
      // admitted effect (see `reason`). A reconcile report is eligibility only and
      // never refreshes liveness. FIFO among the LIVING tickets is untouched: the
      // sweep only removes rows, so sequence order decides the rest.
      const now = this.now();
      for (const claim of data.claims) {
        if ((claim.state === 'waiting' || claim.state === 'provisional') && typeof claim.heartbeat !== 'number') {
          // A ledger written before per-ticket liveness cannot prove when this
          // ticket was queued. Give it exactly one full window to be polled
          // once; a ticket nobody owns is withdrawn by a later sweep.
          claim.heartbeat = now;
        }
      }
      data.claims = data.claims.filter(claim => (claim.state !== 'waiting' && claim.state !== 'provisional')
        || (typeof claim.heartbeat === 'number' && now - claim.heartbeat <= WAITING_TICKET_WINDOW_MS));
      // A known-drained reservation reserves nothing; it waits for the exact
      // store's healthy sample and is dropped after a bounded retention so the
      // bounded claim table can never fill with rows no store will reconcile.
      data.claims = data.claims.filter(claim => claim.state !== 'drained'
        || now - (claim.drainedAt ?? 0) <= DRAINED_TICKET_RETENTION_MS);
      const result = run(data);
      ledgerSchema.parse(data);
      const text = JSON.stringify(data);
      if (Buffer.byteLength(text) > 8 * 1024 ** 2) {
        throw new WorkerError('resource_capacity', 'Resource metadata exceeds 8 MiB. Reconcile quarantines and retire unused stores before admitting more work.');
      }
      // atomicWrite publishes by rename and leaves no temporary behind once it
      // resolves, so ITS RESOLUTION IS THE COMMIT: a reader can never observe a
      // partial ledger, and the caller is never told an effect was rejected while
      // the ledger already grants it.
      //
      // The pre-commit hook runs after the decision is final and before that
      // publication, so a local first publication scoped to THIS attempt can never
      // survive a definitive refusal, while a commit that fails after it still
      // leaves it in place as the recovery fence it is.
      await commit?.(result);
      await atomicWrite(file, text);
      return result;
    } finally {
      // Cleanup runs after the decision and can never change it: a resolved commit
      // stays granted, and a rejected attempt keeps its own primary error instead
      // of being masked here. A lock the bounded retry below could not release
      // stays in place, so the NEXT transaction fails closed with its path instead
      // of two writers ever sharing the ledger.
      await handle.close().catch(() => undefined);
      await this.removeLock(lock).catch(() => undefined);
    }
  }
  /**
   * Remove the exclusive transaction lock once its transaction is finished.
   *
   * Windows can deny the unlink while another program (an indexer, a real-time
   * scanner) still holds the handle that was just closed, which is why only that
   * transient denial is retried - with a bounded deadline. Every other failure is
   * reported unchanged, and a denial that outlasts the bound still leaves the lock
   * in place: the next transaction then fails closed with its path instead of two
   * writers ever sharing the ledger. Exclusive ownership is never weakened.
   */
  private async removeLock(lock: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rm(lock);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return;
        }
        const turnover = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!turnover || attempt >= 40) {
          throw error;
        }
        await delay(25);
      }
    }
  }
  /** This host's live User policy, validated, without touching the ledger. */
  private live(): ResourceConfig {
    return resourceConfigSchema.parse(this.config());
  }
  /**
   * Effective aggregate limits of the SHARED ledger, computed without publishing.
   *
   * Only a registration that exists in the ledger and is enabled can impose a
   * minimum: an unregistered observer contributes nothing (so it sees the shared
   * cap it would be admitted under, never its own unpublished setting), an already
   * registered host sees its published snapshot until `refreshPolicy` re-publishes
   * its live settings, and a disabled profile never narrows the hosts that still
   * participate. `config` supplies everything but the minima - liveness of this
   * host's own `enabled` flag and the fallback when nothing is registered.
   */
  private limits(data: Pick<Ledger, 'policies'>, config: ResourceConfig): ResourceConfig {
    const registered = Object.values(data.policies).map(peer => peer.config).filter(peer => peer.enabled);
    if (!registered.length) {
      return config;
    }
    return { ...config, modelCapacity: Math.min(...registered.map(p => p.modelCapacity)),
      runnableCapacity: Math.min(...registered.map(p => p.runnableCapacity)),
      runnerCapacity: Math.min(...registered.map(p => p.runnerCapacity)),
      storageBytes: Math.min(...registered.map(p => p.storageBytes)) };
  }
  /**
   * Publish this host's participation - only for a transaction that really owns an
   * effect or an explicit policy refresh. A disabled host is published as an
   * ABSENCE, never as a disabled profile, so it cannot keep narrowing the aggregate
   * minima of the hosts that still participate.
   */
  private policy(data: Ledger): ResourceConfig {
    const config = this.live();
    if (!config.enabled) {
      delete data.policies[this.host];
      return this.limits(data, config);
    }
    data.policies[this.host] = { pid: process.pid, config };
    if (Object.keys(data.policies).length > 256) {
      throw new WorkerError('resource_capacity', 'Too many resource host registrations; reconcile stopped hosts.');
    }
    return this.limits(data, config);
  }
  private reason(data: LedgerView, candidate: Claim, policy: ResourceConfig, virtual?: readonly Claim[],
    classification?: { storageCapacity?: boolean }): WaitingReason | undefined {
    // Only live or uncertain ownership consumes capacity. A 'waiting' ticket
    // holds nothing yet, and a 'drained' reservation is a known-finished effect
    // whose bytes are the exact store's sample, not a second reservation. A
    // 'provisional' handoff is neither: it already owns the capacity its effect
    // will use, so it is charged exactly like an active claim until it is
    // acknowledged (becoming 'active') or withdrawn as no-effect.
    // `virtual` carries the older eligible contenders of the same decision: they
    // order this queue exactly like real grants, but they are never persisted for
    // another caller here.
    const active = data.claims.filter(c => (c.state === 'active' || c.state === 'quarantine' || c.state === 'provisional') && c !== candidate);
    if (virtual?.length) {
      active.push(...virtual.filter(c => c !== candidate));
    }
    const full = (claims: Claim[], capacity: number, reserve: number = policy.serviceReserve): boolean => claims.length >= capacity || (candidate.lane === 'work' && claims.filter(c => c.lane === 'work').length >= capacity - reserve);
    // ONE classification per resource FAMILY. Its applicable bounds - the
    // aggregate cap and the candidate's own local cap - are folded into a single
    // predicate built from `full()`, evaluated in the same order as before, and
    // the family reports 'quarantine' only when it is blocked by ALL live
    // ownership but has room once the quarantined rows are filtered out. A
    // quarantine that merely occupies a limit another live claim would fill
    // anyway - a service-lane row filling the overall cap while ordinary work
    // already fills its reserved share, an ordinary local holder, or a same-kind
    // row of another scope - therefore never relabels an ordinary capacity wait.
    // Eligibility is untouched: the predicate is exactly the previous union.
    const family = (claims: Claim[], capacity: WaitingReason, aggregate: number,
      local: number, localReserve: number, sameLocal: (c: Claim) => boolean): WaitingReason | undefined => {
      const blocked = (rows: Claim[]): boolean => full(rows, aggregate) || full(rows.filter(sameLocal), local, localReserve);
      if (!blocked(claims)) {
        return undefined;
      }
      return blocked(claims.filter(c => c.state !== 'quarantine')) ? capacity : 'quarantine';
    };
    if (candidate.kind === 'model') {
      if (candidate.localBlocked) {
        return 'model_capacity';
      }
      // The local model bound carries no lane reserve, so it is `full()` with a
      // zero reserve, i.e. the plain local count it has always been.
      const blocked = family(active.filter(c => c.kind === 'model'), 'model_capacity',
        policy.modelCapacity, candidate.localCapacity, 0,
        c => c.scope === candidate.scope && c.model === candidate.model);
      if (blocked !== undefined) {
        return blocked;
      }
    }
    if ((candidate.kind === 'model' || candidate.kind === 'tool') && full(active.filter(c => c.kind === 'model' || c.kind === 'tool'), policy.runnableCapacity)) {
      return 'runnable_capacity';
    }
    if (candidate.kind === 'runner' && candidate.localBlocked) {
      return 'runner_capacity';
    }
    if (candidate.kind === 'runner') {
      const blocked = family(active.filter(c => c.kind === 'runner'), 'runner_capacity',
        policy.runnerCapacity, candidate.localCapacity, candidate.localCapacity > 1 ? 1 : 0,
        c => c.scope === candidate.scope);
      if (blocked !== undefined) {
        return blocked;
      }
    }
    const unknown = Object.values(data.stores).filter(s => s.uncertain || s.write);
    if (unknown.length) {
      return unknown.some(s => s.accounting === 'quarantine' || s.write?.state === 'quarantine') ? 'quarantine' : 'storage';
    }
    // Retained store samples plus EVERY live charge - a quarantined reservation
    // included, because it really holds its bytes - decide admission exactly as
    // they always have (`attempt` bounds the new reservation the same way). Only
    // the LABEL of a byte refusal is refined here: when those healthy samples and
    // the live charges would fit once the quarantined reservations were released,
    // the wait is an actionable quarantine of exact effects and not bytes the
    // caller could never reclaim by collecting evidence, so it is reported as
    // such. Ordinary storage is kept whenever the wait would remain even without
    // them. `storageCapacity` records that this family - never a model, runner or
    // unknown-store fence - is what binds, so the FIFO protection in
    // `admissionReason` keeps spanning the relabeled wait.
    const limit = policy.storageBytes * (candidate.lane === 'work' ? 0.875 : 1);
    const used = Object.values(data.stores).reduce((n, s) => n + s.bytes, 0) + active.reduce((n, c) => n + c.bytes, 0);
    if (used + candidate.bytes > limit) {
      if (classification) {
        classification.storageCapacity = true;
      }
      const quarantined = active.reduce((n, c) => n + (c.state === 'quarantine' ? c.bytes : 0), 0);
      return used - quarantined + candidate.bytes > limit ? 'storage' : 'quarantine';
    }
    return undefined;
  }
  /** Include fair-queue headroom protection in both admission and inspection. */
  private admissionReason(data: LedgerView, candidate: Claim, policy: ResourceConfig, virtual?: readonly Claim[]): WaitingReason | undefined {
    const direct = this.reason(data, candidate, policy, virtual);
    if (direct) {
      return direct;
    }
    if (candidate.bytes > 0 && data.claims.some(c => c.state === 'waiting' && c.sequence < candidate.sequence
      && (c.lane === 'work') === (candidate.lane === 'work') && c.bytes > 0 && this.storageBlocked(data, c, policy, virtual))) {
      return 'storage';
    }
    return undefined;
  }
  /**
   * Would this older ticket be blocked by STORAGE CAPACITY - as an ordinary
   * storage wait, or as the quarantine that releasing its exact reservations would
   * explain? A younger same-lane reservation must not overtake it in either form,
   * exactly as it never overtook a plain storage wait.
   *
   * A quarantine that belongs to a model, runner or another family is NOT a
   * storage blocker: that older ticket is blocked by something releasing storage
   * cannot free, so it never gated younger bytes. `classification` is the private
   * out-parameter of the ONE byte comparison in `reason`, so the distinction costs
   * no second decision and changes neither eligibility nor virtual FIFO order.
   */
  private storageBlocked(data: LedgerView, claim: Claim, policy: ResourceConfig, virtual?: readonly Claim[]): boolean {
    const classification: { storageCapacity?: boolean } = {};
    const blocked = this.reason(data, claim, policy, virtual, classification);
    return blocked === 'storage' || classification.storageCapacity === true;
  }
  /**
   * ONE FIFO ladder over the LIVE waiting tickets the transaction sweep left, in
   * sequence order. Each step is either the reason that ticket must keep waiting,
   * or `undefined` when it is the oldest eligible live contender - i.e. when ITS
   * OWN poll may activate exactly that ticket.
   *
   * This is the ONLY queue ordering. Admission walks the ladder until it reaches
   * its own ticket, and inspection collects every step of ONE traversal, so a late
   * status page costs one queue pass instead of one per row and the two can never
   * disagree about eligibility or virtual grants.
   *
   * Nothing is mutated here, for any ticket on any host. An older eligible
   * contender is charged as a VIRTUAL grant, so it orders the queue exactly like
   * a real activation would, but no caller ever publishes another poll's grant:
   * a cancelled ticket whose withdrawal failed, a sibling on this same governor or
   * a ticket of another host stays 'waiting' until its own live poll runs. A
   * ticket that outlived its liveness window was already withdrawn by the sweep,
   * so it cannot lead the queue and cannot be revived as active either.
   *
   * Oldest ELIGIBLE request wins; a blocked model, root or lane cannot obstruct
   * independent validation. Runner tickets are handed over physically and
   * separately: eligibility is physical (`localBlocked`), aggregate and local
   * bound, and exactly one runner handoff exists, so only the oldest eligible
   * runner ticket may be activated per poll.
   */
  private *ladder(data: LedgerView, policy: ResourceConfig): Generator<{ ticket: Claim; reason: WaitingReason | undefined }> {
    const virtual: Claim[] = [];
    let handoff = false;
    for (const next of data.claims.filter(c => c.state === 'waiting').sort((a, b) => a.sequence - b.sequence)) {
      if (next.kind === 'runner' && handoff) {
        yield { ticket: next, reason: 'runner_capacity' };
        continue;
      }
      const blocked = this.admissionReason(data, next, policy, virtual);
      if (blocked !== undefined) {
        yield { ticket: next, reason: blocked };
        continue;
      }
      yield { ticket: next, reason: undefined };
      if (next.kind === 'runner') {
        // An older eligible runner ticket keeps the single physical handoff
        // until its own pool polls it.
        handoff = true;
      }
      virtual.push(next);
    }
  }
  /** PURE FIFO decision for one polled ticket, from the shared ladder. */
  private decision(data: LedgerView, candidate: Claim, policy: ResourceConfig): WaitingReason | undefined {
    for (const step of this.ladder(data, policy)) {
      if (step.ticket === candidate) {
        return step.reason;
      }
    }
    // A candidate the sweep did not leave waiting (defensive: admission only asks
    // about its own waiting ticket) still gets the final rule of its own poll.
    return this.admissionReason(data, candidate, policy) ?? (candidate.kind === 'runner' ? 'runner_capacity' : undefined);
  }
  /**
   * The decisions of the waiting tickets ON THIS PAGE, collected from ONE ladder
   * traversal with exactly the order and rules a poll of each ticket would apply.
   *
   * The ladder is FIFO, so a page that starts deep in the queue still has to walk
   * the tickets ahead of it - but only until the last of its own waiting rows is
   * decided: the rows after the page are never computed here, and an early page
   * costs one pass over its own prefix instead of the whole queue.
   */
  private waitingDecisions(data: LedgerView, policy: ResourceConfig, page: readonly Claim[]): Map<Claim, WaitingReason | undefined> {
    const reasons = new Map<Claim, WaitingReason | undefined>();
    const pending = new Set(page.filter(c => c.state === 'waiting'));
    if (!pending.size) {
      return reasons;
    }
    for (const step of this.ladder(data, policy)) {
      if (pending.delete(step.ticket)) {
        reasons.set(step.ticket, step.reason);
        if (!pending.size) {
          break;
        }
      }
    }
    return reasons;
  }
  /**
   * Publish live User policy even when this host has no pending admissions.
   *
   * `enable` is a READER of the raw trusted opt-in the host already consults at
   * every decision point - a switch, never a resource limit - and it is invoked
   * INSIDE the transaction, immediately before the limits are read. An explicit
   * `false` therefore withdraws this host's registered profile without parsing
   * values it no longer uses, so a host that opted out stops narrowing the
   * aggregate minima of the hosts that still participate even when its remaining
   * capacity settings are malformed.
   *
   * Reading it under the lock, rather than capturing it at the call site, keeps a
   * notification queued behind another transaction from publishing a STALE flag:
   * whatever the reader answers is the value at commit time, so a slow opt-out can
   * never apply after a newer opt-in. `true` and `undefined` - and every direct
   * caller that passes no reader at all - keep the established path, which
   * publishes the live, fully validated config and withdraws on its own disabled
   * flag. Only `data.policies[this.host]` is ever removed here: outstanding claims
   * and their charges are preserved exactly as they are. A throwing reader aborts
   * the refresh before any write, and the caller's existing handler reports it.
   */
  async refreshPolicy(enable?: () => boolean | undefined): Promise<void> {
    if (this.closing) {
      return;
    }
    await this.transaction(data => {
      if (this.closing) {
        return;
      }
      if (enable?.() === false) {
        delete data.policies[this.host];
        return;
      }
      this.policy(data);
    });
  }
  async tryAcquire(input: ResourceRequest): Promise<{ granted: boolean; reason?: WaitingReason }> {
    const result = await this.attempt(input, false);
    return result.granted ? { granted: true } : { granted: false, reason: result.reason };
  }
  /**
   * The one admission decision and transition, shared by `tryAcquire` and
   * `acquire`.
   *
   * `handoff` is true only for `acquire`, whose caller still has to run its own
   * fallible handoff steps - the grant callback and the cancellation check -
   * before it may own an effect. Such a grant is durable but PROVISIONAL: it
   * already owns its queue position and charges capacity, it is never treated as
   * an effect by any sweep, quarantine or close, and it becomes a real effect only
   * through `acknowledge`. Direct tryAcquire callers keep the established
   * behaviour: one transaction, and a durable 'active' claim as soon as admission
   * succeeds. Such a caller can never observe - or activate - another caller's
   * provisional handoff: that mixed-API collision is denied as 'quarantine'.
   */
  private async attempt(input: ResourceRequest, handoff: boolean): Promise<{ granted: boolean; reason?: WaitingReason }> {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'Resource owner is closing.', true);
    }
    const scope = input.kind === 'model' && input.scope ? await this.resourceScope(input.scope) : input.scope ?? input.root;
    return this.transaction(data => {
      const policy = this.policy(data);
      if (!policy.enabled) {
        throw new WorkerError('feature_disabled', 'Enable codexSubagent.resources.enabled in User Settings for governed workers.');
      }
      // One clock read per transaction decides ticket liveness, and it is applied
      // to the polling ticket ALONE - never to the siblings refreshed for
      // eligibility below.
      const now = this.now();
      const storageLimit = policy.storageBytes * ((input.lane ?? 'work') === 'work' ? 0.875 : 1);
      const retainedBytes = Object.values(data.stores).reduce((n, s) => n + s.bytes, 0);
      if (retainedBytes + (input.bytes ?? 0) > storageLimit) {
        throw new WorkerError('storage_exhausted', `Retained stores use ${retainedBytes} bytes; this operation reserves ${input.bytes ?? 0}, exceeding its ${storageLimit}-byte lane budget. Collect unreferenced command results and expired receipts, release completed view consumers, then retry the same request. Validation/integration retain one eighth of storage headroom.`, true);
      }
      let claim = data.claims.find(c => c.key === input.key);
      if (claim && claim.host !== this.host) {
        throw new WorkerError('resource_quarantine', 'This resource belongs to an earlier host; reconcile its exact root before retrying.');
      }
      if (input.kind === 'model') {
        // One owning store observes its legacy reservations synchronously.
        // Refresh every waiting ticket in that exact local model scope, so a
        // younger poll cannot bypass an older ticket with stale eligibility.
        for (const waiting of data.claims.filter(c => c.host === this.host && c.kind === 'model' && c.state === 'waiting'
          && c.scope === scope && c.model === (input.model ?? ''))) {
          waiting.localCapacity = input.localCapacity ?? 1; waiting.localBlocked = input.localBlocked === true;
        }
      } else if (input.kind === 'runner') {
        // The owning pool holds its own mutex and asked for admission only after
        // it proved a usable physical slot for this handoff, so every waiting
        // ticket in that exact host/scope is physically eligible right now; the
        // local capacity it reports is the one its own bound must apply.
        //
        // This refresh is ELIGIBILITY only. Liveness is per ticket and strictly
        // its own (see below): refreshing siblings here would keep a cancelled
        // ticket alive forever whenever any other request in the same pool kept
        // polling - exactly the head-of-line leak this must prevent.
        for (const waiting of data.claims.filter(c => c.host === this.host && c.kind === 'runner' && c.state === 'waiting'
          && c.scope === scope)) {
          waiting.localCapacity = input.localCapacity ?? 1; waiting.localBlocked = false;
        }
      } else if (claim?.state === 'waiting') {
        claim.localCapacity = input.localCapacity ?? 1;
      }
      if (!claim) {
        if (!Number.isSafeInteger(data.sequence + 1)) {
          if (data.claims.length) {
            throw new WorkerError('resource_capacity', 'Resource ordering counter exhausted; drain or quarantine and archive this resource namespace.');
          } data.sequence = 0;
        }
        if (data.claims.length >= 512 || ((input.lane ?? 'work') === 'work' && data.claims.filter(c => c.lane === 'work').length >= 480)) {
          throw new WorkerError('resource_capacity', 'Resource queue/ownership ledger is full for this lane (512 total, at most 480 work). Cancel queued work or reconcile quarantined effects; 32 entries are reserved for validation/integration.');
        }
        claim = { key: input.key, host: this.host, pid: process.pid, kind: input.kind, lane: input.lane ?? 'work', root: input.root,
          scope, model: input.model ?? '', localCapacity: input.localCapacity ?? 1,
          bytes: input.bytes ?? 0, localBlocked: input.localBlocked === true, sequence: ++data.sequence, state: 'waiting',
          heartbeat: now };
        data.claims.push(claim);
      }
      if (claim.state === 'waiting') {
        // A ticket's liveness is refreshed by its OWN poll only, for every kind:
        // a cancelled request whose ledger withdrawal failed is never polled
        // again, so it expires on schedule instead of holding the queue or being
        // revived as active, while a sibling poll refreshes nothing but itself.
        claim.heartbeat = now;
      }
      if (claim.state === 'quarantine') {
        return { granted: false, reason: 'quarantine' };
      }
      if (claim.state === 'active') {
        return { granted: true };
      }
      if (claim.state === 'drained') {
        // A known-drained row is NEVER revived into a grant: this identity's
        // bytes have no post-drain measurement yet, so a grant here would admit
        // an effect on a stale sample. It waits instead, and the exact store's
        // next successful sample removes the row so a retry admits normally.
        return { granted: false, reason: 'quarantine' };
      }
      if (claim.state === 'provisional') {
        // Only `acquire` ever creates this state, and only for the exact key it is
        // handing off on this host, so a `handoff` attempt is its own
        // unacknowledged grant coming back (a retried acknowledgement). It is
        // neither an effect to adopt nor a ticket to re-decide: keep its queue
        // position and refresh only its own liveness, exactly like a ticket's own
        // poll.
        if (handoff) {
          claim.heartbeat = now;
          return { granted: true };
        }
        // A mixed-API collision: a caller of `tryAcquire` - `attempt(input, false)`
        // - asked for the exact key an unacknowledged handoff still owns. That row
        // is charged capacity but is NOT an admitted effect, so granting here would
        // hand out an unowned grant, and activating it would let a caller that
        // never acknowledged take over another caller's handoff. Deny with the
        // fenced-identity reason instead: only `acknowledge` or this row's own
        // bounded liveness window settles it, and neither is reachable here.
        return { granted: false, reason: 'quarantine' };
      }
      // Oldest ELIGIBLE live request wins; a blocked model, root or lane cannot
      // obstruct independent validation. No resource is held while waiting.
      //
      // The decision is pure: older eligible contenders are charged virtually, so
      // FIFO spans hosts and sibling tickets on this same governor, and the ONLY
      // row this transaction may change is the polling ticket itself. A cancelled
      // ticket whose withdrawal failed is therefore never persisted as active by
      // another poll; it waits for its own poll or for its liveness window to end.
      const blocked = this.decision(data, claim, policy);
      if (blocked !== undefined) {
        return { granted: false, reason: blocked };
      }
      if (handoff) {
        // The decision is final, but the caller has taken no effect yet: its own
        // callback and cancellation check still have to complete. Record that
        // grant durably as PROVISIONAL, which already owns the queue position and
        // already charges capacity, so a cancellation in that window leaves a
        // bounded no-effect row instead of an unacknowledged effect.
        claim.state = 'provisional';
        claim.heartbeat = now;
        return { granted: true };
      }
      claim.state = 'active';
      // An active ticket is an admitted effect, not a queue entry: it carries no
      // liveness stamp, so no sweep can ever treat it as an abandoned ticket.
      delete claim.heartbeat;
      return { granted: true };
    });
  }
  async acquire(input: ResourceRequest, signal: AbortSignal = new AbortController().signal, waiting?: (reason?: WaitingReason) => Promise<void>, queue = true): Promise<ResourcePermit> {
    try {
      while (true) {
        signal.throwIfAborted();
        const result = await this.attempt(input, true);
        if (result.granted) {
          // The grant is durable but still PROVISIONAL, so no effect can exist yet.
          // Every fallible handoff step - the caller's own grant callback and its
          // cancellation check - therefore completes BEFORE the durable
          // acknowledgement that makes this claim an effect. A cancellation here
          // withdraws a no-effect row; if even that withdrawal fails, what survives
          // is a bounded provisional row, never an unacknowledged active claim, a
          // quarantine, or a charge that a closing host would keep forever.
          await waiting?.();
          signal.throwIfAborted();
          if (!await this.acknowledge(input.key)) {
            // The provisional row is gone (withdrawn by its own liveness window) or
            // no longer grantable: re-admit instead of handing off an unowned effect.
            continue;
          }
          // Deliberately nothing fallible between the acknowledgement and the
          // permit: an abort from here on is settled by the caller that owns it.
          return { release: () => this.release(input.key), quarantine: () => this.quarantine(input.key),
            drain: async options => {
              try {
                await this.drain(input.key, input.store);
              } catch (error) {
                // Only a caller that already FINISHED its effect asks to retain:
                // its publication failed, so this exact claim must stay reachable
                // for the reconciliation and the final close of THIS governor.
                if (options?.retain) {
                  // A repeated failure of the SAME claim keeps the backoff step it
                  // already reached instead of restarting a fresh obligation: that is
                  // the persistent case, and it is retried at the SAME capped rate.
                  this.retainedDrains.set(input.key, { store: input.store,
                    attempts: this.retainedDrains.get(input.key)?.attempts ?? 0 });
                  // Owner-driven progress. Until this exact claim's known drain is
                  // published it keeps charging the store its effect finished in, and
                  // nothing else is guaranteed to publish it: a queued ticket of
                  // ANOTHER host or root only polls its own eligibility, a new
                  // admission and a later store reopen may never happen, and an
                  // ordinary sample can never reclaim an ACTIVE charge. So this
                  // governor schedules ONE coalesced retry of its own.
                  this.scheduleRetainedDrains();
                }
                throw error;
              }
              if (!options?.resample) {
                this.retainedDrains.delete(input.key);
                return;
              }
              // The publication committed, but it is not yet an acknowledged
              // recovery: the exact store stays fenced and this claim is only
              // published as drained until a sample of THAT store accounts for it.
              // The caller's own foreground sample is now the only driver of that
              // reconciliation, so the obligation is registered FIRST - before the
              // callback runs - and only its committing transaction (exact store AND
              // exact claim) settles the entry. A successful publication whose
              // sample fails or is superseded therefore still owns the obligation,
              // and the bounded coalesced retry is armed in the `finally` instead of
              // racing a sample that is still in progress.
              //
              // `foreground` keeps that promise even when a coalesced timer was
              // ALREADY armed for another retained claim - or for an older sibling
              // of this exact store: a round snapshots every entry, so without the
              // marker it would start its own sample of this store and supersede
              // the callback that is running right now. A marked entry is instead
              // invisible to background eligibility, and the marker is cleared
              // exactly once its callback settled, in the same `finally` that
              // re-arms the retry only while something is still owed.
              const entry: RetainedDrain = { store: input.store,
                attempts: this.retainedDrains.get(input.key)?.attempts ?? 0, foreground: true };
              this.retainedDrains.set(input.key, entry);
              try {
                await options.resample();
              } finally {
                if (this.retainedDrains.get(input.key) === entry) {
                  this.retainedDrains.set(input.key, { store: entry.store, attempts: entry.attempts });
                }
                this.scheduleRetainedDrains();
              }
            } };
        }
        if (!queue) {
          // The remedy the reason names is the remedy the caller must take: a
          // quarantine is settled only by reconciling THAT exact effect (or
          // reopening its exact store), never by collecting evidence, and nothing
          // is released automatically.
          throw new WorkerError('resource_busy', 'Resource admission is waiting for ' + result.reason + '. No new effect was started.'
            + (result.reason === 'quarantine'
              ? ' Reconcile the exact quarantined effect, or reopen its exact store, before retrying.'
              : ' Retry after capacity is available, or collect unreferenced evidence and receipts.'), true);
        }
        await waiting?.(result.reason);
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      await this.release(input.key); throw error;
    }
  }
  /**
   * Acknowledge a provisional handoff as a real, admitted effect.
   *
   * One transaction makes the state change and, with it, the durable ownership:
   * from here the claim is charged as an effect, is never expired by ticket
   * liveness, and is retained (or quarantined) instead of withdrawn when its owner
   * goes away. `false` means the provisional row is gone or no longer grantable,
   * so the caller must re-admit rather than perform an effect it does not own.
   *
   * A rejected attempt therefore never leaves an unowned ACTIVE row: a pre-commit
   * failure is the caller's error, while a post-commit cleanup failure is not
   * observable here at all, because `transaction` resolves exactly when the
   * published ledger is the commit.
   */
  private async acknowledge(key: string): Promise<boolean> {
    return this.transaction(data => {
      const claim = data.claims.find(c => c.key === key && c.host === this.host);
      if (claim?.state === 'provisional') {
        claim.state = 'active';
        delete claim.heartbeat;
        return true;
      }
      // Already acknowledged by an earlier attempt of this same handoff.
      return claim?.state === 'active';
    });
  }
  /** Yield an unused model grant without losing its fair-queue identity. */
  async deferModel(key: string): Promise<void> {
    await this.transaction(data => {
      const claim = data.claims.find(c => c.key === key && c.host === this.host);
      if (!claim || claim.kind !== 'model' || claim.state !== 'active') {
        throw new WorkerError('resource_conflict', 'Only an owned, unused active model grant can return to the queue.');
      }
      // Returning to the queue keeps the identity and starts a fresh liveness
      // window: from here only this ticket's own poll can take the handoff.
      claim.state = 'waiting'; claim.localBlocked = true; claim.heartbeat = this.now();
    });
  }
  /**
   * Remove exactly these claim keys, and only rows THIS host owns, in one scoped
   * transaction: another host's identical key is never touched, and hashing a
   * whole batch costs one lock and one commit.
   */
  private async withdraw(keys: ReadonlySet<string>): Promise<void> {
    if (!keys.size) {
      return;
    }
    await this.transaction(data => {
      data.claims = data.claims.filter(c => c.host !== this.host || !keys.has(c.key));
    });
  }
  async release(key: string): Promise<void> {
    await this.withdraw(new Set([key]));
    // An exact release settles this claim, so no retained drain may outlive it.
    this.retainedDrains.delete(key);
  }
  async quarantine(key: string): Promise<void> {
    // An exact quarantine is this caller's decision about its own claim, so the
    // retained retry obligation for that same claim ends here.
    this.retainedDrains.delete(key);
    await this.transaction(data => {
      const c = data.claims.find(c => c.key === key && c.host === this.host);
      if (c?.state === 'provisional') {
        // A handoff nobody acknowledged owns no effect, so it can never be an
        // uncertain one: withdraw it instead of retaining it as a permanent charge.
        data.claims = data.claims.filter(claim => claim !== c);
      } else if (c) {
        c.state = 'quarantine';
      }
    });
  }
  /**
   * Record a KNOWN drain - atomically - instead of quarantining a permit whose
   * effect already finished, and before the caller performs its final accounting.
   *
   * A quarantine means "the effect may still be running". That is wrong for a
   * permit whose action completed and whose only failure was a final accounting or
   * release step, and simply dropping the row is not safe either: a measurement
   * that STARTED before the drain may still complete with a value that predates
   * it, and a caller must never be admitted from stale storage data.
   *
   * So one transaction does both halves:
   *   - the row becomes 'drained' (it reserves nothing, is never granted, and is
   *     never turned back into an active effect), naming the exact registered
   *     store whose bytes it belonged to;
   *   - that exact store is fenced unconditionally - whatever its previous sample
   *     said - and its sample identity is rotated, so every sample already in
   *     flight can no longer succeed or fail against it (account() only commits a
   *     sample whose own identity still matches).
   * The fence keeps admission closed until a sample that STARTED after this drain
   * succeeds; that success clears both the fence and the drained row. Only that
   * exact store can do it: an active effect, an uncertain claim or another store's
   * sample is never touched. A ledger failure throws, leaving the caller's
   * ownership durable and untouched.
   */
  async drain(key: string, store?: string): Promise<void> {
    const scope = store === undefined ? undefined : await this.resourceScope(path.resolve(store));
    const storeKey = scope === undefined ? undefined : digest(scope);
    const context = this.writer.getStore();
    const deadline = Date.now() + 360_000;
    while (!await this.transaction(data => {
      const claim = data.claims.find(c => c.key === key && c.host === this.host);
      if (!claim || claim.state === 'waiting' || claim.state === 'drained') {
        return true;
      }
      if (claim.state === 'provisional') {
        // A provisional handoff never became an effect, so there is nothing to
        // drain and nothing to fence: withdraw the no-effect row instead of
        // retaining it as a charge.
        data.claims = data.claims.filter(c => c !== claim);
        return true;
      }
      const previous = storeKey === undefined ? undefined : data.stores[storeKey];
      const write = previous?.write;
      // Check and rotate the sample under the same ledger lock. An active
      // checkpoint may have started since the previous retry.
      if (write?.state === 'active' && (context?.key !== storeKey || context?.id !== write.id)) {
        return false;
      }
      if (storeKey === undefined || scope === undefined) {
        data.claims = data.claims.filter(c => c !== claim);
        return true;
      }
      claim.state = 'drained';
      claim.drainedAt = this.now();
      claim.store = storeKey;
      data.stores[storeKey] = {
        ...previous,
        directory: previous?.directory ?? scope,
        bytes: previous?.bytes ?? 0,
        sampleId: randomUUID(),
        accounting: 'quarantine',
        uncertain: true,
        diagnostic: 'A drained permit is reconciled by the next successful sample of this exact store.'
      };
      if (Object.keys(data.stores).length > 256) {
        throw new WorkerError('resource_capacity', '256 stores are registered; reconcile retained namespaces before adding another store.');
      }
      return true;
    })) {
      if (Date.now() >= deadline) {
        throw new WorkerError('resource_busy', 'A checkpoint write on this exact store is still active. Retry after it finishes, or reopen its exact store to reconcile.', true);
      }
      await delay(25);
    }
  }
  /**
   * Publish the KNOWN drain of every finished effect whose earlier publication did
   * not commit, and report the ones that still fail.
   *
   * `store` retries only the claims of that exact store - the store a host is
   * about to resample, whose ONE healthy sample then reclaims the drained rows and
   * clears their fences - and `undefined` retries every retained claim, which is
   * what `close` does. `drain` is idempotent for a claim that is already drained or
   * already reclaimed, so a repeated or concurrent retry can neither double charge
   * nor inventory a second effect.
   *
   * Failures are RETURNED instead of thrown: retrying a finished effect's
   * accounting must never fail the unrelated operation that happens to reconcile
   * first. A claim that keeps failing stays retained (never released, never
   * quarantined here), so it remains fail-closed and is retried again - and at the
   * latest by `close`, which either publishes it or retains it as the uncertain
   * charge that persistent failure or a crash really is.
   *
   * This is the drain-only form: its callers resample the exact store right
   * afterwards (`withStorage`/`execute` do), so the ONE healthy sample reclaims a
   * published row and clears its fence without a second measurement here. It never
   * ends the obligation of a claim that names a store: only the `account` commit of
   * a sample that really accounted for that exact claim settles the entry, so a
   * caller whose own sample then fails cannot drop the only handle on a fenced
   * store. The self-driven background round is different - nobody else will sample
   * on its behalf - and is the only pass that also resamples (see
   * `runRetainedDrains`).
   */
  async retryRetainedDrains(store?: string): Promise<{ key: string; error: unknown }[]> {
    return this.settleRetainedDrains(store, false, false);
  }
  /**
   * The ONE publication pass over this governor's retained drains, shared by every
   * caller and by the coalesced background round.
   *
   * Only accounting and ownership are ever retried here. The effect behind an entry
   * has already finished, `drain` is a no-effect transition for a known-drained or
   * already-reclaimed claim, and no claim outside this exact map and no other
   * store is touched - an unrelated or merely uncertain permit is never re-authorized,
   * released or quarantined by a retry.
   *
   * `resample` adds the sample the background round owes and no ordinary caller
   * needs: after the publications of ONE round landed, the exact stores they
   * touched are resampled through the ordinary `account`/`storageUsage` path, which
   * reclaims the published rows and clears their fences, so a QUEUED WAITER of
   * another host or root is admitted by its own next poll instead of waiting for an
   * operation that may never come. If that sample fails, the published fence and
   * the drained rows remain durable and the exact claims stay retained, so a
   * healthy resume still reclaims them.
   *
   * An entry that names a store is therefore settled by NEITHER phase directly: it
   * leaves this map only when a sample of that exact store commits and accounts for
   * its claim, which `account` reports from inside its own current-sample commit.
   * Publishing the drain is not the same as reclaiming its charge, so a drain-only
   * pass (and a round whose sample failed or was superseded by a concurrent writer)
   * leaves the obligation owned instead of dropping the only handle on a fenced
   * store. An entry WITHOUT a store has nothing left to reconcile - `drain` already
   * withdrew that claim - and is settled as soon as it was published.
   *
   * The two phases are deliberately separate. PUBLICATION comes first, for every
   * due claim, and a publication writes ledger metadata only: it never measures.
   * Only then is each store sampled, and at most ONCE per exact store - a round
   * that measured once per CLAIM would let concurrent samples of the same store
   * supersede each other (each rotates the store's sample identity, so all but one
   * of them is discarded) while walking the same directory tree N times. That is
   * why the claims are grouped by resolved store, and why the groups are sampled
   * one after another rather than in parallel.
   *
   * `background` marks an attempt of the rate-capped scheduler: only it advances the
   * entry's own saturated backoff metadata, so an ordinary operation or `close` is
   * never gated by metadata meant to space a background loop.
   *
   * `excludedStores` keeps the exact stores out whose own shutdown pass already ran:
   * `close` publishes AND samples those while it still owns them, and a drain-only
   * retry afterwards could only publish a fence nothing would ever sample again.
   */
  private async settleRetainedDrains(store: string | undefined, resample: boolean,
    background: boolean, excludedStores?: ReadonlySet<string>): Promise<{ key: string; error: unknown }[]> {
    const due = [...this.retainedDrains].filter(([, retained]) => (store === undefined
      || (retained.store !== undefined && path.resolve(retained.store) === path.resolve(store)))
      && !(excludedStores !== undefined && retained.store !== undefined
        && excludedStores.has(path.resolve(retained.store)))
      // A background round may never act on an entry whose owner is measuring that
      // exact store right now: its own committing sample is the acknowledgement,
      // and a second measurement would supersede it instead of settling anything.
      // The entry stays owned and becomes due again once its callback settled.
      && !(background && retained.foreground === true));
    const failures: { key: string; error: unknown }[] = [];
    const published: [string, RetainedDrain][] = [];
    // Publish every due drain before measuring any store. Each publication
    // invalidates older samples without superseding the measurement below.
    await Promise.all(due.map(async ([key, captured]) => {
      try {
        await this.drain(key, captured.store);
        published.push([key, captured]);
      } catch (error) {
        failures.push({ key, error });
        // An unpublished drain is still charged, so its claim stays retained, and
        // only a background round advances its saturated backoff metadata.
        this.keepRetainedDrain(key, captured, background);
      }
    }));
    // A claim that finished WITH A STORE still needs that store's sample, which is
    // PHASE 2. A claim without one has nothing left to reconcile - `drain` already
    // withdrew it - so it is settled here.
    const groups = new Map<string, [string, RetainedDrain][]>();
    for (const [key, captured] of published) {
      if (captured.store === undefined) {
        this.settleRetainedDrain(key, captured);
        continue;
      }
      if (!resample) {
        // Drain only: the caller samples this exact store itself, and `account`
        // settles the entry from the commit that accounts for its claim.
        this.keepRetainedDrain(key, captured, background);
        continue;
      }
      const directory = path.resolve(captured.store);
      const group = groups.get(directory) ?? [];
      group.push([key, captured]);
      groups.set(directory, group);
    }
    // PHASE 2 - ONE sample per exact store, one store at a time. The healthy sample
    // reclaims the drained row of EVERY claim of that store and clears its single
    // fence, and its commit settles exactly the entries whose claim it accounted
    // for; a failed or superseded sample settles nothing and keeps all of them - the
    // fence it left behind is the only thing that can still reclaim them.
    for (const [directory, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      // An OLDER retained sibling of this same store may be publishing while the
      // owner's own foreground sample of it is in progress. Measuring here would
      // supersede that sample without settling anything, so a background round
      // leaves the whole store for the next round; the caller's committing sample
      // settles these entries too, from the same commit.
      if (background && [...this.retainedDrains.values()].some(retained =>
        retained.foreground === true && retained.store !== undefined
        && path.resolve(retained.store) === directory)) {
        for (const [key, captured] of group) {
          this.keepRetainedDrain(key, captured, background);
        }
        continue;
      }
      try {
        await this.account(directory, () => storageUsage(directory));
      } catch (error) {
        for (const [key] of group) {
          failures.push({ key, error });
        }
      }
      // Whatever the sample did, this round consumed ONE backoff step for what is
      // still owned; an entry the commit settled is already gone and untouched.
      for (const [key, captured] of group) {
        this.keepRetainedDrain(key, captured, background);
      }
    }
    return failures.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  /**
   * Forget ONE captured retained drain, but only while the map still holds exactly
   * that entry.
   *
   * The entry captured when a round started is already stale the moment this
   * governor forgets the obligation somewhere else: an exact `release`/`quarantine`
   * ends it, a later `drain({ retain: true })` of the same key replaces it, and
   * `close` clears the map. Deleting by key alone would drop the REPLACEMENT, and
   * re-adding it would resurrect a claim a caller already settled - so both the
   * removal and the bookkeeping below are identity-checked and never insert.
   */
  private settleRetainedDrain(key: string, captured: RetainedDrain): void {
    if (this.retainedDrains.get(key) === captured) {
      this.retainedDrains.delete(key);
    }
  }
  /**
   * Keep a captured obligation after a failed publication or after a sample that
   * settled nothing: unchanged for a foreground pass, and with ONE more saturated
   * backoff step for the scheduler. A replaced or removed entry is never
   * resurrected or overwritten.
   */
  private keepRetainedDrain(key: string, captured: RetainedDrain, background: boolean): void {
    if (this.retainedDrains.get(key) !== captured) {
      return;
    }
    if (background) {
      this.retainedDrains.set(key, { store: captured.store,
        attempts: Math.min(captured.attempts + 1, DRAIN_RETRY_SATURATED_ATTEMPTS),
        ...(captured.foreground === true ? { foreground: true } : {}) });
    }
  }
  /**
   * Schedule the ONE coalesced background retry of this governor's retained drains,
   * at the earliest pending entry's own saturated exponential backoff.
   *
   * Nothing is scheduled while a round is already in flight or while this governor
   * closes, so a governor never owns more than one timer and no retry can outlive
   * the ownership it reconciles. While ONE obligation exists this keeps scheduling,
   * at a rate capped by the backoff ceiling: a persistent failure is rate-limited,
   * never abandoned, so a queued waiter of another host or root keeps getting
   * progress even when no new owning request ever arrives. A drain its exact store's
   * committing sample accounted for, an exact release/quarantine and `close` (which
   * retries the rest and retains whatever cannot be published as its fail-closed
   * quarantine) all leave nothing to schedule.
   *
   * An entry whose own foreground sample is still in progress is not due either:
   * scheduling for it would start a background scan against a sample the owner
   * already runs, and the very same `finally` that clears its marker schedules the
   * retry again if the obligation survived.
   */
  private scheduleRetainedDrains(): void {
    if (this.closing || this.drainRetry || this.drainRound) {
      return;
    }
    const pending = [...this.retainedDrains.values()].filter(retained => retained.foreground !== true)
      .map(retained => retained.attempts);
    if (!pending.length) {
      return;
    }
    const wait = Math.min(DRAIN_RETRY_BASE_MS * 2 ** Math.min(...pending), DRAIN_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.drainRetry = undefined;
      void this.runRetainedDrains();
    }, wait);
    // A background retry must never be the reason a host, an extension or a test
    // process stays alive; whoever owns this governor settles it in `close`.
    timer.unref();
    this.drainRetry = timer;
  }
  /**
   * ONE background round at a time, whatever happens: concurrent retentions join the
   * round that is already running instead of starting another, and the next round is
   * scheduled only if something is still due after this one settled.
   */
  private runRetainedDrains(): Promise<void> {
    const round = this.settleRetainedDrains(undefined, true, true)
      .then(() => undefined, () => undefined)
      .finally(() => {
        this.drainRound = undefined;
        this.scheduleRetainedDrains();
      });
    this.drainRound = round;
    return round;
  }
  /** Restore exact-store model ownership before legacy scheduling can run. */
  async modelReservations(scope: string, established = false): Promise<{ key: string; model: string }[]> {
    if (!await this.hasState()) {
      if (established) {
        throw new WorkerError('resource_corrupt', 'The established aggregate resource namespace is missing. Restore its original ledger; missing ownership cannot be treated as drained.');
      }
      return [];
    }
    const stable = await this.resourceScope(scope);
    const aliases = new Set([stable]);
    if (path.isAbsolute(scope)) {
      const physical = await fs.realpath(scope).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        } throw error;
      });
      if (physical) {
        const candidates = await this.transaction(data => [...new Set(data.claims.filter(c => c.kind === 'model' && c.scope !== stable).map(c => c.scope))]);
        for (const candidate of candidates.filter(path.isAbsolute)) {
          const real = await fs.realpath(candidate).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return undefined;
            } throw error;
          });
          if (real === physical) {
            aliases.add(candidate);
          }
        }
      }
    }
    return this.transaction(data => {
      // Upgrade old alias spellings only with physical proof. Keys and all
      // artifact identities remain unchanged; late provider drain uses its key.
      for (const claim of data.claims.filter(c => c.kind === 'model' && aliases.has(c.scope))) {
        claim.scope = stable;
      }
      return data.claims.filter(c => c.kind === 'model' && c.scope === stable && c.state !== 'waiting').map(c => ({ key: c.key, model: c.model }));
    });
  }
  /** Local proof avoids aggregate I/O for stores that never opted in. */
  private async storeRegistration(directory: string): Promise<{ state: 'pending' | 'registered'; scope?: string; physical?: string } | undefined> {
    const file = path.join(path.resolve(directory), 'resource-store.json');
    const read = async (at: string): Promise<string | undefined> => {
      const stat = await fs.lstat(at).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        } throw error;
      });
      if (!stat) {
        return undefined;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) {
        throw new WorkerError('resource_corrupt', 'Restore the plain local resource registration at ' + at);
      }
      return fs.readFile(at, 'utf8');
    };
    const text = await read(file); const namespace = await read(file + '.namespace');
    if (namespace !== undefined && namespace !== JSON.stringify({ schema: 1, kind: 'resource-store' })) {
      throw new WorkerError('resource_corrupt', 'Local resource registration namespace changed; restore its original metadata.');
    }
    if (text === undefined) {
      if (namespace !== undefined) {
        throw new WorkerError('resource_corrupt', 'Restore missing resource-store.json; an established registration cannot be reset.');
      }
      return undefined;
    }
    try {
      const registration = z.strictObject({ schema: z.literal(1), kind: z.literal('resource-store'), directory: z.string(), state: z.enum(['pending', 'registered']), scope: z.string().max(8192).refine(path.isAbsolute).optional(), physical: z.string().max(8192).refine(path.isAbsolute).optional() }).parse(JSON.parse(text));
      if (registration.directory !== this.directory) {
        throw new Error('Restore its original aggregate resource directory: ' + registration.directory);
      }
      if (registration.physical && await fs.realpath(directory) !== registration.physical) {
        throw new Error('This registration belongs to a different physical store. Restore its original location or perform an explicit namespace migration.');
      }
      return registration;
    } catch (error) {
      throw new WorkerError('resource_corrupt', 'Restore local resource registration: ' + String(error));
    }
  }
  async hasStore(directory: string): Promise<boolean> {
    return await this.storeRegistration(directory) !== undefined;
  }
  /** Resource names are stable even when a physical store is opened through an alias. */
  private async resourceScope(directory: string): Promise<string> {
    if (!path.isAbsolute(directory)) {
      return directory;
    }
    const registration = await this.storeRegistration(directory);
    if (registration?.scope) {
      return registration.scope;
    }
    const absolute = path.resolve(directory);
    const real = async (at: string): Promise<string> => fs.realpath(at).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return path.resolve(at);
      } throw error;
    });
    const physical = await real(absolute);
    if (await this.hasState()) {
      // Backfill registrations written before stable names were introduced.
      // No filesystem work runs under the aggregate transaction lock.
      const directories = await this.transaction(data => Object.values(data.stores).map(s => s.directory));
      for (const candidate of directories) {
        if (await real(candidate) === physical) {
          return candidate;
        }
      }
    }
    return absolute;
  }
  private async runnerScope(scope: string): Promise<string> {
    const store = path.dirname(path.dirname(scope));
    return await this.hasStore(store) ? path.join(await this.resourceScope(store), 'runners', 'pool') : scope;
  }
  /**
   * Resolve this store's local identity WITHOUT publishing anything, plus the two
   * publication steps that belong to a decided admission.
   *
   * `publishPending` writes the PENDING registration. It is invoked from inside
   * the aggregate transaction of the exact attempt that admits this store - after
   * that attempt's capacity decision and before the global commit - so a
   * definitively refused NEW store creates no marker at all, while any error or
   * crash after that publication still leaves the marker in place as the recovery
   * fence. `confirm` completes the identity only once the exact store's own sample
   * was accepted; nothing here removes or rewrites an existing pending or
   * registered marker, and a marker that appeared between this capture and the
   * aggregate lock is re-read there instead of being trusted from here.
   */
  private async registerStore(directory: string): Promise<{ publishPending: () => Promise<void>; confirm: () => Promise<void> }> {
    const stat = await fs.lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      } throw error;
    });
    // Virtual accounting namespaces used by the governor need no local files.
    if (!stat) {
      return { publishPending: async () => undefined, confirm: async () => undefined };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkerError('resource_corrupt', 'Registered storage must be a plain directory.');
    }
    const registration = await this.storeRegistration(directory); const state = registration?.state; const file = path.join(directory, 'resource-store.json');
    const scope = registration?.scope ?? await this.resourceScope(directory); const physical = await fs.realpath(directory);
    if (state === 'registered' && !await this.hasState()) {
      throw new WorkerError('resource_corrupt', 'Restore the established aggregate resource namespace for this registered store; refusing fresh ownership.');
    }
    const text = (state: 'pending' | 'registered'): string => {
      const value = JSON.stringify({ schema: 1, kind: 'resource-store', directory: this.directory, state, scope, physical });
      if (Buffer.byteLength(value) > 32 * 1024) {
        throw new WorkerError('resource_capacity', 'Local registration exceeds 32 KiB. Use shorter storage paths or migrate this namespace explicitly.');
      }
      return value;
    };
    return {
      // The FIRST local publication of this store, and only it: an existing
      // registration is never rewritten into a pending state.
      //
      // The captured `state` predates the aggregate lock, so two first
      // enrollments of the SAME store can both capture "no marker" and only one
      // of them can take the lock first. The marker is therefore re-read here,
      // under that lock: a valid pending or registered identity that appeared
      // meanwhile is left exactly as it is - never downgraded to pending, and
      // never replaced because this attempt's own commit later fails.
      publishPending: async () => {
        if (state === undefined && await this.storeRegistration(directory) === undefined) {
          await atomicWrite(file, text('pending'));
        }
      },
      // Complete THIS store's identity only after its exact sample was accepted.
      // A marker that is already fully registered elsewhere - this attempt's own
      // earlier completion or a concurrent one - is preserved unchanged.
      confirm: async () => {
        const existing = await this.storeRegistration(directory) ?? registration;
        if (!(existing?.state === 'registered' && existing.scope && existing.physical)) {
          await atomicWrite(file, text('registered'));
        }
        const namespace = file + '.namespace';
        if (!await fs.lstat(namespace).then(() => true, error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
          } throw error;
        })) {
          await atomicWrite(namespace, JSON.stringify({ schema: 1, kind: 'resource-store' }));
        }
      }
    };
  }
  async hasScope(scope: string): Promise<boolean> {
    if (!await this.hasStore(path.dirname(path.dirname(scope)))) {
      return false;
    }
    scope = await this.runnerScope(scope);
    try {
      const file = path.join(this.directory, 'ledger.json'); if ((await fs.lstat(file)).size > 8 * 1024 ** 2) {
        return false;
      } const data = ledgerSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); return data.claims.some(c => c.kind === 'runner' && c.scope === scope);
    } catch {
      return false;
    }
  }
  async hasState(): Promise<boolean> {
    let directory: string;
    try {
      directory = this.directory;
    } catch {
      return false;
    }
    return fs.readdir(directory).then(entries => entries.length > 0, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      } throw error;
    });
  }
  async status(offset = 0, limit = 20): Promise<unknown> {
    if (!await this.hasState()) {
      return { policy: this.live(), claims: [], stores: {}, open: false };
    }
    // Acquisition: the NORMAL transaction validates the ledger and applies the
    // established liveness/retention sweep (dead hosts, abandoned tickets, expired
    // drains). It returns the rows it decided on and, because its resolution IS
    // the commit, releases the shared lock before anything below runs. Queue
    // ordering and page projection are pure and can be expensive for a full
    // queue, so they must never hold the OS-user lock while another host admits.
    const snapshot = await this.transaction(data => ({ policies: data.policies, claims: data.claims, stores: data.stores }));
    // Inspection is read-only, as the tool is advertised: report the effective
    // limits WITHOUT registering, refreshing or withdrawing this host's policy
    // snapshot. Only a real admission or an explicit refreshPolicy publishes
    // local settings, so a status call from an enabled - or a disabled - host can
    // never change another host's aggregate minima. Outstanding ownership and its
    // charges are still reported exactly as they are.
    const policy = this.limits(snapshot, this.live());
    const page = snapshot.claims.slice(offset, offset + limit);
    // ONE FIFO traversal per call decides this page's live waiting tickets, with
    // exactly the eligibility and virtual-grant rules of `decision()`; the page
    // below only reads it, so a row is never decided by a second queue pass.
    const decisions = this.waitingDecisions(snapshot, policy, page);
    return { policy, summary: { claims: snapshot.claims.length, stores: Object.keys(snapshot.stores).length, retainedBytes: Object.values(snapshot.stores).reduce((n, s) => n + s.bytes, 0), reservedBytes: snapshot.claims.filter(c => c.state === 'active' || c.state === 'quarantine' || c.state === 'provisional').reduce((n, c) => n + c.bytes, 0), waiting: snapshot.claims.filter(c => c.state === 'waiting').length, quarantine: snapshot.claims.filter(c => c.state === 'quarantine').length }, nextOffset: offset + limit < snapshot.claims.length ? offset + limit : null, nextStoreOffset: offset + limit < Object.keys(snapshot.stores).length ? offset + limit : null, claims: page.map(c => ({ ...c, waitingReason: c.state === 'quarantine' ? 'quarantine' : c.state === 'waiting' ? decisions.get(c) ?? (c.kind === 'runner' ? 'runner_capacity' : undefined) : undefined })), stores: Object.fromEntries(Object.entries(snapshot.stores).slice(offset, offset + limit)),
      diagnostics: ['Storage includes registered retained stores plus conservative reservations. Collect unreferenced results and expired receipts, release completed view consumers, or reconcile exact quarantined leases. Existing effects are never evicted by a policy reduction. Unknown storage samples block new storage grants until this exact store is reconciled; measuring known stores retains their previous charge. Checkpoint write fences block admission until their exact store is resampled; reopen the owning store to reconcile an interrupted write without replaying effects.'] };
  }
  /** Caller must own the exact SessionStore and its mutation mutex. No resource waits in action. */
  async withStoreWrite<T>(directory: string, action: () => Promise<T>, measure: () => Promise<number>, report?: (error: unknown) => void): Promise<T> {
    if (this.closing) {
      throw new WorkerError('host_stopping', 'Storage owner is closing.', true);
    }
    const absolute = path.resolve(directory); const registered = await this.registerStore(absolute);
    const scope = await this.resourceScope(absolute); const key = digest(scope); const id = randomUUID();
    await this.transaction(data => {
      const previous = data.stores[key];
      // The exact capacity decision of THIS attempt, and only for a store this
      // ledger does not know yet: an already registered store is an update and is
      // never refused by the bound. It is decided BEFORE the first local
      // publication below, so a definitively rejected new store leaves no marker
      // that would drag an opted-out legacy scope into the same rejection.
      if (previous === undefined && Object.keys(data.stores).length >= 256) {
        throw new WorkerError('resource_capacity', '256 stores are registered; migrate retained namespaces before adding another store.');
      }
      data.stores[key] = { ...previous, directory: scope, bytes: previous?.bytes ?? 0,
        sampleId: randomUUID(), write: { id, host: this.host, pid: process.pid, state: 'active' } };
    }, () => registered.publishPending());
    return this.writer.run({ key, id }, async () => {
      let value!: T; let failed = false; let problem: unknown;
      try {
        await registered.confirm();
        value = await action();
      } catch (error) {
        failed = true; problem = error;
      }
      try {
        // Other samples cannot replace this one until the write fence clears.
        await this.account(absolute, measure);
        await this.transaction(data => {
          const store = data.stores[key];
          if (store.write?.id !== id || store.accounting || store.uncertain) {
            throw new WorkerError('storage_quarantine', 'The checkpoint write fence lost its reconciled sample. Reopen this exact store to reconcile; do not replay effects.');
          }
          store.write = undefined;
        });
      } catch (error) {
        await this.transaction(data => {
          const store = data.stores[key];
          if (store.write?.id === id) {
            store.write.state = 'quarantine'; store.uncertain = true; store.accounting = 'quarantine';
            store.diagnostic = ('Reopen the exact owning store to rescan an interrupted checkpoint; no effect is replayed. ' + String(error)).slice(0, 500);
          }
        });
        if (report) {
          report(error);
        } else if (!failed) {
          throw error;
        }
      }
      if (failed) {
        throw problem;
      }
      return value;
    });
  }
  /**
   * Only a newly acquired exclusive store owner may reconcile an abandoned
   * checkpoint fence - or an uncertain sample that no write fence can clear.
   *
   * A known drain (or any other interrupted sample) fences the store WITHOUT
   * leaving a write marker, because the write it belonged to already finished. On
   * reload nothing else would ever resample it, so the store would stay fenced
   * forever and its drained row would never be reclaimed. Opening the exact
   * registered store therefore resamples both cases; a store that is neither
   * written nor uncertain reports `false` and is left alone.
   */
  async recoverStoreWrite(directory: string, measure: () => Promise<number>): Promise<boolean> {
    const registration = await this.storeRegistration(directory); const state = registration?.state;
    if (state === undefined) {
      return false;
    }
    if (!await this.hasState()) {
      if (state === 'registered') {
        throw new WorkerError('resource_corrupt', 'Restore the established aggregate resource namespace for this registered store.');
      }
      return false;
    }
    const key = digest(await this.resourceScope(directory));
    const needed = await this.transaction(data => {
      const store = data.stores[key];
      return store?.write !== undefined || store?.uncertain === true || store?.accounting === 'quarantine';
    });
    if (!needed) {
      return false;
    }
    await this.withStoreWrite(directory, async () => undefined, measure);
    return true;
  }
  /**
   * Fence the sample before reading: a later sample always supersedes this one.
   *
   * The commit of a CURRENT sample is also the only thing that settles this
   * governor's retained drains: it reports - after the persisted rows are checked -
   * exactly the captured entries that name THIS exact store (same resolved path the
   * publication side filters on) and whose claim no longer owns a row, and only
   * those are forgotten, and only once the ledger write is durable. An entry of
   * another store is never settled here, however its row disappeared: this
   * transaction also retires an aged drained row of an unsampled store, and that
   * store's fence would otherwise be left with nothing left to retry it. A
   * superseded generation or a failed sample settles nothing and leaves every
   * obligation owned.
   */
  async account(directory: string, measure: () => Promise<number>): Promise<void> {
    const absolute = path.resolve(directory); const registered = await this.registerStore(absolute);
    const scope = await this.resourceScope(absolute); const key = digest(scope); const sampleId = randomUUID();
    const deadline = Date.now() + 360_000;
    while (!await this.transaction(data => {
      const previous = data.stores[key]; const context = this.writer.getStore();
      if (previous?.write && (context?.key !== key || context.id !== previous.write.id)) {
        if (previous.write.state === 'quarantine') {
          throw new WorkerError('storage_quarantine', 'An interrupted checkpoint is retained. Reopen its exact owning store to reconcile bytes without replaying effects.', true);
        }
        return false;
      }
      // Same exclusive decision as `withStoreWrite`: the capacity bound of a store
      // this ledger does not know yet is checked BEFORE this attempt publishes its
      // first local registration, so a definitive refusal enrolls nothing.
      if (previous === undefined && Object.keys(data.stores).length >= 256) {
        throw new WorkerError('resource_capacity', '256 stores are registered. Reuse a registered store with available capacity or export retained namespaces for an operator-managed migration. Never delete the resource ledger to reset ownership.');
      }
      data.stores[key] = { ...previous, directory: scope, bytes: previous?.bytes ?? 0, sampleId,
        accounting: 'measuring', uncertain: previous ? previous.uncertain ?? false : true };
      return true;
    }, admitted => admitted ? registered.publishPending() : undefined)) {
      if (Date.now() >= deadline) {
        throw new WorkerError('resource_busy', 'Checkpoint accounting is still active in another owner. Retry after it drains or reopen its exact store to reconcile.', true);
      }
      await delay(25);
    }
    try {
      await registered.confirm();
      const bytes = await measure();
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new WorkerError('storage_quarantine', 'Storage measurement must be a nonnegative safe byte count.');
      }
      const settled = await this.transaction(data => {
        const store = data.stores[key];
        if (store.sampleId !== sampleId) {
          // A concurrent sample superseded this generation: it accounts for
          // nothing, so it must not settle a single retry obligation either.
          return [] as [string, RetainedDrain][];
        }
        store.bytes = bytes; store.accounting = undefined; store.uncertain = false; store.diagnostic = undefined;
        // A healthy sample of THIS exact store reclaims the durable ownership of
        // every known-drained permit that belonged to it. Uncertain effects
        // ('active'/'quarantine') and any other store's claims are untouched.
        data.claims = data.claims.filter(claim => claim.state !== 'drained' || claim.store !== key);
        // Captured from the SAME commit, against the rows it just published: only
        // an exact claim of THIS host AND of THIS exact store can be accounted for
        // here - reclaimed by this sample, or already by an earlier sample of
        // another governor - so its in-memory retry ends instead of polling a store
        // that has nothing left to reconcile.
        //
        // The store check is what makes a MISSING row proof: this same transaction
        // also retires a drained row after DRAINED_TICKET_RETENTION_MS without
        // sampling anything, so another store's aged-out row would otherwise drop
        // the only retry of a store whose own fence is still quarantined. The
        // comparison is the resolved exact path the publication side uses, and the
        // remaining rows are indexed once instead of scanned per entry.
        const remaining = new Set(data.claims.filter(claim => claim.host === this.host).map(claim => claim.key));
        const reclaimed: [string, RetainedDrain][] = [];
        for (const [claimKey, retained] of this.retainedDrains) {
          if (retained.store !== undefined && path.resolve(retained.store) === absolute && !remaining.has(claimKey)) {
            reclaimed.push([claimKey, retained]);
          }
        }
        return reclaimed;
      });
      // Only now that the publication is durable, and identity-checked so a
      // replaced or removed entry is never resurrected by a stale capture.
      for (const [claimKey, retained] of settled) {
        this.settleRetainedDrain(claimKey, retained);
      }
    } catch (error) {
      await this.transaction(data => {
        const store = data.stores[key];
        if (store.sampleId === sampleId) {
          store.accounting = 'quarantine'; store.uncertain = true;
          store.diagnostic = `Restore readable metadata and reconcile this exact store: ${String(error)}`.slice(0, 500);
        }
      });
      throw error;
    }
  }
  runnerAdmission(scope: string, root: string, laneFor: (owner: RunnerLeaseOwner) => WorkLane, waiting?: (owner: RunnerLeaseOwner, reason?: WaitingReason) => Promise<void>): RunnerAdmission {
    const key = (id: string, stable: string) => `runner:${digest(stable)}:${id}`;
    return {
      tryAcquire: async (id, owner, localCapacity = 8) => {
        const stable = await this.runnerScope(scope);
        const result = await this.tryAcquire({ key: key(id, stable), kind: 'runner', root, scope: stable, lane: laneFor(owner), localCapacity, bytes: 1024 ** 3 }); await waiting?.(owner, result.granted ? undefined : result.reason); return result.granted;
      },
      cancel: async id => this.withdraw(new Set([key(id, await this.runnerScope(scope))])),
      // The SAME removal rule as `cancel`, in one transaction for a whole batch:
      // exact keys only, this host only, and ids that own no row are ignored.
      cancelMany: async ids => {
        const stable = await this.runnerScope(scope);
        await this.withdraw(new Set(ids.map(id => key(id, stable))));
      },
      reconcile: async (records, recovery = false, releasedIds = [], physicalAvailable) => {
        const stable = await this.runnerScope(scope);
        return this.transaction(data => {
          if (physicalAvailable !== undefined) {
            // Per-ticket physical eligibility from the owning pool, refreshed
            // after every journal adoption and on recovery: a waiting ticket
            // whose pool has no usable slot must not reserve aggregate capacity.
            // Active tickets are untouched: their pool holds a physical lease.
            // This is ELIGIBILITY only - a reconcile report never refreshes a
            // ticket's liveness, or a cancelled ticket would be kept alive by
            // any later adoption in the same pool.
            for (const waiting of data.claims.filter(c => c.kind === 'runner' && c.host === this.host
              && c.scope === stable && c.state === 'waiting')) {
              waiting.localBlocked = !physicalAvailable;
            }
          }
          for (const claim of [...data.claims].filter(c => c.kind === 'runner' && c.scope === stable)) {
            const record = records.find(r => key(r.leaseId, stable) === claim.key);
            if (record?.state === 'released' || releasedIds.some(id => key(id, stable) === claim.key) || (recovery && !record)) {
              data.claims = data.claims.filter(c => c !== claim);
            } else if (record?.state === 'quarantined') {
              claim.state = 'quarantine';
            }
          }
        });
      }
    };
  }
  /**
   * The final shutdown pass of this host.
   *
   * `stores` are the exact store directories this host still owns EXCLUSIVELY - the
   * runtime passes the directories of the `SessionStore`s it has not released yet.
   * They matter because publishing a KNOWN drain alone fences its exact store, and a
   * fence no driver ever samples again keeps every waiter of another host or root
   * quarantined until that store is reopened. So for exactly those stores - and no
   * other - this close reuses the coalesced publish+sample pass
   * (`settleRetainedDrains`): the drain is published and ONE healthy sample of the
   * same exact store reclaims the row and clears the fence while the ownership proof
   * still exists. A store with no retained obligation is never read or enrolled.
   *
   * Every other obligation keeps the drain-only fallback: a scope this host cannot
   * prove it still owns (an unowned, standalone or already released store) is never
   * sampled or enrolled here, so only its own later reopen can reconcile it. The
   * fallback deliberately runs AFTER the owned samples and never for their stores: a
   * second drain-only pass could publish a new unresolved fence after teardown, and
   * an obligation that survived its owned pass is settled by the quarantine below.
   *
   * Persistent failure therefore stays fail-closed: an unpublished drain is retained
   * as the quarantine transaction of this close, a published drain whose sample keeps
   * failing keeps its durable fence (the exact store's next reopen reconciles it), and
   * the background retry is stopped and joined first either way.
   */
  async close(stores: readonly string[] = []): Promise<void> {
    this.closing = true;
    // Stop and settle this governor's OWN background reconciliation FIRST: a round
    // that published a drain (or a fence) after the quarantine below would leave a
    // store charged by a host that no longer exists. Clearing the timer and awaiting
    // the in-flight round only ends the RETRY of accounting - the effect behind every
    // entry has already finished and is never replayed - and it deliberately touches
    // neither a concurrent lifecycle retry nor the runtime's own shutdown order.
    clearTimeout(this.drainRetry);
    this.drainRetry = undefined;
    await this.drainRound?.catch(() => undefined);
    if (!await this.hasState()) {
      // No ledger means no claim this host could still own, so no retained drain
      // can have anything left to publish.
      this.retainedDrains.clear();
      return;
    }
    // PHASE 1 - the exact stores this host still owns exclusively, each through ONE
    // coalesced publication+sample: the pass the ordinary reconciliation and the
    // background round already use, so a known drain is never left fenced by the
    // shutdown that settled it. Nothing outside these exact stores is sampled, and a
    // store that still owes nothing costs no I/O and no ledger write at all.
    const owned = new Set(stores.map(directory => path.resolve(directory)));
    for (const directory of [...owned].sort()) {
      await this.settleRetainedDrains(directory, true, false);
    }
    // PHASE 2 - the LAST owner of a finished effect's retry obligation. A host closes
    // its lifecycle before its engine drains in-flight turns (`runtime.ts`), so a
    // completed effect can publish its KNOWN drain only AFTER that lifecycle is gone;
    // the effects are never replayed, only their accounting is retried here. Only
    // scopes this close cannot prove ownership of are still due, and whatever fails is
    // retained by the transaction below as an uncertain effect, which is exactly what
    // persistent I/O failure or a crash deserves.
    await this.settleRetainedDrains(undefined, false, false, owned);
    // Ownership outlives the host if an inference/tool has not drained.
    await this.transaction(data => {
      // A queued ticket and an UNACKNOWLEDGED provisional handoff both own no
      // effect, so closing withdraws them. Only real ownership - active and
      // already-uncertain claims - is retained as a quarantine.
      data.claims = data.claims.filter(c => c.host !== this.host
        || (c.state !== 'waiting' && c.state !== 'provisional'));
      // A known-drained reservation is not an uncertain effect: closing the host
      // must not turn it into a permanent quarantine. It stays 'drained' so the
      // exact store's next healthy sample can still reclaim it.
      for (const claim of data.claims.filter(c => c.host === this.host && c.state !== 'drained')) {
        claim.state = 'quarantine';
      }
      for (const store of Object.values(data.stores)) {
        if (store.write?.host === this.host) {
          store.write.state = 'quarantine';
        }
      }
      delete data.policies[this.host];
    });
    // Every remaining obligation is now durable as a row the ledger retains: a
    // published drain awaits its exact store's sample, and a failed one is the
    // quarantine above. Nothing is left for this closed host to retry.
    this.retainedDrains.clear();
  }
}

/** Conservative accounting: never follow links, never skip unknown files. */
export async function storageUsage(directory: string): Promise<number> {
  let entries = 0;
  const walk = async (at: string): Promise<number> => {
    const stat = await fs.lstat(at).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      } throw error;
    });
    if (!stat) {
      return 0;
    }
    if (stat.isSymbolicLink()) {
      return stat.size;
    }
    if (++entries > 200_000) {
      throw new WorkerError('resource_storage_unknown', `Cannot account storage safely at ${at}; reconcile links or excessive entries.`);
    }
    if (!stat.isDirectory()) {
      return stat.size;
    }
    let bytes = 0;
    for (const entry of await fs.readdir(at).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return [];
      } throw error;
    })) {
      bytes += await walk(path.join(at, entry));
    }
    return bytes;
  };
  const physical = await walk(directory);
  // Git payloads live outside the store. Charge logical retained bytes for
  // each manifest, conservatively, rather than making another checkout free.
  const indexFile = path.join(directory, 'isolated-views', 'index.json');
  const indexStat = await fs.lstat(indexFile).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    } throw error;
  });
  if (!indexStat) {
    return physical;
  }
  if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size > 32 * 1024 ** 2) {
    throw new WorkerError('storage_quarantine', 'Cannot measure invalid private view metadata.');
  }
  const data = JSON.parse(await fs.readFile(indexFile, 'utf8')) as { snapshots?: Record<string, { manifestHash: string; backing: { kind: string } }>; pendingCaptures?: Record<string, { snapshot: { manifestHash: string; backing: { kind: string } } }> };
  let git = 0;
  const seen = new Set<string>();
  for (const snapshot of [...Object.values(data.snapshots ?? {}), ...Object.values(data.pendingCaptures ?? {}).map(p => p.snapshot)]) {
    if (snapshot.backing.kind !== 'git' || seen.has(snapshot.manifestHash)) {
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(snapshot.manifestHash)) {
      throw new WorkerError('storage_quarantine', 'Invalid manifest identity for storage accounting.');
    }
    seen.add(snapshot.manifestHash);
    const bytes = await fs.readFile(path.join(directory, 'isolated-views', 'content', 'blobs', snapshot.manifestHash.slice(0, 2), snapshot.manifestHash.slice(2)));
    const manifest = JSON.parse(bytes.toString('utf8')) as { totalBytes: number };
    if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
      throw new WorkerError('storage_quarantine', 'Invalid retained manifest size.');
    }
    git += manifest.totalBytes;
  }
  return physical + git;
}
