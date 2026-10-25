// run_checks: runs `make check-fast` in the sandbox and returns a short, ANSI-free summary
// (BUILD.md §4.7). The command has a 600 s timeout; on expiry the whole process group is killed.
import { spawn } from "node:child_process";
import { z } from "zod";

export const TIMEOUT_MS = 600_000;
export const MAX_SUMMARY_CHARS = 4000;

export const runChecksSchema = z.strictObject({});

export interface ExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export type Exec = (
  cmd: string[],
  opts: { timeoutMs: number; cwd?: string },
) => Promise<ExecResult>;

// CSI sequences (colours, cursor movement, erase) and OSC sequences (window titles).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function execCommand(
  cmd: string[],
  opts: { timeoutMs: number; cwd?: string },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    let output = "";
    let timedOut = false;
    // Only the tail matters for the summary; keep memory bounded for chatty commands.
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 256 * 1024) output = output.slice(-128 * 1024);
    };
    // A new process group lets the timeout reach grandchildren (make -> vitest -> workers).
    const child = spawn(bin!, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: `spawn ${bin}: ${err.message}`, timedOut: false });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve({ exitCode: 124, output, timedOut: true });
      else resolve({ exitCode: code ?? (signal ? 137 : 1), output, timedOut: false });
    });
  });
}

export interface RunChecksDeps {
  exec?: Exec;
  now?: () => number;
  cwd?: string;
}

export async function runChecks(
  deps: RunChecksDeps = {},
  input: unknown = {},
): Promise<{ exit_code: number; duration_ms: number; summary: string }> {
  runChecksSchema.parse(input ?? {});
  const exec = deps.exec ?? execCommand;
  const now = deps.now ?? Date.now;
  const started = now();
  const result = await exec(["make", "check-fast"], { timeoutMs: TIMEOUT_MS, cwd: deps.cwd });
  const duration_ms = now() - started;
  let text = stripAnsi(result.output);
  if (result.timedOut)
    text += `\n[run_checks] timed out after ${TIMEOUT_MS / 1000} s and was killed`;
  return { exit_code: result.exitCode, duration_ms, summary: text.slice(-MAX_SUMMARY_CHARS) };
}

export const runChecksDeclaration = {
  name: "run_checks",
  description:
    "Run `make check-fast` (lint and unit tests) in the sandbox and return the exit code, duration and the last 4000 characters of output.",
  input_schema: z.toJSONSchema(runChecksSchema) as Record<string, unknown>,
};
