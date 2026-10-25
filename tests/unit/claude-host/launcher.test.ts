/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC and settings payloads are schemaless in these assertions */
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runClaudeTurn, type LauncherOptions } from "../../../harnesses/claude-host/launcher.ts";
import { ENV_ALLOWLIST } from "../../../harnesses/claude-host/env.ts";

const fake = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "harnesses",
  "claude-host",
  "testing",
  "fake-claude.mjs",
);
const SECRETS = {
  [["ANTHROPIC", "API", "KEY"].join("_")]: "placeholder-1",
  [["OPENAI", "API", "KEY"].join("_")]: "placeholder-2",
  [["CLAUDE", "CODE", "OAUTH", "TOKEN"].join("_")]: "placeholder-3",
  GITHUB_TOKEN: "placeholder-4",
};

function opts(
  prompt: string,
  extra: Partial<LauncherOptions> = {},
): LauncherOptions & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    claudeBin: fake,
    worktree: realpathSync(mkdtempSync(join(tmpdir(), "wt-"))),
    runtimeBase: mkdtempSync(join(tmpdir(), "rt-")),
    prompt,
    model: "claude-opus-5-5",
    authorize: async () => ({ approved: true }),
    parentEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ...SECRETS },
    onEvent: (e) => events.push(e),
    events,
    ...extra,
  };
}

const dump = (resultText: string | undefined) =>
  JSON.parse(resultText!) as {
    env: string[];
    cwd: string;
    args: string[];
    settings: any;
    promptLength: number;
  };

describe("runClaudeTurn (Mode A launcher)", () => {
  it("runs a plain turn and returns session, result text and Exo usage", async () => {
    const o = opts("hello [[fake:plain]]");
    const r = await runClaudeTurn(o);
    expect(r).toMatchObject({
      exitCode: 0,
      sessionId: "sess-fake",
      resultText: "Hello from fake claude",
      isError: false,
      aborted: false,
    });
    expect(r.usage).toEqual({
      model: "claude-opus-5-5",
      prompt_tokens: 160,
      completion_tokens: 20,
      prompt_cached_tokens: 50,
      prompt_cache_creation_tokens: 10,
      completion_reasoning_tokens: 0,
      cost_usd: 0.01,
      duration_ms: 1000,
    });
    expect((o.events as any[]).map((e) => e.kind)).toEqual(["init", "text", "result"]);
  });

  it("gives the child no credentials: API keys in the parent do not reach it (FR-4)", async () => {
    const r = await runClaudeTurn(opts("[[fake:dump]]"));
    const info = dump(r.resultText);
    for (const name of Object.keys(SECRETS)) expect(info.env, name).not.toContain(name);
    const allowed = new Set<string>([...ENV_ALLOWLIST, "__CF_USER_TEXT_ENCODING"]);
    for (const key of info.env) expect(allowed.has(key), key).toBe(true);
  });

  it("runs in the worktree with the deny list and bypass-disabled settings in place (FR-4)", async () => {
    const o = opts("[[fake:dump]]");
    const info = dump((await runClaudeTurn(o)).resultText);
    expect(realpathSync(info.cwd)).toBe(o.worktree);
    expect(info.settings.permissions.deny).toContain("Bash(rm -rf:*)");
    expect(info.settings.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(info.settings.permissions.defaultMode).toBe("default");
  });

  it("passes the documented flags, the model and the generated MCP config", async () => {
    const info = dump((await runClaudeTurn(opts("[[fake:dump]]"))).resultText);
    expect(info.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "claude-opus-5-5",
        "--permission-prompt-tool",
        "mcp__exos_approvals__prompt",
        "--strict-mcp-config",
      ]),
    );
    expect(info.args).not.toContain("--resume");
  });

  it("resumes the given Claude session", async () => {
    const r = await runClaudeTurn(opts("[[fake:dump]]", { resumeSessionId: "sess-9" }));
    expect(dump(r.resultText).args.slice(-2)).toEqual(["--resume", "sess-9"]);
    expect(r.sessionId).toBe("sess-9");
  });

  it("delivers a large prompt intact on stdin", async () => {
    const prompt = `[[fake:dump]] ${"x".repeat(200_000)}`;
    expect(dump((await runClaudeTurn(opts(prompt))).resultText).promptLength).toBe(prompt.length);
  });

  describe("permission prompts become approval requests (FR-11)", () => {
    it("allows when the authorizer approves, naming the tool claude.Bash", async () => {
      const seen: unknown[] = [];
      const o = opts("[[fake:approve]]", {
        authorize: async (req) => {
          seen.push(req);
          return { approved: true };
        },
      });
      const r = await runClaudeTurn(o);
      expect(seen).toEqual([
        { name: "claude.Bash", arguments: { command: "git push origin main" } },
      ]);
      expect(r.resultText).toBe("ran the command");
      expect(
        (o.events as any[]).some((e) => e.kind === "tool_result" && e.output === "pushed"),
      ).toBe(true);
    });

    it("denies when the authorizer refuses and tells Claude why", async () => {
      const r = await runClaudeTurn(
        opts("[[fake:approve]]", {
          authorize: async () => ({ approved: false, reason: "dashboard only" }),
        }),
      );
      expect(r.resultText).toBe("denied: dashboard only");
    });

    it("denies (fails closed) when the authorizer throws", async () => {
      const r = await runClaudeTurn(
        opts("[[fake:approve]]", {
          authorize: async () => {
            throw new Error("exo down");
          },
        }),
      );
      expect(r.resultText).toMatch(/^denied: approval failed/);
    });
  });

  it("reports claude_not_found when the binary is missing", async () => {
    await expect(
      runClaudeTurn(opts("x", { claudeBin: "/nonexistent/claude" })),
    ).rejects.toMatchObject({ code: "claude_not_found" });
  });

  it("reports a crash with the exit code and the stderr tail", async () => {
    const r = await runClaudeTurn(opts("[[fake:crash]]"));
    expect(r).toMatchObject({ exitCode: 3, isError: true });
    expect(r.stderrTail).toContain("boom: something broke");
  });

  it("treats a stream with no result message as an error even on exit 0", async () => {
    const r = await runClaudeTurn(opts("[[fake:noresult]]"));
    expect(r.exitCode).toBe(0);
    expect(r).toMatchObject({ isError: true, errorReason: expect.stringMatching(/no result/i) });
  });

  it("reports an error result with its subtype", async () => {
    const r = await runClaudeTurn(opts("[[fake:error-result]]"));
    expect(r).toMatchObject({ isError: true, subtype: "error_max_turns" });
  });

  it("tolerates malformed stream lines and counts them", async () => {
    const r = await runClaudeTurn(opts("[[fake:badlines]]"));
    expect(r).toMatchObject({ isError: false, resultText: "still fine", badLines: 1 });
  });

  it("kills the process when aborted", async () => {
    const ctl = new AbortController();
    const started = Date.now();
    const p = runClaudeTurn(
      opts("[[fake:hang]]", { signal: ctl.signal, onEvent: () => ctl.abort() }),
    );
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("leaves no socket or MCP config behind", async () => {
    const o = opts("[[fake:approve]]");
    await runClaudeTurn(o);
    const leftovers = existsSync(o.runtimeBase!) ? readdirSync(o.runtimeBase!) : [];
    expect(leftovers).toEqual([]);
  });
});
