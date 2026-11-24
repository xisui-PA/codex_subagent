# Architecture

```text
Codex IDE extension
  │ MCP JSON-RPC over stdio
  ▼
stable runtime/relay.js (bundled SDK, using the editor's Node runtime)
  │ authenticated JSON RPC over 127.0.0.1
  ▼
VS Code extension host
  ├─ WorkerBroker → shared-window owners and isolated Git worktrees
  ├─ WorkerEngine → active checkpoints + immutable archives
  ├─ FileTools → WorkspaceEdit, change snapshots, individually approved shell
  ├─ live conversation webview → recovery controls and file diffs
  └─ VscodeProvider → vscode.lm → configured BYOK provider → model endpoint
```

VS Code's API exists only in the extension host; Codex launches an external MCP process. The relay bridges these lifecycles without model credentials. Its capability token rotates on activation and lives in a mode-0600 descriptor inside a mode-0700 directory, never in Codex config. The host rejects browser origins and unexpected Host headers. Other processes running as the same OS user remain within the trust boundary.

The MCP server initializes without a host. Per-call discovery makes startup independent of activation order and reconnects after reload. Canonical roots or a verified registered Git worktree must match the relay's working directory. Each folder/worktree has its own store and pinned tools, independent of the window’s workspace URI or other folders. Overlapping windows attach to the same per-folder owner, then can take over after it exits. Explicit workspaceRoot requests route directly to that folder’s owner. Broker ownership locks never span RPC probes. A local index lock serializes migration/membership updates, and is released before starting hosts or making network requests.

Locked stores forward only to a descriptor advertising that exact root. Repository/worktree fallback is used to discover an unowned scope, never to proxy a locked scope through another checkout. During shutdown the owner remains discoverable with a retryable stopping response until worker effects drain; a missing owner produces a retryable reconnection error. Removed nested roots retain their own store selection even when an enclosing folder remains open.

Legacy grouped stores are partitioned by each worker’s pinned root. Archives and snapshots are copied and synced before the target checkpoint, then the source checkpoint is removed. Existing matching copies allow interrupted migration to continue; conflicting copies stop migration with both originals preserved. Workspace membership records retain history for removed folders, which is browsed without taking lasting ownership. Opening a different window configuration or saving a workspace cannot select a different store for the same folder.

`api.ts` owns schemas, discovery descriptions and tool semantics. Host-side validation repeats validation at the MCP boundary. Spawn/send/resume keys and argument fingerprints are committed in the same file as accepted work, before scheduling/acknowledgment. The relay does not silently retry mutations. Coordinators recover lost acknowledgments using the original key.

`WorkerComposer` persists panel drafts and the complete pending operation in VS Code extension state before submitting it. Acknowledgement clears the pending key; transport and persistence failures retain it for explicit retry. Success cannot erase a newer draft, duplicate submissions share their in-flight promise, and reopening a panel shares the same composer instance. Reloaded panels recover the pending key from storage. Draft saves are not echoed back into the editor, preventing a delayed save from overwriting newer typing.

`WorkerEngine` serializes control mutations, bounds concurrent conversations and runs one turn per conversation. Provider operations and iterators are raced against cancellation, including token counting. An uncooperative external provider may continue its generation, but obsolete output is never committed after cancellation. Internal tools are awaited through cancellation: editor commits/saves and command termination must settle before the worker or store ownership is released. Pending shell approvals may be detached because signal checks prevent late approval from executing a command.

Cancellation finalizes queued jobs that were aborted before entering a turn, and the scheduler rejects queued sessions without any runnable turn. POSIX command termination keeps its forced group kill alive through shell exit, so an early shell close cannot release descendants that ignored SIGTERM. Status reads preserve runtime checkpoint failures; archived turns are fetched only when their output is absent from the current view.

Manual Revert uses a tracked edit job registered under the control mutex, with execution outside that mutex. Conflicting controls are blocked and shutdown drains the edit before releasing ownership. Its durable maintenance marker restores the prior task state after an interrupted host and records that file effects require inspection. Discovered worktree membership is persisted in the workspace index before use. Missing or unregistered scopes are retired by withdrawing their bridge and draining their jobs, then listed and administered through saved storage without requiring the former root path.

```text
spawn/send → queued → running → completed
                       ├─ generation/deadline failure → failed
                       ├─ coordinator cancellation   → cancelled
                       └─ shutdown/restart           → interrupted

failed/cancelled/interrupted → explicit resume → queued
```

Follow-ups queue behind active work. Failure suspends later turns until resumption; queued turns remain in the archive. Completion is recorded only after committing its transcript. Assistant tool calls are committed before invocation; each execution is marked started before effects, then completed together with its result message. Missing results are sealed as uncertain on recovery instead of replayed.

Unfinished streaming text is partial output, not a completed assistant message. Resume provides it as unfinished context alongside committed interactions. Before context/storage/turn limits, bounded model-generated summaries roll active history into immutable archive files. The archive is written before its pointer and reduced active checkpoint are committed, so a failed rollover never deletes the original. Global message offsets span all archive segments. Manual model-based compaction is asynchronous, cancellable maintenance and does not hold the control mutex during inference; a supplied manual summary can be committed directly.

Session updates apply to a clone and publish in memory after fsync/atomic rename. New session creation uses exclusive creation, reserving IDs even when an existing transcript is corrupt. Corrupt bytes are copied to quarantine rather than overwritten. A process-owner lock protects each store while other windows use the owner's authenticated bridge. Editor changes use WorkspaceEdit for undo and preserve already-dirty buffers; standalone test filesystem tools use atomic replacement or exclusive creation. Pending change snapshots precede effects. Actual post-save text, including save participants, replaces the intended after-image before publishing applied metadata and returning its hash. Hash preconditions are not atomic compare-and-swap against arbitrary external writers or an OS sandbox.

Enable/disable sync with settings: Enable Model is a user-initiated inert tool-call and tool-result replay test that, only after it passes, adds the exact model ID to the user-level `codexSubagent.models` setting (existing entries keep their policy and order); Disable Model removes just that key. There is no separate default model: pool key order is automatic selection priority. Provider request options are the optional nested `modelOptions` object of each pool entry; the former top-level shared/profile settings were removed without fallback. Runtime inference requires affirmative VS Code access. Changed/unavailable models fail explicitly; replacement is chosen on resume. There is no credential extraction or direct-endpoint fallback. Stable relay copies and managed-registration repair avoid versioned installation paths becoming stale.

Owners label parent conversations and scope operation keys. Mutating MCP controls require the worker's owner ID. Optional leases cancel unattended work; explicit parent stop applies to managed workers. MCP logging and VS Code notifications report terminal changes, while polling remains available. Native Codex cancellation events and native agent UI are outside this extension's API surface, so transport disconnects do not imply cancellation. Owner IDs coordinate agents but are not authentication between OS users.

Workers use private tools rather than arbitrary extension tools, which might depend on Copilot invocation tokens, unrelated permissions or recursive MCP calls. Shell execution is optional, approved for each exact command, and independent of Codex permissions.

## Task board (opt-in)

Implemented in the host runtime and the extension: the setting is read live through a User-only scope, every board call is gated per call, the tree renders bounded summaries, and full records open read-only. Board metadata stays separate from worker control, dispatch and acceptance.

- Storage: one board file per canonical root, inside that root’s `SessionStore` and under its existing owner lock. No separate board process, lock or relay path.
- Records: teams and tasks carry independent revisions; each keeps bounded transition history with monotonic sequence and trim metadata. Corrupt or foreign-root data fails closed without modification.
- Idempotency: a receipt and its original result are committed atomically with the mutation. Fingerprints are canonical over action and arguments, so identical retries replay and changed arguments conflict. Capacity is explicit; nothing is silently evicted.
- Identity: hosts pass a trusted coordinator scope (`ownerId`); a worker’s board identity is bound to its own session and limited to private progress, blockers, candidate refs and its lifecycle subset.
- Guard: the worker authorize/feature/abort guard is invoked inside the board mutation mutex immediately before persistence, so a call queued behind another write rechecks policy instead of trusting an earlier precheck.
- Dependencies: `contract` dependencies require agreed refs that are independent of the implementation; `artifact` dependencies require an accepted producer. Dependencies are task-level `{taskId, kind}` and do not pin a version.
- Feature gate: `codexSubagent.taskBoard.enabled` is User-level and read live; the extension checks `inspect().globalValue` so a repository value can never enable it, and the editor view/context key follow the same callback. Discovery still lists the 8 board tools; while off, the host refuses every call with `feature_disabled` and workers receive no private board tools. Flipping it refreshes only the board view and context: no broker restart, no model or permission reconfiguration, no worker interruption.
- Validation and acceptance: verdicts are append-only, keyed by artifact id and exact candidate version and retained in insertion order; a distinct re-recorded verdict appends another entry, so a later `failed` supersedes an earlier `passed`, while a byte-identical verdict is deduplicated even under a new `requestId`. Acceptance requires the task to be `validating`, clean readiness, and the **last appended** verdict for the **latest** version of every candidate to be `passed`: a pass for an older version never satisfies a newer one. Only the coordinator records verdicts; a worker cannot.
- Immutability: references are keyed by `id` and `version`. Recording the same pair again never rewrites its `uri` or `label`, and a different URI for that pair is rejected. Verdicts stay append-only: an existing verdict and its `resultRef` are never rewritten, distinct repeated verdicts for one artifact version are kept in insertion order, and byte-identical repeats are deduplicated. Task-scoped candidate, contract, and report `id`+`version` identities (their exact `uri` and `label`) are checked against the current records and against every retained task receipt on open and on commit; contract revocation and task rework clear the active agreements or verdicts without freeing the underlying identity. Any future receipt compaction must preserve that identity history, and a contradictory durable history causes the board to refuse to open without rewriting stored records.
- No automation: no auto-dispatch and no automatic acceptance. `accepted` is distinct from `integrated`, and integration runs only as an explicit coordinator attempt. Explicit coordinator acceptance remains a normal board update.
- Response bounds: `subagent_team_list` and `subagent_task_list` both page at the adapter (`offset` default 0, `limit` default 20, max 20, answers `{teams|tasks, nextOffset}`) and stop at a 3,000,000-character serialized page budget, returning fewer items with `nextOffset` advancing by exactly what was returned; one item that cannot fit fails with `response_too_large`. Team listing needs paging because 100-entry histories are its largest field, not because of the 64-team count. `listTeams` stays a raw synchronous array for worker membership filtering; paging is adapter-only. Status snapshots are bounded summaries with clipped `…Preview` fields, first-few detail lists plus `<list>Count` totals, exact ids/edges, a `truncated` flag, and no reference URIs or transition entries. Caps are sized for doubly encoded JSON (a control character costs seven envelope characters), so even 512 maximum-size tasks stay far inside the bridge limit. Only status snapshots are summaries: the MCP `subagent_team_get`/`subagent_task_get` tools and the paged list results carry full records, and `codexSubagent.openBoardRecord` is the editor path that shows one.
- View and full records: the **Task Board** view renders bounded summaries only. `codexSubagent.openBoardRecord` reads the board summaries, takes the team's trusted `coordinatorOwnerId` from the record (never from UI input), and re-reads the team and task through `subagent_team_get`/`subagent_task_get`. The full JSON, including transition entries and reference URIs, opens read-only through the `codex-task-board-record` content-provider scheme, so nothing implies an editable or savable document. Manual hard deletion is available only through `codexSubagent.deleteTask` and `codexSubagent.deleteTeam` (view context menu or Command Palette). Each resolves the requested node against a fresh board status, prepares read-only through `ui_board_delete_prepare`, shows an explicit modal confirmation naming the item, root and ids, and then sends exactly one `ui_board_delete_task`/`ui_board_delete_team` with the host-returned epoch-qualified request id and exact revision. Cancellation mutates nothing; an error is surfaced without automatic reprepare or retry and refreshes only the board view. These routes are not MCP tool-catalog entries. Deletion is hard, keeps the normal idempotency receipts, never cascades from a team, and removes neither artifacts nor retained worker/runner/integration content; deleting a team ends live membership authorization, so retained resources must be administered first.
- Shutdown: root shutdown awaits `board.close()` before the `SessionStore` owner lock is released.

Validation `resultRef` entries remain manual metadata: they record an id, version and URI without automatically fetching or verifying content. Opt-in [isolated file views](isolated-views.md) now provide shared immutable snapshots, private overlays, sealed submissions and explicit retention. Governed view cleanup now treats current board references and retained evidence pins as retention roots; consumers must still pin exact inputs before use. Opt-in isolated runner execution for bound workers is implemented too (see below). Opt-in step-5 coordinator integration is implemented as explicit decisions, and opt-in step-6 [team mail](team-mailbox.md) carries durable structured peer messages, while automatic dispatch and automatic acceptance remain unimplemented. Subsequent consumers must pin exact artifacts and preserve the task/worker state separation.

## Isolated runner workspaces

Isolated runner execution is a separate, opt-in service layered on the existing per-root host; it never reuses live-workspace tools and never upgrades an unbound legacy worker. It is enabled by the User-only settings `codexSubagent.isolatedViews.runners.enabled` (default false), `.capacity` (default 2, 1–8) and `.maxQueue` (default 32, 0–256). Enablement is read live from the global value; capacity and queue bounds are resource configuration applied to the canonical root when its pool reopens. While the flag is off, a bound worker's `run_command` returns `isolated_shell_unavailable`, no runner storage or execution is created, and legacy routing is untouched. Existing runner records, status and cleanup remain readable with the parent view flags enabled, without approval UI and without the execution flag.

- **Slot pool.** A durable journal (schema, root, revision, sequence and lease records) grants one exclusive slot per owner per canonical root, tracked with that root's `SessionStore` rather than per window. A reservation is persisted before any directory may exist, so a reopen can tell "never started" from "may have run". A slot covers setup, awaiting approval, execution, import and cleanup; a quarantined slot keeps consuming physical capacity until an explicit cleanup proves the owned process drained; a corrupt journal, or a missing journal beside existing slot directories, fails closed. The pool adds no second global lock: the `SessionStore` owner lock still decides which host owns a root, and manager close waits for unsettled runner I/O rather than releasing it early.
- **Queueing.** Requests enter the bounded FIFO queue for the root before a slot is granted, and the approval prompt appears only after that grant, so the queue holds waiting requests rather than approved commands. Overflow is an explicit capacity error, cancellation removes a waiting request, and a denied request never runs.
- **Physical view.** One coherent snapshot + overlay revision is materialized as ordinary files (raw bytes, BOM and EOL preserved, file modes applied) in fresh source and temp directories. Unsupported entries fail setup, hard links are never created, and the view's release mutex is respected before a command starts. Supported changes import back as one atomic operation after exit/failure/timeout/cancel when policy allows; a stale overlay is never overwritten and the runner is retained instead.
- **Command results.** A pending attempt is durable before execution; the final record is immutable and versioned with a deterministic URN, the exact input and after versions, import status, outcome, exit code/signal, bounded output and setup identity (environment hash, platform, shell, runtime, caches). The versioned worker command output returns that full stored result plus its result id. A pending attempt recovered after reload becomes `uncertain` and is never replayed. Caps: 1024 records, 128 MiB total, 1 MiB per result, 100,000 output characters. Start-time capacity is checked against the pending record only, so a start capacity error refuses execution before it begins; the final record is sized separately at finish, and a final capacity or write failure is never reported as success — the pending attempt and its directory are retained or quarantined and reload as `uncertain`.
- **Approval.** Isolated commands have their own prompt and their own grant kind keyed by logical root, so workspace grants never approve isolated requests and isolated grants never approve legacy ones. The prompt shows the logical project, the physical execution root and working directory, and the exact input revision. It does not present the working directory as an OS sandbox: relative paths stay in the view, absolute OS paths are not remapped, and the shell keeps the user's access.
- **Caches.** Only `npm`/`pip` download caches are reused. Installed dependencies, build output and temporary directories are fresh per slot, so a run never inherits another run's tree, and nothing installs without approval; combine steps inside one approved command (for example `npm ci && npm test`).
- **Containment.** Windows uses a Job Object with a suspended assign, no breakaway and an active-zero drain proof; POSIX uses an owned process group plus an inherited marker discovered through readable `/proc` or `ps`. Incomplete or failed scans quarantine instead of guessing, no path kills by bare PID, and runtime identity is validated before recovery. Deliberately scrubbed environment values and changed OS identity are outside this contract: containment is not an OS sandbox.
- **MCP surface.** `subagent_runner_status` pages leases, queue entries or result summaries for the caller's owner and team with a bounded summary block; `subagent_runner_result` returns one full immutable result plus derived current-revision and staleness fields that are null when the current index is unavailable, never rewriting the evidence; `subagent_runner_cleanup` reconciles the scope with no new command and carries a `destructiveHint` tool annotation so clients can warn before calling it.
- **Coordinator control.** Governed step-4 startup now executes explicit create-bind-start decisions, no task planner or automatic acceptance exists, opt-in [team mail](team-mailbox.md) carries structured peer messages, and integration requires the explicit step-5 decisions. A stored command result is evidence only: it is not an artifact pin and not a validation verdict, and a command that ran on one input revision never validates a later one.

## Coordinator integration (step 5)

`subagent_integration` runs one explicit coordinator decision per call: begin,
status, candidate, validate, accept, apply or release. Beginning pins 1–16 exact
sealed sources over one common base snapshot, records immutable requirements,
contract versions, observed evidence and merge conflicts, then composes a
CAS-backed private seed whose derived snapshot id differs from the original
base. A governed service-lane worker validates the clean seed unchanged at
overlay revision 0, or proposes an integration-lane candidate over the derived
seed. Validation matches each agreed command to one exact succeeded, drained,
import-free runner result for the candidate's input revision. Acceptance names
every resolved conflict path, and a separate apply publishes the accepted
candidate through a per-file durable journal with raw bytes and live base
checks. The journal is per file, an interrupted publication is proof-only, and
no Git commit or network publish occurs. See
[coordinator integration](integration.md).

## Team mailbox (step 6)

Opt-in durable messages between one coordinator and the members of one team,
gated by the User-only `codexSubagent.taskBoard.messaging.enabled` flag on top of
`codexSubagent.taskBoard.enabled` and stored per canonical root beside the
board. It is a record channel. It starts nothing, resumes nothing and changes
no board record. A send never mutates scheduling. Only the governed scheduler clears the wait it observes once a correlated live reply exists.

- **Identity.** Coordinators call the three mailbox tools with `ownerId` and the
  optional `workspaceRoot`. Workers call the same names with their session
  identity and reach only their own team and root. The coordinator reads every
  retained team event, while a worker reads only what it sent or received, and
  only while its membership is live.
- **Sends.** One event carries `teamId`, `taskId`, `requestId`, `kind` and a body
  of at most 1024 UTF-8 bytes, with one to four destinations from worker ids or
  the team coordinator. A `replyTo` reply routes to the original sender alone.
  An exact retry replays the retained receipt, changed arguments conflict and an
  expired replay is refused while its tombstone lasts.
- **Delivery.** Mail is durable before it is offered, it is offered in bounded
  batches only at normal provider boundaries of a worker that is already
  running, and it is delivered when the provider emits a part for that prompt
  and the receipt commits. The bounded block is checkpointed into the worker's
  own transcript exactly once, before the receipt, so later requests replay the
  same body and event id as ordinary history while a failed receipt is retried
  when that retained input is presented again. Acknowledgment is a separate
  explicit call. A stopped worker stays stopped, and nothing is broadcast or
  answered automatically.
- **Waits.** A governed bound worker asks with `subagent_mailbox_wait` as the
  only tool call of its round. The wait yields capacity, an authorized matching
  reply clears only the observed wait generation, and cancellation or timeout
  fences it. `subagent_schedule` against the observed wait revision stays the
  coordinator's own decision, and a message by itself never starts a turn or
  changes permissions.
- **References.** A message carries identity, never retention. `artifact_ready`
  names an exact sealed `{id, version, uri}`, evidence names the exact runner ref
  and an attempt is `{id, revision}`. Unretained values are reported, existing
  retention and composition APIs grant access, and no message exposes another
  worker's mutable overlay.
- **Authority.** An `interface_response` is informational. A contract agreement is
  an explicit `subagent_task_update` with the expected task revision, and board
  state, verdicts, attempt acceptance and apply stay separate decisions.

## Resource governance and create-bind-start

Step 4 is implemented behind the User-only resources flag. Its
[configuration and contracts](resource-governance.md) distinguish inference,
runnable effects, dependency/message waits, physical runner ownership and
retained storage. Every session is stored in the one current format, schema
3 with an explicit `mode` (`standalone`, `isolated` or `governed`), derived by
the host and never chosen by input; older session formats are refused and
preserved rather than read, upgraded or mapped. Governed startup persists a
non-runnable gate before the atomic board membership/assignment transaction
and private-view binding. An OS-user ledger grants explicit coordinator
decisions through fair eligible queues, reserves service capacity and retains
uncertain ownership through cancellation/reload. Current histories and
per-root pool dimensions remain supported.

Owner receipt epochs, compressed archives, compact reference identity history,
evidence pins and explicit collection bound metadata alongside content GC.
Missing namespace documents fail closed and expired requests cannot become
fresh mutations. Validation and integration are explicit coordinator stages
with exact input revision and retention obligations, described in
[coordinator integration](integration.md). Opt-in [team mail](team-mailbox.md)
is the step-6 messaging stage. It delivers durable events to a worker that is
already running, waits explicitly with `subagent_mailbox_wait`, and grants no
wake, dispatch or permission authority on its own.
