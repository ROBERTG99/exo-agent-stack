// The nine bridge tools (BUILD.md §4.6).
import type { Register } from "../mcp.ts";
import { registerReads } from "./reads.ts";
import { registerWrites } from "./writes.ts";

export const registerTools: Register = (server, ctx) => {
  registerReads(server, ctx);
  registerWrites(server, ctx);
};
