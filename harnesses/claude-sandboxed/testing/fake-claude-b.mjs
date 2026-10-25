#!/usr/bin/env node
// A stand-in for Claude Code in a Mode B sandbox, used only by tests. It does what Claude Code is
// documented to do with an OAuth token: send it as `Authorization: Bearer <token>` to
// ANTHROPIC_BASE_URL. Whether the real binary behaves exactly so inside SmolVM is verification
// item V-9 (docs/KNOWN_LIMITATIONS.md); this stand-in checks the stack's side of the contract.
const base = process.env.ANTHROPIC_BASE_URL;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!base || !token) {
  console.error("fake-claude-b: ANTHROPIC_BASE_URL and CLAUDE_CODE_OAUTH_TOKEN are required");
  process.exit(2);
}

const res = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "claude-fake",
    max_tokens: 16,
    messages: [{ role: "user", content: "hello [[scenario:plain]]" }],
  }),
});
process.stdout.write(
  `${JSON.stringify({ status: res.status, env: Object.keys(process.env).sort() })}\n`,
);
process.exit(res.ok ? 0 : 1);
