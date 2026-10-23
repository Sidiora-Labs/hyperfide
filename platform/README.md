# Hyperfide platform

Hyperfide runs agent work in live threads across the browser, desktop, mobile,
and command line. The server coordinates state; host daemons provision local
workspaces and run providers. Plugins add providers, tools, and workspace panels.
The repository's spec and qualification workflow govern task completion.

![Hyperfide](assets/hyperfide-logo.png)

## Run and develop

Use Node 24 and pnpm 9.15 from the repository toolchain. From the repository root:

```sh
pnpm -C platform install --frozen-lockfile
pnpm -C platform dev
hyperfide platform --help
```

Use `hyperfide platform <command>` for platform operations. Read command help
before changing server or host configuration. Runtime data belongs in
`~/.hyperfide`; configuration environment variables use `HYPERFIDE_`.

See [repository overview](docs/repository-overview.md),
[configuration](docs/configuration.md), and [contributing](CONTRIBUTING.md).

Source: https://github.com/Sidiora-Labs/hyperfide

Report bugs and request support at https://github.com/Sidiora-Labs/hyperfide/issues.
