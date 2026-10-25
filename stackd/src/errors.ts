// Errors that stackd maps to RFC 9457 problem+json at the HTTP edge. Every one has a stable `code`
// (BUILD.md §4.6); nothing here carries a secret or a raw upstream body.
import { ExoHttpError, ExoProtocolError, ExoUnavailableError } from "@exos/exo-client";
import { ZodError } from "zod";
import { WorkspaceError, WorkspaceNotAllowedError, WorktreeConflictError } from "./worktrees.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    detail?: string,
  ) {
    super(detail ?? title);
    this.name = "ApiError";
  }
}

export const notFound = (what: string) =>
  new ApiError(404, "not_found", "Not found", `${what} not found`);

export interface ProblemShape {
  status: number;
  code: string;
  title: string;
  detail?: string;
  extra?: Record<string, unknown>;
}

/** The problem a thrown error stands for, or undefined when it is not one of ours. */
export function toProblem(err: unknown): ProblemShape | undefined {
  if (err instanceof ApiError) {
    return { status: err.status, code: err.code, title: err.title, detail: err.message };
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return {
      status: 400,
      code: "invalid_input",
      title: "Invalid input",
      detail: `${where}${issue?.message ?? "invalid"}`,
    };
  }
  if (err instanceof ExoUnavailableError) {
    return {
      status: 503,
      code: "exo_unavailable",
      title: "Exo unavailable",
      detail: err.message,
    };
  }
  if (err instanceof ExoHttpError) {
    const body = err.body as { error?: { code?: string } } | undefined;
    if (err.status === 404) return { status: 404, code: "not_found", title: "Not found" };
    if (err.status === 400) {
      return {
        status: 400,
        code: "invalid_input",
        title: "Invalid input",
        detail: "Exo rejected the request as malformed",
      };
    }
    if (err.status === 409) {
      const code = body?.error?.code === "turn_active" ? "turn_active" : "exo_conflict";
      return { status: 409, code, title: "Conflict", detail: `Exo answered 409 (${code})` };
    }
    return {
      status: 502,
      code: "exo_error",
      title: "Exo error",
      detail: `Exo answered ${err.status} for ${err.path}`,
    };
  }
  if (err instanceof ExoProtocolError) {
    return {
      status: 502,
      code: "exo_protocol",
      title: "Unexpected Exo response",
      detail: err.message,
    };
  }
  if (err instanceof WorkspaceNotAllowedError) {
    return { status: 403, code: "workspace_not_allowed", title: "Forbidden", detail: err.message };
  }
  if (err instanceof WorkspaceError) {
    return { status: 400, code: "invalid_input", title: "Invalid workspace", detail: err.message };
  }
  if (err instanceof WorktreeConflictError) {
    return { status: 409, code: "worktree_conflict", title: "Conflict", detail: err.message };
  }
  return undefined;
}
