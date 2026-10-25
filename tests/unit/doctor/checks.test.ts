import { describe, expect, it } from "vitest";
import type { StackSnapshot } from "@exos/common";
import { DENY_RULES } from "../../../harnesses/claude-host/settings.ts";
import { CHECKS, REQUIRED_DENY_RULES, runChecks } from "../../../doctor/src/checks/index.ts";
import { cleanSnapshot } from "../../../data/generator/src/suites/policy.ts";

const run = (s: StackSnapshot, id: string) => runChecks(s).find((r) => r.id === id)!;
const status = (mutate: (s: StackSnapshot) => void, id: string) => {
  const s = cleanSnapshot();
  mutate(s);
  return run(s, id).status;
};

describe("the check list", () => {
  it("has the 22 checks of §15.4 in order, each with a title", () => {
    expect(CHECKS.map((c) => c.id)).toEqual(
      Array.from({ length: 22 }, (_, i) => `D-${String(i + 1).padStart(2, "0")}`),
    );
    for (const c of CHECKS) expect(c.title.length, c.id).toBeGreaterThan(10);
  });

  it("passes or warns on a clean stack, with evidence, and a fix whenever it is not a pass", () => {
    for (const r of runChecks(cleanSnapshot())) {
      expect(["pass", "warn", "skip"], r.id).toContain(r.status);
      expect(r.evidence.length, r.id).toBeGreaterThan(5);
      if (r.status === "warn") expect(r.fix.length, r.id).toBeGreaterThan(10);
    }
  });

  it("gives a failing check a fix", () => {
    const s = cleanSnapshot();
    s.exo.commit = "1".repeat(40);
    const r = run(s, "D-01");
    expect(r.status).toBe("fail");
    expect(r.evidence).toContain("111111111111");
    expect(r.fix).toContain("pin");
  });

  it("requires the deny rules that Mode A really writes", () => {
    for (const rule of REQUIRED_DENY_RULES) expect(DENY_RULES, rule).toContain(rule);
  });

  it("skips a check whose facts could not be collected, and says why", () => {
    const s = cleanSnapshot();
    s.unavailable = { "D-06": "needs a built Exo", "D-04": "nothing is running" };
    expect(run(s, "D-06")).toMatchObject({ status: "skip", evidence: "needs a built Exo" });
    expect(run(s, "D-04").status).toBe("skip");
    expect(run(s, "D-05").status).toBe("pass");
  });

  it("reports a crashed check as a failure, never a pass", () => {
    const s = cleanSnapshot();
    (s as unknown as { vault: unknown }).vault = null;
    expect(run(s, "D-06")).toMatchObject({
      status: "fail",
      evidence: expect.stringContaining("crashed"),
    });
  });
});

describe("check details", () => {
  it("D-01 skips without a checkout", () => {
    expect(status((s) => void ((s.exo.commit = ""), (s.exo.pin = "")), "D-01")).toBe("skip");
  });

  it("D-02 accepts localhost and IPv6 loopback, catches --flag=value forms", () => {
    expect(status((s) => void (s.exo.bind = "localhost:9810"), "D-02")).toBe("pass");
    expect(status((s) => void (s.exo.bind = "[::1]:9810"), "D-02")).toBe("pass");
    expect(status((s) => void s.exo.serve_flags.push("--auth-file=/x"), "D-02")).toBe("fail");
    expect(status((s) => void (s.exo.bind = "0.0.0.0:9810"), "D-02")).toBe("fail");
    expect(status((s) => void (s.exo.bind = "10.0.0.5:9810"), "D-02")).toBe("fail");
  });

  it("D-03 catches bare ports, other addresses and host networking", () => {
    expect(status((s) => void s.compose.ports.push("9801"), "D-03")).toBe("fail");
    expect(status((s) => void s.compose.ports.push("0.0.0.0:9801:9801"), "D-03")).toBe("fail");
    expect(status((s) => void s.compose.ports.push("[::1]:9801:9801"), "D-03")).toBe("pass");
    expect(status((s) => void s.compose.network_modes.push("host"), "D-03")).toBe("fail");
  });

  it("D-04 skips when nothing listens", () => {
    expect(status((s) => void (s.listeners = []), "D-04")).toBe("skip");
  });

  it("D-05 catches all four variables in every place", () => {
    const names = [
      ["ANTHROPIC", "AUTH", "TOKEN"],
      ["OPENROUTER", "API", "KEY"],
    ].map((p) => p.join("_"));
    for (const n of names) {
      expect(
        status((s) => void s.env.compose.push(n), "D-05"),
        n,
      ).toBe("fail");
      expect(
        status((s) => void (s.env.files[".env.local"] = [n]), "D-05"),
        n,
      ).toBe("fail");
    }
    expect(status((s) => void s.env.process.push("ANTHROPIC_MODEL_NOTE"), "D-05")).toBe("pass");
  });

  it("D-06 lets claude-oauth have api.anthropic.com and nothing else", () => {
    expect(status(() => undefined, "D-06")).toBe("pass");
    expect(
      status((s) => void s.vault.secrets.push({ name: "OpenRouter-backup", origins: [] }), "D-06"),
    ).toBe("fail");
    expect(
      status(
        (s) => void s.vault.secrets.push({ name: "x", origins: ["https://openrouter.ai/api"] }),
        "D-06",
      ),
    ).toBe("fail");
  });

  it("D-07 and D-08 detail", () => {
    expect(status((s) => void (s.vault.identities = 2), "D-07")).toBe("fail");
    expect(
      status(
        (s) => void (s.agents[0]!.adapters = [{ type: "discord", allowed_channels: [] }]),
        "D-08",
      ),
    ).toBe("pass");
  });

  it("D-09 allows full networking only where there is no sandbox", () => {
    expect(
      status(
        (s) => void (s.environments.find((e) => e.name === "docker-fallback")!.networking = "none"),
        "D-09",
      ),
    ).toBe("fail");
    expect(
      status(
        (s) => void (s.environments.find((e) => e.name === "host-a")!.networking = "full"),
        "D-09",
      ),
    ).toBe("pass");
  });

  it("D-10 warns when a shared environment gives an agent hosts beyond its own list", () => {
    const r = run(cleanSnapshot(), "D-10");
    expect(r.status).toBe("warn");
    expect(r.evidence).toContain("reviewer-cursor");
    expect(
      status(
        (s) => void (s.agents = s.agents.filter((a) => a.environment !== "smolvm-default")),
        "D-10",
      ),
    ).toBe("pass");
  });

  it("D-12 names what is missing", () => {
    const s = cleanSnapshot();
    s.mode_a.deny_list = [];
    s.mode_a.mount = "repo";
    const r = run(s, "D-12");
    expect(r.status).toBe("fail");
    expect(r.evidence).toContain("deny list lacks");
    expect(r.evidence).toContain("repo");
  });

  it("D-13 warns without claude", () => {
    expect(status((s) => void (s.claude = { present: false }), "D-13")).toBe("warn");
  });

  it("D-14 is a warning where Mode B is unsupported, a failure where it is mis-set", () => {
    expect(status(() => undefined, "D-14")).toBe("warn");
    expect(
      status(
        (s) =>
          void (s.mode_b = {
            provider: "smolvm",
            substitution_verified: true,
            secret_origin: "https://api.anthropic.com",
          }),
        "D-14",
      ),
    ).toBe("pass");
    expect(
      status(
        (s) =>
          void (s.mode_b = {
            provider: "smolvm",
            substitution_verified: false,
            secret_origin: "https://api.anthropic.com",
          }),
        "D-14",
      ),
    ).toBe("warn");
    expect(
      status((s) => void (s.mode_b = { provider: "docker", substitution_verified: true }), "D-14"),
    ).toBe("fail");
    expect(
      status(
        (s) =>
          void (s.mode_b = {
            provider: "smolvm",
            substitution_verified: true,
            secret_origin: "https://example.org",
          }),
        "D-14",
      ),
    ).toBe("fail");
  });

  it("D-15 skips without a secret, warns without recorded hosts, fails off the list", () => {
    expect(status((s) => void (s.cursor = {}), "D-15")).toBe("skip");
    expect(status((s) => void (s.allowlists["reviewer-cursor"] = []), "D-15")).toBe("warn");
    expect(
      status((s) => void (s.cursor = { secret_origin: "https://elsewhere.example.org" }), "D-15"),
    ).toBe("fail");
  });

  it("D-16 has three bands and notes uncounted external turns", () => {
    expect(status((s) => void (s.meter.lag_seconds = 61), "D-16")).toBe("warn");
    expect(status((s) => void (s.meter.lag_seconds = 301), "D-16")).toBe("fail");
    expect(status((s) => void (s.meter.external_turns = 3), "D-16")).toBe("warn");
    const s = cleanSnapshot();
    delete s.meter.external_turns;
    expect(run(s, "D-16").evidence).toContain("not counted");
  });

  it("D-17 checks all three modes and reads several spellings", () => {
    expect(status((s) => void (s.permissions.state_dir_mode = "0755"), "D-17")).toBe("fail");
    expect(status((s) => void (s.permissions.dashboard_token_mode = "0640"), "D-17")).toBe("fail");
    expect(status((s) => void (s.permissions.token_mode = "600"), "D-17")).toBe("pass");
    expect(status((s) => void (s.permissions.token_mode = "0o400"), "D-17")).toBe("pass");
    expect(status((s) => void (s.permissions.token_mode = "rw-------"), "D-17")).toBe("fail");
  });

  it("D-18 warns at 120 days and not before", () => {
    expect(
      status(
        (s) => void (s.price_table = { retrieved_at: "2026-06-28", now: "2026-10-25" }),
        "D-18",
      ),
    ).toBe("pass"); // 119 days
    expect(
      status(
        (s) => void (s.price_table = { retrieved_at: "2026-06-27", now: "2026-10-25" }),
        "D-18",
      ),
    ).toBe("warn"); // 120 days
    expect(
      status((s) => void (s.price_table = { retrieved_at: "garbage", now: "2026-10-25" }), "D-18"),
    ).toBe("fail");
  });

  it("D-19 passes a recorded patch", () => {
    expect(
      status(
        (s) => void ((s.submodule.dirty = true), (s.submodule.patches_recorded = true)),
        "D-19",
      ),
    ).toBe("pass");
  });

  it("D-20 allows the optional review workflow's secret as a warning only", () => {
    expect(
      status(
        (s) =>
          void s.workflows.push({
            file: "claude-review.yml",
            runs_live_target: false,
            holds_model_secret: true,
          }),
        "D-20",
      ),
    ).toBe("warn");
    expect(
      status(
        (s) =>
          void s.workflows.push({
            file: "other.yml",
            runs_live_target: false,
            holds_model_secret: true,
          }),
        "D-20",
      ),
    ).toBe("fail");
    expect(status((s) => void (s.workflows = []), "D-20")).toBe("pass");
  });

  it("D-21 treats an unreadable URL as not loopback", () => {
    expect(
      status(
        (s) => void s.mcp_clients[0]!.servers.push({ name: "x", kind: "url", url: "not a url" }),
        "D-21",
      ),
    ).toBe("fail");
    expect(
      status((s) => void s.mcp_clients[0]!.servers.push({ name: "x", kind: "url" }), "D-21"),
    ).toBe("fail");
  });
});
