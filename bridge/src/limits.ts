// Limits the bridge puts on what passes through it (BUILD.md NFR-8): a prompt of at most 20,000
// characters, event text cut at 4,000, and 60 tool calls a minute.
export const LIMITS = {
  promptChars: 20_000,
  eventTextChars: 4_000,
  callsPerMinute: 60,
  /** HTTP request bodies above this are refused with 413. */
  bodyBytes: 256 * 1024,
} as const;

export type Take = { ok: true } | { ok: false; retryAfterMs: number };

/** A sliding-window limiter: at most `max` accepted calls in any `windowMs`. */
export class RateLimiter {
  private readonly accepted: number[] = [];

  constructor(
    private readonly max: number = LIMITS.callsPerMinute,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(max) || max < 1)
      throw new Error("rate limit must be a positive whole number");
    if (!Number.isFinite(windowMs) || windowMs <= 0)
      throw new Error("rate window must be positive");
  }

  take(): Take {
    const t = this.now();
    while (this.accepted.length > 0 && this.accepted[0]! <= t - this.windowMs)
      this.accepted.shift();
    if (this.accepted.length >= this.max) {
      return { ok: false, retryAfterMs: this.accepted[0]! + this.windowMs - t };
    }
    this.accepted.push(t);
    return { ok: true };
  }
}

export function checkPrompt(text: string): boolean {
  return text.length >= 1 && text.length <= LIMITS.promptChars;
}

/** Cuts agent-written text to the event-text limit and says how much was left out. */
export function clipText(
  text: string,
  max: number = LIMITS.eventTextChars,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  // do not leave half of a surrogate pair at the cut
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return {
    text: `${text.slice(0, end)}… [${text.length - end} more characters not shown]`,
    truncated: true,
  };
}

/** Splits a Host header into a lower-case name and an optional port. */
export function parseHostHeader(
  host: string | undefined,
): { name: string; port: number | undefined } | null {
  if (!host) return null;
  const m = host.match(/^(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : undefined };
}
