import { existsSync } from "node:fs";
import { join } from "node:path";
import { openReadonly, verifyAuditChain } from "@exos/stackd/db";
import type { CommandIo } from "../main.ts";

/** `exos audit verify [--json]`: recompute the hash chain of stack.db. Exit 0 ok, 1 broken, 2 no database. */
export function auditCommand(args: string[], io: CommandIo): number {
  if (args[0] !== "verify") {
    io.err("usage: exos audit verify [--json]");
    return 2;
  }
  const json = args.includes("--json");
  const file = join(io.env.EXOS_STATE_DIR || ".exos-state", "stack.db");
  if (!existsSync(file)) {
    io.err(`no database at ${file}; start stackd once or set EXOS_STATE_DIR`);
    return 2;
  }
  const db = openReadonly(file);
  try {
    const result = verifyAuditChain(db);
    if (json) io.out(JSON.stringify(result));
    if (result.ok) {
      if (!json) io.out(`audit chain ok: ${result.count} events`);
      return 0;
    }
    if (!json) {
      io.err(`audit chain BROKEN at event ${result.brokenAt}: ${result.reason}`);
    }
    return 1;
  } finally {
    db.close();
  }
}
