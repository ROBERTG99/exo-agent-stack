// Mode A runs the unmodified `claude` binary with the maintainer's own login and no Exo credential
// (BUILD.md §4.7, FR-4). The child therefore gets an allowlisted environment: whatever credential
// the parent happens to hold (API keys, tokens, SSH agents) never reaches it.
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
] as const;

export function childEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
