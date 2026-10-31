# GitHub PR Status

Owns GitHub pull request data and actions for hyperfide platform environments. Bundled and enabled by default.

- `host.ts` runs `gh pr view`, the merge-queue lookup and `gh pr ready|merge` in the environment's workspace on its machine.
- `server.ts` resolves environments, assembles the status core's PR UI renders, serves the keyed `pullRequests` read and the `markReady`, `markDraft` and `merge` mutations, and registers `hyperfide platform pull-request`.
- `store.ts` is the single place reads are cached, re-checked while watched, and published when they change. PR snapshots are kept by PR URL so environments that share a PR share one snapshot.
- `contract.ts` is the public contract. Core's composer banner, Info row and sidebar shim read through it with `pluginId: "hyperfide--github-pr-status"`, the way any other plugin would.

Plugin host calls never wake a suspended machine: reads return `unavailable`, and actions fail with a message naming the machine.
