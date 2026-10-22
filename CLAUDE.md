# Claude instructions

<!-- BEGIN VIBEGUARD -->
## VibeGuard

This project uses the local VibeGuard quality gate. Read `AGENTS.md` and `.vibeguard/agent-protocol.md` before coding.

Work one task at a time through MCP tools: `vibeguard_get_next_task` -> `vibeguard_get_context` -> `vibeguard_start_task` -> implement -> `vibeguard_verify_task` -> `vibeguard_record_evidence` -> `vibeguard_complete_task`. Before changing a shared module, use `vibeguard_graph_impact` to inspect dependents and tests.

If `checkpoint.needed` is true, stop and ask the human to test before continuing. Never complete a task without a passing, fresh verification and evidence for every acceptance criterion. Commit after completing, not before.
<!-- END VIBEGUARD -->
