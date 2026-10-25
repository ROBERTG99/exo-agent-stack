**Decision order (stop at the first match):**
1. The task takes fewer than 3 tool calls: do it in the main session.
2. It reads a lot and returns little (more than about 5 files or 20k tokens of reading): `Explore` (`haiku`, `low`), ask for a summary of at most 15 lines with file paths.
3. It is several independent tasks with no shared files: run subagents in parallel, one per task, each with a disjoint file list.
4. It is mechanical, with a spec and a check that verifies it (test, linter, type checker): `mechanic` (`haiku`, `low`).
5. It reviews work already done: `reviewer` or the project-specific reviewer (`opus`, `high`), read-only, verdict "ship" or "fix first" with evidence.
6. The same check failed twice: escalate the model following the escalation ladder. Do not repeat the same attempt.

**Use a subagent for:** isolating context (reading and searching), parallel independent work, routing by model and cost, independent verification, and least privilege (read-only agents for audits and for any untrusted content such as web pages, tickets or external PRs).

**Do not use a subagent when:** the task is small; it depends on conversation context the subagent lacks; it needs to ask the maintainer something; each step depends on the exact output of the previous one; or two agents would edit the same file.

**Brief every subagent with:** the goal and the expected output format, the files in scope, what was already tried or ruled out, and the check that proves it is done. A subagent starts with no context.

**Guardrails:**
- Haiku only for tasks whose result a test or linter verifies. If in doubt, go one level up, not down.
- Opus for anything where an error is costly to detect: security, concurrency, data migrations, public contracts, architecture.
- Reviews run at each milestone and before publishing, not on every commit and not on trivial changes. Reviewers report correctness and security problems, not style preferences.
- Never run more than 4 subagents at once. Parallel work costs roughly 2 to 4 times the tokens of sequential work, so parallelize only tasks that take more than about 5 minutes.
- Subagents never edit files outside their scope and never commit; the main session integrates and commits.
- Log every `opus` and `fable` delegation in the "Model usage" table in `PROGRESS.md`.
