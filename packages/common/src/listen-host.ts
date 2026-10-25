// Loopback-only rail (BUILD.md §0.1 rail 3): every listener binds 127.0.0.1.
// The single exception is a service inside a container, which must listen on the container's
// own interfaces for Docker's port mapping to reach it. That is only allowed when
// EXOS_LISTEN_HOST=container AND EXOS_IN_CONTAINER=1, and compose.yaml publishes those ports as
// 127.0.0.1:<port> only (checked by tests/integration/skeleton.test.ts and loopback.test.ts).

export class ListenHostError extends Error {
  readonly code = "non_loopback_bind";
}

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
// All interfaces *inside the container's network namespace*; never reachable from the LAN unless
// the port is published without the 127.0.0.1 prefix, which the compose tests forbid.
const ALL_INTERFACES_IN_CONTAINER = "0.0.0.0";

export function resolveListenHost(env: Env = process.env): string {
  const raw = (env.EXOS_LISTEN_HOST ?? "").trim();
  if (raw === "") return "127.0.0.1";
  if (raw === "localhost") return "127.0.0.1";
  if (LOOPBACK.has(raw)) return raw;
  if (raw === "container") {
    if (env.EXOS_IN_CONTAINER !== "1") {
      throw new ListenHostError(
        "EXOS_LISTEN_HOST=container is only allowed inside a container (EXOS_IN_CONTAINER=1)",
      );
    }
    return ALL_INTERFACES_IN_CONTAINER;
  }
  throw new ListenHostError(
    `refusing non-loopback bind "${raw}": use 127.0.0.1, localhost or ::1 (loopback only)`,
  );
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`invalid port "${value}"`);
  const n = Number(value);
  if (n < 1 || n > 65535) throw new Error(`invalid port "${value}": must be 1-65535`);
  return n;
}
