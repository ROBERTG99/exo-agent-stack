import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    // review round 4: parser differentials around heredocs, quotes and git options
    ["echo \"<<'X'\"\nclaude login\nX", "no-signin"],
    ["cat <<<'x'\nclaude login", "no-signin"],
    ["cat <<'EOF'\nEOF\nclaude login", "no-signin"],
    ["cat <<'EOF'\nbody\nEOF\nclaude login", "no-signin"],
    ["cat <<'EOF'\nclaude login", "no-signin"],
    ["echo \"it's\" `claude login` 'x'", "no-signin"],
    ["git --weird-opt push --force", "no-force-push"],
    ["git -c alias.zz=push zz --force", "no-force-push"],
    ["git $(echo push) --force", "no-force-push"],
    // review round 5: abbreviations, separators, comments, git config env
    ["git push --forc origin main", "no-force-push"],
    ["git push --del origin x", "no-force-push"],
    ["git push --mir", "no-force-push"],
    ["git push --pru origin", "no-force-push"],
    ["git push --force-w origin main", "no-force-push"],
    ["git push --receive-pack=evil origin main", "no-force-push"],
    ["git --config-env=alias.zz=ALIASVAR zz --force", "no-force-push"],
    ["git --config-env alias.zz=ALIASVAR zz --force", "no-force-push"],
    ["sleep 1 & claude login", "no-signin"],
    ["(claude login)", "no-signin"],
    ["{ claude login; }", "no-signin"],
    ["! claude login", "no-signin"],
    ["if true; then claude login; fi", "no-signin"],
    ["# <<'X'\nclaude login\nX", "no-signin"],
    ["GIT_CONFIG_COUNT=1 git commit -m x", "git-identity"],
    ["GIT_CONFIG_PARAMETERS='user.name=x' git commit -m x", "git-identity"],
    // review round 6: redirects, comments, push-changing config
    ["git push origin main 2>&1 --force", "no-force-push"],
    ["git push origin main >&2 --delete x", "no-force-push"],
    ["(true)#<<X\nclaude login\nX", "no-signin"],
    ["git -c remote.origin.push=+refs/heads/*:refs/heads/* push origin", "no-force-push"],
    ["git -c core.pager=cat push origin main", "no-force-push"],
    ["git config remote.origin.push +refs/heads/*:refs/heads/*", "no-force-push"],
    ["git config alias.pf 'push --force'", "no-force-push"],
    ["git config url.evil.insteadOf https://github.com/", "no-force-push"],
    ["echo x >> .git/config", "git-internals"],
    ["cp /tmp/h .git/hooks/pre-push", "git-internals"],
    // reviewer round: wrappers, runners, env-var binds, tunnels
    ["/usr/bin/env claude login", "no-signin"],
    ["env -i claude login", "no-signin"],
    ["sudo -E claude login", "no-signin"],
    ["sudo -u root claude login", "no-signin"],
    ["env -u FOO BAR=1 /opt/homebrew/bin/claude login", "no-signin"],
    ["pnpm exec claude setup-token", "no-signin"],
    ["npx @anthropic-ai/claude-code setup-token", "no-signin"],
    ["npx -y claude login", "no-signin"],
    ["HOST=0.0.0.0 node server.js", "loopback-only"],
    ["EXOS_LISTEN_HOST=0.0.0.0 pnpm exec tsx x.ts", "loopback-only"],
    ["EXOS_LISTEN_HOST=10.1.1.1 node x.js", "loopback-only"],
    ["EXOS_LISTEN_HOST=container EXOS_IN_CONTAINER=1 node stackd/src/server.ts", "loopback-only"],
    ["ngrok http 9812", "no-tunnels"],
    ["cloudflared tunnel run", "no-tunnels"],
    ["ssh -R 9812:localhost:9812 host", "no-tunnels"],
    ["docker run --network host img", "loopback-only"],
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
    'git commit -m "fix: push -f is blocked"',
    "cat <<-'EOF'\n\tclaude login\n\tEOF",
    "cat <<A <<'B'\nx\nA\nclaude login\nB",
    "git log --oneline -3 | head",
    "git push origin main &>/dev/null",
    "git push origin main >&2",
    "git commit -m x 2>&1 | tail -3",
    "git config --get remote.origin.url",
    "git config --get-regexp '^alias'",
    "git config remote.origin.push",
    "git config core.pager cat",
    "git log --author=Someone --oneline",
    "git shortlog --author=X",
    "env FOO=1 make check-fast",
    "pnpm exec vitest run --project unit",
    "npx prettier --check .",
    "EXOS_LISTEN_HOST=127.0.0.1 node x.js",
    "docker run --network bridge img",
    "ssh -L 8080:localhost:80 host",
    "git push --tags origin main",
    "git push --follow-tags",
    "git push -o ci.skip origin feature",
    "git push --recurse-submodules=check origin main",
    "git push --dry-run -v origin main",
    "sleep 1 & echo hi",
    "ls 2>&1 | head",
    "echo done &",
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

  describe("compose files are parsed, not pattern-matched", () => {
    const compose = (ports: string, extra = "") =>
      `services:\n  a:\n    image: x\n${extra}    ports:\n${ports}`;
    it.each([
      ["long syntax without host_ip", compose("      - target: 80\n        published: 8080\n")],
      ["container-only short syntax", compose('      - "9800"\n')],
      ["a range without host ip", compose('      - "9800-9810:9800-9810"\n')],
      ["a numeric entry", compose("      - 9800\n")],
      ["host network mode", compose('      - "127.0.0.1:9800:9800"\n', "    network_mode: host\n")],
      [
        "an all-interfaces host_ip",
        compose("      - target: 80\n        published: 8080\n        host_ip: 192.168.1.5\n"),
      ],
    ])("blocks %s", (_name, content) => {
      expect(write("compose.yaml", content).decision?.reason.startsWith("loopback-only:")).toBe(
        true,
      );
    });

    it.each([
      ["short syntax with 127.0.0.1", compose('      - "127.0.0.1:9800:9800"\n')],
      ["short syntax with [::1]", compose('      - "[::1]:9800:9800"\n')],
      [
        "long syntax with host_ip",
        compose("      - target: 80\n        published: 8080\n        host_ip: 127.0.0.1\n"),
      ],
      ["a service without ports", "services:\n  a:\n    image: x\n"],
    ])("allows %s", (_name, content) => {
      expect(write("compose.yaml", content).status).toBe(0);
    });

    it("still catches a bad port line in an Edit fragment that is not valid YAML on its own", () => {
      const r = guard("Edit", {
        file_path: "compose.yaml",
        old_string: "a",
        new_string: '      - "9800:9800"\n',
      });
      expect(r.status).toBe(2);
    });
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

describe("guard.mjs reads message files named on the command line", () => {
  const trailer = ["Co-Authored", "By: Someone <a@b.c>"].join("-");
  const files = {
    "msg.txt": `feat: x\n\n${trailer}\n`,
    "clean.txt": "feat: x\n",
  };
  it("blocks git commit -F with a trailer inside the file", () => {
    const r = guard("Bash", { command: "git commit -F msg.txt" }, files);
    expect(r.decision?.reason.startsWith("no-attribution:")).toBe(true);
    expect(guard("Bash", { command: "git commit --file=msg.txt" }, files).status).toBe(2);
  });

  it("allows a clean message file, stdin and a missing file", () => {
    expect(guard("Bash", { command: "git commit -F clean.txt" }, files).status).toBe(0);
    expect(guard("Bash", { command: "git commit -F -" }, files).status).toBe(0);
    expect(guard("Bash", { command: "git commit -F nope.txt" }, files).status).toBe(0);
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

describe("stop.sh timeout", () => {
  it("kills grandchildren of a command that exceeds the limit", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "stop-")), "pid");
    const r = spawnSync("bash", [hook("stop.sh")], {
      input: JSON.stringify({ stop_hook_active: false }),
      encoding: "utf8",
      env: {
        ...process.env,
        STOP_HOOK_CMD: `sleep 30 & echo $! > ${pidFile}; wait`,
        STOP_HOOK_TIMEOUT: "1",
        CLAUDE_PROJECT_DIR: root,
      },
    });
    expect(r.status).toBe(2);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
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

  // A throwaway project directory that reuses the repo's prettier through a symlink.
  function tempProject() {
    const dir = mkdtempSync(join(tmpdir(), "fmt-project-"));
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
    return realpathSync(dir);
  }
  const format = (file: string, project: string) =>
    spawnSync("bash", [hook("format.sh")], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    });

  it("formats a TypeScript file inside the project with prettier", () => {
    const project = tempProject();
    const file = join(project, "a.ts");
    writeFileSync(file, "const   a   =  1\n");
    expect(format(file, project).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("const a = 1;\n");
  });

  it("leaves files outside the project untouched", () => {
    const project = tempProject();
    const outside = join(mkdtempSync(join(tmpdir(), "fmt-outside-")), "b.ts");
    writeFileSync(outside, "const   b   =  2\n");
    expect(format(outside, project).status).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("const   b   =  2\n");
  });

  it("does not follow a ../ path out of the project", () => {
    const project = tempProject();
    const outside = join(mkdtempSync(join(tmpdir(), "fmt-outside-")), "c.ts");
    writeFileSync(outside, "const   c   =  3\n");
    expect(format(join(project, "..", "..", outside), project).status).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("const   c   =  3\n");
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
