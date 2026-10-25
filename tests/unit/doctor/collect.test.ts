import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stackSnapshotSchema } from "@exos/common";
import { runChecks } from "../../../doctor/src/checks/index.ts";
import { collectSnapshot, type Run } from "../../../doctor/src/collect.ts";

const repo = join(import.meta.dirname, "..", "..", "..");
const PIN = "f9f012730fd3bf7e061e3e947e01bd6c2bb415e9";
const KEY_VAR = ["ANTHROPIC", "API", "KEY"].join("_");
// assembled so no key-shaped literal sits in the source
const FAKE_VALUE = ["sk", "ant", "fake", "value"].join("-");

/** A copy of the definitions the collector reads, in a temp directory that tests can add files to. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-root-"));
  for (const dir of ["agents", "environments", "pricing"])
    cpSync(join(repo, dir), join(root, dir), { recursive: true });
  return root;
}

const noSystem: Run = async () => ({ ok: false, stdout: "" });

function fakeRun(over: Partial<Record<string, string>> = {}): Run {
  return async (command, args) => {
    if (command === "git" && args[0] === "ls-tree")
      return { ok: true, stdout: over.tree ?? `160000 commit ${PIN}\tvendor/exo\n` };
    if (command === "git" && args.includes("rev-parse"))
      return { ok: true, stdout: `${over.head ?? PIN}\n` };
    if (command === "git" && args.includes("status"))
      return { ok: true, stdout: over.status ?? "" };
    if (command === "ps")
      return {
        ok: true,
        stdout: over.ps ?? `/usr/local/bin/exo --root /tmp/x run --serve --bind 127.0.0.1:9810\n`,
      };
    if (command === "lsof") {
      return {
        ok: true,
        stdout:
          over.lsof ??
          [
            "node 1 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:9812 (LISTEN)",
            "node 2 u 20u IPv4 0x2 0t0 TCP [::1]:9811 (LISTEN)",
            "node 3 u 20u IPv4 0x3 0t0 TCP 127.0.0.1:9800 (LISTEN)",
            "other 4 u 20u IPv4 0x4 0t0 TCP *:5000 (LISTEN)",
          ].join("\n"),
      };
    }
    return { ok: true, stdout: command.includes("claude") ? "2.1.212 (Claude Code)\n" : "" };
  };
}

const okFetch = (usage: unknown, approvals: unknown): typeof fetch =>
  (async (url: string | URL, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
    const u = String(url);
    const body = u.includes("/usage") ? usage : approvals;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

describe("collectSnapshot on this repository's definitions", () => {
  it("builds a valid snapshot with the agents, environments, deny list and price table", async () => {
    const snap = await collectSnapshot({
      root: repo,
      env: { EXOS_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")) },
      run: noSystem,
    });
    expect(stackSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.agents.map((a) => a.slug).sort()).toEqual(
      [
        "dual-review",
        "dual-review-cursor",
        "local-harness",
        "ops-slack",
        "repo-builder",
        "repo-builder-b",
        "researcher",
        "reviewer-cursor",
      ].sort(),
    );
    expect(snap.agents.find((a) => a.slug === "ops-slack")!.adapters).toEqual([
      { type: "slack", vault: "ops-slack", allowed_channels: ["C0EXOSOPS"] },
    ]);
    expect(snap.environments.map((e) => e.name).sort()).toEqual([
      "ci-local",
      "docker-fallback",
      "host-a",
      "smolvm-default",
    ]);
    expect(snap.mode_a.bypass_disabled).toBe(true);
    expect(snap.mode_a.deny_list).toContain("Bash(rm -rf:*)");
    expect(snap.mcp_servers.map((m) => `${m.name}:${m.write_tools_policy}`).sort()).toEqual([
      "deepwiki:always_ask",
      "playwright:always_ask",
    ]);
    expect(snap.price_table.retrieved_at).toBe("2026-10-25");
    expect(snap.claude.present).toBe(false); // the stub could not run it
  });

  it("marks what it could not read as unavailable, with the reason", async () => {
    const snap = await collectSnapshot({
      root: repo,
      env: { EXOS_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")) },
      run: noSystem,
    });
    expect(Object.keys(snap.unavailable!).sort()).toEqual([
      "D-01",
      "D-02",
      "D-04",
      "D-06",
      "D-07",
      "D-16",
      "D-17",
      "D-19",
      "D-22",
    ]);
    const results = runChecks(snap);
    for (const id of Object.keys(snap.unavailable!))
      expect(results.find((r) => r.id === id)!.status, id).toBe("skip");
  });

  it("reads Exo's commit, process, listeners and submodule state when they are there", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "vendor/exo/.git"), { recursive: true });
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: join(root, "state") },
      run: fakeRun(),
    });
    expect(snap.exo).toMatchObject({ commit: PIN, pin: PIN, bind: "127.0.0.1:9810" });
    expect(snap.exo.serve_flags).toEqual(["--root", "--serve", "--bind"]);
    expect(snap.listeners).toEqual([
      { service: "stackd", host: "127.0.0.1", port: 9812 },
      { service: "bridge", host: "[::1]", port: 9811 },
      { service: "dashboard", host: "127.0.0.1", port: 9800 },
    ]); // port 5000 is not one of ours
    expect(snap.unavailable?.["D-01"]).toBeUndefined();
    expect(snap.unavailable?.["D-02"]).toBeUndefined();
    expect(snap.claude).toEqual({ present: true, version: "2.1.212" });
    const byId = Object.fromEntries(runChecks(snap).map((r) => [r.id, r.status]));
    expect(byId).toMatchObject({ "D-01": "pass", "D-02": "pass", "D-04": "pass", "D-19": "pass" });
  });

  it("flags a moved commit, a wildcard listener, a bad bind and a dirty submodule", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "vendor/exo/.git"), { recursive: true });
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: join(root, "state") },
      run: fakeRun({
        head: "0".repeat(40),
        ps: "exo run --serve --bind 0.0.0.0:9810 --multiplayer\n",
        lsof: "node 1 u 20u IPv4 0x1 0t0 TCP *:9812 (LISTEN)\n",
        status: " M crates/x.rs\n",
      }),
    });
    const failed = runChecks(snap)
      .filter((r) => r.status === "fail")
      .map((r) => r.id);
    expect(failed).toEqual(["D-01", "D-02", "D-04", "D-19"]);
  });
});

describe("collectSnapshot reads files", () => {
  it("reads variable names from every .env file and never a value", async () => {
    const root = tempRoot();
    writeFileSync(
      join(root, ".env"),
      `EXOS_STATE_DIR=.state\n# ${KEY_VAR}=commented\nexport OTHER=1\n`,
    );
    writeFileSync(join(root, ".env.local"), `${KEY_VAR}=${FAKE_VALUE}\n`);
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: join(root, "state"), PATH: "/bin" },
      run: noSystem,
    });
    expect(snap.env.files[".env"]).toEqual(["EXOS_STATE_DIR", "OTHER"]);
    expect(snap.env.files[".env.local"]).toEqual([KEY_VAR]);
    expect(JSON.stringify(snap)).not.toContain(FAKE_VALUE);
    expect(snap.env.process).toEqual(["EXOS_STATE_DIR", "PATH"]);
    expect(runChecks(snap).find((r) => r.id === "D-05")!.status).toBe("fail");
  });

  it("reads compose ports in both syntaxes, host networking and environment names", async () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "compose.yaml"),
      [
        "services:",
        "  a:",
        "    ports: ['127.0.0.1:9800:9800', '9801:9801']",
        "    environment: { SAMPLE_X: '1' }",
        "  b:",
        "    network_mode: host",
        "    ports:",
        "      - { host_ip: 127.0.0.1, published: 9811, target: 9811 }",
        "      - { published: 9812, target: 9812 }",
        "    environment: ['SAMPLE_Y=2']",
      ].join("\n"),
    );
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: join(root, "state") },
      run: noSystem,
    });
    expect(snap.compose.ports).toEqual([
      "127.0.0.1:9800:9800",
      "9801:9801",
      "127.0.0.1:9811:9811",
      "9812:9812",
    ]);
    expect(snap.compose.network_modes).toEqual(["host"]);
    expect(snap.env.compose).toEqual(["SAMPLE_X", "SAMPLE_Y"]);
    expect(runChecks(snap).find((r) => r.id === "D-03")!.status).toBe("fail");
  });

  it("finds workflows that run live targets or hold a model secret", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      "jobs:\n  t:\n    steps:\n      - run: make check-fast\n",
    );
    writeFileSync(
      join(root, ".github/workflows/nightly.yml"),
      "jobs:\n  t:\n    steps:\n      - run: make live-claude\n",
    );
    writeFileSync(
      join(root, ".github/workflows/review.yml"),
      "env:\n  K: ${{ secrets.ANTHROPIC_API_KEY }}\n",
    );
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: join(root, "state") },
      run: noSystem,
    });
    expect(snap.workflows).toEqual([
      { file: "ci.yml", runs_live_target: false, holds_model_secret: false },
      { file: "nightly.yml", runs_live_target: true, holds_model_secret: false },
      { file: "review.yml", runs_live_target: false, holds_model_secret: true },
    ]);
  });

  it("reads client MCP configs, telling stdio from URL entries", async () => {
    const root = tempRoot();
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { a: { command: "node" }, b: { url: "https://bridge.example.org/mcp" } },
      }),
    );
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor/mcp.json"), "{ not json");
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: join(root, "state") },
      run: noSystem,
    });
    expect(snap.mcp_clients[0]).toEqual({
      file: ".mcp.json",
      servers: [
        { name: "a", kind: "stdio" },
        { name: "b", kind: "url", url: "https://bridge.example.org/mcp" },
      ],
    });
    expect(runChecks(snap).find((r) => r.id === "D-21")!.status).toBe("fail"); // the remote URL, and the unreadable file
  });

  it("reads token and state modes, and flags a group-readable dashboard token", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, "local-token"), "t".repeat(64), { mode: 0o600 });
    writeFileSync(join(state, "dashboard-token"), "d".repeat(64), { mode: 0o600 });
    chmodSync(state, 0o700);
    let snap = await collectSnapshot({ root, env: { EXOS_STATE_DIR: state }, run: noSystem });
    expect(snap.permissions).toEqual({
      token_mode: "0600",
      state_dir_mode: "0700",
      dashboard_token_mode: "0600",
    });
    expect(runChecks(snap).find((r) => r.id === "D-17")!.status).toBe("pass");
    chmodSync(join(state, "dashboard-token"), 0o640);
    snap = await collectSnapshot({ root, env: { EXOS_STATE_DIR: state }, run: noSystem });
    expect(snap.permissions.dashboard_token_mode).toBe("0640");
    expect(runChecks(snap).find((r) => r.id === "D-17")!.status).toBe("fail");
  });
});

describe("collectSnapshot asks stackd", () => {
  it("takes meter lag and the dashboard-only list from the running stackd, presenting the API token", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, "local-token"), "t".repeat(64), { mode: 0o600 });
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: state },
      run: noSystem,
      fetchImpl: okFetch({ meter_lag_s: 12 }, { dashboard_only_tools: ["claude.WebFetch"] }),
    });
    expect(snap.meter.lag_seconds).toBe(12);
    expect(snap.dashboard_only_tools).toEqual(["claude.WebFetch"]);
    expect(snap.unavailable?.["D-16"]).toBeUndefined();
    expect(snap.unavailable?.["D-22"]).toBeUndefined();
  });

  it("skips D-16 until the meter has run a pass, and when stackd is unreachable", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, "local-token"), "t".repeat(64), { mode: 0o600 });
    const fresh = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: state },
      run: noSystem,
      fetchImpl: okFetch({ meter_lag_s: null }, { dashboard_only_tools: [] }),
    });
    expect(fresh.unavailable?.["D-16"]).toMatch(/not completed a pass/);
    const down = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: state },
      run: noSystem,
      fetchImpl: (async () => {
        throw new Error("refused");
      }) as typeof fetch,
    });
    expect(down.unavailable?.["D-16"]).toBe("stackd is not reachable");
    expect(down.unavailable?.["D-22"]).toBe("stackd is not reachable");
  });
});

describe("collectSnapshot does not send the token off the machine", () => {
  it("skips the stackd checks, without calling it, when EXOS_STACKD_URL is not a local address", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, "local-token"), "t".repeat(64), { mode: 0o600 });
    let calls = 0;
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: state, EXOS_STACKD_URL: "https://stackd.evil.example" },
      run: noSystem,
      fetchImpl: (async () => {
        calls++;
        return new Response("{}");
      }) as typeof fetch,
    });
    expect(calls).toBe(0);
    expect(snap.unavailable?.["D-16"]).toMatch(/not a local address/);
    expect(snap.unavailable?.["D-22"]).toMatch(/not a local address/);
  });

  it("accepts a local service name such as the compose service stackd", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, "local-token"), "t".repeat(64), { mode: 0o600 });
    const urls: string[] = [];
    await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: state, EXOS_STACKD_URL: "http://stackd:9812" },
      run: noSystem,
      fetchImpl: (async (url: string | URL) => {
        urls.push(String(url));
        return new Response("{}");
      }) as typeof fetch,
    });
    expect(urls[0]).toBe("http://stackd:9812/api/v1/usage");
  });
});

describe("collectSnapshot reads MCP write policy from the tool policies", () => {
  const withAgent = (front: string): string => {
    const root = tempRoot();
    writeFileSync(
      join(root, "agents", "zz-test.md"),
      `---\nname: zz-test\ndescription: test\nharness: ../harnesses/claude-host/harness.ts\nmodel:\n  name: claude-haiku-5-5\n${front}---\n\nbody\n`,
    );
    return root;
  };
  const policyOf = async (front: string, name = "srv") => {
    const root = withAgent(front);
    const snap = await collectSnapshot({
      root,
      env: { EXOS_STATE_DIR: join(root, "state") },
      run: noSystem,
    });
    return snap.mcp_servers.find((m) => m.agent === "zz-test" && m.name === name)!;
  };
  const server = (extra: string) =>
    `mcp_servers:\n  - type: url\n    name: srv\n    url: http://127.0.0.1:9999/mcp\n${extra}`;

  it("treats a server that asks by default as asking for writes", async () => {
    expect(
      (await policyOf(server("    permission_policy:\n      type: always_ask\n")))
        .write_tools_policy,
    ).toBe("always_ask");
  });

  it("does not, when one tool is always_allow", async () => {
    const front = server(
      "    permission_policy:\n      type: always_ask\n    tool_policies:\n      write_file:\n        type: always_allow\n",
    );
    expect((await policyOf(front)).write_tools_policy).toBe("always_allow");
  });

  it("lets a known read-only browser tool be always_allow on the playwright server", async () => {
    const front = `mcp_servers:\n  - type: url\n    name: playwright\n    url: http://127.0.0.1:9843/mcp\n    permission_policy:\n      type: always_ask\n    tool_policies:\n      browser_snapshot:\n        type: always_allow\n`;
    expect((await policyOf(front, "playwright")).write_tools_policy).toBe("always_ask");
    const bad = front + "      browser_click:\n        type: always_allow\n";
    expect((await policyOf(bad, "playwright")).write_tools_policy).toBe("always_allow");
  });

  it("treats a missing permission policy as permissive, and an always_allow server as permissive", async () => {
    expect((await policyOf(server(""))).write_tools_policy).toBe("always_allow");
    expect(
      (await policyOf(server("    permission_policy:\n      type: always_allow\n")))
        .write_tools_policy,
    ).toBe("always_allow");
  });
});
