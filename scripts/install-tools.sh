#!/usr/bin/env bash
# Idempotent installer for the lint/security CLIs the Makefile uses (BUILD.md §1.2).
# Installs only what is missing. INSTALL_TOOLS_DRY_RUN=1 prints what would be done.
# Network access is needed only for tools that are missing.
set -euo pipefail

DRY="${INSTALL_TOOLS_DRY_RUN:-0}"
BIN_DIR="${INSTALL_TOOLS_BIN_DIR:-$HOME/.local/bin}"

have() { command -v "$1" >/dev/null 2>&1; }
log() { printf '%s\n' "$*"; }

run() {
  if [ "$DRY" = "1" ]; then log "would run: $*"; else "$@"; fi
}

install_go_tool() { # name, module
  local name="$1" module="$2"
  if have "$name"; then log "ok: $name"; return; fi
  if have go; then
    run env GOBIN="$BIN_DIR" go install "$module@latest"
  else
    log "missing: $name (needs Go: go install $module@latest)"; MISSING=1
  fi
}

install_brew_or_note() { # name, brew formula, release page
  local name="$1" formula="$2" page="$3"
  if have "$name"; then log "ok: $name"; return; fi
  if [ "$(uname -s)" = "Darwin" ] && have brew; then
    run brew install "$formula"
  else
    log "missing: $name (install from $page into $BIN_DIR)"; MISSING=1
  fi
}

MISSING=0
mkdir -p "$BIN_DIR" 2>/dev/null || true

install_go_tool actionlint github.com/rhysd/actionlint/cmd/actionlint
install_go_tool gitleaks github.com/zricethezav/gitleaks/v8
install_brew_or_note hadolint hadolint https://github.com/hadolint/hadolint/releases
install_brew_or_note trivy trivy https://github.com/aquasecurity/trivy/releases
install_brew_or_note syft syft https://github.com/anchore/syft/releases

if have pre-commit; then
  log "ok: pre-commit"
elif have uv; then
  run uv tool install pre-commit
else
  log "missing: pre-commit (needs uv: uv tool install pre-commit)"; MISSING=1
fi

if [ "$MISSING" = "1" ]; then
  log "some tools could not be installed automatically; see messages above"
  [ "$DRY" = "1" ] || exit 1
fi
log "tools ready"
