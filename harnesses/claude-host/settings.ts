import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Rules Claude Code refuses regardless of any approval (BUILD.md §4.7). */
export const DENY_RULES = [
  "Bash( trash -rf:*)",
  "Bash(git push --force:*)",
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
 */
export function writeSettings(worktree: string, hookPath: string = PATH_GUARD_PATH): string {
  const dir = join(worktree, ".claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.local.json");
  writeFileSync(file, `${JSON.stringify(buildSettings({ worktree, hookPath }), null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  return file;
}
