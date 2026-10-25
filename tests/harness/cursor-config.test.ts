// T-32 / FR-9: Cursor reaches the bridge over loopback with a token that comes from the environment.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePlugin } from "../../scripts/validate-plugin.ts";

const repo = join(import.meta.dirname, "..", "..");
const config = JSON.parse(readFileSync(join(repo, ".cursor/mcp.json"), "utf8"));
const rule = readFileSync(join(repo, ".cursor/rules/exo-delegation.mdc"), "utf8");

describe(".cursor/mcp.json", () => {
  it("points at the loopback bridge and reads the token from EXOS_LOCAL_TOKEN with Cursor's interpolation", () => {
    const server = config.mcpServers["exos-bridge"];
    expect(server.url).toBe("http://127.0.0.1:9811/mcp");
    expect(server.headers.Authorization).toBe("Bearer ${env:EXOS_LOCAL_TOKEN}");
  });

  it("holds no literal token and only the bridge", () => {
    expect(Object.keys(config.mcpServers)).toEqual(["exos-bridge"]);
    expect(JSON.stringify(config)).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("uses the interpolation syntax recorded in the verification log", () => {
    const log = readFileSync(join(repo, "docs/exo-verification.md"), "utf8");
    expect(log).toContain("${env:NAME}");
    expect(log).toContain("cursor.com/docs/context/mcp");
  });
});

describe(".cursor/rules/exo-delegation.mdc", () => {
  it("has front matter, says when to delegate, and forbids approving without the user", () => {
    expect(rule).toMatch(/^---\ndescription: .+\nalwaysApply: false\n---\n/);
    expect(rule).toContain("exo_start_thread");
    expect(rule).toMatch(/Never approve/);
    expect(rule).toMatch(/untrusted/);
    expect(rule).toContain("dashboard_only");
  });

  it("tells the model not to poll in a loop", () => {
    expect(rule).toMatch(/Do not poll in a loop/);
  });
});

describe("validation of the Cursor files", () => {
  function copy(): string {
    const root = mkdtempSync(join(tmpdir(), "cursor-"));
    cpSync(join(repo, "plugin"), join(root, "plugin"), { recursive: true });
    cpSync(join(repo, ".cursor"), join(root, ".cursor"), { recursive: true });
    cpSync(join(repo, ".mcp.json"), join(root, ".mcp.json"));
    return root;
  }
  const messages = (root: string) => validatePlugin(root).map((p) => `${p.file}: ${p.message}`);

  it("flags a URL that is not the loopback bridge", () => {
    const root = copy();
    const c = JSON.parse(readFileSync(join(root, ".cursor/mcp.json"), "utf8"));
    c.mcpServers["exos-bridge"].url = "https://bridge.example.org/mcp";
    writeFileSync(join(root, ".cursor/mcp.json"), JSON.stringify(c));
    expect(messages(root).some((m) => m.includes("url must be http://127.0.0.1:9811/mcp"))).toBe(
      true,
    );
  });

  it("flags a token written into the file", () => {
    const root = copy();
    const c = JSON.parse(readFileSync(join(root, ".cursor/mcp.json"), "utf8"));
    c.mcpServers["exos-bridge"].headers.Authorization = `Bearer ${"a".repeat(64)}`;
    writeFileSync(join(root, ".cursor/mcp.json"), JSON.stringify(c));
    expect(messages(root).some((m) => m.includes("the token comes from the environment"))).toBe(
      true,
    );
  });

  it("flags a rule that no longer forbids approving, or names a tool that does not exist", () => {
    const root = copy();
    writeFileSync(
      join(root, ".cursor/rules/exo-delegation.mdc"),
      rule.replace(/Never approve/g, "Feel free to approve"),
    );
    expect(messages(root).some((m) => m.includes("never to approve"))).toBe(true);
    const root2 = copy();
    writeFileSync(
      join(root2, ".cursor/rules/exo-delegation.mdc"),
      rule.replace("exo_start_thread", "exo_begin_thread"),
    );
    expect(messages(root2).some((m) => m.includes("exo_begin_thread is not a bridge tool"))).toBe(
      true,
    );
  });
});
