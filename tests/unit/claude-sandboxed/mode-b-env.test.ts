import { describe, expect, it } from "vitest";
import {
  ModeBPlaceholderError,
  PLACEHOLDER_PREFIX,
  modeBEnv,
} from "../../../harnesses/claude-sandboxed/mode-b-env.ts";

// The sandbox variable Exo binds the model credential to (assembled so no literal assignment exists).
const MODEL_KEY_VAR = ["ANTHROPIC", "API", "KEY"].join("_");
const sandbox = (extra: Record<string, string> = {}) => ({
  [MODEL_KEY_VAR]: `${PLACEHOLDER_PREFIX}test`,
  PATH: "/usr/bin",
  HOME: "/home/sandbox",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9840",
  ...extra,
});

describe("modeBEnv (BUILD.md §4.7 Mode B)", () => {
  it("hands the placeholder to Claude Code as its OAuth token and removes the API key variable", () => {
    const env = modeBEnv(sandbox());
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("exo_egress_test");
    expect(env).not.toHaveProperty(MODEL_KEY_VAR);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("forwards only the variables Exo's own claude-code harness forwards, plus a minimal base environment", () => {
    const env = modeBEnv(
      sandbox({
        CLAUDE_CONFIG_DIR: "/home/sandbox/.claude",
        TRACEPARENT: "00-aa-bb-01",
        TRACESTATE: "k=v",
        LANG: "C.UTF-8",
        TERM: "xterm",
        TMPDIR: "/tmp",
        GITHUB_TOKEN: "not-forwarded",
        SOMETHING_ELSE: "not-forwarded",
      }),
    );
    expect(Object.keys(env).sort()).toEqual(
      [
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "LANG",
        "PATH",
        "TERM",
        "TMPDIR",
        "TRACEPARENT",
        "TRACESTATE",
      ].sort(),
    );
  });

  it("refuses anything that is not an Exo egress placeholder, so a real credential can never be passed on", () => {
    const realLooking = ["sk", "ant", "oat01", "x".repeat(24)].join("-");
    for (const value of [
      realLooking,
      "Bearer exo_egress_x",
      "exo_egress",
      "",
      "  exo_egress_x",
      "exo_egress_x\nSECOND=1",
      "exo_egress_" + "x".repeat(300),
    ]) {
      expect(() => modeBEnv(sandbox({ [MODEL_KEY_VAR]: value })), JSON.stringify(value)).toThrow(
        ModeBPlaceholderError,
      );
    }
  });

  it("fails clearly when no credential is bound to the sandbox", () => {
    const env = sandbox();
    delete (env as Record<string, string>)[MODEL_KEY_VAR];
    expect(() => modeBEnv(env)).toThrow(/credential/i);
  });

  it("does not modify its input", () => {
    const input = sandbox();
    const copy = { ...input };
    modeBEnv(input);
    expect(input).toEqual(copy);
  });
});
