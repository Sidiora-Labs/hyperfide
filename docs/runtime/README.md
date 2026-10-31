# Hyperfide platform

Hyperfide runs agent work in live threads across the browser, desktop, mobile,
and command line. The server coordinates state; host daemons provision local
workspaces and run providers. Plugins add providers, tools, and workspace panels.
The repository's spec and qualification workflow govern task completion.

![Hyperfide](assets/hyperfide-logo.png)

## Run and develop

Use Node 24 and pnpm 9.15 from the repository toolchain. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
hyperfide platform --help
```

Use `hyperfide platform <command>` for platform operations. Read command help
before changing server or host configuration. Runtime data belongs in
`~/.hyperfide`; configuration environment variables use `HYPERFIDE_`.

See [repository overview](docs/repository-overview.md) and
[configuration](docs/configuration.md).

Source: https://github.com/Sidiora-Labs/hyperfide

Report bugs and request support at https://github.com/Sidiora-Labs/hyperfide/issues.

## Task authority and proof

Read the [platform integration guide](../docs/hyperfide/platform.md) for the four
layers, authority integration, fleet, slices and memory bridge. Runtime threads
execute work; the spec and qualification workflow determine implemented and done.
The guide identifies projection adapters and the scope of each executable proof.

From the repository root, run `bash tests/hyperfide/cases/v22/7_3.sh` for the
documentation and whole-repository identity checks. Runtime package checks use
`pnpm exec turbo run typecheck test --filter=./<package-directory>`.
