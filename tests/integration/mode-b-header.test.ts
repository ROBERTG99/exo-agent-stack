import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFakeModel } from "@exos/fake-model/server";
import { modeBEnv } from "../../harnesses/claude-sandboxed/mode-b-env.ts";

const fakeClaudeB = join(
  import.meta.dirname,
  "..",
  "..",
  "harnesses",
  "claude-sandboxed",
  "testing",
  "fake-claude-b.mjs",
);
const MODEL_KEY_VAR = ["ANTHROPIC", "API", "KEY"].join("_");

const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function startModel() {
  const app = await buildFakeModel();
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

function runChild(env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [fakeClaudeB], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("Mode B: the model API sees the Exo placeholder as a bearer token (FR-5)", () => {
  it("sends Authorization: Bearer exo_egress_test and no x-api-key", async () => {
    const { app, url } = await startModel();
    const env = modeBEnv({
      [MODEL_KEY_VAR]: "exo_egress_test",
      PATH: process.env.PATH ?? "",
      ANTHROPIC_BASE_URL: url,
    });
    const r = await runChild(env);
    expect(r.code, r.stderr).toBe(0);

    const log = (
      await app.inject({ method: "GET", url: "/__test/requests?path=/v1/messages" })
    ).json() as {
      requests: { headers: Record<string, string> }[];
    };
    expect(log.requests).toHaveLength(1);
    expect(log.requests[0]!.headers.authorization).toBe("Bearer exo_egress_test");
    expect(log.requests[0]!.headers).not.toHaveProperty("x-api-key");
  });

  it("the child process never sees the API key variable", async () => {
    const { url } = await startModel();
    const env = modeBEnv({
      [MODEL_KEY_VAR]: "exo_egress_test",
      PATH: process.env.PATH ?? "",
      ANTHROPIC_BASE_URL: url,
    });
    const r = await runChild(env);
    const seen = JSON.parse(r.stdout.trim()) as { env: string[] };
    expect(seen.env).not.toContain(MODEL_KEY_VAR);
    expect(seen.env).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(seen.env).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
  });

  it("does not run at all when the credential is not a placeholder", () => {
    expect(() => modeBEnv({ [MODEL_KEY_VAR]: "not-a-placeholder", PATH: "/usr/bin" })).toThrow();
  });
});
