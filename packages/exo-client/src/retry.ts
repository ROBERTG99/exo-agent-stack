export const RETRYABLE_STATUS = new Set([502, 503, 504]);

/**
 * Exponential backoff with +/-50% jitter: 200 ms, 400 ms, 800 ms ... scaled by 0.5 + random().
 * `random` is injected so tests are deterministic.
 */
export function backoffMs(attempt: number, random: () => number): number {
  return Math.round(200 * 2 ** attempt * (0.5 + random()));
}
