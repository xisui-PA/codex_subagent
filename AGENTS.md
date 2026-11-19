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
