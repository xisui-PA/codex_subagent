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

A successful test lists all 13 tools and returns `ready: true` from `subagent_health`, with the expected workspace root and enabled model. This confirms that Codex can call the worker host; it does not perform model inference. If the test still fails after a window reload, run **Codex Subagent: Check MCP Connection**, then inspect **Codex Subagent: Show Diagnostics** and **Codex Subagent: Show Log** for the failure details.

Reloading the window interrupts active workers. After reloading, inspect them in **Codex Workers** and use **Resume** explicitly to continue unfinished work.

**Check MCP Connection** repeats the handshake independently. It verifies the MCP server and host, not whether an existing Codex conversation has refreshed its tools. **Show Diagnostics**, **Show Log**, and **Retry Worker Host** remain available after startup failures and in an empty window.

Registration adds a managed entry to `$CODEX_HOME/config.toml` or `~/.codex/config.toml`. It preserves unrelated content and config symlinks; the backup is beside the actual config target. The relay is copied into stable extension storage and refreshed after updates. Existing managed registrations are repaired on activation; new registrations require setup. **Unregister MCP from Codex** removes the entry and retains transcripts.

## Data and privacy

Worker requests flow through VS Code's Language Model API to the provider you selected. Task text, file contents, tool results, and message history can be sent to that provider, whose privacy and data policies apply.

Transcripts, change snapshots, and archives are stored in plaintext in extension storage on the extension host's filesystem (on the remote host for remote workspaces) and are retained until you clean them up. **Show Diagnostics** shows their storage location; **Export Transcript** and **Clean Up Saved Workers** export or delete them. Model credentials remain managed by VS Code; this extension does not read, store, or transmit them.

## Worker experience

The Activity Bar's **Codex Subagent** view container holds the **Codex Workers** and **Models** views. The workers view groups workers by parent conversation and workspace root. Click a worker for its live conversation panel: output, current activity, recent tools, errors, changed files, and recovery actions. Completion/failure notifications link back to the worker.

The **Models** view shows the strict User-settings `codexSubagent.models` pool in insertion/priority order, without needing a worker host or a trusted workspace. Expanding a model shows its effective policy (`allowWrite`, `allowShell`, `numSessions`, `maxToolRounds`, `turnTimeoutSeconds`, `autoCompact`) with built-in defaults (true/true/1/40/600/true) flagged as `default`, plus its `modelOptions` entries as readable JSON. Title actions offer **Enable Model**, **Configure Model Options**, and **Open Model Settings** (scoped to `codexSubagent.models` in User Settings); clicking a model configures its options. A malformed setting shows a visible error row that opens the settings; an empty pool shows Enable Model / Open User Settings guidance. The view refreshes on `codexSubagent` configuration changes.

- **New Worker** starts a task directly from VS Code.
- **Send Follow-up** queues a message behind the active turn.
- Panel drafts and unacknowledged follow-ups/resumptions are saved in extension state. **Retry pending request** reuses the original request key and arguments, including after reopening a panel or reloading VS Code. The draft clears only after acknowledgement. **Clear retry record** keeps the draft and does not cancel accepted work.
- **Cancel** stops generation and suspends queued messages. The worker remains busy until in-flight edits and command termination have settled.
- **Resume** continues failed, cancelled, or interrupted workers from their saved conversation: choose an eligible model and optional steering instructions. A completed worker whose model was removed or restricted can also be recovered: choose a replacement model and leave the message empty to switch the model only (no inference and no replay), or add text to queue exactly one follow-up turn that preserves the earlier turns.
- **Discard Queued Messages** prevents unstarted messages from executing while retaining their records.
- **Compact Worker** generates a summary or accepts a manual one.
- **Export Transcript** saves the conversation and archival history. **Clean Up Saved Workers** supports bulk deletion. Deletion removes archives, change snapshots, and operation keys too.
- **Browse Saved Workspaces** reveals other saved transcript stores.

Review before/after diffs and revert individual changes in the panel. Revert checks current content and refuses to overwrite later user edits. Worker edits use WorkspaceEdit and native editor undo. Already-dirty buffers are readable/editable and stay unsaved; previously clean files are saved. Returned hashes and change snapshots include formatting and other save participants. Shell commands see disk contents, so save dirty buffers before validation.

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

- `numSessions` bounds **active** conversations for that model inside its owning workspace/store. Omit it for the built-in default of 1.
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

Removed global settings (`allowWrites`, `allowShell`, `maxConcurrentWorkers`, `maxToolRounds`, `turnTimeoutSeconds`, `autoCompact`, `modelOptions`, `modelProfiles`) are ignored if still present in user settings; configure their per-model equivalents under `models` (provider request options go in each entry's nested `modelOptions`).

## Permissions and editing

Read-only is the default. For code changes, configure a model in `codexSubagent.models` with `allowWrite` true (or omitted) in **User Settings** and request `permission: "workspace-write"` when spawning. Spawn rejects that permission when the selected model policy or write tool is unavailable. `subagent_health` reports effective tools before delegation.

Tools include paginated UTF-8 reads, directory listing/creation, bounded literal search, hash-checked writes, exact-text patches, rename, and delete. Changes have recoverable before/after snapshots. Stale hashes, symlink paths, hard-linked replacements, and writes to `.git`, `.codex`, or `.vscode` are rejected. Missing parent directories can be created in order. These checks are not an OS filesystem sandbox against arbitrary concurrent external processes.

A per-model `allowShell` policy in `codexSubagent.models` (default true when omitted, or false to restrict) may offer shell execution to workspace-write workers. Commands without an active session grant open a scrollable **Review Worker Command** tab showing the full command and working directory with **Run once**, **Allow for this workspace session**, and **Cancel** controls; closing the tab or pressing Escape denies it. A workspace-session grant covers all workers in the same canonical workspace/worktree for this VS Code window, including commands already waiting there, but other workspace/worktree roots need separate grants. The grant is memory only: it ends on window reload/restart or when you run **Revoke Shell Approval**, which also targets one root or all roots and does not terminate running commands (use **Cancel Worker** for that). Commands run with the extension host's OS access, outside Codex's sandbox. Time/output are bounded. POSIX cancellation and deadlines terminate the process group, retaining the forced-kill grace period even if the shell exits first; Windows cancellation targets the direct process. Repository settings cannot grant write/shell access.

## Parent ownership and lifecycle

Give each conversation a unique `ownerId` and optional readable `ownerLabel`. Spawn/send/resume use distinct `requestId` values. **Retry ambiguous transport results with the SAME key and arguments** to recover accepted work. Keys are scoped to the owner when supplied. Mutating controls must pass the worker's ownerId. The VS Code panel can administer all groups; ownership is a coordination boundary, not OS-user authentication.

Default `parentPolicy: "keep"` preserves work across disconnects. For unattended cancellation, use `parentPolicy: "cancel-on-expiry"` and a `leaseSeconds` value. Renew with `subagent_parent` / `action: "heartbeat"`; explicitly cancel a group using `action: "stop"`. Leases are checked about every five seconds. The relay emits MCP logging notifications for tracked workers that stop; clients may display these without injecting them into model context, so polling remains available.

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

Status supports `outputOffset`/`outputLimit`, `turnId`/`attempt`, and `afterMessage`/`messageLimit`. History offsets stay continuous across rollovers. Supply context explicitly: workers do not inherit hidden parent conversation, native tools, skills, or approvals.

To target a registered worktree from a Codex conversation rooted in the main checkout, pass its absolute `workspaceRoot`. Keep the returned root on subsequent controls, and group wait IDs by root. The server verifies that roots are open workspace folders or registered worktrees; arbitrary sibling folders are rejected. This also handles worktrees nested inside the main checkout.

Model-generated manual compaction returns immediately as cancellable background maintenance. Wait for it to stop before resuming or sending another message to that worker; unrelated workers remain responsive.

## Preservation and workspaces

Sessions, operation keys, and tool results are checkpointed in extension storage. Partial text is saved roughly once per second as chunks arrive and on handled failures. A crash can lose the latest uncheckpointed text; unfinished streams are never considered completed.

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

See [architecture notes](docs/design.md), [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), and [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model).
