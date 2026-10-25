// Mode A: run one turn of the unmodified `claude` binary, headless, in a thread's worktree, with
// the maintainer's own login and no Exo credential (BUILD.md §4.7, FR-4).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildClaudeArgs } from "./args.ts";
import type { ApprovalDecision, ApprovalRequest } from "./approvals.ts";
import { ApprovalBroker } from "./broker.ts";
import { childEnv } from "./env.ts";
import { writeSettings } from "./settings.ts";
import { TurnCollector, toExoUsage, type ExoUsage, type TurnEvent } from "./stream.ts";

export class ClaudeNotFoundError extends Error {
  readonly code = "claude_not_found";
  constructor(bin: string) {
    super(`claude binary not found: ${bin}`);
    this.name = "ClaudeNotFoundError";
  }
}

export interface LauncherOptions {
  /** The real binary (EXOS_CLAUDE_BIN), never the interactive shell wrapper. */
  claudeBin: string;
  worktree: string;
  prompt: string;
  model: string;
  authorize: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  parentEnv: Record<string, string | undefined>;
  /** Directory for the per-turn socket and MCP config; keep it short (unix socket path limit). */
  runtimeBase?: string;
  resumeSessionId?: string;
  /** Extra MCP servers (an agent's own mcp_servers) added next to the approvals server. */
  extraMcpServers?: Record<string, unknown>;
  onEvent?: (event: TurnEvent) => void;
  signal?: AbortSignal;
  approvalsMcpPath?: string;
}

export interface LauncherResult {
  exitCode: number;
  sessionId?: string;
  model?: string;
  resultText?: string;
  isError: boolean;
  errorReason?: string;
  subtype?: string;
  usage: ExoUsage | null;
  stderrTail: string;
  badLines: number;
  aborted: boolean;
}

const APPROVALS_MCP = fileURLToPath(new URL("./approvals-mcp.ts", import.meta.url));
const STDERR_TAIL = 4000;

export async function runClaudeTurn(opts: LauncherOptions): Promise<LauncherResult> {
  mkdirSync(opts.worktree, { recursive: true });
  writeSettings(opts.worktree);

  const base = opts.runtimeBase ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const runtimeDir = mkdtempSync(join(base, "exa-"));
  const broker = new ApprovalBroker(opts.authorize);
  try {
    const socketPath = join(runtimeDir, "b.sock");
    await broker.listen(socketPath);

    // `--import tsx` lets the MCP server run from source; an absolute file URL because Claude
    // starts it with the worktree as working directory, where tsx cannot be resolved by name.
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const mcpConfig = {
      mcpServers: {
        exos_approvals: {
          command: process.execPath,
          args: ["--import", tsx, opts.approvalsMcpPath ?? APPROVALS_MCP],
          env: { EXOS_APPROVALS_SOCKET: socketPath },
        },
        ...opts.extraMcpServers,
      },
    };
    const mcpConfigPath = join(runtimeDir, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });

    const args = buildClaudeArgs({
      model: opts.model,
      mcpConfigPath,
      resumeSessionId: opts.resumeSessionId,
    });
    return await spawnClaude(opts, args);
  } finally {
    await broker.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function spawnClaude(opts: LauncherOptions, args: string[]): Promise<LauncherResult> {
  return new Promise((resolve, reject) => {
    const collector = new TurnCollector();
    let stderr = "";
    let aborted = false;
    let buffer = "";

    // A process group, so an abort also reaches anything claude started.
    const child = spawn(opts.claudeBin, args, {
      cwd: opts.worktree,
      env: childEnv(opts.parentEnv),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    };
    const onAbort = () => {
      aborted = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 1000).unref();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line: string) => {
      for (const event of collector.feed(line)) opts.onEvent?.(event);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => {}); // the child may exit before reading the whole prompt
    child.stdin.end(opts.prompt);

    child.once("error", (err: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err.code === "ENOENT" ? new ClaudeNotFoundError(opts.claudeBin) : err);
    });
    child.once("close", (code, signal) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (buffer.trim() !== "") handleLine(buffer);
      const exitCode = code ?? (signal ? 137 : 1);
      const outcome = collector.outcome();
      const isError = aborted || exitCode !== 0 || outcome.isError;
      resolve({
        exitCode,
        sessionId: outcome.sessionId ?? opts.resumeSessionId,
        model: outcome.model,
        resultText: outcome.resultText,
        isError,
        errorReason: aborted
          ? "aborted"
          : (outcome.errorReason ??
            (exitCode !== 0 ? `claude exited with code ${exitCode}` : undefined)),
        subtype: outcome.subtype,
        usage: toExoUsage(outcome, opts.model),
        stderrTail: stderr,
        badLines: outcome.badLines,
        aborted,
      });
    });
  });
}
