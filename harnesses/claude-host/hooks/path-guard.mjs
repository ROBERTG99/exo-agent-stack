#!/usr/bin/env node
// PreToolUse hook for Mode A: file tools may only touch paths inside the thread's worktree.
// Usage: path-guard.mjs <worktree>; the tool call arrives as JSON on stdin.
// Exit 2 (stderr shown to Claude) blocks the call; anything unexpected exits 0 so a bug here never
// stops a turn (the deny list and the approvals gate remain in force).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const GOVERNED = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"]);

function resolveReal(p) {
  // realpath of the deepest existing ancestor, then the not-yet-existing remainder.
  let head = p;
  const tail = [];
  while (!existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  return path.join(realpathSync(head), ...tail);
}

function expand(p, base) {
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

try {
  if (!GOVERNED.has(input.tool_name)) process.exit(0);
  const worktree = realpathSync(process.argv[2]);
  const base = input.cwd ?? worktree;
  const ti = input.tool_input ?? {};
  const candidates = [ti.file_path, ti.notebook_path, ti.path].filter(
    (v) => typeof v === "string" && v !== "",
  );
  // A Glob pattern is a path only when it is anchored outside the working directory.
  if (
    typeof ti.pattern === "string" &&
    (ti.pattern.startsWith("/") || ti.pattern.startsWith("~"))
  ) {
    candidates.push(ti.pattern.split(/[*?[{]/)[0] || "/");
  }
  for (const candidate of candidates) {
    const real = resolveReal(expand(candidate, base));
    if (real !== worktree && !real.startsWith(worktree + path.sep)) {
      process.stderr.write(`path-guard: ${candidate} is outside the worktree ${worktree}\n`);
      process.exit(2);
    }
  }
} catch {
  process.exit(0);
}
process.exit(0);
