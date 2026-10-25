// What every bridge tool needs: where stackd is, how to authenticate to it, and the call limiter.
import { isLocalServiceUrl } from "@exos/common";
import { RateLimiter } from "./limits.ts";

export interface BridgeContext {
  stackdUrl: string;
  /** The API token (never the dashboard token). */
  stackdToken: string;
  limiter: RateLimiter;
  fetchImpl: typeof fetch;
  /** Base URL of the dashboard, for links. */
  dashboardUrl: string;
}

export function makeContext(opts: {
  stackdUrl: string;
  stackdToken: string;
  limiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  dashboardUrl?: string;
}): BridgeContext {
  // The bearer token goes with every request, so it may only go to a local stackd.
  if (!isLocalServiceUrl(opts.stackdUrl)) {
    throw new Error(
      "EXOS_STACKD_URL must name a local stackd (a loopback address or a compose service name)",
    );
  }
  return {
    stackdUrl: opts.stackdUrl.replace(/\/+$/, ""),
    stackdToken: opts.stackdToken,
    limiter: opts.limiter ?? new RateLimiter(),
    fetchImpl: opts.fetchImpl ?? fetch,
    dashboardUrl: opts.dashboardUrl ?? "http://127.0.0.1:9800",
  };
}
