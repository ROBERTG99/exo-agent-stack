// Minimal Exo access for the walking skeleton. packages/exo-client (T-07) replaces this.
export class ExoUnavailableError extends Error {
  readonly code = "exo_unavailable";
}

export interface ExoAgent {
  id: string;
  slug?: string;
  name?: string;
  [key: string]: unknown;
}

const TIMEOUT_MS = 5_000;

export async function listExoAgents(
  exoUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExoAgent[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${exoUrl}/agent`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ExoUnavailableError(`cannot reach Exo at ${exoUrl}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ExoUnavailableError(`Exo answered ${res.status} for GET /agent`);
  const body = (await res.json()) as { agents?: unknown };
  if (!Array.isArray(body.agents))
    throw new ExoUnavailableError("Exo GET /agent returned no agents array");
  return body.agents.filter(
    (a): a is ExoAgent =>
      typeof a === "object" && a !== null && typeof (a as ExoAgent).id === "string",
  );
}

export async function exoReachable(
  exoUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await listExoAgents(exoUrl, fetchImpl);
    return true;
  } catch {
    return false;
  }
}
