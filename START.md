# Kickoff prompt

Launch the session on the orchestrator model with `claude --model sonnet --effort high` (see BUILD.md §7, Model routing for this build), then paste this into the new Claude Code session opened at the repository root (recommended: on the maintainer's Mac).

```
You are the only engineer on the exo-agent-stack repository and you will build it autonomously. The complete specification is BUILD.md at the repository root; it is the single source of truth.

1. Read BUILD.md completely before running any command. Then follow §0 Operating mode and §1 Environment bootstrap in order. The commit-attribution step (§1.1) comes before any other commit.
2. Execute every milestone and task in §8 in order:
   - Write the failing test first.
   - Keep PROGRESS.md and docs/DECISIONS.md up to date after every task.
   - Use the harness you create in .claude/ (subagents, skills, rules, hooks).
   - Push the current branch after each milestone if a remote exists.
3. Do not stop until every item in the §9 Global Definition of Done is checked and §19 Final verification passes. The only valid early stop is a hard blocker under §20.
4. Subscription-only rules (non-negotiable):
   - Never create, request, read or store API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or any other).
   - Never run `claude setup-token`, never sign in to Claude, Cursor or any other service, and never handle OAuth tokens yourself.
   - Steps that need the maintainer's subscriptions go under "Needs the maintainer" in PROGRESS.md.
   - Never expose Exo, the bridge or the dashboard beyond localhost. No shared vaults, no multi-user mode.
   - Live subscription runs (`make live-claude`, `make live-cursor`) are maintainer-only and never run in CI.
5. Build Exo from the pinned submodule as §1 and §16 describe:
   - Verify every Exo command, frontmatter field and HTTP endpoint against the pinned source before using it, and record the result in docs/DECISIONS.md.
   - If Exo cannot be built in this environment, keep the bridge, dashboard, fake model server and doctor fully working and tested, mark the targets that need the real exo binary as host-only, and record the gap in docs/KNOWN_LIMITATIONS.md.
6. Other hard rules:
   - Offline first: tests, demo and `make verify` use the fake model server and the recorded Exo API fixtures.
   - Never deploy, never contact real recipients, never change the git identity.
   - No Claude attribution in commits or pull requests.
   - Every number in the docs must come from a command you actually ran.
7. If this session restarts or the context is compacted, re-read BUILD.md, PROGRESS.md, docs/DECISIONS.md and `git log --oneline -30`, then resume from the first unchecked task.

Start now with §1.
```
