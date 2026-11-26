# Team mailbox (implemented, opt-in)

Durable structured messages between one coordinator and the members of one team.
The mailbox carries records only. A send never dispatches work and never mutates
scheduling. The governed scheduler may clear exactly the wait it observes once a
correlated live reply exists, and nothing here edits a file, changes a board
record or grants a permission.

## Enabling

Two User-level (machine) settings gate mail, and both are read live from the
global value, so a checkout cannot turn it on.

- `codexSubagent.taskBoard.enabled` must be `true`. Mail lives beside the board
  it belongs to.
- `codexSubagent.taskBoard.messaging.enabled` is the mail flag and defaults to
  `false`.

While the mail flag is off, `subagent_mailbox_send`, `subagent_mailbox_list` and
`subagent_mailbox_ack` stay visible in MCP discovery, the host refuses every
call with `feature_disabled`, workers receive no mailbox tools and no mailbox
storage is opened. Flipping the flag refreshes the mailbox surface without
restarting a worker or reconfiguring a model.

Storage is per canonical root, inside that root's existing store and owner lock.
Mail adds no second process, lock or relay path, and it never crosses a root, a
team or an OS user.

## Identity and scope

Coordinator calls pass `ownerId` and the optional `workspaceRoot`, exactly like
the board tools. `ownerId` is the trusted parent-conversation identity, the host
removes it before the mailbox sees the request, and it is never part of message
data.

Workers get the same three tool names as host-scoped tools. Their identity is
the worker session, so they pass no `ownerId`, and they can reach only their own
root and their own team. A governed, host-bound worker also gets
`subagent_mailbox_wait`.

A bound worker - one started with a team in its startup record or bound to a
private view - is limited to that one team by `send`, `list`, `ack` and `wait`,
even when the board still lists it as a member of another team. The same scope
drives automatic delivery and the wait, so the explicit tools and the automatic
path cannot disagree. A legacy or unbound worker keeps access to every team it
is still a live member of.

A live team member can send and read while the flag is enabled. The coordinator
can inspect every retained event of a team it coordinates. A worker reads only
the events addressed to it or sent by it, and only while its membership is live.

The `teamId` and `taskId` values come from board reads and name that live board
scope. No message field carries `ownerId`, so the host represents the trusted
coordinator or worker identity in the sender and recipient envelope instead.

## Sending

An original message requires `teamId`, `taskId`, `requestId`, `kind` and `body`.
It optionally names `recipients` as worker IDs and `toCoordinator: true`, with
one to four destinations in total. `requestId` makes the send idempotent. An
exact retry that still finds a retained receipt returns the original event, an
exact retry with changed inputs conflicts, and an expired replay is refused.
The tombstone horizon is decided from the record's age at send time, so once it
passes the same `requestId` creates a new event even before an unrelated write
or a reload prunes the old record. A read-only admission probe still refuses
that would-be new event as a write instead of publishing or returning it.

A reply sets `replyTo` instead. It routes to the original sender of that event,
stays inside the same team and task, produces one event per addressed live
actor, and takes no recipient list.

`kind` is one of `question`, `reply`, `interface_proposal`,
`interface_response`, `discovery`, `blocker`, `artifact_ready`,
`integration_feedback` or `escalation`. An `escalation` is addressed only to the
team coordinator.

`body` holds at most 1024 UTF-8 bytes. Recipients read it as untrusted peer data
under their own task, so state one thing you need or one thing you found rather
than instructions.

A question to the coordinator looks like this.

```json
{
  "teamId": "<team-id>",
  "taskId": "<task-id>",
  "requestId": "<request-id>",
  "kind": "question",
  "toCoordinator": true,
  "body": "Fixture directory is untracked, so setup is refused. Include it in the capture?"
}
```

## Reading and acknowledging

`subagent_mailbox_list` takes `teamId`, `direction` of `inbox`, `outbox` or
`all`, an exclusive `after` cursor, and `limit` up to 20 with a default of 12.
It answers one bounded page with `nextCursor` and `prunedThrough`. Start with
`after: 0` and continue with the returned `nextCursor`.

The sequence and cursor values in that page are team-local. A message's
`sequence` is that team's own 1-based ordinal, so one team's traffic can never
move another team's cursor or open a gap in it: an untouched team stays at
`nextCursor: 0` and `prunedThrough: 0` while other teams on the same root send,
expire and prune.
`prunedThrough` is the highest team ordinal known to have expired or been
pruned, so a cursor below it may span a gap.

Only the current mailbox document format is read. An older schema-1 document is
refused as `mailbox_malformed` and left byte-for-byte untouched: it is never
migrated, rewritten or deleted, so restore a current document or return to the
build that wrote it. A current document that retained records for more than 64
teams is refused the same way instead of being trimmed.

Reuse a cursor only in the same team and the same direction.

`subagent_mailbox_ack` takes up to 12 event ids and records the receiver's
acknowledgment. Acknowledgment is independent of delivery. An event counts as
delivered when its delivery receipt commits, and it stays readable whether or
not anyone acknowledges it. Acknowledging never edits, deletes or re-sends an
event and never changes the board.

Retries split into two kinds. An exact retry of an already persisted send, and
an acknowledgement that would record nothing new - every id already
acknowledged, unknown, expired or unaddressed - answer immediately: they take no
write reservation and publish nothing, so they still succeed while the governed
storage budget is exhausted. A new event or a first acknowledgement has to
change durable state, so it takes the ordinary governed write reservation and is
refused or made to wait while capacity is unavailable, and it persists nothing
in that case.

The host decides that by first attempting the very same call read-only under the
mailbox's own lock. That attempt answers exactly like a real call for a replay or
a no-op, carries the same identity, membership, expiry and idempotency decisions,
can never publish, and never grants authority of its own; only a call that would
really write is re-run with identical arguments through the governed
reservation.

## Delivery

A send is durable before the host offers it. Pending mail is offered
automatically in bounded batches at normal provider boundaries, up to the
per-turn budget, after the paired assistant calls and all of their tool results.
A bounded batch is checkpointed into the worker's own transcript exactly once,
as a labelled untrusted peer message, BEFORE the mailbox commits the delivery
receipt. An event is delivered when the provider emits a part for that prompt
and the receipt commits.

A legacy or unbound worker that belongs to several teams receives one batch
ordered by the mailbox's internal root sequence, which is the durable
cross-team delivery order, so an older notice of a second team is never starved
behind a busy first team. That internal order is never exposed: every event
keeps its own team's `sequence`, and a bound worker only ever reads its bound
team.

The rest follows from that contract.

- A stopped worker stays stopped. Mail never starts or resumes a worker and
  never dispatches work.
- Cancellation and compaction do not discard pending mailbox data.
- After a reload the worker stays interrupted until you resume it, and its
  pending mail is still there.
- There are no passive transcript broadcasts and no automatic replies.
- The delivered block stays in the transcript and every later request of that
  turn, a resume, and a later turn replay it as ordinary history, so the body
  and the event id remain available for a reply after an intervening tool round
  or a cancellation. It is not offered again as a new event.
- A receipt that fails after the checkpoint is retried when that retained input
  is presented to the provider again; a failed receipt never records delivery on
  its own.
- An ambiguous crash between exposure and receipt can repeat one injection, and
  delivery is therefore at-least-once rather than exactly-once. In normal flow
  the transcript holds one entry per delivered event.

The per-turn budget is at most eight notices and 16 KiB of raw notice JSON
(the full structured `MailboxMessage`, including its references and its
delivery/acknowledgement metadata). That byte gate is not a model-context
promise: the exact 0.8 context count still decides which of the counted
candidates fit. Automatic delivery scans up to the mailbox's own 200-message
retention bound before selecting, so a bounded run of older notices that do not
fit cannot hide a later fitting one; only counted, fitting candidates are
injected, and scanned entries never become model context. The public
`subagent_mailbox_list` page keeps its own limit of 20, which is unrelated to
the internal scan. The budget is spent in bounded batches, so a long backlog
normally arrives as one batch per turn and takes several turns. Treat the exact
batch size as runtime detail rather than a documented promise.

## Waiting for a reply

`subagent_mailbox_wait` takes `teamId` and `messageId` and must be the only tool
call of that round. A governed, host-bound worker uses it for its own `question`
or `interface_proposal` event.

The wait stores intent and yields capacity like the other governed waits. A
matching reply that is currently authorized lets the governed scheduler clear
only the wait generation the wait observed, which returns the worker to normal
admission. Cancellation or timeout fences the wait, so a restart begins from a
fresh observation instead of a stale one.

A coordinator reads the same state from `subagent_status` through
`waitingReason` and `scheduleWait`, and decides with `subagent_schedule` against
the observed `scheduleWaitRevision`, using `wait: null` to clear an explicit
wait. A message alone never starts a stopped turn and never changes permissions,
and only the scheduler acts after it observes a correlated live reply. A
precise timeout value or any automatic refresh of legacy waits is not promised.

## References carry identity, not retention

Mail names things. It never owns them.

- The `artifact` field carries the exact sealed `{id, version, uri}` copied from
  a sealed submission, and `artifact_ready` is the kind that carries it.
- The `evidence` field carries the same exact ref the runner returned for its
  result.
- The `attempt` field carries `{id, revision}`.

All of those values are identity only. A bare URI retains nothing, repairs
nothing and reads nothing, so report a released or unretained reference instead
of trying to resolve it. Pin and verify exact inputs through the existing scoped
retention, submission, runner and composition APIs, and never dereference a ref
from the mailbox. Those APIs decide access, and no message ever exposes another
worker's mutable overlay.

`interface_response` is informational. A real agreement is an explicit
`subagent_task_update` agreed-contract record with the expected task revision.
Official board states, verdicts, attempt acceptance and apply remain separate
decisions that mail can discuss and never perform.

## Capacity and retention

Each root holds at most 200 live events, 1024 request records and durable
cursors for at most 64 teams inside 1 MiB of mailbox data, with a standard
retention of 7 days. Those caps are reported rather than met by trimming
retained events or cursors: at the request cap a new event is refused, and at
the team cap a new team's first event is refused, so no existing team cursor is
ever evicted or reset.

A reply can expire with its parent event. Request identity is honored while a
receipt is retained, and an expired replay stays refused while its tombstone is
retained for up to 14 days; only that age horizon removes a tombstone. That age
is evaluated when the send is classified, exactly as the prune does it, so after
the horizon the same `requestId` can create a new event without waiting for an
unrelated write or a reload. Keep a request id stable inside the horizon you
depend on and record a new one afterwards.

An event that reaches its retention horizon while it is being published is
refused with `request_expired` instead of being returned as live mail. If its
durable write already completed, the id and receipt stay stored, so an exact
retry keeps answering `request_expired` before and after a reload.

## Parallel workflow habits

Mail is one part of the protocol in [parallel workflow](parallel-workflow.md),
which covers board agreements, sealed checkpoints and task-board reconciliation.
These habits keep mail correct inside it.

- Copy the exact `{id, version, uri}` of every sealed artifact and the exact
  runner ref of every piece of evidence into the record that uses it, naming the
  `artifact` and `evidence` fields in the message that refers to them. Mail
  preserves identity, so an unretained value must be reported, not repaired.
- Settle decisions in the board tools. Contract changes are
  `subagent_task_update` with agreed contracts and the expected revision, and
  state, verdicts, acceptance and apply each stay their own explicit call. A
  worker proposes an interface or records its blocker; only the coordinator
  records the agreement, and no mail reply clears a blocker.
- Keep one question per event so a reply stays routable to one sender, and use
  the event kinds as the whole vocabulary.
- Expect a backlog after a long turn. The per-turn budget arrives as one bounded
  batch per turn, and a stopped worker keeps its mail until it is resumed.
- Test expectations start from `tests/team-mailbox.test.cjs` and should add the
  disabled flag, worker scoping, reply routing, acknowledgment without delivery,
  cursor reuse in one direction, an unrelated team never moving a cursor, an
  older schema-1 document refused without a rewrite, a cap or retention refusal,
  an exact retry and the wait that clears on an authorized reply.
- Do not treat a mailbox event as a wake, an approval, a verdict or a lease. A
  send has no direct dispatch effect: it never starts, resumes or wakes a
  stopped worker, and only the governed scheduler clears the exact wait
  generation it observes once a correlated authorized reply exists.
