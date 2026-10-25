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

# macOS has no coreutils `timeout`, so perl runs the command in its own process group and kills the
# whole group on expiry; otherwise make/vitest grandchildren would outlive the limit.
(cd "$project" && perl -e '
  my $limit = shift;
  my $pid = fork();
  if (!$pid) { setpgrp(0, 0); exec @ARGV; exit 127; }
  $SIG{ALRM} = sub { kill "TERM", -$pid; select(undef, undef, undef, 1); kill "KILL", -$pid; exit 142; };
  alarm $limit;
  waitpid($pid, 0);
  exit(($? & 127) ? 128 + ($? & 127) : ($? >> 8));
' "$limit" bash -c "$cmd") >"$out" 2>&1
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
