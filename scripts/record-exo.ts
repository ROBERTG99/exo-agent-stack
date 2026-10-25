// Records the Exo HTTP surface (BUILD.md §4.2) as fixtures, derives the WireMock mappings from
// them and compares response shapes.
//
//   tsx scripts/record-exo.ts --sim                    # boot exo-sim + fake model, write exo-sim recordings
//   tsx scripts/record-exo.ts --base-url URL [--out D] # host-only: record a real Exo (agents must exist)
//   tsx scripts/record-exo.ts --compare D1 D2          # exit 1 if D2's shapes lost anything D1 has
//
// A recording is one request and its response, with volatile timestamps fixed. A shape is the same
// response reduced to key names and value types: a host re-recording must produce the same shapes
// as the committed exo-sim recordings (keys the real Exo adds are reported, not failed).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Recording {
  name: string;
  source: string;
  request: { method: string; path: string; query?: string; body?: Json };
  response: { status: number; body?: Json; sse_events?: Json[] };
}

export const FIXED_TS = "2026-01-01T00:00:00.000Z";

// --- normalising and shapes ---------------------------------------------------------------------

/** Fixes timestamps so a recording does not change from one run to the next. */
export function normalise(value: Json, scrub: Array<[string, string]> = []): Json {
  if (Array.isArray(value)) return value.map((v) => normalise(v, scrub));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === "ts" && typeof v === "string" ? FIXED_TS : normalise(v, scrub),
      ]),
    );
  }
  if (typeof value === "string")
    return scrub.reduce((acc, [from, to]) => acc.split(from).join(to), value);
  return value;
}

export type Shape = string | Shape[] | { [k: string]: Shape };

/** Key names and value types only. An array has the shape of its elements, merged. */
export function shapeOf(value: Json | undefined): Shape {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const merged: Shape[] = [];
    for (const item of value) {
      const s = shapeOf(item);
      if (!merged.some((m) => JSON.stringify(m) === JSON.stringify(s))) merged.push(s);
    }
    return [mergeObjects(merged)];
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shapeOf(value[k])]),
    );
  }
  return typeof value;
}

/** Array elements of different object shapes become one object whose keys are the union. */
function mergeObjects(shapes: Shape[]): Shape {
  if (shapes.length === 0) return "empty";
  if (!shapes.every((s) => s && typeof s === "object" && !Array.isArray(s))) {
    return shapes.length === 1 ? shapes[0]! : (shapes as Shape);
  }
  const out: Record<string, Shape> = {};
  for (const s of shapes as Array<Record<string, Shape>>) {
    for (const [k, v] of Object.entries(s)) {
      out[k] = k in out && JSON.stringify(out[k]) !== JSON.stringify(v) ? "mixed" : v;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export interface ShapeDiff {
  missing: string[];
  changed: string[];
  extra: string[];
}

/** What `actual` lost (missing, changed type) or gained (extra) compared with `expected`. */
export function diffShapes(expected: Shape, actual: Shape, at = "$"): ShapeDiff {
  const diff: ShapeDiff = { missing: [], changed: [], extra: [] };
  const walk = (e: Shape, a: Shape, p: string) => {
    if (e === "empty" || a === "empty") return; // no element to compare
    if (e === "mixed" || a === "mixed") return;
    const eObj = typeof e === "object" && !Array.isArray(e);
    const aObj = typeof a === "object" && !Array.isArray(a);
    if (Array.isArray(e) && Array.isArray(a))
      return walk(e[0] ?? "empty", a[0] ?? "empty", `${p}[]`);
    if (eObj && aObj) {
      const eo = e as Record<string, Shape>;
      const ao = a as Record<string, Shape>;
      for (const k of Object.keys(eo)) {
        if (!(k in ao)) diff.missing.push(`${p}.${k}`);
        else walk(eo[k]!, ao[k]!, `${p}.${k}`);
      }
      for (const k of Object.keys(ao)) if (!(k in eo)) diff.extra.push(`${p}.${k}`);
      return;
    }
    if (JSON.stringify(e) !== JSON.stringify(a))
      diff.changed.push(`${p}: ${JSON.stringify(e)} -> ${JSON.stringify(a)}`);
  };
  walk(expected, actual, at);
  return diff;
}

// --- the scenario -------------------------------------------------------------------------------

export interface RecordOptions {
  baseUrl: string;
  source: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Substitutions for machine-specific strings (such as the repository path). */
  scrub?: Array<[string, string]>;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the fixed scenario, strictly one thread at a time so event ids come out in the same order
 * on every run. Needs the agent catalogue to exist already (`exos agents sync`).
 */
export async function recordScenario(o: RecordOptions): Promise<Recording[]> {
  const doFetch = o.fetch ?? fetch;
  const recordings: Recording[] = [];
  const headers = { ...o.headers };
  const deadline = o.timeoutMs ?? 20_000;

  const raw = async (method: string, path: string, query = "", body?: Json) => {
    const res = await doFetch(`${o.baseUrl}${path}${query ? `?${query}` : ""}`, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Json) : undefined };
  };
  const call = async (name: string, method: string, path: string, query = "", body?: Json) => {
    const r = await raw(method, path, query, body);
    recordings.push({
      name,
      source: o.source,
      request: {
        method,
        path,
        ...(query ? { query } : {}),
        ...(body === undefined ? {} : { body }),
      },
      response: {
        status: r.status,
        ...(r.body === undefined ? {} : { body: normalise(r.body, o.scrub) }),
      },
    });
    return r;
  };
  const events = async (agent: string, thread: string, query = "limit=1000") =>
    (
      (await raw("GET", `/agent/${agent}/thread/${thread}/event`, query)).body as {
        events: Array<Record<string, Json>>;
      }
    ).events;
  const waitFor = async (agent: string, thread: string, type: string, turn?: string) => {
    const end = Date.now() + deadline;
    for (;;) {
      const found = (
        await events(agent, thread, `event_type=${type}${turn ? `&turn_id=${turn}` : ""}`)
      )[0];
      if (found) return found;
      if (Date.now() > end) throw new Error(`timed out waiting for ${type}`);
      await sleep(25);
    }
  };
  const newThread = async (agent: string, slug: string, label: string) => {
    const r = await call(`${label}-thread-create`, "POST", `/agent/${agent}/thread`, "", {
      vaults: [],
      thread_slug: slug,
    });
    return (r.body as { thread: { id: string } }).thread.id;
  };
  const submit = async (
    agent: string,
    thread: string,
    label: string,
    input: string,
    extra: Record<string, Json> = {},
  ) => {
    const r = await call(label, "POST", `/agent/${agent}/thread/${thread}/turn`, "", {
      input,
      ...extra,
    });
    const turn = (r.body as { turn: { id: string; session_id: string } | string }).turn;
    return typeof turn === "string"
      ? { id: turn, session: "" }
      : { id: turn.id, session: turn.session_id };
  };

  // agents
  const list = await call("agent-list", "GET", "/agent");
  const agents = (list.body as { agents: Array<{ id: string; slug: string }> }).agents;
  const first = agents.find((a) => a.slug === "repo-builder") ?? agents[0];
  if (!first) throw new Error("the Exo has no agents: run `exos agents sync` first");
  await call("agent-list-by-slug", "GET", "/agent", `slug=${first.slug}`);
  await call("agent-doctor", "GET", `/agent/${first.id}/doctor`);
  await call("agent-unknown-threads", "GET", "/agent/agent-that-does-not-exist/thread");
  const agent = first.id;

  // thread A: an approval, then a report written twice
  const a = await newThread(agent, "recording-a", "thread-a");
  await call("thread-a-create-again", "POST", `/agent/${agent}/thread`, "", {
    vaults: [],
    thread_slug: "recording-a",
  });
  await call("thread-list", "GET", `/agent/${agent}/thread`, "limit=10");
  const t1 = await submit(agent, a, "turn-submit", "[[scenario:approval-edit]] edit notes.md");
  const approval = await waitFor(agent, a, "agent_runtime.approval_requested", t1.id);
  await call("turn-get-active", "GET", `/agent/${agent}/thread/${a}/turn/${t1.id}`);
  await call("event-list-waiting", "GET", `/agent/${agent}/thread/${a}/event`, "limit=1000");
  await call(
    "approval-respond",
    "POST",
    `/agent/${agent}/thread/${a}/turn/${t1.id}/approval-response`,
    "",
    {
      session_id: t1.session,
      approval_id: approval.approval_id as Json,
      approved: true,
      allow_for_tool: false,
    },
  );
  await waitFor(agent, a, "turn_ended", t1.id);
  await call("turn-get-finished", "GET", `/agent/${agent}/thread/${a}/turn/${t1.id}`);
  await call("event-list", "GET", `/agent/${agent}/thread/${a}/event`, "limit=1000");
  await call(
    "event-list-last",
    "GET",
    `/agent/${agent}/thread/${a}/event`,
    "direction=desc&event_type=turn_ended&limit=1",
  );
  await call(
    "approval-respond-again",
    "POST",
    `/agent/${agent}/thread/${a}/turn/${t1.id}/approval-response`,
    "",
    {
      session_id: t1.session,
      approval_id: approval.approval_id as Json,
      approved: false,
      allow_for_tool: false,
    },
  );
  recordings.push(await recordWatch(o, doFetch, agent, a, headers, deadline));

  // the scenario is chosen by the first message of a conversation, so the report gets its own thread
  const r = await newThread(agent, "recording-report", "thread-report");
  const t2 = await submit(
    agent,
    r,
    "turn-submit-report",
    "[[scenario:report-twice]] write the summary",
  );
  await waitFor(agent, r, "turn_ended", t2.id);
  await call("artifact-list", "GET", `/agent/${agent}/thread/${r}/artifact`);
  await call("artifact-read", "GET", `/agent/${agent}/thread/${r}/artifact/read`, "name=summary");
  await call(
    "artifact-read-version",
    "GET",
    `/agent/${agent}/thread/${r}/artifact/read`,
    "name=summary&version=1",
  );
  await call(
    "artifact-read-missing",
    "GET",
    `/agent/${agent}/thread/${r}/artifact/read`,
    "name=ghost",
  );
  await call("previews", "GET", `/agent/${agent}/thread/${r}/previews`);
  const fork = await call("thread-fork", "POST", `/agent/${agent}/thread/${a}/fork`, "", {
    thread_name: "recording-fork",
  });
  const forkId = (fork.body as { thread: { id: string } }).thread.id;
  await call("event-list-fork", "GET", `/agent/${agent}/thread/${forkId}/event`, "limit=5");

  // thread B: a turn that is still running when a second one arrives, then cancelled
  const b = await newThread(agent, "recording-b", "thread-b");
  const t3 = await submit(agent, b, "turn-submit-busy", "[[scenario:approval-edit]] edit and wait");
  await waitFor(agent, b, "agent_runtime.approval_requested", t3.id);
  await call("turn-submit-while-active", "POST", `/agent/${agent}/thread/${b}/turn`, "", {
    input: "a second instruction",
  });
  await call("turn-cancel", "POST", `/agent/${agent}/thread/${b}/turn/${t3.id}/cancel`);
  await call("turn-cancel-again", "POST", `/agent/${agent}/thread/${b}/turn/${t3.id}/cancel`);

  // thread C: a question for the human through a frontend tool
  const c = await newThread(agent, "recording-c", "thread-c");
  const t4 = await submit(agent, c, "turn-submit-frontend", "[[scenario:ask-user]] ask me", {
    frontend_tools: [{ name: "ask_user" }],
  });
  const ask = await waitFor(agent, c, "frontend_tool_requested", t4.id);
  const result = {
    session_id: t4.session,
    tool_call_id: ask.tool_call_id as Json,
    result: { type: "frontend_tool_success", output: "staging" },
  };
  await call(
    "frontend-tool-result",
    "POST",
    `/agent/${agent}/thread/${c}/turn/${t4.id}/frontend-tool-result`,
    "",
    result,
  );
  await waitFor(agent, c, "turn_ended", t4.id);
  await call(
    "frontend-tool-result-again",
    "POST",
    `/agent/${agent}/thread/${c}/turn/${t4.id}/frontend-tool-result`,
    "",
    result,
  );
  return recordings;
}

/** Reads an SSE stream until the turn ends and keeps the events (a stream has no body to compare). */
async function recordWatch(
  o: RecordOptions,
  doFetch: typeof fetch,
  agent: string,
  thread: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Recording> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const res = await doFetch(`${o.baseUrl}/agent/${agent}/thread/${thread}/event/watch?after=0`, {
    headers,
    signal: abort.signal,
  });
  const decoder = new TextDecoder();
  const seen: Json[] = [];
  let buffer = "";
  try {
    outer: for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!data) continue;
        const event = normalise(JSON.parse(data.slice(5).trim()) as Json, o.scrub) as {
          type?: string;
        };
        seen.push(event as Json);
        if (event.type === "turn_ended") break outer;
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return {
    name: "event-watch",
    source: o.source,
    request: {
      method: "GET",
      path: `/agent/${agent}/thread/${thread}/event/watch`,
      query: "after=0",
    },
    response: { status: res.status, sse_events: seen },
  };
}

// --- files --------------------------------------------------------------------------------------

const stable = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const pad = (n: number) => String(n + 1).padStart(2, "0");

export function writeRecordings(dir: string, recordings: Recording[]): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shapes: Record<string, Shape> = {};
  recordings.forEach((r, i) => {
    writeFileSync(join(dir, `${pad(i)}-${r.name}.json`), stable(r));
    shapes[r.name] = shapeOf((r.response.sse_events as Json | undefined) ?? r.response.body);
  });
  writeFileSync(join(dir, "shapes.json"), stable(shapes));
}

export function readRecordings(dir: string): Recording[] {
  return readdirSync(dir)
    .filter((f) => /^\d+-.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Recording);
}

export function readShapes(dir: string): Record<string, Shape> {
  return JSON.parse(readFileSync(join(dir, "shapes.json"), "utf8")) as Record<string, Shape>;
}

/** Shapes of `actual` against `expected`, per recording name; only names in both are compared. */
export function compareDirs(
  expectedDir: string,
  actualDir: string,
): { failures: string[]; notes: string[] } {
  const expected = readShapes(expectedDir);
  const actual = readShapes(actualDir);
  const failures: string[] = [];
  const notes: string[] = [];
  for (const [name, shape] of Object.entries(expected)) {
    if (!(name in actual)) {
      failures.push(`${name}: not recorded`);
      continue;
    }
    const d = diffShapes(shape, actual[name]!);
    failures.push(
      ...d.missing.map((m) => `${name}: missing ${m}`),
      ...d.changed.map((c) => `${name}: changed ${c}`),
    );
    notes.push(...d.extra.map((x) => `${name}: extra ${x}`));
  }
  return { failures, notes };
}

// --- WireMock -----------------------------------------------------------------------------------

/** Recordings whose answer does not depend on state, so a static mapping reproduces them. */
const STATIC = new Set([
  "agent-list",
  "agent-list-by-slug",
  "agent-doctor",
  "thread-list",
  "artifact-list",
  "previews",
]);

export function toWiremockMapping(r: Recording): Record<string, unknown> {
  const query = Object.fromEntries(
    (r.request.query ?? "")
      .split("&")
      .filter(Boolean)
      .map((kv) => {
        const [k, v = ""] = kv.split("=");
        return [k!, { equalTo: decodeURIComponent(v) }];
      }),
  );
  return {
    name: `exo-${r.name} (generated from fixtures/exo-recordings/${r.source}; do not edit)`,
    request: {
      method: r.request.method,
      urlPath: `/exo${r.request.path}`,
      ...(Object.keys(query).length ? { queryParameters: query } : {}),
    },
    response: {
      status: r.response.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r.response.body ?? null),
    },
  };
}

export function writeWiremockMappings(dir: string, recordings: Recording[]): string[] {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^exo-.*\.json$/.test(f)) rmSync(join(dir, f));
  const written: string[] = [];
  for (const r of recordings.filter((x) => STATIC.has(x.name) && x.response.status === 200)) {
    const file = `exo-${r.name}.json`;
    writeFileSync(join(dir, file), stable(toWiremockMapping(r)));
    written.push(file);
  }
  return written;
}

// --- command line -------------------------------------------------------------------------------

/** Boots exo-sim and the fake model on free loopback ports and records against them. */
export async function recordFromSim(root: string): Promise<Recording[]> {
  const [{ buildFakeModel }, { createExoSim }, { ExoClient }, { syncAgents }] = await Promise.all([
    import("../fake-model/src/server.ts"),
    import("../exo-sim/src/index.ts"),
    import("../packages/exo-client/src/index.ts"),
    import("../cli/src/commands/agents-sync.ts"),
  ]);
  const work = mkdtempSync(join(tmpdir(), "record-exo-"));
  const model = await buildFakeModel();
  await model.listen({ host: "127.0.0.1", port: 0 });
  const sim = await createExoSim({
    dataDir: work,
    modelUrl: `http://127.0.0.1:${(model.server.address() as { port: number }).port}`,
    pollMs: 10,
  });
  await sim.app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${(sim.app.server.address() as { port: number }).port}/exo`;
  try {
    await syncAgents({
      client: new ExoClient({ baseUrl, retries: 0 }),
      agentsDir: join(root, "agents"),
      statePath: join(work, "agents-state.json"),
    });
    return await recordScenario({ baseUrl, source: "exo-sim", scrub: [[root, "<repo>"]] });
  } finally {
    await sim.close();
    await model.close();
    rmSync(work, { recursive: true, force: true });
  }
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(args: string[], root: string): Promise<number> {
  const compare = args.indexOf("--compare");
  if (compare >= 0) {
    const [expected, actual] = [args[compare + 1], args[compare + 2]];
    if (!expected || !actual) throw new Error("usage: --compare <expected-dir> <actual-dir>");
    const { failures, notes } = compareDirs(expected, actual);
    for (const n of notes) console.log(`note: ${n}`);
    for (const f of failures) console.error(`FAIL: ${f}`);
    console.log(failures.length === 0 ? "shapes match" : `${failures.length} shape difference(s)`);
    return failures.length === 0 ? 0 : 1;
  }
  const sim = args.includes("--sim");
  const baseUrl = arg(args, "--base-url");
  if (!sim && !baseUrl)
    throw new Error("usage: record-exo.ts --sim | --base-url <url> [--out <dir>]");
  const source = sim ? "exo-sim" : "exo-host";
  const out = arg(args, "--out") ?? join(root, "fixtures/exo-recordings", source);
  const recordings = sim
    ? await recordFromSim(root)
    : await recordScenario({ baseUrl: baseUrl!, source });
  writeRecordings(out, recordings);
  console.log(`wrote ${recordings.length} recordings to ${out}`);
  if (sim) {
    const files = writeWiremockMappings(join(root, "deploy/wiremock/mappings"), recordings);
    console.log(`wrote ${files.length} WireMock mappings`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), join(import.meta.dirname, "..")).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
