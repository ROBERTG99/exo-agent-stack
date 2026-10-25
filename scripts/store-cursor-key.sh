#!/usr/bin/env bash
# Maintainer-only (never run by the build agent or CI): store a Cursor user key.
#
#   1. Create a user key in your own Cursor account.
#   2. Set EXOS_CURSOR_ORIGIN to the https origin of the Cursor SDK host, as listed in the pinned
#      exoharness/typescript/cursor/sdk.ts (docs/exo-verification.md records it).
#   3. Run this script and paste the key when asked (hidden), or pipe it in.
#
# The key goes into vault `personal` as secret `cursor`, bound to that origin only. Keys of other
# providers are refused.
set -euo pipefail
# shellcheck source=scripts/lib/vault-store.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/vault-store.sh"

usage() {
  cat <<'EOF'
usage: EXOS_CURSOR_ORIGIN=https://<cursor-sdk-host> scripts/store-cursor-key.sh [--dry-run]

Stores a Cursor user key in vault `personal` as `cursor`, bound to EXOS_CURSOR_ORIGIN.
  --dry-run   validate the input and print what would be run, without calling exo
Environment: EXOS_EXO_BIN (default: exo), EXOS_EXO_ROOT (default: $EXOS_STATE_DIR/exo)
EOF
}

refuse_in_ci
parse_args "$@"

origin="${EXOS_CURSOR_ORIGIN:-}"
if [ -z "$origin" ]; then
  die 2 "Set EXOS_CURSOR_ORIGIN to the Cursor SDK host origin (https://host) from the pinned exoharness/typescript/cursor/sdk.ts."
fi
if ! [[ "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  die 2 "EXOS_CURSOR_ORIGIN must look like https://host or https://host:port (no path, no query)."
fi

read_secret "Paste the Cursor user key (input hidden): "

# Other providers' keys, matched by prefix. The prefixes are assembled so this file holds no
# key-shaped literal.
prefix_openai="sk-""proj-"
prefix_openrouter="sk-""or-v1-"
case "$SECRET_VALUE" in
  sk-ant-* | "$prefix_openai"* | "$prefix_openrouter"*)
    die 2 "That looks like an Anthropic, OpenAI or OpenRouter credential, not a Cursor user key. This stack never uses API keys of other providers."
    ;;
esac
if ! [[ "$SECRET_VALUE" =~ ^[A-Za-z0-9_-]{16,}$ ]]; then
  die 2 "That does not look like a Cursor user key (expected one line of at least 16 letters, digits, '_' or '-')."
fi

store_secret personal cursor "$origin"
