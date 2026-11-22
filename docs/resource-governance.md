# Governed isolated workers (step 4, opt-in)

Enable `codexSubagent.resources.enabled`, `taskBoard.enabled` and
`isolatedViews.enabled` in **User Settings**. Physical commands additionally
require `isolatedViews.runners.enabled`, workspace-write permission, an enabled
exact model allowing writes/shell, and command approval. No repository setting
can enable these features or widen their budgets. Legacy `subagent_spawn`
continues starting an ordinary worker immediately, with its original history,
permissions, idempotency, model selection, cancellation and drain behavior.

## Create, bind, start

Create a team, a ready unassigned task and a snapshot explicitly. Then call
`subagent_isolated_spawn` with the normal spawn arguments, required `ownerId`,
and:

```json
{
  "setup": {
    "teamId": "<team id>",
    "taskId": "<task id>",
    "snapshotId": "<snapshot id>",
    "teamRevision": 0,
    "taskRevision": 0,
    "lane": "work"
  }
}
```

Use the actual current revisions. `lane` is an explicit coordinator decision:
`work`, `validation` or `integration`. Those labels reserve capacity; they do
not perform validation or integration and convey no verdict or approval.

Governed sessions use schema **3**. Earlier hosts that understand only schemas
1/2 reject and preserve them, so stripping an unfamiliar optional field can
never turn incomplete setup into a live legacy worker. Use the updated host
to administer governed histories; legacy schemas 1/2 remain supported.

The persisted setup phases are `created`, `assigned`, `bound`, `ready`,
`started`, and `cancelled`. Creation persists a non-runnable session. One board
transaction establishes membership and assignment, then the existing durable
binding protocol publishes the permanent private-view marker and overlay. Only
after checking the binding can startup queue the first turn. No legacy turn,
spawn/cancel race, live file tool, or model inference is used during setup.
The task itself remains `ready`; task progress and acceptance remain explicit
board operations, separate from worker execution.

Retry interrupted setup with the **same requestId and arguments**. Board
receipts and binding intents reconcile an interruption between separate stores;
the same assignment is not applied twice. A stale initial team/task revision
leaves setup stopped. Inspect it, cancel it, and issue a new coordinator decision
with current revisions rather than changing arguments under the old key.
Ordinary send/resume cannot bypass incomplete setup. Cancellation permanently
cancels that setup request. A deleted governed request is tombstoned, so retrying
it cannot recreate a worker. Reload never runs queued/interrupted inference or
uncertain tools automatically. An already-started spawn retry observes its
current session; it does not resume interrupted work. If a start decision was
persisted before its scheduling handoff, a same-host retry completes that
handoff only for an inactive queued worker. Reload converts queued work to
interrupted, which still requires explicit resume.

Parent heartbeats cover incomplete setup, including storage waits before a
worker record exists, as well as runnable workers. The accepted identity, its
exact argument fingerprint and the original parent deadline are durable before
the first capacity wait, so a reload or a crash cannot accept changed arguments,
grant a fresh lease or leave that identity open to a legacy spawn. A heartbeat
renews the persisted deadline and a stop retires the persisted intent, including
one accepted by a previous host. Each root retains at most 64 durable
pre-creation requests, at most 60 of them in the work lane, keeping four
reachable for validation and integration, and a reload preserves those
limits. A kept intent has no deadline, so it is removed only when its worker
checkpoint adopts that request or when the parent stops it explicitly.
Cancel-on-expiry stops unattended setup and queued work; a retired
pre-creation request cannot become a fresh worker on retry. A durable retirement
also fences retries and a queued handoff even when a cancellation checkpoint
failed, so neither can revive the retired request. Setup serializes by request,
so a production storage
wait does not hold a root lock needed by validation. Each root permits at most
32 distinct pending preparations (at most 28 work) and 64 concurrent startup
control calls (at most 56 work), preserving service admission at both limits. Shutdown aborts and
drains accepted setup before releasing the root store lock. Owner-scoped
maintenance admission also covers preparations before a Session exists and
accepted worker controls before their queued/running checkpoint. Rollover and
collection refuse that owner until those operations drain; while their durable
maintenance write runs, new work for that owner returns worker_busy. Other
owners and roots remain independent; no control mutex is held across a wait.

## Resource scopes and admission

The aggregate ledger is fixed at
`~/.codex-subagent/resources-v1` on the **extension host's filesystem**, shared
by this OS user across canonical roots, registered worktrees, extension stores,
profiles and extension-host processes. The location uses the OS account profile,
independent of environment HOME overrides. Changing a checkout or extension storage
path does not create another aggregate allowance. Remote hosts/OS users have
separate ledgers. A short exclusive filesystem transaction serializes decisions;
no provider request, command, approval or resource wait runs under that lock.

All settings below use the `codexSubagent.resources.` prefix and User scope.

| Setting | Default | Scope |
| --- | --- | --- |
| `enabled` | `false` | Enables governed startup/execution for this host |
| `modelCapacity` | 8 (2–128) | Simultaneous governed inference requests, all models/roots |
| `runnableCapacity` | 16 (2–256) | Governed inference and non-runner tool effects |
| `runnerCapacity` | 4 (2–64) | Governed physical runner reservations, including quarantine |
| `storageBytes` | 8 GiB (64 MiB–1 TiB) | Conservative retained-store bytes plus admission reservations |
| `serviceReserve` | 1 (fixed) | Model/runnable/runner headroom for validation/integration |

`models[exactId].numSessions` keeps its owning canonical-root **session store**
scope. Another extension store has its own local ceiling, and shares the new
OS-user aggregate allowance. Legacy active
conversation reservations still include maintenance and draining tools.
Governed conversations yield execution capacity between inference, tool and
runner stages; their inference admission honors the same per-store, exact-model
ceiling, including legacy activity. A granted governed model permit is also
reserved locally before asynchronous binding validation, so a legacy worker
cannot take that slot during the provider handoff. The aggregate settings add ceilings and do
not turn `numSessions` into a global setting or expand its numeric ceiling.
Before a governed store reopens, its retained model ownership is restored from
the aggregate ledger into local admission, including retired hosts and deleted
workers with expired/disabled execution settings. Legacy work in that same
store queues until those effects actually drain. A bounded observer refreshes
retained ownership; read failures preserve its last charge and report recovery
errors. Other stores retain their independent local ceilings. Failed inference
finalization also keeps its local reservation until release can be proven.

Existing physical runner `capacity` and `maxQueue` remain per canonical root,
fixed when that pool reopens. Governed admission adds a reserved service slot
within roots having at least two physical slots. Production uses at most
`capacity - 1` there; validation/integration can use the last slot. Free slots
remain admissible when the production wait queue is full, including `maxQueue: 0`. If an older eligible promotion inherits a younger arrival slot promise,
the younger arrival takes its vacated queue entry, keeping the original queue
bound and FIFO ordering. Only the owning pool can claim a ticket, and it claims
that ticket after proving a local slot on that pool. The oldest eligible ticket
across roots receives the next handoff. No runner capacities or reopen settings
are raised.

A waiting runner ticket stays eligible only inside a bounded liveness window
that its own pool poll refreshes. A cancelled request whose ledger withdrawal
failed, a crashed host or a closed pool cannot hold queue leadership beyond that
window. Active and quarantined claims continue charging capacity. Waiting model,
tool, runner and storage tickets all use that same bounded own-poll liveness. A
poll refreshes local eligibility for the sibling model tickets of its
host/store/model scope, so an older request is never overtaken, but only the
polling ticket is renewed and activated: no poll activates a sibling or reclaims
retained ownership. A known-drained claim stops charging capacity and fences
fresh admission until the exact store publishes a healthy sample, and that
sample lets its record be reclaimed. A grant whose queue decision is final but
which its caller has not yet acknowledged is durable as a provisional claim. It
charges capacity exactly like an admitted effect, it is never counted as an
effect, and it is withdrawn without an effect when its own bounded window ends,
when its host closes or when its process dies. A ledger containing that state
fails closed on an older build instead of being misread as an effect.

A one-slot root remains usable, but cannot run two commands concurrently. Legacy runners
retain their previous pool/approval behavior and do not acquire governed
aggregate reservations. The aggregate execution limits cover governed workers;
storage accounting conservatively includes all files in registered stores.
Legacy checkpoints, compaction and deletion refresh those charges, including
after reload or resource opt-out. This accounting does not acquire legacy
execution slots or impose governed storage admission on legacy workers. Host-created
snapshot/CAS and overlay payloads, runner materialization, change journals and
command result publication use the same registered-store write fence. The
filesystem phase holds the store mutation mutex, invalidates earlier samples,
and blocks fresh aggregate grants until its new charge is reconciled. Domain
view/result locks precede that mutex. Admission, approval, shell execution and
pool lease operations run outside the fence, so storage reconciliation cannot
hold resources needed to unblock service work. Failed
measurements quarantine the store for fresh governed admission and report a
diagnostic while ordinary legacy execution continues. An unused, opted-out
legacy store creates no aggregate resource namespace and performs no aggregate
ledger reads or lock acquisitions, even if another workspace's ledger is corrupt
or locked. The opt-in bit is read on its own, so a malformed numeric limit fails
only the governed request that needs it and cannot block legacy work while
governance is disabled. Participation is identified by local `resource-store.json` and its
adjacent namespace marker, each bounded to 32 KiB. Pending registration is
published locally before the global store record and confirmed before effects;
interrupted initial registration can safely finish on retry. First-use ledger
publication likewise resumes a pending empty initialization on retry, while a
missing established ledger fails closed instead of being recreated. Established
registrations require their original aggregate namespace, including after
opt-out. Missing or corrupt local ownership metadata fails closed.

Registration retains a stable resource scope and canonical physical path.
Windows path casing and parent junction aliases therefore share model ownership,
runner admission and retained-byte charges. Legacy model-scope spellings upgrade
only after physical identity is verified; reservation keys and artifact URIs do
not change. Copying an established registration to a different physical store
fails closed: initialize a new namespace or use an operator-managed migration.
This does not broaden snapshot layouts, relocate view identities or change
physical-runner reopen validation.

Governed model requests acquire their queue identity before waiting for local
capacity. Legacy occupancy reduces the available local allowance without
holding aggregate model/runnable slots. A younger poll cannot overtake an older
request. A grant lost at the legacy handoff returns to waiting
with its sequence intact, and cancellation removes that deferred ticket.

Coordinator `subagent_team_create`, `subagent_team_update`,
`subagent_task_create` and `subagent_task_update` accept an optional `lane`
storage-admission hint. It defaults to `work`; explicitly pass
`lane: "validation"` or `lane: "integration"` when creating service tasks or
recording verdicts/acceptance so those mutations can use reserved storage
headroom. The hint still obeys the aggregate User budget and permission checks.
It is removed before domain mutation, is not persisted on the team/task and is
excluded from the request fingerprint: retrying the same mutation with another
lane replays its receipt, while changed business arguments still conflict.
Worker board tools reject this hint. Read/list tools need no reservation and
do not accept it. Small service metadata - a validation/integration board
mutation, its governed setup assignment/binding, one `read_file` result, or a
governed send/resume follow-up that checkpoints control metadata - reserves
4 MiB, while payload work keeps its existing larger reservations and
every original size limit. With resource governance disabled it has no admission effect.
This hint neither dispatches work nor establishes a verdict; choose the
execution lane separately in `subagent_isolated_spawn.setup.lane`.

Oldest eligible requests win. A blocked root/model does not obstruct an
independent request or the reserved service lane. Younger storage consumers
cannot repeatedly consume headroom ahead of an older storage waiter. Such
fairness waits report `storage` consistently in admission replies, waiter
callbacks and resource status. Root queues and the aggregate queue are bounded.
Policy reductions stop new grants
without evicting existing owners; concurrently registered User profiles apply
the most restrictive aggregate limits. Live permission/model/feature checks
still run before inference and effects, including after approval. Governed tool
guards also recheck task assignment, membership, terminal state and scheduling
eligibility immediately before effects. A dependency or message wait added
during admission releases the granted permit before waiting again; it cannot
hold the capacity needed to unblock itself.

Dependency and explicit message waits hold no model, runnable or runner slot.
Inference releases its permit before tools. Runner queue/approval waits hold no
model or runnable permit. A physical slot covers setup, approval, execution,
import and cleanup. Unproven drain or failed durable release retains ownership
or quarantines it; neither local nor aggregate capacity is silently reused.
Governed stream disposal drains pending admission and its queue-ticket cleanup
before reporting a stopped worker. Once a provider request has started, that
request may remain detached on cancellation with its model ownership retained
until actual provider drain. `ExecutionGovernance.drainAdmissions` separates
these phases for normal turns and compaction.
The existing process-identity proofs govern runner recovery. No command or
uncertain tool is replayed. A failed aggregate admission cleanup retains its
claim and reports its identity, but always settles the runner request. Closing
still aborts active leases before awaiting ledger cleanup. Queued cancellation
settles after its admission cleanup attempt; pool shutdown drains outstanding
cancellation attempts before reporting closed, including waiters removed by an
abort callback. Failed cleanup leaves the aggregate claim retained with an
actionable diagnostic. Restore the ledger
and reopen the exact pool to reconcile retained claims; never clear them by
starting a command again.

`waitingReason` and worker activity expose dependency, model capacity, runnable capacity, runner
capacity, approval, storage, quarantine and explicit message waits. Resource
status pages expose global reservations, retained-store charges, effective
policy and reclamation diagnostics. A request larger than its retained-storage
allowance fails with `storage_exhausted` and reports bytes and remedies.

Storage scans include metadata, payloads, histories and archives without
following links. Git-backed snapshots are additionally charged by retained
manifest bytes, so moving payloads to a common Git object store is not free.
Production retains one eighth of storage headroom for service work. A physical
runner reserves 1 GiB; captures reserve 600 MiB; smaller mutations use bounded
reservations. Accounting is conservative and can count retained bytes plus a
reservation during an effect. These are admission budgets, **not OS disk
quotas**: a shell still has the user's real OS access and can create arbitrary
output. Durable governed session checkpoints and terminal runner records refresh
retained accounting before permits are released. Accounting accepts a sampling
callback, assigns its identity in the shared ledger before reading files, and
publishes only if that identity is still current. Older results or failures
cannot replace a newer sample across extension hosts. Filesystem scans stay
outside the aggregate transaction lock. Known stores retain their prior charge
while measuring reserved effects; newly registered or quarantined stores block
fresh storage grants until reconciliation succeeds. Checkpoint writes, including
legacy growth without an admission reservation, publish a durable per-store
write fence **before** changing checkpoint bytes. This invalidates older samples
and blocks new grants with `storage` until the owning mutation has drained and
its final sample is published. Other scans wait outside the aggregate lock and
cannot replace that sample or clear the fence. The owning action runs only
checkpoint filesystem operations; it never waits for admission, approval or
dependencies while fenced. Failed reconciliation retains a `quarantine` fence.
Each registered store has at most one fence under its exclusive SessionStore
owner and mutation mutex. A newly acquired root owner, including offline history
administration, rescans an interrupted fence before enabling work; it never
replays a checkpoint's uncertain external effects. Ordinary legacy execution
continues after a failed post-write measurement, while governed grants stay
blocked. Creating the pre-write fence requires a usable aggregate ledger. Hooks are
installed before opening recovery checkpoints are published. Opening recovery
cannot initialize a missing established ledger before checking durable model
ownership; it fails closed rather than resetting capacity. Parsing and validating
saved transcripts is separate from recovery checkpoint publication. Resource,
permission and filesystem failures during recovery fail the open operation and
leave valid histories available for retry; they do not classify those histories
as malformed or hide workers in an otherwise successful startup.
Active foreign accounting waits are bounded to six minutes; a quarantined fence
fails promptly and identifies recovery through the exact owning store.
Every retention mutation refreshes retained-byte accounting before returning,
including evidence updates, receipt rollover and failures after a durable write.
A new evidence pin reserves 4 MiB conservatively for its bounded ledger.
Writes enforce the same 4 MiB UTF-8 limit as readers, including multibyte URIs.
This admission is nonblocking under the pin mutex: unavailable capacity fails with
`resource_busy` or `storage_exhausted`, so release/GC cannot deadlock behind it.
Existing exact pins replay without a fresh reservation. Reclamation metadata
writes (release, rollover and collection) remain available at exhaustion and
reconcile their bounded maintenance growth. History compaction also remains
available after a task ends or its write permission is revoked. Governed manual compaction is
tracked maintenance: storage admission yields the engine control mutex, and
cancel, parent expiry and shutdown interrupt the wait. Its previous worker
state is persisted and restored on reload without replaying archive effects.
Removed-folder histories accept manual summaries through the same governed
storage accounting, with no provider request or worker tools. This history-only
path tries admission once: if capacity is occupied, it returns `resource_busy`
with the waiting reason and leaves no queued claim or archive effect. Inspect
the current revision and retry after capacity is available. Offline view
administration uses the same storage accounting: release, cleanup, reads and
exact receipt replays reconcile retained bytes without a new reservation;
fresh consumer pins try admission once and return `resource_busy` when capacity
is occupied, leaving no queued claim or new receipt. An exact release replays
its stored acknowledgement even after a native pin, board reference or evidence
consumer was added to that artifact, while a fresh release proves the resource
exists in the requested owner and team scope first, so a foreign or missing id
reports `not_found` rather than a retention conflict. Reclamation therefore can
enter after a denied pin. Registered-store accounting continues after resource
opt-out, so removing a folder or disabling governance cannot leave stale charges
for other roots. It never holds the broker control mutex across a resource wait. Legacy history behavior is unchanged.

## References, expiry and collection

Governed commands seal and retain an exact input submission before execution.
The optional `attempt.inputArtifact` records its immutable id/version/URI and
revision; `attempt.inputVersion` still names the exact tested snapshot/overlay
revision. An imported `afterVersion` is a new, unvalidated revision. Governed
runner ports must implement withSealedInput: sealing, exact input loading,
pending-consumer publication and materialization share one view critical
section. There is no separate-seal fallback. Release/cleanup resolves runner
reference edges after acquiring that same mutex, including commands that
published while cleanup was queued. Consumer callbacks must not recursively
acquire the view port. A collected seal acknowledgement cannot recreate input
content or publish a new consumer.

`subagent_evidence_retention` pins/releases an exact URI under an owner/team
and consumer name. A name cannot switch URI without releasing the old pin.
Pin results before consuming them or publishing dependent references. Existing
view pins continue retaining snapshots/submissions. Board references and
evidence pins protect submission content during view release/cleanup; reads
and collection never infer validation or acceptance from a reference. Managed
pending and final attempts own their sealed inputs: explicit input release or
cleanup cannot remove them while their command evidence remains stored. Collect
the unreferenced final result before releasing its otherwise unneeded input.
Durable governance history (live setup records, retirement payloads or compact
retired-ID metadata) keeps reference-aware retention enabled after deleting the
last governed worker or opting out. This also applies after reload and to offline
release/cleanup. An evidence pin need not have been created for a managed command
to retain its input. Legacy-only stores keep their existing retention behavior.
Use native view pins for snapshot consumers; arbitrary external evidence URIs
are manual metadata and do not make external content managed by this store.

The evidence ledger has an adjacent durable namespace marker. Initialization
publishes an empty ledger before that marker, and existing unmarked ledgers
gain the marker without rewriting their pins. A missing established ledger or
invalid marker blocks collection until its metadata is restored.

`subagent_resource_collect` accepts at most 20 explicit `resultIds` and an
optional `archives: true`. It preserves pending/uncertain results, active or
quarantined leases, active worker/task ownership, board references and evidence
pins. It collects scoped released lease history without resetting sequence
numbers, and can release a collected result's otherwise unreferenced input
submission, preserving any independent native view-consumer pin. Existing view
cleanup performs the reference-aware CAS/Git sweep. Collection also reclaims
auto-sealed governed runner inputs that no live consumer holds. It releases the
exact sealed input of a collected result. An input that a pending attempt still
owns stays retained until that attempt reaches its result. Board references,
evidence pins and native view consumer pins keep their content, and each
release stays inside the exact owner/team scope.

Result collection holds the board and pin reference locks through deletion.
Missing/corrupt metadata or unknown storage stays retained; failures are not
reported as successful reclamation. Complete/cancel setup and quiesce the
owner's workers before metadata maintenance.

`subagent_metadata_rollover` takes `ownerId`, `teamId`, `kind: board | views`
and `expectedEpoch`. It compresses that owner's receipts, commits an incremented
epoch and expires their old request namespace. Use the returned `eN:` prefix on
new requests. Retrying the immediately preceding rollover observes its committed
epoch. **Expired requests return `request_expired`, never a fresh mutation.**
New initial-namespace IDs cannot use reserved `e<digits>:` prefixes, except in
an opted-out (ungoverned) namespace that has not rolled over yet: there such IDs
are ordinary fresh identities, and the first rollover retires them so expiry
stays enforced afterwards. Existing
legacy receipts with those IDs still replay while active. The first rollover
preserves a single bounded set of initial receipt-key identities (at most 1000
board / 4096 view keys), so their later expiry and archive collection cannot
turn a legacy ID into a new operation. This set is never reset or appended.
Worker histories, task records, snapshot/submission IDs and immutable reference
identities remain unchanged. Boards with expiry metadata use schema **2**, so
older non-strict hosts reject them instead of discarding request epochs. Legacy
schema-1 boards remain readable; earlier strict view-index readers likewise
reject the added retention fields. Administer these stores with the updated host.
Board receipt compaction preserves historical
id/version/URI/label identities even after their acknowledgement expires.

The original caps remain: 1000 active board receipts, 4096 view receipts,
1024 command results and 1024 runner lease records. Rollover adds bounded cold
storage: at most 64 archive files per board/view archive directory, 32 MiB
uncompressed per archive, 8192 compact historical board reference identities,
256 owner epoch counters, 1024 evidence pins and 4096 worker tombstones.
Collection can remove expired, unreferenced archives and worker tombstone
payloads. An epoch larger than the 32 MiB archive limit is written as sorted,
deterministic parts that each stay inside that limit; a rollover reports them in
`archives`, and a single part keeps the original payload, source key order, hash
and URI (also still returned as `archive`). The metadata budget counts every recorded archive descriptor and every pending
deletion, including entries whose files are already unlinked, and it stays
separate from the 64-file cap of the archive directory. Both limits are checked
before any part is published, so a present file is never charged twice and the
64th archive still fits. Archive collection first publishes a bounded durable
deletion intent beside the reference removal, then verifies and unlinks only
that owner's unreferenced identities. Reopening a board or view store keeps a
pending intent and never executes it. An explicit scoped collection after
reload checks the current pins and references, so an archive pinned after an
interruption is preserved, another owner's intent is untouched, and a retried or
post-restart collection finishes the rest. Unknown files are never deleted.

Rollover persists one bounded publication intent per owner before it opens any
new archive part. The intent names the exact namespace, owner, from-epoch,
archive identities and receipt keys. Independent owners hold their own intents at
the same time inside the aggregate record budget. A pending publication is
resumed only by its own owner at its exact from-epoch, and a wrong epoch gets
`revision_conflict` naming the pending epoch. Receipts accepted after the intent
stay live and keep their exact replay. Archived and absent IDs stay retired.
Records reserved by a pending intent count against the shared 64-record budget
until that owner finishes that intent. Before a rollover's first registration it
runs that same complete archive preflight, read-only, under its own domain mutex:
the archive directory and its parent must be plain directories, every planned part
is reproduced, every part already present is compared byte for byte, and both caps
are applied with the intent's own parts counted. A physical archive refusal is
therefore reported while the store is still unregistered - no local registration,
no aggregate row, no publication intent and no archive part - and its ordinary
legacy writes stay unregistered. That check writes and unlinks nothing, and a store
that already holds a local registration skips it, so an ordinary rollover never
repeats that archive preparation. Only the durable phase mutates. The durable
filesystem phase of a rollover, covering its fenced preflight, its publication
intent, every archive part and the epoch commit, runs under one store write fence,
and a retry of a pending intent takes that same fence. No resource admission runs
inside the fence, so reclaiming stays available when the lane is exhausted.
Before deleting a tombstone, collection publishes its worker ID in
`retired-worker-identities.json`. Both legacy and governed creation reject
these IDs, including after rollover, reload or feature opt-out; a retired
governed identity cannot regain live tools through legacy spawn. The compact
index and outstanding tombstones share a limit of 4096 distinct immutable
retired-worker identities per session store. The compact index is bounded to
256 KiB and has an adjacent durable namespace marker; missing established or
malformed metadata fails closed. Interrupted collection can leave both forms
and retries safely finish payload removal. At this immutable identity cap,
export the retained namespace for an operator-managed migration; rollover
never permits worker identity reuse. Ordinary legacy-only request semantics
remain unchanged. Epoch counters continue rejecting old governed requests.
Full immutable identity or task namespaces stay retained and fail explicitly rather than resetting.
Scoped view rollover recovers legacy receipts that its own validated records
prove (a record carrying an ownerId, or an exact artifact id). Otherwise an
exact authorized replay establishes that ownership inside the current handle
only: the next successful index mutation, rollover included, publishes it
durably, so a reload before that mutation needs the replay again. Unresolved
receipts stay live, so no owner removes or reads another owner's receipt and no
expired ID becomes fresh. New receipts carry owner metadata. Finish pending
captures/binding intents before view rollover.

The aggregate ledger itself is bounded to 512 claims (at most 480 work claims,
leaving 32 metadata entries for service admission), 256 retained stores,
256 host registrations and 8 MiB. Dead waiting hosts are removed; potentially
active effects stay quarantined. Missing ledger/board documents beside durable
namespace markers fail closed. A stale transaction lock requires confirming
hosts have stopped before removing the lock; never delete the ledger to obtain
capacity. Exclusive lock acquisition retries Windows delete-turnover access
errors for the same bounded interval; persistent denial still fails closed.
A non-draining provider can retain a model reservation indefinitely.
These conservative cases require repair/proof, rather than automatic eviction.
There is no automatic store eviction or identity-namespace reset. At immutable
identity, task or registered-store caps, reuse an existing namespace with room
or export retained records for an operator-managed migration; this stage does
not implement a migration tool.

## Downstream and messaging contracts

- Validation must pin every exact artifact/result it consumes, compare the
  result's **input** revision, record its explicit verdict, then release only
  consumers/evidence no longer needed. A passed input does not validate imports.
- Schedule validation of a candidate independently with pinned inputs. Ordinary
  task dependencies require producer acceptance; using them to gate the work
  that would establish that acceptance creates a coordinator-level cycle. A
  governed session keeps its startup team/task/lane/view binding; use a new
  session for another assignment. Scheduling never chooses or rewrites tasks.
- Integration must use the reserved service lane, retain its source artifacts
  and evidence, recheck live base/editor hashes and path protections, and keep
  acceptance separate from integration. The opt-in workflow that implements
  these decisions is [coordinator integration](integration.md).
- Future message delivery can use `ScheduleWait`/`ScheduleWakeup` and explicit
  `subagent_schedule` waits/wakes. Waiting stores intent and yields resources;
  it neither delivers peer messages nor chooses tasks. Coordinator decisions,
  parent leases, exact identities and drain/quarantine rules remain authoritative.

Each governed worker keeps an opaque, monotonically increasing **wait
generation** (`scheduleWaitRevision`, absent means `0`) beside its wait in its
durable checkpoint. Governed results expose it; ordinary legacy worker responses
keep their existing shape and omit the field. `subagent_schedule` **requires**
`expectedWaitRevision` for both a set and a wake: it is the generation the caller
observed on that worker, not the wait value. The decision is made under the
owning store's mutation authorizer and mutex and re-checked immediately before
the durable rename, so nothing commits from a superseded observation:

- The observation equals the stored generation and the requested wait differs:
  the wait is written and the generation advances by one.
- The observation equals the stored generation and the wait is already identical,
  or the observation is exactly the generation that the stored, identical wait
  was produced at: the request is a **no-op**. It returns the current view
  without writing, advancing or changing the checkpoint, so retransmitting the
  same request — including several concurrent identical retries — is safe and
  commits once.
- Anything else is `revision_conflict` (retryable) naming the current
  generation, and nothing changes. A stale set cannot erase a newer wait, a
  stale wake cannot clear a wait it never observed, and a stale set cannot
  resurrect an older wait after a wake; a generation this host never issued also
  conflicts.

The generation advances by one per applied mutation and never resets when a wait
is cleared, so it cannot silently return to an earlier value. The last safe
integer generation refuses to advance with `wait_revision_exhausted` rather than
losing precision; replace the worker instead of resetting it. Only the two wait
fields are written: turns, messages and archives are untouched. Wait keys stay
opaque: they are compared literally and are never parsed as epochs, paths or
JSON, delivered to a peer or used to pick work. The counter exists only in
checkpoints written by the updated host: a host that predates the field strips it
when it rewrites a session, so govern these stores with the updated host and
re-read the generation before retrying across versions.

Snapshot exclusions, unsupported Git layouts, encodings, capture limits and
runner reopen/process-containment limits are unchanged. See
[isolated views](isolated-views.md), [runner workspaces](runner-workspaces.md) and
[coordinator integration](integration.md).

## Validation

The governance cases in `tests/resource-governance.test.cjs` cover first-turn
provider/tool isolation, interruption at assignment/binding checkpoints, duplicate
requests, cross-team/root/store/host contention, fair admission and service
headroom, live policy reductions, queued cancellation, pre-creation parent
leases, quarantine, reload without replay, owner-scoped metadata rollover,
transitive input retention, legacy epoch-prefix migration, final startup
handoff interruption, admission cleanup failures, cancellable manual compaction,
missing evidence metadata, Windows lock turnover without over-admission, and
legacy startup/maintenance behavior. They also cover mixed legacy/governed
model handoffs, delayed and failed storage samples across hosts, both rollover
admission race directions, and input release queued during runner setup. They
also exercise retained local model ownership across reload/retirement/deletion,
failed recovery reads and reservation deduplication, assignment revocation
during admission and commit, dependency/message waits added during admission,
post-approval task cancellation, and budgeted offline history administration.
`tests/schedule-retry.test.cjs` covers the schedule-wait retry contract: opaque
keys, required generation validation, legacy/governed view shape, durability
across reload, the set/wake compare-and-set that preserves a newer wait, repairs
an exact retry without a write, refuses a conflicting value, commits concurrent
identical retries once and refuses to advance past the safe-integer limit.
Fair model admission covers local governed/legacy contention, deferred handoff
cancellation, parent expiry and feature revocation. Full and zero-length runner
queues exercise service admission and promise transfer without queue growth.
Evidence and rollover tests cover cross-root storage contention, replay/release
at exhaustion, nonblocking pin admission and failed mutation acknowledgements. Real
Windows runner commands exercise approval, import and capacity recovery.
Coordinator admission tests cover creating service tasks and recording
acceptance under production storage pressure, waking dependent work, cancelled
admission without receipts, retry identity, aggregate exhaustion, opt-out and
worker hint rejection. FIFO storage tests compare admission, status and waiter
callback reasons across hosts and lanes. Retirement cases cover legacy spawn
collisions, pre-creation cancellation, interrupted collection, reload/opt-out,
missing/corrupt compact metadata, marker recovery and the immutable identity cap.
Legacy accounting cases cover cross-root budget admission, history writes,
compaction, deletion and measurement quarantine. Offline view cases cover
reclaimed capacity, opt-out, nonblocking pin denial and exact receipt replay.
Command-input cases cover last-worker deletion, opt-out, reload, offline cleanup
and compact retirement identities. Checkpoint cases cover the pre-write boundary,
cross-root contention during legacy measurement, older and concurrent foreign
samples, quarantine, failed repair and reload recovery without replay. Opening
recovery covers live/offline publication and missing established ledgers.
Deterministically delayed model-ticket removal covers cancellation and expiry;
active provider requests still retain their ownership until actual drain.
Opt-out cases cover corrupt/locked foreign ledgers, legacy reload and history
administration without aggregate access. Registration cases cover interruption
on either side of global publication and missing ownership metadata. Recovery
faults cover transient ledger reads, checkpoint writes and accounting, followed
by a clean retry with preserved history. Physical-scope cases cover Windows case
and junction aliases, retained inference, storage charges, runner admission,
checkpoint quarantine, old model-scope migration and copied registrations.
Host payload tests pause real writes during legacy runner materialization,
opted-out capture/private edits, change journaling and result publication;
other roots cannot over-admit from stale charges, while approval still yields
storage for service work. Delayed runner admission cancellation covers caller
settlement and shutdown cleanup drain.

Final checks: `npm test` built the production bundles and passed 786 of 798
tests, with 12 platform/privilege skips and no failures. `npm run typecheck`,
`npm run lint` and `git diff --check` passed. POSIX process execution and a real
VS Code extension-host `npm run test:host` run were not exercised in this
Windows session. Unsupported snapshot layouts and runner containment limits
remain as documented above.
