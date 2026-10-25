import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Rules Claude Code refuses regardless of any approval (BUILD.md §4.7). */
export const DENY_RULES = [
  "Bash(rm -rf:*)",
  "Bash(rm -fr:*)",
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(curl:*)",
  "Bash(ssh:*)",
  "Read(**/.env)",
  "Read(~/.ssh/**)",
  "Read(~/.claude/**)",
  "Read(~/.exo-agent-stack/**)",
];

export const PATH_GUARD_PATH = fileURLToPath(new URL("./hooks/path-guard.mjs", import.meta.url));

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function buildSettings(opts: { worktree: string; hookPath: string }) {
  return {
    permissions: {
      defaultMode: "default",
      disableBypassPermissionsMode: "disable",
      deny: DENY_RULES,
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep",
          hooks: [
            {
              type: "command",
              command: `${quote(process.execPath)} ${quote(opts.hookPath)} ${quote(opts.worktree)}`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Writes <worktree>/.claude/settings.local.json for this turn. The file is replaced, not merged:
 * a stale allow rule in it must never widen what the approvals gate sees.
 *
 * The agent works in this worktree and can plant symlinks, so nothing is written through an
 * existing path: a `.claude` that is not a real directory is unlinked (never followed), and the
 * file is written to a fresh temporary name and renamed into place, which replaces a symlink at
 * the destination instead of writing to its target.
 */
export function writeSettings(worktree: string, hookPath: string = PATH_GUARD_PATH): string {
  const dir = join(worktree, ".claude");
  const existing = lstatSync(dir, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) unlinkSync(dir); // a symlink or a plain file
  mkdirSync(dir, { recursive: true });

  const file = join(dir, "settings.local.json");
  const tmp = join(dir, `.settings.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(buildSettings({ worktree, hookPath }), null, 2)}\n`, {
    mode: 0o600,
    flag: "wx", // fail instead of following or reusing anything at this path
  });
  renameSync(tmp, file);
  return file;
}
