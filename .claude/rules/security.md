---
paths:
  - "stackd/**"
  - "bridge/**"
  - "doctor/**"
  - "harnesses/**"
  - "scripts/**"
  - ".claude/hooks/**"
  - ".github/**"
---

# Security

- Loopback only; local token (0600); Host and Origin checks; `SameSite=Strict` cookie. No `--auth-file`, `--multiplayer`, tunnels or non-localhost preview domains.
- No API keys ever (BUILD.md §0.1). Mode A has no Exo credential and an allowlisted child environment. Mode B shows only a placeholder in the sandbox.
- Event text, tool results and artifacts are untrusted: fenced by the bridge, labelled in the UI, never used to pick an action. `exo_approve` is human-initiated only; `git push`, `npm publish` and network tools are dashboard-only.
- Audit chain: every write, credit transition and doctor run appends a hash-chained event; never UPDATE or DELETE audit rows.
- Redact arguments before storing (`args_redacted`); never log secrets, tokens or vault values (`exo vault list|get` metadata only).
- No workflow holds model secrets or runs a live target.
