import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const scripts = {
  claude: join(root, "scripts", "mode-b-store-token.sh"),
  cursor: join(root, "scripts", "store-cursor-key.sh"),
};

// Credential-shaped test values are assembled from parts (the repository never contains one).
const SETUP_TOKEN = ["sk-ant", "oat01", "A".repeat(40)].join("-");
const SHORT_TOKEN = ["sk-ant", "oat01", "short"].join("-");
const API_KEY = ["sk-ant", "api03", "B".repeat(40)].join("-");
const OPENAI_KEY = ["sk", "proj", "C".repeat(40)].join("-");
const OPENROUTER_KEY = ["sk", "or", "v1", "D".repeat(40)].join("-");
const CURSOR_KEY = "cursor_user_key_" + "E".repeat(24);

/** A stand-in `exo` that records every argument (one per line) and whatever arrives on stdin. */
function fakeExo(opts: { helpExit?: number; helpText?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-exo-"));
  const log = join(dir, "log");
  const bin = join(dir, "exo");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${log}.args"
printf '%s\\n' '---' >> "${log}.args"
for a in "$@"; do
  if [ "$a" = "--help" ]; then
    echo '${opts.helpText ?? "usage: exo vault secret create <vault> <name> [--origin <url>]"}'
    exit ${opts.helpExit ?? 0}
  fi
done
cat > "${log}.stdin"
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    argv: () => (existsSync(`${log}.args`) ? readFileSync(`${log}.args`, "utf8") : ""),
    stdin: () => (existsSync(`${log}.stdin`) ? readFileSync(`${log}.stdin`, "utf8") : undefined),
  };
}

function run(script: string, stdin: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [script, ...args], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

describe("script files", () => {
  it.each(Object.values(scripts))(
    "%s exists, is executable and starts with set -euo pipefail",
    (file) => {
      expect(statSync(file).mode & 0o111).not.toBe(0);
      const text = readFileSync(file, "utf8");
      expect(text.startsWith("#!/usr/bin/env bash")).toBe(true);
      expect(text).toMatch(/^set -euo pipefail$/m);
      expect(text).toMatch(/maintainer/i);
      expect(text).not.toMatch(/^set -x|set -o xtrace/m);
    },
  );

  it.each(Object.values(scripts))("%s refuses to run in CI", (file) => {
    const exo = fakeExo();
    const r = run(file, `${SETUP_TOKEN}\n`, [], {
      CI: "true",
      EXOS_EXO_BIN: exo.bin,
      EXOS_CURSOR_ORIGIN: "https://cursor.example.org",
    });
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/maintainer|CI/i);
    expect(exo.argv()).toBe("");
  });
});

describe("mode-b-store-token.sh (Mode B: Claude setup-token -> vault personal / claude-oauth)", () => {
  const env = (exo: ReturnType<typeof fakeExo>) => ({
    EXOS_EXO_BIN: exo.bin,
    EXOS_EXO_ROOT: "/tmp/exo-root-for-test",
  });

  it("stores a setup-token through exo with the token on stdin only", () => {
    const exo = fakeExo();
    const r = run(scripts.claude, `${SETUP_TOKEN}\n`, [], env(exo));
    expect(r.status, r.err).toBe(0);
    expect(exo.stdin()).toBe(SETUP_TOKEN);
    const argv = exo.argv();
    expect(argv).toContain("vault\nsecret\ncreate\npersonal\nclaude-oauth");
    expect(argv).toContain("--origin\nhttps://api.anthropic.com");
    expect(argv).toContain("--root\n/tmp/exo-root-for-test");
    expect(argv).not.toContain(SETUP_TOKEN);
    expect(argv).not.toContain("AAAA");
    expect(r.all).not.toContain(SETUP_TOKEN);
    expect(r.all).not.toContain("AAAA");
  });

  it("checks that exo understands the command before the token is piped anywhere", () => {
    const exo = fakeExo();
    run(scripts.claude, `${SETUP_TOKEN}\n`, [], env(exo));
    const calls = exo.argv().split("---\n").filter(Boolean);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--help");
    expect(calls[1]).not.toContain("--help");
  });

  it("aborts without sending the token when the help does not mention --origin (unverified flags)", () => {
    const exo = fakeExo({ helpText: "usage: exo vault secret create <vault> <name>" });
    const r = run(scripts.claude, `${SETUP_TOKEN}\n`, [], env(exo));
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/--origin/);
    expect(exo.stdin()).toBeUndefined();
    expect(r.all).not.toContain(SETUP_TOKEN);
  });

  it("aborts without sending the token when exo has no such command", () => {
    const exo = fakeExo({ helpExit: 2 });
    const r = run(scripts.claude, `${SETUP_TOKEN}\n`, [], env(exo));
    expect(r.status).toBe(1);
    expect(exo.stdin()).toBeUndefined();
  });

  it("rejects an Anthropic API key: this stack never uses API keys", () => {
    const exo = fakeExo();
    const r = run(scripts.claude, `${API_KEY}\n`, [], env(exo));
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/API key/i);
    expect(r.all).not.toContain(API_KEY);
    expect(exo.argv()).toBe("");
  });

  it.each([
    ["an empty line", "\n"],
    ["no input", ""],
    ["whitespace", "   \n"],
    ["a token that is too short", `${SHORT_TOKEN}\n`],
    ["another provider's key", `${OPENAI_KEY}\n`],
    ["text with a space", `${SETUP_TOKEN} extra\n`],
    ["two lines", `${SETUP_TOKEN}\nsecond-line\n`],
    ["a token with a trailing carriage return", `${SETUP_TOKEN}\r\n`],
  ])("rejects %s", (_n, input) => {
    const exo = fakeExo();
    const r = run(scripts.claude, input, [], env(exo));
    expect(r.status).toBe(2);
    expect(exo.argv()).toBe("");
    expect(r.all).not.toContain("AAAA");
  });

  it("--dry-run validates and prints the plan without calling exo or revealing the token", () => {
    const exo = fakeExo();
    const r = run(scripts.claude, `${SETUP_TOKEN}\n`, ["--dry-run"], env(exo));
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/would run/i);
    expect(r.out).toContain("vault secret create personal claude-oauth");
    expect(r.out).toContain("https://api.anthropic.com");
    expect(r.all).not.toContain(SETUP_TOKEN);
    expect(r.all).not.toContain("AAAA");
    expect(exo.argv()).toBe("");
  });

  it("--dry-run still rejects an API key", () => {
    const r = run(scripts.claude, `${API_KEY}\n`, ["--dry-run"], env(fakeExo()));
    expect(r.status).toBe(2);
  });

  it("rejects unknown arguments and prints usage for --help", () => {
    expect(run(scripts.claude, "", ["--bogus"], env(fakeExo())).status).toBe(2);
    const help = run(scripts.claude, "", ["--help"], env(fakeExo()));
    expect(help.status).toBe(0);
    expect(help.out).toMatch(/usage/i);
    expect(help.out).toMatch(/claude setup-token/);
  });

  it("does not leak the token through a failed exo call", () => {
    const dir = mkdtempSync(join(tmpdir(), "fail-exo-"));
    const bin = join(dir, "exo");
    writeFileSync(
      bin,
      `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = "--help" ] && { echo '--origin'; exit 0; }; done\ncat >/dev/null\necho "boom" >&2\nexit 7\n`,
    );
    chmodSync(bin, 0o755);
    const r = run(scripts.claude, `${SETUP_TOKEN}\n`, [], { EXOS_EXO_BIN: bin });
    expect(r.status).toBe(1);
    expect(r.all).not.toContain("AAAA");
  });
});

describe("store-cursor-key.sh (Cursor user key -> vault personal / cursor)", () => {
  const env = (exo: ReturnType<typeof fakeExo>, extra: Record<string, string> = {}) => ({
    EXOS_EXO_BIN: exo.bin,
    EXOS_EXO_ROOT: "/tmp/exo-root-for-test",
    EXOS_CURSOR_ORIGIN: "https://cursor-sdk.example.org",
    ...extra,
  });

  it("stores the key through exo, bound to the configured origin, with the key on stdin only", () => {
    const exo = fakeExo();
    const r = run(scripts.cursor, `${CURSOR_KEY}\n`, [], env(exo));
    expect(r.status, r.err).toBe(0);
    expect(exo.stdin()).toBe(CURSOR_KEY);
    expect(exo.argv()).toContain("vault\nsecret\ncreate\npersonal\ncursor");
    expect(exo.argv()).toContain("--origin\nhttps://cursor-sdk.example.org");
    expect(exo.argv()).not.toContain(CURSOR_KEY);
    expect(r.all).not.toContain(CURSOR_KEY);
  });

  it.each([
    ["an Anthropic API key", API_KEY],
    ["an Anthropic setup-token", SETUP_TOKEN],
    ["an OpenAI key", OPENAI_KEY],
    ["an OpenRouter key", OPENROUTER_KEY],
  ])("rejects %s", (_n, key) => {
    const exo = fakeExo();
    const r = run(scripts.cursor, `${key}\n`, [], env(exo));
    expect(r.status).toBe(2);
    expect(r.all).not.toContain(key);
    expect(exo.argv()).toBe("");
  });

  it.each([
    ["empty", "\n"],
    ["too short", "abc\n"],
    ["with a space", "cursor key with spaces 1234567890\n"],
    ["two lines", `${CURSOR_KEY}\nmore\n`],
  ])("rejects a key that is %s", (_n, input) => {
    const exo = fakeExo();
    expect(run(scripts.cursor, input, [], env(exo)).status).toBe(2);
    expect(exo.argv()).toBe("");
  });

  it("requires the origin to be configured, because it must come from the pinned Cursor SDK", () => {
    const exo = fakeExo();
    const r = run(scripts.cursor, `${CURSOR_KEY}\n`, [], { EXOS_EXO_BIN: exo.bin });
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/EXOS_CURSOR_ORIGIN/);
    expect(exo.argv()).toBe("");
  });

  it.each([
    "http://cursor.example.org",
    "cursor.example.org",
    "https://",
    "https://a b.example.org",
    "https://x.example.org/path?q=1",
    "ftp://x.example.org",
  ])("rejects the origin %j", (origin) => {
    const exo = fakeExo();
    const r = run(scripts.cursor, `${CURSOR_KEY}\n`, [], env(exo, { EXOS_CURSOR_ORIGIN: origin }));
    expect(r.status).toBe(2);
    expect(exo.argv()).toBe("");
  });

  it("--dry-run prints the plan and calls nothing", () => {
    const exo = fakeExo();
    const r = run(scripts.cursor, `${CURSOR_KEY}\n`, ["--dry-run"], env(exo));
    expect(r.status).toBe(0);
    expect(r.out).toContain("vault secret create personal cursor");
    expect(r.all).not.toContain(CURSOR_KEY);
    expect(exo.argv()).toBe("");
  });

  it("aborts before sending the key when exo's help does not mention --origin", () => {
    const exo = fakeExo({ helpText: "usage: exo vault secret create <vault> <name>" });
    const r = run(scripts.cursor, `${CURSOR_KEY}\n`, [], env(exo));
    expect(r.status).toBe(1);
    expect(exo.stdin()).toBeUndefined();
  });
});
