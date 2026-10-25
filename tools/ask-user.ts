// ask_user: a frontend tool. The agent asks the human a question; stackd sends this declaration as
// `frontend_tools` on every turn (BUILD.md §4.7) and the dashboard or `exo_answer` supplies the
// result. Wrapping the declaration in Exo's tool format is verified in T-09 (V-13).
import { z } from "zod";

export const askUserSchema = z.strictObject({
  question: z.string().min(1).max(2000),
  choices: z.array(z.string().min(1)).max(6).optional(),
});

export type AskUserInput = z.infer<typeof askUserSchema>;

export function parseAskUser(input: unknown): AskUserInput {
  return askUserSchema.parse(input);
}

export const askUserDeclaration = {
  name: "ask_user",
  description:
    "Ask the human operator a question and wait for the answer. Use it when a decision is theirs to make or information is missing; offer up to 6 choices when the options are known.",
  input_schema: z.toJSONSchema(askUserSchema) as Record<string, unknown>,
};
