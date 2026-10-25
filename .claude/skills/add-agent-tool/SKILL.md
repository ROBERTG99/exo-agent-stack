---
name: add-agent-tool
description: Adds a custom Exo tool (tools/*.ts) with schema, tests and agent wiring. Use for run_checks/write_report/ask_user-style tools.
---

# Add an agent tool

1. Failing test first in `tests/unit/tools/`: input schema (no extra properties, size limits), output shape, side effects, idempotency by `tool_call_id`.
2. Implement in `tools/<name>.ts` with `defineTool`; verify the `defineTool` shape against the pinned source and record it in `docs/exo-verification.md`.
3. Reference it from the relevant `agents/*.md` `tools:` list (path relative to the Markdown file) and run `make agents-lint`.
4. Add the row to the product-tools table in `docs/delegation.md`.
