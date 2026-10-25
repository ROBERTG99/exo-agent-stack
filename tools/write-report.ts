// write_report: saves a Markdown report as a thread artifact (BUILD.md §4.7, FR-7). Exo versions
// artifacts, so writing the same name twice gives two versions; the tool is idempotent by
// tool_call_id (§7.3), so a replay after a crash does not add a third.
import { z } from "zod";

export const MAX_REPORT_BYTES = 1024 * 1024;

export const writeReportSchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
      "name must be 1-128 of letters, digits, '.', '_' or '-'",
    ),
  content: z.string(),
});

export type WriteReportInput = z.infer<typeof writeReportSchema>;

/** Where reports go: Exo's artifact API in production, memory in tests. */
export interface ArtifactStore {
  write(
    name: string,
    content: string,
    idempotencyKey: string,
  ): Promise<{ name: string; version: number }>;
}

export async function writeReport(
  store: ArtifactStore,
  input: unknown,
  toolCallId: string,
): Promise<{ name: string; version: number }> {
  const { name, content } = writeReportSchema.parse(input);
  if (Buffer.byteLength(content, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("report is too large: the limit is 1 MB");
  }
  return store.write(name, content, toolCallId);
}

export const writeReportDeclaration = {
  name: "write_report",
  description:
    "Save a Markdown report as an artifact of this thread (at most 1 MB). Writing the same name again creates a new version.",
  input_schema: z.toJSONSchema(writeReportSchema) as Record<string, unknown>,
};
