# Agent instructions

<!-- BEGIN VIBEGUARD -->
## VibeGuard quality gate (local)

This repo uses VibeGuard. Planning documents and verification are local; there is no billing or telemetry.

Follow this loop exactly:

1. `vibeguard_get_next_task` — take **one** task. If `checkpoint.needed` is true, STOP and ask the human to test the previous work. Do not start it until they approve.
2. `vibeguard_get_context` — read the spec, the listed conventions, and the relevant files before editing.
3. `vibeguard_start_task` — start the task. Use `acknowledgeCheckpoint: true` only after explicit human approval.
4. Implement **only** that task. Stay inside its `files` scope. Follow existing patterns; do not add duplicate libraries or abstractions.
5. `vibeguard_verify_task` — run the real checks. Fix failures. Never fabricate output or weaken a check.
6. `vibeguard_complete_task` — only after verification passes. Then commit. Stop at checkpoints.

Rules:
- Never implement from a chat plan alone. The spec at `.vibeguard/spec.md` is the source of truth.
- Never add a task without acceptance criteria.
- Never mark a task complete without fresh passing verification.
- Do not edit `.vibeguard/spec.md`, `tasks.json`, or logs to force a pass.

CLI fallback: `vibeguard task next`, `vibeguard context <id>`, `vibeguard task start <id>`, `vibeguard task verify <id>`, `vibeguard task done <id>`.
Full protocol: `.vibeguard/agent-protocol.md`.
<!-- END VIBEGUARD -->
