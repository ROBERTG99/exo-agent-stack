#!/usr/bin/env bash
# PostToolUse (Write|Edit|MultiEdit): format the touched file with the repo's prettier.
# Never fails the tool call: missing prettier, unsupported file types and bad input are no-ops.
set -uo pipefail

input="$(cat 2>/dev/null || true)"
file="$(printf '%s' "$input" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try { process.stdout.write(String(JSON.parse(d)?.tool_input?.file_path ?? "")); } catch { /* ignore */ }
});' 2>/dev/null || true)"

[ -n "$file" ] && [ -f "$file" ] || exit 0
case "$file" in
  *.ts | *.tsx | *.js | *.mjs | *.cjs | *.json | *.jsonc | *.css | *.yaml | *.yml | *.html) ;;
  *) exit 0 ;;
esac

project="${CLAUDE_PROJECT_DIR:-$(pwd)}"
prettier="$project/node_modules/.bin/prettier"
[ -x "$prettier" ] || exit 0

(cd "$project" && "$prettier" --write --log-level silent "$file") >/dev/null 2>&1 || true
exit 0
