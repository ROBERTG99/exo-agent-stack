/** Exo could not be reached, or kept answering 502/503/504, after the allowed retries. */
export class ExoUnavailableError extends Error {
  readonly code = "exo_unavailable";
  constructor(
    message: string,
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExoUnavailableError";
  }
}

/** Exo answered with a non-success status that is not worth retrying (4xx, 500). */
export class ExoHttpError extends Error {
  readonly code = "exo_http_error";
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly path: string,
  ) {
    super(`Exo answered ${status} for ${path}`);
    this.name = "ExoHttpError";
  }
}

/** Exo answered, but not with the shape documented in BUILD.md §4.2. */
export class ExoProtocolError extends Error {
  readonly code = "exo_protocol_error";
  constructor(message: string) {
    super(message);
    this.name = "ExoProtocolError";
  }
}
