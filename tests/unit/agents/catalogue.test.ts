/* eslint-disable @typescript-eslint/no-explicit-any -- parsed agent front matter is schemaless here */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  lintAgentDir,
  lintAgentText,
  UNTRUSTED_PARAGRAPH,
} from "../../../doctor/src/agent-schema.ts";
import { renderAgents, writeRendered } from "../../../scripts/agents-render.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const agentsDir = join(root, "agents");

const read = (name: string) => {
  const text = readFileSync(join(agentsDir, `${name}.md`), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
  return { front: parseYaml(m[1]!) as any, body: m[2]! };
};

const NAMES = [
  "dual-review",
  "local-harness",
  "ops-slack",
  "repo-builder",
  "repo-builder-b",
  "researcher",
  "reviewer-cursor",
];

describe("the catalogue (FR-2: seven definitions)", () => {
  it("has exactly the seven agents of BUILD.md §4.5", () => {
    const found =
      lintAgentDir(agentsDir).length === 0
        ? NAMES.filter((n) => existsSync(join(agentsDir, `${n}.md`)))
        : [];
    expect(found).toEqual(NAMES);
  });

  it("lints clean, including that every referenced path exists", () => {
    expect(lintAgentDir(agentsDir, { checkPaths: true })).toEqual([]);
  });

  it("repo-builder: Mode A, opus, Bash and WebFetch ask, mounts the build templates read-only", () => {
    const { front } = read("repo-builder");
    expect(front.harness).toBe("../harnesses/claude-host/harness.ts");
    expect(front.model).toEqual({ name: "claude-opus-5-5" });
    expect(front.permission_policy).toEqual({ type: "always_allow" });
    expect(front.tool_policies).toEqual({
      "claude.Bash": { type: "always_ask" },
      "claude.WebFetch": { type: "always_ask" },
    });
    expect(front.tools).toEqual(["../tools/run-checks.ts", "../tools/write-report.ts"]);
    expect(front.resources).toEqual([
      {
        name: "templates",
        type: "directory",
        path: "../fixtures/build-templates",
        mount_path: "/workspace/templates",
        mode: "ro",
      },
    ]);
  });

  it("repo-builder-b: the same agent in Mode B with the claude-oauth credential", () => {
    const a = read("repo-builder").front;
    const b = read("repo-builder-b").front;
    expect(b.harness).toBe("../harnesses/claude-sandboxed/claude-code-harness.ts");
    expect(b.model).toEqual({ name: "claude-opus-5-5", credential: "claude-oauth" });
    for (const key of ["permission_policy", "tool_policies", "tools", "resources"])
      expect(b[key]).toEqual(a[key]);
  });

  it("reviewer-cursor: Cursor harness, auto model, always_allow (the adapter rejects always_ask), read-only target", () => {
    const { front } = read("reviewer-cursor");
    expect(front.harness).toBe("cursor");
    expect(front.model).toEqual({ name: "auto", credential: "cursor" });
    expect(front.permission_policy).toEqual({ type: "always_allow" });
    expect(front.tools).toEqual(["../tools/write-report.ts"]);
    expect(front.resources[0]).toMatchObject({
      name: "target",
      path: "../fixtures/review-target",
      mount_path: "/workspace/target",
      mode: "ro",
    });
  });

  it("dual-review: like reviewer-cursor but on the claude-host harness", () => {
    const d = read("dual-review").front;
    const r = read("reviewer-cursor").front;
    expect(d.harness).toBe("../harnesses/claude-host/harness.ts");
    expect(d.model.name).toBe("claude-opus-5-5");
    expect(d.model.credential).toBeUndefined();
    expect(d.tools).toEqual(r.tools);
    expect(d.resources).toEqual(r.resources);
  });

  it("ops-slack: haiku, one Slack adapter on a fixed channel, no sender vault", () => {
    const { front } = read("ops-slack");
    expect(front.model).toEqual({ name: "claude-haiku-5-5" });
    expect(front.adapters).toEqual([
      { type: "slack", vault: "ops-slack", allowed_channels: ["C0EXOSOPS"] },
    ]);
    expect(JSON.stringify(front)).not.toContain("use_sender_vault");
  });

  it("researcher: DeepWiki without a credential, Playwright asks except snapshots", () => {
    const { front } = read("researcher");
    expect(front.mcp_servers).toEqual([
      {
        type: "url",
        name: "deepwiki",
        url: "https://mcp.deepwiki.com/mcp",
        permission_policy: { type: "always_allow" },
      },
      {
        type: "url",
        name: "playwright",
        url: "http://127.0.0.1:9843/mcp",
        permission_policy: { type: "always_ask" },
        tool_policies: { browser_snapshot: { type: "always_allow" } },
      },
    ]);
    expect(front.tools).toEqual(["../tools/write-report.ts"]);
  });

  it("every body ends with the untrusted-content paragraph and no agent names an API-key credential", () => {
    for (const n of NAMES) {
      const { front, body } = read(n);
      expect(body.replace(/\s+/g, " ").trim().endsWith(UNTRUSTED_PARAGRAPH), n).toBe(true);
      expect(String(front.model?.credential ?? "")).not.toMatch(/api|key|anthropic|openai/i);
    }
  });
});

describe("renderAgents (make agents-render)", () => {
  const files = renderAgents({ agentsDir, env: {}, modeBSupported: false });

  it("always renders the Cursor fallback of dual-review", () => {
    const text = files.get("agents/generated/dual-review-cursor.md")!;
    expect(text).toBeDefined();
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
    const front = parseYaml(m[1]!) as any;
    expect(front.name).toBe("dual-review-cursor");
    expect(front.harness).toBe("cursor");
    expect(front.model).toEqual({ name: "auto", credential: "cursor" });
    expect(front.permission_policy).toEqual({ type: "always_allow" });
    expect(JSON.stringify(front)).not.toContain("always_ask");
    expect(text.startsWith("---\n# Generated by scripts/agents-render.ts")).toBe(true);
  });

  it("renders nothing else without fleet MCP and while Mode B is unsupported", () => {
    expect([...files.keys()]).toEqual(["agents/generated/dual-review-cursor.md"]);
  });

  it("rewrites relative paths for the generated folder so the output lints clean with its paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-"));
    for (const d of ["agents", "tools", "fixtures", "harnesses"])
      cpSync(join(root, d), join(dir, d), { recursive: true });
    writeRendered(
      dir,
      renderAgents({ agentsDir: join(dir, "agents"), env: {}, modeBSupported: false }),
    );
    const text = readFileSync(join(dir, "agents/generated/dual-review-cursor.md"), "utf8");
    expect(
      lintAgentText(text, {
        file: join(dir, "agents/generated/dual-review-cursor.md"),
        checkPaths: true,
      }),
    ).toEqual([]);
  });

  it("adds a read-only fleet MCP entry to ops-slack only when EXOS_FLEET_MCP_URL is set", () => {
    const withFleet = renderAgents({
      agentsDir,
      env: { EXOS_FLEET_MCP_URL: "http://127.0.0.1:9850/mcp" },
      modeBSupported: false,
    });
    const text = withFleet.get("agents/generated/ops-slack.md")!;
    const front = parseYaml(/^---\n([\s\S]*?)\n---/.exec(text)![1]!) as any;
    expect(front.name).toBe("ops-slack");
    expect(front.mcp_servers).toEqual([
      {
        type: "url",
        name: "agent-fleet",
        url: "http://127.0.0.1:9850/mcp",
        permission_policy: { type: "always_ask" },
      },
    ]);
    expect(front.adapters).toEqual(read("ops-slack").front.adapters);
  });

  it("refuses a fleet URL that is not on loopback", () => {
    expect(() =>
      renderAgents({
        agentsDir,
        env: { EXOS_FLEET_MCP_URL: "https://fleet.example.org/mcp" },
        modeBSupported: false,
      }),
    ).toThrow(/loopback/);
  });

  it("ignores an empty fleet URL", () => {
    expect([
      ...renderAgents({ agentsDir, env: { EXOS_FLEET_MCP_URL: "" }, modeBSupported: false }).keys(),
    ]).toEqual(["agents/generated/dual-review-cursor.md"]);
  });

  it("renders researcher-b with a read-only GitHub MCP entry only once Mode B is supported", () => {
    expect(() => renderAgents({ agentsDir, env: {}, modeBSupported: true })).toThrow(
      /githubMcpUrl/,
    );
    const out = renderAgents({
      agentsDir,
      env: {},
      modeBSupported: true,
      githubMcpUrl: "http://127.0.0.1:9851/mcp",
    });
    const front = parseYaml(
      /^---\n([\s\S]*?)\n---/.exec(out.get("agents/generated/researcher-b.md")!)![1]!,
    ) as any;
    expect(front.name).toBe("researcher-b");
    expect(front.harness).toBe("../../harnesses/claude-sandboxed/claude-code-harness.ts");
    expect(front.model).toEqual({ name: "claude-opus-5-5", credential: "claude-oauth" });
    expect(front.mcp_servers.map((s: any) => s.name)).toEqual(["deepwiki", "playwright", "github"]);
    expect(front.mcp_servers[2].permission_policy).toEqual({ type: "always_ask" });
  });

  it("is deterministic: two renders are byte-identical", () => {
    const again = renderAgents({ agentsDir, env: {}, modeBSupported: false });
    expect([...again.entries()]).toEqual([...files.entries()]);
  });
});

describe("writeRendered", () => {
  it("writes the files, reports what changed, and removes stale generated files", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-"));
    mkdirSync(join(dir, "agents", "generated"), { recursive: true });
    writeFileSync(join(dir, "agents", "generated", "stale.md"), "old");
    writeFileSync(join(dir, "agents", "generated", "keep.txt"), "not an agent");
    const files = new Map([["agents/generated/a.md", "A\n"]]);
    expect(writeRendered(dir, files)).toEqual({
      written: ["agents/generated/a.md"],
      unchanged: [],
      removed: ["agents/generated/stale.md"],
    });
    expect(existsSync(join(dir, "agents", "generated", "stale.md"))).toBe(false);
    expect(existsSync(join(dir, "agents", "generated", "keep.txt"))).toBe(true);
    expect(writeRendered(dir, files)).toEqual({
      written: [],
      unchanged: ["agents/generated/a.md"],
      removed: [],
    });
  });
});
