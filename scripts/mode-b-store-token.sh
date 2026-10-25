#!/usr/bin/env bash
# Maintainer-only (never run by the build agent or CI): store a Claude Code setup-token for Mode B.
#
#   1. In your own terminal, sign in to Claude Code as usual, then run:   claude setup-token
#   2. Run this script and paste the token when asked (hidden), or pipe it in.
#
# The token goes into vault `personal` as secret `claude-oauth`, bound to https://api.anthropic.com,
# so the sandbox only ever holds a placeholder (docs/modes.md). Anthropic API keys are refused: this
# stack runs on subscriptions only.
set -euo pipefail
# shellcheck source=scripts/lib/vault-store.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/vault-store.sh"

usage() {
  cat <<'EOF'
usage: scripts/mode-b-store-token.sh [--dry-run]

Stores the output of `claude setup-token` in vault `personal` as `claude-oauth`.
Run `claude setup-token` yourself first; this script never signs in and never runs it.
  --dry-run   validate the token and print what would be run, without calling exo
Environment: EXOS_EXO_BIN (default: exo), EXOS_EXO_ROOT (default: $EXOS_STATE_DIR/exo)
EOF
}

refuse_in_ci
parse_args "$@"
read_secret "Paste the setup-token (input hidden): "

case "$SECRET_VALUE" in
  sk-ant-api*)
    die 2 "That looks like an Anthropic API key. This stack never uses API keys; use the setup-token printed by 'claude setup-token'."
    ;;
esac
if ! [[ "$SECRET_VALUE" =~ ^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}$ ]]; then
  die 2 "That is not a Claude setup-token (expected one line starting with sk-ant-oat, as printed by 'claude setup-token')."
fi

store_secret personal claude-oauth https://api.anthropic.com
