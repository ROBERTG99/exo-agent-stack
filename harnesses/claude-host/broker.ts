// A tiny request/response channel between the harness and the approvals MCP server, which Claude
// Code starts as a separate process. One JSON line in, one JSON line out, over a unix socket in a
// private directory. Every failure path answers "deny": an approval problem must never allow.
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import {
  toExoToolName,
  toMcpDecision,
  type ApprovalDecision,
  type ApprovalRequest,
  type McpDecision,
} from "./approvals.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;
const deny = (message: string): McpDecision => ({ behavior: "deny", message });

export class ApprovalBroker {
  private server?: Server;
  private sockets = new Set<Socket>();
  private path?: string;

  constructor(private readonly authorize: (req: ApprovalRequest) => Promise<ApprovalDecision>) {}

  listen(socketPath: string): Promise<void> {
    this.path = socketPath;
    this.server = createServer((socket) => this.handle(socket));
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => resolve());
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    if (this.path) await rm(this.path, { force: true });
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_REQUEST_BYTES)
        return void socket.end(`${JSON.stringify(deny("request too large"))}\n`);
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      void this.answer(buffer.slice(0, nl)).then((reply) =>
        socket.end(`${JSON.stringify(reply)}\n`),
      );
      socket.removeAllListeners("data");
    });
  }

  private async answer(line: string): Promise<McpDecision> {
    let req: { tool_name?: unknown; input?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return deny("malformed approval request");
    }
    let name: string;
    try {
      name = toExoToolName(String(req.tool_name));
    } catch {
      return deny("invalid tool name");
    }
    try {
      return toMcpDecision(await this.authorize({ name, arguments: req.input }), req.input);
    } catch (err) {
      return deny(`approval failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Asks the broker; answers deny if it cannot be reached or does not answer. */
export function askBroker(
  socketPath: string,
  req: { tool_name: string; input: unknown },
): Promise<McpDecision> {
  return new Promise((resolve) => {
    const unavailable = () => resolve(deny("approval service unavailable"));
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.once("error", unavailable);
    socket.once("connect", () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on("data", (c) => (buffer += c.toString("utf8")));
    socket.once("close", () => {
      try {
        resolve(JSON.parse(buffer.trim()) as McpDecision);
      } catch {
        unavailable();
      }
    });
  });
}
