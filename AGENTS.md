# AGENTS.md

Use the parent Codex model as the lead for design, planning,
coordination, and review.

The coordinator may make simple, low-risk changes directly and run the
checks needed to verify them. Delegate more involved implementation,
documentation edits, document summarization, and test execution to workers
through the codex_subagent MCP tools. Do not substitute native Codex
subagents.

Check subagent_health and subagent_models before delegation.
Give workers explicit context and acceptance criteria. Review their
changes and test results before reporting completion.

Size tasks conservatively using model metadata and observed performance.
Prefer one bounded, reviewable outcome per task; resolve uncertain
prerequisites first. Keep context focused, compacting or starting a fresh
session when history grows. Increase scope after successful comparable work.

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

If delegation is unavailable or repeatedly fails, explain the blocker
and ask before directly taking on nontrivial work.

Respect explicit worker-model restrictions. A worker-model failure should
first lead to diagnosing the cause, retrying, or reducing the task scope.
Before completely abandoning or replacing a worker model for the remaining
work, explain the observed failures and the proposed model change, then ask
the user for approval. The mere availability of another model, or a single
failed turn, is not approval to abandon the current model.
