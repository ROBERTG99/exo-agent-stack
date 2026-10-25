// Response shapes follow BUILD.md §4.2. They have NOT been checked against the pinned Exo source
// (docs/KNOWN_LIMITATIONS.md): only the members the stack relies on are required, everything else
// passes through, so a richer real response still parses.
import { z } from "zod";

export const agentSchema = z.looseObject({
  id: z.string(),
  slug: z.string().optional(),
  name: z.string().optional(),
});
export const agentsResponse = z.looseObject({ agents: z.array(agentSchema) });

const obj = z.looseObject({});
export const threadResponse = z.looseObject({
  agent: obj.optional(),
  thread: obj,
  harness: z.unknown().optional(),
});
export const turnResponse = z.looseObject({
  agent: obj.optional(),
  thread: obj.optional(),
  turn: z.union([z.string(), z.looseObject({ id: z.string() })]),
  harness: z.unknown().optional(),
});
export const activeResponse = z.looseObject({ active: z.boolean() });
export const cancelResponse = z.looseObject({
  canceled_active_turn: z.boolean(),
  finished_event_id: z.union([z.string(), z.number()]).nullable().optional(),
});
export const threadListResponse = z.looseObject({
  threads: z.array(z.looseObject({})),
  next_cursor: z.string().nullable().optional(),
});
export const forkResponse = z.looseObject({ thread: obj });
export const artifactListResponse = z.looseObject({ artifacts: z.array(z.looseObject({})) });
export const previewsResponse = z.union([
  z.null(),
  z.looseObject({ domain: z.string(), port: z.number() }),
]);

export type ExoAgent = z.infer<typeof agentSchema>;
export type ThreadResponse = z.infer<typeof threadResponse>;
export type TurnResponse = z.infer<typeof turnResponse>;
export type ThreadListResponse = z.infer<typeof threadListResponse>;
export type ForkResponse = z.infer<typeof forkResponse>;
