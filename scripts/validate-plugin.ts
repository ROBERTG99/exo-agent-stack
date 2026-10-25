// Checks the Claude Code plugin in plugin/ and the Cursor configuration in .cursor/ (BUILD.md §7.4,
// FR-9): the manifest is well formed, every bridge tool the plugin names exists, nothing pre-approves
// `exo_approve`, and the Cursor entry points at the loopback bridge with a token from the environment.
// This does not run Claude Code's own `claude plugin validate`, which a maintainer can run on a host.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ERROR_CODES } from "../bridge/src/errors.ts";
import { TOOL_NAMES } from "../bridge/src/schemas.ts";

export interface Problem {
  file: string;
  message: string;
}

const PLUGIN = "exos";
const SERVER = "exos-bridge";
const PREFIX = `mcp__plugin_${PLUGIN}_${SERVER}__`;

const MANIFEST_KEYS = new Set([
  "$schema",
  "name",
  "displayName",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "defaultEnabled",
  "dependencies",
  "metadata",
  "skills",
  "commands",
  "agents",
  "hooks",
  "mcpServers",
  "lspServers",
  "outputStyles",
  "experimental",
  "userConfig",
  "channels",
  "settings",
]);
const USER_CONFIG_KEYS = new Set([
  "type",
  "title",
  "description",
  "required",
  "default",
  "options",
  "multiple",
  "sensitive",
  "min",
  "max",
]);
const USER_CONFIG_TYPES = new Set(["string", "number", "boolean", "directory", "file"]);
const COMMAND_KEYS = new Set([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "allowed-tools",
  "disallowed-tools",
  "disable-model-invocation",
  "model",
  "effort",
  "context",
  "agent",
]);
// Fields a plugin's agents may set; mcpServers, hooks and permissionMode are ignored there for safety.
const AGENT_KEYS = new Set([
  "name",
  "description",
  "model",
  "effort",
  "maxTurns",
  "autoCompactWindow",
  "tools",
  "disallowedTools",
  "skills",
  "memory",
  "background",
  "omitClaudeMd",
  "isolation",
  "color",
]);

const read = (p: string): string => readFileSync(p, "utf8");

function frontMatter(text: string): { front: Record<string, unknown>; body: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  try {
    return { front: (parseYaml(m[1]!) ?? {}) as Record<string, unknown>, body: m[2]! };
  } catch {
    return null;
  }
}

/** A space- or comma-separated string, or a list, as the names it holds. */
function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

function jsonFile(
  file: string,
  repo: string,
  problems: Problem[],
): Record<string, unknown> | undefined {
  const shown = path.relative(repo, file);
  if (!existsSync(file)) {
    problems.push({ file: shown, message: "file is missing" });
    return undefined;
  }
  try {
    return JSON.parse(read(file)) as Record<string, unknown>;
  } catch (err) {
    problems.push({
      file: shown,
      message: `not valid JSON (${(err as Error).message.split("\n")[0]})`,
    });
    return undefined;
  }
}

function checkToolReferences(file: string, text: string, problems: Problem[]): void {
  for (const m of text.matchAll(/mcp__[A-Za-z0-9_-]+/g)) {
    const ref = m[0];
    const tool = ref.startsWith(PREFIX) ? ref.slice(PREFIX.length) : undefined;
    if (tool === undefined)
      problems.push({
        file,
        message: `${ref} is not a tool of the ${SERVER} server of this plugin`,
      });
    else if (!(TOOL_NAMES as string[]).includes(tool))
      problems.push({ file, message: `${ref}: the bridge has no tool ${tool}` });
  }
  for (const m of text.matchAll(/\bexo_[a-z_]+\b/g)) {
    if (
      !(TOOL_NAMES as string[]).includes(m[0]) &&
      !(ERROR_CODES as readonly string[]).includes(m[0])
    )
      problems.push({ file, message: `${m[0]} is not a bridge tool` });
  }
}

export function validatePlugin(repo: string): Problem[] {
  const problems: Problem[] = [];
  const dir = path.join(repo, "plugin");
  const rel = (p: string) => path.relative(repo, p);

  // --- manifest -------------------------------------------------------------------------------
  const manifestFile = path.join(dir, ".claude-plugin", "plugin.json");
  const manifest = jsonFile(manifestFile, repo, problems);
  const declared = new Set<string>();
  if (manifest) {
    const f = rel(manifestFile);
    for (const key of Object.keys(manifest))
      if (!MANIFEST_KEYS.has(key))
        problems.push({ file: f, message: `unknown top-level key "${key}"` });
    if (manifest.name !== PLUGIN) problems.push({ file: f, message: `name must be "${PLUGIN}"` });
    if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version))
      problems.push({ file: f, message: "version must be semver" });
    if (typeof manifest.description !== "string" || manifest.description.length < 10)
      problems.push({ file: f, message: "description is missing" });
    if (typeof (manifest.author as { name?: unknown } | undefined)?.name !== "string")
      problems.push({ file: f, message: "author.name is required" });
    for (const [key, opt] of Object.entries(
      (manifest.userConfig as Record<string, Record<string, unknown>> | undefined) ?? {},
    )) {
      declared.add(key);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        problems.push({ file: f, message: `userConfig key "${key}" is not an identifier` });
      for (const k of Object.keys(opt))
        if (!USER_CONFIG_KEYS.has(k))
          problems.push({ file: f, message: `userConfig.${key}: unknown key "${k}"` });
      for (const required of ["type", "title", "description"]) {
        if (typeof opt[required] !== "string")
          problems.push({ file: f, message: `userConfig.${key}.${required} is required` });
      }
      if (typeof opt.type === "string" && !USER_CONFIG_TYPES.has(opt.type))
        problems.push({ file: f, message: `userConfig.${key}.type "${opt.type}" is not valid` });
    }
  }

  // --- the MCP server -------------------------------------------------------------------------
  const mcpFile = path.join(dir, ".mcp.json");
  const mcp = jsonFile(mcpFile, repo, problems) as
    | {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[]; env?: Record<string, string> }
        >;
      }
    | undefined;
  if (mcp) {
    const f = rel(mcpFile);
    const server = mcp.mcpServers?.[SERVER];
    if (!server) problems.push({ file: f, message: `no server named ${SERVER}` });
    else {
      if (server.command !== "node")
        problems.push({ file: f, message: "the bridge is started with node" });
      if (!server.args?.some((a) => a.endsWith("/bridge/dist/stdio.js")))
        problems.push({ file: f, message: "args must run bridge/dist/stdio.js" });
      for (const text of [...(server.args ?? []), ...Object.values(server.env ?? {})]) {
        for (const m of text.matchAll(/\$\{([^}]+)\}/g)) {
          const ref = m[1]!;
          const ok =
            ref === "CLAUDE_PLUGIN_ROOT" ||
            ref === "CLAUDE_PLUGIN_DATA" ||
            (ref.startsWith("user_config.") && declared.has(ref.slice(12)));
          if (!ok)
            problems.push({
              file: f,
              message: `\${${ref}} refers to something the manifest does not declare`,
            });
        }
      }
      if (Object.values(server.env ?? {}).some((v) => /^[0-9a-f]{32,}$/i.test(v)))
        problems.push({ file: f, message: "a token must not be written into the server's env" });
    }
  }

  // --- commands and agents --------------------------------------------------------------------
  const markdown = (sub: string) =>
    existsSync(path.join(dir, sub))
      ? readdirSync(path.join(dir, sub))
          .filter((n) => n.endsWith(".md"))
          .sort()
          .map((n) => path.join(dir, sub, n))
      : [];
  const commands = markdown("commands");
  const agents = markdown("agents");
  for (const required of ["exo-delegate", "exo-status", "exo-approve"]) {
    if (!commands.some((c) => path.basename(c) === `${required}.md`))
      problems.push({
        file: rel(path.join(dir, "commands")),
        message: `${required}.md is missing`,
      });
  }
  if (!agents.some((a) => path.basename(a) === "delegator.md"))
    problems.push({ file: rel(path.join(dir, "agents")), message: "delegator.md is missing" });

  const approveTool = `${PREFIX}exo_approve`;
  for (const file of [...commands, ...agents]) {
    const f = rel(file);
    const text = read(file);
    const fm = frontMatter(text);
    if (!fm) {
      problems.push({ file: f, message: "no readable front matter" });
      continue;
    }
    const isAgent = agents.includes(file);
    const allowedKeys = isAgent ? AGENT_KEYS : COMMAND_KEYS;
    for (const k of Object.keys(fm.front)) {
      if (!allowedKeys.has(k))
        problems.push({
          file: f,
          message: `front matter key "${k}" is not recognised${isAgent ? " in a plugin agent" : ""}`,
        });
    }
    if (typeof fm.front.description !== "string" || fm.front.description.length < 10)
      problems.push({ file: f, message: "description is missing" });
    checkToolReferences(f, text, problems);
    const granted = names(isAgent ? fm.front.tools : fm.front["allowed-tools"]);
    if (granted.includes(approveTool))
      problems.push({ file: f, message: "exo_approve must not be pre-approved or granted here" });
    if (!/untrusted/i.test(fm.body) && path.basename(file) !== "exo-approve.md")
      problems.push({ file: f, message: "must tell the model that agent output is untrusted" });
    if (path.basename(file) === "exo-approve.md") {
      if (fm.front["disable-model-invocation"] !== true)
        problems.push({
          file: f,
          message: "exo-approve must set disable-model-invocation: true (only the user runs it)",
        });
      if (!/until the user has said/i.test(fm.body))
        problems.push({
          file: f,
          message: "exo-approve must say to wait for the user's own message",
        });
      if (!/untrusted/i.test(fm.body))
        problems.push({ file: f, message: "must label agent output as data" });
    }
    if (path.basename(file) === "delegator.md") {
      const expected = (TOOL_NAMES as string[])
        .filter((t) => t !== "exo_approve")
        .map((t) => `${PREFIX}${t}`)
        .sort();
      if (JSON.stringify([...granted].sort()) !== JSON.stringify(expected)) {
        problems.push({
          file: f,
          message: "the delegator needs every bridge tool except exo_approve, and nothing else",
        });
      }
    }
  }

  // --- the project's own .mcp.json -------------------------------------------------------------
  const projectMcp = jsonFile(path.join(repo, ".mcp.json"), repo, problems) as
    { mcpServers?: Record<string, { command?: string; args?: string[] }> } | undefined;
  const entry = projectMcp?.mcpServers?.[SERVER];
  if (projectMcp && (entry?.command !== "node" || !entry.args?.includes("bridge/dist/stdio.js"))) {
    problems.push({ file: ".mcp.json", message: `${SERVER} must run node bridge/dist/stdio.js` });
  }

  // --- Cursor ---------------------------------------------------------------------------------
  const cursorFile = path.join(repo, ".cursor", "mcp.json");
  const cursor = jsonFile(cursorFile, repo, problems) as
    { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> } | undefined;
  if (cursor) {
    const f = rel(cursorFile);
    const s = cursor.mcpServers?.[SERVER];
    if (!s) problems.push({ file: f, message: `no server named ${SERVER}` });
    else {
      if (s.url !== "http://127.0.0.1:9811/mcp")
        problems.push({ file: f, message: "url must be http://127.0.0.1:9811/mcp" });
      if (s.headers?.Authorization !== "Bearer ${env:EXOS_LOCAL_TOKEN}") {
        problems.push({
          file: f,
          message:
            "Authorization must be exactly `Bearer ${env:EXOS_LOCAL_TOKEN}`: the token comes from the environment, never from the file",
        });
      }
    }
  }
  const ruleFile = path.join(repo, ".cursor", "rules", "exo-delegation.mdc");
  if (!existsSync(ruleFile)) problems.push({ file: rel(ruleFile), message: "file is missing" });
  else {
    const f = rel(ruleFile);
    const text = read(ruleFile);
    const fm = frontMatter(text);
    if (!fm || typeof fm.front.description !== "string")
      problems.push({ file: f, message: "needs front matter with a description" });
    checkToolReferences(f, text, problems);
    if (!/untrusted/i.test(text))
      problems.push({ file: f, message: "must tell the model that agent output is untrusted" });
    if (!/never approve/i.test(text))
      problems.push({
        file: f,
        message: "must say never to approve without the user's own message",
      });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = validatePlugin(repo);
  for (const p of problems) console.error(`${p.file}: ${p.message}`);
  console.log(
    problems.length === 0
      ? "plugin and Cursor configuration are valid"
      : `${problems.length} problem(s)`,
  );
  process.exit(problems.length === 0 ? 0 : 1);
}
