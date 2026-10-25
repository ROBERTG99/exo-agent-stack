import { caseId, splitCases, type Rng } from "../prng.ts";

type Op = Record<string, unknown> & { op: string; expect: Record<string, unknown> };

const AGENTS = ["repo-builder", "reviewer-cursor", "researcher", "dual-review"] as const;
const TOPICS = [
  "summarise the open TODOs",
  "add a unit test for the parser",
  "review the latest diff",
  "draft release notes",
  "check the lint configuration",
  "outline the module layout",
];

const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });
const err = (error: string) => ({ error });

/**
 * Builders for the MCP call sequences of FR-8/FR-11. Scenario markers select a fake-model script
 * ([[scenario:<id>]], BUILD.md §4.7) so that every sequence is deterministic.
 */
const TEMPLATES: Record<string, (r: Rng) => Op[]> = {
  basic: (r) => {
    const agent = r.pick(AGENTS);
    return [
      start(r, agent, "plain"),
      { op: "wait", until: "idle", expect: ok() },
      { op: "status", expect: ok({ state: "idle" }) },
      { op: "events", limit: 20, expect: ok({ min_events: 3 }) },
      { op: "send", key: key(r), message: `${r.pick(TOPICS)} please`, expect: ok() },
      { op: "wait", until: "idle", expect: ok() },
      { op: "usage", expect: ok() },
    ];
  },
  replay: (r) => {
    const s = start(r, r.pick(AGENTS), "plain");
    return [
      s,
      { op: "replay", of: 0, expect: ok({ replayed: true }) },
      { op: "wait", until: "idle", expect: ok() },
    ];
  },
  conflict: (r) => [
    start(r, r.pick(AGENTS), "plain"),
    {
      op: "conflict",
      of: 0,
      prompt: `${r.pick(TOPICS)} [[scenario:plain]]`,
      expect: err("idempotency_conflict"),
    },
  ],
  approve: (r) => [
    start(r, "repo-builder", "approval-edit"),
    { op: "wait", until: "awaiting_approval", expect: ok() },
    { op: "approve", decision: "approve", key: key(r), expect: ok() },
    { op: "wait", until: "idle", expect: ok() },
  ],
  "dashboard-only": (r) => [
    start(r, "repo-builder", "approval-git-push"),
    { op: "wait", until: "awaiting_approval", expect: ok() },
    { op: "approve", decision: "approve", key: key(r), expect: err("dashboard_only") },
    { op: "status", expect: ok({ state: "awaiting_approval" }) },
  ],
  answer: (r) => [
    start(r, "repo-builder", "ask-user"),
    { op: "wait", until: "awaiting_input", expect: ok() },
    {
      op: "answer",
      answer: r.pick(["yes", "use the staging copy", "option 2"]),
      key: key(r),
      expect: ok(),
    },
    { op: "wait", until: "idle", expect: ok() },
  ],
  fork: (r) => {
    const forkKey = key(r);
    return [
      start(r, r.pick(AGENTS), "plain"),
      { op: "wait", until: "idle", expect: ok() },
      { op: "fork", key: forkKey, name: `alt-${r.hex(4)}`, expect: ok() },
      { op: "replay", of: 2, expect: ok({ replayed: true }) },
    ];
  },
  "credit-stop": (r) => [
    { op: "set_credit_state", state: "stop", expect: ok() },
    { ...start(r, r.pick(AGENTS), "plain"), expect: err("credit_stop") },
  ],
  "turn-active": (r) => [
    start(r, r.pick(AGENTS), "slow"),
    { op: "send", key: key(r), message: "second instruction", expect: err("turn_active") },
  ],
  "workspace-not-allowed": (r) => [
    {
      ...start(r, "repo-builder", "plain"),
      workspace: r.pick(["/etc", "/var/root", "/Users/someone-else/private"]),
      expect: err("workspace_not_allowed"),
    },
  ],
  "invalid-input": (r) => [
    {
      ...start(r, r.pick(AGENTS), "plain"),
      prompt: undefined,
      prompt_length: 20001,
      expect: err("invalid_input"),
    },
  ],
  "rate-limit": () => [{ op: "burst", calls: 61, window_seconds: 60, expect: err("rate_limited") }],
  "not-found": (r) => [
    { op: "status", thread: `no-such-thread-${r.hex(6)}`, expect: err("not_found") },
  ],
};

const EXTRA = [
  "basic",
  "replay",
  "conflict",
  "approve",
  "fork",
  "turn-active",
  "workspace-not-allowed",
] as const;

function key(r: Rng): string {
  return `k-${r.hex(16)}`;
}

function start(r: Rng, agent: string, scenario: string): Op {
  return {
    op: "start",
    key: key(r),
    agent,
    prompt: `${r.pick(TOPICS)} [[scenario:${scenario}]]`,
    scenario,
    expect: ok(),
  };
}

/** 20 cases (6 dev / 14 test): one of each template plus seven repeats with different data. */
export function delegationSuite(rng: Rng) {
  const names = [...Object.keys(TEMPLATES), ...EXTRA.slice(0, 7)];
  const cases = names.map((template, i) => ({
    id: caseId("del", i + 1),
    suite: "delegation",
    template,
    ops: TEMPLATES[template]!(rng),
  }));
  return splitCases(rng, cases, 6);
}
