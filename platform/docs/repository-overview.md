# Hyperfide repository overview

The runtime lives in `platform/` within
https://github.com/Sidiora-Labs/hyperfide. Node 24 and pnpm 9.15 drive one workspace.

| Directory | Responsibility |
| --- | --- |
| `apps/server` | HTTP API, realtime state, thread coordination and persistence |
| `apps/host-daemon` | Host enrollment, workspace provisioning and provider execution |
| `apps/app` | Browser interface for projects, threads and settings |
| `apps/cli` | Platform commands reached through `hyperfide platform` |
| `apps/desktop` | Electron shell and packaged runtime |
| `apps/mobile` | Native mobile client |
| `packages` | Contracts, configuration, SDK and shared implementation |
| `plugins` | Providers, tools and workspace capabilities |

From the repository root, use `pnpm -C platform <script>`. Limit package checks
with directory filters, for example:

```sh
pnpm -C platform exec turbo run typecheck test --filter=./apps/app
```

See [system overview](system-overview.md), [configuration](configuration.md),
and [contributing](../CONTRIBUTING.md). Support and bug reports belong in
https://github.com/Sidiora-Labs/hyperfide/issues.
