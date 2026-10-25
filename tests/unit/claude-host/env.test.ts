import { describe, expect, it } from "vitest";
import { ENV_ALLOWLIST, childEnv } from "../../../harnesses/claude-host/env.ts";

// Credential variable names are assembled so this file never holds a literal assignment.
const SECRET_NAMES = [
  ["ANTHROPIC", "API", "KEY"].join("_"),
  ["ANTHROPIC", "AUTH", "TOKEN"].join("_"),
  ["OPENAI", "API", "KEY"].join("_"),
  ["OPENROUTER", "API", "KEY"].join("_"),
  ["CLAUDE", "CODE", "OAUTH", "TOKEN"].join("_"),
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "EXOS_LOCAL_TOKEN",
  "SSH_AUTH_SOCK",
];

describe("childEnv (FR-4: the child never inherits credentials)", () => {
  it("drops API keys and every other variable outside the allowlist", () => {
    const parent: Record<string, string> = { PATH: "/usr/bin", HOME: "/Users/someone" };
    for (const name of SECRET_NAMES) parent[name] = "placeholder-value";
    parent.SOME_OTHER_THING = "x";
    const env = childEnv(parent);
    for (const name of SECRET_NAMES) expect(env, name).not.toHaveProperty(name);
    expect(env).not.toHaveProperty("SOME_OTHER_THING");
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/someone" });
  });

  it("keeps exactly the allowlisted variables when present", () => {
    expect([...ENV_ALLOWLIST]).toEqual([
      "PATH",
      "HOME",
      "LANG",
      "TERM",
      "TMPDIR",
      "CLAUDE_CONFIG_DIR",
    ]);
    const parent = Object.fromEntries(ENV_ALLOWLIST.map((k) => [k, `v-${k}`]));
    expect(childEnv(parent)).toEqual(parent);
  });

  it("skips variables that are undefined and does not mutate the parent", () => {
    const parent = { PATH: "/bin", LANG: undefined, [SECRET_NAMES[0]!]: "x" };
    const snapshot = { ...parent };
    const env = childEnv(parent);
    expect(env).toEqual({ PATH: "/bin" });
    expect(parent).toEqual(snapshot);
  });

  it("returns a fresh object of strings only", () => {
    const parent = { PATH: "/bin" };
    const env = childEnv(parent);
    expect(env).not.toBe(parent);
    for (const v of Object.values(env)) expect(typeof v).toBe("string");
  });

  it("is case-sensitive: a lowercase look-alike is not allowed through", () => {
    expect(childEnv({ path: "/x", Home: "/y" })).toEqual({});
  });
});
