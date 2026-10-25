#!/usr/bin/env node
// A stand-in for the `claude` binary, used only by tests. It validates its own arguments against
// the recorded `claude --help` (so a wrong flag fails the test), reads the prompt from stdin, and
// plays the behaviour named by a [[fake:<mode>]] marker in the prompt, because the harness gives
// the real binary a scrubbed environment and therefore no other side channel.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const help = readFileSync(join(repo, "fixtures", "claude-help", "claude-help.txt"), "utf8");
const hidden = readFileSync(join(repo, "fixtures", "claude-help", "hidden-flags.txt"), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("--"));

const WITH_VALUE = new Set([
  "--output-format",
  "--model",
  "--permission-prompt-tool",
  "--mcp-config",
  "--setting-sources",
  "--resume",
]);
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("-")) continue;
  const known =
    help
      .split("\n")
      .some((l) => new RegExp(`(^|[\\s,])${a.replace(/-/g, "\\-")}([\\s,<\\[]|$)`).test(l)) ||
    hidden.includes(a);
  if (!known) {
    console.error(`error: unknown option '${a}'`);
    process.exit(2);
  }
  flags[a] = WITH_VALUE.has(a) ? argv[++i] : true;
}
if (!flags["-p"] && !flags["--print"]) {
  console.error("error: the fake only supports headless mode (-p)");
  process.exit(2);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const mode = /\[\[fake:([a-z-]+)\]\]/.exec(prompt)?.[1] ?? "plain";

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const session = flags["--resume"] ?? "sess-fake";
const model = flags["--model"] ?? "unknown";
const init = () =>
  out({
    type: "system",
    subtype: "init",
    session_id: session,
    model,
    cwd: process.cwd(),
    permissionMode: "default",
  });
const text = (t) =>
  out({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: t }] },
    session_id: session,
  });
const done = (result, extra = {}) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    num_turns: 1,
    result,
    session_id: session,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 50,
      output_tokens: 20,
    },
    ...extra,
  });

switch (mode) {
  case "plain":
    init();
    text("Hello from fake claude");
    done("Hello from fake claude");
    break;
  case "dump": {
    init();
    const settingsFile = join(process.cwd(), ".claude", "settings.local.json");
    const info = {
      env: Object.keys(process.env).sort(),
      cwd: process.cwd(),
      args: argv,
      settings: existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : null,
      promptLength: prompt.length,
    };
    text(JSON.stringify(info));
    done(JSON.stringify(info));
    break;
  }
  case "approve": {
    init();
    const cfg = JSON.parse(readFileSync(flags["--mcp-config"], "utf8"));
    const spec = cfg.mcpServers.exos_approvals;
    const client = new Client({ name: "fake-claude", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: { ...spec.env, PATH: process.env.PATH ?? "" },
      }),
    );
    const res = await client.callTool({
      name: "prompt",
      arguments: { tool_name: "Bash", input: { command: "git push origin main" } },
    });
    const decision = JSON.parse(res.content[0].text);
    await client.close();
    if (decision.behavior === "allow") {
      out({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: decision.updatedInput },
          ],
        },
        session_id: session,
      });
      out({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "pushed", is_error: false },
          ],
        },
        session_id: session,
      });
      done("ran the command");
    } else {
      text(`denied: ${decision.message}`);
      done(`denied: ${decision.message}`);
    }
    break;
  }
  case "crash":
    init();
    console.error("boom: something broke");
    process.exit(3);
    break;
  case "hang":
    init();
    setInterval(() => {}, 1000);
    break;
  case "noresult":
    init();
    text("started, never finished");
    break;
  case "badlines":
    init();
    process.stdout.write("this is not json\n\n");
    text("still fine");
    done("still fine");
    break;
  case "error-result":
    init();
    out({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      session_id: session,
      num_turns: 9,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    process.exit(1);
    break;
  default:
    console.error(`unknown fake mode ${mode}`);
    process.exit(2);
}
