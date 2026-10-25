#!/usr/bin/env node
// PreToolUse guard for Bash, Write, Edit and MultiEdit (BUILD.md §7.1).
// Reads the tool call as JSON on stdin. On a violation of the project rails (§0.1) it prints
// {"decision":"block","reason":"<rule>: <message>"} to stderr and exits 2 so Claude Code
// blocks the call and shows the reason. Anything else exits 0. Internal errors fail open
// (exit 1, non-blocking) so a bug here never locks the session; tests cover the rules.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The yaml package is a repo devDependency; if it is missing the compose check falls back to a regex.
let parseYaml = null;
try {
  ({ parse: parseYaml } = await import("yaml"));
} catch {
  parseYaml = null;
}

// Sensitive patterns are assembled from parts so this file never matches its own rules.
const KEY_VARS = [
  "ANTHROPIC_" + "API_KEY",
  "ANTHROPIC_" + "AUTH_TOKEN",
  "OPENAI_" + "API_KEY",
  "OPENROUTER_" + "API_KEY",
];
const KEY_ASSIGN = new RegExp(`\\b(?:${KEY_VARS.join("|")})\\s*=(?!=)`);
const KEY_LITERAL = new RegExp(
  ["sk-ant-(api|oat)[0-9]{2}-", "sk-" + "proj-", "sk-" + "or-v1-"].join("|"),
);
const LIVE_CONFIRM = /\bEXOS_LIVE_CONFIRM\s*[=:]\s*["']?(yes|true|1)\b/i;
const LIVE_TARGET = /\b(live-claude|live-cursor|eval-live)\b/;
const TRAILER = /Co-Authored-By|Claude-Session|Generated with \[?Claude Code/i;
const IDENTITY_ENV =
  /\bGIT_(?:AUTHOR|COMMITTER)_[A-Z]+\s*=|\bGIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM)\s*=/;

const KEY_ASSIGN_EXEMPT_DIRS = ["doctor/", "data/generator/", "harnesses/", "tests/"];
const DEPLOY_FILE =
  /^(compose[^/]*\.ya?ml|docker-compose[^/]*\.ya?ml|docker\/|deploy\/|scripts\/|Makefile$|\.github\/|\.env)/;
const CONFIRM_FILE = /^(\.github\/|Makefile$|compose[^/]*\.ya?ml$|deploy\/|\.env)/;
const COMPOSE_FILE = /^(compose[^/]*|docker-compose[^/]*)\.ya?ml$/;
const DATASET_TEST = /^evals\/datasets\/[^/]+\.test\.jsonl$/;
const LAUNCHERS = new Set([
  "exo",
  "node",
  "tsx",
  "npx",
  "pnpm",
  "docker",
  "docker-compose",
  "make",
  "uv",
  "python",
  "python3",
  "vite",
  "nginx",
]);

const block = (rule, message) => ({ rule, message });

let PROJECT_DIR = process.cwd();

/** True when a commit-message or PR-body file named on the command line contains an attribution trailer. */
function fileHasTrailer(arg) {
  const name = arg.replace(/^["']|["']$/g, "");
  if (!name || name === "-") return false;
  try {
    return TRAILER.test(readFileSync(path.resolve(PROJECT_DIR, name), "utf8").slice(0, 1_000_000));
  } catch {
    return false;
  }
}

/** Split a shell command into rough segments at ; && || | and newlines. */
function segments(command) {
  return command
    .split(/&&|\|\||(?<![<>])&(?!>)|[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const TIMEOUT_RE =
  /^timeout\s+(?:(?:-s|-k|--signal|--kill-after)(?:=|\s+)\S+\s+|-{1,2}[A-Za-z-]+(?:=\S+)?\s+)*\d+(?:\.\d+)?[smhd]?\s+/;
const XARGS_RE = /^xargs\s+(?:(?:-[IiLlnPdaEesJ]\s*\S+|--\S+|-[0rtpx]+)\s+)*/;
// sudo and env take options; options that take an argument are removed together with it.
const SUDO_ENV_RE =
  /^(?:sudo|env)\s+(?:(?:-[uCSgGhpUrDRTt]\s+\S+|--(?:user|group|host|prompt|chdir|unset)(?:=\S+|\s+\S+)|--\S*|-[A-Za-z0-9]+)\s+)*/;
const PLAIN_WRAPPER_RE =
  /^(?:command|exec|nohup|time|nice|ionice|stdbuf|setsid|caffeinate)\s+(?:-[A-Za-z0-9]+(?:\s+\d+)?\s+)*/;
const CLAUDE_PKG = String.raw`(?:@anthropic-ai\/claude-code(?:@\S+)?|claude)(?=\s|$)`;
const NPX_RE = new RegExp(String.raw`^(?:npx|bunx)\s+(?:-\S+\s+)*${CLAUDE_PKG}`);
const PKG_EXEC_RE = new RegExp(
  String.raw`^(?:pnpm|npm|yarn)\s+(?:exec|dlx|x)\s+(?:-\S+\s+)*${CLAUDE_PKG}`,
);

/**
 * Drops leading wrappers, env assignments, path prefixes and package-runner prefixes until the
 * first word is the real command. Repeats until stable, so /usr/bin/env -i sudo -E claude works.
 */
function stripPrefix(segment) {
  let s = segment.trim();
  for (let round = 0; round < 20; round++) {
    const next = s
      .replace(/^(?:[({!]+|then\b|do\b|else\b|elif\b)\s*/, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "")
      .replace(SUDO_ENV_RE, "")
      .replace(PLAIN_WRAPPER_RE, "")
      .replace(TIMEOUT_RE, "")
      .replace(XARGS_RE, "")
      .replace(NPX_RE, "claude")
      .replace(PKG_EXEC_RE, "claude")
      // the directory of the command itself, so /opt/homebrew/bin/claude matches `claude`
      .replace(/^\S*\/(?=[^/\s]+(?:\s|$))/, "");
    if (next === s) return s;
    s = next;
  }
  return s;
}

/**
 * Replaces the inside of terminated single-quoted strings with spaces. A single quote inside double
 * quotes is literal text, not a quote. Unterminated quotes are left untouched, so whatever follows
 * is still inspected (fail closed).
 */
function maskSingleQuoted(text) {
  const out = text.split("");
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) break;
      for (let k = i + 1; k < end; k++) if (text[k] !== "\n") out[k] = " ";
      i = end;
    }
  }
  return out.join("");
}

/** Bodies of $(...), <(...) and >(...), with nesting; text inside terminated single quotes is skipped. */
function balancedSubstitutions(command) {
  const masked = maskSingleQuoted(command);
  const out = [];
  for (let i = 0; i < masked.length - 1; i++) {
    if ((masked[i] === "$" || masked[i] === "<" || masked[i] === ">") && masked[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < masked.length && depth > 0; j++) {
        if (masked[j] === "(") depth++;
        else if (masked[j] === ")") depth--;
      }
      out.push(depth === 0 ? command.slice(i + 2, j - 1) : command.slice(i + 2));
    }
  }
  return out;
}

/**
 * Removes the bodies of well-formed heredocs from the command text. A small lexer tracks single and
 * double quotes and $(...) frames, so a "<<" inside a quoted string is not mistaken for a heredoc,
 * and a here-string (<<<) is not one either. A body is removed only when its delimiter line is found;
 * an unterminated heredoc stays in the text and is analysed like any other command. A quoted
 * heredoc (<<'EOF') is literal data; an unquoted one still undergoes $(...) and backtick expansion,
 * so only its substitutions are inspected.
 */
function splitHeredocs(command) {
  const bodies = [];
  const pending = [];
  const frames = [{ double: false, depth: 0 }];
  const top = () => frames[frames.length - 1];
  let code = "";
  let single = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (single) {
      code += c;
      if (c === "'") single = false;
      i++;
      continue;
    }
    if (c === "\\") {
      code += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "#" && !top().double && (i === 0 || /[\s;&|()<>]/.test(command[i - 1]))) {
      // An unquoted # at the start of a word is a comment up to the end of the line.
      let end = command.indexOf("\n", i);
      if (end === -1) end = command.length;
      code += command.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'" && !top().double) {
      single = true;
      code += c;
      i++;
      continue;
    }
    if (c === '"') {
      top().double = !top().double;
      code += c;
      i++;
      continue;
    }
    if ((c === "$" || ((c === "<" || c === ">") && !top().double)) && command[i + 1] === "(") {
      frames.push({ double: false, depth: 0 });
      code += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (frames.length > 1) {
      if (c === "(") top().depth++;
      else if (c === ")") {
        if (top().depth > 0) top().depth--;
        else frames.pop();
      }
    }
    if (
      c === "<" &&
      command[i + 1] === "<" &&
      command[i + 2] !== "<" &&
      command[i - 1] !== "<" &&
      !top().double
    ) {
      const m = command.slice(i).match(/^<<(-?)[ \t]*(?:(["'])([^"'\n]+)\2|(\\?)([A-Za-z_]\w*))/);
      if (m) {
        pending.push({
          tag: m[3] ?? m[5],
          quoted: m[2] !== undefined || m[4] === "\\",
          strip: m[1] === "-",
        });
        code += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === "\n" && pending.length && !top().double) {
      code += c;
      i++;
      for (const h of pending) {
        const start = i;
        const body = [];
        let found = false;
        while (i < command.length) {
          let end = command.indexOf("\n", i);
          if (end === -1) end = command.length;
          const line = command.slice(i, end);
          i = Math.min(end + 1, command.length);
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.tag) {
            found = true;
            break;
          }
          body.push(line);
        }
        if (found) bodies.push({ quoted: h.quoted, text: body.join("\n") });
        else {
          code += command.slice(start);
          i = command.length;
        }
      }
      pending.length = 0;
      continue;
    }
    code += c;
    i++;
  }
  return { code, bodies };
}

/** Command strings hidden inside bash -c, eval, $(...) and backticks, so indirection cannot dodge the rules. */
function nestedCommands(command) {
  const out = [];
  const quoted = String.raw`("(?:[^"\\]|\\.)*"|'[^']*')`;
  const unquote = (q) => q.slice(1, -1).replace(/\\(.)/g, "$1");
  const shell = new RegExp(
    String.raw`\b(?:bash|sh|zsh|dash|ksh)\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+${quoted}`,
    "g",
  );
  for (const m of command.matchAll(shell)) out.push(unquote(m[1]));
  for (const m of command.matchAll(new RegExp(String.raw`\beval\s+${quoted}`, "g")))
    out.push(unquote(m[1]));
  out.push(...balancedSubstitutions(command));
  for (const m of maskSingleQuoted(command).matchAll(/`([^`]*)`/g)) out.push(m[1]);
  return out;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** True when a bind/host/publish value names only a loopback address (any port). */
function isLoopbackValue(value) {
  const v = value.replace(/^["']|["']$/g, "");
  const bracket = v.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return LOOPBACK_HOSTS.has(bracket[1]);
  if ((v.match(/:/g) ?? []).length > 1) return LOOPBACK_HOSTS.has(v);
  return LOOPBACK_HOSTS.has(v.replace(/:\d+$/, ""));
}

function flagValues(seg, names) {
  const re = new RegExp(
    String.raw`(?:^|\s)(?:${names.join("|")})(?:=|\s+)("[^"]*"|'[^']*'|\S+)`,
    "g",
  );
  return [...seg.matchAll(re)].map((m) => m[1]);
}

const SAFE_PUSH_FLAGS = new Set([
  "-u",
  "--set-upstream",
  "--tags",
  "--follow-tags",
  "-n",
  "--dry-run",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--no-verify",
  "--verify",
  "--atomic",
  "--progress",
  "--porcelain",
  "--no-signed",
  "--thin",
  "--no-thin",
  "-4",
  "-6",
  "--ipv4",
  "--ipv6",
  "--no-recurse-submodules",
]);

/**
 * Returns the first push argument that is not provably a plain push, or null. Git accepts
 * unambiguous abbreviations of long options (--forc, --del), so an allowlist of known-safe flags is
 * used instead of a list of dangerous ones. Refspecs starting with + (force) or : (delete) are unsafe.
 */
function unsafePushToken(tokens) {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (/^[+:]/.test(t)) return t;
    if (!t.startsWith("-")) continue;
    if (SAFE_PUSH_FLAGS.has(t)) continue;
    if (/^-[uqvn46]+$/.test(t)) continue;
    if (/^--recurse-submodules=(?:check|on-demand|only|no)$/.test(t)) continue;
    if (/^--signed=(?:true|false|if-asked)$/.test(t)) continue;
    if (t === "-o" || t === "--push-option") {
      k++;
      continue;
    }
    if (t.startsWith("--push-option=")) continue;
    return t;
  }
  return null;
}

const firstWord = (s) => (s.split(/\s+/)[0] ?? "").replace(/^.*\//, "");

function bashRules(command, depth = 0) {
  if (KEY_LITERAL.test(command))
    return block(
      "no-key-literal",
      "API-key-shaped literal in a command. Use an env var that the maintainer sets; never paste a key.",
    );
  if (KEY_ASSIGN.test(command))
    return block(
      "no-api-key",
      "Assigning an API-key variable is forbidden. This stack runs on subscriptions only (BUILD.md §0.1 rail 1).",
    );
  if (LIVE_CONFIRM.test(command))
    return block(
      "no-live-calls",
      "EXOS_LIVE_CONFIRM must never be set by the agent; live runs are maintainer-only (rail 4).",
    );
  if (IDENTITY_ENV.test(command))
    return block(
      "git-identity",
      "GIT_AUTHOR_* / GIT_COMMITTER_* must not be set; the git identity is the maintainer's (§1.1).",
    );

  if (
    /\bgit\s+(?:-\S+\s+\S+\s+)*commit\b|\bgh\s+pr\s+(?:create|edit)\b|\bgh\s+api\b[^\n]*pulls/.test(
      command,
    ) &&
    TRAILER.test(command)
  ) {
    return block(
      "no-attribution",
      "No Co-Authored-By, Claude-Session or 'Generated with Claude Code' trailers in commits or pull requests (§1.1).",
    );
  }

  const { code, bodies } = splitHeredocs(command);
  if (depth < 3) {
    const nested = [
      ...nestedCommands(code),
      ...bodies.filter((b) => !b.quoted).flatMap((b) => nestedCommands(b.text)),
    ];
    for (const inner of nested) {
      const verdict = bashRules(inner, depth + 1);
      if (verdict) return verdict;
    }
  }

  for (const raw of segments(code)) {
    const seg = stripPrefix(raw);
    const word = firstWord(seg);

    if (
      /^claude\s+(?:setup-token|login)\b/.test(seg) ||
      /^cursor-agent\s+login\b/.test(seg) ||
      /^gh\s+auth\s+login\b/.test(seg) ||
      /^exo\s+vault\s+secret\b/.test(seg)
    ) {
      return block(
        "no-signin",
        "Sign-in and secret-creation commands are maintainer-only (rail 2). Add the step to 'Needs the maintainer' in PROGRESS.md instead.",
      );
    }
    if (word === "make" && LIVE_TARGET.test(seg)) {
      return block(
        "no-live-calls",
        "make live-claude, live-cursor and eval-live are maintainer-only and never run by the agent or CI (rail 4).",
      );
    }
    if (/^terraform\s+(?:apply|destroy)\b/.test(seg)) {
      return block(
        "no-terraform",
        "terraform apply and destroy are never run in this build (§0.8). There is no cloud infrastructure.",
      );
    }
    if (/^git\b/.test(seg)) {
      const tokens = seg.split(/\s+/).map((t) => t.replace(/^["'`(]+|["'`);&]+$/g, ""));
      // The subcommand is the first word after git's global options. Anything unrecognised makes the
      // parse uncertain, and an uncertain parse that mentions "push" is treated as a push.
      const takesArg = new Set([
        "-C",
        "-c",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--config-env",
      ]);
      const noArg = new Set([
        "-p",
        "-P",
        "--paginate",
        "--no-pager",
        "--bare",
        "--no-replace-objects",
        "--literal-pathspecs",
        "--glob-pathspecs",
        "--noglob-pathspecs",
        "--icase-pathspecs",
        "--no-optional-locks",
      ]);
      let at = 1;
      let uncertain = false;
      let aliasRisk = false;
      while (at < tokens.length && tokens[at].startsWith("-")) {
        const t = tokens[at];
        if (takesArg.has(t)) {
          if (t === "--config-env" || (t === "-c" && /^alias\./i.test(tokens[at + 1] ?? ""))) {
            uncertain = true;
            aliasRisk = true;
          }
          at += 2;
        } else if (/^--config-env=/.test(t)) {
          uncertain = true;
          aliasRisk = true;
          at += 1;
        } else if (noArg.has(t) || /^--(?:git-dir|work-tree|namespace|exec-path)=/.test(t)) {
          at += 1;
        } else {
          uncertain = true;
          at += 1;
        }
      }
      const hasConfigOverride = tokens
        .slice(1, at)
        .some((t) => t === "-c" || t === "--config-env" || t.startsWith("--config-env="));
      const sub = tokens[at];
      if (sub === undefined || !/^[A-Za-z][A-Za-z-]*$/.test(sub)) uncertain = true;
      const pushTokens =
        sub === "push"
          ? hasConfigOverride
            ? tokens
            : tokens.slice(at + 1)
          : uncertain && (aliasRisk || tokens.some((t) => /(?:^|=)push$/.test(t)))
            ? tokens
            : null;
      if (pushTokens) {
        const unsafe = unsafePushToken(pushTokens);
        if (unsafe) {
          return block(
            "no-force-push",
            `Only plain pushes are allowed; "${unsafe}" can force, delete, mirror or prune (or is not a known-safe push flag). If a bad commit was pushed, list it under 'Needs the maintainer'.`,
          );
        }
      }
      if (
        /\bconfig\b/.test(seg) &&
        /\buser\./.test(seg) &&
        !/--(?:get|get-all|get-regexp|list|show-origin)\b|\s-l\b/.test(seg) &&
        /\buser\.\w+\s+\S/.test(seg)
      ) {
        return block(
          "git-identity",
          "Do not modify git config user.*; the identity is the maintainer's (§1.1).",
        );
      }
      if (
        /\bconfig\b/.test(seg) &&
        !/--(?:get|get-all|get-regexp|list|show-origin)\b|\s-l\b/.test(seg) &&
        /(?:^|\s)(?:remote\.\S+\.(?:push|pushurl|mirror)|push\.\S+|alias\.\S+|url\.\S+|branch\.\S+\.pushremote)\s+\S/i.test(
          seg,
        )
      ) {
        return block(
          "no-force-push",
          "Do not set git config that changes what a push does (remote.*.push, push.*, alias.*, url.*): it can force or redirect pushes.",
        );
      }
      if (sub === "commit") {
        const f = seg.match(/(?:^|\s)(?:-F|--file[= ])\s*("[^"]+"|'[^']+'|\S+)/);
        if (f && fileHasTrailer(f[1])) {
          return block(
            "no-attribution",
            "The commit message file contains an attribution trailer (§1.1).",
          );
        }
      }
      const authorScoped =
        uncertain || ["commit", "commit-tree", "rebase", "am", "merge"].includes(sub);
      if (/\s-c\s+user\./.test(seg) || (authorScoped && /--author\b/.test(seg))) {
        return block(
          "git-identity",
          "Do not override the git author or committer; commits go out as the maintainer (§1.1).",
        );
      }
    }
    if (/\bEXOS_IN_CONTAINER\s*=/.test(raw)) {
      return block(
        "loopback-only",
        "EXOS_IN_CONTAINER is set only by the container images; setting it by hand would let a host process bind every interface (rail 3).",
      );
    }
    const listenHost = raw.match(/\bEXOS_LISTEN_HOST\s*=\s*["']?([^\s"']+)/);
    if (listenHost && !LOOPBACK_HOSTS.has(listenHost[1])) {
      return block(
        "loopback-only",
        `EXOS_LISTEN_HOST=${listenHost[1]} is not a loopback address (rail 3).`,
      );
    }
    if (
      ["ngrok", "cloudflared", "localtunnel", "lt", "bore", "serveo"].includes(word) ||
      (word === "tailscale" && /\b(?:funnel|serve)\b/.test(seg)) ||
      (word === "ssh" && /(?:^|\s)-[A-Za-z]*R/.test(seg))
    ) {
      return block(
        "no-tunnels",
        "Tunnels and remote port forwards expose local services; none are allowed (rail 3).",
      );
    }
    if (
      (word === "docker" || word === "docker-compose") &&
      /(?:^|\s)--(?:network|net)(?:=|\s+)host\b/.test(seg)
    ) {
      return block(
        "loopback-only",
        "Host networking bypasses the 127.0.0.1 port publishing (rail 3).",
      );
    }
    if (LAUNCHERS.has(word) || /--(?:bind|host|hostname|listen|address)\b/.test(seg)) {
      if (/--auth-file\b|--multiplayer\b/.test(raw)) {
        return block(
          "loopback-only",
          "--auth-file and --multiplayer are forbidden: loopback only, single owner (rails 3 and 7).",
        );
      }
      if (/(?:^|[\s=:"'])0\.0\.0\.0\b/.test(raw)) {
        return block(
          "loopback-only",
          "Binding 0.0.0.0 is forbidden; every listener binds 127.0.0.1 (rail 3).",
        );
      }
      for (const v of flagValues(seg, [
        "--bind",
        "--host",
        "--hostname",
        "--listen",
        "--address",
      ])) {
        if (!isLoopbackValue(v)) {
          return block(
            "loopback-only",
            `Bind/host value ${v} is not a loopback address; use 127.0.0.1, ::1 or localhost (rail 3).`,
          );
        }
      }
      for (const v of flagValues(seg, ["--preview-domain"])) {
        const d = v.replace(/^["']|["']$/g, "");
        if (d !== "localhost" && !d.endsWith(".localhost")) {
          return block(
            "loopback-only",
            "--preview-domain must be localhost or end in .localhost (rail 3).",
          );
        }
      }
    }
    if ((word === "docker" || word === "docker-compose") && /\b(?:run|create)\b/.test(seg)) {
      if (/(?:^|\s)(?:-[A-Za-z]*P[A-Za-z]*|--publish-all)(?=\s|$)/.test(seg)) {
        return block(
          "loopback-only",
          "Publishing all ports binds every interface; publish explicit 127.0.0.1: ports (rail 3).",
        );
      }
      for (const v of [
        ...flagValues(seg, ["--publish"]),
        ...[...seg.matchAll(/(?:^|\s)-[A-Za-z]*p(?:=|\s*)("[^"]*"|'[^']*'|\S+)/g)].map((m) => m[1]),
      ]) {
        if (!/^["']?(?:127\.0\.0\.1|\[::1\]):/.test(v)) {
          return block(
            "loopback-only",
            `Published port ${v} must start with 127.0.0.1: or [::1]: (rail 3).`,
          );
        }
      }
    }
  }

  const writeOps = [];
  for (const raw of segments(code)) {
    const seg = stripPrefix(raw);
    const word = firstWord(seg);
    const redirect = /(?:>>?|\btee(?:\s+-a)?\s+)\s*["']?(\S+)/g;
    for (const m of seg.matchAll(redirect)) writeOps.push(m[1]);
    if (
      [
        "rm",
        "sed",
        "perl",
        "patch",
        "truncate",
        "mv",
        "cp",
        "ln",
        "install",
        "chmod",
        "git",
      ].includes(word)
    ) {
      const args = seg
        .split(/\s+/)
        .slice(1)
        .filter((a) => !a.startsWith("-") || a === "-");
      const isInPlace =
        word !== "sed" && word !== "perl" ? true : /\s-(?:i|pi|[a-z]*i)\b/.test(seg);
      if (!isInPlace || word === "git") continue;
      if (word === "cp" || word === "mv" || word === "ln" || word === "install")
        writeOps.push(args[args.length - 1] ?? "");
      else writeOps.push(...args);
    }
  }
  for (const target of writeOps) {
    const t = target.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
    if (/^(?:.*\/)?vendor\/exo(?:\/|$)/.test(t) && !/vendor\/exo\/target(?:\/|$)/.test(t)) {
      return block(
        "vendor-readonly",
        "vendor/exo is a pinned read-only submodule (rail 6). Put fixes in patches/ and proposals in docs/upstream/.",
      );
    }
    if (/(?:^|\/)\.git\/(?:config|hooks\/|info\/|packed-refs|HEAD)/.test(t)) {
      return block(
        "git-internals",
        "Do not write inside .git (config, hooks, refs): it can change push behaviour or the git identity (§1.1).",
      );
    }
    if (/(?:^|\/)evals\/datasets\/[^/]+\.test\.jsonl$/.test(t)) {
      return block(
        "immutable-dataset",
        "Existing evals/datasets/*.test.jsonl files are immutable; add a new dataset version instead.",
      );
    }
  }
  return null;
}

/** Why a compose document breaks the loopback rail, or null. Edits arrive as fragments, so a regex backs up the parser. */
function composeViolation(content) {
  let doc;
  if (parseYaml) {
    try {
      doc = parseYaml(content, { merge: true });
    } catch {
      doc = undefined;
    }
  }
  if (doc && typeof doc === "object" && doc.services && typeof doc.services === "object") {
    if ("include" in doc) return "compose include: pulls in files this check cannot see";
    for (const [name, svc] of Object.entries(doc.services)) {
      if (!svc || typeof svc !== "object") continue;
      if ("extends" in svc)
        return `service ${name} uses extends, which hides ports from this check`;
      if (String(svc.network_mode ?? "") === "host")
        return `service ${name} uses network_mode: host`;
      for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
        if (typeof p === "string" || typeof p === "number") {
          if (!/^(?:127\.0\.0\.1|\[::1\]):/.test(String(p))) {
            return `service ${name} publishes ${p} without a 127.0.0.1: or [::1]: prefix`;
          }
        } else if (
          p &&
          typeof p === "object" &&
          !["127.0.0.1", "::1"].includes(String(p.host_ip ?? ""))
        ) {
          return `service ${name} publishes a port without host_ip 127.0.0.1`;
        }
      }
    }
    return null;
  }
  for (const line of content.split("\n")) {
    if (
      /^\s*-\s*["']?(?!127\.0\.0\.1:|\[::1\]:)\d{2,5}(?:-\d{2,5})?(?::\d{2,5}|["']?\s*$)/.test(line)
    ) {
      return `compose port without a 127.0.0.1: prefix (${line.trim()})`;
    }
    if (/^\s*network_mode:\s*["']?host\b/.test(line)) return "network_mode: host";
  }
  return null;
}

function fileRules(rel, content, exists, isEdit) {
  if (!rel || rel.startsWith("../")) return null;

  if (/^(?:.*\/)?\.git(?:\/|$)/.test(rel)) {
    return block(
      "git-internals",
      "Do not write inside .git (config, hooks, refs): it can change push behaviour or the git identity (§1.1).",
    );
  }
  if (/^vendor\/exo(\/|$)/.test(rel)) {
    return block(
      "vendor-readonly",
      "vendor/exo is a pinned read-only submodule (rail 6). Put fixes in patches/ and proposals in docs/upstream/.",
    );
  }
  if (DATASET_TEST.test(rel) && (exists || isEdit)) {
    return block(
      "immutable-dataset",
      "Existing evals/datasets/*.test.jsonl files are immutable; add a new dataset version instead.",
    );
  }
  if (KEY_LITERAL.test(content)) {
    return block(
      "no-key-literal",
      "API-key-shaped literal in file content. Build fake keys from parts in tests; never commit a key.",
    );
  }
  if (KEY_ASSIGN.test(content) && !KEY_ASSIGN_EXEMPT_DIRS.some((d) => rel.startsWith(d))) {
    return block(
      "no-api-key",
      "API-key variable assignment outside doctor/, data/generator/, harnesses/ and tests/. This stack uses subscriptions only (rail 1).",
    );
  }
  if (DEPLOY_FILE.test(rel)) {
    if (/--auth-file\b|--multiplayer\b/.test(content)) {
      return block(
        "loopback-only",
        "--auth-file and --multiplayer are forbidden in deployment files: loopback only, single owner (rails 3 and 7).",
      );
    }
    if (/(?:^|[\s=:"'<>])0\.0\.0\.0\b/.test(content)) {
      return block(
        "loopback-only",
        "0.0.0.0 is forbidden in deployment files; bind 127.0.0.1 (rail 3).",
      );
    }
    if (/--preview-domain[=\s]+(?![^\s]*localhost)\S+/.test(content)) {
      return block("loopback-only", "--preview-domain must be a localhost name (rail 3).");
    }
  }
  if (COMPOSE_FILE.test(rel)) {
    const problem = composeViolation(content);
    if (problem) return block("loopback-only", `${problem} (rail 3).`);
  }
  if (CONFIRM_FILE.test(rel) && LIVE_CONFIRM.test(content)) {
    return block(
      "no-live-calls",
      "EXOS_LIVE_CONFIRM must not be set in workflows, Makefile, compose or deploy files (rail 4).",
    );
  }
  if (/^\.github\//.test(rel) && LIVE_TARGET.test(content)) {
    return block(
      "no-live-calls",
      "Workflows must never run make live-claude, live-cursor or eval-live (rail 4).",
    );
  }
  if (
    /(?:^|\/)(?:COMMIT_EDITMSG|[\w.-]*(?:commit|pr)[-_]?(?:msg|message|body)[\w.-]*)$/i.test(rel) &&
    TRAILER.test(content)
  ) {
    return block("no-attribution", "No attribution trailers in commit or PR message files (§1.1).");
  }
  return null;
}

export function evaluate(input, projectDir = process.cwd()) {
  PROJECT_DIR = projectDir;
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};
  if (tool === "Bash") return bashRules(String(ti.command ?? ""));
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const file = String(ti.file_path ?? "");
    if (!file) return null;
    const abs = path.resolve(projectDir, file);
    const rel = path.relative(projectDir, abs).split(path.sep).join("/");
    const parts = [];
    if (typeof ti.content === "string") parts.push(ti.content);
    if (typeof ti.new_string === "string") parts.push(ti.new_string);
    if (Array.isArray(ti.edits))
      for (const e of ti.edits) if (typeof e?.new_string === "string") parts.push(e.new_string);
    return fileRules(rel, parts.join("\n"), existsSync(abs), tool !== "Write");
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
    const verdict = evaluate(input, projectDir);
    if (verdict) {
      process.stderr.write(
        `${JSON.stringify({ decision: "block", reason: `${verdict.rule}: ${verdict.message}` })}\n`,
      );
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(
      `guard.mjs internal error (not blocking): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
