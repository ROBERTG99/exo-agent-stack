import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, undefined members dropped.
 * Used for idempotency body hashes and the audit hash chain, so equal content always hashes equal.
 * Throws for values JSON cannot represent (NaN, Infinity, bigint, functions, cycles).
 */
export function canonicalJson(value: unknown): string {
  return stringify(value, new Set());
}

function stringify(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError(`canonicalJson: number must be finite, got ${value}`);
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson: bigint is not representable");
    case "function":
    case "symbol":
      throw new TypeError(`canonicalJson: ${typeof value} is not representable`);
    case "undefined":
      return "null";
    default:
      break;
  }
  const obj = value as object;
  if (seen.has(obj)) throw new TypeError("canonicalJson: circular structure");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((v) => stringify(v, seen)).join(",")}]`;
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stringify(v, seen)}`).join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
