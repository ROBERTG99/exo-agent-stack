#!/usr/bin/env -S node --import tsx
// `exos`: the stack's command line. Commands are added per task (audit verify in T-14).
import { fileURLToPath } from "node:url";
import { auditCommand } from "./commands/audit.ts";
import { dualReviewCommand } from "./commands/dual-review.ts";

export interface CommandIo {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

type Command = (args: string[], io: CommandIo) => number | Promise<number>;

export const commands: Record<string, Command> = {
  audit: auditCommand,
  "dual-review": dualReviewCommand,
};

export async function run(argv: string[], io: CommandIo): Promise<number> {
  const [name, ...rest] = argv;
  const command = name ? commands[name] : undefined;
  if (!command) {
    io.err(`usage: exos <${Object.keys(commands).join("|")}> ...`);
    return 2;
  }
  return command(rest, io);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2), {
    env: process.env,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  }).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
