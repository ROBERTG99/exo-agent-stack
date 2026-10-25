import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const hook = (name: string) => join(root, ".claude/hooks", name);

// Key-shaped literals are assembled from parts so this file never trips the guard it tests.
const ANT_KEY = ["sk", "ant", "api03", "x".repeat(12)].join("-");
const OAT_KEY = ["sk", "ant", "oat01", "x".repeat(12)].join("-");
const PROJ_KEY = ["sk", "proj", "x".repeat(12)].join("-");
const OR_KEY = ["sk", "or", "v1", "x".repeat(12)].join("-");
const KEY_VAR = ["ANTHROPIC", "API", "KEY"].join("_");
const TOKEN_VAR = ["ANTHROPIC", "AUTH", "TOKEN"].join("_");
const OPENAI_VAR = ["OPENAI", "API", "KEY"].join("_");

type Decision = { decision: string; reason: string };

function guard(
  toolName: string,
  toolInput: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const input = { tool_name: toolName, tool_input: toolInput, cwd: dir };
  const r = spawnSync("node", [hook("guard.mjs")], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  let decision: Decision | null = null;
  if (r.status === 2) decision = JSON.parse(r.stderr.trim().split("\n").pop()!) as Decision;
  return { status: r.status, decision, stderr: r.stderr, dir };
}
const bash = (command: string) => guard("Bash", { command });
const write = (file: string, content: string, files?: Record<string, string>) =>
  guard("Write", { file_path: file, content }, files);

describe("guard.mjs blocks §0.1 violations in Bash", () => {
  it.each([
    ["claude setup-token", "no-signin"],
    ["cd x && claude setup-token", "no-signin"],
    ["/opt/homebrew/bin/claude login", "no-signin"],
    ["cursor-agent login", "no-signin"],
    ["gh auth login --web", "no-signin"],
    ["exo vault secret create personal claude-oauth", "no-signin"],
    [`export ${KEY_VAR}=abc`, "no-api-key"],
    [`${OPENAI_VAR}=abc make test`, "no-api-key"],
    [`${TOKEN_VAR}="x" node a.js`, "no-api-key"],
    [`echo ${ANT_KEY}`, "no-key-literal"],
    [`curl -H "x-api-key: ${OAT_KEY}" localhost`, "no-key-literal"],
    [`echo ${PROJ_KEY}`, "no-key-literal"],
    [`echo ${OR_KEY}`, "no-key-literal"],
    ["exo run --serve --auth-file /tmp/a", "loopback-only"],
    ["exo run --serve --multiplayer", "loopback-only"],
    ["node server.js --bind 0.0.0.0:9812", "loopback-only"],
    ["docker run -p 9800:9800 img", "loopback-only"],
    ["exo run --serve --preview-domain example.com", "loopback-only"],
    ["make live-claude", "no-live-calls"],
    ["make live-cursor", "no-live-calls"],
    ["make eval-live", "no-live-calls"],
    ["EXOS_LIVE_CONFIRM=yes make verify", "no-live-calls"],
    ["terraform apply -auto-approve", "no-terraform"],
    ["terraform destroy", "no-terraform"],
    ["git push --force origin main", "no-force-push"],
    ["git push -f", "no-force-push"],
    ["git push origin +main", "no-force-push"],
    ["git push --force-with-lease", "no-force-push"],
    ["git config user.email x@y.z", "git-identity"],
    ["git config --global user.name Someone", "git-identity"],
    ["git -c user.name=X commit -m m", "git-identity"],
    ["git commit --author='A <a@b.c>' -m m", "git-identity"],
    ["GIT_AUTHOR_NAME=x git commit -m m", "git-identity"],
    ["export GIT_COMMITTER_EMAIL=a@b.c", "git-identity"],
    ['git commit -m "feat: x\n\nCo-Authored-By: Someone <a@b.c>"', "no-attribution"],
    ['git commit -m "x" -m "Claude-Session: abc"', "no-attribution"],
    ['gh pr create --body "Generated with Claude Code"', "no-attribution"],
    ["echo hi > vendor/exo/README.md", "vendor-readonly"],
    ["sed -i '' s/a/b/ vendor/exo/Cargo.toml", "vendor-readonly"],
    ["rm -rf vendor/exo/crates", "vendor-readonly"],
    ["cp ./x vendor/exo/x", "vendor-readonly"],
    ["echo x >> evals/datasets/durability.v1.test.jsonl", "immutable-dataset"],
    // destructive pushes beyond --force
    ["git push --delete origin old", "no-force-push"],
    ["git push -d origin old", "no-force-push"],
    ["git push origin :old-branch", "no-force-push"],
    ["git push --mirror", "no-force-push"],
    ["git push --prune origin", "no-force-push"],
    ["git push -fu origin main", "no-force-push"],
    // shell indirection
    ["bash -c 'claude setup-token'", "no-signin"],
    ['sh -c "git push --force"', "no-force-push"],
    ['eval "make live-claude"', "no-live-calls"],
    ["echo $(claude login)", "no-signin"],
    ["echo `gh auth login`", "no-signin"],
    ["echo x | xargs claude login", "no-signin"],
    ["timeout 5 claude setup-token", "no-signin"],
    // review round 3: quoting, global options, nesting, bundles
    ['git "push" --force origin main', "no-force-push"],
    ["git -C /tmp/x push --force", "no-force-push"],
    ["git -c core.pager=cat push -f", "no-force-push"],
    ["git --git-dir=.git push --delete origin x", "no-force-push"],
    ["echo $(echo $(claude login))", "no-signin"],
    ["cat <(claude setup-token)", "no-signin"],
    ["echo x | xargs -n 1 claude login", "no-signin"],
    ["echo x | xargs -I {} claude login", "no-signin"],
    ["timeout -s KILL 5 claude setup-token", "no-signin"],
    ["timeout --kill-after=2s 10 gh auth login", "no-signin"],
    ["docker run -dp 9800:9800 img", "loopback-only"],
    ["docker run -itP img", "loopback-only"],
    ["docker run -p9800:9800 img", "loopback-only"],
    // heredocs and quotes: expansion still counts, literal text does not
    ["cat <<EOF\n$(claude login)\nEOF", "no-signin"],
    ['echo "run `claude setup-token` now"', "no-signin"],
    ["git commit -F - <<'EOF'\nfeat: x\n\nCo-Authored-By: A <a@b.c>\nEOF", "no-attribution"],
    // loopback allowlists
    ["exo run --serve --bind 10.0.0.5:9810", "loopback-only"],
    ["node server.js --host example.com", "loopback-only"],
    ["exo run --serve --preview-domain evil.example", "loopback-only"],
    ["docker run -p 9800 img", "loopback-only"],
    ["docker run -P img", "loopback-only"],
    ["docker run --publish 8080:80 img", "loopback-only"],
    ["docker run -p 0.0.0.0:9800:9800 img", "loopback-only"],
  ])("blocks %j (%s)", (command, rule) => {
    const r = bash(command);
    expect(r.status, r.stderr).toBe(2);
    expect(r.decision?.decision).toBe("block");
    expect(r.decision?.reason.startsWith(`${rule}:`)).toBe(true);
  });

  it.each([
    "make check-fast",
    "pnpm exec vitest run --project unit",
    "git add PROGRESS.md docs/DECISIONS.md",
    'git commit -m "docs: explain why claude setup-token is maintainer-only"',
    "git push origin main",
    "git push -u origin feature/x",
    "git config user.email",
    "git config --get user.name",
    "git var GIT_AUTHOR_IDENT",
    "git log --format='%an <%ae>' -5",
    "cp vendor/exo/README.md /tmp/readme-copy.md",
    "cat vendor/exo/Cargo.toml",
    "grep -rn '0.0.0.0' doctor/src",
    "docker run -p 127.0.0.1:9800:9800 img",
    "exo run --serve --bind 127.0.0.1:9810",
    "terraform validate",
    `env -u ${KEY_VAR} make verify`,
    "make eval",
    "make doctor",
    "cat evals/datasets/durability.v1.test.jsonl",
    "git commit -m 'feat: add credit guard'",
    "git push origin HEAD:refs/heads/feature-x",
    "git push -u origin feature-x",
    "exo run --serve --bind [::1]:9810",
    "exo run --serve --bind localhost:9810",
    "exo run --serve --preview-domain app.localhost",
    "docker run --publish 127.0.0.1:8080:80 img",
    "docker run -p [::1]:9800:9800 img",
    "bash -c 'make check-fast'",
    "cat >> docs/DECISIONS.md <<'EOF'\n- see `docker compose -p demo up` and `claude setup-token`\nclaude login\ngit push --force\nEOF",
    "git commit -m \"$(cat <<'EOF'\ndocs: explain `docker run -p 9800:9800` is blocked\n\nIt's a rule; (see rails).\nEOF\n)\"",
    "echo 'use `claude setup-token` yourself'",
    "git -C /tmp/x push origin main",
    "git push origin feature",
    "docker compose -p demo up -d",
    "docker run -dp 127.0.0.1:9800:9800 img",
    "echo $(echo $(date))",
    "timeout -s KILL 5 make check-fast",
    "echo x | xargs -n 1 echo",
    "echo $(date +%s)",
    "echo x | xargs echo",
  ])("allows %j", (command) => {
    const r = bash(command);
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("guard.mjs on Write and Edit", () => {
  it("blocks API-key assignments outside the exempt directories", () => {
    const r = write("stackd/src/config.ts", `process.env.${KEY_VAR} = "x";`);
    expect(r.decision?.reason.startsWith("no-api-key:")).toBe(true);
  });

  it.each([
    "doctor/src/checks/d05.ts",
    "data/generator/src/x.ts",
    "harnesses/scripted/h.ts",
    "tests/unit/a.test.ts",
  ])("allows the key variable name with an assignment in %s", (file) => {
    expect(
      write(
        file,
        `const env = { ${KEY_VAR}: undefined }; delete env.${KEY_VAR}; const x = "${KEY_VAR}=";`,
      ).status,
    ).toBe(0);
  });

  it("blocks key-shaped literals everywhere, including tests", () => {
    for (const file of ["stackd/src/a.ts", "tests/unit/a.test.ts", "docs/a.md"]) {
      const r = write(file, `const k = "${ANT_KEY}";`);
      expect(r.decision?.reason.startsWith("no-key-literal:"), file).toBe(true);
    }
  });

  it("blocks writes inside vendor/exo but not vendor/exo-notes elsewhere", () => {
    expect(
      write("vendor/exo/src/lib.rs", "fn main() {}").decision?.reason.startsWith(
        "vendor-readonly:",
      ),
    ).toBe(true);
    expect(
      guard("Edit", { file_path: "vendor/exo/Cargo.toml", old_string: "a", new_string: "b" })
        .status,
    ).toBe(2);
    expect(write("docs/vendor-notes.md", "x").status).toBe(0);
  });

  it("blocks non-loopback binds in deployment files but allows docs and doctor to mention them", () => {
    expect(
      write(
        "compose.yaml",
        'services:\n  a:\n    ports:\n      - "9800:9800"\n',
      ).decision?.reason.startsWith("loopback-only:"),
    ).toBe(true);
    expect(
      write("compose.yaml", 'services:\n  a:\n    ports:\n      - "127.0.0.1:9800:9800"\n').status,
    ).toBe(0);
    expect(write("deploy/launchd/a.plist", "<string>0.0.0.0</string>").status).toBe(2);
    expect(write("scripts/host-up.sh", "exo run --serve --auth-file x").status).toBe(2);
    expect(
      write("doctor/src/checks/d02.ts", 'const bad = ["--auth-file", "0.0.0.0"];').status,
    ).toBe(0);
    expect(write("docs/security.md", "We never pass --auth-file or bind 0.0.0.0.").status).toBe(0);
  });

  it("blocks live targets and confirmation in workflows, but docs may explain them", () => {
    expect(
      write(".github/workflows/ci.yml", "run: make eval-live").decision?.reason.startsWith(
        "no-live-calls:",
      ),
    ).toBe(true);
    expect(
      write(
        ".github/workflows/ci.yml",
        "env:\n  EXOS_LIVE_CONFIRM: yes\nrun: echo EXOS_LIVE_CONFIRM=yes",
      ).status,
    ).toBe(2);
    expect(
      write("docs/runbook.md", "Run `EXOS_LIVE_CONFIRM=yes make live-claude` yourself.").status,
    ).toBe(0);
  });

  it("makes existing test-split datasets immutable but allows creating new files", () => {
    const file = "evals/datasets/policy.v1.test.jsonl";
    expect(write(file, "{}\n").status).toBe(0);
    const r = write(file, "{}\n", { [file]: '{"id":1}\n' });
    expect(r.decision?.reason.startsWith("immutable-dataset:")).toBe(true);
    expect(
      guard("Edit", { file_path: file, old_string: "1", new_string: "2" }, { [file]: '{"id":1}\n' })
        .status,
    ).toBe(2);
    expect(
      write("evals/datasets/policy.v1.dev.jsonl", "{}\n", {
        "evals/datasets/policy.v1.dev.jsonl": "x",
      }).status,
    ).toBe(0);
  });

  it("checks every edit of a MultiEdit and reads Edit.new_string", () => {
    expect(
      guard("Edit", { file_path: "stackd/a.ts", old_string: "a", new_string: `x = "${OR_KEY}"` })
        .status,
    ).toBe(2);
    expect(
      guard("MultiEdit", {
        file_path: "stackd/a.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: `${KEY_VAR}=1` },
        ],
      }).status,
    ).toBe(2);
  });
});

describe("guard.mjs robustness", () => {
  it("ignores unrelated tools and malformed input", () => {
    expect(guard("Read", { file_path: "x" }).status).toBe(0);
    const r = spawnSync("node", [hook("guard.mjs")], { input: "not json", encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("emits a reason of the form '<rule>: <message>' as JSON", () => {
    const r = bash("terraform apply");
    expect(r.decision).toEqual({
      decision: "block",
      reason: expect.stringMatching(/^[a-z-]+: .{10,}/),
    });
  });
});

describe("stop.sh", () => {
  const run = (cmd: string, active: boolean) =>
    spawnSync("bash", [hook("stop.sh")], {
      input: JSON.stringify({ stop_hook_active: active }),
      encoding: "utf8",
      env: { ...process.env, STOP_HOOK_CMD: cmd, CLAUDE_PROJECT_DIR: root },
    });

  it("passes when check-fast passes", () => {
    expect(run("true", false).status).toBe(0);
  });

  it("blocks once when check-fast fails, with the output tail", () => {
    const r = run("echo some-failure-output; exit 1", false);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("some-failure-output");
  });

  it("does not loop: exits 0 when stop_hook_active is true, even if it would fail", () => {
    const r = run("echo should-not-run > /dev/stderr; exit 1", true);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("should-not-run");
  });

  it("kills a command that exceeds the time limit and blocks with a timeout message", () => {
    const r = spawnSync("bash", [hook("stop.sh")], {
      input: JSON.stringify({ stop_hook_active: false }),
      encoding: "utf8",
      env: {
        ...process.env,
        STOP_HOOK_CMD: "sleep 30",
        STOP_HOOK_TIMEOUT: "1",
        CLAUDE_PROJECT_DIR: root,
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/timed out|time limit/i);
  });
});

describe("format.sh", () => {
  it("is a no-op that exits 0 for missing files, unsupported types and malformed input", () => {
    for (const input of [
      '{"tool_input":{"file_path":"/nonexistent/a.ts"}}',
      '{"tool_input":{"file_path":"x.bin"}}',
      "garbage",
      "{}",
    ]) {
      const r = spawnSync("bash", [hook("format.sh")], {
        input,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      });
      expect(r.status, input).toBe(0);
    }
  });

  it("formats a TypeScript file with prettier", () => {
    const dir = mkdtempSync(join(tmpdir(), "fmt-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "const   a   =  1\n");
    const r = spawnSync("bash", [hook("format.sh")], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    expect(r.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("const a = 1;\n");
  });
});

describe("session-start.sh", () => {
  const run = (env: Record<string, string>) =>
    spawnSync("bash", [hook("session-start.sh")], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CODE_REMOTE: "", SESSION_START_DRY_RUN: "1", ...env },
    });

  it("does nothing outside Claude Code on the web", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("plans the Appendix A setup when CLAUDE_CODE_REMOTE=true, and is idempotent", () => {
    const a = run({ CLAUDE_CODE_REMOTE: "true" });
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toContain("dockerd");
    expect(a.stdout).toContain("mirror.gcr.io");
    expect(a.stdout).toContain("pnpm install");
    expect(run({ CLAUDE_CODE_REMOTE: "true" }).stdout).toBe(a.stdout);
  });
});

describe("hook files and registration", () => {
  it.each(["session-start.sh", "format.sh", "stop.sh", "guard.mjs"])(
    "%s exists and is executable",
    (f) => {
      expect(statSync(hook(f)).mode & 0o111).not.toBe(0);
    },
  );

  it("settings.json registers all four hooks and keeps the earlier keys", () => {
    const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(s.attribution).toBeDefined();
    expect(s.model).toBe("sonnet");
    expect(JSON.stringify(s.hooks.SessionStart)).toContain("session-start.sh");
    expect(s.hooks.PreToolUse[0].matcher).toBe("Bash|Write|Edit|MultiEdit");
    expect(JSON.stringify(s.hooks.PreToolUse)).toContain("guard.mjs");
    expect(s.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit");
    expect(JSON.stringify(s.hooks.PostToolUse)).toContain("format.sh");
    expect(JSON.stringify(s.hooks.Stop)).toContain("stop.sh");
  });
});

// Keeps chmod import used when a fixture needs it; ensures helpers stay exercised by lint.
void chmodSync;
