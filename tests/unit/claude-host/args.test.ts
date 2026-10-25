import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVAL_TOOL, buildClaudeArgs } from "../../../harnesses/claude-host/args.ts";

const dir = join(import.meta.dirname, "..", "..", "..", "fixtures", "claude-help");
const help = readFileSync(join(dir, "claude-help.txt"), "utf8");
const hidden = readFileSync(join(dir, "hidden-flags.txt"), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("--"));

describe("claude CLI arguments (checked against the recorded claude --help, 2.1.212)", () => {
  const args = buildClaudeArgs({ model: "claude-opus-5-5", mcpConfigPath: "/tmp/mcp.json" });
  const flags = args.filter((a) => a.startsWith("-"));

  it("builds the headless stream-json invocation of BUILD.md §4.7", () => {
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-opus-5-5",
      "--permission-prompt-tool",
      APPROVAL_TOOL,
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
      "--setting-sources",
      "local",
    ]);
    expect(APPROVAL_TOOL).toBe("mcp__exos_approvals__prompt");
  });

  it("only uses flags that the recorded help lists, or that the hidden-flag evidence covers", () => {
    for (const flag of flags) {
      const listed = new RegExp(`(^|[\\s,])${flag.replace(/-/g, "\\-")}([\\s,<\\[]|$)`, "m").test(
        help,
      );
      expect(listed || hidden.includes(flag), flag).toBe(true);
    }
  });

  it("appends --resume only when a session id is given", () => {
    expect(args).not.toContain("--resume");
    const resumed = buildClaudeArgs({
      model: "m",
      mcpConfigPath: "/c.json",
      resumeSessionId: "sess-9",
    });
    expect(resumed.slice(-2)).toEqual(["--resume", "sess-9"]);
    expect(help).toMatch(/--resume/);
  });

  it("never asks to skip permission checks", () => {
    const joined = buildClaudeArgs({ model: "m", mcpConfigPath: "/c", resumeSessionId: "s" }).join(
      " ",
    );
    expect(joined).not.toMatch(/dangerously|bypass/i);
  });

  it("rejects a model name or session id that could be read as a flag", () => {
    expect(() => buildClaudeArgs({ model: "--oops", mcpConfigPath: "/c" })).toThrow();
    expect(() =>
      buildClaudeArgs({ model: "m", mcpConfigPath: "/c", resumeSessionId: "-x" }),
    ).toThrow();
    expect(() => buildClaudeArgs({ model: "", mcpConfigPath: "/c" })).toThrow();
  });
});
