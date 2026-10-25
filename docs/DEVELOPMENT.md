# Development environment

Recorded by T-01 on 2026-10-25 from commands run on the maintainer's machine. Re-run the probes below after a toolchain change.

## Environment

| Item | Value | Probe |
|---|---|---|
| Mode | local run (`CLAUDE_CODE_REMOTE` unset) | `env` |
| OS / architecture | Darwin 27.0.0, arm64 | `uname -srm` |
| `/dev/kvm` | absent (macOS), so SmolVM/Firecracker are host-dependent | `ls /dev/kvm` |
| node | v22.16.0 | `node --version` |
| pnpm | 10.28.0 | `pnpm --version` |
| uv | 0.11.8 | `uv --version` |
| cargo / rustc | 1.98.1 | `cargo --version` |
| docker | client 28.0.1, server 29.9.2 | `docker version` |
| claude | 2.1.212 (`/opt/homebrew/bin/claude`; the interactive shell wraps it in a `claude-auto-retry` function, so call the binary directly) | `/opt/homebrew/bin/claude --version` |
| go | go1.26.5 darwin/arm64 | `go version` |
| python3 | 3.14.6 (evalgate uses uv-managed Python >= 3.12) | `python3 --version` |
| git | 2.55.0 | `git --version` |
| make | GNU Make 3.81 (macOS default; Makefile stays 3.81 compatible) | `make --version` |

## Lint and security CLIs already installed

actionlint 1.7.12, gitleaks 8.30.1, hadolint 2.15.1, trivy 0.76.0, syft 1.54.1, pre-commit 4.7.0. `scripts/install-tools.sh` (T-03) only installs what is missing.

## Layout choices

- `PROGRESS.md` is at the repository root, decisions in `docs/DECISIONS.md`, ADRs in `docs/adr/`.
- The repository lives at `~/dev/exo-agent-stack` (local disk). The Google Drive copy is not used.
- The maintainer's personal playbook conventions (`_meta/`, `/retomar`) are intentionally not used; BUILD.md wins.
