# Isolated runner workspaces (implemented, opt-in)

Bounded private shell for workers that are bound to an isolated view. It is a
separate surface from the legacy workspace shell: unbound legacy workers keep
their existing approval behavior, and nothing here upgrades them.

Runner execution is opt-in and off by default. It applies only to a bound
worker whose view flags are enabled, and it never falls back to live workspace
files or to legacy shell routing.

## Settings

All three are User-only (machine/global) settings read from the global value, so
a repository cannot enable them.

| Setting (prefix `codexSubagent.`) | Default | Meaning |
| --- | --- | --- |
| `isolatedViews.runners.enabled` | `false` | Enables bounded private shell for bound isolated workers. Read live: turning it off returns `isolated_shell_unavailable` without creating runner storage or execution |
| `isolatedViews.runners.capacity` | `2` | Durable runner slots per canonical root, integer 1–8 |
| `isolatedViews.runners.maxQueue` | `32` | Bounded FIFO queue of waiting requests per canonical root, integer 0–256; overflow is an explicit capacity error |

Capacity and queue bounds are resource configuration: they take effect for a
canonical root's runner pool when that pool reopens. Enablement is checked live,
so disabling it stops new execution immediately. Existing runner records,
status and cleanup stay usable with the parent view flags enabled; reading state
or reconciling does not need approval UI and does not require the execution
flag. Neither setting grants shell to legacy workers, and neither bypasses the
per-model `allowShell` policy, `workspace-write` permission, or the live
pre-execution recheck.

## Approval surface

An isolated runner command is approved as its own kind, never as a legacy
workspace command:

- Requests **queue before slot and approval**. A waiting request holds a queue
  position; only once a slot is granted does the prompt appear, so the queue
  holds waiting requests rather than approved commands and a denied request runs
  nothing.
- The prompt shows the **logical project** (the approval scope), the **physical
  execution root**, the **physical working directory**, and the **exact recorded
  input revision** (snapshot id, overlay id, revision) as escaped literal text.
- Relative command paths resolve inside the materialized view. **Absolute OS
  paths are not remapped**: the shell runs with the user's OS access, so it can
  still reach the logical project. The working directory is **not** an OS sandbox
  and is not described as one.
- The prompt says the working directory contains the recorded private revision,
  including editor content captured in that revision. It does not reuse the
  legacy claim that unsaved editor content is invisible.
- Grants are keyed by kind **and** logical root. A workspace-session grant never
  auto-approves an isolated request, and an isolated grant never approves a
  pending or future legacy request. An accepted isolated grant covers later
  isolated commands in the same logical project only.
- Revoking a logical root clears both kinds and denies pending requests of
  either kind; abort, closing the tab, disposal and revocation stay fail-closed,
  and a retained webview cannot re-grant after any of them.
- Model permission, `allowShell` policy and live authorization remain owned by
  the engine/service; the approval prompt never substitutes for them.

## Physical view

- One coherent, exact snapshot + overlay revision is materialized: ordinary
  files are copied as raw bytes (binary, BOM and line endings preserved), with
  every visible file and directory of the view.
- Unsupported entries fail setup instead of being skipped silently, and hard
  links are not created.
- File modes come from the snapshot entry: an optional `644`/`755`, with an
  absent mode defaulting to `644`. POSIX uses the on-disk mode (including an
  unstaged `chmod`); Windows derives the bit from the Git index.
- The full view is materialized before a command runs, and the view's release
  mutex is respected before execution starts.
- Changes are imported as **one atomic import** of supported changes after the
  command exits, fails, times out or is cancelled, and only when policy allows.
  A stale overlay is never overwritten: the runner is retained instead.
- Before and after versions are recorded exactly. A command that ran on input
  revision 0 never validates revision 1; the after version describes the import,
  not the command's input.
- Nothing here validates, accepts or integrates a task board record.

## Pool, slots and queue

- Slots are per canonical root and tracked with that root's `SessionStore`, not
  per window. A slot covers the whole lifecycle: setup, awaiting approval,
  execution, import and cleanup.
- Requests wait in a bounded FIFO queue with cancellation; a slot is granted
  from that queue before approval, grants are exclusive owner leases, and every
  lease gets a fresh source and temp directory.
- A quarantined slot keeps consuming physical capacity until an explicit cleanup
  proves the owned process drained. Nothing is evicted or reused silently.
- Safe release unlinks nested dependency links (for example
  `node_modules/.bin` entries) without following them, so ordinary build output
  is removable while outside targets stay untouched.
- A corrupt journal, or a missing journal beside existing slot directories,
  fails closed instead of adopting empty state.
- Durable records, the existing `SessionStore` owner lock and shutdown drain
  behavior are preserved; the pool adds no second global lock.
- Closing the manager may wait indefinitely for unsettled runner I/O rather
  than releasing the store owner lock early.
- **A failed release write never loses a lease.** If the durable release cannot
  be published, the service retains the exact `drained`/`preserve` intent it must
  honour together with the live slot, so nothing is freed, reused or silently
  forgotten while storage is failing. An authorized `{ownerId, teamId}` cleanup
  retries the retained leases that match that owner and team only (the scope is
  validated and copied before any retry side effect, and each matching lease is
  attempted once per call); `close()` retries every retained lease after the
  handle's own commands have settled. While storage is still bad, each retry
  propagates the real failure. A failed close() leaves the handle closing and
  retains the store owner lock; a retry against a healthy store settles the
  lease normally. No command is replayed and no import is repeated, and
  retention never weakens the original intent into an unsafe deletion.
- A final result that could not be persisted keeps its durable pending attempt
  and its lease directory, and by design may stay quarantined with `preserve`
  set. It reloads as `uncertain` and is never replayed.
- Caps: 1024 lease records, a 4 MiB journal, and physical capacity bounded by
  the configured slot count. Materialized source trees reuse the existing
  capture caps.

## Command results

- A pending attempt is durable **before** anything runs.
- The final record is immutable, versioned (schema 1, version 1) and carries a
  deterministic URN plus the command, owner/lease identity, logical and physical
  directories, timeout, `inputVersion`, `afterVersion`, import status, outcome,
  exit code, signal, bounded output, truncation, drain flag, setup identity
  (environment hash, platform, shell, runtime, caches) and completion time.
- The versioned worker command output returns that full stored result with its
  result id, plus the `timedOut`/`cancelled` compatibility fields.
- A pending attempt found after reload becomes immutable `uncertain`: the
  command is never replayed and no passed status is fabricated.
- `afterVersion` rules: `imported` must keep the same snapshot and overlay and
  advance by exactly one atomic revision; `unchanged` repeats the input version
  explicitly; statuses other than `imported` or `unchanged` stay `null`.
- Caps: 1024 records, 128 MiB total, 1 MiB per result, 100,000 output
  characters. Start-time capacity is checked against the pending record only,
  so a start-capacity error is refused before execution begins. The final
  record is sized separately at finish: a final-capacity or write failure is
  never reported as success, the pending attempt and its directory are
  retained or quarantined instead, and the attempt reloads as `uncertain`.
- Reading a result never rewrites it. Derived fields (current revision,
  whether the input is current, staleness) are computed separately and are
  `null` when the current index is unloaded, released, missing or corrupt —
  reading one result never opens the file index just to answer that.
- **Namespace recovery is narrow and name-exact.** A missing `namespace.json` is
  recoverable ONLY when every existing root entry is an exact
  `namespace.json.<canonical lowercase UUID>.tmp` regular file left by the
  interrupted initial atomic write. Those temps are uncommitted bytes: they are
  never adopted as metadata, never read for identity, and never deleted or
  overwritten, and they remain reported in `unknownEntries`. Managed directories
  or records, other unknown entries, symlinks/junctions and malformed temp names
  beside missing metadata stay `runner_results_corrupt`.
- That predicate depends on the atomic-write file-name convention
  (`<target>.<randomUUID()>.tmp`). Changing that convention is a future contract
  change that must update the recovery predicate with it; nothing else about
  namespace identity, ownership or record paths becomes more permissive.

## Caches and environment

- Only package **download** caches (`npm`, `pip`) persist between runs.
- Installed dependencies, build output and temporary directories are fresh per
  slot, so a run never inherits another run's installed tree.
- No setup command runs automatically or unapproved. A command that needs
  installation and a test can chain them in the one approved command, for
  example `npm ci && npm test`.
- Deliberately scrubbed environment values and changed OS identity are outside
  the containment contract. Containment is process-lifetime control, not an OS
  sandbox.

## Process containment

- **Windows:** a Job Object created with the process suspended and assigned
  before it runs, no breakaway, cleanup on job EOF, and an active-process-count
  zero proof before a slot is reused.
- **POSIX:** an owned process group plus discovery of the inherited ownership
  marker through readable `/proc` (or, where `/proc` is not readable, a `ps`
  listing that is only ever treated as *potential* evidence, as described next).
- Failed or incomplete scans quarantine the slot instead of guessing that
  nothing survived.
- **A `ps`-based match is never environment ownership.** On a non-Linux POSIX
  host the fallback listing (`ps -A -E -o pid,lstart,command`) renders each
  process's arguments and environment as one block of text, so an exact
  `CODEX_RUNNER_PROCESS_MARKER=<token>` there may be an unrelated command's
  argument (a diagnostic grep for the assignment, `env NAME=value cmd`, and so
  on) rather than an inherited variable. Such a match therefore makes a process
  a *potential* owner only: the scan is reported incomplete with an explicit
  diagnostic, the drain stays unproven, and the lease is quarantined. Nothing is
  confirmed or signalled from that text, because re-reading the same merged text
  cannot prove environment ownership. The cost is deliberate: an exact-token
  ambiguity can quarantine a run even when the matching process is an unrelated
  diagnostic one. Only a capability-probed listing with no potential match at
  all still proves emptiness, so the ordinary case keeps its previous contract.
  Reclaiming a genuinely escaped descendant on such a host needs
  environment-specific proof (an equivalent of `/proc/<pid>/environ`), which
  this adapter does not have; until then those runs stay quarantined instead of
  being killed from ambiguous text. Linux `/proc/<pid>/environ` discovery and
  the Windows Job Object path are unaffected.
- A non-Linux reload cannot always prove that the original process creation
  ended; those leases may stay quarantined, which is the intended conservative
  outcome.
- Runtime identity is validated before any recovery decision, and no path kills
  by a bare PID: PID reuse therefore cannot terminate an unrelated process.

## MCP surface

All three tools are scoped by `{ownerId, teamId}` and available for existing
runner state whenever the parent view flags are enabled; the runner execution
flag is required only for **execution**, never for reading state or cleanup.
Counts and previews are bounded, and other identities are never shown.

- `subagent_runner_status` — `{ownerId, teamId, kind: 'leases' | 'queue' |
  'results' (default 'leases'), offset, limit <= 20}`. Returns `kind`, one
  scoped page of `items`, `nextOffset`, and a `summary` with `enabled`, `open`,
  `capacity`, `maxQueue`, `activeCount`, `quarantinedCount`, `queueLength`,
  `resultCount` and `pendingCount`. Rows for the caller's own scope include the
  owner `workerId`, `workerCreatedAt` and the result URI where one exists, and
  lease rows add `createdAt` for when that lease was created rather than when
  the worker was. Result entries are summaries with a 512-character output
  preview and a diagnostic preview, not full output.
- `subagent_runner_result` — `{ownerId, teamId, id}` with a 32-hex id. Returns
  `result` (the full immutable version-1 record and its URI), its `version`,
  plus the derived `currentRevision`, `inputIsCurrent` and `stale`. These
  freshness fields are `null` when the current index is unloaded, released,
  missing or corrupt; the immutable evidence is never updated by a read.
- `subagent_runner_cleanup` — `{ownerId, teamId}`. Natural, scope-only
  reconciliation with no `requestId` and no new command, so repeating it never
  repeats a command. It is annotated as destructive, is gated on the scope
  owner and team membership, recovers only confirmed owned process identity,
  and retains unknown state.
- Retained unimported physical changes are discarded only when an explicit proof
  establishes that the owned process drained; unknown or unverified state stays
  quarantined and is reported. The annotation is a client-facing warning only:
  it adds no approval prompt or extra input.
- Existing view controls and idempotency receipts are unchanged, as are worker
  history, parent leases, model policy and legacy approval.

## What a result does not mean

- No automatic dispatch, integration or acceptance, and no peer messaging.
- No automatic task-board validation of a command result.
- A stored command result is evidence of what ran, not an approval shortcut: it
  is not an artifact pin and not a verdict.
- Input revisions are exact. An imported change produces a new revision that no
  command has tested until one runs, so nothing may claim the "latest" revision
  was validated automatically. Later consumers must pin the retained artifact
  and compare the exact input revision; evidence acceptance and integration stay
  distinct decisions.

## Validation

Run `npm test`, `npm run typecheck` and `npm run lint`. Reviewed focused results
for this stage: pool 25/25, view materialization 15/15, command results 15/15,
approvals 23/23, process containment 30 total with 24 passing and 6 POSIX skips,
and the execution service 21/21 including a final-persist failure that reloads
as `uncertain` with no replay, plus temporary/environment case variants, slow
import, close and open races. All 11 host integration tests for the runner
tools pass through the real broker.

Platform limits are real and are not glossed over: no POSIX execution was
exercised in this environment (no WSL, Docker or Podman available), so the
kernel-scan and `ps` interface, ownership guard and drain state machine are
proven by compiled helpers, pure fixtures and unit coverage rather than a live
run. Deliberately scrubbed environment values and changed OS identity are
outside process containment.

Repository gates from the completed validation run: a fresh `npm test` exited
0 with 581 tests in 51 files (571 passing, 0 failing, 0 cancelled, 10 skipped)
in 92.6 s; the production webpack build and `build:test` were clean;
`npm run typecheck`, `npm run lint` and `git diff --check` all exited 0. The
10 skips are platform- or privilege-specific: 2 POSIX engine cases, 1
registration file-symlink privilege case, 1 POSIX `chmod` snapshot case and 6
POSIX runner-process cases. No real VS Code `npm run test:host` run is claimed.
