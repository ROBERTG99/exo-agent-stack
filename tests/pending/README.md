# Pending tests

Tests written first for a task that is blocked. They are outside every Vitest project, so they do not
run and cannot turn the build red. Move each one into its real folder when its task is unblocked.

- `exo-pin.test.ts` → `tests/harness/` when T-02 (the `vendor/exo` submodule) is unblocked; see "Needs the maintainer" in `PROGRESS.md`.
