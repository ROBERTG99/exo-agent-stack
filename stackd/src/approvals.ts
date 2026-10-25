// One queue for tool approvals and client-tool questions (BUILD.md §4.4, FR-11). Exo owns the
// requests; this module reads them from the event log once (a cursor per thread), keeps a row per
// request so it can be listed and decided, and marks rows closed when Exo's log shows the answer or
// the end of the turn. Arguments are redacted before they are stored.
import type { ExoClient, ExoEvent } from "@exos/exo-client";
import { canonicalJson } from "@exos/common";
import type { AgentDirectory } from "./agents.ts";
import type { Db } from "./db/index.ts";
import { isProvablySafeBash } from "./shell-safety.ts";
import { listThreads } from "./threads.ts";

export type Decision =
  "pending" | "approved" | "denied" | "approved_for_session" | "dashboard_only";

export interface ApprovalRow {
  approval_id: string;
  kind: "approval" | "frontend";
  agent_id: string;
  thread_id: string;
  thread_slug: string;
  turn_id: string;
  session_id: string;
  call_id: string;
  tool: string;
  args_redacted: string;
  decision: Decision;
  decided_by: string | null;
  requested_at: string;
  decided_at: string | null;
  untrusted_text: string | null;
}

export const isOpen = (d: Decision): boolean => d === "pending" || d === "dashboard_only";

// --- redaction ------------------------------------------------------------------------------

const SECRET_KEY =
  /token|secret|passw|credential|authorization|cookie|api[-_]?key|private[-_]?key/i;
const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const MAX_STRING = 500;
const MAX_JSON = 4000;
const MAX_DEPTH = 6;

/** Arguments with secrets masked and long values cut, as canonical JSON of at most ~4 KB. */
export function redactArgs(value: unknown): string {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return "[too deep]";
    if (typeof v === "string") {
      const masked = v.replace(SECRET_VALUE, "[redacted]");
      return masked.length > MAX_STRING
        ? `${masked.slice(0, MAX_STRING)}…(${masked.length} chars)`
        : masked;
    }
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .slice(0, 50)
          .map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : walk(x, depth + 1)]),
      );
    }
    return v;
  };
  const text = canonicalJson(walk(value ?? {}, 0));
  return text.length > MAX_JSON
    ? canonicalJson({ truncated: true, preview: text.slice(0, MAX_JSON) })
    : text;
}

// --- dashboard-only tools -------------------------------------------------------------------

export const DEFAULT_DASHBOARD_ONLY = [
  "claude.Bash(git push)",
  "claude.Bash(npm publish)",
  "claude.Bash(curl)",
  "claude.Bash(wget)",
  "claude.Bash(ssh)",
  "claude.WebFetch",
  "claude.WebSearch",
];

interface Matcher {
  tool: RegExp;
  args?: RegExp;
}

const glob = (g: string): string => g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

/**
 * A phrase is searched anywhere, so a false positive only sends a call to the dashboard. The one
 * exception is a segment of a dotted key: `ssh` is not the `ssh` in `-c gpg.ssh.program=false`
 * (a phrase with a dot on both sides), which the pins that make a git command approvable contain.
 */
const phrase = (p: string): RegExp => new RegExp(`(?:(?<!\\.)${glob(p)}|${glob(p)}(?!\\.))`);

/**
 * `tool` or `tool(phrase)`. The tool name is a whole-name glob; the phrase is searched anywhere in
 * the call's command, URL or path, so `claude.Bash(git push)` also catches `cd x && git push -f`
 * (and, deliberately, `echo "git push"`: a false positive only sends it to the dashboard).
 */
export function parseDashboardOnly(patterns: string[]): Matcher[] {
  return patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^([^()]+?)(?:\((.+)\))?$/.exec(p);
      if (!m) throw new Error(`EXOS_APPROVE_DASHBOARD_ONLY: cannot read "${p}"`);
      return {
        tool: new RegExp(`^${glob(m[1]!.trim())}$`),
        ...(m[2] ? { args: phrase(m[2].trim()) } : {}),
      };
    });
}

function subjectOf(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  return ["command", "cmd", "url", "file_path", "path", "query"]
    .map((k) => (typeof a[k] === "string" ? (a[k] as string) : ""))
    .join("\n");
}

/**
 * Whether only a person in the dashboard may approve this call: the tool matches an explicit
 * pattern, or it is a shell command that is not provably simple and local (shell-safety.ts), which
 * includes a missing or unreadable command. A shell call can therefore only be settled by the bridge
 * when it is plainly harmless.
 */
export function isDashboardOnly(matchers: Matcher[], tool: string, args: unknown): boolean {
  const subject = subjectOf(args);
  if (matchers.some((m) => m.tool.test(tool) && (!m.args || m.args.test(subject)))) return true;
  if (/(^|\.)bash$/i.test(tool)) {
    const command = (args as { command?: unknown } | null | undefined)?.command;
    return typeof command !== "string" || !isProvablySafeBash(command);
  }
  return false;
}

export function loadDashboardOnly(env: NodeJS.ProcessEnv): string[] {
  const raw = env.EXOS_APPROVE_DASHBOARD_ONLY;
  return raw === undefined || raw.trim() === ""
    ? DEFAULT_DASHBOARD_ONLY
    : raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

// --- the queue ------------------------------------------------------------------------------

export interface QueueOptions {
  db: Db;
  exo: ExoClient;
  agents: AgentDirectory;
  dashboardOnly: string[];
  clock?: () => Date;
}

const PAGE = 200;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class ApprovalQueue {
  private readonly matchers: Matcher[];
  private readonly clock: () => Date;
  private running: Promise<{ added: number; closed: number }> | undefined;

  constructor(private readonly o: QueueOptions) {
    this.matchers = parseDashboardOnly(o.dashboardOnly);
    this.clock = o.clock ?? (() => new Date());
  }

  get patterns(): string[] {
    return this.o.dashboardOnly;
  }

  list(
    filter: { state: "open" | "decided" | "all"; thread?: string } = { state: "open" },
  ): ApprovalRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.state === "open") where.push("decision IN ('pending', 'dashboard_only')");
    if (filter.state === "decided") where.push("decision NOT IN ('pending', 'dashboard_only')");
    if (filter.thread) {
      where.push("(thread_id = ? OR thread_slug = ?)");
      args.push(filter.thread, filter.thread);
    }
    return this.o.db
      .prepare(
        `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY requested_at, approval_id`,
      )
      .all(...args) as ApprovalRow[];
  }

  get(id: string): ApprovalRow | undefined {
    return this.o.db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(id) as
      ApprovalRow | undefined;
  }

  /** The open frontend questions for a tool call id (ids are only unique within a thread). */
  frontendByCall(callId: string, thread?: string, agent?: string): ApprovalRow[] {
    return (
      this.o.db
        .prepare(
          "SELECT * FROM approvals WHERE kind = 'frontend' AND call_id = ? AND decision IN ('pending', 'dashboard_only')",
        )
        .all(callId) as ApprovalRow[]
    ).filter(
      (r) =>
        (!thread || r.thread_id === thread || r.thread_slug === thread) &&
        (!agent || r.agent_id === agent),
    );
  }

  /** The most recently answered question for a tool call id (to find its thread after a retry). */
  frontendAnswered(callId: string, thread?: string, agent?: string): ApprovalRow | undefined {
    return (
      this.o.db
        .prepare(
          "SELECT * FROM approvals WHERE kind = 'frontend' AND call_id = ? AND decision = 'approved' ORDER BY decided_at DESC",
        )
        .all(callId) as ApprovalRow[]
    ).find(
      (r) =>
        (!thread || r.thread_id === thread || r.thread_slug === thread) &&
        (!agent || r.agent_id === agent),
    );
  }

  /** Marks an open row decided; false if someone else decided it first. */
  claim(
    id: string,
    decision: Exclude<Decision, "pending" | "dashboard_only">,
    by: string,
  ): boolean {
    return (
      this.o.db
        .prepare(
          "UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ? WHERE approval_id = ? AND decision IN ('pending', 'dashboard_only')",
        )
        .run(decision, by, this.clock().toISOString(), id).changes === 1
    );
  }

  /** Puts a claimed row back (Exo could not take the answer), so the decision can be retried. */
  release(id: string, previous: Decision): void {
    this.o.db
      .prepare(
        "UPDATE approvals SET decision = ?, decided_by = NULL, decided_at = NULL WHERE approval_id = ?",
      )
      .run(previous, id);
  }

  /** One pass over every thread; overlapping calls share it. */
  sync(): Promise<{ added: number; closed: number }> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<{ added: number; closed: number }> {
    const { db, exo } = this.o;
    const out = { added: 0, closed: 0 };
    for (const agent of await this.o.agents.list()) {
      for (const thread of await listThreads(exo, agent.id)) {
        let cursor = (
          db
            .prepare("SELECT last_event_id FROM approval_cursors WHERE thread_id = ?")
            .get(thread.id) as { last_event_id: string } | undefined
        )?.last_event_id;
        for (;;) {
          const page = await exo.listEvents(agent.id, thread.id, { after: cursor, limit: PAGE });
          if (page.length === 0) break;
          db.transaction(() => {
            for (const event of page) this.apply(event, agent.id, thread.id, thread.slug, out);
            cursor = page[page.length - 1]!.id;
            db.prepare(
              `INSERT INTO approval_cursors (thread_id, last_event_id) VALUES (?, ?)
               ON CONFLICT (thread_id) DO UPDATE SET last_event_id = excluded.last_event_id`,
            ).run(thread.id, cursor);
          })();
          if (page.length < PAGE) break;
        }
      }
    }
    return out;
  }

  private apply(
    event: ExoEvent,
    agentId: string,
    threadId: string,
    threadSlug: string,
    out: { added: number; closed: number },
  ): void {
    const { db } = this.o;
    const e = event as Record<string, unknown>;
    const at = str(e.ts) || this.clock().toISOString();
    const close = (id: string, decision: Decision, by: string) => {
      const changed = db
        .prepare(
          "UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ? WHERE approval_id = ? AND decision IN ('pending', 'dashboard_only')",
        )
        .run(decision, by, at, id).changes;
      out.closed += changed;
    };

    switch (event.type) {
      case "agent_runtime.approval_requested": {
        const id = str(e.approval_id);
        if (!id) return;
        const tool = str(e.tool) || str(e.name) || "unknown";
        const decision: Decision = isDashboardOnly(this.matchers, tool, e.arguments)
          ? "dashboard_only"
          : "pending";
        out.added += db
          .prepare(
            `INSERT OR IGNORE INTO approvals
             (approval_id, kind, agent_id, thread_id, thread_slug, turn_id, session_id, call_id, tool, args_redacted, decision, requested_at)
             VALUES (?, 'approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            agentId,
            threadId,
            threadSlug,
            str(e.turn_id),
            str(e.session_id),
            str(e.call_id),
            tool,
            redactArgs(e.arguments),
            decision,
            at,
          ).changes;
        break;
      }
      case "frontend_tool_requested": {
        const call = str(e.call_id) || str(e.tool_call_id);
        if (!call) return;
        const args = (e.arguments ?? {}) as Record<string, unknown>;
        const question = typeof args.question === "string" ? args.question.slice(0, 2000) : null;
        out.added += db
          .prepare(
            `INSERT OR IGNORE INTO approvals
             (approval_id, kind, agent_id, thread_id, thread_slug, turn_id, session_id, call_id, tool, args_redacted, decision, requested_at, untrusted_text)
             VALUES (?, 'frontend', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            `ft:${threadId}:${call}`,
            agentId,
            threadId,
            threadSlug,
            str(e.turn_id),
            str(e.session_id),
            call,
            str(e.name) || "frontend_tool",
            redactArgs(args),
            at,
            question,
          ).changes;
        break;
      }
      case "agent_runtime.approval_response": {
        const id = str(e.approval_id);
        if (id) {
          const decision: Decision =
            e.approved === true
              ? e.allow_for_tool === true
                ? "approved_for_session"
                : "approved"
              : "denied";
          close(id, decision, "exo");
        }
        break;
      }
      case "frontend_tool_result": {
        const call = str(e.call_id) || str(e.tool_call_id);
        if (call) close(`ft:${threadId}:${call}`, "approved", "exo");
        break;
      }
      case "turn_ended": {
        // A request on a finished turn can no longer be answered.
        const turn = str(e.turn_id);
        if (turn) {
          out.closed += db
            .prepare(
              "UPDATE approvals SET decision = 'denied', decided_by = 'turn_ended', decided_at = ? WHERE thread_id = ? AND turn_id = ? AND decision IN ('pending', 'dashboard_only')",
            )
            .run(at, threadId, turn).changes;
        }
        break;
      }
      default:
    }
  }
}
