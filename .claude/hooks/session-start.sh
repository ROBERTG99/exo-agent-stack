#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web only (CLAUDE_CODE_REMOTE=true), BUILD.md Appendix A.
# Idempotent: every step checks whether it is already done. Locally this script does nothing.
# SESSION_START_DRY_RUN=1 prints the steps instead of running them (used by tests).
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

DRY="${SESSION_START_DRY_RUN:-0}"
project="${CLAUDE_PROJECT_DIR:-$(pwd)}"

step() {
  if [ "$DRY" = "1" ]; then
    printf 'step: %s\n' "$*"
  else
    printf 'session-start: %s\n' "$*" >&2
  fi
}

run() {
  if [ "$DRY" = "1" ]; then printf 'run: %s\n' "$*"; else "$@"; fi
}

# 1. Docker daemon with the gcr mirror (Docker Hub direct pulls return 429 on the default policy).
step "start dockerd with registry mirror mirror.gcr.io"
if [ "$DRY" = "1" ] || ! docker info >/dev/null 2>&1; then
  run mkdir -p /etc/docker
  if [ "$DRY" = "1" ]; then
    echo 'run: write /etc/docker/daemon.json {"registry-mirrors":["https://mirror.gcr.io"]}'
    echo "run: nohup dockerd > /tmp/dockerd.log 2>&1 &"
  else
    echo '{"registry-mirrors":["https://mirror.gcr.io"]}' >/etc/docker/daemon.json
    (nohup dockerd >/tmp/dockerd.log 2>&1 &)
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
fi

# 2. Lint and security CLIs (only the missing ones are installed).
step "install missing tools via scripts/install-tools.sh"
run "$project/scripts/install-tools.sh"

# 3. Dependencies.
step "pnpm install --frozen-lockfile"
if [ "$DRY" = "1" ]; then
  echo "run: pnpm install --frozen-lockfile"
else
  (cd "$project" && pnpm install --frozen-lockfile) >&2 || true
fi

step "uv sync"
if [ "$DRY" = "1" ]; then echo "run: uv sync"; else (cd "$project" && uv sync) >&2 || true; fi

# 4. Playwright uses the preinstalled Chromium; never run `playwright install`.
step "PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers (preinstalled Chromium)"

exit 0
