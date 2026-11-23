# Codex Subagent

Persistent workers for Codex, powered by tool-capable language models configured in VS Code. Use a compatible model exposed through VS Code's Language Model API, including a BYOK provider. **No LLM is installed, downloaded, or started locally.** Model credentials stay with VS Code's Language Model API.

## Prerequisites

- VS Code desktop version 1.104 or newer.
- [Codex](https://github.com/openai/codex) installed and configured in VS Code, since Codex performs the delegation.
- A tool-capable language model configured in VS Code via **Chat: Manage Language Models** (or any other VS Code language model provider that exposes models through the Language Model API).
- A trusted filesystem workspace for worker execution.
- Codex and this extension must run in the same local/remote environment; registry routing does not cross machines.

## Installation

1. Install **Codex Subagent** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xisui-pa.codex-subagent) (extension ID `xisui-pa.codex-subagent`), or run `code --install-extension xisui-pa.codex-subagent` from a terminal.
2. Alternatively, package a [VSIX](#development-and-release) and install it with **Extensions: Install from VSIX**.
3. Open a trusted filesystem workspace and run **Codex Subagent: Set Up Workers**.
4. Select a tool-capable model and approve VS Code model access if prompted. Setup tests an inert tool call and a follow-up using its result; this probe accesses no workspace files.
5. Setup registers MCP and checks a real stdio handshake through the worker host. In **Codex chat → gear → Codex Settings → MCP Servers**, check that `codex_subagent` is configured and enabled. This page does not list individual tools; use the chat test below to check which tools Codex can access.
6. Send the connection test below in Codex chat. If Codex cannot find the tools or the MCP call fails, run **Developer: Reload Window** from the VS Code Command Palette (**Cmd+Shift+P** on macOS, **Ctrl+Shift+P** on Windows/Linux), reopen Codex chat, and send the test again. Use a window reload to reconnect; these instructions do not rely on a separate MCP restart control.
7. After the connection test passes, ask Codex: **“Use the codex_subagent MCP tools to spawn a read-only worker to inspect README.md. Give this conversation a unique ownerId, wait for completion, and report its findings.”** This checks actual model inference and workspace access.

Copy this connection test into Codex chat (the setup/register notification offers a **Copy Connection Test** action that copies it to the clipboard):

```text
List the available `codex_subagent` MCP tools, then call `subagent_health` through MCP. Do not substitute a shell command.
```

A successful test lists the worker controls and every opt-in tool group — 13 worker controls, the 8 task-board tools described in [Task board](#task-board-opt-in), the 8 isolated-view tools described in [isolated file views](docs/isolated-views.md), the 3 runner tools described in [Isolated runner shell](#isolated-runner-shell-opt-in), the 3 team-mailbox tools described in [Team mailbox](#team-mailbox-opt-in), and the coordinator `subagent_integration` tool described in [coordinator integration](docs/integration.md) — and returns `ready: true` from `subagent_health`, with the expected workspace root and enabled model. The board and isolated tools stay discoverable even when their opt-in settings are off; the host refuses their calls at that point. This confirms that Codex can call the worker host; it does not perform model inference. If the test still fails after a window reload, run **Codex Subagent: Check MCP Connection**, then inspect **Codex Subagent: Show Diagnostics** and **Codex Subagent: Show Log** for the failure details.

Reloading the window interrupts active workers. After reloading, inspect them in **Codex Workers** and use **Resume** explicitly to continue unfinished work.

**Check MCP Connection** repeats the handshake independently. It verifies the MCP server and host, not whether an existing Codex conversation has refreshed its tools. **Show Diagnostics**, **Show Log**, and **Retry Worker Host** remain available after startup failures and in an empty window.

Registration adds a managed entry to `$CODEX_HOME/config.toml` or `~/.codex/config.toml`. It preserves unrelated content and config symlinks; the backup is beside the actual config target. The relay is copied into stable extension storage and refreshed after updates. Existing managed registrations are repaired on activation; new registrations require setup. **Unregister MCP from Codex** removes the entry and retains transcripts.

## Data and privacy

Worker requests flow through VS Code's Language Model API to the provider you selected. Task text, file contents, tool results, and message history can be sent to that provider, whose privacy and data policies apply.

Transcripts, change snapshots, and archives are stored in plaintext in extension storage on the extension host's filesystem (on the remote host for remote workspaces) and are retained until you clean them up. **Show Diagnostics** shows their storage location; **Export Transcript** and **Clean Up Saved Workers** export or delete them. Model credentials remain managed by VS Code; this extension does not read, store, or transmit them.

## Worker experience

The Activity Bar's **Codex Subagent** view container holds the **Codex Workers** and **Models** views, plus the opt-in **Task Board** view (see [Task board](#task-board-opt-in)). The workers view groups workers by parent conversation and workspace root. Click a worker for its live conversation panel: output, current activity, recent tools, errors, changed files, and recovery actions. Completion/failure notifications link back to the worker.

The **Models** view shows the strict User-settings `codexSubagent.models` pool in insertion/priority order, without needing a worker host or a trusted workspace. Drag model rows onto another model to place them before it, or drop into empty space to move them to the end; the order is saved to User Settings and controls automatic model selection. Multiple selected models keep their relative order. Expanding a model shows its effective policy (`allowWrite`, `allowShell`, `numSessions`, `maxToolRounds`, `turnTimeoutSeconds`, `autoCompact`) with built-in defaults (true/true/1/40/600/true) flagged as `default`, plus its `modelOptions` entries as readable JSON. Title actions offer **Enable Model**, **Configure Model Options**, and **Open Model Settings** (scoped to `codexSubagent.models` in User Settings); clicking a model configures its options. A malformed setting shows a visible error row that opens the settings; an empty pool shows Enable Model / Open User Settings guidance. The view refreshes on configuration changes and settings-file changes, including order-only edits.

- **New Worker** starts a task directly from VS Code.
- **Send Follow-up** queues a message behind the active turn.
- Panel drafts and unacknowledged follow-ups/resumptions are saved in extension state. **Retry pending request** reuses the original request key and arguments, including after reopening a panel or reloading VS Code. The draft clears only after acknowledgement. **Clear retry record** keeps the draft and does not cancel accepted work.
- **Cancel** stops generation and suspends queued messages. The worker remains busy until in-flight edits and command termination have settled.
- **Resume** continues failed, cancelled, or interrupted workers from their saved conversation: choose an eligible model and optional steering instructions. A completed worker whose model was removed or restricted can also be recovered: choose a replacement model and leave the message empty to switch the model only (no inference and no replay), or add text to queue exactly one follow-up turn that preserves the earlier turns.
- **Discard Queued Messages** prevents unstarted messages from executing while retaining their records.
- **Compact Worker** generates a summary or accepts a manual one.
- **Export Transcript** saves the conversation and archival history. **Clean Up Saved Workers** supports bulk deletion. Deletion removes archives, change snapshots, and operation keys too.
- **Browse Saved Workspaces** reveals other saved transcript stores.

Review before/after diffs and revert individual changes in the panel. Revert checks current content and refuses to overwrite later user edits. Legacy worker edits use WorkspaceEdit and native editor undo. Already-dirty buffers are readable/editable and stay unsaved; previously clean files are saved. Returned hashes and change snapshots include formatting and other save participants. Legacy shell commands see disk contents, so save dirty buffers before validation. Opt-in isolated workers use the private file view described below.

Revert is tracked as worker maintenance. Conflicting follow-ups, deletion and other edits are blocked until it settles, and shutdown retains store ownership while it finishes. A restart during Revert preserves the task’s prior state and flags uncertain file effects for inspection.

## Models and settings

Models must be exposed by `vscode.lm.selectChatModels()`. A settings entry alone is insufficient if the provider does not expose it through this API. **Enable Model** tests tool calling and tool-result replay. Background work requires affirmative access and never initiates first-use consent.

Setup and workers use the same response handling. Text and tool calls are processed; known reasoning parts, token-usage footers, and optional server continuation markers are excluded from task output. Workers send their durable message history on each request rather than relying on server continuation markers. Other response types fail explicitly with the part type and, for data parts, the MIME type; payload contents are excluded from that diagnostic. If an older installation reports `unsupported_response` for your model, install a rebuilt version, run **Developer: Reload Window**, and retry **Enable Model** before resuming the failed worker.

Enable/disable sync directly with the `codexSubagent.models` setting: **Enable Model** runs the probe and, only after it passes, adds the exact model ID to the setting (an existing entry keeps its policy and position); **Disable Model** removes just that key from the setting while preserving every other entry and order. Manual User Settings edits are authoritative and take effect immediately. **Configure Model Options** edits the provider request options stored at `codexSubagent.models.<model-id>.modelOptions` for a configured model ID.

Reasoning effort for a BYOK model comes from VS Code's persisted language-model configuration, not from the per-model `modelOptions` under `codexSubagent.models`. Verified in VS Code 1.144.1, `sendChatRequest` resolves and merges that configuration into every request ([`languageModels.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/languageModels.ts)), so workers inherit the selected model's configured `reasoningEffort` automatically. The fallback order is persisted per-model effort, then VS Code's model-configuration schema default, then the provider/model default when no effort is supplied; conversation-specific Copilot overrides are not inherited. This behavior is scoped to the verified implementation rather than claimed for the older 1.104 minimum.

The per-model `modelOptions` objects remain provider request options. The built-in Custom Endpoint provider reads effort from model configuration and filters ordinary model options, so adding `reasoningEffort` or `reasoning_effort` to those settings does not override effort there. The Language Model API does not expose the full effective BYOK configuration to this extension; a worker-specific override would require request-configuration support.

The extension does not extract `${secret:...}` values, query the OS keychain, or directly connect to model endpoints. Live credential-backed access must be tested using Enable Model in your VS Code window.

### Ordered worker model pool

`codexSubagent.models` is an ordered pool of worker models keyed by **exact enabled model IDs**; the JSON key insertion order is the automatic-selection priority. The IDs below are placeholders — replace them with the exact IDs shown by **Enable Model** / **Show Diagnostics**.

```json
{
  "codexSubagent.models": {
    "model-a-id": { "allowWrite": false, "numSessions": 1 },
    "model-b-id": { "allowWrite": true, "allowShell": false, "numSessions": 1 },
    "model-c-id": { "allowWrite": true, "allowShell": true, "numSessions": 2, "maxToolRounds": 60, "turnTimeoutSeconds": 900, "modelOptions": { "temperature": 0.2 } }
  }
}
```

Spawns and **New Worker** selections that omit a model are routed automatically: read-only work takes `model-a-id` first; workspace-write work skips it and uses `model-b-id`, then `model-c-id`, because only `model-b-id`/`model-c-id` allow writes (three concurrent writers: B, C, C).

- `numSessions` bounds **active** conversations for that model inside its owning workspace/store. Omit it for the built-in default of 1. The opt-in governed workflow yields execution capacity during dependency, message, runner and approval waits while retaining the owning-store model ceiling; legacy reservations still include draining tools. Separate aggregate settings never expand this per-store limit.
- When every eligible model is full, the worker queues on the highest-priority eligible model and is **not** migrated to a freer model.
- An explicitly chosen model stays pinned and is still subject to that model's permission flags and `numSessions`.
- `codexSubagent.models` is now the sole permission/limit policy source. `allowWrite` and `allowShell` default to true when omitted, so set either explicitly to `false` to restrict that model. Only user-level settings are honored.
- `maxToolRounds`, `turnTimeoutSeconds` and `autoCompact` are optional per-model fields with built-in defaults when omitted: 40, 600 seconds, and `true`.
- `modelOptions` is an optional per-model JSON object of provider-specific request options passed to VS Code `sendRequest` for that exact model (never credentials). Omitted means no extra options. The former top-level `modelOptions` and `modelProfiles` settings were removed without fallback: stale copies left in user settings are ignored; move their values into the model's nested `modelOptions`.
- An empty pool (`{}`) means no models are enabled: no workers, tools or inference for any permission until at least one model is enabled (Enable Model adds the exact ID to the setting).
- Writes still require `permission: "workspace-write"`. Shell still additionally requires one-time or workspace-session approval in VS Code.

Settings are applied live. Saving or repairing `codexSubagent.models` (including raising `numSessions`) re-evaluates queued workers in the owning window, so stranded queues start once the settings are valid; the host is not restarted and started turns are not replayed. Permission changes are checked while tools run, so a restriction saved mid-turn can still fail that turn. **New Worker**, **Resume Worker**, and the panel dropdown offer only eligible configured models in pool order; when none is eligible they explain what to fix. Completed workers can switch to any eligible model, optionally with one follow-up turn.

Provider request options now live inside each `codexSubagent.models` entry as nested `modelOptions`; they are unrelated to routing. Only user-level (global) settings are honored, and keys must reference models currently exposed and enabled by VS Code.

| Setting (prefix `codexSubagent.`) | Default | Purpose |
| --- | --- | --- |
| `models` | `{}` | Sole enabled-model source: keys are exact enabled model IDs in automatic-selection priority order; values are per-model permissions, tuning (`allowWrite`, `allowShell`, `numSessions`, `maxToolRounds`, `turnTimeoutSeconds`, `autoCompact`) and provider request options (`modelOptions`). Empty means nothing is enabled |
| `notifyOnCompletion` | `true` | Completion/failure notifications |
| `taskBoard.enabled` | `false` | Opt in to the persistent task board: enables board calls and the **Task Board** view. The 8 board tools stay discoverable when off, but the host refuses every call. Records only — no worker dispatch, file edits or automatic acceptance. Machine scope |
| `taskBoard.messaging.enabled` | `false` | Opt in to durable team mail over the task board. Requires `taskBoard.enabled`, is read live and is honored only from User Settings. While it is off, the 3 mailbox tools stay discoverable but every call fails with `feature_disabled`, workers receive no mailbox tools and no mailbox storage is opened. Messages are stored for live members of a team you coordinate and are delivered only to a worker that is already running, so nothing is started, resumed, scheduled or acknowledged automatically. Machine scope |
| `isolatedViews.enabled` | `false` | Opt in to shared immutable snapshots and private worker overlays. A worker already bound to a view never falls back to live files while the flag is off (`feature_disabled`). Machine scope |
| `isolatedViews.integration.enabled` | `false` | Opt in to coordinator integration attempts. Requires `resources.enabled`, `taskBoard.enabled` and `isolatedViews.enabled`. Validation uses the separately enabled isolated runner, and accept and apply stay explicit decisions. Machine scope |
| `isolatedViews.runners.enabled` | `false` | Enables bounded private shell execution for bound isolated workers. Read live from User Settings. While it is off, isolated `run_command` returns `isolated_shell_unavailable`, no runner storage or execution is created, and legacy workspace shell routing is unchanged |
| `isolatedViews.runners.capacity` | `2` | Durable runner slots per canonical root, integer 1–8. Resource configuration: applied when the host and its pool reopen |
| `isolatedViews.runners.maxQueue` | `32` | Bounded FIFO queue of waiting runner requests per canonical root, integer 0–256; overflow is an explicit capacity error |

Removed global settings (`allowWrites`, `allowShell`, `maxConcurrentWorkers`, `maxToolRounds`, `turnTimeoutSeconds`, `autoCompact`, `modelOptions`, `modelProfiles`) are ignored if still present in user settings; configure their per-model equivalents under `models` (provider request options go in each entry's nested `modelOptions`).

## Permissions and editing

Read-only is the default. For code changes, configure a model in `codexSubagent.models` with `allowWrite` true (or omitted) in **User Settings** and request `permission: "workspace-write"` when spawning. Spawn rejects that permission when the selected model policy or write tool is unavailable. `subagent_health` reports effective tools before delegation.

Tools include paginated UTF-8 reads, directory listing/creation, bounded literal search, hash-checked writes, exact-text patches, rename, and delete. Changes have recoverable before/after snapshots. Stale hashes, symlink paths, hard-linked replacements, and writes to `.git`, `.codex`, or `.vscode` are rejected. Missing parent directories can be created in order. These checks are not an OS filesystem sandbox against arbitrary concurrent external processes.

A per-model `allowShell` policy in `codexSubagent.models` (default true when omitted, or false to restrict) may offer shell execution to workspace-write workers. Commands without an active session grant open a scrollable **Review Worker Command** tab showing the full command and working directory with **Run once**, **Allow for this workspace session**, and **Cancel** controls; closing the tab or pressing Escape denies it. A workspace-session grant covers all workers in the same canonical workspace/worktree for this VS Code window, including commands already waiting there, but other workspace/worktree roots need separate grants. The grant is memory only: it ends on window reload/restart or when you run **Revoke Shell Approval**, which also targets one root or all roots and does not terminate running commands (use **Cancel Worker** for that). Commands run with the extension host's OS access, outside Codex's sandbox. Time/output are bounded. POSIX cancellation and deadlines terminate the process group, retaining the forced-kill grace period even if the shell exits first; Windows cancellation targets the direct process. Repository settings cannot grant write/shell access. Bound isolated workers get their own bounded shell surface with a dedicated prompt and its own grants: it shows the logical project, the physical execution root and working directory, and the exact recorded input revision, and neither kind of session grant ever approves the other. See [Isolated runner shell](#isolated-runner-shell-opt-in).

## Parent ownership and lifecycle

Give each conversation a unique `ownerId` and optional readable `ownerLabel`. Spawn/send/resume use distinct `requestId` values. **Retry ambiguous transport results with the SAME key and arguments** to recover accepted work. Keys are scoped to the owner when supplied. Mutating controls must pass the worker's ownerId. The VS Code panel can administer all groups; ownership is a coordination boundary, not OS-user authentication.

Default `parentPolicy: "keep"` preserves work across disconnects. For unattended cancellation, use `parentPolicy: "cancel-on-expiry"` and a `leaseSeconds` value. Renew with `subagent_parent` / `action: "heartbeat"`; explicitly cancel a group using `action: "stop"`. Leases are checked about every five seconds. The relay emits MCP logging notifications for tracked workers that stop; clients may display these without injecting them into model context, so polling remains available.

Poll with `subagent_wait`, omitting `timeoutMs` to use the derived default of max(60s, one tenth of the effective model turn timeout), using the largest interval across a mixed batch. A shorter explicit `timeoutMs` (including 0) is honored; a value above the derived limit is rejected. The returned worker views already contain status and output; inspect `subagent_status` only for additional history. The relay checks tracked workers for completion every five seconds. The bridge allows up to the wait plus a margin (370s when `timeoutMs` is omitted); external client request timeouts and parent leases must cover the requested wait plus a margin.

Native Codex parent-stop events and native agent UI integration are not exposed to this extension. A transport disconnect is not treated as proof of cancellation. Explicit stop/lease policies handle that boundary while retaining recoverable work.

| MCP tool | Purpose |
| --- | --- |
| `subagent_health`, `subagent_models` | Check the host, effective tools, and models |
| `subagent_spawn` | Start an asynchronous worker with explicit context |
| `subagent_send`, `subagent_discard_queued` | Queue a follow-up or discard unstarted work |
| `subagent_status`, `subagent_wait`, `subagent_list` | Read output/history, wait, or list by owner |
| `subagent_cancel`, `subagent_resume` | Stop/recover work, optionally changing model/instructions; completed workers switch model (and optionally add one turn) when given an explicit enabled model |
| `subagent_compact` | Automatic or manual summary with immutable archives |
| `subagent_parent` | Renew leases or stop a parent group |
| `subagent_delete` | Permanently delete a stopped worker |

Status supports `outputOffset`/`outputLimit`, `turnId`/`attempt`, and `afterMessage`/`messageLimit`. History offsets stay continuous across rollovers. Supply context explicitly: workers do not inherit hidden parent conversation, native tools, skills, or approvals. Those are the 13 worker controls; [Task board](#task-board-opt-in) adds 8 board tools, [Isolated team file views](#isolated-team-file-views-opt-in) adds the 8 isolated-view tools, [Team mailbox](#team-mailbox-opt-in) adds 3 mailbox tools, and [Isolated runner shell](#isolated-runner-shell-opt-in) adds 3 runner tools plus the coordinator `subagent_integration` tool described in [coordinator integration](docs/integration.md).

To target a registered worktree from a Codex conversation rooted in the main checkout, pass its absolute `workspaceRoot`. Keep the returned root on subsequent controls, and group wait IDs by root. The server verifies that roots are open workspace folders or registered worktrees; arbitrary sibling folders are rejected. This also handles worktrees nested inside the main checkout.

Model-generated manual compaction returns immediately as cancellable background maintenance. Wait for it to stop before resuming or sending another message to that worker; unrelated workers remain responsive.

## Task board (opt-in)

The task board is an optional, durable record of teams, tasks, dependencies, candidate artifacts and validations for this canonical workspace root. It is off by default and never participates in work unless you opt in.

Enable the machine-scoped boolean `codexSubagent.taskBoard.enabled` in **User Settings**. It defaults to `false`; machine scope means a repository cannot enable it. While it is off, MCP discovery still lists the board tools, but the host refuses every board call with `feature_disabled` and changes nothing; workers also lose their private board definitions, and the **Task Board** view stays hidden.

The 8 board operations are `subagent_team_create`, `subagent_team_get`, `subagent_team_list`, `subagent_team_update`, `subagent_task_create`, `subagent_task_get`, `subagent_task_list` and `subagent_task_update`; their strict schemas are derived from the shared board input types in `src/task-board-tools.ts`. Every call requires a stable `ownerId` (1–200 characters) naming the Codex conversation. It is treated as the trusted coordinator identity and removed before the board sees the request. Like the existing worker controls, it separates cooperating callers on this machine; it is not authentication between OS users. Creates require `requestId`; updates add `expectedRevision`, so retries stay idempotent and a stale write fails instead of overwriting a newer revision. Unknown fields — including `actor`, `workerId` or a second identity — are rejected.

Board tools are record-only:

- Creating or assigning a task never starts a worker, edits files or runs inference. Assignment is metadata.
- A worker that is a team member can read board records and update only its own task's `progress`, `blockers`, candidate artifact refs and lifecycle state (`in_progress`, `submitted`, `failed`). It cannot set contracts, validations, assignments or acceptance. Board updates grant no filesystem access; per-model write and shell policy still gates every file tool.
- Acceptance is always an explicit coordinator decision. Nothing is accepted automatically, and `accepted` never means integrated: opt-in [coordinator integration](docs/integration.md) publishes only through separate explicit accept and apply decisions.

Lifecycle is `ready → in_progress → submitted → validating → accepted`, plus `failed` and `cancelled`. `submitted` and `validating` await coordinator acceptance; the coordinator advances a task with an explicit update carrying the current expected revision.

Dependencies are typed: a **contract** dependency means the task needs an agreed, versioned interface reference before its work is meaningful; an **artifact** dependency means it needs the output of an accepted producer task, which supplies versioned candidate artifacts. A dependency names only `{taskId, kind}`; it does not pin an artifact version, so consumers resolve versions through the producer's candidates and validations. Agreed contracts and candidate artifacts are versioned refs (`id`, `version`, `uri`, optional `label`). Validation records are **append-only**: each verdict ties an artifact ID and an **exact** candidate version to `passed` or `failed` with an optional note, and verdicts are retained in insertion order. A **distinct** verdict for the same candidate version is appended rather than rewriting an existing one, so a later `failed` supersedes an earlier `passed` for that version; a byte-identical verdict is deduplicated instead of appended twice, even under a new `requestId`. Acceptance therefore needs the **last appended** verdict for each artifact's latest candidate version to be `passed`; a verdict for an older version does not count, and only the coordinator can record one. Recording a validation does not accept the task.

References are keyed by `id` and `version`: recording the same pair again never changes its `uri` or `label`, and a different URI for that pair is rejected. Verdicts are never rewritten either: distinct repeated verdicts for one artifact version are appended in order, byte-identical ones are deduplicated, and an existing verdict and its `resultRef` stay immutable once recorded. Task-scoped candidate, contract, and report `id`+`version` identities (their exact `uri` and `label`) are checked against the current records and against every retained task receipt on open and on commit; contract revocation and task rework clear the active agreements or verdicts without freeing the underlying identity. Any future receipt compaction must preserve that identity history, and a contradictory durable history causes the board to refuse to open without rewriting stored records.

A validation `resultRef` is manual metadata (id, version, and a URI in the full record). Nothing fetches, resolves or executes it, and nothing verifies the referenced artifact contents.

Each canonical workspace root — a folder or a registered Git worktree — has its own board, mirroring the per-root worker stores below. The legacy standalone worker path is unchanged: a worker that is not a team member simply receives no board tools.

Both listings are paged the same way: `subagent_team_list` and `subagent_task_list` accept optional `offset` (default 0) and `limit` (default 20, maximum 20) and answer `{ teams | tasks, nextOffset }`, where `nextOffset` is `null` at the end. The board still returns the whole filtered array to the host; the adapter slices one page, so a full 512-task or 64-team board stays inspectable across a few bounded responses instead of one oversized one — team histories are the largest field, so team listing needs paging too. A page also stops at a 3,000,000-character serialized budget, so it may return fewer than `limit` records: `nextOffset` always advances by exactly what was returned, and a single record that cannot fit fails with `response_too_large` instead of being dropped — read it with `subagent_task_get` or `subagent_team_get`.

The **Task Board** view reads bounded status summaries, not full records: each summary carries ids, title, state, assignment, revision, short progress/description, the first few acceptance criteria, blockers, reference and validation previews with their full counts, every dependency edge by id and kind, and history counts. Reference URIs, full-length text and transition entries are intentionally absent. Clicking a task opens its full record through `codexSubagent.openBoardRecord`, which is where the complete text, history entries and URIs are shown; Codex reads the same full records with `subagent_task_get`/`subagent_team_get` (and the paged list results). Nothing in the view creates, accepts or integrates work.

Capacity is explicit rather than silently evicting: at most 64 teams and 512 tasks per board, 32 members per team, 20 acceptance criteria and 32 dependencies per task, 8 candidate refs, 8 agreed contracts, 16 validations, 16 blockers, and 100 retained history entries per record with `lastSequence`/`trimmed` metadata, so a trimmed history stays visible. Field sizes are bounded too (160-character task titles, 4000-character task descriptions and progress, 500-character criteria and blockers, 2048-character ref URIs, 300-character reasons, 2000-character team descriptions, 64-character request IDs, 32-character 32-hex record IDs). Idempotency records are durable and keyed per actor, request ID and fingerprint; reaching 1000 recorded requests is a capacity error, never silent eviction.

## Team mailbox (opt-in)

The team mailbox is an optional durable message channel for one team. It is off by default, adds no dispatch, acceptance or file authority, and never starts or resumes a worker. Enable the User settings `codexSubagent.taskBoard.enabled` and `codexSubagent.taskBoard.messaging.enabled` (`false` by default). Both are read live from User Settings only, so a repository cannot enable them, and mail requires the board. While mail is off, the three mailbox tools stay discoverable, every call fails with `feature_disabled`, workers receive no mailbox tools and no mailbox storage is opened.

The coordinator tools are `subagent_mailbox_send`, `subagent_mailbox_list` and `subagent_mailbox_ack`. Each takes `ownerId` and the optional `workspaceRoot` exactly like the board tools. Live team members call the same three names with their session identity, so they pass no `ownerId` and stay inside their own root and team, and a governed bound worker also gets `subagent_mailbox_wait`. The coordinator can inspect every retained event of a team it coordinates, while a worker reads only the events it sent or received.

- **Sends.** An original message carries `teamId`, `taskId`, `requestId`, `kind` and `body` of at most 1024 UTF-8 bytes, plus one to four destinations from `recipients` (worker ids) and `toCoordinator: true`. A `replyTo` reply goes to the original sender with no recipient list. Kinds are `question`, `reply`, `interface_proposal`, `interface_response`, `discovery`, `blocker`, `artifact_ready`, `integration_feedback` and `escalation`, and an escalation is addressed only to the team coordinator.
- **Delivery is passive.** Mail is durable before it is offered, it is offered in bounded batches, up to the per-turn budget, only at the normal provider boundaries of a worker that is already running, and it is delivered when the provider emits a part for that prompt and the receipt commits. The bounded block is checkpointed into the worker's transcript once, before that receipt, so a later tool round, resume or turn replays the same body and message id as ordinary history; a receipt that fails is retried when the retained input is presented again. A recipient acknowledges it explicitly with `subagent_mailbox_ack` (up to 12 ids). A stopped worker stays stopped, cancellation and compaction keep pending mail, reload leaves the worker interrupted until you resume it, and nothing is broadcast or answered automatically.
- **References are identity only.** `artifact_ready` names an exact sealed `{id, version, uri}`, evidence names the exact ref the runner returned, and an attempt is `{id, revision}`. A bare URI keeps nothing and repairs nothing, so report an unretained reference instead of resolving it, use the existing retention and composition tools for content, and remember that no message exposes another worker's mutable overlay.
- **Authority stays separate.** An `interface_response` is informational. A real agreement is a `subagent_task_update` agreed-contract record with the expected task revision, and board states, verdicts, attempt acceptance and apply remain their own explicit decisions.
- **Bounds.** Each root holds 200 live events and 1024 request records inside 1 MiB, with standard retention of 7 days. A reply can expire with its parent, and an expired request replay stays refused while its tombstone is retained for up to 14 days.

See [team mailbox](docs/team-mailbox.md) for the wait contract, delivery guarantees and step-7 handoff notes.

## Isolated team file views (opt-in)

Enable both `codexSubagent.taskBoard.enabled` and `codexSubagent.isolatedViews.enabled` in **User Settings** to use immutable shared snapshots with private worker overlays. Capture once, explicitly bind a stopped owned team member, then resume it. Unbound turns retain legacy behavior; bound workers never fall back to live files when their view is unavailable. Bound workers also get bounded private shell once `isolatedViews.runners.enabled` is on; without it `run_command` returns `isolated_shell_unavailable` and the legacy workspace shell is never substituted. See [Isolated runner shell](#isolated-runner-shell-opt-in) and [isolated file views](docs/isolated-views.md).

Workers can seal immutable submissions for review. Later edits leave earlier submissions unchanged; explicit retention pins and cleanup manage their lifetime. Board acceptance still does not imply integration: the opt-in [coordinator integration](docs/integration.md) workflow handles composition, validation and publication explicitly, and board references do not pin stored content automatically. See [isolated file views](docs/isolated-views.md) for tools, capture rules, supported layouts, limits, recovery and consumer obligations, and [isolated runner workspaces](docs/runner-workspaces.md) for the runner shell, its storage and its containment limits.

## Isolated runner shell (opt-in)

Bounded private shell for **bound** isolated workers. It is a separate surface from the legacy workspace shell: unbound legacy workers keep exactly the approval behavior described above and are never upgraded by this stage.

Enable it with the User-level settings `codexSubagent.isolatedViews.runners.enabled` (default `false`), `…runners.capacity` (default 2, 1–8) and `…runners.maxQueue` (default 32, 0–256). Enablement is read live from the global value only, so a repository cannot turn it on. Capacity and queue bounds are resource configuration and apply to the canonical root's runner pool when it reopens. With the flag off, `run_command` on a bound worker returns `isolated_shell_unavailable`, no runner storage or execution is created, and nothing falls back to the legacy workspace shell. Existing runner records, status and cleanup stay readable with the parent view flags enabled; reading state or reconciling does not need approval UI and does not require the execution flag.

- **Requests queue before slot and approval.** A bound worker's command first takes a queue position for its canonical root; a slot is granted from that queue, and only then does the prompt appear. The queue is therefore not a queue of already-approved commands: a denied or cancelled request leaves it without running anything.
- **Slots.** `capacity` slots per canonical root, tracked with the root's `SessionStore` rather than per window. A slot covers the whole lifecycle: setup, awaiting approval, execution, import, cleanup. A quarantined slot keeps consuming physical capacity until an explicit cleanup proves the process drained, so nothing is silently reused.
- **Approval.** The prompt shows the logical project (the approval scope), the physical execution root, the physical working directory, and the exact recorded input revision (snapshot, overlay, revision) as escaped literal text. Grants are separate from legacy ones: a workspace-session grant never approves an isolated request, and an isolated grant never approves a legacy one. An accepted isolated grant covers later isolated commands in the same logical project. Revoking a root clears both kinds and their pending requests; aborting, closing the tab, disposal and revocation stay fail-closed. Relative paths resolve inside the materialized view, absolute OS paths are **not** remapped, and the working directory is **not** an OS sandbox: the shell keeps your account's access.
- **Materialized view.** One coherent snapshot + overlay revision is copied as ordinary files, raw bytes and file modes included (POSIX disk mode, Windows Git index bit; an absent mode defaults to 644). Unsatisfiable entries fail setup instead of being skipped, hard links are not created, and supported changes import back as one atomic step after exit, failure, timeout or cancellation when policy allows. A stale overlay is never overwritten; the runner is retained.
- **Results.** A pending attempt is recorded before execution. A finished command stores an immutable versioned result: id, deterministic URI, command, input version, after version, import status, outcome, exit code, signal, bounded output, drain flag and setup identity (environment hash, platform, shell, runtime, caches). The versioned worker command output returns the full stored result plus its `resultId`, with `timedOut`/`cancelled` compatibility fields. A pending attempt found after reload becomes `uncertain` and is never replayed. Caps: 1024 records, 128 MiB total, 1 MiB per result, 100,000 output characters. Start-time capacity is checked against the pending record only, so a start capacity error refuses execution before it begins; the final record is sized separately at finish, and a final capacity or write failure is never reported as success — the pending attempt and its directory are retained or quarantined and reload as `uncertain`.
- **Caches.** Only dependency **download** caches (`npm`, `pip`) are reused. Installed dependencies, build output and temporary directories are fresh per slot, so a run never inherits another run's tree. Nothing installs automatically or without approval; chain installation and validation inside the one approved command when needed, for example `npm ci && npm test`.
- **Cleanup.** Reconciliation is scope-only (`ownerId` + `teamId`) with no new command and no request id, so repeating it never repeats a command. Discarding retained, unimported physical changes needs proof that the owned process drained; unknown or unverified identities stay quarantined and are reported. The tool carries a `destructiveHint` annotation so clients can warn before calling it, which adds no separate approval step.
- **Shutdown.** Closing the manager may wait for unsettled runner I/O instead of releasing the store owner lock early.

| MCP tool | Purpose |
| --- | --- |
| `subagent_runner_status` | `ownerId`, `teamId`, `kind: "leases" \| "queue" \| "results"` (default `leases`), paged at 20. Returns the scoped page plus a summary (`enabled`, `open`, `capacity`, `maxQueue`, counts of active/quarantined leases, queue length, results and pending attempts) and `nextOffset` |
| `subagent_runner_result` | `ownerId`, `teamId`, one 32-hex `id`. Returns the full immutable version 1 result and URI, its `version`, plus derived `currentRevision`, `inputIsCurrent` and `stale`; these freshness fields are `null` when the current index is unloaded, released, missing or corrupt, and reading a result never rewrites the evidence |
| `subagent_runner_cleanup` | `ownerId`, `teamId`. Natural scope reconciliation, annotated as destructive; recovers only confirmed owned process identity and retains unknown state |

Status rows for your own scope include the owner `workerId`, `workerCreatedAt` and the result URI, and lease rows add `createdAt` for when that lease was created rather than when the worker was. Result summaries are limited to output and diagnostic previews (512 characters) rather than full output; read one result with `subagent_runner_result` when you need it. Counts and previews are bounded, and other identities are never shown.

A stored command result is evidence, not an artifact pin and not an automatic board verdict: nothing is accepted or integrated, and no later revision is validated because an earlier command ran. Input revisions are exact and an imported change produces a new revision that no command has tested until one runs.

## Governed isolated startup (opt-in)

Step 4 adds `subagent_isolated_spawn`: create a stopped worker, atomically establish team membership/task assignment, bind its private snapshot, then start its first turn. Enable User `resources.enabled` with the board/view flags. Retry interrupted setup with the same request and arguments; ordinary send/resume cannot bypass incomplete setup.

Separate aggregate model, runnable, runner and storage budgets cover governed work across roots, worktrees, stores and extension hosts for this OS user. Fair queues yield resources during dependency/message/runner waits and reserve validation/integration headroom. Existing owning-store model ceilings, runner pool reopen settings and legacy spawn behavior remain explicit.

Owner-scoped receipt epochs, compressed archives, exact evidence pins and reference-aware collection reclaim metadata without turning expired requests into fresh operations. See [resource governance and lifecycle](docs/resource-governance.md) for configuration, tools, retention limits and recovery. Step-5 [coordinator integration](docs/integration.md) composes exact sealed sources, validates one candidate and publishes only an accepted result.

## Preservation and workspaces

Sessions, operation keys, and tool results are checkpointed in extension storage. Partial text is saved roughly once per second as chunks arrive and on handled failures. A crash can lose the latest uncheckpointed text; unfinished streams are never considered completed. Every Session is stored in the one current format: schema 3 with an explicit `mode` of `standalone`, `isolated` or `governed`, derived by the host (a plain spawn is standalone, a bound private worker is isolated, a create-bind-start worker is governed) and never chosen by a request. There is no default and no old-format reader: a schema-1 or schema-2 record, a schema-3 record without a mode, or an unknown mode is reported as malformed, left byte-for-byte in place with a diagnostic copy under `quarantine/`, and its ID stays fenced so an old request cannot overwrite it or replay its effects.

A durable started record precedes effects. Missing results are sealed as outcome-uncertain, never blindly replayed. Transient failures before any response part receive bounded retries; other errors remain visible for deliberate recovery. Reloaded active work becomes interrupted and resumes explicitly.

Before context/history limits, the worker model summarizes history and the engine writes an immutable archive before reducing active history. Full messages, turn results and prior attempts remain accessible. Summary failure retains the original history. Corrupt files are copied to quarantine, their IDs remain reserved, and retry cannot overwrite them.

Each canonical folder has its own store, tools and bridge owner. Single-folder and multi-folder windows share that owner even when their folder sets overlap; a surviving window can take over after the owner closes. During handoff, requests may return a retryable `host_stopping` or `host_reconnecting` error; retry mutations with the same request key. Registered Git worktrees receive isolated roots/stores on demand without another window; arbitrary sibling folders are rejected. Folder additions, reordering, single-folder conversion and workspace Save As preserve workers across extension-host restarts. Pass the returned `workspaceRoot` on subsequent MCP controls. Tools stay inside that worker’s folder. Removing a nested folder preserves its separate history rather than routing its workers into the containing folder’s store.

Older grouped stores migrate automatically, retaining worker IDs, request keys, archives and snapshots. Copies are committed before their old checkpoint is removed; interrupted migrations can continue on the next activation. An older extension host still owning a store must be reloaded before migration can finish. Removed folders retain readable/exportable/deletable history in their saved workspace; restore the folder before continuing work or generating a history summary.

Worktrees used by a workspace are remembered before delegation. Removing a worktree stops its active workers and retains their history across reloads, while other roots continue refreshing. Recreating the worktree at the same path restores access to its saved workers for explicit continuation.

The owning window supplies model access and editor buffers. Save unsaved changes in other windows before delegating edits; those buffers are not inherited across editor processes.

Limits include 200,000 output characters per turn, approximately 20 MB of active history before rollover, and 200 retained workers per store. Archives are retained until explicit cleanup. Transcripts and snapshots contain local plaintext task/file content; diagnostics shows their location. Codex and the extension must share a local/remote environment; registry routing does not cross machines. VS Code must stay open to supply its model API.

## Development and release

Development and CI use Node.js 22 or newer (`vsce` requires Node 22+). For local development, run `npm ci`, then press **F5** to launch the extension from source.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:host
npm run vsix
```

The VSIX bundles extension, relay and dependencies. It uses VS Code's Node runtime with no startup downloads. Minimum editor version: 1.104. `npm run vsix` produces a version-derived filename, `codex-subagent-<version>.vsix`.

Portable tests use fake models, temporary stores, real stdio MCP clients and temporary Git worktrees. Loopback tests need permission to bind a local port. `npm run test:host` launches an installed VS Code in isolated temporary profiles to exercise actual activation, diagnostics, MCP handshake, native undo, and dirty buffers. Set `VSCODE_EXECUTABLE` for a non-default installation. Neither suite starts an LLM or uses live credentials.

For live acceptance: enable your model, delegate a read-only task, send a follow-up, review a disposable edit, and reload during a task before resuming it. Use diagnostics if discovery, consent, or tool replay fails.

CI (`.github/workflows/ci.yml`) runs on pushes to `main` (including merged pull requests), opened/updated/reopened pull requests targeting `main`, and manual dispatch: it installs dependencies with `npm ci`, then runs typecheck, lint, the portable test suite, and `npm run vsix`. Tags alone do not auto-trigger CI; when you manually dispatch on a release tag (`gh workflow run ci.yml --ref v<version>`), the run fails unless the tag is exactly `v` plus the `package.json` version, matching the release tag policy. The resulting `codex-subagent-*.vsix` is uploaded as a 14-day artifact. CI builds and checks only; it never publishes.

Publishing is manual and happens after validation:

1. Update the `package.json` and `package-lock.json` versions with `npm version <version> --no-git-tag-version`.
2. Run the local validation and host checks above, plus a live smoke test in your own VS Code window.
3. Merge the version change into `main` (via pull request) and tag that `main` commit with `v<version>`.
4. Wait for the successful `main` CI run for that tagged commit and download its VSIX artifact. If you need to rebuild the release artifact, manually dispatch at the tag instead (`gh workflow run ci.yml --ref v<version>`).
5. Upload **that tested artifact** to the VS Code Marketplace at https://marketplace.visualstudio.com/manage under the publisher ID `xisui-pa`.

Do not bump the version after validation or rebuild a different artifact after CI; publish exactly the VSIX CI tested and uploaded.

## Support and license

- Report issues: [GitHub Issues](https://github.com/xisui-PA/codex_subagent/issues)
- License: [MIT](LICENSE)

See [architecture notes](docs/design.md), [team mailbox](docs/team-mailbox.md), [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), and [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model).
