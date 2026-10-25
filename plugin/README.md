# exos: the Exo stack for Claude Code

This plugin connects Claude Code to the bridge of this repository's stack, so a session can hand a
task to a durable agent and come back to it later.

## Install

Build the bridge once, then load the plugin from the checkout:

```bash
make bootstrap
claude --plugin-dir ./plugin
```

Claude Code asks for two directories when the plugin is enabled: your checkout of this repository,
and the stack's state directory (`EXOS_STATE_DIR`, `.exos-state` by default). The bridge reads the
API token from `local-token` in that directory. It never reads the dashboard token.

## What it adds

- `/exos:exo-delegate <agent> <instruction>` starts a thread working in the current repository.
- `/exos:exo-status [thread]` shows a thread's state and recent events, or the credit left.
- `/exos:exo-approve <thread>` settles a pending approval, after asking you. Only you can invoke it,
  and `exo_approve` is not pre-approved anywhere, so Claude Code asks again at the call.
- The `delegator` agent has every bridge tool except `exo_approve`.

Writes (`exo_start_thread`, `exo_send`, `exo_fork`, `exo_answer`) are not pre-approved: Claude Code
asks for each call. Git push, npm publish and network tools can only be approved in the dashboard.

## Check it

```bash
make plugin-validate
```

This checks that every tool the plugin names exists in the bridge's tool list and that nothing
pre-approves `exo_approve`. To also run Claude Code's own validator, run
`claude plugin validate ./plugin --strict` yourself.
