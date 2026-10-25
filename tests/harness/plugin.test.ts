// T-32 / FR-9: the Claude Code plugin names only tools the bridge has, and nothing pre-approves exo_approve.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeContext } from "../../bridge/src/context.ts";
import { ERROR_CODES } from "../../bridge/src/errors.ts";
import { createMcpServer } from "../../bridge/src/mcp.ts";
import { registerTools } from "../../bridge/src/tools/index.ts";
import { validatePlugin } from "../../scripts/validate-plugin.ts";

const repo = join(import.meta.dirname, "..", "..");
const PREFIX = "mcp__plugin_exos_exos-bridge__";

/** A copy of the files the validator reads, to break one at a time. */
function copyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-"));
  cpSync(join(repo, "plugin"), join(root, "plugin"), { recursive: true });
  cpSync(join(repo, ".cursor"), join(root, ".cursor"), { recursive: true });
  cpSync(join(repo, ".mcp.json"), join(root, ".mcp.json"));
  return root;
}
const edit = (root: string, file: string, change: (text: string) => string) =>
  writeFileSync(join(root, file), change(readFileSync(join(root, file), "utf8")));
const problems = (root: string) => validatePlugin(root).map((p) => `${p.file}: ${p.message}`);

describe("the plugin in this repository", () => {
  it("passes the validator with no problems", () => {
    expect(validatePlugin(repo)).toEqual([]);
  });

  it("names only tools that the bridge really lists (FR-9)", async () => {
    const server = createMcpServer(
      makeContext({ stackdUrl: "http://127.0.0.1:1", stackdToken: "t".repeat(40) }),
      registerTools,
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const listed = new Set((await client.listTools()).tools.map((t) => t.name));
    await client.close();

    const files = [
      ...readdirSync(join(repo, "plugin/commands")).map((f) => join("plugin/commands", f)),
      ...readdirSync(join(repo, "plugin/agents")).map((f) => join("plugin/agents", f)),
      ".cursor/rules/exo-delegation.mdc",
    ];
    const referenced = new Set<string>();
    for (const f of files) {
      const text = readFileSync(join(repo, f), "utf8");
      for (const m of text.matchAll(/mcp__plugin_exos_exos-bridge__([a-z_]+)/g))
        referenced.add(m[1]!);
      for (const m of text.matchAll(/\bexo_[a-z_]+\b/g)) {
        if (!(ERROR_CODES as readonly string[]).includes(m[0])) referenced.add(m[0]);
      }
    }
    expect(referenced.size).toBeGreaterThanOrEqual(8);
    for (const tool of referenced) expect(listed.has(tool), tool).toBe(true);
  });

  it("gives the delegator every bridge tool except exo_approve", () => {
    const text = readFileSync(join(repo, "plugin/agents/delegator.md"), "utf8");
    const tools = /^tools: (.*)$/m.exec(text)![1]!.split(", ");
    expect(tools).toHaveLength(8);
    expect(tools).not.toContain(`${PREFIX}exo_approve`);
    expect(tools.every((t) => t.startsWith(PREFIX))).toBe(true);
  });

  it("pre-approves no write tool and never exo_approve", () => {
    for (const f of readdirSync(join(repo, "plugin/commands"))) {
      const text = readFileSync(join(repo, "plugin/commands", f), "utf8");
      const allowed = /^allowed-tools: (.*)$/m.exec(text)?.[1] ?? "";
      for (const write of [
        "exo_start_thread",
        "exo_send",
        "exo_fork",
        "exo_answer",
        "exo_approve",
      ]) {
        expect(allowed, `${f} ${write}`).not.toContain(write);
      }
    }
    expect(readFileSync(join(repo, "plugin/commands/exo-approve.md"), "utf8")).toMatch(
      /^disable-model-invocation: true$/m,
    );
  });

  it("asks for the stack directories and keeps tokens out of the manifest and the server entry", () => {
    const manifest = JSON.parse(
      readFileSync(join(repo, "plugin/.claude-plugin/plugin.json"), "utf8"),
    );
    expect(Object.keys(manifest.userConfig).sort()).toEqual(["stack_dir", "state_dir"]);
    for (const opt of Object.values<{ sensitive?: boolean }>(manifest.userConfig))
      expect(opt.sensitive).toBeUndefined();
    const text = readFileSync(join(repo, "plugin/.mcp.json"), "utf8");
    expect(text).not.toMatch(/[0-9a-f]{32,}/);
    expect(text).not.toContain("EXOS_LOCAL_TOKEN");
  });
});

describe("the validator catches what it should", () => {
  it("starts from a clean copy", () => {
    expect(problems(copyRepo())).toEqual([]);
  });

  it("flags a misspelt tool, in the body and in the tool list", () => {
    const root = copyRepo();
    edit(root, "plugin/commands/exo-delegate.md", (t) =>
      t.replace("exo_start_thread", "exo_start_thred"),
    );
    expect(problems(root)).toContain(
      "plugin/commands/exo-delegate.md: exo_start_thred is not a bridge tool",
    );
    const root2 = copyRepo();
    edit(root2, "plugin/commands/exo-status.md", (t) => t.replace("exo_usage", "exo_usages"));
    expect(problems(root2).some((p) => p.includes("exo_usages"))).toBe(true);
  });

  it("flags a tool of another server", () => {
    const root = copyRepo();
    edit(root, "plugin/commands/exo-status.md", (t) =>
      t.replace(`${PREFIX}exo_usage`, "mcp__github__create_issue"),
    );
    expect(
      problems(root).some((p) =>
        p.includes("mcp__github__create_issue is not a tool of the exos-bridge"),
      ),
    ).toBe(true);
  });

  it("flags exo_approve granted to a command or to the delegator", () => {
    const root = copyRepo();
    edit(root, "plugin/commands/exo-delegate.md", (t) =>
      t.replace("allowed-tools: ", `allowed-tools: ${PREFIX}exo_approve `),
    );
    expect(
      problems(root).some((p) =>
        p.includes("exo-delegate.md: exo_approve must not be pre-approved"),
      ),
    ).toBe(true);
    const root2 = copyRepo();
    edit(root2, "plugin/agents/delegator.md", (t) =>
      t.replace(/^tools: /m, `tools: ${PREFIX}exo_approve, `),
    );
    const found = problems(root2);
    expect(
      found.some((p) => p.includes("delegator.md: exo_approve must not be pre-approved")),
    ).toBe(true);
    expect(found.some((p) => p.includes("every bridge tool except exo_approve"))).toBe(true);
  });

  it("flags a delegator that lacks a tool", () => {
    const root = copyRepo();
    edit(root, "plugin/agents/delegator.md", (t) => t.replace(`${PREFIX}exo_fork, `, ""));
    expect(problems(root).some((p) => p.includes("every bridge tool except exo_approve"))).toBe(
      true,
    );
  });

  it("requires exo-approve to be user-invoked and to wait for the user", () => {
    const root = copyRepo();
    edit(root, "plugin/commands/exo-approve.md", (t) =>
      t.replace("disable-model-invocation: true\n", ""),
    );
    expect(problems(root).some((p) => p.includes("disable-model-invocation: true"))).toBe(true);
    const root2 = copyRepo();
    edit(root2, "plugin/commands/exo-approve.md", (t) =>
      t.replace(/until the user has said/g, "once you think"),
    );
    expect(problems(root2).some((p) => p.includes("wait for the user's own message"))).toBe(true);
  });

  it("requires the untrusted-output warning", () => {
    const root = copyRepo();
    edit(root, "plugin/agents/delegator.md", (t) => t.replace(/untrusted/gi, "other"));
    expect(
      problems(root).some((p) =>
        p.includes("delegator.md: must tell the model that agent output is untrusted"),
      ),
    ).toBe(true);
  });

  it("flags manifest problems: unknown key, bad version, bad userConfig, wrong name", () => {
    const root = copyRepo();
    edit(root, "plugin/.claude-plugin/plugin.json", (t) => {
      const m = JSON.parse(t);
      m.surprise = true;
      m.version = "one";
      m.name = "other";
      m.userConfig.stack_dir.extra = 1;
      m.userConfig.state_dir.type = "path";
      delete m.author;
      return JSON.stringify(m);
    });
    const found = problems(root).join("\n");
    for (const part of [
      'unknown top-level key "surprise"',
      "version must be semver",
      'name must be "exos"',
      'unknown key "extra"',
      '"path" is not valid',
      "author.name is required",
    ]) {
      expect(found, part).toContain(part);
    }
  });

  it("flags a server entry that uses an undeclared option or carries a token", () => {
    const root = copyRepo();
    edit(root, "plugin/.mcp.json", (t) =>
      t.replace("${user_config.state_dir}", "${user_config.nowhere}"),
    );
    expect(
      problems(root).some((p) =>
        p.includes("${user_config.nowhere} refers to something the manifest does not declare"),
      ),
    ).toBe(true);
    const root2 = copyRepo();
    edit(root2, "plugin/.mcp.json", (t) => t.replace("${user_config.state_dir}", "a".repeat(64)));
    expect(problems(root2).some((p) => p.includes("a token must not be written"))).toBe(true);
  });

  it("flags agent front matter that a plugin agent cannot use", () => {
    const root = copyRepo();
    edit(root, "plugin/agents/delegator.md", (t) =>
      t.replace("model: sonnet\n", "model: sonnet\npermissionMode: bypassPermissions\n"),
    );
    expect(
      problems(root).some((p) =>
        p.includes('"permissionMode" is not recognised in a plugin agent'),
      ),
    ).toBe(true);
  });

  it("flags a missing file", () => {
    const root = copyRepo();
    edit(root, "plugin/.mcp.json", () => "{ broken");
    expect(problems(root).some((p) => p.startsWith("plugin/.mcp.json: not valid JSON"))).toBe(true);
  });
});
