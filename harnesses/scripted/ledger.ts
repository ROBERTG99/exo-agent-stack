// Test-only exactly-once evidence for FR-10. The scripted harness's ledger_append tool writes one
// line per tool call id; the durability suite then checks "N unique entries, 0 duplicates" after
// Exo was killed mid-turn. The tool is idempotent by tool_call_id (BUILD.md §7.3: the idempotency
// key of tool calls is the tool_call_id), so re-executing a call whose result was lost in the crash
// adds no second line; each absorbed replay is noted in `<ledger>.absorbed` for the report.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LedgerEntry {
  tool_call_id: string;
  seq: number;
}

function readEntries(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LedgerEntry);
}

export function appendLedger(
  path: string,
  entry: LedgerEntry,
): { ok: true; seq: number; absorbed: boolean } {
  if (readEntries(path).some((e) => e.tool_call_id === entry.tool_call_id)) {
    appendFileSync(`${path}.absorbed`, `${entry.tool_call_id}\n`);
    return { ok: true, seq: entry.seq, absorbed: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return { ok: true, seq: entry.seq, absorbed: false };
}

export function ledgerStats(path: string): {
  entries: number;
  unique: number;
  duplicates: number;
  seqs: number[];
} {
  const entries = readEntries(path);
  const unique = new Map(entries.map((e) => [e.tool_call_id, e.seq]));
  return {
    entries: entries.length,
    unique: unique.size,
    duplicates: entries.length - unique.size,
    seqs: [...unique.values()].sort((a, b) => a - b),
  };
}
