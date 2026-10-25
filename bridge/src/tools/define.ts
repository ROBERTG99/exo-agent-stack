// Registers a tool with the shared behaviour: every call counts against the call limit, results
// carry `structuredContent` plus one line of text written here (never agent text), and errors are
// `isError: true` with `{code, message, details}`.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { BridgeContext } from "../context.ts";
import { BridgeError } from "../errors.ts";
import { SCHEMAS, type ToolName, type ToolSchema } from "../schemas.ts";

type Shape<K extends ToolName> = (typeof SCHEMAS)[K];
type Args<K extends ToolName> = z.infer<z.ZodObject<Shape<K>["input"]>>;
type Out<K extends ToolName> = z.input<z.ZodObject<Shape<K>["output"]>>;

export interface ToolResult<K extends ToolName> {
  data: Out<K>;
  /** One line for the model, built from stack-written values only. */
  text: string;
}

export function errorResult(err: unknown) {
  const e =
    err instanceof BridgeError
      ? err
      : new BridgeError("internal_error", "the bridge hit an unexpected error");
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${e.code}: ${e.message}` }],
    structuredContent: { code: e.code, message: e.message, details: e.details },
  };
}

export function defineTool<K extends ToolName>(
  server: McpServer,
  ctx: BridgeContext,
  name: K,
  run: (args: Args<K>, ctx: BridgeContext) => Promise<ToolResult<K>>,
): void {
  const schema: ToolSchema = SCHEMAS[name];
  server.registerTool(
    name,
    {
      title: schema.title,
      description: schema.description,
      inputSchema: schema.input,
      outputSchema: schema.output,
      annotations: schema.annotations,
    },
    (async (args: unknown) => {
      const taken = ctx.limiter.take();
      if (!taken.ok) {
        return errorResult(
          new BridgeError("rate_limited", "too many calls: the limit is 60 a minute", {
            retry_after_s: Math.ceil(taken.retryAfterMs / 1000),
          }),
        );
      }
      try {
        const result = await run(args as Args<K>, ctx);
        return {
          content: [{ type: "text" as const, text: result.text }],
          structuredContent: result.data,
        };
      } catch (err) {
        return errorResult(err);
      }
    }) as never,
  );
}
