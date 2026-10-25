#!/usr/bin/env bash
# Starts the stack natively (no Docker): Exo (or its offline simulator), stackd and the bridge, all on
# 127.0.0.1. Usage: scripts/host-up.sh [down|status]    (default: up)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

case "${1:-up}" in
  up | down | status) action="${1:-up}" ;;
  *)
    echo "usage: scripts/host-up.sh [up|down|status]" >&2
    exit 2
    ;;
esac

exec pnpm exec tsx cli/src/main.ts host "$action"
