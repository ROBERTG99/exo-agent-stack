import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UNTRUSTED_PARAGRAPH,
  lintAgentDir,
  lintAgentText,
} from "../../../doctor/src/agent-schema.ts";

const root = join(import.meta.dirname, "..", "..", "..");

const body = `\nYou are an agent.\n\n${UNTRUSTED_PARAGRAPH}\n`;
const doc = (front: string, text = body) => `---\n${front}\n---\n${text}`;
const MIN =
  "name: demo\nharness: cursor\nmodel:\n  name: auto\n  credential: cursor\npermission_policy:\n  type: always_allow";

const lint = (text: string, file = "demo.md") => lintAgentText(text, { file, checkPaths: false });
const rules = (text: string, file?: string) => lint(text, file).map((d) => d.rule);

describe("a valid definition", () => {
  it("lints clean", () => {
    expect(lint(doc(MIN))).toEqual([]);
  });

  it("accepts every field of BUILD.md §4.5", () => {
    const front = `name: demo
description: A demo agent
harness: ../harnesses/claude-host/harness.ts
model:
  name: claude-opus-5-5
permission_policy:
  type: always_allow
tool_policies:
  claude.Bash:
    type: always_ask
tools:
  - ../tools/run-checks.ts
resources:
  - name: templates
    type: directory
    path: ../fixtures/build-templates
    mount_path: /workspace/templates
    mode: ro
adapters:
  - type: slack
    vault: ops-slack
    allowed_channels: ["C0EXOSOPS"]
mcp_servers:
  - type: url
    name: deepwiki
    url: https://mcp.deepwiki.com/mcp
    permission_policy:
      type: always_allow
  - type: url
    name: playwright
    url: http://127.0.0.1:9843/mcp
    permission_policy:
      type: always_ask
    tool_policies:
      browser_snapshot:
        type: always_allow`;
    expect(lint(doc(front))).toEqual([]);
  });
});

describe("structure", () => {
  it("reports a missing front matter", () => {
    expect(rules("# no front matter\n")).toEqual(["frontmatter"]);
  });

  it("reports invalid YAML with a line number", () => {
    const d = lint(doc("name: demo\nharness: [unclosed"));
    expect(d[0]).toMatchObject({ rule: "yaml", file: "demo.md" });
    expect(d[0]!.line).toBeGreaterThan(1);
  });

  it("reports an unknown key with the file and line (FR-2)", () => {
    const text = doc(`${MIN}\nbogus_key: 1`);
    const d = lint(text);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ rule: "unknown-key", file: "demo.md", line: 9 });
    expect(d[0]!.message).toContain("bogus_key");
  });

  it("reports an unknown key nested inside a list entry at that entry's line", () => {
    const front = `${MIN}\nadapters:\n  - type: slack\n    vault: v\n    allowed_channels: [C1]\n    surprise: true`;
    const d = lint(doc(front));
    expect(d.find((x) => x.rule === "unknown-key")).toMatchObject({ line: 13 });
  });

  it("reports wrong types and missing required fields", () => {
    expect(rules(doc("name: demo\nmodel: just-a-string"))).toContain("schema");
    expect(rules(doc("harness: cursor\nmodel:\n  name: auto"))).toContain("schema");
    expect(rules(doc("name: demo\nharness: cursor\nmodel:\n  name: 5"))).toContain("schema");
  });

  it("reports every problem in a file, not just the first", () => {
    const front = `name: other\nharness: cursor\nmodel:\n  name: auto\npermission_policy:\n  type: always_ask\nextra: 1`;
    const found = rules(doc(front, "\nno paragraph here\n"));
    expect(found).toEqual(
      expect.arrayContaining(["name-mismatch", "cursor-ask", "unknown-key", "untrusted-paragraph"]),
    );
  });
});

describe("rules of this stack", () => {
  it("the file name must equal the agent name", () => {
    expect(rules(doc(MIN), "other.md")).toEqual(["name-mismatch"]);
    expect(rules(doc(MIN), "/some/dir/demo.md")).toEqual([]);
  });

  it("the Cursor adapter rejects always_ask, as a default or per tool (FR-2)", () => {
    expect(rules(doc(MIN.replace("always_allow", "always_ask")))).toEqual(["cursor-ask"]);
    expect(rules(doc(`${MIN}\ntool_policies:\n  write_report:\n    type: always_ask`))).toEqual([
      "cursor-ask",
    ]);
    expect(
      rules(
        doc(
          MIN.replace("harness: cursor", "harness: ../harnesses/claude-host/harness.ts").replace(
            "always_allow",
            "always_ask",
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("a Cursor agent must state permission_policy always_allow", () => {
    expect(
      rules(doc("name: demo\nharness: cursor\nmodel:\n  name: auto\n  credential: cursor")),
    ).toEqual(["cursor-ask"]);
  });

  it("use_sender_vault is refused wherever it appears, whatever its value", () => {
    for (const value of ["true", "false"]) {
      const front = `${MIN}\nadapters:\n  - type: slack\n    vault: v\n    allowed_channels: [C1]\n    use_sender_vault: ${value}`;
      const d = lint(doc(front));
      expect(d.map((x) => x.rule)).toEqual(["sender-vault"]);
      expect(d[0]!.line).toBe(13);
    }
  });

  it("a Slack adapter needs at least one allowed channel", () => {
    expect(
      rules(doc(`${MIN}\nadapters:\n  - type: slack\n    vault: v\n    allowed_channels: []`)),
    ).toEqual(["slack-channels"]);
  });

  it("the body must end with the untrusted-content paragraph (whitespace-insensitive)", () => {
    expect(rules(doc(MIN, "\nJust instructions.\n"))).toEqual(["untrusted-paragraph"]);
    expect(rules(doc(MIN, `\nText.\n\n${UNTRUSTED_PARAGRAPH.replace(/\. /g, ".\n")}\n\n`))).toEqual(
      [],
    );
    expect(
      rules(doc(MIN, `\n${UNTRUSTED_PARAGRAPH}\n\nTrailing instructions after it.\n`)),
    ).toEqual(["untrusted-paragraph"]);
  });

  it("a model base_url must be on loopback", () => {
    const local = (url: string) =>
      doc(`name: demo\nharness: ../h.ts\nmodel:\n  name: m\n  base_url: "${url}"`);
    expect(rules(local("http://127.0.0.1:9842/v1"))).toEqual([]);
    expect(rules(local("http://localhost:9842/v1"))).toEqual([]);
    expect(rules(local("https://api.example.org/v1"))).toEqual(["base-url"]);
    expect(rules(local("http://0.0.0.0:9842/v1"))).toEqual(["base-url"]);
  });

  it("an MCP server must state a permission policy", () => {
    const front = `${MIN}\nmcp_servers:\n  - type: url\n    name: x\n    url: http://127.0.0.1:1/mcp`;
    expect(rules(doc(front))).toEqual(["mcp-policy"]);
  });

  it("credential names must not look like API keys", () => {
    for (const name of ["anthropic", "openai-key", "OPENROUTER", "my_api_key"]) {
      expect(rules(doc(MIN.replace("credential: cursor", `credential: ${name}`)))).toEqual([
        "credential-name",
      ]);
    }
    expect(rules(doc(MIN.replace("credential: cursor", "credential: claude-oauth")))).toEqual([]);
  });
});

describe("referenced paths", () => {
  it("must exist relative to the Markdown file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "tools", "t.ts"), "export {}");
    const file = join(dir, "demo.md");
    const front = `name: demo\nharness: ./missing-harness.ts\nmodel:\n  name: m\ntools:\n  - ./tools/t.ts\n  - ./tools/nope.ts\nresources:\n  - name: r\n    type: directory\n    path: ./nodir\n    mount_path: /w\n    mode: ro`;
    const d = lintAgentText(doc(front), { file, checkPaths: true });
    const missing = d.filter((x) => x.rule === "path-missing");
    expect(missing).toHaveLength(3);
    expect(missing.map((m) => m.message).join(" ")).toMatch(/missing-harness|nope|nodir/);
    expect(missing.every((m) => m.line > 1)).toBe(true);
  });

  it("is skipped for the built-in cursor harness", () => {
    const d = lintAgentText(doc(MIN), { file: join(tmpdir(), "demo.md"), checkPaths: true });
    expect(d).toEqual([]);
  });
});

describe("lintAgentDir and the CLI", () => {
  const cli = join(root, "cli", "src", "main.ts");
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", cli, "agents", "lint", ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  function dirWith(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it("lints every .md file and ignores other files and the generated folder", () => {
    const dir = dirWith({ "demo.md": doc(MIN), "README.txt": "x" });
    mkdirSync(join(dir, "generated"));
    writeFileSync(join(dir, "generated", "other.md"), "not an agent");
    expect(lintAgentDir(dir, { checkPaths: false })).toEqual([]);
  });

  it("exits 0 on valid definitions", () => {
    const r = run([dirWith({ "demo.md": doc(MIN) })]);
    expect(r.status, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/1 agent definition/);
  });

  it("exits 1 and prints file:line: rule: message for bad ones (FR-2)", () => {
    const dir = dirWith({ "demo.md": doc(`${MIN}\nbogus_key: 1`) });
    const r = run([dir]);
    expect(r.status).toBe(1);
    expect(r.err).toContain(`${join(dir, "demo.md")}:9: unknown-key:`);
    expect(r.err).toContain("bogus_key");
  });

  it("exits 2 for a directory that does not exist", () => {
    const r = run(["/nonexistent-agents-dir"]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/not found|cannot read/i);
  });

  it("refuses --online, which needs a running Exo", () => {
    const r = run([dirWith({ "demo.md": doc(MIN) }), "--online"]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/online/i);
  });
});
