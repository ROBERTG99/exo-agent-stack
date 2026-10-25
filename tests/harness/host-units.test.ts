// T-33: the launchd and systemd units, the render command and the host scripts.
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostCommand, renderUnits, type RenderOptions } from "../../cli/src/commands/host.ts";

const repo = join(import.meta.dirname, "..", "..");
const state = "/home/user/.exos-state";
const base = (over: Partial<RenderOptions> = {}): RenderOptions => ({
  platform: "launchd",
  repo: "/home/user/exo-agent-stack",
  stateDir: state,
  node: "/usr/local/bin/node",
  home: "/home/user",
  path: "/usr/local/bin:/usr/bin:/bin",
  workspaceRoots: "/home/user/dev:/home/user/work",
  exoBin: "/home/user/exo-agent-stack/vendor/exo/target/release/exo",
  templatesRoot: repo,
  ...over,
});

describe("unit templates", () => {
  it("exist for the three long-running services on both platforms", () => {
    expect(readdirSync(join(repo, "deploy/launchd")).sort()).toEqual([
      "com.exos.bridge.plist.template",
      "com.exos.exo.plist.template",
      "com.exos.stackd.plist.template",
    ]);
    expect(readdirSync(join(repo, "deploy/systemd")).sort()).toEqual([
      "exos-bridge.service.template",
      "exos-exo.service.template",
      "exos-stackd.service.template",
    ]);
  });

  it("never bind anything but loopback and never mention a key or a token value", () => {
    for (const dir of ["launchd", "systemd"]) {
      for (const f of readdirSync(join(repo, "deploy", dir))) {
        const text = readFileSync(join(repo, "deploy", dir, f), "utf8");
        expect(text, f).not.toContain("0.0.0.0");
        expect(text, f).not.toMatch(/API_KEY|AUTH_TOKEN|OAUTH/);
        if (f.includes("exo.")) expect(text, f).toContain("127.0.0.1:9810");
        else expect(text, f).toContain("127.0.0.1");
      }
    }
  });
});

describe("rendered launchd agents", () => {
  const { files, notes } = renderUnits(base());
  const byName = Object.fromEntries(files.map((f) => [f.name, f.content]));

  it("renders one agent per service, restarting on exit and starting at login", () => {
    expect(Object.keys(byName).sort()).toEqual([
      "com.exos.bridge.plist",
      "com.exos.exo.plist",
      "com.exos.stackd.plist",
    ]);
    expect(notes).toEqual([]);
    for (const [name, text] of Object.entries(byName)) {
      expect(text, name).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
      expect(text, name).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
      expect(text, name).toContain(`<string>${state}/logs/`);
      expect(text, name).toContain("<key>EXOS_LISTEN_HOST</key>\n    <string>127.0.0.1</string>");
      expect(text, name).not.toMatch(/@[A-Z_]+@/);
    }
  });

  it("starts node with an absolute path, in the repository, and gives stackd its workspace roots", () => {
    expect(byName["com.exos.stackd.plist"]).toContain("<string>/usr/local/bin/node</string>");
    expect(byName["com.exos.stackd.plist"]).toContain(
      "<key>WorkingDirectory</key>\n  <string>/home/user/exo-agent-stack</string>",
    );
    expect(byName["com.exos.stackd.plist"]).toContain(
      "<string>/home/user/dev:/home/user/work</string>",
    );
    expect(byName["com.exos.bridge.plist"]).not.toContain("WORKSPACE_ROOTS");
  });

  it("starts Exo with the pinned binary, a root of its own and a loopback bind", () => {
    const exo = byName["com.exos.exo.plist"]!;
    expect(exo).toContain(
      "<string>/home/user/exo-agent-stack/vendor/exo/target/release/exo</string>",
    );
    expect(exo).toContain(`<string>${state}/exo</string>`);
    expect(exo).toContain("<string>127.0.0.1:9810</string>");
    expect(exo).not.toContain("--auth-file");
    expect(exo).not.toContain("--multiplayer");
  });

  it("is well-formed XML property-list (plutil -lint, where available)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plist-"));
    const out: string[] = [];
    for (const f of files) {
      const p = join(dir, f.name);
      execFileSync("tee", [p], { input: f.content, stdio: ["pipe", "ignore", "inherit"] });
      out.push(p);
    }
    const probe = spawnSync("plutil", ["-help"], { stdio: "ignore" });
    if (probe.error) return; // not macOS: the structure checks above stand in
    for (const p of out) {
      const r = spawnSync("plutil", ["-lint", p], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  });

  it("escapes XML in values", () => {
    const { files: f } = renderUnits(base({ path: "/usr/bin:/opt/a&b" }));
    expect(f.find((x) => x.name === "com.exos.bridge.plist")!.content).toContain("/opt/a&amp;b");
  });
});

describe("rendered systemd units", () => {
  const { files } = renderUnits(base({ platform: "systemd" }));
  const byName = Object.fromEntries(files.map((f) => [f.name, f.content]));

  it("renders one user unit per service that restarts on failure and is hardened", () => {
    expect(Object.keys(byName).sort()).toEqual([
      "exos-bridge.service",
      "exos-exo.service",
      "exos-stackd.service",
    ]);
    for (const [name, text] of Object.entries(byName)) {
      expect(text, name).toMatch(/^Restart=on-failure$/m);
      expect(text, name).toMatch(/^NoNewPrivileges=true$/m);
      expect(text, name).toMatch(/^PrivateTmp=true$/m);
      expect(text, name).toMatch(/^Environment=EXOS_LISTEN_HOST=127\.0\.0\.1$/m);
      expect(text, name).toMatch(/^ExecStart=\//m); // systemd needs an absolute executable
      expect(text, name).toMatch(/^WantedBy=default\.target$/m); // a user unit, not multi-user
      expect(text, name).not.toMatch(/@[A-Z_]+@/);
    }
  });

  it("leaves the user's repositories writable so stackd can add worktrees", () => {
    for (const text of Object.values(byName)) {
      expect(text).toMatch(/^ProtectSystem=full$/m);
      expect(text).not.toContain("ProtectSystem=strict");
      expect(text).not.toContain("ProtectHome");
    }
  });

  it("orders the services and passes the workspace roots only to stackd", () => {
    expect(byName["exos-stackd.service"]).toMatch(/^After=exos-exo\.service$/m);
    expect(byName["exos-bridge.service"]).toMatch(/^After=exos-stackd\.service$/m);
    expect(byName["exos-stackd.service"]).toContain(
      "Environment=EXOS_ALLOWED_WORKSPACE_ROOTS=/home/user/dev:/home/user/work",
    );
    expect(byName["exos-bridge.service"]).not.toContain("WORKSPACE_ROOTS");
  });
});

describe("renderUnits refuses what a unit file cannot hold", () => {
  it.each([
    ["a relative repo", { repo: "exo" }],
    ["a state dir with a space", { stateDir: "/home/my user/.exos" }],
    ["a node path with a specifier", { node: "/opt/%h/node" }],
    ["a home with a quote", { home: '/home/"u"' }],
    ["a relative workspace root", { workspaceRoots: "dev" }],
    ["a workspace root with a variable", { workspaceRoots: "/home/$USER/dev" }],
  ])("%s", (_name, over) => {
    expect(() => renderUnits(base(over as Partial<RenderOptions>))).toThrow(
      /absolute|unit file|workspace root/,
    );
  });

  it("writes no Exo unit, and says why, when Exo is not built", () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const r = renderUnits(base({ platform, exoBin: undefined }));
      expect(
        r.files
          .map((f) => f.name)
          .some((n) => /^(com\.exos\.exo\.plist|exos-exo\.service)$/.test(n)),
      ).toBe(false);
      expect(r.files).toHaveLength(2);
      expect(r.notes[0]).toContain("Exo is not built");
    }
  });
});

describe("exos host render", () => {
  it("writes the files and prints the install commands without running them", async () => {
    const out = mkdtempSync(join(tmpdir(), "units-"));
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await hostCommand(
      [
        "render",
        "--platform",
        "systemd",
        "--out",
        out,
        "--repo",
        repo,
        "--state-dir",
        "/tmp/exos-state-x",
      ],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        out: (l) => void lines.push(l),
        err: (l) => void errs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(readdirSync(out).sort()).toContain("exos-stackd.service");
    expect(lines.join("\n")).toContain("systemctl --user enable --now");
    expect(lines.join("\n")).toContain("To install (you run these)");
  });

  it("needs a platform and refuses a non-loopback host", async () => {
    const io = (env: Record<string, string | undefined>) => {
      const errs: string[] = [];
      return { errs, io: { env, out: () => undefined, err: (l: string) => void errs.push(l) } };
    };
    const a = io({});
    expect(await hostCommand(["render"], a.io)).toBe(2);
    expect(a.errs.join("\n")).toContain("usage");
    const b = io({ EXOS_LISTEN_HOST: "0.0.0.0" });
    expect(await hostCommand(["up", "--repo", repo], b.io)).toBe(2);
    expect(b.errs.join("\n")).toContain("non-loopback");
    const c = io({ EXOS_LISTEN_HOST: "container" });
    expect(await hostCommand(["status", "--repo", repo], c.io)).toBe(2);
    expect(await hostCommand(["bogus"], io({}).io)).toBe(2);
  });
});

describe("scripts/host-up.sh", () => {
  it("is executable, valid bash, and only accepts up, down or status", () => {
    accessSync(join(repo, "scripts/host-up.sh"), constants.X_OK);
    expect(spawnSync("bash", ["-n", join(repo, "scripts/host-up.sh")]).status).toBe(0);
    const r = spawnSync(join(repo, "scripts/host-up.sh"), ["explode"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage");
  });

  it("is what make host-up and make host-down run", () => {
    const out = execFileSync("make", ["-n", "host-up", "host-down"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(out).toContain("scripts/host-up.sh up");
    expect(out).toContain("scripts/host-up.sh down");
  });
});
