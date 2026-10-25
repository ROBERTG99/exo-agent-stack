---
name: add-agent-definition
description: Adds or changes an Exo agent definition in agents/ and keeps lint, render and sync consistent. Use for any agents/*.md change.
---

# Add an agent definition

1. Failing test first in `tests/unit/agents/` (catalogue and lint cases: unknown key, Cursor `always_ask`, `use_sender_vault`).
2. Write `agents/<name>.md` per spec §4.5: relative paths resolve from the Markdown file; the body ends with the untrusted-content paragraph; no `use_sender_vault`; Cursor-harness agents use `always_allow`.
3. Add its allowlist to `environments/allowlists.yaml` if it uses `smolvm-default`.
4. `make agents-lint`, `make agents-render` (deterministic), `make agents-sync` (second run reports unchanged).
5. Verify any new frontmatter field against `vendor/exo` and record it in `docs/exo-verification.md`.
