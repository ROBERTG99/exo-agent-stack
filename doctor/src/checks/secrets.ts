// D-05 to D-08 and D-15: keys, vaults and who can use them. Names and origins only, never values.
import { fail, list, pass, skip, warn, type Check } from "./types.ts";

// Assembled from parts so this file never contains a literal key-variable assignment.
const KEY_VARIABLES = new Set(
  [
    ["ANTHROPIC", "API", "KEY"],
    ["ANTHROPIC", "AUTH", "TOKEN"],
    ["OPENAI", "API", "KEY"],
    ["OPENROUTER", "API", "KEY"],
  ].map((parts) => parts.join("_")),
);

const KEY_NAMED = /anthropic|openai|openrouter/i;
const FORBIDDEN_ORIGINS = ["api.openai.com", "openrouter.ai"];

function originHost(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
}

export const secretChecks: Check[] = [
  {
    id: "D-05",
    title: "No API-key variables in .env files, the process or compose",
    run: ({ env }) => {
      const found: string[] = [];
      for (const [file, names] of Object.entries(env.files)) {
        for (const n of names) if (KEY_VARIABLES.has(n)) found.push(`${n} in ${file}`);
      }
      for (const n of env.process)
        if (KEY_VARIABLES.has(n)) found.push(`${n} in the process environment`);
      for (const n of env.compose)
        if (KEY_VARIABLES.has(n)) found.push(`${n} in the compose environment`);
      return found.length === 0
        ? pass("no model API-key variable is set anywhere the stack reads")
        : fail(
            `API-key variables are set: ${list(found)}`,
            "Remove them. This stack runs on subscriptions only (BUILD.md §0.1, rail 1): unset the variable, and rotate the key if it was ever real.",
          );
    },
  },
  {
    id: "D-06",
    title: "No vault secret is named or scoped like an API key",
    run: ({ vault }) => {
      const bad: string[] = [];
      for (const secret of vault.secrets) {
        if (KEY_NAMED.test(secret.name)) bad.push(`${secret.name} (name)`);
        for (const origin of secret.origins) {
          const host = originHost(origin);
          if (FORBIDDEN_ORIGINS.includes(host)) bad.push(`${secret.name} (scoped to ${host})`);
          if (host === "api.anthropic.com" && secret.name !== "claude-oauth") {
            bad.push(`${secret.name} (scoped to api.anthropic.com)`);
          }
        }
      }
      return bad.length === 0
        ? pass(`${vault.secrets.length} vault secrets, none shaped like an API key`)
        : fail(
            `vault secrets that look like API keys: ${list([...new Set(bad)])}`,
            "Delete them with `exo vault`. Only `claude-oauth` (the setup-token) may be scoped to api.anthropic.com, and no OpenAI or OpenRouter secret belongs here.",
          );
    },
  },
  {
    id: "D-07",
    title: "No shared vault, a single identity",
    run: ({ vault }) =>
      !vault.shared && vault.identities <= 1
        ? pass("one identity, no shared vault")
        : fail(
            `${vault.shared ? "the vault is shared; " : ""}${vault.identities} identities`,
            "This is a single-owner stack (BUILD.md §0.1, rail 7): stop sharing the vault and remove the extra identities.",
          ),
  },
  {
    id: "D-08",
    title: "No use_sender_vault, Slack channels are listed",
    run: ({ agents }) => {
      const problems: string[] = [];
      for (const a of agents) {
        if (a.use_sender_vault) problems.push(`${a.slug} sets use_sender_vault`);
        for (const adapter of a.adapters) {
          if (adapter.type === "slack" && adapter.allowed_channels.length === 0) {
            problems.push(`${a.slug}'s Slack adapter allows no channel list`);
          }
        }
      }
      return problems.length === 0
        ? pass("no agent uses the sender's vault; every Slack adapter names its channels")
        : fail(
            problems.join("; "),
            "Remove use_sender_vault and give each Slack adapter an explicit allowed_channels list.",
          );
    },
  },
  {
    id: "D-15",
    title: "The Cursor secret comes from the Cursor SDK's own hosts",
    run: ({ cursor, allowlists }) => {
      if (!cursor.secret_origin) return skip("no Cursor secret is configured");
      const host = originHost(cursor.secret_origin);
      const allowed = allowlists["reviewer-cursor"] ?? [];
      if (allowed.length === 0) {
        return warn(
          `the Cursor secret is scoped to ${host}, but the Cursor SDK hosts are not recorded yet (V-15)`,
          "Record the SDK hosts in environments/allowlists.yaml once they are read from the pinned source.",
        );
      }
      return allowed.includes(host)
        ? pass(`the Cursor secret is scoped to ${host}, which is on the reviewer-cursor allowlist`)
        : fail(
            `the Cursor secret is scoped to ${host}, which is not on the reviewer-cursor allowlist`,
            "Recreate the secret scoped to the Cursor SDK host only.",
          );
    },
  },
];
