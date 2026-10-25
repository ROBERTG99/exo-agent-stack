---
name: tdd
description: Test-first workflow for every task in exo-agent-stack: write the failing test, implement, run area checks, record evidence, commit. Use at the start of any task in PROGRESS.md.
---

# Test-first task loop

1. Open the task in `PROGRESS.md` and the spec (`docs/specs/000-build-spec.md` §8) for its files, "Test first" and "Done when".
2. Write the named test first. Run it and confirm it fails for the right reason (`pnpm exec vitest run --project unit <file>`).
3. Implement the smallest change that passes. Do not weaken the test or skip it.
4. Run the area checks from "Done when", then `make check-fast`.
5. Record evidence in `PROGRESS.md` (command and a one-line result), update `docs/DECISIONS.md` for any choice made, mark the task `done`.
6. Commit with a Conventional Commit and explicit paths (never `git add .`). No attribution trailers.
7. If the same check fails twice in a row, follow the escalation ladder in `.claude/rules/subagents.md`; do not repeat the same attempt.
