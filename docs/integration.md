# Coordinator integration (step 5, opt-in)

`subagent_integration` is one coordinator-only tool with one explicit action
per call: `begin`, `status`, `details`, `candidate`, `validate`, `accept`,
`apply` or `release`. `status` and `details` read only. An attempt pins exact
sealed submissions, composes a private seed
over their common base snapshot, records immutable validation results, and
publishes only after separate accept and apply decisions. Every stage is a
coordinator decision, and the tool never writes a task-board record.

## Enabling

All four settings are User/machine scope and read from the global value, so a
repository cannot enable them:

| Setting (prefix `codexSubagent.`) | Default | Meaning |
| --- | --- | --- |
| `taskBoard.enabled` | `false` | Board records and worker board identity |
| `isolatedViews.enabled` | `false` | Shared snapshots, private overlays and sealed submissions |
| `resources.enabled` | `false` | Governed create-bind-start, service lanes and aggregate budgets |
| `isolatedViews.integration.enabled` | `false` | Coordinator integration attempts |

All four flags gate the tool. While any of them is off, the host refuses every
action with `feature_disabled` and changes nothing. Discovery still lists it,
like the board and view tools. Validation needs physical runner results, so
isolated runner execution is separately opted in with
`isolatedViews.runners.enabled`, `workspace-write` permission, an enabled
model that allows writes and shell, and approval for each exact command. See
[isolated runner workspaces](runner-workspaces.md).

## Attempt lifecycle

```text
publishing:     begin → ready → candidate → validated → accepted → applying → applied
                                                              └──────────→ interrupted
publishing end: ready/candidate/validated/accepted → release → abandoned
                applied → release → released
consumer seed:  begin → ready → release → abandoned
```

- `begin` records the immutable selection and composes the seed.
- `status` reads one attempt by `attemptId` or by its original
  `beginRequestId` and never mutates it.
- `details` pages the COMPLETE status-form view text of one attempt for an
  exact revision, and never mutates it. See
  [bounded replies and details paging](#bounded-replies-and-details-paging).
- `candidate`, `validate`, `accept`, `apply` and `release` require
  `attemptId`, `expectedRevision` and `requestId`. A stale revision fails with
  `revision_conflict` before any change.
- An exact replay returns the current durable view with `replayed: true`, not a
  copy of the earlier response. The same `requestId` with different arguments
  fails with `request_conflict`.

An older completed attempt that lacks the lineage marker re-proves it from
its exact retained sources and conflicted hops before any new decision, and
advances when that proof succeeds. Only a failed proof refuses a candidate,
validation, acceptance or fresh apply: `ancestry_unresolved` when an exact
conflict resolution is missing, `ancestry_unproved` when the exact retained
inputs are, and `ancestry_mismatch` when they name different identities.
A successful decision records the proof durably. If the proof fails, the
stored decision stays available for an explicit coordinator `release`.

Every ordinary response carries `action`, `replayed`, `attemptId`,
`beginRequestId`, `ownerId`, `teamId`, `status`, `revision`,
`requirements`, `contracts`, `dependencies`, `validationCommands`,
`conflicts`, `conflictPaths`, `conflictPathsDigest`, `derivedSnapshotId`,
`baseSnapshotId`, `inherited`, `sourceSnapshotId`, `candidate`,
`validations`, `acceptance`, `apply`, `failure` and `canPublish`.

## Bounded replies and `details` paging

The transport refuses any response above 10,000,000 characters, and a legal
attempt can exceed that: one merge that reports 3002 conflict paths of 1810
characters stores a 5.4 MB durable record whose complete view serializes to
about 10.9 M characters. Every action therefore acknowledges through ONE
response path, measured on the FULLY serialized tool result - the view JSON
text escaped inside its content envelope - never on raw metadata:

- **Ordinary reply.** While that fully serialized result fits the tool's
  reply budget of 4,194,304 characters, the response is exactly the complete
  view above. The 602-path conflict regression stays whole, because its
  accepted view is about 3.28 M characters.
- **Bounded summary.** Above the budget the response is a deterministic
  summary instead: `action`, `replayed`, `attemptId`, `beginRequestId`,
  `ownerId`, `teamId`, `status`, `revision`, `dependencyOnly`, `seedOnly`, an
  explicit `truncated: true`, the exact `conflictPathsDigest`, `summary`,
  `controls` and nothing else.

  `summary` carries `kind` (`bounded-integration-summary`), a `reason`,
  `actionReplyChars` and `actionViewChars` (the size of THIS action's own
  complete reply as the relay would count it), `fullViewChars` and
  `fullViewBytes` (the size of the canonical STATUS-form document below),
  `guard` (the content identity of that same document), the names of every
  `omitted` field, the exact `counts` (sources, consumer requirement,
  inherited witnesses, dependencies, contracts, validation commands, conflict
  groups, conflict-group paths, distinct conflict paths, validations,
  acceptance resolved paths, apply applied/conflict totals and truncation,
  request receipts), `details` and `detailsFormat`.

  `details` is a DIRECTLY EXECUTABLE `details` call: it contains only the
  schema-valid arguments `action` (`details`), `ownerId`, `teamId`,
  `attemptId`, `expectedRevision` at the current revision, the document's
  `expectedContentDigest`, `offset: 0` and the default `limit` (16384). It can
  be sent as-is, and the service rejects nothing in it.

  Broker replies include the canonical `workspaceRoot` of the attempt.
  Retain it on every continuation page so the request reaches the attempt's
  store when the client's working directory is another open folder.

  `detailsFormat` is separate paging FORMAT metadata, never part of those
  arguments: the `payload` name (`status`), the `encoding`, `maxLimit`
  (65536), the exact `total` of that document, the same `contentDigest`, and
  the `semantics` (follow `nextOffset`, replacing only `offset`/`limit`, and
  send `contentDigest` as `expectedContentDigest` on every continuation).

  The reply also carries that digest as a top-level `contentDigest`. Every
  paging field - `guard`, `fullViewChars`, `fullViewBytes`, `contentDigest`,
  `details.expectedContentDigest` and `detailsFormat.total` - refers to the
  canonical document `details` actually reads (the complete STATUS-form view
  with `action: "status"` and `replayed: false`), never to the action-specific
  reply that triggered the summary. A `begin`, replayed `begin`, `apply`,
  `release` or replayed `release` summary therefore advertises exactly the
  guard `details` accepts.

  `controls` carries the identities and preconditions the next decision
  needs: `expectedRevision`, `status`, `canPublish`, the seed/dependency-only
  flags, `pinState`, `evidencePinned`, the derived/base/source snapshot ids,
  `ancestryVerified`, the candidate artifact with its lane, snapshot and
  revision, the acceptance `requestId`, the apply state and `requestId`, the
  publication journal latch and revision floor, the failure `code` and the
  timestamps.

  A summary previews no path, approval, evidence or publication list at any
  length, so an incomplete approval or conflict set can never look complete.
  Its size depends only on bounded scalar fields, so even the widest legal
  record answers with a small reply. Nothing durable is truncated: the record
  keeps every requirement, contract, conflict, evidence, acceptance and
  publication byte, and releasing an oversized attempt still drops its pins.
  Both `status` keys, the exact `begin` replay, `candidate`, `validate`,
  `accept`, `apply`, `release` and their exact replays all use this same
  path, so no lifecycle effect is ever acknowledged only by an undeliverable
  reply.

### `details`: the complete view, page by page

`details` is a read-only action that pages ONE attempt's COMPLETE
status-form view text. It takes `ownerId`, `teamId`, `attemptId`,
`expectedRevision`, an optional `expectedContentDigest`, an optional `offset`
(default `0`) and an optional `limit` (default `16384`, maximum `65536`). It
authorizes the same owner and team as `status`, mutates nothing - no receipt,
no revision, no durable field - and, like `status` and `release`, never waits
for a storage admission permit. It only reads existing integration storage for
the selected owner, team and root. A missing ledger yields `attempt_missing`
without an initialization write.

- **Payload.** The payload is the full STATUS-form view, the same object
  `status` returns, with no summary and no truncation applied. `text` is that
  view's exact JSON text sliced from `offset`, and `payload` names it
  `status`.
- **Index unit.** `offset`, `nextOffset` and `total` count UTF-16 code units,
  exactly like JavaScript string indices; `encoding` is `utf16-code-unit`.
- **Reassembly.** Concatenate every page from `offset: 0`, always continuing
  at the returned `nextOffset`, until `nextOffset` is `null`. The result is
  the complete view text, `JSON.parse` of it is the complete view, and
  `total` is its exact length. Quoted, escaped-control and non-ASCII strings
  and one huge conflict group survive unchanged.
- **Code point boundaries.** A page never splits a surrogate pair. A boundary
  that would fall inside a pair extends the page by one code unit, so a page
  carries at most `limit + 1` code units and every page advances. An `offset`
  that would split a pair, an `offset` past `total` and a `limit` outside
  `1..65536` are refused with `invalid_arguments`.
- **Revision fence.** `expectedRevision` is required and checked before any
  page is returned. A stale revision fails with `revision_conflict`, so pages
  of two durable revisions are never mixed: re-read `status` and restart at
  `offset: 0`. Another owner or team gets `attempt_missing`.
- **Content fence.** A revision does NOT fence the serialized content. The
  publication journal latch and revision-floor checkpoints, and a failed
  publication retry, are persisted at the SAME attempt revision while they
  change `failure`, `updatedAt`, `publicationJournalEstablished` or
  `publicationJournalRevision`. Two reads of one revision can therefore
  serialize different documents, and a page prefix can be byte-identical while
  the rest moved. Every page and every bounded summary therefore reports
  `contentDigest` plus a `guard` descriptor
  `{kind: 'integration-view-content-digest', algorithm: 'sha256',
  covers: 'complete-status-view-json-text', attemptId, revision, chars, value}`,
  the digest of the exact view text. `expectedContentDigest` is REQUIRED on
  every continuation page (`offset > 0`); a missing one fails with
  `invalid_arguments`, and one naming another document - at any offset - fails
  with `content_changed` before a page is returned. A content change means the
  assembled document no longer exists: discard the pages, re-read `status` (or
  `details` at `offset: 0`) and restart from `offset: 0` with the new guard.
  The fence is a comparison against the freshly serialized text; it adds no
  durable field, no receipt and no cache.

Because the budget keeps every ordinary reply unchanged and `details` reads
the durable record, a coordinator that stored an oversized attempt before
this path existed can still inspect, decide and release it. Paging is only
lossless while both fences hold: the revision AND the content digest. A
client that sees either fail must restart the assembly at `offset: 0`.

## Begin: exact sources, consumer and contracts

`begin` takes `ownerId`, `teamId`, `requestId`, 1–16 `sources`, optional
`consumer`, optional `contracts` and optional `validationCommands`. A consumer
decides the kind of attempt:

- **Publishing batch.** Without a consumer, `validationCommands` requires 1–8
  distinct commands, and sources may be `submitted`, `validating` or
  `accepted`.
- **Consumer seed.** Any explicit `consumer` makes the attempt seed-only.
  Every source task must already be `accepted`, `validationCommands` may be
  omitted or empty, and the composed private seed is for downstream use only:
  it can be released, never validated or published.

Each source names one exact candidate:

```json
{
  "taskId": "<32-hex task id>",
  "taskRevision": 7,
  "artifact": { "id": "<64-hex submission id>", "version": 2, "uri": "<uri from the seal>" },
  "evidence": [{ "id": "<32-hex result id>", "version": 1, "uri": "<uri from subagent_runner_result>" }]
}
```

Sealed submission URIs use
`codex-subagent://submission/<namespace>/<id>/<version>` and runner results use
`urn:codex-runner-result:<namespace>:<id>`. Copy the exact values returned by
the seal and by `subagent_runner_result` instead of constructing them.

- Sources must share one immediate base snapshot, which becomes
  `baseSnapshotId`. That base may itself be a derived seed, but every source
  must be sealed over that same snapshot, and sources sealed over different
  snapshots are refused even when their stored lineages share an ancestor. A
  worker seals over the derived seed, never over another producer's overlay.
- Each `taskRevision` must be current and each artifact must be a current
  candidate of that task at that revision with the exact id, version and URI.
  Each source carries at least one exact scoped runner result recorded as
  succeeded, drained and import-unchanged.
- The recorded producer is the task's current assignee, resolved to its exact
  worker creation identity, owner, team and permanently bound view.
- A `consumer` adds `{taskId, taskRevision}` and records that task's
  requirements against the same attempt.
- `contracts` must name every contract dependency of the selected tasks and
  consumer with an exact agreed ref from the producing task at its current
  revision. Artifact dependencies must be selected as sources, except an
  omitted dependency already proved incorporated through the verified ancestry
  of the immediate base described below.
- `validationCommands` are the exact ordered commands agreed for this attempt.
  They are immutable, distinct and later matched one-to-one with runner
  results.
- The requirements snapshot records titles, task states, acceptance criteria,
  artifacts, evidence and producer identities once. Later board edits do not
  rewrite an attempt, and a worker never redefines the criteria.

Selection is explicit. The coordinator reads producer files through
`subagent_submission_read`, includes relevant conflict details when directing
resolution work, and chooses every source, contract and evidence ref itself.
Eligible unrelated tasks are neither consumed nor waited on, and ordinary
dependency gates on other tasks do not block an integration attempt.

An omitted artifact dependency is accepted only through proof. The selected
sources' one immediate base must carry stored, physically verified ancestry
that names an older durable attempt of this same owner and team,
whose recorded seed, base and exact ordered refs match it, whose recorded seal
identities and evidence prove it consumed the exact candidate even though its
pins may already have been released, and whose task is still accepted with
that exact candidate. That acceptance stays durable after the pin release,
The ordinary physical-retention and board checks still apply to it, and the
attempt then records the inheritance witness and pins only its selected
sources and their exact evidence. It never substitutes
a newer candidate of the omitted producer and never reads old content from the
live workspace, and an unproved edge still fails with `dependency_unselected`.

A hop that carries unresolved conflict groups is proved only by its own
resolution: a later composition may build over it only when it carries the
exact `integration`-lane seal that the hop's own durable attempt validated and
explicitly accepted, as its sole source at that hop, and that older record
names all its original input identities and the explicit resolved paths its
acceptance covered. An unproved conflicted hop fails with `ancestry_unresolved`.

Composition retains the exact producer submissions, pins their evidence,
merges the changed trees over the shared base and stores the result in CAS as
a private seed. Its `snapshotId` is a new derived snapshot distinct from
`baseSnapshotId`. The 600 MiB `begin` admission reserves at most 512 MiB for
distinct composed payload writes in total, including both synthesized blobs and
final native Git bytes, and checks that bound before a write would cross it.
Only native hashes referenced by the derived seed are copied. Merge conflicts
are recorded per path group with the implicated input ids and a reason. At a
conflicting path the seed keeps the base entry, so applying the seed's
unambiguous changes is always safe.

Binary content, overlapping text edits, delete/modify, add/add, file/directory
and case collisions are conservative conflicts. Renames are matched by exact
content. An exact-content rename includes an existing regular destination whose
content changed to the deleted file's bytes, so an overwrite-rename counts once
that destination's own content changed. A rename whose destination conflicts
keeps the source file and reports both paths. A refused half carries no part of
the move into the seed, and independent unrelated edits still survive.

`begin` persists its intent before any effect. A failed begin stays visible by
its `beginRequestId` with a `failure` and can be retried exactly or released.
A recovered composition must reproduce the same seed, base and conflict
groups.

## Candidate: one sealed service-lane submission

`candidate` takes the exact `artifact` `{id, version, uri}` of one sealed
submission from a current team member whose governed session uses a service
lane, is bound to the team and to this attempt's exact `derivedSnapshotId`, and
matches its recorded owner, team and creation identity. A seed-only attempt
rejects a candidate with `dependency_only`.

- A clean seed is validated by a `validation`-lane worker that leaves the
  derived snapshot unchanged at overlay revision 0. A validation-lane
  candidate cannot carry conflicts.
- A seed with conflicts needs an `integration`-lane candidate at a higher
  overlay revision that proposes the fixes.

Binding is decided by the snapshot's own conflict groups. A derived seed whose
conflict groups are unresolved may only be bound by the governed `integration`
startup of exactly that team and snapshot, so an ordinary work bind, a
validation bind and a legacy bind without that host startup identity all refuse
it and change nothing. That lane is the only session that may inspect and edit
the private seed. A conflict-free derived seed and a legacy record without
conflict groups keep ordinary binding.

That check runs for the governed startup before any fresh durable startup
intent or task assignment exists, so a refused conflict-lane bind changes
nothing and does not block the owner's metadata maintenance. An exact
matching retry that the same rule refuses again retires a kept intent that
an earlier build stranded this way, through the ordinary request-identity
fence. A parent stop can also retire a kept intent. Leased requests expire
at their recorded deadline.

Start that worker with the existing governed create-bind-start call,
`subagent_isolated_spawn`, passing `setup.snapshotId` equal to
`derivedSnapshotId`, the exact team and task revisions, the chosen `lane`, and
the agreed requirements, evidence and paths in its instructions. Ordinary
send/resume cannot bypass incomplete setup. See
[resource governance](resource-governance.md).

Proposing a new candidate clears earlier validations and acceptance for the
attempt. Acceptance criteria are never rewritten. A worker seals its exact
resulting revision, and its own identity never approves the work.

## Validate: exact ordered commands and results

`validate` takes one evidence ref per immutable command, in the same order.
Each evidence ref is a scoped runner result. The host checks that the result is
the exact stored version, that it succeeded, drained without a surviving
process and imported nothing, that its input snapshot, overlay and revision are
the candidate's exact input, and that it ran the exact agreed command from the
root.

Repeat counts, reordered commands, a result from another revision or worker,
or a stale input fails the call. `validate` records metadata and pins the
evidence. It runs no command, records no board verdict and accepts nothing. An
imported change is a new revision, and no earlier command result validates it.
When an agreed command runs test files taken from the candidate, review changes
to those files against the frozen acceptance criteria before accepting.

A retained exact runner result stays eligible after the released lease history
that produced it is collected. Eligibility is proved from the result's own
recorded execution directory, its lease id and the configured pool root, so it
never needs a surviving lease record or released tombstone. The original input
snapshot, overlay and revision, the drain and import checks, and the exact
command and canonical source directory still apply, and a temp or output
directory of that lease is still refused.

## Accept: explicit verdict on exact conflict paths

`accept` requires a validated attempt and acknowledges that attempt's exact
conflict path union in ONE of two forms:

- **Full list.** `resolvedPaths` must contain exactly the attempt's conflict
  path union, with no duplicates. Order is immaterial. A missing or extra path
  fails with `conflict_paths_mismatch`, and an attempt without conflicts
  requires an empty array.
- **Compact digest.** `resolvedPathsDigest` acknowledges the exact
  `conflictPathsDigest` the attempt view reports instead of resending the
  paths. It is the existing digest helper over one canonical array: the fixed
  domain separator `codex-subagent/integration-conflict-paths/v1`, the exact
  attempt id and the sorted unique conflict path array. It is therefore
  deterministic for one attempt and its exact conflict set, and it keeps a
  large (but legal) conflict union inside the bridge's request size instead of
  making the decision impossible to send.

The two forms decide the same thing and are never combined. A wrong digest or
a wrong list fails with `conflict_paths_mismatch`, and a nonempty
`resolvedPaths` sent together with `resolvedPathsDigest` fails with
`invalid_arguments`. Every refusal happens before any durable change, so re-read
`status` and send the `conflictPathsDigest` it reports. A successful digest
approval stores the exact verified digest with the immutable conflict groups
it verified. Views and ancestry proofs derive the exact `resolvedPaths` from
those groups. The ledger also reads legacy approvals that store the full list.

The request keeps its identity fence: an exact replay returns the recorded
view with `replayed: true`, the same `requestId` with different arguments -
including switching between the list and the digest - fails with
`request_conflict`, and a stale `expectedRevision` fails with
`revision_conflict`. Acceptance is a durable metadata decision. It does not
write the board, change worker or task state, or touch workspace files, and
board acceptance remains a separate record.

## Apply: separate publication decision

`apply` publishes the accepted candidate through a durable per-file journal.
Its changes are diffed against the original captured ancestor of the base
lineage, the ordinary capture the workspace really held, never against an
intermediate derived seed. Before any effect the attempt records `applying`.
Each file then moves through `pending`, `intent`, `applied` or `interrupted`.

Each file is published with raw bytes, so BOMs, encodings and line endings are
preserved. A full capture records captured editor override paths in the
snapshot manifest's `editorPaths` metadata rather than as separate entries. A
change at one of those paths is a conflict, because the base bytes came from an
unsaved buffer instead of raw disk, and a captured base without that list has
unknown provenance, so any change is refused.

Preflight verifies the live base content hash, size and POSIX mode, pins each
parent directory identity, rejects symlinked or hard-linked destinations,
refuses protected paths, and refuses to create directories or replace a path
with a different entry type. Windows mode changes are unsupported and refused.
The final destination observation compares size, precise mtime/ctime, link count
and permissions against the entry whose content was read, so an in-place write
or a hard link created during the last observation is refused instead of
published over. On POSIX a content-only replacement preserves every current
permission bit whenever the approved mode class is unchanged, so 0o744 stays
0o744 and 0o600 is never widened to 0o644; an intentional supported mode change
applies only the approved executable bit and keeps the destination's read/write
bits.
An editor buffer open on a touched path in the owning window is a conservative
conflict, and so is a stale file or hash. The same holds for an editor path
that reaches the destination through a filesystem alias, because aliases are
matched by canonical location rather than spelling, and for a case-only alias
pair in the final namespace. Every touched path must still match its original
captured precondition. These checks are re-evaluated immediately before each
effect, so an open-editor inventory that changed during the check is a
retryable per-file conflict, and on POSIX a live permission change observed
after staging is refused before the rename and is likewise retryable.

`apply` returns `applied` paths, `conflict` paths with reasons, or
`interrupted`. A precondition conflict leaves the attempt `accepted` with those
paths and reasons. It does not reopen candidate selection: retry `apply` with a
new `requestId`, and the journal skips paths already applied, or release and
begin a new attempt.

An ordinary outcome lists its applied paths and its conflict paths with reasons
whole. A large outcome is reported as a bounded preview instead: at most 256
applied paths and 64 conflicts inside 32 KiB of serialized text, with each
conflict reason capped at 500 characters. Such a preview also carries
`truncated: true` beside the exact `appliedCount` and `conflictCount` it was cut
from. `appliedCount` counts applied paths only, while `conflictCount` counts
every conflict the plan identified before truncation, so a report cut from a
refused plan still counts the conflicts it refused before any effect. The
per-file journal remains the authoritative recovery evidence when it exists,
rather than the preview. A preflight refusal may record no journal at all, so
it has no per-file recovery evidence to reconcile against.

Publication capacity is refused as a conflict before any approved byte of a
pending file is read or any destination file is modified: more than 1024
changed files, more than 256 MiB of approved bytes declared by the plan, or a
journal that could reach its 4 MiB bound even in its own worst-case encoding.
A fresh publication is therefore refused before its first journal revision is
committed. Recovery is the one exception: it first checkpoints the proved
`applied` or `interrupted` outcome of each existing per-file intent, and only
then rechecks capacity for the remaining pending files under the same bound,
before their bytes are read or any effect starts. Every journal write
re-applies that 4 MiB bound. A resumed
publication still reports the paths it already applied, so a capacity retry is
safe.

Storage admission can also deny an attempt that is already `applying`, because
its own journal consumed the headroom. An exact replay of the current apply
receipt may then reconcile existing journal intents in proof-only mode. It
starts no pending file effect and no new journal.

The exact in-flight apply of an attempt whose stored lineage cannot be
re-proved is reconciled the same way: proof-only mode answers only for
journal state that already exists, may remove only its own verified staging
entry, and cannot start a pending write. When recoverable proof leaves
remaining pending files, the outcome is a conflict and the decision stays
accepted and releasable. An interrupted uncertainty remains terminal, and a
new or stale apply request still receives the normal storage refusal. A
normal apply is allowed only once its own preconditions permit it, and then
needs a new `requestId`.

Each per-file `intent` is recorded in the journal, and the attempt then records
that journal revision durably before the workspace write for that file starts.
A later apply compares the loaded journal against the recorded revision. A
restored journal older than that recorded revision may still record a file as
pending whose intent means an effect may have started, including when a later
editor or path check refused it, so it yields `interrupted` with no workspace
write and no journal rewrite. That guarantee depends on the durable attempt
ledger retaining the checkpoint, and proof-only recovery does not relax it.

A published file is staged under a short sibling name of fixed length in the
destination's own directory, so the name never depends on the destination's
length and the final rename or link stays in that directory. The name is
journaled with that entry's durable `intent`, and the staged entry's own file
identity is journaled before its first approved byte is written, so only that
exact entry can ever be published or removed.

Recovery reconciles the recorded stage of a `pending` or `applied` row before
starting new staging. If the stage cannot be safely removed, the result names
the recorded path as a conflict and the journal retains its identity. A retry
with a new `requestId` can proceed once it proves the path absent or can
safely remove the stage, for example after the editor closes. Already applied
paths remain recorded as applied during cleanup and retry.

Once the attempt records an established journal, its absence makes publication
`interrupted`, with no fresh workspace effect and no recreated history. An
`interrupted` result means an effect may have started. That proof is terminal
and is never repeated, an exact replay returns it unchanged, and only an
explicit release may follow. A thrown error during publication leaves the
attempt `applying`. Only the request id recorded on that current applying
decision can re-enter the journal, where it proves each file's state; a replay
of an older apply receipt observes the stored state instead.

A first publication decision with no journal yet durably records that no
journal was established, so a later absence is proved safe and a new journal
may be planned. An attempt recorded before that latch existed is otherwise
uncertain and requires the journal. It may retry without one after the editor
closes only when its first recorded apply outcome is complete rather than a
bounded preview, contains nothing but open-editor conflicts, applied zero
files, and leaves no evidence of an ambiguous attempt, such as an in-flight
decision, a partial applied count or an interrupted result. Every other
uncertain pre-latch history still requires the journal.

Exact recovery removes a staging entry only for its own resolved intent, and
only while the pinned parents, that exact recorded identity, the approved
bytes, the link state and the editor inventory still verify. That includes
the second staging link of a verified creation interrupted between link and
unlink, whose destination is that same identity holding the approved bytes.
Missing or older stage ownership, edited or ambiguous bytes and unsupported
parents are left untouched, and a staging name is never found by scanning.

The journal is per file, so publication is not multi-file atomic and provides
no OS compare-and-swap guarantee against concurrent writers. An applied path is
never rewritten, so a later user edit survives an exact replay. Unknown or
untrusted journal and directory state fails closed. Integration performs no Git
commit and no network publish.

## Release: abandon and free retention

`release` takes `attemptId`, `expectedRevision`, `requestId` and the literal
flags `abandon: true` and `releaseRetention: true`. It records `releasing`
before dropping the attempt's pins and private retention, then reports
`released` for a published attempt or `abandoned` otherwise. The durable
decision record stays. Release is refused while a publication is `applying`,
because that decision stays unresolved. An exact replay of a release returns
its stored view.

## Recovery and reporting

`status` is the recovery entry point. It shows the current revision, stage,
seed and base ids, conflict groups, candidate, validations, acceptance and the
apply result, including applied and conflicting paths.

- After an ambiguous transport result, read `status`, then retry the exact
  original `requestId` with identical arguments.
- While a publication is `applying`, only the request id of that current
  durable decision re-enters the journal. It proves each file's state and
  repeats no effect, while a replay of an older receipt only observes state.
  Release and a different decision are refused.
- An `interrupted` attempt can only be released. Begin a new attempt to publish
  again.
- Reload, shutdown or a new host never resumes a candidate, validation or
  publication automatically.
- A bounded summary is not a lost answer: it names the exact attempt,
  revision and digest, and `details` returns the complete view of that same
  durable revision.

Attempt storage is scoped to its owner and team inside the canonical root's
store. It holds at most 64 attempts for the lifetime of that store, 16 request
receipts per attempt with 13 rework receipts and 3 slots reserved for accept,
apply and release, 16 sources, 16 evidence refs per source, 8 commands, 8
contract selections, 256 dependency edges, 256 conflict groups and 4096 paths
per action, inside an 8 MiB metadata bound. Nothing is evicted. A corrupt
ledger or a missing established namespace fails closed. Release frees pins and
private retention but keeps the decision record, so only archiving the store
reclaims attempt capacity. Replies stay inside a 4,194,304-character budget
by falling back to the bounded summary, and `details` pages at most 65,536
UTF-16 code units of the complete view per call.

## Downstream bind recipe

Artifact task readiness alone adds no files: composition merges only the sources
the coordinator selects over their common base, and a consumer records
requirements rather than artifacts. The coordinator therefore keeps the
consumer attempt and its exact `derivedSnapshotId` pinned, and starts the
downstream worker with the governed `subagent_isolated_spawn` call before that
work begins, passing `setup.snapshotId` equal to `derivedSnapshotId`, the exact
team and task revisions, and the `work` lane. A conflicted consumer attempt
cannot take a candidate, and a validation-lane worker cannot resolve conflicts:
a clean validation-lane candidate verifies a clean seed only. When composition
has conflicts, only the governed `integration` lane may bind that seed. Run
the `integration`-lane resolution as a separate publishing batch over the same
inputs, validate that seal and accept it there, so that hop's own durable
attempt explicitly accepts the resolved conflict paths. Then record and accept
that exact resolver seal separately on the resolver worker's own assigned board
task, with its exact succeeded, drained and import-unchanged runner evidence.
Select the resolver seal alone for the consumer seed and keep the original
artifact dependency edges rather than rewiring them to the resolver task. Only
then start downstream work.

An already composed final candidate can be selected as an input to a downstream
seed. Its
exact seal may enter the separate board candidate path on the producer task and
be accepted there as its own decision, carrying the exact succeeded, drained
runner evidence the source rules require, and any additional source must share
that same base. Selecting those sources then composes a new consumer attempt.
A batch can build on an earlier consumer seed and publish the cumulative
changes. Take an accepted A that a consumer seed already incorporated over the
captured ancestor R, and a downstream worker that seals B over that seed. A
later batch can select B alone, because B's immediate base is that seed, and
its physical immutable base ancestry plus the older durable
attempt prove that the exact, currently accepted A candidate was already
incorporated. That attempt records the inheritance witness, pins B and its
exact evidence, and neither substitutes a newer A nor reads old content from
the live workspace. For a conflicted ancestor the lineage proof links that exact
acceptance and the source seal it carried with the earlier input witness, which
names all original input identities and the explicit resolved paths. A later
clean descendant of that hop still carries the proof, because every conflicted
hop of the stored lineage is verified rather than only the immediate base.
B's result is applied against R, the original captured ancestor that remains
the actual workspace baseline, so the cumulative changes of A and B are both
checked, and the application is per file with every touched path still
matching its original captured precondition. Missing or
legacy ancestry refuses the writeback, as does a captured ancestor without
recorded editor provenance.

## Limits and downstream contracts

Current limits: one immediate base snapshot per attempt, sealed sources from
the same owner and team, conservative conflicts for binary and overlapping
changes, and proof-only handling of a possibly started effect. Automatic
acceptance, automatic dispatch, board mutation, Git commits and publishing
network calls are not part of this workflow. Peer messaging does not exist yet.
A future messaging contract may reference an exact attempt, artifact or result
id and set or wake an explicit schedule wait generation, and that schedule
mutation implies no task, verdict or publication authority.

Downstream consumers must pin the exact artifact or result they use, recheck
the exact input revision and keep evidence, acceptance and publication as
separate decisions. Runner results remain evidence, board references remain
metadata, and a released attempt keeps no consumer pins. See
[isolated file views](isolated-views.md) and
[resource governance](resource-governance.md).
