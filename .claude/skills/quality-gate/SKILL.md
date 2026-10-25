---
name: quality-gate
description: Runs the project's quality gates in order and reports results: lint, typecheck, unit, integration, contract, security, evals, doctor. Use before declaring a task or milestone done.
---

# Quality gate

Run, in order, stopping at the first failure and fixing the cause (never the check):

1. `make check-fast` (lint + unit, < 60 s).
2. `make typecheck`.
3. `make test` (adds integration and contract).
4. `make security` once it exists (T-46), then `make eval` and `make doctor` once they exist.

At milestone end also run the `reviewer` and `policy-guardian` subagents over the milestone diff and fix their blockers. Report the exact commands and results in `PROGRESS.md`; never paraphrase a failure as a pass.
