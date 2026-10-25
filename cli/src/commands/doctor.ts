// `exos doctor [--json] [--root <dir>]`: collects the facts of the stack, runs the 22 checks of
// BUILD.md §15.4 and exits 1 when any check fails. Warnings and skipped checks do not fail it.
import path from "node:path";
import { collectSnapshot } from "@exos/doctor/collect";
import { buildReport, formatReport } from "@exos/doctor/report";
import type { CommandIo } from "../main.ts";

export async function doctorCommand(args: string[], io: CommandIo): Promise<number> {
  const json = args.includes("--json");
  const rootAt = args.indexOf("--root");
  const root = path.resolve(
    rootAt >= 0 ? (args[rootAt + 1] ?? ".") : (io.env.EXOS_REPO_ROOT ?? "."),
  );
  const unknown = args.filter(
    (a, i) => a !== "--json" && a !== "--root" && args[i - 1] !== "--root",
  );
  if (unknown.length > 0) {
    io.err(`exos doctor: unknown argument ${unknown[0]}`);
    io.err("usage: exos doctor [--json] [--root <dir>]");
    return 2;
  }
  const started = Date.now();
  let snapshot;
  try {
    snapshot = await collectSnapshot({ root, env: io.env });
  } catch (err) {
    io.err(
      `exos doctor: could not read the stack: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
  const report = buildReport(snapshot, new Date(), Date.now() - started);
  io.out(json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}
