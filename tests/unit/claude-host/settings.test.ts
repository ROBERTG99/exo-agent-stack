/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC and settings payloads are schemaless in these assertions */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DENY_RULES,
  PATH_GUARD_PATH,
  buildSettings,
  writeSettings,
} from "../../../harnesses/claude-host/settings.ts";

const worktree = () => realpathSync(mkdtempSync(join(tmpdir(), "wt-")));

describe("Mode A settings (BUILD.md §4.7)", () => {
  it("denies the destructive and secret-reading rules", () => {
    expect(DENY_RULES).toEqual([
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
    ]);
  });

  it("keeps the literal rule text in the source file (a tool that rewrites commands must not alter it)", () => {
    // Regression: a user-level hook that rewrites the rm command to trash silently turned this
    // deny rule into a no-op, and a test written through the same hook agreed with it.
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "harnesses", "claude-host", "settings.ts"),
      "utf8",
    );
    expect(source).toContain('"Bash(rm -rf:*)"');
    expect(source).not.toMatch(/trash/i);
    expect(DENY_RULES[0]!.startsWith("Bash(rm ")).toBe(true);
    expect(DENY_RULES.every((r) => !r.includes("( ") && !/\btrash\b/.test(r))).toBe(true);
  });

  it("uses the default permission mode and disables bypass mode", () => {
    const s = buildSettings({ worktree: "/w", hookPath: "/h.mjs" }) as any;
    expect(s.permissions.defaultMode).toBe("default");
    expect(s.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(s.permissions.deny).toEqual(DENY_RULES);
    expect(s.permissions.allow).toBeUndefined();
  });

  it("registers a PreToolUse path guard for the file tools, bound to this worktree", () => {
    const s = buildSettings({ worktree: "/w", hookPath: "/h.mjs" }) as any;
    const hook = s.hooks.PreToolUse[0];
    for (const tool of ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"]) {
      expect(hook.matcher, tool).toContain(tool);
    }
    expect(hook.hooks[0]).toMatchObject({ type: "command" });
    expect(hook.hooks[0].command).toContain("/h.mjs");
    expect(hook.hooks[0].command).toContain("/w");
  });

  it("quotes paths with spaces and quotes in the hook command", () => {
    const s = buildSettings({ worktree: "/a b/it's", hookPath: "/h k.mjs" }) as any;
    const cmd: string = s.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain("'/h k.mjs'");
    expect(cmd).toContain(`'/a b/it'\\''s'`);
  });

  it("writes <worktree>/.claude/settings.local.json with mode 0600, idempotently", () => {
    const wt = worktree();
    const file = writeSettings(wt);
    expect(file).toBe(join(wt, ".claude", "settings.local.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const first = readFileSync(file, "utf8");
    expect(writeSettings(wt)).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(JSON.parse(first).permissions.deny).toEqual(DENY_RULES);
  });

  it("replaces a pre-existing settings.local.json instead of merging in its permissions", () => {
    const wt = worktree();
    mkdirSync(join(wt, ".claude"));
    writeFileSync(
      join(wt, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
    );
    writeSettings(wt);
    const s = JSON.parse(readFileSync(join(wt, ".claude", "settings.local.json"), "utf8"));
    expect(s.permissions.allow).toBeUndefined();
  });

  it("ships the path guard as an existing file", () => {
    expect(existsSync(PATH_GUARD_PATH)).toBe(true);
  });
});

describe("writeSettings does not follow symlinks planted in the worktree", () => {
  const outsideDir = () => realpathSync(mkdtempSync(join(tmpdir(), "outside-")));

  it("replaces a .claude symlink instead of writing through it", () => {
    const wt = worktree();
    const outside = outsideDir();
    symlinkSync(outside, join(wt, ".claude"));
    writeSettings(wt);
    expect(lstatSync(join(wt, ".claude")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, ".claude")).isDirectory()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(wt, ".claude", "settings.local.json"))).toBe(true);
  });

  it("replaces a settings.local.json symlink instead of overwriting its target", () => {
    const wt = worktree();
    const outside = outsideDir();
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "precious");
    mkdirSync(join(wt, ".claude"));
    symlinkSync(victim, join(wt, ".claude", "settings.local.json"));
    writeSettings(wt);
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(lstatSync(join(wt, ".claude", "settings.local.json")).isSymbolicLink()).toBe(false);
    expect(
      JSON.parse(readFileSync(join(wt, ".claude", "settings.local.json"), "utf8")).permissions
        .defaultMode,
    ).toBe("default");
  });

  it("replaces a regular file that sits where the .claude directory belongs", () => {
    const wt = worktree();
    writeFileSync(join(wt, ".claude"), "not a directory");
    writeSettings(wt);
    expect(lstatSync(join(wt, ".claude")).isDirectory()).toBe(true);
  });

  it("leaves no temporary files behind", () => {
    const wt = worktree();
    writeSettings(wt);
    writeSettings(wt);
    expect(readdirSync(join(wt, ".claude"))).toEqual(["settings.local.json"]);
  });
});

describe("path guard hook", () => {
  const run = (wt: string, tool: string, input: Record<string, unknown>) => {
    const r = spawnSync(process.execPath, [PATH_GUARD_PATH, wt], {
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: wt }),
      encoding: "utf8",
    });
    return { status: r.status, stderr: r.stderr };
  };

  it("allows paths inside the worktree, absolute or relative", () => {
    const wt = worktree();
    expect(run(wt, "Read", { file_path: join(wt, "src/a.ts") }).status).toBe(0);
    expect(run(wt, "Write", { file_path: "src/b.ts" }).status).toBe(0);
    expect(run(wt, "Glob", { pattern: "**/*.ts" }).status).toBe(0);
    expect(run(wt, "Grep", { pattern: "x", path: "src" }).status).toBe(0);
  });

  it.each([
    ["an absolute path outside", () => ({ file_path: "/etc/passwd" })],
    ["a relative escape", () => ({ file_path: "../outside.txt" })],
    ["a home-relative path", () => ({ file_path: "~/.ssh/id_ed25519" })],
    ["a notebook outside", () => ({ notebook_path: "/tmp/x.ipynb" })],
    ["a search path outside", () => ({ path: "/Users" })],
  ])("blocks %s with exit 2 and a reason", (_n, input) => {
    const wt = worktree();
    const tool = "notebook_path" in input() ? "NotebookEdit" : "path" in input() ? "Grep" : "Read";
    const r = run(wt, tool, input());
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/outside the worktree/i);
  });

  it("blocks a symlink inside the worktree that points outside", () => {
    const wt = worktree();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
    symlinkSync(outside, join(wt, "link"));
    expect(run(wt, "Read", { file_path: join(wt, "link", "secret.txt") }).status).toBe(2);
  });

  it.each([
    ["a Glob pattern climbing out with ..", "Glob", { pattern: "../**/*.ts" }],
    ["a Glob pattern with .. in the middle", "Glob", { pattern: "src/../../x/*" }],
    ["a Glob pattern anchored outside", "Glob", { pattern: "/etc/**" }],
    ["a home-anchored Glob pattern", "Glob", { pattern: "~/.ssh/*" }],
    ["a Grep glob climbing out", "Grep", { pattern: "secret", glob: "../*" }],
    ["a Grep glob anchored outside", "Grep", { pattern: "secret", glob: "/etc/*" }],
  ])("blocks %s", (_n, tool, input) => {
    const r = run(worktree(), tool, input);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/outside the worktree|\.\./i);
  });

  it("allows in-tree globs and does not treat a Grep regex as a path", () => {
    const wt = worktree();
    expect(run(wt, "Glob", { pattern: "src/**/*.ts" }).status).toBe(0);
    expect(run(wt, "Glob", { pattern: "**/*.md" }).status).toBe(0);
    expect(run(wt, "Glob", { pattern: join(wt, "src", "*.ts") }).status).toBe(0);
    expect(run(wt, "Grep", { pattern: "foo/../bar|\\.\\./baz", glob: "*.ts" }).status).toBe(0);
  });

  it("does not treat a sibling directory with the same prefix as inside", () => {
    const wt = worktree();
    expect(run(wt, "Read", { file_path: `${wt}-evil/file` }).status).toBe(2);
  });

  it("ignores tools it does not govern and malformed input", () => {
    const wt = worktree();
    expect(run(wt, "Bash", { command: "ls /etc" }).status).toBe(0);
    const r = spawnSync(process.execPath, [PATH_GUARD_PATH, wt], {
      input: "not json",
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});
