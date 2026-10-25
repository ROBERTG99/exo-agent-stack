#!/usr/bin/env bash
# Stop hook: run `make check-fast` (< 60 s) and block the stop once if it is red.
# When Claude Code re-runs the hook after a block, stop_hook_active is true and we exit 0,
# so there is never a loop. STOP_HOOK_CMD and STOP_HOOK_TIMEOUT exist for tests.
set -uo pipefail

input="$(cat 2>/dev/null || true)"
active="$(printf '%s' "$input" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try { process.stdout.write(JSON.parse(d)?.stop_hook_active ? "true" : "false"); } catch { process.stdout.write("false"); }
});' 2>/dev/null || echo false)"

[ "$active" = "true" ] && exit 0

project="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cmd="${STOP_HOOK_CMD:-make check-fast}"
limit="${STOP_HOOK_TIMEOUT:-60}"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

# perl alarm is the portable timeout on macOS (no coreutils `timeout`); exec keeps the pid so the alarm kills the shell.
(cd "$project" && perl -e 'alarm shift; exec @ARGV' "$limit" bash -c "$cmd") >"$out" 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

{
  if [ "$status" -eq 142 ] || [ "$status" -eq 14 ]; then
    echo "make check-fast timed out (time limit ${limit}s). Fix or speed up the checks before stopping."
  else
    echo "make check-fast failed (exit $status). Fix it before stopping; last output:"
  fi
  tail -n 40 "$out"
} >&2
exit 2
