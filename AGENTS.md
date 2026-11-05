# AGENTS.md

Use the parent Codex model as the lead for design, planning,
coordination, and review.

Delegate implementation, documentation edits, document summarization,
and test execution to workers through the codex_subagent MCP tools,
including small edits. Do not substitute native Codex subagents.

Check subagent_health and subagent_models before delegation.
Give workers explicit context and acceptance criteria. Review their
changes and test results before reporting completion.

If delegation is unavailable or repeatedly fails, explain the blocker
and ask before doing implementation directly.
