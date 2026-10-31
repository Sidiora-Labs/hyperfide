# Worker injection

The Claude Code and Codex bridge adapters resolve the graph worker capability
through `@hyperfide/plugin-sdk/provider-bridge` when constructing sessions.
The protocol validates each capability and returns it in `attachedCapabilities`
on the thread identity response. `worker-injection.ts` exposes that same SDK
implementation for graph plugin consumers; no separate lifecycle host is needed.

Set `enabled` to `false` in `.codegraph/worker-injection.json` to disable
injection for that repository. A missing file enables injection only when
an ancestor repository contains a `.codegraph` directory. Invalid settings
raise an error. Setting changes apply when a provider session is constructed.
No process-level task is inherited: `CG_TASK` comes from the thread request
or its explicitly supplied environment.
