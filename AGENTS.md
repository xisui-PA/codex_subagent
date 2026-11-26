# AGENTS.md

Use the parent Codex model as the lead for design, planning,
coordination, and review.

The coordinator may make simple, low-risk changes directly and run the
checks needed to verify them. Delegate more involved implementation,
documentation edits, document summarization, and test execution to workers
through the codex_subagent MCP tools. Do not substitute native Codex
subagents.

Check subagent_health and subagent_models before delegation. Review workers'
changes and test results before reporting completion.

Size tasks conservatively using model metadata and observed performance;
resolve uncertain prerequisites first. Write prompts in normal sentences,
with one deliverable, allowed files, relevant symbols/interfaces, acceptance
checks and a concrete stopping point. Include current findings and tool
constraints in a short brief. For reviews, specify one risk area or hypothesis
and require a minimal reproduction or explicit uncertainty before expanding.

Keep implementation, its tests and immediate corrections in the same session.
After a completed task, use a compact faithful handoff or a fresh worker on
the same permitted model for an independent module or role. Do not accumulate
unrelated assignments until the model's context limit forces compaction.
Handoffs should retain decisions, exact identities, changed files, check
results, unresolved risks and next steps; preserve the original histories.

Give workers starting symbols and existing fixtures. Search before reading
large files, read relevant ranges, and reuse unchanged context. Refresh the
current editing view and hash before edits as required below. Report findings,
changes, check results and limitations concisely; keep full logs in named
artifacts and include only the excerpts needed to assess a result.

Wait until a worker finishes its assigned work before reviewing or modifying
that worker's changes.

Respect each worker model's configured turnTimeoutSeconds when deciding
how long to wait. High timeout settings call for longer coordinator
patience; a short polling timeout or sparse output does not mean a
worker has stalled. Do not cancel, restart, narrow its task, or switch
models merely for slow progress while it is within that timeout.
Continue bounded polling, renew parent leases, and keep the user
informed. Intervene earlier only for explicit user direction, a concrete
failure, or changed task requirements.

Poll with subagent_wait, omitting timeoutMs to use the derived default of
max(60s, effective turn timeout in seconds / 10), using the largest interval
across a mixed batch. A shorter explicit timeoutMs (including 0) is honored;
a value above the derived limit is rejected. Inspect the returned worker
views rather than adding redundant status calls; repeat the wait for workers
that remain queued or running. Client request timeouts and parent leases must
cover the wait plus a margin.

Use the smallest number of workers needed, keeping delegated implementation
and its tests in the same worker session by default. Start dependent stages
after their prerequisites are ready, and parallelize only independent work
or work using stable, agreed interfaces. Avoid concurrent writes to shared
files or build outputs. When delegating reviews of small or cohesive
changes, default to one reviewer; add reviewers only for clearly independent
areas or a specific unresolved risk. Prefer targeted follow-ups over
overlapping full reviews, and check existing findings before delegating
further review work.

Assign one owner per shared build/test output directory and name the focused
checks for each task. Reuse verified validation helpers and invocations. Avoid
creating another launcher, watchdog or polling framework for each follow-up.
Run comprehensive validation once changes are ready for integration; repeat
checks when relevant changes, failures or unresolved risks justify them.

Use the actual tool schemas. For worker file tools, patch_file requires the
returned 64-character hash; expectedHash: "new" is only for write_file.
The worker run_command timeoutMs ceiling is 120000; it is separate from the
model turn timeout. On a tool failure, diagnose the specific error before
retrying. If the same failure recurs after a targeted correction, stop that
retry loop and report the evidence and blocker for a coordinator decision.
These checkpoints do not justify interrupting a slow worker within its turn
timeout or abandoning ownership of effects that have not drained.

If delegation is unavailable or repeatedly fails, explain the blocker
and ask before directly taking on nontrivial work.

Respect explicit worker-model restrictions. A worker-model failure should
first lead to diagnosing the cause, retrying, or reducing the task scope.
Before completely abandoning or replacing a worker model for the remaining
work, explain the observed failures and the proposed model change, then ask
the user for approval. The mere availability of another model, or a single
failed turn, is not approval to abandon the current model.

## Coordinator workflow

Use an ordinary MCP worker for a standalone assignment. For parallel work,
use the [task board](README.md#task-board-opt-in) when enabled. It records
plans, assignments and verdicts. The coordinator dispatches each task
explicitly and supplies its inputs. For parallel edits, prefer one shared
immutable snapshot with a private overlay per worker.

### Check capabilities and record the plan

Check the host's tool schemas and the applicable **User Settings**. The flags
below use the `codexSubagent.` prefix. Repository settings cannot enable them.

- `taskBoard.enabled` enables team and task records.
- `isolatedViews.enabled` adds snapshots, overlays and sealed submissions
  with the task board enabled.
- `resources.enabled` adds governed create-bind-start and aggregate
  budgets with the board and views enabled.
- `isolatedViews.runners.enabled` allows bound workers to run approved
  commands in a materialized view.
- `isolatedViews.integration.enabled` enables coordinator integration with
  the board, views and resource governance enabled. Publishing also needs
  runner evidence.

If a required capability is unavailable, identify the blocker before changing
the workflow. A bound worker must never fall back to live file tools.

Use a stable `ownerId` per conversation. Retain the canonical or returned
`workspaceRoot` on subsequent calls and group `subagent_wait` IDs by root.
Where required, use a fresh `requestId` for each new decision and current
revisions for updates. Retry an ambiguous call with the original request ID
and identical arguments.

Create a team and narrowly scoped tasks with explicit acceptance criteria.
Contract dependencies identify tasks that supply versioned agreed interfaces.
Artifact dependencies identify tasks that supply accepted outputs. Resolve
both to exact refs and retain the artifacts the task consumes. Schedule
pre-acceptance validation independently so it can establish the producer's
verdict. Record each verdict against the exact candidate version. Accept a
task only when the latest verdict for each current candidate is passing.

### Start workers in the right view

Capture the shared inputs with `subagent_snapshot_create`. Check the
[isolated view capture rules](docs/isolated-views.md) for working-tree changes,
editor buffers and untracked files. For governed startup, leave each task ready
and unassigned. Call `subagent_isolated_spawn` with the snapshot, exact current
team and task revisions, and an explicit `work`, `validation` or `integration`
lane. It creates the stopped worker, assigns it, binds the view and starts its
first turn. If initial revisions are stale, inspect and cancel the stopped
setup, then make a new decision with current revisions and a new request ID.
When only board and view support is available, explicitly assign the task and
use `subagent_view_bind` on an already stopped, owned team member before
resuming it.

Use the work lane for implementation and preserve service headroom for
validation and integration. Runner slots and queues are root-local, model
session ceilings are store-local, and governed budgets span roots for the OS
user. Inspect scoped `subagent_runner_status` or `subagent_resource_status`
when capacity blocks work. See [resource governance](docs/resource-governance.md)
for admission, leases and recovery.

### Seal, validate and publish

Seal the exact overlay revision. Retain exact submissions and runner results
before consuming them or publishing references to them. Use `subagent_view_pin`
for snapshots or submissions and `subagent_evidence_retention` for exact evidence
URIs as applicable. Legacy view retention does not treat a board reference as a
root, while governed reference-aware cleanup does protect current board
references, active receipt references and evidence pins, and keeps a managed
command result's sealed input. Either way an explicit pin before consumption is
the consumer's own step, and mail identity alone retains nothing. Review the sealed
changes with `subagent_submission_read` and use the stored IDs, versions and URIs.

[Isolated runner commands](docs/runner-workspaces.md) require
`workspace-write`, an eligible model with write and shell access, and
authorization under the isolated grant that currently applies to the command's
logical project when it is requested. Grants are keyed by grant kind and logical
project root, not by worker, so an existing isolated project-session grant can
cover later isolated commands from several workers, while that grant kind stays
separate from a legacy workspace grant. Parent Codex approvals and sandbox are
not inherited. Use relative project paths. Absolute paths still
have the OS account's access. For integration validation, match every stored
result to its exact command and candidate input revision, and require success,
confirmed drain and no imports. A command that imports changes leaves a new
revision that needs its own validation.

Use `subagent_integration` for explicit coordinator decisions. For a
publishing attempt, `begin` pins the exact selected task candidates and
evidence over a common base and freezes the ordered validation commands.
Start a `validation`-lane worker on a clean derived seed and keep its overlay
at revision 0, or use an `integration`-lane worker to resolve conflicts or to
repair a conflict-free seed whose combined checks fail. Then rerun the exact
agreed commands against the candidate's input revision.
The worker seals the result. `candidate` records that seal and `validate`
records matching runner evidence. After review, `accept` acknowledges the
exact conflict paths and `apply` separately publishes against live workspace
and editor preconditions, where any open editor on a touched path is itself a
conflict. Board acceptance is a separate decision.

For a downstream artifact task, compose and retain the consumer's exact
derived seed before starting the worker on it: `begin` with `consumer`, read the
returned `derivedSnapshotId`, and bind or start the dependent worker on that
value before its first implementation turn. Readiness alone delivers no files.
See
[coordinator integration](docs/integration.md) for the downstream conflict
recipe and publication recovery. Inspect `status` after an ambiguous call
before retrying its original request. An `interrupted` publication requires a
new attempt. Release retention after consumers finish and effects settle.

### Close out task-board work

Final task-board reconciliation is the coordinator's own duty, not automatic
extension behavior and not part of a worker's completion. Workers may report
their progress, blockers, candidate refs and `submitted`/`failed` state, but
cannot accept. Worker completion, board acceptance and integration
acceptance/`apply` are three separate outcomes.

Before the final completion response, enumerate and re-read all pages of the
`teams`/`tasks` created or managed for this assignment in the canonical
`workspaceRoot` and stable `ownerId` scope, reconcile current state using
`expectedRevision` and a fresh idempotent `requestId` per decision, and verify
the resulting states. The only successful path is ready -> in_progress ->
submitted -> validating -> accepted; there is no `completed` state. Acceptance
requires the candidate, review, readiness/no-blockers and
latest-passing-verdict conditions stated above, with validations recorded after
the task is `validating` and before the explicit `accept`. A reporting, review or
documentation task still needs a concrete versioned report/output reference where
the board requires candidates: an absent ref is no cover for leaving finished
work `in_progress`, and evidence or passing verdicts must never be manufactured.

Withdraw tasks by explicit cancellation. Leave genuinely unfinished, failed or
blocked tasks with accurate state, blockers and next action, and name them in
the final response instead of claiming full completion or accepting them just
to clear the board.

## Parallel workflow

See [parallel workflow](docs/parallel-workflow.md) for the operating protocol and
the per-surface limits. These rules bind both roles, and the workflow stays
experimental while its end-to-end checks are incomplete: never report it as
verified.

- Classify the work first. Clear-boundary work gets an agreed interface and
  acceptance criteria on the board before implementation, then complementary
  private outcomes over stable contracts; dependent implementation waits for the
  exact contract ref. Coupled work gets one primary owner, with other workers
  limited to investigation, test design, review and, when useful, private
  alternative implementations. Select between competing approaches explicitly,
  and never require overlapping alternatives to be merged or let a worker merge
  them on its own.
- Finish the lifecycle before a worker's first implementation turn: team,
  `ready` unassigned task, snapshot, then binding through
  `subagent_isolated_spawn` or, with only board and view support, an explicit
  assignment plus `subagent_view_bind` on a stopped member. There is no general
  deferred-spawn API; the legacy spawn-cancel-bind bootstrap keeps its earlier
  legacy turns.
- Workers seal an early checkpoint with `expectedRevision`, report the exact
  `{id, version, uri}`, and stop for review. Never read or patch a worker's
  mutable overlay while it is still running; review the sealed submission.
- Agreements are board records: agreed contracts or verdicts through
  `subagent_task_update` with the current `expectedRevision`, recorded by the
  coordinator after a worker proposal. Mail kinds are
  limited to `question`, `reply`, `interface_proposal`, `interface_response`,
  `discovery`, `blocker`, `artifact_ready`, `integration_feedback` and
  `escalation`; an `interface_response` is informational, a send never
  dispatches or wakes a worker, and only the governed scheduler may clear the
  wait generation it observes on a correlated reply. Pin exact artifacts and
  evidence before consuming or publishing a reference, and release retention
  after consumers finish.
- Open blockers gate board transitions and acceptance: they refuse
  `ready → in_progress`, `in_progress → submitted` and acceptance until a board
  update clears them, and progress text or mail never does. Automatic execution
  gating from blockers covers only governed create-bind-start workers, so
  withhold send, resume and dispatch on a non-governed bound worker yourself
  rather than relying on the board. Runner
  evidence belongs to the input revision it ran on; an import advances the
  overlay by one revision that nothing has validated yet. Combined validation
  matches one exact stored result per agreed command, and board acceptance,
  integration acceptance and `apply` are separate decisions. The
  `integration`-lane worker is optional and is needed for composed conflicts
  *and* for a conflict-free seed whose combined behavior fails; `apply` reports
  any open editor on a touched path, not only dirty buffers, as a conflict.
- Structural task edits are state-limited: assignments and dependencies change
  only while the task is `ready` or `failed`, and every other state refuses them.
  A worker finishing and reporting is not a board terminal state, so `submitted`,
  `validating` and `accepted` stay the board's own facts. Give independent review,
  a new role or another module its own fresh `ready` task and worker, keep
  accepted tasks immutable, and for genuine rework preserve the earlier artifact
  and history, record the real failed verdict and `failed` state, then move
  `failed` -> `ready` with the reassignment and on to `in_progress`. Never mark
  successful work `failed` merely to hand it off. A terminal task (`accepted`,
  `cancelled`, `failed`) also stops its governed worker: later execution is
  refused with `task_stopped`, so finish seals, checks and validations before
  accepting and start any later role on a fresh task and worker.
- Waits are explicit and generation-checked: `subagent_schedule` takes
  `expectedWaitRevision` from the worker's `scheduleWaitRevision`, sets a
  `{kind: 'message', key}` wait, and `wait: null` clears that same generation. A
  `revision_conflict` changes nothing, so re-read the worker before retrying. A
  message is not a wakeup and a stopped worker resumes only explicitly. Clearing
  a wait automatically is scheduler-only and covers just the generation it
  observes on a correlated authorized reply; a coordinator may also clear it
  explicitly with `wait: null` at the generation it read. A
  governed bound worker's `subagent_mailbox_wait` covers its own question or
  interface proposal as the only tool call of that round.
- Runner liveness is read from lease `state` plus the current summary and stored
  `result.drained`, never from `phase` alone: the phase is a high-water mark that
  only advances, so a released lease may still say `executing`.
- Candidate refs are append-only board identities: a recorded `{id, version,
  uri}` cannot be removed, an empty list adds nothing, a later version may extend
  the same id, and acceptance needs the latest version of every distinct
  recorded id to pass. So never promise candidate replacement or accept a failed
  identity to clear the board; keep early checkpoints as sealed refs and progress
  until you deliberately record one candidate. If failed ids cannot be
  superseded, leave the task accurately `failed` or `cancelled` with retained
  histories and open a fresh task for the final review. A board id is not proof
  of a managed submission id: integration resolution decides that when the
  attempt matches the exact ref.
- Leave opt-in flags at their implemented defaults unless the plan needs them,
  and treat cancellation, reload, `uncertain` attempts, quarantined slots and
  archive/collection cleanup as explicit recovery decisions rather than automatic
  behaviour.
- The parallel benchmark and its focused suite live at `benchmarks/README.md`
  and `tests/parallel-workflow.test.cjs`; they define what to measure and how.
  Measured results belong in a separately dated artifact with its own inputs; the
  dated record for this workflow is `docs/parallel-workflow-verification.md`,
  which names its passed checks, artifact hashes and still-pending results. A
  planned check or its absence is never evidence, and the workflow stays
  experimental and opt-in while its open failure and missing platform checks
  stand.

## Line endings and exact-text edits

Before exact-text patches, check the target's working-tree line endings.
Use `git ls-files --eol -- <path>` and, when relevant,
`git config --show-origin --get core.autocrlf`. This checkout can have LF
in the index and CRLF in the working tree because `core.autocrlf=true`.
Git blob text and rendered tool output do not prove the current file's EOL.

Read the current file through the same worker view used for editing, and
use its returned full-file hash. Preserve the existing encoding, BOM and
line-ending style. For a uniform LF or CRLF file, construct replacement
text in that style; do not convert the whole file just to make a patch match.
Mixed endings require an exact match or an explicit, scoped normalization.

If a patch reports no match, inspect the actual bytes/EOL and refresh the
read/hash before retrying. Do not repeat the same failed patch, weaken hash
preconditions, or substitute live workspace content for an isolated view.
The isolated patch adapter accepts LF/CRLF differences only after the raw
hash matches; legacy tools may require exact line endings. VS Code editor
edits can preserve the document's existing EOL even when input text uses LF.

Give workers these EOL details in patch tasks. Do not change Git EOL
settings or repository-wide formatting to work around a local mismatch.
Review the diff for unintended newline churn and run `git diff --check`.
