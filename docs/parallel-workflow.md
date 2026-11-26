# Parallel workflow (opt-in, experimental)

Operating protocol for one coordinator that runs several workers at once and for
the workers it starts. Every surface named here is implemented behind an opt-in
User setting; treat the workflow as experimental because end-to-end and platform
checks are not complete, and do not report a guideline as verified capability. The linked documents carry the per-tool detail, limits and
recovery rules, so this guide stays a protocol rather than a second reference.

## Flags and scope

All flags below are User (machine) scope, default `false`, and read live; a
repository setting cannot enable or widen them.

- `codexSubagent.taskBoard.enabled` – teams, tasks, dependencies, candidates,
  validations and the **Task Board** view.
- `codexSubagent.isolatedViews.enabled` – snapshots, private overlays and
  sealed submissions (requires the board).
- `codexSubagent.resources.enabled` – governed create-bind-start, aggregate
  budgets and the governed waits.
- `codexSubagent.isolatedViews.runners.enabled` – private shell for bound
  workers only.
- `codexSubagent.isolatedViews.integration.enabled` – coordinator integration
  attempts.
- `codexSubagent.taskBoard.messaging.enabled` – durable team mail (requires the
  board).

Enable only what the plan uses and leave the rest off. With a flag off, the
tools stay discoverable and calls that need the missing capability are refused
(`feature_disabled`, or `isolated_shell_unavailable` for a bound `run_command`),
and no new storage or execution is created. Existing recorded runner state is
not frozen by that: `subagent_runner_status`, `subagent_runner_result` and
`subagent_runner_cleanup` stay usable with the parent board and view flags on,
without the execution flag and without approval UI. Behaviour that does not
depend on these flags is unchanged with all of them off: legacy
`subagent_spawn`, send, resume, cancel and discard, the legacy workspace shell
and its grants, transcripts, archives and previews. A bound worker never falls
back to live files or the legacy shell.

A physical command needs `workspace-write`, an enabled model whose policy allows
writes and shell, and authorization under the isolated grant that currently
applies to its logical project at the time it is requested: either a one-off
approval or a workspace-session grant for that project. Grants are keyed by
grant kind and logical project root, not by worker, so an existing isolated
project-session grant can cover later isolated commands from several workers in
that project. The isolated grant kind never approves a legacy request and the
legacy grant kind never approves an isolated one, and parent Codex approvals and
sandbox are not inherited by any worker. A request queues for a slot before its
prompt, so a denied, closed or cancelled request runs nothing.

## Two shapes of parallel work

### Clear-boundary work

The unit of parallelism is an independent, privately owned outcome.

- Agree the interface and the acceptance criteria **before** implementation
  starts, and record them on the board: acceptance criteria on the task, the
  interface as an agreed contract ref with `subagent_task_update` and the current
  `expectedRevision`. Only the coordinator records that agreement.
- Give each worker a complementary private outcome over that agreed interface.
  Workers never edit each other's overlay or a shared mutable file, so no
  coordination happens through the file system.
- Settle a stable contract before dependent implementation begins. Record the
  need as a `contract` dependency on the producing task, or an `artifact`
  dependency when accepted output is required; a dependency names only
  `{taskId, kind}`, so resolve the exact agreed ref or candidate separately
  before relying on it.
- Consumers resolve **exact versions and the actual derived files**: the exact
  candidate `{id, version, uri}`, the snapshot id it was sealed over and its
  overlay revision. "Latest" is not a reference, and a newer revision of the
  same worker is a different artifact.

### Coupled work

When two changes touch the same surface, one owner writes it.

- Name one **primary owner** for the coupled surface. It is the only writer for
  that surface.
- Parallel work is then immutable: investigation of the current tree, test
  design, and review of sealed submissions. Those produce reports, seals or
  private alternative implementations, not edits to the owner's files.
- Private alternatives are useful and allowed when they are cheap and
  independent: a second worker may build a competing implementation in its own
  overlay under its own task, so the coordinator can compare sealed results.
- Competing approaches are then **selected explicitly**. The coordinator records
  the chosen approach and, if it matters, seals or names the rejected one.
  Overlapping alternatives are never required to be merged, and no worker merges
  them on its own initiative; an actual merge is the coordinator's explicit
  decision and follows the integration path below.
- Dependent implementation starts only after the selected contract or seal is
  exact, so no worker codes against a proposed interface.

## Create and bind before the first implementation turn

The full lifecycle completes before a worker's first edit: team, task,
snapshot, binding. Capture the snapshot only after the team exists, because
`subagent_snapshot_create` is scoped by `ownerId` and `teamId`.

- **Governed path.** Create the team, a `ready` and unassigned task and the
  snapshot, then call `subagent_isolated_spawn` with the normal spawn arguments
  plus `setup: {teamId, taskId, snapshotId, teamRevision, taskRevision, lane}`.
  It persists a non-runnable worker, establishes membership and assignment in
  one board transaction, publishes the durable private-view binding, and only
  then queues the first turn. Phases are `created → assigned → bound → ready →
  started` (`cancelled` leaves it stopped). `lane` is one of `work`,
  `validation`, `integration` and only reserves capacity. The task itself stays
  `ready`; the worker moves it to `in_progress` as its own board update.
- **Board + views only.** Create and assign the task explicitly, then
  `subagent_view_bind` an already stopped, owned team member to the snapshot, and
  resume it. Binding never starts inference.
- **There is no general deferred-spawn API.** `subagent_spawn` always starts its
  first turn immediately, and no tool creates a stopped worker for a later
  start; `subagent_isolated_spawn` is the one call that performs a stopped
  internal setup and then starts the worker. The legacy bootstrap
  (`subagent_spawn`, cancel, then `subagent_view_bind`) works but leaves earlier
  legacy turns in the transcript: those turns stay legacy, are never rewritten,
  and their changes were made in the live workspace.
- Retry interrupted setup with the **same** `requestId` and arguments. Stale
  `teamRevision`/`taskRevision` values leave setup stopped: inspect it, cancel
  it, and make a new decision with current revisions and a new request id.
  Ordinary send/resume cannot bypass incomplete setup.

### Exact-consumer recipe

A dependent task that needs a producer's files gets them from a composed seed,
never from board readiness. Every producer task must already be accepted, every
selected artifact must be a current candidate of that task at its current
revision, all sources must be sealed over one immediate base snapshot, and each
source must carry at least one scoped runner result that succeeded, drained with
no surviving process and imported nothing.

1. Read each producer with `subagent_task_get` at its current revision and copy
   its accepted current candidate `{taskId, taskRevision, artifact: {id,
   version, uri}}` with its exact `evidence` refs, plus every agreed contract ref
   the selected tasks and the consumer need.
2. Pin what you will consume: `subagent_view_pin` for the submission,
   `subagent_evidence_retention` for each exact evidence URI.
3. Call `subagent_integration` with `action: "begin"`, the exact sources, the
   `contracts`, and `consumer: {taskId, taskRevision}` naming the dependent task
   at its current revision. Any explicit `consumer` makes the attempt seed-only:
   `validationCommands` may be omitted or empty there, and a seed-only attempt
   can never be validated or published, only released.
4. Read the returned `derivedSnapshotId`.
5. Start the dependent worker with `setup.snapshotId` equal to that
   `derivedSnapshotId` (exact team and task revisions, chosen lane), or bind an
   already stopped member to it, **before its first implementation turn**.

Readiness alone delivers no files: a `ready` task, an `artifact` dependency or a
mail message gives no content. The composed seed bound to the worker is what the
dependent turn actually reads. If composition reports conflicts, follow the
[downstream bind recipe](integration.md#downstream-bind-recipe) rather than
binding the seed as it stands.

## Seal early, then stop for review

A checkpoint is a sealed revision plus the exact ref that names it.

- The worker seals with `seal_submission` (`requestId`, `expectedRevision`); the
  coordinator can seal the same way with `subagent_view_seal` and the worker
  `id`. Later edits leave an earlier seal byte-for-byte unchanged.
- Report the exact `{id, version, uri}` with the file list, the snapshot and
  overlay revision, and what was not checked. A seal is an artifact, never
  acceptance, validation or integration. A board candidate ref is its own board
  identity: whether it names a managed sealed submission is decided by
  integration resolution when the attempt matches the exact ref, so never assume
  a logical id maps to a submission id — copy the returned values or verify them
  at `begin`.
- Seal at the earliest useful boundary, then **pause or stop** and let the
  coordinator review before continuing. Extra unrequested work costs capacity
  and muddies review.
- The coordinator reads the seal with `subagent_submission_read`
  (`read_file` / `list_files` / `search_files`); it never reads live files and
  never rewrites the evidence.
- **Never inspect or patch another worker's mutable implementation while it is
  running.** Read the sealed submission instead. Reading an overlay mid-turn
  races the worker and sees an intermediate revision that no seal describes.

### What a reference retains

Retention depends on which capability is running.

- **Legacy view retention:** a board reference, acceptance record or validation
  metadata is not a retention root.
- **Governed, reference-aware cleanup:** current board references, active
  receipt references and evidence pins are retention roots and protect
  submission content during view release and cleanup. A managed command result
  keeps its sealed input while its evidence is stored, even after the last
  governed worker is deleted, after a reload, offline, and after the owner opts
  out; collection preserves board references and evidence pins.
- **In both cases** an explicit pin before consumption stays the consumer's own
  obligation (`subagent_view_pin`, `subagent_evidence_retention`), and mail
  identity alone retains nothing. An arbitrary external evidence URI is manual
  metadata and never makes outside content managed by this store.

## Tasks, blockers and agreements

- Board states are `ready → in_progress → submitted → validating → accepted`,
  plus `failed` and `cancelled`. There is no `completed`.
- **Blockers gate board transitions and acceptance, not every execution path.**
  A task with any blocker is not ready, so `ready → in_progress` and
  `in_progress → submitted` are refused with `transition_blocked`, and `accept`
  is refused with `acceptance_invalid`, together with unmet dependencies. That
  refusal is the board's own gate in every board task. Automatic gating of
  inference and tool execution is narrower: only a GOVERNED worker (created by
  create-bind-start, which requires `resources.enabled`, and carrying a durable
  startup record) is stopped by task readiness and terminal states before a turn
  and again during admission. A worker bound with only the board and view flags through
  `subagent_view_bind` (isolated mode, no startup record, resources off) has no
  such check, so its private `write_file` can still succeed while its task
  carries a blocker. The coordinator therefore must withhold send, resume and
  dispatch on a non-governed worker itself instead of relying on the board to
  stop it. Clearing a blocker is a board update on that task; progress text, a
  follow-up or a mail reply never clears one and never releases execution.
- A worker updates **only its own task**: `progress`, `blockers`, `candidates`
  and the lifecycle subset `in_progress` / `submitted` / `failed`. It cannot set
  contracts, dependencies, validations, assignment, `validating` or acceptance.
- **Candidate refs are append-only.** Recording a candidate appends an immutable
  `{id, version, uri}`; the same pair again is an exact no-op, an empty list adds
  nothing, and nothing removes a recorded candidate. A later version may be
  appended for the same id, but acceptance requires the latest version of
  **every distinct artifact id still recorded** to carry a passed verdict, so no
  candidate update can retire a bad identity from the acceptance gate. Never
  promise candidate replacement, and never try to accept a failed prior identity
  just to clear the board.
- **Structural edits need an editable state.** Assignments and dependencies can
  change only while a task is `ready` or `failed`; every other state refuses them
  with `transition_invalid` because structure freezes once work starts. A
  worker's agent-level completion is not a board terminal state: `submitted`,
  `validating` and `accepted` remain the board's own facts, so re-read the task
  before planning a follow-up.
- **New work gets a new task.** For independent review, a new role or another
  module, create a fresh `ready` task and a new worker, and record that output
  there. Accepted tasks are immutable: do not reassign them, retarget their
  dependencies or reuse their candidates for something else.
- **A terminal task stops its governed worker.** Once a governed worker's task is
  `accepted`, `cancelled` or `failed`, later execution is refused with
  `task_stopped` at the pre-effect boundary, so the worker cannot continue in
  that task. Perform the seals, checks and validations you need *before*
  accepting, and give any subsequent role a fresh `ready` task and worker rather
  than resuming an accepted governed worker for more execution.
- **Real rework keeps the record.** When work genuinely failed, preserve the
  earlier candidate artifact and history, record the real failed verdict and the
  `failed` state, then move `failed → ready` with the reassignment and continue
  from `in_progress`. Never mark successful work `failed` merely to hand it off.
- **Iterate before committing a candidate.** Keep early checkpoints as sealed
  refs and progress text, and record a board candidate only once you are choosing
  what to review. If distinct failed ids are already recorded and no passing later
  version can supersede them, do not force acceptance: leave that task accurately
  `failed` or `cancelled` with its histories retained, and create a fresh task for
  the final review from the sealed submission you actually want to stand behind.
- Mail kinds are the whole vocabulary: `question`, `reply`,
  `interface_proposal`, `interface_response`, `discovery`, `blocker`,
  `artifact_ready`, `integration_feedback`, `escalation`. Keep one question per
  event so a reply stays routable to one sender.
- **An agreement is always a board record.** A worker proposes with
  `interface_proposal` and records its blocker or status; the coordinator records
  the agreed contract with `subagent_task_update` against the current revision.
  `interface_response` is informational, and no worker can settle a contract,
  record a verdict or accept work.
- Mail carries identity only: `artifact_ready` names an exact sealed
  `{id, version, uri}`, evidence names the exact runner ref, an attempt is
  `{id, revision}`. A bare URI resolves nothing; report an unretained reference
  instead of dereferencing it, and remember that no message exposes another
  worker's mutable overlay.
- A send has **no direct dispatch or scheduling effect**: it never starts,
  resumes or wakes a stopped worker. Automatic handling is scheduler-only: a
  correlated authorized reply clears just the exact wait generation that
  observation saw. A coordinator may also clear a wait explicitly with
  `subagent_schedule` `wait: null` at the generation it read, and nothing else
  changes the worker. Mail grants no task, tool, permission or approval
  authority.

## Waits and peer replies

- A coordinator sets or clears an explicit wait with `subagent_schedule`, passing
  the `scheduleWaitRevision` it read from `subagent_status` as
  `expectedWaitRevision` and a wait of `{kind: 'message', key}`. `wait: null`
  clears that same generation. A superseded generation fails with
  `revision_conflict` and changes nothing, so re-read the worker before retrying.
- A message is not a wakeup. It never starts, resumes or schedules a turn and
  never changes a permission; a stopped worker continues only with an explicit
  resume.
- Automatic clearing is scheduler-only: a correlated authorized reply clears
  only the exact wait generation that observation saw. A coordinator's explicit
  `subagent_schedule` decision can also clear the wait, but only by passing
  `wait: null` with the generation it just read.
- A governed bound worker may call `subagent_mailbox_wait` for a `question` or
  `interface_proposal` it sent itself. It must be the only tool call of that
  round and yields the worker's capacity while it waits; a correlated authorized
  reply makes that worker eligible to continue, and nothing else changes.

## Runner evidence: input revision versus after revision

A bound worker's `run_command` is bounded private shell over one materialized
snapshot + overlay revision. It is not an OS sandbox: relative paths stay inside
the materialized view, absolute OS paths are not remapped, and the command keeps
the account's real access.

- The stored result is immutable and versioned: command, `inputVersion`,
  `afterVersion`, import status, outcome, exit code and signal, bounded output,
  drain flag and setup identity, with a deterministic reference.
- `afterVersion` is exact: an import keeps the same snapshot and overlay and
  advances the revision by exactly one, `unchanged` repeats `inputVersion`, and
  every other status is `null`.
- Evidence is bound to the **input** revision. A command that imported files
  produced a new revision that no command has tested, so re-run before claiming
  the new revision passes; read a result with `subagent_runner_result` and use
  its exact ref.
- **Lease phase is a high-water mark, not liveness.** A lease records the
  furthest phase it reached, and it only ever advances, so a released lease can
  still read `executing`. Judge liveness from the lease `state` (a released lease
  is gone even with a late phase) together with the current summary and the
  stored `result.drained`, never from `phase` alone.

### Encoding and line endings

The view's text tools are UTF-8 only. A NUL byte, invalid UTF-8 or a file over
2 MB is refused as `file_limit` rather than guessed at. A UTF-8 BOM stays part
of the returned text and of the raw SHA-256 that writes and patches verify.

- `patch_file` normalizes only its own `oldText` and `newText`: a uniform LF or
  CRLF file keeps its style, and mixed endings require an exact match.
- A whole-file `write_file` is verbatim: the supplied `content` is stored as
  UTF-8 exactly as given, with no adaptation to the file being replaced.
  Supplying LF content for a CRLF file replaces its endings with LF, and content
  written without a BOM stores no BOM. The caller retains responsibility for
  both.

That is not general encoding preservation: captured editor text is stored as
UTF-8 without its original encoding metadata, so an editor override is not
encoding-preserving, and a runner must not treat one as such. Raw runner and
publication paths move raw bytes and can preserve an arbitrary encoding.

## Combined validation, then accept, then apply

- A conflict-free derived seed can be validated unchanged at overlay revision 0
  by a `validation`-lane worker. An `integration`-lane worker seals a changed
  candidate at a higher revision over the same seed.
- The integration worker is **optional, and conflicts are not its only reason**.
  It is needed when composition reported conflicts, and it can equally be needed
  when composition was clean but the combined result fails the agreed checks:
  the lane owns the repair, seals it, and the exact agreed commands are rerun
  against that candidate's input revision. Either way, validation runs on the
  clean seed at revision 0 or on the integration-owned repaired candidate, and
  then the exact command list is executed and recorded again.
- Combined validation is one exact, ordered command list agreed at `begin`. Each
  `validate` entry is the exact stored runner result for the candidate's exact
  input snapshot, overlay and revision, succeeded, drained with no surviving
  process, importing nothing, and byte-identical to the agreed command.
- Integration runs one explicit decision per call: `begin` → `candidate` →
  `validate` → `accept` → `apply`, with `status`, `details` and `release` for
  inspection and cleanup. `begin` pins the exact sealed sources over one shared
  base and composes a private derived seed; the field that names it is
  `derivedSnapshotId`, and it differs from the base.
- **Board acceptance and integration acceptance are different decisions, and
  `apply` is a third one.** `apply` publishes through a durable per-file journal
  against live workspace and editor preconditions. Any open editor on a touched
  path in the owning window is a conservative conflict, whether or not its
  buffer is dirty, and so is a captured editor override with unknown provenance,
  a stale file or hash, or a changed inventory. An interrupted publication is
  reported and needs a new attempt. Nothing commits to Git and nothing publishes
  to a network remote.

## Recovery and cleanup

- Cancel stops generation, suspends queued turns and keeps tool side effects
  that already happened; resume explicitly with a new request id.
- Reload leaves work interrupted; nothing replays queued inference or uncertain
  tool calls. A pending runner attempt found after reload becomes `uncertain` and
  is never replayed. A quarantined slot keeps consuming capacity until an
  explicit cleanup proves the owned process drained.
- Wait and capacity states are visible as `waitingReason`
  (`dependency`, `model_capacity`, `runnable_capacity`, `runner_capacity`,
  `approval`, `storage`, `quarantine`, `message`) and `scheduleWait`. Inspect
  them before suspecting a stall.
- `subagent_resource_collect` collects explicitly named unreferenced results and,
  when asked, expired receipt archives; `subagent_metadata_rollover` expires one
  owner's request epoch. Both are coordinator maintenance, never execution, and
  neither touches active work, pins, board references or uncertain state.
- Release retention **after** consumers finish and effects settle:
  `subagent_view_release` for snapshots, overlays, submissions, pins and pending
  captures; `subagent_evidence_retention` `release` for exact evidence;
  integration `release` for attempt pins. A released worker binding cannot return
  to legacy file tools.
- Administer retained resources before deleting a team: deletion ends live
  membership authorization and does not clean artifacts, pins, runner results or
  integration content.

## Coordinator duties

- Respect each worker's configured `turnTimeoutSeconds`. A derived `subagent_wait`
  interval is `max(60s, turn timeout / 10)`; omit `timeoutMs` to use it, and use
  the largest interval across a mixed batch. Short polling and sparse output are
  not proof of a stall — keep polling, renew parent leases and keep the user
  informed. Intervene early only for explicit user direction, a concrete failure
  or changed requirements.
- Keep explicit model restrictions: a worker stays on its configured model, and
  abandoning or replacing a model for the remaining work needs the user's
  approval after the observed failures are explained.
- Three outcomes stay separate: worker completion, board acceptance and
  integration acceptance/`apply`.
- Final task-board reconciliation is the coordinator's own duty, not a worker's
  and not automatic. Before the final response, enumerate every page of the
  teams/tasks created for the assignment, reconcile each with its current
  `expectedRevision` and a fresh `requestId`, and verify the resulting states.
  Leave genuinely unfinished work accurately stated, and withdraw abandoned
  tasks by explicit cancellation rather than accepting them to clear the board.

## Limits worth knowing here

These are the implemented bounds; the linked documents list the rest.

- Aggregate budgets (`codexSubagent.resources.`): `modelCapacity` 8 (2–128),
  `runnableCapacity` 16 (2–256), `runnerCapacity` 4 (2–64), `storageBytes` 8 GiB
  (64 MiB–1 TiB), `serviceReserve` 1. They span roots and hosts for one OS user;
  per-store `numSessions` still limits each exact model.
- Per-root runner pool: `isolatedViews.runners.capacity` 2 (1–8) and
  `maxQueue` 32 (0–256), applied when the pool reopens.
- Board: 64 teams, 512 tasks, 32 members, 8 candidates, 8 agreed contracts, 16
  validations, 16 blockers and 100 retained history entries per record.
- Mailbox: 200 live events, 1024 request records and 64 team cursors inside
  1 MiB, 7-day retention and a 14-day request tombstone.
- Views: 64 snapshots, 256 overlays, 1024 submissions, 1024 pins, 4096 receipts,
  64 pending captures, 1024 overlay revisions; capture caps 10,000 files and
  512 MiB; text tools 2 MB per read and 500,000 characters per write.
- Runner results: 1024 records, 128 MiB total, 1 MiB per result, 100,000 output
  characters. A start capacity error refuses before execution; a final write
  failure is never reported as success.
- Worker stores: 200 retained workers per store.

## Evidence

Verification instructions live with the artifacts: run the focused suite at
`tests/parallel-workflow.test.cjs` and follow the benchmark procedure in
`benchmarks/README.md`. Those files define what to measure and how.

Measured results are recorded, dated, in
[the verification record](parallel-workflow-verification.md). That record states
which checks executed and passed, which artifacts and hashes back them, and where
its scope ends; this guide keeps its own status statement only. Two
limits it repeats deliberately: the workflow stays experimental and opt-in while
a concurrent-pool failure is open and platform checks are missing, and no pass,
benchmark or platform verification should be inferred from this document itself.

## Related documents

- [Task board](../README.md#task-board-opt-in)
- [Isolated team file views](isolated-views.md)
- [Isolated runner workspaces](runner-workspaces.md)
- [Resource governance and lifecycle](resource-governance.md)
- [Coordinator integration](integration.md)
- [Team mailbox](team-mailbox.md)
