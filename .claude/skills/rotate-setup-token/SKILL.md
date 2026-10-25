---
name: rotate-setup-token
description: Prepares the maintainer's steps to rotate or revoke the Claude setup-token (Mode B). Never executes sign-in or token commands itself.
---

# Rotate the setup-token

The agent never runs `claude setup-token`, `claude login` or `exo vault secret ...`: it only prepares instructions for the maintainer and checks the result.

1. Maintainer revokes the old token in their Claude account settings.
2. Maintainer runs `claude setup-token` in their own terminal, then `scripts/mode-b-store-token.sh` (rejects `sk-ant-api` keys; supports `--dry-run`), which stores the token in vault `personal` as `claude-oauth`.
3. Agent-side verification only: `exos doctor` checks D-06/D-14 (secret name, origin `https://api.anthropic.com`, SmolVM/Firecracker or `unsupported`) from vault metadata, never values.
4. Update `docs/runbook.md` if the procedure changed.
