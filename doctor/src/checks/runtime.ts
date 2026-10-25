// D-13, D-14, D-16 to D-18 and D-20: the running parts and the files around them.
import { fail, list, pass, warn, type Check } from "./types.ts";

const DAY_MS = 86_400_000;

/** `0600`, `600` or `0o600` as a number, or null. */
function parseMode(text: string): number | null {
  const t = text.trim().replace(/^0o/i, "");
  return /^[0-7]{3,4}$/.test(t) ? parseInt(t, 8) : null;
}

const SUPPORTED_PROVIDERS = new Set(["smolvm", "firecracker"]);

export const runtimeChecks: Check[] = [
  {
    id: "D-13",
    title: "claude is present",
    run: ({ claude }) =>
      claude.present
        ? pass(`claude ${claude.version ?? "(version unknown)"} is installed`)
        : warn(
            "the claude binary was not found, so Mode A and the live targets cannot run here",
            "Install Claude Code and sign in yourself (the stack never signs in), or set EXOS_CLAUDE_BIN.",
          ),
  },
  {
    id: "D-14",
    title: "Mode B has a secret origin and SmolVM or Firecracker, or is reported unsupported",
    run: ({ mode_b }) => {
      if (mode_b.provider && !SUPPORTED_PROVIDERS.has(mode_b.provider)) {
        return fail(
          `Mode B is set up on ${mode_b.provider}, which cannot substitute the token`,
          "Mode B needs a SmolVM or Firecracker sandbox; use Mode A otherwise.",
        );
      }
      if (mode_b.secret_origin) {
        let host = mode_b.secret_origin;
        try {
          host = new URL(mode_b.secret_origin).hostname;
        } catch {
          /* keep the raw text */
        }
        if (host !== "api.anthropic.com") {
          return fail(
            `the Mode B secret is scoped to ${host}`,
            "Scope the `claude-oauth` secret to api.anthropic.com only.",
          );
        }
      }
      if (!mode_b.provider || !mode_b.substitution_verified) {
        return warn(
          `Mode B is unsupported here: ${!mode_b.provider ? "no SmolVM or Firecracker provider" : "token substitution is not verified (V-9)"}`,
          "Mode A stays the default. Verify substitution on a host with SmolVM or Firecracker to enable Mode B.",
        );
      }
      return pass(`Mode B runs on ${mode_b.provider} with a verified substitution`);
    },
  },
  {
    id: "D-16",
    title: "The meter keeps up, and turns started outside the stack are counted",
    run: ({ meter }) => {
      const outside =
        meter.external_turns === undefined
          ? "turns started outside the stack were not counted"
          : `${meter.external_turns} turns started outside the stack`;
      if (meter.lag_seconds > 300) {
        return fail(
          `the meter is ${Math.round(meter.lag_seconds)} s behind, so credit decisions use stale spend`,
          "Check that stackd can reach Exo and that EXOS_METER_INTERVAL_SECONDS is small (default 15).",
        );
      }
      if (meter.lag_seconds > 60 || (meter.external_turns ?? 0) > 0) {
        return warn(
          `meter lag ${Math.round(meter.lag_seconds)} s; ${outside}`,
          "Turns started outside the stack are metered but cannot be refused; start work through the bridge or the dashboard.",
        );
      }
      return pass(`meter lag ${Math.round(meter.lag_seconds)} s; ${outside}`);
    },
  },
  {
    id: "D-17",
    title: "Token and state permissions",
    run: ({ permissions }) => {
      const problems: string[] = [];
      const entries: Array<[string, string | undefined]> = [
        ["the API token file", permissions.token_mode],
        ["the dashboard token file", permissions.dashboard_token_mode],
        ["the state directory", permissions.state_dir_mode],
      ];
      for (const [what, mode] of entries) {
        if (mode === undefined) continue;
        const n = parseMode(mode);
        if (n === null) problems.push(`${what} has an unreadable mode "${mode}"`);
        else if (n & 0o077) problems.push(`${what} is readable by others (mode ${mode})`);
      }
      return problems.length === 0
        ? pass("tokens are 0600 and the state directory is 0700, or stricter")
        : fail(problems.join("; "), "chmod 600 the token files and chmod 700 the state directory.");
    },
  },
  {
    id: "D-18",
    title: "The price table is under 120 days old",
    run: ({ price_table }) => {
      const age = Math.floor(
        (Date.parse(price_table.now) - Date.parse(price_table.retrieved_at)) / DAY_MS,
      );
      if (Number.isNaN(age))
        return fail(
          "the price table date is unreadable",
          "Fix retrieved_at in pricing/api-rates.v1.json.",
        );
      return age < 120
        ? pass(`the price table is ${age} days old`)
        : warn(
            `the price table is ${age} days old`,
            "Re-read the pricing page and update pricing/api-rates.v1.json (rates, source_url and retrieved_at).",
          );
    },
  },
  {
    id: "D-20",
    title: "No workflow runs live targets",
    run: ({ workflows }) => {
      const live = workflows.filter((w) => w.runs_live_target);
      const secret = workflows.filter((w) => w.holds_model_secret);
      if (live.length > 0) {
        return fail(
          `workflows that run a live target: ${list(live.map((w) => w.file))}`,
          "Live targets are maintainer-only (BUILD.md §0.1, rail 4); remove the step.",
        );
      }
      const unexpected = secret.filter((w) => w.file !== "claude-review.yml");
      if (unexpected.length > 0) {
        return fail(
          `workflows that hold a model secret: ${list(unexpected.map((w) => w.file))}`,
          "Only the optional claude-review.yml may use a repository secret.",
        );
      }
      return secret.length > 0
        ? warn(
            "the optional claude-review.yml holds a model secret",
            "It runs only if the repository secret exists, a GitHub setting outside the stack (docs/runbook.md).",
          )
        : pass(`${workflows.length} workflows, none runs a live target or holds a model secret`);
    },
  },
];
