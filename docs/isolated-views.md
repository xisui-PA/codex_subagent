# Opt-in Disk-Efficient Team Worker Views (Isolated Snapshots)

This document describes the implemented stage of the opt-in disk-efficient
team-worker feature: shared immutable project snapshots, private per-worker
overlay revisions, sealed submissions, retention pins, cleanup, and the MCP
tool surface. The task-board records remain separate from this file view. Nothing
in this stage performs physical execution, peer messaging, automatic
dispatch, or automatic acceptance; a sealed submission is an immutable
artifact, not proof of validation or integration.

## Enabling

The feature is machine/global only and false by default. Both User Settings
(machine/global scope, not workspace settings) must be set:

- `codexSubagent.taskBoard.enabled: true`
- `codexSubagent.isolatedViews.enabled: true`

The extension reads `isolatedViews.enabled` from the global config value
only. A marked (already-bound) worker that later loses the flag cannot fall
back to live file tools; the host fails with `feature_disabled` instead of
silently serving the working tree.

## Workflow

1. **Create a shared snapshot** (`subagent_snapshot_create`, with `ownerId`,
   `teamId`, `requestId`, and an optional explicit untracked selection).
   Retrying the same `requestId` replays the original acknowledgment or
   recovers a pending Git capture; a different `requestId` starts a new
   snapshot.
2. **Bind a worker** (`subagent_view_bind`) to a snapshot that belongs to
   the same owner and team. The worker must be an **already stopped, owned
   team member**; binding does not start inference. The binding is
   permanent for the worker's identity and writes a Session marker.
3. **Resume / send** to that worker. Its file tools now operate on its
   private overlay revision; turns that occurred before binding remain
   legacy and are not rewritten.
4. **Seal** the exact private revision. Workers call `seal_submission`
   with `requestId` and `expectedRevision`; coordinators use
   `subagent_view_seal` with the worker `id` and the same precondition.
   Later edits never change the submission.
5. **Read sealed artifacts** with `subagent_submission_read`
   (`read_file` / `list_files` / `search_files` on the exact submission).
   This never consults live workspace files.
6. **Pin exact artifacts before consumers use or release them**
   (`subagent_view_pin`) — named pins retaining an exact snapshot or
   submission. Task-board references, acceptance records, and validation
   metadata do **not** retain content automatically.
7. **Release roots and clean up** (`subagent_view_release`,
   `subagent_view_cleanup`). Release and cleanup are destructive-hinted;
   other references to the same content remain valid.

`subagent_view_status` pages the shared index (snapshots, overlays,
submissions, pins, pending captures) and is read-only.

## Capture: what is included and what is not

**Git-backed roots (Git >= 2.46 required).** The 2.46 floor exists so the
hook/fsmonitor isolation and `GIT_NO_LAZY_FETCH` low-level lazy-fetch block
are available; Git raw immutable objects are kept in their own store
namespace with own retention refs. Inclusion is:

- All eligible tracked paths, including unchanged files and staged or
  unstaged changes. Stable tracked deletions are absent. Byte-identical
  index blobs are referenced directly; dirty bytes are stored once in CAS.
- Omitted `selectedUntracked` adds nonignored untracked files; `[]` adds
  none. An explicit list adds only those untracked paths, including ignored
  files if named. Explicit selections bypass default untracked discovery,
  so unselected files cannot exhaust its metadata cap. This selection never
  restricts tracked paths or eligible editor overrides. Hard exclusions
  still apply.
- Eligible **unsaved editor documents**, captured once, from the **owning
  VS Code window only**: file-backed documents and absolute associated
  untitled documents. Current editor text is encoded as UTF-8 in the
  snapshot; original encoding metadata is not retained. Documents from other windows,
  unassociated untitled documents, unsafe paths, excluded entries, and
  outside-root entries are ignored.
- No filters, hooks, or network fetching run during capture.

Excluded / unsupported, explicitly and by name:

- `.git`, `.codex` and `.vscode` are excluded case-insensitively at every
  path component, including leaf files. Dependency/build directories
  `node_modules`, `dist`, `build`, `coverage` and `vendor` stay excluded
  even when explicitly selected or open in an editor.
- Git capture permits other dot directories such as `.github` when an
  eligible tracked/untracked/editor path uses them. Non-Git capture skips
  all dot-prefixed directories; dot-named regular files remain eligible.
- Sparse checkout, partial clone / promisor remotes, object `alternates`,
  and borrowed object directories are unsupported. `objects`,
  `objects/info` and `objects/pack` must be plain directories, not links
  or junctions. Git capture requires the repository/worktree root rather
  than a subdirectory; linked worktrees use their own index and common ODB.
- Symlinks, gitlinks, unmerged index paths and other special entries are recorded as
  `unsupported`; they are never followed or traversed.

**Non-Git roots** use a bounded CAS capture (see caps).
Detected unsupported Git layouts fail explicitly rather than being silently
captured as non-Git. Unbound legacy workers remain available; a marked
worker cannot switch back to a live view.

**Consistency.** The capture performs two matching full scans plus freshly
cloned editor/selection queries between and after scans; on mismatch it
retries up to 3 attempts and then fails with `inconsistent_capture`.
Editor consistency checks use the same path eligibility and namespace
planning as capture. A document conflicting with a captured file or
directory, or an earlier accepted editor document, is ignored. Changes
confined to outside-root, excluded, unsupported, or namespace-conflicting
documents do not invalidate capture; changes to which documents are
accepted still trigger retries. File reads verify an opened handle's
identity before reading and check that same handle afterward, rather than
reopening a mutable path.
Captured byte buffers are stable afterward; reads from the store never fall
back to the live workspace.

## Private view semantics

One `LayeredTree` namespace merges the snapshot base with the worker's
revision deltas and serves `read_file`, `write_file`, `patch_file`,
`delete_file`, `rename_file`, `create_directory`, `list_files`, and
`search_files`. Key rules:

- Writes verify the **full raw SHA-256** (`expectedHash`, or `new` for
  absent files); stale hashes are rejected before any content is stored.
- Windows casing (case-insensitive resolution on win32) and protected names
  (`.git`, `.codex`, `.vscode`, reserved device names) are enforced through
  the tree.
- Captures reject case-colliding paths rather than guessing. Portable path
  protections also refuse traversal, ADS/drive escapes, control characters,
  reserved device names and trailing dots/spaces.
- Patch EOL normalization applies **only after the exact raw hash matches**:
  uniform LF/CRLF files accept the other style in `oldText`/`newText` and
  preserve their own style; **mixed** endings require an exact match.
  BOM bytes stay part of the raw hash and text (an `oldText` may include
  U+FEFF or match the characters after it).
- Binary or oversize (>2 MB) text is an explicit `file_limit` error on
  reads and an explicit skip count on searches; missing or corrupt stored
  content is always an error, never a silent skip. Search applies no extra
  filters that could hide private files. Each coherent read operation
  reuses Git object-store discovery across files; it still checks
  authorization and reads and verifies the stored bytes on every read.
- **No shell:** `run_command` is always `isolated_shell_unavailable`; it
  never executes in the main workspace and never inherits main approval.
  Existing model/permission denials may reject a call before it reaches
  that adapter.

## Disk growth model

Growth is dominated by **whole changed file payloads** plus per-revision
metadata — this is not block-level diff storage. Content is deduplicated
globally by raw SHA-256 in the shared store; the base snapshot is never
copied per worker, so a worker's first revision is cheap.
Unchanged writes reuse existing retained content without adding a CAS
payload or advancing the overlay. The saving applies to view storage;
existing transcript/tool-result retention is unchanged and may repeat text.

## Retention roots and lifecycle

Retention roots are: active overlays, unreleased seals/submissions, named
pins, pending captures and internal binding pins/intents. Receipts,
history, and board metadata are **not** roots.

- CAS deltas form immutable chains (revision cap 1024). Seals survive later
  edits, reloads, and even overlay release.
- Identity is `(workerId, workerCreatedAt)`; the permanent
  `workerCreatedAt` prevents worker-ID-reuse confusion after deletion.
  Explicit model migration uses the existing enabled-target policies and
  preserves the worker's binding and private revisions.
- `release` of a snapshot drops only its creation pin; other references
  stand. A pending capture can be released explicitly; the original create
  request then fails with `isolation_released`.
- `cleanup` first confirms the raw Session file is `ENOENT` before releasing
  an orphan's resources; a corrupt or still-present Session is unknown and
  therefore **retained** with a diagnostic. A crash between pin and
  publication is recovered from the matching marker + binding intent.
- Releasing an internal binding pin requires confirmation that its original
  worker is missing, replaced, unbound, or permanently bound to a different
  overlay. Cleanup also discards those obsolete intents. An intent still
  claimed by its exact Session marker, or with unknown worker state, is
  retained; retry the binding or use cleanup to reconcile it first.
- Cleanup restores exact retention refs for retained Git snapshots and
  pending candidates without pretending a pending capture was acknowledged.
  It releases an unreferenced snapshot's exact store-owned ref and expected
  tree before removing its metadata, then sweeps CAS across all remaining owners'
  roots. Unknown storage files and links are preserved and counted;
  conflicting managed refs are preserved with diagnostics. Ref deletion
  verifies both kind and OID under a prepared Git transaction lock; aborts
  preserve the ref and release the lock. Unrelated Git refs are untouched;
  Git `gc` is never run.
- Offline (saved-root) operations are limited to status, read, pin,
  release, and cleanup under the existing owner lock; capture, bind, seal,
  and resume require the original open root.
  Reads still require the saved CAS and Git common object directory;
  missing backing content fails explicitly without a live-file fallback.
- Fail-closed invariants: a missing index with existing content (or a known
  session marker) is `isolation_corrupt`, never a reset or live fallback;
  the store directory must sit **outside** the canonical project root.
  After an open failure, restore storage and use a fresh handle/host; a
  failed handle cannot overwrite restored metadata from cached empty state.

## Caps

- Capture: 10,000 files, 20,000 namespace entries, 32 MiB per file,
  512 MiB total.
- Git discovery: 100,000 index records and 50,000 default untracked records,
  before capture exclusions. Explicit untracked selections bypass the
  default untracked listing and its metadata cap.
- Index: 32 MiB serialized; 64 snapshots, 256 overlays, 1024 submissions,
  1024 pins, 4096 receipts, 64 pending captures; 1024 overlay revisions.
- Text tools: read 2 MB, write 500,000 characters, search visits at most
  2000 entries with bounded results/pagination.
- Capacities fail explicitly; nothing is evicted. Receipts are permanent
  within their namespace.
- Slow tools (snapshot create, cleanup, sealed submission inspection) get a
  360 s operation timeout, a 370 s bridge response timeout, and the MCP
  client's 420 s tool timeout.

Existing model, permission, owner, lease, and history behavior is preserved
unchanged.

## Future contracts (not implemented in this stage)

- Consumers (runners, validation, integration) will retain the exact
  sealed artifacts they consume; pinning is the mechanism for that.
- Integration must recheck current working-tree and dirty-editor base
  hashes and path protections before applying a sealed change.
- The synthetic Git retention tree is **not** the project's tree or a
  project commit.
- To materialize a manifest + deltas faithfully, executable bits and
  encoding metadata must be added to the stored entries before any
  mode-faithful physical runner can exist; they are not retained today.
- No runners, integration, peer messaging, dispatch, or auto-acceptance
  exist in this stage.

## Validation

Run `npm test`, `npm run typecheck` and `npm run lint`. Focused suites cover
capture consistency and editor content, raw Git retention and real GC,
merged tools and hash/EOL guards, immutable submissions, crash/reload
recovery, scoped cleanup, permission revocation and shutdown/owner-lock
draining, incomplete-index recovery, and explicit model migration.
The storage-growth test binds 16 workers to one 1 MiB base and
checks metadata growth plus deduplication of identical private payloads.
