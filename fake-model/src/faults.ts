export interface FaultConfig {
  /** Added to every model call. */
  latency_ms?: number;
  /** Every Nth model call answers 429 with retry-after. */
  rate_limit_every?: number;
  /** Every Nth model call answers 500. */
  error_every?: number;
}

/** Parses FAKE_MODEL_FAULTS, e.g. "latency_ms=50,rate_limit_every=3,error_every=5". */
export function parseFaults(value: string | undefined): FaultConfig {
  const out: FaultConfig = {};
  if (!value) return out;
  for (const part of value.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    const n = Number(v);
    if (!k || !Number.isInteger(n) || n < 0)
      throw new Error(`FAKE_MODEL_FAULTS: invalid entry "${part}"`);
    if (k !== "latency_ms" && k !== "rate_limit_every" && k !== "error_every") {
      throw new Error(`FAKE_MODEL_FAULTS: unknown fault "${k}"`);
    }
    out[k] = n;
  }
  return out;
}

export type Fault = { status: 429 | 500; headers: Record<string, string> } | null;

/** Deterministic faults: by call counter, or forced for one call with the x-fake-fault header. */
export class FaultInjector {
  private count = 0;

  constructor(private readonly config: FaultConfig) {}

  get latencyMs(): number {
    return this.config.latency_ms ?? 0;
  }

  reset(): void {
    this.count = 0;
  }

  next(forced?: string): Fault {
    const n = ++this.count;
    if (forced === "500") return { status: 500, headers: {} };
    if (forced === "429") return { status: 429, headers: { "retry-after": "1" } };
    const { error_every, rate_limit_every } = this.config;
    if (error_every && n % error_every === 0) return { status: 500, headers: {} };
    if (rate_limit_every && n % rate_limit_every === 0)
      return { status: 429, headers: { "retry-after": "1" } };
    return null;
  }
}
