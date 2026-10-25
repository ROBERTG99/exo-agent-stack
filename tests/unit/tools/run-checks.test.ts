import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_CHARS, execCommand, runChecks, stripAnsi } from "../../../tools/run-checks.ts";

describe("stripAnsi", () => {
  it("removes colour, cursor and OSC sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m plain \u001b[2K\u001b[1Gdone")).toBe("red plain done");
    expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
  });
});

describe("execCommand", () => {
  it("captures stdout and stderr and the exit code", async () => {
    const r = await execCommand(
      ["node", "-e", "console.log('out'); console.error('err'); process.exit(3)"],
      { timeoutMs: 10_000 },
    );
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  it("kills a command that exceeds the timeout, including its children", async () => {
    const started = Date.now();
    const r = await execCommand(["sh", "-c", "sleep 30 & wait"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports a command that cannot start", async () => {
    const r = await execCommand(["definitely-not-a-command-xyz"], { timeoutMs: 5000 });
    expect(r.exitCode).toBe(127);
    expect(r.output).toMatch(/not found|ENOENT|spawn/i);
  });

  it("runs in the requested working directory", async () => {
    const r = await execCommand(["node", "-e", "console.log(process.cwd())"], {
      timeoutMs: 5000,
      cwd: "/tmp",
    });
    expect(r.output.trim()).toMatch(/\/tmp$|\/private\/tmp$/);
  });
});

describe("run_checks", () => {
  it("runs make check-fast by default and summarises the result", async () => {
    const seen: string[][] = [];
    const out = await runChecks({
      exec: async (cmd) => {
        seen.push(cmd);
        return { exitCode: 0, output: "all good\n", timedOut: false };
      },
      now: (() => {
        let t = 1000;
        return () => (t += 250);
      })(),
    });
    expect(seen).toEqual([["make", "check-fast"]]);
    expect(out).toEqual({ exit_code: 0, duration_ms: 250, summary: "all good\n" });
  });

  it("keeps the last 4000 characters with ANSI removed", async () => {
    const long = "x".repeat(10_000) + "\u001b[31mTAIL\u001b[0m";
    const out = await runChecks({
      exec: async () => ({ exitCode: 1, output: long, timedOut: false }),
      now: () => 0,
    });
    expect(MAX_SUMMARY_CHARS).toBe(4000);
    expect(out.summary).toHaveLength(4000);
    expect(out.summary.endsWith("TAIL")).toBe(true);
    expect(out.exit_code).toBe(1);
  });

  it("reports a timeout with exit code 124 and says so in the summary", async () => {
    const out = await runChecks({
      exec: async () => ({ exitCode: 124, output: "partial", timedOut: true }),
      now: () => 0,
    });
    expect(out.exit_code).toBe(124);
    expect(out.summary).toMatch(/timed out after 600/i);
    expect(out.summary).toContain("partial");
  });

  it("uses a 600 second timeout", async () => {
    let timeout = 0;
    await runChecks({
      exec: async (_cmd, opts) => {
        timeout = opts.timeoutMs;
        return { exitCode: 0, output: "", timedOut: false };
      },
      now: () => 0,
    });
    expect(timeout).toBe(600_000);
  });

  it("rejects arguments (the tool takes none)", async () => {
    await expect(
      runChecks(
        { exec: async () => ({ exitCode: 0, output: "", timedOut: false }), now: () => 0 },
        { target: "x" } as never,
      ),
    ).rejects.toThrow();
  });
});
