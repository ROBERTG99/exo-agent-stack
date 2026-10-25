import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stackSnapshotSchema } from "@exos/common";
import {
  loadAllowlists,
  loadEnvironments,
  resolveAllowedHosts,
  snapshotEnvironments,
} from "../../doctor/src/environments.ts";

const dir = join(import.meta.dirname, "..", "..", "environments");
const envs = loadEnvironments(dir);
const allowlists = loadAllowlists(join(dir, "allowlists.yaml"));
const byName = Object.fromEntries(envs.map((e) => [e.name, e]));

describe("the four environments (BUILD.md §4.5)", () => {
  it("are smolvm-default, docker-fallback, host-a and ci-local", () => {
    expect(envs.map((e) => e.name).sort()).toEqual([
      "ci-local",
      "docker-fallback",
      "host-a",
      "smolvm-default",
    ]);
  });

  it("smolvm-default: 2 vCPU, 4096 MiB, idle 900 s, limited networking on 443 with per-agent hosts", () => {
    const e = byName["smolvm-default"]!;
    expect(e.provider).toBe("smolvm");
    expect(e.resources).toEqual({ vcpus: 2, memory_mib: 4096, idle_seconds: 900 });
    expect(e.network).toEqual({
      mode: "limited",
      allowed_tcp_ports: [443],
      allowed_hosts_from: "allowlists.yaml",
    });
    expect(e.vault_backed_agents).toBe("allowed");
  });

  it("docker-fallback: for Linux without KVM, limited networking, no vault-backed agents", () => {
    const e = byName["docker-fallback"]!;
    expect(e.provider).toBe("docker");
    expect(e.network.mode).toBe("limited");
    expect(e.vault_backed_agents).toBe("forbidden");
  });

  it("host-a: a local process that mounts only the thread worktree", () => {
    const e = byName["host-a"]!;
    expect(e.provider).toBe("local_process");
    expect(e.mounts).toEqual(["{{worktree}}"]);
    expect(e.vault_backed_agents).toBe("forbidden");
  });

  it("ci-local: a local process with no mounts and no network, for the scripted harness", () => {
    const e = byName["ci-local"]!;
    expect(e.provider).toBe("local_process");
    expect(e.mounts).toEqual([]);
    expect(e.network.mode).toBe("none");
  });

  it("every sandboxed environment is limited (doctor D-09) and none opens a port other than 443", () => {
    for (const e of envs.filter((x) => x.provider !== "local_process")) {
      expect(e.network.mode, e.name).toBe("limited");
      expect(e.network.allowed_tcp_ports ?? [], e.name).toEqual([443]);
    }
  });
});

describe("allowlists.yaml", () => {
  it("lists the hosts of BUILD.md §4.5 for repo-builder-b and researcher-b", () => {
    expect(allowlists["repo-builder-b"]).toEqual([
      "api.anthropic.com",
      "github.com",
      "api.github.com",
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
    ]);
    expect(allowlists["researcher-b"]).toEqual(["api.anthropic.com"]);
  });

  it("leaves reviewer-cursor empty until the Cursor SDK hosts are read from the pinned source", () => {
    expect(allowlists["reviewer-cursor"]).toEqual([]);
  });

  it("holds only plain lowercase DNS names: no wildcards, schemes, ports, paths or IP literals", () => {
    for (const [agent, hosts] of Object.entries(allowlists)) {
      expect(new Set(hosts).size, agent).toBe(hosts.length);
      for (const h of hosts) {
        expect(h, `${agent}: ${h}`).toMatch(
          /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/,
        );
        expect(h).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      }
    }
  });

  it("names only agents that exist", () => {
    for (const agent of Object.keys(allowlists)) {
      expect(["repo-builder-b", "reviewer-cursor", "researcher-b"], agent).toContain(agent);
    }
  });
});

describe("resolveAllowedHosts", () => {
  it("returns the hosts of one agent, sorted, for a limited environment", () => {
    expect(resolveAllowedHosts(byName["smolvm-default"]!, allowlists, "researcher-b")).toEqual([
      "api.anthropic.com",
    ]);
    expect(resolveAllowedHosts(byName["smolvm-default"]!, allowlists, "repo-builder-b")).toEqual([
      "api.anthropic.com",
      "api.github.com",
      "files.pythonhosted.org",
      "github.com",
      "pypi.org",
      "registry.npmjs.org",
    ]);
  });

  it("allows nothing for an agent with no entry, and for environments without limited networking", () => {
    expect(resolveAllowedHosts(byName["smolvm-default"]!, allowlists, "repo-builder")).toEqual([]);
    expect(resolveAllowedHosts(byName["host-a"]!, allowlists, "repo-builder-b")).toEqual([]);
    expect(resolveAllowedHosts(byName["ci-local"]!, allowlists, "repo-builder-b")).toEqual([]);
  });
});

describe("snapshotEnvironments (what doctor D-09 and D-10 read)", () => {
  const snap = snapshotEnvironments(envs, allowlists);

  it("produces entries and allowlists that fit the StackSnapshot schema", () => {
    const shape = stackSnapshotSchema.shape;
    expect(shape.environments.safeParse(snap.environments).success).toBe(true);
    expect(shape.allowlists.safeParse(snap.allowlists).success).toBe(true);
  });

  it("flags the sandbox hosts as the union of the allowlists and none for local processes", () => {
    const smol = snap.environments.find((e) => e.name === "smolvm-default")!;
    expect(smol.networking).toBe("limited");
    expect(smol.allowed_hosts).toEqual([...new Set(Object.values(allowlists).flat())].sort());
    const host = snap.environments.find((e) => e.name === "host-a")!;
    expect(host).toMatchObject({
      provider: "local_process",
      allowed_hosts: [],
      mounts: ["{{worktree}}"],
    });
  });
});

describe("loading errors name the file", () => {
  function envDir(files: Record<string, string>) {
    const d = mkdtempSync(join(tmpdir(), "envs-"));
    mkdirSync(d, { recursive: true });
    for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
    return d;
  }
  const good =
    "name: x\nprovider: docker\nnetwork:\n  mode: limited\n  allowed_tcp_ports: [443]\n  allowed_hosts_from: allowlists.yaml\nmounts: []\nvault_backed_agents: forbidden\n";

  it.each([
    ["an unknown key", `${good}bogus: 1\n`],
    ["an unknown provider", good.replace("docker", "lxc")],
    ["a name that differs from the file", good.replace("name: x", "name: y")],
    [
      "limited networking without ports",
      good.replace("allowed_tcp_ports: [443]", "allowed_tcp_ports: []"),
    ],
    ["a port other than 443", good.replace("[443]", "[443, 22]")],
    ["invalid YAML", "name: [x"],
  ])("rejects %s", (_n, text) => {
    expect(() => loadEnvironments(envDir({ "x.yaml": text }))).toThrow(/x\.yaml/);
  });

  it("rejects a wildcard, scheme or IP in an allowlist", () => {
    for (const host of [
      "*.github.com",
      "https://github.com",
      "10.0.0.1",
      "GitHub.com",
      "github.com:443",
    ]) {
      const f = join(envDir({ "a.yaml": `repo-builder-b:\n  - "${host}"\n` }), "a.yaml");
      expect(() => loadAllowlists(f), host).toThrow(/allowlist|host/i);
    }
  });

  it("accepts a valid minimal environment", () => {
    expect(loadEnvironments(envDir({ "x.yaml": good }))[0]!.name).toBe("x");
  });
});
