---
name: eval-report
description: Regenerates evals/REPORT.md from the latest run and checks it against the BUILD.md §11 thresholds. Use after any change that can move an eval metric.
---

# Eval report

1. Run `make eval` (offline suites). Real-mode suites (`make eval-durability`, `make eval-delegation`) only where the pinned Exo builds.
2. Confirm `evals/REPORT.md` was written by the script (mode, Exo commit, dataset hashes) and `uv run evalgate check` accepts the report.
3. Compare each metric with its threshold in the spec §11. A miss is fixed in code or recorded in `docs/KNOWN_LIMITATIONS.md`; never relax a threshold.
4. Ask the `eval-analyst` subagent to cluster failures when more than one case fails.
5. The report must say live evals were not run unless the maintainer ran `make eval-live`.
