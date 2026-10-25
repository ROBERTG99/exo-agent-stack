// Errors a bridge tool reports (BUILD.md §4.6): `isError: true` with `{code, message, details}`.
export const ERROR_CODES = [
  "invalid_input",
  "not_found",
  "ambiguous_thread",
  "turn_active",
  "credit_stop",
  "dashboard_only",
  "fork_at_unsupported",
  "idempotency_conflict",
  "exo_unavailable",
  "workspace_not_allowed",
  "rate_limited",
  // beyond the spec's list, for cases it does not name
  "already_decided",
  "stack_unavailable",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

interface Problem {
  code?: unknown;
  detail?: unknown;
  title?: unknown;
}

const KNOWN = new Set<string>(ERROR_CODES);

/** Maps stackd's problem+json to a tool error. Nothing from the body is passed on except stable fields. */
export function fromProblem(status: number, body: unknown): BridgeError {
  const p = (typeof body === "object" && body !== null ? body : {}) as Problem;
  const code = typeof p.code === "string" ? p.code : "";
  const detail =
    typeof p.detail === "string"
      ? p.detail.slice(0, 500)
      : typeof p.title === "string"
        ? p.title
        : `stackd answered ${status}`;
  if (KNOWN.has(code)) return new BridgeError(code as ErrorCode, detail);
  if (code === "exo_error" || code === "exo_protocol" || code === "exo_conflict") {
    return new BridgeError("exo_unavailable", detail, { upstream_code: code });
  }
  if (code === "worktree_conflict")
    return new BridgeError("invalid_input", detail, { upstream_code: code });
  if (status === 401) {
    return new BridgeError(
      "internal_error",
      "stackd did not accept the bridge's token: check EXOS_LOCAL_TOKEN",
      { status },
    );
  }
  return new BridgeError("internal_error", detail, { status, upstream_code: code || null });
}
