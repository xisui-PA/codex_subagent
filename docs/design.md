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
