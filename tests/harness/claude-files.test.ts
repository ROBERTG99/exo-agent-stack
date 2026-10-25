import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const spec = read("docs/specs/000-build-spec.md");

function frontmatter(text: string): Record<string, string> | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

describe("CLAUDE.md and AGENTS.md", () => {
  const claude = read("CLAUDE.md");
  const agents = read("AGENTS.md");

  it("CLAUDE.md is under 200 lines", () => {
    expect(claude.split("\n").length).toBeLessThan(200);
  });

  it("contains the §0.1 project rails verbatim", () => {
    const section = spec.slice(
      spec.indexOf("### 0.1 Project rails"),
      spec.indexOf("## 1. Environment bootstrap"),
    );
    const rails = section.split("\n").filter((l) => /^\d\. \*\*/.test(l));
    expect(rails).toHaveLength(8);
    for (const r of rails) expect(claude, r.slice(0, 40)).toContain(r);
    for (const r of rails) expect(agents, r.slice(0, 40)).toContain(r);
  });

  it.each([
    ["the component map", /bridge.*stackd.*exo|stackd.*Exo/is],
    ["build/test commands", /make check-fast/],
    ["the attribution rule", /Co-Authored-By/],
    ["the PROGRESS.md pointer", /PROGRESS\.md/],
    ["the decisions pointer", /docs\/DECISIONS\.md/],
    ["the verification log pointer", /docs\/exo-verification\.md/],
    ["the subagent rules pointer", /\.claude\/rules\/subagents\.md/],
    ["the spec pointer", /docs\/specs\/000-build-spec\.md|BUILD\.md/],
  ])("CLAUDE.md has %s", (_n, re) => {
    expect(claude).toMatch(re);
  });

  it("AGENTS.md carries the essentials", () => {
    for (const re of [
      /make check-fast/,
      /Co-Authored-By/,
      /PROGRESS\.md/,
      /loopback|127\.0\.0\.1/i,
    ]) {
      expect(agents).toMatch(re);
    }
  });
});

describe(".claude/settings.json", () => {
  const settings = JSON.parse(read(".claude/settings.json"));

  it("keeps the attribution key", () => {
    expect(settings.attribution).toEqual({ commit: "", pr: "", sessionUrl: false });
  });

  it("routes the orchestrator to sonnet at high effort", () => {
    expect(settings.model).toBe("sonnet");
    expect(settings.effortLevel).toBe("high");
  });

  it("has the §7.1 allow and deny lists and no ask rules", () => {
    const p = settings.permissions;
    for (const a of [
      "Bash(git submodule:*)",
      "Bash(git worktree:*)",
      "Bash(cargo build:*)",
      "Bash(cargo test:*)",
      "Bash(claude --version)",
      "Bash(claude --help)",
      "Read(./.env.example)",
    ]) {
      expect(p.allow, a).toContain(a);
    }
    for (const d of [
      "Read(./.env.*)",
      "Read(~/.claude/**)",
      "Read(~/.exo/**)",
      "Read(~/.cursor/**)",
      "Bash(claude setup-token:*)",
      "Bash(claude login:*)",
      "Bash(cursor-agent login:*)",
      "Bash(gh auth login:*)",
      "Bash(exo vault secret:*)",
      "Bash(rm -rf /:*)",
      "Bash(rm -rf ~:*)",
    ]) {
      expect(p.deny, d).toContain(d);
    }
    expect(p.ask).toBeUndefined();
  });

  it("denies every .env variant, including a plain .env and nested ones", () => {
    for (const d of ["Read(./.env)", "Read(./.env.*)", "Read(./**/.env)", "Read(./**/.env.*)"]) {
      expect(settings.permissions.deny, d).toContain(d);
    }
  });

  it("allows no wildcard interpreters or runners and never the live targets", () => {
    const allow: string[] = settings.permissions.allow;
    for (const risky of [
      "Bash(node:*)",
      "Bash(pnpm:*)",
      "Bash(pnpm exec:*)",
      "Bash(pnpm exec tsx scripts/:*)",
      "Bash(pnpm --filter:*)",
      "Bash(uv:*)",
      "Bash(make:*)",
      "Bash(docker compose:*)",
      "Bash(git push:*)",
    ]) {
      expect(allow, risky).not.toContain(risky);
    }
    expect(allow.filter((a) => /live-claude|live-cursor|eval-live/.test(a))).toEqual([]);
    for (const live of ["make live-claude", "make live-cursor", "make eval-live"]) {
      expect(settings.permissions.deny).toContain(`Bash(${live}:*)`);
    }
  });
});

describe("rules", () => {
  it("git-commits.md has no frontmatter", () => {
    const t = read(".claude/rules/git-commits.md");
    expect(t.startsWith("---")).toBe(false);
    expect(t).toContain("Co-Authored-By");
  });

  it.each([
    "typescript",
    "frontend",
    "llm-code",
    "testing",
    "evals",
    "docker",
    "security",
    "exo",
    "docs",
  ])("%s.md has paths frontmatter", (name) => {
    const t = read(`.claude/rules/${name}.md`);
    expect(t.startsWith("---\n")).toBe(true);
    expect(t).toMatch(/^paths:/m);
  });

  it("exo.md covers vendor, harnesses and the exo client", () => {
    const t = read(".claude/rules/exo.md");
    for (const g of ["vendor/**", "harnesses/**", "packages/exo-client/**"]) expect(t).toContain(g);
    expect(t).toContain("docs/exo-verification.md");
  });

  it("llm-code.md says no model calls here", () => {
    expect(read(".claude/rules/llm-code.md")).toMatch(/no model calls/i);
  });

  it("subagents.md is the spec's rules verbatim", () => {
    const start = spec.indexOf("**Decision order");
    const end = spec.indexOf("## 8. Work plan");
    const body = spec.slice(start, end).trim();
    expect(read(".claude/rules/subagents.md").trim()).toBe(body);
  });
});

describe("subagents", () => {
  const expected: Record<string, { model: string; readOnly: boolean }> = {
    reviewer: { model: "opus", readOnly: true },
    "security-auditor": { model: "opus", readOnly: true },
    "eval-analyst": { model: "opus", readOnly: true },
    "policy-guardian": { model: "opus", readOnly: true },
    "exo-integration-reviewer": { model: "opus", readOnly: true },
    "security-reviewer": { model: "opus", readOnly: true },
    "test-designer": { model: "sonnet", readOnly: true },
    "ux-reviewer": { model: "sonnet", readOnly: true },
    "docs-editor": { model: "haiku", readOnly: false },
    mechanic: { model: "haiku", readOnly: false },
    Explore: { model: "haiku", readOnly: true },
    architect: { model: "opus", readOnly: false },
    "architect-critical": { model: "fable", readOnly: false },
  };

  it("has every agent of the routing table and nothing unexpected", () => {
    const files = readdirSync(join(root, ".claude/agents")).map((f) => f.replace(/\.md$/, ""));
    expect(files.sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))("%s has name, description, tools, model", (name, want) => {
    const t = read(`.claude/agents/${name}.md`);
    const fm = frontmatter(t);
    expect(fm, "frontmatter").not.toBeNull();
    expect(fm!.name).toBe(name);
    expect((fm!.description ?? "").length).toBeGreaterThan(20);
    expect(fm!.model).toBe(want.model);
    expect(fm!.tools).toBeTruthy();
    if (want.readOnly) expect(fm!.tools).not.toMatch(/\b(Write|Edit|NotebookEdit)\b/);
  });

  it("architect and architect-critical may only Write (for ADRs), not Edit or Bash", () => {
    for (const n of ["architect", "architect-critical"]) {
      const fm = frontmatter(read(`.claude/agents/${n}.md`))!;
      expect(fm.tools).toContain("Write");
      expect(fm.tools).not.toMatch(/\b(Edit|Bash)\b/);
    }
  });

  it("effort levels follow the routing table", () => {
    const eff = (n: string) => frontmatter(read(`.claude/agents/${n}.md`))!.effort;
    expect(eff("mechanic")).toBe("low");
    expect(eff("Explore")).toBe("low");
    expect(eff("test-designer")).toBe("medium");
    expect(eff("docs-editor")).toBe("medium");
    expect(eff("reviewer")).toBe("high");
    expect(eff("architect")).toBe("xhigh");
    expect(eff("architect-critical")).toBe("high");
  });

  it("policy-guardian answers allow or block", () => {
    expect(read(".claude/agents/policy-guardian.md")).toMatch(/allow/i);
    expect(read(".claude/agents/policy-guardian.md")).toMatch(/block/i);
  });
});

describe("skills", () => {
  const skills = [
    "tdd",
    "quality-gate",
    "eval-report",
    "new-adr",
    "add-migration",
    "add-endpoint",
    "add-agent-tool",
    "add-eval-case",
    "demo-capture",
    "release",
    "add-agent-definition",
    "upgrade-exo-pin",
    "rotate-setup-token",
    "add-bridge-tool",
  ];

  it.each(skills)("%s has a SKILL.md with name and description", (s) => {
    const p = `.claude/skills/${s}/SKILL.md`;
    expect(existsSync(join(root, p))).toBe(true);
    const fm = frontmatter(read(p));
    expect(fm?.name).toBe(s);
    expect((fm?.description ?? "").length).toBeGreaterThan(20);
  });

  it("rotate-setup-token never executes sign-in commands itself", () => {
    expect(read(".claude/skills/rotate-setup-token/SKILL.md")).toMatch(/never (run|execute)/i);
  });

  it("upgrade-exo-pin re-verifies V-1 to V-11", () => {
    expect(read(".claude/skills/upgrade-exo-pin/SKILL.md")).toMatch(/V-1.*V-11/s);
  });
});

describe(".mcp.json", () => {
  const mcp = JSON.parse(read(".mcp.json"));
  it("declares the bridge over stdio and playwright", () => {
    expect(mcp.mcpServers["exos-bridge"]).toMatchObject({
      command: "node",
      args: ["bridge/dist/stdio.js"],
    });
    expect(mcp.mcpServers.playwright.args.join(" ")).toContain("@playwright/mcp");
  });
});
